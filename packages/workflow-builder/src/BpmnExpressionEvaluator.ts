/**
 * Exact process-local implementations of portable BPMN evaluator bindings.
 *
 * **Details**
 *
 * Definitions and registries are provenance-guarded process-local values.
 * Resolution uses the entire portable binding tuple and performs no language,
 * version, deployment, digest, or limit fallback.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnExpression from "./BpmnExpression.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const definitions = new WeakSet<object>()
const registries = new WeakSet<object>()

const decodeBinding = Schema.decodeUnknownResult(
  BpmnExpression.EvaluatorBinding,
  strictParseOptions
)

/**
 * Semantic result shape requested by the BPMN execution authority.
 *
 * **Details**
 *
 * This is an evaluator dispatch contract, not a coercion instruction. An
 * evaluator returns the exact JSON value it computed. The consuming kernel
 * validates that value against this expectation and applies domain-specific
 * bounds such as the configured maximum multi-instance cardinality.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExpectedResult = Schema.Literals([
  "boolean",
  "string",
  "non-negative-integer",
  "json-array",
  "json"
]).annotate({
  identifier: "WorkflowBpmnExpectedEvaluationResult"
})

/**
 * The decoded type of {@link ExpectedResult}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExpectedResult = Schema.Schema.Type<typeof ExpectedResult>

/**
 * Strict JSON input supplied to one evaluator invocation.
 *
 * **Details**
 *
 * `expectedResult` makes the consumer's semantic expectation explicit. The
 * evaluator registry neither converts nor coerces results.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EvaluationRequest = Schema.Struct({
  source: Schema.String,
  context: Schema.Json,
  expectedResult: ExpectedResult
}).annotate({
  identifier: "WorkflowBpmnEvaluationRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EvaluationRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluationRequest = Schema.Schema.Type<typeof EvaluationRequest>

/**
 * Exact successful output returned by an evaluator.
 *
 * **Details**
 *
 * The result remains an exact JSON value so the same evaluator infrastructure
 * can serve conditions, cardinalities, collections, and data mappings. The
 * consuming kernel checks the requested semantic type and its own bounds.
 * Registry implementations must not coerce evaluator output.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EvaluationResult = Schema.Struct({
  result: Schema.Json,
  steps: ProtocolV2Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowBpmnEvaluationResult",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EvaluationResult}.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluationResult = Schema.Schema.Type<typeof EvaluationResult>

/**
 * A service-closed implementation of one formal-expression evaluator.
 *
 * **Details**
 *
 * Applications that need Effect services construct the definition inside a
 * layer and close over the acquired service values. Registry resolution never
 * depends on ambient services.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluatorHandler<out Error = never> = (
  request: EvaluationRequest
) => Effect.Effect<EvaluationResult, Error, never>

/**
 * Application input used to construct one trusted evaluator definition.
 *
 * @category models
 * @since 4.0.0
 */
export interface EvaluatorDefinitionOptions<out Error = never> {
  readonly binding: BpmnExpression.EvaluatorBinding
  readonly evaluate: EvaluatorHandler<Error>
}

/**
 * One trusted process-local implementation under an exact portable binding.
 *
 * @category models
 * @since 4.0.0
 */
export interface EvaluatorDefinition<out Error = never> {
  readonly binding: BpmnExpression.EvaluatorBinding
  readonly evaluate: EvaluatorHandler<Error>
}

/**
 * A type-erased trusted evaluator definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type AnyEvaluatorDefinition = EvaluatorDefinition<unknown>

/**
 * Stable invalid-configuration reason codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const InvalidEvaluatorCodes = {
  InvalidOptions: "InvalidOptions",
  InvalidBinding: "InvalidBinding",
  InvalidDefinition: "InvalidDefinition",
  UnsafeInspection: "UnsafeInspection"
} as const

/**
 * Stable invalid-configuration reason code.
 *
 * @category models
 * @since 4.0.0
 */
export type InvalidEvaluatorCode = typeof InvalidEvaluatorCodes[keyof typeof InvalidEvaluatorCodes]

const InvalidEvaluatorCode = Schema.Literals([
  InvalidEvaluatorCodes.InvalidOptions,
  InvalidEvaluatorCodes.InvalidBinding,
  InvalidEvaluatorCodes.InvalidDefinition,
  InvalidEvaluatorCodes.UnsafeInspection
])

/**
 * Raised when evaluator definition, registry, or lookup input is malformed.
 *
 * **Details**
 *
 * The error intentionally excludes hostile input and evaluator functions.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidEvaluatorConfiguration extends Schema.TaggedErrorClass<
  InvalidEvaluatorConfiguration
>("@effect/workflow-builder/BpmnExpressionEvaluator/InvalidConfiguration")(
  "InvalidEvaluatorConfiguration",
  {
    operation: Schema.Literals(["define", "build", "resolve"]),
    code: InvalidEvaluatorCode,
    index: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when the complete requested binding has not been registered.
 *
 * **Details**
 *
 * No alternate deployment or compatible semantic version is selected.
 *
 * @category errors
 * @since 4.0.0
 */
export class EvaluatorNotFound extends Schema.TaggedErrorClass<EvaluatorNotFound>(
  "@effect/workflow-builder/BpmnExpressionEvaluator/EvaluatorNotFound"
)("EvaluatorNotFound", {
  binding: BpmnExpression.EvaluatorBinding
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when an exact binding is registered more than once.
 *
 * @category errors
 * @since 4.0.0
 */
export class DuplicateEvaluatorDefinition extends Schema.TaggedErrorClass<
  DuplicateEvaluatorDefinition
>("@effect/workflow-builder/BpmnExpressionEvaluator/DuplicateDefinition")(
  "DuplicateEvaluatorDefinition",
  {
    binding: BpmnExpression.EvaluatorBinding
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Failures produced while constructing a registry.
 *
 * @category errors
 * @since 4.0.0
 */
export type RegistryBuildError =
  | InvalidEvaluatorConfiguration
  | DuplicateEvaluatorDefinition

/**
 * Failures produced by exact evaluator resolution.
 *
 * @category errors
 * @since 4.0.0
 */
export type ResolutionError =
  | InvalidEvaluatorConfiguration
  | EvaluatorNotFound

/**
 * Exact evaluator lookup used by a BPMN execution authority.
 *
 * @category services
 * @since 4.0.0
 */
export class EvaluatorRegistry extends Context.Service<
  EvaluatorRegistry,
  EvaluatorRegistry.Service
>()("@effect/workflow-builder/BpmnExpressionEvaluator/Registry") {}

/**
 * Service contracts for {@link EvaluatorRegistry}.
 *
 * @since 4.0.0
 */
export declare namespace EvaluatorRegistry {
  /**
   * Exact evaluator registry service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly size: number
    readonly resolve: (
      binding: BpmnExpression.EvaluatorBinding
    ) => Effect.Effect<AnyEvaluatorDefinition, ResolutionError>
  }
}

const invalid = (
  operation: InvalidEvaluatorConfiguration["operation"],
  code: InvalidEvaluatorCode,
  index?: number
): InvalidEvaluatorConfiguration =>
  new InvalidEvaluatorConfiguration({
    operation,
    code,
    ...(index === undefined ? undefined : { index })
  })

const ownEnumerableData = (
  descriptors: { readonly [key: string]: PropertyDescriptor | undefined },
  key: string
): PropertyDescriptor | undefined => {
  const descriptor = descriptors[key]
  return descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, "value") &&
      descriptor.enumerable === true
    ? descriptor
    : undefined
}

const captureExactObject = (
  input: unknown,
  keys: ReadonlyArray<string>
): Result.Result<Readonly<Record<string, unknown>>, typeof InvalidEvaluatorCodes.UnsafeInspection> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(InvalidEvaluatorCodes.UnsafeInspection)
    }
    const prototype = Object.getPrototypeOf(input)
    const descriptors = Object.getOwnPropertyDescriptors(input)
    if (
      prototype !== Object.prototype && prototype !== null ||
      Reflect.ownKeys(descriptors).length !== keys.length
    ) {
      return Result.fail(InvalidEvaluatorCodes.UnsafeInspection)
    }
    const output: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      const descriptor = ownEnumerableData(descriptors, key)
      if (descriptor === undefined) {
        return Result.fail(InvalidEvaluatorCodes.UnsafeInspection)
      }
      output[key] = descriptor.value
    }
    return Result.succeed(output)
  } catch {
    return Result.fail(InvalidEvaluatorCodes.UnsafeInspection)
  }
}

const captureBinding = (
  input: unknown,
  operation: InvalidEvaluatorConfiguration["operation"]
): Result.Result<BpmnExpression.EvaluatorBinding, InvalidEvaluatorConfiguration> => {
  const outer = captureExactObject(input, [
    "language",
    "languageVersion",
    "build",
    "limits"
  ])
  if (Result.isFailure(outer)) {
    return Result.fail(invalid(operation, InvalidEvaluatorCodes.UnsafeInspection))
  }
  const build = captureExactObject(outer.success.build, [
    "id",
    "version",
    "deploymentId",
    "buildDigest"
  ])
  const limits = captureExactObject(outer.success.limits, [
    "maxSourceUtf8Bytes",
    "maxContextCanonicalBytes",
    "maxSteps",
    "timeoutMillis"
  ])
  if (Result.isFailure(build) || Result.isFailure(limits)) {
    return Result.fail(invalid(operation, InvalidEvaluatorCodes.UnsafeInspection))
  }
  const candidate = {
    language: outer.success.language,
    languageVersion: outer.success.languageVersion,
    build: {
      id: build.success.id,
      version: build.success.version,
      deploymentId: build.success.deploymentId,
      buildDigest: build.success.buildDigest
    },
    limits: {
      maxSourceUtf8Bytes: limits.success.maxSourceUtf8Bytes,
      maxContextCanonicalBytes: limits.success.maxContextCanonicalBytes,
      maxSteps: limits.success.maxSteps,
      timeoutMillis: limits.success.timeoutMillis
    }
  }
  let decoded: Result.Result<BpmnExpression.EvaluatorBinding, unknown>
  try {
    decoded = decodeBinding(candidate)
  } catch {
    return Result.fail(invalid(operation, InvalidEvaluatorCodes.UnsafeInspection))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(invalid(operation, InvalidEvaluatorCodes.InvalidBinding))
  }
  return Result.succeed(Object.freeze({
    language: decoded.success.language,
    languageVersion: decoded.success.languageVersion,
    build: Object.freeze({ ...decoded.success.build }),
    limits: Object.freeze({ ...decoded.success.limits })
  }))
}

const captureDefinitionOptions = (
  input: unknown
): Result.Result<{
  readonly binding: BpmnExpression.EvaluatorBinding
  readonly evaluate: EvaluatorHandler<unknown>
}, InvalidEvaluatorConfiguration> => {
  const outer = captureExactObject(input, ["binding", "evaluate"])
  if (Result.isFailure(outer)) {
    return Result.fail(invalid("define", InvalidEvaluatorCodes.InvalidOptions))
  }
  const binding = captureBinding(outer.success.binding, "define")
  if (Result.isFailure(binding)) {
    return Result.fail(binding.failure)
  }
  if (typeof outer.success.evaluate !== "function") {
    return Result.fail(invalid("define", InvalidEvaluatorCodes.InvalidDefinition))
  }
  return Result.succeed({
    binding: binding.success,
    evaluate: outer.success.evaluate as EvaluatorHandler<unknown>
  })
}

const buildDefinition = <Error>(
  options: EvaluatorDefinitionOptions<Error>
): Result.Result<EvaluatorDefinition<Error>, InvalidEvaluatorConfiguration> => {
  const captured = captureDefinitionOptions(options)
  if (Result.isFailure(captured)) {
    return Result.fail(captured.failure)
  }
  const definition = Object.freeze({
    binding: captured.success.binding,
    evaluate: captured.success.evaluate as EvaluatorHandler<Error>
  })
  definitions.add(definition)
  return Result.succeed(definition)
}

/**
 * Constructs a trusted evaluator definition while retaining invalid
 * configuration as typed data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromDefinition = <Error>(
  options: EvaluatorDefinitionOptions<Error>
): Result.Result<EvaluatorDefinition<Error>, InvalidEvaluatorConfiguration> => buildDefinition(options)

/**
 * Constructs one trusted process-local evaluator definition.
 *
 * **Details**
 *
 * Invalid static configuration throws {@link InvalidEvaluatorConfiguration}.
 * Use {@link fromDefinition} for dynamically discovered definitions.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeDefinition = <Error>(
  options: EvaluatorDefinitionOptions<Error>
): EvaluatorDefinition<Error> => {
  const result = buildDefinition(options)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

/**
 * Tests whether a value is an exact definition constructed by this module.
 *
 * @category guards
 * @since 4.0.0
 */
export const isEvaluatorDefinition = (
  value: unknown
): value is AnyEvaluatorDefinition => typeof value === "object" && value !== null && definitions.has(value)

const captureDefinitions = (
  input: unknown
): Result.Result<ReadonlyArray<AnyEvaluatorDefinition>, InvalidEvaluatorConfiguration> => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return Result.fail(invalid("build", InvalidEvaluatorCodes.InvalidOptions))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const lengthDescriptor = (
      descriptors as unknown as Readonly<Record<string, PropertyDescriptor | undefined>>
    ).length
    const length = lengthDescriptor !== undefined &&
        Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
      ? lengthDescriptor.value
      : undefined
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    ) {
      return Result.fail(invalid("build", InvalidEvaluatorCodes.InvalidOptions))
    }
    const output = new Array<AnyEvaluatorDefinition>(length)
    for (let index = 0; index < length; index++) {
      const descriptor = ownEnumerableData(descriptors, String(index))
      if (descriptor === undefined || !isEvaluatorDefinition(descriptor.value)) {
        return Result.fail(
          invalid("build", InvalidEvaluatorCodes.InvalidDefinition, index)
        )
      }
      output[index] = descriptor.value
    }
    return Result.succeed(Object.freeze(output))
  } catch {
    return Result.fail(invalid("build", InvalidEvaluatorCodes.UnsafeInspection))
  }
}

const buildRegistry = (
  input: unknown
): Result.Result<EvaluatorRegistry.Service, RegistryBuildError> => {
  const captured = captureDefinitions(input)
  if (Result.isFailure(captured)) {
    return Result.fail(captured.failure)
  }
  const byBinding = new Map<string, AnyEvaluatorDefinition>()
  for (const definition of captured.success) {
    const key = BpmnExpression.evaluatorBindingKey(definition.binding)
    if (byBinding.has(key)) {
      return Result.fail(
        new DuplicateEvaluatorDefinition({ binding: definition.binding })
      )
    }
    byBinding.set(key, definition)
  }

  const resolve: EvaluatorRegistry.Service["resolve"] = Effect.fnUntraced(
    function*(input) {
      const binding = captureBinding(input, "resolve")
      if (Result.isFailure(binding)) {
        return yield* Effect.fail(binding.failure)
      }
      const definition = byBinding.get(
        BpmnExpression.evaluatorBindingKey(binding.success)
      )
      if (definition === undefined) {
        return yield* Effect.fail(
          new EvaluatorNotFound({ binding: binding.success })
        )
      }
      return definition
    }
  )

  const service = EvaluatorRegistry.of(Object.freeze({
    size: byBinding.size,
    resolve
  }))
  registries.add(service)
  return Result.succeed(service)
}

/**
 * Builds an immutable registry while retaining configuration failures as
 * typed data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromDefinitions = (
  entries: ReadonlyArray<AnyEvaluatorDefinition>
): Result.Result<EvaluatorRegistry.Service, RegistryBuildError> => buildRegistry(entries)

/**
 * Constructs an immutable in-memory evaluator registry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory = (
  entries: ReadonlyArray<AnyEvaluatorDefinition>
): Effect.Effect<EvaluatorRegistry.Service, RegistryBuildError> =>
  Effect.suspend(() => Effect.fromResult(buildRegistry(entries)))

/**
 * Constructs a layer containing an immutable evaluator registry.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory = (
  entries: ReadonlyArray<AnyEvaluatorDefinition>
): Layer.Layer<EvaluatorRegistry, RegistryBuildError> => Layer.effect(EvaluatorRegistry, makeMemory(entries))

/**
 * Tests whether a value is an exact registry constructed by this module.
 *
 * @category guards
 * @since 4.0.0
 */
export const isEvaluatorRegistry = (
  value: unknown
): value is EvaluatorRegistry.Service => typeof value === "object" && value !== null && registries.has(value)
