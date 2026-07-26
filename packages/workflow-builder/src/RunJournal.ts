/**
 * A non-authoritative, queryable timeline of what happened in each run.
 *
 * The engine emits journal entries as runs progress — start, node
 * settlements with attempt counts, work-item creation, decisions,
 * compensations, and the terminal outcome — so operators and UIs can answer
 * "where is my workflow and how did it get here" without touching the
 * durable execution journal.
 *
 * The journal is a *projection*: the durable authority remains the native
 * workflow storage. Emission is at-least-once and re-fires during replay,
 * so every entry carries a stable identity and recording is idempotent; a
 * lost or rebuilt journal can never corrupt a run. The engine reads it
 * never, and a journal failure never fails a run.
 *
 * By default the journal is a no-op; provide {@link layerMemory} or
 * {@link layerSql} to capture timelines.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"

const strictParseOptions = { onExcessProperty: "error" } as const

const common = {
  runId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  sequence: Schema.Int,
  timeMillis: Schema.Number
}

/**
 * Every kind of timeline entry the engine emits.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Entry = Schema.Union([
  Schema.TaggedStruct("RunStarted", {
    ...common,
    revision: Schema.Int,
    fingerprint: Schema.String
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("NodeCompleted", {
    ...common,
    nodeId: Schema.NonEmptyString,
    outcome: Schema.NonEmptyString,
    attempts: Schema.Int
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("NodeSkipped", {
    ...common,
    nodeId: Schema.NonEmptyString
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("TaskCreated", {
    ...common,
    nodeId: Schema.NonEmptyString,
    taskId: Schema.NonEmptyString
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("DecisionRecorded", {
    ...common,
    nodeId: Schema.NonEmptyString,
    outcome: Schema.NonEmptyString
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("CompensationRun", {
    ...common,
    nodeId: Schema.NonEmptyString
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("RunSucceeded", common).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("RunFailed", {
    ...common,
    failure: Schema.Json
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("RunCancelled", common).annotate({ parseOptions: strictParseOptions })
]).annotate({ identifier: "WorkflowRunJournalEntry" })

/**
 * The decoded type of {@link Entry}.
 *
 * @category models
 * @since 4.0.0
 */
export type Entry = Schema.Schema.Type<typeof Entry>

/**
 * An entry as emitted by the engine, before the journal stamps its ordering.
 *
 * **Details**
 *
 * The engine supplies the causal `sequence` (a per-run counter incremented in
 * interpretation order); the journal stamps `timeMillis`. Because emission is
 * idempotent under replay, the first recording of an entry key fixes both.
 *
 * @category models
 * @since 4.0.0
 */
export type EntryInput = Entry extends infer E ? E extends { readonly timeMillis: number } ? Omit<E, "timeMillis">
  : never
  : never

/**
 * An entry as the engine builds it, before it stamps the causal sequence.
 *
 * @category models
 * @since 4.0.0
 */
export type EmitInput = Entry extends infer E
  ? E extends { readonly sequence: number } ? Omit<E, "sequence" | "timeMillis"> : never
  : never

/**
 * Adds the causal sequence to an emit input, producing a record input.
 *
 * @category models
 * @since 4.0.0
 */
export const withSequence = (entry: EmitInput, sequence: number): EntryInput => ({ ...entry, sequence }) as EntryInput

/**
 * The stable identity that makes journal recording idempotent under replay.
 *
 * @category models
 * @since 4.0.0
 */
export const entryKey = (entry: EntryInput): string => {
  switch (entry._tag) {
    case "RunStarted":
      return "started"
    case "NodeCompleted":
    case "NodeSkipped":
      return JSON.stringify(["node", entry.nodeId])
    case "TaskCreated":
      return JSON.stringify(["task", entry.nodeId])
    case "DecisionRecorded":
      return JSON.stringify(["decision", entry.nodeId])
    case "CompensationRun":
      return JSON.stringify(["compensate", entry.nodeId])
    case "RunSucceeded":
    case "RunFailed":
    case "RunCancelled":
      return "terminal"
  }
}

/**
 * The journal service interface.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  readonly record: (entry: EntryInput) => Effect.Effect<void>
  readonly timeline: (runId: string) => Effect.Effect<ReadonlyArray<Entry>>
}

const noop: Service = {
  record: () => Effect.void,
  timeline: () => Effect.succeed([])
}

/**
 * The current journal, defaulting to a no-op.
 *
 * **Details**
 *
 * Modeled as a reference with a default so the engine can always emit
 * without imposing a journal requirement on every deployment; providing a
 * real layer switches capture on.
 *
 * @category services
 * @since 4.0.0
 */
export const RunJournal = Context.Reference<Service>(
  "@effect/workflow-builder/RunJournal",
  { defaultValue: () => noop }
)

/**
 * Reads a run's timeline through the current journal.
 *
 * @category observation
 * @since 4.0.0
 */
export const timeline = (runId: string): Effect.Effect<ReadonlyArray<Entry>> =>
  Effect.gen(function*() {
    const journal = yield* RunJournal
    return yield* journal.timeline(runId)
  })

const stamped = (entry: EntryInput, timeMillis: number): Entry => ({ ...entry, timeMillis } as Entry)

// Causal order: the engine's per-run sequence is authoritative; wall-clock
// time is a display attribute only, never a sort key (many entries share a
// millisecond).
const ordered = (entries: Iterable<Entry>): ReadonlyArray<Entry> =>
  Array.from(entries).sort((left, right) => left.sequence - right.sequence)

/**
 * In-memory journal for tests and single-process deployments.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<never> = Layer.effect(
  RunJournal,
  Effect.sync(() => {
    const runs = new Map<string, Map<string, Entry>>()
    return {
      record: (entry) =>
        Effect.clockWith((clock) =>
          Effect.sync(() => {
            const entries = runs.get(entry.runId) ?? new Map<string, Entry>()
            const key = entryKey(entry)
            if (!entries.has(key)) {
              entries.set(key, stamped(entry, clock.currentTimeMillisUnsafe()))
              runs.set(entry.runId, entries)
            }
          })
        ),
      timeline: (runId) => Effect.sync(() => ordered(runs.get(runId)?.values() ?? []))
    }
  })
) as Layer.Layer<never>

/**
 * SQL-backed journal sharing the memory layer's idempotent semantics.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSql = (options?: {
  readonly tableName?: string | undefined
}): Layer.Layer<never, SqlError.SqlError, SqlClient.SqlClient> =>
  Layer.effect(
    RunJournal,
    Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = options?.tableName ?? "workflow_journal"
      const tableSql = sql(table)

      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name=${table} AND xtype='U')
            CREATE TABLE ${tableSql} (
              run_id NVARCHAR(255) NOT NULL,
              entry_key NVARCHAR(450) NOT NULL,
              sequence_no INT NOT NULL,
              time_millis BIGINT NOT NULL,
              entry NVARCHAR(MAX) NOT NULL,
              PRIMARY KEY (run_id, entry_key)
            )`,
        orElse: () =>
          sql`CREATE TABLE IF NOT EXISTS ${tableSql} (
            run_id VARCHAR(255) NOT NULL,
            entry_key VARCHAR(450) NOT NULL,
            sequence_no INTEGER NOT NULL,
            time_millis BIGINT NOT NULL,
            entry TEXT NOT NULL,
            PRIMARY KEY (run_id, entry_key)
          )`
      })

      const encode = Schema.encodeUnknownEffect(Entry)

      return {
        record: (input) =>
          Effect.clockWith((clock) =>
            Effect.gen(function*() {
              const entry = stamped(input, clock.currentTimeMillisUnsafe())
              const encoded = yield* encode(entry).pipe(Effect.orDie)
              yield* sql`INSERT INTO ${tableSql} (run_id, entry_key, sequence_no, time_millis, entry)
                VALUES (${input.runId}, ${entryKey(input)}, ${input.sequence}, ${entry.timeMillis}, ${
                JSON.stringify(encoded)
              })`.pipe(
                // Replay re-emits the same identity; the first write wins.
                Effect.catchCause(() => Effect.void)
              )
            })
          ),
        timeline: (runId) =>
          sql<{ readonly entry: string }>`SELECT entry FROM ${tableSql}
            WHERE run_id = ${runId}
            ORDER BY sequence_no`.pipe(
            Effect.orDie,
            Effect.flatMap(
              Effect.forEach((row) => Schema.decodeUnknownEffect(Entry)(JSON.parse(row.entry)).pipe(Effect.orDie))
            )
          )
      }
    })
  ) as Layer.Layer<never, SqlError.SqlError, SqlClient.SqlClient>
