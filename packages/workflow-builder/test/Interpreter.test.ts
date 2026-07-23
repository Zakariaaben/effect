import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Interpreter from "../src/Interpreter.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const textContract = "example/text"
const numberContract = "example/number"

const UndefinedFromNull = Schema.Null.pipe(
  Schema.decodeTo(
    Schema.Undefined,
    SchemaTransformation.transform({
      decode: () => undefined,
      encode: () => null
    })
  )
)

const limits = new Workflow.Limits({
  maxNodes: 32,
  maxEdges: 64,
  maxFanIn: 16,
  maxFanOut: 16,
  maxDepth: 16
})

const planNode = (
  id: string,
  type: string,
  version: string,
  config: unknown
) => ({ id, type, version, config })

const workflowInput = (input: string) => ({ _tag: "WorkflowInput" as const, input })
const nodeOutput = (nodeId: string, output: string) => ({ _tag: "NodeOutput" as const, nodeId, output })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })
const workflowOutput = (output: string) => ({ _tag: "WorkflowOutput" as const, output })

type TestSource = ReturnType<typeof workflowInput> | ReturnType<typeof nodeOutput>
type TestTarget = ReturnType<typeof nodeInput> | ReturnType<typeof workflowOutput>

const dataEdge = (
  id: string,
  source: TestSource,
  target: TestTarget,
  order?: number
) => ({
  _tag: "DataEdge" as const,
  id,
  source,
  target,
  ...(order === undefined ? {} : { order })
})

type TestNode = ReturnType<typeof planNode>
type TestEdge = ReturnType<typeof dataEdge>

const makePlan = (
  definition: Workflow.Any,
  nodes: ReadonlyArray<TestNode>,
  edges: ReadonlyArray<TestEdge>
) => ({
  formatVersion: 1,
  id: `${definition.id}-plan`,
  revision: 7,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes,
  edges
})

const assertExecutionError = (
  error: unknown,
  phase: Interpreter.Phase,
  options: {
    readonly nodeId?: string | undefined
    readonly message?: string | undefined
  } = {}
): Interpreter.ExecutionError => {
  assert.instanceOf(error, Interpreter.ExecutionError)
  const executionError = error as Interpreter.ExecutionError
  assert.strictEqual(executionError.phase, phase)
  if (options.nodeId !== undefined) {
    assert.strictEqual(executionError.nodeId, options.nodeId)
  }
  if (options.message !== undefined) {
    assert.include(executionError.message, options.message)
  }
  return executionError
}

const echo = Node.make("Echo", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, {
      contract: textContract,
      cardinality: "one",
      required: true
    })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: textContract })
  }
})

const echoRegistry = Registry.make(echo)

const echoDefinition = Workflow.make("echo-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    value: Port.input(Schema.String, {
      contract: textContract,
      cardinality: "one",
      required: true
    })
  },
  nodes: echoRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const echoPlan = makePlan(
  echoDefinition,
  [planNode("echo", "Echo", "1.0.0", {})],
  [
    dataEdge("input-echo", workflowInput("value"), nodeInput("echo", "value")),
    dataEdge("echo-output", nodeOutput("echo", "value"), workflowOutput("value"))
  ]
)

const validEchoHandlers = echoRegistry.of({
  "Echo@1.0.0": ({ inputs }) => Effect.succeed({ value: inputs.value })
})

const domainFailureSchema = Schema.Struct({
  _tag: Schema.Literal("DomainFailure"),
  reason: Schema.String
})

const fallible = Node.make("Fallible", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, {
      contract: textContract,
      cardinality: "one",
      required: true
    })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: textContract })
  },
  failure: domainFailureSchema
})

const fallibleRegistry = Registry.make(fallible)

const fallibleDefinition = Workflow.make("fallible-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    value: Port.input(Schema.String, {
      contract: textContract,
      cardinality: "one",
      required: true
    })
  },
  nodes: fallibleRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const falliblePlan = makePlan(
  fallibleDefinition,
  [planNode("fallible", "Fallible", "1.0.0", {})],
  [
    dataEdge("input-fallible", workflowInput("value"), nodeInput("fallible", "value")),
    dataEdge("fallible-output", nodeOutput("fallible", "value"), workflowOutput("value"))
  ]
)

describe("Interpreter", () => {
  it.effect("executes a realistic branched DAG with dependency scheduling and ordered many-input joins", () => {
    const decorate = Node.make("Decorate", {
      version: "1.0.0",
      config: Schema.Struct({ mark: Schema.String }),
      inputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const join = Node.make("Join", {
      version: "1.0.0",
      inputs: {
        values: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "many",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const registry = Registry.make(decorate, join)
    const definition = Workflow.make("dag-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: textContract })
      },
      outputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [
        planNode("root", "Decorate", "1.0.0", { mark: "root" }),
        planNode("left", "Decorate", "1.0.0", { mark: "L" }),
        planNode("right", "Decorate", "1.0.0", { mark: "R" }),
        planNode("join", "Join", "1.0.0", {})
      ],
      [
        dataEdge("input-root", workflowInput("value"), nodeInput("root", "value")),
        dataEdge("root-left", nodeOutput("root", "value"), nodeInput("left", "value")),
        dataEdge("root-right", nodeOutput("root", "value"), nodeInput("right", "value")),
        dataEdge("left-join", nodeOutput("left", "value"), nodeInput("join", "values"), 1),
        dataEdge("right-join", nodeOutput("right", "value"), nodeInput("join", "values"), 0),
        dataEdge("join-output", nodeOutput("join", "value"), workflowOutput("value"))
      ]
    )
    const contexts = new Map<string, Node.HandlerContext>()
    let joinedValues: ReadonlyArray<string> = []

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Decorate@1.0.0": (request) =>
          Effect.sync(() => {
            contexts.set(request.context.nodeId, request.context)
            return { value: `${request.config.mark}(${request.inputs.value})` }
          }),
        "Join@1.0.0": (request) =>
          Effect.sync(() => {
            contexts.set(request.context.nodeId, request.context)
            joinedValues = request.inputs.values
            return { value: request.inputs.values.join(" | ") }
          })
      }))

      const output = yield* Interpreter.execute(compiled, { value: "seed" }, {
        runId: "dag-run",
        concurrency: "unbounded"
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.deepStrictEqual(output, { value: "R(root(seed)) | L(root(seed))" })
      assert.deepStrictEqual(joinedValues, ["R(root(seed))", "L(root(seed))"])
      assert.deepStrictEqual(Array.from(contexts.keys()).sort(), ["join", "left", "right", "root"])
      for (const nodeId of contexts.keys()) {
        assert.deepStrictEqual(contexts.get(nodeId), {
          scope: { _tag: "Direct" },
          runId: "dag-run",
          planId: "dag-workflow-plan",
          planRevision: 7,
          nodeId,
          nodeInstanceId: nodeId,
          attempt: 1,
          idempotencyKey: Command.activityIdempotencyKey("dag-run", nodeId)
        })
      }
    })
  })

  it.effect("does not cache decoded configuration between executions", () => {
    const configShape = Schema.Struct({ mark: Schema.String })
    const freshConfig = configShape.pipe(
      Schema.decodeTo(
        configShape,
        SchemaTransformation.transform({
          decode: ({ mark }) => ({ mark }),
          encode: ({ mark }) => ({ mark })
        })
      )
    )
    const configured = Node.make("FreshConfig", {
      version: "1.0.0",
      config: freshConfig,
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const registry = Registry.make(configured)
    const definition = Workflow.make("fresh-config-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {
        value: Port.input(Schema.String, { contract: textContract })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("configured", "FreshConfig", "1.0.0", { mark: "stable" })],
      [dataEdge("configured-output", nodeOutput("configured", "value"), workflowOutput("value"))]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "FreshConfig@1.0.0": ({ config }) =>
          Effect.sync(() => {
            const mutable = config as { mark: string }
            mutable.mark = `${mutable.mark}!`
            return { value: mutable.mark }
          })
      }))
      const execute = (runId: string) =>
        Interpreter.execute(compiled, {}, { runId, concurrency: 1 }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers)
        )

      assert.deepStrictEqual(yield* execute("fresh-config-1"), { value: "stable!" })
      assert.deepStrictEqual(yield* execute("fresh-config-2"), { value: "stable!" })
      assert.deepStrictEqual(compiled.nodes.get("configured")?.node.config, { mark: "stable" })
    })
  })

  it.effect("routes detached frozen JSON snapshots instead of caller or handler aliases", () => {
    const jsonEcho = Node.make("JsonEcho", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.Json, { contract: "example/json" })
      },
      outputs: {
        value: Port.output(Schema.Json, { contract: "example/json" })
      }
    })
    const registry = Registry.make(jsonEcho)
    const definition = Workflow.make("json-snapshot-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.Json, { contract: "example/json" })
      },
      outputs: {
        value: Port.input(Schema.Json, { contract: "example/json" })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("json", "JsonEcho", "1.0.0", {})],
      [
        dataEdge("json-input", workflowInput("value"), nodeInput("json", "value")),
        dataEdge("json-output", nodeOutput("json", "value"), workflowOutput("value"))
      ]
    )
    const callerValue = { nested: { value: "caller" } }
    const handlerValue = { nested: { value: "handler" } }
    let received: Schema.Json | undefined

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "JsonEcho@1.0.0": ({ inputs }) =>
          Effect.sync(() => {
            received = inputs.value
            assert.notStrictEqual(inputs.value, callerValue)
            assert.isTrue(Object.isFrozen(inputs.value))
            assert.isTrue(Object.isFrozen((inputs.value as Schema.JsonObject).nested))
            return { value: handlerValue }
          })
      }))
      const output = yield* Interpreter.execute(compiled, { value: callerValue }, {
        runId: "json-snapshot-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.notStrictEqual(output.value, handlerValue)
      assert.isTrue(Object.isFrozen(output.value))
      callerValue.nested.value = "mutated-caller"
      handlerValue.nested.value = "mutated-handler"
      assert.deepStrictEqual(received, { nested: { value: "caller" } })
      assert.deepStrictEqual(output.value, { nested: { value: "handler" } })
    })
  })

  it.effect("rejects a schema implementation that emits non-JSON output", () => {
    const dishonestJson = Schema.Unknown as unknown as typeof Schema.Json
    const dishonest = Node.make("DishonestJson", {
      version: "1.0.0",
      outputs: {
        value: Port.output(dishonestJson, { contract: "example/json" })
      }
    })
    const registry = Registry.make(dishonest)
    const definition = Workflow.make("dishonest-json-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {
        value: Port.input(dishonestJson, { contract: "example/json" })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("dishonest", "DishonestJson", "1.0.0", {})],
      [dataEdge("dishonest-output", nodeOutput("dishonest", "value"), workflowOutput("value"))]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "DishonestJson@1.0.0": () => Effect.succeed({ value: undefined as unknown as Schema.Json })
      }))
      const error = yield* Interpreter.execute(compiled, {}, {
        runId: "dishonest-json-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assertExecutionError(error, "node-output", {
        nodeId: "dishonest",
        message: "must encode to strict JSON"
      })
    })
  })

  it.effect("keeps delimiter-bearing node and port identifiers collision-free", () => {
    const first = Node.make("CollisionSourceOne", {
      version: "1.0.0",
      outputs: {
        c: Port.output(Schema.String, { contract: textContract })
      }
    })
    const second = Node.make("CollisionSourceTwo", {
      version: "1.0.0",
      outputs: {
        "b:output:c": Port.output(Schema.String, { contract: textContract })
      }
    })
    const registry = Registry.make(first, second)
    const definition = Workflow.make("collision-free-routing", {
      version: "1.0.0",
      inputs: {},
      outputs: {
        values: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "many",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [
        planNode("a:output:b", "CollisionSourceOne", "1.0.0", {}),
        planNode("a", "CollisionSourceTwo", "1.0.0", {})
      ],
      [
        dataEdge("first-output", nodeOutput("a:output:b", "c"), workflowOutput("values"), 0),
        dataEdge("second-output", nodeOutput("a", "b:output:c"), workflowOutput("values"), 1)
      ]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "CollisionSourceOne@1.0.0": () => Effect.succeed({ c: "first" }),
        "CollisionSourceTwo@1.0.0": () => Effect.succeed({ "b:output:c": "second" })
      }))

      const output = yield* Interpreter.execute(compiled, {}, {
        runId: "collision-free-routing-run",
        concurrency: "unbounded"
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.deepStrictEqual(output, { values: ["first", "second"] })
    })
  })

  it.effect("routes prototype-like port names as ordinary own properties", () => {
    const prototypePorts = Node.make("PrototypePorts", {
      version: "1.0.0",
      inputs: {
        ["__proto__"]: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        }),
        ["constructor"]: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        }),
        ["toString"]: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        ["__proto__"]: Port.output(Schema.String, { contract: textContract }),
        ["constructor"]: Port.output(Schema.String, { contract: textContract }),
        ["toString"]: Port.output(Schema.String, { contract: textContract })
      }
    })
    const registry = Registry.make(prototypePorts)
    const definition = Workflow.make("prototype-port-workflow", {
      version: "1.0.0",
      inputs: {
        ["__proto__"]: Port.output(Schema.String, { contract: textContract }),
        ["constructor"]: Port.output(Schema.String, { contract: textContract }),
        ["toString"]: Port.output(Schema.String, { contract: textContract })
      },
      outputs: {
        ["__proto__"]: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        }),
        ["constructor"]: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        }),
        ["toString"]: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const names = ["__proto__", "constructor", "toString"] as const
    const plan = makePlan(
      definition,
      [planNode("prototype-ports", "PrototypePorts", "1.0.0", {})],
      names.flatMap((name) => [
        dataEdge(`input-${name}`, workflowInput(name), nodeInput("prototype-ports", name)),
        dataEdge(`output-${name}`, nodeOutput("prototype-ports", name), workflowOutput(name))
      ])
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "PrototypePorts@1.0.0": ({ inputs }) => {
          assert.deepStrictEqual(Object.keys(inputs).sort(), [...names].sort())
          assert.strictEqual(Object.getPrototypeOf(inputs), Object.prototype)
          return Effect.succeed(Object.fromEntries(
            names.map((name) => [name, `handled:${inputs[name]}`])
          ))
        }
      }))
      const input = Object.fromEntries(names.map((name) => [name, `input:${name}`]))
      const output = yield* Interpreter.execute(compiled, input, {
        runId: "prototype-port-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.strictEqual(Object.getPrototypeOf(output), Object.prototype)
      for (const name of names) {
        assert.isTrue(Object.prototype.hasOwnProperty.call(output, name))
        assert.strictEqual(output[name], `handled:input:${name}`)
      }
    })
  })

  it.effect("represents connected and absent optional inputs and outputs with Option", () => {
    const optional = Node.make("Optional", {
      version: "1.0.0",
      inputs: {
        connected: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: false
        }),
        absent: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: false
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const registry = Registry.make(optional)
    const definition = Workflow.make("optional-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: textContract })
      },
      outputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        }),
        absent: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: false
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("optional", "Optional", "1.0.0", {})],
      [
        dataEdge("input-optional", workflowInput("value"), nodeInput("optional", "connected")),
        dataEdge("optional-output", nodeOutput("optional", "value"), workflowOutput("value"))
      ]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Optional@1.0.0": ({ inputs }) =>
          Effect.sync(() => {
            assert.isTrue(Option.isSome(inputs.connected))
            assert.isTrue(Option.isNone(inputs.absent))
            const connected = Option.getOrThrow(inputs.connected)
            assert.strictEqual(connected, "provided")
            return { value: connected }
          })
      }))

      const output = yield* Interpreter.execute(compiled, { value: "provided" }, {
        runId: "optional-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.strictEqual(output.value, "provided")
      assert.isTrue(Option.isNone(output.absent))
    })
  })

  it.effect("distinguishes a connected undefined value from an absent optional link", () => {
    const optionalUndefined = Node.make("OptionalUndefined", {
      version: "1.0.0",
      inputs: {
        value: Port.input(UndefinedFromNull, {
          contract: "example/undefined",
          required: false
        })
      },
      outputs: {
        value: Port.output(UndefinedFromNull, { contract: "example/undefined" })
      }
    })
    const registry = Registry.make(optionalUndefined)
    const definition = Workflow.make("optional-undefined-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(UndefinedFromNull, { contract: "example/undefined" })
      },
      outputs: {
        value: Port.input(UndefinedFromNull, {
          contract: "example/undefined",
          required: false
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("optional", "OptionalUndefined", "1.0.0", {})],
      [
        dataEdge("input-optional", workflowInput("value"), nodeInput("optional", "value")),
        dataEdge("optional-output", nodeOutput("optional", "value"), workflowOutput("value"))
      ]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "OptionalUndefined@1.0.0": ({ inputs }) => {
          assert.isTrue(Option.isSome(inputs.value))
          return Effect.succeed({ value: undefined })
        }
      }))
      const output = yield* Interpreter.execute(compiled, { value: undefined }, {
        runId: "optional-undefined-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.isTrue(Option.isSome(output.value))

      const missing = yield* Interpreter.execute(compiled, {} as never, {
        runId: "missing-undefined-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )
      assertExecutionError(missing, "input", {
        message: "Workflow input is missing declared input 'value'"
      })
    })
  })

  it.effect("routes values through source encoding and target decoding transforms", () => {
    const transform = Node.make("Transform", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, {
          contract: numberContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.NumberFromString, { contract: numberContract })
      }
    })
    const registry = Registry.make(transform)
    const definition = Workflow.make("transform-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.NumberFromString, { contract: numberContract })
      },
      outputs: {
        value: Port.input(Schema.String, {
          contract: numberContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("transform", "Transform", "1.0.0", {})],
      [
        dataEdge("input-transform", workflowInput("value"), nodeInput("transform", "value")),
        dataEdge("transform-output", nodeOutput("transform", "value"), workflowOutput("value"))
      ]
    )
    let handlerInput: unknown

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Transform@1.0.0": ({ inputs }) =>
          Effect.sync(() => {
            handlerInput = inputs.value
            return { value: Number(inputs.value) + 1 }
          })
      }))

      const output = yield* Interpreter.execute(compiled, { value: 41 }, {
        runId: "transform-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.strictEqual(handlerInput, "41")
      assert.deepStrictEqual(output, { value: "42" })
    })
  })

  it.effect("honors declared request services and the context captured by handler registration", () => {
    class RunPrefix extends Context.Service<RunPrefix, string>()(
      "@effect/workflow-builder/test/Interpreter/RunPrefix"
    ) {}
    class CapturedSuffix extends Context.Service<CapturedSuffix, string>()(
      "@effect/workflow-builder/test/Interpreter/CapturedSuffix"
    ) {}

    const serviceNode = Node.make("ServiceNode", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      },
      dependencies: [RunPrefix]
    })
    const registry = Registry.make(serviceNode)
    const definition = Workflow.make("service-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: textContract })
      },
      outputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [planNode("service", "ServiceNode", "1.0.0", {})],
      [
        dataEdge("input-service", workflowInput("value"), nodeInput("service", "value")),
        dataEdge("service-output", nodeOutput("service", "value"), workflowOutput("value"))
      ]
    )
    // HandlerEntry intentionally erases services captured while the registry is built.
    const handler = ((request: Node.HandlerRequest<typeof serviceNode>) =>
      Effect.gen(function*() {
        const prefix = yield* RunPrefix
        const suffix = yield* CapturedSuffix
        return { value: `${prefix}:${request.inputs.value}:${suffix}` }
      })) as unknown as Node.Handler<typeof serviceNode>

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "ServiceNode@1.0.0": handler
      })).pipe(Effect.provideService(CapturedSuffix, "captured"))

      const entry = handlers.get("ServiceNode", "1.0.0")
      if (entry === undefined) {
        return yield* Effect.die("Expected the service handler to be registered")
      }
      assert.strictEqual(
        // The captured Context is likewise stored behind HandlerEntry's erased type.
        Context.get(entry.context as Context.Context<CapturedSuffix>, CapturedSuffix),
        "captured"
      )

      const output = yield* Interpreter.execute(compiled, { value: "payload" }, {
        runId: "service-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RunPrefix, "request")
      )

      assert.deepStrictEqual(output, { value: "request:payload:captured" })
    })
  })

  it.effect("enforces the configured concurrency for simultaneously ready nodes", () => {
    const worker = Node.make("Worker", {
      version: "1.0.0",
      config: Schema.Struct({ id: Schema.Number }),
      outputs: {
        value: Port.output(Schema.Number, { contract: numberContract })
      }
    })
    const registry = Registry.make(worker)
    const definition = Workflow.make("concurrency-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {
        values: Port.input(Schema.Number, {
          contract: numberContract,
          cardinality: "many",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [
        planNode("one", "Worker", "1.0.0", { id: 1 }),
        planNode("two", "Worker", "1.0.0", { id: 2 }),
        planNode("three", "Worker", "1.0.0", { id: 3 })
      ],
      [
        dataEdge("one-output", nodeOutput("one", "value"), workflowOutput("values"), 0),
        dataEdge("two-output", nodeOutput("two", "value"), workflowOutput("values"), 1),
        dataEdge("three-output", nodeOutput("three", "value"), workflowOutput("values"), 2)
      ]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const active = yield* Ref.make(0)
      const maximum = yield* Ref.make(0)
      const twoStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const handlers = yield* registry.toHandlers(registry.of({
        "Worker@1.0.0": ({ config }) =>
          Effect.gen(function*() {
            const count = yield* Ref.updateAndGet(active, (value) => value + 1)
            yield* Ref.update(maximum, (value) => Math.max(value, count))
            if (count === 2) {
              yield* Deferred.succeed(twoStarted, undefined)
            }
            yield* Deferred.await(release)
            return { value: config.id }
          }).pipe(Effect.ensuring(Ref.update(active, (value) => value - 1)))
      }))

      const fiber = yield* Interpreter.execute(compiled, {}, {
        runId: "concurrency-run",
        concurrency: 2
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.forkChild
      )

      yield* Deferred.await(twoStarted)
      assert.strictEqual(yield* Ref.get(active), 2)
      assert.strictEqual(yield* Ref.get(maximum), 2)
      yield* Deferred.succeed(release, undefined)

      const output = yield* Fiber.join(fiber)
      assert.deepStrictEqual(output, { values: [1, 2, 3] })
      assert.strictEqual(yield* Ref.get(maximum), 2)
    })
  })

  it.effect("starts a ready dependent before an unrelated slow root completes", () => {
    const source = Node.make("Source", {
      version: "1.0.0",
      config: Schema.Struct({ role: Schema.Literals(["slow", "fast"]) }),
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const child = Node.make("Child", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const registry = Registry.make(source, child)
    const definition = Workflow.make("readiness-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [
        planNode("slow", "Source", "1.0.0", { role: "slow" }),
        planNode("fast", "Source", "1.0.0", { role: "fast" }),
        planNode("child", "Child", "1.0.0", {})
      ],
      [
        dataEdge("fast-child", nodeOutput("fast", "value"), nodeInput("child", "value")),
        dataEdge("child-output", nodeOutput("child", "value"), workflowOutput("value"))
      ]
    )

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const slowStarted = yield* Deferred.make<void>()
      const releaseSlow = yield* Deferred.make<void>()
      const slowCompleted = yield* Deferred.make<void>()
      const fastCompleted = yield* Deferred.make<void>()
      const childCompleted = yield* Deferred.make<void>()
      const handlers = yield* registry.toHandlers(registry.of({
        "Source@1.0.0": ({ config }) =>
          Effect.gen(function*() {
            if (config.role === "slow") {
              yield* Deferred.succeed(slowStarted, undefined)
              yield* Deferred.await(releaseSlow)
              yield* Deferred.succeed(slowCompleted, undefined)
              return { value: "slow" }
            }
            yield* Deferred.succeed(fastCompleted, undefined)
            return { value: "fast" }
          }),
        "Child@1.0.0": ({ inputs }) =>
          Deferred.succeed(childCompleted, undefined).pipe(
            Effect.as({ value: `${inputs.value}-child` })
          )
      }))

      const fiber = yield* Interpreter.execute(compiled, {}, {
        runId: "readiness-run",
        concurrency: 3
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.forkChild
      )

      yield* Deferred.await(slowStarted)
      yield* Deferred.await(fastCompleted)
      for (let attempt = 0; attempt < 20 && !(yield* Deferred.isDone(childCompleted)); attempt++) {
        yield* Effect.yieldNow
      }
      const childFinishedBeforeSlow = yield* Deferred.isDone(childCompleted)
      const slowHadCompleted = yield* Deferred.isDone(slowCompleted)

      yield* Deferred.succeed(releaseSlow, undefined)
      const output = yield* Fiber.join(fiber)

      assert.deepStrictEqual(output, { value: "fast-child" })
      assert.isFalse(slowHadCompleted)
      assert.isTrue(
        childFinishedBeforeSlow,
        "a dependent of the fast root should not wait for an unrelated slow root"
      )
    })
  })

  it.effect("propagates a handler's valid typed failure unchanged", () => {
    const failure = { _tag: "DomainFailure" as const, reason: "business rule" }

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(fallibleDefinition, falliblePlan)
      const handlers = yield* fallibleRegistry.toHandlers(fallibleRegistry.of({
        "Fallible@1.0.0": () => Effect.fail(failure)
      }))

      const error = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "failure-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assert.strictEqual(error, failure)
    })
  })

  it.effect("reports a missing pinned handler as an execution error", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)
      const handlers = Registry.HandlerRegistry.of({
        handlers: new Map<string, Registry.HandlerEntry>(),
        get: () => undefined
      })

      const error = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "missing-handler-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assertExecutionError(error, "handler", {
        nodeId: "echo",
        message: "No exact handler is installed for 'Echo@1.0.0'"
      })
    }))

  it.effect("rejects structural copies of compiled plans", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)
      const copied = { ...compiled } as Compiler.CompiledPlan<typeof echoDefinition>
      const handlers = yield* echoRegistry.toHandlers(validEchoHandlers)
      const error = yield* Interpreter.execute(copied, { value: "input" }, {
        runId: "copied-plan-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assertExecutionError(error, "configuration", {
        message: "exact result of Compiler.compile"
      })
    }))

  it.effect("rejects a same-key handler registered for a different definition object", () => {
    const foreignEcho = Node.make("Echo", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      }
    })
    const foreignRegistry = Registry.make(foreignEcho)

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)
      const handlers = yield* foreignRegistry.toHandlers(foreignRegistry.of({
        "Echo@1.0.0": ({ inputs }) => Effect.succeed({ value: `foreign:${inputs.value}` })
      }))
      const error = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "foreign-handler-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assertExecutionError(error, "handler", {
        nodeId: "echo",
        message: "No exact handler is installed for 'Echo@1.0.0'"
      })
    })
  })

  it.effect("rejects handlers that throw or do not return an Effect", () => {
    const cases: ReadonlyArray<readonly [Node.Handler<typeof echo>, string]> = [
      [(() => 42) as unknown as Node.Handler<typeof echo>, "did not return an Effect"],
      [
        (() => {
          throw new Error("synchronous handler bug")
        }) as Node.Handler<typeof echo>,
        "threw before returning an Effect"
      ]
    ]

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)

      for (const [handler, message] of cases) {
        const handlers = yield* echoRegistry.toHandlers(echoRegistry.of({
          "Echo@1.0.0": handler
        }))
        const error = yield* Interpreter.execute(compiled, { value: "input" }, {
          runId: "invalid-handler-run",
          concurrency: 1
        }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )

        assertExecutionError(error, "handler", { nodeId: "echo", message })
      }
    })
  })

  it.effect("rejects non-object, incomplete, excess, and unencodable handler outputs", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ["not an object", "Node handler output must be an object"],
      [{}, "Handler did not return required output 'value'"],
      [{ value: "ok", extra: true }, "Handler returned unknown output 'extra'"],
      [{ value: 123 }, "Expected string"]
    ]

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)

      for (const [output, expectedMessage] of cases) {
        const invalidHandler = (() => Effect.succeed(output)) as unknown as Node.Handler<typeof echo>
        const handlers = yield* echoRegistry.toHandlers(echoRegistry.of({
          "Echo@1.0.0": invalidHandler
        }))
        const error = yield* Interpreter.execute(compiled, { value: "input" }, {
          runId: "invalid-output-run",
          concurrency: 1
        }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )

        assertExecutionError(error, "node-output", {
          nodeId: "echo",
          message: expectedMessage
        })
      }
    })
  })

  it.effect("rejects hostile handler result containers without invoking accessors", () => {
    let ownGetterCalls = 0
    const accessorOutput = {}
    Object.defineProperty(accessorOutput, "value", {
      enumerable: true,
      get: () => {
        ownGetterCalls++
        return "accessor"
      }
    })

    let inheritedGetterCalls = 0
    const inheritedPrototype = {}
    Object.defineProperty(inheritedPrototype, "value", {
      enumerable: true,
      get: () => {
        inheritedGetterCalls++
        return "inherited"
      }
    })
    const inheritedOutput = Object.create(inheritedPrototype)

    const nonEnumerableOutput = {}
    Object.defineProperty(nonEnumerableOutput, "value", {
      enumerable: false,
      value: "hidden"
    })

    const symbolOutput = { value: "output" }
    Object.defineProperty(symbolOutput, Symbol("extra"), {
      enumerable: true,
      value: "symbol"
    })

    const trappedOutput = new Proxy({ value: "output" }, {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap")
      }
    })

    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [accessorOutput, "must be an enumerable data property"],
      [inheritedOutput, "Object.prototype or null"],
      [nonEnumerableOutput, "must be an enumerable data property"],
      [symbolOutput, "must not contain symbol properties"],
      [trappedOutput, "could not be inspected safely"]
    ]

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)

      for (const [output, message] of cases) {
        const handler = (() => Effect.succeed(output)) as unknown as Node.Handler<typeof echo>
        const handlers = yield* echoRegistry.toHandlers(echoRegistry.of({
          "Echo@1.0.0": handler
        }))
        const error = yield* Interpreter.execute(compiled, { value: "input" }, {
          runId: "hostile-output-run",
          concurrency: 1
        }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )
        assertExecutionError(error, "node-output", {
          nodeId: "echo",
          message
        })
      }

      assert.strictEqual(ownGetterCalls, 0)
      assert.strictEqual(inheritedGetterCalls, 0)
    })
  })

  it.effect("encodes the captured handler output descriptor value without a second property read", () => {
    let ownKeysCalls = 0
    let descriptorCalls = 0
    let propertyReads = 0
    const output = new Proxy({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => {
        ownKeysCalls++
        return ["value"]
      },
      getOwnPropertyDescriptor: () => {
        descriptorCalls++
        return {
          configurable: true,
          enumerable: true,
          value: "captured",
          writable: true
        }
      },
      get: () => {
        propertyReads++
        throw new Error("the original output property must not be read")
      }
    })
    const handler = (() => Effect.succeed(output)) as unknown as Node.Handler<typeof echo>

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)
      const handlers = yield* echoRegistry.toHandlers(echoRegistry.of({
        "Echo@1.0.0": handler
      }))
      const result = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "captured-output-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))

      assert.deepStrictEqual(result, { value: "captured" })
      assert.strictEqual(ownKeysCalls, 1)
      assert.strictEqual(descriptorCalls, 1)
      assert.strictEqual(propertyReads, 0)

      const nullPrototypeOutput = Object.assign(Object.create(null), { value: "null-prototype" })
      const nullPrototypeHandler = (() => Effect.succeed(nullPrototypeOutput)) as unknown as Node.Handler<typeof echo>
      const nullPrototypeHandlers = yield* echoRegistry.toHandlers(echoRegistry.of({
        "Echo@1.0.0": nullPrototypeHandler
      }))
      const nullPrototypeResult = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "null-prototype-output-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, nullPrototypeHandlers))
      assert.deepStrictEqual(nullPrototypeResult, { value: "null-prototype" })
    })
  })

  it.effect("turns failures that do not encode with the declared schema into execution errors", () => {
    const invalidFailure = { _tag: "DomainFailure", reason: 123 }
    const invalidHandler = (() => Effect.fail(invalidFailure)) as unknown as Node.Handler<typeof fallible>

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(fallibleDefinition, falliblePlan)
      const handlers = yield* fallibleRegistry.toHandlers(fallibleRegistry.of({
        "Fallible@1.0.0": invalidHandler
      }))

      const error = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "invalid-failure-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assertExecutionError(error, "failure", {
        nodeId: "fallible",
        message: "Handler returned an invalid typed failure"
      })
    })
  })

  it.effect("validates run identifiers, concurrency, and workflow input shape before execution", () => {
    const invalidOptions: ReadonlyArray<readonly [Interpreter.ExecuteOptions, string]> = [
      [{ runId: "", concurrency: 1 }, "non-empty runId"],
      [{ runId: "run", concurrency: 0 }, "positive safe integer"],
      [{ runId: "run", concurrency: -1 }, "positive safe integer"],
      [{ runId: "run", concurrency: 1.5 }, "positive safe integer"],
      [{ runId: "run", concurrency: Number.MAX_SAFE_INTEGER + 1 }, "positive safe integer"],
      [{ runId: "run", concurrency: Number.NaN }, "positive safe integer"]
    ]
    const invalidInputs: ReadonlyArray<unknown> = [null, "input", ["input"]]

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)
      const handlers = yield* echoRegistry.toHandlers(validEchoHandlers)

      for (const [options, expectedMessage] of invalidOptions) {
        const error = yield* Interpreter.execute(compiled, { value: "input" }, options).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )
        assertExecutionError(error, "configuration", { message: expectedMessage })
      }

      for (const input of invalidInputs) {
        const error = yield* Interpreter.execute(compiled, input as never, {
          runId: "input-run",
          concurrency: 1
        }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )
        assertExecutionError(error, "input", { message: "Workflow input must be an object" })
      }

      const unknown = yield* Interpreter.execute(compiled, {
        value: "input",
        extra: true
      } as never, {
        runId: "input-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )
      const unknownError = assertExecutionError(unknown, "input", {
        message: "Unknown workflow input 'extra'"
      })
      assert.deepStrictEqual(unknownError.details, { input: "extra" })

      for (const input of [{}, { value: 123 }]) {
        const error = yield* Interpreter.execute(compiled, input as never, {
          runId: "input-run",
          concurrency: 1
        }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )
        const inputError = assertExecutionError(error, "input")
        assert.deepStrictEqual(inputError.details, { input: "value" })
      }
    })
  })

  it.effect("validates workflow inputs from own data descriptors without invoking accessors", () => {
    let ownGetterCalls = 0
    const accessorInput = {}
    Object.defineProperty(accessorInput, "value", {
      enumerable: true,
      get: () => {
        ownGetterCalls++
        return "accessor"
      }
    })

    let inheritedGetterCalls = 0
    const inheritedPrototype = {}
    Object.defineProperty(inheritedPrototype, "value", {
      enumerable: true,
      get: () => {
        inheritedGetterCalls++
        return "inherited"
      }
    })
    const inheritedInput = Object.create(inheritedPrototype)

    const nonEnumerableInput = {}
    Object.defineProperty(nonEnumerableInput, "value", {
      enumerable: false,
      value: "hidden"
    })

    const symbolInput = { value: "input" }
    Object.defineProperty(symbolInput, Symbol("extra"), {
      enumerable: true,
      value: "symbol"
    })

    const trappedInput = new Proxy({ value: "input" }, {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap")
      }
    })

    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [accessorInput, "must be an enumerable data property"],
      [inheritedInput, "Object.prototype or null"],
      [nonEnumerableInput, "must be an enumerable data property"],
      [symbolInput, "must not contain symbol properties"],
      [trappedInput, "could not be inspected safely"]
    ]

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(echoDefinition, echoPlan)
      const handlers = yield* echoRegistry.toHandlers(validEchoHandlers)

      for (const [input, message] of cases) {
        const error = yield* Interpreter.execute(compiled, input as never, {
          runId: "descriptor-input-run",
          concurrency: 1
        }).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.flip
        )
        assertExecutionError(error, "input", { message })
      }

      assert.strictEqual(ownGetterCalls, 0)
      assert.strictEqual(inheritedGetterCalls, 0)

      const nullPrototypeInput = Object.assign(Object.create(null), { value: "accepted" })
      const output = yield* Interpreter.execute(compiled, nullPrototypeInput, {
        runId: "null-prototype-input-run",
        concurrency: 1
      }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))
      assert.deepStrictEqual(output, { value: "accepted" })
    })
  })

  it.effect("attributes downstream schema decoding failures to node inputs and workflow outputs", () => {
    const decodeNumber = Node.make("DecodeNumber", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.Number, {
          contract: numberContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: numberContract })
      }
    })
    const registry = Registry.make(decodeNumber)
    const nodeInputDefinition = Workflow.make("node-input-decode-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: numberContract })
      },
      outputs: {
        value: Port.input(Schema.String, {
          contract: numberContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const nodeInputPlan = makePlan(
      nodeInputDefinition,
      [planNode("decode", "DecodeNumber", "1.0.0", {})],
      [
        dataEdge("input-decode", workflowInput("value"), nodeInput("decode", "value")),
        dataEdge("decode-output", nodeOutput("decode", "value"), workflowOutput("value"))
      ]
    )

    const numberWire = Node.make("NumberWire", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, {
          contract: numberContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: numberContract })
      }
    })
    const workflowOutputRegistry = Registry.make(numberWire)
    const workflowOutputDefinition = Workflow.make("workflow-output-decode-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: numberContract })
      },
      outputs: {
        value: Port.input(Schema.Number, {
          contract: numberContract,
          cardinality: "one",
          required: true
        })
      },
      nodes: workflowOutputRegistry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const workflowOutputPlan = makePlan(
      workflowOutputDefinition,
      [planNode("number-wire", "NumberWire", "1.0.0", {})],
      [
        dataEdge("input-number-wire", workflowInput("value"), nodeInput("number-wire", "value")),
        dataEdge("number-wire-output", nodeOutput("number-wire", "value"), workflowOutput("value"))
      ]
    )

    return Effect.gen(function*() {
      const nodeInputCompiled = yield* Compiler.compile(nodeInputDefinition, nodeInputPlan)
      const nodeInputHandlers = yield* registry.toHandlers(registry.of({
        "DecodeNumber@1.0.0": ({ inputs }) => Effect.succeed({ value: String(inputs.value) })
      }))
      const nodeInputError = yield* Interpreter.execute(nodeInputCompiled, { value: "not-a-number" }, {
        runId: "node-input-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, nodeInputHandlers),
        Effect.flip
      )
      assertExecutionError(nodeInputError, "node-input", { nodeId: "decode" })

      const workflowOutputCompiled = yield* Compiler.compile(workflowOutputDefinition, workflowOutputPlan)
      const workflowOutputHandlers = yield* workflowOutputRegistry.toHandlers(workflowOutputRegistry.of({
        "NumberWire@1.0.0": ({ inputs }) => Effect.succeed({ value: inputs.value })
      }))
      const workflowOutputError = yield* Interpreter.execute(workflowOutputCompiled, { value: "not-a-number" }, {
        runId: "workflow-output-run",
        concurrency: 1
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, workflowOutputHandlers),
        Effect.flip
      )
      assertExecutionError(workflowOutputError, "workflow-output")
    })
  })

  it.effect("interrupts concurrently running sibling nodes after one node fails", () => {
    const racing = Node.make("Racing", {
      version: "1.0.0",
      config: Schema.Struct({ role: Schema.Literals(["fail", "wait"]) }),
      inputs: {
        value: Port.input(Schema.String, {
          contract: textContract,
          cardinality: "one",
          required: true
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: textContract })
      },
      failure: domainFailureSchema
    })
    const registry = Registry.make(racing)
    const definition = Workflow.make("interruption-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: textContract })
      },
      outputs: {},
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const plan = makePlan(
      definition,
      [
        planNode("failure", "Racing", "1.0.0", { role: "fail" }),
        planNode("waiting", "Racing", "1.0.0", { role: "wait" })
      ],
      [
        dataEdge("input-failure", workflowInput("value"), nodeInput("failure", "value")),
        dataEdge("input-waiting", workflowInput("value"), nodeInput("waiting", "value"))
      ]
    )
    const failure = { _tag: "DomainFailure" as const, reason: "stop the concurrent work" }

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const waitingStarted = yield* Deferred.make<void>()
      const waitingInterrupted = yield* Deferred.make<void>()
      const handlers = yield* registry.toHandlers(registry.of({
        "Racing@1.0.0": ({ config }) =>
          config.role === "fail"
            ? Deferred.await(waitingStarted).pipe(
              Effect.andThen(Effect.fail(failure))
            )
            : Deferred.succeed(waitingStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(waitingInterrupted, undefined).pipe(Effect.asVoid))
            )
      }))

      const error = yield* Interpreter.execute(compiled, { value: "input" }, {
        runId: "interruption-run",
        concurrency: "unbounded"
      }).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )

      assert.strictEqual(error, failure)
      assert.isTrue(yield* Deferred.isDone(waitingInterrupted))
    })
  })
})
