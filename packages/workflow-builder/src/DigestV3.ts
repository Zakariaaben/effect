/**
 * Domain-separated canonical content identities for execution protocol
 * version `3`.
 *
 * **Details**
 *
 * Every role hashes a versioned envelope rather than the supplied JSON value
 * directly. Equal JSON in two roles therefore has different content identity.
 * Inputs first cross the package's bounded, descriptor-based strict-JSON
 * snapshot boundary; accessors are never evaluated and caller-owned
 * containers are never retained across the cryptographic effect.
 *
 * @since 4.0.0
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Bytes from "./internal/bytes.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the protocol-v3 digest envelope.
 *
 * **Details**
 *
 * This version is independent from the execution protocol and must change if
 * the canonical preimage shape changes.
 *
 * @category constants
 * @since 4.0.0
 */
export const DigestProtocolVersion = 1 as const

/**
 * Audited protocol-v3 content-identity domains.
 *
 * @category constants
 * @since 4.0.0
 */
export const Domains = {
  Artifact: "workflow.artifact.v3",
  CompiledPlan: "workflow.compiled-plan.compiler-v2",
  BoundaryContract: "workflow.boundary-contract.v3",
  ExecutableBuild: "workflow.executable-build.v3",
  EncodedSchema: "workflow.encoded-schema.v3"
} as const

const DomainSchema = Schema.Literals([
  Domains.Artifact,
  Domains.CompiledPlan,
  Domains.BoundaryContract,
  Domains.ExecutableBuild,
  Domains.EncodedSchema
]).annotate({ identifier: "WorkflowDigestV3Domain" })

/**
 * One audited protocol-v3 digest role.
 *
 * @category models
 * @since 4.0.0
 */
export type Domain = Schema.Schema.Type<typeof DomainSchema>

/**
 * Stable failure reasons for the cryptographic digest boundary.
 *
 * @category constants
 * @since 4.0.0
 */
export const CryptoFailureCodes = {
  CanonicalEncodingFailed: "CanonicalEncodingFailed",
  DigestFailed: "DigestFailed",
  InvalidDigestOutput: "InvalidDigestOutput"
} as const

const CryptoFailureCodeSchema = Schema.Literals([
  CryptoFailureCodes.CanonicalEncodingFailed,
  CryptoFailureCodes.DigestFailed,
  CryptoFailureCodes.InvalidDigestOutput
]).annotate({ identifier: "WorkflowDigestV3CryptoFailureCode" })

/**
 * A stable failure reason for the cryptographic digest boundary.
 *
 * @category models
 * @since 4.0.0
 */
export type CryptoFailureCode = Schema.Schema.Type<
  typeof CryptoFailureCodeSchema
>

/**
 * Raised when a digest input cannot cross the bounded strict-JSON boundary.
 *
 * @category errors
 * @since 4.0.0
 */
export class DigestInputError extends Schema.TaggedErrorClass<DigestInputError>(
  "@effect/workflow-builder/DigestV3/DigestInputError"
)("DigestInputError", {
  domain: DomainSchema,
  message: Schema.NonEmptyString,
  path: Schema.Array(Schema.Union([
    Schema.String,
    Wire.NonNegativeSafeInt
  ]))
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when canonical bytes cannot be encoded, SHA-256 fails, or the
 * configured cryptographic service returns an invalid SHA-256 value.
 *
 * @category errors
 * @since 4.0.0
 */
export class DigestCryptoError extends Schema.TaggedErrorClass<DigestCryptoError>(
  "@effect/workflow-builder/DigestV3/DigestCryptoError"
)("DigestCryptoError", {
  domain: DomainSchema,
  code: CryptoFailureCodeSchema,
  message: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * A versioned, domain-separated canonical digest envelope.
 *
 * @category models
 * @since 4.0.0
 */
export interface Preimage {
  readonly digestProtocolVersion: typeof DigestProtocolVersion
  readonly domain: Domain
  readonly value: Schema.Json
}

const inputError = (
  domain: Domain,
  message: string,
  path: ReadonlyArray<string | number>
): DigestInputError =>
  new DigestInputError({
    domain,
    message,
    path: [...path]
  })

const cryptoError = (
  domain: Domain,
  code: CryptoFailureCode,
  message: string
): DigestCryptoError =>
  new DigestCryptoError({
    domain,
    code,
    message
  })

const digest = Effect.fnUntraced(function*(
  domain: Domain,
  input: unknown
): Effect.fn.Return<
  Wire.Sha256Digest,
  DigestInputError | DigestCryptoError,
  Crypto.Crypto
> {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return yield* Effect.fail(inputError(
      domain,
      `Digest input must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }

  const preimage: Preimage = {
    digestProtocolVersion: DigestProtocolVersion,
    domain,
    value: snapshot.success
  }
  const canonical = Json.canonicalizeSnapshot(
    preimage as unknown as Schema.Json
  )
  const bytes = yield* Effect.try({
    try: () => new TextEncoder().encode(canonical),
    catch: () =>
      cryptoError(
        domain,
        CryptoFailureCodes.CanonicalEncodingFailed,
        "Canonical digest preimage could not be encoded as UTF-8"
      )
  })

  const crypto = yield* Crypto.Crypto
  const output = yield* crypto.digest("SHA-256", bytes).pipe(
    Effect.mapError(() =>
      cryptoError(
        domain,
        CryptoFailureCodes.DigestFailed,
        "SHA-256 digest computation failed"
      )
    )
  )

  return yield* Effect.try({
    try: () => {
      const detached = Bytes.copyUint8Array(output)
      if (detached.byteLength !== 32) {
        throw new TypeError("SHA-256 output must contain exactly 32 bytes")
      }
      const encoded = `sha256:${Encoding.encodeHex(detached)}`
      if (!/^sha256:[0-9a-f]{64}$/.test(encoded)) {
        throw new TypeError("SHA-256 output has a non-canonical encoding")
      }
      return encoded as Wire.Sha256Digest
    },
    catch: () =>
      cryptoError(
        domain,
        CryptoFailureCodes.InvalidDigestOutput,
        "SHA-256 returned an invalid digest value"
      )
  })
})

/**
 * Computes the content identity of a complete protocol-v3 durable artifact.
 *
 * @category encoding
 * @since 4.0.0
 */
export const artifact = (
  value: unknown
): Effect.Effect<
  Wire.ArtifactDigest,
  DigestInputError | DigestCryptoError,
  Crypto.Crypto
> =>
  digest(Domains.Artifact, value) as Effect.Effect<
    Wire.ArtifactDigest,
    DigestInputError | DigestCryptoError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of a compiler-semantic-version-2 canonical
 * fingerprint document.
 *
 * @category encoding
 * @since 4.0.0
 */
export const compiledPlan = (
  value: unknown
): Effect.Effect<
  Wire.CompiledFingerprint,
  DigestInputError | DigestCryptoError,
  Crypto.Crypto
> =>
  digest(Domains.CompiledPlan, value) as Effect.Effect<
    Wire.CompiledFingerprint,
    DigestInputError | DigestCryptoError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one portable input or output boundary
 * contract.
 *
 * @category encoding
 * @since 4.0.0
 */
export const boundaryContract = (
  value: unknown
): Effect.Effect<
  Wire.ContractDigest,
  DigestInputError | DigestCryptoError,
  Crypto.Crypto
> =>
  digest(Domains.BoundaryContract, value) as Effect.Effect<
    Wire.ContractDigest,
    DigestInputError | DigestCryptoError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one immutable executable build descriptor.
 *
 * @category encoding
 * @since 4.0.0
 */
export const executableBuild = (
  value: unknown
): Effect.Effect<
  Wire.BuildDigest,
  DigestInputError | DigestCryptoError,
  Crypto.Crypto
> =>
  digest(Domains.ExecutableBuild, value) as Effect.Effect<
    Wire.BuildDigest,
    DigestInputError | DigestCryptoError,
    Crypto.Crypto
  >

/**
 * Computes the content identity of one inspectable encoded-schema document.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodedSchema = (
  value: unknown
): Effect.Effect<
  Wire.SchemaDigest,
  DigestInputError | DigestCryptoError,
  Crypto.Crypto
> =>
  digest(Domains.EncodedSchema, value) as Effect.Effect<
    Wire.SchemaDigest,
    DigestInputError | DigestCryptoError,
    Crypto.Crypto
  >
