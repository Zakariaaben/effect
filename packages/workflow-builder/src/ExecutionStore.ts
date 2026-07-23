/**
 * Atomic semantic-history and durable-dispatch commit contracts, with a
 * process-local reference implementation.
 *
 * @since 4.0.0
 */
import type * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Chunk from "effect/Chunk"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityCancellation from "./ActivityCancellationDelivery.ts"
import * as ActivityDelivery from "./ActivityDeliveryStore.ts"
import * as CommandEvent from "./CommandEvent.ts"
import * as Dispatch from "./Dispatch.ts"
import * as DurableStart from "./DurableStart.ts"
import * as Event from "./Event.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as HistoryStore from "./HistoryStore.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"
import * as PlanStore from "./PlanStore.ts"
import * as RunCoordinator from "./RunCoordinatorStore.ts"
import * as RunState from "./RunState.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * An immutable physical target selected before durable activity dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchTarget = PlanStore.DispatchTarget

/**
 * The decoded type of {@link DispatchTarget}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchTarget = PlanStore.DispatchTarget

/**
 * A tenant-scoped durable run identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunKey = PlanStore.RunKey

/**
 * The decoded type of {@link RunKey}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunKey = PlanStore.RunKey

/**
 * A narrowed semantic-command envelope that can dispatch one activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleActivityCommand = Dispatch.ScheduleActivityCommand

/**
 * The decoded type of {@link ScheduleActivityCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleActivityCommand = Dispatch.ScheduleActivityCommand

/**
 * Immutable intent to publish one already-committed activity schedule.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityDispatchDraft = Dispatch.ActivityDispatchDraft

/**
 * The decoded type of {@link ActivityDispatchDraft}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityDispatchDraft = Dispatch.ActivityDispatchDraft

/**
 * Semantic facts that may be caused directly by a deterministic decision.
 *
 * **Details**
 *
 * Activity results are deliberately absent. Durable results enter history only
 * through the storage-atomic fenced completion operation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DecisionPayload = Schema.Union([
  Event.ActivityScheduled,
  Event.RunSucceeded,
  Event.RunFailed,
  Event.RunCancelled
]).annotate({ identifier: "WorkflowDecisionEventPayload" })

/**
 * The decoded type of {@link DecisionPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type DecisionPayload = Schema.Schema.Type<typeof DecisionPayload>

const EventDraft = Schema.Struct({
  eventVersion: Schema.Literal(1),
  eventId: Schema.NonEmptyString,
  causationId: Schema.optionalKey(Schema.NonEmptyString),
  correlationId: Schema.optionalKey(Schema.NonEmptyString),
  payload: DecisionPayload
})

/**
 * One atomic expected-sequence decision commit before store-owned envelope and
 * outbox fields have been assigned.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DecisionCommitDraft = Schema.Struct({
  commitVersion: Schema.Literal(1),
  key: PlanStore.RunKey,
  expectedLastSequence: NonNegativeInt,
  events: Schema.Array(EventDraft),
  dispatches: Schema.Array(ActivityDispatchDraft)
}).annotate({
  identifier: "WorkflowDecisionCommitDraft",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DecisionCommitDraft}.
 *
 * **Details**
 *
 * `events` is additionally required to be nonempty by
 * {@link ExecutionStore.Service.commitDecision}.
 *
 * @category models
 * @since 4.0.0
 */
export type DecisionCommitDraft =
  & Omit<
    Schema.Schema.Type<typeof DecisionCommitDraft>,
    "events"
  >
  & {
    readonly events: Arr.NonEmptyReadonlyArray<HistoryStore.EventDraft<DecisionPayload>>
  }

/**
 * Idempotent tenant-scoped request to commit cancellation intent.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  key: PlanStore.RunKey,
  requestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowCancellationRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationRequest = Schema.Schema.Type<typeof CancellationRequest>

/**
 * Raised when an immutable dispatch identifier overlaps a different commit or
 * different dispatch content.
 *
 * @category errors
 * @since 4.0.0
 */
export class DispatchIntentIdConflict extends Schema.TaggedErrorClass<DispatchIntentIdConflict>(
  "@effect/workflow-builder/ExecutionStore/DispatchIntentIdConflict"
)("DispatchIntentIdConflict", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  existingRunId: Schema.NonEmptyString,
  intentId: Schema.NonEmptyString,
  existingSourceSequence: NonNegativeInt,
  requestedSourceSequence: NonNegativeInt
}) {}

/**
 * Raised when caller-supplied decision content fails strict structural or
 * relational validation.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidDecisionCommit extends Schema.TaggedErrorClass<InvalidDecisionCommit>(
  "@effect/workflow-builder/ExecutionStore/InvalidDecisionCommit"
)("InvalidDecisionCommit", {
  tenantId: Schema.String,
  runId: Schema.String,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}) {}

/**
 * Raised when a cancellation request is not strict or internally valid.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidCancellationRequest extends Schema.TaggedErrorClass<InvalidCancellationRequest>(
  "@effect/workflow-builder/ExecutionStore/InvalidCancellationRequest"
)("InvalidCancellationRequest", {
  tenantId: Schema.String,
  runId: Schema.String,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when cancellation is requested after a run is already terminal.
 *
 * @category errors
 * @since 4.0.0
 */
export class CancellationRejected extends Schema.TaggedErrorClass<CancellationRejected>(
  "@effect/workflow-builder/ExecutionStore/CancellationRejected"
)("CancellationRejected", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  status: Schema.Literals(["Succeeded", "Failed", "Cancelled"])
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when existing event identities locate a decision commit whose complete
 * event-and-dispatch content differs from the retry.
 *
 * @category errors
 * @since 4.0.0
 */
export class DecisionCommitConflict extends Schema.TaggedErrorClass<DecisionCommitConflict>(
  "@effect/workflow-builder/ExecutionStore/DecisionCommitConflict"
)("DecisionCommitConflict", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  expectedLastSequence: NonNegativeInt,
  existingPreviousSequence: NonNegativeInt,
  message: Schema.NonEmptyString
}) {}

/**
 * Raised when a business start identity is reused with different pinned
 * meaning.
 *
 * @category errors
 * @since 4.0.0
 */
export class StartRequestConflict extends Schema.TaggedErrorClass<StartRequestConflict>(
  "@effect/workflow-builder/ExecutionStore/StartRequestConflict"
)("StartRequestConflict", {
  tenantId: Schema.NonEmptyString,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  existingRunId: Schema.NonEmptyString,
  requestedRunId: Schema.NonEmptyString,
  existingArtifactDigest: PlanStore.ArtifactDigest,
  requestedArtifactDigest: PlanStore.ArtifactDigest
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a tenant-scoped run key is already bound to different immutable
 * start meaning.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunKeyConflict extends Schema.TaggedErrorClass<RunKeyConflict>(
  "@effect/workflow-builder/ExecutionStore/RunKeyConflict"
)("RunKeyConflict", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  existingWorkflowIdentity: Schema.NonEmptyString,
  requestedWorkflowIdentity: Schema.NonEmptyString,
  existingRequestId: Schema.NonEmptyString,
  requestedRequestId: Schema.NonEmptyString,
  existingArtifactDigest: PlanStore.ArtifactDigest,
  requestedArtifactDigest: PlanStore.ArtifactDigest
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a declared compiled fingerprint does not match its document.
 *
 * @category errors
 * @since 4.0.0
 */
export class CompiledFingerprintMismatch extends Schema.TaggedErrorClass<CompiledFingerprintMismatch>(
  "@effect/workflow-builder/ExecutionStore/CompiledFingerprintMismatch"
)("CompiledFingerprintMismatch", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  declared: Fingerprint.Digest,
  computed: Fingerprint.Digest
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a declared artifact digest does not match the artifact content.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactDigestMismatch extends Schema.TaggedErrorClass<ArtifactDigestMismatch>(
  "@effect/workflow-builder/ExecutionStore/ArtifactDigestMismatch"
)("ArtifactDigestMismatch", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  declared: PlanStore.ArtifactDigest,
  computed: PlanStore.ArtifactDigest
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when one tenant already stores different content under an artifact
 * digest returned by the configured cryptographic implementation.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactDigestCollision extends Schema.TaggedErrorClass<ArtifactDigestCollision>(
  "@effect/workflow-builder/ExecutionStore/ArtifactDigestCollision"
)("ArtifactDigestCollision", {
  tenantId: Schema.NonEmptyString,
  artifactDigest: PlanStore.ArtifactDigest
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a start request or artifact is not strict, internally consistent
 * JSON.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidDurableStart extends Schema.TaggedErrorClass<InvalidDurableStart>(
  "@effect/workflow-builder/ExecutionStore/InvalidDurableStart"
)("InvalidDurableStart", {
  tenantId: Schema.String,
  runId: Schema.String,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a tenant-scoped history does not exist.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>(
  "@effect/workflow-builder/ExecutionStore/RunNotFound"
)("RunNotFound", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a decision dispatch target differs from the run's pinned route.
 *
 * @category errors
 * @since 4.0.0
 */
export class DispatchTargetConflict extends Schema.TaggedErrorClass<DispatchTargetConflict>(
  "@effect/workflow-builder/ExecutionStore/DispatchTargetConflict"
)("DispatchTargetConflict", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  intentId: Schema.NonEmptyString,
  expected: Schema.optionalKey(PlanStore.DispatchTarget),
  requested: PlanStore.DispatchTarget
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when an execution-store operation cannot safely validate or perform a
 * request.
 *
 * @category errors
 * @since 4.0.0
 */
export class ExecutionStoreFailure extends Schema.TaggedErrorClass<ExecutionStoreFailure>(
  "@effect/workflow-builder/ExecutionStore/ExecutionStoreFailure"
)("ExecutionStoreFailure", {
  operation: Schema.Literals([
    "start",
    "commitDecision",
    "requestCancellation",
    "read",
    "inspectOutbox"
  ]),
  message: Schema.NonEmptyString,
  cause: Schema.optionalKey(Schema.Json)
}) {}

/**
 * An immutable outbox entry created in the same atomic mutation as its source
 * history event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityDispatch = Dispatch.ActivityDispatch

/**
 * The decoded type of {@link ActivityDispatch}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityDispatch = Dispatch.ActivityDispatch

/**
 * Immutable dispatch identity returned by one decision commit.
 *
 * @category models
 * @since 4.0.0
 */
export interface ActivityDispatchReceipt {
  readonly intentId: string
  readonly sourceEventId: string
  readonly sourceEventSequence: number
  readonly enqueuedAt: Event.Timestamp
}

/**
 * Receipt for one atomic semantic-history and dispatch-intent commit.
 *
 * @category models
 * @since 4.0.0
 */
export interface DecisionCommitReceipt extends HistoryStore.CommitReceipt {
  readonly dispatches: ReadonlyArray<ActivityDispatchReceipt>
}

/**
 * Receipt for an atomic durable start and immutable plan binding.
 *
 * @category models
 * @since 4.0.0
 */
export interface StartReceipt {
  readonly key: PlanStore.RunKey
  readonly artifactDigest: PlanStore.ArtifactDigest
  readonly binding: PlanStore.RunBinding
  readonly historyReceipt: HistoryStore.CommitReceipt
}

/**
 * Failures reported by decision commits.
 *
 * @category errors
 * @since 4.0.0
 */
export type DecisionCommitError =
  | RunNotFound
  | HistoryStore.SequenceConflict
  | HistoryStore.EventIdConflict
  | DispatchIntentIdConflict
  | DispatchTargetConflict
  | DecisionCommitConflict
  | InvalidDecisionCommit
  | RunCoordinator.CoordinatorError
  | ExecutionStoreFailure

/**
 * Failures reported while atomically requesting run cancellation.
 *
 * @category errors
 * @since 4.0.0
 */
export type CancellationError =
  | RunNotFound
  | InvalidCancellationRequest
  | CancellationRejected
  | ExecutionStoreFailure

/**
 * Failures reported by durable starts.
 *
 * @category errors
 * @since 4.0.0
 */
export type StartError =
  | StartRequestConflict
  | RunKeyConflict
  | CompiledFingerprintMismatch
  | ArtifactDigestMismatch
  | ArtifactDigestCollision
  | InvalidDurableStart
  | ExecutionStoreFailure

/**
 * Atomic history and immutable dispatch-intent storage.
 *
 * **Details**
 *
 * Durable starts must be the exact result of {@link DurableStart.prepare};
 * structural copies and forged wrappers are rejected before their wire data is
 * inspected. The store then independently snapshots and verifies that wire
 * data and its content digests before mutation.
 *
 * This facade deliberately exposes no generic append. Durable decisions enter
 * through a strict coordinator envelope whose current capability is rechecked
 * in the same atomic mutation that commits semantic events and physical
 * dispatch intents. Relay and worker operations are exposed by
 * `ActivityDeliveryStore`, backed by the same authority in the memory reference
 * implementation.
 *
 * @category services
 * @since 4.0.0
 */
export class ExecutionStore extends Context.Service<ExecutionStore, ExecutionStore.Service>()(
  "@effect/workflow-builder/ExecutionStore"
) {}

/**
 * Service contracts for {@link ExecutionStore}.
 *
 * @since 4.0.0
 */
export declare namespace ExecutionStore {
  /**
   * The execution-store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly start: (
      request: DurableStart.PreparedStart
    ) => Effect.Effect<StartReceipt, StartError>
    readonly commitDecision: (
      request: RunCoordinator.CommitDecisionRequest
    ) => Effect.Effect<DecisionCommitReceipt, DecisionCommitError>
    readonly requestCancellation: (
      request: CancellationRequest
    ) => Effect.Effect<HistoryStore.CommitReceipt, CancellationError>
    readonly read: (
      key: PlanStore.RunKey
    ) => Effect.Effect<HistoryStore.HistorySnapshot, RunNotFound | ExecutionStoreFailure>
    readonly inspectOutbox: (
      key: PlanStore.RunKey
    ) => Effect.Effect<ReadonlyArray<ActivityDispatch>, RunNotFound | ExecutionStoreFailure>
  }
}

type Operation = "start" | "commitDecision" | "requestCancellation" | "read" | "inspectOutbox"

interface StoredBatch {
  readonly kind: "Start" | "Decision" | "Cancellation" | "ActivityCompletion"
  readonly previousSequence: number | null
  readonly canonicalEvents: Arr.NonEmptyReadonlyArray<string>
  readonly canonicalDispatches: ReadonlyArray<string>
  readonly canonicalCommit: string
  readonly historyReceipt: HistoryStore.CommitReceipt
  readonly decisionReceipt?: DecisionCommitReceipt | undefined
}

interface StoredEvent {
  readonly event: Event.Event
  readonly batch: StoredBatch
  readonly position: number
}

interface StoredDispatch {
  readonly dispatch: ActivityDispatch
  readonly dispatchDigest: Fingerprint.Digest
  readonly batch: StoredBatch
  readonly position: number
  readonly relay: StoredRelayState
  readonly activity: StoredActivityState
}

interface StoredRelayState {
  readonly epoch: number
  readonly status: "Pending" | "Leased" | "Published" | "Suppressed"
  readonly lease?: ActivityDelivery.RelayClaim | undefined
  readonly expiresAtMillis?: number | undefined
  readonly published?: ActivityDelivery.PublishReceipt | undefined
  readonly released?: ActivityDelivery.RelayLeaseRef | undefined
}

interface StoredCompletion {
  readonly canonicalResult: string
  readonly receipt: ActivityDelivery.CompletionReceipt
}

interface StoredActivityState {
  readonly epoch: number
  readonly lease?: ActivityDelivery.ActivityLease | undefined
  readonly expiresAtMillis?: number | undefined
  readonly completion?: StoredCompletion | undefined
}

interface StoredIssuedExecution {
  readonly lease: ActivityDelivery.ActivityLease
  readonly runId: string
  readonly attemptId: string
  readonly attempt: number
  readonly logicalActivityId: string
  readonly quiescent: boolean
}

interface StoredCancellation {
  readonly record: ActivityCancellation.CancellationRecord
  readonly expiresAtMillis?: number | undefined
  readonly lastReleasedRef?: ActivityCancellation.CancellationClaimRef | undefined
  readonly lastReleaseReceipt?: ActivityCancellation.ReleaseCancellationClaimReceipt | undefined
}

interface StoredCoordinatorState {
  readonly epoch: number
  readonly lastClaimOrder?: number | undefined
  readonly lease?: RunCoordinator.RunLease | undefined
  readonly expiresAtMillis?: number | undefined
}

interface StoredDeliveryRequest<out A> {
  readonly canonicalRequest: string
  readonly receipt: A
}

interface StoredRun {
  readonly events: Chunk.Chunk<Event.Event>
  readonly byEventId: HashMap.HashMap<string, StoredEvent>
  readonly outbox: Chunk.Chunk<ActivityDispatch>
  readonly needsDecision: boolean
  readonly coordinator: StoredCoordinatorState
  readonly cancellationReceipt?: HistoryStore.CommitReceipt | undefined
}

interface MemoryState {
  readonly runs: HashMap.HashMap<string, StoredRun>
  readonly byIntentId: HashMap.HashMap<string, StoredDispatch>
  readonly artifacts: HashMap.HashMap<string, StoredArtifact>
  readonly bindings: HashMap.HashMap<string, PlanStore.RunBinding>
  readonly requests: HashMap.HashMap<string, StoredStartRequest>
  readonly relayRequests: HashMap.HashMap<string, StoredDeliveryRequest<ActivityDelivery.ClaimOutboxReceipt>>
  readonly activityRequests: HashMap.HashMap<string, StoredDeliveryRequest<ActivityDelivery.ActivityLease>>
  readonly renewalRequests: HashMap.HashMap<string, StoredDeliveryRequest<ActivityDelivery.ActivityLease>>
  readonly issuedExecutions: HashMap.HashMap<string, StoredIssuedExecution>
  readonly cancellationTargets: HashMap.HashMap<string, string>
  readonly cancellations: HashMap.HashMap<string, StoredCancellation>
  readonly cancellationClaimRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<ActivityCancellation.ClaimCancellationsReceipt>
  >
  readonly cancellationAckRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<ActivityCancellation.AcknowledgeCancellationReceipt>
  >
  readonly cancellationReleaseRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<ActivityCancellation.ReleaseCancellationClaimReceipt>
  >
  readonly coordinatorClaimRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<RunCoordinator.ClaimRunnableRunsReceipt>
  >
  readonly coordinatorRenewalRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<RunCoordinator.RunLease>
  >
  readonly coordinatorReleaseRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<RunCoordinator.ReleaseRunLeaseReceipt>
  >
  readonly coordinatorIdleRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<RunCoordinator.IdleReceipt>
  >
  readonly coordinatorCommitRequests: HashMap.HashMap<
    string,
    StoredDeliveryRequest<DecisionCommitReceipt>
  >
  readonly coordinatorClaimCursors: HashMap.HashMap<string, number>
}

interface CancellationIndexes {
  readonly cancellationTargets: MemoryState["cancellationTargets"]
  readonly cancellations: MemoryState["cancellations"]
}

const enqueueCancellationsForRun = (
  state: Pick<
    MemoryState,
    "issuedExecutions" | "cancellationTargets" | "cancellations"
  >,
  key: PlanStore.RunKey,
  cancellationRequestId: string,
  sourceEventId: string,
  reason: ActivityCancellation.CancellationReason,
  enqueuedAt: Event.Timestamp
): CancellationIndexes => {
  let cancellationTargets = state.cancellationTargets
  let cancellations = state.cancellations
  for (
    const [issuedKey, generation] of HashMap.entries(
      state.issuedExecutions
    )
  ) {
    if (
      generation.quiescent ||
      generation.lease.ref.key.tenantId !== key.tenantId ||
      generation.runId !== key.runId ||
      HashMap.has(cancellationTargets, issuedKey)
    ) {
      continue
    }
    const coordinates: ActivityCancellation.CancellationIdentityCoordinates = {
      activityLeaseRef: generation.lease.ref,
      attemptId: generation.attemptId,
      attempt: generation.attempt,
      logicalActivityId: generation.logicalActivityId,
      cancellationRequestId,
      sourceEventId,
      reason
    }
    const cancellationId = ActivityCancellation.makeCancellationId(coordinates)
    const issued: ActivityCancellation.IssuedExecutionRef = Object.freeze({
      issuedVersion: 1,
      ...coordinates,
      cancellationId,
      enqueuedAt
    })
    const record: ActivityCancellation.PendingCancellation = Object.freeze({
      _tag: "Pending",
      recordVersion: 1,
      issued,
      claimEpoch: 0
    })
    cancellationTargets = HashMap.set(
      cancellationTargets,
      issuedKey,
      cancellationId
    )
    cancellations = HashMap.set(
      cancellations,
      cancellationId,
      Object.freeze({ record })
    )
  }
  return Object.freeze({ cancellationTargets, cancellations })
}

interface StoredArtifact {
  readonly artifact: PlanStore.PlanArtifact
  readonly canonicalArtifact: string
}

interface StoredStartRequest {
  readonly key: PlanStore.RunKey
  readonly artifactDigest: PlanStore.ArtifactDigest
  readonly canonicalInput: string
  readonly receipt: StartReceipt
}

interface ValidatedPairing {
  readonly eventPositionById: ReadonlyMap<string, number>
}

interface CoordinatorCommitFence {
  readonly ref: RunCoordinator.RunLeaseRef
  readonly coordinatorId: string
  readonly requestId: string
  readonly requestKey: string
  readonly canonicalRequest: string
}

const decodeStartRequest = Schema.decodeUnknownResult(DurableStart.Request, strictParseOptions)
const decodeDecisionCommit = Schema.decodeUnknownResult(DecisionCommitDraft, strictParseOptions)
const decodeCancellationRequest = Schema.decodeUnknownResult(CancellationRequest, strictParseOptions)
const decodeTimestamp = Schema.decodeUnknownResult(Event.Timestamp)
const decodeFingerprintDigest = Schema.decodeUnknownResult(Fingerprint.Digest, strictParseOptions)
const decodeArtifactDigest = Schema.decodeUnknownResult(PlanStore.ArtifactDigest, strictParseOptions)
const decodeRunKey = Schema.decodeUnknownResult(PlanStore.RunKey, strictParseOptions)
const decodeClaimOutbox = Schema.decodeUnknownResult(ActivityDelivery.ClaimOutboxRequest, strictParseOptions)
const decodeAcknowledgePublished = Schema.decodeUnknownResult(
  ActivityDelivery.AcknowledgePublishedRequest,
  strictParseOptions
)
const decodeReleaseOutbox = Schema.decodeUnknownResult(ActivityDelivery.ReleaseOutboxRequest, strictParseOptions)
const decodeAcquireAttempt = Schema.decodeUnknownResult(ActivityDelivery.AcquireAttemptRequest, strictParseOptions)
const decodeRenewAttempt = Schema.decodeUnknownResult(ActivityDelivery.RenewAttemptRequest, strictParseOptions)
const decodeCompleteAttempt = Schema.decodeUnknownResult(ActivityDelivery.CompleteAttemptRequest, strictParseOptions)
const decodeClaimRunnableRuns = Schema.decodeUnknownResult(
  RunCoordinator.ClaimRunnableRunsRequest,
  strictParseOptions
)
const decodeRenewRunLease = Schema.decodeUnknownResult(RunCoordinator.RenewRunLeaseRequest, strictParseOptions)
const decodeReleaseRunLease = Schema.decodeUnknownResult(RunCoordinator.ReleaseRunLeaseRequest, strictParseOptions)
const decodeAcknowledgeIdle = Schema.decodeUnknownResult(RunCoordinator.AcknowledgeIdleRequest, strictParseOptions)
const decodeCoordinatorCommit = Schema.decodeUnknownResult(RunCoordinator.CommitDecisionRequest, strictParseOptions)

const storeFailure = (
  operation: Operation,
  message: string,
  cause?: Schema.Json
): ExecutionStoreFailure =>
  new ExecutionStoreFailure({
    operation,
    message,
    ...(cause === undefined ? undefined : { cause })
  })

const deliveryFailure = (
  operation: ActivityDelivery.Operation,
  message: string,
  cause?: Schema.Json
): ActivityDelivery.ActivityDeliveryStoreFailure =>
  new ActivityDelivery.ActivityDeliveryStoreFailure({
    operation,
    message,
    ...(cause === undefined ? undefined : { cause })
  })

const cancellationDeliveryFailure = (
  operation: ActivityCancellation.Operation,
  message: string,
  cause?: Schema.Json
): ActivityCancellation.ActivityCancellationDeliveryStoreFailure =>
  new ActivityCancellation.ActivityCancellationDeliveryStoreFailure({
    operation,
    message,
    ...(cause === undefined ? undefined : { cause })
  })

const coordinatorFailure = (
  operation: RunCoordinator.Operation,
  message: string,
  cause?: Schema.Json
): RunCoordinator.RunCoordinatorStoreFailure =>
  new RunCoordinator.RunCoordinatorStoreFailure({
    operation,
    message,
    ...(cause === undefined ? undefined : { cause })
  })

const validateDeliveryRequest = <A>(
  operation: ActivityDelivery.Operation,
  input: unknown,
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>
): Result.Result<A, ActivityDelivery.InvalidDeliveryRequest> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(
      new ActivityDelivery.InvalidDeliveryRequest({
        operation,
        message: `Delivery request must be strict JSON: ${snapped.failure.message}`,
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      })
    )
  }
  let decoded: Result.Result<A, { readonly message: string }>
  try {
    decoded = decode(snapped.success)
  } catch {
    return Result.fail(
      new ActivityDelivery.InvalidDeliveryRequest({
        operation,
        message: "Delivery request schema validation threw unexpectedly"
      })
    )
  }
  return Result.isFailure(decoded)
    ? Result.fail(
      new ActivityDelivery.InvalidDeliveryRequest({
        operation,
        message: "Invalid activity delivery request",
        details: { parseError: decoded.failure.message }
      })
    )
    : Result.succeed(snapped.success as unknown as A)
}

const validateCoordinatorRequest = <A>(
  operation: RunCoordinator.Operation,
  input: unknown,
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>
): Result.Result<A, RunCoordinator.InvalidCoordinatorRequest> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(
      new RunCoordinator.InvalidCoordinatorRequest({
        operation,
        message: `Coordinator request must be strict JSON: ${snapped.failure.message}`,
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      })
    )
  }
  let decoded: Result.Result<A, { readonly message: string }>
  try {
    decoded = decode(snapped.success)
  } catch {
    return Result.fail(
      new RunCoordinator.InvalidCoordinatorRequest({
        operation,
        message: "Coordinator request schema validation threw unexpectedly"
      })
    )
  }
  return Result.isFailure(decoded)
    ? Result.fail(
      new RunCoordinator.InvalidCoordinatorRequest({
        operation,
        message: "Invalid run coordinator request",
        details: { parseError: decoded.failure.message }
      })
    )
    : Result.succeed(snapped.success as unknown as A)
}

const invalidCommit = (
  key: { readonly tenantId: string; readonly runId: string },
  message: string,
  details?: Schema.Json
): InvalidDecisionCommit =>
  new InvalidDecisionCommit({
    tenantId: key.tenantId,
    runId: key.runId,
    message,
    ...(details === undefined ? undefined : { details })
  })

const invalidStart = (
  key: { readonly tenantId: string; readonly runId: string },
  message: string,
  details?: Schema.Json
): InvalidDurableStart =>
  new InvalidDurableStart({
    tenantId: key.tenantId,
    runId: key.runId,
    message,
    ...(details === undefined ? undefined : { details })
  })

const invalidCancellation = (
  key: { readonly tenantId: string; readonly runId: string },
  message: string,
  details?: Schema.Json
): InvalidCancellationRequest =>
  new InvalidCancellationRequest({
    tenantId: key.tenantId,
    runId: key.runId,
    message,
    ...(details === undefined ? undefined : { details })
  })

const snapshotKey = (input: Schema.Json): { readonly tenantId: string; readonly runId: string } => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { tenantId: "", runId: "" }
  }
  const key = (input as Readonly<Record<string, Schema.Json>>).key
  if (key === null || typeof key !== "object" || Array.isArray(key)) {
    return { tenantId: "", runId: "" }
  }
  const record = key as Readonly<Record<string, Schema.Json>>
  return {
    tenantId: typeof record.tenantId === "string" ? record.tenantId : "",
    runId: typeof record.runId === "string" ? record.runId : ""
  }
}

const validateStartRequest = Effect.fnUntraced(function*(
  input: unknown
): Effect.fn.Return<DurableStart.Request, InvalidDurableStart> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(invalidStart(
      { tenantId: "", runId: "" },
      `Durable start request must be strict JSON: ${snapped.failure.message}`,
      { snapshotError: snapped.failure.message, path: [...snapped.failure.path] }
    ))
  }
  const key = snapshotKey(snapped.success)
  const attempted = yield* Effect.try({
    try: () => decodeStartRequest(snapped.success),
    catch: () => invalidStart(key, "Durable start request schema validation threw unexpectedly")
  })
  if (Result.isFailure(attempted)) {
    return yield* Effect.fail(invalidStart(key, "Invalid durable start request", {
      parseError: attempted.failure.message
    }))
  }
  const request = snapped.success as unknown as DurableStart.Request
  const artifact = PlanStore.validateArtifact(request.artifact)
  if (Result.isFailure(artifact)) {
    return yield* Effect.fail(invalidStart(key, artifact.failure.message, {
      code: artifact.failure.code,
      ...(artifact.failure.details === undefined ? undefined : { artifact: artifact.failure.details })
    }))
  }
  return request
})

const validateDecisionRequest = Effect.fnUntraced(function*(
  input: unknown
): Effect.fn.Return<DecisionCommitDraft, InvalidDecisionCommit> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(invalidCommit(
      { tenantId: "", runId: "" },
      `Decision commit must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  const key = snapshotKey(snapped.success)
  const attempted = yield* Effect.try({
    try: () => decodeDecisionCommit(snapped.success),
    catch: () => invalidCommit(key, "Decision commit schema validation threw unexpectedly")
  })
  if (Result.isFailure(attempted)) {
    return yield* Effect.fail(invalidCommit(key, "Invalid decision commit", {
      parseError: attempted.failure.message
    }))
  }
  const commit = snapped.success as unknown as DecisionCommitDraft
  if (!Number.isSafeInteger(commit.expectedLastSequence) || commit.expectedLastSequence < 0) {
    return yield* Effect.fail(invalidCommit(
      commit.key,
      "expectedLastSequence must be a non-negative safe integer"
    ))
  }
  if (commit.events.length === 0) {
    return yield* Effect.fail(invalidCommit(commit.key, "events must be a non-empty array"))
  }
  if (commit.expectedLastSequence > Number.MAX_SAFE_INTEGER - commit.events.length) {
    return yield* Effect.fail(invalidCommit(
      commit.key,
      "Decision commit event sequences must remain safe integers"
    ))
  }
  return commit
})

const validateCancellationRequest = Effect.fnUntraced(function*(
  input: unknown
): Effect.fn.Return<CancellationRequest, InvalidCancellationRequest> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(invalidCancellation(
      { tenantId: "", runId: "" },
      `Cancellation request must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  const key = snapshotKey(snapped.success)
  let decoded: ReturnType<typeof decodeCancellationRequest>
  try {
    decoded = decodeCancellationRequest(snapped.success)
  } catch {
    return yield* Effect.fail(invalidCancellation(
      key,
      "Cancellation request schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(invalidCancellation(key, "Invalid cancellation request", {
      parseError: decoded.failure.message
    }))
  }
  return snapped.success as unknown as CancellationRequest
})

const validateRunKey = Effect.fnUntraced(function*(
  operation: "read" | "inspectOutbox",
  input: unknown
): Effect.fn.Return<PlanStore.RunKey, ExecutionStoreFailure> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(storeFailure(
      operation,
      `Run key must be strict JSON: ${snapped.failure.message}`
    ))
  }
  const decoded = decodeRunKey(snapped.success)
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(storeFailure(operation, "Invalid tenant-scoped run key", {
      parseError: decoded.failure.message
    }))
  }
  return snapped.success as unknown as PlanStore.RunKey
})

const runStorageKey = (key: PlanStore.RunKey): string => JSON.stringify([key.tenantId, key.runId])

const intentStorageKey = (tenantId: string, intentId: string): string => JSON.stringify([tenantId, intentId])

const artifactStorageKey = (tenantId: string, artifactDigest: PlanStore.ArtifactDigest): string =>
  JSON.stringify([tenantId, artifactDigest])

const requestStorageKey = (
  tenantId: string,
  workflowIdentity: string,
  requestId: string
): string => JSON.stringify([tenantId, workflowIdentity, requestId])

const deliveryRequestStorageKey = (
  operation: "claimOutbox" | "acquireAttempt" | "renewAttempt",
  tenantId: string,
  requestId: string
): string => JSON.stringify([operation, tenantId, requestId])

const issuedExecutionStorageKey = (
  ref: ActivityDelivery.ActivityLeaseRef
): string =>
  JSON.stringify([
    ref.leaseVersion,
    ref.key.tenantId,
    ref.key.intentId,
    ref.workerId,
    ref.workerDeploymentId,
    ref.deliveryEpoch,
    ref.leaseId
  ])

const cancellationRequestStorageKey = (
  operation: ActivityCancellation.Operation,
  tenantId: string,
  claimantId: string,
  requestId: string
): string => JSON.stringify([operation, tenantId, claimantId, requestId])

const coordinatorRequestStorageKey = (
  operation: RunCoordinator.Operation,
  tenantId: string,
  coordinatorId: string,
  requestId: string
): string => JSON.stringify([operation, tenantId, coordinatorId, requestId])

const currentTimestamp = Effect.fnUntraced(function*(
  operation: "start" | "commitDecision" | "requestCancellation"
): Effect.fn.Return<Event.Timestamp, ExecutionStoreFailure> {
  const now = yield* Effect.catchCause(
    Clock.currentTimeMillis,
    (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(storeFailure(operation, "Clock failed while reading the current time"))
  )
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return yield* Effect.fail(storeFailure(operation, "Clock returned an invalid timestamp"))
  }
  const formatted = yield* Effect.try({
    try: () => DateTime.formatIso(DateTime.makeUnsafe(now)),
    catch: () => storeFailure(operation, "Clock returned an invalid timestamp")
  })
  const decoded = yield* Effect.try({
    try: () => decodeTimestamp(formatted),
    catch: () => storeFailure(operation, "Clock timestamp validation threw unexpectedly")
  })
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(storeFailure(operation, "Clock returned an invalid timestamp", {
      parseError: decoded.failure.message
    }))
  }
  return decoded.success
})

interface StoreTime {
  readonly millis: number
  readonly timestamp: Event.Timestamp
}

const timestampFromMillis = (
  operation: ActivityDelivery.Operation,
  millis: number
): Result.Result<Event.Timestamp, ActivityDelivery.ActivityDeliveryStoreFailure> => {
  try {
    const formatted = DateTime.formatIso(DateTime.makeUnsafe(millis))
    const decoded = decodeTimestamp(formatted)
    return Result.isFailure(decoded)
      ? Result.fail(deliveryFailure(operation, "Clock returned an invalid timestamp", {
        parseError: decoded.failure.message
      }))
      : Result.succeed(decoded.success)
  } catch {
    return Result.fail(deliveryFailure(operation, "Clock returned an invalid timestamp"))
  }
}

const currentDeliveryTime = Effect.fnUntraced(function*(
  operation: ActivityDelivery.Operation
): Effect.fn.Return<StoreTime, ActivityDelivery.ActivityDeliveryStoreFailure> {
  const millis = yield* Effect.catchCause(
    Clock.currentTimeMillis,
    (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(deliveryFailure(operation, "Clock failed while reading the current time"))
  )
  if (typeof millis !== "number" || !Number.isFinite(millis)) {
    return yield* Effect.fail(deliveryFailure(operation, "Clock returned an invalid timestamp"))
  }
  const timestamp = timestampFromMillis(operation, millis)
  if (Result.isFailure(timestamp)) {
    return yield* Effect.fail(timestamp.failure)
  }
  return Object.freeze({ millis, timestamp: timestamp.success })
})

const leaseExpiration = (
  operation: ActivityDelivery.Operation,
  now: StoreTime,
  leaseDurationMillis: number
): Result.Result<
  StoreTime,
  ActivityDelivery.InvalidDeliveryRequest | ActivityDelivery.ActivityDeliveryStoreFailure
> => {
  const millis = now.millis + leaseDurationMillis
  if (!Number.isSafeInteger(millis) || millis <= now.millis) {
    return Result.fail(
      new ActivityDelivery.InvalidDeliveryRequest({
        operation,
        message: "Lease expiration must remain a future safe-integer timestamp"
      })
    )
  }
  const timestamp = timestampFromMillis(operation, millis)
  return Result.isFailure(timestamp)
    ? Result.fail(timestamp.failure)
    : Result.succeed(Object.freeze({ millis, timestamp: timestamp.success }))
}

const cancellationTimestampFromMillis = (
  operation: ActivityCancellation.Operation,
  millis: number
): Result.Result<
  Event.Timestamp,
  ActivityCancellation.ActivityCancellationDeliveryStoreFailure
> => {
  try {
    const formatted = DateTime.formatIso(DateTime.makeUnsafe(millis))
    const decoded = decodeTimestamp(formatted)
    return Result.isFailure(decoded)
      ? Result.fail(cancellationDeliveryFailure(
        operation,
        "Clock returned an invalid timestamp",
        { parseError: decoded.failure.message }
      ))
      : Result.succeed(decoded.success)
  } catch {
    return Result.fail(cancellationDeliveryFailure(
      operation,
      "Clock returned an invalid timestamp"
    ))
  }
}

const currentCancellationTime = Effect.fnUntraced(function*(
  operation: ActivityCancellation.Operation
): Effect.fn.Return<
  StoreTime,
  ActivityCancellation.ActivityCancellationDeliveryStoreFailure
> {
  const millis = yield* Effect.catchCause(
    Clock.currentTimeMillis,
    (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(cancellationDeliveryFailure(
          operation,
          "Clock failed while reading the current time"
        ))
  )
  if (typeof millis !== "number" || !Number.isFinite(millis)) {
    return yield* Effect.fail(cancellationDeliveryFailure(
      operation,
      "Clock returned an invalid timestamp"
    ))
  }
  const timestamp = cancellationTimestampFromMillis(operation, millis)
  if (Result.isFailure(timestamp)) {
    return yield* Effect.fail(timestamp.failure)
  }
  return Object.freeze({ millis, timestamp: timestamp.success })
})

const cancellationLeaseExpiration = (
  operation: ActivityCancellation.Operation,
  now: StoreTime,
  leaseDurationMillis: number
): Result.Result<
  StoreTime,
  | ActivityCancellation.InvalidCancellationDeliveryRequest
  | ActivityCancellation.ActivityCancellationDeliveryStoreFailure
> => {
  const millis = now.millis + leaseDurationMillis
  if (!Number.isSafeInteger(millis) || millis <= now.millis) {
    return Result.fail(
      new ActivityCancellation.InvalidCancellationDeliveryRequest({
        operation,
        message: "Lease expiration must remain a future safe-integer timestamp"
      })
    )
  }
  const timestamp = cancellationTimestampFromMillis(operation, millis)
  return Result.isFailure(timestamp)
    ? Result.fail(timestamp.failure)
    : Result.succeed(Object.freeze({ millis, timestamp: timestamp.success }))
}

const coordinatorTimestampFromMillis = (
  operation: RunCoordinator.Operation,
  millis: number
): Result.Result<Event.Timestamp, RunCoordinator.RunCoordinatorStoreFailure> => {
  try {
    const formatted = DateTime.formatIso(DateTime.makeUnsafe(millis))
    const decoded = decodeTimestamp(formatted)
    return Result.isFailure(decoded)
      ? Result.fail(coordinatorFailure(operation, "Clock returned an invalid timestamp", {
        parseError: decoded.failure.message
      }))
      : Result.succeed(decoded.success)
  } catch {
    return Result.fail(coordinatorFailure(operation, "Clock returned an invalid timestamp"))
  }
}

const currentCoordinatorTime = Effect.fnUntraced(function*(
  operation: RunCoordinator.Operation
): Effect.fn.Return<StoreTime, RunCoordinator.RunCoordinatorStoreFailure> {
  const millis = yield* Effect.catchCause(
    Clock.currentTimeMillis,
    (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(coordinatorFailure(operation, "Clock failed while reading the current time"))
  )
  if (typeof millis !== "number" || !Number.isFinite(millis)) {
    return yield* Effect.fail(coordinatorFailure(operation, "Clock returned an invalid timestamp"))
  }
  const timestamp = coordinatorTimestampFromMillis(operation, millis)
  if (Result.isFailure(timestamp)) {
    return yield* Effect.fail(timestamp.failure)
  }
  return Object.freeze({ millis, timestamp: timestamp.success })
})

const coordinatorLeaseExpiration = (
  operation: RunCoordinator.Operation,
  now: StoreTime,
  leaseDurationMillis: number
): Result.Result<
  StoreTime,
  RunCoordinator.InvalidCoordinatorRequest | RunCoordinator.RunCoordinatorStoreFailure
> => {
  const millis = now.millis + leaseDurationMillis
  if (!Number.isSafeInteger(millis) || millis <= now.millis) {
    return Result.fail(
      new RunCoordinator.InvalidCoordinatorRequest({
        operation,
        message: "Lease expiration must remain a future safe-integer timestamp"
      })
    )
  }
  const timestamp = coordinatorTimestampFromMillis(operation, millis)
  return Result.isFailure(timestamp)
    ? Result.fail(timestamp.failure)
    : Result.succeed(Object.freeze({ millis, timestamp: timestamp.success }))
}

const materializeEvent = (
  runId: string,
  sequence: number,
  recordedAt: Event.Timestamp,
  draft: HistoryStore.EventDraft
): Event.Event =>
  Object.freeze({
    eventVersion: draft.eventVersion,
    eventId: draft.eventId,
    runId,
    sequence,
    recordedAt,
    ...(draft.causationId === undefined ? undefined : { causationId: draft.causationId }),
    ...(draft.correlationId === undefined ? undefined : { correlationId: draft.correlationId }),
    payload: draft.payload
  })

const eventConflict = (
  runId: string,
  eventId: string,
  existingSequence: number,
  requestedSequence: number
): HistoryStore.EventIdConflict =>
  new HistoryStore.EventIdConflict({ runId, eventId, existingSequence, requestedSequence })

const intentConflict = (
  key: PlanStore.RunKey,
  intentId: string,
  existing: StoredDispatch,
  requestedSourceSequence: number
): DispatchIntentIdConflict =>
  new DispatchIntentIdConflict({
    tenantId: key.tenantId,
    runId: key.runId,
    existingRunId: existing.dispatch.runId,
    intentId,
    existingSourceSequence: existing.dispatch.sourceEventSequence,
    requestedSourceSequence
  })

const validatePairing = (
  commit: DecisionCommitDraft
): Result.Result<ValidatedPairing, InvalidDecisionCommit> => {
  const eventPositionById = new Map<string, number>()
  const scheduleIds: Array<string> = []
  for (let position = 0; position < commit.events.length; position++) {
    const event = commit.events[position]!
    if (eventPositionById.has(event.eventId)) {
      return Result.fail(invalidCommit(
        commit.key,
        `Duplicate event id '${event.eventId}' in one decision commit`
      ))
    }
    eventPositionById.set(event.eventId, position)
    if (event.payload._tag === "ActivityScheduled") {
      scheduleIds.push(event.eventId)
    }
  }

  const intentIds = new Set<string>()
  const sourceIds = new Set<string>()
  for (let position = 0; position < commit.dispatches.length; position++) {
    const dispatch = commit.dispatches[position]!
    if (intentIds.has(dispatch.intentId)) {
      return Result.fail(invalidCommit(
        commit.key,
        `Duplicate dispatch intent id '${dispatch.intentId}' in one decision commit`
      ))
    }
    if (sourceIds.has(dispatch.sourceEventId)) {
      return Result.fail(invalidCommit(
        commit.key,
        `Source event '${dispatch.sourceEventId}' has more than one dispatch intent`
      ))
    }
    intentIds.add(dispatch.intentId)
    sourceIds.add(dispatch.sourceEventId)

    if (
      dispatch.intentId !== dispatch.command.commandId ||
      dispatch.sourceEventId !== dispatch.command.commandId
    ) {
      return Result.fail(invalidCommit(
        commit.key,
        "Dispatch intentId, sourceEventId, and commandId must be identical",
        {
          intentId: dispatch.intentId,
          sourceEventId: dispatch.sourceEventId,
          commandId: dispatch.command.commandId
        }
      ))
    }

    const eventPosition = eventPositionById.get(dispatch.sourceEventId)
    if (eventPosition === undefined) {
      return Result.fail(invalidCommit(
        commit.key,
        `Dispatch '${dispatch.intentId}' has no source event in the same commit`
      ))
    }
    const event = commit.events[eventPosition]!
    if (event.payload._tag !== "ActivityScheduled") {
      return Result.fail(invalidCommit(
        commit.key,
        `Dispatch '${dispatch.intentId}' source event is not ActivityScheduled`
      ))
    }
    const converted = CommandEvent.fromCommand(dispatch.command)
    if (Result.isFailure(converted)) {
      return Result.fail(invalidCommit(
        commit.key,
        `Dispatch '${dispatch.intentId}' command cannot be converted to a semantic event`,
        { commandError: converted.failure.message }
      ))
    }
    if (
      Json.canonicalizeSnapshot(converted.success as unknown as Schema.Json) !==
        Json.canonicalizeSnapshot(event as unknown as Schema.Json)
    ) {
      return Result.fail(invalidCommit(
        commit.key,
        `Dispatch '${dispatch.intentId}' does not exactly match its source event`
      ))
    }
  }

  if (
    scheduleIds.length !== commit.dispatches.length ||
    scheduleIds.some((eventId, position) => commit.dispatches[position]?.sourceEventId !== eventId)
  ) {
    return Result.fail(invalidCommit(
      commit.key,
      "Every ActivityScheduled event must have exactly one dispatch in source-event order"
    ))
  }

  return Result.succeed({ eventPositionById })
}

const canonicalizeEvents = (
  events: Arr.NonEmptyReadonlyArray<HistoryStore.EventDraft>
): Arr.NonEmptyReadonlyArray<string> =>
  Object.freeze(
    events.map((event) => Json.canonicalizeSnapshot(event as unknown as Schema.Json))
  ) as Arr.NonEmptyReadonlyArray<string>

const canonicalizeDispatches = (
  dispatches: ReadonlyArray<ActivityDispatchDraft>
): ReadonlyArray<string> =>
  Object.freeze(
    dispatches.map((dispatch) => Json.canonicalizeSnapshot(dispatch as unknown as Schema.Json))
  )

const resolveDecisionRetry = (
  state: MemoryState,
  run: StoredRun | undefined,
  commit: DecisionCommitDraft,
  canonicalEvents: Arr.NonEmptyReadonlyArray<string>,
  canonicalDispatches: ReadonlyArray<string>,
  canonicalCommit: string
): Result.Result<
  DecisionCommitReceipt | undefined,
  HistoryStore.EventIdConflict | DispatchIntentIdConflict | DecisionCommitConflict
> => {
  let anchor: StoredBatch | undefined
  if (run !== undefined) {
    for (const event of commit.events) {
      const existing = Option.getOrUndefined(HashMap.get(run.byEventId, event.eventId))
      if (existing !== undefined) {
        anchor = existing.batch
        break
      }
    }
  }
  if (anchor === undefined) {
    for (const dispatch of commit.dispatches) {
      const existing = Option.getOrUndefined(
        HashMap.get(state.byIntentId, intentStorageKey(commit.key.tenantId, dispatch.intentId))
      )
      if (existing !== undefined) {
        anchor = existing.batch
        break
      }
    }
  }
  if (anchor === undefined) {
    return Result.succeed(undefined)
  }

  const exactEvents = run !== undefined &&
    anchor.kind === "Decision" &&
    anchor.previousSequence === commit.expectedLastSequence &&
    anchor.canonicalEvents.length === canonicalEvents.length &&
    canonicalEvents.every((canonical, position) => {
      const existing = Option.getOrUndefined(HashMap.get(run.byEventId, commit.events[position]!.eventId))
      return anchor.canonicalEvents[position] === canonical &&
        existing?.batch === anchor &&
        existing.position === position
    })
  const exactDispatches = anchor.canonicalDispatches.length === canonicalDispatches.length &&
    canonicalDispatches.every((canonical, position) => {
      const existing = Option.getOrUndefined(
        HashMap.get(
          state.byIntentId,
          intentStorageKey(commit.key.tenantId, commit.dispatches[position]!.intentId)
        )
      )
      return anchor.canonicalDispatches[position] === canonical &&
        existing?.batch === anchor &&
        existing.position === position
    })
  if (
    exactEvents &&
    exactDispatches &&
    anchor.canonicalCommit === canonicalCommit &&
    anchor.decisionReceipt !== undefined
  ) {
    return Result.succeed(anchor.decisionReceipt)
  }

  if (exactEvents) {
    return Result.fail(
      new DecisionCommitConflict({
        tenantId: commit.key.tenantId,
        runId: commit.key.runId,
        expectedLastSequence: commit.expectedLastSequence,
        existingPreviousSequence: anchor.previousSequence ?? 0,
        message: "Existing decision event identities have different complete dispatch content"
      })
    )
  }

  if (!exactEvents && run !== undefined) {
    for (let position = 0; position < commit.events.length; position++) {
      const event = commit.events[position]!
      const existing = Option.getOrUndefined(HashMap.get(run.byEventId, event.eventId))
      if (
        existing !== undefined &&
        (
          existing.batch !== anchor ||
          existing.position !== position ||
          anchor.canonicalEvents[position] !== canonicalEvents[position]
        )
      ) {
        return Result.fail(eventConflict(
          commit.key.runId,
          event.eventId,
          existing.event.sequence,
          commit.expectedLastSequence + 1 + position
        ))
      }
    }
    const firstOverlapPosition = commit.events.findIndex((event) => HashMap.has(run.byEventId, event.eventId))
    if (firstOverlapPosition !== -1) {
      const event = commit.events[firstOverlapPosition]!
      const existing = Option.getOrUndefined(HashMap.get(run.byEventId, event.eventId))!
      return Result.fail(eventConflict(
        commit.key.runId,
        event.eventId,
        existing.event.sequence,
        commit.expectedLastSequence + 1 + firstOverlapPosition
      ))
    }
  }

  for (let position = 0; position < commit.dispatches.length; position++) {
    const dispatch = commit.dispatches[position]!
    const existing = Option.getOrUndefined(
      HashMap.get(state.byIntentId, intentStorageKey(commit.key.tenantId, dispatch.intentId))
    )
    if (existing !== undefined) {
      const eventPosition = commit.events.findIndex((event) => event.eventId === dispatch.sourceEventId)
      return Result.fail(intentConflict(
        commit.key,
        dispatch.intentId,
        existing,
        commit.expectedLastSequence + 1 + eventPosition
      ))
    }
  }

  return Result.fail(
    new DecisionCommitConflict({
      tenantId: commit.key.tenantId,
      runId: commit.key.runId,
      expectedLastSequence: commit.expectedLastSequence,
      existingPreviousSequence: anchor.previousSequence ?? 0,
      message: "Existing decision event identities have different complete dispatch content"
    })
  )
}

const makeStartBatch = (
  runId: string,
  recordedAt: Event.Timestamp,
  draft: HistoryStore.EventDraft<Event.RunStarted>,
  canonicalEvent: string
): StoredBatch => {
  const event = materializeEvent(runId, 0, recordedAt, draft)
  const receipt: HistoryStore.CommitReceipt = Object.freeze({
    runId,
    previousSequence: null,
    lastSequence: 0,
    events: Object.freeze([event]) as Arr.NonEmptyReadonlyArray<Event.Event>
  })
  return Object.freeze({
    kind: "Start",
    previousSequence: null,
    canonicalEvents: Object.freeze([canonicalEvent]) as Arr.NonEmptyReadonlyArray<string>,
    canonicalDispatches: Object.freeze([]),
    canonicalCommit: canonicalEvent,
    historyReceipt: receipt
  })
}

const makeDecisionBatch = (
  commit: DecisionCommitDraft,
  pairing: ValidatedPairing,
  recordedAt: Event.Timestamp,
  canonicalEvents: Arr.NonEmptyReadonlyArray<string>,
  canonicalDispatches: ReadonlyArray<string>,
  canonicalCommit: string
): {
  readonly batch: StoredBatch
  readonly events: Arr.NonEmptyReadonlyArray<Event.Event>
  readonly dispatches: ReadonlyArray<ActivityDispatch>
} => {
  const firstSequence = commit.expectedLastSequence + 1
  const events = Object.freeze(
    commit.events.map((event, position) =>
      materializeEvent(commit.key.runId, firstSequence + position, recordedAt, event)
    )
  ) as Arr.NonEmptyReadonlyArray<Event.Event>
  const dispatches = Object.freeze(commit.dispatches.map((draft) => {
    const eventPosition = pairing.eventPositionById.get(draft.sourceEventId)!
    return Object.freeze({
      dispatchVersion: draft.dispatchVersion,
      _tag: draft._tag,
      intentId: draft.intentId,
      sourceEventId: draft.sourceEventId,
      tenantId: commit.key.tenantId,
      runId: commit.key.runId,
      sourceEventSequence: firstSequence + eventPosition,
      enqueuedAt: recordedAt,
      command: draft.command,
      target: draft.target
    })
  }))
  const dispatchReceipts = Object.freeze(dispatches.map((dispatch) =>
    Object.freeze({
      intentId: dispatch.intentId,
      sourceEventId: dispatch.sourceEventId,
      sourceEventSequence: dispatch.sourceEventSequence,
      enqueuedAt: dispatch.enqueuedAt
    })
  ))
  const decisionReceipt: DecisionCommitReceipt = Object.freeze({
    runId: commit.key.runId,
    previousSequence: commit.expectedLastSequence,
    lastSequence: firstSequence + events.length - 1,
    events,
    dispatches: dispatchReceipts
  })
  const batch: StoredBatch = Object.freeze({
    kind: "Decision",
    previousSequence: commit.expectedLastSequence,
    canonicalEvents,
    canonicalDispatches,
    canonicalCommit,
    historyReceipt: decisionReceipt,
    decisionReceipt
  })
  return { batch, events, dispatches }
}

const materializeStartDraft = (
  request: DurableStart.Request
): HistoryStore.EventDraft<Event.RunStarted> => {
  const plan = request.artifact.fingerprintDocument.plan
  return Object.freeze({
    eventVersion: 1,
    eventId: Identity.runStartedEventId(request.key.runId),
    payload: Object.freeze({
      _tag: "RunStarted",
      planId: plan.id,
      planRevision: plan.revision,
      definitionId: plan.definition.id,
      definitionVersion: plan.definition.version,
      compilerVersion: request.artifact.fingerprintDocument.compilerSemanticVersion,
      compiledFingerprint: request.artifact.compiledFingerprint,
      backend: "durable",
      input: request.input
    })
  })
}

const resolveStartAdmission = (
  state: MemoryState,
  request: DurableStart.Request,
  canonicalArtifact: string,
  canonicalInput: string
): Result.Result<
  StartReceipt | undefined,
  StartRequestConflict | RunKeyConflict | ArtifactDigestCollision
> => {
  const storedArtifact = Option.getOrUndefined(
    HashMap.get(state.artifacts, artifactStorageKey(request.key.tenantId, request.artifactDigest))
  )
  if (
    storedArtifact !== undefined &&
    storedArtifact.canonicalArtifact !== canonicalArtifact
  ) {
    return Result.fail(
      new ArtifactDigestCollision({
        tenantId: request.key.tenantId,
        artifactDigest: request.artifactDigest
      })
    )
  }

  const storedRequest = Option.getOrUndefined(HashMap.get(
    state.requests,
    requestStorageKey(request.key.tenantId, request.workflowIdentity, request.requestId)
  ))
  if (storedRequest !== undefined) {
    if (
      storedRequest.artifactDigest === request.artifactDigest &&
      storedRequest.canonicalInput === canonicalInput
    ) {
      return Result.succeed(storedRequest.receipt)
    }
    return Result.fail(
      new StartRequestConflict({
        tenantId: request.key.tenantId,
        workflowIdentity: request.workflowIdentity,
        requestId: request.requestId,
        existingRunId: storedRequest.key.runId,
        requestedRunId: request.key.runId,
        existingArtifactDigest: storedRequest.artifactDigest,
        requestedArtifactDigest: request.artifactDigest
      })
    )
  }

  const binding = Option.getOrUndefined(
    HashMap.get(state.bindings, runStorageKey(request.key))
  )
  if (binding !== undefined) {
    return Result.fail(
      new RunKeyConflict({
        tenantId: request.key.tenantId,
        runId: request.key.runId,
        existingWorkflowIdentity: binding.workflowIdentity,
        requestedWorkflowIdentity: request.workflowIdentity,
        existingRequestId: binding.requestId,
        requestedRequestId: request.requestId,
        existingArtifactDigest: binding.artifactDigest,
        requestedArtifactDigest: request.artifactDigest
      })
    )
  }
  return Result.succeed(undefined)
}

const validateDispatchTargets = (
  commit: DecisionCommitDraft,
  artifact: PlanStore.PlanArtifact
): Result.Result<void, DispatchTargetConflict> => {
  for (const dispatch of commit.dispatches) {
    const nodeId = dispatch.command.payload.nodeId
    const expected = Object.prototype.hasOwnProperty.call(artifact.dispatchTargets, nodeId)
      ? artifact.dispatchTargets[nodeId]
      : undefined
    if (
      expected === undefined ||
      expected.queue !== dispatch.target.queue ||
      expected.deploymentId !== dispatch.target.deploymentId
    ) {
      return Result.fail(
        new DispatchTargetConflict({
          tenantId: commit.key.tenantId,
          runId: commit.key.runId,
          nodeId,
          intentId: dispatch.intentId,
          ...(expected === undefined ? undefined : { expected }),
          requested: dispatch.target
        })
      )
    }
  }
  return Result.succeed(undefined)
}

/**
 * The execution and plan services backed by one process-local memory state.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemoryServices {
  readonly executionStore: ExecutionStore.Service
  readonly planStore: PlanStore.PlanStore.Service
  readonly activityDeliveryStore: ActivityDelivery.ActivityDeliveryStore.Service
  readonly activityCancellationDeliveryStore: ActivityCancellation.ActivityCancellationDeliveryStore.Service
  readonly runCoordinatorStore: RunCoordinator.RunCoordinatorStore["Service"]
}

/**
 * Constructs an isolated process-local execution and plan store.
 *
 * **Details**
 *
 * History and immutable dispatch intents share one `Ref` mutation, making this a
 * semantic reference model for atomic commits. The implementation has one
 * in-process scope and loses all state on process exit. Its delivery service is
 * a semantic reference for relay leases, worker fences, and atomic completion;
 * it is not a persistent broker or cross-process implementation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory: Effect.Effect<Readonly<MemoryServices>, never, Crypto.Crypto> = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto
  const state = yield* Ref.make<MemoryState>(Object.freeze({
    runs: HashMap.empty(),
    byIntentId: HashMap.empty(),
    artifacts: HashMap.empty(),
    bindings: HashMap.empty(),
    requests: HashMap.empty(),
    relayRequests: HashMap.empty(),
    activityRequests: HashMap.empty(),
    renewalRequests: HashMap.empty(),
    issuedExecutions: HashMap.empty(),
    cancellationTargets: HashMap.empty(),
    cancellations: HashMap.empty(),
    cancellationClaimRequests: HashMap.empty(),
    cancellationAckRequests: HashMap.empty(),
    cancellationReleaseRequests: HashMap.empty(),
    coordinatorClaimRequests: HashMap.empty(),
    coordinatorRenewalRequests: HashMap.empty(),
    coordinatorReleaseRequests: HashMap.empty(),
    coordinatorIdleRequests: HashMap.empty(),
    coordinatorCommitRequests: HashMap.empty(),
    coordinatorClaimCursors: HashMap.empty()
  }))

  const digest = Effect.fnUntraced(function*(
    operation: "start" | "commitDecision",
    subject: string,
    value: Schema.Json
  ): Effect.fn.Return<Fingerprint.Digest, ExecutionStoreFailure> {
    const computed = yield* Fingerprint.digest(value).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(storeFailure(operation, `Crypto failed while hashing ${subject}`))
      )
    )
    const decoded = yield* Effect.try({
      try: () => decodeFingerprintDigest(computed),
      catch: () => storeFailure(operation, `Crypto returned an invalid ${subject} digest`)
    })
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(storeFailure(operation, `Crypto returned an invalid ${subject} digest`, {
        parseError: decoded.failure.message
      }))
    }
    return decoded.success
  })

  const makeLeaseId = Effect.fnUntraced(function*(
    operation: ActivityDelivery.Operation
  ): Effect.fn.Return<string, ActivityDelivery.ActivityDeliveryStoreFailure> {
    const bytes = yield* crypto.randomBytes(32).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(deliveryFailure(operation, "Crypto failed while creating a lease capability"))
      )
    )
    return yield* Effect.try({
      try: () => {
        const encoded = Encoding.encodeHex(bytes)
        if (bytes.byteLength !== 32 || !/^[0-9a-f]{64}$/.test(encoded)) {
          throw new TypeError("Invalid random capability bytes")
        }
        return `lease:v1:${encoded}`
      },
      catch: () => deliveryFailure(operation, "Crypto returned invalid lease capability bytes")
    })
  })

  const makeCancellationLeaseId = Effect.fnUntraced(function*(
    operation: ActivityCancellation.Operation,
    uniqueness: string
  ): Effect.fn.Return<
    string,
    ActivityCancellation.ActivityCancellationDeliveryStoreFailure
  > {
    const bytes = yield* crypto.randomBytes(32).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(cancellationDeliveryFailure(
            operation,
            "Crypto failed while creating a cancellation lease capability"
          ))
      )
    )
    return yield* Effect.try({
      try: () => {
        const encoded = Encoding.encodeHex(bytes)
        if (bytes.byteLength !== 32 || !/^[0-9a-f]{64}$/.test(encoded)) {
          throw new TypeError("Invalid random capability bytes")
        }
        return `cancellation-lease:v1:${encoded}:${uniqueness}`
      },
      catch: () =>
        cancellationDeliveryFailure(
          operation,
          "Crypto returned invalid cancellation lease capability bytes"
        )
    })
  })

  const makeCoordinatorLeaseId = Effect.fnUntraced(function*(
    operation: RunCoordinator.Operation
  ): Effect.fn.Return<string, RunCoordinator.RunCoordinatorStoreFailure> {
    const bytes = yield* crypto.randomBytes(32).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(coordinatorFailure(operation, "Crypto failed while creating a lease capability"))
      )
    )
    return yield* Effect.try({
      try: () => {
        const encoded = Encoding.encodeHex(bytes)
        if (bytes.byteLength !== 32 || !/^[0-9a-f]{64}$/.test(encoded)) {
          throw new TypeError("Invalid random capability bytes")
        }
        return `run-lease:v1:${encoded}`
      },
      catch: () => coordinatorFailure(operation, "Crypto returned invalid lease capability bytes")
    })
  })

  const start: ExecutionStore.Service["start"] = Effect.fnUntraced(function*(input) {
    if (!DurableStart.isPrepared(input)) {
      return yield* Effect.fail(invalidStart(
        { tenantId: "", runId: "" },
        "Durable start requires the exact result of DurableStart.prepare"
      ))
    }
    const request = yield* validateStartRequest(input.wire)
    const canonicalArtifact = Json.canonicalizeSnapshot(request.artifact as unknown as Schema.Json)
    const canonicalInput = Json.canonicalizeSnapshot(request.input as unknown as Schema.Json)
    const draft = materializeStartDraft(request)
    const canonicalEvent = Json.canonicalizeSnapshot(draft as unknown as Schema.Json)
    const early = resolveStartAdmission(yield* Ref.get(state), request, canonicalArtifact, canonicalInput)
    if (Result.isFailure(early)) {
      return yield* Effect.fail(early.failure)
    }
    if (early.success !== undefined) {
      return early.success
    }

    const computedFingerprint = yield* digest(
      "start",
      "compiled fingerprint",
      request.artifact.fingerprintDocument as unknown as Schema.Json
    )
    if (computedFingerprint !== request.artifact.compiledFingerprint) {
      return yield* Effect.fail(
        new CompiledFingerprintMismatch({
          tenantId: request.key.tenantId,
          runId: request.key.runId,
          declared: request.artifact.compiledFingerprint,
          computed: computedFingerprint
        })
      )
    }
    const rawArtifactDigest = yield* digest(
      "start",
      "plan artifact",
      request.artifact as unknown as Schema.Json
    )
    const decodedArtifactDigest = decodeArtifactDigest(rawArtifactDigest)
    if (Result.isFailure(decodedArtifactDigest)) {
      return yield* Effect.fail(storeFailure("start", "Crypto returned an invalid plan artifact digest", {
        parseError: decodedArtifactDigest.failure.message
      }))
    }
    const computedArtifactDigest = decodedArtifactDigest.success
    if (computedArtifactDigest !== request.artifactDigest) {
      return yield* Effect.fail(
        new ArtifactDigestMismatch({
          tenantId: request.key.tenantId,
          runId: request.key.runId,
          declared: request.artifactDigest,
          computed: computedArtifactDigest
        })
      )
    }

    const recordedAt = yield* currentTimestamp("start")
    const batch = makeStartBatch(request.key.runId, recordedAt, draft, canonicalEvent)
    const binding: PlanStore.RunBinding = Object.freeze({
      bindingVersion: 1,
      executionProtocolVersion: 1,
      key: request.key,
      artifactDigest: request.artifactDigest,
      workflowIdentity: request.workflowIdentity,
      requestId: request.requestId,
      runStartedEventId: draft.eventId
    })
    const receipt: StartReceipt = Object.freeze({
      key: request.key,
      artifactDigest: request.artifactDigest,
      binding,
      historyReceipt: batch.historyReceipt
    })

    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<
        StartReceipt,
        StartRequestConflict | RunKeyConflict | ArtifactDigestCollision
      >,
      MemoryState
    ] => {
      const admission = resolveStartAdmission(current, request, canonicalArtifact, canonicalInput)
      if (Result.isFailure(admission)) {
        return [Result.fail(admission.failure), current]
      }
      if (admission.success !== undefined) {
        return [Result.succeed(admission.success), current]
      }
      const storedEvent: StoredEvent = Object.freeze({
        event: batch.historyReceipt.events[0],
        batch,
        position: 0
      })
      const storedRun: StoredRun = Object.freeze({
        events: Chunk.fromIterable(batch.historyReceipt.events),
        byEventId: HashMap.make([draft.eventId, storedEvent]),
        outbox: Chunk.empty(),
        needsDecision: true,
        coordinator: Object.freeze({ epoch: 0 })
      })
      const artifactKey = artifactStorageKey(request.key.tenantId, request.artifactDigest)
      const artifacts = HashMap.has(current.artifacts, artifactKey)
        ? current.artifacts
        : HashMap.set(
          current.artifacts,
          artifactKey,
          Object.freeze({
            artifact: request.artifact,
            canonicalArtifact
          })
        )
      return [
        Result.succeed(receipt),
        Object.freeze({
          runs: HashMap.set(current.runs, runStorageKey(request.key), storedRun),
          byIntentId: current.byIntentId,
          artifacts,
          bindings: HashMap.set(current.bindings, runStorageKey(request.key), binding),
          requests: HashMap.set(
            current.requests,
            requestStorageKey(request.key.tenantId, request.workflowIdentity, request.requestId),
            Object.freeze({
              key: request.key,
              artifactDigest: request.artifactDigest,
              canonicalInput,
              receipt
            })
          ),
          relayRequests: current.relayRequests,
          activityRequests: current.activityRequests,
          renewalRequests: current.renewalRequests,
          issuedExecutions: current.issuedExecutions,
          cancellationTargets: current.cancellationTargets,
          cancellations: current.cancellations,
          cancellationClaimRequests: current.cancellationClaimRequests,
          cancellationAckRequests: current.cancellationAckRequests,
          cancellationReleaseRequests: current.cancellationReleaseRequests,
          coordinatorClaimRequests: current.coordinatorClaimRequests,
          coordinatorRenewalRequests: current.coordinatorRenewalRequests,
          coordinatorReleaseRequests: current.coordinatorReleaseRequests,
          coordinatorIdleRequests: current.coordinatorIdleRequests,
          coordinatorCommitRequests: current.coordinatorCommitRequests,
          coordinatorClaimCursors: current.coordinatorClaimCursors
        })
      ]
    })
    return yield* Effect.fromResult(result)
  })

  const sameRunLeaseRef = (
    left: RunCoordinator.RunLeaseRef,
    right: RunCoordinator.RunLeaseRef
  ): boolean =>
    left.key.tenantId === right.key.tenantId &&
    left.key.runId === right.key.runId &&
    left.coordinatorId === right.coordinatorId &&
    left.coordinatorEpoch === right.coordinatorEpoch &&
    left.leaseId === right.leaseId

  const commitDecisionInternal = Effect.fnUntraced(function*(
    input: DecisionCommitDraft,
    fence: CoordinatorCommitFence
  ) {
    const exact = Option.getOrUndefined(HashMap.get(
      (yield* Ref.get(state)).coordinatorCommitRequests,
      fence.requestKey
    ))
    if (exact !== undefined) {
      return exact.canonicalRequest === fence.canonicalRequest
        ? exact.receipt
        : yield* Effect.fail(
          new RunCoordinator.CoordinatorRequestConflict({
            operation: "commitDecision",
            coordinatorId: fence.coordinatorId,
            requestId: fence.requestId
          })
        )
    }
    const commit = yield* validateDecisionRequest(input)
    const pairing = validatePairing(commit)
    if (Result.isFailure(pairing)) {
      return yield* Effect.fail(pairing.failure)
    }
    const canonicalEvents = canonicalizeEvents(commit.events)
    const canonicalDispatches = canonicalizeDispatches(commit.dispatches)
    const canonicalCommit = Json.canonicalizeSnapshot(commit as unknown as Schema.Json)
    const storageKey = runStorageKey(commit.key)

    const earlyState = yield* Ref.get(state)
    const earlyRun = Option.getOrUndefined(HashMap.get(earlyState.runs, storageKey))
    if (earlyRun === undefined) {
      return yield* Effect.fail(new RunNotFound(commit.key))
    }
    const binding = Option.getOrUndefined(HashMap.get(earlyState.bindings, storageKey))
    const artifact = binding === undefined
      ? undefined
      : Option.getOrUndefined(
        HashMap.get(earlyState.artifacts, artifactStorageKey(commit.key.tenantId, binding.artifactDigest))
      )?.artifact
    if (binding === undefined || artifact === undefined) {
      return yield* Effect.fail(storeFailure(
        "commitDecision",
        "Run history is missing its immutable plan binding or artifact"
      ))
    }
    const targets = validateDispatchTargets(commit, artifact)
    if (Result.isFailure(targets)) {
      return yield* Effect.fail(targets.failure)
    }

    if (
      earlyRun.coordinator.lease === undefined ||
      !sameRunLeaseRef(earlyRun.coordinator.lease.ref, fence.ref)
    ) {
      return yield* Effect.fail(
        new RunCoordinator.StaleRunLease({
          key: fence.ref.key,
          coordinatorId: fence.ref.coordinatorId,
          coordinatorEpoch: fence.ref.coordinatorEpoch
        })
      )
    }
    const earlyLastSequence = Chunk.size(earlyRun.events) - 1
    if (commit.expectedLastSequence !== earlyLastSequence) {
      return yield* Effect.fail(
        new HistoryStore.SequenceConflict({
          runId: commit.key.runId,
          expectedLastSequence: commit.expectedLastSequence,
          actualLastSequence: earlyLastSequence
        })
      )
    }

    const recordedAt = yield* currentTimestamp("commitDecision")
    const prospective = makeDecisionBatch(
      commit,
      pairing.success,
      recordedAt,
      canonicalEvents,
      canonicalDispatches,
      canonicalCommit
    )
    const folded = RunState.fold([
      ...Chunk.toReadonlyArray(earlyRun.events),
      ...prospective.events
    ])
    if (Result.isFailure(folded)) {
      return yield* Effect.fail(invalidCommit(
        commit.key,
        `Decision commit would create invalid semantic history: ${folded.failure.message}`,
        {
          code: folded.failure.code,
          ...(folded.failure.historyIndex === undefined
            ? undefined
            : { historyIndex: folded.failure.historyIndex }),
          ...(folded.failure.details === undefined ? undefined : { cause: folded.failure.details })
        }
      ))
    }
    const dispatchDigests = yield* Effect.forEach(
      prospective.dispatches,
      (dispatch) =>
        digest(
          "commitDecision",
          `activity dispatch '${dispatch.intentId}'`,
          dispatch as unknown as Schema.Json
        ),
      { concurrency: 1 }
    )
    const fenceNow = yield* currentCoordinatorTime("commitDecision")
    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<
        DecisionCommitReceipt,
        | RunNotFound
        | HistoryStore.SequenceConflict
        | HistoryStore.EventIdConflict
        | DispatchIntentIdConflict
        | DecisionCommitConflict
        | RunCoordinator.CoordinatorError
      >,
      MemoryState
    ] => {
      const run = Option.getOrUndefined(HashMap.get(current.runs, storageKey))
      const exact = Option.getOrUndefined(HashMap.get(
        current.coordinatorCommitRequests,
        fence.requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === fence.canonicalRequest
          ? [Result.succeed(exact.receipt), current]
          : [
            Result.fail(
              new RunCoordinator.CoordinatorRequestConflict({
                operation: "commitDecision",
                coordinatorId: fence.coordinatorId,
                requestId: fence.requestId
              })
            ),
            current
          ]
      }
      if (run === undefined) {
        return [Result.fail(new RunNotFound(commit.key)), current]
      }
      if (
        run.coordinator.lease === undefined ||
        !sameRunLeaseRef(run.coordinator.lease.ref, fence.ref) ||
        run.coordinator.expiresAtMillis === undefined ||
        run.coordinator.expiresAtMillis <= fenceNow.millis
      ) {
        return [
          Result.fail(
            new RunCoordinator.StaleRunLease({
              key: fence.ref.key,
              coordinatorId: fence.ref.coordinatorId,
              coordinatorEpoch: fence.ref.coordinatorEpoch
            })
          ),
          current
        ]
      }
      const retry = resolveDecisionRetry(
        current,
        run,
        commit,
        canonicalEvents,
        canonicalDispatches,
        canonicalCommit
      )
      if (Result.isFailure(retry)) {
        return [Result.fail(retry.failure), current]
      }
      if (retry.success !== undefined) {
        return [Result.succeed(retry.success), current]
      }
      if (run === undefined) {
        return [Result.fail(new RunNotFound(commit.key)), current]
      }
      const actualLastSequence = Chunk.size(run.events) - 1
      if (commit.expectedLastSequence !== actualLastSequence) {
        return [
          Result.fail(
            new HistoryStore.SequenceConflict({
              runId: commit.key.runId,
              expectedLastSequence: commit.expectedLastSequence,
              actualLastSequence
            })
          ),
          current
        ]
      }

      const made = prospective
      let byEventId = run.byEventId
      made.events.forEach((event, position) => {
        byEventId = HashMap.set(
          byEventId,
          event.eventId,
          Object.freeze({ event, batch: made.batch, position })
        )
      })
      let byIntentId = current.byIntentId
      made.dispatches.forEach((dispatch, position) => {
        byIntentId = HashMap.set(
          byIntentId,
          intentStorageKey(commit.key.tenantId, dispatch.intentId),
          Object.freeze({
            dispatch,
            dispatchDigest: dispatchDigests[position]!,
            batch: made.batch,
            position,
            relay: Object.freeze({ epoch: 0, status: "Pending" }),
            activity: Object.freeze({ epoch: 0 })
          })
        )
      })
      if (
        folded.success.status === "Succeeded" ||
        folded.success.status === "Failed" ||
        folded.success.status === "Cancelled"
      ) {
        for (const [intentKey, stored] of HashMap.entries(byIntentId)) {
          if (
            stored.dispatch.tenantId === commit.key.tenantId &&
            stored.dispatch.runId === commit.key.runId &&
            stored.activity.completion === undefined
          ) {
            byIntentId = HashMap.set(
              byIntentId,
              intentKey,
              Object.freeze({
                ...stored,
                relay: Object.freeze({
                  ...stored.relay,
                  status: "Suppressed" as const
                })
              })
            )
          }
        }
      }
      let cancellationIndexes: CancellationIndexes = {
        cancellationTargets: current.cancellationTargets,
        cancellations: current.cancellations
      }
      if (
        folded.success.status === "Succeeded" ||
        folded.success.status === "Failed" ||
        folded.success.status === "Cancelled"
      ) {
        const terminalEvent = made.events.find((candidate) =>
          candidate.payload._tag === "RunSucceeded" ||
          candidate.payload._tag === "RunFailed" ||
          candidate.payload._tag === "RunCancelled"
        )
        if (terminalEvent !== undefined) {
          cancellationIndexes = enqueueCancellationsForRun(
            current,
            commit.key,
            terminalEvent.eventId,
            terminalEvent.eventId,
            "RunTerminal",
            terminalEvent.recordedAt
          )
        }
      }
      const storedRun: StoredRun = Object.freeze({
        events: Chunk.appendAll(run.events, Chunk.fromIterable(made.events)),
        byEventId,
        outbox: Chunk.appendAll(run.outbox, Chunk.fromIterable(made.dispatches)),
        needsDecision: false,
        coordinator: Object.freeze({
          epoch: run.coordinator.epoch,
          ...(run.coordinator.lastClaimOrder === undefined
            ? undefined
            : { lastClaimOrder: run.coordinator.lastClaimOrder })
        }),
        ...(run.cancellationReceipt === undefined
          ? undefined
          : { cancellationReceipt: run.cancellationReceipt })
      })
      const receipt = made.batch.decisionReceipt!
      return [
        Result.succeed(receipt),
        Object.freeze({
          runs: HashMap.set(current.runs, storageKey, storedRun),
          byIntentId,
          artifacts: current.artifacts,
          bindings: current.bindings,
          requests: current.requests,
          relayRequests: current.relayRequests,
          activityRequests: current.activityRequests,
          renewalRequests: current.renewalRequests,
          issuedExecutions: current.issuedExecutions,
          cancellationTargets: cancellationIndexes.cancellationTargets,
          cancellations: cancellationIndexes.cancellations,
          cancellationClaimRequests: current.cancellationClaimRequests,
          cancellationAckRequests: current.cancellationAckRequests,
          cancellationReleaseRequests: current.cancellationReleaseRequests,
          coordinatorClaimRequests: current.coordinatorClaimRequests,
          coordinatorRenewalRequests: current.coordinatorRenewalRequests,
          coordinatorReleaseRequests: current.coordinatorReleaseRequests,
          coordinatorIdleRequests: current.coordinatorIdleRequests,
          coordinatorCommitRequests: HashMap.set(
            current.coordinatorCommitRequests,
            fence.requestKey,
            Object.freeze({
              canonicalRequest: fence.canonicalRequest,
              receipt
            })
          ),
          coordinatorClaimCursors: current.coordinatorClaimCursors
        })
      ]
    })
    return yield* Effect.fromResult(result)
  })

  const requestCancellation: ExecutionStore.Service["requestCancellation"] = Effect.fnUntraced(function*(input) {
    const request = yield* validateCancellationRequest(input)
    const storageKey = runStorageKey(request.key)
    const earlyRun = Option.getOrUndefined(HashMap.get((yield* Ref.get(state)).runs, storageKey))
    if (earlyRun === undefined) {
      return yield* Effect.fail(new RunNotFound(request.key))
    }
    if (earlyRun.cancellationReceipt !== undefined) {
      return earlyRun.cancellationReceipt
    }
    const earlyFold = RunState.fold(Chunk.toReadonlyArray(earlyRun.events))
    if (Result.isFailure(earlyFold)) {
      return yield* Effect.fail(storeFailure(
        "requestCancellation",
        "Run history cannot be replayed",
        { code: earlyFold.failure.code }
      ))
    }
    if (
      earlyFold.success.status === "Succeeded" ||
      earlyFold.success.status === "Failed" ||
      earlyFold.success.status === "Cancelled"
    ) {
      return yield* Effect.fail(
        new CancellationRejected({
          ...request.key,
          status: earlyFold.success.status
        })
      )
    }

    const recordedAt = yield* currentTimestamp("requestCancellation")
    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<HistoryStore.CommitReceipt, CancellationError>,
      MemoryState
    ] => {
      const run = Option.getOrUndefined(HashMap.get(current.runs, storageKey))
      if (run === undefined) {
        return [Result.fail(new RunNotFound(request.key)), current]
      }
      if (run.cancellationReceipt !== undefined) {
        return [Result.succeed(run.cancellationReceipt), current]
      }
      const folded = RunState.fold(Chunk.toReadonlyArray(run.events))
      if (Result.isFailure(folded)) {
        return [
          Result.fail(storeFailure(
            "requestCancellation",
            "Run history cannot be replayed",
            { code: folded.failure.code }
          )),
          current
        ]
      }
      if (
        folded.success.status === "Succeeded" ||
        folded.success.status === "Failed" ||
        folded.success.status === "Cancelled"
      ) {
        return [
          Result.fail(
            new CancellationRejected({
              ...request.key,
              status: folded.success.status
            })
          ),
          current
        ]
      }
      if (folded.success.status === "CancellationRequested") {
        return [
          Result.fail(storeFailure(
            "requestCancellation",
            "Cancellation-requested history is missing its original receipt"
          )),
          current
        ]
      }
      const previousSequence = Chunk.size(run.events) - 1
      if (previousSequence < 0 || previousSequence >= Number.MAX_SAFE_INTEGER) {
        return [
          Result.fail(storeFailure("requestCancellation", "Cancellation sequence is outside safe range")),
          current
        ]
      }
      const event: Event.Event = Object.freeze({
        eventVersion: 1,
        eventId: Identity.runCancellationRequestedEventId(request.key.runId, request.requestId),
        runId: request.key.runId,
        sequence: previousSequence + 1,
        recordedAt,
        payload: Object.freeze({ _tag: "RunCancellationRequested" })
      })
      const prospective = RunState.fold([
        ...Chunk.toReadonlyArray(run.events),
        event
      ])
      if (Result.isFailure(prospective)) {
        return [
          Result.fail(storeFailure(
            "requestCancellation",
            "Cancellation would create invalid semantic history",
            { code: prospective.failure.code }
          )),
          current
        ]
      }
      const receipt: HistoryStore.CommitReceipt = Object.freeze({
        runId: request.key.runId,
        previousSequence,
        lastSequence: previousSequence + 1,
        events: Object.freeze([event]) as Arr.NonEmptyReadonlyArray<Event.Event>
      })
      const batch: StoredBatch = Object.freeze({
        kind: "Cancellation",
        previousSequence,
        canonicalEvents: Object.freeze([
          Json.canonicalizeSnapshot(event as unknown as Schema.Json)
        ]) as Arr.NonEmptyReadonlyArray<string>,
        canonicalDispatches: Object.freeze([]),
        canonicalCommit: Json.canonicalizeSnapshot(request as unknown as Schema.Json),
        historyReceipt: receipt
      })
      const storedEvent: StoredEvent = Object.freeze({ event, batch, position: 0 })
      const updatedRun: StoredRun = Object.freeze({
        events: Chunk.append(run.events, event),
        byEventId: HashMap.set(run.byEventId, event.eventId, storedEvent),
        outbox: run.outbox,
        needsDecision: true,
        coordinator: run.coordinator,
        cancellationReceipt: receipt
      })
      let byIntentId = current.byIntentId
      for (const [intentKey, stored] of HashMap.entries(current.byIntentId)) {
        if (
          stored.dispatch.tenantId === request.key.tenantId &&
          stored.dispatch.runId === request.key.runId &&
          stored.activity.completion === undefined
        ) {
          byIntentId = HashMap.set(
            byIntentId,
            intentKey,
            Object.freeze({
              ...stored,
              relay: Object.freeze({
                ...stored.relay,
                status: "Suppressed" as const
              })
            })
          )
        }
      }
      const cancellationIndexes = enqueueCancellationsForRun(
        current,
        request.key,
        request.requestId,
        event.eventId,
        "RunCancellationRequested",
        recordedAt
      )
      return [
        Result.succeed(receipt),
        Object.freeze({
          ...current,
          runs: HashMap.set(current.runs, storageKey, updatedRun),
          byIntentId,
          cancellationTargets: cancellationIndexes.cancellationTargets,
          cancellations: cancellationIndexes.cancellations
        })
      ]
    })
    return yield* Effect.fromResult(result)
  })

  const read: ExecutionStore.Service["read"] = Effect.fnUntraced(function*(input) {
    const key = yield* validateRunKey("read", input)
    const current = yield* Ref.get(state)
    const run = Option.getOrUndefined(HashMap.get(current.runs, runStorageKey(key)))
    if (run === undefined) {
      return yield* Effect.fail(new RunNotFound(key))
    }
    return Object.freeze({
      runId: key.runId,
      lastSequence: Chunk.size(run.events) - 1,
      events: Object.freeze([...Chunk.toReadonlyArray(run.events)])
    })
  })

  const inspectOutbox: ExecutionStore.Service["inspectOutbox"] = Effect.fnUntraced(function*(input) {
    const key = yield* validateRunKey("inspectOutbox", input)
    const current = yield* Ref.get(state)
    const run = Option.getOrUndefined(HashMap.get(current.runs, runStorageKey(key)))
    if (run === undefined) {
      return yield* Effect.fail(new RunNotFound(key))
    }
    return Object.freeze([...Chunk.toReadonlyArray(run.outbox)])
  })

  const claimRunnableRuns: RunCoordinator.RunCoordinatorStore["Service"]["claimRunnableRuns"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateCoordinatorRequest(
        "claimRunnableRuns",
        input,
        decodeClaimRunnableRuns
      )
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = coordinatorRequestStorageKey(
        "claimRunnableRuns",
        request.tenantId,
        request.coordinatorId,
        request.requestId
      )
      const early = Option.getOrUndefined(HashMap.get(
        (yield* Ref.get(state)).coordinatorClaimRequests,
        requestKey
      ))
      if (early !== undefined) {
        return early.canonicalRequest === canonicalRequest
          ? early.receipt
          : yield* Effect.fail(
            new RunCoordinator.CoordinatorRequestConflict({
              operation: "claimRunnableRuns",
              coordinatorId: request.coordinatorId,
              requestId: request.requestId
            })
          )
      }

      const leaseIds = yield* Effect.forEach(
        Array.from({ length: request.limit }),
        () => makeCoordinatorLeaseId("claimRunnableRuns"),
        { concurrency: 1 }
      )
      const now = yield* currentCoordinatorTime("claimRunnableRuns")
      const expires = coordinatorLeaseExpiration(
        "claimRunnableRuns",
        now,
        request.leaseDurationMillis
      )
      if (Result.isFailure(expires)) {
        return yield* Effect.fail(expires.failure)
      }

      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          RunCoordinator.ClaimRunnableRunsReceipt,
          | RunCoordinator.InvalidCoordinatorRequest
          | RunCoordinator.CoordinatorRequestConflict
          | RunCoordinator.RunCoordinatorStoreFailure
        >,
        MemoryState
      ] => {
        const exact = Option.getOrUndefined(HashMap.get(current.coordinatorClaimRequests, requestKey))
        if (exact !== undefined) {
          return exact.canonicalRequest === canonicalRequest
            ? [Result.succeed(exact.receipt), current]
            : [
              Result.fail(
                new RunCoordinator.CoordinatorRequestConflict({
                  operation: "claimRunnableRuns",
                  coordinatorId: request.coordinatorId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }

        const candidates: Array<{
          readonly storageKey: string
          readonly key: PlanStore.RunKey
          readonly run: StoredRun
        }> = []
        for (const binding of HashMap.values(current.bindings)) {
          if (binding.key.tenantId !== request.tenantId) {
            continue
          }
          const storageKey = runStorageKey(binding.key)
          const run = Option.getOrUndefined(HashMap.get(current.runs, storageKey))
          if (
            run !== undefined &&
            run.needsDecision &&
            (run.coordinator.lease === undefined ||
              run.coordinator.expiresAtMillis !== undefined &&
                run.coordinator.expiresAtMillis <= now.millis)
          ) {
            candidates.push({ storageKey, key: binding.key, run })
          }
        }
        candidates.sort((left, right) =>
          (left.run.coordinator.lastClaimOrder ?? -1) -
            (right.run.coordinator.lastClaimOrder ?? -1) ||
          left.key.runId.localeCompare(right.key.runId)
        )
        const bounded = candidates.slice(0, request.limit)
        const claimCursor = Option.getOrElse(
          HashMap.get(current.coordinatorClaimCursors, request.tenantId),
          () => 0
        )
        if (bounded.some(({ run }) => run.coordinator.epoch >= Number.MAX_SAFE_INTEGER)) {
          return [
            Result.fail(coordinatorFailure(
              "claimRunnableRuns",
              "Coordinator epoch exhausted its safe-integer range"
            )),
            current
          ]
        }
        if (
          !Number.isSafeInteger(claimCursor + bounded.length) ||
          claimCursor + bounded.length > Number.MAX_SAFE_INTEGER
        ) {
          return [
            Result.fail(coordinatorFailure(
              "claimRunnableRuns",
              "Coordinator fairness cursor exhausted its safe-integer range"
            )),
            current
          ]
        }

        let runs = current.runs
        const leases = bounded.map(({ key, run, storageKey }, position): RunCoordinator.RunLease => {
          const coordinatorEpoch = run.coordinator.epoch + 1
          const ref: RunCoordinator.RunLeaseRef = Object.freeze({
            leaseVersion: 1,
            key,
            coordinatorId: request.coordinatorId,
            coordinatorEpoch,
            leaseId: leaseIds[position]!
          })
          const lease: RunCoordinator.RunLease = Object.freeze({
            leaseVersion: 1,
            requestId: request.requestId,
            ref,
            observedLastSequence: Chunk.size(run.events) - 1,
            leasedAt: now.timestamp,
            expiresAt: expires.success.timestamp
          })
          runs = HashMap.set(
            runs,
            storageKey,
            Object.freeze({
              ...run,
              coordinator: Object.freeze({
                epoch: coordinatorEpoch,
                lastClaimOrder: claimCursor + position + 1,
                lease,
                expiresAtMillis: expires.success.millis
              })
            })
          )
          return lease
        })
        const receipt: RunCoordinator.ClaimRunnableRunsReceipt = Object.freeze({
          receiptVersion: 1,
          tenantId: request.tenantId,
          coordinatorId: request.coordinatorId,
          requestId: request.requestId,
          leases: Object.freeze(leases)
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            runs,
            coordinatorClaimCursors: HashMap.set(
              current.coordinatorClaimCursors,
              request.tenantId,
              claimCursor + bounded.length
            ),
            coordinatorClaimRequests: HashMap.set(
              current.coordinatorClaimRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const renewRunLease: RunCoordinator.RunCoordinatorStore["Service"]["renewRunLease"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateCoordinatorRequest("renewRunLease", input, decodeRenewRunLease)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = coordinatorRequestStorageKey(
        "renewRunLease",
        request.ref.key.tenantId,
        request.ref.coordinatorId,
        request.requestId
      )
      const exact = Option.getOrUndefined(HashMap.get(
        (yield* Ref.get(state)).coordinatorRenewalRequests,
        requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === canonicalRequest
          ? exact.receipt
          : yield* Effect.fail(
            new RunCoordinator.CoordinatorRequestConflict({
              operation: "renewRunLease",
              coordinatorId: request.ref.coordinatorId,
              requestId: request.requestId
            })
          )
      }
      const now = yield* currentCoordinatorTime("renewRunLease")
      const candidateExpiry = coordinatorLeaseExpiration(
        "renewRunLease",
        now,
        request.leaseDurationMillis
      )
      if (Result.isFailure(candidateExpiry)) {
        return yield* Effect.fail(candidateExpiry.failure)
      }
      const storageKey = runStorageKey(request.ref.key)
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          RunCoordinator.RunLease,
          | RunNotFound
          | RunCoordinator.CoordinatorError
        >,
        MemoryState
      ] => {
        const repeated = Option.getOrUndefined(HashMap.get(current.coordinatorRenewalRequests, requestKey))
        if (repeated !== undefined) {
          return repeated.canonicalRequest === canonicalRequest
            ? [Result.succeed(repeated.receipt), current]
            : [
              Result.fail(
                new RunCoordinator.CoordinatorRequestConflict({
                  operation: "renewRunLease",
                  coordinatorId: request.ref.coordinatorId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }
        const run = Option.getOrUndefined(HashMap.get(current.runs, storageKey))
        if (run === undefined) {
          return [Result.fail(new RunNotFound(request.ref.key)), current]
        }
        if (
          run.coordinator.lease === undefined ||
          !sameRunLeaseRef(run.coordinator.lease.ref, request.ref) ||
          run.coordinator.expiresAtMillis === undefined ||
          run.coordinator.expiresAtMillis <= now.millis
        ) {
          return [
            Result.fail(
              new RunCoordinator.StaleRunLease({
                key: request.ref.key,
                coordinatorId: request.ref.coordinatorId,
                coordinatorEpoch: request.ref.coordinatorEpoch
              })
            ),
            current
          ]
        }
        const extendsLease = candidateExpiry.success.millis > run.coordinator.expiresAtMillis
        const expiresAtMillis = extendsLease
          ? candidateExpiry.success.millis
          : run.coordinator.expiresAtMillis
        const lease: RunCoordinator.RunLease = Object.freeze({
          ...run.coordinator.lease,
          expiresAt: extendsLease
            ? candidateExpiry.success.timestamp
            : run.coordinator.lease.expiresAt
        })
        const updatedRun: StoredRun = Object.freeze({
          ...run,
          coordinator: Object.freeze({
            epoch: run.coordinator.epoch,
            ...(run.coordinator.lastClaimOrder === undefined
              ? undefined
              : { lastClaimOrder: run.coordinator.lastClaimOrder }),
            lease,
            expiresAtMillis
          })
        })
        return [
          Result.succeed(lease),
          Object.freeze({
            ...current,
            runs: HashMap.set(current.runs, storageKey, updatedRun),
            coordinatorRenewalRequests: HashMap.set(
              current.coordinatorRenewalRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt: lease })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const releaseRunLease: RunCoordinator.RunCoordinatorStore["Service"]["releaseRunLease"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateCoordinatorRequest("releaseRunLease", input, decodeReleaseRunLease)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = coordinatorRequestStorageKey(
        "releaseRunLease",
        request.ref.key.tenantId,
        request.ref.coordinatorId,
        request.requestId
      )
      const exact = Option.getOrUndefined(HashMap.get(
        (yield* Ref.get(state)).coordinatorReleaseRequests,
        requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === canonicalRequest
          ? exact.receipt
          : yield* Effect.fail(
            new RunCoordinator.CoordinatorRequestConflict({
              operation: "releaseRunLease",
              coordinatorId: request.ref.coordinatorId,
              requestId: request.requestId
            })
          )
      }
      const now = yield* currentCoordinatorTime("releaseRunLease")
      const storageKey = runStorageKey(request.ref.key)
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          RunCoordinator.ReleaseRunLeaseReceipt,
          RunNotFound | RunCoordinator.CoordinatorError
        >,
        MemoryState
      ] => {
        const repeated = Option.getOrUndefined(HashMap.get(current.coordinatorReleaseRequests, requestKey))
        if (repeated !== undefined) {
          return repeated.canonicalRequest === canonicalRequest
            ? [Result.succeed(repeated.receipt), current]
            : [
              Result.fail(
                new RunCoordinator.CoordinatorRequestConflict({
                  operation: "releaseRunLease",
                  coordinatorId: request.ref.coordinatorId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }
        const run = Option.getOrUndefined(HashMap.get(current.runs, storageKey))
        if (run === undefined) {
          return [Result.fail(new RunNotFound(request.ref.key)), current]
        }
        if (
          run.coordinator.lease === undefined ||
          !sameRunLeaseRef(run.coordinator.lease.ref, request.ref) ||
          run.coordinator.expiresAtMillis === undefined ||
          run.coordinator.expiresAtMillis <= now.millis
        ) {
          return [
            Result.fail(
              new RunCoordinator.StaleRunLease({
                key: request.ref.key,
                coordinatorId: request.ref.coordinatorId,
                coordinatorEpoch: request.ref.coordinatorEpoch
              })
            ),
            current
          ]
        }
        const receipt: RunCoordinator.ReleaseRunLeaseReceipt = Object.freeze({
          receiptVersion: 1,
          ref: request.ref,
          requestId: request.requestId,
          releasedAt: now.timestamp
        })
        const updatedRun: StoredRun = Object.freeze({
          ...run,
          coordinator: Object.freeze({
            epoch: run.coordinator.epoch,
            ...(run.coordinator.lastClaimOrder === undefined
              ? undefined
              : { lastClaimOrder: run.coordinator.lastClaimOrder })
          })
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            runs: HashMap.set(current.runs, storageKey, updatedRun),
            coordinatorReleaseRequests: HashMap.set(
              current.coordinatorReleaseRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const acknowledgeIdle: RunCoordinator.RunCoordinatorStore["Service"]["acknowledgeIdle"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateCoordinatorRequest("acknowledgeIdle", input, decodeAcknowledgeIdle)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = coordinatorRequestStorageKey(
        "acknowledgeIdle",
        request.ref.key.tenantId,
        request.ref.coordinatorId,
        request.requestId
      )
      const exact = Option.getOrUndefined(HashMap.get(
        (yield* Ref.get(state)).coordinatorIdleRequests,
        requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === canonicalRequest
          ? exact.receipt
          : yield* Effect.fail(
            new RunCoordinator.CoordinatorRequestConflict({
              operation: "acknowledgeIdle",
              coordinatorId: request.ref.coordinatorId,
              requestId: request.requestId
            })
          )
      }
      const now = yield* currentCoordinatorTime("acknowledgeIdle")
      const storageKey = runStorageKey(request.ref.key)
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          RunCoordinator.IdleReceipt,
          | RunNotFound
          | RunCoordinator.CoordinatorError
          | RunCoordinator.RunSequenceAdvanced
        >,
        MemoryState
      ] => {
        const repeated = Option.getOrUndefined(HashMap.get(current.coordinatorIdleRequests, requestKey))
        if (repeated !== undefined) {
          return repeated.canonicalRequest === canonicalRequest
            ? [Result.succeed(repeated.receipt), current]
            : [
              Result.fail(
                new RunCoordinator.CoordinatorRequestConflict({
                  operation: "acknowledgeIdle",
                  coordinatorId: request.ref.coordinatorId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }
        const run = Option.getOrUndefined(HashMap.get(current.runs, storageKey))
        if (run === undefined) {
          return [Result.fail(new RunNotFound(request.ref.key)), current]
        }
        if (
          run.coordinator.lease === undefined ||
          !sameRunLeaseRef(run.coordinator.lease.ref, request.ref) ||
          run.coordinator.expiresAtMillis === undefined ||
          run.coordinator.expiresAtMillis <= now.millis
        ) {
          return [
            Result.fail(
              new RunCoordinator.StaleRunLease({
                key: request.ref.key,
                coordinatorId: request.ref.coordinatorId,
                coordinatorEpoch: request.ref.coordinatorEpoch
              })
            ),
            current
          ]
        }
        const actualLastSequence = Chunk.size(run.events) - 1
        if (actualLastSequence !== request.observedLastSequence) {
          return [
            Result.fail(
              new RunCoordinator.RunSequenceAdvanced({
                key: request.ref.key,
                observedLastSequence: request.observedLastSequence,
                actualLastSequence
              })
            ),
            current
          ]
        }
        const receipt: RunCoordinator.IdleReceipt = Object.freeze({
          receiptVersion: 1,
          ref: request.ref,
          requestId: request.requestId,
          observedLastSequence: request.observedLastSequence,
          acknowledgedAt: now.timestamp
        })
        const updatedRun: StoredRun = Object.freeze({
          ...run,
          needsDecision: false,
          coordinator: Object.freeze({
            epoch: run.coordinator.epoch,
            ...(run.coordinator.lastClaimOrder === undefined
              ? undefined
              : { lastClaimOrder: run.coordinator.lastClaimOrder })
          })
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            runs: HashMap.set(current.runs, storageKey, updatedRun),
            coordinatorIdleRequests: HashMap.set(
              current.coordinatorIdleRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const commitCoordinatedDecision: RunCoordinator.RunCoordinatorStore["Service"]["commitDecision"] = Effect
    .fnUntraced(function*(input) {
      const captured = validateCoordinatorRequest(
        "commitDecision",
        input,
        decodeCoordinatorCommit
      )
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success as unknown as RunCoordinator.CommitDecisionRequest
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = coordinatorRequestStorageKey(
        "commitDecision",
        request.ref.key.tenantId,
        request.ref.coordinatorId,
        request.requestId
      )
      const exact = Option.getOrUndefined(HashMap.get(
        (yield* Ref.get(state)).coordinatorCommitRequests,
        requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === canonicalRequest
          ? exact.receipt
          : yield* Effect.fail(
            new RunCoordinator.CoordinatorRequestConflict({
              operation: "commitDecision",
              coordinatorId: request.ref.coordinatorId,
              requestId: request.requestId
            })
          )
      }
      const commit = yield* validateDecisionRequest(request.commit)
      if (
        commit.key.tenantId !== request.ref.key.tenantId ||
        commit.key.runId !== request.ref.key.runId
      ) {
        return yield* Effect.fail(
          new RunCoordinator.InvalidCoordinatorRequest({
            operation: "commitDecision",
            message: "Coordinator lease and decision commit identify different runs"
          })
        )
      }
      return yield* commitDecisionInternal(
        commit,
        Object.freeze({
          ref: request.ref,
          coordinatorId: request.ref.coordinatorId,
          requestId: request.requestId,
          requestKey,
          canonicalRequest
        })
      )
    })

  const claimOutbox: ActivityDelivery.ActivityDeliveryStore.Service["claimOutbox"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateDeliveryRequest("claimOutbox", input, decodeClaimOutbox)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = deliveryRequestStorageKey("claimOutbox", request.tenantId, request.requestId)

      const early = Option.getOrUndefined(HashMap.get((yield* Ref.get(state)).relayRequests, requestKey))
      if (early !== undefined) {
        return early.canonicalRequest === canonicalRequest
          ? early.receipt
          : yield* Effect.fail(
            new ActivityDelivery.DeliveryRequestConflict({
              operation: "claimOutbox",
              tenantId: request.tenantId,
              requestId: request.requestId
            })
          )
      }

      const leaseIds = yield* Effect.forEach(
        Array.from({ length: request.limit }),
        () => makeLeaseId("claimOutbox"),
        { concurrency: 1 }
      )
      const now = yield* currentDeliveryTime("claimOutbox")
      const expires = leaseExpiration("claimOutbox", now, request.leaseDurationMillis)
      if (Result.isFailure(expires)) {
        return yield* Effect.fail(expires.failure)
      }

      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<ActivityDelivery.ClaimOutboxReceipt, ActivityDelivery.DeliveryStoreError>,
        MemoryState
      ] => {
        const repeated = Option.getOrUndefined(HashMap.get(current.relayRequests, requestKey))
        if (repeated !== undefined) {
          return repeated.canonicalRequest === canonicalRequest
            ? [Result.succeed(repeated.receipt), current]
            : [
              Result.fail(
                new ActivityDelivery.DeliveryRequestConflict({
                  operation: "claimOutbox",
                  tenantId: request.tenantId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }

        const candidates = Array.from(HashMap.entries(current.byIntentId))
          .filter(([, stored]) =>
            stored.dispatch.tenantId === request.tenantId &&
            (request.queue === undefined || stored.dispatch.target.queue === request.queue) &&
            stored.activity.completion === undefined &&
            (stored.relay.status === "Pending" ||
              stored.relay.status === "Leased" &&
                stored.relay.expiresAtMillis !== undefined &&
                stored.relay.expiresAtMillis <= now.millis)
          )
          .sort(([, left], [, right]) =>
            left.dispatch.enqueuedAt.localeCompare(right.dispatch.enqueuedAt) ||
            left.dispatch.runId.localeCompare(right.dispatch.runId) ||
            left.dispatch.sourceEventSequence - right.dispatch.sourceEventSequence ||
            left.dispatch.intentId.localeCompare(right.dispatch.intentId)
          )
          .slice(0, request.limit)

        if (candidates.some(([, stored]) => stored.relay.epoch >= Number.MAX_SAFE_INTEGER)) {
          return [
            Result.fail(deliveryFailure("claimOutbox", "Relay epoch exhausted its safe-integer range")),
            current
          ]
        }

        let byIntentId = current.byIntentId
        const claims = candidates.map(([storageKey, stored], position): ActivityDelivery.RelayClaim => {
          const relayEpoch = stored.relay.epoch + 1
          const ref: ActivityDelivery.RelayLeaseRef = Object.freeze({
            leaseVersion: 1,
            key: Object.freeze({
              tenantId: stored.dispatch.tenantId,
              intentId: stored.dispatch.intentId
            }),
            relayId: request.relayId,
            relayEpoch,
            leaseId: leaseIds[position]!
          })
          const pointer: Dispatch.DispatchPointer = Object.freeze({
            pointerVersion: 1,
            key: ref.key,
            dispatchDigest: stored.dispatchDigest
          })
          const claim: ActivityDelivery.RelayClaim = Object.freeze({
            claimVersion: 1,
            ref,
            pointer,
            dispatch: stored.dispatch,
            leasedAt: now.timestamp,
            expiresAt: expires.success.timestamp
          })
          byIntentId = HashMap.set(
            byIntentId,
            storageKey,
            Object.freeze({
              ...stored,
              relay: Object.freeze({
                epoch: relayEpoch,
                status: "Leased" as const,
                lease: claim,
                expiresAtMillis: expires.success.millis
              })
            })
          )
          return claim
        })
        const receipt: ActivityDelivery.ClaimOutboxReceipt = Object.freeze({
          receiptVersion: 1,
          tenantId: request.tenantId,
          relayId: request.relayId,
          requestId: request.requestId,
          claims: Object.freeze(claims)
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            byIntentId,
            relayRequests: HashMap.set(
              current.relayRequests,
              requestKey,
              Object.freeze({
                canonicalRequest,
                receipt
              })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const sameRelayRef = (
    left: ActivityDelivery.RelayLeaseRef,
    right: ActivityDelivery.RelayLeaseRef
  ): boolean =>
    left.key.tenantId === right.key.tenantId &&
    left.key.intentId === right.key.intentId &&
    left.relayId === right.relayId &&
    left.relayEpoch === right.relayEpoch &&
    left.leaseId === right.leaseId

  const acknowledgePublished: ActivityDelivery.ActivityDeliveryStore.Service["acknowledgePublished"] = Effect
    .fnUntraced(function*(input) {
      const captured = validateDeliveryRequest(
        "acknowledgePublished",
        input,
        decodeAcknowledgePublished
      )
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalBrokerReceipt = Json.canonicalizeSnapshot(request.brokerReceipt)
      const storageKey = intentStorageKey(request.ref.key.tenantId, request.ref.key.intentId)
      const early = Option.getOrUndefined(HashMap.get((yield* Ref.get(state)).byIntentId, storageKey))
      if (
        early?.relay.published !== undefined &&
        sameRelayRef(early.relay.published.ref, request.ref) &&
        Json.canonicalizeSnapshot(early.relay.published.brokerReceipt) === canonicalBrokerReceipt
      ) {
        return early.relay.published
      }

      const now = yield* currentDeliveryTime("acknowledgePublished")
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          ActivityDelivery.PublishReceipt,
          ActivityDelivery.DeliveryStoreError | ActivityDelivery.StaleRelayLease
        >,
        MemoryState
      ] => {
        const stored = Option.getOrUndefined(HashMap.get(current.byIntentId, storageKey))
        if (stored === undefined) {
          return [Result.fail(new ActivityDelivery.DispatchNotFound(request.ref.key)), current]
        }
        if (
          stored.relay.published !== undefined &&
          sameRelayRef(stored.relay.published.ref, request.ref) &&
          Json.canonicalizeSnapshot(stored.relay.published.brokerReceipt) === canonicalBrokerReceipt
        ) {
          return [Result.succeed(stored.relay.published), current]
        }
        const relay = stored.relay
        const lease = relay.lease
        const reason = relay.status === "Published"
          ? "Published" as const
          : relay.status === "Pending" && relay.released !== undefined && sameRelayRef(relay.released, request.ref)
          ? "Released" as const
          : relay.status !== "Leased" || lease === undefined || !sameRelayRef(lease.ref, request.ref)
          ? "Superseded" as const
          : relay.expiresAtMillis === undefined || relay.expiresAtMillis <= now.millis
          ? "Expired" as const
          : undefined
        if (reason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.StaleRelayLease({
                key: request.ref.key,
                relayId: request.ref.relayId,
                requestedEpoch: request.ref.relayEpoch,
                currentEpoch: relay.epoch,
                reason
              })
            ),
            current
          ]
        }
        const receipt: ActivityDelivery.PublishReceipt = Object.freeze({
          receiptVersion: 1,
          ref: request.ref,
          publishedAt: now.timestamp,
          brokerReceipt: request.brokerReceipt
        })
        const updated = Object.freeze({
          ...stored,
          relay: Object.freeze({
            ...relay,
            status: "Published" as const,
            published: receipt
          })
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            byIntentId: HashMap.set(current.byIntentId, storageKey, updated)
          })
        ]
      })
      return yield* Effect.fromResult(result)
    })

  const releaseOutbox: ActivityDelivery.ActivityDeliveryStore.Service["releaseOutbox"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateDeliveryRequest("releaseOutbox", input, decodeReleaseOutbox)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const storageKey = intentStorageKey(request.ref.key.tenantId, request.ref.key.intentId)
      const early = Option.getOrUndefined(HashMap.get((yield* Ref.get(state)).byIntentId, storageKey))
      if (
        early?.relay.status === "Pending" &&
        early.relay.released !== undefined &&
        sameRelayRef(early.relay.released, request.ref)
      ) {
        return
      }

      const now = yield* currentDeliveryTime("releaseOutbox")
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<void, ActivityDelivery.DeliveryStoreError | ActivityDelivery.StaleRelayLease>,
        MemoryState
      ] => {
        const stored = Option.getOrUndefined(HashMap.get(current.byIntentId, storageKey))
        if (stored === undefined) {
          return [Result.fail(new ActivityDelivery.DispatchNotFound(request.ref.key)), current]
        }
        const relay = stored.relay
        if (
          relay.status === "Pending" &&
          relay.released !== undefined &&
          sameRelayRef(relay.released, request.ref)
        ) {
          return [Result.succeed(undefined), current]
        }
        const lease = relay.lease
        const reason = relay.status === "Published"
          ? "Published" as const
          : relay.status !== "Leased" || lease === undefined || !sameRelayRef(lease.ref, request.ref)
          ? "Superseded" as const
          : relay.expiresAtMillis === undefined || relay.expiresAtMillis <= now.millis
          ? "Expired" as const
          : undefined
        if (reason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.StaleRelayLease({
                key: request.ref.key,
                relayId: request.ref.relayId,
                requestedEpoch: request.ref.relayEpoch,
                currentEpoch: relay.epoch,
                reason
              })
            ),
            current
          ]
        }
        const updated = Object.freeze({
          ...stored,
          relay: Object.freeze({
            epoch: relay.epoch,
            status: "Pending" as const,
            released: request.ref
          })
        })
        return [
          Result.succeed(undefined),
          Object.freeze({
            ...current,
            byIntentId: HashMap.set(current.byIntentId, storageKey, updated)
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const acquireAttempt: ActivityDelivery.ActivityDeliveryStore.Service["acquireAttempt"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateDeliveryRequest("acquireAttempt", input, decodeAcquireAttempt)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = deliveryRequestStorageKey("acquireAttempt", request.key.tenantId, request.requestId)
      const earlyState = yield* Ref.get(state)
      const repeated = Option.getOrUndefined(HashMap.get(earlyState.activityRequests, requestKey))
      if (repeated !== undefined) {
        return repeated.canonicalRequest === canonicalRequest
          ? repeated.receipt
          : yield* Effect.fail(
            new ActivityDelivery.DeliveryRequestConflict({
              operation: "acquireAttempt",
              tenantId: request.key.tenantId,
              requestId: request.requestId
            })
          )
      }
      const earlyDispatch = Option.getOrUndefined(HashMap.get(
        earlyState.byIntentId,
        intentStorageKey(request.key.tenantId, request.key.intentId)
      ))
      if (earlyDispatch === undefined) {
        return yield* Effect.fail(new ActivityDelivery.DispatchNotFound(request.key))
      }
      if (earlyDispatch.dispatchDigest !== request.dispatchDigest) {
        return yield* Effect.fail(
          new ActivityDelivery.DispatchPinMismatch({
            key: request.key,
            field: "dispatchDigest",
            expected: earlyDispatch.dispatchDigest,
            requested: request.dispatchDigest
          })
        )
      }
      if (earlyDispatch.dispatch.target.deploymentId !== request.workerDeploymentId) {
        return yield* Effect.fail(
          new ActivityDelivery.DispatchPinMismatch({
            key: request.key,
            field: "workerDeploymentId",
            expected: earlyDispatch.dispatch.target.deploymentId,
            requested: request.workerDeploymentId
          })
        )
      }
      if (earlyDispatch.dispatch.target.queue !== request.workerQueue) {
        return yield* Effect.fail(
          new ActivityDelivery.DispatchPinMismatch({
            key: request.key,
            field: "workerQueue",
            expected: earlyDispatch.dispatch.target.queue,
            requested: request.workerQueue
          })
        )
      }

      const leaseId = yield* makeLeaseId("acquireAttempt")
      const now = yield* currentDeliveryTime("acquireAttempt")
      const expires = leaseExpiration("acquireAttempt", now, request.leaseDurationMillis)
      if (Result.isFailure(expires)) {
        return yield* Effect.fail(expires.failure)
      }
      const storageKey = intentStorageKey(request.key.tenantId, request.key.intentId)
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          ActivityDelivery.ActivityLease,
          | ActivityDelivery.DeliveryStoreError
          | ActivityDelivery.ActivityLeaseBusy
          | ActivityDelivery.DispatchPinMismatch
          | ActivityDelivery.ActivityCompletionSuppressed
        >,
        MemoryState
      ] => {
        const exact = Option.getOrUndefined(HashMap.get(current.activityRequests, requestKey))
        if (exact !== undefined) {
          return exact.canonicalRequest === canonicalRequest
            ? [Result.succeed(exact.receipt), current]
            : [
              Result.fail(
                new ActivityDelivery.DeliveryRequestConflict({
                  operation: "acquireAttempt",
                  tenantId: request.key.tenantId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }
        const stored = Option.getOrUndefined(HashMap.get(current.byIntentId, storageKey))
        if (stored === undefined) {
          return [Result.fail(new ActivityDelivery.DispatchNotFound(request.key)), current]
        }
        if (stored.dispatchDigest !== request.dispatchDigest) {
          return [
            Result.fail(
              new ActivityDelivery.DispatchPinMismatch({
                key: request.key,
                field: "dispatchDigest",
                expected: stored.dispatchDigest,
                requested: request.dispatchDigest
              })
            ),
            current
          ]
        }
        if (stored.dispatch.target.deploymentId !== request.workerDeploymentId) {
          return [
            Result.fail(
              new ActivityDelivery.DispatchPinMismatch({
                key: request.key,
                field: "workerDeploymentId",
                expected: stored.dispatch.target.deploymentId,
                requested: request.workerDeploymentId
              })
            ),
            current
          ]
        }
        if (stored.dispatch.target.queue !== request.workerQueue) {
          return [
            Result.fail(
              new ActivityDelivery.DispatchPinMismatch({
                key: request.key,
                field: "workerQueue",
                expected: stored.dispatch.target.queue,
                requested: request.workerQueue
              })
            ),
            current
          ]
        }
        const run = Option.getOrUndefined(HashMap.get(
          current.runs,
          runStorageKey({ tenantId: request.key.tenantId, runId: stored.dispatch.runId })
        ))
        if (run === undefined) {
          return [
            Result.fail(deliveryFailure("acquireAttempt", "Dispatch is missing its run history")),
            current
          ]
        }
        const folded = RunState.fold(Chunk.toReadonlyArray(run.events))
        if (Result.isFailure(folded)) {
          return [
            Result.fail(deliveryFailure("acquireAttempt", "Run history cannot be replayed", {
              code: folded.failure.code
            })),
            current
          ]
        }
        const runState = folded.success
        const activityId = stored.dispatch.command.payload.activityId
        const activity = Option.getOrUndefined(HashMap.get(runState.activities, activityId))
        const suppressedReason = runState.status === "CancellationRequested"
          ? "CancellationRequested" as const
          : runState.status !== "Running"
          ? "RunTerminal" as const
          : activity === undefined
          ? "NotScheduled" as const
          : activity.status !== "Scheduled" || stored.activity.completion !== undefined
          ? "AlreadyResolved" as const
          : undefined
        if (suppressedReason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.ActivityCompletionSuppressed({
                key: request.key,
                reason: suppressedReason
              })
            ),
            current
          ]
        }
        const activeLease = stored.activity.lease
        if (
          activeLease !== undefined &&
          stored.activity.expiresAtMillis !== undefined &&
          stored.activity.expiresAtMillis > now.millis
        ) {
          return [
            Result.fail(
              new ActivityDelivery.ActivityLeaseBusy({
                key: request.key,
                workerId: activeLease.ref.workerId,
                deliveryEpoch: activeLease.ref.deliveryEpoch,
                expiresAt: activeLease.expiresAt
              })
            ),
            current
          ]
        }
        if (stored.activity.epoch >= Number.MAX_SAFE_INTEGER) {
          return [
            Result.fail(deliveryFailure("acquireAttempt", "Delivery epoch exhausted its safe-integer range")),
            current
          ]
        }
        const deliveryEpoch = stored.activity.epoch + 1
        const ref: ActivityDelivery.ActivityLeaseRef = Object.freeze({
          leaseVersion: 1,
          key: request.key,
          workerId: request.workerId,
          workerDeploymentId: request.workerDeploymentId,
          deliveryEpoch,
          leaseId
        })
        const pointer: Dispatch.DispatchPointer = Object.freeze({
          pointerVersion: 1,
          key: request.key,
          dispatchDigest: stored.dispatchDigest
        })
        const lease: ActivityDelivery.ActivityLease = Object.freeze({
          leaseVersion: 1,
          requestId: request.requestId,
          ref,
          pointer,
          dispatch: stored.dispatch,
          leasedAt: now.timestamp,
          expiresAt: expires.success.timestamp
        })
        const updated = Object.freeze({
          ...stored,
          activity: Object.freeze({
            epoch: deliveryEpoch,
            lease,
            expiresAtMillis: expires.success.millis
          })
        })
        const issuedKey = issuedExecutionStorageKey(ref)
        const issuedExecution: StoredIssuedExecution = Object.freeze({
          lease,
          runId: stored.dispatch.runId,
          attemptId: stored.dispatch.command.payload.activityId,
          attempt: stored.dispatch.command.payload.attempt,
          logicalActivityId: stored.dispatch.command.payload.idempotencyKey,
          quiescent: false
        })
        return [
          Result.succeed(lease),
          Object.freeze({
            ...current,
            byIntentId: HashMap.set(current.byIntentId, storageKey, updated),
            issuedExecutions: HashMap.set(
              current.issuedExecutions,
              issuedKey,
              issuedExecution
            ),
            activityRequests: HashMap.set(
              current.activityRequests,
              requestKey,
              Object.freeze({
                canonicalRequest,
                receipt: lease
              })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const sameActivityRef = (
    left: ActivityDelivery.ActivityLeaseRef,
    right: ActivityDelivery.ActivityLeaseRef
  ): boolean =>
    left.key.tenantId === right.key.tenantId &&
    left.key.intentId === right.key.intentId &&
    left.workerId === right.workerId &&
    left.workerDeploymentId === right.workerDeploymentId &&
    left.deliveryEpoch === right.deliveryEpoch &&
    left.leaseId === right.leaseId

  const renewAttempt: ActivityDelivery.ActivityDeliveryStore.Service["renewAttempt"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateDeliveryRequest("renewAttempt", input, decodeRenewAttempt)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(request as unknown as Schema.Json)
      const requestKey = deliveryRequestStorageKey("renewAttempt", request.ref.key.tenantId, request.requestId)
      const repeated = Option.getOrUndefined(HashMap.get((yield* Ref.get(state)).renewalRequests, requestKey))
      if (repeated !== undefined) {
        return repeated.canonicalRequest === canonicalRequest
          ? repeated.receipt
          : yield* Effect.fail(
            new ActivityDelivery.DeliveryRequestConflict({
              operation: "renewAttempt",
              tenantId: request.ref.key.tenantId,
              requestId: request.requestId
            })
          )
      }
      const now = yield* currentDeliveryTime("renewAttempt")
      const candidateExpiry = leaseExpiration("renewAttempt", now, request.leaseDurationMillis)
      if (Result.isFailure(candidateExpiry)) {
        return yield* Effect.fail(candidateExpiry.failure)
      }
      const storageKey = intentStorageKey(request.ref.key.tenantId, request.ref.key.intentId)
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          ActivityDelivery.ActivityLease,
          ActivityDelivery.DeliveryStoreError | ActivityDelivery.StaleActivityLease
        >,
        MemoryState
      ] => {
        const exact = Option.getOrUndefined(HashMap.get(current.renewalRequests, requestKey))
        if (exact !== undefined) {
          return exact.canonicalRequest === canonicalRequest
            ? [Result.succeed(exact.receipt), current]
            : [
              Result.fail(
                new ActivityDelivery.DeliveryRequestConflict({
                  operation: "renewAttempt",
                  tenantId: request.ref.key.tenantId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }
        const stored = Option.getOrUndefined(HashMap.get(current.byIntentId, storageKey))
        if (stored === undefined) {
          return [Result.fail(new ActivityDelivery.DispatchNotFound(request.ref.key)), current]
        }
        const activity = stored.activity
        const run = Option.getOrUndefined(HashMap.get(
          current.runs,
          runStorageKey({
            tenantId: request.ref.key.tenantId,
            runId: stored.dispatch.runId
          })
        ))
        if (run === undefined) {
          return [
            Result.fail(deliveryFailure("renewAttempt", "Dispatch is missing its run history")),
            current
          ]
        }
        const folded = RunState.fold(Chunk.toReadonlyArray(run.events))
        if (Result.isFailure(folded)) {
          return [
            Result.fail(deliveryFailure("renewAttempt", "Run history cannot be replayed", {
              code: folded.failure.code
            })),
            current
          ]
        }
        const runReason = folded.success.status === "CancellationRequested"
          ? "CancellationRequested" as const
          : folded.success.status !== "Running"
          ? "RunTerminal" as const
          : undefined
        if (runReason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.StaleActivityLease({
                key: request.ref.key,
                workerId: request.ref.workerId,
                requestedEpoch: request.ref.deliveryEpoch,
                currentEpoch: activity.epoch,
                reason: runReason
              })
            ),
            current
          ]
        }
        const lease = activity.lease
        const reason = activity.completion !== undefined
          ? "Completed" as const
          : lease === undefined || !sameActivityRef(lease.ref, request.ref)
          ? "Superseded" as const
          : activity.expiresAtMillis === undefined || activity.expiresAtMillis <= now.millis
          ? "Expired" as const
          : undefined
        if (reason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.StaleActivityLease({
                key: request.ref.key,
                workerId: request.ref.workerId,
                requestedEpoch: request.ref.deliveryEpoch,
                currentEpoch: activity.epoch,
                reason
              })
            ),
            current
          ]
        }
        const currentLease = lease!
        const extendsLease = candidateExpiry.success.millis > activity.expiresAtMillis!
        const renewed: ActivityDelivery.ActivityLease = Object.freeze({
          ...currentLease,
          expiresAt: extendsLease ? candidateExpiry.success.timestamp : currentLease.expiresAt
        })
        const expiresAtMillis = extendsLease ? candidateExpiry.success.millis : activity.expiresAtMillis!
        const updated = Object.freeze({
          ...stored,
          activity: Object.freeze({
            ...activity,
            lease: renewed,
            expiresAtMillis
          })
        })
        return [
          Result.succeed(renewed),
          Object.freeze({
            ...current,
            byIntentId: HashMap.set(current.byIntentId, storageKey, updated),
            renewalRequests: HashMap.set(
              current.renewalRequests,
              requestKey,
              Object.freeze({
                canonicalRequest,
                receipt: renewed
              })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const completeAttempt: ActivityDelivery.ActivityDeliveryStore.Service["completeAttempt"] = Effect.fnUntraced(
    function*(input) {
      const captured = validateDeliveryRequest("completeAttempt", input, decodeCompleteAttempt)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalResult = Json.canonicalizeSnapshot(request.result as unknown as Schema.Json)
      const storageKey = intentStorageKey(request.ref.key.tenantId, request.ref.key.intentId)
      const early = Option.getOrUndefined(HashMap.get((yield* Ref.get(state)).byIntentId, storageKey))
      if (early?.activity.completion !== undefined) {
        return early.activity.completion.canonicalResult === canonicalResult
          ? early.activity.completion.receipt
          : yield* Effect.fail(
            new ActivityDelivery.ConflictingCompletion({
              key: request.ref.key,
              existingRequestId: early.activity.completion.receipt.requestId,
              requestedRequestId: request.requestId
            })
          )
      }

      const now = yield* currentDeliveryTime("completeAttempt")
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          ActivityDelivery.CompletionReceipt,
          | ActivityDelivery.DeliveryStoreError
          | ActivityDelivery.StaleActivityLease
          | ActivityDelivery.ActivityCompletionSuppressed
          | ActivityDelivery.ConflictingCompletion
        >,
        MemoryState
      ] => {
        const stored = Option.getOrUndefined(HashMap.get(current.byIntentId, storageKey))
        if (stored === undefined) {
          return [Result.fail(new ActivityDelivery.DispatchNotFound(request.ref.key)), current]
        }
        if (stored.activity.completion !== undefined) {
          return stored.activity.completion.canonicalResult === canonicalResult
            ? [Result.succeed(stored.activity.completion.receipt), current]
            : [
              Result.fail(
                new ActivityDelivery.ConflictingCompletion({
                  key: request.ref.key,
                  existingRequestId: stored.activity.completion.receipt.requestId,
                  requestedRequestId: request.requestId
                })
              ),
              current
            ]
        }
        const activityDelivery = stored.activity
        const lease = activityDelivery.lease
        const staleReason = lease === undefined || !sameActivityRef(lease.ref, request.ref)
          ? "Superseded" as const
          : activityDelivery.expiresAtMillis === undefined || activityDelivery.expiresAtMillis <= now.millis
          ? "Expired" as const
          : undefined
        if (staleReason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.StaleActivityLease({
                key: request.ref.key,
                workerId: request.ref.workerId,
                requestedEpoch: request.ref.deliveryEpoch,
                currentEpoch: activityDelivery.epoch,
                reason: staleReason
              })
            ),
            current
          ]
        }
        const issuedKey = issuedExecutionStorageKey(request.ref)
        const issuedGeneration = Option.getOrUndefined(
          HashMap.get(current.issuedExecutions, issuedKey)
        )
        if (issuedGeneration === undefined) {
          return [
            Result.fail(deliveryFailure(
              "completeAttempt",
              "Activity lease generation is missing its issued-execution ledger"
            )),
            current
          ]
        }

        const runKey: PlanStore.RunKey = {
          tenantId: request.ref.key.tenantId,
          runId: stored.dispatch.runId
        }
        const runKeyString = runStorageKey(runKey)
        const run = Option.getOrUndefined(HashMap.get(current.runs, runKeyString))
        if (run === undefined) {
          return [
            Result.fail(deliveryFailure("completeAttempt", "Dispatch is missing its run history")),
            current
          ]
        }
        const folded = RunState.fold(Chunk.toReadonlyArray(run.events))
        if (Result.isFailure(folded)) {
          return [
            Result.fail(deliveryFailure("completeAttempt", "Run history cannot be replayed", {
              code: folded.failure.code
            })),
            current
          ]
        }
        const runState = folded.success
        const activityId = stored.dispatch.command.payload.activityId
        const activity = Option.getOrUndefined(HashMap.get(runState.activities, activityId))
        const suppressedReason = runState.status === "CancellationRequested"
          ? "CancellationRequested" as const
          : runState.status !== "Running"
          ? "RunTerminal" as const
          : activity === undefined
          ? "NotScheduled" as const
          : activity.status !== "Scheduled"
          ? "AlreadyResolved" as const
          : undefined
        if (suppressedReason !== undefined) {
          return [
            Result.fail(
              new ActivityDelivery.ActivityCompletionSuppressed({
                key: request.ref.key,
                reason: suppressedReason
              })
            ),
            current
          ]
        }

        const previousSequence = Chunk.size(run.events) - 1
        if (
          !Number.isSafeInteger(previousSequence) ||
          previousSequence < 1 ||
          previousSequence >= Number.MAX_SAFE_INTEGER
        ) {
          return [
            Result.fail(deliveryFailure("completeAttempt", "Activity result sequence is outside safe range")),
            current
          ]
        }
        const payload: Event.ActivitySucceeded | Event.ActivityFailed = request.result._tag === "Succeeded"
          ? Object.freeze({
            _tag: "ActivitySucceeded",
            activityId,
            output: request.result.output
          })
          : Object.freeze({
            _tag: "ActivityFailed",
            activityId,
            failure: request.result.failure
          })
        const eventId = request.result._tag === "Succeeded"
          ? Identity.activitySucceededEventId(activityId)
          : Identity.activityFailedEventId(activityId)
        const event: Event.Event = Object.freeze({
          eventVersion: 1,
          eventId,
          runId: stored.dispatch.runId,
          sequence: previousSequence + 1,
          recordedAt: now.timestamp,
          causationId: stored.dispatch.command.commandId,
          payload
        })
        const prospective = RunState.fold([
          ...Chunk.toReadonlyArray(run.events),
          event
        ])
        if (Result.isFailure(prospective)) {
          return [
            Result.fail(deliveryFailure(
              "completeAttempt",
              "Fenced activity completion would create invalid semantic history",
              { code: prospective.failure.code }
            )),
            current
          ]
        }
        const receipt: ActivityDelivery.CompletionReceipt = Object.freeze({
          receiptVersion: 1,
          key: request.ref.key,
          requestId: request.requestId,
          previousSequence,
          lastSequence: previousSequence + 1,
          event
        })
        const historyReceipt: HistoryStore.CommitReceipt = Object.freeze({
          runId: stored.dispatch.runId,
          previousSequence,
          lastSequence: previousSequence + 1,
          events: Object.freeze([event]) as Arr.NonEmptyReadonlyArray<Event.Event>
        })
        const batch: StoredBatch = Object.freeze({
          kind: "ActivityCompletion",
          previousSequence,
          canonicalEvents: Object.freeze([
            Json.canonicalizeSnapshot(event as unknown as Schema.Json)
          ]) as Arr.NonEmptyReadonlyArray<string>,
          canonicalDispatches: Object.freeze([]),
          canonicalCommit: canonicalResult,
          historyReceipt
        })
        const storedEvent: StoredEvent = Object.freeze({
          event,
          batch,
          position: 0
        })
        const completion: StoredCompletion = Object.freeze({
          canonicalResult,
          receipt
        })
        const updatedDispatch: StoredDispatch = Object.freeze({
          ...stored,
          relay: Object.freeze({
            ...stored.relay,
            status: "Suppressed"
          }),
          activity: Object.freeze({
            ...stored.activity,
            completion
          })
        })
        const updatedRun: StoredRun = Object.freeze({
          events: Chunk.append(run.events, event),
          byEventId: HashMap.set(run.byEventId, eventId, storedEvent),
          outbox: run.outbox,
          needsDecision: true,
          coordinator: run.coordinator,
          ...(run.cancellationReceipt === undefined
            ? undefined
            : { cancellationReceipt: run.cancellationReceipt })
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            runs: HashMap.set(current.runs, runKeyString, updatedRun),
            byIntentId: HashMap.set(current.byIntentId, storageKey, updatedDispatch),
            issuedExecutions: HashMap.set(
              current.issuedExecutions,
              issuedKey,
              Object.freeze({
                ...issuedGeneration,
                quiescent: true
              })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    }
  )

  const sameCancellationClaimRef = (
    left: ActivityCancellation.CancellationClaimRef,
    right: ActivityCancellation.CancellationClaimRef
  ): boolean =>
    left.claimRefVersion === right.claimRefVersion &&
    sameActivityRef(left.activityLeaseRef, right.activityLeaseRef) &&
    left.attemptId === right.attemptId &&
    left.attempt === right.attempt &&
    left.logicalActivityId === right.logicalActivityId &&
    left.cancellationId === right.cancellationId &&
    left.workerIncarnationId === right.workerIncarnationId &&
    left.claimantId === right.claimantId &&
    left.claimEpoch === right.claimEpoch &&
    left.claimLeaseId === right.claimLeaseId

  const claimCancellations: ActivityCancellation.ActivityCancellationDeliveryStore.Service["claimCancellations"] =
    Effect.fnUntraced(function*(input) {
      const captured = ActivityCancellation.decodeClaimCancellationsRequest(input)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const request = captured.success
      const canonicalRequest = Json.canonicalizeSnapshot(
        request as unknown as Schema.Json
      )
      const requestKey = cancellationRequestStorageKey(
        "claimCancellations",
        request.tenantId,
        request.claimantId,
        request.requestId
      )
      const repeated = Option.getOrUndefined(HashMap.get(
        (yield* Ref.get(state)).cancellationClaimRequests,
        requestKey
      ))
      if (repeated !== undefined) {
        return repeated.canonicalRequest === canonicalRequest
          ? repeated.receipt
          : yield* Effect.fail(
            new ActivityCancellation.CancellationDeliveryRequestConflict({
              operation: "claimCancellations",
              tenantId: request.tenantId,
              requestId: request.requestId
            })
          )
      }
      const now = yield* currentCancellationTime("claimCancellations")
      const expires = cancellationLeaseExpiration(
        "claimCancellations",
        now,
        request.leaseDurationMillis
      )
      if (Result.isFailure(expires)) {
        return yield* Effect.fail(expires.failure)
      }
      const leaseIds = yield* Effect.forEach(
        Array.from({ length: request.limit }, (_, index) => index),
        (index) =>
          makeCancellationLeaseId(
            "claimCancellations",
            `${request.requestId}:${index}`
          ),
        { concurrency: 1 }
      )
      const result = yield* Ref.modify(state, (current): readonly [
        Result.Result<
          ActivityCancellation.ClaimCancellationsReceipt,
          ActivityCancellation.CancellationDeliveryStoreError
        >,
        MemoryState
      ] => {
        const exact = Option.getOrUndefined(HashMap.get(
          current.cancellationClaimRequests,
          requestKey
        ))
        if (exact !== undefined) {
          return exact.canonicalRequest === canonicalRequest
            ? [Result.succeed(exact.receipt), current]
            : [
              Result.fail(
                new ActivityCancellation.CancellationDeliveryRequestConflict({
                  operation: "claimCancellations",
                  tenantId: request.tenantId,
                  requestId: request.requestId
                })
              ),
              current
            ]
        }
        const candidates = [...HashMap.entries(current.cancellations)]
          .filter(([, stored]) => {
            const record = stored.record
            const ref = record.issued.activityLeaseRef
            return ref.key.tenantId === request.tenantId &&
              ref.workerId === request.workerId &&
              ref.workerDeploymentId === request.workerDeploymentId &&
              (record._tag === "Pending" ||
                record._tag === "Leased" &&
                  stored.expiresAtMillis !== undefined &&
                  stored.expiresAtMillis <= now.millis)
          })
          .sort(([, left], [, right]) => {
            const time = left.record.issued.enqueuedAt.localeCompare(
              right.record.issued.enqueuedAt
            )
            return time !== 0
              ? time
              : left.record.issued.cancellationId.localeCompare(
                right.record.issued.cancellationId
              )
          })
          .slice(0, request.limit)
        if (
          candidates.some(([, stored]) => {
            const epoch = stored.record._tag === "Pending"
              ? stored.record.claimEpoch
              : stored.record._tag === "Leased"
              ? stored.record.ref.claimEpoch
              : 0
            return epoch >= Number.MAX_SAFE_INTEGER
          })
        ) {
          return [
            Result.fail(cancellationDeliveryFailure(
              "claimCancellations",
              "Cancellation claim epoch exhausted its safe-integer range"
            )),
            current
          ]
        }
        let cancellations = current.cancellations
        const claims = candidates.map(([cancellationId, stored], index) => {
          const previousEpoch = stored.record._tag === "Pending"
            ? stored.record.claimEpoch
            : stored.record._tag === "Leased"
            ? stored.record.ref.claimEpoch
            : 0
          const issued = stored.record.issued
          const ref: ActivityCancellation.CancellationClaimRef = Object.freeze({
            claimRefVersion: 1,
            activityLeaseRef: issued.activityLeaseRef,
            attemptId: issued.attemptId,
            attempt: issued.attempt,
            logicalActivityId: issued.logicalActivityId,
            cancellationId,
            workerIncarnationId: request.workerIncarnationId,
            claimantId: request.claimantId,
            claimEpoch: previousEpoch + 1,
            claimLeaseId: leaseIds[index]!
          })
          const record: ActivityCancellation.LeasedCancellation = Object.freeze({
            _tag: "Leased",
            recordVersion: 1,
            issued,
            ref,
            claimRequestId: request.requestId,
            leasedAt: now.timestamp,
            expiresAt: expires.success.timestamp
          })
          cancellations = HashMap.set(
            cancellations,
            cancellationId,
            Object.freeze({
              record,
              expiresAtMillis: expires.success.millis,
              ...(stored.lastReleasedRef === undefined
                ? undefined
                : { lastReleasedRef: stored.lastReleasedRef }),
              ...(stored.lastReleaseReceipt === undefined
                ? undefined
                : { lastReleaseReceipt: stored.lastReleaseReceipt })
            })
          )
          return Object.freeze({
            claimVersion: 1,
            ref,
            issued,
            claimRequestId: request.requestId,
            leasedAt: now.timestamp,
            expiresAt: expires.success.timestamp
          }) satisfies ActivityCancellation.CancellationClaim
        })
        const receipt: ActivityCancellation.ClaimCancellationsReceipt = Object.freeze({
          receiptVersion: 1,
          tenantId: request.tenantId,
          workerId: request.workerId,
          workerIncarnationId: request.workerIncarnationId,
          workerDeploymentId: request.workerDeploymentId,
          claimantId: request.claimantId,
          requestId: request.requestId,
          claims: Object.freeze(claims)
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            cancellations,
            cancellationClaimRequests: HashMap.set(
              current.cancellationClaimRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt })
            )
          })
        ]
      })
      return yield* Effect.fromResult(result)
    })

  const acknowledgeCancellation: ActivityCancellation.ActivityCancellationDeliveryStore.Service[
    "acknowledgeCancellation"
  ] = Effect.fnUntraced(function*(input) {
    const captured = ActivityCancellation.decodeAcknowledgeCancellationRequest(input)
    if (Result.isFailure(captured)) {
      return yield* Effect.fail(captured.failure)
    }
    const request = captured.success
    const tenantId = request.ref.activityLeaseRef.key.tenantId
    const canonicalRequest = Json.canonicalizeSnapshot(
      request as unknown as Schema.Json
    )
    const requestKey = cancellationRequestStorageKey(
      "acknowledgeCancellation",
      tenantId,
      request.ref.claimantId,
      request.requestId
    )
    const repeated = Option.getOrUndefined(HashMap.get(
      (yield* Ref.get(state)).cancellationAckRequests,
      requestKey
    ))
    if (repeated !== undefined) {
      return repeated.canonicalRequest === canonicalRequest
        ? repeated.receipt
        : yield* Effect.fail(
          new ActivityCancellation.CancellationDeliveryRequestConflict({
            operation: "acknowledgeCancellation",
            tenantId,
            requestId: request.requestId
          })
        )
    }
    const now = yield* currentCancellationTime(
      "acknowledgeCancellation"
    )
    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<
        ActivityCancellation.AcknowledgeCancellationReceipt,
        | ActivityCancellation.CancellationDeliveryStoreError
        | ActivityCancellation.CancellationNotFound
        | ActivityCancellation.StaleCancellationClaim
        | ActivityCancellation.CancellationDispositionConflict
      >,
      MemoryState
    ] => {
      const exact = Option.getOrUndefined(HashMap.get(
        current.cancellationAckRequests,
        requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === canonicalRequest
          ? [Result.succeed(exact.receipt), current]
          : [
            Result.fail(
              new ActivityCancellation.CancellationDeliveryRequestConflict({
                operation: "acknowledgeCancellation",
                tenantId,
                requestId: request.requestId
              })
            ),
            current
          ]
      }
      const stored = Option.getOrUndefined(HashMap.get(
        current.cancellations,
        request.ref.cancellationId
      ))
      if (stored === undefined) {
        return [
          Result.fail(
            new ActivityCancellation.CancellationNotFound({
              tenantId,
              cancellationId: request.ref.cancellationId
            })
          ),
          current
        ]
      }
      if (stored.record._tag === "Acknowledged") {
        if (
          sameCancellationClaimRef(stored.record.ref, request.ref) &&
          stored.record.disposition !== request.disposition
        ) {
          return [
            Result.fail(
              new ActivityCancellation.CancellationDispositionConflict({
                cancellationId: request.ref.cancellationId,
                existing: stored.record.disposition,
                requested: request.disposition
              })
            ),
            current
          ]
        }
        if (!sameCancellationClaimRef(stored.record.ref, request.ref)) {
          return [
            Result.fail(
              new ActivityCancellation.StaleCancellationClaim({
                cancellationId: request.ref.cancellationId,
                claimantId: request.ref.claimantId,
                workerIncarnationId: request.ref.workerIncarnationId,
                requestedEpoch: request.ref.claimEpoch,
                currentEpoch: stored.record.ref.claimEpoch,
                reason: "Acknowledged"
              })
            ),
            current
          ]
        }
        const receipt: ActivityCancellation.AcknowledgeCancellationReceipt = Object.freeze({
          receiptVersion: 1,
          requestId: request.requestId,
          ref: request.ref,
          disposition: request.disposition,
          acknowledgedAt: stored.record.acknowledgedAt
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            cancellationAckRequests: HashMap.set(
              current.cancellationAckRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt })
            )
          })
        ]
      }
      if (stored.record._tag === "Pending") {
        return [
          Result.fail(
            new ActivityCancellation.StaleCancellationClaim({
              cancellationId: request.ref.cancellationId,
              claimantId: request.ref.claimantId,
              workerIncarnationId: request.ref.workerIncarnationId,
              requestedEpoch: request.ref.claimEpoch,
              currentEpoch: stored.record.claimEpoch,
              reason: stored.lastReleasedRef !== undefined &&
                  sameCancellationClaimRef(
                    stored.lastReleasedRef,
                    request.ref
                  )
                ? "Released"
                : "Superseded"
            })
          ),
          current
        ]
      }
      if (!sameCancellationClaimRef(stored.record.ref, request.ref)) {
        return [
          Result.fail(
            new ActivityCancellation.StaleCancellationClaim({
              cancellationId: request.ref.cancellationId,
              claimantId: request.ref.claimantId,
              workerIncarnationId: request.ref.workerIncarnationId,
              requestedEpoch: request.ref.claimEpoch,
              currentEpoch: stored.record.ref.claimEpoch,
              reason: "Superseded"
            })
          ),
          current
        ]
      }
      if (
        stored.expiresAtMillis === undefined ||
        stored.expiresAtMillis <= now.millis
      ) {
        return [
          Result.fail(
            new ActivityCancellation.StaleCancellationClaim({
              cancellationId: request.ref.cancellationId,
              claimantId: request.ref.claimantId,
              workerIncarnationId: request.ref.workerIncarnationId,
              requestedEpoch: request.ref.claimEpoch,
              currentEpoch: stored.record.ref.claimEpoch,
              reason: "Expired"
            })
          ),
          current
        ]
      }
      const issuedKey = issuedExecutionStorageKey(
        request.ref.activityLeaseRef
      )
      const issued = Option.getOrUndefined(HashMap.get(
        current.issuedExecutions,
        issuedKey
      ))
      if (issued === undefined) {
        return [
          Result.fail(cancellationDeliveryFailure(
            "acknowledgeCancellation",
            "Cancellation references an unknown issued execution"
          )),
          current
        ]
      }
      if (
        request.disposition === "NotRunning" &&
        !issued.quiescent
      ) {
        return [
          Result.fail(cancellationDeliveryFailure(
            "acknowledgeCancellation",
            "NotRunning requires authoritative quiescence for the exact issued execution"
          )),
          current
        ]
      }
      const receipt: ActivityCancellation.AcknowledgeCancellationReceipt = Object.freeze({
        receiptVersion: 1,
        requestId: request.requestId,
        ref: request.ref,
        disposition: request.disposition,
        acknowledgedAt: now.timestamp
      })
      const record: ActivityCancellation.AcknowledgedCancellation = Object.freeze({
        _tag: "Acknowledged",
        recordVersion: 1,
        issued: stored.record.issued,
        ref: request.ref,
        claimRequestId: stored.record.claimRequestId,
        leasedAt: stored.record.leasedAt,
        expiresAt: stored.record.expiresAt,
        acknowledgeRequestId: request.requestId,
        acknowledgedAt: now.timestamp,
        disposition: request.disposition
      })
      return [
        Result.succeed(receipt),
        Object.freeze({
          ...current,
          cancellations: HashMap.set(
            current.cancellations,
            request.ref.cancellationId,
            Object.freeze({ record })
          ),
          issuedExecutions: request.disposition === "Interrupted"
            ? HashMap.set(
              current.issuedExecutions,
              issuedKey,
              Object.freeze({ ...issued, quiescent: true })
            )
            : current.issuedExecutions,
          cancellationAckRequests: HashMap.set(
            current.cancellationAckRequests,
            requestKey,
            Object.freeze({ canonicalRequest, receipt })
          )
        })
      ]
    })
    return yield* Effect.fromResult(result)
  })

  const releaseCancellationClaim: ActivityCancellation.ActivityCancellationDeliveryStore.Service[
    "releaseCancellationClaim"
  ] = Effect.fnUntraced(function*(input) {
    const captured = ActivityCancellation.decodeReleaseCancellationClaimRequest(input)
    if (Result.isFailure(captured)) {
      return yield* Effect.fail(captured.failure)
    }
    const request = captured.success
    const tenantId = request.ref.activityLeaseRef.key.tenantId
    const canonicalRequest = Json.canonicalizeSnapshot(
      request as unknown as Schema.Json
    )
    const requestKey = cancellationRequestStorageKey(
      "releaseCancellationClaim",
      tenantId,
      request.ref.claimantId,
      request.requestId
    )
    const repeated = Option.getOrUndefined(HashMap.get(
      (yield* Ref.get(state)).cancellationReleaseRequests,
      requestKey
    ))
    if (repeated !== undefined) {
      return repeated.canonicalRequest === canonicalRequest
        ? repeated.receipt
        : yield* Effect.fail(
          new ActivityCancellation.CancellationDeliveryRequestConflict({
            operation: "releaseCancellationClaim",
            tenantId,
            requestId: request.requestId
          })
        )
    }
    const now = yield* currentCancellationTime(
      "releaseCancellationClaim"
    )
    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<
        ActivityCancellation.ReleaseCancellationClaimReceipt,
        | ActivityCancellation.CancellationDeliveryStoreError
        | ActivityCancellation.CancellationNotFound
        | ActivityCancellation.StaleCancellationClaim
      >,
      MemoryState
    ] => {
      const exact = Option.getOrUndefined(HashMap.get(
        current.cancellationReleaseRequests,
        requestKey
      ))
      if (exact !== undefined) {
        return exact.canonicalRequest === canonicalRequest
          ? [Result.succeed(exact.receipt), current]
          : [
            Result.fail(
              new ActivityCancellation.CancellationDeliveryRequestConflict({
                operation: "releaseCancellationClaim",
                tenantId,
                requestId: request.requestId
              })
            ),
            current
          ]
      }
      const stored = Option.getOrUndefined(HashMap.get(
        current.cancellations,
        request.ref.cancellationId
      ))
      if (stored === undefined) {
        return [
          Result.fail(
            new ActivityCancellation.CancellationNotFound({
              tenantId,
              cancellationId: request.ref.cancellationId
            })
          ),
          current
        ]
      }
      if (stored.record._tag === "Acknowledged") {
        return [
          Result.fail(
            new ActivityCancellation.StaleCancellationClaim({
              cancellationId: request.ref.cancellationId,
              claimantId: request.ref.claimantId,
              workerIncarnationId: request.ref.workerIncarnationId,
              requestedEpoch: request.ref.claimEpoch,
              currentEpoch: stored.record.ref.claimEpoch,
              reason: "Acknowledged"
            })
          ),
          current
        ]
      }
      if (stored.record._tag === "Pending") {
        if (
          stored.lastReleasedRef === undefined ||
          stored.lastReleaseReceipt === undefined ||
          !sameCancellationClaimRef(
            stored.lastReleasedRef,
            request.ref
          )
        ) {
          return [
            Result.fail(
              new ActivityCancellation.StaleCancellationClaim({
                cancellationId: request.ref.cancellationId,
                claimantId: request.ref.claimantId,
                workerIncarnationId: request.ref.workerIncarnationId,
                requestedEpoch: request.ref.claimEpoch,
                currentEpoch: stored.record.claimEpoch,
                reason: "Superseded"
              })
            ),
            current
          ]
        }
        const receipt: ActivityCancellation.ReleaseCancellationClaimReceipt = Object.freeze({
          ...stored.lastReleaseReceipt,
          requestId: request.requestId
        })
        return [
          Result.succeed(receipt),
          Object.freeze({
            ...current,
            cancellationReleaseRequests: HashMap.set(
              current.cancellationReleaseRequests,
              requestKey,
              Object.freeze({ canonicalRequest, receipt })
            )
          })
        ]
      }
      const reason = !sameCancellationClaimRef(
          stored.record.ref,
          request.ref
        )
        ? "Superseded" as const
        : stored.expiresAtMillis === undefined ||
            stored.expiresAtMillis <= now.millis
        ? "Expired" as const
        : undefined
      if (reason !== undefined) {
        return [
          Result.fail(
            new ActivityCancellation.StaleCancellationClaim({
              cancellationId: request.ref.cancellationId,
              claimantId: request.ref.claimantId,
              workerIncarnationId: request.ref.workerIncarnationId,
              requestedEpoch: request.ref.claimEpoch,
              currentEpoch: stored.record.ref.claimEpoch,
              reason
            })
          ),
          current
        ]
      }
      const receipt: ActivityCancellation.ReleaseCancellationClaimReceipt = Object.freeze({
        receiptVersion: 1,
        requestId: request.requestId,
        ref: request.ref,
        releasedAt: now.timestamp
      })
      const record: ActivityCancellation.PendingCancellation = Object.freeze({
        _tag: "Pending",
        recordVersion: 1,
        issued: stored.record.issued,
        claimEpoch: stored.record.ref.claimEpoch
      })
      return [
        Result.succeed(receipt),
        Object.freeze({
          ...current,
          cancellations: HashMap.set(
            current.cancellations,
            request.ref.cancellationId,
            Object.freeze({
              record,
              lastReleasedRef: request.ref,
              lastReleaseReceipt: receipt
            })
          ),
          cancellationReleaseRequests: HashMap.set(
            current.cancellationReleaseRequests,
            requestKey,
            Object.freeze({ canonicalRequest, receipt })
          )
        })
      ]
    })
    return yield* Effect.fromResult(result)
  })

  const executionStore = ExecutionStore.of(Object.freeze({
    start,
    commitDecision: commitCoordinatedDecision,
    requestCancellation,
    read,
    inspectOutbox
  }))

  const activityDeliveryStore = ActivityDelivery.ActivityDeliveryStore.of(Object.freeze({
    claimOutbox,
    acknowledgePublished,
    releaseOutbox,
    acquireAttempt,
    renewAttempt,
    completeAttempt
  }))

  const activityCancellationDeliveryStore = ActivityCancellation.ActivityCancellationDeliveryStore.of(Object.freeze({
    claimCancellations,
    acknowledgeCancellation,
    releaseCancellationClaim
  }))

  const runCoordinatorStore = RunCoordinator.RunCoordinatorStore.of(Object.freeze({
    claimRunnableRuns,
    renewRunLease,
    releaseRunLease,
    acknowledgeIdle,
    commitDecision: commitCoordinatedDecision
  }))

  const getForRun: PlanStore.PlanStore.Service["getForRun"] = Effect.fnUntraced(function*(input) {
    const snapped = Json.snapshot(input)
    if (Result.isFailure(snapped)) {
      return yield* Effect.fail(
        new PlanStore.PlanStoreFailure({
          operation: "getForRun",
          message: `Run key must be strict JSON: ${snapped.failure.message}`
        })
      )
    }
    const decoded = decodeRunKey(snapped.success)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(
        new PlanStore.PlanStoreFailure({
          operation: "getForRun",
          message: "Invalid tenant-scoped run key",
          cause: { parseError: decoded.failure.message }
        })
      )
    }
    const key = snapped.success as unknown as PlanStore.RunKey
    const current = yield* Ref.get(state)
    const binding = Option.getOrUndefined(HashMap.get(current.bindings, runStorageKey(key)))
    if (binding === undefined) {
      return yield* Effect.fail(new PlanStore.RunBindingNotFound(key))
    }
    const artifact = Option.getOrUndefined(HashMap.get(
      current.artifacts,
      artifactStorageKey(key.tenantId, binding.artifactDigest)
    ))
    if (artifact === undefined) {
      return yield* Effect.fail(
        new PlanStore.ArtifactNotFound({
          tenantId: key.tenantId,
          artifactDigest: binding.artifactDigest
        })
      )
    }
    return Object.freeze({ binding, artifact: artifact.artifact })
  })

  const getArtifact: PlanStore.PlanStore.Service["getArtifact"] = Effect.fnUntraced(function*(input) {
    const snapped = Json.snapshot(input)
    if (Result.isFailure(snapped)) {
      return yield* Effect.fail(
        new PlanStore.PlanStoreFailure({
          operation: "getArtifact",
          message: `Artifact lookup must be strict JSON: ${snapped.failure.message}`
        })
      )
    }
    const Lookup = Schema.Struct({
      tenantId: Schema.NonEmptyString,
      artifactDigest: PlanStore.ArtifactDigest
    })
    const decoded = Schema.decodeUnknownResult(Lookup, strictParseOptions)(snapped.success)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(
        new PlanStore.PlanStoreFailure({
          operation: "getArtifact",
          message: "Invalid artifact lookup",
          cause: { parseError: decoded.failure.message }
        })
      )
    }
    const options = snapped.success as unknown as {
      readonly tenantId: string
      readonly artifactDigest: PlanStore.ArtifactDigest
    }
    const current = yield* Ref.get(state)
    const artifact = Option.getOrUndefined(HashMap.get(
      current.artifacts,
      artifactStorageKey(options.tenantId, options.artifactDigest)
    ))
    if (artifact === undefined) {
      return yield* Effect.fail(new PlanStore.ArtifactNotFound(options))
    }
    return artifact.artifact
  })

  const planStore = PlanStore.PlanStore.of(Object.freeze({ getForRun, getArtifact }))
  return Object.freeze({
    executionStore,
    planStore,
    activityDeliveryStore,
    activityCancellationDeliveryStore,
    runCoordinatorStore
  })
})

/**
 * Constructs only the execution-store facade for convenience.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemoryExecutionStore: Effect.Effect<ExecutionStore.Service, never, Crypto.Crypto> = Effect.map(
  makeMemory,
  ({ executionStore }) => executionStore
)

/**
 * Provides fresh process-local execution and plan-store facades sharing one
 * atomic reference.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<
  | ExecutionStore
  | PlanStore.PlanStore
  | ActivityDelivery.ActivityDeliveryStore
  | ActivityCancellation.ActivityCancellationDeliveryStore
  | RunCoordinator.RunCoordinatorStore,
  never,
  Crypto.Crypto
> = Layer.effectContext(
  Effect.map(
    makeMemory,
    ({
      activityCancellationDeliveryStore,
      activityDeliveryStore,
      executionStore,
      planStore,
      runCoordinatorStore
    }) =>
      Context.make(ExecutionStore, executionStore).pipe(
        Context.add(PlanStore.PlanStore, planStore),
        Context.add(ActivityDelivery.ActivityDeliveryStore, activityDeliveryStore),
        Context.add(
          ActivityCancellation.ActivityCancellationDeliveryStore,
          activityCancellationDeliveryStore
        ),
        Context.add(RunCoordinator.RunCoordinatorStore, runCoordinatorStore)
      )
  )
)
