import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, layer } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Engine from "../src/Engine.ts"
import * as Expression from "../src/Expression.ts"
import * as HumanTasks from "../src/HumanTasks.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

// ----------------------------------------------------------------------------
// Vocabulary: the smallest definition that can admit plans
// ----------------------------------------------------------------------------

const registry = Registry.make(Builtins.Transform)

const definition = Workflow.make("test/sql-stores", {
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

const planDoc = (id: string, revision: number, marker: string): unknown => ({
  formatVersion: 2,
  id,
  revision,
  definition: { id: definition.id, version: definition.version },
  nodes: [
    {
      id: "emit",
      type: "workflow/transform",
      version: "1.0.0",
      config: { value: Expression.literal(marker) }
    }
  ],
  edges: []
})

const savePlan = (planId: string, revision: number, marker: string) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, planDoc(planId, revision, marker))
    const store = yield* PlanStore.PlanStore
    return yield* store.save(compiled)
  })

// ----------------------------------------------------------------------------
// Shared PlanStore scenarios, run against both implementations
// ----------------------------------------------------------------------------

const planListScenario = (prefix: string) =>
  Effect.gen(function*() {
    const store = yield* PlanStore.PlanStore
    yield* savePlan(`${prefix}-b`, 1, "b-one")
    const latestB = yield* savePlan(`${prefix}-b`, 2, "b-two")
    const onlyA = yield* savePlan(`${prefix}-a`, 1, "a-one")

    const listed = yield* store.list()
    // The store is shared with concurrently running tests, so assert on this
    // scenario's slice plus the global ordering invariant.
    const mine = listed.filter((summary) => summary.planId.startsWith(`${prefix}-`))
    assert.deepStrictEqual(mine, [
      { planId: `${prefix}-a`, latestRevision: 1, fingerprint: onlyA.fingerprint },
      { planId: `${prefix}-b`, latestRevision: 2, fingerprint: latestB.fingerprint }
    ])
    const ids = listed.map((summary) => summary.planId)
    assert.deepStrictEqual(ids, [...ids].sort())
  })

const planRevisionsScenario = (prefix: string) =>
  Effect.gen(function*() {
    const store = yield* PlanStore.PlanStore
    const second = yield* savePlan(`${prefix}-plan`, 2, "second")
    const first = yield* savePlan(`${prefix}-plan`, 1, "first")

    const history = yield* store.revisions(`${prefix}-plan`)
    assert.deepStrictEqual(history.map((stored) => stored.revision), [1, 2])
    assert.strictEqual(history[0]!.fingerprint, first.fingerprint)
    assert.strictEqual(history[1]!.fingerprint, second.fingerprint)
    assert.strictEqual(history[0]!.planId, `${prefix}-plan`)

    const missing = yield* store.revisions(`${prefix}-none`).pipe(Effect.flip)
    assert.strictEqual(missing._tag, "PlanNotFoundError")
    assert.strictEqual(missing.planId, `${prefix}-none`)
  })

// ----------------------------------------------------------------------------
// PlanStore over SQLite
// ----------------------------------------------------------------------------

const plansDb = join(mkdtempSync(join(tmpdir(), "workflow-builder-sqlstores-plans-")), "plans.db")

const planStoreSql = PlanStore.layerSql().pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: plansDb })),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto)),
  Layer.orDie
)

layer(planStoreSql)("PlanStore.layerSql", (it) => {
  it.effect("round-trips save, get, and latest", () =>
    Effect.gen(function*() {
      const store = yield* PlanStore.PlanStore
      const first = yield* savePlan("sqlrt-plan", 1, "one")
      const second = yield* savePlan("sqlrt-plan", 2, "two")

      const got = yield* store.get("sqlrt-plan", 1)
      assert.strictEqual(got.planId, "sqlrt-plan")
      assert.strictEqual(got.revision, 1)
      assert.strictEqual(got.fingerprint, first.fingerprint)
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(got.plan)),
        JSON.parse(JSON.stringify(first.plan))
      )

      const latest = yield* store.latest("sqlrt-plan")
      assert.strictEqual(latest.revision, 2)
      assert.strictEqual(latest.fingerprint, second.fingerprint)

      const missingRevision = yield* store.get("sqlrt-plan", 3).pipe(Effect.flip)
      assert.strictEqual(missingRevision._tag, "PlanNotFoundError")
      assert.strictEqual(missingRevision.revision, 3)

      const missingPlan = yield* store.latest("sqlrt-none").pipe(Effect.flip)
      assert.strictEqual(missingPlan._tag, "PlanNotFoundError")
      assert.strictEqual(missingPlan.planId, "sqlrt-none")
    }))

  it.effect("save is idempotent for identical content", () =>
    Effect.gen(function*() {
      const store = yield* PlanStore.PlanStore
      const admitted = yield* savePlan("sqlidem-plan", 1, "same")
      const redelivered = yield* savePlan("sqlidem-plan", 1, "same")
      assert.strictEqual(redelivered.fingerprint, admitted.fingerprint)
      assert.strictEqual(redelivered.revision, 1)

      const history = yield* store.revisions("sqlidem-plan")
      assert.strictEqual(history.length, 1)
    }))

  it.effect("save conflicts on divergent content under the same revision", () =>
    Effect.gen(function*() {
      const admitted = yield* savePlan("sqlconf-plan", 1, "original")
      const conflict = yield* savePlan("sqlconf-plan", 1, "tampered").pipe(Effect.flip)
      assert.strictEqual(conflict._tag, "PlanConflictError")
      assert(conflict._tag === "PlanConflictError")
      assert.strictEqual(conflict.planId, "sqlconf-plan")
      assert.strictEqual(conflict.revision, 1)
      assert.strictEqual(conflict.existing, admitted.fingerprint)
      assert.notStrictEqual(conflict.submitted, admitted.fingerprint)
    }))

  it.effect("lists each plan at its latest revision sorted by plan id", () => planListScenario("sqlist"))

  it.effect("returns a plan's ascending revision history", () => planRevisionsScenario("sqlhist"))
})

// ----------------------------------------------------------------------------
// PlanStore in memory: the new surface behaves identically
// ----------------------------------------------------------------------------

const planStoreMemory = PlanStore.layerMemory.pipe(
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

layer(planStoreMemory)("PlanStore.layerMemory", (it) => {
  it.effect("lists each plan at its latest revision sorted by plan id", () => planListScenario("memlist"))

  it.effect("returns a plan's ascending revision history", () => planRevisionsScenario("memhist"))
})

// ----------------------------------------------------------------------------
// Human tasks: tokens fabricated the way the engine would mint them
// ----------------------------------------------------------------------------

const decisionCodec = DurableDeferred.make("workflow-builder/task-decision", {
  success: Plan.Decision
})

const tokenFor = (executionId: string): DurableDeferred.Token =>
  DurableDeferred.tokenFromExecutionId(decisionCodec, {
    workflow: Engine.Run,
    executionId
  })

const createTask = (
  taskId: string,
  options?: {
    readonly runId?: string
    readonly title?: string
    readonly outcomes?: ReadonlyArray<string>
    readonly assignee?: string
    readonly candidateGroups?: ReadonlyArray<string>
  }
) =>
  Effect.gen(function*() {
    const tasks = yield* HumanTasks.HumanTasks
    return yield* tasks.create({
      taskId,
      runId: options?.runId ?? `${taskId}-run`,
      planId: "sql-stores",
      nodeId: "review",
      title: options?.title ?? "Review",
      outcomes: options?.outcomes ?? ["approve", "reject"],
      assignee: options?.assignee,
      candidateGroups: options?.candidateGroups,
      token: tokenFor(taskId)
    })
  })

// ----------------------------------------------------------------------------
// Shared HumanTasks scenarios, run against both implementations
// ----------------------------------------------------------------------------

const paginationScenario = (prefix: string) =>
  Effect.gen(function*() {
    const tasks = yield* HumanTasks.HumanTasks
    const runId = `${prefix}-run`
    yield* createTask(`${prefix}-a`, { runId, candidateGroups: ["ops"] })
    yield* createTask(`${prefix}-b`, { runId })
    yield* createTask(`${prefix}-c`, { runId, candidateGroups: ["ops"] })
    yield* createTask(`${prefix}-d`, { runId })
    yield* createTask(`${prefix}-e`, { runId, candidateGroups: ["ops"] })

    const all = yield* tasks.list({ runId })
    assert.deepStrictEqual(
      all.map((task) => task.taskId),
      [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`, `${prefix}-d`, `${prefix}-e`]
    )

    const firstPage = yield* tasks.list({ runId, limit: 2 })
    assert.deepStrictEqual(firstPage.map((task) => task.taskId), [`${prefix}-a`, `${prefix}-b`])

    const middlePage = yield* tasks.list({ runId, offset: 2, limit: 2 })
    assert.deepStrictEqual(middlePage.map((task) => task.taskId), [`${prefix}-c`, `${prefix}-d`])

    const tail = yield* tasks.list({ runId, offset: 4 })
    assert.deepStrictEqual(tail.map((task) => task.taskId), [`${prefix}-e`])

    const beyond = yield* tasks.list({ runId, offset: 5 })
    assert.deepStrictEqual(beyond, [])

    // Pagination applies after the candidate-group filter: page two of the
    // "ops" queue is its second member, not a filtered page-two of all rows.
    const opsSecond = yield* tasks.list({ runId, candidateGroup: "ops", offset: 1, limit: 1 })
    assert.deepStrictEqual(opsSecond.map((task) => task.taskId), [`${prefix}-c`])
  })

const reassignScenario = (prefix: string) =>
  Effect.gen(function*() {
    const tasks = yield* HumanTasks.HumanTasks
    const taskId = `${prefix}-task`
    const created = yield* createTask(taskId, { assignee: "alice" })
    assert.strictEqual(created.assignee, "alice")

    const routed = yield* tasks.reassign(taskId, "bob")
    assert.strictEqual(routed.assignee, "bob")
    assert.strictEqual(routed.state, "open")

    yield* tasks.claim(taskId, "carol")
    const moved = yield* tasks.reassign(taskId, "dave")
    assert.strictEqual(moved.assignee, "dave")
    assert.strictEqual(moved.state, "claimed")
    assert.strictEqual(moved.claimedBy, "carol")

    const reloaded = yield* tasks.get(taskId)
    assert.strictEqual(reloaded.assignee, "dave")
    assert.strictEqual(reloaded.state, "claimed")
    assert.strictEqual(reloaded.claimedBy, "carol")

    const cleared = yield* tasks.reassign(taskId, undefined)
    assert.strictEqual(cleared.assignee, undefined)
    const clearedReloaded = yield* tasks.get(taskId)
    assert.strictEqual(clearedReloaded.assignee, undefined)
    assert.strictEqual(clearedReloaded.claimedBy, "carol")

    yield* tasks.expire(taskId)
    const terminal = yield* tasks.reassign(taskId, "erin").pipe(Effect.flip)
    assert.strictEqual(terminal._tag, "TaskStateError")
    assert(terminal._tag === "TaskStateError")
    assert.strictEqual(terminal.state, "expired")

    const missing = yield* tasks.reassign(`${prefix}-missing`, "bob").pipe(Effect.flip)
    assert.strictEqual(missing._tag, "TaskNotFoundError")
  })

// ----------------------------------------------------------------------------
// HumanTasks over SQLite
// ----------------------------------------------------------------------------

const tasksDb = join(mkdtempSync(join(tmpdir(), "workflow-builder-sqlstores-tasks-")), "tasks.db")

const humanTasksSql = HumanTasks.layerSql().pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(SqliteClient.layer({ filename: tasksDb })),
  Layer.orDie
)

layer(humanTasksSql)("HumanTasks.layerSql", (it) => {
  it.effect("create is idempotent under redelivery", () =>
    Effect.gen(function*() {
      const tasks = yield* HumanTasks.HumanTasks
      const created = yield* createTask("sqlcreate-task", { title: "First delivery" })
      const redelivered = yield* tasks.create({
        taskId: "sqlcreate-task",
        runId: "sqlcreate-other-run",
        planId: "sql-stores",
        nodeId: "review",
        title: "Second delivery",
        outcomes: ["approve"],
        token: tokenFor("sqlcreate-task")
      })
      assert.strictEqual(redelivered.title, "First delivery")
      assert.strictEqual(redelivered.runId, created.runId)
      assert.strictEqual(redelivered.state, "open")

      const listed = yield* tasks.list({ runId: created.runId })
      assert.strictEqual(listed.length, 1)

      const missing = yield* tasks.get("sqlcreate-none").pipe(Effect.flip)
      assert.strictEqual(missing._tag, "TaskNotFoundError")
    }))

  it.effect("lists by run, state, assignee, claimedBy, and candidate group", () =>
    Effect.gen(function*() {
      const tasks = yield* HumanTasks.HumanTasks
      const runId = "sqlfilter-run"
      yield* createTask("sqlfilter-a", { runId, assignee: "alice", candidateGroups: ["ops"] })
      yield* createTask("sqlfilter-b", { runId, candidateGroups: ["legal", "ops"] })
      yield* createTask("sqlfilter-c", { runId, assignee: "bob" })
      yield* createTask("sqlfilter-other", {})
      yield* tasks.claim("sqlfilter-c", "carol")

      const byRun = yield* tasks.list({ runId })
      assert.deepStrictEqual(
        byRun.map((task) => task.taskId),
        ["sqlfilter-a", "sqlfilter-b", "sqlfilter-c"]
      )

      const open = yield* tasks.list({ runId, state: "open" })
      assert.deepStrictEqual(open.map((task) => task.taskId), ["sqlfilter-a", "sqlfilter-b"])

      const byAssignee = yield* tasks.list({ runId, assignee: "alice" })
      assert.deepStrictEqual(byAssignee.map((task) => task.taskId), ["sqlfilter-a"])

      const byClaimer = yield* tasks.list({ runId, claimedBy: "carol" })
      assert.deepStrictEqual(byClaimer.map((task) => task.taskId), ["sqlfilter-c"])
      assert.strictEqual(byClaimer[0]!.state, "claimed")

      const byGroup = yield* tasks.list({ runId, candidateGroup: "legal" })
      assert.deepStrictEqual(byGroup.map((task) => task.taskId), ["sqlfilter-b"])
    }))

  it.effect("paginates after every filter with a deterministic order", () => paginationScenario("sqlpage"))

  it.effect("claim and release manage the claim lifecycle", () =>
    Effect.gen(function*() {
      const tasks = yield* HumanTasks.HumanTasks
      const taskId = "sqlclaim-task"
      yield* createTask(taskId)

      const releasedEarly = yield* tasks.release(taskId).pipe(Effect.flip)
      assert.strictEqual(releasedEarly._tag, "TaskStateError")
      assert(releasedEarly._tag === "TaskStateError")
      assert.strictEqual(releasedEarly.state, "open")

      const claimed = yield* tasks.claim(taskId, "alice")
      assert.strictEqual(claimed.state, "claimed")
      assert.strictEqual(claimed.claimedBy, "alice")

      const reclaimed = yield* tasks.claim(taskId, "bob").pipe(Effect.flip)
      assert.strictEqual(reclaimed._tag, "TaskStateError")
      assert(reclaimed._tag === "TaskStateError")
      assert.strictEqual(reclaimed.state, "claimed")

      const released = yield* tasks.release(taskId)
      assert.strictEqual(released.state, "open")
      assert.strictEqual(released.claimedBy, undefined)
      const reloaded = yield* tasks.get(taskId)
      assert.strictEqual(reloaded.state, "open")
      assert.strictEqual(reloaded.claimedBy, undefined)

      const missing = yield* tasks.claim("sqlclaim-none", "alice").pipe(Effect.flip)
      assert.strictEqual(missing._tag, "TaskNotFoundError")
    }))

  it.effect("reassigns open and claimed work without touching state or claim", () => reassignScenario("sqlassign"))

  it.effect("complete records the canonical decision exactly once", () =>
    Effect.gen(function*() {
      const tasks = yield* HumanTasks.HumanTasks
      const taskId = "sqlcomplete-task"
      yield* createTask(taskId)

      const badOutcome = yield* tasks.complete(taskId, { outcome: "escalate" }).pipe(Effect.flip)
      assert.strictEqual(badOutcome._tag, "TaskOutcomeError")
      assert(badOutcome._tag === "TaskOutcomeError")
      assert.deepStrictEqual([...badOutcome.allowed], ["approve", "reject"])

      const completed = yield* tasks.complete(taskId, {
        outcome: "approve",
        output: { note: "ship it" },
        completedBy: "alice"
      })
      assert.strictEqual(completed.state, "completed")
      assert.strictEqual(completed.completion?.outcome, "approve")
      assert.deepStrictEqual(completed.completion?.output, { note: "ship it" })
      assert.strictEqual(completed.completion?.completedBy, "alice")

      const persisted = yield* tasks.get(taskId)
      assert.strictEqual(persisted.state, "completed")
      assert.strictEqual(persisted.completion?.outcome, "approve")
      assert.deepStrictEqual(persisted.completion?.output, { note: "ship it" })

      const again = yield* tasks.complete(taskId, { outcome: "approve" }).pipe(Effect.flip)
      assert.strictEqual(again._tag, "TaskStateError")
      assert(again._tag === "TaskStateError")
      assert.strictEqual(again.state, "completed")
    }))

  it.effect("complete loses a first-wins race and reconciles the projection", () =>
    Effect.gen(function*() {
      const tasks = yield* HumanTasks.HumanTasks

      // The deadline already resolved the decision: the projection reconciles
      // to expired and the late completion reports the conflict.
      const expiredId = "sqlrace-expired"
      yield* createTask(expiredId)
      yield* DurableDeferred.resolve(decisionCodec, {
        token: tokenFor(expiredId),
        exit: Exit.succeed({ outcome: HumanTasks.ExpiredOutcome, output: null })
      })
      const lostToDeadline = yield* tasks.complete(expiredId, { outcome: "approve" }).pipe(Effect.flip)
      assert.strictEqual(lostToDeadline._tag, "TaskStateError")
      assert(lostToDeadline._tag === "TaskStateError")
      assert.strictEqual(lostToDeadline.state, "expired")
      const expired = yield* tasks.get(expiredId)
      assert.strictEqual(expired.state, "expired")
      assert.strictEqual(expired.completion, undefined)

      // Another decision is already canonical: the projection reconciles to
      // it rather than the losing completion.
      const decidedId = "sqlrace-decided"
      yield* createTask(decidedId)
      yield* DurableDeferred.resolve(decisionCodec, {
        token: tokenFor(decidedId),
        exit: Exit.succeed({ outcome: "reject", output: "needs work" })
      })
      const lostToOperator = yield* tasks.complete(decidedId, { outcome: "approve" }).pipe(Effect.flip)
      assert.strictEqual(lostToOperator._tag, "TaskStateError")
      assert(lostToOperator._tag === "TaskStateError")
      assert.strictEqual(lostToOperator.state, "completed")
      const reconciled = yield* tasks.get(decidedId)
      assert.strictEqual(reconciled.state, "completed")
      assert.strictEqual(reconciled.completion?.outcome, "reject")
      assert.strictEqual(reconciled.completion?.output, "needs work")
      assert.strictEqual(reconciled.completion?.completedBy, undefined)
    }))

  it.effect("expire is idempotent and cancelByRun sweeps live work items", () =>
    Effect.gen(function*() {
      const tasks = yield* HumanTasks.HumanTasks
      const runId = "sqlsweep-run"
      yield* createTask("sqlsweep-a", { runId })
      yield* createTask("sqlsweep-b", { runId })
      yield* createTask("sqlsweep-c", { runId })
      yield* createTask("sqlsweep-other")
      yield* tasks.claim("sqlsweep-b", "alice")

      const expired = yield* tasks.expire("sqlsweep-a")
      assert.strictEqual(expired.state, "expired")
      const expiredAgain = yield* tasks.expire("sqlsweep-a")
      assert.strictEqual(expiredAgain.state, "expired")

      yield* tasks.cancelByRun(runId)
      const after = yield* tasks.list({ runId })
      assert.deepStrictEqual(
        after.map((task) => [task.taskId, task.state]),
        [
          ["sqlsweep-a", "expired"],
          ["sqlsweep-b", "cancelled"],
          ["sqlsweep-c", "cancelled"]
        ]
      )

      const untouched = yield* tasks.get("sqlsweep-other")
      assert.strictEqual(untouched.state, "open")

      const missing = yield* tasks.expire("sqlsweep-none").pipe(Effect.flip)
      assert.strictEqual(missing._tag, "TaskNotFoundError")
    }))
})

// ----------------------------------------------------------------------------
// HumanTasks in memory: the new surface behaves identically
// ----------------------------------------------------------------------------

const humanTasksMemory = HumanTasks.layerMemory.pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory)
)

layer(humanTasksMemory)("HumanTasks.layerMemory", (it) => {
  it.effect("paginates after every filter with a deterministic order", () => paginationScenario("mempage"))

  it.effect("reassigns open and claimed work without touching state or claim", () => reassignScenario("memassign"))
})
