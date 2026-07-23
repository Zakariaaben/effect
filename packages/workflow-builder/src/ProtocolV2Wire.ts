/**
 * Dependency-free JSON wire primitives shared by execution protocol version `2`.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const sha256Pattern = /^sha256:[0-9a-f]{64}$/
const isoTimestampPattern = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

const hasValidCalendarDate = (value: string): boolean => {
  const match = isoTimestampPattern.exec(value)
  if (match === null) {
    return true
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]!
}

/**
 * A non-negative integer that can be represented exactly by JavaScript.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
).annotate({ identifier: "WorkflowProtocolV2NonNegativeSafeInt" })

/**
 * The decoded type of {@link NonNegativeSafeInt}.
 *
 * @category models
 * @since 4.0.0
 */
export type NonNegativeSafeInt = Schema.Schema.Type<typeof NonNegativeSafeInt>

/**
 * A positive integer that can be represented exactly by JavaScript.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
).annotate({ identifier: "WorkflowProtocolV2PositiveSafeInt" })

/**
 * The decoded type of {@link PositiveSafeInt}.
 *
 * @category models
 * @since 4.0.0
 */
export type PositiveSafeInt = Schema.Schema.Type<typeof PositiveSafeInt>

/**
 * Largest relative semantic delay admitted by execution protocol version `2`.
 *
 * **Details**
 *
 * One hundred fixed 365-day years is the operational ceiling for one relative
 * offset. Longer business waits must be represented as renewed or
 * calendar-aware schedules rather than one unbounded millisecond offset.
 * The authority records a deterministic protocol failure if an otherwise
 * valid offset reaches the finite timestamp boundary.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumSemanticDelayMillis = 3_153_600_000_000 as const

/**
 * A bounded non-negative relative duration used by semantic timers.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticDelayMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MaximumSemanticDelayMillis)
).annotate({ identifier: "WorkflowProtocolV2SemanticDelayMillis" })

/**
 * The decoded type of {@link SemanticDelayMillis}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticDelayMillis = Schema.Schema.Type<typeof SemanticDelayMillis>

/**
 * A bounded positive relative duration used by semantic timers.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PositiveSemanticDelayMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MaximumSemanticDelayMillis)
).annotate({ identifier: "WorkflowProtocolV2PositiveSemanticDelayMillis" })

/**
 * The decoded type of {@link PositiveSemanticDelayMillis}.
 *
 * @category models
 * @since 4.0.0
 */
export type PositiveSemanticDelayMillis = Schema.Schema.Type<
  typeof PositiveSemanticDelayMillis
>

/**
 * A canonical UTC ISO 8601 timestamp at millisecond precision.
 *
 * **Details**
 *
 * Protocol version `2` policies use whole milliseconds. Requiring the exact
 * `YYYY-MM-DDTHH:mm:ss.sssZ` spelling prevents equivalent offsets or silently
 * truncated sub-millisecond precision from changing persisted meaning.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timestamp = Schema.String.check(
  Schema.isPattern(isoTimestampPattern),
  Schema.makeFilter(
    hasValidCalendarDate,
    { expected: "a canonical UTC ISO 8601 timestamp with millisecond precision" }
  )
).annotate({ identifier: "WorkflowProtocolV2Timestamp" })

/**
 * The decoded type of {@link Timestamp}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timestamp = Schema.Schema.Type<typeof Timestamp>

/**
 * The common lowercase SHA-256 wire representation.
 *
 * **Details**
 *
 * Persisted fields should use one of the nominal schemas below instead of this
 * base schema so unrelated digest domains cannot be mixed in typed code.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Sha256Digest = Schema.String.check(
  Schema.isPattern(sha256Pattern)
).annotate({ identifier: "WorkflowProtocolV2Sha256Digest" })

/**
 * The decoded type of {@link Sha256Digest}.
 *
 * @category models
 * @since 4.0.0
 */
export type Sha256Digest = Schema.Schema.Type<typeof Sha256Digest>

/**
 * Content identity of a complete durable plan artifact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ArtifactDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/ArtifactDigest")
).annotate({ identifier: "WorkflowProtocolV2ArtifactDigest" })

/**
 * The decoded type of {@link ArtifactDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactDigest = Schema.Schema.Type<typeof ArtifactDigest>

/**
 * Content identity of a canonical compiled-plan fingerprint document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompiledFingerprint = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/CompiledFingerprint")
).annotate({ identifier: "WorkflowProtocolV2CompiledFingerprint" })

/**
 * The decoded type of {@link CompiledFingerprint}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompiledFingerprint = Schema.Schema.Type<typeof CompiledFingerprint>

/**
 * Content identity of one codec-encoded payload.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PayloadDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/PayloadDigest")
).annotate({ identifier: "WorkflowProtocolV2PayloadDigest" })

/**
 * The decoded type of {@link PayloadDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadDigest = Schema.Schema.Type<typeof PayloadDigest>

/**
 * Content identity of one normalized ingress request.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequestDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/RequestDigest")
).annotate({ identifier: "WorkflowProtocolV2RequestDigest" })

/**
 * The decoded type of {@link RequestDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequestDigest = Schema.Schema.Type<typeof RequestDigest>

/**
 * Content identity of one immutable executable deployment build.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BuildDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/BuildDigest")
).annotate({ identifier: "WorkflowProtocolV2BuildDigest" })

/**
 * The decoded type of {@link BuildDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type BuildDigest = Schema.Schema.Type<typeof BuildDigest>

/**
 * Content identity of one executable BPMN semantic model and runtime profile.
 *
 * **Details**
 *
 * The digest commits to the normalized semantic model, selected root process,
 * token-kernel semantic version, safety limits, interchange profile, and exact
 * expression-evaluator build manifest. It does not identify BPMN DI or raw XML
 * spelling.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BpmnExecutableFingerprint = Sha256Digest.pipe(
  Schema.brand(
    "@effect/workflow-builder/ProtocolV2Wire/BpmnExecutableFingerprint"
  )
).annotate({
  identifier: "WorkflowProtocolV2BpmnExecutableFingerprint"
})

/**
 * The decoded type of {@link BpmnExecutableFingerprint}.
 *
 * @category models
 * @since 4.0.0
 */
export type BpmnExecutableFingerprint = Schema.Schema.Type<
  typeof BpmnExecutableFingerprint
>

/**
 * Content identity of one portable semantic definition.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DefinitionDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/DefinitionDigest")
).annotate({ identifier: "WorkflowProtocolV2DefinitionDigest" })

/**
 * The decoded type of {@link DefinitionDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type DefinitionDigest = Schema.Schema.Type<typeof DefinitionDigest>

/**
 * Content identity of one inspectable encoded-schema description.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SchemaDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/SchemaDigest")
).annotate({ identifier: "WorkflowProtocolV2SchemaDigest" })

/**
 * The decoded type of {@link SchemaDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type SchemaDigest = Schema.Schema.Type<typeof SchemaDigest>

/**
 * Content identity of one complete canonical history snapshot.
 *
 * @category schemas
 * @since 4.0.0
 */
export const HistoryDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/HistoryDigest")
).annotate({ identifier: "WorkflowProtocolV2HistoryDigest" })

/**
 * The decoded type of {@link HistoryDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type HistoryDigest = Schema.Schema.Type<typeof HistoryDigest>

/**
 * Content identity of one immutable encoded blob.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BlobDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV2Wire/BlobDigest")
).annotate({ identifier: "WorkflowProtocolV2BlobDigest" })

/**
 * The decoded type of {@link BlobDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type BlobDigest = Schema.Schema.Type<typeof BlobDigest>

/**
 * An integrity-checked reference to an immutable encoded payload blob.
 *
 * **Details**
 *
 * `encodedBytes` is the verified target size, not the serialized size of this
 * reference. Authorization and storage scope are supplied by the enclosing
 * tenant/run boundary rather than embedded credentials.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BlobRef = Schema.Struct({
  blobVersion: Schema.Literal(1),
  digest: BlobDigest,
  encodedBytes: PositiveSafeInt,
  mediaType: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowProtocolV2BlobRef",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BlobRef}.
 *
 * @category models
 * @since 4.0.0
 */
export type BlobRef = Schema.Schema.Type<typeof BlobRef>

/**
 * A small codec-encoded JSON payload retained inline.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InlineEncodedPayload = Schema.TaggedStruct("Inline", {
  value: Schema.Json
}).annotate({
  identifier: "WorkflowProtocolV2InlineEncodedPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InlineEncodedPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type InlineEncodedPayload = Schema.Schema.Type<typeof InlineEncodedPayload>

/**
 * A codec-encoded JSON payload retained through an immutable blob reference.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BlobEncodedPayload = Schema.TaggedStruct("Blob", {
  ref: BlobRef
}).annotate({
  identifier: "WorkflowProtocolV2BlobEncodedPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BlobEncodedPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type BlobEncodedPayload = Schema.Schema.Type<typeof BlobEncodedPayload>

/**
 * A portable codec-encoded value stored inline or by immutable blob reference.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedPayload = Schema.Union([
  InlineEncodedPayload,
  BlobEncodedPayload
]).annotate({ identifier: "WorkflowProtocolV2EncodedPayload" })

/**
 * The decoded type of {@link EncodedPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedPayload = Schema.Schema.Type<typeof EncodedPayload>

/**
 * Nonsecret attribution retained for an authorized external admission.
 *
 * **Details**
 *
 * Authentication credentials, claims, and capability material are deliberately
 * absent. These stable identifiers link the semantic fact to a separately
 * retained policy decision without making secrets part of history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AdmissionAttribution = Schema.Struct({
  actorId: Schema.NonEmptyString,
  policyId: Schema.NonEmptyString,
  policyVersion: Schema.NonEmptyString,
  policyDecisionId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowProtocolV2AdmissionAttribution",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AdmissionAttribution}.
 *
 * @category models
 * @since 4.0.0
 */
export type AdmissionAttribution = Schema.Schema.Type<typeof AdmissionAttribution>
