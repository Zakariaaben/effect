/**
 * Pure static-DAG decisions for execution protocol version `2`.
 *
 * **Details**
 *
 * Preparation binds exact compiler provenance to one strict durable artifact
 * and its domain-separated digest. Decisions consume only reducer-authorized
 * history state and emit deterministic semantic commands. No clock, absolute
 * deadline, worker observation, or other external fact enters this module.
 *
 * Version `1` static DAGs schedule activities only. Structured sleep and signal
 * wait nodes are deliberately not started here; already-admitted durable waits
 * are still consumed and cleaned up deterministically.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "./ActivityPolicy.ts"
import * as Command from "./CommandV2.ts"
import * as Compiler from "./Compiler.ts"
import * as Digest from "./DigestV2.ts"
import type * as Event from "./EventV2.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as Identity from "./IdentityV2.ts"
import * as Json from "./internal/json.ts"
import * as PlanStore from "./PlanStoreV2.ts"
import type * as ProtocolWire from "./ProtocolV2Wire.ts"
import * as RunState from "./RunStateV2.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PreparedPlanTypeId: unique symbol = Symbol(
  "@effect/workflow-builder/DecisionV2/PreparedPlan"
)
const preparedPlans = new WeakSet<object>()
const decisionBatches = new WeakMap<
  object,
  {
    readonly plan: DecidablePlan
    readonly state: RunState.RunState
  }
>()

/**
 * Stable machine-readable protocol version `2` decision failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  PlanProvenanceMismatch: "PlanProvenanceMismatch",
  InvalidArtifact: "InvalidArtifact",
  FingerprintDocumentMismatch: "FingerprintDocumentMismatch",
  FingerprintMismatch: "FingerprintMismatch",
  InvalidPreparedPlan: "InvalidPreparedPlan",
  StateProvenanceMismatch: "StateProvenanceMismatch",
  InvalidDurableHead: "InvalidDurableHead",
  RunIdentityMismatch: "RunIdentityMismatch",
  ArtifactIdentityMismatch: "ArtifactIdentityMismatch",
  CompilerIdentityMismatch: "CompilerIdentityMismatch",
  InvalidRunInput: "InvalidRunInput",
  UnknownActivityNode: "UnknownActivityNode",
  DuplicateNodeActivity: "DuplicateNodeActivity",
  InvalidActivityIdentity: "InvalidActivityIdentity",
  ActivityPolicyMismatch: "ActivityPolicyMismatch",
  InvalidRouting: "InvalidRouting",
  InvalidTerminalState: "InvalidTerminalState",
  InvalidCommandBatch: "InvalidCommandBatch"
} as const

/**
 * A stable protocol version `2` decision failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type DecisionErrorCode = typeof Codes[keyof typeof Codes]

const DecisionErrorCode = Schema.Literals([
  Codes.PlanProvenanceMismatch,
  Codes.InvalidArtifact,
  Codes.FingerprintDocumentMismatch,
  Codes.FingerprintMismatch,
  Codes.InvalidPreparedPlan,
  Codes.StateProvenanceMismatch,
  Codes.InvalidDurableHead,
  Codes.RunIdentityMismatch,
  Codes.ArtifactIdentityMismatch,
  Codes.CompilerIdentityMismatch,
  Codes.InvalidRunInput,
  Codes.UnknownActivityNode,
  Codes.DuplicateNodeActivity,
  Codes.InvalidActivityIdentity,
  Codes.ActivityPolicyMismatch,
  Codes.InvalidRouting,
  Codes.InvalidTerminalState,
  Codes.InvalidCommandBatch
])

/**
 * A typed preparation or pure-decision failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class DecisionError extends Schema.TaggedErrorClass<DecisionError>(
  "@effect/workflow-builder/DecisionV2/DecisionError"
)("DecisionError", {
  code: DecisionErrorCode,
  message: Schema.NonEmptyString,
  nodeId: Schema.optionalKey(Schema.NonEmptyString),
  logicalActivityId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Exact compiled meaning and durable artifact admitted for pure decisions.
 *
 * @category models
 * @since 4.0.0
 */
export interface DecidablePlan<out W extends Workflow.Any = Workflow.Any> {
  readonly [PreparedPlanTypeId]: true
  readonly compiled: Compiler.CompiledPlan<W>
  readonly artifact: PlanStore.PlanArtifact
  readonly artifactDigest: ProtocolWire.ArtifactDigest
  readonly compilerVersion: typeof Fingerprint.CompilerSemanticVersion
  readonly compiledFingerprint: ProtocolWire.CompiledFingerprint
}

const makeError = (
  code: DecisionErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly logicalActivityId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): DecisionError =>
  new DecisionError({
    code,
    message,
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.logicalActivityId === undefined
      ? undefined
      : { logicalActivityId: options.logicalActivityId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const fail = <A = never>(
  error: DecisionError
): Result.Result<A, DecisionError> => Result.fail(error)

const jsonEqual = (left: unknown, right: unknown): boolean => {
  const leftSnapshot = Json.snapshot(left)
  const rightSnapshot = Json.snapshot(right)
  return Result.isSuccess(leftSnapshot) &&
    Result.isSuccess(rightSnapshot) &&
    Json.canonicalizeSnapshot(leftSnapshot.success) ===
      Json.canonicalizeSnapshot(rightSnapshot.success)
}

const decodeCommand = Schema.decodeUnknownResult(Command.Command, strictParseOptions)

const commands = (
  values: ReadonlyArray<Command.Command>
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> => {
  const snapshot = Json.snapshot(values)
  if (Result.isFailure(snapshot) || !Array.isArray(snapshot.success)) {
    return fail(makeError(
      Codes.InvalidCommandBatch,
      "Decision command batch could not be snapshotted as strict JSON"
    ))
  }
  try {
    for (let index = 0; index < snapshot.success.length; index++) {
      const decoded = decodeCommand(snapshot.success[index])
      if (Result.isFailure(decoded)) {
        return fail(makeError(
          Codes.InvalidCommandBatch,
          "Decision constructed a command outside the protocol version 2 schema",
          { details: { index, issue: decoded.failure.message } }
        ))
      }
    }
  } catch {
    return fail(makeError(
      Codes.InvalidCommandBatch,
      "Decision command schema validation threw unexpectedly"
    ))
  }
  return Result.succeed(snapshot.success as unknown as ReadonlyArray<Command.Command>)
}

const command = (
  state: RunState.RunState,
  commandId: string,
  payload: Command.Payload
): Command.Command => ({
  commandVersion: Command.CommandVersion,
  tenantId: state.tenantId,
  runId: state.runId,
  commandId,
  payload
})

const getHash = <K, V>(
  map: HashMap.HashMap<K, V>,
  key: K
): V | undefined => {
  const value = HashMap.get(map, key)
  return value._tag === "Some" ? value.value : undefined
}

const encodedValues = (
  input: unknown,
  code: typeof Codes.InvalidRunInput | typeof Codes.InvalidRouting,
  message: string,
  nodeId?: string
): Result.Result<Command.EncodedValues, DecisionError> => {
  const snapshot = Json.snapshot(input)
  if (
    Result.isFailure(snapshot) ||
    snapshot.success === null ||
    typeof snapshot.success !== "object" ||
    Array.isArray(snapshot.success) ||
    Object.keys(snapshot.success).some((key) => key.length === 0)
  ) {
    return fail(makeError(code, message, {
      ...(nodeId === undefined ? undefined : { nodeId })
    }))
  }
  return Result.succeed(snapshot.success as Command.EncodedValues)
}

const hasOwn = (
  values: Command.EncodedValues,
  key: string
): boolean => Object.prototype.hasOwnProperty.call(values, key)

interface ValidatedActivities {
  readonly byNode: ReadonlyMap<string, RunState.ActivityState>
}

const sourceValue = (
  edge: Compiler.CompiledDataEdge,
  runInput: Command.EncodedValues,
  activities: ReadonlyMap<string, RunState.ActivityState>,
  targetNodeId?: string
): Result.Result<Schema.Json, DecisionError> => {
  if (edge.source.kind === "WorkflowInput") {
    if (!hasOwn(runInput, edge.source.port)) {
      return fail(makeError(
        Codes.InvalidRouting,
        `Workflow input '${edge.source.port}' is unavailable`,
        {
          ...(targetNodeId === undefined ? undefined : { nodeId: targetNodeId }),
          details: { edgeId: edge.edge.id }
        }
      ))
    }
    return Result.succeed(runInput[edge.source.port]!)
  }
  const activity = activities.get(edge.source.nodeId)
  if (activity?.status !== "Succeeded" || activity.output === undefined) {
    return fail(makeError(
      Codes.InvalidRouting,
      `Node output source '${edge.source.nodeId}' is unavailable`,
      {
        ...(targetNodeId === undefined ? undefined : { nodeId: targetNodeId }),
        logicalActivityId: activity?.logicalActivityId,
        details: { edgeId: edge.edge.id }
      }
    ))
  }
  if (!hasOwn(activity.output, edge.source.port)) {
    return fail(makeError(
      Codes.InvalidRouting,
      `Node output '${edge.source.port}' is unavailable`,
      {
        ...(targetNodeId === undefined ? undefined : { nodeId: targetNodeId }),
        logicalActivityId: activity.logicalActivityId,
        details: { edgeId: edge.edge.id, sourceNodeId: edge.source.nodeId }
      }
    ))
  }
  return Result.succeed(activity.output[edge.source.port]!)
}

const assembleValues = (
  ports: Readonly<
    Record<string, { readonly cardinality: "one" | "many"; readonly required: boolean }>
  >,
  edges: ReadonlyArray<Compiler.CompiledDataEdge>,
  runInput: Command.EncodedValues,
  activities: ReadonlyMap<string, RunState.ActivityState>,
  target: "NodeInput" | "WorkflowOutput",
  nodeId?: string
): Result.Result<Command.EncodedValues, DecisionError> => {
  const output: Array<readonly [string, Schema.Json]> = []
  for (const [portName, port] of Object.entries(ports)) {
    const connected = edges.filter((edge) =>
      edge.target.kind === target &&
      edge.target.port === portName &&
      (
        target === "WorkflowOutput" ||
        edge.target.kind === "NodeInput" && edge.target.nodeId === nodeId
      )
    )
    if (
      connected.length === 0 &&
      !port.required &&
      port.cardinality === "one"
    ) {
      continue
    }
    const ordered = port.cardinality === "many" && connected.length > 1
      ? [...connected].sort((left, right) => left.edge.order! - right.edge.order!)
      : connected
    const values: Array<Schema.Json> = []
    for (const edge of ordered) {
      const value = sourceValue(edge, runInput, activities, nodeId)
      if (Result.isFailure(value)) {
        return Result.fail(value.failure)
      }
      values.push(value.success)
    }
    if (port.cardinality === "many") {
      output.push([portName, Object.freeze(values)])
    } else if (values.length > 0) {
      output.push([portName, values[0]!])
    } else {
      return fail(makeError(
        Codes.InvalidRouting,
        `Required encoded value '${portName}' is unavailable`,
        {
          ...(nodeId === undefined ? undefined : { nodeId }),
          details: { target, port: portName }
        }
      ))
    }
  }
  return encodedValues(
    Object.fromEntries(output),
    Codes.InvalidRouting,
    "Assembled values are not a strict encoded named-value record",
    nodeId
  )
}

const validateRunInput = (
  plan: DecidablePlan,
  state: RunState.RunState
): Result.Result<Command.EncodedValues, DecisionError> => {
  const input = encodedValues(
    state.input,
    Codes.InvalidRunInput,
    "Run input must be an encoded named-value record"
  )
  if (Result.isFailure(input)) {
    return input
  }
  const expectedKeys = Object.keys(plan.compiled.definition.inputs).sort()
  const actualKeys = Object.keys(input.success).sort()
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return fail(makeError(
      Codes.InvalidRunInput,
      "Run input keys must exactly match workflow inputs",
      { details: { expectedKeys, actualKeys } }
    ))
  }
  return input
}

const validateActivities = (
  plan: DecidablePlan,
  state: RunState.RunState,
  runInput: Command.EncodedValues
): Result.Result<ValidatedActivities, DecisionError> => {
  const entries = Array.from(HashMap.entries(state.activities)).sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0
  )
  const byNode = new Map<string, RunState.ActivityState>()
  for (const [storedId, activity] of entries) {
    const node = plan.compiled.nodes.get(activity.nodeId)
    if (node === undefined) {
      return fail(makeError(
        Codes.UnknownActivityNode,
        `Activity '${activity.logicalActivityId}' refers to an unknown node`,
        {
          nodeId: activity.nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    if (byNode.has(activity.nodeId)) {
      return fail(makeError(
        Codes.DuplicateNodeActivity,
        `Node '${activity.nodeId}' has more than one logical activity`,
        { nodeId: activity.nodeId }
      ))
    }
    const nodeInstanceId = Command.staticNodeInstanceId(activity.nodeId)
    const logicalActivityId = Identity.logicalActivityId(
      state.tenantId,
      state.runId,
      nodeInstanceId
    )
    const idempotencyKey = Identity.activityIdempotencyKey(
      state.tenantId,
      state.runId,
      nodeInstanceId
    )
    const currentAttemptId = Identity.activityAttemptId(
      state.tenantId,
      state.runId,
      nodeInstanceId,
      activity.currentAttempt
    )
    if (
      storedId !== activity.logicalActivityId ||
      activity.logicalActivityId !== logicalActivityId ||
      activity.nodeInstanceId !== nodeInstanceId ||
      activity.idempotencyKey !== idempotencyKey ||
      activity.currentAttemptId !== currentAttemptId
    ) {
      return fail(makeError(
        Codes.InvalidActivityIdentity,
        `Activity for node '${activity.nodeId}' has noncanonical identity pins`,
        {
          nodeId: activity.nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    const attempts = Array.from(HashMap.entries(activity.attempts)).sort(
      ([left], [right]) => left - right
    )
    if (
      attempts.length !== activity.currentAttempt ||
      attempts.some(([storedAttempt, attempt], index) =>
        storedAttempt !== index + 1 ||
        attempt.attempt !== storedAttempt ||
        attempt.attemptId !== Identity.activityAttemptId(
            state.tenantId,
            state.runId,
            nodeInstanceId,
            storedAttempt
          )
      )
    ) {
      return fail(makeError(
        Codes.InvalidActivityIdentity,
        `Activity for node '${activity.nodeId}' has noncanonical attempt identities`,
        {
          nodeId: activity.nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    const policy = plan.artifact.activityPolicies[activity.nodeId]
    if (policy === undefined || !jsonEqual(policy, activity.policy)) {
      return fail(makeError(
        Codes.ActivityPolicyMismatch,
        `Activity for node '${activity.nodeId}' does not retain its artifact policy`,
        {
          nodeId: activity.nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    byNode.set(activity.nodeId, activity)
  }

  for (const nodeId of plan.compiled.topologicalOrder) {
    const activity = byNode.get(nodeId)
    if (activity === undefined) {
      continue
    }
    const node = plan.compiled.nodes.get(nodeId)!
    const unavailable = node.dependencies.find(
      (dependency) => byNode.get(dependency)?.status !== "Succeeded"
    )
    if (unavailable !== undefined) {
      return fail(makeError(
        Codes.InvalidActivityIdentity,
        `Node '${nodeId}' exists before dependency '${unavailable}' succeeded`,
        {
          nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    const expectedInput = assembleValues(
      node.definition.inputs,
      node.incoming,
      runInput,
      byNode,
      "NodeInput",
      nodeId
    )
    if (
      Result.isFailure(expectedInput) ||
      !jsonEqual(expectedInput.success, activity.input)
    ) {
      return fail(makeError(
        Codes.InvalidRouting,
        `Activity input for node '${nodeId}' does not match deterministic routing`,
        {
          nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    if (activity.status === "Succeeded") {
      const output = encodedValues(
        activity.output,
        Codes.InvalidRouting,
        `Activity output for node '${nodeId}' must be encoded values`,
        nodeId
      )
      if (Result.isFailure(output)) {
        return fail(output.failure)
      }
      const expectedKeys = Object.keys(node.definition.outputs).sort()
      const actualKeys = Object.keys(output.success).sort()
      if (
        expectedKeys.length !== actualKeys.length ||
        expectedKeys.some((key, index) => key !== actualKeys[index])
      ) {
        return fail(makeError(
          Codes.InvalidRouting,
          `Activity output keys for node '${nodeId}' do not match its definition`,
          {
            nodeId,
            logicalActivityId: activity.logicalActivityId,
            details: { expectedKeys, actualKeys }
          }
        ))
      }
    }
  }
  return Result.succeed({ byNode })
}

const retryable = (
  activity: RunState.ActivityState,
  attempt: RunState.ActivityAttemptState
): boolean => {
  if (attempt.attempt >= activity.policy.retry.maximumAttempts) {
    return false
  }
  if (attempt.status === "Failed") {
    return activity.policy.retry.retryOn.encodedFailure
  }
  return attempt.status === "TimedOut" &&
    (
      attempt.timeoutKind === "ScheduleToStart"
        ? activity.policy.retry.retryOn.scheduleToStartTimeout
        : activity.policy.retry.retryOn.startToCloseTimeout
    )
}

const scheduleAttempt = (
  state: RunState.RunState,
  nodeId: string,
  attempt: number,
  input: Command.EncodedValues,
  policy: ActivityPolicy.Policy,
  initial: boolean
): ReadonlyArray<Command.Command> => {
  const nodeInstanceId = Command.staticNodeInstanceId(nodeId)
  const logicalActivityId = Identity.logicalActivityId(
    state.tenantId,
    state.runId,
    nodeInstanceId
  )
  const attemptId = Identity.activityAttemptId(
    state.tenantId,
    state.runId,
    nodeInstanceId,
    attempt
  )
  const scheduleCommandId = Identity.scheduleActivityCommandId(
    state.tenantId,
    state.runId,
    nodeInstanceId,
    attempt
  )
  const output: Array<Command.Command> = [
    command(state, scheduleCommandId, {
      _tag: "ScheduleActivityAttempt",
      logicalActivityId,
      attemptId,
      nodeId,
      nodeInstanceId,
      attempt,
      idempotencyKey: Identity.activityIdempotencyKey(
        state.tenantId,
        state.runId,
        nodeInstanceId
      ),
      input,
      policy
    })
  ]
  if (policy.timeouts.scheduleToStart._tag === "After") {
    const timerId = Identity.timerId(
      state.tenantId,
      state.runId,
      "ScheduleToStart",
      attemptId
    )
    output.push(command(
      state,
      Identity.scheduleTimerCommandId(state.tenantId, state.runId, timerId),
      {
        _tag: "ScheduleTimer",
        timerId,
        purpose: {
          _tag: "ScheduleToStart",
          logicalActivityId,
          attemptId,
          attempt
        },
        anchorEventId: scheduleCommandId,
        delayMillis: policy.timeouts.scheduleToStart.durationMillis
      }
    ))
  }
  if (initial && policy.timeouts.scheduleToClose._tag === "After") {
    const timerId = Identity.timerId(
      state.tenantId,
      state.runId,
      "ScheduleToClose",
      logicalActivityId
    )
    output.push(command(
      state,
      Identity.scheduleTimerCommandId(state.tenantId, state.runId, timerId),
      {
        _tag: "ScheduleTimer",
        timerId,
        purpose: { _tag: "ScheduleToClose", logicalActivityId },
        anchorEventId: scheduleCommandId,
        delayMillis: policy.timeouts.scheduleToClose.durationMillis
      }
    ))
  }
  return output
}

const pendingTimer = (
  state: RunState.RunState,
  timerId: string
): RunState.TimerState | undefined => {
  const timer = getHash(state.timers, timerId)
  return timer?.status === "Pending" ? timer : undefined
}

const cancelTimer = (
  state: RunState.RunState,
  timerId: string,
  reason: Event.TimerCancellationReason
): Command.Command =>
  command(
    state,
    Identity.cancelTimerCommandId(state.tenantId, state.runId, timerId),
    { _tag: "CancelTimer", timerId, reason }
  )

const activityFailureCause = (
  attempt: RunState.ActivityAttemptState
): Event.ActivityFailureCause =>
  attempt.status === "Failed"
    ? { _tag: "EncodedFailure", failure: attempt.failure! }
    : {
      _tag: "AttemptTimeout",
      timeoutKind: attempt.timeoutKind!
    }

const finalizeActivity = (
  state: RunState.RunState,
  activity: RunState.ActivityState,
  cause: Event.ActivityFailureCause
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> => {
  const attempt = getHash(activity.attempts, activity.currentAttempt)
  if (attempt === undefined) {
    return fail(makeError(
      Codes.InvalidActivityIdentity,
      "Logical activity lacks its current semantic attempt",
      {
        nodeId: activity.nodeId,
        logicalActivityId: activity.logicalActivityId
      }
    ))
  }
  const output: Array<Command.Command> = [
    command(
      state,
      Identity.finalizeActivityFailureCommandId(
        state.tenantId,
        state.runId,
        activity.nodeInstanceId
      ),
      {
        _tag: "FinalizeActivityFailure",
        logicalActivityId: activity.logicalActivityId,
        nodeId: activity.nodeId,
        nodeInstanceId: activity.nodeInstanceId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempt,
        cause
      }
    )
  ]
  const totalTimerId = Identity.timerId(
    state.tenantId,
    state.runId,
    "ScheduleToClose",
    activity.logicalActivityId
  )
  if (pendingTimer(state, totalTimerId) !== undefined) {
    output.push(cancelTimer(state, totalTimerId, "OwnerFailed"))
  }
  return commands(output)
}

const decideAttemptOutcome = (
  state: RunState.RunState,
  activity: RunState.ActivityState
): Result.Result<ReadonlyArray<Command.Command> | undefined, DecisionError> => {
  const attempt = getHash(activity.attempts, activity.currentAttempt)
  if (attempt === undefined) {
    return fail(makeError(
      Codes.InvalidActivityIdentity,
      "Logical activity lacks its current semantic attempt",
      {
        nodeId: activity.nodeId,
        logicalActivityId: activity.logicalActivityId
      }
    ))
  }
  const totalTimerId = Identity.timerId(
    state.tenantId,
    state.runId,
    "ScheduleToClose",
    activity.logicalActivityId
  )
  const totalTimer = getHash(state.timers, totalTimerId)
  if (totalTimer?.status === "Fired") {
    return finalizeActivity(state, activity, {
      _tag: "ScheduleToCloseTimeout",
      timerId: totalTimerId
    })
  }
  if (attempt.status !== "Failed" && attempt.status !== "TimedOut") {
    return Result.succeed(undefined)
  }
  if (!retryable(activity, attempt)) {
    return finalizeActivity(state, activity, activityFailureCause(attempt))
  }
  const nextAttempt = attempt.attempt + 1
  const retryId = Identity.retryId(
    state.tenantId,
    state.runId,
    activity.nodeInstanceId,
    nextAttempt
  )
  const timerId = Identity.timerId(
    state.tenantId,
    state.runId,
    "RetryBackoff",
    retryId
  )
  const retryCommandId = Identity.scheduleRetryCommandId(
    state.tenantId,
    state.runId,
    activity.nodeInstanceId,
    nextAttempt
  )
  const delayMillis = activity.policy.retry.backoff.delayMillis
  return commands([
    command(state, retryCommandId, {
      _tag: "ScheduleRetry",
      retryId,
      logicalActivityId: activity.logicalActivityId,
      failedAttemptId: attempt.attemptId,
      failedAttempt: attempt.attempt,
      nextAttempt,
      anchorEventId: attempt.completedEventId!,
      timerId,
      selectedDelayMillis: delayMillis
    }),
    command(
      state,
      Identity.scheduleTimerCommandId(state.tenantId, state.runId, timerId),
      {
        _tag: "ScheduleTimer",
        timerId,
        purpose: {
          _tag: "RetryBackoff",
          retryId,
          logicalActivityId: activity.logicalActivityId,
          nextAttempt
        },
        anchorEventId: attempt.completedEventId!,
        delayMillis
      }
    )
  ])
}

const matchingSignal = (
  signal: RunState.SignalState,
  wait: RunState.SignalWaitState
): boolean => {
  if (
    signal.status !== "Pending" ||
    signal.signalName !== wait.signalName ||
    signal.signalVersion !== wait.signalVersion
  ) {
    return false
  }
  return wait.correlation._tag === "Any" ||
    (
      signal.correlation._tag === "Exact" &&
      signal.correlation.key === wait.correlation.key
    )
}

const decideSignals = (
  state: RunState.RunState
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> => {
  const startedSequence = (wait: RunState.SignalWaitState): number =>
    getHash(state.eventsById, wait.startedEventId)?.sequence ??
      Number.MAX_SAFE_INTEGER
  const waits = Array.from(HashMap.values(state.signalWaits))
    .filter((wait) => wait.status === "Pending")
    .sort((left, right) =>
      startedSequence(left) - startedSequence(right) ||
      (left.waitId < right.waitId ? -1 : left.waitId > right.waitId ? 1 : 0)
    )
  const signals = Array.from(HashMap.values(state.signals))
    .filter((signal) => signal.status === "Pending")
    .sort((left, right) =>
      left.inboxSequence - right.inboxSequence ||
      (left.signalId < right.signalId ? -1 : left.signalId > right.signalId ? 1 : 0)
    )
  const consumed = new Set<string>()
  const output: Array<Command.Command> = []
  for (const wait of waits) {
    const signal = signals.find(
      (candidate) => !consumed.has(candidate.signalId) && matchingSignal(candidate, wait)
    )
    if (signal === undefined) {
      continue
    }
    consumed.add(signal.signalId)
    output.push(command(
      state,
      Identity.consumeSignalCommandId(
        state.tenantId,
        state.runId,
        wait.waitId,
        signal.signalId
      ),
      {
        _tag: "ConsumeSignal",
        signalId: signal.signalId,
        inboxSequence: signal.inboxSequence,
        waitId: wait.waitId,
        nodeId: wait.nodeId,
        nodeInstanceId: wait.nodeInstanceId
      }
    ))
    if (pendingTimer(state, signal.expiryTimerId) !== undefined) {
      output.push(cancelTimer(state, signal.expiryTimerId, "SignalConsumed"))
    }
    const waitTimerId = Identity.timerId(
      state.tenantId,
      state.runId,
      "SignalWaitTimeout",
      wait.waitId
    )
    if (pendingTimer(state, waitTimerId) !== undefined) {
      output.push(cancelTimer(state, waitTimerId, "SignalConsumed"))
    }
  }
  return commands(output)
}

const terminalCleanup = (
  state: RunState.RunState,
  reason: "RunTerminal" | "RunCancellationRequested"
): Array<Command.Command> =>
  Array.from(HashMap.values(state.timers))
    .filter((timer) => timer.status === "Pending")
    .sort((left, right) => left.timerId < right.timerId ? -1 : left.timerId > right.timerId ? 1 : 0)
    .map((timer) => cancelTimer(state, timer.timerId, reason))

const runFailure = (
  activity: RunState.ActivityState
): Event.RunActivityFailureCause => ({
  _tag: "ActivityFailure",
  logicalActivityId: activity.logicalActivityId,
  nodeId: activity.nodeId,
  nodeInstanceId: activity.nodeInstanceId,
  attemptId: activity.currentAttemptId,
  attempt: activity.currentAttempt,
  cause: activity.finalCause!
})

const validateIdentities = (
  plan: DecidablePlan,
  state: RunState.RunState
): Result.Result<void, DecisionError> => {
  const compiled = plan.compiled
  if (
    state.executionProtocolVersion !== 2 ||
    state.artifactVersion !== 2 ||
    state.planId !== compiled.plan.id ||
    state.planRevision !== compiled.plan.revision ||
    state.definitionId !== compiled.definition.id ||
    state.definitionVersion !== compiled.definition.version
  ) {
    return fail(makeError(
      Codes.RunIdentityMismatch,
      "Run plan or workflow identity does not match prepared compiled meaning"
    ))
  }
  if (state.artifactDigest !== plan.artifactDigest) {
    return fail(makeError(
      Codes.ArtifactIdentityMismatch,
      "Run artifact digest does not match the prepared artifact",
      {
        details: {
          expected: plan.artifactDigest,
          actual: state.artifactDigest
        }
      }
    ))
  }
  if (
    state.compilerVersion !== plan.compilerVersion ||
    state.compilerVersion !== Fingerprint.CompilerSemanticVersion
  ) {
    return fail(makeError(
      Codes.CompilerIdentityMismatch,
      "Run compiler version does not match prepared compiler semantics"
    ))
  }
  if (state.compiledFingerprint !== plan.compiledFingerprint) {
    return fail(makeError(
      Codes.FingerprintMismatch,
      "Run compiled fingerprint does not match the prepared plan"
    ))
  }
  return Result.succeed(undefined)
}

/**
 * Validates and binds an exact compiled plan to one strict version `2` artifact.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>,
  artifactInput: unknown
): Effect.fn.Return<
  DecidablePlan<W>,
  DecisionError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  if (!Compiler.isCompiled(compiled)) {
    return yield* Effect.fail(makeError(
      Codes.PlanProvenanceMismatch,
      "DecisionV2 preparation requires the exact result of Compiler.compile"
    ))
  }
  const validated = yield* Effect.try({
    try: () => PlanStore.validateArtifact(artifactInput),
    catch: () =>
      makeError(
        Codes.InvalidArtifact,
        "Protocol version 2 artifact validation threw unexpectedly"
      )
  })
  if (Result.isFailure(validated)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidArtifact,
      validated.failure.message,
      { details: { artifactCode: validated.failure.code } }
    ))
  }
  const artifact = validated.success
  const fingerprintDocument = Fingerprint.materialize(compiled)
  if (!jsonEqual(artifact.fingerprintDocument, fingerprintDocument)) {
    return yield* Effect.fail(makeError(
      Codes.FingerprintDocumentMismatch,
      "Artifact fingerprint document does not match the exact compiled plan"
    ))
  }
  const compiledFingerprint = yield* Digest.compiledPlan(
    fingerprintDocument as unknown as Schema.Json
  )
  if (artifact.compiledFingerprint !== compiledFingerprint) {
    return yield* Effect.fail(makeError(
      Codes.FingerprintMismatch,
      "Artifact compiled fingerprint does not match its compiled-plan document",
      {
        details: {
          expected: compiledFingerprint,
          actual: artifact.compiledFingerprint
        }
      }
    ))
  }
  const artifactDigest = yield* Digest.artifact(
    artifact as unknown as Schema.Json
  )
  const plan: DecidablePlan<W> = Object.freeze({
    [PreparedPlanTypeId]: true as const,
    compiled,
    artifact,
    artifactDigest,
    compilerVersion: Fingerprint.CompilerSemanticVersion,
    compiledFingerprint
  })
  preparedPlans.add(plan)
  return plan
})

/**
 * Tests whether a value is an exact plan produced by {@link prepare}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (plan: unknown): plan is DecidablePlan<any> =>
  typeof plan === "object" && plan !== null && preparedPlans.has(plan)

/**
 * Purely decides the next strict protocol version `2` static-DAG command batch.
 *
 * @category running
 * @since 4.0.0
 */
const decideUnregistered = <W extends Workflow.Any>(
  plan: DecidablePlan<W>,
  stateInput: unknown
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> => {
  if (!isPrepared(plan)) {
    return fail(makeError(
      Codes.InvalidPreparedPlan,
      "DecisionV2 requires a plan produced by DecisionV2.prepare"
    ))
  }
  if (!RunState.isDerived(stateInput)) {
    return fail(makeError(
      Codes.StateProvenanceMismatch,
      "DecisionV2 requires exact state derived by RunStateV2"
    ))
  }
  const state = stateInput
  const identities = validateIdentities(plan, state)
  if (Result.isFailure(identities)) {
    return Result.fail(identities.failure)
  }
  const durableHead = RunState.validateDurableHead(state)
  if (Result.isFailure(durableHead)) {
    return fail(makeError(
      Codes.InvalidDurableHead,
      durableHead.failure.message,
      { details: { historyCode: durableHead.failure.code } }
    ))
  }
  const runInput = validateRunInput(plan, state)
  if (Result.isFailure(runInput)) {
    return Result.fail(runInput.failure)
  }
  const validated = validateActivities(plan, state, runInput.success)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const activities = validated.success.byNode

  if (state.status === "Succeeded") {
    if (
      !plan.compiled.topologicalOrder.every(
        (nodeId) => activities.get(nodeId)?.status === "Succeeded"
      )
    ) {
      return fail(makeError(
        Codes.InvalidTerminalState,
        "Succeeded run has incomplete static-DAG activities"
      ))
    }
    const expected = assembleValues(
      plan.compiled.definition.outputs,
      plan.compiled.dataEdges,
      runInput.success,
      activities,
      "WorkflowOutput"
    )
    if (Result.isFailure(expected) || !jsonEqual(expected.success, state.output)) {
      return fail(makeError(
        Codes.InvalidTerminalState,
        "Succeeded run output does not match deterministic workflow routing"
      ))
    }
    return commands([])
  }
  if (state.status === "Failed" || state.status === "Cancelled") {
    return commands([])
  }
  if (state.status === "CancellationRequested") {
    return commands([
      ...terminalCleanup(state, "RunCancellationRequested"),
      command(
        state,
        Identity.cancelRunCommandId(state.tenantId, state.runId),
        { _tag: "CancelRun" }
      )
    ])
  }

  const failedActivity = plan.compiled.topologicalOrder
    .map((nodeId) => activities.get(nodeId))
    .find((activity): activity is RunState.ActivityState => activity?.status === "Failed")
  if (failedActivity !== undefined) {
    return commands([
      ...terminalCleanup(state, "RunTerminal"),
      command(
        state,
        Identity.failRunCommandId(state.tenantId, state.runId),
        { _tag: "FailRun", cause: runFailure(failedActivity) }
      )
    ])
  }
  const timedOutWait = Array.from(HashMap.values(state.signalWaits))
    .filter((wait) => wait.status === "TimedOut")
    .sort((left, right) => left.waitId < right.waitId ? -1 : left.waitId > right.waitId ? 1 : 0)[0]
  if (timedOutWait !== undefined) {
    return commands([
      ...terminalCleanup(state, "RunTerminal"),
      command(
        state,
        Identity.failRunCommandId(state.tenantId, state.runId),
        {
          _tag: "FailRun",
          cause: {
            _tag: "SignalWaitTimeout",
            waitId: timedOutWait.waitId,
            nodeId: timedOutWait.nodeId,
            nodeInstanceId: timedOutWait.nodeInstanceId,
            timerId: timedOutWait.timerId!
          }
        }
      )
    ])
  }

  for (const nodeId of plan.compiled.topologicalOrder) {
    const activity = activities.get(nodeId)
    if (activity === undefined || activity.status !== "Active") {
      continue
    }
    const outcome = decideAttemptOutcome(state, activity)
    if (Result.isFailure(outcome)) {
      return Result.fail(outcome.failure)
    }
    if (outcome.success !== undefined) {
      return Result.succeed(outcome.success)
    }
  }

  const signalCommands = decideSignals(state)
  if (Result.isFailure(signalCommands)) {
    return Result.fail(signalCommands.failure)
  }
  if (signalCommands.success.length > 0) {
    return signalCommands
  }

  const scheduling: Array<Command.Command> = []
  for (const nodeId of plan.compiled.topologicalOrder) {
    const activity = activities.get(nodeId)
    const policy = plan.artifact.activityPolicies[nodeId]!
    if (activity === undefined) {
      const node = plan.compiled.nodes.get(nodeId)!
      if (
        !node.dependencies.every(
          (dependency) => activities.get(dependency)?.status === "Succeeded"
        )
      ) {
        continue
      }
      const input = assembleValues(
        node.definition.inputs,
        node.incoming,
        runInput.success,
        activities,
        "NodeInput",
        nodeId
      )
      if (Result.isFailure(input)) {
        return Result.fail(input.failure)
      }
      scheduling.push(...scheduleAttempt(
        state,
        nodeId,
        1,
        input.success,
        policy,
        true
      ))
      continue
    }
    if (activity.status !== "RetryPending") {
      continue
    }
    const retry = activity.pendingRetryId === undefined
      ? undefined
      : getHash(state.retries, activity.pendingRetryId)
    if (retry?.status !== "Ready") {
      continue
    }
    scheduling.push(...scheduleAttempt(
      state,
      nodeId,
      retry.nextAttempt,
      activity.input,
      policy,
      false
    ))
  }
  if (scheduling.length > 0) {
    return commands(scheduling)
  }

  if (
    plan.compiled.topologicalOrder.every(
      (nodeId) => activities.get(nodeId)?.status === "Succeeded"
    ) &&
    Array.from(HashMap.values(state.signalWaits)).every(
      (wait) => wait.status === "Consumed"
    ) &&
    Array.from(HashMap.values(state.sleeps)).every(
      (sleep) => sleep.status === "Completed"
    )
  ) {
    const output = assembleValues(
      plan.compiled.definition.outputs,
      plan.compiled.dataEdges,
      runInput.success,
      activities,
      "WorkflowOutput"
    )
    if (Result.isFailure(output)) {
      return Result.fail(output.failure)
    }
    return commands([
      ...terminalCleanup(state, "RunTerminal"),
      command(
        state,
        Identity.succeedRunCommandId(state.tenantId, state.runId),
        { _tag: "SucceedRun", output: output.success }
      )
    ])
  }

  return commands([])
}

/**
 * Tests whether a command batch is the exact immutable result of a successful
 * decision against the supplied reducer state.
 *
 * **Details**
 *
 * Canonical command identities are consistency checks, not authorization.
 * This process-local provenance guard lets the public command materializer
 * reject caller-constructed batches even when their identifiers are
 * structurally canonical.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDecisionBatch = (
  state: RunState.RunState,
  input: unknown
): input is ReadonlyArray<Command.Command> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !RunState.isDerived(state)
  ) {
    return false
  }
  const metadata = decisionBatches.get(input)
  return metadata !== undefined && metadata.state === state &&
    isPrepared(metadata.plan)
}

/**
 * Purely decides the next strict protocol version `2` static-DAG command batch.
 *
 * **Details**
 *
 * Successful batches are immutable process-local capabilities associated with
 * the exact prepared plan and reducer state. Use the execution authority for
 * durable commits; the capability prevents the public materializer from
 * treating a structurally fabricated command as an authorized decision.
 *
 * @category running
 * @since 4.0.0
 */
export const decide = <W extends Workflow.Any>(
  plan: DecidablePlan<W>,
  stateInput: unknown
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> => {
  const result = decideUnregistered(plan, stateInput)
  if (
    Result.isSuccess(result) &&
    RunState.isDerived(stateInput)
  ) {
    decisionBatches.set(result.success, {
      plan,
      state: stateInput
    })
  }
  return result
}
