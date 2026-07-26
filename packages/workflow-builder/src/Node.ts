/**
 * Defines versioned workflow node kinds and their type-safe handler contract.
 *
 * A node definition contains only schemas and metadata. Implementations are
 * supplied separately so the same plan vocabulary can be interpreted by
 * different Effect layers and execution backends.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Plan from "./Plan.ts"
import type * as Policy from "./Policy.ts"
import type * as Port from "./Port.ts"

/**
 * Runtime marker for node definitions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "@effect/workflow-builder/Node"

/**
 * Type-level marker for node definitions.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "@effect/workflow-builder/Node"

const definitions = new WeakSet<object>()

const register = <A extends object>(definition: A): A => {
  definitions.add(definition)
  return definition
}

/**
 * Empty node configuration schema.
 *
 * **Details**
 *
 * The compiler decodes configuration with excess-property errors enabled, so
 * this schema accepts only an empty object at a plan boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EmptyConfig = Schema.Struct({})

/**
 * Success outcomes declared by a node kind: a static list, or a function of
 * the node's decoded configuration for kinds whose routing vocabulary is
 * user-composed (a switch's cases, a human task's decisions).
 *
 * **Details**
 *
 * The reserved `error` outcome is never declared here; it exists exactly when
 * the definition declares a typed failure schema.
 *
 * @category models
 * @since 4.0.0
 */
export type Outcomes = ReadonlyArray<string> | ((config: never) => ReadonlyArray<string>)

/**
 * Everything a compensation handler receives about the completed work it
 * must undo: the node's decoded configuration, the inputs it ran with, the
 * outputs it produced, and the run context.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompensationRequest<N extends Any> {
  readonly config: Config<N>
  readonly inputs: InputValues<N>
  readonly outputs: OutputValues<N>
  readonly context: HandlerContext
}

/**
 * Marks a node kind as externally completed.
 *
 * **Details**
 *
 * An external node's handler is only the *registration* step: it receives a
 * decision token in its {@link HandlerContext} and hands it to the outside
 * world — a work-item store, an e-signature provider, a legacy worker queue,
 * an email gateway. The node's result is the durable decision later resolved
 * against that token, exposed through the reserved `decision` output port and
 * routed by its outcome.
 *
 * `deadline` derives an optional decision deadline in milliseconds from the
 * node's decoded configuration; when it yields a value, the engine schedules
 * an idempotent expiry that races completion first-wins, and the definition's
 * outcomes must include `expired`.
 *
 * @category models
 * @since 4.0.0
 */
export interface External {
  readonly deadline?: ((config: never) => number | undefined) | undefined
}

/**
 * A stable, versioned node kind that may be referenced by portable plans.
 *
 * @category models
 * @since 4.0.0
 */
export interface Definition<
  out Type extends string,
  out Version extends string,
  out Config extends Port.PayloadSchema,
  out Inputs extends Port.Inputs,
  out Outputs extends Port.Outputs,
  out Failure extends Port.PayloadSchema,
  out Requirements = never
> extends Pipeable {
  readonly [TypeId]: {
    readonly _Type: Types.Covariant<Type>
    readonly _Version: Types.Covariant<Version>
    readonly _Requirements: Types.Covariant<Requirements>
  }
  readonly id: `@effect/workflow-builder/Node/${Type}/${Version}`
  readonly type: Type
  readonly version: Version
  readonly description?: string | undefined
  readonly configSchema: Config
  readonly inputs: Inputs
  readonly outputs: Outputs
  readonly failureSchema: Failure
  readonly outcomes: Outcomes | undefined
  readonly external: External | undefined
  readonly compensation: ((request: never) => Effect.Effect<void, never, any>) | undefined
  readonly defaultPolicy: Policy.Policy | undefined
  readonly annotations: Context.Context<never>

  /**
   * Adds a service that must be provided for each execution request.
   */
  addDependency<I, S>(key: Context.Key<I, S>): Definition<
    Type,
    Version,
    Config,
    Inputs,
    Outputs,
    Failure,
    Requirements | I
  >

  /**
   * Adds an application annotation to this node definition.
   */
  annotate<I, A>(key: Context.Key<I, A>, value: A): Definition<
    Type,
    Version,
    Config,
    Inputs,
    Outputs,
    Failure,
    Requirements
  >

  /**
   * Merges application annotations into this node definition.
   */
  annotateMerge<I>(annotations: Context.Context<I>): Definition<
    Type,
    Version,
    Config,
    Inputs,
    Outputs,
    Failure,
    Requirements
  >
}

/**
 * Runtime identity, attempt, and idempotency information supplied to every node
 * handler.
 *
 * **Details**
 *
 * Stable node-instance and idempotency keys are distinct from array positions,
 * allowing a durable backend to replay a pinned plan without depending on UI
 * layout or iteration order. The default idempotency key is independent of
 * attempt identity; durable execution additionally scopes it by tenant so two
 * tenants may safely reuse a run identifier. `attempt` is the one-based
 * managed-retry attempt number for the current invocation: it is `1` on the
 * first try and increments on each policy-driven retry, so a handler can key
 * external idempotency by `idempotencyKey` while observing which attempt it
 * is running.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerContext {
  readonly scope: HandlerScope
  readonly runId: string
  readonly planId: string
  readonly planRevision: number
  readonly nodeId: string
  readonly nodeInstanceId: string
  readonly attempt: number
  readonly idempotencyKey: string
  /**
   * The opaque token that completes this node, present only for definitions
   * declaring {@link External} completion. The handler must deliver it to
   * whatever system will eventually decide the outcome.
   */
  readonly decisionToken?: string | undefined
}

/**
 * Explicit execution backend scope supplied to a node handler.
 *
 * **Details**
 *
 * Durable scope carries tenant and immutable handler-deployment identity. An
 * operational delivery epoch is intentionally absent so handler business
 * behavior and external idempotency cannot depend on redelivery ownership.
 *
 * @category models
 * @since 4.0.0
 */
export type HandlerScope =
  | {
    readonly _tag: "Direct"
  }
  | {
    readonly _tag: "Durable"
    readonly tenantId: string
    readonly handlerDeploymentId: string
  }

/**
 * Fully decoded request passed to a node implementation.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerRequest<N extends Any> {
  readonly config: Config<N>
  readonly inputs: InputValues<N>
  readonly context: HandlerContext
}

/**
 * Type-safe implementation of a node definition.
 *
 * @category models
 * @since 4.0.0
 */
export type Handler<N extends Any> = (
  request: HandlerRequest<N>
) => Effect.Effect<OutputValues<N>, Failure<N>, Requirements<N>>

/**
 * A type-erased node definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export interface Any extends
  Definition<
    string,
    string,
    Port.PayloadSchema,
    Port.Inputs,
    Port.Outputs,
    Port.PayloadSchema,
    any
  >
{}

/**
 * Tests whether a value is an exact node definition produced by this module.
 *
 * **Details**
 *
 * Public marker properties are useful for typing but are forgeable. Durable
 * deployment and handler boundaries use this out-of-band provenance guard so
 * structural copies, proxies, and caller-constructed prototypes are rejected.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDefinition = (value: unknown): value is Any =>
  typeof value === "object" && value !== null && definitions.has(value)

/**
 * Extracts a node definition's type identifier.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Type<N> = N extends Definition<
  infer T,
  infer _Version,
  infer _Config,
  infer _Inputs,
  infer _Outputs,
  infer _Failure,
  infer _Requirements
> ? T
  : never

/**
 * Extracts a node definition's version.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Version<N> = N extends Definition<
  infer _Type,
  infer V,
  infer _Config,
  infer _Inputs,
  infer _Outputs,
  infer _Failure,
  infer _Requirements
> ? V
  : never

/**
 * Extracts a node definition's decoded configuration.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Config<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer C,
  infer _Inputs,
  infer _Outputs,
  infer _Failure,
  infer _Requirements
> ? C["Type"]
  : never

/**
 * Extracts a node definition's configuration schema.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ConfigSchema<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer C,
  infer _Inputs,
  infer _Outputs,
  infer _Failure,
  infer _Requirements
> ? C
  : never

/**
 * Extracts services required to decode a node's portable configuration.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ConfigDecodingServices<N> = ConfigSchema<N> extends Port.PayloadSchema ? ConfigSchema<N>["DecodingServices"]
  : never

/**
 * Extracts a node definition's input declarations.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Inputs<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer _Config,
  infer I,
  infer _Outputs,
  infer _Failure,
  infer _Requirements
> ? I
  : never

/**
 * Extracts a node definition's decoded input object.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputValues<N> = Inputs<N> extends Port.Inputs ? Port.InputValues<Inputs<N>> : never

/**
 * Extracts a node definition's output declarations.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Outputs<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer _Config,
  infer _Inputs,
  infer O,
  infer _Failure,
  infer _Requirements
> ? O
  : never

/**
 * Extracts a node definition's decoded output object.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputValues<N> = Outputs<N> extends Port.Outputs ? Port.OutputValues<Outputs<N>> : never

/**
 * Extracts services required to decode all node inputs.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputDecodingServices<N> = Inputs<N> extends Port.Inputs ? Port.InputDecodingServices<Inputs<N>> : never

/**
 * Extracts services required to encode all node outputs.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputEncodingServices<N> = Outputs<N> extends Port.Outputs ? Port.OutputEncodingServices<Outputs<N>>
  : never

/**
 * Extracts services required to encode a node's typed failure.
 *
 * @category utility types
 * @since 4.0.0
 */
export type FailureEncodingServices<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer _Config,
  infer _Inputs,
  infer _Outputs,
  infer E,
  infer _Requirements
> ? E["EncodingServices"]
  : never

/**
 * Extracts a node definition's typed failure value.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Failure<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer _Config,
  infer _Inputs,
  infer _Outputs,
  infer E,
  infer _Requirements
> ? E["Type"]
  : never

/**
 * Extracts the request-level services required by a node handler.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<N> = N extends Definition<
  infer _Type,
  infer _Version,
  infer _Config,
  infer _Inputs,
  infer _Outputs,
  infer _Failure,
  infer R
> ? R
  : never

/**
 * Returns the stable registry key for a node type and version.
 *
 * @category constructors
 * @since 4.0.0
 */
export const key = <const Type extends string, const Version extends string>(
  type: Type,
  version: Version
): `${Type}@${Version}` => `${type}@${version}`

const Proto = {
  [TypeId]: {
    _Type: identity,
    _Version: identity,
    _Requirements: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  },
  addDependency(this: Any) {
    return register(Object.freeze(Object.assign(Object.create(Proto), this)))
  },
  annotate<I, A>(this: Any, annotation: Context.Key<I, A>, value: A) {
    return register(Object.freeze(Object.assign(Object.create(Proto), this, {
      annotations: Context.add(this.annotations, annotation, value)
    })))
  },
  annotateMerge<I>(this: Any, annotations: Context.Context<I>) {
    return register(Object.freeze(Object.assign(Object.create(Proto), this, {
      annotations: Context.merge(this.annotations, annotations)
    })))
  }
}

/**
 * Creates a versioned node definition.
 *
 * **Details**
 *
 * The version is mandatory because running plans pin it for validation,
 * execution, recovery, and migration. Changing handler behavior incompatibly
 * therefore requires a new definition version rather than mutating a live
 * run's meaning.
 *
 * Configuration and failure codecs must declare a JSON-compatible encoded
 * representation, just like port payload codecs. This compile-time constraint
 * preserves each codec's concrete decoded and encoded types and its service
 * requirements. Compilation and execution still validate actual values because
 * a custom codec or type assertion can lie about its encoded representation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  const Type extends string,
  const Version extends string,
  Config extends Port.PayloadSchema = typeof EmptyConfig,
  const Inputs extends Port.Inputs = {},
  const Outputs extends Port.Outputs = {},
  Failure extends Port.PayloadSchema = typeof Schema.Never,
  Dependencies extends ReadonlyArray<Context.Key<any, any> | Context.Key<never, any>> = []
>(type: Type, options: {
  readonly version: Version
  readonly description?: string | undefined
  readonly config?: Config | undefined
  readonly inputs?: Inputs | undefined
  readonly outputs?: Outputs | undefined
  readonly failure?: Failure | undefined
  readonly outcomes?: ReadonlyArray<string> | ((config: Config["Type"]) => ReadonlyArray<string>) | undefined
  readonly external?:
    | boolean
    | { readonly deadline?: ((config: Config["Type"]) => number | undefined) | undefined }
    | undefined
  readonly compensation?:
    | ((request: {
      readonly config: Config["Type"]
      readonly inputs: Port.InputValues<Inputs>
      readonly outputs: Port.OutputValues<Outputs>
      readonly context: HandlerContext
    }) => Effect.Effect<void, never, Context.Service.Identifier<Dependencies[number]>>)
    | undefined
  readonly policy?: Policy.Policy | undefined
  readonly dependencies?: Dependencies | undefined
}): Definition<
  Type,
  Version,
  Config,
  Inputs,
  Outputs,
  Failure,
  Context.Service.Identifier<Dependencies[number]>
> =>
  register(Object.freeze(Object.assign(Object.create(Proto), {
    id: `@effect/workflow-builder/Node/${type}/${options.version}`,
    type,
    version: options.version,
    description: options.description,
    configSchema: options.config ?? EmptyConfig,
    inputs: Object.freeze({ ...options.inputs }),
    outputs: Object.freeze({ ...options.outputs }),
    failureSchema: options.failure ?? Schema.Never,
    outcomes: Array.isArray(options.outcomes) ? Object.freeze([...options.outcomes]) : options.outcomes,
    external: options.external === undefined || options.external === false
      ? undefined
      : Object.freeze(options.external === true ? {} : { ...options.external }),
    compensation: options.compensation,
    defaultPolicy: options.policy,
    annotations: Context.empty()
  }))) as any

/**
 * Tests whether a definition declares a typed business failure.
 *
 * **Details**

 * A node has the reserved `error` outcome exactly when this is `true`, so a
 * plan can route its failures instead of failing the run.
 *
 * @category outcomes
 * @since 4.0.0
 */
export const hasDeclaredFailure = (definition: Any): boolean => definition.failureSchema.ast._tag !== "Never"

/**
 * Resolves the success outcomes of a node for its decoded configuration.
 *
 * **Details**
 *
 * Without a declaration the only success outcome is the default `done`. The
 * reserved `error` outcome is excluded; it is implied by a declared failure
 * schema and resolved separately via {@link hasDeclaredFailure}.
 *
 * @category outcomes
 * @since 4.0.0
 */
export const outcomesFor = (definition: Any, config: unknown): ReadonlyArray<string> => {
  const declared = definition.outcomes
  if (declared === undefined) {
    return [Plan.DefaultOutcome]
  }
  return typeof declared === "function" ? declared(config as never) : declared
}
