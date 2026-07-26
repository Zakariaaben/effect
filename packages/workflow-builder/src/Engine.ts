/**
 * Durable execution of compiled plans on the native Effect workflow runtime.
 *
 * The engine is one generic native workflow — `workflow-builder/run` — whose
 * handler deterministically interprets a pinned, compiled plan. Everything
 * durable delegates to `effect/unstable/workflow`: node attempts are dynamic
 * activities replayed by name, waits are durable deferreds, timers are
 * durable clocks, and sub-workflows are child executions of the same generic
 * workflow. The engine adds no persistence of its own; on resume the handler
 * re-runs and every committed step short-circuits from the native journal.
 *
 * Determinism contract: the interpreter reads only the pinned plan, the run
 * input, and recorded activity/deferred results. Every clock observation and
 * every side effect crosses an activity boundary.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import * as DurableWorkflow from "effect/unstable/workflow/Workflow"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Builtins from "./Builtins.ts"
import * as Compiler from "./Compiler.ts"
import * as Expression from "./Expression.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as HumanTasks from "./HumanTasks.ts"
import * as Json from "./internal/json.ts"
import * as Node from "./Node.ts"
import * as Plan from "./Plan.ts"
import * as PlanStore from "./PlanStore.ts"
import * as Policy from "./Policy.ts"
import type * as Port from "./Port.ts"
import * as Registry from "./Registry.ts"
import * as RunJournal from "./RunJournal.ts"
import type * as Workflow from "./Workflow.ts"

// ----------------------------------------------------------------------------
// Wire schemas
// ----------------------------------------------------------------------------

const strictParseOptions = { onExcessProperty: "error" } as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Maximum nesting depth of sub-workflow and for-each child runs.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxDepth = 16

/**
 * Maximum number of items a single for-each group may expand to.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxItems = 1024

/**
 * Payload starting one run of a pinned plan revision.
 *
 * **Details**
 *
 * `runKey` is the caller's idempotency handle: starting the same plan pin
 * with the same key returns the same execution. `fingerprint` fails the run
 * closed when the stored plan does not match the meaning the caller admitted.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunPayload = Schema.Struct({
  planId: Schema.NonEmptyString,
  revision: NonNegativeInt,
  fingerprint: Fingerprint.Digest,
  input: Schema.Json,
  runKey: Schema.NonEmptyString,
  depth: NonNegativeInt
}).annotate({
  identifier: "WorkflowRunPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RunPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunPayload = Schema.Schema.Type<typeof RunPayload>

/**
 * Successful run result: the encoded workflow outputs that were live.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunSuccess = Schema.Struct({
  outputs: Schema.Record(Schema.String, Schema.Json)
}).annotate({
  identifier: "WorkflowRunSuccess",
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
 * A node's typed business failure exhausted its policy without a routed
 * `error` outcome.
 *
 * @category errors
 * @since 4.0.0
 */
export class NodeFailed extends Schema.TaggedErrorClass<NodeFailed>(
  "@effect/workflow-builder/Engine/NodeFailed"
)("NodeFailed", {
  nodeId: Schema.String,
  attempts: Schema.Int,
  error: Schema.Json
}) {}

/**
 * A node exceeded one of its timeout dimensions.
 *
 * @category errors
 * @since 4.0.0
 */
export class NodeTimedOut extends Schema.TaggedErrorClass<NodeTimedOut>(
  "@effect/workflow-builder/Engine/NodeTimedOut"
)("NodeTimedOut", {
  nodeId: Schema.String,
  kind: Schema.Literals(["attempt", "total"]),
  millis: Schema.Int
}) {}

/**
 * A `workflow/fail` node terminated the run deliberately.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunAborted extends Schema.TaggedErrorClass<RunAborted>(
  "@effect/workflow-builder/Engine/RunAborted"
)("RunAborted", {
  nodeId: Schema.String,
  code: Schema.String,
  message: Schema.String
}) {}

/**
 * The engine could not interpret the plan: configuration, expression, or
 * value validation failed at runtime.
 *
 * @category errors
 * @since 4.0.0
 */
export class EngineFault extends Schema.TaggedErrorClass<EngineFault>(
  "@effect/workflow-builder/Engine/EngineFault"
)("EngineFault", {
  nodeId: Schema.optionalKey(Schema.String),
  phase: Schema.String,
  message: Schema.String
}) {}

/**
 * Run admission failed: the plan pin could not be resolved, verified, or
 * compiled against the current vocabulary.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanRejected extends Schema.TaggedErrorClass<PlanRejected>(
  "@effect/workflow-builder/Engine/PlanRejected"
)("PlanRejected", {
  planId: Schema.String,
  revision: Schema.Int,
  message: Schema.String
}) {}

/**
 * Every way a run can fail.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RunFailure = Schema.Union([
  NodeFailed,
  NodeTimedOut,
  RunAborted,
  EngineFault,
  PlanRejected
]).annotate({ identifier: "WorkflowRunFailure" })

/**
 * The decoded type of {@link RunFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type RunFailure = Schema.Schema.Type<typeof RunFailure>

/**
 * The generic native workflow interpreting every plan run.
 *
 * **Details**
 *
 * The execution id derives from `planId`, `revision`, and `runKey`, so run
 * identity is stable across processes and restarts without a coordination
 * service.
 *
 * @category workflow
 * @since 4.0.0
 */
export const Run = DurableWorkflow.make("workflow-builder/run", {
  payload: RunPayload,
  success: RunSuccess,
  error: RunFailure,
  idempotencyKey: (payload) => `${payload.planId}:${payload.revision}:${payload.runKey}`
})

// ----------------------------------------------------------------------------
// Internal wire helpers
// ----------------------------------------------------------------------------

const AttemptOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", {
    outputs: Schema.Record(Schema.String, Schema.Json)
  }),
  Schema.TaggedStruct("Failed", {
    tag: Schema.Union([Schema.String, Schema.Null]),
    error: Schema.Json
  }),
  Schema.TaggedStruct("TimedOut", {})
]).annotate({ identifier: "WorkflowAttemptOutcome" })

type AttemptOutcome = Schema.Schema.Type<typeof AttemptOutcome>

const PlanPin = Schema.Union([
  Schema.TaggedStruct("Resolved", {
    revision: Schema.Int,
    fingerprint: Fingerprint.Digest
  }),
  Schema.TaggedStruct("NotFound", {})
]).annotate({ identifier: "WorkflowPlanPin" })

const TaskHandle = Schema.Struct({
  taskId: Schema.String,
  dueAtMillis: Schema.Union([Schema.Number, Schema.Null])
}).annotate({ identifier: "WorkflowTaskHandle" })

/** Collision-free durable names: JSON tuples, never string concatenation. */
const durableName = (...parts: ReadonlyArray<string | number>): string => JSON.stringify(parts)

/** Services every durable step requires from the native runtime. */
type Durable = WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance

/**
 * The durable deferred a `workflow/receive` node awaits for a named signal.
 *
 * **Details**
 *
 * The deferred address is `(workflow, runId, signal name)`, so external
 * senders need only the run id and the signal name declared in the plan.
 *
 * @category signals
 * @since 4.0.0
 */
export const signalDeferred = (
  name: string
): DurableDeferred.DurableDeferred<typeof Schema.Json> =>
  DurableDeferred.make(durableName("signal", name), { success: Schema.Json })

type Settlement =
  | {
    readonly _tag: "Completed"
    readonly outcome: string
    readonly outputs: Readonly<Record<string, Schema.Json>>
    readonly attempts: number
  }
  | { readonly _tag: "Skipped" }

const skipped: Settlement = { _tag: "Skipped" }

const completed = (
  outcome: string,
  outputs: Readonly<Record<string, Schema.Json>>,
  attempts = 1
): Settlement => ({
  _tag: "Completed",
  outcome,
  outputs,
  attempts
})

/**
 * Options for {@link layer}.
 *
 * @category models
 * @since 4.0.0
 */
export interface Options {
  readonly tenantId?: string | undefined
}

// ----------------------------------------------------------------------------
// The interpreter
// ----------------------------------------------------------------------------

interface RunContext {
  readonly definition: Workflow.Any
  readonly compiled: Compiler.CompiledPlan
  readonly payload: RunPayload
  readonly executionId: string
  readonly tenantId: string
  readonly handlers: Registry.HandlerRegistry["Service"]
  readonly humanTasks: HumanTasks.HumanTasks["Service"]
  readonly planStore: PlanStore.PlanStore["Service"]
  readonly journal: RunJournal.Service
  readonly input: Schema.JsonObject
  readonly settlements: Map<string, Settlement>
  readonly latches: Map<string, Deferred.Deferred<Settlement>>
  readonly values: Map<string, Schema.Json>
  readonly nodesScope: { [nodeId: string]: Schema.Json }
  readonly compensations: Array<{
    readonly node: Compiler.CompiledNode
    readonly settlement: Extract<Settlement, { _tag: "Completed" }>
  }>
}

const valueKey = (endpoint: { readonly kind: string; readonly nodeId?: string; readonly port: string }): string =>
  endpoint.kind === "WorkflowInput"
    ? durableName("WorkflowInput", endpoint.port)
    : durableName("NodeOutput", endpoint.nodeId!, endpoint.port)

const fault = (nodeId: string | undefined, phase: string, message: string): EngineFault =>
  nodeId === undefined
    ? new EngineFault({ phase, message })
    : new EngineFault({ nodeId, phase, message })

const scopeOf = (context: RunContext): Expression.Scope => ({
  input: context.input,
  nodes: context.nodesScope
})

const evaluateExpression = (
  context: RunContext,
  nodeId: string,
  phase: string,
  expression: Expression.Expression,
  extra?: Readonly<Record<string, Schema.Json>>
): Effect.Effect<Schema.Json, EngineFault> => {
  const result = Expression.evaluate(expression, { ...scopeOf(context), ...extra })
  return Result.isFailure(result)
    ? Effect.fail(fault(nodeId, phase, result.failure.message))
    : Effect.succeed(result.success)
}

/**
 * Erases the `unknown` service requirement that type-erased vocabulary
 * schemas report. Port, config, and failure codecs run against the ambient
 * handler context; the engine adds no services of its own here.
 */
const erase = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> => effect as Effect.Effect<A, E>

const decodeConfig = (
  node: Compiler.CompiledNode
): Effect.Effect<unknown, EngineFault> =>
  erase(
    Schema.decodeUnknownEffect(node.definition.configSchema, {
      errors: "all",
      onExcessProperty: "error"
    })(node.node.config).pipe(
      Effect.catchCause((cause) => Effect.fail(fault(node.node.id, "configuration", Cause.pretty(cause))))
    )
  )

/** Journal emission: observational, idempotent, and never load-bearing. */
const emit = (context: RunContext, entry: RunJournal.EntryInput): Effect.Effect<void> =>
  context.journal.record(entry).pipe(Effect.catchCause(() => Effect.void))

const settle = (
  context: RunContext,
  nodeId: string,
  settlement: Settlement
): Effect.Effect<void> =>
  Effect.gen(function*() {
    context.settlements.set(nodeId, settlement)
    if (settlement._tag === "Completed") {
      context.nodesScope[nodeId] = settlement.outputs as Schema.Json
      for (const [port, value] of Object.entries(settlement.outputs)) {
        context.values.set(durableName("NodeOutput", nodeId, port), value)
      }
    }
    yield* emit(
      context,
      settlement._tag === "Completed"
        ? {
          _tag: "NodeCompleted",
          runId: context.executionId,
          planId: context.payload.planId,
          nodeId,
          outcome: settlement.outcome,
          attempts: settlement.attempts
        }
        : {
          _tag: "NodeSkipped",
          runId: context.executionId,
          planId: context.payload.planId,
          nodeId
        }
    )
    yield* Deferred.succeed(context.latches.get(nodeId)!, settlement)
  })

const edgeIsLive = (context: RunContext, edge: Compiler.CompiledControlEdge): boolean => {
  const settlement = context.settlements.get(edge.sourceNodeId)
  return settlement !== undefined && settlement._tag === "Completed" && settlement.outcome === edge.outcome
}

/** Waits for eligibility: `Live` to run, or a dead-path settlement. */
const awaitEligibility = (
  context: RunContext,
  node: Compiler.CompiledNode
): Effect.Effect<"live" | "skip", never> =>
  node.join === "any"
    ? Effect.gen(function*() {
      const fire = yield* Deferred.make<"live" | "skip">()
      let dead = 0
      yield* Effect.forEach(node.incomingControl, (edge) =>
        Effect.forkChild(
          Effect.gen(function*() {
            yield* Deferred.await(context.latches.get(edge.sourceNodeId)!)
            if (edgeIsLive(context, edge)) {
              yield* Deferred.succeed(fire, "live")
            } else {
              dead++
              if (dead === node.incomingControl.length) {
                yield* Deferred.succeed(fire, "skip")
              }
            }
          }),
          { startImmediately: true }
        ))
      return yield* Deferred.await(fire)
    })
    : Effect.gen(function*() {
      for (const dependency of node.dependencies) {
        yield* Deferred.await(context.latches.get(dependency)!)
      }
      if (node.incomingControl.length > 0 && !node.incomingControl.some((edge) => edgeIsLive(context, edge))) {
        return "skip"
      }
      return "live"
    })

// ----------------------------------------------------------------------------
// Input resolution
// ----------------------------------------------------------------------------

type ResolvedInputs =
  | { readonly _tag: "Resolved"; readonly inputs: Record<string, unknown> }
  | { readonly _tag: "DeadPath" }

const decodePortValue = (
  nodeId: string,
  portName: string,
  schema: Port.PayloadSchema,
  value: Schema.Json
): Effect.Effect<unknown, EngineFault> =>
  erase(
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(fault(nodeId, "node-input", `Input '${portName}': ${Cause.pretty(cause)}`))
      )
    )
  )

const liveEdgeValue = (
  context: RunContext,
  nodeId: string,
  edge: Compiler.CompiledDataEdge
): Effect.Effect<Option.Option<Schema.Json>, EngineFault> =>
  Effect.gen(function*() {
    const raw = context.values.get(valueKey(edge.source))
    if (raw === undefined) {
      return Option.none()
    }
    if (edge.edge.transform === undefined) {
      return Option.some(raw)
    }
    const transformed = yield* evaluateExpression(
      context,
      nodeId,
      "transform",
      edge.edge.transform,
      { value: raw }
    )
    return Option.some(transformed)
  })

const resolveInputs = (
  context: RunContext,
  node: Compiler.CompiledNode
): Effect.Effect<ResolvedInputs, EngineFault> =>
  Effect.gen(function*() {
    const inputs: Record<string, unknown> = {}
    for (const portName of Object.keys(node.definition.inputs).sort()) {
      const port = node.definition.inputs[portName]!
      const edges = node.incoming.filter((edge) => edge.target.kind === "NodeInput" && edge.target.port === portName)
      const live: Array<Schema.Json> = []
      for (const edge of edges) {
        const value = yield* liveEdgeValue(context, node.node.id, edge)
        if (Option.isSome(value)) {
          live.push(value.value)
        }
      }
      const binding = node.bindings.get(portName)

      if (port.cardinality === "many") {
        let encoded: ReadonlyArray<Schema.Json> = live
        if (edges.length === 0 && binding !== undefined) {
          const bound = yield* evaluateExpression(context, node.node.id, "binding", binding)
          if (!Array.isArray(bound)) {
            return yield* Effect.fail(fault(
              node.node.id,
              "binding",
              `Binding for '${portName}' must produce an array`
            ))
          }
          encoded = bound
        }
        if (port.required && encoded.length === 0 && (edges.length > 0 || binding !== undefined)) {
          return { _tag: "DeadPath" as const }
        }
        const decoded: Array<unknown> = []
        for (const value of encoded) {
          decoded.push(yield* decodePortValue(node.node.id, portName, port.schema, value))
        }
        inputs[portName] = decoded
        continue
      }

      let encoded: Schema.Json | undefined = live[0]
      if (encoded === undefined && edges.length === 0 && binding !== undefined) {
        encoded = yield* evaluateExpression(context, node.node.id, "binding", binding)
      }
      if (encoded === undefined) {
        if (port.required) {
          // Every compile-admitted required input has an edge or binding, so
          // reaching this point means every feeding edge is dead.
          return { _tag: "DeadPath" as const }
        }
        inputs[portName] = Option.none()
        continue
      }
      const decoded = yield* decodePortValue(node.node.id, portName, port.schema, encoded)
      inputs[portName] = port.required ? decoded : Option.some(decoded)
    }
    return { _tag: "Resolved" as const, inputs }
  })

// ----------------------------------------------------------------------------
// Application-node execution (activity + managed retry)
// ----------------------------------------------------------------------------

const encodeOutputs = (
  node: Compiler.CompiledNode,
  outputs: Record<string, unknown>
): Effect.Effect<Record<string, Schema.Json>, EngineFault> =>
  erase(Effect.gen(function*() {
    const encoded: Record<string, Schema.Json> = {}
    for (const portName of Object.keys(node.definition.outputs).sort()) {
      const port = node.definition.outputs[portName]!
      if (!Object.prototype.hasOwnProperty.call(outputs, portName)) {
        return yield* Effect.fail(fault(
          node.node.id,
          "node-output",
          `Handler did not produce declared output '${portName}'`
        ))
      }
      const value = yield* Schema.encodeUnknownEffect(port.schema)(outputs[portName]).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(fault(node.node.id, "node-output", `Output '${portName}': ${Cause.pretty(cause)}`))
        )
      )
      const snapshot = Json.snapshot(value)
      if (Result.isFailure(snapshot)) {
        return yield* Effect.fail(fault(
          node.node.id,
          "node-output",
          `Output '${portName}' is not portable JSON: ${snapshot.failure.message}`
        ))
      }
      encoded[portName] = snapshot.success
    }
    return encoded
  }))

const encodeFailure = (
  node: Compiler.CompiledNode,
  error: unknown
): Effect.Effect<{ readonly tag: string | null; readonly error: Schema.Json }, EngineFault> =>
  erase(Effect.gen(function*() {
    const encoded = yield* Schema.encodeUnknownEffect(node.definition.failureSchema)(error).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(fault(node.node.id, "failure", `Typed failure could not be encoded: ${Cause.pretty(cause)}`))
      )
    )
    const snapshot = Json.snapshot(encoded)
    if (Result.isFailure(snapshot)) {
      return yield* Effect.fail(fault(
        node.node.id,
        "failure",
        `Typed failure is not portable JSON: ${snapshot.failure.message}`
      ))
    }
    const tag = typeof error === "object" && error !== null &&
        typeof (error as { _tag?: unknown })._tag === "string"
      ? (error as { _tag: string })._tag
      : null
    return { tag, error: snapshot.success }
  }))

const nodeAttempt = (
  context: RunContext,
  node: Compiler.CompiledNode,
  attempt: number,
  inputs: Record<string, unknown>,
  decisionToken: string | undefined
): Effect.Effect<AttemptOutcome, EngineFault, Durable> => {
  const attemptMillis = context.compiled.nodes.get(node.node.id)!.policy.timeouts?.attemptMillis
  const activity = Activity.make({
    name: durableName("node", node.node.id),
    success: AttemptOutcome,
    error: EngineFault,
    execute: Effect.gen(function*() {
      const entry = context.handlers.get(node.node.type, node.node.version)
      if (entry === undefined || entry.definition !== node.definition) {
        return yield* Effect.fail(fault(
          node.node.id,
          "handler",
          `No registered handler for '${node.node.type}@${node.node.version}'`
        ))
      }
      const config = yield* decodeConfig(node)
      const idempotencyKey = yield* Activity.idempotencyKey(durableName("node", node.node.id))
      const handlerContext: Node.HandlerContext = {
        scope: {
          _tag: "Durable",
          tenantId: context.tenantId,
          handlerDeploymentId: `${context.definition.id}@${context.definition.version}`
        },
        runId: context.executionId,
        planId: context.payload.planId,
        planRevision: context.payload.revision,
        nodeId: node.node.id,
        nodeInstanceId: durableName(context.executionId, node.node.id),
        attempt,
        idempotencyKey,
        decisionToken
      }
      const invocation = entry.handler({
        config: config as never,
        inputs: inputs as never,
        context: handlerContext
      }).pipe(
        Effect.updateContext((current) => Context.merge(entry.context as Context.Context<any>, current))
      ) as Effect.Effect<Record<string, unknown>, unknown>
      const outcome = yield* Effect.matchEffect(
        attemptMillis === undefined
          ? invocation
          : Effect.timeout(invocation, Duration.millis(attemptMillis)),
        {
          onSuccess: (outputs): Effect.Effect<AttemptOutcome, EngineFault> =>
            encodeOutputs(node, outputs).pipe(
              Effect.map((encoded) => ({ _tag: "Succeeded" as const, outputs: encoded }))
            ),
          onFailure: (error): Effect.Effect<AttemptOutcome, EngineFault> =>
            Cause.isTimeoutError(error)
              ? Effect.succeed<AttemptOutcome>({ _tag: "TimedOut" })
              : encodeFailure(node, error).pipe(
                Effect.map((encoded) => ({ _tag: "Failed" as const, tag: encoded.tag, error: encoded.error }))
              )
        }
      )
      return outcome
    })
  })
  return activity.pipe(
    Effect.provideService(Activity.CurrentAttempt, attempt)
  ) as Effect.Effect<AttemptOutcome, EngineFault, Durable>
}

const observeMillis = (name: string): Effect.Effect<number, never, Durable> =>
  Activity.make({
    name,
    success: Schema.Number,
    execute: Effect.clockWith((clock) => clock.currentTimeMillis)
  }) as unknown as Effect.Effect<number, never, Durable>

const errorRouted = (node: Compiler.CompiledNode): boolean =>
  node.outgoingControl.some((edge) => edge.outcome === Plan.ErrorOutcome) ||
  node.outgoing.some((edge) => edge.source.kind === "NodeOutput" && edge.source.port === Plan.ErrorOutcome)

const runApplicationNode = (
  context: RunContext,
  node: Compiler.CompiledNode,
  inputs: Record<string, unknown>,
  decisionToken?: string
): Effect.Effect<Settlement, RunFailure, Durable> =>
  Effect.gen(function*() {
    const retry = node.policy.retry ?? Policy.defaultRetry
    const totalMillis = node.policy.timeouts?.totalMillis
    const startedAt = totalMillis === undefined
      ? 0
      : yield* observeMillis(durableName("node", node.node.id, "time", "start"))

    let attempt = 1
    while (true) {
      const outcome = yield* nodeAttempt(context, node, attempt, inputs, decisionToken)

      if (outcome._tag === "Succeeded") {
        return completed(Plan.DefaultOutcome, outcome.outputs, attempt)
      }

      const retryable = outcome._tag === "TimedOut" ||
        Policy.isRetryableTag(retry, outcome.tag ?? undefined)

      if (!retryable || attempt >= retry.maxAttempts) {
        if (outcome._tag === "TimedOut") {
          return yield* Effect.fail(
            new NodeTimedOut({
              nodeId: node.node.id,
              kind: "attempt",
              millis: node.policy.timeouts?.attemptMillis ?? 0
            })
          )
        }
        if (node.errorOutcome && errorRouted(node)) {
          return completed(Plan.ErrorOutcome, { [Plan.ErrorOutcome]: outcome.error }, attempt)
        }
        return yield* Effect.fail(
          new NodeFailed({ nodeId: node.node.id, attempts: attempt, error: outcome.error })
        )
      }

      const delay = Policy.delayMillis(retry, attempt)
      if (delay > 0) {
        yield* DurableClock.sleep({
          name: durableName("retry", node.node.id, attempt),
          duration: Duration.millis(delay)
        })
      }
      if (totalMillis !== undefined) {
        const now = yield* observeMillis(
          durableName("node", node.node.id, "time", attempt + 1)
        )
        if (now - startedAt > totalMillis) {
          return yield* Effect.fail(
            new NodeTimedOut({ nodeId: node.node.id, kind: "total", millis: totalMillis })
          )
        }
      }
      attempt++
    }
  })

// ----------------------------------------------------------------------------
// Saga compensation
// ----------------------------------------------------------------------------

const compensationActivity = (
  context: RunContext,
  node: Compiler.CompiledNode,
  settlement: Extract<Settlement, { _tag: "Completed" }>
): Effect.Effect<void, never, any> =>
  Activity.make({
    name: durableName("compensate", node.node.id),
    execute: Effect.gen(function*() {
      const entry = context.handlers.get(node.node.type, node.node.version)
      const compensation = node.definition.compensation
      if (entry === undefined || compensation === undefined) {
        return
      }
      const config = yield* decodeConfig(node)
      const resolved = yield* resolveInputs(context, node)
      const inputs = resolved._tag === "Resolved" ? resolved.inputs : {}
      const outputs: Record<string, unknown> = {}
      for (const portName of Object.keys(node.definition.outputs)) {
        const encoded = settlement.outputs[portName]
        if (encoded !== undefined) {
          outputs[portName] = yield* decodePortValue(
            node.node.id,
            portName,
            node.definition.outputs[portName]!.schema,
            encoded
          )
        }
      }
      const idempotencyKey = yield* Activity.idempotencyKey(durableName("compensate", node.node.id))
      const request = {
        config,
        inputs,
        outputs,
        context: {
          scope: {
            _tag: "Durable" as const,
            tenantId: context.tenantId,
            handlerDeploymentId: `${context.definition.id}@${context.definition.version}`
          },
          runId: context.executionId,
          planId: context.payload.planId,
          planRevision: context.payload.revision,
          nodeId: node.node.id,
          nodeInstanceId: durableName(context.executionId, node.node.id),
          attempt: 1,
          idempotencyKey
        }
      }
      yield* (compensation(request as never) as Effect.Effect<void, never, any>).pipe(
        Effect.updateContext((current) => Context.merge(entry.context as Context.Context<any>, current))
      )
    }).pipe(Effect.orDie)
  }) as Effect.Effect<void, never, any>

/**
 * Arms a completed node's declared compensation on the run's own saga stack.
 *
 * **Details**
 *
 * Compensations run as durable activities, in reverse arming order, inside
 * the run's failure path — before the failed or cancelled result becomes
 * observable — and never when a business failure was routed through a wired
 * `error` outcome, which is a handled path. Nodes without a declared
 * compensation simply have nothing to unwind.
 */
const armCompensation = (
  context: RunContext,
  node: Compiler.CompiledNode,
  settlement: Settlement
): void => {
  if (
    settlement._tag === "Completed" &&
    settlement.outcome !== Plan.ErrorOutcome &&
    node.definition.compensation !== undefined
  ) {
    context.compensations.push({ node, settlement })
  }
}

const runCompensations = (context: RunContext): Effect.Effect<void, never, any> =>
  Effect.gen(function*() {
    for (let index = context.compensations.length - 1; index >= 0; index--) {
      const armed = context.compensations[index]!
      yield* compensationActivity(context, armed.node, armed.settlement)
      yield* emit(context, {
        _tag: "CompensationRun",
        runId: context.executionId,
        planId: context.payload.planId,
        nodeId: armed.node.node.id
      })
    }
  })

// ----------------------------------------------------------------------------
// Externally completed nodes
// ----------------------------------------------------------------------------

/**
 * The durable deferred carrying an external node's decision.
 *
 * @category decisions
 * @since 4.0.0
 */
export const decisionDeferred = (
  nodeId: string
): DurableDeferred.DurableDeferred<typeof Plan.Decision> =>
  DurableDeferred.make(durableName("decision", nodeId), { success: Plan.Decision })

const scheduleExpiry = (
  deferred: DurableDeferred.DurableDeferred<typeof Plan.Decision>,
  token: DurableDeferred.Token,
  nodeId: string,
  wakeUpMillis: number
): Effect.Effect<void, never, Durable> =>
  DurableClock.schedule(deferred, {
    token,
    scheduleId: durableName("decision", nodeId, "deadline"),
    wakeUp: DateTime.makeUnsafe(wakeUpMillis),
    value: { outcome: Plan.ExpiredOutcome, output: null }
  }) as Effect.Effect<void, never, Durable>

const awaitDecision = (
  context: RunContext,
  node: Compiler.CompiledNode,
  deferred: DurableDeferred.DurableDeferred<typeof Plan.Decision>
): Effect.Effect<Plan.Decision, EngineFault, any> =>
  Effect.gen(function*() {
    const decision = yield* DurableDeferred.await(deferred)
    if (!node.outcomes.includes(decision.outcome)) {
      return yield* Effect.fail(fault(
        node.node.id,
        "decision",
        `Node decided with unknown outcome '${decision.outcome}'`
      ))
    }
    yield* emit(context, {
      _tag: "DecisionRecorded",
      runId: context.executionId,
      planId: context.payload.planId,
      nodeId: node.node.id,
      outcome: decision.outcome
    })
    return decision
  })

/**
 * Runs an externally completed application node: the handler registers the
 * decision token with the outside world (under the normal retry policy), the
 * optional deadline is armed idempotently, and the node's settlement is the
 * first-wins decision, exposed on the reserved `decision` output.
 */
const runExternalNode = (
  context: RunContext,
  node: Compiler.CompiledNode,
  inputs: Record<string, unknown>
): Effect.Effect<Settlement, RunFailure, any> =>
  Effect.gen(function*() {
    const deferred = decisionDeferred(node.node.id)
    const token = yield* DurableDeferred.token(deferred)

    const registration = yield* runApplicationNode(context, node, inputs, token)
    if (registration._tag === "Completed" && registration.outcome === Plan.ErrorOutcome) {
      return registration
    }

    const config = yield* decodeConfig(node)
    const deadlineMillis = node.definition.external?.deadline?.(config as never)
    if (deadlineMillis !== undefined) {
      const armedAt = yield* observeMillis(durableName("decision", node.node.id, "armed"))
      yield* scheduleExpiry(deferred, token, node.node.id, armedAt + deadlineMillis)
    }

    const decision = yield* awaitDecision(context, node, deferred)
    return completed(decision.outcome, { [Plan.DecisionOutput]: decision.output })
  })

// ----------------------------------------------------------------------------
// Built-in interpretation
// ----------------------------------------------------------------------------

const expectBoolean = (
  nodeId: string,
  phase: string,
  value: Schema.Json
): Effect.Effect<boolean, EngineFault> =>
  typeof value === "boolean"
    ? Effect.succeed(value)
    : Effect.fail(fault(nodeId, phase, "Condition must evaluate to a boolean"))

const childFailureAsBusiness = (
  node: Compiler.CompiledNode,
  failure: RunFailure
): Effect.Effect<Schema.Json, EngineFault> =>
  erase(
    Schema.encodeUnknownEffect(RunFailure)(failure).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(fault(node.node.id, "child", `Child failure could not be encoded: ${Cause.pretty(cause)}`))
      ),
      Effect.map((encoded) => encoded as Schema.Json)
    )
  )

const resolveChildPin = (
  context: RunContext,
  node: Compiler.CompiledNode,
  kind: "sub" | "forEach" | "while",
  reference: Builtins.PlanReference
): Effect.Effect<{ readonly revision: number; readonly fingerprint: string }, RunFailure, Durable> =>
  Effect.gen(function*() {
    const pin = yield* Activity.make({
      name: durableName(kind, node.node.id, "resolve"),
      success: PlanPin,
      execute: Effect.gen(function*() {
        const stored = yield* (reference.revision === undefined
          ? context.planStore.latest(reference.planId)
          : context.planStore.get(reference.planId, reference.revision)).pipe(
            Effect.option
          )
        return Option.isNone(stored)
          ? { _tag: "NotFound" as const }
          : {
            _tag: "Resolved" as const,
            revision: stored.value.revision,
            fingerprint: stored.value.fingerprint
          }
      })
    })
    if (pin._tag === "NotFound") {
      return yield* Effect.fail(fault(
        node.node.id,
        "child",
        `Referenced plan '${reference.planId}' was not found`
      ))
    }
    return { revision: pin.revision, fingerprint: pin.fingerprint }
  })

const executeChild = (
  context: RunContext,
  options: {
    readonly planId: string
    readonly revision: number
    readonly fingerprint: string
    readonly input: Schema.Json
    readonly runKey: string
  }
): Effect.Effect<Result.Result<RunSuccess, RunFailure>, never, any> =>
  Run.execute({
    planId: options.planId,
    revision: options.revision,
    fingerprint: options.fingerprint,
    input: options.input,
    runKey: options.runKey,
    depth: context.payload.depth + 1
  }).pipe(Effect.result) as Effect.Effect<Result.Result<RunSuccess, RunFailure>, never, any>

const settleChildResult = (
  node: Compiler.CompiledNode,
  result: Result.Result<RunSuccess, RunFailure>,
  onSuccess: (success: RunSuccess) => Settlement
): Effect.Effect<Settlement, RunFailure> =>
  Effect.gen(function*() {
    if (Result.isSuccess(result)) {
      return onSuccess(result.success)
    }
    const encoded = yield* childFailureAsBusiness(node, result.failure)
    if (node.errorOutcome && errorRouted(node)) {
      return completed(Plan.ErrorOutcome, { [Plan.ErrorOutcome]: encoded })
    }
    return yield* Effect.fail(
      new NodeFailed({ nodeId: node.node.id, attempts: 1, error: encoded })
    )
  })

const runBuiltin = (
  context: RunContext,
  node: Compiler.CompiledNode,
  builtin: Builtins.Builtin
): Effect.Effect<Settlement, RunFailure, any> =>
  Effect.gen(function*() {
    const nodeId = node.node.id
    const config = (yield* decodeConfig(node)) as never

    switch (builtin) {
      case "if": {
        const { condition } = config as { condition: Expression.Expression }
        const value = yield* evaluateExpression(context, nodeId, "condition", condition)
        const selected = yield* expectBoolean(nodeId, "condition", value)
        return completed(selected ? "true" : "false", {})
      }

      case "switch": {
        const { cases } = config as {
          cases: ReadonlyArray<{ name: string; condition: Expression.Expression }>
        }
        for (const entry of cases) {
          const value = yield* evaluateExpression(context, nodeId, "condition", entry.condition)
          const selected = yield* expectBoolean(nodeId, "condition", value)
          if (selected) {
            return completed(entry.name, {})
          }
        }
        return completed("default", {})
      }

      case "transform": {
        const { value } = config as { value: Expression.Expression }
        const output = yield* evaluateExpression(context, nodeId, "transform", value)
        return completed(Plan.DefaultOutcome, { value: output })
      }

      case "fail": {
        const { code, message } = config as {
          code: string
          message?: string | Expression.Expression
        }
        const text = message === undefined
          ? code
          : typeof message === "string"
          ? message
          : yield* evaluateExpression(context, nodeId, "message", message).pipe(
            Effect.flatMap((value) =>
              typeof value === "string"
                ? Effect.succeed(value)
                : Effect.fail(fault(nodeId, "message", "Fail message must evaluate to a string"))
            )
          )
        return yield* Effect.fail(new RunAborted({ nodeId, code, message: text }))
      }

      case "delay": {
        const { durationMillis } = config as {
          durationMillis: number | Expression.Expression
        }
        const millis = typeof durationMillis === "number"
          ? durationMillis
          : yield* evaluateExpression(context, nodeId, "duration", durationMillis).pipe(
            Effect.flatMap((value) =>
              typeof value === "number" && Number.isInteger(value) && value > 0
                ? Effect.succeed(value)
                : Effect.fail(fault(nodeId, "duration", "Delay duration must evaluate to a positive integer"))
            )
          )
        yield* DurableClock.sleep({
          name: durableName("delay", nodeId),
          duration: Duration.millis(millis)
        })
        return completed(Plan.DefaultOutcome, {})
      }

      case "waitUntil": {
        const { atMillis } = config as { atMillis: number | Expression.Expression }
        const millis = typeof atMillis === "number"
          ? atMillis
          : yield* evaluateExpression(context, nodeId, "deadline", atMillis).pipe(
            Effect.flatMap((value) =>
              typeof value === "number" && Number.isInteger(value) && value > 0
                ? Effect.succeed(value)
                : Effect.fail(fault(nodeId, "deadline", "Deadline must evaluate to positive epoch milliseconds"))
            )
          )
        const deferred = DurableDeferred.make(durableName("waitUntil", nodeId), {
          success: Schema.Json
        })
        const token = yield* DurableDeferred.token(deferred)
        yield* DurableClock.schedule(deferred, {
          token,
          scheduleId: durableName("waitUntil", nodeId, "at"),
          wakeUp: DateTime.makeUnsafe(millis),
          value: null
        })
        yield* DurableDeferred.await(deferred)
        return completed(Plan.DefaultOutcome, {})
      }

      case "while": {
        const cfg = config as {
          condition: Expression.Expression
          plan: Builtins.PlanReference
          input?: Expression.Expression
          maxIterations: number
        }
        const pin = yield* resolveChildPin(context, node, "while", cfg.plan)
        let iteration = 0
        let previous: Schema.Json = null
        while (true) {
          const extra = { iteration, previous }
          const proceed = yield* evaluateExpression(context, nodeId, "condition", cfg.condition, extra)
            .pipe(Effect.flatMap((value) => expectBoolean(nodeId, "condition", value)))
          if (!proceed) {
            break
          }
          if (iteration >= cfg.maxIterations) {
            return yield* Effect.fail(fault(
              nodeId,
              "loop",
              `Loop exceeded its maxIterations bound of ${cfg.maxIterations}`
            ))
          }
          const input = cfg.input === undefined
            ? extra
            : yield* evaluateExpression(context, nodeId, "iteration-input", cfg.input, extra)
          const result = yield* executeChild(context, {
            planId: cfg.plan.planId,
            revision: pin.revision,
            fingerprint: pin.fingerprint,
            input,
            runKey: durableName(context.executionId, nodeId, "iter", iteration)
          })
          if (Result.isFailure(result)) {
            return yield* settleChildResult(node, result, () => skipped)
          }
          previous = result.success.outputs as Schema.Json
          iteration++
        }
        return completed(Plan.DefaultOutcome, { iterations: iteration, last: previous })
      }

      case "receive": {
        const { signal } = config as { signal: string }
        const payload = yield* DurableDeferred.await(signalDeferred(signal))
        return completed(Plan.DefaultOutcome, { payload })
      }

      case "humanTask": {
        const cfg = config as {
          title: string
          description?: string
          outcomes: ReadonlyArray<string>
          form?: Schema.Json
          payload?: Expression.Expression
          assignee?: Expression.Expression
          candidateGroups?: Expression.Expression
          dueInMillis?: number
        }
        const payloadValue = cfg.payload === undefined
          ? undefined
          : yield* evaluateExpression(context, nodeId, "payload", cfg.payload)
        const assignee = cfg.assignee === undefined
          ? undefined
          : yield* evaluateExpression(context, nodeId, "assignee", cfg.assignee).pipe(
            Effect.flatMap((value) =>
              typeof value === "string"
                ? Effect.succeed(value)
                : Effect.fail(fault(nodeId, "assignee", "Assignee must evaluate to a string"))
            )
          )
        const candidateGroups = cfg.candidateGroups === undefined
          ? []
          : yield* evaluateExpression(context, nodeId, "candidateGroups", cfg.candidateGroups).pipe(
            Effect.flatMap((value) =>
              Array.isArray(value) && value.every((group) => typeof group === "string")
                ? Effect.succeed(value as ReadonlyArray<string>)
                : Effect.fail(
                  fault(nodeId, "candidateGroups", "Candidate groups must evaluate to an array of strings")
                )
            )
          )

        // The human task is a profile of the external-decision primitive:
        // registration creates the work item, the decision resolves the same
        // deferred every external node uses, and expiry races it first-wins.
        const deferred = decisionDeferred(nodeId)
        const token = yield* DurableDeferred.token(deferred)
        const handle = yield* Activity.make({
          name: durableName("task", nodeId, "create"),
          success: TaskHandle,
          execute: Effect.gen(function*() {
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            const dueAtMillis = cfg.dueInMillis === undefined ? null : now + cfg.dueInMillis
            const task = yield* context.humanTasks.create({
              taskId: durableName(context.executionId, nodeId),
              runId: context.executionId,
              planId: context.payload.planId,
              nodeId,
              title: cfg.title,
              description: cfg.description,
              outcomes: node.outcomes,
              form: cfg.form,
              payload: payloadValue,
              assignee,
              candidateGroups,
              dueAtMillis: dueAtMillis ?? undefined,
              token
            })
            return { taskId: task.taskId, dueAtMillis }
          })
        })
        yield* emit(context, {
          _tag: "TaskCreated",
          runId: context.executionId,
          planId: context.payload.planId,
          nodeId,
          taskId: handle.taskId
        })
        if (handle.dueAtMillis !== null) {
          yield* scheduleExpiry(deferred, token, nodeId, handle.dueAtMillis)
        }
        const decision = yield* awaitDecision(context, node, deferred)
        if (decision.outcome === Plan.ExpiredOutcome && cfg.dueInMillis !== undefined) {
          yield* Activity.make({
            name: durableName("task", nodeId, "expired"),
            execute: context.humanTasks.expire(handle.taskId).pipe(Effect.ignore)
          })
        }
        return completed(decision.outcome, { output: decision.output })
      }

      case "subWorkflow": {
        const cfg = config as {
          plan: Builtins.PlanReference
          input?: Expression.Expression
        }
        const pin = yield* resolveChildPin(context, node, "sub", cfg.plan)
        const input = cfg.input === undefined
          ? {}
          : yield* evaluateExpression(context, nodeId, "child-input", cfg.input)
        const result = yield* executeChild(context, {
          planId: cfg.plan.planId,
          revision: pin.revision,
          fingerprint: pin.fingerprint,
          input,
          runKey: durableName(context.executionId, nodeId)
        })
        return yield* settleChildResult(node, result, (success) =>
          completed(Plan.DefaultOutcome, { output: success.outputs as Schema.Json }))
      }

      case "forEach": {
        const cfg = config as {
          items: Expression.Expression
          plan: Builtins.PlanReference
          mode?: "sequential" | "parallel"
          concurrency?: number
          input?: Expression.Expression
        }
        const items = yield* evaluateExpression(context, nodeId, "items", cfg.items)
        if (!Array.isArray(items)) {
          return yield* Effect.fail(fault(nodeId, "items", "For-each items must evaluate to an array"))
        }
        if (items.length > MaxItems) {
          return yield* Effect.fail(fault(
            nodeId,
            "items",
            `For-each expanded to ${items.length} items, exceeding the limit of ${MaxItems}`
          ))
        }
        const pin = yield* resolveChildPin(context, node, "forEach", cfg.plan)
        const concurrency = cfg.mode === "parallel" ? cfg.concurrency ?? "unbounded" : 1

        const results = yield* Effect.forEach(
          items.map((item, index) =>
            [item, index] as const
          ),
          ([item, index]) =>
            Effect.gen(function*() {
              const input = cfg.input === undefined
                ? { item, index }
                : yield* evaluateExpression(context, nodeId, "item-input", cfg.input, { item, index })
              return yield* executeChild(context, {
                planId: cfg.plan.planId,
                revision: pin.revision,
                fingerprint: pin.fingerprint,
                input,
                runKey: durableName(context.executionId, nodeId, "item", index)
              })
            }),
          { concurrency }
        )

        const failure = results.find(Result.isFailure)
        if (failure !== undefined) {
          return yield* settleChildResult(node, failure, () => skipped)
        }
        const outputs = results.map((result) => (result as Result.Success<RunSuccess, RunFailure>).success.outputs)
        return completed(Plan.DefaultOutcome, { results: outputs as unknown as Schema.Json })
      }
    }
  })

// ----------------------------------------------------------------------------
// Run interpretation
// ----------------------------------------------------------------------------

const runNode = (
  context: RunContext,
  nodeId: string
): Effect.Effect<void, RunFailure, any> =>
  Effect.gen(function*() {
    const node = context.compiled.nodes.get(nodeId)!
    const eligibility = yield* awaitEligibility(context, node)
    if (eligibility === "skip") {
      return yield* settle(context, nodeId, skipped)
    }

    if (node.builtin !== undefined) {
      const settlement = yield* runBuiltin(context, node, node.builtin)
      return yield* settle(context, nodeId, settlement)
    }

    const resolved = yield* resolveInputs(context, node)
    if (resolved._tag === "DeadPath") {
      return yield* settle(context, nodeId, skipped)
    }
    const settlement = node.definition.external !== undefined
      ? yield* runExternalNode(context, node, resolved.inputs)
      : yield* runApplicationNode(context, node, resolved.inputs)
    armCompensation(context, node, settlement)
    yield* settle(context, nodeId, settlement)
  })

const collectOutputs = (
  context: RunContext
): Effect.Effect<Record<string, Schema.Json>, EngineFault> =>
  Effect.gen(function*() {
    const outputs: Record<string, Schema.Json> = {}
    for (const [name, port] of context.compiled.boundary.outputs) {
      const edges = context.compiled.dataEdges.filter((edge) =>
        edge.target.kind === "WorkflowOutput" && edge.target.port === name
      )
      const live: Array<Schema.Json> = []
      for (const edge of edges) {
        const value = yield* liveEdgeValue(context, "", edge)
        if (Option.isSome(value)) {
          live.push(value.value)
        }
      }
      if (port.cardinality === "many") {
        for (const value of live) {
          yield* decodePortValue("", name, port.schema, value).pipe(
            Effect.mapError((error) => fault(undefined, "workflow-output", error.message))
          )
        }
        outputs[name] = live
        continue
      }
      if (live.length === 0) {
        continue
      }
      yield* decodePortValue("", name, port.schema, live[0]!).pipe(
        Effect.mapError((error) => fault(undefined, "workflow-output", error.message))
      )
      outputs[name] = live[0]!
    }
    return outputs
  })

const interpret = (
  definition: Workflow.Any,
  options: Options | undefined,
  payload: RunPayload,
  executionId: string
): Effect.Effect<RunSuccess, RunFailure, any> =>
  Effect.gen(function*() {
    if (payload.depth > MaxDepth) {
      return yield* Effect.fail(
        new PlanRejected({
          planId: payload.planId,
          revision: payload.revision,
          message: `Run nesting exceeds the depth limit of ${MaxDepth}`
        })
      )
    }
    const planStore = yield* PlanStore.PlanStore
    const handlers = yield* Registry.HandlerRegistry
    const humanTasks = yield* HumanTasks.HumanTasks
    const journal = yield* RunJournal.RunJournal

    const stored = yield* planStore.get(payload.planId, payload.revision).pipe(
      Effect.mapError((error) =>
        new PlanRejected({
          planId: payload.planId,
          revision: payload.revision,
          message: error.message
        })
      )
    )
    if (stored.fingerprint !== payload.fingerprint) {
      return yield* Effect.fail(
        new PlanRejected({
          planId: payload.planId,
          revision: payload.revision,
          message: `Stored fingerprint '${stored.fingerprint}' does not match the pinned '${payload.fingerprint}'`
        })
      )
    }
    const compiled = yield* Compiler.compile(definition, stored.plan).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new PlanRejected({
            planId: payload.planId,
            revision: payload.revision,
            message: `Plan no longer compiles against the current vocabulary: ${Cause.pretty(cause)}`
          })
        )
      )
    )

    // Validate the run input against the resolved boundary, whichever side —
    // definition code or the plan itself — declared it.
    if (payload.input === null || typeof payload.input !== "object" || Array.isArray(payload.input)) {
      return yield* Effect.fail(fault(undefined, "input", "Run input must be a JSON object"))
    }
    const input = payload.input as Schema.JsonObject
    for (const [name, entry] of compiled.boundary.inputs) {
      if (!Object.prototype.hasOwnProperty.call(input, name)) {
        if (entry.required) {
          return yield* Effect.fail(fault(undefined, "input", `Missing workflow input '${name}'`))
        }
        continue
      }
      yield* erase(Schema.decodeUnknownEffect(entry.port.schema)(input[name])).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(fault(undefined, "input", `Workflow input '${name}': ${Cause.pretty(cause)}`))
        )
      )
    }

    const context: RunContext = {
      definition,
      compiled,
      payload,
      executionId,
      tenantId: options?.tenantId ?? "default",
      handlers,
      humanTasks,
      planStore,
      journal,
      input,
      settlements: new Map(),
      latches: new Map(),
      values: new Map(),
      nodesScope: {},
      compensations: []
    }
    for (const name of Object.keys(input)) {
      context.values.set(durableName("WorkflowInput", name), input[name]!)
    }
    for (const nodeId of compiled.topologicalOrder) {
      context.latches.set(nodeId, yield* Deferred.make<Settlement>())
    }

    yield* emit(context, {
      _tag: "RunStarted",
      runId: executionId,
      planId: payload.planId,
      revision: payload.revision,
      fingerprint: payload.fingerprint
    })

    // Cancel outstanding human work when the run ends for any reason other
    // than successful completion of every waiting node.
    yield* DurableWorkflow.addFinalizer(() => humanTasks.cancelByRun(executionId).pipe(Effect.ignore))

    // The saga boundary: when interpretation fails or the run is cancelled,
    // armed compensations unwind — durably, in reverse order — before the
    // terminal result becomes observable. A failure routed through a wired
    // `error` outcome never reaches this path.
    yield* Effect.all(
      compiled.topologicalOrder.map((nodeId) => runNode(context, nodeId)),
      { concurrency: "unbounded", discard: true }
    ).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success" || context.compensations.length === 0
          ? Effect.void
          : Effect.uninterruptible(runCompensations(context))
      )
    )

    const outputs = yield* collectOutputs(context)
    return { outputs }
  })

/**
 * Registers the engine's generic native workflow for a vocabulary.
 *
 * **Details**
 *
 * The returned layer requires the native `WorkflowEngine` (memory for tests,
 * cluster for production), the vocabulary's `HandlerRegistry`, a `PlanStore`,
 * and `HumanTasks`. Handler-specific services travel inside the handler
 * registry's captured context, so they never leak into the engine's own
 * requirements.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <W extends Workflow.Any>(
  definition: W,
  options?: Options
): Layer.Layer<
  never,
  never,
  | DurableWorkflow.RequirementsHandler<typeof Run>
  | PlanStore.PlanStore
  | Registry.HandlerRegistry
  | HumanTasks.HumanTasks
> =>
  Run.toLayer((payload, executionId) =>
    Effect.gen(function*() {
      const journal = yield* RunJournal.RunJournal
      const instance = yield* WorkflowEngine.WorkflowInstance
      const record = (entry: RunJournal.EntryInput) => journal.record(entry).pipe(Effect.catchCause(() => Effect.void))
      return yield* interpret(definition, options, payload, executionId).pipe(
        Effect.onExit((exit) => {
          if (exit._tag === "Success") {
            return record({ _tag: "RunSucceeded", runId: executionId, planId: payload.planId })
          }
          const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
          if (failure !== undefined) {
            return Schema.encodeUnknownEffect(RunFailure)((failure as { error: RunFailure }).error).pipe(
              Effect.orElseSucceed((): unknown => null),
              Effect.flatMap((encoded) =>
                record({
                  _tag: "RunFailed",
                  runId: executionId,
                  planId: payload.planId,
                  failure: encoded as Schema.Json
                })
              )
            )
          }
          if (instance.interrupted) {
            return record({ _tag: "RunCancelled", runId: executionId, planId: payload.planId })
          }
          if (instance.suspended) {
            return Effect.void
          }
          return record({
            _tag: "RunFailed",
            runId: executionId,
            planId: payload.planId,
            failure: { defect: Cause.pretty(exit.cause) }
          })
        })
      )
    })
  ) as any
