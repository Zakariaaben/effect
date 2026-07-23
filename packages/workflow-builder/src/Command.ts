/**
 * Strict, versioned semantic commands for workflow runs.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as Event from "./Event.ts"
import * as Identity from "./Identity.ts"

const strictParseOptions = { onExcessProperty: "error" } as const
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * A string-keyed object containing encoded JSON values.
 *
 * **Details**
 *
 * Arrays, `null`, empty property names, and non-JSON values are rejected. This
 * is the same encoded-values boundary used by semantic history events.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedValues = Event.EncodedValues

/**
 * The decoded type of {@link EncodedValues}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedValues = Schema.Schema.Type<typeof EncodedValues>

/**
 * Requests execution of one admitted activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleActivity = Schema.TaggedStruct("ScheduleActivity", {
  activityId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attempt: PositiveInt,
  idempotencyKey: Schema.NonEmptyString,
  input: EncodedValues
}).annotate({
  identifier: "WorkflowScheduleActivityCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleActivity}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleActivity = Schema.Schema.Type<typeof ScheduleActivity>

/**
 * Requests successful run completion with encoded outputs.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SucceedRun = Schema.TaggedStruct("SucceedRun", {
  output: EncodedValues
}).annotate({
  identifier: "WorkflowSucceedRunCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SucceedRun}.
 *
 * @category models
 * @since 4.0.0
 */
export type SucceedRun = Schema.Schema.Type<typeof SucceedRun>

/**
 * Identifies the activity attempt whose encoded failure terminates a run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityFailure = Event.ActivityFailure

/**
 * The decoded type of {@link ActivityFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityFailure = Event.ActivityFailure

/**
 * Requests failed run completion with the originating activity failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FailRun = Schema.TaggedStruct("FailRun", {
  failure: ActivityFailure
}).annotate({
  identifier: "WorkflowFailRunCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FailRun}.
 *
 * @category models
 * @since 4.0.0
 */
export type FailRun = Schema.Schema.Type<typeof FailRun>

/**
 * Requests terminal cancellation of a run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancelRun = Schema.TaggedStruct("CancelRun", {}).annotate({
  identifier: "WorkflowCancelRunCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancelRun}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancelRun = Schema.Schema.Type<typeof CancelRun>

/**
 * The deliberately small semantic command vocabulary supported by format
 * version `1`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Payload = Schema.Union([
  ScheduleActivity,
  SucceedRun,
  FailRun,
  CancelRun
]).annotate({ identifier: "WorkflowCommandPayload" })

/**
 * The decoded type of {@link Payload}.
 *
 * @category models
 * @since 4.0.0
 */
export type Payload = Schema.Schema.Type<typeof Payload>

/**
 * A strict JSON semantic-command envelope.
 *
 * **Details**
 *
 * Command identifiers are deterministic identities selected by the decision
 * layer. They allow a backend to deduplicate repeated decisions without
 * depending on array position or delivery timing.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Command = Schema.Struct({
  commandVersion: Schema.Literal(1),
  commandId: Schema.NonEmptyString,
  payload: Payload
}).annotate({
  identifier: "WorkflowCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Command}.
 *
 * @category models
 * @since 4.0.0
 */
export type Command = Schema.Schema.Type<typeof Command>

/**
 * Returns the v1 node-instance identity for a static plan node.
 *
 * **Details**
 *
 * Static nodes have exactly one instance per run, so their admitted nonempty
 * node identifier is already the stable instance identifier. This helper
 * expects an identifier admitted by the command or plan schemas and does not
 * perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const staticNodeInstanceId = (nodeId: string): string => nodeId

/**
 * Returns the stable identity of an activity attempt.
 *
 * **Details**
 *
 * A versioned JSON tuple preserves component boundaries even when identifiers
 * contain delimiters. Inputs are expected to be admitted nonempty identifiers
 * and a positive integer attempt; this helper does not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityId = (runId: string, nodeInstanceId: string, attempt: number): string =>
  Identity.activityId(runId, nodeInstanceId, attempt)

/**
 * Returns the default external idempotency key for a node instance.
 *
 * **Details**
 *
 * The attempt is deliberately absent, keeping the key stable across distinct
 * attempt identities. Version `1` currently emits only attempt `1`; retaining
 * this boundary avoids silently changing external idempotency if later command
 * versions add retry semantics. Inputs are expected to be admitted nonempty
 * identifiers; this helper does not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityIdempotencyKey = (runId: string, nodeInstanceId: string): string =>
  Identity.activityIdempotencyKey(runId, nodeInstanceId)

/**
 * Returns the deterministic command identity for scheduling an activity
 * attempt.
 *
 * **Details**
 *
 * Inputs are expected to be admitted nonempty identifiers and a positive
 * integer attempt; this helper does not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleActivityCommandId = (
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => Identity.scheduleActivityCommandId(runId, nodeInstanceId, attempt)

/**
 * Returns the deterministic command identity for successful run completion.
 *
 * **Details**
 *
 * The run identifier is expected to be admitted and nonempty; this helper does
 * not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const succeedRunCommandId = (runId: string): string => Identity.succeedRunCommandId(runId)

/**
 * Returns the deterministic command identity for failed run completion.
 *
 * **Details**
 *
 * The run identifier is expected to be admitted and nonempty; this helper does
 * not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failRunCommandId = (runId: string): string => Identity.failRunCommandId(runId)

/**
 * Returns the deterministic command identity for terminal run cancellation.
 *
 * **Details**
 *
 * The run identifier is expected to be admitted and nonempty; this helper does
 * not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cancelRunCommandId = (runId: string): string => Identity.cancelRunCommandId(runId)
