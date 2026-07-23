import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as EventV1 from "../src/Event.ts"
import * as EventV2 from "../src/EventV2.ts"
import * as IdentityV2 from "../src/IdentityV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const timestamp = "2026-07-23T01:02:03.000Z"
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
const blobDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BlobDigest
)(`sha256:${"f".repeat(64)}`)

const policy = (): ActivityPolicy.Policy => ({
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
    backoff: { _tag: "Fixed", delayMillis: 1_000 },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: { _tag: "After", durationMillis: 5_000 },
    startToClose: { _tag: "After", durationMillis: 30_000 },
    scheduleToClose: { _tag: "After", durationMillis: 120_000 }
  }
})

const runStarted = (
  overrides: Partial<EventV2.RunStarted> = {}
): EventV2.RunStarted => ({
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
  input: { orderId: "order-1" },
  ...overrides
})

const activityScheduled = (
  overrides: Partial<EventV2.ActivityScheduled> = {}
): EventV2.ActivityScheduled => ({
  _tag: "ActivityScheduled",
  logicalActivityId: "logical-activity-1",
  attemptId: "attempt-1",
  nodeId: "validate",
  nodeInstanceId: "validate",
  attempt: 1,
  idempotencyKey: "external-operation-1",
  input: { order: { id: "order-1" } },
  policy: policy(),
  ...overrides
})

const activityFailureCause = (
  overrides: Partial<EventV2.EncodedFailureCause> = {}
): EventV2.EncodedFailureCause => ({
  _tag: "EncodedFailure",
  failure: { _tag: "InvalidOrder", reason: "missing id" },
  ...overrides
})

const activityFailed = (
  overrides: Partial<EventV2.ActivityFailed> = {}
): EventV2.ActivityFailed => ({
  _tag: "ActivityFailed",
  logicalActivityId: "logical-activity-1",
  nodeId: "validate",
  nodeInstanceId: "validate",
  attemptId: "attempt-1",
  attempt: 1,
  cause: activityFailureCause(),
  ...overrides
})

const sleepStarted = (
  overrides: Partial<EventV2.SleepStarted> = {}
): EventV2.SleepStarted => ({
  _tag: "SleepStarted",
  waitId: "sleep-wait-1",
  nodeId: "sleep",
  nodeInstanceId: "sleep",
  durationMillis: 1_000,
  ...overrides
})

const signalAccepted = (
  overrides: Partial<EventV2.SignalAccepted> = {}
): EventV2.SignalAccepted => {
  const value = { approvedBy: "reviewer-1" }
  return {
    _tag: "SignalAccepted",
    signalId: "signal-1",
    inboxSequence: 0,
    signalName: "ApprovalGranted",
    signalVersion: "1.0.0",
    correlation: { _tag: "Exact", key: "order-1" },
    signalDefinitionDigest,
    requestDigest,
    payload: { _tag: "Inline", value },
    payloadDigest,
    encodedPayloadBytes: JSON.stringify(value).length,
    ttlMillis: 60_000,
    admission: {
      actorId: "reviewer-1",
      policyId: "approval-signals",
      policyVersion: "1.0.0",
      policyDecisionId: "decision-1"
    },
    expiresAt: timestamp,
    expiryTimerId: "timer-signal-expiry-1",
    ...overrides
  }
}

const event = (
  sequence: number,
  payload: EventV2.Payload,
  overrides: Partial<EventV2.Event> = {}
): EventV2.Event => ({
  eventVersion: 2,
  tenantId: "tenant-1",
  eventId: `event-${sequence}`,
  runId: "run-1",
  sequence,
  recordedAt: timestamp,
  payload,
  ...overrides
})

const omit = (
  input: Readonly<Record<string, unknown>>,
  key: string
): Record<string, unknown> => {
  const output = { ...input }
  delete output[key]
  return output
}

describe("EventV2", () => {
  const decode = Schema.decodeUnknownSync(EventV2.Event)
  const encode = Schema.encodeSync(EventV2.Event)

  it("roundtrips every protocol version 2 payload tag", () => {
    const payloads: ReadonlyArray<EventV2.Payload> = [
      runStarted(),
      activityScheduled(),
      {
        _tag: "ActivityAttemptStarted",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-1",
        attempt: 1
      },
      {
        _tag: "ActivityAttemptFailed",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-1",
        attempt: 1,
        failure: { _tag: "TransientFailure" }
      },
      {
        _tag: "ActivityAttemptTimedOut",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-1",
        attempt: 1,
        timerId: "timer-start-to-close-1",
        timeoutKind: "StartToClose"
      },
      {
        _tag: "RetryScheduled",
        retryId: "retry-2",
        logicalActivityId: "logical-activity-1",
        failedAttemptId: "attempt-1",
        failedAttempt: 1,
        nextAttempt: 2,
        anchorEventId: "attempt-failed-1",
        timerId: "timer-retry-2",
        selectedDelayMillis: 1_000,
        deadline: timestamp
      },
      {
        _tag: "ActivitySucceeded",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-2",
        attempt: 2,
        output: { valid: true }
      },
      activityFailed(),
      {
        _tag: "TimerScheduled",
        timerId: "timer-retry-2",
        purpose: {
          _tag: "RetryBackoff",
          retryId: "retry-2",
          logicalActivityId: "logical-activity-1",
          nextAttempt: 2
        },
        anchorEventId: "retry-scheduled-2",
        delayMillis: 1_000,
        deadline: timestamp
      },
      { _tag: "TimerFired", timerId: "timer-retry-2" },
      {
        _tag: "TimerCancelled",
        timerId: "timer-retry-2",
        reason: "OwnerCompleted"
      },
      signalAccepted(),
      {
        _tag: "SignalWaitStarted",
        waitId: "wait-1",
        nodeId: "approval",
        nodeInstanceId: "approval",
        signalName: "ApprovalGranted",
        signalVersion: "1.0.0",
        correlation: { _tag: "Exact", key: "order-1" },
        timeout: { _tag: "After", durationMillis: 60_000 }
      },
      sleepStarted(),
      {
        _tag: "SignalConsumed",
        signalId: "signal-1",
        inboxSequence: 0,
        waitId: "wait-1",
        nodeId: "approval",
        nodeInstanceId: "approval"
      },
      { _tag: "RunCancellationRequested", requestId: "request-1" },
      { _tag: "RunSucceeded", output: { receipt: "receipt-1" } },
      {
        _tag: "RunFailed",
        cause: {
          _tag: "ActivityFailure",
          logicalActivityId: "logical-activity-1",
          nodeId: "validate",
          nodeInstanceId: "validate",
          attemptId: "attempt-1",
          attempt: 1,
          cause: activityFailureCause()
        }
      },
      { _tag: "RunCancelled" }
    ]

    for (let index = 0; index < payloads.length; index++) {
      const input = event(index, payloads[index]!, {
        causationId: "command-1",
        correlationId: "request-1"
      })
      assert.deepStrictEqual(encode(decode(input)), input)
    }
  })

  it("strictly validates the complete SleepStarted owner payload", () => {
    const valid = event(1, sleepStarted())
    assert.deepStrictEqual(decode(valid), valid)

    const payload = sleepStarted()
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, payload: omit(payload, "waitId") },
      { ...valid, payload: omit(payload, "nodeId") },
      { ...valid, payload: omit(payload, "nodeInstanceId") },
      { ...valid, payload: omit(payload, "durationMillis") },
      { ...valid, payload: { ...payload, waitId: "" } },
      { ...valid, payload: { ...payload, nodeId: "" } },
      { ...valid, payload: { ...payload, nodeInstanceId: "" } },
      { ...valid, payload: { ...payload, durationMillis: 0 } },
      { ...valid, payload: { ...payload, durationMillis: -1 } },
      { ...valid, payload: { ...payload, durationMillis: 1.5 } },
      {
        ...valid,
        payload: {
          ...payload,
          durationMillis: Number.MAX_SAFE_INTEGER + 1
        }
      },
      { ...valid, payload: { ...payload, unexpected: true } }
    ]
    for (const input of malformed) {
      assert.throws(() => decode(input))
    }

    const hostilePayload = Object.defineProperty(
      { ...payload },
      "durationMillis",
      {
        enumerable: true,
        get() {
          throw new Error("hostile sleep duration")
        }
      }
    )
    assert.throws(() => decode({ ...valid, payload: hostilePayload }))
  })

  it("strictly retains portable signal integrity and authorization facts", () => {
    const valid = event(1, signalAccepted())
    assert.deepStrictEqual(decode(valid), valid)

    const scalar = event(
      1,
      signalAccepted({
        payload: { _tag: "Inline", value: "approved" },
        encodedPayloadBytes: JSON.stringify("approved").length
      })
    )
    assert.deepStrictEqual(decode(scalar), scalar)

    const blob = event(
      1,
      signalAccepted({
        payload: {
          _tag: "Blob",
          ref: {
            blobVersion: 1,
            digest: blobDigest,
            encodedBytes: 8_192,
            mediaType: "application/json"
          }
        },
        encodedPayloadBytes: 8_192
      })
    )
    assert.deepStrictEqual(decode(blob), blob)

    const payload = signalAccepted()
    for (
      const field of [
        "signalDefinitionDigest",
        "requestDigest",
        "payloadDigest",
        "encodedPayloadBytes",
        "ttlMillis",
        "admission"
      ] as const
    ) {
      assert.throws(() => decode(event(1, omit(payload, field) as EventV2.Payload)))
    }
    assert.throws(() =>
      decode(event(
        1,
        signalAccepted({
          admission: {
            ...payload.admission,
            policyDecisionId: ""
          }
        })
      ))
    )
    assert.throws(() =>
      decode(event(1, {
        ...signalAccepted(),
        payload: { _tag: "Inline", value: undefined }
      } as EventV2.Payload))
    )
  })

  it("requires the tenant envelope and both protocol version markers", () => {
    const valid = event(0, runStarted())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, eventVersion: 1 },
      { ...valid, eventVersion: 3 },
      { ...valid, tenantId: "" },
      omit(valid, "tenantId"),
      {
        ...valid,
        payload: { ...runStarted(), executionProtocolVersion: 1 }
      },
      {
        ...valid,
        payload: omit(runStarted(), "executionProtocolVersion")
      },
      {
        ...valid,
        payload: { ...runStarted(), artifactVersion: 1 }
      },
      {
        ...valid,
        payload: omit(runStarted(), "artifactDigest")
      },
      {
        ...valid,
        payload: omit(runStarted(), "workflowIdentity")
      },
      {
        ...valid,
        payload: omit(runStarted(), "startRequestId")
      }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("rejects unsafe integers at every representative semantic boundary", () => {
    const unsafeNonNegative = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]
    const unsafePositive = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]

    for (const sequence of unsafeNonNegative) {
      assert.throws(() => decode(event(sequence, runStarted())))
      assert.throws(() =>
        decode(event(0, {
          ...runStarted(),
          planRevision: sequence
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          _tag: "SignalConsumed",
          signalId: "signal-1",
          inboxSequence: sequence,
          waitId: "wait-1",
          nodeId: "approval",
          nodeInstanceId: "approval"
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          _tag: "TimerScheduled",
          timerId: "timer-1",
          purpose: {
            _tag: "ScheduleToClose",
            logicalActivityId: "logical-activity-1"
          },
          anchorEventId: "anchor-1",
          delayMillis: sequence,
          deadline: timestamp
        }))
      )
    }

    for (const attempt of unsafePositive) {
      assert.throws(() =>
        decode(event(0, {
          ...activityScheduled(),
          attempt
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          _tag: "ActivityAttemptStarted",
          logicalActivityId: "logical-activity-1",
          attemptId: "attempt-1",
          attempt
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          _tag: "SignalWaitStarted",
          waitId: "wait-1",
          nodeId: "approval",
          nodeInstanceId: "approval",
          signalName: "ApprovalGranted",
          signalVersion: "1.0.0",
          correlation: { _tag: "Any" },
          timeout: { _tag: "After", durationMillis: attempt }
        }))
      )
    }

    assert.doesNotThrow(() =>
      decode(event(Number.MAX_SAFE_INTEGER, {
        ...activityScheduled(),
        attempt: Number.MAX_SAFE_INTEGER
      }))
    )
  })

  it("requires explicit policy, purpose, correlation, timeout, and failure cause", () => {
    const malformedPayloads: ReadonlyArray<unknown> = [
      omit(activityScheduled(), "policy"),
      {
        _tag: "TimerScheduled",
        timerId: "timer-1",
        anchorEventId: "anchor-1",
        delayMillis: 1,
        deadline: timestamp
      },
      omit(signalAccepted({ correlation: { _tag: "Any" } }), "correlation"),
      omit({
        _tag: "SignalWaitStarted",
        waitId: "wait-1",
        nodeId: "approval",
        nodeInstanceId: "approval",
        signalName: "ApprovalGranted",
        signalVersion: "1.0.0",
        correlation: { _tag: "Any" },
        timeout: { _tag: "Disabled" }
      }, "timeout"),
      {
        _tag: "ActivityFailed",
        logicalActivityId: "logical-activity-1",
        nodeId: "validate",
        nodeInstanceId: "validate",
        attemptId: "attempt-1",
        attempt: 1
      },
      { _tag: "RunCancellationRequested" },
      { _tag: "RunFailed" }
    ]

    for (const payload of malformedPayloads) {
      assert.throws(() => decode(event(0, payload as EventV2.Payload)))
    }
  })

  it("rejects excess properties at every nested strict boundary", () => {
    const valid = event(0, activityScheduled())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, unexpected: true },
      { ...valid, payload: { ...activityScheduled(), unexpected: true } },
      {
        ...valid,
        payload: {
          ...activityScheduled(),
          policy: { ...policy(), unexpected: true }
        }
      },
      {
        ...valid,
        payload: {
          ...activityScheduled(),
          policy: {
            ...policy(),
            retry: {
              ...policy().retry,
              retryOn: { ...policy().retry.retryOn, unexpected: true }
            }
          }
        }
      },
      {
        ...valid,
        payload: {
          ...activityScheduled(),
          policy: {
            ...policy(),
            timeouts: {
              ...policy().timeouts,
              startToClose: {
                _tag: "After",
                durationMillis: 1,
                unexpected: true
              }
            }
          }
        }
      },
      {
        ...valid,
        payload: {
          _tag: "TimerScheduled",
          timerId: "timer-1",
          purpose: {
            _tag: "RetryBackoff",
            retryId: "retry-1",
            logicalActivityId: "logical-activity-1",
            nextAttempt: 2,
            unexpected: true
          },
          anchorEventId: "anchor-1",
          delayMillis: 1,
          deadline: timestamp
        }
      },
      {
        ...valid,
        payload: activityFailed({
          cause: {
            ...activityFailureCause(),
            unexpected: true
          } as EventV2.ActivityFailureCause
        })
      },
      {
        ...valid,
        payload: {
          _tag: "SignalWaitStarted",
          waitId: "wait-1",
          nodeId: "approval",
          nodeInstanceId: "approval",
          signalName: "ApprovalGranted",
          signalVersion: "1.0.0",
          correlation: { _tag: "Exact", key: "order-1", unexpected: true },
          timeout: { _tag: "Disabled" }
        }
      }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("strictly admits every timer purpose and rejects ambiguous variants", () => {
    const decodePurpose = Schema.decodeUnknownSync(EventV2.TimerPurpose)
    const purposes: ReadonlyArray<EventV2.TimerPurpose> = [
      {
        _tag: "RetryBackoff",
        retryId: "retry-2",
        logicalActivityId: "logical-activity-1",
        nextAttempt: 2
      },
      {
        _tag: "ScheduleToStart",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-1",
        attempt: 1
      },
      {
        _tag: "StartToClose",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-1",
        attempt: 1
      },
      {
        _tag: "ScheduleToClose",
        logicalActivityId: "logical-activity-1"
      },
      {
        _tag: "SignalExpiry",
        signalId: "signal-1",
        inboxSequence: 0
      },
      {
        _tag: "SignalWaitTimeout",
        waitId: "wait-1",
        nodeInstanceId: "approval"
      },
      {
        _tag: "Sleep",
        waitId: "sleep-1",
        nodeInstanceId: "sleep"
      }
    ]

    for (const purpose of purposes) {
      assert.deepStrictEqual(decodePurpose(purpose), purpose)
    }

    const malformed: ReadonlyArray<unknown> = [
      { _tag: "RetryBackoff", logicalActivityId: "logical-activity-1", nextAttempt: 2 },
      {
        _tag: "ScheduleToClose",
        logicalActivityId: "logical-activity-1",
        attemptId: "attempt-1"
      },
      { _tag: "FutureTimer", ownerId: "owner-1" }
    ]
    for (const purpose of malformed) {
      assert.throws(() => decodePurpose(purpose))
    }
  })

  it("strictly admits every activity and run failure cause", () => {
    const decodeActivityCause = Schema.decodeUnknownSync(EventV2.ActivityFailureCause)
    const activityCauses: ReadonlyArray<EventV2.ActivityFailureCause> = [
      activityFailureCause(),
      { _tag: "AttemptTimeout", timeoutKind: "ScheduleToStart" },
      { _tag: "AttemptTimeout", timeoutKind: "StartToClose" },
      { _tag: "ScheduleToCloseTimeout", timerId: "timer-total-1" }
    ]
    for (const cause of activityCauses) {
      assert.deepStrictEqual(decodeActivityCause(cause), cause)
    }

    const decodeRunCause = Schema.decodeUnknownSync(EventV2.RunFailureCause)
    const runCauses: ReadonlyArray<EventV2.RunFailureCause> = [
      {
        _tag: "ActivityFailure",
        logicalActivityId: "logical-activity-1",
        nodeId: "validate",
        nodeInstanceId: "validate",
        attemptId: "attempt-3",
        attempt: 3,
        cause: { _tag: "AttemptTimeout", timeoutKind: "StartToClose" }
      },
      {
        _tag: "SignalWaitTimeout",
        waitId: "wait-1",
        nodeId: "approval",
        nodeInstanceId: "approval",
        timerId: "timer-wait-1"
      },
      {
        _tag: "ProtocolFailure",
        code: "DeadlineOutOfRange",
        commandId: "schedule-timer-1",
        anchorEventId: "activity-scheduled-1",
        delayMillis: 1
      }
    ]
    for (const cause of runCauses) {
      assert.deepStrictEqual(decodeRunCause(cause), cause)
    }

    const malformed: ReadonlyArray<unknown> = [
      { _tag: "EncodedFailure" },
      { _tag: "AttemptTimeout", timeoutKind: "ScheduleToClose" },
      { _tag: "ScheduleToCloseTimeout", timerId: "" },
      { _tag: "FutureFailure", failure: {} }
    ]
    for (const cause of malformed) {
      assert.throws(() => decodeActivityCause(cause))
    }
    assert.throws(() =>
      decodeRunCause({
        _tag: "ActivityFailure",
        logicalActivityId: "logical-activity-1",
        nodeId: "validate",
        nodeInstanceId: "validate",
        attemptId: "attempt-1",
        attempt: 1
      })
    )
    assert.throws(() =>
      decodeRunCause({
        _tag: "ProtocolFailure",
        code: "DeadlineOutOfRange",
        commandId: "schedule-timer-1",
        anchorEventId: "activity-scheduled-1",
        delayMillis: ProtocolV2Wire.MaximumSemanticDelayMillis + 1
      })
    )
  })

  it("strictly validates signal correlation and timer cancellation reason unions", () => {
    const decodeCorrelation = Schema.decodeUnknownSync(EventV2.SignalCorrelation)
    assert.deepStrictEqual(decodeCorrelation({ _tag: "Any" }), { _tag: "Any" })
    assert.deepStrictEqual(
      decodeCorrelation({ _tag: "Exact", key: "order-1" }),
      { _tag: "Exact", key: "order-1" }
    )
    assert.throws(() => decodeCorrelation({ _tag: "Exact", key: "" }))
    assert.throws(() => decodeCorrelation({ _tag: "Any", key: "ambiguous" }))
    assert.throws(() => decodeCorrelation({ _tag: "Prefix", key: "order-" }))

    const decodeReason = Schema.decodeUnknownSync(EventV2.TimerCancellationReason)
    for (
      const reason of [
        "OwnerCompleted",
        "OwnerFailed",
        "RunCancellationRequested",
        "RunTerminal",
        "SignalConsumed",
        "Superseded"
      ] as const
    ) {
      assert.strictEqual(decodeReason(reason), reason)
    }
    assert.throws(() => decodeReason("UnknownReason"))
  })

  it("rejects malformed timestamps, empty identities, and unknown payload tags", () => {
    const valid = event(0, runStarted())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, eventId: "" },
      { ...valid, runId: "" },
      { ...valid, recordedAt: "not-a-timestamp" },
      { ...valid, recordedAt: "2026-02-30T01:02:03Z" },
      { ...valid, recordedAt: "2026-07-23T01:02:03" },
      { ...valid, recordedAt: "2026-07-23T01:02:03Z" },
      { ...valid, recordedAt: "2026-07-23T01:02:03.0001Z" },
      { ...valid, recordedAt: "2026-07-23T02:02:03.000+01:00" },
      { ...valid, causationId: "" },
      { ...valid, correlationId: "" },
      { ...valid, payload: { _tag: "UnknownEvent" } },
      {
        ...valid,
        payload: { ...runStarted(), compiledFingerprint: "sha256:abcd" }
      },
      {
        ...valid,
        payload: { ...activityScheduled(), logicalActivityId: "" }
      }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("rejects non-JSON and hostile values at every encoded boundary", () => {
    const nonJson: ReadonlyArray<unknown> = [
      { value: 1n },
      { value: undefined },
      { value: () => undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY }
    ]

    for (const value of nonJson) {
      assert.throws(() =>
        decode(event(0, {
          ...runStarted(),
          input: value as EventV2.EncodedValues
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          ...activityScheduled(),
          input: value as EventV2.EncodedValues
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          _tag: "ActivityAttemptFailed",
          logicalActivityId: "logical-activity-1",
          attemptId: "attempt-1",
          attempt: 1,
          failure: value as Schema.Json
        }))
      )
      assert.throws(() =>
        decode(event(0, {
          _tag: "RunSucceeded",
          output: value as EventV2.EncodedValues
        }))
      )
    }

    const hostile = Object.defineProperty(
      { ...event(0, runStarted()) },
      "payload",
      {
        enumerable: true,
        get() {
          throw new Error("hostile payload getter")
        }
      }
    )
    assert.throws(() => decode(hostile))
    assert.throws(() =>
      decode(
        new Proxy({}, {
          ownKeys() {
            throw new Error("hostile ownKeys")
          }
        })
      )
    )
  })

  it("preserves prototype-like encoded names without polluting prototypes", () => {
    const input = JSON.parse(
      "{\"__proto__\":{\"polluted\":true},\"constructor\":\"constructor-value\",\"toString\":\"string-value\"}"
    )
    const decodeValues = Schema.decodeUnknownSync(EventV2.EncodedValues)
    const decoded = decodeValues(input)

    assert.isTrue(Object.prototype.hasOwnProperty.call(decoded, "__proto__"))
    assert.deepStrictEqual(decoded["__proto__"], { polluted: true })
    assert.strictEqual(decoded.constructor, "constructor-value")
    assert.strictEqual(decoded.toString, "string-value")
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
  })

  it("remains wire-incompatible with event format version 1", () => {
    const v1 = {
      eventVersion: 1,
      eventId: "event-v1",
      runId: "run-1",
      sequence: 0,
      recordedAt: timestamp,
      payload: {
        _tag: "RunStarted",
        planId: "order-plan",
        planRevision: 3,
        definitionId: "order-workflow",
        definitionVersion: "2.1.0",
        compilerVersion: "4.0.0",
        compiledFingerprint,
        backend: "durable",
        input: {}
      }
    }
    const v2 = event(0, runStarted())

    assert.doesNotThrow(() => Schema.decodeUnknownSync(EventV1.Event)(v1))
    assert.throws(() => decode(v1))
    assert.throws(() => Schema.decodeUnknownSync(EventV1.Event)(v2))
  })

  it("roundtrips canonical tenant-bound protocol version 2 identities", () => {
    const tenantId = "tenant-1"
    const runId = "run-1"
    const nodeInstanceId = "validate"
    const logicalActivityId = IdentityV2.logicalActivityId(tenantId, runId, nodeInstanceId)
    const attemptId = IdentityV2.activityAttemptId(tenantId, runId, nodeInstanceId, 1)
    const payload = activityScheduled({
      logicalActivityId,
      attemptId,
      nodeInstanceId,
      idempotencyKey: IdentityV2.activityIdempotencyKey(
        tenantId,
        runId,
        nodeInstanceId
      )
    })
    const input = event(1, payload, {
      tenantId,
      runId,
      eventId: IdentityV2.scheduleActivityCommandId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      )
    })
    const decoded = decode(input)

    assert.deepStrictEqual(decoded, input)
    assert.strictEqual(
      decoded.eventId,
      IdentityV2.scheduleActivityCommandId(tenantId, runId, nodeInstanceId, 1)
    )
    assert.strictEqual(decoded.tenantId, tenantId)

    const requestId = "request-1"
    const cancellation = event(2, {
      _tag: "RunCancellationRequested",
      requestId
    }, {
      tenantId,
      runId,
      eventId: IdentityV2.runCancellationRequestedEventId(
        tenantId,
        runId,
        requestId
      )
    })
    assert.deepStrictEqual(decode(cancellation), cancellation)

    const sleepNodeInstanceId = "sleep"
    const sleep = event(
      3,
      sleepStarted({
        waitId: IdentityV2.sleepWaitId(
          tenantId,
          runId,
          sleepNodeInstanceId
        ),
        nodeInstanceId: sleepNodeInstanceId
      }),
      {
        tenantId,
        runId,
        eventId: IdentityV2.startSleepCommandId(
          tenantId,
          runId,
          sleepNodeInstanceId
        )
      }
    )
    assert.deepStrictEqual(decode(sleep), sleep)
    assert.strictEqual(
      sleep.eventId,
      IdentityV2.startSleepCommandId(
        tenantId,
        runId,
        sleepNodeInstanceId
      )
    )
  })
})
