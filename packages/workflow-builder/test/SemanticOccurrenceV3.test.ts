import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { createHash } from "node:crypto"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const document = (
  activation = 0,
  scopePath: ReadonlyArray<Occurrence.ScopeActivation> = []
) => ({
  occurrenceVersion: Occurrence.OccurrenceVersion,
  executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
  tenantId: "tenant-1",
  runId: "run-1",
  artifactDigest: digest("a"),
  nodeId: "review-document",
  scopePath,
  activation
})

describe("SemanticOccurrenceV3", () => {
  it.effect("prepares detached content-addressed static and nested occurrences", () =>
    Effect.gen(function*() {
      const staticOccurrence = yield* Occurrence.prepare(document())
      const replay = yield* Occurrence.prepare(document())
      const nextActivation = yield* Occurrence.prepare(document(1))
      const nested = yield* Occurrence.prepare(document(0, [{
        scopeActivationVersion: 1,
        scopeId: "foreach-documents",
        activation: 7
      }]))

      assert.strictEqual(
        staticOccurrence.occurrenceDigest,
        replay.occurrenceDigest
      )
      assert.notStrictEqual(
        staticOccurrence.occurrenceDigest,
        nextActivation.occurrenceDigest
      )
      assert.notStrictEqual(
        staticOccurrence.occurrenceDigest,
        nested.occurrenceDigest
      )
      assert.isTrue(Occurrence.isPrepared(staticOccurrence))
      assert.isFalse(Occurrence.isPrepared({ ...staticOccurrence }))
      assert.isTrue(Object.isFrozen(staticOccurrence))
      assert.isTrue(Object.isFrozen(staticOccurrence.document))
      assert.isTrue(Object.isFrozen(staticOccurrence.document.scopePath))
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("verifies persisted pins and rejects document substitution", () =>
    Effect.gen(function*() {
      const prepared = yield* Occurrence.prepare(document())
      const verified = yield* Occurrence.verify({
        document: prepared.document,
        occurrenceDigest: prepared.occurrenceDigest
      })
      assert.isTrue(Occurrence.isPrepared(verified))
      assert.deepStrictEqual(verified, prepared)

      const substituted = yield* Effect.exit(Occurrence.verify({
        document: {
          ...prepared.document,
          activation: 1
        },
        occurrenceDigest: prepared.occurrenceDigest
      }))
      assert(Exit.isFailure(substituted))
      assert.strictEqual(
        substituted.cause.reasons[0]?._tag,
        "Fail"
      )
      if (
        substituted.cause.reasons[0]?._tag === "Fail" &&
        substituted.cause.reasons[0].error._tag ===
          "SemanticOccurrenceError"
      ) {
        assert.strictEqual(
          substituted.cause.reasons[0].error.code,
          Occurrence.ErrorCodes.DigestMismatch
        )
      }
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("rejects hostile, excess, invalid, and unbounded documents without reading accessors", () =>
    Effect.gen(function*() {
      let reads = 0
      const hostile = {
        ...document(),
        get nodeId() {
          reads++
          return "review-document"
        }
      }
      const values = [
        hostile,
        { ...document(), forged: true },
        { ...document(), activation: -1 },
        {
          ...document(),
          scopePath: Array.from(
            { length: Occurrence.MaximumScopeDepth + 1 },
            (_, activation) => ({
              scopeActivationVersion: 1,
              scopeId: "scope",
              activation
            })
          )
        },
        { ...document(), nodeId: "\ud800" }
      ]

      for (const value of values) {
        const rejected = yield* Effect.exit(Occurrence.prepare(value))
        assert(Exit.isFailure(rejected))
      }
      assert.strictEqual(reads, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("domain-separates occurrence identities from artifact bytes", () =>
    Effect.gen(function*() {
      const prepared = yield* Occurrence.prepare(document())
      const artifactLike = yield* Crypto.Crypto.pipe(
        Effect.flatMap((service) =>
          service.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(document()))
          )
        )
      )
      assert.notStrictEqual(
        prepared.occurrenceDigest,
        `sha256:${Buffer.from(artifactLike).toString("hex")}`
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))
})
