/**
 * Reconstructs exact durable workflow meaning from immutable storage pins.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Compiler from "./Compiler.ts"
import * as Decision from "./Decision.ts"
import * as Deployment from "./Deployment.ts"
import type * as Diagnostic from "./Diagnostic.ts"
import * as Event from "./Event.ts"
import * as ExecutionStore from "./ExecutionStore.ts"
import * as Fingerprint from "./Fingerprint.ts"
import type * as HistoryStore from "./HistoryStore.ts"
import * as Json from "./internal/json.ts"
import * as Node from "./Node.ts"
import * as PlanStore from "./PlanStore.ts"
import * as RunState from "./RunState.ts"
import * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const RecoveredRunTypeId: unique symbol = Symbol(
  "@effect/workflow-builder/DurableRecovery/RecoveredRun"
)
const recoveredRuns = new WeakSet<object>()

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const BoundPlan = Schema.Struct({
  binding: PlanStore.RunBinding,
  artifact: PlanStore.PlanArtifact
})

const HistorySnapshot = Schema.Struct({
  runId: Schema.NonEmptyString,
  lastSequence: NonNegativeInt,
  events: Schema.Array(Event.Event)
})

const decodeKey = Schema.decodeUnknownResult(PlanStore.RunKey, strictParseOptions)
const decodeBoundPlan = Schema.decodeUnknownResult(BoundPlan, strictParseOptions)
const decodeHistorySnapshot = Schema.decodeUnknownResult(HistorySnapshot, strictParseOptions)
const decodeFingerprint = Schema.decodeUnknownResult(Fingerprint.Digest, strictParseOptions)
const decodeArtifactDigest = Schema.decodeUnknownResult(PlanStore.ArtifactDigest, strictParseOptions)

/**
 * Stable machine-readable durable-recovery integrity failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidKey: "InvalidKey",
  InvalidExpectedDeployment: "InvalidExpectedDeployment",
  InvalidBoundPlan: "InvalidBoundPlan",
  InvalidHistorySnapshot: "InvalidHistorySnapshot",
  BindingMismatch: "BindingMismatch",
  ArtifactDigestMismatch: "ArtifactDigestMismatch",
  CompiledFingerprintMismatch: "CompiledFingerprintMismatch",
  StartMismatch: "StartMismatch",
  WorkflowDeploymentMismatch: "WorkflowDeploymentMismatch",
  HandlerDeploymentMismatch: "HandlerDeploymentMismatch",
  RecompiledPlanMismatch: "RecompiledPlanMismatch"
} as const

/**
 * A stable machine-readable durable-recovery integrity code.
 *
 * @category models
 * @since 4.0.0
 */
export type DurableRecoveryErrorCode = typeof Codes[keyof typeof Codes]

const DurableRecoveryErrorCode = Schema.Literals([
  Codes.InvalidKey,
  Codes.InvalidExpectedDeployment,
  Codes.InvalidBoundPlan,
  Codes.InvalidHistorySnapshot,
  Codes.BindingMismatch,
  Codes.ArtifactDigestMismatch,
  Codes.CompiledFingerprintMismatch,
  Codes.StartMismatch,
  Codes.WorkflowDeploymentMismatch,
  Codes.HandlerDeploymentMismatch,
  Codes.RecompiledPlanMismatch
])

/**
 * Raised when stored durable meaning is malformed, substituted, or internally
 * inconsistent.
 *
 * @category errors
 * @since 4.0.0
 */
export class DurableRecoveryError extends Schema.TaggedErrorClass<DurableRecoveryError>(
  "@effect/workflow-builder/DurableRecovery/DurableRecoveryError"
)("DurableRecoveryError", {
  code: DurableRecoveryErrorCode,
  tenantId: Schema.String,
  runId: Schema.String,
  message: Schema.NonEmptyString,
  nodeId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * A reconstructed run whose compiler, decision, and deployment provenance has
 * been re-established in the current process.
 *
 * @category models
 * @since 4.0.0
 */
export interface RecoveredRun<out W extends Workflow.Any = Workflow.Any> {
  readonly [RecoveredRunTypeId]: true
  readonly key: PlanStore.RunKey
  readonly boundPlan: PlanStore.BoundPlan
  readonly binding: PlanStore.RunBinding
  readonly artifact: PlanStore.PlanArtifact
  readonly history: HistoryStore.HistorySnapshot
  readonly plan: Decision.DecidablePlan<W>
  readonly state: RunState.RunState
  readonly dispatchTargets: PlanStore.DispatchTargets
}

/**
 * Effect services required to recover one concrete workflow deployment.
 *
 * **Details**
 *
 * The concrete workflow type is retained by the expected deployment witness.
 * This prevents the requirements of `Workflow.Any` from widening the Effect
 * environment to `any`.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | PlanStore.PlanStore
  | ExecutionStore.ExecutionStore
  | Deployment.DeploymentCatalog
  | Crypto.Crypto
  | Compiler.Requirements<W>

/**
 * Failures that may be produced while recovering one concrete workflow
 * deployment.
 *
 * @category errors
 * @since 4.0.0
 */
export type RecoverError<W extends Workflow.Any> =
  | DurableRecoveryError
  | PlanStore.RunBindingNotFound
  | PlanStore.ArtifactNotFound
  | PlanStore.PlanStoreFailure
  | ExecutionStore.RunNotFound
  | ExecutionStore.ExecutionStoreFailure
  | Deployment.DeploymentResolutionError
  | Diagnostic.CompilationError
  | Workflow.PolicyError<W>
  | RunState.HistoryError
  | Decision.DecisionError
  | PlatformError.PlatformError

interface ExpectedDeployment<W extends Workflow.Any> {
  readonly deploymentId: string
  readonly definition: W
}

const makeError = (
  code: DurableRecoveryErrorCode,
  key: { readonly tenantId: string; readonly runId: string },
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): DurableRecoveryError =>
  new DurableRecoveryError({
    code,
    tenantId: key.tenantId,
    runId: key.runId,
    message,
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const parse = <A>(
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>,
  input: unknown,
  code: DurableRecoveryErrorCode,
  key: { readonly tenantId: string; readonly runId: string },
  subject: string
): Result.Result<A, DurableRecoveryError> => {
  let decoded: Result.Result<A, { readonly message: string }>
  try {
    decoded = decode(input)
  } catch {
    return Result.fail(makeError(
      code,
      key,
      `${subject} schema validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(code, key, `Invalid ${subject.toLowerCase()}`, {
      details: { parseError: decoded.failure.message }
    }))
    : Result.succeed(decoded.success)
}

const snapshotKey = (
  input: unknown
): Result.Result<PlanStore.RunKey, DurableRecoveryError> => {
  const emptyKey = { tenantId: "", runId: "" }
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidKey,
      emptyKey,
      `Durable recovery key must be strict JSON: ${snapped.failure.message}`,
      {
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      }
    ))
  }
  const decoded = parse(
    decodeKey,
    snapped.success,
    Codes.InvalidKey,
    emptyKey,
    "Durable recovery key"
  )
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure)
    : Result.succeed(snapped.success as unknown as PlanStore.RunKey)
}

const captureExpectedDeployment = <W extends Workflow.Any>(
  input: Deployment.WorkflowDefinitionDeployment<W>,
  key: PlanStore.RunKey
): Result.Result<ExpectedDeployment<W>, DurableRecoveryError> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(makeError(
        Codes.InvalidExpectedDeployment,
        key,
        "Expected workflow deployment must be an object"
      ))
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      return Result.fail(makeError(
        Codes.InvalidExpectedDeployment,
        key,
        "Expected workflow deployment must be a plain object"
      ))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    const deploymentId = descriptors.deploymentId
    const definition = descriptors.definition
    if (
      keys.length !== 2 ||
      deploymentId === undefined ||
      definition === undefined ||
      !Object.prototype.hasOwnProperty.call(deploymentId, "value") ||
      !Object.prototype.hasOwnProperty.call(definition, "value") ||
      deploymentId.enumerable !== true ||
      definition.enumerable !== true ||
      typeof deploymentId.value !== "string" ||
      deploymentId.value.length === 0 ||
      typeof definition.value !== "object" ||
      definition.value === null ||
      !Workflow.isDefinition(definition.value)
    ) {
      return Result.fail(makeError(
        Codes.InvalidExpectedDeployment,
        key,
        "Expected workflow deployment must contain exactly a non-empty deploymentId and definition data property"
      ))
    }
    return Result.succeed(Object.freeze({
      deploymentId: deploymentId.value,
      definition: definition.value as W
    }))
  } catch {
    return Result.fail(makeError(
      Codes.InvalidExpectedDeployment,
      key,
      "Expected workflow deployment could not be inspected safely"
    ))
  }
}

const snapshotBoundPlan = (
  input: unknown,
  key: PlanStore.RunKey
): Result.Result<PlanStore.BoundPlan, DurableRecoveryError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidBoundPlan,
      key,
      `Bound plan must be strict JSON: ${snapped.failure.message}`,
      {
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      }
    ))
  }
  const decoded = parse(
    decodeBoundPlan,
    snapped.success,
    Codes.InvalidBoundPlan,
    key,
    "Bound plan"
  )
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  const bound = snapped.success as unknown as PlanStore.BoundPlan
  const artifact = PlanStore.validateArtifact(bound.artifact)
  if (Result.isFailure(artifact)) {
    return Result.fail(makeError(
      Codes.InvalidBoundPlan,
      key,
      artifact.failure.message,
      {
        details: {
          artifactCode: artifact.failure.code,
          ...(artifact.failure.details === undefined
            ? undefined
            : { artifactDetails: artifact.failure.details })
        }
      }
    ))
  }
  return Result.succeed(Object.freeze({
    binding: bound.binding,
    artifact: artifact.success
  }))
}

const snapshotHistory = (
  input: unknown,
  key: PlanStore.RunKey
): Result.Result<HistoryStore.HistorySnapshot, DurableRecoveryError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(makeError(
      Codes.InvalidHistorySnapshot,
      key,
      `History snapshot must be strict JSON: ${snapped.failure.message}`,
      {
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      }
    ))
  }
  const decoded = parse(
    decodeHistorySnapshot,
    snapped.success,
    Codes.InvalidHistorySnapshot,
    key,
    "History snapshot"
  )
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  const history = snapped.success as unknown as HistoryStore.HistorySnapshot
  if (
    history.events.length === 0 ||
    history.lastSequence !== history.events.length - 1
  ) {
    return Result.fail(makeError(
      Codes.InvalidHistorySnapshot,
      key,
      "History snapshot head must exactly match its non-empty event array",
      {
        details: {
          lastSequence: history.lastSequence,
          eventCount: history.events.length
        }
      }
    ))
  }
  return Result.succeed(history)
}

const sameKey = (
  left: PlanStore.RunKey,
  right: PlanStore.RunKey
): boolean => left.tenantId === right.tenantId && left.runId === right.runId

const canonicalEqual = (
  left: Schema.Json,
  right: Schema.Json
): boolean => Json.canonicalizeSnapshot(left) === Json.canonicalizeSnapshot(right)

const checkStartRelations = (
  key: PlanStore.RunKey,
  binding: PlanStore.RunBinding,
  artifact: PlanStore.PlanArtifact,
  history: HistoryStore.HistorySnapshot,
  state: RunState.RunState
): Result.Result<void, DurableRecoveryError> => {
  if (history.runId !== key.runId || state.runId !== key.runId || state.sequence !== history.lastSequence) {
    return Result.fail(makeError(
      Codes.StartMismatch,
      key,
      "History identity or head does not match the requested durable run",
      {
        details: {
          historyRunId: history.runId,
          stateRunId: state.runId,
          stateSequence: state.sequence,
          lastSequence: history.lastSequence
        }
      }
    ))
  }

  const first = history.events[0]!
  if (
    first.payload._tag !== "RunStarted" ||
    first.eventId !== binding.runStartedEventId
  ) {
    return Result.fail(makeError(
      Codes.StartMismatch,
      key,
      "History start event does not match the durable run binding",
      {
        details: {
          bindingEventId: binding.runStartedEventId,
          historyEventId: first.eventId,
          eventTag: first.payload._tag
        }
      }
    ))
  }

  const started = first.payload
  const portable = artifact.fingerprintDocument.plan
  if (
    started.backend !== "durable" ||
    started.planId !== portable.id ||
    started.planRevision !== portable.revision ||
    started.definitionId !== portable.definition.id ||
    started.definitionVersion !== portable.definition.version ||
    started.compilerVersion !== artifact.fingerprintDocument.compilerSemanticVersion ||
    started.compiledFingerprint !== artifact.compiledFingerprint
  ) {
    return Result.fail(makeError(
      Codes.StartMismatch,
      key,
      "History start pins do not match the bound durable plan artifact",
      {
        details: {
          expected: {
            backend: "durable",
            planId: portable.id,
            planRevision: portable.revision,
            definitionId: portable.definition.id,
            definitionVersion: portable.definition.version,
            compilerVersion: artifact.fingerprintDocument.compilerSemanticVersion,
            compiledFingerprint: artifact.compiledFingerprint
          },
          actual: {
            backend: started.backend,
            planId: started.planId,
            planRevision: started.planRevision,
            definitionId: started.definitionId,
            definitionVersion: started.definitionVersion,
            compilerVersion: started.compilerVersion,
            compiledFingerprint: started.compiledFingerprint
          }
        }
      }
    ))
  }
  return Result.succeed(undefined)
}

/**
 * Tests whether a value is the exact object returned by {@link recover}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isRecovered = (value: unknown): value is RecoveredRun =>
  typeof value === "object" && value !== null && recoveredRuns.has(value)

/**
 * Reconstructs one durable run against an exact typed workflow deployment.
 *
 * **Details**
 *
 * The persisted deployment identifier still governs catalog resolution. The
 * typed deployment argument is a witness: recovery requires the catalog's
 * exact resolved workflow object to be the same object as the witness before
 * compilation. This retains `W` and `Compiler.Requirements<W>` without
 * exposing the erased requirements of `Workflow.Any`.
 *
 * Store outputs cross strict detached JSON boundaries. Recovery independently
 * verifies the binding, artifact digest, compiled fingerprint, start event,
 * full recompiled fingerprint document, and exact handler-definition objects.
 * It recompiles, prepares, folds, and performs one pure decision validation
 * before returning a process-local provenance-marked context.
 *
 * @category recovery
 * @since 4.0.0
 */
export const recover = Effect.fnUntraced(function*<W extends Workflow.Any>(
  inputKey: PlanStore.RunKey,
  inputExpected: Deployment.WorkflowDefinitionDeployment<W>
): Effect.fn.Return<
  RecoveredRun<W>,
  RecoverError<W>,
  Requirements<W>
> {
  const capturedKey = snapshotKey(inputKey)
  if (Result.isFailure(capturedKey)) {
    return yield* Effect.fail(capturedKey.failure)
  }
  const key = capturedKey.success

  const capturedExpected = captureExpectedDeployment(inputExpected, key)
  if (Result.isFailure(capturedExpected)) {
    return yield* Effect.fail(capturedExpected.failure)
  }
  const expected = capturedExpected.success

  const planStore = yield* PlanStore.PlanStore
  const executionStore = yield* ExecutionStore.ExecutionStore
  const catalog = yield* Deployment.DeploymentCatalog

  const storedBound = yield* planStore.getForRun(key)
  const boundResult = snapshotBoundPlan(storedBound, key)
  if (Result.isFailure(boundResult)) {
    return yield* Effect.fail(boundResult.failure)
  }
  const bound = boundResult.success

  if (!sameKey(bound.binding.key, key)) {
    return yield* Effect.fail(makeError(
      Codes.BindingMismatch,
      key,
      "Durable run binding key does not match the requested key",
      {
        details: {
          expected: key,
          actual: bound.binding.key
        }
      }
    ))
  }

  const storedHistory = yield* executionStore.read(key)
  const historyResult = snapshotHistory(storedHistory, key)
  if (Result.isFailure(historyResult)) {
    return yield* Effect.fail(historyResult.failure)
  }
  const history = historyResult.success

  const computedFingerprint = yield* Fingerprint.digest(
    bound.artifact.fingerprintDocument as unknown as Schema.Json
  )
  const decodedFingerprint = parse(
    decodeFingerprint,
    computedFingerprint,
    Codes.CompiledFingerprintMismatch,
    key,
    "Compiled fingerprint"
  )
  if (
    Result.isFailure(decodedFingerprint) ||
    computedFingerprint !== bound.artifact.compiledFingerprint
  ) {
    return yield* Effect.fail(makeError(
      Codes.CompiledFingerprintMismatch,
      key,
      "Stored compiled fingerprint does not match its fingerprint document",
      {
        details: {
          declared: bound.artifact.compiledFingerprint,
          computed: computedFingerprint
        }
      }
    ))
  }

  const rawArtifactDigest = yield* Fingerprint.digest(
    bound.artifact as unknown as Schema.Json
  )
  const computedArtifactDigest = parse(
    decodeArtifactDigest,
    rawArtifactDigest,
    Codes.ArtifactDigestMismatch,
    key,
    "Plan artifact digest"
  )
  if (
    Result.isFailure(computedArtifactDigest) ||
    computedArtifactDigest.success !== bound.binding.artifactDigest
  ) {
    return yield* Effect.fail(makeError(
      Codes.ArtifactDigestMismatch,
      key,
      "Stored plan artifact digest does not match its content",
      {
        details: {
          declared: bound.binding.artifactDigest,
          computed: rawArtifactDigest
        }
      }
    ))
  }

  const stateResult = RunState.fold(history.events)
  if (Result.isFailure(stateResult)) {
    return yield* Effect.fail(stateResult.failure)
  }
  const state = stateResult.success
  const startRelations = checkStartRelations(
    key,
    bound.binding,
    bound.artifact,
    history,
    state
  )
  if (Result.isFailure(startRelations)) {
    return yield* Effect.fail(startRelations.failure)
  }

  const portable = bound.artifact.fingerprintDocument.plan
  if (expected.deploymentId !== bound.artifact.definitionDeploymentId) {
    return yield* Effect.fail(makeError(
      Codes.WorkflowDeploymentMismatch,
      key,
      "Expected workflow deployment does not match the artifact deployment pin",
      {
        details: {
          expectedDeploymentId: expected.deploymentId,
          artifactDeploymentId: bound.artifact.definitionDeploymentId
        }
      }
    ))
  }

  const resolvedWorkflow = yield* catalog.resolveWorkflowDefinition({
    deploymentId: bound.artifact.definitionDeploymentId,
    definitionId: portable.definition.id,
    definitionVersion: portable.definition.version
  })
  if (resolvedWorkflow !== expected.definition) {
    return yield* Effect.fail(makeError(
      Codes.WorkflowDeploymentMismatch,
      key,
      "Deployment catalog resolved a different workflow definition object than the typed witness",
      {
        details: {
          deploymentId: bound.artifact.definitionDeploymentId,
          definitionId: portable.definition.id,
          definitionVersion: portable.definition.version
        }
      }
    ))
  }

  const resolvedHandlers = new Map<string, Node.Any>()
  for (const node of portable.nodes) {
    const target = bound.artifact.dispatchTargets[node.id]!
    const resolved = yield* catalog.resolveHandlerDefinition({
      deploymentId: target.deploymentId,
      type: node.type,
      version: node.version
    })
    const registryKey = `${node.type}@${node.version}`
    const registered = Object.prototype.hasOwnProperty.call(
        expected.definition.nodes.definitions,
        registryKey
      )
      ? expected.definition.nodes.definitions[registryKey]
      : undefined
    if (
      !Node.isDefinition(resolved) ||
      registered === undefined ||
      resolved !== registered
    ) {
      return yield* Effect.fail(makeError(
        Codes.HandlerDeploymentMismatch,
        key,
        "Handler deployment did not resolve to the workflow registry's exact definition object",
        {
          nodeId: node.id,
          details: {
            deploymentId: target.deploymentId,
            type: node.type,
            version: node.version
          }
        }
      ))
    }
    resolvedHandlers.set(node.id, resolved)
  }

  const compiled = yield* Compiler.compile(
    expected.definition,
    portable
  )
  const recompiledDocument = Fingerprint.materialize(compiled)
  if (
    !canonicalEqual(
      recompiledDocument as unknown as Schema.Json,
      bound.artifact.fingerprintDocument as unknown as Schema.Json
    )
  ) {
    return yield* Effect.fail(makeError(
      Codes.RecompiledPlanMismatch,
      key,
      "Recompiled fingerprint document does not match the stored document"
    ))
  }

  for (const [nodeId, definition] of resolvedHandlers) {
    if (compiled.nodes.get(nodeId)?.definition !== definition) {
      return yield* Effect.fail(makeError(
        Codes.HandlerDeploymentMismatch,
        key,
        "Compiled node does not retain the exact resolved handler definition object",
        { nodeId }
      ))
    }
  }

  const plan = yield* Decision.prepare(compiled)
  if (
    plan.compilerVersion !== bound.artifact.fingerprintDocument.compilerSemanticVersion ||
    plan.compiledFingerprint !== bound.artifact.compiledFingerprint
  ) {
    return yield* Effect.fail(makeError(
      Codes.RecompiledPlanMismatch,
      key,
      "Reprepared plan pins do not match the stored durable artifact",
      {
        details: {
          expectedCompilerVersion: bound.artifact.fingerprintDocument.compilerSemanticVersion,
          actualCompilerVersion: plan.compilerVersion,
          expectedFingerprint: bound.artifact.compiledFingerprint,
          actualFingerprint: plan.compiledFingerprint
        }
      }
    ))
  }

  const decided = Decision.decide(plan, state)
  if (Result.isFailure(decided)) {
    return yield* Effect.fail(decided.failure)
  }

  const recovered: RecoveredRun<W> = Object.freeze({
    [RecoveredRunTypeId]: true as const,
    key,
    boundPlan: bound,
    binding: bound.binding,
    artifact: bound.artifact,
    history,
    plan,
    state,
    dispatchTargets: bound.artifact.dispatchTargets
  })
  recoveredRuns.add(recovered)
  return recovered
})
