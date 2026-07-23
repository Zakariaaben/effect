/**
 * Executes compiled workflow plans directly in the current Effect runtime.
 *
 * This interpreter is intentionally non-durable. Durable execution is exposed
 * by separate, explicit adapters so choosing a local Effect interpreter never
 * silently implies persistence or replay semantics.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Command from "./Command.ts"
import * as Compiler from "./Compiler.ts"
import * as Json from "./internal/json.ts"
import type * as Node from "./Node.ts"
import * as Registry from "./Registry.ts"
import type * as Workflow from "./Workflow.ts"

/**
 * Execution phase associated with an engine-level validation failure.
 *
 * @category models
 * @since 4.0.0
 */
export type Phase =
  | "input"
  | "node-input"
  | "handler"
  | "node-output"
  | "failure"
  | "workflow-output"
  | "configuration"

/**
 * Raised when the interpreter itself cannot safely execute or route a value.
 *
 * **Details**
 *
 * User-declared node failures remain in their original typed error channel and
 * are not collapsed into this error.
 *
 * @category errors
 * @since 4.0.0
 */
export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>(
  "@effect/workflow-builder/Interpreter/ExecutionError"
)("ExecutionError", {
  runId: Schema.String,
  nodeId: Schema.optionalKey(Schema.String),
  phase: Schema.Literals([
    "input",
    "node-input",
    "handler",
    "node-output",
    "failure",
    "workflow-output",
    "configuration"
  ]),
  message: Schema.String,
  details: Schema.optionalKey(Schema.Json)
}) {}

/**
 * Direct-interpreter concurrency setting.
 *
 * @category configuration
 * @since 4.0.0
 */
export type Concurrency = number | "unbounded"

/**
 * Explicit options for one non-durable execution.
 *
 * @category configuration
 * @since 4.0.0
 */
export interface ExecuteOptions {
  readonly runId: string
  readonly concurrency: Concurrency
}

type DefinitionsOf<W extends Workflow.Any> = Registry.Definitions<Workflow.Nodes<W>>
type NodeOf<W extends Workflow.Any> = DefinitionsOf<W>[keyof DefinitionsOf<W>]

/**
 * Typed failures declared by any node available to a workflow definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Failure<W extends Workflow.Any> = Node.Failure<NodeOf<W>>

/**
 * Effect services required by a direct plan execution.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> =
  | Registry.HandlerRegistry
  | Workflow.InputEncodingServices<W>
  | Workflow.OutputDecodingServices<W>
  | Node.ConfigDecodingServices<NodeOf<W>>
  | Node.InputDecodingServices<NodeOf<W>>
  | Node.OutputEncodingServices<NodeOf<W>>
  | Node.FailureEncodingServices<NodeOf<W>>
  | Node.Requirements<NodeOf<W>>

const makeError = (
  runId: string,
  phase: Phase,
  message: string,
  nodeId?: string,
  details?: Schema.Json
): ExecutionError =>
  new ExecutionError({
    runId,
    phase,
    message,
    ...(nodeId === undefined ? undefined : { nodeId }),
    ...(details === undefined ? undefined : { details })
  })

const storageKey = (...segments: ReadonlyArray<string>): string => JSON.stringify(segments)

const sourceStorageKey = (source: Compiler.CompiledDataEdge["source"]): string =>
  source.kind === "WorkflowInput"
    ? storageKey("WorkflowInput", source.port)
    : storageKey("NodeOutput", source.nodeId, source.port)

const targetStorageKey = (target: Compiler.CompiledDataEdge["target"]): string =>
  target.kind === "WorkflowOutput"
    ? storageKey("WorkflowOutput", target.port)
    : storageKey("NodeInput", target.nodeId, target.port)

const sorted = (
  edges: ReadonlyArray<Compiler.CompiledDataEdge>
): ReadonlyArray<Compiler.CompiledDataEdge> =>
  edges.length < 2 ? edges : [...edges].sort((left, right) => left.edge.order! - right.edge.order!)

interface CapturedProperty {
  readonly key: PropertyKey
  readonly descriptor: PropertyDescriptor
}

const captureRecordProperties = Effect.fnUntraced(function*(
  value: unknown,
  runId: string,
  phase: "input" | "node-output",
  label: string,
  nodeId?: string
) {
  if (typeof value !== "object" || value === null) {
    return yield* Effect.fail(makeError(runId, phase, `${label} must be an object`, nodeId))
  }
  const captured = yield* Effect.try({
    try: () => {
      const prototype = Object.getPrototypeOf(value)
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const properties: Array<CapturedProperty> = Reflect.ownKeys(descriptors).map((key) => ({
        key,
        descriptor: Reflect.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor
      }))
      return { prototype, properties } as const
    },
    catch: () => makeError(runId, phase, `${label} could not be inspected safely`, nodeId)
  })
  if (captured.prototype !== Object.prototype && captured.prototype !== null) {
    return yield* Effect.fail(makeError(
      runId,
      phase,
      `${label} must be an object with Object.prototype or null as its prototype`,
      nodeId
    ))
  }
  return captured.properties
})

const isEnumerableDataProperty = (descriptor: PropertyDescriptor): boolean =>
  descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value")

const snapshotEncoded = (
  value: unknown,
  runId: string,
  phase: "input" | "node-output" | "failure",
  label: string,
  nodeId?: string,
  details?: Schema.Json
): Effect.Effect<Schema.Json, ExecutionError> => {
  const snapped = Json.snapshot(value)
  return Result.isFailure(snapped)
    ? Effect.fail(makeError(
      runId,
      phase,
      `${label} must encode to strict JSON: ${snapped.failure.message}`,
      nodeId,
      details
    ))
    : Effect.succeed(snapped.success)
}

/**
 * Executes a compiled plan directly with ordinary Effect fibers.
 *
 * **Details**
 *
 * Intermediate values are routed as detached, recursively frozen strict JSON.
 * Every workflow input and node output is encoded with its source schema,
 * snapshotted, then each destination decodes with its own schema. This both
 * validates untrusted handlers and makes the direct interpreter follow the same
 * payload boundary that semantic history uses.
 *
 * Workflow inputs and handler results must be plain or null-prototype records
 * with exactly the declared own enumerable data properties. Their property
 * descriptors are captured once, so accessors are rejected without evaluation
 * and later routing cannot observe a second property read.
 *
 * Nodes become runnable as soon as their own dependencies complete; compiled
 * stages are not global barriers. A semaphore applies the requested concurrency
 * only to runnable handlers, so nodes waiting on dependencies cannot consume
 * permits or deadlock the graph. The interpreter inherits Effect's structured
 * interruption: a failing node interrupts other in-flight and waiting nodes,
 * while completed external side effects are not rolled back.
 *
 * @category running
 * @since 4.0.0
 */
export const execute = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>,
  input: Workflow.InputValues<W>,
  options: ExecuteOptions
): Effect.fn.Return<
  Workflow.OutputValues<W>,
  ExecutionError | Failure<W>,
  Requirements<W>
> {
  if (options.runId.length === 0) {
    return yield* Effect.fail(makeError(
      options.runId,
      "configuration",
      "Direct execution requires a non-empty runId"
    ))
  }
  if (
    options.concurrency !== "unbounded" &&
    (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0)
  ) {
    return yield* Effect.fail(makeError(
      options.runId,
      "configuration",
      "Direct execution concurrency must be a positive safe integer or 'unbounded'"
    ))
  }
  if (!Compiler.isCompiled(compiled)) {
    return yield* Effect.fail(makeError(
      options.runId,
      "configuration",
      "Direct execution requires the exact result of Compiler.compile"
    ))
  }
  const definition = compiled.definition
  const values = new Map<string, Schema.Json>()
  const declaredInputNames = new Set(Object.keys(definition.inputs))
  const capturedInput = yield* captureRecordProperties(input, options.runId, "input", "Workflow input")
  const inputValues = new Map<string, unknown>()
  for (const property of capturedInput) {
    if (typeof property.key !== "string") {
      return yield* Effect.fail(makeError(
        options.runId,
        "input",
        "Workflow input must not contain symbol properties"
      ))
    }
    if (!isEnumerableDataProperty(property.descriptor)) {
      return yield* Effect.fail(makeError(
        options.runId,
        "input",
        `Workflow input '${property.key}' must be an enumerable data property`,
        undefined,
        { input: property.key }
      ))
    }
    if (!declaredInputNames.has(property.key)) {
      return yield* Effect.fail(makeError(
        options.runId,
        "input",
        `Unknown workflow input '${property.key}'`,
        undefined,
        { input: property.key }
      ))
    }
    inputValues.set(property.key, property.descriptor.value)
  }
  for (const [name, port] of Object.entries(definition.inputs)) {
    if (!inputValues.has(name)) {
      return yield* Effect.fail(makeError(
        options.runId,
        "input",
        `Workflow input is missing declared input '${name}'`,
        undefined,
        { input: name }
      ))
    }
    const encoded = yield* Schema.encodeUnknownEffect(port.schema)(inputValues.get(name)).pipe(
      Effect.mapError((error) => makeError(options.runId, "input", error.message, undefined, { input: name }))
    )
    values.set(
      storageKey("WorkflowInput", name),
      yield* snapshotEncoded(encoded, options.runId, "input", `Workflow input '${name}'`, undefined, { input: name })
    )
  }

  const handlers = yield* Registry.HandlerRegistry
  const executionContext = yield* Effect.context<never>()

  const readEdge = Effect.fnUntraced(function*(
    edge: Compiler.CompiledDataEdge,
    targetSchema: Schema.Top,
    phase: "node-input" | "workflow-output",
    nodeId?: string
  ) {
    const key = sourceStorageKey(edge.source)
    if (!values.has(key)) {
      return yield* Effect.fail(makeError(
        options.runId,
        phase,
        `Compiled source value '${key}' is unavailable`,
        nodeId,
        { edgeId: edge.edge.id }
      ))
    }
    return yield* Schema.decodeUnknownEffect(targetSchema)(values.get(key)).pipe(
      Effect.mapError((error) => makeError(options.runId, phase, error.message, nodeId, { edgeId: edge.edge.id }))
    )
  })

  const runNode = Effect.fnUntraced(function*(nodeId: string) {
    const compiledNode = compiled.nodes.get(nodeId)!
    const entry = handlers.get(compiledNode.definition.type, compiledNode.definition.version)
    if (
      entry === undefined ||
      entry.definition !== compiledNode.definition ||
      typeof entry.handler !== "function"
    ) {
      return yield* Effect.fail(makeError(
        options.runId,
        "handler",
        `No exact handler is installed for '${compiledNode.definition.type}@${compiledNode.definition.version}'`,
        nodeId
      ))
    }

    const config = yield* Schema.decodeUnknownEffect(compiledNode.definition.configSchema, {
      errors: "all",
      onExcessProperty: "error"
    })(compiledNode.node.config).pipe(
      Effect.mapError((error) =>
        makeError(
          options.runId,
          "configuration",
          `Pinned node configuration could not be decoded: ${error.message}`,
          nodeId
        )
      )
    )

    const decodedInputEntries: Array<readonly [string, unknown]> = []
    for (const [name, port] of Object.entries(compiledNode.definition.inputs)) {
      const edges = sorted(
        compiledNode.incoming.filter((edge) => edge.target.kind === "NodeInput" && edge.target.port === name)
      )
      const decoded = yield* Effect.forEach(
        edges,
        (edge) => readEdge(edge, port.schema, "node-input", nodeId),
        { concurrency: 1 }
      )
      decodedInputEntries.push([
        name,
        port.cardinality === "many"
          ? decoded
          : port.required
          ? decoded[0]
          : edges.length === 0
          ? Option.none()
          : Option.some(decoded[0])
      ])
    }
    const decodedInputs = Object.fromEntries(decodedInputEntries)

    const handlerEffectUnknown = yield* Effect.try({
      try: () =>
        entry.handler({
          config,
          inputs: decodedInputs,
          context: {
            scope: Object.freeze({ _tag: "Direct" as const }),
            runId: options.runId,
            planId: compiled.plan.id,
            planRevision: compiled.plan.revision,
            nodeId,
            nodeInstanceId: Command.staticNodeInstanceId(nodeId),
            attempt: 1,
            idempotencyKey: Command.activityIdempotencyKey(options.runId, nodeId)
          }
        }) as unknown,
      catch: () =>
        makeError(
          options.runId,
          "handler",
          "Node handler threw before returning an Effect",
          nodeId
        )
    })
    if (!Effect.isEffect(handlerEffectUnknown)) {
      return yield* Effect.fail(makeError(
        options.runId,
        "handler",
        "Node handler did not return an Effect",
        nodeId
      ))
    }
    const handlerEffect = handlerEffectUnknown as Effect.Effect<
      Record<string, unknown>,
      Failure<W>,
      Requirements<W>
    >
    const handled = yield* Effect.result(handlerEffect.pipe(
      Effect.updateContext((current) =>
        Context.merge(entry.context, Context.merge(executionContext, current)) as Context.Context<any>
      )
    ))
    if (Result.isFailure(handled)) {
      const encodedFailure = yield* Effect.result(
        Schema.encodeUnknownEffect(compiledNode.definition.failureSchema)(handled.failure)
      )
      if (Result.isFailure(encodedFailure)) {
        return yield* Effect.fail(makeError(
          options.runId,
          "failure",
          `Handler returned an invalid typed failure: ${encodedFailure.failure.message}`,
          nodeId
        ))
      }
      yield* snapshotEncoded(
        encodedFailure.success,
        options.runId,
        "failure",
        "Handler failure",
        nodeId
      )
      return yield* Effect.fail(handled.failure)
    }
    const declaredOutputs = new Set(Object.keys(compiledNode.definition.outputs))
    const capturedOutput = yield* captureRecordProperties(
      handled.success,
      options.runId,
      "node-output",
      "Node handler output",
      nodeId
    )
    const outputValues = new Map<string, unknown>()
    for (const property of capturedOutput) {
      if (typeof property.key !== "string") {
        return yield* Effect.fail(makeError(
          options.runId,
          "node-output",
          "Node handler output must not contain symbol properties",
          nodeId
        ))
      }
      if (!isEnumerableDataProperty(property.descriptor)) {
        return yield* Effect.fail(makeError(
          options.runId,
          "node-output",
          `Handler output '${property.key}' must be an enumerable data property`,
          nodeId,
          { output: property.key }
        ))
      }
      if (!declaredOutputs.has(property.key)) {
        return yield* Effect.fail(makeError(
          options.runId,
          "node-output",
          `Handler returned unknown output '${property.key}'`,
          nodeId,
          { output: property.key }
        ))
      }
      outputValues.set(property.key, property.descriptor.value)
    }
    for (const [name, port] of Object.entries(compiledNode.definition.outputs)) {
      if (!outputValues.has(name)) {
        return yield* Effect.fail(makeError(
          options.runId,
          "node-output",
          `Handler did not return required output '${name}'`,
          nodeId,
          { output: name }
        ))
      }
      const encoded = yield* Schema.encodeUnknownEffect(port.schema)(outputValues.get(name)).pipe(
        Effect.mapError((error) => makeError(options.runId, "node-output", error.message, nodeId, { output: name }))
      )
      values.set(
        storageKey("NodeOutput", nodeId, name),
        yield* snapshotEncoded(
          encoded,
          options.runId,
          "node-output",
          `Handler output '${name}'`,
          nodeId,
          { output: name }
        )
      )
    }
  })

  const completions = new Map<string, Deferred.Deferred<void>>()
  for (const nodeId of compiled.topologicalOrder) {
    completions.set(nodeId, yield* Deferred.make<void>())
  }
  const semaphore = options.concurrency === "unbounded" ? undefined : yield* Semaphore.make(options.concurrency)
  const runWhenReady = Effect.fnUntraced(function*(nodeId: string) {
    const node = compiled.nodes.get(nodeId)!
    yield* Effect.forEach(
      node.dependencies,
      (dependency) => Deferred.await(completions.get(dependency)!),
      { concurrency: "unbounded", discard: true }
    )
    yield* (semaphore === undefined ? runNode(nodeId) : semaphore.withPermit(runNode(nodeId)))
    yield* Deferred.succeed(completions.get(nodeId)!, undefined)
  })
  yield* Effect.forEach(compiled.topologicalOrder, runWhenReady, {
    concurrency: "unbounded",
    discard: true
  })

  const outputEntries: Array<readonly [string, unknown]> = []
  for (const [name, port] of Object.entries(definition.outputs)) {
    const edges = sorted(
      compiled.dataEdges.filter((edge) => targetStorageKey(edge.target) === storageKey("WorkflowOutput", name))
    )
    const decoded = yield* Effect.forEach(
      edges,
      (edge) => readEdge(edge, port.schema, "workflow-output"),
      { concurrency: 1 }
    )
    outputEntries.push([
      name,
      port.cardinality === "many"
        ? decoded
        : port.required
        ? decoded[0]
        : edges.length === 0
        ? Option.none()
        : Option.some(decoded[0])
    ])
  }
  return Object.fromEntries(outputEntries) as Workflow.OutputValues<W>
})
