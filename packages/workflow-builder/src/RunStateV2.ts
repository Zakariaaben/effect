/**
 * Pure protocol version 2 semantic-history replay.
 *
 * **Details**
 *
 * Replay consumes descriptor-safe JSON snapshots and derives immutable state.
 * It never reads a clock, performs an Effect, or treats operational activity
 * delivery as a semantic attempt.
 *
 * @since 4.0.0
 */
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Event from "./EventV2.ts"
import * as Identity from "./IdentityV2.ts"
import * as Json from "./internal/json.ts"
import * as SemanticTime from "./SemanticTime.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const
const derivedStates = new WeakSet<object>()
const deeplyFrozenObjects = new WeakSet<object>()

const deepFreeze = <A>(root: A): A => {
  if (typeof root !== "object" || root === null) {
    return root
  }
  const seen = new WeakSet<object>()
  const objects: Array<object> = []
  const pending: Array<object> = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (deeplyFrozenObjects.has(current) || seen.has(current)) {
      continue
    }
    seen.add(current)
    objects.push(current)
    const keys = Reflect.ownKeys(current)
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key)!
      if (
        Object.prototype.hasOwnProperty.call(descriptor, "value") &&
        typeof descriptor.value === "object" &&
        descriptor.value !== null
      ) {
        pending.push(descriptor.value)
      }
    }
  }
  for (let index = objects.length - 1; index >= 0; index--) {
    const current = objects[index]!
    Object.freeze(current)
    deeplyFrozenObjects.add(current)
  }
  return root
}

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Stable machine-readable protocol version 2 history validation codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidHistory: "InvalidHistory",
  InvalidState: "InvalidState",
  EmptyHistory: "EmptyHistory",
  InvalidEvent: "InvalidEvent",
  FirstEventNotRunStarted: "FirstEventNotRunStarted",
  DuplicateRunStarted: "DuplicateRunStarted",
  DuplicateEventId: "DuplicateEventId",
  NonCanonicalEventId: "NonCanonicalEventId",
  SequenceMismatch: "SequenceMismatch",
  TimestampRegression: "TimestampRegression",
  TenantIdMismatch: "TenantIdMismatch",
  RunIdMismatch: "RunIdMismatch",
  EventAfterTerminal: "EventAfterTerminal",
  ActivityIdentityMismatch: "ActivityIdentityMismatch",
  ActivityAlreadyScheduled: "ActivityAlreadyScheduled",
  ActivityNotScheduled: "ActivityNotScheduled",
  AttemptMismatch: "AttemptMismatch",
  IllegalAttemptTransition: "IllegalAttemptTransition",
  RetryNotAllowed: "RetryNotAllowed",
  RetryMismatch: "RetryMismatch",
  FinalFailureMismatch: "FinalFailureMismatch",
  TimerAlreadyScheduled: "TimerAlreadyScheduled",
  TimerNotScheduled: "TimerNotScheduled",
  TimerAnchorNotFound: "TimerAnchorNotFound",
  TimerDeadlineMismatch: "TimerDeadlineMismatch",
  TimerOwnershipMismatch: "TimerOwnershipMismatch",
  IllegalTimerTransition: "IllegalTimerTransition",
  SleepIdentityMismatch: "SleepIdentityMismatch",
  SleepNotFound: "SleepNotFound",
  IllegalSleepTransition: "IllegalSleepTransition",
  DuplicateSignal: "DuplicateSignal",
  InboxSequenceMismatch: "InboxSequenceMismatch",
  SignalNotFound: "SignalNotFound",
  SignalAccountingMismatch: "SignalAccountingMismatch",
  IncompleteSemanticPairing: "IncompleteSemanticPairing",
  DuplicateSignalWait: "DuplicateSignalWait",
  SignalWaitNotFound: "SignalWaitNotFound",
  SignalMatchMismatch: "SignalMatchMismatch",
  SignalOrderMismatch: "SignalOrderMismatch",
  IllegalSignalTransition: "IllegalSignalTransition",
  IllegalCancellationTransition: "IllegalCancellationTransition",
  IllegalRunTransition: "IllegalRunTransition"
} as const

/**
 * A stable machine-readable protocol version 2 history validation code.
 *
 * @category models
 * @since 4.0.0
 */
export type HistoryErrorCode = typeof Codes[keyof typeof Codes]

const HistoryErrorCode = Schema.Literals([
  Codes.InvalidHistory,
  Codes.InvalidState,
  Codes.EmptyHistory,
  Codes.InvalidEvent,
  Codes.FirstEventNotRunStarted,
  Codes.DuplicateRunStarted,
  Codes.DuplicateEventId,
  Codes.NonCanonicalEventId,
  Codes.SequenceMismatch,
  Codes.TimestampRegression,
  Codes.TenantIdMismatch,
  Codes.RunIdMismatch,
  Codes.EventAfterTerminal,
  Codes.ActivityIdentityMismatch,
  Codes.ActivityAlreadyScheduled,
  Codes.ActivityNotScheduled,
  Codes.AttemptMismatch,
  Codes.IllegalAttemptTransition,
  Codes.RetryNotAllowed,
  Codes.RetryMismatch,
  Codes.FinalFailureMismatch,
  Codes.TimerAlreadyScheduled,
  Codes.TimerNotScheduled,
  Codes.TimerAnchorNotFound,
  Codes.TimerDeadlineMismatch,
  Codes.TimerOwnershipMismatch,
  Codes.IllegalTimerTransition,
  Codes.SleepIdentityMismatch,
  Codes.SleepNotFound,
  Codes.IllegalSleepTransition,
  Codes.DuplicateSignal,
  Codes.InboxSequenceMismatch,
  Codes.SignalNotFound,
  Codes.SignalAccountingMismatch,
  Codes.IncompleteSemanticPairing,
  Codes.DuplicateSignalWait,
  Codes.SignalWaitNotFound,
  Codes.SignalMatchMismatch,
  Codes.SignalOrderMismatch,
  Codes.IllegalSignalTransition,
  Codes.IllegalCancellationTransition,
  Codes.IllegalRunTransition
])

/**
 * A typed failure produced when version 2 history cannot be replayed safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class HistoryError extends Schema.TaggedErrorClass<HistoryError>(
  "@effect/workflow-builder/RunStateV2/HistoryError"
)("HistoryError", {
  code: HistoryErrorCode,
  message: Schema.NonEmptyString,
  historyIndex: Schema.optionalKey(NonNegativeSafeInt),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Derived lifecycle status of one semantic activity attempt.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityAttemptStatus =
  | "Scheduled"
  | "Started"
  | "Failed"
  | "TimedOut"
  | "Succeeded"

/**
 * Immutable state derived for one semantic activity attempt.
 *
 * @category models
 * @since 4.0.0
 */
export interface ActivityAttemptState {
  readonly attemptId: string
  readonly attempt: number
  readonly status: ActivityAttemptStatus
  readonly scheduledEventId: string
  readonly scheduledAt: Event.Timestamp
  readonly startedEventId?: string | undefined
  readonly startedAt?: Event.Timestamp | undefined
  readonly completedEventId?: string | undefined
  readonly completedAt?: Event.Timestamp | undefined
  readonly failure?: Schema.Json | undefined
  readonly timeoutKind?: Event.ActivityAttemptTimeoutKind | undefined
  readonly timerId?: string | undefined
  readonly output?: Event.EncodedValues | undefined
}

/**
 * Derived lifecycle status of one logical activity.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityStatus = "Active" | "RetryPending" | "Succeeded" | "Failed"

/**
 * Immutable state derived for one logical activity and all semantic attempts.
 *
 * @category models
 * @since 4.0.0
 */
export interface ActivityState {
  readonly logicalActivityId: string
  readonly nodeId: string
  readonly nodeInstanceId: string
  readonly idempotencyKey: string
  readonly input: Event.EncodedValues
  readonly policy: Event.ActivityScheduled["policy"]
  readonly status: ActivityStatus
  readonly currentAttempt: number
  readonly currentAttemptId: string
  readonly attempts: HashMap.HashMap<number, ActivityAttemptState>
  readonly firstScheduledEventId: string
  readonly scheduledAt: Event.Timestamp
  readonly pendingRetryId?: string | undefined
  readonly output?: Event.EncodedValues | undefined
  readonly finalCause?: Event.ActivityFailureCause | undefined
  readonly completedAt?: Event.Timestamp | undefined
}

/**
 * Derived lifecycle status of one semantic retry.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryStatus = "WaitingForTimer" | "Ready" | "Consumed"

/**
 * Immutable state derived for one committed semantic retry.
 *
 * @category models
 * @since 4.0.0
 */
export interface RetryState {
  readonly retryId: string
  readonly logicalActivityId: string
  readonly failedAttemptId: string
  readonly failedAttempt: number
  readonly nextAttempt: number
  readonly timerId: string
  readonly selectedDelayMillis: number
  readonly deadline: Event.Timestamp
  readonly anchorEventId: string
  readonly scheduledEventId: string
  readonly scheduledAt: Event.Timestamp
  readonly status: RetryStatus
  readonly consumedAt?: Event.Timestamp | undefined
}

/**
 * Derived lifecycle status of one semantic timer.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerStatus = "Pending" | "Fired" | "Cancelled"

/**
 * Immutable state derived for one semantic timer.
 *
 * @category models
 * @since 4.0.0
 */
export interface TimerState {
  readonly timerId: string
  readonly purpose: Event.TimerPurpose
  readonly anchorEventId: string
  readonly delayMillis: number
  readonly deadline: Event.Timestamp
  readonly status: TimerStatus
  readonly scheduledEventId: string
  readonly scheduledAt: Event.Timestamp
  readonly firedAt?: Event.Timestamp | undefined
  readonly cancelledAt?: Event.Timestamp | undefined
  readonly cancellationReason?: Event.TimerCancellationReason | undefined
}

/**
 * Derived lifecycle status of one accepted signal.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalStatus = "Pending" | "Consumed" | "Expired" | "Discarded"

/**
 * Immutable state derived for one accepted signal.
 *
 * @category models
 * @since 4.0.0
 */
export interface SignalState {
  readonly signalId: string
  readonly inboxSequence: number
  readonly signalName: string
  readonly signalVersion: string
  readonly correlation: Event.SignalCorrelation
  readonly signalDefinitionDigest: Event.SignalAccepted["signalDefinitionDigest"]
  readonly requestDigest: Event.SignalAccepted["requestDigest"]
  readonly payload: Event.SignalAccepted["payload"]
  readonly payloadDigest: Event.SignalAccepted["payloadDigest"]
  readonly encodedPayloadBytes: number
  readonly ttlMillis: number
  readonly admission: Event.SignalAccepted["admission"]
  readonly expiresAt: Event.Timestamp
  readonly expiryTimerId: string
  readonly status: SignalStatus
  readonly acceptedEventId: string
  readonly acceptedAt: Event.Timestamp
  readonly waitId?: string | undefined
  readonly consumedAt?: Event.Timestamp | undefined
  readonly expiredAt?: Event.Timestamp | undefined
  readonly discardedAt?: Event.Timestamp | undefined
}

/**
 * Derived lifecycle status of one durable signal wait.
 *
 * @category models
 * @since 4.0.0
 */
export type SignalWaitStatus = "Pending" | "Consumed" | "TimedOut" | "Cancelled"

/**
 * Immutable state derived for one durable signal wait.
 *
 * @category models
 * @since 4.0.0
 */
export interface SignalWaitState {
  readonly waitId: string
  readonly nodeId: string
  readonly nodeInstanceId: string
  readonly signalName: string
  readonly signalVersion: string
  readonly correlation: Event.SignalCorrelation
  readonly timeout: Event.SignalWaitStarted["timeout"]
  readonly status: SignalWaitStatus
  readonly startedEventId: string
  readonly startedAt: Event.Timestamp
  readonly signalId?: string | undefined
  readonly inboxSequence?: number | undefined
  readonly timerId?: string | undefined
  readonly completedAt?: Event.Timestamp | undefined
}

/**
 * Derived lifecycle status of one durable sleep.
 *
 * @category models
 * @since 4.0.0
 */
export type SleepStatus = "Pending" | "Completed" | "Cancelled"

/**
 * Immutable state derived for one durable sleep owner.
 *
 * @category models
 * @since 4.0.0
 */
export interface SleepState {
  readonly waitId: string
  readonly nodeId: string
  readonly nodeInstanceId: string
  readonly durationMillis: number
  readonly status: SleepStatus
  readonly startedEventId: string
  readonly startedAt: Event.Timestamp
  readonly timerId?: string | undefined
  readonly completedAt?: Event.Timestamp | undefined
}

/**
 * Minimal retained metadata for validating event anchors and chronology.
 *
 * @category models
 * @since 4.0.0
 */
export interface EventMetadata {
  readonly eventId: string
  readonly sequence: number
  readonly recordedAt: Event.Timestamp
  readonly payloadTag: Event.Payload["_tag"]
}

/**
 * The timer fact that must immediately follow a durable owner fact in the
 * same storage-atomic batch.
 *
 * @category models
 * @since 4.0.0
 */
export interface TimerPairingObligation {
  readonly owner: "SignalAccepted" | "SignalWaitStarted" | "SleepStarted"
  readonly ownerEventId: string
  readonly timerId: string
}

/**
 * Immutable run identity and derived collections shared by every run status.
 *
 * @category models
 * @since 4.0.0
 */
export interface RunStateBase {
  readonly executionProtocolVersion: 2
  readonly tenantId: string
  readonly runId: string
  readonly sequence: number
  readonly lastRecordedAt: Event.Timestamp
  readonly startedAt: Event.Timestamp
  readonly planId: string
  readonly planRevision: number
  readonly definitionId: string
  readonly definitionVersion: string
  readonly compilerVersion: string
  readonly compiledFingerprint: Event.RunStarted["compiledFingerprint"]
  readonly artifactVersion: 2
  readonly artifactDigest: Event.RunStarted["artifactDigest"]
  readonly workflowIdentity: string
  readonly startRequestId: string
  readonly backend: "direct" | "durable"
  readonly input: Event.EncodedValues
  readonly activities: HashMap.HashMap<string, ActivityState>
  readonly retries: HashMap.HashMap<string, RetryState>
  readonly timers: HashMap.HashMap<string, TimerState>
  readonly signals: HashMap.HashMap<string, SignalState>
  readonly signalWaits: HashMap.HashMap<string, SignalWaitState>
  readonly sleeps: HashMap.HashMap<string, SleepState>
  readonly nextInboxSequence: number
  readonly acceptedSignalCount: number
  readonly pendingSignalCount: number
  readonly pendingSignalEncodedBytes: number
  readonly seenEventIds: HashSet.HashSet<string>
  readonly eventsById: HashMap.HashMap<string, EventMetadata>
  readonly pendingTimerPairing?: TimerPairingObligation | undefined
  readonly cancellationRequestId?: string | undefined
  readonly cancellationRequestedAt?: Event.Timestamp | undefined
}

/**
 * A live protocol version 2 run.
 *
 * @category models
 * @since 4.0.0
 */
export interface RunningRunState extends RunStateBase {
  readonly status: "Running"
}

/**
 * A live run for which cancellation has been requested.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancellationRequestedRunState extends RunStateBase {
  readonly status: "CancellationRequested"
  readonly cancellationRequestId: string
  readonly cancellationRequestedAt: Event.Timestamp
}

/**
 * A successfully completed protocol version 2 run.
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
 * A failed protocol version 2 run.
 *
 * @category models
 * @since 4.0.0
 */
export interface FailedRunState extends RunStateBase {
  readonly status: "Failed"
  readonly failure: Event.RunFailureCause
  readonly completedAt: Event.Timestamp
}

/**
 * A terminally cancelled protocol version 2 run.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancelledRunState extends RunStateBase {
  readonly status: "Cancelled"
  readonly cancellationRequestId: string
  readonly cancellationRequestedAt: Event.Timestamp
  readonly completedAt: Event.Timestamp
}

/**
 * Immutable state rebuilt exclusively from protocol version 2 history.
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

/**
 * Tests whether a state is an exact immutable value derived by this reducer.
 *
 * **Details**
 *
 * The marker is retained out of band. Structural copies and values obtained by
 * reducing a forged state cannot acquire reducer authority merely by matching
 * the public interface.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDerived = (state: unknown): state is RunState =>
  typeof state === "object" &&
  state !== null &&
  derivedStates.has(state) &&
  deeplyFrozenObjects.has(state)

const decodeEvent = Schema.decodeUnknownResult(Event.Event, strictParseOptions)

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

const isTerminal = (
  state: RunState
): state is SucceededRunState | FailedRunState | CancelledRunState =>
  state.status === "Succeeded" || state.status === "Failed" || state.status === "Cancelled"

const metadata = (event: Event.Event): EventMetadata =>
  Object.freeze({
    eventId: event.eventId,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
    payloadTag: event.payload._tag
  })

const commit = (
  state: RunState,
  event: Event.Event,
  changes: Readonly<Record<string, unknown>> = {}
): RunState => {
  const next = deepFreeze({
    ...state,
    ...changes,
    sequence: event.sequence,
    lastRecordedAt: event.recordedAt,
    seenEventIds: HashSet.add(state.seenEventIds, event.eventId),
    eventsById: HashMap.set(state.eventsById, event.eventId, metadata(event))
  }) as RunState
  if (derivedStates.has(state)) {
    derivedStates.add(next)
  }
  return next
}

const getActivity = (
  state: RunState,
  logicalActivityId: string
): ActivityState | undefined => {
  const value = HashMap.get(state.activities, logicalActivityId)
  return value._tag === "Some" ? value.value : undefined
}

const getAttempt = (
  activity: ActivityState,
  attempt: number = activity.currentAttempt
): ActivityAttemptState | undefined => {
  const value = HashMap.get(activity.attempts, attempt)
  return value._tag === "Some" ? value.value : undefined
}

const getRetry = (
  state: RunState,
  retryId: string
): RetryState | undefined => {
  const value = HashMap.get(state.retries, retryId)
  return value._tag === "Some" ? value.value : undefined
}

const getTimer = (
  state: RunState,
  timerId: string
): TimerState | undefined => {
  const value = HashMap.get(state.timers, timerId)
  return value._tag === "Some" ? value.value : undefined
}

const getSignal = (
  state: RunState,
  signalId: string
): SignalState | undefined => {
  const value = HashMap.get(state.signals, signalId)
  return value._tag === "Some" ? value.value : undefined
}

const getSignalWait = (
  state: RunState,
  waitId: string
): SignalWaitState | undefined => {
  const value = HashMap.get(state.signalWaits, waitId)
  return value._tag === "Some" ? value.value : undefined
}

const getSleep = (
  state: RunState,
  waitId: string
): SleepState | undefined => {
  const value = HashMap.get(state.sleeps, waitId)
  return value._tag === "Some" ? value.value : undefined
}

const setActivity = (
  state: RunState,
  activity: ActivityState
): HashMap.HashMap<string, ActivityState> =>
  HashMap.set(state.activities, activity.logicalActivityId, Object.freeze(activity))

const setRetry = (
  state: RunState,
  retry: RetryState
): HashMap.HashMap<string, RetryState> => HashMap.set(state.retries, retry.retryId, Object.freeze(retry))

const setTimer = (
  state: RunState,
  timer: TimerState
): HashMap.HashMap<string, TimerState> => HashMap.set(state.timers, timer.timerId, Object.freeze(timer))

const setSignal = (
  state: RunState,
  signal: SignalState
): HashMap.HashMap<string, SignalState> => HashMap.set(state.signals, signal.signalId, Object.freeze(signal))

const setSignalWait = (
  state: RunState,
  wait: SignalWaitState
): HashMap.HashMap<string, SignalWaitState> => HashMap.set(state.signalWaits, wait.waitId, Object.freeze(wait))

const setSleep = (
  state: RunState,
  sleep: SleepState
): HashMap.HashMap<string, SleepState> => HashMap.set(state.sleeps, sleep.waitId, Object.freeze(sleep))

const cancelPendingSleeps = (
  state: RunState,
  completedAt: Event.Timestamp
): HashMap.HashMap<string, SleepState> => {
  let sleeps = state.sleeps
  for (const sleep of HashMap.values(state.sleeps)) {
    if (sleep.status === "Pending") {
      sleeps = HashMap.set(
        sleeps,
        sleep.waitId,
        Object.freeze({
          ...sleep,
          status: "Cancelled",
          completedAt
        })
      )
    }
  }
  return sleeps
}

const cancelPendingSignalWaits = (
  state: RunState,
  completedAt: Event.Timestamp
): HashMap.HashMap<string, SignalWaitState> => {
  let waits = state.signalWaits
  for (const wait of HashMap.values(state.signalWaits)) {
    if (wait.status === "Pending") {
      waits = HashMap.set(
        waits,
        wait.waitId,
        Object.freeze({
          ...wait,
          status: "Cancelled",
          completedAt
        })
      )
    }
  }
  return waits
}

const jsonEqual = (left: unknown, right: unknown): boolean =>
  Json.canonicalizeSnapshot(left as Schema.Json) ===
    Json.canonicalizeSnapshot(right as Schema.Json)

const instant = (value: Event.Timestamp): number | undefined => {
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const compareTimestamps = (
  left: Event.Timestamp,
  right: Event.Timestamp
): -1 | 0 | 1 | undefined => {
  const leftInstant = instant(left)
  const rightInstant = instant(right)
  return leftInstant === undefined || rightInstant === undefined
    ? undefined
    : leftInstant < rightInstant
    ? -1
    : leftInstant > rightInstant
    ? 1
    : 0
}

const deadlineMatches = (
  anchor: Event.Timestamp,
  delayMillis: number,
  deadline: Event.Timestamp
): boolean => {
  const expected = SemanticTime.materializeDeadline(anchor, delayMillis)
  return Result.isSuccess(expected) && expected.success === deadline
}

const durationMillisBetween = (
  start: Event.Timestamp,
  end: Event.Timestamp
): number | undefined => {
  const startInstant = instant(start)
  const endInstant = instant(end)
  if (startInstant === undefined || endInstant === undefined) {
    return undefined
  }
  const duration = endInstant - startInstant
  return Number.isSafeInteger(duration) && duration >= 0
    ? duration
    : undefined
}

const checkedNonNegativeAdd = (
  left: number,
  right: number
): number | undefined => {
  const result = left + right
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : undefined
}

const canRemovePendingSignal = (
  state: RunState,
  signal: SignalState
): boolean =>
  signal.status === "Pending" &&
  state.pendingSignalCount >= 1 &&
  state.pendingSignalEncodedBytes >= signal.encodedPayloadBytes

const expectedEventId = (
  state: RunState | undefined,
  event: Event.Event
): string | undefined => {
  const payload = event.payload
  switch (payload._tag) {
    case "RunStarted":
      return Identity.runStartedEventId(event.tenantId, event.runId)
    case "ActivityScheduled":
      return Identity.scheduleActivityCommandId(
        event.tenantId,
        event.runId,
        payload.nodeInstanceId,
        payload.attempt
      )
    case "ActivityAttemptStarted":
    case "ActivityAttemptFailed": {
      const activity = state === undefined
        ? undefined
        : getActivity(state, payload.logicalActivityId)
      return activity === undefined
        ? undefined
        : payload._tag === "ActivityAttemptStarted"
        ? Identity.activityAttemptStartedEventId(
          event.tenantId,
          event.runId,
          activity.nodeInstanceId,
          payload.attempt
        )
        : Identity.activityAttemptFailedEventId(
          event.tenantId,
          event.runId,
          activity.nodeInstanceId,
          payload.attempt
        )
    }
    case "ActivityAttemptTimedOut": {
      const activity = state === undefined
        ? undefined
        : getActivity(state, payload.logicalActivityId)
      return activity === undefined
        ? undefined
        : Identity.activityAttemptTimedOutEventId(
          event.tenantId,
          event.runId,
          activity.nodeInstanceId,
          payload.attempt,
          payload.timeoutKind
        )
    }
    case "RetryScheduled": {
      const activity = state === undefined
        ? undefined
        : getActivity(state, payload.logicalActivityId)
      return activity === undefined
        ? undefined
        : Identity.scheduleRetryCommandId(
          event.tenantId,
          event.runId,
          activity.nodeInstanceId,
          payload.nextAttempt
        )
    }
    case "ActivitySucceeded": {
      const activity = state === undefined
        ? undefined
        : getActivity(state, payload.logicalActivityId)
      return activity === undefined
        ? undefined
        : Identity.activitySucceededEventId(
          event.tenantId,
          event.runId,
          activity.nodeInstanceId,
          payload.attempt
        )
    }
    case "ActivityFailed":
      return Identity.finalizeActivityFailureCommandId(
        event.tenantId,
        event.runId,
        payload.nodeInstanceId
      )
    case "TimerScheduled":
      return Identity.scheduleTimerCommandId(
        event.tenantId,
        event.runId,
        payload.timerId
      )
    case "TimerFired":
      return Identity.timerFiredEventId(
        event.tenantId,
        event.runId,
        payload.timerId
      )
    case "TimerCancelled":
      return Identity.cancelTimerCommandId(
        event.tenantId,
        event.runId,
        payload.timerId
      )
    case "SignalAccepted":
      return Identity.signalAcceptedEventId(
        event.tenantId,
        event.runId,
        payload.signalId
      )
    case "SignalWaitStarted":
      return Identity.startSignalWaitCommandId(
        event.tenantId,
        event.runId,
        payload.nodeInstanceId
      )
    case "SleepStarted":
      return Identity.startSleepCommandId(
        event.tenantId,
        event.runId,
        payload.nodeInstanceId
      )
    case "SignalConsumed":
      return Identity.consumeSignalCommandId(
        event.tenantId,
        event.runId,
        payload.waitId,
        payload.signalId
      )
    case "RunCancellationRequested":
      return Identity.runCancellationRequestedEventId(
        event.tenantId,
        event.runId,
        payload.requestId
      )
    case "RunSucceeded":
      return Identity.succeedRunCommandId(event.tenantId, event.runId)
    case "RunFailed":
      return Identity.failRunCommandId(event.tenantId, event.runId)
    case "RunCancelled":
      return Identity.cancelRunCommandId(event.tenantId, event.runId)
  }
}

const validateEventId = (
  state: RunState | undefined,
  event: Event.Event,
  historyIndex: number
): HistoryError | undefined => {
  const expected = expectedEventId(state, event)
  return expected === undefined || event.eventId === expected
    ? undefined
    : makeError(
      Codes.NonCanonicalEventId,
      `Event '${event.payload._tag}' has a noncanonical protocol version 2 event id`,
      historyIndex,
      {
        eventTag: event.payload._tag,
        expectedEventId: expected,
        actualEventId: event.eventId
      }
    )
}

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
      "Protocol version 2 event schema validation threw unexpectedly",
      historyIndex
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(Codes.InvalidEvent, decoded.failure.message, historyIndex))
    : Result.succeed(input as Event.Event)
}

const snapshotEvent = (
  input: unknown,
  historyIndex?: number
): Result.Result<Event.Event, HistoryError> => {
  const snapshot = Json.snapshot(input)
  return Result.isFailure(snapshot)
    ? Result.fail(makeError(Codes.InvalidEvent, snapshot.failure.message, historyIndex))
    : decodeSnapshotEvent(snapshot.success, historyIndex)
}

const initialState = (event: Event.Event): RunningRunState => {
  const payload = event.payload as Event.RunStarted
  const state = deepFreeze({
    executionProtocolVersion: 2,
    tenantId: event.tenantId,
    runId: event.runId,
    status: "Running",
    sequence: event.sequence,
    lastRecordedAt: event.recordedAt,
    startedAt: event.recordedAt,
    planId: payload.planId,
    planRevision: payload.planRevision,
    definitionId: payload.definitionId,
    definitionVersion: payload.definitionVersion,
    compilerVersion: payload.compilerVersion,
    compiledFingerprint: payload.compiledFingerprint,
    artifactVersion: payload.artifactVersion,
    artifactDigest: payload.artifactDigest,
    workflowIdentity: payload.workflowIdentity,
    startRequestId: payload.startRequestId,
    backend: payload.backend,
    input: payload.input,
    activities: HashMap.empty(),
    retries: HashMap.empty(),
    timers: HashMap.empty(),
    signals: HashMap.empty(),
    signalWaits: HashMap.empty(),
    sleeps: HashMap.empty(),
    nextInboxSequence: 0,
    acceptedSignalCount: 0,
    pendingSignalCount: 0,
    pendingSignalEncodedBytes: 0,
    seenEventIds: HashSet.make(event.eventId),
    eventsById: HashMap.make([event.eventId, metadata(event)])
  } as RunningRunState)
  derivedStates.add(state)
  return state
}

const activityIdentityError = (
  event: Event.Event,
  payload: Event.ActivityScheduled,
  historyIndex: number
): HistoryError | undefined => {
  const expectedLogicalActivityId = Identity.logicalActivityId(
    event.tenantId,
    event.runId,
    payload.nodeInstanceId
  )
  const expectedAttemptId = Identity.activityAttemptId(
    event.tenantId,
    event.runId,
    payload.nodeInstanceId,
    payload.attempt
  )
  const expectedIdempotencyKey = Identity.activityIdempotencyKey(
    event.tenantId,
    event.runId,
    payload.nodeInstanceId
  )
  return payload.logicalActivityId === expectedLogicalActivityId &&
      payload.attemptId === expectedAttemptId &&
      payload.idempotencyKey === expectedIdempotencyKey
    ? undefined
    : makeError(
      Codes.ActivityIdentityMismatch,
      `Activity attempt ${payload.attempt} has inconsistent protocol version 2 identities`,
      historyIndex,
      {
        expectedLogicalActivityId,
        actualLogicalActivityId: payload.logicalActivityId,
        expectedAttemptId,
        actualAttemptId: payload.attemptId,
        expectedIdempotencyKey,
        actualIdempotencyKey: payload.idempotencyKey
      }
    )
}

const currentAttemptError = (
  activity: ActivityState,
  payload: {
    readonly logicalActivityId: string
    readonly attemptId: string
    readonly attempt: number
  },
  historyIndex: number
): HistoryError | undefined =>
  payload.logicalActivityId === activity.logicalActivityId &&
    payload.attemptId === activity.currentAttemptId &&
    payload.attempt === activity.currentAttempt
    ? undefined
    : makeError(
      Codes.AttemptMismatch,
      `Activity fact does not identify the current semantic attempt ${activity.currentAttempt}`,
      historyIndex,
      {
        logicalActivityId: activity.logicalActivityId,
        expectedAttemptId: activity.currentAttemptId,
        actualAttemptId: payload.attemptId,
        expectedAttempt: activity.currentAttempt,
        actualAttempt: payload.attempt
      }
    )

const updateAttempt = (
  activity: ActivityState,
  attempt: ActivityAttemptState,
  changes: Readonly<Record<string, unknown>> = {}
): ActivityState =>
  Object.freeze({
    ...activity,
    ...changes,
    attempts: HashMap.set(activity.attempts, attempt.attempt, Object.freeze(attempt))
  }) as ActivityState

const retryableAttempt = (
  activity: ActivityState,
  attempt: ActivityAttemptState
): boolean => {
  if (attempt.attempt >= activity.policy.retry.maximumAttempts) {
    return false
  }
  if (attempt.status === "Failed") {
    return activity.policy.retry.retryOn.encodedFailure
  }
  if (attempt.status !== "TimedOut") {
    return false
  }
  return attempt.timeoutKind === "ScheduleToStart"
    ? activity.policy.retry.retryOn.scheduleToStartTimeout
    : activity.policy.retry.retryOn.startToCloseTimeout
}

const activityTimer = (
  state: RunState,
  tenantId: string,
  runId: string,
  ownerKind: "ScheduleToStart" | "StartToClose",
  attemptId: string
): TimerState | undefined =>
  getTimer(
    state,
    Identity.timerId(
      tenantId,
      runId,
      ownerKind,
      attemptId
    )
  )

const scheduleToCloseTimer = (
  state: RunState,
  tenantId: string,
  runId: string,
  logicalActivityId: string
): TimerState | undefined =>
  getTimer(
    state,
    Identity.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      logicalActivityId
    )
  )

const enabledTimeoutIsPending = (
  timeout: Event.SignalWaitStarted["timeout"],
  timer: TimerState | undefined
): boolean => timeout._tag === "Disabled" || timer?.status === "Pending"

const purposeOwner = (
  purpose: Event.TimerPurpose
): readonly [Identity.TimerOwnerKind, string] => {
  switch (purpose._tag) {
    case "RetryBackoff":
      return ["RetryBackoff", purpose.retryId]
    case "ScheduleToStart":
      return ["ScheduleToStart", purpose.attemptId]
    case "StartToClose":
      return ["StartToClose", purpose.attemptId]
    case "ScheduleToClose":
      return ["ScheduleToClose", purpose.logicalActivityId]
    case "SignalExpiry":
      return ["SignalExpiry", purpose.signalId]
    case "SignalWaitTimeout":
      return ["SignalWaitTimeout", purpose.waitId]
    case "Sleep":
      return ["Sleep", purpose.waitId]
  }
}

const validateTimerPurpose = (
  state: RunState,
  event: Event.Event,
  payload: Event.TimerScheduled,
  historyIndex: number
): HistoryError | undefined => {
  const [ownerKind, ownerId] = purposeOwner(payload.purpose)
  const expectedTimerId = Identity.timerId(
    event.tenantId,
    event.runId,
    ownerKind,
    ownerId
  )
  if (payload.timerId !== expectedTimerId) {
    return makeError(
      Codes.TimerOwnershipMismatch,
      `Timer '${payload.timerId}' does not match its '${payload.purpose._tag}' owner`,
      historyIndex,
      { expectedTimerId, actualTimerId: payload.timerId, purpose: payload.purpose._tag }
    )
  }

  const anchor = HashMap.get(state.eventsById, payload.anchorEventId)
  if (anchor._tag === "None") {
    return makeError(
      Codes.TimerAnchorNotFound,
      `Timer '${payload.timerId}' refers to an unknown anchor event`,
      historyIndex,
      { timerId: payload.timerId, anchorEventId: payload.anchorEventId }
    )
  }
  if (
    !deadlineMatches(
      anchor.value.recordedAt,
      payload.delayMillis,
      payload.deadline
    )
  ) {
    return makeError(
      Codes.TimerDeadlineMismatch,
      `Timer '${payload.timerId}' deadline does not equal its anchor plus delay`,
      historyIndex,
      {
        timerId: payload.timerId,
        anchorEventId: payload.anchorEventId,
        anchorRecordedAt: anchor.value.recordedAt,
        delayMillis: payload.delayMillis,
        deadline: payload.deadline
      }
    )
  }

  const purpose = payload.purpose
  switch (purpose._tag) {
    case "RetryBackoff": {
      const retry = getRetry(state, purpose.retryId)
      if (
        retry === undefined ||
        retry.logicalActivityId !== purpose.logicalActivityId ||
        retry.nextAttempt !== purpose.nextAttempt ||
        retry.timerId !== payload.timerId ||
        retry.anchorEventId !== payload.anchorEventId ||
        retry.selectedDelayMillis !== payload.delayMillis ||
        compareTimestamps(retry.deadline, payload.deadline) !== 0
      ) {
        return makeError(
          Codes.TimerOwnershipMismatch,
          `Retry timer '${payload.timerId}' does not match its committed retry`,
          historyIndex,
          { timerId: payload.timerId, retryId: purpose.retryId }
        )
      }
      return undefined
    }
    case "ScheduleToStart":
    case "StartToClose": {
      const activity = getActivity(state, purpose.logicalActivityId)
      const attempt = activity === undefined
        ? undefined
        : getAttempt(activity, purpose.attempt)
      const timeout = activity === undefined
        ? undefined
        : purpose._tag === "ScheduleToStart"
        ? activity.policy.timeouts.scheduleToStart
        : activity.policy.timeouts.startToClose
      const expectedAnchor = purpose._tag === "ScheduleToStart"
        ? attempt?.scheduledEventId
        : attempt?.startedEventId
      const expectedStatus = purpose._tag === "ScheduleToStart"
        ? "Scheduled"
        : "Started"
      if (
        activity === undefined ||
        attempt === undefined ||
        purpose.attemptId !== attempt.attemptId ||
        attempt.status !== expectedStatus ||
        timeout?._tag !== "After" ||
        timeout.durationMillis !== payload.delayMillis ||
        expectedAnchor !== payload.anchorEventId
      ) {
        return makeError(
          Codes.TimerOwnershipMismatch,
          `Attempt timer '${payload.timerId}' does not match its current activity attempt`,
          historyIndex,
          { timerId: payload.timerId, purpose: purpose._tag }
        )
      }
      return undefined
    }
    case "ScheduleToClose": {
      const activity = getActivity(state, purpose.logicalActivityId)
      const timeout = activity?.policy.timeouts.scheduleToClose
      if (
        activity === undefined ||
        activity.status === "Succeeded" ||
        activity.status === "Failed" ||
        timeout?._tag !== "After" ||
        timeout.durationMillis !== payload.delayMillis ||
        activity.firstScheduledEventId !== payload.anchorEventId
      ) {
        return makeError(
          Codes.TimerOwnershipMismatch,
          `Schedule-to-close timer '${payload.timerId}' does not match a live logical activity`,
          historyIndex,
          { timerId: payload.timerId, logicalActivityId: purpose.logicalActivityId }
        )
      }
      return undefined
    }
    case "SignalExpiry": {
      const signal = getSignal(state, purpose.signalId)
      if (
        signal === undefined ||
        signal.status !== "Pending" ||
        signal.inboxSequence !== purpose.inboxSequence ||
        signal.expiryTimerId !== payload.timerId ||
        signal.acceptedEventId !== payload.anchorEventId ||
        signal.ttlMillis !== payload.delayMillis ||
        compareTimestamps(signal.expiresAt, payload.deadline) !== 0
      ) {
        return makeError(
          Codes.TimerOwnershipMismatch,
          `Signal-expiry timer '${payload.timerId}' does not match its accepted signal`,
          historyIndex,
          { timerId: payload.timerId, signalId: purpose.signalId }
        )
      }
      return undefined
    }
    case "SignalWaitTimeout": {
      const wait = getSignalWait(state, purpose.waitId)
      if (
        wait === undefined ||
        wait.status !== "Pending" ||
        wait.nodeInstanceId !== purpose.nodeInstanceId ||
        wait.timeout._tag !== "After" ||
        wait.timeout.durationMillis !== payload.delayMillis ||
        wait.startedEventId !== payload.anchorEventId
      ) {
        return makeError(
          Codes.TimerOwnershipMismatch,
          `Signal-wait timer '${payload.timerId}' does not match its pending wait`,
          historyIndex,
          { timerId: payload.timerId, waitId: purpose.waitId }
        )
      }
      return undefined
    }
    case "Sleep": {
      const sleep = getSleep(state, purpose.waitId)
      if (sleep === undefined) {
        return makeError(
          Codes.SleepNotFound,
          `Sleep timer '${payload.timerId}' refers to an unknown sleep owner`,
          historyIndex,
          { timerId: payload.timerId, waitId: purpose.waitId }
        )
      }
      if (
        sleep.status !== "Pending" ||
        sleep.nodeInstanceId !== purpose.nodeInstanceId ||
        sleep.durationMillis !== payload.delayMillis ||
        sleep.startedEventId !== payload.anchorEventId ||
        sleep.timerId !== undefined
      ) {
        return makeError(
          Codes.TimerOwnershipMismatch,
          `Sleep timer '${payload.timerId}' does not match its pending sleep owner`,
          historyIndex,
          {
            timerId: payload.timerId,
            waitId: purpose.waitId,
            sleepStatus: sleep.status
          }
        )
      }
      return undefined
    }
  }
}

const timerMayFire = (
  state: RunState,
  timer: TimerState
): boolean => {
  const purpose = timer.purpose
  switch (purpose._tag) {
    case "RetryBackoff": {
      const retry = getRetry(state, purpose.retryId)
      const activity = retry === undefined
        ? undefined
        : getActivity(state, retry.logicalActivityId)
      const totalTimer = activity === undefined
        ? undefined
        : scheduleToCloseTimer(
          state,
          state.tenantId,
          state.runId,
          activity.logicalActivityId
        )
      return retry !== undefined &&
        retry.status === "WaitingForTimer" &&
        activity?.status === "RetryPending" &&
        totalTimer?.status !== "Fired"
    }
    case "ScheduleToStart": {
      const activity = getActivity(state, purpose.logicalActivityId)
      const attempt = activity === undefined ? undefined : getAttempt(activity, purpose.attempt)
      const totalTimer = activity === undefined
        ? undefined
        : scheduleToCloseTimer(
          state,
          state.tenantId,
          state.runId,
          activity.logicalActivityId
        )
      return attempt !== undefined &&
        attempt.status === "Scheduled" &&
        totalTimer?.status !== "Fired"
    }
    case "StartToClose": {
      const activity = getActivity(state, purpose.logicalActivityId)
      const attempt = activity === undefined ? undefined : getAttempt(activity, purpose.attempt)
      const totalTimer = activity === undefined
        ? undefined
        : scheduleToCloseTimer(
          state,
          state.tenantId,
          state.runId,
          activity.logicalActivityId
        )
      return attempt !== undefined &&
        attempt.status === "Started" &&
        totalTimer?.status !== "Fired"
    }
    case "ScheduleToClose": {
      const activity = getActivity(state, purpose.logicalActivityId)
      return activity !== undefined &&
        activity.status !== "Succeeded" &&
        activity.status !== "Failed"
    }
    case "SignalExpiry":
      return getSignal(state, purpose.signalId)?.status === "Pending"
    case "SignalWaitTimeout":
      return getSignalWait(state, purpose.waitId)?.status === "Pending"
    case "Sleep": {
      const sleep = getSleep(state, purpose.waitId)
      return sleep?.status === "Pending" &&
        sleep.nodeInstanceId === purpose.nodeInstanceId &&
        sleep.timerId === timer.timerId
    }
  }
}

const matchingSignal = (
  signal: SignalState,
  wait: SignalWaitState
): boolean => {
  if (
    signal.status !== "Pending" ||
    signal.signalName !== wait.signalName ||
    signal.signalVersion !== wait.signalVersion
  ) {
    return false
  }
  if (wait.correlation._tag === "Any") {
    return true
  }
  return signal.correlation._tag === "Exact" &&
    signal.correlation.key === wait.correlation.key
}

const oldestMatchingSignal = (
  state: RunState,
  wait: SignalWaitState
): SignalState | undefined => {
  let oldest: SignalState | undefined
  for (const signal of HashMap.values(state.signals)) {
    if (
      matchingSignal(signal, wait) &&
      (oldest === undefined || signal.inboxSequence < oldest.inboxSequence)
    ) {
      oldest = signal
    }
  }
  return oldest
}

const firstPendingTimer = (state: RunState): TimerState | undefined => {
  for (const timer of HashMap.values(state.timers)) {
    if (timer.status === "Pending") {
      return timer
    }
  }
  return undefined
}

const terminalDecisionReady = (state: RunState): boolean => {
  if (state.status !== "Running") {
    return false
  }
  let allActivitiesSucceeded = true
  for (const activity of HashMap.values(state.activities)) {
    if (activity.status === "Failed") {
      return true
    }
    if (activity.status !== "Succeeded") {
      allActivitiesSucceeded = false
    }
  }
  let allWaitsConsumed = true
  for (const wait of HashMap.values(state.signalWaits)) {
    if (wait.status === "TimedOut") {
      return true
    }
    if (wait.status !== "Consumed") {
      allWaitsConsumed = false
    }
  }
  let allSleepsCompleted = true
  for (const sleep of HashMap.values(state.sleeps)) {
    if (sleep.status !== "Completed") {
      allSleepsCompleted = false
    }
  }
  return allActivitiesSucceeded && allWaitsConsumed && allSleepsCompleted
}

const timerOwnerCompleted = (
  state: RunState,
  timer: TimerState
): boolean => {
  const purpose = timer.purpose
  switch (purpose._tag) {
    case "RetryBackoff":
      return getRetry(state, purpose.retryId)?.status === "Consumed"
    case "ScheduleToStart": {
      const activity = getActivity(state, purpose.logicalActivityId)
      const attempt = activity === undefined ? undefined : getAttempt(activity, purpose.attempt)
      return attempt !== undefined && attempt.status !== "Scheduled"
    }
    case "StartToClose": {
      const activity = getActivity(state, purpose.logicalActivityId)
      return activity === undefined
        ? false
        : getAttempt(activity, purpose.attempt)?.status === "Succeeded"
    }
    case "ScheduleToClose":
      return getActivity(state, purpose.logicalActivityId)?.status === "Succeeded"
    case "SignalExpiry":
      return getSignal(state, purpose.signalId)?.status === "Consumed"
    case "SignalWaitTimeout":
      return getSignalWait(state, purpose.waitId)?.status === "Consumed"
    case "Sleep":
      return getSleep(state, purpose.waitId)?.status === "Completed"
  }
}

const timerOwnerFailed = (
  state: RunState,
  timer: TimerState
): boolean => {
  const purpose = timer.purpose
  switch (purpose._tag) {
    case "RetryBackoff":
      return getActivity(state, purpose.logicalActivityId)?.status === "Failed"
    case "ScheduleToStart":
    case "StartToClose": {
      const activity = getActivity(state, purpose.logicalActivityId)
      const attempt = activity === undefined ? undefined : getAttempt(activity, purpose.attempt)
      return attempt?.status === "Failed" || attempt?.status === "TimedOut"
    }
    case "ScheduleToClose":
      return getActivity(state, purpose.logicalActivityId)?.status === "Failed"
    case "SignalExpiry":
      return getSignal(state, purpose.signalId)?.status === "Expired"
    case "SignalWaitTimeout":
      return getSignalWait(state, purpose.waitId)?.status === "TimedOut"
    case "Sleep":
      return getSleep(state, purpose.waitId)?.status === "Cancelled"
  }
}

const timerOwnerSignalConsumed = (
  state: RunState,
  timer: TimerState
): boolean =>
  timer.purpose._tag === "SignalExpiry"
    ? getSignal(state, timer.purpose.signalId)?.status === "Consumed"
    : timer.purpose._tag === "SignalWaitTimeout" &&
      getSignalWait(state, timer.purpose.waitId)?.status === "Consumed"

const validTimerCancellationReason = (
  state: RunState,
  timer: TimerState,
  reason: Event.TimerCancellationReason
): boolean => {
  switch (reason) {
    case "RunCancellationRequested":
      return state.status === "CancellationRequested"
    case "RunTerminal":
      return terminalDecisionReady(state)
    case "SignalConsumed":
      return timerOwnerSignalConsumed(state, timer)
    case "OwnerCompleted":
      return timerOwnerCompleted(state, timer)
    case "OwnerFailed":
      return timerOwnerFailed(state, timer)
    case "Superseded":
      return !timerMayFire(state, timer)
  }
}

const expectedPairingPurpose = (
  owner: TimerPairingObligation["owner"]
): "SignalExpiry" | "SignalWaitTimeout" | "Sleep" =>
  owner === "SignalAccepted"
    ? "SignalExpiry"
    : owner === "SignalWaitStarted"
    ? "SignalWaitTimeout"
    : "Sleep"

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
  if (HashSet.has(state.seenEventIds, event.eventId)) {
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
  const recordedAtOrder = compareTimestamps(
    event.recordedAt,
    state.lastRecordedAt
  )
  if (recordedAtOrder === undefined || recordedAtOrder < 0) {
    return Result.fail(makeError(
      Codes.TimestampRegression,
      "Event recordedAt must not precede the prior committed event instant",
      historyIndex,
      {
        previousRecordedAt: state.lastRecordedAt,
        actualRecordedAt: event.recordedAt
      }
    ))
  }
  if (event.tenantId !== state.tenantId) {
    return Result.fail(makeError(
      Codes.TenantIdMismatch,
      `Expected tenant id '${state.tenantId}' but received '${event.tenantId}'`,
      historyIndex,
      { expected: state.tenantId, actual: event.tenantId }
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
  const identityError = validateEventId(state, event, historyIndex)
  if (identityError !== undefined) {
    return Result.fail(identityError)
  }
  if (event.payload._tag === "RunStarted") {
    return Result.fail(makeError(
      Codes.DuplicateRunStarted,
      "RunStarted may only be the first history event",
      historyIndex
    ))
  }
  const pairing = state.pendingTimerPairing
  if (
    pairing !== undefined &&
    event.payload._tag !== "TimerScheduled"
  ) {
    return Result.fail(makeError(
      Codes.IncompleteSemanticPairing,
      `'${pairing.owner}' must be followed immediately by its exact timer fact`,
      historyIndex,
      {
        owner: pairing.owner,
        ownerEventId: pairing.ownerEventId,
        expectedTimerId: pairing.timerId,
        expectedTimerPurpose: expectedPairingPurpose(pairing.owner),
        actualEventTag: event.payload._tag
      }
    ))
  }
  if (
    state.status === "CancellationRequested" &&
    event.payload._tag !== "TimerCancelled" &&
    event.payload._tag !== "RunCancelled"
  ) {
    return Result.fail(makeError(
      Codes.IllegalCancellationTransition,
      `Event '${event.payload._tag}' is not cancellation cleanup`,
      historyIndex,
      { eventTag: event.payload._tag }
    ))
  }

  const payload = event.payload
  switch (payload._tag) {
    case "ActivityScheduled": {
      const identity = activityIdentityError(event, payload, historyIndex)
      if (identity !== undefined) {
        return Result.fail(identity)
      }
      const current = getActivity(state, payload.logicalActivityId)
      if (current === undefined) {
        if (payload.attempt !== 1) {
          return Result.fail(makeError(
            Codes.AttemptMismatch,
            "A new logical activity must begin with semantic attempt 1",
            historyIndex,
            { logicalActivityId: payload.logicalActivityId, actualAttempt: payload.attempt }
          ))
        }
        const attempt: ActivityAttemptState = Object.freeze({
          attemptId: payload.attemptId,
          attempt: payload.attempt,
          status: "Scheduled",
          scheduledEventId: event.eventId,
          scheduledAt: event.recordedAt
        })
        const activity: ActivityState = {
          logicalActivityId: payload.logicalActivityId,
          nodeId: payload.nodeId,
          nodeInstanceId: payload.nodeInstanceId,
          idempotencyKey: payload.idempotencyKey,
          input: payload.input,
          policy: payload.policy,
          status: "Active",
          currentAttempt: payload.attempt,
          currentAttemptId: payload.attemptId,
          attempts: HashMap.make([payload.attempt, attempt]),
          firstScheduledEventId: event.eventId,
          scheduledAt: event.recordedAt
        }
        return Result.succeed(commit(state, event, {
          activities: setActivity(state, activity)
        }))
      }
      if (current.status !== "RetryPending") {
        return Result.fail(makeError(
          Codes.ActivityAlreadyScheduled,
          `Logical activity '${payload.logicalActivityId}' cannot schedule another attempt`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId, status: current.status }
        ))
      }
      const expectedAttempt = current.currentAttempt + 1
      const retry = current.pendingRetryId === undefined
        ? undefined
        : getRetry(state, current.pendingRetryId)
      const timer = retry === undefined ? undefined : getTimer(state, retry.timerId)
      const totalTimer = scheduleToCloseTimer(
        state,
        event.tenantId,
        event.runId,
        current.logicalActivityId
      )
      if (
        payload.attempt !== expectedAttempt ||
        retry === undefined ||
        retry.nextAttempt !== payload.attempt ||
        retry.status !== "Ready" ||
        timer?.status !== "Fired" ||
        !enabledTimeoutIsPending(
          current.policy.timeouts.scheduleToClose,
          totalTimer
        )
      ) {
        return Result.fail(makeError(
          Codes.RetryMismatch,
          `Activity attempt ${payload.attempt} lacks its exact fired retry timer`,
          historyIndex,
          {
            logicalActivityId: payload.logicalActivityId,
            expectedAttempt,
            actualAttempt: payload.attempt
          }
        ))
      }
      if (
        payload.nodeId !== current.nodeId ||
        payload.nodeInstanceId !== current.nodeInstanceId ||
        payload.idempotencyKey !== current.idempotencyKey ||
        !jsonEqual(payload.input, current.input) ||
        !jsonEqual(payload.policy, current.policy)
      ) {
        return Result.fail(makeError(
          Codes.ActivityIdentityMismatch,
          "A retry must retain the logical activity's pinned meaning",
          historyIndex,
          { logicalActivityId: payload.logicalActivityId, attempt: payload.attempt }
        ))
      }
      const attempt: ActivityAttemptState = {
        attemptId: payload.attemptId,
        attempt: payload.attempt,
        status: "Scheduled",
        scheduledEventId: event.eventId,
        scheduledAt: event.recordedAt
      }
      const activity: ActivityState = {
        ...current,
        status: "Active",
        currentAttempt: payload.attempt,
        currentAttemptId: payload.attemptId,
        attempts: HashMap.set(
          current.attempts,
          payload.attempt,
          Object.freeze(attempt)
        ),
        pendingRetryId: undefined
      }
      const consumedRetry: RetryState = {
        ...retry,
        status: "Consumed",
        consumedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, activity),
        retries: setRetry(state, consumedRetry)
      }))
    }
    case "ActivityAttemptStarted": {
      const activity = getActivity(state, payload.logicalActivityId)
      if (activity === undefined) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Attempt '${payload.attemptId}' started before its logical activity was scheduled`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId }
        ))
      }
      const mismatch = currentAttemptError(activity, payload, historyIndex)
      if (mismatch !== undefined) {
        return Result.fail(mismatch)
      }
      const attempt = getAttempt(activity)
      if (activity.status !== "Active" || attempt?.status !== "Scheduled") {
        return Result.fail(makeError(
          Codes.IllegalAttemptTransition,
          `Attempt '${payload.attemptId}' cannot start from its current state`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId, status: attempt?.status ?? activity.status }
        ))
      }
      const scheduleTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        "ScheduleToStart",
        attempt.attemptId
      )
      const scheduleTimer = getTimer(state, scheduleTimerId)
      const totalTimer = scheduleToCloseTimer(
        state,
        event.tenantId,
        event.runId,
        activity.logicalActivityId
      )
      if (
        !enabledTimeoutIsPending(
          activity.policy.timeouts.scheduleToStart,
          scheduleTimer
        ) ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.scheduleToClose,
          totalTimer
        )
      ) {
        return Result.fail(makeError(
          Codes.IllegalAttemptTransition,
          `Attempt '${payload.attemptId}' cannot start without every enabled scheduling timer pending`,
          historyIndex,
          {
            attemptId: payload.attemptId,
            scheduleToStartTimerId: scheduleTimerId,
            scheduleToStartTimerStatus: scheduleTimer?.status ?? null,
            scheduleToCloseTimerStatus: totalTimer?.status ?? null
          }
        ))
      }
      const started: ActivityAttemptState = {
        ...attempt,
        status: "Started",
        startedEventId: event.eventId,
        startedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, updateAttempt(activity, started))
      }))
    }
    case "ActivityAttemptFailed": {
      const activity = getActivity(state, payload.logicalActivityId)
      if (activity === undefined) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Attempt '${payload.attemptId}' failed before its logical activity was scheduled`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId }
        ))
      }
      const mismatch = currentAttemptError(activity, payload, historyIndex)
      if (mismatch !== undefined) {
        return Result.fail(mismatch)
      }
      const attempt = getAttempt(activity)
      const startTimer = attempt === undefined
        ? undefined
        : activityTimer(
          state,
          event.tenantId,
          event.runId,
          "StartToClose",
          attempt.attemptId
        )
      const totalTimer = scheduleToCloseTimer(
        state,
        event.tenantId,
        event.runId,
        activity.logicalActivityId
      )
      if (
        activity.status !== "Active" ||
        attempt?.status !== "Started" ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.startToClose,
          startTimer
        ) ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.scheduleToClose,
          totalTimer
        )
      ) {
        return Result.fail(makeError(
          Codes.IllegalAttemptTransition,
          `Attempt '${payload.attemptId}' must start and retain every enabled active timer before it can fail`,
          historyIndex,
          { attemptId: payload.attemptId, status: attempt?.status ?? activity.status }
        ))
      }
      const failed: ActivityAttemptState = {
        ...attempt,
        status: "Failed",
        failure: payload.failure,
        completedEventId: event.eventId,
        completedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, updateAttempt(activity, failed))
      }))
    }
    case "ActivityAttemptTimedOut": {
      const activity = getActivity(state, payload.logicalActivityId)
      if (activity === undefined) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Attempt '${payload.attemptId}' timed out before its logical activity was scheduled`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId }
        ))
      }
      const mismatch = currentAttemptError(activity, payload, historyIndex)
      if (mismatch !== undefined) {
        return Result.fail(mismatch)
      }
      const attempt = getAttempt(activity)
      const expectedStatus = payload.timeoutKind === "ScheduleToStart"
        ? "Scheduled"
        : "Started"
      const timeout = payload.timeoutKind === "ScheduleToStart"
        ? activity.policy.timeouts.scheduleToStart
        : activity.policy.timeouts.startToClose
      const expectedTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        payload.timeoutKind,
        payload.attemptId
      )
      const timer = getTimer(state, payload.timerId)
      const totalTimer = scheduleToCloseTimer(
        state,
        event.tenantId,
        event.runId,
        activity.logicalActivityId
      )
      if (
        activity.status !== "Active" ||
        attempt?.status !== expectedStatus ||
        timeout._tag !== "After" ||
        payload.timerId !== expectedTimerId ||
        timer?.status !== "Fired" ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.scheduleToClose,
          totalTimer
        )
      ) {
        return Result.fail(makeError(
          Codes.IllegalAttemptTransition,
          `Attempt '${payload.attemptId}' does not have a matching fired ${payload.timeoutKind} timer`,
          historyIndex,
          {
            attemptId: payload.attemptId,
            timeoutKind: payload.timeoutKind,
            timerId: payload.timerId
          }
        ))
      }
      const timedOut: ActivityAttemptState = {
        ...attempt,
        status: "TimedOut",
        timeoutKind: payload.timeoutKind,
        timerId: payload.timerId,
        completedEventId: event.eventId,
        completedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, updateAttempt(activity, timedOut))
      }))
    }
    case "RetryScheduled": {
      const activity = getActivity(state, payload.logicalActivityId)
      if (activity === undefined) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Retry '${payload.retryId}' refers to an unknown logical activity`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId }
        ))
      }
      const attempt = getAttempt(activity)
      const expectedRetryId = Identity.retryId(
        event.tenantId,
        event.runId,
        activity.nodeInstanceId,
        activity.currentAttempt + 1
      )
      const expectedTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        "RetryBackoff",
        expectedRetryId
      )
      const totalTimer = scheduleToCloseTimer(
        state,
        event.tenantId,
        event.runId,
        activity.logicalActivityId
      )
      if (
        activity.status !== "Active" ||
        attempt === undefined ||
        payload.failedAttemptId !== attempt.attemptId ||
        payload.failedAttempt !== attempt.attempt ||
        payload.nextAttempt !== attempt.attempt + 1 ||
        payload.anchorEventId !== attempt.completedEventId ||
        payload.retryId !== expectedRetryId ||
        payload.timerId !== expectedTimerId ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.scheduleToClose,
          totalTimer
        )
      ) {
        return Result.fail(makeError(
          Codes.RetryMismatch,
          `Retry '${payload.retryId}' does not identify the exact next semantic attempt`,
          historyIndex,
          {
            logicalActivityId: payload.logicalActivityId,
            currentAttempt: activity.currentAttempt,
            nextAttempt: payload.nextAttempt
          }
        ))
      }
      if (!retryableAttempt(activity, attempt)) {
        return Result.fail(makeError(
          Codes.RetryNotAllowed,
          `Attempt ${attempt.attempt} is permanent or exhausted under its pinned policy`,
          historyIndex,
          { logicalActivityId: activity.logicalActivityId, attempt: attempt.attempt }
        ))
      }
      if (getRetry(state, payload.retryId) !== undefined) {
        return Result.fail(makeError(
          Codes.RetryMismatch,
          `Retry '${payload.retryId}' was already scheduled`,
          historyIndex,
          { retryId: payload.retryId }
        ))
      }
      if (
        payload.selectedDelayMillis !== activity.policy.retry.backoff.delayMillis ||
        attempt.completedAt === undefined ||
        attempt.completedEventId === undefined ||
        !deadlineMatches(
          attempt.completedAt,
          payload.selectedDelayMillis,
          payload.deadline
        )
      ) {
        return Result.fail(makeError(
          Codes.RetryMismatch,
          `Retry '${payload.retryId}' does not match the pinned backoff decision`,
          historyIndex,
          {
            retryId: payload.retryId,
            expectedDelayMillis: activity.policy.retry.backoff.delayMillis,
            actualDelayMillis: payload.selectedDelayMillis
          }
        ))
      }
      const retry: RetryState = {
        retryId: payload.retryId,
        logicalActivityId: payload.logicalActivityId,
        failedAttemptId: payload.failedAttemptId,
        failedAttempt: payload.failedAttempt,
        nextAttempt: payload.nextAttempt,
        timerId: payload.timerId,
        selectedDelayMillis: payload.selectedDelayMillis,
        deadline: payload.deadline,
        anchorEventId: payload.anchorEventId,
        scheduledEventId: event.eventId,
        scheduledAt: event.recordedAt,
        status: "WaitingForTimer"
      }
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, {
          ...activity,
          status: "RetryPending",
          pendingRetryId: payload.retryId
        }),
        retries: setRetry(state, retry)
      }))
    }
    case "ActivitySucceeded": {
      const activity = getActivity(state, payload.logicalActivityId)
      if (activity === undefined) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Attempt '${payload.attemptId}' succeeded before its logical activity was scheduled`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId }
        ))
      }
      const mismatch = currentAttemptError(activity, payload, historyIndex)
      if (mismatch !== undefined) {
        return Result.fail(mismatch)
      }
      const attempt = getAttempt(activity)
      const startToCloseTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        "StartToClose",
        payload.attemptId
      )
      const startTimer = getTimer(state, startToCloseTimerId)
      const scheduleToCloseTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        "ScheduleToClose",
        payload.logicalActivityId
      )
      const totalTimer = getTimer(state, scheduleToCloseTimerId)
      if (
        activity.status !== "Active" ||
        attempt?.status !== "Started" ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.startToClose,
          startTimer
        ) ||
        !enabledTimeoutIsPending(
          activity.policy.timeouts.scheduleToClose,
          totalTimer
        )
      ) {
        return Result.fail(makeError(
          Codes.IllegalAttemptTransition,
          `Attempt '${payload.attemptId}' cannot succeed from its current state`,
          historyIndex,
          { attemptId: payload.attemptId, status: attempt?.status ?? activity.status }
        ))
      }
      const succeeded: ActivityAttemptState = {
        ...attempt,
        status: "Succeeded",
        output: payload.output,
        completedEventId: event.eventId,
        completedAt: event.recordedAt
      }
      const next = updateAttempt(activity, succeeded, {
        status: "Succeeded",
        output: payload.output,
        completedAt: event.recordedAt
      })
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, next)
      }))
    }
    case "ActivityFailed": {
      const activity = getActivity(state, payload.logicalActivityId)
      if (activity === undefined) {
        return Result.fail(makeError(
          Codes.ActivityNotScheduled,
          `Final activity failure refers to unknown logical activity '${payload.logicalActivityId}'`,
          historyIndex,
          { logicalActivityId: payload.logicalActivityId }
        ))
      }
      const mismatch = currentAttemptError(activity, payload, historyIndex)
      if (
        mismatch !== undefined ||
        payload.nodeId !== activity.nodeId ||
        payload.nodeInstanceId !== activity.nodeInstanceId
      ) {
        return Result.fail(
          mismatch ?? makeError(
            Codes.FinalFailureMismatch,
            "Final activity failure attribution does not match its logical activity",
            historyIndex,
            { logicalActivityId: payload.logicalActivityId }
          )
        )
      }
      const attempt = getAttempt(activity)!
      const totalTimer = scheduleToCloseTimer(
        state,
        event.tenantId,
        event.runId,
        activity.logicalActivityId
      )
      const totalTimedOut = totalTimer?.status === "Fired"
      let matches = false
      if (payload.cause._tag === "EncodedFailure") {
        matches = attempt.status === "Failed" &&
          !totalTimedOut &&
          !retryableAttempt(activity, attempt) &&
          jsonEqual(attempt.failure, payload.cause.failure)
      } else if (payload.cause._tag === "AttemptTimeout") {
        matches = attempt.status === "TimedOut" &&
          !totalTimedOut &&
          !retryableAttempt(activity, attempt) &&
          attempt.timeoutKind === payload.cause.timeoutKind
      } else {
        const expectedTimerId = Identity.timerId(
          event.tenantId,
          event.runId,
          "ScheduleToClose",
          activity.logicalActivityId
        )
        matches = payload.cause.timerId === expectedTimerId &&
          totalTimedOut &&
          activity.status !== "Succeeded" &&
          activity.status !== "Failed"
      }
      if (!matches) {
        return Result.fail(makeError(
          Codes.FinalFailureMismatch,
          "Final activity failure does not match an exhausted or permanent current cause",
          historyIndex,
          {
            logicalActivityId: activity.logicalActivityId,
            attempt: activity.currentAttempt,
            cause: payload.cause._tag
          }
        ))
      }
      const failed: ActivityState = {
        ...activity,
        status: "Failed",
        finalCause: payload.cause,
        completedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        activities: setActivity(state, failed)
      }))
    }
    case "SleepStarted": {
      const expectedWaitId = Identity.sleepWaitId(
        event.tenantId,
        event.runId,
        payload.nodeInstanceId
      )
      if (payload.waitId !== expectedWaitId) {
        return Result.fail(makeError(
          Codes.SleepIdentityMismatch,
          `Sleep '${payload.waitId}' has a noncanonical owner identity`,
          historyIndex,
          { expectedWaitId, actualWaitId: payload.waitId }
        ))
      }
      if (getSleep(state, payload.waitId) !== undefined) {
        return Result.fail(makeError(
          Codes.IllegalSleepTransition,
          `Sleep '${payload.waitId}' was already started`,
          historyIndex,
          { waitId: payload.waitId }
        ))
      }
      const sleep: SleepState = {
        waitId: payload.waitId,
        nodeId: payload.nodeId,
        nodeInstanceId: payload.nodeInstanceId,
        durationMillis: payload.durationMillis,
        status: "Pending",
        startedEventId: event.eventId,
        startedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        sleeps: setSleep(state, sleep),
        pendingTimerPairing: {
          owner: "SleepStarted",
          ownerEventId: event.eventId,
          timerId: Identity.timerId(
            event.tenantId,
            event.runId,
            "Sleep",
            payload.waitId
          )
        }
      }))
    }
    case "TimerScheduled": {
      if (getTimer(state, payload.timerId) !== undefined) {
        return Result.fail(makeError(
          Codes.TimerAlreadyScheduled,
          `Timer '${payload.timerId}' was already scheduled`,
          historyIndex,
          { timerId: payload.timerId }
        ))
      }
      const purposeError = validateTimerPurpose(state, event, payload, historyIndex)
      if (purposeError !== undefined) {
        return Result.fail(purposeError)
      }
      const pairing = state.pendingTimerPairing
      if (
        pairing !== undefined &&
        (
          payload.timerId !== pairing.timerId ||
          payload.anchorEventId !== pairing.ownerEventId ||
          payload.purpose._tag !== expectedPairingPurpose(pairing.owner)
        )
      ) {
        return Result.fail(makeError(
          Codes.IncompleteSemanticPairing,
          `Timer fact does not satisfy the pending '${pairing.owner}' pairing`,
          historyIndex,
          {
            owner: pairing.owner,
            ownerEventId: pairing.ownerEventId,
            expectedTimerId: pairing.timerId,
            expectedTimerPurpose: expectedPairingPurpose(pairing.owner),
            actualTimerId: payload.timerId,
            actualAnchorEventId: payload.anchorEventId,
            actualTimerPurpose: payload.purpose._tag
          }
        ))
      }
      const timer: TimerState = {
        timerId: payload.timerId,
        purpose: payload.purpose,
        anchorEventId: payload.anchorEventId,
        delayMillis: payload.delayMillis,
        deadline: payload.deadline,
        status: "Pending",
        scheduledEventId: event.eventId,
        scheduledAt: event.recordedAt
      }
      const changes: Record<string, unknown> = {
        timers: setTimer(state, timer),
        pendingTimerPairing: undefined
      }
      if (payload.purpose._tag === "Sleep") {
        const sleep = getSleep(state, payload.purpose.waitId)!
        changes.sleeps = setSleep(state, {
          ...sleep,
          timerId: payload.timerId
        })
      }
      return Result.succeed(commit(state, event, changes))
    }
    case "TimerFired": {
      const timer = getTimer(state, payload.timerId)
      if (timer === undefined) {
        return Result.fail(makeError(
          Codes.TimerNotScheduled,
          `Timer '${payload.timerId}' fired before it was scheduled`,
          historyIndex,
          { timerId: payload.timerId }
        ))
      }
      const fireOrder = compareTimestamps(event.recordedAt, timer.deadline)
      if (
        timer.status !== "Pending" ||
        fireOrder === undefined ||
        fireOrder < 0 ||
        !timerMayFire(state, timer)
      ) {
        return Result.fail(makeError(
          Codes.IllegalTimerTransition,
          `Timer '${payload.timerId}' cannot fire from its current owner state or before its deadline`,
          historyIndex,
          { timerId: payload.timerId, status: timer.status }
        ))
      }
      const fired: TimerState = {
        ...timer,
        status: "Fired",
        firedAt: event.recordedAt
      }
      const changes: Record<string, unknown> = {
        timers: setTimer(state, fired)
      }
      if (timer.purpose._tag === "RetryBackoff") {
        const retry = getRetry(state, timer.purpose.retryId)!
        changes.retries = setRetry(state, {
          ...retry,
          status: "Ready"
        })
      } else if (timer.purpose._tag === "SignalExpiry") {
        const signal = getSignal(state, timer.purpose.signalId)!
        if (!canRemovePendingSignal(state, signal)) {
          return Result.fail(makeError(
            Codes.SignalAccountingMismatch,
            `Signal '${signal.signalId}' cannot be removed from pending accounting`,
            historyIndex,
            {
              signalId: signal.signalId,
              pendingSignalCount: state.pendingSignalCount,
              pendingSignalEncodedBytes: state.pendingSignalEncodedBytes,
              encodedPayloadBytes: signal.encodedPayloadBytes
            }
          ))
        }
        changes.signals = setSignal(state, {
          ...signal,
          status: "Expired",
          expiredAt: event.recordedAt
        })
        changes.pendingSignalCount = state.pendingSignalCount - 1
        changes.pendingSignalEncodedBytes = state.pendingSignalEncodedBytes -
          signal.encodedPayloadBytes
      } else if (timer.purpose._tag === "SignalWaitTimeout") {
        const wait = getSignalWait(state, timer.purpose.waitId)!
        changes.signalWaits = setSignalWait(state, {
          ...wait,
          status: "TimedOut",
          timerId: timer.timerId,
          completedAt: event.recordedAt
        })
      } else if (timer.purpose._tag === "Sleep") {
        const sleep = getSleep(state, timer.purpose.waitId)!
        changes.sleeps = setSleep(state, {
          ...sleep,
          status: "Completed",
          timerId: timer.timerId,
          completedAt: event.recordedAt
        })
      }
      return Result.succeed(commit(state, event, changes))
    }
    case "TimerCancelled": {
      const timer = getTimer(state, payload.timerId)
      if (timer === undefined) {
        return Result.fail(makeError(
          Codes.TimerNotScheduled,
          `Timer '${payload.timerId}' was cancelled before it was scheduled`,
          historyIndex,
          { timerId: payload.timerId }
        ))
      }
      if (timer.status !== "Pending") {
        return Result.fail(makeError(
          Codes.IllegalTimerTransition,
          `Only a pending timer can be cancelled`,
          historyIndex,
          { timerId: payload.timerId, status: timer.status }
        ))
      }
      if (!validTimerCancellationReason(state, timer, payload.reason)) {
        return Result.fail(makeError(
          state.status === "CancellationRequested"
            ? Codes.IllegalCancellationTransition
            : Codes.IllegalTimerTransition,
          `Timer cancellation reason '${payload.reason}' does not match its derived owner state`,
          historyIndex,
          {
            timerId: payload.timerId,
            purpose: timer.purpose._tag,
            reason: payload.reason,
            runStatus: state.status
          }
        ))
      }
      const cancelled: TimerState = {
        ...timer,
        status: "Cancelled",
        cancellationReason: payload.reason,
        cancelledAt: event.recordedAt
      }
      const changes: Record<string, unknown> = {
        timers: setTimer(state, cancelled)
      }
      if (timer.purpose._tag === "SignalExpiry") {
        const signal = getSignal(state, timer.purpose.signalId)
        if (signal === undefined) {
          return Result.fail(makeError(
            Codes.SignalNotFound,
            `Signal-expiry timer '${timer.timerId}' has no accepted owner`,
            historyIndex,
            { timerId: timer.timerId, signalId: timer.purpose.signalId }
          ))
        }
        if (signal.status === "Pending") {
          if (!canRemovePendingSignal(state, signal)) {
            return Result.fail(makeError(
              Codes.SignalAccountingMismatch,
              `Signal '${signal.signalId}' cannot be discarded from pending accounting`,
              historyIndex,
              {
                signalId: signal.signalId,
                pendingSignalCount: state.pendingSignalCount,
                pendingSignalEncodedBytes: state.pendingSignalEncodedBytes,
                encodedPayloadBytes: signal.encodedPayloadBytes
              }
            ))
          }
          changes.signals = setSignal(state, {
            ...signal,
            status: "Discarded",
            discardedAt: event.recordedAt
          })
          changes.pendingSignalCount = state.pendingSignalCount - 1
          changes.pendingSignalEncodedBytes = state.pendingSignalEncodedBytes -
            signal.encodedPayloadBytes
        }
      } else if (timer.purpose._tag === "SignalWaitTimeout") {
        const wait = getSignalWait(state, timer.purpose.waitId)
        if (wait === undefined) {
          return Result.fail(makeError(
            Codes.SignalWaitNotFound,
            `Signal-wait timer '${timer.timerId}' has no durable owner`,
            historyIndex,
            { timerId: timer.timerId, waitId: timer.purpose.waitId }
          ))
        }
        if (wait.status === "Pending") {
          changes.signalWaits = setSignalWait(state, {
            ...wait,
            status: "Cancelled",
            timerId: timer.timerId,
            completedAt: event.recordedAt
          })
        }
      } else if (timer.purpose._tag === "Sleep") {
        const sleep = getSleep(state, timer.purpose.waitId)
        if (sleep === undefined || sleep.status !== "Pending") {
          return Result.fail(makeError(
            Codes.IllegalSleepTransition,
            `Sleep timer '${timer.timerId}' has no pending owner to cancel`,
            historyIndex,
            { timerId: timer.timerId, waitId: timer.purpose.waitId }
          ))
        }
        changes.sleeps = setSleep(state, {
          ...sleep,
          status: "Cancelled",
          timerId: timer.timerId,
          completedAt: event.recordedAt
        })
      }
      return Result.succeed(commit(state, event, changes))
    }
    case "SignalAccepted": {
      if (getSignal(state, payload.signalId) !== undefined) {
        return Result.fail(makeError(
          Codes.DuplicateSignal,
          `Signal '${payload.signalId}' was already accepted`,
          historyIndex,
          { signalId: payload.signalId }
        ))
      }
      if (payload.inboxSequence !== state.nextInboxSequence) {
        return Result.fail(makeError(
          Codes.InboxSequenceMismatch,
          `Expected signal inbox sequence ${state.nextInboxSequence} but received ${payload.inboxSequence}`,
          historyIndex,
          { expected: state.nextInboxSequence, actual: payload.inboxSequence }
        ))
      }
      const expectedTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        "SignalExpiry",
        payload.signalId
      )
      const expiryDuration = durationMillisBetween(
        event.recordedAt,
        payload.expiresAt
      )
      const nextInboxSequence = checkedNonNegativeAdd(
        state.nextInboxSequence,
        1
      )
      const acceptedSignalCount = checkedNonNegativeAdd(
        state.acceptedSignalCount,
        1
      )
      const pendingSignalCount = checkedNonNegativeAdd(
        state.pendingSignalCount,
        1
      )
      const pendingSignalEncodedBytes = checkedNonNegativeAdd(
        state.pendingSignalEncodedBytes,
        payload.encodedPayloadBytes
      )
      const blobMismatch = payload.payload._tag === "Blob" &&
        payload.payload.ref.encodedBytes !== payload.encodedPayloadBytes
      if (
        payload.expiryTimerId !== expectedTimerId ||
        expiryDuration !== payload.ttlMillis ||
        blobMismatch
      ) {
        return Result.fail(makeError(
          Codes.TimerOwnershipMismatch,
          `Signal '${payload.signalId}' has invalid expiry or payload integrity facts`,
          historyIndex,
          {
            signalId: payload.signalId,
            expectedTimerId,
            actualTimerId: payload.expiryTimerId,
            ttlMillis: payload.ttlMillis,
            expiryDuration: expiryDuration ?? null,
            blobMismatch
          }
        ))
      }
      if (
        state.acceptedSignalCount !== state.nextInboxSequence ||
        nextInboxSequence === undefined ||
        acceptedSignalCount === undefined ||
        pendingSignalCount === undefined ||
        pendingSignalEncodedBytes === undefined
      ) {
        return Result.fail(makeError(
          Codes.SignalAccountingMismatch,
          `Signal '${payload.signalId}' would overflow or contradict inbox accounting`,
          historyIndex,
          {
            nextInboxSequence: state.nextInboxSequence,
            acceptedSignalCount: state.acceptedSignalCount,
            pendingSignalCount: state.pendingSignalCount,
            pendingSignalEncodedBytes: state.pendingSignalEncodedBytes,
            encodedPayloadBytes: payload.encodedPayloadBytes
          }
        ))
      }
      const signal: SignalState = {
        signalId: payload.signalId,
        inboxSequence: payload.inboxSequence,
        signalName: payload.signalName,
        signalVersion: payload.signalVersion,
        correlation: payload.correlation,
        signalDefinitionDigest: payload.signalDefinitionDigest,
        requestDigest: payload.requestDigest,
        payload: payload.payload,
        payloadDigest: payload.payloadDigest,
        encodedPayloadBytes: payload.encodedPayloadBytes,
        ttlMillis: payload.ttlMillis,
        admission: payload.admission,
        expiresAt: payload.expiresAt,
        expiryTimerId: payload.expiryTimerId,
        status: "Pending",
        acceptedEventId: event.eventId,
        acceptedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        signals: setSignal(state, signal),
        nextInboxSequence,
        acceptedSignalCount,
        pendingSignalCount,
        pendingSignalEncodedBytes,
        pendingTimerPairing: {
          owner: "SignalAccepted",
          ownerEventId: event.eventId,
          timerId: payload.expiryTimerId
        }
      }))
    }
    case "SignalWaitStarted": {
      const expectedWaitId = Identity.signalWaitId(
        event.tenantId,
        event.runId,
        payload.nodeInstanceId
      )
      if (payload.waitId !== expectedWaitId) {
        return Result.fail(makeError(
          Codes.SignalMatchMismatch,
          `Signal wait '${payload.waitId}' has a noncanonical owner identity`,
          historyIndex,
          { expectedWaitId, actualWaitId: payload.waitId }
        ))
      }
      if (getSignalWait(state, payload.waitId) !== undefined) {
        return Result.fail(makeError(
          Codes.DuplicateSignalWait,
          `Signal wait '${payload.waitId}' was already started`,
          historyIndex,
          { waitId: payload.waitId }
        ))
      }
      const wait: SignalWaitState = {
        waitId: payload.waitId,
        nodeId: payload.nodeId,
        nodeInstanceId: payload.nodeInstanceId,
        signalName: payload.signalName,
        signalVersion: payload.signalVersion,
        correlation: payload.correlation,
        timeout: payload.timeout,
        status: "Pending",
        startedEventId: event.eventId,
        startedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        signalWaits: setSignalWait(state, wait),
        pendingTimerPairing: payload.timeout._tag === "After"
          ? {
            owner: "SignalWaitStarted",
            ownerEventId: event.eventId,
            timerId: Identity.timerId(
              event.tenantId,
              event.runId,
              "SignalWaitTimeout",
              payload.waitId
            )
          }
          : undefined
      }))
    }
    case "SignalConsumed": {
      const signal = getSignal(state, payload.signalId)
      if (signal === undefined) {
        return Result.fail(makeError(
          Codes.SignalNotFound,
          `Signal '${payload.signalId}' was consumed before acceptance`,
          historyIndex,
          { signalId: payload.signalId }
        ))
      }
      const wait = getSignalWait(state, payload.waitId)
      if (wait === undefined) {
        return Result.fail(makeError(
          Codes.SignalWaitNotFound,
          `Signal wait '${payload.waitId}' was consumed before it started`,
          historyIndex,
          { waitId: payload.waitId }
        ))
      }
      if (
        signal.status !== "Pending" ||
        wait.status !== "Pending" ||
        signal.inboxSequence !== payload.inboxSequence
      ) {
        return Result.fail(makeError(
          Codes.IllegalSignalTransition,
          "Only a pending accepted signal and pending wait can be consumed",
          historyIndex,
          {
            signalId: payload.signalId,
            signalStatus: signal.status,
            waitId: payload.waitId,
            waitStatus: wait.status
          }
        ))
      }
      const expiryTimer = getTimer(state, signal.expiryTimerId)
      const waitTimerId = Identity.timerId(
        event.tenantId,
        event.runId,
        "SignalWaitTimeout",
        wait.waitId
      )
      const waitTimer = getTimer(state, waitTimerId)
      if (
        expiryTimer?.status !== "Pending" ||
        !enabledTimeoutIsPending(wait.timeout, waitTimer)
      ) {
        return Result.fail(makeError(
          Codes.IllegalSignalTransition,
          "Signal consumption requires every enabled expiry and wait timer to be pending",
          historyIndex,
          {
            signalId: signal.signalId,
            expiryTimerStatus: expiryTimer?.status ?? null,
            waitId: wait.waitId,
            waitTimerStatus: waitTimer?.status ?? null
          }
        ))
      }
      if (
        wait.nodeId !== payload.nodeId ||
        wait.nodeInstanceId !== payload.nodeInstanceId ||
        !matchingSignal(signal, wait)
      ) {
        return Result.fail(makeError(
          Codes.SignalMatchMismatch,
          `Signal '${payload.signalId}' does not match wait '${payload.waitId}'`,
          historyIndex,
          { signalId: payload.signalId, waitId: payload.waitId }
        ))
      }
      const oldest = oldestMatchingSignal(state, wait)
      if (oldest?.signalId !== signal.signalId) {
        return Result.fail(makeError(
          Codes.SignalOrderMismatch,
          `Signal '${payload.signalId}' is not the oldest matching pending signal`,
          historyIndex,
          {
            signalId: payload.signalId,
            expectedSignalId: oldest?.signalId ?? null,
            waitId: payload.waitId
          }
        ))
      }
      if (!canRemovePendingSignal(state, signal)) {
        return Result.fail(makeError(
          Codes.SignalAccountingMismatch,
          `Signal '${signal.signalId}' cannot be consumed from pending accounting`,
          historyIndex,
          {
            signalId: signal.signalId,
            pendingSignalCount: state.pendingSignalCount,
            pendingSignalEncodedBytes: state.pendingSignalEncodedBytes,
            encodedPayloadBytes: signal.encodedPayloadBytes
          }
        ))
      }
      const consumedSignal: SignalState = {
        ...signal,
        status: "Consumed",
        waitId: wait.waitId,
        consumedAt: event.recordedAt
      }
      const consumedWait: SignalWaitState = {
        ...wait,
        status: "Consumed",
        signalId: signal.signalId,
        inboxSequence: signal.inboxSequence,
        completedAt: event.recordedAt
      }
      return Result.succeed(commit(state, event, {
        signals: setSignal(state, consumedSignal),
        signalWaits: setSignalWait(state, consumedWait),
        pendingSignalCount: state.pendingSignalCount - 1,
        pendingSignalEncodedBytes: state.pendingSignalEncodedBytes -
          signal.encodedPayloadBytes
      }))
    }
    case "RunCancellationRequested": {
      const completeHead = validateDurableHead(state)
      if (Result.isFailure(completeHead)) {
        return Result.fail(completeHead.failure)
      }
      return Result.succeed(commit(state, event, {
        status: "CancellationRequested",
        cancellationRequestId: payload.requestId,
        cancellationRequestedAt: event.recordedAt
      }))
    }
    case "RunSucceeded": {
      const incompleteActivity = Array.from(HashMap.values(state.activities)).find(
        (activity) => activity.status !== "Succeeded"
      )
      const incompleteWait = Array.from(HashMap.values(state.signalWaits)).find(
        (wait) => wait.status !== "Consumed"
      )
      const incompleteSleep = Array.from(HashMap.values(state.sleeps)).find(
        (sleep) => sleep.status !== "Completed"
      )
      const pendingSignal = Array.from(HashMap.values(state.signals)).find(
        (signal) => signal.status === "Pending"
      )
      const pendingTimer = firstPendingTimer(state)
      if (
        incompleteActivity !== undefined ||
        incompleteWait !== undefined ||
        incompleteSleep !== undefined ||
        pendingSignal !== undefined ||
        state.pendingSignalCount !== 0 ||
        state.pendingSignalEncodedBytes !== 0 ||
        pendingTimer !== undefined
      ) {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          "Run cannot succeed with incomplete work, pending signals, or pending timers",
          historyIndex,
          {
            activityId: incompleteActivity?.logicalActivityId ?? null,
            waitId: incompleteWait?.waitId ?? null,
            sleepWaitId: incompleteSleep?.waitId ?? null,
            signalId: pendingSignal?.signalId ?? null,
            pendingSignalCount: state.pendingSignalCount,
            pendingSignalEncodedBytes: state.pendingSignalEncodedBytes,
            timerId: pendingTimer?.timerId ?? null
          }
        ))
      }
      return Result.succeed(commit(state, event, {
        status: "Succeeded",
        output: payload.output,
        completedAt: event.recordedAt
      }))
    }
    case "RunFailed": {
      let matches = false
      if (payload.cause._tag === "ActivityFailure") {
        const activity = getActivity(state, payload.cause.logicalActivityId)
        matches = activity !== undefined &&
          activity.status === "Failed" &&
          activity.nodeId === payload.cause.nodeId &&
          activity.nodeInstanceId === payload.cause.nodeInstanceId &&
          activity.currentAttemptId === payload.cause.attemptId &&
          activity.currentAttempt === payload.cause.attempt &&
          jsonEqual(activity.finalCause, payload.cause.cause)
      } else if (payload.cause._tag === "SignalWaitTimeout") {
        const wait = getSignalWait(state, payload.cause.waitId)
        matches = wait !== undefined &&
          wait.status === "TimedOut" &&
          wait.nodeId === payload.cause.nodeId &&
          wait.nodeInstanceId === payload.cause.nodeInstanceId &&
          wait.timerId === payload.cause.timerId
      } else {
        matches = state.status === "Running"
      }
      if (!matches) {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          "RunFailed does not match a derived final failure or authoritative protocol failure",
          historyIndex,
          { cause: payload.cause._tag }
        ))
      }
      const pendingTimer = firstPendingTimer(state)
      const pendingSignal = Array.from(HashMap.values(state.signals)).find(
        (signal) => signal.status === "Pending"
      )
      if (
        pendingTimer !== undefined ||
        pendingSignal !== undefined ||
        state.pendingSignalCount !== 0 ||
        state.pendingSignalEncodedBytes !== 0
      ) {
        return Result.fail(makeError(
          Codes.IllegalRunTransition,
          "Run cannot fail before pending timers and signals are cleaned up",
          historyIndex,
          {
            timerId: pendingTimer?.timerId ?? null,
            signalId: pendingSignal?.signalId ?? null,
            pendingSignalCount: state.pendingSignalCount,
            pendingSignalEncodedBytes: state.pendingSignalEncodedBytes,
            cause: payload.cause._tag
          }
        ))
      }
      return Result.succeed(commit(state, event, {
        status: "Failed",
        failure: payload.cause,
        signalWaits: cancelPendingSignalWaits(state, event.recordedAt),
        sleeps: cancelPendingSleeps(state, event.recordedAt),
        completedAt: event.recordedAt
      }))
    }
    case "RunCancelled": {
      const pendingTimer = firstPendingTimer(state)
      const pendingSignal = Array.from(HashMap.values(state.signals)).find(
        (signal) => signal.status === "Pending"
      )
      if (
        state.status !== "CancellationRequested" ||
        pendingTimer !== undefined ||
        pendingSignal !== undefined ||
        state.pendingSignalCount !== 0 ||
        state.pendingSignalEncodedBytes !== 0
      ) {
        return Result.fail(makeError(
          Codes.IllegalCancellationTransition,
          "RunCancelled requires a cancellation request and completed timer/signal cleanup",
          historyIndex,
          {
            status: state.status,
            timerId: pendingTimer?.timerId ?? null,
            signalId: pendingSignal?.signalId ?? null,
            pendingSignalCount: state.pendingSignalCount,
            pendingSignalEncodedBytes: state.pendingSignalEncodedBytes
          }
        ))
      }
      return Result.succeed(commit(state, event, {
        status: "Cancelled",
        signalWaits: cancelPendingSignalWaits(state, event.recordedAt),
        sleeps: cancelPendingSleeps(state, event.recordedAt),
        completedAt: event.recordedAt
      }))
    }
  }
}

/**
 * Applies one unknown protocol version 2 wire event to immutable state.
 *
 * @category folding
 * @since 4.0.0
 */
export const reduce = (
  state: RunState,
  event: unknown
): Result.Result<RunState, HistoryError> => {
  if (!isDerived(state)) {
    return Result.fail(makeError(
      Codes.InvalidState,
      "Protocol version 2 reduction requires exact immutable reducer state"
    ))
  }
  const decoded = snapshotEvent(event, state.sequence + 1)
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure)
    : apply(state, decoded.success, state.sequence + 1)
}

/**
 * Rebuilds immutable run state from a sequential protocol version 2 prefix.
 *
 * **Details**
 *
 * This lower-level fold may end between facts of one storage-atomic batch so a
 * transaction implementation can validate each event in order. Recovery,
 * import, query, and other committed-history consumers must use {@link fold},
 * which additionally verifies all required semantic pairings at the head.
 *
 * @category folding
 * @since 4.0.0
 */
export const foldPrefix = (
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
      "Protocol version 2 workflow history must be an array"
    ))
  }
  if (snapshot.length === 0) {
    return Result.fail(makeError(
      Codes.EmptyHistory,
      "Protocol version 2 workflow history must contain RunStarted"
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
  if (instant(first.success.recordedAt) === undefined) {
    return Result.fail(makeError(
      Codes.TimestampRegression,
      "First event recordedAt must identify an orderable instant",
      0,
      { actualRecordedAt: first.success.recordedAt }
    ))
  }
  const identityError = validateEventId(undefined, first.success, 0)
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

/**
 * Verifies storage-atomic semantic pairings at a committed history head.
 *
 * **Details**
 *
 * Sequential replay deliberately accepts the first fact of a multi-event
 * transaction while folding that transaction. An authoritative store or
 * imported history must call this after the complete committed batch. It
 * rejects truncated owner facts, missing live timers, and signal-accounting
 * drift that ordinary event-by-event validation cannot identify at an
 * intermediate sequence.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateDurableHead = (
  state: RunState
): Result.Result<RunState, HistoryError> => {
  if (!isDerived(state)) {
    return Result.fail(makeError(
      Codes.InvalidState,
      "Durable-head validation requires exact immutable reducer state"
    ))
  }
  if (state.pendingTimerPairing !== undefined) {
    return Result.fail(makeError(
      Codes.IncompleteSemanticPairing,
      `'${state.pendingTimerPairing.owner}' lacks its immediately paired timer fact`,
      state.sequence,
      {
        owner: state.pendingTimerPairing.owner,
        ownerEventId: state.pendingTimerPairing.ownerEventId,
        expectedTimerId: state.pendingTimerPairing.timerId,
        expectedTimerPurpose: expectedPairingPurpose(
          state.pendingTimerPairing.owner
        )
      }
    ))
  }

  if (state.status === "Running") {
    for (const activity of HashMap.values(state.activities)) {
      if (
        activity.status !== "Active" &&
        activity.status !== "RetryPending"
      ) {
        continue
      }
      const scheduleToClose = activity.policy.timeouts.scheduleToClose
      if (scheduleToClose._tag === "After") {
        const timerId = Identity.timerId(
          state.tenantId,
          state.runId,
          "ScheduleToClose",
          activity.logicalActivityId
        )
        const timer = getTimer(state, timerId)
        if (
          timer === undefined ||
          timer.status !== "Pending" ||
          timer.purpose._tag !== "ScheduleToClose" ||
          timer.purpose.logicalActivityId !== activity.logicalActivityId ||
          timer.anchorEventId !== activity.firstScheduledEventId ||
          timer.delayMillis !== scheduleToClose.durationMillis
        ) {
          return Result.fail(makeError(
            Codes.IncompleteSemanticPairing,
            `Live activity '${activity.logicalActivityId}' lacks its exact schedule-to-close timer`,
            state.sequence,
            {
              logicalActivityId: activity.logicalActivityId,
              timerId,
              timerStatus: timer?.status ?? null,
              timerPurpose: timer?.purpose._tag ?? null
            }
          ))
        }
      }

      if (activity.status !== "Active") {
        continue
      }
      const attempt = getAttempt(activity)
      if (
        attempt?.status === "Scheduled" &&
        activity.policy.timeouts.scheduleToStart._tag === "After"
      ) {
        const timeout = activity.policy.timeouts.scheduleToStart
        const timerId = Identity.timerId(
          state.tenantId,
          state.runId,
          "ScheduleToStart",
          attempt.attemptId
        )
        const timer = getTimer(state, timerId)
        if (
          timer === undefined ||
          timer.status !== "Pending" ||
          timer.purpose._tag !== "ScheduleToStart" ||
          timer.purpose.logicalActivityId !== activity.logicalActivityId ||
          timer.purpose.attemptId !== attempt.attemptId ||
          timer.purpose.attempt !== attempt.attempt ||
          timer.anchorEventId !== attempt.scheduledEventId ||
          timer.delayMillis !== timeout.durationMillis
        ) {
          return Result.fail(makeError(
            Codes.IncompleteSemanticPairing,
            `Scheduled attempt '${attempt.attemptId}' lacks its exact schedule-to-start timer`,
            state.sequence,
            {
              attemptId: attempt.attemptId,
              timerId,
              timerStatus: timer?.status ?? null,
              timerPurpose: timer?.purpose._tag ?? null
            }
          ))
        }
      }
      if (
        attempt?.status === "Started" &&
        activity.policy.timeouts.startToClose._tag === "After"
      ) {
        const timeout = activity.policy.timeouts.startToClose
        const timerId = Identity.timerId(
          state.tenantId,
          state.runId,
          "StartToClose",
          attempt.attemptId
        )
        const timer = getTimer(state, timerId)
        if (
          attempt.startedEventId === undefined ||
          timer === undefined ||
          timer.status !== "Pending" ||
          timer.purpose._tag !== "StartToClose" ||
          timer.purpose.logicalActivityId !== activity.logicalActivityId ||
          timer.purpose.attemptId !== attempt.attemptId ||
          timer.purpose.attempt !== attempt.attempt ||
          timer.anchorEventId !== attempt.startedEventId ||
          timer.delayMillis !== timeout.durationMillis
        ) {
          return Result.fail(makeError(
            Codes.IncompleteSemanticPairing,
            `Started attempt '${attempt.attemptId}' lacks its exact start-to-close timer`,
            state.sequence,
            {
              attemptId: attempt.attemptId,
              timerId,
              timerStatus: timer?.status ?? null,
              timerPurpose: timer?.purpose._tag ?? null
            }
          ))
        }
      }
    }

    for (const retry of HashMap.values(state.retries)) {
      if (retry.status !== "WaitingForTimer") {
        continue
      }
      const timer = getTimer(state, retry.timerId)
      const activity = getActivity(state, retry.logicalActivityId)
      const ownerFailed = activity?.status === "Failed" &&
        activity.pendingRetryId === retry.retryId
      if (
        timer === undefined ||
        timer.status !== (ownerFailed ? "Cancelled" : "Pending") ||
        timer.purpose._tag !== "RetryBackoff" ||
        timer.purpose.retryId !== retry.retryId ||
        timer.purpose.logicalActivityId !== retry.logicalActivityId ||
        timer.purpose.nextAttempt !== retry.nextAttempt ||
        timer.anchorEventId !== retry.anchorEventId ||
        timer.delayMillis !== retry.selectedDelayMillis ||
        timer.deadline !== retry.deadline
      ) {
        return Result.fail(makeError(
          Codes.IncompleteSemanticPairing,
          ownerFailed
            ? `Failed retry owner '${retry.retryId}' lacks its exact cancelled backoff timer`
            : `Retry '${retry.retryId}' lacks its exact live backoff timer`,
          state.sequence,
          {
            retryId: retry.retryId,
            timerId: retry.timerId,
            timerStatus: timer?.status ?? null,
            timerPurpose: timer?.purpose._tag ?? null,
            activityStatus: activity?.status ?? null
          }
        ))
      }
    }
  }

  let acceptedSignalCount = 0
  let pendingSignalCount = 0
  let pendingSignalEncodedBytes = 0
  for (const signal of HashMap.values(state.signals)) {
    acceptedSignalCount++
    if (signal.status !== "Pending") {
      continue
    }
    pendingSignalCount++
    const nextBytes = checkedNonNegativeAdd(
      pendingSignalEncodedBytes,
      signal.encodedPayloadBytes
    )
    if (nextBytes === undefined) {
      return Result.fail(makeError(
        Codes.SignalAccountingMismatch,
        "Pending signal bytes exceed exact safe-integer accounting",
        state.sequence,
        { signalId: signal.signalId }
      ))
    }
    pendingSignalEncodedBytes = nextBytes
    const timer = getTimer(state, signal.expiryTimerId)
    if (
      timer === undefined ||
      timer.status !== "Pending" ||
      timer.purpose._tag !== "SignalExpiry" ||
      timer.purpose.signalId !== signal.signalId ||
      timer.purpose.inboxSequence !== signal.inboxSequence ||
      timer.anchorEventId !== signal.acceptedEventId ||
      timer.delayMillis !== signal.ttlMillis
    ) {
      return Result.fail(makeError(
        Codes.IncompleteSemanticPairing,
        `Pending signal '${signal.signalId}' lacks its exact live expiry timer`,
        state.sequence,
        {
          signalId: signal.signalId,
          expiryTimerId: signal.expiryTimerId,
          timerStatus: timer?.status ?? null,
          timerPurpose: timer?.purpose._tag ?? null
        }
      ))
    }
  }
  if (
    acceptedSignalCount !== state.acceptedSignalCount ||
    acceptedSignalCount !== state.nextInboxSequence ||
    pendingSignalCount !== state.pendingSignalCount ||
    pendingSignalEncodedBytes !== state.pendingSignalEncodedBytes
  ) {
    return Result.fail(makeError(
      Codes.SignalAccountingMismatch,
      "Derived signal counts and bytes do not match retained run accounting",
      state.sequence,
      {
        expectedAcceptedSignalCount: acceptedSignalCount,
        actualAcceptedSignalCount: state.acceptedSignalCount,
        nextInboxSequence: state.nextInboxSequence,
        expectedPendingSignalCount: pendingSignalCount,
        actualPendingSignalCount: state.pendingSignalCount,
        expectedPendingSignalEncodedBytes: pendingSignalEncodedBytes,
        actualPendingSignalEncodedBytes: state.pendingSignalEncodedBytes
      }
    ))
  }

  for (const wait of HashMap.values(state.signalWaits)) {
    if (wait.status !== "Pending" || wait.timeout._tag !== "After") {
      continue
    }
    const timerId = Identity.timerId(
      state.tenantId,
      state.runId,
      "SignalWaitTimeout",
      wait.waitId
    )
    const timer = getTimer(state, timerId)
    if (
      timer === undefined ||
      timer.status !== "Pending" ||
      timer.purpose._tag !== "SignalWaitTimeout" ||
      timer.purpose.waitId !== wait.waitId ||
      timer.anchorEventId !== wait.startedEventId ||
      timer.delayMillis !== wait.timeout.durationMillis
    ) {
      return Result.fail(makeError(
        Codes.IncompleteSemanticPairing,
        `Pending signal wait '${wait.waitId}' lacks its exact live timeout timer`,
        state.sequence,
        {
          waitId: wait.waitId,
          timerId,
          timerStatus: timer?.status ?? null,
          timerPurpose: timer?.purpose._tag ?? null
        }
      ))
    }
  }

  for (const sleep of HashMap.values(state.sleeps)) {
    if (sleep.status !== "Pending") {
      continue
    }
    const timerId = Identity.timerId(
      state.tenantId,
      state.runId,
      "Sleep",
      sleep.waitId
    )
    const timer = getTimer(state, timerId)
    if (
      sleep.timerId !== timerId ||
      timer === undefined ||
      timer.status !== "Pending" ||
      timer.purpose._tag !== "Sleep" ||
      timer.purpose.waitId !== sleep.waitId ||
      timer.anchorEventId !== sleep.startedEventId ||
      timer.delayMillis !== sleep.durationMillis
    ) {
      return Result.fail(makeError(
        Codes.IncompleteSemanticPairing,
        `Pending sleep '${sleep.waitId}' lacks its exact live timer`,
        state.sequence,
        {
          waitId: sleep.waitId,
          timerId,
          retainedTimerId: sleep.timerId ?? null,
          timerStatus: timer?.status ?? null,
          timerPurpose: timer?.purpose._tag ?? null
        }
      ))
    }
  }

  for (const timer of HashMap.values(state.timers)) {
    if (
      timer.status === "Pending" &&
      (
        !timerMayFire(state, timer) ||
        state.status === "CancellationRequested"
      )
    ) {
      return Result.fail(makeError(
        Codes.IncompleteSemanticPairing,
        `Pending timer '${timer.timerId}' requires owner-transition cleanup in the committed batch`,
        state.sequence,
        {
          timerId: timer.timerId,
          purpose: timer.purpose._tag,
          runStatus: state.status
        }
      ))
    }
  }

  return Result.succeed(state)
}

/**
 * Rebuilds immutable state from one complete committed protocol version 2
 * history.
 *
 * **Details**
 *
 * In addition to strict sequential replay, this public recovery boundary
 * rejects a history truncated between owner and timer facts or between an
 * owner transition and required timer cleanup.
 *
 * @category folding
 * @since 4.0.0
 */
export const fold = (
  history: unknown
): Result.Result<RunState, HistoryError> => {
  const state = foldPrefix(history)
  return Result.isFailure(state)
    ? state
    : validateDurableHead(state.success)
}
