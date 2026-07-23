import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const blobRef = (): ProtocolV2Wire.BlobRef => ({
  blobVersion: 1,
  digest: Schema.decodeUnknownSync(ProtocolV2Wire.BlobDigest)(digest("a")),
  encodedBytes: 4,
  mediaType: "application/json"
})

const attribution = (): ProtocolV2Wire.AdmissionAttribution => ({
  actorId: "actor-1",
  policyId: "orders.signal",
  policyVersion: "1.0.0",
  policyDecisionId: "decision-1"
})

describe("ProtocolV2Wire", () => {
  it("admits only bounded safe integers", () => {
    const decodeNonNegative = Schema.decodeUnknownSync(ProtocolV2Wire.NonNegativeSafeInt)
    const decodePositive = Schema.decodeUnknownSync(ProtocolV2Wire.PositiveSafeInt)

    assert.strictEqual(decodeNonNegative(0), 0)
    assert.strictEqual(decodeNonNegative(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
    assert.strictEqual(decodePositive(1), 1)
    assert.strictEqual(decodePositive(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)

    for (
      const invalid of [
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY
      ]
    ) {
      assert.throws(() => decodeNonNegative(invalid))
    }
    for (
      const invalid of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY
      ]
    ) {
      assert.throws(() => decodePositive(invalid))
    }
  })

  it("bounds relative semantic delays so valid timestamp addition is representable", () => {
    const decodeDelay = Schema.decodeUnknownSync(ProtocolV2Wire.SemanticDelayMillis)
    const decodePositive = Schema.decodeUnknownSync(
      ProtocolV2Wire.PositiveSemanticDelayMillis
    )
    assert.strictEqual(decodeDelay(0), 0)
    assert.strictEqual(
      decodeDelay(ProtocolV2Wire.MaximumSemanticDelayMillis),
      ProtocolV2Wire.MaximumSemanticDelayMillis
    )
    assert.strictEqual(decodePositive(1), 1)
    assert.strictEqual(
      decodePositive(ProtocolV2Wire.MaximumSemanticDelayMillis),
      ProtocolV2Wire.MaximumSemanticDelayMillis
    )
    for (
      const invalid of [
        -1,
        0.5,
        ProtocolV2Wire.MaximumSemanticDelayMillis + 1,
        Number.MAX_SAFE_INTEGER
      ]
    ) {
      assert.throws(() => decodeDelay(invalid))
    }
    assert.throws(() => decodePositive(0))
  })

  it("requires one canonical UTC millisecond timestamp and a valid calendar date", () => {
    const decode = Schema.decodeUnknownSync(ProtocolV2Wire.Timestamp)
    for (
      const valid of [
        "2024-02-29T00:00:00.000Z",
        "2026-07-23T01:02:03.004Z",
        "9999-12-31T23:59:59.999Z"
      ]
    ) {
      assert.strictEqual(decode(valid), valid)
    }

    for (
      const invalid of [
        "2023-02-29T00:00:00.000Z",
        "2024-04-31T00:00:00.000Z",
        "2026-07-23T01:02:03Z",
        "2026-07-23T01:02:03.0001Z",
        "2026-07-23T02:02:03.000+01:00",
        "2026-7-23T01:02:03.000Z",
        ""
      ]
    ) {
      assert.throws(() => decode(invalid))
    }
  })

  it("validates every digest kind and retains distinct nominal brands", () => {
    const schemas = [
      ProtocolV2Wire.ArtifactDigest,
      ProtocolV2Wire.CompiledFingerprint,
      ProtocolV2Wire.PayloadDigest,
      ProtocolV2Wire.RequestDigest,
      ProtocolV2Wire.BuildDigest,
      ProtocolV2Wire.DefinitionDigest,
      ProtocolV2Wire.SchemaDigest,
      ProtocolV2Wire.HistoryDigest,
      ProtocolV2Wire.BlobDigest
    ] as const

    assert.strictEqual(
      Schema.decodeUnknownSync(ProtocolV2Wire.Sha256Digest)(digest("0")),
      digest("0")
    )
    for (const schema of schemas) {
      assert.strictEqual(Schema.decodeUnknownSync(schema)(digest("a")), digest("a"))
      for (
        const invalid of [
          "sha256:",
          `sha256:${"a".repeat(63)}`,
          `sha256:${"A".repeat(64)}`,
          `sha512:${"a".repeat(64)}`,
          `${digest("a")} `,
          ""
        ]
      ) {
        assert.throws(() => Schema.decodeUnknownSync(schema)(invalid))
      }
    }

    const brands = schemas.map((schema) => {
      const annotations: unknown = schema.ast.checks?.at(-1)?.annotations?.brands
      assert.isTrue(Array.isArray(annotations))
      if (!Array.isArray(annotations)) {
        throw new Error("Expected one nominal digest brand annotation")
      }
      assert.strictEqual(annotations.length, 1)
      assert.isString(annotations[0])
      return annotations[0] as string
    })
    assert.strictEqual(new Set(brands).size, schemas.length)
  })

  it("strictly distinguishes inline JSON from a bounded blob reference", () => {
    const decode = Schema.decodeUnknownSync(ProtocolV2Wire.EncodedPayload)
    const inlineValues: ReadonlyArray<Schema.Json> = [
      null,
      true,
      1,
      "value",
      ["one", 2, false],
      { nested: { value: "ok" } }
    ]
    for (const value of inlineValues) {
      assert.deepStrictEqual(decode({ _tag: "Inline", value }), { _tag: "Inline", value })
    }

    assert.deepStrictEqual(
      decode({ _tag: "Blob", ref: blobRef() }),
      { _tag: "Blob", ref: blobRef() }
    )

    const malformed: ReadonlyArray<unknown> = [
      { _tag: "Inline", value: undefined },
      { _tag: "Inline", value: Number.NaN },
      { _tag: "Inline", value: 1, extra: true },
      { _tag: "Blob", ref: { ...blobRef(), encodedBytes: 0 } },
      { _tag: "Blob", ref: { ...blobRef(), encodedBytes: 1.5 } },
      { _tag: "Blob", ref: { ...blobRef(), encodedBytes: Number.MAX_SAFE_INTEGER + 1 } },
      { _tag: "Blob", ref: { ...blobRef(), mediaType: "" } },
      { _tag: "Blob", ref: { ...blobRef(), extra: true } },
      { _tag: "Blob", ref: blobRef(), extra: true },
      { _tag: "Unknown", value: null }
    ]
    for (const value of malformed) {
      assert.throws(() => decode(value))
    }
  })

  it("requires complete nonempty admission attribution and rejects excess data", () => {
    const decode = Schema.decodeUnknownSync(ProtocolV2Wire.AdmissionAttribution)
    assert.deepStrictEqual(decode(attribution()), attribution())

    for (const field of ["actorId", "policyId", "policyVersion", "policyDecisionId"] as const) {
      assert.throws(() => decode({ ...attribution(), [field]: "" }))
      const missing = { ...attribution() } as Record<string, unknown>
      delete missing[field]
      assert.throws(() => decode(missing))
    }
    assert.throws(() => decode({ ...attribution(), credentials: "secret" }))
  })
})
