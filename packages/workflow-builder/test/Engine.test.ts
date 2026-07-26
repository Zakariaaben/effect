import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Engine from "../src/Engine.ts"
import * as Expression from "../src/Expression.ts"
import * as HumanTasks from "../src/HumanTasks.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Runs from "../src/Runs.ts"
import * as Workflow from "../src/Workflow.ts"

// ----------------------------------------------------------------------------
// Vocabulary
// ----------------------------------------------------------------------------

class StepFailure extends Schema.TaggedErrorClass<StepFailure>(
  "test/Engine/StepFailure"
)("StepFailure", {
  reason: Schema.String
}) {}

const uppercase = Node.make("Uppercase", {
  version: "1.0.0",
  inputs: { text: Port.input(Schema.String, { contract: "test/text" }) },
  outputs: { text: Port.output(Schema.String, { contract: "test/text" }) }
})

const flaky = Node.make("Flaky", {
  version: "1.0.0",
  config: Schema.Struct({ succeedOnAttempt: Schema.Int }),
  outputs: { attempt: Port.output(Schema.Int, { contract: "test/number" }) },
  failure: StepFailure
})

const registry = Registry.make(
  uppercase,
  flaky,
  Builtins.If,
  Builtins.Transform,
  Builtins.Fail
)

const definition = Workflow.make("test/engine", {
  version: "1.0.0",
  inputs: {
    name: Port.output(Schema.String, { contract: "test/text" })
  },
  outputs: {
    greeting: Port.input(Schema.String, { contract: "test/text", required: false }),
    shortName: Port.input(Schema.String, { contract: "test/text", required: false })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 16,
    maxEdges: 32,
    maxFanIn: 4,
    maxFanOut: 8,
    maxDepth: 8
  })
})

const attemptCounters = new Map<string, number>()

const handlers = registry.toLayer(registry.of({
  "Uppercase@1.0.0": ({ inputs }) => Effect.succeed({ text: inputs.text.toUpperCase() }),
  "Flaky@1.0.0": ({ config, context }) =>
    Effect.suspend(() => {
      const count = (attemptCounters.get(context.planId) ?? 0) + 1
      attemptCounters.set(context.planId, count)
      return count >= config.succeedOnAttempt
        ? Effect.succeed({ attempt: count })
        : Effect.fail(new StepFailure({ reason: `attempt ${count}` }))
    })
}))

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

const TestLayer = Engine.layer(definition).pipe(
  Layer.provideMerge(Layer.mergeAll(
    handlers,
    PlanStore.layerMemory,
    HumanTasks.layerMemory
  )),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

// ----------------------------------------------------------------------------
// Plans
// ----------------------------------------------------------------------------

const greetingPlan = {
  formatVersion: 2,
  id: "greeting",
  revision: 1,
  definition: { id: "test/engine", version: "1.0.0" },
  nodes: [
    { id: "upper", type: "Uppercase", version: "1.0.0", config: {} },
    {
      id: "isLong",
      type: "workflow/if",
      version: "1.0.0",
      config: {
        condition: Expression.compare(
          "gt",
          Expression.size(Expression.ref("nodes", "upper", "text")),
          Expression.literal(3)
        )
      }
    },
    {
      id: "greet",
      type: "workflow/transform",
      version: "1.0.0",
      config: {
        value: Expression.template("Hello, ", Expression.ref("nodes", "upper", "text"), "!")
      }
    },
    {
      id: "short",
      type: "workflow/transform",
      version: "1.0.0",
      config: { value: Expression.ref("nodes", "upper", "text") }
    }
  ],
  edges: [
    {
      _tag: "DataEdge",
      id: "in-to-upper",
      source: { _tag: "WorkflowInput", input: "name" },
      target: { _tag: "NodeInput", nodeId: "upper", input: "text" }
    },
    {
      _tag: "ControlEdge",
      id: "long-greet",
      sourceNodeId: "isLong",
      outcome: "true",
      targetNodeId: "greet"
    },
    {
      _tag: "ControlEdge",
      id: "short-name",
      sourceNodeId: "isLong",
      outcome: "false",
      targetNodeId: "short"
    },
    {
      _tag: "DataEdge",
      id: "greet-out",
      source: { _tag: "NodeOutput", nodeId: "greet", output: "value" },
      target: { _tag: "WorkflowOutput", output: "greeting" },
      transform: Expression.ref("value")
    },
    {
      _tag: "DataEdge",
      id: "short-out",
      source: { _tag: "NodeOutput", nodeId: "short", output: "value" },
      target: { _tag: "WorkflowOutput", output: "shortName" },
      transform: Expression.ref("value")
    }
  ]
}

const savePlan = (plan: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, plan)
    const store = yield* PlanStore.PlanStore
    return yield* store.save(compiled)
  })

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("Engine", () => {
  it.effect("runs a plan with data flow, branching, and dead-path skipping", () =>
    Effect.gen(function*() {
      yield* savePlan(greetingPlan)

      const long = yield* Runs.execute("greeting", { input: { name: "Ada Lovelace" } })
      assert.deepStrictEqual(long.outputs, { greeting: "Hello, ADA LOVELACE!" })

      const short = yield* Runs.execute("greeting", { input: { name: "Ada" } })
      assert.deepStrictEqual(short.outputs, { shortName: "ADA" })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("retries a failing node according to its policy", () =>
    Effect.gen(function*() {
      yield* savePlan({
        formatVersion: 2,
        id: "retrying",
        revision: 1,
        definition: { id: "test/engine", version: "1.0.0" },
        nodes: [{
          id: "flaky",
          type: "Flaky",
          version: "1.0.0",
          config: { succeedOnAttempt: 3 },
          policy: { retry: { maxAttempts: 5 } }
        }],
        edges: []
      })

      const result = yield* Runs.execute("retrying", { input: { name: "unused" } })
      assert.deepStrictEqual(result.outputs, {})
      assert.strictEqual(attemptCounters.get("retrying"), 3)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("fails the run when retries are exhausted without error routing", () =>
    Effect.gen(function*() {
      yield* savePlan({
        formatVersion: 2,
        id: "exhausted",
        revision: 1,
        definition: { id: "test/engine", version: "1.0.0" },
        nodes: [{
          id: "flaky",
          type: "Flaky",
          version: "1.0.0",
          config: { succeedOnAttempt: 10 },
          policy: { retry: { maxAttempts: 2 } }
        }],
        edges: []
      })

      const result = yield* Runs.execute("exhausted", { input: { name: "unused" } }).pipe(
        Effect.flip
      )
      assert.strictEqual(result._tag, "NodeFailed")
      assert.strictEqual((result as Engine.NodeFailed).attempts, 2)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("aborts the run through a workflow/fail node", () =>
    Effect.gen(function*() {
      yield* savePlan({
        formatVersion: 2,
        id: "aborting",
        revision: 1,
        definition: { id: "test/engine", version: "1.0.0" },
        nodes: [{
          id: "reject",
          type: "workflow/fail",
          version: "1.0.0",
          config: { code: "REJECTED", message: "not allowed" }
        }],
        edges: []
      })

      const result = yield* Runs.execute("aborting", { input: { name: "unused" } }).pipe(
        Effect.flip
      )
      assert.strictEqual(result._tag, "RunAborted")
      assert.strictEqual((result as Engine.RunAborted).code, "REJECTED")
    }).pipe(Effect.provide(TestLayer)))
})
