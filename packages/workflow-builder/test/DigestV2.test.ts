import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import { createHash } from "node:crypto"
import * as DigestV2 from "../src/DigestV2.ts"

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (
          output[index % output.length]! +
          data[index]! +
          index
        ) & 0xff
      }
      return output
    })
})

const sha256Crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

describe("DigestV2", () => {
  it.effect("canonicalizes object order and separates protocol domains", () =>
    Effect.gen(function*() {
      const first = yield* DigestV2.payload({
        b: 2,
        a: 1
      })
      const reordered = yield* DigestV2.payload({
        a: 1,
        b: 2
      })
      const request = yield* DigestV2.request({
        a: 1,
        b: 2
      })

      assert.strictEqual(first, reordered)
      assert.notStrictEqual(String(first), String(request))
      assert.match(first, /^sha256:[0-9a-f]{64}$/)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("fails closed for hostile non-JSON preimages", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    return Effect.gen(function*() {
      const result = yield* DigestV2.artifact(
        cyclic as never
      ).pipe(Effect.result)
      assert.strictEqual(result._tag, "Failure")
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })

  it.effect("hashes exact blob bytes independently from JSON domains", () =>
    Effect.gen(function*() {
      const bytes = new TextEncoder().encode("{\"value\":1}")
      const first = yield* DigestV2.blob(bytes)
      const second = yield* DigestV2.blob(bytes.slice())
      const payload = yield* DigestV2.payload({ value: 1 })

      assert.strictEqual(first, second)
      assert.notStrictEqual(String(first), String(payload))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("locks every protocol domain and raw blob spelling to real SHA-256 vectors", () =>
    Effect.gen(function*() {
      const value = { b: 2, a: 1 }
      const digests = yield* Effect.all([
        DigestV2.artifact(value),
        DigestV2.compiledPlan(value),
        DigestV2.payload(value),
        DigestV2.request(value),
        DigestV2.build(value),
        DigestV2.bpmnExecutable(value),
        DigestV2.definition(value),
        DigestV2.schema(value),
        DigestV2.history(value)
      ])
      assert.deepStrictEqual(digests.map(String), [
        "sha256:0639e9fb4acf96d8729baa798e7beedaa846c1c032528c6484cafd60770434d2",
        "sha256:6968280d10b17aef3edbdfb4a89bab83d434a04a314b9f11413d0ec019fafcef",
        "sha256:8b6bf10c743f95d3733f8d1f18bb05fe3e3225f2027b2ef1486e8884644ef586",
        "sha256:2a5cc8c3d8256fd1421599282f580b2543679c340038b1d42b6c00f2ffd70a23",
        "sha256:6079d244d4ab91b14b58b4dc81b87717a29920e7d1ae3964a23facdcdedafa35",
        "sha256:0b5c3fdb077b3dcbf93cafe5a75339a7059ec072988d099e3c843f29d0074d0b",
        "sha256:6ea7df9c9678562d4d1ec970eb60a2e8914618a5ceef88ab4349e45f6e6eb886",
        "sha256:a1e51fde611bc295d0e539c49d1efb7bdb4eed1184d18e571c5d31891373869f",
        "sha256:3a04b1f9bf65140ae95908453f6b47dd06728632ff514926e2e12972aa956c95"
      ])
      assert.strictEqual(
        yield* DigestV2.blob(
          new TextEncoder().encode(" {\"value\":1}\n")
        ),
        "sha256:c41736cc588a66ab9e58b20b9e6bf89f337ba04f9ddbef51b07f0764460174d6"
      )
    }).pipe(Effect.provideService(Crypto.Crypto, sha256Crypto)))

  it.effect("snapshots caller-owned blob bytes before an asynchronous digest boundary", () => {
    const source = new Uint8Array([1, 2, 3])
    const inspectingCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) =>
        Effect.sync(() => {
          source.fill(9)
          assert.deepStrictEqual([...data], [1, 2, 3])
          return new Uint8Array(32)
        })
    })
    return DigestV2.blob(source).pipe(
      Effect.provideService(Crypto.Crypto, inspectingCrypto),
      Effect.asVoid
    )
  })

  it.effect("does not consult a hostile Uint8Array subclass species while copying", () => {
    class MutatingCopy extends Uint8Array {
      constructor(length: number) {
        super(length)
        queueMicrotask(() => this.fill(9))
      }
    }
    class HostileBytes extends Uint8Array {
      static override get [Symbol.species](): Uint8ArrayConstructor {
        return MutatingCopy
      }
    }
    const source = new HostileBytes([1, 2, 3])
    const inspectingCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) =>
        Effect.promise(async () => {
          await Promise.resolve()
          assert.strictEqual(Object.getPrototypeOf(data), Uint8Array.prototype)
          assert.deepStrictEqual([...data], [1, 2, 3])
          return new Uint8Array(32)
        })
    })
    return DigestV2.blob(source).pipe(
      Effect.provideService(Crypto.Crypto, inspectingCrypto),
      Effect.asVoid
    )
  })
})
