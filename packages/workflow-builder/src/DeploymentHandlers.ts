/**
 * Exact handler implementations indexed by immutable deployment pins.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Deployment from "./Deployment.ts"
import * as Node from "./Node.ts"
import * as Registry from "./Registry.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const registries = new WeakSet<object>()

/**
 * One process-local handler registry installed under an immutable deployment.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerDeployment {
  readonly deploymentId: string
  readonly handlers: Registry.HandlerRegistry["Service"]
}

/**
 * Constructs one handler-deployment entry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const handlerDeployment = (
  deploymentId: string,
  handlers: Registry.HandlerRegistry["Service"]
): HandlerDeployment => Object.freeze({ deploymentId, handlers })

/**
 * Raised when handler-deployment configuration cannot be inspected safely or
 * does not match exact catalog provenance.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidDeploymentHandlers extends Schema.TaggedErrorClass<InvalidDeploymentHandlers>(
  "@effect/workflow-builder/DeploymentHandlers/InvalidDeploymentHandlers"
)("InvalidDeploymentHandlers", {
  message: Schema.NonEmptyString,
  index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  deploymentId: Schema.optionalKey(Schema.NonEmptyString),
  type: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.optionalKey(Schema.NonEmptyString)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when two entries provide the same exact deployed handler pin.
 *
 * @category errors
 * @since 4.0.0
 */
export class DuplicateDeploymentHandler extends Schema.TaggedErrorClass<DuplicateDeploymentHandler>(
  "@effect/workflow-builder/DeploymentHandlers/DuplicateDeploymentHandler"
)("DuplicateDeploymentHandler", {
  deploymentId: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Failures produced while building exact deployed handlers.
 *
 * @category errors
 * @since 4.0.0
 */
export type BuildError =
  | InvalidDeploymentHandlers
  | DuplicateDeploymentHandler
  | Deployment.DeploymentResolutionError

/**
 * Handler entry whose executable implementation is bound to one deployment.
 *
 * @category models
 * @since 4.0.0
 */
export interface DeployedHandlerEntry extends Registry.HandlerEntry {
  readonly deploymentId: string
  readonly registry: Registry.HandlerRegistry["Service"]
}

/**
 * Exact deployed handler lookup used by durable activity workers.
 *
 * @category services
 * @since 4.0.0
 */
export class DeploymentHandlerRegistry extends Context.Service<DeploymentHandlerRegistry, {
  readonly handlers: ReadonlyMap<string, DeployedHandlerEntry>
  readonly get: (
    deploymentId: string,
    type: string,
    version: string
  ) => DeployedHandlerEntry | undefined
}>()("@effect/workflow-builder/DeploymentHandlers") {}

/**
 * Tests whether a value is an exact deployed handler registry built here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDeploymentHandlerRegistry = (
  value: unknown
): value is DeploymentHandlerRegistry["Service"] => typeof value === "object" && value !== null && registries.has(value)

interface CapturedDeployment {
  readonly deploymentId: string
  readonly handlers: Registry.HandlerRegistry["Service"]
}

const invalid = (
  message: string,
  options: {
    readonly index?: number | undefined
    readonly deploymentId?: string | undefined
    readonly type?: string | undefined
    readonly version?: string | undefined
  } = {}
): InvalidDeploymentHandlers =>
  new InvalidDeploymentHandlers({
    message,
    ...(options.index === undefined ? undefined : { index: options.index }),
    ...(options.deploymentId === undefined ? undefined : { deploymentId: options.deploymentId }),
    ...(options.type === undefined ? undefined : { type: options.type }),
    ...(options.version === undefined ? undefined : { version: options.version })
  })

const capture = (
  input: unknown
): Effect.Effect<ReadonlyArray<CapturedDeployment>, InvalidDeploymentHandlers> =>
  Effect.try({
    try: () => {
      if (!Array.isArray(input)) {
        throw invalid("Handler deployments must be a dense array")
      }
      const arrayDescriptors = Object.getOwnPropertyDescriptors(input)
      const deployments: Array<CapturedDeployment> = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = arrayDescriptors[String(index)]
        if (
          descriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          throw invalid("Handler deployments must not contain accessors or sparse entries", { index })
        }
        const entry = descriptor.value
        if (typeof entry !== "object" || entry === null) {
          throw invalid("Handler deployment entries must be objects", { index })
        }
        const prototype = Object.getPrototypeOf(entry)
        const descriptors = Object.getOwnPropertyDescriptors(entry)
        const keys = Reflect.ownKeys(descriptors)
        const deploymentId = descriptors.deploymentId
        const handlers = descriptors.handlers
        if (
          prototype !== Object.prototype && prototype !== null ||
          keys.length !== 2 ||
          deploymentId === undefined ||
          handlers === undefined ||
          !Object.prototype.hasOwnProperty.call(deploymentId, "value") ||
          !Object.prototype.hasOwnProperty.call(handlers, "value") ||
          deploymentId.enumerable !== true ||
          handlers.enumerable !== true ||
          typeof deploymentId.value !== "string" ||
          deploymentId.value.length === 0 ||
          !Registry.isHandlerRegistry(handlers.value)
        ) {
          throw invalid(
            "Handler deployment entries must contain exactly a non-empty deploymentId and exact HandlerRegistry",
            { index }
          )
        }
        deployments.push(Object.freeze({
          deploymentId: deploymentId.value,
          handlers: handlers.value
        }))
      }
      return Object.freeze(deployments)
    },
    catch: (cause) =>
      cause instanceof InvalidDeploymentHandlers
        ? cause
        : invalid("Handler deployments could not be inspected safely")
  })

const key = (
  deploymentId: string,
  type: string,
  version: string
): string => JSON.stringify([deploymentId, type, version])

const readonlyMap = <K, V>(source: Map<K, V>): ReadonlyMap<K, V> => {
  let view: ReadonlyMap<K, V>
  view = Object.freeze({
    get size() {
      return source.size
    },
    get: (entryKey: K) => source.get(entryKey),
    has: (entryKey: K) => source.has(entryKey),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: V, entryKey: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      source.forEach((value, entryKey) => callback.call(thisArg, value, entryKey, view))
    },
    [Symbol.iterator]: () => source[Symbol.iterator]()
  })
  return view
}

/**
 * Builds an immutable deployed-handler registry against the exact definition
 * catalog.
 *
 * **Details**
 *
 * Both the source handler registry and every node definition retain process-
 * local provenance. Catalog resolution must return the same definition object;
 * matching only `type@version` is insufficient.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(
  input: ReadonlyArray<HandlerDeployment>
): Effect.fn.Return<
  DeploymentHandlerRegistry["Service"],
  BuildError,
  Deployment.DeploymentCatalog
> {
  const deployments = yield* capture(input)
  const catalog = yield* Deployment.DeploymentCatalog
  const handlers = new Map<string, DeployedHandlerEntry>()
  for (let index = 0; index < deployments.length; index++) {
    const deployment = deployments[index]!
    for (const entry of deployment.handlers.handlers.values()) {
      if (
        !Node.isDefinition(entry.definition) ||
        typeof entry.handler !== "function"
      ) {
        return yield* Effect.fail(invalid(
          "Handler registry contains an invalid entry",
          { index, deploymentId: deployment.deploymentId }
        ))
      }
      const resolved = yield* catalog.resolveHandlerDefinition({
        deploymentId: deployment.deploymentId,
        type: entry.definition.type,
        version: entry.definition.version
      })
      if (resolved !== entry.definition) {
        return yield* Effect.fail(invalid(
          "Handler deployment resolved to a different node definition object",
          {
            index,
            deploymentId: deployment.deploymentId,
            type: entry.definition.type,
            version: entry.definition.version
          }
        ))
      }
      const entryKey = key(
        deployment.deploymentId,
        entry.definition.type,
        entry.definition.version
      )
      if (handlers.has(entryKey)) {
        return yield* Effect.fail(
          new DuplicateDeploymentHandler({
            deploymentId: deployment.deploymentId,
            type: entry.definition.type,
            version: entry.definition.version
          })
        )
      }
      handlers.set(
        entryKey,
        Object.freeze({
          deploymentId: deployment.deploymentId,
          registry: deployment.handlers,
          definition: entry.definition,
          context: entry.context,
          handler: entry.handler
        })
      )
    }
  }
  const service = DeploymentHandlerRegistry.of(Object.freeze({
    handlers: readonlyMap(handlers),
    get: (deploymentId, type, version) => handlers.get(key(deploymentId, type, version))
  }))
  registries.add(service)
  return service
})

/**
 * Builds a layer containing exact deployed handlers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  deployments: ReadonlyArray<HandlerDeployment>
): Layer.Layer<DeploymentHandlerRegistry, BuildError, Deployment.DeploymentCatalog> =>
  Layer.effect(DeploymentHandlerRegistry, make(deployments))
