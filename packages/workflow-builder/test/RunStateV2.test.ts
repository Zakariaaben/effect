import { assert, describe, it } from "@effect/vitest"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import type * as Event from "../src/EventV2.ts"
import * as Identity from "../src/IdentityV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as RunState from "../src/RunStateV2.ts"

const tenantId = "tenant-1"
const runId = "run-1"
const nodeId = "validate"
const nodeInstanceId = "validate"
const logicalActivityId = Identity.logicalActivityId(
  tenantId,
  runId,
  nodeInstanceId
)
const idempotencyKey = Identity.activityIdempotencyKey(
  tenantId,
  runId,
  nodeInstanceId
)
const compiledFingerprint = Schema.decodeUnknownSync(
  ProtocolV2Wire.CompiledFingerprint
)(`sha256:${"a".repeat(64)}`)
const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.ArtifactDigest
)(`sha256:${"b".repeat(64)}`)
const signalDefinitionDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.DefinitionDigest
)(`sha256:${"c".repeat(64)}`)
const epoch = Date.parse("2026-07-23T00:00:00.000Z")
const time = (millis: number): Event.Timestamp => new Date(epoch + millis).toISOString()

interface PolicyOptions {
  readonly maximumAttempts?: number
  readonly retryEncodedFailure?: boolean
  readonly retryScheduleToStart?: boolean
  readonly retryStartToClose?: boolean
  readonly delayMillis?: number
  readonly scheduleToStart?: ActivityPolicy.Timeout
  readonly startToClose?: ActivityPolicy.Timeout
  readonly scheduleToClose?: ActivityPolicy.Timeout
}

const policy = (options: PolicyOptions = {}): ActivityPolicy.Policy => ({
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: options.maximumAttempts ?? 2,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: options.retryEncodedFailure ?? true,
      scheduleToStartTimeout: options.retryScheduleToStart ?? true,
      startToCloseTimeout: options.retryStartToClose ?? true
    },
    backoff: {
      _tag: "Fixed",
      delayMillis: options.delayMillis ?? 1_000
    },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: options.scheduleToStart ?? { _tag: "Disabled" },
    startToClose: options.startToClose ?? { _tag: "Disabled" },
    scheduleToClose: options.scheduleToClose ?? { _tag: "Disabled" }
  }
})

const wireEvent = (
  sequence: number,
  payload: Event.Payload,
  eventId: string,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => ({
  eventVersion: 2,
  tenantId,
  eventId,
  runId,
  sequence,
  recordedAt,
  payload
})

const runStarted = (
  input: Event.EncodedValues = { orderId: "order-1" }
): Event.Event =>
  wireEvent(
    0,
    {
      _tag: "RunStarted",
      executionProtocolVersion: 2,
      artifactVersion: 2,
      artifactDigest,
      workflowIdentity: "order:order-1",
      startRequestId: "start-request-1",
      planId: "order-plan",
      planRevision: 3,
      definitionId: "order-workflow",
      definitionVersion: "2.1.0",
      compilerVersion: "4.0.0",
      compiledFingerprint,
      backend: "durable",
      input
    },
    Identity.runStartedEventId(tenantId, runId),
    time(0)
  )

const scheduled = (
  sequence: number,
  attempt: number,
  activityPolicy: ActivityPolicy.Policy,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityScheduled",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      nodeId,
      nodeInstanceId,
      attempt,
      idempotencyKey,
      input: { order: { id: "order-1" } },
      policy: activityPolicy
    },
    Identity.scheduleActivityCommandId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    ),
    recordedAt
  )

const attemptStarted = (
  sequence: number,
  attempt: number,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityAttemptStarted",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt
    },
    Identity.activityAttemptStartedEventId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    ),
    recordedAt
  )

const attemptFailed = (
  sequence: number,
  attempt: number,
  failure: Schema.Json = { _tag: "TransientFailure" },
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityAttemptFailed",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt,
      failure
    },
    Identity.activityAttemptFailedEventId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    ),
    recordedAt
  )

const retryScheduled = (
  sequence: number,
  failedAttempt: number,
  delayMillis: number,
  recordedAt: Event.Timestamp = time(sequence * 100),
  failedAt: Event.Timestamp = time((sequence - 1) * 100),
  anchorEventId: string = Identity.activityAttemptFailedEventId(
    tenantId,
    runId,
    nodeInstanceId,
    failedAttempt
  )
): Event.Event => {
  const nextAttempt = failedAttempt + 1
  const retryId = Identity.retryId(
    tenantId,
    runId,
    nodeInstanceId,
    nextAttempt
  )
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "RetryBackoff",
    retryId
  )
  return wireEvent(
    sequence,
    {
      _tag: "RetryScheduled",
      retryId,
      logicalActivityId,
      failedAttemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        failedAttempt
      ),
      failedAttempt,
      nextAttempt,
      anchorEventId,
      timerId,
      selectedDelayMillis: delayMillis,
      deadline: new Date(Date.parse(failedAt) + delayMillis).toISOString()
    },
    Identity.scheduleRetryCommandId(
      tenantId,
      runId,
      nodeInstanceId,
      nextAttempt
    ),
    recordedAt
  )
}

const retryTimerScheduled = (
  sequence: number,
  failedAttempt: number,
  failedEvent: Event.Event,
  delayMillis: number,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const nextAttempt = failedAttempt + 1
  const retryId = Identity.retryId(
    tenantId,
    runId,
    nodeInstanceId,
    nextAttempt
  )
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "RetryBackoff",
    retryId
  )
  const deadline = new Date(
    Date.parse(failedEvent.recordedAt) + delayMillis
  ).toISOString()
  return wireEvent(
    sequence,
    {
      _tag: "TimerScheduled",
      timerId,
      purpose: {
        _tag: "RetryBackoff",
        retryId,
        logicalActivityId,
        nextAttempt
      },
      anchorEventId: failedEvent.eventId,
      delayMillis,
      deadline
    },
    Identity.scheduleTimerCommandId(tenantId, runId, timerId),
    recordedAt
  )
}

const timerFired = (
  sequence: number,
  timerId: string,
  recordedAt: Event.Timestamp
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "TimerFired",
      timerId
    },
    Identity.timerFiredEventId(tenantId, runId, timerId),
    recordedAt
  )

const scheduleToCloseTimerScheduled = (
  sequence: number,
  schedule: Event.Event,
  delayMillis: number,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "ScheduleToClose",
    logicalActivityId
  )
  return wireEvent(
    sequence,
    {
      _tag: "TimerScheduled",
      timerId,
      purpose: { _tag: "ScheduleToClose", logicalActivityId },
      anchorEventId: schedule.eventId,
      delayMillis,
      deadline: new Date(
        Date.parse(schedule.recordedAt) + delayMillis
      ).toISOString()
    },
    Identity.scheduleTimerCommandId(tenantId, runId, timerId),
    recordedAt
  )
}

const activitySucceeded = (
  sequence: number,
  attempt: number,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivitySucceeded",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt,
      output: { valid: true }
    },
    Identity.activitySucceededEventId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    ),
    recordedAt
  )

const finalActivityFailure = (
  sequence: number,
  attempt: number,
  cause: Event.ActivityFailureCause,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityFailed",
      logicalActivityId,
      nodeId,
      nodeInstanceId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt,
      cause
    },
    Identity.finalizeActivityFailureCommandId(
      tenantId,
      runId,
      nodeInstanceId
    ),
    recordedAt
  )

const runSucceeded = (
  sequence: number,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "RunSucceeded",
      output: { receipt: "receipt-1" }
    },
    Identity.succeedRunCommandId(tenantId, runId),
    recordedAt
  )

const runFailed = (
  sequence: number,
  cause: Event.RunFailureCause,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "RunFailed",
      cause
    },
    Identity.failRunCommandId(tenantId, runId),
    recordedAt
  )

const signalAccepted = (
  sequence: number,
  signalId: string,
  inboxSequence: number,
  acceptedAt: Event.Timestamp,
  expiresAt: Event.Timestamp,
  correlation: Event.SignalCorrelation = { _tag: "Any" }
): Event.Event => {
  const expiryTimerId = Identity.timerId(
    tenantId,
    runId,
    "SignalExpiry",
    signalId
  )
  const value = { approvedBy: `reviewer-${inboxSequence}` }
  const digestCharacter = ((inboxSequence % 14) + 1).toString(16)
  const requestDigest = Schema.decodeUnknownSync(
    ProtocolV2Wire.RequestDigest
  )(`sha256:${digestCharacter.repeat(64)}`)
  const payloadDigest = Schema.decodeUnknownSync(
    ProtocolV2Wire.PayloadDigest
  )(`sha256:${((inboxSequence + 2) % 14 + 1).toString(16).repeat(64)}`)
  return wireEvent(
    sequence,
    {
      _tag: "SignalAccepted",
      signalId,
      inboxSequence,
      signalName: "ApprovalGranted",
      signalVersion: "1.0.0",
      correlation,
      signalDefinitionDigest,
      requestDigest,
      payload: { _tag: "Inline", value },
      payloadDigest,
      encodedPayloadBytes: JSON.stringify(value).length,
      ttlMillis: Date.parse(expiresAt) - Date.parse(acceptedAt),
      admission: {
        actorId: `reviewer-${inboxSequence}`,
        policyId: "approval-signals",
        policyVersion: "1.0.0",
        policyDecisionId: `decision-${signalId}`
      },
      expiresAt,
      expiryTimerId
    },
    Identity.signalAcceptedEventId(tenantId, runId, signalId),
    acceptedAt
  )
}

const signalExpiryTimer = (
  sequence: number,
  accepted: Event.Event,
  signalId: string,
  inboxSequence: number,
  delayMillis: number
): Event.Event => {
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "SignalExpiry",
    signalId
  )
  return wireEvent(sequence, {
    _tag: "TimerScheduled",
    timerId,
    purpose: { _tag: "SignalExpiry", signalId, inboxSequence },
    anchorEventId: accepted.eventId,
    delayMillis,
    deadline: new Date(
      Date.parse(accepted.recordedAt) + delayMillis
    ).toISOString()
  }, Identity.scheduleTimerCommandId(tenantId, runId, timerId))
}

const signalWaitStarted = (
  sequence: number,
  instanceId: string,
  timeout: ActivityPolicy.Timeout = { _tag: "Disabled" },
  correlation: Event.SignalCorrelation = { _tag: "Any" },
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const waitId = Identity.signalWaitId(tenantId, runId, instanceId)
  return wireEvent(
    sequence,
    {
      _tag: "SignalWaitStarted",
      waitId,
      nodeId: instanceId,
      nodeInstanceId: instanceId,
      signalName: "ApprovalGranted",
      signalVersion: "1.0.0",
      correlation,
      timeout
    },
    Identity.startSignalWaitCommandId(
      tenantId,
      runId,
      instanceId
    ),
    recordedAt
  )
}

const signalConsumed = (
  sequence: number,
  signalId: string,
  inboxSequence: number,
  instanceId: string,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const waitId = Identity.signalWaitId(tenantId, runId, instanceId)
  return wireEvent(
    sequence,
    {
      _tag: "SignalConsumed",
      signalId,
      inboxSequence,
      waitId,
      nodeId: instanceId,
      nodeInstanceId: instanceId
    },
    Identity.consumeSignalCommandId(
      tenantId,
      runId,
      waitId,
      signalId
    ),
    recordedAt
  )
}

const sleepStarted = (
  sequence: number,
  instanceId = "sleep",
  durationMillis = 1_000,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const waitId = Identity.sleepWaitId(tenantId, runId, instanceId)
  return wireEvent(
    sequence,
    {
      _tag: "SleepStarted",
      waitId,
      nodeId: instanceId,
      nodeInstanceId: instanceId,
      durationMillis
    },
    Identity.startSleepCommandId(tenantId, runId, instanceId),
    recordedAt
  )
}

const sleepTimerScheduled = (
  sequence: number,
  started: Event.Event,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const sleep = started.payload as Event.SleepStarted
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "Sleep",
    sleep.waitId
  )
  return wireEvent(
    sequence,
    {
      _tag: "TimerScheduled",
      timerId,
      purpose: {
        _tag: "Sleep",
        waitId: sleep.waitId,
        nodeInstanceId: sleep.nodeInstanceId
      },
      anchorEventId: started.eventId,
      delayMillis: sleep.durationMillis,
      deadline: new Date(
        Date.parse(started.recordedAt) + sleep.durationMillis
      ).toISOString()
    },
    Identity.scheduleTimerCommandId(tenantId, runId, timerId),
    recordedAt
  )
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result))
  return result.success
}

const failure = <A>(
  result: Result.Result<A, RunState.HistoryError>
): RunState.HistoryError => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

const code = (history: unknown): RunState.HistoryErrorCode => failure(RunState.fold(history)).code

describe("RunStateV2", () => {
  it("replays a complete failed-attempt, fired-backoff, successful-retry history", () => {
    const activityPolicy = policy()
    const failed = attemptFailed(3, 1)
    const retry = retryScheduled(4, 1, 1_000, time(400), failed.recordedAt)
    const retryTimer = retryTimerScheduled(5, 1, failed, 1_000)
    const retryTimerId = (retry.payload as Event.RetryScheduled).timerId
    const state = success(RunState.foldPrefix([
      runStarted(),
      scheduled(1, 1, activityPolicy),
      attemptStarted(2, 1),
      failed,
      retry,
      retryTimer,
      timerFired(6, retryTimerId, time(1_400)),
      scheduled(7, 2, activityPolicy, time(1_500)),
      attemptStarted(8, 2, time(1_600)),
      activitySucceeded(9, 2, time(1_700)),
      runSucceeded(10, time(1_800))
    ]))

    assert.strictEqual(state.status, "Succeeded")
    assert.strictEqual(state.sequence, 10)
    assert.strictEqual(state.tenantId, tenantId)
    assert.strictEqual(state.executionProtocolVersion, 2)
    assert.strictEqual(state.artifactVersion, 2)
    assert.strictEqual(state.artifactDigest, artifactDigest)
    assert.strictEqual(state.workflowIdentity, "order:order-1")
    assert.strictEqual(state.startRequestId, "start-request-1")
    const activity = HashMap.getUnsafe(state.activities, logicalActivityId)
    assert.strictEqual(activity.status, "Succeeded")
    assert.strictEqual(activity.currentAttempt, 2)
    assert.strictEqual(HashMap.size(activity.attempts), 2)
    assert.strictEqual(
      HashMap.getUnsafe(activity.attempts, 1).status,
      "Failed"
    )
    assert.strictEqual(
      HashMap.getUnsafe(activity.attempts, 2).status,
      "Succeeded"
    )
    const retryState = HashMap.getUnsafe(
      state.retries,
      (retry.payload as Event.RetryScheduled).retryId
    )
    assert.strictEqual(retryState.status, "Consumed")
    assert.strictEqual(
      HashMap.getUnsafe(state.timers, retryTimerId).status,
      "Fired"
    )
  })

  it("anchors retry backoff to failed-attempt completion despite coordinator delay", () => {
    const activityPolicy = policy()
    const failed = attemptFailed(3, 1, { _tag: "TransientFailure" }, time(300))
    const retry = retryScheduled(
      4,
      1,
      1_000,
      time(1_000),
      failed.recordedAt
    )
    const retryTimer = retryTimerScheduled(
      5,
      1,
      failed,
      1_000,
      time(1_100)
    )
    const retryPayload = retry.payload as Event.RetryScheduled
    const state = success(RunState.fold([
      runStarted(),
      scheduled(1, 1, activityPolicy),
      attemptStarted(2, 1),
      failed,
      retry,
      retryTimer,
      timerFired(6, retryPayload.timerId, time(1_300))
    ]))

    assert.strictEqual(retryPayload.deadline, time(1_300))
    assert.strictEqual(
      (retryTimer.payload as Event.TimerScheduled).anchorEventId,
      failed.eventId
    )
    assert.strictEqual(
      HashMap.getUnsafe(state.retries, retryPayload.retryId).status,
      "Ready"
    )
  })

  it("rejects retry for permanent or exhausted attempts and accepts exact final failure", () => {
    for (
      const activityPolicy of [
        policy({ retryEncodedFailure: false, maximumAttempts: 3 }),
        policy({ retryEncodedFailure: true, maximumAttempts: 1 })
      ]
    ) {
      const prefix = [
        runStarted(),
        scheduled(1, 1, activityPolicy),
        attemptStarted(2, 1),
        attemptFailed(3, 1, { _tag: "PermanentFailure" })
      ]
      assert.strictEqual(
        code([...prefix, retryScheduled(4, 1, 1_000)]),
        RunState.Codes.RetryNotAllowed
      )

      const final = finalActivityFailure(4, 1, {
        _tag: "EncodedFailure",
        failure: { _tag: "PermanentFailure" }
      })
      const terminal = runFailed(5, {
        _tag: "ActivityFailure",
        logicalActivityId,
        nodeId,
        nodeInstanceId,
        attemptId: Identity.activityAttemptId(
          tenantId,
          runId,
          nodeInstanceId,
          1
        ),
        attempt: 1,
        cause: {
          _tag: "EncodedFailure",
          failure: { _tag: "PermanentFailure" }
        }
      })
      assert.strictEqual(
        success(RunState.fold([...prefix, final, terminal])).status,
        "Failed"
      )
    }

    const retryable = [
      runStarted(),
      scheduled(1, 1, policy()),
      attemptStarted(2, 1),
      attemptFailed(3, 1)
    ]
    assert.strictEqual(
      code([
        ...retryable,
        finalActivityFailure(4, 1, {
          _tag: "EncodedFailure",
          failure: { _tag: "TransientFailure" }
        })
      ]),
      RunState.Codes.FinalFailureMismatch
    )
  })

  it("permits fail-fast terminal cleanup while concurrent work stays fenced", () => {
    const failingNodeId = "fail-fast-a"
    const liveNodeId = "fail-fast-b"
    const logicalId = (currentNodeId: string) =>
      Identity.logicalActivityId(
        tenantId,
        runId,
        currentNodeId
      )
    const attemptId = (currentNodeId: string) =>
      Identity.activityAttemptId(
        tenantId,
        runId,
        currentNodeId,
        1
      )
    const activityScheduled = (
      sequence: number,
      currentNodeId: string,
      currentPolicy: ActivityPolicy.Policy
    ): Event.Event =>
      wireEvent(
        sequence,
        {
          _tag: "ActivityScheduled",
          logicalActivityId: logicalId(currentNodeId),
          attemptId: attemptId(currentNodeId),
          nodeId: currentNodeId,
          nodeInstanceId: currentNodeId,
          attempt: 1,
          idempotencyKey: Identity.activityIdempotencyKey(
            tenantId,
            runId,
            currentNodeId
          ),
          input: {},
          policy: currentPolicy
        },
        Identity.scheduleActivityCommandId(
          tenantId,
          runId,
          currentNodeId,
          1
        ),
        time(sequence * 100)
      )

    const failingPolicy = policy({
      maximumAttempts: 1,
      retryEncodedFailure: false
    })
    const livePolicy = policy({
      scheduleToClose: { _tag: "After", durationMillis: 10_000 }
    })
    const failingSchedule = activityScheduled(
      1,
      failingNodeId,
      failingPolicy
    )
    const liveSchedule = activityScheduled(2, liveNodeId, livePolicy)
    const liveLogicalId = logicalId(liveNodeId)
    const liveTimerId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      liveLogicalId
    )
    const liveTimer = wireEvent(
      3,
      {
        _tag: "TimerScheduled",
        timerId: liveTimerId,
        purpose: {
          _tag: "ScheduleToClose",
          logicalActivityId: liveLogicalId
        },
        anchorEventId: liveSchedule.eventId,
        delayMillis: 10_000,
        deadline: time(10_200)
      },
      Identity.scheduleTimerCommandId(
        tenantId,
        runId,
        liveTimerId
      ),
      time(300)
    )
    const failingStarted = wireEvent(
      4,
      {
        _tag: "ActivityAttemptStarted",
        logicalActivityId: logicalId(failingNodeId),
        attemptId: attemptId(failingNodeId),
        attempt: 1
      },
      Identity.activityAttemptStartedEventId(
        tenantId,
        runId,
        failingNodeId,
        1
      ),
      time(400)
    )
    const encodedFailure = { _tag: "PermanentFailure" }
    const failingAttempt = wireEvent(
      5,
      {
        _tag: "ActivityAttemptFailed",
        logicalActivityId: logicalId(failingNodeId),
        attemptId: attemptId(failingNodeId),
        attempt: 1,
        failure: encodedFailure
      },
      Identity.activityAttemptFailedEventId(
        tenantId,
        runId,
        failingNodeId,
        1
      ),
      time(500)
    )
    const cause: Event.ActivityFailureCause = {
      _tag: "EncodedFailure",
      failure: encodedFailure
    }
    const finalFailure = wireEvent(
      6,
      {
        _tag: "ActivityFailed",
        logicalActivityId: logicalId(failingNodeId),
        nodeId: failingNodeId,
        nodeInstanceId: failingNodeId,
        attemptId: attemptId(failingNodeId),
        attempt: 1,
        cause
      },
      Identity.finalizeActivityFailureCommandId(
        tenantId,
        runId,
        failingNodeId
      ),
      time(600)
    )
    const cleanup = wireEvent(
      7,
      {
        _tag: "TimerCancelled",
        timerId: liveTimerId,
        reason: "RunTerminal"
      },
      Identity.cancelTimerCommandId(
        tenantId,
        runId,
        liveTimerId
      ),
      time(700)
    )
    const terminal = runFailed(
      8,
      {
        _tag: "ActivityFailure",
        logicalActivityId: logicalId(failingNodeId),
        nodeId: failingNodeId,
        nodeInstanceId: failingNodeId,
        attemptId: attemptId(failingNodeId),
        attempt: 1,
        cause
      },
      time(800)
    )
    const state = success(RunState.fold([
      runStarted(),
      failingSchedule,
      liveSchedule,
      liveTimer,
      failingStarted,
      failingAttempt,
      finalFailure,
      cleanup,
      terminal
    ]))

    assert.strictEqual(state.status, "Failed")
    assert.strictEqual(
      HashMap.getUnsafe(state.activities, liveLogicalId).status,
      "Active"
    )
    assert.strictEqual(
      HashMap.getUnsafe(state.timers, liveTimerId).status,
      "Cancelled"
    )
  })

  it("requires pending timer cleanup before RunFailed", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(10_100)
    )
    const expiryTimer = signalExpiryTimer(2, accepted, "signal-1", 0, 10_000)
    const expiryTimerId = (
      expiryTimer.payload as Event.TimerScheduled
    ).timerId
    const permanentPolicy = policy({
      maximumAttempts: 3,
      retryEncodedFailure: false
    })
    const failureCause: Event.ActivityFailureCause = {
      _tag: "EncodedFailure",
      failure: { _tag: "PermanentFailure" }
    }
    const terminalCause: Event.RunActivityFailureCause = {
      _tag: "ActivityFailure",
      logicalActivityId,
      nodeId,
      nodeInstanceId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      ),
      attempt: 1,
      cause: failureCause
    }
    const prefix = [
      runStarted(),
      accepted,
      expiryTimer,
      scheduled(3, 1, permanentPolicy),
      attemptStarted(4, 1),
      attemptFailed(5, 1, { _tag: "PermanentFailure" }),
      finalActivityFailure(6, 1, failureCause)
    ]
    assert.strictEqual(
      code([...prefix, runFailed(7, terminalCause)]),
      RunState.Codes.IllegalRunTransition
    )

    const cleanup = wireEvent(
      7,
      {
        _tag: "TimerCancelled",
        timerId: expiryTimerId,
        reason: "RunTerminal"
      },
      Identity.cancelTimerCommandId(
        tenantId,
        runId,
        expiryTimerId
      ),
      time(700)
    )
    assert.strictEqual(
      success(RunState.fold([
        ...prefix,
        cleanup,
        runFailed(8, terminalCause)
      ])).status,
      "Failed"
    )
  })

  it("does not model lease redelivery as another semantic attempt", () => {
    const first = scheduled(1, 1, policy())
    const state = success(RunState.fold([runStarted(), first]))
    assert.strictEqual(
      failure(RunState.reduce(state, {
        ...first,
        sequence: 2
      })).code,
      RunState.Codes.DuplicateEventId
    )
    assert.strictEqual(
      failure(RunState.reduce(state, {
        ...first,
        sequence: 2,
        eventId: "broker-redelivery"
      })).code,
      RunState.Codes.NonCanonicalEventId
    )
    assert.strictEqual(
      HashMap.size(
        HashMap.getUnsafe(state.activities, logicalActivityId).attempts
      ),
      1
    )
  })

  it("requires a started attempt before failure or success", () => {
    const prefix = [runStarted(), scheduled(1, 1, policy())]
    assert.strictEqual(
      code([...prefix, attemptFailed(2, 1)]),
      RunState.Codes.IllegalAttemptTransition
    )
    assert.strictEqual(
      code([...prefix, activitySucceeded(2, 1)]),
      RunState.Codes.IllegalAttemptTransition
    )
  })

  it("makes committed completion-versus-timeout event order authoritative", () => {
    const durationMillis = 1_000
    const activityPolicy = policy({
      startToClose: { _tag: "After", durationMillis }
    })
    const start = attemptStarted(2, 1, time(200))
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "StartToClose",
      Identity.activityAttemptId(tenantId, runId, nodeInstanceId, 1)
    )
    const timer = wireEvent(
      3,
      {
        _tag: "TimerScheduled",
        timerId,
        purpose: {
          _tag: "StartToClose",
          logicalActivityId,
          attemptId: Identity.activityAttemptId(
            tenantId,
            runId,
            nodeInstanceId,
            1
          ),
          attempt: 1
        },
        anchorEventId: start.eventId,
        delayMillis: durationMillis,
        deadline: time(1_200)
      },
      Identity.scheduleTimerCommandId(tenantId, runId, timerId),
      time(300)
    )
    const prefix = [
      runStarted(),
      scheduled(1, 1, activityPolicy),
      start,
      timer
    ]

    const completed = success(RunState.foldPrefix([
      ...prefix,
      activitySucceeded(4, 1, time(1_100))
    ]))
    assert.strictEqual(
      failure(RunState.reduce(
        completed,
        timerFired(5, timerId, time(1_200))
      )).code,
      RunState.Codes.IllegalTimerTransition
    )

    const timed = success(RunState.foldPrefix([
      ...prefix,
      timerFired(4, timerId, time(1_200))
    ]))
    assert.strictEqual(
      failure(RunState.validateDurableHead(timed)).code,
      RunState.Codes.IncompleteSemanticPairing
    )
    assert.strictEqual(
      failure(RunState.reduce(
        timed,
        activitySucceeded(5, 1, time(1_201))
      )).code,
      RunState.Codes.IllegalAttemptTransition
    )
    assert.strictEqual(
      failure(RunState.reduce(
        timed,
        attemptFailed(
          5,
          1,
          { _tag: "LateWorkerFailure" },
          time(1_201)
        )
      )).code,
      RunState.Codes.IllegalAttemptTransition
    )
    const timeout = wireEvent(
      5,
      {
        _tag: "ActivityAttemptTimedOut",
        logicalActivityId,
        attemptId: Identity.activityAttemptId(
          tenantId,
          runId,
          nodeInstanceId,
          1
        ),
        attempt: 1,
        timerId,
        timeoutKind: "StartToClose"
      },
      Identity.activityAttemptTimedOutEventId(
        tenantId,
        runId,
        nodeInstanceId,
        1,
        "StartToClose"
      ),
      time(1_201)
    )
    const timedOut = success(RunState.reduce(timed, timeout))
    assert.strictEqual(
      success(RunState.validateDurableHead(timedOut)).sequence,
      timedOut.sequence
    )
    assert.strictEqual(
      HashMap.getUnsafe(
        HashMap.getUnsafe(timedOut.activities, logicalActivityId).attempts,
        1
      ).status,
      "TimedOut"
    )
  })

  it("rejects durable heads missing enabled activity or retry timers", () => {
    const scheduleToStartHistory = [
      runStarted(),
      scheduled(
        1,
        1,
        policy({
          scheduleToStart: {
            _tag: "After",
            durationMillis: 500
          }
        })
      )
    ]
    assert.ok(Result.isSuccess(
      RunState.foldPrefix(scheduleToStartHistory)
    ))
    assert.strictEqual(
      code(scheduleToStartHistory),
      RunState.Codes.IncompleteSemanticPairing
    )

    const scheduleToCloseHistory = [
      runStarted(),
      scheduled(
        1,
        1,
        policy({
          scheduleToClose: {
            _tag: "After",
            durationMillis: 1_000
          }
        })
      )
    ]
    assert.ok(Result.isSuccess(
      RunState.foldPrefix(scheduleToCloseHistory)
    ))
    assert.strictEqual(
      code(scheduleToCloseHistory),
      RunState.Codes.IncompleteSemanticPairing
    )

    const startToCloseHistory = [
      runStarted(),
      scheduled(
        1,
        1,
        policy({
          startToClose: {
            _tag: "After",
            durationMillis: 1_000
          }
        })
      ),
      attemptStarted(2, 1)
    ]
    assert.ok(Result.isSuccess(
      RunState.foldPrefix(startToCloseHistory)
    ))
    assert.strictEqual(
      code(startToCloseHistory),
      RunState.Codes.IncompleteSemanticPairing
    )

    const failed = attemptFailed(3, 1)
    const retry = retryScheduled(
      4,
      1,
      1_000,
      time(400),
      failed.recordedAt
    )
    const retryHistory = [
      runStarted(),
      scheduled(1, 1, policy()),
      attemptStarted(2, 1),
      failed,
      retry
    ]
    assert.ok(Result.isSuccess(RunState.foldPrefix(retryHistory)))
    assert.strictEqual(
      code(retryHistory),
      RunState.Codes.IncompleteSemanticPairing
    )

    assert.ok(Result.isSuccess(RunState.fold([
      runStarted(),
      scheduled(1, 1, policy())
    ])))
  })

  it("makes schedule-to-close firing win every worker and retry race", () => {
    const durationMillis = 2_000
    const activityPolicy = policy({
      scheduleToClose: { _tag: "After", durationMillis }
    })
    const schedule = scheduled(1, 1, activityPolicy, time(100))
    const totalTimer = scheduleToCloseTimerScheduled(
      2,
      schedule,
      durationMillis,
      time(200)
    )
    const totalTimerId = (totalTimer.payload as Event.TimerScheduled).timerId
    const totalFiredWhileScheduled = [
      runStarted(),
      schedule,
      totalTimer,
      timerFired(3, totalTimerId, time(2_100))
    ]
    assert.strictEqual(
      code([
        ...totalFiredWhileScheduled,
        attemptStarted(4, 1, time(2_101))
      ]),
      RunState.Codes.IllegalAttemptTransition
    )

    const startedPrefix = [
      runStarted(),
      schedule,
      totalTimer,
      attemptStarted(3, 1, time(300)),
      timerFired(4, totalTimerId, time(2_100))
    ]
    assert.strictEqual(
      code([
        ...startedPrefix,
        activitySucceeded(5, 1, time(2_101))
      ]),
      RunState.Codes.IllegalAttemptTransition
    )
    assert.strictEqual(
      code([
        ...startedPrefix,
        attemptFailed(5, 1, { _tag: "LateFailure" }, time(2_101))
      ]),
      RunState.Codes.IllegalAttemptTransition
    )

    const failed = attemptFailed(4, 1, { _tag: "TransientFailure" }, time(400))
    assert.strictEqual(
      code([
        runStarted(),
        schedule,
        totalTimer,
        attemptStarted(3, 1, time(300)),
        failed,
        timerFired(5, totalTimerId, time(2_100)),
        retryScheduled(6, 1, 1_000, time(2_101), failed.recordedAt)
      ]),
      RunState.Codes.RetryMismatch
    )

    const startDelay = 500
    const timeoutPolicy = policy({
      scheduleToStart: { _tag: "After", durationMillis: startDelay },
      scheduleToClose: { _tag: "After", durationMillis }
    })
    const timeoutSchedule = scheduled(1, 1, timeoutPolicy, time(100))
    const attemptId = Identity.activityAttemptId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    )
    const startTimerId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToStart",
      attemptId
    )
    const startTimer = wireEvent(
      2,
      {
        _tag: "TimerScheduled",
        timerId: startTimerId,
        purpose: {
          _tag: "ScheduleToStart",
          logicalActivityId,
          attemptId,
          attempt: 1
        },
        anchorEventId: timeoutSchedule.eventId,
        delayMillis: startDelay,
        deadline: time(600)
      },
      Identity.scheduleTimerCommandId(
        tenantId,
        runId,
        startTimerId
      ),
      time(200)
    )
    const timeoutTotalTimer = scheduleToCloseTimerScheduled(
      3,
      timeoutSchedule,
      durationMillis,
      time(300)
    )
    const timeoutTotalTimerId = (
      timeoutTotalTimer.payload as Event.TimerScheduled
    ).timerId
    const attemptTimeout = wireEvent(
      6,
      {
        _tag: "ActivityAttemptTimedOut",
        logicalActivityId,
        attemptId,
        attempt: 1,
        timerId: startTimerId,
        timeoutKind: "ScheduleToStart"
      },
      Identity.activityAttemptTimedOutEventId(
        tenantId,
        runId,
        nodeInstanceId,
        1,
        "ScheduleToStart"
      ),
      time(2_101)
    )
    assert.strictEqual(
      code([
        runStarted(),
        timeoutSchedule,
        startTimer,
        timeoutTotalTimer,
        timerFired(4, startTimerId, time(600)),
        timerFired(5, timeoutTotalTimerId, time(2_100)),
        attemptTimeout
      ]),
      RunState.Codes.IllegalAttemptTransition
    )
  })

  it("allows schedule-to-start timeout and retry without a started fact", () => {
    const durationMillis = 500
    const activityPolicy = policy({
      scheduleToStart: { _tag: "After", durationMillis }
    })
    const schedule = scheduled(1, 1, activityPolicy, time(100))
    const attemptId = Identity.activityAttemptId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    )
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToStart",
      attemptId
    )
    const timer = wireEvent(
      2,
      {
        _tag: "TimerScheduled",
        timerId,
        purpose: {
          _tag: "ScheduleToStart",
          logicalActivityId,
          attemptId,
          attempt: 1
        },
        anchorEventId: schedule.eventId,
        delayMillis: durationMillis,
        deadline: time(600)
      },
      Identity.scheduleTimerCommandId(tenantId, runId, timerId),
      time(200)
    )
    const timeout = wireEvent(
      4,
      {
        _tag: "ActivityAttemptTimedOut",
        logicalActivityId,
        attemptId,
        attempt: 1,
        timerId,
        timeoutKind: "ScheduleToStart"
      },
      Identity.activityAttemptTimedOutEventId(
        tenantId,
        runId,
        nodeInstanceId,
        1,
        "ScheduleToStart"
      ),
      time(601)
    )
    const retry = retryScheduled(
      5,
      1,
      1_000,
      time(700),
      time(601),
      timeout.eventId
    )
    const retryTimer = retryTimerScheduled(
      6,
      1,
      timeout,
      1_000,
      time(800)
    )
    const state = success(RunState.fold([
      runStarted(),
      schedule,
      timer,
      timerFired(3, timerId, time(600)),
      timeout,
      retry,
      retryTimer
    ]))

    assert.strictEqual(
      HashMap.getUnsafe(state.activities, logicalActivityId).status,
      "RetryPending"
    )
  })

  it("derives a final schedule-to-close failure from its fired timer", () => {
    const durationMillis = 1_000
    const activityPolicy = policy({
      scheduleToClose: { _tag: "After", durationMillis }
    })
    const schedule = scheduled(1, 1, activityPolicy, time(100))
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      logicalActivityId
    )
    const timer = wireEvent(
      2,
      {
        _tag: "TimerScheduled",
        timerId,
        purpose: { _tag: "ScheduleToClose", logicalActivityId },
        anchorEventId: schedule.eventId,
        delayMillis: durationMillis,
        deadline: time(1_100)
      },
      Identity.scheduleTimerCommandId(tenantId, runId, timerId),
      time(200)
    )
    const state = success(RunState.fold([
      runStarted(),
      schedule,
      timer,
      timerFired(3, timerId, time(1_100)),
      finalActivityFailure(4, 1, {
        _tag: "ScheduleToCloseTimeout",
        timerId
      }, time(1_101))
    ]))

    assert.strictEqual(
      HashMap.getUnsafe(state.activities, logicalActivityId).status,
      "Failed"
    )
  })

  it("rejects fired activity timers without their atomic timeout consequence", () => {
    const durationMillis = 1_000
    const scheduleToStartPolicy = policy({
      scheduleToStart: { _tag: "After", durationMillis }
    })
    const scheduleToStart = scheduled(
      1,
      1,
      scheduleToStartPolicy,
      time(100)
    )
    const attemptId = Identity.activityAttemptId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    )
    const scheduleToStartTimerId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToStart",
      attemptId
    )
    const scheduleToStartTimer = wireEvent(
      2,
      {
        _tag: "TimerScheduled",
        timerId: scheduleToStartTimerId,
        purpose: {
          _tag: "ScheduleToStart",
          logicalActivityId,
          attemptId,
          attempt: 1
        },
        anchorEventId: scheduleToStart.eventId,
        delayMillis: durationMillis,
        deadline: time(1_100)
      },
      Identity.scheduleTimerCommandId(
        tenantId,
        runId,
        scheduleToStartTimerId
      ),
      time(200)
    )
    assert.strictEqual(
      code([
        runStarted(),
        scheduleToStart,
        scheduleToStartTimer,
        timerFired(3, scheduleToStartTimerId, time(1_100))
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )

    const startToClosePolicy = policy({
      startToClose: { _tag: "After", durationMillis }
    })
    const startToCloseSchedule = scheduled(
      1,
      1,
      startToClosePolicy,
      time(100)
    )
    const started = attemptStarted(2, 1, time(200))
    const startToCloseTimerId = Identity.timerId(
      tenantId,
      runId,
      "StartToClose",
      attemptId
    )
    const startToCloseTimer = wireEvent(
      3,
      {
        _tag: "TimerScheduled",
        timerId: startToCloseTimerId,
        purpose: {
          _tag: "StartToClose",
          logicalActivityId,
          attemptId,
          attempt: 1
        },
        anchorEventId: started.eventId,
        delayMillis: durationMillis,
        deadline: time(1_200)
      },
      Identity.scheduleTimerCommandId(
        tenantId,
        runId,
        startToCloseTimerId
      ),
      time(300)
    )
    assert.strictEqual(
      code([
        runStarted(),
        startToCloseSchedule,
        started,
        startToCloseTimer,
        timerFired(4, startToCloseTimerId, time(1_200))
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )

    const totalPolicy = policy({
      scheduleToClose: { _tag: "After", durationMillis }
    })
    const totalSchedule = scheduled(1, 1, totalPolicy, time(100))
    const totalTimer = scheduleToCloseTimerScheduled(
      2,
      totalSchedule,
      durationMillis,
      time(200)
    )
    const totalTimerId = (totalTimer.payload as Event.TimerScheduled).timerId
    assert.strictEqual(
      code([
        runStarted(),
        totalSchedule,
        totalTimer,
        timerFired(3, totalTimerId, time(1_100))
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )
  })

  it("retains but cancels a pending retry when schedule-to-close wins", () => {
    const totalDurationMillis = 10_000
    const activityPolicy = policy({
      scheduleToClose: {
        _tag: "After",
        durationMillis: totalDurationMillis
      }
    })
    const schedule = scheduled(1, 1, activityPolicy, time(100))
    const totalTimer = scheduleToCloseTimerScheduled(
      2,
      schedule,
      totalDurationMillis,
      time(200)
    )
    const failed = attemptFailed(
      4,
      1,
      { _tag: "TransientFailure" },
      time(400)
    )
    const retry = retryScheduled(
      5,
      1,
      1_000,
      time(500),
      failed.recordedAt
    )
    const retryTimer = retryTimerScheduled(
      6,
      1,
      failed,
      1_000,
      time(600)
    )
    const retryPayload = retry.payload as Event.RetryScheduled
    const totalTimerId = (
      totalTimer.payload as Event.TimerScheduled
    ).timerId
    const finalFailure = finalActivityFailure(
      8,
      1,
      {
        _tag: "ScheduleToCloseTimeout",
        timerId: totalTimerId
      },
      time(10_101)
    )
    const cancelRetry = wireEvent(
      9,
      {
        _tag: "TimerCancelled",
        timerId: retryPayload.timerId,
        reason: "Superseded"
      },
      Identity.cancelTimerCommandId(
        tenantId,
        runId,
        retryPayload.timerId
      ),
      time(10_102)
    )
    const beforeCleanup = success(RunState.foldPrefix([
      runStarted(),
      schedule,
      totalTimer,
      attemptStarted(3, 1, time(300)),
      failed,
      retry,
      retryTimer,
      timerFired(7, totalTimerId, time(10_100)),
      finalFailure
    ]))

    assert.strictEqual(
      failure(RunState.validateDurableHead(beforeCleanup)).code,
      RunState.Codes.IncompleteSemanticPairing
    )

    const state = success(RunState.fold([
      runStarted(),
      schedule,
      totalTimer,
      attemptStarted(3, 1, time(300)),
      failed,
      retry,
      retryTimer,
      timerFired(7, totalTimerId, time(10_100)),
      finalFailure,
      cancelRetry
    ]))

    assert.strictEqual(
      HashMap.getUnsafe(state.activities, logicalActivityId).status,
      "Failed"
    )
    assert.strictEqual(
      HashMap.getUnsafe(state.retries, retryPayload.retryId).status,
      "WaitingForTimer"
    )
    assert.strictEqual(
      HashMap.getUnsafe(state.timers, retryPayload.timerId).status,
      "Cancelled"
    )
  })

  it("consumes a signal accepted before its wait", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(10_100)
    )
    const expiryTimer = signalExpiryTimer(2, accepted, "signal-1", 0, 10_000)
    const expiryTimerId = (
      expiryTimer.payload as Event.TimerScheduled
    ).timerId
    const unpaired = success(RunState.foldPrefix([runStarted(), accepted]))
    assert.strictEqual(
      failure(RunState.validateDurableHead(unpaired)).code,
      RunState.Codes.IncompleteSemanticPairing
    )
    assert.strictEqual(
      success(RunState.validateDurableHead(
        success(RunState.reduce(unpaired, expiryTimer))
      )).pendingSignalCount,
      1
    )
    const forgedCleanup = wireEvent(
      3,
      {
        _tag: "TimerCancelled",
        timerId: expiryTimerId,
        reason: "SignalConsumed"
      },
      Identity.cancelTimerCommandId(
        tenantId,
        runId,
        expiryTimerId
      ),
      time(300)
    )
    assert.strictEqual(
      code([runStarted(), accepted, expiryTimer, forgedCleanup]),
      RunState.Codes.IllegalTimerTransition
    )
    const state = success(RunState.foldPrefix([
      runStarted(),
      accepted,
      expiryTimer,
      signalWaitStarted(3, "approval"),
      signalConsumed(4, "signal-1", 0, "approval")
    ]))

    assert.strictEqual(
      HashMap.getUnsafe(state.signals, "signal-1").status,
      "Consumed"
    )
    assert.strictEqual(state.acceptedSignalCount, 1)
    assert.strictEqual(state.nextInboxSequence, 1)
    assert.strictEqual(state.pendingSignalCount, 0)
    assert.strictEqual(state.pendingSignalEncodedBytes, 0)
    assert.strictEqual(
      HashMap.getUnsafe(state.signals, "signal-1").admission.policyDecisionId,
      "decision-signal-1"
    )
    assert.strictEqual(
      HashMap.getUnsafe(
        state.signalWaits,
        Identity.signalWaitId(tenantId, runId, "approval")
      ).status,
      "Consumed"
    )
    assert.strictEqual(
      failure(RunState.validateDurableHead(state)).code,
      RunState.Codes.IncompleteSemanticPairing
    )
    const cleanup = wireEvent(
      5,
      {
        _tag: "TimerCancelled",
        timerId: expiryTimerId,
        reason: "SignalConsumed"
      },
      Identity.cancelTimerCommandId(
        tenantId,
        runId,
        expiryTimerId
      ),
      time(500)
    )
    const cleaned = success(RunState.reduce(state, cleanup))
    assert.strictEqual(
      HashMap.getUnsafe(cleaned.timers, expiryTimerId).status,
      "Cancelled"
    )
    assert.strictEqual(
      success(RunState.validateDurableHead(cleaned)).sequence,
      cleaned.sequence
    )
  })

  it("rejects duplicate signal identity and non-monotonic inbox sequence", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(10_100)
    )
    const expiryTimer = signalExpiryTimer(
      2,
      accepted,
      "signal-1",
      0,
      10_000
    )
    assert.strictEqual(
      code([
        runStarted(),
        accepted,
        { ...accepted, sequence: 2 }
      ]),
      RunState.Codes.DuplicateEventId
    )
    assert.strictEqual(
      code([
        runStarted(),
        accepted,
        expiryTimer,
        signalAccepted(3, "signal-2", 0, time(300), time(10_300))
      ]),
      RunState.Codes.InboxSequenceMismatch
    )
  })

  it("consumes the oldest matching signal and enforces correlation", () => {
    const first = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(10_100),
      { _tag: "Exact", key: "order-1" }
    )
    const second = signalAccepted(
      3,
      "signal-2",
      1,
      time(300),
      time(10_300),
      { _tag: "Exact", key: "order-1" }
    )
    const firstTimer = signalExpiryTimer(2, first, "signal-1", 0, 10_000)
    const secondTimer = signalExpiryTimer(4, second, "signal-2", 1, 10_000)
    const wait = signalWaitStarted(
      5,
      "approval",
      { _tag: "Disabled" },
      { _tag: "Exact", key: "order-1" }
    )
    const prefix = [
      runStarted(),
      first,
      firstTimer,
      second,
      secondTimer,
      wait
    ]

    assert.strictEqual(
      code([...prefix, signalConsumed(6, "signal-2", 1, "approval")]),
      RunState.Codes.SignalOrderMismatch
    )
    assert.doesNotThrow(() =>
      success(RunState.foldPrefix([
        ...prefix,
        signalConsumed(6, "signal-1", 0, "approval")
      ]))
    )

    const mismatched = signalWaitStarted(
      5,
      "approval",
      { _tag: "Disabled" },
      { _tag: "Exact", key: "another-order" }
    )
    assert.strictEqual(
      code([
        runStarted(),
        first,
        firstTimer,
        second,
        secondTimer,
        mismatched,
        signalConsumed(6, "signal-1", 0, "approval")
      ]),
      RunState.Codes.SignalMatchMismatch
    )
  })

  it("derives signal expiry from a fired expiry timer", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(1_100)
    )
    const expiryTimer = signalExpiryTimer(2, accepted, "signal-1", 0, 1_000)
    const timerId = (expiryTimer.payload as Event.TimerScheduled).timerId
    const expired = success(RunState.fold([
      runStarted(),
      accepted,
      expiryTimer,
      timerFired(3, timerId, time(1_100))
    ]))
    assert.strictEqual(
      HashMap.getUnsafe(expired.signals, "signal-1").status,
      "Expired"
    )
    assert.strictEqual(expired.acceptedSignalCount, 1)
    assert.strictEqual(expired.pendingSignalCount, 0)
    assert.strictEqual(expired.pendingSignalEncodedBytes, 0)
    const waiting = success(RunState.reduce(
      expired,
      signalWaitStarted(
        4,
        "approval",
        { _tag: "Disabled" },
        { _tag: "Any" },
        time(1_200)
      )
    ))
    assert.strictEqual(
      failure(RunState.reduce(
        waiting,
        signalConsumed(5, "signal-1", 0, "approval", time(1_300))
      )).code,
      RunState.Codes.IllegalSignalTransition
    )
  })

  it("rejects inconsistent signal TTL, blob integrity, and pending accounting", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(1_100)
    )
    const acceptedPayload = accepted.payload as Event.SignalAccepted
    assert.strictEqual(
      code([
        runStarted(),
        {
          ...accepted,
          payload: {
            ...acceptedPayload,
            ttlMillis: acceptedPayload.ttlMillis + 1
          }
        }
      ]),
      RunState.Codes.TimerOwnershipMismatch
    )

    const blobDigest = Schema.decodeUnknownSync(
      ProtocolV2Wire.BlobDigest
    )(`sha256:${"9".repeat(64)}`)
    const blobAccepted: Event.Event = {
      ...accepted,
      payload: {
        ...acceptedPayload,
        payload: {
          _tag: "Blob",
          ref: {
            blobVersion: 1,
            digest: blobDigest,
            encodedBytes: 32,
            mediaType: "application/json"
          }
        },
        encodedPayloadBytes: 31
      }
    }
    assert.strictEqual(
      code([runStarted(), blobAccepted]),
      RunState.Codes.TimerOwnershipMismatch
    )

    const expiryTimer = signalExpiryTimer(
      2,
      accepted,
      "signal-1",
      0,
      1_000
    )
    const timerId = (expiryTimer.payload as Event.TimerScheduled).timerId
    const pending = success(RunState.fold([
      runStarted(),
      accepted,
      expiryTimer
    ]))
    const corrupted: RunState.RunState = {
      ...pending,
      pendingSignalEncodedBytes: 0
    }
    assert.strictEqual(
      failure(RunState.reduce(
        corrupted,
        timerFired(3, timerId, time(1_100))
      )).code,
      RunState.Codes.InvalidState
    )
  })

  it("derives signal-wait timeout and validates matching terminal failure", () => {
    const durationMillis = 1_000
    const wait = signalWaitStarted(
      1,
      "approval",
      { _tag: "After", durationMillis },
      { _tag: "Any" },
      time(100)
    )
    const waitId = Identity.signalWaitId(tenantId, runId, "approval")
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "SignalWaitTimeout",
      waitId
    )
    const timer = wireEvent(
      2,
      {
        _tag: "TimerScheduled",
        timerId,
        purpose: {
          _tag: "SignalWaitTimeout",
          waitId,
          nodeInstanceId: "approval"
        },
        anchorEventId: wait.eventId,
        delayMillis: durationMillis,
        deadline: time(1_100)
      },
      Identity.scheduleTimerCommandId(tenantId, runId, timerId),
      time(200)
    )
    assert.strictEqual(
      failure(RunState.validateDurableHead(
        success(RunState.foldPrefix([runStarted(), wait]))
      )).code,
      RunState.Codes.IncompleteSemanticPairing
    )
    assert.doesNotThrow(() =>
      success(RunState.validateDurableHead(
        success(RunState.fold([runStarted(), wait, timer]))
      ))
    )
    const cause: Event.SignalWaitTimeoutFailureCause = {
      _tag: "SignalWaitTimeout",
      waitId,
      nodeId: "approval",
      nodeInstanceId: "approval",
      timerId
    }
    const state = success(RunState.fold([
      runStarted(),
      wait,
      timer,
      timerFired(3, timerId, time(1_100)),
      runFailed(4, cause, time(1_101))
    ]))

    assert.strictEqual(state.status, "Failed")
    assert.strictEqual(
      HashMap.getUnsafe(state.signalWaits, waitId).status,
      "TimedOut"
    )
  })

  it("requires timer-owner pairs to be contiguous in one committed batch", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(10_100)
    )
    assert.strictEqual(
      code([
        runStarted(),
        accepted,
        signalWaitStarted(2, "unrelated-wait")
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )

    const timedWait = signalWaitStarted(
      1,
      "timed-wait",
      { _tag: "After", durationMillis: 1_000 },
      { _tag: "Any" },
      time(100)
    )
    assert.strictEqual(
      code([
        runStarted(),
        timedWait,
        scheduled(2, 1, policy({ retry: { _tag: "Never" } }), time(200))
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )

    const sleep = sleepStarted(1, "unpaired-sleep", 1_000, time(100))
    assert.strictEqual(
      code([
        runStarted(),
        sleep,
        scheduled(2, 1, policy({ retry: { _tag: "Never" } }), time(200))
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )
  })

  it("allows only timer cleanup and RunCancelled after cancellation", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(10_100)
    )
    const expiryTimer = signalExpiryTimer(2, accepted, "signal-1", 0, 10_000)
    const timerId = (expiryTimer.payload as Event.TimerScheduled).timerId
    const requestId = "cancel-request-1"
    const cancellation = wireEvent(
      3,
      {
        _tag: "RunCancellationRequested",
        requestId
      },
      Identity.runCancellationRequestedEventId(
        tenantId,
        runId,
        requestId
      ),
      time(300)
    )
    const requested = success(RunState.foldPrefix([
      runStarted(),
      accepted,
      expiryTimer,
      cancellation
    ]))
    assert.strictEqual(
      failure(RunState.validateDurableHead(requested)).code,
      RunState.Codes.IncompleteSemanticPairing
    )

    assert.strictEqual(
      failure(RunState.reduce(
        requested,
        signalWaitStarted(4, "approval")
      )).code,
      RunState.Codes.IllegalCancellationTransition
    )
    const cancelledEvent = wireEvent(
      4,
      {
        _tag: "RunCancelled"
      },
      Identity.cancelRunCommandId(tenantId, runId),
      time(400)
    )
    assert.strictEqual(
      failure(RunState.reduce(requested, cancelledEvent)).code,
      RunState.Codes.IllegalCancellationTransition
    )
    const badCleanup = wireEvent(
      4,
      {
        _tag: "TimerCancelled",
        timerId,
        reason: "RunTerminal"
      },
      Identity.cancelTimerCommandId(tenantId, runId, timerId),
      time(400)
    )
    assert.strictEqual(
      failure(RunState.reduce(requested, badCleanup)).code,
      RunState.Codes.IllegalCancellationTransition
    )
    const cleanup = wireEvent(
      4,
      {
        _tag: "TimerCancelled",
        timerId,
        reason: "RunCancellationRequested"
      },
      Identity.cancelTimerCommandId(tenantId, runId, timerId),
      time(400)
    )
    const cleaned = success(RunState.reduce(requested, cleanup))
    assert.strictEqual(
      HashMap.getUnsafe(cleaned.signals, "signal-1").status,
      "Discarded"
    )
    assert.strictEqual(cleaned.pendingSignalCount, 0)
    assert.strictEqual(cleaned.pendingSignalEncodedBytes, 0)
    assert.strictEqual(
      success(RunState.validateDurableHead(cleaned)).sequence,
      cleaned.sequence
    )
    const terminal = wireEvent(
      5,
      {
        _tag: "RunCancelled"
      },
      Identity.cancelRunCommandId(tenantId, runId),
      time(500)
    )
    const state = success(RunState.reduce(cleaned, terminal))
    assert.strictEqual(state.status, "Cancelled")
    assert.strictEqual(
      failure(RunState.reduce(state, {
        ...terminal,
        sequence: 6
      })).code,
      RunState.Codes.EventAfterTerminal
    )
  })

  it("accepts cancellation cleanup for a live activity without reviving its timers", () => {
    const activityPolicy = policy({
      scheduleToClose: { _tag: "After", durationMillis: 10_000 }
    })
    const schedule = scheduled(1, 1, activityPolicy, time(100))
    const totalTimer = scheduleToCloseTimerScheduled(
      2,
      schedule,
      10_000,
      time(200)
    )
    const timerId = (totalTimer.payload as Event.TimerScheduled).timerId
    const requestId = "cancel-live-activity"
    const cancellation = wireEvent(
      3,
      {
        _tag: "RunCancellationRequested",
        requestId
      },
      Identity.runCancellationRequestedEventId(
        tenantId,
        runId,
        requestId
      ),
      time(300)
    )
    const cleanup = wireEvent(
      4,
      {
        _tag: "TimerCancelled",
        timerId,
        reason: "RunCancellationRequested"
      },
      Identity.cancelTimerCommandId(tenantId, runId, timerId),
      time(400)
    )
    const cleaned = success(RunState.fold([
      runStarted(),
      schedule,
      totalTimer,
      cancellation,
      cleanup
    ]))

    assert.strictEqual(cleaned.status, "CancellationRequested")
    assert.strictEqual(
      HashMap.getUnsafe(cleaned.activities, logicalActivityId).status,
      "Active"
    )
    assert.strictEqual(
      HashMap.getUnsafe(cleaned.timers, timerId).status,
      "Cancelled"
    )

    const terminal = wireEvent(
      5,
      {
        _tag: "RunCancelled"
      },
      Identity.cancelRunCommandId(tenantId, runId),
      time(500)
    )
    const cancelled = success(RunState.reduce(cleaned, terminal))
    assert.strictEqual(cancelled.status, "Cancelled")
    assert.strictEqual(
      success(RunState.validateDurableHead(cancelled)).sequence,
      cancelled.sequence
    )
  })

  it("rejects cancellation from a truncated signal pair and closes untimed waits", () => {
    const requestId = "cancel-disabled-wait"
    const cancellationAtTwo = wireEvent(
      2,
      {
        _tag: "RunCancellationRequested",
        requestId
      },
      Identity.runCancellationRequestedEventId(
        tenantId,
        runId,
        requestId
      ),
      time(200)
    )
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(1_100)
    )
    assert.strictEqual(
      code([runStarted(), accepted, cancellationAtTwo]),
      RunState.Codes.IncompleteSemanticPairing
    )

    const wait = signalWaitStarted(
      1,
      "approval",
      { _tag: "Disabled" },
      { _tag: "Any" },
      time(100)
    )
    const requested = success(RunState.fold([
      runStarted(),
      wait,
      cancellationAtTwo
    ]))
    const terminal = wireEvent(
      3,
      { _tag: "RunCancelled" },
      Identity.cancelRunCommandId(tenantId, runId),
      time(300)
    )
    const cancelled = success(RunState.reduce(requested, terminal))
    const waitId = Identity.signalWaitId(tenantId, runId, "approval")
    assert.strictEqual(cancelled.status, "Cancelled")
    assert.strictEqual(
      HashMap.getUnsafe(cancelled.signalWaits, waitId).status,
      "Cancelled"
    )
  })

  it("resolves completion-versus-cancellation races by committed order", () => {
    const activityPolicy = policy()
    const completed = success(RunState.fold([
      runStarted(),
      scheduled(1, 1, activityPolicy),
      attemptStarted(2, 1),
      activitySucceeded(3, 1)
    ]))
    const requestId = "cancel-after-completion"
    const request = wireEvent(
      4,
      {
        _tag: "RunCancellationRequested",
        requestId
      },
      Identity.runCancellationRequestedEventId(
        tenantId,
        runId,
        requestId
      )
    )
    assert.strictEqual(
      success(RunState.reduce(completed, request)).status,
      "CancellationRequested"
    )

    const requested = success(RunState.fold([
      runStarted(),
      scheduled(1, 1, activityPolicy),
      wireEvent(
        2,
        {
          _tag: "RunCancellationRequested",
          requestId: "cancel-first"
        },
        Identity.runCancellationRequestedEventId(
          tenantId,
          runId,
          "cancel-first"
        )
      )
    ]))
    assert.strictEqual(
      failure(RunState.reduce(
        requested,
        attemptStarted(3, 1)
      )).code,
      RunState.Codes.IllegalCancellationTransition
    )
  })

  it("validates timer anchors, exact deadline arithmetic, and fire time", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(1_100)
    )
    const valid = signalExpiryTimer(2, accepted, "signal-1", 0, 1_000)
    const validPayload = valid.payload as Event.TimerScheduled

    assert.strictEqual(
      code([
        runStarted(),
        accepted,
        {
          ...valid,
          payload: { ...validPayload, anchorEventId: "missing-anchor" }
        }
      ]),
      RunState.Codes.TimerAnchorNotFound
    )
    assert.strictEqual(
      code([
        runStarted(),
        accepted,
        {
          ...valid,
          payload: { ...validPayload, deadline: time(1_101) }
        }
      ]),
      RunState.Codes.TimerDeadlineMismatch
    )
    const pending = success(RunState.fold([
      runStarted(),
      accepted,
      valid
    ]))
    assert.strictEqual(
      failure(RunState.reduce(
        pending,
        timerFired(3, validPayload.timerId, time(1_099))
      )).code,
      RunState.Codes.IllegalTimerTransition
    )
    assert.strictEqual(
      HashMap.getUnsafe(
        success(RunState.reduce(
          pending,
          timerFired(3, validPayload.timerId, time(1_100))
        )).timers,
        validPayload.timerId
      ).status,
      "Fired"
    )
  })

  it("validates canonical timer ownership and fails closed for ownerless Sleep", () => {
    const accepted = signalAccepted(
      1,
      "signal-1",
      0,
      time(100),
      time(1_100)
    )
    const valid = signalExpiryTimer(2, accepted, "signal-1", 0, 1_000)
    const validPayload = valid.payload as Event.TimerScheduled
    assert.strictEqual(
      code([
        runStarted(),
        accepted,
        {
          ...valid,
          payload: { ...validPayload, timerId: "forged-timer" },
          eventId: Identity.scheduleTimerCommandId(
            tenantId,
            runId,
            "forged-timer"
          )
        }
      ]),
      RunState.Codes.TimerOwnershipMismatch
    )

    const waitId = Identity.sleepWaitId(
      tenantId,
      runId,
      "sleep-node"
    )
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "Sleep",
      waitId
    )
    const sleep = wireEvent(1, {
      _tag: "TimerScheduled",
      timerId,
      purpose: {
        _tag: "Sleep",
        waitId,
        nodeInstanceId: "sleep-node"
      },
      anchorEventId: runStarted().eventId,
      delayMillis: 1_000,
      deadline: time(1_000)
    }, Identity.scheduleTimerCommandId(tenantId, runId, timerId))
    assert.strictEqual(
      code([runStarted(), sleep]),
      RunState.Codes.SleepNotFound
    )
  })

  it("replays Sleep from its canonical owner through timer fire and run success", () => {
    const started = sleepStarted(1, "sleep", 1_000, time(100))
    const waitId = (started.payload as Event.SleepStarted).waitId
    const scheduledTimer = sleepTimerScheduled(2, started, time(200))
    const timerId = (scheduledTimer.payload as Event.TimerScheduled).timerId

    const owner = success(RunState.foldPrefix([runStarted(), started]))
    const ownerSleep = HashMap.getUnsafe(owner.sleeps, waitId)
    assert.strictEqual(ownerSleep.status, "Pending")
    assert.strictEqual(ownerSleep.timerId, undefined)
    assert.strictEqual(
      failure(RunState.validateDurableHead(owner)).code,
      RunState.Codes.IncompleteSemanticPairing
    )
    assert.strictEqual(
      failure(RunState.reduce(owner, runSucceeded(2, time(200)))).code,
      RunState.Codes.IncompleteSemanticPairing
    )
    assert.strictEqual(
      (failure(
        RunState.reduce(owner, runSucceeded(2, time(200)))
      ).details as { readonly owner: string }).owner,
      "SleepStarted"
    )

    const armed = success(RunState.reduce(owner, scheduledTimer))
    const armedSleep = HashMap.getUnsafe(armed.sleeps, waitId)
    assert.strictEqual(armedSleep.status, "Pending")
    assert.strictEqual(armedSleep.timerId, timerId)
    assert.strictEqual(ownerSleep.timerId, undefined)
    assert.strictEqual(
      success(RunState.validateDurableHead(armed)).sequence,
      armed.sequence
    )
    assert.strictEqual(
      failure(RunState.reduce(armed, runSucceeded(3, time(300)))).code,
      RunState.Codes.IllegalRunTransition
    )
    assert.strictEqual(
      failure(RunState.reduce(
        armed,
        timerFired(3, timerId, time(1_099))
      )).code,
      RunState.Codes.IllegalTimerTransition
    )

    const completed = success(RunState.reduce(
      armed,
      timerFired(3, timerId, time(1_100))
    ))
    const completedSleep = HashMap.getUnsafe(completed.sleeps, waitId)
    assert.strictEqual(completedSleep.status, "Completed")
    assert.strictEqual(completedSleep.completedAt, time(1_100))
    assert.strictEqual(armedSleep.status, "Pending")
    assert.ok(Object.isFrozen(ownerSleep))
    assert.ok(Object.isFrozen(armedSleep))
    assert.ok(Object.isFrozen(completedSleep))
    assert.strictEqual(
      success(RunState.validateDurableHead(completed)).sequence,
      completed.sequence
    )

    const lateCancellation = wireEvent(
      4,
      {
        _tag: "TimerCancelled",
        timerId,
        reason: "OwnerCompleted"
      },
      Identity.cancelTimerCommandId(tenantId, runId, timerId),
      time(1_101)
    )
    assert.strictEqual(
      failure(RunState.reduce(completed, lateCancellation)).code,
      RunState.Codes.IllegalTimerTransition
    )

    const terminal = success(RunState.reduce(
      completed,
      runSucceeded(4, time(1_101))
    ))
    assert.strictEqual(terminal.status, "Succeeded")
    assert.strictEqual(
      HashMap.getUnsafe(terminal.sleeps, waitId).status,
      "Completed"
    )

    assert.strictEqual(
      code([
        runStarted(),
        started,
        {
          ...started,
          sequence: 2,
          recordedAt: time(200)
        }
      ]),
      RunState.Codes.DuplicateEventId
    )
  })

  it("rejects forged Sleep identities and imprecise timer ownership", () => {
    const started = sleepStarted(1, "sleep", 1_000, time(100))
    const sleep = started.payload as Event.SleepStarted
    const timer = sleepTimerScheduled(2, started, time(200))
    const timerPayload = timer.payload as Event.TimerScheduled

    assert.strictEqual(
      code([
        runStarted(),
        { ...started, eventId: "forged-start-sleep" }
      ]),
      RunState.Codes.NonCanonicalEventId
    )
    assert.strictEqual(
      code([
        runStarted(),
        {
          ...started,
          payload: { ...sleep, waitId: "forged-wait" }
        }
      ]),
      RunState.Codes.SleepIdentityMismatch
    )
    assert.strictEqual(
      code([
        runStarted(),
        started,
        {
          ...timer,
          payload: {
            ...timerPayload,
            purpose: {
              ...timerPayload.purpose,
              nodeInstanceId: "other-sleep"
            }
          }
        }
      ]),
      RunState.Codes.TimerOwnershipMismatch
    )
    assert.strictEqual(
      code([
        runStarted(),
        started,
        {
          ...timer,
          payload: {
            ...timerPayload,
            anchorEventId: runStarted().eventId,
            deadline: time(1_000)
          }
        }
      ]),
      RunState.Codes.TimerOwnershipMismatch
    )
    assert.strictEqual(
      code([
        runStarted(),
        started,
        {
          ...timer,
          payload: {
            ...timerPayload,
            delayMillis: 999,
            deadline: time(1_099)
          }
        }
      ]),
      RunState.Codes.TimerOwnershipMismatch
    )

    const forgedTimerId = Identity.timerId(
      tenantId,
      runId,
      "Sleep",
      "forged-owner"
    )
    assert.strictEqual(
      code([
        runStarted(),
        started,
        {
          ...timer,
          eventId: Identity.scheduleTimerCommandId(
            tenantId,
            runId,
            forgedTimerId
          ),
          payload: {
            ...timerPayload,
            timerId: forgedTimerId
          }
        }
      ]),
      RunState.Codes.TimerOwnershipMismatch
    )
  })

  it("cancels armed and intermediate Sleep owners during terminal cleanup", () => {
    const started = sleepStarted(1, "sleep", 10_000, time(100))
    const waitId = (started.payload as Event.SleepStarted).waitId
    const timer = sleepTimerScheduled(2, started, time(200))
    const timerId = (timer.payload as Event.TimerScheduled).timerId
    const requestId = "cancel-sleep"
    const request = wireEvent(
      3,
      { _tag: "RunCancellationRequested", requestId },
      Identity.runCancellationRequestedEventId(
        tenantId,
        runId,
        requestId
      ),
      time(300)
    )
    const cleanup = wireEvent(
      4,
      {
        _tag: "TimerCancelled",
        timerId,
        reason: "RunCancellationRequested"
      },
      Identity.cancelTimerCommandId(tenantId, runId, timerId),
      time(400)
    )
    const terminal = wireEvent(
      5,
      { _tag: "RunCancelled" },
      Identity.cancelRunCommandId(tenantId, runId),
      time(500)
    )
    const cleaned = success(RunState.fold([
      runStarted(),
      started,
      timer,
      request,
      cleanup
    ]))
    assert.strictEqual(
      failure(RunState.reduce(
        cleaned,
        timerFired(5, timerId, time(10_100))
      )).code,
      RunState.Codes.IllegalCancellationTransition
    )
    const cancelled = success(RunState.reduce(cleaned, terminal))
    assert.strictEqual(cancelled.status, "Cancelled")
    assert.strictEqual(
      HashMap.getUnsafe(cancelled.sleeps, waitId).status,
      "Cancelled"
    )

    const intermediateStarted = sleepStarted(1, "intermediate", 10_000, time(100))
    const intermediateRequestId = "cancel-intermediate-sleep"
    const intermediateRequest = wireEvent(
      2,
      {
        _tag: "RunCancellationRequested",
        requestId: intermediateRequestId
      },
      Identity.runCancellationRequestedEventId(
        tenantId,
        runId,
        intermediateRequestId
      ),
      time(200)
    )
    const intermediateTerminal = wireEvent(
      3,
      { _tag: "RunCancelled" },
      Identity.cancelRunCommandId(tenantId, runId),
      time(300)
    )
    assert.strictEqual(
      code([
        runStarted(),
        intermediateStarted,
        intermediateRequest,
        intermediateTerminal
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )

    const failedSleep = sleepStarted(1, "failed-run-sleep", 10_000, time(100))
    const failedWaitId = (failedSleep.payload as Event.SleepStarted).waitId
    const failedSleepTimer = sleepTimerScheduled(2, failedSleep, time(200))
    const failedSleepTimerId = (
      failedSleepTimer.payload as Event.TimerScheduled
    ).timerId
    const permanentPolicy = policy({
      maximumAttempts: 1,
      retryEncodedFailure: false
    })
    const activityCause: Event.ActivityFailureCause = {
      _tag: "EncodedFailure",
      failure: { _tag: "PermanentFailure" }
    }
    const terminalCause: Event.RunActivityFailureCause = {
      _tag: "ActivityFailure",
      logicalActivityId,
      nodeId,
      nodeInstanceId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      ),
      attempt: 1,
      cause: activityCause
    }
    const terminalCleanup = wireEvent(
      7,
      {
        _tag: "TimerCancelled",
        timerId: failedSleepTimerId,
        reason: "RunTerminal"
      },
      Identity.cancelTimerCommandId(
        tenantId,
        runId,
        failedSleepTimerId
      ),
      time(700)
    )
    const failed = success(RunState.fold([
      runStarted(),
      failedSleep,
      failedSleepTimer,
      scheduled(3, 1, permanentPolicy, time(300)),
      attemptStarted(4, 1, time(400)),
      attemptFailed(5, 1, { _tag: "PermanentFailure" }, time(500)),
      finalActivityFailure(6, 1, activityCause, time(600)),
      terminalCleanup,
      runFailed(8, terminalCause, time(800))
    ]))
    assert.strictEqual(failed.status, "Failed")
    assert.strictEqual(
      HashMap.getUnsafe(failed.sleeps, failedWaitId).status,
      "Cancelled"
    )

    assert.strictEqual(
      code([
        runStarted(),
        sleepStarted(1, "abandoned-sleep", 10_000, time(100)),
        scheduled(2, 1, permanentPolicy, time(200)),
        attemptStarted(3, 1, time(300)),
        attemptFailed(4, 1, { _tag: "PermanentFailure" }, time(400)),
        finalActivityFailure(5, 1, activityCause, time(500)),
        runFailed(6, terminalCause, time(600))
      ]),
      RunState.Codes.IncompleteSemanticPairing
    )
  })

  it("rejects mixed format version 1 history", () => {
    const v1 = {
      eventVersion: 1,
      eventId: "v1-event",
      runId,
      sequence: 1,
      recordedAt: time(100),
      payload: { _tag: "RunCancellationRequested" }
    }
    assert.strictEqual(
      code([runStarted(), v1]),
      RunState.Codes.InvalidEvent
    )
    assert.strictEqual(
      code([{ ...v1, sequence: 0 }]),
      RunState.Codes.InvalidEvent
    )
  })

  it("validates first-event, continuity, tenant, run, duplicate, and canonical ids", () => {
    assert.strictEqual(code([]), RunState.Codes.EmptyHistory)
    assert.strictEqual(
      code([scheduled(0, 1, policy())]),
      RunState.Codes.FirstEventNotRunStarted
    )
    assert.strictEqual(
      code([{ ...runStarted(), sequence: 1 }]),
      RunState.Codes.SequenceMismatch
    )
    assert.strictEqual(
      code([{ ...runStarted(), eventId: "forged-start" }]),
      RunState.Codes.NonCanonicalEventId
    )

    const first = scheduled(1, 1, policy())
    assert.strictEqual(
      code([runStarted(), { ...first, tenantId: "tenant-2" }]),
      RunState.Codes.TenantIdMismatch
    )
    assert.strictEqual(
      code([runStarted(), { ...first, runId: "run-2" }]),
      RunState.Codes.RunIdMismatch
    )
    assert.strictEqual(
      code([runStarted(), { ...first, sequence: 2 }]),
      RunState.Codes.SequenceMismatch
    )
    assert.strictEqual(
      code([
        runStarted(),
        scheduled(1, 1, policy(), time(-1))
      ]),
      RunState.Codes.TimestampRegression
    )
    assert.strictEqual(
      success(RunState.fold([
        runStarted(),
        scheduled(1, 1, policy(), time(0))
      ])).lastRecordedAt,
      time(0)
    )
    assert.strictEqual(
      code([
        runStarted(),
        first,
        { ...first, sequence: 2 }
      ]),
      RunState.Codes.DuplicateEventId
    )
  })

  it("rejects hostile history without invoking accessors or iteration hooks", () => {
    let getterReads = 0
    const hostileEvent = Object.defineProperty({}, "eventVersion", {
      enumerable: true,
      get() {
        getterReads++
        return 2
      }
    })
    assert.strictEqual(
      code([hostileEvent]),
      RunState.Codes.InvalidEvent
    )

    const hostileHistory = [runStarted()]
    Object.defineProperty(hostileHistory, Symbol.iterator, {
      get() {
        getterReads++
        throw new Error("hostile iterator")
      }
    })
    assert.strictEqual(
      code(hostileHistory),
      RunState.Codes.InvalidHistory
    )
    assert.strictEqual(getterReads, 0)
  })

  it("returns detached recursively frozen state without mutating prior states", () => {
    const mutableInput = { order: { id: "order-1" } }
    const first = success(RunState.fold([runStarted(mutableInput)]))
    const second = success(RunState.reduce(
      first,
      scheduled(1, 1, policy())
    ))

    mutableInput.order.id = "mutated"
    assert.deepStrictEqual(first.input, { order: { id: "order-1" } })
    assert.strictEqual(first.sequence, 0)
    assert.strictEqual(HashMap.size(first.activities), 0)
    assert.strictEqual(second.sequence, 1)
    assert.strictEqual(HashMap.size(second.activities), 1)
    assert.ok(Object.isFrozen(first))
    assert.ok(Object.isFrozen(second))
    assert.ok(Object.isFrozen(first.input))
    assert.ok(Object.isFrozen(HashMap.getUnsafe(
      second.activities,
      logicalActivityId
    )))
    assert.ok(Object.isFrozen(HashMap.getUnsafe(
      HashMap.getUnsafe(second.activities, logicalActivityId).attempts,
      1
    )))
    const activityMapRuntime = second.activities as unknown as {
      readonly _root: object
    }
    const attemptsRuntime = HashMap.getUnsafe(
      second.activities,
      logicalActivityId
    ).attempts as unknown as {
      readonly _root: object
    }
    assert.ok(Object.isFrozen(second.activities))
    assert.ok(Object.isFrozen(activityMapRuntime._root))
    assert.ok(Object.isFrozen(attemptsRuntime))
    assert.ok(Object.isFrozen(attemptsRuntime._root))
    assert.isFalse(Reflect.set(
      activityMapRuntime,
      "_root",
      (HashMap.empty() as unknown as { readonly _root: object })._root
    ))
    assert.isTrue(RunState.isDerived(second))

    const unpairedSignal = success(RunState.foldPrefix([
      runStarted(),
      signalAccepted(
        1,
        "freeze-pairing",
        0,
        time(100),
        time(1_100)
      )
    ]))
    assert.isDefined(unpairedSignal.pendingTimerPairing)
    assert.isTrue(Object.isFrozen(
      unpairedSignal.pendingTimerPairing!
    ))
  })

  it("retains reducer authority out of band without laundering structural copies", () => {
    const first = success(RunState.fold([runStarted()]))
    const second = success(RunState.reduce(
      first,
      scheduled(1, 1, policy())
    ))
    const forged = { ...first } as RunState.RunState
    const reducedFromForged = failure(RunState.reduce(
      forged,
      scheduled(1, 1, policy())
    ))

    assert.isTrue(RunState.isDerived(first))
    assert.isTrue(RunState.isDerived(second))
    assert.isFalse(RunState.isDerived(forged))
    assert.strictEqual(
      reducedFromForged.code,
      RunState.Codes.InvalidState
    )
    assert.strictEqual(
      failure(RunState.validateDurableHead(forged)).code,
      RunState.Codes.InvalidState
    )
    assert.isFalse(RunState.isDerived({
      ...first,
      isDerived: true
    }))
  })

  it("exposes HistoryError as a strict schema-backed typed error", () => {
    const error = failure(RunState.fold([]))
    assert.instanceOf(error, RunState.HistoryError)
    assert.strictEqual(error.code, RunState.Codes.EmptyHistory)
  })
})
