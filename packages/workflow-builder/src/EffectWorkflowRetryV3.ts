/**
 * Durable business-failure retry composition for semantic protocol version 3.
 *
 * **Details**
 *
 * This module composes authenticated semantic operations with Effect's native
 * Workflow activities and durable clock. It owns no persistence, activity,
 * timer, lease, or replay implementation.
 *
 * Every business attempt executes through the managed `NodeAttempt` activity.
 * The handler's exact output or application failure is encoded once inside
 * that native activity and persisted as a closed outcome. Workflow replay
 * never catches or re-encodes a decoded activity failure.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as NativeClock from "effect/unstable/workflow/DurableClock"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import * as NativeName from "./EffectWorkflowOperationV3.ts"
import * as EffectWorkflowSemanticV3 from "./EffectWorkflowSemanticV3.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV3 from "./PlanStoreV3.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import * as SemanticExecutableRegistryV3 from "./SemanticExecutableRegistryV3.ts"
import * as SemanticOccurrenceV3 from "./SemanticOccurrenceV3.ts"
import * as SemanticOperationV3 from "./SemanticOperationV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const OperationIds = {
  NodeAttempt: "workflow-builder.retry.node-attempt",
  InitialTime: "workflow-builder.retry.initial-time",
  FailureTime: "workflow-builder.retry.failure-time",
  Classifier: "workflow-builder.retry.classifier",
  Delay: "workflow-builder.retry.delay",
  Backoff: "workflow-builder.retry.backoff",
  ScheduleToStart: "workflow-builder.retry.schedule-to-start",
  ScheduleToStartArm: "workflow-builder.retry.schedule-to-start-arm",
  AttemptStart: "workflow-builder.retry.attempt-start",
  AttemptTerminal: "workflow-builder.retry.attempt-terminal",
  StartToClose: "workflow-builder.retry.start-to-close",
  ScheduleToClose: "workflow-builder.retry.schedule-to-close"
} as const

/**
 * Canonical managed-attempt schemas owned by {@link SemanticOperationV3}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptSucceeded = SemanticOperationV3.NodeAttemptSucceeded

/**
 * The decoded type of {@link NodeAttemptSucceeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptSucceeded = SemanticOperationV3.NodeAttemptSucceeded

/**
 * Canonical managed application-failure outcome.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptApplicationFailed = SemanticOperationV3.NodeAttemptApplicationFailed

/**
 * The decoded type of {@link NodeAttemptApplicationFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptApplicationFailed = SemanticOperationV3.NodeAttemptApplicationFailed

/**
 * Canonical persisted managed-attempt outcome.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptOutcome = SemanticOperationV3.NodeAttemptOutcome

/**
 * The decoded type of {@link NodeAttemptOutcome}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptOutcome = SemanticOperationV3.NodeAttemptOutcome

/**
 * Canonical managed-attempt timeout outcome.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptTimedOut = SemanticOperationV3.NodeAttemptTimedOut

/**
 * The decoded type of {@link NodeAttemptTimedOut}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptTimedOut = SemanticOperationV3.NodeAttemptTimedOut

const ScheduleToStartArmedStruct = Schema.TaggedStruct("Armed", {
  armVersion: Schema.Literal(1),
  activityDigest: Wire.OperationDigest,
  attempt: Wire.PositiveSafeInt,
  timerOperationDigest: Wire.OperationDigest,
  armedAt: Wire.Timestamp,
  deadline: Wire.Timestamp,
  durationMillis: Wire.PositiveSemanticDelayMillis
})

const ScheduleToStartArmed = ScheduleToStartArmedStruct.check(
  Schema.makeFilter((armed) => {
    const start = Date.parse(armed.armedAt)
    const deadline = Date.parse(armed.deadline)
    return Number.isSafeInteger(start) &&
        Number.isSafeInteger(deadline) &&
        deadline - start === armed.durationMillis
      ? []
      : [{
        path: ["deadline"],
        issue: "schedule-to-start deadline must equal armedAt plus durationMillis"
      }]
  })
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ScheduleToStartArmed",
  parseOptions: strictParseOptions
})

type ScheduleToStartArmed = Schema.Schema.Type<
  typeof ScheduleToStartArmed
>

const StartToCloseDisabled = Schema.TaggedStruct("Disabled", {})

const StartToCloseScheduled = Schema.TaggedStruct("Scheduled", {
  timerOperationDigest: Wire.OperationDigest,
  durationMillis: Wire.PositiveSemanticDelayMillis,
  deadline: Wire.Timestamp
})

const AttemptStartedStruct = Schema.TaggedStruct("Started", {
  startVersion: Schema.Literal(1),
  activityDigest: Wire.OperationDigest,
  attempt: Wire.PositiveSafeInt,
  startedAt: Wire.Timestamp,
  startToClose: Schema.Union([
    StartToCloseDisabled,
    StartToCloseScheduled
  ])
})

/**
 * Canonical durable acknowledgement that one native attempt entered its
 * worker-side activity boundary.
 *
 * **Details**
 *
 * When start-to-close is enabled, the acknowledgement commits its exact timer,
 * duration, and absolute deadline. Redelivery therefore cannot extend the
 * original attempt budget before re-arming the idempotent native schedule.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptStarted = AttemptStartedStruct.check(
  Schema.makeFilter((started) => {
    if (started.startToClose._tag === "Disabled") return []
    const start = Date.parse(started.startedAt)
    const deadline = Date.parse(started.startToClose.deadline)
    return Number.isSafeInteger(start) &&
        Number.isSafeInteger(deadline) &&
        deadline - start === started.startToClose.durationMillis
      ? []
      : [{
        path: ["startToClose", "deadline"],
        issue: "start-to-close deadline must equal startedAt plus durationMillis"
      }]
  })
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3AttemptStarted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AttemptStarted}.
 *
 * @category models
 * @since 4.0.0
 */
export type AttemptStarted = Schema.Schema.Type<typeof AttemptStarted>

/**
 * First-wins start gate for one exact native attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptStartDecision = Schema.Union([
  AttemptStarted,
  NodeAttemptTimedOut
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3AttemptStartDecision",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AttemptStartDecision}.
 *
 * @category models
 * @since 4.0.0
 */
export type AttemptStartDecision = Schema.Schema.Type<
  typeof AttemptStartDecision
>

/**
 * Stable retry-composition failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidInvocation: "InvalidInvocation",
  InvalidInput: "InvalidInput",
  ArtifactMismatch: "ArtifactMismatch",
  UnknownNode: "UnknownNode",
  UnsupportedBlobPayload: "UnsupportedBlobPayload",
  OperationPreparationFailed: "OperationPreparationFailed",
  ActivityResolutionFailed: "ActivityResolutionFailed",
  ClockRegression: "ClockRegression"
} as const

/**
 * A retry-composition failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidInvocation,
  ErrorCodes.InvalidInput,
  ErrorCodes.ArtifactMismatch,
  ErrorCodes.UnknownNode,
  ErrorCodes.UnsupportedBlobPayload,
  ErrorCodes.OperationPreparationFailed,
  ErrorCodes.ActivityResolutionFailed,
  ErrorCodes.ClockRegression
])

/**
 * A protocol/runtime error raised while preparing or composing retry
 * operations. Business terminal outcomes use {@link TerminalFailure}.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowRetryError extends Schema.TaggedErrorClass<
  EffectWorkflowRetryError
>("@effect/workflow-builder/EffectWorkflowRetryV3/Error")(
  "EffectWorkflowRetryError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    nodeId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationDigest: Schema.optionalKey(Wire.OperationDigest)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Stable defects raised when already-authenticated codec or policy objects
 * violate their admitted contracts.
 *
 * @category constants
 * @since 4.0.0
 */
export const DefectCodes = {
  InvalidOutputDecoding: "InvalidOutputDecoding",
  InvalidPolicyEvaluation: "InvalidPolicyEvaluation"
} as const

/**
 * A retry-composition invariant defect code.
 *
 * @category models
 * @since 4.0.0
 */
export type DefectCode = typeof DefectCodes[keyof typeof DefectCodes]

const DefectCode = Schema.Literals([
  DefectCodes.InvalidOutputDecoding,
  DefectCodes.InvalidPolicyEvaluation
])

/**
 * A retry-composition invariant defect.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowRetryDefect extends Schema.TaggedErrorClass<
  EffectWorkflowRetryDefect
>("@effect/workflow-builder/EffectWorkflowRetryV3/Defect")(
  "EffectWorkflowRetryDefect",
  {
    code: DefectCode,
    message: Schema.NonEmptyString,
    nodeId: Wire.AtomicIdentifier,
    operationId: Wire.AtomicIdentifier,
    operationDigest: Wire.OperationDigest
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * A policy-list override that rejected one application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExplicitNonRetryableDecision = Schema.TaggedStruct(
  "PolicyOverride",
  {
    decisionVersion: Schema.Literal(1),
    matchedBy: Schema.Literals(["ErrorTag", "ErrorCode"])
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ExplicitNonRetryableDecision",
  parseOptions: strictParseOptions
})

/**
 * An exact replay-recorded classifier that rejected one application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClassifierNonRetryableDecision = Schema.TaggedStruct(
  "Classifier",
  {
    decisionVersion: Schema.Literal(1),
    classificationActivityDigest: Wire.OperationDigest
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ClassifierNonRetryableDecision",
  parseOptions: strictParseOptions
})

/**
 * Closed decision vocabulary for a non-retryable application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NonRetryableDecision = Schema.Union([
  ExplicitNonRetryableDecision,
  ClassifierNonRetryableDecision
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3NonRetryableDecision",
  parseOptions: strictParseOptions
})

/**
 * An application failure rejected before another attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NonRetryable = Schema.TaggedStruct("NonRetryable", {
  terminalVersion: Schema.Literal(1),
  cause: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  decision: NonRetryableDecision
}).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3NonRetryable",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NonRetryable}.
 *
 * @category models
 * @since 4.0.0
 */
export type NonRetryable = Schema.Schema.Type<typeof NonRetryable>

/**
 * A retryable application failure for which attempt or elapsed admission
 * budget was exhausted.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Exhausted = Schema.TaggedStruct("Exhausted", {
  terminalVersion: Schema.Literal(1),
  cause: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classificationActivityDigest: Wire.OperationDigest,
  reason: ActivityPolicyV3.RetryDeniedReason
}).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3Exhausted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Exhausted}.
 *
 * @category models
 * @since 4.0.0
 */
export type Exhausted = Schema.Schema.Type<typeof Exhausted>

/**
 * A classifier rejected a retry-classifiable attempt timeout.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptTimeoutNonRetryableDecision = Schema.TaggedStruct(
  "NonRetryable",
  {
    decisionVersion: Schema.Literal(1),
    classificationActivityDigest: Wire.OperationDigest
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3AttemptTimeoutNonRetryableDecision",
  parseOptions: strictParseOptions
})

/**
 * A retry-classifiable attempt timeout exhausted an attempt or elapsed budget.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptTimeoutExhaustedDecision = Schema.TaggedStruct(
  "Exhausted",
  {
    decisionVersion: Schema.Literal(1),
    classificationActivityDigest: Wire.OperationDigest,
    reason: ActivityPolicyV3.RetryDeniedReason
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3AttemptTimeoutExhaustedDecision",
  parseOptions: strictParseOptions
})

/**
 * Closed terminal-decision vocabulary for an attempt timeout.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptTimeoutTerminalDecision = Schema.Union([
  AttemptTimeoutNonRetryableDecision,
  AttemptTimeoutExhaustedDecision
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3AttemptTimeoutTerminalDecision",
  parseOptions: strictParseOptions
})

/**
 * A schedule-to-start or start-to-close timeout that terminated the managed
 * retry composition.
 *
 * **Details**
 *
 * Attempt timeouts are classified separately from application failures. They
 * therefore remain an operational timeout terminal and can never be projected
 * as a BPMN business error.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AttemptTimedOut = Schema.TaggedStruct("AttemptTimedOut", {
  terminalVersion: Schema.Literal(1),
  timeout: NodeAttemptTimedOut,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  decision: AttemptTimeoutTerminalDecision
}).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3AttemptTimedOut",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AttemptTimedOut}.
 *
 * @category models
 * @since 4.0.0
 */
export type AttemptTimedOut = Schema.Schema.Type<typeof AttemptTimedOut>

/**
 * A durable schedule-to-close deadline that won before semantic completion.
 *
 * **Details**
 *
 * The timeout fences the managed retry composition and interrupts the losing
 * workflow waiter. It does not claim to roll back an external side effect
 * already dispatched by an activity handler.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleToCloseTimedOut = Schema.TaggedStruct(
  "ScheduleToCloseTimedOut",
  {
    timeoutVersion: Schema.Literal(1),
    timeoutKind: Schema.Literal("ScheduleToClose"),
    controllerOperationDigest: Wire.OperationDigest,
    firstActivityDigest: Wire.OperationDigest,
    durationMillis: Wire.PositiveSemanticDelayMillis
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ScheduleToCloseTimedOut",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleToCloseTimedOut}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleToCloseTimedOut = Schema.Schema.Type<
  typeof ScheduleToCloseTimedOut
>

/**
 * Closed public terminal vocabulary of managed retry execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TerminalFailure = Schema.Union([
  NonRetryable,
  Exhausted,
  AttemptTimedOut,
  ScheduleToCloseTimedOut
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3TerminalFailure",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TerminalFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type TerminalFailure = Schema.Schema.Type<
  typeof TerminalFailure
>

/**
 * Closed semantic completion values persisted by a schedule-to-close
 * controller before any business output is decoded.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryScheduleToCloseOutcome = Schema.Union([
  NodeAttemptSucceeded,
  NonRetryable,
  Exhausted,
  AttemptTimedOut,
  ScheduleToCloseTimedOut
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ScheduleToCloseOutcome",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryScheduleToCloseOutcome}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryScheduleToCloseOutcome = Schema.Schema.Type<
  typeof RetryScheduleToCloseOutcome
>

/**
 * Closed raw result of one managed retry execution.
 *
 * **Details**
 *
 * Unlike {@link execute}, this vocabulary retains the encoded successful
 * output and returns business terminals as values. It is suitable for
 * orchestration adapters that must inspect the exact durable activity
 * coordinates without executing the invocation a second time.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryExecutionOutcome = RetryScheduleToCloseOutcome

/**
 * The decoded type of {@link RetryExecutionOutcome}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryExecutionOutcome = RetryScheduleToCloseOutcome

const RetryScheduleToCloseWinnerStruct = Schema.Struct({
  _tag: Schema.Literal("RetryScheduleToCloseWinner"),
  outcomeEnvelopeVersion: Schema.Literal(2),
  controllerOperationDigest: Wire.OperationDigest,
  exit: Schema.Exit(
    RetryScheduleToCloseOutcome,
    Schema.Never,
    Schema.Defect()
  )
})

/**
 * Canonical persisted winner for one schedule-to-close retry controller.
 *
 * **Details**
 *
 * Semantic success, terminal business failure, and timeout are successful
 * values inside the canonical `Exit`. Non-interrupt defects retain their
 * complete native cause. Pure interruption is never converted into a winner.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryScheduleToCloseWinner = RetryScheduleToCloseWinnerStruct.pipe(
  Schema.decodeTo(Schema.toType(RetryScheduleToCloseWinnerStruct))
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ScheduleToCloseWinner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryScheduleToCloseWinner}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryScheduleToCloseWinner = Schema.Schema.Type<
  typeof RetryScheduleToCloseWinner
>

/**
 * Persistable pins exposed by one process-local prepared retry invocation.
 *
 * **Details**
 *
 * Execution additionally requires the exact returned object; structural
 * copies are rejected.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedRetryInvocation {
  readonly invocationVersion: 2
  readonly artifactDigest: Wire.ArtifactDigest
  readonly occurrenceDigest: Wire.OccurrenceDigest
  readonly nodeId: Wire.AtomicIdentifier
  readonly firstActivityDigest: Wire.OperationDigest
  readonly firstScheduleToStartTimerDigest?: Wire.OperationDigest | undefined
  readonly firstStartToCloseTimerDigest?: Wire.OperationDigest | undefined
  readonly scheduleToCloseControllerDigest?: Wire.OperationDigest | undefined
}

/**
 * Inputs admitted while preparing one durable retry invocation.
 *
 * @category models
 * @since 4.0.0
 */
export interface PrepareOptions {
  readonly artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables
  readonly occurrence: SemanticOccurrenceV3.PreparedOccurrence
  readonly input: Wire.EncodedPayload
}

/**
 * Explicit infrastructure execution policy. It does not influence business
 * classification, attempt limits, jitter bounds, or backoff.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutionOptions = EffectWorkflowSemanticV3.ActivityExecutionOptions

interface CapturedPrepareOptions {
  readonly artifact: unknown
  readonly occurrence: unknown
  readonly input: unknown
}

interface PreparedAttempt {
  readonly attempt: Wire.PositiveSafeInt
  readonly operation: SemanticOperationV3.PreparedOperation
  readonly resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
  readonly scheduleToStart: PreparedAttemptTimer | undefined
  readonly startToClose: PreparedAttemptTimer | undefined
}

type PreparedTimerOperation = SemanticOperationV3.PreparedOperation & {
  readonly document: Extract<
    SemanticOperationV3.OperationDocument,
    { readonly _tag: "Timer" }
  >
}

interface PreparedAttemptTimer {
  readonly operation: PreparedTimerOperation
  readonly operationName: string
  readonly timeoutKind: ActivityPolicyV3.AttemptTimeout["timeoutKind"]
  readonly durationMillis: Wire.PositiveSemanticDelayMillis
}

type PreparedScheduleToCloseOperation = SemanticOperationV3.PreparedOperation & {
  readonly document: Extract<
    SemanticOperationV3.OperationDocument,
    { readonly _tag: "RetryScheduleToClose" }
  >
}

interface PreparedScheduleToClose {
  readonly operation: PreparedScheduleToCloseOperation
  readonly operationName: string
  readonly durationMillis: Wire.PositiveSemanticDelayMillis
}

interface InvocationState {
  readonly artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables
  readonly occurrence: SemanticOccurrenceV3.PreparedOccurrence
  readonly node: SemanticExecutableRegistryV3.ResolvedNodeHandler
  readonly input: Wire.InlineEncodedPayload
  readonly firstAttempt: PreparedAttempt
  readonly initialObservation: SemanticExecutableRegistryV3.ResolvedTimeObservationActivity
  readonly scheduleToClose: PreparedScheduleToClose | undefined
}

const invocationStates = new WeakMap<object, InvocationState>()
const decodePayload = Schema.decodeUnknownResult(
  Wire.EncodedPayload,
  strictParseOptions
)

/**
 * Tests whether a value retains exact retry-invocation provenance in this
 * process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (
  value: unknown
): value is PreparedRetryInvocation =>
  typeof value === "object" &&
  value !== null &&
  invocationStates.has(value)

const retryError = (
  code: ErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly operationId?: string | undefined
    readonly operationDigest?: Wire.OperationDigest | undefined
  } = {}
): EffectWorkflowRetryError =>
  new EffectWorkflowRetryError({
    code,
    message,
    ...(options.nodeId === undefined ? undefined : {
      nodeId: options.nodeId
    }),
    ...(options.operationId === undefined ? undefined : {
      operationId: options.operationId
    }),
    ...(options.operationDigest === undefined ? undefined : {
      operationDigest: options.operationDigest
    })
  })

/**
 * Recovers the exact occurrence retained for a prepared retry invocation.
 *
 * **Details**
 *
 * This is a process-local admission accessor for semantic bridges, not a
 * caller-supplied durable pin. Only the exact object returned by
 * {@link prepare} is admitted; structural copies, proxies, and unknown values
 * fail without inspecting any invocation fields.
 *
 * @category accessors
 * @since 4.0.0
 */
export const preparedOccurrence = (
  invocation: unknown
): Result.Result<
  SemanticOccurrenceV3.PreparedOccurrence,
  EffectWorkflowRetryError
> => {
  if (typeof invocation !== "object" || invocation === null) {
    return Result.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Prepared occurrence access requires the exact PreparedRetryInvocation returned by prepare"
    ))
  }
  const state = invocationStates.get(invocation)
  return state === undefined
    ? Result.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Prepared occurrence access requires the exact PreparedRetryInvocation returned by prepare"
    ))
    : Result.succeed(state.occurrence)
}

const capturePrepareOptions = (
  input: unknown
): Result.Result<CapturedPrepareOptions, EffectWorkflowRetryError> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must be a plain object"
      ))
    }
    const prototype = Object.getPrototypeOf(input)
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must not use an exotic prototype"
      ))
    }
    if (Object.getOwnPropertySymbols(input).length !== 0) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must not contain symbol properties"
      ))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const names = Object.getOwnPropertyNames(descriptors).sort()
    const expected = ["artifact", "input", "occurrence"]
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must contain exactly artifact, occurrence, and input"
      ))
    }
    const artifact = descriptors.artifact
    const occurrence = descriptors.occurrence
    const payload = descriptors.input
    for (
      const [name, descriptor] of [
        ["artifact", artifact],
        ["occurrence", occurrence],
        ["input", payload]
      ] as const
    ) {
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        ) ||
        descriptor.enumerable !== true
      ) {
        return Result.fail(retryError(
          ErrorCodes.InvalidInvocation,
          `Retry preparation option '${name}' must be an enumerable data property`
        ))
      }
    }
    return Result.succeed(Object.freeze({
      artifact: artifact!.value,
      occurrence: occurrence!.value,
      input: payload!.value
    }))
  } catch {
    return Result.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry preparation options could not be inspected safely"
    ))
  }
}

const causeMessage = (cause: unknown): string => {
  try {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "message" in cause &&
      typeof cause.message === "string" &&
      cause.message.length > 0
    ) {
      return cause.message
    }
    return String(cause)
  } catch {
    return "Unknown internal failure"
  }
}

const builtIn = (
  schema: SemanticOperationV3.BuiltInSchemaName
) => ({
  _tag: "BuiltIn" as const,
  contractReferenceVersion: 1 as const,
  vocabularyVersion: 2 as const,
  schema
})

type ResolutionByTag = {
  readonly NodeAttempt: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
  readonly RetryClassifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity
  readonly RetryDelaySelection: SemanticExecutableRegistryV3.ResolvedRetryDelaySelectionActivity
  readonly TimeObservation: SemanticExecutableRegistryV3.ResolvedTimeObservationActivity
}

const prepareOperation = (
  occurrence: SemanticOccurrenceV3.PreparedOccurrence,
  nodeId: string,
  operationId: string,
  input: unknown
): Effect.Effect<
  SemanticOperationV3.PreparedOperation,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  SemanticOperationV3.prepare(occurrence, input).pipe(
    Effect.mapError((cause) =>
      retryError(
        ErrorCodes.OperationPreparationFailed,
        `Could not prepare retry operation '${operationId}': ${causeMessage(cause)}`,
        { nodeId, operationId }
      )
    )
  )

const resolveActivity = <K extends keyof ResolutionByTag>(
  artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables,
  operation: SemanticOperationV3.PreparedOperation,
  expected: K
): Effect.Effect<ResolutionByTag[K], EffectWorkflowRetryError> =>
  Effect.suspend(() => {
    const resolved = SemanticExecutableRegistryV3.resolveActivity(
      artifact,
      operation
    )
    if (Result.isFailure(resolved)) {
      return Effect.fail(retryError(
        ErrorCodes.ActivityResolutionFailed,
        `Could not resolve retry operation '${operation.document.operationId}': ${resolved.failure.message}`,
        {
          nodeId: operation.document.occurrence.document.nodeId,
          operationId: operation.document.operationId,
          operationDigest: operation.operationDigest
        }
      ))
    }
    if (resolved.success._tag !== expected) {
      return Effect.fail(retryError(
        ErrorCodes.ActivityResolutionFailed,
        `Retry operation '${operation.document.operationId}' resolved as '${resolved.success._tag}' instead of '${expected}'`,
        {
          nodeId: operation.document.occurrence.document.nodeId,
          operationId: operation.document.operationId,
          operationDigest: operation.operationDigest
        }
      ))
    }
    return Effect.succeed(
      resolved.success as ResolutionByTag[K]
    )
  })

const nativeOperationName = (
  nodeId: string,
  operation: SemanticOperationV3.PreparedOperation
): Effect.Effect<string, EffectWorkflowRetryError> => {
  const coordinates = SemanticOperationV3.nativeCoordinates(operation)
  if (Result.isFailure(coordinates)) {
    return Effect.fail(retryError(
      ErrorCodes.OperationPreparationFailed,
      `Could not derive native operation coordinates: ${coordinates.failure.message}`,
      {
        nodeId,
        operationId: operation.document.operationId,
        operationDigest: operation.operationDigest
      }
    ))
  }
  const name = NativeName.name(coordinates.success)
  return Result.isFailure(name)
    ? Effect.fail(retryError(
      ErrorCodes.OperationPreparationFailed,
      `Could not derive native operation name: ${name.failure.message}`,
      {
        nodeId,
        operationId: operation.document.operationId,
        operationDigest: operation.operationDigest
      }
    ))
    : Effect.succeed(name.success)
}

const prepareAttemptTimer = (
  state: Pick<InvocationState, "occurrence" | "node">,
  attempt: {
    readonly attempt: Wire.PositiveSafeInt
    readonly operation: SemanticOperationV3.PreparedOperation
  },
  timeoutKind: ActivityPolicyV3.AttemptTimeout["timeoutKind"],
  durationMillis: Wire.PositiveSemanticDelayMillis
): Effect.Effect<
  PreparedAttemptTimer,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operationId = timeoutKind === "ScheduleToStart"
      ? OperationIds.ScheduleToStart
      : OperationIds.StartToClose
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      operationId,
      {
        _tag: "Timer",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId,
        generation: attempt.attempt,
        owner: {
          _tag: timeoutKind,
          activityDigest: attempt.operation.operationDigest
        },
        delayMillis: durationMillis
      }
    )
    if (operation.document._tag !== "Timer") {
      return yield* Effect.fail(retryError(
        ErrorCodes.OperationPreparationFailed,
        "Prepared attempt timeout did not retain its Timer operation",
        {
          nodeId: state.node.binding.nodeId,
          operationId,
          operationDigest: operation.operationDigest
        }
      ))
    }
    return Object.freeze({
      operation: operation as PreparedTimerOperation,
      operationName: yield* nativeOperationName(
        state.node.binding.nodeId,
        operation
      ),
      timeoutKind,
      durationMillis
    })
  })

const prepareAttempt = (
  state: Pick<
    InvocationState,
    "artifact" | "occurrence" | "node" | "input"
  >,
  attempt: Wire.PositiveSafeInt
): Effect.Effect<
  PreparedAttempt,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.NodeAttempt,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.NodeAttempt,
        attempt,
        purpose: {
          _tag: "NodeAttempt",
          purposeVersion: 1,
          nodeDefinitionKey: state.node.binding.nodeDefinitionKey,
          handlerBuildDigest: state.node.binding.handlerBuild.buildDigest
        },
        input: state.input,
        successContract: builtIn("NodeAttemptOutcome"),
        errorContract: builtIn("Never")
      }
    )
    const resolution = yield* resolveActivity(
      state.artifact,
      operation,
      "NodeAttempt"
    )
    const timeoutPolicy = state.node.binding.activityPolicy.timeouts
    const scheduleToStart = timeoutPolicy.scheduleToStart._tag === "After"
      ? yield* prepareAttemptTimer(
        state,
        { attempt, operation },
        "ScheduleToStart",
        timeoutPolicy.scheduleToStart.durationMillis
      )
      : undefined
    const startToClose = timeoutPolicy.startToClose._tag === "After"
      ? yield* prepareAttemptTimer(
        state,
        { attempt, operation },
        "StartToClose",
        timeoutPolicy.startToClose.durationMillis
      )
      : undefined
    return Object.freeze({
      attempt,
      operation,
      resolution,
      scheduleToStart,
      startToClose
    })
  })

const prepareTimeObservation = (
  state: Pick<
    InvocationState,
    "artifact" | "occurrence" | "node"
  >,
  input: {
    readonly operationId: string
    readonly attempt: Wire.PositiveSafeInt
    readonly owner: SemanticOperationV3.PreparedOperation
    readonly kind: SemanticOperationV3.TimeObservationKind
  }
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedTimeObservationActivity,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      input.operationId,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: input.operationId,
        attempt: input.attempt,
        purpose: {
          _tag: "TimeObservation",
          purposeVersion: 1,
          ownerOperationDigest: input.owner.operationDigest,
          observationKind: input.kind
        },
        input: { _tag: "Inline", value: null },
        successContract: builtIn("CanonicalTimestamp"),
        errorContract: builtIn("Never")
      }
    )
    return yield* resolveActivity(
      state.artifact,
      operation,
      "TimeObservation"
    )
  })

const prepareClassifier = (
  state: InvocationState,
  attempt: PreparedAttempt,
  failure: ActivityPolicyV3.RetryFailureCause
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const classifier = state.node.binding.activityPolicy.retry.classifier
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.Classifier,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.Classifier,
        attempt: attempt.attempt,
        purpose: {
          _tag: "RetryClassifier",
          purposeVersion: 1,
          failedActivityDigest: attempt.operation.operationDigest,
          classifierKey: PlanStoreV3.classifierKey(
            classifier.classifierId,
            classifier.classifierVersion
          ),
          classifierBuildDigest: classifier.buildDigest
        },
        input: { _tag: "Inline", value: failure },
        successContract: builtIn("RetryClassification"),
        errorContract: builtIn("Never")
      }
    )
    return yield* resolveActivity(
      state.artifact,
      operation,
      "RetryClassifier"
    )
  })

const prepareDelaySelection = (
  state: InvocationState,
  attempt: PreparedAttempt,
  classification: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  input: ActivityPolicyV3.RetryDelayInput
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedRetryDelaySelectionActivity,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.Delay,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.Delay,
        attempt: attempt.attempt,
        purpose: {
          _tag: "RetryDelaySelection",
          purposeVersion: 1,
          failedActivityDigest: attempt.operation.operationDigest,
          classificationActivityDigest: classification.operation.operationDigest
        },
        input: { _tag: "Inline", value: input },
        successContract: builtIn("RecordedRetryDelay"),
        errorContract: builtIn("Never")
      }
    )
    return yield* resolveActivity(
      state.artifact,
      operation,
      "RetryDelaySelection"
    )
  })

const prepareBackoff = (
  state: InvocationState,
  attempt: PreparedAttempt,
  delay: ActivityPolicyV3.RecordedRetryDelay
): Effect.Effect<
  SemanticOperationV3.PreparedOperation,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  prepareOperation(
    state.occurrence,
    state.node.binding.nodeId,
    OperationIds.Backoff,
    {
      _tag: "Timer",
      operationVersion: SemanticOperationV3.OperationVersion,
      executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
      operationId: OperationIds.Backoff,
      generation: delay.retryOrdinal,
      owner: {
        _tag: "RetryBackoff",
        failedActivityDigest: attempt.operation.operationDigest
      },
      delayMillis: delay.selectedDelayMillis
    }
  )

const prepareScheduleToClose = (
  state: Pick<
    InvocationState,
    "occurrence" | "node" | "input"
  >,
  firstAttempt: PreparedAttempt,
  initialObservation: SemanticExecutableRegistryV3.ResolvedTimeObservationActivity,
  durationMillis: Wire.PositiveSemanticDelayMillis
): Effect.Effect<
  PreparedScheduleToClose,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.ScheduleToClose,
      {
        _tag: "RetryScheduleToClose",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.ScheduleToClose,
        generation: 0,
        controllerVersion: 2,
        firstActivityDigest: firstAttempt.operation.operationDigest,
        initialObservationDigest: initialObservation.operation.operationDigest,
        nodeDefinitionKey: state.node.binding.nodeDefinitionKey,
        handlerBuildDigest: state.node.binding.handlerBuild.buildDigest,
        input: state.input,
        activityPolicy: state.node.binding.activityPolicy,
        timeoutKind: "ScheduleToClose",
        durationMillis,
        outcomeContractVersion: 1,
        loserDisposition: "InterruptWaiters"
      }
    )
    if (operation.document._tag !== "RetryScheduleToClose") {
      return yield* Effect.fail(retryError(
        ErrorCodes.OperationPreparationFailed,
        "Prepared retry controller did not retain its dedicated operation tag",
        {
          nodeId: state.node.binding.nodeId,
          operationId: OperationIds.ScheduleToClose,
          operationDigest: operation.operationDigest
        }
      ))
    }
    const coordinates = SemanticOperationV3.nativeCoordinates(operation)
    if (Result.isFailure(coordinates)) {
      return yield* Effect.fail(retryError(
        ErrorCodes.OperationPreparationFailed,
        `Could not derive retry controller coordinates: ${coordinates.failure.message}`,
        {
          nodeId: state.node.binding.nodeId,
          operationId: OperationIds.ScheduleToClose,
          operationDigest: operation.operationDigest
        }
      ))
    }
    const operationName = NativeName.name(coordinates.success)
    if (Result.isFailure(operationName)) {
      return yield* Effect.fail(retryError(
        ErrorCodes.OperationPreparationFailed,
        `Could not derive retry controller name: ${operationName.failure.message}`,
        {
          nodeId: state.node.binding.nodeId,
          operationId: OperationIds.ScheduleToClose,
          operationDigest: operation.operationDigest
        }
      ))
    }
    return Object.freeze({
      operation: operation as PreparedScheduleToCloseOperation,
      operationName: operationName.success,
      durationMillis
    })
  })

/**
 * Prepares an exact process-local retry invocation.
 *
 * **Details**
 *
 * The three capability-bearing options are captured through own data-property
 * descriptors before any value is read. Getters, symbols, extra properties,
 * exotic prototypes, copied capabilities, and blobs fail closed. Exact
 * schedule-to-start and start-to-close timers are prepared per attempt, while
 * an enabled schedule-to-close policy is compiled into a dedicated durable
 * controller.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = (
  options: PrepareOptions
): Effect.Effect<
  PreparedRetryInvocation,
  EffectWorkflowRetryError,
  Crypto.Crypto
> => {
  const captured = capturePrepareOptions(options)
  if (Result.isFailure(captured)) {
    return Effect.fail(captured.failure)
  }
  const artifact = captured.success.artifact
  const occurrence = captured.success.occurrence
  if (
    !SemanticExecutableRegistryV3
      .isResolvedArtifactExecutables(artifact)
  ) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry preparation requires the exact artifact resolution returned by SemanticExecutableRegistryV3"
    ))
  }
  if (!SemanticOccurrenceV3.isPrepared(occurrence)) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry preparation requires the exact occurrence returned by SemanticOccurrenceV3"
    ))
  }
  if (
    occurrence.document.artifactDigest !==
      artifact.artifactDigest
  ) {
    return Effect.fail(retryError(
      ErrorCodes.ArtifactMismatch,
      "Retry occurrence and executable resolution belong to different artifacts",
      { nodeId: occurrence.document.nodeId }
    ))
  }
  const node = artifact.nodeHandlers.get(
    occurrence.document.nodeId
  )
  if (node === undefined) {
    return Effect.fail(retryError(
      ErrorCodes.UnknownNode,
      "Retry occurrence does not select a resolved node handler",
      { nodeId: occurrence.document.nodeId }
    ))
  }
  const snapshot = Json.snapshot(captured.success.input)
  if (Result.isFailure(snapshot)) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInput,
      `Retry input must be bounded strict JSON: ${snapshot.failure.message}`,
      { nodeId: node.binding.nodeId }
    ))
  }
  let payload: ReturnType<typeof decodePayload>
  try {
    payload = decodePayload(snapshot.success)
  } catch {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInput,
      "Retry input schema validation threw unexpectedly",
      { nodeId: node.binding.nodeId }
    ))
  }
  if (Result.isFailure(payload)) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInput,
      `Invalid retry input payload: ${payload.failure.message}`,
      { nodeId: node.binding.nodeId }
    ))
  }
  if (payload.success._tag === "Blob") {
    return Effect.fail(retryError(
      ErrorCodes.UnsupportedBlobPayload,
      "Retry node inputs require inline payloads until a digest-verifying BlobStore adapter is available",
      { nodeId: node.binding.nodeId }
    ))
  }
  const inlinePayload = payload.success

  return Effect.gen(function*() {
    const base = {
      artifact,
      occurrence,
      node,
      input: inlinePayload
    }
    const firstAttempt = yield* prepareAttempt(base, 1)
    const initialObservation = yield* prepareTimeObservation(
      base,
      {
        operationId: OperationIds.InitialTime,
        attempt: 1,
        owner: firstAttempt.operation,
        kind: "Initial"
      }
    )
    const scheduleToClosePolicy = node.binding.activityPolicy.timeouts.scheduleToClose
    const scheduleToClose = scheduleToClosePolicy._tag === "After"
      ? yield* prepareScheduleToClose(
        base,
        firstAttempt,
        initialObservation,
        scheduleToClosePolicy.durationMillis
      )
      : undefined
    const invocation = Object.freeze({
      invocationVersion: 2,
      artifactDigest: artifact.artifactDigest,
      occurrenceDigest: occurrence.occurrenceDigest,
      nodeId: node.binding.nodeId,
      firstActivityDigest: firstAttempt.operation.operationDigest,
      ...(firstAttempt.scheduleToStart === undefined
        ? undefined
        : {
          firstScheduleToStartTimerDigest: firstAttempt.scheduleToStart.operation.operationDigest
        }),
      ...(firstAttempt.startToClose === undefined
        ? undefined
        : {
          firstStartToCloseTimerDigest: firstAttempt.startToClose.operation.operationDigest
        }),
      ...(scheduleToClose === undefined
        ? undefined
        : {
          scheduleToCloseControllerDigest: scheduleToClose.operation.operationDigest
        })
    }) satisfies PreparedRetryInvocation
    invocationStates.set(
      invocation,
      Object.freeze({
        ...base,
        firstAttempt,
        initialObservation,
        scheduleToClose
      })
    )
    return invocation
  })
}

const retryDefect = (
  attempt: PreparedAttempt,
  code: DefectCode,
  message: string
): EffectWorkflowRetryDefect =>
  new EffectWorkflowRetryDefect({
    code,
    message,
    nodeId: attempt.resolution.node.binding.nodeId,
    operationId: attempt.operation.document.operationId,
    operationDigest: attempt.operation.operationDigest
  })

const decodeSucceededOutput = (
  state: InvocationState,
  outcome: SemanticOperationV3.NodeAttemptSucceeded
): Effect.Effect<unknown> =>
  Schema.decodeUnknownEffect(
    state.node.contract.successSchema,
    strictParseOptions
  )(outcome.output.value).pipe(
    Effect.updateContext((current) =>
      Context.merge(
        state.node.contract.resultCodecContext,
        current
      ) as Context.Context<any>
    ),
    Effect.mapError((cause) =>
      new EffectWorkflowRetryDefect({
        code: DefectCodes.InvalidOutputDecoding,
        message: `Persisted node-attempt output is incompatible with its exact codecs: ${cause.message}`,
        nodeId: state.node.binding.nodeId,
        operationId: OperationIds.NodeAttempt,
        operationDigest: outcome.activityDigest
      })
    ),
    Effect.orDie
  ) as Effect.Effect<unknown>

const elapsedBetween = (
  nodeId: string,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp
): Result.Result<
  Wire.SemanticDelayMillis,
  EffectWorkflowRetryError
> => {
  const initialEpoch = Date.parse(initialObservedAt)
  const failedEpoch = Date.parse(failedObservedAt)
  if (
    !Number.isSafeInteger(initialEpoch) ||
    !Number.isSafeInteger(failedEpoch)
  ) {
    return Result.fail(retryError(
      ErrorCodes.ClockRegression,
      "A canonical retry time observation could not be represented as safe epoch milliseconds",
      { nodeId }
    ))
  }
  if (failedEpoch < initialEpoch) {
    return Result.fail(retryError(
      ErrorCodes.ClockRegression,
      "Failure time precedes the initial retry-budget observation",
      { nodeId }
    ))
  }
  return Result.succeed(
    Math.min(
      failedEpoch - initialEpoch,
      Wire.MaximumSemanticDelayMillis
    ) as Wire.SemanticDelayMillis
  )
}

const explicitTerminal = (
  failure: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  disposition: Extract<
    ActivityPolicyV3.FailureDisposition,
    { readonly _tag: "ExplicitNonRetryable" }
  >
): NonRetryable =>
  Object.freeze({
    _tag: "NonRetryable",
    terminalVersion: 1,
    cause: failure,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    decision: {
      _tag: "PolicyOverride" as const,
      decisionVersion: 1 as const,
      matchedBy: disposition.matchedBy
    }
  })

const classifiedTerminal = (
  failure: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity
): NonRetryable =>
  Object.freeze({
    _tag: "NonRetryable",
    terminalVersion: 1,
    cause: failure,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    decision: {
      _tag: "Classifier" as const,
      decisionVersion: 1 as const,
      classificationActivityDigest: classifier.operation.operationDigest
    }
  })

const exhaustedTerminal = (
  failure: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  reason: ActivityPolicyV3.RetryDeniedReason
): Exhausted =>
  Object.freeze({
    _tag: "Exhausted",
    terminalVersion: 1,
    cause: failure,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    classificationActivityDigest: classifier.operation.operationDigest,
    reason
  })

const classifiedTimeoutTerminal = (
  timeout: NodeAttemptTimedOut,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity
): AttemptTimedOut =>
  Object.freeze({
    _tag: "AttemptTimedOut",
    terminalVersion: 1,
    timeout,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    decision: {
      _tag: "NonRetryable" as const,
      decisionVersion: 1 as const,
      classificationActivityDigest: classifier.operation.operationDigest
    }
  })

const exhaustedTimeoutTerminal = (
  timeout: NodeAttemptTimedOut,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  reason: ActivityPolicyV3.RetryDeniedReason
): AttemptTimedOut =>
  Object.freeze({
    _tag: "AttemptTimedOut",
    terminalVersion: 1,
    timeout,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    decision: {
      _tag: "Exhausted" as const,
      decisionVersion: 1 as const,
      classificationActivityDigest: classifier.operation.operationDigest,
      reason
    }
  })

const attemptProtocolError = (
  state: InvocationState,
  attempt: PreparedAttempt,
  message: string
): EffectWorkflowRetryError =>
  retryError(
    ErrorCodes.OperationPreparationFailed,
    message,
    {
      nodeId: state.node.binding.nodeId,
      operationId: attempt.operation.document.operationId,
      operationDigest: attempt.operation.operationDigest
    }
  )

const dateTimeAt = (
  state: InvocationState,
  attempt: PreparedAttempt,
  millis: number
): Effect.Effect<
  { readonly dateTime: DateTime.Utc; readonly timestamp: Wire.Timestamp },
  EffectWorkflowRetryError
> =>
  Effect.try({
    try: () => {
      if (!Number.isSafeInteger(millis)) {
        throw new RangeError("Unsafe epoch milliseconds")
      }
      const dateTime = DateTime.makeUnsafe(millis)
      return {
        dateTime,
        timestamp: DateTime.formatIso(dateTime) as Wire.Timestamp
      }
    },
    catch: () =>
      attemptProtocolError(
        state,
        attempt,
        "Attempt timeout deadline could not be represented as canonical UTC milliseconds"
      )
  })

const deadlineFromStart = (
  state: InvocationState,
  attempt: PreparedAttempt,
  startedAtMillis: number,
  durationMillis: Wire.PositiveSemanticDelayMillis
): Effect.Effect<
  {
    readonly startedAt: Wire.Timestamp
    readonly deadline: Wire.Timestamp
    readonly wakeUp: DateTime.Utc
  },
  EffectWorkflowRetryError
> =>
  Effect.gen(function*() {
    const started = yield* dateTimeAt(
      state,
      attempt,
      startedAtMillis
    )
    const deadline = yield* dateTimeAt(
      state,
      attempt,
      startedAtMillis + durationMillis
    )
    return {
      startedAt: started.timestamp,
      deadline: deadline.timestamp,
      wakeUp: deadline.dateTime
    }
  })

const deadlineFromNow = (
  state: InvocationState,
  attempt: PreparedAttempt,
  durationMillis: Wire.PositiveSemanticDelayMillis
): Effect.Effect<
  {
    readonly startedAt: Wire.Timestamp
    readonly deadline: Wire.Timestamp
    readonly wakeUp: DateTime.Utc
  },
  EffectWorkflowRetryError
> =>
  Effect.flatMap(
    Clock.currentTimeMillis,
    (now) =>
      deadlineFromStart(
        state,
        attempt,
        now,
        durationMillis
      )
  )

const attemptPhaseName = (
  state: InvocationState,
  attempt: PreparedAttempt,
  operationId: string
): Effect.Effect<string, EffectWorkflowRetryError> => {
  const result = NativeName.name({
    _tag: "Deferred",
    coordinateVersion: NativeName.CoordinateVersion,
    occurrenceDigest: state.occurrence.occurrenceDigest,
    operationId,
    generation: attempt.attempt
  })
  return Result.isFailure(result)
    ? Effect.fail(attemptProtocolError(
      state,
      attempt,
      `Could not derive bounded attempt handshake name: ${result.failure.message}`
    ))
    : Effect.succeed(result.success)
}

const timeoutFor = (
  attempt: PreparedAttempt,
  timer: PreparedAttemptTimer,
  deadline: Wire.Timestamp
): NodeAttemptTimedOut =>
  Object.freeze({
    _tag: "TimedOut",
    outcomeVersion: 2,
    attempt: attempt.attempt,
    activityDigest: attempt.operation.operationDigest,
    timeout: {
      _tag: "AttemptTimeout" as const,
      failureCauseVersion: 1 as const,
      activityDigest: attempt.operation.operationDigest,
      attempt: attempt.attempt,
      timeoutKind: timer.timeoutKind
    },
    timerOperationDigest: timer.operation.operationDigest,
    deadline,
    durationMillis: timer.durationMillis
  })

const validateScheduleToStartArmed = (
  state: InvocationState,
  attempt: PreparedAttempt,
  armed: ScheduleToStartArmed
): Effect.Effect<void, EffectWorkflowRetryError> => {
  const timer = attempt.scheduleToStart
  if (
    timer === undefined ||
    armed.attempt !== attempt.attempt ||
    armed.activityDigest !== attempt.operation.operationDigest ||
    armed.timerOperationDigest !== timer.operation.operationDigest ||
    armed.durationMillis !== timer.durationMillis
  ) {
    return Effect.fail(attemptProtocolError(
      state,
      attempt,
      "Persisted schedule-to-start arm does not match its exact activity, timer, or duration"
    ))
  }
  return Effect.void
}

const timerForTimeout = (
  attempt: PreparedAttempt,
  timeoutKind: ActivityPolicyV3.AttemptTimeout["timeoutKind"]
): PreparedAttemptTimer | undefined =>
  timeoutKind === "ScheduleToStart"
    ? attempt.scheduleToStart
    : attempt.startToClose

const validateAttemptTimeout = (
  state: InvocationState,
  attempt: PreparedAttempt,
  timeout: NodeAttemptTimedOut,
  expectedDeadline?: Wire.Timestamp | undefined
): Effect.Effect<void, EffectWorkflowRetryError> => {
  const timer = timerForTimeout(
    attempt,
    timeout.timeout.timeoutKind
  )
  if (
    timer === undefined ||
    timeout.attempt !== attempt.attempt ||
    timeout.activityDigest !== attempt.operation.operationDigest ||
    timeout.timeout.attempt !== attempt.attempt ||
    timeout.timeout.activityDigest !==
      attempt.operation.operationDigest ||
    timeout.timerOperationDigest !==
      timer.operation.operationDigest ||
    timeout.durationMillis !== timer.durationMillis ||
    (expectedDeadline !== undefined &&
      timeout.deadline !== expectedDeadline)
  ) {
    return Effect.fail(attemptProtocolError(
      state,
      attempt,
      "Persisted attempt timeout does not match its exact activity, timer, duration, or deadline"
    ))
  }
  return Effect.void
}

const validateAttemptStarted = (
  state: InvocationState,
  attempt: PreparedAttempt,
  started: AttemptStarted
): Effect.Effect<void, EffectWorkflowRetryError> => {
  if (
    started.attempt !== attempt.attempt ||
    started.activityDigest !== attempt.operation.operationDigest
  ) {
    return Effect.fail(attemptProtocolError(
      state,
      attempt,
      "Persisted start acknowledgement belongs to a different managed attempt"
    ))
  }
  if (attempt.startToClose === undefined) {
    return started.startToClose._tag === "Disabled"
      ? Effect.void
      : Effect.fail(attemptProtocolError(
        state,
        attempt,
        "Persisted start acknowledgement arms an unconfigured start-to-close timeout"
      ))
  }
  return started.startToClose._tag === "Scheduled" &&
      started.startToClose.timerOperationDigest ===
        attempt.startToClose.operation.operationDigest &&
      started.startToClose.durationMillis ===
        attempt.startToClose.durationMillis
    ? Effect.void
    : Effect.fail(attemptProtocolError(
      state,
      attempt,
      "Persisted start acknowledgement does not match its exact start-to-close timer"
    ))
}

const validateAttemptOutcome = (
  state: InvocationState,
  attempt: PreparedAttempt,
  outcome: NodeAttemptOutcome,
  expectedTimeoutDeadline?: Wire.Timestamp | undefined
): Effect.Effect<void, EffectWorkflowRetryError> => {
  if (
    outcome.attempt !== attempt.attempt ||
    outcome.activityDigest !== attempt.operation.operationDigest
  ) {
    return Effect.fail(attemptProtocolError(
      state,
      attempt,
      "Persisted attempt terminal belongs to a different managed attempt"
    ))
  }
  return outcome._tag === "TimedOut"
    ? validateAttemptTimeout(
      state,
      attempt,
      outcome,
      expectedTimeoutDeadline
    )
    : Effect.void
}

type RetryTimer = (
  operation: SemanticOperationV3.PreparedOperation
) => Effect.Effect<
  void,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  EffectWorkflowSemanticV3.Requirements
>

type AttemptFence = () => Effect.Effect<
  ScheduleToCloseTimedOut | undefined,
  never,
  EffectWorkflowSemanticV3.Requirements
>

const executeAttempt = (
  state: InvocationState,
  attempt: PreparedAttempt,
  options: ExecutionOptions
): Effect.Effect<
  NodeAttemptOutcome,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  EffectWorkflowSemanticV3.Requirements
> => {
  if (
    attempt.scheduleToStart === undefined &&
    attempt.startToClose === undefined
  ) {
    return EffectWorkflowSemanticV3.nodeAttempt(
      attempt.resolution,
      options
    )
  }

  return Effect.gen(function*() {
    // Bind every descriptor before arming the queue deadline. Descriptor
    // admission work is not part of the user activity's schedule-to-start
    // interval, and replay must reject drift before reading a cached winner.
    yield* EffectWorkflowSemanticV3.bind(attempt.operation)
    if (attempt.scheduleToStart !== undefined) {
      yield* EffectWorkflowSemanticV3.bind(
        attempt.scheduleToStart.operation
      )
    }
    if (attempt.startToClose !== undefined) {
      yield* EffectWorkflowSemanticV3.bind(
        attempt.startToClose.operation
      )
    }

    const instance = yield* NativeWorkflowEngine.WorkflowInstance
    const startGate = NativeDeferred.make(
      yield* attemptPhaseName(
        state,
        attempt,
        OperationIds.AttemptStart
      ),
      {
        success: AttemptStartDecision,
        error: Schema.Never
      }
    )
    const scheduleToStartArmGate = attempt.scheduleToStart === undefined
      ? undefined
      : NativeDeferred.make(
        yield* attemptPhaseName(
          state,
          attempt,
          OperationIds.ScheduleToStartArm
        ),
        {
          success: ScheduleToStartArmed,
          error: Schema.Never
        }
      )
    const terminalGate = NativeDeferred.make(
      yield* attemptPhaseName(
        state,
        attempt,
        OperationIds.AttemptTerminal
      ),
      {
        success: NodeAttemptOutcome,
        error: EffectWorkflowSemanticV3.EffectWorkflowSemanticError
      }
    )
    const startToken = NativeDeferred.tokenFromExecutionId(
      startGate,
      {
        workflow: instance.workflow,
        executionId: instance.executionId
      }
    )
    const scheduleToStartArmToken = scheduleToStartArmGate === undefined
      ? undefined
      : NativeDeferred.tokenFromExecutionId(
        scheduleToStartArmGate,
        {
          workflow: instance.workflow,
          executionId: instance.executionId
        }
      )
    const terminalToken = NativeDeferred.tokenFromExecutionId(
      terminalGate,
      {
        workflow: instance.workflow,
        executionId: instance.executionId
      }
    )

    let scheduleToStartArmed:
      | ScheduleToStartArmed
      | undefined
    const validateStartDecisionTimeout = (
      timeout: NodeAttemptTimedOut
    ): Effect.Effect<void, EffectWorkflowRetryError> => {
      if (
        timeout.timeout.timeoutKind !== "ScheduleToStart" ||
        scheduleToStartArmed === undefined
      ) {
        return Effect.fail(attemptProtocolError(
          state,
          attempt,
          "Persisted start-gate timeout is not the exact canonical schedule-to-start decision"
        ))
      }
      return validateAttemptTimeout(
        state,
        attempt,
        timeout,
        scheduleToStartArmed.deadline
      )
    }
    const expectedTimeoutDeadlineFor = (
      outcome: NodeAttemptOutcome
    ): Effect.Effect<
      Wire.Timestamp | undefined,
      EffectWorkflowRetryError,
      NativeWorkflowEngine.WorkflowEngine
    > => {
      if (outcome._tag !== "TimedOut") {
        return Effect.succeed(undefined)
      }
      if (outcome.timeout.timeoutKind === "ScheduleToStart") {
        return scheduleToStartArmed === undefined
          ? Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Persisted schedule-to-start timeout has no canonical arm acknowledgement"
          ))
          : Effect.succeed(scheduleToStartArmed.deadline)
      }
      return Effect.gen(function*() {
        const recordedStart = yield* NativeDeferred.poll(
          startGate,
          { token: startToken }
        )
        if (Option.isNone(recordedStart)) {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Persisted start-to-close timeout has no canonical start acknowledgement"
          ))
        }
        const decision = yield* recordedStart.value
        if (decision._tag !== "Started") {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Persisted start-to-close timeout is paired with a non-start decision"
          ))
        }
        yield* validateAttemptStarted(state, attempt, decision)
        if (decision.startToClose._tag !== "Scheduled") {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Persisted start-to-close timeout is paired with a disabled start-to-close acknowledgement"
          ))
        }
        return decision.startToClose.deadline
      })
    }
    const readTerminal = Effect.gen(function*() {
      const recorded = yield* NativeDeferred.poll(
        terminalGate,
        { token: terminalToken }
      )
      if (Option.isNone(recorded)) return Option.none()
      if (Exit.isSuccess(recorded.value)) {
        const expectedTimeoutDeadline = yield* expectedTimeoutDeadlineFor(recorded.value.value)
        yield* validateAttemptOutcome(
          state,
          attempt,
          recorded.value.value,
          expectedTimeoutDeadline
        )
      }
      return recorded
    })

    if (
      attempt.scheduleToStart !== undefined &&
      scheduleToStartArmGate !== undefined &&
      scheduleToStartArmToken !== undefined
    ) {
      const clock = yield* deadlineFromNow(
        state,
        attempt,
        attempt.scheduleToStart.durationMillis
      )
      const armedExit = yield* NativeDeferred.resolve(
        scheduleToStartArmGate,
        {
          token: scheduleToStartArmToken,
          exit: Exit.succeed({
            _tag: "Armed",
            armVersion: 1,
            activityDigest: attempt.operation.operationDigest,
            attempt: attempt.attempt,
            timerOperationDigest: attempt.scheduleToStart.operation.operationDigest,
            armedAt: clock.startedAt,
            deadline: clock.deadline,
            durationMillis: attempt.scheduleToStart.durationMillis
          })
        }
      )
      scheduleToStartArmed = yield* armedExit
      yield* validateScheduleToStartArmed(
        state,
        attempt,
        scheduleToStartArmed
      )
      const wakeUp = yield* dateTimeAt(
        state,
        attempt,
        Date.parse(scheduleToStartArmed.deadline)
      )
      yield* NativeClock.schedule(startGate, {
        token: startToken,
        scheduleId: attempt.scheduleToStart.operationName,
        wakeUp: wakeUp.dateTime,
        value: timeoutFor(
          attempt,
          attempt.scheduleToStart,
          scheduleToStartArmed.deadline
        )
      })
    }

    const recorded = yield* readTerminal
    if (Option.isSome(recorded)) {
      return yield* recorded.value
    }

    const startGateEffect = Effect.gen(function*() {
      const recorded = yield* NativeDeferred.poll(
        startGate,
        { token: startToken }
      )
      let canonical: AttemptStartDecision
      if (Option.isSome(recorded)) {
        canonical = yield* recorded.value
      } else {
        const observedAt = yield* Clock.currentTimeMillis
        if (
          scheduleToStartArmed !== undefined &&
          attempt.scheduleToStart !== undefined &&
          observedAt >= Date.parse(scheduleToStartArmed.deadline)
        ) {
          const canonicalExit = yield* NativeDeferred.resolve(
            startGate,
            {
              token: startToken,
              exit: Exit.succeed(timeoutFor(
                attempt,
                attempt.scheduleToStart,
                scheduleToStartArmed.deadline
              ))
            }
          )
          canonical = yield* canonicalExit
        } else {
          const startedClock = attempt.startToClose === undefined
            ? undefined
            : yield* deadlineFromStart(
              state,
              attempt,
              observedAt,
              attempt.startToClose.durationMillis
            )
          const candidate = Object.freeze({
            _tag: "Started" as const,
            startVersion: 1 as const,
            activityDigest: attempt.operation.operationDigest,
            attempt: attempt.attempt,
            startedAt: startedClock === undefined
              ? (yield* dateTimeAt(
                state,
                attempt,
                observedAt
              )).timestamp
              : startedClock.startedAt,
            startToClose: startedClock === undefined
              ? { _tag: "Disabled" as const }
              : {
                _tag: "Scheduled" as const,
                timerOperationDigest: attempt.startToClose!.operation.operationDigest,
                durationMillis: attempt.startToClose!.durationMillis,
                deadline: startedClock.deadline
              }
          }) satisfies AttemptStarted
          const canonicalExit = yield* NativeDeferred.resolve(
            startGate,
            {
              token: startToken,
              exit: Exit.succeed(candidate)
            }
          )
          canonical = yield* canonicalExit
        }
      }
      if (canonical._tag === "TimedOut") {
        yield* validateStartDecisionTimeout(canonical)
        return canonical
      }
      yield* validateAttemptStarted(
        state,
        attempt,
        canonical
      )

      if (
        canonical.startToClose._tag === "Scheduled" &&
        attempt.startToClose !== undefined
      ) {
        const wakeUp = yield* dateTimeAt(
          state,
          attempt,
          Date.parse(canonical.startToClose.deadline)
        )
        const timeout = timeoutFor(
          attempt,
          attempt.startToClose,
          canonical.startToClose.deadline
        )
        yield* NativeClock.schedule(terminalGate, {
          token: terminalToken,
          scheduleId: attempt.startToClose.operationName,
          wakeUp: wakeUp.dateTime,
          value: timeout
        })

        // Re-delivery after a crash must not run user code merely because the
        // durable timer delivery is a little late. The canonical start
        // acknowledgement itself carries the absolute deadline.
        if (
          (yield* Clock.currentTimeMillis) >=
            Date.parse(canonical.startToClose.deadline)
        ) {
          const terminal = yield* NativeDeferred.resolve(
            terminalGate,
            {
              token: terminalToken,
              exit: Exit.succeed(timeout)
            }
          )
          if (
            Exit.isSuccess(terminal) &&
            terminal.value._tag === "TimedOut"
          ) {
            yield* validateAttemptTimeout(
              state,
              attempt,
              terminal.value,
              canonical.startToClose.deadline
            )
            return terminal.value
          }
          if (Exit.isFailure(terminal)) {
            return yield* Effect.die(terminal.cause)
          }
        }
      }
      return undefined
    })

    const expectedStartGateTimeout = Effect.gen(function*() {
      const recorded = yield* NativeDeferred.poll(
        startGate,
        { token: startToken }
      )
      if (Option.isNone(recorded)) return undefined
      const decision = yield* recorded.value
      if (decision._tag === "TimedOut") {
        const timer = attempt.scheduleToStart
        const armed = scheduleToStartArmed
        if (timer === undefined || armed === undefined) {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Canonical start-gate timeout has no matching schedule-to-start arm"
          ))
        }
        yield* validateStartDecisionTimeout(decision)
        return timeoutFor(
          attempt,
          timer,
          armed.deadline
        )
      }
      yield* validateAttemptStarted(state, attempt, decision)
      if (
        decision.startToClose._tag === "Scheduled" &&
        attempt.startToClose !== undefined
      ) {
        return timeoutFor(
          attempt,
          attempt.startToClose,
          decision.startToClose.deadline
        )
      }
      return undefined
    })

    const terminalTimeoutAt = (
      receiptCompletedAt: number,
      declaredCompletedAt?: number | undefined
    ): Effect.Effect<
      NodeAttemptTimedOut | undefined,
      EffectWorkflowRetryError,
      NativeWorkflowEngine.WorkflowEngine
    > =>
      Effect.gen(function*() {
        const recorded = yield* NativeDeferred.poll(
          startGate,
          { token: startToken }
        )
        if (Option.isNone(recorded)) {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Managed activity completed without a canonical start acknowledgement"
          ))
        }
        const started = yield* recorded.value
        if (started._tag === "TimedOut") {
          yield* validateStartDecisionTimeout(started)
          return started
        }
        yield* validateAttemptStarted(
          state,
          attempt,
          started
        )
        const startedAt = Date.parse(started.startedAt)
        if (
          !Number.isSafeInteger(receiptCompletedAt) ||
          !Number.isSafeInteger(startedAt) ||
          (declaredCompletedAt !== undefined &&
            !Number.isSafeInteger(declaredCompletedAt))
        ) {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Managed activity start or completion is not a safe canonical timestamp"
          ))
        }
        if (
          receiptCompletedAt < startedAt ||
          (declaredCompletedAt !== undefined &&
            (
              declaredCompletedAt < startedAt ||
              declaredCompletedAt > receiptCompletedAt
            ))
        ) {
          return yield* Effect.fail(attemptProtocolError(
            state,
            attempt,
            "Managed activity completion precedes its canonical start or follows its native completion receipt"
          ))
        }
        if (
          started.startToClose._tag === "Scheduled" &&
          attempt.startToClose !== undefined
        ) {
          const deadline = Date.parse(
            started.startToClose.deadline
          )
          if (!Number.isSafeInteger(deadline)) {
            return yield* Effect.fail(attemptProtocolError(
              state,
              attempt,
              "Managed activity start-to-close deadline is not a safe canonical timestamp"
            ))
          }
          if (receiptCompletedAt >= deadline) {
            return timeoutFor(
              attempt,
              attempt.startToClose,
              started.startToClose.deadline
            )
          }
        }
        return undefined
      })

    const terminalOutcomeFor = (
      outcome: NodeAttemptOutcome,
      receiptCompletedAt: number
    ): Effect.Effect<
      NodeAttemptOutcome,
      EffectWorkflowRetryError,
      NativeWorkflowEngine.WorkflowEngine
    > =>
      Effect.gen(function*() {
        const expectedTimeoutDeadline = yield* expectedTimeoutDeadlineFor(outcome)
        yield* validateAttemptOutcome(
          state,
          attempt,
          outcome,
          expectedTimeoutDeadline
        )
        if (outcome._tag === "TimedOut") return outcome
        const timeout = yield* terminalTimeoutAt(
          receiptCompletedAt,
          Date.parse(outcome.completedAt)
        )
        return timeout ?? outcome
      })

    const terminalExitFor = (
      completion: EffectWorkflowSemanticV3.NodeAttemptCompletion
    ): Effect.Effect<
      Exit.Exit<NodeAttemptOutcome, never>,
      EffectWorkflowRetryError,
      NativeWorkflowEngine.WorkflowEngine
    > =>
      Effect.gen(function*() {
        const receiptCompletedAt = DateTime.toEpochMillis(
          completion.completedAt
        )
        if (Exit.isSuccess(completion.exit)) {
          return Exit.succeed(
            yield* terminalOutcomeFor(
              completion.exit.value,
              receiptCompletedAt
            )
          )
        }
        const cause = completion.exit.cause
        if (Cause.hasInterruptsOnly(cause)) {
          return yield* Effect.failCause(cause)
        }
        const reasons = cause.reasons.filter(
          (reason) => !Cause.isInterruptReason(reason)
        )
        if (reasons.length === 0) {
          return yield* Effect.failCause(cause)
        }
        const timeout = yield* terminalTimeoutAt(
          receiptCompletedAt
        )
        return timeout === undefined
          ? Exit.failCause(Cause.fromReasons(reasons))
          : Exit.succeed(timeout)
      })

    const activity = EffectWorkflowSemanticV3
      .nodeAttemptCompletionWithStartGate(
        attempt.resolution,
        {
          interruptRetryPolicy: options.interruptRetryPolicy,
          expectedTimeout: expectedStartGateTimeout.pipe(
            Effect.orDie
          ),
          startGate: startGateEffect.pipe(Effect.orDie)
        }
      )

    const publishActivity = Effect.flatMap(
      activity,
      (completion) => terminalExitFor(completion).pipe(Effect.orDie)
    ).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause)
          }
          const reasons = cause.reasons.filter(
            (reason) => !Cause.isInterruptReason(reason)
          )
          if (reasons.length === 0) {
            return Effect.failCause(cause)
          }
          return NativeDeferred.resolve(terminalGate, {
            token: terminalToken,
            exit: Exit.failCause(Cause.fromReasons(reasons))
          }).pipe(Effect.asVoid)
        },
        onSuccess: (exit) =>
          NativeDeferred.resolve(terminalGate, {
            token: terminalToken,
            exit
          }).pipe(Effect.asVoid)
      })
    )
    const activityFiber = yield* publishActivity.pipe(
      Effect.forkDetach({ startImmediately: true })
    )

    return yield* Effect.gen(function*() {
      let immediatePolls = 0
      let nextDelay = MinimumDeferredPollMillis
      while (true) {
        const terminal = yield* readTerminal
        if (Option.isSome(terminal)) {
          return yield* terminal.value
        }
        if (attempt.scheduleToStart !== undefined) {
          const start = yield* NativeDeferred.poll(
            startGate,
            { token: startToken }
          )
          if (Option.isSome(start)) {
            const decision = yield* start.value
            if (decision._tag === "TimedOut") {
              yield* validateStartDecisionTimeout(decision)
              const canonical = yield* NativeDeferred.resolve(
                terminalGate,
                {
                  token: terminalToken,
                  exit: Exit.succeed(decision)
                }
              )
              if (Exit.isSuccess(canonical)) {
                const expectedTimeoutDeadline = yield* expectedTimeoutDeadlineFor(canonical.value)
                yield* validateAttemptOutcome(
                  state,
                  attempt,
                  canonical.value,
                  expectedTimeoutDeadline
                )
              }
              return yield* canonical
            }
            yield* validateAttemptStarted(
              state,
              attempt,
              decision
            )
          }
        }
        if (immediatePolls < ImmediateDeferredPolls) {
          immediatePolls++
          yield* Effect.yieldNow
          continue
        }
        yield* Effect.sleep(Duration.millis(nextDelay))
        nextDelay = Math.min(
          nextDelay * 2,
          MaximumDeferredPollMillis
        )
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => activityFiber.interruptUnsafe())
      )
    )
  })
}

const retryLoop = (
  state: InvocationState,
  options: ExecutionOptions,
  initialObservation?: Wire.Timestamp | undefined,
  sleep: RetryTimer = EffectWorkflowSemanticV3.sleep,
  attemptFence?: AttemptFence | undefined
): Effect.Effect<
  RetryExecutionOutcome,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> =>
  Effect.gen(function*() {
    const initialObservedAt = initialObservation ??
      (yield* EffectWorkflowSemanticV3.timeObservation(
        state.initialObservation,
        options
      ))
    let attempt = state.firstAttempt

    while (true) {
      if (attemptFence !== undefined) {
        const timedOut = yield* attemptFence()
        if (timedOut !== undefined) return timedOut
      }
      const outcome = yield* executeAttempt(
        state,
        attempt,
        options
      )
      if (outcome._tag === "Succeeded") {
        return outcome
      }
      const failure = outcome._tag === "ApplicationFailed"
        ? outcome.failure
        : outcome.timeout
      const failureObservation = yield* prepareTimeObservation(state, {
        operationId: OperationIds.FailureTime,
        attempt: attempt.attempt,
        owner: attempt.operation,
        kind: "Failure"
      })
      const failedObservedAt = yield* EffectWorkflowSemanticV3.timeObservation(
        failureObservation,
        options
      )
      const elapsedMillis = yield* Effect.fromResult(
        elapsedBetween(
          state.node.binding.nodeId,
          initialObservedAt,
          failedObservedAt
        )
      )
      if (failure._tag === "ApplicationFailure") {
        const disposition = ActivityPolicyV3.failureDisposition(
          state.node.binding.activityPolicy,
          failure.identity
        )
        if (Result.isFailure(disposition)) {
          return yield* Effect.die(retryDefect(
            attempt,
            DefectCodes.InvalidPolicyEvaluation,
            `Failure disposition evaluation failed: ${disposition.failure.message}`
          ))
        }
        if (
          disposition.success._tag ===
            "ExplicitNonRetryable"
        ) {
          return explicitTerminal(
            failure,
            initialObservedAt,
            failedObservedAt,
            elapsedMillis,
            disposition.success
          )
        }
      }

      const classifier = yield* prepareClassifier(
        state,
        attempt,
        failure
      )
      const classification = yield* EffectWorkflowSemanticV3.retryClassifier(
        classifier,
        options
      )
      if (classification._tag === "NonRetryable") {
        return outcome._tag === "TimedOut"
          ? classifiedTimeoutTerminal(
            outcome,
            initialObservedAt,
            failedObservedAt,
            elapsedMillis,
            classifier
          )
          : classifiedTerminal(
            failure as ActivityPolicyV3.ApplicationFailure,
            initialObservedAt,
            failedObservedAt,
            elapsedMillis,
            classifier
          )
      }

      const delayInput = {
        evaluationVersion: 1,
        failedAttempt: attempt.attempt,
        elapsedMillis
      } satisfies ActivityPolicyV3.RetryDelayInput
      const decision = ActivityPolicyV3.retryDelayRange(
        state.node.binding.activityPolicy,
        delayInput
      )
      if (Result.isFailure(decision)) {
        return yield* Effect.die(retryDefect(
          attempt,
          DefectCodes.InvalidPolicyEvaluation,
          `Retry-delay evaluation failed: ${decision.failure.message}`
        ))
      }
      if (decision.success._tag === "DoNotRetry") {
        return outcome._tag === "TimedOut"
          ? exhaustedTimeoutTerminal(
            outcome,
            initialObservedAt,
            failedObservedAt,
            elapsedMillis,
            classifier,
            decision.success.reason
          )
          : exhaustedTerminal(
            failure as ActivityPolicyV3.ApplicationFailure,
            initialObservedAt,
            failedObservedAt,
            elapsedMillis,
            classifier,
            decision.success.reason
          )
      }

      const delayResolution = yield* prepareDelaySelection(
        state,
        attempt,
        classifier,
        delayInput
      )
      const delay = yield* EffectWorkflowSemanticV3.retryDelaySelection(
        delayResolution,
        options
      )
      if (delay.selectedDelayMillis > 0) {
        const timer = yield* prepareBackoff(
          state,
          attempt,
          delay
        )
        yield* sleep(timer)
      }
      attempt = yield* prepareAttempt(
        state,
        delay.nextAttempt
      )
    }
  })

const completeRetryOutcome = (
  state: InvocationState,
  outcome: RetryScheduleToCloseOutcome
): Effect.Effect<unknown, TerminalFailure> => {
  switch (outcome._tag) {
    case "Succeeded":
      return decodeSucceededOutput(state, outcome)
    case "NonRetryable":
    case "Exhausted":
    case "AttemptTimedOut":
    case "ScheduleToCloseTimedOut":
      return Effect.fail(outcome)
  }
}

const scheduleToCloseWinner = (
  controller: PreparedScheduleToClose,
  exit: Exit.Exit<RetryScheduleToCloseOutcome, never>
): RetryScheduleToCloseWinner => ({
  _tag: "RetryScheduleToCloseWinner",
  outcomeEnvelopeVersion: 2,
  controllerOperationDigest: controller.operation.operationDigest,
  exit
})

const retryWinner = (
  state: InvocationState,
  controller: PreparedScheduleToClose,
  options: ExecutionOptions,
  initialObservedAt: Wire.Timestamp,
  attemptFence: AttemptFence
): Effect.Effect<
  RetryScheduleToCloseWinner,
  never,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> =>
  retryLoop(
    state,
    options,
    initialObservedAt,
    (operation) => nonSuspendingTimer(state, operation),
    attemptFence
  ).pipe(
    // Once the business terminal values have been closed into the success
    // channel, only adapter/protocol failures remain typed. They are defects
    // of this authenticated controller, never application failures.
    Effect.orDie,
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause)
        }
        const reasons = cause.reasons.filter(
          (reason) => !Cause.isInterruptReason(reason)
        )
        if (reasons.length === 0) {
          return Effect.failCause(cause)
        }
        return Effect.succeed(scheduleToCloseWinner(
          controller,
          Exit.failCause(Cause.fromReasons(reasons))
        ))
      },
      onSuccess: (outcome) =>
        Effect.succeed(scheduleToCloseWinner(
          controller,
          Exit.succeed(outcome)
        ))
    })
  ) as Effect.Effect<
    RetryScheduleToCloseWinner,
    never,
    | Crypto.Crypto
    | EffectWorkflowSemanticV3.Requirements
  >

const timeoutOutcome = (
  controller: PreparedScheduleToClose
): ScheduleToCloseTimedOut => ({
  _tag: "ScheduleToCloseTimedOut",
  timeoutVersion: 1,
  timeoutKind: "ScheduleToClose",
  controllerOperationDigest: controller.operation.operationDigest,
  firstActivityDigest: controller.operation.document.firstActivityDigest,
  durationMillis: controller.durationMillis
})

const timeoutWinner = (
  controller: PreparedScheduleToClose
): RetryScheduleToCloseWinner =>
  scheduleToCloseWinner(
    controller,
    Exit.succeed(timeoutOutcome(controller))
  )

const invalidWinnerCoordinates = (
  state: InvocationState,
  controller: PreparedScheduleToClose,
  message: string
): EffectWorkflowRetryError =>
  retryError(
    ErrorCodes.OperationPreparationFailed,
    message,
    {
      nodeId: state.node.binding.nodeId,
      operationId: OperationIds.ScheduleToClose,
      operationDigest: controller.operation.operationDigest
    }
  )

const validateWinnerCoordinates = (
  state: InvocationState,
  controller: PreparedScheduleToClose,
  outcome: RetryScheduleToCloseOutcome,
  options: ExecutionOptions
): Effect.Effect<
  void,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  Crypto.Crypto | EffectWorkflowSemanticV3.Requirements
> =>
  Effect.gen(function*() {
    if (outcome._tag === "ScheduleToCloseTimedOut") {
      if (
        outcome.controllerOperationDigest !==
          controller.operation.operationDigest ||
        outcome.firstActivityDigest !==
          controller.operation.document.firstActivityDigest ||
        outcome.durationMillis !== controller.durationMillis
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted schedule-to-close timeout coordinates do not match its exact controller"
        ))
      }
      return
    }

    const attemptNumber = outcome._tag === "Succeeded"
      ? outcome.attempt
      : outcome._tag === "AttemptTimedOut"
      ? outcome.timeout.attempt
      : outcome.cause.attempt
    const activityDigest = outcome._tag === "Succeeded"
      ? outcome.activityDigest
      : outcome._tag === "AttemptTimedOut"
      ? outcome.timeout.activityDigest
      : outcome.cause.activityDigest
    const attempt = yield* prepareAttempt(state, attemptNumber)
    if (attempt.operation.operationDigest !== activityDigest) {
      return yield* Effect.fail(invalidWinnerCoordinates(
        state,
        controller,
        "Persisted retry winner activity coordinates do not match the exact managed attempt"
      ))
    }

    if (outcome._tag === "Succeeded") return

    const initialObservedAt = yield* EffectWorkflowSemanticV3.timeObservation(
      state.initialObservation,
      options
    )
    const failureObservation = yield* prepareTimeObservation(state, {
      operationId: OperationIds.FailureTime,
      attempt: attempt.attempt,
      owner: attempt.operation,
      kind: "Failure"
    })
    const failedObservedAt = yield* EffectWorkflowSemanticV3.timeObservation(
      failureObservation,
      options
    )
    const elapsedMillis = yield* Effect.fromResult(
      elapsedBetween(
        state.node.binding.nodeId,
        initialObservedAt,
        failedObservedAt
      )
    )
    if (
      outcome.initialObservedAt !== initialObservedAt ||
      outcome.failedObservedAt !== failedObservedAt ||
      outcome.elapsedMillis !== elapsedMillis
    ) {
      return yield* Effect.fail(invalidWinnerCoordinates(
        state,
        controller,
        "Persisted terminal retry timestamps do not match their replay-recorded observations"
      ))
    }

    if (outcome._tag === "AttemptTimedOut") {
      yield* validateAttemptTimeout(
        state,
        attempt,
        outcome.timeout
      )
      const classifier = yield* prepareClassifier(
        state,
        attempt,
        outcome.timeout.timeout
      )
      if (
        classifier.operation.operationDigest !==
          outcome.decision.classificationActivityDigest
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted attempt-timeout classifier coordinates do not match its exact timed-out attempt"
        ))
      }
      const classification = yield* EffectWorkflowSemanticV3.retryClassifier(
        classifier,
        options
      )
      if (outcome.decision._tag === "NonRetryable") {
        if (classification._tag !== "NonRetryable") {
          return yield* Effect.fail(invalidWinnerCoordinates(
            state,
            controller,
            "Persisted attempt-timeout terminal contradicts its replay-recorded classifier result"
          ))
        }
        return
      }
      if (classification._tag !== "Retryable") {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted exhausted attempt timeout contradicts its replay-recorded classifier result"
        ))
      }
      const decision = ActivityPolicyV3.retryDelayRange(
        state.node.binding.activityPolicy,
        {
          evaluationVersion: 1,
          failedAttempt: attempt.attempt,
          elapsedMillis
        }
      )
      if (
        Result.isFailure(decision) ||
        decision.success._tag !== "DoNotRetry" ||
        decision.success.reason !== outcome.decision.reason
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted exhausted attempt timeout does not match the exact retry policy decision"
        ))
      }
      return
    }

    const disposition = ActivityPolicyV3.failureDisposition(
      state.node.binding.activityPolicy,
      outcome.cause.identity
    )
    if (Result.isFailure(disposition)) {
      return yield* Effect.fail(invalidWinnerCoordinates(
        state,
        controller,
        "Persisted terminal retry policy could not be evaluated deterministically"
      ))
    }
    if (
      outcome._tag === "NonRetryable" &&
      outcome.decision._tag === "PolicyOverride"
    ) {
      if (
        disposition.success._tag !== "ExplicitNonRetryable" ||
        disposition.success.matchedBy !== outcome.decision.matchedBy
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted non-retryable policy override does not match the exact activity policy"
        ))
      }
      return
    }
    if (disposition.success._tag === "ExplicitNonRetryable") {
      return yield* Effect.fail(invalidWinnerCoordinates(
        state,
        controller,
        "Persisted classifier terminal contradicts an exact non-retryable policy override"
      ))
    }

    if (
      outcome._tag === "NonRetryable" &&
      outcome.decision._tag === "Classifier"
    ) {
      const classifier = yield* prepareClassifier(
        state,
        attempt,
        outcome.cause
      )
      if (
        classifier.operation.operationDigest !==
          outcome.decision.classificationActivityDigest
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted non-retryable classifier coordinates do not match its exact failed attempt"
        ))
      }
      const classification = yield* EffectWorkflowSemanticV3.retryClassifier(
        classifier,
        options
      )
      if (classification._tag !== "NonRetryable") {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted non-retryable terminal contradicts its replay-recorded classifier result"
        ))
      }
    } else if (outcome._tag === "Exhausted") {
      const classifier = yield* prepareClassifier(
        state,
        attempt,
        outcome.cause
      )
      if (
        classifier.operation.operationDigest !==
          outcome.classificationActivityDigest
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted exhausted classifier coordinates do not match its exact failed attempt"
        ))
      }
      const classification = yield* EffectWorkflowSemanticV3.retryClassifier(
        classifier,
        options
      )
      if (classification._tag !== "Retryable") {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted exhausted terminal contradicts its replay-recorded classifier result"
        ))
      }
      const decision = ActivityPolicyV3.retryDelayRange(
        state.node.binding.activityPolicy,
        {
          evaluationVersion: 1,
          failedAttempt: attempt.attempt,
          elapsedMillis
        }
      )
      if (
        Result.isFailure(decision) ||
        decision.success._tag !== "DoNotRetry" ||
        decision.success.reason !== outcome.reason
      ) {
        return yield* Effect.fail(invalidWinnerCoordinates(
          state,
          controller,
          "Persisted exhausted terminal does not match the exact retry policy decision"
        ))
      }
    }
  })

const remainingScheduleToClose = (
  state: InvocationState,
  initialObservedAt: Wire.Timestamp,
  durationMillis: Wire.PositiveSemanticDelayMillis
): Effect.Effect<number, EffectWorkflowRetryError> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => {
    const initial = Date.parse(initialObservedAt)
    if (
      !Number.isSafeInteger(initial) ||
      !Number.isSafeInteger(now)
    ) {
      return Effect.fail(retryError(
        ErrorCodes.ClockRegression,
        "Schedule-to-close time could not be represented as safe epoch milliseconds",
        { nodeId: state.node.binding.nodeId }
      ))
    }
    if (now < initial) {
      return Effect.fail(retryError(
        ErrorCodes.ClockRegression,
        "Current time precedes the replay-recorded schedule-to-close observation",
        { nodeId: state.node.binding.nodeId }
      ))
    }
    return Effect.succeed(
      Math.max(0, durationMillis - (now - initial))
    )
  })

const MaximumDeferredPollMillis = 1_000
const MinimumDeferredPollMillis = 10
const ImmediateDeferredPolls = 64

const adaptivePollDelay = (
  estimateDeadline: number,
  nextDelay: number,
  now: number
): number => {
  const untilEstimate = Math.max(0, estimateDeadline - now)
  return untilEstimate === 0
    ? MinimumDeferredPollMillis
    : Math.max(
      1,
      Math.min(nextDelay, untilEstimate)
    )
}

const awaitScheduledClock = (
  engine: NativeWorkflowEngine.WorkflowEngine["Service"],
  clock: NativeClock.DurableClock,
  estimatedRemainingMillis: number
): Effect.Effect<void, never, NativeWorkflowEngine.WorkflowInstance> =>
  Effect.gen(function*() {
    const estimatedDeadline = (yield* Clock.currentTimeMillis) + estimatedRemainingMillis
    let nextDelay = MinimumDeferredPollMillis
    while (true) {
      const completed = yield* engine.deferredResult(clock.deferred)
      if (Option.isSome(completed)) {
        return yield* completed.value
      }
      // Durable clock delivery is the sole timeout authority. The estimate
      // only reduces reads; every execution polls before sleeping, then uses
      // bounded adaptive delays and lands exactly on its local estimate.
      const delay = adaptivePollDelay(
        estimatedDeadline,
        nextDelay,
        yield* Clock.currentTimeMillis
      )
      yield* Effect.sleep(Duration.millis(delay))
      nextDelay = Math.min(
        nextDelay * 2,
        MaximumDeferredPollMillis
      )
    }
  })

const timeoutIfClockCompleted = (
  engine: NativeWorkflowEngine.WorkflowEngine["Service"],
  clock: NativeClock.DurableClock,
  controller: PreparedScheduleToClose
): Effect.Effect<
  ScheduleToCloseTimedOut | undefined,
  never,
  NativeWorkflowEngine.WorkflowInstance
> =>
  Effect.flatMap(
    engine.deferredResult(clock.deferred),
    (completed) =>
      Option.isNone(completed)
        ? Effect.succeed(undefined)
        : Effect.as(
          completed.value,
          timeoutOutcome(controller)
        )
  )

const nonSuspendingTimer = (
  state: InvocationState,
  operation: SemanticOperationV3.PreparedOperation
): Effect.Effect<
  void,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  EffectWorkflowSemanticV3.Requirements
> =>
  Effect.gen(function*() {
    if (operation.document._tag !== "Timer") {
      return yield* Effect.fail(retryError(
        ErrorCodes.OperationPreparationFailed,
        "Managed retry backoff requires an exact Timer operation",
        {
          nodeId: state.node.binding.nodeId,
          operationId: operation.document.operationId,
          operationDigest: operation.operationDigest
        }
      ))
    }
    yield* EffectWorkflowSemanticV3.bind(operation)
    const engine = yield* NativeWorkflowEngine.WorkflowEngine
    const instance = yield* NativeWorkflowEngine.WorkflowInstance
    const clock = NativeClock.make({
      name: yield* nativeOperationName(
        state.node.binding.nodeId,
        operation
      ),
      duration: Duration.millis(operation.document.delayMillis)
    })
    yield* engine.scheduleClock(instance.workflow, {
      executionId: instance.executionId,
      clock
    })
    return yield* awaitScheduledClock(
      engine,
      clock,
      operation.document.delayMillis
    )
  })

const persistControllerWinner = <R>(
  engine: NativeWorkflowEngine.WorkflowEngine["Service"],
  instance: NativeWorkflowEngine.WorkflowInstance["Service"],
  deferred: NativeDeferred.DurableDeferred<
    typeof RetryScheduleToCloseWinner,
    typeof Schema.Never
  >,
  contender: Effect.Effect<RetryScheduleToCloseWinner, never, R>
): Effect.Effect<void, never, R> =>
  Effect.flatMap(
    contender,
    (winner) =>
      engine.deferredDone(deferred, {
        workflowName: instance.workflow._tag,
        executionId: instance.executionId,
        deferredName: deferred.name,
        exit: Exit.succeed(winner)
      })
  )

const readControllerWinner = (
  state: InvocationState,
  controller: PreparedScheduleToClose,
  engine: NativeWorkflowEngine.WorkflowEngine["Service"],
  deferred: NativeDeferred.DurableDeferred<
    typeof RetryScheduleToCloseWinner,
    typeof Schema.Never
  >
): Effect.Effect<
  Option.Option<RetryScheduleToCloseWinner>,
  never,
  NativeWorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    const recorded = yield* engine.deferredResult(deferred)
    if (Option.isNone(recorded)) return Option.none()
    if (Exit.isFailure(recorded.value)) {
      return yield* Effect.die(invalidWinnerCoordinates(
        state,
        controller,
        Cause.hasInterrupts(recorded.value.cause)
          ? "Persisted retry controller deferred must never contain interruption"
          : "Persisted retry controller deferred must use its success-only winner envelope"
      ))
    }
    return Option.some(recorded.value.value)
  })

const awaitControllerWinner = (
  state: InvocationState,
  controller: PreparedScheduleToClose,
  engine: NativeWorkflowEngine.WorkflowEngine["Service"],
  deferred: NativeDeferred.DurableDeferred<
    typeof RetryScheduleToCloseWinner,
    typeof Schema.Never
  >,
  estimatedRemainingMillis: number
): Effect.Effect<
  RetryScheduleToCloseWinner,
  never,
  NativeWorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    const estimatedDeadline = (yield* Clock.currentTimeMillis) + estimatedRemainingMillis
    let immediatePolls = 0
    let nextDelay = MinimumDeferredPollMillis
    while (true) {
      const winner = yield* readControllerWinner(
        state,
        controller,
        engine,
        deferred
      )
      if (Option.isSome(winner)) return winner.value
      if (immediatePolls < ImmediateDeferredPolls) {
        immediatePolls++
        yield* Effect.yieldNow
        continue
      }
      const delay = adaptivePollDelay(
        estimatedDeadline,
        nextDelay,
        yield* Clock.currentTimeMillis
      )
      yield* Effect.sleep(Duration.millis(delay))
      nextDelay = Math.min(
        nextDelay * 2,
        MaximumDeferredPollMillis
      )
    }
  })

const clockWinner = (
  controller: PreparedScheduleToClose,
  clock: Effect.Effect<
    void,
    never,
    NativeWorkflowEngine.WorkflowInstance
  >
): Effect.Effect<
  RetryScheduleToCloseWinner,
  never,
  NativeWorkflowEngine.WorkflowInstance
> =>
  clock.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(scheduleToCloseWinner(
            controller,
            Exit.failCause(cause)
          )),
      onSuccess: () => Effect.succeed(timeoutWinner(controller))
    })
  )

const scheduleToClose = (
  state: InvocationState,
  controller: PreparedScheduleToClose,
  options: ExecutionOptions
): Effect.Effect<
  RetryExecutionOutcome,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> =>
  Effect.gen(function*() {
    // Descriptor binding always precedes cached-winner lookup, so replay
    // cannot consume an old winner under changed policy, input, or duration.
    yield* EffectWorkflowSemanticV3.bind(controller.operation)

    const engine = yield* NativeWorkflowEngine.WorkflowEngine
    const instance = yield* NativeWorkflowEngine.WorkflowInstance
    const durableWinner = NativeDeferred.make(
      `raceAll/${controller.operationName}`,
      {
        success: RetryScheduleToCloseWinner,
        error: Schema.Never
      }
    )
    const recorded = yield* readControllerWinner(
      state,
      controller,
      engine,
      durableWinner
    )
    let winner: RetryScheduleToCloseWinner
    if (Option.isSome(recorded)) {
      winner = recorded.value
    } else {
      // The stable native clock acknowledgement is the durable budget origin.
      // It precedes time observation and every attempt; replaying this call
      // retains the backend's original same-name schedule.
      const clock = NativeClock.make({
        name: controller.operationName,
        duration: Duration.millis(controller.durationMillis)
      })
      yield* engine.scheduleClock(instance.workflow, {
        executionId: instance.executionId,
        clock
      })

      const completedBeforeObservation = yield* timeoutIfClockCompleted(
        engine,
        clock,
        controller
      )
      if (completedBeforeObservation !== undefined) {
        yield* persistControllerWinner(
          engine,
          instance,
          durableWinner,
          Effect.succeed(timeoutWinner(controller))
        )
        winner = yield* awaitControllerWinner(
          state,
          controller,
          engine,
          durableWinner,
          0
        )
      } else {
        const initialObservedAt = yield* EffectWorkflowSemanticV3.timeObservation(
          state.initialObservation,
          options
        )
        const remainingMillis = yield* remainingScheduleToClose(
          state,
          initialObservedAt,
          controller.durationMillis
        )
        const timeoutPublisher = persistControllerWinner(
          engine,
          instance,
          durableWinner,
          clockWinner(
            controller,
            awaitScheduledClock(
              engine,
              clock,
              remainingMillis
            )
          )
        )
        const timeoutFiber = yield* timeoutPublisher.pipe(
          Effect.forkDetach({ startImmediately: true })
        )
        const contenderFibers = [timeoutFiber]

        // Re-read the persistent clock immediately before the first attempt.
        // A due-but-late local poll may never dispatch a post-deadline side
        // effect.
        const completedBeforeAttempt = yield* timeoutIfClockCompleted(
          engine,
          clock,
          controller
        )
        if (
          remainingMillis === 0 ||
          completedBeforeAttempt !== undefined
        ) {
          if (completedBeforeAttempt !== undefined) {
            yield* persistControllerWinner(
              engine,
              instance,
              durableWinner,
              Effect.succeed(timeoutWinner(controller))
            )
          }
        } else {
          const attemptFence = () =>
            timeoutIfClockCompleted(
              engine,
              clock,
              controller
            )
          const businessContender = Effect.flatMap(
            retryWinner(
              state,
              controller,
              options,
              initialObservedAt,
              attemptFence
            ),
            (candidate) =>
              Effect.map(
                // This final clock read fences success and defects before
                // either may publish to the first-wins controller deferred.
                attemptFence(),
                (timedOut) =>
                  timedOut === undefined
                    ? candidate
                    : timeoutWinner(controller)
              )
          )
          contenderFibers.push(
            yield* persistControllerWinner(
              engine,
              instance,
              durableWinner,
              businessContender
            ).pipe(
              Effect.forkDetach({ startImmediately: true })
            )
          )
        }

        winner = yield* awaitControllerWinner(
          state,
          controller,
          engine,
          durableWinner,
          remainingMillis
        ).pipe(
          Effect.ensuring(
            // On normal completion the first-wins ACK has already been read.
            // The same immediate cleanup also prevents detached contenders
            // leaking when the controller itself is interrupted or defects.
            Effect.sync(() => {
              for (const fiber of contenderFibers) {
                fiber.interruptUnsafe()
              }
            })
          )
        )
      }
    }
    if (
      winner.controllerOperationDigest !==
        controller.operation.operationDigest
    ) {
      return yield* Effect.die(retryError(
        ErrorCodes.OperationPreparationFailed,
        "Persisted retry schedule-to-close winner belongs to a different controller descriptor",
        {
          nodeId: state.node.binding.nodeId,
          operationId: OperationIds.ScheduleToClose,
          operationDigest: controller.operation.operationDigest
        }
      ))
    }
    if (
      Exit.isFailure(winner.exit) &&
      Cause.hasInterrupts(winner.exit.cause)
    ) {
      return yield* Effect.die(invalidWinnerCoordinates(
        state,
        controller,
        "Persisted retry winner Exit must never contain interruption"
      ))
    }
    const outcome = yield* winner.exit
    yield* validateWinnerCoordinates(
      state,
      controller,
      outcome,
      options
    ).pipe(Effect.orDie)
    return outcome
  })

const executePrepared = (
  state: InvocationState,
  options: ExecutionOptions
): Effect.Effect<
  RetryExecutionOutcome,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> =>
  state.scheduleToClose === undefined
    ? retryLoop(state, options)
    : scheduleToClose(state, state.scheduleToClose, options)

/**
 * Executes an opaque prepared invocation and returns its raw durable outcome.
 *
 * **Details**
 *
 * Successful activity output remains encoded and `NonRetryable`, `Exhausted`,
 * and `ScheduleToCloseTimedOut` are returned in the success channel. Defects
 * and interruption retain their native Effect semantics. The exact prepared
 * invocation provenance check happens before any handler can run.
 *
 * This and {@link execute} project the same private execution primitive;
 * consumers that need both activity metadata and a terminal classification
 * must call this function once rather than execute the workflow again.
 *
 * @category execution
 * @since 4.0.0
 */
export const executeDetailed = (
  invocation: PreparedRetryInvocation,
  options: ExecutionOptions
): Effect.Effect<
  RetryExecutionOutcome,
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> => {
  const state = invocationStates.get(invocation)
  if (state === undefined) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry execution requires the exact PreparedRetryInvocation returned by prepare"
    ))
  }
  return executePrepared(state, options)
}

/**
 * Executes an opaque prepared invocation through native durable activities and
 * timers.
 *
 * **Details**
 *
 * Explicit non-retryable lists are evaluated before the exact durable
 * classifier. Retryable failures pass through deterministic range evaluation,
 * internally sampled replay-recorded jitter, and a durable positive backoff
 * timer. Zero-delay transitions do not allocate a timer.
 *
 * `maximumElapsed` remains an admission budget for scheduling another
 * attempt. When configured, `scheduleToClose` is a separate hard semantic
 * deadline around the complete managed loop. The acknowledgement of one
 * stable native clock fixes the durable budget origin before the
 * replay-recorded initial observation or any node attempt.
 *
 * Contenders publish success-only values to one native durable deferred, whose
 * backend first-wins rule closes the result. After that winner is durably read,
 * loser fibers receive a fire-and-forget interruption request; their physical
 * shutdown is never joined and cannot delay the semantic terminal. Native
 * Effect Workflow does not promise rollback of an external side effect that a
 * handler already dispatched.
 *
 * The injected `WorkflowEngine` and its persistence are a trust boundary.
 * Descriptor binding, exact coordinate reconstruction, timestamp checks, and
 * interruption rejection detect schema-valid drift available through public
 * reads, but Effect Workflow currently exposes no independent read-only
 * activity-journal proof API.
 *
 * @category execution
 * @since 4.0.0
 */
export const execute = (
  invocation: PreparedRetryInvocation,
  options: ExecutionOptions
): Effect.Effect<
  unknown,
  | TerminalFailure
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> => {
  const state = invocationStates.get(invocation)
  if (state === undefined) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry execution requires the exact PreparedRetryInvocation returned by prepare"
    ))
  }
  return Effect.flatMap(
    executePrepared(state, options),
    (outcome) => completeRetryOutcome(state, outcome)
  )
}
