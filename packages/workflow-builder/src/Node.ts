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
 * tenants may safely reuse a run identifier. `attempt` identifies the
 * invocation separately. Version `1` currently supplies only attempt `1`, while
 * preserving the identity boundary needed by a future command version with
 * retry semantics.
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
    annotations: Context.empty()
  }))) as any
