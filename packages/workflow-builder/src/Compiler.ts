/**
 * Validates portable workflow plans and compiles them into immutable execution
 * graphs.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Graph from "effect/Graph"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"
import type * as LinkPolicy from "./LinkPolicy.ts"
import type * as Node from "./Node.ts"
import * as Plan from "./Plan.ts"
import type * as Port from "./Port.ts"
import type * as Registry from "./Registry.ts"
import type * as Workflow from "./Workflow.ts"

const compiledPlans = new WeakSet<object>()

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
  CycleDetected: "CycleDetected"
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
 * A validated control dependency.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledControlEdge {
  readonly edge: Plan.ControlEdge
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
 * @category models
 * @since 4.0.0
 */
export interface CompiledNode {
  readonly node: Plan.PlanNode
  readonly definition: Node.Any
  readonly incoming: ReadonlyArray<CompiledDataEdge>
  readonly outgoing: ReadonlyArray<CompiledDataEdge>
  readonly dependencies: ReadonlyArray<string>
  readonly dependents: ReadonlyArray<string>
}

/**
 * An admitted plan with resolved definitions, ports, configuration, and a
 * deterministic topological schedule.
 *
 * **Details**
 *
 * Each inner `stages` array can run concurrently. The array order is stable for
 * a given portable plan and does not depend on activity completion order.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledPlan<out W extends Workflow.Any = Workflow.Any> {
  readonly definition: W
  readonly plan: Plan.Plan
  readonly nodes: ReadonlyMap<string, CompiledNode>
  readonly dataEdges: ReadonlyArray<CompiledDataEdge>
  readonly controlEdges: ReadonlyArray<CompiledControlEdge>
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
  readonly incoming: Array<CompiledDataEdge>
  readonly outgoing: Array<CompiledDataEdge>
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
  const indices = new Map<string, Graph.NodeIndex>()
  const dependencyEdges: Array<readonly [string, string]> = []
  for (const node of mutableNodes.values()) {
    for (const dependent of node.dependents) {
      dependencyEdges.push([node.node.id, dependent])
    }
  }
  const graph = Graph.directed<string, string>((mutable) => {
    for (const node of mutableNodes.values()) {
      indices.set(node.node.id, Graph.addNode(mutable, node.node.id))
    }
    for (const [source, target] of dependencyEdges) {
      Graph.addEdge(mutable, indices.get(source)!, indices.get(target)!, `${source}->${target}`)
    }
  })
  if (!Graph.isAcyclic(graph)) {
    add(
      diagnostics,
      Codes.CycleDetected,
      "The root workflow graph contains a cycle; use an explicit structured loop node instead",
      ["edges"]
    )
    return { topologicalOrder: [], stages: [] }
  }

  const topologicalOrder = Array.from(Graph.values(Graph.topo(graph)))
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
  return {
    topologicalOrder: Object.freeze(topologicalOrder),
    stages: Object.freeze(stages.map((stage) => Object.freeze(stage)))
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
  const snapped = Json.snapshot(input)
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
      incoming: [],
      outgoing: [],
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
    }
  }

  const edgeIds = new Set<string>()
  const compiledDataEdges: Array<CompiledDataEdge> = []
  const compiledControlEdges: Array<CompiledControlEdge> = []
  const incoming = new Map<string, Array<readonly [CompiledDataEdge, number]>>()
  const outgoing = new Map<string, Array<readonly [CompiledDataEdge, number]>>()

  const resolveSource = (
    source: Plan.SourceEndpoint,
    edgeIndex: number
  ): ResolvedSource | undefined => {
    if (source._tag === "WorkflowInput") {
      const port = getOwn(definition.inputs, source.input)
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
    const port = getOwn(node.definition.outputs, source.output)
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
      const port = getOwn(definition.outputs, target.output)
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
      if (source !== undefined && target !== undefined) {
        source.dependents.add(target.node.id)
        target.dependencies.add(source.node.id)
        compiledControlEdges.push(Object.freeze({ edge }))
      }
      continue
    }

    const source = resolveSource(edge.source, index)
    const target = resolveTarget(edge.target, index)
    if (source === undefined || target === undefined) {
      continue
    }
    if (source.port.contract !== target.port.contract) {
      add(
        diagnostics,
        Codes.IncompatibleContract,
        `Cannot connect contract '${source.port.contract}' to '${target.port.contract}'`,
        ["edges", index],
        { edgeId: edge.id, source: source.port.contract, target: target.port.contract }
      )
      continue
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

  const validateTarget = (
    port: Port.Input.Any,
    key: string,
    label: string,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    missingCode: string
  ) => {
    const edges = incoming.get(key) ?? []
    if (port.required && edges.length === 0) {
      add(diagnostics, missingCode, `Required ${label} is not connected`, path, { target: label })
    }
    const allowed = port.cardinality === "one" ? 1 : definition.limits.maxFanIn
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
      validateTarget(
        port,
        storageKey("NodeInput", node.node.id, name),
        `input '${node.node.id}.${name}'`,
        ["nodes", node.index],
        Codes.MissingRequiredInput
      )
    }
  }
  for (const [name, port] of Object.entries(definition.outputs)) {
    validateTarget(
      port,
      storageKey("WorkflowOutput", name),
      `workflow output '${name}'`,
      ["edges"],
      Codes.MissingRequiredOutput
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
  for (const [name, port] of Object.entries(definition.inputs)) {
    validateSource(port, storageKey("WorkflowInput", name), `workflow input '${name}'`, ["edges"])
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
  for (const [nodeId, node] of mutableNodes) {
    node.incoming.sort((left, right) => {
      const leftPort = left.target.kind === "NodeInput" ? left.target.port : ""
      const rightPort = right.target.kind === "NodeInput" ? right.target.port : ""
      return leftPort.localeCompare(rightPort) || (left.edge.order ?? 0) - (right.edge.order ?? 0)
    })
    nodes.set(
      nodeId,
      Object.freeze({
        node: node.node,
        definition: node.definition,
        incoming: Object.freeze(node.incoming),
        outgoing: Object.freeze(node.outgoing),
        dependencies: Object.freeze(Array.from(node.dependencies)),
        dependents: Object.freeze(Array.from(node.dependents))
      })
    )
  }
  const compiled = Object.freeze({
    definition,
    plan,
    nodes: readonlyMap(nodes),
    dataEdges: Object.freeze(compiledDataEdges),
    controlEdges: Object.freeze(compiledControlEdges),
    topologicalOrder: topology.topologicalOrder,
    stages: topology.stages,
    warnings: Object.freeze(warnings)
  })
  compiledPlans.add(compiled)
  return compiled
})
