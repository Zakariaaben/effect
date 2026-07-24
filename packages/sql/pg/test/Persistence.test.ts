import { assert, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Latch, Layer, Schema } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import { TestClock } from "effect/testing"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { PgContainer } from "./utils.ts"

PersistedCacheTest.suite(
  "sql-pg-multi",
  Persistence.layerSqlMultiTable.pipe(Layer.provide(PgContainer.layerClient))
)

PersistedCacheTest.suite(
  "sql-pg-single",
  Persistence.layerSql.pipe(Layer.provide(PgContainer.layerClient))
)

PersistedQueueTest.suite(
  "sql-pg",
  PersistedQueue.layerStoreSql().pipe(Layer.provide(PgContainer.layerClient))
)

it.layer(PgContainer.layerClient, { timeout: "30 seconds" })("PersistedQueue SQL locks", (it) => {
  it.effect("migrates the legacy global id index without dropping queue rows", () =>
    Effect.gen(function*() {
      const tableName = "effect_queue_legacy_id_index"
      const options = { tableName, pollInterval: "10 millis" } as const
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql(tableName)
      const legacyIndex = sql(`idx_${tableName}_id`)

      const legacyStore = yield* PersistedQueue.makeStoreSql(options)
      yield* sql`CREATE UNIQUE INDEX ${legacyIndex} ON ${table} (id)`

      const id = crypto.randomUUID()
      yield* legacyStore.offer({
        name: "legacy-index-a",
        id,
        element: { message: "first" },
        isCustomId: true
      })

      const store = yield* PersistedQueue.makeStoreSql(options)
      yield* store.offer({
        name: "legacy-index-b",
        id,
        element: { message: "second" },
        isCustomId: true
      })

      const rows = yield* sql<{ readonly queue_name: string }>`
        SELECT queue_name FROM ${table}
        WHERE id = ${id}
        ORDER BY queue_name
      `
      assert.deepStrictEqual(rows.map((row) => row.queue_name), ["legacy-index-a", "legacy-index-b"])
    }).pipe(TestClock.withLive))

  it.effect("refreshes locks for acquired elements", () =>
    Effect.gen(function*() {
      const options = {
        tableName: "effect_queue_lock_refresh",
        pollInterval: "10 millis",
        lockRefreshInterval: "100 millis",
        lockExpiration: "1 second"
      } as const
      const store1 = yield* PersistedQueue.makeStoreSql(options)
      const store2 = yield* PersistedQueue.makeStoreSql(options)
      const element = { message: "hello" }

      yield* store1.offer({
        name: "lock-refresh",
        id: crypto.randomUUID(),
        element,
        isCustomId: false
      })

      const acquired = Latch.makeUnsafe()
      const first = yield* Effect.scoped(Effect.gen(function*() {
        yield* store1.take({ name: "lock-refresh", maxAttempts: 10 })
        yield* acquired.open
        return yield* Effect.never
      })).pipe(Effect.forkScoped)

      yield* acquired.await

      const second = yield* Effect.scoped(
        store2.take({ name: "lock-refresh", maxAttempts: 10 })
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("1500 millis")
      assert.isUndefined(second.pollUnsafe())

      yield* Fiber.interrupt(first)
      const received = yield* Fiber.join(second)
      assert.deepStrictEqual(received.element, element)
    }).pipe(TestClock.withLive))

  it.effect("fences a stale finalizer after same-store reacquisition", () =>
    Effect.gen(function*() {
      const tableName = "effect_queue_acquisition_fence"
      const queueName = "acquisition-fence"
      const store = yield* PersistedQueue.makeStoreSql({
        tableName,
        pollInterval: "10 millis",
        lockRefreshInterval: "1 hour",
        lockExpiration: "1 second"
      })
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql(tableName)
      const id = crypto.randomUUID()

      yield* store.offer({
        name: queueName,
        id,
        element: { message: "hello" },
        isCustomId: false
      })

      const firstAcquired = Latch.makeUnsafe()
      const releaseFirst = Latch.makeUnsafe()
      const first = yield* Effect.scoped(Effect.gen(function*() {
        yield* store.take({ name: queueName, maxAttempts: 10 })
        yield* firstAcquired.open
        yield* releaseFirst.await
      })).pipe(Effect.forkScoped)
      yield* firstAcquired.await

      yield* sql`UPDATE ${table} SET acquired_at = ${new Date(0)} WHERE id = ${id}`

      const secondAcquired = Latch.makeUnsafe()
      const releaseSecond = Latch.makeUnsafe()
      const second = yield* Effect.scoped(Effect.gen(function*() {
        yield* store.take({ name: queueName, maxAttempts: 10 })
        yield* secondAcquired.open
        yield* releaseSecond.await
      })).pipe(Effect.forkScoped)
      yield* secondAcquired.await

      yield* releaseFirst.open
      yield* Fiber.join(first)

      const whileSecondOwns = yield* sql<{
        readonly completed: boolean
        readonly acquired_by: string | null
      }>`SELECT completed, acquired_by FROM ${table} WHERE id = ${id}`
      assert.isFalse(whileSecondOwns[0].completed)
      assert.isNotNull(whileSecondOwns[0].acquired_by)

      yield* releaseSecond.open
      yield* Fiber.join(second)

      const afterSecondCompletes = yield* sql<{
        readonly completed: boolean
        readonly acquired_by: string | null
      }>`SELECT completed, acquired_by FROM ${table} WHERE id = ${id}`
      assert.isTrue(afterSecondCompletes[0].completed)
      assert.isNull(afterSecondCompletes[0].acquired_by)
    }).pipe(TestClock.withLive))

  it.effect("signals confirmed acquisition ownership loss", () =>
    Effect.gen(function*() {
      const tableName = "effect_queue_ownership_loss"
      const queueName = "ownership-loss"
      const store = yield* PersistedQueue.makeStoreSql({
        tableName,
        pollInterval: "10 millis",
        lockRefreshInterval: "20 millis",
        lockExpiration: "1 second"
      })
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql(tableName)
      const id = crypto.randomUUID()

      yield* store.offer({
        name: queueName,
        id,
        element: { message: "hello" },
        isCustomId: false
      })

      const acquired = Latch.makeUnsafe()
      const lost = Latch.makeUnsafe()
      const release = Latch.makeUnsafe()
      const worker = yield* Effect.scoped(Effect.gen(function*() {
        const item = yield* store.take({ name: queueName, maxAttempts: 10 })
        yield* item.acquisition.ownershipLost.pipe(
          Effect.andThen(Effect.gen(function*() {
            assert.isTrue(yield* item.acquisition.isOwnershipLost)
            yield* lost.open
          })),
          Effect.forkScoped
        )
        yield* acquired.open
        yield* release.await
      })).pipe(Effect.forkScoped)

      yield* acquired.await
      yield* sql`
        UPDATE ${table}
        SET acquired_by = ${crypto.randomUUID()}
        WHERE id = ${id}
      `
      yield* lost.await

      yield* release.open
      yield* Fiber.join(worker)
    }).pipe(TestClock.withLive))

  it.effect("fails closed after the unconfirmed ownership horizon", () =>
    Effect.gen(function*() {
      const store = yield* PersistedQueue.makeStoreSql({
        tableName: "effect_queue_ownership_horizon",
        pollInterval: "10 millis",
        lockRefreshInterval: "1 hour",
        lockExpiration: "100 millis"
      })
      const queueName = "ownership-horizon"

      yield* store.offer({
        name: queueName,
        id: crypto.randomUUID(),
        element: { message: "hello" },
        isCustomId: false
      })

      const worker = yield* Effect.scoped(Effect.gen(function*() {
        const item = yield* store.take({ name: queueName, maxAttempts: 10 })
        assert.isFalse(yield* item.acquisition.isOwnershipLost)
        yield* item.acquisition.ownershipLost
        assert.isTrue(yield* item.acquisition.isOwnershipLost)
        return yield* Effect.interrupt
      })).pipe(Effect.forkScoped)

      yield* Fiber.await(worker)
    }).pipe(TestClock.withLive))

  it.effect("counts malformed JSON as an attempt and continues", () =>
    Effect.gen(function*() {
      const tableName = "effect_queue_invalid_json"
      const store = yield* PersistedQueue.makeStoreSql({
        tableName,
        pollInterval: "10 millis"
      })
      const factory = yield* PersistedQueue.makeFactory.pipe(
        Effect.provideService(PersistedQueue.PersistedQueueStore, store)
      )
      const queue = yield* factory.make({
        name: "invalid-json",
        schema: Schema.String
      })
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql(tableName)
      const poisonId = crypto.randomUUID()

      yield* store.offer({
        name: "invalid-json",
        id: poisonId,
        element: "poison",
        isCustomId: false
      })
      yield* sql`UPDATE ${table} SET element = ${"{"} WHERE id = ${poisonId}`
      yield* queue.offer("valid")

      const malformed = yield* Effect.exit(queue.take(Effect.succeed, { maxAttempts: 1 }))
      assert.isTrue(Exit.isFailure(malformed))

      const rows = yield* sql<{
        readonly attempts: number
        readonly last_failure: string | null
      }>`SELECT attempts, last_failure FROM ${table} WHERE id = ${poisonId}`
      assert.strictEqual(rows[0].attempts, 1)
      assert.isNotNull(rows[0].last_failure)

      const value = yield* queue.take(Effect.succeed, { maxAttempts: 1 })
      assert.strictEqual(value, "valid")
    }).pipe(TestClock.withLive))
})
