import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as ActivityConsumer from "../src/ActivityConsumer.ts"
import * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Deployment from "../src/Deployment.ts"
import type * as Dispatch from "../src/Dispatch.ts"
import * as DurableStart from "../src/DurableStart.ts"
import type * as Event from "../src/Event.ts"
import * as ExecutionStore from "../src/ExecutionStore.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"
import * as Identity from "../src/Identity.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as OutboxRelay from "../src/OutboxRelay.ts"
import * as Registry from "../src/Registry.ts"
import type * as RunCoordinatorStore from "../src/RunCoordinatorStore.ts"
import * as Workflow from "../src/Workflow.ts"

const digestBytes = (data: Uint8Array): Uint8Array => {
  const output = new Uint8Array(32)
  for (let index = 0; index < data.length; index++) {
    const position = index % output.length
    output[position] = ((output[position]! * 33) ^ data[index]! ^ index) & 0xff
  }
  return output
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(digestBytes(data))
})

const clock = (millis: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  sleep: () => Effect.void
})

const at = <A, E, R>(millis: number, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Clock.Clock, clock(millis)))

const limits = new Workflow.Limits({
  maxNodes: 4,
  maxEdges: 4,
  maxFanIn: 2,
  maxFanOut: 2,
  maxDepth: 2
})

const task = Node.make("ConsumerTask", { version: "1.0.0" })

const definition = Workflow.make("activity-consumer-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(task),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "activity-consumer-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "task",
    type: task.type,
    version: task.version,
    config: {}
  }],
  edges: []
}

const scheduleCommand = (runId: string): Dispatch.ScheduleActivityCommand => ({
  commandVersion: 1,
  commandId: Command.scheduleActivityCommandId(runId, "task", 1),
  payload: {
    _tag: "ScheduleActivity",
    activityId: Command.activityId(runId, "task", 1),
    nodeId: "task",
    nodeInstanceId: "task",
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey(runId, "task"),
    input: {}
  }
})

const scheduleEvent = (
  command: Dispatch.ScheduleActivityCommand
): HistoryStore.EventDraft<Event.ActivityScheduled> => ({
  eventVersion: 1,
  eventId: command.commandId,
  payload: {
    _tag: "ActivityScheduled",
    activityId: command.payload.activityId,
    nodeId: command.payload.nodeId,
    nodeInstanceId: command.payload.nodeInstanceId,
    attempt: command.payload.attempt,
    idempotencyKey: command.payload.idempotencyKey,
    input: command.payload.input
  }
})

const makeFixture = (
  tenantId = "tenant-a",
  runId = "run-1"
) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, planInput)
    const plan = yield* Decision.prepare(compiled)
    const catalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        Deployment.workflowDefinition("workflow-build-1", definition)
      ],
      handlerDefinitions: [
        Deployment.handlerDefinition("task-build-1", task)
      ]
    })
    const services = yield* ExecutionStore.makeMemory
    const key = { tenantId, runId }
    const prepared = yield* DurableStart.prepare(plan, {}, {
      tenantId,
      runId,
      workflowIdentity: `consumer/${runId}`,
      requestId: `start-${runId}`,
      definitionDeploymentId: "workflow-build-1",
      dispatchTargets: {
        task: {
          queue: "tasks",
          deploymentId: "task-build-1"
        }
      }
    }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
    yield* services.executionStore.start(prepared)

    const runnable = yield* services.runCoordinatorStore.claimRunnableRuns({
      requestVersion: 1,
      tenantId,
      coordinatorId: `coordinator-${tenantId}-${runId}`,
      requestId: `claim-${tenantId}-${runId}`,
      limit: 1,
      leaseDurationMillis: 60_000
    })
    const coordinatorLease = runnable.leases[0]
    if (coordinatorLease === undefined) {
      return yield* Effect.die("Expected the consumer fixture to be runnable")
    }
    const command = scheduleCommand(runId)
    const commit: ExecutionStore.DecisionCommitDraft = {
      commitVersion: 1,
      key,
      expectedLastSequence: 0,
      events: [scheduleEvent(command)],
      dispatches: [{
        dispatchVersion: 1,
        _tag: "Activity",
        intentId: command.commandId,
        sourceEventId: command.commandId,
        command,
        target: {
          queue: "tasks",
          deploymentId: "task-build-1"
        }
      }]
    }
    yield* services.executionStore.commitDecision(
      {
        requestVersion: 1,
        ref: coordinatorLease.ref,
        requestId: `commit-${tenantId}-${runId}`,
        commit
      } satisfies RunCoordinatorStore.CommitDecisionRequest
    )

    let message: OutboxRelay.ActivityMessage | undefined
    const publisher = OutboxRelay.ActivityPublisher.of({
      publish: (published) =>
        Effect.sync(() => {
          message = published
          return { brokerId: published.messageId }
        })
    })
    const relayed = yield* at(
      1_000,
      OutboxRelay.relayBatch({
        requestVersion: 1,
        claim: {
          requestVersion: 1,
          tenantId,
          relayId: `relay-${tenantId}-${runId}`,
          requestId: `relay-request-${tenantId}-${runId}`,
          queue: "tasks",
          limit: 1,
          leaseDurationMillis: 100
        },
        publishConcurrency: 1
      }).pipe(
        Effect.provideService(OutboxRelay.ActivityPublisher, publisher),
        Effect.provideService(
          ActivityDeliveryStore.ActivityDeliveryStore,
          services.activityDeliveryStore
        )
      )
    )
    if (
      message === undefined ||
      relayed.results[0] === undefined ||
      Result.isFailure(relayed.results[0])
    ) {
      return yield* Effect.die("Expected the activity pointer to be published")
    }
    const dispatch = (yield* services.executionStore.inspectOutbox(key))[0]!
    return {
      key,
      services,
      message,
      dispatch
    }
  })

const acquireRequest = (
  message: OutboxRelay.ActivityMessage,
  requestId: string,
  overrides: Partial<ActivityConsumer.AcquireRequest> = {}
): ActivityConsumer.AcquireRequest => ({
  requestVersion: 1,
  message,
  workerId: "worker-1",
  workerDeploymentId: "task-build-1",
  requestId,
  leaseDurationMillis: 100,
  ...overrides
})

const acquire = (
  store: ActivityDeliveryStore.ActivityDeliveryStore.Service,
  request: ActivityConsumer.AcquireRequest,
  millis = 1_010
) =>
  at(
    millis,
    ActivityConsumer.acquire(request).pipe(
      Effect.provideService(
        ActivityDeliveryStore.ActivityDeliveryStore,
        store
      )
    )
  )

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected activity consumer operation to fail")
  }
  return result.failure
}

describe("ActivityConsumer", () => {
  it.effect("reloads exact authoritative work and keeps broker identities tenant-safe across exact retries", () =>
    Effect.gen(function*() {
      const first = yield* makeFixture("tenant-a", "same-run")
      const second = yield* makeFixture("tenant-b", "same-run")
      assert.strictEqual(
        first.message.pointer.key.intentId,
        second.message.pointer.key.intentId
      )
      assert.strictEqual(
        first.message.messageId,
        Identity.activityBrokerMessageId(
          first.key.tenantId,
          first.message.pointer.key.intentId
        )
      )
      assert.strictEqual(
        second.message.messageId,
        Identity.activityBrokerMessageId(
          second.key.tenantId,
          second.message.pointer.key.intentId
        )
      )
      assert.notStrictEqual(
        first.message.messageId,
        second.message.messageId
      )

      const request = acquireRequest(first.message, "acquire-1")
      const lease = yield* acquire(
        first.services.activityDeliveryStore,
        request
      )
      assert.strictEqual(
        lease.pointer.dispatchDigest,
        first.message.pointer.dispatchDigest
      )
      assert.strictEqual(lease.dispatch, first.dispatch)
      assert.strictEqual(lease.dispatch.target.queue, first.message.queue)
      assert.strictEqual(
        lease.dispatch.target.deploymentId,
        request.workerDeploymentId
      )
      assert.strictEqual(
        lease.dispatch.intentId,
        first.message.pointer.key.intentId
      )
      assert.strictEqual(lease.ref.workerDeploymentId, "task-build-1")
      assert.strictEqual(lease.ref.deliveryEpoch, 1)

      const exact = yield* acquire(
        first.services.activityDeliveryStore,
        request,
        Number.MAX_SAFE_INTEGER
      )
      assert.strictEqual(exact, lease)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("rejects wrong message, digest, queue, and deployment pins before allocating handler work", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      let acquireCalls = 0
      const countingStore = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        acquireAttempt: (request) =>
          Effect.andThen(
            Effect.sync(() => {
              acquireCalls++
            }),
            fixture.services.activityDeliveryStore.acquireAttempt(request)
          )
      })

      const wrongMessage = yield* Effect.result(
        acquire(
          countingStore,
          acquireRequest(
            {
              ...fixture.message,
              messageId: Identity.activityBrokerMessageId(
                "tenant-b",
                fixture.message.pointer.key.intentId
              )
            },
            "wrong-message"
          )
        )
      )
      assert.instanceOf(
        failure(wrongMessage),
        ActivityConsumer.InvalidActivityMessage
      )
      assert.strictEqual(acquireCalls, 0)

      const digest = fixture.message.pointer.dispatchDigest
      const wrongDigestValue = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`
      const wrongDigest = yield* Effect.result(
        acquire(
          countingStore,
          acquireRequest(
            {
              ...fixture.message,
              pointer: {
                ...fixture.message.pointer,
                dispatchDigest: wrongDigestValue
              }
            },
            "wrong-digest"
          )
        )
      )
      const digestError = failure(wrongDigest)
      assert.instanceOf(
        digestError,
        ActivityDeliveryStore.DispatchPinMismatch
      )
      if (digestError instanceof ActivityDeliveryStore.DispatchPinMismatch) {
        assert.strictEqual(digestError.field, "dispatchDigest")
      }

      const wrongQueue = yield* Effect.result(
        acquire(
          countingStore,
          acquireRequest(
            {
              ...fixture.message,
              queue: "other-queue"
            },
            "wrong-queue"
          )
        )
      )
      const queueError = failure(wrongQueue)
      assert.instanceOf(
        queueError,
        ActivityDeliveryStore.DispatchPinMismatch
      )
      if (queueError instanceof ActivityDeliveryStore.DispatchPinMismatch) {
        assert.strictEqual(queueError.field, "workerQueue")
      }

      const wrongDeployment = yield* Effect.result(
        acquire(
          countingStore,
          acquireRequest(
            fixture.message,
            "wrong-deployment",
            { workerDeploymentId: "other-build" }
          )
        )
      )
      const deploymentError = failure(wrongDeployment)
      assert.instanceOf(
        deploymentError,
        ActivityDeliveryStore.DispatchPinMismatch
      )
      if (
        deploymentError instanceof ActivityDeliveryStore.DispatchPinMismatch
      ) {
        assert.strictEqual(
          deploymentError.field,
          "workerDeploymentId"
        )
      }
      assert.strictEqual(acquireCalls, 3)

      const valid = yield* acquire(
        countingStore,
        acquireRequest(fixture.message, "valid-after-rejections")
      )
      assert.strictEqual(valid.ref.deliveryEpoch, 1)
      assert.strictEqual(acquireCalls, 4)
      assert.strictEqual(
        (yield* fixture.services.executionStore.read(fixture.key))
          .lastSequence,
        1
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("suppresses broker redelivery after activity completion or run cancellation", () =>
    Effect.gen(function*() {
      const completed = yield* makeFixture("tenant-a", "run-completed")
      const lease = yield* acquire(
        completed.services.activityDeliveryStore,
        acquireRequest(completed.message, "acquire-completed")
      )
      yield* at(
        1_020,
        completed.services.activityDeliveryStore.completeAttempt({
          requestVersion: 1,
          ref: lease.ref,
          requestId: "complete-1",
          result: {
            _tag: "Succeeded",
            output: {}
          }
        })
      )
      const completedResult = yield* Effect.result(
        acquire(
          completed.services.activityDeliveryStore,
          acquireRequest(completed.message, "redeliver-completed"),
          1_030
        )
      )
      const completedError = failure(completedResult)
      assert.instanceOf(
        completedError,
        ActivityDeliveryStore.ActivityCompletionSuppressed
      )
      if (
        completedError instanceof
          ActivityDeliveryStore.ActivityCompletionSuppressed
      ) {
        assert.strictEqual(completedError.reason, "AlreadyResolved")
      }

      const cancelled = yield* makeFixture("tenant-a", "run-cancelled")
      yield* at(
        1_010,
        cancelled.services.executionStore.requestCancellation({
          requestVersion: 1,
          key: cancelled.key,
          requestId: "cancel-1"
        })
      )
      const cancelledResult = yield* Effect.result(
        acquire(
          cancelled.services.activityDeliveryStore,
          acquireRequest(cancelled.message, "redeliver-cancelled"),
          1_020
        )
      )
      const cancelledError = failure(cancelledResult)
      assert.instanceOf(
        cancelledError,
        ActivityDeliveryStore.ActivityCompletionSuppressed
      )
      if (
        cancelledError instanceof
          ActivityDeliveryStore.ActivityCompletionSuppressed
      ) {
        assert.strictEqual(
          cancelledError.reason,
          "CancellationRequested"
        )
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
