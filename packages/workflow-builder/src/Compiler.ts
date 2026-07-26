/**
 * Validates portable workflow plans and compiles them into immutable execution
 * graphs.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Builtins from "./Builtins.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Expression from "./Expression.ts"
import * as Json from "./internal/json.ts"
import type * as LinkPolicy from "./LinkPolicy.ts"
import * as Node from "./Node.ts"
import * as Plan from "./Plan.ts"
import * as Policy from "./Policy.ts"
import * as Port from "./Port.ts"
import type * as Registry from "./Registry.ts"
import type * as Workflow from "./Workflow.ts"

const compiledPlans = new WeakSet<object>()

/**
 * Maximum JSON nesting depth a plan document may reach at admission.
 *
 * **Details**
 *
 * Bounds the recursive schema decode and the depth of any single embedded
 * expression before {@link Expression.validate}'s own bound applies. Well
 * above any hand-authored or canvas-generated plan; far below a stack
 * overflow.
 *
 * @category constants
 * @since 4.0.0
 */
export const AdmissionMaxDepth = 256

/**
 * Stable built-in diagnostic codes emitted by the compiler.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidPlanSchema: "InvalidPlanSchema",
  DefinitionMismatch: "DefinitionMismatch",
  InvalidDefinition: "InvalidDefinition",
  LimitExceeded: "LimitExceeded",
  DuplicateNodeId: "DuplicateNodeId",
  DuplicateEdgeId: "DuplicateEdgeId",
  UnknownNodeDefinition: "UnknownNodeDefinition",
  InvalidNodeConfig: "InvalidNodeConfig",
  UnknownSourceNode: "UnknownSourceNode",
  UnknownTargetNode: "UnknownTargetNode",
  UnknownWorkflowInput: "UnknownWorkflowInput",
  UnknownWorkflowOutput: "UnknownWorkflowOutput",
  UnknownNodeInput: "UnknownNodeInput",
  UnknownNodeOutput: "UnknownNodeOutput",
  IncompatibleContract: "IncompatibleContract",
  UnauthorizedLink: "UnauthorizedLink",
  InputCardinalityExceeded: "InputCardinalityExceeded",
  OutputFanOutExceeded: "OutputFanOutExceeded",
  MissingRequiredInput: "MissingRequiredInput",
  MissingRequiredOutput: "MissingRequiredOutput",
  AmbiguousEdgeOrder: "AmbiguousEdgeOrder",
  CycleDetected: "CycleDetected",
  UnknownOutcome: "UnknownOutcome",
  InvalidOutcomes: "InvalidOutcomes",
  UnknownBindingInput: "UnknownBindingInput",
  ConflictingInputBinding: "ConflictingInputBinding",
  InvalidExpression: "InvalidExpression",
  DuplicateSignal: "DuplicateSignal",
  ReservedTypeNamespace: "ReservedTypeNamespace",
  InvalidJoin: "InvalidJoin",
  ClosedBoundary: "ClosedBoundary",
  DuplicateBoundaryPort: "DuplicateBoundaryPort"
} as const

/**
 * A resolved and authorized data edge.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledDataEdge {
  readonly edge: Plan.DataEdge
  readonly source: LinkPolicy.ResolvedSourceEndpoint
  readonly target: LinkPolicy.ResolvedTargetEndpoint
}

/**
 * A validated control dependency from a source node outcome to a target node.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledControlEdge {
  readonly edge: Plan.ControlEdge
  readonly sourceNodeId: string
  readonly outcome: string
  readonly targetNodeId: string
}

/**
 * A node whose definition and portable configuration have been validated.
 *
 * **Details**
 *
 * The immutable encoded configuration remains available as `node.config`.
 * Runtimes decode it afresh for each activity invocation so a handler cannot
 * mutate a cached decoded object and change later execution under the same plan
 * fingerprint.
 *
 * `outcomes` are the resolved success outcomes for this node's configuration;
 * `errorOutcome` is `true` when the definition declares a typed failure, which
 * makes the reserved `error` outcome routable. `policy` is the plan-authored
 * policy merged over the definition default. `dependencies` include data-edge
 * sources, control-edge sources, and nodes referenced by expressions.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledNode {
  readonly node: Plan.PlanNode
  readonly definition: Node.Any
  readonly builtin: Builtins.Builtin | undefined
  readonly outcomes: ReadonlyArray<string>
  readonly errorOutcome: boolean
  readonly join: Plan.Join
  readonly policy: Policy.Policy
  readonly bindings: ReadonlyMap<string, Expression.Expression>
  readonly incoming: ReadonlyArray<CompiledDataEdge>
  readonly outgoing: ReadonlyArray<CompiledDataEdge>
  readonly incomingControl: ReadonlyArray<CompiledControlEdge>
  readonly outgoingControl: ReadonlyArray<CompiledControlEdge>
  readonly dependencies: ReadonlyArray<string>
  readonly dependents: ReadonlyArray<string>
}

/**
 * A resolved workflow input port with its run-start requiredness.
 *
 * @category models
 * @since 4.0.0
 */
export interface BoundaryInputPort {
  readonly port: Port.Output.Any
  readonly required: boolean
}

/**
 * The run interface a compiled plan executes with.
 *
 * **Details**
 *
 * The boundary is resolved per side: from the definition's declared ports
 * when that side is closed, or from the plan's own declarations (with
 * schemas looked up in the definition's contract catalog) when it is open.
 * Downstream consumers — edge resolution, fingerprinting, and the engine —
 * read only this resolved form and never the raw declarations.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledBoundary {
  readonly inputs: ReadonlyMap<string, BoundaryInputPort>
  readonly outputs: ReadonlyMap<string, Port.Input.Any>
}

/**
 * An admitted plan with resolved definitions, ports, configuration, and a
 * deterministic topological schedule.
 *
 * **Details**
 *
 * Each inner `stages` array can run concurrently. The array order is stable for
 * a given portable plan and does not depend on activity completion order.
 * `signals` maps each declared external signal name to its waiting node.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledPlan<out W extends Workflow.Any = Workflow.Any> {
  readonly definition: W
  readonly plan: Plan.Plan
  readonly boundary: CompiledBoundary
  readonly nodes: ReadonlyMap<string, CompiledNode>
  readonly dataEdges: ReadonlyArray<CompiledDataEdge>
  readonly controlEdges: ReadonlyArray<CompiledControlEdge>
  readonly signals: ReadonlyMap<string, string>
  readonly topologicalOrder: ReadonlyArray<string>
  readonly stages: ReadonlyArray<ReadonlyArray<string>>
  readonly warnings: ReadonlyArray<Diagnostic.Diagnostic>
}

/**
 * Tests whether a value is the exact immutable plan object returned by
 * {@link compile} in this process.
 *
 * **Details**
 *
 * Structural copies and caller-constructed objects are not admitted. Durable
 * recovery must reconstruct a plan through the compiler and independently
 * verify its persisted fingerprint before using this in-process provenance.
 *
 * @category guards
 * @since 4.0.0
 */
export const isCompiled = (value: unknown): value is CompiledPlan =>
  typeof value === "object" && value !== null && compiledPlans.has(value)

type DefinitionsOf<W extends Workflow.Any> = Registry.Definitions<Workflow.Nodes<W>>
type NodeOf<W extends Workflow.Any> = DefinitionsOf<W>[keyof DefinitionsOf<W>]

/**
 * Services required to compile every configuration schema in a workflow
 * definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | Workflow.PolicyRequirements<W>
  | Node.ConfigDecodingServices<NodeOf<W>>

interface MutableCompiledNode {
  readonly index: number
  readonly node: Plan.PlanNode
  readonly definition: Node.Any
  readonly builtin: Builtins.Builtin | undefined
  config: unknown
  configValid: boolean
  outcomes: ReadonlyArray<string>
  errorOutcome: boolean
  readonly incoming: Array<CompiledDataEdge>
  readonly outgoing: Array<CompiledDataEdge>
  readonly incomingControl: Array<CompiledControlEdge>
  readonly outgoingControl: Array<CompiledControlEdge>
  readonly dependencies: Set<string>
  readonly dependents: Set<string>
}

interface ResolvedSource {
  readonly descriptor: LinkPolicy.ResolvedSourceEndpoint
  readonly port: Port.Output.Any
}

interface ResolvedTarget {
  readonly descriptor: LinkPolicy.ResolvedTargetEndpoint
  readonly port: Port.Input.Any
}

const readonlyMap = <K, V>(source: Map<K, V>): ReadonlyMap<K, V> => {
  let view: ReadonlyMap<K, V>
  view = Object.freeze({
    get size() {
      return source.size
    },
    get: (key: K) => source.get(key),
    has: (key: K) => source.has(key),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      source.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    [Symbol.iterator]: () => source[Symbol.iterator]()
  })
  return view
}

const add = (
  diagnostics: Array<Diagnostic.Diagnostic>,
  code: string,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): void => {
  diagnostics.push(Diagnostic.error(code, message, path, details))
}

const getOwn = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

const storageKey = (...segments: ReadonlyArray<string>): string => JSON.stringify(segments)

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const fail = (diagnostics: Array<Diagnostic.Diagnostic>): Effect.Effect<never, Diagnostic.CompilationError> =>
  Effect.fail(
    new Diagnostic.CompilationError({
      diagnostics: diagnostics as [Diagnostic.Diagnostic, ...Array<Diagnostic.Diagnostic>]
    })
  )

const validateDefinition = (
  definition: Workflow.Any,
  diagnostics: Array<Diagnostic.Diagnostic>
): void => {
  if (definition.id.length === 0 || definition.version.length === 0) {
    add(diagnostics, Codes.InvalidDefinition, "Workflow definition id and version must be non-empty", [])
  }
  const checkPorts = (
    ports: Port.Inputs | Port.Outputs,
    path: string
  ) => {
    for (const [name, port] of Object.entries(ports)) {
      if (name.length === 0 || port.contract.length === 0) {
        add(
          diagnostics,
          Codes.InvalidDefinition,
          `Workflow definition ${path} port names and contracts must be non-empty`,
          [],
          { port: name, contract: port.contract }
        )
      }
    }
  }
  checkPorts(definition.inputs, "input")
  checkPorts(definition.outputs, "output")
  for (const [definitionKey, node] of Object.entries(definition.nodes.definitions)) {
    if (node.type.length === 0 || node.version.length === 0 || definitionKey !== `${node.type}@${node.version}`) {
      add(
        diagnostics,
        Codes.InvalidDefinition,
        `Invalid node registry entry '${definitionKey}'`,
        [],
        { definitionKey, type: node.type, version: node.version }
      )
    }
    checkPorts(node.inputs, `node '${definitionKey}' input`)
    checkPorts(node.outputs, `node '${definitionKey}' output`)
    if (node.type.startsWith("workflow/") && Builtins.kindOf(node) === undefined) {
      add(
        diagnostics,
        Codes.ReservedTypeNamespace,
        `Node type '${node.type}' uses the reserved 'workflow/' namespace without being engine-interpreted`,
        [],
        { definitionKey, type: node.type }
      )
    }
    if (
      Node.hasDeclaredFailure(node) &&
      Object.prototype.hasOwnProperty.call(node.outputs, Plan.ErrorOutcome)
    ) {
      add(
        diagnostics,
        Codes.InvalidDefinition,
        `Node '${definitionKey}' declares an output named '${Plan.ErrorOutcome}', which is reserved for its typed failure`,
        [],
        { definitionKey }
      )
    }
    if (node.external !== undefined && Object.keys(node.outputs).length > 0) {
      add(
        diagnostics,
        Codes.InvalidDefinition,
        `External node '${definitionKey}' must not declare output ports; it exposes the reserved '${Plan.DecisionOutput}' output`,
        [],
        { definitionKey }
      )
    }
  }
}

const targetKey = (endpoint: LinkPolicy.ResolvedTargetEndpoint): string =>
  endpoint.kind === "NodeInput"
    ? storageKey("NodeInput", endpoint.nodeId, endpoint.port)
    : storageKey("WorkflowOutput", endpoint.port)

const sourceKey = (endpoint: LinkPolicy.ResolvedSourceEndpoint): string =>
  endpoint.kind === "NodeOutput"
    ? storageKey("NodeOutput", endpoint.nodeId, endpoint.port)
    : storageKey("WorkflowInput", endpoint.port)

const compileTopology = (
  definition: Workflow.Any,
  mutableNodes: ReadonlyMap<string, MutableCompiledNode>,
  diagnostics: Array<Diagnostic.Diagnostic>
): {
  readonly topologicalOrder: ReadonlyArray<string>
  readonly stages: ReadonlyArray<ReadonlyArray<string>>
} => {
  const nodeIds = Array.from(mutableNodes.keys()).sort(compareCodeUnits)
  const remainingDependencies = new Map<string, number>()
  for (const nodeId of nodeIds) {
    remainingDependencies.set(
      nodeId,
      mutableNodes.get(nodeId)!.dependencies.size
    )
  }
  const ready = nodeIds.filter((nodeId) => remainingDependencies.get(nodeId) === 0)
  const topologicalOrder: Array<string> = []
  while (ready.length > 0) {
    const nodeId = ready.shift()!
    topologicalOrder.push(nodeId)
    const dependents = Array.from(
      mutableNodes.get(nodeId)!.dependents
    ).sort(compareCodeUnits)
    for (const dependent of dependents) {
      const remaining = remainingDependencies.get(dependent)
      if (remaining === undefined || remaining <= 0) {
        continue
      }
      const next = remaining - 1
      remainingDependencies.set(dependent, next)
      if (next === 0) {
        ready.push(dependent)
        ready.sort(compareCodeUnits)
      }
    }
  }
  if (topologicalOrder.length !== nodeIds.length) {
    add(
      diagnostics,
      Codes.CycleDetected,
      "The root workflow graph contains a cycle; use an explicit structured loop node instead",
      ["edges"]
    )
    return { topologicalOrder: [], stages: [] }
  }

  const depths = new Map<string, number>()
  let maximumDepth = 0
  for (const nodeId of topologicalOrder) {
    const node = mutableNodes.get(nodeId)!
    let depth = 1
    for (const dependency of node.dependencies) {
      depth = Math.max(depth, (depths.get(dependency) ?? 0) + 1)
    }
    depths.set(nodeId, depth)
    maximumDepth = Math.max(maximumDepth, depth)
  }
  if (maximumDepth > definition.limits.maxDepth) {
    add(
      diagnostics,
      Codes.LimitExceeded,
      `Plan depth ${maximumDepth} exceeds limit ${definition.limits.maxDepth}`,
      ["edges"],
      { actual: maximumDepth, limit: definition.limits.maxDepth, resource: "depth" }
    )
  }
  const stages: Array<Array<string>> = Array.from({ length: maximumDepth }, () => [])
  for (const nodeId of topologicalOrder) {
    stages[depths.get(nodeId)! - 1]!.push(nodeId)
  }
  for (const stage of stages) {
    stage.sort(compareCodeUnits)
  }
  return {
    topologicalOrder: Object.freeze(topologicalOrder),
    stages: Object.freeze(stages.map((stage) => Object.freeze(stage)))
  }
}

interface ExpressionSite {
  readonly expression: Expression.Expression
  readonly path: ReadonlyArray<Diagnostic.PathSegment>
  readonly extraRoots: ReadonlyArray<string>
}

const builtinExpressionSites = (
  node: MutableCompiledNode
): ReadonlyArray<ExpressionSite> => {
  if (node.builtin === undefined || !node.configValid) {
    return []
  }
  const config = node.config as never
  const base: ReadonlyArray<Diagnostic.PathSegment> = ["nodes", node.index, "config"]
  switch (node.builtin) {
    case "if": {
      const { condition } = config as { condition: Expression.Expression }
      return [{ expression: condition, path: [...base, "condition"], extraRoots: [] }]
    }
    case "switch": {
      const { cases } = config as {
        cases: ReadonlyArray<{ name: string; condition: Expression.Expression }>
      }
      return cases.map((entry, index) => ({
        expression: entry.condition,
        path: [...base, "cases", index, "condition"],
        extraRoots: []
      }))
    }
    case "transform": {
      const { value } = config as { value: Expression.Expression }
      return [{ expression: value, path: [...base, "value"], extraRoots: [] }]
    }
    case "forEach": {
      const { input, items } = config as {
        items: Expression.Expression
        input?: Expression.Expression
      }
      const sites: Array<ExpressionSite> = [
        { expression: items, path: [...base, "items"], extraRoots: [] }
      ]
      if (input !== undefined) {
        sites.push({ expression: input, path: [...base, "input"], extraRoots: ["item", "index"] })
      }
      return sites
    }
    case "subWorkflow": {
      const { input } = config as { input?: Expression.Expression }
      return input === undefined ? [] : [{ expression: input, path: [...base, "input"], extraRoots: [] }]
    }
    case "humanTask": {
      const { assignee, candidateGroups, payload } = config as {
        payload?: Expression.Expression
        assignee?: Expression.Expression
        candidateGroups?: Expression.Expression
      }
      const sites: Array<ExpressionSite> = []
      if (payload !== undefined) {
        sites.push({ expression: payload, path: [...base, "payload"], extraRoots: [] })
      }
      if (assignee !== undefined) {
        sites.push({ expression: assignee, path: [...base, "assignee"], extraRoots: [] })
      }
      if (candidateGroups !== undefined) {
        sites.push({ expression: candidateGroups, path: [...base, "candidateGroups"], extraRoots: [] })
      }
      return sites
    }
    case "delay": {
      const { durationMillis } = config as { durationMillis: number | Expression.Expression }
      return typeof durationMillis === "number"
        ? []
        : [{ expression: durationMillis, path: [...base, "durationMillis"], extraRoots: [] }]
    }
    case "waitUntil": {
      const { atMillis } = config as { atMillis: number | Expression.Expression }
      return typeof atMillis === "number"
        ? []
        : [{ expression: atMillis, path: [...base, "atMillis"], extraRoots: [] }]
    }
    case "while": {
      const { condition, input } = config as {
        condition: Expression.Expression
        input?: Expression.Expression
      }
      const sites: Array<ExpressionSite> = [
        { expression: condition, path: [...base, "condition"], extraRoots: ["iteration", "previous"] }
      ]
      if (input !== undefined) {
        sites.push({ expression: input, path: [...base, "input"], extraRoots: ["iteration", "previous"] })
      }
      return sites
    }
    case "fail": {
      const { message } = config as { message?: string | Expression.Expression }
      return message === undefined || typeof message === "string"
        ? []
        : [{ expression: message, path: [...base, "message"], extraRoots: [] }]
    }
    case "receive":
      return []
  }
}

/**
 * Decodes and compiles an unknown portable plan against a workflow definition.
 *
 * **Details**
 *
 * Structural and semantic failures are accumulated into one
 * {@link Diagnostic.CompilationError}. An effectful link policy's own error is
 * kept distinct, so infrastructure or authorization-system failure cannot be
 * mistaken for a denied link.
 *
 * @category compiling
 * @since 4.0.0
 */
export const compile = Effect.fnUntraced(function*<W extends Workflow.Any>(
  definition: W,
  input: unknown
): Effect.fn.Return<
  CompiledPlan<W>,
  Diagnostic.CompilationError | Workflow.PolicyError<W>,
  Requirements<W>
> {
  // Bound admission BEFORE the recursive schema decode: the plan schema
  // recurses through suspended expression nodes, so an unbounded-depth JSON
  // document would overflow the stack as a defect rather than a diagnostic.
  // The snapshot's structural caps are the real admission gate; derive them
  // from the definition's own limits so a plan cannot exceed what the
  // application declared it will accept.
  const snapped = Json.snapshot(input, {
    maxDepth: AdmissionMaxDepth,
    maxContainers: Math.max(1024, (definition.limits.maxNodes + definition.limits.maxEdges) * 64),
    maxEntries: Math.max(16384, (definition.limits.maxNodes + definition.limits.maxEdges) * 512)
  })
  if (Result.isFailure(snapped)) {
    return yield* fail([
      Diagnostic.error(Codes.InvalidPlanSchema, snapped.failure.message, snapped.failure.path)
    ])
  }

  const decoded = yield* Effect.result(
    Schema.decodeUnknownEffect(Plan.Plan, {
      errors: "all",
      onExcessProperty: "error"
    })(snapped.success)
  )
  if (Result.isFailure(decoded)) {
    return yield* fail([
      Diagnostic.error(Codes.InvalidPlanSchema, decoded.failure.message, [])
    ])
  }

  // `Plan.Plan` has no transformations, so the validated strict-JSON snapshot
  // is also its decoded representation. Retaining the snapshot keeps the
  // admitted plan detached and recursively frozen without trusting caller
  // container methods or traversing accessors.
  const plan = snapped.success as Plan.Plan
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const warnings: Array<Diagnostic.Diagnostic> = []
  validateDefinition(definition, diagnostics)

  if (plan.definition.id !== definition.id || plan.definition.version !== definition.version) {
    add(
      diagnostics,
      Codes.DefinitionMismatch,
      `Plan targets '${plan.definition.id}@${plan.definition.version}' but compiler was given '${definition.id}@${definition.version}'`,
      ["definition"],
      {
        expected: { id: definition.id, version: definition.version },
        actual: plan.definition
      }
    )
  }
  if (plan.nodes.length > definition.limits.maxNodes) {
    add(
      diagnostics,
      Codes.LimitExceeded,
      `Plan has ${plan.nodes.length} nodes, exceeding limit ${definition.limits.maxNodes}`,
      ["nodes"],
      { actual: plan.nodes.length, limit: definition.limits.maxNodes, resource: "nodes" }
    )
  }
  if (plan.edges.length > definition.limits.maxEdges) {
    add(
      diagnostics,
      Codes.LimitExceeded,
      `Plan has ${plan.edges.length} edges, exceeding limit ${definition.limits.maxEdges}`,
      ["edges"],
      { actual: plan.edges.length, limit: definition.limits.maxEdges, resource: "edges" }
    )
  }
  if (
    plan.nodes.length > definition.limits.maxNodes ||
    plan.edges.length > definition.limits.maxEdges
  ) {
    return yield* fail(diagnostics)
  }

  // --------------------------------------------------------------------------
  // Boundary resolution (per side: definition-declared = closed, else open)
  // --------------------------------------------------------------------------

  const contractSchema = (contract: string): Port.PayloadSchema =>
    getOwn(definition.contracts, contract) ?? (Schema.Json as Port.PayloadSchema)

  const boundaryInputs = new Map<string, BoundaryInputPort>()
  const boundaryOutputs = new Map<string, Port.Input.Any>()

  const inputsClosed = Object.keys(definition.inputs).length > 0
  if (inputsClosed) {
    if (plan.inputs !== undefined) {
      add(
        diagnostics,
        Codes.ClosedBoundary,
        "The workflow definition declares its inputs in code; the plan cannot declare its own",
        ["inputs"]
      )
    }
    for (const name of Object.keys(definition.inputs).sort(compareCodeUnits)) {
      boundaryInputs.set(name, Object.freeze({ port: definition.inputs[name]!, required: true }))
    }
  } else if (plan.inputs !== undefined) {
    for (let index = 0; index < plan.inputs.length; index++) {
      const declared = plan.inputs[index]!
      if (boundaryInputs.has(declared.name)) {
        add(
          diagnostics,
          Codes.DuplicateBoundaryPort,
          `Duplicate workflow input '${declared.name}'`,
          ["inputs", index, "name"],
          { name: declared.name }
        )
        continue
      }
      boundaryInputs.set(
        declared.name,
        Object.freeze({
          port: Port.output(contractSchema(declared.contract), { contract: declared.contract }),
          required: declared.required ?? true
        })
      )
    }
  }

  const outputsClosed = Object.keys(definition.outputs).length > 0
  if (outputsClosed) {
    if (plan.outputs !== undefined) {
      add(
        diagnostics,
        Codes.ClosedBoundary,
        "The workflow definition declares its outputs in code; the plan cannot declare its own",
        ["outputs"]
      )
    }
    for (const name of Object.keys(definition.outputs).sort(compareCodeUnits)) {
      boundaryOutputs.set(name, definition.outputs[name]!)
    }
  } else if (plan.outputs !== undefined) {
    for (let index = 0; index < plan.outputs.length; index++) {
      const declared = plan.outputs[index]!
      if (boundaryOutputs.has(declared.name)) {
        add(
          diagnostics,
          Codes.DuplicateBoundaryPort,
          `Duplicate workflow output '${declared.name}'`,
          ["outputs", index, "name"],
          { name: declared.name }
        )
        continue
      }
      boundaryOutputs.set(
        declared.name,
        Port.input(contractSchema(declared.contract), { contract: declared.contract, required: false })
      )
    }
  }

  const mutableNodes = new Map<string, MutableCompiledNode>()
  const nodeIds = new Set<string>()
  for (let index = 0; index < plan.nodes.length; index++) {
    const node = plan.nodes[index]!
    if (nodeIds.has(node.id)) {
      add(
        diagnostics,
        Codes.DuplicateNodeId,
        `Duplicate node id '${node.id}'`,
        ["nodes", index, "id"],
        { nodeId: node.id }
      )
      continue
    }
    nodeIds.add(node.id)
    const candidate = getOwn(definition.nodes.definitions, `${node.type}@${node.version}`)
    const nodeDefinition = candidate?.type === node.type && candidate.version === node.version ? candidate : undefined
    if (nodeDefinition === undefined) {
      add(
        diagnostics,
        Codes.UnknownNodeDefinition,
        `Unknown node definition '${node.type}@${node.version}'`,
        ["nodes", index],
        { type: node.type, version: node.version }
      )
      continue
    }
    mutableNodes.set(node.id, {
      index,
      node,
      definition: nodeDefinition,
      builtin: Builtins.kindOf(nodeDefinition),
      config: undefined,
      configValid: false,
      outcomes: [Plan.DefaultOutcome],
      errorOutcome: Node.hasDeclaredFailure(nodeDefinition),
      incoming: [],
      outgoing: [],
      incomingControl: [],
      outgoingControl: [],
      dependencies: new Set(),
      dependents: new Set()
    })
  }

  for (const compiledNode of mutableNodes.values()) {
    const config = yield* Effect.result(
      Schema.decodeUnknownEffect(compiledNode.definition.configSchema, {
        errors: "all",
        onExcessProperty: "error"
      })(compiledNode.node.config)
    )
    if (Result.isFailure(config)) {
      add(
        diagnostics,
        Codes.InvalidNodeConfig,
        config.failure.message,
        ["nodes", compiledNode.index, "config"],
        { nodeId: compiledNode.node.id, type: compiledNode.node.type, version: compiledNode.node.version }
      )
      continue
    }
    compiledNode.config = config.success
    compiledNode.configValid = true

    const outcomes = Node.outcomesFor(compiledNode.definition, config.success)
    const seen = new Set<string>()
    let valid = true
    for (const outcome of outcomes) {
      if (typeof outcome !== "string" || outcome.length === 0) {
        add(
          diagnostics,
          Codes.InvalidOutcomes,
          `Node '${compiledNode.node.id}' resolved an empty outcome name`,
          ["nodes", compiledNode.index],
          { nodeId: compiledNode.node.id }
        )
        valid = false
        continue
      }
      if (outcome === Plan.ErrorOutcome) {
        add(
          diagnostics,
          Codes.InvalidOutcomes,
          `Node '${compiledNode.node.id}' declares the reserved outcome '${Plan.ErrorOutcome}'`,
          ["nodes", compiledNode.index],
          { nodeId: compiledNode.node.id }
        )
        valid = false
        continue
      }
      if (seen.has(outcome)) {
        add(
          diagnostics,
          Codes.InvalidOutcomes,
          `Node '${compiledNode.node.id}' declares the outcome '${outcome}' more than once`,
          ["nodes", compiledNode.index],
          { nodeId: compiledNode.node.id, outcome }
        )
        valid = false
        continue
      }
      seen.add(outcome)
    }
    if (valid) {
      compiledNode.outcomes = Object.freeze([...seen])
    }

    const deadline = compiledNode.definition.external?.deadline
    if (deadline !== undefined) {
      const millis = deadline(config.success as never)
      if (millis !== undefined && !compiledNode.outcomes.includes(Plan.ExpiredOutcome)) {
        add(
          diagnostics,
          Codes.InvalidOutcomes,
          `Node '${compiledNode.node.id}' derives a decision deadline but does not declare the '${Plan.ExpiredOutcome}' outcome`,
          ["nodes", compiledNode.index],
          { nodeId: compiledNode.node.id }
        )
      }
    }
  }

  // --------------------------------------------------------------------------
  // Expression reference validation and implicit dependencies
  // --------------------------------------------------------------------------

  const validateExpression = (
    site: ExpressionSite,
    owner: MutableCompiledNode | undefined
  ): void => {
    const bounds = Expression.validate(site.expression)
    if (Result.isFailure(bounds)) {
      add(diagnostics, Codes.InvalidExpression, bounds.failure.message, site.path)
      return
    }
    for (const reference of Expression.references(site.expression)) {
      const root = reference[0]
      if (typeof root !== "string") {
        add(
          diagnostics,
          Codes.InvalidExpression,
          "Expression references must start with a named scope root",
          site.path,
          { reference: [...reference] as unknown as Schema.Json }
        )
        continue
      }
      if (root === "input" || site.extraRoots.includes(root)) {
        continue
      }
      if (root !== "nodes") {
        add(
          diagnostics,
          Codes.InvalidExpression,
          `Unknown scope root '${root}'`,
          site.path,
          { reference: [...reference] as unknown as Schema.Json }
        )
        continue
      }
      const referencedId = reference[1]
      if (typeof referencedId !== "string") {
        add(
          diagnostics,
          Codes.InvalidExpression,
          "References through 'nodes' must name a node id",
          site.path,
          { reference: [...reference] as unknown as Schema.Json }
        )
        continue
      }
      const referenced = mutableNodes.get(referencedId)
      if (referenced === undefined) {
        add(
          diagnostics,
          Codes.InvalidExpression,
          `Expression references unknown node '${referencedId}'`,
          site.path,
          { reference: [...reference] as unknown as Schema.Json }
        )
        continue
      }
      if (owner !== undefined && referencedId === owner.node.id) {
        add(
          diagnostics,
          Codes.InvalidExpression,
          `Node '${owner.node.id}' cannot reference its own outputs`,
          site.path
        )
        continue
      }
      const portName = reference[2]
      if (portName !== undefined) {
        const portKey = typeof portName === "number" ? String(portName) : portName
        const isReservedPort = (portKey === Plan.ErrorOutcome && referenced.errorOutcome) ||
          (portKey === Plan.DecisionOutput && referenced.definition.external !== undefined)
        if (!isReservedPort && getOwn(referenced.definition.outputs, portKey) === undefined) {
          add(
            diagnostics,
            Codes.InvalidExpression,
            `Node '${referencedId}' has no output '${portKey}'`,
            site.path,
            { reference: [...reference] as unknown as Schema.Json }
          )
          continue
        }
      }
      if (owner !== undefined) {
        owner.dependencies.add(referencedId)
        referenced.dependents.add(owner.node.id)
      }
    }
  }

  for (const compiledNode of mutableNodes.values()) {
    const bindings = compiledNode.node.bindings
    if (bindings !== undefined) {
      for (const [portName, expression] of Object.entries(bindings)) {
        if (getOwn(compiledNode.definition.inputs, portName) === undefined) {
          add(
            diagnostics,
            Codes.UnknownBindingInput,
            `Node '${compiledNode.node.id}' has no input '${portName}' to bind`,
            ["nodes", compiledNode.index, "bindings", portName],
            { nodeId: compiledNode.node.id, input: portName }
          )
          continue
        }
        validateExpression({
          expression,
          path: ["nodes", compiledNode.index, "bindings", portName],
          extraRoots: []
        }, compiledNode)
      }
    }
    for (const site of builtinExpressionSites(compiledNode)) {
      validateExpression(site, compiledNode)
    }
  }

  // --------------------------------------------------------------------------
  // Signals
  // --------------------------------------------------------------------------

  const signals = new Map<string, string>()
  for (const compiledNode of mutableNodes.values()) {
    if (compiledNode.builtin !== "receive" || !compiledNode.configValid) {
      continue
    }
    const { signal } = compiledNode.config as { signal: string }
    const existing = signals.get(signal)
    if (existing !== undefined) {
      add(
        diagnostics,
        Codes.DuplicateSignal,
        `Signal '${signal}' is declared by both '${existing}' and '${compiledNode.node.id}'`,
        ["nodes", compiledNode.index, "config", "signal"],
        { signal, nodes: [existing, compiledNode.node.id] }
      )
      continue
    }
    signals.set(signal, compiledNode.node.id)
  }

  // --------------------------------------------------------------------------
  // Edges
  // --------------------------------------------------------------------------

  const edgeIds = new Set<string>()
  const compiledDataEdges: Array<CompiledDataEdge> = []
  const compiledControlEdges: Array<CompiledControlEdge> = []
  const incoming = new Map<string, Array<readonly [CompiledDataEdge, number]>>()
  const outgoing = new Map<string, Array<readonly [CompiledDataEdge, number]>>()

  const errorPorts = new Map<string, Port.Output.Any>()
  const errorPort = (node: MutableCompiledNode): Port.Output.Any => {
    const existing = errorPorts.get(node.node.id)
    if (existing !== undefined) {
      return existing
    }
    const port = Port.output(node.definition.failureSchema as Port.PayloadSchema, {
      contract: Port.AnyContract
    })
    errorPorts.set(node.node.id, port)
    return port
  }

  const decisionPort = Port.output(Schema.Json as Port.PayloadSchema, { contract: Port.AnyContract })

  const reservedOutput = (node: MutableCompiledNode, output: string): Port.Output.Any | undefined =>
    output === Plan.ErrorOutcome && node.errorOutcome
      ? errorPort(node)
      : output === Plan.DecisionOutput && node.definition.external !== undefined
      ? decisionPort
      : undefined

  const resolveSource = (
    source: Plan.SourceEndpoint,
    edgeIndex: number
  ): ResolvedSource | undefined => {
    if (source._tag === "WorkflowInput") {
      const port = boundaryInputs.get(source.input)?.port
      if (port === undefined) {
        add(
          diagnostics,
          Codes.UnknownWorkflowInput,
          `Unknown workflow input '${source.input}'`,
          ["edges", edgeIndex, "source", "input"],
          { input: source.input }
        )
        return undefined
      }
      return {
        port,
        descriptor: Object.freeze({ kind: "WorkflowInput", port: source.input, contract: port.contract })
      }
    }
    const node = mutableNodes.get(source.nodeId)
    if (node === undefined) {
      const exists = plan.nodes.some((candidate) => candidate.id === source.nodeId)
      if (!exists) {
        add(
          diagnostics,
          Codes.UnknownSourceNode,
          `Unknown source node '${source.nodeId}'`,
          ["edges", edgeIndex, "source", "nodeId"],
          { nodeId: source.nodeId }
        )
      }
      return undefined
    }
    const declared = getOwn(node.definition.outputs, source.output)
    const port = declared ?? reservedOutput(node, source.output)
    if (port === undefined) {
      add(
        diagnostics,
        Codes.UnknownNodeOutput,
        `Node '${source.nodeId}' has no output '${source.output}'`,
        ["edges", edgeIndex, "source", "output"],
        { nodeId: source.nodeId, output: source.output }
      )
      return undefined
    }
    return {
      port,
      descriptor: Object.freeze({
        kind: "NodeOutput",
        nodeId: source.nodeId,
        nodeType: node.node.type,
        nodeVersion: node.node.version,
        port: source.output,
        contract: port.contract
      })
    }
  }

  const resolveTarget = (
    target: Plan.TargetEndpoint,
    edgeIndex: number
  ): ResolvedTarget | undefined => {
    if (target._tag === "WorkflowOutput") {
      const port = boundaryOutputs.get(target.output)
      if (port === undefined) {
        add(
          diagnostics,
          Codes.UnknownWorkflowOutput,
          `Unknown workflow output '${target.output}'`,
          ["edges", edgeIndex, "target", "output"],
          { output: target.output }
        )
        return undefined
      }
      return {
        port,
        descriptor: Object.freeze({ kind: "WorkflowOutput", port: target.output, contract: port.contract })
      }
    }
    const node = mutableNodes.get(target.nodeId)
    if (node === undefined) {
      const exists = plan.nodes.some((candidate) => candidate.id === target.nodeId)
      if (!exists) {
        add(
          diagnostics,
          Codes.UnknownTargetNode,
          `Unknown target node '${target.nodeId}'`,
          ["edges", edgeIndex, "target", "nodeId"],
          { nodeId: target.nodeId }
        )
      }
      return undefined
    }
    const port = getOwn(node.definition.inputs, target.input)
    if (port === undefined) {
      add(
        diagnostics,
        Codes.UnknownNodeInput,
        `Node '${target.nodeId}' has no input '${target.input}'`,
        ["edges", edgeIndex, "target", "input"],
        { nodeId: target.nodeId, input: target.input }
      )
      return undefined
    }
    return {
      port,
      descriptor: Object.freeze({
        kind: "NodeInput",
        nodeId: target.nodeId,
        nodeType: node.node.type,
        nodeVersion: node.node.version,
        port: target.input,
        contract: port.contract
      })
    }
  }

  for (let index = 0; index < plan.edges.length; index++) {
    const edge = plan.edges[index]!
    if (edgeIds.has(edge.id)) {
      add(
        diagnostics,
        Codes.DuplicateEdgeId,
        `Duplicate edge id '${edge.id}'`,
        ["edges", index, "id"],
        { edgeId: edge.id }
      )
      continue
    }
    edgeIds.add(edge.id)
    if (edge._tag === "ControlEdge") {
      const source = mutableNodes.get(edge.sourceNodeId)
      const target = mutableNodes.get(edge.targetNodeId)
      if (source === undefined) {
        if (!plan.nodes.some((candidate) => candidate.id === edge.sourceNodeId)) {
          add(
            diagnostics,
            Codes.UnknownSourceNode,
            `Unknown control source node '${edge.sourceNodeId}'`,
            ["edges", index, "sourceNodeId"],
            { nodeId: edge.sourceNodeId }
          )
        }
      }
      if (target === undefined) {
        if (!plan.nodes.some((candidate) => candidate.id === edge.targetNodeId)) {
          add(
            diagnostics,
            Codes.UnknownTargetNode,
            `Unknown control target node '${edge.targetNodeId}'`,
            ["edges", index, "targetNodeId"],
            { nodeId: edge.targetNodeId }
          )
        }
      }
      if (source === undefined || target === undefined) {
        continue
      }
      const outcome = edge.outcome ?? Plan.DefaultOutcome
      const known = outcome === Plan.ErrorOutcome
        ? source.errorOutcome
        : source.outcomes.includes(outcome)
      if (source.configValid && !known) {
        add(
          diagnostics,
          Codes.UnknownOutcome,
          `Node '${edge.sourceNodeId}' has no outcome '${outcome}'`,
          ["edges", index, "outcome"],
          { nodeId: edge.sourceNodeId, outcome, available: [...source.outcomes] }
        )
        continue
      }
      const compiledEdge: CompiledControlEdge = Object.freeze({
        edge,
        sourceNodeId: edge.sourceNodeId,
        outcome,
        targetNodeId: edge.targetNodeId
      })
      source.outgoingControl.push(compiledEdge)
      target.incomingControl.push(compiledEdge)
      source.dependents.add(target.node.id)
      target.dependencies.add(source.node.id)
      compiledControlEdges.push(compiledEdge)
      continue
    }

    const source = resolveSource(edge.source, index)
    const target = resolveTarget(edge.target, index)
    if (source === undefined || target === undefined) {
      continue
    }
    const compatible = source.port.contract === target.port.contract ||
      source.port.contract === Port.AnyContract ||
      target.port.contract === Port.AnyContract ||
      edge.transform !== undefined
    if (!compatible) {
      add(
        diagnostics,
        Codes.IncompatibleContract,
        `Cannot connect contract '${source.port.contract}' to '${target.port.contract}' without a transform`,
        ["edges", index],
        { edgeId: edge.id, source: source.port.contract, target: target.port.contract }
      )
      continue
    }
    if (edge.transform !== undefined) {
      const owner = target.descriptor.kind === "NodeInput" ? mutableNodes.get(target.descriptor.nodeId) : undefined
      validateExpression({
        expression: edge.transform,
        path: ["edges", index, "transform"],
        extraRoots: ["value"]
      }, owner)
    }
    const allowed = yield* definition.linkPolicy.authorize({
      edgeId: edge.id,
      source: source.descriptor,
      target: target.descriptor
    })
    if (!allowed) {
      add(
        diagnostics,
        Codes.UnauthorizedLink,
        `Link '${edge.id}' is not authorized by the workflow definition`,
        ["edges", index],
        { edgeId: edge.id }
      )
      continue
    }
    const compiledEdge: CompiledDataEdge = Object.freeze({
      edge,
      source: source.descriptor,
      target: target.descriptor
    })
    compiledDataEdges.push(compiledEdge)
    const incomingKey = targetKey(target.descriptor)
    const outgoingKey = sourceKey(source.descriptor)
    const targetEdges = incoming.get(incomingKey) ?? []
    targetEdges.push([compiledEdge, index])
    incoming.set(incomingKey, targetEdges)
    const sourceEdges = outgoing.get(outgoingKey) ?? []
    sourceEdges.push([compiledEdge, index])
    outgoing.set(outgoingKey, sourceEdges)

    if (source.descriptor.kind === "NodeOutput") {
      mutableNodes.get(source.descriptor.nodeId)!.outgoing.push(compiledEdge)
    }
    if (target.descriptor.kind === "NodeInput") {
      mutableNodes.get(target.descriptor.nodeId)!.incoming.push(compiledEdge)
    }
    if (source.descriptor.kind === "NodeOutput" && target.descriptor.kind === "NodeInput") {
      const sourceNode = mutableNodes.get(source.descriptor.nodeId)!
      const targetNode = mutableNodes.get(target.descriptor.nodeId)!
      sourceNode.dependents.add(targetNode.node.id)
      targetNode.dependencies.add(sourceNode.node.id)
    }
  }

  // --------------------------------------------------------------------------
  // Joins, required inputs, cardinality, and fan-out
  // --------------------------------------------------------------------------

  for (const node of mutableNodes.values()) {
    const join = node.node.join ?? "all"
    if (join === "any" && node.incomingControl.length === 0) {
      add(
        diagnostics,
        Codes.InvalidJoin,
        `Node '${node.node.id}' declares join 'any' without incoming control edges`,
        ["nodes", node.index, "join"],
        { nodeId: node.node.id }
      )
    }
  }

  const validateTarget = (
    port: Port.Input.Any,
    key: string,
    label: string,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    missingCode: string,
    bound: boolean,
    allowedOverride?: number
  ) => {
    const edges = incoming.get(key) ?? []
    if (port.required && edges.length === 0 && !bound) {
      add(diagnostics, missingCode, `Required ${label} is not connected`, path, { target: label })
    }
    if (edges.length > 0 && bound) {
      add(
        diagnostics,
        Codes.ConflictingInputBinding,
        `${label} is supplied by both a binding and a data edge`,
        path,
        { target: label }
      )
    }
    const allowed = allowedOverride ?? (port.cardinality === "one" ? 1 : definition.limits.maxFanIn)
    if (edges.length > allowed) {
      add(
        diagnostics,
        Codes.InputCardinalityExceeded,
        `${label} has ${edges.length} incoming links, exceeding ${allowed}`,
        path,
        { actual: edges.length, limit: allowed, target: label }
      )
    }
    if (port.cardinality === "many" && edges.length > 1) {
      const orders = edges.map(([compiled]) => compiled.edge.order)
      const present = orders.filter((order): order is number => order !== undefined)
      if (present.length !== orders.length || new Set(present).size !== present.length) {
        add(
          diagnostics,
          Codes.AmbiguousEdgeOrder,
          `${label} requires a unique explicit order on every incoming link`,
          path,
          { target: label }
        )
      }
    }
  }

  for (const node of mutableNodes.values()) {
    for (const [name, port] of Object.entries(node.definition.inputs)) {
      const bound = node.node.bindings !== undefined &&
        Object.prototype.hasOwnProperty.call(node.node.bindings, name)
      validateTarget(
        port,
        storageKey("NodeInput", node.node.id, name),
        `input '${node.node.id}.${name}'`,
        ["nodes", node.index],
        Codes.MissingRequiredInput,
        bound
      )
    }
  }
  for (const [name, port] of boundaryOutputs) {
    // A plan-declared output may be fed from alternative branches; liveness
    // selects the value at runtime, so static fan-in is bounded only by the
    // definition limit.
    validateTarget(
      port,
      storageKey("WorkflowOutput", name),
      `workflow output '${name}'`,
      ["edges"],
      Codes.MissingRequiredOutput,
      false,
      outputsClosed && port.cardinality === "one" ? 1 : definition.limits.maxFanIn
    )
  }

  const validateSource = (
    port: Port.Output.Any,
    key: string,
    label: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ) => {
    const edges = outgoing.get(key) ?? []
    const allowed = port.fanOut === "single" ? 1 : definition.limits.maxFanOut
    if (edges.length > allowed) {
      add(
        diagnostics,
        Codes.OutputFanOutExceeded,
        `${label} has ${edges.length} outgoing links, exceeding ${allowed}`,
        path,
        { actual: edges.length, limit: allowed, source: label }
      )
    }
  }
  for (const [name, entry] of boundaryInputs) {
    validateSource(entry.port, storageKey("WorkflowInput", name), `workflow input '${name}'`, ["edges"])
  }
  for (const node of mutableNodes.values()) {
    for (const [name, port] of Object.entries(node.definition.outputs)) {
      validateSource(
        port,
        storageKey("NodeOutput", node.node.id, name),
        `output '${node.node.id}.${name}'`,
        ["nodes", node.index]
      )
    }
  }

  const topology = compileTopology(definition, mutableNodes, diagnostics)
  if (diagnostics.length > 0) {
    return yield* fail(diagnostics)
  }

  const nodes = new Map<string, CompiledNode>()
  const canonicalNodeIds = Array.from(mutableNodes.keys()).sort(compareCodeUnits)
  for (const nodeId of canonicalNodeIds) {
    const node = mutableNodes.get(nodeId)!
    node.incoming.sort((left, right) => {
      const leftPort = left.target.kind === "NodeInput" ? left.target.port : ""
      const rightPort = right.target.kind === "NodeInput" ? right.target.port : ""
      return compareCodeUnits(leftPort, rightPort) ||
        (left.edge.order ?? 0) - (right.edge.order ?? 0) ||
        compareCodeUnits(left.edge.id, right.edge.id)
    })
    node.outgoing.sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id))
    node.incomingControl.sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id))
    node.outgoingControl.sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id))
    const bindings = new Map<string, Expression.Expression>()
    if (node.node.bindings !== undefined) {
      for (const key of Object.keys(node.node.bindings).sort(compareCodeUnits)) {
        bindings.set(key, node.node.bindings[key]!)
      }
    }
    nodes.set(
      nodeId,
      Object.freeze({
        node: node.node,
        definition: node.definition,
        builtin: node.builtin,
        outcomes: node.outcomes,
        errorOutcome: node.errorOutcome,
        join: node.node.join ?? "all",
        policy: Object.freeze(Policy.merge(node.definition.defaultPolicy, node.node.policy)),
        bindings: readonlyMap(bindings),
        incoming: Object.freeze(node.incoming),
        outgoing: Object.freeze(node.outgoing),
        incomingControl: Object.freeze(node.incomingControl),
        outgoingControl: Object.freeze(node.outgoingControl),
        dependencies: Object.freeze(
          Array.from(node.dependencies).sort(compareCodeUnits)
        ),
        dependents: Object.freeze(
          Array.from(node.dependents).sort(compareCodeUnits)
        )
      })
    )
  }
  compiledDataEdges.sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id))
  compiledControlEdges.sort((left, right) => compareCodeUnits(left.edge.id, right.edge.id))
  const orderedSignals = new Map<string, string>()
  for (const signal of Array.from(signals.keys()).sort(compareCodeUnits)) {
    orderedSignals.set(signal, signals.get(signal)!)
  }
  const orderedBoundaryInputs = new Map<string, BoundaryInputPort>()
  for (const name of Array.from(boundaryInputs.keys()).sort(compareCodeUnits)) {
    orderedBoundaryInputs.set(name, boundaryInputs.get(name)!)
  }
  const orderedBoundaryOutputs = new Map<string, Port.Input.Any>()
  for (const name of Array.from(boundaryOutputs.keys()).sort(compareCodeUnits)) {
    orderedBoundaryOutputs.set(name, boundaryOutputs.get(name)!)
  }
  const compiled = Object.freeze({
    definition,
    plan,
    boundary: Object.freeze({
      inputs: readonlyMap(orderedBoundaryInputs),
      outputs: readonlyMap(orderedBoundaryOutputs)
    }),
    nodes: readonlyMap(nodes),
    dataEdges: Object.freeze(compiledDataEdges),
    controlEdges: Object.freeze(compiledControlEdges),
    signals: readonlyMap(orderedSignals),
    topologicalOrder: topology.topologicalOrder,
    stages: topology.stages,
    warnings: Object.freeze(warnings)
  })
  compiledPlans.add(compiled)
  return compiled
})
