import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Compiler from "../src/Compiler.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const definition = Workflow.make("fingerprint-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(),
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 8,
    maxEdges: 8,
    maxFanIn: 4,
    maxFanOut: 4,
    maxDepth: 4
  })
})

const plan = (revision: number) => ({
  formatVersion: 2,
  id: "fingerprint-plan",
  revision,
  definition: {
    id: "fingerprint-workflow",
    version: "1.0.0"
  },
  nodes: [],
  edges: [],
  metadata: {
    z: 1,
    a: { second: true, first: null }
  }
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (output[index % output.length]! + data[index]! + index) & 0xff
      }
      return output
    })
})

describe("Fingerprint", () => {
  it("canonicalizes object keys recursively while preserving array order", () => {
    const input: Schema.Json = {
      z: 1,
      a: { beta: true, alpha: null },
      list: [{ b: 2, a: 1 }, "x"]
    }

    assert.strictEqual(
      Fingerprint.canonicalize(input),
      "{\"a\":{\"alpha\":null,\"beta\":true},\"list\":[{\"a\":1,\"b\":2},\"x\"],\"z\":1}"
    )
    assert.notStrictEqual(Fingerprint.canonicalize([1, 2]), Fingerprint.canonicalize([2, 1]))
  })

  it("rejects hostile and non-JSON containers without invoking user code", () => {
    let getterReads = 0
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterReads++
        return 1
      }
    })
    const sparse = new Array(2)
    sparse[0] = 1
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const overridden = [1]
    Object.defineProperty(overridden, Symbol.iterator, {
      value: function*() {},
      enumerable: false
    })

    for (const value of [accessor, sparse, cyclic, overridden, undefined, 1n, Number.NaN]) {
      assert.throws(() => Fingerprint.canonicalize(value as Schema.Json), TypeError)
    }
    assert.strictEqual(getterReads, 0)
  })

  it("preserves dangerous own keys and handles deeply nested JSON iteratively", () => {
    const dangerous: Record<string, Schema.Json> = {}
    Object.defineProperty(dangerous, "__proto__", { value: 1, enumerable: true })
    Object.defineProperty(dangerous, "constructor", { value: 2, enumerable: true })
    Object.defineProperty(dangerous, "toString", { value: 3, enumerable: true })
    assert.strictEqual(
      Fingerprint.canonicalize(dangerous),
      "{\"__proto__\":1,\"constructor\":2,\"toString\":3}"
    )

    let deep: Schema.Json = null
    for (let index = 0; index < 10_000; index++) {
      deep = { value: deep }
    }
    const canonical = Fingerprint.canonicalize(deep)
    assert.strictEqual(canonical.length, 100_004)
    assert.ok(canonical.endsWith("null" + "}".repeat(10_000)))
  })

  it.effect("materializes a strict immutable fingerprint document", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan(1))
      const document = Fingerprint.materialize(compiled)
      const decoded = yield* Schema.decodeUnknownEffect(Fingerprint.FingerprintDocument)(document)

      assert.deepStrictEqual(decoded, document)
      assert.strictEqual(document.compilerSemanticVersion, Fingerprint.CompilerSemanticVersion)
      assert.isTrue(Object.isFrozen(document))
      assert.isTrue(Object.isFrozen(document.topologicalOrder))
      assert.isTrue(Object.isFrozen(document.stages))
    }))

  it.effect("is stable for the same compiled meaning and changes with the pinned plan", () =>
    Effect.gen(function*() {
      const first = yield* Compiler.compile(definition, plan(1))
      const same = yield* Compiler.compile(definition, plan(1))
      const changed = yield* Compiler.compile(definition, plan(2))
      const firstFingerprint = yield* Fingerprint.make(first)
      const sameFingerprint = yield* Fingerprint.make(same)
      const changedFingerprint = yield* Fingerprint.make(changed)

      assert.strictEqual(firstFingerprint, sameFingerprint)
      assert.notStrictEqual(firstFingerprint, changedFingerprint)
      assert.match(firstFingerprint, /^sha256:[0-9a-f]{64}$/)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("digests arbitrary strict JSON with the same canonical hash boundary", () =>
    Effect.gen(function*() {
      const left = yield* Fingerprint.digest({ b: [2, 1], a: { value: true } })
      const reordered = yield* Fingerprint.digest({ a: { value: true }, b: [2, 1] })
      const changed = yield* Fingerprint.digest({ a: { value: true }, b: [1, 2] })

      assert.strictEqual(left, reordered)
      assert.notStrictEqual(left, changed)
      assert.deepStrictEqual(Schema.decodeUnknownSync(Fingerprint.Digest)(left), left)
      assert.throws(() => Schema.decodeUnknownSync(Fingerprint.Digest)("sha256:ABC"))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("fails when a Crypto implementation violates the SHA-256 output contract", () => {
    const invalidCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: () => Effect.succeed(new Uint8Array([1]))
    })

    return Effect.gen(function*() {
      const result = yield* Effect.result(Fingerprint.digest({ value: true }))
      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "PlatformError")
      assert.strictEqual(result.failure.reason._tag, "InvalidData")
    }).pipe(Effect.provideService(Crypto.Crypto, invalidCrypto))
  })

  it.effect("reports hostile JSON and proxied digest bytes through the typed error channel", () => {
    let getterReads = 0
    const hostile = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterReads++
        return true
      }
    })
    const proxiedCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: () => Effect.succeed(new Proxy(new Uint8Array(32), {}))
    })

    return Effect.gen(function*() {
      const invalidJson = yield* Effect.result(Fingerprint.digest(hostile as Schema.Json))
      assert.isTrue(Result.isFailure(invalidJson))
      assert.strictEqual(invalidJson.failure.reason._tag, "InvalidData")
      assert.strictEqual(getterReads, 0)

      const invalidBytes = yield* Effect.result(Fingerprint.digest({ value: true })).pipe(
        Effect.provideService(Crypto.Crypto, proxiedCrypto)
      )
      assert.isTrue(Result.isFailure(invalidBytes))
      assert.strictEqual(invalidBytes.failure.reason._tag, "InvalidData")
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })
})
