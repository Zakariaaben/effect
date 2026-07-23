/**
 * Semantic-operation mappings onto native Effect Workflow primitives.
 *
 * **Details**
 *
 * This module admits authenticated node occurrences and composes public native
 * primitives; it owns no persistence, journal, clock store, deferred store,
 * activity cache, lease, or replay engine. Every operation mapping first binds
 * the content-addressed semantic descriptor through a native guard activity.
 * Reusing the same native coordinates with changed meaning then fails before
 * the changed operation can run.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Random from "effect/Random"
import * as Result from "effect/Result"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as NativeActivity from "effect/unstable/workflow/Activity"
import * as NativeClock from "effect/unstable/workflow/DurableClock"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import type * as NativeWorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import type * as DigestV3 from "./DigestV3.ts"
import * as EffectWorkflowBackendV3 from "./EffectWorkflowBackendV3.ts"
import * as NativeName from "./EffectWorkflowOperationV3.ts"
import * as Json from "./internal/json.ts"
import type * as Node from "./Node.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import * as SemanticExecutableRegistryV3 from "./SemanticExecutableRegistryV3.ts"
import * as SemanticOccurrenceV3 from "./SemanticOccurrenceV3.ts"
import * as SemanticOperationV3 from "./SemanticOperationV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Stable native semantic-mapping failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidSemanticExecution: "InvalidSemanticExecution",
  InvalidOccurrenceCoordinates: "InvalidOccurrenceCoordinates",
  UnknownNode: "UnknownNode",
  UnsupportedOccurrence: "UnsupportedOccurrence",
  UnpreparedOperation: "UnpreparedOperation",
  InvalidActivityResolution: "InvalidActivityResolution",
  InvalidActivityInput: "InvalidActivityInput",
  UnsupportedBlobPayload: "UnsupportedBlobPayload",
  InvalidDeferredToken: "InvalidDeferredToken",
  InvalidDeferredCompletion: "InvalidDeferredCompletion",
  InvalidRaceResolution: "InvalidRaceResolution",
  InvalidNativeCoordinates: "InvalidNativeCoordinates",
  UnsupportedOperation: "UnsupportedOperation",
  DescriptorDrift: "DescriptorDrift"
} as const

/**
 * A stable native semantic-mapping failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidSemanticExecution,
  ErrorCodes.InvalidOccurrenceCoordinates,
  ErrorCodes.UnknownNode,
  ErrorCodes.UnsupportedOccurrence,
  ErrorCodes.UnpreparedOperation,
  ErrorCodes.InvalidActivityResolution,
  ErrorCodes.InvalidActivityInput,
  ErrorCodes.UnsupportedBlobPayload,
  ErrorCodes.InvalidDeferredToken,
  ErrorCodes.InvalidDeferredCompletion,
  ErrorCodes.InvalidRaceResolution,
  ErrorCodes.InvalidNativeCoordinates,
  ErrorCodes.UnsupportedOperation,
  ErrorCodes.DescriptorDrift
])

/**
 * Raised before or while mapping a semantic operation onto a native primitive.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowSemanticError extends Schema.TaggedErrorClass<
  EffectWorkflowSemanticError
>("@effect/workflow-builder/EffectWorkflowSemanticV3/Error")(
  "EffectWorkflowSemanticError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    nodeId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationId: Schema.optionalKey(Wire.AtomicIdentifier),
    currentDigest: Schema.optionalKey(Wire.OperationDigest),
    committedDigest: Schema.optionalKey(Wire.OperationDigest)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Stable defect codes for violations inside a node activity boundary.
 *
 * @category constants
 * @since 4.0.0
 */
export const ActivityDefectCodes = {
  MissingNodeConfiguration: "MissingNodeConfiguration",
  UnsupportedBlobPayload: "UnsupportedBlobPayload",
  InvalidConfiguration: "InvalidConfiguration",
  InvalidInput: "InvalidInput",
  InvalidHandler: "InvalidHandler",
  InvalidOutput: "InvalidOutput",
  InvalidFailure: "InvalidFailure",
  InvalidFailureIdentity: "InvalidFailureIdentity",
  InvalidOutcome: "InvalidOutcome"
} as const

/**
 * A stable node activity defect code.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityDefectCode = typeof ActivityDefectCodes[keyof typeof ActivityDefectCodes]

const ActivityDefectCode = Schema.Literals([
  ActivityDefectCodes.MissingNodeConfiguration,
  ActivityDefectCodes.UnsupportedBlobPayload,
  ActivityDefectCodes.InvalidConfiguration,
  ActivityDefectCodes.InvalidInput,
  ActivityDefectCodes.InvalidHandler,
  ActivityDefectCodes.InvalidOutput,
  ActivityDefectCodes.InvalidFailure,
  ActivityDefectCodes.InvalidFailureIdentity,
  ActivityDefectCodes.InvalidOutcome
])

/**
 * A protocol/runtime defect that must never enter a node's typed failure
 * channel.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowActivityDefect extends Schema.TaggedErrorClass<
  EffectWorkflowActivityDefect
>("@effect/workflow-builder/EffectWorkflowSemanticV3/ActivityDefect")(
  "EffectWorkflowActivityDefect",
  {
    code: ActivityDefectCode,
    message: Schema.NonEmptyString,
    nodeId: Wire.AtomicIdentifier,
    operationId: Wire.AtomicIdentifier,
    operationDigest: Wire.OperationDigest
  },
  { parseOptions: strictParseOptions }
) {}

const error = (
  code: ErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly operationId?: string | undefined
    readonly currentDigest?: Wire.OperationDigest | undefined
    readonly committedDigest?: Wire.OperationDigest | undefined
  } = {}
): EffectWorkflowSemanticError =>
  new EffectWorkflowSemanticError({
    code,
    message,
    ...(options.nodeId === undefined
      ? undefined
      : { nodeId: options.nodeId }),
    ...(options.operationId === undefined
      ? undefined
      : { operationId: options.operationId }),
    ...(options.currentDigest === undefined
      ? undefined
      : { currentDigest: options.currentDigest }),
    ...(options.committedDigest === undefined
      ? undefined
      : { committedDigest: options.committedDigest })
  })

const activityDefect = (
  resolution:
    | SemanticExecutableRegistryV3.ResolvedNodeHandlerActivity
    | SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  code: ActivityDefectCode,
  message: string
): EffectWorkflowActivityDefect =>
  new EffectWorkflowActivityDefect({
    code,
    message,
    nodeId: resolution.node.binding.nodeId,
    operationId: resolution.operation.document.operationId,
    operationDigest: resolution.operation.operationDigest
  })

/**
 * Dynamic coordinates requested for a node occurrence in the current
 * static-DAG interpreter.
 *
 * **Details**
 *
 * The schema already reserves the full occurrence vocabulary, but the current
 * static-DAG host admits only an empty scope path and activation `0`. Loop,
 * multi-instance, re-entry, and BPMN scope activations must later come from
 * replay-derived interpreter state rather than caller-selected counters.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OccurrenceCoordinates = Schema.Struct({
  nodeId: Wire.AtomicIdentifier,
  scopePath: SemanticOccurrenceV3.ScopePath,
  activation: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowEffectSemanticV3OccurrenceCoordinates",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OccurrenceCoordinates}.
 *
 * @category models
 * @since 4.0.0
 */
export type OccurrenceCoordinates = Schema.Schema.Type<
  typeof OccurrenceCoordinates
>

const decodeOccurrenceCoordinates = (
  input: unknown
): Result.Result<OccurrenceCoordinates, EffectWorkflowSemanticError> => {
  const snapped = Json.snapshot(input, {
    maxArrayLength: SemanticOccurrenceV3.MaximumScopeDepth,
    maxContainers: 256,
    maxDepth: 16,
    maxEntries: 1_024,
    maxStringBytes: Wire.MaximumAtomicIdentifierBytes,
    maxTotalBytes: 1_048_576
  })
  if (Result.isFailure(snapped)) {
    return Result.fail(error(
      ErrorCodes.InvalidOccurrenceCoordinates,
      `Static-DAG occurrence coordinates must be bounded strict JSON: ${snapped.failure.message}`
    ))
  }
  let decoded: Result.Result<
    OccurrenceCoordinates,
    Schema.SchemaError
  >
  try {
    decoded = Schema.decodeUnknownResult(
      OccurrenceCoordinates,
      strictParseOptions
    )(snapped.success)
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidOccurrenceCoordinates,
      "Static-DAG occurrence coordinate validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      ErrorCodes.InvalidOccurrenceCoordinates,
      `Invalid static-DAG occurrence coordinates: ${decoded.failure.message}`
    ))
    : Result.succeed(snapped.success as unknown as OccurrenceCoordinates)
}

/**
 * Constructs one authenticated current static-DAG node occurrence.
 *
 * **Details**
 *
 * Tenant, run, and artifact identity come exclusively from the exact
 * {@link EffectWorkflowBackendV3.SemanticExecution} created by the registered
 * native handler. Callers provide only node coordinates. The node must belong
 * to the pinned artifact, and structural copies or proxies of the execution
 * context are rejected.
 *
 * The present static-DAG runtime is one-shot, so only `scopePath: []` and
 * `activation: 0` are admitted. Future control-flow interpreters must expose a
 * separate replay-derived admission path before dynamic activations are
 * enabled.
 *
 * @category constructors
 * @since 4.0.0
 */
export const staticDagOccurrence = (
  execution: EffectWorkflowBackendV3.SemanticExecution,
  input: unknown
): Effect.Effect<
  SemanticOccurrenceV3.PreparedOccurrence,
  | EffectWorkflowSemanticError
  | SemanticOccurrenceV3.SemanticOccurrenceError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  if (!EffectWorkflowBackendV3.isSemanticExecution(execution)) {
    return Effect.fail(error(
      ErrorCodes.InvalidSemanticExecution,
      "Static-DAG occurrences require the exact SemanticExecution created by EffectWorkflowBackendV3"
    ))
  }
  const coordinates = decodeOccurrenceCoordinates(input)
  if (Result.isFailure(coordinates)) {
    return Effect.fail(coordinates.failure)
  }
  if (
    coordinates.success.scopePath.length !== 0 ||
    coordinates.success.activation !== 0
  ) {
    return Effect.fail(error(
      ErrorCodes.UnsupportedOccurrence,
      "The current static-DAG interpreter admits only scopePath [] and activation 0",
      { nodeId: coordinates.success.nodeId }
    ))
  }
  const nodeExists = execution.artifact.nodeBindings.some(
    (binding) => binding.nodeId === coordinates.success.nodeId
  )
  if (!nodeExists) {
    return Effect.fail(error(
      ErrorCodes.UnknownNode,
      "Occurrence node does not belong to the execution artifact",
      { nodeId: coordinates.success.nodeId }
    ))
  }
  return SemanticOccurrenceV3.prepare({
    occurrenceVersion: SemanticOccurrenceV3.OccurrenceVersion,
    executionProtocolVersion: SemanticOccurrenceV3.ExecutionProtocolVersion,
    tenantId: execution.request.tenantId,
    runId: execution.request.runId,
    artifactDigest: execution.request.artifactDigest,
    nodeId: coordinates.success.nodeId,
    scopePath: coordinates.success.scopePath,
    activation: coordinates.success.activation
  })
}

const resolve = (
  operation: SemanticOperationV3.PreparedOperation
): Result.Result<
  {
    readonly coordinates: NativeName.Coordinates
    readonly operationName: string
    readonly bindingName: string
  },
  EffectWorkflowSemanticError
> => {
  if (!SemanticOperationV3.isPrepared(operation)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedOperation,
      "Native semantic mappings require an exact PreparedOperation"
    ))
  }
  const coordinates = SemanticOperationV3.nativeCoordinates(operation)
  if (Result.isFailure(coordinates)) {
    return Result.fail(error(
      ErrorCodes.InvalidNativeCoordinates,
      coordinates.failure.message,
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }
  const operationName = NativeName.name(coordinates.success)
  if (Result.isFailure(operationName)) {
    return Result.fail(error(
      ErrorCodes.InvalidNativeCoordinates,
      operationName.failure.message,
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }
  const bindingName = NativeName.bindingName(coordinates.success)
  if (Result.isFailure(bindingName)) {
    return Result.fail(error(
      ErrorCodes.InvalidNativeCoordinates,
      bindingName.failure.message,
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }
  return Result.succeed({
    coordinates: coordinates.success,
    operationName: operationName.success,
    bindingName: bindingName.success
  })
}

/**
 * Native services required while executing a semantic operation mapping.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements =
  | NativeWorkflowEngine.WorkflowEngine
  | NativeWorkflowEngine.WorkflowInstance

/**
 * Explicit native activity execution options.
 *
 * **Details**
 *
 * Both result schemas and the infrastructure interruption retry schedule are
 * required. The adapter never silently selects the native defaults. Business
 * failure retry/backoff remains a semantic loop that creates the next
 * content-addressed attempt; `interruptRetryPolicy` only governs operational
 * interruption inside that same semantic attempt.
 *
 * @category models
 * @since 4.0.0
 */
export interface ActivityExecutionOptions {
  readonly interruptRetryPolicy: Schedule.Schedule<
    any,
    Cause.Cause<unknown>
  >
}

/**
 * Explicit execution policy for one resolved node handler.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityOptions = ActivityExecutionOptions

/**
 * Explicit worker-side start gate for one managed node attempt.
 *
 * **Details**
 *
 * The gate runs inside the native activity boundary, before the user handler
 * is constructed or evaluated. `undefined` admits the handler; the only
 * early value it may produce is an exact
 * {@link SemanticOperationV3.NodeAttemptTimedOut}. Defects and interruption
 * retain their native `Cause`, while a typed gate failure is deliberately
 * unrepresentable.
 *
 * @category models
 * @since 4.0.0
 */
export interface NodeAttemptStartGateOptions<R = never> extends ActivityExecutionOptions {
  /**
   * Computes the only exact timeout the gate is authorized to return.
   *
   * **Details**
   *
   * It is evaluated only after the gate returns a timeout, allowing an exact
   * expectation to be derived from the gate's canonical durable decision.
   * `undefined` makes the gate admission-only: any early timeout is rejected.
   */
  readonly expectedTimeout: Effect.Effect<
    SemanticOperationV3.NodeAttemptTimedOut | undefined,
    never,
    R
  >
  readonly startGate: Effect.Effect<
    SemanticOperationV3.NodeAttemptTimedOut | undefined,
    never,
    R
  >
}

/**
 * Explicit operational policy for activities participating in a semantic
 * race.
 *
 * **Details**
 *
 * Race membership, order, result contracts, selection mode, and loser
 * disposition are committed by the prepared race descriptor. This option
 * controls only native infrastructure interruption retries for an admitted
 * node activity.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceExecutionOptions = ActivityExecutionOptions

/**
 * First-settled race result retaining the exact winning participant and its
 * complete success, typed failure, or defect exit.
 *
 * @category models
 * @since 4.0.0
 */
export interface FirstSettledRaceWinner {
  readonly _tag: "RaceWinner"
  readonly outcomeEnvelopeVersion: 1
  readonly participantId: string
  readonly index: number
  readonly participantOperationDigest: Wire.OperationDigest
  readonly exit: Exit.Exit<unknown, unknown>
}

/**
 * First-success race result retaining the exact successful participant.
 *
 * @category models
 * @since 4.0.0
 */
export interface FirstSuccessRaceWinner {
  readonly _tag: "RaceWinner"
  readonly outcomeEnvelopeVersion: 1
  readonly participantId: string
  readonly index: number
  readonly participantOperationDigest: Wire.OperationDigest
  readonly value: unknown
}

/**
 * Identified typed failure emitted when every participant of a first-success
 * race fails.
 *
 * @category models
 * @since 4.0.0
 */
export interface FirstSuccessRaceFailure {
  readonly _tag: "RaceFailure"
  readonly outcomeEnvelopeVersion: 1
  readonly participantId: string
  readonly index: number
  readonly participantOperationDigest: Wire.OperationDigest
  readonly error: unknown
}

/**
 * Successful value returned by either semantic race mode.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceResult =
  | FirstSettledRaceWinner
  | FirstSuccessRaceWinner

/**
 * Binds the exact operation digest under stable native coordinates.
 *
 * **Details**
 *
 * On the first execution, the native activity records the current digest. On
 * replay, Effect Workflow returns that recorded digest. A mismatch proves that
 * the same native coordinate acquired different semantic input, policy,
 * duration, codec, contract, or target meaning.
 *
 * Activity bindings use the semantic attempt through
 * `NativeActivity.CurrentAttempt`. Timer and deferred generations already
 * participate in their binding name and therefore use native attempt `1`.
 *
 * @category execution
 * @since 4.0.0
 */
export const bind = (
  operation: SemanticOperationV3.PreparedOperation
): Effect.Effect<
  void,
  EffectWorkflowSemanticError,
  Requirements
> => {
  const resolved = resolve(operation)
  if (Result.isFailure(resolved)) {
    return Effect.fail(resolved.failure)
  }
  const attempt = operation.document._tag === "Activity"
    ? operation.document.attempt
    : 1
  return NativeActivity.make({
    name: resolved.success.bindingName,
    success: Wire.OperationDigest,
    execute: Effect.succeed(operation.operationDigest)
  }).pipe(
    Effect.provideService(NativeActivity.CurrentAttempt, attempt),
    Effect.flatMap((committedDigest) =>
      committedDigest === operation.operationDigest
        ? Effect.void
        : Effect.fail(error(
          ErrorCodes.DescriptorDrift,
          "Native operation coordinates are already bound to a different semantic descriptor",
          {
            operationId: operation.document.operationId,
            currentDigest: operation.operationDigest,
            committedDigest
          }
        ))
    )
  )
}

/**
 * Executes one descriptor-bound semantic activity attempt through native
 * `Activity`.
 *
 * **Details**
 *
 * The exact frozen encoded input comes from the prepared descriptor. The
 * logical name is stable across policy retries and the positive semantic
 * attempt is supplied through `Activity.CurrentAttempt`, so native replay
 * stores each attempt once. The executable registry is responsible for
 * resolving the exact artifact-pinned handler and schemas before calling this
 * mapping.
 *
 * @category execution
 * @since 4.0.0
 */
const nativeResolvedActivity = <A, E, R>(
  resolution: SemanticExecutableRegistryV3.ResolvedActivity,
  operationName: string,
  attempt: Wire.PositiveSafeInt,
  execute: Effect.Effect<A, E, R>,
  options: ActivityExecutionOptions
): Effect.Effect<
  A,
  E,
  | Requirements
  | Exclude<
    R,
    | NativeWorkflowEngine.WorkflowEngine
    | NativeWorkflowEngine.WorkflowInstance
  >
> => {
  const executeWithContext = execute.pipe(
    Effect.updateContext((current) =>
      Context.merge(
        resolution.context,
        current
      ) as Context.Context<any>
    )
  )
  return NativeActivity.make({
    name: operationName,
    success: resolution.successSchema,
    error: resolution.errorSchema,
    execute: executeWithContext,
    interruptRetryPolicy: options.interruptRetryPolicy
  }).pipe(
    Effect.provideService(
      NativeActivity.CurrentAttempt,
      attempt
    ),
    Effect.updateContext((current) =>
      Context.merge(
        resolution.context,
        current
      ) as Context.Context<any>
    )
  ) as Effect.Effect<
    A,
    E,
    | Requirements
    | Exclude<
      R,
      | NativeWorkflowEngine.WorkflowEngine
      | NativeWorkflowEngine.WorkflowInstance
    >
  >
}

const executeResolvedActivity = <A, E, R>(
  resolution: SemanticExecutableRegistryV3.ResolvedActivity,
  execute: Effect.Effect<A, E, R>,
  options: ActivityExecutionOptions
): Effect.Effect<
  A,
  E | EffectWorkflowSemanticError,
  | Requirements
  | Exclude<
    R,
    | NativeWorkflowEngine.WorkflowEngine
    | NativeWorkflowEngine.WorkflowInstance
  >
> => {
  if (!SemanticExecutableRegistryV3.isResolvedActivity(resolution)) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityResolution,
      "Native activity execution requires the exact ResolvedActivity returned by SemanticExecutableRegistryV3"
    ))
  }
  const operation = resolution.operation
  const resolved = resolve(operation)
  if (Result.isFailure(resolved)) {
    return Effect.fail(resolved.failure)
  }
  if (operation.document._tag !== "Activity") {
    return Effect.fail(error(
      ErrorCodes.UnsupportedOperation,
      "Native activity execution requires a prepared Activity operation",
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }
  const native = nativeResolvedActivity(
    resolution,
    resolved.success.operationName,
    operation.document.attempt,
    execute,
    options
  )
  return Effect.andThen(bind(operation), native) as Effect.Effect<
    A,
    E | EffectWorkflowSemanticError,
    | Requirements
    | Exclude<
      R,
      | NativeWorkflowEngine.WorkflowEngine
      | NativeWorkflowEngine.WorkflowInstance
    >
  >
}

type ResolvedNodeExecutionActivity =
  | SemanticExecutableRegistryV3.ResolvedNodeHandlerActivity
  | SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity

const captureNodeOutput = (
  resolution: ResolvedNodeExecutionActivity,
  value: unknown
): Result.Result<
  Readonly<Record<string, unknown>>,
  EffectWorkflowActivityDefect
> => {
  try {
    if (typeof value !== "object" || value === null) {
      return Result.fail(activityDefect(
        resolution,
        ActivityDefectCodes.InvalidOutput,
        "Node handler output must be a plain object"
      ))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return Result.fail(activityDefect(
        resolution,
        ActivityDefectCodes.InvalidOutput,
        "Node handler output must not use an exotic prototype"
      ))
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return Result.fail(activityDefect(
        resolution,
        ActivityDefectCodes.InvalidOutput,
        "Node handler output must not contain symbol properties"
      ))
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const names = Object.getOwnPropertyNames(value).sort()
    const expected = resolution.node.contract.manifest.outputs.map(
      (port) => port.name
    )
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      return Result.fail(activityDefect(
        resolution,
        ActivityDefectCodes.InvalidOutput,
        "Node handler output names must exactly match the artifact manifest"
      ))
    }
    const output: Record<string, unknown> = Object.create(null)
    for (const name of expected) {
      const descriptor = descriptors[name]
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return Result.fail(activityDefect(
          resolution,
          ActivityDefectCodes.InvalidOutput,
          `Node handler output '${name}' must be an enumerable data property`
        ))
      }
      output[name] = descriptor.value
    }
    return Result.succeed(Object.freeze(output))
  } catch {
    return Result.fail(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutput,
      "Node handler output could not be inspected safely"
    ))
  }
}

const prepareNodeHandlerEffect = (
  resolution: ResolvedNodeExecutionActivity,
  operationName: string
): Effect.Effect<
  Effect.Effect<unknown, unknown>,
  never,
  NativeWorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    const document = resolution.operation.document
    if (document._tag !== "Activity") {
      return yield* Effect.die(activityDefect(
        resolution,
        ActivityDefectCodes.InvalidHandler,
        "Resolved node handler does not retain an Activity operation"
      ))
    }
    const semanticNodes = resolution.artifact.artifact.fingerprintDocument.semanticPlan.nodes
    let semanticNode: (typeof semanticNodes)[number] | undefined
    for (const candidate of semanticNodes) {
      if (candidate.id === resolution.node.binding.nodeId) {
        semanticNode = candidate
        break
      }
    }
    if (
      semanticNode === undefined ||
      semanticNode.type !== resolution.node.binding.nodeType ||
      semanticNode.version !== resolution.node.binding.nodeVersion
    ) {
      return yield* Effect.die(activityDefect(
        resolution,
        ActivityDefectCodes.MissingNodeConfiguration,
        "Pinned node configuration is absent or incompatible in the semantic plan"
      ))
    }
    const config = yield* Schema.decodeUnknownEffect(
      resolution.node.contract.config.schema,
      strictParseOptions
    )(semanticNode.config).pipe(
      Effect.mapError((cause) =>
        activityDefect(
          resolution,
          ActivityDefectCodes.InvalidConfiguration,
          `Pinned node configuration is invalid: ${cause.message}`
        )
      ),
      Effect.orDie
    )
    if (document.input._tag === "Blob") {
      return yield* Effect.die(activityDefect(
        resolution,
        ActivityDefectCodes.UnsupportedBlobPayload,
        "Node input blobs require an explicit digest-verifying BlobStore adapter"
      ))
    }
    const inputs = yield* Schema.decodeUnknownEffect(
      resolution.node.contract.inputSchema,
      strictParseOptions
    )(document.input.value).pipe(
      Effect.mapError((cause) =>
        activityDefect(
          resolution,
          ActivityDefectCodes.InvalidInput,
          `Node input aggregate is invalid: ${cause.message}`
        )
      ),
      Effect.orDie
    )
    const idempotencyKey = yield* NativeActivity.idempotencyKey(
      operationName
    )
    const handlerEffect = yield* Effect.try({
      try: () => {
        const candidate = resolution.node.handler({
          config,
          inputs: inputs as Node.InputValues<Node.Any>,
          context: Object.freeze({
            scope: Object.freeze({
              _tag: "Durable" as const,
              tenantId: document.occurrence.document.tenantId,
              handlerDeploymentId: resolution.node.binding.handlerBuild.deploymentId
            }),
            runId: document.occurrence.document.runId,
            planId: resolution.artifact.artifact.fingerprintDocument.semanticPlan.id,
            planRevision: resolution.artifact.artifact.fingerprintDocument.semanticPlan.revision,
            nodeId: resolution.node.binding.nodeId,
            nodeInstanceId: document.occurrence.occurrenceDigest,
            attempt: document.attempt,
            idempotencyKey
          })
        })
        if (!Effect.isEffect(candidate)) {
          throw new TypeError("Handler did not return an Effect")
        }
        return candidate as Effect.Effect<
          unknown,
          unknown,
          unknown
        >
      },
      catch: () =>
        activityDefect(
          resolution,
          ActivityDefectCodes.InvalidHandler,
          "Node handler threw or did not return an Effect"
        )
    }).pipe(Effect.orDie)
    return handlerEffect.pipe(
      Effect.updateContext((current) =>
        Context.merge(
          resolution.node.context,
          current
        ) as Context.Context<any>
      )
    ) as Effect.Effect<unknown, unknown>
  }) as Effect.Effect<
    Effect.Effect<unknown, unknown>,
    never,
    NativeWorkflowEngine.WorkflowInstance
  >

const invokeNodeHandler = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeHandlerActivity,
  operationName: string
): Effect.Effect<
  Readonly<Record<string, unknown>>,
  unknown,
  NativeWorkflowEngine.WorkflowInstance
> =>
  Effect.flatMap(
    prepareNodeHandlerEffect(resolution, operationName),
    (handlerEffect) =>
      Effect.flatMap(handlerEffect, (value) => {
        const captured = captureNodeOutput(resolution, value)
        if (Result.isFailure(captured)) {
          return Effect.die(captured.failure)
        }
        return Schema.encodeUnknownEffect(
          resolution.node.contract.successSchema
        )(captured.success).pipe(
          Effect.mapError((cause) =>
            activityDefect(
              resolution,
              ActivityDefectCodes.InvalidOutput,
              `Node handler output is incompatible with its exact codecs: ${cause.message}`
            )
          ),
          Effect.orDie,
          Effect.as(captured.success)
        )
      })
  ) as Effect.Effect<
    Readonly<Record<string, unknown>>,
    unknown,
    NativeWorkflowEngine.WorkflowInstance
  >

/**
 * Executes one descriptor-bound node-handler attempt through native
 * `Activity`.
 *
 * **Details**
 *
 * Configuration, aggregate inputs, handler, outputs, success schema, and
 * failure schema all come from the exact artifact resolution. Protocol and
 * codec violations become defects; only the handler's own typed failure may
 * enter the persisted application-failure channel.
 *
 * @category execution
 * @since 4.0.0
 */
export const activity = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeHandlerActivity,
  options: ActivityOptions
): Effect.Effect<
  unknown,
  unknown | EffectWorkflowSemanticError,
  Requirements
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "NodeHandler"
  ) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityResolution,
      "Node activity execution requires an exact NodeHandler resolution"
    ))
  }
  const native = resolve(resolution.operation)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  return executeResolvedActivity(
    resolution,
    invokeNodeHandler(resolution, native.success.operationName),
    options
  ) as Effect.Effect<
    unknown,
    unknown | EffectWorkflowSemanticError,
    Requirements
  >
}

const decodeManagedOutcome = Schema.decodeUnknownResult(
  SemanticOperationV3.NodeAttemptOutcome,
  strictParseOptions
)

const admitManagedOutcome = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  input: unknown
): Effect.Effect<SemanticOperationV3.NodeAttemptOutcome> => {
  let admitted: ReturnType<typeof decodeManagedOutcome>
  try {
    admitted = decodeManagedOutcome(input)
  } catch {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node-attempt outcome validation threw unexpectedly"
    ))
  }
  return Result.isFailure(admitted)
    ? Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      `Managed node-attempt outcome is invalid: ${admitted.failure.message}`
    ))
    : Effect.succeed(Object.freeze(admitted.success))
}

const decodeManagedTimeout = Schema.decodeUnknownResult(
  SemanticOperationV3.NodeAttemptTimedOut,
  strictParseOptions
)

const admitManagedTimeout = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  input: unknown,
  expected: SemanticOperationV3.NodeAttemptTimedOut | undefined
): Effect.Effect<SemanticOperationV3.NodeAttemptTimedOut> => {
  let admitted: ReturnType<typeof decodeManagedTimeout>
  try {
    admitted = decodeManagedTimeout(input)
  } catch {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node-attempt start-gate timeout validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(admitted)) {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      `Managed node-attempt start gate may only return an exact timeout: ${admitted.failure.message}`
    ))
  }
  const document = resolution.operation.document
  if (
    document._tag !== "Activity" ||
    admitted.success.attempt !== document.attempt ||
    admitted.success.activityDigest !==
      resolution.operation.operationDigest
  ) {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node-attempt start-gate timeout does not match its exact activity coordinates"
    ))
  }
  if (expected === undefined) {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node-attempt start gate is not authorized to return an early timeout"
    ))
  }
  let admittedExpected: ReturnType<typeof decodeManagedTimeout>
  try {
    admittedExpected = decodeManagedTimeout(expected)
  } catch {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node-attempt expected start-gate timeout validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(admittedExpected)) {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      `Managed node-attempt expected start-gate timeout is invalid: ${admittedExpected.failure.message}`
    ))
  }
  const actual = admitted.success
  const authorized = admittedExpected.success
  if (
    actual.attempt !== authorized.attempt ||
    actual.activityDigest !== authorized.activityDigest ||
    actual.timeout.attempt !== authorized.timeout.attempt ||
    actual.timeout.activityDigest !==
      authorized.timeout.activityDigest ||
    actual.timeout.timeoutKind !==
      authorized.timeout.timeoutKind ||
    actual.timerOperationDigest !==
      authorized.timerOperationDigest ||
    actual.deadline !== authorized.deadline ||
    actual.durationMillis !== authorized.durationMillis
  ) {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node-attempt start-gate timeout does not match its exact authorized timer, duration, and deadline"
    ))
  }
  return Effect.succeed(Object.freeze(admitted.success))
}

const encodeManagedInline = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  schema: Schema.Top,
  value: unknown,
  defectCode:
    | typeof ActivityDefectCodes.InvalidOutput
    | typeof ActivityDefectCodes.InvalidFailure,
  label: string
): Effect.Effect<Wire.InlineEncodedPayload> => {
  const encoded = Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.updateContext((current) =>
      Context.merge(
        resolution.node.contract.resultCodecContext,
        current
      ) as Context.Context<any>
    ),
    Effect.mapError((cause) =>
      activityDefect(
        resolution,
        defectCode,
        `${label} is incompatible with its exact codecs: ${cause.message}`
      )
    ),
    Effect.orDie
  ) as Effect.Effect<unknown>
  return Effect.flatMap(encoded, (result) => {
    const snapshot = Json.snapshot(result)
    return Result.isFailure(snapshot)
      ? Effect.die(activityDefect(
        resolution,
        defectCode,
        `${label} codec must produce bounded strict JSON: ${snapshot.failure.message}`
      ))
      : Effect.succeed(Object.freeze({
        _tag: "Inline",
        value: snapshot.success
      }) as Wire.InlineEncodedPayload)
  })
}

const managedCompletionTimestamp = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
): Effect.Effect<Wire.Timestamp> =>
  Effect.flatMap(
    Clock.currentTimeMillis,
    (millis) =>
      Effect.try({
        try: () =>
          DateTime.formatIso(
            DateTime.makeUnsafe(millis)
          ) as Wire.Timestamp,
        catch: () =>
          activityDefect(
            resolution,
            ActivityDefectCodes.InvalidOutcome,
            "Managed node-attempt completion time could not be represented as canonical UTC milliseconds"
          )
      }).pipe(Effect.orDie)
  )

const managedSuccess = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  value: unknown
): Effect.Effect<SemanticOperationV3.NodeAttemptOutcome> => {
  const captured = captureNodeOutput(resolution, value)
  if (Result.isFailure(captured)) {
    return Effect.die(captured.failure)
  }
  const document = resolution.operation.document
  if (document._tag !== "Activity") {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node attempt no longer retains an Activity descriptor"
    ))
  }
  return Effect.gen(function*() {
    const output = yield* encodeManagedInline(
      resolution,
      resolution.node.contract.successSchema,
      captured.success,
      ActivityDefectCodes.InvalidOutput,
      "Node handler output"
    )
    return yield* admitManagedOutcome(resolution, {
      _tag: "Succeeded",
      outcomeVersion: 2,
      attempt: document.attempt,
      activityDigest: resolution.operation.operationDigest,
      completedAt: yield* managedCompletionTimestamp(resolution),
      output
    })
  })
}

const managedFailure = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  failure: unknown
): Effect.Effect<SemanticOperationV3.NodeAttemptOutcome> => {
  const document = resolution.operation.document
  if (document._tag !== "Activity") {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Managed node attempt no longer retains an Activity descriptor"
    ))
  }
  return Effect.gen(function*() {
    const encodedFailure = yield* encodeManagedInline(
      resolution,
      resolution.node.contract.failure.schema,
      failure,
      ActivityDefectCodes.InvalidFailure,
      "Node handler failure"
    )
    const identity = ActivityPolicyV3.extractFailureIdentity(
      resolution.node.binding.activityPolicy.retry.failureIdentity,
      encodedFailure.value
    )
    if (Result.isFailure(identity)) {
      return yield* Effect.die(activityDefect(
        resolution,
        ActivityDefectCodes.InvalidFailureIdentity,
        `Could not derive the policy-pinned failure identity: ${identity.failure.message}`
      ))
    }
    const applicationFailure = {
      _tag: "ApplicationFailure",
      failureCauseVersion: 1,
      activityDigest: resolution.operation.operationDigest,
      attempt: document.attempt,
      identity: identity.success,
      failure: encodedFailure
    } satisfies ActivityPolicyV3.ApplicationFailure
    return yield* admitManagedOutcome(resolution, {
      _tag: "ApplicationFailed",
      outcomeVersion: 2,
      attempt: document.attempt,
      activityDigest: resolution.operation.operationDigest,
      completedAt: yield* managedCompletionTimestamp(resolution),
      failure: applicationFailure
    })
  })
}

const verifyManagedOutcomeCoordinates = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  outcome: SemanticOperationV3.NodeAttemptOutcome
): Effect.Effect<SemanticOperationV3.NodeAttemptOutcome> => {
  const document = resolution.operation.document
  if (
    document._tag !== "Activity" ||
    outcome.attempt !== document.attempt ||
    outcome.activityDigest !== resolution.operation.operationDigest
  ) {
    return Effect.die(activityDefect(
      resolution,
      ActivityDefectCodes.InvalidOutcome,
      "Persisted managed node-attempt outcome does not match its exact activity coordinates"
    ))
  }
  return Effect.succeed(outcome)
}

const executeNodeAttempt = <R>(
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  options: ActivityExecutionOptions,
  startGate?: Effect.Effect<
    SemanticOperationV3.NodeAttemptTimedOut | undefined,
    never,
    R
  >,
  expectedTimeout?: Effect.Effect<
    SemanticOperationV3.NodeAttemptTimedOut | undefined,
    never,
    R
  >
): Effect.Effect<
  SemanticOperationV3.NodeAttemptOutcome,
  EffectWorkflowSemanticError,
  | Requirements
  | Exclude<
    R,
    | NativeWorkflowEngine.WorkflowEngine
    | NativeWorkflowEngine.WorkflowInstance
  >
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "NodeAttempt"
  ) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityResolution,
      startGate === undefined
        ? "Managed node-attempt execution requires an exact NodeAttempt resolution"
        : "Managed node-attempt start gate requires an exact NodeAttempt resolution"
    ))
  }
  const native = resolve(resolution.operation)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  const executeHandler = Effect.flatMap(
    prepareNodeHandlerEffect(
      resolution,
      native.success.operationName
    ),
    (handlerEffect) =>
      Effect.matchEffect(handlerEffect, {
        onSuccess: (value) => managedSuccess(resolution, value),
        onFailure: (failure) => managedFailure(resolution, failure)
      })
  )
  const execute: Effect.Effect<
    SemanticOperationV3.NodeAttemptOutcome,
    never,
    | R
    | NativeWorkflowEngine.WorkflowInstance
  > = startGate === undefined
    ? executeHandler
    : Effect.gen(function*() {
      const early = yield* startGate
      if (early === undefined) {
        return yield* executeHandler
      }
      const expected = yield* (
        expectedTimeout ?? Effect.succeed(undefined)
      )
      return yield* admitManagedTimeout(
        resolution,
        early,
        expected
      )
    })
  return Effect.flatMap(
    executeResolvedActivity(
      resolution,
      execute,
      options
    ),
    (outcome) => verifyManagedOutcomeCoordinates(resolution, outcome)
  ) as Effect.Effect<
    SemanticOperationV3.NodeAttemptOutcome,
    EffectWorkflowSemanticError,
    | Requirements
    | Exclude<
      R,
      | NativeWorkflowEngine.WorkflowEngine
      | NativeWorkflowEngine.WorkflowInstance
    >
  >
}

/**
 * Executes one managed node attempt whose complete business outcome is
 * persisted in the native activity success channel.
 *
 * **Details**
 *
 * Configuration, input, handler construction, and idempotency context are
 * validated before the handler Effect is matched. Only the handler's typed
 * failure is converted to `ApplicationFailed`; interruption and defects retain
 * their native `Cause`. Exact output/failure codecs run once inside the native
 * activity and produce detached inline JSON before persistence. Replay returns
 * that recorded outcome without invoking the handler or either business codec.
 *
 * @category execution
 * @since 4.0.0
 */
export const nodeAttempt = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  options: ActivityOptions
): Effect.Effect<
  SemanticOperationV3.NodeAttemptOutcome,
  EffectWorkflowSemanticError,
  Requirements
> =>
  executeNodeAttempt<never>(
    resolution,
    options
  ) as Effect.Effect<
    SemanticOperationV3.NodeAttemptOutcome,
    EffectWorkflowSemanticError,
    Requirements
  >

/**
 * Executes one managed node attempt behind an explicit worker-side start
 * gate.
 *
 * **Details**
 *
 * The gate is part of the native activity execution and runs immediately
 * before handler preparation, so an admitted timeout prevents even
 * synchronous handler construction. It may only return `undefined` to
 * proceed or an exact `NodeAttemptTimedOut` to finish early; in particular it
 * cannot manufacture a node success or application failure. A timeout must
 * equal `expectedTimeout` across its activity, attempt, timer, kind, duration,
 * and absolute deadline; `undefined` authorizes no timeout. The persisted
 * outcome is subsequently checked against the resolved attempt's coordinates
 * just like {@link nodeAttempt}.
 *
 * This extension is intentionally separate: callers that do not need a
 * worker handshake retain the direct, zero-gate {@link nodeAttempt} path.
 *
 * @category execution
 * @since 4.0.0
 */
export const nodeAttemptWithStartGate = <R>(
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  options: NodeAttemptStartGateOptions<R>
): Effect.Effect<
  SemanticOperationV3.NodeAttemptOutcome,
  EffectWorkflowSemanticError,
  | Requirements
  | Exclude<
    R,
    | NativeWorkflowEngine.WorkflowEngine
    | NativeWorkflowEngine.WorkflowInstance
  >
> =>
  executeNodeAttempt(
    resolution,
    options,
    options.startGate,
    options.expectedTimeout
  )

const decodeInlineActivityInput = <A>(
  resolution: SemanticExecutableRegistryV3.ResolvedActivity,
  schema: Schema.Codec<A, unknown, never, never>,
  label: string
): Result.Result<A, EffectWorkflowSemanticError> => {
  const document = resolution.operation.document
  if (document._tag !== "Activity") {
    return Result.fail(error(
      ErrorCodes.InvalidActivityResolution,
      `${label} resolution does not retain an Activity operation`
    ))
  }
  if (document.input._tag === "Blob") {
    return Result.fail(error(
      ErrorCodes.UnsupportedBlobPayload,
      `${label} cannot materialize a blob payload without an explicit digest-verifying BlobStore adapter`,
      {
        operationId: document.operationId,
        currentDigest: resolution.operation.operationDigest
      }
    ))
  }
  let decoded: Result.Result<A, Schema.SchemaError>
  try {
    decoded = Schema.decodeUnknownResult(schema, strictParseOptions)(
      document.input.value
    )
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidActivityInput,
      `${label} input validation threw unexpectedly`,
      {
        operationId: document.operationId,
        currentDigest: resolution.operation.operationDigest
      }
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      ErrorCodes.InvalidActivityInput,
      `Invalid ${label} input: ${decoded.failure.message}`,
      {
        operationId: document.operationId,
        currentDigest: resolution.operation.operationDigest
      }
    ))
    : Result.succeed(decoded.success)
}

/**
 * Runs one exact retry classifier as a replay-recorded native activity.
 *
 * @category execution
 * @since 4.0.0
 */
export const retryClassifier = (
  resolution: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  options: ActivityExecutionOptions
): Effect.Effect<
  ActivityPolicyV3.RetryClassification,
  EffectWorkflowSemanticError,
  Requirements
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "RetryClassifier"
  ) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityResolution,
      "Retry classification requires an exact RetryClassifier resolution"
    ))
  }
  const input = decodeInlineActivityInput(
    resolution,
    ActivityPolicyV3.RetryFailureCause,
    "retry-classifier"
  )
  if (Result.isFailure(input)) return Effect.fail(input.failure)
  const classified = Effect.suspend(() => resolution.executable.classifier(input.success))
  return executeResolvedActivity(
    resolution,
    classified,
    options
  ) as Effect.Effect<
    ActivityPolicyV3.RetryClassification,
    EffectWorkflowSemanticError,
    Requirements
  >
}

/**
 * Selects and records one delay inside the exact deterministic policy range.
 *
 * **Details**
 *
 * Entropy comes from Effect's `Random` service inside the native activity.
 * The selected value is admitted against the inclusive range before
 * persistence and is therefore returned unchanged during replay. Tests may
 * use `Random.withSeed` or provide the standard `Random` service; callers
 * cannot inject a semantic selection callback.
 *
 * @category execution
 * @since 4.0.0
 */
export const retryDelaySelection = (
  resolution: SemanticExecutableRegistryV3.ResolvedRetryDelaySelectionActivity,
  options: ActivityExecutionOptions
): Effect.Effect<
  ActivityPolicyV3.RecordedRetryDelay,
  EffectWorkflowSemanticError,
  Requirements
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "RetryDelaySelection"
  ) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityResolution,
      "Retry-delay selection requires an exact RetryDelaySelection resolution"
    ))
  }
  const input = decodeInlineActivityInput(
    resolution,
    ActivityPolicyV3.RetryDelayInput,
    "retry-delay selection"
  )
  if (Result.isFailure(input)) return Effect.fail(input.failure)
  const range = ActivityPolicyV3.retryDelayRange(
    resolution.node.binding.activityPolicy,
    input.success
  )
  if (Result.isFailure(range)) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityInput,
      `Retry-delay policy evaluation failed: ${range.failure.message}`,
      {
        operationId: resolution.operation.document.operationId,
        currentDigest: resolution.operation.operationDigest
      }
    ))
  }
  if (range.success._tag === "DoNotRetry") {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityInput,
      `Retry-delay selection was requested after policy denial '${range.success.reason}'`,
      {
        operationId: resolution.operation.document.operationId,
        currentDigest: resolution.operation.operationDigest
      }
    ))
  }
  const admittedRange = range.success

  const selection = admittedRange.minimumDelayMillis ===
      admittedRange.maximumDelayMillis
    ? Effect.succeed(admittedRange.minimumDelayMillis)
    : Random.nextIntBetween(
      admittedRange.minimumDelayMillis,
      admittedRange.maximumDelayMillis
    )
  const selected = Effect.flatMap(
    selection,
    (delayMillis) => {
      const admitted = ActivityPolicyV3.admitRecordedRetryDelay(
        resolution.node.binding.activityPolicy,
        input.success,
        delayMillis
      )
      return Result.isFailure(admitted)
        ? Effect.die(admitted.failure)
        : Effect.succeed(admitted.success)
    }
  )
  return executeResolvedActivity(
    resolution,
    selected,
    options
  ) as Effect.Effect<
    ActivityPolicyV3.RecordedRetryDelay,
    EffectWorkflowSemanticError,
    Requirements
  >
}

/**
 * Records one canonical wall-clock observation through native activity replay.
 *
 * @category execution
 * @since 4.0.0
 */
export const timeObservation = (
  resolution: SemanticExecutableRegistryV3.ResolvedTimeObservationActivity,
  options: ActivityExecutionOptions
): Effect.Effect<
  Wire.Timestamp,
  EffectWorkflowSemanticError,
  Requirements
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "TimeObservation"
  ) {
    return Effect.fail(error(
      ErrorCodes.InvalidActivityResolution,
      "Time observation requires an exact TimeObservation resolution"
    ))
  }
  const input = decodeInlineActivityInput(
    resolution,
    Schema.Null,
    "time-observation"
  )
  if (Result.isFailure(input)) return Effect.fail(input.failure)

  const observed = Effect.flatMap(
    Clock.currentTimeMillis,
    (millis) =>
      Effect.sync(() => {
        const timestamp = new Date(millis).toISOString()
        const decoded = Schema.decodeUnknownResult(
          Wire.Timestamp,
          strictParseOptions
        )(timestamp)
        if (Result.isFailure(decoded)) throw decoded.failure
        return decoded.success
      })
  )
  return executeResolvedActivity(
    resolution,
    observed,
    options
  ) as Effect.Effect<
    Wire.Timestamp,
    EffectWorkflowSemanticError,
    Requirements
  >
}

const makeResolvedDeferred = (
  resolution: SemanticExecutableRegistryV3.ResolvedDeferredCodecs
): Result.Result<
  {
    readonly operation: SemanticOperationV3.PreparedOperation
    readonly deferred: NativeDeferred.DurableDeferred<
      Schema.Top,
      Schema.Top
    >
  },
  EffectWorkflowSemanticError
> => {
  if (!SemanticExecutableRegistryV3.isResolvedDeferredCodecs(resolution)) {
    return Result.fail(error(
      ErrorCodes.InvalidActivityResolution,
      "Native deferred execution requires the exact ResolvedDeferredCodecs returned by SemanticExecutableRegistryV3"
    ))
  }
  const operation = resolution.operation
  const native = resolve(operation)
  if (Result.isFailure(native)) return Result.fail(native.failure)
  if (operation.document._tag !== "Deferred") {
    return Result.fail(error(
      ErrorCodes.UnsupportedOperation,
      "Native deferred execution requires a prepared Deferred operation",
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }
  return Result.succeed({
    operation,
    deferred: NativeDeferred.make(native.success.operationName, {
      success: resolution.success.schema,
      error: resolution.error.schema
    })
  })
}

/**
 * Awaits one exact descriptor-bound durable deferred generation.
 *
 * @category execution
 * @since 4.0.0
 */
export const awaitDeferred = (
  resolution: SemanticExecutableRegistryV3.ResolvedDeferredCodecs
): Effect.Effect<
  unknown,
  unknown | EffectWorkflowSemanticError,
  Requirements
> => {
  const native = makeResolvedDeferred(resolution)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  const awaited = NativeDeferred.await(native.success.deferred).pipe(
    Effect.updateContext((current) => Context.merge(resolution.context, current))
  )
  return Effect.andThen(
    bind(native.success.operation),
    awaited
  ) as Effect.Effect<
    unknown,
    unknown | EffectWorkflowSemanticError,
    Requirements
  >
}

/**
 * Exposes the completion token of one exact descriptor-bound deferred.
 *
 * **Details**
 *
 * The descriptor digest is bound before the token is returned, preventing a
 * stable native deferred name from being exposed under changed codec meaning.
 *
 * @category execution
 * @since 4.0.0
 */
export const deferredToken = (
  resolution: SemanticExecutableRegistryV3.ResolvedDeferredCodecs
): Effect.Effect<
  NativeDeferred.Token,
  EffectWorkflowSemanticError,
  Requirements
> => {
  const native = makeResolvedDeferred(resolution)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  return Effect.andThen(
    bind(native.success.operation),
    NativeDeferred.token(native.success.deferred)
  )
}

const decodeDeferredToken = (
  input: unknown,
  expectedName: string
): Result.Result<
  NativeDeferred.Token,
  EffectWorkflowSemanticError
> => {
  if (
    typeof input !== "string" ||
    input.length > Wire.MaximumIdentifierBytes * 4
  ) {
    return Result.fail(error(
      ErrorCodes.InvalidDeferredToken,
      "Deferred token must be a bounded string"
    ))
  }
  let parsed: Result.Result<
    NativeDeferred.TokenParsed,
    Schema.SchemaError
  >
  try {
    parsed = Schema.decodeUnknownResult(
      NativeDeferred.TokenParsed.FromString,
      strictParseOptions
    )(input)
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidDeferredToken,
      "Deferred token validation threw unexpectedly"
    ))
  }
  if (
    Result.isFailure(parsed) ||
    parsed.success.deferredName !== expectedName ||
    parsed.success.asToken !== input
  ) {
    return Result.fail(error(
      ErrorCodes.InvalidDeferredToken,
      "Deferred token is invalid, non-canonical, or addresses a different semantic deferred"
    ))
  }
  return Result.succeed(input as NativeDeferred.Token)
}

const validateDeferredCompletion = (
  resolution: SemanticExecutableRegistryV3.ResolvedDeferredCodecs,
  schema: Schema.Top,
  value: unknown,
  label: "success" | "failure"
): Effect.Effect<
  void,
  EffectWorkflowSemanticError
> =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      error(
        ErrorCodes.InvalidDeferredCompletion,
        `Deferred ${label} does not satisfy its exact artifact codec: ${cause.message}`,
        {
          operationId: resolution.operation.document.operationId,
          currentDigest: resolution.operation.operationDigest
        }
      )
    ),
    Effect.updateContext((current) =>
      Context.merge(
        resolution.context,
        current
      ) as Context.Context<any>
    )
  ) as Effect.Effect<void, EffectWorkflowSemanticError>

/**
 * Completes one descriptor-bound deferred with an exact typed success.
 *
 * **Details**
 *
 * This boundary validates the canonical token and success codec before
 * delegating storage and wake-up to the injected native `WorkflowEngine`.
 * Authorization remains an explicit application ingress policy.
 *
 * @category execution
 * @since 4.0.0
 */
export const succeedDeferred = (
  resolution: SemanticExecutableRegistryV3.ResolvedDeferredCodecs,
  tokenInput: unknown,
  value: unknown
): Effect.Effect<
  void,
  EffectWorkflowSemanticError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const native = makeResolvedDeferred(resolution)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  const token = decodeDeferredToken(
    tokenInput,
    native.success.deferred.name
  )
  if (Result.isFailure(token)) return Effect.fail(token.failure)
  return Effect.andThen(
    validateDeferredCompletion(
      resolution,
      resolution.success.schema,
      value,
      "success"
    ),
    NativeDeferred.succeed(native.success.deferred, {
      token: token.success,
      value
    }).pipe(
      Effect.updateContext((current) =>
        Context.merge(
          resolution.context,
          current
        ) as Context.Context<any>
      )
    )
  ) as Effect.Effect<
    void,
    EffectWorkflowSemanticError,
    NativeWorkflowEngine.WorkflowEngine
  >
}

/**
 * Completes one descriptor-bound deferred with an exact typed failure.
 *
 * @category execution
 * @since 4.0.0
 */
export const failDeferred = (
  resolution: SemanticExecutableRegistryV3.ResolvedDeferredCodecs,
  tokenInput: unknown,
  failure: unknown
): Effect.Effect<
  void,
  EffectWorkflowSemanticError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const native = makeResolvedDeferred(resolution)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  const token = decodeDeferredToken(
    tokenInput,
    native.success.deferred.name
  )
  if (Result.isFailure(token)) return Effect.fail(token.failure)
  return Effect.andThen(
    validateDeferredCompletion(
      resolution,
      resolution.error.schema,
      failure,
      "failure"
    ),
    NativeDeferred.fail(native.success.deferred, {
      token: token.success,
      error: failure
    }).pipe(
      Effect.updateContext((current) =>
        Context.merge(
          resolution.context,
          current
        ) as Context.Context<any>
      )
    )
  ) as Effect.Effect<
    void,
    EffectWorkflowSemanticError,
    NativeWorkflowEngine.WorkflowEngine
  >
}

const raceParticipantOperation = (
  participant: SemanticExecutableRegistryV3.ResolvedRaceParticipant
): SemanticOperationV3.PreparedOperation =>
  SemanticExecutableRegistryV3.isResolvedActivity(participant)
    ? participant.operation
    : SemanticExecutableRegistryV3.isResolvedDeferredCodecs(participant)
    ? participant.operation
    : participant

const prepareBoundRaceParticipant = (
  participant: SemanticExecutableRegistryV3.ResolvedRaceParticipant,
  options: RaceExecutionOptions
): Result.Result<
  Effect.Effect<unknown, unknown, Requirements>,
  EffectWorkflowSemanticError
> => {
  if (SemanticExecutableRegistryV3.isResolvedActivity(participant)) {
    if (participant._tag !== "NodeHandler") {
      return Result.fail(error(
        ErrorCodes.InvalidRaceResolution,
        "Only resolved node-handler activities may execute as race participants"
      ))
    }
    const operation = participant.operation
    const native = resolve(operation)
    if (Result.isFailure(native)) return Result.fail(native.failure)
    if (operation.document._tag !== "Activity") {
      return Result.fail(error(
        ErrorCodes.InvalidRaceResolution,
        "Resolved race activity no longer retains an Activity descriptor",
        {
          operationId: operation.document.operationId,
          currentDigest: operation.operationDigest
        }
      ))
    }
    return Result.succeed(nativeResolvedActivity(
      participant,
      native.success.operationName,
      operation.document.attempt,
      invokeNodeHandler(
        participant,
        native.success.operationName
      ),
      options
    ) as Effect.Effect<unknown, unknown, Requirements>)
  }
  if (
    SemanticExecutableRegistryV3.isResolvedDeferredCodecs(participant)
  ) {
    const native = makeResolvedDeferred(participant)
    if (Result.isFailure(native)) return Result.fail(native.failure)
    return Result.succeed(
      NativeDeferred.await(native.success.deferred).pipe(
        Effect.updateContext((current) =>
          Context.merge(
            participant.context,
            current
          ) as Context.Context<any>
        )
      ) as Effect.Effect<unknown, unknown, Requirements>
    )
  }
  if (
    SemanticOperationV3.isPrepared(participant) &&
    participant.document._tag === "Timer"
  ) {
    const native = resolve(participant)
    if (Result.isFailure(native)) return Result.fail(native.failure)
    return Result.succeed(
      NativeClock.sleep({
        name: native.success.operationName,
        duration: Duration.millis(
          participant.document.delayMillis
        ),
        inMemoryThreshold: Duration.zero
      }) as Effect.Effect<void, never, Requirements>
    )
  }
  return Result.fail(error(
    ErrorCodes.InvalidRaceResolution,
    "Race resolution retained an unsupported or unproven participant"
  ))
}

const raceIdentity = (
  descriptor: SemanticOperationV3.RaceParticipant,
  index: number
) => ({
  outcomeEnvelopeVersion: 1 as const,
  participantId: descriptor.participantId,
  index,
  participantOperationDigest: descriptor.operationDigest
})

const firstSettledParticipant = (
  participant: Effect.Effect<unknown, unknown, Requirements>,
  descriptor: SemanticOperationV3.RaceParticipant,
  index: number
): Effect.Effect<
  FirstSettledRaceWinner,
  never,
  Requirements
> =>
  participant.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause)
        }
        const nonInterruptReasons = cause.reasons.filter(
          (reason) => !Cause.isInterruptReason(reason)
        )
        if (nonInterruptReasons.length === 0) {
          return Effect.failCause(cause)
        }
        return Effect.succeed({
          _tag: "RaceWinner" as const,
          ...raceIdentity(descriptor, index),
          exit: Exit.failCause(Cause.fromReasons(nonInterruptReasons))
        })
      },
      onSuccess: (value) =>
        Effect.succeed({
          _tag: "RaceWinner" as const,
          ...raceIdentity(descriptor, index),
          exit: Exit.succeed(value)
        })
    })
  ) as unknown as Effect.Effect<
    FirstSettledRaceWinner,
    never,
    Requirements
  >

const firstSuccessParticipant = (
  participant: Effect.Effect<unknown, unknown, Requirements>,
  descriptor: SemanticOperationV3.RaceParticipant,
  index: number
): Effect.Effect<
  FirstSuccessRaceWinner,
  FirstSuccessRaceFailure,
  Requirements
> =>
  participant.pipe(
    Effect.mapBoth({
      onFailure: (failure) => ({
        _tag: "RaceFailure" as const,
        ...raceIdentity(descriptor, index),
        error: failure
      }),
      onSuccess: (value) => ({
        _tag: "RaceWinner" as const,
        ...raceIdentity(descriptor, index),
        value
      })
    })
  )

/**
 * Executes one authenticated semantic race through native
 * `DurableDeferred.raceAll`.
 *
 * **Details**
 *
 * The API accepts no effects, callbacks, schemas, or caller-authored
 * participant wrappers. Membership and order come from the exact
 * {@link SemanticExecutableRegistryV3.ResolvedRace}. The race descriptor and
 * every participant descriptor are bound sequentially before any participant
 * may execute.
 *
 * `FirstSettled` turns each non-interrupt completion into an identified
 * winner containing its complete `Exit`; pure suspension/interruption remains
 * an interruption and cannot become a winner. `FirstSuccess` delegates the
 * usual first-success rule while retaining participant identity on successes
 * and typed failures.
 *
 * Native loser interruption stops waiting fibers only. It does not claim to
 * roll back external side effects or durably cancel already dispatched work.
 *
 * @category execution
 * @since 4.0.0
 */
export const race = (
  resolution: SemanticExecutableRegistryV3.ResolvedRace,
  options: RaceExecutionOptions
): Effect.Effect<
  RaceResult,
  FirstSuccessRaceFailure | EffectWorkflowSemanticError,
  Requirements
> => {
  if (!SemanticExecutableRegistryV3.isResolvedRace(resolution)) {
    return Effect.fail(error(
      ErrorCodes.InvalidRaceResolution,
      "Native race execution requires the exact ResolvedRace returned by SemanticExecutableRegistryV3"
    ))
  }
  const operation = resolution.operation
  const native = resolve(operation)
  if (Result.isFailure(native)) return Effect.fail(native.failure)
  const document = operation.document
  if (
    document._tag !== "Race" ||
    document.participants.length !== resolution.participants.length
  ) {
    return Effect.fail(error(
      ErrorCodes.InvalidRaceResolution,
      "Resolved race membership no longer matches its prepared descriptor",
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }

  const preparedParticipants: Array<
    Effect.Effect<unknown, unknown, Requirements>
  > = []
  for (const participant of resolution.participants) {
    const prepared = prepareBoundRaceParticipant(
      participant,
      options
    )
    if (Result.isFailure(prepared)) {
      return Effect.fail(prepared.failure)
    }
    preparedParticipants.push(prepared.success)
  }
  const effects = preparedParticipants.map((participant, index) => {
    const descriptor = document.participants[index]!
    return document.mode === "FirstSettled"
      ? firstSettledParticipant(
        participant,
        descriptor,
        index
      )
      : firstSuccessParticipant(
        participant,
        descriptor,
        index
      )
  })
  if (effects.length === 0) {
    return Effect.fail(error(
      ErrorCodes.InvalidRaceResolution,
      "Semantic races require at least one authenticated participant"
    ))
  }
  const participants = effects as [
    Effect.Effect<unknown, unknown, Requirements>,
    ...Array<Effect.Effect<unknown, unknown, Requirements>>
  ]
  const prebind = Effect.forEach(
    resolution.participants,
    (participant) => bind(raceParticipantOperation(participant)),
    { concurrency: 1, discard: true }
  )
  const raced = NativeDeferred.raceAll({
    name: native.success.operationName,
    success: resolution.successSchema as Schema.Schema<any>,
    error: resolution.errorSchema as Schema.Schema<any>,
    effects: participants
  }).pipe(
    Effect.updateContext((current) => Context.merge(resolution.context, current))
  )
  return Effect.andThen(
    bind(operation),
    Effect.andThen(prebind, raced)
  ) as Effect.Effect<
    RaceResult,
    FirstSuccessRaceFailure | EffectWorkflowSemanticError,
    Requirements
  >
}

/**
 * Executes a positive semantic timer through native `DurableClock`.
 *
 * **Details**
 *
 * The operation is descriptor-bound first. `inMemoryThreshold` is always zero,
 * so even short business timers use the native durable-clock path. Zero-delay
 * transitions are rejected by the timer descriptor and remain immediate
 * semantic decisions.
 *
 * @category execution
 * @since 4.0.0
 */
export const sleep = (
  operation: SemanticOperationV3.PreparedOperation
): Effect.Effect<
  void,
  EffectWorkflowSemanticError,
  Requirements
> => {
  const resolved = resolve(operation)
  if (Result.isFailure(resolved)) {
    return Effect.fail(resolved.failure)
  }
  if (operation.document._tag !== "Timer") {
    return Effect.fail(error(
      ErrorCodes.UnsupportedOperation,
      "Native durable sleep requires a prepared Timer operation",
      {
        operationId: operation.document.operationId,
        currentDigest: operation.operationDigest
      }
    ))
  }
  return Effect.andThen(
    bind(operation),
    NativeClock.sleep({
      name: resolved.success.operationName,
      duration: Duration.millis(operation.document.delayMillis),
      inMemoryThreshold: Duration.zero
    })
  )
}
