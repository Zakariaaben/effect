import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"

const Result = DurableDeferred.make("DurableClockTest/Result", {
  success: Schema.String
})

const DeadlineWorkflow = Workflow.make("DurableClockTest/DeadlineWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id
})

const DeadlineWorkflowLayer = DeadlineWorkflow.toLayer(() => DurableDeferred.await(Result)).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory)
)

const start = Effect.fnUntraced(function*(id: string) {
  const executionId = yield* DeadlineWorkflow.executionId({ id })
  yield* DeadlineWorkflow.execute({ id }, { discard: true })
  return {
    executionId,
    token: DurableDeferred.tokenFromExecutionId(Result, {
      workflow: DeadlineWorkflow,
      executionId
    })
  }
})

const pollUntilComplete = (executionId: string) =>
  Effect.gen(function*() {
    let result = yield* DeadlineWorkflow.poll(executionId)
    for (let i = 0; i < 100 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      result = yield* DeadlineWorkflow.poll(executionId)
    }
    return result
  })

const assertSuccess = (
  result: Option.Option<Workflow.Result<string, never>>,
  expected: string
) => {
  assert(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit))
  assert.strictEqual(result.value.exit.value, expected)
}

describe("DurableClock", () => {
  it.effect("encodes and decodes a scheduled deferred value without a workflow instance", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const deferred = DurableDeferred.make("DurableClockTest/EncodedResult", {
        success: Schema.NumberFromString
      })
      const token = new DurableDeferred.TokenParsed({
        workflowName: "DurableClockTest/ExternalSchedule",
        executionId: "execution",
        deferredName: deferred.name
      }).asToken

      yield* DurableClock.schedule(deferred, {
        token,
        scheduleId: "encoded-deadline",
        wakeUp: DateTime.makeUnsafe(1_000),
        value: 42
      })
      yield* TestClock.adjust("1 second")

      const result = yield* DurableDeferred.poll(deferred, { token })
      assert(Option.isSome(result) && Exit.isSuccess(result.value))
      assert.strictEqual(result.value.value, 42)
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)))

  it.effect("keeps a result that completes before the timer", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const { executionId, token } = yield* start("result-first")

      yield* DurableClock.schedule(Result, {
        token,
        scheduleId: "result-first/deadline",
        wakeUp: DateTime.makeUnsafe(10_000),
        value: "timer"
      })
      yield* DurableDeferred.succeed(Result, {
        token,
        value: "result"
      })
      yield* TestClock.adjust("10 seconds")

      assertSuccess(yield* pollUntilComplete(executionId), "result")
    }).pipe(Effect.provide(DeadlineWorkflowLayer)))

  it.effect("keeps a timer result when a completion arrives late", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const { executionId, token } = yield* start("timer-first")

      yield* DurableClock.schedule(Result, {
        token,
        scheduleId: "timer-first/deadline",
        wakeUp: DateTime.makeUnsafe(10_000),
        value: "timer"
      })
      yield* TestClock.adjust("10 seconds")
      yield* DurableDeferred.succeed(Result, {
        token,
        value: "late"
      })

      assertSuccess(yield* pollUntilComplete(executionId), "timer")
    }).pipe(Effect.provide(DeadlineWorkflowLayer)))

  it.effect("does not move or replace a duplicate schedule", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const { executionId, token } = yield* start("duplicate")

      yield* DurableClock.schedule(Result, {
        token,
        scheduleId: "duplicate/deadline",
        wakeUp: DateTime.makeUnsafe(10_000),
        value: "original"
      })
      yield* DurableClock.schedule(Result, {
        token,
        scheduleId: "duplicate/deadline",
        wakeUp: DateTime.makeUnsafe(1_000),
        value: "replacement"
      })
      yield* TestClock.adjust("1 second")

      const early = yield* DeadlineWorkflow.poll(executionId)
      assert(Option.isNone(early) || early.value._tag !== "Complete")

      yield* TestClock.adjust("9 seconds")
      assertSuccess(yield* pollUntilComplete(executionId), "original")
    }).pipe(Effect.provide(DeadlineWorkflowLayer)))
})
