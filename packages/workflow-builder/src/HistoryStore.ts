/**
 * Atomic storage contracts for committed workflow history, with a process-local
 * memory implementation.
 *
 * @since 4.0.0
 */
import type * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Chunk from "effect/Chunk"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Event from "./Event.ts"
import * as Json from "./internal/json.ts"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * An event before its store-owned envelope fields have been assigned.
 *
 * **Details**
 *
 * A draft supplies stable semantic identity and content. The history store is
 * the sole owner of `runId`, `sequence`, and `recordedAt`.
 *
 * @category models
 * @since 4.0.0
 */
export interface EventDraft<out Payload extends Event.Payload = Event.Payload> {
  readonly eventVersion: 1
  readonly eventId: string
  readonly causationId?: string | undefined
  readonly correlationId?: string | undefined
  readonly payload: Payload
}

/**
 * Raised when a requested workflow run has no history in the selected store.
 *
 * @category errors
 * @since 4.0.0
 */
export class HistoryNotFound extends Schema.TaggedErrorClass<HistoryNotFound>(
  "@effect/workflow-builder/HistoryStore/HistoryNotFound"
)("HistoryNotFound", { runId: Schema.NonEmptyString }) {}

/**
 * Raised when a different start event has already created a workflow run.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunAlreadyExists extends Schema.TaggedErrorClass<RunAlreadyExists>(
  "@effect/workflow-builder/HistoryStore/RunAlreadyExists"
)("RunAlreadyExists", {
  runId: Schema.NonEmptyString,
  lastSequence: NonNegativeInt
}) {}

/**
 * Raised when an append does not compare-and-set against the current head.
 *
 * @category errors
 * @since 4.0.0
 */
export class SequenceConflict extends Schema.TaggedErrorClass<SequenceConflict>(
  "@effect/workflow-builder/HistoryStore/SequenceConflict"
)("SequenceConflict", {
  runId: Schema.NonEmptyString,
  expectedLastSequence: NonNegativeInt,
  actualLastSequence: NonNegativeInt
}) {}

/**
 * Raised when an event identifier is reused outside its exact original commit.
 *
 * @category errors
 * @since 4.0.0
 */
export class EventIdConflict extends Schema.TaggedErrorClass<EventIdConflict>(
  "@effect/workflow-builder/HistoryStore/EventIdConflict"
)("EventIdConflict", {
  runId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  existingSequence: NonNegativeInt,
  requestedSequence: NonNegativeInt
}) {}

/**
 * Raised when a history-store operation cannot safely validate or perform a
 * request.
 *
 * **Details**
 *
 * Memory-backed validation failures use this error instead of becoming
 * defects. Durable adapters can also use it for operational failures that do
 * not have a more specific concurrency error.
 *
 * @category errors
 * @since 4.0.0
 */
export class HistoryStoreFailure extends Schema.TaggedErrorClass<HistoryStoreFailure>(
  "@effect/workflow-builder/HistoryStore/HistoryStoreFailure"
)("HistoryStoreFailure", {
  operation: Schema.Literals(["start", "append", "read"]),
  message: Schema.NonEmptyString,
  cause: Schema.optionalKey(Schema.Json)
}) {}

/**
 * A receipt for one atomic history commit.
 *
 * **Details**
 *
 * Retrying the exact same start or append returns the original immutable
 * receipt, including after later commits have advanced the run head.
 *
 * @category models
 * @since 4.0.0
 */
export interface CommitReceipt {
  readonly runId: string
  readonly previousSequence: number | null
  readonly lastSequence: number
  readonly events: Arr.NonEmptyReadonlyArray<Event.Event>
}

/**
 * An immutable point-in-time view of one workflow history.
 *
 * @category models
 * @since 4.0.0
 */
export interface HistorySnapshot {
  readonly runId: string
  readonly lastSequence: number
  readonly events: ReadonlyArray<Event.Event>
}

/**
 * Failures reported by history-store operations.
 *
 * @category errors
 * @since 4.0.0
 */
export type HistoryStoreError =
  | HistoryNotFound
  | RunAlreadyExists
  | SequenceConflict
  | EventIdConflict
  | HistoryStoreFailure

/**
 * Atomic workflow-history operations.
 *
 * **Details**
 *
 * The service contract defines sequencing, atomic batches, and exact retry
 * behavior; durability and cross-process coordination are properties of the
 * selected implementation. {@link layerMemory} is process-local and intended
 * for direct execution and tests only.
 *
 * @category services
 * @since 4.0.0
 */
export class HistoryStore extends Context.Service<HistoryStore, HistoryStore.Service>()(
  "@effect/workflow-builder/HistoryStore"
) {}

/**
 * Service contracts for {@link HistoryStore}.
 *
 * @since 4.0.0
 */
export declare namespace HistoryStore {
  /**
   * The history-store service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly start: (options: {
      readonly runId: string
      readonly event: EventDraft<Event.RunStarted>
    }) => Effect.Effect<CommitReceipt, RunAlreadyExists | EventIdConflict | HistoryStoreFailure>
    readonly append: (options: {
      readonly runId: string
      readonly expectedLastSequence: number
      readonly events: Arr.NonEmptyReadonlyArray<EventDraft>
    }) => Effect.Effect<CommitReceipt, HistoryNotFound | SequenceConflict | EventIdConflict | HistoryStoreFailure>
    readonly read: (runId: string) => Effect.Effect<HistorySnapshot, HistoryNotFound | HistoryStoreFailure>
  }
}

interface StoredBatch {
  readonly previousSequence: number | null
  readonly canonicalDrafts: Arr.NonEmptyReadonlyArray<string>
  readonly receipt: CommitReceipt
}

interface StoredEvent {
  readonly event: Event.Event
  readonly batch: StoredBatch
  readonly position: number
}

interface StoredRun {
  readonly events: Chunk.Chunk<Event.Event>
  readonly byEventId: HashMap.HashMap<string, StoredEvent>
}

type MemoryState = HashMap.HashMap<string, StoredRun>

type Operation = "start" | "append" | "read"

const storeFailure = (operation: Operation, message: string, cause?: Schema.Json): HistoryStoreFailure =>
  new HistoryStoreFailure({
    operation,
    message,
    ...(cause === undefined ? undefined : { cause })
  })

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const EventDraftSchema = Schema.Struct({
  eventVersion: Schema.Literal(1),
  eventId: Schema.NonEmptyString,
  causationId: Schema.optionalKey(Schema.NonEmptyString),
  correlationId: Schema.optionalKey(Schema.NonEmptyString),
  payload: Event.Payload
})

const StartRequest = Schema.Struct({
  runId: Schema.NonEmptyString,
  event: EventDraftSchema
})

const AppendRequest = Schema.Struct({
  runId: Schema.NonEmptyString,
  expectedLastSequence: Schema.Number,
  events: Schema.Array(EventDraftSchema)
})

const decodeStartRequest = Schema.decodeUnknownResult(StartRequest, strictParseOptions)
const decodeAppendRequest = Schema.decodeUnknownResult(AppendRequest, strictParseOptions)
const decodeTimestamp = Schema.decodeUnknownResult(Event.Timestamp)

const validateRequest = Effect.fnUntraced(function*<A>(
  operation: "start" | "append",
  input: unknown,
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>
): Effect.fn.Return<A, HistoryStoreFailure> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(storeFailure(operation, `Invalid JSON request: ${snapped.failure.message}`))
  }
  const attempted = yield* Effect.try({
    try: () => decode(snapped.success),
    catch: () => storeFailure(operation, "Request schema validation threw unexpectedly")
  })
  if (Result.isFailure(attempted)) {
    return yield* Effect.fail(storeFailure(operation, "Invalid request", {
      parseError: attempted.failure.message
    }))
  }
  return snapped.success as A
})

const validateRunId = Effect.fnUntraced(function*(
  operation: Operation,
  runId: unknown
): Effect.fn.Return<string, HistoryStoreFailure> {
  if (typeof runId !== "string") {
    return yield* Effect.fail(storeFailure(operation, "runId must be a non-empty string"))
  }
  const result = Schema.decodeUnknownResult(Schema.NonEmptyString)(runId)
  if (Result.isFailure(result)) {
    return yield* Effect.fail(storeFailure(operation, "runId must be a non-empty string", {
      parseError: result.failure.message
    }))
  }
  return result.success
})

const validateExpectedSequence = (
  expectedLastSequence: unknown
): Effect.Effect<number, HistoryStoreFailure> =>
  Number.isSafeInteger(expectedLastSequence) && (expectedLastSequence as number) >= 0
    ? Effect.succeed(expectedLastSequence as number)
    : Effect.fail(storeFailure("append", "expectedLastSequence must be a non-negative safe integer"))

const currentTimestamp = Effect.fnUntraced(function*(
  operation: "start" | "append"
): Effect.fn.Return<Event.Timestamp, HistoryStoreFailure> {
  const now = yield* Effect.catchCause(
    Clock.currentTimeMillis,
    (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(storeFailure(operation, "Clock failed while reading the current time"))
  )
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return yield* Effect.fail(storeFailure(operation, "Clock returned an invalid timestamp"))
  }
  const formatted = yield* Effect.try({
    try: () => DateTime.formatIso(DateTime.makeUnsafe(now)),
    catch: () => storeFailure(operation, "Clock returned an invalid timestamp")
  })
  const decoded = yield* Effect.try({
    try: () => decodeTimestamp(formatted),
    catch: () => storeFailure(operation, "Clock timestamp validation threw unexpectedly")
  })
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(storeFailure(operation, "Clock returned an invalid timestamp", {
      parseError: decoded.failure.message
    }))
  }
  return decoded.success
})

const materialize = (
  runId: string,
  sequence: number,
  recordedAt: Event.Timestamp,
  draft: EventDraft
): Event.Event =>
  Object.freeze({
    eventVersion: draft.eventVersion,
    eventId: draft.eventId,
    runId,
    sequence,
    recordedAt,
    ...(draft.causationId === undefined ? undefined : { causationId: draft.causationId }),
    ...(draft.correlationId === undefined ? undefined : { correlationId: draft.correlationId }),
    payload: draft.payload
  })

const eventConflict = (
  runId: string,
  eventId: string,
  existingSequence: number,
  requestedSequence: number
): EventIdConflict => new EventIdConflict({ runId, eventId, existingSequence, requestedSequence })

const findDuplicate = (
  runId: string,
  drafts: Arr.NonEmptyReadonlyArray<EventDraft>,
  firstSequence: number
): EventIdConflict | undefined => {
  const positions = new Map<string, number>()
  for (let position = 0; position < drafts.length; position++) {
    const draft = drafts[position]!
    const previous = positions.get(draft.eventId)
    if (previous !== undefined) {
      return eventConflict(runId, draft.eventId, firstSequence + previous, firstSequence + position)
    }
    positions.set(draft.eventId, position)
  }
  return undefined
}

const resolveRetry = (
  runId: string,
  run: StoredRun,
  previousSequence: number | null,
  drafts: Arr.NonEmptyReadonlyArray<EventDraft>,
  canonicalDrafts: Arr.NonEmptyReadonlyArray<string>,
  firstSequence: number
): Result.Result<CommitReceipt | undefined, EventIdConflict> => {
  let firstExisting: StoredEvent | undefined
  for (const draft of drafts) {
    const existing = Option.getOrUndefined(HashMap.get(run.byEventId, draft.eventId))
    if (existing !== undefined) {
      firstExisting = existing
      break
    }
  }
  if (firstExisting === undefined) {
    return Result.succeed(undefined)
  }

  const batch = firstExisting.batch
  const exact = batch.previousSequence === previousSequence &&
    batch.canonicalDrafts.length === canonicalDrafts.length &&
    canonicalDrafts.every((canonical, position) =>
      batch.canonicalDrafts[position] === canonical &&
      Option.getOrUndefined(HashMap.get(run.byEventId, drafts[position]!.eventId))?.batch === batch &&
      Option.getOrUndefined(HashMap.get(run.byEventId, drafts[position]!.eventId))?.position === position
    )
  if (exact) {
    return Result.succeed(batch.receipt)
  }

  const requestedPosition = drafts.findIndex((draft, position) => {
    const existing = Option.getOrUndefined(HashMap.get(run.byEventId, draft.eventId))
    return existing !== undefined &&
      (existing.batch !== batch || existing.position !== position ||
        batch.canonicalDrafts[position] !== canonicalDrafts[position])
  })
  const position = requestedPosition === -1
    ? drafts.findIndex((draft) => HashMap.has(run.byEventId, draft.eventId))
    : requestedPosition
  const draft = drafts[position]!
  const existing = Option.getOrUndefined(HashMap.get(run.byEventId, draft.eventId))!
  return Result.fail(eventConflict(runId, draft.eventId, existing.event.sequence, firstSequence + position))
}

const findExactRetry = (
  current: MemoryState,
  runId: string,
  previousSequence: number | null,
  drafts: Arr.NonEmptyReadonlyArray<EventDraft>,
  canonicalDrafts: Arr.NonEmptyReadonlyArray<string>,
  firstSequence: number
): CommitReceipt | undefined => {
  const run = Option.getOrUndefined(HashMap.get(current, runId))
  if (run === undefined) {
    return undefined
  }
  const retry = resolveRetry(runId, run, previousSequence, drafts, canonicalDrafts, firstSequence)
  return Result.isSuccess(retry) ? retry.success : undefined
}

const makeBatch = (
  runId: string,
  previousSequence: number | null,
  recordedAt: Event.Timestamp,
  drafts: Arr.NonEmptyReadonlyArray<EventDraft>,
  canonicalDrafts: Arr.NonEmptyReadonlyArray<string>
): StoredBatch => {
  const frozenCanonicalDrafts = Object.freeze([...canonicalDrafts]) as unknown as Arr.NonEmptyReadonlyArray<string>
  const firstSequence = previousSequence === null ? 0 : previousSequence + 1
  const events = drafts.map((draft, position) =>
    materialize(runId, firstSequence + position, recordedAt, draft)
  ) as unknown as Arr.NonEmptyReadonlyArray<Event.Event>
  const receipt: CommitReceipt = Object.freeze({
    runId,
    previousSequence,
    lastSequence: firstSequence + events.length - 1,
    events: Object.freeze(events)
  })
  return Object.freeze({ previousSequence, canonicalDrafts: frozenCanonicalDrafts, receipt })
}

/**
 * Constructs an isolated process-local in-memory history store.
 *
 * **Details**
 *
 * Each commit performs identifier resolution, retry recognition, head
 * comparison, and insertion in one atomic `Ref` mutation. The implementation
 * does not coordinate with other processes and loses all history on process
 * exit.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory: Effect.Effect<HistoryStore.Service> = Effect.gen(function*() {
  const state = yield* Ref.make<MemoryState>(HashMap.empty())

  const start: HistoryStore.Service["start"] = Effect.fnUntraced(function*(options) {
    const request = yield* validateRequest("start", options, decodeStartRequest)
    const runId = request.runId
    const draft = request.event
    if (draft.payload._tag !== "RunStarted") {
      return yield* Effect.fail(storeFailure("start", "The start event payload must be RunStarted"))
    }
    const canonicalDrafts = Object.freeze([
      Json.canonicalizeSnapshot(draft as unknown as Schema.Json)
    ]) as Arr.NonEmptyReadonlyArray<string>
    const exactRetry = findExactRetry(yield* Ref.get(state), runId, null, [draft], canonicalDrafts, 0)
    if (exactRetry !== undefined) {
      return exactRetry
    }
    const recordedAt = yield* currentTimestamp("start")
    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<CommitReceipt, RunAlreadyExists | EventIdConflict | HistoryStoreFailure>,
      MemoryState
    ] => {
      const run = Option.getOrUndefined(HashMap.get(current, runId))
      if (run !== undefined) {
        const retry = resolveRetry(runId, run, null, [draft], canonicalDrafts, 0)
        if (Result.isFailure(retry)) {
          return [Result.fail(retry.failure), current]
        }
        if (retry.success !== undefined) {
          return [Result.succeed(retry.success), current] as const
        }
        return [
          Result.fail(
            new RunAlreadyExists({
              runId,
              lastSequence: Chunk.size(run.events) - 1
            })
          ),
          current
        ] as const
      }

      const duplicate = findDuplicate(runId, [draft], 0)
      if (duplicate !== undefined) {
        return [Result.fail(duplicate), current] as const
      }
      const batch = makeBatch(runId, null, recordedAt, [draft], canonicalDrafts)
      const stored: StoredEvent = Object.freeze({ event: batch.receipt.events[0], batch, position: 0 })
      const runs = HashMap.set(
        current,
        runId,
        Object.freeze({
          events: Chunk.fromIterable(batch.receipt.events),
          byEventId: HashMap.make([draft.eventId, stored])
        })
      )
      return [Result.succeed(batch.receipt), runs] as const
    })
    return yield* Effect.fromResult(result)
  })

  const append: HistoryStore.Service["append"] = Effect.fnUntraced(function*(options) {
    const request = yield* validateRequest("append", options, decodeAppendRequest)
    const runId = request.runId
    const expectedLastSequence = yield* validateExpectedSequence(request.expectedLastSequence)
    if (request.events.length === 0) {
      return yield* Effect.fail(storeFailure("append", "events must be a non-empty array"))
    }
    const drafts = request.events as unknown as Arr.NonEmptyReadonlyArray<EventDraft>
    const canonicalDrafts = Object.freeze(
      drafts.map((draft) => Json.canonicalizeSnapshot(draft as unknown as Schema.Json))
    ) as unknown as Arr.NonEmptyReadonlyArray<string>
    const exactRetry = findExactRetry(
      yield* Ref.get(state),
      runId,
      expectedLastSequence,
      drafts,
      canonicalDrafts,
      expectedLastSequence + 1
    )
    if (exactRetry !== undefined) {
      return exactRetry
    }
    const recordedAt = yield* currentTimestamp("append")
    const result = yield* Ref.modify(state, (current): readonly [
      Result.Result<CommitReceipt, HistoryNotFound | SequenceConflict | EventIdConflict | HistoryStoreFailure>,
      MemoryState
    ] => {
      const firstSequence = expectedLastSequence + 1
      const duplicate = findDuplicate(runId, drafts, firstSequence)
      if (duplicate !== undefined) {
        return [Result.fail(duplicate), current] as const
      }
      const run = Option.getOrUndefined(HashMap.get(current, runId))
      if (run === undefined) {
        return [Result.fail(new HistoryNotFound({ runId })), current] as const
      }
      const retry = resolveRetry(
        runId,
        run,
        expectedLastSequence,
        drafts,
        canonicalDrafts,
        firstSequence
      )
      if (Result.isFailure(retry)) {
        return [Result.fail(retry.failure), current]
      }
      if (retry.success !== undefined) {
        return [Result.succeed(retry.success), current] as const
      }
      const actualLastSequence = Chunk.size(run.events) - 1
      if (expectedLastSequence !== actualLastSequence) {
        return [
          Result.fail(
            new SequenceConflict({
              runId,
              expectedLastSequence,
              actualLastSequence
            })
          ),
          current
        ] as const
      }

      const batch = makeBatch(runId, expectedLastSequence, recordedAt, drafts, canonicalDrafts)
      let byEventId = run.byEventId
      batch.receipt.events.forEach((event, position) => {
        byEventId = HashMap.set(byEventId, event.eventId, Object.freeze({ event, batch, position }))
      })
      const runs = HashMap.set(
        current,
        runId,
        Object.freeze({
          events: Chunk.appendAll(run.events, Chunk.fromIterable(batch.receipt.events)),
          byEventId
        })
      )
      return [Result.succeed(batch.receipt), runs] as const
    })
    return yield* Effect.fromResult(result)
  })

  const read: HistoryStore.Service["read"] = Effect.fnUntraced(function*(runId) {
    runId = yield* validateRunId("read", runId)
    const current = yield* Ref.get(state)
    const run = Option.getOrUndefined(HashMap.get(current, runId))
    if (run === undefined) {
      return yield* Effect.fail(new HistoryNotFound({ runId }))
    }
    return Object.freeze({
      runId,
      lastSequence: Chunk.size(run.events) - 1,
      events: Object.freeze([...Chunk.toReadonlyArray(run.events)])
    })
  })

  return HistoryStore.of(Object.freeze({ start, append, read }))
})

/**
 * Provides a fresh process-local in-memory {@link HistoryStore}.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<HistoryStore> = Layer.effect(HistoryStore, makeMemory)
