/**
 * Trusted bridge from native Effect Workflow retry execution to portable BPMN
 * Task resolution.
 *
 * **Details**
 *
 * This module owns no activity, timer, persistence, replay, or BPMN state
 * implementation. It executes one exact protocol-v3 retry invocation through
 * {@link EffectWorkflowRetryV3}, then translates its authenticated terminal
 * coordinates into one {@link BpmnActivityV3.ResolveTaskCommand}.
 *
 * The command is intentionally not applied here. A durable coordinator must
 * serialize or compare-and-swap the later {@link BpmnKernel.resolveTask}
 * transition. Attempt timeout, schedule-to-close timeout, defects,
 * interruption, and adapter failures never become BPMN Error outcomes.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnActivityV3 from "./BpmnActivityV3.ts"
import * as BpmnKernel from "./BpmnKernel.ts"
import * as EffectWorkflowRetryV3 from "./EffectWorkflowRetryV3.ts"
import type * as EffectWorkflowSemanticV3 from "./EffectWorkflowSemanticV3.ts"
import * as Json from "./internal/json.ts"
import type * as SemanticOccurrenceV3 from "./SemanticOccurrenceV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the native-Effect-to-BPMN bridge receipt.
 *
 * @category constants
 * @since 4.0.0
 */
export const BridgeVersion = 2 as const

/**
 * Exact BPMN wait-state coordinates selected by a durable coordinator.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskResolutionTarget = Schema.Struct({
  scopeInstanceId: Schema.NonEmptyString,
  taskNodeId: Schema.NonEmptyString,
  tokenId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowEffectWorkflowBpmnV3TaskResolutionTarget",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskResolutionTarget}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskResolutionTarget = Schema.Schema.Type<
  typeof TaskResolutionTarget
>

/**
 * Retry outcomes that may resolve a BPMN Task.
 *
 * **Details**
 *
 * Attempt and schedule-to-close timeouts are deliberately excluded. A future
 * Boundary Timer integration needs a distinct BPMN timer subscription and
 * must not masquerade as an Error event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvableRetryOutcome = Schema.Union([
  EffectWorkflowRetryV3.NodeAttemptSucceeded,
  EffectWorkflowRetryV3.NonRetryable,
  EffectWorkflowRetryV3.Exhausted
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnV3ResolvableRetryOutcome",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolvableRetryOutcome}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvableRetryOutcome = Schema.Schema.Type<
  typeof ResolvableRetryOutcome
>

/**
 * Portable result of one bridge execution.
 *
 * **Details**
 *
 * `command` is the minimal durable input for the BPMN kernel.
 * `retryOutcome` retains the encoded success output or complete retry
 * explanation for downstream data mapping and observability without a second
 * workflow execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExecutedTaskResolution = Schema.Struct({
  bridgeVersion: Schema.Literal(BridgeVersion),
  command: BpmnActivityV3.ResolveTaskCommand,
  retryOutcome: ResolvableRetryOutcome
}).annotate({
  identifier: "WorkflowEffectWorkflowBpmnV3ExecutedTaskResolution",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExecutedTaskResolution}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutedTaskResolution = Schema.Schema.Type<
  typeof ExecutedTaskResolution
>

/**
 * Stable bridge failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidTaskTarget: "InvalidTaskTarget",
  InvalidKernelAuthority: "InvalidKernelAuthority",
  TaskBindingUnavailable: "TaskBindingUnavailable",
  TaskOccurrenceUnavailable: "TaskOccurrenceUnavailable",
  TaskCollectionItemUnavailable: "TaskCollectionItemUnavailable",
  InvalidInvocation: "InvalidInvocation",
  InvocationBindingMismatch: "InvocationBindingMismatch",
  InvocationOccurrenceMismatch: "InvocationOccurrenceMismatch",
  InvocationInputMismatch: "InvocationInputMismatch",
  InvalidResolutionReceipt: "InvalidResolutionReceipt"
} as const

/**
 * A stable bridge failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidTaskTarget,
  ErrorCodes.InvalidKernelAuthority,
  ErrorCodes.TaskBindingUnavailable,
  ErrorCodes.TaskOccurrenceUnavailable,
  ErrorCodes.TaskCollectionItemUnavailable,
  ErrorCodes.InvalidInvocation,
  ErrorCodes.InvocationBindingMismatch,
  ErrorCodes.InvocationOccurrenceMismatch,
  ErrorCodes.InvocationInputMismatch,
  ErrorCodes.InvalidResolutionReceipt
])

/**
 * Typed admission or translation failure at the Effect Workflow / BPMN
 * boundary.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowBpmnError extends Schema.TaggedErrorClass<
  EffectWorkflowBpmnError
>("@effect/workflow-builder/EffectWorkflowBpmnV3/Error")(
  "EffectWorkflowBpmnError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    scopeInstanceId: Schema.optionalKey(Schema.NonEmptyString),
    taskNodeId: Schema.optionalKey(Schema.NonEmptyString),
    tokenId: Schema.optionalKey(Schema.NonEmptyString)
  },
  { parseOptions: strictParseOptions }
) {}

const bridgeError = (
  code: ErrorCode,
  message: string,
  target?: TaskResolutionTarget
): EffectWorkflowBpmnError =>
  new EffectWorkflowBpmnError({
    code,
    message,
    ...(target === undefined
      ? undefined
      : {
        scopeInstanceId: target.scopeInstanceId,
        taskNodeId: target.taskNodeId,
        tokenId: target.tokenId
      })
  })

const decodeTarget = Schema.decodeUnknownResult(
  TaskResolutionTarget,
  strictParseOptions
)
const decodeReceipt = Schema.decodeUnknownResult(
  ExecutedTaskResolution,
  strictParseOptions
)

const captureTarget = (
  input: unknown
): Result.Result<TaskResolutionTarget, EffectWorkflowBpmnError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(bridgeError(
      ErrorCodes.InvalidTaskTarget,
      snapshot.failure.message
    ))
  }
  const decoded = decodeTarget(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(bridgeError(
      ErrorCodes.InvalidTaskTarget,
      "Invalid BPMN Task resolution target"
    ))
  }
  return Result.succeed(
    snapshot.success as unknown as TaskResolutionTarget
  )
}

const lookupBinding = (
  kernel: BpmnKernel.CompiledKernel,
  target: TaskResolutionTarget
): Result.Result<BpmnActivityV3.TaskBinding, EffectWorkflowBpmnError> => {
  const binding = BpmnKernel.taskBinding(kernel, target.taskNodeId)
  if (Result.isSuccess(binding)) {
    return Result.succeed(binding.success)
  }
  const diagnostic = binding.failure.diagnostics[0]
  return Result.fail(bridgeError(
    diagnostic.code === BpmnKernel.Codes.InvalidKernel
      ? ErrorCodes.InvalidKernelAuthority
      : ErrorCodes.TaskBindingUnavailable,
    diagnostic.message,
    target
  ))
}

const lookupOccurrence = (
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  target: TaskResolutionTarget
): Result.Result<
  BpmnKernel.TaskOccurrenceCoordinates,
  EffectWorkflowBpmnError
> => {
  const occurrence = BpmnKernel.taskOccurrence(
    kernel,
    stateInput,
    target
  )
  if (Result.isSuccess(occurrence)) {
    return Result.succeed(occurrence.success)
  }
  const diagnostic = occurrence.failure.diagnostics[0]
  return Result.fail(bridgeError(
    diagnostic.code === BpmnKernel.Codes.InvalidKernel
      ? ErrorCodes.InvalidKernelAuthority
      : ErrorCodes.TaskOccurrenceUnavailable,
    diagnostic.message,
    target
  ))
}

const lookupCollectionItem = (
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  target: TaskResolutionTarget
): Result.Result<
  BpmnKernel.TaskCollectionItem | undefined,
  EffectWorkflowBpmnError
> => {
  const item = BpmnKernel.taskCollectionItem(
    kernel,
    stateInput,
    target
  )
  if (Result.isSuccess(item)) {
    return Result.succeed(item.success)
  }
  const diagnostic = item.failure.diagnostics[0]
  return Result.fail(bridgeError(
    diagnostic.code === BpmnKernel.Codes.InvalidKernel
      ? ErrorCodes.InvalidKernelAuthority
      : ErrorCodes.TaskCollectionItemUnavailable,
    diagnostic.message,
    target
  ))
}

const sameOccurrenceCoordinates = (
  expected: BpmnKernel.TaskOccurrenceCoordinates,
  actual: EffectWorkflowRetryV3.PreparedRetryInvocation,
  occurrence: SemanticOccurrenceV3.PreparedOccurrence
): boolean =>
  actual.occurrenceDigest === occurrence.occurrenceDigest &&
  expected.nodeId === occurrence.document.nodeId &&
  expected.activation === occurrence.document.activation &&
  expected.scopePath.length === occurrence.document.scopePath.length &&
  expected.scopePath.every((activation, index) => {
    const candidate = occurrence.document.scopePath[index]
    return candidate !== undefined &&
      activation.scopeActivationVersion ===
        candidate.scopeActivationVersion &&
      activation.scopeId === candidate.scopeId &&
      activation.activation === candidate.activation
  })

const sameJson = (left: unknown, right: unknown): boolean => {
  const leftSnapshot = Json.snapshot(left)
  const rightSnapshot = Json.snapshot(right)
  return Result.isSuccess(leftSnapshot) &&
    Result.isSuccess(rightSnapshot) &&
    Json.canonicalizeSnapshot(leftSnapshot.success) ===
      Json.canonicalizeSnapshot(rightSnapshot.success)
}

const succeededOutcome = (
  invocation: EffectWorkflowRetryV3.PreparedRetryInvocation,
  outcome: EffectWorkflowRetryV3.NodeAttemptSucceeded
): BpmnActivityV3.TaskSucceeded => ({
  _tag: "Succeeded",
  outcomeVersion: BpmnActivityV3.OutcomeVersion,
  artifactDigest: invocation.artifactDigest,
  semanticNodeId: invocation.nodeId,
  occurrenceDigest: invocation.occurrenceDigest,
  firstActivityDigest: invocation.firstActivityDigest,
  attempt: outcome.attempt,
  completedActivityDigest: outcome.activityDigest,
  output: outcome.output
})

const businessFailureOutcome = (
  invocation: EffectWorkflowRetryV3.PreparedRetryInvocation,
  outcome:
    | EffectWorkflowRetryV3.NonRetryable
    | EffectWorkflowRetryV3.Exhausted
): BpmnActivityV3.TaskBusinessFailed => ({
  _tag: "BusinessFailed",
  outcomeVersion: BpmnActivityV3.OutcomeVersion,
  artifactDigest: invocation.artifactDigest,
  semanticNodeId: invocation.nodeId,
  occurrenceDigest: invocation.occurrenceDigest,
  firstActivityDigest: invocation.firstActivityDigest,
  terminal: outcome._tag === "NonRetryable"
    ? {
      _tag: "NonRetryable",
      terminalVersion: outcome.terminalVersion,
      decision: outcome.decision
    }
    : {
      _tag: "Exhausted",
      terminalVersion: outcome.terminalVersion,
      classificationActivityDigest: outcome.classificationActivityDigest,
      reason: outcome.reason
    },
  failedActivityDigest: outcome.cause.activityDigest,
  attempt: outcome.cause.attempt,
  identity: outcome.cause.identity
})

const resolutionReceipt = (
  invocation: EffectWorkflowRetryV3.PreparedRetryInvocation,
  target: TaskResolutionTarget,
  outcome: ResolvableRetryOutcome
): Result.Result<ExecutedTaskResolution, EffectWorkflowBpmnError> => {
  const command: BpmnActivityV3.ResolveTaskCommand = {
    commandVersion: BpmnActivityV3.CommandVersion,
    scopeInstanceId: target.scopeInstanceId,
    taskNodeId: target.taskNodeId,
    tokenId: target.tokenId,
    outcome: outcome._tag === "Succeeded"
      ? succeededOutcome(invocation, outcome)
      : businessFailureOutcome(invocation, outcome)
  }
  const snapshot = Json.snapshot({
    bridgeVersion: BridgeVersion,
    command,
    retryOutcome: outcome
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(bridgeError(
      ErrorCodes.InvalidResolutionReceipt,
      snapshot.failure.message,
      target
    ))
  }
  const decoded = decodeReceipt(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(bridgeError(
      ErrorCodes.InvalidResolutionReceipt,
      "Native retry outcome could not be represented as a BPMN Task resolution",
      target
    ))
  }
  return Result.succeed(
    snapshot.success as unknown as ExecutedTaskResolution
  )
}

/**
 * Executes one exact native retry invocation and prepares its portable BPMN
 * Task-resolution command.
 *
 * **Details**
 *
 * The exact compiled kernel and replay-derived execution state are consulted
 * before execution, so a structural kernel copy, unbound task, stale token,
 * artifact/node mismatch, or forged loop/scope activation cannot dispatch the
 * first handler. `stateInput` must be the coordinator's authoritative state
 * snapshot for `targetInput`; the retained prepared invocation must carry the
 * exact occurrence coordinates derived by {@link BpmnKernel.taskOccurrence}.
 *
 * The returned command is not applied automatically: its optimistic token
 * coordinates must still be checked by {@link BpmnKernel.resolveTask} in the
 * caller's durable state transaction.
 *
 * The native retry loop runs exactly once. Business terminal failures are
 * preserved as values long enough to become `BusinessFailed`; attempt and
 * schedule-to-close timeouts remain typed operational failures. Defects and
 * interruption retain their native cause.
 *
 * @category execution
 * @since 4.0.0
 */
export const executeTask = (
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  invocation: EffectWorkflowRetryV3.PreparedRetryInvocation,
  targetInput: unknown,
  options: EffectWorkflowRetryV3.ExecutionOptions
): Effect.Effect<
  ExecutedTaskResolution,
  | EffectWorkflowBpmnError
  | EffectWorkflowRetryV3.AttemptTimedOut
  | EffectWorkflowRetryV3.ScheduleToCloseTimedOut
  | EffectWorkflowRetryV3.EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> =>
  Effect.gen(function*() {
    const target = yield* Effect.fromResult(captureTarget(targetInput))
    const binding = yield* Effect.fromResult(
      lookupBinding(kernel, target)
    )
    if (!EffectWorkflowRetryV3.isPrepared(invocation)) {
      return yield* Effect.fail(bridgeError(
        ErrorCodes.InvalidInvocation,
        "BPMN Task execution requires an exact prepared retry invocation",
        target
      ))
    }
    const occurrence = yield* Effect.fromResult(
      EffectWorkflowRetryV3.preparedOccurrence(invocation)
    )
    const preparedInput = yield* Effect.fromResult(
      EffectWorkflowRetryV3.preparedInput(invocation)
    )
    const expectedOccurrence = yield* Effect.fromResult(
      lookupOccurrence(kernel, stateInput, target)
    )
    const expectedCollectionItem = yield* Effect.fromResult(
      lookupCollectionItem(
        kernel,
        stateInput,
        target
      )
    )
    if (
      binding.artifactDigest !== invocation.artifactDigest ||
      binding.semanticNodeId !== invocation.nodeId
    ) {
      return yield* Effect.fail(bridgeError(
        ErrorCodes.InvocationBindingMismatch,
        `Prepared retry invocation does not match BPMN Task binding '${target.taskNodeId}'`,
        target
      ))
    }
    if (
      occurrence.document.artifactDigest !== invocation.artifactDigest ||
      occurrence.document.nodeId !== invocation.nodeId ||
      !sameOccurrenceCoordinates(
        expectedOccurrence,
        invocation,
        occurrence
      )
    ) {
      return yield* Effect.fail(bridgeError(
        ErrorCodes.InvocationOccurrenceMismatch,
        `Prepared retry invocation does not match replay-derived BPMN Task occurrence '${target.tokenId}'`,
        target
      ))
    }
    if (
      expectedCollectionItem !== undefined &&
      !sameJson(
        preparedInput.value,
        expectedCollectionItem.item
      )
    ) {
      return yield* Effect.fail(bridgeError(
        ErrorCodes.InvocationInputMismatch,
        `Prepared retry invocation input does not match frozen collection item '${expectedCollectionItem.itemKey}'`,
        target
      ))
    }
    const outcome = yield* EffectWorkflowRetryV3.executeDetailed(
      invocation,
      options
    )
    if (
      outcome._tag === "AttemptTimedOut" ||
      outcome._tag === "ScheduleToCloseTimedOut"
    ) {
      return yield* Effect.fail(outcome)
    }
    return yield* Effect.fromResult(
      resolutionReceipt(invocation, target, outcome)
    )
  })
