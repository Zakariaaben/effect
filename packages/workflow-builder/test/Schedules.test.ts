import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import * as Cron from "effect/Cron"
import * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Compiler from "../src/Compiler.ts"
import * as Engine from "../src/Engine.ts"
import * as HumanTasks from "../src/HumanTasks.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Runs from "../src/Runs.ts"
import * as Schedules from "../src/Schedules.ts"
import * as Workflow from "../src/Workflow.ts"

// ----------------------------------------------------------------------------
// Vocabulary: one stamping step whose executions are counted per plan revision
// ----------------------------------------------------------------------------

const stamp = Node.make("Stamp", {
  version: "1.0.0",
  outputs: { stamp: Port.output(Schema.String, { contract: Port.AnyContract }) }
})

const registry = Registry.make(stamp)

const definition = Workflow.make("test/schedules", {
  version: "1.0.0",
  inputs: {},
  outputs: {
    result: Port.input(Schema.Json, { contract: Port.AnyContract, required: false })
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

// Tests run concurrently, so every counter is keyed by (planId, revision) —
// each test uses its own plan ids.
const runCounts = new Map<string, number>()

const countKey = (planId: string, revision: number): string => `${planId}@${revision}`

const handlers = registry.toLayer(registry.of({
  "Stamp@1.0.0": ({ context }) =>
    Effect.sync(() => {
      const key = countKey(context.planId, context.planRevision)
      const count = (runCounts.get(key) ?? 0) + 1
      runCounts.set(key, count)
      return { stamp: `${key}#${count}` }
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

const stack = (options?: { readonly pollInterval?: Duration.Input }) =>
  Layer.mergeAll(Schedules.runner(options), Engine.layer(definition)).pipe(
    Layer.provideMerge(Layer.mergeAll(
      handlers,
      PlanStore.layerMemory,
      HumanTasks.layerMemory,
      Schedules.layerMemory
    )),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
  )

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const everyMinute = Cron.parseUnsafe("* * * * *", "UTC")

const stampPlan = (id: string, revision: number): unknown => ({
  formatVersion: 2,
  id,
  revision,
  definition: { id: definition.id, version: definition.version },
  nodes: [{ id: "stamp", type: "Stamp", version: "1.0.0", config: {} }],
  edges: [{
    _tag: "DataEdge",
    id: "out",
    source: { _tag: "NodeOutput", nodeId: "stamp", output: "stamp" },
    target: { _tag: "WorkflowOutput", output: "result" }
  }]
})

const savePlan = (document: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, document)
    const store = yield* PlanStore.PlanStore
    return yield* store.save(compiled)
  })

const sleepLive = Effect.sleep(10).pipe(TestClock.withLive)

/** Advances the test clock second by second until the keyed run count reaches `expected`. */
const awaitCount = (key: string, expected: number) =>
  Effect.gen(function*() {
    for (let index = 0; index < 150 && (runCounts.get(key) ?? 0) < expected; index++) {
      yield* TestClock.adjust("1 second")
      yield* sleepLive
    }
    assert.strictEqual(runCounts.get(key) ?? 0, expected)
  })

const awaitStatus = (runId: string, done: (status: Runs.RunStatus) => boolean) =>
  Effect.gen(function*() {
    let status = yield* Runs.status(runId)
    for (let index = 0; index < 200 && !done(status); index++) {
      yield* sleepLive
      status = yield* Runs.status(runId)
    }
    return status
  })

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("Schedules", () => {
  describe("store", () => {
    it.effect("creates, reads, toggles, and removes schedules", () =>
      Effect.gen(function*() {
        const schedules = yield* Schedules.Schedules
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

        const created = yield* schedules.create({
          scheduleId: "store-a",
          planId: "plan-a",
          cron: "* * * * *"
        })
        assert.strictEqual(created.enabled, true)
        assert.deepStrictEqual(created.input, {})
        assert.strictEqual(created.createdAtMillis, now)
        assert.isUndefined(created.revision)
        assert.isUndefined(created.lastFireTimeMillis)

        const pinned = yield* schedules.create({
          scheduleId: "store-b",
          planId: "plan-b",
          revision: 2,
          cron: "0 12 * * *",
          input: { flavor: "vanilla" },
          enabled: false
        })
        assert.strictEqual(pinned.revision, 2)
        assert.strictEqual(pinned.enabled, false)
        assert.deepStrictEqual(pinned.input, { flavor: "vanilla" })

        assert.deepStrictEqual(yield* schedules.get("store-a"), created)
        assert.deepStrictEqual(
          (yield* schedules.list()).map((schedule) => schedule.scheduleId),
          ["store-a", "store-b"]
        )

        const disabled = yield* schedules.disable("store-a")
        assert.strictEqual(disabled.enabled, false)
        assert.strictEqual((yield* schedules.get("store-a")).enabled, false)
        const enabled = yield* schedules.enable("store-a")
        assert.strictEqual(enabled.enabled, true)

        yield* schedules.remove("store-a")
        const missing = yield* schedules.get("store-a").pipe(Effect.flip)
        assert.strictEqual(missing._tag, "ScheduleNotFoundError")
        assert.deepStrictEqual(
          (yield* schedules.list()).map((schedule) => schedule.scheduleId),
          ["store-b"]
        )
      }).pipe(Effect.provide(Schedules.layerMemory)))

    it.effect("rejects duplicate schedule ids and invalid cron expressions", () =>
      Effect.gen(function*() {
        const schedules = yield* Schedules.Schedules
        yield* schedules.create({ scheduleId: "dup", planId: "plan", cron: "* * * * *" })

        const conflict = yield* schedules.create({
          scheduleId: "dup",
          planId: "other",
          cron: "0 0 * * *"
        }).pipe(Effect.flip)
        assert.strictEqual(conflict._tag, "ScheduleConflictError")
        assert.strictEqual((conflict as Schedules.ScheduleConflictError).scheduleId, "dup")

        const invalid = yield* schedules.create({
          scheduleId: "bad",
          planId: "plan",
          cron: "every minute"
        }).pipe(Effect.flip)
        assert.strictEqual(invalid._tag, "InvalidCronError")
        // A rejected schedule is never stored.
        const missing = yield* schedules.get("bad").pipe(Effect.flip)
        assert.strictEqual(missing._tag, "ScheduleNotFoundError")
      }).pipe(Effect.provide(Schedules.layerMemory)))

    it.effect("fails typed on missing schedules", () =>
      Effect.gen(function*() {
        const schedules = yield* Schedules.Schedules
        assert.strictEqual((yield* schedules.get("nope").pipe(Effect.flip))._tag, "ScheduleNotFoundError")
        assert.strictEqual((yield* schedules.enable("nope").pipe(Effect.flip))._tag, "ScheduleNotFoundError")
        assert.strictEqual((yield* schedules.disable("nope").pipe(Effect.flip))._tag, "ScheduleNotFoundError")
        assert.strictEqual((yield* schedules.remove("nope").pipe(Effect.flip))._tag, "ScheduleNotFoundError")
        assert.strictEqual(
          (yield* schedules.recordFire("nope", 0).pipe(Effect.flip))._tag,
          "ScheduleNotFoundError"
        )
      }).pipe(Effect.provide(Schedules.layerMemory)))

    it.effect("computes due schedules from creation time, recorded fires, and the enabled flag", () =>
      Effect.gen(function*() {
        const schedules = yield* Schedules.Schedules
        const created = yield* schedules.create({
          scheduleId: "due-a",
          planId: "plan",
          cron: "* * * * *"
        })
        const first = Cron.next(everyMinute, created.createdAtMillis).getTime()

        assert.deepStrictEqual(yield* schedules.due(first - 1), [])
        assert.deepStrictEqual(
          (yield* schedules.due(first)).map((schedule) => schedule.scheduleId),
          ["due-a"]
        )

        yield* schedules.disable("due-a")
        assert.deepStrictEqual(yield* schedules.due(first), [])
        yield* schedules.enable("due-a")
        assert.deepStrictEqual(
          (yield* schedules.due(first)).map((schedule) => schedule.scheduleId),
          ["due-a"]
        )

        yield* schedules.recordFire("due-a", first)
        assert.deepStrictEqual(yield* schedules.due(first), [])
        const second = Cron.next(everyMinute, first).getTime()
        assert.deepStrictEqual(
          (yield* schedules.due(second)).map((schedule) => schedule.scheduleId),
          ["due-a"]
        )

        // recordFire is monotonic: replaying an older fire cannot rewind.
        yield* schedules.recordFire("due-a", second)
        yield* schedules.recordFire("due-a", first)
        assert.strictEqual((yield* schedules.get("due-a")).lastFireTimeMillis, second)
      }).pipe(Effect.provide(Schedules.layerMemory)))
  })

  describe("runner", () => {
    it.effect("fires one idempotent run per elapsed occurrence", () =>
      Effect.gen(function*() {
        const planId = "sched-once"
        const key = countKey(planId, 1)
        yield* savePlan(stampPlan(planId, 1))
        const schedules = yield* Schedules.Schedules
        yield* schedules.create({ scheduleId: "once", planId, cron: "* * * * *" })

        yield* awaitCount(key, 1)

        // Staying inside the same minute cannot fire again.
        for (let index = 0; index < 10; index++) {
          yield* TestClock.adjust("1 second")
          yield* sleepLive
        }
        assert.strictEqual(runCounts.get(key), 1)

        // The fire-time-derived run key joins the runner's own run instead of
        // starting a second one.
        const fired = yield* schedules.get("once")
        assert.isDefined(fired.lastFireTimeMillis)
        const handle = yield* Runs.start(planId, {
          runKey: JSON.stringify(["schedule", "once", fired.lastFireTimeMillis])
        })
        const status = yield* awaitStatus(handle.runId, (current) => current._tag === "Succeeded")
        assert.strictEqual(status._tag, "Succeeded")
        assert.deepStrictEqual(
          (status as Extract<Runs.RunStatus, { _tag: "Succeeded" }>).value.outputs,
          { result: `${key}#1` }
        )
        assert.strictEqual(runCounts.get(key), 1)
      }).pipe(Effect.provide(stack())))

    it.effect("does not fire disabled schedules", () =>
      Effect.gen(function*() {
        const planId = "sched-disabled"
        yield* savePlan(stampPlan(planId, 1))
        const schedules = yield* Schedules.Schedules
        yield* schedules.create({
          scheduleId: "disabled",
          planId,
          cron: "* * * * *",
          enabled: false
        })

        // Cross several occurrences: nothing may fire.
        for (let index = 0; index < 70; index++) {
          yield* TestClock.adjust("2 seconds")
          yield* sleepLive
        }
        assert.isUndefined(runCounts.get(countKey(planId, 1)))
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        assert.deepStrictEqual(yield* schedules.due(now), [])
      }).pipe(Effect.provide(stack())))

    it.effect("collapses missed occurrences into a single fire for the latest one", () =>
      Effect.gen(function*() {
        const planId = "sched-missed"
        const key = countKey(planId, 1)
        yield* savePlan(stampPlan(planId, 1))
        const schedules = yield* Schedules.Schedules
        const created = yield* schedules.create({
          scheduleId: "missed",
          planId,
          cron: "* * * * *"
        })

        // Five minutes elapse before the runner's next poll.
        yield* TestClock.adjust("5 minutes")
        for (let index = 0; index < 200 && (runCounts.get(key) ?? 0) < 1; index++) {
          yield* sleepLive
        }
        assert.strictEqual(runCounts.get(key), 1)

        const fired = yield* schedules.get("missed")
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const firstOccurrence = Cron.next(everyMinute, created.createdAtMillis).getTime()
        assert.isDefined(fired.lastFireTimeMillis)
        // The single fire targeted the LATEST elapsed occurrence, not the first.
        assert.isAbove(fired.lastFireTimeMillis!, firstOccurrence)
        assert.isAtMost(fired.lastFireTimeMillis!, now)
        assert.isAbove(Cron.next(everyMinute, fired.lastFireTimeMillis!).getTime(), now)
        assert.strictEqual(runCounts.get(key), 1)
      }).pipe(Effect.provide(stack({ pollInterval: "5 minutes" }))))

    it.effect("logs and continues when a schedule references a missing plan", () =>
      Effect.gen(function*() {
        const planId = "sched-alive"
        yield* savePlan(stampPlan(planId, 1))
        const schedules = yield* Schedules.Schedules
        yield* schedules.create({ scheduleId: "ghost", planId: "no-such-plan", cron: "* * * * *" })
        yield* schedules.create({ scheduleId: "alive", planId, cron: "* * * * *" })

        // The healthy schedule fires even though the other one cannot start.
        yield* awaitCount(countKey(planId, 1), 1)

        // The missing-plan fire was consumed instead of retrying forever.
        let ghost = yield* schedules.get("ghost")
        for (let index = 0; index < 200 && ghost.lastFireTimeMillis === undefined; index++) {
          yield* sleepLive
          ghost = yield* schedules.get("ghost")
        }
        assert.isDefined(ghost.lastFireTimeMillis)
      }).pipe(Effect.provide(stack())))

    it.effect("runs the pinned revision, or the latest when unpinned, over the full stack", () =>
      Effect.gen(function*() {
        const planId = "sched-revisions"
        yield* savePlan(stampPlan(planId, 1))
        yield* savePlan(stampPlan(planId, 2))
        const schedules = yield* Schedules.Schedules
        yield* schedules.create({ scheduleId: "pinned", planId, revision: 1, cron: "* * * * *" })
        yield* schedules.create({ scheduleId: "latest", planId, cron: "* * * * *" })

        yield* awaitCount(countKey(planId, 1), 1)
        yield* awaitCount(countKey(planId, 2), 1)

        assert.strictEqual(runCounts.get(countKey(planId, 1)), 1)
        assert.strictEqual(runCounts.get(countKey(planId, 2)), 1)
      }).pipe(Effect.provide(stack())))
  })

  describe("sql", () => {
    const sqliteLayer = () => {
      const directory = mkdtempSync(join(tmpdir(), "workflow-builder-schedules-"))
      return Schedules.layerSql().pipe(
        Layer.provideMerge(SqliteClient.layer({ filename: join(directory, "schedules.db") })),
        Layer.orDie
      )
    }

    it.effect("roundtrips schedule state over sqlite", () =>
      Effect.gen(function*() {
        const schedules = yield* Schedules.Schedules

        const created = yield* schedules.create({
          scheduleId: "sql-a",
          planId: "plan-a",
          revision: 3,
          cron: "* * * * *",
          input: { n: 1 }
        })
        assert.strictEqual(created.revision, 3)
        assert.deepStrictEqual(created.input, { n: 1 })

        const conflict = yield* schedules.create({
          scheduleId: "sql-a",
          planId: "other",
          cron: "* * * * *"
        }).pipe(Effect.flip)
        assert.strictEqual(conflict._tag, "ScheduleConflictError")

        const invalid = yield* schedules.create({
          scheduleId: "sql-bad",
          planId: "plan-a",
          cron: "61 * * * *"
        }).pipe(Effect.flip)
        assert.strictEqual(invalid._tag, "InvalidCronError")

        assert.deepStrictEqual(yield* schedules.get("sql-a"), created)

        yield* schedules.create({
          scheduleId: "sql-b",
          planId: "plan-b",
          cron: "0 12 * * *",
          enabled: false
        })
        assert.deepStrictEqual(
          (yield* schedules.list()).map((schedule) => schedule.scheduleId),
          ["sql-a", "sql-b"]
        )

        const first = Cron.next(everyMinute, created.createdAtMillis).getTime()
        assert.deepStrictEqual(yield* schedules.due(first - 1), [])
        // Only the enabled schedule is due.
        assert.deepStrictEqual(
          (yield* schedules.due(first)).map((schedule) => schedule.scheduleId),
          ["sql-a"]
        )

        yield* schedules.recordFire("sql-a", first)
        assert.strictEqual((yield* schedules.get("sql-a")).lastFireTimeMillis, first)
        assert.deepStrictEqual(yield* schedules.due(first), [])
        // recordFire is monotonic: replaying an older fire cannot rewind.
        yield* schedules.recordFire("sql-a", first - 60_000)
        assert.strictEqual((yield* schedules.get("sql-a")).lastFireTimeMillis, first)

        const enabled = yield* schedules.enable("sql-b")
        assert.strictEqual(enabled.enabled, true)
        const disabled = yield* schedules.disable("sql-b")
        assert.strictEqual(disabled.enabled, false)

        yield* schedules.remove("sql-b")
        assert.strictEqual(
          (yield* schedules.get("sql-b").pipe(Effect.flip))._tag,
          "ScheduleNotFoundError"
        )
        assert.strictEqual(
          (yield* schedules.remove("sql-b").pipe(Effect.flip))._tag,
          "ScheduleNotFoundError"
        )
      }).pipe(Effect.provide(sqliteLayer())))
  })
})
