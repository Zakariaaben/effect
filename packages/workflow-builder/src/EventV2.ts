/**
 * Strict protocol version 2 semantic history events.
 *
 * **Details**
 *
 * This module intentionally does not extend or import the version 1 event
 * schema. A protocol version selects one complete wire contract so an omitted
 * version 2 field can never silently acquire version 1 meaning.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as ActivityPolicy from "./ActivityPolicy.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as SignalContractV2 from "./SignalContractV2.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeSafeInt = ProtocolV2Wire.NonNegativeSafeInt
const PositiveSafeInt = ProtocolV2Wire.PositiveSafeInt

/**
 * The event-envelope format version defined by this module.
 *
 * @category constants
 * @since 4.0.0
 */
export const EventVersion = 2 as const

/**
 * The execution protocol selected by a version 2 run-start fact.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 2 as const

/**
 * A canonical UTC ISO 8601 timestamp at millisecond precision.
 *
 * **Details**
 *
 * Semantic time is store-owned and policies use whole milliseconds. Requiring
 * `YYYY-MM-DDTHH:mm:ss.sssZ` prevents equivalent offset spellings and silent
 * sub-millisecond truncation from changing replay or deadline meaning.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timestamp = ProtocolV2Wire.Timestamp

/**
 * The decoded type of {@link Timestamp}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timestamp = Schema.Schema.Type<typeof Timestamp>

/**
 * Encoded named values at protocol version 2 boundaries.
 *
 * **Details**
 *
 * Every present property must contain strict JSON. Optional application values
 * are represented by an omitted property, not `undefined`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedValues = Schema.Record(Schema.String, Schema.Json).check(
  Schema.isPropertyNames(Schema.NonEmptyString)
).annotate({
  identifier: "WorkflowEventV2EncodedValues",
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
 * Activity-attempt timeout kinds represented by protocol version 2.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityAttemptTimeoutKind = Schema.Literals([
  "ScheduleToStart",
  "StartToClose"
]).annotate({ identifier: "WorkflowEventV2ActivityAttemptTimeoutKind" })

/**
 * The decoded type of {@link ActivityAttemptTimeoutKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityAttemptTimeoutKind = Schema.Schema.Type<typeof ActivityAttemptTimeoutKind>

/**
 * Final activity failure caused by an encoded application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedFailureCause = Schema.TaggedStruct("EncodedFailure", {
  failure: Schema.Json
}).annotate({
  identifier: "WorkflowEventV2EncodedFailureCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EncodedFailureCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedFailureCause = Schema.Schema.Type<typeof EncodedFailureCause>

/**
 * Final activity failure caused by an attempt timeout.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptTimeoutCause = Schema.TaggedStruct("AttemptTimeout", {
  timeoutKind: ActivityAttemptTimeoutKind
}).annotate({
  identifier: "WorkflowEventV2AttemptTimeoutCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AttemptTimeoutCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type AttemptTimeoutCause = Schema.Schema.Type<typeof AttemptTimeoutCause>

/**
 * Final activity failure caused by its total schedule-to-close deadline.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleToCloseTimeoutCause = Schema.TaggedStruct("ScheduleToCloseTimeout", {
  timerId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2ScheduleToCloseTimeoutCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleToCloseTimeoutCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleToCloseTimeoutCause = Schema.Schema.Type<typeof ScheduleToCloseTimeoutCause>

/**
 * Exhaustive final logical-activity failure causes.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityFailureCause = Schema.Union([
  EncodedFailureCause,
  AttemptTimeoutCause,
  ScheduleToCloseTimeoutCause
]).annotate({ identifier: "WorkflowEventV2ActivityFailureCause" })

/**
 * The decoded type of {@link ActivityFailureCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityFailureCause = Schema.Schema.Type<typeof ActivityFailureCause>

/**
 * A retry-backoff timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryBackoffTimerPurpose = Schema.TaggedStruct("RetryBackoff", {
  retryId: Schema.NonEmptyString,
  logicalActivityId: Schema.NonEmptyString,
  nextAttempt: PositiveSafeInt
}).annotate({
  identifier: "WorkflowEventV2RetryBackoffTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryBackoffTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryBackoffTimerPurpose = Schema.Schema.Type<typeof RetryBackoffTimerPurpose>

/**
 * A schedule-to-start timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleToStartTimerPurpose = Schema.TaggedStruct("ScheduleToStart", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt
}).annotate({
  identifier: "WorkflowEventV2ScheduleToStartTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleToStartTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleToStartTimerPurpose = Schema.Schema.Type<typeof ScheduleToStartTimerPurpose>

/**
 * A start-to-close timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StartToCloseTimerPurpose = Schema.TaggedStruct("StartToClose", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt
}).annotate({
  identifier: "WorkflowEventV2StartToCloseTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StartToCloseTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type StartToCloseTimerPurpose = Schema.Schema.Type<typeof StartToCloseTimerPurpose>

/**
 * A schedule-to-close timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleToCloseTimerPurpose = Schema.TaggedStruct("ScheduleToClose", {
  logicalActivityId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2ScheduleToCloseTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleToCloseTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleToCloseTimerPurpose = Schema.Schema.Type<typeof ScheduleToCloseTimerPurpose>

/**
 * A signal-expiry timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalExpiryTimerPurpose = Schema.TaggedStruct("SignalExpiry", {
  signalId: Schema.NonEmptyString,
  inboxSequence: NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowEventV2SignalExpiryTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalExpiryTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalExpiryTimerPurpose = Schema.Schema.Type<typeof SignalExpiryTimerPurpose>

/**
 * A signal-wait timeout timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalWaitTimeoutTimerPurpose = Schema.TaggedStruct("SignalWaitTimeout", {
  waitId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2SignalWaitTimeoutTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalWaitTimeoutTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalWaitTimeoutTimerPurpose = Schema.Schema.Type<typeof SignalWaitTimeoutTimerPurpose>

/**
 * A structured sleep timer purpose.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SleepTimerPurpose = Schema.TaggedStruct("Sleep", {
  waitId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2SleepTimerPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SleepTimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type SleepTimerPurpose = Schema.Schema.Type<typeof SleepTimerPurpose>

/**
 * Exhaustive semantic timer ownership in protocol version 2.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerPurpose = Schema.Union([
  RetryBackoffTimerPurpose,
  ScheduleToStartTimerPurpose,
  StartToCloseTimerPurpose,
  ScheduleToCloseTimerPurpose,
  SignalExpiryTimerPurpose,
  SignalWaitTimeoutTimerPurpose,
  SleepTimerPurpose
]).annotate({ identifier: "WorkflowEventV2TimerPurpose" })

/**
 * The decoded type of {@link TimerPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerPurpose = Schema.Schema.Type<typeof TimerPurpose>

/**
 * Reasons a semantic timer can be cancelled.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerCancellationReason = Schema.Literals([
  "OwnerCompleted",
  "OwnerFailed",
  "RunCancellationRequested",
  "RunTerminal",
  "SignalConsumed",
  "Superseded"
]).annotate({ identifier: "WorkflowEventV2TimerCancellationReason" })

/**
 * The decoded type of {@link TimerCancellationReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerCancellationReason = Schema.Schema.Type<typeof TimerCancellationReason>

/**
 * A signal or wait that accepts any correlation key.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AnySignalCorrelation = SignalContractV2.AnySignalCorrelation

/**
 * The decoded type of {@link AnySignalCorrelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type AnySignalCorrelation = SignalContractV2.AnySignalCorrelation

/**
 * A signal or wait with an exact correlation key.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExactSignalCorrelation = SignalContractV2.ExactSignalCorrelation

/**
 * The decoded type of {@link ExactSignalCorrelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExactSignalCorrelation = SignalContractV2.ExactSignalCorrelation

/**
 * Required signal correlation semantics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalCorrelation = SignalContractV2.SignalCorrelation

/**
 * The decoded type of {@link SignalCorrelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalCorrelation = SignalContractV2.SignalCorrelation

/**
 * Records the immutable execution meaning selected before a run starts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunStarted = Schema.TaggedStruct("RunStarted", {
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  artifactVersion: Schema.Literal(2),
  artifactDigest: ProtocolV2Wire.ArtifactDigest,
  workflowIdentity: Schema.NonEmptyString,
  startRequestId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  planRevision: NonNegativeSafeInt,
  definitionId: Schema.NonEmptyString,
  definitionVersion: Schema.NonEmptyString,
  compilerVersion: Schema.NonEmptyString,
  compiledFingerprint: ProtocolV2Wire.CompiledFingerprint,
  backend: Schema.Literals(["direct", "durable"]),
  input: EncodedValues
}).annotate({
  identifier: "WorkflowEventV2RunStarted",
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
 * Records committed intent to execute one logical activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityScheduled = Schema.TaggedStruct("ActivityScheduled", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  idempotencyKey: Schema.NonEmptyString,
  input: EncodedValues,
  policy: ActivityPolicy.Policy
}).annotate({
  identifier: "WorkflowEventV2ActivityScheduled",
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
 * Records that a worker began one semantic activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityAttemptStarted = Schema.TaggedStruct("ActivityAttemptStarted", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt
}).annotate({
  identifier: "WorkflowEventV2ActivityAttemptStarted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityAttemptStarted}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityAttemptStarted = Schema.Schema.Type<typeof ActivityAttemptStarted>

/**
 * Records an encoded application failure from one activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityAttemptFailed = Schema.TaggedStruct("ActivityAttemptFailed", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  failure: Schema.Json
}).annotate({
  identifier: "WorkflowEventV2ActivityAttemptFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityAttemptFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityAttemptFailed = Schema.Schema.Type<typeof ActivityAttemptFailed>

/**
 * Records the timer that timed out one activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityAttemptTimedOut = Schema.TaggedStruct("ActivityAttemptTimedOut", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  timerId: Schema.NonEmptyString,
  timeoutKind: ActivityAttemptTimeoutKind
}).annotate({
  identifier: "WorkflowEventV2ActivityAttemptTimedOut",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityAttemptTimedOut}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityAttemptTimedOut = Schema.Schema.Type<typeof ActivityAttemptTimedOut>

/**
 * Commits one retry admission and its selected backoff decision.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryScheduled = Schema.TaggedStruct("RetryScheduled", {
  retryId: Schema.NonEmptyString,
  logicalActivityId: Schema.NonEmptyString,
  failedAttemptId: Schema.NonEmptyString,
  failedAttempt: PositiveSafeInt,
  nextAttempt: PositiveSafeInt,
  anchorEventId: Schema.NonEmptyString,
  timerId: Schema.NonEmptyString,
  selectedDelayMillis: ProtocolV2Wire.SemanticDelayMillis,
  deadline: Timestamp
}).annotate({
  identifier: "WorkflowEventV2RetryScheduled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryScheduled}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryScheduled = Schema.Schema.Type<typeof RetryScheduled>

/**
 * Records the encoded output of a successful logical activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivitySucceeded = Schema.TaggedStruct("ActivitySucceeded", {
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  output: EncodedValues
}).annotate({
  identifier: "WorkflowEventV2ActivitySucceeded",
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
 * Records the final attributed failure of one logical activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityFailed = Schema.TaggedStruct("ActivityFailed", {
  logicalActivityId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  cause: ActivityFailureCause
}).annotate({
  identifier: "WorkflowEventV2ActivityFailed",
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
 * Commits a semantic timer and its absolute replay deadline.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerScheduled = Schema.TaggedStruct("TimerScheduled", {
  timerId: Schema.NonEmptyString,
  purpose: TimerPurpose,
  anchorEventId: Schema.NonEmptyString,
  delayMillis: ProtocolV2Wire.SemanticDelayMillis,
  deadline: Timestamp
}).annotate({
  identifier: "WorkflowEventV2TimerScheduled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimerScheduled}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerScheduled = Schema.Schema.Type<typeof TimerScheduled>

/**
 * Records that a semantic timer reached its committed deadline.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerFired = Schema.TaggedStruct("TimerFired", {
  timerId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2TimerFired",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimerFired}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerFired = Schema.Schema.Type<typeof TimerFired>

/**
 * Records why a live semantic timer was cancelled.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerCancelled = Schema.TaggedStruct("TimerCancelled", {
  timerId: Schema.NonEmptyString,
  reason: TimerCancellationReason
}).annotate({
  identifier: "WorkflowEventV2TimerCancelled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimerCancelled}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerCancelled = Schema.Schema.Type<typeof TimerCancelled>

/**
 * Records one deduplicated, ordered signal-inbox acceptance.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalAccepted = Schema.TaggedStruct("SignalAccepted", {
  signalId: Schema.NonEmptyString,
  inboxSequence: NonNegativeSafeInt,
  signalName: Schema.NonEmptyString,
  signalVersion: Schema.NonEmptyString,
  correlation: SignalCorrelation,
  signalDefinitionDigest: ProtocolV2Wire.DefinitionDigest,
  requestDigest: ProtocolV2Wire.RequestDigest,
  payload: ProtocolV2Wire.EncodedPayload,
  payloadDigest: ProtocolV2Wire.PayloadDigest,
  encodedPayloadBytes: PositiveSafeInt,
  ttlMillis: ProtocolV2Wire.PositiveSemanticDelayMillis,
  admission: ProtocolV2Wire.AdmissionAttribution,
  expiresAt: Timestamp,
  expiryTimerId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2SignalAccepted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalAccepted}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalAccepted = Schema.Schema.Type<typeof SignalAccepted>

/**
 * Records a durable signal wait and its explicit timeout behavior.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalWaitStarted = Schema.TaggedStruct("SignalWaitStarted", {
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  signalName: Schema.NonEmptyString,
  signalVersion: Schema.NonEmptyString,
  correlation: SignalCorrelation,
  timeout: ActivityPolicy.Timeout
}).annotate({
  identifier: "WorkflowEventV2SignalWaitStarted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalWaitStarted}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalWaitStarted = Schema.Schema.Type<typeof SignalWaitStarted>

/**
 * Records one structured sleep owner and its immutable duration.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SleepStarted = Schema.TaggedStruct("SleepStarted", {
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  durationMillis: ProtocolV2Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowEventV2SleepStarted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SleepStarted}.
 *
 * @category models
 * @since 4.0.0
 */
export type SleepStarted = Schema.Schema.Type<typeof SleepStarted>

/**
 * Records which accepted signal satisfied which durable wait.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalConsumed = Schema.TaggedStruct("SignalConsumed", {
  signalId: Schema.NonEmptyString,
  inboxSequence: NonNegativeSafeInt,
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2SignalConsumed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalConsumed}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalConsumed = Schema.Schema.Type<typeof SignalConsumed>

/**
 * Records that cancellation was requested for a non-terminal run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunCancellationRequested = Schema.TaggedStruct("RunCancellationRequested", {
  requestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2RunCancellationRequested",
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
  identifier: "WorkflowEventV2RunSucceeded",
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
 * Attributes terminal run failure to a final logical-activity failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunActivityFailureCause = Schema.TaggedStruct("ActivityFailure", {
  logicalActivityId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt,
  cause: ActivityFailureCause
}).annotate({
  identifier: "WorkflowEventV2RunActivityFailureCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunActivityFailureCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunActivityFailureCause = Schema.Schema.Type<typeof RunActivityFailureCause>

/**
 * Attributes terminal run failure to a signal-wait timeout.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SignalWaitTimeoutFailureCause = Schema.TaggedStruct("SignalWaitTimeout", {
  waitId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  nodeInstanceId: Schema.NonEmptyString,
  timerId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEventV2SignalWaitTimeoutFailureCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SignalWaitTimeoutFailureCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalWaitTimeoutFailureCause = Schema.Schema.Type<typeof SignalWaitTimeoutFailureCause>

/**
 * Attributes terminal run failure to an authoritative protocol boundary.
 *
 * **Details**
 *
 * This initial cause is reserved for a valid semantic delay whose absolute
 * deadline cannot be represented from the committed anchor. The authority
 * records the exact command and anchor identities so replay does not depend on
 * a later clock or deployment.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProtocolFailureCause = Schema.TaggedStruct("ProtocolFailure", {
  code: Schema.Literal("DeadlineOutOfRange"),
  commandId: Schema.NonEmptyString,
  anchorEventId: Schema.NonEmptyString,
  delayMillis: ProtocolV2Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowEventV2ProtocolFailureCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProtocolFailureCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProtocolFailureCause = Schema.Schema.Type<typeof ProtocolFailureCause>

/**
 * Exhaustive terminal run-failure causes in the initial version 2 vocabulary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunFailureCause = Schema.Union([
  RunActivityFailureCause,
  SignalWaitTimeoutFailureCause,
  ProtocolFailureCause
]).annotate({ identifier: "WorkflowEventV2RunFailureCause" })

/**
 * The decoded type of {@link RunFailureCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunFailureCause = Schema.Schema.Type<typeof RunFailureCause>

/**
 * Records an attributed terminal run failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunFailed = Schema.TaggedStruct("RunFailed", {
  cause: RunFailureCause
}).annotate({
  identifier: "WorkflowEventV2RunFailed",
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
 * Records that cancellation reached the terminal run state.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunCancelled = Schema.TaggedStruct("RunCancelled", {}).annotate({
  identifier: "WorkflowEventV2RunCancelled",
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
 * The deliberately bounded semantic payload vocabulary for protocol version 2.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Payload = Schema.Union([
  RunStarted,
  ActivityScheduled,
  ActivityAttemptStarted,
  ActivityAttemptFailed,
  ActivityAttemptTimedOut,
  RetryScheduled,
  ActivitySucceeded,
  ActivityFailed,
  TimerScheduled,
  TimerFired,
  TimerCancelled,
  SignalAccepted,
  SignalWaitStarted,
  SleepStarted,
  SignalConsumed,
  RunCancellationRequested,
  RunSucceeded,
  RunFailed,
  RunCancelled
]).annotate({ identifier: "WorkflowEventV2Payload" })

/**
 * The decoded type of {@link Payload}.
 *
 * @category models
 * @since 4.0.0
 */
export type Payload = Schema.Schema.Type<typeof Payload>

/**
 * A strict, tenant-scoped protocol version 2 semantic-history envelope.
 *
 * **Details**
 *
 * Sequence continuity and identity-to-payload correspondence are state-machine
 * invariants. This boundary validates their wire types and rejects ambiguous
 * version 1 or future payload shapes.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Event = Schema.Struct({
  eventVersion: Schema.Literal(EventVersion),
  tenantId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  sequence: NonNegativeSafeInt,
  recordedAt: Timestamp,
  causationId: Schema.optionalKey(Schema.NonEmptyString),
  correlationId: Schema.optionalKey(Schema.NonEmptyString),
  payload: Payload
}).annotate({
  identifier: "WorkflowEventV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Event}.
 *
 * @category models
 * @since 4.0.0
 */
export type Event = Schema.Schema.Type<typeof Event>
