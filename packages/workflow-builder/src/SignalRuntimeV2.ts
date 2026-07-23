/**
 * Exact process-local signal codecs and authorization policies for execution
 * protocol version `2`.
 *
 * **Details**
 *
 * Portable workflow artifacts retain only JSON definitions and immutable pins.
 * This module binds those pins to application-owned `Schema` codecs and policy
 * functions. It performs no admission transaction, persistence, clock access,
 * event construction, blob retrieval, or hashing.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as SignalContractV2 from "./SignalContractV2.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const definitions = new WeakSet<object>()
const registries = new WeakSet<object>()
const trustedActors = new WeakSet<object>()
const blobRequirements = new WeakMap<object, ResolvedSignalRuntime>()

const RuntimePins = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  definitionDigest: ProtocolV2Wire.DefinitionDigest,
  payloadCodec: SignalContractV2.CodecPin,
  authorizationPolicy: SignalContractV2.BuildPin
}).annotate({
  identifier: "WorkflowSignalRuntimePinsV2",
  parseOptions: strictParseOptions
})

interface RuntimePins extends Schema.Schema.Type<typeof RuntimePins> {}

const decodeRuntimePins = Schema.decodeUnknownResult(RuntimePins, strictParseOptions)
const decodeCatalogEntry = Schema.decodeUnknownResult(
  SignalContractV2.SignalCatalogEntry,
  strictParseOptions
)
const decodeDecisionId = Schema.decodeUnknownResult(Schema.NonEmptyString)
const decodeActorId = Schema.decodeUnknownResult(Schema.NonEmptyString)
const decodeEncodedPayload = Schema.decodeUnknownResult(
  ProtocolV2Wire.EncodedPayload,
  strictParseOptions
)

/**
 * A signal payload codec whose persisted representation is strict JSON.
 *
 * **Details**
 *
 * The runtime still snapshots every actual encoded value because custom
 * schemas and unsafe type assertions can violate this declaration.
 *
 * @category models
 * @since 4.0.0
 */
export interface SignalPayloadSchema extends Schema.Top {
  readonly Encoded: Schema.Json
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/**
 * Trusted, process-local actor material supplied to an authorization policy.
 *
 * **Details**
 *
 * Instances can only be created by {@link makeTrustedActor}. Claims and
 * context are deliberately non-enumerable, so ordinary JSON serialization can
 * retain the declared nonsecret actor identifier but cannot accidentally copy
 * authentication material into history or an error.
 *
 * @category models
 * @since 4.0.0
 */
export interface TrustedActorContext<
  out Claims = unknown,
  out ActorContext = unknown
> {
  readonly actorId: string
  readonly claims: Claims
  readonly context: ActorContext
}

/**
 * Raised when trusted actor material has an invalid public identity.
 *
 * **Details**
 *
 * The error deliberately does not retain the rejected value, claims, or
 * context.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidTrustedActor extends Schema.TaggedErrorClass<InvalidTrustedActor>(
  "@effect/workflow-builder/SignalRuntimeV2/InvalidTrustedActor"
)("InvalidTrustedActor", {
  code: Schema.Literal("InvalidActorId")
}, { parseOptions: strictParseOptions }) {}

/**
 * Input supplied to one exact authorization policy.
 *
 * @category models
 * @since 4.0.0
 */
export interface AuthorizationRequest<
  out Payload = unknown,
  out Claims = unknown,
  out ActorContext = unknown
> {
  readonly actor: TrustedActorContext<Claims, ActorContext>
  readonly payload: Payload
}

/**
 * A typed, nonsecret policy denial.
 *
 * **Details**
 *
 * `reasonCode` and the optional decision identifier are application-owned
 * stable identifiers. The error intentionally has no arbitrary message,
 * claims, credentials, payload, or cause field.
 *
 * @category errors
 * @since 4.0.0
 */
export class AuthorizationDenied extends Schema.TaggedErrorClass<AuthorizationDenied>(
  "@effect/workflow-builder/SignalRuntimeV2/AuthorizationDenied"
)("AuthorizationDenied", {
  reasonCode: Schema.NonEmptyString,
  policyDecisionId: Schema.optionalKey(Schema.NonEmptyString)
}, { parseOptions: strictParseOptions }) {}

/**
 * A typed transient inability to evaluate an authorization policy.
 *
 * **Details**
 *
 * Only a stable nonsecret reason code crosses the boundary. Operational causes
 * remain in the policy implementation's private telemetry.
 *
 * @category errors
 * @since 4.0.0
 */
export class AuthorizationUnavailable extends Schema.TaggedErrorClass<AuthorizationUnavailable>(
  "@effect/workflow-builder/SignalRuntimeV2/AuthorizationUnavailable"
)("AuthorizationUnavailable", {
  reasonCode: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * An application-owned exact authorization implementation.
 *
 * **Details**
 *
 * Policies are service-closed functions. Applications that require Effect
 * services construct the definition inside their layer and close over the
 * acquired service values, keeping registry resolution independent of a
 * changing ambient context.
 *
 * @category models
 * @since 4.0.0
 */
export type AuthorizationPolicy<Payload> = (
  request: AuthorizationRequest<Payload>
) => Effect.Effect<string, AuthorizationDenied | AuthorizationUnavailable>

/**
 * Runtime configuration for one exact signal payload codec.
 *
 * @category models
 * @since 4.0.0
 */
export interface RuntimePayloadCodec<out PayloadSchema extends SignalPayloadSchema> {
  readonly pin: SignalContractV2.CodecPin
  readonly schema: PayloadSchema
}

/**
 * Runtime configuration for one exact authorization policy.
 *
 * @category models
 * @since 4.0.0
 */
export interface RuntimeAuthorizationPolicy<Payload> {
  readonly pin: SignalContractV2.BuildPin
  readonly authorize: AuthorizationPolicy<Payload>
}

/**
 * Application input used to construct one runtime signal definition.
 *
 * @category models
 * @since 4.0.0
 */
export interface SignalRuntimeDefinitionOptions<
  out Name extends string,
  out Version extends string,
  PayloadSchema extends SignalPayloadSchema
> {
  readonly name: Name
  readonly version: Version
  readonly definitionDigest: ProtocolV2Wire.DefinitionDigest
  readonly payloadCodec: RuntimePayloadCodec<PayloadSchema>
  readonly authorizationPolicy: RuntimeAuthorizationPolicy<PayloadSchema["Type"]>
}

/**
 * One application-owned codec and policy implementation under exact portable
 * signal pins.
 *
 * @category models
 * @since 4.0.0
 */
export interface SignalRuntimeDefinition<
  out Name extends string,
  out Version extends string,
  PayloadSchema extends SignalPayloadSchema
> {
  readonly name: Name
  readonly version: Version
  readonly definitionDigest: ProtocolV2Wire.DefinitionDigest
  readonly payloadCodec: RuntimePayloadCodec<PayloadSchema>
  readonly authorizationPolicy: RuntimeAuthorizationPolicy<PayloadSchema["Type"]>
}

/**
 * Type-erased runtime signal definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type AnySignalRuntimeDefinition = SignalRuntimeDefinition<
  string,
  string,
  SignalPayloadSchema
>

/**
 * The decoded payload type of one runtime signal definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Payload<D extends AnySignalRuntimeDefinition> = D["payloadCodec"]["schema"]["Type"]

/**
 * Services required to decode and encode a runtime signal definition.
 *
 * @category utility types
 * @since 4.0.0
 */
export type CodecServices<D extends AnySignalRuntimeDefinition> =
  | D["payloadCodec"]["schema"]["DecodingServices"]
  | D["payloadCodec"]["schema"]["EncodingServices"]

/**
 * Stable construction and resolution failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const InvalidRuntimeCodes = {
  InvalidOptions: "InvalidOptions",
  InvalidDefinition: "InvalidDefinition",
  InvalidCatalogEntry: "InvalidCatalogEntry",
  UnsafeInspection: "UnsafeInspection"
} as const

/**
 * Stable construction and resolution failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type InvalidRuntimeCode = typeof InvalidRuntimeCodes[keyof typeof InvalidRuntimeCodes]

const InvalidRuntimeCode = Schema.Literals([
  InvalidRuntimeCodes.InvalidOptions,
  InvalidRuntimeCodes.InvalidDefinition,
  InvalidRuntimeCodes.InvalidCatalogEntry,
  InvalidRuntimeCodes.UnsafeInspection
])

/**
 * Raised when runtime configuration or an exact resolution request is unsafe
 * or malformed.
 *
 * @category errors
 * @since 4.0.0
 */
export class InvalidSignalRuntime extends Schema.TaggedErrorClass<InvalidSignalRuntime>(
  "@effect/workflow-builder/SignalRuntimeV2/InvalidSignalRuntime"
)("InvalidSignalRuntime", {
  operation: Schema.Literals(["define", "build", "resolve"]),
  code: InvalidRuntimeCode,
  index: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt),
  name: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.optionalKey(Schema.NonEmptyString)
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a registry declares one signal name and version more than once.
 *
 * @category errors
 * @since 4.0.0
 */
export class DuplicateSignalRuntimeDefinition extends Schema.TaggedErrorClass<
  DuplicateSignalRuntimeDefinition
>("@effect/workflow-builder/SignalRuntimeV2/DuplicateSignalRuntimeDefinition")(
  "DuplicateSignalRuntimeDefinition",
  {
    name: Schema.NonEmptyString,
    version: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Raised when no runtime entry exists for an exact persisted signal identity.
 *
 * @category errors
 * @since 4.0.0
 */
export class SignalRuntimeNotFound extends Schema.TaggedErrorClass<SignalRuntimeNotFound>(
  "@effect/workflow-builder/SignalRuntimeV2/SignalRuntimeNotFound"
)("SignalRuntimeNotFound", {
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString
}, { parseOptions: strictParseOptions }) {}

/**
 * Raised when a runtime entry exists under the requested name and version but
 * any immutable persisted pin differs.
 *
 * @category errors
 * @since 4.0.0
 */
export class SignalRuntimePinMismatch extends Schema.TaggedErrorClass<SignalRuntimePinMismatch>(
  "@effect/workflow-builder/SignalRuntimeV2/SignalRuntimePinMismatch"
)("SignalRuntimePinMismatch", {
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  field: Schema.NonEmptyString,
  expected: Schema.String,
  actual: Schema.String
}, { parseOptions: strictParseOptions }) {}

/**
 * Failures produced while constructing a runtime registry.
 *
 * @category errors
 * @since 4.0.0
 */
export type RegistryBuildError =
  | InvalidSignalRuntime
  | DuplicateSignalRuntimeDefinition

/**
 * Failures produced while resolving a persisted signal definition.
 *
 * @category errors
 * @since 4.0.0
 */
export type ResolutionError =
  | InvalidSignalRuntime
  | SignalRuntimeNotFound
  | SignalRuntimePinMismatch

/**
 * One exact pairing of a persisted JSON definition and its runtime code.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedSignalRuntime<
  out Definition extends AnySignalRuntimeDefinition = AnySignalRuntimeDefinition
> {
  readonly runtime: Definition
  readonly persisted: SignalContractV2.SignalCatalogEntry
}

/**
 * Stable payload boundary failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const PayloadErrorCodes = {
  InvalidEnvelope: "InvalidEnvelope",
  PayloadTooLarge: "PayloadTooLarge",
  DecodeFailed: "DecodeFailed",
  EncodeFailed: "EncodeFailed",
  NonJsonEncoding: "NonJsonEncoding",
  CanonicalizationFailed: "CanonicalizationFailed",
  BlobRequirementMismatch: "BlobRequirementMismatch"
} as const

/**
 * Stable payload boundary failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadErrorCode = typeof PayloadErrorCodes[keyof typeof PayloadErrorCodes]

const PayloadErrorCode = Schema.Literals([
  PayloadErrorCodes.InvalidEnvelope,
  PayloadErrorCodes.PayloadTooLarge,
  PayloadErrorCodes.DecodeFailed,
  PayloadErrorCodes.EncodeFailed,
  PayloadErrorCodes.NonJsonEncoding,
  PayloadErrorCodes.CanonicalizationFailed,
  PayloadErrorCodes.BlobRequirementMismatch
])

/**
 * Raised when an encoded signal payload cannot safely cross its exact runtime
 * codec boundary.
 *
 * **Details**
 *
 * This error contains only identity, phase, reason, and optional byte counts.
 * It never retains the hostile payload or decoded application value.
 *
 * @category errors
 * @since 4.0.0
 */
export class SignalPayloadError extends Schema.TaggedErrorClass<SignalPayloadError>(
  "@effect/workflow-builder/SignalRuntimeV2/SignalPayloadError"
)("SignalPayloadError", {
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  phase: Schema.Literals(["envelope", "decode", "encode", "snapshot", "blob"]),
  code: PayloadErrorCode,
  maximumBytes: Schema.optionalKey(ProtocolV2Wire.PositiveSafeInt),
  actualBytes: Schema.optionalKey(ProtocolV2Wire.NonNegativeSafeInt)
}, { parseOptions: strictParseOptions }) {}

/**
 * A strict, detached payload after decode and deterministic re-encoding through
 * its exact runtime codec.
 *
 * @category models
 * @since 4.0.0
 */
export interface DecodedPayload<out A = unknown> {
  readonly _tag: "DecodedPayload"
  readonly source: "Inline" | "Blob"
  readonly value: A
  readonly encoded: Schema.Json
  readonly canonicalEncoded: string
  readonly encodedBytes: number
  readonly payload: ProtocolV2Wire.EncodedPayload
}

/**
 * Explicit work handed to a trusted blob authority.
 *
 * **Details**
 *
 * This module never follows the reference. The authority must load the bytes,
 * verify size and digest, parse strict JSON, and only then call
 * {@link decodeVerifiedBlob}. The requirement is bound to the exact resolved
 * runtime that created it.
 *
 * @category models
 * @since 4.0.0
 */
export interface BlobResolutionRequired {
  readonly _tag: "BlobResolutionRequired"
  readonly ref: ProtocolV2Wire.BlobRef
  readonly definitionDigest: ProtocolV2Wire.DefinitionDigest
  readonly maximumEncodedBytes: number
}

/**
 * Result of inspecting and decoding an encoded signal payload.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadResult<A = unknown> =
  | DecodedPayload<A>
  | BlobResolutionRequired

/**
 * Exact runtime signal lookup used by a signal ingress authority.
 *
 * @category services
 * @since 4.0.0
 */
export class SignalRuntimeRegistry extends Context.Service<
  SignalRuntimeRegistry,
  SignalRuntimeRegistry.Service
>()("@effect/workflow-builder/SignalRuntimeV2/Registry") {}

/**
 * Service contracts for {@link SignalRuntimeRegistry}.
 *
 * @since 4.0.0
 */
export declare namespace SignalRuntimeRegistry {
  /**
   * Exact runtime registry service shape.
   *
   * @category services
   * @since 4.0.0
   */
  export interface Service {
    readonly size: number
    readonly resolve: (
      persisted: SignalContractV2.SignalCatalogEntry
    ) => Effect.Effect<ResolvedSignalRuntime, ResolutionError>
  }
}

interface CapturedDefinitionOptions {
  readonly name: unknown
  readonly version: unknown
  readonly definitionDigest: unknown
  readonly payloadCodec: {
    readonly pin: unknown
    readonly schema: unknown
  }
  readonly authorizationPolicy: {
    readonly pin: unknown
    readonly authorize: unknown
  }
}

const invalid = (
  operation: InvalidSignalRuntime["operation"],
  code: InvalidRuntimeCode,
  options: {
    readonly index?: number | undefined
    readonly name?: string | undefined
    readonly version?: string | undefined
  } = {}
): InvalidSignalRuntime =>
  new InvalidSignalRuntime({
    operation,
    code,
    ...(options.index === undefined ? undefined : { index: options.index }),
    ...(options.name === undefined ? undefined : { name: options.name }),
    ...(options.version === undefined ? undefined : { version: options.version })
  })

const ownData = (
  descriptors: { readonly [key: string]: PropertyDescriptor | undefined },
  property: string
): PropertyDescriptor | undefined => {
  const descriptor = descriptors[property]
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor
    : undefined
}

const capturePair = (
  input: unknown,
  first: string,
  second: string
): Result.Result<readonly [unknown, unknown], InvalidSignalRuntime> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidOptions))
    }
    const prototype = Object.getPrototypeOf(input)
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const firstDescriptor = ownData(descriptors, first)
    const secondDescriptor = ownData(descriptors, second)
    if (
      prototype !== Object.prototype && prototype !== null ||
      Reflect.ownKeys(descriptors).length !== 2 ||
      firstDescriptor === undefined ||
      secondDescriptor === undefined ||
      firstDescriptor.enumerable !== true ||
      secondDescriptor.enumerable !== true
    ) {
      return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidOptions))
    }
    return Result.succeed([firstDescriptor.value, secondDescriptor.value] as const)
  } catch {
    return Result.fail(invalid("define", InvalidRuntimeCodes.UnsafeInspection))
  }
}

const captureDefinitionOptions = (
  input: unknown
): Result.Result<CapturedDefinitionOptions, InvalidSignalRuntime> => {
  try {
    if (typeof input !== "object" || input === null) {
      return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidOptions))
    }
    const prototype = Object.getPrototypeOf(input)
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const name = ownData(descriptors, "name")
    const version = ownData(descriptors, "version")
    const definitionDigest = ownData(descriptors, "definitionDigest")
    const payloadCodec = ownData(descriptors, "payloadCodec")
    const authorizationPolicy = ownData(descriptors, "authorizationPolicy")
    if (
      prototype !== Object.prototype && prototype !== null ||
      Reflect.ownKeys(descriptors).length !== 5 ||
      name === undefined ||
      version === undefined ||
      definitionDigest === undefined ||
      payloadCodec === undefined ||
      authorizationPolicy === undefined ||
      name.enumerable !== true ||
      version.enumerable !== true ||
      definitionDigest.enumerable !== true ||
      payloadCodec.enumerable !== true ||
      authorizationPolicy.enumerable !== true
    ) {
      return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidOptions))
    }
    const codecPair = capturePair(payloadCodec.value, "pin", "schema")
    if (Result.isFailure(codecPair)) {
      return Result.fail(codecPair.failure)
    }
    const policyPair = capturePair(authorizationPolicy.value, "pin", "authorize")
    if (Result.isFailure(policyPair)) {
      return Result.fail(policyPair.failure)
    }
    return Result.succeed({
      name: name.value,
      version: version.value,
      definitionDigest: definitionDigest.value,
      payloadCodec: {
        pin: codecPair.success[0],
        schema: codecPair.success[1]
      },
      authorizationPolicy: {
        pin: policyPair.success[0],
        authorize: policyPair.success[1]
      }
    })
  } catch {
    return Result.fail(invalid("define", InvalidRuntimeCodes.UnsafeInspection))
  }
}

const buildDefinition = <
  const Name extends string,
  const Version extends string,
  PayloadSchema extends SignalPayloadSchema
>(
  input: SignalRuntimeDefinitionOptions<Name, Version, PayloadSchema>
): Result.Result<
  SignalRuntimeDefinition<Name, Version, PayloadSchema>,
  InvalidSignalRuntime
> => {
  const captured = captureDefinitionOptions(input)
  if (Result.isFailure(captured)) {
    return Result.fail(captured.failure)
  }
  let validSchema: boolean
  try {
    validSchema = Schema.isSchema(captured.success.payloadCodec.schema)
  } catch {
    return Result.fail(invalid("define", InvalidRuntimeCodes.UnsafeInspection))
  }
  if (
    !validSchema ||
    typeof captured.success.authorizationPolicy.authorize !== "function"
  ) {
    return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidDefinition))
  }
  const pinsSnapshot = Json.snapshot({
    name: captured.success.name,
    version: captured.success.version,
    definitionDigest: captured.success.definitionDigest,
    payloadCodec: captured.success.payloadCodec.pin,
    authorizationPolicy: captured.success.authorizationPolicy.pin
  })
  if (Result.isFailure(pinsSnapshot)) {
    return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidDefinition))
  }
  let decoded: Result.Result<RuntimePins, unknown>
  try {
    decoded = decodeRuntimePins(pinsSnapshot.success)
  } catch {
    return Result.fail(invalid("define", InvalidRuntimeCodes.UnsafeInspection))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(invalid("define", InvalidRuntimeCodes.InvalidDefinition))
  }
  const pins = pinsSnapshot.success as unknown as RuntimePins
  const definition = Object.freeze({
    name: pins.name as Name,
    version: pins.version as Version,
    definitionDigest: pins.definitionDigest,
    payloadCodec: Object.freeze({
      pin: pins.payloadCodec,
      schema: captured.success.payloadCodec.schema as PayloadSchema
    }),
    authorizationPolicy: Object.freeze({
      pin: pins.authorizationPolicy,
      authorize: captured.success.authorizationPolicy.authorize as AuthorizationPolicy<
        PayloadSchema["Type"]
      >
    })
  })
  definitions.add(definition)
  return Result.succeed(definition)
}

/**
 * Constructs a runtime signal definition while retaining invalid
 * configuration as typed data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromDefinition = <
  const Name extends string,
  const Version extends string,
  PayloadSchema extends SignalPayloadSchema
>(
  options: SignalRuntimeDefinitionOptions<Name, Version, PayloadSchema>
): Result.Result<
  SignalRuntimeDefinition<Name, Version, PayloadSchema>,
  InvalidSignalRuntime
> => buildDefinition(options)

/**
 * Constructs one application-owned runtime signal definition.
 *
 * **Details**
 *
 * Invalid static configuration throws {@link InvalidSignalRuntime}. Use
 * {@link fromDefinition} when definitions are discovered dynamically and the
 * failure must remain typed data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeDefinition = <
  const Name extends string,
  const Version extends string,
  PayloadSchema extends SignalPayloadSchema
>(
  options: SignalRuntimeDefinitionOptions<Name, Version, PayloadSchema>
): SignalRuntimeDefinition<Name, Version, PayloadSchema> => {
  const result = buildDefinition(options)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

/**
 * Tests whether a value is an exact runtime definition constructed here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSignalRuntimeDefinition = (
  value: unknown
): value is AnySignalRuntimeDefinition => typeof value === "object" && value !== null && definitions.has(value)

const buildTrustedActor = <Claims, ActorContext>(
  actorId: string,
  claims: Claims,
  context: ActorContext
): Result.Result<TrustedActorContext<Claims, ActorContext>, InvalidTrustedActor> => {
  let decoded: Result.Result<string, unknown>
  try {
    decoded = decodeActorId(actorId)
  } catch {
    return Result.fail(new InvalidTrustedActor({ code: "InvalidActorId" }))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(new InvalidTrustedActor({ code: "InvalidActorId" }))
  }
  const actor = Object.create(Object.prototype) as TrustedActorContext<
    Claims,
    ActorContext
  >
  Object.defineProperties(actor, {
    actorId: {
      value: decoded.success,
      enumerable: true
    },
    claims: {
      value: claims,
      enumerable: false
    },
    context: {
      value: context,
      enumerable: false
    }
  })
  Object.freeze(actor)
  trustedActors.add(actor)
  return Result.succeed(actor)
}

/**
 * Creates process-local trusted actor material while retaining invalid public
 * identity as typed data.
 *
 * **Details**
 *
 * Calling this constructor does not authenticate a caller. An already-trusted
 * adapter supplies the nonsecret actor identifier and opaque private values.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromTrustedActor = <Claims = unknown, ActorContext = unknown>(
  actorId: string,
  claims?: Claims,
  context?: ActorContext
): Result.Result<
  TrustedActorContext<Claims | undefined, ActorContext | undefined>,
  InvalidTrustedActor
> => buildTrustedActor(actorId, claims, context)

/**
 * Creates process-local trusted actor material after transport
 * authentication.
 *
 * **Details**
 *
 * Calling this constructor does not authenticate a caller. An already-trusted
 * adapter supplies the nonsecret actor identifier and opaque private values.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeTrustedActor = <Claims = unknown, ActorContext = unknown>(
  actorId: string,
  claims?: Claims,
  context?: ActorContext
): TrustedActorContext<Claims | undefined, ActorContext | undefined> => {
  const result = fromTrustedActor(actorId, claims, context)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

/**
 * Tests whether a value is exact trusted actor material constructed here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isTrustedActor = (
  value: unknown
): value is TrustedActorContext => typeof value === "object" && value !== null && trustedActors.has(value)

const signalKey = (name: string, version: string): string => SignalContractV2.signalDefinitionKey(name, version)

const captureDefinitions = (
  input: unknown
): Result.Result<ReadonlyArray<AnySignalRuntimeDefinition>, InvalidSignalRuntime> => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return Result.fail(invalid("build", InvalidRuntimeCodes.InvalidOptions))
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const lengthDescriptor = ownData(descriptors, "length")
    const length = lengthDescriptor?.value
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    ) {
      return Result.fail(invalid("build", InvalidRuntimeCodes.InvalidOptions))
    }
    const output = new Array<AnySignalRuntimeDefinition>(length)
    for (let index = 0; index < length; index++) {
      const descriptor = ownData(descriptors, String(index))
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !isSignalRuntimeDefinition(descriptor.value)
      ) {
        return Result.fail(invalid("build", InvalidRuntimeCodes.InvalidDefinition, { index }))
      }
      output[index] = descriptor.value
    }
    return Result.succeed(Object.freeze(output))
  } catch {
    return Result.fail(invalid("build", InvalidRuntimeCodes.UnsafeInspection))
  }
}

const mismatch = (
  persisted: SignalContractV2.SignalCatalogEntry,
  field: string,
  expected: string,
  actual: string
): SignalRuntimePinMismatch =>
  new SignalRuntimePinMismatch({
    name: persisted.definition.name,
    version: persisted.definition.version,
    field,
    expected,
    actual
  })

const pinFields = (
  persisted: SignalContractV2.SignalCatalogEntry,
  prefix: string,
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>
): SignalRuntimePinMismatch | undefined => {
  for (const field of Object.keys(expected)) {
    if (expected[field] !== actual[field]) {
      return mismatch(
        persisted,
        `${prefix}.${field}`,
        expected[field]!,
        actual[field] ?? ""
      )
    }
  }
  return undefined
}

const verifyPins = (
  runtime: AnySignalRuntimeDefinition,
  persisted: SignalContractV2.SignalCatalogEntry
): SignalRuntimePinMismatch | undefined => {
  if (runtime.definitionDigest !== persisted.definitionDigest) {
    return mismatch(
      persisted,
      "definitionDigest",
      persisted.definitionDigest,
      runtime.definitionDigest
    )
  }
  const codecMismatch = pinFields(
    persisted,
    "payloadCodec",
    persisted.definition.payloadCodec as unknown as Readonly<Record<string, string>>,
    runtime.payloadCodec.pin as unknown as Readonly<Record<string, string>>
  )
  if (codecMismatch !== undefined) {
    return codecMismatch
  }
  return pinFields(
    persisted,
    "authorizationPolicy",
    persisted.definition.authorizationPolicy as unknown as Readonly<Record<string, string>>,
    runtime.authorizationPolicy.pin as unknown as Readonly<Record<string, string>>
  )
}

const buildRegistry = (
  input: unknown
): Result.Result<SignalRuntimeRegistry.Service, RegistryBuildError> => {
  const captured = captureDefinitions(input)
  if (Result.isFailure(captured)) {
    return Result.fail(captured.failure)
  }
  const bySignal = new Map<string, AnySignalRuntimeDefinition>()
  for (const definition of captured.success) {
    const key = signalKey(definition.name, definition.version)
    if (bySignal.has(key)) {
      return Result.fail(
        new DuplicateSignalRuntimeDefinition({
          name: definition.name,
          version: definition.version
        })
      )
    }
    bySignal.set(key, definition)
  }

  const resolve: SignalRuntimeRegistry.Service["resolve"] = Effect.fnUntraced(
    function*(input) {
      const snapshot = Json.snapshot(input)
      if (Result.isFailure(snapshot)) {
        return yield* Effect.fail(
          invalid("resolve", InvalidRuntimeCodes.InvalidCatalogEntry)
        )
      }
      let decoded: Result.Result<SignalContractV2.SignalCatalogEntry, unknown>
      try {
        decoded = decodeCatalogEntry(snapshot.success)
      } catch {
        return yield* Effect.fail(
          invalid("resolve", InvalidRuntimeCodes.UnsafeInspection)
        )
      }
      if (Result.isFailure(decoded)) {
        return yield* Effect.fail(
          invalid("resolve", InvalidRuntimeCodes.InvalidCatalogEntry)
        )
      }
      const persisted = snapshot.success as unknown as SignalContractV2.SignalCatalogEntry
      const runtime = bySignal.get(
        signalKey(persisted.definition.name, persisted.definition.version)
      )
      if (runtime === undefined) {
        return yield* Effect.fail(
          new SignalRuntimeNotFound({
            name: persisted.definition.name,
            version: persisted.definition.version
          })
        )
      }
      const pinMismatch = verifyPins(runtime, persisted)
      if (pinMismatch !== undefined) {
        return yield* Effect.fail(pinMismatch)
      }
      return Object.freeze({
        runtime,
        persisted
      })
    }
  )

  const service = SignalRuntimeRegistry.of(Object.freeze({
    size: bySignal.size,
    resolve
  }))
  registries.add(service)
  return Result.succeed(service)
}

/**
 * Builds an immutable runtime registry while retaining configuration failures
 * as typed data.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromDefinitions = (
  entries: ReadonlyArray<AnySignalRuntimeDefinition>
): Result.Result<SignalRuntimeRegistry.Service, RegistryBuildError> => buildRegistry(entries)

/**
 * Constructs an immutable in-memory runtime signal registry.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeMemory = (
  entries: ReadonlyArray<AnySignalRuntimeDefinition>
): Effect.Effect<SignalRuntimeRegistry.Service, RegistryBuildError> =>
  Effect.suspend(() => Effect.fromResult(buildRegistry(entries)))

/**
 * Constructs a layer containing an immutable runtime signal registry.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory = (
  entries: ReadonlyArray<AnySignalRuntimeDefinition>
): Layer.Layer<SignalRuntimeRegistry, RegistryBuildError> => Layer.effect(SignalRuntimeRegistry, makeMemory(entries))

/**
 * Tests whether a value is an exact runtime registry constructed here.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSignalRuntimeRegistry = (
  value: unknown
): value is SignalRuntimeRegistry.Service => typeof value === "object" && value !== null && registries.has(value)

const payloadError = (
  resolved: ResolvedSignalRuntime,
  phase: SignalPayloadError["phase"],
  code: PayloadErrorCode,
  counts: {
    readonly maximumBytes?: number | undefined
    readonly actualBytes?: number | undefined
  } = {}
): SignalPayloadError =>
  new SignalPayloadError({
    name: resolved.persisted.definition.name,
    version: resolved.persisted.definition.version,
    phase,
    code,
    ...(counts.maximumBytes === undefined
      ? undefined
      : { maximumBytes: counts.maximumBytes }),
    ...(counts.actualBytes === undefined ? undefined : { actualBytes: counts.actualBytes })
  })

const canonicalSnapshot = (
  resolved: ResolvedSignalRuntime,
  input: unknown,
  code: typeof PayloadErrorCodes.NonJsonEncoding | typeof PayloadErrorCodes.CanonicalizationFailed
): Effect.Effect<{
  readonly encoded: Schema.Json
  readonly canonical: string
  readonly bytes: number
}, SignalPayloadError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Effect.fail(payloadError(resolved, "snapshot", code))
  }
  return Effect.try({
    try: () => {
      const canonical = Json.canonicalizeSnapshot(snapshot.success)
      return {
        encoded: snapshot.success,
        canonical,
        bytes: new TextEncoder().encode(canonical).byteLength
      }
    },
    catch: () =>
      payloadError(
        resolved,
        "snapshot",
        PayloadErrorCodes.CanonicalizationFailed
      )
  })
}

const ensureSize = (
  resolved: ResolvedSignalRuntime,
  actualBytes: number,
  phase: SignalPayloadError["phase"]
): Effect.Effect<void, SignalPayloadError> => {
  const maximumBytes = resolved.persisted.definition.maxEncodedPayloadBytes
  return actualBytes <= maximumBytes
    ? Effect.void
    : Effect.fail(payloadError(
      resolved,
      phase,
      PayloadErrorCodes.PayloadTooLarge,
      { maximumBytes, actualBytes }
    ))
}

const runCodec = Effect.fnUntraced(function*<A, R>(
  resolved: ResolvedSignalRuntime,
  phase: "decode" | "encode",
  operation: () => Effect.Effect<A, unknown, R>
): Effect.fn.Return<A, SignalPayloadError, R> {
  const prepared = yield* Effect.try({
    try: operation,
    catch: () =>
      payloadError(
        resolved,
        phase,
        phase === "decode"
          ? PayloadErrorCodes.DecodeFailed
          : PayloadErrorCodes.EncodeFailed
      )
  })
  return yield* prepared.pipe(
    Effect.mapError(() =>
      payloadError(
        resolved,
        phase,
        phase === "decode"
          ? PayloadErrorCodes.DecodeFailed
          : PayloadErrorCodes.EncodeFailed
      )
    ),
    Effect.catchCauseIf(
      (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      () =>
        Effect.fail(payloadError(
          resolved,
          phase,
          phase === "decode"
            ? PayloadErrorCodes.DecodeFailed
            : PayloadErrorCodes.EncodeFailed
        ))
    )
  )
})

const decodeAndReencode = Effect.fnUntraced(function*<
  D extends AnySignalRuntimeDefinition
>(
  resolved: ResolvedSignalRuntime<D>,
  encodedInput: unknown,
  source: "Inline" | "Blob",
  payload: ProtocolV2Wire.EncodedPayload
): Effect.fn.Return<
  DecodedPayload<Payload<D>>,
  SignalPayloadError,
  CodecServices<D>
> {
  const inputSnapshot = yield* canonicalSnapshot(
    resolved,
    encodedInput,
    PayloadErrorCodes.CanonicalizationFailed
  )
  yield* ensureSize(resolved, inputSnapshot.bytes, source === "Blob" ? "blob" : "envelope")
  const decoded = yield* runCodec(
    resolved,
    "decode",
    () =>
      Schema.decodeUnknownEffect(
        resolved.runtime.payloadCodec.schema,
        strictParseOptions
      )(inputSnapshot.encoded) as unknown as Effect.Effect<
        Payload<D>,
        unknown,
        D["payloadCodec"]["schema"]["DecodingServices"]
      >
  )
  const encoded = yield* runCodec(
    resolved,
    "encode",
    () =>
      Schema.encodeUnknownEffect(
        resolved.runtime.payloadCodec.schema,
        strictParseOptions
      )(decoded) as unknown as Effect.Effect<
        unknown,
        unknown,
        D["payloadCodec"]["schema"]["EncodingServices"]
      >
  )
  const canonical = yield* canonicalSnapshot(
    resolved,
    encoded,
    PayloadErrorCodes.NonJsonEncoding
  )
  yield* ensureSize(resolved, canonical.bytes, "encode")
  return Object.freeze({
    _tag: "DecodedPayload" as const,
    source,
    value: decoded,
    encoded: canonical.encoded,
    canonicalEncoded: canonical.canonical,
    encodedBytes: canonical.bytes,
    payload
  })
})

/**
 * Strictly decodes and deterministically re-encodes an inline payload, or
 * returns an explicit blob-resolution requirement.
 *
 * **Details**
 *
 * The envelope is first detached as strict JSON. Inline values are bounded,
 * decoded with excess-property rejection, re-encoded through the same exact
 * codec, snapshotted, canonicalized, and bounded again. Blob references are
 * never followed here.
 *
 * @category validation
 * @since 4.0.0
 */
export const decodePayload = Effect.fnUntraced(function*<
  D extends AnySignalRuntimeDefinition
>(
  resolved: ResolvedSignalRuntime<D>,
  input: unknown
): Effect.fn.Return<
  PayloadResult<Payload<D>>,
  SignalPayloadError,
  CodecServices<D>
> {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return yield* Effect.fail(
      payloadError(resolved, "envelope", PayloadErrorCodes.InvalidEnvelope)
    )
  }
  let decoded: Result.Result<ProtocolV2Wire.EncodedPayload, unknown>
  try {
    decoded = decodeEncodedPayload(snapshot.success)
  } catch {
    return yield* Effect.fail(
      payloadError(resolved, "envelope", PayloadErrorCodes.InvalidEnvelope)
    )
  }
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(
      payloadError(resolved, "envelope", PayloadErrorCodes.InvalidEnvelope)
    )
  }
  const payload = snapshot.success as unknown as ProtocolV2Wire.EncodedPayload
  if (payload._tag === "Inline") {
    return yield* decodeAndReencode(
      resolved,
      payload.value,
      "Inline",
      payload
    )
  }
  yield* ensureSize(resolved, payload.ref.encodedBytes, "blob")
  const requirement = Object.freeze({
    _tag: "BlobResolutionRequired" as const,
    ref: payload.ref,
    definitionDigest: resolved.persisted.definitionDigest,
    maximumEncodedBytes: resolved.persisted.definition.maxEncodedPayloadBytes
  })
  blobRequirements.set(requirement, resolved)
  return requirement
})

/**
 * Decodes JSON bytes already loaded and integrity-verified by a trusted blob
 * authority.
 *
 * **Details**
 *
 * This function does not retrieve bytes and cannot verify a digest. It only
 * accepts a requirement emitted by {@link decodePayload} for the same exact
 * resolved runtime. The caller is responsible for verifying the referenced
 * digest, byte count, media type, and strict JSON parse before invoking it.
 *
 * @category validation
 * @since 4.0.0
 */
export const decodeVerifiedBlob = Effect.fnUntraced(function*<
  D extends AnySignalRuntimeDefinition
>(
  resolved: ResolvedSignalRuntime<D>,
  requirement: BlobResolutionRequired,
  verifiedEncoded: unknown
): Effect.fn.Return<
  DecodedPayload<Payload<D>>,
  SignalPayloadError,
  CodecServices<D>
> {
  if (blobRequirements.get(requirement) !== resolved) {
    return yield* Effect.fail(
      payloadError(
        resolved,
        "blob",
        PayloadErrorCodes.BlobRequirementMismatch
      )
    )
  }
  return yield* decodeAndReencode(
    resolved,
    verifiedEncoded,
    "Blob",
    Object.freeze({
      _tag: "Blob" as const,
      ref: requirement.ref
    })
  )
})

/**
 * Evaluates the exact registered authorization policy with trusted actor
 * material.
 *
 * **Details**
 *
 * A successful policy must return a nonempty stable decision identifier.
 * Typed denial and unavailability are preserved. Throws, defects, malformed
 * results, non-Effect returns, and forged actor objects become a bounded
 * {@link AuthorizationUnavailable} without retaining private actor material.
 *
 * @category authorization
 * @since 4.0.0
 */
export const authorize = Effect.fnUntraced(function*<
  D extends AnySignalRuntimeDefinition
>(
  resolved: ResolvedSignalRuntime<D>,
  actor: TrustedActorContext,
  payload: Payload<D>
): Effect.fn.Return<
  string,
  AuthorizationDenied | AuthorizationUnavailable
> {
  if (!isTrustedActor(actor)) {
    return yield* Effect.fail(
      new AuthorizationUnavailable({ reasonCode: "InvalidTrustedActor" })
    )
  }
  const operation = yield* Effect.try({
    try: () =>
      resolved.runtime.authorizationPolicy.authorize(
        Object.freeze({ actor, payload })
      ),
    catch: () => new AuthorizationUnavailable({ reasonCode: "PolicyInvocationFailed" })
  })
  const isEffect = yield* Effect.try({
    try: () => Effect.isEffect(operation),
    catch: () => new AuthorizationUnavailable({ reasonCode: "PolicyInspectionFailed" })
  })
  if (!isEffect) {
    return yield* Effect.fail(
      new AuthorizationUnavailable({ reasonCode: "PolicyDidNotReturnEffect" })
    )
  }
  return yield* (operation as Effect.Effect<
    string,
    AuthorizationDenied | AuthorizationUnavailable
  >).pipe(
    Effect.catch((failure) =>
      failure instanceof AuthorizationDenied ||
        failure instanceof AuthorizationUnavailable
        ? Effect.fail(failure)
        : Effect.fail(
          new AuthorizationUnavailable({ reasonCode: "InvalidPolicyFailure" })
        )
    ),
    Effect.catchCauseIf(
      (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      () =>
        Effect.fail(
          new AuthorizationUnavailable({ reasonCode: "PolicyDefect" })
        )
    ),
    Effect.flatMap((decisionId) => {
      const decoded = decodeDecisionId(decisionId)
      return Result.isFailure(decoded)
        ? Effect.fail(
          new AuthorizationUnavailable({ reasonCode: "InvalidPolicyDecision" })
        )
        : Effect.succeed(decoded.success)
    })
  )
})
