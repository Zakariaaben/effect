/**
 * Portable, exact bindings for BPMN formal-expression evaluators.
 *
 * **Details**
 *
 * A workflow definition records language identity, executable build identity,
 * and resource limits. It never records a JavaScript function or asks a
 * runtime to select a "latest" compatible evaluator.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Maximum UTF-8 byte length of one formal-expression source.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumSourceUtf8Bytes = 1_048_576 as const

/**
 * Maximum byte length of one canonical JSON evaluation context.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumContextCanonicalBytes = 16_777_216 as const

/**
 * Maximum evaluator-accounted work steps for one expression.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumEvaluationSteps = 10_000_000 as const

/**
 * Maximum wall-clock budget, in milliseconds, for one evaluation.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumEvaluationTimeoutMillis = 300_000 as const

const boundedPositiveInt = (maximum: number) =>
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(maximum)
  )

/**
 * Exact logical and physical identity of an evaluator build.
 *
 * **Details**
 *
 * `deploymentId` selects an installed artifact, while `buildDigest` verifies
 * the artifact's content identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EvaluatorBuildPin = Schema.Struct({
  id: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString,
  buildDigest: ProtocolV2Wire.BuildDigest
}).annotate({
  identifier: "WorkflowBpmnEvaluatorBuildPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EvaluatorBuildPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluatorBuildPin = Schema.Schema.Type<typeof EvaluatorBuildPin>

/**
 * Portable resource limits applied to one expression evaluation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EvaluationLimits = Schema.Struct({
  maxSourceUtf8Bytes: boundedPositiveInt(MaximumSourceUtf8Bytes),
  maxContextCanonicalBytes: boundedPositiveInt(MaximumContextCanonicalBytes),
  maxSteps: boundedPositiveInt(MaximumEvaluationSteps),
  timeoutMillis: boundedPositiveInt(MaximumEvaluationTimeoutMillis)
}).annotate({
  identifier: "WorkflowBpmnEvaluationLimits",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EvaluationLimits}.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluationLimits = Schema.Schema.Type<typeof EvaluationLimits>

/**
 * Complete portable identity and limits of one formal-expression evaluator.
 *
 * **Details**
 *
 * Every field participates in registry identity. A runtime must resolve this
 * complete tuple exactly; language-only and semantic-version fallback are not
 * part of the contract.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EvaluatorBinding = Schema.Struct({
  language: Schema.NonEmptyString,
  languageVersion: Schema.NonEmptyString,
  build: EvaluatorBuildPin,
  limits: EvaluationLimits
}).annotate({
  identifier: "WorkflowBpmnEvaluatorBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EvaluatorBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluatorBinding = Schema.Schema.Type<typeof EvaluatorBinding>

/**
 * Produces the collision-safe process-local key for one complete binding.
 *
 * **Details**
 *
 * The JSON array spelling is unambiguous because every position is fixed and
 * every member has already been validated by {@link EvaluatorBinding}.
 *
 * @category utilities
 * @since 4.0.0
 */
export const evaluatorBindingKey = (binding: EvaluatorBinding): string =>
  JSON.stringify([
    binding.language,
    binding.languageVersion,
    binding.build.id,
    binding.build.version,
    binding.build.deploymentId,
    binding.build.buildDigest,
    binding.limits.maxSourceUtf8Bytes,
    binding.limits.maxContextCanonicalBytes,
    binding.limits.maxSteps,
    binding.limits.timeoutMillis
  ])
