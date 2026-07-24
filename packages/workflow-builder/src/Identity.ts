/**
 * Collision-free version 1 identities shared by workflow engine boundaries.
 *
 * @since 4.0.0
 */

const namespace = "@effect/workflow-builder" as const
const version = 1 as const

const identity = (
  kind: string,
  ...parts: ReadonlyArray<string | number>
): string => JSON.stringify([namespace, version, kind, ...parts])

/**
 * Returns the stable identity of an activity attempt.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityId = (
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("Activity", runId, nodeInstanceId, attempt)

/**
 * Returns the stable external idempotency key for an activity node instance.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityIdempotencyKey = (
  runId: string,
  nodeInstanceId: string
): string => identity("ActivityIdempotencyKey", runId, nodeInstanceId)

/**
 * Returns the stable tenant-scoped external idempotency key for durable work.
 *
 * @category constructors
 * @since 4.0.0
 */
export const durableActivityIdempotencyKey = (
  tenantId: string,
  runId: string,
  nodeInstanceId: string
): string => identity("DurableActivityIdempotencyKey", tenantId, runId, nodeInstanceId)

/**
 * Returns the stable user idempotency key of one native queued node attempt.
 *
 * @category constructors
 * @since 4.0.0
 */
export const nativeNodeAttemptWorkIdempotencyKey = (
  routeDigest: string,
  operationDigest: string
): string => identity("NativeNodeAttemptWork", routeDigest, operationDigest)

/**
 * Returns the shared identity of a schedule command and its scheduled event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleActivityCommandId = (
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string => identity("ScheduleActivity", runId, nodeInstanceId, attempt)

/**
 * Returns the globally stable broker identity of a tenant-scoped dispatch.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityBrokerMessageId = (
  tenantId: string,
  intentId: string
): string => identity("ActivityBrokerMessage", tenantId, intentId)

/**
 * Returns the stable identity of a run-start event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const runStartedEventId = (runId: string): string => identity("RunStarted", runId)

/**
 * Returns the stable identity of an externally requested run cancellation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const runCancellationRequestedEventId = (
  runId: string,
  requestId: string
): string => identity("RunCancellationRequested", runId, requestId)

/**
 * Returns the stable identity of a successful activity-result event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activitySucceededEventId = (activityId: string): string => identity("ActivitySucceeded", activityId)

/**
 * Returns the stable identity of a failed activity-result event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityFailedEventId = (activityId: string): string => identity("ActivityFailed", activityId)

/**
 * Returns the shared identity of a succeed-run command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const succeedRunCommandId = (runId: string): string => identity("SucceedRun", runId)

/**
 * Returns the shared identity of a fail-run command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failRunCommandId = (runId: string): string => identity("FailRun", runId)

/**
 * Returns the shared identity of a cancel-run command and event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cancelRunCommandId = (runId: string): string => identity("CancelRun", runId)
