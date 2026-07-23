/**
 * Admitted protocol version `2` decision-batch materialization.
 *
 * **Details**
 *
 * The public boundary accepts only the exact immutable command batch returned
 * by {@link DecisionV2.decide} for the supplied reducer-derived state. Canonical
 * command identifiers remain consistency checks; they are not authorization.
 *
 * Materialization is a deterministic preview of semantic events and the next
 * durable head. Applications should use `ExecutionAuthorityV2` as the atomic
 * commit boundary. The lower-level storage translator is intentionally
 * package-internal so callers cannot fabricate an otherwise canonical command
 * batch and bypass the decision engine.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as DecisionV2 from "./DecisionV2.ts"
import type * as EventV2 from "./EventV2.ts"
import * as Storage from "./internal/commandEventV2.ts"
import type * as RunStateV2 from "./RunStateV2.ts"

/**
 * Stable machine-readable public materialization failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = Storage.Codes

/**
 * A non-empty bounded batch of protocol version `2` commands.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CommandBatch = Storage.CommandBatch

/**
 * The decoded type of {@link CommandBatch}.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandBatch = Storage.CommandBatch

/**
 * A typed public command-batch materialization failure.
 *
 * @category errors
 * @since 4.0.0
 */
export const CommandEventError = Storage.CommandEventError

/**
 * The instance type of {@link CommandEventError}.
 *
 * @category errors
 * @since 4.0.0
 */
export type CommandEventError = Storage.CommandEventError

/**
 * A stable public command-batch materialization failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandEventErrorCode = Storage.CommandEventErrorCode

/**
 * Immutable events and next reducer state produced by materialization.
 *
 * @category models
 * @since 4.0.0
 */
export type MaterializedBatch = Storage.MaterializedBatch

/**
 * Materializes one decision-authorized command batch into immutable events.
 *
 * **Details**
 *
 * The batch must be the same object returned by a successful
 * {@link DecisionV2.decide} call for `initialState`. Reconstructed, cloned, or
 * caller-authored batches are rejected even if their command identifiers are
 * canonical. The execution authority should be preferred whenever the result
 * is to be committed.
 *
 * @category running
 * @since 4.0.0
 */
export const materialize = (
  initialState: RunStateV2.RunState,
  input: unknown,
  recordedAt: EventV2.Timestamp
): Result.Result<Storage.MaterializedBatch, Storage.CommandEventError> => {
  if (!DecisionV2.isDecisionBatch(initialState, input)) {
    return Result.fail(
      new Storage.CommandEventError({
        code: Storage.Codes.InvalidCommandBatch,
        message:
          "Public materialization requires the exact command batch returned by DecisionV2.decide for this reducer state"
      })
    )
  }
  return Storage.materialize(initialState, input, recordedAt)
}
