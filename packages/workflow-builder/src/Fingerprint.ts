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

/**
 * Version of the canonical fingerprint document shape.
 *
 * @category constants
 * @since 4.0.0
 */
export const FingerprintVersion = 2 as const

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
export const CompilerSemanticVersion = "3" as const

/**
 * Canonical document hashed for an admitted plan.
 *
 * **Details**
 *
 * The document contains only semantic content: presentation `metadata` is
 * stripped from the plan, its nodes, and its edges, and unordered collections
 * are sorted canonically. Moving a node on a canvas therefore cannot change a
 * fingerprint, while any change to vocabulary pins, configuration, bindings,
 * policy, wiring, or the compiled schedule does.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FingerprintDocument = Schema.Struct({
  fingerprintVersion: Schema.Literal(FingerprintVersion),
  compilerSemanticVersion: Schema.Literal(CompilerSemanticVersion),
  plan: Schema.Json,
  boundary: Schema.Json,
  topologicalOrder: Schema.Array(Schema.NonEmptyString)
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

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const stripped = <A extends { readonly metadata?: Schema.Json | undefined }>(
  value: A
): Omit<A, "metadata"> => {
  const { metadata: _metadata, ...rest } = value
  return rest
}

/**
 * Materializes the immutable canonical document for a compiled plan.
 *
 * **Details**
 *
 * Presentation `metadata` is removed at every level and nodes and edges are
 * sorted by id, so two plans differing only in layout or authoring order
 * produce the same fingerprint. The workflow boundary — input and output port
 * names, contracts, cardinality, and fan-out — is committed alongside the
 * plan because it shapes execution meaning without appearing in the plan
 * document itself.
 *
 * @category constructors
 * @since 4.0.0
 */
export const materialize = (compiled: Compiler.CompiledPlan): FingerprintDocument => {
  const document = Json.snapshot({
    fingerprintVersion: FingerprintVersion,
    compilerSemanticVersion: CompilerSemanticVersion,
    plan: {
      formatVersion: compiled.plan.formatVersion,
      id: compiled.plan.id,
      revision: compiled.plan.revision,
      definition: compiled.plan.definition,
      nodes: [...compiled.plan.nodes]
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map(stripped),
      edges: [...compiled.plan.edges]
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map(stripped)
    },
    boundary: {
      inputs: Array.from(compiled.boundary.inputs, ([name, entry]) => ({
        name,
        contract: entry.port.contract,
        required: entry.required
      })),
      outputs: Array.from(compiled.boundary.outputs, ([name, port]) => ({
        name,
        contract: port.contract,
        cardinality: port.cardinality,
        required: port.required
      }))
    },
    topologicalOrder: [...compiled.topologicalOrder]
  })
  if (Result.isFailure(document)) {
    throw new TypeError(`Cannot materialize invalid fingerprint JSON: ${document.failure.message}`)
  }
  return document.success as unknown as FingerprintDocument
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
