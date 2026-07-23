import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
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
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import type * as RunCoordinator from "../src/RunCoordinatorStore.ts"
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

const constantCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: () => Effect.succeed(new Uint8Array(32))
})

const artifactDigestCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(
      new TextDecoder().decode(data).includes("\"artifactVersion\":1")
        ? new Uint8Array(32)
        : digestBytes(data)
    )
})

const key = (tenantId: string, runId: string): PlanStore.RunKey => ({
  tenantId,
  runId
})

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const jsonContract = "execution-store/json"

const charge = Node.make("charge-activity", {
  version: "1.0.0",
  inputs: {
    payload: Port.input(Schema.Json, { contract: jsonContract })
  },
  outputs: {}
})

const definition = Workflow.make("order-workflow", {
  version: "2.1.0",
  inputs: {
    payload: Port.output(Schema.Json, { contract: jsonContract })
  },
  outputs: {},
  nodes: Registry.make(charge),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "order-plan",
  revision: 3,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    {
      id: "charge",
      type: charge.type,
      version: charge.version,
      config: {}
    }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "payload-charge",
      source: {
        _tag: "WorkflowInput" as const,
        input: "payload"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId: "charge",
        input: "payload"
      }
    }
  ]
}

interface RequestOptions {
  readonly tenantId?: string
  readonly runId?: string
  readonly workflowIdentity?: string
  readonly requestId?: string
  readonly input?: Schema.Json
  readonly definitionDeploymentId?: string
  readonly dispatchTargets?: PlanStore.DispatchTargets
}

const makePreparedStart = (options: RequestOptions = {}) =>
  Effect.gen(function*() {
    const definitionDeploymentId = options.definitionDeploymentId ?? "orders-2026-07-23"
    const dispatchTargets = options.dispatchTargets ?? {
      charge: {
        queue: "charge-queue",
        deploymentId: "charge-2026-07-23"
      }
    }
    const compiled = yield* Compiler.compile(definition, planInput)
    const plan = yield* Decision.prepare(compiled)
    const deploymentCatalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        { deploymentId: definitionDeploymentId, definition }
      ],
      handlerDefinitions: [
        {
          deploymentId: dispatchTargets.charge?.deploymentId ?? "charge-2026-07-23",
          definition: charge
        }
      ]
    })
    return yield* DurableStart.prepare(plan, {
      payload: options.input ?? { orderId: "order-1" }
    }, {
      tenantId: options.tenantId ?? "tenant-a",
      runId: options.runId ?? "run-1",
      workflowIdentity: options.workflowIdentity ?? "order/order-1",
      requestId: options.requestId ?? "request-1",
      definitionDeploymentId,
      dispatchTargets
    }).pipe(
      Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog)
    )
  })

const scheduleCommand = (
  runId: string,
  nodeId = "charge",
  commandId = Command.scheduleActivityCommandId(runId, nodeId, 1),
  input: Event.EncodedValues = { amount: 100 }
): ExecutionStore.ScheduleActivityCommand => ({
  commandVersion: 1,
  commandId,
  payload: {
    _tag: "ScheduleActivity",
    activityId: Command.activityId(runId, nodeId, 1),
    nodeId,
    nodeInstanceId: nodeId,
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey(runId, nodeId),
    input
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

const activitySucceeded = (
  activityId: string,
  eventId = Identity.activitySucceededEventId(activityId)
): HistoryStore.EventDraft<Event.ActivitySucceeded> => ({
  eventVersion: 1,
  eventId,
  payload: {
    _tag: "ActivitySucceeded",
    activityId,
    output: { receiptId: "receipt-1" }
  }
})

const dispatch = (
  command: ExecutionStore.ScheduleActivityCommand,
  target: ExecutionStore.DispatchTarget = {
    queue: `${command.payload.nodeId}-queue`,
    deploymentId: `${command.payload.nodeId}-2026-07-23`
  }
): ExecutionStore.ActivityDispatchDraft => ({
  dispatchVersion: 1,
  _tag: "Activity",
  intentId: command.commandId,
  sourceEventId: command.commandId,
  command,
  target
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

const failure = <A, E>(result: Result.Result<A, E>): E => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

const makeClock = (currentTimeMillis: Effect.Effect<number>): Clock.Clock => ({
  currentTimeMillisUnsafe: () => 0,
  currentTimeMillis,
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void
})

const withTestCrypto = Effect.provideService(Crypto.Crypto, testCrypto)

const claimRun = (
  coordinatorStore: RunCoordinator.RunCoordinatorStore["Service"],
  runKey: PlanStore.RunKey,
  requestId: string
) =>
  Effect.gen(function*() {
    const receipt = yield* coordinatorStore.claimRunnableRuns({
      requestVersion: 1,
      tenantId: runKey.tenantId,
      coordinatorId: "execution-store-test",
      requestId,
      limit: 1,
      leaseDurationMillis: 60_000
    })
    const lease = receipt.leases[0]
    return lease === undefined
      ? yield* Effect.die(`Expected '${runKey.tenantId}/${runKey.runId}' to be runnable`)
      : lease
  })

const fencedCommit = (
  lease: RunCoordinator.RunLease,
  requestId: string,
  commit: ExecutionStore.DecisionCommitDraft
): RunCoordinator.CommitDecisionRequest => ({
  requestVersion: 1,
  ref: lease.ref,
  requestId,
  commit
})

describe("ExecutionStore", () => {
  it.effect("atomically materializes RunStarted and exposes the shared read-only plan facade", () =>
    Effect.gen(function*() {
      const { executionStore, planStore } = yield* ExecutionStore.makeMemory
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      const receipt = yield* executionStore.start(prepared)
      const history = yield* executionStore.read(request.key)
      const outbox = yield* executionStore.inspectOutbox(request.key)
      const bound = yield* planStore.getForRun(request.key)
      const artifact = yield* planStore.getArtifact({
        tenantId: request.key.tenantId,
        artifactDigest: request.artifactDigest
      })

      assert.deepStrictEqual(receipt.key, request.key)
      assert.strictEqual(receipt.artifactDigest, request.artifactDigest)
      assert.strictEqual(receipt.binding, bound.binding)
      assert.strictEqual(receipt.historyReceipt.lastSequence, 0)
      assert.strictEqual(receipt.historyReceipt, receipt.historyReceipt)
      assert.deepStrictEqual(bound.artifact, request.artifact)
      assert.strictEqual(artifact, bound.artifact)
      assert.deepStrictEqual(outbox, [])
      assert.strictEqual(history.events.length, 1)
      assert.deepStrictEqual(history.events[0].payload, {
        _tag: "RunStarted",
        planId: request.artifact.fingerprintDocument.plan.id,
        planRevision: request.artifact.fingerprintDocument.plan.revision,
        definitionId: request.artifact.fingerprintDocument.plan.definition.id,
        definitionVersion: request.artifact.fingerprintDocument.plan.definition.version,
        compilerVersion: request.artifact.fingerprintDocument.compilerSemanticVersion,
        compiledFingerprint: request.artifact.compiledFingerprint,
        backend: "durable",
        input: request.input
      })
      assert.isTrue(Object.isFrozen(receipt))
      assert.isTrue(Object.isFrozen(receipt.binding))
      assert.isTrue(Object.isFrozen(receipt.historyReceipt))
      assert.isTrue(Object.isFrozen(history))
      assert.isTrue(Object.isFrozen(outbox))
      assert.isFalse("putArtifact" in planStore)
    }).pipe(withTestCrypto))

  it.effect("provides both facades from one layer", () =>
    Effect.gen(function*() {
      const executionStore = yield* ExecutionStore.ExecutionStore
      const planStore = yield* PlanStore.PlanStore
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      yield* executionStore.start(prepared)
      assert.strictEqual((yield* planStore.getForRun(request.key)).binding.key.runId, "run-1")
    }).pipe(
      Effect.provide(ExecutionStore.layerMemory),
      withTestCrypto
    ))

  it.effect("isolates histories, artifacts, request ids, and intent ids by tenant", () =>
    Effect.gen(function*() {
      const { executionStore, planStore, runCoordinatorStore } = yield* ExecutionStore.makeMemory
      const firstPrepared = yield* makePreparedStart({
        tenantId: "tenant-a",
        runId: "same-run",
        input: { tenant: "a" }
      })
      const secondPrepared = yield* makePreparedStart({
        tenantId: "tenant-b",
        runId: "same-run",
        input: { tenant: "b" }
      })
      const first = firstPrepared.wire
      const second = secondPrepared.wire
      yield* executionStore.start(firstPrepared)
      yield* executionStore.start(secondPrepared)

      const firstCommand = scheduleCommand("same-run", "charge", undefined, { tenant: "a" })
      const secondCommand = scheduleCommand("same-run", "charge", undefined, { tenant: "b" })
      const firstLease = yield* claimRun(runCoordinatorStore, first.key, "claim-first")
      const secondLease = yield* claimRun(runCoordinatorStore, second.key, "claim-second")
      yield* executionStore.commitDecision(fencedCommit(
        firstLease,
        "commit-first",
        decision(first.key, 0, scheduleEvent(firstCommand), [dispatch(firstCommand)])
      ))
      yield* executionStore.commitDecision(fencedCommit(
        secondLease,
        "commit-second",
        decision(second.key, 0, scheduleEvent(secondCommand), [dispatch(secondCommand)])
      ))

      const firstHistory = yield* executionStore.read(first.key)
      const secondHistory = yield* executionStore.read(second.key)
      const firstOutbox = yield* executionStore.inspectOutbox(first.key)
      const secondOutbox = yield* executionStore.inspectOutbox(second.key)
      assert.deepStrictEqual((firstHistory.events[0].payload as Event.RunStarted).input, first.input)
      assert.deepStrictEqual((secondHistory.events[0].payload as Event.RunStarted).input, second.input)
      assert.strictEqual(firstOutbox[0].tenantId, "tenant-a")
      assert.strictEqual(secondOutbox[0].tenantId, "tenant-b")
      assert.strictEqual(firstOutbox[0].intentId, secondOutbox[0].intentId)

      const wrongTenant = yield* Effect.result(executionStore.read(key("tenant-c", "same-run")))
      assert.strictEqual(failure(wrongTenant)._tag, "RunNotFound")
      const wrongPlan = yield* Effect.result(planStore.getForRun(key("tenant-c", "same-run")))
      assert.strictEqual(failure(wrongPlan)._tag, "RunBindingNotFound")
    }).pipe(withTestCrypto))

  it.effect("returns the original business-start receipt for a new proposed run id before Crypto and Clock", () => {
    let digestCalls = 0
    let clockReads = 0
    const countingCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) =>
        Effect.sync(() => {
          digestCalls++
          return digestBytes(data)
        })
    })
    const brokenClock = makeClock(Effect.sync(() => {
      clockReads++
      return Number.POSITIVE_INFINITY
    }))

    return Effect.gen(function*() {
      const { executionStore, planStore, runCoordinatorStore } = yield* ExecutionStore.makeMemory
      const originalPrepared = yield* makePreparedStart()
      const retryPrepared = yield* makePreparedStart({
        runId: "proposed-new-run"
      })
      const changedPrepared = yield* makePreparedStart({
        runId: "another-proposed-run",
        input: { orderId: "changed" }
      })
      const originalRequest = originalPrepared.wire
      const original = yield* executionStore.start(originalPrepared)
      const command = scheduleCommand(original.key.runId)
      const lease = yield* claimRun(runCoordinatorStore, original.key, "claim-original")
      yield* executionStore.commitDecision(fencedCommit(
        lease,
        "commit-original",
        decision(original.key, 0, scheduleEvent(command), [dispatch(command)])
      ))
      digestCalls = 0

      const retried = yield* executionStore.start(retryPrepared).pipe(
        Effect.provideService(Clock.Clock, brokenClock)
      )

      assert.strictEqual(retried, original)
      assert.strictEqual(retried.key.runId, "run-1")
      assert.strictEqual(retried.historyReceipt.lastSequence, 0)
      assert.strictEqual(digestCalls, 0)
      assert.strictEqual(clockReads, 0)
      assert.strictEqual((yield* executionStore.read(original.key)).lastSequence, 1)
      assert.strictEqual(
        failure(yield* Effect.result(planStore.getForRun(key("tenant-a", "proposed-new-run"))))._tag,
        "RunBindingNotFound"
      )

      const changed = yield* Effect.result(
        executionStore.start(changedPrepared).pipe(
          Effect.provideService(Clock.Clock, brokenClock)
        )
      )
      assert.strictEqual(failure(changed)._tag, "StartRequestConflict")
      assert.strictEqual(digestCalls, 0)
      assert.strictEqual(clockReads, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, countingCrypto))
  })

  it.effect("rejects a new business identity for an already bound run key", () =>
    Effect.gen(function*() {
      const { executionStore } = yield* ExecutionStore.makeMemory
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      yield* executionStore.start(prepared)
      const conflictPrepared = yield* makePreparedStart({
        workflowIdentity: "order/order-2",
        requestId: "request-2"
      })
      const conflict = yield* Effect.result(executionStore.start(conflictPrepared))
      const error = failure(conflict)
      assert.strictEqual(error._tag, "RunKeyConflict")
      if (error._tag === "RunKeyConflict") {
        assert.strictEqual(error.tenantId, request.key.tenantId)
        assert.strictEqual(error.runId, request.key.runId)
      }
    }).pipe(withTestCrypto))

  it.effect("recomputes prepared wire digests and rejects forged wrappers before mutation", () =>
    Effect.gen(function*() {
      const { executionStore, planStore } = yield* ExecutionStore.makeMemory
      const validPrepared = yield* makePreparedStart()
      const request = validPrepared.wire
      const wrongFingerprintPrepared = yield* makePreparedStart().pipe(
        Effect.provideService(Crypto.Crypto, constantCrypto)
      )
      const wrongFingerprint = yield* Effect.result(
        executionStore.start(wrongFingerprintPrepared)
      )
      assert.strictEqual(failure(wrongFingerprint)._tag, "CompiledFingerprintMismatch")

      const wrongDigestPrepared = yield* makePreparedStart().pipe(
        Effect.provideService(Crypto.Crypto, artifactDigestCrypto)
      )
      const wrongDigest = yield* Effect.result(
        executionStore.start(wrongDigestPrepared)
      )
      assert.strictEqual(failure(wrongDigest)._tag, "ArtifactDigestMismatch")

      const cloned = { ...validPrepared }
      const forged = {
        ...validPrepared,
        wire: {
          ...request,
          artifact: {
            ...request.artifact,
            dispatchTargets: {
              unknown: {
                queue: "wrong",
                deploymentId: "wrong"
              }
            }
          }
        }
      }
      assert.isFalse(DurableStart.isPrepared(cloned))
      assert.isFalse(DurableStart.isPrepared(forged))
      assert.strictEqual(
        failure(
          yield* Effect.result(
            executionStore.start(cloned as unknown as DurableStart.PreparedStart)
          )
        )._tag,
        "InvalidDurableStart"
      )
      assert.strictEqual(
        failure(
          yield* Effect.result(
            executionStore.start(forged as unknown as DurableStart.PreparedStart)
          )
        )._tag,
        "InvalidDurableStart"
      )
      assert.strictEqual(
        failure(yield* Effect.result(planStore.getForRun(request.key)))._tag,
        "RunBindingNotFound"
      )
      assert.strictEqual(
        failure(yield* Effect.result(executionStore.read(request.key)))._tag,
        "RunNotFound"
      )
    }).pipe(withTestCrypto))

  it.effect("detects same-tenant digest collisions while keeping artifact namespaces tenant-local", () =>
    Effect.gen(function*() {
      const { executionStore } = yield* ExecutionStore.makeMemory
      const firstPrepared = yield* makePreparedStart({
        runId: "run-a",
        workflowIdentity: "workflow-a",
        requestId: "request-a",
        definitionDeploymentId: "definition-a"
      })
      const collisionPrepared = yield* makePreparedStart({
        runId: "run-b",
        workflowIdentity: "workflow-b",
        requestId: "request-b",
        definitionDeploymentId: "definition-b"
      })
      const otherTenantPrepared = yield* makePreparedStart({
        tenantId: "tenant-b",
        runId: "run-b",
        workflowIdentity: "workflow-b",
        requestId: "request-b",
        definitionDeploymentId: "definition-b"
      })
      const otherTenant = otherTenantPrepared.wire

      yield* executionStore.start(firstPrepared)
      assert.strictEqual(
        failure(yield* Effect.result(executionStore.start(collisionPrepared)))._tag,
        "ArtifactDigestCollision"
      )
      yield* executionStore.start(otherTenantPrepared)
      assert.strictEqual((yield* executionStore.read(otherTenant.key)).lastSequence, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, constantCrypto)))

  it.effect("linearizes concurrent starts for one business request", () =>
    Effect.gen(function*() {
      const { executionStore } = yield* ExecutionStore.makeMemory
      const firstPrepared = yield* makePreparedStart({ runId: "candidate-a" })
      const secondPrepared = yield* makePreparedStart({ runId: "candidate-b" })
      const first = firstPrepared.wire
      const second = secondPrepared.wire
      const receipts = yield* Effect.all([
        executionStore.start(firstPrepared),
        executionStore.start(secondPrepared)
      ], { concurrency: "unbounded" })

      assert.strictEqual(receipts[0], receipts[1])
      assert.isTrue(
        receipts[0].key.runId === "candidate-a" ||
          receipts[0].key.runId === "candidate-b"
      )
      const missingKey = receipts[0].key.runId === "candidate-a" ? second.key : first.key
      assert.strictEqual(
        failure(yield* Effect.result(executionStore.read(missingKey)))._tag,
        "RunNotFound"
      )
    }).pipe(withTestCrypto))

  it.effect("rejects changed and unknown dispatch routes without a partial history or outbox write", () =>
    Effect.gen(function*() {
      const { executionStore, runCoordinatorStore } = yield* ExecutionStore.makeMemory
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      yield* executionStore.start(prepared)
      const command = scheduleCommand(request.key.runId)
      const lease = yield* claimRun(runCoordinatorStore, request.key, "claim-route")
      const changedRoute = yield* Effect.result(executionStore.commitDecision(
        fencedCommit(
          lease,
          "changed-route",
          decision(request.key, 0, scheduleEvent(command), [
            dispatch(command, {
              queue: "priority",
              deploymentId: "charge-2026-07-23"
            })
          ])
        )
      ))
      const changedError = failure(changedRoute)
      assert.strictEqual(changedError._tag, "DispatchTargetConflict")
      if (changedError._tag === "DispatchTargetConflict") {
        assert.deepStrictEqual(changedError.expected, request.artifact.dispatchTargets.charge)
      }

      const unknown = scheduleCommand(request.key.runId, "unknown")
      const unknownRoute = yield* Effect.result(executionStore.commitDecision(
        fencedCommit(
          lease,
          "unknown-route",
          decision(request.key, 0, scheduleEvent(unknown), [dispatch(unknown)])
        )
      ))
      const unknownError = failure(unknownRoute)
      assert.strictEqual(unknownError._tag, "DispatchTargetConflict")
      if (unknownError._tag === "DispatchTargetConflict") {
        assert.isFalse(Object.prototype.hasOwnProperty.call(unknownError, "expected"))
      }
      assert.strictEqual((yield* executionStore.read(request.key)).lastSequence, 0)
      assert.deepStrictEqual(yield* executionStore.inspectOutbox(request.key), [])
    }).pipe(withTestCrypto))

  it.effect("rejects structurally valid decisions that would create illegal semantic history", () =>
    Effect.gen(function*() {
      const { executionStore, runCoordinatorStore } = yield* ExecutionStore.makeMemory
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      yield* executionStore.start(prepared)
      const lease = yield* claimRun(runCoordinatorStore, request.key, "claim-invalid-history")

      const result = yield* Effect.result(executionStore.commitDecision(
        fencedCommit(
          lease,
          "invalid-history",
          decision(request.key, 0, activitySucceeded("missing-activity"))
        )
      ))
      assert.strictEqual(failure(result)._tag, "InvalidDecisionCommit")
      assert.strictEqual((yield* executionStore.read(request.key)).lastSequence, 0)
      assert.deepStrictEqual(yield* executionStore.inspectOutbox(request.key), [])
    }).pipe(withTestCrypto))

  it.effect("atomically commits pinned dispatches and returns exact retries after head advancement", () =>
    Effect.gen(function*() {
      const { executionStore, runCoordinatorStore } = yield* ExecutionStore.makeMemory
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      yield* executionStore.start(prepared)
      const command = scheduleCommand(request.key.runId)
      const wire = decision(request.key, 0, scheduleEvent(command), [dispatch(command)])
      const lease = yield* claimRun(runCoordinatorStore, request.key, "claim-exact")
      const fenced = fencedCommit(lease, "commit-exact", wire)
      const original = yield* executionStore.commitDecision(fenced)

      const retried = yield* executionStore.commitDecision(fenced).pipe(
        Effect.provideService(
          Clock.Clock,
          makeClock(Effect.succeed(Number.POSITIVE_INFINITY))
        )
      )
      const outbox = yield* executionStore.inspectOutbox(request.key)
      assert.strictEqual(retried, original)
      assert.strictEqual((yield* executionStore.read(request.key)).lastSequence, 1)
      assert.strictEqual(outbox.length, 1)
      assert.strictEqual(outbox[0].tenantId, request.key.tenantId)
      assert.strictEqual(outbox[0].target.queue, "charge-queue")
      assert.isTrue(Object.isFrozen(outbox[0]))
      assert.isTrue(Object.isFrozen(outbox[0].command))
      assert.isTrue(Object.isFrozen(outbox[0].target))
    }).pipe(withTestCrypto))

  it.effect("snapshots hostile starts, commits, and keys without invoking accessors", () =>
    Effect.gen(function*() {
      const { executionStore, planStore, runCoordinatorStore } = yield* ExecutionStore.makeMemory
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      yield* executionStore.start(prepared)
      let reads = 0
      const hostile = Object.defineProperty({}, "key", {
        enumerable: true,
        get: () => {
          reads++
          return request.key
        }
      })

      assert.strictEqual(
        failure(
          yield* Effect.result(
            executionStore.start(hostile as DurableStart.PreparedStart)
          )
        )._tag,
        "InvalidDurableStart"
      )
      assert.strictEqual(
        failure(
          yield* Effect.result(
            executionStore.commitDecision(hostile as RunCoordinator.CommitDecisionRequest)
          )
        )._tag,
        "InvalidCoordinatorRequest"
      )
      assert.strictEqual(
        failure(
          yield* Effect.result(
            executionStore.read(hostile as PlanStore.RunKey)
          )
        )._tag,
        "ExecutionStoreFailure"
      )
      assert.strictEqual(
        failure(
          yield* Effect.result(
            planStore.getForRun(hostile as PlanStore.RunKey)
          )
        )._tag,
        "PlanStoreFailure"
      )
      assert.strictEqual(reads, 0)

      const sparseEvents = new Array<HistoryStore.EventDraft>(2)
      sparseEvents[0] = activitySucceeded("activity-1")
      const lease = yield* claimRun(runCoordinatorStore, request.key, "claim-sparse")
      const sparseCommit = {
        commitVersion: 1,
        key: request.key,
        expectedLastSequence: 0,
        events: sparseEvents as [
          HistoryStore.EventDraft,
          ...Array<HistoryStore.EventDraft>
        ],
        dispatches: []
      } as ExecutionStore.DecisionCommitDraft
      const sparse = yield* Effect.result(executionStore.commitDecision(
        fencedCommit(lease, "commit-sparse", sparseCommit)
      ))
      assert.strictEqual(failure(sparse)._tag, "InvalidCoordinatorRequest")
      assert.strictEqual((yield* executionStore.read(request.key)).lastSequence, 0)
    }).pipe(withTestCrypto))

  it.effect("maps Crypto and Clock failures atomically while preserving pure interruption", () =>
    Effect.gen(function*() {
      const prepared = yield* makePreparedStart()
      const request = prepared.wire
      const defectCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.die("crypto-defect")
      })
      const defectStores = yield* ExecutionStore.makeMemory.pipe(
        Effect.provideService(Crypto.Crypto, defectCrypto)
      )
      const cryptoFailure = yield* Effect.result(defectStores.executionStore.start(prepared))
      assert.strictEqual(failure(cryptoFailure)._tag, "ExecutionStoreFailure")
      assert.strictEqual(
        failure(yield* Effect.result(defectStores.executionStore.read(request.key)))._tag,
        "RunNotFound"
      )

      const interruptCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.interrupt
      })
      const interruptStores = yield* ExecutionStore.makeMemory.pipe(
        Effect.provideService(Crypto.Crypto, interruptCrypto)
      )
      const interruptedCrypto = yield* Effect.exit(interruptStores.executionStore.start(prepared))
      assert.isTrue(Exit.isFailure(interruptedCrypto))
      if (Exit.isFailure(interruptedCrypto)) {
        assert.isTrue(Cause.hasInterruptsOnly(interruptedCrypto.cause))
      }

      const clockStores = yield* ExecutionStore.makeMemory
      const clockFailure = yield* Effect.result(clockStores.executionStore.start(prepared)).pipe(
        Effect.provideService(
          Clock.Clock,
          makeClock(Effect.succeed(8_640_000_000_000_000))
        )
      )
      assert.strictEqual(failure(clockFailure)._tag, "ExecutionStoreFailure")
      assert.strictEqual(
        failure(yield* Effect.result(clockStores.executionStore.read(request.key)))._tag,
        "RunNotFound"
      )

      const interruptedClock = yield* Effect.exit(clockStores.executionStore.start(prepared)).pipe(
        Effect.provideService(Clock.Clock, makeClock(Effect.interrupt))
      )
      assert.isTrue(Exit.isFailure(interruptedClock))
      if (Exit.isFailure(interruptedClock)) {
        assert.isTrue(Cause.hasInterruptsOnly(interruptedClock.cause))
      }
    }).pipe(withTestCrypto))
})
