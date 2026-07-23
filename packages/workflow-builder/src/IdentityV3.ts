/**
 * Collision-free protocol version `3` identities shared by parent-child
 * workflow boundaries.
 *
 * **Details**
 *
 * Each identity is the JSON serialization of a domain, tuple version,
 * semantic kind, and ordered coordinates. JSON tuple framing preserves the
 * exact historical wire values while avoiding delimiter and tuple-boundary
 * collisions.
 *
 * @since 4.0.0
 */

const namespace = "@effect/workflow-builder" as const

/**
 * Identity tuple version used by execution protocol version `3`.
 *
 * @category constants
 * @since 4.0.0
 */
export const IdentityVersion = 3 as const

const identity = (
  kind: string,
  ...parts: ReadonlyArray<string | number>
): string => JSON.stringify([namespace, IdentityVersion, kind, ...parts])

/**
 * Returns the stable identity of one child call site in a parent run.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCallId = (
  tenantId: string,
  parentRunId: string,
  nodeInstanceId: string
): string => identity("ChildCall", tenantId, parentRunId, nodeInstanceId)

/**
 * Returns the deterministic run identifier reserved for one child relation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childRunId = (
  tenantId: string,
  parentRunId: string,
  callId: string
): string => identity("ChildRun", tenantId, parentRunId, callId)

/**
 * Returns the deterministic durable-start request identifier for one child.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartRequestId = (
  tenantId: string,
  parentRunId: string,
  callId: string
): string => identity("ChildStartRequest", tenantId, parentRunId, callId)

/**
 * Returns the shared schedule command and event identity for one child call.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleChildCommandId = (
  tenantId: string,
  parentRunId: string,
  callId: string
): string => identity("ScheduleChild", tenantId, parentRunId, callId)

/**
 * Returns the parent projection identity for a canonical child start event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartProjectionEventId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  childRunStartedEventId: string
): string =>
  identity(
    "ChildStartProjection",
    tenantId,
    parentRunId,
    callId,
    childRunStartedEventId
  )

/**
 * Returns the parent projection identity for a canonical child terminal event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childTerminalProjectionEventId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  childTerminalEventId: string
): string =>
  identity(
    "ChildTerminalProjection",
    tenantId,
    parentRunId,
    callId,
    childTerminalEventId
  )

/**
 * Returns the cancellation command identity for one parent close cause.
 *
 * @category constructors
 * @since 4.0.0
 */
export const requestChildCancellationCommandId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  parentCauseEventId: string
): string =>
  identity(
    "RequestChildCancellation",
    tenantId,
    parentRunId,
    callId,
    parentCauseEventId
  )

/**
 * Returns the parent acknowledgement identity for a child cancellation fact.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCancellationAcceptedEventId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  childCancellationEventId: string
): string =>
  identity(
    "ChildCancellationAccepted",
    tenantId,
    parentRunId,
    callId,
    childCancellationEventId
  )

/**
 * Returns the terminal relation identity when close wins before child start.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCancelledBeforeStartEventId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  parentCauseEventId: string
): string =>
  identity(
    "ChildCancelledBeforeStart",
    tenantId,
    parentRunId,
    callId,
    parentCauseEventId
  )

/**
 * Returns the durable abandon identity for one parent close cause.
 *
 * @category constructors
 * @since 4.0.0
 */
export const abandonChildEventId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  parentCauseEventId: string
): string =>
  identity(
    "AbandonChild",
    tenantId,
    parentRunId,
    callId,
    parentCauseEventId
  )

/**
 * Returns the durable identity of a permanent child-start failure.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartFailedEventId = (
  tenantId: string,
  parentRunId: string,
  callId: string,
  startRequestId: string
): string =>
  identity(
    "ChildStartFailed",
    tenantId,
    parentRunId,
    callId,
    startRequestId
  )

/**
 * Returns the canonical recursion family identity for one workflow
 * definition identifier.
 *
 * **Details**
 *
 * Definition versions, artifacts, and deployments deliberately share this
 * identity. Recursion therefore cannot be hidden by selecting another build or
 * revision of the same workflow family.
 *
 * @category constructors
 * @since 4.0.0
 */
export const workflowFamilyIdentity = (
  definitionId: string
): string => identity("WorkflowFamily", definitionId)
