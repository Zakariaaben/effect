import { assert, describe, it } from "@effect/vitest"
import * as IdentityV2 from "../src/IdentityV2.ts"

const tuple = (
  kind: string,
  ...parts: ReadonlyArray<string | number>
): string =>
  JSON.stringify([
    "@effect/workflow-builder",
    2,
    kind,
    ...parts
  ])

describe("IdentityV2", () => {
  it("has stable canonical fixtures for the complete initial vocabulary", () => {
    const tenantId = "tenant-1"
    const runId = "run-1"
    const nodeInstanceId = "node-1"
    const logicalActivityId = IdentityV2.logicalActivityId(tenantId, runId, nodeInstanceId)
    const attemptId = IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 2)
    const retryId = IdentityV2.retryId(tenantId, runId, nodeInstanceId, 2)
    const waitId = IdentityV2.signalWaitId(tenantId, runId, nodeInstanceId)
    const sleepId = IdentityV2.sleepWaitId(tenantId, runId, nodeInstanceId)
    const timerId = IdentityV2.timerId(tenantId, runId, "RetryBackoff", retryId)

    const fixtures: ReadonlyArray<readonly [string, string]> = [
      [
        logicalActivityId,
        tuple("LogicalActivity", tenantId, runId, nodeInstanceId)
      ],
      [
        attemptId,
        tuple("ActivityAttempt", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        IdentityV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId),
        tuple("ActivityIdempotencyKey", tenantId, runId, nodeInstanceId)
      ],
      [
        IdentityV2.scheduleActivityCommandId(tenantId, runId, nodeInstanceId, 2),
        tuple("ScheduleActivity", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        IdentityV2.activityAttemptStartedEventId(tenantId, runId, nodeInstanceId, 2),
        tuple("ActivityAttemptStarted", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        IdentityV2.activityAttemptFailedEventId(tenantId, runId, nodeInstanceId, 2),
        tuple("ActivityAttemptFailed", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        IdentityV2.activityAttemptTimedOutEventId(
          tenantId,
          runId,
          nodeInstanceId,
          2,
          "StartToClose"
        ),
        tuple(
          "ActivityAttemptTimedOut",
          tenantId,
          runId,
          nodeInstanceId,
          2,
          "StartToClose"
        )
      ],
      [
        IdentityV2.activitySucceededEventId(tenantId, runId, nodeInstanceId, 2),
        tuple("ActivitySucceeded", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        IdentityV2.finalizeActivityFailureCommandId(tenantId, runId, nodeInstanceId),
        tuple("FinalizeActivityFailure", tenantId, runId, nodeInstanceId)
      ],
      [
        retryId,
        tuple("Retry", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        IdentityV2.scheduleRetryCommandId(tenantId, runId, nodeInstanceId, 2),
        tuple("ScheduleRetry", tenantId, runId, nodeInstanceId, 2)
      ],
      [
        timerId,
        tuple("Timer", tenantId, runId, "RetryBackoff", retryId)
      ],
      [
        IdentityV2.scheduleTimerCommandId(tenantId, runId, timerId),
        tuple("ScheduleTimer", tenantId, runId, timerId)
      ],
      [
        IdentityV2.timerFiredEventId(tenantId, runId, timerId),
        tuple("TimerFired", tenantId, runId, timerId)
      ],
      [
        IdentityV2.cancelTimerCommandId(tenantId, runId, timerId),
        tuple("CancelTimer", tenantId, runId, timerId)
      ],
      [
        IdentityV2.signalAcceptedEventId(tenantId, runId, "signal-1"),
        tuple("SignalAccepted", tenantId, runId, "signal-1")
      ],
      [
        waitId,
        tuple("SignalWait", tenantId, runId, nodeInstanceId)
      ],
      [
        IdentityV2.startSignalWaitCommandId(tenantId, runId, nodeInstanceId),
        tuple("StartSignalWait", tenantId, runId, nodeInstanceId)
      ],
      [
        IdentityV2.consumeSignalCommandId(tenantId, runId, waitId, "signal-1"),
        tuple("ConsumeSignal", tenantId, runId, waitId, "signal-1")
      ],
      [
        sleepId,
        tuple("SleepWait", tenantId, runId, nodeInstanceId)
      ],
      [
        IdentityV2.startSleepCommandId(tenantId, runId, nodeInstanceId),
        tuple("StartSleep", tenantId, runId, nodeInstanceId)
      ],
      [
        IdentityV2.timerId(tenantId, runId, "Sleep", sleepId),
        tuple("Timer", tenantId, runId, "Sleep", sleepId)
      ],
      [
        IdentityV2.runStartedEventId(tenantId, runId),
        tuple("RunStarted", tenantId, runId)
      ],
      [
        IdentityV2.runCancellationRequestedEventId(tenantId, runId, "request-1"),
        tuple("RunCancellationRequested", tenantId, runId, "request-1")
      ],
      [
        IdentityV2.succeedRunCommandId(tenantId, runId),
        tuple("SucceedRun", tenantId, runId)
      ],
      [
        IdentityV2.failRunCommandId(tenantId, runId),
        tuple("FailRun", tenantId, runId)
      ],
      [
        IdentityV2.cancelRunCommandId(tenantId, runId),
        tuple("CancelRun", tenantId, runId)
      ]
    ]

    for (const [actual, expected] of fixtures) {
      assert.strictEqual(actual, expected)
    }
  })

  it("keeps external idempotency stable while semantic attempts change", () => {
    const tenantId = "tenant-1"
    const runId = "run-1"
    const nodeInstanceId = "node-1"

    assert.strictEqual(
      IdentityV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId),
      IdentityV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId)
    )
    assert.notStrictEqual(
      IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 2)
    )
    assert.notStrictEqual(
      IdentityV2.scheduleActivityCommandId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.scheduleActivityCommandId(tenantId, runId, nodeInstanceId, 2)
    )
    assert.notStrictEqual(
      IdentityV2.retryId(tenantId, runId, nodeInstanceId, 2),
      IdentityV2.retryId(tenantId, runId, nodeInstanceId, 3)
    )
  })

  it("binds identities to tenants and resists delimiter collisions", () => {
    assert.notStrictEqual(
      IdentityV2.logicalActivityId("tenant-a", "run-1", "node-1"),
      IdentityV2.logicalActivityId("tenant-b", "run-1", "node-1")
    )
    assert.notStrictEqual(
      IdentityV2.logicalActivityId("tenant|run", "node", "instance"),
      IdentityV2.logicalActivityId("tenant", "run|node", "instance")
    )
    assert.notStrictEqual(
      IdentityV2.consumeSignalCommandId("tenant", "run|wait", "signal", "x"),
      IdentityV2.consumeSignalCommandId("tenant", "run", "wait|signal", "x")
    )
    assert.notStrictEqual(
      IdentityV2.timerId("tenant", "run", "RetryBackoff", "owner"),
      IdentityV2.timerId("tenant", "run", "ScheduleToClose", "owner")
    )
    assert.notStrictEqual(
      IdentityV2.sleepWaitId("tenant|run", "node", "instance"),
      IdentityV2.sleepWaitId("tenant", "run|node", "instance")
    )
    assert.notStrictEqual(
      IdentityV2.startSleepCommandId("tenant-a", "run", "sleep"),
      IdentityV2.startSleepCommandId("tenant-b", "run", "sleep")
    )
  })

  it("uses disjoint namespaces for different semantic identity kinds", () => {
    const tenantId = "tenant-1"
    const runId = "run-1"
    const nodeInstanceId = "node-1"
    const ids = [
      IdentityV2.logicalActivityId(tenantId, runId, nodeInstanceId),
      IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.activityIdempotencyKey(tenantId, runId, nodeInstanceId),
      IdentityV2.scheduleActivityCommandId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.activityAttemptStartedEventId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.activityAttemptFailedEventId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.activityAttemptTimedOutEventId(
        tenantId,
        runId,
        nodeInstanceId,
        1,
        "ScheduleToStart"
      ),
      IdentityV2.activitySucceededEventId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.finalizeActivityFailureCommandId(tenantId, runId, nodeInstanceId),
      IdentityV2.retryId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.scheduleRetryCommandId(tenantId, runId, nodeInstanceId, 1),
      IdentityV2.signalWaitId(tenantId, runId, nodeInstanceId),
      IdentityV2.startSignalWaitCommandId(tenantId, runId, nodeInstanceId),
      IdentityV2.sleepWaitId(tenantId, runId, nodeInstanceId),
      IdentityV2.startSleepCommandId(tenantId, runId, nodeInstanceId),
      IdentityV2.runStartedEventId(tenantId, runId),
      IdentityV2.succeedRunCommandId(tenantId, runId),
      IdentityV2.failRunCommandId(tenantId, runId),
      IdentityV2.cancelRunCommandId(tenantId, runId)
    ]

    assert.strictEqual(new Set(ids).size, ids.length)
  })
})
