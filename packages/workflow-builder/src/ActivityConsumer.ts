/**
 * Strict broker-message ingress for acquiring authoritative activity work.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityDeliveryStore from "./ActivityDeliveryStore.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"
import * as OutboxRelay from "./OutboxRelay.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * One broker delivery admitted by a concrete worker build.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcquireRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  message: OutboxRelay.ActivityMessage,
  workerId: Schema.NonEmptyString,
  workerDeploymentId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  leaseDurationMillis: PositiveSafeInt
}).annotate({
  identifier: "WorkflowAcquireBrokerActivityRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcquireRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcquireRequest = Schema.Schema.Type<typeof AcquireRequest>

/**
 * Raised when a broker delivery is malformed or internally inconsistent.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidActivityMessage extends Schema.TaggedErrorClass<InvalidActivityMessage>(
  "@effect/workflow-builder/ActivityConsumer/InvalidActivityMessage"
)("InvalidActivityMessage", {
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Failures produced while acquiring one broker-delivered activity.
 *
 * @category errors
 * @since 4.0.0
 */
export type AcquireError =
  | InvalidActivityMessage
  | ActivityDeliveryStore.DeliveryStoreError
  | ActivityDeliveryStore.ActivityLeaseBusy
  | ActivityDeliveryStore.DispatchPinMismatch
  | ActivityDeliveryStore.ActivityCompletionSuppressed

const decodeRequest = Schema.decodeUnknownResult(AcquireRequest, strictParseOptions)

const invalid = (
  message: string,
  details?: Schema.Json
): InvalidActivityMessage =>
  new InvalidActivityMessage({
    message,
    ...(details === undefined ? undefined : { details })
  })

const capture = (
  input: unknown
): Result.Result<AcquireRequest, InvalidActivityMessage> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(invalid(
      `Activity consumer request must be strict JSON: ${snapped.failure.message}`,
      {
        snapshotError: snapped.failure.message,
        path: [...snapped.failure.path]
      }
    ))
  }
  let decoded: ReturnType<typeof decodeRequest>
  try {
    decoded = decodeRequest(snapped.success)
  } catch {
    return Result.fail(invalid("Activity consumer request schema validation threw unexpectedly"))
  }
  return Result.isFailure(decoded)
    ? Result.fail(invalid("Invalid activity consumer request", {
      parseError: decoded.failure.message
    }))
    : Result.succeed(snapped.success as unknown as AcquireRequest)
}

/**
 * Reloads and acquires authoritative work for one stable broker pointer.
 *
 * **Details**
 *
 * Message identity, tenant, digest, queue, and immutable worker-deployment pin
 * are all checked before a lease is returned. The broker payload never becomes
 * the activity authority; the transactional store supplies the exact dispatch.
 * A repeated broker delivery should use a new `requestId`, while an uncertain
 * retry of the same acquisition uses the original one.
 *
 * @category running
 * @since 4.0.0
 */
export const acquire = Effect.fnUntraced(function*(
  input: AcquireRequest
): Effect.fn.Return<
  ActivityDeliveryStore.ActivityLease,
  AcquireError,
  ActivityDeliveryStore.ActivityDeliveryStore
> {
  const captured = capture(input)
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const request = captured.success
  const expectedMessageId = Identity.activityBrokerMessageId(
    request.message.pointer.key.tenantId,
    request.message.pointer.key.intentId
  )
  if (request.message.messageId !== expectedMessageId) {
    return yield* Effect.fail(invalid(
      "Activity messageId must equal its immutable dispatch intentId",
      {
        messageId: request.message.messageId,
        expectedMessageId
      }
    ))
  }
  const store = yield* ActivityDeliveryStore.ActivityDeliveryStore
  const lease = yield* store.acquireAttempt({
    requestVersion: 1,
    key: request.message.pointer.key,
    dispatchDigest: request.message.pointer.dispatchDigest,
    workerId: request.workerId,
    workerQueue: request.message.queue,
    workerDeploymentId: request.workerDeploymentId,
    requestId: request.requestId,
    leaseDurationMillis: request.leaseDurationMillis
  })
  if (
    lease.pointer.dispatchDigest !== request.message.pointer.dispatchDigest ||
    lease.dispatch.tenantId !== request.message.pointer.key.tenantId ||
    lease.dispatch.intentId !== request.message.pointer.key.intentId ||
    lease.dispatch.target.queue !== request.message.queue ||
    lease.dispatch.target.deploymentId !== request.workerDeploymentId
  ) {
    return yield* Effect.fail(invalid(
      "Activity store returned work inconsistent with the admitted broker message"
    ))
  }
  return lease
})
