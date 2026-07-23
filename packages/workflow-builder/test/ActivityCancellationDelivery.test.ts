import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Cancellation from "../src/ActivityCancellationDelivery.ts"
import type * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const at = "2026-07-23T10:00:00.000Z" as const
const later = "2026-07-23T10:01:00.000Z" as const

const lease = (
  overrides: Partial<ActivityDeliveryStore.ActivityLeaseRef> = {}
): ActivityDeliveryStore.ActivityLeaseRef => ({
  leaseVersion: 1,
  key: {
    tenantId: "tenant-a",
    intentId: "intent-a"
  },
  workerId: "worker-a",
  workerDeploymentId: "deployment-a",
  deliveryEpoch: 3,
  leaseId: "activity-lease-a",
  ...overrides
})

const coordinates = (
  overrides: Partial<Cancellation.CancellationIdentityCoordinates> = {}
): Cancellation.CancellationIdentityCoordinates => ({
  activityLeaseRef: lease(),
  attemptId: "attempt-a",
  attempt: 2,
  logicalActivityId: "logical-a",
  cancellationRequestId: "cancel-request-a",
  sourceEventId: "event-a",
  reason: "RunCancellationRequested",
  ...overrides
})

const issued = (
  overrides: Partial<Cancellation.IssuedExecutionRef> = {}
): Cancellation.IssuedExecutionRef => {
  const identityCoordinates = coordinates(
    overrides.activityLeaseRef === undefined
      ? {}
      : { activityLeaseRef: overrides.activityLeaseRef }
  )
  return {
    issuedVersion: 1,
    ...identityCoordinates,
    cancellationId: Cancellation.makeCancellationId(identityCoordinates),
    enqueuedAt: at,
    ...overrides
  }
}

const claimRef = (
  overrides: Partial<Cancellation.CancellationClaimRef> = {}
): Cancellation.CancellationClaimRef => ({
  claimRefVersion: 1,
  activityLeaseRef: lease(),
  attemptId: "attempt-a",
  attempt: 2,
  logicalActivityId: "logical-a",
  cancellationId: issued().cancellationId,
  workerIncarnationId: "incarnation-a",
  claimantId: "claimant-a",
  claimEpoch: 4,
  claimLeaseId: "claim-lease-a",
  ...overrides
})

const claimRequest: Cancellation.ClaimCancellationsRequest = {
  requestVersion: 1,
  tenantId: "tenant-a",
  workerId: "worker-a",
  workerIncarnationId: "incarnation-a",
  workerDeploymentId: "deployment-a",
  claimantId: "claimant-a",
  requestId: "claim-request-a",
  limit: 10,
  leaseDurationMillis: 60_000
}

const strictDecode = <A>(
  schema: Schema.ConstraintDecoder<A>,
  input: unknown
): Result.Result<A, Schema.SchemaError> =>
  Schema.decodeUnknownResult(schema, {
    errors: "all",
    onExcessProperty: "error"
  })(input)

describe("ActivityCancellationDelivery", () => {
  it("decodes exact issued, pending, leased, and acknowledged records", () => {
    const exactIssued = issued()
    const ref = claimRef()
    const records: ReadonlyArray<Cancellation.CancellationRecord> = [
      {
        _tag: "Pending",
        recordVersion: 1,
        issued: exactIssued,
        claimEpoch: 0
      },
      {
        _tag: "Leased",
        recordVersion: 1,
        issued: exactIssued,
        ref,
        claimRequestId: "claim-request-a",
        leasedAt: at,
        expiresAt: later
      },
      {
        _tag: "Acknowledged",
        recordVersion: 1,
        issued: exactIssued,
        ref,
        claimRequestId: "claim-request-a",
        leasedAt: at,
        expiresAt: later,
        acknowledgeRequestId: "ack-request-a",
        acknowledgedAt: later,
        disposition: "Interrupted"
      }
    ]

    assert.isTrue(Result.isSuccess(
      strictDecode(Cancellation.IssuedExecutionRef, exactIssued)
    ))
    for (const record of records) {
      assert.isTrue(Result.isSuccess(
        strictDecode(Cancellation.CancellationRecord, record)
      ))
    }
  })

  it("decodes bounded claim, acknowledgement, and release wire messages", () => {
    const ref = claimRef()
    const claim: Cancellation.CancellationClaim = {
      claimVersion: 1,
      ref,
      issued: issued(),
      claimRequestId: claimRequest.requestId,
      leasedAt: at,
      expiresAt: later
    }
    const receipt: Cancellation.ClaimCancellationsReceipt = {
      receiptVersion: 1,
      tenantId: claimRequest.tenantId,
      workerId: claimRequest.workerId,
      workerIncarnationId: claimRequest.workerIncarnationId,
      workerDeploymentId: claimRequest.workerDeploymentId,
      claimantId: claimRequest.claimantId,
      requestId: claimRequest.requestId,
      claims: [claim]
    }

    assert.isTrue(Result.isSuccess(
      strictDecode(Cancellation.ClaimCancellationsRequest, claimRequest)
    ))
    assert.isTrue(Result.isSuccess(
      strictDecode(Cancellation.ClaimCancellationsReceipt, receipt)
    ))
    assert.isTrue(Result.isSuccess(strictDecode(
      Cancellation.AcknowledgeCancellationRequest,
      {
        requestVersion: 1,
        requestId: "ack-request-a",
        ref,
        disposition: "AlreadyFinished"
      }
    )))
    assert.isTrue(Result.isSuccess(strictDecode(
      Cancellation.ReleaseCancellationClaimRequest,
      {
        requestVersion: 1,
        requestId: "release-request-a",
        ref
      }
    )))
  })

  it("rejects excess properties and values outside claim bounds", () => {
    const invalid = [
      { ...claimRequest, extra: true },
      { ...claimRequest, limit: 0 },
      { ...claimRequest, limit: Cancellation.MaxClaimBatchSize + 1 },
      { ...claimRequest, leaseDurationMillis: 0 },
      {
        ...claimRequest,
        leaseDurationMillis: ProtocolV2Wire.MaximumSemanticDelayMillis + 1
      },
      {
        ...claimRequest,
        workerId: ""
      },
      {
        ...claimRequest,
        requestVersion: 2
      }
    ]
    for (const candidate of invalid) {
      assert.isTrue(Result.isFailure(
        strictDecode(Cancellation.ClaimCancellationsRequest, candidate)
      ))
    }

    const nestedExcess = {
      ...issued(),
      activityLeaseRef: {
        ...lease(),
        unexpected: "not admitted"
      }
    }
    assert.isTrue(Result.isFailure(
      strictDecode(Cancellation.IssuedExecutionRef, nestedExcess)
    ))
    assert.isTrue(Result.isFailure(
      strictDecode(Cancellation.IssuedExecutionRef, {
        ...issued(),
        cancellationId: "forged-cancellation"
      })
    ))
    assert.isTrue(Result.isFailure(
      strictDecode(Cancellation.CancellationClaim, {
        claimVersion: 1,
        ref: claimRef({
          activityLeaseRef: lease({
            deliveryEpoch: 2,
            leaseId: "old-lease"
          })
        }),
        issued: issued(),
        claimRequestId: "claim-request-a",
        leasedAt: at,
        expiresAt: later
      })
    ))
  })

  it("rejects accessor-based request input without invoking it", () => {
    let accessed = 0
    const hostile = { ...claimRequest } as Record<string, unknown>
    Object.defineProperty(hostile, "tenantId", {
      enumerable: true,
      get() {
        accessed++
        return "tenant-a"
      }
    })

    const decoded = Cancellation.decodeClaimCancellationsRequest(hostile)

    assert.isTrue(Result.isFailure(decoded))
    assert.strictEqual(accessed, 0)
    if (Result.isSuccess(decoded)) {
      throw new Error("expected hostile request rejection")
    }
    assert.instanceOf(
      decoded.failure,
      Cancellation.InvalidCancellationDeliveryRequest
    )
  })

  it("commits every issued lease generation and cancellation coordinate to identity", () => {
    const base = coordinates()
    const baseId = Cancellation.makeCancellationId(base)
    const variants: ReadonlyArray<Cancellation.CancellationIdentityCoordinates> = [
      { ...base, activityLeaseRef: lease({ key: { tenantId: "tenant-b", intentId: "intent-a" } }) },
      { ...base, activityLeaseRef: lease({ key: { tenantId: "tenant-a", intentId: "intent-b" } }) },
      { ...base, activityLeaseRef: lease({ workerId: "worker-b" }) },
      { ...base, activityLeaseRef: lease({ workerDeploymentId: "deployment-b" }) },
      { ...base, activityLeaseRef: lease({ deliveryEpoch: 4 }) },
      { ...base, activityLeaseRef: lease({ leaseId: "activity-lease-b" }) },
      { ...base, attemptId: "attempt-b" },
      { ...base, attempt: 3 },
      { ...base, logicalActivityId: "logical-b" },
      { ...base, cancellationRequestId: "cancel-request-b" },
      { ...base, sourceEventId: "event-b" },
      { ...base, reason: "RunTerminal" }
    ]
    const ids = variants.map(Cancellation.makeCancellationId)

    assert.strictEqual(new Set([baseId, ...ids]).size, ids.length + 1)
    assert.notStrictEqual(
      Cancellation.makeCancellationId(coordinates({
        activityLeaseRef: lease({ deliveryEpoch: 3 })
      })),
      Cancellation.makeCancellationId(coordinates({
        activityLeaseRef: lease({ deliveryEpoch: 4 })
      }))
    )
  })

  it("keeps claim fences distinct across stale worker generations", () => {
    const current = claimRef()
    const staleEpoch = claimRef({ claimEpoch: current.claimEpoch - 1 })
    const staleIncarnation = claimRef({
      workerIncarnationId: "incarnation-old"
    })
    const oldActivityGeneration = claimRef({
      activityLeaseRef: lease({
        deliveryEpoch: 2,
        leaseId: "activity-lease-old"
      })
    })

    assert.notDeepEqual(current, staleEpoch)
    assert.notDeepEqual(current, staleIncarnation)
    assert.notDeepEqual(current, oldActivityGeneration)
    for (
      const ref of [
        current,
        staleEpoch,
        staleIncarnation,
        oldActivityGeneration
      ]
    ) {
      assert.isTrue(Result.isSuccess(
        strictDecode(Cancellation.CancellationClaimRef, ref)
      ))
    }
  })

  it("encodes every typed store error as strict schema data", () => {
    const errors = [
      {
        schema: Cancellation.InvalidCancellationDeliveryRequest,
        value: new Cancellation.InvalidCancellationDeliveryRequest({
          operation: "claimCancellations",
          message: "invalid"
        })
      },
      {
        schema: Cancellation.CancellationDeliveryRequestConflict,
        value: new Cancellation.CancellationDeliveryRequestConflict({
          operation: "acknowledgeCancellation",
          tenantId: "tenant-a",
          requestId: "request-a"
        })
      },
      {
        schema: Cancellation.CancellationNotFound,
        value: new Cancellation.CancellationNotFound({
          tenantId: "tenant-a",
          cancellationId: "cancellation-a"
        })
      },
      {
        schema: Cancellation.CancellationClaimBusy,
        value: new Cancellation.CancellationClaimBusy({
          cancellationId: "cancellation-a",
          claimantId: "claimant-a",
          workerIncarnationId: "incarnation-a",
          claimEpoch: 1,
          expiresAt: later
        })
      },
      {
        schema: Cancellation.StaleCancellationClaim,
        value: new Cancellation.StaleCancellationClaim({
          cancellationId: "cancellation-a",
          claimantId: "claimant-a",
          workerIncarnationId: "incarnation-a",
          requestedEpoch: 1,
          currentEpoch: 2,
          reason: "Superseded"
        })
      },
      {
        schema: Cancellation.CancellationDispositionConflict,
        value: new Cancellation.CancellationDispositionConflict({
          cancellationId: "cancellation-a",
          existing: "Interrupted",
          requested: "AlreadyFinished"
        })
      },
      {
        schema: Cancellation.ActivityCancellationDeliveryStoreFailure,
        value: new Cancellation.ActivityCancellationDeliveryStoreFailure({
          operation: "releaseCancellationClaim",
          message: "unavailable",
          cause: { code: "storage" }
        })
      }
    ] as const

    for (const candidate of errors) {
      const encoded = Schema.encodeUnknownResult(
        candidate.schema
      )(candidate.value)
      assert.isTrue(Result.isSuccess(encoded))
      if (Result.isSuccess(encoded)) {
        assert.doesNotThrow(() => JSON.stringify(encoded.success))
      }
    }
  })
})
