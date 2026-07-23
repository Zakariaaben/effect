/**
 * Produces deterministic semantic commands from compiled plans and
 * replayed semantic history.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Command from "./Command.ts"
import * as Compiler from "./Compiler.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as Json from "./internal/json.ts"
import type * as RunState from "./RunState.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = { onExcessProperty: "error" } as const
const PreparedPlanTypeId: unique symbol = Symbol("@effect/workflow-builder/Decision/PreparedPlan")
const preparedPlans = new WeakSet<object>()

/**
 * Stable machine-readable failures emitted by the decision layer.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  PlanIdentityMismatch: "PlanIdentityMismatch",
  CompilerVersionMismatch: "CompilerVersionMismatch",
  FingerprintMismatch: "FingerprintMismatch",
  UnknownActivityNode: "UnknownActivityNode",
  InvalidActivityIdentity: "InvalidActivityIdentity",
  DuplicateNodeActivity: "DuplicateNodeActivity",
  InvalidEncodedValues: "InvalidEncodedValues",
  MissingSourceValue: "MissingSourceValue",
  InvalidTerminalState: "InvalidTerminalState"
} as const

/**
 * A stable machine-readable decision failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type DecisionErrorCode = typeof Codes[keyof typeof Codes]

const DecisionErrorCode = Schema.Literals([
  Codes.PlanIdentityMismatch,
  Codes.CompilerVersionMismatch,
  Codes.FingerprintMismatch,
  Codes.UnknownActivityNode,
  Codes.InvalidActivityIdentity,
  Codes.DuplicateNodeActivity,
  Codes.InvalidEncodedValues,
  Codes.MissingSourceValue,
  Codes.InvalidTerminalState
])

/**
 * A typed failure produced when pinned history cannot be decided safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class DecisionError extends Schema.TaggedErrorClass<DecisionError>(
  "@effect/workflow-builder/Decision/DecisionError"
)("DecisionError", {
  code: DecisionErrorCode,
  message: Schema.NonEmptyString,
  nodeId: Schema.optionalKey(Schema.NonEmptyString),
  activityId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * A compiled plan paired with the exact compiler semantics and fingerprint
 * that a run must pin before semantic decisions can be made.
 *
 * @category models
 * @since 4.0.0
 */
export interface DecidablePlan<out W extends Workflow.Any = Workflow.Any> {
  readonly [PreparedPlanTypeId]: true
  readonly compiled: Compiler.CompiledPlan<W>
  readonly compilerVersion: typeof Fingerprint.CompilerSemanticVersion
  readonly compiledFingerprint: Fingerprint.Fingerprint
}

const makeError = (
  code: DecisionErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly activityId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): DecisionError =>
  new DecisionError({
    code,
    message,
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.activityId === undefined ? undefined : { activityId: options.activityId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const fail = <A = never>(error: DecisionError): Result.Result<A, DecisionError> => Result.fail(error)

const hasOwn = (record: Command.EncodedValues, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key)

const invalidEncodedValues = (
  message: string,
  error?: Json.JsonSnapshotError,
  options: {
    readonly nodeId?: string | undefined
    readonly activityId?: string | undefined
    readonly details?: Schema.JsonObject | undefined
  } = {}
): DecisionError =>
  makeError(Codes.InvalidEncodedValues, message, {
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.activityId === undefined ? undefined : { activityId: options.activityId }),
    ...(
      error === undefined && options.details === undefined
        ? undefined
        : {
          details: {
            ...options.details,
            ...(error === undefined
              ? undefined
              : { snapshotError: error.message, path: [...error.path] })
          }
        }
    )
  })

const snapshotJson = (
  value: unknown,
  message: string,
  options?: {
    readonly nodeId?: string | undefined
    readonly activityId?: string | undefined
  }
): Result.Result<Schema.Json, DecisionError> => {
  const snapped = Json.snapshot(value)
  return Result.isFailure(snapped)
    ? fail(invalidEncodedValues(message, snapped.failure, options))
    : Result.succeed(snapped.success)
}

const snapshotEncodedValues = (
  value: unknown,
  message: string,
  options?: {
    readonly nodeId?: string | undefined
    readonly activityId?: string | undefined
  }
): Result.Result<Command.EncodedValues, DecisionError> => {
  const snapped = snapshotJson(value, message, options)
  if (Result.isFailure(snapped)) {
    return Result.fail(snapped.failure)
  }
  const encoded = snapped.success
  if (
    encoded === null || typeof encoded !== "object" || Array.isArray(encoded) ||
    Object.keys(encoded).some((key) => key.length === 0)
  ) {
    return fail(invalidEncodedValues(message, undefined, options))
  }
  return Result.succeed(encoded as Command.EncodedValues)
}

const validateRunInput = (
  plan: DecidablePlan,
  state: RunState.RunState
): Result.Result<Command.EncodedValues, DecisionError> => {
  const input = snapshotEncodedValues(state.input, "Run input must be an encoded named-value record")
  if (Result.isFailure(input)) {
    return Result.fail(input.failure)
  }
  const expectedKeys = Object.keys(plan.compiled.definition.inputs).sort()
  const actualKeys = Object.keys(input.success).sort()
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return fail(invalidEncodedValues(
      "Run input keys must exactly match the workflow definition inputs",
      undefined,
      { details: { expectedKeys, actualKeys } }
    ))
  }
  return input
}

const freezeCommand = <C extends Command.Command>(command: C): C => {
  const payload = command.payload._tag === "ScheduleActivity"
    ? Object.freeze({ ...command.payload, input: command.payload.input })
    : command.payload._tag === "SucceedRun"
    ? Object.freeze({ ...command.payload, output: command.payload.output })
    : command.payload._tag === "FailRun"
    ? Object.freeze({
      ...command.payload,
      failure: Object.freeze({ ...command.payload.failure })
    })
    : Object.freeze({ ...command.payload })
  return Object.freeze({ ...command, payload }) as C
}

const succeed = (
  commands: ReadonlyArray<Command.Command>
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> =>
  Result.succeed(Object.freeze(commands.map(freezeCommand)))

const jsonEqual = (left: Schema.Json, right: Schema.Json): boolean => {
  return left === right || Json.canonicalizeSnapshot(left) === Json.canonicalizeSnapshot(right)
}

interface ValidatedActivities {
  readonly byNode: ReadonlyMap<string, RunState.ActivityState>
}

const validateActivities = (
  plan: DecidablePlan,
  state: RunState.RunState,
  runInput: Command.EncodedValues
): Result.Result<ValidatedActivities, DecisionError> => {
  const entries = Array.from(state.activities).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const nodeActivityIds = new Map<string, Array<string>>()

  for (const [storedActivityId, activity] of entries) {
    if (!plan.compiled.nodes.has(activity.nodeId)) {
      return fail(makeError(
        Codes.UnknownActivityNode,
        `Activity '${activity.activityId}' refers to unknown node '${activity.nodeId}'`,
        { nodeId: activity.nodeId, activityId: activity.activityId }
      ))
    }
    const ids = nodeActivityIds.get(activity.nodeId) ?? []
    ids.push(storedActivityId)
    nodeActivityIds.set(activity.nodeId, ids)
  }

  for (const nodeId of plan.compiled.topologicalOrder) {
    const activityIds = nodeActivityIds.get(nodeId)
    if (activityIds !== undefined && activityIds.length > 1) {
      return fail(makeError(
        Codes.DuplicateNodeActivity,
        `Node '${nodeId}' has more than one historical activity`,
        { nodeId, details: { activityIds } }
      ))
    }
  }

  const byNode = new Map<string, RunState.ActivityState>()
  for (const [storedActivityId, activity] of entries) {
    const expectedNodeInstanceId = Command.staticNodeInstanceId(activity.nodeId)
    const expectedActivityId = Command.activityId(state.runId, expectedNodeInstanceId, 1)
    const expectedIdempotencyKey = Command.activityIdempotencyKey(state.runId, expectedNodeInstanceId)
    if (
      storedActivityId !== activity.activityId ||
      activity.activityId !== expectedActivityId ||
      activity.nodeInstanceId !== expectedNodeInstanceId ||
      activity.attempt !== 1 ||
      activity.idempotencyKey !== expectedIdempotencyKey
    ) {
      return fail(makeError(
        Codes.InvalidActivityIdentity,
        `Activity '${activity.activityId}' does not match the canonical identity for node '${activity.nodeId}'`,
        {
          nodeId: activity.nodeId,
          activityId: activity.activityId,
          details: {
            expected: {
              activityId: expectedActivityId,
              nodeInstanceId: expectedNodeInstanceId,
              attempt: 1,
              idempotencyKey: expectedIdempotencyKey
            },
            actual: {
              storedActivityId,
              activityId: activity.activityId,
              nodeInstanceId: activity.nodeInstanceId,
              attempt: activity.attempt,
              idempotencyKey: activity.idempotencyKey
            }
          }
        }
      ))
    }
    const input = snapshotEncodedValues(
      activity.input,
      `Activity '${activity.activityId}' input must be an encoded named-value record`,
      { nodeId: activity.nodeId, activityId: activity.activityId }
    )
    if (Result.isFailure(input)) {
      return Result.fail(input.failure)
    }
    if (activity.status === "Succeeded") {
      const output = snapshotEncodedValues(
        activity.output,
        `Activity '${activity.activityId}' output must be an encoded named-value record`,
        { nodeId: activity.nodeId, activityId: activity.activityId }
      )
      if (Result.isFailure(output)) {
        return Result.fail(output.failure)
      }
      byNode.set(activity.nodeId, Object.freeze({ ...activity, input: input.success, output: output.success }))
      continue
    }
    if (activity.status === "Failed") {
      const failure = snapshotJson(
        activity.failure,
        `Activity '${activity.activityId}' failure must be encoded JSON`,
        { nodeId: activity.nodeId, activityId: activity.activityId }
      )
      if (Result.isFailure(failure)) {
        return Result.fail(failure.failure)
      }
      byNode.set(activity.nodeId, Object.freeze({ ...activity, input: input.success, failure: failure.success }))
      continue
    }
    byNode.set(activity.nodeId, Object.freeze({ ...activity, input: input.success }))
  }

  for (const nodeId of plan.compiled.topologicalOrder) {
    const activity = byNode.get(nodeId)
    if (activity === undefined) {
      continue
    }
    const node = plan.compiled.nodes.get(nodeId)!
    const unavailableDependency = node.dependencies.find((dependency) => byNode.get(dependency)?.status !== "Succeeded")
    if (unavailableDependency !== undefined) {
      return fail(makeError(
        Codes.InvalidActivityIdentity,
        `Activity '${activity.activityId}' exists before dependency '${unavailableDependency}' succeeded`,
        {
          nodeId,
          activityId: activity.activityId,
          details: { dependency: unavailableDependency }
        }
      ))
    }
    const expectedInput = assembleValues(node.definition.inputs, node.incoming, runInput, byNode, "NodeInput", nodeId)
    if (Result.isFailure(expectedInput)) {
      return Result.fail(expectedInput.failure)
    }
    if (!jsonEqual(expectedInput.success, activity.input)) {
      return fail(makeError(
        Codes.InvalidActivityIdentity,
        `Activity '${activity.activityId}' input does not match deterministic routing for node '${nodeId}'`,
        { nodeId, activityId: activity.activityId }
      ))
    }
    if (activity.status === "Succeeded") {
      const expectedKeys = Object.keys(node.definition.outputs).sort()
      const actualKeys = Object.keys(activity.output).sort()
      if (
        expectedKeys.length !== actualKeys.length ||
        expectedKeys.some((key, index) => key !== actualKeys[index])
      ) {
        return fail(makeError(
          Codes.InvalidEncodedValues,
          `Activity '${activity.activityId}' output keys do not match node '${nodeId}'`,
          {
            nodeId,
            activityId: activity.activityId,
            details: { expectedKeys, actualKeys }
          }
        ))
      }
    }
  }
  return Result.succeed({ byNode })
}

const sourceValue = (
  edge: Compiler.CompiledDataEdge,
  runInput: Command.EncodedValues,
  activities: ReadonlyMap<string, RunState.ActivityState>,
  targetNodeId?: string
): Result.Result<Schema.Json, DecisionError> => {
  let values: Command.EncodedValues
  let sourceName: string
  let sourceActivityId: string | undefined
  if (edge.source.kind === "WorkflowInput") {
    values = runInput
    sourceName = edge.source.port
  } else {
    const activity = activities.get(edge.source.nodeId)
    sourceName = edge.source.port
    sourceActivityId = activity?.activityId
    if (activity === undefined || activity.status !== "Succeeded") {
      return fail(makeError(
        Codes.MissingSourceValue,
        `Output source node '${edge.source.nodeId}' has not succeeded`,
        {
          nodeId: targetNodeId ?? edge.source.nodeId,
          ...(sourceActivityId === undefined ? undefined : { activityId: sourceActivityId }),
          details: { edgeId: edge.edge.id, sourceNodeId: edge.source.nodeId, source: sourceName }
        }
      ))
    }
    values = activity.output
  }
  if (!hasOwn(values, sourceName)) {
    return fail(makeError(
      Codes.MissingSourceValue,
      `Encoded source value '${sourceName}' is missing`,
      {
        ...(targetNodeId === undefined ? undefined : { nodeId: targetNodeId }),
        ...(sourceActivityId === undefined ? undefined : { activityId: sourceActivityId }),
        details: { edgeId: edge.edge.id, source: sourceName }
      }
    ))
  }
  return Result.succeed(values[sourceName]!)
}

const assembleValues = (
  ports: Readonly<Record<string, { readonly cardinality: "one" | "many"; readonly required: boolean }>>,
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
      (target === "WorkflowOutput" || edge.target.kind === "NodeInput" && edge.target.nodeId === nodeId)
    )
    if (connected.length === 0 && !port.required && port.cardinality === "one") {
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
        Codes.MissingSourceValue,
        `Required encoded value '${portName}' is unavailable`,
        {
          ...(nodeId === undefined ? undefined : { nodeId }),
          details: { target, port: portName }
        }
      ))
    }
  }
  return Result.succeed(Object.freeze(Object.fromEntries(output)))
}

const schedule = (
  state: RunState.RunState,
  nodeId: string,
  input: Command.EncodedValues
): Command.Command => {
  const nodeInstanceId = Command.staticNodeInstanceId(nodeId)
  const attempt = 1
  return {
    commandVersion: 1,
    commandId: Command.scheduleActivityCommandId(state.runId, nodeInstanceId, attempt),
    payload: {
      _tag: "ScheduleActivity",
      activityId: Command.activityId(state.runId, nodeInstanceId, attempt),
      nodeId,
      nodeInstanceId,
      attempt,
      idempotencyKey: Command.activityIdempotencyKey(state.runId, nodeInstanceId),
      input
    }
  }
}

/**
 * Computes and retains the immutable identity pins required by pure decisions.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>
): Effect.fn.Return<DecidablePlan<W>, PlatformError.PlatformError | DecisionError, Crypto.Crypto> {
  if (!Compiler.isCompiled(compiled)) {
    return yield* Effect.fail(makeError(
      Codes.PlanIdentityMismatch,
      "Decision preparation requires the exact result of Compiler.compile"
    ))
  }
  const compiledFingerprint = yield* Fingerprint.make(compiled)
  const plan: DecidablePlan<W> = Object.freeze({
    [PreparedPlanTypeId]: true as const,
    compiled,
    compilerVersion: Fingerprint.CompilerSemanticVersion,
    compiledFingerprint
  })
  preparedPlans.add(plan)
  return plan
})

/**
 * Tests whether a value is an exact plan instance produced by {@link prepare}.
 *
 * **Details**
 *
 * Prepared-plan provenance is retained out of band. Structural copies and
 * forged marker properties therefore cannot substitute compiled meaning under
 * retained identity pins.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (plan: unknown): plan is DecidablePlan<any> =>
  typeof plan === "object" && plan !== null && preparedPlans.has(plan)

/**
 * Purely decides all commands currently implied by a pinned plan and replayed
 * run state.
 *
 * **Details**
 *
 * The function only models the version 1 activity and terminal command set. It
 * does not imply retry, timer, or signal semantics. Already-scheduled
 * activities are left to the durable outbox and are never rescheduled here.
 * Once a cancellation request is committed for a nonterminal run, cancellation
 * wins over any concurrently visible activity failure or completion. RunState
 * rejects a cancellation event committed after terminal history.
 *
 * @category running
 * @since 4.0.0
 */
export const decide = <W extends Workflow.Any>(
  plan: DecidablePlan<W>,
  state: RunState.RunState
): Result.Result<ReadonlyArray<Command.Command>, DecisionError> => {
  if (!isPrepared(plan)) {
    return fail(makeError(
      Codes.PlanIdentityMismatch,
      "Decisions require a plan produced by Decision.prepare"
    ))
  }
  const compiled = plan.compiled
  if (plan.compilerVersion !== Fingerprint.CompilerSemanticVersion) {
    return fail(makeError(
      Codes.CompilerVersionMismatch,
      `Prepared compiler version '${plan.compilerVersion}' is not supported by this decision implementation`,
      { details: { expected: Fingerprint.CompilerSemanticVersion, actual: plan.compilerVersion } }
    ))
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(plan.compiledFingerprint)) {
    return fail(makeError(
      Codes.FingerprintMismatch,
      "Prepared plan fingerprint is not a canonical SHA-256 fingerprint"
    ))
  }
  if (
    state.planId !== compiled.plan.id ||
    state.planRevision !== compiled.plan.revision ||
    state.definitionId !== compiled.definition.id ||
    state.definitionVersion !== compiled.definition.version
  ) {
    return fail(makeError(
      Codes.PlanIdentityMismatch,
      "Run plan or workflow-definition identity does not match the prepared plan",
      {
        details: {
          expected: {
            planId: compiled.plan.id,
            planRevision: compiled.plan.revision,
            definitionId: compiled.definition.id,
            definitionVersion: compiled.definition.version
          },
          actual: {
            planId: state.planId,
            planRevision: state.planRevision,
            definitionId: state.definitionId,
            definitionVersion: state.definitionVersion
          }
        }
      }
    ))
  }
  if (state.compilerVersion !== plan.compilerVersion) {
    return fail(makeError(
      Codes.CompilerVersionMismatch,
      `Run compiler version '${state.compilerVersion}' does not match '${plan.compilerVersion}'`,
      { details: { expected: plan.compilerVersion, actual: state.compilerVersion } }
    ))
  }
  if (state.compiledFingerprint !== plan.compiledFingerprint) {
    return fail(makeError(
      Codes.FingerprintMismatch,
      "Run fingerprint does not match the prepared plan",
      { details: { expected: plan.compiledFingerprint, actual: state.compiledFingerprint } }
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

  if (state.status === "Failed" || state.status === "Cancelled") {
    return succeed([])
  }
  if (state.status === "Succeeded") {
    for (const nodeId of compiled.topologicalOrder) {
      if (activities.get(nodeId)?.status !== "Succeeded") {
        return fail(makeError(
          Codes.InvalidTerminalState,
          `Succeeded run has incomplete node '${nodeId}'`,
          { nodeId }
        ))
      }
    }
    const expected = assembleValues(
      compiled.definition.outputs,
      compiled.dataEdges,
      runInput.success,
      activities,
      "WorkflowOutput"
    )
    if (Result.isFailure(expected)) {
      return fail(makeError(
        Codes.InvalidTerminalState,
        "Succeeded run cannot assemble its workflow output",
        {
          details: {
            causeCode: expected.failure.code,
            causeMessage: expected.failure.message
          }
        }
      ))
    }
    const output = snapshotEncodedValues(
      state.output,
      "Succeeded run output must be an encoded named-value record"
    )
    if (Result.isFailure(output) || !jsonEqual(expected.success, output.success)) {
      return fail(makeError(
        Codes.InvalidTerminalState,
        "Succeeded run output does not match the deterministically assembled workflow output"
      ))
    }
    return succeed([])
  }
  if (state.status === "CancellationRequested") {
    return succeed([{
      commandVersion: 1,
      commandId: Command.cancelRunCommandId(state.runId),
      payload: { _tag: "CancelRun" }
    }])
  }

  for (const nodeId of compiled.topologicalOrder) {
    const activity = activities.get(nodeId)
    if (activity?.status === "Failed") {
      const nodeInstanceId = Command.staticNodeInstanceId(nodeId)
      return succeed([{
        commandVersion: 1,
        commandId: Command.failRunCommandId(state.runId),
        payload: {
          _tag: "FailRun",
          failure: {
            _tag: "ActivityFailure",
            activityId: activity.activityId,
            nodeId,
            nodeInstanceId,
            attempt: activity.attempt,
            failure: activity.failure
          }
        }
      }])
    }
  }

  const commands: Array<Command.Command> = []
  for (const nodeId of compiled.topologicalOrder) {
    if (activities.has(nodeId)) {
      continue
    }
    const node = compiled.nodes.get(nodeId)!
    if (!node.dependencies.every((dependency) => activities.get(dependency)?.status === "Succeeded")) {
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
    commands.push(schedule(state, nodeId, input.success))
  }
  if (commands.length > 0) {
    return succeed(commands)
  }

  if (compiled.topologicalOrder.every((nodeId) => activities.get(nodeId)?.status === "Succeeded")) {
    const output = assembleValues(
      compiled.definition.outputs,
      compiled.dataEdges,
      runInput.success,
      activities,
      "WorkflowOutput"
    )
    if (Result.isFailure(output)) {
      return Result.fail(output.failure)
    }
    return succeed([{
      commandVersion: 1,
      commandId: Command.succeedRunCommandId(state.runId),
      payload: { _tag: "SucceedRun", output: output.success }
    }])
  }

  return succeed([])
}
