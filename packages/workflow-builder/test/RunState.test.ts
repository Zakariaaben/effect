import { assert, describe, it } from "@effect/vitest"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityRuntime from "../src/ActivityRuntime.ts"
import * as Command from "../src/Command.ts"
import * as CommandEvent from "../src/CommandEvent.ts"
import * as Event from "../src/Event.ts"
import * as Identity from "../src/Identity.ts"
import * as RunStart from "../src/RunStart.ts"
import * as RunState from "../src/RunState.ts"

const timestamp = "2026-07-23T01:02:03.000Z"
const compiledFingerprint = `sha256:${"a".repeat(64)}`

const runStarted = (
  input: Event.EncodedValues = { orderId: "order-1" },
  overrides: Partial<Event.RunStarted> = {}
): Event.RunStarted => ({
  _tag: "RunStarted",
  planId: "order-plan",
  planRevision: 3,
  definitionId: "order-workflow",
  definitionVersion: "2.1.0",
  compilerVersion: "4.0.0",
  compiledFingerprint,
  backend: "durable",
  input,
  ...overrides
})

const activityScheduled = (
  activityId = "activity-validate",
  overrides: Partial<Event.ActivityScheduled> = {}
): Event.ActivityScheduled => ({
  _tag: "ActivityScheduled",
  activityId,
  nodeId: "validate",
  nodeInstanceId: "validate",
  attempt: 1,
  idempotencyKey: `run-1:${activityId}`,
  input: { value: "encoded-input" },
  ...overrides
})

const activityFailure = (
  failure: Schema.Json = { code: "Invalid" },
  overrides: Partial<Event.ActivityFailure> = {}
): Event.ActivityFailure => ({
  _tag: "ActivityFailure",
  activityId: "activity-validate",
  nodeId: "validate",
  nodeInstanceId: "validate",
  attempt: 1,
  failure,
  ...overrides
})

const canonicalEventId = (
  runId: string,
  sequence: number,
  payload: Event.Payload
): string => {
  switch (payload._tag) {
    case "RunStarted":
      return Identity.runStartedEventId(runId)
    case "ActivityScheduled":
      return Identity.scheduleActivityCommandId(runId, payload.nodeInstanceId, payload.attempt)
    case "ActivitySucceeded":
      return Identity.activitySucceededEventId(payload.activityId)
    case "ActivityFailed":
      return Identity.activityFailedEventId(payload.activityId)
    case "RunCancellationRequested":
      return `external-cancellation-${sequence}`
    case "RunSucceeded":
      return Identity.succeedRunCommandId(runId)
    case "RunFailed":
      return Identity.failRunCommandId(runId)
    case "RunCancelled":
      return Identity.cancelRunCommandId(runId)
  }
}

const event = (
  sequence: number,
  payload: Event.Payload,
  overrides: Partial<Pick<Event.Event, "eventId" | "runId" | "recordedAt">> = {}
): Event.Event => {
  const runId = overrides.runId ?? "run-1"
  return {
    eventVersion: 1,
    eventId: overrides.eventId ?? canonicalEventId(runId, sequence, payload),
    runId,
    sequence,
    recordedAt: overrides.recordedAt ?? timestamp,
    payload
  }
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result))
  return result.success
}

const failure = <A>(result: Result.Result<A, RunState.HistoryError>): RunState.HistoryError => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

const code = (history: unknown): RunState.HistoryErrorCode => failure(RunState.fold(history)).code

describe("Event", () => {
  const decode = Schema.decodeUnknownSync(Event.Event)

  it("decodes every version 1 payload and preserves encoded JSON", () => {
    const payloads: ReadonlyArray<Event.Payload> = [
      runStarted(),
      activityScheduled(),
      { _tag: "ActivitySucceeded", activityId: "activity-validate", output: { valid: true } },
      { _tag: "ActivityFailed", activityId: "activity-validate", failure: { code: "Invalid" } },
      { _tag: "RunCancellationRequested" },
      { _tag: "RunSucceeded", output: { receipt: "receipt-1" } },
      { _tag: "RunFailed", failure: activityFailure({ code: "RunFailure" }) },
      { _tag: "RunCancelled" }
    ]

    for (let index = 0; index < payloads.length; index++) {
      const input = {
        ...event(index, payloads[index]!),
        causationId: "command-1",
        correlationId: "request-1"
      }
      assert.deepStrictEqual(decode(input), input)
    }
  })

  it("rejects invalid envelope fields and unknown payload tags", () => {
    const valid = event(0, runStarted())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, eventVersion: 2 },
      { ...valid, eventId: "" },
      { ...valid, runId: "" },
      { ...valid, sequence: -1 },
      { ...valid, sequence: 0.5 },
      { ...valid, recordedAt: "not-a-timestamp" },
      { ...valid, recordedAt: "2026-02-30T01:02:03Z" },
      { ...valid, causationId: "" },
      { ...valid, correlationId: "" },
      { ...valid, payload: { _tag: "UnknownEvent" } }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("strictly validates immutable RunStarted pins", () => {
    const valid = event(0, runStarted())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, payload: runStarted(undefined, { planId: "" }) },
      { ...valid, payload: runStarted(undefined, { planRevision: -1 }) },
      { ...valid, payload: runStarted(undefined, { definitionId: "" }) },
      { ...valid, payload: runStarted(undefined, { definitionVersion: "" }) },
      { ...valid, payload: runStarted(undefined, { compilerVersion: "" }) },
      { ...valid, payload: runStarted(undefined, { compiledFingerprint: "sha256:abcd" }) },
      {
        ...valid,
        payload: runStarted(undefined, {
          compiledFingerprint: `sha256:${"A".repeat(64)}`
        })
      },
      { ...valid, payload: runStarted(undefined, { compiledFingerprint: `md5:${"a".repeat(64)}` }) },
      { ...valid, payload: runStarted(undefined, { backend: "future" as "durable" }) },
      { ...valid, payload: { ...runStarted(), input: { value: 1n } } },
      { ...valid, payload: { ...runStarted(), input: null } },
      { ...valid, payload: { ...runStarted(), input: [] } },
      { ...valid, payload: { ...runStarted(), input: { "": "value" } } }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("rejects invalid activity identity, attempts, and non-JSON values", () => {
    const valid = event(1, activityScheduled())
    const malformed: ReadonlyArray<unknown> = [
      { ...valid, payload: activityScheduled("activity-validate", { activityId: "" }) },
      { ...valid, payload: activityScheduled("activity-validate", { nodeId: "" }) },
      { ...valid, payload: activityScheduled("activity-validate", { nodeInstanceId: "" }) },
      { ...valid, payload: activityScheduled("activity-validate", { idempotencyKey: "" }) },
      { ...valid, payload: activityScheduled("activity-validate", { attempt: 0 }) },
      { ...valid, payload: activityScheduled("activity-validate", { attempt: 1.5 }) },
      {
        ...valid,
        payload: { ...activityScheduled(), input: { callback: () => undefined } }
      },
      { ...valid, payload: { ...activityScheduled(), input: null } },
      { ...valid, payload: { ...activityScheduled(), input: [] } },
      {
        ...valid,
        payload: { _tag: "ActivitySucceeded", activityId: "activity-validate", output: null }
      },
      {
        ...valid,
        payload: { _tag: "ActivityFailed", activityId: "activity-validate", failure: 1n }
      },
      {
        ...valid,
        payload: { _tag: "RunFailed", failure: { arbitrary: true } }
      }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("rejects excess properties in both envelope and payload", () => {
    const valid = event(0, runStarted())
    assert.throws(() => decode({ ...valid, unexpected: true }))
    assert.throws(() =>
      decode({
        ...valid,
        payload: { ...valid.payload, unexpected: true }
      })
    )
  })
})

describe("RunState", () => {
  it("exposes HistoryError as a strict schema-backed typed error", () => {
    const decode = Schema.decodeUnknownSync(RunState.HistoryError)
    const valid = {
      _tag: "HistoryError",
      code: RunState.Codes.EmptyHistory,
      message: "History is empty"
    }
    const decoded = decode(valid)
    assert.ok(decoded instanceof RunState.HistoryError)
    assert.strictEqual(decoded.code, RunState.Codes.EmptyHistory)
    assert.throws(() => decode({ ...valid, unexpected: true }))
  })

  it("replays deterministically into immutable successful state", () => {
    const mutableInput = { order: { id: "order-1" } }
    const history = [
      event(0, runStarted(mutableInput)),
      event(1, activityScheduled("activity-validate")),
      event(2, {
        _tag: "ActivitySucceeded",
        activityId: "activity-validate",
        output: { valid: true }
      }),
      event(
        3,
        activityScheduled("activity-persist", {
          nodeId: "persist",
          nodeInstanceId: "persist",
          input: { order: "encoded-order" }
        })
      ),
      event(4, {
        _tag: "ActivitySucceeded",
        activityId: "activity-persist",
        output: { receipt: "receipt-1" }
      }),
      event(5, { _tag: "RunSucceeded", output: { receipt: "receipt-1" } })
    ]

    const first = success(RunState.fold(history))
    const second = success(RunState.fold(history))
    assert.deepStrictEqual(second, first)
    assert.notStrictEqual(second, first)

    assert.strictEqual(first.status, "Succeeded")
    assert.strictEqual(first.sequence, 5)
    assert.strictEqual(first.runId, "run-1")
    assert.strictEqual(first.planId, "order-plan")
    assert.strictEqual(first.planRevision, 3)
    assert.strictEqual(first.definitionId, "order-workflow")
    assert.strictEqual(first.definitionVersion, "2.1.0")
    assert.strictEqual(first.compilerVersion, "4.0.0")
    assert.strictEqual(first.compiledFingerprint, compiledFingerprint)
    assert.strictEqual(first.backend, "durable")
    assert.deepStrictEqual(first.input, mutableInput)
    assert.deepStrictEqual(first.output, { receipt: "receipt-1" })
    assert.strictEqual(HashMap.getUnsafe(first.activities, "activity-validate").status, "Succeeded")
    assert.strictEqual(HashMap.getUnsafe(first.activities, "activity-persist").status, "Succeeded")

    assert.ok(Object.isFrozen(first))
    assert.ok(Object.isFrozen(HashMap.getUnsafe(first.activities, "activity-validate")))
    assert.isTrue(HashSet.has(first.seenEventIds, history[0]!.eventId))
    assert.ok(Object.isFrozen(first.input))
    assert.ok(Object.isFrozen(first.output))

    mutableInput.order.id = "mutated-after-replay"
    assert.deepStrictEqual(first.input, { order: { id: "order-1" } })
    assert.deepStrictEqual(
      Array.from(first.seenEventIds).sort(),
      history.map((event) => event.eventId).sort()
    )
  })

  it("retains encoded activity and run failures without executing effects", () => {
    const state = success(RunState.fold([
      event(0, runStarted()),
      event(1, activityScheduled()),
      event(2, {
        _tag: "ActivityFailed",
        activityId: "activity-validate",
        failure: { _tag: "ValidationFailure", issues: ["missing id"] }
      }),
      event(3, {
        _tag: "RunFailed",
        failure: activityFailure({ _tag: "ValidationFailure", issues: ["missing id"] })
      })
    ]))

    assert.strictEqual(state.status, "Failed")
    assert.deepStrictEqual(
      state.failure,
      activityFailure({ _tag: "ValidationFailure", issues: ["missing id"] })
    )
    const activity = HashMap.getUnsafe(state.activities, "activity-validate")
    assert.strictEqual(activity.status, "Failed")
    assert.deepStrictEqual(activity.failure, {
      _tag: "ValidationFailure",
      issues: ["missing id"]
    })
  })

  it("keeps cancellation requested distinct from terminal cancellation", () => {
    const requested = success(RunState.fold([
      event(0, runStarted()),
      event(1, activityScheduled()),
      event(2, { _tag: "RunCancellationRequested" })
    ]))
    assert.strictEqual(requested.status, "CancellationRequested")
    assert.ok(!("completedAt" in requested))

    const completedDuringCancellation = RunState.reduce(
      requested,
      event(3, {
        _tag: "ActivitySucceeded",
        activityId: "activity-validate",
        output: { valid: true }
      })
    )
    assert.isTrue(Result.isFailure(completedDuringCancellation))
    assert.strictEqual(
      completedDuringCancellation.failure.code,
      RunState.Codes.IllegalActivityTransition
    )

    const cancelled = success(RunState.reduce(
      requested,
      event(3, {
        _tag: "RunCancelled"
      })
    ))
    assert.strictEqual(cancelled.status, "Cancelled")
    assert.strictEqual(cancelled.sequence, 3)
  })

  it("allows cancellation to terminate only with RunCancelled", () => {
    const invalidTerminals: ReadonlyArray<Event.Payload> = [
      { _tag: "RunSucceeded", output: {} },
      { _tag: "RunFailed", failure: activityFailure() }
    ]

    for (const terminal of invalidTerminals) {
      const error = failure(RunState.fold([
        event(0, runStarted()),
        event(1, { _tag: "RunCancellationRequested" }),
        event(2, terminal)
      ]))
      assert.strictEqual(error.code, RunState.Codes.IllegalRunTransition)
      assert.deepStrictEqual(error.details, {
        status: "CancellationRequested",
        eventTag: terminal._tag
      })
    }
  })

  it("rejects noncanonical engine event ids for every engine-generated tag", () => {
    const cases: ReadonlyArray<{
      readonly history: ReadonlyArray<Event.Event>
      readonly historyIndex: number
      readonly eventTag: Event.Payload["_tag"]
    }> = [
      {
        history: [event(0, runStarted(), { eventId: "hostile-run-started" })],
        historyIndex: 0,
        eventTag: "RunStarted"
      },
      {
        history: [
          event(0, runStarted()),
          event(1, activityScheduled(), { eventId: "hostile-activity-scheduled" })
        ],
        historyIndex: 1,
        eventTag: "ActivityScheduled"
      },
      {
        history: [
          event(0, runStarted()),
          event(1, activityScheduled()),
          event(2, {
            _tag: "ActivitySucceeded",
            activityId: "activity-validate",
            output: {}
          }, { eventId: "hostile-activity-succeeded" })
        ],
        historyIndex: 2,
        eventTag: "ActivitySucceeded"
      },
      {
        history: [
          event(0, runStarted()),
          event(1, activityScheduled()),
          event(2, {
            _tag: "ActivityFailed",
            activityId: "activity-validate",
            failure: null
          }, { eventId: "hostile-activity-failed" })
        ],
        historyIndex: 2,
        eventTag: "ActivityFailed"
      },
      {
        history: [
          event(0, runStarted()),
          event(1, { _tag: "RunSucceeded", output: {} }, {
            eventId: "hostile-run-succeeded"
          })
        ],
        historyIndex: 1,
        eventTag: "RunSucceeded"
      },
      {
        history: [
          event(0, runStarted()),
          event(1, { _tag: "RunFailed", failure: activityFailure() }, {
            eventId: "hostile-run-failed"
          })
        ],
        historyIndex: 1,
        eventTag: "RunFailed"
      },
      {
        history: [
          event(0, runStarted()),
          event(1, { _tag: "RunCancellationRequested" }, { eventId: "caller-request" }),
          event(2, { _tag: "RunCancelled" }, { eventId: "hostile-run-cancelled" })
        ],
        historyIndex: 2,
        eventTag: "RunCancelled"
      }
    ]

    for (const testCase of cases) {
      const error = failure(RunState.fold(testCase.history))
      const rejected = testCase.history[testCase.historyIndex]!
      assert.strictEqual(error.code, RunState.Codes.NonCanonicalEventId)
      assert.strictEqual(error.historyIndex, testCase.historyIndex)
      assert.deepStrictEqual(error.details, {
        eventTag: testCase.eventTag,
        expectedEventId: canonicalEventId(
          rejected.runId,
          rejected.sequence,
          rejected.payload
        ),
        actualEventId: rejected.eventId
      })
    }

    const running = success(RunState.fold([event(0, runStarted())]))
    assert.strictEqual(
      failure(RunState.reduce(
        running,
        event(1, { _tag: "RunFailed", failure: activityFailure() }, { eventId: "hostile-reduce" })
      )).code,
      RunState.Codes.NonCanonicalEventId
    )
  })

  it("accepts caller-selected cancellation-request ids and generated engine histories", () => {
    const runId = "generated-run"
    const activityId = Command.activityId(runId, "validate", 1)
    const start = {
      eventVersion: 1 as const,
      eventId: RunStart.eventId(runId),
      payload: runStarted()
    }
    const schedule: Command.Command = {
      commandVersion: 1,
      commandId: Command.scheduleActivityCommandId(runId, "validate", 1),
      payload: {
        _tag: "ScheduleActivity",
        activityId,
        nodeId: "validate",
        nodeInstanceId: "validate",
        attempt: 1,
        idempotencyKey: Command.activityIdempotencyKey(runId, "validate"),
        input: {}
      }
    }
    const scheduled = success(CommandEvent.fromCommand(schedule))
    const succeeded = {
      eventVersion: 1 as const,
      eventId: ActivityRuntime.activitySucceededEventId(activityId),
      causationId: schedule.commandId,
      payload: {
        _tag: "ActivitySucceeded" as const,
        activityId,
        output: {}
      }
    }
    const terminal = success(CommandEvent.fromCommand({
      commandVersion: 1,
      commandId: Command.succeedRunCommandId(runId),
      payload: { _tag: "SucceedRun", output: {} }
    }))
    const generated = [start, scheduled, succeeded, terminal].map((draft, sequence) => ({
      ...draft,
      runId,
      sequence,
      recordedAt: timestamp
    }))
    assert.strictEqual(success(RunState.fold(generated)).status, "Succeeded")

    const externallyCancelled = success(RunState.fold([
      event(0, runStarted()),
      event(1, { _tag: "RunCancellationRequested" }, { eventId: "request-from-api" }),
      event(2, { _tag: "RunCancelled" })
    ]))
    assert.strictEqual(externallyCancelled.status, "Cancelled")
  })

  it("rejects non-array, empty, and malformed wire histories", () => {
    assert.strictEqual(code(null), RunState.Codes.InvalidHistory)
    assert.strictEqual(code([]), RunState.Codes.EmptyHistory)
    assert.strictEqual(
      code([{
        ...event(0, runStarted()),
        unexpected: true
      }]),
      RunState.Codes.InvalidEvent
    )
    assert.strictEqual(
      code([{
        ...event(0, runStarted()),
        payload: { _tag: "FutureEvent" }
      }]),
      RunState.Codes.InvalidEvent
    )
  })

  it("rejects hostile histories without invoking accessors or overridden iteration", () => {
    let reads = 0
    const hostileEvent = Object.defineProperty({}, "eventVersion", {
      enumerable: true,
      get: () => {
        reads++
        return 1
      }
    })
    const accessor = failure(RunState.fold([hostileEvent]))
    assert.strictEqual(accessor.code, RunState.Codes.InvalidEvent)
    assert.strictEqual(accessor.historyIndex, 0)
    assert.strictEqual(reads, 0)

    const sparse = new Array(1)
    assert.strictEqual(failure(RunState.fold(sparse)).code, RunState.Codes.InvalidHistory)

    const decorated = [event(0, runStarted())]
    Object.defineProperty(decorated, Symbol.iterator, { value: function*() {}, enumerable: false })
    assert.strictEqual(failure(RunState.fold(decorated)).code, RunState.Codes.InvalidHistory)

    const state = success(RunState.fold([event(0, runStarted())]))
    assert.strictEqual(failure(RunState.reduce(state, hostileEvent)).code, RunState.Codes.InvalidEvent)
  })

  it("rejects a first event other than RunStarted", () => {
    const error = failure(RunState.fold([
      event(0, { _tag: "RunCancellationRequested" })
    ]))
    assert.strictEqual(error.code, RunState.Codes.FirstEventNotRunStarted)
    assert.strictEqual(error.historyIndex, 0)
  })

  it("requires a zero-based exact sequence", () => {
    assert.strictEqual(
      code([
        event(1, runStarted())
      ]),
      RunState.Codes.SequenceMismatch
    )

    for (const sequence of [0, 2, 4]) {
      const error = failure(RunState.fold([
        event(0, runStarted()),
        event(sequence, activityScheduled(), { eventId: `out-of-order-${sequence}` })
      ]))
      assert.strictEqual(error.code, RunState.Codes.SequenceMismatch)
      assert.deepStrictEqual(error.details, { expected: 1, actual: sequence })
    }
  })

  it("rejects events for a different run", () => {
    const error = failure(RunState.fold([
      event(0, runStarted()),
      event(1, activityScheduled(), { runId: "run-2" })
    ]))
    assert.strictEqual(error.code, RunState.Codes.RunIdMismatch)
    assert.deepStrictEqual(error.details, { expected: "run-1", actual: "run-2" })
  })

  it("rejects duplicate RunStarted events", () => {
    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, runStarted())
      ]),
      RunState.Codes.DuplicateRunStarted
    )
  })

  it("rejects duplicate event ids in both fold and reduce", () => {
    const started = event(0, runStarted())
    const duplicate = event(1, activityScheduled(), { eventId: started.eventId })
    const error = failure(RunState.fold([
      started,
      duplicate
    ]))
    assert.strictEqual(error.code, RunState.Codes.DuplicateEventId)
    assert.deepStrictEqual(error.details, { eventId: started.eventId })

    const state = success(RunState.fold([started]))
    assert.strictEqual(
      failure(RunState.reduce(state, duplicate)).code,
      RunState.Codes.DuplicateEventId
    )
  })

  it("rejects scheduling an activity id more than once", () => {
    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(
          2,
          activityScheduled("activity-validate", {
            nodeInstanceId: "validate-duplicate"
          })
        )
      ]),
      RunState.Codes.ActivityAlreadyScheduled
    )
  })

  it("rejects activity completion before scheduling", () => {
    const completions: ReadonlyArray<Event.Payload> = [
      { _tag: "ActivitySucceeded", activityId: "activity-missing", output: {} },
      { _tag: "ActivityFailed", activityId: "activity-missing", failure: null }
    ]
    for (const completion of completions) {
      assert.strictEqual(
        code([
          event(0, runStarted()),
          event(1, completion)
        ]),
        RunState.Codes.ActivityNotScheduled
      )
    }
  })

  it("rejects every duplicate activity completion", () => {
    const firstCompletions: ReadonlyArray<Event.Payload> = [
      { _tag: "ActivitySucceeded", activityId: "activity-validate", output: { valid: true } },
      { _tag: "ActivityFailed", activityId: "activity-validate", failure: { code: "Invalid" } }
    ]
    const secondCompletions: ReadonlyArray<Event.Payload> = [
      { _tag: "ActivitySucceeded", activityId: "activity-validate", output: { valid: true } },
      { _tag: "ActivityFailed", activityId: "activity-validate", failure: { code: "Invalid" } }
    ]

    for (const first of firstCompletions) {
      for (const second of secondCompletions) {
        assert.strictEqual(
          code([
            event(0, runStarted()),
            event(1, activityScheduled()),
            event(2, first),
            event(3, second)
          ]),
          first._tag === second._tag
            ? RunState.Codes.DuplicateEventId
            : RunState.Codes.ActivityAlreadyCompleted
        )
      }
    }
  })

  it("does not schedule new work after cancellation was requested", () => {
    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, { _tag: "RunCancellationRequested" }),
        event(2, activityScheduled())
      ]),
      RunState.Codes.IllegalActivityTransition
    )
  })

  it("rejects duplicate cancellation requests and cancellation without a request", () => {
    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, { _tag: "RunCancellationRequested" }),
        event(2, { _tag: "RunCancellationRequested" })
      ]),
      RunState.Codes.IllegalRunTransition
    )

    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, { _tag: "RunCancelled" })
      ]),
      RunState.Codes.IllegalRunTransition
    )
  })

  it("rejects successful run completion with pending or failed activities", () => {
    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(2, { _tag: "RunSucceeded", output: {} })
      ]),
      RunState.Codes.IllegalRunTransition
    )

    assert.strictEqual(
      code([
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(2, { _tag: "ActivityFailed", activityId: "activity-validate", failure: null }),
        event(3, { _tag: "RunSucceeded", output: {} })
      ]),
      RunState.Codes.IllegalRunTransition
    )
  })

  it("requires terminal failure to match an attributed failed activity", () => {
    const cases: ReadonlyArray<ReadonlyArray<Event.Event>> = [
      [
        event(0, runStarted()),
        event(1, { _tag: "RunFailed", failure: activityFailure() })
      ],
      [
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(2, { _tag: "RunFailed", failure: activityFailure() })
      ],
      [
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(2, { _tag: "ActivityFailed", activityId: "activity-validate", failure: null }),
        event(3, { _tag: "RunFailed", failure: activityFailure({ different: true }) })
      ],
      [
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(2, { _tag: "ActivityFailed", activityId: "activity-validate", failure: null }),
        event(3, {
          _tag: "RunFailed",
          failure: activityFailure(null, { nodeInstanceId: "other-instance" })
        })
      ]
    ]

    for (const history of cases) {
      assert.strictEqual(code(history), RunState.Codes.IllegalRunTransition)
    }
  })

  it("rejects every event after a terminal run event", () => {
    const terminalHistories: ReadonlyArray<ReadonlyArray<Event.Event>> = [
      [
        event(0, runStarted()),
        event(1, { _tag: "RunSucceeded", output: {} })
      ],
      [
        event(0, runStarted()),
        event(1, activityScheduled()),
        event(2, { _tag: "ActivityFailed", activityId: "activity-validate", failure: null }),
        event(3, { _tag: "RunFailed", failure: activityFailure(null) })
      ],
      [
        event(0, runStarted()),
        event(1, { _tag: "RunCancellationRequested" }),
        event(2, { _tag: "RunCancelled" })
      ]
    ]

    for (const history of terminalHistories) {
      assert.strictEqual(
        code([
          ...history,
          event(history.length, { _tag: "RunFailed", failure: activityFailure("late") })
        ]),
        RunState.Codes.EventAfterTerminal
      )
    }
  })

  it("schema-validates events supplied directly to reduce", () => {
    const state = success(RunState.fold([event(0, runStarted())]))
    const error = failure(RunState.reduce(state, {
      ...event(1, activityScheduled()),
      payload: { ...activityScheduled(), unexpected: true }
    }))
    assert.strictEqual(error.code, RunState.Codes.InvalidEvent)
  })
})
