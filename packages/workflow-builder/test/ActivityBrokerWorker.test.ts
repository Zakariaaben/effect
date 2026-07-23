import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import * as ActivityBrokerWorker from "../src/ActivityBrokerWorker.ts"
import * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import type * as Dispatch from "../src/Dispatch.ts"
import * as DurableRecovery from "../src/DurableRecovery.ts"
import * as DurableStart from "../src/DurableStart.ts"
import type * as Event from "../src/Event.ts"
import * as ExecutionStore from "../src/ExecutionStore.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"
import * as Identity from "../src/Identity.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
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

const task = Node.make("BrokerWorkerTask", { version: "1.0.0" })
const registry = Registry.make(task)

const definition = Workflow.make("activity-broker-worker-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "activity-broker-worker-plan",
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

const key: PlanStore.RunKey = {
  tenantId: "tenant-a",
  runId: "run-1"
}

const witness = Deployment.workflowDefinition("workflow-build-1", definition)

const scheduleCommand = (): Dispatch.ScheduleActivityCommand => ({
  commandVersion: 1,
  commandId: Command.scheduleActivityCommandId(key.runId, "task", 1),
  payload: {
    _tag: "ScheduleActivity",
    activityId: Command.activityId(key.runId, "task", 1),
    nodeId: "task",
    nodeInstanceId: "task",
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey(key.runId, "task"),
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
  handlerMode: "succeed" | "defect" = "succeed",
  order?: Array<string>
) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, planInput)
    const plan = yield* Decision.prepare(compiled)
    const catalog = yield* Deployment.makeMemory({
      workflowDefinitions: [witness],
      handlerDefinitions: [
        Deployment.handlerDefinition("task-build-1", task)
      ]
    })
    const prepared = yield* DurableStart.prepare(plan, {}, {
      tenantId: key.tenantId,
      runId: key.runId,
      workflowIdentity: "activity-broker-worker",
      requestId: "start-request-1",
      definitionDeploymentId: witness.deploymentId,
      dispatchTargets: {
        task: {
          queue: "tasks",
          deploymentId: "task-build-1"
        }
      }
    }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
    const services = yield* ExecutionStore.makeMemory
    yield* services.executionStore.start(prepared)

    const runnable = yield* services.runCoordinatorStore.claimRunnableRuns({
      requestVersion: 1,
      tenantId: key.tenantId,
      coordinatorId: "coordinator-1",
      requestId: "coordinator-claim-1",
      limit: 1,
      leaseDurationMillis: 60_000
    })
    const runLease = runnable.leases[0]
    if (runLease === undefined) {
      return yield* Effect.die("Expected broker-worker fixture to be runnable")
    }
    const command = scheduleCommand()
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
        ref: runLease.ref,
        requestId: "coordinator-commit-1",
        commit
      } satisfies RunCoordinatorStore.CommitDecisionRequest
    )

    const recovered = yield* DurableRecovery.recover(key, witness).pipe(
      Effect.provideService(PlanStore.PlanStore, services.planStore),
      Effect.provideService(ExecutionStore.ExecutionStore, services.executionStore),
      Effect.provideService(Deployment.DeploymentCatalog, catalog)
    )
    const claimed = yield* at(
      1_000,
      services.activityDeliveryStore.claimOutbox({
        requestVersion: 1,
        tenantId: key.tenantId,
        relayId: "relay-1",
        requestId: "relay-request-1",
        queue: "tasks",
        limit: 1,
        leaseDurationMillis: 100
      })
    )
    const claim = claimed.claims[0]
    if (claim === undefined) {
      return yield* Effect.die("Expected committed activity dispatch to be claimable")
    }
    const message: ActivityBrokerWorker.ActivityMessage = Object.freeze({
      messageVersion: 1,
      messageId: Identity.activityBrokerMessageId(
        claim.pointer.key.tenantId,
        claim.pointer.key.intentId
      ),
      queue: claim.dispatch.target.queue,
      pointer: claim.pointer
    })
    const handlers = yield* registry.toHandlers(registry.of({
      "BrokerWorkerTask@1.0.0": () => {
        order?.push("handler")
        return handlerMode === "defect"
          ? Effect.die("simulated worker crash")
          : Effect.succeed({})
      }
    }))
    const deployed = yield* DeploymentHandlers.make([
      DeploymentHandlers.handlerDeployment("task-build-1", handlers)
    ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
    return {
      services,
      recovered,
      deployed,
      message
    }
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const processRequest = (
  message: Schema.Json,
  overrides: Partial<ActivityBrokerWorker.ProcessRequest> = {}
): ActivityBrokerWorker.ProcessRequest => ({
  requestVersion: 1,
  delivery: {
    deliveryVersion: 1,
    deliveryId: "delivery-1",
    message
  },
  workerId: "worker-1",
  workerDeploymentId: "task-build-1",
  acquireRequestId: "acquire-request-1",
  completionRequestId: "completion-request-1",
  settlementRequestId: "settlement-request-1",
  leaseDurationMillis: 100,
  retryDelayMillis: 5_000,
  ...overrides
})

const recordingSettlement = (
  actions: Array<string>,
  requests: Array<ActivityBrokerWorker.SettlementRequest> = []
) =>
  ActivityBrokerWorker.ActivityBrokerSettlement.of({
    acknowledge: (request) =>
      Effect.sync(() => {
        actions.push("Acknowledge")
        requests.push(request)
        return {
          action: "Acknowledge",
          requestId: request.requestId
        }
      }),
    retry: (request) =>
      Effect.sync(() => {
        actions.push("Retry")
        requests.push(request)
        return {
          action: "Retry",
          requestId: request.requestId
        }
      }),
    deadLetter: (request) =>
      Effect.sync(() => {
        actions.push("DeadLetter")
        requests.push(request)
        return {
          action: "DeadLetter",
          requestId: request.requestId
        }
      })
  })

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected broker worker operation to fail")
  }
  return result.failure
}

describe("ActivityBrokerWorker", () => {
  it.effect("durably completes before acknowledging the broker delivery", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const fixture = yield* makeFixture("succeed", order)
      const requests: Array<ActivityBrokerWorker.SettlementRequest> = []
      const settlement = ActivityBrokerWorker.ActivityBrokerSettlement.of({
        ...recordingSettlement(order, requests),
        acknowledge: (request) =>
          Effect.sync(() => {
            order.push("acknowledge")
            requests.push(request)
            return { brokerAck: request.delivery.deliveryId }
          })
      })
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        acquireAttempt: (request) =>
          fixture.services.activityDeliveryStore.acquireAttempt(request).pipe(
            Effect.tap(() => Effect.sync(() => order.push("acquire")))
          ),
        completeAttempt: (request) =>
          fixture.services.activityDeliveryStore.completeAttempt(request).pipe(
            Effect.tap(() => Effect.sync(() => order.push("complete")))
          )
      })

      const processed = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(fixture.message)
        ).pipe(
          Effect.provideService(ActivityBrokerWorker.ActivityBrokerSettlement, settlement),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed)
        )
      )

      assert.strictEqual(processed._tag, "Completed")
      assert.deepStrictEqual(order, [
        "acquire",
        "handler",
        "complete",
        "acknowledge"
      ])
      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0]!._tag, "Acknowledge")
      assert.strictEqual(
        (requests[0] as ActivityBrokerWorker.AcknowledgeRequest).reason,
        "Completed"
      )
      assert.isTrue(Object.isFrozen(requests[0]))
      assert.isTrue(Object.isFrozen(requests[0]!.delivery))
      assert.isTrue(Object.isFrozen(requests[0]!.delivery.message))
    }))

  it.effect("retries a worker crash and never acknowledges or completes it", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("defect")
      const actions: Array<string> = []
      let completionCalls = 0
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        completeAttempt: (request) =>
          Effect.suspend(() => {
            completionCalls++
            return fixture.services.activityDeliveryStore.completeAttempt(request)
          })
      })
      const processed = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(fixture.message)
        ).pipe(
          Effect.provideService(
            ActivityBrokerWorker.ActivityBrokerSettlement,
            recordingSettlement(actions)
          ),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed)
        )
      )

      assert.strictEqual(processed._tag, "Retried")
      if (processed._tag === "Retried") {
        assert.strictEqual(processed.reason, "WorkerFailure")
        assert.strictEqual(processed.failure.tag, "ActivityRuntimeError")
      }
      assert.strictEqual(completionCalls, 0)
      assert.deepStrictEqual(actions, ["Retry"])
    }))

  it.effect("acknowledges authoritative completion suppression", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const actions: Array<string> = []
      const requests: Array<ActivityBrokerWorker.SettlementRequest> = []
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        completeAttempt: () =>
          Effect.fail(
            new ActivityDeliveryStore.ActivityCompletionSuppressed({
              key: fixture.message.pointer.key,
              reason: "CancellationRequested"
            })
          )
      })
      const processed = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(fixture.message)
        ).pipe(
          Effect.provideService(
            ActivityBrokerWorker.ActivityBrokerSettlement,
            recordingSettlement(actions, requests)
          ),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed)
        )
      )

      assert.deepStrictEqual(actions, ["Acknowledge"])
      assert.strictEqual(processed._tag, "Suppressed")
      if (processed._tag === "Suppressed") {
        assert.strictEqual(processed.reason, "CancellationRequested")
      }
      assert.deepStrictEqual(requests[0], {
        requestVersion: 1,
        _tag: "Acknowledge",
        requestId: "settlement-request-1",
        delivery: processRequest(fixture.message).delivery,
        reason: "Suppressed",
        suppressionReason: "CancellationRequested"
      })
    }))

  it.effect("requests delayed redelivery while another lease is busy", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const actions: Array<string> = []
      const requests: Array<ActivityBrokerWorker.SettlementRequest> = []
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        acquireAttempt: () =>
          Effect.fail(
            new ActivityDeliveryStore.ActivityLeaseBusy({
              key: fixture.message.pointer.key,
              workerId: "other-worker",
              deliveryEpoch: 3,
              expiresAt: "1970-01-01T00:00:10.000Z"
            })
          )
      })
      const processed = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(fixture.message)
        ).pipe(
          Effect.provideService(
            ActivityBrokerWorker.ActivityBrokerSettlement,
            recordingSettlement(actions, requests)
          ),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed)
        )
      )

      assert.strictEqual(processed._tag, "Retried")
      if (processed._tag === "Retried") {
        assert.strictEqual(processed.reason, "Busy")
      }
      assert.deepStrictEqual(actions, ["Retry"])
      assert.strictEqual(
        (requests[0] as ActivityBrokerWorker.RetryRequest).delayMillis,
        5_000
      )
    }))

  it.effect("dead-letters malformed messages and immutable deployment pin mismatches", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const actions: Array<string> = []
      const requests: Array<ActivityBrokerWorker.SettlementRequest> = []
      let acquireCalls = 0
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        acquireAttempt: (request) =>
          Effect.suspend(() => {
            acquireCalls++
            return fixture.services.activityDeliveryStore.acquireAttempt(request)
          })
      })
      const malformedMessage = { messageVersion: 1 }
      const malformed = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(malformedMessage)
        ).pipe(
          Effect.provideService(
            ActivityBrokerWorker.ActivityBrokerSettlement,
            recordingSettlement(actions, requests)
          ),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed)
        )
      )
      const pinMismatch = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(fixture.message, {
            delivery: {
              deliveryVersion: 1,
              deliveryId: "delivery-2",
              message: fixture.message
            },
            workerDeploymentId: "wrong-build",
            acquireRequestId: "acquire-request-2",
            completionRequestId: "completion-request-2",
            settlementRequestId: "settlement-request-2"
          })
        ).pipe(
          Effect.provideService(
            ActivityBrokerWorker.ActivityBrokerSettlement,
            recordingSettlement(actions, requests)
          ),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed)
        )
      )

      assert.strictEqual(malformed._tag, "DeadLettered")
      assert.strictEqual(pinMismatch._tag, "DeadLettered")
      if (malformed._tag === "DeadLettered" && pinMismatch._tag === "DeadLettered") {
        assert.strictEqual(malformed.reason, "Malformed")
        assert.strictEqual(pinMismatch.reason, "PinMismatch")
      }
      assert.strictEqual(acquireCalls, 1)
      assert.deepStrictEqual(actions, ["DeadLetter", "DeadLetter"])
      assert.notStrictEqual(requests[0]!.delivery.message, malformedMessage)
      assert.deepStrictEqual(requests[0]!.delivery.message, malformedMessage)
      assert.isTrue(Object.isFrozen(requests[0]!.delivery.message))
    }))

  it.effect("normalizes hostile settlement adapters without acknowledging", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        acquireAttempt: () =>
          Effect.fail(
            new ActivityDeliveryStore.ActivityLeaseBusy({
              key: fixture.message.pointer.key,
              workerId: "other-worker",
              deliveryEpoch: 1,
              expiresAt: "1970-01-01T00:00:10.000Z"
            })
          )
      })
      const validMethod = () => Effect.succeed({ unused: true })
      const nonEffect = ActivityBrokerWorker.ActivityBrokerSettlement.of({
        acknowledge: validMethod,
        retry: () => ({ invalid: "not-an-effect" } as unknown as Effect.Effect<
          Schema.Json,
          ActivityBrokerWorker.ActivityBrokerWorkerError
        >),
        deadLetter: validMethod
      })
      const defect = ActivityBrokerWorker.ActivityBrokerSettlement.of({
        acknowledge: validMethod,
        retry: () => Effect.die("adapter defect"),
        deadLetter: validMethod
      })
      const invalidFailure = ActivityBrokerWorker.ActivityBrokerSettlement.of({
        acknowledge: validMethod,
        retry: () =>
          Effect.fail("invalid adapter failure") as unknown as Effect.Effect<
            Schema.Json,
            ActivityBrokerWorker.ActivityBrokerWorkerError
          >,
        deadLetter: validMethod
      })
      let getterReads = 0
      const hostileReceipt = Object.defineProperty({}, "receipt", {
        enumerable: true,
        get: () => {
          getterReads++
          return "must-not-be-read"
        }
      })
      const receipt = ActivityBrokerWorker.ActivityBrokerSettlement.of({
        acknowledge: validMethod,
        retry: () => Effect.succeed(hostileReceipt as unknown as Schema.Json),
        deadLetter: validMethod
      })

      const run = (
        settlement: typeof nonEffect
      ) =>
        at(
          1_010,
          ActivityBrokerWorker.process(
            fixture.recovered,
            processRequest(fixture.message)
          ).pipe(
            Effect.provideService(ActivityBrokerWorker.ActivityBrokerSettlement, settlement),
            Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
            Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed),
            Effect.result
          )
        )
      const nonEffectResult = yield* run(nonEffect)
      const defectResult = yield* run(defect)
      const invalidFailureResult = yield* run(invalidFailure)
      const receiptResult = yield* run(receipt)

      for (
        const result of [
          nonEffectResult,
          defectResult,
          invalidFailureResult,
          receiptResult
        ]
      ) {
        const error = failure(result)
        assert.instanceOf(error, ActivityBrokerWorker.ActivityBrokerWorkerError)
      }
      const nonEffectError = failure(nonEffectResult)
      const defectError = failure(defectResult)
      const invalidFailureError = failure(invalidFailureResult)
      const receiptError = failure(receiptResult)
      if (
        nonEffectError instanceof ActivityBrokerWorker.ActivityBrokerWorkerError &&
        defectError instanceof ActivityBrokerWorker.ActivityBrokerWorkerError &&
        invalidFailureError instanceof ActivityBrokerWorker.ActivityBrokerWorkerError &&
        receiptError instanceof ActivityBrokerWorker.ActivityBrokerWorkerError
      ) {
        assert.strictEqual(nonEffectError.phase, "adapter")
        assert.strictEqual(defectError.phase, "adapter")
        assert.strictEqual(invalidFailureError.phase, "adapter")
        assert.strictEqual(receiptError.phase, "receipt")
      }
      assert.strictEqual(getterReads, 0)
    }))

  it.effect("preserves settlement interruption", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const store = ActivityDeliveryStore.ActivityDeliveryStore.of({
        ...fixture.services.activityDeliveryStore,
        acquireAttempt: () =>
          Effect.fail(
            new ActivityDeliveryStore.ActivityLeaseBusy({
              key: fixture.message.pointer.key,
              workerId: "other-worker",
              deliveryEpoch: 1,
              expiresAt: "1970-01-01T00:00:10.000Z"
            })
          )
      })
      const settlement = ActivityBrokerWorker.ActivityBrokerSettlement.of({
        acknowledge: () => Effect.succeed({ unused: true }),
        retry: () => Effect.interrupt,
        deadLetter: () => Effect.succeed({ unused: true })
      })
      const interrupted = yield* at(
        1_010,
        ActivityBrokerWorker.process(
          fixture.recovered,
          processRequest(fixture.message)
        ).pipe(
          Effect.provideService(ActivityBrokerWorker.ActivityBrokerSettlement, settlement),
          Effect.provideService(ActivityDeliveryStore.ActivityDeliveryStore, store),
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, fixture.deployed),
          Effect.exit
        )
      )

      assert.isTrue(Exit.isFailure(interrupted))
      if (Exit.isFailure(interrupted)) {
        assert.isTrue(Cause.hasInterruptsOnly(interrupted.cause))
      }
    }))
})
