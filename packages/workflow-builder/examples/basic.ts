import { Compiler, Interpreter, LinkPolicy, Node, Port, Registry, Workflow } from "@effect/workflow-builder"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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

const registry = Registry.make(decorate)

const definition = Workflow.make("example/greeting", {
  version: "1.0.0",
  inputs: {
    name: Port.output(Schema.String, { contract: "example/text" })
  },
  outputs: {
    greeting: Port.input(Schema.String, { contract: "example/text" })
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

const plan = {
  formatVersion: 1,
  id: "example/greeting-plan",
  revision: 1,
  definition: {
    id: "example/greeting",
    version: "1.0.0"
  },
  nodes: [{
    id: "hello",
    type: "Decorate",
    version: "1.0.0",
    config: { prefix: "Hello" }
  }],
  edges: [
    {
      _tag: "DataEdge",
      id: "name-to-hello",
      source: { _tag: "WorkflowInput", input: "name" },
      target: { _tag: "NodeInput", nodeId: "hello", input: "value" }
    },
    {
      _tag: "DataEdge",
      id: "hello-to-greeting",
      source: { _tag: "NodeOutput", nodeId: "hello", output: "value" },
      target: { _tag: "WorkflowOutput", output: "greeting" }
    }
  ]
}

const program = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, plan)
  const handlers = yield* registry.toHandlers(registry.of({
    "Decorate@1.0.0": ({ config, inputs }) => Effect.succeed({ value: `${config.prefix}, ${inputs.value}!` })
  }))

  return yield* Interpreter.execute(compiled, { name: "Ada" }, {
    runId: "example-run-1",
    concurrency: 4
  }).pipe(Effect.provideService(Registry.HandlerRegistry, handlers))
})

Effect.runPromise(program).then(console.log)
// { greeting: "Hello, Ada!" }
