import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as SignalContractV2 from "../src/SignalContractV2.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const buildPin = (
  overrides: Partial<SignalContractV2.BuildPin> = {}
): SignalContractV2.BuildPin => ({
  id: "orders-signal-policy",
  version: "1.0.0",
  deploymentId: "orders-policy-build-1",
  buildDigest: Schema.decodeUnknownSync(ProtocolV2Wire.BuildDigest)(digest("b")),
  ...overrides
})

const codecPin = (
  overrides: Partial<SignalContractV2.CodecPin> = {}
): SignalContractV2.CodecPin => ({
  id: "approval-codec",
  version: "1.0.0",
  deploymentId: "approval-codec-build-1",
  buildDigest: Schema.decodeUnknownSync(ProtocolV2Wire.BuildDigest)(digest("c")),
  contractId: "orders.ApprovalGranted",
  contractVersion: "1.0.0",
  encodedSchemaDigest: Schema.decodeUnknownSync(ProtocolV2Wire.SchemaDigest)(digest("d")),
  ...overrides
})

const definition = (
  overrides: Partial<SignalContractV2.SignalDefinition> = {}
): SignalContractV2.SignalDefinition => ({
  signalDefinitionVersion: 1,
  name: "ApprovalGranted",
  version: "1.0.0",
  payloadCodec: codecPin(),
  authorizationPolicy: buildPin(),
  correlation: "ExactRequired",
  ttlMillis: 86_400_000,
  maxEncodedPayloadBytes: 4_096,
  ...overrides
})

const catalogEntry = (
  signal: SignalContractV2.SignalDefinition,
  digestCharacter: string
): SignalContractV2.SignalCatalogEntry => ({
  key: SignalContractV2.signalDefinitionKey(signal.name, signal.version),
  definitionDigest: Schema.decodeUnknownSync(ProtocolV2Wire.DefinitionDigest)(
    digest(digestCharacter)
  ),
  definition: signal
})

const rejectPolicy = (
  overrides: Partial<SignalContractV2.SignalInboxPolicy> = {}
): SignalContractV2.SignalInboxPolicy => ({
  policyVersion: 1,
  maxAcceptedCount: 100,
  maxPendingCount: 20,
  maxPendingEncodedBytes: 100_000,
  maxItemEncodedBytes: 4_096,
  maxSignalIdBytes: 128,
  maxCorrelationKeyBytes: 256,
  maxPendingWaits: 20,
  maxTtlMillis: 86_400_000,
  deduplicationScope: "RunLifetime",
  receiptRetentionAfterTerminalMillis: 604_800_000,
  overflow: { _tag: "Reject" },
  ...overrides
})

describe("SignalContractV2", () => {
  it("strictly admits complete immutable build and codec pins", () => {
    const decodeBuild = Schema.decodeUnknownSync(SignalContractV2.BuildPin)
    const decodeCodec = Schema.decodeUnknownSync(SignalContractV2.CodecPin)
    assert.deepStrictEqual(decodeBuild(buildPin()), buildPin())
    assert.deepStrictEqual(decodeCodec(codecPin()), codecPin())

    for (const field of ["id", "version", "deploymentId"] as const) {
      assert.throws(() => decodeBuild({ ...buildPin(), [field]: "" }))
      assert.throws(() => decodeCodec({ ...codecPin(), [field]: "" }))
    }
    for (const field of ["contractId", "contractVersion"] as const) {
      assert.throws(() => decodeCodec({ ...codecPin(), [field]: "" }))
    }

    const missingSchemaDigest = { ...codecPin() } as Record<string, unknown>
    delete missingSchemaDigest.encodedSchemaDigest
    assert.throws(() => decodeCodec(missingSchemaDigest))
    assert.throws(() => decodeBuild({ ...buildPin(), extra: true }))
    assert.throws(() => decodeCodec({ ...codecPin(), extra: true }))
    assert.throws(() =>
      decodeCodec({
        ...codecPin(),
        encodedSchemaDigest: "sha256:not-a-digest"
      })
    )
  })

  it("strictly distinguishes any and exact signal correlations", () => {
    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalCorrelation)
    assert.deepStrictEqual(decode({ _tag: "Any" }), { _tag: "Any" })
    assert.deepStrictEqual(decode({ _tag: "Exact", key: "order-1" }), {
      _tag: "Exact",
      key: "order-1"
    })

    for (
      const malformed of [
        { _tag: "Any", key: "order-1" },
        { _tag: "Exact", key: "" },
        { _tag: "Exact", key: "order-1", extra: true },
        { _tag: "Unknown" }
      ]
    ) {
      assert.throws(() => decode(malformed))
    }
  })

  it("builds collision-resistant canonical keys and strictly validates definitions", () => {
    assert.strictEqual(
      SignalContractV2.signalDefinitionKey("ApprovalGranted", "1.0.0"),
      JSON.stringify(["ApprovalGranted", "1.0.0"])
    )
    assert.notStrictEqual(
      SignalContractV2.signalDefinitionKey("a|b", "c"),
      SignalContractV2.signalDefinitionKey("a", "b|c")
    )

    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalDefinition)
    assert.deepStrictEqual(decode(definition()), definition())
    for (const field of ["name", "version"] as const) {
      assert.throws(() => decode({ ...definition(), [field]: "" }))
    }
    for (const correlation of ["AnyAllowed", "ExactRequired"] as const) {
      assert.strictEqual(decode({ ...definition(), correlation }).correlation, correlation)
    }
    for (
      const [field, value] of [
        ["ttlMillis", 0],
        ["ttlMillis", 1.5],
        [
          "ttlMillis",
          ProtocolV2Wire.MaximumSemanticDelayMillis + 1
        ],
        ["ttlMillis", Number.MAX_SAFE_INTEGER + 1],
        ["maxEncodedPayloadBytes", 0],
        ["maxEncodedPayloadBytes", -1],
        ["maxEncodedPayloadBytes", 1.5]
      ] as const
    ) {
      assert.throws(() => decode({ ...definition(), [field]: value }))
    }
    assert.throws(() => decode({ ...definition(), correlation: "CallerSelected" }))
    assert.throws(() => decode({ ...definition(), extra: true }))
  })

  it("requires catalog keys to match definitions and be unique in strict key order", () => {
    const firstDefinition = definition({
      name: "ApprovalGranted",
      version: "1.0.0"
    })
    const secondDefinition = definition({
      name: "OrderCancelled",
      version: "2.0.0",
      correlation: "AnyAllowed"
    })
    const entries = [
      catalogEntry(firstDefinition, "1"),
      catalogEntry(secondDefinition, "2")
    ].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalCatalog)

    assert.deepStrictEqual(decode(entries), entries)
    assert.throws(() => decode([...entries].reverse()))
    assert.throws(() => decode([entries[0], entries[0]]))
    assert.throws(() =>
      decode([{
        ...entries[0],
        key: SignalContractV2.signalDefinitionKey("WrongName", "1.0.0")
      }])
    )
    assert.throws(() => decode([{ ...entries[0], extra: true }]))
    assert.throws(() =>
      decode([{
        ...entries[0],
        definition: { ...entries[0]!.definition, extra: true }
      }])
    )
  })

  it("enforces inbox count, byte, item, and safe-integer relationships", () => {
    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalInboxPolicy)
    assert.deepStrictEqual(decode(rejectPolicy()), rejectPolicy())

    const nonPositiveFields = [
      "maxAcceptedCount",
      "maxPendingCount",
      "maxPendingEncodedBytes",
      "maxItemEncodedBytes",
      "maxSignalIdBytes",
      "maxCorrelationKeyBytes",
      "maxPendingWaits",
      "maxTtlMillis"
    ] as const
    for (const field of nonPositiveFields) {
      assert.throws(() => decode({ ...rejectPolicy(), [field]: 0 }))
      assert.throws(() => decode({ ...rejectPolicy(), [field]: 1.5 }))
      assert.throws(() => decode({ ...rejectPolicy(), [field]: Number.MAX_SAFE_INTEGER + 1 }))
      if (field === "maxTtlMillis") {
        assert.throws(() =>
          decode({
            ...rejectPolicy(),
            [field]: ProtocolV2Wire.MaximumSemanticDelayMillis + 1
          })
        )
      }
    }
    assert.strictEqual(
      decode(rejectPolicy({ receiptRetentionAfterTerminalMillis: 0 }))
        .receiptRetentionAfterTerminalMillis,
      0
    )
    for (
      const invalid of [
        -1,
        0.5,
        ProtocolV2Wire.MaximumSemanticDelayMillis + 1,
        Number.MAX_SAFE_INTEGER + 1
      ]
    ) {
      assert.throws(() => decode(rejectPolicy({ receiptRetentionAfterTerminalMillis: invalid })))
    }

    assert.throws(() =>
      decode(rejectPolicy({
        maxAcceptedCount: 19,
        maxPendingCount: 20
      }))
    )
    assert.throws(() =>
      decode(rejectPolicy({
        maxPendingEncodedBytes: 4_095,
        maxItemEncodedBytes: 4_096
      }))
    )
    assert.throws(() =>
      decode({
        ...rejectPolicy(),
        deduplicationScope: "RetentionWindow"
      })
    )
    assert.throws(() => decode({ ...rejectPolicy(), extra: true }))
  })

  it("requires a bounded dead-letter overflow policy large enough for one item", () => {
    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalInboxPolicy)
    const deadLetter: SignalContractV2.DeadLetterOverflow = {
      _tag: "DeadLetter",
      maxCount: 25,
      maxEncodedBytes: 50_000,
      retentionMillis: 86_400_000
    }
    const valid = rejectPolicy({ overflow: deadLetter })
    assert.deepStrictEqual(decode(valid), valid)

    for (const field of ["maxCount", "maxEncodedBytes", "retentionMillis"] as const) {
      assert.throws(() =>
        decode(rejectPolicy({
          overflow: { ...deadLetter, [field]: 0 }
        }))
      )
      assert.throws(() =>
        decode(rejectPolicy({
          overflow: { ...deadLetter, [field]: Number.MAX_SAFE_INTEGER + 1 }
        }))
      )
    }
    assert.throws(() =>
      decode(rejectPolicy({
        overflow: { ...deadLetter, maxEncodedBytes: 4_095 }
      }))
    )
    assert.throws(() =>
      decode({
        ...rejectPolicy(),
        overflow: { ...deadLetter, extra: true }
      })
    )
  })

  it("bounds every catalog definition by its pinned inbox policy", () => {
    const entry = catalogEntry(definition(), "a")
    const manifest: SignalContractV2.SignalCatalogManifest = {
      catalogVersion: 1,
      definitions: [entry],
      inboxPolicy: rejectPolicy()
    }
    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalCatalogManifest)
    assert.deepStrictEqual(decode(manifest), manifest)

    assert.throws(() =>
      decode({
        ...manifest,
        definitions: [
          catalogEntry(definition({ ttlMillis: manifest.inboxPolicy.maxTtlMillis + 1 }), "b")
        ]
      })
    )
    assert.throws(() =>
      decode({
        ...manifest,
        definitions: [
          catalogEntry(
            definition({
              maxEncodedPayloadBytes: manifest.inboxPolicy.maxItemEncodedBytes + 1
            }),
            "c"
          )
        ]
      })
    )
    assert.throws(() => decode({ ...manifest, extra: true }))
  })

  it("exposes and strictly decodes the complete typed rejection vocabulary", () => {
    const expected = [
      "InvalidRequest",
      "UnknownRun",
      "WrongArtifact",
      "UnknownSignal",
      "Unauthorized",
      "InvalidPayload",
      "PayloadTooLarge",
      "SignalIdTooLarge",
      "CorrelationKeyTooLarge",
      "InboxCountExceeded",
      "PendingCountExceeded",
      "PendingBytesExceeded",
      "WaitingCapacityExceeded",
      "TerminalRun",
      "SignalIdConflict",
      "Expired",
      "DeadLettered"
    ] as const
    assert.deepStrictEqual(
      Object.values(SignalContractV2.SignalRejectionReasons),
      [...expected]
    )
    const decode = Schema.decodeUnknownSync(SignalContractV2.SignalRejectionReason)
    for (const reason of expected) {
      assert.strictEqual(decode(reason), reason)
    }
    assert.throws(() => decode("Unknown"))
    assert.throws(() => decode(""))
  })
})
