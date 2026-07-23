/**
 * Produces deterministic, cryptographic fingerprints for admitted workflow
 * plans.
 *
 * @since 4.0.0
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Compiler from "./Compiler.ts"
import * as Json from "./internal/json.ts"
import * as Plan from "./Plan.ts"

/**
 * Version of the canonical fingerprint document shape.
 *
 * @category constants
 * @since 4.0.0
 */
export const FingerprintVersion = 1 as const

/**
 * Version of the compiler semantics represented by a fingerprint.
 *
 * **Details**
 *
 * This value must change whenever the same admitted plan can acquire different
 * execution meaning without changing the portable plan format.
 *
 * @category constants
 * @since 4.0.0
 */
export const CompilerSemanticVersion = "1" as const

/**
 * Canonical document hashed for an admitted plan.
 *
 * **Details**
 *
 * The original portable plan captures user-authored meaning and exact version
 * pins. The compiled schedule additionally captures compiler-derived ordering.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FingerprintDocument = Schema.Struct({
  fingerprintVersion: Schema.Literal(FingerprintVersion),
  compilerSemanticVersion: Schema.Literal(CompilerSemanticVersion),
  plan: Plan.Plan,
  topologicalOrder: Schema.Array(Schema.NonEmptyString),
  stages: Schema.Array(Schema.Array(Schema.NonEmptyString))
}).annotate({
  identifier: "WorkflowFingerprintDocument",
  parseOptions: { onExcessProperty: "error" }
})

/**
 * The decoded type of {@link FingerprintDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type FingerprintDocument = Schema.Schema.Type<typeof FingerprintDocument>

/**
 * A lowercase SHA-256 digest with an explicit algorithm prefix.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Digest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/)
).annotate({ identifier: "WorkflowSha256Digest" })

/**
 * The decoded type of {@link Digest}.
 *
 * @category models
 * @since 4.0.0
 */
export type Digest = Schema.Schema.Type<typeof Digest>

/**
 * A compiled-plan fingerprint.
 *
 * @category models
 * @since 4.0.0
 */
export type Fingerprint = Digest

const invalidDigestData = (description: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "InvalidData",
    module: "Crypto",
    method: "digest",
    description
  })

/**
 * Serializes JSON with recursively sorted object keys and preserved array
 * order.
 *
 * **Details**
 *
 * Numbers and strings use ECMAScript JSON serialization. The input is first
 * detached through strict descriptor-based JSON validation, so accessors,
 * sparse arrays, unsupported values, and cyclic containers are rejected.
 *
 * @category encoding
 * @since 4.0.0
 */
export const canonicalize = (value: Schema.Json): string => {
  const canonical = Json.canonicalize(value)
  if (Result.isFailure(canonical)) {
    throw new TypeError(`Cannot canonicalize invalid JSON: ${canonical.failure.message}`)
  }
  return canonical.success
}

/**
 * Computes the canonical SHA-256 digest of strict JSON.
 *
 * @category encoding
 * @since 4.0.0
 */
export const digest = Effect.fnUntraced(function*(
  value: Schema.Json
): Effect.fn.Return<Digest, PlatformError.PlatformError, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto
  const canonical = Json.canonicalize(value)
  if (Result.isFailure(canonical)) {
    return yield* Effect.fail(invalidDigestData(
      `Input is not strict JSON: ${canonical.failure.message}`
    ))
  }
  const bytes = yield* Effect.try({
    try: () => new TextEncoder().encode(canonical.success),
    catch: () => invalidDigestData("Canonical JSON could not be encoded")
  })
  const bytesDigest = yield* crypto.digest("SHA-256", bytes)
  return yield* Effect.try({
    try: () => {
      const encoded = `sha256:${Encoding.encodeHex(bytesDigest)}`
      if (bytesDigest.byteLength !== 32 || !/^sha256:[0-9a-f]{64}$/.test(encoded)) {
        throw new TypeError("Invalid SHA-256 output")
      }
      return encoded
    },
    catch: () => invalidDigestData("SHA-256 returned a digest with an invalid length or encoding")
  })
})

/**
 * Materializes the immutable canonical document for a compiled plan.
 *
 * @category constructors
 * @since 4.0.0
 */
export const materialize = (compiled: Compiler.CompiledPlan): FingerprintDocument => {
  const document = Json.snapshot({
    fingerprintVersion: FingerprintVersion,
    compilerSemanticVersion: CompilerSemanticVersion,
    plan: compiled.plan,
    topologicalOrder: [...compiled.topologicalOrder],
    stages: compiled.stages.map((stage) => [...stage])
  })
  if (Result.isFailure(document)) {
    throw new TypeError(`Cannot materialize invalid fingerprint JSON: ${document.failure.message}`)
  }
  return document.success as FingerprintDocument
}

/**
 * Computes the SHA-256 fingerprint of a compiled plan's canonical document.
 *
 * **Details**
 *
 * The platform-independent {@link Crypto.Crypto} service makes the hashing
 * implementation explicit and replaceable in tests and runtimes.
 *
 * @category encoding
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(
  compiled: Compiler.CompiledPlan
): Effect.fn.Return<Fingerprint, PlatformError.PlatformError, Crypto.Crypto> {
  const document = materialize(compiled)
  return yield* digest(document as unknown as Schema.Json)
})
