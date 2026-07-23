/**
 * Process-local reference authority for protocol version `2` signal admission.
 *
 * **Details**
 *
 * This module is an executable transaction specification, not a persistence
 * claim. It validates immutable run artifacts and history, resolves exact
 * runtime codec and policy pins, computes store-owned facts, and commits the
 * accepted signal, expiry timer, receipt, timer index, counters, and wake
 * revision in one `Ref` mutation. A persistent adapter must preserve the same
 * transaction boundary across process and machine failure.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as DigestV2 from "./DigestV2.ts"
import * as EventV2 from "./EventV2.ts"
import * as IdentityV2 from "./IdentityV2.ts"
import * as Bytes from "./internal/bytes.ts"
import * as Json from "./internal/json.ts"
import * as PlanStoreV2 from "./PlanStoreV2.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as RunStateV2 from "./RunStateV2.ts"
import * as SemanticTime from "./SemanticTime.ts"
import * as SignalContractV2 from "./SignalContractV2.ts"
import * as SignalIngressV2 from "./SignalIngressV2.ts"
import * as SignalRuntimeV2 from "./SignalRuntimeV2.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const decodeBoundPlan = Schema.decodeUnknownResult(
  PlanStoreV2.BoundPlan,
  strictParseOptions
)
const decodeHistory = Schema.decodeUnknownResult(
  Schema.Array(EventV2.Event),
  strictParseOptions
)
const decodeRequest = Schema.decodeUnknownResult(
  SignalIngressV2.Request,
  strictParseOptions
)

/**
 * Stable process-local authority construction failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const InvalidSeedCodes = {
  InvalidOptions: "InvalidOptions",
  InvalidBoundPlan: "InvalidBoundPlan",
  InvalidHistory: "InvalidHistory",
  ArtifactDigestMismatch: "ArtifactDigestMismatch",
  DefinitionDigestMismatch: "DefinitionDigestMismatch",
  RuntimePinMismatch: "RuntimePinMismatch",
  BindingMismatch: "BindingMismatch",
  DuplicateRun: "DuplicateRun",
  BlobUnavailable: "BlobUnavailable",
  CryptoUnavailable: "CryptoUnavailable"
} as const

/**
 * A stable process-local authority construction failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type InvalidSeedCode = typeof InvalidSeedCodes[keyof typeof InvalidSeedCodes]

const InvalidSeedCode = Schema.Literals([
  InvalidSeedCodes.InvalidOptions,
  InvalidSeedCodes.InvalidBoundPlan,
  InvalidSeedCodes.InvalidHistory,
  InvalidSeedCodes.ArtifactDigestMismatch,
  InvalidSeedCodes.DefinitionDigestMismatch,
  InvalidSeedCodes.RuntimePinMismatch,
  InvalidSeedCodes.BindingMismatch,
  InvalidSeedCodes.DuplicateRun,
  InvalidSeedCodes.BlobUnavailable,
  InvalidSeedCodes.CryptoUnavailable
])

/**
 * Raised when a process-local authority cannot safely install one exact run.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidMemorySeed extends Schema.TaggedErrorClass<InvalidMemorySeed>(
  "@effect/workflow-builder/SignalAuthorityV2/InvalidMemorySeed"
)("InvalidMemorySeed", {
  index: ProtocolV2Wire.NonNegativeSafeInt,
  code: InvalidSeedCode,
  message: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * A protocol version `2` run installed in the process-local authority.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemoryRunSeed {
  readonly boundPlan: PlanStoreV2.BoundPlan
  readonly history: ReadonlyArray<EventV2.Event>
}

/**
 * Stable immutable-blob read failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const BlobReadFailureCodes = {
  NotFound: "NotFound",
  Unavailable: "Unavailable"
} as const

/**
 * A trusted blob reader's bounded failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class BlobReadFailure extends Schema.TaggedErrorClass<BlobReadFailure>(
  "@effect/workflow-builder/SignalAuthorityV2/BlobReadFailure"
)("BlobReadFailure", {
  code: Schema.Literals([
    BlobReadFailureCodes.NotFound,
    BlobReadFailureCodes.Unavailable
  ])
}, { parseOptions: strictParseOptions }) {}

/**
 * Reads exact immutable blob bytes inside a tenant and run scope.
 *
 * **Details**
 *
 * The authority independently verifies the returned byte count, SHA-256
 * digest, UTF-8 JSON encoding, and payload codec. A reader never receives
 * credentials through the portable request or history.
 *
 * @category models
 * @since 4.0.0
 */
export interface BlobReader {
  readonly read: (request: {
    readonly key: PlanStoreV2.RunKey
    readonly ref: ProtocolV2Wire.BlobRef
    readonly maximumBytes: number
  }) => Effect.Effect<Uint8Array, BlobReadFailure>
}

/**
 * Input used to construct the process-local signal authority.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemoryOptions {
  readonly runs: ReadonlyArray<MemoryRunSeed>
  readonly runtimes: SignalRuntimeV2.SignalRuntimeRegistry.Service
  readonly blobReader?: BlobReader | undefined
}

/**
 * One indexed live signal-expiry timer.
 *
 * @category models
 * @since 4.0.0
 */
export interface IndexedTimer {
  readonly timerId: string
  readonly deadline: EventV2.Timestamp
  readonly historySequence: number
}

/**
 * One bounded overflow record retained outside semantic run history.
 *
 * @category models
 * @since 4.0.0
 */
export interface DeadLetterRecord {
  readonly signalId: string
  readonly requestDigest: ProtocolV2Wire.RequestDigest
  readonly payloadDigest: ProtocolV2Wire.PayloadDigest
  readonly payload: ProtocolV2Wire.EncodedPayload
  readonly encodedPayloadBytes: number
  readonly admission: ProtocolV2Wire.AdmissionAttribution
  readonly recordedAt: EventV2.Timestamp
  readonly expiresAt: EventV2.Timestamp
}

/**
 * Detached process-local run state exposed for conformance tests.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemorySnapshot {
  readonly boundPlan: PlanStoreV2.BoundPlan
  readonly history: ReadonlyArray<EventV2.Event>
  readonly replay: RunStateV2.RunState
  readonly receipts: ReadonlyArray<SignalIngressV2.Receipt>
  readonly indexedTimers: ReadonlyArray<IndexedTimer>
  readonly deadLetters: ReadonlyArray<DeadLetterRecord>
  readonly wakeRevision: number
}

/**
 * Services produced by the process-local signal authority.
 *
 * @category models
 * @since 4.0.0
 */
export interface MemoryServices {
  readonly ingress: SignalIngressV2.SignalIngressV2.Service
  readonly inspect: (
    key: PlanStoreV2.RunKey
  ) => Effect.Effect<MemorySnapshot | undefined>
}

interface AcceptedOutcome {
  readonly _tag: "AcceptedOutcome"
  readonly requestDigest: ProtocolV2Wire.RequestDigest
  readonly receipt: SignalIngressV2.Receipt
}

interface DeadLetterOutcome {
  readonly _tag: "DeadLetterOutcome"
  readonly requestDigest: ProtocolV2Wire.RequestDigest
  readonly record: DeadLetterRecord
}

type StoredOutcome = AcceptedOutcome | DeadLetterOutcome

interface StoredRun {
  readonly boundPlan: PlanStoreV2.BoundPlan
  readonly history: ReadonlyArray<EventV2.Event>
  readonly replay: RunStateV2.RunState
  readonly outcomes: HashMap.HashMap<string, StoredOutcome>
  readonly timers: HashMap.HashMap<string, IndexedTimer>
  readonly deadLetters: HashMap.HashMap<string, DeadLetterRecord>
  readonly deadLetterEncodedBytes: number
  readonly wakeRevision: number
}

interface MemoryState {
  readonly runs: HashMap.HashMap<string, StoredRun>
}

interface PreparedAdmission {
  readonly request: SignalIngressV2.Request
  readonly requestDigest: ProtocolV2Wire.RequestDigest
  readonly definition: SignalContractV2.SignalCatalogEntry
  readonly payload: ProtocolV2Wire.EncodedPayload
  readonly payloadDigest: ProtocolV2Wire.PayloadDigest
  readonly encodedPayloadBytes: number
  readonly admission: ProtocolV2Wire.AdmissionAttribution
  readonly recordedAt: EventV2.Timestamp
}

type CommitResult =
  | SignalIngressV2.AdmissionResult
  | SignalIngressV2.SignalIngressUnavailable

const storageKey = (key: PlanStoreV2.RunKey): string => JSON.stringify([key.tenantId, key.runId])

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

const unavailable = (
  code: SignalIngressV2.UnavailableCode,
  message: string
): SignalIngressV2.SignalIngressUnavailable => new SignalIngressV2.SignalIngressUnavailable({ code, message })

const rejected = (
  reason: SignalContractV2.SignalRejectionReason
): SignalIngressV2.Rejected =>
  Object.freeze({
    _tag: "Rejected",
    reason
  })

const invalidSeed = (
  index: number,
  code: InvalidSeedCode,
  message: string
): InvalidMemorySeed => new InvalidMemorySeed({ index, code, message })

const getRun = (
  state: MemoryState,
  key: PlanStoreV2.RunKey
): StoredRun | undefined => Option.getOrUndefined(HashMap.get(state.runs, storageKey(key)))

const isClosedToSignalAdmission = (run: StoredRun): boolean =>
  run.replay.status === "CancellationRequested" ||
  run.replay.status === "Succeeded" ||
  run.replay.status === "Failed" ||
  run.replay.status === "Cancelled"

const findDefinition = (
  run: StoredRun,
  name: string,
  version: string
): SignalContractV2.SignalCatalogEntry | undefined => {
  const key = SignalContractV2.signalDefinitionKey(name, version)
  return run.boundPlan.artifact.signalManifest.definitions.find(
    (entry) => entry.key === key
  )
}

const snapshotRequest = (
  input: unknown
): SignalIngressV2.Request | undefined => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return undefined
  }
  let decoded: ReturnType<typeof decodeRequest>
  try {
    decoded = decodeRequest(snapshot.success)
  } catch {
    return undefined
  }
  return Result.isFailure(decoded)
    ? undefined
    : snapshot.success as unknown as SignalIngressV2.Request
}

const captureActor = (
  input: unknown
): SignalRuntimeV2.TrustedActorContext | undefined => {
  try {
    if (typeof input !== "object" || input === null) {
      return undefined
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const actorId = descriptors.actorId
    const authenticationContext = descriptors.authenticationContext
    if (
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(descriptors).length !== 2 ||
      actorId === undefined ||
      authenticationContext === undefined ||
      !Object.prototype.hasOwnProperty.call(actorId, "value") ||
      !Object.prototype.hasOwnProperty.call(authenticationContext, "value") ||
      actorId.enumerable !== true ||
      authenticationContext.enumerable !== true ||
      typeof actorId.value !== "string"
    ) {
      return undefined
    }
    const actor = SignalRuntimeV2.fromTrustedActor(
      actorId.value,
      authenticationContext.value
    )
    return Result.isFailure(actor) ? undefined : actor.success
  } catch {
    return undefined
  }
}

const timestamp = (millis: number): EventV2.Timestamp | undefined => {
  try {
    const value = new Date(millis).toISOString()
    const decoded = Schema.decodeUnknownResult(
      ProtocolV2Wire.Timestamp
    )(value)
    return Result.isFailure(decoded) ? undefined : decoded.success
  } catch {
    return undefined
  }
}

const quotaReason = (
  run: StoredRun,
  encodedPayloadBytes: number
): SignalContractV2.SignalRejectionReason | undefined => {
  const policy = run.boundPlan.artifact.signalManifest.inboxPolicy
  if (run.replay.acceptedSignalCount >= policy.maxAcceptedCount) {
    return SignalContractV2.SignalRejectionReasons.InboxCountExceeded
  }
  if (run.replay.pendingSignalCount >= policy.maxPendingCount) {
    return SignalContractV2.SignalRejectionReasons.PendingCountExceeded
  }
  if (
    run.replay.pendingSignalEncodedBytes + encodedPayloadBytes >
      policy.maxPendingEncodedBytes
  ) {
    return SignalContractV2.SignalRejectionReasons.PendingBytesExceeded
  }
  return undefined
}

const liveOutcome = (
  run: StoredRun,
  signalId: string,
  nowMillis: number
): StoredOutcome | undefined => {
  const outcome = Option.getOrUndefined(HashMap.get(run.outcomes, signalId))
  if (
    outcome?._tag === "DeadLetterOutcome" &&
    Date.parse(outcome.record.expiresAt) < nowMillis
  ) {
    return undefined
  }
  return outcome
}

const duplicateOrConflict = (
  outcome: StoredOutcome,
  requestDigest: ProtocolV2Wire.RequestDigest,
  actorId: string
): SignalIngressV2.AdmissionResult =>
  outcome._tag === "AcceptedOutcome" &&
      outcome.receipt.admission.actorId !== actorId ||
    outcome._tag === "DeadLetterOutcome" &&
      outcome.record.admission.actorId !== actorId
    ? rejected(SignalContractV2.SignalRejectionReasons.Unauthorized)
    : outcome.requestDigest !== requestDigest
    ? rejected(SignalContractV2.SignalRejectionReasons.SignalIdConflict)
    : outcome._tag === "AcceptedOutcome"
    ? Object.freeze({
      _tag: "Duplicate",
      receipt: outcome.receipt
    })
    : rejected(SignalContractV2.SignalRejectionReasons.DeadLettered)

const pruneDeadLetters = (
  run: StoredRun,
  nowMillis: number
): StoredRun => {
  let outcomes = run.outcomes
  let deadLetters = run.deadLetters
  let deadLetterEncodedBytes = run.deadLetterEncodedBytes
  for (const [signalId, record] of HashMap.entries(run.deadLetters)) {
    if (Date.parse(record.expiresAt) >= nowMillis) {
      continue
    }
    deadLetters = HashMap.remove(deadLetters, signalId)
    outcomes = HashMap.remove(outcomes, signalId)
    deadLetterEncodedBytes -= record.encodedPayloadBytes
  }
  return deadLetters === run.deadLetters
    ? run
    : Object.freeze({
      ...run,
      outcomes,
      deadLetters,
      deadLetterEncodedBytes
    })
}

const deadLetter = (
  run: StoredRun,
  prepared: PreparedAdmission
): readonly [CommitResult, StoredRun] => {
  const overflow = run.boundPlan.artifact.signalManifest.inboxPolicy.overflow
  if (
    overflow._tag !== "DeadLetter" ||
    HashMap.size(run.deadLetters) >= overflow.maxCount ||
    run.deadLetterEncodedBytes + prepared.encodedPayloadBytes >
      overflow.maxEncodedBytes
  ) {
    return [
      rejected(quotaReason(run, prepared.encodedPayloadBytes)!),
      run
    ]
  }
  const expiresAtResult = SemanticTime.materializeDeadline(
    prepared.recordedAt,
    overflow.retentionMillis
  )
  if (Result.isFailure(expiresAtResult)) {
    return [
      unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Dead-letter retention deadline could not be represented"
      ),
      run
    ]
  }
  const record: DeadLetterRecord = Object.freeze({
    signalId: prepared.request.signalId,
    requestDigest: prepared.requestDigest,
    payloadDigest: prepared.payloadDigest,
    payload: prepared.payload,
    encodedPayloadBytes: prepared.encodedPayloadBytes,
    admission: prepared.admission,
    recordedAt: prepared.recordedAt,
    expiresAt: expiresAtResult.success
  })
  return [
    rejected(SignalContractV2.SignalRejectionReasons.DeadLettered),
    Object.freeze({
      ...run,
      outcomes: HashMap.set(
        run.outcomes,
        record.signalId,
        Object.freeze({
          _tag: "DeadLetterOutcome",
          requestDigest: record.requestDigest,
          record
        })
      ),
      deadLetters: HashMap.set(run.deadLetters, record.signalId, record),
      deadLetterEncodedBytes: run.deadLetterEncodedBytes +
        record.encodedPayloadBytes
    })
  ]
}

const commitAdmission = (
  original: StoredRun,
  prepared: PreparedAdmission,
  nowMillis: number
): readonly [CommitResult, StoredRun] => {
  const run = pruneDeadLetters(original, nowMillis)
  const existing = liveOutcome(run, prepared.request.signalId, nowMillis)
  if (existing !== undefined) {
    return [
      duplicateOrConflict(
        existing,
        prepared.requestDigest,
        prepared.admission.actorId
      ),
      run
    ]
  }
  if (
    prepared.request.expectedArtifactDigest !==
      run.boundPlan.binding.artifactDigest
  ) {
    return [
      rejected(SignalContractV2.SignalRejectionReasons.WrongArtifact),
      run
    ]
  }
  if (isClosedToSignalAdmission(run)) {
    return [
      rejected(SignalContractV2.SignalRejectionReasons.TerminalRun),
      run
    ]
  }
  const currentDefinition = findDefinition(
    run,
    prepared.request.signalName,
    prepared.request.signalVersion
  )
  if (
    currentDefinition === undefined ||
    currentDefinition.definitionDigest !==
      prepared.definition.definitionDigest
  ) {
    return [
      rejected(SignalContractV2.SignalRejectionReasons.UnknownSignal),
      run
    ]
  }
  const committedAt = timestamp(Math.max(
    nowMillis,
    Date.parse(prepared.recordedAt),
    Date.parse(run.replay.lastRecordedAt)
  ))
  if (committedAt === undefined) {
    return [
      unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Store commit time could not be represented canonically"
      ),
      run
    ]
  }
  prepared = Object.freeze({
    ...prepared,
    recordedAt: committedAt
  })
  const overflow = quotaReason(run, prepared.encodedPayloadBytes)
  if (overflow !== undefined) {
    return run.boundPlan.artifact.signalManifest.inboxPolicy.overflow._tag ===
        "DeadLetter"
      ? deadLetter(run, prepared)
      : [rejected(overflow), run]
  }
  const inboxSequence = run.replay.nextInboxSequence
  const acceptedSequence = run.replay.sequence + 1
  const timerSequence = acceptedSequence + 1
  const wakeRevision = run.wakeRevision + 1
  if (
    !Number.isSafeInteger(acceptedSequence) ||
    !Number.isSafeInteger(timerSequence) ||
    !Number.isSafeInteger(wakeRevision)
  ) {
    return [
      unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Signal commit counters exceed safe-integer bounds"
      ),
      run
    ]
  }
  const definition = prepared.definition.definition
  const expiryTimerId = IdentityV2.timerId(
    prepared.request.key.tenantId,
    prepared.request.key.runId,
    "SignalExpiry",
    prepared.request.signalId
  )
  const expiresAt = SemanticTime.materializeDeadline(
    prepared.recordedAt,
    definition.ttlMillis
  )
  if (Result.isFailure(expiresAt)) {
    return [
      unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Signal expiry deadline could not be represented"
      ),
      run
    ]
  }
  const acceptedEventId = IdentityV2.signalAcceptedEventId(
    prepared.request.key.tenantId,
    prepared.request.key.runId,
    prepared.request.signalId
  )
  const acceptedEvent: EventV2.Event = Object.freeze({
    eventVersion: EventV2.EventVersion,
    tenantId: prepared.request.key.tenantId,
    runId: prepared.request.key.runId,
    eventId: acceptedEventId,
    sequence: acceptedSequence,
    recordedAt: prepared.recordedAt,
    correlationId: prepared.request.signalId,
    payload: Object.freeze({
      _tag: "SignalAccepted",
      signalId: prepared.request.signalId,
      inboxSequence,
      signalName: prepared.request.signalName,
      signalVersion: prepared.request.signalVersion,
      correlation: prepared.request.correlation,
      signalDefinitionDigest: prepared.definition.definitionDigest,
      requestDigest: prepared.requestDigest,
      payload: prepared.payload,
      payloadDigest: prepared.payloadDigest,
      encodedPayloadBytes: prepared.encodedPayloadBytes,
      ttlMillis: definition.ttlMillis,
      admission: prepared.admission,
      expiresAt: expiresAt.success,
      expiryTimerId
    })
  })
  const timerEvent: EventV2.Event = Object.freeze({
    eventVersion: EventV2.EventVersion,
    tenantId: prepared.request.key.tenantId,
    runId: prepared.request.key.runId,
    eventId: IdentityV2.scheduleTimerCommandId(
      prepared.request.key.tenantId,
      prepared.request.key.runId,
      expiryTimerId
    ),
    sequence: timerSequence,
    recordedAt: prepared.recordedAt,
    causationId: acceptedEventId,
    correlationId: prepared.request.signalId,
    payload: Object.freeze({
      _tag: "TimerScheduled",
      timerId: expiryTimerId,
      purpose: Object.freeze({
        _tag: "SignalExpiry",
        signalId: prepared.request.signalId,
        inboxSequence
      }),
      anchorEventId: acceptedEventId,
      delayMillis: definition.ttlMillis,
      deadline: expiresAt.success
    })
  })
  const history = Object.freeze([
    ...run.history,
    acceptedEvent,
    timerEvent
  ])
  const replay = RunStateV2.fold(history)
  if (Result.isFailure(replay)) {
    return [
      unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        `Signal transaction violated history semantics: ${replay.failure.code}`
      ),
      run
    ]
  }
  const receipt: SignalIngressV2.Receipt = Object.freeze({
    receiptVersion: 1,
    key: prepared.request.key,
    artifactDigest: run.boundPlan.binding.artifactDigest,
    signalDefinitionDigest: prepared.definition.definitionDigest,
    signalId: prepared.request.signalId,
    signalName: prepared.request.signalName,
    signalVersion: prepared.request.signalVersion,
    requestDigest: prepared.requestDigest,
    payloadDigest: prepared.payloadDigest,
    encodedPayloadBytes: prepared.encodedPayloadBytes,
    inboxSequence,
    historySequence: acceptedSequence,
    acceptedEventId,
    expiryTimerId,
    acceptedAt: prepared.recordedAt,
    expiresAt: expiresAt.success,
    admission: prepared.admission
  })
  const timer: IndexedTimer = Object.freeze({
    timerId: expiryTimerId,
    deadline: expiresAt.success,
    historySequence: timerSequence
  })
  const updated: StoredRun = Object.freeze({
    ...run,
    history,
    replay: replay.success,
    outcomes: HashMap.set(
      run.outcomes,
      receipt.signalId,
      Object.freeze({
        _tag: "AcceptedOutcome",
        requestDigest: receipt.requestDigest,
        receipt
      })
    ),
    timers: HashMap.set(run.timers, timer.timerId, timer),
    wakeRevision
  })
  return [
    Object.freeze({ _tag: "Accepted", receipt }),
    updated
  ]
}

const inspectRun = (run: StoredRun): MemorySnapshot =>
  Object.freeze({
    boundPlan: run.boundPlan,
    history: Object.freeze([...run.history]),
    replay: run.replay,
    receipts: Object.freeze(
      Array.from(HashMap.values(run.outcomes))
        .filter((outcome): outcome is AcceptedOutcome => outcome._tag === "AcceptedOutcome")
        .map((outcome) => outcome.receipt)
        .sort((left, right) => left.inboxSequence - right.inboxSequence)
    ),
    indexedTimers: Object.freeze(
      Array.from(HashMap.values(run.timers))
        .sort((left, right) => left.historySequence - right.historySequence)
    ),
    deadLetters: Object.freeze(
      Array.from(HashMap.values(run.deadLetters))
        .sort((left, right) => left.signalId.localeCompare(right.signalId))
    ),
    wakeRevision: run.wakeRevision
  })

/**
 * Constructs an isolated process-local protocol version `2` signal authority.
 *
 * **Details**
 *
 * Every seed is strict-decoded, content-digest checked, artifact-bound, and
 * replayed before the service becomes visible. Exact runtime pins must be
 * installed for every signal definition. The returned service then owns
 * acceptance time, inbox/history order, identities, digests, receipts, timer
 * indexing, and wake revisions.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory = Effect.fnUntraced(function*(
  options: MemoryOptions
): Effect.fn.Return<
  Readonly<MemoryServices>,
  InvalidMemorySeed,
  Clock.Clock | Crypto.Crypto
> {
  const crypto = yield* Crypto.Crypto
  const clock = yield* Clock.Clock
  if (
    typeof options !== "object" ||
    options === null ||
    !Array.isArray(options.runs) ||
    !SignalRuntimeV2.isSignalRuntimeRegistry(options.runtimes)
  ) {
    return yield* Effect.fail(invalidSeed(
      0,
      InvalidSeedCodes.InvalidOptions,
      "Memory signal authority options are invalid"
    ))
  }
  const runtimes = options.runtimes
  const runSeeds = [...options.runs]

  const hashArtifact = (index: number, value: Schema.Json) =>
    DigestV2.artifact(value).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.CryptoUnavailable,
            "Artifact digest computation failed"
          ))
      )
    )
  const hashDefinition = (index: number, value: Schema.Json) =>
    DigestV2.definition(value).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.CryptoUnavailable,
            "Signal definition digest computation failed"
          ))
      )
    )
  const hashPayload = (value: Schema.Json) =>
    DigestV2.payload(value).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(unavailable(
            SignalIngressV2.UnavailableCodes.StoreUnavailable,
            "Payload digest computation failed"
          ))
      )
    )
  const hashRequest = (value: Schema.Json) =>
    DigestV2.request(value).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(unavailable(
            SignalIngressV2.UnavailableCodes.StoreUnavailable,
            "Request digest computation failed"
          ))
      )
    )
  const hashBlob = (bytes: Uint8Array) =>
    DigestV2.blob(bytes).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(unavailable(
            SignalIngressV2.UnavailableCodes.BlobUnavailable,
            "Blob digest computation failed"
          ))
      )
    )

  const blobReader = options.blobReader
  const loadBlobJson = Effect.fnUntraced(function*(
    key: PlanStoreV2.RunKey,
    ref: ProtocolV2Wire.BlobRef,
    maximumBytes: number
  ): Effect.fn.Return<
    Schema.Json,
    SignalIngressV2.SignalIngressUnavailable
  > {
    if (blobReader === undefined) {
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.BlobUnavailable,
        "No immutable blob reader is installed"
      ))
    }
    const returned = yield* blobReader.read({
      key,
      ref,
      maximumBytes
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(unavailable(
            SignalIngressV2.UnavailableCodes.BlobUnavailable,
            "Immutable blob bytes are unavailable"
          ))
      )
    )
    const bytes = yield* Effect.try({
      try: () => {
        if (
          !(returned instanceof Uint8Array) ||
          returned.byteLength !== ref.encodedBytes ||
          returned.byteLength > maximumBytes ||
          ref.mediaType !== "application/json"
        ) {
          throw new TypeError("Invalid immutable blob result")
        }
        const copied = Bytes.copyUint8Array(returned)
        if (copied.byteLength !== ref.encodedBytes) {
          throw new TypeError("Immutable blob changed while being copied")
        }
        return copied
      },
      catch: () =>
        unavailable(
          SignalIngressV2.UnavailableCodes.BlobUnavailable,
          "Immutable blob metadata, size, or snapshot verification failed"
        )
    })
    const digest = yield* hashBlob(bytes)
    if (digest !== ref.digest) {
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.BlobUnavailable,
        "Immutable blob digest verification failed"
      ))
    }
    return yield* Effect.try({
      try: () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        const parsed: unknown = JSON.parse(text)
        const snapshot = Json.snapshot(parsed)
        if (Result.isFailure(snapshot)) {
          throw new TypeError("Blob JSON is not strict")
        }
        return snapshot.success
      },
      catch: () =>
        unavailable(
          SignalIngressV2.UnavailableCodes.BlobUnavailable,
          "Immutable blob is not strict UTF-8 JSON"
        )
    })
  })

  let runs = HashMap.empty<string, StoredRun>()
  for (let index = 0; index < runSeeds.length; index++) {
    const seed = runSeeds[index]!
    const boundSnapshot = Json.snapshot(seed?.boundPlan)
    if (Result.isFailure(boundSnapshot)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidBoundPlan,
        "Run seed bound plan is not strict JSON"
      ))
    }
    let decodedBound: ReturnType<typeof decodeBoundPlan>
    try {
      decodedBound = decodeBoundPlan(boundSnapshot.success)
    } catch {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidBoundPlan,
        "Run seed bound plan could not be inspected safely"
      ))
    }
    if (Result.isFailure(decodedBound)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidBoundPlan,
        "Run seed bound plan failed strict schema validation"
      ))
    }
    const boundPlan = boundSnapshot.success as unknown as PlanStoreV2.BoundPlan
    const artifactValidation = PlanStoreV2.validateArtifact(boundPlan.artifact)
    if (Result.isFailure(artifactValidation)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidBoundPlan,
        "Run seed artifact failed relational validation"
      ))
    }
    const artifactDigest = yield* hashArtifact(
      index,
      boundPlan.artifact as unknown as Schema.Json
    )
    if (artifactDigest !== boundPlan.binding.artifactDigest) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.ArtifactDigestMismatch,
        "Run seed binding does not match its artifact content digest"
      ))
    }
    const resolvedDefinitions = new Map<
      string,
      SignalRuntimeV2.ResolvedSignalRuntime
    >()
    for (
      const entry of boundPlan.artifact.signalManifest.definitions
    ) {
      const definitionDigest = yield* hashDefinition(
        index,
        entry.definition as unknown as Schema.Json
      )
      if (definitionDigest !== entry.definitionDigest) {
        return yield* Effect.fail(invalidSeed(
          index,
          InvalidSeedCodes.DefinitionDigestMismatch,
          "Signal catalog entry does not match its definition content digest"
        ))
      }
      const runtime = yield* runtimes.resolve(entry).pipe(Effect.result)
      if (Result.isFailure(runtime)) {
        return yield* Effect.fail(invalidSeed(
          index,
          InvalidSeedCodes.RuntimePinMismatch,
          "Exact signal runtime pins are unavailable"
        ))
      }
      resolvedDefinitions.set(entry.key, runtime.success)
    }

    const historySnapshot = Json.snapshot(seed?.history)
    if (Result.isFailure(historySnapshot)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidHistory,
        "Run seed history is not strict JSON"
      ))
    }
    let decodedEvents: ReturnType<typeof decodeHistory>
    try {
      decodedEvents = decodeHistory(historySnapshot.success)
    } catch {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidHistory,
        "Run seed history could not be inspected safely"
      ))
    }
    if (Result.isFailure(decodedEvents)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidHistory,
        "Run seed history failed strict schema validation"
      ))
    }
    const history = Object.freeze(
      historySnapshot.success as unknown as ReadonlyArray<EventV2.Event>
    )
    const replay = RunStateV2.fold(history)
    if (Result.isFailure(replay)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.InvalidHistory,
        `Run seed history failed replay: ${replay.failure.code}`
      ))
    }
    const plan = boundPlan.artifact.fingerprintDocument.plan
    if (
      replay.success.tenantId !== boundPlan.binding.key.tenantId ||
      replay.success.runId !== boundPlan.binding.key.runId ||
      replay.success.artifactDigest !== boundPlan.binding.artifactDigest ||
      replay.success.workflowIdentity !== boundPlan.binding.workflowIdentity ||
      replay.success.startRequestId !== boundPlan.binding.requestId ||
      replay.success.compiledFingerprint !==
        boundPlan.artifact.compiledFingerprint ||
      replay.success.planId !== plan.id ||
      replay.success.planRevision !== plan.revision ||
      replay.success.definitionId !== plan.definition.id ||
      replay.success.definitionVersion !== plan.definition.version ||
      replay.success.compilerVersion !==
        boundPlan.artifact.fingerprintDocument.compilerSemanticVersion ||
      history[0]?.eventId !== boundPlan.binding.runStartedEventId
    ) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.BindingMismatch,
        "Run seed history, binding, and artifact identities disagree"
      ))
    }
    for (const event of history) {
      if (event.payload._tag !== "SignalAccepted") {
        continue
      }
      const payload = event.payload
      const entry = boundPlan.artifact.signalManifest.definitions.find(
        (candidate) =>
          candidate.definition.name === payload.signalName &&
          candidate.definition.version === payload.signalVersion
      )
      if (
        entry === undefined ||
        entry.definitionDigest !== payload.signalDefinitionDigest ||
        entry.definition.authorizationPolicy.id !==
          payload.admission.policyId ||
        entry.definition.authorizationPolicy.version !==
          payload.admission.policyVersion ||
        entry.definition.ttlMillis !== payload.ttlMillis ||
        payload.encodedPayloadBytes >
          entry.definition.maxEncodedPayloadBytes ||
        (
          entry.definition.correlation === "ExactRequired" &&
          payload.correlation._tag !== "Exact"
        )
      ) {
        return yield* Effect.fail(invalidSeed(
          index,
          InvalidSeedCodes.BindingMismatch,
          "Accepted signal history is not admitted by the bound manifest"
        ))
      }
      const resolved = resolvedDefinitions.get(entry.key)
      if (resolved === undefined) {
        return yield* Effect.fail(invalidSeed(
          index,
          InvalidSeedCodes.RuntimePinMismatch,
          "Exact historical signal runtime pins are unavailable"
        ))
      }
      if (payload.payload._tag === "Inline") {
        const decodedPayload = yield* SignalRuntimeV2.decodePayload(
          resolved,
          payload.payload
        ).pipe(Effect.result)
        if (
          Result.isFailure(decodedPayload) ||
          decodedPayload.success._tag !== "DecodedPayload" ||
          decodedPayload.success.source !== "Inline"
        ) {
          return yield* Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.BindingMismatch,
            "Accepted inline signal history fails its exact pinned codec"
          ))
        }
        const canonical = Json.canonicalizeSnapshot(
          payload.payload.value
        )
        const payloadDigest = yield* hashPayload(
          payload.payload.value
        ).pipe(
          Effect.mapError(() =>
            invalidSeed(
              index,
              InvalidSeedCodes.CryptoUnavailable,
              "Historical payload digest computation failed"
            )
          )
        )
        if (
          canonical !== decodedPayload.success.canonicalEncoded ||
          decodedPayload.success.encodedBytes !==
            payload.encodedPayloadBytes ||
          payloadDigest !== payload.payloadDigest ||
          new TextEncoder().encode(canonical).byteLength !==
            payload.encodedPayloadBytes
        ) {
          return yield* Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.BindingMismatch,
            "Accepted inline signal history has invalid payload integrity facts"
          ))
        }
      } else {
        const requirement = yield* SignalRuntimeV2.decodePayload(
          resolved,
          payload.payload
        ).pipe(Effect.result)
        if (
          Result.isFailure(requirement) ||
          requirement.success._tag !== "BlobResolutionRequired"
        ) {
          return yield* Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.BindingMismatch,
            "Accepted blob signal history has an invalid payload reference"
          ))
        }
        const encoded = yield* loadBlobJson(
          boundPlan.binding.key,
          payload.payload.ref,
          entry.definition.maxEncodedPayloadBytes
        ).pipe(
          Effect.mapError(() =>
            invalidSeed(
              index,
              InvalidSeedCodes.BlobUnavailable,
              "Historical signal blob is unavailable or fails raw integrity verification"
            )
          )
        )
        const decodedPayload = yield* SignalRuntimeV2.decodeVerifiedBlob(
          resolved,
          requirement.success,
          encoded
        ).pipe(Effect.result)
        if (Result.isFailure(decodedPayload)) {
          return yield* Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.BindingMismatch,
            "Accepted blob signal history fails its exact pinned codec"
          ))
        }
        const payloadDigest = yield* hashPayload(
          decodedPayload.success.encoded
        ).pipe(
          Effect.mapError(() =>
            invalidSeed(
              index,
              InvalidSeedCodes.CryptoUnavailable,
              "Historical blob payload digest computation failed"
            )
          )
        )
        if (
          payloadDigest !== payload.payloadDigest ||
          payload.payload.ref.encodedBytes !== payload.encodedPayloadBytes
        ) {
          return yield* Effect.fail(invalidSeed(
            index,
            InvalidSeedCodes.BindingMismatch,
            "Accepted blob signal history has invalid payload integrity facts"
          ))
        }
      }
    }
    const key = storageKey(boundPlan.binding.key)
    if (HashMap.has(runs, key)) {
      return yield* Effect.fail(invalidSeed(
        index,
        InvalidSeedCodes.DuplicateRun,
        "Run seed identity was installed more than once"
      ))
    }
    let outcomes = HashMap.empty<string, StoredOutcome>()
    let timers = HashMap.empty<string, IndexedTimer>()
    for (const event of history) {
      if (event.payload._tag === "SignalAccepted") {
        const payload = event.payload
        const receipt: SignalIngressV2.Receipt = Object.freeze({
          receiptVersion: 1,
          key: boundPlan.binding.key,
          artifactDigest: boundPlan.binding.artifactDigest,
          signalDefinitionDigest: payload.signalDefinitionDigest,
          signalId: payload.signalId,
          signalName: payload.signalName,
          signalVersion: payload.signalVersion,
          requestDigest: payload.requestDigest,
          payloadDigest: payload.payloadDigest,
          encodedPayloadBytes: payload.encodedPayloadBytes,
          inboxSequence: payload.inboxSequence,
          historySequence: event.sequence,
          acceptedEventId: event.eventId,
          expiryTimerId: payload.expiryTimerId,
          acceptedAt: event.recordedAt,
          expiresAt: payload.expiresAt,
          admission: payload.admission
        })
        outcomes = HashMap.set(
          outcomes,
          payload.signalId,
          Object.freeze({
            _tag: "AcceptedOutcome",
            requestDigest: payload.requestDigest,
            receipt
          })
        )
      } else if (
        event.payload._tag === "TimerScheduled" &&
        event.payload.purpose._tag === "SignalExpiry"
      ) {
        timers = HashMap.set(
          timers,
          event.payload.timerId,
          Object.freeze({
            timerId: event.payload.timerId,
            deadline: event.payload.deadline,
            historySequence: event.sequence
          })
        )
      } else if (
        event.payload._tag === "TimerFired" ||
        event.payload._tag === "TimerCancelled"
      ) {
        timers = HashMap.remove(timers, event.payload.timerId)
      }
    }
    runs = HashMap.set(
      runs,
      key,
      Object.freeze({
        boundPlan,
        history,
        replay: replay.success,
        outcomes,
        timers,
        deadLetters: HashMap.empty(),
        deadLetterEncodedBytes: 0,
        wakeRevision: 0
      })
    )
  }

  const state = yield* Ref.make<MemoryState>(Object.freeze({ runs }))

  const readBlob = Effect.fnUntraced(function*(
    key: PlanStoreV2.RunKey,
    resolved: SignalRuntimeV2.ResolvedSignalRuntime,
    requirement: SignalRuntimeV2.BlobResolutionRequired
  ): Effect.fn.Return<
    SignalRuntimeV2.DecodedPayload,
    SignalIngressV2.SignalIngressUnavailable | SignalRuntimeV2.SignalPayloadError
  > {
    const encoded = yield* loadBlobJson(
      key,
      requirement.ref,
      requirement.maximumEncodedBytes
    )
    return yield* SignalRuntimeV2.decodeVerifiedBlob(
      resolved,
      requirement,
      encoded
    )
  })

  const accept: SignalIngressV2.SignalIngressV2.Service["accept"] = Effect.fnUntraced(function*(input, actorInput) {
    const request = snapshotRequest(input)
    if (request === undefined) {
      return rejected(
        SignalContractV2.SignalRejectionReasons.InvalidRequest
      )
    }
    const requestDigest = yield* hashRequest(
      request as unknown as Schema.Json
    )
    const actor = captureActor(actorInput)
    if (actor === undefined) {
      return rejected(SignalContractV2.SignalRejectionReasons.Unauthorized)
    }
    const rawNow = yield* clock.currentTimeMillis
    if (!Number.isSafeInteger(rawNow)) {
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Store clock returned an unsafe millisecond value"
      ))
    }
    const earlyState = yield* Ref.get(state)
    const earlyRun = getRun(earlyState, request.key)
    if (earlyRun === undefined) {
      return rejected(SignalContractV2.SignalRejectionReasons.UnknownRun)
    }
    const earlyOutcome = liveOutcome(
      earlyRun,
      request.signalId,
      rawNow
    )
    if (earlyOutcome !== undefined) {
      return duplicateOrConflict(
        earlyOutcome,
        requestDigest,
        actor.actorId
      )
    }
    if (
      request.expectedArtifactDigest !==
        earlyRun.boundPlan.binding.artifactDigest
    ) {
      return rejected(SignalContractV2.SignalRejectionReasons.WrongArtifact)
    }
    if (isClosedToSignalAdmission(earlyRun)) {
      return rejected(SignalContractV2.SignalRejectionReasons.TerminalRun)
    }
    const definition = findDefinition(
      earlyRun,
      request.signalName,
      request.signalVersion
    )
    if (definition === undefined) {
      return rejected(SignalContractV2.SignalRejectionReasons.UnknownSignal)
    }
    const policy = earlyRun.boundPlan.artifact.signalManifest.inboxPolicy
    if (utf8Bytes(request.signalId) > policy.maxSignalIdBytes) {
      return rejected(
        SignalContractV2.SignalRejectionReasons.SignalIdTooLarge
      )
    }
    if (
      request.correlation._tag === "Exact" &&
      utf8Bytes(request.correlation.key) > policy.maxCorrelationKeyBytes
    ) {
      return rejected(
        SignalContractV2.SignalRejectionReasons.CorrelationKeyTooLarge
      )
    }
    if (
      definition.definition.correlation === "ExactRequired" &&
      request.correlation._tag !== "Exact"
    ) {
      return rejected(
        SignalContractV2.SignalRejectionReasons.InvalidRequest
      )
    }
    const resolvedResult = yield* runtimes.resolve(
      definition
    ).pipe(Effect.result)
    if (Result.isFailure(resolvedResult)) {
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.RuntimeDefinitionUnavailable,
        "Exact signal runtime pins are unavailable"
      ))
    }
    const resolved = resolvedResult.success
    const decodedResult = yield* SignalRuntimeV2.decodePayload(
      resolved,
      request.payload
    ).pipe(Effect.result)
    if (Result.isFailure(decodedResult)) {
      return rejected(
        decodedResult.failure.code ===
            SignalRuntimeV2.PayloadErrorCodes.PayloadTooLarge
          ? SignalContractV2.SignalRejectionReasons.PayloadTooLarge
          : SignalContractV2.SignalRejectionReasons.InvalidPayload
      )
    }
    let decoded: SignalRuntimeV2.DecodedPayload
    if (decodedResult.success._tag === "BlobResolutionRequired") {
      const blobResult = yield* readBlob(
        request.key,
        resolved,
        decodedResult.success
      ).pipe(Effect.result)
      if (Result.isFailure(blobResult)) {
        if (
          blobResult.failure instanceof
            SignalRuntimeV2.SignalPayloadError
        ) {
          return rejected(
            blobResult.failure.code ===
                SignalRuntimeV2.PayloadErrorCodes.PayloadTooLarge
              ? SignalContractV2.SignalRejectionReasons.PayloadTooLarge
              : SignalContractV2.SignalRejectionReasons.InvalidPayload
          )
        }
        return yield* Effect.fail(blobResult.failure)
      }
      decoded = blobResult.success
    } else {
      decoded = decodedResult.success
    }
    if (
      decoded.encodedBytes >
        definition.definition.maxEncodedPayloadBytes ||
      decoded.encodedBytes > policy.maxItemEncodedBytes
    ) {
      return rejected(
        SignalContractV2.SignalRejectionReasons.PayloadTooLarge
      )
    }
    const authorization = yield* SignalRuntimeV2.authorize(
      resolved,
      actor,
      decoded.value
    ).pipe(Effect.result)
    if (Result.isFailure(authorization)) {
      if (
        authorization.failure instanceof
          SignalRuntimeV2.AuthorizationDenied
      ) {
        return rejected(
          SignalContractV2.SignalRejectionReasons.Unauthorized
        )
      }
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.AuthorizationUnavailable,
        "Signal authorization policy is unavailable"
      ))
    }
    const payloadDigest = yield* hashPayload(decoded.encoded)
    const encodedPayloadBytes = request.payload._tag === "Blob"
      ? request.payload.ref.encodedBytes
      : decoded.encodedBytes
    const recordedMillis = Math.max(
      rawNow,
      Date.parse(earlyRun.replay.lastRecordedAt)
    )
    const recordedAt = timestamp(recordedMillis)
    if (recordedAt === undefined) {
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Store clock could not be represented canonically"
      ))
    }
    const payload: ProtocolV2Wire.EncodedPayload = request.payload._tag === "Inline"
      ? Object.freeze({
        _tag: "Inline",
        value: decoded.encoded
      })
      : request.payload
    const prepared: PreparedAdmission = Object.freeze({
      request,
      requestDigest,
      definition,
      payload,
      payloadDigest,
      encodedPayloadBytes,
      admission: Object.freeze({
        actorId: actor.actorId,
        policyId: definition.definition.authorizationPolicy.id,
        policyVersion: definition.definition.authorizationPolicy.version,
        policyDecisionId: authorization.success
      }),
      recordedAt
    })
    const commitNow = yield* clock.currentTimeMillis
    if (!Number.isSafeInteger(commitNow)) {
      return yield* Effect.fail(unavailable(
        SignalIngressV2.UnavailableCodes.StoreUnavailable,
        "Store commit clock returned an unsafe millisecond value"
      ))
    }
    const result = yield* Ref.modify(state, (current) => {
      const currentRun = getRun(current, request.key)
      if (currentRun === undefined) {
        return [
          rejected(SignalContractV2.SignalRejectionReasons.UnknownRun),
          current
        ] as const
      }
      const [outcome, nextRun] = commitAdmission(
        currentRun,
        prepared,
        commitNow
      )
      return [
        outcome,
        nextRun === currentRun
          ? current
          : Object.freeze({
            runs: HashMap.set(
              current.runs,
              storageKey(request.key),
              nextRun
            )
          })
      ] as const
    })
    return result instanceof SignalIngressV2.SignalIngressUnavailable
      ? yield* Effect.fail(result)
      : result
  })

  const ingress = SignalIngressV2.SignalIngressV2.of(
    Object.freeze({ accept })
  )
  const inspect: MemoryServices["inspect"] = (key) =>
    Ref.get(state).pipe(
      Effect.map((current) => {
        const run = getRun(current, key)
        return run === undefined ? undefined : inspectRun(run)
      })
    )
  return Object.freeze({ ingress, inspect })
})
