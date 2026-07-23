/**
 * Executes one already-committed workflow activity in the current process.
 *
 * This boundary performs no history writes and provides no durable scheduling,
 * leasing, retry, or recovery semantics. A runner is responsible for committing
 * a schedule command before invoking this process-local executor and for
 * appending the returned event draft.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Command from "./Command.ts"
import * as Compiler from "./Compiler.ts"
import * as Event from "./Event.ts"
import type * as HistoryStore from "./HistoryStore.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"
import type * as Node from "./Node.ts"
import * as Registry from "./Registry.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Activity-execution phase associated with an engine-level failure.
 *
 * @category models
 * @since 4.0.0
 */
export type Phase =
  | "identity"
  | "configuration"
  | "input"
  | "handler"
  | "output"
  | "failure"
  | "validation"

/**
 * Explicit tenant and handler-deployment identity for durable execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DurableExecutionIdentity = Schema.Struct({
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  handlerDeploymentId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDurableActivityExecutionIdentity",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DurableExecutionIdentity}.
 *
 * @category models
 * @since 4.0.0
 */
export type DurableExecutionIdentity = Schema.Schema.Type<typeof DurableExecutionIdentity>

/**
 * Explicit direct or durable identity accepted by {@link execute}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutionIdentity = string | DurableExecutionIdentity

/**
 * Raised when an activity cannot safely be invoked or converted into history.
 *
 * **Details**
 *
 * A handler's compatible typed failure is returned as a successful
 * {@link Failed} outcome. This error is reserved for activity-boundary
 * identity, compatibility, codec, handler-protocol, and strict-JSON failures.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityRuntimeError extends Schema.TaggedErrorClass<ActivityRuntimeError>(
  "@effect/workflow-builder/ActivityRuntime/ActivityRuntimeError"
)("ActivityRuntimeError", {
  runId: Schema.String,
  nodeId: Schema.optionalKey(Schema.String),
  activityId: Schema.optionalKey(Schema.String),
  phase: Schema.Literals([
    "identity",
    "configuration",
    "input",
    "handler",
    "output",
    "failure",
    "validation"
  ]),
  message: Schema.String,
  details: Schema.optionalKey(Schema.Json)
}) {}

/**
 * A successful activity execution converted into an append-ready event draft.
 *
 * @category models
 * @since 4.0.0
 */
export interface Succeeded {
  readonly _tag: "Succeeded"
  readonly event: HistoryStore.EventDraft<Event.ActivitySucceeded>
}

/**
 * A compatible typed activity failure converted into an append-ready event
 * draft.
 *
 * **Details**
 *
 * `failure` is the original in-process typed value for local recovery and
 * observability. Only `event.payload.failure` is detached strict JSON suitable
 * for persistence.
 *
 * @category models
 * @since 4.0.0
 */
export interface Failed<out Failure> {
  readonly _tag: "Failed"
  readonly event: HistoryStore.EventDraft<Event.ActivityFailed>
  readonly failure: Failure
}

/**
 * Result of executing one admitted activity command.
 *
 * @category models
 * @since 4.0.0
 */
export type Outcome<Failure = unknown> = Succeeded | Failed<Failure>

type DefinitionsOf<W extends Workflow.Any> = Registry.Definitions<Workflow.Nodes<W>>
type NodeOf<W extends Workflow.Any> = DefinitionsOf<W>[keyof DefinitionsOf<W>]

/**
 * Typed failures declared by nodes available to a workflow definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Failure<W extends Workflow.Any> = Node.Failure<NodeOf<W>>

/**
 * Effect services required to execute one activity.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | Registry.HandlerRegistry
  | Node.ConfigDecodingServices<NodeOf<W>>
  | Node.InputDecodingServices<NodeOf<W>>
  | Node.OutputEncodingServices<NodeOf<W>>
  | Node.FailureEncodingServices<NodeOf<W>>
  | Node.Requirements<NodeOf<W>>

const ActivitySucceededDraft = Schema.Struct({
  eventVersion: Schema.Literal(1),
  eventId: Schema.NonEmptyString,
  causationId: Schema.optionalKey(Schema.NonEmptyString),
  correlationId: Schema.optionalKey(Schema.NonEmptyString),
  payload: Event.ActivitySucceeded
}).annotate({ parseOptions: strictParseOptions })

const ActivityFailedDraft = Schema.Struct({
  eventVersion: Schema.Literal(1),
  eventId: Schema.NonEmptyString,
  causationId: Schema.optionalKey(Schema.NonEmptyString),
  correlationId: Schema.optionalKey(Schema.NonEmptyString),
  payload: Event.ActivityFailed
}).annotate({ parseOptions: strictParseOptions })

const decodeDurableExecutionIdentity = Schema.decodeUnknownResult(
  DurableExecutionIdentity,
  strictParseOptions
)

/**
 * Returns the deterministic event identity for a successful activity result.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activitySucceededEventId = (activityId: string): string => Identity.activitySucceededEventId(activityId)

/**
 * Returns the deterministic event identity for a failed activity result.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityFailedEventId = (activityId: string): string => Identity.activityFailedEventId(activityId)

const makeError = (
  runId: string,
  phase: Phase,
  message: string,
  schedule?: Command.ScheduleActivity,
  details?: Schema.Json
): ActivityRuntimeError =>
  new ActivityRuntimeError({
    runId,
    phase,
    ...(schedule === undefined ? undefined : {
      nodeId: schedule.nodeId,
      activityId: schedule.activityId
    }),
    ...(details === undefined ? undefined : { details }),
    message
  })

const runCodec = Effect.fnUntraced(function*<A, R>(
  construct: () => Effect.Effect<A, { readonly message: string }, R>,
  onFailure: (message: string) => ActivityRuntimeError
): Effect.fn.Return<A, ActivityRuntimeError, R> {
  const operation = yield* Effect.try({
    try: construct,
    catch: () => onFailure("Codec could not be prepared safely")
  })
  return yield* operation.pipe(
    Effect.mapError((error) => onFailure(error.message)),
    Effect.catchCauseIf(
      Cause.hasDies,
      () => Effect.fail(onFailure("Codec failed unexpectedly"))
    )
  )
})

const validateSchema = Effect.fnUntraced(function*(
  schema: Schema.Top,
  value: unknown,
  error: (message: string) => ActivityRuntimeError
): Effect.fn.Return<void, ActivityRuntimeError> {
  yield* runCodec(
    () =>
      Schema.decodeUnknownEffect(schema, strictParseOptions)(value) as unknown as Effect.Effect<
        unknown,
        { readonly message: string },
        never
      >,
    error
  )
})

const snapshotEncoded = (
  value: unknown,
  error: (message: string) => ActivityRuntimeError
): Effect.Effect<Schema.Json, ActivityRuntimeError> => {
  const snapped = Json.snapshot(value)
  return Result.isFailure(snapped)
    ? Effect.fail(error(`Value must encode to strict JSON: ${snapped.failure.message}`))
    : Effect.succeed(snapped.success)
}

interface CapturedProperty {
  readonly key: PropertyKey
  readonly descriptor: PropertyDescriptor
}

const captureRecordProperties = Effect.fnUntraced(function*(
  value: unknown,
  error: (message: string) => ActivityRuntimeError
): Effect.fn.Return<ReadonlyArray<CapturedProperty>, ActivityRuntimeError> {
  if (typeof value !== "object" || value === null) {
    return yield* Effect.fail(error("Node handler output must be an object"))
  }
  const captured = yield* Effect.try({
    try: () => {
      const prototype = Object.getPrototypeOf(value)
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const properties = Reflect.ownKeys(descriptors).map((key) => ({
        key,
        descriptor: Reflect.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor
      }))
      return { prototype, properties } as const
    },
    catch: () => error("Node handler output could not be inspected safely")
  })
  if (captured.prototype !== Object.prototype && captured.prototype !== null) {
    return yield* Effect.fail(error(
      "Node handler output must use Object.prototype or null as its prototype"
    ))
  }
  return captured.properties
})

const isEnumerableDataProperty = (descriptor: PropertyDescriptor): boolean =>
  descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value")

const decodeInvocation = Effect.fnUntraced(function*(
  runId: string,
  input: Command.ScheduleActivity | Command.Command
): Effect.fn.Return<{
  readonly schedule: Command.ScheduleActivity
  readonly causationId?: string | undefined
}, ActivityRuntimeError> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(makeError(
      runId,
      "validation",
      `Activity command must be strict JSON: ${snapped.failure.message}`
    ))
  }
  const value = snapped.success
  const isEnvelope = typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "commandVersion")

  if (isEnvelope) {
    yield* validateSchema(
      Command.Command,
      value,
      (message) => makeError(runId, "validation", `Invalid activity command: ${message}`)
    )
    const command = value as Command.Command
    if (command.payload._tag !== "ScheduleActivity") {
      return yield* Effect.fail(makeError(
        runId,
        "validation",
        "Activity runtime requires a ScheduleActivity command"
      ))
    }
    return {
      schedule: command.payload,
      causationId: command.commandId
    }
  }

  yield* validateSchema(
    Command.ScheduleActivity,
    value,
    (message) => makeError(runId, "validation", `Invalid activity schedule: ${message}`)
  )
  return { schedule: value as Command.ScheduleActivity }
})

const validateIdentity = Effect.fnUntraced(function*(
  compiled: Compiler.CompiledPlan,
  runId: string,
  schedule: Command.ScheduleActivity,
  causationId?: string
): Effect.fn.Return<Compiler.CompiledNode, ActivityRuntimeError> {
  const nodeInstanceId = Command.staticNodeInstanceId(schedule.nodeId)
  if (schedule.nodeInstanceId !== nodeInstanceId) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      "Schedule nodeInstanceId is not canonical for its static node",
      schedule
    ))
  }
  if (schedule.attempt !== 1) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      "Command format version 1 supports only activity attempt 1",
      schedule
    ))
  }
  if (schedule.activityId !== Command.activityId(runId, nodeInstanceId, schedule.attempt)) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      "Schedule activityId is not canonical for the run and node instance",
      schedule
    ))
  }
  if (schedule.idempotencyKey !== Command.activityIdempotencyKey(runId, nodeInstanceId)) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      "Schedule idempotencyKey is not canonical for the run and node instance",
      schedule
    ))
  }
  if (
    causationId !== undefined &&
    causationId !== Command.scheduleActivityCommandId(runId, nodeInstanceId, schedule.attempt)
  ) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      "Schedule commandId is not canonical for the run and activity attempt",
      schedule
    ))
  }

  const compiledNode = yield* Effect.try({
    try: () => compiled.nodes.get(schedule.nodeId),
    catch: () =>
      makeError(
        runId,
        "identity",
        "Compiled node index could not be inspected safely",
        schedule
      )
  })
  if (compiledNode === undefined || compiledNode.node.id !== schedule.nodeId) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      `Schedule references unknown compiled node '${schedule.nodeId}'`,
      schedule
    ))
  }
  return compiledNode
})

const decodeInputs = Effect.fnUntraced(function*(
  definition: Node.Any,
  schedule: Command.ScheduleActivity,
  runId: string
): Effect.fn.Return<Record<string, unknown>, ActivityRuntimeError, Node.InputDecodingServices<Node.Any>> {
  const inputError = (message: string, input?: string) =>
    makeError(
      runId,
      "input",
      message,
      schedule,
      input === undefined ? undefined : { input }
    )
  const declared = new Set(Object.keys(definition.inputs))
  for (const name of Object.keys(schedule.input)) {
    if (!declared.has(name)) {
      return yield* Effect.fail(inputError(`Schedule contains unknown input '${name}'`, name))
    }
  }

  const entries: Array<readonly [string, unknown]> = []
  for (const [name, port] of Object.entries(definition.inputs)) {
    const present = Object.prototype.hasOwnProperty.call(schedule.input, name)
    if (port.cardinality === "many") {
      if (!present) {
        return yield* Effect.fail(inputError(
          `Schedule is missing array input '${name}'`,
          name
        ))
      }
      const encoded = schedule.input[name]
      if (!Array.isArray(encoded)) {
        return yield* Effect.fail(inputError(
          `Schedule input '${name}' must be a JSON array`,
          name
        ))
      }
      if (port.required && encoded.length === 0) {
        return yield* Effect.fail(inputError(
          `Required many input '${name}' must contain at least one value`,
          name
        ))
      }
      const decoded = yield* Effect.forEach(
        encoded,
        (value) =>
          runCodec(
            () => Schema.decodeUnknownEffect(port.schema)(value),
            (message) => inputError(`Invalid encoded input '${name}': ${message}`, name)
          ),
        { concurrency: 1 }
      )
      entries.push([name, Object.freeze(decoded)])
      continue
    }

    if (!present) {
      if (port.required) {
        return yield* Effect.fail(inputError(
          `Schedule is missing required input '${name}'`,
          name
        ))
      }
      entries.push([name, Option.none()])
      continue
    }
    const decoded = yield* runCodec(
      () => Schema.decodeUnknownEffect(port.schema)(schedule.input[name]),
      (message) => inputError(`Invalid encoded input '${name}': ${message}`, name)
    )
    entries.push([name, port.required ? decoded : Option.some(decoded)])
  }
  return Object.freeze(Object.fromEntries(entries))
})

const validateDraft = Effect.fnUntraced(function*<Payload extends Event.ActivitySucceeded | Event.ActivityFailed>(
  runId: string,
  schedule: Command.ScheduleActivity,
  schema: Schema.Top,
  draft: HistoryStore.EventDraft<Payload>
): Effect.fn.Return<HistoryStore.EventDraft<Payload>, ActivityRuntimeError> {
  const snapped = yield* snapshotEncoded(
    draft,
    (message) => makeError(runId, "validation", `Invalid activity result event: ${message}`, schedule)
  )
  yield* validateSchema(
    schema,
    snapped,
    (message) => makeError(runId, "validation", `Invalid activity result event: ${message}`, schedule)
  )
  return snapped as unknown as HistoryStore.EventDraft<Payload>
})

/**
 * Executes one already-committed schedule command in the current process.
 *
 * **Details**
 *
 * A full {@link Command.Command} is accepted when the caller has retained the
 * committed command envelope; its canonical command id becomes the result
 * event's `causationId`. A bare {@link Command.ScheduleActivity} is also
 * accepted, but no causation id is invented.
 *
 * Configuration is decoded afresh from the compiled plan for every invocation.
 * Scheduled inputs are strict encoded JSON: required single inputs must be
 * present, optional single inputs decode to `Option`, and many inputs must be
 * arrays whose elements are decoded individually. Exact input and output key
 * sets are enforced.
 *
 * Handler output and compatible typed failure encodings are detached into
 * recursively frozen strict-JSON snapshots before an append-ready event draft
 * is returned. Durable handler context uses a tenant-scoped external
 * idempotency key while the committed version `1` schedule identity remains
 * replay-compatible. The handler registry's captured context is merged with
 * the ambient execution context for the invocation.
 *
 * @category running
 * @since 4.0.0
 */
export const execute = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>,
  executionIdentity: ExecutionIdentity,
  input: Command.ScheduleActivity | Command.Command
): Effect.fn.Return<
  Outcome<Failure<W>>,
  ActivityRuntimeError,
  Requirements<W>
> {
  let runId: string
  let scope: Node.HandlerScope
  let handlerIdempotencyKey: (nodeInstanceId: string) => string
  if (typeof executionIdentity === "string") {
    if (executionIdentity.length === 0) {
      return yield* Effect.fail(makeError(
        "",
        "identity",
        "Activity execution requires a non-empty runId"
      ))
    }
    runId = executionIdentity
    scope = Object.freeze({ _tag: "Direct" })
    handlerIdempotencyKey = (nodeInstanceId) => Identity.activityIdempotencyKey(runId, nodeInstanceId)
  } else {
    const snapped = Json.snapshot(executionIdentity)
    if (Result.isFailure(snapped)) {
      return yield* Effect.fail(makeError(
        "",
        "identity",
        `Durable execution identity must be strict JSON: ${snapped.failure.message}`
      ))
    }
    let decoded: ReturnType<typeof decodeDurableExecutionIdentity>
    try {
      decoded = decodeDurableExecutionIdentity(snapped.success)
    } catch {
      return yield* Effect.fail(makeError(
        "",
        "identity",
        "Durable execution identity validation threw unexpectedly"
      ))
    }
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(makeError(
        "",
        "identity",
        `Invalid durable execution identity: ${decoded.failure.message}`
      ))
    }
    const identity = snapped.success as unknown as DurableExecutionIdentity
    runId = identity.runId
    scope = Object.freeze({
      _tag: "Durable",
      tenantId: identity.tenantId,
      handlerDeploymentId: identity.handlerDeploymentId
    })
    handlerIdempotencyKey = (nodeInstanceId) =>
      Identity.durableActivityIdempotencyKey(
        identity.tenantId,
        identity.runId,
        nodeInstanceId
      )
  }
  if (typeof runId !== "string" || runId.length === 0) {
    return yield* Effect.fail(makeError(
      "",
      "identity",
      "Activity execution requires a non-empty runId"
    ))
  }
  if (!Compiler.isCompiled(compiled)) {
    return yield* Effect.fail(makeError(
      runId,
      "identity",
      "Activity execution requires the exact result of Compiler.compile"
    ))
  }

  const invocation = yield* decodeInvocation(runId, input)
  const schedule = invocation.schedule
  const compiledNode = yield* validateIdentity(
    compiled,
    runId,
    schedule,
    invocation.causationId
  )

  const handlers = yield* Registry.HandlerRegistry
  const entry = yield* Effect.try({
    try: () => handlers.get(compiledNode.definition.type, compiledNode.definition.version),
    catch: () =>
      makeError(
        runId,
        "handler",
        "Handler registry could not be inspected safely",
        schedule
      )
  })
  if (
    entry === undefined ||
    entry.definition !== compiledNode.definition ||
    typeof entry.handler !== "function"
  ) {
    return yield* Effect.fail(makeError(
      runId,
      "handler",
      `No exact handler is installed for '${compiledNode.definition.type}@${compiledNode.definition.version}'`,
      schedule
    ))
  }

  const config = yield* runCodec(
    () =>
      Schema.decodeUnknownEffect(
        compiledNode.definition.configSchema,
        strictParseOptions
      )(compiledNode.node.config),
    (message) =>
      makeError(
        runId,
        "configuration",
        `Pinned node configuration could not be decoded: ${message}`,
        schedule
      )
  )
  const decodedInputs = yield* decodeInputs(compiledNode.definition, schedule, runId)
  const executionContext = yield* Effect.context<never>()
  const handlerEffectUnknown = yield* Effect.try({
    try: () =>
      entry.handler({
        config,
        inputs: decodedInputs,
        context: {
          scope,
          runId,
          planId: compiled.plan.id,
          planRevision: compiled.plan.revision,
          nodeId: schedule.nodeId,
          nodeInstanceId: schedule.nodeInstanceId,
          attempt: schedule.attempt,
          idempotencyKey: handlerIdempotencyKey(schedule.nodeInstanceId)
        }
      }) as unknown,
    catch: () =>
      makeError(
        runId,
        "handler",
        "Node handler threw before returning an Effect",
        schedule
      )
  })
  const isEffect = yield* Effect.try({
    try: () => Effect.isEffect(handlerEffectUnknown),
    catch: () =>
      makeError(
        runId,
        "handler",
        "Node handler result could not be inspected safely",
        schedule
      )
  })
  if (!isEffect) {
    return yield* Effect.fail(makeError(
      runId,
      "handler",
      "Node handler did not return an Effect",
      schedule
    ))
  }

  const handled = yield* Effect.result(
    (handlerEffectUnknown as Effect.Effect<
      Record<string, unknown>,
      Failure<W>,
      Requirements<W>
    >).pipe(
      Effect.updateContext((current) =>
        Context.merge(entry.context, Context.merge(executionContext, current)) as Context.Context<any>
      )
    )
  ).pipe(
    Effect.catchCauseIf(
      Cause.hasDies,
      () =>
        Effect.fail(makeError(
          runId,
          "handler",
          "Node handler failed with an unexpected defect",
          schedule
        ))
    )
  )

  if (Result.isFailure(handled)) {
    const encoded = yield* runCodec(
      () => Schema.encodeUnknownEffect(compiledNode.definition.failureSchema)(handled.failure),
      (message) =>
        makeError(
          runId,
          "failure",
          `Handler returned an incompatible typed failure: ${message}`,
          schedule
        )
    )
    const failure = yield* snapshotEncoded(
      encoded,
      (message) => makeError(runId, "failure", `Handler failure ${message}`, schedule)
    )
    const draft = yield* validateDraft(
      runId,
      schedule,
      ActivityFailedDraft,
      {
        eventVersion: 1,
        eventId: activityFailedEventId(schedule.activityId),
        ...(invocation.causationId === undefined ? undefined : {
          causationId: invocation.causationId
        }),
        payload: {
          _tag: "ActivityFailed",
          activityId: schedule.activityId,
          failure
        }
      }
    )
    return Object.freeze({
      _tag: "Failed",
      event: draft,
      failure: handled.failure
    })
  }

  const outputError = (message: string, output?: string) =>
    makeError(
      runId,
      "output",
      message,
      schedule,
      output === undefined ? undefined : { output }
    )
  const captured = yield* captureRecordProperties(handled.success, outputError)
  const declared = new Set(Object.keys(compiledNode.definition.outputs))
  const values = new Map<string, unknown>()
  for (const property of captured) {
    if (typeof property.key !== "string") {
      return yield* Effect.fail(outputError(
        "Node handler output must not contain symbol properties"
      ))
    }
    if (!isEnumerableDataProperty(property.descriptor)) {
      return yield* Effect.fail(outputError(
        `Handler output '${property.key}' must be an enumerable data property`,
        property.key
      ))
    }
    if (!declared.has(property.key)) {
      return yield* Effect.fail(outputError(
        `Handler returned unknown output '${property.key}'`,
        property.key
      ))
    }
    values.set(property.key, property.descriptor.value)
  }

  const encodedEntries: Array<readonly [string, Schema.Json]> = []
  for (const [name, port] of Object.entries(compiledNode.definition.outputs)) {
    if (!values.has(name)) {
      return yield* Effect.fail(outputError(
        `Handler did not return required output '${name}'`,
        name
      ))
    }
    const encoded = yield* runCodec(
      () => Schema.encodeUnknownEffect(port.schema)(values.get(name)),
      (message) => outputError(`Invalid handler output '${name}': ${message}`, name)
    )
    encodedEntries.push([
      name,
      yield* snapshotEncoded(
        encoded,
        (message) => outputError(`Handler output '${name}' ${message}`, name)
      )
    ])
  }
  const output = (yield* snapshotEncoded(
    Object.fromEntries(encodedEntries),
    (message) => outputError(`Encoded handler output ${message}`)
  )) as Event.EncodedValues
  const draft = yield* validateDraft(
    runId,
    schedule,
    ActivitySucceededDraft,
    {
      eventVersion: 1,
      eventId: activitySucceededEventId(schedule.activityId),
      ...(invocation.causationId === undefined ? undefined : {
        causationId: invocation.causationId
      }),
      payload: {
        _tag: "ActivitySucceeded",
        activityId: schedule.activityId,
        output
      }
    }
  )
  return Object.freeze({
    _tag: "Succeeded",
    event: draft
  })
})
