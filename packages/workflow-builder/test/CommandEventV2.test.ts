import { assert, describe, it } from "@effect/vitest"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import type * as Command from "../src/CommandV2.ts"
import type * as Event from "../src/EventV2.ts"
import * as Identity from "../src/IdentityV2.ts"
import * as CommandEvent from "../src/internal/commandEventV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as RunState from "../src/RunStateV2.ts"

const tenantId = "tenant-1"
const runId = "run-1"
const epoch = Date.parse("2026-07-23T00:00:00.000Z")
const time = (millis: number): Event.Timestamp => new Date(epoch + millis).toISOString()

const compiledFingerprint = Schema.decodeUnknownSync(
  ProtocolV2Wire.CompiledFingerprint
)(`sha256:${"a".repeat(64)}`)
const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.ArtifactDigest
)(`sha256:${"b".repeat(64)}`)
const signalDefinitionDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.DefinitionDigest
)(`sha256:${"c".repeat(64)}`)
const requestDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.RequestDigest
)(`sha256:${"d".repeat(64)}`)
const payloadDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.PayloadDigest
)(`sha256:${"e".repeat(64)}`)

interface PolicyOptions {
  readonly maximumAttempts?: number
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
      encodedFailure: true,
      scheduleToStartTimeout: true,
      startToCloseTimeout: true
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

const event = (
  sequence: number,
  eventId: string,
  payload: Event.Payload,
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
  recordedAt: Event.Timestamp = time(0)
): Event.Event =>
  event(
    0,
    Identity.runStartedEventId(tenantId, runId),
    {
      _tag: "RunStarted",
      executionProtocolVersion: 2,
      artifactVersion: 2,
      artifactDigest,
      workflowIdentity: "workflow:run-1",
      startRequestId: "start-request-1",
      planId: "plan-1",
      planRevision: 1,
      definitionId: "workflow-1",
      definitionVersion: "1.0.0",
      compilerVersion: "4.0.0",
      compiledFingerprint,
      backend: "durable",
      input: { orderId: "order-1" }
    },
    recordedAt
  )

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result))
  return result.success
}

const failure = <A>(
  result: Result.Result<A, CommandEvent.CommandEventError>
): CommandEvent.CommandEventError => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

const replay = (
  events: ReadonlyArray<Event.Event>
): RunState.RunState => success(RunState.foldPrefix(events))

const command = (
  commandId: string,
  payload: Command.Payload,
  overrides: Partial<Pick<Command.Command, "tenantId" | "runId">> = {}
): Command.Command => ({
  commandVersion: 2,
  tenantId: overrides.tenantId ?? tenantId,
  runId: overrides.runId ?? runId,
  commandId,
  payload
})

const scheduleActivity = (
  nodeInstanceId: string,
  attempt: number,
  activityPolicy: ActivityPolicy.Policy,
  input: Command.EncodedValues = { orderId: "order-1" }
): Command.Command =>
  command(
    Identity.scheduleActivityCommandId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    ),
    {
      _tag: "ScheduleActivityAttempt",
      logicalActivityId: Identity.logicalActivityId(
        tenantId,
        runId,
        nodeInstanceId
      ),
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      nodeId: nodeInstanceId,
      nodeInstanceId,
      attempt,
      idempotencyKey: Identity.activityIdempotencyKey(
        tenantId,
        runId,
        nodeInstanceId
      ),
      input,
      policy: activityPolicy
    }
  )

const scheduleTimer = (
  timerId: string,
  purpose: Event.TimerPurpose,
  anchorEventId: string,
  delayMillis: number
): Command.Command =>
  command(
    Identity.scheduleTimerCommandId(tenantId, runId, timerId),
    {
      _tag: "ScheduleTimer",
      timerId,
      purpose,
      anchorEventId,
      delayMillis
    }
  )

const cancelTimer = (
  timerId: string,
  reason: Event.TimerCancellationReason
): Command.Command =>
  command(
    Identity.cancelTimerCommandId(tenantId, runId, timerId),
    { _tag: "CancelTimer", timerId, reason }
  )

const activityScheduledEvent = (
  sequence: number,
  nodeInstanceId: string,
  activityPolicy: ActivityPolicy.Policy,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => {
  const scheduled = scheduleActivity(nodeInstanceId, 1, activityPolicy)
  return event(
    sequence,
    scheduled.commandId,
    {
      ...(scheduled.payload as Command.ScheduleActivityAttempt),
      _tag: "ActivityScheduled"
    },
    recordedAt
  )
}

const attemptStartedEvent = (
  sequence: number,
  nodeInstanceId: string,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  event(
    sequence,
    Identity.activityAttemptStartedEventId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    ),
    {
      _tag: "ActivityAttemptStarted",
      logicalActivityId: Identity.logicalActivityId(
        tenantId,
        runId,
        nodeInstanceId
      ),
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      ),
      attempt: 1
    },
    recordedAt
  )

const attemptFailedEvent = (
  sequence: number,
  nodeInstanceId: string,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event =>
  event(
    sequence,
    Identity.activityAttemptFailedEventId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    ),
    {
      _tag: "ActivityAttemptFailed",
      logicalActivityId: Identity.logicalActivityId(
        tenantId,
        runId,
        nodeInstanceId
      ),
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      ),
      attempt: 1,
      failure: { _tag: "TemporaryFailure" }
    },
    recordedAt
  )

describe("CommandEventV2", () => {
  it("materializes activity scheduling and every enabled activity timer from committed anchors", () => {
    const activityPolicy = policy({
      scheduleToStart: { _tag: "After", durationMillis: 1_000 },
      startToClose: { _tag: "After", durationMillis: 2_000 },
      scheduleToClose: { _tag: "After", durationMillis: 3_000 }
    })
    const nodeInstanceId = "activity"
    const logicalActivityId = Identity.logicalActivityId(
      tenantId,
      runId,
      nodeInstanceId
    )
    const attemptId = Identity.activityAttemptId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    )
    const activityCommand = scheduleActivity(
      nodeInstanceId,
      1,
      activityPolicy,
      { order: { id: "order-1" } }
    )
    const scheduleToStartId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToStart",
      attemptId
    )
    const scheduleToCloseId = Identity.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      logicalActivityId
    )
    const input = [
      activityCommand,
      scheduleTimer(
        scheduleToStartId,
        {
          _tag: "ScheduleToStart",
          logicalActivityId,
          attemptId,
          attempt: 1
        },
        activityCommand.commandId,
        1_000
      ),
      scheduleTimer(
        scheduleToCloseId,
        { _tag: "ScheduleToClose", logicalActivityId },
        activityCommand.commandId,
        3_000
      )
    ]
    const first = success(CommandEvent.materialize(
      replay([runStarted()]),
      input,
      time(100)
    ))

    assert.deepStrictEqual(
      first.events.map((item) => item.payload._tag),
      ["ActivityScheduled", "TimerScheduled", "TimerScheduled"]
    )
    assert.deepStrictEqual(
      first.events.map((item) => item.sequence),
      [1, 2, 3]
    )
    assert.deepStrictEqual(
      first.events.map((item) => item.eventId),
      input.map((item) => item.commandId)
    )
    assert.deepStrictEqual(
      first.events.map((item) => item.recordedAt),
      [time(100), time(100), time(100)]
    )
    assert.strictEqual(
      (first.events[1]!.payload as Event.TimerScheduled).deadline,
      time(1_100)
    )
    assert.strictEqual(
      (first.events[2]!.payload as Event.TimerScheduled).deadline,
      time(3_100)
    )
    assert.isTrue(Object.isFrozen(first))
    assert.isTrue(Object.isFrozen(first.events))
    assert.isTrue(Object.isFrozen(first.events[0]!))
    assert.isTrue(Object.isFrozen(first.events[0]!.payload))
    assert.isTrue(Object.isFrozen(
      (first.events[0]!.payload as Event.ActivityScheduled).input.order
    ))
    assert.isTrue(RunState.isDerived(first.state))

    const started = attemptStartedEvent(4, nodeInstanceId, time(400))
    const startedState = success(RunState.reduce(first.state, started))
    const startToCloseId = Identity.timerId(
      tenantId,
      runId,
      "StartToClose",
      attemptId
    )
    const second = success(CommandEvent.materialize(
      startedState,
      [
        cancelTimer(scheduleToStartId, "OwnerCompleted"),
        scheduleTimer(
          startToCloseId,
          {
            _tag: "StartToClose",
            logicalActivityId,
            attemptId,
            attempt: 1
          },
          started.eventId,
          2_000
        )
      ],
      time(500)
    ))
    assert.deepStrictEqual(
      second.events.map((item) => item.payload._tag),
      ["TimerCancelled", "TimerScheduled"]
    )
    assert.strictEqual(
      (second.events[1]!.payload as Event.TimerScheduled).deadline,
      time(2_400)
    )
    assert.strictEqual(success(RunState.validateDurableHead(second.state)), second.state)

    assert.strictEqual(
      failure(CommandEvent.materialize(
        replay([runStarted()]),
        [activityCommand],
        time(100)
      )).code,
      CommandEvent.Codes.IncompleteBatch
    )

    const nested = (activityCommand.payload as Command.ScheduleActivityAttempt).input
      .order as { id: string }
    nested.id = "mutated"
    input.pop()
    assert.deepStrictEqual(
      (first.events[0]!.payload as Event.ActivityScheduled).input,
      { order: { id: "order-1" } }
    )
    assert.strictEqual(first.events.length, 3)
  })

  it("materializes a retry and its exact backoff timer from the failed-attempt timestamp", () => {
    const nodeInstanceId = "retrying"
    const activityPolicy = policy({ delayMillis: 1_250 })
    const scheduled = activityScheduledEvent(1, nodeInstanceId, activityPolicy)
    const started = attemptStartedEvent(2, nodeInstanceId)
    const failed = attemptFailedEvent(3, nodeInstanceId)
    const state = replay([runStarted(), scheduled, started, failed])
    const logicalActivityId = Identity.logicalActivityId(
      tenantId,
      runId,
      nodeInstanceId
    )
    const retryId = Identity.retryId(
      tenantId,
      runId,
      nodeInstanceId,
      2
    )
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "RetryBackoff",
      retryId
    )
    const retry = command(
      Identity.scheduleRetryCommandId(
        tenantId,
        runId,
        nodeInstanceId,
        2
      ),
      {
        _tag: "ScheduleRetry",
        retryId,
        logicalActivityId,
        failedAttemptId: Identity.activityAttemptId(
          tenantId,
          runId,
          nodeInstanceId,
          1
        ),
        failedAttempt: 1,
        nextAttempt: 2,
        anchorEventId: failed.eventId,
        timerId,
        selectedDelayMillis: 1_250
      }
    )
    const materialized = success(CommandEvent.materialize(
      state,
      [
        retry,
        scheduleTimer(
          timerId,
          {
            _tag: "RetryBackoff",
            retryId,
            logicalActivityId,
            nextAttempt: 2
          },
          failed.eventId,
          1_250
        )
      ],
      time(500)
    ))

    assert.deepStrictEqual(
      materialized.events.map((item) => item.payload._tag),
      ["RetryScheduled", "TimerScheduled"]
    )
    for (const materializedEvent of materialized.events) {
      const payload = materializedEvent.payload as
        | Event.RetryScheduled
        | Event.TimerScheduled
      assert.strictEqual(payload.deadline, time(1_550))
    }
    const retained = HashMap.get(materialized.state.retries, retryId)
    assert.strictEqual(retained._tag, "Some")
    if (retained._tag === "Some") {
      assert.strictEqual(retained.value.status, "WaitingForTimer")
      assert.strictEqual(retained.value.deadline, time(1_550))
    }
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [retry],
        time(500)
      )).code,
      CommandEvent.Codes.IncompleteBatch
    )
  })

  it("requires immediate and complete sleep and signal-wait timer pairs", () => {
    const state = replay([runStarted()])
    const sleepInstanceId = "sleep"
    const sleepWaitId = Identity.sleepWaitId(
      tenantId,
      runId,
      sleepInstanceId
    )
    const sleepCommand = command(
      Identity.startSleepCommandId(tenantId, runId, sleepInstanceId),
      {
        _tag: "StartSleep",
        waitId: sleepWaitId,
        nodeId: sleepInstanceId,
        nodeInstanceId: sleepInstanceId,
        durationMillis: 2_000
      }
    )
    const sleepTimerId = Identity.timerId(
      tenantId,
      runId,
      "Sleep",
      sleepWaitId
    )
    const waitInstanceId = "approval"
    const waitId = Identity.signalWaitId(
      tenantId,
      runId,
      waitInstanceId
    )
    const waitCommand = command(
      Identity.startSignalWaitCommandId(
        tenantId,
        runId,
        waitInstanceId
      ),
      {
        _tag: "StartSignalWait",
        waitId,
        nodeId: waitInstanceId,
        nodeInstanceId: waitInstanceId,
        signalName: "ApprovalGranted",
        signalVersion: "1.0.0",
        correlation: { _tag: "Exact", key: "order-1" },
        timeout: { _tag: "After", durationMillis: 5_000 }
      }
    )
    const waitTimerId = Identity.timerId(
      tenantId,
      runId,
      "SignalWaitTimeout",
      waitId
    )
    const batch = [
      sleepCommand,
      scheduleTimer(
        sleepTimerId,
        {
          _tag: "Sleep",
          waitId: sleepWaitId,
          nodeInstanceId: sleepInstanceId
        },
        sleepCommand.commandId,
        2_000
      ),
      waitCommand,
      scheduleTimer(
        waitTimerId,
        {
          _tag: "SignalWaitTimeout",
          waitId,
          nodeInstanceId: waitInstanceId
        },
        waitCommand.commandId,
        5_000
      )
    ]
    const complete = success(CommandEvent.materialize(
      state,
      batch,
      time(100)
    ))
    assert.deepStrictEqual(
      complete.events.map((item) => item.payload._tag),
      ["SleepStarted", "TimerScheduled", "SignalWaitStarted", "TimerScheduled"]
    )

    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [sleepCommand],
        time(100)
      )).code,
      CommandEvent.Codes.IncompleteBatch
    )
    const interrupted = failure(CommandEvent.materialize(
      state,
      [sleepCommand, waitCommand],
      time(100)
    ))
    assert.strictEqual(interrupted.code, CommandEvent.Codes.IncompleteBatch)
    assert.strictEqual(interrupted.commandIndex, 1)
  })

  it("consumes a signal, cleans up both timers, and commits successful termination", () => {
    const signalId = "signal-1"
    const acceptedAt = time(100)
    const ttlMillis = 10_000
    const expiryTimerId = Identity.timerId(
      tenantId,
      runId,
      "SignalExpiry",
      signalId
    )
    const accepted = event(
      1,
      Identity.signalAcceptedEventId(tenantId, runId, signalId),
      {
        _tag: "SignalAccepted",
        signalId,
        inboxSequence: 0,
        signalName: "ApprovalGranted",
        signalVersion: "1.0.0",
        correlation: { _tag: "Exact", key: "order-1" },
        signalDefinitionDigest,
        requestDigest,
        payload: { _tag: "Inline", value: { approved: true } },
        payloadDigest,
        encodedPayloadBytes: 17,
        ttlMillis,
        admission: {
          actorId: "reviewer-1",
          policyId: "approval",
          policyVersion: "1",
          policyDecisionId: "decision-1"
        },
        expiresAt: time(10_100),
        expiryTimerId
      },
      acceptedAt
    )
    const expiryTimer = event(
      2,
      Identity.scheduleTimerCommandId(tenantId, runId, expiryTimerId),
      {
        _tag: "TimerScheduled",
        timerId: expiryTimerId,
        purpose: { _tag: "SignalExpiry", signalId, inboxSequence: 0 },
        anchorEventId: accepted.eventId,
        delayMillis: ttlMillis,
        deadline: time(10_100)
      }
    )
    const waitInstanceId = "approval"
    const waitId = Identity.signalWaitId(
      tenantId,
      runId,
      waitInstanceId
    )
    const waitStarted = event(
      3,
      Identity.startSignalWaitCommandId(
        tenantId,
        runId,
        waitInstanceId
      ),
      {
        _tag: "SignalWaitStarted",
        waitId,
        nodeId: waitInstanceId,
        nodeInstanceId: waitInstanceId,
        signalName: "ApprovalGranted",
        signalVersion: "1.0.0",
        correlation: { _tag: "Exact", key: "order-1" },
        timeout: { _tag: "After", durationMillis: 5_000 }
      }
    )
    const waitTimerId = Identity.timerId(
      tenantId,
      runId,
      "SignalWaitTimeout",
      waitId
    )
    const waitTimer = event(
      4,
      Identity.scheduleTimerCommandId(tenantId, runId, waitTimerId),
      {
        _tag: "TimerScheduled",
        timerId: waitTimerId,
        purpose: {
          _tag: "SignalWaitTimeout",
          waitId,
          nodeInstanceId: waitInstanceId
        },
        anchorEventId: waitStarted.eventId,
        delayMillis: 5_000,
        deadline: time(5_300)
      }
    )
    const state = success(RunState.fold([
      runStarted(),
      accepted,
      expiryTimer,
      waitStarted,
      waitTimer
    ]))
    const consumed = command(
      Identity.consumeSignalCommandId(
        tenantId,
        runId,
        waitId,
        signalId
      ),
      {
        _tag: "ConsumeSignal",
        signalId,
        inboxSequence: 0,
        waitId,
        nodeId: waitInstanceId,
        nodeInstanceId: waitInstanceId
      }
    )
    const succeeded = command(
      Identity.succeedRunCommandId(tenantId, runId),
      { _tag: "SucceedRun", output: { approved: true } }
    )
    const materialized = success(CommandEvent.materialize(
      state,
      [
        consumed,
        cancelTimer(expiryTimerId, "SignalConsumed"),
        cancelTimer(waitTimerId, "SignalConsumed"),
        succeeded
      ],
      time(500)
    ))

    assert.deepStrictEqual(
      materialized.events.map((item) => item.payload._tag),
      ["SignalConsumed", "TimerCancelled", "TimerCancelled", "RunSucceeded"]
    )
    assert.strictEqual(materialized.state.status, "Succeeded")
    assert.strictEqual(materialized.events[3]!.eventId, succeeded.commandId)
  })

  it("materializes final activity failure and attributed failed-run termination", () => {
    const nodeInstanceId = "permanent-failure"
    const activityPolicy = policy({ maximumAttempts: 1 })
    const scheduled = activityScheduledEvent(1, nodeInstanceId, activityPolicy)
    const started = attemptStartedEvent(2, nodeInstanceId)
    const failed = attemptFailedEvent(3, nodeInstanceId)
    const state = replay([runStarted(), scheduled, started, failed])
    const logicalActivityId = Identity.logicalActivityId(
      tenantId,
      runId,
      nodeInstanceId
    )
    const attemptId = Identity.activityAttemptId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    )
    const cause: Event.ActivityFailureCause = {
      _tag: "EncodedFailure",
      failure: { _tag: "TemporaryFailure" }
    }
    const finalize = command(
      Identity.finalizeActivityFailureCommandId(
        tenantId,
        runId,
        nodeInstanceId
      ),
      {
        _tag: "FinalizeActivityFailure",
        logicalActivityId,
        nodeId: nodeInstanceId,
        nodeInstanceId,
        attemptId,
        attempt: 1,
        cause
      }
    )
    const failRun = command(
      Identity.failRunCommandId(tenantId, runId),
      {
        _tag: "FailRun",
        cause: {
          _tag: "ActivityFailure",
          logicalActivityId,
          nodeId: nodeInstanceId,
          nodeInstanceId,
          attemptId,
          attempt: 1,
          cause
        }
      }
    )
    const materialized = success(CommandEvent.materialize(
      state,
      [finalize, failRun],
      time(500)
    ))

    assert.deepStrictEqual(
      materialized.events.map((item) => item.payload._tag),
      ["ActivityFailed", "RunFailed"]
    )
    assert.strictEqual(materialized.state.status, "Failed")
  })

  it("requires complete cancellation cleanup before cancelled termination", () => {
    const sleepInstanceId = "cancelled-sleep"
    const waitId = Identity.sleepWaitId(
      tenantId,
      runId,
      sleepInstanceId
    )
    const started = event(
      1,
      Identity.startSleepCommandId(tenantId, runId, sleepInstanceId),
      {
        _tag: "SleepStarted",
        waitId,
        nodeId: sleepInstanceId,
        nodeInstanceId: sleepInstanceId,
        durationMillis: 5_000
      }
    )
    const timerId = Identity.timerId(
      tenantId,
      runId,
      "Sleep",
      waitId
    )
    const timer = event(
      2,
      Identity.scheduleTimerCommandId(tenantId, runId, timerId),
      {
        _tag: "TimerScheduled",
        timerId,
        purpose: {
          _tag: "Sleep",
          waitId,
          nodeInstanceId: sleepInstanceId
        },
        anchorEventId: started.eventId,
        delayMillis: 5_000,
        deadline: time(5_100)
      }
    )
    const running = success(RunState.fold([runStarted(), started, timer]))
    const requested = success(RunState.reduce(
      running,
      event(
        3,
        Identity.runCancellationRequestedEventId(
          tenantId,
          runId,
          "cancel-request-1"
        ),
        {
          _tag: "RunCancellationRequested",
          requestId: "cancel-request-1"
        }
      )
    ))
    const cancelRun = command(
      Identity.cancelRunCommandId(tenantId, runId),
      { _tag: "CancelRun" }
    )

    const incomplete = failure(CommandEvent.materialize(
      requested,
      [cancelRun],
      time(400)
    ))
    assert.strictEqual(
      incomplete.code,
      CommandEvent.Codes.CancellationIncoherent
    )

    const complete = success(CommandEvent.materialize(
      requested,
      [
        cancelTimer(timerId, "RunCancellationRequested"),
        cancelRun
      ],
      time(400)
    ))
    assert.deepStrictEqual(
      complete.events.map((item) => item.payload._tag),
      ["TimerCancelled", "RunCancelled"]
    )
    assert.strictEqual(complete.state.status, "Cancelled")

    const wrongWork = failure(CommandEvent.materialize(
      requested,
      [
        command(
          Identity.succeedRunCommandId(tenantId, runId),
          { _tag: "SucceedRun", output: {} }
        )
      ],
      time(400)
    ))
    assert.strictEqual(
      wrongWork.code,
      CommandEvent.Codes.CancellationIncoherent
    )
  })

  it("rejects hostile, non-derived, external-fact, duplicate, and tampered inputs", () => {
    const state = replay([runStarted()])
    let invoked = 0
    const hostileCommand = {
      commandVersion: 2,
      tenantId,
      runId,
      commandId: "hostile",
      get payload(): Command.Payload {
        invoked++
        throw new Error("must not run")
      }
    }
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [hostileCommand],
        time(100)
      )).code,
      CommandEvent.Codes.InvalidCommandBatch
    )
    assert.strictEqual(invoked, 0)

    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error("must be contained")
      }
    })
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        proxy,
        time(100)
      )).code,
      CommandEvent.Codes.InvalidCommandBatch
    )

    const stateLike = Object.defineProperty(
      {},
      "lastRecordedAt",
      {
        get() {
          invoked++
          throw new Error("must not run")
        }
      }
    ) as RunState.RunState
    assert.strictEqual(
      failure(CommandEvent.materialize(
        stateLike,
        [],
        time(100)
      )).code,
      CommandEvent.Codes.InvalidRunState
    )
    assert.strictEqual(invoked, 0)

    for (
      const payload of [
        {
          _tag: "ActivityAttemptStarted",
          logicalActivityId: "activity-1",
          attemptId: "attempt-1",
          attempt: 1
        },
        {
          _tag: "ActivitySucceeded",
          logicalActivityId: "activity-1",
          attemptId: "attempt-1",
          attempt: 1,
          output: {}
        },
        { _tag: "TimerFired", timerId: "timer-1" },
        { _tag: "SignalAccepted", signalId: "signal-1" },
        {
          _tag: "RunCancellationRequested",
          requestId: "cancel-request-1"
        }
      ]
    ) {
      assert.strictEqual(
        failure(CommandEvent.materialize(
          state,
          [{
            commandVersion: 2,
            tenantId,
            runId,
            commandId: "external",
            payload
          }],
          time(100)
        )).code,
        CommandEvent.Codes.InvalidCommandBatch
      )
    }

    const terminal = command(
      Identity.succeedRunCommandId(tenantId, runId),
      { _tag: "SucceedRun", output: {} }
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [terminal, terminal],
        time(100)
      )).code,
      CommandEvent.Codes.DuplicateCommandId
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        Array.from({ length: 1_025 }, () => terminal),
        time(100)
      )).code,
      CommandEvent.Codes.InvalidCommandBatch
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [{ ...terminal, commandId: "tampered" }],
        time(100)
      )).code,
      CommandEvent.Codes.NonCanonicalCommandId
    )

    const semanticTamper = scheduleActivity(
      "activity",
      1,
      policy()
    )
    const malformedPayload = semanticTamper.payload as Command.ScheduleActivityAttempt
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [{
          ...semanticTamper,
          payload: {
            ...malformedPayload,
            logicalActivityId: "tampered"
          }
        }],
        time(100)
      )).code,
      CommandEvent.Codes.HistoryRejected
    )
  })

  it("rejects tenant/run mismatches, unsafe clocks, missing anchors, and deadline overflow", () => {
    const state = replay([runStarted()])
    const succeeded = command(
      Identity.succeedRunCommandId(tenantId, runId),
      { _tag: "SucceedRun", output: {} }
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [{ ...succeeded, tenantId: "tenant-2" }],
        time(100)
      )).code,
      CommandEvent.Codes.TenantIdMismatch
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [{ ...succeeded, runId: "run-2" }],
        time(100)
      )).code,
      CommandEvent.Codes.RunIdMismatch
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [],
        time(100)
      )).code,
      CommandEvent.Codes.EmptyCommandBatch
    )
    let recordedAtInvoked = 0
    const hostileRecordedAt = Object.defineProperty(
      {},
      "timestamp",
      {
        enumerable: true,
        get() {
          recordedAtInvoked++
          throw new Error("must not run")
        }
      }
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [succeeded],
        hostileRecordedAt
      )).code,
      CommandEvent.Codes.InvalidRecordedAt
    )
    assert.strictEqual(recordedAtInvoked, 0)
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [succeeded],
        "2026-07-23T00:00:00Z"
      )).code,
      CommandEvent.Codes.InvalidRecordedAt
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [succeeded],
        "2026-07-22T23:59:59.999Z"
      )).code,
      CommandEvent.Codes.TimestampRegression
    )

    const missingTimerId = Identity.timerId(
      tenantId,
      runId,
      "Sleep",
      "missing"
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        state,
        [
          scheduleTimer(
            missingTimerId,
            {
              _tag: "Sleep",
              waitId: "missing",
              nodeInstanceId: "missing"
            },
            "missing-anchor",
            1
          )
        ],
        time(100)
      )).code,
      CommandEvent.Codes.AnchorNotFound
    )

    const maximum = "9999-12-31T23:59:59.999Z" as Event.Timestamp
    const maximumState = replay([runStarted(maximum)])
    const waitId = Identity.sleepWaitId(tenantId, runId, "overflow")
    const sleep = command(
      Identity.startSleepCommandId(tenantId, runId, "overflow"),
      {
        _tag: "StartSleep",
        waitId,
        nodeId: "overflow",
        nodeInstanceId: "overflow",
        durationMillis: 1
      }
    )
    const overflowTimerId = Identity.timerId(
      tenantId,
      runId,
      "Sleep",
      waitId
    )
    assert.strictEqual(
      failure(CommandEvent.materialize(
        maximumState,
        [
          sleep,
          scheduleTimer(
            overflowTimerId,
            {
              _tag: "Sleep",
              waitId,
              nodeInstanceId: "overflow"
            },
            sleep.commandId,
            1
          )
        ],
        maximum
      )).code,
      CommandEvent.Codes.DeadlineOutOfRange
    )
  })
})
