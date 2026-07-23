import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const assertType = <T extends true>(value: T): void => {
  assert.isTrue(value)
}

const blobRef = (): ProtocolV3Wire.BlobRef => ({
  blobVersion: 1,
  digest: Schema.decodeUnknownSync(ProtocolV3Wire.BlobDigest)(digest("a")),
  encodedBytes: 4,
  mediaType: "application/json"
})

describe("ProtocolV3Wire", () => {
  it("admits only bounded safe integers and semantic delays", () => {
    const decodeNonNegative = Schema.decodeUnknownSync(
      ProtocolV3Wire.NonNegativeSafeInt
    )
    const decodePositive = Schema.decodeUnknownSync(
      ProtocolV3Wire.PositiveSafeInt
    )
    const decodeDelay = Schema.decodeUnknownSync(
      ProtocolV3Wire.SemanticDelayMillis
    )
    const decodePositiveDelay = Schema.decodeUnknownSync(
      ProtocolV3Wire.PositiveSemanticDelayMillis
    )

    assert.strictEqual(decodeNonNegative(0), 0)
    assert.strictEqual(
      decodeNonNegative(Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER
    )
    assert.strictEqual(decodePositive(1), 1)
    assert.strictEqual(
      decodePositive(Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER
    )
    assert.strictEqual(decodeDelay(0), 0)
    assert.strictEqual(
      decodeDelay(ProtocolV3Wire.MaximumSemanticDelayMillis),
      ProtocolV3Wire.MaximumSemanticDelayMillis
    )
    assert.strictEqual(decodePositiveDelay(1), 1)
    assert.strictEqual(
      decodePositiveDelay(ProtocolV3Wire.MaximumSemanticDelayMillis),
      ProtocolV3Wire.MaximumSemanticDelayMillis
    )

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
    for (
      const invalid of [
        -1,
        0.5,
        ProtocolV3Wire.MaximumSemanticDelayMillis + 1,
        Number.MAX_SAFE_INTEGER
      ]
    ) {
      assert.throws(() => decodeDelay(invalid))
    }
    assert.throws(() => decodePositiveDelay(0))
  })

  it("requires canonical UTC millisecond timestamps with valid calendar dates", () => {
    const decode = Schema.decodeUnknownSync(ProtocolV3Wire.Timestamp)
    for (
      const valid of [
        "0000-02-29T00:00:00.000Z",
        "2000-02-29T00:00:00.000Z",
        "2026-07-23T01:02:03.004Z",
        "9999-12-31T23:59:59.999Z"
      ]
    ) {
      assert.strictEqual(decode(valid), valid)
    }

    for (
      const invalid of [
        "1900-02-29T00:00:00.000Z",
        "2023-02-29T00:00:00.000Z",
        "2024-04-31T00:00:00.000Z",
        "2026-07-23T01:02:03Z",
        "2026-07-23T01:02:03.0001Z",
        "2026-07-23T02:02:03.000+01:00",
        "2026-7-23T01:02:03.000Z",
        "2026-00-01T00:00:00.000Z",
        "2026-01-00T00:00:00.000Z",
        ""
      ]
    ) {
      assert.throws(() => decode(invalid))
    }
  })

  it("validates digest spelling and keeps every v3 digest domain nominally distinct", () => {
    const schemas = [
      ProtocolV3Wire.ArtifactDigest,
      ProtocolV3Wire.CompiledFingerprint,
      ProtocolV3Wire.ContractDigest,
      ProtocolV3Wire.BuildDigest,
      ProtocolV3Wire.SchemaDigest,
      ProtocolV3Wire.PayloadDigest,
      ProtocolV3Wire.BlobDigest
    ] as const

    assert.strictEqual(
      Schema.decodeUnknownSync(ProtocolV3Wire.Sha256Digest)(digest("0")),
      digest("0")
    )
    for (const schema of schemas) {
      assert.strictEqual(
        Schema.decodeUnknownSync(schema)(digest("a")),
        digest("a")
      )
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
    assert.isTrue(
      brands.every((brand) => brand.startsWith("@effect/workflow-builder/ProtocolV3Wire/"))
    )

    assertType<
      Types.Equals<
        ProtocolV2Wire.ArtifactDigest,
        ProtocolV3Wire.ArtifactDigest
      > extends false ? true : false
    >(true)
    assertType<
      Types.Equals<
        ProtocolV3Wire.ArtifactDigest,
        ProtocolV3Wire.CompiledFingerprint
      > extends false ? true : false
    >(true)
    assertType<
      Types.Equals<
        ProtocolV2Wire.BuildDigest,
        ProtocolV3Wire.BuildDigest
      > extends false ? true : false
    >(true)
    assertType<
      Types.Equals<
        ProtocolV3Wire.BuildDigest,
        ProtocolV3Wire.SchemaDigest
      > extends false ? true : false
    >(true)
  })

  it("preserves compatible serialized primitives without sharing v2 brands", () => {
    const rawDigest = digest("b")
    const v2Artifact = Schema.decodeUnknownSync(
      ProtocolV2Wire.ArtifactDigest
    )(rawDigest)
    const v3Artifact = Schema.decodeUnknownSync(
      ProtocolV3Wire.ArtifactDigest
    )(rawDigest)
    assert.strictEqual(v3Artifact, v2Artifact)

    const v2Brand: unknown = ProtocolV2Wire.ArtifactDigest.ast.checks?.at(-1)?.annotations?.brands
    const v3Brand: unknown = ProtocolV3Wire.ArtifactDigest.ast.checks?.at(-1)?.annotations?.brands
    assert.notDeepEqual(v3Brand, v2Brand)

    const rawReference = {
      blobVersion: 1,
      digest: digest("c"),
      encodedBytes: 17,
      mediaType: "application/json"
    }
    assert.deepStrictEqual(
      Schema.encodeSync(ProtocolV3Wire.BlobRef)(
        Schema.decodeUnknownSync(ProtocolV3Wire.BlobRef)(rawReference)
      ),
      Schema.encodeSync(ProtocolV2Wire.BlobRef)(
        Schema.decodeUnknownSync(ProtocolV2Wire.BlobRef)(rawReference)
      )
    )
  })

  it("admits the complete strict JSON value vocabulary", () => {
    const decode = Schema.decodeUnknownSync(ProtocolV3Wire.EncodedJsonValue)
    const valid: ReadonlyArray<Schema.Json> = [
      null,
      true,
      false,
      0,
      -1.5,
      "value",
      ["one", 2, false, null],
      {
        nested: {
          array: [1, 2, 3]
        }
      }
    ]
    for (const value of valid) {
      assert.deepStrictEqual(decode(value), value)
    }

    for (
      const invalid of [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1n,
        Symbol("value"),
        () => "value",
        [undefined],
        { nested: undefined }
      ]
    ) {
      assert.throws(() => decode(invalid))
    }
  })

  it("strictly distinguishes inline JSON from bounded blob references", () => {
    const decode = Schema.decodeUnknownSync(ProtocolV3Wire.EncodedPayload)
    assert.deepStrictEqual(
      decode({ _tag: "Inline", value: { nested: ["ok"] } }),
      { _tag: "Inline", value: { nested: ["ok"] } }
    )
    assert.deepStrictEqual(
      decode({ _tag: "Blob", ref: blobRef() }),
      { _tag: "Blob", ref: blobRef() }
    )

    const malformed: ReadonlyArray<unknown> = [
      { _tag: "Inline", value: undefined },
      { _tag: "Inline", value: Number.NaN },
      { _tag: "Inline", value: 1, extra: true },
      { _tag: "Blob", ref: { ...blobRef(), blobVersion: 3 } },
      { _tag: "Blob", ref: { ...blobRef(), encodedBytes: 0 } },
      { _tag: "Blob", ref: { ...blobRef(), encodedBytes: 1.5 } },
      {
        _tag: "Blob",
        ref: {
          ...blobRef(),
          encodedBytes: Number.MAX_SAFE_INTEGER + 1
        }
      },
      { _tag: "Blob", ref: { ...blobRef(), mediaType: "" } },
      { _tag: "Blob", ref: { ...blobRef(), digest: digest("A") } },
      { _tag: "Blob", ref: { ...blobRef(), credentials: "secret" } },
      { _tag: "Blob", ref: blobRef(), extra: true },
      { _tag: "Unknown", value: null }
    ]
    for (const value of malformed) {
      assert.throws(() => decode(value))
    }
  })
})
