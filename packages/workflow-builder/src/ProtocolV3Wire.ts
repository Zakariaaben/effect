/**
 * Dependency-free JSON wire primitives shared by execution protocol version
 * `3`.
 *
 * **Details**
 *
 * These schemas deliberately do not import protocol version `2`. Compatible
 * values retain their serialized spelling, while schema identifiers and
 * nominal digest brands remain version-specific so typed code cannot
 * accidentally cross a protocol boundary without explicit validation.
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
  const leapYear = year % 4 === 0 &&
    (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ]
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
).annotate({ identifier: "WorkflowProtocolV3NonNegativeSafeInt" })

/**
 * The decoded type of {@link NonNegativeSafeInt}.
 *
 * @category models
 * @since 4.0.0
 */
export type NonNegativeSafeInt = Schema.Schema.Type<
  typeof NonNegativeSafeInt
>

/**
 * A positive integer that can be represented exactly by JavaScript.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
).annotate({ identifier: "WorkflowProtocolV3PositiveSafeInt" })

/**
 * The decoded type of {@link PositiveSafeInt}.
 *
 * @category models
 * @since 4.0.0
 */
export type PositiveSafeInt = Schema.Schema.Type<typeof PositiveSafeInt>

/**
 * Largest relative semantic delay admitted by execution protocol version `3`.
 *
 * **Details**
 *
 * One hundred fixed 365-day years is the operational ceiling for one relative
 * offset. Longer business waits must be represented as renewed or
 * calendar-aware schedules rather than one unbounded millisecond offset.
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
).annotate({ identifier: "WorkflowProtocolV3SemanticDelayMillis" })

/**
 * The decoded type of {@link SemanticDelayMillis}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticDelayMillis = Schema.Schema.Type<
  typeof SemanticDelayMillis
>

/**
 * A bounded positive relative duration used by semantic timers.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PositiveSemanticDelayMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MaximumSemanticDelayMillis)
).annotate({ identifier: "WorkflowProtocolV3PositiveSemanticDelayMillis" })

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
 * The exact `YYYY-MM-DDTHH:mm:ss.sssZ` spelling prevents equivalent offsets
 * or silently truncated sub-millisecond precision from changing persisted
 * meaning. The calendar-date check rejects impossible leap days and
 * out-of-range month days.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timestamp = Schema.String.check(
  Schema.isPattern(isoTimestampPattern),
  Schema.makeFilter(
    hasValidCalendarDate,
    {
      expected: "a canonical UTC ISO 8601 timestamp with millisecond precision"
    }
  )
).annotate({ identifier: "WorkflowProtocolV3Timestamp" })

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
 * Persisted fields should use a nominal domain schema below instead of this
 * base schema so unrelated digest domains cannot be mixed in typed code.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Sha256Digest = Schema.String.check(
  Schema.isPattern(sha256Pattern)
).annotate({ identifier: "WorkflowProtocolV3Sha256Digest" })

/**
 * The decoded type of {@link Sha256Digest}.
 *
 * @category models
 * @since 4.0.0
 */
export type Sha256Digest = Schema.Schema.Type<typeof Sha256Digest>

/**
 * Content identity of a complete protocol version `3` durable artifact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ArtifactDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV3Wire/ArtifactDigest")
).annotate({ identifier: "WorkflowProtocolV3ArtifactDigest" })

/**
 * The decoded type of {@link ArtifactDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactDigest = Schema.Schema.Type<typeof ArtifactDigest>

/**
 * Content identity of a canonical protocol version `3` compiled-plan
 * fingerprint document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompiledFingerprint = Sha256Digest.pipe(
  Schema.brand(
    "@effect/workflow-builder/ProtocolV3Wire/CompiledFingerprint"
  )
).annotate({ identifier: "WorkflowProtocolV3CompiledFingerprint" })

/**
 * The decoded type of {@link CompiledFingerprint}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompiledFingerprint = Schema.Schema.Type<
  typeof CompiledFingerprint
>

/**
 * Content identity of one protocol version `3` input or output contract.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ContractDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV3Wire/ContractDigest")
).annotate({ identifier: "WorkflowProtocolV3ContractDigest" })

/**
 * The decoded type of {@link ContractDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ContractDigest = Schema.Schema.Type<typeof ContractDigest>

/**
 * Content identity of one immutable protocol version `3` executable build.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BuildDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV3Wire/BuildDigest")
).annotate({ identifier: "WorkflowProtocolV3BuildDigest" })

/**
 * The decoded type of {@link BuildDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type BuildDigest = Schema.Schema.Type<typeof BuildDigest>

/**
 * Content identity of one inspectable protocol version `3` encoded-schema
 * document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SchemaDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV3Wire/SchemaDigest")
).annotate({ identifier: "WorkflowProtocolV3SchemaDigest" })

/**
 * The decoded type of {@link SchemaDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type SchemaDigest = Schema.Schema.Type<typeof SchemaDigest>

/**
 * Content identity of one protocol version `3` codec-encoded payload.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PayloadDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV3Wire/PayloadDigest")
).annotate({ identifier: "WorkflowProtocolV3PayloadDigest" })

/**
 * The decoded type of {@link PayloadDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadDigest = Schema.Schema.Type<typeof PayloadDigest>

/**
 * Content identity of one immutable protocol version `3` encoded blob.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BlobDigest = Sha256Digest.pipe(
  Schema.brand("@effect/workflow-builder/ProtocolV3Wire/BlobDigest")
).annotate({ identifier: "WorkflowProtocolV3BlobDigest" })

/**
 * The decoded type of {@link BlobDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type BlobDigest = Schema.Schema.Type<typeof BlobDigest>

/**
 * A strict codec-encoded JSON value.
 *
 * **Details**
 *
 * The schema defines the portable value vocabulary. Boundary authorities must
 * still detach and bound caller-owned values before decoding when hostile
 * objects, cycles, or resource exhaustion are in scope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedJsonValue = Schema.Json.annotate({
  identifier: "WorkflowProtocolV3EncodedJsonValue"
})

/**
 * The decoded type of {@link EncodedJsonValue}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedJsonValue = Schema.Schema.Type<typeof EncodedJsonValue>

/**
 * An integrity-checked reference to an immutable encoded payload blob.
 *
 * **Details**
 *
 * `blobVersion` versions this reference format independently of the execution
 * protocol and therefore remains `1`. `encodedBytes` is the verified target
 * size, not the serialized size of this reference. Authorization and storage
 * scope are supplied by the enclosing tenant/run boundary rather than
 * embedded credentials.
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
  identifier: "WorkflowProtocolV3BlobRef",
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
  value: EncodedJsonValue
}).annotate({
  identifier: "WorkflowProtocolV3InlineEncodedPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InlineEncodedPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type InlineEncodedPayload = Schema.Schema.Type<
  typeof InlineEncodedPayload
>

/**
 * A codec-encoded JSON payload retained through an immutable blob reference.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BlobEncodedPayload = Schema.TaggedStruct("Blob", {
  ref: BlobRef
}).annotate({
  identifier: "WorkflowProtocolV3BlobEncodedPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BlobEncodedPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type BlobEncodedPayload = Schema.Schema.Type<
  typeof BlobEncodedPayload
>

/**
 * A portable codec-encoded value stored inline or by immutable blob reference.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedPayload = Schema.Union([
  InlineEncodedPayload,
  BlobEncodedPayload
]).annotate({
  identifier: "WorkflowProtocolV3EncodedPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EncodedPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedPayload = Schema.Schema.Type<typeof EncodedPayload>
