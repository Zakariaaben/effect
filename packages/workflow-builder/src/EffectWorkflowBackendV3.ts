/**
 * Thin protocol-version `3` execution host over native Effect Workflow.
 *
 * **Details**
 *
 * This module registers and addresses an already-admitted semantic run through
 * the public `effect/unstable/workflow` API. It deliberately owns no journal,
 * persistence driver, activity cache, clock, deferred, queue, lease, sharding,
 * or failover implementation. Applications provide the native
 * `WorkflowEngine` layer.
 *
 * The semantic handler remains responsible for interpreting the pinned
 * artifact. Start-request conflict admission must happen before this adapter:
 * the native tenant/run idempotency key deduplicates execution but is not a
 * same-run/different-request conflict ledger.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import type * as NativeWorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Json from "./internal/json.ts"
import * as PlanStoreV3 from "./PlanStoreV3.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const preparedBindings = new WeakMap<object, NativeRunWorkflow>()
const preparedArtifacts = new WeakMap<
  object,
  PlanStoreV3.VerifiedArtifact
>()
const semanticExecutions = new WeakSet<object>()

/**
 * Independent format version of this native adapter.
 *
 * @category constants
 * @since 4.0.0
 */
export const AdapterVersion = 1 as const

/**
 * Execution protocol hosted by this adapter.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 3 as const

/**
 * Stable native workflow-tag prefix for adapter version `1` and protocol
 * version `3`.
 *
 * @category constants
 * @since 4.0.0
 */
export const WorkflowTagPrefix = "@effect/workflow-builder/effect-workflow/v3/a1/" as const

/**
 * Caller-owned coordinates and input supplied after authoritative start
 * admission.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunInvocation = Schema.Struct({
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier,
  requestId: Wire.SourceEventIdentifier,
  input: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowEffectBackendV3RunInvocation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunInvocation}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunInvocation = Schema.Schema.Type<typeof RunInvocation>

/**
 * Exact native workflow payload after the prepared binding supplies its
 * artifact pin.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunRequest = Schema.Struct({
  adapterVersion: Schema.Literal(AdapterVersion),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier,
  requestId: Wire.SourceEventIdentifier,
  artifactDigest: Wire.ArtifactDigest,
  input: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowEffectBackendV3RunRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunRequest = Schema.Schema.Type<typeof RunRequest>

/**
 * Checked successful terminal envelope returned by a semantic handler.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunSuccess = Schema.TaggedStruct("Completed", {
  completionVersion: Schema.Literal(1),
  outputContractDigest: Wire.ContractDigest,
  output: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowEffectBackendV3RunSuccess",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunSuccess}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunSuccess = Schema.Schema.Type<typeof RunSuccess>

/**
 * Terminal failure categories crossing the native workflow error boundary.
 *
 * **Details**
 *
 * Success, business failure, timeout, cancellation, and compensation branches
 * remain semantic control-flow outcomes while the run can continue. This
 * envelope represents only a terminal native workflow failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunFailureKind = Schema.Literals([
  "BusinessFailure",
  "ProtocolFailure",
  "PolicyFailure",
  "AdapterInvariant"
]).annotate({ identifier: "WorkflowEffectBackendV3RunFailureKind" })

/**
 * The decoded type of {@link RunFailureKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunFailureKind = Schema.Schema.Type<typeof RunFailureKind>

/**
 * Checked terminal failure envelope returned by a semantic handler.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunFailure = Schema.TaggedStruct("Failed", {
  failureVersion: Schema.Literal(1),
  failureKind: RunFailureKind,
  failure: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowEffectBackendV3RunFailure",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunFailure = Schema.Schema.Type<typeof RunFailure>

type NativeRunWorkflow = NativeWorkflow.Workflow<
  string,
  typeof RunRequest,
  typeof RunSuccess,
  typeof RunFailure
>

/**
 * Process-local prepared native binding for one exact verified artifact.
 *
 * **Details**
 *
 * The public fields are inspectable diagnostics. Authority comes from
 * {@link prepare}, whose exact returned object is retained in a private
 * `WeakMap`. Structural copies are rejected.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedBinding {
  readonly adapterVersion: typeof AdapterVersion
  readonly executionProtocolVersion: typeof ExecutionProtocolVersion
  readonly workflowTag: string
  readonly artifactDigest: Wire.ArtifactDigest
  readonly definitionId: string
  readonly definitionVersion: string
  readonly inputContractDigest: Wire.ContractDigest
  readonly outputContractDigest: Wire.ContractDigest
}

/**
 * Stable adapter-boundary failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  UnverifiedArtifact: "UnverifiedArtifact",
  UnpreparedBinding: "UnpreparedBinding",
  InvalidInvocation: "InvalidInvocation",
  InvalidRequest: "InvalidRequest",
  ArtifactMismatch: "ArtifactMismatch",
  InvalidExecutionId: "InvalidExecutionId"
} as const

/**
 * The decoded adapter-boundary failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.UnverifiedArtifact,
  ErrorCodes.UnpreparedBinding,
  ErrorCodes.InvalidInvocation,
  ErrorCodes.InvalidRequest,
  ErrorCodes.ArtifactMismatch,
  ErrorCodes.InvalidExecutionId
])

/**
 * Raised before a request reaches the native `WorkflowEngine`.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowBackendError extends Schema.TaggedErrorClass<
  EffectWorkflowBackendError
>("@effect/workflow-builder/EffectWorkflowBackendV3/Error")(
  "EffectWorkflowBackendError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const error = (
  code: ErrorCode,
  message: string
): EffectWorkflowBackendError => new EffectWorkflowBackendError({ code, message })

const snapshot = (
  input: unknown,
  label: string
): Result.Result<Schema.Json, EffectWorkflowBackendError> => {
  const snapped = Json.snapshot(input, {
    maxArrayLength: 16_384,
    maxContainers: 65_536,
    maxDepth: 1_024,
    maxEntries: 262_144,
    maxStringBytes: 1_048_576,
    maxTotalBytes: 16_777_216
  })
  return Result.isFailure(snapped)
    ? Result.fail(error(
      ErrorCodes.InvalidInvocation,
      `${label} must be bounded strict JSON: ${snapped.failure.message}`
    ))
    : Result.succeed(snapped.success)
}

const decodeSnapshot = <A>(
  schema: Schema.Codec<A, Schema.Json>,
  input: unknown,
  code: ErrorCode,
  label: string
): Result.Result<A, EffectWorkflowBackendError> => {
  const snapped = snapshot(input, label)
  if (Result.isFailure(snapped)) {
    return Result.fail(error(code, snapped.failure.message))
  }
  let decoded: Result.Result<A, Schema.SchemaError>
  try {
    decoded = Schema.decodeUnknownResult(schema, strictParseOptions)(
      snapped.success
    )
  } catch {
    return Result.fail(error(code, `${label} validation threw unexpectedly`))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(code, `Invalid ${label}: ${decoded.failure.message}`))
    : Result.succeed(snapped.success as unknown as A)
}

const workflowTag = (
  artifactDigest: Wire.ArtifactDigest
): string => `${WorkflowTagPrefix}${artifactDigest}`

const nativeIdempotencyKey = (
  request: RunRequest
): string =>
  JSON.stringify([
    "WorkflowBuilderRunV3",
    request.tenantId,
    request.runId
  ])

const nativeWorkflow = (
  binding: PreparedBinding
): Result.Result<NativeRunWorkflow, EffectWorkflowBackendError> => {
  const workflow = preparedBindings.get(binding)
  return workflow === undefined
    ? Result.fail(error(
      ErrorCodes.UnpreparedBinding,
      "Expected the exact PreparedBinding returned by prepare"
    ))
    : Result.succeed(workflow)
}

/**
 * Tests whether a value is the exact binding object returned by
 * {@link prepare} in this process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (
  value: unknown
): value is PreparedBinding =>
  typeof value === "object" &&
  value !== null &&
  preparedBindings.has(value) &&
  preparedArtifacts.has(value)

/**
 * Creates an artifact-versioned native workflow from verified provenance.
 *
 * **Details**
 *
 * The exact {@link PlanStoreV3.VerifiedArtifact} must come from
 * {@link PlanStoreV3.verifyArtifact} in this process. Child close and lineage
 * policies deliberately do not participate in this binding: they belong to
 * each semantic parent-child relation, while one native workflow definition
 * is shared by every run of the same exact artifact.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = (
  verified: PlanStoreV3.VerifiedArtifact
): Result.Result<PreparedBinding, EffectWorkflowBackendError> => {
  if (!PlanStoreV3.isVerifiedArtifact(verified)) {
    return Result.fail(error(
      ErrorCodes.UnverifiedArtifact,
      "Native workflow preparation requires the exact VerifiedArtifact returned by PlanStoreV3.verifyArtifact"
    ))
  }
  const artifact = verified.artifact
  const tag = workflowTag(verified.artifactDigest)
  const workflow = NativeWorkflow.make(tag, {
    payload: RunRequest,
    success: RunSuccess,
    error: RunFailure,
    idempotencyKey: nativeIdempotencyKey
  })
  const binding = Object.freeze({
    adapterVersion: AdapterVersion,
    executionProtocolVersion: ExecutionProtocolVersion,
    workflowTag: tag,
    artifactDigest: verified.artifactDigest,
    definitionId: artifact.definition.id,
    definitionVersion: artifact.definition.version,
    inputContractDigest: artifact.inputBoundary.digest,
    outputContractDigest: artifact.outputBoundary.digest
  })
  preparedBindings.set(binding, workflow)
  preparedArtifacts.set(binding, verified)
  return Result.succeed(binding)
}

/**
 * Detaches and validates one invocation, supplying the prepared artifact pin.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeRequest = (
  binding: PreparedBinding,
  invocation: unknown
): Result.Result<RunRequest, EffectWorkflowBackendError> => {
  if (!isPrepared(binding)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedBinding,
      "Run requests require the exact PreparedBinding returned by prepare"
    ))
  }
  const decoded = decodeSnapshot(
    RunInvocation,
    invocation,
    ErrorCodes.InvalidInvocation,
    "native run invocation"
  )
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  return validateRequest(binding, {
    adapterVersion: AdapterVersion,
    executionProtocolVersion: ExecutionProtocolVersion,
    tenantId: decoded.success.tenantId,
    runId: decoded.success.runId,
    requestId: decoded.success.requestId,
    artifactDigest: binding.artifactDigest,
    input: decoded.success.input
  })
}

/**
 * Detaches and validates a complete native request against its prepared
 * artifact pin.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateRequest = (
  binding: PreparedBinding,
  request: unknown
): Result.Result<RunRequest, EffectWorkflowBackendError> => {
  if (!isPrepared(binding)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedBinding,
      "Request validation requires the exact PreparedBinding returned by prepare"
    ))
  }
  const decoded = decodeSnapshot(
    RunRequest,
    request,
    ErrorCodes.InvalidRequest,
    "native run request"
  )
  if (Result.isFailure(decoded)) return decoded
  if (decoded.success.artifactDigest !== binding.artifactDigest) {
    return Result.fail(error(
      ErrorCodes.ArtifactMismatch,
      "Native run request artifact digest does not match its prepared workflow"
    ))
  }
  return decoded
}

/**
 * Context supplied to the backend-neutral semantic handler.
 *
 * @category models
 * @since 4.0.0
 */
export interface SemanticExecution {
  readonly request: RunRequest
  readonly verifiedArtifact: PlanStoreV3.VerifiedArtifact
  readonly artifact: PlanStoreV3.StaticDagArtifact
  readonly nativeExecutionId: string
}

/**
 * Tests whether a value is the exact semantic execution context created by a
 * registered native handler in this process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSemanticExecution = (
  value: unknown
): value is SemanticExecution =>
  typeof value === "object" &&
  value !== null &&
  semanticExecutions.has(value)

/**
 * Backend-neutral semantic handler hosted by native Effect Workflow.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticHandler<R> = (
  execution: SemanticExecution
) => Effect.Effect<RunSuccess, RunFailure, R>

/**
 * Application services retained by a registered semantic handler after native
 * workflow runtime services are supplied by `WorkflowEngine`.
 *
 * @category utility types
 * @since 4.0.0
 */
export type RegistrationRequirements<R> =
  | NativeWorkflowEngine.WorkflowEngine
  | Exclude<
    R,
    | NativeWorkflowEngine.WorkflowEngine
    | NativeWorkflowEngine.WorkflowInstance
    | NativeWorkflow.Execution<string>
    | Scope.Scope
  >

const invariantFailure = (
  code: string,
  message: string
): RunFailure => ({
  _tag: "Failed",
  failureVersion: 1,
  failureKind: "AdapterInvariant",
  failure: {
    _tag: "Inline",
    value: { code, message }
  }
})

const validateSuccess = (
  binding: PreparedBinding,
  input: unknown
): Result.Result<RunSuccess, RunFailure> => {
  const decoded = decodeSnapshot(
    RunSuccess,
    input,
    ErrorCodes.InvalidRequest,
    "native run success"
  )
  if (Result.isFailure(decoded)) {
    return Result.fail(invariantFailure(
      "InvalidSuccessEnvelope",
      decoded.failure.message
    ))
  }
  if (
    decoded.success.outputContractDigest !==
      binding.outputContractDigest
  ) {
    return Result.fail(invariantFailure(
      "OutputContractMismatch",
      "Semantic handler output contract does not match the prepared artifact"
    ))
  }
  return Result.succeed(decoded.success)
}

const validateFailure = (
  input: unknown
): RunFailure => {
  const decoded = decodeSnapshot(
    RunFailure,
    input,
    ErrorCodes.InvalidRequest,
    "native run failure"
  )
  return Result.isFailure(decoded)
    ? invariantFailure("InvalidFailureEnvelope", decoded.failure.message)
    : decoded.success
}

/**
 * Registers a semantic handler as the prepared native workflow.
 *
 * **Details**
 *
 * The returned layer requires the application's native `WorkflowEngine`.
 * Supplying `WorkflowEngine.layerMemory` or a cluster-backed layer changes
 * durability and distribution without changing this adapter or the semantic
 * handler.
 *
 * @category layers
 * @since 4.0.0
 */
export const toLayer = <R>(
  binding: PreparedBinding,
  handler: SemanticHandler<R>
): Result.Result<
  Layer.Layer<never, never, RegistrationRequirements<R>>,
  EffectWorkflowBackendError
> => {
  const resolved = nativeWorkflow(binding)
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  const layer = resolved.success.toLayer((request, nativeExecutionId) => {
    const admitted = validateRequest(binding, request)
    if (Result.isFailure(admitted)) {
      return Effect.fail(invariantFailure(
        admitted.failure.code,
        admitted.failure.message
      ))
    }
    const verifiedArtifact = preparedArtifacts.get(binding)!
    const execution = Object.freeze({
      request: admitted.success,
      verifiedArtifact,
      artifact: verifiedArtifact.artifact,
      nativeExecutionId
    })
    semanticExecutions.add(execution)
    return Effect.matchEffect(
      handler(execution),
      {
        onFailure: (failure) => Effect.fail(validateFailure(failure)),
        onSuccess: (success) => {
          const validated = validateSuccess(binding, success)
          return Result.isFailure(validated)
            ? Effect.fail(validated.failure)
            : Effect.succeed(validated.success)
        }
      }
    )
  })
  return Result.succeed(layer)
}

const resolveInvocation = (
  binding: PreparedBinding,
  invocation: unknown
): Result.Result<
  readonly [NativeRunWorkflow, RunRequest],
  EffectWorkflowBackendError
> => {
  const resolved = nativeWorkflow(binding)
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
  const request = makeRequest(binding, invocation)
  return Result.isFailure(request)
    ? Result.fail(request.failure)
    : Result.succeed([resolved.success, request.success] as const)
}

/**
 * Computes the deterministic native execution identifier without starting the
 * workflow.
 *
 * @category execution
 * @since 4.0.0
 */
export const executionId = (
  binding: PreparedBinding,
  invocation: unknown
): Effect.Effect<string, EffectWorkflowBackendError> => {
  const resolved = resolveInvocation(binding, invocation)
  return Result.isFailure(resolved)
    ? Effect.fail(resolved.failure)
    : resolved.success[0].executionId(resolved.success[1])
}

/**
 * Starts the already-admitted run through the injected native engine and
 * returns immediately with its deterministic native execution identifier.
 *
 * @category execution
 * @since 4.0.0
 */
export const start = (
  binding: PreparedBinding,
  invocation: unknown
): Effect.Effect<
  string,
  EffectWorkflowBackendError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const resolved = resolveInvocation(binding, invocation)
  return Result.isFailure(resolved)
    ? Effect.fail(resolved.failure)
    : resolved.success[0].execute(
      resolved.success[1],
      { discard: true }
    )
}

/**
 * Executes or joins the already-admitted run through the injected native
 * engine.
 *
 * @category execution
 * @since 4.0.0
 */
export const execute = (
  binding: PreparedBinding,
  invocation: unknown
): Effect.Effect<
  RunSuccess,
  RunFailure | EffectWorkflowBackendError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const resolved = resolveInvocation(binding, invocation)
  return Result.isFailure(resolved)
    ? Effect.fail(resolved.failure)
    : resolved.success[0].execute(resolved.success[1])
}

const decodeExecutionId = (
  input: unknown
): Result.Result<string, EffectWorkflowBackendError> =>
  decodeSnapshot(
    Wire.Identifier,
    input,
    ErrorCodes.InvalidExecutionId,
    "native execution identifier"
  )

/**
 * Polls native operational completion or suspension state.
 *
 * @category execution
 * @since 4.0.0
 */
export const poll = (
  binding: PreparedBinding,
  nativeExecutionId: unknown
): Effect.Effect<
  Option.Option<NativeWorkflow.Result<RunSuccess, RunFailure>>,
  EffectWorkflowBackendError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const resolved = nativeWorkflow(binding)
  if (Result.isFailure(resolved)) return Effect.fail(resolved.failure)
  const executionId = decodeExecutionId(nativeExecutionId)
  return Result.isFailure(executionId)
    ? Effect.fail(executionId.failure)
    : resolved.success.poll(executionId.success)
}

/**
 * Requests native safe interruption, preserving the engine's child and
 * finalizer behavior.
 *
 * @category execution
 * @since 4.0.0
 */
export const interrupt = (
  binding: PreparedBinding,
  nativeExecutionId: unknown
): Effect.Effect<
  void,
  EffectWorkflowBackendError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const resolved = nativeWorkflow(binding)
  if (Result.isFailure(resolved)) return Effect.fail(resolved.failure)
  const executionId = decodeExecutionId(nativeExecutionId)
  return Result.isFailure(executionId)
    ? Effect.fail(executionId.failure)
    : resolved.success.interrupt(executionId.success)
}

/**
 * Requests native workflow resumption through the injected engine.
 *
 * @category execution
 * @since 4.0.0
 */
export const resume = (
  binding: PreparedBinding,
  nativeExecutionId: unknown
): Effect.Effect<
  void,
  EffectWorkflowBackendError,
  NativeWorkflowEngine.WorkflowEngine
> => {
  const resolved = nativeWorkflow(binding)
  if (Result.isFailure(resolved)) return Effect.fail(resolved.failure)
  const executionId = decodeExecutionId(nativeExecutionId)
  return Result.isFailure(executionId)
    ? Effect.fail(executionId.failure)
    : resolved.success.resume(executionId.success)
}
