/**
 * Transactional relay, worker-lease, and fenced activity-completion contracts.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Dispatch from "./Dispatch.ts"
import * as Event from "./Event.ts"
import * as Fingerprint from "./Fingerprint.ts"

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
 * Maximum number of outbox records returned by one relay claim.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxClaimBatchSize = 1_000

const ClaimBatchSize = PositiveSafeInt.check(
  Schema.isLessThanOrEqualTo(MaxClaimBatchSize)
)

/**
 * Claims a bounded deterministic batch of unpublished outbox records.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClaimOutboxRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  tenantId: Schema.NonEmptyString,
  relayId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  queue: Schema.optionalKey(Schema.NonEmptyString),
  limit: ClaimBatchSize,
  leaseDurationMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowClaimOutboxRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ClaimOutboxRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ClaimOutboxRequest = Schema.Schema.Type<typeof ClaimOutboxRequest>

/**
 * Fenced reference to one relay ownership generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RelayLeaseRef = Schema.Struct({
  leaseVersion: Schema.Literal(1),
  key: Dispatch.DispatchKey,
  relayId: Schema.NonEmptyString,
  relayEpoch: PositiveSafeInt,
  leaseId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowRelayLeaseRef",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RelayLeaseRef}.
 *
 * @category models
 * @since 4.0.0
 */
export type RelayLeaseRef = Schema.Schema.Type<typeof RelayLeaseRef>

/**
 * One authoritative dispatch leased to an outbox relay.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RelayClaim = Schema.Struct({
  claimVersion: Schema.Literal(1),
  ref: RelayLeaseRef,
  pointer: Dispatch.DispatchPointer,
  dispatch: Dispatch.ActivityDispatch,
  leasedAt: Event.Timestamp,
  expiresAt: Event.Timestamp
}).annotate({
  identifier: "WorkflowRelayClaim",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RelayClaim}.
 *
 * @category models
 * @since 4.0.0
 */
export type RelayClaim = Schema.Schema.Type<typeof RelayClaim>

/**
 * Exact-retry-safe receipt for one outbox claim request.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClaimOutboxReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  tenantId: Schema.NonEmptyString,
  relayId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  claims: Schema.Array(RelayClaim)
}).annotate({
  identifier: "WorkflowClaimOutboxReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ClaimOutboxReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ClaimOutboxReceipt = Schema.Schema.Type<typeof ClaimOutboxReceipt>

/**
 * Records successful publication of one fenced relay claim.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgePublishedRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: RelayLeaseRef,
  brokerReceipt: Schema.Json
}).annotate({
  identifier: "WorkflowAcknowledgePublishedRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgePublishedRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgePublishedRequest = Schema.Schema.Type<typeof AcknowledgePublishedRequest>

/**
 * Receipt proving that a relay ownership generation was marked published.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PublishReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  ref: RelayLeaseRef,
  publishedAt: Event.Timestamp,
  brokerReceipt: Schema.Json
}).annotate({
  identifier: "WorkflowPublishReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link PublishReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type PublishReceipt = Schema.Schema.Type<typeof PublishReceipt>

/**
 * Releases an unpublished relay claim before its lease expires.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReleaseOutboxRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: RelayLeaseRef
}).annotate({
  identifier: "WorkflowReleaseOutboxRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ReleaseOutboxRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ReleaseOutboxRequest = Schema.Schema.Type<typeof ReleaseOutboxRequest>

/**
 * Acquires one operational delivery generation for committed activity work.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcquireAttemptRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  key: Dispatch.DispatchKey,
  dispatchDigest: Fingerprint.Digest,
  workerId: Schema.NonEmptyString,
  workerQueue: Schema.NonEmptyString,
  workerDeploymentId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  leaseDurationMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowAcquireActivityAttemptRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcquireAttemptRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcquireAttemptRequest = Schema.Schema.Type<typeof AcquireAttemptRequest>

/**
 * Unforgeable process-external capability for one worker ownership generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityLeaseRef = Schema.Struct({
  leaseVersion: Schema.Literal(1),
  key: Dispatch.DispatchKey,
  workerId: Schema.NonEmptyString,
  workerDeploymentId: Schema.NonEmptyString,
  deliveryEpoch: PositiveSafeInt,
  leaseId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowActivityLeaseRef",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityLeaseRef}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityLeaseRef = Schema.Schema.Type<typeof ActivityLeaseRef>

/**
 * Canonical activity work plus its current operational fence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityLease = Schema.Struct({
  leaseVersion: Schema.Literal(1),
  requestId: Schema.NonEmptyString,
  ref: ActivityLeaseRef,
  pointer: Dispatch.DispatchPointer,
  dispatch: Dispatch.ActivityDispatch,
  leasedAt: Event.Timestamp,
  expiresAt: Event.Timestamp
}).annotate({
  identifier: "WorkflowActivityLease",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityLease}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityLease = Schema.Schema.Type<typeof ActivityLease>

/**
 * Renews the current worker lease without changing its delivery epoch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RenewAttemptRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: ActivityLeaseRef,
  requestId: Schema.NonEmptyString,
  leaseDurationMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowRenewActivityAttemptRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RenewAttemptRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RenewAttemptRequest = Schema.Schema.Type<typeof RenewAttemptRequest>

/**
 * Commits one worker result under the current activity fence.
 *
 * **Details**
 *
 * The caller supplies encoded result data, never an event draft. Storage derives
 * the activity, event, causation, run, sequence, and timestamp identities from
 * the canonical dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompleteAttemptRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  ref: ActivityLeaseRef,
  requestId: Schema.NonEmptyString,
  result: Dispatch.ActivityResult
}).annotate({
  identifier: "WorkflowCompleteActivityAttemptRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompleteAttemptRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompleteAttemptRequest = Schema.Schema.Type<typeof CompleteAttemptRequest>

/**
 * Receipt for one accepted, storage-atomic activity result.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompletionReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  key: Dispatch.DispatchKey,
  requestId: Schema.NonEmptyString,
  previousSequence: PositiveSafeInt,
  lastSequence: PositiveSafeInt,
  event: Event.Event
}).annotate({
  identifier: "WorkflowActivityCompletionReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompletionReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompletionReceipt = Schema.Schema.Type<typeof CompletionReceipt>

/**
 * Stable activity-delivery storage operation names.
 *
 * @category models
 * @since 4.0.0
 */
export type Operation =
  | "claimOutbox"
  | "acknowledgePublished"
  | "releaseOutbox"
  | "acquireAttempt"
  | "renewAttempt"
  | "completeAttempt"

const Operation = Schema.Literals([
  "claimOutbox",
  "acknowledgePublished",
  "releaseOutbox",
  "acquireAttempt",
  "renewAttempt",
  "completeAttempt"
])

/**
 * Raised when a delivery request is not detached strict JSON or violates its
 * operation schema.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidDeliveryRequest extends Schema.TaggedErrorClass<InvalidDeliveryRequest>(
  "@effect/workflow-builder/ActivityDeliveryStore/InvalidDeliveryRequest"
)("InvalidDeliveryRequest", {
  operation: Operation,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a tenant-scoped dispatch does not exist.
 *
 * @category errors
 * @since 4.0.0
 */
export class DispatchNotFound extends Schema.TaggedErrorClass<DispatchNotFound>(
  "@effect/workflow-builder/ActivityDeliveryStore/DispatchNotFound"
)("DispatchNotFound", Dispatch.DispatchKey.fields, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a stable request identity is reused with different content.
 *
 * @category errors
 * @since 4.0.0
 */
export class DeliveryRequestConflict extends Schema.TaggedErrorClass<DeliveryRequestConflict>(
  "@effect/workflow-builder/ActivityDeliveryStore/DeliveryRequestConflict"
)("DeliveryRequestConflict", {
  operation: Operation,
  tenantId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when relay ownership is stale, expired, released, or superseded.
 *
 * @category errors
 * @since 4.0.0
 */
export class StaleRelayLease extends Schema.TaggedErrorClass<StaleRelayLease>(
  "@effect/workflow-builder/ActivityDeliveryStore/StaleRelayLease"
)("StaleRelayLease", {
  key: Dispatch.DispatchKey,
  relayId: Schema.NonEmptyString,
  requestedEpoch: PositiveSafeInt,
  currentEpoch: NonNegativeSafeInt,
  reason: Schema.Literals(["Expired", "Released", "Superseded", "Published"])
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when current unexpired activity work is owned by another claim.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityLeaseBusy extends Schema.TaggedErrorClass<ActivityLeaseBusy>(
  "@effect/workflow-builder/ActivityDeliveryStore/ActivityLeaseBusy"
)("ActivityLeaseBusy", {
  key: Dispatch.DispatchKey,
  workerId: Schema.NonEmptyString,
  deliveryEpoch: PositiveSafeInt,
  expiresAt: Event.Timestamp
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a worker capability is stale, expired, superseded, or fenced by
 * cancellation or terminal run state.
 *
 * @category errors
 * @since 4.0.0
 */
export class StaleActivityLease extends Schema.TaggedErrorClass<StaleActivityLease>(
  "@effect/workflow-builder/ActivityDeliveryStore/StaleActivityLease"
)("StaleActivityLease", {
  key: Dispatch.DispatchKey,
  workerId: Schema.NonEmptyString,
  requestedEpoch: PositiveSafeInt,
  currentEpoch: NonNegativeSafeInt,
  reason: Schema.Literals([
    "Expired",
    "Superseded",
    "Completed",
    "CancellationRequested",
    "RunTerminal"
  ])
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a worker targets a deployment or digest different from the
 * committed dispatch.
 *
 * @category errors
 * @since 4.0.0
 */
export class DispatchPinMismatch extends Schema.TaggedErrorClass<DispatchPinMismatch>(
  "@effect/workflow-builder/ActivityDeliveryStore/DispatchPinMismatch"
)("DispatchPinMismatch", {
  key: Dispatch.DispatchKey,
  field: Schema.Literals(["dispatchDigest", "workerQueue", "workerDeploymentId"]),
  expected: Schema.NonEmptyString,
  requested: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a result arrives after cancellation, terminal state, resolution,
 * or without its matching semantic schedule.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityCompletionSuppressed extends Schema.TaggedErrorClass<ActivityCompletionSuppressed>(
  "@effect/workflow-builder/ActivityDeliveryStore/ActivityCompletionSuppressed"
)("ActivityCompletionSuppressed", {
  key: Dispatch.DispatchKey,
  reason: Schema.Literals([
    "CancellationRequested",
    "RunTerminal",
    "AlreadyResolved",
    "NotScheduled"
  ])
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a stable completion identity carries different result content.
 *
 * @category errors
 * @since 4.0.0
 */
export class ConflictingCompletion extends Schema.TaggedErrorClass<ConflictingCompletion>(
  "@effect/workflow-builder/ActivityDeliveryStore/ConflictingCompletion"
)("ConflictingCompletion", {
  key: Dispatch.DispatchKey,
  existingRequestId: Schema.NonEmptyString,
  requestedRequestId: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when activity-delivery storage cannot safely perform an operation.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityDeliveryStoreFailure extends Schema.TaggedErrorClass<ActivityDeliveryStoreFailure>(
  "@effect/workflow-builder/ActivityDeliveryStore/ActivityDeliveryStoreFailure"
)("ActivityDeliveryStoreFailure", {
  operation: Operation,
  message: Schema.NonEmptyString,
  cause: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Failures common to activity-delivery storage operations.
 *
 * @category errors
 * @since 4.0.0
 */
export type DeliveryStoreError =
  | InvalidDeliveryRequest
  | DispatchNotFound
  | DeliveryRequestConflict
  | ActivityDeliveryStoreFailure

/**
 * Storage authority for relay state, worker leases, and fenced result commits.
 *
 * **Details**
 *
 * An implementation must share one transactional authority with semantic
 * history and its activity outbox. In particular, `completeAttempt` may not be
 * implemented as a lease read followed by an unrelated history append.
 *
 * @category services
 * @since 4.0.0
 */
export class ActivityDeliveryStore extends Context.Service<
  ActivityDeliveryStore,
  ActivityDeliveryStore.Service
>()("@effect/workflow-builder/ActivityDeliveryStore") {}

/**
 * Service contracts for {@link ActivityDeliveryStore}.
 *
 * @since 4.0.0
 */
export declare namespace ActivityDeliveryStore {
  /**
   * The activity-delivery store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly claimOutbox: (
      request: ClaimOutboxRequest
    ) => Effect.Effect<ClaimOutboxReceipt, DeliveryStoreError>
    readonly acknowledgePublished: (
      request: AcknowledgePublishedRequest
    ) => Effect.Effect<PublishReceipt, DeliveryStoreError | StaleRelayLease>
    readonly releaseOutbox: (
      request: ReleaseOutboxRequest
    ) => Effect.Effect<void, DeliveryStoreError | StaleRelayLease>
    readonly acquireAttempt: (
      request: AcquireAttemptRequest
    ) => Effect.Effect<
      ActivityLease,
      | DeliveryStoreError
      | ActivityLeaseBusy
      | DispatchPinMismatch
      | ActivityCompletionSuppressed
    >
    readonly renewAttempt: (
      request: RenewAttemptRequest
    ) => Effect.Effect<ActivityLease, DeliveryStoreError | StaleActivityLease>
    readonly completeAttempt: (
      request: CompleteAttemptRequest
    ) => Effect.Effect<
      CompletionReceipt,
      | DeliveryStoreError
      | StaleActivityLease
      | ActivityCompletionSuppressed
      | ConflictingCompletion
    >
  }
}
