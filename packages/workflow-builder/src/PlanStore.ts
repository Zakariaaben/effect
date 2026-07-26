/**
 * Stores immutable, fingerprint-pinned revisions of portable plans.
 *
 * A run references its plan by `(planId, revision, fingerprint)`; the store's
 * only job is to return exactly the admitted document for that pin. Revisions
 * are append-only — saving a different plan under an existing revision is a
 * conflict, never an overwrite — so a running or resumed execution can always
 * recover the meaning it started with.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import type * as Compiler from "./Compiler.ts"
import * as CompilerModule from "./Compiler.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as Plan from "./Plan.ts"

/**
 * Raised when a referenced plan revision does not exist.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanNotFoundError extends Schema.TaggedErrorClass<PlanNotFoundError>(
  "@effect/workflow-builder/PlanStore/PlanNotFoundError"
)("PlanNotFoundError", {
  planId: Schema.String,
  revision: Schema.optionalKey(Schema.Int)
}) {}

/**
 * Raised when a revision is saved again with different semantic content.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanConflictError extends Schema.TaggedErrorClass<PlanConflictError>(
  "@effect/workflow-builder/PlanStore/PlanConflictError"
)("PlanConflictError", {
  planId: Schema.String,
  revision: Schema.Int,
  existing: Fingerprint.Digest,
  submitted: Fingerprint.Digest
}) {}

/**
 * An admitted plan revision pinned by its canonical fingerprint.
 *
 * @category models
 * @since 4.0.0
 */
export interface StoredPlan {
  readonly planId: string
  readonly revision: number
  readonly fingerprint: Fingerprint.Fingerprint
  readonly plan: Plan.Plan
}

/**
 * A plan's identity pinned at its latest admitted revision.
 *
 * @category models
 * @since 4.0.0
 */
export interface PlanSummary {
  readonly planId: string
  readonly latestRevision: number
  readonly fingerprint: Fingerprint.Fingerprint
}

/**
 * Service storing admitted plan revisions.
 *
 * **Details**
 *
 * `save` accepts only a plan that passed compilation, computes its canonical
 * fingerprint, and is idempotent for identical content. `get` returns an
 * exact revision and `latest` the highest saved revision; both return the
 * pinned fingerprint so callers can fail closed on drift. `list` summarizes
 * every stored plan at its latest revision, sorted by plan id, and
 * `revisions` returns a plan's full history in ascending revision order.
 *
 * @category services
 * @since 4.0.0
 */
export class PlanStore extends Context.Service<PlanStore, {
  readonly save: (
    compiled: Compiler.CompiledPlan
  ) => Effect.Effect<StoredPlan, PlanConflictError | PlatformError.PlatformError>
  readonly get: (planId: string, revision: number) => Effect.Effect<StoredPlan, PlanNotFoundError>
  readonly latest: (planId: string) => Effect.Effect<StoredPlan, PlanNotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PlanSummary>>
  readonly revisions: (planId: string) => Effect.Effect<ReadonlyArray<StoredPlan>, PlanNotFoundError>
}>()("@effect/workflow-builder/PlanStore") {}

const storageKey = (planId: string, revision: number): string => JSON.stringify([planId, revision])

/**
 * In-memory plan store for tests and single-process deployments.
 *
 * **Details**
 *
 * Contents are lost on process exit. A durable deployment supplies its own
 * `PlanStore` layer over a database while keeping the same append-only and
 * fingerprint semantics.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<PlanStore, never, Crypto.Crypto> = Layer.effect(
  PlanStore,
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const revisions = new Map<string, StoredPlan>()
    const latestRevision = new Map<string, number>()

    const save: PlanStore["Service"]["save"] = (compiled) =>
      Effect.gen(function*() {
        if (!CompilerModule.isCompiled(compiled)) {
          return yield* Effect.die(
            new TypeError("PlanStore.save requires the exact compiled plan returned by Compiler.compile")
          )
        }
        const fingerprint = yield* Fingerprint.make(compiled)
        const planId = compiled.plan.id
        const revision = compiled.plan.revision
        const key = storageKey(planId, revision)
        const existing = revisions.get(key)
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return yield* Effect.fail(
              new PlanConflictError({
                planId,
                revision,
                existing: existing.fingerprint,
                submitted: fingerprint
              })
            )
          }
          return existing
        }
        const stored: StoredPlan = Object.freeze({
          planId,
          revision,
          fingerprint,
          plan: compiled.plan
        })
        revisions.set(key, stored)
        const currentLatest = latestRevision.get(planId)
        if (currentLatest === undefined || revision > currentLatest) {
          latestRevision.set(planId, revision)
        }
        return stored
      }).pipe(Effect.provideService(Crypto.Crypto, crypto))

    return PlanStore.of({
      save,
      get: (planId, revision) => {
        const stored = revisions.get(storageKey(planId, revision))
        return stored === undefined
          ? Effect.fail(new PlanNotFoundError({ planId, revision }))
          : Effect.succeed(stored)
      },
      latest: (planId) => {
        const revision = latestRevision.get(planId)
        const stored = revision === undefined ? undefined : revisions.get(storageKey(planId, revision))
        return stored === undefined
          ? Effect.fail(new PlanNotFoundError({ planId }))
          : Effect.succeed(stored)
      },
      list: () =>
        Effect.sync(() => {
          const summaries: Array<PlanSummary> = []
          for (const [planId, revision] of latestRevision) {
            const stored = revisions.get(storageKey(planId, revision))!
            summaries.push({
              planId,
              latestRevision: stored.revision,
              fingerprint: stored.fingerprint
            })
          }
          summaries.sort((left, right) => (left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0))
          return summaries
        }),
      revisions: (planId) =>
        Effect.suspend(() => {
          const history = Array.from(revisions.values()).filter((stored) => stored.planId === planId)
          if (history.length === 0) {
            return Effect.fail(new PlanNotFoundError({ planId }))
          }
          history.sort((left, right) => left.revision - right.revision)
          return Effect.succeed(history as ReadonlyArray<StoredPlan>)
        })
    })
  })
)

/**
 * SQL-backed plan store sharing the memory layer's append-only semantics.
 *
 * **Details**
 *
 * Revisions live in one table keyed by `(plan_id, revision)` with the
 * canonical fingerprint and the plan document as JSON text. `save` remains
 * idempotent for identical content and conflicts on divergent content, and a
 * concurrent insert race resolves by re-reading the committed row.
 * Infrastructure failures after successful initialization are defects, not
 * typed errors, so the service interface stays identical across layers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSql = (options?: {
  readonly tableName?: string | undefined
}): Layer.Layer<PlanStore, SqlError.SqlError, SqlClient.SqlClient | Crypto.Crypto> =>
  Layer.effect(
    PlanStore,
    Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const crypto = yield* Crypto.Crypto
      const table = options?.tableName ?? "workflow_plans"
      const tableSql = sql(table)

      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name=${table} AND xtype='U')
            CREATE TABLE ${tableSql} (
              plan_id NVARCHAR(255) NOT NULL,
              revision INT NOT NULL,
              fingerprint NVARCHAR(80) NOT NULL,
              document NVARCHAR(MAX) NOT NULL,
              PRIMARY KEY (plan_id, revision)
            )`,
        mysql: () =>
          sql`CREATE TABLE IF NOT EXISTS ${tableSql} (
            plan_id VARCHAR(255) NOT NULL,
            revision INT NOT NULL,
            fingerprint VARCHAR(80) NOT NULL,
            document MEDIUMTEXT NOT NULL,
            PRIMARY KEY (plan_id, revision)
          )`,
        orElse: () =>
          sql`CREATE TABLE IF NOT EXISTS ${tableSql} (
            plan_id VARCHAR(255) NOT NULL,
            revision INTEGER NOT NULL,
            fingerprint VARCHAR(80) NOT NULL,
            document TEXT NOT NULL,
            PRIMARY KEY (plan_id, revision)
          )`
      })

      interface Row {
        readonly plan_id: string
        readonly revision: number
        readonly fingerprint: string
        readonly document: string
      }

      const decodePlan = Schema.decodeUnknownEffect(Plan.Plan, {
        errors: "all",
        onExcessProperty: "error"
      })

      const rowToStored = (row: Row): Effect.Effect<StoredPlan> =>
        decodePlan(JSON.parse(row.document)).pipe(
          Effect.map((plan): StoredPlan =>
            Object.freeze({
              planId: row.plan_id,
              revision: Number(row.revision),
              fingerprint: row.fingerprint as Fingerprint.Fingerprint,
              plan
            })
          ),
          Effect.orDie
        )

      const read = (planId: string, revision: number) =>
        sql<Row>`SELECT plan_id, revision, fingerprint, document
          FROM ${tableSql}
          WHERE plan_id = ${planId} AND revision = ${revision}`.pipe(Effect.orDie)

      const save: PlanStore["Service"]["save"] = (compiled) =>
        Effect.gen(function*() {
          if (!CompilerModule.isCompiled(compiled)) {
            return yield* Effect.die(
              new TypeError("PlanStore.save requires the exact compiled plan returned by Compiler.compile")
            )
          }
          const fingerprint = yield* Fingerprint.make(compiled).pipe(
            Effect.provideService(Crypto.Crypto, crypto)
          )
          const planId = compiled.plan.id
          const revision = compiled.plan.revision
          const verify = (rows: ReadonlyArray<Row>): Effect.Effect<StoredPlan, PlanConflictError> => {
            const existing = rows[0]!
            return existing.fingerprint === fingerprint
              ? rowToStored(existing)
              : Effect.fail(
                new PlanConflictError({
                  planId,
                  revision,
                  existing: existing.fingerprint as Fingerprint.Fingerprint,
                  submitted: fingerprint
                })
              )
          }
          const existing = yield* read(planId, revision)
          if (existing.length > 0) {
            return yield* verify(existing)
          }
          const document = JSON.stringify(compiled.plan)
          return yield* sql`INSERT INTO ${tableSql} (plan_id, revision, fingerprint, document)
            VALUES (${planId}, ${revision}, ${fingerprint}, ${document})`.pipe(
            Effect.map((): StoredPlan => Object.freeze({ planId, revision, fingerprint, plan: compiled.plan })),
            // A concurrent writer may have won the primary key; the committed
            // row decides idempotency versus conflict.
            Effect.catchCause(() =>
              read(planId, revision).pipe(
                Effect.flatMap((rows) =>
                  rows.length > 0
                    ? verify(rows)
                    : Effect.die(new Error("PlanStore.layerSql: insert failed without a committed row"))
                )
              )
            )
          )
        })

      return PlanStore.of({
        save,
        get: (planId, revision) =>
          read(planId, revision).pipe(
            Effect.flatMap((rows) =>
              rows.length === 0
                ? Effect.fail(new PlanNotFoundError({ planId, revision }))
                : rowToStored(rows[0]!)
            )
          ),
        latest: (planId) =>
          sql<Row>`SELECT plan_id, revision, fingerprint, document
            FROM ${tableSql}
            WHERE plan_id = ${planId}
            ORDER BY revision DESC
            LIMIT 1`.pipe(
            Effect.orDie,
            Effect.flatMap((rows) =>
              rows.length === 0
                ? Effect.fail(new PlanNotFoundError({ planId }))
                : rowToStored(rows[0]!)
            )
          ),
        list: () =>
          sql<Pick<Row, "plan_id" | "revision" | "fingerprint">>`SELECT plan_id, revision, fingerprint
            FROM ${tableSql} pins
            WHERE revision = (SELECT MAX(revision) FROM ${tableSql} WHERE plan_id = pins.plan_id)
            ORDER BY plan_id`.pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.map((row): PlanSummary => ({
                planId: row.plan_id,
                latestRevision: Number(row.revision),
                fingerprint: row.fingerprint as Fingerprint.Fingerprint
              }))
            )
          ),
        revisions: (planId) =>
          sql<Row>`SELECT plan_id, revision, fingerprint, document
            FROM ${tableSql}
            WHERE plan_id = ${planId}
            ORDER BY revision`.pipe(
            Effect.orDie,
            Effect.flatMap((rows) =>
              rows.length === 0
                ? Effect.fail(new PlanNotFoundError({ planId }))
                : Effect.forEach(rows, rowToStored)
            )
          )
      })
    })
  )
