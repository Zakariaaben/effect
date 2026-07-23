/**
 * Process-local atomic execution authority for protocol version `2`.
 *
 * **Details**
 *
 * This module is an executable transaction specification, not a durable
 * persistence claim. One Effect `Ref` owns admitted plans, histories, derived
 * heads, idempotency receipts, timer indexes, activity dispatches, and
 * coalesced decision wakes. A persistent adapter must preserve the same
 * transaction boundaries across process and machine failure.
 *
 * Signal admission remains the responsibility of `SignalAuthorityV2` until a
 * persistent adapter can coordinate both capabilities in one transaction.
 * Cancellation fences future authority operations and clears dispatches, but
 * this process-local implementation cannot interrupt activity code that is
 * already executing on a worker.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityCompletionV2 from "./ActivityCompletionV2.ts"
import * as CommandEventV2 from "./CommandEventV2.ts"
import * as CommandV2 from "./CommandV2.ts"
import * as DecisionV2 from "./DecisionV2.ts"
import * as DurableStartV2 from "./DurableStartV2.ts"
import * as EventV2 from "./EventV2.ts"
import * as ExternalEventV2 from "./ExternalEventV2.ts"
import * as IdentityV2 from "./IdentityV2.ts"
import * as CommandEventStorageV2 from "./internal/commandEventV2.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV1 from "./PlanStore.ts"
import * as PlanStoreV2 from "./PlanStoreV2.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as RunStateV2 from "./RunStateV2.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Privileged mutations supported by the process-local authority.
 *
 * @category models
 * @since 4.0.0
 */
export const Operation = Schema.Literals([
  "start",
  "decide",
  "recordActivityStarted",
  "completeActivityAttempt",
  "fireTimer",
  "requestCancellation"
])

/**
 * The decoded type of {@link Operation}.
 *
 * @category models
 * @since 4.0.0
 */
export type Operation = Schema.Schema.Type<typeof Operation>

const CommitOperation = Schema.Literals([
  "decide",
  "recordActivityStarted",
  "completeActivityAttempt",
  "fireTimer",
  "requestCancellation"
])

/**
 * A mutation other than initial run admission.
 *
 * @category models
 * @since 4.0.0
 */
export type CommitOperation = Schema.Schema.Type<typeof CommitOperation>

/**
 * A strict compare-and-set request for one pure decision transaction.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DecisionCommitRequest = Schema.Struct({
  key: PlanStoreV2.RunKey,
  operationId: Schema.NonEmptyString,
  expectedSequence: NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowExecutionAuthorityV2DecisionCommitRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DecisionCommitRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type DecisionCommitRequest = Schema.Schema.Type<
  typeof DecisionCommitRequest
>

/**
 * A strict privileged worker-start request with an authority idempotency key.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RecordActivityStartedRequest = Schema.Struct({
  operationId: Schema.NonEmptyString,
  key: PlanStoreV2.RunKey,
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt
}).annotate({
  identifier: "WorkflowExecutionAuthorityV2RecordActivityStartedRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RecordActivityStartedRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RecordActivityStartedRequest = Schema.Schema.Type<
  typeof RecordActivityStartedRequest
>

/**
 * The authority-owned idempotency key for one prepared worker completion.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompleteActivityAttemptOperation = Schema.Struct({
  operationId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowExecutionAuthorityV2CompleteActivityAttemptOperation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompleteActivityAttemptOperation}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompleteActivityAttemptOperation = Schema.Schema.Type<
  typeof CompleteActivityAttemptOperation
>

/**
 * A strict request to fire one timer selected from the authority-owned index.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FireTimerRequest = Schema.Struct({
  operationId: Schema.NonEmptyString,
  key: PlanStoreV2.RunKey,
  timerId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowExecutionAuthorityV2FireTimerRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FireTimerRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type FireTimerRequest = Schema.Schema.Type<typeof FireTimerRequest>

/**
 * A strict cancellation request. Its request identifier is also the
 * authority-wide operation identity for the run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequestCancellationRequest = ExternalEventV2.RequestCancellationRequest

/**
 * The decoded type of {@link RequestCancellationRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequestCancellationRequest = ExternalEventV2.RequestCancellationRequest

/**
 * Stable machine-readable authority failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidPreparedPlan: "InvalidPreparedPlan",
  InvalidPreparedStart: "InvalidPreparedStart",
  InvalidPreparedCompletion: "InvalidPreparedCompletion",
  InvalidRequest: "InvalidRequest",
  PlanIdentityMismatch: "PlanIdentityMismatch",
  ArtifactIdentityMismatch: "ArtifactIdentityMismatch",
  CompilerIdentityMismatch: "CompilerIdentityMismatch",
  RunAlreadyExists: "RunAlreadyExists",
  RunNotFound: "RunNotFound",
  IdempotencyConflict: "IdempotencyConflict",
  StaleSequence: "StaleSequence",
  ClockUnavailable: "ClockUnavailable",
  StartRejected: "StartRejected",
  DecisionRejected: "DecisionRejected",
  CommandRejected: "CommandRejected",
  ExternalFactRejected: "ExternalFactRejected",
  TimerNotIndexed: "TimerNotIndexed",
  DispatchNotFound: "DispatchNotFound",
  CounterOverflow: "CounterOverflow",
  StoreInvariantViolation: "StoreInvariantViolation"
} as const

/**
 * A stable machine-readable authority failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutionAuthorityErrorCode = typeof Codes[keyof typeof Codes]

const ExecutionAuthorityErrorCode = Schema.Literals([
  Codes.InvalidPreparedPlan,
  Codes.InvalidPreparedStart,
  Codes.InvalidPreparedCompletion,
  Codes.InvalidRequest,
  Codes.PlanIdentityMismatch,
  Codes.ArtifactIdentityMismatch,
  Codes.CompilerIdentityMismatch,
  Codes.RunAlreadyExists,
  Codes.RunNotFound,
  Codes.IdempotencyConflict,
  Codes.StaleSequence,
  Codes.ClockUnavailable,
  Codes.StartRejected,
  Codes.DecisionRejected,
  Codes.CommandRejected,
  Codes.ExternalFactRejected,
  Codes.TimerNotIndexed,
  Codes.DispatchNotFound,
  Codes.CounterOverflow,
  Codes.StoreInvariantViolation
])

/**
 * Raised when an atomic process-local authority operation cannot be admitted.
 *
 * @category errors
 * @since 4.0.0
 */
export class ExecutionAuthorityError extends Schema.TaggedErrorClass<ExecutionAuthorityError>(
  "@effect/workflow-builder/ExecutionAuthorityV2/ExecutionAuthorityError"
)("ExecutionAuthorityError", {
  operation: Operation,
  code: ExecutionAuthorityErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * The immutable receipt for atomic start admission.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StartReceipt = Schema.Struct({
  operation: Schema.Literal("start"),
  operationId: Schema.NonEmptyString,
  key: PlanStoreV2.RunKey,
  sequence: Schema.Literal(0),
  recordedAt: EventV2.Timestamp,
  binding: PlanStoreV2.RunBinding,
  event: EventV2.Event
}).annotate({
  identifier: "WorkflowExecutionAuthorityV2StartReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StartReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type StartReceipt = Schema.Schema.Type<typeof StartReceipt>

/**
 * The immutable receipt for one successful post-start transaction.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CommitReceipt = Schema.Struct({
  operation: CommitOperation,
  operationId: Schema.NonEmptyString,
  key: PlanStoreV2.RunKey,
  previousSequence: NonNegativeSafeInt,
  sequence: NonNegativeSafeInt,
  recordedAt: EventV2.Timestamp,
  events: Schema.Array(EventV2.Event)
}).annotate({
  identifier: "WorkflowExecutionAuthorityV2CommitReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CommitReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type CommitReceipt = Schema.Schema.Type<typeof CommitReceipt>

/**
 * Any immutable operation receipt retained by the authority.
 *
 * @category models
 * @since 4.0.0
 */
export type Receipt = StartReceipt | CommitReceipt

/**
 * One pending semantic timer in the authority-owned due-time index.
 *
 * @category models
 * @since 4.0.0
 */
export interface IndexedTimer {
  readonly key: PlanStoreV2.RunKey
  readonly timerId: string
  readonly deadline: EventV2.Timestamp
  readonly historySequence: number
}

/**
 * One pending activity delivery selected from an immutable plan artifact.
 *
 * @category models
 * @since 4.0.0
 */
export interface DispatchOutboxItem {
  readonly key: PlanStoreV2.RunKey
  readonly artifactDigest: PlanStoreV2.ArtifactDigest
  readonly scheduledEventId: string
  readonly historySequence: number
  readonly logicalActivityId: string
  readonly attemptId: string
  readonly attempt: number
  readonly nodeId: string
  readonly nodeInstanceId: string
  readonly idempotencyKey: string
  readonly input: EventV2.EncodedValues
  readonly target: PlanStoreV2.DispatchTarget
}

/**
 * Why a run is waiting for another deterministic decision pass.
 *
 * @category models
 * @since 4.0.0
 */
export type WakeReason =
  | "RunStarted"
  | "ActivityCompleted"
  | "TimerFired"
  | "CancellationRequested"

/**
 * One coalesced run wake retained in the authority queue.
 *
 * @category models
 * @since 4.0.0
 */
export interface WakeItem {
  readonly key: PlanStoreV2.RunKey
  readonly revision: number
  readonly historySequence: number
  readonly reason: WakeReason
}

/**
 * Detached read-only state for one admitted run.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemoryRunSnapshot {
  readonly boundPlan: PlanStoreV2.BoundPlan
  readonly history: ReadonlyArray<EventV2.Event>
  readonly replay: RunStateV2.RunState
  readonly receipts: ReadonlyArray<Receipt>
  readonly indexedTimers: ReadonlyArray<IndexedTimer>
  readonly dispatchOutbox: ReadonlyArray<DispatchOutboxItem>
  readonly wake: WakeItem | undefined
}

/**
 * Detached read-only state for the complete process-local authority.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemorySnapshot {
  readonly runs: ReadonlyArray<MemoryRunSnapshot>
  readonly indexedTimers: ReadonlyArray<IndexedTimer>
  readonly dispatchOutbox: ReadonlyArray<DispatchOutboxItem>
  readonly wakeQueue: ReadonlyArray<WakeItem>
}

/**
 * Services produced by the process-local protocol version `2` authority.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemoryServices {
  readonly start: <W extends Workflow.Any>(
    plan: DecisionV2.DecidablePlan<W>,
    prepared: DurableStartV2.PreparedStart
  ) => Effect.Effect<StartReceipt, ExecutionAuthorityError>
  readonly decide: (
    request: unknown
  ) => Effect.Effect<CommitReceipt, ExecutionAuthorityError>
  readonly recordActivityStarted: (
    request: unknown
  ) => Effect.Effect<CommitReceipt, ExecutionAuthorityError>
  readonly completeActivityAttempt: (
    operationId: unknown,
    prepared: ActivityCompletionV2.PreparedCompletion
  ) => Effect.Effect<CommitReceipt, ExecutionAuthorityError>
  readonly fireTimer: (
    request: unknown
  ) => Effect.Effect<CommitReceipt, ExecutionAuthorityError>
  readonly requestCancellation: (
    request: unknown
  ) => Effect.Effect<CommitReceipt, ExecutionAuthorityError>
  readonly planStore: PlanStoreV2.PlanStoreV2.Service
  readonly inspect: (
    key: PlanStoreV2.RunKey
  ) => Effect.Effect<MemoryRunSnapshot | undefined>
  readonly snapshot: Effect.Effect<MemorySnapshot>
}

interface Captured<A> {
  readonly value: A
  readonly semantic: string
}

interface StoredOutcome {
  readonly operation: Operation
  readonly semantic: string
  readonly order: number
  readonly receipt: Receipt
}

interface StoredArtifact {
  readonly artifact: PlanStoreV2.PlanArtifact
  readonly semantic: string
}

interface StoredRun {
  readonly plan: DecisionV2.DecidablePlan
  readonly boundPlan: PlanStoreV2.BoundPlan
  readonly history: ReadonlyArray<EventV2.Event>
  readonly replay: RunStateV2.RunState
  readonly outcomes: HashMap.HashMap<string, StoredOutcome>
  readonly nextOutcomeOrder: number
  readonly timers: HashMap.HashMap<string, IndexedTimer>
  readonly dispatches: HashMap.HashMap<string, DispatchOutboxItem>
  readonly wakeRevision: number
  readonly wake: WakeItem | undefined
}

interface MemoryState {
  readonly runs: HashMap.HashMap<string, StoredRun>
  readonly artifacts: HashMap.HashMap<string, StoredArtifact>
  readonly starts: HashMap.HashMap<string, StoredOutcome>
}

type StrictDecoder<A> = (
  input: unknown
) => Result.Result<A, unknown>

const decodeStartRequest = Schema.decodeUnknownResult(
  DurableStartV2.Request,
  strictParseOptions
)
const decodeDecisionRequest = Schema.decodeUnknownResult(
  DecisionCommitRequest,
  strictParseOptions
)
const decodeRecordActivityStartedRequest = Schema.decodeUnknownResult(
  RecordActivityStartedRequest,
  strictParseOptions
)
const decodeCompleteActivityAttemptOperation = Schema.decodeUnknownResult(
  CompleteActivityAttemptOperation,
  strictParseOptions
)
const decodeFireTimerRequest = Schema.decodeUnknownResult(
  FireTimerRequest,
  strictParseOptions
)
const decodeCancellationRequest = Schema.decodeUnknownResult(
  RequestCancellationRequest,
  strictParseOptions
)
const decodeBoundPlan = Schema.decodeUnknownResult(
  PlanStoreV2.BoundPlan,
  strictParseOptions
)
const decodeTimestamp = Schema.decodeUnknownResult(
  ProtocolV2Wire.Timestamp,
  strictParseOptions
)
const decodeRunKey = Schema.decodeUnknownResult(
  PlanStoreV2.RunKey,
  strictParseOptions
)

const makeError = (
  operation: Operation,
  code: ExecutionAuthorityErrorCode,
  message: string,
  details?: Schema.Json
): ExecutionAuthorityError =>
  new ExecutionAuthorityError({
    operation,
    code,
    message,
    ...(details === undefined ? undefined : { details })
  })

const storageKey = (key: PlanStoreV2.RunKey): string => JSON.stringify([key.tenantId, key.runId])

const startKey = (tenantId: string, requestId: string): string => JSON.stringify([tenantId, requestId])

const artifactKey = (
  tenantId: string,
  artifactDigest: PlanStoreV2.ArtifactDigest
): string => JSON.stringify([tenantId, artifactDigest])

const getRun = (
  state: MemoryState,
  key: PlanStoreV2.RunKey
): StoredRun | undefined => Option.getOrUndefined(HashMap.get(state.runs, storageKey(key)))

const capture = <A>(
  operation: Operation,
  input: unknown,
  decode: StrictDecoder<A>
): Result.Result<Captured<A>, ExecutionAuthorityError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      operation,
      Codes.InvalidRequest,
      `Authority request must be strict JSON: ${snapshot.failure.message}`,
      {
        snapshotError: snapshot.failure.message,
        path: [...snapshot.failure.path]
      }
    ))
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = decode(snapshot.success)
  } catch {
    return Result.fail(makeError(
      operation,
      Codes.InvalidRequest,
      "Authority request schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(makeError(
      operation,
      Codes.InvalidRequest,
      "Invalid strict authority request",
      { parseError: String(decoded.failure) }
    ))
  }
  return Result.succeed(Object.freeze({
    value: snapshot.success as unknown as A,
    semantic: Json.canonicalizeSnapshot(snapshot.success)
  }))
}

const timestamp = (
  operation: Operation,
  millis: number
): Result.Result<EventV2.Timestamp, ExecutionAuthorityError> => {
  if (!Number.isSafeInteger(millis)) {
    return Result.fail(makeError(
      operation,
      Codes.ClockUnavailable,
      "Authority clock returned an unsafe millisecond value"
    ))
  }
  try {
    const value = new Date(millis).toISOString()
    const decoded = decodeTimestamp(value)
    return Result.isFailure(decoded)
      ? Result.fail(makeError(
        operation,
        Codes.ClockUnavailable,
        "Authority clock could not be represented as a canonical timestamp"
      ))
      : Result.succeed(decoded.success)
  } catch {
    return Result.fail(makeError(
      operation,
      Codes.ClockUnavailable,
      "Authority clock could not be represented as a canonical timestamp"
    ))
  }
}

const atLeast = (
  operation: Operation,
  candidate: EventV2.Timestamp,
  minimum: EventV2.Timestamp
): Result.Result<EventV2.Timestamp, ExecutionAuthorityError> => {
  const candidateMillis = Date.parse(candidate)
  const minimumMillis = Date.parse(minimum)
  if (
    !Number.isSafeInteger(candidateMillis) ||
    !Number.isSafeInteger(minimumMillis)
  ) {
    return Result.fail(makeError(
      operation,
      Codes.StoreInvariantViolation,
      "Authority transaction encountered an invalid timestamp"
    ))
  }
  return timestamp(operation, Math.max(candidateMillis, minimumMillis))
}

const semanticArtifact = (
  operation: Operation,
  input: unknown
): Result.Result<string, ExecutionAuthorityError> => {
  const validated = PlanStoreV2.validateArtifact(input)
  return Result.isFailure(validated)
    ? Result.fail(makeError(
      operation,
      Codes.ArtifactIdentityMismatch,
      "Prepared artifact is not a valid protocol version 2 artifact",
      { artifactCode: validated.failure.code }
    ))
    : Result.succeed(Json.canonicalizeSnapshot(
      validated.success as unknown as Schema.Json
    ))
}

const samePins = (
  plan: DecisionV2.DecidablePlan,
  wire: DurableStartV2.Request
): boolean => {
  const fingerprint = wire.artifact.fingerprintDocument
  return wire.artifactDigest === plan.artifactDigest &&
    wire.artifact === plan.artifact &&
    wire.artifact.compiledFingerprint === plan.compiledFingerprint &&
    fingerprint.compilerSemanticVersion === plan.compilerVersion &&
    fingerprint.plan.id === plan.compiled.plan.id &&
    fingerprint.plan.revision === plan.compiled.plan.revision &&
    fingerprint.plan.definition.id === plan.compiled.definition.id &&
    fingerprint.plan.definition.version === plan.compiled.definition.version
}

const boundPlan = (
  wire: DurableStartV2.Request,
  eventId: string
): Result.Result<PlanStoreV2.BoundPlan, ExecutionAuthorityError> => {
  const snapshot = Json.snapshot({
    binding: {
      bindingVersion: 2,
      executionProtocolVersion: 2,
      key: wire.key,
      artifactDigest: wire.artifactDigest,
      workflowIdentity: wire.workflowIdentity,
      requestId: wire.requestId,
      runStartedEventId: eventId
    },
    artifact: wire.artifact
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      "start",
      Codes.StartRejected,
      "Bound plan could not be detached safely"
    ))
  }
  const decoded = decodeBoundPlan(snapshot.success)
  return Result.isFailure(decoded)
    ? Result.fail(makeError(
      "start",
      Codes.StartRejected,
      "Internally constructed bound plan is invalid",
      { parseError: String(decoded.failure) }
    ))
    : Result.succeed(snapshot.success as unknown as PlanStoreV2.BoundPlan)
}

const runStarted = (
  plan: DecisionV2.DecidablePlan,
  wire: DurableStartV2.Request,
  recordedAt: EventV2.Timestamp
): Result.Result<
  readonly [EventV2.Event, RunStateV2.RunState],
  ExecutionAuthorityError
> => {
  const candidate = {
    eventVersion: EventV2.EventVersion,
    tenantId: wire.key.tenantId,
    eventId: IdentityV2.runStartedEventId(
      wire.key.tenantId,
      wire.key.runId
    ),
    runId: wire.key.runId,
    sequence: 0,
    recordedAt,
    correlationId: wire.requestId,
    payload: {
      _tag: "RunStarted",
      executionProtocolVersion: 2,
      artifactVersion: 2,
      artifactDigest: wire.artifactDigest,
      workflowIdentity: wire.workflowIdentity,
      startRequestId: wire.requestId,
      planId: plan.compiled.plan.id,
      planRevision: plan.compiled.plan.revision,
      definitionId: plan.compiled.definition.id,
      definitionVersion: plan.compiled.definition.version,
      compilerVersion: plan.compilerVersion,
      compiledFingerprint: plan.compiledFingerprint,
      backend: "durable",
      input: wire.input
    }
  }
  const snapshot = Json.snapshot(candidate)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      "start",
      Codes.StartRejected,
      "RunStarted could not be detached safely"
    ))
  }
  const event = snapshot.success as unknown as EventV2.Event
  const replay = RunStateV2.fold([event])
  return Result.isFailure(replay)
    ? Result.fail(makeError(
      "start",
      Codes.StartRejected,
      `RunStarted was rejected by protocol replay: ${replay.failure.message}`,
      { historyCode: replay.failure.code }
    ))
    : Result.succeed([event, replay.success])
}

const metadataSequence = (
  state: RunStateV2.RunState,
  eventId: string
): number | undefined => Option.getOrUndefined(HashMap.get(state.eventsById, eventId))?.sequence

const timerIndex = (
  key: PlanStoreV2.RunKey,
  state: RunStateV2.RunState
): HashMap.HashMap<string, IndexedTimer> => {
  let timers = HashMap.empty<string, IndexedTimer>()
  for (const timer of HashMap.values(state.timers)) {
    if (timer.status !== "Pending") {
      continue
    }
    const historySequence = metadataSequence(state, timer.scheduledEventId)
    if (historySequence === undefined) {
      continue
    }
    const indexed = Object.freeze({
      key,
      timerId: timer.timerId,
      deadline: timer.deadline,
      historySequence
    })
    timers = HashMap.set(timers, timer.timerId, indexed)
  }
  return timers
}

const dispatchIndex = (
  run: Pick<StoredRun, "boundPlan">,
  state: RunStateV2.RunState
): HashMap.HashMap<string, DispatchOutboxItem> => {
  let dispatches = HashMap.empty<string, DispatchOutboxItem>()
  if (state.status !== "Running") {
    return dispatches
  }
  for (const activity of HashMap.values(state.activities)) {
    if (activity.status !== "Active") {
      continue
    }
    const attempt = Option.getOrUndefined(
      HashMap.get(activity.attempts, activity.currentAttempt)
    )
    if (attempt?.status !== "Scheduled") {
      continue
    }
    const historySequence = metadataSequence(
      state,
      attempt.scheduledEventId
    )
    const target = run.boundPlan.artifact.dispatchTargets[activity.nodeId]
    if (historySequence === undefined || target === undefined) {
      continue
    }
    const item = Object.freeze({
      key: run.boundPlan.binding.key,
      artifactDigest: run.boundPlan.binding.artifactDigest,
      scheduledEventId: attempt.scheduledEventId,
      historySequence,
      logicalActivityId: activity.logicalActivityId,
      attemptId: attempt.attemptId,
      attempt: attempt.attempt,
      nodeId: activity.nodeId,
      nodeInstanceId: activity.nodeInstanceId,
      idempotencyKey: activity.idempotencyKey,
      input: activity.input,
      target
    })
    dispatches = HashMap.set(dispatches, item.attemptId, item)
  }
  return dispatches
}

const historyOrder = (
  left: { readonly historySequence: number },
  right: { readonly historySequence: number }
): number => left.historySequence - right.historySequence

const timerOrder = (left: IndexedTimer, right: IndexedTimer): number => {
  const deadline = Date.parse(left.deadline) - Date.parse(right.deadline)
  if (deadline !== 0) {
    return deadline
  }
  const history = historyOrder(left, right)
  return history !== 0
    ? history
    : left.timerId < right.timerId
    ? -1
    : left.timerId > right.timerId
    ? 1
    : 0
}

const replayHistory = (
  operation: Operation,
  history: ReadonlyArray<EventV2.Event>
): Result.Result<RunStateV2.RunState, ExecutionAuthorityError> => {
  const replay = RunStateV2.fold(history)
  return Result.isFailure(replay)
    ? Result.fail(makeError(
      operation,
      Codes.StoreInvariantViolation,
      `Committed history cannot be replayed: ${replay.failure.message}`,
      { historyCode: replay.failure.code }
    ))
    : Result.succeed(replay.success)
}

const duplicate = (
  run: StoredRun,
  operation: Operation,
  operationId: string,
  semantic: string
): Result.Result<Receipt | undefined, ExecutionAuthorityError> => {
  const found = Option.getOrUndefined(HashMap.get(run.outcomes, operationId))
  if (found === undefined) {
    return Result.succeed(undefined)
  }
  return found.operation === operation && found.semantic === semantic
    ? Result.succeed(found.receipt)
    : Result.fail(makeError(
      operation,
      Codes.IdempotencyConflict,
      `Operation identity '${operationId}' was already used for different semantics`,
      {
        operationId,
        priorOperation: found.operation
      }
    ))
}

const nextWake = (
  operation: Operation,
  run: StoredRun,
  replay: RunStateV2.RunState,
  reason: WakeReason
): Result.Result<
  readonly [number, WakeItem],
  ExecutionAuthorityError
> => {
  if (run.wakeRevision >= Number.MAX_SAFE_INTEGER) {
    return Result.fail(makeError(
      operation,
      Codes.CounterOverflow,
      "Run wake revision exceeds the safe-integer range"
    ))
  }
  const revision = run.wakeRevision + 1
  return Result.succeed([
    revision,
    Object.freeze({
      key: run.boundPlan.binding.key,
      revision,
      historySequence: replay.sequence,
      reason
    })
  ])
}

const committedRun = (
  run: StoredRun,
  operation: CommitOperation,
  operationId: string,
  semantic: string,
  recordedAt: EventV2.Timestamp,
  events: ReadonlyArray<EventV2.Event>,
  options: {
    readonly wake?: WakeReason | undefined
    readonly clearWake?: boolean | undefined
  }
): Result.Result<
  readonly [CommitReceipt, StoredRun],
  ExecutionAuthorityError
> => {
  if (run.nextOutcomeOrder >= Number.MAX_SAFE_INTEGER) {
    return Result.fail(makeError(
      operation,
      Codes.CounterOverflow,
      "Run operation-receipt order exceeds the safe-integer range"
    ))
  }
  const history = Object.freeze([...run.history, ...events])
  const replay = replayHistory(operation, history)
  if (Result.isFailure(replay)) {
    return Result.fail(replay.failure)
  }
  const receiptSnapshot = Json.snapshot({
    operation,
    operationId,
    key: run.boundPlan.binding.key,
    previousSequence: run.replay.sequence,
    sequence: replay.success.sequence,
    recordedAt,
    events
  })
  if (Result.isFailure(receiptSnapshot)) {
    return Result.fail(makeError(
      operation,
      Codes.StoreInvariantViolation,
      "Operation receipt could not be detached safely"
    ))
  }
  const receipt = receiptSnapshot.success as unknown as CommitReceipt
  const order = run.nextOutcomeOrder
  const outcomes = HashMap.set(
    run.outcomes,
    operationId,
    Object.freeze({
      operation,
      semantic,
      order,
      receipt
    })
  )
  let wakeRevision = run.wakeRevision
  let wake = options.clearWake === true ? undefined : run.wake
  if (options.wake !== undefined) {
    const updatedWake = nextWake(
      operation,
      run,
      replay.success,
      options.wake
    )
    if (Result.isFailure(updatedWake)) {
      return Result.fail(updatedWake.failure)
    }
    wakeRevision = updatedWake.success[0]
    wake = updatedWake.success[1]
  }
  const next: StoredRun = Object.freeze({
    ...run,
    history,
    replay: replay.success,
    outcomes,
    nextOutcomeOrder: order + 1,
    timers: timerIndex(run.boundPlan.binding.key, replay.success),
    dispatches: dispatchIndex(run, replay.success),
    wakeRevision,
    wake
  })
  return Result.succeed([receipt, next])
}

const deadlineProtocolFailure = (
  state: RunStateV2.RunState,
  commands: ReadonlyArray<CommandV2.Command>,
  error: CommandEventV2.CommandEventError,
  recordedAt: EventV2.Timestamp
): Result.Result<
  CommandEventV2.MaterializedBatch,
  CommandEventV2.CommandEventError
> => {
  const failed = error.commandIndex === undefined
    ? undefined
    : commands[error.commandIndex]
  if (
    error.code !== CommandEventV2.Codes.DeadlineOutOfRange ||
    failed === undefined ||
    (
      failed.payload._tag !== "ScheduleRetry" &&
      failed.payload._tag !== "ScheduleTimer"
    )
  ) {
    return Result.fail(error)
  }
  const anchorEventId = failed.payload.anchorEventId
  const delayMillis = failed.payload._tag === "ScheduleRetry"
    ? failed.payload.selectedDelayMillis
    : failed.payload.delayMillis
  const cleanup = Array.from(HashMap.values(state.timers))
    .filter((timer) => timer.status === "Pending")
    .sort((left, right) => left.timerId < right.timerId ? -1 : left.timerId > right.timerId ? 1 : 0)
    .map((timer): CommandV2.Command => ({
      commandVersion: CommandV2.CommandVersion,
      tenantId: state.tenantId,
      runId: state.runId,
      commandId: IdentityV2.cancelTimerCommandId(
        state.tenantId,
        state.runId,
        timer.timerId
      ),
      payload: {
        _tag: "CancelTimer",
        timerId: timer.timerId,
        reason: "RunTerminal"
      }
    }))
  const failure: CommandV2.Command = {
    commandVersion: CommandV2.CommandVersion,
    tenantId: state.tenantId,
    runId: state.runId,
    commandId: IdentityV2.failRunCommandId(state.tenantId, state.runId),
    payload: {
      _tag: "FailRun",
      cause: {
        _tag: "ProtocolFailure",
        code: "DeadlineOutOfRange",
        commandId: failed.commandId,
        anchorEventId,
        delayMillis
      }
    }
  }
  return CommandEventStorageV2.materialize(
    state,
    [...cleanup, failure],
    recordedAt
  )
}

const inspectRun = (run: StoredRun): MemoryRunSnapshot =>
  Object.freeze({
    boundPlan: run.boundPlan,
    history: Object.freeze([...run.history]),
    replay: run.replay,
    receipts: Object.freeze(
      Array.from(HashMap.values(run.outcomes))
        .sort((left, right) => left.order - right.order)
        .map((outcome) => outcome.receipt)
    ),
    indexedTimers: Object.freeze(
      Array.from(HashMap.values(run.timers)).sort(timerOrder)
    ),
    dispatchOutbox: Object.freeze(
      Array.from(HashMap.values(run.dispatches)).sort(historyOrder)
    ),
    wake: run.wake
  })

const inspectMemory = (state: MemoryState): MemorySnapshot => {
  const runs = Array.from(HashMap.values(state.runs))
    .sort((left, right) => {
      const leftKey = storageKey(left.boundPlan.binding.key)
      const rightKey = storageKey(right.boundPlan.binding.key)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    .map(inspectRun)
  return Object.freeze({
    runs: Object.freeze(runs),
    indexedTimers: Object.freeze(
      runs.flatMap((run) => run.indexedTimers).sort(timerOrder)
    ),
    dispatchOutbox: Object.freeze(
      runs.flatMap((run) => run.dispatchOutbox).sort(historyOrder)
    ),
    wakeQueue: Object.freeze(
      runs.flatMap((run) => run.wake === undefined ? [] : [run.wake])
        .sort((left, right) => {
          const history = historyOrder(left, right)
          if (history !== 0) {
            return history
          }
          const leftKey = storageKey(left.key)
          const rightKey = storageKey(right.key)
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
        })
    )
  })
}

/**
 * Constructs an isolated process-local protocol version `2` execution
 * authority.
 *
 * **Details**
 *
 * Start admission requires exact `DecisionV2.prepare` and
 * `DurableStartV2.prepare` provenance. The authority checks object identity
 * between their artifacts, all compiler pins, and the artifact digest before
 * entering its single `Ref` transaction.
 *
 * Every later capability snapshots a strict request, checks global per-run
 * operation identity, obtains a store timestamp, and rechecks all mutable
 * preconditions inside `Ref.modify`. Decision commands are recomputed inside
 * that mutation against the exact current derived head and expected sequence.
 * Failed transactions return the previous `Ref` value unchanged.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory = Effect.fnUntraced(function*(): Effect.fn.Return<
  Readonly<MemoryServices>,
  never,
  Clock.Clock
> {
  const clock = yield* Clock.Clock
  const state = yield* Ref.make<MemoryState>(Object.freeze({
    runs: HashMap.empty(),
    artifacts: HashMap.empty(),
    starts: HashMap.empty()
  }))

  const now = Effect.fnUntraced(function*(
    operation: Operation,
    minimum?: EventV2.Timestamp
  ): Effect.fn.Return<
    EventV2.Timestamp,
    ExecutionAuthorityError
  > {
    const clockMillis = yield* clock.currentTimeMillis.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(makeError(
            operation,
            Codes.ClockUnavailable,
            "Authority clock failed"
          ))
      )
    )
    const minimumMillis = minimum === undefined
      ? Number.MIN_SAFE_INTEGER
      : Date.parse(minimum)
    if (!Number.isSafeInteger(minimumMillis)) {
      return yield* Effect.fail(makeError(
        operation,
        Codes.StoreInvariantViolation,
        "Stored history head has an invalid timestamp"
      ))
    }
    const admitted = timestamp(
      operation,
      Math.max(clockMillis, minimumMillis)
    )
    return Result.isFailure(admitted)
      ? yield* Effect.fail(admitted.failure)
      : admitted.success
  })

  const start: MemoryServices["start"] = Effect.fnUntraced(function*(
    plan,
    prepared
  ) {
    if (!DecisionV2.isPrepared(plan)) {
      return yield* Effect.fail(makeError(
        "start",
        Codes.InvalidPreparedPlan,
        "Start requires the exact result of DecisionV2.prepare"
      ))
    }
    if (!DurableStartV2.isPrepared(prepared)) {
      return yield* Effect.fail(makeError(
        "start",
        Codes.InvalidPreparedStart,
        "Start requires the exact result of DurableStartV2.prepare"
      ))
    }
    const request = capture("start", prepared.wire, decodeStartRequest)
    if (Result.isFailure(request)) {
      return yield* Effect.fail(makeError(
        "start",
        Codes.InvalidPreparedStart,
        request.failure.message,
        request.failure.details
      ))
    }
    if (!samePins(plan, prepared.wire)) {
      return yield* Effect.fail(makeError(
        "start",
        prepared.wire.artifactDigest !== plan.artifactDigest ||
          prepared.wire.artifact !== plan.artifact
          ? Codes.ArtifactIdentityMismatch
          : Codes.CompilerIdentityMismatch,
        "Prepared start and prepared decision plan do not have exact shared identity"
      ))
    }
    const planArtifactSemantic = semanticArtifact("start", plan.artifact)
    if (Result.isFailure(planArtifactSemantic)) {
      return yield* Effect.fail(planArtifactSemantic.failure)
    }
    const requestArtifactSemantic = semanticArtifact(
      "start",
      request.success.value.artifact
    )
    if (
      Result.isFailure(requestArtifactSemantic) ||
      requestArtifactSemantic.success !== planArtifactSemantic.success
    ) {
      return yield* Effect.fail(makeError(
        "start",
        Codes.ArtifactIdentityMismatch,
        "Prepared start artifact does not equal the prepared plan artifact"
      ))
    }

    const earlyState = yield* Ref.get(state)
    const earlyStart = Option.getOrUndefined(HashMap.get(
      earlyState.starts,
      startKey(
        request.success.value.key.tenantId,
        request.success.value.requestId
      )
    ))
    if (earlyStart !== undefined) {
      if (
        earlyStart.operation === "start" &&
        earlyStart.semantic === request.success.semantic
      ) {
        return earlyStart.receipt as StartReceipt
      }
      return yield* Effect.fail(makeError(
        "start",
        Codes.IdempotencyConflict,
        `Start request '${request.success.value.requestId}' was already used for different semantics`
      ))
    }

    const recordedAt = yield* now("start")
    const committed: Result.Result<
      StartReceipt,
      ExecutionAuthorityError
    > = yield* Ref.modify(
      state,
      (current): readonly [
        Result.Result<StartReceipt, ExecutionAuthorityError>,
        MemoryState
      ] => {
        const startIdentity = startKey(
          request.success.value.key.tenantId,
          request.success.value.requestId
        )
        const prior = Option.getOrUndefined(
          HashMap.get(current.starts, startIdentity)
        )
        if (prior !== undefined) {
          return prior.operation === "start" &&
              prior.semantic === request.success.semantic
            ? [Result.succeed(prior.receipt as StartReceipt), current] as const
            : [
              Result.fail(makeError(
                "start",
                Codes.IdempotencyConflict,
                `Start request '${request.success.value.requestId}' was already used for different semantics`
              )),
              current
            ] as const
        }
        if (getRun(current, request.success.value.key) !== undefined) {
          return [
            Result.fail(makeError(
              "start",
              Codes.RunAlreadyExists,
              "A run with this tenant-scoped key already exists"
            )),
            current
          ] as const
        }
        const existingArtifact = Option.getOrUndefined(HashMap.get(
          current.artifacts,
          artifactKey(
            request.success.value.key.tenantId,
            request.success.value.artifactDigest
          )
        ))
        if (
          existingArtifact !== undefined &&
          existingArtifact.semantic !== planArtifactSemantic.success
        ) {
          return [
            Result.fail(makeError(
              "start",
              Codes.ArtifactIdentityMismatch,
              "Artifact digest is already bound to different immutable content"
            )),
            current
          ] as const
        }
        const started = runStarted(plan, request.success.value, recordedAt)
        if (Result.isFailure(started)) {
          return [Result.fail(started.failure), current] as const
        }
        const [event, replay] = started.success
        const binding = boundPlan(request.success.value, event.eventId)
        if (Result.isFailure(binding)) {
          return [Result.fail(binding.failure), current] as const
        }
        const receiptSnapshot = Json.snapshot({
          operation: "start",
          operationId: request.success.value.requestId,
          key: request.success.value.key,
          sequence: 0,
          recordedAt,
          binding: binding.success.binding,
          event
        })
        if (Result.isFailure(receiptSnapshot)) {
          return [
            Result.fail(makeError(
              "start",
              Codes.StoreInvariantViolation,
              "Start receipt could not be detached safely"
            )),
            current
          ] as const
        }
        const receipt = receiptSnapshot.success as unknown as StartReceipt
        const outcome: StoredOutcome = Object.freeze({
          operation: "start",
          semantic: request.success.semantic,
          order: 0,
          receipt
        })
        const wake: WakeItem = Object.freeze({
          key: binding.success.binding.key,
          revision: 1,
          historySequence: 0,
          reason: "RunStarted"
        })
        const run: StoredRun = Object.freeze({
          plan,
          boundPlan: binding.success,
          history: Object.freeze([event]),
          replay,
          outcomes: HashMap.make([
            request.success.value.requestId,
            outcome
          ]),
          nextOutcomeOrder: 1,
          timers: HashMap.empty(),
          dispatches: HashMap.empty(),
          wakeRevision: 1,
          wake
        })
        const next: MemoryState = Object.freeze({
          runs: HashMap.set(
            current.runs,
            storageKey(request.success.value.key),
            run
          ),
          artifacts: HashMap.set(
            current.artifacts,
            artifactKey(
              request.success.value.key.tenantId,
              request.success.value.artifactDigest
            ),
            existingArtifact ?? Object.freeze({
              artifact: binding.success.artifact,
              semantic: planArtifactSemantic.success
            })
          ),
          starts: HashMap.set(current.starts, startIdentity, outcome)
        })
        return [Result.succeed(receipt), next] as const
      }
    )
    return Result.isFailure(committed)
      ? yield* Effect.fail(committed.failure)
      : committed.success
  })

  const decide: MemoryServices["decide"] = Effect.fnUntraced(function*(input) {
    const request = capture("decide", input, decodeDecisionRequest)
    if (Result.isFailure(request)) {
      return yield* Effect.fail(request.failure)
    }
    const early = getRun(yield* Ref.get(state), request.success.value.key)
    if (early !== undefined) {
      const prior = duplicate(
        early,
        "decide",
        request.success.value.operationId,
        request.success.semantic
      )
      if (Result.isFailure(prior)) {
        return yield* Effect.fail(prior.failure)
      }
      if (prior.success !== undefined) {
        return prior.success as CommitReceipt
      }
    }
    const recordedAt = yield* now("decide", early?.replay.lastRecordedAt)
    const committed: Result.Result<
      CommitReceipt,
      ExecutionAuthorityError
    > = yield* Ref.modify(
      state,
      (current): readonly [
        Result.Result<CommitReceipt, ExecutionAuthorityError>,
        MemoryState
      ] => {
        const run = getRun(current, request.success.value.key)
        if (run === undefined) {
          return [
            Result.fail(makeError(
              "decide",
              Codes.RunNotFound,
              "Decision run was not found"
            )),
            current
          ] as const
        }
        const prior = duplicate(
          run,
          "decide",
          request.success.value.operationId,
          request.success.semantic
        )
        if (Result.isFailure(prior)) {
          return [Result.fail(prior.failure), current] as const
        }
        if (prior.success !== undefined) {
          return [
            Result.succeed(prior.success as CommitReceipt),
            current
          ] as const
        }
        if (run.replay.sequence !== request.success.value.expectedSequence) {
          return [
            Result.fail(makeError(
              "decide",
              Codes.StaleSequence,
              "Decision expected sequence does not match the durable head",
              {
                expectedSequence: request.success.value.expectedSequence,
                actualSequence: run.replay.sequence
              }
            )),
            current
          ] as const
        }
        const commitRecordedAt = atLeast(
          "decide",
          recordedAt,
          run.replay.lastRecordedAt
        )
        if (Result.isFailure(commitRecordedAt)) {
          return [Result.fail(commitRecordedAt.failure), current] as const
        }
        const commands = DecisionV2.decide(run.plan, run.replay)
        if (Result.isFailure(commands)) {
          return [
            Result.fail(makeError(
              "decide",
              Codes.DecisionRejected,
              commands.failure.message,
              { decisionCode: commands.failure.code }
            )),
            current
          ] as const
        }
        let events: ReadonlyArray<EventV2.Event> = Object.freeze([])
        if (commands.success.length > 0) {
          const attempted = CommandEventV2.materialize(
            run.replay,
            commands.success,
            commitRecordedAt.success
          )
          const materialized = Result.isFailure(attempted) &&
              attempted.failure.code === CommandEventV2.Codes.DeadlineOutOfRange
            ? deadlineProtocolFailure(
              run.replay,
              commands.success,
              attempted.failure,
              commitRecordedAt.success
            )
            : attempted
          if (Result.isFailure(materialized)) {
            return [
              Result.fail(makeError(
                "decide",
                Codes.CommandRejected,
                materialized.failure.message,
                { commandCode: materialized.failure.code }
              )),
              current
            ] as const
          }
          events = materialized.success.events
        }
        const next = committedRun(
          run,
          "decide",
          request.success.value.operationId,
          request.success.semantic,
          commitRecordedAt.success,
          events,
          { clearWake: true }
        )
        if (Result.isFailure(next)) {
          return [Result.fail(next.failure), current] as const
        }
        return [
          Result.succeed(next.success[0]),
          Object.freeze({
            ...current,
            runs: HashMap.set(
              current.runs,
              storageKey(request.success.value.key),
              next.success[1]
            )
          })
        ] as const
      }
    )
    return Result.isFailure(committed)
      ? yield* Effect.fail(committed.failure)
      : committed.success
  })

  const recordActivityStarted: MemoryServices["recordActivityStarted"] = Effect.fnUntraced(function*(input) {
    const request = capture(
      "recordActivityStarted",
      input,
      decodeRecordActivityStartedRequest
    )
    if (Result.isFailure(request)) {
      return yield* Effect.fail(request.failure)
    }
    const early = getRun(yield* Ref.get(state), request.success.value.key)
    if (early !== undefined) {
      const prior = duplicate(
        early,
        "recordActivityStarted",
        request.success.value.operationId,
        request.success.semantic
      )
      if (Result.isFailure(prior)) {
        return yield* Effect.fail(prior.failure)
      }
      if (prior.success !== undefined) {
        return prior.success as CommitReceipt
      }
    }
    const recordedAt = yield* now(
      "recordActivityStarted",
      early?.replay.lastRecordedAt
    )
    const committed: Result.Result<
      CommitReceipt,
      ExecutionAuthorityError
    > = yield* Ref.modify(
      state,
      (current): readonly [
        Result.Result<CommitReceipt, ExecutionAuthorityError>,
        MemoryState
      ] => {
        const run = getRun(current, request.success.value.key)
        if (run === undefined) {
          return [
            Result.fail(makeError(
              "recordActivityStarted",
              Codes.RunNotFound,
              "Worker-start run was not found"
            )),
            current
          ] as const
        }
        const prior = duplicate(
          run,
          "recordActivityStarted",
          request.success.value.operationId,
          request.success.semantic
        )
        if (Result.isFailure(prior)) {
          return [Result.fail(prior.failure), current] as const
        }
        if (prior.success !== undefined) {
          return [
            Result.succeed(prior.success as CommitReceipt),
            current
          ] as const
        }
        const commitRecordedAt = atLeast(
          "recordActivityStarted",
          recordedAt,
          run.replay.lastRecordedAt
        )
        if (Result.isFailure(commitRecordedAt)) {
          return [Result.fail(commitRecordedAt.failure), current] as const
        }
        if (
          Option.getOrUndefined(
            HashMap.get(run.dispatches, request.success.value.attemptId)
          ) === undefined
        ) {
          return [
            Result.fail(makeError(
              "recordActivityStarted",
              Codes.DispatchNotFound,
              "Activity attempt is not present in the authority dispatch outbox"
            )),
            current
          ] as const
        }
        const materialized = ExternalEventV2.recordActivityStarted(
          run.replay,
          {
            key: request.success.value.key,
            logicalActivityId: request.success.value.logicalActivityId,
            attemptId: request.success.value.attemptId,
            attempt: request.success.value.attempt
          },
          commitRecordedAt.success
        )
        if (Result.isFailure(materialized)) {
          return [
            Result.fail(makeError(
              "recordActivityStarted",
              Codes.ExternalFactRejected,
              materialized.failure.message,
              { externalCode: materialized.failure.code }
            )),
            current
          ] as const
        }
        const next = committedRun(
          run,
          "recordActivityStarted",
          request.success.value.operationId,
          request.success.semantic,
          commitRecordedAt.success,
          materialized.success.events,
          {}
        )
        if (Result.isFailure(next)) {
          return [Result.fail(next.failure), current] as const
        }
        return [
          Result.succeed(next.success[0]),
          Object.freeze({
            ...current,
            runs: HashMap.set(
              current.runs,
              storageKey(request.success.value.key),
              next.success[1]
            )
          })
        ] as const
      }
    )
    return Result.isFailure(committed)
      ? yield* Effect.fail(committed.failure)
      : committed.success
  })

  const completeActivityAttempt: MemoryServices["completeActivityAttempt"] = Effect.fnUntraced(
    function*(operationId, prepared) {
      if (!ActivityCompletionV2.isPrepared(prepared)) {
        return yield* Effect.fail(makeError(
          "completeActivityAttempt",
          Codes.InvalidPreparedCompletion,
          "Worker completion requires the exact result of ActivityCompletionV2.prepare"
        ))
      }
      const operation = capture(
        "completeActivityAttempt",
        { operationId },
        decodeCompleteActivityAttemptOperation
      )
      if (Result.isFailure(operation)) {
        return yield* Effect.fail(operation.failure)
      }
      const semanticSnapshot = Json.snapshot({
        operationId: operation.success.value.operationId,
        wire: prepared.wire
      })
      if (Result.isFailure(semanticSnapshot)) {
        return yield* Effect.fail(makeError(
          "completeActivityAttempt",
          Codes.InvalidPreparedCompletion,
          "Prepared completion could not be captured safely"
        ))
      }
      const semantic = Json.canonicalizeSnapshot(semanticSnapshot.success)
      const wire = prepared.wire
      const early = getRun(yield* Ref.get(state), wire.key)
      if (early !== undefined) {
        const prior = duplicate(
          early,
          "completeActivityAttempt",
          operation.success.value.operationId,
          semantic
        )
        if (Result.isFailure(prior)) {
          return yield* Effect.fail(prior.failure)
        }
        if (prior.success !== undefined) {
          return prior.success as CommitReceipt
        }
      }
      const recordedAt = yield* now(
        "completeActivityAttempt",
        early?.replay.lastRecordedAt
      )
      const committed: Result.Result<
        CommitReceipt,
        ExecutionAuthorityError
      > = yield* Ref.modify(
        state,
        (current): readonly [
          Result.Result<CommitReceipt, ExecutionAuthorityError>,
          MemoryState
        ] => {
          const run = getRun(current, wire.key)
          if (run === undefined) {
            return [
              Result.fail(makeError(
                "completeActivityAttempt",
                Codes.RunNotFound,
                "Worker-completion run was not found"
              )),
              current
            ] as const
          }
          const prior = duplicate(
            run,
            "completeActivityAttempt",
            operation.success.value.operationId,
            semantic
          )
          if (Result.isFailure(prior)) {
            return [Result.fail(prior.failure), current] as const
          }
          if (prior.success !== undefined) {
            return [
              Result.succeed(prior.success as CommitReceipt),
              current
            ] as const
          }
          const resolved = ActivityCompletionV2.resolve(
            run.plan,
            run.replay,
            prepared
          )
          if (Result.isFailure(resolved)) {
            return [
              Result.fail(makeError(
                "completeActivityAttempt",
                Codes.InvalidPreparedCompletion,
                resolved.failure.message,
                { completionCode: resolved.failure.code }
              )),
              current
            ] as const
          }
          const commitRecordedAt = atLeast(
            "completeActivityAttempt",
            recordedAt,
            run.replay.lastRecordedAt
          )
          if (Result.isFailure(commitRecordedAt)) {
            return [Result.fail(commitRecordedAt.failure), current] as const
          }
          const materialized = ExternalEventV2.completeActivityAttempt(
            run.replay,
            resolved.success,
            commitRecordedAt.success
          )
          if (Result.isFailure(materialized)) {
            return [
              Result.fail(makeError(
                "completeActivityAttempt",
                Codes.ExternalFactRejected,
                materialized.failure.message,
                { externalCode: materialized.failure.code }
              )),
              current
            ] as const
          }
          const next = committedRun(
            run,
            "completeActivityAttempt",
            operation.success.value.operationId,
            semantic,
            commitRecordedAt.success,
            materialized.success.events,
            { wake: "ActivityCompleted" }
          )
          if (Result.isFailure(next)) {
            return [Result.fail(next.failure), current] as const
          }
          return [
            Result.succeed(next.success[0]),
            Object.freeze({
              ...current,
              runs: HashMap.set(
                current.runs,
                storageKey(wire.key),
                next.success[1]
              )
            })
          ] as const
        }
      )
      return Result.isFailure(committed)
        ? yield* Effect.fail(committed.failure)
        : committed.success
    }
  )

  const fireTimer: MemoryServices["fireTimer"] = Effect.fnUntraced(function*(input) {
    const request = capture("fireTimer", input, decodeFireTimerRequest)
    if (Result.isFailure(request)) {
      return yield* Effect.fail(request.failure)
    }
    const early = getRun(yield* Ref.get(state), request.success.value.key)
    if (early !== undefined) {
      const prior = duplicate(
        early,
        "fireTimer",
        request.success.value.operationId,
        request.success.semantic
      )
      if (Result.isFailure(prior)) {
        return yield* Effect.fail(prior.failure)
      }
      if (prior.success !== undefined) {
        return prior.success as CommitReceipt
      }
    }
    const recordedAt = yield* now("fireTimer", early?.replay.lastRecordedAt)
    const committed: Result.Result<
      CommitReceipt,
      ExecutionAuthorityError
    > = yield* Ref.modify(
      state,
      (current): readonly [
        Result.Result<CommitReceipt, ExecutionAuthorityError>,
        MemoryState
      ] => {
        const run = getRun(current, request.success.value.key)
        if (run === undefined) {
          return [
            Result.fail(makeError(
              "fireTimer",
              Codes.RunNotFound,
              "Timer run was not found"
            )),
            current
          ] as const
        }
        const prior = duplicate(
          run,
          "fireTimer",
          request.success.value.operationId,
          request.success.semantic
        )
        if (Result.isFailure(prior)) {
          return [Result.fail(prior.failure), current] as const
        }
        if (prior.success !== undefined) {
          return [
            Result.succeed(prior.success as CommitReceipt),
            current
          ] as const
        }
        const commitRecordedAt = atLeast(
          "fireTimer",
          recordedAt,
          run.replay.lastRecordedAt
        )
        if (Result.isFailure(commitRecordedAt)) {
          return [Result.fail(commitRecordedAt.failure), current] as const
        }
        if (
          Option.getOrUndefined(
            HashMap.get(run.timers, request.success.value.timerId)
          ) === undefined
        ) {
          return [
            Result.fail(makeError(
              "fireTimer",
              Codes.TimerNotIndexed,
              "Timer is not present in the authority due-time index"
            )),
            current
          ] as const
        }
        const materialized = ExternalEventV2.fireTimer(
          run.replay,
          {
            key: request.success.value.key,
            timerId: request.success.value.timerId
          },
          commitRecordedAt.success
        )
        if (Result.isFailure(materialized)) {
          return [
            Result.fail(makeError(
              "fireTimer",
              Codes.ExternalFactRejected,
              materialized.failure.message,
              { externalCode: materialized.failure.code }
            )),
            current
          ] as const
        }
        const next = committedRun(
          run,
          "fireTimer",
          request.success.value.operationId,
          request.success.semantic,
          commitRecordedAt.success,
          materialized.success.events,
          { wake: "TimerFired" }
        )
        if (Result.isFailure(next)) {
          return [Result.fail(next.failure), current] as const
        }
        return [
          Result.succeed(next.success[0]),
          Object.freeze({
            ...current,
            runs: HashMap.set(
              current.runs,
              storageKey(request.success.value.key),
              next.success[1]
            )
          })
        ] as const
      }
    )
    return Result.isFailure(committed)
      ? yield* Effect.fail(committed.failure)
      : committed.success
  })

  const requestCancellation: MemoryServices["requestCancellation"] = Effect.fnUntraced(function*(input) {
    const request = capture(
      "requestCancellation",
      input,
      decodeCancellationRequest
    )
    if (Result.isFailure(request)) {
      return yield* Effect.fail(request.failure)
    }
    const early = getRun(yield* Ref.get(state), request.success.value.key)
    if (early !== undefined) {
      const prior = duplicate(
        early,
        "requestCancellation",
        request.success.value.requestId,
        request.success.semantic
      )
      if (Result.isFailure(prior)) {
        return yield* Effect.fail(prior.failure)
      }
      if (prior.success !== undefined) {
        return prior.success as CommitReceipt
      }
    }
    const recordedAt = yield* now(
      "requestCancellation",
      early?.replay.lastRecordedAt
    )
    const committed: Result.Result<
      CommitReceipt,
      ExecutionAuthorityError
    > = yield* Ref.modify(
      state,
      (current): readonly [
        Result.Result<CommitReceipt, ExecutionAuthorityError>,
        MemoryState
      ] => {
        const run = getRun(current, request.success.value.key)
        if (run === undefined) {
          return [
            Result.fail(makeError(
              "requestCancellation",
              Codes.RunNotFound,
              "Cancellation run was not found"
            )),
            current
          ] as const
        }
        const prior = duplicate(
          run,
          "requestCancellation",
          request.success.value.requestId,
          request.success.semantic
        )
        if (Result.isFailure(prior)) {
          return [Result.fail(prior.failure), current] as const
        }
        if (prior.success !== undefined) {
          return [
            Result.succeed(prior.success as CommitReceipt),
            current
          ] as const
        }
        const commitRecordedAt = atLeast(
          "requestCancellation",
          recordedAt,
          run.replay.lastRecordedAt
        )
        if (Result.isFailure(commitRecordedAt)) {
          return [Result.fail(commitRecordedAt.failure), current] as const
        }
        const materialized = ExternalEventV2.requestCancellation(
          run.replay,
          request.success.value,
          commitRecordedAt.success
        )
        if (Result.isFailure(materialized)) {
          return [
            Result.fail(makeError(
              "requestCancellation",
              Codes.ExternalFactRejected,
              materialized.failure.message,
              { externalCode: materialized.failure.code }
            )),
            current
          ] as const
        }
        const next = committedRun(
          run,
          "requestCancellation",
          request.success.value.requestId,
          request.success.semantic,
          commitRecordedAt.success,
          materialized.success.events,
          { wake: "CancellationRequested" }
        )
        if (Result.isFailure(next)) {
          return [Result.fail(next.failure), current] as const
        }
        return [
          Result.succeed(next.success[0]),
          Object.freeze({
            ...current,
            runs: HashMap.set(
              current.runs,
              storageKey(request.success.value.key),
              next.success[1]
            )
          })
        ] as const
      }
    )
    return Result.isFailure(committed)
      ? yield* Effect.fail(committed.failure)
      : committed.success
  })

  const planStoreService: PlanStoreV2.PlanStoreV2.Service = Object.freeze({
    getForRun: (key: PlanStoreV2.RunKey) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const run = getRun(current, key)
          return run === undefined
            ? Effect.fail(
              new PlanStoreV1.RunBindingNotFound({
                tenantId: key.tenantId,
                runId: key.runId
              })
            )
            : Effect.succeed(run.boundPlan)
        })
      ),
    getArtifact: (options: {
      readonly tenantId: string
      readonly artifactDigest: PlanStoreV2.ArtifactDigest
    }) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const artifact = Option.getOrUndefined(HashMap.get(
            current.artifacts,
            artifactKey(options.tenantId, options.artifactDigest)
          ))
          return artifact === undefined
            ? Effect.fail(
              new PlanStoreV1.ArtifactNotFound({
                tenantId: options.tenantId,
                artifactDigest: options.artifactDigest as unknown as PlanStoreV1.ArtifactDigest
              })
            )
            : Effect.succeed(artifact.artifact)
        })
      )
  })
  const planStore = PlanStoreV2.PlanStoreV2.of(planStoreService)

  const inspect: MemoryServices["inspect"] = (input) => {
    const snapshot = Json.snapshot(input)
    if (Result.isFailure(snapshot)) {
      return Effect.succeed(undefined)
    }
    const decoded = decodeRunKey(snapshot.success)
    if (Result.isFailure(decoded)) {
      return Effect.succeed(undefined)
    }
    const key = snapshot.success as unknown as PlanStoreV2.RunKey
    return Ref.get(state).pipe(
      Effect.map((current) => {
        const run = getRun(current, key)
        return run === undefined ? undefined : inspectRun(run)
      })
    )
  }

  return Object.freeze({
    start,
    decide,
    recordActivityStarted,
    completeActivityAttempt,
    fireTimer,
    requestCancellation,
    planStore,
    inspect,
    snapshot: Ref.get(state).pipe(Effect.map(inspectMemory))
  })
})
