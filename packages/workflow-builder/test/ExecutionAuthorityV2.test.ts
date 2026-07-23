import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as ActivityCompletionV2 from "../src/ActivityCompletionV2.ts"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as Compiler from "../src/Compiler.ts"
import * as DecisionV2 from "../src/DecisionV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DigestV2 from "../src/DigestV2.ts"
import * as DurableStartV2 from "../src/DurableStartV2.ts"
import * as ExecutionAuthorityV2 from "../src/ExecutionAuthorityV2.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStoreV2 from "../src/PlanStoreV2.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const epoch = Date.parse("2026-07-23T12:00:00.000Z")

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (
          output[index % output.length]! +
          data[index]! +
          index
        ) & 0xff
      }
      return output
    })
})

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const jsonContract = "execution-authority-v2/json"
const consume = Node.make("ExecutionAuthorityConsumeV2", {
  version: "1.0.0",
  inputs: {
    document: Port.input(Schema.Json, { contract: jsonContract })
  },
  outputs: {},
  failure: Schema.Json
})

const definition = Workflow.make("execution-authority-v2-workflow", {
  version: "1.0.0",
  inputs: {
    document: Port.output(Schema.Json, { contract: jsonContract })
  },
  outputs: {},
  nodes: Registry.make(consume),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const graphPlan = {
  formatVersion: 1,
  id: "execution-authority-v2-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "worker",
    type: consume.type,
    version: consume.version,
    config: {}
  }],
  edges: [{
    _tag: "DataEdge" as const,
    id: "document-worker",
    source: {
      _tag: "WorkflowInput" as const,
      input: "document"
    },
    target: {
      _tag: "NodeInput" as const,
      nodeId: "worker",
      input: "document"
    }
  }]
}

const policy: ActivityPolicy.Policy = {
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: 3,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: true,
      scheduleToStartTimeout: true,
      startToCloseTimeout: true
    },
    backoff: { _tag: "Fixed", delayMillis: 1_000 },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: { _tag: "After", durationMillis: 10_000 },
    startToClose: { _tag: "After", durationMillis: 20_000 },
    scheduleToClose: { _tag: "After", durationMillis: 30_000 }
  }
}

const inboxPolicy: PlanStoreV2.PlanArtifact["signalManifest"]["inboxPolicy"] = {
  policyVersion: 1,
  maxAcceptedCount: 100,
  maxPendingCount: 100,
  maxPendingEncodedBytes: 65_536,
  maxItemEncodedBytes: 4_096,
  maxSignalIdBytes: 64,
  maxCorrelationKeyBytes: 64,
  maxPendingWaits: 100,
  maxTtlMillis: 60_000,
  deduplicationScope: "RunLifetime",
  receiptRetentionAfterTerminalMillis: 60_000,
  overflow: { _tag: "Reject" }
}

const makeArtifact = Effect.fnUntraced(function*(
  compiled: Compiler.CompiledPlan<typeof definition>
) {
  const fingerprintDocument = Fingerprint.materialize(compiled)
  const compiledFingerprint = yield* DigestV2.compiledPlan(
    fingerprintDocument as unknown as Schema.Json
  )
  return {
    artifactVersion: 2,
    executionProtocolVersion: 2,
    fingerprintDocument,
    compiledFingerprint,
    definitionDeploymentId: "workflow-build-1",
    dispatchTargets: {
      worker: {
        queue: "documents",
        deploymentId: "consume-build-1"
      }
    },
    activityPolicies: { worker: policy },
    signalManifest: {
      catalogVersion: 1,
      definitions: [],
      inboxPolicy
    }
  } satisfies PlanStoreV2.PlanArtifact
})

const deploymentCatalog = (): Deployment.DeploymentCatalog.Service => {
  const result = Deployment.fromEntries({
    workflowDefinitions: [
      Deployment.workflowDefinition("workflow-build-1", definition)
    ],
    handlerDefinitions: [
      Deployment.handlerDefinition("consume-build-1", consume)
    ]
  })
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const startOptions = (
  overrides: Partial<DurableStartV2.Options> = {}
): DurableStartV2.Options => ({
  tenantId: "tenant-1",
  runId: "run-1",
  workflowIdentity: "document:run-1",
  requestId: "start-request-1",
  ...overrides
})

const prepareStart = (
  plan: DecisionV2.DecidablePlan<typeof definition>,
  options = startOptions()
) =>
  DurableStartV2.prepare(
    plan,
    { document: { accepted: true } },
    options
  ).pipe(
    Effect.provideService(
      Deployment.DeploymentCatalog,
      deploymentCatalog()
    )
  )

const preparedFixture = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, graphPlan)
  const artifact = yield* makeArtifact(compiled)
  const plan = yield* DecisionV2.prepare(compiled, artifact)
  const prepared = yield* prepareStart(plan)
  return { compiled, artifact, plan, prepared }
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const authorityFixture = Effect.gen(function*() {
  yield* TestClock.setTime(epoch)
  const prepared = yield* preparedFixture
  const authority = yield* ExecutionAuthorityV2.makeMemory()
  const start = yield* authority.start(prepared.plan, prepared.prepared)
  return { ...prepared, authority, start }
})

const failure = <A>(
  result: Result.Result<A, ExecutionAuthorityV2.ExecutionAuthorityError>
): ExecutionAuthorityV2.ExecutionAuthorityError => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

const scheduledAttempt = (
  snapshot: ExecutionAuthorityV2.MemoryRunSnapshot
): ExecutionAuthorityV2.DispatchOutboxItem => {
  assert.strictEqual(snapshot.dispatchOutbox.length, 1)
  return snapshot.dispatchOutbox[0]!
}

const prepareCompletion = (
  plan: DecisionV2.DecidablePlan<typeof definition>,
  snapshot: ExecutionAuthorityV2.MemoryRunSnapshot,
  dispatch: ExecutionAuthorityV2.DispatchOutboxItem,
  completion: unknown
) =>
  ActivityCompletionV2.prepare(
    plan,
    snapshot.replay,
    {
      key: snapshot.boundPlan.binding.key,
      logicalActivityId: dispatch.logicalActivityId,
      attemptId: dispatch.attemptId,
      attempt: dispatch.attempt,
      completion
    }
  )

describe("ExecutionAuthorityV2", () => {
  it("exposes strict capability schemas and closed error codes", () => {
    const decodeDecision = Schema.decodeUnknownSync(
      ExecutionAuthorityV2.DecisionCommitRequest
    )
    assert.deepStrictEqual(
      decodeDecision({
        key: { tenantId: "tenant-1", runId: "run-1" },
        operationId: "decision-1",
        expectedSequence: 0
      }),
      {
        key: { tenantId: "tenant-1", runId: "run-1" },
        operationId: "decision-1",
        expectedSequence: 0
      }
    )
    assert.throws(() =>
      decodeDecision({
        key: { tenantId: "tenant-1", runId: "run-1" },
        operationId: "decision-1",
        expectedSequence: 0,
        eventId: "caller-owned"
      })
    )
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(
        ExecutionAuthorityV2.CompleteActivityAttemptOperation
      )({ operationId: "worker-complete-1" }),
      { operationId: "worker-complete-1" }
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(
        ExecutionAuthorityV2.ExecutionAuthorityError
      )({
        _tag: "ExecutionAuthorityError",
        operation: "append",
        code: ExecutionAuthorityV2.Codes.InvalidRequest,
        message: "not a capability"
      })
    )
  })

  it.effect("atomically executes start, dispatch, worker facts, and terminal decision", () =>
    Effect.gen(function*() {
      const { authority, plan, start } = yield* authorityFixture
      assert.strictEqual(start.sequence, 0)
      assert.strictEqual(start.event.payload._tag, "RunStarted")
      assert.strictEqual(start.event.recordedAt, "2026-07-23T12:00:00.000Z")

      const afterStart = yield* authority.inspect(start.key)
      assert.isDefined(afterStart)
      assert.strictEqual(afterStart.replay.status, "Running")
      assert.strictEqual(afterStart.wake?.reason, "RunStarted")
      assert.strictEqual(afterStart.history.length, 1)

      const scheduled = yield* authority.decide({
        key: start.key,
        operationId: "decision-schedule",
        expectedSequence: 0
      })
      assert.deepStrictEqual(
        scheduled.events.map((event) => event.payload._tag),
        ["ActivityScheduled", "TimerScheduled", "TimerScheduled"]
      )
      const afterSchedule = (yield* authority.inspect(start.key))!
      const dispatch = scheduledAttempt(afterSchedule)
      assert.strictEqual(dispatch.target.queue, "documents")
      assert.strictEqual(afterSchedule.indexedTimers.length, 2)
      assert.isUndefined(afterSchedule.wake)

      const started = yield* authority.recordActivityStarted({
        operationId: "worker-start-1",
        key: start.key,
        logicalActivityId: dispatch.logicalActivityId,
        attemptId: dispatch.attemptId,
        attempt: dispatch.attempt
      })
      assert.deepStrictEqual(
        started.events.map((event) => event.payload._tag),
        ["ActivityAttemptStarted", "TimerCancelled", "TimerScheduled"]
      )
      const afterWorkerStart = (yield* authority.inspect(start.key))!
      assert.strictEqual(afterWorkerStart.dispatchOutbox.length, 0)
      assert.strictEqual(afterWorkerStart.indexedTimers.length, 2)
      assert.isUndefined(afterWorkerStart.wake)

      const preparedCompletion = yield* prepareCompletion(
        plan,
        afterWorkerStart,
        dispatch,
        { _tag: "Succeeded", output: {} }
      )
      const completed = yield* authority.completeActivityAttempt(
        "worker-complete-1",
        preparedCompletion
      )
      assert.strictEqual(
        yield* authority.completeActivityAttempt(
          "worker-complete-1",
          preparedCompletion
        ),
        completed
      )
      assert.deepStrictEqual(
        completed.events.map((event) => event.payload._tag),
        ["ActivitySucceeded", "TimerCancelled", "TimerCancelled"]
      )
      const afterCompletion = (yield* authority.inspect(start.key))!
      assert.strictEqual(afterCompletion.indexedTimers.length, 0)
      assert.strictEqual(afterCompletion.wake?.reason, "ActivityCompleted")

      const terminal = yield* authority.decide({
        key: start.key,
        operationId: "decision-terminal",
        expectedSequence: completed.sequence
      })
      assert.deepStrictEqual(
        terminal.events.map((event) => event.payload._tag),
        ["RunSucceeded"]
      )
      const finished = (yield* authority.inspect(start.key))!
      assert.strictEqual(finished.replay.status, "Succeeded")
      assert.isUndefined(finished.wake)
      assert.strictEqual(finished.indexedTimers.length, 0)
      assert.strictEqual(finished.dispatchOutbox.length, 0)

      const bound = yield* authority.planStore.getForRun(start.key)
      assert.strictEqual(
        bound.binding.artifactDigest,
        start.binding.artifactDigest
      )
      const artifact = yield* authority.planStore.getArtifact({
        tenantId: start.key.tenantId,
        artifactDigest: start.binding.artifactDigest
      })
      assert.strictEqual(
        artifact.compiledFingerprint,
        bound.artifact.compiledFingerprint
      )

      const all = yield* authority.snapshot
      assert.strictEqual(all.runs.length, 1)
      assert.strictEqual(all.indexedTimers.length, 0)
      assert.strictEqual(all.dispatchOutbox.length, 0)
      assert.strictEqual(all.wakeQueue.length, 0)
      assert.isTrue(Object.isFrozen(all))
      assert.isTrue(Object.isFrozen(all.runs))
      assert.isTrue(Object.isFrozen(finished.history))
      assert.isTrue(Object.isFrozen(finished.history[0]))
      assert.isTrue(Object.isFrozen(finished.history[0]!.payload))
    }))

  it.effect("indexes retry timers, rejects early firing, and schedules the next attempt", () =>
    Effect.gen(function*() {
      const { authority, plan, start } = yield* authorityFixture
      const scheduled = yield* authority.decide({
        key: start.key,
        operationId: "decision-schedule",
        expectedSequence: 0
      })
      const dispatch = scheduledAttempt(
        (yield* authority.inspect(start.key))!
      )
      yield* authority.recordActivityStarted({
        operationId: "worker-start-1",
        key: start.key,
        logicalActivityId: dispatch.logicalActivityId,
        attemptId: dispatch.attemptId,
        attempt: 1
      })
      const preparedFailure = yield* prepareCompletion(
        plan,
        (yield* authority.inspect(start.key))!,
        dispatch,
        {
          _tag: "Failed",
          failure: { _tag: "Transient" }
        }
      )
      const failed = yield* authority.completeActivityAttempt(
        "worker-fail-1",
        preparedFailure
      )
      const retry = yield* authority.decide({
        key: start.key,
        operationId: "decision-retry",
        expectedSequence: failed.sequence
      })
      assert.deepStrictEqual(
        retry.events.map((event) => event.payload._tag),
        ["RetryScheduled", "TimerScheduled"]
      )
      const waiting = (yield* authority.inspect(start.key))!
      const retryTimer = waiting.indexedTimers.find(
        (timer) =>
          HashMap.get(waiting.replay.timers, timer.timerId).pipe(
            Option.exists((state) => state.purpose._tag === "RetryBackoff")
          )
      )
      assert.isDefined(retryTimer)

      const beforeEarly = yield* authority.snapshot
      const early = yield* authority.fireTimer({
        operationId: "fire-retry-early",
        key: start.key,
        timerId: retryTimer.timerId
      }).pipe(Effect.result)
      assert.strictEqual(
        failure(early).code,
        ExecutionAuthorityV2.Codes.ExternalFactRejected
      )
      const afterEarly = yield* authority.snapshot
      assert.strictEqual(
        afterEarly.runs[0]!.history.length,
        beforeEarly.runs[0]!.history.length
      )
      assert.deepStrictEqual(
        afterEarly.runs[0]!.indexedTimers,
        beforeEarly.runs[0]!.indexedTimers
      )

      yield* TestClock.setTime(epoch + 1_000)
      const fired = yield* authority.fireTimer({
        operationId: "fire-retry-due",
        key: start.key,
        timerId: retryTimer.timerId
      })
      assert.deepStrictEqual(
        fired.events.map((event) => event.payload._tag),
        ["TimerFired"]
      )
      const next = yield* authority.decide({
        key: start.key,
        operationId: "decision-attempt-2",
        expectedSequence: fired.sequence
      })
      assert.deepStrictEqual(
        next.events.map((event) => event.payload._tag),
        ["ActivityScheduled", "TimerScheduled"]
      )
      const second = scheduledAttempt(
        (yield* authority.inspect(start.key))!
      )
      assert.strictEqual(second.attempt, 2)
      assert.notStrictEqual(second.attemptId, dispatch.attemptId)
      assert.strictEqual(scheduled.sequence < second.historySequence, true)
    }))

  it.effect("provides stable idempotency, sequence CAS, and rollback on conflicts", () =>
    Effect.gen(function*() {
      const { authority, plan, prepared, start } = yield* authorityFixture
      const duplicateStart = yield* authority.start(plan, prepared)
      assert.strictEqual(duplicateStart, start)

      const scheduledRequest = {
        key: start.key,
        operationId: "decision-schedule",
        expectedSequence: 0
      }
      const first = yield* authority.decide(scheduledRequest)
      const duplicateDecision = yield* authority.decide(scheduledRequest)
      assert.strictEqual(duplicateDecision, first)

      const before = yield* authority.snapshot
      const conflicting = yield* authority.decide({
        ...scheduledRequest,
        expectedSequence: 1
      }).pipe(Effect.result)
      assert.strictEqual(
        failure(conflicting).code,
        ExecutionAuthorityV2.Codes.IdempotencyConflict
      )
      const stale = yield* authority.decide({
        key: start.key,
        operationId: "decision-stale",
        expectedSequence: 0
      }).pipe(Effect.result)
      assert.strictEqual(
        failure(stale).code,
        ExecutionAuthorityV2.Codes.StaleSequence
      )
      const after = yield* authority.snapshot
      assert.strictEqual(
        after.runs[0]!.history.length,
        before.runs[0]!.history.length
      )
      assert.strictEqual(
        after.runs[0]!.receipts.length,
        before.runs[0]!.receipts.length
      )

      const dispatch = scheduledAttempt(after.runs[0]!)
      const workerRequest = {
        operationId: "worker-start-1",
        key: start.key,
        logicalActivityId: dispatch.logicalActivityId,
        attemptId: dispatch.attemptId,
        attempt: 1
      }
      const worker = yield* authority.recordActivityStarted(workerRequest)
      assert.strictEqual(
        yield* authority.recordActivityStarted(workerRequest),
        worker
      )
      const workerConflict = yield* authority.recordActivityStarted({
        ...workerRequest,
        attempt: 2
      }).pipe(Effect.result)
      assert.strictEqual(
        failure(workerConflict).code,
        ExecutionAuthorityV2.Codes.IdempotencyConflict
      )
    }))

  it.effect("cancels timed live work durably while documenting worker-interrupt boundary", () =>
    Effect.gen(function*() {
      const { authority, plan, start } = yield* authorityFixture
      yield* authority.decide({
        key: start.key,
        operationId: "decision-schedule",
        expectedSequence: 0
      })
      const dispatch = scheduledAttempt(
        (yield* authority.inspect(start.key))!
      )
      const workerStarted = yield* authority.recordActivityStarted({
        operationId: "worker-start-1",
        key: start.key,
        logicalActivityId: dispatch.logicalActivityId,
        attemptId: dispatch.attemptId,
        attempt: 1
      })
      const beforeCancellation = (yield* authority.inspect(start.key))!
      assert.strictEqual(beforeCancellation.indexedTimers.length, 2)
      const preparedLateCompletion = yield* prepareCompletion(
        plan,
        beforeCancellation,
        dispatch,
        { _tag: "Succeeded", output: {} }
      )

      const requested = yield* authority.requestCancellation({
        key: start.key,
        requestId: "cancel-request-1"
      })
      assert.strictEqual(
        requested.events[0]!.payload._tag,
        "RunCancellationRequested"
      )
      assert.deepStrictEqual(
        requested.events.slice(1).map((event) => event.payload._tag),
        ["TimerCancelled", "TimerCancelled"]
      )
      const cancelling = (yield* authority.inspect(start.key))!
      assert.strictEqual(cancelling.replay.status, "CancellationRequested")
      assert.strictEqual(cancelling.indexedTimers.length, 0)
      assert.strictEqual(cancelling.dispatchOutbox.length, 0)
      assert.strictEqual(cancelling.wake?.reason, "CancellationRequested")

      const terminal = yield* authority.decide({
        key: start.key,
        operationId: "decision-cancel",
        expectedSequence: requested.sequence
      })
      assert.deepStrictEqual(
        terminal.events.map((event) => event.payload._tag),
        ["RunCancelled"]
      )
      const cancelled = (yield* authority.inspect(start.key))!
      assert.strictEqual(cancelled.replay.status, "Cancelled")
      assert.strictEqual(cancelled.indexedTimers.length, 0)
      const retained = Option.getOrThrow(HashMap.get(
        cancelled.replay.activities,
        dispatch.logicalActivityId
      ))
      assert.strictEqual(retained.status, "Active")

      const beforeLateCompletion = cancelled.history.length
      const lateCompletion = yield* authority.completeActivityAttempt(
        "worker-complete-after-cancel",
        preparedLateCompletion
      ).pipe(Effect.result)
      assert.strictEqual(
        failure(lateCompletion).code,
        ExecutionAuthorityV2.Codes.InvalidPreparedCompletion
      )
      assert.strictEqual(
        (yield* authority.inspect(start.key))!.history.length,
        beforeLateCompletion
      )
      assert.strictEqual(workerStarted.sequence < requested.sequence, true)
    }))

  it.effect("turns residual deadline overflow into one deterministic terminal fact", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("9999-12-31T23:59:59.999Z"))
      const fixture = yield* preparedFixture
      const authority = yield* ExecutionAuthorityV2.makeMemory()
      const start = yield* authority.start(fixture.plan, fixture.prepared)

      const committed = yield* authority.decide({
        key: start.key,
        operationId: "decision-deadline-overflow",
        expectedSequence: 0
      })
      assert.deepStrictEqual(
        committed.events.map((event) => event.payload._tag),
        ["RunFailed"]
      )
      const failed = committed.events[0]!.payload
      assert.strictEqual(failed._tag, "RunFailed")
      if (failed._tag !== "RunFailed") {
        throw new Error("Expected a terminal protocol failure")
      }
      assert.strictEqual(failed.cause._tag, "ProtocolFailure")
      if (failed.cause._tag !== "ProtocolFailure") {
        throw new Error("Expected deadline protocol attribution")
      }
      assert.strictEqual(failed.cause.code, "DeadlineOutOfRange")
      assert.strictEqual(failed.cause.delayMillis, 10_000)

      const snapshot = (yield* authority.inspect(start.key))!
      assert.strictEqual(snapshot.replay.status, "Failed")
      assert.strictEqual(snapshot.indexedTimers.length, 0)
      assert.strictEqual(snapshot.dispatchOutbox.length, 0)

      const duplicate = yield* authority.decide({
        key: start.key,
        operationId: "decision-deadline-overflow",
        expectedSequence: 0
      })
      assert.strictEqual(duplicate, committed)
    }))

  it.effect("rejects provenance mismatches and hostile inputs without mutation", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(epoch)
      const fixture = yield* preparedFixture
      const authority = yield* ExecutionAuthorityV2.makeMemory()

      const forgedPlan = { ...fixture.plan }
      const badPlan = yield* authority.start(
        forgedPlan as DecisionV2.DecidablePlan<typeof definition>,
        fixture.prepared
      ).pipe(Effect.result)
      assert.strictEqual(
        failure(badPlan).code,
        ExecutionAuthorityV2.Codes.InvalidPreparedPlan
      )
      const forgedStart = { ...fixture.prepared }
      const badStart = yield* authority.start(
        fixture.plan,
        forgedStart as DurableStartV2.PreparedStart
      ).pipe(Effect.result)
      assert.strictEqual(
        failure(badStart).code,
        ExecutionAuthorityV2.Codes.InvalidPreparedStart
      )

      const secondArtifact = yield* makeArtifact(fixture.compiled)
      const secondPlan = yield* DecisionV2.prepare(
        fixture.compiled,
        secondArtifact
      )
      const secondStart = yield* prepareStart(secondPlan)
      const crossed = yield* authority.start(
        fixture.plan,
        secondStart
      ).pipe(Effect.result)
      assert.strictEqual(
        failure(crossed).code,
        ExecutionAuthorityV2.Codes.ArtifactIdentityMismatch
      )
      assert.strictEqual((yield* authority.snapshot).runs.length, 0)

      const start = yield* authority.start(
        fixture.plan,
        fixture.prepared
      )
      let getterReads = 0
      const hostile = {
        key: start.key,
        operationId: "hostile-decision",
        get expectedSequence() {
          getterReads++
          return 0
        }
      }
      const before = yield* authority.snapshot
      const rejected = yield* authority.decide(hostile).pipe(Effect.result)
      assert.strictEqual(
        failure(rejected).code,
        ExecutionAuthorityV2.Codes.InvalidRequest
      )
      assert.strictEqual(getterReads, 0)
      const after = yield* authority.snapshot
      assert.strictEqual(after.runs[0]!.history.length, 1)
      assert.strictEqual(
        after.runs[0]!.receipts.length,
        before.runs[0]!.receipts.length
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
