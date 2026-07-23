import { assert, describe, it } from "@effect/vitest"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import type * as CommandV2 from "../src/CommandV2.ts"
import type * as EventV2 from "../src/EventV2.ts"
import * as ExternalEventV2 from "../src/ExternalEventV2.ts"
import * as IdentityV2 from "../src/IdentityV2.ts"
import * as CommandEventV2 from "../src/internal/commandEventV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as RunStateV2 from "../src/RunStateV2.ts"

const tenantId = "tenant-1"
const runId = "run-1"
const key = { tenantId, runId }
const epoch = Date.parse("2026-07-23T00:00:00.000Z")
const time = (millis: number): EventV2.Timestamp => new Date(epoch + millis).toISOString()

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
  state: RunStateV2.RunState | undefined,
  eventId: string,
  payload: EventV2.Payload,
  recordedAt: EventV2.Timestamp
): EventV2.Event => ({
  eventVersion: 2,
  tenantId,
  eventId,
  runId,
  sequence: state === undefined ? 0 : state.sequence + 1,
  recordedAt,
  payload
})

const runStarted = (): EventV2.Event =>
  event(
    undefined,
    IdentityV2.runStartedEventId(tenantId, runId),
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
    time(0)
  )

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(
    Result.isSuccess(result),
    Result.isFailure(result) ? JSON.stringify(result.failure) : undefined
  )
  return result.success
}

const failure = <A>(
  result: Result.Result<A, ExternalEventV2.ExternalEventError>
): ExternalEventV2.ExternalEventError => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

const initialState = (): RunStateV2.RunState => success(RunStateV2.fold([runStarted()]))

const command = (
  commandId: string,
  payload: CommandV2.Payload
): CommandV2.Command => ({
  commandVersion: 2,
  tenantId,
  runId,
  commandId,
  payload
})

interface ScheduledFixture {
  readonly state: RunStateV2.RunState
  readonly activityPolicy: ActivityPolicy.Policy
  readonly nodeInstanceId: string
  readonly logicalActivityId: string
  readonly attemptId: string
  readonly scheduleEventId: string
}

const scheduleActivity = (
  activityPolicy: ActivityPolicy.Policy,
  nodeInstanceId = "activity",
  recordedAt: EventV2.Timestamp = time(100)
): ScheduledFixture => {
  const logicalActivityId = IdentityV2.logicalActivityId(
    tenantId,
    runId,
    nodeInstanceId
  )
  const attemptId = IdentityV2.activityAttemptId(
    tenantId,
    runId,
    nodeInstanceId,
    1
  )
  const scheduleEventId = IdentityV2.scheduleActivityCommandId(
    tenantId,
    runId,
    nodeInstanceId,
    1
  )
  const commands: Array<CommandV2.Command> = [
    command(scheduleEventId, {
      _tag: "ScheduleActivityAttempt",
      logicalActivityId,
      attemptId,
      nodeId: nodeInstanceId,
      nodeInstanceId,
      attempt: 1,
      idempotencyKey: IdentityV2.activityIdempotencyKey(
        tenantId,
        runId,
        nodeInstanceId
      ),
      input: { orderId: "order-1" },
      policy: activityPolicy
    })
  ]
  if (activityPolicy.timeouts.scheduleToStart._tag === "After") {
    const timerId = IdentityV2.timerId(
      tenantId,
      runId,
      "ScheduleToStart",
      attemptId
    )
    commands.push(command(
      IdentityV2.scheduleTimerCommandId(tenantId, runId, timerId),
      {
        _tag: "ScheduleTimer",
        timerId,
        purpose: {
          _tag: "ScheduleToStart",
          logicalActivityId,
          attemptId,
          attempt: 1
        },
        anchorEventId: scheduleEventId,
        delayMillis: activityPolicy.timeouts.scheduleToStart.durationMillis
      }
    ))
  }
  if (activityPolicy.timeouts.scheduleToClose._tag === "After") {
    const timerId = IdentityV2.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      logicalActivityId
    )
    commands.push(command(
      IdentityV2.scheduleTimerCommandId(tenantId, runId, timerId),
      {
        _tag: "ScheduleTimer",
        timerId,
        purpose: {
          _tag: "ScheduleToClose",
          logicalActivityId
        },
        anchorEventId: scheduleEventId,
        delayMillis: activityPolicy.timeouts.scheduleToClose.durationMillis
      }
    ))
  }
  const materialized = success(CommandEventV2.materialize(
    initialState(),
    commands,
    recordedAt
  ))
  return {
    state: materialized.state,
    activityPolicy,
    nodeInstanceId,
    logicalActivityId,
    attemptId,
    scheduleEventId
  }
}

const attemptRequest = (
  fixture: ScheduledFixture
): ExternalEventV2.RecordActivityStartedRequest => ({
  key,
  logicalActivityId: fixture.logicalActivityId,
  attemptId: fixture.attemptId,
  attempt: 1
})

const startActivity = (
  fixture: ScheduledFixture,
  recordedAt: EventV2.Timestamp = time(200)
): ExternalEventV2.MaterializedExternalEvents =>
  success(ExternalEventV2.recordActivityStarted(
    fixture.state,
    attemptRequest(fixture),
    recordedAt
  ))

const timerState = (
  state: RunStateV2.RunState,
  timerId: string
): RunStateV2.TimerState => HashMap.getUnsafe(state.timers, timerId)

const activityState = (
  state: RunStateV2.RunState,
  logicalActivityId: string
): RunStateV2.ActivityState => HashMap.getUnsafe(state.activities, logicalActivityId)

const acceptSignal = (
  initial: RunStateV2.RunState,
  signalId = "signal-1",
  recordedAt: EventV2.Timestamp = time(150)
): RunStateV2.RunState => {
  const acceptedEventId = IdentityV2.signalAcceptedEventId(
    tenantId,
    runId,
    signalId
  )
  const expiryTimerId = IdentityV2.timerId(
    tenantId,
    runId,
    "SignalExpiry",
    signalId
  )
  const ttlMillis = 10_000
  const accepted = event(
    initial,
    acceptedEventId,
    {
      _tag: "SignalAccepted",
      signalId,
      inboxSequence: initial.nextInboxSequence,
      signalName: "ApprovalGranted",
      signalVersion: "1.0.0",
      correlation: { _tag: "Exact", key: "order-1" },
      signalDefinitionDigest,
      requestDigest,
      payload: {
        _tag: "Inline",
        value: { approved: true }
      },
      payloadDigest,
      encodedPayloadBytes: 17,
      ttlMillis,
      admission: {
        actorId: "reviewer-1",
        policyId: "approval-policy",
        policyVersion: "1.0.0",
        policyDecisionId: "allow-1"
      },
      expiresAt: time(10_150),
      expiryTimerId
    },
    recordedAt
  )
  const afterAccepted = success(RunStateV2.reduce(initial, accepted))
  const scheduled = event(
    afterAccepted,
    IdentityV2.scheduleTimerCommandId(tenantId, runId, expiryTimerId),
    {
      _tag: "TimerScheduled",
      timerId: expiryTimerId,
      purpose: {
        _tag: "SignalExpiry",
        signalId,
        inboxSequence: initial.nextInboxSequence
      },
      anchorEventId: acceptedEventId,
      delayMillis: ttlMillis,
      deadline: time(10_150)
    },
    recordedAt
  )
  return success(RunStateV2.validateDurableHead(
    success(RunStateV2.reduce(afterAccepted, scheduled))
  ))
}

describe("ExternalEventV2", () => {
  it("starts an exact attempt, cleans queue timeout, and arms active timeout", () => {
    const fixture = scheduleActivity(policy({
      scheduleToStart: { _tag: "After", durationMillis: 1_000 },
      startToClose: { _tag: "After", durationMillis: 2_000 },
      scheduleToClose: { _tag: "After", durationMillis: 5_000 }
    }))
    const materialized = startActivity(fixture)

    assert.deepStrictEqual(
      materialized.events.map((item) => item.payload._tag),
      ["ActivityAttemptStarted", "TimerCancelled", "TimerScheduled"]
    )
    assert.deepStrictEqual(
      materialized.events.map((item) => item.sequence),
      [
        fixture.state.sequence + 1,
        fixture.state.sequence + 2,
        fixture.state.sequence + 3
      ]
    )
    const scheduleToStartId = IdentityV2.timerId(
      tenantId,
      runId,
      "ScheduleToStart",
      fixture.attemptId
    )
    const startToCloseId = IdentityV2.timerId(
      tenantId,
      runId,
      "StartToClose",
      fixture.attemptId
    )
    assert.strictEqual(
      timerState(materialized.state, scheduleToStartId).status,
      "Cancelled"
    )
    assert.strictEqual(
      timerState(materialized.state, startToCloseId).deadline,
      time(2_200)
    )
    assert.strictEqual(
      timerState(materialized.state, startToCloseId).anchorEventId,
      materialized.events[0]!.eventId
    )
    assert.isTrue(Object.isFrozen(materialized))
    assert.isTrue(Object.isFrozen(materialized.events))
    assert.isTrue(Object.isFrozen(materialized.events[0]!))
    assert.isTrue(Object.isFrozen(materialized.events[0]!.payload))
    assert.isTrue(RunStateV2.isDerived(materialized.state))

    const disabled = scheduleActivity(policy(), "disabled")
    const disabledStart = startActivity(disabled)
    assert.deepStrictEqual(
      disabledStart.events.map((item) => item.payload._tag),
      ["ActivityAttemptStarted"]
    )
    assert.strictEqual(
      success(RunStateV2.validateDurableHead(disabledStart.state)),
      disabledStart.state
    )
  })

  it("completes success or failure and applies exact active timer cleanup", () => {
    const activityPolicy = policy({
      startToClose: { _tag: "After", durationMillis: 2_000 },
      scheduleToClose: { _tag: "After", durationMillis: 5_000 }
    })
    const fixture = scheduleActivity(activityPolicy)
    const started = startActivity(fixture)
    const output = { invoice: { id: "invoice-1" } }
    const succeeded = success(ExternalEventV2.completeActivityAttempt(
      started.state,
      {
        ...attemptRequest(fixture),
        completion: {
          _tag: "Succeeded",
          output
        }
      },
      time(300)
    ))

    assert.deepStrictEqual(
      succeeded.events.map((item) => item.payload._tag),
      ["ActivitySucceeded", "TimerCancelled", "TimerCancelled"]
    )
    assert.deepStrictEqual(
      succeeded.events.slice(1).map((item) =>
        item.payload._tag === "TimerCancelled"
          ? item.payload.reason
          : undefined
      ),
      ["OwnerCompleted", "OwnerCompleted"]
    )
    assert.strictEqual(
      activityState(succeeded.state, fixture.logicalActivityId).status,
      "Succeeded"
    )
    output.invoice.id = "mutated"
    const successPayload = succeeded.events[0]!.payload
    assert.strictEqual(successPayload._tag, "ActivitySucceeded")
    if (successPayload._tag === "ActivitySucceeded") {
      assert.deepStrictEqual(successPayload.output, {
        invoice: { id: "invoice-1" }
      })
    }

    const failedFixture = scheduleActivity(activityPolicy, "failed")
    const failedStarted = startActivity(failedFixture)
    const failed = success(ExternalEventV2.completeActivityAttempt(
      failedStarted.state,
      {
        ...attemptRequest(failedFixture),
        completion: {
          _tag: "Failed",
          failure: { code: "temporary" }
        }
      },
      time(300)
    ))
    assert.deepStrictEqual(
      failed.events.map((item) => item.payload._tag),
      ["ActivityAttemptFailed", "TimerCancelled"]
    )
    const cancellation = failed.events[1]!.payload
    assert.strictEqual(cancellation._tag, "TimerCancelled")
    if (cancellation._tag === "TimerCancelled") {
      assert.strictEqual(cancellation.reason, "OwnerFailed")
    }
    const totalTimerId = IdentityV2.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      failedFixture.logicalActivityId
    )
    assert.strictEqual(
      timerState(failed.state, totalTimerId).status,
      "Pending"
    )
  })

  it("makes completion-versus-timeout order authoritative and rejects early fire", () => {
    const fixture = scheduleActivity(policy({
      startToClose: { _tag: "After", durationMillis: 1_000 }
    }))
    const started = startActivity(fixture)
    const timerId = IdentityV2.timerId(
      tenantId,
      runId,
      "StartToClose",
      fixture.attemptId
    )
    const fireRequest: ExternalEventV2.FireTimerRequest = { key, timerId }
    assert.strictEqual(
      failure(ExternalEventV2.fireTimer(
        started.state,
        fireRequest,
        time(1_199)
      )).code,
      ExternalEventV2.Codes.TimerNotDue
    )

    const completionFirst = success(ExternalEventV2.completeActivityAttempt(
      started.state,
      {
        ...attemptRequest(fixture),
        completion: {
          _tag: "Succeeded",
          output: { ok: true }
        }
      },
      time(1_000)
    ))
    assert.strictEqual(
      failure(ExternalEventV2.fireTimer(
        completionFirst.state,
        fireRequest,
        time(1_200)
      )).code,
      ExternalEventV2.Codes.TimerNotPending
    )

    const timeoutFirst = success(ExternalEventV2.fireTimer(
      started.state,
      fireRequest,
      time(1_200)
    ))
    assert.deepStrictEqual(
      timeoutFirst.events.map((item) => item.payload._tag),
      ["TimerFired", "ActivityAttemptTimedOut"]
    )
    assert.strictEqual(
      failure(ExternalEventV2.completeActivityAttempt(
        timeoutFirst.state,
        {
          ...attemptRequest(fixture),
          completion: {
            _tag: "Succeeded",
            output: { ok: true }
          }
        },
        time(1_300)
      )).code,
      ExternalEventV2.Codes.IllegalActivityTransition
    )
  })

  it("fires non-activity timers without inventing an extra consequence", () => {
    const base = initialState()
    const nodeInstanceId = "sleep"
    const waitId = IdentityV2.sleepWaitId(tenantId, runId, nodeInstanceId)
    const timerId = IdentityV2.timerId(
      tenantId,
      runId,
      "Sleep",
      waitId
    )
    const sleepEventId = IdentityV2.startSleepCommandId(
      tenantId,
      runId,
      nodeInstanceId
    )
    const sleeping = success(CommandEventV2.materialize(
      base,
      [
        command(sleepEventId, {
          _tag: "StartSleep",
          waitId,
          nodeId: nodeInstanceId,
          nodeInstanceId,
          durationMillis: 1_000
        }),
        command(
          IdentityV2.scheduleTimerCommandId(tenantId, runId, timerId),
          {
            _tag: "ScheduleTimer",
            timerId,
            purpose: {
              _tag: "Sleep",
              waitId,
              nodeInstanceId
            },
            anchorEventId: sleepEventId,
            delayMillis: 1_000
          }
        )
      ],
      time(100)
    ))
    const fired = success(ExternalEventV2.fireTimer(
      sleeping.state,
      { key, timerId },
      time(1_100)
    ))

    assert.deepStrictEqual(
      fired.events.map((item) => item.payload._tag),
      ["TimerFired"]
    )
    assert.strictEqual(
      HashMap.getUnsafe(fired.state.sleeps, waitId).status,
      "Completed"
    )
  })

  it("makes schedule-to-close final during retry and cancels backoff", () => {
    const activityPolicy = policy({
      delayMillis: 10_000,
      scheduleToClose: { _tag: "After", durationMillis: 5_000 }
    })
    const fixture = scheduleActivity(activityPolicy, "retrying")
    const started = startActivity(fixture)
    const failed = success(ExternalEventV2.completeActivityAttempt(
      started.state,
      {
        ...attemptRequest(fixture),
        completion: {
          _tag: "Failed",
          failure: { code: "temporary" }
        }
      },
      time(300)
    ))
    const failedEventId = failed.events[0]!.eventId
    const retryId = IdentityV2.retryId(
      tenantId,
      runId,
      fixture.nodeInstanceId,
      2
    )
    const retryTimerId = IdentityV2.timerId(
      tenantId,
      runId,
      "RetryBackoff",
      retryId
    )
    const retrying = success(CommandEventV2.materialize(
      failed.state,
      [
        command(
          IdentityV2.scheduleRetryCommandId(
            tenantId,
            runId,
            fixture.nodeInstanceId,
            2
          ),
          {
            _tag: "ScheduleRetry",
            retryId,
            logicalActivityId: fixture.logicalActivityId,
            failedAttemptId: fixture.attemptId,
            failedAttempt: 1,
            nextAttempt: 2,
            anchorEventId: failedEventId,
            timerId: retryTimerId,
            selectedDelayMillis: 10_000
          }
        ),
        command(
          IdentityV2.scheduleTimerCommandId(
            tenantId,
            runId,
            retryTimerId
          ),
          {
            _tag: "ScheduleTimer",
            timerId: retryTimerId,
            purpose: {
              _tag: "RetryBackoff",
              retryId,
              logicalActivityId: fixture.logicalActivityId,
              nextAttempt: 2
            },
            anchorEventId: failedEventId,
            delayMillis: 10_000
          }
        )
      ],
      time(400)
    ))
    const scheduleToCloseId = IdentityV2.timerId(
      tenantId,
      runId,
      "ScheduleToClose",
      fixture.logicalActivityId
    )
    const timedOut = success(ExternalEventV2.fireTimer(
      retrying.state,
      { key, timerId: scheduleToCloseId },
      time(5_100)
    ))

    assert.deepStrictEqual(
      timedOut.events.map((item) => item.payload._tag),
      ["TimerFired", "ActivityFailed", "TimerCancelled"]
    )
    const cleanup = timedOut.events[2]!.payload
    assert.strictEqual(cleanup._tag, "TimerCancelled")
    if (cleanup._tag === "TimerCancelled") {
      assert.strictEqual(cleanup.timerId, retryTimerId)
      assert.strictEqual(cleanup.reason, "Superseded")
    }
    assert.strictEqual(
      activityState(timedOut.state, fixture.logicalActivityId).status,
      "Failed"
    )
    assert.strictEqual(
      timerState(timedOut.state, retryTimerId).status,
      "Cancelled"
    )
  })

  it("requests cancellation and deterministically cleans active timers and signals", () => {
    const fixture = scheduleActivity(policy({
      scheduleToStart: { _tag: "After", durationMillis: 2_000 },
      scheduleToClose: { _tag: "After", durationMillis: 5_000 }
    }))
    const state = acceptSignal(fixture.state)
    const expectedTimerIds = Array.from(HashMap.values(state.timers))
      .filter((timer) => timer.status === "Pending")
      .map((timer) => timer.timerId)
      .sort()
    const cancelled = success(ExternalEventV2.requestCancellation(
      state,
      { key, requestId: "cancel-request-1" },
      time(200)
    ))

    assert.strictEqual(cancelled.state.status, "CancellationRequested")
    assert.strictEqual(cancelled.events[0]!.payload._tag, "RunCancellationRequested")
    assert.isFalse(
      cancelled.events.some((item) => item.payload._tag === "RunCancelled")
    )
    const cleanupIds = cancelled.events.slice(1).map((item) => {
      assert.strictEqual(item.payload._tag, "TimerCancelled")
      return item.payload._tag === "TimerCancelled"
        ? item.payload.timerId
        : ""
    })
    assert.deepStrictEqual(cleanupIds, expectedTimerIds)
    assert.isTrue(
      Array.from(HashMap.values(cancelled.state.timers)).every(
        (timer) => timer.status === "Cancelled"
      )
    )
    assert.strictEqual(
      activityState(cancelled.state, fixture.logicalActivityId).status,
      "Active"
    )
    assert.strictEqual(
      HashMap.getUnsafe(cancelled.state.signals, "signal-1").status,
      "Discarded"
    )
    assert.strictEqual(cancelled.state.pendingSignalCount, 0)
    assert.strictEqual(cancelled.state.pendingSignalEncodedBytes, 0)
    assert.strictEqual(
      success(RunStateV2.validateDurableHead(cancelled.state)),
      cancelled.state
    )
  })

  it("rejects forged, incomplete, stale, and mismatched authority inputs", () => {
    const fixture = scheduleActivity(policy({
      scheduleToStart: { _tag: "After", durationMillis: 1_000 }
    }))
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        { ...fixture.state } as RunStateV2.RunState,
        attemptRequest(fixture),
        time(200)
      )).code,
      ExternalEventV2.Codes.InvalidRunState
    )
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        { ...attemptRequest(fixture), attemptId: "forged-attempt" },
        time(200)
      )).code,
      ExternalEventV2.Codes.AttemptMismatch
    )
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        {
          ...attemptRequest(fixture),
          key: { tenantId: "other-tenant", runId }
        },
        time(200)
      )).code,
      ExternalEventV2.Codes.RunKeyMismatch
    )
    const started = startActivity(fixture)
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        started.state,
        attemptRequest(fixture),
        time(300)
      )).code,
      ExternalEventV2.Codes.IllegalActivityTransition
    )

    const incompletePolicy = policy({
      scheduleToStart: { _tag: "After", durationMillis: 1_000 }
    })
    const incompleteNode = "incomplete"
    const incompleteLogicalId = IdentityV2.logicalActivityId(
      tenantId,
      runId,
      incompleteNode
    )
    const incompleteAttemptId = IdentityV2.activityAttemptId(
      tenantId,
      runId,
      incompleteNode,
      1
    )
    const base = initialState()
    const incomplete = success(RunStateV2.reduce(
      base,
      event(
        base,
        IdentityV2.scheduleActivityCommandId(
          tenantId,
          runId,
          incompleteNode,
          1
        ),
        {
          _tag: "ActivityScheduled",
          logicalActivityId: incompleteLogicalId,
          attemptId: incompleteAttemptId,
          nodeId: incompleteNode,
          nodeInstanceId: incompleteNode,
          attempt: 1,
          idempotencyKey: IdentityV2.activityIdempotencyKey(
            tenantId,
            runId,
            incompleteNode
          ),
          input: {},
          policy: incompletePolicy
        },
        time(100)
      )
    ))
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        incomplete,
        {
          key,
          logicalActivityId: incompleteLogicalId,
          attemptId: incompleteAttemptId,
          attempt: 1
        },
        time(200)
      )).code,
      ExternalEventV2.Codes.InvalidDurableHead
    )
  })

  it("fails closed on hostile requests and noncanonical or regressing timestamps", () => {
    const fixture = scheduleActivity(policy())
    let getterCalls = 0
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, "key", {
      enumerable: true,
      get() {
        getterCalls++
        throw new Error("must not run")
      }
    })
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        hostile,
        time(200)
      )).code,
      ExternalEventV2.Codes.InvalidRequest
    )
    assert.strictEqual(getterCalls, 0)
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        {
          ...attemptRequest(fixture),
          extra: true
        },
        time(200)
      )).code,
      ExternalEventV2.Codes.InvalidRequest
    )
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        attemptRequest(fixture),
        "2026-07-23T00:00:00Z"
      )).code,
      ExternalEventV2.Codes.InvalidRecordedAt
    )
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        attemptRequest(fixture),
        time(99)
      )).code,
      ExternalEventV2.Codes.TimestampRegression
    )
    let timestampGetterCalls = 0
    const hostileTimestamp = Object.create(null)
    Object.defineProperty(hostileTimestamp, "value", {
      enumerable: true,
      get() {
        timestampGetterCalls++
        throw new Error("must not run")
      }
    })
    assert.strictEqual(
      failure(ExternalEventV2.recordActivityStarted(
        fixture.state,
        attemptRequest(fixture),
        hostileTimestamp
      )).code,
      ExternalEventV2.Codes.InvalidRecordedAt
    )
    assert.strictEqual(timestampGetterCalls, 0)
  })
})
