import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"
import * as ActivityWorker from "../src/ActivityWorker.ts"
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
import * as Port from "../src/Port.ts"
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
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const contract = "activity-worker/text"

const task = Node.make("DurableTask", {
  version: "1.0.0",
  inputs: {
    payload: Port.input(Schema.String, { contract })
  },
  outputs: {
    selected: Port.output(Schema.String, { contract })
  }
})

const otherTaskObject = Node.make("DurableTask", {
  version: "1.0.0",
  inputs: {
    payload: Port.input(Schema.String, { contract })
  },
  outputs: {
    selected: Port.output(Schema.String, { contract })
  }
})

const registry = Registry.make(task)
const otherRegistry = Registry.make(otherTaskObject)

const definition = Workflow.make("activity-worker-workflow", {
  version: "1.0.0",
  inputs: {
    payload: Port.output(Schema.String, { contract })
  },
  outputs: {},
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "activity-worker-plan",
  revision: 7,
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
  edges: [{
    _tag: "DataEdge" as const,
    id: "payload-task",
    source: { _tag: "WorkflowInput" as const, input: "payload" },
    target: { _tag: "NodeInput" as const, nodeId: "task", input: "payload" }
  }]
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
    input: { payload: "work" }
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

const makeFixture = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, planInput)
  const plan = yield* Decision.prepare(compiled)
  const catalog = yield* Deployment.makeMemory({
    workflowDefinitions: [witness],
    handlerDefinitions: [
      Deployment.handlerDefinition("task-build-a", task),
      Deployment.handlerDefinition("task-build-b", task)
    ]
  })
  const preparedStart = yield* DurableStart.prepare(plan, { payload: "work" }, {
    tenantId: key.tenantId,
    runId: key.runId,
    workflowIdentity: "activity-worker",
    requestId: "start-request-1",
    definitionDeploymentId: witness.deploymentId,
    dispatchTargets: {
      task: {
        queue: "tasks",
        deploymentId: "task-build-b"
      }
    }
  }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
  const services = yield* ExecutionStore.makeMemory
  yield* services.executionStore.start(preparedStart)

  const command = scheduleCommand()
  const runnable = yield* services.runCoordinatorStore.claimRunnableRuns({
    requestVersion: 1,
    tenantId: key.tenantId,
    coordinatorId: "worker-fixture-coordinator",
    requestId: "coordinator-claim-1",
    limit: 1,
    leaseDurationMillis: 60_000
  })
  const runLease = runnable.leases[0]
  if (runLease === undefined) {
    return yield* Effect.die("Expected started activity-worker fixture to be runnable")
  }
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
        deploymentId: "task-build-b"
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
    return yield* Effect.die("Expected the committed activity dispatch to be claimable")
  }
  const lease = yield* at(
    1_000,
    services.activityDeliveryStore.acquireAttempt({
      requestVersion: 1,
      key: claim.pointer.key,
      dispatchDigest: claim.pointer.dispatchDigest,
      workerId: "worker-1",
      workerQueue: claim.dispatch.target.queue,
      workerDeploymentId: claim.dispatch.target.deploymentId,
      requestId: "worker-request-1",
      leaseDurationMillis: 100
    })
  )
  return { services, catalog, recovered, lease }
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const makeHandlers = (
  selected: string,
  calls: Array<string>,
  contexts: Array<Node.HandlerContext>
) =>
  registry.toHandlers(registry.of({
    "DurableTask@1.0.0": (request) => {
      calls.push(selected)
      contexts.push(request.context)
      return Effect.succeed({ selected })
    }
  }))

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected activity worker operation to fail")
  }
  return result.failure
}

const assertWorkerError = (
  error: unknown,
  phase: ActivityWorker.ActivityWorkerError["phase"]
): ActivityWorker.ActivityWorkerError => {
  assert.instanceOf(error, ActivityWorker.ActivityWorkerError)
  const workerError = error as ActivityWorker.ActivityWorkerError
  assert.strictEqual(workerError.phase, phase)
  return workerError
}

describe("ActivityWorker", () => {
  it.effect("selects the exact pinned build, exposes stable durable scope, and commits through the lease fence", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const calls: Array<string> = []
      const contexts: Array<Node.HandlerContext> = []
      const handlersA = yield* makeHandlers("build-a", calls, contexts)
      const handlersB = yield* makeHandlers("build-b", calls, contexts)
      const deployed = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-a", handlersA),
        DeploymentHandlers.handlerDeployment("task-build-b", handlersB)
      ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, fixture.catalog))

      const completed = yield* at(
        1_050,
        ActivityWorker.run(
          fixture.recovered,
          fixture.lease,
          "completion-request-1"
        ).pipe(
          Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, deployed),
          Effect.provideService(
            ActivityDeliveryStore.ActivityDeliveryStore,
            fixture.services.activityDeliveryStore
          )
        )
      )
      const history = yield* fixture.services.executionStore.read(key)

      assert.deepStrictEqual(calls, ["build-b"])
      assert.deepStrictEqual(completed.result, {
        _tag: "Succeeded",
        output: { selected: "build-b" }
      })
      assert.deepStrictEqual(contexts, [{
        scope: {
          _tag: "Durable",
          tenantId: key.tenantId,
          handlerDeploymentId: "task-build-b"
        },
        runId: key.runId,
        planId: planInput.id,
        planRevision: planInput.revision,
        nodeId: "task",
        nodeInstanceId: "task",
        attempt: 1,
        idempotencyKey: Identity.durableActivityIdempotencyKey(
          key.tenantId,
          key.runId,
          "task"
        )
      }])
      assert.isFalse(Object.prototype.hasOwnProperty.call(contexts[0], "deliveryEpoch"))
      assert.isFalse(Object.prototype.hasOwnProperty.call(contexts[0]!.scope, "deliveryEpoch"))

      assert.strictEqual(completed.receipt.requestId, "completion-request-1")
      assert.strictEqual(completed.receipt.key.tenantId, key.tenantId)
      assert.strictEqual(completed.receipt.key.intentId, fixture.lease.dispatch.intentId)
      assert.strictEqual(completed.receipt.previousSequence, 1)
      assert.strictEqual(completed.receipt.lastSequence, 2)
      assert.strictEqual(completed.receipt.event.payload._tag, "ActivitySucceeded")
      assert.strictEqual(history.lastSequence, 2)
      assert.strictEqual(history.events[2], completed.receipt.event)
    }))

  it.effect("rejects missing and exact-object-mismatched deployed handlers before user code", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const calls: Array<string> = []
      const contexts: Array<Node.HandlerContext> = []
      const handlersA = yield* makeHandlers("build-a", calls, contexts)
      const missing = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-a", handlersA)
      ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, fixture.catalog))

      const missingResult = yield* ActivityWorker.execute(
        fixture.recovered,
        fixture.lease
      ).pipe(
        Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, missing),
        Effect.result
      )
      const missingError = assertWorkerError(failure(missingResult), "handler")
      assert.strictEqual(missingError.tenantId, key.tenantId)
      assert.strictEqual(missingError.runId, key.runId)
      assert.strictEqual(missingError.intentId, fixture.lease.dispatch.intentId)
      assert.include(missingError.message, "No exact handler implementation")

      const otherHandlers = yield* otherRegistry.toHandlers(otherRegistry.of({
        "DurableTask@1.0.0": () => {
          calls.push("mismatched")
          return Effect.succeed({ selected: "mismatched" })
        }
      }))
      const otherCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("task-build-b", otherTaskObject)
        ]
      })
      const mismatched = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-b", otherHandlers)
      ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, otherCatalog))
      const mismatchedResult = yield* ActivityWorker.execute(
        fixture.recovered,
        fixture.lease
      ).pipe(
        Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, mismatched),
        Effect.result
      )

      assertWorkerError(failure(mismatchedResult), "handler")
      assert.deepStrictEqual(calls, [])
      assert.deepStrictEqual(contexts, [])
    }))

  it.effect("rejects hostile lease accessors and forged provenance copies without invoking user code", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const calls: Array<string> = []
      const contexts: Array<Node.HandlerContext> = []
      const handlers = yield* makeHandlers("build-b", calls, contexts)
      const deployed = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-b", handlers)
      ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, fixture.catalog))

      let getterReads = 0
      const hostileLease = Object.defineProperty(
        { ...fixture.lease },
        "dispatch",
        {
          enumerable: true,
          get: () => {
            getterReads++
            return fixture.lease.dispatch
          }
        }
      ) as ActivityDeliveryStore.ActivityLease
      const hostileResult = yield* ActivityWorker.execute(
        fixture.recovered,
        hostileLease
      ).pipe(
        Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, deployed),
        Effect.result
      )
      assertWorkerError(failure(hostileResult), "lease")
      assert.strictEqual(getterReads, 0)

      const copiedRunResult = yield* ActivityWorker.execute(
        { ...fixture.recovered } as DurableRecovery.RecoveredRun<typeof definition>,
        fixture.lease
      ).pipe(
        Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, deployed),
        Effect.result
      )
      assertWorkerError(failure(copiedRunResult), "run")

      const forgedRegistry = DeploymentHandlers.DeploymentHandlerRegistry.of({
        ...deployed
      })
      const forgedRegistryResult = yield* ActivityWorker.execute(
        fixture.recovered,
        fixture.lease
      ).pipe(
        Effect.provideService(DeploymentHandlers.DeploymentHandlerRegistry, forgedRegistry),
        Effect.result
      )
      assertWorkerError(failure(forgedRegistryResult), "handler")
      assert.deepStrictEqual(calls, [])
      assert.deepStrictEqual(contexts, [])
    }))
})
