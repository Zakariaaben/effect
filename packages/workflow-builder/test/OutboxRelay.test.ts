import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
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

const task = Node.make("RelayTask", { version: "1.0.0" })

const definition = Workflow.make("outbox-relay-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(task),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "outbox-relay-plan",
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

const makeFixture = (runIds: ReadonlyArray<string>) =>
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
    for (const runId of runIds) {
      const key = { tenantId: "tenant-a", runId }
      const prepared = yield* DurableStart.prepare(plan, {}, {
        tenantId: key.tenantId,
        runId,
        workflowIdentity: `relay/${runId}`,
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
        tenantId: key.tenantId,
        coordinatorId: `coordinator-${runId}`,
        requestId: `claim-${runId}`,
        limit: 1,
        leaseDurationMillis: 60_000
      })
      const lease = runnable.leases[0]
      if (lease === undefined) {
        return yield* Effect.die(`Expected '${runId}' to be runnable`)
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
          ref: lease.ref,
          requestId: `commit-${runId}`,
          commit
        } satisfies RunCoordinatorStore.CommitDecisionRequest
      )
    }
    return services
  })

const relayRequest = (
  requestId: string,
  relayId = "relay-1"
): OutboxRelay.RelayBatchRequest => ({
  requestVersion: 1,
  claim: {
    requestVersion: 1,
    tenantId: "tenant-a",
    relayId,
    requestId,
    queue: "tasks",
    limit: 10,
    leaseDurationMillis: 100
  },
  publishConcurrency: 4
})

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected relay item to fail")
  }
  return result.failure
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (!Result.isSuccess(result)) {
    throw new Error("Expected relay item to succeed")
  }
  return result.success
}

describe("OutboxRelay", () => {
  it.effect("publishes a stable pointer-only envelope before ack and exact-retries it", () =>
    Effect.gen(function*() {
      const services = yield* makeFixture(["run-1"])
      const messages: Array<OutboxRelay.ActivityMessage> = []
      const order: Array<string> = []
      const publisher = OutboxRelay.ActivityPublisher.of({
        publish: (message) =>
          Effect.sync(() => {
            messages.push(message)
            order.push(`publish:${message.messageId}`)
            return { brokerId: message.messageId }
          })
      })
      const deliveryStore = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...services.activityDeliveryStore,
        acknowledgePublished: (request) =>
          Effect.andThen(
            Effect.sync(() => {
              order.push(
                `ack:${
                  Identity.activityBrokerMessageId(
                    request.ref.key.tenantId,
                    request.ref.key.intentId
                  )
                }`
              )
            }),
            services.activityDeliveryStore.acknowledgePublished(request)
          )
      })
      const request = relayRequest("relay-request-1")
      const first = yield* at(
        1_000,
        OutboxRelay.relayBatch(request).pipe(
          Effect.provideService(OutboxRelay.ActivityPublisher, publisher),
          Effect.provideService(
            ActivityDeliveryStore.ActivityDeliveryStore,
            deliveryStore
          )
        )
      )
      const relayed = success(first.results[0]!)
      const message = relayed.message

      assert.deepStrictEqual(Object.keys(message).sort(), [
        "messageId",
        "messageVersion",
        "pointer",
        "queue"
      ])
      assert.strictEqual(
        message.messageId,
        Identity.activityBrokerMessageId(
          message.pointer.key.tenantId,
          message.pointer.key.intentId
        )
      )
      assert.notStrictEqual(message.messageId, message.pointer.key.intentId)
      assert.notStrictEqual(
        message.messageId,
        Identity.activityBrokerMessageId(
          "tenant-b",
          message.pointer.key.intentId
        )
      )
      assert.strictEqual(message.queue, "tasks")
      assert.deepStrictEqual(message.pointer, first.claim.claims[0]!.pointer)
      assert.isFalse(Object.prototype.hasOwnProperty.call(message, "dispatch"))
      assert.isFalse(Object.prototype.hasOwnProperty.call(message, "command"))
      assert.isFalse(Object.prototype.hasOwnProperty.call(message, "target"))
      assert.isTrue(Object.isFrozen(message))
      assert.isTrue(Object.isFrozen(message.pointer))
      assert.deepStrictEqual(relayed.receipt.brokerReceipt, {
        brokerId: message.messageId
      })
      assert.deepStrictEqual(order, [
        `publish:${message.messageId}`,
        `ack:${message.messageId}`
      ])

      const exact = yield* at(
        Number.MAX_SAFE_INTEGER,
        OutboxRelay.relayBatch(request).pipe(
          Effect.provideService(OutboxRelay.ActivityPublisher, publisher),
          Effect.provideService(
            ActivityDeliveryStore.ActivityDeliveryStore,
            deliveryStore
          )
        )
      )
      const exactRelayed = success(exact.results[0]!)
      assert.deepStrictEqual(exactRelayed.message, message)
      assert.strictEqual(exactRelayed.receipt, relayed.receipt)
      assert.deepStrictEqual(messages, [message, message])
      assert.deepStrictEqual(order, [
        `publish:${message.messageId}`,
        `ack:${message.messageId}`,
        `publish:${message.messageId}`,
        `ack:${message.messageId}`
      ])

      const empty = yield* at(
        1_001,
        OutboxRelay.relayBatch(relayRequest("relay-request-after-publish")).pipe(
          Effect.provideService(OutboxRelay.ActivityPublisher, publisher),
          Effect.provideService(
            ActivityDeliveryStore.ActivityDeliveryStore,
            deliveryStore
          )
        )
      )
      assert.deepStrictEqual(empty.claim.claims, [])
      assert.deepStrictEqual(empty.results, [])
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("isolates per-item publication failures and redelivers only the unacked stable pointer", () =>
    Effect.gen(function*() {
      const services = yield* makeFixture(["run-fail", "run-ok"])
      const failedIntentId = scheduleCommand("run-fail").commandId
      const failedMessageId = Identity.activityBrokerMessageId(
        "tenant-a",
        failedIntentId
      )
      const attempts = new Map<string, number>()
      const messages = new Map<string, Array<OutboxRelay.ActivityMessage>>()
      const publisher = OutboxRelay.ActivityPublisher.of({
        publish: (message) => {
          const count = (attempts.get(message.messageId) ?? 0) + 1
          attempts.set(message.messageId, count)
          const seen = messages.get(message.messageId) ?? []
          seen.push(message)
          messages.set(message.messageId, seen)
          return message.messageId === failedMessageId && count === 1
            ? Effect.fail(
              new OutboxRelay.ActivityPublishError({
                queue: message.queue,
                messageId: message.messageId,
                message: "broker unavailable"
              })
            )
            : Effect.succeed({ brokerId: message.messageId })
        }
      })
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(OutboxRelay.ActivityPublisher, publisher),
          Effect.provideService(
            ActivityDeliveryStore.ActivityDeliveryStore,
            services.activityDeliveryStore
          )
        )

      const first = yield* at(
        1_000,
        provide(OutboxRelay.relayBatch(relayRequest("relay-batch-1")))
      )
      assert.strictEqual(first.results.length, 2)
      for (let index = 0; index < first.results.length; index++) {
        const claim = first.claim.claims[index]!
        const result = first.results[index]!
        if (claim.pointer.key.intentId === failedIntentId) {
          assert.instanceOf(failure(result), OutboxRelay.ActivityPublishError)
        } else {
          assert.strictEqual(
            success(result).message.messageId,
            Identity.activityBrokerMessageId(
              claim.pointer.key.tenantId,
              claim.pointer.key.intentId
            )
          )
        }
      }

      const retried = yield* at(
        1_100,
        provide(
          OutboxRelay.relayBatch(
            relayRequest("relay-batch-2", "relay-2")
          )
        )
      )
      assert.strictEqual(retried.claim.claims.length, 1)
      assert.strictEqual(
        retried.claim.claims[0]!.pointer.key.intentId,
        failedIntentId
      )
      assert.strictEqual(retried.claim.claims[0]!.ref.relayEpoch, 2)
      const retriedMessage = success(retried.results[0]!).message
      assert.deepStrictEqual(retriedMessage, messages.get(failedMessageId)![0])
      assert.strictEqual(attempts.get(failedMessageId), 2)
      assert.strictEqual(
        attempts.get(
          Identity.activityBrokerMessageId(
            "tenant-a",
            scheduleCommand("run-ok").commandId
          )
        ),
        1
      )

      const empty = yield* at(
        1_101,
        provide(OutboxRelay.relayBatch(relayRequest("relay-batch-3")))
      )
      assert.deepStrictEqual(empty.results, [])
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("isolates hostile receipt and publisher protocol failures without invoking accessors or acking", () =>
    Effect.gen(function*() {
      const services = yield* makeFixture([
        "run-accessor-receipt",
        "run-non-effect"
      ])
      const accessorMessageId = Identity.activityBrokerMessageId(
        "tenant-a",
        scheduleCommand("run-accessor-receipt").commandId
      )
      let getterReads = 0
      const hostileReceipt = Object.defineProperty({}, "brokerId", {
        enumerable: true,
        get: () => {
          getterReads++
          return "should-not-be-read"
        }
      })
      const publisher = OutboxRelay.ActivityPublisher.of({
        publish: (message) =>
          message.messageId === accessorMessageId
            ? Effect.succeed(hostileReceipt as unknown as Schema.Json)
            : ({
              invalid: "not-an-effect"
            } as unknown as Effect.Effect<
              Schema.Json,
              OutboxRelay.ActivityPublishError
            >)
      })
      const batch = yield* at(
        1_000,
        OutboxRelay.relayBatch(relayRequest("relay-protocol")).pipe(
          Effect.provideService(OutboxRelay.ActivityPublisher, publisher),
          Effect.provideService(
            ActivityDeliveryStore.ActivityDeliveryStore,
            services.activityDeliveryStore
          )
        )
      )
      assert.strictEqual(batch.results.length, 2)
      for (let index = 0; index < batch.results.length; index++) {
        const runId = batch.claim.claims[index]!.dispatch.runId
        const error = failure(batch.results[index]!)
        assert.instanceOf(error, OutboxRelay.RelayProtocolError)
        if (error instanceof OutboxRelay.RelayProtocolError) {
          assert.strictEqual(
            error.phase,
            runId === "run-accessor-receipt" ? "receipt" : "publisher"
          )
        }
      }
      assert.strictEqual(getterReads, 0)

      const reclaimed = yield* at(
        1_100,
        services.activityDeliveryStore.claimOutbox(
          relayRequest("relay-protocol-reclaim", "relay-2").claim
        )
      )
      assert.strictEqual(reclaimed.claims.length, 2)
      assert.deepStrictEqual(
        reclaimed.claims.map((claim) => claim.ref.relayEpoch),
        [2, 2]
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
