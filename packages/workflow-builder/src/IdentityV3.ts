/**
 * Collision-free protocol version `3` identities shared by parent-child
 * workflow boundaries.
 *
 * **Details**
 *
 * Each identity uses typed, UTF-8-byte-length-prefixed fields for a domain, tuple
 * version, semantic kind, and ordered coordinates. The framing preserves
 * arbitrary strings without escaping them again when a child identifier
 * becomes its descendant's parent coordinate.
 *
 * Child-derived identities expand a canonical call back to its tenant, parent,
 * and node-instance coordinates instead of embedding both the parent and a
 * call that already contains that parent. Nested child-run identifiers
 * therefore grow linearly with lineage depth rather than exponentially.
 *
 * @since 4.0.0
 */

import {
  MaximumAtomicIdentifierBytes,
  MaximumIdentifierBytes,
  MaximumLineageIdentifierBytes,
  MaximumSourceEventIdentifierBytes
} from "./ProtocolV3Wire.ts"

const namespace = "@effect/workflow-builder" as const

/**
 * Identity tuple version used by execution protocol version `3`.
 *
 * @category constants
 * @since 4.0.0
 */
export const IdentityVersion = 3 as const

const utf8Length = (value: string): number | undefined => {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return undefined
      }
      bytes += 4
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return undefined
    } else {
      bytes += 3
    }
  }
  return bytes
}

const withinBound = (value: string, maximumBytes: number): boolean => {
  if (value.length > maximumBytes) {
    return false
  }
  const bytes = utf8Length(value)
  return bytes !== undefined && bytes <= maximumBytes
}

const assertBound = (
  value: string,
  maximumBytes: number,
  label: string
): void => {
  if (value.length > maximumBytes) {
    throw new RangeError(
      `Protocol V3 ${label} cannot exceed ${maximumBytes} UTF-8 bytes`
    )
  }
  const bytes = utf8Length(value)
  if (bytes === undefined) {
    throw new TypeError(
      `Protocol V3 ${label} must contain only Unicode scalar values`
    )
  }
  if (bytes > maximumBytes) {
    throw new RangeError(
      `Protocol V3 ${label} cannot exceed ${maximumBytes} UTF-8 bytes`
    )
  }
}

const assertAtomic = (value: string, label: string): void => assertBound(value, MaximumAtomicIdentifierBytes, label)

const assertLineage = (value: string, label: string): void => assertBound(value, MaximumLineageIdentifierBytes, label)

const assertSourceEvent = (value: string, label: string): void =>
  assertBound(value, MaximumSourceEventIdentifierBytes, label)

const field = (value: string | number): string => {
  const text = String(value)
  if (text.length > MaximumIdentifierBytes) {
    throw new RangeError(
      `Protocol V3 identity coordinates cannot exceed ${MaximumIdentifierBytes} UTF-8 bytes`
    )
  }
  const length = utf8Length(text)
  if (length === undefined) {
    throw new TypeError(
      "Protocol V3 identity coordinates must contain only Unicode scalar values"
    )
  }
  return `${typeof value === "number" ? "n" : "s"}${length}:${text}`
}

const identity = (
  kind: string,
  ...parts: ReadonlyArray<string | number>
): string => {
  const value = [
    field(namespace),
    field(IdentityVersion),
    field(kind),
    ...parts.map(field)
  ].join("")
  const bytes = utf8Length(value)
  if (bytes === undefined || bytes > MaximumIdentifierBytes) {
    throw new RangeError(
      `Protocol V3 identities cannot exceed ${MaximumIdentifierBytes} UTF-8 bytes`
    )
  }
  return value
}

interface FramedField {
  readonly type: "n" | "s"
  readonly value: string
}

const parseFields = (input: string): ReadonlyArray<FramedField> | undefined => {
  if (input.length > MaximumIdentifierBytes) {
    return undefined
  }
  const output: Array<FramedField> = []
  let offset = 0
  while (offset < input.length) {
    if (output.length === 6) {
      return undefined
    }
    const type = input[offset]
    if (type !== "n" && type !== "s") {
      return undefined
    }
    const colon = input.indexOf(":", offset + 1)
    if (colon < 0) {
      return undefined
    }
    const lengthText = input.slice(offset + 1, colon)
    if (!/^(?:0|[1-9][0-9]*)$/.test(lengthText)) {
      return undefined
    }
    const byteLength = Number(lengthText)
    if (!Number.isSafeInteger(byteLength)) {
      return undefined
    }
    const start = colon + 1
    let end = start
    let consumedBytes = 0
    while (end < input.length && consumedBytes < byteLength) {
      const code = input.charCodeAt(end)
      if (code <= 0x7f) {
        consumedBytes++
        end++
      } else if (code <= 0x7ff) {
        consumedBytes += 2
        end++
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(end + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return undefined
        }
        consumedBytes += 4
        end += 2
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return undefined
      } else {
        consumedBytes += 3
        end++
      }
    }
    if (consumedBytes !== byteLength) {
      return undefined
    }
    const value = input.slice(start, end)
    if (
      type === "n" &&
      (!/^-?(?:0|[1-9][0-9]*)$/.test(value) || String(Number(value)) !== value)
    ) {
      return undefined
    }
    output.push({ type, value })
    offset = end
  }
  return output
}

const callCoordinates = (
  tenantId: string,
  parentRunId: string,
  callId: string
): ReadonlyArray<string> => {
  assertAtomic(tenantId, "tenant identifier")
  assertLineage(parentRunId, "parent-run identifier")
  assertLineage(callId, "child-call identifier")
  const fields = parseFields(callId)
  if (
    fields?.length === 6 &&
    fields[0]?.type === "s" &&
    fields[0].value === namespace &&
    fields[1]?.type === "n" &&
    fields[1].value === String(IdentityVersion) &&
    fields[2]?.type === "s" &&
    fields[2].value === "ChildCall" &&
    fields[3]?.type === "s" &&
    fields[3].value === tenantId &&
    fields[4]?.type === "s" &&
    fields[4].value === parentRunId &&
    fields[5]?.type === "s" &&
    withinBound(fields[5].value, MaximumAtomicIdentifierBytes)
  ) {
    return ["CanonicalCall", tenantId, parentRunId, fields[5].value]
  }
  assertSourceEvent(callId, "opaque child-call identifier")
  return ["OpaqueCall", tenantId, parentRunId, callId]
}

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
): string => {
  assertAtomic(tenantId, "tenant identifier")
  assertLineage(parentRunId, "parent-run identifier")
  assertAtomic(nodeInstanceId, "node-instance identifier")
  return identity("ChildCall", tenantId, parentRunId, nodeInstanceId)
}

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
): string => identity("ChildRun", ...callCoordinates(tenantId, parentRunId, callId))

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
): string =>
  identity(
    "ChildStartRequest",
    ...callCoordinates(tenantId, parentRunId, callId)
  )

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
): string => identity("ScheduleChild", ...callCoordinates(tenantId, parentRunId, callId))

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
): string => {
  assertSourceEvent(childRunStartedEventId, "child-start event identifier")
  return identity(
    "ChildStartProjection",
    ...callCoordinates(tenantId, parentRunId, callId),
    childRunStartedEventId
  )
}

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
): string => {
  assertSourceEvent(childTerminalEventId, "child-terminal event identifier")
  return identity(
    "ChildTerminalProjection",
    ...callCoordinates(tenantId, parentRunId, callId),
    childTerminalEventId
  )
}

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
): string => {
  assertSourceEvent(parentCauseEventId, "parent-cause event identifier")
  return identity(
    "RequestChildCancellation",
    ...callCoordinates(tenantId, parentRunId, callId),
    parentCauseEventId
  )
}

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
): string => {
  assertSourceEvent(
    childCancellationEventId,
    "child-cancellation event identifier"
  )
  return identity(
    "ChildCancellationAccepted",
    ...callCoordinates(tenantId, parentRunId, callId),
    childCancellationEventId
  )
}

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
): string => {
  assertSourceEvent(parentCauseEventId, "parent-cause event identifier")
  return identity(
    "ChildCancelledBeforeStart",
    ...callCoordinates(tenantId, parentRunId, callId),
    parentCauseEventId
  )
}

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
): string => {
  assertSourceEvent(parentCauseEventId, "parent-cause event identifier")
  return identity(
    "AbandonChild",
    ...callCoordinates(tenantId, parentRunId, callId),
    parentCauseEventId
  )
}

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
): string => {
  const coordinates = callCoordinates(tenantId, parentRunId, callId)
  const canonicalStartRequest = identity(
    "ChildStartRequest",
    ...coordinates
  )
  if (startRequestId === canonicalStartRequest) {
    return identity(
      "ChildStartFailed",
      ...coordinates,
      "CanonicalStartRequest"
    )
  }
  assertSourceEvent(startRequestId, "opaque start-request identifier")
  return identity(
    "ChildStartFailed",
    ...coordinates,
    "OpaqueStartRequest",
    startRequestId
  )
}

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
): string => {
  assertAtomic(definitionId, "workflow-definition identifier")
  return identity("WorkflowFamily", definitionId)
}
