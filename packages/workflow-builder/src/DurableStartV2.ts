/**
 * Prepares strict protocol version `2` durable-start requests.
 *
 * **Details**
 *
 * This module prepares immutable input for a future authoritative start
 * transaction. It neither reads a clock nor assigns semantic event identity or
 * sequence. The authority must atomically create the durable plan binding and
 * store-stamped `RunStarted` event.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as DecisionV2 from "./DecisionV2.ts"
import * as Deployment from "./Deployment.ts"
import * as EventV2 from "./EventV2.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV2 from "./PlanStoreV2.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PreparedStartTypeId: unique symbol = Symbol(
  "@effect/workflow-builder/DurableStartV2/PreparedStart"
)
const preparedStarts = new WeakSet<object>()

/**
 * The strict protocol version `2` start request for an authoritative store.
 *
 * **Details**
 *
 * Sequence, event identity, and timestamps are intentionally absent. Storage
 * owns those facts when it atomically binds the artifact and creates the run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Request = Schema.Struct({
  startVersion: Schema.Literal(2),
  key: PlanStoreV2.RunKey,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  artifactDigest: PlanStoreV2.ArtifactDigest,
  artifact: PlanStoreV2.PlanArtifact,
  input: EventV2.EncodedValues
}).annotate({
  identifier: "WorkflowDurableStartRequestV2",
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
 * Stable machine-readable protocol version `2` start-preparation failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidPreparedPlan: "InvalidPreparedPlan",
  InvalidConfiguration: "InvalidConfiguration",
  InvalidArtifact: "InvalidArtifact",
  ArtifactIdentityMismatch: "ArtifactIdentityMismatch",
  TargetKeyMismatch: "TargetKeyMismatch",
  DeploymentMismatch: "DeploymentMismatch",
  InvalidInput: "InvalidInput",
  InvalidRequest: "InvalidRequest"
} as const

/**
 * A stable protocol version `2` start-preparation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type DurableStartPreparationErrorCode = typeof Codes[keyof typeof Codes]

const DurableStartPreparationErrorCode = Schema.Literals([
  Codes.InvalidPreparedPlan,
  Codes.InvalidConfiguration,
  Codes.InvalidArtifact,
  Codes.ArtifactIdentityMismatch,
  Codes.TargetKeyMismatch,
  Codes.DeploymentMismatch,
  Codes.InvalidInput,
  Codes.InvalidRequest
])

/**
 * Raised when a protocol version `2` durable start cannot be prepared safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class DurableStartPreparationError extends Schema.TaggedErrorClass<DurableStartPreparationError>(
  "@effect/workflow-builder/DurableStartV2/DurableStartPreparationError"
)("DurableStartPreparationError", {
  code: DurableStartPreparationErrorCode,
  message: Schema.NonEmptyString,
  input: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Caller-owned identity for one new protocol version `2` run.
 *
 * @category configuration
 * @since 4.0.0
 */
export interface Options {
  readonly tenantId: string
  readonly runId: string
  readonly workflowIdentity: string
  readonly requestId: string
}

/**
 * A strict start request admitted by {@link prepare}.
 *
 * **Details**
 *
 * Provenance is retained out of band and cannot be recreated by structural
 * copying. The future storage authority must still validate the wire request
 * inside its atomic start transaction.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedStart {
  readonly [PreparedStartTypeId]: true
  readonly wire: Request
}

/**
 * Effect services required to encode inputs and resolve exact deployments.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | Workflow.InputEncodingServices<W>
  | Deployment.DeploymentCatalog

/**
 * Failures produced while preparing a protocol version `2` durable start.
 *
 * @category errors
 * @since 4.0.0
 */
export type PrepareError =
  | DurableStartPreparationError
  | Deployment.DeploymentResolutionError

const PreparationOptions = Schema.Struct({
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  workflowIdentity: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDurableStartOptionsV2",
  parseOptions: strictParseOptions
})

const decodeOptions = Schema.decodeUnknownResult(
  PreparationOptions,
  strictParseOptions
)
const decodeInput = Schema.decodeUnknownResult(
  EventV2.EncodedValues,
  strictParseOptions
)
const decodeRequest = Schema.decodeUnknownResult(Request, strictParseOptions)

const makeError = (
  code: DurableStartPreparationErrorCode,
  message: string,
  options: {
    readonly input?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): DurableStartPreparationError =>
  new DurableStartPreparationError({
    code,
    message,
    ...(options.input === undefined ? undefined : { input: options.input }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const captureOptions = (
  input: unknown
): Result.Result<Options, DurableStartPreparationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      Codes.InvalidConfiguration,
      `Durable start options must be strict JSON: ${snapshot.failure.message}`,
      {
        details: {
          snapshotError: snapshot.failure.message,
          path: [...snapshot.failure.path]
        }
      }
    ))
  }
  let decoded: ReturnType<typeof decodeOptions>
  try {
    decoded = decodeOptions(snapshot.success)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidConfiguration,
      "Durable-start option validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(
      Codes.InvalidConfiguration,
      "Invalid protocol version 2 durable-start options",
      { details: { parseError: decoded.failure.message } }
    ))
    : Result.succeed(snapshot.success as unknown as Options)
}

const sameKeys = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  left.length === right.length &&
  left.every((key, index) => key === right[index])

const validateArtifact = (
  plan: DecisionV2.DecidablePlan
): Result.Result<PlanStoreV2.PlanArtifact, DurableStartPreparationError> => {
  let validated: ReturnType<typeof PlanStoreV2.validateArtifact>
  try {
    validated = PlanStoreV2.validateArtifact(plan.artifact)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidArtifact,
      "Prepared protocol version 2 artifact validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(validated)) {
    return Result.fail(makeError(
      Codes.InvalidArtifact,
      validated.failure.message,
      {
        details: {
          artifactCode: validated.failure.code,
          ...(validated.failure.details === undefined
            ? undefined
            : { artifactDetails: validated.failure.details })
        }
      }
    ))
  }

  const artifact = plan.artifact
  const fingerprint = artifact.fingerprintDocument
  const compiled = plan.compiled
  if (
    artifact.compiledFingerprint !== plan.compiledFingerprint ||
    fingerprint.compilerSemanticVersion !== plan.compilerVersion ||
    fingerprint.plan.id !== compiled.plan.id ||
    fingerprint.plan.revision !== compiled.plan.revision ||
    fingerprint.plan.definition.id !== compiled.definition.id ||
    fingerprint.plan.definition.version !== compiled.definition.version
  ) {
    return Result.fail(makeError(
      Codes.ArtifactIdentityMismatch,
      "Prepared artifact identity does not match its exact compiled plan"
    ))
  }

  const expectedKeys = Array.from(compiled.nodes.keys()).sort()
  const targetKeys = Object.keys(artifact.dispatchTargets).sort()
  const policyKeys = Object.keys(artifact.activityPolicies).sort()
  if (
    !sameKeys(expectedKeys, targetKeys) ||
    !sameKeys(expectedKeys, policyKeys)
  ) {
    return Result.fail(makeError(
      Codes.TargetKeyMismatch,
      "Artifact target and policy keys must exactly match compiled nodes",
      {
        details: {
          expectedKeys,
          targetKeys,
          policyKeys
        }
      }
    ))
  }
  return Result.succeed(artifact)
}

interface CapturedProperty {
  readonly key: PropertyKey
  readonly descriptor: PropertyDescriptor
}

const captureInput = Effect.fnUntraced(function*(
  input: unknown
): Effect.fn.Return<
  ReadonlyArray<CapturedProperty>,
  DurableStartPreparationError
> {
  if (typeof input !== "object" || input === null) {
    return yield* Effect.fail(makeError(
      Codes.InvalidInput,
      "Workflow input must be an object"
    ))
  }
  const captured = yield* Effect.try({
    try: () => {
      const prototype = Object.getPrototypeOf(input)
      const descriptors = Object.getOwnPropertyDescriptors(input)
      const properties = Reflect.ownKeys(descriptors).map(
        (key): CapturedProperty => ({
          key,
          descriptor: Reflect.getOwnPropertyDescriptor(
            descriptors,
            key
          )!.value as PropertyDescriptor
        })
      )
      return { prototype, properties } as const
    },
    catch: () =>
      makeError(
        Codes.InvalidInput,
        "Workflow input could not be inspected safely"
      )
  })
  if (
    captured.prototype !== Object.prototype &&
    captured.prototype !== null
  ) {
    return yield* Effect.fail(makeError(
      Codes.InvalidInput,
      "Workflow input must have Object.prototype or null as its prototype"
    ))
  }
  return Object.freeze(captured.properties)
})

const isEnumerableDataProperty = (
  descriptor: PropertyDescriptor
): boolean =>
  descriptor.enumerable === true &&
  Object.prototype.hasOwnProperty.call(descriptor, "value")

const encodeValue = Effect.fnUntraced(function*<A, R>(
  construct: () => Effect.Effect<A, { readonly message: string }, R>,
  input: string
): Effect.fn.Return<A, DurableStartPreparationError, R> {
  const operation = yield* Effect.try({
    try: construct,
    catch: () =>
      makeError(
        Codes.InvalidInput,
        `Workflow input '${input}' codec could not be prepared safely`,
        { input, details: { input } }
      )
  })
  return yield* operation.pipe(
    Effect.mapError((error) =>
      makeError(
        Codes.InvalidInput,
        `Workflow input '${input}' could not be encoded: ${error.message}`,
        { input, details: { input } }
      )
    ),
    Effect.catchCauseIf(
      Cause.hasDies,
      () =>
        Effect.fail(makeError(
          Codes.InvalidInput,
          `Workflow input '${input}' codec failed unexpectedly`,
          { input, details: { input } }
        ))
    )
  )
})

const encodeInput = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: DecisionV2.DecidablePlan<W>,
  input: Workflow.InputValues<W>
): Effect.fn.Return<
  EventV2.EncodedValues,
  DurableStartPreparationError,
  Workflow.InputEncodingServices<W>
> {
  const declared = Object.entries(plan.compiled.definition.inputs)
  const declaredNames = new Set(declared.map(([name]) => name))
  const captured = yield* captureInput(input)
  const values = new Map<string, unknown>()

  for (const property of captured) {
    if (typeof property.key !== "string") {
      return yield* Effect.fail(makeError(
        Codes.InvalidInput,
        "Workflow input must not contain symbol properties"
      ))
    }
    if (!isEnumerableDataProperty(property.descriptor)) {
      return yield* Effect.fail(makeError(
        Codes.InvalidInput,
        `Workflow input '${property.key}' must be an enumerable data property`,
        { input: property.key }
      ))
    }
    if (!declaredNames.has(property.key)) {
      return yield* Effect.fail(makeError(
        Codes.InvalidInput,
        `Unknown workflow input '${property.key}'`,
        { input: property.key }
      ))
    }
    values.set(property.key, property.descriptor.value)
  }

  const entries: Array<readonly [string, Schema.Json]> = []
  for (const [name, port] of declared) {
    if (!values.has(name)) {
      return yield* Effect.fail(makeError(
        Codes.InvalidInput,
        `Workflow input is missing declared input '${name}'`,
        { input: name }
      ))
    }
    const encoded = yield* encodeValue(
      () => Schema.encodeUnknownEffect(port.schema)(values.get(name)),
      name
    )
    const snapshot = Json.snapshot(encoded)
    if (Result.isFailure(snapshot)) {
      return yield* Effect.fail(makeError(
        Codes.InvalidInput,
        `Workflow input '${name}' must encode to strict JSON: ${snapshot.failure.message}`,
        {
          input: name,
          details: {
            input: name,
            snapshotError: snapshot.failure.message,
            path: [...snapshot.failure.path]
          }
        }
      ))
    }
    entries.push([name, snapshot.success])
  }

  const snapshot = Json.snapshot(Object.fromEntries(entries))
  if (Result.isFailure(snapshot)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidInput,
      `Encoded workflow input must be strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: ReturnType<typeof decodeInput>
  try {
    decoded = decodeInput(snapshot.success)
  } catch {
    return yield* Effect.fail(makeError(
      Codes.InvalidInput,
      "Encoded workflow-input validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidInput,
      "Encoded workflow input is not a strict named-value record",
      { details: { parseError: decoded.failure.message } }
    ))
  }
  return snapshot.success as EventV2.EncodedValues
})

/**
 * Tests whether a value is the exact object returned by {@link prepare}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (value: unknown): value is PreparedStart =>
  typeof value === "object" &&
  value !== null &&
  preparedStarts.has(value)

/**
 * Prepares one strict protocol version `2` durable-start request.
 *
 * **Details**
 *
 * Preparation first requires exact {@link DecisionV2.prepare} provenance,
 * then descriptor-safely snapshots options and validates the already prepared
 * artifact. The artifact and its digest are reused verbatim; this function
 * does not hash them or construct alternative durable semantics.
 *
 * The artifact workflow deployment and every handler target are resolved
 * through {@link Deployment.DeploymentCatalog}. Each resolution must return
 * the exact definition object retained by the compiled plan.
 *
 * Workflow inputs must contain exactly the declared own enumerable data
 * properties. Every value is freshly encoded through its Effect Schema, then
 * detached through strict JSON inspection. Codec defects become typed input
 * failures while Effect interruption remains interruption.
 *
 * The returned request is recursively detached and frozen. It carries no
 * caller-selected event id, sequence, timestamp, causation, or correlation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: DecisionV2.DecidablePlan<W>,
  input: Workflow.InputValues<W>,
  options: Options
): Effect.fn.Return<
  PreparedStart,
  PrepareError,
  Requirements<W>
> {
  if (!DecisionV2.isPrepared(plan)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidPreparedPlan,
      "DurableStartV2 requires a plan produced by DecisionV2.prepare"
    ))
  }

  const capturedOptions = captureOptions(options)
  if (Result.isFailure(capturedOptions)) {
    return yield* Effect.fail(capturedOptions.failure)
  }
  const artifact = validateArtifact(plan)
  if (Result.isFailure(artifact)) {
    return yield* Effect.fail(artifact.failure)
  }

  const catalog = yield* Deployment.DeploymentCatalog
  const resolvedWorkflow = yield* catalog.resolveWorkflowDefinition({
    deploymentId: artifact.success.definitionDeploymentId,
    definitionId: plan.compiled.definition.id,
    definitionVersion: plan.compiled.definition.version
  })
  if (resolvedWorkflow !== plan.compiled.definition) {
    return yield* Effect.fail(makeError(
      Codes.DeploymentMismatch,
      "Workflow deployment must resolve to the compiled definition's exact object",
      {
        details: {
          deploymentId: artifact.success.definitionDeploymentId,
          definitionId: plan.compiled.definition.id,
          definitionVersion: plan.compiled.definition.version
        }
      }
    ))
  }

  const compiledNodes = Array.from(plan.compiled.nodes.entries()).sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0
  )
  for (const [nodeId, compiledNode] of compiledNodes) {
    const target = artifact.success.dispatchTargets[nodeId]!
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
          details: {
            nodeId,
            deploymentId: target.deploymentId,
            type: compiledNode.definition.type,
            version: compiledNode.definition.version
          }
        }
      ))
    }
  }

  const encodedInput = yield* encodeInput(plan, input)
  const admittedOptions = capturedOptions.success
  const key: PlanStoreV2.RunKey = Object.freeze({
    tenantId: admittedOptions.tenantId,
    runId: admittedOptions.runId
  })
  const wire: Request = Object.freeze({
    startVersion: 2,
    key,
    workflowIdentity: admittedOptions.workflowIdentity,
    requestId: admittedOptions.requestId,
    artifactDigest: plan.artifactDigest,
    artifact: artifact.success,
    input: encodedInput
  })

  let decoded: ReturnType<typeof decodeRequest>
  try {
    decoded = decodeRequest(wire)
  } catch {
    return yield* Effect.fail(makeError(
      Codes.InvalidRequest,
      "Durable-start request validation threw unexpectedly"
    ))
  }
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidRequest,
      "Invalid protocol version 2 durable-start request",
      { details: { parseError: decoded.failure.message } }
    ))
  }

  const prepared: PreparedStart = Object.freeze({
    [PreparedStartTypeId]: true as const,
    wire
  })
  preparedStarts.add(prepared)
  return prepared
})
