/**
 * Defines the application-owned vocabulary and admission limits for workflow
 * plans.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import { identity } from "effect/Function"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import type * as LinkPolicy from "./LinkPolicy.ts"
import type * as Port from "./Port.ts"
import type * as Registry from "./Registry.ts"

/**
 * Runtime marker for workflow definitions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "@effect/workflow-builder/Workflow"

/**
 * Type-level marker for workflow definitions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "@effect/workflow-builder/Workflow"

const definitions = new WeakSet<object>()

const register = <A extends object>(definition: A): A => {
  definitions.add(definition)
  return definition
}

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * Hard admission limits applied before a plan can execute.
 *
 * **Details**
 *
 * Limits are part of the workflow definition rather than engine-global magic,
 * so separate business workflows can make different and reviewable resource
 * choices.
 *
 * @category models
 * @since 4.0.0
 */
export class Limits extends Schema.Class<Limits>(
  "@effect/workflow-builder/Workflow/Limits"
)({
  maxNodes: PositiveInt,
  maxEdges: PositiveInt,
  maxFanIn: PositiveInt,
  maxFanOut: PositiveInt,
  maxDepth: PositiveInt
}) {}

/**
 * An immutable workflow vocabulary used to validate portable plans.
 *
 * **Details**
 *
 * Workflow inputs are source ports and workflow outputs are sink ports. Node
 * definitions are versioned independently, and every data edge must pass both
 * schema-contract compatibility and the explicit link policy.
 *
 * @category models
 * @since 4.0.0
 */
export interface Definition<
  out Id extends string,
  out Version extends string,
  out Inputs extends Port.Outputs,
  out Outputs extends Port.Inputs,
  out Nodes extends Registry.Any,
  out Policy extends LinkPolicy.LinkPolicy<any, any>
> extends Pipeable {
  readonly [TypeId]: {
    readonly _Id: Types.Covariant<Id>
    readonly _Version: Types.Covariant<Version>
    readonly _Inputs: Types.Covariant<Inputs>
    readonly _Outputs: Types.Covariant<Outputs>
    readonly _Nodes: Types.Covariant<Nodes>
    readonly _Policy: Types.Covariant<Policy>
  }
  readonly id: Id
  readonly version: Version
  readonly description?: string | undefined
  readonly inputs: Inputs
  readonly outputs: Outputs
  readonly contracts: Readonly<Record<string, Port.PayloadSchema>>
  readonly nodes: Nodes
  readonly linkPolicy: Policy
  readonly limits: Limits
  readonly annotations: Context.Context<never>

  /**
   * Adds an application annotation to this definition.
   */
  annotate<I, A>(key: Context.Key<I, A>, value: A): Definition<Id, Version, Inputs, Outputs, Nodes, Policy>

  /**
   * Merges application annotations into this definition.
   */
  annotateMerge<I>(annotations: Context.Context<I>): Definition<Id, Version, Inputs, Outputs, Nodes, Policy>
}

/**
 * Type-erased workflow definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export interface Any extends
  Definition<
    string,
    string,
    Port.Outputs,
    Port.Inputs,
    Registry.Any,
    LinkPolicy.LinkPolicy<any, any>
  >
{}

/**
 * Tests whether a value is an exact workflow definition produced by this
 * module.
 *
 * **Details**
 *
 * Structural copies, public-marker forgeries, and proxies are not admitted.
 * Durable deployment resolution uses this out-of-band provenance rather than
 * treating a public type marker as a trust boundary.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDefinition = (value: unknown): value is Any =>
  typeof value === "object" && value !== null && definitions.has(value)

/**
 * Extracts the node registry from a workflow definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Nodes<W> = W extends Definition<
  infer _Id,
  infer _Version,
  infer _Inputs,
  infer _Outputs,
  infer N,
  infer _Policy
> ? N
  : never

/**
 * Extracts the workflow-input port declarations.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Inputs<W> = W extends Definition<
  infer _Id,
  infer _Version,
  infer I,
  infer _Outputs,
  infer _Nodes,
  infer _Policy
> ? I
  : never

/**
 * Extracts the typed input object accepted by an execution.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputValues<W> = Inputs<W> extends Port.Outputs ? Port.OutputValues<Inputs<W>> : never

/**
 * Extracts the workflow-output sink declarations.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Outputs<W> = W extends Definition<
  infer _Id,
  infer _Version,
  infer _Inputs,
  infer O,
  infer _Nodes,
  infer _Policy
> ? O
  : never

/**
 * Extracts the typed output object returned by an execution.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputValues<W> = Outputs<W> extends Port.Inputs ? Port.InputValues<Outputs<W>> : never

/**
 * Extracts services required to encode workflow inputs.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputEncodingServices<W> = Inputs<W> extends Port.Outputs ? Port.OutputEncodingServices<Inputs<W>> : never

/**
 * Extracts services required to decode workflow outputs.
 *
 * **Details**
 *
 * These services are required both by the direct interpreter and by semantic
 * command boundaries that validate a successful run before committing it.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputDecodingServices<W> = Outputs<W> extends Port.Inputs ? Port.InputDecodingServices<Outputs<W>> : never

/**
 * Extracts an Effect link-policy failure from a workflow definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type PolicyError<W> = W extends Definition<
  infer _Id,
  infer _Version,
  infer _Inputs,
  infer _Outputs,
  infer _Nodes,
  LinkPolicy.LinkPolicy<infer E, infer _R>
> ? E
  : never

/**
 * Extracts Effect services required by a workflow link policy.
 *
 * @category utility types
 * @since 4.0.0
 */
export type PolicyRequirements<W> = W extends Definition<
  infer _Id,
  infer _Version,
  infer _Inputs,
  infer _Outputs,
  infer _Nodes,
  LinkPolicy.LinkPolicy<infer _E, infer R>
> ? R
  : never

const Proto = {
  [TypeId]: {
    _Id: identity,
    _Version: identity,
    _Inputs: identity,
    _Outputs: identity,
    _Nodes: identity,
    _Policy: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  },
  annotate<I, A>(this: Any, key: Context.Key<I, A>, value: A) {
    return register(Object.freeze(Object.assign(Object.create(Proto), this, {
      annotations: Context.add(this.annotations, key, value)
    })))
  },
  annotateMerge<I>(this: Any, annotations: Context.Context<I>) {
    return register(Object.freeze(Object.assign(Object.create(Proto), this, {
      annotations: Context.merge(this.annotations, annotations)
    })))
  }
}

/**
 * Creates an immutable workflow definition.
 *
 * **Details**
 *
 * No link or resource policy is selected implicitly: callers must supply both
 * the authorization policy and admission limits as visible application code.
 *
 * The boundary is decided per side. A side declared here — `inputs` or
 * `outputs` with at least one port — is **closed**: every plan compiled
 * against this definition shares that exact typed interface (code-first,
 * static workflows). A side omitted is **open**: each plan declares its own
 * named, contract-typed interface, and `contracts` maps contract names to
 * the schemas that validate those values (end-user-composed workflows).
 * Contracts absent from the catalog validate as arbitrary JSON.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  const Id extends string,
  const Version extends string,
  Nodes extends Registry.Any,
  Policy extends LinkPolicy.LinkPolicy<any, any>,
  Inputs extends Port.Outputs = {},
  Outputs extends Port.Inputs = {}
>(id: Id, options: {
  readonly version: Version
  readonly description?: string | undefined
  readonly inputs?: Inputs | undefined
  readonly outputs?: Outputs | undefined
  readonly contracts?: Readonly<Record<string, Port.PayloadSchema>> | undefined
  readonly nodes: Nodes
  readonly linkPolicy: Policy
  readonly limits: Limits
}): Definition<Id, Version, Inputs, Outputs, Nodes, Policy> =>
  register(Object.freeze(Object.assign(Object.create(Proto), {
    id,
    version: options.version,
    description: options.description,
    inputs: Object.freeze({ ...options.inputs }),
    outputs: Object.freeze({ ...options.outputs }),
    contracts: Object.freeze({ ...options.contracts }),
    nodes: options.nodes,
    linkPolicy: options.linkPolicy,
    limits: Object.freeze(new Limits({ ...options.limits })),
    annotations: Context.empty()
  })))
