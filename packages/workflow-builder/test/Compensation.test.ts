import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
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

class StepFailure extends Schema.TaggedErrorClass<StepFailure>(
  "test/Compensation/StepFailure"
)("StepFailure", {
  reason: Schema.String
}) {}

// Tests in this repository run concurrently, so compensation records are
// keyed by the plan under test.
const compensated = new Map<string, Array<string>>()

const record = (planId: string, entry: string) => {
  const entries = compensated.get(planId) ?? []
  entries.push(entry)
  compensated.set(planId, entries)
}

const recorded = (planId: string): ReadonlyArray<string> => compensated.get(planId) ?? []

const charge = Node.make("Charge", {
  version: "1.0.0",
  config: Schema.Struct({ account: Schema.String }),
  outputs: { chargeId: Port.output(Schema.String, { contract: "test/text" }) },
  compensation: ({ config, context, outputs }) =>
    Effect.sync(() => {
      record(context.planId, `refund:${config.account}:${outputs.chargeId}`)
    })
})

const reserve = Node.make("Reserve", {
  version: "1.0.0",
  outputs: { reservationId: Port.output(Schema.String, { contract: "test/text" }) },
  compensation: ({ context, outputs }) =>
    Effect.sync(() => {
      record(context.planId, `release:${outputs.reservationId}`)
    })
})

const notify = Node.make("Notify", {
  version: "1.0.0"
  // Deliberately not compensable: a sent notification cannot be unsent.
})

const explode = Node.make("Explode", {
  version: "1.0.0",
  failure: StepFailure
})

const registry = Registry.make(charge, reserve, notify, explode, Builtins.HumanTask, Builtins.Transform)

const definition = Workflow.make("test/compensation", {
  version: "1.0.0",
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

const handlers = registry.toLayer(registry.of({
  "Charge@1.0.0": ({ config }) => Effect.succeed({ chargeId: `ch-${config.account}` }),
  "Reserve@1.0.0": () => Effect.succeed({ reservationId: "res-1" }),
  "Notify@1.0.0": () => Effect.succeed({}),
  "Explode@1.0.0": () => Effect.fail(new StepFailure({ reason: "boom" }))
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
  Layer.provideMerge(Layer.mergeAll(handlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

const savePlan = (plan: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, plan)
    const store = yield* PlanStore.PlanStore
    yield* store.save(compiled)
  })

const basePlan = (id: string, nodes: ReadonlyArray<unknown>, edges: ReadonlyArray<unknown>) => ({
  formatVersion: 2,
  id,
  revision: 1,
  definition: { id: "test/compensation", version: "1.0.0" },
  nodes,
  edges
})

describe("Compensation", () => {
  it.effect("unwinds completed compensable steps in reverse order on failure", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan(
        "saga-failure",
        [
          { id: "reserve", type: "Reserve", version: "1.0.0", config: {} },
          { id: "charge", type: "Charge", version: "1.0.0", config: { account: "acme" } },
          { id: "boom", type: "Explode", version: "1.0.0", config: {} }
        ],
        [
          { _tag: "ControlEdge", id: "e1", sourceNodeId: "reserve", targetNodeId: "charge" },
          { _tag: "ControlEdge", id: "e2", sourceNodeId: "charge", targetNodeId: "boom" }
        ]
      ))

      const failure = yield* Runs.execute("saga-failure", { input: {} }).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "NodeFailed")
      assert.deepStrictEqual(recorded("saga-failure"), ["refund:acme:ch-acme", "release:res-1"])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("does not compensate when the failure is routed as a handled outcome", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan(
        "saga-routed",
        [
          { id: "charge", type: "Charge", version: "1.0.0", config: { account: "acme" } },
          { id: "boom", type: "Explode", version: "1.0.0", config: {} },
          {
            id: "recover",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("recovered") }
          }
        ],
        [
          { _tag: "ControlEdge", id: "e1", sourceNodeId: "charge", targetNodeId: "boom" },
          { _tag: "ControlEdge", id: "e2", sourceNodeId: "boom", outcome: "error", targetNodeId: "recover" }
        ]
      ))

      const result = yield* Runs.execute("saga-routed", { input: {} })
      assert.deepStrictEqual(result.outputs, {})
      assert.deepStrictEqual(recorded("saga-routed"), [])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("compensates completed steps when the run is cancelled", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan(
        "saga-cancel",
        [
          { id: "charge", type: "Charge", version: "1.0.0", config: { account: "acme" } },
          { id: "notify", type: "Notify", version: "1.0.0", config: {} },
          {
            id: "review",
            type: "workflow/humanTask",
            version: "1.0.0",
            config: { title: "Review", outcomes: ["approve"] }
          }
        ],
        [
          { _tag: "ControlEdge", id: "e1", sourceNodeId: "charge", targetNodeId: "notify" },
          { _tag: "ControlEdge", id: "e2", sourceNodeId: "notify", targetNodeId: "review" }
        ]
      ))

      const handle = yield* Runs.start("saga-cancel", { input: {} })
      const tasks = yield* HumanTasks.HumanTasks
      let open = yield* tasks.list({ runId: handle.runId, state: "open" })
      for (let index = 0; index < 200 && open.length === 0; index++) {
        yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
        open = yield* tasks.list({ runId: handle.runId, state: "open" })
      }
      assert.lengthOf(open, 1)

      yield* Runs.cancel(handle.runId)
      let status = yield* Runs.status(handle.runId)
      for (let index = 0; index < 200 && (status._tag === "Running" || status._tag === "Suspended"); index++) {
        yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
        status = yield* Runs.status(handle.runId)
      }
      assert.strictEqual(status._tag, "Interrupted")
      // Charge is undone; Notify declared no compensation and is untouched.
      assert.deepStrictEqual(recorded("saga-cancel"), ["refund:acme:ch-acme"])
    }).pipe(Effect.provide(TestLayer)))
})
