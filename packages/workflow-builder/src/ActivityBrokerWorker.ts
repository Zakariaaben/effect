/**
 * One-shot broker settlement for durable activity deliveries.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityCancellationWorker from "./ActivityCancellationWorker.ts"
import * as ActivityConsumer from "./ActivityConsumer.ts"
import * as ActivityDeliveryStore from "./ActivityDeliveryStore.ts"
import * as ActivityRuntime from "./ActivityRuntime.ts"
import * as ActivityWorker from "./ActivityWorker.ts"
import type * as DurableRecovery from "./DurableRecovery.ts"
import * as Json from "./internal/json.ts"
import * as OutboxRelay from "./OutboxRelay.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Strict stable activity message published by the transactional outbox relay.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityMessage = OutboxRelay.ActivityMessage

/**
 * The decoded type of {@link ActivityMessage}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityMessage = OutboxRelay.ActivityMessage

/**
 * One concrete broker delivery and its detached raw JSON message.
 *
 * **Details**
 *
 * `deliveryId` identifies the broker delivery being settled. The raw message
 * remains JSON so a malformed activity envelope can still be safely routed to
 * a dead-letter destination.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BrokerDelivery = Schema.Struct({
  deliveryVersion: Schema.Literal(1),
  deliveryId: Schema.NonEmptyString,
  message: Schema.Json
}).annotate({
  identifier: "WorkflowActivityBrokerDelivery",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BrokerDelivery}.
 *
 * @category models
 * @since 4.0.0
 */
export type BrokerDelivery = Schema.Schema.Type<typeof BrokerDelivery>

/**
 * One bounded attempt to acquire, execute, durably complete, and settle a
 * broker delivery.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProcessRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  delivery: BrokerDelivery,
  workerId: Schema.NonEmptyString,
  workerDeploymentId: Schema.NonEmptyString,
  acquireRequestId: Schema.NonEmptyString,
  completionRequestId: Schema.NonEmptyString,
  settlementRequestId: Schema.NonEmptyString,
  leaseDurationMillis: PositiveSafeInt,
  retryDelayMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowProcessActivityBrokerDeliveryRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProcessRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessRequest = Schema.Schema.Type<typeof ProcessRequest>

/**
 * A detached description of the failure that selected a broker disposition.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FailureSummary = Schema.Struct({
  tag: Schema.NonEmptyString,
  message: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowActivityBrokerFailureSummary",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FailureSummary}.
 *
 * @category models
 * @since 4.0.0
 */
export type FailureSummary = Schema.Schema.Type<typeof FailureSummary>

/**
 * Broker acknowledgement after an accepted durable completion.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeCompletedRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  _tag: Schema.Literal("Acknowledge"),
  requestId: Schema.NonEmptyString,
  delivery: BrokerDelivery,
  reason: Schema.Literal("Completed")
}).annotate({
  identifier: "WorkflowAcknowledgeCompletedActivityDeliveryRequest",
  parseOptions: strictParseOptions
})

/**
 * Broker acknowledgement after storage authoritatively suppresses execution or
 * completion.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeSuppressedRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  _tag: Schema.Literal("Acknowledge"),
  requestId: Schema.NonEmptyString,
  delivery: BrokerDelivery,
  reason: Schema.Literal("Suppressed"),
  suppressionReason: Schema.Literals([
    "CancellationRequested",
    "RunTerminal",
    "AlreadyResolved",
    "NotScheduled"
  ])
}).annotate({
  identifier: "WorkflowAcknowledgeSuppressedActivityDeliveryRequest",
  parseOptions: strictParseOptions
})

/**
 * Strict request accepted by a broker acknowledgement adapter.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeRequest = Schema.Union([
  AcknowledgeCompletedRequest,
  AcknowledgeSuppressedRequest
]).annotate({
  identifier: "WorkflowAcknowledgeActivityDeliveryRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgeRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgeRequest = Schema.Schema.Type<typeof AcknowledgeRequest>

/**
 * Stable reasons for delayed broker redelivery.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryReason = Schema.Literals([
  "Busy",
  "Transient",
  "StaleLease",
  "WorkerUnavailable",
  "WorkerFailure"
])

/**
 * The decoded type of {@link RetryReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryReason = Schema.Schema.Type<typeof RetryReason>

/**
 * Delays one broker delivery without acknowledging it.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  _tag: Schema.Literal("Retry"),
  requestId: Schema.NonEmptyString,
  delivery: BrokerDelivery,
  reason: RetryReason,
  delayMillis: PositiveSafeInt,
  failure: FailureSummary
}).annotate({
  identifier: "WorkflowRetryActivityDeliveryRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryRequest = Schema.Schema.Type<typeof RetryRequest>

/**
 * Stable poison-delivery classifications.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeadLetterReason = Schema.Literals([
  "Malformed",
  "PinMismatch",
  "RequestConflict"
])

/**
 * The decoded type of {@link DeadLetterReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeadLetterReason = Schema.Schema.Type<typeof DeadLetterReason>

/**
 * Permanently routes one poison broker delivery away from normal redelivery.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeadLetterRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  _tag: Schema.Literal("DeadLetter"),
  requestId: Schema.NonEmptyString,
  delivery: BrokerDelivery,
  reason: DeadLetterReason,
  failure: FailureSummary
}).annotate({
  identifier: "WorkflowDeadLetterActivityDeliveryRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DeadLetterRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeadLetterRequest = Schema.Schema.Type<typeof DeadLetterRequest>

/**
 * A strict request passed to one broker settlement operation.
 *
 * @category models
 * @since 4.0.0
 */
export type SettlementRequest =
  | AcknowledgeRequest
  | RetryRequest
  | DeadLetterRequest

/**
 * Raised when a worker or broker-settlement boundary violates its protocol.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityBrokerWorkerError extends Schema.TaggedErrorClass<ActivityBrokerWorkerError>(
  "@effect/workflow-builder/ActivityBrokerWorker/ActivityBrokerWorkerError"
)("ActivityBrokerWorkerError", {
  phase: Schema.Literals(["request", "adapter", "receipt"]),
  message: Schema.NonEmptyString,
  action: Schema.optionalKey(Schema.Literals(["Acknowledge", "Retry", "DeadLetter"])),
  deliveryId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Effect service implemented by a concrete broker settlement adapter.
 *
 * **Details**
 *
 * Implementations must make `requestId` idempotent. Every request is a
 * recursively frozen strict-JSON snapshot, including the original delivery,
 * and adapter receipts must also be strict JSON.
 *
 * @category services
 * @since 4.0.0
 */
export class ActivityBrokerSettlement extends Context.Service<ActivityBrokerSettlement, {
  readonly acknowledge: (
    request: AcknowledgeRequest
  ) => Effect.Effect<Schema.Json, ActivityBrokerWorkerError>
  readonly retry: (
    request: RetryRequest
  ) => Effect.Effect<Schema.Json, ActivityBrokerWorkerError>
  readonly deadLetter: (
    request: DeadLetterRequest
  ) => Effect.Effect<Schema.Json, ActivityBrokerWorkerError>
}>()("@effect/workflow-builder/ActivityBrokerWorker/ActivityBrokerSettlement") {}

/**
 * A broker settlement request and its detached adapter receipt.
 *
 * @category models
 * @since 4.0.0
 */
export interface SettlementReceipt {
  readonly request: SettlementRequest
  readonly brokerReceipt: Schema.Json
}

/**
 * A delivery acknowledged after its result was durably committed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Completed<out Failure> {
  readonly _tag: "Completed"
  readonly completed: ActivityWorker.Completed<Failure>
  readonly settlement: SettlementReceipt
}

/**
 * A delivery acknowledged after authoritative storage suppression.
 *
 * @category models
 * @since 4.0.0
 */
export interface Suppressed {
  readonly _tag: "Suppressed"
  readonly reason: ActivityDeliveryStore.ActivityCompletionSuppressed["reason"]
  readonly settlement: SettlementReceipt
}

/**
 * A delivery left unacknowledged and scheduled for delayed redelivery.
 *
 * @category models
 * @since 4.0.0
 */
export interface Retried {
  readonly _tag: "Retried"
  readonly reason: RetryReason
  readonly failure: FailureSummary
  readonly settlement: SettlementReceipt
}

/**
 * A poison delivery permanently routed to a dead-letter destination.
 *
 * @category models
 * @since 4.0.0
 */
export interface DeadLettered {
  readonly _tag: "DeadLettered"
  readonly reason: DeadLetterReason
  readonly failure: FailureSummary
  readonly settlement: SettlementReceipt
}

/**
 * The disposition produced by one {@link process} call.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessResult<Failure> =
  | Completed<Failure>
  | Suppressed
  | Retried
  | DeadLettered

/**
 * Services required to process and settle one durable activity delivery.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ProcessRequirements<W extends Workflow.Any> =
  | ActivityWorker.RunRequirements<W>
  | ActivityBrokerSettlement

/**
 * Services required to process one cancellation-observable durable activity
 * delivery.
 *
 * @category utility types
 * @since 4.0.0
 */
export type CancellableProcessRequirements<W extends Workflow.Any> =
  | ActivityWorker.CancellableRunRequirements<W>
  | ActivityBrokerSettlement

const decodeProcessRequest = Schema.decodeUnknownResult(ProcessRequest, strictParseOptions)
const decodeAcknowledgeRequest = Schema.decodeUnknownResult(AcknowledgeRequest, strictParseOptions)
const decodeRetryRequest = Schema.decodeUnknownResult(RetryRequest, strictParseOptions)
const decodeDeadLetterRequest = Schema.decodeUnknownResult(DeadLetterRequest, strictParseOptions)

const boundaryError = (
  phase: "request" | "adapter" | "receipt",
  message: string,
  options: {
    readonly action?: SettlementRequest["_tag"] | undefined
    readonly deliveryId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): ActivityBrokerWorkerError =>
  new ActivityBrokerWorkerError({
    phase,
    message,
    ...(options.action === undefined ? undefined : { action: options.action }),
    ...(options.deliveryId === undefined ? undefined : { deliveryId: options.deliveryId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const capture = <A>(
  input: unknown,
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>,
  subject: string,
  options: {
    readonly action?: SettlementRequest["_tag"] | undefined
    readonly deliveryId?: string | undefined
  } = {}
): Result.Result<A, ActivityBrokerWorkerError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(boundaryError(
      "request",
      `${subject} must be strict JSON: ${snapped.failure.message}`,
      {
        ...options,
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      }
    ))
  }
  let decoded: Result.Result<A, { readonly message: string }>
  try {
    decoded = decode(snapped.success)
  } catch {
    return Result.fail(boundaryError(
      "request",
      `${subject} schema validation threw unexpectedly`,
      options
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(boundaryError("request", `Invalid ${subject.toLowerCase()}`, {
      ...options,
      details: { parseError: decoded.failure.message }
    }))
    : Result.succeed(snapped.success as unknown as A)
}

const failureSummary = (
  tag: string,
  message: string
): FailureSummary => Object.freeze({ tag, message })

const summarize = (error: unknown): FailureSummary => {
  if (error instanceof ActivityConsumer.InvalidActivityMessage) {
    return failureSummary(error._tag, error.message)
  }
  if (error instanceof ActivityDeliveryStore.ActivityLeaseBusy) {
    return failureSummary(error._tag, "Activity lease is currently owned by another worker")
  }
  if (error instanceof ActivityDeliveryStore.DispatchPinMismatch) {
    return failureSummary(error._tag, `Immutable activity dispatch pin '${error.field}' does not match`)
  }
  if (error instanceof ActivityDeliveryStore.StaleActivityLease) {
    return failureSummary(error._tag, `Activity lease is stale: ${error.reason}`)
  }
  if (error instanceof ActivityDeliveryStore.DispatchNotFound) {
    return failureSummary(error._tag, "Authoritative activity dispatch was not found")
  }
  if (error instanceof ActivityDeliveryStore.DeliveryRequestConflict) {
    return failureSummary(error._tag, "Stable delivery request identity was reused with different content")
  }
  if (error instanceof ActivityDeliveryStore.InvalidDeliveryRequest) {
    return failureSummary(error._tag, error.message)
  }
  if (error instanceof ActivityDeliveryStore.ActivityDeliveryStoreFailure) {
    return failureSummary(error._tag, error.message)
  }
  if (error instanceof ActivityDeliveryStore.ConflictingCompletion) {
    return failureSummary(error._tag, "A different durable completion already owns this request")
  }
  if (error instanceof ActivityWorker.ActivityWorkerError) {
    return failureSummary(error._tag, error.message)
  }
  if (error instanceof ActivityRuntime.ActivityRuntimeError) {
    return failureSummary(error._tag, error.message)
  }
  return failureSummary("UnexpectedWorkerFailure", "Activity processing failed unexpectedly")
}

const captureSettlementRequest = (
  request: SettlementRequest
): Result.Result<SettlementRequest, ActivityBrokerWorkerError> => {
  const decode = request._tag === "Acknowledge"
    ? decodeAcknowledgeRequest
    : request._tag === "Retry"
    ? decodeRetryRequest
    : decodeDeadLetterRequest
  return capture(
    request,
    decode as (
      input: unknown
    ) => Result.Result<SettlementRequest, { readonly message: string }>,
    `${request._tag} settlement request`,
    {
      action: request._tag,
      deliveryId: request.delivery.deliveryId
    }
  )
}

const settle = Effect.fnUntraced(function*(
  input: SettlementRequest
): Effect.fn.Return<
  SettlementReceipt,
  ActivityBrokerWorkerError,
  ActivityBrokerSettlement
> {
  const captured = captureSettlementRequest(input)
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const request = captured.success
  const adapter = yield* ActivityBrokerSettlement
  const adapterEffect = yield* Effect.try({
    try: (): unknown => {
      switch (request._tag) {
        case "Acknowledge":
          return adapter.acknowledge(request)
        case "Retry":
          return adapter.retry(request)
        case "DeadLetter":
          return adapter.deadLetter(request)
      }
    },
    catch: () =>
      boundaryError(
        "adapter",
        `Broker ${request._tag.toLowerCase()} adapter threw before returning an Effect`,
        {
          action: request._tag,
          deliveryId: request.delivery.deliveryId
        }
      )
  })
  const isEffect = yield* Effect.try({
    try: () => Effect.isEffect(adapterEffect),
    catch: () =>
      boundaryError(
        "adapter",
        `Broker ${request._tag.toLowerCase()} adapter result could not be inspected safely`,
        {
          action: request._tag,
          deliveryId: request.delivery.deliveryId
        }
      )
  })
  if (!isEffect) {
    return yield* Effect.fail(boundaryError(
      "adapter",
      `Broker ${request._tag.toLowerCase()} adapter did not return an Effect`,
      {
        action: request._tag,
        deliveryId: request.delivery.deliveryId
      }
    ))
  }
  const rawReceipt = yield* (adapterEffect as Effect.Effect<
    Schema.Json,
    ActivityBrokerWorkerError
  >).pipe(
    Effect.catch((error) =>
      error instanceof ActivityBrokerWorkerError
        ? Effect.fail(error)
        : Effect.fail(boundaryError(
          "adapter",
          `Broker ${request._tag.toLowerCase()} adapter failed with an invalid typed error`,
          {
            action: request._tag,
            deliveryId: request.delivery.deliveryId
          }
        ))
    ),
    Effect.catchCauseIf(
      (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      () =>
        Effect.fail(boundaryError(
          "adapter",
          `Broker ${request._tag.toLowerCase()} adapter failed with an unexpected defect`,
          {
            action: request._tag,
            deliveryId: request.delivery.deliveryId
          }
        ))
    )
  )
  const snappedReceipt = Json.snapshot(rawReceipt)
  if (Result.isFailure(snappedReceipt)) {
    return yield* Effect.fail(boundaryError(
      "receipt",
      `Broker settlement receipt must be strict JSON: ${snappedReceipt.failure.message}`,
      {
        action: request._tag,
        deliveryId: request.delivery.deliveryId,
        details: {
          snapshotError: snappedReceipt.failure.message,
          path: [...snappedReceipt.failure.path]
        }
      }
    ))
  }
  return Object.freeze({
    request,
    brokerReceipt: snappedReceipt.success
  })
})

const acknowledgeCompleted = <Failure>(
  request: ProcessRequest,
  completed: ActivityWorker.Completed<Failure>
): Effect.Effect<Completed<Failure>, ActivityBrokerWorkerError, ActivityBrokerSettlement> =>
  settle({
    requestVersion: 1,
    _tag: "Acknowledge",
    requestId: request.settlementRequestId,
    delivery: request.delivery,
    reason: "Completed"
  }).pipe(
    Effect.map((settlement) =>
      Object.freeze({
        _tag: "Completed" as const,
        completed,
        settlement
      })
    )
  )

const acknowledgeSuppressed = (
  request: ProcessRequest,
  reason: ActivityDeliveryStore.ActivityCompletionSuppressed["reason"]
): Effect.Effect<Suppressed, ActivityBrokerWorkerError, ActivityBrokerSettlement> =>
  settle({
    requestVersion: 1,
    _tag: "Acknowledge",
    requestId: request.settlementRequestId,
    delivery: request.delivery,
    reason: "Suppressed",
    suppressionReason: reason
  }).pipe(
    Effect.map((settlement) =>
      Object.freeze({
        _tag: "Suppressed" as const,
        reason,
        settlement
      })
    )
  )

const retry = (
  request: ProcessRequest,
  reason: RetryReason,
  failure: FailureSummary
): Effect.Effect<Retried, ActivityBrokerWorkerError, ActivityBrokerSettlement> =>
  settle({
    requestVersion: 1,
    _tag: "Retry",
    requestId: request.settlementRequestId,
    delivery: request.delivery,
    reason,
    delayMillis: request.retryDelayMillis,
    failure
  }).pipe(
    Effect.map((settlement) =>
      Object.freeze({
        _tag: "Retried" as const,
        reason,
        failure,
        settlement
      })
    )
  )

const deadLetter = (
  request: ProcessRequest,
  reason: DeadLetterReason,
  failure: FailureSummary
): Effect.Effect<DeadLettered, ActivityBrokerWorkerError, ActivityBrokerSettlement> =>
  settle({
    requestVersion: 1,
    _tag: "DeadLetter",
    requestId: request.settlementRequestId,
    delivery: request.delivery,
    reason,
    failure
  }).pipe(
    Effect.map((settlement) =>
      Object.freeze({
        _tag: "DeadLettered" as const,
        reason,
        failure,
        settlement
      })
    )
  )

const settleAcquireFailure = (
  request: ProcessRequest,
  error: ActivityConsumer.AcquireError
): Effect.Effect<
  Suppressed | Retried | DeadLettered,
  ActivityBrokerWorkerError,
  ActivityBrokerSettlement
> => {
  if (error instanceof ActivityConsumer.InvalidActivityMessage) {
    return deadLetter(request, "Malformed", summarize(error))
  }
  if (error instanceof ActivityDeliveryStore.DispatchPinMismatch) {
    return deadLetter(request, "PinMismatch", summarize(error))
  }
  if (error instanceof ActivityDeliveryStore.ActivityCompletionSuppressed) {
    return acknowledgeSuppressed(request, error.reason)
  }
  if (error instanceof ActivityDeliveryStore.ActivityLeaseBusy) {
    return retry(request, "Busy", summarize(error))
  }
  if (error instanceof ActivityDeliveryStore.DeliveryRequestConflict) {
    return deadLetter(request, "RequestConflict", summarize(error))
  }
  return retry(request, "Transient", summarize(error))
}

type RunFailure =
  | ActivityWorker.ActivityWorkerError
  | ActivityRuntime.ActivityRuntimeError
  | ActivityDeliveryStore.DeliveryStoreError
  | ActivityDeliveryStore.StaleActivityLease
  | ActivityDeliveryStore.ActivityCompletionSuppressed
  | ActivityDeliveryStore.ConflictingCompletion
  | ActivityCancellationWorker.InvalidActivityExecutionRef
  | ActivityCancellationWorker.ActivityExecutionAlreadyRegistered

const settleRunFailure = (
  request: ProcessRequest,
  error: RunFailure
): Effect.Effect<
  Suppressed | Retried | DeadLettered,
  ActivityBrokerWorkerError,
  ActivityBrokerSettlement
> => {
  if (error instanceof ActivityDeliveryStore.ActivityCompletionSuppressed) {
    return acknowledgeSuppressed(request, error.reason)
  }
  if (error instanceof ActivityDeliveryStore.StaleActivityLease) {
    return retry(request, "StaleLease", summarize(error))
  }
  if (error instanceof ActivityCancellationWorker.InvalidActivityExecutionRef) {
    return deadLetter(request, "Malformed", summarize(error))
  }
  if (
    error instanceof ActivityCancellationWorker.ActivityExecutionAlreadyRegistered
  ) {
    return retry(request, "Busy", summarize(error))
  }
  if (error instanceof ActivityWorker.ActivityWorkerError) {
    if (error.phase === "handler") {
      return retry(request, "WorkerUnavailable", summarize(error))
    }
    return deadLetter(
      request,
      error.phase === "lease" ? "Malformed" : "PinMismatch",
      summarize(error)
    )
  }
  if (
    error instanceof ActivityDeliveryStore.ConflictingCompletion ||
    error instanceof ActivityDeliveryStore.DeliveryRequestConflict
  ) {
    return deadLetter(request, "RequestConflict", summarize(error))
  }
  if (error instanceof ActivityRuntime.ActivityRuntimeError) {
    return retry(request, "WorkerFailure", summarize(error))
  }
  return retry(request, "Transient", summarize(error))
}

/**
 * Acquires, executes, durably completes, and settles one broker delivery.
 *
 * **Details**
 *
 * Acknowledgement occurs only after `ActivityWorker.run` returns a durable
 * completion receipt or the delivery store reports authoritative completion
 * suppression. Lease acquisition alone is never acknowledged. Busy ownership,
 * transient storage failures, stale fences, unavailable pinned workers, and
 * runtime failures request delayed redelivery; malformed messages and immutable
 * pin or request conflicts are dead-lettered.
 *
 * `ActivityMessage.messageId` is stable across broker redeliveries. For an
 * uncertain retry of this exact processing attempt, reuse `deliveryId` and all
 * three request IDs so acquisition, completion, and settlement remain
 * idempotent. A distinct broker-issued redelivery follows the broker's delivery
 * identity semantics and uses fresh acquisition, completion, and settlement
 * request IDs; durable handler idempotency remains derived from the semantic run
 * and activity identities.
 *
 * Defects and interruption from acquisition or worker execution are not
 * converted into a broker disposition. Broker adapter defects are normalized to
 * {@link ActivityBrokerWorkerError}, except interruption, which is preserved.
 *
 * @category running
 * @since 4.0.0
 */
export const process = Effect.fnUntraced(function*<W extends Workflow.Any>(
  recovered: DurableRecovery.RecoveredRun<W>,
  input: ProcessRequest
): Effect.fn.Return<
  ProcessResult<ActivityRuntime.Failure<W>>,
  ActivityBrokerWorkerError,
  ProcessRequirements<W>
> {
  const captured = capture(
    input,
    decodeProcessRequest,
    "Activity broker worker request"
  )
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const request = captured.success
  const acquired = yield* Effect.result(ActivityConsumer.acquire({
    requestVersion: 1,
    message: request.delivery.message as ActivityMessage,
    workerId: request.workerId,
    workerDeploymentId: request.workerDeploymentId,
    requestId: request.acquireRequestId,
    leaseDurationMillis: request.leaseDurationMillis
  }))
  if (Result.isFailure(acquired)) {
    return yield* settleAcquireFailure(request, acquired.failure)
  }
  const completed = yield* Effect.result(ActivityWorker.run(
    recovered,
    acquired.success,
    request.completionRequestId
  ))
  if (Result.isFailure(completed)) {
    return yield* settleRunFailure(request, completed.failure)
  }
  return yield* acknowledgeCompleted(request, completed.success)
})

/**
 * Acquires, cancellation-registers, executes, completes, and settles one
 * broker delivery.
 *
 * **Details**
 *
 * This is the cancellation-observable counterpart to {@link process}. It
 * registers the exact activity lease generation before invoking user code, so
 * a durable cancellation worker can interrupt the correct Effect fiber and
 * wait for its finalizers. Broker settlement retains the same durable
 * completion and suppression rules.
 *
 * @category running
 * @since 4.0.0
 */
export const processCancellable = Effect.fnUntraced(function*<
  W extends Workflow.Any
>(
  recovered: DurableRecovery.RecoveredRun<W>,
  input: ProcessRequest
): Effect.fn.Return<
  ProcessResult<ActivityRuntime.Failure<W>>,
  ActivityBrokerWorkerError,
  CancellableProcessRequirements<W>
> {
  const captured = capture(
    input,
    decodeProcessRequest,
    "Activity broker worker request"
  )
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const request = captured.success
  const acquired = yield* Effect.result(ActivityConsumer.acquire({
    requestVersion: 1,
    message: request.delivery.message as ActivityMessage,
    workerId: request.workerId,
    workerDeploymentId: request.workerDeploymentId,
    requestId: request.acquireRequestId,
    leaseDurationMillis: request.leaseDurationMillis
  }))
  if (Result.isFailure(acquired)) {
    return yield* settleAcquireFailure(request, acquired.failure)
  }
  const completed = yield* Effect.result(ActivityWorker.runCancellable(
    recovered,
    acquired.success,
    request.completionRequestId
  ))
  if (Result.isFailure(completed)) {
    return yield* settleRunFailure(request, completed.failure)
  }
  return yield* acknowledgeCompleted(request, completed.success)
})
