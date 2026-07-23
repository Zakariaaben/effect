import { assert, describe, it } from "@effect/vitest"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import * as Command from "../src/Command.ts"
import * as Event from "../src/Event.ts"
import * as Identity from "../src/Identity.ts"
import * as RunState from "../src/RunState.ts"

const Fixture = Schema.Struct({
  fixtureVersion: Schema.Literal(1),
  failureHistory: Schema.Array(Event.Event),
  cancellationHistory: Schema.Array(Event.Event)
})

const fixture = Schema.decodeUnknownSync(Fixture)(
  JSON.parse(readFileSync(new URL("./fixtures/v1-history.json", import.meta.url), "utf8"))
)

const fold = (history: ReadonlyArray<Event.Event>): RunState.RunState => {
  const result = RunState.fold(history)
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

describe("version 1 compatibility fixtures", () => {
  it("preserves terminal failure and attributed attempt semantics", () => {
    const beforeTerminal = fold(fixture.failureHistory.slice(0, 3))
    assert.strictEqual(beforeTerminal.status, "Running")
    const activity = HashMap.getUnsafe(
      beforeTerminal.activities,
      Identity.activityId("run-golden-failure", "task", 1)
    )
    assert.strictEqual(activity.status, "Failed")
    assert.strictEqual(activity.attempt, 1)

    const terminal = fold(fixture.failureHistory)
    assert.strictEqual(terminal.status, "Failed")
    if (terminal.status !== "Failed") {
      throw new Error("Expected the v1 failure fixture to terminate as failed")
    }
    assert.strictEqual(terminal.failure.activityId, activity.activityId)
    assert.strictEqual(terminal.failure.attempt, 1)
    assert.deepStrictEqual(terminal.failure.failure, {
      _tag: "GoldenFailure",
      message: "boom"
    })
  })

  it("preserves cancellation precedence after a visible activity success", () => {
    const requested = fold(fixture.cancellationHistory.slice(0, 4))
    assert.strictEqual(requested.status, "CancellationRequested")
    const activity = HashMap.getUnsafe(
      requested.activities,
      Identity.activityId("run-golden-cancel", "task", 1)
    )
    assert.strictEqual(activity.status, "Succeeded")

    const terminal = fold(fixture.cancellationHistory)
    assert.strictEqual(terminal.status, "Cancelled")
    assert.strictEqual(terminal.sequence, 4)
  })

  it("locks canonical v1 identities and rejects mixed protocol envelopes", () => {
    const scheduled = fixture.failureHistory[1]!
    assert.strictEqual(
      scheduled.eventId,
      Identity.scheduleActivityCommandId("run-golden-failure", "task", 1)
    )
    assert.strictEqual(
      scheduled.payload._tag === "ActivityScheduled" && scheduled.payload.activityId,
      Identity.activityId("run-golden-failure", "task", 1)
    )

    assert.throws(() =>
      Schema.decodeUnknownSync(Event.Event)({
        ...fixture.failureHistory[0],
        eventVersion: 2
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Command.Command)({
        commandVersion: 2,
        commandId: "future-command",
        payload: { _tag: "CancelRun" }
      })
    )
  })
})
