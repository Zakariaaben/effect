import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Cancellation from "../src/ActivityCancellationDelivery.ts"
import * as CancellationWorker from "../src/ActivityCancellationWorker.ts"
import type * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"

const at = "2026-07-23T10:00:00.000Z" as const
const later = "2026-07-23T10:01:00.000Z" as const

const leaseRef = (
  overrides: Partial<ActivityDeliveryStore.ActivityLeaseRef> = {}
): ActivityDeliveryStore.ActivityLeaseRef => ({
  leaseVersion: 1,
  key: {
    tenantId: "tenant-a",
    intentId: "intent-a"
  },
  workerId: "worker-session-a",
  workerDeploymentId: "deployment-a",
  deliveryEpoch: 3,
  leaseId: "activity-lease-a",
  ...overrides
})

const cancellationClaim = (): Cancellation.CancellationClaim => {
  const activityLeaseRef = leaseRef()
  const coordinates: Cancellation.CancellationIdentityCoordinates = {
    activityLeaseRef,
    attemptId: "attempt-a",
    attempt: 2,
    logicalActivityId: "logical-a",
    cancellationRequestId: "cancel-request-a",
    sourceEventId: "cancel-event-a",
    reason: "RunCancellationRequested"
  }
  const issued: Cancellation.IssuedExecutionRef = {
    issuedVersion: 1,
    ...coordinates,
    cancellationId: Cancellation.makeCancellationId(coordinates),
    enqueuedAt: at
  }
  const ref: Cancellation.CancellationClaimRef = {
    claimRefVersion: 1,
    activityLeaseRef,
    attemptId: issued.attemptId,
    attempt: issued.attempt,
    logicalActivityId: issued.logicalActivityId,
    cancellationId: issued.cancellationId,
    workerIncarnationId: "worker-incarnation-a",
    claimantId: "cancellation-worker-a",
    claimEpoch: 1,
    claimLeaseId: "cancellation-lease-a"
  }
  return {
    claimVersion: 1,
    ref,
    issued,
    claimRequestId: "claim-request-a",
    leasedAt: at,
    expiresAt: later
  }
}

const mockStore = (
  acknowledged: Ref.Ref<ReadonlyArray<Cancellation.AcknowledgeCancellationRequest>>,
  released: Ref.Ref<ReadonlyArray<Cancellation.ReleaseCancellationClaimRequest>>
): Cancellation.ActivityCancellationDeliveryStore.Service =>
  Cancellation.ActivityCancellationDeliveryStore.of(Object.freeze({
    claimCancellations: () => Effect.die("unused claim operation"),
    acknowledgeCancellation: (request) =>
      Ref.update(acknowledged, (current) => [...current, request]).pipe(
        Effect.as(Object.freeze({
          receiptVersion: 1 as const,
          requestId: request.requestId,
          ref: request.ref,
          disposition: request.disposition,
          acknowledgedAt: later
        }))
      ),
    releaseCancellationClaim: (request) =>
      Ref.update(released, (current) => [...current, request]).pipe(
        Effect.as(Object.freeze({
          receiptVersion: 1 as const,
          requestId: request.requestId,
          ref: request.ref,
          releasedAt: later
        }))
      )
  }))

const process = (
  registry: CancellationWorker.ActivityExecutionRegistry.Service,
  store: Cancellation.ActivityCancellationDeliveryStore.Service,
  claim: Cancellation.CancellationClaim
) =>
  CancellationWorker.processCancellation({
    requestVersion: 1,
    claim,
    acknowledgeRequestId: "ack-request-a",
    releaseRequestId: "release-request-a"
  }).pipe(
    Effect.provideService(
      CancellationWorker.ActivityExecutionRegistry,
      registry
    ),
    Effect.provideService(
      Cancellation.ActivityCancellationDeliveryStore,
      store
    )
  )

describe("ActivityCancellationWorker", () => {
  it.effect("interrupts the exact running fiber and waits for finalizers before acknowledgement", () =>
    Effect.gen(function*() {
      const registry = yield* CancellationWorker.makeMemory
      const acknowledged = yield* Ref.make<
        ReadonlyArray<Cancellation.AcknowledgeCancellationRequest>
      >([])
      const released = yield* Ref.make<
        ReadonlyArray<Cancellation.ReleaseCancellationClaimRequest>
      >([])
      const store = mockStore(acknowledged, released)
      const started = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const claim = cancellationClaim()
      const running = yield* registry.run(
        claim.issued.activityLeaseRef,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(finalized, undefined))
        )
      ).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      const result = yield* process(registry, store, claim)

      assert.strictEqual(result._tag, "Acknowledged")
      if (result._tag === "Acknowledged") {
        assert.strictEqual(result.observation, "Interrupted")
        assert.strictEqual(result.receipt.disposition, "Interrupted")
      }
      assert.isTrue(yield* Deferred.isDone(finalized))
      assert.strictEqual(
        yield* registry.status(claim.issued.activityLeaseRef),
        "Absent"
      )
      assert.strictEqual((yield* Ref.get(acknowledged)).length, 1)
      assert.strictEqual((yield* Ref.get(released)).length, 0)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(running)))
    }))

  it.effect("retains a tombstone when cancellation wins the register race", () =>
    Effect.gen(function*() {
      const registry = yield* CancellationWorker.makeMemory
      const acknowledged = yield* Ref.make<
        ReadonlyArray<Cancellation.AcknowledgeCancellationRequest>
      >([])
      const released = yield* Ref.make<
        ReadonlyArray<Cancellation.ReleaseCancellationClaimRequest>
      >([])
      const store = mockStore(acknowledged, released)
      const claim = cancellationClaim()

      const result = yield* process(registry, store, claim)
      assert.strictEqual(result._tag, "Released")
      assert.strictEqual(
        yield* registry.status(claim.issued.activityLeaseRef),
        "PendingRegistration"
      )
      assert.strictEqual((yield* Ref.get(acknowledged)).length, 0)
      assert.strictEqual((yield* Ref.get(released)).length, 1)

      const invoked = yield* Ref.make(false)
      const execution = yield* registry.run(
        claim.issued.activityLeaseRef,
        Ref.set(invoked, true)
      ).pipe(Effect.forkChild)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(execution)))
      assert.isFalse(yield* Ref.get(invoked))
      assert.strictEqual(
        yield* registry.status(claim.issued.activityLeaseRef),
        "Finished"
      )
    }))

  it.effect("rejects duplicate execution registration for one exact generation", () =>
    Effect.gen(function*() {
      const registry = yield* CancellationWorker.makeMemory
      const started = yield* Deferred.make<void>()
      const ref = leaseRef()
      const first = yield* registry.run(
        ref,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never)
        )
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const duplicate = yield* Effect.result(registry.run(
        ref,
        Effect.succeed("should-not-run")
      ))
      assert.isTrue(Result.isFailure(duplicate))
      if (Result.isSuccess(duplicate)) {
        throw new Error("expected duplicate registration failure")
      }
      assert.instanceOf(
        duplicate.failure,
        CancellationWorker.ActivityExecutionAlreadyRegistered
      )

      assert.strictEqual(
        yield* registry.requestCancellation(ref),
        "Interrupted"
      )
      yield* Fiber.await(first)
    }))

  it.effect("keeps every lease-generation coordinate in the registry key", () =>
    Effect.gen(function*() {
      const base = leaseRef()
      const baseKey = CancellationWorker.activityLeaseGenerationKey(base)
      const variants = [
        leaseRef({ key: { tenantId: "tenant-b", intentId: "intent-a" } }),
        leaseRef({ key: { tenantId: "tenant-a", intentId: "intent-b" } }),
        leaseRef({ workerId: "worker-session-b" }),
        leaseRef({ workerDeploymentId: "deployment-b" }),
        leaseRef({ deliveryEpoch: 4 }),
        leaseRef({ leaseId: "activity-lease-b" })
      ]
      const keys = variants.map(
        CancellationWorker.activityLeaseGenerationKey
      )

      assert.strictEqual(new Set([baseKey, ...keys]).size, keys.length + 1)
    }))

  it.effect("rejects hostile execution references without invoking accessors", () =>
    Effect.gen(function*() {
      const registry = yield* CancellationWorker.makeMemory
      let accessed = 0
      const hostile = { ...leaseRef() } as Record<string, unknown>
      Object.defineProperty(hostile, "workerId", {
        enumerable: true,
        get() {
          accessed++
          return "unsafe"
        }
      })

      const result = yield* Effect.result(
        registry.requestCancellation(
          hostile as ActivityDeliveryStore.ActivityLeaseRef
        )
      )

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(accessed, 0)
      if (Result.isSuccess(result)) {
        throw new Error("expected hostile reference rejection")
      }
      assert.instanceOf(
        result.failure,
        CancellationWorker.InvalidActivityExecutionRef
      )
    }))
})
