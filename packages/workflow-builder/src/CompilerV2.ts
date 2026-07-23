/**
 * Canonical compiler semantic version `2` intermediate representation.
 *
 * **Details**
 *
 * Version `2` separates user-authored semantic plan data, the workflow
 * boundary interface, and the compiler-resolved static DAG. Presentation
 * metadata is deliberately excluded, while every array whose order is not
 * itself semantic is normalized with an ECMAScript code-unit comparator.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Compiler from "./Compiler.ts"
import type * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"
import * as Plan from "./Plan.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeInt = Wire.NonNegativeSafeInt

const preparedPlans = new WeakSet<object>()

/**
 * Version of the canonical compiler-v2 fingerprint document.
 *
 * @category constants
 * @since 4.0.0
 */
export const FingerprintVersion = 2 as const

/**
 * Compiler semantics represented by this module.
 *
 * **Details**
 *
 * This is intentionally independent from the portable plan format and
 * execution protocol versions.
 *
 * @category constants
 * @since 4.0.0
 */
export const CompilerSemanticVersion = "2" as const

/**
 * Version of the workflow-boundary interface document.
 *
 * @category constants
 * @since 4.0.0
 */
export const WorkflowInterfaceVersion = 2 as const

/**
 * Version of the resolved static-DAG program.
 *
 * @category constants
 * @since 4.0.0
 */
export const StaticDagProgramVersion = 1 as const

/**
 * A metadata-free node in the semantic plan.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticPlanNode = Schema.Struct({
  id: Wire.AtomicIdentifier,
  type: Wire.AtomicIdentifier,
  version: Wire.AtomicIdentifier,
  config: Plan.PlanNode.fields.config
}).annotate({
  identifier: "WorkflowCompilerV2SemanticPlanNode",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SemanticPlanNode}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticPlanNode = Schema.Schema.Type<typeof SemanticPlanNode>

/**
 * A metadata-free data edge retaining the portable endpoint spelling.
 *
 * **Details**
 *
 * The enclosing `dataEdges` array supplies the edge variant, so only the
 * endpoint unions retain their `_tag` discriminants.
 *
 * @category schemas
 * @since 4.0.0
 */
const SemanticSourceEndpoint = Schema.Union([
  Schema.TaggedStruct("WorkflowInput", {
    input: Wire.AtomicIdentifier
  }),
  Schema.TaggedStruct("NodeOutput", {
    nodeId: Wire.AtomicIdentifier,
    output: Wire.AtomicIdentifier
  })
])

const SemanticTargetEndpoint = Schema.Union([
  Schema.TaggedStruct("NodeInput", {
    nodeId: Wire.AtomicIdentifier,
    input: Wire.AtomicIdentifier
  }),
  Schema.TaggedStruct("WorkflowOutput", {
    output: Wire.AtomicIdentifier
  })
])

/**
 * A metadata-free data edge retaining bounded, Unicode-scalar endpoint
 * identifiers.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticDataEdge = Schema.Struct({
  id: Wire.AtomicIdentifier,
  source: SemanticSourceEndpoint,
  target: SemanticTargetEndpoint,
  order: Schema.optionalKey(NonNegativeInt)
}).annotate({
  identifier: "WorkflowCompilerV2SemanticDataEdge",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SemanticDataEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticDataEdge = Schema.Schema.Type<typeof SemanticDataEdge>

/**
 * A metadata-free control dependency.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticControlEdge = Schema.Struct({
  id: Wire.AtomicIdentifier,
  sourceNodeId: Wire.AtomicIdentifier,
  targetNodeId: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowCompilerV2SemanticControlEdge",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SemanticControlEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticControlEdge = Schema.Schema.Type<
  typeof SemanticControlEdge
>

/**
 * Canonical user-authored execution meaning with presentation metadata
 * removed.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticPlan = Schema.Struct({
  formatVersion: Plan.Plan.fields.formatVersion,
  id: Wire.AtomicIdentifier,
  revision: Wire.NonNegativeSafeInt,
  definition: Schema.Struct({
    id: Wire.AtomicIdentifier,
    version: Wire.AtomicIdentifier
  }),
  nodes: Schema.Array(SemanticPlanNode),
  dataEdges: Schema.Array(SemanticDataEdge),
  controlEdges: Schema.Array(SemanticControlEdge)
}).annotate({
  identifier: "WorkflowCompilerV2SemanticPlan",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SemanticPlan}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticPlan = Schema.Schema.Type<typeof SemanticPlan>

/**
 * A workflow input exposed by the canonical interface.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkflowInterfaceInput = Schema.Struct({
  name: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier,
  fanOut: Schema.Literals(["single", "multiple"])
}).annotate({
  identifier: "WorkflowCompilerV2InterfaceInput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkflowInterfaceInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkflowInterfaceInput = Schema.Schema.Type<
  typeof WorkflowInterfaceInput
>

/**
 * A workflow output exposed by the canonical interface.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkflowInterfaceOutput = Schema.Struct({
  name: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier,
  cardinality: Schema.Literals(["one", "many"]),
  required: Schema.Boolean
}).annotate({
  identifier: "WorkflowCompilerV2InterfaceOutput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkflowInterfaceOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkflowInterfaceOutput = Schema.Schema.Type<
  typeof WorkflowInterfaceOutput
>

/**
 * Canonical portable meaning of the workflow boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkflowInterface = Schema.Struct({
  interfaceVersion: Schema.Literal(WorkflowInterfaceVersion),
  inputs: Schema.Array(WorkflowInterfaceInput),
  outputs: Schema.Array(WorkflowInterfaceOutput)
}).annotate({
  identifier: "WorkflowCompilerV2Interface",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkflowInterface}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkflowInterface = Schema.Schema.Type<typeof WorkflowInterface>

/**
 * A resolved workflow-input source.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedWorkflowInput = Schema.Struct({
  kind: Schema.Literal("WorkflowInput"),
  port: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowCompilerV2ResolvedWorkflowInput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolvedWorkflowInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedWorkflowInput = Schema.Schema.Type<
  typeof ResolvedWorkflowInput
>

/**
 * A resolved node-output source.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedNodeOutput = Schema.Struct({
  kind: Schema.Literal("NodeOutput"),
  nodeId: Wire.AtomicIdentifier,
  nodeType: Wire.AtomicIdentifier,
  nodeVersion: Wire.AtomicIdentifier,
  port: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowCompilerV2ResolvedNodeOutput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolvedNodeOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedNodeOutput = Schema.Schema.Type<typeof ResolvedNodeOutput>

/**
 * A resolved node-input target.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedNodeInput = Schema.Struct({
  kind: Schema.Literal("NodeInput"),
  nodeId: Wire.AtomicIdentifier,
  nodeType: Wire.AtomicIdentifier,
  nodeVersion: Wire.AtomicIdentifier,
  port: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowCompilerV2ResolvedNodeInput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolvedNodeInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedNodeInput = Schema.Schema.Type<typeof ResolvedNodeInput>

/**
 * A resolved workflow-output target.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedWorkflowOutput = Schema.Struct({
  kind: Schema.Literal("WorkflowOutput"),
  port: Wire.AtomicIdentifier,
  contract: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowCompilerV2ResolvedWorkflowOutput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolvedWorkflowOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedWorkflowOutput = Schema.Schema.Type<
  typeof ResolvedWorkflowOutput
>

/**
 * A resolved data-edge source.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedSourceEndpoint = Schema.Union([
  ResolvedWorkflowInput,
  ResolvedNodeOutput
]).annotate({ identifier: "WorkflowCompilerV2ResolvedSourceEndpoint" })

/**
 * The decoded type of {@link ResolvedSourceEndpoint}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedSourceEndpoint = Schema.Schema.Type<
  typeof ResolvedSourceEndpoint
>

/**
 * A resolved data-edge target.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedTargetEndpoint = Schema.Union([
  ResolvedNodeInput,
  ResolvedWorkflowOutput
]).annotate({ identifier: "WorkflowCompilerV2ResolvedTargetEndpoint" })

/**
 * The decoded type of {@link ResolvedTargetEndpoint}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedTargetEndpoint = Schema.Schema.Type<
  typeof ResolvedTargetEndpoint
>

/**
 * A compiler-resolved data edge.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedDataEdge = Schema.Struct({
  id: Wire.AtomicIdentifier,
  source: ResolvedSourceEndpoint,
  target: ResolvedTargetEndpoint,
  order: Schema.optionalKey(NonNegativeInt)
}).annotate({
  identifier: "WorkflowCompilerV2ResolvedDataEdge",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolvedDataEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedDataEdge = Schema.Schema.Type<typeof ResolvedDataEdge>

/**
 * A resolved static-DAG control edge.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolvedControlEdge = SemanticControlEdge.annotate({
  identifier: "WorkflowCompilerV2ResolvedControlEdge"
})

/**
 * The decoded type of {@link ResolvedControlEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedControlEdge = Schema.Schema.Type<
  typeof ResolvedControlEdge
>

/**
 * One node in the resolved static-DAG program.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StaticDagNode = Schema.Struct({
  id: Wire.AtomicIdentifier,
  type: Wire.AtomicIdentifier,
  version: Wire.AtomicIdentifier,
  incomingEdgeIds: Schema.Array(Wire.AtomicIdentifier),
  outgoingEdgeIds: Schema.Array(Wire.AtomicIdentifier),
  dependencies: Schema.Array(Wire.AtomicIdentifier),
  dependents: Schema.Array(Wire.AtomicIdentifier)
}).annotate({
  identifier: "WorkflowCompilerV2StaticDagNode",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StaticDagNode}.
 *
 * @category models
 * @since 4.0.0
 */
export type StaticDagNode = Schema.Schema.Type<typeof StaticDagNode>

/**
 * Canonical compiler-resolved program for a static acyclic root graph.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StaticDag = Schema.Struct({
  _tag: Schema.Literal("StaticDag"),
  programVersion: Schema.Literal(StaticDagProgramVersion),
  nodes: Schema.Array(StaticDagNode),
  dataEdges: Schema.Array(ResolvedDataEdge),
  controlEdges: Schema.Array(ResolvedControlEdge),
  topologicalOrder: Schema.Array(Wire.AtomicIdentifier),
  stages: Schema.Array(Schema.Array(Wire.AtomicIdentifier))
}).annotate({
  identifier: "WorkflowCompilerV2StaticDag",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StaticDag}.
 *
 * @category models
 * @since 4.0.0
 */
export type StaticDag = Schema.Schema.Type<typeof StaticDag>

/**
 * Exact canonical JSON document committed by compiler semantic version `2`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FingerprintDocument = Schema.Struct({
  fingerprintVersion: Schema.Literal(FingerprintVersion),
  compilerSemanticVersion: Schema.Literal(CompilerSemanticVersion),
  semanticPlan: SemanticPlan,
  workflowInterface: WorkflowInterface,
  program: StaticDag
}).annotate({
  identifier: "WorkflowCompilerV2FingerprintDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FingerprintDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type FingerprintDocument = Schema.Schema.Type<
  typeof FingerprintDocument
>

/**
 * Stable validation codes for compiler-v2 fingerprint documents.
 *
 * @category constants
 * @since 4.0.0
 */
export const ValidationCodes = {
  InvalidJson: "InvalidJson",
  InvalidSchema: "InvalidSchema",
  NonCanonical: "NonCanonical",
  InvalidRelation: "InvalidRelation"
} as const

/**
 * A stable compiler-v2 document validation code.
 *
 * @category models
 * @since 4.0.0
 */
export type ValidationCode = typeof ValidationCodes[keyof typeof ValidationCodes]

const ValidationCode = Schema.Literals([
  ValidationCodes.InvalidJson,
  ValidationCodes.InvalidSchema,
  ValidationCodes.NonCanonical,
  ValidationCodes.InvalidRelation
])

/**
 * Raised when an external compiler-v2 document is not strict, canonical, or
 * relationally valid.
 *
 * @category errors
 * @since 4.0.0
 */
export class FingerprintDocumentValidationError extends Schema.TaggedErrorClass<FingerprintDocumentValidationError>(
  "@effect/workflow-builder/CompilerV2/FingerprintDocumentValidationError"
)("FingerprintDocumentValidationError", {
  code: ValidationCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const decodeFingerprintDocument = Schema.decodeUnknownResult(
  FingerprintDocument,
  strictParseOptions
)

/**
 * A provenance-bearing compiler-v2 plan prepared in this process.
 *
 * **Details**
 *
 * The current executable {@link Compiler.CompiledPlan} remains available to
 * interpreters, while `fingerprintDocument` is the canonical portable meaning
 * intended for content hashing and durable pinning.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedPlan<
  out W extends Workflow.Any = Workflow.Any
> {
  readonly compiled: Compiler.CompiledPlan<W>
  readonly fingerprintDocument: FingerprintDocument
}

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const sortedStrings = (values: Iterable<string>): Array<string> => Array.from(values).sort(compareCodeUnits)

const sortedById = <A extends { readonly id: string }>(
  values: Iterable<A>
): Array<A> => Array.from(values).sort((left, right) => compareCodeUnits(left.id, right.id))

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)

const validationFailure = (
  code: ValidationCode,
  message: string,
  details?: Schema.Json
): Result.Result<never, FingerprintDocumentValidationError> =>
  Result.fail(
    new FingerprintDocumentValidationError({
      code,
      message,
      ...(details === undefined ? undefined : { details })
    })
  )

const isStrictlySortedBy = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string
): boolean => {
  for (let index = 1; index < values.length; index++) {
    if (compareCodeUnits(key(values[index - 1]!), key(values[index]!)) >= 0) {
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

const insertDependency = (
  dependencies: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
  source: string,
  target: string
): boolean => {
  const targetDependencies = dependencies.get(target)
  const sourceDependents = dependents.get(source)
  if (targetDependencies === undefined || sourceDependents === undefined) {
    return false
  }
  targetDependencies.add(source)
  sourceDependents.add(target)
  return true
}

interface CanonicalTopology {
  readonly topologicalOrder: ReadonlyArray<string>
  readonly stages: ReadonlyArray<ReadonlyArray<string>>
}

const canonicalTopology = (
  nodeIds: ReadonlyArray<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  dependents: ReadonlyMap<string, ReadonlySet<string>>
): CanonicalTopology | undefined => {
  const remaining = new Map<string, number>()
  for (const nodeId of nodeIds) {
    remaining.set(nodeId, dependencies.get(nodeId)?.size ?? 0)
  }
  const ready = nodeIds.filter((nodeId) => remaining.get(nodeId) === 0)
  ready.sort(compareCodeUnits)
  const topologicalOrder: Array<string> = []

  while (ready.length > 0) {
    const nodeId = ready.shift()!
    topologicalOrder.push(nodeId)
    const next = sortedStrings(dependents.get(nodeId) ?? [])
    for (const dependent of next) {
      const count = remaining.get(dependent)
      if (count === undefined || count <= 0) {
        return undefined
      }
      const updated = count - 1
      remaining.set(dependent, updated)
      if (updated === 0) {
        ready.push(dependent)
        ready.sort(compareCodeUnits)
      }
    }
  }
  if (topologicalOrder.length !== nodeIds.length) {
    return undefined
  }

  const depths = new Map<string, number>()
  let maximumDepth = -1
  for (const nodeId of topologicalOrder) {
    let depth = 0
    for (const dependency of dependencies.get(nodeId) ?? []) {
      const dependencyDepth = depths.get(dependency)
      if (dependencyDepth === undefined) {
        return undefined
      }
      depth = Math.max(depth, dependencyDepth + 1)
    }
    depths.set(nodeId, depth)
    maximumDepth = Math.max(maximumDepth, depth)
  }
  const stages: Array<Array<string>> = Array.from(
    { length: maximumDepth + 1 },
    () => []
  )
  for (const nodeId of topologicalOrder) {
    stages[depths.get(nodeId)!]!.push(nodeId)
  }
  for (const stage of stages) {
    stage.sort(compareCodeUnits)
  }
  return {
    topologicalOrder,
    stages
  }
}

const semanticSourceMatches = (
  semantic: Plan.SourceEndpoint,
  resolved: ResolvedSourceEndpoint,
  nodes: ReadonlyMap<string, SemanticPlanNode>,
  workflowInputs: ReadonlyMap<string, WorkflowInterfaceInput>
): boolean => {
  if (semantic._tag === "WorkflowInput") {
    return resolved.kind === "WorkflowInput" &&
      resolved.port === semantic.input &&
      workflowInputs.get(semantic.input)?.contract === resolved.contract
  }
  const node = nodes.get(semantic.nodeId)
  return node !== undefined &&
    resolved.kind === "NodeOutput" &&
    resolved.nodeId === semantic.nodeId &&
    resolved.port === semantic.output &&
    resolved.nodeType === node.type &&
    resolved.nodeVersion === node.version
}

const semanticTargetMatches = (
  semantic: Plan.TargetEndpoint,
  resolved: ResolvedTargetEndpoint,
  nodes: ReadonlyMap<string, SemanticPlanNode>,
  workflowOutputs: ReadonlyMap<string, WorkflowInterfaceOutput>
): boolean => {
  if (semantic._tag === "WorkflowOutput") {
    return resolved.kind === "WorkflowOutput" &&
      resolved.port === semantic.output &&
      workflowOutputs.get(semantic.output)?.contract === resolved.contract
  }
  const node = nodes.get(semantic.nodeId)
  return node !== undefined &&
    resolved.kind === "NodeInput" &&
    resolved.nodeId === semantic.nodeId &&
    resolved.port === semantic.input &&
    resolved.nodeType === node.type &&
    resolved.nodeVersion === node.version
}

const validateCanonicalOrdering = (
  document: FingerprintDocument
): Result.Result<void, FingerprintDocumentValidationError> => {
  const keyedArrays: ReadonlyArray<
    readonly [string, ReadonlyArray<{ readonly id: string }>]
  > = [
    ["semanticPlan.nodes", document.semanticPlan.nodes],
    ["semanticPlan.dataEdges", document.semanticPlan.dataEdges],
    ["semanticPlan.controlEdges", document.semanticPlan.controlEdges],
    ["program.nodes", document.program.nodes],
    ["program.dataEdges", document.program.dataEdges],
    ["program.controlEdges", document.program.controlEdges]
  ]
  for (const [path, values] of keyedArrays) {
    if (!isStrictlySortedBy(values, (value) => value.id)) {
      return validationFailure(
        ValidationCodes.NonCanonical,
        `${path} must be strictly code-unit sorted by id`,
        { path }
      )
    }
  }
  if (
    !isStrictlySortedBy(document.workflowInterface.inputs, (value) => value.name)
  ) {
    return validationFailure(
      ValidationCodes.NonCanonical,
      "workflowInterface.inputs must be strictly code-unit sorted by name"
    )
  }
  if (
    !isStrictlySortedBy(document.workflowInterface.outputs, (value) => value.name)
  ) {
    return validationFailure(
      ValidationCodes.NonCanonical,
      "workflowInterface.outputs must be strictly code-unit sorted by name"
    )
  }
  for (const node of document.program.nodes) {
    const arrays: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["incomingEdgeIds", node.incomingEdgeIds],
      ["outgoingEdgeIds", node.outgoingEdgeIds],
      ["dependencies", node.dependencies],
      ["dependents", node.dependents]
    ]
    for (const [field, values] of arrays) {
      if (!isStrictlySortedBy(values, (value) => value)) {
        return validationFailure(
          ValidationCodes.NonCanonical,
          `program node '${node.id}' ${field} must be strictly code-unit sorted`,
          { nodeId: node.id, field }
        )
      }
    }
  }
  for (let index = 0; index < document.program.stages.length; index++) {
    if (
      !isStrictlySortedBy(
        document.program.stages[index]!,
        (value) => value
      )
    ) {
      return validationFailure(
        ValidationCodes.NonCanonical,
        `program stage ${index} must be strictly code-unit sorted`,
        { stage: index }
      )
    }
  }
  return Result.succeed(undefined)
}

const validateRelations = (
  document: FingerprintDocument
): Result.Result<void, FingerprintDocumentValidationError> => {
  const semanticNodes = new Map(
    document.semanticPlan.nodes.map((node) => [node.id, node] as const)
  )
  const programNodes = new Map(
    document.program.nodes.map((node) => [node.id, node] as const)
  )
  if (
    semanticNodes.size !== programNodes.size ||
    document.semanticPlan.nodes.some((node) => {
      const programNode = programNodes.get(node.id)
      return programNode === undefined ||
        programNode.type !== node.type ||
        programNode.version !== node.version
    })
  ) {
    return validationFailure(
      ValidationCodes.InvalidRelation,
      "Semantic and program nodes must have identical ids, types, and versions"
    )
  }

  const workflowInputs = new Map(
    document.workflowInterface.inputs.map((input) => [input.name, input] as const)
  )
  const workflowOutputs = new Map(
    document.workflowInterface.outputs.map((output) => [output.name, output] as const)
  )
  const semanticDataEdges = new Map(
    document.semanticPlan.dataEdges.map((edge) => [edge.id, edge] as const)
  )
  const programDataEdges = new Map(
    document.program.dataEdges.map((edge) => [edge.id, edge] as const)
  )
  const semanticControlEdges = new Map(
    document.semanticPlan.controlEdges.map((edge) => [edge.id, edge] as const)
  )
  const programControlEdges = new Map(
    document.program.controlEdges.map((edge) => [edge.id, edge] as const)
  )
  const semanticEdgeIds = new Set([
    ...semanticDataEdges.keys(),
    ...semanticControlEdges.keys()
  ])
  const programEdgeIds = new Set([
    ...programDataEdges.keys(),
    ...programControlEdges.keys()
  ])
  if (
    semanticEdgeIds.size !==
      document.semanticPlan.dataEdges.length +
        document.semanticPlan.controlEdges.length ||
    programEdgeIds.size !==
      document.program.dataEdges.length + document.program.controlEdges.length ||
    semanticEdgeIds.size !== programEdgeIds.size ||
    [...semanticEdgeIds].some((edgeId) => !programEdgeIds.has(edgeId))
  ) {
    return validationFailure(
      ValidationCodes.InvalidRelation,
      "Semantic and program edge identifiers must be unique and identical"
    )
  }

  for (const semantic of document.semanticPlan.dataEdges) {
    const resolved = programDataEdges.get(semantic.id)
    if (
      resolved === undefined ||
      hasOwn(semantic, "order") !== hasOwn(resolved, "order") ||
      semantic.order !== resolved.order ||
      !semanticSourceMatches(
        semantic.source,
        resolved.source,
        semanticNodes,
        workflowInputs
      ) ||
      !semanticTargetMatches(
        semantic.target,
        resolved.target,
        semanticNodes,
        workflowOutputs
      ) ||
      resolved.source.contract !== resolved.target.contract
    ) {
      return validationFailure(
        ValidationCodes.InvalidRelation,
        `Resolved data edge '${semantic.id}' does not match its semantic edge`,
        { edgeId: semantic.id }
      )
    }
  }
  for (const semantic of document.semanticPlan.controlEdges) {
    const resolved = programControlEdges.get(semantic.id)
    if (
      resolved === undefined ||
      semantic.sourceNodeId !== resolved.sourceNodeId ||
      semantic.targetNodeId !== resolved.targetNodeId
    ) {
      return validationFailure(
        ValidationCodes.InvalidRelation,
        `Resolved control edge '${semantic.id}' does not match its semantic edge`,
        { edgeId: semantic.id }
      )
    }
  }

  const dependencies = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const nodeId of semanticNodes.keys()) {
    dependencies.set(nodeId, new Set())
    dependents.set(nodeId, new Set())
    incoming.set(nodeId, new Set())
    outgoing.set(nodeId, new Set())
  }
  for (const edge of document.program.dataEdges) {
    if (edge.source.kind === "NodeOutput") {
      const sourceEdges = outgoing.get(edge.source.nodeId)
      if (sourceEdges === undefined) {
        return validationFailure(
          ValidationCodes.InvalidRelation,
          `Data edge '${edge.id}' has an unknown source node`,
          { edgeId: edge.id, nodeId: edge.source.nodeId }
        )
      }
      sourceEdges.add(edge.id)
    }
    if (edge.target.kind === "NodeInput") {
      const targetEdges = incoming.get(edge.target.nodeId)
      if (targetEdges === undefined) {
        return validationFailure(
          ValidationCodes.InvalidRelation,
          `Data edge '${edge.id}' has an unknown target node`,
          { edgeId: edge.id, nodeId: edge.target.nodeId }
        )
      }
      targetEdges.add(edge.id)
    }
    if (
      edge.source.kind === "NodeOutput" &&
      edge.target.kind === "NodeInput" &&
      !insertDependency(
        dependencies,
        dependents,
        edge.source.nodeId,
        edge.target.nodeId
      )
    ) {
      return validationFailure(
        ValidationCodes.InvalidRelation,
        `Data edge '${edge.id}' has an unknown dependency endpoint`,
        { edgeId: edge.id }
      )
    }
  }
  for (const edge of document.program.controlEdges) {
    if (
      !insertDependency(
        dependencies,
        dependents,
        edge.sourceNodeId,
        edge.targetNodeId
      )
    ) {
      return validationFailure(
        ValidationCodes.InvalidRelation,
        `Control edge '${edge.id}' has an unknown dependency endpoint`,
        { edgeId: edge.id }
      )
    }
  }

  for (const node of document.program.nodes) {
    if (
      !sameStrings(node.incomingEdgeIds, sortedStrings(incoming.get(node.id)!)) ||
      !sameStrings(node.outgoingEdgeIds, sortedStrings(outgoing.get(node.id)!)) ||
      !sameStrings(node.dependencies, sortedStrings(dependencies.get(node.id)!)) ||
      !sameStrings(node.dependents, sortedStrings(dependents.get(node.id)!))
    ) {
      return validationFailure(
        ValidationCodes.InvalidRelation,
        `Program node '${node.id}' adjacency does not match the resolved edges`,
        { nodeId: node.id }
      )
    }
  }

  const topology = canonicalTopology(
    sortedStrings(semanticNodes.keys()),
    dependencies,
    dependents
  )
  if (
    topology === undefined ||
    !sameStrings(
      document.program.topologicalOrder,
      topology.topologicalOrder
    ) ||
    document.program.stages.length !== topology.stages.length ||
    document.program.stages.some((stage, index) => !sameStrings(stage, topology.stages[index]!))
  ) {
    return validationFailure(
      ValidationCodes.InvalidRelation,
      "Program topology must equal the canonical code-unit Kahn schedule"
    )
  }
  return Result.succeed(undefined)
}

/**
 * Detaches and validates an unknown compiler-v2 fingerprint document.
 *
 * **Details**
 *
 * Descriptor-based JSON inspection runs before schema decoding, so accessors,
 * sparse arrays, cycles, unsupported values, and excess properties fail
 * closed. Validation also proves canonical ordering, exact semantic to
 * resolved-edge correspondence, adjacency, and the canonical Kahn schedule.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateFingerprintDocument = (
  input: unknown
): Result.Result<
  FingerprintDocument,
  FingerprintDocumentValidationError
> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return validationFailure(
      ValidationCodes.InvalidJson,
      `Fingerprint document must be strict JSON: ${snapshot.failure.message}`,
      {
        path: [...snapshot.failure.path],
        snapshotError: snapshot.failure.message
      }
    )
  }
  let decoded: ReturnType<typeof decodeFingerprintDocument>
  try {
    decoded = decodeFingerprintDocument(snapshot.success)
  } catch {
    return validationFailure(
      ValidationCodes.InvalidSchema,
      "Fingerprint document schema validation threw unexpectedly"
    )
  }
  if (Result.isFailure(decoded)) {
    return validationFailure(
      ValidationCodes.InvalidSchema,
      "Invalid compiler-v2 fingerprint document",
      { parseError: decoded.failure.message }
    )
  }

  const document = snapshot.success as unknown as FingerprintDocument
  try {
    const ordering = validateCanonicalOrdering(document)
    if (Result.isFailure(ordering)) {
      return Result.fail(ordering.failure)
    }
    const relations = validateRelations(document)
    if (Result.isFailure(relations)) {
      return Result.fail(relations.failure)
    }
  } catch {
    return validationFailure(
      ValidationCodes.InvalidRelation,
      "Fingerprint document relational validation threw unexpectedly"
    )
  }
  return Result.succeed(document)
}

const semanticPlan = (
  compiled: Compiler.CompiledPlan
): SemanticPlan => {
  const nodes = sortedById(compiled.plan.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    version: node.version,
    config: node.config
  })))
  const dataEdges: Array<SemanticDataEdge> = []
  const controlEdges: Array<SemanticControlEdge> = []
  for (const edge of compiled.plan.edges) {
    if (edge._tag === "DataEdge") {
      dataEdges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.order === undefined ? undefined : { order: edge.order })
      })
    } else {
      controlEdges.push({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId
      })
    }
  }
  dataEdges.sort((left, right) => compareCodeUnits(left.id, right.id))
  controlEdges.sort((left, right) => compareCodeUnits(left.id, right.id))
  return {
    formatVersion: compiled.plan.formatVersion,
    id: compiled.plan.id,
    revision: compiled.plan.revision,
    definition: compiled.plan.definition,
    nodes,
    dataEdges,
    controlEdges
  }
}

const workflowInterface = (
  compiled: Compiler.CompiledPlan
): WorkflowInterface => ({
  interfaceVersion: WorkflowInterfaceVersion,
  inputs: Object.keys(compiled.definition.inputs)
    .sort(compareCodeUnits)
    .map((name) => {
      const port = compiled.definition.inputs[name]!
      return {
        name,
        contract: port.contract,
        fanOut: port.fanOut
      }
    }),
  outputs: Object.keys(compiled.definition.outputs)
    .sort(compareCodeUnits)
    .map((name) => {
      const port = compiled.definition.outputs[name]!
      return {
        name,
        contract: port.contract,
        cardinality: port.cardinality,
        required: port.required
      }
    })
})

const resolvedSource = (
  source: Compiler.CompiledDataEdge["source"]
): ResolvedSourceEndpoint =>
  source.kind === "WorkflowInput"
    ? {
      kind: source.kind,
      port: source.port,
      contract: source.contract
    }
    : {
      kind: source.kind,
      nodeId: source.nodeId,
      nodeType: source.nodeType,
      nodeVersion: source.nodeVersion,
      port: source.port,
      contract: source.contract
    }

const resolvedTarget = (
  target: Compiler.CompiledDataEdge["target"]
): ResolvedTargetEndpoint =>
  target.kind === "WorkflowOutput"
    ? {
      kind: target.kind,
      port: target.port,
      contract: target.contract
    }
    : {
      kind: target.kind,
      nodeId: target.nodeId,
      nodeType: target.nodeType,
      nodeVersion: target.nodeVersion,
      port: target.port,
      contract: target.contract
    }

const staticDag = (
  compiled: Compiler.CompiledPlan
): StaticDag => {
  const dataEdges = sortedById(compiled.dataEdges.map((compiledEdge) => ({
    id: compiledEdge.edge.id,
    source: resolvedSource(compiledEdge.source),
    target: resolvedTarget(compiledEdge.target),
    ...(compiledEdge.edge.order === undefined
      ? undefined
      : { order: compiledEdge.edge.order })
  })))
  const controlEdges = sortedById(compiled.controlEdges.map(({ edge }) => ({
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId
  })))

  const dependencies = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  const nodeIds = sortedStrings(compiled.nodes.keys())
  for (const nodeId of nodeIds) {
    dependencies.set(nodeId, new Set())
    dependents.set(nodeId, new Set())
    incoming.set(nodeId, new Set())
    outgoing.set(nodeId, new Set())
  }
  for (const edge of dataEdges) {
    if (edge.source.kind === "NodeOutput") {
      outgoing.get(edge.source.nodeId)!.add(edge.id)
    }
    if (edge.target.kind === "NodeInput") {
      incoming.get(edge.target.nodeId)!.add(edge.id)
    }
    if (
      edge.source.kind === "NodeOutput" &&
      edge.target.kind === "NodeInput"
    ) {
      insertDependency(
        dependencies,
        dependents,
        edge.source.nodeId,
        edge.target.nodeId
      )
    }
  }
  for (const edge of controlEdges) {
    insertDependency(
      dependencies,
      dependents,
      edge.sourceNodeId,
      edge.targetNodeId
    )
  }
  const nodes: Array<StaticDagNode> = nodeIds.map((nodeId) => {
    const node = compiled.nodes.get(nodeId)!
    return {
      id: nodeId,
      type: node.node.type,
      version: node.node.version,
      incomingEdgeIds: sortedStrings(incoming.get(nodeId)!),
      outgoingEdgeIds: sortedStrings(outgoing.get(nodeId)!),
      dependencies: sortedStrings(dependencies.get(nodeId)!),
      dependents: sortedStrings(dependents.get(nodeId)!)
    }
  })
  const topology = canonicalTopology(nodeIds, dependencies, dependents)
  if (topology === undefined) {
    throw new TypeError(
      "Compiler returned a cyclic or internally inconsistent admitted graph"
    )
  }
  return {
    _tag: "StaticDag",
    programVersion: StaticDagProgramVersion,
    nodes,
    dataEdges,
    controlEdges,
    topologicalOrder: topology.topologicalOrder,
    stages: topology.stages
  }
}

/**
 * Materializes the exact canonical fingerprint document for an admitted plan.
 *
 * **Details**
 *
 * Only exact process-local values returned by {@link Compiler.compile} are
 * accepted. The result is descriptor-validated, detached, and recursively
 * frozen before it can be hashed or persisted.
 *
 * @category constructors
 * @since 4.0.0
 */
export const materialize = (
  compiled: Compiler.CompiledPlan
): FingerprintDocument => {
  if (!Compiler.isCompiled(compiled)) {
    throw new TypeError(
      "CompilerV2.materialize requires an exact admitted Compiler.CompiledPlan"
    )
  }
  const validated = validateFingerprintDocument({
    fingerprintVersion: FingerprintVersion,
    compilerSemanticVersion: CompilerSemanticVersion,
    semanticPlan: semanticPlan(compiled),
    workflowInterface: workflowInterface(compiled),
    program: staticDag(compiled)
  })
  if (Result.isFailure(validated)) {
    throw new TypeError(
      `CompilerV2 produced an invalid fingerprint document: ${validated.failure.message}`
    )
  }
  return validated.success
}

/**
 * Wraps an exact admitted plan with compiler-v2 canonical meaning.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = <W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>
): PreparedPlan<W> => {
  const prepared = Object.freeze({
    compiled,
    fingerprintDocument: materialize(compiled)
  })
  preparedPlans.add(prepared)
  return prepared
}

/**
 * Tests whether a value is an exact {@link PreparedPlan} produced in this
 * process.
 *
 * **Details**
 *
 * Structural copies, proxies, and caller-constructed values are rejected even
 * when their public fields happen to be equal.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPreparedPlan = (
  value: unknown
): value is PreparedPlan => typeof value === "object" && value !== null && preparedPlans.has(value)

/**
 * Compiles an unknown portable plan and prepares its canonical compiler-v2
 * representation.
 *
 * @category compiling
 * @since 4.0.0
 */
export const compile = Effect.fnUntraced(function*<
  W extends Workflow.Any
>(
  definition: W,
  input: unknown
): Effect.fn.Return<
  PreparedPlan<W>,
  Diagnostic.CompilationError | Workflow.PolicyError<W>,
  Compiler.Requirements<W>
> {
  const compiled = yield* Compiler.compile(definition, input)
  return prepare(compiled)
})
