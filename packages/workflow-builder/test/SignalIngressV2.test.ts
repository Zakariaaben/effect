import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as SignalIngressV2 from "../src/SignalIngressV2.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.ArtifactDigest
)(digest("a"))
const definitionDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.DefinitionDigest
)(digest("b"))
const requestDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.RequestDigest
)(digest("c"))
const payloadDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.PayloadDigest
)(digest("d"))

const request = (
  overrides: Partial<SignalIngressV2.Request> = {}
): SignalIngressV2.Request => ({
  ingressVersion: 2,
  key: { tenantId: "tenant-1", runId: "run-1" },
  expectedArtifactDigest: artifactDigest,
  signalId: "signal-1",
  signalName: "ApprovalGranted",
  signalVersion: "1.0.0",
  correlation: { _tag: "Exact", key: "order-1" },
  payload: {
    _tag: "Inline",
    value: { approvedBy: "reviewer-1" }
  },
  ...overrides
})

const receipt = (): SignalIngressV2.Receipt => ({
  receiptVersion: 1,
  key: { tenantId: "tenant-1", runId: "run-1" },
  artifactDigest,
  signalDefinitionDigest: definitionDigest,
  signalId: "signal-1",
  signalName: "ApprovalGranted",
  signalVersion: "1.0.0",
  requestDigest,
  payloadDigest,
  encodedPayloadBytes: 27,
  inboxSequence: 0,
  historySequence: 4,
  acceptedEventId: "signal-accepted-1",
  expiryTimerId: "signal-expiry-1",
  acceptedAt: "2026-07-23T01:02:03.000Z",
  expiresAt: "2026-07-24T01:02:03.000Z",
  admission: {
    actorId: "reviewer-1",
    policyId: "approval-signals",
    policyVersion: "1.0.0",
    policyDecisionId: "decision-1"
  }
})

describe("SignalIngressV2", () => {
  it("strictly decodes caller intent without store-owned fields", () => {
    const decode = Schema.decodeUnknownSync(SignalIngressV2.Request)
    assert.deepStrictEqual(decode(request()), request())
    assert.deepStrictEqual(
      decode(request({ payload: { _tag: "Inline", value: "approved" } })),
      request({ payload: { _tag: "Inline", value: "approved" } })
    )

    const blobDigest = Schema.decodeUnknownSync(
      ProtocolV2Wire.BlobDigest
    )(digest("e"))
    const blobRequest = request({
      payload: {
        _tag: "Blob",
        ref: {
          blobVersion: 1,
          digest: blobDigest,
          encodedBytes: 4_096,
          mediaType: "application/json"
        }
      }
    })
    assert.deepStrictEqual(decode(blobRequest), blobRequest)

    for (
      const smuggled of [
        { acceptedAt: "2026-07-23T01:02:03.000Z" },
        { expiresAt: "2026-07-24T01:02:03.000Z" },
        { inboxSequence: 0 },
        { historySequence: 4 },
        { encodedPayloadBytes: 27 },
        { requestDigest },
        { payloadDigest },
        { admission: receipt().admission },
        { expiryTimerId: "forged-timer" },
        { acceptedEventId: "forged-event" }
      ]
    ) {
      assert.throws(() => decode({ ...request(), ...smuggled }))
    }
    assert.throws(() => decode({ ...request(), signalId: "" }))
    assert.throws(() => decode({ ...request(), ingressVersion: 1 }))
    assert.throws(() =>
      decode({
        ...request(),
        payload: { _tag: "Inline", value: undefined }
      })
    )
  })

  it("keeps trusted actor context out of the request wire contract", () => {
    const secretContext = { bearerToken: "never-persist-me", roles: ["reviewer"] }
    const actor = SignalIngressV2.makeAuthenticatedActor(
      "reviewer-1",
      secretContext
    )
    assert.strictEqual(actor.actorId, "reviewer-1")
    assert.strictEqual(actor.authenticationContext, secretContext)
    assert.isFalse("actorId" in request())
    assert.isFalse("authenticationContext" in request())
    assert.throws(() =>
      Schema.decodeUnknownSync(SignalIngressV2.Request)({
        ...request(),
        actor
      })
    )
  })

  it("strictly roundtrips accepted, duplicate, and rejected outcomes", () => {
    const decode = Schema.decodeUnknownSync(SignalIngressV2.AdmissionResult)
    const outcomes: ReadonlyArray<SignalIngressV2.AdmissionResult> = [
      { _tag: "Accepted", receipt: receipt() },
      { _tag: "Duplicate", receipt: receipt() },
      { _tag: "Rejected", reason: "SignalIdConflict" },
      { _tag: "Rejected", reason: "Unauthorized" }
    ]
    for (const outcome of outcomes) {
      assert.deepStrictEqual(decode(outcome), outcome)
    }
    assert.throws(() =>
      decode({
        _tag: "Rejected",
        reason: "Unknown",
        details: { payload: "must-not-be-retained" }
      })
    )
    assert.throws(() =>
      decode({
        _tag: "Accepted",
        receipt: { ...receipt(), extra: true }
      })
    )
  })

  it("applies the hard raw-byte limit before parsing without retaining bytes", () => {
    const policy = Schema.decodeUnknownSync(SignalIngressV2.RawBodyPolicy)({
      maximumBytes: 4
    })
    assert.isTrue(Result.isSuccess(
      SignalIngressV2.checkRawBodySize(new Uint8Array([1, 2, 3, 4]), policy)
    ))

    const rejected = SignalIngressV2.checkRawBodySize(
      new Uint8Array([1, 2, 3, 4, 5]),
      policy
    )
    assert.isTrue(Result.isFailure(rejected))
    if (Result.isSuccess(rejected)) {
      throw new Error("Expected raw body rejection")
    }
    assert.strictEqual(rejected.failure.maximumBytes, 4)
    assert.strictEqual(rejected.failure.actualBytes, 5)
    assert.isFalse("bytes" in rejected.failure)
    assert.throws(() =>
      Schema.decodeUnknownSync(SignalIngressV2.RawBodyPolicy)({
        maximumBytes: 0
      })
    )
  })

  it("strictly classifies transient unavailability separately from rejection", () => {
    const failure = new SignalIngressV2.SignalIngressUnavailable({
      code: SignalIngressV2.UnavailableCodes.AuthorizationUnavailable,
      message: "authorization service unavailable"
    })
    assert.strictEqual(failure._tag, "SignalIngressUnavailable")
    assert.strictEqual(failure.code, "AuthorizationUnavailable")
    assert.throws(() =>
      Schema.decodeUnknownSync(SignalIngressV2.SignalIngressUnavailable)({
        _tag: "SignalIngressUnavailable",
        code: "Unauthorized",
        message: "not transient"
      })
    )
  })
})
