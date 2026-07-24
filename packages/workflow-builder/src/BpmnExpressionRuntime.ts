/**
 * Effect-native execution of the pure BPMN token kernel.
 *
 * **Details**
 *
 * The token kernel remains synchronous and atomic. This driver captures the
 * first expression that has no operation-local decision, resolves its exact
 * evaluator binding, evaluates it under the binding timeout, and reruns the
 * same immutable kernel operation. No intermediate transition batch is
 * exposed.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnExpressionEvaluator from "./BpmnExpressionEvaluator.ts"
import * as BpmnKernel from "./BpmnKernel.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Operation = Schema.Literals([
  "initialize",
  "advance",
  "completeTask",
  "resolveTask"
])

/**
 * Stable machine-readable expression-runtime error codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidEvaluatorRegistry: "InvalidEvaluatorRegistry",
  EvaluatorResolutionFailed: "EvaluatorResolutionFailed",
  EvaluatorFailed: "EvaluatorFailed",
  EvaluatorDefect: "EvaluatorDefect",
  EvaluationTimedOut: "EvaluationTimedOut",
  InvalidEvaluationResult: "InvalidEvaluationResult",
  EvaluationStepLimitExceeded: "EvaluationStepLimitExceeded",
  DecisionIdentityMismatch: "DecisionIdentityMismatch",
  DecisionIdentityUnavailable: "DecisionIdentityUnavailable"
} as const

/**
 * A stable machine-readable expression-runtime error code.
 *
 * @category models
 * @since 4.0.0
 */
export type Code = typeof Codes[keyof typeof Codes]

const Code = Schema.Literals([
  Codes.InvalidEvaluatorRegistry,
  Codes.EvaluatorResolutionFailed,
  Codes.EvaluatorFailed,
  Codes.EvaluatorDefect,
  Codes.EvaluationTimedOut,
  Codes.InvalidEvaluationResult,
  Codes.EvaluationStepLimitExceeded,
  Codes.DecisionIdentityMismatch,
  Codes.DecisionIdentityUnavailable
])

const RuntimeErrorFields = Schema.Struct({
  operation: Operation,
  code: Code,
  ordinal: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  sequenceFlowId: Schema.optionalKey(Schema.NonEmptyString),
  loopActivityId: Schema.optionalKey(Schema.NonEmptyString),
  loopFrameId: Schema.optionalKey(Schema.NonEmptyString),
  loopActivation: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  loopPhase: Schema.optionalKey(Schema.Literals(["before", "after"])),
  loopIteration: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceActivityId: Schema.optionalKey(Schema.NonEmptyString),
  multiInstanceGroupId: Schema.optionalKey(Schema.NonEmptyString),
  multiInstanceGroupActivation: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceCompletedItemIndex: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceCompletedItemKey: Schema.optionalKey(Schema.NonEmptyString),
  multiInstanceLoopCounter: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceNumberOfInstances: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceNumberOfActiveInstances: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceNumberOfCompletedInstances: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  multiInstanceNumberOfTerminatedInstances: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt)
}).check(
  Schema.makeFilter((fields) => {
    const loopCoordinates = [
      fields.loopActivityId,
      fields.loopFrameId,
      fields.loopActivation,
      fields.loopPhase,
      fields.loopIteration
    ]
    const loopCoordinateCount = loopCoordinates.filter(
      (coordinate) => coordinate !== undefined
    ).length
    const multiInstanceBaseCoordinates = [
      fields.multiInstanceActivityId,
      fields.multiInstanceGroupId,
      fields.multiInstanceGroupActivation
    ]
    const multiInstanceCompletionCoordinates = [
      fields.multiInstanceCompletedItemIndex,
      fields.multiInstanceCompletedItemKey,
      fields.multiInstanceLoopCounter,
      fields.multiInstanceNumberOfInstances,
      fields.multiInstanceNumberOfActiveInstances,
      fields.multiInstanceNumberOfCompletedInstances,
      fields.multiInstanceNumberOfTerminatedInstances
    ]
    const multiInstanceBaseCount = multiInstanceBaseCoordinates.filter(
      (coordinate) => coordinate !== undefined
    ).length
    const multiInstanceCompletionCount = multiInstanceCompletionCoordinates.filter(
      (coordinate) => coordinate !== undefined
    ).length
    const hasSequenceFlow = fields.sequenceFlowId !== undefined
    const decisionKinds = Number(hasSequenceFlow) +
      Number(loopCoordinateCount > 0) +
      Number(multiInstanceBaseCount > 0 || multiInstanceCompletionCount > 0)
    if (decisionKinds > 1) {
      return false
    }
    if (hasSequenceFlow) {
      return true
    }
    if (loopCoordinateCount > 0) {
      return loopCoordinateCount === loopCoordinates.length
    }
    if (multiInstanceBaseCount > 0 || multiInstanceCompletionCount > 0) {
      return multiInstanceBaseCount === multiInstanceBaseCoordinates.length &&
        (
          multiInstanceCompletionCount === 0 ||
          multiInstanceCompletionCount === multiInstanceCompletionCoordinates.length
        )
    }
    return true
  }, {
    expected:
      "no decision coordinates, one sequenceFlowId, one complete standard-loop tuple, one complete multi-instance cardinality tuple, or one complete multi-instance completion tuple"
  })
)

/**
 * Stable failure produced while driving an effectful BPMN expression.
 *
 * **Details**
 *
 * Evaluator errors and defects are deliberately not embedded. The portable
 * code and deterministic BPMN coordinates are sufficient for classification
 * without leaking an evaluator's unknown failure values.
 *
 * @category errors
 * @since 4.0.0
 */
export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>(
  "@effect/workflow-builder/BpmnExpressionRuntime/RuntimeError"
)(
  "BpmnExpressionRuntimeError",
  RuntimeErrorFields,
  { parseOptions: strictParseOptions }
) {}

/**
 * Machine-readable guarantees enforced by this runtime boundary.
 *
 * @category constants
 * @since 4.0.0
 */
export const Requirements = Object.freeze(
  {
    evaluatorRegistry: "trusted-exact-registry",
    evaluatorBindingResolution: "complete-tuple",
    operationReplay: "same-input-and-time",
    decisionIdentityVersion: 2,
    evaluatorTimeout: "binding-timeout-millis",
    evaluatorOutput: "strict-json-result",
    commitVisibility: "final-batch-only"
  } as const
)

/**
 * Effect environment required by expression-runtime operations.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements = BpmnExpressionEvaluator.EvaluatorRegistry

type Operation = RuntimeError["operation"]

interface CachedDecision {
  readonly identity: string
  readonly result: BpmnExpressionEvaluator.EvaluationResult
}

type DecisionCoordinates =
  | {
    readonly _tag: "SequenceFlowCondition"
    readonly sourceNodeId: string
    readonly sequenceFlowId: string
  }
  | {
    readonly _tag: "StandardLoopCondition"
    readonly loopActivityId: string
    readonly loopFrameId: string
    readonly loopActivation: number
    readonly loopPhase: "before" | "after"
    readonly loopIteration: number
  }
  | {
    readonly _tag: "MultiInstanceCardinality"
    readonly activityId: string
    readonly groupId: string
    readonly groupActivation: number
  }
  | {
    readonly _tag: "MultiInstanceCompletionCondition"
    readonly activityId: string
    readonly groupId: string
    readonly groupActivation: number
    readonly completedItemIndex: number
    readonly completedItemKey: string
    readonly loopCounter: number
    readonly numberOfInstances: number
    readonly numberOfActiveInstances: number
    readonly numberOfCompletedInstances: number
    readonly numberOfTerminatedInstances: number
  }

interface PendingEvaluation {
  readonly context: BpmnKernel.EvaluationContext
  readonly coordinates: DecisionCoordinates
  readonly identity: string
  readonly ordinal: number
}

type KernelOperation = (
  evaluateExpression: NonNullable<BpmnKernel.Services["evaluateExpression"]>
) => Result.Result<BpmnKernel.TransitionBatch, Diagnostic.CompilationError>

const decodeEvaluationResult = Schema.decodeUnknownResult(
  BpmnExpressionEvaluator.EvaluationResult,
  strictParseOptions
)

const runtimeError = (
  operation: Operation,
  code: Code,
  ordinal?: number,
  coordinates?: DecisionCoordinates
): RuntimeError =>
  new RuntimeError({
    operation,
    code,
    ...(ordinal === undefined ? undefined : { ordinal }),
    ...(coordinates === undefined
      ? undefined
      : coordinates._tag === "SequenceFlowCondition"
      ? { sequenceFlowId: coordinates.sequenceFlowId }
      : coordinates._tag === "StandardLoopCondition"
      ? {
        loopActivityId: coordinates.loopActivityId,
        loopFrameId: coordinates.loopFrameId,
        loopActivation: coordinates.loopActivation,
        loopPhase: coordinates.loopPhase,
        loopIteration: coordinates.loopIteration
      }
      : coordinates._tag === "MultiInstanceCardinality"
      ? {
        multiInstanceActivityId: coordinates.activityId,
        multiInstanceGroupId: coordinates.groupId,
        multiInstanceGroupActivation: coordinates.groupActivation
      }
      : {
        multiInstanceActivityId: coordinates.activityId,
        multiInstanceGroupId: coordinates.groupId,
        multiInstanceGroupActivation: coordinates.groupActivation,
        multiInstanceCompletedItemIndex: coordinates.completedItemIndex,
        multiInstanceCompletedItemKey: coordinates.completedItemKey,
        multiInstanceLoopCounter: coordinates.loopCounter,
        multiInstanceNumberOfInstances: coordinates.numberOfInstances,
        multiInstanceNumberOfActiveInstances: coordinates.numberOfActiveInstances,
        multiInstanceNumberOfCompletedInstances: coordinates.numberOfCompletedInstances,
        multiInstanceNumberOfTerminatedInstances: coordinates.numberOfTerminatedInstances
      })
  })

const decisionCoordinates = (
  context: BpmnKernel.EvaluationContext
): DecisionCoordinates => {
  switch (context._tag) {
    case "SequenceFlowCondition":
      return {
        _tag: context._tag,
        sourceNodeId: context.sourceNode.id,
        sequenceFlowId: context.sequenceFlow.id
      }
    case "StandardLoopCondition":
      return {
        _tag: context._tag,
        loopActivityId: context.activity.id,
        loopFrameId: context.loopFrame.frameId,
        loopActivation: context.loopFrame.activation,
        loopPhase: context.phase,
        loopIteration: context.iteration
      }
    case "MultiInstanceCardinality":
      return {
        _tag: context._tag,
        activityId: context.activity.id,
        groupId: context.groupId,
        groupActivation: context.groupActivation
      }
    case "MultiInstanceCompletionCondition":
      return {
        _tag: context._tag,
        activityId: context.activity.id,
        groupId: context.multiInstanceGroup.groupId,
        groupActivation: context.multiInstanceGroup.activation,
        completedItemIndex: context.completedMember.index,
        completedItemKey: context.completedMember.itemKey,
        loopCounter: context.runtime.loopCounter,
        numberOfInstances: context.runtime.numberOfInstances,
        numberOfActiveInstances: context.runtime.numberOfActiveInstances,
        numberOfCompletedInstances: context.runtime.numberOfCompletedInstances,
        numberOfTerminatedInstances: context.runtime.numberOfTerminatedInstances
      }
  }
}

const evaluationFailure = (
  coordinates: DecisionCoordinates
): Diagnostic.CompilationError => {
  const details: Schema.Json = coordinates._tag === "SequenceFlowCondition"
    ? { sequenceFlowId: coordinates.sequenceFlowId }
    : coordinates._tag === "StandardLoopCondition"
    ? {
      loopActivityId: coordinates.loopActivityId,
      loopFrameId: coordinates.loopFrameId,
      loopActivation: coordinates.loopActivation,
      loopPhase: coordinates.loopPhase,
      loopIteration: coordinates.loopIteration
    }
    : coordinates._tag === "MultiInstanceCardinality"
    ? {
      multiInstanceActivityId: coordinates.activityId,
      multiInstanceGroupId: coordinates.groupId,
      multiInstanceGroupActivation: coordinates.groupActivation
    }
    : {
      multiInstanceActivityId: coordinates.activityId,
      multiInstanceGroupId: coordinates.groupId,
      multiInstanceGroupActivation: coordinates.groupActivation,
      multiInstanceCompletedItemIndex: coordinates.completedItemIndex,
      multiInstanceCompletedItemKey: coordinates.completedItemKey,
      multiInstanceLoopCounter: coordinates.loopCounter,
      multiInstanceNumberOfInstances: coordinates.numberOfInstances,
      multiInstanceNumberOfActiveInstances: coordinates.numberOfActiveInstances,
      multiInstanceNumberOfCompletedInstances: coordinates.numberOfCompletedInstances,
      multiInstanceNumberOfTerminatedInstances: coordinates.numberOfTerminatedInstances
    }
  const message = coordinates._tag === "SequenceFlowCondition"
    ? `Effectful evaluation is required for sequence flow '${coordinates.sequenceFlowId}'`
    : coordinates._tag === "StandardLoopCondition"
    ? `Effectful evaluation is required for standard loop on activity '${coordinates.loopActivityId}'`
    : coordinates._tag === "MultiInstanceCardinality"
    ? `Effectful evaluation is required for multi-instance cardinality on activity '${coordinates.activityId}'`
    : `Effectful evaluation is required for multi-instance completion condition on activity '${coordinates.activityId}'`
  return new Diagnostic.CompilationError({
    diagnostics: [
      Diagnostic.error(
        BpmnKernel.Codes.EvaluationRequired,
        message,
        coordinates._tag === "SequenceFlowCondition"
          ? ["sequenceFlows"]
          : ["flowNodes"],
        details
      )
    ]
  })
}

const decisionIdentity = (
  operation: Operation,
  kernel: BpmnKernel.CompiledKernel,
  context: BpmnKernel.EvaluationContext,
  coordinates: DecisionCoordinates,
  ordinal: number
): Result.Result<string, RuntimeError> => {
  const snapshot = Json.snapshot({
    decisionIdentityVersion: Requirements.decisionIdentityVersion,
    ordinal,
    executableFingerprint: kernel.modelReference.executableFingerprint,
    scope: {
      scopeInstanceId: context.scopeInstance.scopeInstanceId,
      definitionId: context.scopeInstance.definitionId,
      processId: context.scopeInstance.processId,
      invocation: context.scopeInstance.invocation
    },
    decision: coordinates,
    expression: context.expression,
    evaluatorBinding: context.evaluatorBinding,
    request: context.request
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(runtimeError(
      operation,
      Codes.DecisionIdentityUnavailable,
      ordinal,
      coordinates
    ))
  }
  try {
    return Result.succeed(Json.canonicalizeSnapshot(snapshot.success))
  } catch {
    return Result.fail(runtimeError(
      operation,
      Codes.DecisionIdentityUnavailable,
      ordinal,
      coordinates
    ))
  }
}

const evaluate = (
  operation: Operation,
  registry: BpmnExpressionEvaluator.EvaluatorRegistry.Service,
  pending: PendingEvaluation
): Effect.Effect<
  BpmnExpressionEvaluator.EvaluationResult,
  RuntimeError
> =>
  Effect.gen(function*() {
    const definition = yield* registry.resolve(
      pending.context.evaluatorBinding
    ).pipe(
      Effect.mapError(() =>
        runtimeError(
          operation,
          Codes.EvaluatorResolutionFailed,
          pending.ordinal,
          pending.coordinates
        )
      )
    )

    const outcome = yield* Effect.suspend(() => definition.evaluate(pending.context.request)).pipe(
      Effect.mapError(() =>
        runtimeError(
          operation,
          Codes.EvaluatorFailed,
          pending.ordinal,
          pending.coordinates
        )
      ),
      Effect.timeoutOrElse({
        duration: pending.context.evaluatorBinding.limits.timeoutMillis,
        orElse: () =>
          Effect.fail(runtimeError(
            operation,
            Codes.EvaluationTimedOut,
            pending.ordinal,
            pending.coordinates
          ))
      }),
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterrupts(cause)) {
            return Effect.failCause(cause)
          }
          const typed = Cause.findError(cause)
          if (Result.isSuccess(typed)) {
            return Effect.fail(typed.success)
          }
          return Effect.fail(runtimeError(
            operation,
            Codes.EvaluatorDefect,
            pending.ordinal,
            pending.coordinates
          ))
        },
        onSuccess: Effect.succeed
      })
    )

    const snapshot = Json.snapshot(outcome)
    if (Result.isFailure(snapshot)) {
      return yield* Effect.fail(runtimeError(
        operation,
        Codes.InvalidEvaluationResult,
        pending.ordinal,
        pending.coordinates
      ))
    }
    const decoded = decodeEvaluationResult(snapshot.success)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(runtimeError(
        operation,
        Codes.InvalidEvaluationResult,
        pending.ordinal,
        pending.coordinates
      ))
    }
    const result = decoded.success
    if (result.steps > pending.context.evaluatorBinding.limits.maxSteps) {
      return yield* Effect.fail(runtimeError(
        operation,
        Codes.EvaluationStepLimitExceeded,
        pending.ordinal,
        pending.coordinates
      ))
    }
    return Object.freeze({ ...result })
  })

const drive = (
  operation: Operation,
  kernel: BpmnKernel.CompiledKernel,
  run: KernelOperation
): Effect.Effect<
  BpmnKernel.TransitionBatch,
  Diagnostic.CompilationError | RuntimeError,
  BpmnExpressionEvaluator.EvaluatorRegistry
> =>
  Effect.gen(function*() {
    const registry = yield* BpmnExpressionEvaluator.EvaluatorRegistry
    if (!BpmnExpressionEvaluator.isEvaluatorRegistry(registry)) {
      return yield* Effect.fail(runtimeError(
        operation,
        Codes.InvalidEvaluatorRegistry
      ))
    }

    const decisions: Array<CachedDecision> = []
    while (true) {
      let ordinal = 0
      let pending: PendingEvaluation | undefined
      let callbackFailure: RuntimeError | undefined

      const evaluateExpression: NonNullable<
        BpmnKernel.Services["evaluateExpression"]
      > = (context) => {
        const currentOrdinal = ordinal++
        const coordinates = decisionCoordinates(context)
        const identity = decisionIdentity(
          operation,
          kernel,
          context,
          coordinates,
          currentOrdinal
        )
        if (Result.isFailure(identity)) {
          callbackFailure = identity.failure
          return Result.fail(evaluationFailure(coordinates))
        }
        const cached = decisions[currentOrdinal]
        if (cached !== undefined) {
          if (cached.identity !== identity.success) {
            callbackFailure = runtimeError(
              operation,
              Codes.DecisionIdentityMismatch,
              currentOrdinal,
              coordinates
            )
            return Result.fail(evaluationFailure(coordinates))
          }
          return Result.succeed(cached.result)
        }
        pending = {
          context,
          coordinates,
          identity: identity.success,
          ordinal: currentOrdinal
        }
        return Result.fail(evaluationFailure(coordinates))
      }

      const batch = run(evaluateExpression)
      if (callbackFailure !== undefined) {
        return yield* Effect.fail(callbackFailure)
      }
      if (Result.isSuccess(batch)) {
        return batch.success
      }
      if (pending === undefined) {
        return yield* Effect.fail(batch.failure)
      }
      const requested = pending as PendingEvaluation
      const result = yield* evaluate(operation, registry, requested)
      decisions.push(Object.freeze({
        identity: requested.identity,
        result
      }))
    }
  })

const captureNow = (
  input: BpmnKernel.Services
): BpmnKernel.Services["now"] => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "now")
    return descriptor !== undefined && !("get" in descriptor)
      ? descriptor.value as BpmnKernel.Services["now"]
      : undefined as unknown as BpmnKernel.Services["now"]
  } catch {
    return undefined as unknown as BpmnKernel.Services["now"]
  }
}

const runtimeServices = (
  now: BpmnKernel.Services["now"],
  evaluateExpression: NonNullable<BpmnKernel.Services["evaluateExpression"]>
): BpmnKernel.Services => ({ now, evaluateExpression })

const snapshotInput = (input: unknown): unknown => {
  const snapshot = Json.snapshot(input)
  return Result.isSuccess(snapshot) ? snapshot.success : input
}

/**
 * Initializes a BPMN execution with exact Effect-native expression evaluation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const initialize = (
  kernel: BpmnKernel.CompiledKernel,
  services: BpmnKernel.Services
): Effect.Effect<
  BpmnKernel.TransitionBatch,
  Diagnostic.CompilationError | RuntimeError,
  BpmnExpressionEvaluator.EvaluatorRegistry
> =>
  Effect.suspend(() => {
    const now = captureNow(services)
    return drive(
      "initialize",
      kernel,
      (evaluateExpression) =>
        BpmnKernel.initialize(
          kernel,
          runtimeServices(now, evaluateExpression)
        )
    )
  })

/**
 * Advances BPMN state with exact Effect-native expression evaluation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const advance = (
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  services: BpmnKernel.Services
): Effect.Effect<
  BpmnKernel.TransitionBatch,
  Diagnostic.CompilationError | RuntimeError,
  BpmnExpressionEvaluator.EvaluatorRegistry
> =>
  Effect.suspend(() => {
    const now = captureNow(services)
    const state = snapshotInput(stateInput)
    return drive(
      "advance",
      kernel,
      (evaluateExpression) =>
        BpmnKernel.advance(
          kernel,
          state,
          runtimeServices(now, evaluateExpression)
        )
    )
  })

/**
 * Completes a BPMN task with exact Effect-native expression evaluation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const completeTask = (
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  commandInput: unknown,
  services: BpmnKernel.Services
): Effect.Effect<
  BpmnKernel.TransitionBatch,
  Diagnostic.CompilationError | RuntimeError,
  BpmnExpressionEvaluator.EvaluatorRegistry
> =>
  Effect.suspend(() => {
    const now = captureNow(services)
    const state = snapshotInput(stateInput)
    const command = snapshotInput(commandInput)
    return drive(
      "completeTask",
      kernel,
      (evaluateExpression) =>
        BpmnKernel.completeTask(
          kernel,
          state,
          command,
          runtimeServices(now, evaluateExpression)
        )
    )
  })

/**
 * Resolves a protocol-v3 BPMN task outcome with exact Effect-native condition
 * evaluation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const resolveTask = (
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  commandInput: unknown,
  services: BpmnKernel.Services
): Effect.Effect<
  BpmnKernel.TransitionBatch,
  Diagnostic.CompilationError | RuntimeError,
  BpmnExpressionEvaluator.EvaluatorRegistry
> =>
  Effect.suspend(() => {
    const now = captureNow(services)
    const state = snapshotInput(stateInput)
    const command = snapshotInput(commandInput)
    return drive(
      "resolveTask",
      kernel,
      (evaluateExpression) =>
        BpmnKernel.resolveTask(
          kernel,
          state,
          command,
          runtimeServices(now, evaluateExpression)
        )
    )
  })
