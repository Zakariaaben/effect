import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import { createHash } from "node:crypto"
import * as DigestV3 from "../src/DigestV3.ts"

const sha256Crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const withSha256 = Effect.provideService(Crypto.Crypto, sha256Crypto)

describe("DigestV3", () => {
  it.effect("canonicalizes object order and separates every audited role", () =>
    Effect.gen(function*() {
      const value = { b: 2, a: 1 }
      const reordered = yield* DigestV3.artifact({ a: 1, b: 2 })
      const digests = yield* Effect.all([
        DigestV3.artifact(value),
        DigestV3.compiledPlan(value),
        DigestV3.boundaryContract(value),
        DigestV3.executableBuild(value),
        DigestV3.encodedSchema(value)
      ])

      assert.strictEqual(digests[0], reordered)
      assert.strictEqual(new Set(digests.map(String)).size, digests.length)
      assert.isTrue(
        digests.every((digest) => /^sha256:[0-9a-f]{64}$/.test(digest))
      )
    }).pipe(withSha256))

  it.effect("locks the exact domains and canonical envelope to SHA-256 vectors", () =>
    Effect.gen(function*() {
      const value = { b: 2, a: 1 }
      const digests = yield* Effect.all([
        DigestV3.artifact(value),
        DigestV3.compiledPlan(value),
        DigestV3.boundaryContract(value),
        DigestV3.executableBuild(value),
        DigestV3.encodedSchema(value)
      ])

      assert.deepStrictEqual(digests.map(String), [
        "sha256:cd1c99601ca54875df55ecb703d2685c49a128c5b10dff75108714ae8464eacf",
        "sha256:a021d0fba5e848726ca9a6ba3b194d9b3eae39a43bafece80903c81fbf2b9f2c",
        "sha256:c9680b14d08b5ace27b7caefa56bb45556fee5c430bd75a087a10aa7868ee056",
        "sha256:dda071f7408cdda8c985b4a582b462dd7c30b11b39f3edb1fb87146769229718",
        "sha256:bbb97ccdd5f2455737bcbbe3c615a10c1f7e2fda91eb3789768617a0b92bb7be"
      ])
    }).pipe(withSha256))

  it.effect("rejects hostile inputs without evaluating accessors", () => {
    let getterCalls = 0
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 1
      }
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = new Array(2)
    sparse[1] = "value"

    return Effect.gen(function*() {
      for (
        const input of [
          accessor,
          cyclic,
          sparse,
          Object.assign(Object.create({ inherited: true }), { value: 1 }),
          { value: undefined }
        ]
      ) {
        const result = yield* DigestV3.artifact(input).pipe(Effect.result)
        assert.strictEqual(result._tag, "Failure")
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure._tag, "DigestInputError")
          assert.strictEqual(
            result.failure.domain,
            DigestV3.Domains.Artifact
          )
        }
      }
      assert.strictEqual(getterCalls, 0)
    }).pipe(withSha256)
  })

  it.effect("reports the detached failure path for invalid nested JSON", () =>
    Effect.gen(function*() {
      const result = yield* DigestV3.boundaryContract({
        nested: {
          values: [1, undefined]
        }
      }).pipe(Effect.result)

      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "DigestInputError")
        assert.deepStrictEqual(result.failure.path, [
          "nested",
          "values",
          1
        ])
      }
    }).pipe(withSha256))

  it.effect("snapshots caller-owned JSON before crossing the Crypto boundary", () => {
    const source = { value: 1 }
    const inspectingCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) =>
        Effect.sync(() => {
          source.value = 9
          const preimage = new TextDecoder().decode(data)
          assert.strictEqual(
            preimage,
            "{\"digestProtocolVersion\":1,\"domain\":\"workflow.artifact.v3\",\"value\":{\"value\":1}}"
          )
          return new Uint8Array(32)
        })
    })
    return DigestV3.artifact(source).pipe(
      Effect.provideService(Crypto.Crypto, inspectingCrypto),
      Effect.asVoid
    )
  })

  it.effect("maps Crypto service failures to a typed digest failure", () => {
    const failingCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: () =>
        Effect.fail(PlatformError.systemError({
          _tag: "BadResource",
          module: "test",
          method: "digest",
          description: "unavailable"
        }))
    })
    return Effect.gen(function*() {
      const result = yield* DigestV3.compiledPlan({ value: 1 }).pipe(
        Effect.provideService(Crypto.Crypto, failingCrypto),
        Effect.result
      )
      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "DigestCryptoError")
        assert.strictEqual(
          result.failure.code,
          DigestV3.CryptoFailureCodes.DigestFailed
        )
        assert.strictEqual(
          result.failure.domain,
          DigestV3.Domains.CompiledPlan
        )
      }
    })
  })

  it.effect("rejects invalid or forged SHA-256 outputs with a typed failure", () =>
    Effect.gen(function*() {
      const outputs: ReadonlyArray<unknown> = [
        new Uint8Array(31),
        new Uint8Array(33),
        "not-bytes"
      ]
      for (const output of outputs) {
        const invalidCrypto = Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: () => Effect.succeed(output as Uint8Array)
        })
        const result = yield* DigestV3.encodedSchema({ value: 1 }).pipe(
          Effect.provideService(Crypto.Crypto, invalidCrypto),
          Effect.result
        )
        assert.strictEqual(result._tag, "Failure")
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure._tag, "DigestCryptoError")
          assert.strictEqual(
            result.failure.code,
            DigestV3.CryptoFailureCodes.InvalidDigestOutput
          )
          assert.strictEqual(
            result.failure.domain,
            DigestV3.Domains.EncodedSchema
          )
        }
      }
    }))
})
