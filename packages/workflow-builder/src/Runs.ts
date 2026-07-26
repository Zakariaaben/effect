/**
 * The application-facing client for starting and steering runs.
 *
 * Runs are addressed by the stable `runId` returned from {@link start} — the
 * native execution id derived from the plan pin and the caller's run key —
 * so any process holding the same `WorkflowEngine` layer can observe, signal,
 * cancel, or resume a run without extra coordination state.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Engine from "./Engine.ts"
import * as PlanStore from "./PlanStore.ts"

/**
 * Options for {@link start} and {@link execute}.
 *
 * @category models
 * @since 4.0.0
 */
export interface StartOptions {
  /** The run input; must satisfy the workflow definition's input ports. */
  readonly input?: Schema.Json | undefined
  /**
   * Caller idempotency handle. Starting the same plan revision with the same
   * key returns the same run. Defaults to a random UUID — a fresh run.
   */
  readonly runKey?: string | undefined
  /** Exact plan revision; defaults to the latest saved revision. */
  readonly revision?: number | undefined
}

/**
 * A started run's identity and pins.
 *
 * @category models
 * @since 4.0.0
 */
export interface RunHandle {
  readonly runId: string
  readonly planId: string
  readonly revision: number
  readonly fingerprint: string
  readonly runKey: string
}

const resolvePin = (
  planId: string,
  options: StartOptions | undefined
): Effect.Effect<PlanStore.StoredPlan, PlanStore.PlanNotFoundError, PlanStore.PlanStore> =>
  Effect.gen(function*() {
    const store = yield* PlanStore.PlanStore
    return yield* (options?.revision === undefined
      ? store.latest(planId)
      : store.get(planId, options.revision))
  })

const payloadFor = (
  stored: PlanStore.StoredPlan,
  options: StartOptions | undefined,
  runKey: string
): Engine.RunPayload => ({
  planId: stored.planId,
  revision: stored.revision,
  fingerprint: stored.fingerprint,
  input: options?.input ?? {},
  runKey,
  depth: 0
})

const freshRunKey = (options: StartOptions | undefined): Effect.Effect<string> =>
  options?.runKey === undefined
    ? Effect.sync(() => globalThis.crypto.randomUUID())
    : Effect.succeed(options.runKey)

/**
 * Starts a run without waiting for it and returns its durable identity.
 *
 * @category run lifecycle
 * @since 4.0.0
 */
export const start = (
  planId: string,
  options?: StartOptions
): Effect.Effect<
  RunHandle,
  PlanStore.PlanNotFoundError,
  PlanStore.PlanStore | WorkflowEngine.WorkflowEngine
> =>
  Effect.gen(function*() {
    const stored = yield* resolvePin(planId, options)
    const runKey = yield* freshRunKey(options)
    const runId = yield* Engine.Run.execute(payloadFor(stored, options, runKey), { discard: true })
    return {
      runId,
      planId: stored.planId,
      revision: stored.revision,
      fingerprint: stored.fingerprint,
      runKey
    }
  })

/**
 * Starts a run — or joins the identical already-started run — and waits for
 * its final result.
 *
 * @category run lifecycle
 * @since 4.0.0
 */
export const execute = (
  planId: string,
  options?: StartOptions
): Effect.Effect<
  Engine.RunSuccess,
  Engine.RunFailure | PlanStore.PlanNotFoundError,
  PlanStore.PlanStore | WorkflowEngine.WorkflowEngine
> =>
  Effect.gen(function*() {
    const stored = yield* resolvePin(planId, options)
    const runKey = yield* freshRunKey(options)
    return yield* Engine.Run.execute(payloadFor(stored, options, runKey))
  })

/**
 * Observable state of a run.
 *
 * @category models
 * @since 4.0.0
 */
export type RunStatus =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Suspended" }
  | { readonly _tag: "Succeeded"; readonly value: Engine.RunSuccess }
  | { readonly _tag: "Failed"; readonly error: Engine.RunFailure }
  | { readonly _tag: "Interrupted" }

/**
 * Reads the current status of a run without blocking.
 *
 * **Details**
 *
 * `Running` covers both an actively executing run and one whose result is
 * not yet observable from this engine.
 *
 * @category observation
 * @since 4.0.0
 */
export const status = (
  runId: string
): Effect.Effect<RunStatus, never, WorkflowEngine.WorkflowEngine> =>
  Engine.Run.poll(runId).pipe(
    Effect.map((result) => {
      if (Option.isNone(result)) {
        return { _tag: "Running" as const }
      }
      const value = result.value
      if (value._tag === "Suspended") {
        return { _tag: "Suspended" as const }
      }
      const exit = value.exit
      if (exit._tag === "Success") {
        return { _tag: "Succeeded" as const, value: exit.value }
      }
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      return failure !== undefined
        ? { _tag: "Failed" as const, error: (failure as { error: Engine.RunFailure }).error }
        : { _tag: "Interrupted" as const }
    })
  )

/**
 * Cooperatively cancels a run: in-flight work is interrupted, compensation
 * runs, and outstanding human tasks are cancelled.
 *
 * @category run lifecycle
 * @since 4.0.0
 */
export const cancel = (runId: string): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> =>
  Engine.Run.interrupt(runId)

/**
 * Resumes a suspended run, replaying committed work and continuing from the
 * first incomplete step.
 *
 * @category run lifecycle
 * @since 4.0.0
 */
export const resume = (runId: string): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> =>
  Engine.Run.resume(runId)

/**
 * Delivers an external signal to a run's waiting `workflow/receive` node.
 *
 * **Details**
 *
 * Delivery is first-wins and durable: redelivering the same signal cannot
 * replace an accepted payload, and a signal for a run that has not yet
 * reached its wait is retained by the engine's deferred storage.
 *
 * @category signals
 * @since 4.0.0
 */
export const signal = (
  runId: string,
  name: string,
  payload: Schema.Json
): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> => {
  const deferred = Engine.signalDeferred(name)
  const token = DurableDeferred.tokenFromExecutionId(deferred, {
    workflow: Engine.Run,
    executionId: runId
  })
  return DurableDeferred.succeed(deferred, { token, value: payload })
}
