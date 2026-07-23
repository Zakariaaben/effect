/**
 * Authoritative protocol version `2` command-batch materialization.
 *
 * **Details**
 *
 * This module is a pure storage-boundary specification. It converts a
 * detached strict command batch into immutable semantic events, derives
 * absolute deadlines only from committed event timestamps, and validates the
 * resulting durable run head. It does not admit external facts.
 *
 * @since 4.0.0
 */
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as CommandV2 from "../CommandV2.ts"
import * as EventV2 from "../EventV2.ts"
import * as IdentityV2 from "../IdentityV2.ts"
import * as RunStateV2 from "../RunStateV2.ts"
import * as SemanticTime from "../SemanticTime.ts"
import * as Json from "./json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const MaxCommandCount = 1_024

/**
 * A non-empty atomic batch of protocol version `2` decision commands.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CommandBatch = Schema.NonEmptyArray(CommandV2.Command).check(
  Schema.isMaxLength(MaxCommandCount)
).annotate({
  identifier: "WorkflowCommandEventV2CommandBatch",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CommandBatch}.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandBatch = Schema.Schema.Type<typeof CommandBatch>

/**
 * Stable machine-readable command-batch materialization failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidRunState: "InvalidRunState",
  InvalidCommandBatch: "InvalidCommandBatch",
  EmptyCommandBatch: "EmptyCommandBatch",
  InvalidRecordedAt: "InvalidRecordedAt",
  TimestampRegression: "TimestampRegression",
  SequenceOutOfRange: "SequenceOutOfRange",
  TenantIdMismatch: "TenantIdMismatch",
  RunIdMismatch: "RunIdMismatch",
  DuplicateCommandId: "DuplicateCommandId",
  NonCanonicalCommandId: "NonCanonicalCommandId",
  AnchorNotFound: "AnchorNotFound",
  InvalidAnchor: "InvalidAnchor",
  DeadlineOutOfRange: "DeadlineOutOfRange",
  HistoryRejected: "HistoryRejected",
  IncompleteBatch: "IncompleteBatch",
  CancellationIncoherent: "CancellationIncoherent"
} as const

/**
 * A stable machine-readable command-batch materialization failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandEventErrorCode = typeof Codes[keyof typeof Codes]

const CommandEventErrorCode = Schema.Literals([
  Codes.InvalidRunState,
  Codes.InvalidCommandBatch,
  Codes.EmptyCommandBatch,
  Codes.InvalidRecordedAt,
  Codes.TimestampRegression,
  Codes.SequenceOutOfRange,
  Codes.TenantIdMismatch,
  Codes.RunIdMismatch,
  Codes.DuplicateCommandId,
  Codes.NonCanonicalCommandId,
  Codes.AnchorNotFound,
  Codes.InvalidAnchor,
  Codes.DeadlineOutOfRange,
  Codes.HistoryRejected,
  Codes.IncompleteBatch,
  Codes.CancellationIncoherent
])

/**
 * Raised when an authoritative store cannot safely materialize one command
 * batch.
 *
 * @category errors
 * @since 4.0.0
 */
export class CommandEventError extends Schema.TaggedErrorClass<CommandEventError>(
  "@effect/workflow-builder/CommandEventV2/CommandEventError"
)("CommandEventError", {
  code: CommandEventErrorCode,
  message: Schema.NonEmptyString,
  commandIndex: Schema.optionalKey(NonNegativeSafeInt),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * The immutable events and durable state produced by one admitted batch.
 *
 * @category models
 * @since 4.0.0
 */
export interface MaterializedBatch {
  readonly events: ReadonlyArray<EventV2.Event>
  readonly state: RunStateV2.RunState
}

const decodeBatch = Schema.decodeUnknownResult(CommandBatch, strictParseOptions)

const makeError = (
  code: CommandEventErrorCode,
  message: string,
  commandIndex?: number,
  details?: Schema.Json
): CommandEventError =>
  new CommandEventError({
    code,
    message,
    ...(commandIndex === undefined ? undefined : { commandIndex }),
    ...(details === undefined ? undefined : { details })
  })

const captureBatch = (
  input: unknown
): Result.Result<CommandBatch, CommandEventError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidCommandBatch,
      `Command batch must be strict JSON: ${snapped.failure.message}`,
      undefined,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  if (Array.isArray(snapped.success) && snapped.success.length === 0) {
    return Result.fail(makeError(
      Codes.EmptyCommandBatch,
      "Command batch must contain at least one command"
    ))
  }
  let decoded: ReturnType<typeof decodeBatch>
  try {
    decoded = decodeBatch(snapped.success)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidCommandBatch,
      "Command-batch schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(
      Codes.InvalidCommandBatch,
      "Invalid protocol version 2 command batch",
      undefined,
      { parseError: decoded.failure.message }
    ))
    : Result.succeed(snapped.success as unknown as CommandBatch)
}

const captureRecordedAt = (
  input: unknown
): Result.Result<EventV2.Timestamp, CommandEventError> => {
  const captured = SemanticTime.materializeDeadline(
    input as EventV2.Timestamp,
    0
  )
  if (Result.isSuccess(captured)) {
    return Result.succeed(captured.success)
  }
  return Result.fail(makeError(
    Codes.InvalidRecordedAt,
    "recordedAt must be one canonical, orderable protocol version 2 timestamp",
    undefined,
    {
      semanticTimeError: captured.failure._tag,
      message: captured.failure.message
    }
  ))
}

const activity = (
  state: RunStateV2.RunState,
  logicalActivityId: string
): RunStateV2.ActivityState | undefined => {
  const found = HashMap.get(state.activities, logicalActivityId)
  return found._tag === "Some" ? found.value : undefined
}

const anchor = (
  state: RunStateV2.RunState,
  eventId: string
): RunStateV2.EventMetadata | undefined => {
  const found = HashMap.get(state.eventsById, eventId)
  return found._tag === "Some" ? found.value : undefined
}

const expectedCommandId = (
  state: RunStateV2.RunState,
  command: CommandV2.Command
): string | undefined => {
  const payload = command.payload
  switch (payload._tag) {
    case "ScheduleActivityAttempt":
      return IdentityV2.scheduleActivityCommandId(
        command.tenantId,
        command.runId,
        payload.nodeInstanceId,
        payload.attempt
      )
    case "ScheduleRetry": {
      const owner = activity(state, payload.logicalActivityId)
      return owner === undefined
        ? undefined
        : IdentityV2.scheduleRetryCommandId(
          command.tenantId,
          command.runId,
          owner.nodeInstanceId,
          payload.nextAttempt
        )
    }
    case "FinalizeActivityFailure":
      return IdentityV2.finalizeActivityFailureCommandId(
        command.tenantId,
        command.runId,
        payload.nodeInstanceId
      )
    case "ScheduleTimer":
      return IdentityV2.scheduleTimerCommandId(
        command.tenantId,
        command.runId,
        payload.timerId
      )
    case "CancelTimer":
      return IdentityV2.cancelTimerCommandId(
        command.tenantId,
        command.runId,
        payload.timerId
      )
    case "StartSleep":
      return IdentityV2.startSleepCommandId(
        command.tenantId,
        command.runId,
        payload.nodeInstanceId
      )
    case "StartSignalWait":
      return IdentityV2.startSignalWaitCommandId(
        command.tenantId,
        command.runId,
        payload.nodeInstanceId
      )
    case "ConsumeSignal":
      return IdentityV2.consumeSignalCommandId(
        command.tenantId,
        command.runId,
        payload.waitId,
        payload.signalId
      )
    case "SucceedRun":
      return IdentityV2.succeedRunCommandId(command.tenantId, command.runId)
    case "FailRun":
      return IdentityV2.failRunCommandId(command.tenantId, command.runId)
    case "CancelRun":
      return IdentityV2.cancelRunCommandId(command.tenantId, command.runId)
  }
}

const deadline = (
  state: RunStateV2.RunState,
  anchorEventId: string,
  delayMillis: number,
  commandIndex: number
): Result.Result<EventV2.Timestamp, CommandEventError> => {
  const committed = anchor(state, anchorEventId)
  if (committed === undefined) {
    return Result.fail(makeError(
      Codes.AnchorNotFound,
      `Command refers to unknown committed anchor event '${anchorEventId}'`,
      commandIndex,
      { anchorEventId }
    ))
  }
  const materialized = SemanticTime.materializeDeadline(
    committed.recordedAt,
    delayMillis
  )
  if (Result.isSuccess(materialized)) {
    return Result.succeed(materialized.success)
  }
  if (materialized.failure._tag === "DeadlineOutOfRange") {
    return Result.fail(makeError(
      Codes.DeadlineOutOfRange,
      `Command deadline exceeds the protocol timestamp range`,
      commandIndex,
      {
        anchorEventId,
        anchorRecordedAt: committed.recordedAt,
        delayMillis,
        reason: materialized.failure.reason
      }
    ))
  }
  return Result.fail(makeError(
    Codes.InvalidAnchor,
    `Committed anchor '${anchorEventId}' has an unsafe timestamp`,
    commandIndex,
    {
      anchorEventId,
      semanticTimeError: materialized.failure._tag,
      message: materialized.failure.message
    }
  ))
}

const mapPayload = (
  state: RunStateV2.RunState,
  payload: CommandV2.Payload,
  commandIndex: number
): Result.Result<EventV2.Payload, CommandEventError> => {
  switch (payload._tag) {
    case "ScheduleActivityAttempt":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "ActivityScheduled"
      }))
    case "ScheduleRetry": {
      const absolute = deadline(
        state,
        payload.anchorEventId,
        payload.selectedDelayMillis,
        commandIndex
      )
      return Result.isFailure(absolute)
        ? Result.fail(absolute.failure)
        : Result.succeed(Object.freeze({
          ...payload,
          _tag: "RetryScheduled",
          deadline: absolute.success
        }))
    }
    case "FinalizeActivityFailure":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "ActivityFailed"
      }))
    case "ScheduleTimer": {
      const absolute = deadline(
        state,
        payload.anchorEventId,
        payload.delayMillis,
        commandIndex
      )
      return Result.isFailure(absolute)
        ? Result.fail(absolute.failure)
        : Result.succeed(Object.freeze({
          ...payload,
          _tag: "TimerScheduled",
          deadline: absolute.success
        }))
    }
    case "CancelTimer":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "TimerCancelled"
      }))
    case "StartSleep":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "SleepStarted"
      }))
    case "StartSignalWait":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "SignalWaitStarted"
      }))
    case "ConsumeSignal":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "SignalConsumed"
      }))
    case "SucceedRun":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "RunSucceeded"
      }))
    case "FailRun":
      return Result.succeed(Object.freeze({
        ...payload,
        _tag: "RunFailed"
      }))
    case "CancelRun":
      return Result.succeed(Object.freeze({ _tag: "RunCancelled" }))
  }
}

const historyFailure = (
  failure: RunStateV2.HistoryError,
  commandIndex: number,
  cancellationContext: boolean
): CommandEventError => {
  const code = failure.code === RunStateV2.Codes.IncompleteSemanticPairing
    ? cancellationContext
      ? Codes.CancellationIncoherent
      : Codes.IncompleteBatch
    : failure.code === RunStateV2.Codes.IllegalCancellationTransition
    ? Codes.CancellationIncoherent
    : Codes.HistoryRejected
  return makeError(
    code,
    `Materialized command was rejected by protocol replay: ${failure.message}`,
    commandIndex,
    {
      historyCode: failure.code,
      ...(failure.details === undefined ? undefined : { historyDetails: failure.details })
    }
  )
}

/**
 * Materializes and validates one atomic protocol version `2` command batch.
 *
 * **Details**
 *
 * The unknown batch and `recordedAt` cross descriptor-safe detached
 * boundaries. Every command must identify the authoritative tenant and run,
 * carry its canonical command identity, and be unique against both committed
 * history and the batch. Each admitted command produces exactly one event with
 * the same stable identifier and one consecutive sequence.
 *
 * Retry and timer deadlines are derived with
 * {@link SemanticTime.materializeDeadline} from an event already committed in
 * the supplied state or materialized earlier in this batch. The single
 * store-owned `recordedAt` cannot precede the current durable head.
 *
 * Every event is folded through {@link RunStateV2.reduce}; the final state must
 * pass {@link RunStateV2.validateDurableHead}. Consequently owner/timer facts,
 * timer cleanup, terminal cleanup, and cancellation cleanup cannot be
 * truncated across a successful batch.
 *
 * The supplied derived state may be an in-transaction prefix after an
 * authoritative external fact, such as an activity start or cancellation
 * request. The caller must ensure that transaction began from a validated
 * durable head and must not persist the intermediate prefix. Only the state
 * returned by a successful call is guaranteed to be a valid durable head.
 *
 * @category converting
 * @since 4.0.0
 */
export const materialize = (
  initialState: RunStateV2.RunState,
  input: unknown,
  inputRecordedAt: unknown
): Result.Result<MaterializedBatch, CommandEventError> => {
  if (!RunStateV2.isDerived(initialState)) {
    return Result.fail(makeError(
      Codes.InvalidRunState,
      "Run state must be an exact immutable value derived by RunStateV2"
    ))
  }
  const commands = captureBatch(input)
  if (Result.isFailure(commands)) {
    return Result.fail(commands.failure)
  }
  const recordedAt = captureRecordedAt(inputRecordedAt)
  if (Result.isFailure(recordedAt)) {
    return Result.fail(recordedAt.failure)
  }
  const previousInstant = Date.parse(initialState.lastRecordedAt)
  const recordedInstant = Date.parse(recordedAt.success)
  if (
    !Number.isSafeInteger(previousInstant) ||
    !Number.isSafeInteger(recordedInstant) ||
    recordedInstant < previousInstant
  ) {
    return Result.fail(makeError(
      Codes.TimestampRegression,
      "Batch recordedAt must not precede the authoritative durable head",
      undefined,
      {
        previousRecordedAt: initialState.lastRecordedAt,
        actualRecordedAt: recordedAt.success
      }
    ))
  }
  if (
    initialState.sequence >
      Number.MAX_SAFE_INTEGER - commands.success.length
  ) {
    return Result.fail(makeError(
      Codes.SequenceOutOfRange,
      "Command batch would exceed the safe history-sequence range",
      undefined,
      {
        currentSequence: initialState.sequence,
        commandCount: commands.success.length
      }
    ))
  }

  const events: Array<EventV2.Event> = []
  const commandIds = new Set<string>()
  let state = initialState
  for (let index = 0; index < commands.success.length; index++) {
    const command = commands.success[index]!
    if (command.tenantId !== initialState.tenantId) {
      return Result.fail(makeError(
        Codes.TenantIdMismatch,
        `Command tenant '${command.tenantId}' does not match the authoritative run`,
        index,
        {
          expectedTenantId: initialState.tenantId,
          actualTenantId: command.tenantId
        }
      ))
    }
    if (command.runId !== initialState.runId) {
      return Result.fail(makeError(
        Codes.RunIdMismatch,
        `Command run '${command.runId}' does not match the authoritative run`,
        index,
        {
          expectedRunId: initialState.runId,
          actualRunId: command.runId
        }
      ))
    }
    const expected = expectedCommandId(state, command)
    if (expected === undefined || command.commandId !== expected) {
      return Result.fail(makeError(
        Codes.NonCanonicalCommandId,
        `Command '${command.payload._tag}' has a noncanonical identity`,
        index,
        {
          commandTag: command.payload._tag,
          expectedCommandId: expected ?? null,
          actualCommandId: command.commandId
        }
      ))
    }
    if (
      commandIds.has(command.commandId) ||
      HashSet.has(state.seenEventIds, command.commandId)
    ) {
      return Result.fail(makeError(
        Codes.DuplicateCommandId,
        `Command id '${command.commandId}' was already committed or repeated`,
        index,
        { commandId: command.commandId }
      ))
    }
    commandIds.add(command.commandId)

    if (
      state.status === "CancellationRequested" &&
      command.payload._tag !== "CancelTimer" &&
      command.payload._tag !== "CancelRun"
    ) {
      return Result.fail(makeError(
        Codes.CancellationIncoherent,
        `Command '${command.payload._tag}' is not cancellation cleanup`,
        index,
        {
          commandTag: command.payload._tag,
          runStatus: state.status
        }
      ))
    }

    const payload = mapPayload(state, command.payload, index)
    if (Result.isFailure(payload)) {
      return Result.fail(payload.failure)
    }
    const event = Object.freeze({
      eventVersion: EventV2.EventVersion,
      tenantId: command.tenantId,
      eventId: command.commandId,
      runId: command.runId,
      sequence: state.sequence + 1,
      recordedAt: recordedAt.success,
      payload: payload.success
    }) as EventV2.Event
    const next = RunStateV2.reduce(state, event)
    if (Result.isFailure(next)) {
      return Result.fail(historyFailure(
        next.failure,
        index,
        state.status === "CancellationRequested"
      ))
    }
    events.push(event)
    state = next.success
  }

  const durable = RunStateV2.validateDurableHead(state)
  if (Result.isFailure(durable)) {
    return Result.fail(historyFailure(
      durable.failure,
      commands.success.length - 1,
      state.status === "CancellationRequested" ||
        initialState.status === "CancellationRequested"
    ))
  }
  return Result.succeed(Object.freeze({
    events: Object.freeze(events),
    state: durable.success
  }))
}
