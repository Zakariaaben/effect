/**
 * Durable human work items backing the `workflow/humanTask` built-in.
 *
 * The engine creates a work item when a human-task node activates and then
 * suspends durably on a deferred decision. This service is the application's
 * window onto that wait: it lists and completes work items, validates that a
 * completion selects one of the configured outcomes, and races correctly
 * against a configured expiration deadline — first decision wins, exactly
 * once, across crashes and redelivery.
 *
 * Assignment, forms, and notification remain application concerns: `form`
 * travels opaquely and `assignee`/`candidateGroups` are plain data for the
 * application's own directory and authorization model.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Json from "./internal/json.ts"
import * as Plan from "./Plan.ts"

/**
 * The decision recorded when a work item concludes.
 *
 * **Details**
 *
 * This is {@link Plan.Decision}: the same wire vocabulary every externally
 * completed node uses, so the decision value — not the task record — is the
 * replayed authority for the run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Decision = Plan.Decision

/**
 * The decoded type of {@link Decision}.
 *
 * @category models
 * @since 4.0.0
 */
export type Decision = Plan.Decision

/**
 * The outcome recorded when an expiration deadline wins the decision race.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExpiredOutcome = Plan.ExpiredOutcome

/**
 * Lifecycle state of a work item.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskState = "open" | "claimed" | "completed" | "expired" | "cancelled"

/**
 * A durable human work item.
 *
 * @category models
 * @since 4.0.0
 */
export interface TaskItem {
  readonly taskId: string
  readonly runId: string
  readonly planId: string
  readonly nodeId: string
  readonly title: string
  readonly description: string | undefined
  readonly outcomes: ReadonlyArray<string>
  readonly form: Schema.Json | undefined
  readonly payload: Schema.Json | undefined
  readonly assignee: string | undefined
  readonly candidateGroups: ReadonlyArray<string>
  readonly createdAtMillis: number
  readonly dueAtMillis: number | undefined
  readonly state: TaskState
  readonly claimedBy: string | undefined
  readonly completion: TaskCompletion | undefined
  readonly token: string
}

/**
 * The completion facts of a concluded work item.
 *
 * @category models
 * @since 4.0.0
 */
export interface TaskCompletion {
  readonly outcome: string
  readonly output: Schema.Json
  readonly completedBy: string | undefined
  readonly completedAtMillis: number
}

/**
 * Request creating a work item; issued by the engine inside an activity.
 *
 * @category models
 * @since 4.0.0
 */
export interface CreateRequest {
  readonly taskId: string
  readonly runId: string
  readonly planId: string
  readonly nodeId: string
  readonly title: string
  readonly description?: string | undefined
  readonly outcomes: ReadonlyArray<string>
  readonly form?: Schema.Json | undefined
  readonly payload?: Schema.Json | undefined
  readonly assignee?: string | undefined
  readonly candidateGroups?: ReadonlyArray<string> | undefined
  readonly dueAtMillis?: number | undefined
  readonly token: string
}

/**
 * Filter for listing work items.
 *
 * **Details**
 *
 * `limit` and `offset` paginate the listing after every other filter —
 * including `candidateGroup` — has been applied, over the deterministic
 * created-at/task-id ordering, so pages are stable across implementations.
 *
 * @category models
 * @since 4.0.0
 */
export interface TaskFilter {
  readonly runId?: string | undefined
  readonly state?: TaskState | undefined
  readonly assignee?: string | undefined
  readonly claimedBy?: string | undefined
  readonly candidateGroup?: string | undefined
  readonly limit?: number | undefined
  readonly offset?: number | undefined
}

/**
 * Raised when a referenced work item does not exist.
 *
 * @category errors
 * @since 4.0.0
 */
export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>(
  "@effect/workflow-builder/HumanTasks/TaskNotFoundError"
)("TaskNotFoundError", {
  taskId: Schema.String
}) {}

/**
 * Raised when an operation is invalid for the work item's current state.
 *
 * @category errors
 * @since 4.0.0
 */
export class TaskStateError extends Schema.TaggedErrorClass<TaskStateError>(
  "@effect/workflow-builder/HumanTasks/TaskStateError"
)("TaskStateError", {
  taskId: Schema.String,
  state: Schema.Literals(["open", "claimed", "completed", "expired", "cancelled"])
}) {}

/**
 * Raised when a completion selects an outcome the task does not offer.
 *
 * @category errors
 * @since 4.0.0
 */
export class TaskOutcomeError extends Schema.TaggedErrorClass<TaskOutcomeError>(
  "@effect/workflow-builder/HumanTasks/TaskOutcomeError"
)("TaskOutcomeError", {
  taskId: Schema.String,
  outcome: Schema.String,
  allowed: Schema.Array(Schema.String)
}) {}

/**
 * Service managing durable human work items.
 *
 * **Details**
 *
 * `complete` validates the selected outcome and resolves the run's decision
 * deferred first-wins: a completion racing an expiration deadline observes
 * the canonical decision and reports a conflict instead of silently losing.
 * `create` and `expire` are engine-facing and idempotent under redelivery.
 * `reassign` routes an open or claimed item to a different assignee — or
 * clears the assignment — without touching its state or claim.
 *
 * @category services
 * @since 4.0.0
 */
export class HumanTasks extends Context.Service<HumanTasks, {
  readonly create: (request: CreateRequest) => Effect.Effect<TaskItem>
  readonly get: (taskId: string) => Effect.Effect<TaskItem, TaskNotFoundError>
  readonly list: (filter?: TaskFilter) => Effect.Effect<ReadonlyArray<TaskItem>>
  readonly claim: (taskId: string, userId: string) => Effect.Effect<TaskItem, TaskNotFoundError | TaskStateError>
  readonly release: (taskId: string) => Effect.Effect<TaskItem, TaskNotFoundError | TaskStateError>
  readonly reassign: (
    taskId: string,
    assignee: string | undefined
  ) => Effect.Effect<TaskItem, TaskNotFoundError | TaskStateError>
  readonly complete: (taskId: string, completion: {
    readonly outcome: string
    readonly output?: Schema.Json | undefined
    readonly completedBy?: string | undefined
  }) => Effect.Effect<TaskItem, TaskNotFoundError | TaskStateError | TaskOutcomeError>
  readonly expire: (taskId: string) => Effect.Effect<TaskItem, TaskNotFoundError>
  readonly cancelByRun: (runId: string) => Effect.Effect<void>
}>()("@effect/workflow-builder/HumanTasks") {}

const decisionCodec = DurableDeferred.make("workflow-builder/task-decision", {
  success: Decision
})

const canonicalJson = (value: Schema.Json): string => {
  const canonical = Json.canonicalize(value)
  return Result.isFailure(canonical) ? JSON.stringify(value) : canonical.success
}

// Pagination is applied after every other filter so both layers page over the
// same deterministic created-at/task-id ordering.
const paginate = (
  items: ReadonlyArray<TaskItem>,
  filter: TaskFilter | undefined
): ReadonlyArray<TaskItem> => {
  const offset = filter?.offset ?? 0
  const end = filter?.limit === undefined ? undefined : offset + filter.limit
  return offset === 0 && end === undefined ? items : items.slice(offset, end)
}

/**
 * In-memory work-item store for tests and single-process deployments.
 *
 * **Details**
 *
 * Records are lost on process exit, but the decisions themselves live in the
 * durable deferred owned by the `WorkflowEngine`, so a lost projection cannot
 * corrupt a run. A durable deployment replaces this layer with a database
 * implementation exposing the same semantics.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<HumanTasks, never, WorkflowEngine.WorkflowEngine> = Layer.effect(
  HumanTasks,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const tasks = new Map<string, TaskItem>()

    const require_ = (taskId: string): Effect.Effect<TaskItem, TaskNotFoundError> => {
      const task = tasks.get(taskId)
      return task === undefined
        ? Effect.fail(new TaskNotFoundError({ taskId }))
        : Effect.succeed(task)
    }

    const update = (task: TaskItem): TaskItem => {
      const frozen = Object.freeze(task)
      tasks.set(task.taskId, frozen)
      return frozen
    }

    return HumanTasks.of({
      create: (request) =>
        Effect.gen(function*() {
          const existing = tasks.get(request.taskId)
          if (existing !== undefined) {
            return existing
          }
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          return update({
            taskId: request.taskId,
            runId: request.runId,
            planId: request.planId,
            nodeId: request.nodeId,
            title: request.title,
            description: request.description,
            outcomes: Object.freeze([...request.outcomes]),
            form: request.form,
            payload: request.payload,
            assignee: request.assignee,
            candidateGroups: Object.freeze([...request.candidateGroups ?? []]),
            createdAtMillis: now,
            dueAtMillis: request.dueAtMillis,
            state: "open",
            claimedBy: undefined,
            completion: undefined,
            token: request.token
          })
        }),

      get: require_,

      list: (filter) =>
        Effect.sync(() => {
          const items = Array.from(tasks.values()).filter((task) =>
            (filter?.runId === undefined || task.runId === filter.runId) &&
            (filter?.state === undefined || task.state === filter.state) &&
            (filter?.assignee === undefined || task.assignee === filter.assignee) &&
            (filter?.claimedBy === undefined || task.claimedBy === filter.claimedBy) &&
            (filter?.candidateGroup === undefined || task.candidateGroups.includes(filter.candidateGroup))
          )
          items.sort((left, right) =>
            left.createdAtMillis - right.createdAtMillis ||
            (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)
          )
          return paginate(items, filter)
        }),

      claim: (taskId, userId) =>
        Effect.gen(function*() {
          const task = yield* require_(taskId)
          if (task.state !== "open") {
            return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
          }
          return update({ ...task, state: "claimed", claimedBy: userId })
        }),

      release: (taskId) =>
        Effect.gen(function*() {
          const task = yield* require_(taskId)
          if (task.state !== "claimed") {
            return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
          }
          return update({ ...task, state: "open", claimedBy: undefined })
        }),

      reassign: (taskId, assignee) =>
        Effect.gen(function*() {
          const task = yield* require_(taskId)
          if (task.state !== "open" && task.state !== "claimed") {
            return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
          }
          return update({ ...task, assignee })
        }),

      complete: (taskId, completion) =>
        Effect.gen(function*() {
          const task = yield* require_(taskId)
          if (task.state !== "open" && task.state !== "claimed") {
            return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
          }
          if (!task.outcomes.includes(completion.outcome)) {
            return yield* Effect.fail(
              new TaskOutcomeError({
                taskId,
                outcome: completion.outcome,
                allowed: task.outcomes
              })
            )
          }
          const decision: Decision = {
            outcome: completion.outcome,
            output: completion.output ?? null
          }
          const canonical = yield* DurableDeferred.resolve(decisionCodec, {
            token: task.token as DurableDeferred.Token,
            exit: Exit.succeed(decision)
          }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          if (
            Exit.isSuccess(canonical) &&
            canonical.value.outcome === decision.outcome &&
            canonicalJson(canonical.value.output) === canonicalJson(decision.output)
          ) {
            return update({
              ...task,
              state: "completed",
              completion: Object.freeze({
                outcome: decision.outcome,
                output: decision.output,
                completedBy: completion.completedBy,
                completedAtMillis: now
              })
            })
          }
          // A different decision was already canonical: reconcile the local
          // projection with it before reporting the conflict.
          if (Exit.isSuccess(canonical)) {
            update(
              canonical.value.outcome === ExpiredOutcome
                ? { ...task, state: "expired" }
                : {
                  ...task,
                  state: "completed",
                  completion: Object.freeze({
                    outcome: canonical.value.outcome,
                    output: canonical.value.output,
                    completedBy: undefined,
                    completedAtMillis: now
                  })
                }
            )
          }
          return yield* Effect.fail(new TaskStateError({ taskId, state: tasks.get(taskId)!.state }))
        }),

      expire: (taskId) =>
        Effect.gen(function*() {
          const task = yield* require_(taskId)
          return task.state === "open" || task.state === "claimed"
            ? update({ ...task, state: "expired" })
            : task
        }),

      cancelByRun: (runId) =>
        Effect.sync(() => {
          for (const task of tasks.values()) {
            if (task.runId === runId && (task.state === "open" || task.state === "claimed")) {
              update({ ...task, state: "cancelled" })
            }
          }
        })
    })
  })
)

/**
 * SQL-backed work-item store sharing the memory layer's semantics.
 *
 * **Details**
 *
 * Work items survive process restarts, so an operator can list and complete
 * tasks created before a crash; the decision itself still lives in the
 * durable deferred owned by the `WorkflowEngine`, which remains the replayed
 * authority. Infrastructure failures after initialization are defects, so
 * the service interface stays identical across layers. The candidate-group
 * filter is applied after the indexed SQL filters.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSql = (options?: {
  readonly tableName?: string | undefined
}): Layer.Layer<
  HumanTasks,
  SqlError.SqlError,
  SqlClient.SqlClient | WorkflowEngine.WorkflowEngine
> =>
  Layer.effect(
    HumanTasks,
    Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const engine = yield* WorkflowEngine.WorkflowEngine
      const table = options?.tableName ?? "workflow_tasks"
      const tableSql = sql(table)
      const runIndex = `idx_${table}_run`

      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name=${table} AND xtype='U')
            CREATE TABLE ${tableSql} (
              task_id NVARCHAR(450) PRIMARY KEY,
              run_id NVARCHAR(255) NOT NULL,
              plan_id NVARCHAR(255) NOT NULL,
              node_id NVARCHAR(255) NOT NULL,
              title NVARCHAR(MAX) NOT NULL,
              description NVARCHAR(MAX),
              outcomes NVARCHAR(MAX) NOT NULL,
              form NVARCHAR(MAX),
              payload NVARCHAR(MAX),
              assignee NVARCHAR(255),
              candidate_groups NVARCHAR(MAX) NOT NULL,
              created_at_millis BIGINT NOT NULL,
              due_at_millis BIGINT,
              state NVARCHAR(16) NOT NULL,
              claimed_by NVARCHAR(255),
              completion NVARCHAR(MAX),
              token NVARCHAR(MAX) NOT NULL
            )`,
        orElse: () =>
          sql`CREATE TABLE IF NOT EXISTS ${tableSql} (
            task_id VARCHAR(450) PRIMARY KEY,
            run_id VARCHAR(255) NOT NULL,
            plan_id VARCHAR(255) NOT NULL,
            node_id VARCHAR(255) NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            outcomes TEXT NOT NULL,
            form TEXT,
            payload TEXT,
            assignee VARCHAR(255),
            candidate_groups TEXT NOT NULL,
            created_at_millis BIGINT NOT NULL,
            due_at_millis BIGINT,
            state VARCHAR(16) NOT NULL,
            claimed_by VARCHAR(255),
            completion TEXT,
            token TEXT NOT NULL
          )`
      })
      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = ${runIndex})
            CREATE INDEX ${sql(runIndex)} ON ${tableSql} (run_id, state)`,
        mysql: () =>
          sql`CREATE INDEX ${sql(runIndex)} ON ${tableSql} (run_id, state)`.pipe(
            Effect.catchCause(() => Effect.void)
          ),
        orElse: () => sql`CREATE INDEX IF NOT EXISTS ${sql(runIndex)} ON ${tableSql} (run_id, state)`
      })

      interface Row {
        readonly task_id: string
        readonly run_id: string
        readonly plan_id: string
        readonly node_id: string
        readonly title: string
        readonly description: string | null
        readonly outcomes: string
        readonly form: string | null
        readonly payload: string | null
        readonly assignee: string | null
        readonly candidate_groups: string
        readonly created_at_millis: number | string
        readonly due_at_millis: number | string | null
        readonly state: string
        readonly claimed_by: string | null
        readonly completion: string | null
        readonly token: string
      }

      const rowToTask = (row: Row): TaskItem =>
        Object.freeze({
          taskId: row.task_id,
          runId: row.run_id,
          planId: row.plan_id,
          nodeId: row.node_id,
          title: row.title,
          description: row.description ?? undefined,
          outcomes: Object.freeze(JSON.parse(row.outcomes) as Array<string>),
          form: row.form === null ? undefined : JSON.parse(row.form) as Schema.Json,
          payload: row.payload === null ? undefined : JSON.parse(row.payload) as Schema.Json,
          assignee: row.assignee ?? undefined,
          candidateGroups: Object.freeze(JSON.parse(row.candidate_groups) as Array<string>),
          createdAtMillis: Number(row.created_at_millis),
          dueAtMillis: row.due_at_millis === null ? undefined : Number(row.due_at_millis),
          state: row.state as TaskState,
          claimedBy: row.claimed_by ?? undefined,
          completion: row.completion === null ? undefined : Object.freeze(JSON.parse(row.completion) as TaskCompletion),
          token: row.token
        })

      const read = (taskId: string): Effect.Effect<ReadonlyArray<Row>> =>
        sql<Row>`SELECT * FROM ${tableSql} WHERE task_id = ${taskId}`.pipe(Effect.orDie)

      const require_ = (taskId: string): Effect.Effect<TaskItem, TaskNotFoundError> =>
        read(taskId).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.fail(new TaskNotFoundError({ taskId }))
              : Effect.succeed(rowToTask(rows[0]!))
          )
        )

      const writeState = (
        taskId: string,
        state: TaskState,
        claimedBy: string | null,
        completion: TaskCompletion | null
      ): Effect.Effect<void> =>
        sql`UPDATE ${tableSql} SET
            state = ${state},
            claimed_by = ${claimedBy},
            completion = ${completion === null ? null : JSON.stringify(completion)}
          WHERE task_id = ${taskId}`.pipe(Effect.orDie, Effect.asVoid)

      return HumanTasks.of({
        create: (request) =>
          Effect.gen(function*() {
            const existing = yield* read(request.taskId)
            if (existing.length > 0) {
              return rowToTask(existing[0]!)
            }
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            yield* sql`INSERT INTO ${tableSql} (
                task_id, run_id, plan_id, node_id, title, description, outcomes,
                form, payload, assignee, candidate_groups, created_at_millis,
                due_at_millis, state, claimed_by, completion, token
              ) VALUES (
                ${request.taskId}, ${request.runId}, ${request.planId},
                ${request.nodeId}, ${request.title}, ${request.description ?? null},
                ${JSON.stringify(request.outcomes)},
                ${request.form === undefined ? null : JSON.stringify(request.form)},
                ${request.payload === undefined ? null : JSON.stringify(request.payload)},
                ${request.assignee ?? null},
                ${JSON.stringify(request.candidateGroups ?? [])},
                ${now}, ${request.dueAtMillis ?? null}, ${"open"}, ${null}, ${null},
                ${request.token}
              )`.pipe(
              // Idempotent under redelivery: the first writer's row wins.
              Effect.catchCause(() => Effect.void)
            )
            return yield* require_(request.taskId).pipe(Effect.orDie)
          }),

        get: require_,

        list: (filter) =>
          Effect.gen(function*() {
            const conditions = [
              ...filter?.runId === undefined ? [] : [sql`run_id = ${filter.runId}`],
              ...filter?.state === undefined ? [] : [sql`state = ${filter.state}`],
              ...filter?.assignee === undefined ? [] : [sql`assignee = ${filter.assignee}`],
              ...filter?.claimedBy === undefined ? [] : [sql`claimed_by = ${filter.claimedBy}`]
            ]
            const rows = yield* sql<Row>`SELECT * FROM ${tableSql}
              WHERE ${sql.and(conditions)}
              ORDER BY created_at_millis, task_id`.pipe(Effect.orDie)
            const items = rows.map(rowToTask)
            const matched = filter?.candidateGroup === undefined
              ? items
              : items.filter((task) => task.candidateGroups.includes(filter.candidateGroup!))
            return paginate(matched, filter)
          }),

        claim: (taskId, userId) =>
          Effect.gen(function*() {
            const task = yield* require_(taskId)
            if (task.state !== "open") {
              return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
            }
            yield* writeState(taskId, "claimed", userId, null)
            return { ...task, state: "claimed" as const, claimedBy: userId }
          }),

        release: (taskId) =>
          Effect.gen(function*() {
            const task = yield* require_(taskId)
            if (task.state !== "claimed") {
              return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
            }
            yield* writeState(taskId, "open", null, null)
            return { ...task, state: "open" as const, claimedBy: undefined }
          }),

        reassign: (taskId, assignee) =>
          Effect.gen(function*() {
            const task = yield* require_(taskId)
            if (task.state !== "open" && task.state !== "claimed") {
              return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
            }
            yield* sql`UPDATE ${tableSql} SET assignee = ${assignee ?? null}
              WHERE task_id = ${taskId}`.pipe(Effect.orDie, Effect.asVoid)
            return { ...task, assignee }
          }),

        complete: (taskId, completion) =>
          Effect.gen(function*() {
            const task = yield* require_(taskId)
            if (task.state !== "open" && task.state !== "claimed") {
              return yield* Effect.fail(new TaskStateError({ taskId, state: task.state }))
            }
            if (!task.outcomes.includes(completion.outcome)) {
              return yield* Effect.fail(
                new TaskOutcomeError({
                  taskId,
                  outcome: completion.outcome,
                  allowed: task.outcomes
                })
              )
            }
            const decision: Decision = {
              outcome: completion.outcome,
              output: completion.output ?? null
            }
            const canonical = yield* DurableDeferred.resolve(decisionCodec, {
              token: task.token as DurableDeferred.Token,
              exit: Exit.succeed(decision)
            }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            if (
              Exit.isSuccess(canonical) &&
              canonical.value.outcome === decision.outcome &&
              canonicalJson(canonical.value.output) === canonicalJson(decision.output)
            ) {
              const accepted: TaskCompletion = Object.freeze({
                outcome: decision.outcome,
                output: decision.output,
                completedBy: completion.completedBy,
                completedAtMillis: now
              })
              yield* writeState(taskId, "completed", task.claimedBy ?? null, accepted)
              return { ...task, state: "completed" as const, completion: accepted }
            }
            if (Exit.isSuccess(canonical)) {
              if (canonical.value.outcome === ExpiredOutcome) {
                yield* writeState(taskId, "expired", task.claimedBy ?? null, null)
              } else {
                yield* writeState(
                  taskId,
                  "completed",
                  task.claimedBy ?? null,
                  Object.freeze({
                    outcome: canonical.value.outcome,
                    output: canonical.value.output,
                    completedBy: undefined,
                    completedAtMillis: now
                  })
                )
              }
            }
            const reconciled = yield* require_(taskId).pipe(Effect.orDie)
            return yield* Effect.fail(new TaskStateError({ taskId, state: reconciled.state }))
          }),

        expire: (taskId) =>
          Effect.gen(function*() {
            const task = yield* require_(taskId)
            if (task.state === "open" || task.state === "claimed") {
              yield* writeState(taskId, "expired", task.claimedBy ?? null, null)
              return { ...task, state: "expired" as const }
            }
            return task
          }),

        cancelByRun: (runId) =>
          sql`UPDATE ${tableSql} SET state = ${"cancelled"}
            WHERE run_id = ${runId} AND state IN ('open', 'claimed')`.pipe(
            Effect.orDie,
            Effect.asVoid
          )
      })
    })
  )
