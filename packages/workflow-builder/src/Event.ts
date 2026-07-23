/**
 * Strict, versioned semantic history events for workflow runs.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"

const strictParseOptions = { onExcessProperty: "error" } as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const CompiledFingerprint = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/)
)

const isoTimestampPattern =
  /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

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
 * An ISO 8601 timestamp with an explicit UTC or numeric offset.
 *
 * **Details**
 *
 * The value remains a string after decoding so semantic events stay directly
 * JSON-compatible.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timestamp = Schema.String.check(
  Schema.isPattern(isoTimestampPattern),
  Schema.makeFilter(
    hasValidCalendarDate,
    { expected: "an ISO 8601 timestamp with an explicit offset" }
  )
).annotate({ identifier: "WorkflowEventTimestamp" })

/**
 * The decoded type of {@link Timestamp}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timestamp = Schema.Schema.Type<typeof Timestamp>

/**
 * Encoded named values routed through semantic history and commands.
 *
 * **Details**
 *
 * Optional values are represented by an omitted property, not `undefined` or a
 * sentinel. A present property may still contain JSON `null`. Source schemas
 * encode these values before commit and target schemas decode them at the
 * activity boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedValues = Schema.Record(Schema.String, Schema.Json).check(
  Schema.isPropertyNames(Schema.NonEmptyString)
).annotate({
  identifier: "WorkflowEncodedValues",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EncodedValues}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedValues = Schema.Schema.Type<typeof EncodedValues>

/**
 * Records the immutable meaning selected before a run starts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunStarted = Schema.TaggedStruct("RunStarted", {
  planId: Schema.NonEmptyString,
  planRevision: NonNegativeInt,
  definitionId: Schema.NonEmptyString,
  definitionVersion: Schema.NonEmptyString,
  compilerVersion: Schema.NonEmptyString,
  compiledFingerprint: CompiledFingerprint,
  backend: Schema.Literals(["direct", "durable"]),
  input: EncodedValues
}).annotate({
  identifier: "WorkflowRunStarted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunStarted}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunStarted = Schema.Schema.Type<typeof RunStarted>

/**
 * Records committed intent to execute one activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityScheduled = Schema.TaggedStruct("ActivityScheduled", {
  activityId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attempt: PositiveInt,
  idempotencyKey: Schema.NonEmptyString,
  input: EncodedValues
}).annotate({
  identifier: "WorkflowActivityScheduled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityScheduled}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityScheduled = Schema.Schema.Type<typeof ActivityScheduled>

/**
 * Records the encoded output of a successful activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivitySucceeded = Schema.TaggedStruct("ActivitySucceeded", {
  activityId: Schema.NonEmptyString,
  output: EncodedValues
}).annotate({
  identifier: "WorkflowActivitySucceeded",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivitySucceeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivitySucceeded = Schema.Schema.Type<typeof ActivitySucceeded>

/**
 * Records the encoded failure of an activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityFailed = Schema.TaggedStruct("ActivityFailed", {
  activityId: Schema.NonEmptyString,
  failure: Schema.Json
}).annotate({
  identifier: "WorkflowActivityFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityFailed = Schema.Schema.Type<typeof ActivityFailed>

/**
 * Records that cancellation was requested for a non-terminal run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunCancellationRequested = Schema.TaggedStruct("RunCancellationRequested", {}).annotate({
  identifier: "WorkflowRunCancellationRequested",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunCancellationRequested}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunCancellationRequested = Schema.Schema.Type<typeof RunCancellationRequested>

/**
 * Records the encoded output of a successful run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunSucceeded = Schema.TaggedStruct("RunSucceeded", {
  output: EncodedValues
}).annotate({
  identifier: "WorkflowRunSucceeded",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunSucceeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunSucceeded = Schema.Schema.Type<typeof RunSucceeded>

/**
 * Attributes terminal run failure to the exact failed activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityFailure = Schema.TaggedStruct("ActivityFailure", {
  activityId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attempt: PositiveInt,
  failure: Schema.Json
}).annotate({
  identifier: "WorkflowEventActivityFailure",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityFailure = Schema.Schema.Type<typeof ActivityFailure>

/**
 * Records the attributed encoded failure of a failed run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunFailed = Schema.TaggedStruct("RunFailed", {
  failure: ActivityFailure
}).annotate({
  identifier: "WorkflowRunFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunFailed = Schema.Schema.Type<typeof RunFailed>

/**
 * Records that a cancellation request reached its terminal state.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunCancelled = Schema.TaggedStruct("RunCancelled", {}).annotate({
  identifier: "WorkflowRunCancelled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunCancelled}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunCancelled = Schema.Schema.Type<typeof RunCancelled>

/**
 * The deliberately small semantic payload vocabulary supported by history
 * format version `1`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Payload = Schema.Union([
  RunStarted,
  ActivityScheduled,
  ActivitySucceeded,
  ActivityFailed,
  RunCancellationRequested,
  RunSucceeded,
  RunFailed,
  RunCancelled
]).annotate({ identifier: "WorkflowEventPayload" })

/**
 * The decoded type of {@link Payload}.
 *
 * @category models
 * @since 4.0.0
 */
export type Payload = Schema.Schema.Type<typeof Payload>

/**
 * A strict JSON semantic-history envelope.
 *
 * **Details**
 *
 * `sequence` is validated structurally here and checked for exact continuity
 * by the history fold. Optional causation and correlation identifiers are
 * omitted rather than represented by `undefined` on the wire.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Event = Schema.Struct({
  eventVersion: Schema.Literal(1),
  eventId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  sequence: NonNegativeInt,
  recordedAt: Timestamp,
  causationId: Schema.optionalKey(Schema.NonEmptyString),
  correlationId: Schema.optionalKey(Schema.NonEmptyString),
  payload: Payload
}).annotate({
  identifier: "WorkflowEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Event}.
 *
 * @category models
 * @since 4.0.0
 */
export type Event = Schema.Schema.Type<typeof Event>
