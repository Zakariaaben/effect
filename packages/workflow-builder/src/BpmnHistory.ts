/**
 * Content-addressed durable artifacts for executable BPMN transition journals.
 *
 * **Details**
 *
 * A sealed artifact commits to the exact prepared model reference and complete
 * ordered transition journal. The digest detects accidental corruption and
 * supports comparison with an independently anchored value. It is not a
 * signature or MAC: storage able to replace both payload and digest still
 * requires an external trust mechanism.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnExecutionState from "./BpmnExecutionState.ts"
import * as BpmnKernel from "./BpmnKernel.ts"
import type * as Diagnostic from "./Diagnostic.ts"
import * as DigestV2 from "./DigestV2.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the sealed BPMN journal artifact.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnHistoryArtifactVersion = 1 as const

/**
 * Canonical payload covered by a BPMN journal history digest.
 *
 * @category schemas
 * @since 4.0.0
 */
export const JournalPayload = Schema.Struct({
  artifactKind: Schema.Literal("BpmnTransitionJournal"),
  artifactVersion: Schema.Literal(BpmnHistoryArtifactVersion),
  model: BpmnExecutionState.ModelReference,
  events: BpmnKernel.TransitionJournal
}).annotate({
  identifier: "WorkflowBpmnHistoryJournalPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link JournalPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type JournalPayload = Schema.Schema.Type<typeof JournalPayload>

/**
 * One content-addressed durable BPMN transition journal.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SealedJournal = Schema.Struct({
  artifactKind: Schema.Literal("BpmnTransitionJournal"),
  artifactVersion: Schema.Literal(BpmnHistoryArtifactVersion),
  model: BpmnExecutionState.ModelReference,
  events: BpmnKernel.TransitionJournal,
  historyDigest: ProtocolV2Wire.HistoryDigest
}).annotate({
  identifier: "WorkflowBpmnHistorySealedJournal",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SealedJournal}.
 *
 * @category models
 * @since 4.0.0
 */
export type SealedJournal = Schema.Schema.Type<typeof SealedJournal>

/**
 * Stable BPMN history artifact failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidArtifact: "InvalidArtifact",
  InvalidJournalHeader: "InvalidJournalHeader",
  HistoryDigestMismatch: "HistoryDigestMismatch"
} as const

/**
 * A stable BPMN history artifact failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type Code = typeof Codes[keyof typeof Codes]

const Code = Schema.Literals([
  Codes.InvalidArtifact,
  Codes.InvalidJournalHeader,
  Codes.HistoryDigestMismatch
])

/**
 * Raised when a sealed BPMN history artifact is malformed or corrupt.
 *
 * @category errors
 * @since 4.0.0
 */
export class BpmnHistoryError extends Schema.TaggedErrorClass<
  BpmnHistoryError
>("@effect/workflow-builder/BpmnHistory/Error")(
  "BpmnHistoryError",
  {
    code: Code,
    path: Schema.Array(Schema.Union([
      Schema.String,
      ProtocolV2Wire.NonNegativeSafeInt
    ]))
  },
  { parseOptions: strictParseOptions }
) {}

const decodeJournal = Schema.decodeUnknownResult(
  BpmnKernel.TransitionJournal,
  strictParseOptions
)
const decodeSealedJournal = Schema.decodeUnknownResult(
  SealedJournal,
  strictParseOptions
)

const historyError = (
  code: Code,
  path: ReadonlyArray<string | number> = []
): BpmnHistoryError => new BpmnHistoryError({ code, path: [...path] })

const captureJournal = (
  input: unknown
): Result.Result<BpmnKernel.TransitionJournal, BpmnHistoryError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(historyError(
      Codes.InvalidArtifact,
      snapshot.failure.path
    ))
  }
  const decoded = decodeJournal(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(historyError(Codes.InvalidArtifact, ["events"]))
  }
  return Result.succeed(
    snapshot.success as unknown as BpmnKernel.TransitionJournal
  )
}

const payloadOf = (
  model: BpmnExecutionState.ModelReference,
  events: BpmnKernel.TransitionJournal
): JournalPayload => ({
  artifactKind: "BpmnTransitionJournal",
  artifactVersion: BpmnHistoryArtifactVersion,
  model,
  events
})

/**
 * Validates and seals one complete causal BPMN transition journal.
 *
 * **Details**
 *
 * Kernel replay runs before hashing, so malformed, cross-model, truncated, or
 * causally inconsistent histories cannot be sealed by this constructor.
 *
 * @category constructors
 * @since 4.0.0
 */
export const seal = Effect.fnUntraced(function*(
  kernel: BpmnKernel.CompiledKernel,
  eventsInput: unknown
): Effect.fn.Return<
  SealedJournal,
  | BpmnHistoryError
  | Diagnostic.CompilationError
  | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const events = yield* Effect.fromResult(captureJournal(eventsInput))
  yield* Effect.fromResult(BpmnKernel.replay(kernel, events))
  const header = events[0]
  if (header?._tag !== "JournalStarted") {
    return yield* Effect.fail(historyError(
      Codes.InvalidJournalHeader,
      ["events", 0]
    ))
  }
  const payloadSnapshot = Json.snapshot(payloadOf(header.model, events))
  if (Result.isFailure(payloadSnapshot)) {
    return yield* Effect.fail(historyError(
      Codes.InvalidArtifact,
      payloadSnapshot.failure.path
    ))
  }
  const historyDigest = yield* DigestV2.history(payloadSnapshot.success)
  const artifact = Json.snapshot({
    ...payloadOf(header.model, events),
    historyDigest
  })
  if (Result.isFailure(artifact)) {
    return yield* Effect.fail(historyError(
      Codes.InvalidArtifact,
      artifact.failure.path
    ))
  }
  return artifact.success as unknown as SealedJournal
})

/**
 * Verifies one sealed journal's content identity and replays it under the
 * exact prepared kernel.
 *
 * @category constructors
 * @since 4.0.0
 */
export const replay = Effect.fnUntraced(function*(
  kernel: BpmnKernel.CompiledKernel,
  artifactInput: unknown
): Effect.fn.Return<
  BpmnExecutionState.BpmnExecutionState,
  | BpmnHistoryError
  | Diagnostic.CompilationError
  | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const snapshot = Json.snapshot(artifactInput)
  if (Result.isFailure(snapshot)) {
    return yield* Effect.fail(historyError(
      Codes.InvalidArtifact,
      snapshot.failure.path
    ))
  }
  const decoded = decodeSealedJournal(snapshot.success)
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(historyError(Codes.InvalidArtifact))
  }
  const artifact = snapshot.success as unknown as SealedJournal
  const payloadSnapshot = Json.snapshot(payloadOf(
    artifact.model,
    artifact.events
  ))
  if (Result.isFailure(payloadSnapshot)) {
    return yield* Effect.fail(historyError(
      Codes.InvalidArtifact,
      payloadSnapshot.failure.path
    ))
  }
  const actualDigest = yield* DigestV2.history(payloadSnapshot.success)
  if (actualDigest !== artifact.historyDigest) {
    return yield* Effect.fail(historyError(
      Codes.HistoryDigestMismatch,
      ["historyDigest"]
    ))
  }
  const header = artifact.events[0]
  if (
    header?._tag !== "JournalStarted" ||
    Json.canonicalizeSnapshot(
      header.model as unknown as Schema.Json
    ) !==
      Json.canonicalizeSnapshot(
        artifact.model as unknown as Schema.Json
      )
  ) {
    return yield* Effect.fail(historyError(
      Codes.InvalidJournalHeader,
      ["events", 0]
    ))
  }
  return yield* Effect.fromResult(
    BpmnKernel.replay(kernel, artifact.events)
  )
})
