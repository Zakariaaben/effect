/**
 * Privileged protocol version `2` external-fact materialization.
 *
 * **Details**
 *
 * This module is a pure transaction specification for a future authoritative
 * store. Its capability-shaped operations construct only store-owned activity,
 * timer, and cancellation facts. It deliberately exposes no generic event
 * append operation.
 *
 * @since 4.0.0
 */
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as EventV2 from "./EventV2.ts"
import * as IdentityV2 from "./IdentityV2.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV2 from "./PlanStoreV2.ts"
import * as RunStateV2 from "./RunStateV2.ts"
import * as SemanticTime from "./SemanticTime.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const Operation = Schema.Literals([
  "recordActivityStarted",
  "completeActivityAttempt",
  "fireTimer",
  "requestCancellation"
])

type Operation = Schema.Schema.Type<typeof Operation>

const ActivityAttemptFields = {
  key: PlanStoreV2.RunKey,
  logicalActivityId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  attempt: PositiveSafeInt
} as const

/**
 * Exact activity-attempt owner supplied by a privileged worker boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RecordActivityStartedRequest = Schema.Struct(
  ActivityAttemptFields
).annotate({
  identifier: "WorkflowExternalEventV2RecordActivityStartedRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RecordActivityStartedRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RecordActivityStartedRequest = Schema.Schema.Type<
  typeof RecordActivityStartedRequest
>

const Succeeded = Schema.TaggedStruct("Succeeded", {
  output: EventV2.EncodedValues
}).annotate({
  identifier: "WorkflowExternalEventV2SucceededCompletion",
  parseOptions: strictParseOptions
})

const Failed = Schema.TaggedStruct("Failed", {
  failure: Schema.Json
}).annotate({
  identifier: "WorkflowExternalEventV2FailedCompletion",
  parseOptions: strictParseOptions
})

/**
 * Exact success or encoded application failure observed by a privileged
 * activity worker boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityCompletion = Schema.Union([
  Succeeded,
  Failed
]).annotate({
  identifier: "WorkflowExternalEventV2ActivityCompletion"
})

/**
 * The decoded type of {@link ActivityCompletion}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityCompletion = Schema.Schema.Type<typeof ActivityCompletion>

/**
 * Exact current activity attempt and its observed completion.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompleteActivityAttemptRequest = Schema.Struct({
  ...ActivityAttemptFields,
  completion: ActivityCompletion
}).annotate({
  identifier: "WorkflowExternalEventV2CompleteActivityAttemptRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompleteActivityAttemptRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompleteActivityAttemptRequest = Schema.Schema.Type<
  typeof CompleteActivityAttemptRequest
>

/**
 * Exact pending timer selected by a privileged due-timer index.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FireTimerRequest = Schema.Struct({
  key: PlanStoreV2.RunKey,
  timerId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowExternalEventV2FireTimerRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FireTimerRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type FireTimerRequest = Schema.Schema.Type<typeof FireTimerRequest>

/**
 * Exact run and idempotency identity supplied by a privileged cancellation
 * boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequestCancellationRequest = Schema.Struct({
  key: PlanStoreV2.RunKey,
  requestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowExternalEventV2RequestCancellationRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RequestCancellationRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequestCancellationRequest = Schema.Schema.Type<
  typeof RequestCancellationRequest
>

/**
 * Stable machine-readable external-fact materialization failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidRunState: "InvalidRunState",
  InvalidDurableHead: "InvalidDurableHead",
  InvalidRequest: "InvalidRequest",
  InvalidRecordedAt: "InvalidRecordedAt",
  TimestampRegression: "TimestampRegression",
  SequenceOutOfRange: "SequenceOutOfRange",
  RunKeyMismatch: "RunKeyMismatch",
  RunNotRunning: "RunNotRunning",
  ActivityNotFound: "ActivityNotFound",
  AttemptMismatch: "AttemptMismatch",
  IllegalActivityTransition: "IllegalActivityTransition",
  TimerNotFound: "TimerNotFound",
  TimerNotPending: "TimerNotPending",
  TimerNotDue: "TimerNotDue",
  DeadlineOutOfRange: "DeadlineOutOfRange",
  HistoryRejected: "HistoryRejected",
  IncompleteBatch: "IncompleteBatch"
} as const

/**
 * A stable machine-readable external-fact failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ExternalEventErrorCode = typeof Codes[keyof typeof Codes]

const ExternalEventErrorCode = Schema.Literals([
  Codes.InvalidRunState,
  Codes.InvalidDurableHead,
  Codes.InvalidRequest,
  Codes.InvalidRecordedAt,
  Codes.TimestampRegression,
  Codes.SequenceOutOfRange,
  Codes.RunKeyMismatch,
  Codes.RunNotRunning,
  Codes.ActivityNotFound,
  Codes.AttemptMismatch,
  Codes.IllegalActivityTransition,
  Codes.TimerNotFound,
  Codes.TimerNotPending,
  Codes.TimerNotDue,
  Codes.DeadlineOutOfRange,
  Codes.HistoryRejected,
  Codes.IncompleteBatch
])

/**
 * Raised when privileged external input cannot be materialized safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class ExternalEventError extends Schema.TaggedErrorClass<ExternalEventError>(
  "@effect/workflow-builder/ExternalEventV2/ExternalEventError"
)("ExternalEventError", {
  operation: Operation,
  code: ExternalEventErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Detached events and the exact derived durable state produced by one
 * privileged operation.
 *
 * @category models
 * @since 4.0.0
 */
export interface MaterializedExternalEvents {
  readonly state: RunStateV2.RunState
  readonly events: ReadonlyArray<EventV2.Event>
}

type StrictDecoder<A> = (
  input: unknown
) => Result.Result<A, unknown>

interface Context {
  readonly operation: Operation
  readonly recordedAt: EventV2.Timestamp
  readonly events: Array<EventV2.Event>
  state: RunStateV2.RunState
}

const decodeRecordActivityStarted = Schema.decodeUnknownResult(
  RecordActivityStartedRequest,
  strictParseOptions
)
const decodeCompleteActivityAttempt = Schema.decodeUnknownResult(
  CompleteActivityAttemptRequest,
  strictParseOptions
)
const decodeFireTimer = Schema.decodeUnknownResult(
  FireTimerRequest,
  strictParseOptions
)
const decodeRequestCancellation = Schema.decodeUnknownResult(
  RequestCancellationRequest,
  strictParseOptions
)

const makeError = (
  operation: Operation,
  code: ExternalEventErrorCode,
  message: string,
  details?: Schema.Json
): ExternalEventError =>
  new ExternalEventError({
    operation,
    code,
    message,
    ...(details === undefined ? undefined : { details })
  })

const captureRequest = <A>(
  operation: Operation,
  input: unknown,
  decode: StrictDecoder<A>
): Result.Result<A, ExternalEventError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      operation,
      Codes.InvalidRequest,
      `External request must be strict JSON: ${snapshot.failure.message}`,
      {
        snapshotError: snapshot.failure.message,
        path: [...snapshot.failure.path]
      }
    ))
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = decode(snapshot.success)
  } catch {
    return Result.fail(makeError(
      operation,
      Codes.InvalidRequest,
      "External request schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(
      operation,
      Codes.InvalidRequest,
      "Invalid privileged external request",
      { parseError: String(decoded.failure) }
    ))
    : Result.succeed(snapshot.success as unknown as A)
}

const captureRecordedAt = (
  operation: Operation,
  input: unknown
): Result.Result<EventV2.Timestamp, ExternalEventError> => {
  const captured = SemanticTime.materializeDeadline(
    input as EventV2.Timestamp,
    0
  )
  return Result.isSuccess(captured)
    ? Result.succeed(captured.success)
    : Result.fail(makeError(
      operation,
      Codes.InvalidRecordedAt,
      "recordedAt must be one canonical, orderable protocol version 2 timestamp",
      {
        semanticTimeError: captured.failure._tag,
        message: captured.failure.message
      }
    ))
}

const captureState = (
  operation: Operation,
  state: RunStateV2.RunState
): Result.Result<RunStateV2.RunState, ExternalEventError> => {
  if (!RunStateV2.isDerived(state)) {
    return Result.fail(makeError(
      operation,
      Codes.InvalidRunState,
      "Run state must be an exact immutable value derived by RunStateV2"
    ))
  }
  const durable = RunStateV2.validateDurableHead(state)
  return Result.isFailure(durable)
    ? Result.fail(makeError(
      operation,
      Codes.InvalidDurableHead,
      `Input state is not a complete durable head: ${durable.failure.message}`,
      {
        historyCode: durable.failure.code,
        ...(durable.failure.details === undefined
          ? undefined
          : { historyDetails: durable.failure.details })
      }
    ))
    : Result.succeed(durable.success)
}

const context = (
  operation: Operation,
  inputState: RunStateV2.RunState,
  inputRecordedAt: unknown
): Result.Result<Context, ExternalEventError> => {
  const state = captureState(operation, inputState)
  if (Result.isFailure(state)) {
    return Result.fail(state.failure)
  }
  const recordedAt = captureRecordedAt(operation, inputRecordedAt)
  if (Result.isFailure(recordedAt)) {
    return Result.fail(recordedAt.failure)
  }
  const previousInstant = Date.parse(state.success.lastRecordedAt)
  const recordedInstant = Date.parse(recordedAt.success)
  if (
    !Number.isSafeInteger(previousInstant) ||
    !Number.isSafeInteger(recordedInstant) ||
    recordedInstant < previousInstant
  ) {
    return Result.fail(makeError(
      operation,
      Codes.TimestampRegression,
      "External fact recordedAt must not precede the durable head",
      {
        previousRecordedAt: state.success.lastRecordedAt,
        actualRecordedAt: recordedAt.success
      }
    ))
  }
  return Result.succeed({
    operation,
    state: state.success,
    recordedAt: recordedAt.success,
    events: []
  })
}

const validateKey = (
  operation: Operation,
  state: RunStateV2.RunState,
  key: PlanStoreV2.RunKey
): Result.Result<void, ExternalEventError> =>
  key.tenantId === state.tenantId && key.runId === state.runId
    ? Result.succeed(undefined)
    : Result.fail(makeError(
      operation,
      Codes.RunKeyMismatch,
      "External request key does not match the authoritative run",
      {
        expectedTenantId: state.tenantId,
        expectedRunId: state.runId,
        actualTenantId: key.tenantId,
        actualRunId: key.runId
      }
    ))

const requireRunning = (
  operation: Operation,
  state: RunStateV2.RunState
): Result.Result<void, ExternalEventError> =>
  state.status === "Running"
    ? Result.succeed(undefined)
    : Result.fail(makeError(
      operation,
      Codes.RunNotRunning,
      `External operation requires a running run, received '${state.status}'`,
      { runStatus: state.status }
    ))

const getActivity = (
  state: RunStateV2.RunState,
  logicalActivityId: string
): RunStateV2.ActivityState | undefined => {
  const found = HashMap.get(state.activities, logicalActivityId)
  return found._tag === "Some" ? found.value : undefined
}

const getTimer = (
  state: RunStateV2.RunState,
  timerId: string
): RunStateV2.TimerState | undefined => {
  const found = HashMap.get(state.timers, timerId)
  return found._tag === "Some" ? found.value : undefined
}

const getAttempt = (
  activity: RunStateV2.ActivityState,
  attempt: number
): RunStateV2.ActivityAttemptState | undefined => {
  const found = HashMap.get(activity.attempts, attempt)
  return found._tag === "Some" ? found.value : undefined
}

const historyError = (
  operation: Operation,
  error: RunStateV2.HistoryError,
  code: typeof Codes.HistoryRejected | typeof Codes.IncompleteBatch
): ExternalEventError =>
  makeError(
    operation,
    code,
    `Materialized external fact was rejected by protocol replay: ${error.message}`,
    {
      historyCode: error.code,
      ...(error.details === undefined
        ? undefined
        : { historyDetails: error.details })
    }
  )

const append = (
  current: Context,
  eventId: string,
  payload: EventV2.Payload,
  options: {
    readonly causationId?: string
    readonly correlationId?: string
  } = {}
): Result.Result<EventV2.Event, ExternalEventError> => {
  if (current.state.sequence >= Number.MAX_SAFE_INTEGER) {
    return Result.fail(makeError(
      current.operation,
      Codes.SequenceOutOfRange,
      "External fact would exceed the safe history-sequence range",
      { currentSequence: current.state.sequence }
    ))
  }
  const candidate = {
    eventVersion: EventV2.EventVersion,
    tenantId: current.state.tenantId,
    eventId,
    runId: current.state.runId,
    sequence: current.state.sequence + 1,
    recordedAt: current.recordedAt,
    ...(options.causationId === undefined
      ? undefined
      : { causationId: options.causationId }),
    ...(options.correlationId === undefined
      ? undefined
      : { correlationId: options.correlationId }),
    payload
  }
  const snapshot = Json.snapshot(candidate)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      current.operation,
      Codes.HistoryRejected,
      "Internally materialized external event is not strict JSON",
      {
        snapshotError: snapshot.failure.message,
        path: [...snapshot.failure.path]
      }
    ))
  }
  const event = snapshot.success as unknown as EventV2.Event
  const next = RunStateV2.reduce(current.state, event)
  if (Result.isFailure(next)) {
    return Result.fail(historyError(
      current.operation,
      next.failure,
      Codes.HistoryRejected
    ))
  }
  current.events.push(event)
  current.state = next.success
  return Result.succeed(event)
}

const finish = (
  current: Context
): Result.Result<MaterializedExternalEvents, ExternalEventError> => {
  const durable = RunStateV2.validateDurableHead(current.state)
  return Result.isFailure(durable)
    ? Result.fail(historyError(
      current.operation,
      durable.failure,
      Codes.IncompleteBatch
    ))
    : Result.succeed(Object.freeze({
      state: durable.success,
      events: Object.freeze([...current.events])
    }))
}

const materializeDeadline = (
  operation: Operation,
  anchor: EventV2.Timestamp,
  delayMillis: number
): Result.Result<EventV2.Timestamp, ExternalEventError> => {
  const deadline = SemanticTime.materializeDeadline(anchor, delayMillis)
  return Result.isSuccess(deadline)
    ? Result.succeed(deadline.success)
    : Result.fail(makeError(
      operation,
      deadline.failure._tag === "DeadlineOutOfRange"
        ? Codes.DeadlineOutOfRange
        : Codes.HistoryRejected,
      "Timer deadline cannot be materialized from the external fact",
      {
        semanticTimeError: deadline.failure._tag,
        message: deadline.failure.message
      }
    ))
}

const activityAttempt = (
  operation: Operation,
  state: RunStateV2.RunState,
  request: RecordActivityStartedRequest
): Result.Result<
  readonly [RunStateV2.ActivityState, RunStateV2.ActivityAttemptState],
  ExternalEventError
> => {
  const activity = getActivity(state, request.logicalActivityId)
  if (activity === undefined) {
    return Result.fail(makeError(
      operation,
      Codes.ActivityNotFound,
      `Logical activity '${request.logicalActivityId}' is not scheduled`,
      { logicalActivityId: request.logicalActivityId }
    ))
  }
  const attempt = getAttempt(activity, request.attempt)
  if (
    attempt === undefined ||
    activity.currentAttempt !== request.attempt ||
    activity.currentAttemptId !== request.attemptId ||
    attempt.attemptId !== request.attemptId
  ) {
    return Result.fail(makeError(
      operation,
      Codes.AttemptMismatch,
      "External activity fact does not identify the exact current semantic attempt",
      {
        logicalActivityId: activity.logicalActivityId,
        expectedAttemptId: activity.currentAttemptId,
        actualAttemptId: request.attemptId,
        expectedAttempt: activity.currentAttempt,
        actualAttempt: request.attempt
      }
    ))
  }
  return Result.succeed([activity, attempt])
}

const cancelTimer = (
  current: Context,
  timerId: string,
  reason: EventV2.TimerCancellationReason,
  causationId: string
): Result.Result<EventV2.Event, ExternalEventError> =>
  append(
    current,
    IdentityV2.cancelTimerCommandId(
      current.state.tenantId,
      current.state.runId,
      timerId
    ),
    {
      _tag: "TimerCancelled",
      timerId,
      reason
    },
    { causationId, correlationId: timerId }
  )

const textOrder = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const pendingTimers = (
  state: RunStateV2.RunState
): Array<RunStateV2.TimerState> =>
  Array.from(HashMap.values(state.timers))
    .filter((timer) => timer.status === "Pending")
    .sort((left, right) => textOrder(left.timerId, right.timerId))

const activityTimerBelongsTo = (
  timer: RunStateV2.TimerState,
  logicalActivityId: string
): boolean => {
  const purpose = timer.purpose
  switch (purpose._tag) {
    case "RetryBackoff":
    case "ScheduleToStart":
    case "StartToClose":
    case "ScheduleToClose":
      return purpose.logicalActivityId === logicalActivityId
    case "SignalExpiry":
    case "SignalWaitTimeout":
    case "Sleep":
      return false
  }
}

/**
 * Materializes a worker-start fact and every immediately required timer
 * transition.
 *
 * @category converting
 * @since 4.0.0
 */
export const recordActivityStarted = (
  initialState: RunStateV2.RunState,
  input: unknown,
  inputRecordedAt: unknown
): Result.Result<MaterializedExternalEvents, ExternalEventError> => {
  const operation = "recordActivityStarted"
  const request = captureRequest(
    operation,
    input,
    decodeRecordActivityStarted
  )
  if (Result.isFailure(request)) {
    return Result.fail(request.failure)
  }
  const current = context(operation, initialState, inputRecordedAt)
  if (Result.isFailure(current)) {
    return Result.fail(current.failure)
  }
  const key = validateKey(operation, current.success.state, request.success.key)
  if (Result.isFailure(key)) {
    return Result.fail(key.failure)
  }
  const running = requireRunning(operation, current.success.state)
  if (Result.isFailure(running)) {
    return Result.fail(running.failure)
  }
  const owner = activityAttempt(operation, current.success.state, request.success)
  if (Result.isFailure(owner)) {
    return Result.fail(owner.failure)
  }
  const [activity, attempt] = owner.success
  if (activity.status !== "Active" || attempt.status !== "Scheduled") {
    return Result.fail(makeError(
      operation,
      Codes.IllegalActivityTransition,
      "Only the exact currently scheduled attempt can start",
      {
        activityStatus: activity.status,
        attemptStatus: attempt.status
      }
    ))
  }

  const startedEventId = IdentityV2.activityAttemptStartedEventId(
    initialState.tenantId,
    initialState.runId,
    activity.nodeInstanceId,
    attempt.attempt
  )
  const started = append(
    current.success,
    startedEventId,
    {
      _tag: "ActivityAttemptStarted",
      logicalActivityId: activity.logicalActivityId,
      attemptId: attempt.attemptId,
      attempt: attempt.attempt
    },
    { correlationId: attempt.attemptId }
  )
  if (Result.isFailure(started)) {
    return Result.fail(started.failure)
  }

  if (activity.policy.timeouts.scheduleToStart._tag === "After") {
    const timerId = IdentityV2.timerId(
      initialState.tenantId,
      initialState.runId,
      "ScheduleToStart",
      attempt.attemptId
    )
    const cancelled = cancelTimer(
      current.success,
      timerId,
      "OwnerCompleted",
      startedEventId
    )
    if (Result.isFailure(cancelled)) {
      return Result.fail(cancelled.failure)
    }
  }

  if (activity.policy.timeouts.startToClose._tag === "After") {
    const timeout = activity.policy.timeouts.startToClose
    const timerId = IdentityV2.timerId(
      initialState.tenantId,
      initialState.runId,
      "StartToClose",
      attempt.attemptId
    )
    const deadline = materializeDeadline(
      operation,
      current.success.recordedAt,
      timeout.durationMillis
    )
    if (Result.isFailure(deadline)) {
      return Result.fail(deadline.failure)
    }
    const scheduled = append(
      current.success,
      IdentityV2.scheduleTimerCommandId(
        initialState.tenantId,
        initialState.runId,
        timerId
      ),
      {
        _tag: "TimerScheduled",
        timerId,
        purpose: {
          _tag: "StartToClose",
          logicalActivityId: activity.logicalActivityId,
          attemptId: attempt.attemptId,
          attempt: attempt.attempt
        },
        anchorEventId: startedEventId,
        delayMillis: timeout.durationMillis,
        deadline: deadline.success
      },
      { causationId: startedEventId, correlationId: attempt.attemptId }
    )
    if (Result.isFailure(scheduled)) {
      return Result.fail(scheduled.failure)
    }
  }
  return finish(current.success)
}

/**
 * Materializes one exact worker completion and required active-timeout
 * cleanup.
 *
 * @category converting
 * @since 4.0.0
 */
export const completeActivityAttempt = (
  initialState: RunStateV2.RunState,
  input: unknown,
  inputRecordedAt: unknown
): Result.Result<MaterializedExternalEvents, ExternalEventError> => {
  const operation = "completeActivityAttempt"
  const request = captureRequest(
    operation,
    input,
    decodeCompleteActivityAttempt
  )
  if (Result.isFailure(request)) {
    return Result.fail(request.failure)
  }
  const current = context(operation, initialState, inputRecordedAt)
  if (Result.isFailure(current)) {
    return Result.fail(current.failure)
  }
  const key = validateKey(operation, current.success.state, request.success.key)
  if (Result.isFailure(key)) {
    return Result.fail(key.failure)
  }
  const running = requireRunning(operation, current.success.state)
  if (Result.isFailure(running)) {
    return Result.fail(running.failure)
  }
  const owner = activityAttempt(operation, current.success.state, request.success)
  if (Result.isFailure(owner)) {
    return Result.fail(owner.failure)
  }
  const [activity, attempt] = owner.success
  if (activity.status !== "Active" || attempt.status !== "Started") {
    return Result.fail(makeError(
      operation,
      Codes.IllegalActivityTransition,
      "Only the exact currently started attempt can complete",
      {
        activityStatus: activity.status,
        attemptStatus: attempt.status
      }
    ))
  }

  const succeeded = request.success.completion._tag === "Succeeded"
  const completionEventId = succeeded
    ? IdentityV2.activitySucceededEventId(
      initialState.tenantId,
      initialState.runId,
      activity.nodeInstanceId,
      attempt.attempt
    )
    : IdentityV2.activityAttemptFailedEventId(
      initialState.tenantId,
      initialState.runId,
      activity.nodeInstanceId,
      attempt.attempt
    )
  const completionPayload: EventV2.Payload = succeeded
    ? {
      _tag: "ActivitySucceeded",
      logicalActivityId: activity.logicalActivityId,
      attemptId: attempt.attemptId,
      attempt: attempt.attempt,
      output: request.success.completion.output
    }
    : {
      _tag: "ActivityAttemptFailed",
      logicalActivityId: activity.logicalActivityId,
      attemptId: attempt.attemptId,
      attempt: attempt.attempt,
      failure: request.success.completion.failure
    }
  const completed = append(
    current.success,
    completionEventId,
    completionPayload,
    { correlationId: attempt.attemptId }
  )
  if (Result.isFailure(completed)) {
    return Result.fail(completed.failure)
  }

  if (activity.policy.timeouts.startToClose._tag === "After") {
    const timerId = IdentityV2.timerId(
      initialState.tenantId,
      initialState.runId,
      "StartToClose",
      attempt.attemptId
    )
    const cancelled = cancelTimer(
      current.success,
      timerId,
      succeeded ? "OwnerCompleted" : "OwnerFailed",
      completionEventId
    )
    if (Result.isFailure(cancelled)) {
      return Result.fail(cancelled.failure)
    }
  }
  if (
    succeeded &&
    activity.policy.timeouts.scheduleToClose._tag === "After"
  ) {
    const timerId = IdentityV2.timerId(
      initialState.tenantId,
      initialState.runId,
      "ScheduleToClose",
      activity.logicalActivityId
    )
    const cancelled = cancelTimer(
      current.success,
      timerId,
      "OwnerCompleted",
      completionEventId
    )
    if (Result.isFailure(cancelled)) {
      return Result.fail(cancelled.failure)
    }
  }
  return finish(current.success)
}

/**
 * Materializes one exact due timer fact and its store-owned timeout
 * consequences.
 *
 * @category converting
 * @since 4.0.0
 */
export const fireTimer = (
  initialState: RunStateV2.RunState,
  input: unknown,
  inputRecordedAt: unknown
): Result.Result<MaterializedExternalEvents, ExternalEventError> => {
  const operation = "fireTimer"
  const request = captureRequest(operation, input, decodeFireTimer)
  if (Result.isFailure(request)) {
    return Result.fail(request.failure)
  }
  const current = context(operation, initialState, inputRecordedAt)
  if (Result.isFailure(current)) {
    return Result.fail(current.failure)
  }
  const key = validateKey(operation, current.success.state, request.success.key)
  if (Result.isFailure(key)) {
    return Result.fail(key.failure)
  }
  const running = requireRunning(operation, current.success.state)
  if (Result.isFailure(running)) {
    return Result.fail(running.failure)
  }
  const timer = getTimer(current.success.state, request.success.timerId)
  if (timer === undefined) {
    return Result.fail(makeError(
      operation,
      Codes.TimerNotFound,
      `Timer '${request.success.timerId}' is not retained by the run`,
      { timerId: request.success.timerId }
    ))
  }
  if (timer.status !== "Pending") {
    return Result.fail(makeError(
      operation,
      Codes.TimerNotPending,
      `Timer '${timer.timerId}' is not pending`,
      { timerId: timer.timerId, timerStatus: timer.status }
    ))
  }
  const deadlineInstant = Date.parse(timer.deadline)
  const recordedInstant = Date.parse(current.success.recordedAt)
  if (
    !Number.isSafeInteger(deadlineInstant) ||
    !Number.isSafeInteger(recordedInstant) ||
    recordedInstant < deadlineInstant
  ) {
    return Result.fail(makeError(
      operation,
      Codes.TimerNotDue,
      `Timer '${timer.timerId}' cannot fire before its exact deadline`,
      {
        timerId: timer.timerId,
        deadline: timer.deadline,
        recordedAt: current.success.recordedAt
      }
    ))
  }

  const firedEventId = IdentityV2.timerFiredEventId(
    initialState.tenantId,
    initialState.runId,
    timer.timerId
  )
  const fired = append(
    current.success,
    firedEventId,
    {
      _tag: "TimerFired",
      timerId: timer.timerId
    },
    { correlationId: timer.timerId }
  )
  if (Result.isFailure(fired)) {
    return Result.fail(fired.failure)
  }

  const purpose = timer.purpose
  if (
    purpose._tag === "ScheduleToStart" ||
    purpose._tag === "StartToClose"
  ) {
    const activity = getActivity(
      current.success.state,
      purpose.logicalActivityId
    )
    if (activity === undefined) {
      return Result.fail(makeError(
        operation,
        Codes.ActivityNotFound,
        "Attempt timeout has no retained logical activity",
        { logicalActivityId: purpose.logicalActivityId }
      ))
    }
    const timedOut = append(
      current.success,
      IdentityV2.activityAttemptTimedOutEventId(
        initialState.tenantId,
        initialState.runId,
        activity.nodeInstanceId,
        purpose.attempt,
        purpose._tag
      ),
      {
        _tag: "ActivityAttemptTimedOut",
        logicalActivityId: purpose.logicalActivityId,
        attemptId: purpose.attemptId,
        attempt: purpose.attempt,
        timerId: timer.timerId,
        timeoutKind: purpose._tag
      },
      { causationId: firedEventId, correlationId: purpose.attemptId }
    )
    if (Result.isFailure(timedOut)) {
      return Result.fail(timedOut.failure)
    }
  } else if (purpose._tag === "ScheduleToClose") {
    const activity = getActivity(
      current.success.state,
      purpose.logicalActivityId
    )
    if (activity === undefined) {
      return Result.fail(makeError(
        operation,
        Codes.ActivityNotFound,
        "Schedule-to-close timeout has no retained logical activity",
        { logicalActivityId: purpose.logicalActivityId }
      ))
    }
    const failedEventId = IdentityV2.finalizeActivityFailureCommandId(
      initialState.tenantId,
      initialState.runId,
      activity.nodeInstanceId
    )
    const failed = append(
      current.success,
      failedEventId,
      {
        _tag: "ActivityFailed",
        logicalActivityId: activity.logicalActivityId,
        nodeId: activity.nodeId,
        nodeInstanceId: activity.nodeInstanceId,
        attemptId: activity.currentAttemptId,
        attempt: activity.currentAttempt,
        cause: {
          _tag: "ScheduleToCloseTimeout",
          timerId: timer.timerId
        }
      },
      {
        causationId: firedEventId,
        correlationId: activity.logicalActivityId
      }
    )
    if (Result.isFailure(failed)) {
      return Result.fail(failed.failure)
    }
    const siblings = pendingTimers(current.success.state).filter(
      (candidate) =>
        candidate.timerId !== timer.timerId &&
        activityTimerBelongsTo(candidate, activity.logicalActivityId)
    )
    for (const sibling of siblings) {
      const cancelled = cancelTimer(
        current.success,
        sibling.timerId,
        "Superseded",
        failedEventId
      )
      if (Result.isFailure(cancelled)) {
        return Result.fail(cancelled.failure)
      }
    }
  }
  return finish(current.success)
}

/**
 * Materializes cancellation intent and deterministic cleanup of every pending
 * semantic timer without terminally cancelling the run.
 *
 * @category converting
 * @since 4.0.0
 */
export const requestCancellation = (
  initialState: RunStateV2.RunState,
  input: unknown,
  inputRecordedAt: unknown
): Result.Result<MaterializedExternalEvents, ExternalEventError> => {
  const operation = "requestCancellation"
  const request = captureRequest(
    operation,
    input,
    decodeRequestCancellation
  )
  if (Result.isFailure(request)) {
    return Result.fail(request.failure)
  }
  const current = context(operation, initialState, inputRecordedAt)
  if (Result.isFailure(current)) {
    return Result.fail(current.failure)
  }
  const key = validateKey(operation, current.success.state, request.success.key)
  if (Result.isFailure(key)) {
    return Result.fail(key.failure)
  }
  const running = requireRunning(operation, current.success.state)
  if (Result.isFailure(running)) {
    return Result.fail(running.failure)
  }

  const cancellationEventId = IdentityV2.runCancellationRequestedEventId(
    initialState.tenantId,
    initialState.runId,
    request.success.requestId
  )
  const cancellation = append(
    current.success,
    cancellationEventId,
    {
      _tag: "RunCancellationRequested",
      requestId: request.success.requestId
    },
    { correlationId: request.success.requestId }
  )
  if (Result.isFailure(cancellation)) {
    return Result.fail(cancellation.failure)
  }
  const timers = pendingTimers(current.success.state)
  for (const timer of timers) {
    const cancelled = cancelTimer(
      current.success,
      timer.timerId,
      "RunCancellationRequested",
      cancellationEventId
    )
    if (Result.isFailure(cancelled)) {
      return Result.fail(cancelled.failure)
    }
  }
  return finish(current.success)
}
