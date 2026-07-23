/**
 * Drives semantic workflow history with process-local Effect fibers.
 *
 * This runner is intentionally not a durable executor. It does not provide a
 * transactional outbox, leases, crash recovery, cross-process coordination, or
 * cancellation of side effects that have already started.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityRuntime from "./ActivityRuntime.ts"
import * as Command from "./Command.ts"
import * as CommandEvent from "./CommandEvent.ts"
import * as CommandRuntime from "./CommandRuntime.ts"
import * as Decision from "./Decision.ts"
import * as HistoryStore from "./HistoryStore.ts"
import * as Json from "./internal/json.ts"
import * as RunStart from "./RunStart.ts"
import * as RunState from "./RunState.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

/**
 * Stable machine-readable failures emitted by the process-local runner.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidConfiguration: "InvalidConfiguration",
  BackendMismatch: "BackendMismatch",
  CycleLimitExceeded: "CycleLimitExceeded",
  Stalled: "Stalled",
  ConflictingActivityResult: "ConflictingActivityResult"
} as const

/**
 * A stable machine-readable local-runner failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type LocalRunnerErrorCode = typeof Codes[keyof typeof Codes]

const LocalRunnerErrorCode = Schema.Literals([
  Codes.InvalidConfiguration,
  Codes.BackendMismatch,
  Codes.CycleLimitExceeded,
  Codes.Stalled,
  Codes.ConflictingActivityResult
])

/**
 * Raised when the local driver cannot safely continue a semantic run.
 *
 * **Details**
 *
 * Store, replay, decision, command-validation, command-conversion, start, and
 * activity-boundary failures retain their original error types. This error
 * represents only local-driver configuration, progress, and
 * result-reconciliation failures.
 *
 * @category errors
 * @since 4.0.0
 */
export class LocalRunnerError extends Schema.TaggedErrorClass<LocalRunnerError>(
  "@effect/workflow-builder/LocalRunner/LocalRunnerError"
)("LocalRunnerError", {
  code: LocalRunnerErrorCode,
  runId: Schema.String,
  message: Schema.NonEmptyString,
  activityId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Bounded process-local execution settings.
 *
 * **Details**
 *
 * `concurrency` limits activity fibers in this process. `maxCycles` limits
 * semantic read/decide cycles. `maxConflictRetries` limits additional
 * compare-and-set attempts for already-computed activity outcomes; it never
 * re-executes a handler and is not an activity retry policy.
 *
 * @category configuration
 * @since 4.0.0
 */
export interface RunOptions {
  readonly runId: string
  readonly concurrency: number
  readonly maxCycles: number
  readonly maxConflictRetries: number
}

/**
 * Services required to drive an already-started local run.
 *
 * **Details**
 *
 * In addition to history and activity services, this includes services used by
 * workflow-output decoders when validating a successful semantic command.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | HistoryStore.HistoryStore
  | ActivityRuntime.Requirements<W>
  | CommandRuntime.Requirements<W>

/**
 * Services required to encode, start, and drive a local run.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ExecuteRequirements<W extends Workflow.Any> =
  | Requirements<W>
  | RunStart.Requirements<W>

/**
 * Failures that may be produced while driving an already-started local run.
 *
 * @category errors
 * @since 4.0.0
 */
export type RunError =
  | LocalRunnerError
  | HistoryStore.HistoryStoreError
  | RunState.HistoryError
  | Decision.DecisionError
  | CommandEvent.CommandEventError
  | CommandRuntime.CommandRuntimeError
  | ActivityRuntime.ActivityRuntimeError

/**
 * Failures that may be produced while starting and driving a local run.
 *
 * @category errors
 * @since 4.0.0
 */
export type ExecuteError = RunError | RunStart.RunStartError

const makeError = (
  code: LocalRunnerErrorCode,
  runId: string,
  message: string,
  options: {
    readonly activityId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): LocalRunnerError =>
  new LocalRunnerError({
    code,
    runId,
    message,
    ...(options.activityId === undefined ? undefined : { activityId: options.activityId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const validateOptions = (options: RunOptions): Effect.Effect<void, LocalRunnerError> => {
  if (options.runId.length === 0) {
    return Effect.fail(makeError(
      Codes.InvalidConfiguration,
      options.runId,
      "Local execution requires a non-empty runId"
    ))
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
    return Effect.fail(makeError(
      Codes.InvalidConfiguration,
      options.runId,
      "Local execution concurrency must be a positive safe integer"
    ))
  }
  if (!Number.isSafeInteger(options.maxCycles) || options.maxCycles <= 0) {
    return Effect.fail(makeError(
      Codes.InvalidConfiguration,
      options.runId,
      "Local execution maxCycles must be a positive safe integer"
    ))
  }
  if (!Number.isSafeInteger(options.maxConflictRetries) || options.maxConflictRetries < 0) {
    return Effect.fail(makeError(
      Codes.InvalidConfiguration,
      options.runId,
      "Local execution maxConflictRetries must be a non-negative safe integer"
    ))
  }
  return Effect.void
}

interface Inspected {
  readonly state: RunState.RunState
  readonly commands: ReadonlyArray<Command.Command>
}

const inspect = Effect.fnUntraced(function*<W extends Workflow.Any>(
  store: HistoryStore.HistoryStore.Service,
  plan: Decision.DecidablePlan<W>,
  runId: string
): Effect.fn.Return<
  Inspected,
  | LocalRunnerError
  | HistoryStore.HistoryStoreError
  | RunState.HistoryError
  | Decision.DecisionError
> {
  const snapshot = yield* store.read(runId)
  const folded = RunState.fold(snapshot.events)
  if (Result.isFailure(folded)) {
    return yield* Effect.fail(folded.failure)
  }
  const state = folded.success
  if (state.backend !== "direct") {
    return yield* Effect.fail(makeError(
      Codes.BackendMismatch,
      runId,
      "The process-local runner only accepts histories pinned to the direct backend",
      { details: { backend: state.backend } }
    ))
  }
  const decided = Decision.decide(plan, state)
  if (Result.isFailure(decided)) {
    return yield* Effect.fail(decided.failure)
  }
  return { state, commands: decided.success }
})

const isTerminal = (
  state: RunState.RunState
): state is RunState.SucceededRunState | RunState.FailedRunState | RunState.CancelledRunState =>
  state.status === "Succeeded" || state.status === "Failed" || state.status === "Cancelled"

const commandDrafts = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  commands: ReadonlyArray<Command.Command>
): Effect.fn.Return<
  [HistoryStore.EventDraft, ...Array<HistoryStore.EventDraft>],
  CommandRuntime.CommandRuntimeError | CommandEvent.CommandEventError,
  CommandRuntime.Requirements<W>
> {
  const drafts: Array<HistoryStore.EventDraft> = []
  for (const command of commands) {
    const validated = yield* CommandRuntime.validate(plan.compiled, command)
    const converted = CommandEvent.fromCommand(validated)
    if (Result.isFailure(converted)) {
      return yield* Effect.fail(converted.failure)
    }
    drafts.push(converted.success)
  }
  return drafts as [HistoryStore.EventDraft, ...Array<HistoryStore.EventDraft>]
})

const scheduleCommand = (
  runId: string,
  activity: RunState.ScheduledActivityState
): Command.Command => ({
  commandVersion: 1,
  commandId: Command.scheduleActivityCommandId(runId, activity.nodeInstanceId, activity.attempt),
  payload: {
    _tag: "ScheduleActivity",
    activityId: activity.activityId,
    nodeId: activity.nodeId,
    nodeInstanceId: activity.nodeInstanceId,
    attempt: activity.attempt,
    idempotencyKey: activity.idempotencyKey,
    input: activity.input
  }
})

const scheduledInTopologicalOrder = <W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  state: RunState.RunState
): ReadonlyArray<RunState.ScheduledActivityState> => {
  const byNode = new Map<string, RunState.ScheduledActivityState>()
  for (const activity of HashMap.values(state.activities)) {
    if (activity.status === "Scheduled") {
      byNode.set(activity.nodeId, activity)
    }
  }
  const activities: Array<RunState.ScheduledActivityState> = []
  for (const nodeId of plan.compiled.topologicalOrder) {
    const activity = byNode.get(nodeId)
    if (activity !== undefined) {
      activities.push(activity)
    }
  }
  return activities
}

const jsonEqual = (left: Schema.Json, right: Schema.Json): boolean =>
  left === right || Json.canonicalizeSnapshot(left) === Json.canonicalizeSnapshot(right)

const reconcileOutcomes = (
  runId: string,
  state: RunState.RunState,
  events: ReadonlyArray<HistoryStore.EventDraft>
): Result.Result<
  ReadonlyArray<HistoryStore.EventDraft>,
  LocalRunnerError
> => {
  const pending: Array<HistoryStore.EventDraft> = []
  for (const event of events) {
    const payload = event.payload
    if (payload._tag !== "ActivitySucceeded" && payload._tag !== "ActivityFailed") {
      return Result.fail(makeError(
        Codes.ConflictingActivityResult,
        runId,
        "Activity result reconciliation received a non-result event"
      ))
    }
    const activity = HashMap.get(state.activities, payload.activityId)
    if (activity._tag === "None") {
      return Result.fail(makeError(
        Codes.ConflictingActivityResult,
        runId,
        `Activity result '${payload.activityId}' has no matching scheduled activity`,
        { activityId: payload.activityId }
      ))
    }
    if (activity.value.status === "Scheduled") {
      pending.push(event)
      continue
    }
    const identical = activity.value.status === "Succeeded" && payload._tag === "ActivitySucceeded"
      ? jsonEqual(activity.value.output, payload.output)
      : activity.value.status === "Failed" && payload._tag === "ActivityFailed"
      ? jsonEqual(activity.value.failure, payload.failure)
      : false
    if (!identical) {
      return Result.fail(makeError(
        Codes.ConflictingActivityResult,
        runId,
        `Activity '${payload.activityId}' already has a different committed result`,
        {
          activityId: payload.activityId,
          details: {
            committedStatus: activity.value.status,
            attemptedResult: payload._tag
          }
        }
      ))
    }
  }
  if (pending.length > 0 && state.status === "Cancelled") {
    return Result.succeed([])
  }
  if (pending.length > 0 && isTerminal(state)) {
    return Result.fail(makeError(
      Codes.ConflictingActivityResult,
      runId,
      "A terminal run still has uncommitted in-process activity results",
      { details: { status: state.status } }
    ))
  }
  return Result.succeed(pending)
}

const appendOutcomes = Effect.fnUntraced(function*<W extends Workflow.Any>(
  store: HistoryStore.HistoryStore.Service,
  plan: Decision.DecidablePlan<W>,
  runId: string,
  expectedLastSequence: number,
  events: [HistoryStore.EventDraft, ...Array<HistoryStore.EventDraft>],
  maxConflictRetries: number
): Effect.fn.Return<void, RunError> {
  let expected = expectedLastSequence
  let pending = events
  let retries = 0

  while (true) {
    const appended = yield* Effect.result(store.append({
      runId,
      expectedLastSequence: expected,
      events: pending
    }))
    if (Result.isSuccess(appended)) {
      return
    }
    if (appended.failure._tag !== "SequenceConflict" && appended.failure._tag !== "EventIdConflict") {
      return yield* Effect.fail(appended.failure)
    }

    const current = yield* inspect(store, plan, runId)
    const reconciled = reconcileOutcomes(runId, current.state, pending)
    if (Result.isFailure(reconciled)) {
      return yield* Effect.fail(reconciled.failure)
    }
    if (reconciled.success.length === 0) {
      return
    }
    if (retries >= maxConflictRetries) {
      return yield* Effect.fail(makeError(
        Codes.ConflictingActivityResult,
        runId,
        `Activity results exceeded maxConflictRetries ${maxConflictRetries}`,
        {
          details: appended.failure._tag === "SequenceConflict"
            ? {
              maxConflictRetries,
              conflictRetries: retries,
              storeError: appended.failure._tag,
              actualLastSequence: appended.failure.actualLastSequence
            }
            : {
              maxConflictRetries,
              conflictRetries: retries,
              storeError: appended.failure._tag
            }
        }
      ))
    }

    retries++
    expected = current.state.sequence
    pending = reconciled.success as [HistoryStore.EventDraft, ...Array<HistoryStore.EventDraft>]
  }
})

/**
 * Drives an existing direct-backend history to a terminal semantic state.
 *
 * **Details**
 *
 * Every decision batch crosses strict command validation before conversion and
 * is committed before any newly scheduled activity is invoked. In particular,
 * a successful command decodes its encoded values through the workflow-output
 * sink schemas. A compare-and-set conflict discards stale decisions and causes
 * a fresh read, replay, and decision. Activity results are appended in compiled
 * topological order; after a result conflict, only results whose activities
 * remain scheduled are retried, while identical committed results are skipped.
 * Result reconciliation is bounded by `maxConflictRetries` and never invokes an
 * activity handler a second time.
 *
 * Dispatch remains process-local and is not transactional with history.
 * Multiple runners can therefore deliver the same scheduled activity, and a
 * process crash can occur between schedule, handler side effects, and result
 * append. On resume, a committed schedule without a result is dispatched
 * again with the same activity and idempotency identities: this boundary is
 * at-least-once, not exactly-once. A cancellation observed before local dispatch
 * prevents that dispatch, but cancellation does not stop side effects that have
 * already started. If terminal cancellation wins a result-append race, those
 * late local outcomes are discarded; succeeded or failed terminal races fail
 * closed instead.
 *
 * @category running
 * @since 4.0.0
 */
export const run = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  options: RunOptions
): Effect.fn.Return<RunState.RunState, RunError, Requirements<W>> {
  yield* validateOptions(options)
  const store = yield* HistoryStore.HistoryStore

  for (let cycle = 1; cycle <= options.maxCycles; cycle++) {
    let inspected = yield* inspect(store, plan, options.runId)
    if (isTerminal(inspected.state)) {
      return inspected.state
    }

    if (inspected.commands.length > 0) {
      const drafts = yield* commandDrafts(plan, inspected.commands)
      const committed = yield* Effect.result(store.append({
        runId: options.runId,
        expectedLastSequence: inspected.state.sequence,
        events: drafts
      }))
      if (Result.isFailure(committed)) {
        if (committed.failure._tag === "SequenceConflict") {
          continue
        }
        return yield* Effect.fail(committed.failure)
      }

      inspected = yield* inspect(store, plan, options.runId)
      if (isTerminal(inspected.state)) {
        return inspected.state
      }
      if (inspected.commands.length > 0) {
        continue
      }
    }

    if (inspected.state.status !== "Running") {
      continue
    }
    const scheduled = scheduledInTopologicalOrder(plan, inspected.state)
    if (scheduled.length === 0) {
      return yield* Effect.fail(makeError(
        Codes.Stalled,
        options.runId,
        "The run is nonterminal but has no decision or scheduled activity to make progress"
      ))
    }

    const outcomes = yield* Effect.forEach(
      scheduled,
      (activity) =>
        ActivityRuntime.execute(
          plan.compiled,
          options.runId,
          scheduleCommand(options.runId, activity)
        ),
      { concurrency: options.concurrency }
    )
    const events = outcomes.map((outcome) => outcome.event) as [
      HistoryStore.EventDraft,
      ...Array<HistoryStore.EventDraft>
    ]
    yield* appendOutcomes(
      store,
      plan,
      options.runId,
      inspected.state.sequence,
      events,
      options.maxConflictRetries
    )
  }

  return yield* Effect.fail(makeError(
    Codes.CycleLimitExceeded,
    options.runId,
    `Local execution exceeded maxCycles ${options.maxCycles}`,
    { details: { maxCycles: options.maxCycles } }
  ))
})

/**
 * Encodes typed input, starts a direct-backend history, and drives it locally.
 *
 * **Details**
 *
 * Starting is exact-retry safe through the selected {@link HistoryStore}; this
 * function does not make the store durable and does not add cross-process
 * dispatch guarantees.
 *
 * @category running
 * @since 4.0.0
 */
export const execute = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  input: Workflow.InputValues<W>,
  options: RunOptions
): Effect.fn.Return<RunState.RunState, ExecuteError, ExecuteRequirements<W>> {
  yield* validateOptions(options)
  const start = yield* RunStart.make(plan, input, {
    runId: options.runId,
    backend: "direct"
  })
  const store = yield* HistoryStore.HistoryStore
  yield* store.start({ runId: options.runId, event: start })
  return yield* run(plan, options)
})
