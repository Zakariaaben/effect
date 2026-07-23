/**
 * Effect-native execution of the pure BPMN token kernel.
 *
 * **Details**
 *
 * The token kernel remains synchronous and atomic. This driver captures the
 * first condition that has no operation-local decision, resolves its exact
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
  "completeTask"
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
)("BpmnExpressionRuntimeError", {
  operation: Operation,
  code: Code,
  ordinal: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  sequenceFlowId: Schema.optionalKey(Schema.NonEmptyString)
}, { parseOptions: strictParseOptions }) {}

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
    decisionIdentityVersion: 1,
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

interface PendingEvaluation {
  readonly context: BpmnKernel.EvaluationContext
  readonly identity: string
  readonly ordinal: number
}

type KernelOperation = (
  evaluateCondition: NonNullable<BpmnKernel.Services["evaluateCondition"]>
) => Result.Result<BpmnKernel.TransitionBatch, Diagnostic.CompilationError>

const decodeEvaluationResult = Schema.decodeUnknownResult(
  BpmnExpressionEvaluator.EvaluationResult,
  strictParseOptions
)

const runtimeError = (
  operation: Operation,
  code: Code,
  ordinal?: number,
  sequenceFlowId?: string
): RuntimeError =>
  new RuntimeError({
    operation,
    code,
    ...(ordinal === undefined ? undefined : { ordinal }),
    ...(sequenceFlowId === undefined ? undefined : { sequenceFlowId })
  })

const evaluationFailure = (
  sequenceFlowId: string
): Diagnostic.CompilationError =>
  new Diagnostic.CompilationError({
    diagnostics: [
      Diagnostic.error(
        BpmnKernel.Codes.EvaluationRequired,
        `Effectful evaluation is required for sequence flow '${sequenceFlowId}'`,
        ["sequenceFlows"],
        { sequenceFlowId }
      )
    ]
  })

const decisionIdentity = (
  operation: Operation,
  kernel: BpmnKernel.CompiledKernel,
  context: BpmnKernel.EvaluationContext,
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
    sourceNodeId: context.sourceNode.id,
    sequenceFlowId: context.sequenceFlow.id,
    expression: context.expression,
    evaluatorBinding: context.evaluatorBinding,
    request: context.request
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(runtimeError(
      operation,
      Codes.DecisionIdentityUnavailable,
      ordinal,
      context.sequenceFlow.id
    ))
  }
  try {
    return Result.succeed(Json.canonicalizeSnapshot(snapshot.success))
  } catch {
    return Result.fail(runtimeError(
      operation,
      Codes.DecisionIdentityUnavailable,
      ordinal,
      context.sequenceFlow.id
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
          pending.context.sequenceFlow.id
        )
      )
    )

    const outcome = yield* Effect.suspend(() => definition.evaluate(pending.context.request)).pipe(
      Effect.mapError(() =>
        runtimeError(
          operation,
          Codes.EvaluatorFailed,
          pending.ordinal,
          pending.context.sequenceFlow.id
        )
      ),
      Effect.timeoutOrElse({
        duration: pending.context.evaluatorBinding.limits.timeoutMillis,
        orElse: () =>
          Effect.fail(runtimeError(
            operation,
            Codes.EvaluationTimedOut,
            pending.ordinal,
            pending.context.sequenceFlow.id
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
            pending.context.sequenceFlow.id
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
        pending.context.sequenceFlow.id
      ))
    }
    const decoded = decodeEvaluationResult(snapshot.success)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(runtimeError(
        operation,
        Codes.InvalidEvaluationResult,
        pending.ordinal,
        pending.context.sequenceFlow.id
      ))
    }
    const result = decoded.success
    if (result.steps > pending.context.evaluatorBinding.limits.maxSteps) {
      return yield* Effect.fail(runtimeError(
        operation,
        Codes.EvaluationStepLimitExceeded,
        pending.ordinal,
        pending.context.sequenceFlow.id
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

      const evaluateCondition: NonNullable<
        BpmnKernel.Services["evaluateCondition"]
      > = (context) => {
        const currentOrdinal = ordinal++
        const identity = decisionIdentity(
          operation,
          kernel,
          context,
          currentOrdinal
        )
        if (Result.isFailure(identity)) {
          callbackFailure = runtimeError(
            operation,
            identity.failure.code,
            currentOrdinal,
            context.sequenceFlow.id
          )
          return Result.fail(evaluationFailure(context.sequenceFlow.id))
        }
        const cached = decisions[currentOrdinal]
        if (cached !== undefined) {
          if (cached.identity !== identity.success) {
            callbackFailure = runtimeError(
              operation,
              Codes.DecisionIdentityMismatch,
              currentOrdinal,
              context.sequenceFlow.id
            )
            return Result.fail(evaluationFailure(context.sequenceFlow.id))
          }
          return Result.succeed(cached.result)
        }
        pending = {
          context,
          identity: identity.success,
          ordinal: currentOrdinal
        }
        return Result.fail(evaluationFailure(context.sequenceFlow.id))
      }

      const batch = run(evaluateCondition)
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
  evaluateCondition: NonNullable<BpmnKernel.Services["evaluateCondition"]>
): BpmnKernel.Services => ({ now, evaluateCondition })

const snapshotInput = (input: unknown): unknown => {
  const snapshot = Json.snapshot(input)
  return Result.isSuccess(snapshot) ? snapshot.success : input
}

/**
 * Initializes a BPMN execution with exact Effect-native condition evaluation.
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
      (evaluateCondition) =>
        BpmnKernel.initialize(
          kernel,
          runtimeServices(now, evaluateCondition)
        )
    )
  })

/**
 * Advances BPMN state with exact Effect-native condition evaluation.
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
      (evaluateCondition) =>
        BpmnKernel.advance(
          kernel,
          state,
          runtimeServices(now, evaluateCondition)
        )
    )
  })

/**
 * Completes a BPMN task with exact Effect-native condition evaluation.
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
      (evaluateCondition) =>
        BpmnKernel.completeTask(
          kernel,
          state,
          command,
          runtimeServices(now, evaluateCondition)
        )
    )
  })
