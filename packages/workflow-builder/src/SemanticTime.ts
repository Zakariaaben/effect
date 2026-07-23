/**
 * Pure protocol version 2 semantic deadline materialization.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as EventV2 from "./EventV2.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * A non-negative whole-millisecond semantic delay.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DelayMillis = ProtocolV2Wire.SemanticDelayMillis.annotate({
  identifier: "WorkflowSemanticDelayMillis"
})

/**
 * The decoded type of {@link DelayMillis}.
 *
 * @category models
 * @since 4.0.0
 */
export type DelayMillis = Schema.Schema.Type<typeof DelayMillis>

/**
 * Raised when the supplied anchor is not a detached protocol version 2
 * timestamp.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidAnchor extends Schema.TaggedErrorClass<InvalidAnchor>(
  "@effect/workflow-builder/SemanticTime/InvalidAnchor"
)("InvalidAnchor", {
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when the supplied delay is not a detached bounded semantic duration.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidDelay extends Schema.TaggedErrorClass<InvalidDelay>(
  "@effect/workflow-builder/SemanticTime/InvalidDelay"
)("InvalidDelay", {
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a valid anchor and delay cannot produce a safe, four-digit-year
 * protocol version 2 timestamp.
 *
 * @category errors
 * @since 4.0.0
 */
export class DeadlineOutOfRange extends Schema.TaggedErrorClass<DeadlineOutOfRange>(
  "@effect/workflow-builder/SemanticTime/DeadlineOutOfRange"
)("DeadlineOutOfRange", {
  anchor: EventV2.Timestamp,
  delayMillis: DelayMillis,
  reason: Schema.Literals(["UnsafeInteger", "CalendarRange"]),
  message: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Failures produced while materializing one semantic deadline.
 *
 * @category errors
 * @since 4.0.0
 */
export type SemanticTimeError =
  | InvalidAnchor
  | InvalidDelay
  | DeadlineOutOfRange

const decodeAnchor = Schema.decodeUnknownResult(EventV2.Timestamp, strictParseOptions)
const decodeDelay = Schema.decodeUnknownResult(DelayMillis, strictParseOptions)
const decodeDeadline = Schema.decodeUnknownResult(EventV2.Timestamp, strictParseOptions)

const invalidAnchor = (
  message: string,
  details?: Schema.Json
): InvalidAnchor =>
  new InvalidAnchor({
    message,
    ...(details === undefined ? undefined : { details })
  })

const invalidDelay = (
  message: string,
  details?: Schema.Json
): InvalidDelay =>
  new InvalidDelay({
    message,
    ...(details === undefined ? undefined : { details })
  })

const captureAnchor = (
  input: unknown
): Result.Result<EventV2.Timestamp, InvalidAnchor> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(invalidAnchor(
      `Semantic time anchor must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  let decoded: ReturnType<typeof decodeAnchor>
  try {
    decoded = decodeAnchor(snapped.success)
  } catch {
    return Result.fail(invalidAnchor(
      "Semantic time anchor schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(invalidAnchor("Invalid protocol version 2 timestamp anchor", {
      parseError: decoded.failure.message
    }))
    : Result.succeed(decoded.success)
}

const captureDelay = (
  input: unknown
): Result.Result<DelayMillis, InvalidDelay> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(invalidDelay(
      `Semantic time delay must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  let decoded: ReturnType<typeof decodeDelay>
  try {
    decoded = decodeDelay(snapped.success)
  } catch {
    return Result.fail(invalidDelay(
      "Semantic time delay schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(invalidDelay("Semantic time delay exceeds the bounded protocol duration", {
      parseError: decoded.failure.message
    }))
    : Result.succeed(decoded.success)
}

const outOfRange = (
  anchor: EventV2.Timestamp,
  delayMillis: DelayMillis,
  reason: "UnsafeInteger" | "CalendarRange",
  message: string
): DeadlineOutOfRange =>
  new DeadlineOutOfRange({
    anchor,
    delayMillis,
    reason,
    message
  })

/**
 * Materializes the canonical UTC deadline for one stored semantic timer.
 *
 * **Details**
 *
 * Both inputs cross detached strict-JSON boundaries before use. The anchor must
 * satisfy {@link EventV2.Timestamp}; the delay must satisfy the protocol's
 * operational semantic-duration ceiling. Addition is checked before
 * constructing the deadline, and the one canonical `toISOString` result is
 * validated against `EventV2.Timestamp` before it is returned.
 *
 * This helper is deterministic and reads no clock. Store code supplies the
 * already-persisted anchor timestamp and must persist the returned deadline
 * unchanged anywhere that semantic deadline is duplicated.
 *
 * @category validation
 * @since 4.0.0
 */
export const materializeDeadline = (
  inputAnchor: EventV2.Timestamp,
  inputDelayMillis: DelayMillis
): Result.Result<EventV2.Timestamp, SemanticTimeError> => {
  const capturedAnchor = captureAnchor(inputAnchor)
  if (Result.isFailure(capturedAnchor)) {
    return Result.fail(capturedAnchor.failure)
  }
  const capturedDelay = captureDelay(inputDelayMillis)
  if (Result.isFailure(capturedDelay)) {
    return Result.fail(capturedDelay.failure)
  }
  const anchor = capturedAnchor.success
  const delayMillis = capturedDelay.success
  const anchorEpoch = Date.parse(anchor)
  if (!Number.isSafeInteger(anchorEpoch)) {
    return Result.fail(invalidAnchor(
      "Protocol version 2 timestamp anchor cannot be represented as epoch milliseconds"
    ))
  }
  if (anchorEpoch > Number.MAX_SAFE_INTEGER - delayMillis) {
    return Result.fail(outOfRange(
      anchor,
      delayMillis,
      "UnsafeInteger",
      "Semantic deadline exceeds the safe-integer millisecond range"
    ))
  }
  const deadlineEpoch = anchorEpoch + delayMillis
  let canonical: string
  try {
    canonical = new Date(deadlineEpoch).toISOString()
  } catch {
    return Result.fail(outOfRange(
      anchor,
      delayMillis,
      "CalendarRange",
      "Semantic deadline is outside the supported calendar range"
    ))
  }
  let decoded: ReturnType<typeof decodeDeadline>
  try {
    decoded = decodeDeadline(canonical)
  } catch {
    return Result.fail(outOfRange(
      anchor,
      delayMillis,
      "CalendarRange",
      "Canonical semantic deadline validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(outOfRange(
      anchor,
      delayMillis,
      "CalendarRange",
      "Semantic deadline is outside the protocol version 2 timestamp range"
    ))
    : Result.succeed(decoded.success)
}
