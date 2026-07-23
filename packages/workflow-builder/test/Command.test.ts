import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as Command from "../src/Command.ts"

const scheduleActivity = (
  overrides: Partial<Command.ScheduleActivity> = {}
): Command.ScheduleActivity => ({
  _tag: "ScheduleActivity",
  activityId: Command.activityId("run-1", "validate", 1),
  nodeId: "validate",
  nodeInstanceId: Command.staticNodeInstanceId("validate"),
  attempt: 1,
  idempotencyKey: Command.activityIdempotencyKey("run-1", "validate"),
  input: { order: { id: "order-1" } },
  ...overrides
})

const activityFailure = (
  overrides: Partial<Command.ActivityFailure> = {}
): Command.ActivityFailure => ({
  _tag: "ActivityFailure",
  activityId: Command.activityId("run-1", "validate", 1),
  nodeId: "validate",
  nodeInstanceId: "validate",
  attempt: 1,
  failure: { _tag: "InvalidOrder", reason: "missing id" },
  ...overrides
})

const command = (payload: Command.Payload, commandId = "command-1"): Command.Command => ({
  commandVersion: 1,
  commandId,
  payload
})

describe("Command", () => {
  const decode = Schema.decodeUnknownSync(Command.Command)
  const encode = Schema.encodeSync(Command.Command)

  it("roundtrips every version 1 payload tag", () => {
    const payloads: ReadonlyArray<Command.Payload> = [
      scheduleActivity(),
      { _tag: "SucceedRun", output: { receipt: "receipt-1" } },
      { _tag: "FailRun", failure: activityFailure() },
      { _tag: "CancelRun" }
    ]

    for (let index = 0; index < payloads.length; index++) {
      const input = command(payloads[index]!, `command-${index}`)
      assert.deepStrictEqual(encode(decode(input)), input)
    }
  })

  it("rejects invalid and excess envelope fields", () => {
    const valid = command(scheduleActivity())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, commandVersion: 2 },
      { ...valid, commandId: "" },
      { ...valid, unexpected: true },
      { ...valid, payload: { _tag: "FutureCommand" } }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("strictly validates activity scheduling identity and attempts", () => {
    const malformed: ReadonlyArray<unknown> = [
      scheduleActivity({ activityId: "" }),
      scheduleActivity({ nodeId: "" }),
      scheduleActivity({ nodeInstanceId: "" }),
      scheduleActivity({ attempt: 0 }),
      scheduleActivity({ attempt: 1.5 }),
      scheduleActivity({ idempotencyKey: "" }),
      { ...scheduleActivity(), unexpected: true }
    ]

    for (const payload of malformed) {
      assert.throws(() => decode(command(payload as Command.Payload)))
    }
  })

  it("strictly validates nested activity failures", () => {
    const malformed: ReadonlyArray<unknown> = [
      activityFailure({ activityId: "" }),
      activityFailure({ nodeId: "" }),
      activityFailure({ nodeInstanceId: "" }),
      activityFailure({ attempt: 0 }),
      activityFailure({ attempt: 1.5 }),
      activityFailure({ failure: 1n as never }),
      { ...activityFailure(), unexpected: true }
    ]

    for (const failure of malformed) {
      assert.throws(() =>
        decode(command({
          _tag: "FailRun",
          failure: failure as Command.ActivityFailure
        }))
      )
    }

    assert.throws(() =>
      decode(command({
        _tag: "FailRun",
        failure: activityFailure(),
        unexpected: true
      } as Command.FailRun))
    )
    assert.throws(() => decode(command({ _tag: "CancelRun", unexpected: true } as Command.CancelRun)))
  })

  it("rejects non-JSON values at every encoded boundary", () => {
    const nonJson: ReadonlyArray<unknown> = [
      { value: 1n },
      { value: undefined },
      { value: () => undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY }
    ]

    for (const value of nonJson) {
      assert.throws(() =>
        decode(command({
          ...scheduleActivity(),
          input: value as Command.EncodedValues
        }))
      )
      assert.throws(() =>
        decode(command({
          _tag: "SucceedRun",
          output: value as Command.EncodedValues
        }))
      )
    }
  })
})

describe("EncodedValues", () => {
  const decode = Schema.decodeUnknownSync(Command.EncodedValues)

  it("accepts an empty object and named JSON values", () => {
    assert.deepStrictEqual(decode({}), {})
    assert.deepStrictEqual(decode({ value: [1, true, null, { nested: "yes" }] }), {
      value: [1, true, null, { nested: "yes" }]
    })
  })

  it("rejects arrays, null, empty property names, and non-JSON values", () => {
    const malformed: ReadonlyArray<unknown> = [
      [],
      null,
      { "": "value" },
      { value: 1n },
      { value: undefined },
      { value: () => undefined }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("preserves prototype-like property names without prototype pollution", () => {
    const input = JSON.parse(
      "{\"__proto__\":{\"polluted\":true},\"constructor\":\"constructor-value\",\"toString\":\"string-value\"}"
    )
    const decoded = decode(input)

    assert.isTrue(Object.prototype.hasOwnProperty.call(decoded, "__proto__"))
    assert.isTrue(Object.prototype.hasOwnProperty.call(decoded, "constructor"))
    assert.isTrue(Object.prototype.hasOwnProperty.call(decoded, "toString"))
    assert.deepStrictEqual(decoded["__proto__"], { polluted: true })
    assert.strictEqual(decoded.constructor, "constructor-value")
    assert.strictEqual(decoded.toString, "string-value")
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
  })
})

describe("command identities", () => {
  it("has stable versioned JSON tuple fixtures", () => {
    assert.strictEqual(Command.staticNodeInstanceId("node-1"), "node-1")
    assert.strictEqual(
      Command.activityId("run-1", "node-1", 1),
      "[\"@effect/workflow-builder\",1,\"Activity\",\"run-1\",\"node-1\",1]"
    )
    assert.strictEqual(
      Command.activityIdempotencyKey("run-1", "node-1"),
      "[\"@effect/workflow-builder\",1,\"ActivityIdempotencyKey\",\"run-1\",\"node-1\"]"
    )
    assert.strictEqual(
      Command.scheduleActivityCommandId("run-1", "node-1", 1),
      "[\"@effect/workflow-builder\",1,\"ScheduleActivity\",\"run-1\",\"node-1\",1]"
    )
    assert.strictEqual(
      Command.succeedRunCommandId("run-1"),
      "[\"@effect/workflow-builder\",1,\"SucceedRun\",\"run-1\"]"
    )
    assert.strictEqual(
      Command.failRunCommandId("run-1"),
      "[\"@effect/workflow-builder\",1,\"FailRun\",\"run-1\"]"
    )
    assert.strictEqual(
      Command.cancelRunCommandId("run-1"),
      "[\"@effect/workflow-builder\",1,\"CancelRun\",\"run-1\"]"
    )
  })

  it("is deterministic and collision-free for delimiter-bearing components", () => {
    const first = Command.activityId("run:a", "node:b", 1)
    assert.strictEqual(Command.activityId("run:a", "node:b", 1), first)
    assert.notStrictEqual(first, Command.activityId("run", "a:node:b", 1))
    assert.notStrictEqual(first, Command.activityId("run:a", "node", 1))
  })

  it("is unique across attempts, nodes, and command kinds", () => {
    const identities = [
      Command.activityId("run-1", "node-1", 1),
      Command.activityId("run-1", "node-1", 2),
      Command.activityId("run-1", "node-2", 1),
      Command.scheduleActivityCommandId("run-1", "node-1", 1),
      Command.scheduleActivityCommandId("run-1", "node-2", 1),
      Command.succeedRunCommandId("run-1"),
      Command.failRunCommandId("run-1"),
      Command.cancelRunCommandId("run-1")
    ]
    assert.strictEqual(new Set(identities).size, identities.length)
  })

  it("keeps external idempotency independent of activity attempt identity", () => {
    const firstAttempt = {
      activityId: Command.activityId("run-1", "node-1", 1),
      idempotencyKey: Command.activityIdempotencyKey("run-1", "node-1")
    }
    const secondAttempt = {
      activityId: Command.activityId("run-1", "node-1", 2),
      idempotencyKey: Command.activityIdempotencyKey("run-1", "node-1")
    }

    assert.notStrictEqual(firstAttempt.activityId, secondAttempt.activityId)
    assert.strictEqual(firstAttempt.idempotencyKey, secondAttempt.idempotencyKey)
  })
})
