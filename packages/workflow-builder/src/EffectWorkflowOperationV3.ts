/**
 * Replay-stable operation names for the native Effect Workflow adapter.
 *
 * **Details**
 *
 * Effect Workflow already implements durable activities, deferred values,
 * clocks, races, and nested workflow execution. This module does not wrap or
 * reimplement those primitives. It only maps builder-owned semantic
 * coordinates to bounded, collision-free native names.
 *
 * A {@link Wire.OccurrenceDigest} commits the complete dynamic occurrence
 * coordinates. `operationId` distinguishes multiple durable operations
 * belonging to that occurrence. Native
 * `Activity.CurrentAttempt` distinguishes semantic activity attempts, while a
 * timer/deferred generation distinguishes renewable uses of those operations.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Coordinate format consumed by this native naming profile.
 *
 * @category constants
 * @since 4.0.0
 */
export const CoordinateVersion = 3 as const

/**
 * Independent format version of the generated native operation name.
 *
 * @category constants
 * @since 4.0.0
 */
export const NameVersion = 1 as const

/**
 * Stable prefix for protocol-v3 native operation names.
 *
 * @category constants
 * @since 4.0.0
 */
export const NamePrefix = "@effect/workflow-builder/effect-workflow/v3/operation/a1/" as const

/**
 * Stable prefix for native descriptor-binding guard activities.
 *
 * @category constants
 * @since 4.0.0
 */
export const BindingNamePrefix = "@effect/workflow-builder/effect-workflow/v3/binding/a1/" as const

/**
 * Maximum UTF-8 size of one generated native operation name.
 *
 * **Details**
 *
 * The bound covers the worst-case JSON escaping of two protocol-v3 atomic
 * identifiers while keeping native persistence keys and trace attributes
 * finite.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumNameBytes = 4_096 as const

const CommonCoordinates = {
  coordinateVersion: Schema.Literal(CoordinateVersion),
  occurrenceDigest: Wire.OccurrenceDigest,
  operationId: Wire.AtomicIdentifier
} as const

/**
 * Coordinates for one builder-owned logical activity.
 *
 * **Details**
 *
 * The returned name stays constant across semantic attempts. The semantic
 * runtime supplies its positive attempt through native
 * `Activity.CurrentAttempt`, whose value already participates in Effect
 * Workflow's durable activity key. Callers must not also use `Activity.retry`
 * for business retries; classification and backoff remain protocol-v3
 * decisions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Activity = Schema.TaggedStruct("Activity", {
  ...CommonCoordinates
}).annotate({
  identifier: "WorkflowEffectOperationV3Activity",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Activity}.
 *
 * @category models
 * @since 4.0.0
 */
export type Activity = Schema.Schema.Type<typeof Activity>

/**
 * Coordinates for one durable timer generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timer = Schema.TaggedStruct("Timer", {
  ...CommonCoordinates,
  generation: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowEffectOperationV3Timer",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Timer}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timer = Schema.Schema.Type<typeof Timer>

/**
 * Coordinates for one durable deferred generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Deferred = Schema.TaggedStruct("Deferred", {
  ...CommonCoordinates,
  generation: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowEffectOperationV3Deferred",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Deferred}.
 *
 * @category models
 * @since 4.0.0
 */
export type Deferred = Schema.Schema.Type<typeof Deferred>

/**
 * Coordinates for one durable semantic race generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Race = Schema.TaggedStruct("Race", {
  ...CommonCoordinates,
  generation: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowEffectOperationV3Race",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Race}.
 *
 * @category models
 * @since 4.0.0
 */
export type Race = Schema.Schema.Type<typeof Race>

/**
 * Closed coordinate vocabulary currently mapped to names by adapter version
 * `1`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Coordinates = Schema.Union([
  Activity,
  Timer,
  Deferred,
  Race
]).annotate({
  identifier: "WorkflowEffectOperationV3Coordinates",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Coordinates}.
 *
 * @category models
 * @since 4.0.0
 */
export type Coordinates = Schema.Schema.Type<typeof Coordinates>

/**
 * Stable operation-name validation failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidCoordinates: "InvalidCoordinates",
  NameTooLong: "NameTooLong"
} as const

/**
 * A stable operation-name validation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidCoordinates,
  ErrorCodes.NameTooLong
])

/**
 * Raised when semantic coordinates cannot safely become a native operation
 * name.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowOperationError extends Schema.TaggedErrorClass<
  EffectWorkflowOperationError
>("@effect/workflow-builder/EffectWorkflowOperationV3/Error")(
  "EffectWorkflowOperationError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const error = (
  code: ErrorCode,
  message: string
): EffectWorkflowOperationError => new EffectWorkflowOperationError({ code, message })

const tuple = (
  coordinates: Coordinates
): ReadonlyArray<string | number> =>
  coordinates._tag === "Activity"
    ? [
      NameVersion,
      coordinates._tag,
      coordinates.occurrenceDigest,
      coordinates.operationId
    ]
    : [
      NameVersion,
      coordinates._tag,
      coordinates.occurrenceDigest,
      coordinates.operationId,
      coordinates.generation
    ]

/**
 * Validates semantic coordinates and returns their replay-stable native name.
 *
 * **Details**
 *
 * The JSON tuple is an unambiguous framing, not persisted builder state. Native
 * Effect Workflow remains responsible for recording and replaying the
 * operation addressed by the returned name.
 *
 * @category constructors
 * @since 4.0.0
 */
export const name = (
  input: unknown
): Result.Result<string, EffectWorkflowOperationError> => {
  const snapshot = Json.snapshot(input, {
    maxArrayLength: 8,
    maxContainers: 16,
    maxDepth: 8,
    maxEntries: 32,
    maxStringBytes: Wire.MaximumAtomicIdentifierBytes,
    maxTotalBytes: 2_048
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(error(
      ErrorCodes.InvalidCoordinates,
      `Native operation coordinates must be bounded strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: Result.Result<Coordinates, Schema.SchemaError>
  try {
    decoded = Schema.decodeUnknownResult(Coordinates, strictParseOptions)(
      snapshot.success
    )
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidCoordinates,
      "Native operation coordinate validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(error(
      ErrorCodes.InvalidCoordinates,
      `Invalid native operation coordinates: ${decoded.failure.message}`
    ))
  }
  const coordinates = decoded.success
  const value = `${NamePrefix}${JSON.stringify(tuple(coordinates))}`
  if (new TextEncoder().encode(value).byteLength > MaximumNameBytes) {
    return Result.fail(error(
      ErrorCodes.NameTooLong,
      `Native operation names cannot exceed ${MaximumNameBytes} UTF-8 bytes`
    ))
  }
  return Result.succeed(value)
}

/**
 * Returns the stable native activity name that binds an operation descriptor
 * digest before the operation itself may run.
 *
 * **Details**
 *
 * The binding guard uses the same semantic coordinates in a disjoint native
 * namespace. Its cached result is compared with the current operation digest
 * on every replay. The digest is deliberately not part of this name.
 *
 * @category constructors
 * @since 4.0.0
 */
export const bindingName = (
  input: unknown
): Result.Result<string, EffectWorkflowOperationError> => {
  const operationName = name(input)
  if (Result.isFailure(operationName)) return operationName
  const value = `${BindingNamePrefix}${operationName.success.slice(NamePrefix.length)}`
  if (new TextEncoder().encode(value).byteLength > MaximumNameBytes) {
    return Result.fail(error(
      ErrorCodes.NameTooLong,
      `Native operation names cannot exceed ${MaximumNameBytes} UTF-8 bytes`
    ))
  }
  return Result.succeed(value)
}
