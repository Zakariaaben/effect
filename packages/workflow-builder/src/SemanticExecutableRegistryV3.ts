/**
 * Exact process-local executable resolution for verified protocol-v3 plans.
 *
 * **Details**
 *
 * This registry is an attestation boundary between persisted build
 * descriptors and executable process objects. It does not execute nodes,
 * classify failures, encode values, or own any durable workflow state.
 *
 * Every lookup uses the complete artifact pin. There is deliberately no
 * version selection, "latest" lookup, deployment fallback, or cache.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import type * as Deployment from "./Deployment.ts"
import * as DeploymentHandlers from "./DeploymentHandlers.ts"
import * as Json from "./internal/json.ts"
import * as Node from "./Node.ts"
import * as PlanStoreV3 from "./PlanStoreV3.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import * as Registry from "./Registry.ts"
import * as SemanticOperationV3 from "./SemanticOperationV3.ts"
import * as Workflow from "./Workflow.ts"

type PolicyExecutablePin = Schema.Schema.Type<
  typeof PlanStoreV3.PolicyExecutablePin
>

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const workflowDefinitionExecutables = new WeakSet<object>()
const nodeHandlerExecutables = new WeakSet<object>()
const codecExecutables = new WeakSet<object>()
const retryClassifierExecutables = new WeakSet<object>()
const executableRegistries = new WeakSet<object>()
const resolvedArtifacts = new WeakSet<object>()
const resolvedActivities = new WeakSet<object>()
const resolvedDeferredCodecs = new WeakSet<object>()
const resolvedRaces = new WeakSet<object>()

/**
 * Executable kinds admitted by this registry.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutableKind =
  | "WorkflowDefinition"
  | "NodeHandler"
  | "Codec"
  | "RetryClassifier"

const ExecutableKind = Schema.Literals([
  "WorkflowDefinition",
  "NodeHandler",
  "Codec",
  "RetryClassifier"
])

/**
 * Stable executable-registry failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidPin: "InvalidPin",
  InvalidExecutable: "InvalidExecutable",
  UntrustedExecutable: "UntrustedExecutable",
  DuplicateExecutable: "DuplicateExecutable",
  ConflictingExecutable: "ConflictingExecutable",
  UnverifiedArtifact: "UnverifiedArtifact",
  MissingExecutable: "MissingExecutable",
  PinMismatch: "PinMismatch",
  UnresolvedArtifact: "UnresolvedArtifact",
  UnpreparedOperation: "UnpreparedOperation",
  UnsupportedOperation: "UnsupportedOperation",
  ArtifactMismatch: "ArtifactMismatch"
} as const

/**
 * A stable executable-registry failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidPin,
  ErrorCodes.InvalidExecutable,
  ErrorCodes.UntrustedExecutable,
  ErrorCodes.DuplicateExecutable,
  ErrorCodes.ConflictingExecutable,
  ErrorCodes.UnverifiedArtifact,
  ErrorCodes.MissingExecutable,
  ErrorCodes.PinMismatch,
  ErrorCodes.UnresolvedArtifact,
  ErrorCodes.UnpreparedOperation,
  ErrorCodes.UnsupportedOperation,
  ErrorCodes.ArtifactMismatch
])

/**
 * Raised when executable attestation or exact artifact resolution fails.
 *
 * @category errors
 * @since 4.0.0
 */
export class SemanticExecutableRegistryError extends Schema.TaggedErrorClass<
  SemanticExecutableRegistryError
>("@effect/workflow-builder/SemanticExecutableRegistryV3/Error")(
  "SemanticExecutableRegistryError",
  {
    code: ErrorCode,
    operation: Schema.Literals([
      "nodeHandler",
      "workflowDefinition",
      "codec",
      "retryClassifier",
      "build",
      "resolveArtifact",
      "resolveActivity",
      "resolveDeferred",
      "resolveRace"
    ]),
    message: Schema.NonEmptyString,
    executableKind: Schema.optionalKey(ExecutableKind),
    key: Schema.optionalKey(Schema.NonEmptyString),
    nodeId: Schema.optionalKey(Schema.NonEmptyString),
    deploymentId: Schema.optionalKey(Schema.NonEmptyString),
    executableId: Schema.optionalKey(Schema.NonEmptyString),
    executableVersion: Schema.optionalKey(Schema.NonEmptyString)
  },
  { parseOptions: strictParseOptions }
) {}

type Operation = SemanticExecutableRegistryError["operation"]

const error = (
  code: ErrorCode,
  operation: Operation,
  message: string,
  options: {
    readonly executableKind?: ExecutableKind | undefined
    readonly key?: string | undefined
    readonly nodeId?: string | undefined
    readonly deploymentId?: string | undefined
    readonly executableId?: string | undefined
    readonly executableVersion?: string | undefined
  } = {}
): SemanticExecutableRegistryError =>
  new SemanticExecutableRegistryError({
    code,
    operation,
    message,
    ...(options.executableKind === undefined
      ? undefined
      : { executableKind: options.executableKind }),
    ...(options.key === undefined ? undefined : { key: options.key }),
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.deploymentId === undefined
      ? undefined
      : { deploymentId: options.deploymentId }),
    ...(options.executableId === undefined
      ? undefined
      : { executableId: options.executableId }),
    ...(options.executableVersion === undefined
      ? undefined
      : { executableVersion: options.executableVersion })
  })

const decodeJson = <A>(
  schema: Schema.Codec<A, Schema.Json>,
  input: unknown,
  operation: Operation,
  label: string
): Result.Result<A, SemanticExecutableRegistryError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(error(
      ErrorCodes.InvalidPin,
      operation,
      `${label} must be bounded strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: Result.Result<A, Schema.SchemaError>
  try {
    decoded = Schema.decodeUnknownResult(schema, strictParseOptions)(
      snapshot.success
    )
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidPin,
      operation,
      `${label} validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      ErrorCodes.InvalidPin,
      operation,
      `Invalid ${label}: ${decoded.failure.message}`
    ))
    : Result.succeed(snapshot.success as unknown as A)
}

const buildCoordinates = (
  build: PlanStoreV3.ExecutableBuildPin
): {
  readonly executableKind: PlanStoreV3.ExecutableKind
  readonly deploymentId: string
  readonly executableId: string
  readonly executableVersion: string
} => ({
  executableKind: build.buildDocument.executableKind,
  deploymentId: build.deploymentId,
  executableId: build.buildDocument.executableId,
  executableVersion: build.buildDocument.executableVersion
})

const validBuildRelationships = (
  build: PlanStoreV3.ExecutableBuildPin,
  kind: ExecutableKind,
  executableId: string,
  executableVersion: string
): boolean =>
  build.deploymentId === build.buildDocument.deploymentId &&
  build.buildDocument.executableKind === kind &&
  build.buildDocument.executableId === executableId &&
  build.buildDocument.executableVersion === executableVersion

const buildKey = (
  build: PlanStoreV3.ExecutableBuildPin
): string =>
  JSON.stringify([
    build.buildDocument.executableKind,
    build.deploymentId,
    build.buildDocument.executableId,
    build.buildDocument.executableVersion,
    build.buildDocument.catalogBuildId,
    build.buildDigest
  ])

const buildCoordinateKey = (
  build: PlanStoreV3.ExecutableBuildPin
): string =>
  JSON.stringify([
    build.buildDocument.executableKind,
    build.deploymentId,
    build.buildDocument.executableId,
    build.buildDocument.executableVersion
  ])

const nodeLogicalKey = (
  type: string,
  version: string
): string => JSON.stringify(["NodeHandler", type, version])

const workflowLogicalKey = (
  id: string,
  version: string
): string => JSON.stringify(["WorkflowDefinition", id, version])

const codecLogicalKey = (key: string): string => JSON.stringify(["Codec", key])

const classifierLogicalKey = (key: string): string => JSON.stringify(["RetryClassifier", key])

const codecEntryKey = (pin: PlanStoreV3.CodecPin): string =>
  JSON.stringify([
    pin.key,
    buildKey(pin.build),
    pin.schemaDigest
  ])

const classifierEntryKey = (
  pin: PolicyExecutablePin
): string => JSON.stringify([pin.key, buildKey(pin.build)])

/**
 * A workflow definition resolved from its exact deployment and attested
 * against one complete executable-build pin.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkflowDefinitionExecutable {
  readonly _tag: "WorkflowDefinition"
  readonly build: PlanStoreV3.ExecutableBuildPin
  readonly definition: Workflow.Any
}

/**
 * A node handler attested against one exact executable build.
 *
 * @category models
 * @since 4.0.0
 */
export interface NodeHandlerExecutable {
  readonly _tag: "NodeHandler"
  readonly build: PlanStoreV3.ExecutableBuildPin
  readonly deployed: DeploymentHandlers.DeployedHandlerEntry
}

/**
 * A runtime schema attested against one exact codec and schema pin.
 *
 * @category models
 * @since 4.0.0
 */
export interface CodecExecutable<out S extends Schema.Top = Schema.Top> {
  readonly _tag: "Codec"
  readonly pin: PlanStoreV3.CodecPin
  readonly schema: S
  readonly context: Context.Context<never>
}

/**
 * Requirement-erased classifier boundary retained by the executable catalog.
 *
 * **Details**
 *
 * The registry never invokes this function. Its requirements are erased only
 * after the trusted constructor captures their exact Effect context. Input and
 * success remain the closed retry cause/decision contracts, and the typed
 * failure channel is `never`; defects remain policy/runtime failures.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyRetryClassifier = (
  failure: ActivityPolicyV3.RetryFailureCause
) => Effect.Effect<ActivityPolicyV3.RetryClassification, never, any>

/**
 * A retry classifier attested against one exact policy-executable pin.
 *
 * @category models
 * @since 4.0.0
 */
export interface RetryClassifierExecutable {
  readonly _tag: "RetryClassifier"
  readonly pin: PolicyExecutablePin
  readonly classifier: AnyRetryClassifier
  readonly context: Context.Context<never>
}

/**
 * Any executable entry admitted by this registry.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutableEntry =
  | WorkflowDefinitionExecutable
  | NodeHandlerExecutable
  | CodecExecutable
  | RetryClassifierExecutable

/**
 * Tests whether a value is an exact workflow-definition entry constructed
 * here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isWorkflowDefinitionExecutable = (
  value: unknown
): value is WorkflowDefinitionExecutable =>
  typeof value === "object" &&
  value !== null &&
  workflowDefinitionExecutables.has(value)

/**
 * Tests whether a value is an exact node-handler entry constructed here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isNodeHandlerExecutable = (
  value: unknown
): value is NodeHandlerExecutable =>
  typeof value === "object" &&
  value !== null &&
  nodeHandlerExecutables.has(value)

/**
 * Tests whether a value is an exact codec entry constructed here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isCodecExecutable = (
  value: unknown
): value is CodecExecutable => typeof value === "object" && value !== null && codecExecutables.has(value)

/**
 * Tests whether a value is an exact retry-classifier entry constructed here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isRetryClassifierExecutable = (
  value: unknown
): value is RetryClassifierExecutable =>
  typeof value === "object" &&
  value !== null &&
  retryClassifierExecutables.has(value)

const deploymentResolutionError = (
  cause: Deployment.DeploymentResolutionError,
  coordinates: ReturnType<typeof buildCoordinates>
): SemanticExecutableRegistryError => {
  switch (cause._tag) {
    case "DeploymentNotFound":
      return error(
        ErrorCodes.MissingExecutable,
        "workflowDefinition",
        "The workflow-definition deployment is not installed",
        { ...coordinates, executableKind: "WorkflowDefinition" }
      )
    case "DeploymentPinMismatch":
      return error(
        ErrorCodes.PinMismatch,
        "workflowDefinition",
        "The workflow-definition deployment has different id/version coordinates",
        { ...coordinates, executableKind: "WorkflowDefinition" }
      )
    case "InvalidDeployment":
      return error(
        ErrorCodes.InvalidExecutable,
        "workflowDefinition",
        "The workflow-definition deployment could not be resolved safely",
        { ...coordinates, executableKind: "WorkflowDefinition" }
      )
  }
}

/**
 * Resolves and attests the exact workflow definition selected by one complete
 * executable-build pin.
 *
 * **Details**
 *
 * Resolution delegates to {@link Deployment.DeploymentCatalog} with the
 * build's exact deployment, definition id, and definition version. There is
 * no fallback to another deployment. The returned definition must retain
 * process-local {@link Workflow.isDefinition} provenance.
 *
 * @category constructors
 * @since 4.0.0
 */
export const workflowDefinition = (
  catalog: Deployment.DeploymentCatalog["Service"],
  buildInput: unknown
): Effect.Effect<
  WorkflowDefinitionExecutable,
  SemanticExecutableRegistryError
> =>
  Effect.gen(function*() {
    const decoded = decodeJson(
      PlanStoreV3.ExecutableBuildPin,
      buildInput,
      "workflowDefinition",
      "workflow-definition build pin"
    )
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    const build = decoded.success
    const coordinates = buildCoordinates(build)
    if (
      !validBuildRelationships(
        build,
        "WorkflowDefinition",
        coordinates.executableId,
        coordinates.executableVersion
      )
    ) {
      return yield* Effect.fail(error(
        ErrorCodes.InvalidPin,
        "workflowDefinition",
        "Workflow-definition build fields must identify one exact WorkflowDefinition executable",
        { ...coordinates, executableKind: "WorkflowDefinition" }
      ))
    }

    let resolution: Effect.Effect<
      Workflow.Any,
      Deployment.DeploymentResolutionError
    >
    try {
      if (
        typeof catalog !== "object" ||
        catalog === null ||
        typeof catalog.resolveWorkflowDefinition !== "function"
      ) {
        throw new TypeError("Invalid deployment catalog")
      }
      resolution = catalog.resolveWorkflowDefinition({
        deploymentId: build.deploymentId,
        definitionId: coordinates.executableId,
        definitionVersion: coordinates.executableVersion
      })
    } catch {
      return yield* Effect.fail(error(
        ErrorCodes.UntrustedExecutable,
        "workflowDefinition",
        "Workflow definitions require a usable DeploymentCatalog service",
        { ...coordinates, executableKind: "WorkflowDefinition" }
      ))
    }

    const definition = yield* resolution.pipe(
      Effect.mapError((cause) => deploymentResolutionError(cause, coordinates))
    )
    if (
      !Workflow.isDefinition(definition) ||
      definition.id !== coordinates.executableId ||
      definition.version !== coordinates.executableVersion
    ) {
      return yield* Effect.fail(error(
        ErrorCodes.InvalidExecutable,
        "workflowDefinition",
        "The deployment catalog did not return the exact provenanced workflow definition selected by the build",
        { ...coordinates, executableKind: "WorkflowDefinition" }
      ))
    }

    const entry = Object.freeze({
      _tag: "WorkflowDefinition" as const,
      build,
      definition
    })
    workflowDefinitionExecutables.add(entry)
    return entry
  })

/**
 * Attests the exact deployed handler selected by a node-handler build.
 *
 * **Details**
 *
 * Callers provide the process-local registry rather than a structural handler
 * entry. The selected handler must therefore retain provenance from
 * {@link DeploymentHandlers.make}.
 *
 * @category constructors
 * @since 4.0.0
 */
export const nodeHandler = (
  registry: DeploymentHandlers.DeploymentHandlerRegistry["Service"],
  buildInput: unknown
): Result.Result<NodeHandlerExecutable, SemanticExecutableRegistryError> => {
  const decoded = decodeJson(
    PlanStoreV3.ExecutableBuildPin,
    buildInput,
    "nodeHandler",
    "node-handler build pin"
  )
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const build = decoded.success
  const coordinates = buildCoordinates(build)
  if (
    !validBuildRelationships(
      build,
      "NodeHandler",
      coordinates.executableId,
      coordinates.executableVersion
    )
  ) {
    return Result.fail(error(
      ErrorCodes.InvalidPin,
      "nodeHandler",
      "Node-handler build fields must identify one exact NodeHandler executable",
      { ...coordinates, executableKind: "NodeHandler" }
    ))
  }
  if (!DeploymentHandlers.isDeploymentHandlerRegistry(registry)) {
    return Result.fail(error(
      ErrorCodes.UntrustedExecutable,
      "nodeHandler",
      "Node handlers require an exact DeploymentHandlerRegistry built by DeploymentHandlers.make",
      { ...coordinates, executableKind: "NodeHandler" }
    ))
  }
  let deployed: DeploymentHandlers.DeployedHandlerEntry | undefined
  try {
    deployed = registry.get(
      build.deploymentId,
      coordinates.executableId,
      coordinates.executableVersion
    )
  } catch {
    return Result.fail(error(
      ErrorCodes.UntrustedExecutable,
      "nodeHandler",
      "The deployed-handler registry could not be inspected safely",
      { ...coordinates, executableKind: "NodeHandler" }
    ))
  }
  if (
    deployed === undefined ||
    !Registry.isHandlerRegistry(deployed.registry) ||
    deployed.registry.get(
        coordinates.executableId,
        coordinates.executableVersion
      )?.definition !== deployed.definition ||
    deployed.deploymentId !== build.deploymentId ||
    deployed.definition.type !== coordinates.executableId ||
    deployed.definition.version !== coordinates.executableVersion ||
    typeof deployed.handler !== "function"
  ) {
    return Result.fail(error(
      ErrorCodes.InvalidExecutable,
      "nodeHandler",
      "No exact provenanced deployed handler matches the build pin",
      { ...coordinates, executableKind: "NodeHandler" }
    ))
  }
  const entry = Object.freeze({
    _tag: "NodeHandler" as const,
    build,
    deployed
  })
  nodeHandlerExecutables.add(entry)
  return Result.succeed(entry)
}

/**
 * Attests one runtime schema against an exact persisted codec pin.
 *
 * **Details**
 *
 * This constructor is the trusted catalog boundary: Effect Schema does not
 * expose a general proof that a runtime schema implements an external encoded
 * schema document. The exact pin and runtime schema are therefore retained
 * together with process-local provenance.
 *
 * @category constructors
 * @since 4.0.0
 */
export const codec = <S extends Schema.Top>(
  pinInput: unknown,
  schema: S
): Effect.Effect<
  CodecExecutable<S>,
  SemanticExecutableRegistryError,
  S["DecodingServices"] | S["EncodingServices"]
> =>
  Effect.gen(function*() {
    const decoded = decodeJson(
      PlanStoreV3.CodecPin,
      pinInput,
      "codec",
      "codec pin"
    )
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    const pin = decoded.success
    let validSchema = false
    try {
      validSchema = Schema.isSchema(schema)
    } catch {
      return yield* Effect.fail(error(
        ErrorCodes.InvalidExecutable,
        "codec",
        "Runtime codec schema could not be inspected safely",
        {
          executableKind: "Codec",
          key: pin.key,
          deploymentId: pin.build.deploymentId,
          executableId: pin.codecId,
          executableVersion: pin.codecVersion
        }
      ))
    }
    if (
      !validSchema ||
      pin.key !== PlanStoreV3.codecKey(pin.codecId, pin.codecVersion) ||
      pin.encodedSchema.codecKey !== pin.key ||
      pin.encodedSchema.codecId !== pin.codecId ||
      pin.encodedSchema.codecVersion !== pin.codecVersion ||
      !validBuildRelationships(
        pin.build,
        "Codec",
        pin.codecId,
        pin.codecVersion
      )
    ) {
      return yield* Effect.fail(error(
        ErrorCodes.InvalidExecutable,
        "codec",
        "Runtime schema and codec pin must describe one exact codec executable",
        {
          executableKind: "Codec",
          key: pin.key,
          deploymentId: pin.build.deploymentId,
          executableId: pin.codecId,
          executableVersion: pin.codecVersion
        }
      ))
    }
    const context = yield* Effect.context<
      S["DecodingServices"] | S["EncodingServices"]
    >()
    const entry = Object.freeze({
      _tag: "Codec" as const,
      pin,
      schema,
      // Capturing closes the service requirement before the generic schema is
      // erased by the heterogeneous registry.
      context: context as Context.Context<never>
    })
    codecExecutables.add(entry)
    return entry
  })

/**
 * Attests one closed, infallible retry classifier against its exact build pin.
 *
 * @category constructors
 * @since 4.0.0
 */
export const retryClassifier = <R>(
  pinInput: unknown,
  classifier: (
    failure: ActivityPolicyV3.RetryFailureCause
  ) => Effect.Effect<
    ActivityPolicyV3.RetryClassification,
    never,
    R
  >
): Effect.Effect<
  RetryClassifierExecutable,
  SemanticExecutableRegistryError,
  R
> =>
  Effect.gen(function*() {
    const decoded = decodeJson(
      PlanStoreV3.PolicyExecutablePin,
      pinInput,
      "retryClassifier",
      "retry-classifier executable pin"
    )
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    const pin = decoded.success
    if (
      typeof classifier !== "function" ||
      pin.key !== PlanStoreV3.classifierKey(
          pin.classifierId,
          pin.classifierVersion
        ) ||
      !validBuildRelationships(
        pin.build,
        "RetryClassifier",
        pin.classifierId,
        pin.classifierVersion
      )
    ) {
      return yield* Effect.fail(error(
        ErrorCodes.InvalidExecutable,
        "retryClassifier",
        "Classifier callable and pin must describe one exact RetryClassifier executable",
        {
          executableKind: "RetryClassifier",
          key: pin.key,
          deploymentId: pin.build.deploymentId,
          executableId: pin.classifierId,
          executableVersion: pin.classifierVersion
        }
      ))
    }
    const context = yield* Effect.context<R>()
    // This is the sole intentional callable type-erasure boundary. The exact
    // requirement context is retained beside the function before erasure.
    const entry = Object.freeze({
      _tag: "RetryClassifier" as const,
      pin,
      classifier: classifier as AnyRetryClassifier,
      context: context as Context.Context<never>
    })
    retryClassifierExecutables.add(entry)
    return entry
  })

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
    forEach: (
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown
    ) => {
      source.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    [Symbol.iterator]: () => source[Symbol.iterator]()
  })
  return view
}

interface CapturedEntries {
  readonly entries: ReadonlyArray<ExecutableEntry>
}

const captureEntries = (
  input: unknown
): Result.Result<CapturedEntries, SemanticExecutableRegistryError> => {
  try {
    if (!Array.isArray(input)) {
      return Result.fail(error(
        ErrorCodes.UntrustedExecutable,
        "build",
        "Executable entries must be supplied as a dense array"
      ))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const entries: Array<ExecutableEntry> = []
    for (let index = 0; index < input.length; index++) {
      const descriptor = descriptors[String(index)]
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return Result.fail(error(
          ErrorCodes.UntrustedExecutable,
          "build",
          `Executable entry ${index} must be a dense data property`
        ))
      }
      const entry = descriptor.value
      if (
        !isWorkflowDefinitionExecutable(entry) &&
        !isNodeHandlerExecutable(entry) &&
        !isCodecExecutable(entry) &&
        !isRetryClassifierExecutable(entry)
      ) {
        return Result.fail(error(
          ErrorCodes.UntrustedExecutable,
          "build",
          `Executable entry ${index} was not constructed by this module`
        ))
      }
      entries.push(entry)
    }
    return Result.succeed({
      entries: Object.freeze(entries)
    })
  } catch {
    return Result.fail(error(
      ErrorCodes.UntrustedExecutable,
      "build",
      "Executable entries could not be inspected safely"
    ))
  }
}

interface RegistryIndex {
  readonly workflowDefinitions: Map<string, WorkflowDefinitionExecutable>
  readonly nodeHandlers: Map<string, NodeHandlerExecutable>
  readonly codecs: Map<string, CodecExecutable>
  readonly retryClassifiers: Map<string, RetryClassifierExecutable>
  readonly workflowLogical: Set<string>
  readonly nodeLogical: Set<string>
  readonly codecLogical: Set<string>
  readonly classifierLogical: Set<string>
}

const executableMetadata = (
  entry: ExecutableEntry
): {
  readonly build: PlanStoreV3.ExecutableBuildPin
  readonly entryKey: string
  readonly coordinateKey: string
  readonly logicalKey: string
  readonly id: string
  readonly version: string
  readonly key?: string | undefined
} => {
  switch (entry._tag) {
    case "WorkflowDefinition":
      return {
        build: entry.build,
        entryKey: buildKey(entry.build),
        coordinateKey: buildCoordinateKey(entry.build),
        logicalKey: workflowLogicalKey(
          entry.build.buildDocument.executableId,
          entry.build.buildDocument.executableVersion
        ),
        id: entry.build.buildDocument.executableId,
        version: entry.build.buildDocument.executableVersion
      }
    case "NodeHandler":
      return {
        build: entry.build,
        entryKey: buildKey(entry.build),
        coordinateKey: buildCoordinateKey(entry.build),
        logicalKey: nodeLogicalKey(
          entry.build.buildDocument.executableId,
          entry.build.buildDocument.executableVersion
        ),
        id: entry.build.buildDocument.executableId,
        version: entry.build.buildDocument.executableVersion
      }
    case "Codec":
      return {
        build: entry.pin.build,
        entryKey: codecEntryKey(entry.pin),
        coordinateKey: buildCoordinateKey(entry.pin.build),
        logicalKey: codecLogicalKey(entry.pin.key),
        id: entry.pin.codecId,
        version: entry.pin.codecVersion,
        key: entry.pin.key
      }
    case "RetryClassifier":
      return {
        build: entry.pin.build,
        entryKey: classifierEntryKey(entry.pin),
        coordinateKey: buildCoordinateKey(entry.pin.build),
        logicalKey: classifierLogicalKey(entry.pin.key),
        id: entry.pin.classifierId,
        version: entry.pin.classifierVersion,
        key: entry.pin.key
      }
  }
}

const indexEntries = (
  entries: ReadonlyArray<ExecutableEntry>
): Result.Result<RegistryIndex, SemanticExecutableRegistryError> => {
  const workflowDefinitions = new Map<
    string,
    WorkflowDefinitionExecutable
  >()
  const nodeHandlers = new Map<string, NodeHandlerExecutable>()
  const codecs = new Map<string, CodecExecutable>()
  const retryClassifiers = new Map<string, RetryClassifierExecutable>()
  const workflowLogical = new Set<string>()
  const nodeLogical = new Set<string>()
  const codecLogical = new Set<string>()
  const classifierLogical = new Set<string>()
  const coordinates = new Map<string, string>()

  for (const entry of entries) {
    const metadata = executableMetadata(entry)
    const existingBuild = coordinates.get(metadata.coordinateKey)
    if (existingBuild !== undefined && existingBuild !== metadata.entryKey) {
      return Result.fail(error(
        ErrorCodes.ConflictingExecutable,
        "build",
        "One immutable deployment coordinate is associated with conflicting executable pins",
        {
          executableKind: entry._tag,
          ...(metadata.key === undefined ? undefined : { key: metadata.key }),
          deploymentId: metadata.build.deploymentId,
          executableId: metadata.id,
          executableVersion: metadata.version
        }
      ))
    }
    coordinates.set(metadata.coordinateKey, metadata.entryKey)

    switch (entry._tag) {
      case "WorkflowDefinition":
        if (workflowDefinitions.has(metadata.entryKey)) {
          return Result.fail(error(
            ErrorCodes.DuplicateExecutable,
            "build",
            "Duplicate exact workflow-definition executable",
            {
              executableKind: "WorkflowDefinition",
              deploymentId: metadata.build.deploymentId,
              executableId: metadata.id,
              executableVersion: metadata.version
            }
          ))
        }
        workflowDefinitions.set(metadata.entryKey, entry)
        workflowLogical.add(metadata.logicalKey)
        break
      case "NodeHandler":
        if (nodeHandlers.has(metadata.entryKey)) {
          return Result.fail(error(
            ErrorCodes.DuplicateExecutable,
            "build",
            "Duplicate exact node-handler executable",
            {
              executableKind: "NodeHandler",
              deploymentId: metadata.build.deploymentId,
              executableId: metadata.id,
              executableVersion: metadata.version
            }
          ))
        }
        nodeHandlers.set(metadata.entryKey, entry)
        nodeLogical.add(metadata.logicalKey)
        break
      case "Codec":
        if (codecs.has(metadata.entryKey)) {
          return Result.fail(error(
            ErrorCodes.DuplicateExecutable,
            "build",
            "Duplicate exact codec executable",
            {
              executableKind: "Codec",
              key: entry.pin.key,
              deploymentId: metadata.build.deploymentId,
              executableId: metadata.id,
              executableVersion: metadata.version
            }
          ))
        }
        codecs.set(metadata.entryKey, entry)
        codecLogical.add(metadata.logicalKey)
        break
      case "RetryClassifier":
        if (retryClassifiers.has(metadata.entryKey)) {
          return Result.fail(error(
            ErrorCodes.DuplicateExecutable,
            "build",
            "Duplicate exact retry-classifier executable",
            {
              executableKind: "RetryClassifier",
              key: entry.pin.key,
              deploymentId: metadata.build.deploymentId,
              executableId: metadata.id,
              executableVersion: metadata.version
            }
          ))
        }
        retryClassifiers.set(metadata.entryKey, entry)
        classifierLogical.add(metadata.logicalKey)
        break
    }
  }
  return Result.succeed({
    workflowDefinitions,
    nodeHandlers,
    codecs,
    retryClassifiers,
    workflowLogical,
    nodeLogical,
    codecLogical,
    classifierLogical
  })
}

/**
 * One node binding paired with its exact process-local handler.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeHandler {
  readonly binding: PlanStoreV3.NodeBinding
  readonly executable: NodeHandlerExecutable
  readonly definition: Node.Any
  readonly context: Context.Context<never>
  readonly handler: Node.Handler<Node.Any>
  readonly contract: ResolvedNodeContract
}

/**
 * One exact artifact input port paired with its attested runtime codec.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeInput {
  readonly manifest: PlanStoreV3.NodeDefinitionManifest["inputs"][number]
  readonly codec: CodecExecutable
}

/**
 * One exact artifact output port paired with its attested runtime codec.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeOutput {
  readonly manifest: PlanStoreV3.NodeDefinitionManifest["outputs"][number]
  readonly codec: CodecExecutable
}

/**
 * Complete schema and codec contract resolved for one node definition.
 *
 * **Details**
 *
 * Aggregate schemas are constructed only after every manifest codec has been
 * resolved and authenticated against the exact runtime `Schema` object used by
 * the workflow definition. Captured codec contexts are merged in canonical
 * manifest order; conflicting values for the same Effect service key reject
 * the artifact instead of silently selecting one.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeContract {
  readonly manifest: PlanStoreV3.NodeDefinitionManifest
  readonly config: CodecExecutable
  readonly failure: CodecExecutable
  readonly inputs: ReadonlyMap<string, ResolvedNodeInput>
  readonly outputs: ReadonlyMap<string, ResolvedNodeOutput>
  readonly inputSchema: Schema.Top
  readonly successSchema: Schema.Top
  readonly codecContext: Context.Context<never>
  readonly invocationCodecContext: Context.Context<never>
  readonly resultCodecContext: Context.Context<never>
}

/**
 * All artifact-required process-local executables resolved atomically.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedArtifactExecutables {
  readonly verifiedArtifact: PlanStoreV3.VerifiedArtifact
  readonly artifact: PlanStoreV3.StaticDagArtifact
  readonly artifactDigest: PlanStoreV3.VerifiedArtifact["artifactDigest"]
  readonly workflowExecutable: WorkflowDefinitionExecutable
  readonly workflowDefinition: Workflow.Any
  readonly nodeHandlers: ReadonlyMap<string, ResolvedNodeHandler>
  readonly codecs: ReadonlyMap<string, CodecExecutable>
  readonly retryClassifiers: ReadonlyMap<string, RetryClassifierExecutable>
}

/**
 * Tests whether a value is an exact complete resolution returned here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isResolvedArtifactExecutables = (
  value: unknown
): value is ResolvedArtifactExecutables => typeof value === "object" && value !== null && resolvedArtifacts.has(value)

const missingOrMismatch = (
  operation: "resolveArtifact" | "resolveActivity" | "resolveDeferred",
  kind: ExecutableKind,
  logicalPresent: boolean,
  message: string,
  options: {
    readonly key?: string | undefined
    readonly nodeId?: string | undefined
    readonly deploymentId?: string | undefined
    readonly executableId?: string | undefined
    readonly executableVersion?: string | undefined
  }
): SemanticExecutableRegistryError =>
  error(
    logicalPresent ? ErrorCodes.PinMismatch : ErrorCodes.MissingExecutable,
    operation,
    message,
    { executableKind: kind, ...options }
  )

const boundaryShapeIssue = (
  artifact: PlanStoreV3.StaticDagArtifact,
  definition: Workflow.Any
): string | undefined => {
  try {
    const inputPorts = artifact.inputBoundary.document.ports
    const runtimeInputs = definition.inputs
    if (Object.keys(runtimeInputs).length !== inputPorts.length) {
      return "Workflow input port names do not exactly match the artifact input boundary"
    }
    for (const port of inputPorts) {
      if (!Object.prototype.hasOwnProperty.call(runtimeInputs, port.name)) {
        return `Workflow input '${port.name}' is absent from the runtime definition`
      }
      const runtime = runtimeInputs[port.name]
      if (
        runtime === undefined ||
        runtime._tag !== "OutputPort" ||
        runtime.contract !== port.contract ||
        runtime.fanOut !== port.fanOut
      ) {
        return `Workflow input '${port.name}' contract or fan-out does not match the artifact boundary`
      }
    }

    const outputPorts = artifact.outputBoundary.document.ports
    const runtimeOutputs = definition.outputs
    if (Object.keys(runtimeOutputs).length !== outputPorts.length) {
      return "Workflow output port names do not exactly match the artifact output boundary"
    }
    for (const port of outputPorts) {
      if (!Object.prototype.hasOwnProperty.call(runtimeOutputs, port.name)) {
        return `Workflow output '${port.name}' is absent from the runtime definition`
      }
      const runtime = runtimeOutputs[port.name]
      if (
        runtime === undefined ||
        runtime._tag !== "InputPort" ||
        runtime.contract !== port.contract ||
        runtime.cardinality !== port.cardinality ||
        runtime.required !== port.required
      ) {
        return `Workflow output '${port.name}' contract, cardinality, or required flag does not match the artifact boundary`
      }
    }
    return undefined
  } catch {
    return "Runtime workflow boundary ports could not be inspected safely"
  }
}

interface RuntimeSchemaIssue {
  readonly message: string
  readonly executableKind: ExecutableKind
  readonly key?: string | undefined
  readonly nodeId?: string | undefined
}

const sameNames = (
  runtime: Readonly<Record<string, unknown>>,
  manifest: ReadonlyArray<{ readonly name: string }>
): boolean => {
  const runtimeNames = Object.keys(runtime).sort()
  if (runtimeNames.length !== manifest.length) return false
  for (let index = 0; index < manifest.length; index++) {
    if (runtimeNames[index] !== manifest[index]!.name) return false
  }
  return true
}

const schemaIdentityIssue = (
  codecs: ReadonlyMap<string, CodecExecutable>,
  codecKey: string,
  runtimeSchema: Schema.Top,
  label: string,
  nodeId?: string
): RuntimeSchemaIssue | undefined => {
  const executable = codecs.get(codecKey)
  return executable !== undefined && executable.schema === runtimeSchema
    ? undefined
    : {
      message: `${label} must use the exact runtime Schema object attested by codec '${codecKey}'`,
      executableKind: "Codec",
      key: codecKey,
      ...(nodeId === undefined ? undefined : { nodeId })
    }
}

const runtimeSchemaIssue = (
  artifact: PlanStoreV3.StaticDagArtifact,
  definition: Workflow.Any,
  codecs: ReadonlyMap<string, CodecExecutable>
): RuntimeSchemaIssue | undefined => {
  try {
    for (const port of artifact.inputBoundary.document.ports) {
      const runtime = definition.inputs[port.name]
      if (runtime === undefined) {
        return {
          message: `Workflow input '${port.name}' is absent from the runtime definition`,
          executableKind: "WorkflowDefinition",
          key: port.name
        }
      }
      const issue = schemaIdentityIssue(
        codecs,
        port.codecKey,
        runtime.schema,
        `Workflow input '${port.name}'`
      )
      if (issue !== undefined) return issue
    }

    for (const port of artifact.outputBoundary.document.ports) {
      const runtime = definition.outputs[port.name]
      if (runtime === undefined) {
        return {
          message: `Workflow output '${port.name}' is absent from the runtime definition`,
          executableKind: "WorkflowDefinition",
          key: port.name
        }
      }
      const issue = schemaIdentityIssue(
        codecs,
        port.codecKey,
        runtime.schema,
        `Workflow output '${port.name}'`
      )
      if (issue !== undefined) return issue
    }

    for (const manifest of artifact.nodeDefinitions) {
      const runtime = definition.nodes.definitions[
        Node.key(manifest.nodeType, manifest.nodeVersion)
      ]
      if (
        manifest.key !== PlanStoreV3.nodeDefinitionKey(
            manifest.nodeType,
            manifest.nodeVersion
          ) ||
        runtime === undefined ||
        !Node.isDefinition(runtime) ||
        runtime.type !== manifest.nodeType ||
        runtime.version !== manifest.nodeVersion
      ) {
        return {
          message: `Node definition '${manifest.key}' is absent or incompatible in the runtime workflow`,
          executableKind: "WorkflowDefinition",
          key: manifest.key
        }
      }
      if (
        !sameNames(runtime.inputs, manifest.inputs) ||
        !sameNames(runtime.outputs, manifest.outputs)
      ) {
        return {
          message: `Node definition '${manifest.key}' port names do not exactly match its artifact manifest`,
          executableKind: "WorkflowDefinition",
          key: manifest.key
        }
      }

      let issue = schemaIdentityIssue(
        codecs,
        manifest.configCodecKey,
        runtime.configSchema,
        `Node definition '${manifest.key}' configuration`
      )
      if (issue !== undefined) return issue
      issue = schemaIdentityIssue(
        codecs,
        manifest.failureCodecKey,
        runtime.failureSchema,
        `Node definition '${manifest.key}' failure`
      )
      if (issue !== undefined) return issue

      for (const port of manifest.inputs) {
        const runtimePort = runtime.inputs[port.name]
        if (
          runtimePort === undefined ||
          runtimePort._tag !== "InputPort" ||
          runtimePort.contract !== port.contract ||
          runtimePort.cardinality !== port.cardinality ||
          runtimePort.required !== port.required
        ) {
          return {
            message: `Node input '${manifest.key}.${port.name}' metadata does not match its artifact manifest`,
            executableKind: "WorkflowDefinition",
            key: manifest.key
          }
        }
        issue = schemaIdentityIssue(
          codecs,
          port.codecKey,
          runtimePort.schema,
          `Node input '${manifest.key}.${port.name}'`
        )
        if (issue !== undefined) return issue
      }

      for (const port of manifest.outputs) {
        const runtimePort = runtime.outputs[port.name]
        if (
          runtimePort === undefined ||
          runtimePort._tag !== "OutputPort" ||
          runtimePort.contract !== port.contract ||
          runtimePort.fanOut !== port.fanOut
        ) {
          return {
            message: `Node output '${manifest.key}.${port.name}' metadata does not match its artifact manifest`,
            executableKind: "WorkflowDefinition",
            key: manifest.key
          }
        }
        issue = schemaIdentityIssue(
          codecs,
          port.codecKey,
          runtimePort.schema,
          `Node output '${manifest.key}.${port.name}'`
        )
        if (issue !== undefined) return issue
      }
    }
    return undefined
  } catch {
    return {
      message: "Runtime workflow and node schemas could not be inspected safely",
      executableKind: "WorkflowDefinition"
    }
  }
}

const mergeCodecContexts = (
  nodeId: string,
  label: string,
  codecs: ReadonlyArray<CodecExecutable>
): Result.Result<
  Context.Context<never>,
  SemanticExecutableRegistryError
> => {
  const services = new Map<string, unknown>()
  const owners = new Map<string, string>()
  try {
    const orderedCodecs = [...codecs].sort(
      (left, right) =>
        left.pin.key < right.pin.key
          ? -1
          : left.pin.key > right.pin.key
          ? 1
          : 0
    )
    for (const codec of orderedCodecs) {
      if (!Context.isContext(codec.context)) {
        return Result.fail(error(
          ErrorCodes.InvalidExecutable,
          "resolveArtifact",
          `${label} codec '${codec.pin.key}' has an invalid captured Effect context`,
          {
            executableKind: "Codec",
            key: codec.pin.key,
            nodeId
          }
        ))
      }
      const entries = Array.from(codec.context.mapUnsafe).sort(
        ([left], [right]) => left < right ? -1 : left > right ? 1 : 0
      )
      for (const [serviceKey, service] of entries) {
        if (
          services.has(serviceKey) &&
          !Object.is(services.get(serviceKey), service)
        ) {
          return Result.fail(error(
            ErrorCodes.ConflictingExecutable,
            "resolveArtifact",
            `${label} codecs '${
              owners.get(serviceKey)
            }' and '${codec.pin.key}' captured different values for Effect service '${serviceKey}'`,
            {
              executableKind: "Codec",
              key: codec.pin.key,
              nodeId
            }
          ))
        }
        services.set(serviceKey, service)
        owners.set(serviceKey, codec.pin.key)
      }
    }
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidExecutable,
      "resolveArtifact",
      `${label} codec contexts could not be inspected safely`,
      {
        executableKind: "Codec",
        nodeId
      }
    ))
  }
  return Result.succeed(
    Context.makeUnsafe(services) as Context.Context<never>
  )
}

const resolvedCodec = (
  codecs: ReadonlyMap<string, CodecExecutable>,
  codecKey: string,
  nodeId: string,
  label: string
): Result.Result<
  CodecExecutable,
  SemanticExecutableRegistryError
> => {
  const codec = codecs.get(codecKey)
  return codec === undefined
    ? Result.fail(error(
      ErrorCodes.MissingExecutable,
      "resolveArtifact",
      `${label} codec '${codecKey}' was not resolved from the artifact`,
      {
        executableKind: "Codec",
        key: codecKey,
        nodeId
      }
    ))
    : Result.succeed(codec)
}

const buildNodeContract = (
  binding: PlanStoreV3.NodeBinding,
  manifest: PlanStoreV3.NodeDefinitionManifest,
  codecs: ReadonlyMap<string, CodecExecutable>
): Result.Result<
  ResolvedNodeContract,
  SemanticExecutableRegistryError
> => {
  const configResult = resolvedCodec(
    codecs,
    manifest.configCodecKey,
    binding.nodeId,
    "Configuration"
  )
  if (Result.isFailure(configResult)) {
    return Result.fail(configResult.failure)
  }
  const failureResult = resolvedCodec(
    codecs,
    manifest.failureCodecKey,
    binding.nodeId,
    "Failure"
  )
  if (Result.isFailure(failureResult)) {
    return Result.fail(failureResult.failure)
  }

  const inputFields: Record<string, Schema.Constraint> = Object.create(null)
  const outputFields: Record<string, Schema.Constraint> = Object.create(null)
  const inputs = new Map<string, ResolvedNodeInput>()
  const outputs = new Map<string, ResolvedNodeOutput>()
  const inputCodecs: Array<CodecExecutable> = []
  const outputCodecs: Array<CodecExecutable> = []

  for (const port of manifest.inputs) {
    const codecResult = resolvedCodec(
      codecs,
      port.codecKey,
      binding.nodeId,
      `Input '${port.name}'`
    )
    if (Result.isFailure(codecResult)) {
      return Result.fail(codecResult.failure)
    }
    const codec = codecResult.success
    inputs.set(port.name, Object.freeze({ manifest: port, codec }))
    inputCodecs.push(codec)
    inputFields[port.name] = port.cardinality === "many"
      ? port.required
        ? Schema.NonEmptyArray(codec.schema)
        : Schema.Array(codec.schema)
      : port.required
      ? codec.schema
      : Schema.OptionFromOptionalKey(codec.schema)
  }

  for (const port of manifest.outputs) {
    const codecResult = resolvedCodec(
      codecs,
      port.codecKey,
      binding.nodeId,
      `Output '${port.name}'`
    )
    if (Result.isFailure(codecResult)) {
      return Result.fail(codecResult.failure)
    }
    const codec = codecResult.success
    outputs.set(port.name, Object.freeze({ manifest: port, codec }))
    outputCodecs.push(codec)
    outputFields[port.name] = codec.schema
  }

  const invocationCodecContext = mergeCodecContexts(
    binding.nodeId,
    "Invocation",
    [configResult.success, ...inputCodecs]
  )
  if (Result.isFailure(invocationCodecContext)) {
    return Result.fail(invocationCodecContext.failure)
  }
  const resultCodecContext = mergeCodecContexts(
    binding.nodeId,
    "Result",
    [...outputCodecs, failureResult.success]
  )
  if (Result.isFailure(resultCodecContext)) {
    return Result.fail(resultCodecContext.failure)
  }
  const codecContext = mergeCodecContexts(
    binding.nodeId,
    "Node",
    [
      configResult.success,
      ...inputCodecs,
      ...outputCodecs,
      failureResult.success
    ]
  )
  if (Result.isFailure(codecContext)) {
    return Result.fail(codecContext.failure)
  }

  const inputSchema = Schema.Struct(
    Object.freeze(inputFields)
  ).annotate({
    identifier: "WorkflowSemanticExecutableV3NodeInputAggregate",
    parseOptions: strictParseOptions
  })
  const successSchema = Schema.Struct(
    Object.freeze(outputFields)
  ).annotate({
    identifier: "WorkflowSemanticExecutableV3NodeOutputAggregate",
    parseOptions: strictParseOptions
  })

  return Result.succeed(Object.freeze({
    manifest,
    config: configResult.success,
    failure: failureResult.success,
    inputs: readonlyMap(inputs),
    outputs: readonlyMap(outputs),
    inputSchema,
    successSchema,
    codecContext: codecContext.success,
    invocationCodecContext: invocationCodecContext.success,
    resultCodecContext: resultCodecContext.success
  }))
}

const resolveArtifactFromIndex = (
  index: RegistryIndex,
  verified: PlanStoreV3.VerifiedArtifact
): Effect.Effect<
  ResolvedArtifactExecutables,
  SemanticExecutableRegistryError
> => {
  if (!PlanStoreV3.isVerifiedArtifact(verified)) {
    return Effect.fail(error(
      ErrorCodes.UnverifiedArtifact,
      "resolveArtifact",
      "Executable resolution requires the exact VerifiedArtifact returned by PlanStoreV3.verifyArtifact"
    ))
  }

  const artifact = verified.artifact
  const workflowExecutable = index.workflowDefinitions.get(
    buildKey(artifact.definition.build)
  )
  if (workflowExecutable === undefined) {
    return Effect.fail(missingOrMismatch(
      "resolveArtifact",
      "WorkflowDefinition",
      index.workflowLogical.has(workflowLogicalKey(
        artifact.definition.id,
        artifact.definition.version
      )),
      "No executable matches the artifact's exact workflow-definition build pin",
      {
        deploymentId: artifact.definition.build.deploymentId,
        executableId: artifact.definition.id,
        executableVersion: artifact.definition.version
      }
    ))
  }
  const workflowDefinition = workflowExecutable.definition
  if (
    workflowDefinition.id !== artifact.definition.id ||
    workflowDefinition.version !== artifact.definition.version ||
    !validBuildRelationships(
      workflowExecutable.build,
      "WorkflowDefinition",
      artifact.definition.id,
      artifact.definition.version
    )
  ) {
    return Effect.fail(error(
      ErrorCodes.PinMismatch,
      "resolveArtifact",
      "The workflow-definition executable does not match the artifact definition pin",
      {
        executableKind: "WorkflowDefinition",
        deploymentId: artifact.definition.build.deploymentId,
        executableId: artifact.definition.id,
        executableVersion: artifact.definition.version
      }
    ))
  }
  const boundaryIssue = boundaryShapeIssue(artifact, workflowDefinition)
  if (boundaryIssue !== undefined) {
    return Effect.fail(error(
      ErrorCodes.PinMismatch,
      "resolveArtifact",
      boundaryIssue,
      {
        executableKind: "WorkflowDefinition",
        deploymentId: artifact.definition.build.deploymentId,
        executableId: artifact.definition.id,
        executableVersion: artifact.definition.version
      }
    ))
  }

  const pendingNodes = new Map<
    string,
    Omit<ResolvedNodeHandler, "contract">
  >()
  const codecs = new Map<string, CodecExecutable>()
  const classifiers = new Map<string, RetryClassifierExecutable>()

  for (const binding of artifact.nodeBindings) {
    const executable = index.nodeHandlers.get(buildKey(binding.handlerBuild))
    if (executable === undefined) {
      return Effect.fail(missingOrMismatch(
        "resolveArtifact",
        "NodeHandler",
        index.nodeLogical.has(nodeLogicalKey(
          binding.nodeType,
          binding.nodeVersion
        )),
        "No executable matches the artifact's exact node-handler build pin",
        {
          nodeId: binding.nodeId,
          deploymentId: binding.handlerBuild.deploymentId,
          executableId: binding.nodeType,
          executableVersion: binding.nodeVersion
        }
      ))
    }
    let workflowNode: Node.Any | undefined
    try {
      if (
        binding.nodeDefinitionKey !== PlanStoreV3.nodeDefinitionKey(
          binding.nodeType,
          binding.nodeVersion
        )
      ) {
        throw new TypeError("Invalid node-definition key")
      }
      workflowNode = workflowDefinition.nodes.definitions[
        Node.key(binding.nodeType, binding.nodeVersion)
      ]
    } catch {
      return Effect.fail(error(
        ErrorCodes.PinMismatch,
        "resolveArtifact",
        "The runtime workflow node registry could not be inspected safely",
        {
          executableKind: "NodeHandler",
          nodeId: binding.nodeId,
          deploymentId: binding.handlerBuild.deploymentId,
          executableId: binding.nodeType,
          executableVersion: binding.nodeVersion
        }
      ))
    }
    if (workflowNode !== executable.deployed.definition) {
      return Effect.fail(error(
        ErrorCodes.PinMismatch,
        "resolveArtifact",
        "The deployed handler definition is not the exact object retained by the workflow definition",
        {
          executableKind: "NodeHandler",
          nodeId: binding.nodeId,
          deploymentId: binding.handlerBuild.deploymentId,
          executableId: binding.nodeType,
          executableVersion: binding.nodeVersion
        }
      ))
    }
    pendingNodes.set(
      binding.nodeId,
      Object.freeze({
        binding,
        executable,
        definition: executable.deployed.definition,
        context: executable.deployed.context,
        handler: executable.deployed.handler
      })
    )
  }

  for (const pin of artifact.codecs) {
    const executable = index.codecs.get(codecEntryKey(pin))
    if (executable === undefined) {
      return Effect.fail(missingOrMismatch(
        "resolveArtifact",
        "Codec",
        index.codecLogical.has(codecLogicalKey(pin.key)),
        "No executable matches the artifact's exact codec and schema pin",
        {
          key: pin.key,
          deploymentId: pin.build.deploymentId,
          executableId: pin.codecId,
          executableVersion: pin.codecVersion
        }
      ))
    }
    codecs.set(pin.key, executable)
  }

  for (const pin of artifact.policyExecutableBuilds) {
    const executable = index.retryClassifiers.get(classifierEntryKey(pin))
    if (executable === undefined) {
      return Effect.fail(missingOrMismatch(
        "resolveArtifact",
        "RetryClassifier",
        index.classifierLogical.has(classifierLogicalKey(pin.key)),
        "No executable matches the artifact's exact retry-classifier build pin",
        {
          key: pin.key,
          deploymentId: pin.build.deploymentId,
          executableId: pin.classifierId,
          executableVersion: pin.classifierVersion
        }
      ))
    }
    classifiers.set(pin.key, executable)
  }

  const schemaIssue = runtimeSchemaIssue(
    artifact,
    workflowDefinition,
    codecs
  )
  if (schemaIssue !== undefined) {
    return Effect.fail(error(
      ErrorCodes.PinMismatch,
      "resolveArtifact",
      schemaIssue.message,
      {
        executableKind: schemaIssue.executableKind,
        ...(schemaIssue.key === undefined
          ? undefined
          : { key: schemaIssue.key }),
        ...(schemaIssue.nodeId === undefined
          ? undefined
          : { nodeId: schemaIssue.nodeId })
      }
    ))
  }

  const manifests = new Map(
    artifact.nodeDefinitions.map((manifest) => [manifest.key, manifest])
  )
  const nodes = new Map<string, ResolvedNodeHandler>()
  for (const [nodeId, pending] of pendingNodes) {
    const manifest = manifests.get(pending.binding.nodeDefinitionKey)
    if (manifest === undefined) {
      return Effect.fail(error(
        ErrorCodes.PinMismatch,
        "resolveArtifact",
        "The node binding does not select an exact node-definition manifest",
        {
          executableKind: "NodeHandler",
          nodeId,
          key: pending.binding.nodeDefinitionKey,
          deploymentId: pending.binding.handlerBuild.deploymentId,
          executableId: pending.binding.nodeType,
          executableVersion: pending.binding.nodeVersion
        }
      ))
    }
    const contract = buildNodeContract(
      pending.binding,
      manifest,
      codecs
    )
    if (Result.isFailure(contract)) return Effect.fail(contract.failure)
    nodes.set(
      nodeId,
      Object.freeze({
        ...pending,
        contract: contract.success
      })
    )
  }

  const resolved = Object.freeze({
    verifiedArtifact: verified,
    artifact,
    artifactDigest: verified.artifactDigest,
    workflowExecutable,
    workflowDefinition,
    nodeHandlers: readonlyMap(nodes),
    codecs: readonlyMap(codecs),
    retryClassifiers: readonlyMap(classifiers)
  })
  resolvedArtifacts.add(resolved)
  return Effect.succeed(resolved)
}

/**
 * Exact immutable executable registry service.
 *
 * @category services
 * @since 4.0.0
 */
export class SemanticExecutableRegistryV3 extends Context.Service<
  SemanticExecutableRegistryV3,
  {
    readonly size: number
    readonly resolveArtifact: (
      verified: PlanStoreV3.VerifiedArtifact
    ) => Effect.Effect<
      ResolvedArtifactExecutables,
      SemanticExecutableRegistryError
    >
  }
>()("@effect/workflow-builder/SemanticExecutableRegistryV3") {}

/**
 * Tests whether a value is an exact registry service built here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSemanticExecutableRegistry = (
  value: unknown
): value is SemanticExecutableRegistryV3["Service"] =>
  typeof value === "object" &&
  value !== null &&
  executableRegistries.has(value)

/**
 * Builds an immutable exact executable registry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  input: ReadonlyArray<ExecutableEntry>
): Effect.Effect<
  SemanticExecutableRegistryV3["Service"],
  SemanticExecutableRegistryError
> => {
  const captured = captureEntries(input)
  if (Result.isFailure(captured)) return Effect.fail(captured.failure)
  const indexed = indexEntries(captured.success.entries)
  if (Result.isFailure(indexed)) return Effect.fail(indexed.failure)
  const index = indexed.success
  const service = SemanticExecutableRegistryV3.of(Object.freeze({
    size: captured.success.entries.length,
    resolveArtifact: (
      verified: PlanStoreV3.VerifiedArtifact
    ) => resolveArtifactFromIndex(index, verified)
  }))
  executableRegistries.add(service)
  return Effect.succeed(service)
}

/**
 * Builds a layer containing the exact executable registry.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  entries: ReadonlyArray<ExecutableEntry>
): Layer.Layer<
  SemanticExecutableRegistryV3,
  SemanticExecutableRegistryError
> => Layer.effect(SemanticExecutableRegistryV3, make(entries))

interface ResolvedActivityBase {
  readonly artifact: ResolvedArtifactExecutables
  readonly operation: SemanticOperationV3.PreparedOperation
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly context: Context.Context<never>
}

/**
 * Exact node-handler activity selected by an artifact and prepared operation.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeHandlerActivity extends ResolvedActivityBase {
  readonly _tag: "NodeHandler"
  readonly node: ResolvedNodeHandler
}

/**
 * Exact managed node-attempt activity selected by an artifact and prepared
 * operation.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeAttemptActivity extends ResolvedActivityBase {
  readonly _tag: "NodeAttempt"
  readonly node: ResolvedNodeHandler
}

/**
 * Exact retry-classifier activity selected by a node's immutable policy.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedRetryClassifierActivity extends ResolvedActivityBase {
  readonly _tag: "RetryClassifier"
  readonly node: ResolvedNodeHandler
  readonly executable: RetryClassifierExecutable
}

/**
 * Replay-recorded retry-delay selection using the closed engine vocabulary.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedRetryDelaySelectionActivity extends ResolvedActivityBase {
  readonly _tag: "RetryDelaySelection"
  readonly node: ResolvedNodeHandler
}

/**
 * Replay-recorded canonical wall-clock observation.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedTimeObservationActivity extends ResolvedActivityBase {
  readonly _tag: "TimeObservation"
  readonly node: ResolvedNodeHandler
}

/**
 * Closed exact activity resolution admitted by this registry.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedActivity =
  | ResolvedNodeHandlerActivity
  | ResolvedNodeAttemptActivity
  | ResolvedRetryClassifierActivity
  | ResolvedRetryDelaySelectionActivity
  | ResolvedTimeObservationActivity

/**
 * Tests whether a value is an exact activity resolution returned here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isResolvedActivity = (
  value: unknown
): value is ResolvedActivity =>
  typeof value === "object" &&
  value !== null &&
  resolvedActivities.has(value)

const isBuiltInContract = (
  contract: SemanticOperationV3.ResultContract,
  schema: SemanticOperationV3.BuiltInSchemaName
): boolean =>
  contract._tag === "BuiltIn" &&
  contract.contractReferenceVersion === 1 &&
  contract.vocabularyVersion === 1 &&
  contract.schema === schema

const builtInSchema = (
  name: SemanticOperationV3.BuiltInSchemaName
): Schema.Top => {
  switch (name) {
    case "Never":
      return Schema.Never
    case "Void":
      return Schema.Void
    case "NodeAttemptOutcome":
      return SemanticOperationV3.NodeAttemptOutcome
    case "RetryClassification":
      return ActivityPolicyV3.RetryClassification
    case "RecordedRetryDelay":
      return ActivityPolicyV3.RecordedRetryDelay
    case "CanonicalTimestamp":
      return Wire.Timestamp
  }
}

const resolvedActivity = <A extends ResolvedActivity>(
  value: A
): Result.Result<A, SemanticExecutableRegistryError> => {
  const frozen = Object.freeze(value)
  resolvedActivities.add(frozen)
  return Result.succeed(frozen)
}

/**
 * Resolves one prepared activity exclusively from its verified artifact.
 *
 * **Details**
 *
 * The operation, artifact resolution, node binding, handler or classifier
 * build, and every success/error contract must agree exactly. Built-in
 * contracts resolve through a closed non-overridable vocabulary; callers
 * cannot inject alternate schemas.
 *
 * @category resolution
 * @since 4.0.0
 */
export const resolveActivity = (
  resolved: ResolvedArtifactExecutables,
  operation: SemanticOperationV3.PreparedOperation
): Result.Result<
  ResolvedActivity,
  SemanticExecutableRegistryError
> => {
  if (!isResolvedArtifactExecutables(resolved)) {
    return Result.fail(error(
      ErrorCodes.UnresolvedArtifact,
      "resolveActivity",
      "Activity resolution requires the exact complete artifact resolution returned by this module"
    ))
  }
  if (!SemanticOperationV3.isPrepared(operation)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedOperation,
      "resolveActivity",
      "Activity resolution requires the exact PreparedOperation returned by SemanticOperationV3"
    ))
  }
  const document = operation.document
  if (document._tag !== "Activity") {
    return Result.fail(error(
      ErrorCodes.UnsupportedOperation,
      "resolveActivity",
      "Only Activity semantic operations carry executable result contracts"
    ))
  }
  if (
    document.occurrence.document.artifactDigest !== resolved.artifactDigest
  ) {
    return Result.fail(error(
      ErrorCodes.ArtifactMismatch,
      "resolveActivity",
      "Activity operation and executable resolution belong to different artifacts"
    ))
  }

  const nodeId = document.occurrence.document.nodeId
  const node = resolved.nodeHandlers.get(nodeId)
  if (node === undefined) {
    return Result.fail(error(
      ErrorCodes.MissingExecutable,
      "resolveActivity",
      "No resolved node binding matches the activity occurrence",
      {
        executableKind: "NodeHandler",
        nodeId
      }
    ))
  }

  switch (document.purpose._tag) {
    case "NodeHandler": {
      if (
        document.purpose.nodeDefinitionKey !==
          node.binding.nodeDefinitionKey ||
        document.purpose.handlerBuildDigest !==
          node.binding.handlerBuild.buildDigest
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Node-handler purpose does not match the occurrence's exact artifact binding",
          {
            executableKind: "NodeHandler",
            key: document.purpose.nodeDefinitionKey,
            nodeId
          }
        ))
      }
      if (
        document.successContract._tag !== "NodeOutputAggregate" ||
        document.successContract.contractReferenceVersion !== 1 ||
        document.successContract.nodeDefinitionKey !==
          node.contract.manifest.key
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Node-handler success does not select its exact resolved output aggregate",
          {
            executableKind: "Codec",
            key: node.contract.manifest.key,
            nodeId
          }
        ))
      }
      if (
        document.errorContract._tag !== "ArtifactCodec" ||
        document.errorContract.contractReferenceVersion !== 1 ||
        document.errorContract.codecKey !== node.contract.failure.pin.key ||
        document.errorContract.schemaDigest !==
          node.contract.failure.pin.schemaDigest
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Node-handler error does not select its exact resolved failure codec",
          {
            executableKind: "Codec",
            key: document.errorContract._tag === "ArtifactCodec"
              ? document.errorContract.codecKey
              : node.contract.failure.pin.key,
            nodeId
          }
        ))
      }
      return resolvedActivity({
        _tag: "NodeHandler",
        artifact: resolved,
        operation,
        node,
        successSchema: node.contract.successSchema,
        errorSchema: node.contract.failure.schema,
        context: node.contract.codecContext
      })
    }
    case "NodeAttempt": {
      if (
        document.purpose.nodeDefinitionKey !==
          node.binding.nodeDefinitionKey ||
        document.purpose.handlerBuildDigest !==
          node.binding.handlerBuild.buildDigest
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Managed node-attempt purpose does not match the occurrence's exact artifact binding",
          {
            executableKind: "NodeHandler",
            key: document.purpose.nodeDefinitionKey,
            nodeId
          }
        ))
      }
      if (
        !isBuiltInContract(
          document.successContract,
          "NodeAttemptOutcome"
        ) ||
        !isBuiltInContract(document.errorContract, "Never")
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Managed node-attempt result contracts are outside the closed built-in vocabulary",
          {
            executableKind: "NodeHandler",
            key: node.contract.manifest.key,
            nodeId
          }
        ))
      }
      return resolvedActivity({
        _tag: "NodeAttempt",
        artifact: resolved,
        operation,
        node,
        successSchema: builtInSchema("NodeAttemptOutcome"),
        errorSchema: builtInSchema("Never"),
        context: node.contract.codecContext
      })
    }
    case "RetryClassifier": {
      const classifierPolicy = node.binding.activityPolicy.retry.classifier
      const classifierKey = PlanStoreV3.classifierKey(
        classifierPolicy.classifierId,
        classifierPolicy.classifierVersion
      )
      if (
        document.purpose.classifierKey !== classifierKey ||
        document.purpose.classifierBuildDigest !==
          classifierPolicy.buildDigest
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Retry-classifier purpose does not match the occurrence node's immutable retry policy",
          {
            executableKind: "RetryClassifier",
            key: document.purpose.classifierKey,
            nodeId
          }
        ))
      }
      const executable = resolved.retryClassifiers.get(classifierKey)
      if (
        executable === undefined ||
        executable.pin.build.buildDigest !== classifierPolicy.buildDigest
      ) {
        return Result.fail(missingOrMismatch(
          "resolveActivity",
          "RetryClassifier",
          executable !== undefined,
          "No resolved retry classifier matches the occurrence node's exact policy pin",
          {
            key: classifierKey,
            nodeId
          }
        ))
      }
      if (
        !isBuiltInContract(
          document.successContract,
          "RetryClassification"
        ) ||
        !isBuiltInContract(document.errorContract, "Never")
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Retry-classifier result contracts are outside the closed built-in vocabulary",
          {
            executableKind: "RetryClassifier",
            key: classifierKey,
            nodeId
          }
        ))
      }
      return resolvedActivity({
        _tag: "RetryClassifier",
        artifact: resolved,
        operation,
        node,
        executable,
        successSchema: builtInSchema("RetryClassification"),
        errorSchema: builtInSchema("Never"),
        context: executable.context
      })
    }
    case "RetryDelaySelection":
      if (
        !isBuiltInContract(
          document.successContract,
          "RecordedRetryDelay"
        ) ||
        !isBuiltInContract(document.errorContract, "Never")
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Retry-delay result contracts are outside the closed built-in vocabulary",
          { nodeId }
        ))
      }
      return resolvedActivity({
        _tag: "RetryDelaySelection",
        artifact: resolved,
        operation,
        node,
        successSchema: builtInSchema("RecordedRetryDelay"),
        errorSchema: builtInSchema("Never"),
        context: Context.empty()
      })
    case "TimeObservation":
      if (
        !isBuiltInContract(
          document.successContract,
          "CanonicalTimestamp"
        ) ||
        !isBuiltInContract(document.errorContract, "Never")
      ) {
        return Result.fail(error(
          ErrorCodes.PinMismatch,
          "resolveActivity",
          "Time-observation result contracts are outside the closed built-in vocabulary",
          { nodeId }
        ))
      }
      return resolvedActivity({
        _tag: "TimeObservation",
        artifact: resolved,
        operation,
        node,
        successSchema: builtInSchema("CanonicalTimestamp"),
        errorSchema: builtInSchema("Never"),
        context: Context.empty()
      })
  }
}

/**
 * Exact success and error codecs selected for one prepared deferred operation.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedDeferredCodecs {
  readonly artifact: ResolvedArtifactExecutables
  readonly operation: SemanticOperationV3.PreparedOperation
  readonly success: CodecExecutable
  readonly error: CodecExecutable
  readonly context: Context.Context<never>
}

/**
 * Tests whether a value is an exact deferred-codec resolution returned here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isResolvedDeferredCodecs = (
  value: unknown
): value is ResolvedDeferredCodecs =>
  typeof value === "object" &&
  value !== null &&
  resolvedDeferredCodecs.has(value)

/**
 * Exact prepared timer admitted as a semantic-race participant.
 *
 * **Details**
 *
 * This is not a caller-constructible wrapper. Runtime admission still checks
 * {@link SemanticOperationV3.isPrepared}; the refined document type only
 * exposes that proof to consumers after {@link resolveRace} succeeds.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedRaceTimer = SemanticOperationV3.PreparedOperation & {
  readonly document: Extract<
    SemanticOperationV3.OperationDocument,
    { readonly _tag: "Timer" }
  >
}

/**
 * Closed process-local participant vocabulary for a resolved semantic race.
 *
 * **Details**
 *
 * Activities must be exact node-handler resolutions, timers must be exact
 * prepared operations, and deferred generations must be exact codec
 * resolutions. Arbitrary effects and structural participant wrappers are not
 * part of this vocabulary.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedRaceParticipant =
  | ResolvedNodeHandlerActivity
  | ResolvedRaceTimer
  | ResolvedDeferredCodecs

/**
 * Exact runtime contracts for one authenticated semantic race.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedRace {
  readonly artifact: ResolvedArtifactExecutables
  readonly operation: SemanticOperationV3.PreparedOperation
  readonly participants: ReadonlyArray<ResolvedRaceParticipant>
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly context: Context.Context<never>
}

/**
 * Tests whether a value is the exact race resolution returned by
 * {@link resolveRace}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isResolvedRace = (
  value: unknown
): value is ResolvedRace =>
  typeof value === "object" &&
  value !== null &&
  resolvedRaces.has(value)

/**
 * Resolves both exact codecs pinned by a prepared deferred operation.
 *
 * **Details**
 *
 * A deferred may use distinct success and error codecs. Both keys and schema
 * digests must match codecs already resolved from the same artifact; absence
 * or drift fails the whole operation.
 *
 * @category resolution
 * @since 4.0.0
 */
export const resolveDeferred = (
  resolved: ResolvedArtifactExecutables,
  operation: SemanticOperationV3.PreparedOperation
): Result.Result<
  ResolvedDeferredCodecs,
  SemanticExecutableRegistryError
> => {
  if (!isResolvedArtifactExecutables(resolved)) {
    return Result.fail(error(
      ErrorCodes.UnresolvedArtifact,
      "resolveDeferred",
      "Deferred codecs require the exact complete artifact resolution returned by this module"
    ))
  }
  if (!SemanticOperationV3.isPrepared(operation)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedOperation,
      "resolveDeferred",
      "Deferred codecs require the exact PreparedOperation returned by SemanticOperationV3"
    ))
  }
  const document = operation.document
  if (document._tag !== "Deferred") {
    return Result.fail(error(
      ErrorCodes.UnsupportedOperation,
      "resolveDeferred",
      "Only Deferred semantic operations carry success and error codec pins"
    ))
  }
  if (
    document.occurrence.document.artifactDigest !== resolved.artifactDigest
  ) {
    return Result.fail(error(
      ErrorCodes.ArtifactMismatch,
      "resolveDeferred",
      "Deferred operation and executable resolution belong to different artifacts"
    ))
  }

  const success = resolved.codecs.get(document.successCodecKey)
  if (
    success === undefined ||
    success.pin.schemaDigest !== document.successSchemaDigest
  ) {
    return Result.fail(missingOrMismatch(
      "resolveDeferred",
      "Codec",
      success !== undefined,
      "No resolved codec matches the deferred success codec and schema digest",
      { key: document.successCodecKey }
    ))
  }
  const failure = resolved.codecs.get(document.errorCodecKey)
  if (
    failure === undefined ||
    failure.pin.schemaDigest !== document.errorSchemaDigest
  ) {
    return Result.fail(missingOrMismatch(
      "resolveDeferred",
      "Codec",
      failure !== undefined,
      "No resolved codec matches the deferred error codec and schema digest",
      { key: document.errorCodecKey }
    ))
  }
  const context = mergeCodecContexts(
    document.occurrence.document.nodeId,
    "Deferred",
    [success, failure]
  )
  if (Result.isFailure(context)) {
    return Result.fail(context.failure)
  }

  const value = Object.freeze({
    artifact: resolved,
    operation,
    success,
    error: failure,
    context: context.success
  })
  resolvedDeferredCodecs.add(value)
  return Result.succeed(value)
}

interface ResolvedRaceParticipantContract {
  readonly participant: ResolvedRaceParticipant
  readonly operation: SemanticOperationV3.PreparedOperation
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly context: Context.Context<never>
}

const captureRaceParticipants = (
  input: unknown
): Result.Result<
  ReadonlyArray<unknown>,
  SemanticExecutableRegistryError
> => {
  try {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return Result.fail(error(
        ErrorCodes.InvalidExecutable,
        "resolveRace",
        "Race resolutions must be supplied as one plain dense array"
      ))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    if (
      Object.getOwnPropertyNames(descriptors).length !==
        input.length + 1
    ) {
      return Result.fail(error(
        ErrorCodes.InvalidExecutable,
        "resolveRace",
        "Race resolution arrays must not contain holes, accessors, or extra properties"
      ))
    }
    const captured: Array<unknown> = []
    for (let index = 0; index < input.length; index++) {
      const descriptor = descriptors[String(index)]
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return Result.fail(error(
          ErrorCodes.InvalidExecutable,
          "resolveRace",
          "Race resolution arrays must contain only enumerable data entries"
        ))
      }
      captured.push(descriptor.value)
    }
    return Result.succeed(Object.freeze(captured))
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidExecutable,
      "resolveRace",
      "Race resolutions could not be inspected safely"
    ))
  }
}

const sameResultContract = (
  left: SemanticOperationV3.ResultContract,
  right: SemanticOperationV3.ResultContract
): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case "ArtifactCodec":
      return right._tag === "ArtifactCodec" &&
        left.contractReferenceVersion ===
          right.contractReferenceVersion &&
        left.codecKey === right.codecKey &&
        left.schemaDigest === right.schemaDigest
    case "NodeOutputAggregate":
      return right._tag === "NodeOutputAggregate" &&
        left.contractReferenceVersion ===
          right.contractReferenceVersion &&
        left.nodeDefinitionKey === right.nodeDefinitionKey
    case "BuiltIn":
      return right._tag === "BuiltIn" &&
        left.contractReferenceVersion ===
          right.contractReferenceVersion &&
        left.vocabularyVersion === right.vocabularyVersion &&
        left.schema === right.schema
  }
}

const expectedRaceContracts = (
  operation: SemanticOperationV3.PreparedOperation
): {
  readonly success: SemanticOperationV3.ResultContract
  readonly error: SemanticOperationV3.ResultContract
} | undefined => {
  const document = operation.document
  switch (document._tag) {
    case "Activity":
      return {
        success: document.successContract,
        error: document.errorContract
      }
    case "Timer":
      return {
        success: {
          _tag: "BuiltIn",
          contractReferenceVersion: 1,
          vocabularyVersion: 1,
          schema: "Void"
        },
        error: {
          _tag: "BuiltIn",
          contractReferenceVersion: 1,
          vocabularyVersion: 1,
          schema: "Never"
        }
      }
    case "Deferred":
      return {
        success: {
          _tag: "ArtifactCodec",
          contractReferenceVersion: 1,
          codecKey: document.successCodecKey,
          schemaDigest: document.successSchemaDigest
        },
        error: {
          _tag: "ArtifactCodec",
          contractReferenceVersion: 1,
          codecKey: document.errorCodecKey,
          schemaDigest: document.errorSchemaDigest
        }
      }
    case "Race":
      return undefined
    case "RetryScheduleToClose":
      return undefined
  }
}

const resolveRaceParticipant = (
  resolved: ResolvedArtifactExecutables,
  race: Extract<
    SemanticOperationV3.OperationDocument,
    { readonly _tag: "Race" }
  >,
  descriptor: SemanticOperationV3.RaceParticipant,
  input: unknown
): Result.Result<
  ResolvedRaceParticipantContract,
  SemanticExecutableRegistryError
> => {
  let participant: ResolvedRaceParticipant
  let operation: SemanticOperationV3.PreparedOperation
  let successSchema: Schema.Top
  let errorSchema: Schema.Top
  let context: Context.Context<never>

  switch (descriptor.participantKind) {
    case "Activity":
      if (
        !isResolvedActivity(input) ||
        input._tag !== "NodeHandler"
      ) {
        return Result.fail(error(
          ErrorCodes.UntrustedExecutable,
          "resolveRace",
          "Activity race participants require an exact resolved node-handler activity"
        ))
      }
      if (input.artifact !== resolved) {
        return Result.fail(error(
          ErrorCodes.ArtifactMismatch,
          "resolveRace",
          "Activity race participant and race belong to different resolved artifacts"
        ))
      }
      participant = input
      operation = input.operation
      successSchema = input.successSchema
      errorSchema = input.errorSchema
      context = input.context
      break
    case "Timer":
      if (
        !SemanticOperationV3.isPrepared(input) ||
        input.document._tag !== "Timer"
      ) {
        return Result.fail(error(
          ErrorCodes.UnpreparedOperation,
          "resolveRace",
          "Timer race participants require an exact prepared Timer operation"
        ))
      }
      participant = input as ResolvedRaceTimer
      operation = input
      successSchema = builtInSchema("Void")
      errorSchema = builtInSchema("Never")
      context = Context.empty()
      break
    case "Deferred":
      if (!isResolvedDeferredCodecs(input)) {
        return Result.fail(error(
          ErrorCodes.UntrustedExecutable,
          "resolveRace",
          "Deferred race participants require exact resolved deferred codecs"
        ))
      }
      if (input.artifact !== resolved) {
        return Result.fail(error(
          ErrorCodes.ArtifactMismatch,
          "resolveRace",
          "Deferred race participant and race belong to different resolved artifacts"
        ))
      }
      participant = input
      operation = input.operation
      successSchema = input.success.schema
      errorSchema = input.error.schema
      context = input.context
      break
  }

  if (
    operation.document.occurrence.document.artifactDigest !==
      resolved.artifactDigest
  ) {
    return Result.fail(error(
      ErrorCodes.ArtifactMismatch,
      "resolveRace",
      "Race participant operation belongs to a different artifact"
    ))
  }
  if (
    operation.document.occurrence.occurrenceDigest !==
      race.occurrence.occurrenceDigest
  ) {
    return Result.fail(error(
      ErrorCodes.ArtifactMismatch,
      "resolveRace",
      "Race participant operation belongs to a different semantic occurrence"
    ))
  }
  if (operation.operationDigest !== descriptor.operationDigest) {
    return Result.fail(error(
      ErrorCodes.PinMismatch,
      "resolveRace",
      "Ordered race resolution does not match its committed participant operation digest"
    ))
  }
  const contracts = expectedRaceContracts(operation)
  if (
    contracts === undefined ||
    !sameResultContract(
      descriptor.successContract,
      contracts.success
    ) ||
    !sameResultContract(
      descriptor.errorContract,
      contracts.error
    )
  ) {
    return Result.fail(error(
      ErrorCodes.PinMismatch,
      "resolveRace",
      "Race participant result contracts do not match its exact resolved operation"
    ))
  }

  return Result.succeed({
    participant,
    operation,
    successSchema,
    errorSchema,
    context
  })
}

const mergeRaceContexts = (
  nodeId: string,
  descriptors: ReadonlyArray<SemanticOperationV3.RaceParticipant>,
  participants: ReadonlyArray<ResolvedRaceParticipantContract>
): Result.Result<
  Context.Context<never>,
  SemanticExecutableRegistryError
> => {
  const services = new Map<string, unknown>()
  const owners = new Map<string, string>()
  try {
    for (let index = 0; index < participants.length; index++) {
      const participant = participants[index]!
      const descriptor = descriptors[index]!
      if (!Context.isContext(participant.context)) {
        return Result.fail(error(
          ErrorCodes.InvalidExecutable,
          "resolveRace",
          `Race participant '${descriptor.participantId}' has an invalid captured Effect context`,
          { nodeId }
        ))
      }
      const entries = Array.from(
        participant.context.mapUnsafe
      ).sort(
        ([left], [right]) => left < right ? -1 : left > right ? 1 : 0
      )
      for (const [serviceKey, service] of entries) {
        if (
          services.has(serviceKey) &&
          !Object.is(services.get(serviceKey), service)
        ) {
          return Result.fail(error(
            ErrorCodes.ConflictingExecutable,
            "resolveRace",
            `Race participants '${
              owners.get(serviceKey)
            }' and '${descriptor.participantId}' captured different values for Effect service '${serviceKey}'`,
            { nodeId }
          ))
        }
        services.set(serviceKey, service)
        owners.set(serviceKey, descriptor.participantId)
      }
    }
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidExecutable,
      "resolveRace",
      "Race participant contexts could not be inspected safely",
      { nodeId }
    ))
  }
  return Result.succeed(
    Context.makeUnsafe(services) as Context.Context<never>
  )
}

const raceIdentityFields = (
  descriptor: SemanticOperationV3.RaceParticipant,
  index: number
) => ({
  outcomeEnvelopeVersion: Schema.Literal(1),
  participantId: Schema.Literal(descriptor.participantId),
  index: Schema.Literal(index),
  participantOperationDigest: Schema.Literal(
    descriptor.operationDigest
  )
})

const raceUnion = (
  members: ReadonlyArray<Schema.Constraint>,
  identifier: string,
  strictExcessProperties = true
): Schema.Top =>
  Schema.Union(Object.freeze([...members])).annotate({
    identifier,
    parseOptions: strictExcessProperties
      ? strictParseOptions
      : { errors: "all" }
  })

const raceSchemas = (
  race: Extract<
    SemanticOperationV3.OperationDocument,
    { readonly _tag: "Race" }
  >,
  participants: ReadonlyArray<ResolvedRaceParticipantContract>
): {
  readonly success: Schema.Top
  readonly error: Schema.Top
} => {
  if (race.mode === "FirstSettled") {
    const winners = participants.map((participant, index) => {
      const descriptor = race.participants[index]!
      const winner = Schema.Struct({
        _tag: Schema.Literal("RaceWinner"),
        ...raceIdentityFields(descriptor, index),
        exit: Schema.Exit(
          participant.successSchema,
          participant.errorSchema,
          Schema.Defect()
        )
      })
      // Keep strict validation on the winner envelope without propagating
      // excess-property rejection into Schema.Exit's native Cause metadata
      // when the durable backend derives its canonical JSON codec.
      return winner.pipe(
        Schema.decodeTo(Schema.toType(winner))
      ).annotate({
        identifier: "WorkflowSemanticExecutableV3FirstSettledRaceWinner",
        parseOptions: strictParseOptions
      })
    })
    return {
      success: raceUnion(
        winners,
        "WorkflowSemanticExecutableV3FirstSettledRaceResult",
        false
      ),
      error: builtInSchema("Never")
    }
  }

  const winners = participants.map((participant, index) => {
    const descriptor = race.participants[index]!
    const winner = Schema.Struct({
      _tag: Schema.Literal("RaceWinner"),
      ...raceIdentityFields(descriptor, index),
      value: participant.successSchema
    })
    return winner.pipe(
      Schema.decodeTo(Schema.toType(winner))
    ).annotate({
      identifier: "WorkflowSemanticExecutableV3FirstSuccessRaceWinner",
      parseOptions: strictParseOptions
    })
  })
  const failures = participants.map((participant, index) => {
    const descriptor = race.participants[index]!
    const failure = Schema.Struct({
      _tag: Schema.Literal("RaceFailure"),
      ...raceIdentityFields(descriptor, index),
      error: participant.errorSchema
    })
    return failure.pipe(
      Schema.decodeTo(Schema.toType(failure))
    ).annotate({
      identifier: "WorkflowSemanticExecutableV3FirstSuccessRaceFailure",
      parseOptions: strictParseOptions
    })
  })
  return {
    success: raceUnion(
      winners,
      "WorkflowSemanticExecutableV3FirstSuccessRaceResult",
      false
    ),
    error: raceUnion(
      failures,
      "WorkflowSemanticExecutableV3FirstSuccessRaceError",
      false
    )
  }
}

/**
 * Resolves one authenticated semantic race from exact ordered participant
 * resolutions.
 *
 * **Details**
 *
 * The persisted descriptor owns participant IDs, order, kinds, operation
 * digests, and result contracts. The caller supplies only the corresponding
 * exact process-local resolutions; arbitrary effects, structural copies, and
 * reordered participants are rejected before a dynamic result schema is
 * constructed.
 *
 * `FirstSettled` returns a tagged winner containing the participant's complete
 * `Exit` and has an impossible typed error channel. `FirstSuccess` keeps
 * successes and typed failures in distinct identified envelopes; defects
 * remain defects rather than being disguised as application failures.
 *
 * @category resolution
 * @since 4.0.0
 */
export const resolveRace = (
  resolved: ResolvedArtifactExecutables,
  operation: SemanticOperationV3.PreparedOperation,
  orderedResolutions: ReadonlyArray<ResolvedRaceParticipant>
): Result.Result<
  ResolvedRace,
  SemanticExecutableRegistryError
> => {
  if (!isResolvedArtifactExecutables(resolved)) {
    return Result.fail(error(
      ErrorCodes.UnresolvedArtifact,
      "resolveRace",
      "Race resolution requires the exact complete artifact resolution returned by this module"
    ))
  }
  if (!SemanticOperationV3.isPrepared(operation)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedOperation,
      "resolveRace",
      "Race resolution requires the exact PreparedOperation returned by SemanticOperationV3"
    ))
  }
  const race = operation.document
  if (race._tag !== "Race") {
    return Result.fail(error(
      ErrorCodes.UnsupportedOperation,
      "resolveRace",
      "Only a prepared Race operation has ordered participant membership"
    ))
  }
  if (
    race.occurrence.document.artifactDigest !==
      resolved.artifactDigest
  ) {
    return Result.fail(error(
      ErrorCodes.ArtifactMismatch,
      "resolveRace",
      "Race operation and executable resolution belong to different artifacts"
    ))
  }
  const captured = captureRaceParticipants(orderedResolutions)
  if (Result.isFailure(captured)) {
    return Result.fail(captured.failure)
  }
  if (captured.success.length !== race.participants.length) {
    return Result.fail(error(
      ErrorCodes.PinMismatch,
      "resolveRace",
      "Ordered race resolutions must exactly match the committed participant count"
    ))
  }

  const participants: Array<ResolvedRaceParticipantContract> = []
  for (let index = 0; index < race.participants.length; index++) {
    const participant = resolveRaceParticipant(
      resolved,
      race,
      race.participants[index]!,
      captured.success[index]
    )
    if (Result.isFailure(participant)) {
      return Result.fail(participant.failure)
    }
    participants.push(participant.success)
  }
  const context = mergeRaceContexts(
    race.occurrence.document.nodeId,
    race.participants,
    participants
  )
  if (Result.isFailure(context)) {
    return Result.fail(context.failure)
  }
  const schemas = raceSchemas(race, participants)
  const exactParticipants = Object.freeze(
    participants.map((participant) => participant.participant)
  )
  const value = Object.freeze({
    artifact: resolved,
    operation,
    participants: exactParticipants,
    successSchema: schemas.success,
    errorSchema: schemas.error,
    context: context.success
  })
  resolvedRaces.add(value)
  return Result.succeed(value)
}
