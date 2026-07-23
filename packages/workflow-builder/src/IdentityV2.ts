/**
 * Collision-free protocol version 2 identities shared by workflow engine
 * boundaries.
 *
 * @since 4.0.0
 */

const namespace = "@effect/workflow-builder" as const

/**
 * Identity tuple version used by protocol version 2.
 *
 * @category constants
 * @since 4.0.0
 */
export const IdentityVersion = 2 as const

/**
 * Timer-owner kinds admitted by protocol version 2 identity helpers.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerOwnerKind =
  | "RetryBackoff"
  | "ScheduleToStart"
  | "StartToClose"
  | "ScheduleToClose"
  | "SignalExpiry"
  | "SignalWaitTimeout"
  | "Sleep"

/**
 * Activity-attempt timeout kinds admitted by protocol version 2 identities.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityAttemptTimeoutKind = "ScheduleToStart" | "StartToClose"

const identity = (
  kind: string,
  ...parts: ReadonlyArray<string | number>
): string => JSON.stringify([namespace, IdentityVersion, kind, ...parts])

/**
 * Returns the stable tenant-scoped identity of one logical activity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const logicalActivityId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("LogicalActivity", tenantId, runId, nodeInstanceId)

/**
 * Returns the stable tenant-scoped identity of one semantic activity attempt.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityAttemptId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("ActivityAttempt", tenantId, runId, nodeInstanceId, attempt)

/**
 * Returns the default external idempotency key for one logical activity.
 *
 * **Details**
 *
 * The semantic attempt is deliberately absent so policy retries retain the
 * same external idempotency identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityIdempotencyKey = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("ActivityIdempotencyKey", tenantId, runId, nodeInstanceId)

/**
 * Returns the shared identity of an activity-attempt schedule command and
 * event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleActivityCommandId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("ScheduleActivity", tenantId, runId, nodeInstanceId, attempt)

/**
 * Returns the stable identity of an activity-attempt started event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityAttemptStartedEventId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("ActivityAttemptStarted", tenantId, runId, nodeInstanceId, attempt)

/**
 * Returns the stable identity of an activity-attempt failed event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityAttemptFailedEventId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("ActivityAttemptFailed", tenantId, runId, nodeInstanceId, attempt)

/**
 * Returns the stable identity of an activity-attempt timed-out event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityAttemptTimedOutEventId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  attempt: number,
  timeoutKind: ActivityAttemptTimeoutKind
): string =>
  identity(
    "ActivityAttemptTimedOut",
    tenantId,
    runId,
    nodeInstanceId,
    attempt,
    timeoutKind
  )

/**
 * Returns the stable identity of a successful logical-activity result event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activitySucceededEventId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("ActivitySucceeded", tenantId, runId, nodeInstanceId, attempt)

/**
 * Returns the shared identity of a final activity-failure command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const finalizeActivityFailureCommandId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("FinalizeActivityFailure", tenantId, runId, nodeInstanceId)

/**
 * Returns the stable identity of one admitted semantic retry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const retryId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  nextAttempt: number
): string => identity("Retry", tenantId, runId, nodeInstanceId, nextAttempt)

/**
 * Returns the shared identity of a retry-schedule command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleRetryCommandId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string,
  nextAttempt: number
): string => identity("ScheduleRetry", tenantId, runId, nodeInstanceId, nextAttempt)

/**
 * Returns the stable identity of one semantic timer.
 *
 * @category constructors
 * @since 4.0.0
 */
export const timerId = (
  tenantId: string,
  runId: string,
  ownerKind: TimerOwnerKind,
  ownerId: string
): string => identity("Timer", tenantId, runId, ownerKind, ownerId)

/**
 * Returns the shared identity of a timer-schedule command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleTimerCommandId = (
  tenantId: string,
  runId: string,
  timerId: string
): string => identity("ScheduleTimer", tenantId, runId, timerId)

/**
 * Returns the stable identity of a timer-fired event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const timerFiredEventId = (
  tenantId: string,
  runId: string,
  timerId: string
): string => identity("TimerFired", tenantId, runId, timerId)

/**
 * Returns the shared identity of a timer-cancellation command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cancelTimerCommandId = (
  tenantId: string,
  runId: string,
  timerId: string
): string => identity("CancelTimer", tenantId, runId, timerId)

/**
 * Returns the stable identity of an accepted external signal event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const signalAcceptedEventId = (
  tenantId: string,
  runId: string,
  signalId: string
): string => identity("SignalAccepted", tenantId, runId, signalId)

/**
 * Returns the stable identity of one signal wait.
 *
 * @category constructors
 * @since 4.0.0
 */
export const signalWaitId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("SignalWait", tenantId, runId, nodeInstanceId)

/**
 * Returns the shared identity of a signal-wait start command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const startSignalWaitCommandId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("StartSignalWait", tenantId, runId, nodeInstanceId)

/**
 * Returns the stable identity of one structured sleep wait.
 *
 * @category constructors
 * @since 4.0.0
 */
export const sleepWaitId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("SleepWait", tenantId, runId, nodeInstanceId)

/**
 * Returns the shared identity of a sleep-start command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const startSleepCommandId = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("StartSleep", tenantId, runId, nodeInstanceId)

/**
 * Returns the shared identity of a signal-consumption command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const consumeSignalCommandId = (
  tenantId: string,
  runId: string,
  waitId: string,
  signalId: string
): string => identity("ConsumeSignal", tenantId, runId, waitId, signalId)

/**
 * Returns the stable identity of a run-start event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const runStartedEventId = (
  tenantId: string,
  runId: string
): string => identity("RunStarted", tenantId, runId)

/**
 * Returns the stable identity of an externally requested run cancellation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const runCancellationRequestedEventId = (
  tenantId: string,
  runId: string,
  requestId: string
): string => identity("RunCancellationRequested", tenantId, runId, requestId)

/**
 * Returns the shared identity of a succeed-run command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const succeedRunCommandId = (
  tenantId: string,
  runId: string
): string => identity("SucceedRun", tenantId, runId)

/**
 * Returns the shared identity of a fail-run command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failRunCommandId = (
  tenantId: string,
  runId: string
): string => identity("FailRun", tenantId, runId)

/**
 * Returns the shared identity of a cancel-run command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cancelRunCommandId = (
  tenantId: string,
  runId: string
): string => identity("CancelRun", tenantId, runId)
