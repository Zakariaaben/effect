/**
 * Content-addressed dynamic node occurrences for execution protocol version
 * `3`.
 *
 * **Details**
 *
 * A static node identifier is not sufficient once loops, multi-instance
 * activities, nested BPMN scopes, or repeated event activations exist. This
 * module identifies one occurrence by its exact run/artifact/node coordinates,
 * root-to-parent scope activations, and node activation number.
 *
 * The occurrence digest is identity, not authorization. An execution
 * admission layer must still prove that the tenant/run is authoritative, the
 * artifact was verified, the node exists, and each activation was derived from
 * replayable semantic state rather than ambient counters or completion order.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as DigestV3 from "./DigestV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const preparedOccurrences = new WeakSet<object>()

/**
 * Execution protocol whose occurrence coordinates are represented here.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 3 as const

/**
 * Independent format version of the occurrence document.
 *
 * @category constants
 * @since 4.0.0
 */
export const OccurrenceVersion = 1 as const

/**
 * Maximum number of nested semantic scope activations in one occurrence.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumScopeDepth = 64 as const

/**
 * One activated ancestor scope in root-to-parent order.
 *
 * **Details**
 *
 * `activation` is allocated by the semantic state machine for that scope
 * within its parent occurrence. It is not a wall-clock, array-index, or
 * process-local scheduling counter.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScopeActivation = Schema.Struct({
  scopeActivationVersion: Schema.Literal(1),
  scopeId: Wire.AtomicIdentifier,
  activation: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowSemanticOccurrenceV3ScopeActivation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScopeActivation}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScopeActivation = Schema.Schema.Type<typeof ScopeActivation>

/**
 * Bounded root-to-parent semantic scope activation path.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScopePath = Schema.Array(ScopeActivation).check(
  Schema.isMaxLength(MaximumScopeDepth)
).annotate({
  identifier: "WorkflowSemanticOccurrenceV3ScopePath",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScopePath}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScopePath = Schema.Schema.Type<typeof ScopePath>

/**
 * Canonical preimage of one dynamic node occurrence.
 *
 * **Details**
 *
 * A one-shot static-DAG node uses an empty `scopePath` and activation `0`.
 * Re-entry, loops, multi-instance bodies, and BPMN scope instances must use
 * replay-derived activation coordinates so concurrent scheduling order cannot
 * change identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OccurrenceDocument = Schema.Struct({
  occurrenceVersion: Schema.Literal(OccurrenceVersion),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier,
  artifactDigest: Wire.ArtifactDigest,
  nodeId: Wire.AtomicIdentifier,
  scopePath: ScopePath,
  activation: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowSemanticOccurrenceV3Document",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OccurrenceDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type OccurrenceDocument = Schema.Schema.Type<
  typeof OccurrenceDocument
>

/**
 * Persistable document and its domain-separated content identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OccurrencePin = Schema.Struct({
  document: OccurrenceDocument,
  occurrenceDigest: Wire.OccurrenceDigest
}).annotate({
  identifier: "WorkflowSemanticOccurrenceV3Pin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OccurrencePin}.
 *
 * @category models
 * @since 4.0.0
 */
export type OccurrencePin = Schema.Schema.Type<typeof OccurrencePin>

/**
 * Exact process-local occurrence returned by {@link prepare} or
 * {@link verify}.
 *
 * **Details**
 *
 * Public fields form the persistable pin. Runtime provenance comes from the
 * exact returned object being retained in a private `WeakSet`; structural
 * copies are not prepared occurrences.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedOccurrence extends OccurrencePin {}

/**
 * Stable occurrence preparation and verification failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidDocument: "InvalidDocument",
  InvalidPin: "InvalidPin",
  DigestMismatch: "DigestMismatch"
} as const

/**
 * A stable occurrence failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidDocument,
  ErrorCodes.InvalidPin,
  ErrorCodes.DigestMismatch
])

/**
 * Raised when occurrence coordinates or a persisted occurrence pin are
 * invalid.
 *
 * @category errors
 * @since 4.0.0
 */
export class SemanticOccurrenceError extends Schema.TaggedErrorClass<
  SemanticOccurrenceError
>("@effect/workflow-builder/SemanticOccurrenceV3/Error")(
  "SemanticOccurrenceError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const error = (
  code: ErrorCode,
  message: string
): SemanticOccurrenceError => new SemanticOccurrenceError({ code, message })

const snapshot = (
  input: unknown,
  code: typeof ErrorCodes.InvalidDocument | typeof ErrorCodes.InvalidPin,
  label: string
): Result.Result<Schema.Json, SemanticOccurrenceError> => {
  const snapped = Json.snapshot(input, {
    maxArrayLength: MaximumScopeDepth,
    maxContainers: 256,
    maxDepth: 16,
    maxEntries: 1_024,
    maxStringBytes: Wire.MaximumLineageIdentifierBytes,
    maxTotalBytes: 1_048_576
  })
  return Result.isFailure(snapped)
    ? Result.fail(error(
      code,
      `${label} must be bounded strict JSON: ${snapped.failure.message}`
    ))
    : Result.succeed(snapped.success)
}

const decodeSnapshot = <A>(
  schema: Schema.Codec<A, Schema.Json>,
  input: unknown,
  code: typeof ErrorCodes.InvalidDocument | typeof ErrorCodes.InvalidPin,
  label: string
): Result.Result<A, SemanticOccurrenceError> => {
  const snapped = snapshot(input, code, label)
  if (Result.isFailure(snapped)) return Result.fail(snapped.failure)
  let decoded: Result.Result<A, Schema.SchemaError>
  try {
    decoded = Schema.decodeUnknownResult(schema, strictParseOptions)(
      snapped.success
    )
  } catch {
    return Result.fail(error(
      code,
      `${label} validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      code,
      `Invalid ${label}: ${decoded.failure.message}`
    ))
    : Result.succeed(snapped.success as unknown as A)
}

const admit = (
  document: OccurrenceDocument,
  occurrenceDigest: Wire.OccurrenceDigest
): PreparedOccurrence => {
  const prepared = Object.freeze({
    document,
    occurrenceDigest
  })
  preparedOccurrences.add(prepared)
  return prepared
}

/**
 * Tests whether a value is an exact occurrence prepared in this process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (
  value: unknown
): value is PreparedOccurrence =>
  typeof value === "object" &&
  value !== null &&
  preparedOccurrences.has(value)

/**
 * Validates, detaches, fingerprints, and prepares occurrence coordinates.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = (
  input: unknown
): Effect.Effect<
  PreparedOccurrence,
  | SemanticOccurrenceError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  const decoded = decodeSnapshot(
    OccurrenceDocument,
    input,
    ErrorCodes.InvalidDocument,
    "semantic occurrence document"
  )
  if (Result.isFailure(decoded)) {
    return Effect.fail(decoded.failure)
  }
  return Effect.map(
    DigestV3.occurrence(decoded.success),
    (occurrenceDigest) => admit(decoded.success, occurrenceDigest)
  )
}

/**
 * Recomputes and verifies a persisted occurrence pin before preparing it.
 *
 * @category validation
 * @since 4.0.0
 */
export const verify = (
  input: unknown
): Effect.Effect<
  PreparedOccurrence,
  | SemanticOccurrenceError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  const decoded = decodeSnapshot(
    OccurrencePin,
    input,
    ErrorCodes.InvalidPin,
    "semantic occurrence pin"
  )
  if (Result.isFailure(decoded)) {
    return Effect.fail(decoded.failure)
  }
  return Effect.flatMap(
    DigestV3.occurrence(decoded.success.document),
    (computed) =>
      computed !== decoded.success.occurrenceDigest
        ? Effect.fail(error(
          ErrorCodes.DigestMismatch,
          "Semantic occurrence digest does not match its document"
        ))
        : Effect.succeed(admit(
          decoded.success.document,
          decoded.success.occurrenceDigest
        ))
  )
}
