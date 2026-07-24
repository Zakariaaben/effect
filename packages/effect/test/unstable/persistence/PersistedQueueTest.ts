import { assert, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Latch, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { PersistedQueue } from "effect/unstable/persistence"

export const suite = (name: string, layer: Layer.Layer<PersistedQueue.PersistedQueueStore, unknown>) =>
  it.layer(
    PersistedQueue.layer.pipe(
      Layer.provideMerge(layer)
    ),
    { timeout: "30 seconds" }
  )(`PersistedQueue (${name})`, (it) => {
    it.effect("offer + take", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-a",
          schema: Item
        })

        yield* queue.offer({ n: 42n })
        yield* queue.take(Effect.fnUntraced(function*(value) {
          assert.strictEqual(value.n, 42n)
        }))
      }))

    it.effect("interrupt does not exhaust max attempts", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-b",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        const latch = Latch.makeUnsafe()
        const fiber = yield* queue.take(
          Effect.fnUntraced(function*(_value) {
            yield* latch.open
            return yield* Effect.never
          }),
          { maxAttempts: 1 }
        ).pipe(Effect.forkScoped)

        const fiber2 = yield* queue.take((val, { attempts }) => {
          assert.strictEqual(attempts, 0)
          return Effect.succeed(val)
        }, { maxAttempts: 1 }).pipe(Effect.forkScoped)

        yield* latch.await

        // allow some real time to pass to ensure the second take is really
        // waiting
        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(
          TestClock.withLive
        )
        assert.isUndefined(fiber2.pollUnsafe())

        yield* Fiber.interrupt(fiber)

        yield* TestClock.adjust(1000)

        assert.strictEqual((yield* Fiber.join(fiber2)).n, 42n)
      }))

    it.effect("keeps ownership-loss pending while the acquisition is current", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-ownership-current",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        yield* queue.take(Effect.fnUntraced(function*(_value, { acquisition }) {
          assert.isFalse(yield* acquisition.isOwnershipLost)
          const lost = yield* acquisition.ownershipLost.pipe(Effect.forkScoped)
          yield* Effect.sleep("250 millis").pipe(TestClock.withLive)
          assert.isUndefined(lost.pollUnsafe())
        }))
      }))

    it.effect("failure", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-c",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        const error = yield* queue.take(() => Effect.fail("boom")).pipe(Effect.flip)
        assert.strictEqual(error, "boom")

        const value = yield* queue.take((val, { attempts }) => {
          assert.strictEqual(attempts, 1)
          return Effect.succeed(val)
        })
        assert.strictEqual(value.n, 42n)
      }))

    it.effect("counts a mixed failure and interruption cause as an attempt", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-mixed-failure-interruption",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        yield* queue.take(
          () => Effect.failCause(Cause.combine(Cause.fail("boom"), Cause.interrupt(1))),
          { maxAttempts: 2 }
        ).pipe(Effect.exit)

        const value = yield* queue.take((val, { attempts }) => {
          assert.strictEqual(attempts, 1)
          return Effect.succeed(val)
        }, { maxAttempts: 2 })
        assert.strictEqual(value.n, 42n)
      }))

    it.effect("idempotent offer", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "idempotent-offer",
          schema: Item
        })

        yield* queue.offer({ n: 42n }, { id: "custom-id" })
        yield* queue.offer({ n: 42n }, { id: "custom-id" })
        yield* queue.take(Effect.fnUntraced(function*(value) {
          assert.strictEqual(value.n, 42n)
        }))
        const fiber = yield* queue.take(Effect.fnUntraced(function*(value) {
          assert.strictEqual(value.n, 42n)
        })).pipe(Effect.forkScoped)

        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(
          TestClock.withLive
        )

        assert.isUndefined(fiber.pollUnsafe())
      }))

    it.effect("scopes custom-id de-duplication to each queue", () =>
      Effect.gen(function*() {
        const queueA = yield* PersistedQueue.make({
          name: "queue-scoped-id-a",
          schema: Item
        })
        const queueB = yield* PersistedQueue.make({
          name: "queue-scoped-id-b",
          schema: Item
        })

        yield* queueA.offer({ n: 1n }, { id: "shared-custom-id" })
        yield* queueB.offer({ n: 2n }, { id: "shared-custom-id" })

        assert.strictEqual((yield* queueA.take(Effect.succeed)).n, 1n)
        assert.strictEqual((yield* queueB.take(Effect.succeed)).n, 2n)
      }))

    it.effect("does not redeliver in-flight elements", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-reset",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        const taken = Latch.makeUnsafe()
        const release = Latch.makeUnsafe()
        const fiber = yield* queue.take(() => Effect.andThen(taken.open, release.await)).pipe(Effect.forkScoped)
        yield* taken.await

        const fiber2 = yield* queue.take((val) => Effect.succeed(val)).pipe(Effect.forkScoped)

        // allow any periodic reset in the store to run while the element is
        // still being processed
        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(
          TestClock.withLive
        )

        assert.isUndefined(fiber2.pollUnsafe())

        // after a successful take the element should not be delivered again
        yield* release.open
        yield* Fiber.join(fiber)
        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(
          TestClock.withLive
        )

        assert.isUndefined(fiber2.pollUnsafe())

        yield* Fiber.interrupt(fiber2)
      }))

    it.effect("stops delivering when maxAttempts is exhausted", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-exhausted",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        const error = yield* queue
          .take(() => Effect.fail("boom"), { maxAttempts: 1 })
          .pipe(Effect.flip)

        assert.strictEqual(error, "boom")

        const fiber = yield* queue.take((val) => Effect.succeed(val), { maxAttempts: 1 }).pipe(Effect.forkScoped)

        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(
          TestClock.withLive
        )

        assert.isUndefined(fiber.pollUnsafe())
      }))

    it.effect("keeps exhausted elements terminal when a later take raises maxAttempts", () =>
      Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          name: "test-queue-exhausted-terminal",
          schema: Item
        })

        yield* queue.offer({ n: 42n })

        const error = yield* queue
          .take(() => Effect.fail("boom"), { maxAttempts: 1 })
          .pipe(Effect.flip)

        assert.strictEqual(error, "boom")

        const fiber = yield* queue.take((val) => Effect.succeed(val), { maxAttempts: 2 }).pipe(Effect.forkScoped)

        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(TestClock.withLive)

        assert.isUndefined(fiber.pollUnsafe())
      }))

    it.effect("counts schema decode failures as attempts", () =>
      Effect.gen(function*() {
        const store = yield* PersistedQueue.PersistedQueueStore
        const queue = yield* PersistedQueue.make({
          name: "test-queue-decode-failure",
          schema: Item
        })

        yield* store.offer({
          name: "test-queue-decode-failure",
          id: crypto.randomUUID(),
          element: { n: null },
          isCustomId: false
        })

        const error = yield* queue.take(Effect.succeed, { maxAttempts: 1 }).pipe(Effect.flip)
        assert.isTrue(Schema.isSchemaError(error))

        const fiber = yield* queue.take(Effect.succeed, { maxAttempts: 1 }).pipe(Effect.forkScoped)

        yield* TestClock.adjust(1000)
        yield* Effect.sleep(1000).pipe(TestClock.withLive)

        assert.isUndefined(fiber.pollUnsafe())
      }))
  })

const Item = Schema.Struct({
  n: Schema.BigInt
})
