/**
 * Pure, fail-closed BPMN timer lexical parsing and deadline materialization.
 *
 * **Details**
 *
 * This profile parses the string value produced by a BPMN `timeDuration` or
 * `timeDate` expression as a bounded ISO-8601 / XML Schema duration or
 * date-time subset. BPMN `tExpression` text is not itself XML Schema-typed.
 * The supported runtime subset consists of fixed, non-negative day/time
 * durations and zoned date-times representable by the protocol's canonical
 * millisecond-precision timestamp.
 *
 * No operation reads a clock. Callers supply the already-persisted
 * `scheduledAt` anchor and an explicit delay ceiling.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the accepted BPMN timer lexical subset and its normalization
 * rules.
 *
 * **Details**
 *
 * Version `1` accepts XML Schema duration day/time components only, rejects
 * negative and calendar-relative durations, and normalizes exact
 * millisecond values. Zoned date-times normalize to the protocol version `2`
 * UTC timestamp spelling.
 *
 * @category constants
 * @since 4.0.0
 */
export const LexicalVersion = 1 as const

/**
 * Hard UTF-8 byte ceiling applied before BPMN timer lexical regular
 * expressions run.
 *
 * **Details**
 *
 * Kernel profiles may select a lower fingerprinted ceiling, but public parser
 * entry points always retain this fixed defensive bound.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumTimerLexicalUtf8Bytes = 4_096 as const

/**
 * An explicit caller-selected delay ceiling that cannot exceed the protocol
 * version `3` semantic-delay ceiling.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MaximumDelayMillis = ProtocolV3Wire.SemanticDelayMillis.annotate({
  identifier: "WorkflowBpmnTimeMaximumDelayMillis"
})

/**
 * The decoded type of {@link MaximumDelayMillis}.
 *
 * @category models
 * @since 4.0.0
 */
export type MaximumDelayMillis = Schema.Schema.Type<typeof MaximumDelayMillis>

/**
 * Stable machine-readable BPMN timer validation failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidMaximumDelay: "InvalidMaximumDelay",
  InvalidScheduledAt: "InvalidScheduledAt",
  InvalidFixedDuration: "InvalidFixedDuration",
  NegativeDuration: "NegativeDuration",
  CalendarUnitUnsupported: "CalendarUnitUnsupported",
  SubMillisecondPrecision: "SubMillisecondPrecision",
  DelayExceedsProtocolMaximum: "DelayExceedsProtocolMaximum",
  DelayExceedsMaximum: "DelayExceedsMaximum",
  DueAtOutOfRange: "DueAtOutOfRange",
  InvalidTimeDate: "InvalidTimeDate"
} as const

/**
 * A stable machine-readable BPMN timer validation failure.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof Codes[keyof typeof Codes]

const ErrorCode = Schema.Literals([
  Codes.InvalidMaximumDelay,
  Codes.InvalidScheduledAt,
  Codes.InvalidFixedDuration,
  Codes.NegativeDuration,
  Codes.CalendarUnitUnsupported,
  Codes.SubMillisecondPrecision,
  Codes.DelayExceedsProtocolMaximum,
  Codes.DelayExceedsMaximum,
  Codes.DueAtOutOfRange,
  Codes.InvalidTimeDate
])

/**
 * Raised when a BPMN timer lexical value, anchor, or explicit bound cannot be
 * interpreted without ambiguity, rounding, or range loss.
 *
 * @category errors
 * @since 4.0.0
 */
export class BpmnTimeError extends Schema.TaggedErrorClass<BpmnTimeError>(
  "@effect/workflow-builder/BpmnTime/Error"
)("BpmnTimeError", {
  code: ErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const error = (
  code: ErrorCode,
  message: string,
  details?: Schema.Json
): BpmnTimeError =>
  new BpmnTimeError({
    code,
    message,
    ...(details === undefined ? undefined : { details })
  })

interface DurationFailure {
  readonly code:
    | typeof Codes.InvalidFixedDuration
    | typeof Codes.NegativeDuration
    | typeof Codes.CalendarUnitUnsupported
    | typeof Codes.SubMillisecondPrecision
    | typeof Codes.DelayExceedsProtocolMaximum
  readonly message: string
}

const durationPattern = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$/

const hasBoundedLexicalUtf8Bytes = (lexical: string): boolean =>
  lexical.length <= MaximumTimerLexicalUtf8Bytes &&
  new TextEncoder().encode(lexical).byteLength <=
    MaximumTimerLexicalUtf8Bytes

const parseBoundedInteger = (
  digits: string,
  maximum: bigint
): bigint | undefined => {
  let value = BigInt(0)
  for (let index = 0; index < digits.length; index++) {
    value = value * BigInt(10) + BigInt(digits.charCodeAt(index) - 48)
    if (value > maximum) {
      return undefined
    }
  }
  return value
}

const analyzeFixedDuration = (
  lexical: string
): Result.Result<number, DurationFailure> => {
  if (!hasBoundedLexicalUtf8Bytes(lexical)) {
    return Result.fail({
      code: Codes.InvalidFixedDuration,
      message: `BPMN fixed duration exceeds the ${MaximumTimerLexicalUtf8Bytes}-byte lexical ceiling`
    })
  }
  if (lexical.startsWith("-P")) {
    return Result.fail({
      code: Codes.NegativeDuration,
      message: "BPMN fixed durations cannot have a negative sign"
    })
  }

  const timeMarker = lexical.indexOf("T")
  const datePart = lexical.slice(1, timeMarker === -1 ? undefined : timeMarker)
  if (datePart.includes("Y") || datePart.includes("M")) {
    return Result.fail({
      code: Codes.CalendarUnitUnsupported,
      message: "BPMN fixed durations cannot contain calendar years or months"
    })
  }

  const match = durationPattern.exec(lexical)
  if (match === null) {
    return Result.fail({
      code: Codes.InvalidFixedDuration,
      message: "Invalid XML Schema fixed-duration lexical value"
    })
  }

  const days = match[1]
  const hours = match[2]
  const minutes = match[3]
  const seconds = match[4]
  const fraction = match[5]
  if (
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return Result.fail({
      code: Codes.InvalidFixedDuration,
      message: "A fixed duration must contain at least one duration component"
    })
  }
  if (
    timeMarker !== -1 &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return Result.fail({
      code: Codes.InvalidFixedDuration,
      message: "The duration time marker must be followed by a time component"
    })
  }
  if (
    fraction !== undefined &&
    fraction.length > 3 &&
    /[1-9]/.test(fraction.slice(3))
  ) {
    return Result.fail({
      code: Codes.SubMillisecondPrecision,
      message: "A fixed duration must represent an exact whole-millisecond value"
    })
  }

  const protocolMaximum = BigInt(
    ProtocolV3Wire.MaximumSemanticDelayMillis
  )
  let total = BigInt(0)
  const add = (digits: string | undefined, multiplier: bigint): boolean => {
    if (digits === undefined) {
      return true
    }
    const component = parseBoundedInteger(
      digits,
      protocolMaximum / multiplier
    )
    if (component === undefined) {
      return false
    }
    const increment = component * multiplier
    if (total > protocolMaximum - increment) {
      return false
    }
    total += increment
    return true
  }

  if (
    !add(days, BigInt(86_400_000)) ||
    !add(hours, BigInt(3_600_000)) ||
    !add(minutes, BigInt(60_000)) ||
    !add(seconds, BigInt(1_000))
  ) {
    return Result.fail({
      code: Codes.DelayExceedsProtocolMaximum,
      message: "Fixed duration exceeds the protocol semantic-delay ceiling"
    })
  }

  if (fraction !== undefined) {
    const fractionMillis = BigInt(fraction.slice(0, 3).padEnd(3, "0"))
    if (total > protocolMaximum - fractionMillis) {
      return Result.fail({
        code: Codes.DelayExceedsProtocolMaximum,
        message: "Fixed duration exceeds the protocol semantic-delay ceiling"
      })
    }
    total += fractionMillis
  }

  return Result.succeed(Number(total))
}

const formatFixedDuration = (delayMillis: number): string => {
  let remainder = delayMillis
  const days = Math.floor(remainder / 86_400_000)
  remainder -= days * 86_400_000
  const hours = Math.floor(remainder / 3_600_000)
  remainder -= hours * 3_600_000
  const minutes = Math.floor(remainder / 60_000)
  remainder -= minutes * 60_000
  const seconds = Math.floor(remainder / 1_000)
  const millis = remainder - seconds * 1_000

  if (delayMillis === 0) {
    return "PT0S"
  }

  let lexical = days === 0 ? "P" : `P${days}D`
  if (hours !== 0 || minutes !== 0 || seconds !== 0 || millis !== 0) {
    lexical += "T"
    if (hours !== 0) {
      lexical += `${hours}H`
    }
    if (minutes !== 0) {
      lexical += `${minutes}M`
    }
    if (seconds !== 0 || millis !== 0) {
      lexical += `${seconds}`
      if (millis !== 0) {
        lexical += `.${String(millis).padStart(3, "0").replace(/0+$/, "")}`
      }
      lexical += "S"
    }
  }
  return lexical
}

/**
 * Canonical lexical spelling of one bounded, fixed BPMN duration.
 *
 * **Details**
 *
 * The spelling uses normalized day, hour, minute, second, and millisecond
 * components. Zero is `PT0S`; redundant leading zeros and trailing fractional
 * zeros are absent.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FixedDurationLexical = Schema.String.check(
  Schema.makeFilter(
    (lexical) => {
      const analyzed = analyzeFixedDuration(lexical)
      return Result.isSuccess(analyzed) &&
        formatFixedDuration(analyzed.success) === lexical
    },
    { expected: "a canonical bounded fixed BPMN duration" }
  )
).annotate({ identifier: "WorkflowBpmnTimeFixedDurationLexical" })

/**
 * The decoded type of {@link FixedDurationLexical}.
 *
 * @category models
 * @since 4.0.0
 */
export type FixedDurationLexical = Schema.Schema.Type<
  typeof FixedDurationLexical
>

/**
 * Parsed and normalized fixed BPMN duration.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FixedDuration = Schema.Struct({
  lexicalVersion: Schema.Literal(LexicalVersion),
  lexical: FixedDurationLexical,
  delayMillis: ProtocolV3Wire.SemanticDelayMillis
}).check(
  Schema.makeFilter(
    (value) => {
      const analyzed = analyzeFixedDuration(value.lexical)
      return Result.isSuccess(analyzed) &&
        analyzed.success === value.delayMillis
    },
    { expected: "matching canonical duration lexical and millisecond values" }
  )
).annotate({
  identifier: "WorkflowBpmnTimeFixedDuration",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FixedDuration}.
 *
 * @category models
 * @since 4.0.0
 */
export type FixedDuration = Schema.Schema.Type<typeof FixedDuration>

/**
 * A fixed-duration timer resolved against one persisted schedule anchor.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DurationResolution = Schema.Struct({
  lexicalVersion: Schema.Literal(LexicalVersion),
  lexical: FixedDurationLexical,
  delayMillis: ProtocolV3Wire.SemanticDelayMillis,
  dueAt: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnTimeDurationResolution",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DurationResolution}.
 *
 * @category models
 * @since 4.0.0
 */
export type DurationResolution = Schema.Schema.Type<typeof DurationResolution>

/**
 * Canonical UTC form of a parsed BPMN `timeDate`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeDate = Schema.Struct({
  lexicalVersion: Schema.Literal(LexicalVersion),
  lexical: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnTimeDate",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimeDate}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimeDate = Schema.Schema.Type<typeof TimeDate>

/**
 * An absolute BPMN date timer resolved against one persisted schedule anchor.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeDateResolution = Schema.Struct({
  lexicalVersion: Schema.Literal(LexicalVersion),
  lexical: ProtocolV2Wire.Timestamp,
  delayMillis: ProtocolV3Wire.SemanticDelayMillis,
  dueAt: ProtocolV2Wire.Timestamp
}).check(
  Schema.makeFilter(
    (value) => value.lexical === value.dueAt,
    { expected: "an absolute timer whose normalized lexical value is dueAt" }
  )
).annotate({
  identifier: "WorkflowBpmnTimeDateResolution",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimeDateResolution}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimeDateResolution = Schema.Schema.Type<
  typeof TimeDateResolution
>

const timeDatePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/

const daysInMonth = (year: number, month: number): number => {
  const leapYear = year % 4 === 0 &&
    (year % 100 !== 0 || year % 400 === 0)
  return [
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
  ][month - 1] ?? 0
}

interface TimeDateFailure {
  readonly code:
    | typeof Codes.InvalidTimeDate
    | typeof Codes.SubMillisecondPrecision
  readonly message: string
}

const decodeTimestamp = Schema.decodeUnknownResult(
  ProtocolV2Wire.Timestamp,
  strictParseOptions
)

const analyzeTimeDate = (
  lexical: string
): Result.Result<ProtocolV2Wire.Timestamp, TimeDateFailure> => {
  if (!hasBoundedLexicalUtf8Bytes(lexical)) {
    return Result.fail({
      code: Codes.InvalidTimeDate,
      message: `BPMN timeDate exceeds the ${MaximumTimerLexicalUtf8Bytes}-byte lexical ceiling`
    })
  }
  const match = timeDatePattern.exec(lexical)
  if (match === null) {
    return Result.fail({
      code: Codes.InvalidTimeDate,
      message: "BPMN timeDate must be an ISO date-time with Z or an explicit offset"
    })
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7]
  const zone = match[8]!
  const offsetSign = match[9]
  const offsetHour = match[10] === undefined ? 0 : Number(match[10])
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11])

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return Result.fail({
      code: Codes.InvalidTimeDate,
      message: "BPMN timeDate contains an invalid calendar, time, or offset component"
    })
  }
  if (
    fraction !== undefined &&
    fraction.length > 3 &&
    /[1-9]/.test(fraction.slice(3))
  ) {
    return Result.fail({
      code: Codes.SubMillisecondPrecision,
      message: "BPMN timeDate must represent an exact whole-millisecond instant"
    })
  }

  const millis = fraction === undefined
    ? 0
    : Number(fraction.slice(0, 3).padEnd(3, "0"))
  const localDate = new Date(0)
  localDate.setUTCHours(0, 0, 0, 0)
  localDate.setUTCFullYear(year, month - 1, day)
  localDate.setUTCHours(hour, minute, second, millis)
  const offsetMillis = (offsetHour * 60 + offsetMinute) * 60_000
  const epochMillis = localDate.getTime() -
    (zone === "Z" ? 0 : offsetSign === "+" ? offsetMillis : -offsetMillis)
  if (!Number.isSafeInteger(epochMillis)) {
    return Result.fail({
      code: Codes.InvalidTimeDate,
      message: "BPMN timeDate is outside the safe millisecond range"
    })
  }

  let canonical: string
  try {
    canonical = new Date(epochMillis).toISOString()
  } catch {
    return Result.fail({
      code: Codes.InvalidTimeDate,
      message: "BPMN timeDate is outside the supported calendar range"
    })
  }

  let decoded: ReturnType<typeof decodeTimestamp>
  try {
    decoded = decodeTimestamp(canonical)
  } catch {
    return Result.fail({
      code: Codes.InvalidTimeDate,
      message: "Canonical BPMN timeDate validation threw unexpectedly"
    })
  }
  return Result.isFailure(decoded)
    ? Result.fail({
      code: Codes.InvalidTimeDate,
      message: "BPMN timeDate cannot normalize to a protocol timestamp"
    })
    : Result.succeed(decoded.success)
}

const decodeMaximum = Schema.decodeUnknownResult(
  MaximumDelayMillis,
  strictParseOptions
)
const decodeScheduledAt = Schema.decodeUnknownResult(
  ProtocolV2Wire.Timestamp,
  strictParseOptions
)

const validateMaximum = (
  input: unknown
): Result.Result<MaximumDelayMillis, BpmnTimeError> => {
  let decoded: ReturnType<typeof decodeMaximum>
  try {
    decoded = decodeMaximum(input)
  } catch {
    return Result.fail(error(
      Codes.InvalidMaximumDelay,
      "Maximum delay schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      Codes.InvalidMaximumDelay,
      "Maximum delay must be a non-negative whole millisecond value within the protocol ceiling",
      { parseError: decoded.failure.message }
    ))
    : Result.succeed(decoded.success)
}

const validateScheduledAt = (
  input: unknown
): Result.Result<ProtocolV2Wire.Timestamp, BpmnTimeError> => {
  let decoded: ReturnType<typeof decodeScheduledAt>
  try {
    decoded = decodeScheduledAt(input)
  } catch {
    return Result.fail(error(
      Codes.InvalidScheduledAt,
      "Schedule anchor schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      Codes.InvalidScheduledAt,
      "scheduledAt must be a canonical protocol version 2 UTC timestamp",
      { parseError: decoded.failure.message }
    ))
    : Result.succeed(decoded.success)
}

const materializeDueAt = (
  scheduledAt: ProtocolV2Wire.Timestamp,
  delayMillis: number
): Result.Result<ProtocolV2Wire.Timestamp, BpmnTimeError> => {
  const scheduledEpoch = Date.parse(scheduledAt)
  if (
    !Number.isSafeInteger(scheduledEpoch) ||
    scheduledEpoch > Number.MAX_SAFE_INTEGER - delayMillis
  ) {
    return Result.fail(error(
      Codes.DueAtOutOfRange,
      "Timer dueAt exceeds the safe-integer millisecond range"
    ))
  }

  let canonical: string
  try {
    canonical = new Date(scheduledEpoch + delayMillis).toISOString()
  } catch {
    return Result.fail(error(
      Codes.DueAtOutOfRange,
      "Timer dueAt is outside the supported calendar range"
    ))
  }

  let decoded: ReturnType<typeof decodeTimestamp>
  try {
    decoded = decodeTimestamp(canonical)
  } catch {
    return Result.fail(error(
      Codes.DueAtOutOfRange,
      "Canonical timer dueAt validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      Codes.DueAtOutOfRange,
      "Timer dueAt is outside the protocol version 2 timestamp range"
    ))
    : Result.succeed(decoded.success)
}

/**
 * Parses and normalizes one non-negative fixed BPMN `timeDuration`.
 *
 * **Details**
 *
 * The accepted lexical grammar is the day/time subset of XML Schema
 * `duration`: `P[nD][T[nH][nM][n[.f]S]]`. Years, calendar months, weeks,
 * signs, exponents, and empty component lists are rejected. Hour, minute, and
 * second components may exceed their normalized ranges because their meaning
 * is still fixed.
 *
 * Fractional seconds must denote exact whole milliseconds. More than three
 * fractional digits are accepted only when every additional digit is zero.
 * Arithmetic is bounded before conversion to `number`, then checked against
 * both {@link ProtocolV3Wire.MaximumSemanticDelayMillis} and the caller's
 * explicit `maximumDelayMillis`.
 *
 * @category validation
 * @since 4.0.0
 */
export const parseFixedDuration = (
  input: unknown,
  maximumDelayMillis: MaximumDelayMillis
): Result.Result<FixedDuration, BpmnTimeError> => {
  const maximum = validateMaximum(maximumDelayMillis)
  if (Result.isFailure(maximum)) {
    return Result.fail(maximum.failure)
  }
  if (typeof input !== "string") {
    return Result.fail(error(
      Codes.InvalidFixedDuration,
      "BPMN fixed duration must be a string"
    ))
  }

  const analyzed = analyzeFixedDuration(input)
  if (Result.isFailure(analyzed)) {
    return Result.fail(error(analyzed.failure.code, analyzed.failure.message))
  }
  if (analyzed.success > maximum.success) {
    return Result.fail(error(
      Codes.DelayExceedsMaximum,
      "Fixed duration exceeds the explicit delay ceiling",
      {
        delayMillis: analyzed.success,
        maximumDelayMillis: maximum.success
      }
    ))
  }

  return Result.succeed({
    lexicalVersion: LexicalVersion,
    lexical: formatFixedDuration(analyzed.success),
    delayMillis: analyzed.success
  })
}

/**
 * Resolves one fixed BPMN duration against a canonical persisted schedule
 * anchor.
 *
 * **Details**
 *
 * The duration crosses the same bounded lexical parser as
 * {@link parseFixedDuration}. `scheduledAt` must already use the exact
 * protocol version `2` UTC spelling. Addition and the resulting four-digit
 * year are checked before the canonical `dueAt` is returned.
 *
 * @category validation
 * @since 4.0.0
 */
export const durationDueAt = (
  scheduledAt: ProtocolV2Wire.Timestamp,
  input: unknown,
  maximumDelayMillis: MaximumDelayMillis
): Result.Result<DurationResolution, BpmnTimeError> => {
  const parsed = parseFixedDuration(input, maximumDelayMillis)
  if (Result.isFailure(parsed)) {
    return Result.fail(parsed.failure)
  }
  const anchor = validateScheduledAt(scheduledAt)
  if (Result.isFailure(anchor)) {
    return Result.fail(anchor.failure)
  }
  const dueAt = materializeDueAt(
    anchor.success,
    parsed.success.delayMillis
  )
  return Result.isFailure(dueAt)
    ? Result.fail(dueAt.failure)
    : Result.succeed({
      ...parsed.success,
      dueAt: dueAt.success
    })
}

/**
 * Parses and normalizes one absolute BPMN `timeDate`.
 *
 * **Details**
 *
 * Version `1` accepts a four-digit ISO calendar date and time followed by
 * uppercase `Z` or an XML Schema offset from `-14:00` through `+14:00`.
 * Calendar fields are checked independently of host parsing, including XML
 * Schema 1.0's prohibition of year `0000`. Fractional seconds follow the same
 * exact-millisecond rule as
 * {@link parseFixedDuration}. The result is normalized to the canonical
 * protocol version `2` `YYYY-MM-DDTHH:mm:ss.sssZ` spelling.
 *
 * @category validation
 * @since 4.0.0
 */
export const parseTimeDate = (
  input: unknown
): Result.Result<TimeDate, BpmnTimeError> => {
  if (typeof input !== "string") {
    return Result.fail(error(
      Codes.InvalidTimeDate,
      "BPMN timeDate must be a string"
    ))
  }
  const analyzed = analyzeTimeDate(input)
  return Result.isFailure(analyzed)
    ? Result.fail(error(analyzed.failure.code, analyzed.failure.message))
    : Result.succeed({
      lexicalVersion: LexicalVersion,
      lexical: analyzed.success
    })
}

/**
 * Resolves one absolute BPMN `timeDate` against a canonical persisted schedule
 * anchor.
 *
 * **Details**
 *
 * A date at or before `scheduledAt` is immediately eligible and therefore has
 * delay `0`. A future date's exact whole-millisecond difference must fit both
 * the protocol version `3` semantic-delay ceiling and the explicit
 * `maximumDelayMillis`. In either case the normalized absolute instant is
 * returned unchanged as `dueAt`, preserving its logical ordering meaning.
 *
 * @category validation
 * @since 4.0.0
 */
export const timeDateDueAt = (
  scheduledAt: ProtocolV2Wire.Timestamp,
  input: unknown,
  maximumDelayMillis: MaximumDelayMillis
): Result.Result<TimeDateResolution, BpmnTimeError> => {
  const maximum = validateMaximum(maximumDelayMillis)
  if (Result.isFailure(maximum)) {
    return Result.fail(maximum.failure)
  }
  const anchor = validateScheduledAt(scheduledAt)
  if (Result.isFailure(anchor)) {
    return Result.fail(anchor.failure)
  }
  const parsed = parseTimeDate(input)
  if (Result.isFailure(parsed)) {
    return Result.fail(parsed.failure)
  }

  const scheduledEpoch = Date.parse(anchor.success)
  const dueEpoch = Date.parse(parsed.success.lexical)
  if (
    !Number.isSafeInteger(scheduledEpoch) ||
    !Number.isSafeInteger(dueEpoch)
  ) {
    return Result.fail(error(
      Codes.InvalidTimeDate,
      "BPMN timer instants must be representable as safe epoch milliseconds"
    ))
  }
  const delayMillis = Math.max(0, dueEpoch - scheduledEpoch)
  if (delayMillis > maximum.success) {
    return Result.fail(error(
      Codes.DelayExceedsMaximum,
      "BPMN timeDate delay exceeds the explicit delay ceiling",
      {
        delayMillis,
        maximumDelayMillis: maximum.success
      }
    ))
  }

  return Result.succeed({
    lexicalVersion: LexicalVersion,
    lexical: parsed.success.lexical,
    delayMillis,
    dueAt: parsed.success.lexical
  })
}
