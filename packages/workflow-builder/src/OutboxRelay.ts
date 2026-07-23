/**
 * At-least-once activity-outbox publication using stable pointer messages.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityDeliveryStore from "./ActivityDeliveryStore.ts"
import * as Dispatch from "./Dispatch.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Maximum parallel broker publications performed by one relay call.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxPublishConcurrency = 64

const PublishConcurrency = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MaxPublishConcurrency)
)

/**
 * Stable broker envelope for one authoritative stored activity dispatch.
 *
 * **Details**
 *
 * The full activity payload is deliberately absent. Workers reload it from the
 * transactional store using `pointer` and verify its digest before acquiring a
 * delivery generation. `messageId` remains stable across relay redelivery so a
 * broker may additionally deduplicate it when supported.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityMessage = Schema.Struct({
  messageVersion: Schema.Literal(1),
  messageId: Schema.NonEmptyString,
  queue: Schema.NonEmptyString,
  pointer: Dispatch.DispatchPointer
}).annotate({
  identifier: "WorkflowActivityBrokerMessage",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityMessage}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityMessage = Schema.Schema.Type<typeof ActivityMessage>

/**
 * One bounded relay poll and its publication concurrency.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RelayBatchRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  claim: ActivityDeliveryStore.ClaimOutboxRequest,
  publishConcurrency: PublishConcurrency
}).annotate({
  identifier: "WorkflowRelayBatchRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RelayBatchRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type RelayBatchRequest = Schema.Schema.Type<typeof RelayBatchRequest>

/**
 * Normalized broker-adapter publication failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityPublishError extends Schema.TaggedErrorClass<ActivityPublishError>(
  "@effect/workflow-builder/OutboxRelay/ActivityPublishError"
)("ActivityPublishError", {
  queue: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  cause: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when relay, store, or publisher output violates the strict protocol.
 *
 * @category errors
 * @since 4.0.0
 */
export class RelayProtocolError extends Schema.TaggedErrorClass<RelayProtocolError>(
  "@effect/workflow-builder/OutboxRelay/RelayProtocolError"
)("RelayProtocolError", {
  phase: Schema.Literals(["request", "claim", "publisher", "receipt"]),
  message: Schema.NonEmptyString,
  queue: Schema.optionalKey(Schema.NonEmptyString),
  messageId: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Effect service implemented by a concrete broker adapter.
 *
 * @category services
 * @since 4.0.0
 */
export class ActivityPublisher extends Context.Service<ActivityPublisher, {
  readonly publish: (
    message: ActivityMessage
  ) => Effect.Effect<Schema.Json, ActivityPublishError>
}>()("@effect/workflow-builder/OutboxRelay/ActivityPublisher") {}

/**
 * One successfully published and acknowledged activity pointer.
 *
 * @category models
 * @since 4.0.0
 */
export interface RelayedActivity {
  readonly message: ActivityMessage
  readonly receipt: ActivityDeliveryStore.PublishReceipt
}

/**
 * Failures isolated to one claim in a relay batch.
 *
 * @category errors
 * @since 4.0.0
 */
export type RelayItemError =
  | ActivityPublishError
  | RelayProtocolError
  | ActivityDeliveryStore.DeliveryStoreError
  | ActivityDeliveryStore.StaleRelayLease

/**
 * Result of one bounded relay poll.
 *
 * **Details**
 *
 * Item failures are retained independently so one poison or unavailable route
 * cannot prevent unrelated claims in the same bounded batch from publishing.
 *
 * @category models
 * @since 4.0.0
 */
export interface RelayBatchReceipt {
  readonly claim: ActivityDeliveryStore.ClaimOutboxReceipt
  readonly results: ReadonlyArray<Result.Result<RelayedActivity, RelayItemError>>
}

const decodeRequest = Schema.decodeUnknownResult(RelayBatchRequest, strictParseOptions)
const decodeClaim = Schema.decodeUnknownResult(
  ActivityDeliveryStore.ClaimOutboxReceipt,
  strictParseOptions
)

const protocolError = (
  phase: "request" | "claim" | "publisher" | "receipt",
  message: string,
  options: {
    readonly queue?: string | undefined
    readonly messageId?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): RelayProtocolError =>
  new RelayProtocolError({
    phase,
    message,
    ...(options.queue === undefined ? undefined : { queue: options.queue }),
    ...(options.messageId === undefined ? undefined : { messageId: options.messageId }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const capture = <A>(
  input: unknown,
  decode: (input: unknown) => Result.Result<A, { readonly message: string }>,
  phase: "request" | "claim",
  subject: string
): Result.Result<A, RelayProtocolError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(protocolError(
      phase,
      `${subject} must be strict JSON: ${snapped.failure.message}`,
      {
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
    return Result.fail(protocolError(phase, `${subject} schema validation threw unexpectedly`))
  }
  return Result.isFailure(decoded)
    ? Result.fail(protocolError(phase, `Invalid ${subject.toLowerCase()}`, {
      details: { parseError: decoded.failure.message }
    }))
    : Result.succeed(snapped.success as unknown as A)
}

const publishClaim = Effect.fnUntraced(function*(
  claim: ActivityDeliveryStore.RelayClaim
): Effect.fn.Return<
  RelayedActivity,
  RelayItemError,
  ActivityPublisher | ActivityDeliveryStore.ActivityDeliveryStore
> {
  if (
    claim.ref.key.tenantId !== claim.pointer.key.tenantId ||
    claim.ref.key.intentId !== claim.pointer.key.intentId ||
    claim.dispatch.tenantId !== claim.pointer.key.tenantId ||
    claim.dispatch.intentId !== claim.pointer.key.intentId
  ) {
    return yield* Effect.fail(protocolError(
      "claim",
      "Relay claim contains inconsistent tenant or dispatch identities"
    ))
  }
  const message: ActivityMessage = Object.freeze({
    messageVersion: 1,
    messageId: Identity.activityBrokerMessageId(
      claim.pointer.key.tenantId,
      claim.pointer.key.intentId
    ),
    queue: claim.dispatch.target.queue,
    pointer: claim.pointer
  })
  const publisher = yield* ActivityPublisher
  const publishEffect = yield* Effect.try({
    try: () => publisher.publish(message),
    catch: () =>
      protocolError(
        "publisher",
        "Activity publisher threw before returning an Effect",
        { queue: message.queue, messageId: message.messageId }
      )
  })
  const isEffect = yield* Effect.try({
    try: () => Effect.isEffect(publishEffect),
    catch: () =>
      protocolError(
        "publisher",
        "Activity publisher result could not be inspected safely",
        { queue: message.queue, messageId: message.messageId }
      )
  })
  if (!isEffect) {
    return yield* Effect.fail(protocolError(
      "publisher",
      "Activity publisher did not return an Effect",
      { queue: message.queue, messageId: message.messageId }
    ))
  }
  const brokerReceipt = yield* publishEffect.pipe(
    Effect.catchCauseIf(
      Cause.hasDies,
      () =>
        Effect.fail(protocolError(
          "publisher",
          "Activity publisher failed with an unexpected defect",
          { queue: message.queue, messageId: message.messageId }
        ))
    )
  )
  const snappedReceipt = Json.snapshot(brokerReceipt)
  if (Result.isFailure(snappedReceipt)) {
    return yield* Effect.fail(protocolError(
      "receipt",
      `Broker receipt must be strict JSON: ${snappedReceipt.failure.message}`,
      {
        queue: message.queue,
        messageId: message.messageId,
        details: {
          snapshotError: snappedReceipt.failure.message,
          path: [...snappedReceipt.failure.path]
        }
      }
    ))
  }
  const deliveryStore = yield* ActivityDeliveryStore.ActivityDeliveryStore
  const receipt = yield* deliveryStore.acknowledgePublished({
    requestVersion: 1,
    ref: claim.ref,
    brokerReceipt: snappedReceipt.success
  })
  return Object.freeze({ message, receipt })
})

/**
 * Claims and independently publishes one bounded activity-outbox batch.
 *
 * **Details**
 *
 * Publication precedes the transactional acknowledgement. A process failure
 * between those operations republishes the same stable message on a later
 * relay generation, providing at-least-once delivery. Failed and unprocessed
 * broker acknowledgements are not automatically released; lease expiry is the
 * retry delay and avoids an immediate poison-message hot loop.
 *
 * @category running
 * @since 4.0.0
 */
export const relayBatch = Effect.fnUntraced(function*(
  input: RelayBatchRequest
): Effect.fn.Return<
  RelayBatchReceipt,
  RelayProtocolError | ActivityDeliveryStore.DeliveryStoreError,
  ActivityPublisher | ActivityDeliveryStore.ActivityDeliveryStore
> {
  const capturedRequest = capture(input, decodeRequest, "request", "Relay batch request")
  if (Result.isFailure(capturedRequest)) {
    return yield* Effect.fail(capturedRequest.failure)
  }
  const request = capturedRequest.success
  const deliveryStore = yield* ActivityDeliveryStore.ActivityDeliveryStore
  const rawClaim = yield* deliveryStore.claimOutbox(request.claim)
  const capturedClaim = capture(rawClaim, decodeClaim, "claim", "Relay claim receipt")
  if (Result.isFailure(capturedClaim)) {
    return yield* Effect.fail(capturedClaim.failure)
  }
  const claim = capturedClaim.success
  const results = yield* Effect.forEach(
    claim.claims,
    (item) => Effect.result(publishClaim(item)),
    { concurrency: request.publishConcurrency }
  )
  return Object.freeze({
    claim,
    results: Object.freeze(results)
  })
})
