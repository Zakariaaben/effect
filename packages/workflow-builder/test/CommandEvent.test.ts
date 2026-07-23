import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Command from "../src/Command.ts"
import * as CommandEvent from "../src/CommandEvent.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"

const command = (payload: Command.Payload, commandId = "command-1"): Command.Command => ({
  commandVersion: 1,
  commandId,
  payload
})

const scheduleActivity = (
  input: Command.EncodedValues = { order: { id: "order-1" } }
): Command.ScheduleActivity => ({
  _tag: "ScheduleActivity",
  activityId: Command.activityId("run-1", "validate", 1),
  nodeId: "validate",
  nodeInstanceId: Command.staticNodeInstanceId("validate"),
  attempt: 1,
  idempotencyKey: Command.activityIdempotencyKey("run-1", "validate"),
  input
})

const activityFailure = (
  failure: Command.ActivityFailure["failure"] = {
    _tag: "InvalidOrder",
    reason: "missing id"
  }
): Command.ActivityFailure => ({
  _tag: "ActivityFailure",
  activityId: Command.activityId("run-1", "validate", 1),
  nodeId: "validate",
  nodeInstanceId: "validate",
  attempt: 1,
  failure
})

const success = (
  result: Result.Result<HistoryStore.EventDraft, CommandEvent.CommandEventError>
): HistoryStore.EventDraft => {
  assert.ok(Result.isSuccess(result))
  return result.success
}

const failure = (
  result: Result.Result<HistoryStore.EventDraft, CommandEvent.CommandEventError>
): CommandEvent.CommandEventError => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

describe("CommandEvent", () => {
  it("maps every command payload and uses the command identity as event identity", () => {
    const originatingFailure = activityFailure()
    const cases: ReadonlyArray<readonly [Command.Command, HistoryStore.EventDraft]> = [
      [
        command(scheduleActivity(), "schedule-command"),
        {
          eventVersion: 1,
          eventId: "schedule-command",
          payload: {
            _tag: "ActivityScheduled",
            activityId: Command.activityId("run-1", "validate", 1),
            nodeId: "validate",
            nodeInstanceId: "validate",
            attempt: 1,
            idempotencyKey: Command.activityIdempotencyKey("run-1", "validate"),
            input: { order: { id: "order-1" } }
          }
        }
      ],
      [
        command({ _tag: "SucceedRun", output: { receipt: "receipt-1" } }, "success-command"),
        {
          eventVersion: 1,
          eventId: "success-command",
          payload: {
            _tag: "RunSucceeded",
            output: { receipt: "receipt-1" }
          }
        }
      ],
      [
        command({ _tag: "FailRun", failure: originatingFailure }, "failure-command"),
        {
          eventVersion: 1,
          eventId: "failure-command",
          payload: {
            _tag: "RunFailed",
            failure: originatingFailure
          }
        }
      ],
      [
        command({ _tag: "CancelRun" }, "cancel-command"),
        {
          eventVersion: 1,
          eventId: "cancel-command",
          payload: { _tag: "RunCancelled" }
        }
      ]
    ]

    for (const [input, expected] of cases) {
      const draft = success(CommandEvent.fromCommand(input))
      assert.deepStrictEqual(draft, expected)
      assert.isFalse(Object.prototype.hasOwnProperty.call(draft, "causationId"))
      assert.isFalse(Object.prototype.hasOwnProperty.call(draft, "correlationId"))
      assert.isTrue(Object.isFrozen(draft))
      assert.isTrue(Object.isFrozen(draft.payload))
    }

    const failed = success(CommandEvent.fromCommand(cases[2]![0]))
    assert.deepStrictEqual(failed.payload, cases[2]![1].payload)
  })

  it("returns a detached recursively frozen draft", () => {
    const nested = { id: "order-1" }
    const input = command(scheduleActivity({ order: nested }))
    const draft = success(CommandEvent.fromCommand(input))

    nested.id = "mutated"
    input.commandId = "mutated-command"

    assert.strictEqual(draft.eventId, "command-1")
    assert.deepStrictEqual(draft.payload, {
      _tag: "ActivityScheduled",
      activityId: Command.activityId("run-1", "validate", 1),
      nodeId: "validate",
      nodeInstanceId: "validate",
      attempt: 1,
      idempotencyKey: Command.activityIdempotencyKey("run-1", "validate"),
      input: { order: { id: "order-1" } }
    })
    if (draft.payload._tag === "ActivityScheduled") {
      assert.notStrictEqual(draft.payload.input, input.payload.input)
      assert.isTrue(Object.isFrozen(draft.payload.input))
      assert.isTrue(Object.isFrozen(draft.payload.input.order))
    }
  })

  it("rejects hostile accessors without invoking them", () => {
    let invoked = 0
    const hostile = {
      commandVersion: 1,
      commandId: "command-1",
      get payload(): Command.Payload {
        invoked++
        throw new Error("must not run")
      }
    }

    const error = failure(CommandEvent.fromCommand(hostile))
    assert.strictEqual(error.code, CommandEvent.Codes.InvalidJson)
    assert.strictEqual(invoked, 0)
  })

  it("rejects strict schema excess at the envelope and payload boundaries", () => {
    const valid = command(scheduleActivity())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, unexpected: true },
      {
        ...valid,
        payload: { ...valid.payload, unexpected: true }
      }
    ]

    for (const input of malformed) {
      const error = failure(CommandEvent.fromCommand(input))
      assert.strictEqual(error.code, CommandEvent.Codes.InvalidCommand)
    }
  })

  it("preserves collision-like JSON keys without prototype pollution", () => {
    const collisionValues = JSON.parse(
      "{\"__proto__\":{\"polluted\":true},\"constructor\":\"constructor-value\",\"toString\":\"string-value\"}"
    ) as Command.EncodedValues
    const scheduled = success(CommandEvent.fromCommand(command(scheduleActivity(collisionValues))))

    assert.strictEqual(scheduled.payload._tag, "ActivityScheduled")
    if (scheduled.payload._tag === "ActivityScheduled") {
      assert.isTrue(Object.prototype.hasOwnProperty.call(scheduled.payload.input, "__proto__"))
      assert.isTrue(Object.prototype.hasOwnProperty.call(scheduled.payload.input, "constructor"))
      assert.isTrue(Object.prototype.hasOwnProperty.call(scheduled.payload.input, "toString"))
      assert.deepStrictEqual(scheduled.payload.input["__proto__"], { polluted: true })
      assert.strictEqual(scheduled.payload.input.constructor, "constructor-value")
      assert.strictEqual(scheduled.payload.input.toString, "string-value")
    }
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)

    const failed = success(CommandEvent.fromCommand(command({
      _tag: "FailRun",
      failure: activityFailure(collisionValues)
    })))
    assert.strictEqual(failed.payload._tag, "RunFailed")
    if (failed.payload._tag === "RunFailed") {
      assert.deepStrictEqual(failed.payload.failure, {
        _tag: "ActivityFailure",
        activityId: Command.activityId("run-1", "validate", 1),
        nodeId: "validate",
        nodeInstanceId: "validate",
        attempt: 1,
        failure: collisionValues
      })
      assert.isTrue(Object.isFrozen(failed.payload.failure))
    }
  })
})
