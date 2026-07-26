/**
 * Portable, JSON-compatible workflow plan schemas.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as Expression from "./Expression.ts"
import * as Policy from "./Policy.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The plan wire-format version accepted by this compiler generation.
 *
 * @category constants
 * @since 4.0.0
 */
export const FormatVersion = 2 as const

/**
 * The reserved outcome name carrying a node's typed business failure.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorOutcome = "error" as const

/**
 * The default completion outcome of every node kind.
 *
 * @category constants
 * @since 4.0.0
 */
export const DefaultOutcome = "done" as const

/**
 * Join semantics over a node's incoming edges.
 *
 * **Details**
 *
 * `all` waits until every incoming edge has settled and runs when at least one
 * control edge is live (or, without control edges, when data sources
 * completed); it propagates skipping when every incoming control edge is dead.
 * `any` runs as soon as one incoming control edge becomes live and never runs
 * more than once.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Join = Schema.Literals(["all", "any"])

/**
 * The decoded type of {@link Join}.
 *
 * @category models
 * @since 4.0.0
 */
export type Join = typeof Join.Type

/**
 * Identifies the immutable workflow definition used to compile a plan.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DefinitionReference = Schema.Struct({
  id: Schema.NonEmptyString,
  version: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDefinitionReference",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DefinitionReference}.
 *
 * @category models
 * @since 4.0.0
 */
export type DefinitionReference = Schema.Schema.Type<typeof DefinitionReference>

/**
 * A node in a portable workflow plan.
 *
 * **Details**
 *
 * The node implementation is selected by `type` and `version`, while `config`
 * and optional `metadata` remain arbitrary JSON so plans can cross process and
 * persistence boundaries without carrying executable values.
 *
 * `bindings` supply input ports directly from expressions — literals,
 * references to earlier node outputs, or reshaped values — as an alternative
 * to wiring a data edge. `policy` overrides the node definition's default
 * retry and timeout policy. `join` selects how incoming edges are awaited.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PlanNode = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  config: Schema.Json,
  bindings: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, Expression.Expression)),
  policy: Schema.optionalKey(Policy.Policy),
  join: Schema.optionalKey(Join),
  metadata: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowPlanNode",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link PlanNode}.
 *
 * @category models
 * @since 4.0.0
 */
export type PlanNode = Schema.Schema.Type<typeof PlanNode>

/**
 * A source endpoint that reads a named workflow input.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkflowInput = Schema.TaggedStruct("WorkflowInput", {
  input: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowInputEndpoint",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkflowInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkflowInput = Schema.Schema.Type<typeof WorkflowInput>

/**
 * A source endpoint that reads a named output from a node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeOutput = Schema.TaggedStruct("NodeOutput", {
  nodeId: Schema.NonEmptyString,
  output: Schema.NonEmptyString
}).annotate({
  identifier: "NodeOutputEndpoint",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeOutput = Schema.Schema.Type<typeof NodeOutput>

/**
 * A data-edge source, either a workflow input or a node output.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SourceEndpoint = Schema.Union([
  WorkflowInput,
  NodeOutput
]).annotate({ identifier: "SourceEndpoint" })

/**
 * The decoded type of {@link SourceEndpoint}.
 *
 * @category models
 * @since 4.0.0
 */
export type SourceEndpoint = Schema.Schema.Type<typeof SourceEndpoint>

/**
 * A target endpoint that writes a named input on a node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeInput = Schema.TaggedStruct("NodeInput", {
  nodeId: Schema.NonEmptyString,
  input: Schema.NonEmptyString
}).annotate({
  identifier: "NodeInputEndpoint",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeInput = Schema.Schema.Type<typeof NodeInput>

/**
 * A target endpoint that writes a named workflow output.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkflowOutput = Schema.TaggedStruct("WorkflowOutput", {
  output: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowOutputEndpoint",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkflowOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkflowOutput = Schema.Schema.Type<typeof WorkflowOutput>

/**
 * A data-edge target, either a node input or a workflow output.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TargetEndpoint = Schema.Union([
  NodeInput,
  WorkflowOutput
]).annotate({ identifier: "TargetEndpoint" })

/**
 * The decoded type of {@link TargetEndpoint}.
 *
 * @category models
 * @since 4.0.0
 */
export type TargetEndpoint = Schema.Schema.Type<typeof TargetEndpoint>

/**
 * A data dependency between workflow or node ports.
 *
 * **Details**
 *
 * `order` can make multiple edges targeting the same input deterministic.
 *
 * `transform` reshapes the source value before the target decodes it. The
 * transform expression is evaluated with the source value bound to the `value`
 * scope root, alongside the shared `input` and `nodes` roots. An edge with a
 * transform is exempt from contract equality: the runtime schema validation at
 * the target is its correctness boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataEdge = Schema.TaggedStruct("DataEdge", {
  id: Schema.NonEmptyString,
  source: SourceEndpoint,
  target: TargetEndpoint,
  transform: Schema.optionalKey(Expression.Expression),
  order: Schema.optionalKey(NonNegativeInt),
  metadata: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowDataEdge",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataEdge = Schema.Schema.Type<typeof DataEdge>

/**
 * An execution-order dependency from a node outcome to another node.
 *
 * **Details**
 *
 * `outcome` selects which completion outcome of the source node activates
 * this edge; absent means the default `done` outcome. An edge is *live* when
 * its source completed with exactly that outcome and *dead* when the source
 * settled any other way, which is what drives conditional routing and
 * dead-path propagation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ControlEdge = Schema.TaggedStruct("ControlEdge", {
  id: Schema.NonEmptyString,
  sourceNodeId: Schema.NonEmptyString,
  outcome: Schema.optionalKey(Schema.NonEmptyString),
  targetNodeId: Schema.NonEmptyString,
  metadata: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowControlEdge",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ControlEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type ControlEdge = Schema.Schema.Type<typeof ControlEdge>

/**
 * A data or control edge in a workflow plan.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PlanEdge = Schema.Union([
  DataEdge,
  ControlEdge
]).annotate({ identifier: "WorkflowPlanEdge" })

/**
 * The decoded type of {@link PlanEdge}.
 *
 * @category models
 * @since 4.0.0
 */
export type PlanEdge = Schema.Schema.Type<typeof PlanEdge>

/**
 * A versioned, portable workflow plan.
 *
 * **Details**
 *
 * `formatVersion` versions this wire format independently from node
 * implementation versions. `definition` pins the workflow vocabulary used to
 * compile the plan. `revision` is a non-negative integer suitable for optimistic
 * updates or immutable plan snapshots.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Plan = Schema.Struct({
  formatVersion: Schema.Literal(FormatVersion),
  id: Schema.NonEmptyString,
  revision: NonNegativeInt,
  definition: DefinitionReference,
  nodes: Schema.Array(PlanNode),
  edges: Schema.Array(PlanEdge),
  metadata: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowPlan",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Plan}.
 *
 * @category models
 * @since 4.0.0
 */
export type Plan = Schema.Schema.Type<typeof Plan>
