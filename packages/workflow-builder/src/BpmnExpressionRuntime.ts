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
  loopIteration: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt)
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
    return fields.sequenceFlowId === undefined
      ? loopCoordinateCount === 0 || loopCoordinateCount === loopCoordinates.length
      : loopCoordinateCount === 0
  }, {
    expected: "no decision coordinates, one sequenceFlowId, or one complete standard-loop coordinate tuple"
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

interface PendingEvaluation {
  readonly context: BpmnKernel.EvaluationContext
  readonly coordinates: DecisionCoordinates
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
      : {
        loopActivityId: coordinates.loopActivityId,
        loopFrameId: coordinates.loopFrameId,
        loopActivation: coordinates.loopActivation,
        loopPhase: coordinates.loopPhase,
        loopIteration: coordinates.loopIteration
      })
  })

const decisionCoordinates = (
  context: BpmnKernel.EvaluationContext
): DecisionCoordinates =>
  context._tag === "SequenceFlowCondition"
    ? {
      _tag: context._tag,
      sourceNodeId: context.sourceNode.id,
      sequenceFlowId: context.sequenceFlow.id
    }
    : {
      _tag: context._tag,
      loopActivityId: context.activity.id,
      loopFrameId: context.loopFrame.frameId,
      loopActivation: context.loopFrame.activation,
      loopPhase: context.phase,
      loopIteration: context.iteration
    }

const evaluationFailure = (
  coordinates: DecisionCoordinates
): Diagnostic.CompilationError => {
  const isSequenceFlow = coordinates._tag === "SequenceFlowCondition"
  const details: Schema.Json = isSequenceFlow
    ? { sequenceFlowId: coordinates.sequenceFlowId }
    : {
      loopActivityId: coordinates.loopActivityId,
      loopFrameId: coordinates.loopFrameId,
      loopActivation: coordinates.loopActivation,
      loopPhase: coordinates.loopPhase,
      loopIteration: coordinates.loopIteration
    }
  return new Diagnostic.CompilationError({
    diagnostics: [
      Diagnostic.error(
        BpmnKernel.Codes.EvaluationRequired,
        isSequenceFlow
          ? `Effectful evaluation is required for sequence flow '${coordinates.sequenceFlowId}'`
          : `Effectful evaluation is required for standard loop on activity '${coordinates.loopActivityId}'`,
        isSequenceFlow ? ["sequenceFlows"] : ["flowNodes"],
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
  const target = coordinates._tag === "SequenceFlowCondition"
    ? {
      sourceNodeId: coordinates.sourceNodeId,
      sequenceFlowId: coordinates.sequenceFlowId
    }
    : {
      loopActivityId: coordinates.loopActivityId,
      loopFrameId: coordinates.loopFrameId,
      loopActivation: coordinates.loopActivation,
      loopPhase: coordinates.loopPhase,
      loopIteration: coordinates.loopIteration
    }
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
    ...target,
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

      const evaluateCondition: NonNullable<
        BpmnKernel.Services["evaluateCondition"]
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
      (evaluateCondition) =>
        BpmnKernel.resolveTask(
          kernel,
          state,
          command,
          runtimeServices(now, evaluateCondition)
        )
    )
  })
