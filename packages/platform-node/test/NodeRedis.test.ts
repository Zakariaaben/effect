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

        const keys = redisQueueKeys("effectq:", queueName)
        const failed = yield* redis.use((client) => client.lrange(keys.failed, 0, -1))
        assert.strictEqual(failed.length, 1)
        const failedItem = JSON.parse(failed[0])
        assert.strictEqual(failedItem.id, id)
        assert.deepStrictEqual(failedItem.element, { n: 42 })
        assert.strictEqual(failedItem.attempts, 1)

        const pending = yield* redis.use((client) => client.hlen(keys.pending))
        assert.strictEqual(pending, 0)
      }))

    it.effect("isolates public queue names from internal Redis key families", () =>
      Effect.gen(function*() {
        const baseName = "test-redis-key-family"
        const queue = yield* PersistedQueue.make({
          name: baseName,
          schema: RedisItem
        })
        const suffixQueue = yield* PersistedQueue.make({
          name: `${baseName}:pending`,
          schema: RedisItem
        })

        yield* queue.offer({ n: 1 })
        yield* suffixQueue.offer({ n: 2 })

        assert.strictEqual((yield* queue.take(Effect.succeed)).n, 1)
        assert.strictEqual((yield* suffixQueue.take(Effect.succeed)).n, 2)
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
            const keys = redisQueueKeys(prefix, queueName)
            const queueKey = keys.ready
            const pendingKey = keys.pending
            const failedKey = keys.failed
            const maxAttempts = mode === "failed" ? 1 : 10
            const id = crypto.randomUUID()
            const lockKey = keys.lock(id)

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

    it.effect("signals confirmed acquisition ownership loss", () =>
      Effect.gen(function*() {
        const redis = yield* NodeRedis.NodeRedis
        const prefix = "effectq-ownership-loss:"
        const queueName = "ownership-loss"
        const id = crypto.randomUUID()
        const lockKey = redisQueueKeys(prefix, queueName).lock(id)
        const store = yield* PersistedQueue.makeStoreRedis({
          prefix,
          pollInterval: "10 millis",
          lockRefreshInterval: "20 millis",
          lockExpiration: "1 second"
        })

        yield* store.offer({
          name: queueName,
          id,
          element: { n: 42 },
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
        yield* redis.use((client) => client.set(lockKey, "replacement-acquisition"))
        yield* lost.await

        yield* release.open
        yield* Fiber.join(worker)
      }).pipe(TestClock.withLive))

    it.effect("fails closed after the unconfirmed ownership horizon", () =>
      Effect.gen(function*() {
        const store = yield* PersistedQueue.makeStoreRedis({
          prefix: "effectq-ownership-horizon:",
          pollInterval: "10 millis",
          lockRefreshInterval: "1 hour",
          lockExpiration: "100 millis"
        })
        const queueName = "ownership-horizon"

        yield* store.offer({
          name: queueName,
          id: crypto.randomUUID(),
          element: { n: 42 },
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
  }
)

const RedisItem = Schema.Struct({
  n: Schema.Number
})

const redisQueueKeys = (prefix: string, name: string) => {
  const base = `${prefix}v2:queue:${name.length}:${name}:`
  return {
    ready: `${base}ready`,
    pending: `${base}pending`,
    failed: `${base}failed`,
    lock: (id: string) => `${base}lock:${id}`
  } as const
}
