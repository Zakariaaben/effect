import { NodeRedis } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { RedisContainer } from "@testcontainers/redis"
import { Effect, Fiber, Latch, Layer, Schema } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import { TestClock } from "effect/testing"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"

const RedisLayer = Layer.unwrap(
  Effect.gen(function*() {
    const container = yield* Effect.acquireRelease(
      Effect.promise(() => new RedisContainer("redis:alpine").start()),
      (container) => Effect.promise(() => container.stop())
    )
    return NodeRedis.layer({
      host: container.getHost(),
      port: container.getMappedPort(6379)
    })
  }).pipe(
    Effect.catchCause(() => Effect.fail(new PersistedCacheTest.TransientError()))
  )
)

PersistedCacheTest.suite(
  "NodeRedis",
  Persistence.layerRedis.pipe(Layer.provide(RedisLayer))
)

PersistedQueueTest.suite(
  "NodeRedis",
  // short intervals so the periodic reset runs while the suite's takes are
  // in flight
  PersistedQueue.layerStoreRedis({
    pollInterval: "50 millis",
    lockRefreshInterval: "100 millis"
  }).pipe(Layer.provide(RedisLayer))
)

const PersistedQueueRedisLayer = Layer.mergeAll(
  RedisLayer,
  PersistedQueue.layer.pipe(
    Layer.provideMerge(
      PersistedQueue.layerStoreRedis().pipe(Layer.provide(RedisLayer))
    )
  )
)

it.layer(PersistedQueueRedisLayer, { timeout: "30 seconds" })(
  "PersistedQueue (NodeRedis)",
  (it) => {
    // The shared PersistedQueue suite can only assert that exhausted elements
    // are no longer delivered, which is also true if they are silently
    // dropped. There is no public API for reading failed elements, so
    // verifying they are preserved in the dead-letter list requires
    // inspecting Redis directly.
    it.effect("moves exhausted elements to the failed list", () =>
      Effect.gen(function*() {
        const redis = yield* NodeRedis.NodeRedis
        const queueName = "test-redis-failed"

        const queue = yield* PersistedQueue.make({
          name: queueName,
          schema: RedisItem
        })
        const id = yield* queue.offer({ n: 42 })
        const error = yield* queue.take(() => Effect.fail("boom"), { maxAttempts: 1 }).pipe(Effect.flip)
        assert.strictEqual(error, "boom")

        const failed = yield* redis.use((client) => client.lrange(`effectq:${queueName}:failed`, 0, -1))
        assert.strictEqual(failed.length, 1)
        const failedItem = JSON.parse(failed[0])
        assert.strictEqual(failedItem.id, id)
        assert.deepStrictEqual(failedItem.element, { n: 42 })
        assert.strictEqual(failedItem.attempts, 1)

        const pending = yield* redis.use((client) => client.hlen(`effectq:${queueName}:pending`))
        assert.strictEqual(pending, 0)
      }))

    it.effect("fences stale completion, requeue, and failed-item finalizers", () =>
      Effect.gen(function*() {
        const redis = yield* NodeRedis.NodeRedis
        const prefix = "effectq-fence:"
        const store = yield* PersistedQueue.makeStoreRedis({
          prefix,
          pollInterval: "10 millis",
          lockRefreshInterval: "1 hour",
          lockExpiration: "1 hour"
        })

        yield* Effect.forEach(
          ["complete", "requeue", "failed"] as const,
          Effect.fnUntraced(function*(mode) {
            const queueName = `same-store-${mode}`
            const queueKey = `${prefix}${queueName}`
            const pendingKey = `${queueKey}:pending`
            const failedKey = `${queueKey}:failed`
            const maxAttempts = mode === "failed" ? 1 : 10
            const id = crypto.randomUUID()
            const lockKey = `${prefix}${id}:lock`

            yield* store.offer({
              name: queueName,
              id,
              element: { n: 42 },
              isCustomId: false
            })

            const firstAcquired = Latch.makeUnsafe()
            const releaseFirst = Latch.makeUnsafe()
            const first = yield* Effect.scoped(Effect.gen(function*() {
              yield* store.take({ name: queueName, maxAttempts })
              yield* firstAcquired.open
              yield* releaseFirst.await
              if (mode !== "complete") {
                return yield* Effect.fail("stale")
              }
            })).pipe(Effect.forkScoped)
            yield* firstAcquired.await

            const pendingPayload = yield* redis.use((client) => client.hget(pendingKey, id))
            assert.isNotNull(pendingPayload)
            yield* redis.use((client) => client.del(lockKey))
            yield* redis.use((client) => client.hdel(pendingKey, id))
            yield* redis.use((client) => client.rpush(queueKey, pendingPayload))

            const secondAcquired = Latch.makeUnsafe()
            const releaseSecond = Latch.makeUnsafe()
            const second = yield* Effect.scoped(Effect.gen(function*() {
              yield* store.take({ name: queueName, maxAttempts })
              yield* secondAcquired.open
              yield* releaseSecond.await
            })).pipe(Effect.forkScoped)
            yield* secondAcquired.await

            yield* releaseFirst.open
            yield* Fiber.await(first)

            assert.isNotNull(yield* redis.use((client) => client.get(lockKey)))
            assert.isNotNull(yield* redis.use((client) => client.hget(pendingKey, id)))
            assert.strictEqual(yield* redis.use((client) => client.llen(queueKey)), 0)
            assert.strictEqual(yield* redis.use((client) => client.llen(failedKey)), 0)

            yield* releaseSecond.open
            yield* Fiber.join(second)

            assert.isNull(yield* redis.use((client) => client.get(lockKey)))
            assert.isNull(yield* redis.use((client) => client.hget(pendingKey, id)))
            assert.strictEqual(yield* redis.use((client) => client.llen(queueKey)), 0)
            assert.strictEqual(yield* redis.use((client) => client.llen(failedKey)), 0)
          }),
          { discard: true }
        )
      }).pipe(TestClock.withLive))
  }
)

const RedisItem = Schema.Struct({
  n: Schema.Number
})
