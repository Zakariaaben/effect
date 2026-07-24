/**
 * Optional post-commit Effect Workflow adapter for BPMN CallActivity commands.
 *
 * **Details**
 *
 * The portable BPMN kernel and the caller-provided durable relation authority
 * remain the only sources of parent-child meaning. This adapter consumes an
 * already-committed protocol-version `3` child outbox command and delegates
 * only native execution mechanics:
 *
 * - submit a deterministically addressed child run;
 * - request safe interruption of an already-addressed child run; or
 * - acknowledge abandonment without touching the child backend.
 *
 * Native `start` and `interrupt` results are operational acknowledgements.
 * They never become `ChildStartAccepted`, `ChildCancellationAccepted`,
 * `ChildCancelled`, or another semantic child event. A cooperating child host
 * and durable relation authority must publish those independently with stable
 * source-event identities and relation-local sequence numbers.
 *
 * The adapter owns no journal, outbox, inbox, relation store, scheduler,
 * worker, lease, retry loop, lifecycle polling, or persistence driver.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as NativeWorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as BpmnCallActivityV3 from "./BpmnCallActivityV3.ts"
import * as ChildWorkflowLifecycleV3 from "./ChildWorkflowLifecycleV3.ts"
import * as ChildWorkflowProtocolV3 from "./ChildWorkflowProtocolV3.ts"
import type * as ChildWorkflowStateV3 from "./ChildWorkflowStateV3.ts"
import type * as ChildWorkflowV3 from "./ChildWorkflowV3.ts"
import * as EffectWorkflowBackendV3 from "./EffectWorkflowBackendV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of this optional CallActivity adapter.
 *
 * @category constants
 * @since 4.0.0
 */
export const AdapterVersion = 1 as const

/**
 * Version of adapter dispatch receipts.
 *
 * @category constants
 * @since 4.0.0
 */
export const ReceiptVersion = 1 as const

/**
 * Version of native lifecycle ingress requests.
 *
 * @category constants
 * @since 4.0.0
 */
export const LifecycleIngressRequestVersion = 1 as const

/**
 * Version of prepared native lifecycle ingress capabilities.
 *
 * @category constants
 * @since 4.0.0
 */
export const PreparedLifecycleIngressVersion = 1 as const

/**
 * Stable backend identifier stored in portable CallActivity locators.
 *
 * @category constants
 * @since 4.0.0
 */
export const BackendId = "effect-workflow-native-child-v1" as const

/**
 * Locator restricted to this native child backend.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeBackendLocator = BpmnCallActivityV3.BackendLocator.check(
  Schema.makeFilter(
    (locator) =>
      locator.backendId === BackendId ||
      [{
        path: ["backendId"],
        issue: `backendId must equal '${BackendId}'`
      }]
  )
).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeBackendLocator",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NativeBackendLocator}.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeBackendLocator = Schema.Schema.Type<
  typeof NativeBackendLocator
>

const NativeLifecycleIngressRequestStruct = Schema.Struct({
  requestVersion: Schema.Literal(LifecycleIngressRequestVersion),
  lifecycle: ChildWorkflowLifecycleV3.PrepareLifecycleEventRequest,
  locator: Schema.optionalKey(NativeBackendLocator)
}).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeLifecycleIngressRequestStruct",
  parseOptions: strictParseOptions
})

/**
 * Exact native address plus one lifecycle source fact.
 *
 * **Details**
 *
 * Accepted-start, cancellation-acceptance, and terminal facts require the
 * exact native child locator. A permanent `ChildStartFailed` fact represents a
 * run which was never accepted and therefore forbids a locator.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeLifecycleIngressRequest = NativeLifecycleIngressRequestStruct.check(
  Schema.makeFilter((request) => {
    const startFailed = request.lifecycle.fact._tag === "ChildStartFailed"
    if (startFailed && request.locator !== undefined) {
      return [{
        path: ["locator"],
        issue: "ChildStartFailed must not claim an accepted native child address"
      }]
    }
    if (!startFailed && request.locator === undefined) {
      return [{
        path: ["locator"],
        issue: "Child-originated lifecycle facts require the exact native child address"
      }]
    }
    return []
  })
).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeLifecycleIngressRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NativeLifecycleIngressRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeLifecycleIngressRequest = Schema.Schema.Type<
  typeof NativeLifecycleIngressRequest
>

/**
 * Why a durable relation authority suppressed a native child start.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeStartSuppressionReason = Schema.Literals([
  "CancelledBeforeStart",
  "Abandoned",
  "ChildTerminal"
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeStartSuppressionReason"
})

/**
 * The decoded type of {@link NativeStartSuppressionReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeStartSuppressionReason = Schema.Schema.Type<
  typeof NativeStartSuppressionReason
>

/**
 * First durable schedule arbitration, performed before target resolution.
 *
 * **Details**
 *
 * `ResolveNativeTarget` carries an authority-issued claim. The authority must
 * fence that claim again in `admitNativeStart`; it is not permission to start
 * by itself.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SchedulePreparation = Schema.Union([
  Schema.TaggedStruct("ResolveNativeTarget", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier
  }),
  Schema.TaggedStruct("NativeStartAlreadyRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("NativeStartSuppressed", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    reason: NativeStartSuppressionReason
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3SchedulePreparation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SchedulePreparation}.
 *
 * @category models
 * @since 4.0.0
 */
export type SchedulePreparation = Schema.Schema.Type<
  typeof SchedulePreparation
>

/**
 * Final durable start arbitration after the exact native address is known.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeStartAdmission = Schema.Union([
  Schema.TaggedStruct("SubmitNativeStart", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("NativeStartAlreadyRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("NativeStartSuppressed", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    reason: NativeStartSuppressionReason
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeStartAdmission",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NativeStartAdmission}.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeStartAdmission = Schema.Schema.Type<
  typeof NativeStartAdmission
>

/**
 * Durable acknowledgement after native start submission.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeStartRecord = Schema.Union([
  Schema.TaggedStruct("NativeStartAddressRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("NativeStartAddressAlreadyRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeStartRecord",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NativeStartRecord}.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeStartRecord = Schema.Schema.Type<typeof NativeStartRecord>

/**
 * Why a cancellation command requires no native interruption.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NoNativeInterruptionReason = Schema.Literals([
  "CancelledBeforeStart",
  "ChildTerminal",
  "Abandoned"
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NoNativeInterruptionReason"
})

/**
 * The decoded type of {@link NoNativeInterruptionReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type NoNativeInterruptionReason = Schema.Schema.Type<
  typeof NoNativeInterruptionReason
>

/**
 * Durable cancellation arbitration.
 *
 * **Details**
 *
 * `AwaitNativeStartAddress` asks the outbox relay to retry later. It prevents
 * an interruption sent before the native start address is durably usable from
 * being mistaken for completed cancellation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationDisposition = Schema.Union([
  Schema.TaggedStruct("SubmitNativeInterruption", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("NativeInterruptionAlreadyRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("AwaitNativeStartAddress", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier
  }),
  Schema.TaggedStruct("NoNativeInterruption", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    reason: NoNativeInterruptionReason
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3CancellationDisposition",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationDisposition}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationDisposition = Schema.Schema.Type<
  typeof CancellationDisposition
>

/**
 * Durable acknowledgement after a native interruption request.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeInterruptionRecord = Schema.Union([
  Schema.TaggedStruct("NativeInterruptionRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator
  }),
  Schema.TaggedStruct("NativeInterruptionAlreadyRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeInterruptionRecord",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NativeInterruptionRecord}.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeInterruptionRecord = Schema.Schema.Type<
  typeof NativeInterruptionRecord
>

/**
 * Durable acknowledgement of an abandon command.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AbandonRecord = Schema.Union([
  Schema.TaggedStruct("AbandonRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier
  }),
  Schema.TaggedStruct("AbandonAlreadyRecorded", {
    adapterVersion: Schema.Literal(AdapterVersion),
    commandId: Wire.Identifier
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3AbandonRecord",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AbandonRecord}.
 *
 * @category models
 * @since 4.0.0
 */
export type AbandonRecord = Schema.Schema.Type<typeof AbandonRecord>

const NativeStartReceipt = Schema.Union([
  Schema.TaggedStruct("NativeStartSubmitted", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator,
    addressRecord: Schema.Literals([
      "Recorded",
      "AlreadyRecorded"
    ]),
    semanticEventProduced: Schema.Literal(false)
  }),
  Schema.TaggedStruct("NativeStartAlreadyRecorded", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    locator: NativeBackendLocator,
    semanticEventProduced: Schema.Literal(false)
  }),
  Schema.TaggedStruct("NativeStartSuppressed", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    reason: NativeStartSuppressionReason,
    semanticEventProduced: Schema.Literal(false)
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3NativeStartReceipt",
  parseOptions: strictParseOptions
})

/**
 * Operational receipt from one schedule-command dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleDispatchReceipt = NativeStartReceipt

/**
 * The decoded type of {@link ScheduleDispatchReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleDispatchReceipt = Schema.Schema.Type<
  typeof ScheduleDispatchReceipt
>

/**
 * Operational receipt from one child-cancellation command dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationDispatchReceipt = Schema.Union([
  Schema.TaggedStruct("NativeInterruptionSubmitted", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    claimId: Wire.Identifier,
    locator: NativeBackendLocator,
    interruptionRecord: Schema.Literals([
      "Recorded",
      "AlreadyRecorded"
    ]),
    semanticEventProduced: Schema.Literal(false)
  }),
  Schema.TaggedStruct("NativeInterruptionAlreadyRecorded", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    locator: NativeBackendLocator,
    semanticEventProduced: Schema.Literal(false)
  }),
  Schema.TaggedStruct("AwaitingNativeStartAddress", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    semanticEventProduced: Schema.Literal(false)
  }),
  Schema.TaggedStruct("NoNativeInterruption", {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    reason: NoNativeInterruptionReason,
    semanticEventProduced: Schema.Literal(false)
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3CancellationDispatchReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationDispatchReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationDispatchReceipt = Schema.Schema.Type<
  typeof CancellationDispatchReceipt
>

/**
 * Operational receipt from one abandon-command dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AbandonDispatchReceipt = Schema.TaggedStruct(
  "AbandonAcknowledged",
  {
    receiptVersion: Schema.Literal(ReceiptVersion),
    backendId: Schema.Literal(BackendId),
    commandId: Wire.Identifier,
    abandonRecord: Schema.Literals([
      "Recorded",
      "AlreadyRecorded"
    ]),
    semanticEventProduced: Schema.Literal(false)
  }
).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3AbandonDispatchReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AbandonDispatchReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type AbandonDispatchReceipt = Schema.Schema.Type<
  typeof AbandonDispatchReceipt
>

/**
 * Closed operational result vocabulary for generic dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchReceipt = Schema.Union([
  ScheduleDispatchReceipt,
  CancellationDispatchReceipt,
  AbandonDispatchReceipt
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3DispatchReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DispatchReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchReceipt = Schema.Schema.Type<typeof DispatchReceipt>

const freezeReceipt = <A extends DispatchReceipt>(receipt: A): A => Object.freeze(receipt)

/**
 * Stable adapter invariant failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  UnexpectedCommand: "UnexpectedCommand",
  InvalidBindingRegistry: "InvalidBindingRegistry",
  DuplicateBinding: "DuplicateBinding",
  InvalidLifecycleIngressRequest: "InvalidLifecycleIngressRequest",
  InvalidAuthorityResult: "InvalidAuthorityResult",
  AuthorityCommandMismatch: "AuthorityCommandMismatch",
  AuthorityClaimMismatch: "AuthorityClaimMismatch",
  AuthorityLocatorMismatch: "AuthorityLocatorMismatch",
  NativeExecutionAddressMismatch: "NativeExecutionAddressMismatch"
} as const

/**
 * Stable adapter invariant failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.UnexpectedCommand,
  ErrorCodes.InvalidBindingRegistry,
  ErrorCodes.DuplicateBinding,
  ErrorCodes.InvalidLifecycleIngressRequest,
  ErrorCodes.InvalidAuthorityResult,
  ErrorCodes.AuthorityCommandMismatch,
  ErrorCodes.AuthorityClaimMismatch,
  ErrorCodes.AuthorityLocatorMismatch,
  ErrorCodes.NativeExecutionAddressMismatch
])

/**
 * Failure at the CallActivity native-adapter boundary.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowBpmnCallActivityError extends Schema.TaggedErrorClass<
  EffectWorkflowBpmnCallActivityError
>("@effect/workflow-builder/EffectWorkflowBpmnCallActivityV3/Error")(
  "EffectWorkflowBpmnCallActivityError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    commandId: Schema.optionalKey(Wire.Identifier)
  },
  { parseOptions: strictParseOptions }
) {}

const adapterError = (
  code: ErrorCode,
  message: string,
  commandId?: string
): EffectWorkflowBpmnCallActivityError =>
  new EffectWorkflowBpmnCallActivityError({
    code,
    message,
    ...(commandId === undefined ? undefined : { commandId })
  })

/**
 * Failure resolving one exact target to a prepared native binding.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildBindingResolutionError extends Schema.TaggedErrorClass<
  ChildBindingResolutionError
>("@effect/workflow-builder/EffectWorkflowBpmnCallActivityV3/BindingResolutionError")(
  "ChildBindingResolutionError",
  {
    code: Wire.AtomicIdentifier,
    message: Schema.NonEmptyString,
    retryable: Schema.Boolean,
    artifactDigest: Schema.optionalKey(Wire.ArtifactDigest)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Durable relation-authority operation names.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RelationAuthorityOperation = Schema.Literals([
  "prepareSchedule",
  "admitNativeStart",
  "recordNativeStart",
  "selectCancellation",
  "recordNativeInterruption",
  "acknowledgeAbandon"
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnCallActivityV3RelationAuthorityOperation"
})

/**
 * The decoded type of {@link RelationAuthorityOperation}.
 *
 * @category models
 * @since 4.0.0
 */
export type RelationAuthorityOperation = Schema.Schema.Type<
  typeof RelationAuthorityOperation
>

/**
 * Failure returned by the caller-owned durable relation authority.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildRelationAuthorityError extends Schema.TaggedErrorClass<
  ChildRelationAuthorityError
>("@effect/workflow-builder/EffectWorkflowBpmnCallActivityV3/RelationAuthorityError")(
  "ChildRelationAuthorityError",
  {
    operation: RelationAuthorityOperation,
    code: Wire.AtomicIdentifier,
    message: Schema.NonEmptyString,
    retryable: Schema.Boolean,
    commandId: Schema.optionalKey(Wire.Identifier),
    cause: Schema.optionalKey(Schema.Json)
  },
  { parseOptions: strictParseOptions }
) {}

type CommandWithPayload<P extends ChildWorkflowProtocolV3.CommandPayload> =
  & Omit<ChildWorkflowProtocolV3.Command, "payload">
  & { readonly payload: P }

/**
 * Exact schedule-command view passed to adapter services.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleCommand = CommandWithPayload<
  ChildWorkflowProtocolV3.ScheduleChild
>

/**
 * Exact cancellation-command view passed to adapter services.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationCommand = CommandWithPayload<
  ChildWorkflowProtocolV3.RequestChildCancellation
>

/**
 * Exact abandon-command view passed to adapter services.
 *
 * @category models
 * @since 4.0.0
 */
export type AbandonCommand = CommandWithPayload<
  ChildWorkflowProtocolV3.AbandonChild
>

/**
 * Dynamic exact-target resolver supplied by the application.
 *
 * @category services
 * @since 4.0.0
 */
export class ChildBindingResolver extends Context.Service<
  ChildBindingResolver,
  {
    readonly resolve: (
      target: ChildWorkflowV3.ChildTargetPin
    ) => Effect.Effect<
      EffectWorkflowBackendV3.PreparedBinding,
      ChildBindingResolutionError
    >
  }
>()(
  "@effect/workflow-builder/EffectWorkflowBpmnCallActivityV3/ChildBindingResolver"
) {}

/**
 * Durable parent-child relation authority supplied by the application.
 *
 * **Details**
 *
 * Every method must be idempotent by canonical `commandId`. Schedule claims
 * must be fenced across `prepareSchedule`, `admitNativeStart`, and
 * `recordNativeStart`. A crash after native start but before address recording
 * is recovered by redelivery: native start uses the same deterministic
 * execution identifier.
 *
 * The authority also owns the schedule-versus-close race and all semantic
 * child event allocation. Returning `CancelledBeforeStart` means the
 * authority has durably won that race; it does not ask this adapter to invent
 * the corresponding event.
 *
 * @category services
 * @since 4.0.0
 */
export class ChildRelationAuthority extends Context.Service<
  ChildRelationAuthority,
  {
    readonly prepareSchedule: (
      command: ScheduleCommand
    ) => Effect.Effect<SchedulePreparation, ChildRelationAuthorityError>
    readonly admitNativeStart: (input: {
      readonly command: ScheduleCommand
      readonly claimId: Wire.Identifier
      readonly locator: NativeBackendLocator
    }) => Effect.Effect<NativeStartAdmission, ChildRelationAuthorityError>
    readonly recordNativeStart: (input: {
      readonly command: ScheduleCommand
      readonly claimId: Wire.Identifier
      readonly locator: NativeBackendLocator
    }) => Effect.Effect<NativeStartRecord, ChildRelationAuthorityError>
    readonly selectCancellation: (
      command: CancellationCommand
    ) => Effect.Effect<CancellationDisposition, ChildRelationAuthorityError>
    readonly recordNativeInterruption: (input: {
      readonly command: CancellationCommand
      readonly claimId: Wire.Identifier
      readonly locator: NativeBackendLocator
    }) => Effect.Effect<
      NativeInterruptionRecord,
      ChildRelationAuthorityError
    >
    readonly acknowledgeAbandon: (
      command: AbandonCommand
    ) => Effect.Effect<AbandonRecord, ChildRelationAuthorityError>
  }
>()(
  "@effect/workflow-builder/EffectWorkflowBpmnCallActivityV3/ChildRelationAuthority"
) {}

const decodeNativeLifecycleIngressRequest = Schema.decodeUnknownResult(
  NativeLifecycleIngressRequest,
  strictParseOptions
)

const validateNativeLifecycleIngressRequest = (
  input: unknown
): Result.Result<
  NativeLifecycleIngressRequest,
  EffectWorkflowBpmnCallActivityError
> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(adapterError(
      ErrorCodes.InvalidLifecycleIngressRequest,
      `Native child lifecycle ingress must be bounded strict JSON: ${snapshot.failure.message}`
    ))
  }
  let decoded: ReturnType<
    typeof decodeNativeLifecycleIngressRequest
  >
  try {
    decoded = decodeNativeLifecycleIngressRequest(snapshot.success)
  } catch {
    return Result.fail(adapterError(
      ErrorCodes.InvalidLifecycleIngressRequest,
      "Native child lifecycle ingress validation threw unexpectedly"
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(adapterError(
      ErrorCodes.InvalidLifecycleIngressRequest,
      `Invalid native child lifecycle ingress: ${decoded.failure}`
    ))
    : Result.succeed(
      snapshot.success as unknown as NativeLifecycleIngressRequest
    )
}

/**
 * Opaque native child lifecycle projection prepared for parent ingress.
 *
 * **Details**
 *
 * This value proves only deterministic validation and transition preparation.
 * A durable relation authority must still atomically deduplicate the source
 * fact, append `lifecycle.event` at `expectedPreviousSequence`, and apply or
 * enqueue `command` against the matching parent execution.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedNativeLifecycleIngress {
  readonly preparedVersion: typeof PreparedLifecycleIngressVersion
  readonly bindingArtifactDigest: Wire.ArtifactDigest
  readonly expectedPreviousSequence: number
  readonly locator?: NativeBackendLocator
  readonly lifecycle: ChildWorkflowLifecycleV3.PreparedLifecycleEvent
  readonly command: BpmnCallActivityV3.ApplyChildEventCommand
}

const preparedNativeLifecycleIngress = new WeakSet<object>()

/**
 * Tests whether a value is the exact capability returned by
 * {@link prepareNativeLifecycleIngress}.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPreparedNativeLifecycleIngress = (
  value: unknown
): value is PreparedNativeLifecycleIngress =>
  typeof value === "object" &&
  value !== null &&
  preparedNativeLifecycleIngress.has(value)

/**
 * Prepares one authoritative native child lifecycle fact for parent ingress.
 *
 * **Details**
 *
 * The exact prepared backend binding must reproduce the relation's complete
 * child target. When a locator is required, its deterministic execution ID is
 * recomputed from the relation's tenant and child run before any command is
 * returned. The function neither persists nor applies the command.
 *
 * `ChildStartFailed` remains a start-authority decision after permanent
 * rejection or retry exhaustion. It is the only lifecycle fact accepted
 * without a native locator.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareNativeLifecycleIngress = Effect.fnUntraced(function*(
  binding: EffectWorkflowBackendV3.PreparedBinding,
  state: ChildWorkflowStateV3.ChildWorkflowState,
  requestInput: unknown
) {
  const request = yield* Effect.fromResult(
    validateNativeLifecycleIngressRequest(requestInput)
  )
  const lifecycle = yield* Effect.fromResult(
    ChildWorkflowLifecycleV3.prepareLifecycleEvent(
      state,
      request.lifecycle
    )
  )
  yield* Effect.fromResult(
    EffectWorkflowBackendV3.validateChildTargetBinding(
      binding,
      lifecycle.nextState.relation.target
    )
  )
  if (request.locator !== undefined) {
    const expectedExecutionId = yield* EffectWorkflowBackendV3.executionIdForRun(binding, {
      tenantId: lifecycle.nextState.tenantId,
      runId: lifecycle.nextState.relation.childRunId
    })
    if (request.locator.executionId !== expectedExecutionId) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.NativeExecutionAddressMismatch,
        "The lifecycle source locator addresses a different native child run",
        lifecycle.event.eventId
      ))
    }
  }
  const command = yield* Effect.fromResult(
    BpmnCallActivityV3.validateApplyChildEventCommand({
      commandVersion: BpmnCallActivityV3.ApplyChildEventCommandVersion,
      executionProtocolVersion: ChildWorkflowProtocolV3.ExecutionProtocolVersion,
      callFrameId: lifecycle.nextState.callId,
      event: lifecycle.event,
      ...(request.locator === undefined
        ? undefined
        : { backendLocator: request.locator })
    })
  )
  const prepared: PreparedNativeLifecycleIngress = Object.freeze({
    preparedVersion: PreparedLifecycleIngressVersion,
    bindingArtifactDigest: binding.artifactDigest,
    expectedPreviousSequence: lifecycle.expectedPreviousSequence,
    ...(request.locator === undefined
      ? undefined
      : { locator: request.locator }),
    lifecycle,
    command
  })
  preparedNativeLifecycleIngress.add(prepared)
  return prepared
})

const validateServiceResult = <A>(
  schema: Schema.Codec<A, Schema.Json>,
  input: unknown,
  label: string,
  commandId: string
): Result.Result<A, EffectWorkflowBpmnCallActivityError> => {
  const snapshot = Json.snapshot(input, {
    maxArrayLength: 64,
    maxContainers: 128,
    maxDepth: 32,
    maxEntries: 512,
    maxStringBytes: 4_096,
    maxTotalBytes: 32_768
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(adapterError(
      ErrorCodes.InvalidAuthorityResult,
      `${label} must be bounded strict JSON: ${snapshot.failure.message}`,
      commandId
    ))
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = Schema.decodeUnknownResult(
      schema,
      strictParseOptions
    )(snapshot.success)
  } catch {
    return Result.fail(adapterError(
      ErrorCodes.InvalidAuthorityResult,
      `${label} schema validation threw unexpectedly`,
      commandId
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(adapterError(
      ErrorCodes.InvalidAuthorityResult,
      `Invalid ${label}: ${decoded.failure}`,
      commandId
    ))
  }
  return Result.succeed(snapshot.success as A)
}

const requireCommand = (
  expected: string,
  actual: string,
  commandId: string
): Effect.Effect<void, EffectWorkflowBpmnCallActivityError> =>
  expected === actual
    ? Effect.void
    : Effect.fail(adapterError(
      ErrorCodes.AuthorityCommandMismatch,
      "The durable authority returned a result for a different child command",
      commandId
    ))

const requireClaim = (
  expected: string,
  actual: string,
  commandId: string
): Effect.Effect<void, EffectWorkflowBpmnCallActivityError> =>
  expected === actual
    ? Effect.void
    : Effect.fail(adapterError(
      ErrorCodes.AuthorityClaimMismatch,
      "The durable authority changed the fenced child dispatch claim",
      commandId
    ))

const locatorEquals = (
  left: NativeBackendLocator,
  right: NativeBackendLocator
): boolean =>
  left.locatorVersion === right.locatorVersion &&
  left.backendId === right.backendId &&
  left.executionId === right.executionId

const requireLocator = (
  expected: NativeBackendLocator,
  actual: NativeBackendLocator,
  commandId: string
): Effect.Effect<void, EffectWorkflowBpmnCallActivityError> =>
  locatorEquals(expected, actual)
    ? Effect.void
    : Effect.fail(adapterError(
      ErrorCodes.AuthorityLocatorMismatch,
      "The durable authority returned a different native child locator",
      commandId
    ))

const makeNativeLocator = (
  executionId: string
): NativeBackendLocator =>
  Object.freeze({
    locatorVersion: BpmnCallActivityV3.BackendLocatorVersion,
    backendId: BackendId,
    executionId
  })

const validateCommand = (
  input: unknown
): Effect.Effect<
  ChildWorkflowProtocolV3.Command,
  ChildWorkflowProtocolV3.ChildWorkflowProtocolValidationError
> => Effect.fromResult(ChildWorkflowProtocolV3.validateCommand(input))

const scheduleCommand = (
  input: unknown
): Effect.Effect<
  ScheduleCommand,
  | ChildWorkflowProtocolV3.ChildWorkflowProtocolValidationError
  | EffectWorkflowBpmnCallActivityError
> =>
  Effect.flatMap(validateCommand(input), (command) =>
    command.payload._tag === "ScheduleChild"
      ? Effect.succeed(command as ScheduleCommand)
      : Effect.fail(adapterError(
        ErrorCodes.UnexpectedCommand,
        "Expected a ScheduleChild command",
        command.commandId
      )))

const cancellationCommand = (
  input: unknown
): Effect.Effect<
  CancellationCommand,
  | ChildWorkflowProtocolV3.ChildWorkflowProtocolValidationError
  | EffectWorkflowBpmnCallActivityError
> =>
  Effect.flatMap(validateCommand(input), (command) =>
    command.payload._tag === "RequestChildCancellation"
      ? Effect.succeed(command as CancellationCommand)
      : Effect.fail(adapterError(
        ErrorCodes.UnexpectedCommand,
        "Expected a RequestChildCancellation command",
        command.commandId
      )))

const abandonCommand = (
  input: unknown
): Effect.Effect<
  AbandonCommand,
  | ChildWorkflowProtocolV3.ChildWorkflowProtocolValidationError
  | EffectWorkflowBpmnCallActivityError
> =>
  Effect.flatMap(validateCommand(input), (command) =>
    command.payload._tag === "AbandonChild"
      ? Effect.succeed(command as AbandonCommand)
      : Effect.fail(adapterError(
        ErrorCodes.UnexpectedCommand,
        "Expected an AbandonChild command",
        command.commandId
      )))

const resolveBinding = Effect.fnUntraced(function*(
  target: ChildWorkflowV3.ChildTargetPin
) {
  const resolver = yield* ChildBindingResolver
  const binding = yield* resolver.resolve(target)
  yield* Effect.fromResult(
    EffectWorkflowBackendV3.validateChildTargetBinding(binding, target)
  )
  return binding
})

const validatePreparation = (
  command: ScheduleCommand,
  input: unknown
): Effect.Effect<
  SchedulePreparation,
  EffectWorkflowBpmnCallActivityError
> =>
  Effect.gen(function*() {
    const preparation = yield* Effect.fromResult(validateServiceResult(
      SchedulePreparation,
      input,
      "schedule preparation",
      command.commandId
    ))
    yield* requireCommand(
      command.commandId,
      preparation.commandId,
      command.commandId
    )
    return preparation
  })

const validateStartAdmission = (
  command: ScheduleCommand,
  claimId: string,
  locator: NativeBackendLocator,
  input: unknown
): Effect.Effect<
  NativeStartAdmission,
  EffectWorkflowBpmnCallActivityError
> =>
  Effect.gen(function*() {
    const admission = yield* Effect.fromResult(validateServiceResult(
      NativeStartAdmission,
      input,
      "native start admission",
      command.commandId
    ))
    yield* requireCommand(
      command.commandId,
      admission.commandId,
      command.commandId
    )
    if (admission._tag === "SubmitNativeStart") {
      yield* requireClaim(claimId, admission.claimId, command.commandId)
      yield* requireLocator(locator, admission.locator, command.commandId)
    } else if (admission._tag === "NativeStartAlreadyRecorded") {
      yield* requireLocator(locator, admission.locator, command.commandId)
    }
    return admission
  })

const validateStartRecord = (
  command: ScheduleCommand,
  claimId: string,
  locator: NativeBackendLocator,
  input: unknown
): Effect.Effect<
  NativeStartRecord,
  EffectWorkflowBpmnCallActivityError
> =>
  Effect.gen(function*() {
    const record = yield* Effect.fromResult(validateServiceResult(
      NativeStartRecord,
      input,
      "native start record",
      command.commandId
    ))
    yield* requireCommand(command.commandId, record.commandId, command.commandId)
    yield* requireClaim(claimId, record.claimId, command.commandId)
    yield* requireLocator(locator, record.locator, command.commandId)
    return record
  })

const validateCancellationDisposition = (
  command: CancellationCommand,
  input: unknown
): Effect.Effect<
  CancellationDisposition,
  EffectWorkflowBpmnCallActivityError
> =>
  Effect.gen(function*() {
    const disposition = yield* Effect.fromResult(validateServiceResult(
      CancellationDisposition,
      input,
      "cancellation disposition",
      command.commandId
    ))
    yield* requireCommand(
      command.commandId,
      disposition.commandId,
      command.commandId
    )
    return disposition
  })

const validateInterruptionRecord = (
  command: CancellationCommand,
  claimId: string,
  locator: NativeBackendLocator,
  input: unknown
): Effect.Effect<
  NativeInterruptionRecord,
  EffectWorkflowBpmnCallActivityError
> =>
  Effect.gen(function*() {
    const record = yield* Effect.fromResult(validateServiceResult(
      NativeInterruptionRecord,
      input,
      "native interruption record",
      command.commandId
    ))
    yield* requireCommand(command.commandId, record.commandId, command.commandId)
    yield* requireClaim(claimId, record.claimId, command.commandId)
    yield* requireLocator(locator, record.locator, command.commandId)
    return record
  })

const validateAbandonRecord = (
  command: AbandonCommand,
  input: unknown
): Effect.Effect<
  AbandonRecord,
  EffectWorkflowBpmnCallActivityError
> =>
  Effect.gen(function*() {
    const record = yield* Effect.fromResult(validateServiceResult(
      AbandonRecord,
      input,
      "abandon record",
      command.commandId
    ))
    yield* requireCommand(command.commandId, record.commandId, command.commandId)
    return record
  })

const dispatchValidatedSchedule = Effect.fnUntraced(function*(
  command: ScheduleCommand
) {
  const authority = yield* ChildRelationAuthority
  const prepared = yield* authority.prepareSchedule(command).pipe(
    Effect.flatMap((value) => validatePreparation(command, value))
  )
  if (prepared._tag === "NativeStartAlreadyRecorded") {
    return freezeReceipt(
      {
        _tag: "NativeStartAlreadyRecorded",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        locator: prepared.locator,
        semanticEventProduced: false
      } satisfies ScheduleDispatchReceipt
    )
  }
  if (prepared._tag === "NativeStartSuppressed") {
    return freezeReceipt(
      {
        _tag: "NativeStartSuppressed",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        reason: prepared.reason,
        semanticEventProduced: false
      } satisfies ScheduleDispatchReceipt
    )
  }

  const binding = yield* resolveBinding(command.relation.target)
  const invocation = {
    tenantId: command.tenantId,
    runId: command.relation.childRunId,
    requestId: command.relation.startRequestId,
    input: command.payload.encodedInput
  }
  const expectedExecutionId = yield* EffectWorkflowBackendV3.executionId(
    binding,
    invocation
  )
  const locator = makeNativeLocator(expectedExecutionId)
  const admission = yield* authority.admitNativeStart({
    command,
    claimId: prepared.claimId,
    locator
  }).pipe(
    Effect.flatMap((value) =>
      validateStartAdmission(
        command,
        prepared.claimId,
        locator,
        value
      )
    )
  )
  if (admission._tag === "NativeStartAlreadyRecorded") {
    return freezeReceipt(
      {
        _tag: "NativeStartAlreadyRecorded",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        locator: admission.locator,
        semanticEventProduced: false
      } satisfies ScheduleDispatchReceipt
    )
  }
  if (admission._tag === "NativeStartSuppressed") {
    return freezeReceipt(
      {
        _tag: "NativeStartSuppressed",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        reason: admission.reason,
        semanticEventProduced: false
      } satisfies ScheduleDispatchReceipt
    )
  }

  const submittedExecutionId = yield* EffectWorkflowBackendV3.start(
    binding,
    invocation
  )
  if (submittedExecutionId !== locator.executionId) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.NativeExecutionAddressMismatch,
      "Native start returned an execution identifier different from its deterministic preflight address",
      command.commandId
    ))
  }
  const record = yield* authority.recordNativeStart({
    command,
    claimId: prepared.claimId,
    locator
  }).pipe(
    Effect.flatMap((value) =>
      validateStartRecord(
        command,
        prepared.claimId,
        locator,
        value
      )
    )
  )
  return freezeReceipt(
    {
      _tag: "NativeStartSubmitted",
      receiptVersion: ReceiptVersion,
      backendId: BackendId,
      commandId: command.commandId,
      claimId: prepared.claimId,
      locator,
      addressRecord: record._tag === "NativeStartAddressRecorded"
        ? "Recorded"
        : "AlreadyRecorded",
      semanticEventProduced: false
    } satisfies ScheduleDispatchReceipt
  )
})

/**
 * Dispatches one exact committed `ScheduleChild` command.
 *
 * @category execution
 * @since 4.0.0
 */
export const dispatchSchedule = Effect.fnUntraced(function*(
  commandInput: unknown
) {
  const command = yield* scheduleCommand(commandInput)
  return yield* dispatchValidatedSchedule(command)
})

const dispatchValidatedCancellation = Effect.fnUntraced(function*(
  command: CancellationCommand
) {
  const authority = yield* ChildRelationAuthority
  const disposition = yield* authority.selectCancellation(command).pipe(
    Effect.flatMap((value) => validateCancellationDisposition(command, value))
  )
  if (disposition._tag === "NativeInterruptionAlreadyRecorded") {
    return freezeReceipt(
      {
        _tag: "NativeInterruptionAlreadyRecorded",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        locator: disposition.locator,
        semanticEventProduced: false
      } satisfies CancellationDispatchReceipt
    )
  }
  if (disposition._tag === "AwaitNativeStartAddress") {
    return freezeReceipt(
      {
        _tag: "AwaitingNativeStartAddress",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        semanticEventProduced: false
      } satisfies CancellationDispatchReceipt
    )
  }
  if (disposition._tag === "NoNativeInterruption") {
    return freezeReceipt(
      {
        _tag: "NoNativeInterruption",
        receiptVersion: ReceiptVersion,
        backendId: BackendId,
        commandId: command.commandId,
        reason: disposition.reason,
        semanticEventProduced: false
      } satisfies CancellationDispatchReceipt
    )
  }

  const binding = yield* resolveBinding(command.relation.target)
  const expectedExecutionId = yield* EffectWorkflowBackendV3.executionIdForRun(binding, {
    tenantId: command.tenantId,
    runId: command.relation.childRunId
  })
  if (disposition.locator.executionId !== expectedExecutionId) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.NativeExecutionAddressMismatch,
      "The cancellation authority selected a locator for a different native child run",
      command.commandId
    ))
  }
  yield* EffectWorkflowBackendV3.interrupt(
    binding,
    disposition.locator.executionId
  )
  const record = yield* authority.recordNativeInterruption({
    command,
    claimId: disposition.claimId,
    locator: disposition.locator
  }).pipe(
    Effect.flatMap((value) =>
      validateInterruptionRecord(
        command,
        disposition.claimId,
        disposition.locator,
        value
      )
    )
  )
  return freezeReceipt(
    {
      _tag: "NativeInterruptionSubmitted",
      receiptVersion: ReceiptVersion,
      backendId: BackendId,
      commandId: command.commandId,
      claimId: disposition.claimId,
      locator: disposition.locator,
      interruptionRecord: record._tag === "NativeInterruptionRecorded"
        ? "Recorded"
        : "AlreadyRecorded",
      semanticEventProduced: false
    } satisfies CancellationDispatchReceipt
  )
})

/**
 * Dispatches one exact committed `RequestChildCancellation` command.
 *
 * **Details**
 *
 * This function returns after operational interruption submission. It never
 * polls for termination and never produces a semantic cancellation event.
 *
 * @category execution
 * @since 4.0.0
 */
export const dispatchCancellation = Effect.fnUntraced(function*(
  commandInput: unknown
) {
  const command = yield* cancellationCommand(commandInput)
  return yield* dispatchValidatedCancellation(command)
})

const dispatchValidatedAbandon = Effect.fnUntraced(function*(
  command: AbandonCommand
) {
  const authority = yield* ChildRelationAuthority
  const record = yield* authority.acknowledgeAbandon(command).pipe(
    Effect.flatMap((value) => validateAbandonRecord(command, value))
  )
  return freezeReceipt(
    {
      _tag: "AbandonAcknowledged",
      receiptVersion: ReceiptVersion,
      backendId: BackendId,
      commandId: command.commandId,
      abandonRecord: record._tag === "AbandonRecorded"
        ? "Recorded"
        : "AlreadyRecorded",
      semanticEventProduced: false
    } satisfies AbandonDispatchReceipt
  )
})

/**
 * Acknowledges one exact committed `AbandonChild` command.
 *
 * **Details**
 *
 * This path deliberately requires neither a binding resolver nor a native
 * `WorkflowEngine`. It never starts, polls, resumes, or interrupts the child.
 *
 * @category execution
 * @since 4.0.0
 */
export const dispatchAbandon = Effect.fnUntraced(function*(
  commandInput: unknown
) {
  const command = yield* abandonCommand(commandInput)
  return yield* dispatchValidatedAbandon(command)
})

/**
 * Dispatches any exact committed protocol-version `3` child command.
 *
 * @category execution
 * @since 4.0.0
 */
export const dispatch = Effect.fnUntraced(function*(
  commandInput: unknown
) {
  const command = yield* validateCommand(commandInput)
  switch (command.payload._tag) {
    case "ScheduleChild":
      return yield* dispatchValidatedSchedule(command as ScheduleCommand)
    case "RequestChildCancellation":
      return yield* dispatchValidatedCancellation(
        command as CancellationCommand
      )
    case "AbandonChild":
      return yield* dispatchValidatedAbandon(command as AbandonCommand)
  }
})

/**
 * Builds an immutable digest-indexed resolver from exact prepared bindings.
 *
 * **Details**
 *
 * Target equality is still checked by
 * {@link EffectWorkflowBackendV3.validateChildTargetBinding} after resolution;
 * digest lookup is routing, not authorization.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeBindingResolver = (
  bindings: ReadonlyArray<EffectWorkflowBackendV3.PreparedBinding>
): Result.Result<
  ChildBindingResolver["Service"],
  EffectWorkflowBpmnCallActivityError
> => {
  if (!Array.isArray(bindings)) {
    return Result.fail(adapterError(
      ErrorCodes.InvalidBindingRegistry,
      "The native child binding registry must be an array"
    ))
  }
  const index = new Map<
    Wire.ArtifactDigest,
    EffectWorkflowBackendV3.PreparedBinding
  >()
  try {
    for (const binding of bindings) {
      if (!EffectWorkflowBackendV3.isPrepared(binding)) {
        return Result.fail(adapterError(
          ErrorCodes.InvalidBindingRegistry,
          "Every native child binding must be the exact object returned by EffectWorkflowBackendV3.prepare"
        ))
      }
      if (index.has(binding.artifactDigest)) {
        return Result.fail(adapterError(
          ErrorCodes.DuplicateBinding,
          `Duplicate native child binding for artifact '${binding.artifactDigest}'`
        ))
      }
      index.set(binding.artifactDigest, binding)
    }
  } catch {
    return Result.fail(adapterError(
      ErrorCodes.InvalidBindingRegistry,
      "The native child binding registry could not be inspected safely"
    ))
  }
  const service = ChildBindingResolver.of(Object.freeze({
    resolve: (
      target: ChildWorkflowV3.ChildTargetPin
    ): Effect.Effect<
      EffectWorkflowBackendV3.PreparedBinding,
      ChildBindingResolutionError
    > => {
      const binding = index.get(target.artifactDigest)
      return binding === undefined
        ? Effect.fail(
          new ChildBindingResolutionError({
            code: "TargetNotRegistered",
            message: `No prepared native child binding is registered for artifact '${target.artifactDigest}'`,
            retryable: false,
            artifactDigest: target.artifactDigest
          })
        )
        : Effect.succeed(binding)
    }
  }))
  return Result.succeed(service)
}

/**
 * Builds a layer containing a digest-indexed exact child binding resolver.
 *
 * @category layers
 * @since 4.0.0
 */
export const bindingResolverLayer = (
  bindings: ReadonlyArray<EffectWorkflowBackendV3.PreparedBinding>
): Layer.Layer<
  ChildBindingResolver,
  EffectWorkflowBpmnCallActivityError
> => Layer.effect(ChildBindingResolver, Effect.fromResult(makeBindingResolver(bindings)))

/**
 * Complete environment required by generic native child dispatch.
 *
 * @category utility types
 * @since 4.0.0
 */
export type DispatchRequirements =
  | ChildBindingResolver
  | ChildRelationAuthority
  | NativeWorkflowEngine.WorkflowEngine
