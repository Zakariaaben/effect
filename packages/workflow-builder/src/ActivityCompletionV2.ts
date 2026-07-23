/**
 * Plan-bound activity-completion admission for execution protocol version `2`.
 *
 * **Details**
 *
 * Worker output is untrusted encoded data. This module binds one completion to
 * an exact prepared plan and reducer-derived durable head, then decodes success
 * values and application failures through the node definition retained by that
 * plan. The resulting capability is process-local and cannot be recreated by
 * structural copying.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Compiler from "./Compiler.ts"
import * as DecisionV2 from "./DecisionV2.ts"
import * as ExternalEventV2 from "./ExternalEventV2.ts"
import * as Json from "./internal/json.ts"
import type * as Node from "./Node.ts"
import type * as Port from "./Port.ts"
import type * as Registry from "./Registry.ts"
import * as RunStateV2 from "./RunStateV2.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const snapshotLimits = {
  maxArrayLength: 10_000,
  maxContainers: 10_000,
  maxDepth: 128,
  maxEntries: 100_000
} as const

const PreparedCompletionTypeId: unique symbol = Symbol(
  "@effect/workflow-builder/ActivityCompletionV2/PreparedCompletion"
)
const preparedCompletions = new WeakSet<object>()

interface PreparedMetadata {
  readonly plan: DecisionV2.DecidablePlan
  readonly state: RunStateV2.RunState
  readonly expectedSequence: number
  readonly wire: ExternalEventV2.CompleteActivityAttemptRequest
}

const preparedMetadata = new WeakMap<object, PreparedMetadata>()

type DefinitionsOf<W extends Workflow.Any> = Registry.Definitions<
  Workflow.Nodes<W>
>
type NodeOf<W extends Workflow.Any> = DefinitionsOf<W>[keyof DefinitionsOf<W>]

type OutputDecodingServices<N> = N extends Node.Any ?
  Node.Outputs<N> extends Port.Outputs ? Port.OutputDecodingServices<Node.Outputs<N>>
  : never
  : never

type FailureDecodingServices<N> = N extends Node.Definition<
  infer _Type,
  infer _Version,
  infer _Config,
  infer _Inputs,
  infer _Outputs,
  infer Failure,
  infer _Requirements
> ? Failure["DecodingServices"]
  : never

/**
 * Stable machine-readable protocol version `2` completion-admission failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidPreparedPlan: "InvalidPreparedPlan",
  InvalidRunState: "InvalidRunState",
  InvalidDurableHead: "InvalidDurableHead",
  PlanStateMismatch: "PlanStateMismatch",
  InvalidRequest: "InvalidRequest",
  RunKeyMismatch: "RunKeyMismatch",
  RunNotRunning: "RunNotRunning",
  ActivityNotFound: "ActivityNotFound",
  AttemptMismatch: "AttemptMismatch",
  IllegalActivityTransition: "IllegalActivityTransition",
  UnknownActivityNode: "UnknownActivityNode",
  InvalidOutput: "InvalidOutput",
  InvalidFailure: "InvalidFailure",
  InvalidPreparedCompletion: "InvalidPreparedCompletion",
  PreparedPlanMismatch: "PreparedPlanMismatch",
  PreparedStateMismatch: "PreparedStateMismatch",
  StalePreparedCompletion: "StalePreparedCompletion"
} as const

/**
 * A stable completion-admission failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityCompletionErrorCode = typeof Codes[keyof typeof Codes]

const ActivityCompletionErrorCode = Schema.Literals([
  Codes.InvalidPreparedPlan,
  Codes.InvalidRunState,
  Codes.InvalidDurableHead,
  Codes.PlanStateMismatch,
  Codes.InvalidRequest,
  Codes.RunKeyMismatch,
  Codes.RunNotRunning,
  Codes.ActivityNotFound,
  Codes.AttemptMismatch,
  Codes.IllegalActivityTransition,
  Codes.UnknownActivityNode,
  Codes.InvalidOutput,
  Codes.InvalidFailure,
  Codes.InvalidPreparedCompletion,
  Codes.PreparedPlanMismatch,
  Codes.PreparedStateMismatch,
  Codes.StalePreparedCompletion
])

/**
 * Raised when an encoded worker completion cannot be admitted safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityCompletionError extends Schema.TaggedErrorClass<ActivityCompletionError>(
  "@effect/workflow-builder/ActivityCompletionV2/ActivityCompletionError"
)("ActivityCompletionError", {
  code: ActivityCompletionErrorCode,
  message: Schema.NonEmptyString,
  nodeId: Schema.optionalKey(Schema.NonEmptyString),
  logicalActivityId: Schema.optionalKey(Schema.NonEmptyString),
  attemptId: Schema.optionalKey(Schema.NonEmptyString),
  attempt: Schema.optionalKey(Schema.Int),
  output: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * One immutable completion admitted against an exact plan and durable head.
 *
 * **Details**
 *
 * The public wire request and expected sequence are detached and immutable.
 * Exact plan and state identity are retained only in module-private metadata.
 * Use {@link resolve} inside the authoritative commit transaction.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedCompletion {
  readonly [PreparedCompletionTypeId]: true
  readonly wire: ExternalEventV2.CompleteActivityAttemptRequest
  readonly expectedSequence: number
}

/**
 * Effect services required to decode all activity outputs and failures that
 * may occur in a workflow.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | OutputDecodingServices<NodeOf<W>>
  | FailureDecodingServices<NodeOf<W>>

const makeError = (
  code: ActivityCompletionErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly logicalActivityId?: string | undefined
    readonly attemptId?: string | undefined
    readonly attempt?: number | undefined
    readonly output?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): ActivityCompletionError =>
  new ActivityCompletionError({
    code,
    message,
    ...(options.nodeId === undefined ? undefined : { nodeId: options.nodeId }),
    ...(options.logicalActivityId === undefined
      ? undefined
      : { logicalActivityId: options.logicalActivityId }),
    ...(options.attemptId === undefined
      ? undefined
      : { attemptId: options.attemptId }),
    ...(options.attempt === undefined ? undefined : { attempt: options.attempt }),
    ...(options.output === undefined ? undefined : { output: options.output }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const decodeRequest = Schema.decodeUnknownResult(
  ExternalEventV2.CompleteActivityAttemptRequest,
  strictParseOptions
)

const captureRequest = (
  input: unknown
): Result.Result<
  ExternalEventV2.CompleteActivityAttemptRequest,
  ActivityCompletionError
> => {
  const snapshot = Json.snapshot(input, snapshotLimits)
  if (Result.isFailure(snapshot)) {
    return Result.fail(makeError(
      Codes.InvalidRequest,
      `Activity completion must be bounded strict JSON: ${snapshot.failure.message}`,
      {
        details: {
          snapshotError: snapshot.failure.message,
          path: [...snapshot.failure.path]
        }
      }
    ))
  }
  let decoded: ReturnType<typeof decodeRequest>
  try {
    decoded = decodeRequest(snapshot.success)
  } catch {
    return Result.fail(makeError(
      Codes.InvalidRequest,
      "Activity-completion request validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(makeError(
      Codes.InvalidRequest,
      "Invalid protocol version 2 activity-completion request",
      { details: { parseError: decoded.failure.message } }
    ))
    : Result.succeed(
      snapshot.success as unknown as ExternalEventV2.CompleteActivityAttemptRequest
    )
}

const boundState = (
  plan: DecisionV2.DecidablePlan,
  stateInput: unknown
): Result.Result<RunStateV2.RunState, ActivityCompletionError> => {
  if (!DecisionV2.isPrepared(plan)) {
    return Result.fail(makeError(
      Codes.InvalidPreparedPlan,
      "ActivityCompletionV2 requires a plan produced by DecisionV2.prepare"
    ))
  }
  if (!RunStateV2.isDerived(stateInput)) {
    return Result.fail(makeError(
      Codes.InvalidRunState,
      "ActivityCompletionV2 requires exact reducer-derived state"
    ))
  }
  const durable = RunStateV2.validateDurableHead(stateInput)
  if (Result.isFailure(durable)) {
    return Result.fail(makeError(
      Codes.InvalidDurableHead,
      durable.failure.message,
      { details: { historyCode: durable.failure.code } }
    ))
  }
  const decision = DecisionV2.decide(plan, durable.success)
  if (Result.isFailure(decision)) {
    return Result.fail(makeError(
      Codes.PlanStateMismatch,
      decision.failure.message,
      {
        ...(decision.failure.nodeId === undefined
          ? undefined
          : { nodeId: decision.failure.nodeId }),
        ...(decision.failure.logicalActivityId === undefined
          ? undefined
          : { logicalActivityId: decision.failure.logicalActivityId }),
        details: {
          decisionCode: decision.failure.code,
          ...(decision.failure.details === undefined
            ? undefined
            : { decisionDetails: decision.failure.details })
        }
      }
    ))
  }
  return Result.succeed(durable.success)
}

const runCodec = Effect.fnUntraced(function*<A, R>(
  construct: () => Effect.Effect<A, { readonly message: string }, R>,
  error: ActivityCompletionError
): Effect.fn.Return<A, ActivityCompletionError, R> {
  const operation = yield* Effect.try({
    try: construct,
    catch: () =>
      new ActivityCompletionError({
        ...error,
        message: `${error.message}: codec could not be prepared safely`
      })
  })
  return yield* operation.pipe(
    Effect.mapError((cause) =>
      new ActivityCompletionError({
        ...error,
        message: `${error.message}: ${cause.message}`
      })
    ),
    Effect.catchCauseIf(
      Cause.hasDies,
      () =>
        Effect.fail(
          new ActivityCompletionError({
            ...error,
            message: `${error.message}: codec failed unexpectedly`
          })
        )
    )
  )
})

const sameKeys = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  left.length === right.length &&
  left.every((key, index) => key === right[index])

const validateOutput = Effect.fnUntraced(function*<W extends Workflow.Any>(
  node: Compiler.CompiledNode,
  output: Extract<ExternalEventV2.ActivityCompletion, {
    readonly _tag: "Succeeded"
  }>["output"],
  activity: {
    readonly logicalActivityId: string
    readonly attemptId?: string | undefined
    readonly attempt?: number | undefined
  }
): Effect.fn.Return<void, ActivityCompletionError, Requirements<W>> {
  const expectedKeys = Object.keys(node.definition.outputs).sort()
  const actualKeys = Object.keys(output).sort()
  if (!sameKeys(expectedKeys, actualKeys)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidOutput,
      `Activity output keys for node '${node.node.id}' must exactly match its definition`,
      {
        nodeId: node.node.id,
        logicalActivityId: activity.logicalActivityId,
        ...(activity.attemptId === undefined
          ? undefined
          : { attemptId: activity.attemptId }),
        ...(activity.attempt === undefined
          ? undefined
          : { attempt: activity.attempt }),
        details: { expectedKeys, actualKeys }
      }
    ))
  }

  for (
    const [name, port] of Object.entries(node.definition.outputs).sort(
      ([left], [right]) => left < right ? -1 : left > right ? 1 : 0
    )
  ) {
    const error = makeError(
      Codes.InvalidOutput,
      `Invalid encoded activity output '${node.node.id}.${name}'`,
      {
        nodeId: node.node.id,
        logicalActivityId: activity.logicalActivityId,
        ...(activity.attemptId === undefined
          ? undefined
          : { attemptId: activity.attemptId }),
        ...(activity.attempt === undefined
          ? undefined
          : { attempt: activity.attempt }),
        output: name
      }
    )
    yield* runCodec(
      () =>
        Schema.decodeUnknownEffect(
          port.schema,
          strictParseOptions
        )(output[name]) as Effect.Effect<
          unknown,
          { readonly message: string },
          Requirements<W>
        >,
      error
    )
  }
})

const validateFailure = Effect.fnUntraced(function*<W extends Workflow.Any>(
  node: Compiler.CompiledNode,
  failure: Schema.Json,
  activity: {
    readonly logicalActivityId: string
    readonly attemptId?: string | undefined
    readonly attempt?: number | undefined
  }
): Effect.fn.Return<void, ActivityCompletionError, Requirements<W>> {
  const error = makeError(
    Codes.InvalidFailure,
    `Invalid encoded activity failure for node '${node.node.id}'`,
    {
      nodeId: node.node.id,
      logicalActivityId: activity.logicalActivityId,
      ...(activity.attemptId === undefined
        ? undefined
        : { attemptId: activity.attemptId }),
      ...(activity.attempt === undefined
        ? undefined
        : { attempt: activity.attempt })
    }
  )
  yield* runCodec(
    () =>
      Schema.decodeUnknownEffect(
        node.definition.failureSchema,
        strictParseOptions
      )(failure) as Effect.Effect<
        unknown,
        { readonly message: string },
        Requirements<W>
      >,
    error
  )
})

/**
 * Validates schema-bearing activity facts in one imported durable head.
 *
 * **Details**
 *
 * The state must first satisfy reducer provenance, durable pairing, and exact
 * prepared-plan identity. Every successful logical activity is then decoded
 * through all declared output schemas, and every historical encoded attempt
 * failure is decoded through that node's failure schema. This closes the same
 * schema boundary for replayed or imported history as for a live completion.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateState = Effect.fnUntraced(function*<
  W extends Workflow.Any
>(
  plan: DecisionV2.DecidablePlan<W>,
  stateInput: unknown
): Effect.fn.Return<
  RunStateV2.RunState,
  ActivityCompletionError,
  Requirements<W>
> {
  const bound = boundState(plan, stateInput)
  if (Result.isFailure(bound)) {
    return yield* Effect.fail(bound.failure)
  }
  const state = bound.success
  const activities = Array.from(HashMap.values(state.activities)).sort(
    (left, right) =>
      left.logicalActivityId < right.logicalActivityId ?
        -1
        : left.logicalActivityId > right.logicalActivityId ?
        1
        : 0
  )
  for (const activity of activities) {
    const node = plan.compiled.nodes.get(activity.nodeId)
    if (node === undefined) {
      return yield* Effect.fail(makeError(
        Codes.UnknownActivityNode,
        `Activity '${activity.logicalActivityId}' refers to an unknown compiled node`,
        {
          nodeId: activity.nodeId,
          logicalActivityId: activity.logicalActivityId
        }
      ))
    }
    if (activity.status === "Succeeded" && activity.output !== undefined) {
      yield* validateOutput<W>(node, activity.output, {
        logicalActivityId: activity.logicalActivityId,
        attemptId: activity.currentAttemptId,
        attempt: activity.currentAttempt
      })
    }
    const attempts = Array.from(HashMap.values(activity.attempts)).sort(
      (left, right) => left.attempt - right.attempt
    )
    for (const attempt of attempts) {
      if (attempt.status !== "Failed" || attempt.failure === undefined) {
        continue
      }
      yield* validateFailure<W>(node, attempt.failure, {
        logicalActivityId: activity.logicalActivityId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempt
      })
    }
  }
  return state
})

/**
 * Tests whether a value is an exact capability returned by {@link prepare}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (value: unknown): value is PreparedCompletion =>
  typeof value === "object" &&
  value !== null &&
  preparedCompletions.has(value) &&
  preparedMetadata.has(value)

/**
 * Prepares a plan-bound, schema-valid activity completion.
 *
 * **Details**
 *
 * The request must identify the exact currently started semantic attempt of a
 * running durable head. Successful output names must exactly match the
 * compiled node definition and each encoded value is decoded through its
 * output-port schema. Encoded application failures are decoded through the
 * node failure schema. Codec defects become typed failures while pure Effect
 * interruption remains interruption.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: DecisionV2.DecidablePlan<W>,
  stateInput: unknown,
  requestInput: unknown
): Effect.fn.Return<
  PreparedCompletion,
  ActivityCompletionError,
  Requirements<W>
> {
  const state = yield* validateState(plan, stateInput)
  const request = captureRequest(requestInput)
  if (Result.isFailure(request)) {
    return yield* Effect.fail(request.failure)
  }
  if (
    request.success.key.tenantId !== state.tenantId ||
    request.success.key.runId !== state.runId
  ) {
    return yield* Effect.fail(makeError(
      Codes.RunKeyMismatch,
      "Activity-completion request key does not match the durable run",
      {
        details: {
          expectedTenantId: state.tenantId,
          expectedRunId: state.runId,
          actualTenantId: request.success.key.tenantId,
          actualRunId: request.success.key.runId
        }
      }
    ))
  }
  if (state.status !== "Running") {
    return yield* Effect.fail(makeError(
      Codes.RunNotRunning,
      `Activity completion requires a running run, received '${state.status}'`
    ))
  }

  const activityOption = HashMap.get(
    state.activities,
    request.success.logicalActivityId
  )
  if (activityOption._tag === "None") {
    return yield* Effect.fail(makeError(
      Codes.ActivityNotFound,
      `Logical activity '${request.success.logicalActivityId}' is not scheduled`,
      {
        logicalActivityId: request.success.logicalActivityId,
        attemptId: request.success.attemptId,
        attempt: request.success.attempt
      }
    ))
  }
  const activity = activityOption.value
  const attemptOption = HashMap.get(
    activity.attempts,
    request.success.attempt
  )
  if (
    attemptOption._tag === "None" ||
    activity.currentAttempt !== request.success.attempt ||
    activity.currentAttemptId !== request.success.attemptId ||
    attemptOption.value.attemptId !== request.success.attemptId
  ) {
    return yield* Effect.fail(makeError(
      Codes.AttemptMismatch,
      "Activity completion does not identify the exact current semantic attempt",
      {
        nodeId: activity.nodeId,
        logicalActivityId: activity.logicalActivityId,
        attemptId: request.success.attemptId,
        attempt: request.success.attempt,
        details: {
          expectedAttemptId: activity.currentAttemptId,
          actualAttemptId: request.success.attemptId,
          expectedAttempt: activity.currentAttempt,
          actualAttempt: request.success.attempt
        }
      }
    ))
  }
  const attempt = attemptOption.value
  if (activity.status !== "Active" || attempt.status !== "Started") {
    return yield* Effect.fail(makeError(
      Codes.IllegalActivityTransition,
      "Only the exact currently started activity attempt can complete",
      {
        nodeId: activity.nodeId,
        logicalActivityId: activity.logicalActivityId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempt,
        details: {
          activityStatus: activity.status,
          attemptStatus: attempt.status
        }
      }
    ))
  }
  const node = plan.compiled.nodes.get(activity.nodeId)
  if (node === undefined) {
    return yield* Effect.fail(makeError(
      Codes.UnknownActivityNode,
      `Activity '${activity.logicalActivityId}' refers to an unknown compiled node`,
      {
        nodeId: activity.nodeId,
        logicalActivityId: activity.logicalActivityId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempt
      }
    ))
  }

  if (request.success.completion._tag === "Succeeded") {
    yield* validateOutput<W>(
      node,
      request.success.completion.output,
      {
        logicalActivityId: activity.logicalActivityId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempt
      }
    )
  } else {
    yield* validateFailure<W>(
      node,
      request.success.completion.failure,
      {
        logicalActivityId: activity.logicalActivityId,
        attemptId: attempt.attemptId,
        attempt: attempt.attempt
      }
    )
  }

  const prepared: PreparedCompletion = Object.freeze({
    [PreparedCompletionTypeId]: true as const,
    wire: request.success,
    expectedSequence: state.sequence
  })
  const metadata: PreparedMetadata = Object.freeze({
    plan,
    state,
    expectedSequence: state.sequence,
    wire: request.success
  })
  preparedCompletions.add(prepared)
  preparedMetadata.set(prepared, metadata)
  return prepared
})

/**
 * Resolves an admitted completion inside its authoritative commit transaction.
 *
 * **Details**
 *
 * Resolution requires the same prepared-plan object and the same exact
 * reducer-derived state object used during preparation. A newly committed head
 * therefore invalidates an older capability even when its request still names
 * an otherwise valid activity attempt.
 *
 * @category validation
 * @since 4.0.0
 */
export const resolve = (
  plan: DecisionV2.DecidablePlan,
  state: RunStateV2.RunState,
  prepared: unknown
): Result.Result<
  ExternalEventV2.CompleteActivityAttemptRequest,
  ActivityCompletionError
> => {
  if (!isPrepared(prepared)) {
    return Result.fail(makeError(
      Codes.InvalidPreparedCompletion,
      "Completion must be an exact capability returned by ActivityCompletionV2.prepare"
    ))
  }
  const metadata = preparedMetadata.get(prepared)!
  if (metadata.plan !== plan) {
    return Result.fail(makeError(
      Codes.PreparedPlanMismatch,
      "Prepared completion belongs to a different exact plan object"
    ))
  }
  if (metadata.state !== state) {
    return Result.fail(makeError(
      Codes.PreparedStateMismatch,
      "Prepared completion belongs to a different exact durable-head object",
      {
        details: {
          expectedSequence: metadata.expectedSequence,
          actualSequence: state.sequence
        }
      }
    ))
  }
  if (
    state.sequence !== metadata.expectedSequence ||
    prepared.expectedSequence !== metadata.expectedSequence
  ) {
    return Result.fail(makeError(
      Codes.StalePreparedCompletion,
      "Prepared completion sequence no longer matches its durable head",
      {
        details: {
          expectedSequence: metadata.expectedSequence,
          actualSequence: state.sequence
        }
      }
    ))
  }
  return Result.succeed(metadata.wire)
}
