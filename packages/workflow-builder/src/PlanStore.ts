/**
 * Immutable durable-plan artifacts and tenant-scoped run bindings.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Fingerprint from "./Fingerprint.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * The mandatory physical namespace and semantic run identifier of a durable
 * execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunKey = Schema.Struct({
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDurableRunKey",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunKey}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunKey = Schema.Schema.Type<typeof RunKey>

/**
 * An immutable physical target selected before durable activity dispatch.
 *
 * **Details**
 *
 * `deploymentId` names an exact immutable handler deployment, not a mutable
 * alias such as `latest`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchTarget = Schema.Struct({
  queue: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDispatchTarget",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DispatchTarget}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchTarget = Schema.Schema.Type<typeof DispatchTarget>

/**
 * Physical targets keyed by every node identifier in an admitted plan.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchTargets = Schema.Record(Schema.String, DispatchTarget).check(
  Schema.isPropertyNames(Schema.NonEmptyString)
).annotate({
  identifier: "WorkflowDispatchTargets",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DispatchTargets}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchTargets = Schema.Schema.Type<typeof DispatchTargets>

/**
 * Content identity of the complete durable plan artifact.
 *
 * **Details**
 *
 * The wire representation is SHA-256, but the brand prevents confusing this
 * value with the narrower compiled-plan fingerprint in typed application code.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ArtifactDigest = Fingerprint.Digest.pipe(
  Schema.brand("@effect/workflow-builder/PlanStore/ArtifactDigest")
).annotate({ identifier: "WorkflowPlanArtifactDigest" })

/**
 * The decoded type of {@link ArtifactDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactDigest = Schema.Schema.Type<typeof ArtifactDigest>

/**
 * Strict reusable content whose digest pins durable execution meaning.
 *
 * **Details**
 *
 * The compiled fingerprint identifies the portable plan and compiler-derived
 * topology. The artifact additionally pins the complete execution protocol,
 * workflow-definition deployment, and each node's exact queue and handler
 * deployment. It contains no run input, tenant identifier, request identity,
 * timestamp, credential, or mutable capacity setting.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PlanArtifact = Schema.Struct({
  artifactVersion: Schema.Literal(1),
  executionProtocolVersion: Schema.Literal(1),
  fingerprintDocument: Fingerprint.FingerprintDocument,
  compiledFingerprint: Fingerprint.Digest,
  definitionDeploymentId: Schema.NonEmptyString,
  dispatchTargets: DispatchTargets
}).annotate({
  identifier: "WorkflowDurablePlanArtifact",
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
 * Stable machine-readable failures for detached plan-artifact validation.
 *
 * @category constants
 * @since 4.0.0
 */
export const ArtifactValidationCodes = {
  InvalidSchema: "InvalidSchema",
  DuplicateNodeId: "DuplicateNodeId",
  TargetKeyMismatch: "TargetKeyMismatch",
  InvalidTopology: "InvalidTopology"
} as const

/**
 * A stable plan-artifact validation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactValidationErrorCode = typeof ArtifactValidationCodes[keyof typeof ArtifactValidationCodes]

const ArtifactValidationErrorCode = Schema.Literals([
  ArtifactValidationCodes.InvalidSchema,
  ArtifactValidationCodes.DuplicateNodeId,
  ArtifactValidationCodes.TargetKeyMismatch,
  ArtifactValidationCodes.InvalidTopology
])

/**
 * Raised when a durable artifact is not strict detached JSON or its physical
 * target set does not exactly cover its portable plan nodes.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactValidationError extends Schema.TaggedErrorClass<ArtifactValidationError>(
  "@effect/workflow-builder/PlanStore/ArtifactValidationError"
)("ArtifactValidationError", {
  code: ArtifactValidationErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const decodePlanArtifact = Schema.decodeUnknownResult(PlanArtifact, strictParseOptions)

const artifactError = (
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
 * Detaches and validates one durable plan artifact.
 *
 * **Details**
 *
 * Cryptographic digest checks remain effectful storage/admission concerns. This
 * pure boundary rejects hostile containers, strict-schema violations,
 * duplicate portable node identifiers, and route sets that do not name every
 * plan node exactly once.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateArtifact = (
  input: unknown
): Result.Result<PlanArtifact, ArtifactValidationError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.InvalidSchema,
      `Plan artifact must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }

  let decoded: ReturnType<typeof decodePlanArtifact>
  try {
    decoded = decodePlanArtifact(snapped.success)
  } catch {
    return Result.fail(artifactError(
      ArtifactValidationCodes.InvalidSchema,
      "Plan artifact schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.InvalidSchema,
      "Invalid plan artifact",
      { parseError: decoded.failure.message }
    ))
  }

  const artifact = snapped.success as unknown as PlanArtifact
  const nodeIds = artifact.fingerprintDocument.plan.nodes.map((node) => node.id)
  const uniqueNodeIds = new Set(nodeIds)
  if (uniqueNodeIds.size !== nodeIds.length) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.DuplicateNodeId,
      "Plan artifact contains duplicate node identifiers",
      { nodeIds }
    ))
  }
  const expectedKeys = [...uniqueNodeIds].sort()
  const actualKeys = Object.keys(artifact.dispatchTargets).sort()
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.TargetKeyMismatch,
      "Dispatch target keys must exactly match all artifact plan node identifiers",
      { expectedKeys, actualKeys }
    ))
  }
  const topologicalOrder = [...artifact.fingerprintDocument.topologicalOrder]
  const orderedKeys = [...topologicalOrder].sort()
  const flattenedStages = artifact.fingerprintDocument.stages.flatMap((stage) => [...stage])
  if (
    topologicalOrder.length !== expectedKeys.length ||
    new Set(topologicalOrder).size !== topologicalOrder.length ||
    expectedKeys.some((key, index) => key !== orderedKeys[index]) ||
    flattenedStages.length !== topologicalOrder.length ||
    flattenedStages.some((nodeId, index) => nodeId !== topologicalOrder[index]) ||
    artifact.fingerprintDocument.stages.some((stage) => stage.length === 0)
  ) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.InvalidTopology,
      "Fingerprint topology and stages must cover every plan node exactly once in the same order",
      { expectedKeys, topologicalOrder, flattenedStages }
    ))
  }
  const edgeIds = artifact.fingerprintDocument.plan.edges.map((edge) => edge.id)
  const nodeSet = new Set(nodeIds)
  const orderByNode = new Map(topologicalOrder.map((nodeId, index) => [nodeId, index] as const))
  const stageByNode = new Map(
    artifact.fingerprintDocument.stages.flatMap((stage, stageIndex) =>
      stage.map((nodeId) => [nodeId, stageIndex] as const)
    )
  )
  const hasUnknownEndpoint = artifact.fingerprintDocument.plan.edges.some((edge) =>
    edge._tag === "ControlEdge"
      ? !nodeSet.has(edge.sourceNodeId) || !nodeSet.has(edge.targetNodeId)
      : (edge.source._tag === "NodeOutput" && !nodeSet.has(edge.source.nodeId)) ||
        (edge.target._tag === "NodeInput" && !nodeSet.has(edge.target.nodeId))
  )
  if (new Set(edgeIds).size !== edgeIds.length || hasUnknownEndpoint) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.InvalidTopology,
      "Artifact plan edges must have unique identifiers and known node endpoints",
      { edgeIds, hasUnknownEndpoint }
    ))
  }
  const invalidDependency = artifact.fingerprintDocument.plan.edges.find((edge) => {
    const sourceNodeId = edge._tag === "ControlEdge"
      ? edge.sourceNodeId
      : edge.source._tag === "NodeOutput"
      ? edge.source.nodeId
      : undefined
    const targetNodeId = edge._tag === "ControlEdge"
      ? edge.targetNodeId
      : edge.target._tag === "NodeInput"
      ? edge.target.nodeId
      : undefined
    return sourceNodeId !== undefined && targetNodeId !== undefined &&
      (orderByNode.get(sourceNodeId)! >= orderByNode.get(targetNodeId)! ||
        stageByNode.get(sourceNodeId)! >= stageByNode.get(targetNodeId)!)
  })
  if (invalidDependency !== undefined) {
    return Result.fail(artifactError(
      ArtifactValidationCodes.InvalidTopology,
      "Artifact dependency edges must point forward across declared topology stages",
      { edgeId: invalidDependency.id }
    ))
  }
  return Result.succeed(artifact)
}

/**
 * Immutable tenant-scoped binding created atomically with sequence zero.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunBinding = Schema.Struct({
  bindingVersion: Schema.Literal(1),
  executionProtocolVersion: Schema.Literal(1),
  key: RunKey,
  artifactDigest: ArtifactDigest,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  runStartedEventId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDurableRunBinding",
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
 * A run binding and the exact content-addressed artifact it selects.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BoundPlan = Schema.Struct({
  binding: RunBinding,
  artifact: PlanArtifact
}).annotate({
  identifier: "WorkflowBoundDurablePlan",
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
 * Raised when a tenant-scoped run has no durable plan binding.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunBindingNotFound extends Schema.TaggedErrorClass<RunBindingNotFound>(
  "@effect/workflow-builder/PlanStore/RunBindingNotFound"
)("RunBindingNotFound", {
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when an artifact digest is not available in the requested tenant.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactNotFound extends Schema.TaggedErrorClass<ArtifactNotFound>(
  "@effect/workflow-builder/PlanStore/ArtifactNotFound"
)("ArtifactNotFound", {
  tenantId: Schema.NonEmptyString,
  artifactDigest: ArtifactDigest
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a plan-store read cannot be performed safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanStoreFailure extends Schema.TaggedErrorClass<PlanStoreFailure>(
  "@effect/workflow-builder/PlanStore/PlanStoreFailure"
)("PlanStoreFailure", {
  operation: Schema.Literals(["getForRun", "getArtifact"]),
  message: Schema.NonEmptyString,
  cause: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Read-only access to immutable durable-plan artifacts and run bindings.
 *
 * **Details**
 *
 * Artifact insertion is intentionally absent. A durable execution store must
 * create or verify the artifact, bind the run, and append `RunStarted` in one
 * transaction.
 *
 * @category services
 * @since 4.0.0
 */
export class PlanStore extends Context.Service<PlanStore, PlanStore.Service>()(
  "@effect/workflow-builder/PlanStore"
) {}

/**
 * Service contracts for {@link PlanStore}.
 *
 * @since 4.0.0
 */
export declare namespace PlanStore {
  /**
   * The plan-store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly getForRun: (
      key: RunKey
    ) => Effect.Effect<BoundPlan, RunBindingNotFound | ArtifactNotFound | PlanStoreFailure>
    readonly getArtifact: (options: {
      readonly tenantId: string
      readonly artifactDigest: ArtifactDigest
    }) => Effect.Effect<PlanArtifact, ArtifactNotFound | PlanStoreFailure>
  }
}
