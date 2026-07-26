/**
 * Collects node definitions and installs their implementations as an Effect
 * layer.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Types from "effect/Types"
import * as Builtins from "./Builtins.ts"
import type * as Node from "./Node.ts"

const handlerRegistries = new WeakSet<object>()

/**
 * Runtime marker for node registries.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "@effect/workflow-builder/Registry"

/**
 * Type-level marker for node registries.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "@effect/workflow-builder/Registry"

/**
 * Raised when two definitions claim the same node type and version.
 *
 * @category errors
 * @since 4.0.0
 */
export class DuplicateDefinitionError extends Schema.TaggedErrorClass<DuplicateDefinitionError>(
  "@effect/workflow-builder/Registry/DuplicateDefinitionError"
)("DuplicateDefinitionError", {
  type: Schema.String,
  version: Schema.String
}) {}

/**
 * Raised when a handler table does not contain an executable implementation
 * for every registered definition.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidHandlerError extends Schema.TaggedErrorClass<InvalidHandlerError>(
  "@effect/workflow-builder/Registry/InvalidHandlerError"
)("InvalidHandlerError", {
  key: Schema.String,
  type: Schema.String,
  version: Schema.String
}) {}

/**
 * Maps an array or union of definitions to their stable `type@version` keys.
 *
 * @category utility types
 * @since 4.0.0
 */
export type DefinitionsByKey<Definitions> = {
  readonly [
    N in Definitions extends ReadonlyArray<Node.Any> ? Definitions[number]
      : Definitions extends Node.Any ? Definitions
      : never as `${Node.Type<N>}@${Node.Version<N>}`
  ]: N
}

/**
 * A versioned collection of node kinds available to a workflow definition.
 *
 * @category models
 * @since 4.0.0
 */
export interface Registry<out Definitions extends Readonly<Record<string, Node.Any>>> extends Pipeable {
  readonly [TypeId]: {
    readonly _Definitions: Types.Covariant<Definitions>
  }
  readonly definitions: Definitions

  /**
   * Type-checks a complete handler record without changing it.
   */
  of(handlers: HandlersFrom<Definitions>): HandlersFrom<Definitions>

  /**
   * Builds the handler service used by workflow engines.
   */
  toHandlers<E = never, R = never>(
    build: HandlersFrom<Definitions> | Effect.Effect<HandlersFrom<Definitions>, E, R>
  ): Effect.Effect<HandlerRegistry["Service"], E | InvalidHandlerError, R>

  /**
   * Builds a layer containing this registry's node handlers.
   */
  toLayer<E = never, R = never>(
    build: HandlersFrom<Definitions> | Effect.Effect<HandlersFrom<Definitions>, E, R>
  ): Layer.Layer<HandlerRegistry, E | InvalidHandlerError, Exclude<R, Scope.Scope>>
}

/**
 * Type-erased node registry.
 *
 * @category utility types
 * @since 4.0.0
 */
export interface Any extends Registry<Readonly<Record<string, Node.Any>>> {}

/**
 * Extracts the definitions held by a registry.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Definitions<R> = R extends Registry<infer D> ? D : never

/**
 * Maps every registered definition to its required implementation.
 *
 * **Details**
 *
 * Definitions in the reserved `workflow/` namespace are engine-interpreted
 * built-ins and take no handler entry; every other definition requires one.
 *
 * @category utility types
 * @since 4.0.0
 */
export type HandlersFrom<Definitions extends Readonly<Record<string, Node.Any>>> =
  & {
    readonly [K in keyof Definitions as K extends `workflow/${string}` ? never : K]: Node.Handler<Definitions[K]>
  }
  & {
    readonly [K in keyof Definitions as K extends `workflow/${string}` ? K : never]?: Node.Handler<Definitions[K]>
  }

/**
 * Runtime handler entry, including the Effect context captured when its layer
 * was constructed.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerEntry {
  readonly definition: Node.Any
  readonly context: Context.Context<never>
  readonly handler: Node.Handler<Node.Any>
}

/**
 * Service containing the implementations for a node registry.
 *
 * **Details**
 *
 * Engines merge a handler's captured context with the per-execution context,
 * matching Effect's toolkit and workflow registration patterns.
 *
 * @category services
 * @since 4.0.0
 */
export class HandlerRegistry extends Context.Service<HandlerRegistry, {
  readonly handlers: ReadonlyMap<string, HandlerEntry>
  readonly get: (type: string, version: string) => HandlerEntry | undefined
}>()("@effect/workflow-builder/Registry/Handlers") {}

/**
 * Tests whether a value is an exact handler registry built by this module.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHandlerRegistry = (value: unknown): value is HandlerRegistry["Service"] =>
  typeof value === "object" && value !== null && handlerRegistries.has(value)

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

const Proto = {
  [TypeId]: {
    _Definitions: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  },
  of: identity,
  toHandlers(
    this: Any,
    build:
      | Readonly<Record<string, Node.Handler<Node.Any>>>
      | Effect.Effect<Readonly<Record<string, Node.Handler<Node.Any>>>, unknown, unknown>
  ) {
    return Effect.gen({ self: this }, function*() {
      const context = yield* Effect.context<never>()
      const implementations = Effect.isEffect(build) ? yield* build : build
      const handlers = new Map<string, HandlerEntry>()
      for (const [key, definition] of Object.entries(this.definitions)) {
        if (Builtins.kindOf(definition) !== undefined) {
          continue
        }
        const handler = Object.prototype.hasOwnProperty.call(implementations, key) ? implementations[key] : undefined
        if (typeof handler !== "function") {
          return yield* Effect.fail(
            new InvalidHandlerError({
              key,
              type: definition.type,
              version: definition.version
            })
          )
        }
        handlers.set(
          key,
          Object.freeze({
            definition,
            context,
            handler
          })
        )
      }
      const service = HandlerRegistry.of(Object.freeze({
        handlers: readonlyMap(handlers),
        get: (type, version) => {
          const entry = handlers.get(`${type}@${version}`)
          return entry?.definition.type === type && entry.definition.version === version ? entry : undefined
        }
      }))
      handlerRegistries.add(service)
      return service
    })
  },
  toLayer(
    this: Any,
    build:
      | Readonly<Record<string, Node.Handler<Node.Any>>>
      | Effect.Effect<Readonly<Record<string, Node.Handler<Node.Any>>>, unknown, unknown>
  ) {
    return Layer.effect(HandlerRegistry, this.toHandlers(build as any))
  }
}

const build = <Definitions extends ReadonlyArray<Node.Any>>(
  definitions: Definitions
): Result.Result<Registry<DefinitionsByKey<Definitions>>, DuplicateDefinitionError> => {
  const byKey: Record<string, Node.Any> = Object.create(null)
  for (const definition of definitions) {
    const definitionKey = `${definition.type}@${definition.version}`
    if (Object.prototype.hasOwnProperty.call(byKey, definitionKey)) {
      return Result.fail(
        new DuplicateDefinitionError({
          type: definition.type,
          version: definition.version
        })
      )
    }
    byKey[definitionKey] = definition
  }
  return Result.succeed(Object.freeze(Object.assign(Object.create(Proto), {
    definitions: Object.freeze(byKey)
  })) as Registry<DefinitionsByKey<Definitions>>)
}

/**
 * Creates a registry while retaining duplicate-definition failures as data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromIterable = <const Definitions extends ReadonlyArray<Node.Any>>(
  definitions: Definitions
): Result.Result<Registry<DefinitionsByKey<Definitions>>, DuplicateDefinitionError> => build(definitions)

/**
 * Creates a node registry.
 *
 * **Details**
 *
 * Duplicate `type@version` definitions are programmer configuration errors and
 * throw immediately. Use {@link fromIterable} when definitions are discovered
 * dynamically and duplicate failure must remain typed data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <const Definitions extends ReadonlyArray<Node.Any>>(
  ...definitions: Definitions
): Registry<DefinitionsByKey<Definitions>> => {
  const result = build(definitions)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}
