/**
 * Prepares immutable durable-start requests and content-addressed plan
 * artifacts.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Decision from "./Decision.ts"
import * as Deployment from "./Deployment.ts"
import * as Event from "./Event.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as Json from "./internal/json.ts"
import * as PlanStore from "./PlanStore.ts"
import * as RunStart from "./RunStart.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PreparedStartTypeId: unique symbol = Symbol(
  "@effect/workflow-builder/DurableStart/PreparedStart"
)
const preparedStarts = new WeakSet<object>()

/**
 * The strict wire request admitted by durable execution storage.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Request = Schema.Struct({
  startVersion: Schema.Literal(1),
  key: PlanStore.RunKey,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  artifactDigest: PlanStore.ArtifactDigest,
  artifact: PlanStore.PlanArtifact,
  input: Event.EncodedValues
}).annotate({
  identifier: "WorkflowDurableStartRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Request}.
 *
 * @category models
 * @since 4.0.0
 */
export type Request = Schema.Schema.Type<typeof Request>

/**
 * Stable machine-readable durable-start preparation failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidConfiguration: "InvalidConfiguration",
  InvalidTargets: "InvalidTargets",
  TargetKeyMismatch: "TargetKeyMismatch",
  DeploymentMismatch: "DeploymentMismatch",
  FingerprintMismatch: "FingerprintMismatch",
  InvalidArtifact: "InvalidArtifact",
  InvalidRequest: "InvalidRequest"
} as const

/**
 * A stable machine-readable durable-start preparation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type DurableStartPreparationErrorCode = typeof Codes[keyof typeof Codes]

const DurableStartPreparationErrorCode = Schema.Literals([
  Codes.InvalidConfiguration,
  Codes.InvalidTargets,
  Codes.TargetKeyMismatch,
  Codes.DeploymentMismatch,
  Codes.FingerprintMismatch,
  Codes.InvalidArtifact,
  Codes.InvalidRequest
])

/**
 * Raised when a durable start cannot be converted into a strict, internally
 * consistent request.
 *
 * @category errors
 * @since 4.0.0
 */
export class DurableStartPreparationError extends Schema.TaggedErrorClass<DurableStartPreparationError>(
  "@effect/workflow-builder/DurableStart/DurableStartPreparationError"
)("DurableStartPreparationError", {
  code: DurableStartPreparationErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Explicit configuration for one durable workflow start.
 *
 * @category configuration
 * @since 4.0.0
 */
export interface Options {
  readonly tenantId: string
  readonly runId: string
  readonly workflowIdentity: string
  readonly requestId: string
  readonly definitionDeploymentId: string
  readonly dispatchTargets: PlanStore.DispatchTargets
}

/**
 * A strict durable-start request admitted by {@link prepare}.
 *
 * **Details**
 *
 * Provenance is retained only inside this process. Durable storage must still
 * independently validate the wire request and recompute claimed digests.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedStart {
  readonly [PreparedStartTypeId]: true
  readonly wire: Request
}

/**
 * Effect services required to encode workflow input and hash durable content.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | RunStart.Requirements<W>
  | Crypto.Crypto
  | Deployment.DeploymentCatalog

/**
 * Failures that may be produced while preparing a durable start.
 *
 * @category errors
 * @since 4.0.0
 */
export type PrepareError =
  | DurableStartPreparationError
  | Deployment.DeploymentResolutionError
  | RunStart.RunStartError
  | PlatformError.PlatformError

const PreparationOptions = Schema.Struct({
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  definitionDeploymentId: Schema.NonEmptyString,
  dispatchTargets: Schema.Json
})

const decodeOptions = Schema.decodeUnknownResult(PreparationOptions, strictParseOptions)
const decodeTargets = Schema.decodeUnknownResult(PlanStore.DispatchTargets, strictParseOptions)
const decodeDigest = Schema.decodeUnknownResult(Fingerprint.Digest, strictParseOptions)
const decodeArtifactDigest = Schema.decodeUnknownResult(PlanStore.ArtifactDigest, strictParseOptions)
const decodeArtifact = Schema.decodeUnknownResult(PlanStore.PlanArtifact, strictParseOptions)
const decodeRequest = Schema.decodeUnknownResult(Request, strictParseOptions)

const makeError = (
  code: DurableStartPreparationErrorCode,
  message: string,
  details?: Schema.Json
): DurableStartPreparationError =>
  new DurableStartPreparationError({
    code,
    message,
    ...(details === undefined ? undefined : { details })
  })

const parse = <A>(
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>,
  input: unknown,
  code: DurableStartPreparationErrorCode,
  subject: string
): Result.Result<A, DurableStartPreparationError> => {
  let decoded: Result.Result<A, { readonly message: string }>
  try {
    decoded = decode(input)
  } catch {
    return Result.fail(makeError(
      code,
      `${subject} schema validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(code, `Invalid ${subject.toLowerCase()}`, {
      parseError: decoded.failure.message
    }))
    : Result.succeed(decoded.success)
}

const snapshotOptions = (
  input: unknown
): Result.Result<Options, DurableStartPreparationError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidConfiguration,
      `Durable start options must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }

  const decoded = parse(
    decodeOptions,
    snapped.success,
    Codes.InvalidConfiguration,
    "Durable start options"
  )
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }

  const options = snapped.success as unknown as {
    readonly tenantId: string
    readonly runId: string
    readonly workflowIdentity: string
    readonly requestId: string
    readonly definitionDeploymentId: string
    readonly dispatchTargets: unknown
  }
  const targets = parse(
    decodeTargets,
    options.dispatchTargets,
    Codes.InvalidTargets,
    "Dispatch targets"
  )
  if (Result.isFailure(targets)) {
    return Result.fail(targets.failure)
  }
  return Result.succeed(options as Options)
}

const validateTargetKeys = (
  plan: Decision.DecidablePlan,
  targets: PlanStore.DispatchTargets
): Result.Result<void, DurableStartPreparationError> => {
  const expectedKeys = Array.from(plan.compiled.nodes.keys()).sort()
  const actualKeys = Object.keys(targets).sort()
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return Result.fail(makeError(
      Codes.TargetKeyMismatch,
      "Dispatch target keys must exactly match all compiled node identifiers",
      { expectedKeys, actualKeys }
    ))
  }
  return Result.succeed(undefined)
}

const snapshotArtifact = (
  input: unknown
): Result.Result<PlanStore.PlanArtifact, DurableStartPreparationError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidArtifact,
      `Plan artifact must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  const decoded = parse(
    decodeArtifact,
    snapped.success,
    Codes.InvalidArtifact,
    "Plan artifact"
  )
  return Result.isFailure(decoded)
    ? decoded
    : Result.succeed(snapped.success as unknown as PlanStore.PlanArtifact)
}

const snapshotRequest = (
  input: unknown
): Result.Result<Request, DurableStartPreparationError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidRequest,
      `Durable start request must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  const decoded = parse(
    decodeRequest,
    snapped.success,
    Codes.InvalidRequest,
    "Durable start request"
  )
  return Result.isFailure(decoded)
    ? decoded
    : Result.succeed(snapped.success as unknown as Request)
}

/**
 * Tests whether a value is the exact object returned by {@link prepare}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (value: unknown): value is PreparedStart =>
  typeof value === "object" && value !== null && preparedStarts.has(value)

/**
 * Prepares one strict durable-start request.
 *
 * **Details**
 *
 * The complete options object first crosses the descriptor-based strict-JSON
 * boundary, so accessors and proxy failures are rejected without reading
 * individual option fields. Targets must name every compiled node exactly.
 * Every workflow and handler deployment pin is then resolved through
 * {@link Deployment.DeploymentCatalog}; the resolved definition must be the
 * exact object retained by the prepared compiler output.
 *
 * Workflow input is encoded through {@link RunStart.make}; the reusable
 * artifact deliberately excludes tenant, run, request, and input data.
 *
 * The compiled fingerprint is independently recomputed from the materialized
 * document before the deployment- and route-aware artifact is hashed. The
 * returned wire request is detached and recursively frozen.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  input: Workflow.InputValues<W>,
  options: Options
): Effect.fn.Return<
  PreparedStart,
  PrepareError,
  Requirements<W>
> {
  if (!Decision.isPrepared(plan)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidConfiguration,
      "Durable start requires a plan produced by Decision.prepare"
    ))
  }

  const capturedOptions = snapshotOptions(options)
  if (Result.isFailure(capturedOptions)) {
    return yield* Effect.fail(capturedOptions.failure)
  }
  const admittedOptions = capturedOptions.success

  const targetKeys = validateTargetKeys(plan, admittedOptions.dispatchTargets)
  if (Result.isFailure(targetKeys)) {
    return yield* Effect.fail(targetKeys.failure)
  }

  const catalog = yield* Deployment.DeploymentCatalog
  const resolvedWorkflow = yield* catalog.resolveWorkflowDefinition({
    deploymentId: admittedOptions.definitionDeploymentId,
    definitionId: plan.compiled.definition.id,
    definitionVersion: plan.compiled.definition.version
  })
  if (resolvedWorkflow !== plan.compiled.definition) {
    return yield* Effect.fail(makeError(
      Codes.DeploymentMismatch,
      "Workflow deployment must resolve to the compiled workflow definition's exact object",
      {
        deploymentId: admittedOptions.definitionDeploymentId,
        definitionId: plan.compiled.definition.id,
        definitionVersion: plan.compiled.definition.version
      }
    ))
  }
  for (const [nodeId, compiledNode] of plan.compiled.nodes) {
    const target = admittedOptions.dispatchTargets[nodeId]!
    const resolvedHandler = yield* catalog.resolveHandlerDefinition({
      deploymentId: target.deploymentId,
      type: compiledNode.definition.type,
      version: compiledNode.definition.version
    })
    if (resolvedHandler !== compiledNode.definition) {
      return yield* Effect.fail(makeError(
        Codes.DeploymentMismatch,
        "Handler deployment must resolve to the compiled node definition's exact object",
        {
          nodeId,
          deploymentId: target.deploymentId,
          type: compiledNode.definition.type,
          version: compiledNode.definition.version
        }
      ))
    }
  }

  const draft = yield* RunStart.make(plan, input, {
    runId: admittedOptions.runId,
    backend: "durable"
  })

  const fingerprintDocument = Fingerprint.materialize(plan.compiled)
  const materializedFingerprint = yield* Fingerprint.digest(
    fingerprintDocument as unknown as Schema.Json
  )
  const validDigest = parse(
    decodeDigest,
    materializedFingerprint,
    Codes.FingerprintMismatch,
    "Compiled fingerprint"
  )
  if (
    Result.isFailure(validDigest) ||
    materializedFingerprint !== plan.compiledFingerprint
  ) {
    return yield* Effect.fail(makeError(
      Codes.FingerprintMismatch,
      "Prepared compiled fingerprint does not match its materialized document",
      {
        expected: plan.compiledFingerprint,
        actual: materializedFingerprint
      }
    ))
  }

  const artifact = snapshotArtifact({
    artifactVersion: 1,
    executionProtocolVersion: 1,
    fingerprintDocument,
    compiledFingerprint: plan.compiledFingerprint,
    definitionDeploymentId: admittedOptions.definitionDeploymentId,
    dispatchTargets: admittedOptions.dispatchTargets
  })
  if (Result.isFailure(artifact)) {
    return yield* Effect.fail(artifact.failure)
  }

  const computedArtifactDigest = yield* Fingerprint.digest(
    artifact.success as unknown as Schema.Json
  )
  const artifactDigest = parse(
    decodeArtifactDigest,
    computedArtifactDigest,
    Codes.InvalidArtifact,
    "Plan artifact digest"
  )
  if (Result.isFailure(artifactDigest)) {
    return yield* Effect.fail(artifactDigest.failure)
  }
  const wire = snapshotRequest({
    startVersion: 1,
    key: {
      tenantId: admittedOptions.tenantId,
      runId: admittedOptions.runId
    },
    workflowIdentity: admittedOptions.workflowIdentity,
    requestId: admittedOptions.requestId,
    artifactDigest: artifactDigest.success,
    artifact: artifact.success,
    input: draft.payload.input
  })
  if (Result.isFailure(wire)) {
    return yield* Effect.fail(wire.failure)
  }

  const prepared: PreparedStart = Object.freeze({
    [PreparedStartTypeId]: true as const,
    wire: wire.success
  })
  preparedStarts.add(prepared)
  return prepared
})
