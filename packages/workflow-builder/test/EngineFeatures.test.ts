import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
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

// ----------------------------------------------------------------------------
// Vocabulary
// ----------------------------------------------------------------------------

class BrokenStep extends Schema.TaggedErrorClass<BrokenStep>(
  "test/EngineFeatures/BrokenStep"
)("BrokenStep", {
  reason: Schema.String
}) {}

const probe = Node.make("Probe", {
  version: "1.0.0",
  outputs: { stamp: Port.output(Schema.String, { contract: Port.AnyContract }) }
})

const alwaysFails = Node.make("AlwaysFails", {
  version: "1.0.0",
  failure: BrokenStep
})

const hang = Node.make("Hang", {
  version: "1.0.0"
})

const double = Node.make("Double", {
  version: "1.0.0",
  inputs: { value: Port.input(Schema.Number, { contract: Port.AnyContract }) },
  outputs: { value: Port.output(Schema.Number, { contract: Port.AnyContract }) }
})

const registry = Registry.make(
  probe,
  alwaysFails,
  hang,
  double,
  Builtins.Transform,
  Builtins.HumanTask,
  Builtins.Receive,
  Builtins.Delay,
  Builtins.SubWorkflow,
  Builtins.ForEach,
  Builtins.Fail
)

const definition = Workflow.make("test/engine-features", {
  version: "1.0.0",
  inputs: {},
  outputs: {
    result: Port.input(Schema.Json, { contract: Port.AnyContract, required: false }),
    aux: Port.input(Schema.Json, { contract: Port.AnyContract, required: false }),
    extra: Port.input(Schema.Json, { contract: Port.AnyContract, required: false })
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

const executions = new Map<string, number>()

const bump = (key: string): number => {
  const next = (executions.get(key) ?? 0) + 1
  executions.set(key, next)
  return next
}

const handlers = registry.toLayer(registry.of({
  "Probe@1.0.0": ({ context }) =>
    Effect.sync(() => {
      bump(context.planId)
      return { stamp: "ran" }
    }),
  "AlwaysFails@1.0.0": ({ context }) =>
    Effect.suspend(() => Effect.fail(new BrokenStep({ reason: `attempt ${bump(context.planId)}` }))),
  "Hang@1.0.0": () => Effect.never,
  "Double@1.0.0": ({ inputs }) => Effect.succeed({ value: inputs.value * 2 })
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
// Helpers
// ----------------------------------------------------------------------------

const plan = (
  id: string,
  nodes: ReadonlyArray<unknown>,
  edges: ReadonlyArray<unknown>
): unknown => ({
  formatVersion: 2,
  id,
  revision: 1,
  definition: { id: definition.id, version: definition.version },
  nodes,
  edges
})

const savePlan = (document: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, document)
    const store = yield* PlanStore.PlanStore
    return yield* store.save(compiled)
  })

const sleepLive = Effect.sleep(10).pipe(TestClock.withLive)

/**
 * Polls a run until it reports the expected status. When `adjust` is given,
 * the test clock advances by that amount between polls so activity timeouts
 * and durable timers can fire regardless of when the run registers them.
 */
const awaitStatus = (
  runId: string,
  expected: Runs.RunStatus["_tag"],
  options?: { readonly adjust?: Duration.Input }
): Effect.Effect<Runs.RunStatus, never, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    let status = yield* Runs.status(runId)
    for (let index = 0; index < 200 && status._tag !== expected; index++) {
      if (options?.adjust !== undefined) {
        yield* TestClock.adjust(options.adjust)
      }
      yield* sleepLive
      status = yield* Runs.status(runId)
    }
    assert.strictEqual(status._tag, expected)
    return status
  })

const awaitSuccess = (
  runId: string,
  options?: { readonly adjust?: Duration.Input }
): Effect.Effect<Record<string, Schema.Json>, never, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const status = yield* awaitStatus(runId, "Succeeded", options)
    return status._tag === "Succeeded"
      ? status.value.outputs
      : yield* Effect.die("expected a successful run")
  })

const awaitTask = (
  runId: string
): Effect.Effect<HumanTasks.TaskItem, never, HumanTasks.HumanTasks> =>
  Effect.gen(function*() {
    const tasks = yield* HumanTasks.HumanTasks
    for (let index = 0; index < 200; index++) {
      const items = yield* tasks.list({ runId })
      if (items.length > 0) {
        return items[0]!
      }
      yield* sleepLive
    }
    return yield* Effect.die(`No task appeared for run '${runId}'`)
  })

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("EngineFeatures", () => {
  describe("human tasks", () => {
    it.effect("completes a work item end to end and routes its outcome", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("approval", [
          {
            id: "task",
            type: "workflow/humanTask",
            version: "1.0.0",
            config: {
              title: "Review document",
              outcomes: ["approve", "reject"],
              payload: Expression.record({ doc: Expression.ref("input", "doc") })
            }
          },
          {
            id: "approved",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("approved-path") }
          },
          {
            id: "rejected",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("rejected-path") }
          }
        ], [
          {
            _tag: "ControlEdge",
            id: "on-approve",
            sourceNodeId: "task",
            outcome: "approve",
            targetNodeId: "approved"
          },
          {
            _tag: "ControlEdge",
            id: "on-reject",
            sourceNodeId: "task",
            outcome: "reject",
            targetNodeId: "rejected"
          },
          {
            _tag: "DataEdge",
            id: "task-out",
            source: { _tag: "NodeOutput", nodeId: "task", output: "output" },
            target: { _tag: "WorkflowOutput", output: "result" }
          },
          {
            _tag: "DataEdge",
            id: "approved-out",
            source: { _tag: "NodeOutput", nodeId: "approved", output: "value" },
            target: { _tag: "WorkflowOutput", output: "aux" }
          },
          {
            _tag: "DataEdge",
            id: "rejected-out",
            source: { _tag: "NodeOutput", nodeId: "rejected", output: "value" },
            target: { _tag: "WorkflowOutput", output: "extra" }
          }
        ]))

        const run = yield* Runs.start("approval", { input: { doc: "spec.pdf" } })
        const task = yield* awaitTask(run.runId)

        assert.strictEqual(task.title, "Review document")
        assert.deepStrictEqual([...task.outcomes], ["approve", "reject"])
        assert.deepStrictEqual(task.payload, { doc: "spec.pdf" })
        assert.strictEqual(task.runId, run.runId)
        assert.strictEqual(task.planId, "approval")
        assert.strictEqual(task.state, "open")

        const tasks = yield* HumanTasks.HumanTasks
        const unknownOutcome = yield* tasks.complete(task.taskId, { outcome: "escalate" }).pipe(
          Effect.flip
        )
        assert(unknownOutcome._tag === "TaskOutcomeError")
        assert.deepStrictEqual([...unknownOutcome.allowed], ["approve", "reject"])

        yield* awaitStatus(run.runId, "Suspended")
        const completed = yield* tasks.complete(task.taskId, {
          outcome: "approve",
          output: { comment: "ship it" }
        })
        assert.strictEqual(completed.state, "completed")
        assert.strictEqual(completed.completion?.outcome, "approve")

        const again = yield* tasks.complete(task.taskId, { outcome: "approve" }).pipe(Effect.flip)
        assert(again._tag === "TaskStateError")
        assert.strictEqual(again.state, "completed")

        const outputs = yield* awaitSuccess(run.runId)
        assert.deepStrictEqual(outputs, {
          result: { comment: "ship it" },
          aux: "approved-path"
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("expires a work item past its deadline and routes the expired outcome", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        yield* savePlan(plan("expiring", [
          {
            id: "task",
            type: "workflow/humanTask",
            version: "1.0.0",
            config: {
              title: "Approve before the deadline",
              outcomes: ["approve"],
              dueInMillis: 5000
            }
          },
          {
            id: "onApprove",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("approved-path") }
          },
          {
            id: "onExpired",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("expired-path") }
          }
        ], [
          {
            _tag: "ControlEdge",
            id: "approve-edge",
            sourceNodeId: "task",
            outcome: "approve",
            targetNodeId: "onApprove"
          },
          {
            _tag: "ControlEdge",
            id: "expired-edge",
            sourceNodeId: "task",
            outcome: "expired",
            targetNodeId: "onExpired"
          },
          {
            _tag: "DataEdge",
            id: "task-out",
            source: { _tag: "NodeOutput", nodeId: "task", output: "output" },
            target: { _tag: "WorkflowOutput", output: "result" }
          },
          {
            _tag: "DataEdge",
            id: "approve-out",
            source: { _tag: "NodeOutput", nodeId: "onApprove", output: "value" },
            target: { _tag: "WorkflowOutput", output: "extra" }
          },
          {
            _tag: "DataEdge",
            id: "expired-out",
            source: { _tag: "NodeOutput", nodeId: "onExpired", output: "value" },
            target: { _tag: "WorkflowOutput", output: "aux" }
          }
        ]))

        const run = yield* Runs.start("expiring", { input: {} })
        const task = yield* awaitTask(run.runId)
        assert.deepStrictEqual([...task.outcomes], ["approve", "expired"])
        assert.strictEqual(task.dueAtMillis, task.createdAtMillis + 5000)

        const outputs = yield* awaitSuccess(run.runId, { adjust: "6 seconds" })
        assert.deepStrictEqual(outputs, { result: null, aux: "expired-path" })

        const tasks = yield* HumanTasks.HumanTasks
        const expired = yield* tasks.get(task.taskId)
        assert.strictEqual(expired.state, "expired")

        const late = yield* tasks.complete(task.taskId, { outcome: "approve" }).pipe(Effect.flip)
        assert(late._tag === "TaskStateError")
        assert.strictEqual(late.state, "expired")
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("signals", () => {
    it.effect("delivers an external signal payload first-wins", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("signalled", [
          {
            id: "recv",
            type: "workflow/receive",
            version: "1.0.0",
            config: { signal: "docReady" }
          }
        ], [
          {
            _tag: "DataEdge",
            id: "payload-out",
            source: { _tag: "NodeOutput", nodeId: "recv", output: "payload" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))

        const run = yield* Runs.start("signalled", { input: {} })
        yield* sleepLive
        yield* Runs.signal(run.runId, "docReady", { url: "first" })
        yield* Runs.signal(run.runId, "docReady", { url: "second" })

        const outputs = yield* awaitSuccess(run.runId)
        assert.deepStrictEqual(outputs, { result: { url: "first" } })

        // Redelivery after completion cannot replace the accepted payload.
        yield* Runs.signal(run.runId, "docReady", { url: "third" })
        const status = yield* Runs.status(run.runId)
        assert(status._tag === "Succeeded")
        assert.deepStrictEqual(status.value.outputs, { result: { url: "first" } })
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("timers", () => {
    it.effect("holds a delay node until the clock passes its duration", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("delayed", [
          {
            id: "wait",
            type: "workflow/delay",
            version: "1.0.0",
            config: { durationMillis: 5000 }
          },
          {
            id: "after",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.literal("woke") }
          }
        ], [
          {
            _tag: "ControlEdge",
            id: "wait-after",
            sourceNodeId: "wait",
            targetNodeId: "after"
          },
          {
            _tag: "DataEdge",
            id: "after-out",
            source: { _tag: "NodeOutput", nodeId: "after", output: "value" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))

        const run = yield* Runs.start("delayed", { input: {} })
        for (let index = 0; index < 5; index++) {
          yield* sleepLive
        }
        const before = yield* Runs.status(run.runId)
        assert.strictEqual(before._tag, "Running")

        const outputs = yield* awaitSuccess(run.runId, { adjust: "5001 millis" })
        assert.deepStrictEqual(outputs, { result: "woke" })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("fails the run with an attempt timeout after retries are exhausted", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("hanging", [
          {
            id: "stuck",
            type: "Hang",
            version: "1.0.0",
            config: {},
            policy: {
              retry: { maxAttempts: 1 },
              timeouts: { attemptMillis: 100 }
            }
          }
        ], []))

        const run = yield* Runs.start("hanging", { input: {} })
        const status = yield* awaitStatus(run.runId, "Failed", { adjust: "200 millis" })
        assert(status._tag === "Failed")
        assert(status.error._tag === "NodeTimedOut")
        assert.strictEqual(status.error.nodeId, "stuck")
        assert.strictEqual(status.error.kind, "attempt")
        assert.strictEqual(status.error.millis, 100)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("error routing", () => {
    it.effect("routes an exhausted typed failure through the error outcome", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("err-routed", [
          {
            id: "boom",
            type: "AlwaysFails",
            version: "1.0.0",
            config: {},
            policy: { retry: { maxAttempts: 2 } }
          },
          {
            id: "handle",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.ref("nodes", "boom", "error") }
          }
        ], [
          {
            _tag: "ControlEdge",
            id: "on-error",
            sourceNodeId: "boom",
            outcome: "error",
            targetNodeId: "handle"
          },
          {
            _tag: "DataEdge",
            id: "handle-out",
            source: { _tag: "NodeOutput", nodeId: "handle", output: "value" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))

        const result = yield* Runs.execute("err-routed", { input: {} })
        assert.deepStrictEqual(result.outputs, {
          result: { _tag: "BrokenStep", reason: "attempt 2" }
        })
        assert.strictEqual(executions.get("err-routed"), 2)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("sub-workflows", () => {
    it.effect("surfaces child outputs through the parent node's output port", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("child-ok", [
          {
            id: "emit",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.ref("input", "n") }
          }
        ], [
          {
            _tag: "DataEdge",
            id: "emit-out",
            source: { _tag: "NodeOutput", nodeId: "emit", output: "value" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))
        yield* savePlan(plan("parent-ok", [
          {
            id: "sub",
            type: "workflow/subWorkflow",
            version: "1.0.0",
            config: {
              plan: { planId: "child-ok" },
              input: Expression.record({ n: Expression.literal(21) })
            }
          }
        ], [
          {
            _tag: "DataEdge",
            id: "sub-out",
            source: { _tag: "NodeOutput", nodeId: "sub", output: "output" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))

        const result = yield* Runs.execute("parent-ok", { input: {} })
        assert.deepStrictEqual(result.outputs, { result: { result: 21 } })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("routes a failing child through the parent's error outcome", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("child-fail", [
          {
            id: "die",
            type: "workflow/fail",
            version: "1.0.0",
            config: { code: "CHILD_BOOM", message: "nope" }
          }
        ], []))
        yield* savePlan(plan("parent-fail", [
          {
            id: "sub",
            type: "workflow/subWorkflow",
            version: "1.0.0",
            config: { plan: { planId: "child-fail" } }
          },
          {
            id: "handle",
            type: "workflow/transform",
            version: "1.0.0",
            config: { value: Expression.ref("nodes", "sub", "error") }
          }
        ], [
          {
            _tag: "ControlEdge",
            id: "on-error",
            sourceNodeId: "sub",
            outcome: "error",
            targetNodeId: "handle"
          },
          {
            _tag: "DataEdge",
            id: "handle-out",
            source: { _tag: "NodeOutput", nodeId: "handle", output: "value" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))

        const result = yield* Runs.execute("parent-fail", { input: {} })
        assert.deepStrictEqual(result.outputs, {
          result: {
            _tag: "RunAborted",
            nodeId: "die",
            code: "CHILD_BOOM",
            message: "nope"
          }
        })
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("for-each", () => {
    const childDouble = plan("child-double", [
      {
        id: "dbl",
        type: "Double",
        version: "1.0.0",
        config: {},
        bindings: { value: Expression.ref("input", "item") }
      }
    ], [
      {
        _tag: "DataEdge",
        id: "dbl-out",
        source: { _tag: "NodeOutput", nodeId: "dbl", output: "value" },
        target: { _tag: "WorkflowOutput", output: "result" }
      }
    ])

    const forEachParent = (id: string, mode: "sequential" | "parallel"): unknown =>
      plan(id, [
        {
          id: "each",
          type: "workflow/forEach",
          version: "1.0.0",
          config: {
            items: Expression.literal([1, 2, 3]),
            plan: { planId: "child-double" },
            mode
          }
        }
      ], [
        {
          _tag: "DataEdge",
          id: "each-out",
          source: { _tag: "NodeOutput", nodeId: "each", output: "results" },
          target: { _tag: "WorkflowOutput", output: "result" }
        }
      ])

    it.effect("runs a child per item in parallel and aggregates results in order", () =>
      Effect.gen(function*() {
        yield* savePlan(childDouble)
        yield* savePlan(forEachParent("each-parallel", "parallel"))

        const result = yield* Runs.execute("each-parallel", { input: {} })
        assert.deepStrictEqual(result.outputs, {
          result: [{ result: 2 }, { result: 4 }, { result: 6 }]
        })
      }).pipe(Effect.provide(TestLayer)))

    it.effect("runs children sequentially with the same aggregated results", () =>
      Effect.gen(function*() {
        yield* savePlan(childDouble)
        yield* savePlan(forEachParent("each-sequential", "sequential"))

        const result = yield* Runs.execute("each-sequential", { input: {} })
        assert.deepStrictEqual(result.outputs, {
          result: [{ result: 2 }, { result: 4 }, { result: 6 }]
        })
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("cancellation", () => {
    it.effect("interrupts a suspended run and cancels its open work item", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("cancelling", [
          {
            id: "task",
            type: "workflow/humanTask",
            version: "1.0.0",
            config: { title: "Never completed", outcomes: ["ok"] }
          }
        ], []))

        const run = yield* Runs.start("cancelling", { input: {} })
        const task = yield* awaitTask(run.runId)
        yield* awaitStatus(run.runId, "Suspended")

        yield* Runs.cancel(run.runId)
        yield* awaitStatus(run.runId, "Interrupted")

        const tasks = yield* HumanTasks.HumanTasks
        const cancelled = yield* tasks.get(task.taskId)
        assert.strictEqual(cancelled.state, "cancelled")
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("replay determinism", () => {
    it.effect("replays committed activities without re-running their handlers", () =>
      Effect.gen(function*() {
        yield* savePlan(plan("replay", [
          { id: "count", type: "Probe", version: "1.0.0", config: {} },
          {
            id: "task",
            type: "workflow/humanTask",
            version: "1.0.0",
            config: { title: "Continue the run", outcomes: ["ok"] }
          }
        ], [
          {
            _tag: "ControlEdge",
            id: "count-task",
            sourceNodeId: "count",
            targetNodeId: "task"
          },
          {
            _tag: "DataEdge",
            id: "stamp-out",
            source: { _tag: "NodeOutput", nodeId: "count", output: "stamp" },
            target: { _tag: "WorkflowOutput", output: "aux" }
          },
          {
            _tag: "DataEdge",
            id: "task-out",
            source: { _tag: "NodeOutput", nodeId: "task", output: "output" },
            target: { _tag: "WorkflowOutput", output: "result" }
          }
        ]))

        const run = yield* Runs.start("replay", { input: {} })
        const task = yield* awaitTask(run.runId)
        yield* awaitStatus(run.runId, "Suspended")
        assert.strictEqual(executions.get("replay"), 1)

        const tasks = yield* HumanTasks.HumanTasks
        yield* tasks.complete(task.taskId, { outcome: "ok", output: "resumed" })

        const outputs = yield* awaitSuccess(run.runId)
        assert.deepStrictEqual(outputs, { result: "resumed", aux: "ran" })
        assert.strictEqual(executions.get("replay"), 1)
      }).pipe(Effect.provide(TestLayer)))
  })
})
