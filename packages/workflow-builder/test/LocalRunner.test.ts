import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as ActivityRuntime from "../src/ActivityRuntime.ts"
import * as Command from "../src/Command.ts"
import * as CommandEvent from "../src/CommandEvent.ts"
import * as CommandRuntime from "../src/CommandRuntime.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import type * as Event from "../src/Event.ts"
import * as HistoryStore from "../src/HistoryStore.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as LocalRunner from "../src/LocalRunner.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunStart from "../src/RunStart.ts"
import * as RunState from "../src/RunState.ts"
import * as Workflow from "../src/Workflow.ts"

const limits = new Workflow.Limits({
  maxNodes: 16,
  maxEdges: 32,
  maxFanIn: 8,
  maxFanOut: 8,
  maxDepth: 8
})

const textContract = "local-runner/text"
const domainFailure = Schema.Struct({
  _tag: Schema.Literal("DomainFailure"),
  reason: Schema.String
})

const task = Node.make("Task", {
  version: "1.0.0",
  config: Schema.Struct({
    label: Schema.String,
    fail: Schema.Boolean
  }),
  inputs: {
    value: Port.input(Schema.String, { contract: textContract })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: textContract })
  },
  failure: domainFailure
})

const join = Node.make("Join", {
  version: "1.0.0",
  inputs: {
    values: Port.input(Schema.String, {
      contract: textContract,
      cardinality: "many"
    })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: textContract })
  },
  failure: domainFailure
})

const registry = Registry.make(task, join)

const definition = Workflow.make("local-runner-workflow", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(Schema.String, { contract: textContract })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const emptyDefinition = Workflow.make("local-runner-empty", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const mismatchDefinition = Workflow.make("local-runner-output-mismatch", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(Schema.Number, { contract: textContract })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

class OutputDecoder extends Context.Service<OutputDecoder, {
  readonly seen: Array<string>
}>()("@effect/workflow-builder/test/LocalRunner/OutputDecoder") {}

const ServiceDecodedOutput = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.gen(function*() {
          const decoder = yield* OutputDecoder
          decoder.seen.push(value)
          return value
        }),
      encode: Effect.succeed
    })
  )
)

const serviceOutputDefinition = Workflow.make("local-runner-output-service", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(ServiceDecodedOutput, { contract: textContract })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const workflowInput = (input: string) => ({ _tag: "WorkflowInput" as const, input })
const nodeOutput = (nodeId: string, output: string) => ({ _tag: "NodeOutput" as const, nodeId, output })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })
const workflowOutput = (output: string) => ({ _tag: "WorkflowOutput" as const, output })

const dataEdge = (
  id: string,
  source: ReturnType<typeof workflowInput> | ReturnType<typeof nodeOutput>,
  target: ReturnType<typeof nodeInput> | ReturnType<typeof workflowOutput>,
  order?: number
) => ({
  _tag: "DataEdge" as const,
  id,
  source,
  target,
  ...(order === undefined ? undefined : { order })
})

const oneNodePlan = {
  formatVersion: 1,
  id: "local-one",
  revision: 1,
  definition: { id: definition.id, version: definition.version },
  nodes: [{
    id: "only",
    type: task.type,
    version: task.version,
    config: { label: "only", fail: false }
  }],
  edges: [
    dataEdge("seed-only", workflowInput("seed"), nodeInput("only", "value")),
    dataEdge("only-result", nodeOutput("only", "value"), workflowOutput("result"))
  ]
}

const mismatchPlan = {
  ...oneNodePlan,
  id: "local-output-mismatch",
  definition: {
    id: mismatchDefinition.id,
    version: mismatchDefinition.version
  }
}

const serviceOutputPlan = {
  ...oneNodePlan,
  id: "local-output-service",
  definition: {
    id: serviceOutputDefinition.id,
    version: serviceOutputDefinition.version
  }
}

const failingPlan = {
  ...oneNodePlan,
  id: "local-failing",
  nodes: [{
    id: "only",
    type: task.type,
    version: task.version,
    config: { label: "only", fail: true }
  }]
}

const parallelPlan = {
  formatVersion: 1,
  id: "local-parallel",
  revision: 1,
  definition: { id: definition.id, version: definition.version },
  nodes: [
    {
      id: "left",
      type: task.type,
      version: task.version,
      config: { label: "left", fail: false }
    },
    {
      id: "right",
      type: task.type,
      version: task.version,
      config: { label: "right", fail: false }
    },
    { id: "join", type: join.type, version: join.version, config: {} }
  ],
  edges: [
    dataEdge("seed-left", workflowInput("seed"), nodeInput("left", "value")),
    dataEdge("seed-right", workflowInput("seed"), nodeInput("right", "value")),
    dataEdge("right-join", nodeOutput("right", "value"), nodeInput("join", "values"), 0),
    dataEdge("left-join", nodeOutput("left", "value"), nodeInput("join", "values"), 1),
    dataEdge("join-result", nodeOutput("join", "value"), workflowOutput("result"))
  ]
}

const emptyPlan = {
  formatVersion: 1,
  id: "local-empty",
  revision: 1,
  definition: { id: emptyDefinition.id, version: emptyDefinition.version },
  nodes: [],
  edges: []
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (output[index % output.length]! + data[index]! + index) & 0xff
      }
      return output
    })
})

const prepare = <W extends Workflow.Any>(
  workflow: W,
  plan: unknown
) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(workflow, plan)
    return yield* Decision.prepare(compiled)
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

interface HandlerProbe {
  readonly calls: Array<string>
  readonly contexts: Array<Node.HandlerContext>
  active: number
  maximumActive: number
}

const makeHandlers = (
  probe: HandlerProbe,
  yieldTasks = false
): Effect.Effect<Registry.HandlerRegistry["Service"], Registry.InvalidHandlerError> => {
  const taskHandler: Node.Handler<typeof task> = Effect.fnUntraced(function*(request) {
    probe.calls.push(request.config.label)
    probe.contexts.push(request.context)
    probe.active++
    probe.maximumActive = Math.max(probe.maximumActive, probe.active)
    if (yieldTasks) {
      yield* Effect.yieldNow
    }
    probe.active--
    if (request.config.fail) {
      return yield* Effect.fail({
        _tag: "DomainFailure" as const,
        reason: `failed:${request.config.label}`
      })
    }
    return { value: `${request.inputs.value}:${request.config.label}` }
  })
  const joinHandler: Node.Handler<typeof join> = Effect.fnUntraced(function*(request) {
    probe.calls.push("join")
    return { value: request.inputs.values.join("|") }
  })
  return registry.toHandlers(registry.of({
    "Task@1.0.0": taskHandler,
    "Join@1.0.0": joinHandler
  }))
}

const options = (runId: string, overrides: Partial<LocalRunner.RunOptions> = {}): LocalRunner.RunOptions => ({
  runId,
  concurrency: 2,
  maxCycles: 16,
  maxConflictRetries: 4,
  ...overrides
})

const cancellationRequested = (
  eventId: string
): HistoryStore.EventDraft<Event.RunCancellationRequested> => ({
  eventVersion: 1,
  eventId,
  payload: { _tag: "RunCancellationRequested" }
})

const runCancelled = (
  eventId: string
): HistoryStore.EventDraft<Event.RunCancelled> => ({
  eventVersion: 1,
  eventId,
  payload: { _tag: "RunCancelled" }
})

const isScheduleBatch = (
  events: ReadonlyArray<HistoryStore.EventDraft>
): boolean => events.some((event) => event.payload._tag === "ActivityScheduled")

const isResultBatch = (
  events: ReadonlyArray<HistoryStore.EventDraft>
): boolean =>
  events.some((event) => event.payload._tag === "ActivitySucceeded" || event.payload._tag === "ActivityFailed")

const probe = (): HandlerProbe => ({
  calls: [],
  contexts: [],
  active: 0,
  maximumActive: 0
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

describe("LocalRunner", () => {
  it.effect("completes an empty graph without dispatching an activity", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(emptyDefinition, emptyPlan)
      const store = yield* HistoryStore.makeMemory
      const handlers = yield* makeHandlers(probe())
      const state = yield* LocalRunner.execute(plan, {}, options("empty-run")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )

      assert.strictEqual(state.status, "Succeeded")
      assert.strictEqual(state.backend, "direct")
      if (state.status === "Succeeded") {
        assert.deepStrictEqual(state.output, {})
      }
      const history = yield* store.read("empty-run")
      assert.deepStrictEqual(history.events.map((event) => event.payload._tag), [
        "RunStarted",
        "RunSucceeded"
      ])
    }))

  it.effect("commits schedule before one local activity and preserves command causation", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const store = yield* HistoryStore.makeMemory
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("one-run")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* store.read("one-run")
      const activityId = Command.activityId("one-run", "only", 1)
      const result = history.events.find((event) => event.payload._tag === "ActivitySucceeded")

      assert.strictEqual(state.status, "Succeeded")
      if (state.status === "Succeeded") {
        assert.deepStrictEqual(state.output, { result: "seed:only" })
      }
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.deepStrictEqual(history.events.map((event) => event.payload._tag), [
        "RunStarted",
        "ActivityScheduled",
        "ActivitySucceeded",
        "RunSucceeded"
      ])
      assert.strictEqual(result?.eventId, ActivityRuntime.activitySucceededEventId(activityId))
      assert.strictEqual(
        result?.causationId,
        Command.scheduleActivityCommandId("one-run", "only", 1)
      )
    }))

  it.effect("runs independent nodes concurrently and commits outcomes in compiled topological order", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, parallelPlan)
      const store = yield* HistoryStore.makeMemory
      const observed = probe()
      const handlers = yield* makeHandlers(observed, true)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("parallel-run")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* store.read("parallel-run")
      const results = history.events.filter((event) => event.payload._tag === "ActivitySucceeded")
      const resultIds = results.map((event) =>
        event.payload._tag === "ActivitySucceeded" ? event.payload.activityId : ""
      )
      const expectedIds = plan.compiled.topologicalOrder.map((nodeId) => Command.activityId("parallel-run", nodeId, 1))

      assert.strictEqual(state.status, "Succeeded")
      if (state.status === "Succeeded") {
        assert.deepStrictEqual(state.output, { result: "seed:right|seed:left" })
      }
      assert.strictEqual(observed.maximumActive, 2)
      assert.deepStrictEqual(resultIds, expectedIds)
    }))

  it.effect("commits typed node failures and returns a failed RunState", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, failingPlan)
      const store = yield* HistoryStore.makeMemory
      const handlers = yield* makeHandlers(probe())
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("failure-run")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )

      assert.strictEqual(state.status, "Failed")
      if (state.status === "Failed") {
        assert.deepStrictEqual(state.failure, {
          _tag: "ActivityFailure",
          activityId: Command.activityId("failure-run", "only", 1),
          nodeId: "only",
          nodeInstanceId: "only",
          attempt: 1,
          failure: {
            _tag: "DomainFailure",
            reason: "failed:only"
          }
        })
      }
    }))

  it.effect("treats an exact repeated start as resume and does not redeliver a completed handler", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const store = yield* HistoryStore.makeMemory
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const execute = LocalRunner.execute(plan, { seed: "seed" }, options("retry-run")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )

      const first = yield* execute
      const second = yield* execute

      assert.strictEqual(first.status, "Succeeded")
      assert.strictEqual(second.status, "Succeeded")
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.strictEqual((yield* store.read("retry-run")).events.length, 4)
    }))

  it.effect("redispatches a committed activity after process-local crash and preserves its stable identity", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const store = yield* HistoryStore.makeMemory
      const start = yield* RunStart.make(plan, { seed: "seed" }, {
        runId: "crash-resume",
        backend: "direct"
      })
      yield* store.start({ runId: "crash-resume", event: start })
      const started = success(RunState.fold((yield* store.read("crash-resume")).events))
      const schedule = success(Decision.decide(plan, started))[0]!
      const scheduleDraft = success(CommandEvent.fromCommand(schedule))
      yield* store.append({
        runId: "crash-resume",
        expectedLastSequence: started.sequence,
        events: [scheduleDraft]
      })

      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.run(plan, options("crash-resume")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* store.read("crash-resume")

      assert.strictEqual(state.status, "Succeeded")
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.deepStrictEqual(observed.contexts, [{
        scope: { _tag: "Direct" },
        runId: "crash-resume",
        planId: plan.compiled.plan.id,
        planRevision: plan.compiled.plan.revision,
        nodeId: "only",
        nodeInstanceId: "only",
        attempt: 1,
        idempotencyKey: Command.activityIdempotencyKey("crash-resume", "only")
      }])
      assert.strictEqual(history.events.filter((event) => event.payload._tag === "ActivityScheduled").length, 1)
    }))

  it.effect("freshly redecides after a decision CAS race and never retargets the stale schedule", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let raced = false
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          if (!raced && isScheduleBatch(request.events)) {
            raced = true
            yield* underlying.append({
              runId: request.runId,
              expectedLastSequence: request.expectedLastSequence,
              events: [cancellationRequested("decision-race-cancel")]
            })
          }
          return yield* underlying.append(request)
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("decision-race")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* underlying.read("decision-race")

      assert.strictEqual(state.status, "Cancelled")
      assert.deepStrictEqual(observed.calls, [])
      assert.isFalse(history.events.some((event) => event.payload._tag === "ActivityScheduled"))
    }))

  it.effect("observes cancellation committed after scheduling and before local dispatch", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let injected = false
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          const receipt = yield* underlying.append(request)
          if (!injected && isScheduleBatch(request.events)) {
            injected = true
            yield* underlying.append({
              runId: request.runId,
              expectedLastSequence: receipt.lastSequence,
              events: [cancellationRequested("before-dispatch-cancel")]
            })
          }
          return receipt
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("before-dispatch")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* underlying.read("before-dispatch")

      assert.strictEqual(state.status, "Cancelled")
      assert.deepStrictEqual(observed.calls, [])
      assert.isTrue(history.events.some((event) => event.payload._tag === "ActivityScheduled"))
      assert.isFalse(history.events.some((event) =>
        event.payload._tag === "ActivitySucceeded" || event.payload._tag === "ActivityFailed"
      ))
    }))

  it.effect("resumes from a schedule committed before an injected retry signal without duplicate delivery", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let injected = false
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          const receipt = yield* underlying.append(request)
          if (!injected && isScheduleBatch(request.events)) {
            injected = true
            return yield* Effect.fail(
              new HistoryStore.SequenceConflict({
                runId: request.runId,
                expectedLastSequence: request.expectedLastSequence,
                actualLastSequence: receipt.lastSequence
              })
            )
          }
          return receipt
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("schedule-retry")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* underlying.read("schedule-retry")

      assert.strictEqual(state.status, "Succeeded")
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.strictEqual(history.events.filter((event) => event.payload._tag === "ActivityScheduled").length, 1)
    }))

  it.effect("discards late local outcomes when terminal cancellation wins the result CAS race", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let cancelled = false
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          if (!cancelled && isResultBatch(request.events)) {
            cancelled = true
            yield* underlying.append({
              runId: request.runId,
              expectedLastSequence: request.expectedLastSequence,
              events: [
                cancellationRequested("result-race-request"),
                runCancelled(Command.cancelRunCommandId(request.runId))
              ]
            })
          }
          return yield* underlying.append(request)
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("result-race")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* underlying.read("result-race")

      assert.strictEqual(state.status, "Cancelled")
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.isFalse(
        history.events.some((event) =>
          event.payload._tag === "ActivitySucceeded" || event.payload._tag === "ActivityFailed"
        )
      )
    }))

  it.effect("preserves cancellation precedence across two consecutive result CAS races", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let stage = 0
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          if (isResultBatch(request.events) && stage === 0) {
            stage++
            yield* underlying.append({
              runId: request.runId,
              expectedLastSequence: request.expectedLastSequence,
              events: [cancellationRequested("two-stage-request")]
            })
          } else if (isResultBatch(request.events) && stage === 1) {
            stage++
            yield* underlying.append({
              runId: request.runId,
              expectedLastSequence: request.expectedLastSequence,
              events: [runCancelled(Command.cancelRunCommandId(request.runId))]
            })
          }
          return yield* underlying.append(request)
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(
        plan,
        { seed: "seed" },
        options("two-stage-cancellation", { maxConflictRetries: 1 })
      ).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )
      const history = yield* underlying.read("two-stage-cancellation")

      assert.strictEqual(state.status, "Cancelled")
      assert.strictEqual(stage, 2)
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.isFalse(history.events.some((event) =>
        event.payload._tag === "ActivitySucceeded" || event.payload._tag === "ActivityFailed"
      ))
    }))

  it.effect("recognizes a result committed before an injected retry signal without redelivery", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let injected = false
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          const receipt = yield* underlying.append(request)
          if (!injected && isResultBatch(request.events)) {
            injected = true
            return yield* Effect.fail(
              new HistoryStore.SequenceConflict({
                runId: request.runId,
                expectedLastSequence: request.expectedLastSequence,
                actualLastSequence: receipt.lastSequence
              })
            )
          }
          return receipt
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const state = yield* LocalRunner.execute(plan, { seed: "seed" }, options("result-retry")).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers)
      )

      assert.strictEqual(state.status, "Succeeded")
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.strictEqual(
        (yield* underlying.read("result-retry")).events.filter((event) => event.payload._tag === "ActivitySucceeded")
          .length,
        1
      )
    }))

  it.effect("fails closed when a concurrent commit records a different activity result", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let injected = false
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          if (!injected && isResultBatch(request.events)) {
            injected = true
            const original = request.events[0]!
            if (original.payload._tag !== "ActivitySucceeded") {
              return yield* Effect.die("Expected an activity success draft")
            }
            yield* underlying.append({
              runId: request.runId,
              expectedLastSequence: request.expectedLastSequence,
              events: [{
                ...original,
                payload: {
                  ...original.payload,
                  output: { value: "concurrent-value" }
                }
              }]
            })
          }
          return yield* underlying.append(request)
        })
      })
      const handlers = yield* makeHandlers(probe())
      const result = yield* Effect.result(
        LocalRunner.execute(plan, { seed: "seed" }, options("conflicting-result")).pipe(
          Effect.provideService(HistoryStore.HistoryStore, store),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )
      const error = failure(result)

      assert.instanceOf(error, LocalRunner.LocalRunnerError)
      assert.strictEqual(error.code, LocalRunner.Codes.ConflictingActivityResult)
      assert.strictEqual(error.activityId, Command.activityId("conflicting-result", "only", 1))
    }))

  it.effect("bounds repeated result conflicts without re-executing the handler", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const underlying = yield* HistoryStore.makeMemory
      let resultAttempts = 0
      const store = HistoryStore.HistoryStore.of({
        start: underlying.start,
        read: underlying.read,
        append: Effect.fnUntraced(function*(request) {
          if (isResultBatch(request.events)) {
            resultAttempts++
            return yield* Effect.fail(
              new HistoryStore.SequenceConflict({
                runId: request.runId,
                expectedLastSequence: request.expectedLastSequence,
                actualLastSequence: request.expectedLastSequence + 1
              })
            )
          }
          return yield* underlying.append(request)
        })
      })
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const result = yield* Effect.result(
        LocalRunner.execute(
          plan,
          { seed: "seed" },
          options("bounded-conflicts", { maxConflictRetries: 2 })
        ).pipe(
          Effect.provideService(HistoryStore.HistoryStore, store),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )
      const error = failure(result)

      assert.instanceOf(error, LocalRunner.LocalRunnerError)
      assert.strictEqual(error.code, LocalRunner.Codes.ConflictingActivityResult)
      assert.include(error.message, "maxConflictRetries 2")
      assert.strictEqual(resultAttempts, 3)
      assert.deepStrictEqual(observed.calls, ["only"])
    }))

  it.effect("bounds semantic cycles and validates options before creating history", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const store = yield* HistoryStore.makeMemory
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const limited = yield* Effect.result(
        LocalRunner.execute(plan, { seed: "seed" }, options("limited-run", { maxCycles: 1 })).pipe(
          Effect.provideService(HistoryStore.HistoryStore, store),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )
      const invalid = yield* Effect.result(
        LocalRunner.execute(plan, { seed: "seed" }, options("invalid-run", { concurrency: 0 })).pipe(
          Effect.provideService(HistoryStore.HistoryStore, store),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )
      const invalidRetries = yield* Effect.result(
        LocalRunner.execute(plan, { seed: "seed" }, options("invalid-retries", { maxConflictRetries: -1 })).pipe(
          Effect.provideService(HistoryStore.HistoryStore, store),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )
      const missing = yield* Effect.result(store.read("invalid-run"))
      const missingRetries = yield* Effect.result(store.read("invalid-retries"))

      const limitedError = failure(limited)
      assert.instanceOf(limitedError, LocalRunner.LocalRunnerError)
      assert.strictEqual(limitedError.code, LocalRunner.Codes.CycleLimitExceeded)
      const invalidError = failure(invalid)
      assert.instanceOf(invalidError, LocalRunner.LocalRunnerError)
      assert.strictEqual(invalidError.code, LocalRunner.Codes.InvalidConfiguration)
      const invalidRetriesError = failure(invalidRetries)
      assert.instanceOf(invalidRetriesError, LocalRunner.LocalRunnerError)
      assert.strictEqual(invalidRetriesError.code, LocalRunner.Codes.InvalidConfiguration)
      assert.strictEqual(failure(missing)._tag, "HistoryNotFound")
      assert.strictEqual(failure(missingRetries)._tag, "HistoryNotFound")
    }))

  it.effect("rejects a same-contract String activity output at a Number workflow sink", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(mismatchDefinition, mismatchPlan)
      const store = yield* HistoryStore.makeMemory
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const error = yield* LocalRunner.execute(
        plan,
        { seed: "seed" },
        options("output-mismatch")
      ).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )
      const history = yield* store.read("output-mismatch")

      assert.instanceOf(error, CommandRuntime.CommandRuntimeError)
      assert.strictEqual(error.code, CommandRuntime.Codes.InvalidWorkflowOutput)
      assert.strictEqual(error.output, "result")
      assert.deepStrictEqual(observed.calls, ["only"])
      assert.deepStrictEqual(history.events.map((event) => event.payload._tag), [
        "RunStarted",
        "ActivityScheduled",
        "ActivitySucceeded"
      ])
    }))

  it.effect("provides workflow-output decoder services at the command boundary", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(serviceOutputDefinition, serviceOutputPlan)
      const store = yield* HistoryStore.makeMemory
      const observed = probe()
      const handlers = yield* makeHandlers(observed)
      const decoder = { seen: [] as Array<string> }
      const state = yield* LocalRunner.execute(
        plan,
        { seed: "seed" },
        options("output-service")
      ).pipe(
        Effect.provideService(HistoryStore.HistoryStore, store),
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(OutputDecoder, decoder)
      )

      assert.strictEqual(state.status, "Succeeded")
      assert.deepStrictEqual(decoder.seen, ["seed:only"])
    }))

  it.effect("rejects durable histories and structurally copied prepared plans", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(definition, oneNodePlan)
      const handlers = yield* makeHandlers(probe())

      const durableStore = yield* HistoryStore.makeMemory
      const durableStart = yield* RunStart.make(plan, { seed: "seed" }, {
        runId: "durable-run",
        backend: "durable"
      })
      yield* durableStore.start({ runId: "durable-run", event: durableStart })
      const durable = yield* Effect.result(
        LocalRunner.run(plan, options("durable-run")).pipe(
          Effect.provideService(HistoryStore.HistoryStore, durableStore),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )

      const copiedStore = yield* HistoryStore.makeMemory
      const copiedStart = yield* RunStart.make(plan, { seed: "seed" }, {
        runId: "copied-run",
        backend: "direct"
      })
      yield* copiedStore.start({ runId: "copied-run", event: copiedStart })
      const copied = { ...plan } as Decision.DecidablePlan<typeof definition>
      const forged = yield* Effect.result(
        LocalRunner.run(copied, options("copied-run")).pipe(
          Effect.provideService(HistoryStore.HistoryStore, copiedStore),
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )
      )

      const durableError = failure(durable)
      assert.instanceOf(durableError, LocalRunner.LocalRunnerError)
      assert.strictEqual(durableError.code, LocalRunner.Codes.BackendMismatch)
      const forgedError = failure(forged)
      assert.instanceOf(forgedError, Decision.DecisionError)
      assert.strictEqual(forgedError.code, Decision.Codes.PlanIdentityMismatch)
    }))
})
