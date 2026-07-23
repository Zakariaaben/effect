/**
 * Durable business-failure retry composition for semantic protocol version 3.
 *
 * **Details**
 *
 * This module composes authenticated semantic operations with Effect's native
 * Workflow activities and durable clock. It owns no persistence, activity,
 * timer, lease, or replay implementation.
 *
 * Every business attempt executes through the managed `NodeAttempt` activity.
 * The handler's exact output or application failure is encoded once inside
 * that native activity and persisted as a closed outcome. Workflow replay
 * never catches or re-encodes a decoded activity failure.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import * as EffectWorkflowSemanticV3 from "./EffectWorkflowSemanticV3.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV3 from "./PlanStoreV3.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import * as SemanticExecutableRegistryV3 from "./SemanticExecutableRegistryV3.ts"
import * as SemanticOccurrenceV3 from "./SemanticOccurrenceV3.ts"
import * as SemanticOperationV3 from "./SemanticOperationV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const OperationIds = {
  NodeAttempt: "workflow-builder.retry.node-attempt",
  InitialTime: "workflow-builder.retry.initial-time",
  FailureTime: "workflow-builder.retry.failure-time",
  Classifier: "workflow-builder.retry.classifier",
  Delay: "workflow-builder.retry.delay",
  Backoff: "workflow-builder.retry.backoff"
} as const

/**
 * Canonical managed-attempt schemas owned by {@link SemanticOperationV3}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptSucceeded = SemanticOperationV3.NodeAttemptSucceeded
export type NodeAttemptSucceeded = SemanticOperationV3.NodeAttemptSucceeded

/**
 * Canonical managed application-failure outcome.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptApplicationFailed = SemanticOperationV3.NodeAttemptApplicationFailed
export type NodeAttemptApplicationFailed = SemanticOperationV3.NodeAttemptApplicationFailed

/**
 * Canonical persisted managed-attempt outcome.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptOutcome = SemanticOperationV3.NodeAttemptOutcome
export type NodeAttemptOutcome = SemanticOperationV3.NodeAttemptOutcome

/**
 * Stable retry-composition failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidInvocation: "InvalidInvocation",
  InvalidInput: "InvalidInput",
  ArtifactMismatch: "ArtifactMismatch",
  UnknownNode: "UnknownNode",
  UnsupportedBlobPayload: "UnsupportedBlobPayload",
  UnsupportedTimeoutPolicy: "UnsupportedTimeoutPolicy",
  OperationPreparationFailed: "OperationPreparationFailed",
  ActivityResolutionFailed: "ActivityResolutionFailed",
  ClockRegression: "ClockRegression"
} as const

/**
 * A retry-composition failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidInvocation,
  ErrorCodes.InvalidInput,
  ErrorCodes.ArtifactMismatch,
  ErrorCodes.UnknownNode,
  ErrorCodes.UnsupportedBlobPayload,
  ErrorCodes.UnsupportedTimeoutPolicy,
  ErrorCodes.OperationPreparationFailed,
  ErrorCodes.ActivityResolutionFailed,
  ErrorCodes.ClockRegression
])

/**
 * A protocol/runtime error raised while preparing or composing retry
 * operations. Business terminal outcomes use {@link TerminalFailure}.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowRetryError extends Schema.TaggedErrorClass<
  EffectWorkflowRetryError
>("@effect/workflow-builder/EffectWorkflowRetryV3/Error")(
  "EffectWorkflowRetryError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    nodeId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationDigest: Schema.optionalKey(Wire.OperationDigest)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Stable defects raised when already-authenticated codec or policy objects
 * violate their admitted contracts.
 *
 * @category constants
 * @since 4.0.0
 */
export const DefectCodes = {
  InvalidOutputDecoding: "InvalidOutputDecoding",
  InvalidPolicyEvaluation: "InvalidPolicyEvaluation"
} as const

export type DefectCode = typeof DefectCodes[keyof typeof DefectCodes]

const DefectCode = Schema.Literals([
  DefectCodes.InvalidOutputDecoding,
  DefectCodes.InvalidPolicyEvaluation
])

/**
 * A retry-composition invariant defect.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowRetryDefect extends Schema.TaggedErrorClass<
  EffectWorkflowRetryDefect
>("@effect/workflow-builder/EffectWorkflowRetryV3/Defect")(
  "EffectWorkflowRetryDefect",
  {
    code: DefectCode,
    message: Schema.NonEmptyString,
    nodeId: Wire.AtomicIdentifier,
    operationId: Wire.AtomicIdentifier,
    operationDigest: Wire.OperationDigest
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * A policy-list override that rejected one application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExplicitNonRetryableDecision = Schema.TaggedStruct(
  "PolicyOverride",
  {
    decisionVersion: Schema.Literal(1),
    matchedBy: Schema.Literals(["ErrorTag", "ErrorCode"])
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ExplicitNonRetryableDecision",
  parseOptions: strictParseOptions
})

/**
 * An exact replay-recorded classifier that rejected one application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClassifierNonRetryableDecision = Schema.TaggedStruct(
  "Classifier",
  {
    decisionVersion: Schema.Literal(1),
    classificationActivityDigest: Wire.OperationDigest
  }
).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3ClassifierNonRetryableDecision",
  parseOptions: strictParseOptions
})

export const NonRetryableDecision = Schema.Union([
  ExplicitNonRetryableDecision,
  ClassifierNonRetryableDecision
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3NonRetryableDecision",
  parseOptions: strictParseOptions
})

/**
 * An application failure rejected before another attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NonRetryable = Schema.TaggedStruct("NonRetryable", {
  terminalVersion: Schema.Literal(1),
  cause: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  decision: NonRetryableDecision
}).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3NonRetryable",
  parseOptions: strictParseOptions
})

export type NonRetryable = Schema.Schema.Type<typeof NonRetryable>

/**
 * A retryable application failure for which attempt or elapsed admission
 * budget was exhausted.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Exhausted = Schema.TaggedStruct("Exhausted", {
  terminalVersion: Schema.Literal(1),
  cause: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classificationActivityDigest: Wire.OperationDigest,
  reason: ActivityPolicyV3.RetryDeniedReason
}).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3Exhausted",
  parseOptions: strictParseOptions
})

export type Exhausted = Schema.Schema.Type<typeof Exhausted>

/**
 * Closed terminal business-failure vocabulary implemented before timeout
 * support.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TerminalFailure = Schema.Union([
  NonRetryable,
  Exhausted
]).annotate({
  identifier: "WorkflowEffectWorkflowRetryV3TerminalFailure",
  parseOptions: strictParseOptions
})

export type TerminalFailure = Schema.Schema.Type<
  typeof TerminalFailure
>

/**
 * Persistable pins exposed by one process-local prepared retry invocation.
 *
 * **Details**
 *
 * Execution additionally requires the exact returned object; structural
 * copies are rejected.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedRetryInvocation {
  readonly invocationVersion: 1
  readonly artifactDigest: Wire.ArtifactDigest
  readonly occurrenceDigest: Wire.OccurrenceDigest
  readonly nodeId: Wire.AtomicIdentifier
  readonly firstActivityDigest: Wire.OperationDigest
}

/**
 * Inputs admitted while preparing one durable retry invocation.
 *
 * @category models
 * @since 4.0.0
 */
export interface PrepareOptions {
  readonly artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables
  readonly occurrence: SemanticOccurrenceV3.PreparedOccurrence
  readonly input: Wire.EncodedPayload
}

/**
 * Explicit infrastructure execution policy. It does not influence business
 * classification, attempt limits, jitter bounds, or backoff.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutionOptions = EffectWorkflowSemanticV3.ActivityExecutionOptions

interface CapturedPrepareOptions {
  readonly artifact: unknown
  readonly occurrence: unknown
  readonly input: unknown
}

interface PreparedAttempt {
  readonly attempt: Wire.PositiveSafeInt
  readonly operation: SemanticOperationV3.PreparedOperation
  readonly resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
}

interface InvocationState {
  readonly artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables
  readonly occurrence: SemanticOccurrenceV3.PreparedOccurrence
  readonly node: SemanticExecutableRegistryV3.ResolvedNodeHandler
  readonly input: Wire.InlineEncodedPayload
  readonly firstAttempt: PreparedAttempt
  readonly initialObservation: SemanticExecutableRegistryV3.ResolvedTimeObservationActivity
}

const invocationStates = new WeakMap<object, InvocationState>()
const decodePayload = Schema.decodeUnknownResult(
  Wire.EncodedPayload,
  strictParseOptions
)

/**
 * Tests whether a value retains exact retry-invocation provenance in this
 * process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (
  value: unknown
): value is PreparedRetryInvocation =>
  typeof value === "object" &&
  value !== null &&
  invocationStates.has(value)

const retryError = (
  code: ErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly operationId?: string | undefined
    readonly operationDigest?: Wire.OperationDigest | undefined
  } = {}
): EffectWorkflowRetryError =>
  new EffectWorkflowRetryError({
    code,
    message,
    ...(options.nodeId === undefined ? undefined : {
      nodeId: options.nodeId
    }),
    ...(options.operationId === undefined ? undefined : {
      operationId: options.operationId
    }),
    ...(options.operationDigest === undefined ? undefined : {
      operationDigest: options.operationDigest
    })
  })

const capturePrepareOptions = (
  input: unknown
): Result.Result<CapturedPrepareOptions, EffectWorkflowRetryError> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must be a plain object"
      ))
    }
    const prototype = Object.getPrototypeOf(input)
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must not use an exotic prototype"
      ))
    }
    if (Object.getOwnPropertySymbols(input).length !== 0) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must not contain symbol properties"
      ))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const names = Object.getOwnPropertyNames(descriptors).sort()
    const expected = ["artifact", "input", "occurrence"]
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      return Result.fail(retryError(
        ErrorCodes.InvalidInvocation,
        "Retry preparation options must contain exactly artifact, occurrence, and input"
      ))
    }
    const artifact = descriptors.artifact
    const occurrence = descriptors.occurrence
    const payload = descriptors.input
    for (
      const [name, descriptor] of [
        ["artifact", artifact],
        ["occurrence", occurrence],
        ["input", payload]
      ] as const
    ) {
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        ) ||
        descriptor.enumerable !== true
      ) {
        return Result.fail(retryError(
          ErrorCodes.InvalidInvocation,
          `Retry preparation option '${name}' must be an enumerable data property`
        ))
      }
    }
    return Result.succeed(Object.freeze({
      artifact: artifact!.value,
      occurrence: occurrence!.value,
      input: payload!.value
    }))
  } catch {
    return Result.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry preparation options could not be inspected safely"
    ))
  }
}

const causeMessage = (cause: unknown): string => {
  try {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "message" in cause &&
      typeof cause.message === "string" &&
      cause.message.length > 0
    ) {
      return cause.message
    }
    return String(cause)
  } catch {
    return "Unknown internal failure"
  }
}

const builtIn = (
  schema: SemanticOperationV3.BuiltInSchemaName
) => ({
  _tag: "BuiltIn" as const,
  contractReferenceVersion: 1 as const,
  vocabularyVersion: 1 as const,
  schema
})

type ResolutionByTag = {
  readonly NodeAttempt: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
  readonly RetryClassifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity
  readonly RetryDelaySelection: SemanticExecutableRegistryV3.ResolvedRetryDelaySelectionActivity
  readonly TimeObservation: SemanticExecutableRegistryV3.ResolvedTimeObservationActivity
}

const prepareOperation = (
  occurrence: SemanticOccurrenceV3.PreparedOccurrence,
  nodeId: string,
  operationId: string,
  input: unknown
): Effect.Effect<
  SemanticOperationV3.PreparedOperation,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  SemanticOperationV3.prepare(occurrence, input).pipe(
    Effect.mapError((cause) =>
      retryError(
        ErrorCodes.OperationPreparationFailed,
        `Could not prepare retry operation '${operationId}': ${causeMessage(cause)}`,
        { nodeId, operationId }
      )
    )
  )

const resolveActivity = <K extends keyof ResolutionByTag>(
  artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables,
  operation: SemanticOperationV3.PreparedOperation,
  expected: K
): Effect.Effect<ResolutionByTag[K], EffectWorkflowRetryError> =>
  Effect.suspend(() => {
    const resolved = SemanticExecutableRegistryV3.resolveActivity(
      artifact,
      operation
    )
    if (Result.isFailure(resolved)) {
      return Effect.fail(retryError(
        ErrorCodes.ActivityResolutionFailed,
        `Could not resolve retry operation '${operation.document.operationId}': ${resolved.failure.message}`,
        {
          nodeId: operation.document.occurrence.document.nodeId,
          operationId: operation.document.operationId,
          operationDigest: operation.operationDigest
        }
      ))
    }
    if (resolved.success._tag !== expected) {
      return Effect.fail(retryError(
        ErrorCodes.ActivityResolutionFailed,
        `Retry operation '${operation.document.operationId}' resolved as '${resolved.success._tag}' instead of '${expected}'`,
        {
          nodeId: operation.document.occurrence.document.nodeId,
          operationId: operation.document.operationId,
          operationDigest: operation.operationDigest
        }
      ))
    }
    return Effect.succeed(
      resolved.success as ResolutionByTag[K]
    )
  })

const prepareAttempt = (
  state: Pick<
    InvocationState,
    "artifact" | "occurrence" | "node" | "input"
  >,
  attempt: Wire.PositiveSafeInt
): Effect.Effect<
  PreparedAttempt,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.NodeAttempt,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.NodeAttempt,
        attempt,
        purpose: {
          _tag: "NodeAttempt",
          purposeVersion: 1,
          nodeDefinitionKey: state.node.binding.nodeDefinitionKey,
          handlerBuildDigest: state.node.binding.handlerBuild.buildDigest
        },
        input: state.input,
        successContract: builtIn("NodeAttemptOutcome"),
        errorContract: builtIn("Never")
      }
    )
    const resolution = yield* resolveActivity(
      state.artifact,
      operation,
      "NodeAttempt"
    )
    return Object.freeze({
      attempt,
      operation,
      resolution
    })
  })

const prepareTimeObservation = (
  state: Pick<
    InvocationState,
    "artifact" | "occurrence" | "node"
  >,
  input: {
    readonly operationId: string
    readonly attempt: Wire.PositiveSafeInt
    readonly owner: SemanticOperationV3.PreparedOperation
    readonly kind: SemanticOperationV3.TimeObservationKind
  }
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedTimeObservationActivity,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      input.operationId,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: input.operationId,
        attempt: input.attempt,
        purpose: {
          _tag: "TimeObservation",
          purposeVersion: 1,
          ownerOperationDigest: input.owner.operationDigest,
          observationKind: input.kind
        },
        input: { _tag: "Inline", value: null },
        successContract: builtIn("CanonicalTimestamp"),
        errorContract: builtIn("Never")
      }
    )
    return yield* resolveActivity(
      state.artifact,
      operation,
      "TimeObservation"
    )
  })

const prepareClassifier = (
  state: InvocationState,
  attempt: PreparedAttempt,
  failure: ActivityPolicyV3.ApplicationFailure
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const classifier = state.node.binding.activityPolicy.retry.classifier
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.Classifier,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.Classifier,
        attempt: attempt.attempt,
        purpose: {
          _tag: "RetryClassifier",
          purposeVersion: 1,
          failedActivityDigest: attempt.operation.operationDigest,
          classifierKey: PlanStoreV3.classifierKey(
            classifier.classifierId,
            classifier.classifierVersion
          ),
          classifierBuildDigest: classifier.buildDigest
        },
        input: { _tag: "Inline", value: failure },
        successContract: builtIn("RetryClassification"),
        errorContract: builtIn("Never")
      }
    )
    return yield* resolveActivity(
      state.artifact,
      operation,
      "RetryClassifier"
    )
  })

const prepareDelaySelection = (
  state: InvocationState,
  attempt: PreparedAttempt,
  classification: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  input: ActivityPolicyV3.RetryDelayInput
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedRetryDelaySelectionActivity,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const operation = yield* prepareOperation(
      state.occurrence,
      state.node.binding.nodeId,
      OperationIds.Delay,
      {
        _tag: "Activity",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: OperationIds.Delay,
        attempt: attempt.attempt,
        purpose: {
          _tag: "RetryDelaySelection",
          purposeVersion: 1,
          failedActivityDigest: attempt.operation.operationDigest,
          classificationActivityDigest: classification.operation.operationDigest
        },
        input: { _tag: "Inline", value: input },
        successContract: builtIn("RecordedRetryDelay"),
        errorContract: builtIn("Never")
      }
    )
    return yield* resolveActivity(
      state.artifact,
      operation,
      "RetryDelaySelection"
    )
  })

const prepareBackoff = (
  state: InvocationState,
  attempt: PreparedAttempt,
  delay: ActivityPolicyV3.RecordedRetryDelay
): Effect.Effect<
  SemanticOperationV3.PreparedOperation,
  EffectWorkflowRetryError,
  Crypto.Crypto
> =>
  prepareOperation(
    state.occurrence,
    state.node.binding.nodeId,
    OperationIds.Backoff,
    {
      _tag: "Timer",
      operationVersion: SemanticOperationV3.OperationVersion,
      executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
      operationId: OperationIds.Backoff,
      generation: delay.retryOrdinal,
      owner: {
        _tag: "RetryBackoff",
        failedActivityDigest: attempt.operation.operationDigest
      },
      delayMillis: delay.selectedDelayMillis
    }
  )

const unsupportedTimeout = (
  policy: ActivityPolicyV3.TimeoutPolicy
): string | undefined => {
  if (policy.scheduleToStart._tag !== "Disabled") {
    return "scheduleToStart"
  }
  if (policy.startToClose._tag !== "Disabled") {
    return "startToClose"
  }
  if (policy.scheduleToClose._tag !== "Disabled") {
    return "scheduleToClose"
  }
  return undefined
}

/**
 * Prepares an exact process-local retry invocation.
 *
 * **Details**
 *
 * The three capability-bearing options are captured through own data-property
 * descriptors before any value is read. Getters, symbols, extra properties,
 * exotic prototypes, copied capabilities, blobs, and enabled timeouts fail
 * closed.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = (
  options: PrepareOptions
): Effect.Effect<
  PreparedRetryInvocation,
  EffectWorkflowRetryError,
  Crypto.Crypto
> => {
  const captured = capturePrepareOptions(options)
  if (Result.isFailure(captured)) {
    return Effect.fail(captured.failure)
  }
  const artifact = captured.success.artifact
  const occurrence = captured.success.occurrence
  if (
    !SemanticExecutableRegistryV3
      .isResolvedArtifactExecutables(artifact)
  ) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry preparation requires the exact artifact resolution returned by SemanticExecutableRegistryV3"
    ))
  }
  if (!SemanticOccurrenceV3.isPrepared(occurrence)) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry preparation requires the exact occurrence returned by SemanticOccurrenceV3"
    ))
  }
  if (
    occurrence.document.artifactDigest !==
      artifact.artifactDigest
  ) {
    return Effect.fail(retryError(
      ErrorCodes.ArtifactMismatch,
      "Retry occurrence and executable resolution belong to different artifacts",
      { nodeId: occurrence.document.nodeId }
    ))
  }
  const node = artifact.nodeHandlers.get(
    occurrence.document.nodeId
  )
  if (node === undefined) {
    return Effect.fail(retryError(
      ErrorCodes.UnknownNode,
      "Retry occurrence does not select a resolved node handler",
      { nodeId: occurrence.document.nodeId }
    ))
  }
  const timeout = unsupportedTimeout(
    node.binding.activityPolicy.timeouts
  )
  if (timeout !== undefined) {
    return Effect.fail(retryError(
      ErrorCodes.UnsupportedTimeoutPolicy,
      `Timeout '${timeout}' is enabled but is not implemented by the durable retry facade`,
      { nodeId: node.binding.nodeId }
    ))
  }

  const snapshot = Json.snapshot(captured.success.input)
  if (Result.isFailure(snapshot)) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInput,
      `Retry input must be bounded strict JSON: ${snapshot.failure.message}`,
      { nodeId: node.binding.nodeId }
    ))
  }
  let payload: ReturnType<typeof decodePayload>
  try {
    payload = decodePayload(snapshot.success)
  } catch {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInput,
      "Retry input schema validation threw unexpectedly",
      { nodeId: node.binding.nodeId }
    ))
  }
  if (Result.isFailure(payload)) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInput,
      `Invalid retry input payload: ${payload.failure.message}`,
      { nodeId: node.binding.nodeId }
    ))
  }
  if (payload.success._tag === "Blob") {
    return Effect.fail(retryError(
      ErrorCodes.UnsupportedBlobPayload,
      "Retry node inputs require inline payloads until a digest-verifying BlobStore adapter is available",
      { nodeId: node.binding.nodeId }
    ))
  }
  const inlinePayload = payload.success

  return Effect.gen(function*() {
    const base = {
      artifact,
      occurrence,
      node,
      input: inlinePayload
    }
    const firstAttempt = yield* prepareAttempt(base, 1)
    const initialObservation = yield* prepareTimeObservation(
      base,
      {
        operationId: OperationIds.InitialTime,
        attempt: 1,
        owner: firstAttempt.operation,
        kind: "Initial"
      }
    )
    const invocation = Object.freeze({
      invocationVersion: 1,
      artifactDigest: artifact.artifactDigest,
      occurrenceDigest: occurrence.occurrenceDigest,
      nodeId: node.binding.nodeId,
      firstActivityDigest: firstAttempt.operation.operationDigest
    }) satisfies PreparedRetryInvocation
    invocationStates.set(
      invocation,
      Object.freeze({
        ...base,
        firstAttempt,
        initialObservation
      })
    )
    return invocation
  })
}

const retryDefect = (
  attempt: PreparedAttempt,
  code: DefectCode,
  message: string
): EffectWorkflowRetryDefect =>
  new EffectWorkflowRetryDefect({
    code,
    message,
    nodeId: attempt.resolution.node.binding.nodeId,
    operationId: attempt.operation.document.operationId,
    operationDigest: attempt.operation.operationDigest
  })

const decodeSucceededOutput = (
  attempt: PreparedAttempt,
  outcome: SemanticOperationV3.NodeAttemptSucceeded
): Effect.Effect<unknown> =>
  Schema.decodeUnknownEffect(
    attempt.resolution.node.contract.successSchema,
    strictParseOptions
  )(outcome.output.value).pipe(
    Effect.updateContext((current) =>
      Context.merge(
        attempt.resolution.node.contract.resultCodecContext,
        current
      ) as Context.Context<any>
    ),
    Effect.mapError((cause) =>
      retryDefect(
        attempt,
        DefectCodes.InvalidOutputDecoding,
        `Persisted node-attempt output is incompatible with its exact codecs: ${cause.message}`
      )
    ),
    Effect.orDie
  ) as Effect.Effect<unknown>

const elapsedBetween = (
  nodeId: string,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp
): Result.Result<
  Wire.SemanticDelayMillis,
  EffectWorkflowRetryError
> => {
  const initialEpoch = Date.parse(initialObservedAt)
  const failedEpoch = Date.parse(failedObservedAt)
  if (
    !Number.isSafeInteger(initialEpoch) ||
    !Number.isSafeInteger(failedEpoch)
  ) {
    return Result.fail(retryError(
      ErrorCodes.ClockRegression,
      "A canonical retry time observation could not be represented as safe epoch milliseconds",
      { nodeId }
    ))
  }
  if (failedEpoch < initialEpoch) {
    return Result.fail(retryError(
      ErrorCodes.ClockRegression,
      "Failure time precedes the initial retry-budget observation",
      { nodeId }
    ))
  }
  return Result.succeed(
    Math.min(
      failedEpoch - initialEpoch,
      Wire.MaximumSemanticDelayMillis
    ) as Wire.SemanticDelayMillis
  )
}

const explicitTerminal = (
  failure: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  disposition: Extract<
    ActivityPolicyV3.FailureDisposition,
    { readonly _tag: "ExplicitNonRetryable" }
  >
): NonRetryable =>
  Object.freeze({
    _tag: "NonRetryable",
    terminalVersion: 1,
    cause: failure,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    decision: {
      _tag: "PolicyOverride" as const,
      decisionVersion: 1 as const,
      matchedBy: disposition.matchedBy
    }
  })

const classifiedTerminal = (
  failure: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity
): NonRetryable =>
  Object.freeze({
    _tag: "NonRetryable",
    terminalVersion: 1,
    cause: failure,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    decision: {
      _tag: "Classifier" as const,
      decisionVersion: 1 as const,
      classificationActivityDigest: classifier.operation.operationDigest
    }
  })

const exhaustedTerminal = (
  failure: ActivityPolicyV3.ApplicationFailure,
  initialObservedAt: Wire.Timestamp,
  failedObservedAt: Wire.Timestamp,
  elapsedMillis: Wire.SemanticDelayMillis,
  classifier: SemanticExecutableRegistryV3.ResolvedRetryClassifierActivity,
  reason: ActivityPolicyV3.RetryDeniedReason
): Exhausted =>
  Object.freeze({
    _tag: "Exhausted",
    terminalVersion: 1,
    cause: failure,
    initialObservedAt,
    failedObservedAt,
    elapsedMillis,
    classificationActivityDigest: classifier.operation.operationDigest,
    reason
  })

/**
 * Executes an opaque prepared invocation through native durable activities and
 * timers.
 *
 * **Details**
 *
 * Explicit non-retryable lists are evaluated before the exact durable
 * classifier. Retryable failures pass through deterministic range evaluation,
 * internally sampled replay-recorded jitter, and a durable positive backoff
 * timer. Zero-delay transitions do not allocate a timer.
 *
 * `maximumElapsed` is an admission budget for scheduling another attempt, not
 * a hard deadline for an already-running attempt.
 *
 * @category execution
 * @since 4.0.0
 */
export const execute = (
  invocation: PreparedRetryInvocation,
  options: ExecutionOptions
): Effect.Effect<
  unknown,
  | TerminalFailure
  | EffectWorkflowRetryError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | Crypto.Crypto
  | EffectWorkflowSemanticV3.Requirements
> => {
  const state = invocationStates.get(invocation)
  if (state === undefined) {
    return Effect.fail(retryError(
      ErrorCodes.InvalidInvocation,
      "Retry execution requires the exact PreparedRetryInvocation returned by prepare"
    ))
  }
  return Effect.gen(function*() {
    const initialObservedAt = yield* EffectWorkflowSemanticV3.timeObservation(
      state.initialObservation,
      options
    )
    let attempt = state.firstAttempt

    while (true) {
      const outcome = yield* EffectWorkflowSemanticV3.nodeAttempt(
        attempt.resolution,
        options
      )
      if (outcome._tag === "Succeeded") {
        return yield* decodeSucceededOutput(attempt, outcome)
      }
      const failure = outcome.failure
      const failureObservation = yield* prepareTimeObservation(state, {
        operationId: OperationIds.FailureTime,
        attempt: attempt.attempt,
        owner: attempt.operation,
        kind: "Failure"
      })
      const failedObservedAt = yield* EffectWorkflowSemanticV3.timeObservation(
        failureObservation,
        options
      )
      const elapsedMillis = yield* Effect.fromResult(
        elapsedBetween(
          state.node.binding.nodeId,
          initialObservedAt,
          failedObservedAt
        )
      )
      const disposition = ActivityPolicyV3.failureDisposition(
        state.node.binding.activityPolicy,
        failure.identity
      )
      if (Result.isFailure(disposition)) {
        return yield* Effect.die(retryDefect(
          attempt,
          DefectCodes.InvalidPolicyEvaluation,
          `Failure disposition evaluation failed: ${disposition.failure.message}`
        ))
      }
      if (
        disposition.success._tag ===
          "ExplicitNonRetryable"
      ) {
        return yield* Effect.fail(explicitTerminal(
          failure,
          initialObservedAt,
          failedObservedAt,
          elapsedMillis,
          disposition.success
        ))
      }

      const classifier = yield* prepareClassifier(
        state,
        attempt,
        failure
      )
      const classification = yield* EffectWorkflowSemanticV3.retryClassifier(
        classifier,
        options
      )
      if (classification._tag === "NonRetryable") {
        return yield* Effect.fail(classifiedTerminal(
          failure,
          initialObservedAt,
          failedObservedAt,
          elapsedMillis,
          classifier
        ))
      }

      const delayInput = {
        evaluationVersion: 1,
        failedAttempt: attempt.attempt,
        elapsedMillis
      } satisfies ActivityPolicyV3.RetryDelayInput
      const decision = ActivityPolicyV3.retryDelayRange(
        state.node.binding.activityPolicy,
        delayInput
      )
      if (Result.isFailure(decision)) {
        return yield* Effect.die(retryDefect(
          attempt,
          DefectCodes.InvalidPolicyEvaluation,
          `Retry-delay evaluation failed: ${decision.failure.message}`
        ))
      }
      if (decision.success._tag === "DoNotRetry") {
        return yield* Effect.fail(exhaustedTerminal(
          failure,
          initialObservedAt,
          failedObservedAt,
          elapsedMillis,
          classifier,
          decision.success.reason
        ))
      }

      const delayResolution = yield* prepareDelaySelection(
        state,
        attempt,
        classifier,
        delayInput
      )
      const delay = yield* EffectWorkflowSemanticV3.retryDelaySelection(
        delayResolution,
        options
      )
      if (delay.selectedDelayMillis > 0) {
        const timer = yield* prepareBackoff(
          state,
          attempt,
          delay
        )
        yield* EffectWorkflowSemanticV3.sleep(timer)
      }
      attempt = yield* prepareAttempt(
        state,
        delay.nextAttempt
      )
    }
  })
}
