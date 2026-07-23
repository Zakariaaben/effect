/**
 * Immutable durable-plan artifacts pinned to execution protocol version `2`.
 *
 * **Details**
 *
 * This is a sibling contract rather than a widened version `1` schema. A
 * durable run therefore selects its reducer, decision, command, timer, and
 * signal semantics through a required artifact and binding field.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicy from "./ActivityPolicy.ts"
import * as EventV2 from "./EventV2.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV1 from "./PlanStore.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as SignalContractV2 from "./SignalContractV2.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Tenant-scoped durable run identity shared by protocol versions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunKey = PlanStoreV1.RunKey

/**
 * The decoded type of {@link RunKey}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunKey = PlanStoreV1.RunKey

/**
 * Immutable physical activity target shared by protocol versions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchTarget = PlanStoreV1.DispatchTarget

/**
 * The decoded type of {@link DispatchTarget}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchTarget = PlanStoreV1.DispatchTarget

/**
 * Exact node-to-dispatch-target map shared by protocol versions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchTargets = PlanStoreV1.DispatchTargets

/**
 * The decoded type of {@link DispatchTargets}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchTargets = PlanStoreV1.DispatchTargets

/**
 * Content identity of a complete protocol version `2` plan artifact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ArtifactDigest = ProtocolV2Wire.ArtifactDigest

/**
 * The decoded type of {@link ArtifactDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactDigest = ProtocolV2Wire.ArtifactDigest

/**
 * Immutable activity policies keyed by every executable plan node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityPolicies = Schema.Record(Schema.String, ActivityPolicy.Policy).check(
  Schema.isPropertyNames(Schema.NonEmptyString)
).annotate({
  identifier: "WorkflowActivityPoliciesV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityPolicies}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityPolicies = Schema.Schema.Type<typeof ActivityPolicies>

/**
 * Strict reusable durable meaning for execution protocol version `2`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PlanArtifact = Schema.Struct({
  artifactVersion: Schema.Literal(2),
  executionProtocolVersion: Schema.Literal(EventV2.ExecutionProtocolVersion),
  fingerprintDocument: PlanStoreV1.PlanArtifact.fields.fingerprintDocument,
  compiledFingerprint: ProtocolV2Wire.CompiledFingerprint,
  definitionDeploymentId: Schema.NonEmptyString,
  dispatchTargets: DispatchTargets,
  activityPolicies: ActivityPolicies,
  signalManifest: SignalContractV2.SignalCatalogManifest
}).annotate({
  identifier: "WorkflowDurablePlanArtifactV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link PlanArtifact}.
 *
 * @category models
 * @since 4.0.0
 */
export type PlanArtifact = Schema.Schema.Type<typeof PlanArtifact>

/**
 * Stable protocol version `2` plan-artifact validation codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ArtifactValidationCodes = {
  ...PlanStoreV1.ArtifactValidationCodes,
  PolicyKeyMismatch: "PolicyKeyMismatch"
} as const

/**
 * A stable protocol version `2` artifact validation code.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactValidationErrorCode = typeof ArtifactValidationCodes[keyof typeof ArtifactValidationCodes]

const ArtifactValidationErrorCode = Schema.Literals([
  ArtifactValidationCodes.InvalidSchema,
  ArtifactValidationCodes.DuplicateNodeId,
  ArtifactValidationCodes.TargetKeyMismatch,
  ArtifactValidationCodes.InvalidTopology,
  ArtifactValidationCodes.PolicyKeyMismatch
])

/**
 * Raised when a protocol version `2` artifact is not strict or relationally valid.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactValidationError extends Schema.TaggedErrorClass<ArtifactValidationError>(
  "@effect/workflow-builder/PlanStoreV2/ArtifactValidationError"
)("ArtifactValidationError", {
  code: ArtifactValidationErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const decodePlanArtifact = Schema.decodeUnknownResult(PlanArtifact, strictParseOptions)

const validationError = (
  code: ArtifactValidationErrorCode,
  message: string,
  details?: Schema.Json
): ArtifactValidationError =>
  new ArtifactValidationError({
    code,
    message,
    ...(details === undefined ? undefined : { details })
  })

/**
 * Detaches and validates one protocol version `2` durable plan artifact.
 *
 * **Details**
 *
 * Topology, stage, edge, and target-set invariants are intentionally identical
 * to version `1`; only the required artifact and execution-protocol selectors
 * differ. Cryptographic digest verification remains an effectful admission and
 * storage responsibility.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateArtifact = (
  input: unknown
): Result.Result<PlanArtifact, ArtifactValidationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidSchema,
      `Plan artifact must be strict JSON: ${snapshot.failure.message}`,
      {
        snapshotError: snapshot.failure.message,
        path: [...snapshot.failure.path]
      }
    ))
  }

  let decoded: ReturnType<typeof decodePlanArtifact>
  try {
    decoded = decodePlanArtifact(snapshot.success)
  } catch {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidSchema,
      "Plan artifact schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidSchema,
      "Invalid plan artifact",
      { parseError: decoded.failure.message }
    ))
  }

  const artifact = snapshot.success as unknown as PlanArtifact
  const structural = PlanStoreV1.validateArtifact({
    artifactVersion: 1,
    executionProtocolVersion: 1,
    fingerprintDocument: artifact.fingerprintDocument,
    compiledFingerprint: artifact.compiledFingerprint,
    definitionDeploymentId: artifact.definitionDeploymentId,
    dispatchTargets: artifact.dispatchTargets
  })
  if (Result.isFailure(structural)) {
    return Result.fail(validationError(
      structural.failure.code,
      structural.failure.message,
      structural.failure.details
    ))
  }
  const expectedKeys = Object.keys(artifact.dispatchTargets).sort()
  const policyKeys = Object.keys(artifact.activityPolicies).sort()
  if (
    expectedKeys.length !== policyKeys.length ||
    expectedKeys.some((key, index) => key !== policyKeys[index])
  ) {
    return Result.fail(validationError(
      ArtifactValidationCodes.PolicyKeyMismatch,
      "Activity policy keys must exactly match all artifact plan node identifiers",
      { expectedKeys, policyKeys }
    ))
  }
  return Result.succeed(artifact)
}

/**
 * Immutable tenant-scoped run binding for execution protocol version `2`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunBinding = Schema.Struct({
  bindingVersion: Schema.Literal(2),
  executionProtocolVersion: Schema.Literal(EventV2.ExecutionProtocolVersion),
  key: RunKey,
  artifactDigest: ArtifactDigest,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  runStartedEventId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDurableRunBindingV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunBinding = Schema.Schema.Type<typeof RunBinding>

/**
 * A version `2` run binding and its exact content-addressed artifact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BoundPlan = Schema.Struct({
  binding: RunBinding,
  artifact: PlanArtifact
}).annotate({
  identifier: "WorkflowBoundDurablePlanV2",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BoundPlan}.
 *
 * @category models
 * @since 4.0.0
 */
export type BoundPlan = Schema.Schema.Type<typeof BoundPlan>

/**
 * Read-only access to immutable version `2` artifacts and run bindings.
 *
 * @category services
 * @since 4.0.0
 */
export class PlanStoreV2 extends Context.Service<PlanStoreV2, PlanStoreV2.Service>()(
  "@effect/workflow-builder/PlanStoreV2"
) {}

/**
 * Service contracts for {@link PlanStoreV2}.
 *
 * @since 4.0.0
 */
export declare namespace PlanStoreV2 {
  /**
   * The version `2` plan-store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly getForRun: (
      key: RunKey
    ) => Effect.Effect<
      BoundPlan,
      PlanStoreV1.RunBindingNotFound | PlanStoreV1.ArtifactNotFound | PlanStoreV1.PlanStoreFailure
    >
    readonly getArtifact: (options: {
      readonly tenantId: string
      readonly artifactDigest: ArtifactDigest
    }) => Effect.Effect<
      PlanArtifact,
      PlanStoreV1.ArtifactNotFound | PlanStoreV1.PlanStoreFailure
    >
  }
}
