import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import type * as Event from "../src/Event.ts"
import * as HistoryStore from "../src/HistoryStore.ts"
import * as Identity from "../src/Identity.ts"
import * as RunState from "../src/RunState.ts"

const compiledFingerprint = `sha256:${"a".repeat(64)}`

const runStarted = (
  eventId = "event-start",
  input: Event.EncodedValues = { orderId: "order-1" }
): HistoryStore.EventDraft<Event.RunStarted> => ({
  eventVersion: 1,
  eventId,
  payload: {
    _tag: "RunStarted",
    planId: "order-plan",
    planRevision: 3,
    definitionId: "order-workflow",
    definitionVersion: "2.1.0",
    compilerVersion: "4.0.0",
    compiledFingerprint,
    backend: "direct",
    input
  }
})

const activityScheduled = (
  eventId: string,
  activityId = eventId
): HistoryStore.EventDraft<Event.ActivityScheduled> => ({
  eventVersion: 1,
  eventId,
  payload: {
    _tag: "ActivityScheduled",
    activityId,
    nodeId: activityId,
    nodeInstanceId: activityId,
    attempt: 1,
    idempotencyKey: `run-1:${activityId}`,
    input: { value: activityId }
  }
})

const activitySucceeded = (
  eventId: string,
  activityId: string,
  output: Event.EncodedValues = { ok: true }
): HistoryStore.EventDraft<Event.ActivitySucceeded> => ({
  eventVersion: 1,
  eventId,
  payload: { _tag: "ActivitySucceeded", activityId, output }
})

const failure = <A, E>(result: Result.Result<A, E>): E => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

const makeClock = (currentTimeMillis: Effect.Effect<number>): Clock.Clock => ({
  currentTimeMillisUnsafe: () => 0,
  currentTimeMillis,
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void
})

describe("HistoryStore", () => {
  it.effect("reports histories that have not been started", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const read = yield* Effect.result(store.read("missing-run"))
      const append = yield* Effect.result(store.append({
        runId: "missing-run",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1")]
      }))

      assert.strictEqual(failure(read)._tag, "HistoryNotFound")
      assert.strictEqual(failure(append)._tag, "HistoryNotFound")
    }))

  it.effect("starts a run at sequence zero and assigns its envelope once", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const draft = runStarted()
      const receipt = yield* store.start({ runId: "run-1", event: draft })
      const snapshot = yield* store.read("run-1")

      assert.strictEqual(receipt.runId, "run-1")
      assert.strictEqual(receipt.previousSequence, null)
      assert.strictEqual(receipt.lastSequence, 0)
      assert.strictEqual(receipt.events[0].runId, "run-1")
      assert.strictEqual(receipt.events[0].sequence, 0)
      assert.match(receipt.events[0].recordedAt, /Z$/)
      assert.deepStrictEqual(snapshot.events, receipt.events)
    }))

  it.effect("allows only one of two different concurrent starts", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const results = yield* Effect.all([
        Effect.result(store.start({ runId: "run-1", event: runStarted("start-a") })),
        Effect.result(store.start({ runId: "run-1", event: runStarted("start-b") }))
      ], { concurrency: "unbounded" })

      assert.strictEqual(results.filter(Result.isSuccess).length, 1)
      const rejected = results.find(Result.isFailure)
      assert.ok(rejected !== undefined && Result.isFailure(rejected))
      assert.strictEqual(rejected.failure._tag, "RunAlreadyExists")
      assert.strictEqual(rejected.failure.lastSequence, 0)
    }))

  it.effect("returns the original receipt for an exact start retry", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const draft = runStarted()
      const original = yield* store.start({ runId: "run-1", event: draft })
      const retried = yield* store.start({ runId: "run-1", event: draft })

      assert.strictEqual(retried, original)
      assert.strictEqual(retried.events[0], original.events[0])
    }))

  it.effect("recognizes an exact start retry after later appends", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const draft = runStarted()
      const original = yield* store.start({ runId: "run-1", event: draft })
      yield* store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1")]
      })
      const retried = yield* store.start({ runId: "run-1", event: draft })

      assert.strictEqual(retried, original)
      assert.strictEqual(retried.lastSequence, 0)
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 1)
    }))

  it.effect("rejects changed content under the start event ID", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const changed = yield* Effect.result(store.start({
        runId: "run-1",
        event: runStarted("event-start", { orderId: "changed" })
      }))

      assert.strictEqual(failure(changed)._tag, "EventIdConflict")
    }))

  it.effect("rejects changed canonical content under the same event ID", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const original = activityScheduled("event-1", "activity-1")
      yield* store.append({ runId: "run-1", expectedLastSequence: 0, events: [original] })
      const changed = activityScheduled("event-1", "activity-changed")
      const result = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [changed]
      }))
      const error = failure(result)

      assert.strictEqual(error._tag, "EventIdConflict")
      assert.strictEqual(error.existingSequence, 1)
      assert.strictEqual(error.requestedSequence, 1)
    }))

  it.effect("commits a multi-event append atomically with contiguous sequences", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const committed = yield* store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1", "activity-1"), activityScheduled("event-2", "activity-2")]
      })

      assert.deepStrictEqual(committed.events.map((event) => event.sequence), [1, 2])
      assert.strictEqual(committed.previousSequence, 0)
      assert.strictEqual(committed.lastSequence, 2)

      const rejected = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: 2,
        events: [activityScheduled("event-3"), activityScheduled("event-3")]
      }))
      assert.strictEqual(failure(rejected)._tag, "EventIdConflict")
      const snapshot = yield* store.read("run-1")
      assert.strictEqual(snapshot.lastSequence, 2)
      assert.strictEqual(snapshot.events.length, 3)
    }))

  it.effect("permits one concurrent compare-and-set append", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const results = yield* Effect.all([
        Effect.result(store.append({
          runId: "run-1",
          expectedLastSequence: 0,
          events: [activityScheduled("event-a")]
        })),
        Effect.result(store.append({
          runId: "run-1",
          expectedLastSequence: 0,
          events: [activityScheduled("event-b")]
        }))
      ], { concurrency: "unbounded" })

      assert.strictEqual(results.filter(Result.isSuccess).length, 1)
      const rejected = results.find(Result.isFailure)
      assert.ok(rejected !== undefined && Result.isFailure(rejected))
      assert.strictEqual(rejected.failure._tag, "SequenceConflict")
      assert.strictEqual(rejected.failure.actualLastSequence, 1)
    }))

  it.effect("recognizes an exact append retry after the head advances", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const drafts = [
        activityScheduled("event-1", "activity-1"),
        activityScheduled("event-2", "activity-2")
      ] as const
      const original = yield* store.append({ runId: "run-1", expectedLastSequence: 0, events: drafts })
      yield* store.append({
        runId: "run-1",
        expectedLastSequence: 2,
        events: [activitySucceeded("event-3", "activity-1")]
      })
      const retried = yield* store.append({ runId: "run-1", expectedLastSequence: 0, events: drafts })

      assert.strictEqual(retried, original)
      assert.strictEqual(retried.lastSequence, 2)
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 3)
    }))

  it.effect("applies retry, overlap, and stale-head precedence across batch shapes", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const first = [activityScheduled("event-1"), activityScheduled("event-2")] as const
      const firstReceipt = yield* store.append({ runId: "run-1", expectedLastSequence: 0, events: first })
      yield* store.append({
        runId: "run-1",
        expectedLastSequence: 2,
        events: [activityScheduled("event-3"), activityScheduled("event-4")]
      })

      const exact = yield* store.append({ runId: "run-1", expectedLastSequence: 0, events: first })
      assert.strictEqual(exact, firstReceipt)

      const cases = [
        { events: [activityScheduled("fresh")], tag: "SequenceConflict" },
        { events: [activityScheduled("event-1", "changed")], tag: "EventIdConflict" },
        { events: [first[1], first[0]], tag: "EventIdConflict" },
        { events: [first[0]], tag: "EventIdConflict" },
        { events: [first[0], first[1], activityScheduled("superset")], tag: "EventIdConflict" },
        { events: [first[1], activityScheduled("event-3")], tag: "EventIdConflict" }
      ] as const
      for (const testCase of cases) {
        const result = yield* Effect.result(store.append({
          runId: "run-1",
          expectedLastSequence: 0,
          events: testCase.events
        }))
        assert.strictEqual(failure(result)._tag, testCase.tag)
      }
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 4)
    }))

  it.effect("rejects partial overlap with a prior batch", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      yield* store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1"), activityScheduled("event-2")]
      })
      const result = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1"), activityScheduled("event-new")]
      }))

      assert.strictEqual(failure(result)._tag, "EventIdConflict")
      const snapshot = yield* store.read("run-1")
      assert.strictEqual(snapshot.events.some((event) => event.eventId === "event-new"), false)
    }))

  it.effect("rejects duplicate IDs inside one request without committing", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })
      const result = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("duplicate"), activityScheduled("duplicate")]
      }))
      const error = failure(result)

      assert.strictEqual(error._tag, "EventIdConflict")
      assert.strictEqual(error.existingSequence, 1)
      assert.strictEqual(error.requestedSequence, 2)
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 0)
    }))

  it.effect("reports hostile runtime inputs as typed store failures", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const invalidStart = yield* Effect.result(store.start({
        runId: "run-1",
        event: activityScheduled("not-a-start") as unknown as HistoryStore.EventDraft<Event.RunStarted>
      }))
      assert.strictEqual(failure(invalidStart)._tag, "HistoryStoreFailure")

      yield* store.start({ runId: "run-1", event: runStarted() })
      const invalidSequence = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: -1,
        events: [activityScheduled("event-1")]
      }))
      assert.strictEqual(failure(invalidSequence)._tag, "HistoryStoreFailure")

      const empty = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [] as unknown as [HistoryStore.EventDraft]
      }))
      assert.strictEqual(failure(empty)._tag, "HistoryStoreFailure")

      const cyclic: Record<string, Schema.Json> = {}
      cyclic.self = cyclic
      const invalidJson = yield* Effect.result(store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activitySucceeded("event-cyclic", "activity-1", cyclic)]
      }))
      assert.strictEqual(failure(invalidJson)._tag, "HistoryStoreFailure")
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 0)
    }))

  it.effect("snapshots request descriptors before validation and never invokes accessors", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      let reads = 0
      const options = Object.defineProperty({}, "runId", {
        enumerable: true,
        get: () => {
          reads++
          return "run-1"
        }
      })
      Object.defineProperty(options, "event", { enumerable: true, value: runStarted() })

      const getter = yield* Effect.result(store.start(options as Parameters<typeof store.start>[0]))
      const nil = yield* Effect.result(store.start(null as unknown as Parameters<typeof store.start>[0]))
      assert.strictEqual(failure(getter)._tag, "HistoryStoreFailure")
      assert.strictEqual(failure(nil)._tag, "HistoryStoreFailure")
      assert.strictEqual(reads, 0)
    }))

  it.effect("rejects sparse, decorated, and reserved-field drafts without committing", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      yield* store.start({ runId: "run-1", event: runStarted() })

      const sparse = new Array<HistoryStore.EventDraft>(2)
      sparse[0] = activityScheduled("event-sparse")
      const decorated = [activityScheduled("event-decorated")]
      Object.defineProperty(decorated, "map", { value: () => [], enumerable: false })
      Object.defineProperty(decorated, "every", { value: () => true, enumerable: false })
      Object.defineProperty(decorated, Symbol.iterator, { value: function*() {}, enumerable: false })
      const reserved = { ...activityScheduled("event-reserved"), runId: "caller-owned" }

      for (const events of [sparse, decorated, [reserved]]) {
        const result = yield* Effect.result(store.append({
          runId: "run-1",
          expectedLastSequence: 0,
          events: events as [HistoryStore.EventDraft]
        }))
        assert.strictEqual(failure(result)._tag, "HistoryStoreFailure")
      }
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 0)
    }))

  it.effect("maps an invalid custom clock to HistoryStoreFailure", () => {
    const invalidClock = makeClock(Effect.succeed(Number.POSITIVE_INFINITY))
    return Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const result = yield* Effect.result(store.start({ runId: "run-1", event: runStarted() }))
      assert.strictEqual(failure(result)._tag, "HistoryStoreFailure")
    }).pipe(Effect.provideService(Clock.Clock, invalidClock))
  })

  it.effect("rejects finite clock values outside the event timestamp schema", () => {
    const outOfRangeClock = makeClock(Effect.succeed(8_640_000_000_000_000))
    return Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const result = yield* Effect.result(store.start({ runId: "run-1", event: runStarted() }))
      assert.strictEqual(failure(result)._tag, "HistoryStoreFailure")
      assert.strictEqual(failure(yield* Effect.result(store.read("run-1")))._tag, "HistoryNotFound")
    }).pipe(Effect.provideService(Clock.Clock, outOfRangeClock))
  })

  it.effect("types clock defects but preserves pure clock interruption", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const defect = yield* Effect.result(
        store.start({ runId: "defect-run", event: runStarted() })
      ).pipe(Effect.provideService(Clock.Clock, makeClock(Effect.die("clock-defect"))))
      assert.strictEqual(failure(defect)._tag, "HistoryStoreFailure")

      const interrupted = yield* Effect.exit(
        store.start({ runId: "interrupted-run", event: runStarted() })
      ).pipe(Effect.provideService(Clock.Clock, makeClock(Effect.interrupt)))
      assert.isTrue(Exit.isFailure(interrupted))
      if (Exit.isFailure(interrupted)) {
        assert.isTrue(Cause.hasInterruptsOnly(interrupted.cause))
      }
      assert.strictEqual(
        failure(yield* Effect.result(store.read("interrupted-run")))._tag,
        "HistoryNotFound"
      )
    }))

  it.effect("returns exact retry receipts without consulting a changed clock", () => {
    let mode: "valid" | "invalid" | "interrupted" = "valid"
    let reads = 0
    const dynamicClock = makeClock(Effect.suspend(() => {
      reads++
      switch (mode) {
        case "valid":
          return Effect.succeed(Date.parse("2026-07-23T01:02:03.000Z"))
        case "invalid":
          return Effect.succeed(Number.POSITIVE_INFINITY)
        case "interrupted":
          return Effect.interrupt
      }
    }))

    return Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const startDraft = runStarted()
      const appendRequest = {
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1")]
      } as const
      const originalStart = yield* store.start({ runId: "run-1", event: startDraft })
      const originalAppend = yield* store.append(appendRequest)
      assert.strictEqual(reads, 2)

      for (const nextMode of ["invalid", "interrupted"] as const) {
        mode = nextMode
        assert.strictEqual(
          yield* store.start({ runId: "run-1", event: startDraft }),
          originalStart
        )
        assert.strictEqual(yield* store.append(appendRequest), originalAppend)
        assert.strictEqual(reads, 2)
      }
    }).pipe(Effect.provideService(Clock.Clock, dynamicClock))
  })

  it.effect("returns one receipt for concurrent identical start and append retries", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const starts = yield* Effect.all([
        store.start({ runId: "run-1", event: runStarted() }),
        store.start({ runId: "run-1", event: runStarted() })
      ], { concurrency: "unbounded" })
      assert.strictEqual(starts[0], starts[1])

      const request = {
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1")]
      } as const
      const appends = yield* Effect.all([store.append(request), store.append(request)], { concurrency: "unbounded" })
      assert.strictEqual(appends[0], appends[1])
      assert.strictEqual((yield* store.read("run-1")).lastSequence, 1)
    }))

  it.effect("returns frozen detached snapshots that remain stable", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const mutableInput: { orderId: string } = { orderId: "order-1" }
      const draft = runStarted("event-start", mutableInput)
      yield* store.start({ runId: "run-1", event: draft })
      const oldSnapshot = yield* store.read("run-1")
      mutableInput.orderId = "mutated"

      yield* store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [activityScheduled("event-1")]
      })
      const current = yield* store.read("run-1")
      const storedInput = oldSnapshot.events[0].payload as Event.RunStarted

      assert.strictEqual(storedInput.input.orderId, "order-1")
      assert.strictEqual(oldSnapshot.events.length, 1)
      assert.strictEqual(current.events.length, 2)
      assert.ok(Object.isFrozen(oldSnapshot))
      assert.ok(Object.isFrozen(oldSnapshot.events))
      assert.ok(Object.isFrozen(oldSnapshot.events[0]))
      assert.ok(Object.isFrozen(oldSnapshot.events[0].payload))
      assert.ok(Object.isFrozen(storedInput.input))
      assert.notStrictEqual(oldSnapshot.events, current.events)
    }))

  it.effect("produces history accepted by RunState.fold", () =>
    Effect.gen(function*() {
      const store = yield* HistoryStore.makeMemory
      const activityId = Identity.activityId("run-1", "node-instance-1", 1)
      yield* store.start({
        runId: "run-1",
        event: runStarted(Identity.runStartedEventId("run-1"))
      })
      yield* store.append({
        runId: "run-1",
        expectedLastSequence: 0,
        events: [
          activityScheduled(Identity.scheduleActivityCommandId("run-1", activityId, 1), activityId),
          activitySucceeded(Identity.activitySucceededEventId(activityId), activityId)
        ]
      })
      const snapshot = yield* store.read("run-1")
      const folded = RunState.fold(snapshot.events)

      assert.ok(Result.isSuccess(folded))
      assert.strictEqual(folded.success.sequence, 2)
    }))
})
