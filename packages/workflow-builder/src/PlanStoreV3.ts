/**
 * Trusted static-DAG plan artifacts for execution protocol version `3`.
 *
 * **Details**
 *
 * This module admits only CompilerV2 `StaticDag` artifacts. BPMN executable
 * artifacts are a future strict sibling contract and are never coerced into
 * this shape. Build digests prove descriptor integrity; deciding that a build
 * descriptor names authentic executable code remains the responsibility of a
 * separately trusted executable-catalog attestation authority.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "./ChildWorkflowV3.ts"
import * as CompilerV2 from "./CompilerV2.ts"
import * as DigestV3 from "./DigestV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const verifiedArtifacts = new WeakSet<object>()

/**
 * Static-DAG artifact wire version.
 *
 * @category constants
 * @since 4.0.0
 */
export const ArtifactVersion = 3 as const

/**
 * Execution protocol selected by this artifact.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 3 as const

/**
 * Maximum entries admitted in any artifact manifest array.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumManifestEntries = 16_384 as const

const ManifestArray = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(Schema.isMaxLength(MaximumManifestEntries))

const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const canonicalTuple = (
  domain: string,
  first: string,
  second: string
): string => JSON.stringify([domain, first, second])

/**
 * Returns the collision-free identity of one codec pin.
 *
 * @category identity
 * @since 4.0.0
 */
export const codecKey = (codecId: string, codecVersion: string): string =>
  canonicalTuple("codec", codecId, codecVersion)

/**
 * Returns the collision-free identity of one node-definition manifest.
 *
 * @category identity
 * @since 4.0.0
 */
export const nodeDefinitionKey = (
  nodeType: string,
  nodeVersion: string
): string => canonicalTuple("node-definition", nodeType, nodeVersion)

/**
 * Returns the collision-free identity of one retry-classifier executable.
 *
 * @category identity
 * @since 4.0.0
 */
export const classifierKey = (
  classifierId: string,
  classifierVersion: string
): string => canonicalTuple("retry-classifier", classifierId, classifierVersion)

/**
 * Explicit executable kinds carried by static-DAG artifacts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExecutableKind = Schema.Literals([
  "WorkflowDefinition",
  "NodeHandler",
  "Codec",
  "RetryClassifier"
]).annotate({ identifier: "WorkflowPlanStoreV3ExecutableKind" })

/**
 * The decoded type of {@link ExecutableKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutableKind = Schema.Schema.Type<typeof ExecutableKind>

/**
 * Inspectable identity document for a catalog-owned executable build.
 *
 * **Details**
 *
 * Its digest detects descriptor substitution. It does not, by itself, prove
 * that deployed code has the behavior represented by this document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExecutableBuildDocument = Schema.Struct({
  buildDocumentVersion: Schema.Literal(3),
  executableKind: ExecutableKind,
  executableId: Wire.AtomicIdentifier,
  executableVersion: Wire.AtomicIdentifier,
  deploymentId: Wire.AtomicIdentifier,
  catalogBuildId: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowPlanStoreV3ExecutableBuildDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExecutableBuildDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutableBuildDocument = Schema.Schema.Type<
  typeof ExecutableBuildDocument
>

/**
 * Exact deployment and content identity of an executable descriptor.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExecutableBuildPin = Schema.Struct({
  deploymentId: Wire.AtomicIdentifier,
  buildDocument: ExecutableBuildDocument,
  buildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowPlanStoreV3ExecutableBuildPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExecutableBuildPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutableBuildPin = Schema.Schema.Type<
  typeof ExecutableBuildPin
>

/**
 * Inspectable encoded-schema document owned by one codec.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EncodedSchemaDocument = Schema.Struct({
  encodedSchemaVersion: Schema.Literal(3),
  codecKey: Wire.Identifier,
  codecId: Wire.AtomicIdentifier,
  codecVersion: Wire.AtomicIdentifier,
  format: Wire.AtomicIdentifier,
  schema: Schema.Json
}).annotate({
  identifier: "WorkflowPlanStoreV3EncodedSchemaDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EncodedSchemaDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type EncodedSchemaDocument = Schema.Schema.Type<
  typeof EncodedSchemaDocument
>

/**
 * Complete executable and schema pin for one reusable codec.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CodecPin = Schema.Struct({
  codecPinVersion: Schema.Literal(3),
  key: Wire.Identifier,
  codecId: Wire.AtomicIdentifier,
  codecVersion: Wire.AtomicIdentifier,
  build: ExecutableBuildPin,
  encodedSchema: EncodedSchemaDocument,
  schemaDigest: Wire.SchemaDigest
}).annotate({
  identifier: "WorkflowPlanStoreV3CodecPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CodecPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type CodecPin = Schema.Schema.Type<typeof CodecPin>

/**
 * One input port in a node-definition manifest.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeInputPortManifest = Schema.Struct({
  name: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier,
  cardinality: Schema.Literals(["one", "many"]),
  required: Schema.Boolean,
  codecKey: Wire.Identifier
}).annotate({
  identifier: "WorkflowPlanStoreV3NodeInputPortManifest",
  parseOptions: strictParseOptions
})

/**
 * One output port in a node-definition manifest.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeOutputPortManifest = Schema.Struct({
  name: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier,
  fanOut: Schema.Literals(["single", "multiple"]),
  codecKey: Wire.Identifier
}).annotate({
  identifier: "WorkflowPlanStoreV3NodeOutputPortManifest",
  parseOptions: strictParseOptions
})

/**
 * Complete codec and port-shape manifest for one used node definition.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeDefinitionManifest = Schema.Struct({
  manifestVersion: Schema.Literal(3),
  key: Wire.Identifier,
  nodeType: Wire.AtomicIdentifier,
  nodeVersion: Wire.AtomicIdentifier,
  configCodecKey: Wire.Identifier,
  failureCodecKey: Wire.Identifier,
  inputs: ManifestArray(NodeInputPortManifest),
  outputs: ManifestArray(NodeOutputPortManifest)
}).annotate({
  identifier: "WorkflowPlanStoreV3NodeDefinitionManifest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeDefinitionManifest}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeDefinitionManifest = Schema.Schema.Type<
  typeof NodeDefinitionManifest
>

/**
 * One aggregate workflow-input boundary port.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InputBoundaryPort = Schema.Struct({
  name: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier,
  fanOut: Schema.Literals(["single", "multiple"]),
  codecKey: Wire.Identifier
}).annotate({
  identifier: "WorkflowPlanStoreV3InputBoundaryPort",
  parseOptions: strictParseOptions
})

/**
 * One aggregate workflow-output boundary port.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OutputBoundaryPort = Schema.Struct({
  name: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier,
  cardinality: Schema.Literals(["one", "many"]),
  required: Schema.Boolean,
  codecKey: Wire.Identifier
}).annotate({
  identifier: "WorkflowPlanStoreV3OutputBoundaryPort",
  parseOptions: strictParseOptions
})

const BoundaryDefinitionReference = Schema.Struct({
  id: Wire.AtomicIdentifier,
  version: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowPlanStoreV3BoundaryDefinitionReference",
  parseOptions: strictParseOptions
})

/**
 * Aggregate contract document for every workflow input.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InputBoundaryContractDocument = Schema.Struct({
  boundaryContractVersion: Schema.Literal(3),
  direction: Schema.Literal("Input"),
  definition: BoundaryDefinitionReference,
  ports: ManifestArray(InputBoundaryPort)
}).annotate({
  identifier: "WorkflowPlanStoreV3InputBoundaryContractDocument",
  parseOptions: strictParseOptions
})

/**
 * Aggregate contract document for every workflow output.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OutputBoundaryContractDocument = Schema.Struct({
  boundaryContractVersion: Schema.Literal(3),
  direction: Schema.Literal("Output"),
  definition: BoundaryDefinitionReference,
  ports: ManifestArray(OutputBoundaryPort)
}).annotate({
  identifier: "WorkflowPlanStoreV3OutputBoundaryContractDocument",
  parseOptions: strictParseOptions
})

/**
 * Pinned workflow-input boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InputBoundaryPin = Schema.Struct({
  document: InputBoundaryContractDocument,
  digest: Wire.ContractDigest
}).annotate({
  identifier: "WorkflowPlanStoreV3InputBoundaryPin",
  parseOptions: strictParseOptions
})

/**
 * Pinned workflow-output boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OutputBoundaryPin = Schema.Struct({
  document: OutputBoundaryContractDocument,
  digest: Wire.ContractDigest
}).annotate({
  identifier: "WorkflowPlanStoreV3OutputBoundaryPin",
  parseOptions: strictParseOptions
})

/**
 * Exact workflow-definition deployment and build.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DefinitionPin = Schema.Struct({
  id: Wire.AtomicIdentifier,
  version: Wire.AtomicIdentifier,
  build: ExecutableBuildPin
}).annotate({
  identifier: "WorkflowPlanStoreV3DefinitionPin",
  parseOptions: strictParseOptions
})

/**
 * A retry-classifier build referenced by one or more activity policies.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PolicyExecutablePin = Schema.Struct({
  key: Wire.Identifier,
  classifierId: Wire.AtomicIdentifier,
  classifierVersion: Wire.AtomicIdentifier,
  build: ExecutableBuildPin
}).annotate({
  identifier: "WorkflowPlanStoreV3PolicyExecutablePin",
  parseOptions: strictParseOptions
})

/**
 * Deterministic execution binding for one plan node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeBinding = Schema.Struct({
  bindingVersion: Schema.Literal(3),
  nodeId: Wire.AtomicIdentifier,
  nodeType: Wire.AtomicIdentifier,
  nodeVersion: Wire.AtomicIdentifier,
  nodeDefinitionKey: Wire.Identifier,
  queue: Wire.AtomicIdentifier,
  handlerBuild: ExecutableBuildPin,
  activityPolicy: ActivityPolicyV3.Policy
}).annotate({
  identifier: "WorkflowPlanStoreV3NodeBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeBinding = Schema.Schema.Type<typeof NodeBinding>

/**
 * Complete reusable static-DAG execution meaning for protocol version `3`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StaticDagArtifact = Schema.Struct({
  artifactVersion: Schema.Literal(ArtifactVersion),
  artifactKind: Schema.Literal("StaticDag"),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  fingerprintDocument: CompilerV2.FingerprintDocument,
  compiledFingerprint: Wire.CompiledFingerprint,
  workflowFamilyIdentity: Wire.Identifier,
  definition: DefinitionPin,
  inputBoundary: InputBoundaryPin,
  outputBoundary: OutputBoundaryPin,
  nodeDefinitions: ManifestArray(NodeDefinitionManifest),
  codecs: ManifestArray(CodecPin),
  policyExecutableBuilds: ManifestArray(PolicyExecutablePin),
  nodeBindings: ManifestArray(NodeBinding)
}).annotate({
  identifier: "WorkflowPlanStoreV3StaticDagArtifact",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StaticDagArtifact}.
 *
 * @category models
 * @since 4.0.0
 */
export type StaticDagArtifact = Schema.Schema.Type<typeof StaticDagArtifact>

/**
 * Current static-DAG artifact contract.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PlanArtifact = StaticDagArtifact

/**
 * The decoded type of {@link PlanArtifact}.
 *
 * @category models
 * @since 4.0.0
 */
export type PlanArtifact = StaticDagArtifact

/**
 * Stable pure artifact-validation codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ArtifactValidationCodes = {
  InvalidJson: "InvalidJson",
  InvalidSchema: "InvalidSchema",
  NonV3StaticDagArtifact: "NonV3StaticDagArtifact",
  InvalidCompilerDocument: "InvalidCompilerDocument",
  NonCanonical: "NonCanonical",
  DefinitionMismatch: "DefinitionMismatch",
  FamilyIdentityMismatch: "FamilyIdentityMismatch",
  BoundaryMismatch: "BoundaryMismatch",
  NodeCoverageMismatch: "NodeCoverageMismatch",
  NodeBindingMismatch: "NodeBindingMismatch",
  CodecCoverageMismatch: "CodecCoverageMismatch",
  ExecutableBuildMismatch: "ExecutableBuildMismatch",
  ActivityPolicyMismatch: "ActivityPolicyMismatch",
  InvalidExpectedArtifactDigest: "InvalidExpectedArtifactDigest"
} as const

/**
 * A stable pure artifact-validation code.
 *
 * @category models
 * @since 4.0.0
 */
export type ArtifactValidationCode = typeof ArtifactValidationCodes[keyof typeof ArtifactValidationCodes]

const ArtifactValidationCode = Schema.Literals([
  ArtifactValidationCodes.InvalidJson,
  ArtifactValidationCodes.InvalidSchema,
  ArtifactValidationCodes.NonV3StaticDagArtifact,
  ArtifactValidationCodes.InvalidCompilerDocument,
  ArtifactValidationCodes.NonCanonical,
  ArtifactValidationCodes.DefinitionMismatch,
  ArtifactValidationCodes.FamilyIdentityMismatch,
  ArtifactValidationCodes.BoundaryMismatch,
  ArtifactValidationCodes.NodeCoverageMismatch,
  ArtifactValidationCodes.NodeBindingMismatch,
  ArtifactValidationCodes.CodecCoverageMismatch,
  ArtifactValidationCodes.ExecutableBuildMismatch,
  ArtifactValidationCodes.ActivityPolicyMismatch,
  ArtifactValidationCodes.InvalidExpectedArtifactDigest
])

const ValidationPath = Schema.Array(Schema.Union([
  Schema.String,
  Wire.NonNegativeSafeInt
]))

/**
 * Raised when static-DAG artifact data is not strict, canonical, or
 * relationally complete.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactValidationError extends Schema.TaggedErrorClass<
  ArtifactValidationError
>("@effect/workflow-builder/PlanStoreV3/ArtifactValidationError")(
  "ArtifactValidationError",
  {
    code: ArtifactValidationCode,
    message: Schema.NonEmptyString,
    path: ValidationPath
  },
  { parseOptions: strictParseOptions }
) {}

const validationError = (
  code: ArtifactValidationCode,
  message: string,
  path: ReadonlyArray<string | number> = []
): ArtifactValidationError => new ArtifactValidationError({ code, message, path: [...path] })

const decodeStaticDagArtifact = Schema.decodeUnknownResult(
  StaticDagArtifact,
  strictParseOptions
)
const decodeIdentifier = Schema.decodeUnknownResult(
  Wire.AtomicIdentifier,
  strictParseOptions
)

const invalidCompilerIdentifier = (
  artifact: StaticDagArtifact
): ArtifactValidationError | undefined => {
  const candidates: Array<
    readonly [string, ReadonlyArray<string | number>]
  > = []
  const add = (
    value: string,
    path: ReadonlyArray<string | number>
  ): void => {
    candidates.push([value, path])
  }
  const document = artifact.fingerprintDocument
  add(document.semanticPlan.id, ["fingerprintDocument", "semanticPlan", "id"])
  add(document.semanticPlan.definition.id, [
    "fingerprintDocument",
    "semanticPlan",
    "definition",
    "id"
  ])
  add(document.semanticPlan.definition.version, [
    "fingerprintDocument",
    "semanticPlan",
    "definition",
    "version"
  ])
  for (let index = 0; index < document.semanticPlan.nodes.length; index++) {
    const node = document.semanticPlan.nodes[index]!
    add(node.id, ["fingerprintDocument", "semanticPlan", "nodes", index, "id"])
    add(node.type, [
      "fingerprintDocument",
      "semanticPlan",
      "nodes",
      index,
      "type"
    ])
    add(node.version, [
      "fingerprintDocument",
      "semanticPlan",
      "nodes",
      index,
      "version"
    ])
  }
  for (
    let index = 0;
    index < document.semanticPlan.dataEdges.length;
    index++
  ) {
    const edge = document.semanticPlan.dataEdges[index]!
    const prefix: ReadonlyArray<string | number> = [
      "fingerprintDocument",
      "semanticPlan",
      "dataEdges",
      index
    ]
    add(edge.id, [...prefix, "id"])
    if (edge.source._tag === "WorkflowInput") {
      add(edge.source.input, [...prefix, "source", "input"])
    } else {
      add(edge.source.nodeId, [...prefix, "source", "nodeId"])
      add(edge.source.output, [...prefix, "source", "output"])
    }
    if (edge.target._tag === "WorkflowOutput") {
      add(edge.target.output, [...prefix, "target", "output"])
    } else {
      add(edge.target.nodeId, [...prefix, "target", "nodeId"])
      add(edge.target.input, [...prefix, "target", "input"])
    }
  }
  for (
    let index = 0;
    index < document.semanticPlan.controlEdges.length;
    index++
  ) {
    const edge = document.semanticPlan.controlEdges[index]!
    const prefix: ReadonlyArray<string | number> = [
      "fingerprintDocument",
      "semanticPlan",
      "controlEdges",
      index
    ]
    add(edge.id, [...prefix, "id"])
    add(edge.sourceNodeId, [...prefix, "sourceNodeId"])
    add(edge.targetNodeId, [...prefix, "targetNodeId"])
  }
  for (
    let index = 0;
    index < document.workflowInterface.inputs.length;
    index++
  ) {
    const port = document.workflowInterface.inputs[index]!
    add(port.name, [
      "fingerprintDocument",
      "workflowInterface",
      "inputs",
      index,
      "name"
    ])
    add(port.contract, [
      "fingerprintDocument",
      "workflowInterface",
      "inputs",
      index,
      "contract"
    ])
  }
  for (
    let index = 0;
    index < document.workflowInterface.outputs.length;
    index++
  ) {
    const port = document.workflowInterface.outputs[index]!
    add(port.name, [
      "fingerprintDocument",
      "workflowInterface",
      "outputs",
      index,
      "name"
    ])
    add(port.contract, [
      "fingerprintDocument",
      "workflowInterface",
      "outputs",
      index,
      "contract"
    ])
  }
  for (let index = 0; index < document.program.nodes.length; index++) {
    const node = document.program.nodes[index]!
    const prefix: ReadonlyArray<string | number> = [
      "fingerprintDocument",
      "program",
      "nodes",
      index
    ]
    add(node.id, [...prefix, "id"])
    add(node.type, [...prefix, "type"])
    add(node.version, [...prefix, "version"])
    for (
      const [field, values] of [
        ["incomingEdgeIds", node.incomingEdgeIds],
        ["outgoingEdgeIds", node.outgoingEdgeIds],
        ["dependencies", node.dependencies],
        ["dependents", node.dependents]
      ] as const
    ) {
      for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
        add(values[valueIndex]!, [...prefix, field, valueIndex])
      }
    }
  }
  for (let index = 0; index < document.program.dataEdges.length; index++) {
    const edge = document.program.dataEdges[index]!
    const prefix: ReadonlyArray<string | number> = [
      "fingerprintDocument",
      "program",
      "dataEdges",
      index
    ]
    add(edge.id, [...prefix, "id"])
    add(edge.source.port, [...prefix, "source", "port"])
    add(edge.source.contract, [...prefix, "source", "contract"])
    if (edge.source.kind === "NodeOutput") {
      add(edge.source.nodeId, [...prefix, "source", "nodeId"])
      add(edge.source.nodeType, [...prefix, "source", "nodeType"])
      add(edge.source.nodeVersion, [...prefix, "source", "nodeVersion"])
    }
    add(edge.target.port, [...prefix, "target", "port"])
    add(edge.target.contract, [...prefix, "target", "contract"])
    if (edge.target.kind === "NodeInput") {
      add(edge.target.nodeId, [...prefix, "target", "nodeId"])
      add(edge.target.nodeType, [...prefix, "target", "nodeType"])
      add(edge.target.nodeVersion, [...prefix, "target", "nodeVersion"])
    }
  }
  for (let index = 0; index < document.program.controlEdges.length; index++) {
    const edge = document.program.controlEdges[index]!
    const prefix: ReadonlyArray<string | number> = [
      "fingerprintDocument",
      "program",
      "controlEdges",
      index
    ]
    add(edge.id, [...prefix, "id"])
    add(edge.sourceNodeId, [...prefix, "sourceNodeId"])
    add(edge.targetNodeId, [...prefix, "targetNodeId"])
  }
  for (
    let index = 0;
    index < document.program.topologicalOrder.length;
    index++
  ) {
    add(document.program.topologicalOrder[index]!, [
      "fingerprintDocument",
      "program",
      "topologicalOrder",
      index
    ])
  }
  for (let stageIndex = 0; stageIndex < document.program.stages.length; stageIndex++) {
    const stage = document.program.stages[stageIndex]!
    for (let index = 0; index < stage.length; index++) {
      add(stage[index]!, [
        "fingerprintDocument",
        "program",
        "stages",
        stageIndex,
        index
      ])
    }
  }
  for (const [value, path] of candidates) {
    let decoded: ReturnType<typeof decodeIdentifier>
    try {
      decoded = decodeIdentifier(value)
    } catch {
      return validationError(
        ArtifactValidationCodes.InvalidSchema,
        "CompilerV2 identifier validation threw unexpectedly",
        path
      )
    }
    if (Result.isFailure(decoded)) {
      return validationError(
        ArtifactValidationCodes.InvalidSchema,
        "CompilerV2 identifiers must be bounded Unicode-scalar values",
        path
      )
    }
  }
  return undefined
}

const strictSorted = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string
): boolean => {
  for (let index = 1; index < values.length; index++) {
    if (codeUnitCompare(key(values[index - 1]!), key(values[index]!)) >= 0) {
      return false
    }
  }
  return true
}

const sameStrings = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index])

const validateBuild = (
  pin: ExecutableBuildPin,
  kind: ExecutableKind,
  id: string,
  version: string
): boolean =>
  pin.deploymentId === pin.buildDocument.deploymentId &&
  pin.buildDocument.executableKind === kind &&
  pin.buildDocument.executableId === id &&
  pin.buildDocument.executableVersion === version

const jsonObject = (
  value: Schema.Json
): Schema.JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Schema.JsonObject
    : undefined

const versionError = (
  value: Schema.Json
): ArtifactValidationError | undefined => {
  const object = jsonObject(value)
  if (object === undefined) {
    return undefined
  }
  const selectors: ReadonlyArray<readonly [string, Schema.Json]> = [
    ["artifactVersion", ArtifactVersion],
    ["artifactKind", "StaticDag"],
    ["executionProtocolVersion", ExecutionProtocolVersion]
  ]
  for (const [key, expected] of selectors) {
    if (key in object && object[key] !== expected) {
      return validationError(
        ArtifactValidationCodes.NonV3StaticDagArtifact,
        `${key} must select the protocol-v3 StaticDag artifact contract`,
        [key]
      )
    }
  }
  return undefined
}

const validateCanonical = (
  artifact: StaticDagArtifact
): ArtifactValidationError | undefined => {
  const arrays: ReadonlyArray<
    readonly [string, ReadonlyArray<unknown>, (value: any) => string]
  > = [
    ["nodeDefinitions", artifact.nodeDefinitions, (value) => value.key],
    ["codecs", artifact.codecs, (value) => value.key],
    [
      "policyExecutableBuilds",
      artifact.policyExecutableBuilds,
      (value) => value.key
    ],
    ["nodeBindings", artifact.nodeBindings, (value) => value.nodeId],
    [
      "inputBoundary.document.ports",
      artifact.inputBoundary.document.ports,
      (value) => value.name
    ],
    [
      "outputBoundary.document.ports",
      artifact.outputBoundary.document.ports,
      (value) => value.name
    ]
  ]
  for (const [path, values, key] of arrays) {
    if (!strictSorted(values, key)) {
      return validationError(
        ArtifactValidationCodes.NonCanonical,
        `${path} must be unique and code-unit sorted`,
        path.split(".")
      )
    }
  }
  for (let index = 0; index < artifact.nodeDefinitions.length; index++) {
    const manifest = artifact.nodeDefinitions[index]!
    if (
      !strictSorted(manifest.inputs, (port) => port.name) ||
      !strictSorted(manifest.outputs, (port) => port.name)
    ) {
      return validationError(
        ArtifactValidationCodes.NonCanonical,
        "Node manifest ports must be unique and code-unit sorted",
        ["nodeDefinitions", index]
      )
    }
  }
  return undefined
}

const validateDefinitionAndBoundaries = (
  artifact: StaticDagArtifact
): ArtifactValidationError | undefined => {
  const fingerprint = artifact.fingerprintDocument
  const definition = fingerprint.semanticPlan.definition
  if (
    artifact.definition.id !== definition.id ||
    artifact.definition.version !== definition.version ||
    !validateBuild(
      artifact.definition.build,
      "WorkflowDefinition",
      definition.id,
      definition.version
    )
  ) {
    return validationError(
      ArtifactValidationCodes.DefinitionMismatch,
      "Artifact definition and build must exactly match the compiler definition",
      ["definition"]
    )
  }
  if (
    artifact.workflowFamilyIdentity !==
      ChildWorkflowV3.workflowFamilyIdentity(definition.id)
  ) {
    return validationError(
      ArtifactValidationCodes.FamilyIdentityMismatch,
      "workflowFamilyIdentity must be derived from the definition id",
      ["workflowFamilyIdentity"]
    )
  }
  const input = artifact.inputBoundary.document
  const output = artifact.outputBoundary.document
  if (
    input.definition.id !== definition.id ||
    input.definition.version !== definition.version ||
    output.definition.id !== definition.id ||
    output.definition.version !== definition.version
  ) {
    return validationError(
      ArtifactValidationCodes.BoundaryMismatch,
      "Boundary documents must select the artifact definition",
      ["inputBoundary"]
    )
  }
  const compilerInputs = fingerprint.workflowInterface.inputs
  const compilerOutputs = fingerprint.workflowInterface.outputs
  if (
    input.ports.length !== compilerInputs.length ||
    input.ports.some((port, index) => {
      const expected = compilerInputs[index]
      return expected === undefined ||
        port.name !== expected.name ||
        port.contract !== expected.contract ||
        port.fanOut !== expected.fanOut
    }) ||
    output.ports.length !== compilerOutputs.length ||
    output.ports.some((port, index) => {
      const expected = compilerOutputs[index]
      return expected === undefined ||
        port.name !== expected.name ||
        port.contract !== expected.contract ||
        port.cardinality !== expected.cardinality ||
        port.required !== expected.required
    })
  ) {
    return validationError(
      ArtifactValidationCodes.BoundaryMismatch,
      "Boundary port semantics must exactly match CompilerV2 workflow interface",
      ["inputBoundary"]
    )
  }
  return undefined
}

const incomingEndpointKey = (
  target: CompilerV2.ResolvedTargetEndpoint
): string =>
  target.kind === "NodeInput"
    ? JSON.stringify(["NodeInput", target.nodeId, target.port])
    : JSON.stringify(["WorkflowOutput", target.port])

const outgoingEndpointKey = (
  source: CompilerV2.ResolvedSourceEndpoint
): string =>
  source.kind === "NodeOutput"
    ? JSON.stringify(["NodeOutput", source.nodeId, source.port])
    : JSON.stringify(["WorkflowInput", source.port])

const targetConnectionError = (
  edges: ReadonlyArray<CompilerV2.ResolvedDataEdge>,
  port: {
    readonly cardinality: "one" | "many"
    readonly required: boolean
  },
  code: ArtifactValidationCode,
  label: string,
  path: ReadonlyArray<string | number>
): ArtifactValidationError | undefined => {
  if (port.required && edges.length === 0) {
    return validationError(
      code,
      `Required ${label} must have an incoming data edge`,
      path
    )
  }
  if (port.cardinality === "one" && edges.length > 1) {
    return validationError(
      code,
      `${label} with cardinality one cannot have multiple incoming data edges`,
      path
    )
  }
  if (port.cardinality === "many" && edges.length > 1) {
    const orders = edges.map((edge) => edge.order)
    const present = orders.filter((order): order is number => order !== undefined)
    if (
      present.length !== orders.length ||
      new Set(present).size !== present.length
    ) {
      return validationError(
        code,
        `${label} with multiple incoming data edges requires a unique explicit order on every edge`,
        path
      )
    }
  }
  return undefined
}

const sourceConnectionError = (
  edges: ReadonlyArray<CompilerV2.ResolvedDataEdge>,
  fanOut: "single" | "multiple",
  code: ArtifactValidationCode,
  label: string,
  path: ReadonlyArray<string | number>
): ArtifactValidationError | undefined =>
  fanOut === "single" && edges.length > 1
    ? validationError(
      code,
      `${label} with single fan-out cannot have multiple outgoing data edges`,
      path
    )
    : undefined

const validateNodeCoverage = (
  artifact: StaticDagArtifact
): ArtifactValidationError | undefined => {
  const manifests = new Map(
    artifact.nodeDefinitions.map((manifest) => [manifest.key, manifest] as const)
  )
  const expectedManifestKeys = Array.from(
    new Set(
      artifact.fingerprintDocument.program.nodes.map((node) => nodeDefinitionKey(node.type, node.version))
    )
  ).sort(codeUnitCompare)
  if (
    !sameStrings(
      artifact.nodeDefinitions.map((manifest) => manifest.key),
      expectedManifestKeys
    ) ||
    artifact.nodeDefinitions.some((manifest) =>
      manifest.key !==
        nodeDefinitionKey(manifest.nodeType, manifest.nodeVersion)
    )
  ) {
    return validationError(
      ArtifactValidationCodes.NodeCoverageMismatch,
      "Node manifests must exactly cover every used type and version",
      ["nodeDefinitions"]
    )
  }

  const programNodes = artifact.fingerprintDocument.program.nodes
  if (
    artifact.nodeBindings.length !== programNodes.length ||
    artifact.nodeBindings.some((binding, index) => {
      const node = programNodes[index]
      return node === undefined ||
        binding.nodeId !== node.id ||
        binding.nodeType !== node.type ||
        binding.nodeVersion !== node.version ||
        binding.nodeDefinitionKey !==
          nodeDefinitionKey(node.type, node.version) ||
        !validateBuild(
          binding.handlerBuild,
          "NodeHandler",
          node.type,
          node.version
        )
    })
  ) {
    return validationError(
      ArtifactValidationCodes.NodeBindingMismatch,
      "Node bindings must exactly cover sorted program nodes and handler builds",
      ["nodeBindings"]
    )
  }

  for (const edge of artifact.fingerprintDocument.program.dataEdges) {
    if (edge.source.kind === "NodeOutput") {
      const manifest = manifests.get(
        nodeDefinitionKey(edge.source.nodeType, edge.source.nodeVersion)
      )
      const port = manifest?.outputs.find((candidate) => candidate.name === edge.source.port)
      if (port === undefined || port.contract !== edge.source.contract) {
        return validationError(
          ArtifactValidationCodes.NodeCoverageMismatch,
          "Resolved node output must exist with the same contract in its manifest",
          ["fingerprintDocument", "program", "dataEdges", edge.id, "source"]
        )
      }
    }
    if (edge.target.kind === "NodeInput") {
      const manifest = manifests.get(
        nodeDefinitionKey(edge.target.nodeType, edge.target.nodeVersion)
      )
      const port = manifest?.inputs.find((candidate) => candidate.name === edge.target.port)
      if (port === undefined || port.contract !== edge.target.contract) {
        return validationError(
          ArtifactValidationCodes.NodeCoverageMismatch,
          "Resolved node input must exist with the same contract in its manifest",
          ["fingerprintDocument", "program", "dataEdges", edge.id, "target"]
        )
      }
    }
  }

  const incoming = new Map<
    string,
    Array<CompilerV2.ResolvedDataEdge>
  >()
  const outgoing = new Map<
    string,
    Array<CompilerV2.ResolvedDataEdge>
  >()
  for (const edge of artifact.fingerprintDocument.program.dataEdges) {
    const targetKey = incomingEndpointKey(edge.target)
    const sourceKey = outgoingEndpointKey(edge.source)
    const targetEdges = incoming.get(targetKey) ?? []
    targetEdges.push(edge)
    incoming.set(targetKey, targetEdges)
    const sourceEdges = outgoing.get(sourceKey) ?? []
    sourceEdges.push(edge)
    outgoing.set(sourceKey, sourceEdges)
  }

  for (const node of programNodes) {
    const manifest = manifests.get(
      nodeDefinitionKey(node.type, node.version)
    )!
    for (let index = 0; index < manifest.inputs.length; index++) {
      const port = manifest.inputs[index]!
      const error = targetConnectionError(
        incoming.get(
          JSON.stringify(["NodeInput", node.id, port.name])
        ) ?? [],
        port,
        ArtifactValidationCodes.NodeCoverageMismatch,
        `node input '${node.id}.${port.name}'`,
        ["nodeDefinitions", manifest.key, "inputs", index]
      )
      if (error !== undefined) return error
    }
    for (let index = 0; index < manifest.outputs.length; index++) {
      const port = manifest.outputs[index]!
      const error = sourceConnectionError(
        outgoing.get(
          JSON.stringify(["NodeOutput", node.id, port.name])
        ) ?? [],
        port.fanOut,
        ArtifactValidationCodes.NodeCoverageMismatch,
        `node output '${node.id}.${port.name}'`,
        ["nodeDefinitions", manifest.key, "outputs", index]
      )
      if (error !== undefined) return error
    }
  }

  for (
    let index = 0;
    index < artifact.inputBoundary.document.ports.length;
    index++
  ) {
    const port = artifact.inputBoundary.document.ports[index]!
    const error = sourceConnectionError(
      outgoing.get(
        JSON.stringify(["WorkflowInput", port.name])
      ) ?? [],
      port.fanOut,
      ArtifactValidationCodes.BoundaryMismatch,
      `workflow input '${port.name}'`,
      ["inputBoundary", "document", "ports", index]
    )
    if (error !== undefined) return error
  }
  for (
    let index = 0;
    index < artifact.outputBoundary.document.ports.length;
    index++
  ) {
    const port = artifact.outputBoundary.document.ports[index]!
    const error = targetConnectionError(
      incoming.get(
        JSON.stringify(["WorkflowOutput", port.name])
      ) ?? [],
      port,
      ArtifactValidationCodes.BoundaryMismatch,
      `workflow output '${port.name}'`,
      ["outputBoundary", "document", "ports", index]
    )
    if (error !== undefined) return error
  }
  return undefined
}

const validateCodecCoverage = (
  artifact: StaticDagArtifact
): ArtifactValidationError | undefined => {
  const codecs = new Map(
    artifact.codecs.map((codec) => [codec.key, codec] as const)
  )
  const referenced = new Set<string>()
  for (const port of artifact.inputBoundary.document.ports) {
    referenced.add(port.codecKey)
  }
  for (const port of artifact.outputBoundary.document.ports) {
    referenced.add(port.codecKey)
  }
  for (const manifest of artifact.nodeDefinitions) {
    referenced.add(manifest.configCodecKey)
    referenced.add(manifest.failureCodecKey)
    for (const port of manifest.inputs) referenced.add(port.codecKey)
    for (const port of manifest.outputs) referenced.add(port.codecKey)
  }
  const expected = Array.from(referenced).sort(codeUnitCompare)
  if (
    !sameStrings(artifact.codecs.map((codec) => codec.key), expected) ||
    artifact.codecs.some((codec) => {
      const expectedKey = codecKey(codec.codecId, codec.codecVersion)
      return codec.key !== expectedKey ||
        codec.encodedSchema.codecKey !== expectedKey ||
        codec.encodedSchema.codecId !== codec.codecId ||
        codec.encodedSchema.codecVersion !== codec.codecVersion ||
        !validateBuild(
          codec.build,
          "Codec",
          codec.codecId,
          codec.codecVersion
        )
    }) ||
    expected.some((key) => !codecs.has(key))
  ) {
    return validationError(
      ArtifactValidationCodes.CodecCoverageMismatch,
      "Codec pins must uniquely and exactly cover every manifest codec reference",
      ["codecs"]
    )
  }
  return undefined
}

const validatePolicies = (
  artifact: StaticDagArtifact
): ArtifactValidationError | undefined => {
  const executablePins = new Map(
    artifact.policyExecutableBuilds.map((pin) => [pin.key, pin] as const)
  )
  const referenced = new Set<string>()
  for (let index = 0; index < artifact.nodeBindings.length; index++) {
    const policy = ActivityPolicyV3.validate(
      artifact.nodeBindings[index]!.activityPolicy
    )
    if (Result.isFailure(policy)) {
      return validationError(
        ArtifactValidationCodes.ActivityPolicyMismatch,
        "Every node binding must carry a valid ActivityPolicyV3 policy",
        ["nodeBindings", index, "activityPolicy"]
      )
    }
    const classifier = policy.success.retry.classifier
    const key = classifierKey(
      classifier.classifierId,
      classifier.classifierVersion
    )
    referenced.add(key)
    const pin = executablePins.get(key)
    if (
      pin === undefined ||
      pin.build.buildDigest !== classifier.buildDigest ||
      !validateBuild(
        pin.build,
        "RetryClassifier",
        classifier.classifierId,
        classifier.classifierVersion
      )
    ) {
      return validationError(
        ArtifactValidationCodes.ActivityPolicyMismatch,
        "Activity classifier pins must match their executable build",
        ["nodeBindings", index, "activityPolicy", "retry", "classifier"]
      )
    }
  }
  const expected = Array.from(referenced).sort(codeUnitCompare)
  if (
    !sameStrings(
      artifact.policyExecutableBuilds.map((pin) => pin.key),
      expected
    ) ||
    artifact.policyExecutableBuilds.some((pin) => pin.key !== classifierKey(pin.classifierId, pin.classifierVersion))
  ) {
    return validationError(
      ArtifactValidationCodes.ActivityPolicyMismatch,
      "Policy executable pins must exactly cover all retry classifiers",
      ["policyExecutableBuilds"]
    )
  }
  return undefined
}

/**
 * Detaches and purely validates one protocol-v3 static-DAG artifact.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateArtifact = (
  input: unknown
): Result.Result<StaticDagArtifact, ArtifactValidationError> => {
  const snapshot = Json.snapshot(input, {
    maxArrayLength: MaximumManifestEntries,
    maxContainers: 65_536,
    maxDepth: 1_024,
    maxEntries: 262_144,
    maxStringBytes: 1_048_576,
    maxTotalBytes: 16_777_216
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidJson,
      `Artifact must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }
  const selector = versionError(snapshot.success)
  if (selector !== undefined) {
    return Result.fail(selector)
  }
  let decoded: ReturnType<typeof decodeStaticDagArtifact>
  try {
    decoded = decodeStaticDagArtifact(snapshot.success)
  } catch {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidSchema,
      "StaticDag artifact schema validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidSchema,
      `Invalid StaticDag artifact: ${decoded.failure.message}`
    ))
  }
  const artifact = snapshot.success as unknown as StaticDagArtifact
  try {
    const identifier = invalidCompilerIdentifier(artifact)
    if (identifier !== undefined) {
      return Result.fail(identifier)
    }
    const compiler = CompilerV2.validateFingerprintDocument(
      artifact.fingerprintDocument
    )
    if (Result.isFailure(compiler)) {
      return Result.fail(validationError(
        ArtifactValidationCodes.InvalidCompilerDocument,
        compiler.failure.message,
        ["fingerprintDocument"]
      ))
    }
    for (
      const error of [
        validateCanonical(artifact),
        validateDefinitionAndBoundaries(artifact),
        validateNodeCoverage(artifact),
        validateCodecCoverage(artifact),
        validatePolicies(artifact)
      ]
    ) {
      if (error !== undefined) return Result.fail(error)
    }
  } catch {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidSchema,
      "StaticDag artifact relational validation threw unexpectedly"
    ))
  }
  return Result.succeed(artifact)
}

/**
 * Digest roles verified in a fixed order during artifact admission.
 *
 * @category schemas
 * @since 4.0.0
 */
export const VerifiedDigestRole = Schema.Literals([
  "CompiledPlan",
  "InputBoundary",
  "OutputBoundary",
  "DefinitionBuild",
  "HandlerBuild",
  "CodecBuild",
  "EncodedSchema",
  "PolicyExecutableBuild",
  "Artifact"
]).annotate({ identifier: "WorkflowPlanStoreV3VerifiedDigestRole" })

/**
 * The decoded type of {@link VerifiedDigestRole}.
 *
 * @category models
 * @since 4.0.0
 */
export type VerifiedDigestRole = Schema.Schema.Type<
  typeof VerifiedDigestRole
>

/**
 * Raised when recomputed content identity differs from a pinned digest.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactDigestMismatch extends Schema.TaggedErrorClass<
  ArtifactDigestMismatch
>("@effect/workflow-builder/PlanStoreV3/ArtifactDigestMismatch")(
  "ArtifactDigestMismatch",
  {
    role: VerifiedDigestRole,
    key: Schema.optionalKey(Wire.Identifier),
    expected: Wire.Sha256Digest,
    actual: Wire.Sha256Digest
  },
  { parseOptions: strictParseOptions }
) {}

const digestMismatch = (
  role: VerifiedDigestRole,
  expected: Wire.Sha256Digest,
  actual: Wire.Sha256Digest,
  key?: string
): ArtifactDigestMismatch =>
  new ArtifactDigestMismatch({
    role,
    expected,
    actual,
    ...(key === undefined ? undefined : { key })
  })

const verifyDigest = <
  A extends Wire.Sha256Digest,
  E,
  R
>(
  role: VerifiedDigestRole,
  expected: Wire.Sha256Digest,
  effect: Effect.Effect<A, E, R>,
  key?: string
): Effect.Effect<A, E | ArtifactDigestMismatch, R> =>
  Effect.flatMap(effect, (actual) =>
    actual === expected
      ? Effect.succeed(actual)
      : Effect.fail(digestMismatch(role, expected, actual, key)))

/**
 * A cryptographically verified static-DAG artifact with process-local
 * provenance.
 *
 * **Details**
 *
 * The artifact and its digest are detached immutable values. Structural copies
 * do not preserve verification provenance.
 *
 * @category models
 * @since 4.0.0
 */
export interface VerifiedArtifact {
  readonly artifact: StaticDagArtifact
  readonly artifactDigest: Wire.ArtifactDigest
}

/**
 * Tests whether a value was returned by {@link verifyArtifact} in this process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isVerifiedArtifact = (
  value: unknown
): value is VerifiedArtifact => typeof value === "object" && value !== null && verifiedArtifacts.has(value)

const decodeExpectedArtifactDigest = Schema.decodeUnknownResult(
  Wire.ArtifactDigest,
  strictParseOptions
)

const validateExpectedArtifactDigest = (
  input: unknown
): Result.Result<Wire.ArtifactDigest, ArtifactValidationError> => {
  const snapshot = Json.snapshot(input, {
    maxArrayLength: 1,
    maxContainers: 1,
    maxDepth: 1,
    maxEntries: 1,
    maxStringBytes: 256,
    maxTotalBytes: 256
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidExpectedArtifactDigest,
      `Expected artifact digest must be strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: ReturnType<typeof decodeExpectedArtifactDigest>
  try {
    decoded = decodeExpectedArtifactDigest(snapshot.success)
  } catch {
    return Result.fail(validationError(
      ArtifactValidationCodes.InvalidExpectedArtifactDigest,
      "Expected artifact digest validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(validationError(
      ArtifactValidationCodes.InvalidExpectedArtifactDigest,
      "Expected artifact digest is not canonical SHA-256"
    ))
    : Result.succeed(decoded.success)
}

/**
 * Validates and cryptographically verifies one static-DAG artifact.
 *
 * **Details**
 *
 * Digests are recomputed sequentially in this fixed order: compiled plan,
 * input boundary, output boundary, definition build, node-handler builds,
 * codec builds and schemas, retry-classifier builds, then the complete
 * artifact. Handler, codec, and classifier arrays are already canonical, so
 * this order is reproducible across processes.
 *
 * `expectedArtifactDigest` is an optional lookup/integrity expectation only.
 * The returned digest is always computed from the detached artifact; supplying
 * an expected value never confers provenance.
 *
 * Build digest verification proves descriptor integrity, not executable-code
 * authenticity. A deployment must separately attest these build descriptors
 * through its trusted executable catalog.
 *
 * @category validation
 * @since 4.0.0
 */
export const verifyArtifact = Effect.fnUntraced(function*(
  input: unknown,
  expectedArtifactDigest?: unknown
): Effect.fn.Return<
  VerifiedArtifact,
  | ArtifactValidationError
  | ArtifactDigestMismatch
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> {
  const validation = validateArtifact(input)
  if (Result.isFailure(validation)) {
    return yield* Effect.fail(validation.failure)
  }
  const artifact = validation.success
  let expected: Wire.ArtifactDigest | undefined
  if (expectedArtifactDigest !== undefined) {
    const decoded = validateExpectedArtifactDigest(expectedArtifactDigest)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    expected = decoded.success
  }

  yield* verifyDigest(
    "CompiledPlan",
    artifact.compiledFingerprint,
    DigestV3.compiledPlan(artifact.fingerprintDocument)
  )
  yield* verifyDigest(
    "InputBoundary",
    artifact.inputBoundary.digest,
    DigestV3.boundaryContract(artifact.inputBoundary.document)
  )
  yield* verifyDigest(
    "OutputBoundary",
    artifact.outputBoundary.digest,
    DigestV3.boundaryContract(artifact.outputBoundary.document)
  )
  yield* verifyDigest(
    "DefinitionBuild",
    artifact.definition.build.buildDigest,
    DigestV3.executableBuild(artifact.definition.build.buildDocument),
    artifact.definition.id
  )
  for (const binding of artifact.nodeBindings) {
    yield* verifyDigest(
      "HandlerBuild",
      binding.handlerBuild.buildDigest,
      DigestV3.executableBuild(binding.handlerBuild.buildDocument),
      binding.nodeId
    )
  }
  for (const codec of artifact.codecs) {
    yield* verifyDigest(
      "CodecBuild",
      codec.build.buildDigest,
      DigestV3.executableBuild(codec.build.buildDocument),
      codec.key
    )
    yield* verifyDigest(
      "EncodedSchema",
      codec.schemaDigest,
      DigestV3.encodedSchema(codec.encodedSchema),
      codec.key
    )
  }
  for (const executable of artifact.policyExecutableBuilds) {
    yield* verifyDigest(
      "PolicyExecutableBuild",
      executable.build.buildDigest,
      DigestV3.executableBuild(executable.build.buildDocument),
      executable.key
    )
  }

  const computedArtifactDigest = yield* DigestV3.artifact(artifact)
  if (
    expected !== undefined &&
    computedArtifactDigest !== expected
  ) {
    return yield* Effect.fail(digestMismatch(
      "Artifact",
      expected,
      computedArtifactDigest
    ))
  }
  const verified = Object.freeze({
    artifact,
    artifactDigest: computedArtifactDigest
  })
  verifiedArtifacts.add(verified)
  return verified
})

/**
 * Tenant-scoped durable run identity for protocol version `3`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunKey = Schema.Struct({
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier
}).annotate({
  identifier: "WorkflowPlanStoreV3RunKey",
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
 * Immutable run-to-artifact binding for protocol version `3`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunBinding = Schema.Struct({
  bindingVersion: Schema.Literal(3),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  key: RunKey,
  artifactDigest: Wire.ArtifactDigest,
  workflowIdentity: Wire.AtomicIdentifier,
  requestId: Wire.SourceEventIdentifier,
  runStartedEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowPlanStoreV3RunBinding",
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
 * Stored run binding and unverified artifact bytes.
 *
 * **Details**
 *
 * Reading this record does not confer trust. Consumers must call
 * {@link verifyArtifact} using `binding.artifactDigest` before execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BoundPlan = Schema.Struct({
  binding: RunBinding,
  artifact: StaticDagArtifact
}).annotate({
  identifier: "WorkflowPlanStoreV3BoundPlan",
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
 * Raised when no protocol-v3 binding exists for a tenant-scoped run.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunBindingNotFound extends Schema.TaggedErrorClass<
  RunBindingNotFound
>("@effect/workflow-builder/PlanStoreV3/RunBindingNotFound")(
  "RunBindingNotFound",
  {
    tenantId: Wire.AtomicIdentifier,
    runId: Wire.LineageIdentifier
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when one protocol-v3 artifact is absent from tenant-scoped storage.
 *
 * @category errors
 * @since 4.0.0
 */
export class ArtifactNotFound extends Schema.TaggedErrorClass<
  ArtifactNotFound
>("@effect/workflow-builder/PlanStoreV3/ArtifactNotFound")(
  "ArtifactNotFound",
  {
    tenantId: Wire.AtomicIdentifier,
    artifactDigest: Wire.ArtifactDigest
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when a read-only plan-store operation fails.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanStoreFailure extends Schema.TaggedErrorClass<
  PlanStoreFailure
>("@effect/workflow-builder/PlanStoreV3/PlanStoreFailure")(
  "PlanStoreFailure",
  {
    operation: Schema.Literals(["getForRun", "getArtifact"]),
    message: Schema.NonEmptyString,
    cause: Schema.optionalKey(Schema.Json)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Read-only access to immutable protocol-v3 static-DAG artifacts and bindings.
 *
 * **Details**
 *
 * Artifact insertion is deliberately absent. The execution authority owns the
 * atomic verify, bind, and `RunStarted` transaction.
 *
 * @category services
 * @since 4.0.0
 */
export class PlanStoreV3 extends Context.Service<
  PlanStoreV3,
  PlanStoreV3.Service
>()("@effect/workflow-builder/PlanStoreV3") {}

/**
 * Service contracts for {@link PlanStoreV3}.
 *
 * @since 4.0.0
 */
export declare namespace PlanStoreV3 {
  /**
   * Read-only protocol-v3 plan-store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly getForRun: (
      key: RunKey
    ) => Effect.Effect<
      BoundPlan,
      RunBindingNotFound | ArtifactNotFound | PlanStoreFailure
    >
    readonly getArtifact: (options: {
      readonly tenantId: string
      readonly artifactDigest: Wire.ArtifactDigest
    }) => Effect.Effect<
      StaticDagArtifact,
      ArtifactNotFound | PlanStoreFailure
    >
  }
}

/**
 * Validated policy supplied when deriving a child target from an artifact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildTargetOptions = Schema.Struct({
  closePolicy: ChildWorkflowV3.ChildClosePolicy,
  maxLineageDepth: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(ChildWorkflowV3.MaximumLineageDepth)
  )
}).annotate({
  identifier: "WorkflowPlanStoreV3ChildTargetOptions",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildTargetOptions}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildTargetOptions = Schema.Schema.Type<
  typeof ChildTargetOptions
>

/**
 * Stable child-target derivation codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ChildTargetDerivationCodes = {
  UnverifiedArtifact: "UnverifiedArtifact",
  InvalidOptions: "InvalidOptions",
  InvalidDerivedTarget: "InvalidDerivedTarget"
} as const

const ChildTargetDerivationCode = Schema.Literals([
  ChildTargetDerivationCodes.UnverifiedArtifact,
  ChildTargetDerivationCodes.InvalidOptions,
  ChildTargetDerivationCodes.InvalidDerivedTarget
])

/**
 * Raised when a trusted static-DAG child target cannot be derived.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildTargetDerivationError extends Schema.TaggedErrorClass<
  ChildTargetDerivationError
>("@effect/workflow-builder/PlanStoreV3/ChildTargetDerivationError")(
  "ChildTargetDerivationError",
  {
    code: ChildTargetDerivationCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const childTargetError = (
  code: typeof ChildTargetDerivationCodes[
    keyof typeof ChildTargetDerivationCodes
  ],
  message: string
): ChildTargetDerivationError => new ChildTargetDerivationError({ code, message })

const decodeChildTargetOptions = Schema.decodeUnknownResult(
  ChildTargetOptions,
  strictParseOptions
)

/**
 * Derives a self-contained child target from one verified static-DAG artifact.
 *
 * **Details**
 *
 * Every artifact-owned field is copied from the WeakSet-provenanced verified
 * artifact. Replay therefore needs only the returned target pin and does not
 * consult a mutable definition or deployment resolver.
 *
 * @category constructors
 * @since 4.0.0
 */
export const deriveChildTarget = (
  verified: VerifiedArtifact,
  options: unknown
): Result.Result<
  ChildWorkflowV3.ChildTargetPin,
  ChildTargetDerivationError
> => {
  if (!isVerifiedArtifact(verified)) {
    return Result.fail(childTargetError(
      ChildTargetDerivationCodes.UnverifiedArtifact,
      "Child targets require an exact VerifiedArtifact from this process"
    ))
  }
  const snapshot = Json.snapshot(options, {
    maxArrayLength: 8,
    maxContainers: 16,
    maxDepth: 8,
    maxEntries: 32,
    maxStringBytes: 256,
    maxTotalBytes: 2_048
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(childTargetError(
      ChildTargetDerivationCodes.InvalidOptions,
      `Child target options must be strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: ReturnType<typeof decodeChildTargetOptions>
  try {
    decoded = decodeChildTargetOptions(snapshot.success)
  } catch {
    return Result.fail(childTargetError(
      ChildTargetDerivationCodes.InvalidOptions,
      "Child target option validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(childTargetError(
      ChildTargetDerivationCodes.InvalidOptions,
      `Invalid child target options: ${decoded.failure.message}`
    ))
  }
  const artifact = verified.artifact
  const candidate = {
    targetVersion: 3 as const,
    artifactVersion: ArtifactVersion,
    executionProtocolVersion: ExecutionProtocolVersion,
    artifactDigest: verified.artifactDigest,
    plan: {
      id: artifact.fingerprintDocument.semanticPlan.id,
      revision: artifact.fingerprintDocument.semanticPlan.revision
    },
    compilerSemanticVersion: CompilerV2.CompilerSemanticVersion,
    compiledFingerprint: artifact.compiledFingerprint,
    definition: {
      id: artifact.definition.id,
      version: artifact.definition.version,
      deploymentId: artifact.definition.build.deploymentId,
      buildDigest: artifact.definition.build.buildDigest
    },
    workflowFamilyIdentity: artifact.workflowFamilyIdentity,
    inputContractDigest: artifact.inputBoundary.digest,
    outputContractDigest: artifact.outputBoundary.digest,
    closePolicy: decoded.success.closePolicy,
    recursionPolicy: "Forbid" as const,
    maxLineageDepth: decoded.success.maxLineageDepth
  }
  const target = ChildWorkflowV3.validateChildTargetPin(candidate)
  return Result.isFailure(target)
    ? Result.fail(childTargetError(
      ChildTargetDerivationCodes.InvalidDerivedTarget,
      target.failure.message
    ))
    : Result.succeed(target.success)
}
