import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"

describe("WorkflowEngine", () => {
  const IncrementWorkflow = Workflow.make("WorkflowEngine/IncrementWorkflow", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  })

  const IncrementWorkflowLayer = IncrementWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

  class ClassWorkflow extends Workflow.make("WorkflowEngine/ClassWorkflow", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  }) {}

  const ClassWorkflowLayer = ClassWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

  it.effect("layer executes and polls workflows", () =>
    Effect.gen(function*() {
      const executionId = yield* IncrementWorkflow.execute({ value: 1 }, { discard: true })
      const result = yield* IncrementWorkflow.execute({ value: 1 })
      const polled = yield* IncrementWorkflow.poll(executionId)

      assert.strictEqual(result, 2)
      assert(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isSuccess(polled.value.exit))
      assert.strictEqual(polled.value.exit.value, 2)
    }).pipe(
      Effect.provide(IncrementWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("discard returns the deterministic execution ID", () =>
    Effect.gen(function*() {
      const executionId = yield* IncrementWorkflow.executionId({ value: 1 })
      const discardedExecutionId = yield* IncrementWorkflow.execute({ value: 1 }, { discard: true })

      assert.strictEqual(discardedExecutionId, executionId)
    }).pipe(
      Effect.provide(IncrementWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("supports class extension", () =>
    Effect.gen(function*() {
      const result = yield* ClassWorkflow.execute({ value: 1 })

      assert.strictEqual(ClassWorkflow._tag, "WorkflowEngine/ClassWorkflow")
      assert.strictEqual(result, 2)
    }).pipe(
      Effect.provide(ClassWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("polls an unresolved durable deferred by token", () =>
    Effect.gen(function*() {
      const deferred = DurableDeferred.make("result", {
        success: Schema.Number
      })
      const token = new DurableDeferred.TokenParsed({
        workflowName: "WorkflowEngine/Poll",
        executionId: "execution",
        deferredName: deferred.name
      }).asToken

      const result = yield* DurableDeferred.poll(deferred, { token })

      assert(Option.isNone(result))
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)))

  it.effect("returns the canonical first durable deferred resolution", () =>
    Effect.gen(function*() {
      const deferred = DurableDeferred.make("result", {
        success: Schema.Number
      })
      const token = new DurableDeferred.TokenParsed({
        workflowName: "WorkflowEngine/Resolve",
        executionId: "execution",
        deferredName: deferred.name
      }).asToken

      const first = yield* DurableDeferred.resolve(deferred, {
        token,
        exit: Exit.succeed(1)
      })
      const competing = yield* DurableDeferred.resolve(deferred, {
        token,
        exit: Exit.succeed(2)
      })
      const polled = yield* DurableDeferred.poll(deferred, { token })

      assert(Exit.isSuccess(first))
      assert.strictEqual(first.value, 1)
      assert(Exit.isSuccess(competing))
      assert.strictEqual(competing.value, 1)
      assert(Option.isSome(polled) && Exit.isSuccess(polled.value))
      assert.strictEqual(polled.value.value, 1)
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)))

  it.effect("returns a canonical failure Exit as data", () =>
    Effect.gen(function*() {
      const deferred = DurableDeferred.make("result", {
        success: Schema.Number,
        error: Schema.String
      })
      const token = new DurableDeferred.TokenParsed({
        workflowName: "WorkflowEngine/ResolveFailure",
        executionId: "execution",
        deferredName: deferred.name
      }).asToken

      const failed = yield* DurableDeferred.resolve(deferred, {
        token,
        exit: Exit.fail("boom")
      })
      const competing = yield* DurableDeferred.resolve(deferred, {
        token,
        exit: Exit.succeed(1)
      })

      assert.deepStrictEqual(failed, Exit.fail("boom"))
      assert.deepStrictEqual(competing, Exit.fail("boom"))
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)))

  it.effect("encodes and decodes token-addressed durable deferred results", () =>
    Effect.gen(function*() {
      const deferred = DurableDeferred.make("result", {
        success: Schema.NumberFromString
      })
      const token = new DurableDeferred.TokenParsed({
        workflowName: "WorkflowEngine/Codec",
        executionId: "execution",
        deferredName: deferred.name
      }).asToken

      const resolved = yield* DurableDeferred.resolve(deferred, {
        token,
        exit: Exit.succeed(42)
      })
      const polled = yield* DurableDeferred.poll(deferred, { token })

      assert(Exit.isSuccess(resolved))
      assert.strictEqual(resolved.value, 42)
      assert(Option.isSome(polled) && Exit.isSuccess(polled.value))
      assert.strictEqual(polled.value.value, 42)
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)))

  it.effect("isolates durable deferred addresses by workflow name", () =>
    Effect.gen(function*() {
      const deferred = DurableDeferred.make("result", {
        success: Schema.Number
      })
      const tokenA = new DurableDeferred.TokenParsed({
        workflowName: "WorkflowEngine/Isolation/A",
        executionId: "shared-execution",
        deferredName: deferred.name
      }).asToken
      const tokenB = new DurableDeferred.TokenParsed({
        workflowName: "WorkflowEngine/Isolation/B",
        executionId: "shared-execution",
        deferredName: deferred.name
      }).asToken

      yield* DurableDeferred.resolve(deferred, {
        token: tokenA,
        exit: Exit.succeed(1)
      })

      const beforeB = yield* DurableDeferred.poll(deferred, { token: tokenB })
      const resolvedB = yield* DurableDeferred.resolve(deferred, {
        token: tokenB,
        exit: Exit.succeed(2)
      })
      const polledA = yield* DurableDeferred.poll(deferred, { token: tokenA })

      assert(Option.isNone(beforeB))
      assert(Exit.isSuccess(resolvedB))
      assert.strictEqual(resolvedB.value, 2)
      assert(Option.isSome(polledA) && Exit.isSuccess(polledA.value))
      assert.strictEqual(polledA.value.value, 1)
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)))
})
