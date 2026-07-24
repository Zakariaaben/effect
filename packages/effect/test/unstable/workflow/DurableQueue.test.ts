import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Latch, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { PersistedQueue } from "effect/unstable/persistence"
import { DurableQueue, Workflow, WorkflowEngine } from "effect/unstable/workflow"

const maxAttempts = new Array<number | undefined>()

const PersistedQueueLayer = Layer.effect(
  PersistedQueue.PersistedQueueFactory,
  PersistedQueue.makeFactory.pipe(
    Effect.map((factory) =>
      PersistedQueue.PersistedQueueFactory.of({
        make: (options) =>
          factory.make(options).pipe(
            Effect.map((queue) => ({
              ...queue,
              take: (f, options) => {
                maxAttempts.push(options?.maxAttempts)
                return queue.take(f, options)
              }
            }))
          )
      })
    )
  )
).pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

const redeliverAfterTerminalLayer = (
  state: {
    deliveries: number
    failedOnce: boolean
  },
  secondDeliveryCompleted: Latch.Latch
) =>
  Layer.effect(
    PersistedQueue.PersistedQueueFactory,
    PersistedQueue.makeFactory.pipe(
      Effect.map((factory) =>
        PersistedQueue.PersistedQueueFactory.of({
          make: (options) =>
            factory.make(options).pipe(
              Effect.map((queue) => ({
                ...queue,
                take: (f, takeOptions) =>
                  queue.take(
                    (value, metadata) =>
                      Effect.gen(function*() {
                        state.deliveries++
                        const result = yield* f(value, metadata)
                        if (!state.failedOnce) {
                          state.failedOnce = true
                          return yield* Effect.die(
                            "simulated crash after durable terminal publication"
                          )
                        }
                        yield* secondDeliveryCompleted.open
                        return result
                      }),
                    takeOptions
                  )
              }))
            )
        })
      )
    )
  ).pipe(
    Layer.provideMerge(PersistedQueue.layerStoreMemory)
  )

const controlFirstOwnershipLayer = (
  state: {
    deliveries: number
    readonly attempts: Array<number>
  },
  secondDeliveryAcquired: Latch.Latch,
  allowSecondDelivery: Latch.Latch,
  transform: (
    acquisition: PersistedQueue.Acquisition
  ) => PersistedQueue.Acquisition
) =>
  Layer.effect(
    PersistedQueue.PersistedQueueFactory,
    PersistedQueue.makeFactory.pipe(
      Effect.map((factory) =>
        PersistedQueue.PersistedQueueFactory.of({
          make: (options) =>
            factory.make(options).pipe(
              Effect.map((queue) => ({
                ...queue,
                take: (f, takeOptions) =>
                  queue.take(
                    (value, metadata) =>
                      Effect.gen(function*() {
                        state.deliveries++
                        state.attempts.push(metadata.attempts)
                        if (state.deliveries === 2) {
                          yield* secondDeliveryAcquired.open
                          yield* allowSecondDelivery.await
                        }
                        return yield* f(
                          value,
                          state.deliveries === 1
                            ? {
                              ...metadata,
                              acquisition: transform(metadata.acquisition)
                            }
                            : metadata
                        )
                      }),
                    takeOptions
                  )
              }))
            )
        })
      )
    )
  ).pipe(
    Layer.provideMerge(PersistedQueue.layerStoreMemory)
  )

const pollUntilComplete = <A, E, R>(
  poll: Effect.Effect<Option.Option<Workflow.Result<A, E>>, never, R>
) =>
  Effect.gen(function*() {
    let polled = yield* poll
    for (let i = 0; i < 10 && (Option.isNone(polled) || polled.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* Effect.sleep("10 millis").pipe(TestClock.withLive)
      polled = yield* poll
    }
    return polled
  })

describe("DurableQueue", () => {
  const successWorkerMetadata = new Array<DurableQueue.WorkerMetadata>()

  const SuccessQueue = DurableQueue.make({
    name: "DurableQueueTest/SuccessQueue",
    payload: {
      id: Schema.String,
      value: Schema.Number
    },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })

  const SuccessWorkflow = Workflow.make("DurableQueueTest/SuccessWorkflow", {
    payload: {
      id: Schema.String,
      value: Schema.Number
    },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })

  const SuccessLayer = Layer.mergeAll(
    SuccessWorkflow.toLayer(({ id, value }) => DurableQueue.process(SuccessQueue, { id, value })),
    DurableQueue.worker(
      SuccessQueue,
      ({ value }, metadata) =>
        Effect.sync(() => {
          successWorkerMetadata.push(metadata)
          return value + 1
        }),
      { maxAttempts: 1 }
    )
  ).pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  it.effect("forwards max attempts and metadata to workers", () =>
    Effect.gen(function*() {
      const executionId = yield* SuccessWorkflow.execute({ id: "success", value: 41 }, { discard: true })
      const polled = yield* pollUntilComplete(SuccessWorkflow.poll(executionId))

      assert(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isSuccess(polled.value.exit))
      assert.strictEqual(polled.value.exit.value, 42)
      assert.isTrue(maxAttempts.includes(1))
      assert.strictEqual(successWorkerMetadata.length, 1)
      assert.strictEqual(successWorkerMetadata[0]!.attempts, 0)
      assert.isTrue(successWorkerMetadata[0]!.id.length > 0)
    }).pipe(Effect.provide(SuccessLayer)))

  const FailureQueue = DurableQueue.make({
    name: "DurableQueueTest/FailureQueue",
    payload: {
      id: Schema.String
    },
    success: Schema.Void,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })

  const FailureWorkflow = Workflow.make("DurableQueueTest/FailureWorkflow", {
    payload: {
      id: Schema.String
    },
    success: Schema.Void,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })

  const FailureLayer = Layer.mergeAll(
    FailureWorkflow.toLayer(({ id }) => DurableQueue.process(FailureQueue, { id })),
    DurableQueue.worker(
      FailureQueue,
      () => Effect.fail("boom")
    )
  ).pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  it.effect("propagates worker failures to the workflow", () =>
    Effect.gen(function*() {
      const executionId = yield* FailureWorkflow.execute({ id: "failure" }, { discard: true })
      const polled = yield* pollUntilComplete(FailureWorkflow.poll(executionId))

      assert(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isFailure(polled.value.exit))
      const failure = polled.value.exit.cause.reasons.find(Cause.isFailReason)
      assert.strictEqual(failure?.error, "boom")
    }).pipe(Effect.provide(FailureLayer)))

  it.effect("drains a redelivery with an existing terminal without invoking or overwriting the handler", () => {
    const state = {
      deliveries: 0,
      failedOnce: false
    }
    const secondDeliveryCompleted = Latch.makeUnsafe()
    let handlerExecutions = 0
    const queue = DurableQueue.make({
      name: "DurableQueueTest/TerminalRedeliveryQueue",
      payload: {
        id: Schema.String
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const workflow = Workflow.make("DurableQueueTest/TerminalRedeliveryWorkflow", {
      payload: {
        id: Schema.String
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      workflow.toLayer(({ id }) => DurableQueue.process(queue, { id })),
      DurableQueue.worker(
        queue,
        () =>
          Effect.sync(() => {
            handlerExecutions++
            return handlerExecutions
          }),
        { maxAttempts: 3 }
      )
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(
        redeliverAfterTerminalLayer(
          state,
          secondDeliveryCompleted
        )
      )
    )

    return Effect.gen(function*() {
      const executionId = yield* workflow.execute(
        { id: "terminal-redelivery" },
        { discard: true }
      )
      yield* secondDeliveryCompleted.await
      const polled = yield* pollUntilComplete(workflow.poll(executionId))

      assert.strictEqual(state.deliveries, 2)
      assert.strictEqual(handlerExecutions, 1)
      assert(
        Option.isSome(polled) &&
          polled.value._tag === "Complete" &&
          Exit.isSuccess(polled.value.exit)
      )
      assert.strictEqual(polled.value.exit.value, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("requeues ownership loss without publishing an interrupted handler exit", () => {
    const state = {
      deliveries: 0,
      attempts: new Array<number>()
    }
    const firstHandlerStarted = Latch.makeUnsafe()
    const secondDeliveryAcquired = Latch.makeUnsafe()
    const allowSecondDelivery = Latch.makeUnsafe()
    let handlerExecutions = 0
    const queue = DurableQueue.make({
      name: "DurableQueueTest/OwnershipLossQueue",
      payload: {
        id: Schema.String,
        value: Schema.Number
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const workflow = Workflow.make("DurableQueueTest/OwnershipLossWorkflow", {
      payload: {
        id: Schema.String,
        value: Schema.Number
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      workflow.toLayer(({ id, value }) => DurableQueue.process(queue, { id, value })),
      DurableQueue.worker(
        queue,
        ({ value }) =>
          Effect.gen(function*() {
            handlerExecutions++
            if (handlerExecutions === 1) {
              yield* firstHandlerStarted.open
              return yield* Effect.never
            }
            return value + 1
          }),
        { maxAttempts: 1 }
      )
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(
        controlFirstOwnershipLayer(
          state,
          secondDeliveryAcquired,
          allowSecondDelivery,
          (acquisition) => ({
            ...acquisition,
            ownershipLost: firstHandlerStarted.await
          })
        )
      )
    )

    return Effect.gen(function*() {
      const executionId = yield* workflow.execute(
        { id: "ownership-loss", value: 41 },
        { discard: true }
      )
      yield* secondDeliveryAcquired.await

      const beforeRedelivery = yield* workflow.poll(executionId)
      assert(
        Option.isNone(beforeRedelivery) ||
          beforeRedelivery.value._tag === "Suspended"
      )
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerExecutions, 1)

      yield* allowSecondDelivery.open
      const completed = yield* pollUntilComplete(workflow.poll(executionId))

      assert.strictEqual(state.deliveries, 2)
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerExecutions, 2)
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      assert.strictEqual(completed.value.exit.value, 42)
    }).pipe(Effect.provide(layer))
  })

  it.effect("does not construct a handler for an acquisition already known to be lost", () => {
    const state = {
      deliveries: 0,
      attempts: new Array<number>()
    }
    const secondDeliveryAcquired = Latch.makeUnsafe()
    const allowSecondDelivery = Latch.makeUnsafe()
    let handlerConstructions = 0
    let handlerExecutions = 0
    const queue = DurableQueue.make({
      name: "DurableQueueTest/AlreadyLostOwnershipQueue",
      payload: {
        id: Schema.String,
        value: Schema.Number
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const workflow = Workflow.make("DurableQueueTest/AlreadyLostOwnershipWorkflow", {
      payload: {
        id: Schema.String,
        value: Schema.Number
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      workflow.toLayer(({ id, value }) => DurableQueue.process(queue, { id, value })),
      DurableQueue.worker(
        queue,
        ({ value }) => {
          handlerConstructions++
          return Effect.sync(() => {
            handlerExecutions++
            return value + 1
          })
        },
        { maxAttempts: 1 }
      )
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(
        controlFirstOwnershipLayer(
          state,
          secondDeliveryAcquired,
          allowSecondDelivery,
          (acquisition) => ({
            ...acquisition,
            isOwnershipLost: Effect.succeed(true),
            ownershipLost: Effect.void
          })
        )
      )
    )

    return Effect.gen(function*() {
      const executionId = yield* workflow.execute(
        { id: "already-lost-ownership", value: 41 },
        { discard: true }
      )
      yield* secondDeliveryAcquired.await

      const beforeRedelivery = yield* workflow.poll(executionId)
      assert(
        Option.isNone(beforeRedelivery) ||
          beforeRedelivery.value._tag === "Suspended"
      )
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerConstructions, 0)
      assert.strictEqual(handlerExecutions, 0)

      yield* allowSecondDelivery.open
      const completed = yield* pollUntilComplete(workflow.poll(executionId))

      assert.strictEqual(state.deliveries, 2)
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerConstructions, 1)
      assert.strictEqual(handlerExecutions, 1)
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      assert.strictEqual(completed.value.exit.value, 42)
    }).pipe(Effect.provide(layer))
  })

  it.effect("prioritizes ownership loss observed between the precheck and race", () => {
    const state = {
      deliveries: 0,
      attempts: new Array<number>()
    }
    const ownershipLost = Latch.makeUnsafe()
    const secondDeliveryAcquired = Latch.makeUnsafe()
    const allowSecondDelivery = Latch.makeUnsafe()
    let handlerConstructions = 0
    let handlerExecutions = 0
    const queue = DurableQueue.make({
      name: "DurableQueueTest/PreRaceOwnershipLossQueue",
      payload: {
        id: Schema.String,
        value: Schema.Number
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const workflow = Workflow.make("DurableQueueTest/PreRaceOwnershipLossWorkflow", {
      payload: {
        id: Schema.String,
        value: Schema.Number
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      workflow.toLayer(({ id, value }) => DurableQueue.process(queue, { id, value })),
      DurableQueue.worker(
        queue,
        ({ value }) => {
          handlerConstructions++
          return Effect.sync(() => {
            handlerExecutions++
            return value + 1
          })
        },
        { maxAttempts: 1 }
      )
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(
        controlFirstOwnershipLayer(
          state,
          secondDeliveryAcquired,
          allowSecondDelivery,
          (acquisition) => ({
            ...acquisition,
            isOwnershipLost: Effect.andThen(
              ownershipLost.open,
              Effect.succeed(false)
            ),
            ownershipLost: ownershipLost.await
          })
        )
      )
    )

    return Effect.gen(function*() {
      const executionId = yield* workflow.execute(
        { id: "pre-race-ownership-loss", value: 41 },
        { discard: true }
      )
      yield* secondDeliveryAcquired.await

      const beforeRedelivery = yield* workflow.poll(executionId)
      assert(
        Option.isNone(beforeRedelivery) ||
          beforeRedelivery.value._tag === "Suspended"
      )
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerConstructions, 0)
      assert.strictEqual(handlerExecutions, 0)

      yield* allowSecondDelivery.open
      const completed = yield* pollUntilComplete(workflow.poll(executionId))

      assert.strictEqual(state.deliveries, 2)
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerConstructions, 1)
      assert.strictEqual(handlerExecutions, 1)
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      assert.strictEqual(completed.value.exit.value, 42)
    }).pipe(Effect.provide(layer))
  })

  it.effect("drops a handler result when ownership is lost before publication", () => {
    const state = {
      deliveries: 0,
      attempts: new Array<number>()
    }
    const secondDeliveryAcquired = Latch.makeUnsafe()
    const allowSecondDelivery = Latch.makeUnsafe()
    let ownershipChecks = 0
    let handlerExecutions = 0
    const queue = DurableQueue.make({
      name: "DurableQueueTest/PrePublicationOwnershipLossQueue",
      payload: {
        id: Schema.String
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const workflow = Workflow.make("DurableQueueTest/PrePublicationOwnershipLossWorkflow", {
      payload: {
        id: Schema.String
      },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      workflow.toLayer(({ id }) => DurableQueue.process(queue, { id })),
      DurableQueue.worker(
        queue,
        () =>
          Effect.sync(() => {
            handlerExecutions++
            return handlerExecutions
          }),
        { maxAttempts: 1 }
      )
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(
        controlFirstOwnershipLayer(
          state,
          secondDeliveryAcquired,
          allowSecondDelivery,
          (acquisition) => ({
            ...acquisition,
            isOwnershipLost: Effect.sync(() => {
              ownershipChecks++
              return ownershipChecks >= 2
            }),
            ownershipLost: Effect.never
          })
        )
      )
    )

    return Effect.gen(function*() {
      const executionId = yield* workflow.execute(
        { id: "pre-publication-ownership-loss" },
        { discard: true }
      )
      yield* secondDeliveryAcquired.await

      const beforeRedelivery = yield* workflow.poll(executionId)
      assert(
        Option.isNone(beforeRedelivery) ||
          beforeRedelivery.value._tag === "Suspended"
      )
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(ownershipChecks, 2)
      assert.strictEqual(handlerExecutions, 1)

      yield* allowSecondDelivery.open
      const completed = yield* pollUntilComplete(workflow.poll(executionId))

      assert.strictEqual(state.deliveries, 2)
      assert.deepStrictEqual(state.attempts, [0, 0])
      assert.strictEqual(handlerExecutions, 2)
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      assert.strictEqual(completed.value.exit.value, 2)
    }).pipe(Effect.provide(layer))
  })
})
