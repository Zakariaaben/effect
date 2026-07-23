/**
 * Domain-separated canonical digests for execution protocol version `2`.
 *
 * **Details**
 *
 * Digest strings share one wire spelling, but their preimages do not. Every
 * JSON digest commits to a versioned domain tag as well as the strict JSON
 * value. This prevents an identical JSON value used in two protocol roles from
 * acquiring the same content identity accidentally.
 *
 * @since 4.0.0
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as PlatformError from "effect/PlatformError"
import type * as Schema from "effect/Schema"
import * as Fingerprint from "./Fingerprint.ts"
import * as Bytes from "./internal/bytes.ts"
import type * as Wire from "./ProtocolV2Wire.ts"

/**
 * Version of the domain-separated JSON digest preimage.
 *
 * @category constants
 * @since 4.0.0
 */
export const DigestProtocolVersion = 1 as const

/**
 * Stable protocol domains for canonical JSON content identities.
 *
 * @category constants
 * @since 4.0.0
 */
export const Domains = {
  Artifact: "workflow.artifact.v2",
  CompiledPlan: "workflow.compiled-plan.v2",
  Payload: "workflow.payload.v2",
  Request: "workflow.signal-request.v2",
  Build: "workflow.executable-build.v2",
  BpmnExecutable: "workflow.bpmn-executable.v2",
  Definition: "workflow.definition.v2",
  Schema: "workflow.encoded-schema.v2",
  History: "workflow.history.v2"
} as const

/**
 * A stable canonical JSON digest domain.
 *
 * @category models
 * @since 4.0.0
 */
export type Domain = typeof Domains[keyof typeof Domains]

/**
 * Versioned domain-separated document hashed for one strict JSON value.
 *
 * @category models
 * @since 4.0.0
 */
export interface Preimage {
  readonly digestProtocolVersion: typeof DigestProtocolVersion
  readonly domain: Domain
  readonly value: Schema.Json
}

/**
 * Materializes the canonical document used for a protocol version `2` digest.
 *
 * **Details**
 *
 * Strict JSON inspection and detachment occur inside the digest operation.
 * This constructor deliberately performs no unsafe traversal itself.
 *
 * @category constructors
 * @since 4.0.0
 */
export const preimage = (
  domain: Domain,
  value: Schema.Json
): Preimage => ({
  digestProtocolVersion: DigestProtocolVersion,
  domain,
  value
})

const digest = Effect.fnUntraced(function*(
  domain: Domain,
  value: Schema.Json
): Effect.fn.Return<
  Wire.Sha256Digest,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return yield* Fingerprint.digest(
    preimage(domain, value) as unknown as Schema.Json
  )
})

/**
 * Computes the content identity of a complete protocol version `2` artifact.
 *
 * @category encoding
 * @since 4.0.0
 */
export const artifact = (
  value: Schema.Json
): Effect.Effect<
  Wire.ArtifactDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.Artifact, value) as Effect.Effect<
    Wire.ArtifactDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of a compiled protocol version `2` plan.
 *
 * @category encoding
 * @since 4.0.0
 */
export const compiledPlan = (
  value: Schema.Json
): Effect.Effect<
  Wire.CompiledFingerprint,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.CompiledPlan, value) as Effect.Effect<
    Wire.CompiledFingerprint,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one canonical codec-encoded payload.
 *
 * @category encoding
 * @since 4.0.0
 */
export const payload = (
  value: Schema.Json
): Effect.Effect<
  Wire.PayloadDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.Payload, value) as Effect.Effect<
    Wire.PayloadDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one normalized signal ingress request.
 *
 * @category encoding
 * @since 4.0.0
 */
export const request = (
  value: Schema.Json
): Effect.Effect<
  Wire.RequestDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.Request, value) as Effect.Effect<
    Wire.RequestDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one executable build descriptor.
 *
 * @category encoding
 * @since 4.0.0
 */
export const build = (
  value: Schema.Json
): Effect.Effect<
  Wire.BuildDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.Build, value) as Effect.Effect<
    Wire.BuildDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one executable BPMN model and profile.
 *
 * @category encoding
 * @since 4.0.0
 */
export const bpmnExecutable = (
  value: Schema.Json
): Effect.Effect<
  Wire.BpmnExecutableFingerprint,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.BpmnExecutable, value) as Effect.Effect<
    Wire.BpmnExecutableFingerprint,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one portable semantic definition.
 *
 * @category encoding
 * @since 4.0.0
 */
export const definition = (
  value: Schema.Json
): Effect.Effect<
  Wire.DefinitionDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.Definition, value) as Effect.Effect<
    Wire.DefinitionDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one inspectable encoded-schema document.
 *
 * @category encoding
 * @since 4.0.0
 */
export const schema = (
  value: Schema.Json
): Effect.Effect<
  Wire.SchemaDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.Schema, value) as Effect.Effect<
    Wire.SchemaDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one complete canonical history snapshot.
 *
 * @category encoding
 * @since 4.0.0
 */
export const history = (
  value: Schema.Json
): Effect.Effect<
  Wire.HistoryDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  digest(Domains.History, value) as Effect.Effect<
    Wire.HistoryDigest,
    PlatformError.PlatformError,
    Crypto.Crypto
  >

/**
 * Computes the raw-byte content identity of one immutable blob.
 *
 * **Details**
 *
 * Blob references intentionally use the conventional SHA-256 of the exact
 * stored bytes so an independent object store can verify them without parsing
 * workflow JSON. JSON role digests above remain domain separated.
 *
 * @category encoding
 * @since 4.0.0
 */
export const blob = Effect.fnUntraced(function*(
  bytes: Uint8Array
): Effect.fn.Return<
  Wire.BlobDigest,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  const crypto = yield* Crypto.Crypto
  const snapshot = yield* Effect.try({
    try: () => {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Blob input is not a Uint8Array")
      }
      return Bytes.copyUint8Array(bytes)
    },
    catch: () =>
      PlatformError.systemError({
        _tag: "InvalidData",
        module: "Crypto",
        method: "digest",
        description: "Blob bytes could not be snapshotted safely"
      })
  })
  const hashed = yield* crypto.digest("SHA-256", snapshot)
  return yield* Effect.try({
    try: () => {
      const encoded = `sha256:${Encoding.encodeHex(hashed)}`
      if (
        hashed.byteLength !== 32 ||
        !/^sha256:[0-9a-f]{64}$/.test(encoded)
      ) {
        throw new TypeError("Invalid SHA-256 output")
      }
      return encoded as Wire.BlobDigest
    },
    catch: () =>
      PlatformError.systemError({
        _tag: "InvalidData",
        module: "Crypto",
        method: "digest",
        description: "SHA-256 returned an invalid blob digest"
      })
  })
})
