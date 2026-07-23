/**
 * Pure replay and transition authority for one protocol version `3`
 * parent-child relation stream.
 *
 * **Details**
 *
 * This module owns semantic transition legality only. It has no clock, store,
 * queue, resolver, or runtime dependency. A durable authority must serialize
 * relation mutations and fold every committed event through this reducer
 * before publishing a new head.
 *
 * @since 4.0.0
 */
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Protocol from "./ChildWorkflowProtocolV3.ts"
import * as Child from "./ChildWorkflowV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeSafeInt = Wire.NonNegativeSafeInt

/**
 * Snapshot representation version produced by this reducer.
 *
 * @category constants
 * @since 4.0.0
 */
export const StateVersion = 3 as const

/**
 * Metadata retained for one accepted relation event.
 *
 * @category models
 * @since 4.0.0
 */
export interface EventMetadata {
  readonly eventId: string
  readonly sequence: number
  readonly recordedAt: Wire.Timestamp
  readonly causationId: string
  readonly payloadTag: Protocol.EventPayload["_tag"]
}

/**
 * No parent-close action has been committed for this relation.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenCloseState {
  readonly _tag: "Open"
}

/**
 * A cancellation intent is durable but has not yet been accepted by the child.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancellationRequestedCloseState {
  readonly _tag: "CancellationRequested"
  readonly parentCause: Protocol.ParentCloseCause
  readonly closeAction: Protocol.CancellationCloseAction
  readonly cancellationCommandId: string
}

/**
 * The child durably accepted the propagated cancellation.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancellationAcceptedCloseState {
  readonly _tag: "CancellationAccepted"
  readonly parentCause: Protocol.ParentCloseCause
  readonly closeAction: Protocol.CancellationCloseAction
  readonly cancellationCommandId: string
  readonly childCancellationEventId: string
  readonly acceptedEventId: string
}

/**
 * Parent close won before a child run was accepted.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancelledBeforeStartCloseState {
  readonly _tag: "CancelledBeforeStart"
  readonly parentCause: Protocol.ParentCloseCause
  readonly closeAction: Protocol.CancellationCloseAction
  readonly cancellationCommandId: string
}

/**
 * The parent durably detached without asserting child cancellation.
 *
 * @category models
 * @since 4.0.0
 */
export interface AbandonedCloseState {
  readonly _tag: "Abandoned"
  readonly parentCause: Protocol.ParentCloseCause
}

/**
 * Closed parent-close propagation state derived from relation history.
 *
 * @category models
 * @since 4.0.0
 */
export type CloseState =
  | OpenCloseState
  | CancellationRequestedCloseState
  | CancellationAcceptedCloseState
  | CancelledBeforeStartCloseState
  | AbandonedCloseState

/**
 * A relation without a terminal outcome.
 *
 * @category models
 * @since 4.0.0
 */
export interface PendingOutcome {
  readonly _tag: "Pending"
}

/**
 * A permanent child-start failure.
 *
 * @category models
 * @since 4.0.0
 */
export interface StartFailedOutcome {
  readonly _tag: "StartFailed"
  readonly failureKind: Protocol.ChildStartFailureKind
  readonly failure: Wire.EncodedPayload
}

/**
 * A successful child result projected into the parent relation.
 *
 * @category models
 * @since 4.0.0
 */
export interface SucceededOutcome {
  readonly _tag: "Succeeded"
  readonly outputContractDigest: Child.ContractDigest
  readonly encodedOutput: Wire.EncodedPayload
}

/**
 * A failed child result projected into the parent relation.
 *
 * @category models
 * @since 4.0.0
 */
export interface FailedOutcome {
  readonly _tag: "Failed"
  readonly failure: Wire.EncodedPayload
}

/**
 * A cancelled child result projected into the parent relation.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancelledOutcome {
  readonly _tag: "Cancelled"
  readonly cancellation: Wire.EncodedPayload
}

/**
 * A terminal relation closed before child start.
 *
 * @category models
 * @since 4.0.0
 */
export interface CancelledBeforeStartOutcome {
  readonly _tag: "CancelledBeforeStart"
  readonly parentCause: Protocol.ParentCloseCause
  readonly closeAction: Protocol.CancellationCloseAction
}

/**
 * A terminal detached relation.
 *
 * @category models
 * @since 4.0.0
 */
export interface AbandonedOutcome {
  readonly _tag: "Abandoned"
  readonly parentCause: Protocol.ParentCloseCause
}

/**
 * Exhaustive business outcome retained by a child relation head.
 *
 * @category models
 * @since 4.0.0
 */
export type Outcome =
  | PendingOutcome
  | StartFailedOutcome
  | SucceededOutcome
  | FailedOutcome
  | CancelledOutcome
  | CancelledBeforeStartOutcome
  | AbandonedOutcome

/**
 * Immutable state rebuilt exclusively from one protocol version `3` child
 * relation history.
 *
 * @category models
 * @since 4.0.0
 */
export interface ChildWorkflowState {
  readonly stateVersion: typeof StateVersion
  readonly tenantId: string
  readonly parentRunId: string
  readonly callId: string
  readonly relation: Child.ChildRelation
  readonly inputContractDigest: Child.ContractDigest
  readonly encodedInput: Wire.EncodedPayload
  readonly scheduledAt: Wire.Timestamp
  readonly sequence: number
  readonly lastRecordedAt: Wire.Timestamp
  readonly phase: Child.ChildCallPhase
  readonly close: CloseState
  readonly outcome: Outcome
  readonly seenEventIds: HashSet.HashSet<string>
  readonly eventsById: HashMap.HashMap<string, EventMetadata>
}

/**
 * Parent terminal gating derived from the exact child close state.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentCloseBarrier =
  | "NotRequested"
  | "WaitingForChildTerminal"
  | "Discharged"

/**
 * Stable machine-readable child history failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidState: "InvalidState",
  InvalidHistory: "InvalidHistory",
  InvalidEvent: "InvalidEvent",
  MissingSchedule: "MissingSchedule",
  UnexpectedSequence: "UnexpectedSequence",
  SequenceOutOfRange: "SequenceOutOfRange",
  TimestampRegression: "TimestampRegression",
  TenantIdMismatch: "TenantIdMismatch",
  ParentRunIdMismatch: "ParentRunIdMismatch",
  CallIdMismatch: "CallIdMismatch",
  DuplicateEventId: "DuplicateEventId",
  ClosePolicyMismatch: "ClosePolicyMismatch",
  OutputContractMismatch: "OutputContractMismatch",
  CancellationMismatch: "CancellationMismatch",
  IllegalTransition: "IllegalTransition",
  StateInvariantViolation: "StateInvariantViolation"
} as const

/**
 * A stable child history failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type HistoryErrorCode = typeof Codes[keyof typeof Codes]

const HistoryErrorCode = Schema.Literals([
  Codes.InvalidState,
  Codes.InvalidHistory,
  Codes.InvalidEvent,
  Codes.MissingSchedule,
  Codes.UnexpectedSequence,
  Codes.SequenceOutOfRange,
  Codes.TimestampRegression,
  Codes.TenantIdMismatch,
  Codes.ParentRunIdMismatch,
  Codes.CallIdMismatch,
  Codes.DuplicateEventId,
  Codes.ClosePolicyMismatch,
  Codes.OutputContractMismatch,
  Codes.CancellationMismatch,
  Codes.IllegalTransition,
  Codes.StateInvariantViolation
])

/**
 * Raised when a child relation history cannot be replayed safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildWorkflowHistoryError extends Schema.TaggedErrorClass<ChildWorkflowHistoryError>(
  "@effect/workflow-builder/ChildWorkflowStateV3/HistoryError"
)("ChildWorkflowHistoryError", {
  code: HistoryErrorCode,
  message: Schema.NonEmptyString,
  historyIndex: Schema.optionalKey(NonNegativeSafeInt),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const derivedStates = new WeakSet<object>()

const makeError = (
  code: HistoryErrorCode,
  message: string,
  details?: Schema.Json,
  historyIndex?: number
): ChildWorkflowHistoryError =>
  new ChildWorkflowHistoryError({
    code,
    message,
    ...(historyIndex === undefined ? undefined : { historyIndex }),
    ...(details === undefined ? undefined : { details })
  })

const metadata = (
  event: Protocol.Event
): EventMetadata =>
  Object.freeze({
    eventId: event.eventId,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
    causationId: event.causationId,
    payloadTag: event.payload._tag
  })

const selectedCloseAction = (
  relation: Child.ChildRelation,
  cause: Protocol.ParentCloseCause
): Child.ChildCloseAction =>
  cause._tag === "ParentFailure"
    ? relation.target.closePolicy.onParentFailure
    : relation.target.closePolicy.onParentCancellation

const terminalPhase = (
  phase: Child.ChildCallPhase
): boolean =>
  phase._tag === "StartFailed" ||
  phase._tag === "Succeeded" ||
  phase._tag === "Failed" ||
  phase._tag === "Cancelled" ||
  phase._tag === "CancelledBeforeStart" ||
  phase._tag === "Abandoned"

const phaseIdentityMismatch = (
  phase: Child.ChildCallPhase["_tag"],
  field: string,
  expected: string,
  actual: string
): Result.Result<never, ChildWorkflowHistoryError> =>
  Result.fail(makeError(
    Codes.StateInvariantViolation,
    "Reducer produced a child-call phase with a non-canonical identity",
    {
      phase,
      field,
      expected,
      actual
    }
  ))

const validatePhase = (
  relation: Child.ChildRelation,
  phase: Child.ChildCallPhase
): Result.Result<Child.ChildCallPhase, ChildWorkflowHistoryError> => {
  const parent = relation.parent
  const coordinates = [
    parent.tenantId,
    parent.parentRunId,
    parent.callId
  ] as const

  switch (phase._tag) {
    case "Scheduled": {
      break
    }
    case "Running": {
      const expected = Child.childStartProjectionEventId(
        ...coordinates,
        phase.childRunStartedEventId
      )
      if (phase.startProjectionEventId !== expected) {
        return phaseIdentityMismatch(
          phase._tag,
          "startProjectionEventId",
          expected,
          phase.startProjectionEventId
        )
      }
      break
    }
    case "StartFailed": {
      const expected = Child.childStartFailedEventId(
        ...coordinates,
        relation.startRequestId
      )
      if (phase.startFailedEventId !== expected) {
        return phaseIdentityMismatch(
          phase._tag,
          "startFailedEventId",
          expected,
          phase.startFailedEventId
        )
      }
      break
    }
    case "CancellationRequested": {
      const expected = Child.requestChildCancellationCommandId(
        ...coordinates,
        phase.parentCauseEventId
      )
      if (phase.cancellationCommandId !== expected) {
        return phaseIdentityMismatch(
          phase._tag,
          "cancellationCommandId",
          expected,
          phase.cancellationCommandId
        )
      }
      break
    }
    case "CancellationAccepted": {
      const expectedCommand = Child.requestChildCancellationCommandId(
        ...coordinates,
        phase.parentCauseEventId
      )
      if (phase.cancellationCommandId !== expectedCommand) {
        return phaseIdentityMismatch(
          phase._tag,
          "cancellationCommandId",
          expectedCommand,
          phase.cancellationCommandId
        )
      }
      const expectedAccepted = Child.childCancellationAcceptedEventId(
        ...coordinates,
        phase.childCancellationEventId
      )
      if (phase.acceptedEventId !== expectedAccepted) {
        return phaseIdentityMismatch(
          phase._tag,
          "acceptedEventId",
          expectedAccepted,
          phase.acceptedEventId
        )
      }
      break
    }
    case "Succeeded":
    case "Failed":
    case "Cancelled": {
      const expected = Child.childTerminalProjectionEventId(
        ...coordinates,
        phase.childTerminalEventId
      )
      if (phase.terminalProjectionEventId !== expected) {
        return phaseIdentityMismatch(
          phase._tag,
          "terminalProjectionEventId",
          expected,
          phase.terminalProjectionEventId
        )
      }
      break
    }
    case "CancelledBeforeStart": {
      const expected = Child.childCancelledBeforeStartEventId(
        ...coordinates,
        phase.parentCauseEventId
      )
      if (phase.cancelledBeforeStartEventId !== expected) {
        return phaseIdentityMismatch(
          phase._tag,
          "cancelledBeforeStartEventId",
          expected,
          phase.cancelledBeforeStartEventId
        )
      }
      break
    }
    case "Abandoned": {
      const expected = Child.abandonChildEventId(
        ...coordinates,
        phase.parentCauseEventId
      )
      if (phase.abandonEventId !== expected) {
        return phaseIdentityMismatch(
          phase._tag,
          "abandonEventId",
          expected,
          phase.abandonEventId
        )
      }
      break
    }
  }

  return Result.succeed(phase)
}

const initial = (
  event: Protocol.Event
): Result.Result<ChildWorkflowState, ChildWorkflowHistoryError> => {
  if (event.payload._tag !== "ChildScheduled") {
    return Result.fail(makeError(
      Codes.MissingSchedule,
      "A child relation history must begin with ChildScheduled",
      { actualTag: event.payload._tag }
    ))
  }
  if (event.sequence !== 0) {
    return Result.fail(makeError(
      Codes.UnexpectedSequence,
      "ChildScheduled must have relation sequence zero",
      { expectedSequence: 0, actualSequence: event.sequence }
    ))
  }
  const phase = validatePhase(
    event.payload.relation,
    Object.freeze({ _tag: "Scheduled" })
  )
  if (Result.isFailure(phase)) {
    return Result.fail(phase.failure)
  }
  const state = Object.freeze({
    stateVersion: StateVersion,
    tenantId: event.tenantId,
    parentRunId: event.parentRunId,
    callId: event.callId,
    relation: event.payload.relation,
    inputContractDigest: event.payload.inputContractDigest,
    encodedInput: event.payload.encodedInput,
    scheduledAt: event.recordedAt,
    sequence: event.sequence,
    lastRecordedAt: event.recordedAt,
    phase: phase.success,
    close: Object.freeze({ _tag: "Open" }),
    outcome: Object.freeze({ _tag: "Pending" }),
    seenEventIds: HashSet.make(event.eventId),
    eventsById: HashMap.make([event.eventId, metadata(event)])
  }) as ChildWorkflowState
  derivedStates.add(state)
  return Result.succeed(state)
}

interface Transition {
  readonly phase: Child.ChildCallPhase
  readonly close: CloseState
  readonly outcome: Outcome
}

const illegal = (
  state: ChildWorkflowState,
  event: Protocol.Event,
  expected: string
): Result.Result<never, ChildWorkflowHistoryError> =>
  Result.fail(makeError(
    Codes.IllegalTransition,
    `${event.payload._tag} is not legal from child phase ${state.phase._tag}`,
    {
      currentPhase: state.phase._tag,
      eventTag: event.payload._tag,
      expected
    }
  ))

const requirePinnedCloseAction = (
  state: ChildWorkflowState,
  cause: Protocol.ParentCloseCause,
  actual: Child.ChildCloseAction
): Result.Result<void, ChildWorkflowHistoryError> => {
  const expected = selectedCloseAction(state.relation, cause)
  return expected === actual
    ? Result.succeed(undefined)
    : Result.fail(makeError(
      Codes.ClosePolicyMismatch,
      "Child close action does not equal the relation's pinned policy",
      {
        parentCause: cause._tag,
        expectedCloseAction: expected,
        actualCloseAction: actual
      }
    ))
}

const transition = (
  state: ChildWorkflowState,
  event: Protocol.Event
): Result.Result<Transition, ChildWorkflowHistoryError> => {
  const payload = event.payload
  switch (payload._tag) {
    case "ChildScheduled":
      return illegal(state, event, "the schedule fact only at sequence zero")
    case "ChildStartAccepted": {
      if (state.phase._tag !== "Scheduled") {
        return illegal(state, event, "Scheduled")
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "Running",
          childRunStartedEventId: payload.childRunStartedEventId,
          startProjectionEventId: event.eventId
        }),
        close: state.close,
        outcome: state.outcome
      })
    }
    case "ChildStartFailed": {
      if (state.phase._tag !== "Scheduled") {
        return illegal(state, event, "Scheduled")
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "StartFailed",
          startFailedEventId: event.eventId
        }),
        close: state.close,
        outcome: Object.freeze({
          _tag: "StartFailed",
          failureKind: payload.failureKind,
          failure: payload.failure
        })
      })
    }
    case "ChildCancellationRequested": {
      if (state.phase._tag !== "Running") {
        return illegal(state, event, "Running")
      }
      const pinned = requirePinnedCloseAction(
        state,
        payload.parentCause,
        payload.closeAction
      )
      if (Result.isFailure(pinned)) {
        return Result.fail(pinned.failure)
      }
      const parentCauseEventId = payload.parentCause.parentCauseEventId
      return Result.succeed({
        phase: Object.freeze({
          _tag: "CancellationRequested",
          parentCauseEventId,
          cancellationCommandId: payload.cancellationCommandId
        }),
        close: Object.freeze({
          _tag: "CancellationRequested",
          parentCause: payload.parentCause,
          closeAction: payload.closeAction,
          cancellationCommandId: payload.cancellationCommandId
        }),
        outcome: state.outcome
      })
    }
    case "ChildCancellationAccepted": {
      if (
        state.phase._tag !== "CancellationRequested" ||
        state.close._tag !== "CancellationRequested"
      ) {
        return illegal(state, event, "CancellationRequested")
      }
      if (
        payload.parentCauseEventId !==
          state.close.parentCause.parentCauseEventId ||
        payload.cancellationCommandId !==
          state.close.cancellationCommandId
      ) {
        return Result.fail(makeError(
          Codes.CancellationMismatch,
          "Child cancellation acceptance does not reference the live request",
          {
            expectedParentCauseEventId: state.close.parentCause.parentCauseEventId,
            actualParentCauseEventId: payload.parentCauseEventId,
            expectedCancellationCommandId: state.close.cancellationCommandId,
            actualCancellationCommandId: payload.cancellationCommandId
          }
        ))
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "CancellationAccepted",
          parentCauseEventId: payload.parentCauseEventId,
          cancellationCommandId: payload.cancellationCommandId,
          childCancellationEventId: payload.childCancellationEventId,
          acceptedEventId: event.eventId
        }),
        close: Object.freeze({
          _tag: "CancellationAccepted",
          parentCause: state.close.parentCause,
          closeAction: state.close.closeAction,
          cancellationCommandId: payload.cancellationCommandId,
          childCancellationEventId: payload.childCancellationEventId,
          acceptedEventId: event.eventId
        }),
        outcome: state.outcome
      })
    }
    case "ChildCancelledBeforeStart": {
      if (state.phase._tag !== "Scheduled") {
        return illegal(state, event, "Scheduled")
      }
      const pinned = requirePinnedCloseAction(
        state,
        payload.parentCause,
        payload.closeAction
      )
      if (Result.isFailure(pinned)) {
        return Result.fail(pinned.failure)
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "CancelledBeforeStart",
          parentCauseEventId: payload.parentCauseEventId,
          cancelledBeforeStartEventId: event.eventId
        }),
        close: Object.freeze({
          _tag: "CancelledBeforeStart",
          parentCause: payload.parentCause,
          closeAction: payload.closeAction,
          cancellationCommandId: payload.cancellationCommandId
        }),
        outcome: Object.freeze({
          _tag: "CancelledBeforeStart",
          parentCause: payload.parentCause,
          closeAction: payload.closeAction
        })
      })
    }
    case "ChildSucceeded": {
      if (
        state.phase._tag !== "Running" &&
        state.phase._tag !== "CancellationRequested"
      ) {
        return illegal(
          state,
          event,
          "Running or CancellationRequested before child cancellation acceptance"
        )
      }
      if (
        payload.outputContractDigest !==
          state.relation.target.outputContractDigest
      ) {
        return Result.fail(makeError(
          Codes.OutputContractMismatch,
          "Child success uses an output contract other than the pinned target",
          {
            expectedOutputContractDigest: state.relation.target.outputContractDigest,
            actualOutputContractDigest: payload.outputContractDigest
          }
        ))
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "Succeeded",
          childTerminalEventId: payload.childTerminalEventId,
          terminalProjectionEventId: event.eventId
        }),
        close: state.close,
        outcome: Object.freeze({
          _tag: "Succeeded",
          outputContractDigest: payload.outputContractDigest,
          encodedOutput: payload.encodedOutput
        })
      })
    }
    case "ChildFailed": {
      if (
        state.phase._tag !== "Running" &&
        state.phase._tag !== "CancellationRequested"
      ) {
        return illegal(
          state,
          event,
          "Running or CancellationRequested before child cancellation acceptance"
        )
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "Failed",
          childTerminalEventId: payload.childTerminalEventId,
          terminalProjectionEventId: event.eventId
        }),
        close: state.close,
        outcome: Object.freeze({
          _tag: "Failed",
          failure: payload.failure
        })
      })
    }
    case "ChildCancelled": {
      if (
        state.phase._tag !== "Running" &&
        state.phase._tag !== "CancellationRequested" &&
        state.phase._tag !== "CancellationAccepted"
      ) {
        return illegal(
          state,
          event,
          "Running, CancellationRequested, or CancellationAccepted"
        )
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "Cancelled",
          childTerminalEventId: payload.childTerminalEventId,
          terminalProjectionEventId: event.eventId
        }),
        close: state.close,
        outcome: Object.freeze({
          _tag: "Cancelled",
          cancellation: payload.cancellation
        })
      })
    }
    case "ChildAbandoned": {
      if (
        state.phase._tag !== "Scheduled" &&
        state.phase._tag !== "Running"
      ) {
        return illegal(state, event, "Scheduled or Running")
      }
      const pinned = requirePinnedCloseAction(
        state,
        payload.parentCause,
        payload.closeAction
      )
      if (Result.isFailure(pinned)) {
        return Result.fail(pinned.failure)
      }
      return Result.succeed({
        phase: Object.freeze({
          _tag: "Abandoned",
          parentCauseEventId: payload.parentCause.parentCauseEventId,
          abandonEventId: event.eventId
        }),
        close: Object.freeze({
          _tag: "Abandoned",
          parentCause: payload.parentCause
        }),
        outcome: Object.freeze({
          _tag: "Abandoned",
          parentCause: payload.parentCause
        })
      })
    }
  }
}

const append = (
  state: ChildWorkflowState,
  event: Protocol.Event,
  next: Transition
): Result.Result<ChildWorkflowState, ChildWorkflowHistoryError> => {
  const phase = validatePhase(state.relation, next.phase)
  if (Result.isFailure(phase)) {
    return Result.fail(phase.failure)
  }
  const updated = Object.freeze({
    ...state,
    sequence: event.sequence,
    lastRecordedAt: event.recordedAt,
    phase: phase.success,
    close: Object.freeze(next.close),
    outcome: Object.freeze(next.outcome),
    seenEventIds: HashSet.add(state.seenEventIds, event.eventId),
    eventsById: HashMap.set(
      state.eventsById,
      event.eventId,
      metadata(event)
    )
  }) as ChildWorkflowState
  derivedStates.add(updated)
  return Result.succeed(updated)
}

/**
 * Tests whether a value is an exact immutable state produced by this reducer.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDerived = (
  state: unknown
): state is ChildWorkflowState =>
  typeof state === "object" &&
  state !== null &&
  derivedStates.has(state)

/**
 * Tests whether a child relation is terminal for parent projection purposes.
 *
 * **Details**
 *
 * `Abandoned` is terminal for the relation only. It makes no claim that the
 * independently running child has stopped.
 *
 * @category guards
 * @since 4.0.0
 */
export const isTerminal = (
  state: ChildWorkflowState
): boolean => terminalPhase(state.phase)

/**
 * Derives whether a committed parent close may pass this child relation.
 *
 * @category getters
 * @since 4.0.0
 */
export const parentCloseBarrier = (
  state: ChildWorkflowState
): ParentCloseBarrier => {
  if (terminalPhase(state.phase)) {
    return "Discharged"
  }
  switch (state.close._tag) {
    case "Open":
      return "NotRequested"
    case "CancellationRequested":
    case "CancellationAccepted":
      return state.close.closeAction === "CancelAndWait"
        ? "WaitingForChildTerminal"
        : "Discharged"
    case "CancelledBeforeStart":
    case "Abandoned":
      return "Discharged"
  }
}

/**
 * Applies one detached strict event to a relation state.
 *
 * **Details**
 *
 * A missing state admits only `ChildScheduled` at sequence zero. Every later
 * event must use the next sequence, a non-regressing canonical timestamp, the
 * same tenant/parent/call coordinates, and a fresh canonical event identity.
 * Structural copies of reducer state are rejected.
 *
 * @category folding
 * @since 4.0.0
 */
export const reduce = (
  state: ChildWorkflowState | undefined,
  input: unknown
): Result.Result<ChildWorkflowState, ChildWorkflowHistoryError> => {
  const validated = Protocol.validateEvent(input)
  if (Result.isFailure(validated)) {
    return Result.fail(makeError(
      Codes.InvalidEvent,
      "Invalid protocol version 3 child relation event",
      {
        validationCode: validated.failure.code,
        validationMessage: validated.failure.message,
        path: [...validated.failure.path]
      }
    ))
  }
  const event = validated.success
  if (state === undefined) {
    return initial(event)
  }
  if (!isDerived(state)) {
    return Result.fail(makeError(
      Codes.InvalidState,
      "Child relation state must be an exact reducer-derived value"
    ))
  }
  if (event.tenantId !== state.tenantId) {
    return Result.fail(makeError(
      Codes.TenantIdMismatch,
      "Child event tenant does not match the relation",
      {
        expectedTenantId: state.tenantId,
        actualTenantId: event.tenantId
      }
    ))
  }
  if (event.parentRunId !== state.parentRunId) {
    return Result.fail(makeError(
      Codes.ParentRunIdMismatch,
      "Child event parent run does not match the relation",
      {
        expectedParentRunId: state.parentRunId,
        actualParentRunId: event.parentRunId
      }
    ))
  }
  if (event.callId !== state.callId) {
    return Result.fail(makeError(
      Codes.CallIdMismatch,
      "Child event call does not match the relation",
      {
        expectedCallId: state.callId,
        actualCallId: event.callId
      }
    ))
  }
  if (HashSet.has(state.seenEventIds, event.eventId)) {
    return Result.fail(makeError(
      Codes.DuplicateEventId,
      `Child event '${event.eventId}' was already committed`,
      { eventId: event.eventId }
    ))
  }
  if (state.sequence === Number.MAX_SAFE_INTEGER) {
    return Result.fail(makeError(
      Codes.SequenceOutOfRange,
      "Child relation sequence cannot advance beyond the safe integer range"
    ))
  }
  const expectedSequence = state.sequence + 1
  if (event.sequence !== expectedSequence) {
    return Result.fail(makeError(
      Codes.UnexpectedSequence,
      "Child event sequence is not the next authoritative relation sequence",
      {
        expectedSequence,
        actualSequence: event.sequence
      }
    ))
  }
  if (event.recordedAt < state.lastRecordedAt) {
    return Result.fail(makeError(
      Codes.TimestampRegression,
      "Child event recordedAt precedes the relation head",
      {
        previousRecordedAt: state.lastRecordedAt,
        actualRecordedAt: event.recordedAt
      }
    ))
  }
  if (terminalPhase(state.phase)) {
    return illegal(state, event, "no event after a terminal relation")
  }
  const next = transition(state, event)
  return Result.isFailure(next)
    ? Result.fail(next.failure)
    : append(state, event, next.success)
}

/**
 * Rebuilds one child relation state from a detached strict history.
 *
 * @category folding
 * @since 4.0.0
 */
export const fold = (
  input: unknown
): Result.Result<ChildWorkflowState, ChildWorkflowHistoryError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      Codes.InvalidHistory,
      `Child relation history must be bounded strict JSON: ${snapshot.failure.message}`,
      {
        snapshotError: snapshot.failure.message,
        path: [...snapshot.failure.path]
      }
    ))
  }
  if (!Array.isArray(snapshot.success)) {
    return Result.fail(makeError(
      Codes.InvalidHistory,
      "Child relation history must be an array"
    ))
  }
  if (snapshot.success.length === 0) {
    return Result.fail(makeError(
      Codes.MissingSchedule,
      "Child relation history cannot be empty"
    ))
  }
  let state: ChildWorkflowState | undefined
  for (let index = 0; index < snapshot.success.length; index++) {
    const next = reduce(state, snapshot.success[index])
    if (Result.isFailure(next)) {
      return Result.fail(makeError(
        next.failure.code,
        next.failure.message,
        next.failure.details,
        index
      ))
    }
    state = next.success
  }
  return Result.succeed(state!)
}
