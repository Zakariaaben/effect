import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as CommandV2 from "../src/CommandV2.ts"
import * as EventV2 from "../src/EventV2.ts"
import * as IdentityV2 from "../src/IdentityV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const tenantId = "tenant-1"
const runId = "run-1"
const nodeInstanceId = "task"

const policy: ActivityPolicy.Policy = {
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: 3,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: true,
      scheduleToStartTimeout: true,
      startToCloseTimeout: true
    },
    backoff: { _tag: "Fixed", delayMillis: 500 },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: { _tag: "After", durationMillis: 10_000 },
    startToClose: { _tag: "After", durationMillis: 20_000 },
    scheduleToClose: { _tag: "Disabled" }
  }
}

const schedule = (): CommandV2.Command => ({
  commandVersion: 2,
  tenantId,
  runId,
  commandId: IdentityV2.scheduleActivityCommandId(tenantId, runId, nodeInstanceId, 1),
  payload: {
    _tag: "ScheduleActivityAttempt",
    logicalActivityId: IdentityV2.logicalActivityId(tenantId, runId, nodeInstanceId),
    attemptId: IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 1),
    nodeId: "task",
    nodeInstanceId,
    attempt: 1,
    idempotencyKey: IdentityV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId),
    input: { documentId: "document-1" },
    policy
  }
})

const startSleep = (): CommandV2.Command => ({
  commandVersion: 2,
  tenantId,
  runId,
  commandId: IdentityV2.startSleepCommandId(tenantId, runId, "sleep"),
  payload: {
    _tag: "StartSleep",
    waitId: IdentityV2.sleepWaitId(tenantId, runId, "sleep"),
    nodeId: "sleep",
    nodeInstanceId: "sleep",
    durationMillis: 1_000
  }
})

describe("CommandV2", () => {
  it("strictly admits a tenant-bound activity-attempt command", () => {
    const command = schedule()
    assert.deepStrictEqual(Schema.decodeUnknownSync(CommandV2.Command)(command), command)
    assert.strictEqual(
      CommandV2.logicalActivityId(tenantId, runId, nodeInstanceId),
      command.payload._tag === "ScheduleActivityAttempt" && command.payload.logicalActivityId
    )
    assert.notStrictEqual(
      CommandV2.activityAttemptId(tenantId, runId, nodeInstanceId, 1),
      CommandV2.activityAttemptId(tenantId, runId, nodeInstanceId, 2)
    )
    assert.strictEqual(
      CommandV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId),
      IdentityV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId)
    )
  })

  it("strictly admits a canonical durable sleep start command", () => {
    const decode = Schema.decodeUnknownSync(CommandV2.Command)
    const command = startSleep()

    assert.deepStrictEqual(decode(command), command)
    assert.strictEqual(
      CommandV2.sleepWaitId(tenantId, runId, "sleep"),
      IdentityV2.sleepWaitId(tenantId, runId, "sleep")
    )
    assert.strictEqual(
      CommandV2.startSleepCommandId(tenantId, runId, "sleep"),
      command.commandId
    )
    assert.isFalse("deadline" in command.payload)

    const sleep = command.payload as CommandV2.StartSleep
    for (
      const malformed of [
        { ...command, payload: { ...sleep, durationMillis: 0 } },
        { ...command, payload: { ...sleep, durationMillis: -1 } },
        { ...command, payload: { ...sleep, durationMillis: 1.5 } },
        {
          ...command,
          payload: {
            ...sleep,
            durationMillis: ProtocolV2Wire.MaximumSemanticDelayMillis + 1
          }
        },
        {
          ...command,
          payload: {
            ...sleep,
            durationMillis: Number.MAX_SAFE_INTEGER + 1
          }
        },
        { ...command, payload: { ...sleep, waitId: "" } },
        { ...command, payload: { ...sleep, nodeId: "" } },
        { ...command, payload: { ...sleep, nodeInstanceId: "" } },
        { ...command, payload: { ...sleep, deadline: "2026-07-23T00:00:01.000Z" } },
        {
          ...command,
          payload: {
            _tag: "StartSleep",
            waitId: sleep.waitId,
            nodeId: sleep.nodeId,
            nodeInstanceId: sleep.nodeInstanceId
          }
        }
      ]
    ) {
      assert.throws(() => decode(malformed))
    }

    const hostile = Object.defineProperty(
      { ...sleep },
      "durationMillis",
      {
        enumerable: true,
        get() {
          throw new Error("hostile sleep duration")
        }
      }
    )
    assert.throws(() => decode({ ...command, payload: hostile }))
  })

  it("keeps deadlines and store-owned facts out of decision commands", () => {
    const retryId = IdentityV2.retryId(tenantId, runId, nodeInstanceId, 2)
    const timerId = IdentityV2.timerId(tenantId, runId, "RetryBackoff", retryId)
    const retry: CommandV2.Command = {
      commandVersion: 2,
      tenantId,
      runId,
      commandId: IdentityV2.scheduleRetryCommandId(tenantId, runId, nodeInstanceId, 2),
      payload: {
        _tag: "ScheduleRetry",
        retryId,
        logicalActivityId: IdentityV2.logicalActivityId(tenantId, runId, nodeInstanceId),
        failedAttemptId: IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 1),
        failedAttempt: 1,
        nextAttempt: 2,
        anchorEventId: IdentityV2.activityAttemptFailedEventId(
          tenantId,
          runId,
          nodeInstanceId,
          1
        ),
        timerId,
        selectedDelayMillis: 500
      }
    }
    assert.deepStrictEqual(Schema.decodeUnknownSync(CommandV2.Command)(retry), retry)
    assert.isFalse("deadline" in retry.payload)

    const timer: CommandV2.Command = {
      commandVersion: 2,
      tenantId,
      runId,
      commandId: IdentityV2.scheduleTimerCommandId(tenantId, runId, timerId),
      payload: {
        _tag: "ScheduleTimer",
        timerId,
        purpose: {
          _tag: "RetryBackoff",
          retryId,
          logicalActivityId: IdentityV2.logicalActivityId(tenantId, runId, nodeInstanceId),
          nextAttempt: 2
        },
        anchorEventId: "attempt-failed-event",
        delayMillis: 500
      }
    }
    assert.deepStrictEqual(Schema.decodeUnknownSync(CommandV2.Command)(timer), timer)
    assert.isFalse("deadline" in timer.payload)

    for (
      const payload of [
        { _tag: "ActivitySucceeded", output: {} },
        { _tag: "TimerFired", timerId },
        { _tag: "SignalAccepted", signalId: "signal-1" }
      ]
    ) {
      assert.throws(() =>
        Schema.decodeUnknownSync(CommandV2.Command)({
          commandVersion: 2,
          tenantId,
          runId,
          commandId: "external-fact",
          payload
        })
      )
    }
  })

  it("rejects mixed versions, excess fields, and unsafe counters", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(CommandV2.Command)({
        ...schedule(),
        commandVersion: 1
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(CommandV2.Command)({
        ...schedule(),
        extra: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(CommandV2.Command)({
        ...schedule(),
        payload: {
          ...(schedule().payload as CommandV2.ScheduleActivityAttempt),
          attempt: Number.MAX_SAFE_INTEGER + 1
        }
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EventV2.Event)({
        ...schedule(),
        eventVersion: 2,
        eventId: schedule().commandId,
        sequence: 0,
        recordedAt: "2026-07-23T00:00:00.000Z"
      })
    )
  })
})
