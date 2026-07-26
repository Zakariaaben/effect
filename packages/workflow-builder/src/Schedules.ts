/**
 * Durable cron schedules that start plan runs.
 *
 * A schedule pins a plan — optionally to an exact revision — together with a
 * UTC cron expression and a run input. The {@link runner} daemon polls the
 * store, and for every schedule whose next occurrence has elapsed starts one
 * run through `Runs.start` with a run key derived from the fire time, so
 * firing is idempotent across restarts and duplicate runners: the same fire
 * always joins the same run. When several occurrences elapse unobserved —
 * downtime, a long poll interval — the runner fires once for the latest
 * missed occurrence instead of replaying every one.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Cron from "effect/Cron"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import type * as PlanStore from "./PlanStore.ts"
import * as Runs from "./Runs.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

/**
 * A stored cron schedule over a saved plan.
 *
 * **Details**
 *
 * `cron` is a standard cron expression evaluated in UTC and validated by
 * `Cron.parse` at creation. `lastFireTimeMillis` is the occurrence the runner
 * last fired for; the next fire is the first occurrence strictly after it —
 * or after `createdAtMillis` while the schedule has never fired.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Schedule = Schema.Struct({
  scheduleId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  revision: Schema.optionalKey(Schema.Int),
  cron: Schema.NonEmptyString,
  input: Schema.Json,
  enabled: Schema.Boolean,
  createdAtMillis: Schema.Number,
  lastFireTimeMillis: Schema.optionalKey(Schema.Number)
}).annotate({
  identifier: "WorkflowSchedule",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Schedule}.
 *
 * @category models
 * @since 4.0.0
 */
export type Schedule = Schema.Schema.Type<typeof Schedule>

/**
 * Request creating a schedule.
 *
 * @category models
 * @since 4.0.0
 */
export interface CreateRequest {
  readonly scheduleId: string
  readonly planId: string
  /** Exact plan revision to run; defaults to the latest revision at fire time. */
  readonly revision?: number | undefined
  /** A cron expression evaluated in UTC; rejected when `Cron.parse` fails. */
  readonly cron: string
  /** The run input passed to every fired run; defaults to `{}`. */
  readonly input?: Schema.Json | undefined
  /** Whether the schedule fires; defaults to `true`. */
  readonly enabled?: boolean | undefined
}

/**
 * Raised when a schedule is created under an already-used id.
 *
 * @category errors
 * @since 4.0.0
 */
export class ScheduleConflictError extends Schema.TaggedErrorClass<ScheduleConflictError>(
  "@effect/workflow-builder/Schedules/ScheduleConflictError"
)("ScheduleConflictError", {
  scheduleId: Schema.String
}) {}

/**
 * Raised when a referenced schedule does not exist.
 *
 * @category errors
 * @since 4.0.0
 */
export class ScheduleNotFoundError extends Schema.TaggedErrorClass<ScheduleNotFoundError>(
  "@effect/workflow-builder/Schedules/ScheduleNotFoundError"
)("ScheduleNotFoundError", {
  scheduleId: Schema.String
}) {}

/**
 * Raised when a schedule is created with an unparseable cron expression.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidCronError extends Schema.TaggedErrorClass<InvalidCronError>(
  "@effect/workflow-builder/Schedules/InvalidCronError"
)("InvalidCronError", {
  scheduleId: Schema.String,
  cron: Schema.String,
  message: Schema.String
}) {}

/**
 * Service storing durable cron schedules.
 *
 * **Details**
 *
 * `create` validates the cron expression and rejects duplicate ids; every
 * other lookup fails typed on a missing schedule. `due` and `recordFire` are
 * the {@link runner}'s internal protocol: `due` returns the enabled schedules
 * whose next occurrence — computed from the last fire time, or the creation
 * time before the first fire — is at or before the given instant, and
 * `recordFire` advances the last fire time monotonically, so a replayed or
 * stale fire can never rewind a schedule.
 *
 * @category services
 * @since 4.0.0
 */
export class Schedules extends Context.Service<Schedules, {
  readonly create: (
    request: CreateRequest
  ) => Effect.Effect<Schedule, ScheduleConflictError | InvalidCronError>
  readonly get: (scheduleId: string) => Effect.Effect<Schedule, ScheduleNotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Schedule>>
  readonly enable: (scheduleId: string) => Effect.Effect<Schedule, ScheduleNotFoundError>
  readonly disable: (scheduleId: string) => Effect.Effect<Schedule, ScheduleNotFoundError>
  readonly remove: (scheduleId: string) => Effect.Effect<void, ScheduleNotFoundError>
  readonly due: (nowMillis: number) => Effect.Effect<ReadonlyArray<Schedule>>
  readonly recordFire: (
    scheduleId: string,
    fireTimeMillis: number
  ) => Effect.Effect<void, ScheduleNotFoundError>
}>()("@effect/workflow-builder/Schedules") {}

const UtcZone = "UTC"

const parseCron = (
  scheduleId: string,
  expression: string
): Effect.Effect<Cron.Cron, InvalidCronError> => {
  const parsed = Cron.parse(expression, UtcZone)
  return Result.isFailure(parsed)
    ? Effect.fail(
      new InvalidCronError({ scheduleId, cron: expression, message: parsed.failure.message })
    )
    : Effect.succeed(parsed.success)
}

/** A stored expression was validated at creation; failing to re-parse it is store corruption. */
const storedCron = (schedule: Schedule): Effect.Effect<Cron.Cron> =>
  parseCron(schedule.scheduleId, schedule.cron).pipe(Effect.orDie)

/** The instant the next fire is computed from. */
const baseMillis = (schedule: Schedule): number => schedule.lastFireTimeMillis ?? schedule.createdAtMillis

const nextFireMillis = (schedule: Schedule): Effect.Effect<number> =>
  storedCron(schedule).pipe(Effect.map((cron) => Cron.next(cron, baseMillis(schedule)).getTime()))

/**
 * The latest occurrence at or before `nowMillis`.
 *
 * `Cron.prev` is strict — an instant that itself matches the schedule steps
 * back to the earlier occurrence — so step back and forward again to keep an
 * exact hit.
 */
const latestOccurrenceMillis = (cron: Cron.Cron, nowMillis: number): number => {
  const previous = Cron.prev(cron, nowMillis).getTime()
  const following = Cron.next(cron, previous).getTime()
  return following <= nowMillis ? following : previous
}

const byCreation = (left: Schedule, right: Schedule): number =>
  left.createdAtMillis - right.createdAtMillis ||
  (left.scheduleId < right.scheduleId ? -1 : left.scheduleId > right.scheduleId ? 1 : 0)

const dueFrom = (
  candidates: Iterable<Schedule>,
  nowMillis: number
): Effect.Effect<ReadonlyArray<Schedule>> =>
  Effect.gen(function*() {
    const due: Array<Schedule> = []
    for (const schedule of candidates) {
      if (!schedule.enabled) {
        continue
      }
      if ((yield* nextFireMillis(schedule)) <= nowMillis) {
        due.push(schedule)
      }
    }
    return due.sort(byCreation)
  })

/**
 * In-memory schedule store for tests and single-process deployments.
 *
 * **Details**
 *
 * Contents are lost on process exit. Because the runner derives run keys from
 * fire times, a rebuilt store re-firing an occurrence joins the original run
 * instead of duplicating it.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<Schedules> = Layer.effect(
  Schedules,
  Effect.sync(() => {
    const store = new Map<string, Schedule>()

    const require_ = (scheduleId: string): Effect.Effect<Schedule, ScheduleNotFoundError> => {
      const schedule = store.get(scheduleId)
      return schedule === undefined
        ? Effect.fail(new ScheduleNotFoundError({ scheduleId }))
        : Effect.succeed(schedule)
    }

    const update = (schedule: Schedule): Schedule => {
      const frozen = Object.freeze(schedule)
      store.set(schedule.scheduleId, frozen)
      return frozen
    }

    return Schedules.of({
      create: (request) =>
        Effect.gen(function*() {
          yield* parseCron(request.scheduleId, request.cron)
          if (store.has(request.scheduleId)) {
            return yield* Effect.fail(new ScheduleConflictError({ scheduleId: request.scheduleId }))
          }
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          return update({
            scheduleId: request.scheduleId,
            planId: request.planId,
            ...request.revision === undefined ? {} : { revision: request.revision },
            cron: request.cron,
            input: request.input ?? {},
            enabled: request.enabled ?? true,
            createdAtMillis: now
          })
        }),

      get: require_,

      list: () => Effect.sync(() => Array.from(store.values()).sort(byCreation)),

      enable: (scheduleId) =>
        require_(scheduleId).pipe(
          Effect.map((schedule) => update({ ...schedule, enabled: true }))
        ),

      disable: (scheduleId) =>
        require_(scheduleId).pipe(
          Effect.map((schedule) => update({ ...schedule, enabled: false }))
        ),

      remove: (scheduleId) =>
        require_(scheduleId).pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              store.delete(scheduleId)
            })
          )
        ),

      due: (nowMillis) => dueFrom(store.values(), nowMillis),

      recordFire: (scheduleId, fireTimeMillis) =>
        require_(scheduleId).pipe(
          Effect.map((schedule) => {
            if (schedule.lastFireTimeMillis === undefined || schedule.lastFireTimeMillis < fireTimeMillis) {
              update({ ...schedule, lastFireTimeMillis: fireTimeMillis })
            }
          })
        )
    })
  })
)

/**
 * SQL-backed schedule store sharing the memory layer's semantics.
 *
 * **Details**
 *
 * Schedules live in one table keyed by `schedule_id` with the run input as
 * JSON text. Cron evaluation stays in code — `due` filters the enabled rows
 * against the parsed expression — and `recordFire` advances the last fire
 * time with a monotonic guard so racing runners cannot rewind a schedule.
 * Infrastructure failures after successful initialization are defects, not
 * typed errors, so the service interface stays identical across layers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSql = (options?: {
  readonly tableName?: string | undefined
}): Layer.Layer<Schedules, SqlError.SqlError, SqlClient.SqlClient> =>
  Layer.effect(
    Schedules,
    Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = options?.tableName ?? "workflow_schedules"
      const tableSql = sql(table)

      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name=${table} AND xtype='U')
            CREATE TABLE ${tableSql} (
              schedule_id NVARCHAR(255) PRIMARY KEY,
              plan_id NVARCHAR(255) NOT NULL,
              revision INT,
              cron NVARCHAR(255) NOT NULL,
              input NVARCHAR(MAX) NOT NULL,
              enabled INT NOT NULL,
              created_at_millis BIGINT NOT NULL,
              last_fire_time_millis BIGINT
            )`,
        orElse: () =>
          sql`CREATE TABLE IF NOT EXISTS ${tableSql} (
            schedule_id VARCHAR(255) PRIMARY KEY,
            plan_id VARCHAR(255) NOT NULL,
            revision INTEGER,
            cron VARCHAR(255) NOT NULL,
            input TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            created_at_millis BIGINT NOT NULL,
            last_fire_time_millis BIGINT
          )`
      })

      interface Row {
        readonly schedule_id: string
        readonly plan_id: string
        readonly revision: number | string | null
        readonly cron: string
        readonly input: string
        readonly enabled: number | string
        readonly created_at_millis: number | string
        readonly last_fire_time_millis: number | string | null
      }

      const rowToSchedule = (row: Row): Schedule =>
        Object.freeze({
          scheduleId: row.schedule_id,
          planId: row.plan_id,
          ...row.revision === null ? {} : { revision: Number(row.revision) },
          cron: row.cron,
          input: JSON.parse(row.input) as Schema.Json,
          enabled: Number(row.enabled) !== 0,
          createdAtMillis: Number(row.created_at_millis),
          ...row.last_fire_time_millis === null
            ? {}
            : { lastFireTimeMillis: Number(row.last_fire_time_millis) }
        })

      const read = (scheduleId: string): Effect.Effect<ReadonlyArray<Row>> =>
        sql<Row>`SELECT * FROM ${tableSql} WHERE schedule_id = ${scheduleId}`.pipe(Effect.orDie)

      const require_ = (scheduleId: string): Effect.Effect<Schedule, ScheduleNotFoundError> =>
        read(scheduleId).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.fail(new ScheduleNotFoundError({ scheduleId }))
              : Effect.succeed(rowToSchedule(rows[0]!))
          )
        )

      const setEnabled = (
        scheduleId: string,
        enabled: boolean
      ): Effect.Effect<Schedule, ScheduleNotFoundError> =>
        require_(scheduleId).pipe(
          Effect.flatMap((schedule) =>
            sql`UPDATE ${tableSql} SET enabled = ${enabled ? 1 : 0}
              WHERE schedule_id = ${scheduleId}`.pipe(
              Effect.orDie,
              Effect.as(Object.freeze({ ...schedule, enabled }))
            )
          )
        )

      return Schedules.of({
        create: (request) =>
          Effect.gen(function*() {
            yield* parseCron(request.scheduleId, request.cron)
            const existing = yield* read(request.scheduleId)
            if (existing.length > 0) {
              return yield* Effect.fail(new ScheduleConflictError({ scheduleId: request.scheduleId }))
            }
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            const schedule: Schedule = Object.freeze({
              scheduleId: request.scheduleId,
              planId: request.planId,
              ...request.revision === undefined ? {} : { revision: request.revision },
              cron: request.cron,
              input: request.input ?? {},
              enabled: request.enabled ?? true,
              createdAtMillis: now
            })
            yield* sql`INSERT INTO ${tableSql} (
                schedule_id, plan_id, revision, cron, input, enabled,
                created_at_millis, last_fire_time_millis
              ) VALUES (
                ${schedule.scheduleId}, ${schedule.planId},
                ${schedule.revision ?? null}, ${schedule.cron},
                ${JSON.stringify(schedule.input)}, ${schedule.enabled ? 1 : 0},
                ${schedule.createdAtMillis}, ${null}
              )`.pipe(
              // A concurrent writer may have won the primary key; the
              // committed row decides the conflict.
              Effect.catchCause(() =>
                read(request.scheduleId).pipe(
                  Effect.flatMap((rows) =>
                    rows.length > 0
                      ? Effect.fail(new ScheduleConflictError({ scheduleId: request.scheduleId }))
                      : Effect.die(new Error("Schedules.layerSql: insert failed without a committed row"))
                  )
                )
              )
            )
            return schedule
          }),

        get: require_,

        list: () =>
          sql<Row>`SELECT * FROM ${tableSql} ORDER BY created_at_millis, schedule_id`.pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map(rowToSchedule))
          ),

        enable: (scheduleId) => setEnabled(scheduleId, true),

        disable: (scheduleId) => setEnabled(scheduleId, false),

        remove: (scheduleId) =>
          require_(scheduleId).pipe(
            Effect.flatMap(() => sql`DELETE FROM ${tableSql} WHERE schedule_id = ${scheduleId}`.pipe(Effect.orDie)),
            Effect.asVoid
          ),

        due: (nowMillis) =>
          sql<Row>`SELECT * FROM ${tableSql} WHERE enabled = 1`.pipe(
            Effect.orDie,
            Effect.flatMap((rows) => dueFrom(rows.map(rowToSchedule), nowMillis))
          ),

        recordFire: (scheduleId, fireTimeMillis) =>
          require_(scheduleId).pipe(
            Effect.flatMap(() =>
              sql`UPDATE ${tableSql} SET last_fire_time_millis = ${fireTimeMillis}
                WHERE schedule_id = ${scheduleId}
                  AND (last_fire_time_millis IS NULL OR last_fire_time_millis < ${fireTimeMillis})`.pipe(
                Effect.orDie
              )
            ),
            Effect.asVoid
          )
      })
    })
  )

const fireDue = (
  service: Schedules["Service"],
  schedule: Schedule,
  nowMillis: number
): Effect.Effect<void, never, PlanStore.PlanStore | WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const cron = yield* storedCron(schedule)
    const fireTimeMillis = latestOccurrenceMillis(cron, nowMillis)
    yield* Runs.start(schedule.planId, {
      input: schedule.input,
      revision: schedule.revision,
      runKey: JSON.stringify(["schedule", schedule.scheduleId, fireTimeMillis])
    }).pipe(
      // A missing plan consumes the fire after a warning: the schedule keeps
      // ticking instead of retrying the same occurrence forever.
      Effect.catchTag("PlanNotFoundError", (error) =>
        Effect.logWarning(
          `Schedules.runner: schedule '${schedule.scheduleId}' references missing plan '${schedule.planId}'`,
          error
        ))
    )
    yield* service.recordFire(schedule.scheduleId, fireTimeMillis).pipe(
      // The schedule may have been removed while the run was starting.
      Effect.catchTag("ScheduleNotFoundError", () => Effect.void)
    )
  })

const tick = (
  service: Schedules["Service"]
): Effect.Effect<void, never, PlanStore.PlanStore | WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const nowMillis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const due = yield* service.due(nowMillis)
    for (const schedule of due) {
      yield* fireDue(service, schedule, nowMillis)
    }
  })

/**
 * The daemon that turns due schedules into plan runs.
 *
 * **Details**
 *
 * A forked loop reads the clock every `pollInterval` (default one second),
 * asks the store for due schedules, and fires each one. The fire time is the
 * latest cron occurrence at or before the observed now: when several
 * occurrences were missed — downtime, a long poll interval — the runner
 * fires ONCE for the latest of them rather than replaying every missed
 * occurrence, so recovery can never turn into an unbounded catch-up storm.
 *
 * The run key is derived from the fire time —
 * `JSON.stringify(["schedule", scheduleId, fireTimeMillis])` — which makes
 * firing idempotent across restarts and duplicate runners: two runners
 * observing the same occurrence start (or join) the same run. After the
 * start, the fire time is recorded so the next evaluation begins strictly
 * after it.
 *
 * A schedule referencing a missing plan logs a warning and keeps the loop
 * alive, and any other tick failure is logged and retried on the next poll —
 * the daemon never crashes.
 *
 * @category layers
 * @since 4.0.0
 */
export const runner = (options?: {
  readonly pollInterval?: Duration.Input | undefined
}): Layer.Layer<never, never, Schedules | PlanStore.PlanStore | WorkflowEngine.WorkflowEngine> =>
  Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const service = yield* Schedules
      const interval = options?.pollInterval ?? Duration.seconds(1)
      while (true) {
        yield* tick(service).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Schedules.runner: poll tick failed", cause))
        )
        yield* Effect.sleep(interval)
      }
    }),
    { startImmediately: true }
  ))
