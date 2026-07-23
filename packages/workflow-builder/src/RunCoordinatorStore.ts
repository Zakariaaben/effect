/**
 * Tenant-scoped runnable-run discovery and fenced decision coordination.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Event from "./Event.ts"
import type * as ExecutionStore from "./ExecutionStore.ts"
import * as PlanStore from "./PlanStore.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Maximum number of runnable runs returned by one coordinator claim.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxClaimBatchSize = 1_000

const ClaimBatchSize = PositiveSafeInt.check(
  Schema.isLessThanOrEqualTo(MaxClaimBatchSize)
)

/**
 * Coordinator-store operation names used by typed failures.
 *
 * @category models
 * @since 4.0.0
 */
export type Operation =
  | "claimRunnableRuns"
  | "renewRunLease"
  | "releaseRunLease"
  | "acknowledgeIdle"
  | "commitDecision"

const Operation = Schema.Literals([
  "claimRunnableRuns",
  "renewRunLease",
  "releaseRunLease",
  "acknowledgeIdle",
  "commitDecision"
])

/**
 * Claims a bounded deterministic batch of runnable runs for one tenant.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClaimRunnableRunsRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  tenantId: Schema.NonEmptyString,
  coordinatorId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  limit: ClaimBatchSize,
  leaseDurationMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowClaimRunnableRunsRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ClaimRunnableRunsRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ClaimRunnableRunsRequest = Schema.Schema.Type<typeof ClaimRunnableRunsRequest>

/**
 * Unforgeable reference to one coordinator ownership generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunLeaseRef = Schema.Struct({
  leaseVersion: Schema.Literal(1),
  key: PlanStore.RunKey,
  coordinatorId: Schema.NonEmptyString,
  coordinatorEpoch: PositiveSafeInt,
  leaseId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowRunCoordinatorLeaseRef",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunLeaseRef}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunLeaseRef = Schema.Schema.Type<typeof RunLeaseRef>

/**
 * A runnable run together with its current coordinator fence.
 *
 * **Details**
 *
 * `observedLastSequence` is a discovery hint, not an authorization token. A
 * coordinator must recover the latest history and submit that exact sequence;
 * the store rechecks both the sequence and lease in its atomic commit.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunLease = Schema.Struct({
  leaseVersion: Schema.Literal(1),
  requestId: Schema.NonEmptyString,
  ref: RunLeaseRef,
  observedLastSequence: NonNegativeSafeInt,
  leasedAt: Event.Timestamp,
  expiresAt: Event.Timestamp
}).annotate({
  identifier: "WorkflowRunCoordinatorLease",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunLease}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunLease = Schema.Schema.Type<typeof RunLease>

/**
 * Exact-retry-safe result of one bounded runnable-run claim.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClaimRunnableRunsReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  tenantId: Schema.NonEmptyString,
  coordinatorId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  leases: Schema.Array(RunLease)
}).annotate({
  identifier: "WorkflowClaimRunnableRunsReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ClaimRunnableRunsReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ClaimRunnableRunsReceipt = Schema.Schema.Type<typeof ClaimRunnableRunsReceipt>

/**
 * Renews the current coordinator generation without changing its fence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RenewRunLeaseRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: RunLeaseRef,
  requestId: Schema.NonEmptyString,
  leaseDurationMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowRenewRunCoordinatorLeaseRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RenewRunLeaseRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RenewRunLeaseRequest = Schema.Schema.Type<typeof RenewRunLeaseRequest>

/**
 * Releases a current coordinator generation while leaving the run runnable.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReleaseRunLeaseRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: RunLeaseRef,
  requestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowReleaseRunCoordinatorLeaseRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ReleaseRunLeaseRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ReleaseRunLeaseRequest = Schema.Schema.Type<typeof ReleaseRunLeaseRequest>

/**
 * Receipt for an exact coordinator release.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReleaseRunLeaseReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  ref: RunLeaseRef,
  requestId: Schema.NonEmptyString,
  releasedAt: Event.Timestamp
}).annotate({
  identifier: "WorkflowReleaseRunCoordinatorLeaseReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ReleaseRunLeaseReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ReleaseRunLeaseReceipt = Schema.Schema.Type<typeof ReleaseRunLeaseReceipt>

/**
 * Clears a runnable wakeup only if no history arrived after recovery.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeIdleRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: RunLeaseRef,
  requestId: Schema.NonEmptyString,
  observedLastSequence: NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowAcknowledgeIdleRunRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgeIdleRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgeIdleRequest = Schema.Schema.Type<typeof AcknowledgeIdleRequest>

/**
 * Receipt proving that one unchanged runnable wakeup was consumed.
 *
 * @category schemas
 * @since 4.0.0
 */
export const IdleReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  ref: RunLeaseRef,
  requestId: Schema.NonEmptyString,
  observedLastSequence: NonNegativeSafeInt,
  acknowledgedAt: Event.Timestamp
}).annotate({
  identifier: "WorkflowAcknowledgeIdleRunReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link IdleReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type IdleReceipt = Schema.Schema.Type<typeof IdleReceipt>

/**
 * Strict outer envelope for a fenced decision commit.
 *
 * **Details**
 *
 * The nested decision remains `Schema.Json` here to avoid a runtime module
 * cycle; the execution store validates it with its full strict schema before
 * mutation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CommitDecisionRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: RunLeaseRef,
  requestId: Schema.NonEmptyString,
  commit: Schema.Json
}).annotate({
  identifier: "WorkflowCommitFencedDecisionRequest",
  parseOptions: strictParseOptions
})

/**
 * A fenced decision commit with the execution store's narrowed commit type.
 *
 * @category models
 * @since 4.0.0
 */
export type CommitDecisionRequest =
  & Omit<
    Schema.Schema.Type<typeof CommitDecisionRequest>,
    "commit"
  >
  & {
    readonly commit: ExecutionStore.DecisionCommitDraft
  }

/**
 * Raised when a coordinator request cannot be safely decoded.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidCoordinatorRequest extends Schema.TaggedErrorClass<InvalidCoordinatorRequest>(
  "@effect/workflow-builder/RunCoordinatorStore/InvalidCoordinatorRequest"
)("InvalidCoordinatorRequest", {
  operation: Operation,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when an exact request identity is reused with different content.
 *
 * @category errors
 * @since 4.0.0
 */
export class CoordinatorRequestConflict extends Schema.TaggedErrorClass<CoordinatorRequestConflict>(
  "@effect/workflow-builder/RunCoordinatorStore/CoordinatorRequestConflict"
)("CoordinatorRequestConflict", {
  operation: Operation,
  coordinatorId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a different coordinator currently owns an unexpired run lease.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunLeaseBusy extends Schema.TaggedErrorClass<RunLeaseBusy>(
  "@effect/workflow-builder/RunCoordinatorStore/RunLeaseBusy"
)("RunLeaseBusy", {
  key: PlanStore.RunKey,
  coordinatorId: Schema.NonEmptyString,
  expiresAt: Event.Timestamp
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a coordinator fence is missing, expired, or superseded.
 *
 * @category errors
 * @since 4.0.0
 */
export class StaleRunLease extends Schema.TaggedErrorClass<StaleRunLease>(
  "@effect/workflow-builder/RunCoordinatorStore/StaleRunLease"
)("StaleRunLease", {
  key: PlanStore.RunKey,
  coordinatorId: Schema.NonEmptyString,
  coordinatorEpoch: PositiveSafeInt
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when history advanced after a coordinator's recovered observation.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunSequenceAdvanced extends Schema.TaggedErrorClass<RunSequenceAdvanced>(
  "@effect/workflow-builder/RunCoordinatorStore/RunSequenceAdvanced"
)("RunSequenceAdvanced", {
  key: PlanStore.RunKey,
  observedLastSequence: NonNegativeSafeInt,
  actualLastSequence: NonNegativeSafeInt
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when the reference implementation cannot safely coordinate a run.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunCoordinatorStoreFailure extends Schema.TaggedErrorClass<RunCoordinatorStoreFailure>(
  "@effect/workflow-builder/RunCoordinatorStore/RunCoordinatorStoreFailure"
)("RunCoordinatorStoreFailure", {
  operation: Operation,
  message: Schema.NonEmptyString,
  cause: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Common coordinator request failures.
 *
 * @category errors
 * @since 4.0.0
 */
export type CoordinatorError =
  | InvalidCoordinatorRequest
  | CoordinatorRequestConflict
  | StaleRunLease
  | RunCoordinatorStoreFailure

/**
 * Atomic runnable discovery and fenced decision storage.
 *
 * @category services
 * @since 4.0.0
 */
export class RunCoordinatorStore extends Context.Service<RunCoordinatorStore, {
  readonly claimRunnableRuns: (
    request: ClaimRunnableRunsRequest
  ) => Effect.Effect<
    ClaimRunnableRunsReceipt,
    InvalidCoordinatorRequest | CoordinatorRequestConflict | RunCoordinatorStoreFailure
  >
  readonly renewRunLease: (
    request: RenewRunLeaseRequest
  ) => Effect.Effect<RunLease, CoordinatorError | ExecutionStore.RunNotFound>
  readonly releaseRunLease: (
    request: ReleaseRunLeaseRequest
  ) => Effect.Effect<ReleaseRunLeaseReceipt, CoordinatorError | ExecutionStore.RunNotFound>
  readonly acknowledgeIdle: (
    request: AcknowledgeIdleRequest
  ) => Effect.Effect<IdleReceipt, CoordinatorError | RunSequenceAdvanced | ExecutionStore.RunNotFound>
  readonly commitDecision: (
    request: CommitDecisionRequest
  ) => Effect.Effect<
    ExecutionStore.DecisionCommitReceipt,
    CoordinatorError | ExecutionStore.DecisionCommitError
  >
}>()("@effect/workflow-builder/RunCoordinatorStore") {}
