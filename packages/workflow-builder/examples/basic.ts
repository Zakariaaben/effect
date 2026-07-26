import {
  Builtins,
  Compiler,
  Engine,
  Expression,
  HumanTasks,
  LinkPolicy,
  Node,
  PlanStore,
  Port,
  Registry,
  Runs,
  Workflow
} from "@effect/workflow-builder"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"

// ----------------------------------------------------------------------------
// 1. The application registers its vocabulary in code.
// ----------------------------------------------------------------------------

const decorate = Node.make("Decorate", {
  version: "1.0.0",
  config: Schema.Struct({ prefix: Schema.String }),
  inputs: {
    value: Port.input(Schema.String, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  }
})

const registry = Registry.make(decorate, Builtins.If, Builtins.Transform)

const definition = Workflow.make("example/greeting", {
  version: "1.0.0",
  inputs: {
    name: Port.output(Schema.String, { contract: "example/text" })
  },
  outputs: {
    greeting: Port.input(Schema.String, { contract: "example/text", required: false })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 8,
    maxEdges: 16,
    maxFanIn: 4,
    maxFanOut: 4,
    maxDepth: 4
  })
})

// ----------------------------------------------------------------------------
// 2. An end user composes a portable plan (any UI could produce this JSON).
// ----------------------------------------------------------------------------

const plan = {
  formatVersion: 2,
  id: "example/greeting-plan",
  revision: 1,
  definition: { id: "example/greeting", version: "1.0.0" },
  nodes: [
    { id: "hello", type: "Decorate", version: "1.0.0", config: { prefix: "Hello" } },
    {
      id: "isLong",
      type: "workflow/if",
      version: "1.0.0",
      config: {
        condition: Expression.compare(
          "gt",
          Expression.size(Expression.ref("nodes", "hello", "value")),
          Expression.literal(10)
        )
      }
    },
    {
      id: "shout",
      type: "workflow/transform",
      version: "1.0.0",
      config: {
        value: Expression.template(Expression.ref("nodes", "hello", "value"), "!!")
      }
    }
  ],
  edges: [
    {
      _tag: "DataEdge",
      id: "name-to-hello",
      source: { _tag: "WorkflowInput", input: "name" },
      target: { _tag: "NodeInput", nodeId: "hello", input: "value" }
    },
    {
      _tag: "ControlEdge",
      id: "long-shout",
      sourceNodeId: "isLong",
      outcome: "true",
      targetNodeId: "shout"
    },
    {
      _tag: "DataEdge",
      id: "shout-out",
      source: { _tag: "NodeOutput", nodeId: "shout", output: "value" },
      target: { _tag: "WorkflowOutput", output: "greeting" },
      transform: Expression.ref("value")
    }
  ]
}

// ----------------------------------------------------------------------------
// 3. Compile, pin, and run durably on the (memory) workflow engine.
// ----------------------------------------------------------------------------

const handlers = registry.toLayer(registry.of({
  "Decorate@1.0.0": ({ config, inputs }) => Effect.succeed({ value: `${config.prefix}, ${inputs.value}` })
}))

const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>).then((buffer) => new Uint8Array(buffer)))
})

const EngineLive = Engine.layer(definition).pipe(
  Layer.provideMerge(Layer.mergeAll(handlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(webCrypto))
)

const program = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, plan)
  const store = yield* PlanStore.PlanStore
  yield* store.save(compiled)

  const long = yield* Runs.execute("example/greeting-plan", { input: { name: "Ada Lovelace" } })
  const short = yield* Runs.execute("example/greeting-plan", { input: { name: "Ada" } })
  return { long: long.outputs, short: short.outputs }
}).pipe(Effect.provide(EngineLive))

Effect.runPromise(program).then(console.log)
// { long: { greeting: "Hello, Ada Lovelace!!" }, short: {} }
