/**
 * Preparation of atomic decision commits and activity dispatch intents.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as CommandEvent from "./CommandEvent.ts"
import * as CommandRuntime from "./CommandRuntime.ts"
import * as Decision from "./Decision.ts"
import * as ExecutionStore from "./ExecutionStore.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"
import * as PlanStore from "./PlanStore.ts"
import * as RunCoordinatorStore from "./RunCoordinatorStore.ts"
import type * as RunState from "./RunState.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = { onExcessProperty: "error" } as const
const PreparedDecisionCommitTypeId: unique symbol = Symbol(
  "@effect/workflow-builder/DecisionCommit/PreparedDecisionCommit"
)
const preparedDecisionCommits = new WeakSet<object>()

/**
 * Stable machine-readable decision-commit preparation failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidBoundPlan: "InvalidBoundPlan",
  ArtifactMismatch: "ArtifactMismatch",
  InvalidCommit: "InvalidCommit"
} as const

/**
 * A stable machine-readable preparation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type DecisionCommitPreparationErrorCode = typeof Codes[keyof typeof Codes]

const DecisionCommitPreparationErrorCode = Schema.Literals([
  Codes.InvalidBoundPlan,
  Codes.ArtifactMismatch,
  Codes.InvalidCommit
])

const decodeBoundPlan = Schema.decodeUnknownResult(PlanStore.BoundPlan, {
  errors: "all",
  onExcessProperty: "error"
})
const decodeWire = Schema.decodeUnknownResult(ExecutionStore.DecisionCommitDraft, {
  errors: "all",
  onExcessProperty: "error"
})
const decodeRunLease = Schema.decodeUnknownResult(RunCoordinatorStore.RunLease, {
  errors: "all",
  onExcessProperty: "error"
})
const decodeCommitRequest = Schema.decodeUnknownResult(RunCoordinatorStore.CommitDecisionRequest, {
  errors: "all",
  onExcessProperty: "error"
})

/**
 * Raised when a decision cannot be converted into a strict atomic commit.
 *
 * @category errors
 * @since 4.0.0
 */
export class DecisionCommitPreparationError extends Schema.TaggedErrorClass<DecisionCommitPreparationError>(
  "@effect/workflow-builder/DecisionCommit/DecisionCommitPreparationError"
)("DecisionCommitPreparationError", {
  code: DecisionCommitPreparationErrorCode,
  message: Schema.NonEmptyString,
  nodeId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Immutable dispatch targets keyed by every compiled node identifier.
 *
 * @deprecated Durable decisions derive targets from {@link PlanStore.BoundPlan}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchTargets = PlanStore.DispatchTargets

/**
 * An atomic decision commit admitted by {@link prepare}.
 *
 * **Details**
 *
 * Provenance is retained only inside this process. Stores must independently
 * revalidate `wire` and may not treat this marker as a trust boundary.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedDecisionCommit {
  readonly [PreparedDecisionCommitTypeId]: true
  readonly wire: ExecutionStore.DecisionCommitDraft
}

/**
 * Effect services required to prepare a decision commit.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> = CommandRuntime.Requirements<W>

/**
 * Failures that may be produced while preparing a decision commit.
 *
 * @category errors
 * @since 4.0.0
 */
export type PrepareError =
  | Decision.DecisionError
  | CommandRuntime.CommandRuntimeError
  | CommandEvent.CommandEventError
  | DecisionCommitPreparationError

/**
 * Failures produced while committing an exact prepared decision under a run
 * coordinator fence.
 *
 * @category errors
 * @since 4.0.0
 */
export type CommitError =
  | DecisionCommitPreparationError
  | ExecutionStore.DecisionCommitError

/**
 * Tests whether a value is the exact object returned by {@link prepare}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (value: unknown): value is PreparedDecisionCommit =>
  typeof value === "object" && value !== null && preparedDecisionCommits.has(value)

const makeError = (
  code: DecisionCommitPreparationErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): DecisionCommitPreparationError =>
  new DecisionCommitPreparationError({
    code,
    message,
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const snapshotBoundPlan = (
  plan: Decision.DecidablePlan,
  state: RunState.RunState,
  input: unknown
): Result.Result<PlanStore.BoundPlan, DecisionCommitPreparationError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidBoundPlan,
      `Bound plan must be strict JSON: ${snapped.failure.message}`,
      {
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      }
    ))
  }

  let decoded: ReturnType<typeof decodeBoundPlan>
  try {
    decoded = decodeBoundPlan(snapped.success)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidBoundPlan,
      "Bound-plan schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(makeError(Codes.InvalidBoundPlan, "Invalid bound plan", {
      details: { parseError: decoded.failure.message }
    }))
  }

  const bound = snapped.success as unknown as PlanStore.BoundPlan
  const artifact = PlanStore.validateArtifact(bound.artifact)
  if (Result.isFailure(artifact)) {
    return Result.fail(makeError(Codes.InvalidBoundPlan, artifact.failure.message, {
      details: {
        code: artifact.failure.code,
        ...(artifact.failure.details === undefined ? undefined : { artifact: artifact.failure.details })
      }
    }))
  }
  if (
    bound.binding.key.runId !== state.runId ||
    bound.binding.runStartedEventId !== Identity.runStartedEventId(state.runId)
  ) {
    return Result.fail(makeError(
      Codes.InvalidBoundPlan,
      "Bound plan does not identify the replayed run",
      {
        details: {
          expectedRunId: state.runId,
          actualRunId: bound.binding.key.runId,
          expectedRunStartedEventId: Identity.runStartedEventId(state.runId),
          actualRunStartedEventId: bound.binding.runStartedEventId
        }
      }
    ))
  }
  const materialized = Fingerprint.materialize(plan.compiled)
  if (
    bound.artifact.compiledFingerprint !== plan.compiledFingerprint ||
    Json.canonicalizeSnapshot(bound.artifact.fingerprintDocument as unknown as Schema.Json) !==
      Json.canonicalizeSnapshot(materialized as unknown as Schema.Json)
  ) {
    return Result.fail(makeError(
      Codes.ArtifactMismatch,
      "Bound artifact does not match the prepared compiled plan",
      {
        details: {
          expectedCompiledFingerprint: plan.compiledFingerprint,
          actualCompiledFingerprint: bound.artifact.compiledFingerprint
        }
      }
    ))
  }
  return Result.succeed(bound)
}

const snapshotWire = (
  input: unknown
): Result.Result<ExecutionStore.DecisionCommitDraft, DecisionCommitPreparationError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(
      makeError(Codes.InvalidCommit, `Decision commit must be strict JSON: ${snapped.failure.message}`, {
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      })
    )
  }

  let decoded: ReturnType<typeof decodeWire>
  try {
    decoded = decodeWire(snapped.success)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidCommit,
      "Decision commit schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(makeError(Codes.InvalidCommit, "Invalid decision commit", {
      details: { parseError: decoded.failure.message }
    }))
  }
  return Result.succeed(snapped.success as unknown as ExecutionStore.DecisionCommitDraft)
}

/**
 * Decides and prepares one strict atomic decision commit.
 *
 * **Details**
 *
 * The bound artifact must match the exact prepared compiled plan and replayed
 * run. Its immutable targets name every compiled node, so callers cannot select
 * a new queue or deployment for a later decision. Activity commands produce
 * paired semantic events and dispatch drafts; terminal commands produce only
 * semantic events. Commands cross the effectful workflow-output validation
 * boundary before conversion. The returned wire value is detached and
 * recursively frozen.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  state: RunState.RunState,
  boundPlan: PlanStore.BoundPlan
): Effect.fn.Return<
  Option.Option<PreparedDecisionCommit>,
  PrepareError,
  Requirements<W>
> {
  const commands = Decision.decide(plan, state)
  if (Result.isFailure(commands)) {
    return yield* Effect.fail(commands.failure)
  }

  const validatedBoundPlan = snapshotBoundPlan(plan, state, boundPlan)
  if (Result.isFailure(validatedBoundPlan)) {
    return yield* Effect.fail(validatedBoundPlan.failure)
  }
  if (commands.success.length === 0) {
    return Option.none()
  }

  const events: Array<
    ReturnType<typeof CommandEvent.fromCommand> extends Result.Result<infer A, CommandEvent.CommandEventError> ? A :
      never
  > = []
  const dispatches: Array<ExecutionStore.ActivityDispatchDraft> = []
  for (const command of commands.success) {
    const validated = yield* CommandRuntime.validate(plan.compiled, command)
    const converted = CommandEvent.fromCommand(validated)
    if (Result.isFailure(converted)) {
      return yield* Effect.fail(converted.failure)
    }
    events.push(converted.success)
    if (validated.payload._tag !== "ScheduleActivity") {
      continue
    }
    dispatches.push({
      dispatchVersion: 1,
      _tag: "Activity",
      intentId: validated.commandId,
      sourceEventId: validated.commandId,
      command: {
        commandVersion: validated.commandVersion,
        commandId: validated.commandId,
        payload: validated.payload
      },
      target: validatedBoundPlan.success.artifact.dispatchTargets[validated.payload.nodeId]!
    })
  }

  const wire = snapshotWire({
    commitVersion: 1,
    key: validatedBoundPlan.success.binding.key,
    expectedLastSequence: state.sequence,
    events,
    dispatches
  })
  if (Result.isFailure(wire)) {
    return yield* Effect.fail(wire.failure)
  }

  const prepared: PreparedDecisionCommit = Object.freeze({
    [PreparedDecisionCommitTypeId]: true as const,
    wire: wire.success
  })
  preparedDecisionCommits.add(prepared)
  return Option.some(prepared)
})

/**
 * Commits an exact prepared decision under one current coordinator lease.
 *
 * **Details**
 *
 * Prepared-decision provenance, strict lease data, request identity, and the
 * tenant-scoped run key are checked before calling storage. The store remains
 * authoritative: it revalidates the nested decision, lease capability, expiry,
 * and expected history head in its atomic mutation. Repeating the same accepted
 * request returns its original receipt even after the lease has been cleared.
 *
 * @category running
 * @since 4.0.0
 */
export const commit = Effect.fnUntraced(function*(
  prepared: PreparedDecisionCommit,
  inputLease: RunCoordinatorStore.RunLease,
  requestId: string
): Effect.fn.Return<
  ExecutionStore.DecisionCommitReceipt,
  CommitError,
  RunCoordinatorStore.RunCoordinatorStore
> {
  if (!isPrepared(prepared)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Decision commit requires the exact result of DecisionCommit.prepare"
    ))
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Decision commit requestId must be a non-empty string"
    ))
  }
  const snappedLease = Json.snapshot(inputLease)
  if (Result.isFailure(snappedLease)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      `Coordinator lease must be strict JSON: ${snappedLease.failure.message}`,
      {
        details: {
          snapshotError: snappedLease.failure.message,
          path: [...snappedLease.failure.path]
        }
      }
    ))
  }
  let decodedLease: ReturnType<typeof decodeRunLease>
  try {
    decodedLease = decodeRunLease(snappedLease.success)
  } catch {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Coordinator lease schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decodedLease)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Invalid coordinator lease",
      { details: { parseError: decodedLease.failure.message } }
    ))
  }
  const lease = snappedLease.success as unknown as RunCoordinatorStore.RunLease
  if (
    lease.ref.key.tenantId !== prepared.wire.key.tenantId ||
    lease.ref.key.runId !== prepared.wire.key.runId
  ) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Coordinator lease and prepared decision identify different runs"
    ))
  }
  const rawRequest = {
    requestVersion: 1 as const,
    ref: lease.ref,
    requestId,
    commit: prepared.wire
  }
  const snappedRequest = Json.snapshot(rawRequest)
  if (Result.isFailure(snappedRequest)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      `Fenced decision request must be strict JSON: ${snappedRequest.failure.message}`
    ))
  }
  let decodedRequest: ReturnType<typeof decodeCommitRequest>
  try {
    decodedRequest = decodeCommitRequest(snappedRequest.success)
  } catch {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Fenced decision request schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decodedRequest)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidCommit,
      "Invalid fenced decision request",
      { details: { parseError: decodedRequest.failure.message } }
    ))
  }
  const store = yield* RunCoordinatorStore.RunCoordinatorStore
  return yield* store.commitDecision(
    snappedRequest.success as unknown as RunCoordinatorStore.CommitDecisionRequest
  )
})
