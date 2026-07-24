/**
 * Optional child-lifecycle reporter over native Effect Workflow activities.
 *
 * **Details**
 *
 * The reporter decorates an already-prepared protocol-version `3` native
 * workflow handler. It records accepted-start and terminal source facts
 * through stable native `Activity` identities, while a caller-provided
 * {@link ChildLifecycleSourceOutbox} owns the transactional first write.
 *
 * This module implements no store, outbox table, relay, scheduler, poller,
 * clock, application outbox retry controller, workflow engine, or parent
 * projection. A durable outbox implementation must deduplicate by source
 * identity, allocate source sequence and occurrence time once, insert the
 * canonical source fact and egress record atomically, and return the exact
 * first receipt on every retry.
 *
 * Native interruption, polling, suspension, defects, and workflow absence are
 * never converted into child cancellation facts. The generic decorator reports
 * only a validated handler success or typed terminal `RunFailure`.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as NativeActivity from "effect/unstable/workflow/Activity"
import type * as NativeWorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as BpmnCallActivityV3 from "./BpmnCallActivityV3.ts"
import * as ChildWorkflowLifecycleV3 from "./ChildWorkflowLifecycleV3.ts"
import * as EffectWorkflowBackendV3 from "./EffectWorkflowBackendV3.ts"
import * as EffectWorkflowBpmnCallActivityV3 from "./EffectWorkflowBpmnCallActivityV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of this optional native lifecycle reporter.
 *
 * @category constants
 * @since 4.0.0
 */
export const AdapterVersion = 1 as const

/**
 * Version of child lifecycle source reports.
 *
 * @category constants
 * @since 4.0.0
 */
export const SourceReportVersion = 1 as const

/**
 * Version of source sequence/time allocations.
 *
 * @category constants
 * @since 4.0.0
 */
export const SourceAllocationVersion = 1 as const

/**
 * Version of canonical lifecycle outbox receipts.
 *
 * @category constants
 * @since 4.0.0
 */
export const CanonicalReceiptVersion = 1 as const

/**
 * Version of persisted lifecycle publication failure envelopes.
 *
 * @category constants
 * @since 4.0.0
 */
export const PublicationFailureVersion = 1 as const

/**
 * Stable native Activity name for accepted child start publication.
 *
 * @category constants
 * @since 4.0.0
 */
export const StartedActivityName = "@effect/workflow-builder/effect-workflow/v3/child-lifecycle/a1/started" as const

/**
 * Stable native Activity name shared by successful and failed terminals.
 *
 * **Details**
 *
 * Sharing one identity prevents the same native child run from publishing two
 * incompatible generic terminal outcomes.
 *
 * @category constants
 * @since 4.0.0
 */
export const TerminalActivityName = "@effect/workflow-builder/effect-workflow/v3/child-lifecycle/a1/terminal" as const

const SourceReportFields = {
  reportVersion: Schema.Literal(SourceReportVersion),
  adapterVersion: Schema.Literal(AdapterVersion),
  executionProtocolVersion: Schema.Literal(
    EffectWorkflowBackendV3.ExecutionProtocolVersion
  ),
  tenantId: Wire.AtomicIdentifier,
  childRunId: Wire.LineageIdentifier,
  startRequestId: Wire.SourceEventIdentifier,
  artifactDigest: Wire.ArtifactDigest,
  locator: EffectWorkflowBpmnCallActivityV3.NativeBackendLocator,
  sourceEventId: Wire.SourceEventIdentifier
}

/**
 * Canonical report that one native child host was durably admitted.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildStartAcceptedReport = Schema.TaggedStruct(
  "ChildStartAccepted",
  SourceReportFields
).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3ChildStartAcceptedReport",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildStartAcceptedReport}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildStartAcceptedReport = Schema.Schema.Type<
  typeof ChildStartAcceptedReport
>

/**
 * Canonical report of a validated successful native child terminal.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildSucceededReport = Schema.TaggedStruct("ChildSucceeded", {
  ...SourceReportFields,
  outputContractDigest: Wire.ContractDigest,
  encodedOutput: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3ChildSucceededReport",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildSucceededReport}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildSucceededReport = Schema.Schema.Type<
  typeof ChildSucceededReport
>

/**
 * Canonical report of a validated typed native child terminal failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildFailedReport = Schema.TaggedStruct("ChildFailed", {
  ...SourceReportFields,
  failure: EffectWorkflowBackendV3.RunFailure
}).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3ChildFailedReport",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildFailedReport}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildFailedReport = Schema.Schema.Type<
  typeof ChildFailedReport
>

/**
 * Closed report vocabulary emitted by the generic native child host.
 *
 * **Details**
 *
 * Cancellation acceptance and cancellation terminal facts are intentionally
 * absent. They require an explicit committed event from the child semantic
 * authority and must not be inferred by a generic wrapper.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildLifecycleSourceReport = Schema.Union([
  ChildStartAcceptedReport,
  ChildSucceededReport,
  ChildFailedReport
]).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3SourceReport",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildLifecycleSourceReport}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildLifecycleSourceReport = Schema.Schema.Type<
  typeof ChildLifecycleSourceReport
>

/**
 * Source coordinates allocated by the durable outbox's first write.
 *
 * **Details**
 *
 * `sourceSequence` is monotonic within the child lifecycle stream. A replay
 * must reuse this exact allocation. Neither the handler decorator nor the
 * parent projection samples these values.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SourceFactAllocation = Schema.Struct({
  allocationVersion: Schema.Literal(SourceAllocationVersion),
  sourceSequence: Wire.NonNegativeSafeInt,
  occurredAt: Wire.Timestamp
}).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3SourceFactAllocation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SourceFactAllocation}.
 *
 * @category models
 * @since 4.0.0
 */
export type SourceFactAllocation = Schema.Schema.Type<
  typeof SourceFactAllocation
>

const CanonicalLifecycleReceiptStruct = Schema.Struct({
  receiptVersion: Schema.Literal(CanonicalReceiptVersion),
  outboxEntryId: Wire.Identifier,
  report: ChildLifecycleSourceReport,
  fact: ChildWorkflowLifecycleV3.LifecycleFact
})

/**
 * Exact first-write result returned by the lifecycle source outbox.
 *
 * **Details**
 *
 * `outboxEntryId`, `report`, and `fact` must be identical for the first call,
 * a concurrent duplicate, and every post-crash retry. A first/replayed flag is
 * deliberately absent because it would make one Activity identity produce two
 * different success values.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CanonicalLifecycleReceipt = CanonicalLifecycleReceiptStruct.check(
  Schema.makeFilter((receipt) => {
    const report = receipt.report
    const fact = receipt.fact
    if (report._tag !== fact._tag) {
      return [{
        path: ["fact", "_tag"],
        issue: "lifecycle receipt report and fact tags must match"
      }]
    }
    if (report.childRunId !== fact.childRunId) {
      return [{
        path: ["fact", "childRunId"],
        issue: "lifecycle receipt report and fact childRunId values must match"
      }]
    }
    if (
      report._tag === "ChildStartAccepted" &&
      fact._tag === "ChildStartAccepted"
    ) {
      return report.sourceEventId === fact.childRunStartedEventId
        ? []
        : [{
          path: ["fact", "childRunStartedEventId"],
          issue: "accepted-start fact identity must equal report sourceEventId"
        }]
    }
    if (
      report._tag === "ChildSucceeded" &&
      fact._tag === "ChildSucceeded"
    ) {
      if (report.sourceEventId !== fact.childTerminalEventId) {
        return [{
          path: ["fact", "childTerminalEventId"],
          issue: "successful terminal fact identity must equal report sourceEventId"
        }]
      }
      if (
        report.outputContractDigest !== fact.outputContractDigest
      ) {
        return [{
          path: ["fact", "outputContractDigest"],
          issue: "successful terminal report and fact contracts must match"
        }]
      }
      return Json.canonicalizeSnapshot(
          report.encodedOutput as unknown as Schema.Json
        ) ===
          Json.canonicalizeSnapshot(
            fact.encodedOutput as unknown as Schema.Json
          )
        ? []
        : [{
          path: ["fact", "encodedOutput"],
          issue: "successful terminal report and fact outputs must match"
        }]
    }
    if (
      report._tag === "ChildFailed" &&
      fact._tag === "ChildFailed"
    ) {
      if (report.sourceEventId !== fact.childTerminalEventId) {
        return [{
          path: ["fact", "childTerminalEventId"],
          issue: "failed terminal fact identity must equal report sourceEventId"
        }]
      }
      if (fact.failure._tag !== "Inline") {
        return [{
          path: ["fact", "failure"],
          issue: "failed native terminal fact must inline the complete RunFailure envelope"
        }]
      }
      return Json.canonicalizeSnapshot(
          report.failure as unknown as Schema.Json
        ) ===
          Json.canonicalizeSnapshot(
            fact.failure.value
          )
        ? []
        : [{
          path: ["fact", "failure", "value"],
          issue: "failed terminal fact must retain the exact RunFailure envelope"
        }]
    }
    return [{
      path: ["fact", "_tag"],
      issue: "unsupported generic native child lifecycle fact"
    }]
  })
).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3CanonicalReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CanonicalLifecycleReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type CanonicalLifecycleReceipt = Schema.Schema.Type<
  typeof CanonicalLifecycleReceipt
>

/**
 * Stable lifecycle reporter failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidBinding: "InvalidBinding",
  InvalidSemanticExecution: "InvalidSemanticExecution",
  ArtifactMismatch: "ArtifactMismatch",
  NativeExecutionAddressMismatch: "NativeExecutionAddressMismatch",
  InvalidReport: "InvalidReport",
  InvalidAllocation: "InvalidAllocation",
  InvalidReceipt: "InvalidReceipt",
  ReceiptDrift: "ReceiptDrift",
  InvalidPublicationFailure: "InvalidPublicationFailure",
  PublicationFailureDrift: "PublicationFailureDrift",
  InvalidSuccess: "InvalidSuccess"
} as const

/**
 * A stable lifecycle reporter failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidBinding,
  ErrorCodes.InvalidSemanticExecution,
  ErrorCodes.ArtifactMismatch,
  ErrorCodes.NativeExecutionAddressMismatch,
  ErrorCodes.InvalidReport,
  ErrorCodes.InvalidAllocation,
  ErrorCodes.InvalidReceipt,
  ErrorCodes.ReceiptDrift,
  ErrorCodes.InvalidPublicationFailure,
  ErrorCodes.PublicationFailureDrift,
  ErrorCodes.InvalidSuccess
])

/**
 * Raised by lifecycle report construction or receipt validation.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowChildLifecycleError extends Schema.TaggedErrorClass<
  EffectWorkflowChildLifecycleError
>("@effect/workflow-builder/EffectWorkflowChildLifecycleV3/Error")(
  "EffectWorkflowChildLifecycleError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    sourceEventId: Schema.optionalKey(Wire.SourceEventIdentifier),
    outboxEntryId: Schema.optionalKey(Wire.Identifier)
  },
  { parseOptions: strictParseOptions }
) {}

const lifecycleError = (
  code: ErrorCode,
  message: string,
  options: {
    readonly sourceEventId?: string | undefined
    readonly outboxEntryId?: string | undefined
  } = {}
): EffectWorkflowChildLifecycleError =>
  new EffectWorkflowChildLifecycleError({
    code,
    message,
    ...(options.sourceEventId === undefined
      ? undefined
      : { sourceEventId: options.sourceEventId }),
    ...(options.outboxEntryId === undefined
      ? undefined
      : { outboxEntryId: options.outboxEntryId })
  })

/**
 * Stable application-outbox failure categories persisted by the native
 * lifecycle Activity.
 *
 * @category constants
 * @since 4.0.0
 */
export const SourceOutboxErrorCodes = {
  Unavailable: "Unavailable",
  Rejected: "Rejected",
  Conflict: "Conflict",
  Unauthorized: "Unauthorized",
  CapacityExceeded: "CapacityExceeded",
  InvariantViolation: "InvariantViolation"
} as const

/**
 * A stable application-outbox failure category.
 *
 * @category models
 * @since 4.0.0
 */
export type SourceOutboxErrorCode = typeof SourceOutboxErrorCodes[keyof typeof SourceOutboxErrorCodes]

const SourceOutboxErrorCode = Schema.Literals([
  SourceOutboxErrorCodes.Unavailable,
  SourceOutboxErrorCodes.Rejected,
  SourceOutboxErrorCodes.Conflict,
  SourceOutboxErrorCodes.Unauthorized,
  SourceOutboxErrorCodes.CapacityExceeded,
  SourceOutboxErrorCodes.InvariantViolation
])

/**
 * Typed failure returned by an application lifecycle source outbox.
 *
 * **Details**
 *
 * `retryable` is evidence for an application-selected retry composition; this
 * adapter does not silently retry typed outbox failures.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildLifecycleSourceOutboxError extends Schema.TaggedErrorClass<
  ChildLifecycleSourceOutboxError
>("@effect/workflow-builder/EffectWorkflowChildLifecycleV3/SourceOutboxError")(
  "ChildLifecycleSourceOutboxError",
  {
    code: SourceOutboxErrorCode,
    message: Schema.NonEmptyString,
    sourceEventId: Wire.SourceEventIdentifier,
    retryable: Schema.Boolean
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Runtime application error vocabulary restored after one lifecycle
 * publication Activity fails.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LifecyclePublicationError = Schema.Union([
  ChildLifecycleSourceOutboxError,
  EffectWorkflowChildLifecycleError
]).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3PublicationError",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LifecyclePublicationError}.
 *
 * @category models
 * @since 4.0.0
 */
export type LifecyclePublicationError = Schema.Schema.Type<
  typeof LifecyclePublicationError
>

/**
 * Portable error payload retained inside a publication failure envelope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LifecyclePublicationErrorSnapshot = Schema.Union([
  Schema.TaggedStruct("ChildLifecycleSourceOutboxError", {
    code: SourceOutboxErrorCode,
    message: Schema.NonEmptyString,
    sourceEventId: Wire.SourceEventIdentifier,
    retryable: Schema.Boolean
  }),
  Schema.TaggedStruct("EffectWorkflowChildLifecycleError", {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    sourceEventId: Schema.optionalKey(Wire.SourceEventIdentifier),
    outboxEntryId: Schema.optionalKey(Wire.Identifier)
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowChildLifecycleV3PublicationErrorSnapshot",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LifecyclePublicationErrorSnapshot}.
 *
 * @category models
 * @since 4.0.0
 */
export type LifecyclePublicationErrorSnapshot = Schema.Schema.Type<
  typeof LifecyclePublicationErrorSnapshot
>

const LifecyclePublicationFailureStruct = Schema.TaggedStruct(
  "LifecyclePublicationFailed",
  {
    failureVersion: Schema.Literal(PublicationFailureVersion),
    report: ChildLifecycleSourceReport,
    error: LifecyclePublicationErrorSnapshot
  }
)

/**
 * Report-bound typed failure persisted by one lifecycle publication Activity.
 *
 * **Details**
 *
 * Native Workflow persists typed Activity failures as well as successes. The
 * complete report is therefore repeated here so replay can reject report drift
 * before returning the original application error.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LifecyclePublicationFailure = LifecyclePublicationFailureStruct
  .check(
    Schema.makeFilter((failure) =>
      failure.error.sourceEventId === undefined ||
        failure.error.sourceEventId === failure.report.sourceEventId
        ? []
        : [{
          path: ["error", "sourceEventId"],
          issue: "publication failure error identity must equal report sourceEventId"
        }]
    )
  ).annotate({
    identifier: "WorkflowEffectWorkflowChildLifecycleV3PublicationFailure",
    parseOptions: strictParseOptions
  })

/**
 * The decoded type of {@link LifecyclePublicationFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type LifecyclePublicationFailure = Schema.Schema.Type<
  typeof LifecyclePublicationFailure
>

const snapshotPublicationError = (
  error: LifecyclePublicationError
): LifecyclePublicationErrorSnapshot =>
  error._tag === "ChildLifecycleSourceOutboxError"
    ? {
      _tag: error._tag,
      code: error.code,
      message: error.message,
      sourceEventId: error.sourceEventId,
      retryable: error.retryable
    }
    : {
      _tag: error._tag,
      code: error.code,
      message: error.message,
      ...(error.sourceEventId === undefined
        ? undefined
        : { sourceEventId: error.sourceEventId }),
      ...(error.outboxEntryId === undefined
        ? undefined
        : { outboxEntryId: error.outboxEntryId })
    }

const restorePublicationError = (
  error: LifecyclePublicationErrorSnapshot
): LifecyclePublicationError =>
  error._tag === "ChildLifecycleSourceOutboxError"
    ? new ChildLifecycleSourceOutboxError(error)
    : new EffectWorkflowChildLifecycleError(error)

/**
 * Transactional application boundary for child lifecycle source facts.
 *
 * **Details**
 *
 * `record` must implement first-write semantics by child run plus
 * `report.sourceEventId`, allocate a monotonic per-child source sequence, and
 * use an authoritative transaction timestamp. Identical retries return the
 * exact original receipt. Reusing the same source identity with different
 * report content fails with `Conflict`. The canonical fact and an egress
 * outbox entry must commit in one transaction.
 *
 * @category services
 * @since 4.0.0
 */
export class ChildLifecycleSourceOutbox extends Context.Service<
  ChildLifecycleSourceOutbox,
  {
    readonly record: (
      report: ChildLifecycleSourceReport
    ) => Effect.Effect<
      CanonicalLifecycleReceipt,
      ChildLifecycleSourceOutboxError
    >
  }
>()(
  "@effect/workflow-builder/EffectWorkflowChildLifecycleV3/ChildLifecycleSourceOutbox"
) {}

const decodeSourceReport = Schema.decodeUnknownResult(
  ChildLifecycleSourceReport,
  strictParseOptions
)
const decodeSourceAllocation = Schema.decodeUnknownResult(
  SourceFactAllocation,
  strictParseOptions
)
const decodeCanonicalReceipt = Schema.decodeUnknownResult(
  CanonicalLifecycleReceipt,
  strictParseOptions
)
const decodeLifecyclePublicationFailure = Schema.decodeUnknownResult(
  LifecyclePublicationFailure,
  strictParseOptions
)

const validateWith = <A>(
  input: unknown,
  decode: (input: unknown) => Result.Result<A, unknown>,
  code:
    | typeof ErrorCodes.InvalidReport
    | typeof ErrorCodes.InvalidAllocation
    | typeof ErrorCodes.InvalidReceipt
    | typeof ErrorCodes.InvalidPublicationFailure,
  label: string
): Result.Result<A, EffectWorkflowChildLifecycleError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(lifecycleError(
      code,
      `${label} must be bounded strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = decode(snapshot.success)
  } catch {
    return Result.fail(lifecycleError(
      code,
      `${label} validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(lifecycleError(
      code,
      `Invalid ${label}: ${decoded.failure}`
    ))
    : Result.succeed(snapshot.success as unknown as A)
}

/**
 * Detaches, recursively freezes, and validates one lifecycle source report.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateSourceReport = (
  input: unknown
): Result.Result<
  ChildLifecycleSourceReport,
  EffectWorkflowChildLifecycleError
> =>
  validateWith(
    input,
    decodeSourceReport,
    ErrorCodes.InvalidReport,
    "child lifecycle source report"
  )

const validateSourceAllocation = (
  input: unknown
): Result.Result<
  SourceFactAllocation,
  EffectWorkflowChildLifecycleError
> =>
  validateWith(
    input,
    decodeSourceAllocation,
    ErrorCodes.InvalidAllocation,
    "child lifecycle source allocation"
  )

const canonicalEquals = (
  left: Schema.Json,
  right: Schema.Json
): boolean =>
  Json.canonicalizeSnapshot(left) ===
    Json.canonicalizeSnapshot(right)

/**
 * Constructs the exact lifecycle source fact for a first-write allocation.
 *
 * **Details**
 *
 * A failed native terminal is retained as one inline encoded
 * `EffectWorkflowBackendV3.RunFailure` envelope so its failure category and
 * nested encoded payload cannot be separated or reclassified by the relay.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCanonicalFact = (
  reportInput: unknown,
  allocationInput: unknown
): Result.Result<
  ChildWorkflowLifecycleV3.LifecycleFact,
  EffectWorkflowChildLifecycleError
> => {
  const report = validateSourceReport(reportInput)
  if (Result.isFailure(report)) {
    return Result.fail(report.failure)
  }
  const allocation = validateSourceAllocation(allocationInput)
  if (Result.isFailure(allocation)) {
    return Result.fail(allocation.failure)
  }
  const common = {
    factVersion: ChildWorkflowLifecycleV3.LifecycleFactVersion,
    childRunId: report.success.childRunId,
    sourceSequence: allocation.success.sourceSequence,
    occurredAt: allocation.success.occurredAt
  }
  const candidate = report.success._tag === "ChildStartAccepted"
    ? {
      _tag: report.success._tag,
      ...common,
      childRunStartedEventId: report.success.sourceEventId
    }
    : report.success._tag === "ChildSucceeded"
    ? {
      _tag: report.success._tag,
      ...common,
      childTerminalEventId: report.success.sourceEventId,
      outputContractDigest: report.success.outputContractDigest,
      encodedOutput: report.success.encodedOutput
    }
    : {
      _tag: report.success._tag,
      ...common,
      childTerminalEventId: report.success.sourceEventId,
      failure: {
        _tag: "Inline" as const,
        value: report.success.failure as unknown as Schema.Json
      }
    }
  const fact = ChildWorkflowLifecycleV3.validateLifecycleFact(candidate)
  return Result.isFailure(fact)
    ? Result.fail(lifecycleError(
      ErrorCodes.InvalidReceipt,
      `Canonical lifecycle fact construction failed: ${fact.failure.message}`,
      { sourceEventId: report.success.sourceEventId }
    ))
    : Result.succeed(fact.success)
}

/**
 * Validates an outbox receipt against the exact current source report.
 *
 * **Details**
 *
 * The receipt's source allocation is used only to reconstruct the fact which
 * the first write must have returned. A changed report is replay drift; a fact
 * which does not exactly follow from its own report/allocation is an invalid
 * outbox receipt.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateCanonicalReceipt = (
  expectedReportInput: unknown,
  receiptInput: unknown
): Result.Result<
  CanonicalLifecycleReceipt,
  EffectWorkflowChildLifecycleError
> => {
  const expectedReport = validateSourceReport(expectedReportInput)
  if (Result.isFailure(expectedReport)) {
    return Result.fail(expectedReport.failure)
  }
  const receipt = validateWith(
    receiptInput,
    decodeCanonicalReceipt,
    ErrorCodes.InvalidReceipt,
    "canonical child lifecycle receipt"
  )
  if (Result.isFailure(receipt)) {
    return Result.fail(receipt.failure)
  }
  if (
    !canonicalEquals(
      expectedReport.success as unknown as Schema.Json,
      receipt.success.report as unknown as Schema.Json
    )
  ) {
    return Result.fail(lifecycleError(
      ErrorCodes.ReceiptDrift,
      "The persisted lifecycle Activity receipt belongs to a different source report",
      {
        sourceEventId: expectedReport.success.sourceEventId,
        outboxEntryId: receipt.success.outboxEntryId
      }
    ))
  }
  const fact = receipt.success.fact
  if (fact._tag === "ChildStartFailed") {
    return Result.fail(lifecycleError(
      ErrorCodes.InvalidReceipt,
      "The generic native child host cannot emit a ChildStartFailed source receipt",
      {
        sourceEventId: expectedReport.success.sourceEventId,
        outboxEntryId: receipt.success.outboxEntryId
      }
    ))
  }
  const expectedFact = makeCanonicalFact(receipt.success.report, {
    allocationVersion: SourceAllocationVersion,
    sourceSequence: fact.sourceSequence,
    occurredAt: fact.occurredAt
  })
  if (Result.isFailure(expectedFact)) {
    return Result.fail(expectedFact.failure)
  }
  if (
    !canonicalEquals(
      expectedFact.success as unknown as Schema.Json,
      fact as unknown as Schema.Json
    )
  ) {
    return Result.fail(lifecycleError(
      ErrorCodes.InvalidReceipt,
      "The lifecycle source fact does not exactly match its report and first-write allocation",
      {
        sourceEventId: expectedReport.success.sourceEventId,
        outboxEntryId: receipt.success.outboxEntryId
      }
    ))
  }
  return Result.succeed(receipt.success)
}

/**
 * Validates a persisted publication failure against the exact current report.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateLifecyclePublicationFailure = (
  expectedReportInput: unknown,
  failureInput: unknown
): Result.Result<
  LifecyclePublicationFailure,
  EffectWorkflowChildLifecycleError
> => {
  const expectedReport = validateSourceReport(expectedReportInput)
  if (Result.isFailure(expectedReport)) {
    return Result.fail(expectedReport.failure)
  }
  const failure = validateWith(
    failureInput,
    decodeLifecyclePublicationFailure,
    ErrorCodes.InvalidPublicationFailure,
    "child lifecycle publication failure"
  )
  if (Result.isFailure(failure)) {
    return Result.fail(failure.failure)
  }
  if (
    !canonicalEquals(
      expectedReport.success as unknown as Schema.Json,
      failure.success.report as unknown as Schema.Json
    )
  ) {
    return Result.fail(lifecycleError(
      ErrorCodes.PublicationFailureDrift,
      "The persisted lifecycle Activity failure belongs to a different source report",
      { sourceEventId: expectedReport.success.sourceEventId }
    ))
  }
  return Result.succeed(failure.success)
}

const makePublicationFailure = (
  report: ChildLifecycleSourceReport,
  error: LifecyclePublicationError
): LifecyclePublicationFailure => {
  const candidate = {
    _tag: "LifecyclePublicationFailed",
    failureVersion: PublicationFailureVersion,
    report,
    error: snapshotPublicationError(error)
  } as const
  const validated = validateLifecyclePublicationFailure(
    report,
    candidate
  )
  if (Result.isSuccess(validated)) {
    return validated.success
  }
  return {
    _tag: "LifecyclePublicationFailed",
    failureVersion: PublicationFailureVersion,
    report,
    error: snapshotPublicationError(validated.failure)
  }
}

/**
 * Explicit native Activity execution policy for lifecycle publication.
 *
 * **Details**
 *
 * The policy governs infrastructure interruption of the same publication
 * attempt. Typed outbox failures are not retried implicitly; applications may
 * compose retry inside their outbox service when their transaction semantics
 * permit it.
 *
 * @category models
 * @since 4.0.0
 */
export interface LifecycleActivityOptions {
  readonly interruptRetryPolicy: Schedule.Schedule<
    any,
    Cause.Cause<unknown>
  >
}

const interruptOnlyRetryPolicy = (
  policy: LifecycleActivityOptions["interruptRetryPolicy"]
): LifecycleActivityOptions["interruptRetryPolicy"] =>
  policy.pipe(
    Schedule.while((meta) => Cause.hasInterrupts(meta.input))
  )

/**
 * Native services required while publishing one lifecycle source fact.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements =
  | NativeWorkflowEngine.WorkflowEngine
  | NativeWorkflowEngine.WorkflowInstance
  | ChildLifecycleSourceOutbox

const reportBase = Effect.fnUntraced(function*(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  execution: EffectWorkflowBackendV3.SemanticExecution,
  activityName: string
) {
  if (!EffectWorkflowBackendV3.isPrepared(binding)) {
    return yield* Effect.fail(lifecycleError(
      ErrorCodes.InvalidBinding,
      "Child lifecycle reporting requires the exact PreparedBinding returned by EffectWorkflowBackendV3.prepare"
    ))
  }
  if (!EffectWorkflowBackendV3.isSemanticExecution(execution)) {
    return yield* Effect.fail(lifecycleError(
      ErrorCodes.InvalidSemanticExecution,
      "Child lifecycle reporting requires the exact SemanticExecution created by the native host"
    ))
  }
  if (execution.request.artifactDigest !== binding.artifactDigest) {
    return yield* Effect.fail(lifecycleError(
      ErrorCodes.ArtifactMismatch,
      "The semantic execution belongs to a different prepared artifact"
    ))
  }
  const expectedExecutionId = yield* EffectWorkflowBackendV3.executionIdForRun(binding, {
    tenantId: execution.request.tenantId,
    runId: execution.request.runId
  })
  if (execution.nativeExecutionId !== expectedExecutionId) {
    return yield* Effect.fail(lifecycleError(
      ErrorCodes.NativeExecutionAddressMismatch,
      "The semantic execution has a non-canonical native child address"
    ))
  }
  const sourceEventId = yield* NativeActivity.idempotencyKey(activityName)
  return {
    reportVersion: SourceReportVersion,
    adapterVersion: AdapterVersion,
    executionProtocolVersion: EffectWorkflowBackendV3.ExecutionProtocolVersion,
    tenantId: execution.request.tenantId,
    childRunId: execution.request.runId,
    startRequestId: execution.request.requestId,
    artifactDigest: execution.request.artifactDigest,
    locator: {
      locatorVersion: BpmnCallActivityV3.BackendLocatorVersion,
      backendId: EffectWorkflowBpmnCallActivityV3.BackendId,
      executionId: execution.nativeExecutionId
    },
    sourceEventId
  } as const
})

const recordThroughActivity = Effect.fnUntraced(function*(
  activityName: string,
  reportInput: unknown,
  options: LifecycleActivityOptions
) {
  const report = yield* Effect.fromResult(
    validateSourceReport(reportInput)
  )
  const execute = Effect.flatMap(
    ChildLifecycleSourceOutbox,
    (outbox) => outbox.record(report)
  ).pipe(
    Effect.flatMap((receipt) => Effect.fromResult(validateCanonicalReceipt(report, receipt))),
    Effect.mapError((error) => makePublicationFailure(report, error))
  )
  const activity = NativeActivity.make({
    name: activityName,
    success: CanonicalLifecycleReceipt,
    error: LifecyclePublicationFailure,
    execute,
    interruptRetryPolicy: interruptOnlyRetryPolicy(
      options.interruptRetryPolicy
    )
  })
  const completion = yield* NativeActivity.completion(activity).pipe(
    Effect.provideService(NativeActivity.CurrentAttempt, 1)
  )
  return yield* Effect.matchEffect(
    completion.exit,
    {
      onFailure: (failure) => {
        const validated = validateLifecyclePublicationFailure(
          report,
          failure
        )
        return Result.isFailure(validated)
          ? Effect.fail(validated.failure)
          : Effect.fail(
            restorePublicationError(validated.success.error)
          )
      },
      onSuccess: (receipt) => Effect.fromResult(validateCanonicalReceipt(report, receipt))
    }
  )
})

/**
 * Records the accepted-start source fact before constructing the child
 * semantic handler.
 *
 * @category execution
 * @since 4.0.0
 */
export const publishStarted = Effect.fnUntraced(function*(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  execution: EffectWorkflowBackendV3.SemanticExecution,
  options: LifecycleActivityOptions
) {
  const base = yield* reportBase(
    binding,
    execution,
    StartedActivityName
  )
  return yield* recordThroughActivity(
    StartedActivityName,
    {
      _tag: "ChildStartAccepted",
      ...base
    },
    options
  )
})

/**
 * Records a validated successful child terminal source fact.
 *
 * @category execution
 * @since 4.0.0
 */
export const publishSucceeded = Effect.fnUntraced(function*(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  execution: EffectWorkflowBackendV3.SemanticExecution,
  successInput: unknown,
  options: LifecycleActivityOptions
) {
  const base = yield* reportBase(
    binding,
    execution,
    TerminalActivityName
  )
  const success = EffectWorkflowBackendV3.validateRunSuccess(
    binding,
    successInput
  )
  if (Result.isFailure(success)) {
    return yield* Effect.fail(lifecycleError(
      ErrorCodes.InvalidSuccess,
      "The child terminal success does not match the prepared native output contract"
    ))
  }
  return yield* recordThroughActivity(
    TerminalActivityName,
    {
      _tag: "ChildSucceeded",
      ...base,
      outputContractDigest: success.success.outputContractDigest,
      encodedOutput: success.success.output
    },
    options
  )
})

/**
 * Records a closed typed child terminal failure source fact.
 *
 * **Details**
 *
 * This operation closes malformed typed failures to `AdapterInvariant` using
 * the same boundary as the native host. Defects and interruption do not call
 * this operation.
 *
 * @category execution
 * @since 4.0.0
 */
export const publishFailed = Effect.fnUntraced(function*(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  execution: EffectWorkflowBackendV3.SemanticExecution,
  failureInput: unknown,
  options: LifecycleActivityOptions
) {
  const failure = EffectWorkflowBackendV3.validateRunFailure(failureInput)
  const base = yield* reportBase(
    binding,
    execution,
    TerminalActivityName
  )
  return yield* recordThroughActivity(
    TerminalActivityName,
    {
      _tag: "ChildFailed",
      ...base,
      failure
    },
    options
  )
})

/**
 * Application services retained by the decorated native child registration.
 *
 * @category utility types
 * @since 4.0.0
 */
export type RegistrationRequirements<R> = EffectWorkflowBackendV3.RegistrationRequirements<
  R | ChildLifecycleSourceOutbox
>

/**
 * Decorates a native semantic handler with lifecycle source publication.
 *
 * **Details**
 *
 * This operation performs no registration and therefore composes with other
 * handler decorators before the application chooses a native
 * `WorkflowEngine` layer. Invalid structural copies of `binding` fail at the
 * base registration boundary and again before publication.
 *
 * @category combinators
 * @since 4.0.0
 */
export const decorate = <R>(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  handler: EffectWorkflowBackendV3.SemanticHandler<R>,
  options: LifecycleActivityOptions
): EffectWorkflowBackendV3.SemanticHandler<R | Requirements> =>
(execution) =>
  Effect.gen(function*() {
    yield* publishStarted(binding, execution, options).pipe(
      Effect.orDie
    )
    const outcome = yield* Effect.matchEffect(
      handler(execution),
      {
        onFailure: (failure) =>
          Effect.succeed({
            _tag: "Failed" as const,
            failure: EffectWorkflowBackendV3.validateRunFailure(failure)
          }),
        onSuccess: (success) => {
          const validated = EffectWorkflowBackendV3.validateRunSuccess(
            binding,
            success
          )
          return Effect.succeed(
            Result.isSuccess(validated)
              ? {
                _tag: "Succeeded" as const,
                success: validated.success
              }
              : {
                _tag: "Failed" as const,
                failure: validated.failure
              }
          )
        }
      }
    )
    if (outcome._tag === "Succeeded") {
      yield* publishSucceeded(
        binding,
        execution,
        outcome.success,
        options
      ).pipe(Effect.orDie)
      return outcome.success
    }
    yield* publishFailed(
      binding,
      execution,
      outcome.failure,
      options
    ).pipe(Effect.orDie)
    return yield* Effect.fail(outcome.failure)
  })

/**
 * Registers a native semantic handler with authoritative lifecycle reporting.
 *
 * **Details**
 *
 * The accepted-start Activity commits before the user handler is constructed.
 * A success is contract-validated before publication. A typed handler failure
 * is closed through the native run-failure vocabulary before publication.
 * Publication errors become operational defects so they cannot masquerade as
 * a child business failure or recursively publish another terminal fact.
 *
 * Handler-local scopes finish before their Effect returns. This generic
 * decorator does not claim to observe completion of the outer native workflow
 * result commit or finalizers registered directly on the workflow-lifetime
 * scope; that stronger signal requires a backend lifecycle outbox.
 *
 * @category layers
 * @since 4.0.0
 */
export const toLayer = <R>(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  handler: EffectWorkflowBackendV3.SemanticHandler<R>,
  options: LifecycleActivityOptions
): Result.Result<
  Layer.Layer<never, never, RegistrationRequirements<R>>,
  EffectWorkflowBackendV3.EffectWorkflowBackendError
> => {
  return EffectWorkflowBackendV3.toLayer(
    binding,
    decorate(binding, handler, options)
  )
}
