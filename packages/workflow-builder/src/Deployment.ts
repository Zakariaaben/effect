/**
 * Exact deployment-aware definition resolution for durable workflow recovery.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"
import * as Node from "./Node.ts"
import * as Workflow from "./Workflow.ts"

const namespace = "@effect/workflow-builder" as const
const keyVersion = 1 as const
const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * The kind of definition retained by a deployment catalog.
 *
 * @category models
 * @since 4.0.0
 */
export type DeploymentKind = "WorkflowDefinition" | "HandlerDefinition"

const DeploymentKind = Schema.Literals([
  "WorkflowDefinition",
  "HandlerDefinition"
])

/**
 * An exact workflow-definition deployment pin.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkflowDefinitionPin = Schema.Struct({
  deploymentId: Schema.NonEmptyString,
  definitionId: Schema.NonEmptyString,
  definitionVersion: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDefinitionDeploymentPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkflowDefinitionPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkflowDefinitionPin = Schema.Schema.Type<typeof WorkflowDefinitionPin>

/**
 * An exact node-handler deployment pin.
 *
 * **Details**
 *
 * `deploymentId` is independent of `type@version`. More than one immutable
 * deployment may therefore retain a definition with the same portable node
 * identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const HandlerDefinitionPin = Schema.Struct({
  deploymentId: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString
}).annotate({
  identifier: "HandlerDefinitionDeploymentPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link HandlerDefinitionPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type HandlerDefinitionPin = Schema.Schema.Type<typeof HandlerDefinitionPin>

/**
 * Raised when catalog configuration or a resolution request is not a safe,
 * strict deployment value.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidDeployment extends Schema.TaggedErrorClass<InvalidDeployment>(
  "@effect/workflow-builder/Deployment/InvalidDeployment"
)("InvalidDeployment", {
  operation: Schema.Literals([
    "build",
    "resolveWorkflowDefinition",
    "resolveHandlerDefinition"
  ]),
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when one catalog declares the same immutable deployment binding twice.
 *
 * **Details**
 *
 * Workflow definitions are unique by deployment identifier. Handler definitions
 * are unique by the exact `(deploymentId, type, version)` tuple because one
 * handler deployment may contain multiple node definitions.
 *
 * @category errors
 * @since 4.0.0
 */
export class DuplicateDeploymentId extends Schema.TaggedErrorClass<DuplicateDeploymentId>(
  "@effect/workflow-builder/Deployment/DuplicateDeploymentId"
)("DuplicateDeploymentId", {
  kind: DeploymentKind,
  deploymentId: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.optionalKey(Schema.NonEmptyString)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when one immutable deployment binding is assigned conflicting object
 * provenance. For handlers, the binding is the exact deployment/type/version
 * tuple rather than the deployment identifier alone.
 *
 * @category errors
 * @since 4.0.0
 */
export class DeploymentIdConflict extends Schema.TaggedErrorClass<DeploymentIdConflict>(
  "@effect/workflow-builder/Deployment/DeploymentIdConflict"
)("DeploymentIdConflict", {
  kind: DeploymentKind,
  deploymentId: Schema.NonEmptyString,
  reason: Schema.Literals(["DifferentPin", "DifferentObject"]),
  existingName: Schema.NonEmptyString,
  existingVersion: Schema.NonEmptyString,
  requestedName: Schema.NonEmptyString,
  requestedVersion: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when an exact deployment identifier is absent.
 *
 * @category errors
 * @since 4.0.0
 */
export class DeploymentNotFound extends Schema.TaggedErrorClass<DeploymentNotFound>(
  "@effect/workflow-builder/Deployment/DeploymentNotFound"
)("DeploymentNotFound", {
  kind: DeploymentKind,
  deploymentId: Schema.NonEmptyString,
  requestedName: Schema.NonEmptyString,
  requestedVersion: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a known deployment identifier is requested with a different
 * portable definition identity.
 *
 * @category errors
 * @since 4.0.0
 */
export class DeploymentPinMismatch extends Schema.TaggedErrorClass<DeploymentPinMismatch>(
  "@effect/workflow-builder/Deployment/DeploymentPinMismatch"
)("DeploymentPinMismatch", {
  kind: DeploymentKind,
  deploymentId: Schema.NonEmptyString,
  expectedName: Schema.NonEmptyString,
  expectedVersion: Schema.NonEmptyString,
  actualName: Schema.NonEmptyString,
  actualVersion: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Failures produced while constructing an in-memory deployment catalog.
 *
 * @category errors
 * @since 4.0.0
 */
export type DeploymentCatalogBuildError =
  | InvalidDeployment
  | DuplicateDeploymentId
  | DeploymentIdConflict

/**
 * Failures produced while resolving an exact deployment pin.
 *
 * @category errors
 * @since 4.0.0
 */
export type DeploymentResolutionError =
  | InvalidDeployment
  | DeploymentNotFound
  | DeploymentPinMismatch

/**
 * One workflow definition installed under an immutable deployment identifier.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkflowDefinitionDeployment<
  out W extends Workflow.Any = Workflow.Any
> {
  readonly deploymentId: string
  readonly definition: W
}

/**
 * One handler definition installed under an immutable deployment identifier.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerDefinitionDeployment<
  out N extends Node.Any = Node.Any
> {
  readonly deploymentId: string
  readonly definition: N
}

/**
 * Complete immutable input used to construct an in-memory deployment catalog.
 *
 * @category models
 * @since 4.0.0
 */
export interface DeploymentCatalogEntries {
  readonly workflowDefinitions: ReadonlyArray<WorkflowDefinitionDeployment>
  readonly handlerDefinitions: ReadonlyArray<HandlerDefinitionDeployment>
}

/**
 * Constructs a workflow-definition deployment entry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const workflowDefinition = <W extends Workflow.Any>(
  deploymentId: string,
  definition: W
): WorkflowDefinitionDeployment<W> => Object.freeze({ deploymentId, definition })

/**
 * Constructs a handler-definition deployment entry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const handlerDefinition = <N extends Node.Any>(
  deploymentId: string,
  definition: N
): HandlerDefinitionDeployment<N> => Object.freeze({ deploymentId, definition })

/**
 * Exact definition resolution used by durable recovery.
 *
 * **Details**
 *
 * The deployment identifier and portable identity must both match. The service
 * never searches for another deployment with a compatible `id@version` or
 * `type@version`.
 *
 * @category services
 * @since 4.0.0
 */
export class DeploymentCatalog extends Context.Service<DeploymentCatalog, DeploymentCatalog.Service>()(
  "@effect/workflow-builder/Deployment/Catalog"
) {}

/**
 * Service contracts for {@link DeploymentCatalog}.
 *
 * @since 4.0.0
 */
export declare namespace DeploymentCatalog {
  /**
   * The deployment-catalog service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly resolveWorkflowDefinition: (
      pin: WorkflowDefinitionPin
    ) => Effect.Effect<Workflow.Any, DeploymentResolutionError>
    readonly resolveHandlerDefinition: (
      pin: HandlerDefinitionPin
    ) => Effect.Effect<Node.Any, DeploymentResolutionError>
  }
}

type ResolveOperation =
  | "resolveWorkflowDefinition"
  | "resolveHandlerDefinition"

interface CapturedEntry {
  readonly deploymentId: unknown
  readonly definition: unknown
}

interface CapturedEntries {
  readonly workflowDefinitions: ReadonlyArray<CapturedEntry>
  readonly handlerDefinitions: ReadonlyArray<CapturedEntry>
}

interface StoredWorkflowDefinition {
  readonly deploymentId: string
  readonly name: string
  readonly version: string
  readonly definition: Workflow.Any
}

interface StoredHandlerDefinition {
  readonly deploymentId: string
  readonly name: string
  readonly version: string
  readonly definition: Node.Any
}

type StoredDefinition = StoredWorkflowDefinition | StoredHandlerDefinition

const invalid = (
  operation: InvalidDeployment["operation"],
  message: string,
  details?: Schema.Json
): InvalidDeployment =>
  new InvalidDeployment({
    operation,
    message,
    ...(details === undefined ? undefined : { details })
  })

const key = (
  kind: DeploymentKind,
  deploymentId: string,
  name?: string,
  version?: string
): string =>
  JSON.stringify([
    namespace,
    keyVersion,
    "Deployment",
    kind,
    deploymentId,
    ...(name === undefined ? [] : [name, version!])
  ])

const ownData = (
  descriptors: { readonly [key: string]: PropertyDescriptor | undefined },
  property: string
): PropertyDescriptor | undefined => {
  const descriptor = descriptors[property]
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor
    : undefined
}

const captureDenseArray = (
  input: unknown,
  field: string
): Result.Result<ReadonlyArray<CapturedEntry>, InvalidDeployment> => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return Result.fail(invalid("build", `'${field}' must be a plain dense array`))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const length = ownData(descriptors, "length")?.value
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    ) {
      return Result.fail(invalid("build", `'${field}' must be a plain dense array`))
    }
    const output = new Array<CapturedEntry>(length)
    for (let index = 0; index < length; index++) {
      const descriptor = ownData(descriptors, String(index))
      if (descriptor === undefined || descriptor.enumerable !== true) {
        return Result.fail(invalid("build", `'${field}' must contain only indexed data properties`, {
          field,
          index
        }))
      }
      const entry = descriptor.value
      if (typeof entry !== "object" || entry === null) {
        return Result.fail(invalid("build", `'${field}' entry ${index} must be an object`, {
          field,
          index
        }))
      }
      const prototype = Object.getPrototypeOf(entry)
      if (prototype !== Object.prototype && prototype !== null) {
        return Result.fail(invalid("build", `'${field}' entry ${index} must be a plain object`, {
          field,
          index
        }))
      }
      const entryDescriptors = Object.getOwnPropertyDescriptors(entry)
      const entryKeys = Reflect.ownKeys(entryDescriptors)
      const deploymentId = ownData(entryDescriptors, "deploymentId")
      const definition = ownData(entryDescriptors, "definition")
      if (
        entryKeys.length !== 2 ||
        deploymentId === undefined ||
        definition === undefined ||
        deploymentId.enumerable !== true ||
        definition.enumerable !== true
      ) {
        return Result.fail(invalid(
          "build",
          `'${field}' entry ${index} must contain exactly deploymentId and definition data properties`,
          { field, index }
        ))
      }
      output[index] = {
        deploymentId: deploymentId.value,
        definition: definition.value
      }
    }
    return Result.succeed(Object.freeze(output))
  } catch {
    return Result.fail(invalid("build", `'${field}' could not be inspected safely`))
  }
}

const captureEntries = (
  input: unknown
): Result.Result<CapturedEntries, InvalidDeployment> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(invalid("build", "Deployment catalog entries must be an object"))
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      return Result.fail(invalid("build", "Deployment catalog entries must be a plain object"))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    const workflows = ownData(descriptors, "workflowDefinitions")
    const handlers = ownData(descriptors, "handlerDefinitions")
    if (
      keys.length !== 2 ||
      workflows === undefined ||
      handlers === undefined ||
      workflows.enumerable !== true ||
      handlers.enumerable !== true
    ) {
      return Result.fail(invalid(
        "build",
        "Deployment catalog entries must contain exactly workflowDefinitions and handlerDefinitions"
      ))
    }
    const workflowDefinitions = captureDenseArray(workflows.value, "workflowDefinitions")
    if (Result.isFailure(workflowDefinitions)) {
      return Result.fail(workflowDefinitions.failure)
    }
    const handlerDefinitions = captureDenseArray(handlers.value, "handlerDefinitions")
    if (Result.isFailure(handlerDefinitions)) {
      return Result.fail(handlerDefinitions.failure)
    }
    return Result.succeed(Object.freeze({
      workflowDefinitions: workflowDefinitions.success,
      handlerDefinitions: handlerDefinitions.success
    }))
  } catch {
    return Result.fail(invalid("build", "Deployment catalog entries could not be inspected safely"))
  }
}

const decodeDeploymentId = (
  input: unknown,
  kind: DeploymentKind,
  index: number
): Result.Result<string, InvalidDeployment> => {
  if (typeof input !== "string" || input.length === 0) {
    return Result.fail(invalid("build", "deploymentId must be a non-empty string", {
      kind,
      index
    }))
  }
  const decoded = Schema.decodeUnknownResult(Schema.NonEmptyString)(input)
  return Result.isFailure(decoded)
    ? Result.fail(invalid("build", "deploymentId must be a non-empty string", {
      kind,
      index,
      parseError: decoded.failure.message
    }))
    : Result.succeed(decoded.success)
}

const inspectDefinition = (
  kind: DeploymentKind,
  definition: unknown,
  index: number
): Result.Result<{
  readonly name: string
  readonly version: string
  readonly definition: Workflow.Any | Node.Any
}, InvalidDeployment> => {
  try {
    const valid = kind === "WorkflowDefinition"
      ? Workflow.isDefinition(definition)
      : Node.isDefinition(definition)
    if (!valid) {
      return Result.fail(invalid("build", "Deployment definitions must be immutable definition objects", {
        kind,
        index
      }))
    }
    const descriptors = Object.getOwnPropertyDescriptors(definition)
    const nameProperty = kind === "WorkflowDefinition" ? "id" : "type"
    const name = ownData(descriptors, nameProperty)?.value
    const version = ownData(descriptors, "version")?.value
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      typeof version !== "string" ||
      version.length === 0
    ) {
      return Result.fail(invalid("build", "Deployment definition identity must contain non-empty strings", {
        kind,
        index
      }))
    }
    return Result.succeed({
      name,
      version,
      definition: definition as Workflow.Any | Node.Any
    })
  } catch {
    return Result.fail(invalid("build", "Deployment definition could not be inspected safely", {
      kind,
      index
    }))
  }
}

const decodePin = <A>(
  operation: ResolveOperation,
  input: unknown,
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>
): Effect.Effect<A, InvalidDeployment> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Effect.fail(invalid(operation, `Deployment pin must be strict JSON: ${snapped.failure.message}`, {
      snapshotError: snapped.failure.message,
      path: [...snapped.failure.path]
    }))
  }
  try {
    const decoded = decode(snapped.success)
    return Result.isFailure(decoded)
      ? Effect.fail(invalid(operation, "Invalid deployment pin", {
        parseError: decoded.failure.message
      }))
      : Effect.succeed(snapped.success as A)
  } catch {
    return Effect.fail(invalid(operation, "Deployment pin schema validation threw unexpectedly"))
  }
}

const decodeWorkflowPin = Schema.decodeUnknownResult(WorkflowDefinitionPin, strictParseOptions)
const decodeHandlerPin = Schema.decodeUnknownResult(HandlerDefinitionPin, strictParseOptions)

const duplicateOrConflict = (
  kind: DeploymentKind,
  existing: StoredDefinition,
  requested: StoredDefinition
): DuplicateDeploymentId | DeploymentIdConflict => {
  if (existing.definition === requested.definition) {
    return new DuplicateDeploymentId({
      kind,
      deploymentId: requested.deploymentId,
      name: requested.name,
      version: requested.version
    })
  }
  return new DeploymentIdConflict({
    kind,
    deploymentId: requested.deploymentId,
    reason: existing.name === requested.name && existing.version === requested.version
      ? "DifferentObject"
      : "DifferentPin",
    existingName: existing.name,
    existingVersion: existing.version,
    requestedName: requested.name,
    requestedVersion: requested.version
  })
}

const buildUnsafe = (
  input: unknown
): Result.Result<DeploymentCatalog.Service, DeploymentCatalogBuildError> => {
  const captured = captureEntries(input)
  if (Result.isFailure(captured)) {
    return Result.fail(captured.failure)
  }

  const workflowsById = new Map<string, StoredWorkflowDefinition>()
  const workflowsByPin = new Map<string, StoredWorkflowDefinition>()
  const handlersByPin = new Map<string, StoredHandlerDefinition>()

  for (let index = 0; index < captured.success.workflowDefinitions.length; index++) {
    const entry = captured.success.workflowDefinitions[index]!
    const deploymentId = decodeDeploymentId(entry.deploymentId, "WorkflowDefinition", index)
    if (Result.isFailure(deploymentId)) {
      return Result.fail(deploymentId.failure)
    }
    const inspected = inspectDefinition("WorkflowDefinition", entry.definition, index)
    if (Result.isFailure(inspected)) {
      return Result.fail(inspected.failure)
    }
    const stored: StoredWorkflowDefinition = Object.freeze({
      deploymentId: deploymentId.success,
      name: inspected.success.name,
      version: inspected.success.version,
      definition: inspected.success.definition as Workflow.Any
    })
    const idKey = key("WorkflowDefinition", stored.deploymentId)
    const existing = workflowsById.get(idKey)
    if (existing !== undefined) {
      return Result.fail(duplicateOrConflict("WorkflowDefinition", existing, stored))
    }
    workflowsById.set(idKey, stored)
    workflowsByPin.set(
      key("WorkflowDefinition", stored.deploymentId, stored.name, stored.version),
      stored
    )
  }

  for (let index = 0; index < captured.success.handlerDefinitions.length; index++) {
    const entry = captured.success.handlerDefinitions[index]!
    const deploymentId = decodeDeploymentId(entry.deploymentId, "HandlerDefinition", index)
    if (Result.isFailure(deploymentId)) {
      return Result.fail(deploymentId.failure)
    }
    const inspected = inspectDefinition("HandlerDefinition", entry.definition, index)
    if (Result.isFailure(inspected)) {
      return Result.fail(inspected.failure)
    }
    const stored: StoredHandlerDefinition = Object.freeze({
      deploymentId: deploymentId.success,
      name: inspected.success.name,
      version: inspected.success.version,
      definition: inspected.success.definition as Node.Any
    })
    const pinKey = key(
      "HandlerDefinition",
      stored.deploymentId,
      stored.name,
      stored.version
    )
    const existing = handlersByPin.get(pinKey)
    if (existing !== undefined) {
      return Result.fail(duplicateOrConflict("HandlerDefinition", existing, stored))
    }
    handlersByPin.set(pinKey, stored)
  }

  const resolveWorkflowDefinition: DeploymentCatalog.Service["resolveWorkflowDefinition"] = Effect.fnUntraced(
    function*(input) {
      const pin = yield* decodePin(
        "resolveWorkflowDefinition",
        input,
        decodeWorkflowPin
      )
      const stored = workflowsById.get(key("WorkflowDefinition", pin.deploymentId))
      if (stored === undefined) {
        return yield* Effect.fail(
          new DeploymentNotFound({
            kind: "WorkflowDefinition",
            deploymentId: pin.deploymentId,
            requestedName: pin.definitionId,
            requestedVersion: pin.definitionVersion
          })
        )
      }
      if (
        stored.name !== pin.definitionId ||
        stored.version !== pin.definitionVersion
      ) {
        return yield* Effect.fail(
          new DeploymentPinMismatch({
            kind: "WorkflowDefinition",
            deploymentId: pin.deploymentId,
            expectedName: pin.definitionId,
            expectedVersion: pin.definitionVersion,
            actualName: stored.name,
            actualVersion: stored.version
          })
        )
      }
      const exact = workflowsByPin.get(
        key("WorkflowDefinition", pin.deploymentId, pin.definitionId, pin.definitionVersion)
      )
      if (exact !== stored) {
        return yield* Effect.fail(invalid(
          "resolveWorkflowDefinition",
          "Deployment catalog workflow index is incoherent"
        ))
      }
      return stored.definition
    }
  )

  const resolveHandlerDefinition: DeploymentCatalog.Service["resolveHandlerDefinition"] = Effect.fnUntraced(
    function*(input) {
      const pin = yield* decodePin(
        "resolveHandlerDefinition",
        input,
        decodeHandlerPin
      )
      const stored = handlersByPin.get(
        key("HandlerDefinition", pin.deploymentId, pin.type, pin.version)
      )
      if (stored === undefined) {
        return yield* Effect.fail(
          new DeploymentNotFound({
            kind: "HandlerDefinition",
            deploymentId: pin.deploymentId,
            requestedName: pin.type,
            requestedVersion: pin.version
          })
        )
      }
      if (
        stored.deploymentId !== pin.deploymentId ||
        stored.name !== pin.type ||
        stored.version !== pin.version
      ) {
        return yield* Effect.fail(invalid(
          "resolveHandlerDefinition",
          "Deployment catalog handler index is incoherent"
        ))
      }
      return stored.definition
    }
  )

  return Result.succeed(DeploymentCatalog.of(Object.freeze({
    resolveWorkflowDefinition,
    resolveHandlerDefinition
  })))
}

const build = (
  input: unknown
): Result.Result<DeploymentCatalog.Service, DeploymentCatalogBuildError> => {
  try {
    return buildUnsafe(input)
  } catch {
    return Result.fail(invalid("build", "Deployment catalog construction failed unexpectedly"))
  }
}

/**
 * Builds an immutable in-memory deployment catalog while retaining
 * configuration failures as data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromEntries = (
  entries: DeploymentCatalogEntries
): Result.Result<DeploymentCatalog.Service, DeploymentCatalogBuildError> => build(entries)

/**
 * Constructs an immutable in-memory deployment catalog.
 *
 * **Details**
 *
 * The catalog is process-local and is intended as the semantic reference for
 * exact deployment resolution. Durable adapters must retain the same duplicate,
 * pin-coherence, and no-fallback behavior.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory = (
  entries: DeploymentCatalogEntries
): Effect.Effect<DeploymentCatalog.Service, DeploymentCatalogBuildError> =>
  Effect.suspend(() => Effect.fromResult(build(entries)))

/**
 * Constructs a layer containing an in-memory {@link DeploymentCatalog}.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory = (
  entries: DeploymentCatalogEntries
): Layer.Layer<DeploymentCatalog, DeploymentCatalogBuildError> => Layer.effect(DeploymentCatalog, makeMemory(entries))
