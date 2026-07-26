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
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Json from "./internal/json.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

/**
 * The decision recorded when a work item concludes.
 *
 * **Details**
 *
 * This is also the success schema of the durable deferred the engine awaits,
 * so the decision value — not the task record — is the replayed authority for
 * the run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Decision = Schema.Struct({
  outcome: Schema.NonEmptyString,
  output: Schema.Json
}).annotate({
  identifier: "WorkflowTaskDecision",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Decision}.
 *
 * @category models
 * @since 4.0.0
 */
export type Decision = Schema.Schema.Type<typeof Decision>

/**
 * The outcome recorded when an expiration deadline wins the decision race.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExpiredOutcome = "expired" as const

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
 * @category models
 * @since 4.0.0
 */
export interface TaskFilter {
  readonly runId?: string | undefined
  readonly state?: TaskState | undefined
  readonly assignee?: string | undefined
  readonly claimedBy?: string | undefined
  readonly candidateGroup?: string | undefined
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
          return items
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
