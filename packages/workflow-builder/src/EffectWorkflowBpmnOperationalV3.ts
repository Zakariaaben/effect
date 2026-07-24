/**
 * Optional native Effect Workflow post-commit adapter for operational BPMN
 * instance withdrawal.
 *
 * **Details**
 *
 * The portable {@link BpmnKernel} transition remains the sole authority for
 * withdrawal. This module accepts only a kernel-validated, durably withdrawn
 * snapshot and then exposes two explicit operational choices:
 *
 * - notify one already-cancelled native catch channel so its host can reload
 *   portable state; or
 * - safely interrupt the complete native workflow that hosts the portable
 *   execution.
 *
 * It owns no state store, journal, scheduler, deferred registry, timer
 * cancellation, activity cancellation, queue, or replay engine. In
 * particular, a successful native interruption request is not evidence that
 * an external side effect was revoked.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import type * as NativeWorkflow from "effect/unstable/workflow/WorkflowEngine"
import type * as BpmnExecutionState from "./BpmnExecutionState.ts"
import * as BpmnKernel from "./BpmnKernel.ts"
import * as EffectWorkflowBackendV3 from "./EffectWorkflowBackendV3.ts"
import * as EffectWorkflowBpmnEventV3 from "./EffectWorkflowBpmnEventV3.ts"
import * as ProtocolV3Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of this optional native post-commit adapter.
 *
 * @category constants
 * @since 4.0.0
 */
export const AdapterVersion = 1 as const

/**
 * Stable machine-readable adapter failures.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidExecutionState: "InvalidExecutionState",
  WithdrawalNotCommitted: "WithdrawalNotCommitted",
  WithdrawalRequestMismatch: "WithdrawalRequestMismatch",
  UnpreparedWithdrawal: "UnpreparedWithdrawal",
  WaitGroupNotCancelled: "WaitGroupNotCancelled",
  UnpreparedWaitNotification: "UnpreparedWaitNotification",
  NativeExecutionAddressMismatch: "NativeExecutionAddressMismatch"
} as const

/**
 * A stable adapter failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidExecutionState,
  ErrorCodes.WithdrawalNotCommitted,
  ErrorCodes.WithdrawalRequestMismatch,
  ErrorCodes.UnpreparedWithdrawal,
  ErrorCodes.WaitGroupNotCancelled,
  ErrorCodes.UnpreparedWaitNotification,
  ErrorCodes.NativeExecutionAddressMismatch
])

/**
 * Failure at the optional native operational-withdrawal boundary.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowBpmnOperationalError extends Schema.TaggedErrorClass<
  EffectWorkflowBpmnOperationalError
>("@effect/workflow-builder/EffectWorkflowBpmnOperationalV3/Error")(
  "EffectWorkflowBpmnOperationalError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const adapterError = (
  code: ErrorCode,
  message: string
): EffectWorkflowBpmnOperationalError => new EffectWorkflowBpmnOperationalError({ code, message })

/**
 * Opaque proof that the portable withdrawal has already committed.
 *
 * **Details**
 *
 * Public fields are inspectable diagnostics. Authority comes from the exact
 * object returned by {@link prepareCommittedWithdrawal}; structural copies
 * are rejected.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedCommittedWithdrawal {
  readonly adapterVersion: typeof AdapterVersion
  readonly requestId: ProtocolV3Wire.AtomicIdentifier
  readonly rootScopeInstanceId: ProtocolV3Wire.Identifier
  readonly executableFingerprint: BpmnExecutionState.ModelReference[
    "executableFingerprint"
  ]
  readonly withdrawnAt: ProtocolV3Wire.Timestamp
  readonly cancelledWaitGroupIds: ReadonlyArray<ProtocolV3Wire.Identifier>
}

interface TrustedCommittedWithdrawal {
  readonly kernel: BpmnKernel.CompiledKernel
  readonly state: BpmnExecutionState.BpmnExecutionState
}

const preparedWithdrawals = new WeakMap<
  object,
  TrustedCommittedWithdrawal
>()

/**
 * Opaque post-commit capability for one native catch channel whose portable
 * wait group is already cancelled.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedCancelledWaitNotification {
  readonly adapterVersion: typeof AdapterVersion
  readonly requestId: ProtocolV3Wire.AtomicIdentifier
  readonly waitGroupId: ProtocolV3Wire.Identifier
  readonly address: EffectWorkflowBpmnEventV3.NativeExecutionAddress
  readonly preparedWaitGroup: EffectWorkflowBpmnEventV3.PreparedWaitGroup
}

interface TrustedCancelledWaitNotification {
  readonly withdrawal: PreparedCommittedWithdrawal
  readonly preparedWaitGroup: EffectWorkflowBpmnEventV3.PreparedWaitGroup
}

const preparedWaitNotifications = new WeakMap<
  object,
  TrustedCancelledWaitNotification
>()

const requirePreparedWithdrawal = (
  prepared: PreparedCommittedWithdrawal
): Effect.Effect<
  TrustedCommittedWithdrawal,
  EffectWorkflowBpmnOperationalError
> => {
  const trusted = typeof prepared === "object" && prepared !== null
    ? preparedWithdrawals.get(prepared)
    : undefined
  return trusted === undefined
    ? Effect.fail(adapterError(
      ErrorCodes.UnpreparedWithdrawal,
      "Operational actions require the exact capability returned by prepareCommittedWithdrawal"
    ))
    : Effect.succeed(trusted)
}

const requirePreparedWaitNotification = (
  prepared: PreparedCancelledWaitNotification
): Effect.Effect<
  TrustedCancelledWaitNotification,
  EffectWorkflowBpmnOperationalError
> => {
  const trusted = typeof prepared === "object" && prepared !== null
    ? preparedWaitNotifications.get(prepared)
    : undefined
  return trusted === undefined
    ? Effect.fail(adapterError(
      ErrorCodes.UnpreparedWaitNotification,
      "Native catch notification requires the exact capability returned by prepareCancelledWaitNotification"
    ))
    : Effect.succeed(trusted)
}

/**
 * Authenticates a committed portable withdrawal and prepares an opaque
 * post-commit capability.
 *
 * **Details**
 *
 * This is deliberately impossible on an active, completed, failed, forged,
 * or differently-requested snapshot. Callers must first atomically persist
 * the batch returned by `BpmnKernel.withdrawExecution`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareCommittedWithdrawal = Effect.fnUntraced(function*(
  kernel: BpmnKernel.CompiledKernel,
  stateInput: unknown,
  requestIdInput: unknown
) {
  const requestId = Schema.decodeUnknownResult(
    ProtocolV3Wire.AtomicIdentifier,
    strictParseOptions
  )(requestIdInput)
  if (Result.isFailure(requestId)) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.WithdrawalRequestMismatch,
      `Invalid operational withdrawal request identity: ${requestId.failure.message}`
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
  if (
    state.status !== "cancelled" ||
    state.operationalWithdrawal === undefined ||
    state.completedAt === undefined
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.WithdrawalNotCommitted,
      "The portable execution has not committed an operational instance withdrawal"
    ))
  }
  if (
    state.operationalWithdrawal.command.requestId !== requestId.success
  ) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.WithdrawalRequestMismatch,
      "The committed operational withdrawal belongs to a different request identity"
    ))
  }
  const cancelledWaitGroupIds = Object.freeze(
    state.catchWaitGroups
      .filter((group) =>
        group.status === "cancelled" &&
        group.cancellationReason === "execution-cancelled"
      )
      .map((group) => group.waitGroupId)
      .sort((left, right) => left.localeCompare(right))
  )
  const prepared: PreparedCommittedWithdrawal = Object.freeze({
    adapterVersion: AdapterVersion,
    requestId: requestId.success,
    rootScopeInstanceId: state.operationalWithdrawal.command.rootScopeInstanceId,
    executableFingerprint: state.model.executableFingerprint,
    withdrawnAt: state.completedAt as ProtocolV3Wire.Timestamp,
    cancelledWaitGroupIds
  })
  preparedWithdrawals.set(prepared, {
    kernel,
    state
  })
  return prepared
})

/**
 * Reconstructs one cancelled native catch channel from committed portable
 * state.
 *
 * **Details**
 *
 * This prepares a post-commit notification only. The native token must come
 * from the host's durable execution binding or outbox; this adapter does not
 * persist tokens or invent a second delivery mechanism.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareCancelledWaitNotification = Effect.fnUntraced(function*(
  withdrawal: PreparedCommittedWithdrawal,
  waitGroupId: string,
  addressInput: unknown
) {
  const trusted = yield* requirePreparedWithdrawal(withdrawal)
  if (!withdrawal.cancelledWaitGroupIds.includes(waitGroupId)) {
    return yield* Effect.fail(adapterError(
      ErrorCodes.WaitGroupNotCancelled,
      `Catch wait group '${waitGroupId}' was not cancelled by this operational withdrawal`
    ))
  }
  const preparedWaitGroup = yield* EffectWorkflowBpmnEventV3.prepareWaitGroup(
    trusted.kernel,
    trusted.state,
    waitGroupId,
    addressInput
  )
  const prepared: PreparedCancelledWaitNotification = Object.freeze({
    adapterVersion: AdapterVersion,
    requestId: withdrawal.requestId,
    waitGroupId,
    address: preparedWaitGroup.address,
    preparedWaitGroup
  })
  preparedWaitNotifications.set(prepared, {
    withdrawal,
    preparedWaitGroup
  })
  return prepared
})

/**
 * Resolves one cancelled catch channel with a post-commit reload hint.
 *
 * **Details**
 *
 * Native deferred first-wins behavior is only a wake-up mechanism. The host
 * must reload portable state after waking; this function does not decide a
 * BPMN race or reopen the cancelled wait.
 *
 * @category execution
 * @since 4.0.0
 */
export const notifyCancelledWait = (
  prepared: PreparedCancelledWaitNotification,
  token: NativeDeferred.Token
): Effect.Effect<
  EffectWorkflowBpmnEventV3.NativeCatchWakeV1,
  | EffectWorkflowBpmnOperationalError
  | EffectWorkflowBpmnEventV3.EffectWorkflowBpmnEventError,
  NativeWorkflow.WorkflowEngine
> =>
  Effect.gen(function*() {
    const trusted = yield* requirePreparedWaitNotification(prepared)
    yield* requirePreparedWithdrawal(trusted.withdrawal)
    return yield* EffectWorkflowBpmnEventV3.notifyStateChanged(
      trusted.preparedWaitGroup,
      token,
      {
        changeId: prepared.requestId,
        reason: "cancelled"
      }
    )
  })

/**
 * Safely interrupts the complete native host after portable withdrawal
 * committed.
 *
 * **Details**
 *
 * This is an explicit whole-host choice. Local scope or catch cancellation
 * must use portable state plus {@link notifyCancelledWait}. The public Effect
 * Workflow interruption path preserves its finalizer and child propagation
 * behavior; `interruptUnsafe` is intentionally not exposed.
 *
 * Completion of this effect confirms only that the native engine accepted the
 * interruption request. It does not prove physical cancellation of a remote
 * service, human action, or side effect that already committed.
 *
 * @category execution
 * @since 4.0.0
 */
export const interruptCommittedHost = (
  withdrawal: PreparedCommittedWithdrawal,
  binding: EffectWorkflowBackendV3.PreparedBinding,
  addressInput: unknown
): Effect.Effect<
  void,
  | EffectWorkflowBpmnOperationalError
  | EffectWorkflowBackendV3.EffectWorkflowBackendError,
  NativeWorkflow.WorkflowEngine
> =>
  Effect.gen(function*() {
    yield* requirePreparedWithdrawal(withdrawal)
    const address = Schema.decodeUnknownResult(
      EffectWorkflowBpmnEventV3.NativeExecutionAddress,
      strictParseOptions
    )(addressInput)
    if (Result.isFailure(address)) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.NativeExecutionAddressMismatch,
        `Invalid native execution address: ${address.failure.message}`
      ))
    }
    if (address.success.workflowName !== binding.workflowTag) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.NativeExecutionAddressMismatch,
        "The native execution address does not name the prepared host workflow"
      ))
    }
    yield* EffectWorkflowBackendV3.interrupt(
      binding,
      address.success.executionId
    )
  })
