import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DurableStart from "../src/DurableStart.ts"
import type * as Event from "../src/Event.ts"
import * as ExecutionStore from "../src/ExecutionStore.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"
import * as Identity from "../src/Identity.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStore from "../src/PlanStore.ts"
import * as Registry from "../src/Registry.ts"
import * as RunCoordinatorStore from "../src/RunCoordinatorStore.ts"
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

const left = Node.make("CoordinatorLeft", { version: "1.0.0" })
const right = Node.make("CoordinatorRight", { version: "1.0.0" })

const definition = Workflow.make("run-coordinator-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(left, right),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "run-coordinator-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    {
      id: "left",
      type: left.type,
      version: left.version,
      config: {}
    },
    {
      id: "right",
      type: right.type,
      version: right.version,
      config: {}
    }
  ],
  edges: []
}

const key = (tenantId: string, runId: string): PlanStore.RunKey => ({
  tenantId,
  runId
})

const makePreparedStart = (runKey: PlanStore.RunKey) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, planInput)
    const plan = yield* Decision.prepare(compiled)
    const catalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        Deployment.workflowDefinition("workflow-build-1", definition)
      ],
      handlerDefinitions: [
        Deployment.handlerDefinition("left-build-1", left),
        Deployment.handlerDefinition("right-build-1", right)
      ]
    })
    return yield* DurableStart.prepare(plan, {}, {
      tenantId: runKey.tenantId,
      runId: runKey.runId,
      workflowIdentity: `workflow/${runKey.runId}`,
      requestId: `start-${runKey.runId}`,
      definitionDeploymentId: "workflow-build-1",
      dispatchTargets: {
        left: {
          queue: "tasks",
          deploymentId: "left-build-1"
        },
        right: {
          queue: "tasks",
          deploymentId: "right-build-1"
        }
      }
    }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
  })

const startRuns = (
  executionStore: ExecutionStore.ExecutionStore.Service,
  keys: ReadonlyArray<PlanStore.RunKey>
) =>
  Effect.forEach(
    keys,
    (runKey) =>
      Effect.flatMap(
        makePreparedStart(runKey),
        (prepared) => executionStore.start(prepared)
      ),
    { concurrency: 1 }
  )

const claimRequest = (
  tenantId: string,
  coordinatorId: string,
  requestId: string,
  overrides: Partial<RunCoordinatorStore.ClaimRunnableRunsRequest> = {}
): RunCoordinatorStore.ClaimRunnableRunsRequest => ({
  requestVersion: 1,
  tenantId,
  coordinatorId,
  requestId,
  limit: 10,
  leaseDurationMillis: 100,
  ...overrides
})

const scheduleCommand = (
  runId: string,
  nodeId: "left" | "right"
): ExecutionStore.ScheduleActivityCommand => ({
  commandVersion: 1,
  commandId: Command.scheduleActivityCommandId(runId, nodeId, 1),
  payload: {
    _tag: "ScheduleActivity",
    activityId: Command.activityId(runId, nodeId, 1),
    nodeId,
    nodeInstanceId: nodeId,
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey(runId, nodeId),
    input: {}
  }
})

const scheduleEvent = (
  command: ExecutionStore.ScheduleActivityCommand
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

const dispatch = (
  command: ExecutionStore.ScheduleActivityCommand
): ExecutionStore.ActivityDispatchDraft => ({
  dispatchVersion: 1,
  _tag: "Activity",
  intentId: command.commandId,
  sourceEventId: command.commandId,
  command,
  target: {
    queue: "tasks",
    deploymentId: command.payload.nodeId === "left"
      ? "left-build-1"
      : "right-build-1"
  }
})

const decision = (
  runKey: PlanStore.RunKey,
  expectedLastSequence: number,
  events: HistoryStore.EventDraft | ReadonlyArray<HistoryStore.EventDraft>,
  dispatches: ReadonlyArray<ExecutionStore.ActivityDispatchDraft> = []
): ExecutionStore.DecisionCommitDraft => ({
  commitVersion: 1,
  key: runKey,
  expectedLastSequence,
  events: (Array.isArray(events) ? events : [events]) as [
    HistoryStore.EventDraft,
    ...Array<HistoryStore.EventDraft>
  ],
  dispatches
})

const fencedDecision = (
  lease: RunCoordinatorStore.RunLease,
  requestId: string,
  commit: ExecutionStore.DecisionCommitDraft
): RunCoordinatorStore.CommitDecisionRequest => ({
  requestVersion: 1,
  ref: lease.ref,
  requestId,
  commit
})

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected coordinator store operation to fail")
  }
  return result.failure
}

describe("RunCoordinatorStore", () => {
  it.effect("claims deterministic tenant-bounded batches with exact retry, conflict, and expiry fencing", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      yield* startRuns(services.executionStore, [
        key("tenant-a", "run-z"),
        key("tenant-a", "run-a"),
        key("tenant-a", "run-m"),
        key("tenant-b", "run-a")
      ])

      const request = claimRequest(
        "tenant-a",
        "coordinator-a",
        "claim-a-1",
        { limit: 2 }
      )
      const first = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(request)
      )
      assert.deepStrictEqual(
        first.leases.map((lease) => lease.ref.key),
        [
          key("tenant-a", "run-a"),
          key("tenant-a", "run-m")
        ]
      )
      assert.deepStrictEqual(
        first.leases.map((lease) => lease.ref.coordinatorEpoch),
        [1, 1]
      )

      const exact = yield* at(
        Number.MAX_SAFE_INTEGER,
        services.runCoordinatorStore.claimRunnableRuns(request)
      )
      assert.strictEqual(exact, first)
      const conflict = yield* Effect.result(at(
        1_001,
        services.runCoordinatorStore.claimRunnableRuns({
          ...request,
          limit: 3
        })
      ))
      assert.instanceOf(
        failure(conflict),
        RunCoordinatorStore.CoordinatorRequestConflict
      )

      const tenantB = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest("tenant-b", "coordinator-b", "claim-b-1")
        )
      )
      assert.deepStrictEqual(
        tenantB.leases.map((lease) => lease.ref.key),
        [key("tenant-b", "run-a")]
      )

      const remaining = yield* at(
        1_050,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest("tenant-a", "coordinator-next", "claim-a-2")
        )
      )
      assert.deepStrictEqual(
        remaining.leases.map((lease) => lease.ref.key.runId),
        ["run-z"]
      )

      const stolen = yield* at(
        1_100,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            "tenant-a",
            "coordinator-steal",
            "claim-a-3",
            { limit: 2 }
          )
        )
      )
      assert.deepStrictEqual(
        stolen.leases.map((lease) => lease.ref.key.runId),
        ["run-a", "run-m"]
      )
      assert.deepStrictEqual(
        stolen.leases.map((lease) => lease.ref.coordinatorEpoch),
        [2, 2]
      )

      const stale = yield* Effect.result(at(
        1_101,
        services.runCoordinatorStore.renewRunLease({
          requestVersion: 1,
          ref: first.leases[0]!.ref,
          requestId: "renew-stolen",
          leaseDurationMillis: 100
        })
      ))
      assert.instanceOf(failure(stale), RunCoordinatorStore.StaleRunLease)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("renews and releases one generation exactly while preserving epochs and runnable state", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      yield* startRuns(services.executionStore, [
        key("tenant-a", "run-renew")
      ])
      const first = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest("tenant-a", "coordinator-a", "claim-renew")
        )
      )
      const lease = first.leases[0]!
      const renewalRequest: RunCoordinatorStore.RenewRunLeaseRequest = {
        requestVersion: 1,
        ref: lease.ref,
        requestId: "renew-1",
        leaseDurationMillis: 200
      }
      const renewed = yield* at(
        1_050,
        services.runCoordinatorStore.renewRunLease(renewalRequest)
      )
      assert.strictEqual(renewed.ref, lease.ref)
      assert.strictEqual(
        renewed.ref.coordinatorEpoch,
        lease.ref.coordinatorEpoch
      )
      assert.notStrictEqual(renewed.expiresAt, lease.expiresAt)
      assert.strictEqual(
        yield* at(
          Number.MAX_SAFE_INTEGER,
          services.runCoordinatorStore.renewRunLease(renewalRequest)
        ),
        renewed
      )

      const releaseRequest: RunCoordinatorStore.ReleaseRunLeaseRequest = {
        requestVersion: 1,
        ref: renewed.ref,
        requestId: "release-1"
      }
      const released = yield* at(
        1_100,
        services.runCoordinatorStore.releaseRunLease(releaseRequest)
      )
      assert.deepStrictEqual(released.ref, renewed.ref)
      const reclaimed = yield* at(
        1_100,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest("tenant-a", "coordinator-b", "claim-after-release")
        )
      )
      assert.strictEqual(reclaimed.leases.length, 1)
      assert.strictEqual(
        reclaimed.leases[0]!.ref.coordinatorEpoch,
        lease.ref.coordinatorEpoch + 1
      )
      assert.strictEqual(
        yield* at(
          Number.MAX_SAFE_INTEGER,
          services.runCoordinatorStore.releaseRunLease(releaseRequest)
        ),
        released
      )

      const stale = yield* Effect.result(at(
        1_110,
        services.runCoordinatorStore.renewRunLease({
          ...renewalRequest,
          requestId: "renew-old-generation"
        })
      ))
      assert.instanceOf(failure(stale), RunCoordinatorStore.StaleRunLease)

      const idle = yield* at(
        1_110,
        services.runCoordinatorStore.acknowledgeIdle({
          requestVersion: 1,
          ref: reclaimed.leases[0]!.ref,
          requestId: "idle-after-release",
          observedLastSequence: reclaimed.leases[0]!.observedLastSequence
        })
      )
      assert.strictEqual(idle.observedLastSequence, 0)
      const empty = yield* at(
        1_111,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest("tenant-a", "coordinator-c", "claim-after-idle")
        )
      )
      assert.deepStrictEqual(empty.leases, [])
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("cycles bounded claims fairly and an exact idle retry cannot erase a later wake", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      const keys = [
        key("tenant-a", "run-a"),
        key("tenant-a", "run-b"),
        key("tenant-a", "run-c")
      ]
      yield* startRuns(services.executionStore, keys)
      const order: Array<string> = []
      for (let index = 0; index < 4; index++) {
        const claimed = yield* at(
          1_000 + index,
          services.runCoordinatorStore.claimRunnableRuns(
            claimRequest(
              "tenant-a",
              `coordinator-${index}`,
              `fair-claim-${index}`,
              { limit: 1, leaseDurationMillis: 1_000 }
            )
          )
        )
        const lease = claimed.leases[0]!
        order.push(lease.ref.key.runId)
        yield* at(
          1_000 + index,
          services.runCoordinatorStore.releaseRunLease({
            requestVersion: 1,
            ref: lease.ref,
            requestId: `fair-release-${index}`
          })
        )
      }
      assert.deepStrictEqual(order, ["run-a", "run-b", "run-c", "run-a"])

      const idleRunKey = key("tenant-idle", "run-idle")
      yield* startRuns(services.executionStore, [idleRunKey])
      const idleClaim = yield* at(
        2_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(idleRunKey.tenantId, "idle-coordinator", "idle-claim", {
            limit: 1,
            leaseDurationMillis: 1_000
          })
        )
      )
      const idleRequest: RunCoordinatorStore.AcknowledgeIdleRequest = {
        requestVersion: 1,
        ref: idleClaim.leases[0]!.ref,
        requestId: "idle-once",
        observedLastSequence: 0
      }
      const idle = yield* at(
        2_001,
        services.runCoordinatorStore.acknowledgeIdle(idleRequest)
      )
      const idleKey = idle.ref.key
      yield* at(
        2_002,
        services.executionStore.requestCancellation({
          requestVersion: 1,
          key: idleKey,
          requestId: "cancel-after-idle"
        })
      )
      assert.strictEqual(
        yield* at(
          Number.MAX_SAFE_INTEGER,
          services.runCoordinatorStore.acknowledgeIdle(idleRequest)
        ),
        idle
      )
      const awakened = yield* at(
        2_003,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(idleKey.tenantId, "after-idle", "after-idle-claim", {
            limit: 1
          })
        )
      )
      assert.strictEqual(awakened.leases[0]!.ref.key.runId, idleKey.runId)
      assert.strictEqual(awakened.leases[0]!.observedLastSequence, 1)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("does not clear a cancellation wakeup observed after coordinator recovery", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      const runKey = key("tenant-a", "run-cancel-race")
      yield* startRuns(services.executionStore, [runKey])
      const claimed = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            runKey.tenantId,
            "coordinator-a",
            "claim-cancel-race",
            { leaseDurationMillis: 1_000 }
          )
        )
      )
      const lease = claimed.leases[0]!
      assert.strictEqual(lease.observedLastSequence, 0)

      yield* at(
        1_010,
        services.executionStore.requestCancellation({
          requestVersion: 1,
          key: runKey,
          requestId: "cancel-1"
        })
      )
      const idleResult = yield* Effect.result(at(
        1_020,
        services.runCoordinatorStore.acknowledgeIdle({
          requestVersion: 1,
          ref: lease.ref,
          requestId: "idle-stale-head",
          observedLastSequence: lease.observedLastSequence
        })
      ))
      const advanced = failure(idleResult)
      assert.instanceOf(advanced, RunCoordinatorStore.RunSequenceAdvanced)
      if (advanced instanceof RunCoordinatorStore.RunSequenceAdvanced) {
        assert.strictEqual(advanced.observedLastSequence, 0)
        assert.strictEqual(advanced.actualLastSequence, 1)
      }

      yield* at(
        1_020,
        services.runCoordinatorStore.releaseRunLease({
          requestVersion: 1,
          ref: lease.ref,
          requestId: "release-cancel-race"
        })
      )
      const reclaimed = yield* at(
        1_020,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            runKey.tenantId,
            "coordinator-b",
            "reclaim-cancel-race"
          )
        )
      )
      assert.strictEqual(reclaimed.leases.length, 1)
      assert.strictEqual(reclaimed.leases[0]!.observedLastSequence, 1)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("does not clear a later activity-completion wakeup from an earlier observed head", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      const runKey = key("tenant-a", "run-completion-race")
      yield* startRuns(services.executionStore, [runKey])
      const initialClaim = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            runKey.tenantId,
            "coordinator-initial",
            "claim-initial",
            { leaseDurationMillis: 1_000 }
          )
        )
      )
      const leftCommand = scheduleCommand(runKey.runId, "left")
      const rightCommand = scheduleCommand(runKey.runId, "right")
      yield* at(
        1_005,
        services.runCoordinatorStore.commitDecision(
          fencedDecision(
            initialClaim.leases[0]!,
            "commit-schedules",
            decision(
              runKey,
              0,
              [
                scheduleEvent(leftCommand),
                scheduleEvent(rightCommand)
              ],
              [
                dispatch(leftCommand),
                dispatch(rightCommand)
              ]
            )
          )
        )
      )

      const relay = yield* at(
        1_010,
        services.activityDeliveryStore.claimOutbox({
          requestVersion: 1,
          tenantId: runKey.tenantId,
          relayId: "relay-1",
          requestId: "relay-completions",
          queue: "tasks",
          limit: 10,
          leaseDurationMillis: 1_000
        })
      )
      assert.strictEqual(relay.claims.length, 2)
      const leftClaim = relay.claims.find(
        (claim) => claim.dispatch.command.payload.nodeId === "left"
      )!
      const rightClaim = relay.claims.find(
        (claim) => claim.dispatch.command.payload.nodeId === "right"
      )!
      const leftLease = yield* at(
        1_010,
        services.activityDeliveryStore.acquireAttempt({
          requestVersion: 1,
          key: leftClaim.pointer.key,
          dispatchDigest: leftClaim.pointer.dispatchDigest,
          workerId: "left-worker",
          workerQueue: leftClaim.dispatch.target.queue,
          workerDeploymentId: leftClaim.dispatch.target.deploymentId,
          requestId: "acquire-left",
          leaseDurationMillis: 1_000
        })
      )
      const rightLease = yield* at(
        1_010,
        services.activityDeliveryStore.acquireAttempt({
          requestVersion: 1,
          key: rightClaim.pointer.key,
          dispatchDigest: rightClaim.pointer.dispatchDigest,
          workerId: "right-worker",
          workerQueue: rightClaim.dispatch.target.queue,
          workerDeploymentId: rightClaim.dispatch.target.deploymentId,
          requestId: "acquire-right",
          leaseDurationMillis: 1_000
        })
      )
      yield* at(
        1_020,
        services.activityDeliveryStore.completeAttempt({
          requestVersion: 1,
          ref: leftLease.ref,
          requestId: "complete-left",
          result: { _tag: "Succeeded", output: {} }
        })
      )

      const coordinatorClaim = yield* at(
        1_030,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            runKey.tenantId,
            "coordinator-race",
            "claim-between-completions",
            { leaseDurationMillis: 1_000 }
          )
        )
      )
      const coordinatorLease = coordinatorClaim.leases[0]!
      assert.strictEqual(coordinatorLease.observedLastSequence, 3)

      yield* at(
        1_040,
        services.activityDeliveryStore.completeAttempt({
          requestVersion: 1,
          ref: rightLease.ref,
          requestId: "complete-right",
          result: { _tag: "Succeeded", output: {} }
        })
      )
      const idleResult = yield* Effect.result(at(
        1_050,
        services.runCoordinatorStore.acknowledgeIdle({
          requestVersion: 1,
          ref: coordinatorLease.ref,
          requestId: "idle-between-completions",
          observedLastSequence: coordinatorLease.observedLastSequence
        })
      ))
      const advanced = failure(idleResult)
      assert.instanceOf(advanced, RunCoordinatorStore.RunSequenceAdvanced)
      if (advanced instanceof RunCoordinatorStore.RunSequenceAdvanced) {
        assert.strictEqual(advanced.observedLastSequence, 3)
        assert.strictEqual(advanced.actualLastSequence, 4)
      }

      yield* at(
        1_050,
        services.runCoordinatorStore.releaseRunLease({
          requestVersion: 1,
          ref: coordinatorLease.ref,
          requestId: "release-completion-race"
        })
      )
      const reclaimed = yield* at(
        1_050,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            runKey.tenantId,
            "coordinator-after-race",
            "reclaim-completion-race"
          )
        )
      )
      assert.strictEqual(reclaimed.leases.length, 1)
      assert.strictEqual(reclaimed.leases[0]!.observedLastSequence, 4)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("suppresses unresolved delivery when a parallel activity failure terminates the run", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      const runKey = key("tenant-a", "run-terminal-failure")
      yield* startRuns(services.executionStore, [runKey])
      const initial = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(runKey.tenantId, "coordinator-initial", "terminal-initial", {
            leaseDurationMillis: 1_000
          })
        )
      )
      const leftCommand = scheduleCommand(runKey.runId, "left")
      const rightCommand = scheduleCommand(runKey.runId, "right")
      yield* at(
        1_001,
        services.runCoordinatorStore.commitDecision(
          fencedDecision(
            initial.leases[0]!,
            "terminal-schedules",
            decision(
              runKey,
              0,
              [scheduleEvent(leftCommand), scheduleEvent(rightCommand)],
              [dispatch(leftCommand), dispatch(rightCommand)]
            )
          )
        )
      )
      const relay = yield* at(
        1_010,
        services.activityDeliveryStore.claimOutbox({
          requestVersion: 1,
          tenantId: runKey.tenantId,
          relayId: "relay-terminal",
          requestId: "relay-terminal-initial",
          queue: "tasks",
          limit: 10,
          leaseDurationMillis: 1_000
        })
      )
      const leftClaim = relay.claims.find(
        (claim) => claim.dispatch.command.payload.nodeId === "left"
      )!
      const rightClaim = relay.claims.find(
        (claim) => claim.dispatch.command.payload.nodeId === "right"
      )!
      const leftLease = yield* at(
        1_011,
        services.activityDeliveryStore.acquireAttempt({
          requestVersion: 1,
          key: leftClaim.pointer.key,
          dispatchDigest: leftClaim.pointer.dispatchDigest,
          workerId: "left-worker",
          workerQueue: leftClaim.dispatch.target.queue,
          workerDeploymentId: leftClaim.dispatch.target.deploymentId,
          requestId: "terminal-acquire-left",
          leaseDurationMillis: 1_000
        })
      )
      const failureValue = { reason: "boom" }
      yield* at(
        1_012,
        services.activityDeliveryStore.completeAttempt({
          requestVersion: 1,
          ref: leftLease.ref,
          requestId: "terminal-complete-left",
          result: { _tag: "Failed", failure: failureValue }
        })
      )
      const terminalClaim = yield* at(
        1_020,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(runKey.tenantId, "coordinator-terminal", "terminal-claim", {
            leaseDurationMillis: 1_000
          })
        )
      )
      yield* at(
        1_021,
        services.runCoordinatorStore.commitDecision(
          fencedDecision(
            terminalClaim.leases[0]!,
            "terminal-commit",
            decision(runKey, 3, {
              eventVersion: 1,
              eventId: Identity.failRunCommandId(runKey.runId),
              payload: {
                _tag: "RunFailed",
                failure: {
                  _tag: "ActivityFailure",
                  activityId: leftCommand.payload.activityId,
                  nodeId: "left",
                  nodeInstanceId: "left",
                  attempt: 1,
                  failure: failureValue
                }
              }
            })
          )
        )
      )

      const afterTerminal = yield* at(
        1_022,
        services.activityDeliveryStore.claimOutbox({
          requestVersion: 1,
          tenantId: runKey.tenantId,
          relayId: "relay-after-terminal",
          requestId: "relay-after-terminal",
          queue: "tasks",
          limit: 10,
          leaseDurationMillis: 1_000
        })
      )
      assert.deepStrictEqual(afterTerminal.claims, [])
      const acquireRight = yield* Effect.result(at(
        1_022,
        services.activityDeliveryStore.acquireAttempt({
          requestVersion: 1,
          key: rightClaim.pointer.key,
          dispatchDigest: rightClaim.pointer.dispatchDigest,
          workerId: "right-worker",
          workerQueue: rightClaim.dispatch.target.queue,
          workerDeploymentId: rightClaim.dispatch.target.deploymentId,
          requestId: "terminal-acquire-right",
          leaseDurationMillis: 1_000
        })
      ))
      const suppressed = failure(acquireRight)
      assert.instanceOf(suppressed, ActivityDeliveryStore.ActivityCompletionSuppressed)
      if (suppressed instanceof ActivityDeliveryStore.ActivityCompletionSuppressed) {
        assert.strictEqual(suppressed.reason, "RunTerminal")
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("requires the public fenced envelope and preserves exact commit retry after clearing the lease", () =>
    Effect.gen(function*() {
      const services = yield* ExecutionStore.makeMemory
      const runKey = key("tenant-a", "run-commit")
      yield* startRuns(services.executionStore, [runKey])
      const claimed = yield* at(
        1_000,
        services.runCoordinatorStore.claimRunnableRuns(
          claimRequest(
            runKey.tenantId,
            "coordinator-a",
            "claim-commit",
            { leaseDurationMillis: 1_000 }
          )
        )
      )
      const command = scheduleCommand(runKey.runId, "left")
      const commit = decision(
        runKey,
        0,
        scheduleEvent(command),
        [dispatch(command)]
      )

      const bare = yield* Effect.result(
        services.executionStore.commitDecision(
          commit as unknown as RunCoordinatorStore.CommitDecisionRequest
        )
      )
      const bareError = failure(bare)
      assert.instanceOf(
        bareError,
        RunCoordinatorStore.InvalidCoordinatorRequest
      )
      if (bareError instanceof RunCoordinatorStore.InvalidCoordinatorRequest) {
        assert.strictEqual(bareError.operation, "commitDecision")
      }
      assert.strictEqual(
        (yield* services.executionStore.read(runKey)).lastSequence,
        0
      )

      const request = fencedDecision(
        claimed.leases[0]!,
        "fenced-commit-1",
        commit
      )
      const committed = yield* at(
        1_010,
        services.executionStore.commitDecision(request)
      )
      assert.strictEqual(committed.previousSequence, 0)
      assert.strictEqual(committed.lastSequence, 1)

      const exact = yield* at(
        Number.MAX_SAFE_INTEGER,
        services.runCoordinatorStore.commitDecision(request)
      )
      assert.strictEqual(exact, committed)

      const conflict = yield* Effect.result(at(
        1_020,
        services.runCoordinatorStore.commitDecision({
          ...request,
          commit: {
            ...request.commit,
            expectedLastSequence: 1
          }
        })
      ))
      assert.instanceOf(
        failure(conflict),
        RunCoordinatorStore.CoordinatorRequestConflict
      )

      const stale = yield* Effect.result(at(
        1_020,
        services.runCoordinatorStore.commitDecision({
          ...request,
          requestId: "fenced-commit-new-request"
        })
      ))
      assert.instanceOf(failure(stale), RunCoordinatorStore.StaleRunLease)
      assert.strictEqual(
        (yield* services.executionStore.read(runKey)).lastSequence,
        1
      )
      assert.strictEqual(
        (yield* services.executionStore.inspectOutbox(runKey)).length,
        1
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
