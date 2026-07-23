import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Cancellation from "../src/ActivityCancellationDelivery.ts"
import * as ActivityDelivery from "../src/ActivityDeliveryStore.ts"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Deployment from "../src/Deployment.ts"
import type * as Dispatch from "../src/Dispatch.ts"
import * as DurableStart from "../src/DurableStart.ts"
import type * as Event from "../src/Event.ts"
import * as ExecutionStore from "../src/ExecutionStore.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const digestBytes = (data: Uint8Array): Uint8Array => {
  const output = new Uint8Array(32)
  for (let index = 0; index < data.length; index++) {
    output[index % output.length] ^= data[index]! ^ index
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

const at = <A, E, R>(
  millis: number,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => Effect.provideService(effect, Clock.Clock, clock(millis))

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const task = Node.make("CancellationTask", {
  version: "1.0.0",
  inputs: {
    payload: Port.input(Schema.Json, {
      contract: "activity-cancellation/json"
    })
  },
  outputs: {}
})

const definition = Workflow.make("activity-cancellation-workflow", {
  version: "1.0.0",
  inputs: {
    payload: Port.output(Schema.Json, {
      contract: "activity-cancellation/json"
    })
  },
  outputs: {},
  nodes: Registry.make(task),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "activity-cancellation-plan",
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
  edges: [{
    _tag: "DataEdge" as const,
    id: "payload-task",
    source: {
      _tag: "WorkflowInput" as const,
      input: "payload"
    },
    target: {
      _tag: "NodeInput" as const,
      nodeId: "task",
      input: "payload"
    }
  }]
}

const scheduleCommand = (
  runId: string
): Dispatch.ScheduleActivityCommand => ({
  commandVersion: 1,
  commandId: Command.scheduleActivityCommandId(runId, "task", 1),
  payload: {
    _tag: "ScheduleActivity",
    activityId: Command.activityId(runId, "task", 1),
    nodeId: "task",
    nodeInstanceId: "task",
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey(runId, "task"),
    input: { payload: { id: "document-1" } }
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

interface Fixture {
  readonly key: PlanStore.RunKey
  readonly executionStore: ExecutionStore.ExecutionStore.Service
  readonly deliveryStore: ActivityDelivery.ActivityDeliveryStore.Service
  readonly cancellationStore: Cancellation.ActivityCancellationDeliveryStore.Service
  readonly coordinatorStore: ExecutionStore.MemoryServices[
    "runCoordinatorStore"
  ]
  readonly dispatch: Dispatch.ActivityDispatch
  readonly relayClaim: ActivityDelivery.RelayClaim
}

const makeFixture = (
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
    const key = { tenantId: "tenant-a", runId }
    const prepared = yield* DurableStart.prepare(
      plan,
      { payload: { id: "document-1" } },
      {
        tenantId: key.tenantId,
        runId,
        workflowIdentity: `document/${runId}`,
        requestId: `start-${runId}`,
        definitionDeploymentId: "workflow-build-1",
        dispatchTargets: {
          task: {
            queue: "tasks",
            deploymentId: "task-build-1"
          }
        }
      }
    ).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
    const services = yield* ExecutionStore.makeMemory
    yield* services.executionStore.start(prepared)
    const runnable = yield* services.runCoordinatorStore
      .claimRunnableRuns({
        requestVersion: 1,
        tenantId: key.tenantId,
        coordinatorId: "fixture-coordinator",
        requestId: `initial-claim-${runId}`,
        limit: 1,
        leaseDurationMillis: 60_000
      })
    const runLease = runnable.leases[0]
    if (runLease === undefined) {
      return yield* Effect.die("expected runnable fixture")
    }
    const command = scheduleCommand(runId)
    yield* services.executionStore.commitDecision({
      requestVersion: 1,
      ref: runLease.ref,
      requestId: `schedule-commit-${runId}`,
      commit: {
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
    })
    const dispatches = yield* services.executionStore.inspectOutbox(key)
    const relay = yield* services.activityDeliveryStore.claimOutbox({
      requestVersion: 1,
      tenantId: key.tenantId,
      relayId: "fixture-relay",
      requestId: `relay-${runId}`,
      queue: "tasks",
      limit: 1,
      leaseDurationMillis: 100
    })
    const relayClaim = relay.claims[0]
    if (relayClaim === undefined) {
      return yield* Effect.die("expected relay claim")
    }
    return {
      key,
      executionStore: services.executionStore,
      deliveryStore: services.activityDeliveryStore,
      cancellationStore: services.activityCancellationDeliveryStore,
      coordinatorStore: services.runCoordinatorStore,
      dispatch: dispatches[0]!,
      relayClaim
    }
  })

const acquire = (
  fixture: Fixture,
  requestId: string,
  leaseDurationMillis = 100
) =>
  fixture.deliveryStore.acquireAttempt({
    requestVersion: 1,
    key: fixture.relayClaim.pointer.key,
    dispatchDigest: fixture.relayClaim.pointer.dispatchDigest,
    workerId: "worker-a",
    workerQueue: fixture.dispatch.target.queue,
    workerDeploymentId: fixture.dispatch.target.deploymentId,
    requestId,
    leaseDurationMillis
  })

const claimRequest = (
  requestId: string,
  overrides: Partial<Cancellation.ClaimCancellationsRequest> = {}
): Cancellation.ClaimCancellationsRequest => ({
  requestVersion: 1,
  tenantId: "tenant-a",
  workerId: "worker-a",
  workerIncarnationId: "worker-incarnation-a",
  workerDeploymentId: "task-build-1",
  claimantId: "claimant-a",
  requestId,
  limit: 10,
  leaseDurationMillis: 100,
  ...overrides
})

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) {
    throw new Error("expected failure")
  }
  return result.failure
}

describe("ActivityCancellationDeliveryStore", () => {
  it.effect("targets every issued generation including expired predecessors", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const first = yield* at(1_000, acquire(fixture, "acquire-1"))
      const second = yield* at(1_101, acquire(fixture, "acquire-2"))

      const cancelled = yield* at(
        1_102,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel-1"
        })
      )
      const exact = yield* at(
        9_000,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel-1"
        })
      )
      assert.strictEqual(exact, cancelled)

      const wrongWorker = yield* at(
        1_103,
        fixture.cancellationStore.claimCancellations(
          claimRequest("wrong-worker", { workerId: "worker-b" })
        )
      )
      const wrongDeployment = yield* at(
        1_103,
        fixture.cancellationStore.claimCancellations(
          claimRequest("wrong-deployment", {
            workerDeploymentId: "other-build"
          })
        )
      )
      const claimed = yield* at(
        1_103,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim-both")
        )
      )

      assert.deepStrictEqual(wrongWorker.claims, [])
      assert.deepStrictEqual(wrongDeployment.claims, [])
      assert.strictEqual(claimed.claims.length, 2)
      assert.deepStrictEqual(
        new Set(claimed.claims.map((claim) => claim.ref.activityLeaseRef.leaseId)),
        new Set([first.ref.leaseId, second.ref.leaseId])
      )
      assert.isTrue(claimed.claims.every((claim) =>
        claim.issued.reason === "RunCancellationRequested" &&
        claim.issued.cancellationRequestId === "cancel-1" &&
        claim.issued.sourceEventId === cancelled.events[0].eventId
      ))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("makes claim requests exactly retry-safe and conflict-detecting", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("run-claim-retry")
      yield* at(2_000, acquire(fixture, "acquire"))
      yield* at(
        2_001,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel"
        })
      )
      const request = claimRequest("claim-retry")
      const first = yield* at(
        2_002,
        fixture.cancellationStore.claimCancellations(request)
      )
      const exact = yield* at(
        50_000,
        fixture.cancellationStore.claimCancellations(request)
      )
      const conflict = yield* at(
        2_003,
        fixture.cancellationStore.claimCancellations({
          ...request,
          limit: 1
        })
      ).pipe(Effect.result)

      assert.strictEqual(exact, first)
      assert.instanceOf(
        failure(conflict),
        Cancellation.CancellationDeliveryRequestConflict
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("reclaims expired claims and fences stale acknowledgements and releases", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("run-reclaim")
      yield* at(3_000, acquire(fixture, "acquire"))
      yield* at(
        3_001,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel"
        })
      )
      const first = yield* at(
        3_002,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim-first")
        )
      )
      const reclaimed = yield* at(
        3_103,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim-second")
        )
      )
      const old = first.claims[0]!
      const current = reclaimed.claims[0]!
      assert.strictEqual(current.ref.claimEpoch, old.ref.claimEpoch + 1)
      assert.notStrictEqual(current.ref.claimLeaseId, old.ref.claimLeaseId)

      const staleAck = yield* at(
        3_104,
        fixture.cancellationStore.acknowledgeCancellation({
          requestVersion: 1,
          requestId: "stale-ack",
          ref: old.ref,
          disposition: "Interrupted"
        })
      ).pipe(Effect.result)
      const staleRelease = yield* at(
        3_104,
        fixture.cancellationStore.releaseCancellationClaim({
          requestVersion: 1,
          requestId: "stale-release",
          ref: old.ref
        })
      ).pipe(Effect.result)

      assert.instanceOf(
        failure(staleAck),
        Cancellation.StaleCancellationClaim
      )
      assert.instanceOf(
        failure(staleRelease),
        Cancellation.StaleCancellationClaim
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("supports idempotent release and fences the released generation", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("run-release")
      yield* at(4_000, acquire(fixture, "acquire"))
      yield* at(
        4_001,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel"
        })
      )
      const claimed = yield* at(
        4_002,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim")
        )
      )
      const ref = claimed.claims[0]!.ref
      const request = {
        requestVersion: 1 as const,
        requestId: "release",
        ref
      }
      const released = yield* at(
        4_003,
        fixture.cancellationStore.releaseCancellationClaim(request)
      )
      const exact = yield* at(
        9_000,
        fixture.cancellationStore.releaseCancellationClaim(request)
      )
      const staleAck = yield* at(
        4_004,
        fixture.cancellationStore.acknowledgeCancellation({
          requestVersion: 1,
          requestId: "ack-after-release",
          ref,
          disposition: "Interrupted"
        })
      ).pipe(Effect.result)

      assert.strictEqual(exact, released)
      assert.instanceOf(
        failure(staleAck),
        Cancellation.StaleCancellationClaim
      )
      assert.strictEqual(
        (failure(staleAck) as Cancellation.StaleCancellationClaim).reason,
        "Released"
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("fails NotRunning closed and handles duplicate acknowledgement semantics", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("run-ack")
      yield* at(5_000, acquire(fixture, "acquire"))
      yield* at(
        5_001,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel"
        })
      )
      const claimed = yield* at(
        5_002,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim")
        )
      )
      const ref = claimed.claims[0]!.ref
      const notRunning = yield* at(
        5_003,
        fixture.cancellationStore.acknowledgeCancellation({
          requestVersion: 1,
          requestId: "not-running",
          ref,
          disposition: "NotRunning"
        })
      ).pipe(Effect.result)
      assert.instanceOf(
        failure(notRunning),
        Cancellation.ActivityCancellationDeliveryStoreFailure
      )

      const ackRequest = {
        requestVersion: 1 as const,
        requestId: "ack",
        ref,
        disposition: "Interrupted" as const
      }
      const ack = yield* at(
        5_004,
        fixture.cancellationStore.acknowledgeCancellation(ackRequest)
      )
      const exact = yield* at(
        9_000,
        fixture.cancellationStore.acknowledgeCancellation(ackRequest)
      )
      const duplicate = yield* at(
        5_005,
        fixture.cancellationStore.acknowledgeCancellation({
          ...ackRequest,
          requestId: "ack-duplicate"
        })
      )
      const conflict = yield* at(
        5_005,
        fixture.cancellationStore.acknowledgeCancellation({
          ...ackRequest,
          requestId: "ack-conflict",
          disposition: "AlreadyFinished"
        })
      ).pipe(Effect.result)

      assert.strictEqual(exact, ack)
      assert.strictEqual(duplicate.acknowledgedAt, ack.acknowledgedAt)
      assert.instanceOf(
        failure(conflict),
        Cancellation.CancellationDispositionConflict
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("orders completion and cancellation atomically and retains renew fencing", () =>
    Effect.gen(function*() {
      const completedFirst = yield* makeFixture("run-complete-first")
      const completedLease = yield* at(
        6_000,
        acquire(completedFirst, "acquire")
      )
      yield* at(
        6_001,
        completedFirst.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: completedLease.ref,
          requestId: "complete",
          result: { _tag: "Succeeded", output: {} }
        })
      )
      yield* at(
        6_002,
        completedFirst.executionStore.requestCancellation({
          requestVersion: 1,
          key: completedFirst.key,
          requestId: "cancel"
        })
      )
      const noCancellation = yield* at(
        6_003,
        completedFirst.cancellationStore.claimCancellations(
          claimRequest("claim-completed")
        )
      )
      assert.deepStrictEqual(noCancellation.claims, [])

      const cancelledFirst = yield* makeFixture("run-cancel-first")
      const cancelledLease = yield* at(
        7_000,
        acquire(cancelledFirst, "acquire")
      )
      yield* at(
        7_001,
        cancelledFirst.executionStore.requestCancellation({
          requestVersion: 1,
          key: cancelledFirst.key,
          requestId: "cancel"
        })
      )
      const completion = yield* at(
        7_002,
        cancelledFirst.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: cancelledLease.ref,
          requestId: "complete",
          result: { _tag: "Succeeded", output: {} }
        })
      ).pipe(Effect.result)
      const renewal = yield* at(
        7_002,
        cancelledFirst.deliveryStore.renewAttempt({
          requestVersion: 1,
          ref: cancelledLease.ref,
          requestId: "renew",
          leaseDurationMillis: 100
        })
      ).pipe(Effect.result)
      const cancellation = yield* at(
        7_003,
        cancelledFirst.cancellationStore.claimCancellations(
          claimRequest("claim-cancelled")
        )
      )

      assert.instanceOf(
        failure(completion),
        ActivityDelivery.ActivityCompletionSuppressed
      )
      assert.instanceOf(
        failure(renewal),
        ActivityDelivery.StaleActivityLease
      )
      assert.strictEqual(cancellation.claims.length, 1)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("commits RunCancelled without waiting for delivery acknowledgement", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("run-terminal")
      yield* at(8_000, acquire(fixture, "acquire"))
      yield* at(
        8_001,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel"
        })
      )
      const pending = yield* at(
        8_002,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim-pending")
        )
      )
      assert.strictEqual(pending.claims.length, 1)

      const runnable = yield* at(
        8_003,
        fixture.coordinatorStore.claimRunnableRuns({
          requestVersion: 1,
          tenantId: fixture.key.tenantId,
          coordinatorId: "terminal-coordinator",
          requestId: "terminal-claim",
          limit: 1,
          leaseDurationMillis: 100
        })
      )
      const runLease = runnable.leases[0]
      if (runLease === undefined) {
        throw new Error("expected cancellation-requested run to be runnable")
      }
      yield* at(
        8_004,
        fixture.coordinatorStore.commitDecision({
          requestVersion: 1,
          ref: runLease.ref,
          requestId: "terminal-commit",
          commit: {
            commitVersion: 1,
            key: fixture.key,
            expectedLastSequence: 2,
            events: [{
              eventVersion: 1,
              eventId: Command.cancelRunCommandId(
                fixture.key.runId
              ),
              payload: { _tag: "RunCancelled" }
            }],
            dispatches: []
          }
        })
      )
      const history = yield* fixture.executionStore.read(fixture.key)

      assert.strictEqual(
        history.events.at(-1)?.payload._tag,
        "RunCancelled"
      )
      const noneDuplicated = yield* at(
        8_105,
        fixture.cancellationStore.claimCancellations(
          claimRequest("claim-after-terminal")
        )
      )
      assert.strictEqual(noneDuplicated.claims.length, 1)
      assert.strictEqual(
        noneDuplicated.claims[0]?.issued.reason,
        "RunCancellationRequested"
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("defensively targets an older non-quiescent generation on terminal failure", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("run-terminal-failure")
      const old = yield* at(9_000, acquire(fixture, "acquire-old"))
      const current = yield* at(
        9_101,
        acquire(fixture, "acquire-current")
      )
      const failureValue = { reason: "boom" }
      yield* at(
        9_102,
        fixture.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: current.ref,
          requestId: "complete-current",
          result: {
            _tag: "Failed",
            failure: failureValue
          }
        })
      )
      const runnable = yield* at(
        9_103,
        fixture.coordinatorStore.claimRunnableRuns({
          requestVersion: 1,
          tenantId: fixture.key.tenantId,
          coordinatorId: "failure-coordinator",
          requestId: "failure-claim",
          limit: 1,
          leaseDurationMillis: 100
        })
      )
      const runLease = runnable.leases[0]
      if (runLease === undefined) {
        throw new Error("expected failed activity run to be runnable")
      }
      yield* at(
        9_104,
        fixture.coordinatorStore.commitDecision({
          requestVersion: 1,
          ref: runLease.ref,
          requestId: "failure-commit",
          commit: {
            commitVersion: 1,
            key: fixture.key,
            expectedLastSequence: 2,
            events: [{
              eventVersion: 1,
              eventId: Command.failRunCommandId(
                fixture.key.runId
              ),
              payload: {
                _tag: "RunFailed",
                failure: {
                  _tag: "ActivityFailure",
                  activityId: fixture.dispatch.command.payload.activityId,
                  nodeId: "task",
                  nodeInstanceId: "task",
                  attempt: 1,
                  failure: failureValue
                }
              }
            }],
            dispatches: []
          }
        })
      )
      const claimed = yield* at(
        9_105,
        fixture.cancellationStore.claimCancellations(
          claimRequest("terminal-failure-cancellations")
        )
      )

      assert.strictEqual(claimed.claims.length, 1)
      assert.strictEqual(
        claimed.claims[0]?.ref.activityLeaseRef.leaseId,
        old.ref.leaseId
      )
      assert.strictEqual(
        claimed.claims[0]?.issued.reason,
        "RunTerminal"
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
