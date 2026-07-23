/**
 * One-shot durable recovery, decision, and fenced commit coordination.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as DecisionCommit from "./DecisionCommit.ts"
import type * as Deployment from "./Deployment.ts"
import * as DurableRecovery from "./DurableRecovery.ts"
import type * as ExecutionStore from "./ExecutionStore.ts"
import * as Json from "./internal/json.ts"
import * as RunCoordinatorStore from "./RunCoordinatorStore.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * One acquired run generation and stable storage request identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProcessRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  lease: RunCoordinatorStore.RunLease,
  requestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDurableCoordinatorProcessRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProcessRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessRequest = Schema.Schema.Type<typeof ProcessRequest>

/**
 * Raised when a one-shot coordinator request is not strict protocol data.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidProcessRequest extends Schema.TaggedErrorClass<InvalidProcessRequest>(
  "@effect/workflow-builder/DurableCoordinator/InvalidProcessRequest"
)("InvalidProcessRequest", {
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * A decision batch was committed under the acquired coordinator generation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Committed {
  readonly _tag: "Committed"
  readonly receipt: ExecutionStore.DecisionCommitReceipt
}

/**
 * Recovery found no commands and consumed the unchanged runnable wake.
 *
 * @category models
 * @since 4.0.0
 */
export interface Idle {
  readonly _tag: "Idle"
  readonly receipt: RunCoordinatorStore.IdleReceipt
}

/**
 * Outcome of processing one acquired runnable run.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessOutcome = Committed | Idle

/**
 * Services required for one recovered and fenced decision.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | DurableRecovery.Requirements<W>
  | DecisionCommit.Requirements<W>
  | RunCoordinatorStore.RunCoordinatorStore

/**
 * Failures produced while processing one runnable run.
 *
 * @category errors
 * @since 4.0.0
 */
export type ProcessError<W extends Workflow.Any> =
  | InvalidProcessRequest
  | DurableRecovery.RecoverError<W>
  | DecisionCommit.PrepareError
  | DecisionCommit.CommitError
  | RunCoordinatorStore.CoordinatorError
  | RunCoordinatorStore.RunSequenceAdvanced
  | ExecutionStore.RunNotFound

const decodeRequest = Schema.decodeUnknownResult(ProcessRequest, strictParseOptions)

const capture = (
  input: unknown
): Result.Result<ProcessRequest, InvalidProcessRequest> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(
      new InvalidProcessRequest({
        message: `Durable coordinator request must be strict JSON: ${snapped.failure.message}`,
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      })
    )
  }
  let decoded: ReturnType<typeof decodeRequest>
  try {
    decoded = decodeRequest(snapped.success)
  } catch {
    return Result.fail(
      new InvalidProcessRequest({
        message: "Durable coordinator request schema validation threw unexpectedly"
      })
    )
  }
  return Result.isFailure(decoded)
    ? Result.fail(
      new InvalidProcessRequest({
        message: "Invalid durable coordinator request",
        details: { parseError: decoded.failure.message }
      })
    )
    : Result.succeed(snapped.success as unknown as ProcessRequest)
}

/**
 * Recovers, decides, and atomically resolves one runnable run generation.
 *
 * **Details**
 *
 * Recovery always reads the latest authoritative history; the sequence in the
 * acquired lease is only a discovery hint. A nonempty decision is committed
 * through {@link DecisionCommit.commit}. An empty decision clears the wake only
 * if the recovered history head is still current. Completion, cancellation, or
 * another decision arriving between recovery and storage therefore wins by
 * sequence and leaves a runnable wake intact.
 *
 * This is a one-shot convenience. If the final storage response is uncertain,
 * retry that exact `DecisionCommit.commit` or `acknowledgeIdle` request while it
 * is retained. After process loss, let the lease expire or release it and claim
 * the still-authoritative runnable state again; do not rerun user activity code
 * merely to recover an acknowledgement.
 *
 * @category running
 * @since 4.0.0
 */
export const process = Effect.fnUntraced(function*<W extends Workflow.Any>(
  input: ProcessRequest,
  expectedDeployment: Deployment.WorkflowDefinitionDeployment<W>
): Effect.fn.Return<ProcessOutcome, ProcessError<W>, Requirements<W>> {
  const captured = capture(input)
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const request = captured.success
  const recovered = yield* DurableRecovery.recover(
    request.lease.ref.key,
    expectedDeployment
  )
  const prepared = yield* DecisionCommit.prepare(
    recovered.plan,
    recovered.state,
    recovered.boundPlan
  )
  if (Option.isSome(prepared)) {
    const receipt = yield* DecisionCommit.commit(
      prepared.value,
      request.lease,
      request.requestId
    )
    return Object.freeze({ _tag: "Committed", receipt })
  }
  const store = yield* RunCoordinatorStore.RunCoordinatorStore
  const receipt = yield* store.acknowledgeIdle({
    requestVersion: 1,
    ref: request.lease.ref,
    requestId: request.requestId,
    observedLastSequence: recovered.state.sequence
  })
  return Object.freeze({ _tag: "Idle", receipt })
})
