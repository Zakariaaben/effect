/**
 * Durable worker boundary for exact deployed handlers and fenced completions.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityCancellationWorker from "./ActivityCancellationWorker.ts"
import * as ActivityDeliveryStore from "./ActivityDeliveryStore.ts"
import * as ActivityRuntime from "./ActivityRuntime.ts"
import * as DeploymentHandlers from "./DeploymentHandlers.ts"
import type * as Dispatch from "./Dispatch.ts"
import * as DurableRecovery from "./DurableRecovery.ts"
import * as Json from "./internal/json.ts"
import * as Registry from "./Registry.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const decodeLease = Schema.decodeUnknownResult(ActivityDeliveryStore.ActivityLease, strictParseOptions)

/**
 * Raised before user code when a durable lease, run, route, or handler pin is
 * inconsistent.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityWorkerError extends Schema.TaggedErrorClass<ActivityWorkerError>(
  "@effect/workflow-builder/ActivityWorker/ActivityWorkerError"
)("ActivityWorkerError", {
  phase: Schema.Literals(["lease", "run", "route", "handler"]),
  tenantId: Schema.String,
  runId: Schema.String,
  intentId: Schema.optionalKey(Schema.NonEmptyString),
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * A validated activity execution and its strict encoded completion result.
 *
 * @category models
 * @since 4.0.0
 */
export interface Executed<out Failure> {
  readonly outcome: ActivityRuntime.Outcome<Failure>
  readonly result: Dispatch.ActivityResult
}

/**
 * A completed activity execution with its storage receipt.
 *
 * @category models
 * @since 4.0.0
 */
export interface Completed<out Failure> extends Executed<Failure> {
  readonly receipt: ActivityDeliveryStore.CompletionReceipt
}

/**
 * Services required to execute an exact deployed durable handler.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ExecuteRequirements<W extends Workflow.Any> =
  | Exclude<ActivityRuntime.Requirements<W>, Registry.HandlerRegistry>
  | DeploymentHandlers.DeploymentHandlerRegistry

/**
 * Services required to execute and commit a fenced durable handler result.
 *
 * @category utility types
 * @since 4.0.0
 */
export type RunRequirements<W extends Workflow.Any> =
  | ExecuteRequirements<W>
  | ActivityDeliveryStore.ActivityDeliveryStore

/**
 * Services required to execute a cancellation-observable durable handler and
 * commit its result.
 *
 * @category utility types
 * @since 4.0.0
 */
export type CancellableRunRequirements<W extends Workflow.Any> =
  | RunRequirements<W>
  | ActivityCancellationWorker.ActivityExecutionRegistry

const makeError = (
  phase: "lease" | "run" | "route" | "handler",
  tenantId: string,
  runId: string,
  message: string,
  options: {
    readonly intentId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): ActivityWorkerError =>
  new ActivityWorkerError({
    phase,
    tenantId,
    runId,
    message,
    ...(options.intentId === undefined ? undefined : { intentId: options.intentId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const captureLease = (
  input: unknown
): Result.Result<ActivityDeliveryStore.ActivityLease, ActivityWorkerError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      "lease",
      "",
      "",
      `Activity lease must be strict JSON: ${snapped.failure.message}`
    ))
  }
  let decoded: ReturnType<typeof decodeLease>
  try {
    decoded = decodeLease(snapped.success)
  } catch {
    return Result.fail(makeError(
      "lease",
      "",
      "",
      "Activity lease schema validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError("lease", "", "", "Invalid activity lease", {
      details: { parseError: decoded.failure.message }
    }))
    : Result.succeed(snapped.success as unknown as ActivityDeliveryStore.ActivityLease)
}

/**
 * Executes one acquired activity lease with its exact pinned handler build.
 *
 * **Details**
 *
 * The lease is detached through a strict JSON boundary. Tenant, run, dispatch,
 * route, definition, and handler-deployment identities are cross-checked before
 * user code is invoked. The operational delivery epoch is not exposed in
 * `Node.HandlerContext`, so redelivery cannot alter business idempotency.
 *
 * @category running
 * @since 4.0.0
 */
export const execute = Effect.fnUntraced(function*<W extends Workflow.Any>(
  recovered: DurableRecovery.RecoveredRun<W>,
  inputLease: ActivityDeliveryStore.ActivityLease
): Effect.fn.Return<
  Executed<ActivityRuntime.Failure<W>>,
  ActivityWorkerError | ActivityRuntime.ActivityRuntimeError,
  ExecuteRequirements<W>
> {
  if (!DurableRecovery.isRecovered(recovered)) {
    return yield* Effect.fail(makeError(
      "run",
      "",
      "",
      "Durable activity execution requires the exact result of DurableRecovery.recover"
    ))
  }
  const captured = captureLease(inputLease)
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const lease = captured.success
  const dispatch = lease.dispatch
  const schedule = dispatch.command.payload
  if (
    lease.ref.key.tenantId !== recovered.key.tenantId ||
    dispatch.tenantId !== recovered.key.tenantId ||
    dispatch.runId !== recovered.key.runId ||
    lease.ref.key.intentId !== dispatch.intentId ||
    lease.pointer.key.tenantId !== dispatch.tenantId ||
    lease.pointer.key.intentId !== dispatch.intentId
  ) {
    return yield* Effect.fail(makeError(
      "run",
      recovered.key.tenantId,
      recovered.key.runId,
      "Activity lease does not belong to the recovered tenant-scoped run",
      { intentId: dispatch.intentId }
    ))
  }
  if (
    lease.ref.workerDeploymentId !== dispatch.target.deploymentId ||
    recovered.artifact.dispatchTargets[schedule.nodeId]?.queue !== dispatch.target.queue ||
    recovered.artifact.dispatchTargets[schedule.nodeId]?.deploymentId !== dispatch.target.deploymentId
  ) {
    return yield* Effect.fail(makeError(
      "route",
      recovered.key.tenantId,
      recovered.key.runId,
      "Activity lease route differs from the recovered immutable dispatch target",
      {
        intentId: dispatch.intentId,
        details: {
          nodeId: schedule.nodeId,
          queue: dispatch.target.queue,
          deploymentId: dispatch.target.deploymentId
        }
      }
    ))
  }
  const compiledNode = recovered.plan.compiled.nodes.get(schedule.nodeId)
  if (compiledNode === undefined) {
    return yield* Effect.fail(makeError(
      "run",
      recovered.key.tenantId,
      recovered.key.runId,
      "Activity lease references a node absent from the recovered compiled plan",
      { intentId: dispatch.intentId }
    ))
  }
  const deployedHandlers = yield* DeploymentHandlers.DeploymentHandlerRegistry
  if (!DeploymentHandlers.isDeploymentHandlerRegistry(deployedHandlers)) {
    return yield* Effect.fail(makeError(
      "handler",
      recovered.key.tenantId,
      recovered.key.runId,
      "Durable activity execution requires an exact DeploymentHandlerRegistry",
      { intentId: dispatch.intentId }
    ))
  }
  const entry = deployedHandlers.get(
    dispatch.target.deploymentId,
    compiledNode.definition.type,
    compiledNode.definition.version
  )
  if (
    entry === undefined ||
    entry.deploymentId !== dispatch.target.deploymentId ||
    entry.definition !== compiledNode.definition ||
    !Registry.isHandlerRegistry(entry.registry)
  ) {
    return yield* Effect.fail(makeError(
      "handler",
      recovered.key.tenantId,
      recovered.key.runId,
      "No exact handler implementation is installed for the pinned deployment",
      {
        intentId: dispatch.intentId,
        details: {
          deploymentId: dispatch.target.deploymentId,
          type: compiledNode.definition.type,
          version: compiledNode.definition.version
        }
      }
    ))
  }

  const outcome = yield* ActivityRuntime.execute(
    recovered.plan.compiled,
    {
      tenantId: recovered.key.tenantId,
      runId: recovered.key.runId,
      handlerDeploymentId: dispatch.target.deploymentId
    },
    dispatch.command
  ).pipe(Effect.provideService(Registry.HandlerRegistry, entry.registry))
  const result: Dispatch.ActivityResult = outcome._tag === "Succeeded"
    ? Object.freeze({
      _tag: "Succeeded",
      output: outcome.event.payload.output
    })
    : Object.freeze({
      _tag: "Failed",
      failure: outcome.event.payload.failure
    })
  return Object.freeze({ outcome, result })
})

/**
 * Executes one acquired lease and atomically commits its result under the same
 * fence.
 *
 * @category running
 * @since 4.0.0
 */
export const run = Effect.fnUntraced(function*<W extends Workflow.Any>(
  recovered: DurableRecovery.RecoveredRun<W>,
  lease: ActivityDeliveryStore.ActivityLease,
  completionRequestId: string
): Effect.fn.Return<
  Completed<ActivityRuntime.Failure<W>>,
  | ActivityWorkerError
  | ActivityRuntime.ActivityRuntimeError
  | ActivityDeliveryStore.DeliveryStoreError
  | ActivityDeliveryStore.StaleActivityLease
  | ActivityDeliveryStore.ActivityCompletionSuppressed
  | ActivityDeliveryStore.ConflictingCompletion,
  RunRequirements<W>
> {
  const executed = yield* execute(recovered, lease)
  const deliveryStore = yield* ActivityDeliveryStore.ActivityDeliveryStore
  const receipt = yield* deliveryStore.completeAttempt({
    requestVersion: 1,
    ref: lease.ref,
    requestId: completionRequestId,
    result: executed.result
  })
  return Object.freeze({ ...executed, receipt })
})

/**
 * Executes a lease under its exact process-local cancellation registration,
 * then atomically commits its result under the worker fence.
 *
 * **Details**
 *
 * The handler fiber is registered before user code begins. A cancellation
 * tombstone installed before registration causes immediate interruption, and
 * a cancellation delivered during execution waits for handler finalizers.
 * Durable storage still serializes completion versus semantic cancellation;
 * this process-local registration is operational delivery, not semantic
 * authority.
 *
 * @category running
 * @since 4.0.0
 */
export const runCancellable = Effect.fnUntraced(function*<
  W extends Workflow.Any
>(
  recovered: DurableRecovery.RecoveredRun<W>,
  lease: ActivityDeliveryStore.ActivityLease,
  completionRequestId: string
): Effect.fn.Return<
  Completed<ActivityRuntime.Failure<W>>,
  | ActivityWorkerError
  | ActivityRuntime.ActivityRuntimeError
  | ActivityDeliveryStore.DeliveryStoreError
  | ActivityDeliveryStore.StaleActivityLease
  | ActivityDeliveryStore.ActivityCompletionSuppressed
  | ActivityDeliveryStore.ConflictingCompletion
  | ActivityCancellationWorker.InvalidActivityExecutionRef
  | ActivityCancellationWorker.ActivityExecutionAlreadyRegistered,
  CancellableRunRequirements<W>
> {
  const registry = yield* ActivityCancellationWorker.ActivityExecutionRegistry
  const executed = yield* registry.run(
    lease.ref,
    execute(recovered, lease)
  )
  const deliveryStore = yield* ActivityDeliveryStore.ActivityDeliveryStore
  const receipt = yield* deliveryStore.completeAttempt({
    requestVersion: 1,
    ref: lease.ref,
    requestId: completionRequestId,
    result: executed.result
  })
  return Object.freeze({ ...executed, receipt })
})
