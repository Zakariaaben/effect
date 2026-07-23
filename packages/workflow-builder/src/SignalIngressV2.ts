/**
 * Strict public signal-admission contracts for execution protocol version `2`.
 *
 * **Details**
 *
 * This module separates caller-supplied request data, trusted transport
 * authentication context, store-assigned receipts, semantic rejections, and
 * transient infrastructure failures. It deliberately does not implement the
 * authoritative transaction.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as PlanStoreV2 from "./PlanStoreV2.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as SignalContractV2 from "./SignalContractV2.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * The public signal-ingress wire version.
 *
 * @category constants
 * @since 4.0.0
 */
export const IngressVersion = 2 as const

/**
 * Caller-supplied intent to admit one external signal.
 *
 * **Details**
 *
 * Identifier, correlation, and payload byte limits are rechecked against the
 * run's immutable signal manifest inside the authoritative transaction. The
 * caller cannot choose acceptance time, ordering, digests, authorization
 * attribution, expiry, timer identity, or history identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Request = Schema.Struct({
  ingressVersion: Schema.Literal(IngressVersion),
  key: PlanStoreV2.RunKey,
  expectedArtifactDigest: ProtocolV2Wire.ArtifactDigest,
  signalId: Schema.NonEmptyString,
  signalName: Schema.NonEmptyString,
  signalVersion: Schema.NonEmptyString,
  correlation: SignalContractV2.SignalCorrelation,
  payload: ProtocolV2Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowSignalIngressRequestV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Request}.
 *
 * @category models
 * @since 4.0.0
 */
export type Request = Schema.Schema.Type<typeof Request>

/**
 * Trusted authentication context supplied out of band by a transport adapter.
 *
 * **Details**
 *
 * This is intentionally not a `Schema` and is not part of {@link Request}.
 * The opaque context may contain claims or capabilities needed by the
 * registered authorization policy, but it must never be copied into history.
 * Only the policy's nonsecret {@link ProtocolV2Wire.AdmissionAttribution}
 * result is persisted.
 *
 * @category models
 * @since 4.0.0
 */
export interface AuthenticatedActor<out AuthenticationContext = unknown> {
  readonly actorId: string
  readonly authenticationContext: AuthenticationContext
}

/**
 * Constructs trusted transport authentication context after authentication.
 *
 * **Details**
 *
 * Calling this function does not authenticate a principal. It is intended for
 * an already-trusted HTTP, queue, or event adapter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeAuthenticatedActor = <AuthenticationContext>(
  actorId: string,
  authenticationContext: AuthenticationContext
): AuthenticatedActor<AuthenticationContext> => ({
  actorId,
  authenticationContext
})

/**
 * Immutable proof that one signal request was durably admitted.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Receipt = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  key: PlanStoreV2.RunKey,
  artifactDigest: ProtocolV2Wire.ArtifactDigest,
  signalDefinitionDigest: ProtocolV2Wire.DefinitionDigest,
  signalId: Schema.NonEmptyString,
  signalName: Schema.NonEmptyString,
  signalVersion: Schema.NonEmptyString,
  requestDigest: ProtocolV2Wire.RequestDigest,
  payloadDigest: ProtocolV2Wire.PayloadDigest,
  encodedPayloadBytes: ProtocolV2Wire.PositiveSafeInt,
  inboxSequence: ProtocolV2Wire.NonNegativeSafeInt,
  historySequence: ProtocolV2Wire.NonNegativeSafeInt,
  acceptedEventId: Schema.NonEmptyString,
  expiryTimerId: Schema.NonEmptyString,
  acceptedAt: ProtocolV2Wire.Timestamp,
  expiresAt: ProtocolV2Wire.Timestamp,
  admission: ProtocolV2Wire.AdmissionAttribution
}).annotate({
  identifier: "WorkflowSignalIngressReceiptV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Receipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type Receipt = Schema.Schema.Type<typeof Receipt>

/**
 * A newly committed signal admission.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Accepted = Schema.TaggedStruct("Accepted", {
  receipt: Receipt
}).annotate({
  identifier: "WorkflowSignalIngressAcceptedV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Accepted}.
 *
 * @category models
 * @since 4.0.0
 */
export type Accepted = Schema.Schema.Type<typeof Accepted>

/**
 * An exact idempotent retry returning the original immutable receipt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Duplicate = Schema.TaggedStruct("Duplicate", {
  receipt: Receipt
}).annotate({
  identifier: "WorkflowSignalIngressDuplicateV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Duplicate}.
 *
 * @category models
 * @since 4.0.0
 */
export type Duplicate = Schema.Schema.Type<typeof Duplicate>

/**
 * A semantic signal-admission rejection.
 *
 * **Details**
 *
 * Rejections contain only a bounded machine-readable reason. Transport
 * adapters decide how much existence information may be revealed to a caller
 * and retain any security audit separately from run history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Rejected = Schema.TaggedStruct("Rejected", {
  reason: SignalContractV2.SignalRejectionReason
}).annotate({
  identifier: "WorkflowSignalIngressRejectedV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Rejected}.
 *
 * @category models
 * @since 4.0.0
 */
export type Rejected = Schema.Schema.Type<typeof Rejected>

/**
 * Complete business result of authoritative signal admission.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AdmissionResult = Schema.Union([
  Accepted,
  Duplicate,
  Rejected
]).annotate({ identifier: "WorkflowSignalIngressAdmissionResultV2" })

/**
 * The decoded type of {@link AdmissionResult}.
 *
 * @category models
 * @since 4.0.0
 */
export type AdmissionResult = Schema.Schema.Type<typeof AdmissionResult>

/**
 * Stable transient signal-ingress failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const UnavailableCodes = {
  ArtifactUnavailable: "ArtifactUnavailable",
  RuntimeDefinitionUnavailable: "RuntimeDefinitionUnavailable",
  AuthorizationUnavailable: "AuthorizationUnavailable",
  BlobUnavailable: "BlobUnavailable",
  StoreUnavailable: "StoreUnavailable"
} as const

/**
 * A stable transient signal-ingress failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type UnavailableCode = typeof UnavailableCodes[keyof typeof UnavailableCodes]

const UnavailableCode = Schema.Literals([
  UnavailableCodes.ArtifactUnavailable,
  UnavailableCodes.RuntimeDefinitionUnavailable,
  UnavailableCodes.AuthorizationUnavailable,
  UnavailableCodes.BlobUnavailable,
  UnavailableCodes.StoreUnavailable
])

/**
 * A retryable inability to decide or durably commit signal admission.
 *
 * @category errors
 * @since 4.0.0
 */
export class SignalIngressUnavailable extends Schema.TaggedErrorClass<SignalIngressUnavailable>(
  "@effect/workflow-builder/SignalIngressV2/SignalIngressUnavailable"
)("SignalIngressUnavailable", {
  code: UnavailableCode,
  message: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Hard transport limit applied to raw bytes before JSON parsing.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RawBodyPolicy = Schema.Struct({
  maximumBytes: ProtocolV2Wire.PositiveSafeInt
}).annotate({
  identifier: "WorkflowSignalIngressRawBodyPolicyV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RawBodyPolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type RawBodyPolicy = Schema.Schema.Type<typeof RawBodyPolicy>

/**
 * Raised before JSON parsing when a raw signal request exceeds its hard limit.
 *
 * **Details**
 *
 * The error retains counts only. It deliberately does not retain the hostile
 * request bytes.
 *
 * @category errors
 * @since 4.0.0
 */
export class RawBodyTooLarge extends Schema.TaggedErrorClass<RawBodyTooLarge>(
  "@effect/workflow-builder/SignalIngressV2/RawBodyTooLarge"
)("RawBodyTooLarge", {
  maximumBytes: ProtocolV2Wire.PositiveSafeInt,
  actualBytes: ProtocolV2Wire.NonNegativeSafeInt
}, { parseOptions: strictParseOptions }) {}

/**
 * Checks raw transport bytes without parsing or retaining their contents.
 *
 * @category validation
 * @since 4.0.0
 */
export const checkRawBodySize = (
  bytes: Uint8Array,
  policy: RawBodyPolicy
): Result.Result<void, RawBodyTooLarge> =>
  bytes.byteLength <= policy.maximumBytes
    ? Result.succeed(undefined)
    : Result.fail(
      new RawBodyTooLarge({
        maximumBytes: policy.maximumBytes,
        actualBytes: bytes.byteLength
      })
    )

/**
 * Authoritative signal-admission service.
 *
 * @category services
 * @since 4.0.0
 */
export class SignalIngressV2 extends Context.Service<SignalIngressV2, SignalIngressV2.Service>()(
  "@effect/workflow-builder/SignalIngressV2"
) {}

/**
 * Service contracts for {@link SignalIngressV2}.
 *
 * @since 4.0.0
 */
export declare namespace SignalIngressV2 {
  /**
   * The signal-admission service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly accept: (
      request: Request,
      actor: AuthenticatedActor
    ) => Effect.Effect<AdmissionResult, SignalIngressUnavailable>
  }
}
