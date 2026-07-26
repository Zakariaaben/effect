import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import * as DurableEngine from "../src/DurableEngine.ts"
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
// Vocabulary: one side-effecting step, then a human decision, then a mapping
// ----------------------------------------------------------------------------

let prepared = 0

const prepare = Node.make("Prepare", {
  version: "1.0.0",
  outputs: { reference: Port.output(Schema.String, { contract: "test/text" }) }
})

const registry = Registry.make(prepare, Builtins.HumanTask, Builtins.Transform)

const definition = Workflow.make("test/durable", {
  version: "1.0.0",
  contracts: { "test/text": Schema.String },
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
  "Prepare@1.0.0": () =>
    Effect.sync(() => {
      prepared++
      return { reference: `case-${prepared}` }
    })
}))

const plan = {
  formatVersion: 2,
  id: "durable-approval",
  revision: 1,
  definition: { id: "test/durable", version: "1.0.0" },
  outputs: [{ name: "verdict", contract: "*" }],
  nodes: [
    { id: "prepare", type: "Prepare", version: "1.0.0", config: {} },
    {
      id: "review",
      type: "workflow/humanTask",
      version: "1.0.0",
      config: {
        title: "Review the case",
        outcomes: ["approve", "reject"],
        payload: Expression.ref("nodes", "prepare", "reference")
      }
    },
    {
      id: "verdict",
      type: "workflow/transform",
      version: "1.0.0",
      config: {
        value: Expression.template(
          Expression.ref("nodes", "prepare", "reference"),
          ": ",
          Expression.ref("nodes", "review", "output")
        )
      }
    }
  ],
  edges: [
    { _tag: "ControlEdge", id: "p-r", sourceNodeId: "prepare", targetNodeId: "review" },
    { _tag: "ControlEdge", id: "ok", sourceNodeId: "review", outcome: "approve", targetNodeId: "verdict" },
    {
      _tag: "DataEdge",
      id: "out",
      source: { _tag: "NodeOutput", nodeId: "verdict", output: "value" },
      target: { _tag: "WorkflowOutput", output: "verdict" }
    }
  ]
}

// ----------------------------------------------------------------------------
// The restartable stack: everything durable lives in one SQLite file
// ----------------------------------------------------------------------------

const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() =>
      globalThis.crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>).then((buffer) =>
        new Uint8Array(buffer)
      )
    )
})

const appLayer = (filename: string) =>
  Engine.layer(definition).pipe(
    Layer.provideMerge(Layer.mergeAll(
      handlers,
      PlanStore.layerSql(),
      HumanTasks.layerSql()
    )),
    Layer.provideMerge(DurableEngine.layer({
      shardingConfig: {
        entityMessagePollInterval: 100,
        entityReplyPollInterval: 50,
        refreshAssignmentsInterval: 200,
        sendRetryInterval: 50,
        entityTerminationTimeout: 0
      }
    })),
    Layer.provideMerge(SqliteClient.layer({ filename })),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto)(webCrypto)),
    Layer.orDie
  )

type AppRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Layer.Success<ReturnType<typeof appLayer>>,
  never
>

const run = <A>(runtime: AppRuntime, effect: Effect.Effect<A, any, any>): Effect.Effect<A> =>
  Effect.promise(() => runtime.runPromise(effect as Effect.Effect<A, any, never>))

describe("Durability", () => {
  it.live("a run survives a full process restart over the same database", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "workflow-builder-durability-"))
      const file = join(directory, "workflows.db")

      // ----- process 1: admit the plan, start the run, reach the human wait
      const first = ManagedRuntime.make(appLayer(file))
      const runId = yield* run(
        first,
        Effect.gen(function*() {
          const compiled = yield* Compiler.compile(definition, plan)
          const store = yield* PlanStore.PlanStore
          yield* store.save(compiled)
          const handle = yield* Runs.start("durable-approval", {
            input: {},
            runKey: "restart-proof"
          })
          return handle.runId
        })
      )

      let taskId: string | undefined
      for (let index = 0; index < 200 && taskId === undefined; index++) {
        taskId = yield* run(
          first,
          Effect.gen(function*() {
            const tasks = yield* HumanTasks.HumanTasks
            const open = yield* tasks.list({ runId, state: "open" })
            return open[0]?.taskId
          })
        )
        if (taskId === undefined) {
          yield* Effect.sleep("50 millis")
        }
      }
      assert.isDefined(taskId)
      assert.strictEqual(prepared, 1)

      // ----- the crash: every fiber interrupted, all memory gone
      yield* Effect.promise(() => first.dispose())

      // ----- process 2: a fresh runtime over the same database file
      const second = ManagedRuntime.make(appLayer(file))

      const reloaded = yield* run(
        second,
        Effect.gen(function*() {
          const tasks = yield* HumanTasks.HumanTasks
          return yield* tasks.get(taskId!)
        })
      )
      assert.strictEqual(reloaded.state, "open")
      assert.strictEqual(reloaded.title, "Review the case")
      assert.strictEqual(reloaded.payload, "case-1")

      yield* run(
        second,
        Effect.gen(function*() {
          const tasks = yield* HumanTasks.HumanTasks
          yield* tasks.complete(taskId!, {
            outcome: "approve",
            output: "granted",
            completedBy: "alice"
          })
        })
      )

      let status = yield* run(second, Runs.status(runId))
      for (let index = 0; index < 400 && (status._tag === "Running" || status._tag === "Suspended"); index++) {
        yield* Effect.sleep("50 millis")
        status = yield* run(second, Runs.status(runId))
      }
      assert.strictEqual(status._tag, "Succeeded")
      assert.deepStrictEqual(
        (status as Extract<Runs.RunStatus, { _tag: "Succeeded" }>).value.outputs,
        { verdict: "case-1: granted" }
      )

      // The prepare step was replayed from its persisted result, never re-run.
      assert.strictEqual(prepared, 1)

      yield* Effect.promise(() => second.dispose())
    }), 60_000)
})
