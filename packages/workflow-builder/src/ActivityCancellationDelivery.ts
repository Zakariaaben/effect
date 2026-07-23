/**
 * Fenced activity-cancellation delivery storage contracts.
 *
 * **Details**
 *
 * These schemas describe operational delivery after semantic cancellation is
 * already committed. A run becoming cancelled never waits for a delivery
 * acknowledgement.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityDeliveryStore from "./ActivityDeliveryStore.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Maximum number of cancellation records returned by one claim.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxClaimBatchSize = 1_000 as const

const ClaimBatchSize = ProtocolV2Wire.PositiveSafeInt.check(
  Schema.isLessThanOrEqualTo(MaxClaimBatchSize)
)

/**
 * Reasons that can issue operational activity cancellation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationReason = Schema.Literals([
  "RunCancellationRequested",
  "RunTerminal"
]).annotate({
  identifier: "WorkflowActivityCancellationReason"
})

/**
 * The decoded type of {@link CancellationReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationReason = Schema.Schema.Type<
  typeof CancellationReason
>

/**
 * Coordinates committed by a stable cancellation identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationIdentityCoordinates = Schema.Struct({
  activityLeaseRef: ActivityDeliveryStore.ActivityLeaseRef,
  attemptId: Schema.NonEmptyString,
  attempt: ProtocolV2Wire.PositiveSafeInt,
  logicalActivityId: Schema.NonEmptyString,
  cancellationRequestId: Schema.NonEmptyString,
  sourceEventId: Schema.NonEmptyString,
  reason: CancellationReason
}).annotate({
  identifier: "WorkflowActivityCancellationIdentityCoordinates",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationIdentityCoordinates}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationIdentityCoordinates = Schema.Schema.Type<
  typeof CancellationIdentityCoordinates
>

/**
 * Returns the collision-safe identity of one issued execution cancellation.
 *
 * **Details**
 *
 * The tuple includes every activity lease-generation coordinate plus the
 * semantic attempt and cancellation source. Enqueue time is deliberately
 * absent so an exact retry retains the same identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCancellationId = (
  coordinates: CancellationIdentityCoordinates
): string =>
  JSON.stringify([
    "@effect/workflow-builder",
    2,
    "ActivityCancellationDelivery",
    coordinates.activityLeaseRef.leaseVersion,
    coordinates.activityLeaseRef.key.tenantId,
    coordinates.activityLeaseRef.key.intentId,
    coordinates.activityLeaseRef.workerId,
    coordinates.activityLeaseRef.workerDeploymentId,
    coordinates.activityLeaseRef.deliveryEpoch,
    coordinates.activityLeaseRef.leaseId,
    coordinates.attemptId,
    coordinates.attempt,
    coordinates.logicalActivityId,
    coordinates.cancellationRequestId,
    coordinates.sourceEventId,
    coordinates.reason
  ])

/**
 * One cancellation bound to the exact issued activity execution generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const IssuedExecutionRef = Schema.Struct({
  issuedVersion: Schema.Literal(1),
  ...CancellationIdentityCoordinates.fields,
  cancellationId: Schema.NonEmptyString,
  enqueuedAt: ProtocolV2Wire.Timestamp
}).check(
  Schema.makeFilter(
    (value) => value.cancellationId === makeCancellationId(value),
    { expected: "a cancellationId derived from the exact issued execution" }
  )
).annotate({
  identifier: "WorkflowActivityCancellationIssuedExecutionRef",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link IssuedExecutionRef}.
 *
 * @category models
 * @since 4.0.0
 */
export type IssuedExecutionRef = Schema.Schema.Type<
  typeof IssuedExecutionRef
>

/**
 * Terminal worker dispositions for a delivered cancellation.
 *
 * **Details**
 *
 * `NotRunning` may only be committed after the store authoritatively proves
 * that the exact issued lease generation is not running.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationDisposition = Schema.Literals([
  "Interrupted",
  "AlreadyFinished",
  "NotRunning"
]).annotate({
  identifier: "WorkflowActivityCancellationDisposition"
})

/**
 * The decoded type of {@link CancellationDisposition}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationDisposition = Schema.Schema.Type<
  typeof CancellationDisposition
>

/**
 * Fenced reference to one cancellation claim generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationClaimRef = Schema.Struct({
  claimRefVersion: Schema.Literal(1),
  activityLeaseRef: ActivityDeliveryStore.ActivityLeaseRef,
  attemptId: Schema.NonEmptyString,
  attempt: ProtocolV2Wire.PositiveSafeInt,
  logicalActivityId: Schema.NonEmptyString,
  cancellationId: Schema.NonEmptyString,
  workerIncarnationId: Schema.NonEmptyString,
  claimantId: Schema.NonEmptyString,
  claimEpoch: ProtocolV2Wire.PositiveSafeInt,
  claimLeaseId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowActivityCancellationClaimRef",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationClaimRef}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationClaimRef = Schema.Schema.Type<
  typeof CancellationClaimRef
>

const sameActivityLeaseRef = (
  left: ActivityDeliveryStore.ActivityLeaseRef,
  right: ActivityDeliveryStore.ActivityLeaseRef
): boolean =>
  left.leaseVersion === right.leaseVersion &&
  left.key.tenantId === right.key.tenantId &&
  left.key.intentId === right.key.intentId &&
  left.workerId === right.workerId &&
  left.workerDeploymentId === right.workerDeploymentId &&
  left.deliveryEpoch === right.deliveryEpoch &&
  left.leaseId === right.leaseId

const claimMatchesIssued = (
  ref: CancellationClaimRef,
  issued: IssuedExecutionRef
): boolean =>
  sameActivityLeaseRef(ref.activityLeaseRef, issued.activityLeaseRef) &&
  ref.attemptId === issued.attemptId &&
  ref.attempt === issued.attempt &&
  ref.logicalActivityId === issued.logicalActivityId &&
  ref.cancellationId === issued.cancellationId

const ExactIssuedClaim = Schema.makeFilter(
  (value: {
    readonly ref: CancellationClaimRef
    readonly issued: IssuedExecutionRef
  }) => claimMatchesIssued(value.ref, value.issued),
  { expected: "a claim fence matching the exact issued execution" }
)

/**
 * An issued cancellation waiting to be claimed.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PendingCancellation = Schema.TaggedStruct("Pending", {
  recordVersion: Schema.Literal(1),
  issued: IssuedExecutionRef,
  claimEpoch: ProtocolV2Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowPendingActivityCancellation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link PendingCancellation}.
 *
 * @category models
 * @since 4.0.0
 */
export type PendingCancellation = Schema.Schema.Type<
  typeof PendingCancellation
>

/**
 * An issued cancellation owned by one active claim generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LeasedCancellation = Schema.TaggedStruct("Leased", {
  recordVersion: Schema.Literal(1),
  issued: IssuedExecutionRef,
  ref: CancellationClaimRef,
  claimRequestId: Schema.NonEmptyString,
  leasedAt: ProtocolV2Wire.Timestamp,
  expiresAt: ProtocolV2Wire.Timestamp
}).check(ExactIssuedClaim).annotate({
  identifier: "WorkflowLeasedActivityCancellation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LeasedCancellation}.
 *
 * @category models
 * @since 4.0.0
 */
export type LeasedCancellation = Schema.Schema.Type<
  typeof LeasedCancellation
>

/**
 * An issued cancellation acknowledged under an exact claim generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgedCancellation = Schema.TaggedStruct("Acknowledged", {
  recordVersion: Schema.Literal(1),
  issued: IssuedExecutionRef,
  ref: CancellationClaimRef,
  claimRequestId: Schema.NonEmptyString,
  leasedAt: ProtocolV2Wire.Timestamp,
  expiresAt: ProtocolV2Wire.Timestamp,
  acknowledgeRequestId: Schema.NonEmptyString,
  acknowledgedAt: ProtocolV2Wire.Timestamp,
  disposition: CancellationDisposition
}).check(ExactIssuedClaim).annotate({
  identifier: "WorkflowAcknowledgedActivityCancellation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgedCancellation}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgedCancellation = Schema.Schema.Type<
  typeof AcknowledgedCancellation
>

/**
 * Persisted activity-cancellation delivery state.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationRecord = Schema.Union([
  PendingCancellation,
  LeasedCancellation,
  AcknowledgedCancellation
]).annotate({
  identifier: "WorkflowActivityCancellationRecord",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationRecord}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationRecord = Schema.Schema.Type<
  typeof CancellationRecord
>

/**
 * Claims a bounded batch for one exact worker incarnation and deployment.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClaimCancellationsRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  tenantId: Schema.NonEmptyString,
  workerId: Schema.NonEmptyString,
  workerIncarnationId: Schema.NonEmptyString,
  workerDeploymentId: Schema.NonEmptyString,
  claimantId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  limit: ClaimBatchSize,
  leaseDurationMillis: ProtocolV2Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowClaimActivityCancellationsRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ClaimCancellationsRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ClaimCancellationsRequest = Schema.Schema.Type<
  typeof ClaimCancellationsRequest
>

/**
 * One issued cancellation plus its current claim fence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationClaim = Schema.Struct({
  claimVersion: Schema.Literal(1),
  ref: CancellationClaimRef,
  issued: IssuedExecutionRef,
  claimRequestId: Schema.NonEmptyString,
  leasedAt: ProtocolV2Wire.Timestamp,
  expiresAt: ProtocolV2Wire.Timestamp
}).check(ExactIssuedClaim).annotate({
  identifier: "WorkflowActivityCancellationClaim",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationClaim}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationClaim = Schema.Schema.Type<
  typeof CancellationClaim
>

/**
 * Exact-retry-safe receipt for one cancellation claim request.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClaimCancellationsReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  tenantId: Schema.NonEmptyString,
  workerId: Schema.NonEmptyString,
  workerIncarnationId: Schema.NonEmptyString,
  workerDeploymentId: Schema.NonEmptyString,
  claimantId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  claims: Schema.Array(CancellationClaim)
}).annotate({
  identifier: "WorkflowClaimActivityCancellationsReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ClaimCancellationsReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ClaimCancellationsReceipt = Schema.Schema.Type<
  typeof ClaimCancellationsReceipt
>

/**
 * Acknowledges cancellation delivery under the current claim fence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeCancellationRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  requestId: Schema.NonEmptyString,
  ref: CancellationClaimRef,
  disposition: CancellationDisposition
}).annotate({
  identifier: "WorkflowAcknowledgeActivityCancellationRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgeCancellationRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgeCancellationRequest = Schema.Schema.Type<
  typeof AcknowledgeCancellationRequest
>

/**
 * Receipt for one acknowledged cancellation claim.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeCancellationReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  requestId: Schema.NonEmptyString,
  ref: CancellationClaimRef,
  disposition: CancellationDisposition,
  acknowledgedAt: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowAcknowledgeActivityCancellationReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgeCancellationReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgeCancellationReceipt = Schema.Schema.Type<
  typeof AcknowledgeCancellationReceipt
>

/**
 * Releases one cancellation claim before its lease expires.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReleaseCancellationClaimRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  requestId: Schema.NonEmptyString,
  ref: CancellationClaimRef
}).annotate({
  identifier: "WorkflowReleaseActivityCancellationClaimRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ReleaseCancellationClaimRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ReleaseCancellationClaimRequest = Schema.Schema.Type<
  typeof ReleaseCancellationClaimRequest
>

/**
 * Receipt for one released cancellation claim generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ReleaseCancellationClaimReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  requestId: Schema.NonEmptyString,
  ref: CancellationClaimRef,
  releasedAt: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowReleaseActivityCancellationClaimReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ReleaseCancellationClaimReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ReleaseCancellationClaimReceipt = Schema.Schema.Type<
  typeof ReleaseCancellationClaimReceipt
>

/**
 * Cancellation-delivery storage operation names.
 *
 * @category models
 * @since 4.0.0
 */
export type Operation =
  | "claimCancellations"
  | "acknowledgeCancellation"
  | "releaseCancellationClaim"

const Operation = Schema.Literals([
  "claimCancellations",
  "acknowledgeCancellation",
  "releaseCancellationClaim"
])

/**
 * Raised when a cancellation-delivery request is not strict JSON or violates
 * its operation schema.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidCancellationDeliveryRequest extends Schema.TaggedErrorClass<
  InvalidCancellationDeliveryRequest
>("@effect/workflow-builder/ActivityCancellationDelivery/InvalidRequest")(
  "InvalidCancellationDeliveryRequest",
  {
    operation: Operation,
    message: Schema.NonEmptyString,
    details: Schema.optionalKey(Schema.Json)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when a caller-owned request identity is reused with different input.
 *
 * @category errors
 * @since 4.0.0
 */
export class CancellationDeliveryRequestConflict extends Schema.TaggedErrorClass<
  CancellationDeliveryRequestConflict
>("@effect/workflow-builder/ActivityCancellationDelivery/RequestConflict")(
  "CancellationDeliveryRequestConflict",
  {
    operation: Operation,
    tenantId: Schema.NonEmptyString,
    requestId: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when an issued cancellation cannot be found.
 *
 * @category errors
 * @since 4.0.0
 */
export class CancellationNotFound extends Schema.TaggedErrorClass<
  CancellationNotFound
>("@effect/workflow-builder/ActivityCancellationDelivery/NotFound")(
  "CancellationNotFound",
  {
    tenantId: Schema.NonEmptyString,
    cancellationId: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when an unexpired claim is owned by another claimant generation.
 *
 * @category errors
 * @since 4.0.0
 */
export class CancellationClaimBusy extends Schema.TaggedErrorClass<
  CancellationClaimBusy
>("@effect/workflow-builder/ActivityCancellationDelivery/ClaimBusy")(
  "CancellationClaimBusy",
  {
    cancellationId: Schema.NonEmptyString,
    claimantId: Schema.NonEmptyString,
    workerIncarnationId: Schema.NonEmptyString,
    claimEpoch: ProtocolV2Wire.PositiveSafeInt,
    expiresAt: ProtocolV2Wire.Timestamp
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when a cancellation claim is expired, released, or superseded.
 *
 * @category errors
 * @since 4.0.0
 */
export class StaleCancellationClaim extends Schema.TaggedErrorClass<
  StaleCancellationClaim
>("@effect/workflow-builder/ActivityCancellationDelivery/StaleClaim")(
  "StaleCancellationClaim",
  {
    cancellationId: Schema.NonEmptyString,
    claimantId: Schema.NonEmptyString,
    workerIncarnationId: Schema.NonEmptyString,
    requestedEpoch: ProtocolV2Wire.PositiveSafeInt,
    currentEpoch: ProtocolV2Wire.NonNegativeSafeInt,
    reason: Schema.Literals([
      "Expired",
      "Released",
      "Superseded",
      "Acknowledged"
    ])
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when an acknowledged cancellation is retried with a new disposition.
 *
 * @category errors
 * @since 4.0.0
 */
export class CancellationDispositionConflict extends Schema.TaggedErrorClass<
  CancellationDispositionConflict
>("@effect/workflow-builder/ActivityCancellationDelivery/DispositionConflict")(
  "CancellationDispositionConflict",
  {
    cancellationId: Schema.NonEmptyString,
    existing: CancellationDisposition,
    requested: CancellationDisposition
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when cancellation-delivery storage cannot safely perform an
 * operation.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityCancellationDeliveryStoreFailure extends Schema.TaggedErrorClass<
  ActivityCancellationDeliveryStoreFailure
>("@effect/workflow-builder/ActivityCancellationDelivery/StoreFailure")(
  "ActivityCancellationDeliveryStoreFailure",
  {
    operation: Operation,
    message: Schema.NonEmptyString,
    cause: Schema.optionalKey(Schema.Json)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Failures common to cancellation-delivery store operations.
 *
 * @category errors
 * @since 4.0.0
 */
export type CancellationDeliveryStoreError =
  | InvalidCancellationDeliveryRequest
  | CancellationDeliveryRequestConflict
  | ActivityCancellationDeliveryStoreFailure

const decodeClaimCancellations = Schema.decodeUnknownResult(
  ClaimCancellationsRequest,
  strictParseOptions
)
const decodeAcknowledgeCancellation = Schema.decodeUnknownResult(
  AcknowledgeCancellationRequest,
  strictParseOptions
)
const decodeReleaseCancellation = Schema.decodeUnknownResult(
  ReleaseCancellationClaimRequest,
  strictParseOptions
)

const decodeRequest = <A>(
  operation: Operation,
  input: unknown,
  decode: (input: unknown) => Result.Result<A, unknown>
): Result.Result<A, InvalidCancellationDeliveryRequest> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(
      new InvalidCancellationDeliveryRequest({
        operation,
        message: "Cancellation-delivery request must be detached strict JSON",
        details: {
          issue: snapshot.failure.message,
          path: snapshot.failure.path
        }
      })
    )
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = decode(snapshot.success)
  } catch {
    return Result.fail(
      new InvalidCancellationDeliveryRequest({
        operation,
        message: "Cancellation-delivery request schema validation failed"
      })
    )
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InvalidCancellationDeliveryRequest({
        operation,
        message: "Invalid cancellation-delivery request"
      })
    )
  }
  return Result.succeed(decoded.success)
}

/**
 * Safely decodes one bounded cancellation claim request.
 *
 * @category validation
 * @since 4.0.0
 */
export const decodeClaimCancellationsRequest = (
  input: unknown
): Result.Result<
  ClaimCancellationsRequest,
  InvalidCancellationDeliveryRequest
> => decodeRequest("claimCancellations", input, decodeClaimCancellations)

/**
 * Safely decodes one fenced cancellation acknowledgement request.
 *
 * @category validation
 * @since 4.0.0
 */
export const decodeAcknowledgeCancellationRequest = (
  input: unknown
): Result.Result<
  AcknowledgeCancellationRequest,
  InvalidCancellationDeliveryRequest
> =>
  decodeRequest(
    "acknowledgeCancellation",
    input,
    decodeAcknowledgeCancellation
  )

/**
 * Safely decodes one fenced cancellation-claim release request.
 *
 * @category validation
 * @since 4.0.0
 */
export const decodeReleaseCancellationClaimRequest = (
  input: unknown
): Result.Result<
  ReleaseCancellationClaimRequest,
  InvalidCancellationDeliveryRequest
> =>
  decodeRequest(
    "releaseCancellationClaim",
    input,
    decodeReleaseCancellation
  )

/**
 * Storage authority for fenced operational activity cancellation delivery.
 *
 * **Details**
 *
 * Implementations must select and mutate records transactionally. An
 * acknowledgement is operational evidence only and cannot gate semantic
 * `RunCancelled`. `NotRunning` requires a store-authoritative check of the
 * exact issued activity lease generation.
 *
 * @category services
 * @since 4.0.0
 */
export class ActivityCancellationDeliveryStore extends Context.Service<
  ActivityCancellationDeliveryStore,
  ActivityCancellationDeliveryStore.Service
>()("@effect/workflow-builder/ActivityCancellationDeliveryStore") {}

/**
 * Service contracts for {@link ActivityCancellationDeliveryStore}.
 *
 * @since 4.0.0
 */
export declare namespace ActivityCancellationDeliveryStore {
  /**
   * Cancellation-delivery store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly claimCancellations: (
      request: ClaimCancellationsRequest
    ) => Effect.Effect<
      ClaimCancellationsReceipt,
      CancellationDeliveryStoreError | CancellationClaimBusy
    >
    readonly acknowledgeCancellation: (
      request: AcknowledgeCancellationRequest
    ) => Effect.Effect<
      AcknowledgeCancellationReceipt,
      | CancellationDeliveryStoreError
      | CancellationNotFound
      | StaleCancellationClaim
      | CancellationDispositionConflict
    >
    readonly releaseCancellationClaim: (
      request: ReleaseCancellationClaimRequest
    ) => Effect.Effect<
      ReleaseCancellationClaimReceipt,
      | CancellationDeliveryStoreError
      | CancellationNotFound
      | StaleCancellationClaim
    >
  }
}
