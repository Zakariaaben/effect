/**
 * Pure preparation boundary for child-originated lifecycle projections.
 *
 * **Details**
 *
 * A child host, or the durable start authority for a rejected start, reports
 * an authoritative source fact. This module binds that fact to one exact
 * reducer-derived parent-child relation head, derives the canonical projection
 * event identity and next sequence, validates the closed protocol envelope,
 * and proves the transition through `ChildWorkflowStateV3.reduce`.
 *
 * It does not read a clock, allocate a source identity, persist an event,
 * publish to a parent, or infer lifecycle from backend polling or
 * interruption. A durable authority supplies `recordedAt`, serializes the
 * expected relation head, and atomically commits the prepared event.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Protocol from "./ChildWorkflowProtocolV3.ts"
import * as State from "./ChildWorkflowStateV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the lifecycle-source fact vocabulary.
 *
 * @category constants
 * @since 4.0.0
 */
export const LifecycleFactVersion = 1 as const

/**
 * Version of lifecycle event preparation requests.
 *
 * @category constants
 * @since 4.0.0
 */
export const PreparationRequestVersion = 1 as const

/**
 * Version of opaque prepared lifecycle event capabilities.
 *
 * @category constants
 * @since 4.0.0
 */
export const PreparedLifecycleEventVersion = 1 as const

/**
 * Authoritative child-run acceptance fact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildStartAcceptedFact = Schema.TaggedStruct(
  "ChildStartAccepted",
  {
    factVersion: Schema.Literal(LifecycleFactVersion),
    childRunId: Wire.LineageIdentifier,
    sourceSequence: Wire.NonNegativeSafeInt,
    occurredAt: Wire.Timestamp,
    childRunStartedEventId: Wire.SourceEventIdentifier
  }
).annotate({
  identifier: "WorkflowChildLifecycleV3ChildStartAcceptedFact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildStartAcceptedFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildStartAcceptedFact = Schema.Schema.Type<
  typeof ChildStartAcceptedFact
>

/**
 * Permanent child-start failure selected by the durable start authority.
 *
 * **Details**
 *
 * The canonical start request is the source identity for this fact. The
 * authority must classify operational retries before publishing it.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildStartFailedFact = Schema.TaggedStruct(
  "ChildStartFailed",
  {
    factVersion: Schema.Literal(LifecycleFactVersion),
    childRunId: Wire.LineageIdentifier,
    startRequestId: Wire.LineageIdentifier,
    decidedAt: Wire.Timestamp,
    failureKind: Protocol.ChildStartFailureKind,
    failure: Wire.EncodedPayload
  }
).annotate({
  identifier: "WorkflowChildLifecycleV3ChildStartFailedFact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildStartFailedFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildStartFailedFact = Schema.Schema.Type<
  typeof ChildStartFailedFact
>

/**
 * Authoritative child acceptance of a live cancellation request.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCancellationAcceptedFact = Schema.TaggedStruct(
  "ChildCancellationAccepted",
  {
    factVersion: Schema.Literal(LifecycleFactVersion),
    childRunId: Wire.LineageIdentifier,
    sourceSequence: Wire.NonNegativeSafeInt,
    occurredAt: Wire.Timestamp,
    childCancellationEventId: Wire.SourceEventIdentifier
  }
).annotate({
  identifier: "WorkflowChildLifecycleV3ChildCancellationAcceptedFact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildCancellationAcceptedFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCancellationAcceptedFact = Schema.Schema.Type<
  typeof ChildCancellationAcceptedFact
>

/**
 * Authoritative successful child terminal fact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildSucceededFact = Schema.TaggedStruct("ChildSucceeded", {
  factVersion: Schema.Literal(LifecycleFactVersion),
  childRunId: Wire.LineageIdentifier,
  sourceSequence: Wire.NonNegativeSafeInt,
  occurredAt: Wire.Timestamp,
  childTerminalEventId: Wire.SourceEventIdentifier,
  outputContractDigest: Wire.ContractDigest,
  encodedOutput: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildLifecycleV3ChildSucceededFact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildSucceededFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildSucceededFact = Schema.Schema.Type<
  typeof ChildSucceededFact
>

/**
 * Authoritative failed child terminal fact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildFailedFact = Schema.TaggedStruct("ChildFailed", {
  factVersion: Schema.Literal(LifecycleFactVersion),
  childRunId: Wire.LineageIdentifier,
  sourceSequence: Wire.NonNegativeSafeInt,
  occurredAt: Wire.Timestamp,
  childTerminalEventId: Wire.SourceEventIdentifier,
  failure: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildLifecycleV3ChildFailedFact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildFailedFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildFailedFact = Schema.Schema.Type<typeof ChildFailedFact>

/**
 * Authoritative cancelled child terminal fact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCancelledFact = Schema.TaggedStruct("ChildCancelled", {
  factVersion: Schema.Literal(LifecycleFactVersion),
  childRunId: Wire.LineageIdentifier,
  sourceSequence: Wire.NonNegativeSafeInt,
  occurredAt: Wire.Timestamp,
  childTerminalEventId: Wire.SourceEventIdentifier,
  cancellation: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildLifecycleV3ChildCancelledFact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildCancelledFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCancelledFact = Schema.Schema.Type<
  typeof ChildCancelledFact
>

/**
 * Closed child-lifecycle source fact vocabulary.
 *
 * **Details**
 *
 * Parent-owned scheduling, cancellation-request, cancellation-before-start,
 * and abandon events are intentionally absent. They are produced by the
 * serialized relation authority. `ChildStartFailed` is also authority-owned,
 * but remains here because it uses the same exact lifecycle projection
 * preparation boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LifecycleFact = Schema.Union([
  ChildStartAcceptedFact,
  ChildStartFailedFact,
  ChildCancellationAcceptedFact,
  ChildSucceededFact,
  ChildFailedFact,
  ChildCancelledFact
]).annotate({
  identifier: "WorkflowChildLifecycleV3Fact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LifecycleFact}.
 *
 * @category models
 * @since 4.0.0
 */
export type LifecycleFact = Schema.Schema.Type<typeof LifecycleFact>

/**
 * Caller-supplied preparation request.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PrepareLifecycleEventRequest = Schema.Struct({
  requestVersion: Schema.Literal(PreparationRequestVersion),
  recordedAt: Wire.Timestamp,
  fact: LifecycleFact
}).annotate({
  identifier: "WorkflowChildLifecycleV3PrepareEventRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link PrepareLifecycleEventRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type PrepareLifecycleEventRequest = Schema.Schema.Type<
  typeof PrepareLifecycleEventRequest
>

/**
 * Stable lifecycle preparation failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidState: "InvalidState",
  InvalidFact: "InvalidFact",
  InvalidRequest: "InvalidRequest",
  SourceRelationMismatch: "SourceRelationMismatch",
  MissingCancellationRequest: "MissingCancellationRequest",
  SequenceExhausted: "SequenceExhausted"
} as const

/**
 * A stable lifecycle preparation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidState,
  ErrorCodes.InvalidFact,
  ErrorCodes.InvalidRequest,
  ErrorCodes.SourceRelationMismatch,
  ErrorCodes.MissingCancellationRequest,
  ErrorCodes.SequenceExhausted
])

/**
 * Failure before protocol or reducer transition validation.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildWorkflowLifecycleError extends Schema.TaggedErrorClass<
  ChildWorkflowLifecycleError
>("@effect/workflow-builder/ChildWorkflowLifecycleV3/Error")(
  "ChildWorkflowLifecycleError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    eventId: Schema.optionalKey(Wire.Identifier),
    path: Schema.optionalKey(Schema.Array(Schema.Union([
      Schema.String,
      Wire.NonNegativeSafeInt
    ])))
  },
  { parseOptions: strictParseOptions }
) {}

const lifecycleError = (
  code: ErrorCode,
  message: string,
  options: {
    readonly eventId?: string | undefined
    readonly path?: ReadonlyArray<string | number> | undefined
  } = {}
): ChildWorkflowLifecycleError =>
  new ChildWorkflowLifecycleError({
    code,
    message,
    ...(options.eventId === undefined
      ? undefined
      : { eventId: options.eventId }),
    ...(options.path === undefined
      ? undefined
      : { path: [...options.path] })
  })

const decodeFact = Schema.decodeUnknownResult(
  LifecycleFact,
  strictParseOptions
)
const decodeRequest = Schema.decodeUnknownResult(
  PrepareLifecycleEventRequest,
  strictParseOptions
)

const validateWith = <A>(
  input: unknown,
  decode: (input: unknown) => Result.Result<A, unknown>,
  code: typeof ErrorCodes.InvalidFact | typeof ErrorCodes.InvalidRequest,
  label: string
): Result.Result<A, ChildWorkflowLifecycleError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(lifecycleError(
      code,
      `${label} must be bounded strict JSON: ${snapshot.failure.message}`,
      { path: snapshot.failure.path }
    ))
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = decode(snapshot.success)
  } catch {
    return Result.fail(lifecycleError(
      code,
      `${label} validation threw unexpectedly`
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(lifecycleError(
      code,
      `Invalid ${label}: ${decoded.failure}`
    ))
  }
  return Result.succeed(snapshot.success as unknown as A)
}

/**
 * Detaches, recursively freezes, and validates one child-host lifecycle fact.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateLifecycleFact = (
  input: unknown
): Result.Result<LifecycleFact, ChildWorkflowLifecycleError> =>
  validateWith(
    input,
    decodeFact,
    ErrorCodes.InvalidFact,
    "child lifecycle fact"
  )

const coordinates = (
  state: State.ChildWorkflowState
): readonly [string, string, string] => [
  state.tenantId,
  state.parentRunId,
  state.callId
]

const validateFactRelation = (
  state: State.ChildWorkflowState,
  fact: LifecycleFact
): Result.Result<void, ChildWorkflowLifecycleError> => {
  if (fact.childRunId !== state.relation.childRunId) {
    return Result.fail(lifecycleError(
      ErrorCodes.SourceRelationMismatch,
      "The lifecycle source fact belongs to a different child run"
    ))
  }
  if (
    fact._tag === "ChildStartFailed" &&
    fact.startRequestId !== state.relation.startRequestId
  ) {
    return Result.fail(lifecycleError(
      ErrorCodes.SourceRelationMismatch,
      "The start-failure fact belongs to a different child start request"
    ))
  }
  return Result.succeed(undefined)
}

const eventIdFor = (
  state: State.ChildWorkflowState,
  fact: LifecycleFact
): string => {
  const at = coordinates(state)
  switch (fact._tag) {
    case "ChildStartAccepted":
      return Protocol.childStartProjectionEventId(
        ...at,
        fact.childRunStartedEventId
      )
    case "ChildStartFailed":
      return Protocol.childStartFailedEventId(
        ...at,
        state.relation.startRequestId
      )
    case "ChildCancellationAccepted":
      return Protocol.childCancellationAcceptedEventId(
        ...at,
        fact.childCancellationEventId
      )
    case "ChildSucceeded":
    case "ChildFailed":
    case "ChildCancelled":
      return Protocol.childTerminalProjectionEventId(
        ...at,
        fact.childTerminalEventId
      )
  }
}

/**
 * Derives the canonical projection identity without allocating a sequence.
 *
 * **Details**
 *
 * A durable authority can use this identity to look up an earlier projection
 * before attempting a new append. Same-identity/different-content conflict
 * detection remains a store responsibility.
 *
 * @category identity
 * @since 4.0.0
 */
export const projectionEventId = (
  state: State.ChildWorkflowState,
  factInput: unknown
): Result.Result<string, ChildWorkflowLifecycleError> => {
  if (!State.isDerived(state)) {
    return Result.fail(lifecycleError(
      ErrorCodes.InvalidState,
      "Lifecycle projection requires an exact ChildWorkflowStateV3 reducer head"
    ))
  }
  const fact = validateLifecycleFact(factInput)
  if (Result.isFailure(fact)) {
    return Result.fail(fact.failure)
  }
  const related = validateFactRelation(state, fact.success)
  return Result.isFailure(related)
    ? Result.fail(related.failure)
    : Result.succeed(eventIdFor(state, fact.success))
}

const eventPayload = (
  state: State.ChildWorkflowState,
  fact: LifecycleFact
): Result.Result<
  Protocol.EventPayload,
  ChildWorkflowLifecycleError
> => {
  const relation = state.relation
  switch (fact._tag) {
    case "ChildStartAccepted":
      return Result.succeed({
        _tag: fact._tag,
        childRunId: relation.childRunId,
        startRequestId: relation.startRequestId,
        childRunStartedEventId: fact.childRunStartedEventId
      })
    case "ChildStartFailed":
      return Result.succeed({
        _tag: fact._tag,
        childRunId: relation.childRunId,
        startRequestId: relation.startRequestId,
        failureKind: fact.failureKind,
        failure: fact.failure
      })
    case "ChildCancellationAccepted": {
      if (state.close._tag !== "CancellationRequested") {
        return Result.fail(lifecycleError(
          ErrorCodes.MissingCancellationRequest,
          "Child cancellation acceptance requires one live durable cancellation request",
          { eventId: eventIdFor(state, fact) }
        ))
      }
      return Result.succeed({
        _tag: fact._tag,
        childRunId: relation.childRunId,
        parentCauseEventId: state.close.parentCause.parentCauseEventId,
        cancellationCommandId: state.close.cancellationCommandId,
        childCancellationEventId: fact.childCancellationEventId
      })
    }
    case "ChildSucceeded":
      return Result.succeed({
        _tag: fact._tag,
        childRunId: relation.childRunId,
        childTerminalEventId: fact.childTerminalEventId,
        outputContractDigest: fact.outputContractDigest,
        encodedOutput: fact.encodedOutput
      })
    case "ChildFailed":
      return Result.succeed({
        _tag: fact._tag,
        childRunId: relation.childRunId,
        childTerminalEventId: fact.childTerminalEventId,
        failure: fact.failure
      })
    case "ChildCancelled":
      return Result.succeed({
        _tag: fact._tag,
        childRunId: relation.childRunId,
        childTerminalEventId: fact.childTerminalEventId,
        cancellation: fact.cancellation
      })
  }
}

const causationIdFor = (
  state: State.ChildWorkflowState,
  fact: LifecycleFact
): string => {
  switch (fact._tag) {
    case "ChildStartAccepted":
      return fact.childRunStartedEventId
    case "ChildStartFailed":
      return state.relation.startRequestId
    case "ChildCancellationAccepted":
      return fact.childCancellationEventId
    case "ChildSucceeded":
    case "ChildFailed":
    case "ChildCancelled":
      return fact.childTerminalEventId
  }
}

/**
 * Opaque exact transition capability prepared against one relation head.
 *
 * **Details**
 *
 * Public fields are inspectable. Authority comes from the exact object
 * returned by {@link prepareLifecycleEvent}; structural copies are rejected
 * by {@link isPreparedLifecycleEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedLifecycleEvent {
  readonly preparedVersion: typeof PreparedLifecycleEventVersion
  readonly expectedPreviousSequence: number
  readonly fact: LifecycleFact
  readonly event: Protocol.Event
  readonly nextState: State.ChildWorkflowState
}

const preparedLifecycleEvents = new WeakSet<object>()

/**
 * Tests whether a value is an exact lifecycle preparation capability.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPreparedLifecycleEvent = (
  value: unknown
): value is PreparedLifecycleEvent =>
  typeof value === "object" &&
  value !== null &&
  preparedLifecycleEvents.has(value)

/**
 * Prepares and proves one lifecycle-source relation transition.
 *
 * **Details**
 *
 * The caller must atomically append `event` only while the durable relation
 * head still equals `expectedPreviousSequence`. `nextState` is a derived
 * convenience and must not replace replay from committed history.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareLifecycleEvent = (
  state: State.ChildWorkflowState,
  requestInput: unknown
): Result.Result<
  PreparedLifecycleEvent,
  | ChildWorkflowLifecycleError
  | Protocol.ChildWorkflowProtocolValidationError
  | State.ChildWorkflowHistoryError
> => {
  if (!State.isDerived(state)) {
    return Result.fail(lifecycleError(
      ErrorCodes.InvalidState,
      "Lifecycle preparation requires an exact ChildWorkflowStateV3 reducer head"
    ))
  }
  if (state.sequence === Number.MAX_SAFE_INTEGER) {
    return Result.fail(lifecycleError(
      ErrorCodes.SequenceExhausted,
      "The child relation sequence cannot advance beyond the safe integer range"
    ))
  }
  const request = validateWith(
    requestInput,
    decodeRequest,
    ErrorCodes.InvalidRequest,
    "child lifecycle preparation request"
  )
  if (Result.isFailure(request)) {
    return Result.fail(request.failure)
  }
  const fact = request.success.fact
  const related = validateFactRelation(state, fact)
  if (Result.isFailure(related)) {
    return Result.fail(related.failure)
  }
  const payload = eventPayload(state, fact)
  if (Result.isFailure(payload)) {
    return Result.fail(payload.failure)
  }
  const candidate = {
    eventVersion: Protocol.EventVersion,
    executionProtocolVersion: Protocol.ExecutionProtocolVersion,
    eventId: eventIdFor(state, fact),
    tenantId: state.tenantId,
    parentRunId: state.parentRunId,
    callId: state.callId,
    sequence: state.sequence + 1,
    recordedAt: request.success.recordedAt,
    causationId: causationIdFor(state, fact),
    correlationId: state.callId,
    payload: payload.success
  }
  const event = Protocol.validateEvent(candidate)
  if (Result.isFailure(event)) {
    return Result.fail(event.failure)
  }
  const nextState = State.reduce(state, event.success)
  if (Result.isFailure(nextState)) {
    return Result.fail(nextState.failure)
  }
  const prepared = Object.freeze({
    preparedVersion: PreparedLifecycleEventVersion,
    expectedPreviousSequence: state.sequence,
    fact,
    event: event.success,
    nextState: nextState.success
  })
  preparedLifecycleEvents.add(prepared)
  return Result.succeed(prepared)
}
