/**
 * Optional native Effect Workflow wake-up adapter for durable BPMN catch
 * events.
 *
 * **Details**
 *
 * This module deliberately does not own BPMN timer state, correlation,
 * cancellation, race selection, or replay. The portable BPMN kernel remains
 * the sole authority for those decisions. Native `DurableClock.schedule` and
 * one typed `DurableDeferred` per wait group only provide durable wake-up
 * hints.
 *
 * A caller must first validate the complete execution snapshot through the
 * supplied {@link BpmnKernel.CompiledKernel}. Scheduling is absolute and
 * idempotent by a domain-separated stable `scheduleId`; recovery may therefore
 * prepare and arm the same still-`scheduled` timer again after a crash. The
 * returned acknowledgement remains a command for the portable kernel and is
 * not applied here.
 *
 * @since 4.0.0
 */
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as NativeClock from "effect/unstable/workflow/DurableClock"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import type * as NativeWorkflow from "effect/unstable/workflow/WorkflowEngine"
import * as BpmnEventV3 from "./BpmnEventV3.ts"
import * as BpmnExecutionState from "./BpmnExecutionState.ts"
import * as BpmnKernel from "./BpmnKernel.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV3Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the native catch wake envelope.
 *
 * @category constants
 * @since 4.0.0
 */
export const NativeCatchWakeVersion = 1 as const

/**
 * Version of deterministic native catch identities.
 *
 * @category constants
 * @since 4.0.0
 */
export const NativeCatchIdentityVersion = 1 as const

/**
 * Stable backend identity recorded in portable timer-arm receipts.
 *
 * @category constants
 * @since 4.0.0
 */
export const BackendId = "effect-workflow-native-catch-v1" as const

/**
 * Maximum UTF-8 length of a generated native deferred name.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumDeferredNameBytes = 256 as const

const DeferredNamePrefix = "@effect/workflow-builder/bpmn-catch/v1/wake/"
const ScheduleIdPrefix = "effect-workflow-catch-schedule-v1:"
const ReceiptIdPrefix = "effect-workflow-catch-receipt-v1:"

/**
 * Caller-owned address of the native Effect Workflow execution hosting one
 * portable BPMN execution.
 *
 * **Details**
 *
 * The portable BPMN snapshot deliberately has no native workflow address.
 * The host must persist this binding beside its execution record and supply
 * it again during recovery. It is an address, not an authentication
 * credential.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeExecutionAddress = Schema.Struct({
  workflowName: ProtocolV3Wire.Identifier,
  executionId: ProtocolV3Wire.Identifier
}).annotate({
  identifier: "WorkflowEffectWorkflowBpmnNativeExecutionAddressV1",
  parseOptions: strictParseOptions
})

/**
 * Decoded native execution address.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeExecutionAddress = Schema.Schema.Type<
  typeof NativeExecutionAddress
>

/**
 * Exact optimistic coordinates of one catch wait group.
 *
 * **Details**
 *
 * Unlike a Timer or Message ingress target, a generic state-change wake-up
 * belongs to the group itself and must not invent an arm identity. This also
 * permits durable suspension of Message-only catch groups.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WaitGroupTarget = Schema.Struct({
  waitGroupId: ProtocolV3Wire.Identifier,
  scopeInstanceId: ProtocolV3Wire.Identifier,
  ownerTokenId: ProtocolV3Wire.Identifier,
  generation: ProtocolV3Wire.PositiveSafeInt
}).annotate({
  identifier: "WorkflowEffectWorkflowBpmnWaitGroupTargetV1",
  parseOptions: strictParseOptions
})

/**
 * Decoded exact wait-group coordinates.
 *
 * @category models
 * @since 4.0.0
 */
export type WaitGroupTarget = Schema.Schema.Type<typeof WaitGroupTarget>

/**
 * Closed reason vocabulary for a post-commit state-change hint.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StateChangedReason = Schema.Literals([
  "message-committed",
  "cancelled",
  "repaired"
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnStateChangedReasonV1"
})

/**
 * Decoded post-commit state-change reason.
 *
 * @category models
 * @since 4.0.0
 */
export type StateChangedReason = Schema.Schema.Type<
  typeof StateChangedReason
>

/**
 * Closed, versioned hint stored in a native durable deferred.
 *
 * **Details**
 *
 * `TimerDueHint` means only that a native timer delivery may now be useful.
 * It never asserts that the referenced timer won. `StateChanged` is an
 * application-issued post-commit notification which asks a suspended native
 * workflow to reload portable state. Whichever value reaches the deferred
 * first is merely the first wake-up hint, not the BPMN race winner.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NativeCatchWakeV1 = Schema.Union([
  Schema.TaggedStruct("TimerDueHint", {
    wakeVersion: Schema.Literal(NativeCatchWakeVersion),
    backendId: Schema.Literal(BackendId),
    target: BpmnEventV3.CatchArmTarget,
    timerId: ProtocolV3Wire.Identifier,
    scheduleId: ProtocolV3Wire.Identifier,
    dueAt: ProtocolV3Wire.Timestamp
  }),
  Schema.TaggedStruct("StateChanged", {
    wakeVersion: Schema.Literal(NativeCatchWakeVersion),
    backendId: Schema.Literal(BackendId),
    target: WaitGroupTarget,
    changeId: ProtocolV3Wire.AtomicIdentifier,
    reason: StateChangedReason,
    committedStateVersion: Schema.Literal(
      BpmnExecutionState.BpmnExecutionStateVersion
    ),
    notifiedAt: ProtocolV3Wire.Timestamp
  })
]).annotate({
  identifier: "WorkflowEffectWorkflowBpmnNativeCatchWakeV1",
  parseOptions: strictParseOptions
})

/**
 * Decoded native catch wake hint.
 *
 * @category models
 * @since 4.0.0
 */
export type NativeCatchWakeV1 = Schema.Schema.Type<
  typeof NativeCatchWakeV1
>

const StateChangedInput = Schema.Struct({
  changeId: ProtocolV3Wire.AtomicIdentifier,
  reason: StateChangedReason
}).annotate({
  identifier: "WorkflowEffectWorkflowBpmnStateChangedInput",
  parseOptions: strictParseOptions
})

/**
 * Stable machine-readable native catch adapter failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidExecutionState: "InvalidExecutionState",
  InvalidNativeExecutionAddress: "InvalidNativeExecutionAddress",
  WaitGroupNotFound: "WaitGroupNotFound",
  WaitGroupNotLive: "WaitGroupNotLive",
  TimerNotFound: "TimerNotFound",
  TimerNotSchedulable: "TimerNotSchedulable",
  InconsistentCoordinates: "InconsistentCoordinates",
  InvalidDeadline: "InvalidDeadline",
  InvalidPreparedWaitGroup: "InvalidPreparedWaitGroup",
  InvalidPreparedTimerArm: "InvalidPreparedTimerArm",
  InvalidStateChangedInput: "InvalidStateChangedInput",
  InvalidStateChangeReason: "InvalidStateChangeReason",
  InvalidWake: "InvalidWake"
} as const

/**
 * Native catch adapter failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidExecutionState,
  ErrorCodes.InvalidNativeExecutionAddress,
  ErrorCodes.WaitGroupNotFound,
  ErrorCodes.WaitGroupNotLive,
  ErrorCodes.TimerNotFound,
  ErrorCodes.TimerNotSchedulable,
  ErrorCodes.InconsistentCoordinates,
  ErrorCodes.InvalidDeadline,
  ErrorCodes.InvalidPreparedWaitGroup,
  ErrorCodes.InvalidPreparedTimerArm,
  ErrorCodes.InvalidStateChangedInput,
  ErrorCodes.InvalidStateChangeReason,
  ErrorCodes.InvalidWake
])

/**
 * A deterministic preparation or hint-validation failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowBpmnEventError extends Schema.TaggedErrorClass<
  EffectWorkflowBpmnEventError
>("@effect/workflow-builder/EffectWorkflowBpmnEventV3/Error")(
  "EffectWorkflowBpmnEventError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const adapterError = (
  code: ErrorCode,
  message: string
): EffectWorkflowBpmnEventError => new EffectWorkflowBpmnEventError({ code, message })

/**
 * One wait group authenticated by a compiled BPMN kernel and mapped to a
 * shared native typed deferred.
 *
 * **Details**
 *
 * A group may contain only Message arms, only Timer arms, or the admitted
 * combination. All arms share this one hint channel. `observedStatus` records
 * whether the capability came from the waiting or a closed snapshot. This
 * permits an outbox worker to reconstruct the same channel after the portable
 * Message/cancellation commit and a crash before notification. Instances are
 * opaque runtime capabilities and must be reconstructed from portable state
 * during recovery rather than persisted.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedWaitGroup {
  readonly preparationVersion: 1
  readonly backendId: typeof BackendId
  readonly address: NativeExecutionAddress
  readonly executableFingerprint: BpmnExecutionState.ModelReference[
    "executableFingerprint"
  ]
  readonly target: WaitGroupTarget
  readonly observedStatus: BpmnExecutionState.CatchWaitGroup["status"]
  readonly observedMessageDeliveryId?: string | undefined
  readonly deferredName: string
  readonly deferred: NativeDeferred.DurableDeferred<
    typeof NativeCatchWakeV1,
    typeof Schema.Never
  >
}

/**
 * Opaque proof that a typed wake value was returned by
 * {@link awaitWake}.
 *
 * **Details**
 *
 * The decoded hint remains inspectable, but conversion to a trusted backend
 * Timer observation requires this capability rather than arbitrary
 * schema-valid JSON.
 *
 * @category models
 * @since 4.0.0
 */
export interface ObservedNativeCatchWake {
  readonly wake: NativeCatchWakeV1
}

/**
 * A scheduled or acknowledged-armed Timer authenticated by a compiled BPMN
 * kernel and mapped to one absolute native schedule on its prepared wait
 * group's shared deferred.
 *
 * **Details**
 *
 * A `scheduled` capability may arm the native schedule. An `armed` capability
 * can be reconstructed after acknowledgement to await and authenticate the
 * eventual wake without scheduling again.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedTimerArm {
  readonly preparationVersion: 1
  readonly backendId: typeof BackendId
  readonly waitGroup: PreparedWaitGroup
  readonly target: BpmnEventV3.CatchArmTarget
  readonly timerId: string
  readonly observedTimerStatus: "scheduled" | "armed"
  readonly scheduledAt: ProtocolV3Wire.Timestamp
  readonly dueAt: ProtocolV3Wire.Timestamp
  readonly wakeUpAt: ProtocolV3Wire.Timestamp
  readonly scheduleId: string
  readonly receiptId: string
  readonly timerDueHint: Extract<
    NativeCatchWakeV1,
    { readonly _tag: "TimerDueHint" }
  >
}

const preparedWaitGroups = new WeakSet<object>()
const preparedTimerArms = new WeakSet<object>()
const observedNativeWakes = new WeakMap<
  object,
  {
    readonly wake: NativeCatchWakeV1
    readonly waitGroup: PreparedWaitGroup
  }
>()

const requirePreparedWaitGroup = (
  prepared: PreparedWaitGroup
): Effect.Effect<PreparedWaitGroup, EffectWorkflowBpmnEventError> =>
  typeof prepared === "object" &&
    prepared !== null &&
    preparedWaitGroups.has(prepared)
    ? Effect.succeed(prepared)
    : Effect.fail(adapterError(
      ErrorCodes.InvalidPreparedWaitGroup,
      "Wait-group operations require an opaque value returned by prepareWaitGroup"
    ))

const requirePrepared = (
  prepared: PreparedTimerArm
): Effect.Effect<PreparedTimerArm, EffectWorkflowBpmnEventError> =>
  typeof prepared === "object" &&
    prepared !== null &&
    preparedTimerArms.has(prepared)
    ? Effect.succeed(prepared)
    : Effect.fail(adapterError(
      ErrorCodes.InvalidPreparedTimerArm,
      "Timer-arm operations require an opaque value returned by prepareTimerArm"
    ))

const validateToken = (
  prepared: PreparedWaitGroup,
  token: NativeDeferred.Token
): Effect.Effect<void, EffectWorkflowBpmnEventError> =>
  Effect.try({
    try: () => {
      const parsed = NativeDeferred.TokenParsed.fromString(token)
      if (
        parsed.workflowName !== prepared.address.workflowName ||
        parsed.executionId !== prepared.address.executionId ||
        parsed.deferredName !== prepared.deferredName
      ) {
        throw new TypeError("native execution address mismatch")
      }
    },
    catch: () =>
      adapterError(
        ErrorCodes.InconsistentCoordinates,
        "The native deferred token does not match the prepared workflow, execution, and wait-group channel address"
      )
  })

const samePreparedWaitGroup = (
  left: PreparedWaitGroup,
  right: PreparedWaitGroup
): boolean =>
  left.backendId === right.backendId &&
  left.address.workflowName === right.address.workflowName &&
  left.address.executionId === right.address.executionId &&
  left.executableFingerprint === right.executableFingerprint &&
  left.target.waitGroupId === right.target.waitGroupId &&
  left.target.scopeInstanceId === right.target.scopeInstanceId &&
  left.target.ownerTokenId === right.target.ownerTokenId &&
  left.target.generation === right.target.generation &&
  left.deferredName === right.deferredName

const dateTimeAt = (
  value: string,
  label: string
): Effect.Effect<
  {
    readonly millis: number
    readonly dateTime: DateTime.Utc
    readonly timestamp: ProtocolV3Wire.Timestamp
  },
  EffectWorkflowBpmnEventError
> =>
  Effect.try({
    try: () => {
      const millis = Date.parse(value)
      if (!Number.isSafeInteger(millis)) {
        throw new RangeError("unsafe epoch milliseconds")
      }
      const dateTime = DateTime.makeUnsafe(millis)
      const timestamp = DateTime.formatIso(dateTime)
      if (timestamp !== value) {
        throw new RangeError("non-canonical timestamp")
      }
      return {
        millis,
        dateTime,
        timestamp: timestamp as ProtocolV3Wire.Timestamp
      }
    },
    catch: () =>
      adapterError(
        ErrorCodes.InvalidDeadline,
        `${label} must be an exactly representable canonical UTC millisecond timestamp`
      )
  })

const currentTimestamp = (
  label: string
): Effect.Effect<
  ProtocolV3Wire.Timestamp,
  EffectWorkflowBpmnEventError
> =>
  Effect.flatMap(
    Clock.currentTimeMillis,
    (millis) =>
      Effect.try({
        try: () => {
          if (!Number.isSafeInteger(millis)) {
            throw new RangeError("unsafe epoch milliseconds")
          }
          return DateTime.formatIso(
            DateTime.makeUnsafe(millis)
          ) as ProtocolV3Wire.Timestamp
        },
        catch: () =>
          adapterError(
            ErrorCodes.InvalidDeadline,
            `${label} could not be represented as a canonical UTC millisecond timestamp`
          )
      })
  )

const waitIdentityDigest = (
  state: BpmnExecutionState.BpmnExecutionState,
  target: WaitGroupTarget,
  address: NativeExecutionAddress
): Effect.Effect<
  Fingerprint.Digest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  Fingerprint.digest({
    identityVersion: NativeCatchIdentityVersion,
    domain: "@effect/workflow-builder/bpmn-catch/wait-deferred/v1",
    executableFingerprint: state.model.executableFingerprint,
    address,
    target
  })

const timerIdentityDigest = (
  domain: "timer-schedule" | "timer-receipt",
  state: BpmnExecutionState.BpmnExecutionState,
  address: NativeExecutionAddress,
  target: BpmnEventV3.CatchArmTarget,
  timerId: string,
  dueAt: ProtocolV3Wire.Timestamp
): Effect.Effect<
  Fingerprint.Digest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  Fingerprint.digest({
    identityVersion: NativeCatchIdentityVersion,
    domain: `@effect/workflow-builder/bpmn-catch/${domain}/v1`,
    executableFingerprint: state.model.executableFingerprint,
    address,
    target,
    timer: {
      timerId,
      dueAt
    }
  })

const prepareValidatedWaitGroup = Effect.fnUntraced(function*(
  state: BpmnExecutionState.BpmnExecutionState,
  group: BpmnExecutionState.CatchWaitGroup,
  address: NativeExecutionAddress
) {
  const token = state.tokens.find(
    (candidate) => candidate.tokenId === group.ownerTokenId
  )
  const arms = group.armIds.map((armId) =>
    state.subscriptions.find((candidate) =>
      candidate.waitGroupId === group.waitGroupId &&
      candidate.armId === armId
    )
  )
  const invalidCoordinates = arms.some((arm) =>
    arm === undefined ||
    arm.processId !== group.processId ||
    arm.scopeInstanceId !== group.scopeInstanceId ||
    arm.tokenId !== group.ownerTokenId ||
    arm.generation !== group.generation
  )
  const invalidLifecycle = group.status === "waiting"
    ? state.status !== "active" ||
      token?.status !== "active" ||
      arms.some((arm) => arm?.status !== "waiting")
    : token?.status === "active"
  if (
    token === undefined ||
    invalidCoordinates ||
    invalidLifecycle
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.WaitGroupNotLive,
      `Catch wait group '${group.waitGroupId}' does not match its validated owner and arm lifecycle`
    ))
  }
  const target: WaitGroupTarget = Object.freeze({
    waitGroupId: group.waitGroupId,
    scopeInstanceId: group.scopeInstanceId,
    ownerTokenId: group.ownerTokenId,
    generation: group.generation
  })
  const deferredDigest = yield* waitIdentityDigest(
    state,
    target,
    address
  )
  const messageDeliveries = state.messageDeliveries.filter(
    (delivery) =>
      delivery.target.waitGroupId === group.waitGroupId &&
      (
        delivery.disposition === "message-winner" ||
        delivery.disposition === "timer-preempted"
      )
  )
  const deferredName = `${DeferredNamePrefix}${deferredDigest}`
  if (
    new TextEncoder().encode(deferredName).byteLength >
      MaximumDeferredNameBytes
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InconsistentCoordinates,
      "The derived native catch deferred name exceeds its fixed byte limit"
    ))
  }
  const prepared: PreparedWaitGroup = Object.freeze({
    preparationVersion: 1 as const,
    backendId: BackendId,
    address: Object.freeze({ ...address }),
    executableFingerprint: state.model.executableFingerprint,
    target,
    observedStatus: group.status,
    observedMessageDeliveryId: messageDeliveries.length === 1
      ? messageDeliveries[0]!.receipt.deliveryId
      : undefined,
    deferredName,
    deferred: NativeDeferred.make(deferredName, {
      success: NativeCatchWakeV1
    })
  })
  preparedWaitGroups.add(prepared)
  return prepared
})

/**
 * Validates and prepares one exact catch wait group, including a Message-only
 * group, as one stable native typed wake-up channel.
 *
 * **Details**
 *
 * Waiting groups may suspend. Won or cancelled groups may only reconstruct
 * the channel for a post-commit notification. The caller-owned native address
 * participates in the identity and must be supplied exactly on recovery.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareWaitGroup = Effect.fnUntraced(function*(
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  waitGroupId: string,
  addressInput: unknown
) {
  const decodedAddress = Schema.decodeUnknownResult(
    NativeExecutionAddress,
    strictParseOptions
  )(addressInput)
  if (Result.isFailure(decodedAddress)) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InvalidNativeExecutionAddress,
      `Invalid native execution address: ${decodedAddress.failure.message}`
    ))
  }
  const checked = BpmnKernel.validateExecutionState(kernel, stateInput)
  if (Result.isFailure(checked)) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InvalidExecutionState,
      `The BPMN kernel rejected the execution snapshot: ${checked.failure.message}`
    ))
  }
  const group = checked.success.catchWaitGroups.find(
    (candidate) => candidate.waitGroupId === waitGroupId
  )
  if (group === undefined) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.WaitGroupNotFound,
      `Catch wait group '${waitGroupId}' does not exist in the validated execution snapshot`
    ))
  }
  return yield* prepareValidatedWaitGroup(
    checked.success,
    group,
    decodedAddress.success
  )
})

/**
 * Validates one complete portable state against its compiled kernel and
 * prepares exactly one still-live `scheduled` or `armed` Timer arm.
 *
 * **Details**
 *
 * The adapter does not claim authority from TypeScript typing alone:
 * `BpmnKernel.validateExecutionState` authenticates the kernel and validates
 * the full snapshot before any native identity is derived. A `scheduled`
 * result can be armed; an `armed` result must retain this adapter's exact
 * deterministic receipt and may only await/convert its wake. Fired,
 * cancelled, closed, stale, or coordinate-inconsistent timers are rejected.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareTimerArm = Effect.fnUntraced(function*(
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  timerId: string,
  addressInput: unknown
) {
  const decodedAddress = Schema.decodeUnknownResult(
    NativeExecutionAddress,
    strictParseOptions
  )(addressInput)
  if (Result.isFailure(decodedAddress)) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InvalidNativeExecutionAddress,
      `Invalid native execution address: ${decodedAddress.failure.message}`
    ))
  }
  const checked = BpmnKernel.validateExecutionState(kernel, stateInput)
  if (Result.isFailure(checked)) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InvalidExecutionState,
      `The BPMN kernel rejected the execution snapshot: ${checked.failure.message}`
    ))
  }
  const state = checked.success
  const timer = state.timers.find((candidate) => candidate.timerId === timerId)
  if (timer === undefined) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.TimerNotFound,
      `Timer '${timerId}' does not exist in the validated execution snapshot`
    ))
  }
  const group = state.catchWaitGroups.find(
    (candidate) => candidate.waitGroupId === timer.waitGroupId
  )
  const arm = state.subscriptions.find(
    (candidate) =>
      candidate.waitGroupId === timer.waitGroupId &&
      candidate.armId === timer.armId
  )
  const token = state.tokens.find(
    (candidate) => candidate.tokenId === timer.tokenId
  )
  if (
    state.status !== "active" ||
    (timer.status !== "scheduled" && timer.status !== "armed") ||
    group?.status !== "waiting" ||
    arm?._tag !== "TimerCatchSubscription" ||
    arm.status !== "waiting" ||
    token?.status !== "active"
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.TimerNotSchedulable,
      `Timer '${timerId}' must be a scheduled or armed member of one live waiting catch group`
    ))
  }
  if (
    arm.timerId !== timer.timerId ||
    group.ownerTokenId !== timer.tokenId ||
    group.scopeInstanceId !== timer.scopeInstanceId ||
    group.generation !== timer.generation ||
    !group.armIds.includes(timer.armId) ||
    arm.processId !== timer.processId ||
    arm.scopeInstanceId !== timer.scopeInstanceId ||
    arm.tokenId !== timer.tokenId ||
    arm.generation !== timer.generation
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InconsistentCoordinates,
      `Timer '${timerId}' does not exactly match its wait group, arm, and owner token`
    ))
  }

  const scheduled = yield* dateTimeAt(
    timer.scheduledAt,
    `Timer '${timerId}' scheduledAt`
  )
  const due = yield* dateTimeAt(
    timer.schedule.dueAt,
    `Timer '${timerId}' dueAt`
  )
  const wakeUp = due.millis < scheduled.millis
    ? scheduled
    : due
  const target: BpmnEventV3.CatchArmTarget = Object.freeze({
    waitGroupId: group.waitGroupId,
    armId: arm.armId,
    scopeInstanceId: group.scopeInstanceId,
    catchEventNodeId: arm.ownerNodeId,
    tokenId: group.ownerTokenId,
    generation: group.generation
  })
  const waitGroup = yield* prepareValidatedWaitGroup(
    state,
    group,
    decodedAddress.success
  )
  const scheduleDigest = yield* timerIdentityDigest(
    "timer-schedule",
    state,
    decodedAddress.success,
    target,
    timer.timerId,
    timer.schedule.dueAt
  )
  const receiptDigest = yield* timerIdentityDigest(
    "timer-receipt",
    state,
    decodedAddress.success,
    target,
    timer.timerId,
    timer.schedule.dueAt
  )
  const scheduleId = `${ScheduleIdPrefix}${scheduleDigest}`
  const receiptId = `${ReceiptIdPrefix}${receiptDigest}`
  if (
    timer.status === "armed" &&
    (
      timer.armReceipt?.backendId !== BackendId ||
      timer.armReceipt.scheduleId !== scheduleId ||
      timer.armReceipt.receiptId !== receiptId
    )
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.InconsistentCoordinates,
      `Armed Timer '${timerId}' does not retain this adapter's exact deterministic receipt identities`
    ))
  }
  const timerDueHint = Object.freeze({
    _tag: "TimerDueHint" as const,
    wakeVersion: NativeCatchWakeVersion,
    backendId: BackendId,
    target,
    timerId: timer.timerId,
    scheduleId,
    dueAt: timer.schedule.dueAt
  })
  const prepared: PreparedTimerArm = Object.freeze({
    preparationVersion: 1 as const,
    backendId: BackendId,
    waitGroup,
    target,
    timerId: timer.timerId,
    observedTimerStatus: timer.status,
    scheduledAt: scheduled.timestamp,
    dueAt: due.timestamp,
    wakeUpAt: wakeUp.timestamp,
    scheduleId,
    receiptId,
    timerDueHint
  })
  preparedTimerArms.add(prepared)
  return prepared
})

/**
 * Returns the native token for the prepared wait-group deferred in the current
 * workflow execution.
 *
 * @category constructors
 * @since 4.0.0
 */
export const wakeToken = (
  prepared: PreparedWaitGroup
): Effect.Effect<
  NativeDeferred.Token,
  EffectWorkflowBpmnEventError,
  NativeWorkflow.WorkflowInstance
> =>
  Effect.gen(function*() {
    const trusted = yield* requirePreparedWaitGroup(prepared)
    const token = yield* NativeDeferred.token(trusted.deferred)
    yield* validateToken(trusted, token)
    return token
  })

/**
 * Arms one absolute native timer and returns the portable acknowledgement
 * command only after native scheduling succeeds.
 *
 * **Details**
 *
 * The same prepared arm and token may be submitted again during recovery.
 * Native Effect Workflow keeps the first deadline and value for the stable
 * `scheduleId`. `armedAt` is a fresh trusted post-schedule observation, while
 * backend, schedule, and receipt identities remain stable.
 *
 * @category execution
 * @since 4.0.0
 */
export const armTimer = (
  prepared: PreparedTimerArm,
  token: NativeDeferred.Token
): Effect.Effect<
  BpmnEventV3.AcknowledgeTimerArmCommand,
  EffectWorkflowBpmnEventError,
  NativeWorkflow.WorkflowEngine
> =>
  Effect.gen(function*() {
    const trusted = yield* requirePrepared(prepared)
    yield* requirePreparedWaitGroup(trusted.waitGroup)
    if (
      trusted.waitGroup.observedStatus !== "waiting" ||
      trusted.observedTimerStatus !== "scheduled"
    ) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.WaitGroupNotLive,
        "A native Timer may only be armed from a scheduled capability prepared while its catch wait group is waiting"
      ))
    }
    yield* validateToken(trusted.waitGroup, token)
    yield* NativeClock.schedule(trusted.waitGroup.deferred, {
      token,
      scheduleId: trusted.scheduleId,
      wakeUp: DateTime.makeUnsafe(Date.parse(trusted.wakeUpAt)),
      value: trusted.timerDueHint
    })
    const armedAt = yield* currentTimestamp("Timer armedAt")
    return {
      commandVersion: BpmnEventV3.AcknowledgeTimerArmCommandVersion,
      target: trusted.target,
      timerId: trusted.timerId,
      receipt: {
        receiptVersion: BpmnEventV3.TimerArmReceiptVersion,
        backendId: trusted.backendId,
        scheduleId: trusted.scheduleId,
        receiptId: trusted.receiptId,
        armedAt
      }
    }
  })

/**
 * Awaits the first native wake-up hint for the wait group.
 *
 * **Details**
 *
 * Returning from this effect says nothing about the BPMN winner. Callers must
 * reload portable state and submit any Timer observation to the BPMN kernel.
 * Only a capability prepared from a waiting group may suspend, and the
 * current native Workflow address must match exactly.
 *
 * @category execution
 * @since 4.0.0
 */
export const awaitWake = (
  prepared: PreparedWaitGroup
): Effect.Effect<
  ObservedNativeCatchWake,
  EffectWorkflowBpmnEventError,
  NativeWorkflow.WorkflowEngine | NativeWorkflow.WorkflowInstance
> =>
  Effect.gen(function*() {
    const trusted = yield* requirePreparedWaitGroup(prepared)
    if (trusted.observedStatus !== "waiting") {
      return yield* Effect.fail(adapterError(
        ErrorCodes.WaitGroupNotLive,
        "A native catch wait may only suspend from a capability prepared while its group is waiting"
      ))
    }
    const token = yield* NativeDeferred.token(trusted.deferred)
    yield* validateToken(trusted, token)
    const wake = yield* NativeDeferred.await(trusted.deferred)
    const snapped = Json.snapshot(wake)
    if (Result.isFailure(snapped)) {
      const path = snapped.failure.path.length === 0
        ? ""
        : ` at ${snapped.failure.path.join(".")}`
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidWake,
        `The native catch wake is not strict JSON${path}: ${snapped.failure.message}`
      ))
    }
    const wakeSnapshot = snapped.success as NativeCatchWakeV1
    const observed: ObservedNativeCatchWake = Object.freeze({
      wake: wakeSnapshot
    })
    observedNativeWakes.set(observed, {
      wake: wakeSnapshot,
      waitGroup: trusted
    })
    return observed
  })

/**
 * Resolves the wait-group deferred with a post-commit state-change hint.
 *
 * **Details**
 *
 * The caller owns the state transaction and must invoke this only after that
 * transaction commits. Native `resolve` returns the canonical first value:
 * a prior Timer hint remains a Timer hint and a prior state notification
 * remains the original state notification.
 *
 * `message-committed` requires a capability re-prepared from a won snapshot
 * with one matching durable Message delivery ledger record and uses that
 * delivery ID as `changeId`. `cancelled` requires a re-prepared cancelled
 * group. `repaired` is the explicit host-owned repair path. `notifiedAt` is
 * sampled here and intentionally makes no claim about the earlier commit
 * instant.
 *
 * @category execution
 * @since 4.0.0
 */
export const notifyStateChanged = (
  prepared: PreparedWaitGroup,
  token: NativeDeferred.Token,
  input: unknown
): Effect.Effect<
  NativeCatchWakeV1,
  EffectWorkflowBpmnEventError,
  NativeWorkflow.WorkflowEngine
> =>
  Effect.gen(function*() {
    const trusted = yield* requirePreparedWaitGroup(prepared)
    yield* validateToken(trusted, token)
    const decoded = Schema.decodeUnknownResult(
      StateChangedInput,
      strictParseOptions
    )(input)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidStateChangedInput,
        `Invalid post-commit state-change hint: ${decoded.failure.message}`
      ))
    }
    if (
      decoded.success.reason === "message-committed" &&
      (
        trusted.observedStatus !== "won" ||
        trusted.observedMessageDeliveryId !== decoded.success.changeId
      )
    ) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidStateChangeReason,
        "message-committed requires a re-prepared won group with one exact matching Message delivery ledger identity"
      ))
    }
    if (
      decoded.success.reason === "cancelled" &&
      trusted.observedStatus !== "cancelled"
    ) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidStateChangeReason,
        "cancelled requires a re-prepared cancelled wait group"
      ))
    }
    const notifiedAt = yield* currentTimestamp("State change notifiedAt")
    const hint: NativeCatchWakeV1 = {
      _tag: "StateChanged",
      wakeVersion: NativeCatchWakeVersion,
      backendId: BackendId,
      target: trusted.target,
      changeId: decoded.success.changeId,
      reason: decoded.success.reason,
      committedStateVersion: BpmnExecutionState.BpmnExecutionStateVersion,
      notifiedAt
    }
    const canonical = yield* NativeDeferred.resolve(trusted.deferred, {
      token,
      exit: Exit.succeed(hint)
    })
    if (Exit.isFailure(canonical)) {
      return yield* Effect.die(canonical.cause)
    }
    return canonical.value
  })

/**
 * Converts a native Timer hint into a trusted-time observation command.
 *
 * **Details**
 *
 * A state-change hint returns `undefined`. Even a returned Timer command is
 * only an optimistic observation: `BpmnKernel.observeDueTimer` still verifies
 * the target, deadline, generation, and all competing timers before choosing
 * a winner. Arbitrary schema-valid JSON is insufficient: the wake must be an
 * opaque result of {@link awaitWake} for the same exact wait group, and its
 * Timer fields must match the supplied prepared schedule.
 *
 * @category constructors
 * @since 4.0.0
 */
export const timerObservationFromWake = (
  prepared: PreparedTimerArm,
  observationInput: unknown
): Effect.Effect<
  BpmnEventV3.ObserveDueTimerCommand | undefined,
  EffectWorkflowBpmnEventError
> =>
  Effect.gen(function*() {
    const trusted = yield* requirePrepared(prepared)
    if (
      typeof observationInput !== "object" ||
      observationInput === null
    ) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidWake,
        "Timer observation requires an opaque value returned by awaitWake"
      ))
    }
    const proof = observedNativeWakes.get(observationInput)
    if (proof === undefined) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidWake,
        "Timer observation requires an opaque value returned by awaitWake"
      ))
    }
    yield* requirePreparedWaitGroup(trusted.waitGroup)
    if (!samePreparedWaitGroup(proof.waitGroup, trusted.waitGroup)) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidWake,
        "The observed native wake belongs to different exact wait-group coordinates"
      ))
    }
    if (proof.wake._tag === "StateChanged") {
      return undefined
    }
    const wake = proof.wake
    if (
      wake.backendId !== trusted.backendId ||
      wake.timerId !== trusted.timerId ||
      wake.scheduleId !== trusted.scheduleId ||
      wake.dueAt !== trusted.dueAt ||
      wake.target.waitGroupId !== trusted.target.waitGroupId ||
      wake.target.armId !== trusted.target.armId ||
      wake.target.scopeInstanceId !== trusted.target.scopeInstanceId ||
      wake.target.catchEventNodeId !==
        trusted.target.catchEventNodeId ||
      wake.target.tokenId !== trusted.target.tokenId ||
      wake.target.generation !== trusted.target.generation
    ) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidWake,
        "The observed Timer hint does not match the prepared native schedule identity"
      ))
    }
    return {
      commandVersion: BpmnEventV3.ObserveDueTimerCommandVersion,
      target: wake.target,
      timerId: wake.timerId,
      observedAt: yield* currentTimestamp("Timer observedAt")
    }
  })
