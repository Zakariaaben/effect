import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
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
import * as Registry from "../src/Registry.ts"
import * as RunJournal from "../src/RunJournal.ts"
import * as Runs from "../src/Runs.ts"
import * as Workflow from "../src/Workflow.ts"

class StepFailure extends Schema.TaggedErrorClass<StepFailure>(
  "test/GapFeatures/StepFailure"
)("StepFailure", {
  reason: Schema.String
}) {}

const broken = Node.make("Broken", {
  version: "1.0.0",
  failure: StepFailure
})

const registry = Registry.make(
  broken,
  Builtins.Transform,
  Builtins.HumanTask,
  Builtins.WaitUntil,
  Builtins.While,
  Builtins.If
)

const definition = Workflow.make("test/gaps", {
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
  "Broken@1.0.0": () => Effect.fail(new StepFailure({ reason: "boom" }))
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
    HumanTasks.layerMemory,
    RunJournal.layerMemory
  )),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

const savePlan = (plan: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, plan)
    const store = yield* PlanStore.PlanStore
    yield* store.save(compiled)
  })

const basePlan = (id: string, extra: object) => ({
  formatVersion: 2,
  id,
  revision: 1,
  definition: { id: "test/gaps", version: "1.0.0" },
  ...extra
})

const awaitStatus = (runId: string, done: (status: Runs.RunStatus) => boolean) =>
  Effect.gen(function*() {
    let status = yield* Runs.status(runId)
    for (let index = 0; index < 200 && !done(status); index++) {
      yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
      status = yield* Runs.status(runId)
    }
    return status
  })

describe("GapFeatures", () => {
  describe("arithmetic expressions", () => {
    const scope = { input: { a: 10, b: 4 } }
    const evaluate = (op: Expression.ArithmeticOp) =>
      Expression.evaluate(
        Expression.arithmetic(op, Expression.ref("input", "a"), Expression.ref("input", "b")),
        scope
      )

    it("computes the standard operators", () => {
      assert.deepStrictEqual(evaluate("add"), Result.succeed(14))
      assert.deepStrictEqual(evaluate("subtract"), Result.succeed(6))
      assert.deepStrictEqual(evaluate("multiply"), Result.succeed(40))
      assert.deepStrictEqual(evaluate("divide"), Result.succeed(2.5))
      assert.deepStrictEqual(evaluate("modulo"), Result.succeed(2))
    })

    it("rejects non-numeric operands and non-finite results", () => {
      const mismatch = Expression.evaluate(
        Expression.arithmetic("add", Expression.literal("x"), Expression.literal(1)),
        {}
      )
      assert.isTrue(Result.isFailure(mismatch))

      const division = Expression.evaluate(
        Expression.arithmetic("divide", Expression.literal(1), Expression.literal(0)),
        {}
      )
      assert.isTrue(Result.isFailure(division))
      assert.match((division as Result.Failure<never, Expression.EvaluationError>).failure.message, /non-finite/)
    })

    it("round-trips through the wire schema", () => {
      const expression = Expression.arithmetic("multiply", Expression.literal(2), Expression.literal(3))
      const decoded = Schema.decodeUnknownSync(Expression.Expression)(expression)
      assert.deepStrictEqual(decoded, expression)
    })
  })

  it.effect("workflow/waitUntil holds the run until the absolute deadline", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      yield* savePlan(basePlan("wait-until", {
        nodes: [
          { id: "gate", type: "workflow/waitUntil", version: "1.0.0", config: { atMillis: 5000 } },
          {
            id: "after",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("opened") }
          }
        ],
        outputs: [{ name: "result", contract: "*" }],
        edges: [
          { _tag: "ControlEdge", id: "e1", sourceNodeId: "gate", targetNodeId: "after" },
          {
            _tag: "DataEdge",
            id: "out",
            source: { _tag: "NodeOutput", nodeId: "after", output: "value" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]
      }))

      const handle = yield* Runs.start("wait-until", { input: {} })
      let status = yield* awaitStatus(handle.runId, (s) => s._tag === "Suspended")
      assert.notStrictEqual(status._tag, "Succeeded")

      yield* TestClock.adjust("5 seconds")
      status = yield* awaitStatus(handle.runId, (s) => s._tag !== "Running" && s._tag !== "Suspended")
      assert.strictEqual(status._tag, "Succeeded")
      assert.deepStrictEqual(
        (status as Extract<Runs.RunStatus, { _tag: "Succeeded" }>).value.outputs,
        { result: "opened" }
      )
    }).pipe(Effect.provide(TestLayer)))

  it.effect("workflow/while iterates a body plan with committed identity", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan("acc-body", {
        outputs: [{ name: "total", contract: "*" }],
        nodes: [{
          id: "step",
          type: "workflow/transform",
          version: "1.0.0",
          config: {
            value: Expression.arithmetic(
              "add",
              Expression.coalesce(Expression.ref("input", "previous", "total"), Expression.literal(0)),
              Expression.literal(5)
            )
          }
        }],
        edges: [{
          _tag: "DataEdge",
          id: "out",
          source: { _tag: "NodeOutput", nodeId: "step", output: "value" },
          target: { _tag: "WorkflowOutput", output: "total" }
        }]
      }))

      yield* savePlan(basePlan("accumulate", {
        outputs: [
          { name: "iterations", contract: "*" },
          { name: "last", contract: "*" }
        ],
        nodes: [{
          id: "loop",
          type: "workflow/while",
          version: "1.0.0",
          config: {
            condition: Expression.compare(
              "lt",
              Expression.coalesce(Expression.ref("previous", "total"), Expression.literal(0)),
              Expression.literal(12)
            ),
            plan: { planId: "acc-body" },
            maxIterations: 10
          }
        }],
        edges: [
          {
            _tag: "DataEdge",
            id: "o1",
            source: { _tag: "NodeOutput", nodeId: "loop", output: "iterations" },
            target: { _tag: "WorkflowOutput", output: "iterations" }
          },
          {
            _tag: "DataEdge",
            id: "o2",
            source: { _tag: "NodeOutput", nodeId: "loop", output: "last" },
            target: { _tag: "WorkflowOutput", output: "last" }
          }
        ]
      }))

      const result = yield* Runs.execute("accumulate", { input: {} })
      assert.deepStrictEqual(result.outputs, {
        iterations: 3,
        last: { total: 15 }
      })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("workflow/while enforces its iteration bound", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan("noop-body", {
        nodes: [{
          id: "step",
          type: "workflow/transform",
          version: "1.0.0",
          config: { value: Expression.literal(1) }
        }],
        edges: []
      }))
      yield* savePlan(basePlan("runaway", {
        nodes: [{
          id: "loop",
          type: "workflow/while",
          version: "1.0.0",
          config: {
            condition: Expression.literal(true),
            plan: { planId: "noop-body" },
            maxIterations: 3
          }
        }],
        edges: []
      }))

      const failure = yield* Runs.execute("runaway", { input: {} }).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "EngineFault")
      assert.match((failure as Engine.EngineFault).message, /maxIterations/)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("Runs.await returns terminal results from any observer", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan("awaited", {
        outputs: [{ name: "decision", contract: "*" }],
        nodes: [{
          id: "review",
          type: "workflow/humanTask",
          version: "1.0.0",
          config: { title: "Review", outcomes: ["approve"] }
        }, {
          id: "echo",
          type: "workflow/transform",
          version: "1.0.0",
          config: { value: Expression.ref("nodes", "review", "output") }
        }],
        edges: [
          { _tag: "ControlEdge", id: "e1", sourceNodeId: "review", outcome: "approve", targetNodeId: "echo" },
          {
            _tag: "DataEdge",
            id: "out",
            source: { _tag: "NodeOutput", nodeId: "echo", output: "value" },
            target: { _tag: "WorkflowOutput", output: "decision" }
          }
        ]
      }))

      const handle = yield* Runs.start("awaited", { input: {} })
      const tasks = yield* HumanTasks.HumanTasks
      let open = yield* tasks.list({ runId: handle.runId, state: "open" })
      for (let index = 0; index < 200 && open.length === 0; index++) {
        yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
        open = yield* tasks.list({ runId: handle.runId, state: "open" })
      }
      yield* tasks.complete(open[0]!.taskId, { outcome: "approve", output: "granted" })

      const result = yield* Runs.await(handle.runId, { pollInterval: "5 millis" }).pipe(TestClock.withLive)
      assert.deepStrictEqual(result.outputs, { decision: "granted" })

      // A failing run surfaces its typed failure through await as well.
      yield* savePlan(basePlan("await-fails", {
        nodes: [{ id: "boom", type: "Broken", version: "1.0.0", config: {} }],
        edges: []
      }))
      const failing = yield* Runs.start("await-fails", { input: {} })
      const failure = yield* Runs.await(failing.runId, { pollInterval: "5 millis" }).pipe(
        TestClock.withLive,
        Effect.flip
      )
      assert.strictEqual(failure._tag, "NodeFailed")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("the run journal captures a queryable timeline", () =>
    Effect.gen(function*() {
      yield* savePlan(basePlan("journaled", {
        nodes: [
          {
            id: "prepare",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("ready") }
          },
          {
            id: "review",
            type: "workflow/humanTask",
            version: "1.0.0",
            config: { title: "Review", outcomes: ["approve", "reject"] }
          },
          {
            id: "unreached",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("never") }
          }
        ],
        edges: [
          { _tag: "ControlEdge", id: "e1", sourceNodeId: "prepare", targetNodeId: "review" },
          { _tag: "ControlEdge", id: "e2", sourceNodeId: "review", outcome: "reject", targetNodeId: "unreached" }
        ]
      }))

      const handle = yield* Runs.start("journaled", { input: {} })
      const tasks = yield* HumanTasks.HumanTasks
      let open = yield* tasks.list({ runId: handle.runId, state: "open" })
      for (let index = 0; index < 200 && open.length === 0; index++) {
        yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
        open = yield* tasks.list({ runId: handle.runId, state: "open" })
      }
      yield* tasks.complete(open[0]!.taskId, { outcome: "approve", output: null })
      yield* awaitStatus(handle.runId, (s) => s._tag !== "Running" && s._tag !== "Suspended")

      const entries = yield* RunJournal.timeline(handle.runId)
      const byTag = new Map(entries.map((entry) => [entry._tag, entry]))

      assert.isDefined(byTag.get("RunStarted"))
      assert.strictEqual(
        (byTag.get("TaskCreated") as Extract<RunJournal.Entry, { _tag: "TaskCreated" }>).nodeId,
        "review"
      )
      assert.strictEqual(
        (byTag.get("DecisionRecorded") as Extract<RunJournal.Entry, { _tag: "DecisionRecorded" }>).outcome,
        "approve"
      )
      assert.isDefined(byTag.get("RunSucceeded"))
      const nodeEntries = entries.filter((entry) => entry._tag === "NodeCompleted")
      assert.includeMembers(nodeEntries.map((entry) => entry.nodeId), ["prepare", "review"])
      const skippedEntries = entries.filter((entry) => entry._tag === "NodeSkipped")
      assert.deepStrictEqual(skippedEntries.map((entry) => entry.nodeId), ["unreached"])

      // A failed run records its typed failure.
      yield* savePlan(basePlan("journal-fails", {
        nodes: [{ id: "boom", type: "Broken", version: "1.0.0", config: {} }],
        edges: []
      }))
      const failing = yield* Runs.start("journal-fails", { input: {} })
      yield* awaitStatus(failing.runId, (s) => s._tag === "Failed")
      const failedEntries = yield* RunJournal.timeline(failing.runId)
      const terminal = failedEntries.find((entry) => entry._tag === "RunFailed")
      assert.isDefined(terminal)
      assert.strictEqual(
        ((terminal as Extract<RunJournal.Entry, { _tag: "RunFailed" }>).failure as { _tag: string })._tag,
        "NodeFailed"
      )
    }).pipe(Effect.provide(TestLayer)))
})
