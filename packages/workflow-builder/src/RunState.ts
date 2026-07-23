/**
 * Pure semantic-history replay for workflow runs.
 *
 * @since 4.0.0
 */
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Event from "./Event.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Stable machine-readable history validation codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidHistory: "InvalidHistory",
  EmptyHistory: "EmptyHistory",
  InvalidEvent: "InvalidEvent",
  NonCanonicalEventId: "NonCanonicalEventId",
  FirstEventNotRunStarted: "FirstEventNotRunStarted",
  DuplicateEventId: "DuplicateEventId",
  SequenceMismatch: "SequenceMismatch",
  RunIdMismatch: "RunIdMismatch",
  DuplicateRunStarted: "DuplicateRunStarted",
  ActivityAlreadyScheduled: "ActivityAlreadyScheduled",
  ActivityNotScheduled: "ActivityNotScheduled",
  ActivityAlreadyCompleted: "ActivityAlreadyCompleted",
  IllegalActivityTransition: "IllegalActivityTransition",
  IllegalRunTransition: "IllegalRunTransition",
  EventAfterTerminal: "EventAfterTerminal"
} as const

/**
 * A stable machine-readable history validation code.
 *
 * @category models
 * @since 4.0.0
 */
export type HistoryErrorCode = typeof Codes[keyof typeof Codes]

const HistoryErrorCode = Schema.Literals([
  Codes.InvalidHistory,
  Codes.EmptyHistory,
  Codes.InvalidEvent,
  Codes.NonCanonicalEventId,
  Codes.FirstEventNotRunStarted,
  Codes.DuplicateEventId,
  Codes.SequenceMismatch,
  Codes.RunIdMismatch,
  Codes.DuplicateRunStarted,
  Codes.ActivityAlreadyScheduled,
  Codes.ActivityNotScheduled,
  Codes.ActivityAlreadyCompleted,
  Codes.IllegalActivityTransition,
  Codes.IllegalRunTransition,
  Codes.EventAfterTerminal
])

/**
 * A typed failure produced when wire history cannot be replayed safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class HistoryError extends Schema.TaggedErrorClass<HistoryError>(
  "@effect/workflow-builder/RunState/HistoryError"
)("HistoryError", {
  code: HistoryErrorCode,
  message: Schema.NonEmptyString,
  historyIndex: Schema.optionalKey(NonNegativeInt),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Identity and scheduling data retained for every activity lifecycle.
 *
 * @category models
 * @since 4.0.0
 */
export interface ActivityStateBase {
  readonly activityId: string
  readonly nodeId: string
  readonly nodeInstanceId: string
  readonly attempt: number
  readonly idempotencyKey: string
  readonly input: Event.EncodedValues
  readonly scheduledAt: Event.Timestamp
}

/**
 * An activity for which execution intent was committed but no result was
 * recorded.
 *
 * @category models
 * @since 4.0.0
 */
export interface ScheduledActivityState extends ActivityStateBase {
  readonly status: "Scheduled"
}

/**
 * An activity with a committed encoded output.
 *
 * @category models
 * @since 4.0.0
 */
export interface SucceededActivityState extends ActivityStateBase {
  readonly status: "Succeeded"
  readonly output: Event.EncodedValues
  readonly completedAt: Event.Timestamp
}

/**
 * An activity with a committed encoded failure.
 *
 * @category models
 * @since 4.0.0
 */
export interface FailedActivityState extends ActivityStateBase {
  readonly status: "Failed"
  readonly failure: Schema.Json
  readonly completedAt: Event.Timestamp
}

/**
 * State derived for one activity from semantic history.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityState = ScheduledActivityState | SucceededActivityState | FailedActivityState

/**
 * Immutable run identity and pinned start data shared by every run status.
 *
 * @category models
 * @since 4.0.0
 */
export interface RunStateBase {
  readonly runId: string
  readonly sequence: number
  readonly startedAt: Event.Timestamp
  readonly planId: string
  readonly planRevision: number
  readonly definitionId: string
  readonly definitionVersion: string
  readonly compilerVersion: string
  readonly compiledFingerprint: string
  readonly backend: "direct" | "durable"
  readonly input: Event.EncodedValues
  readonly activities: HashMap.HashMap<string, ActivityState>
  readonly seenEventIds: HashSet.HashSet<string>
  readonly cancellationRequestedAt?: Event.Timestamp | undefined
}

/**
 * A live run that has not received a cancellation request.
 *
 * @category models
 * @since 4.0.0
 */
export interface RunningRunState extends RunStateBase {
  readonly status: "Running"
}

/**
 * A live run whose cancellation has been requested but not yet committed as
 * terminal.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancellationRequestedRunState extends RunStateBase {
  readonly status: "CancellationRequested"
  readonly cancellationRequestedAt: Event.Timestamp
}

/**
 * A successfully completed run with its encoded output.
 *
 * @category models
 * @since 4.0.0
 */
export interface SucceededRunState extends RunStateBase {
  readonly status: "Succeeded"
  readonly output: Event.EncodedValues
  readonly completedAt: Event.Timestamp
}

/**
 * A failed run with its encoded failure.
 *
 * @category models
 * @since 4.0.0
 */
export interface FailedRunState extends RunStateBase {
  readonly status: "Failed"
  readonly failure: Event.ActivityFailure
  readonly completedAt: Event.Timestamp
}

/**
 * A terminally cancelled run.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancelledRunState extends RunStateBase {
  readonly status: "Cancelled"
  readonly cancellationRequestedAt: Event.Timestamp
  readonly completedAt: Event.Timestamp
}

/**
 * Immutable state rebuilt exclusively from ordered semantic history.
 *
 * @category models
 * @since 4.0.0
 */
export type RunState =
  | RunningRunState
  | CancellationRequestedRunState
  | SucceededRunState
  | FailedRunState
  | CancelledRunState

const decodeEvent = Schema.decodeUnknownResult(Event.Event, {
  errors: "all",
  onExcessProperty: "error"
})

const makeError = (
  code: HistoryErrorCode,
  message: string,
  historyIndex?: number,
  details?: Schema.Json
): HistoryError =>
  new HistoryError({
    code,
    message,
    ...(historyIndex === undefined ? undefined : { historyIndex }),
    ...(details === undefined ? undefined : { details })
  })

const isTerminal = (state: RunState): state is SucceededRunState | FailedRunState | CancelledRunState =>
  state.status === "Succeeded" || state.status === "Failed" || state.status === "Cancelled"

const hasActivity = (state: RunState, activityId: string): boolean => HashMap.has(state.activities, activityId)

const hasEventId = (state: RunState, eventId: string): boolean => HashSet.has(state.seenEventIds, eventId)

const appendEventId = (
  state: RunState,
  eventId: string
): HashSet.HashSet<string> => HashSet.add(state.seenEventIds, eventId)

const expectedEngineEventId = (event: Event.Event): string | undefined => {
  const payload = event.payload
  switch (payload._tag) {
    case "RunStarted":
      return Identity.runStartedEventId(event.runId)
    case "ActivityScheduled":
      return Identity.scheduleActivityCommandId(
        event.runId,
        payload.nodeInstanceId,
        payload.attempt
      )
    case "ActivitySucceeded":
      return Identity.activitySucceededEventId(payload.activityId)
    case "ActivityFailed":
      return Identity.activityFailedEventId(payload.activityId)
    case "RunSucceeded":
      return Identity.succeedRunCommandId(event.runId)
    case "RunFailed":
      return Identity.failRunCommandId(event.runId)
    case "RunCancelled":
      return Identity.cancelRunCommandId(event.runId)
    case "RunCancellationRequested":
      return undefined
  }
}

const validateEngineEventId = (
  event: Event.Event,
  historyIndex: number
): HistoryError | undefined => {
  const expectedEventId = expectedEngineEventId(event)
  return expectedEventId === undefined || event.eventId === expectedEventId
    ? undefined
    : makeError(
      Codes.NonCanonicalEventId,
      `Event '${event.payload._tag}' has a noncanonical engine event id`,
      historyIndex,
      {
        eventTag: event.payload._tag,
        expectedEventId,
        actualEventId: event.eventId
      }
    )
}

const replaceActivity = (
  state: RunState,
  activity: ActivityState
): HashMap.HashMap<string, ActivityState> => HashMap.set(state.activities, activity.activityId, Object.freeze(activity))

const decodeSnapshotEvent = (
  input: unknown,
  historyIndex?: number
): Result.Result<Event.Event, HistoryError> => {
  let decoded: ReturnType<typeof decodeEvent>
  try {
    decoded = decodeEvent(input)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidEvent,
      "Event schema validation threw unexpectedly",
      historyIndex
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(
      Codes.InvalidEvent,
      decoded.failure.message,
      historyIndex
    ))
    : Result.succeed(input as Event.Event)
}

const invalidEvent = (
  input: unknown,
  historyIndex?: number
): Result.Result<Event.Event, HistoryError> => {
  const snapped = Json.snapshot(input)
  return Result.isFailure(snapped)
    ? Result.fail(makeError(Codes.InvalidEvent, snapped.failure.message, historyIndex))
    : decodeSnapshotEvent(snapped.success, historyIndex)
}

const initialState = (
  event: Event.Event
): RunningRunState => {
  const payload = event.payload as Event.RunStarted
  return Object.freeze({
    runId: event.runId,
    status: "Running",
    sequence: event.sequence,
    startedAt: event.recordedAt,
    planId: payload.planId,
    planRevision: payload.planRevision,
    definitionId: payload.definitionId,
    definitionVersion: payload.definitionVersion,
    compilerVersion: payload.compilerVersion,
    compiledFingerprint: payload.compiledFingerprint,
    backend: payload.backend,
    input: payload.input,
    activities: HashMap.empty(),
    seenEventIds: HashSet.make(event.eventId)
  })
}

const apply = (
  state: RunState,
  event: Event.Event,
  historyIndex: number
): Result.Result<RunState, HistoryError> => {
  if (isTerminal(state)) {
    return Result.fail(makeError(
      Codes.EventAfterTerminal,
      `Event '${event.payload._tag}' follows terminal run status '${state.status}'`,
      historyIndex,
      { status: state.status, eventTag: event.payload._tag }
    ))
  }
  if (
    event.payload._tag === "RunStarted" &&
    event.sequence === state.sequence + 1 &&
    event.runId === state.runId
  ) {
    const identityError = validateEngineEventId(event, historyIndex)
    return identityError === undefined
      ? Result.fail(makeError(
        Codes.DuplicateRunStarted,
        "RunStarted may only be the first history event",
        historyIndex
      ))
      : Result.fail(identityError)
  }
  if (hasEventId(state, event.eventId)) {
    return Result.fail(makeError(
      Codes.DuplicateEventId,
      `Event id '${event.eventId}' already exists in this run's history`,
      historyIndex,
      { eventId: event.eventId }
    ))
  }
  const expectedSequence = state.sequence + 1
  if (event.sequence !== expectedSequence) {
    return Result.fail(makeError(
      Codes.SequenceMismatch,
      `Expected history sequence ${expectedSequence} but received ${event.sequence}`,
      historyIndex,
      { expected: expectedSequence, actual: event.sequence }
    ))
  }
  if (event.runId !== state.runId) {
    return Result.fail(makeError(
      Codes.RunIdMismatch,
      `Expected run id '${state.runId}' but received '${event.runId}'`,
      historyIndex,
      { expected: state.runId, actual: event.runId }
    ))
  }
  const identityError = validateEngineEventId(event, historyIndex)
  if (identityError !== undefined) {
    return Result.fail(identityError)
  }
  const payload = event.payload
  if (
    state.status === "CancellationRequested" &&
    (payload._tag === "RunSucceeded" || payload._tag === "RunFailed")
  ) {
    return Result.fail(makeError(
      Codes.IllegalRunTransition,
      `Cancellation-requested runs may only terminate with RunCancelled, received '${payload._tag}'`,
      historyIndex,
      { status: state.status, eventTag: payload._tag }
    ))
  }
  switch (payload._tag) {
    case "RunStarted": {
      return Result.fail(makeError(
        Codes.DuplicateRunStarted,
        "RunStarted may only be the first history event",
        historyIndex
      ))
    }
    case "ActivityScheduled": {
      if (state.status !== "Running") {
        return Result.fail(makeError(
          Codes.IllegalActivityTransition,
          `Cannot schedule activity '${payload.activityId}' after cancellation was requested`,
          historyIndex,
          { activityId: payload.activityId, status: state.status }
        ))
      }
      if (hasActivity(state, payload.activityId)) {
        return Result.fail(makeError(
          Codes.ActivityAlreadyScheduled,
          `Activity '${payload.activityId}' was already scheduled`,
          historyIndex,
          { activityId: payload.activityId }
        ))
      }
      const activity: ScheduledActivityState = {
        status: "Scheduled",
        activityId: payload.activityId,
        nodeId: payload.nodeId,
        nodeInstanceId: payload.nodeInstanceId,
        attempt: payload.attempt,
        idempotencyKey: payload.idempotencyKey,
        input: payload.input,
        scheduledAt: event.recordedAt
      }
      return Result.succeed(Object.freeze({
        ...state,
        sequence: event.sequence,
        activities: replaceActivity(state, activity),
        seenEventIds: appendEventId(state, event.eventId)
      }))
    }
    case "ActivitySucceeded":
    case "ActivityFailed": {
      if (state.status !== "Running") {
        return Result.fail(makeError(
          Codes.IllegalActivityTransition,
          `Cannot complete activity '${payload.activityId}' after cancellation was requested`,
          historyIndex,
          { activityId: payload.activityId, status: state.status }
        ))
      }
      if (!hasActivity(state, payload.activityId)) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Activity '${payload.activityId}' completed before it was scheduled`,
          historyIndex,
          { activityId: payload.activityId }
        ))
      }
      const current = HashMap.getUnsafe(state.activities, payload.activityId)
      if (current.status !== "Scheduled") {
        return Result.fail(makeError(
          Codes.ActivityAlreadyCompleted,
          `Activity '${payload.activityId}' already completed with status '${current.status}'`,
          historyIndex,
          { activityId: payload.activityId, status: current.status }
        ))
      }
      const activity: ActivityState = payload._tag === "ActivitySucceeded"
        ? {
          ...current,
          status: "Succeeded",
          output: payload.output,
          completedAt: event.recordedAt
        }
        : {
          ...current,
          status: "Failed",
          failure: payload.failure,
          completedAt: event.recordedAt
        }
      return Result.succeed(Object.freeze({
        ...state,
        sequence: event.sequence,
        activities: replaceActivity(state, activity),
        seenEventIds: appendEventId(state, event.eventId)
      }))
    }
    case "RunCancellationRequested": {
      if (state.status !== "Running") {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          "Cancellation was already requested for this run",
          historyIndex,
          { status: state.status }
        ))
      }
      return Result.succeed(Object.freeze({
        ...state,
        status: "CancellationRequested",
        sequence: event.sequence,
        cancellationRequestedAt: event.recordedAt,
        seenEventIds: appendEventId(state, event.eventId)
      }))
    }
    case "RunSucceeded": {
      const incomplete = Array.from(HashMap.values(state.activities)).find((activity) =>
        activity.status !== "Succeeded"
      )
      if (incomplete !== undefined) {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          `Run cannot succeed while activity '${incomplete.activityId}' has status '${incomplete.status}'`,
          historyIndex,
          { activityId: incomplete.activityId, activityStatus: incomplete.status }
        ))
      }
      return Result.succeed(Object.freeze({
        ...state,
        status: "Succeeded",
        sequence: event.sequence,
        output: payload.output,
        completedAt: event.recordedAt,
        seenEventIds: appendEventId(state, event.eventId)
      }))
    }
    case "RunFailed": {
      const failed = HashMap.get(state.activities, payload.failure.activityId)
      if (failed._tag === "None") {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          `Run failure refers to unknown activity '${payload.failure.activityId}'`,
          historyIndex,
          { activityId: payload.failure.activityId }
        ))
      }
      const activity = failed.value
      if (
        activity.status !== "Failed" ||
        activity.nodeId !== payload.failure.nodeId ||
        activity.nodeInstanceId !== payload.failure.nodeInstanceId ||
        activity.attempt !== payload.failure.attempt ||
        Json.canonicalizeSnapshot(activity.failure) !==
          Json.canonicalizeSnapshot(payload.failure.failure)
      ) {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          `Run failure does not match failed activity '${payload.failure.activityId}'`,
          historyIndex,
          {
            activityId: payload.failure.activityId,
            activityStatus: activity.status
          }
        ))
      }
      return Result.succeed(Object.freeze({
        ...state,
        status: "Failed",
        sequence: event.sequence,
        failure: payload.failure,
        completedAt: event.recordedAt,
        seenEventIds: appendEventId(state, event.eventId)
      }))
    }
    case "RunCancelled": {
      if (state.status !== "CancellationRequested") {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          "RunCancelled requires a preceding RunCancellationRequested event",
          historyIndex,
          { status: state.status }
        ))
      }
      return Result.succeed(Object.freeze({
        ...state,
        status: "Cancelled",
        sequence: event.sequence,
        completedAt: event.recordedAt,
        seenEventIds: appendEventId(state, event.eventId)
      }))
    }
  }
}

/**
 * Applies one unknown wire event to an existing immutable state.
 *
 * **Details**
 *
 * The event is schema-decoded before any transition is considered. Sequence,
 * run identity, activity lifecycle, cancellation, and terminal invariants fail
 * closed with {@link HistoryError}.
 *
 * @category folding
 * @since 4.0.0
 */
export const reduce = (
  state: RunState,
  event: unknown
): Result.Result<RunState, HistoryError> => {
  const decoded = invalidEvent(event, state.sequence + 1)
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure)
    : apply(state, decoded.success, state.sequence + 1)
}

/**
 * Rebuilds immutable run state from a complete unknown wire history.
 *
 * **Details**
 *
 * Complete histories start with `RunStarted` at sequence `0`; every following
 * event must use the same run id and the exact next sequence.
 *
 * @category folding
 * @since 4.0.0
 */
export const fold = (
  history: unknown
): Result.Result<RunState, HistoryError> => {
  const snapped = Json.snapshot(history)
  if (Result.isFailure(snapped)) {
    const firstPath = snapped.failure.path[0]
    return typeof firstPath === "number"
      ? Result.fail(makeError(Codes.InvalidEvent, snapped.failure.message, firstPath))
      : Result.fail(makeError(Codes.InvalidHistory, snapped.failure.message))
  }
  const snapshot = snapped.success
  if (!Array.isArray(snapshot)) {
    return Result.fail(makeError(
      Codes.InvalidHistory,
      "Workflow history must be an array"
    ))
  }
  if (snapshot.length === 0) {
    return Result.fail(makeError(
      Codes.EmptyHistory,
      "Workflow history must contain a RunStarted event"
    ))
  }

  const first = decodeSnapshotEvent(snapshot[0], 0)
  if (Result.isFailure(first)) {
    return Result.fail(first.failure)
  }
  if (first.success.payload._tag !== "RunStarted") {
    return Result.fail(makeError(
      Codes.FirstEventNotRunStarted,
      `First history event must be RunStarted, received '${first.success.payload._tag}'`,
      0,
      { eventTag: first.success.payload._tag }
    ))
  }
  if (first.success.sequence !== 0) {
    return Result.fail(makeError(
      Codes.SequenceMismatch,
      `Expected first history sequence 0 but received ${first.success.sequence}`,
      0,
      { expected: 0, actual: first.success.sequence }
    ))
  }
  const identityError = validateEngineEventId(first.success, 0)
  if (identityError !== undefined) {
    return Result.fail(identityError)
  }

  let state: RunState = initialState(first.success)
  for (let index = 1; index < snapshot.length; index++) {
    const decoded = decodeSnapshotEvent(snapshot[index], index)
    if (Result.isFailure(decoded)) {
      return Result.fail(decoded.failure)
    }
    const next = apply(state, decoded.success, index)
    if (Result.isFailure(next)) {
      return Result.fail(next.failure)
    }
    state = next.success
  }
  return Result.succeed(state)
}
