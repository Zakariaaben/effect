/**
 * Portable signal definitions and bounded inbox policy for execution protocol
 * version `2`.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * An immutable executable build selected by stable logical and physical pins.
 *
 * **Details**
 *
 * The deployment identifier supports catalog lookup. The content digest makes
 * that lookup independently verifiable after export or installation elsewhere.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BuildPin = Schema.Struct({
  id: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString,
  buildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowSignalBuildPinV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BuildPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type BuildPin = Schema.Schema.Type<typeof BuildPin>

/**
 * An exact codec and its portable encoded contract.
 *
 * **Details**
 *
 * A schema digest is inspectable persisted metadata, while the build pin
 * identifies the executable codec required for Effect `Schema` transforms and
 * service-dependent decoding. The executable schema object itself is never
 * persisted.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CodecPin = Schema.Struct({
  ...BuildPin.fields,
  contractId: Schema.NonEmptyString,
  contractVersion: Schema.NonEmptyString,
  encodedSchemaDigest: Wire.SchemaDigest
}).annotate({
  identifier: "WorkflowSignalCodecPinV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CodecPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type CodecPin = Schema.Schema.Type<typeof CodecPin>

/**
 * A signal or wait that accepts every admitted correlation key.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AnySignalCorrelation = Schema.TaggedStruct("Any", {}).annotate({
  identifier: "WorkflowSignalAnyCorrelationV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AnySignalCorrelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type AnySignalCorrelation = Schema.Schema.Type<typeof AnySignalCorrelation>

/**
 * A signal or wait with one exact nonempty correlation key.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExactSignalCorrelation = Schema.TaggedStruct("Exact", {
  key: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowSignalExactCorrelationV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExactSignalCorrelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExactSignalCorrelation = Schema.Schema.Type<typeof ExactSignalCorrelation>

/**
 * Required portable signal-correlation semantics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalCorrelation = Schema.Union([
  AnySignalCorrelation,
  ExactSignalCorrelation
]).annotate({ identifier: "WorkflowSignalCorrelationV2" })

/**
 * The decoded type of {@link SignalCorrelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalCorrelation = Schema.Schema.Type<typeof SignalCorrelation>

/**
 * Correlation forms admitted by one signal definition.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalCorrelationPolicy = Schema.Literals([
  "AnyAllowed",
  "ExactRequired"
]).annotate({ identifier: "WorkflowSignalCorrelationPolicyV2" })

/**
 * The decoded type of {@link SignalCorrelationPolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalCorrelationPolicy = Schema.Schema.Type<typeof SignalCorrelationPolicy>

/**
 * Immutable decoding, authorization, retention, and item-size meaning for one
 * signal name and version.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalDefinition = Schema.Struct({
  signalDefinitionVersion: Schema.Literal(1),
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  payloadCodec: CodecPin,
  authorizationPolicy: BuildPin,
  correlation: SignalCorrelationPolicy,
  ttlMillis: Wire.PositiveSemanticDelayMillis,
  maxEncodedPayloadBytes: Wire.PositiveSafeInt
}).annotate({
  identifier: "WorkflowSignalDefinitionV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalDefinition}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalDefinition = Schema.Schema.Type<typeof SignalDefinition>

/**
 * Returns the collision-free portable key of one admitted signal definition.
 *
 * **Details**
 *
 * A canonical JSON tuple remains unambiguous even when either component
 * contains punctuation used by display-oriented `name@version` strings.
 *
 * @category identity
 * @since 4.0.0
 */
export const signalDefinitionKey = (
  name: string,
  version: string
): string => JSON.stringify([name, version])

/**
 * One content-identified signal definition under its canonical catalog key.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalCatalogEntry = Schema.Struct({
  key: Schema.NonEmptyString,
  definitionDigest: Wire.DefinitionDigest,
  definition: SignalDefinition
}).check(
  Schema.makeFilter((entry) =>
    entry.key === signalDefinitionKey(entry.definition.name, entry.definition.version)
      ? undefined
      : {
        path: ["key"],
        issue: "signal catalog key must equal the canonical [name, version] JSON tuple"
      }
  )
).annotate({
  identifier: "WorkflowSignalCatalogEntryV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalCatalogEntry}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalCatalogEntry = Schema.Schema.Type<typeof SignalCatalogEntry>

/**
 * A unique, canonically ordered list of admitted signal definitions.
 *
 * **Details**
 *
 * Strict key ordering makes the catalog representation deterministic and also
 * rejects duplicate keys. The catalog entry independently verifies that each
 * key corresponds to its definition's exact name and version.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalCatalog = Schema.Array(SignalCatalogEntry).check(
  Schema.makeFilter((entries) => {
    const issues: Array<Schema.FilterIssue> = []
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1]!
      const current = entries[index]!
      if (current.key <= previous.key) {
        issues.push({
          path: [index, "key"],
          issue: current.key === previous.key
            ? "signal catalog keys must be unique"
            : "signal catalog keys must be in ascending canonical order"
        })
      }
    }
    return issues
  })
).annotate({
  identifier: "WorkflowSignalCatalogV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalCatalog}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalCatalog = Schema.Schema.Type<typeof SignalCatalog>

/**
 * Rejects signal overflow without retaining the rejected payload.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RejectOverflow = Schema.TaggedStruct("Reject", {}).annotate({
  identifier: "WorkflowSignalRejectOverflowV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RejectOverflow}.
 *
 * @category models
 * @since 4.0.0
 */
export type RejectOverflow = Schema.Schema.Type<typeof RejectOverflow>

/**
 * Retains admitted overflow in a separately bounded dead-letter store.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeadLetterOverflow = Schema.TaggedStruct("DeadLetter", {
  maxCount: Wire.PositiveSafeInt,
  maxEncodedBytes: Wire.PositiveSafeInt,
  retentionMillis: Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowSignalDeadLetterOverflowV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DeadLetterOverflow}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeadLetterOverflow = Schema.Schema.Type<typeof DeadLetterOverflow>

/**
 * Explicit signal-inbox overflow behavior.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalOverflow = Schema.Union([
  RejectOverflow,
  DeadLetterOverflow
]).annotate({ identifier: "WorkflowSignalOverflowV2" })

/**
 * The decoded type of {@link SignalOverflow}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalOverflow = Schema.Schema.Type<typeof SignalOverflow>

/**
 * Immutable per-run bounds for signal acceptance, retention, and waiting.
 *
 * **Details**
 *
 * `maxAcceptedCount` permanently bounds history and the run-lifetime
 * deduplication namespace. Pending count and bytes may decrease after
 * consumption or expiry. Every maximum is explicit and safe-integer bounded.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalInboxPolicy = Schema.Struct({
  policyVersion: Schema.Literal(1),
  maxAcceptedCount: Wire.PositiveSafeInt,
  maxPendingCount: Wire.PositiveSafeInt,
  maxPendingEncodedBytes: Wire.PositiveSafeInt,
  maxItemEncodedBytes: Wire.PositiveSafeInt,
  maxSignalIdBytes: Wire.PositiveSafeInt,
  maxCorrelationKeyBytes: Wire.PositiveSafeInt,
  maxPendingWaits: Wire.PositiveSafeInt,
  maxTtlMillis: Wire.PositiveSemanticDelayMillis,
  deduplicationScope: Schema.Literal("RunLifetime"),
  receiptRetentionAfterTerminalMillis: Wire.SemanticDelayMillis,
  overflow: SignalOverflow
}).check(
  Schema.makeFilter((policy) => {
    const issues: Array<Schema.FilterIssue> = []
    if (policy.maxPendingCount > policy.maxAcceptedCount) {
      issues.push({
        path: ["maxPendingCount"],
        issue: "maxPendingCount must not exceed maxAcceptedCount"
      })
    }
    if (policy.maxItemEncodedBytes > policy.maxPendingEncodedBytes) {
      issues.push({
        path: ["maxItemEncodedBytes"],
        issue: "maxItemEncodedBytes must not exceed maxPendingEncodedBytes"
      })
    }
    if (
      policy.overflow._tag === "DeadLetter" &&
      policy.maxItemEncodedBytes > policy.overflow.maxEncodedBytes
    ) {
      issues.push({
        path: ["overflow", "maxEncodedBytes"],
        issue: "dead-letter maxEncodedBytes must admit one maximum-size item"
      })
    }
    return issues
  })
).annotate({
  identifier: "WorkflowSignalInboxPolicyV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalInboxPolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalInboxPolicy = Schema.Schema.Type<typeof SignalInboxPolicy>

/**
 * A complete portable signal catalog and its immutable inbox bounds.
 *
 * **Details**
 *
 * Each definition must fit the run-level item-size and TTL ceilings. This
 * manifest contains only JSON pins and policy; executable codecs and
 * authorization functions remain registered application code.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalCatalogManifest = Schema.Struct({
  catalogVersion: Schema.Literal(1),
  definitions: SignalCatalog,
  inboxPolicy: SignalInboxPolicy
}).check(
  Schema.makeFilter((manifest) => {
    const issues: Array<Schema.FilterIssue> = []
    for (let index = 0; index < manifest.definitions.length; index++) {
      const definition = manifest.definitions[index]!.definition
      if (definition.ttlMillis > manifest.inboxPolicy.maxTtlMillis) {
        issues.push({
          path: ["definitions", index, "definition", "ttlMillis"],
          issue: "signal definition ttlMillis must not exceed inbox maxTtlMillis"
        })
      }
      if (definition.maxEncodedPayloadBytes > manifest.inboxPolicy.maxItemEncodedBytes) {
        issues.push({
          path: ["definitions", index, "definition", "maxEncodedPayloadBytes"],
          issue: "signal definition maxEncodedPayloadBytes must not exceed inbox maxItemEncodedBytes"
        })
      }
    }
    return issues
  })
).annotate({
  identifier: "WorkflowSignalCatalogManifestV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalCatalogManifest}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalCatalogManifest = Schema.Schema.Type<typeof SignalCatalogManifest>

/**
 * Stable machine-readable reasons an external signal is not accepted.
 *
 * @category constants
 * @since 4.0.0
 */
export const SignalRejectionReasons = {
  InvalidRequest: "InvalidRequest",
  UnknownRun: "UnknownRun",
  WrongArtifact: "WrongArtifact",
  UnknownSignal: "UnknownSignal",
  Unauthorized: "Unauthorized",
  InvalidPayload: "InvalidPayload",
  PayloadTooLarge: "PayloadTooLarge",
  SignalIdTooLarge: "SignalIdTooLarge",
  CorrelationKeyTooLarge: "CorrelationKeyTooLarge",
  InboxCountExceeded: "InboxCountExceeded",
  PendingCountExceeded: "PendingCountExceeded",
  PendingBytesExceeded: "PendingBytesExceeded",
  WaitingCapacityExceeded: "WaitingCapacityExceeded",
  TerminalRun: "TerminalRun",
  SignalIdConflict: "SignalIdConflict",
  Expired: "Expired",
  DeadLettered: "DeadLettered"
} as const

/**
 * Machine-readable signal rejection reasons.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalRejectionReason = Schema.Literals([
  SignalRejectionReasons.InvalidRequest,
  SignalRejectionReasons.UnknownRun,
  SignalRejectionReasons.WrongArtifact,
  SignalRejectionReasons.UnknownSignal,
  SignalRejectionReasons.Unauthorized,
  SignalRejectionReasons.InvalidPayload,
  SignalRejectionReasons.PayloadTooLarge,
  SignalRejectionReasons.SignalIdTooLarge,
  SignalRejectionReasons.CorrelationKeyTooLarge,
  SignalRejectionReasons.InboxCountExceeded,
  SignalRejectionReasons.PendingCountExceeded,
  SignalRejectionReasons.PendingBytesExceeded,
  SignalRejectionReasons.WaitingCapacityExceeded,
  SignalRejectionReasons.TerminalRun,
  SignalRejectionReasons.SignalIdConflict,
  SignalRejectionReasons.Expired,
  SignalRejectionReasons.DeadLettered
]).annotate({ identifier: "WorkflowSignalRejectionReasonV2" })

/**
 * The decoded type of {@link SignalRejectionReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalRejectionReason = Schema.Schema.Type<typeof SignalRejectionReason>
