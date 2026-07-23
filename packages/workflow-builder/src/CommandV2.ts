/**
 * Strict semantic decision commands for execution protocol version `2`.
 *
 * **Details**
 *
 * Store-owned external facts such as activity results, timer fires, and signal
 * acceptance are deliberately absent. The authoritative store materializes
 * absolute timer deadlines from committed anchors; the decision layer never
 * reads a clock or supplies a deadline.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as ActivityPolicy from "./ActivityPolicy.ts"
import * as EventV2 from "./EventV2.ts"
import * as IdentityV2 from "./IdentityV2.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * The command-envelope format version defined by this module.
 *
 * @category constants
 * @since 4.0.0
 */
export const CommandVersion = 2 as const

/**
 * Encoded named values carried by version `2` commands.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedValues = EventV2.EncodedValues

/**
 * The decoded type of {@link EncodedValues}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedValues = EventV2.EncodedValues

/**
 * Requests one new semantic activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleActivityAttempt = Schema.TaggedStruct("ScheduleActivityAttempt", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  idempotencyKey: Schema.NonEmptyString,
  input: EncodedValues,
  policy: ActivityPolicy.Policy
}).annotate({
  identifier: "WorkflowCommandV2ScheduleActivityAttempt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleActivityAttempt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleActivityAttempt = Schema.Schema.Type<typeof ScheduleActivityAttempt>

/**
 * Requests admission of the next logical attempt after a committed failure.
 *
 * **Details**
 *
 * The selected delay is a semantic choice. `anchorEventId` must name the exact
 * failed or timed-out attempt fact. The absolute deadline is omitted because
 * storage derives it exactly once from that committed event's timestamp.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleRetry = Schema.TaggedStruct("ScheduleRetry", {
  retryId: Schema.NonEmptyString,
  logicalActivityId: Schema.NonEmptyString,
  failedAttemptId: Schema.NonEmptyString,
  failedAttempt: PositiveSafeInt,
  nextAttempt: PositiveSafeInt,
  anchorEventId: Schema.NonEmptyString,
  timerId: Schema.NonEmptyString,
  selectedDelayMillis: ProtocolV2Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowCommandV2ScheduleRetry",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleRetry}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleRetry = Schema.Schema.Type<typeof ScheduleRetry>

/**
 * Requests the final failure of one exhausted or permanent logical activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FinalizeActivityFailure = Schema.TaggedStruct("FinalizeActivityFailure", {
  logicalActivityId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  cause: EventV2.ActivityFailureCause
}).annotate({
  identifier: "WorkflowCommandV2FinalizeActivityFailure",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FinalizeActivityFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type FinalizeActivityFailure = Schema.Schema.Type<typeof FinalizeActivityFailure>

/**
 * Requests one semantic timer relative to an already committed event.
 *
 * **Details**
 *
 * The anchor may also name an earlier event in the same atomic decision batch.
 * The store resolves and persists the absolute deadline before acknowledging
 * the commit.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleTimer = Schema.TaggedStruct("ScheduleTimer", {
  timerId: Schema.NonEmptyString,
  purpose: EventV2.TimerPurpose,
  anchorEventId: Schema.NonEmptyString,
  delayMillis: ProtocolV2Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowCommandV2ScheduleTimer",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleTimer}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleTimer = Schema.Schema.Type<typeof ScheduleTimer>

/**
 * Requests cancellation of one still-pending semantic timer.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancelTimer = Schema.TaggedStruct("CancelTimer", {
  timerId: Schema.NonEmptyString,
  reason: EventV2.TimerCancellationReason
}).annotate({
  identifier: "WorkflowCommandV2CancelTimer",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancelTimer}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancelTimer = Schema.Schema.Type<typeof CancelTimer>

/**
 * Requests one structured sleep with an immutable positive duration.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StartSleep = Schema.TaggedStruct("StartSleep", {
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  durationMillis: ProtocolV2Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowCommandV2StartSleep",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StartSleep}.
 *
 * @category models
 * @since 4.0.0
 */
export type StartSleep = Schema.Schema.Type<typeof StartSleep>

/**
 * Requests a durable wait for one admitted signal definition.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StartSignalWait = Schema.TaggedStruct("StartSignalWait", {
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  signalName: Schema.NonEmptyString,
  signalVersion: Schema.NonEmptyString,
  correlation: EventV2.SignalCorrelation,
  timeout: ActivityPolicy.Timeout
}).annotate({
  identifier: "WorkflowCommandV2StartSignalWait",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StartSignalWait}.
 *
 * @category models
 * @since 4.0.0
 */
export type StartSignalWait = Schema.Schema.Type<typeof StartSignalWait>

/**
 * Requests exactly one semantic consumption of an accepted signal.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ConsumeSignal = Schema.TaggedStruct("ConsumeSignal", {
  signalId: Schema.NonEmptyString,
  inboxSequence: NonNegativeSafeInt,
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowCommandV2ConsumeSignal",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ConsumeSignal}.
 *
 * @category models
 * @since 4.0.0
 */
export type ConsumeSignal = Schema.Schema.Type<typeof ConsumeSignal>

/**
 * Requests successful terminal run completion.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SucceedRun = Schema.TaggedStruct("SucceedRun", {
  output: EncodedValues
}).annotate({
  identifier: "WorkflowCommandV2SucceedRun",
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
 * Requests attributed terminal run failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FailRun = Schema.TaggedStruct("FailRun", {
  cause: EventV2.RunFailureCause
}).annotate({
  identifier: "WorkflowCommandV2FailRun",
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
 * Requests terminal cancellation after cancellation intent was committed.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancelRun = Schema.TaggedStruct("CancelRun", {}).annotate({
  identifier: "WorkflowCommandV2CancelRun",
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
 * Decision-owned protocol version `2` command payloads.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Payload = Schema.Union([
  ScheduleActivityAttempt,
  ScheduleRetry,
  FinalizeActivityFailure,
  ScheduleTimer,
  CancelTimer,
  StartSleep,
  StartSignalWait,
  ConsumeSignal,
  SucceedRun,
  FailRun,
  CancelRun
]).annotate({ identifier: "WorkflowCommandV2Payload" })

/**
 * The decoded type of {@link Payload}.
 *
 * @category models
 * @since 4.0.0
 */
export type Payload = Schema.Schema.Type<typeof Payload>

/**
 * A strict tenant- and run-bound protocol version `2` command envelope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Command = Schema.Struct({
  commandVersion: Schema.Literal(CommandVersion),
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  commandId: Schema.NonEmptyString,
  payload: Payload
}).annotate({
  identifier: "WorkflowCommandV2",
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
 * Returns the static node-instance identity for a root plan node.
 *
 * @category constructors
 * @since 4.0.0
 */
export const staticNodeInstanceId = (nodeId: string): string => nodeId

/**
 * Returns the tenant-scoped logical activity identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const logicalActivityId = IdentityV2.logicalActivityId

/**
 * Returns the identity of one semantic activity attempt.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityAttemptId = IdentityV2.activityAttemptId

/**
 * Returns the external idempotency key shared by all semantic attempts.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityIdempotencyKey = IdentityV2.activityIdempotencyKey

/**
 * Returns the shared activity-attempt schedule command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleActivityCommandId = IdentityV2.scheduleActivityCommandId

/**
 * Returns the shared retry schedule command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleRetryCommandId = IdentityV2.scheduleRetryCommandId

/**
 * Returns the shared final activity-failure command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const finalizeActivityFailureCommandId = IdentityV2.finalizeActivityFailureCommandId

/**
 * Returns the shared timer schedule command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleTimerCommandId = IdentityV2.scheduleTimerCommandId

/**
 * Returns the shared timer cancellation command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cancelTimerCommandId = IdentityV2.cancelTimerCommandId

/**
 * Returns the stable identity of one structured sleep wait.
 *
 * @category constructors
 * @since 4.0.0
 */
export const sleepWaitId = IdentityV2.sleepWaitId

/**
 * Returns the shared sleep-start command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const startSleepCommandId = IdentityV2.startSleepCommandId

/**
 * Returns the shared signal-wait start command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const startSignalWaitCommandId = IdentityV2.startSignalWaitCommandId

/**
 * Returns the shared signal-consumption command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const consumeSignalCommandId = IdentityV2.consumeSignalCommandId

/**
 * Returns the shared successful terminal command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const succeedRunCommandId = IdentityV2.succeedRunCommandId

/**
 * Returns the shared failed terminal command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failRunCommandId = IdentityV2.failRunCommandId

/**
 * Returns the shared cancelled terminal command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cancelRunCommandId = IdentityV2.cancelRunCommandId
