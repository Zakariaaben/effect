/**
 * Process-local activity execution registration and cancellation delivery.
 *
 * **Details**
 *
 * Durable cancellation records identify an exact activity lease generation.
 * This module maps that identity to the Effect fiber currently executing it,
 * preserves cancellation tombstones across acquire/register races, and
 * acknowledges delivery only after interruption and finalizers complete.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityCancellationDelivery from "./ActivityCancellationDelivery.ts"
import * as ActivityDeliveryStore from "./ActivityDeliveryStore.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const decodeLeaseRef = Schema.decodeUnknownResult(
  ActivityDeliveryStore.ActivityLeaseRef,
  strictParseOptions
)

/**
 * Returns the collision-safe process-local key for one activity execution
 * generation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const activityLeaseGenerationKey = (
  ref: ActivityDeliveryStore.ActivityLeaseRef
): string =>
  JSON.stringify([
    "@effect/workflow-builder",
    1,
    "ActivityLeaseGeneration",
    ref.leaseVersion,
    ref.key.tenantId,
    ref.key.intentId,
    ref.workerId,
    ref.workerDeploymentId,
    ref.deliveryEpoch,
    ref.leaseId
  ])

/**
 * Observable process-local registry states.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RegistryStatus = Schema.Literals([
  "Absent",
  "PendingRegistration",
  "Running",
  "Finished"
])

/**
 * The decoded type of {@link RegistryStatus}.
 *
 * @category models
 * @since 4.0.0
 */
export type RegistryStatus = Schema.Schema.Type<typeof RegistryStatus>

/**
 * Result of requesting cancellation from the process-local registry.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationObservation = Schema.Literals([
  "PendingRegistration",
  "Interrupted",
  "AlreadyFinished"
])

/**
 * The decoded type of {@link CancellationObservation}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationObservation = Schema.Schema.Type<
  typeof CancellationObservation
>

/**
 * Raised when an execution reference is not detached strict JSON or violates
 * the activity-lease schema.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidActivityExecutionRef extends Schema.TaggedErrorClass<
  InvalidActivityExecutionRef
>("@effect/workflow-builder/ActivityCancellationWorker/InvalidExecutionRef")(
  "InvalidActivityExecutionRef",
  {
    message: Schema.NonEmptyString,
    details: Schema.optionalKey(Schema.Json)
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when the same execution generation is registered more than once.
 *
 * @category errors
 * @since 4.0.0
 */
export class ActivityExecutionAlreadyRegistered extends Schema.TaggedErrorClass<
  ActivityExecutionAlreadyRegistered
>(
  "@effect/workflow-builder/ActivityCancellationWorker/ExecutionAlreadyRegistered"
)(
  "ActivityExecutionAlreadyRegistered",
  {
    key: Schema.NonEmptyString,
    status: Schema.Literals(["Running", "Finished"])
  },
  { parseOptions: strictParseOptions }
) {}

const captureLeaseRef = (
  input: unknown
): Result.Result<
  ActivityDeliveryStore.ActivityLeaseRef,
  InvalidActivityExecutionRef
> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(
      new InvalidActivityExecutionRef({
        message: "Activity execution reference must be detached strict JSON",
        details: {
          issue: snapshot.failure.message,
          path: snapshot.failure.path
        }
      })
    )
  }
  let decoded: ReturnType<typeof decodeLeaseRef>
  try {
    decoded = decodeLeaseRef(snapshot.success)
  } catch {
    return Result.fail(
      new InvalidActivityExecutionRef({
        message: "Activity execution reference validation failed safely"
      })
    )
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InvalidActivityExecutionRef({
        message: "Invalid activity execution reference",
        details: { parseError: decoded.failure.message }
      })
    )
  }
  return Result.succeed(
    snapshot.success as unknown as ActivityDeliveryStore.ActivityLeaseRef
  )
}

interface PendingRegistration {
  readonly _tag: "PendingRegistration"
  readonly ref: ActivityDeliveryStore.ActivityLeaseRef
}

interface Running {
  readonly _tag: "Running"
  readonly ref: ActivityDeliveryStore.ActivityLeaseRef
  readonly fiber: Fiber.Fiber<unknown, unknown>
}

interface Finished {
  readonly _tag: "Finished"
  readonly ref: ActivityDeliveryStore.ActivityLeaseRef
}

type RegistryEntry = PendingRegistration | Running | Finished

/**
 * Process-local authority mapping exact activity lease generations to fibers.
 *
 * **Details**
 *
 * A pending cancellation is retained when delivery wins the
 * acquire/register race. Later registration installs the exact fiber and
 * self-interrupts before invoking user code. Finished tombstones are retained
 * until durable acknowledgement succeeds.
 *
 * @category services
 * @since 4.0.0
 */
export class ActivityExecutionRegistry extends Context.Service<
  ActivityExecutionRegistry,
  ActivityExecutionRegistry.Service
>()("@effect/workflow-builder/ActivityExecutionRegistry") {}

/**
 * Service contracts for {@link ActivityExecutionRegistry}.
 *
 * @since 4.0.0
 */
export declare namespace ActivityExecutionRegistry {
  /**
   * Process-local activity execution registry shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly run: <A, E, R>(
      ref: ActivityDeliveryStore.ActivityLeaseRef,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<
      A,
      E | InvalidActivityExecutionRef | ActivityExecutionAlreadyRegistered,
      R
    >
    readonly requestCancellation: (
      ref: ActivityDeliveryStore.ActivityLeaseRef
    ) => Effect.Effect<CancellationObservation, InvalidActivityExecutionRef>
    readonly forgetCompleted: (
      ref: ActivityDeliveryStore.ActivityLeaseRef
    ) => Effect.Effect<boolean, InvalidActivityExecutionRef>
    readonly status: (
      ref: ActivityDeliveryStore.ActivityLeaseRef
    ) => Effect.Effect<RegistryStatus, InvalidActivityExecutionRef>
  }
}

/**
 * Constructs an isolated process-local activity execution registry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory: Effect.Effect<
  ActivityExecutionRegistry.Service
> = Effect.gen(function*() {
  const state = yield* Ref.make<HashMap.HashMap<string, RegistryEntry>>(
    HashMap.empty()
  )

  const run: ActivityExecutionRegistry.Service["run"] = <A, E, R>(
    inputRef: ActivityDeliveryStore.ActivityLeaseRef,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    E | InvalidActivityExecutionRef | ActivityExecutionAlreadyRegistered,
    R
  > => {
    const captured = captureLeaseRef(inputRef)
    if (Result.isFailure(captured)) {
      return Effect.fail(captured.failure)
    }
    const ref = captured.success
    const key = activityLeaseGenerationKey(ref)
    return Effect.withFiber((fiber) =>
      Effect.gen(function*() {
        const registration = yield* Ref.modify(
          state,
          (current): readonly [
            "Run" | "Interrupt" | ActivityExecutionAlreadyRegistered,
            HashMap.HashMap<string, RegistryEntry>
          ] => {
            const existing = HashMap.get(current, key)
            if (existing._tag === "Some") {
              if (existing.value._tag === "PendingRegistration") {
                return [
                  "Interrupt",
                  HashMap.set(current, key, { _tag: "Finished", ref })
                ]
              }
              return [
                new ActivityExecutionAlreadyRegistered({
                  key,
                  status: existing.value._tag
                }),
                current
              ]
            }
            return [
              "Run",
              HashMap.set(current, key, {
                _tag: "Running",
                ref,
                fiber
              })
            ]
          }
        )
        if (registration instanceof ActivityExecutionAlreadyRegistered) {
          return yield* Effect.fail(registration)
        }
        const finish = Ref.update(state, (current) => {
          const existing = HashMap.get(current, key)
          return existing._tag === "Some" &&
              existing.value._tag === "Running" &&
              existing.value.fiber === fiber
            ? HashMap.set(current, key, { _tag: "Finished", ref })
            : current
        })
        return yield* (
          registration === "Interrupt" ? Effect.interrupt : effect
        ).pipe(Effect.ensuring(finish))
      })
    )
  }

  const requestCancellation: ActivityExecutionRegistry.Service["requestCancellation"] = Effect.fnUntraced(
    function*(inputRef) {
      const captured = captureLeaseRef(inputRef)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const ref = captured.success
      const key = activityLeaseGenerationKey(ref)
      const decision = yield* Ref.modify(
        state,
        (current): readonly [
          "PendingRegistration" | "AlreadyFinished" | Fiber.Fiber<unknown, unknown>,
          HashMap.HashMap<string, RegistryEntry>
        ] => {
          const existing = HashMap.get(current, key)
          if (existing._tag === "None") {
            return [
              "PendingRegistration",
              HashMap.set(current, key, { _tag: "PendingRegistration", ref })
            ]
          }
          if (existing.value._tag === "PendingRegistration") {
            return ["PendingRegistration", current]
          }
          if (existing.value._tag === "Finished") {
            return ["AlreadyFinished", current]
          }
          return [existing.value.fiber, current]
        }
      )
      if (decision === "PendingRegistration" || decision === "AlreadyFinished") {
        return decision
      }
      const alreadyFinished = decision.pollUnsafe() !== undefined
      if (!alreadyFinished) {
        yield* Fiber.interrupt(decision)
      }
      yield* Ref.update(state, (current) => {
        const existing = HashMap.get(current, key)
        return existing._tag === "Some" &&
            existing.value._tag === "Running" &&
            existing.value.fiber === decision
          ? HashMap.set(current, key, { _tag: "Finished", ref })
          : current
      })
      return alreadyFinished ? "AlreadyFinished" as const : "Interrupted" as const
    }
  )

  const forgetCompleted: ActivityExecutionRegistry.Service["forgetCompleted"] = Effect.fnUntraced(function*(inputRef) {
    const captured = captureLeaseRef(inputRef)
    if (Result.isFailure(captured)) {
      return yield* Effect.fail(captured.failure)
    }
    const key = activityLeaseGenerationKey(captured.success)
    return yield* Ref.modify(
      state,
      (current): readonly [boolean, HashMap.HashMap<string, RegistryEntry>] => {
        const existing = HashMap.get(current, key)
        return existing._tag === "Some" && existing.value._tag === "Finished"
          ? [true, HashMap.remove(current, key)]
          : [false, current]
      }
    )
  })

  const status: ActivityExecutionRegistry.Service["status"] = Effect.fnUntraced(
    function*(inputRef) {
      const captured = captureLeaseRef(inputRef)
      if (Result.isFailure(captured)) {
        return yield* Effect.fail(captured.failure)
      }
      const entry = HashMap.get(
        yield* Ref.get(state),
        activityLeaseGenerationKey(captured.success)
      )
      return entry._tag === "None" ? "Absent" as const : entry.value._tag
    }
  )

  return ActivityExecutionRegistry.of(Object.freeze({
    run,
    requestCancellation,
    forgetCompleted,
    status
  }))
})

/**
 * Process-local layer for {@link ActivityExecutionRegistry}.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<ActivityExecutionRegistry> = Layer.effect(
  ActivityExecutionRegistry,
  makeMemory
)

/**
 * One claimed cancellation-delivery operation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProcessCancellationRequest = Schema.Struct({
  requestVersion: Schema.Literal(1),
  claim: ActivityCancellationDelivery.CancellationClaim,
  acknowledgeRequestId: Schema.NonEmptyString,
  releaseRequestId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowProcessActivityCancellationRequest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProcessCancellationRequest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessCancellationRequest = Schema.Schema.Type<
  typeof ProcessCancellationRequest
>

/**
 * A cancellation interrupted or observed a finished exact execution and was
 * durably acknowledged.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationAcknowledged = Schema.TaggedStruct("Acknowledged", {
  resultVersion: Schema.Literal(1),
  observation: Schema.Literals(["Interrupted", "AlreadyFinished"]),
  receipt: ActivityCancellationDelivery.AcknowledgeCancellationReceipt
}).annotate({
  identifier: "WorkflowActivityCancellationAcknowledgedResult",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationAcknowledged}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationAcknowledged = Schema.Schema.Type<
  typeof CancellationAcknowledged
>

/**
 * A cancellation won the acquire/register race and was released for retry
 * while its process-local tombstone remains installed.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationReleased = Schema.TaggedStruct("Released", {
  resultVersion: Schema.Literal(1),
  observation: Schema.Literal("PendingRegistration"),
  receipt: ActivityCancellationDelivery.ReleaseCancellationClaimReceipt
}).annotate({
  identifier: "WorkflowActivityCancellationReleasedResult",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationReleased}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationReleased = Schema.Schema.Type<
  typeof CancellationReleased
>

/**
 * Result of processing one cancellation claim.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProcessCancellationResult = Schema.Union([
  CancellationAcknowledged,
  CancellationReleased
]).annotate({
  identifier: "WorkflowProcessActivityCancellationResult"
})

/**
 * The decoded type of {@link ProcessCancellationResult}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessCancellationResult = Schema.Schema.Type<
  typeof ProcessCancellationResult
>

/**
 * Raised when a one-shot cancellation worker request is malformed.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidCancellationProcessRequest extends Schema.TaggedErrorClass<
  InvalidCancellationProcessRequest
>("@effect/workflow-builder/ActivityCancellationWorker/InvalidProcessRequest")(
  "InvalidCancellationProcessRequest",
  {
    message: Schema.NonEmptyString,
    details: Schema.optionalKey(Schema.Json)
  },
  { parseOptions: strictParseOptions }
) {}

const decodeProcessRequest = Schema.decodeUnknownResult(
  ProcessCancellationRequest,
  strictParseOptions
)

const captureProcessRequest = (
  input: unknown
): Result.Result<
  ProcessCancellationRequest,
  InvalidCancellationProcessRequest
> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(
      new InvalidCancellationProcessRequest({
        message: "Cancellation worker request must be detached strict JSON",
        details: {
          issue: snapshot.failure.message,
          path: snapshot.failure.path
        }
      })
    )
  }
  let decoded: ReturnType<typeof decodeProcessRequest>
  try {
    decoded = decodeProcessRequest(snapshot.success)
  } catch {
    return Result.fail(
      new InvalidCancellationProcessRequest({
        message: "Cancellation worker request validation failed safely"
      })
    )
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InvalidCancellationProcessRequest({
        message: "Invalid cancellation worker request",
        details: { parseError: decoded.failure.message }
      })
    )
  }
  return Result.succeed(snapshot.success as unknown as ProcessCancellationRequest)
}

/**
 * Interrupts or observes one exact activity execution and settles its durable
 * cancellation claim.
 *
 * **Details**
 *
 * Interruption waits for the registered fiber's finalizers before
 * acknowledgement. If delivery wins the acquire/register race, the claim is
 * released while the local tombstone remains, causing later registration to
 * self-interrupt. Store failures and Effect interruption are preserved so the
 * claim can be retried under its durable lease protocol.
 *
 * @category running
 * @since 4.0.0
 */
export const processCancellation = Effect.fnUntraced(function*(
  input: ProcessCancellationRequest
): Effect.fn.Return<
  ProcessCancellationResult,
  | InvalidCancellationProcessRequest
  | InvalidActivityExecutionRef
  | ActivityCancellationDelivery.CancellationDeliveryStoreError
  | ActivityCancellationDelivery.CancellationNotFound
  | ActivityCancellationDelivery.StaleCancellationClaim
  | ActivityCancellationDelivery.CancellationDispositionConflict,
  | ActivityExecutionRegistry
  | ActivityCancellationDelivery.ActivityCancellationDeliveryStore
> {
  const captured = captureProcessRequest(input)
  if (Result.isFailure(captured)) {
    return yield* Effect.fail(captured.failure)
  }
  const request = captured.success
  const registry = yield* ActivityExecutionRegistry
  const store = yield* ActivityCancellationDelivery.ActivityCancellationDeliveryStore
  const observation = yield* registry.requestCancellation(
    request.claim.issued.activityLeaseRef
  )
  if (observation === "PendingRegistration") {
    const receipt = yield* store.releaseCancellationClaim({
      requestVersion: 1,
      requestId: request.releaseRequestId,
      ref: request.claim.ref
    })
    return Object.freeze({
      _tag: "Released",
      resultVersion: 1,
      observation,
      receipt
    })
  }
  const receipt = yield* store.acknowledgeCancellation({
    requestVersion: 1,
    requestId: request.acknowledgeRequestId,
    ref: request.claim.ref,
    disposition: observation
  })
  yield* registry.forgetCompleted(request.claim.issued.activityLeaseRef)
  return Object.freeze({
    _tag: "Acknowledged",
    resultVersion: 1,
    observation,
    receipt
  })
})
