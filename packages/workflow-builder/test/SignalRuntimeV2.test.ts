import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as SignalContractV2 from "../src/SignalContractV2.ts"
import * as SignalRuntimeV2 from "../src/SignalRuntimeV2.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const definitionDigest = (character = "a") =>
  Schema.decodeUnknownSync(ProtocolV2Wire.DefinitionDigest)(digest(character))

const buildDigest = (character: string) => Schema.decodeUnknownSync(ProtocolV2Wire.BuildDigest)(digest(character))

const schemaDigest = (character: string) => Schema.decodeUnknownSync(ProtocolV2Wire.SchemaDigest)(digest(character))

const blobDigest = (character: string) => Schema.decodeUnknownSync(ProtocolV2Wire.BlobDigest)(digest(character))

const codecPin = (
  overrides: Partial<SignalContractV2.CodecPin> = {}
): SignalContractV2.CodecPin => ({
  id: "orders.approval-codec",
  version: "1.0.0",
  deploymentId: "approval-codec-build-1",
  buildDigest: buildDigest("b"),
  contractId: "orders.ApprovalGranted",
  contractVersion: "1.0.0",
  encodedSchemaDigest: schemaDigest("c"),
  ...overrides
})

const policyPin = (
  overrides: Partial<SignalContractV2.BuildPin> = {}
): SignalContractV2.BuildPin => ({
  id: "orders.approval-policy",
  version: "1.0.0",
  deploymentId: "approval-policy-build-1",
  buildDigest: buildDigest("d"),
  ...overrides
})

const Payload = Schema.Struct({
  orderId: Schema.NonEmptyString,
  amount: Schema.NumberFromString
})

type Payload = Schema.Schema.Type<typeof Payload>

const runtimeDefinition = (
  authorize: SignalRuntimeV2.AuthorizationPolicy<Payload> = () => Effect.succeed("decision-allow-1"),
  overrides: {
    readonly name?: string
    readonly version?: string
    readonly definitionDigest?: ProtocolV2Wire.DefinitionDigest
    readonly codecPin?: SignalContractV2.CodecPin
    readonly policyPin?: SignalContractV2.BuildPin
  } = {}
) =>
  SignalRuntimeV2.makeDefinition({
    name: overrides.name ?? "ApprovalGranted",
    version: overrides.version ?? "1.0.0",
    definitionDigest: overrides.definitionDigest ?? definitionDigest(),
    payloadCodec: {
      pin: overrides.codecPin ?? codecPin(),
      schema: Payload
    },
    authorizationPolicy: {
      pin: overrides.policyPin ?? policyPin(),
      authorize
    }
  })

const persisted = (
  overrides: {
    readonly name?: string
    readonly version?: string
    readonly definitionDigest?: ProtocolV2Wire.DefinitionDigest
    readonly codecPin?: SignalContractV2.CodecPin
    readonly policyPin?: SignalContractV2.BuildPin
    readonly maximumBytes?: number
  } = {}
): SignalContractV2.SignalCatalogEntry => {
  const name = overrides.name ?? "ApprovalGranted"
  const version = overrides.version ?? "1.0.0"
  return Schema.decodeUnknownSync(SignalContractV2.SignalCatalogEntry)({
    key: SignalContractV2.signalDefinitionKey(name, version),
    definitionDigest: overrides.definitionDigest ?? definitionDigest(),
    definition: {
      signalDefinitionVersion: 1,
      name,
      version,
      payloadCodec: overrides.codecPin ?? codecPin(),
      authorizationPolicy: overrides.policyPin ?? policyPin(),
      correlation: "ExactRequired",
      ttlMillis: 60_000,
      maxEncodedPayloadBytes: overrides.maximumBytes ?? 4_096
    }
  })
}

const resolve = Effect.fnUntraced(function*(
  definition = runtimeDefinition(),
  entry = persisted()
) {
  const registry = yield* SignalRuntimeV2.makeMemory([definition])
  return yield* registry.resolve(entry)
})

describe("SignalRuntimeV2", () => {
  it.effect("constructs an immutable exact registry and layer", () =>
    Effect.gen(function*() {
      const definition = runtimeDefinition()
      const registry = yield* SignalRuntimeV2.makeMemory([definition])
      const resolved = yield* registry.resolve(persisted())

      assert.strictEqual(registry.size, 1)
      assert.strictEqual(resolved.runtime, definition)
      assert.isTrue(Object.isFrozen(resolved))
      assert.isTrue(Object.isFrozen(resolved.persisted))
      assert.isTrue(SignalRuntimeV2.isSignalRuntimeDefinition(definition))
      assert.isFalse(SignalRuntimeV2.isSignalRuntimeDefinition({ ...definition }))
      assert.isTrue(SignalRuntimeV2.isSignalRuntimeRegistry(registry))
      assert.isFalse(SignalRuntimeV2.isSignalRuntimeRegistry({ ...registry }))

      const context = yield* Effect.scoped(
        Layer.build(SignalRuntimeV2.layerMemory([definition]))
      )
      const layered = Context.get(context, SignalRuntimeV2.SignalRuntimeRegistry)
      assert.strictEqual((yield* layered.resolve(persisted())).runtime, definition)
    }))

  it.effect("rejects duplicate signal name and version registrations", () =>
    Effect.gen(function*() {
      const definition = runtimeDefinition()
      const result = yield* SignalRuntimeV2.makeMemory([
        definition,
        definition
      ]).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(
        result.failure,
        SignalRuntimeV2.DuplicateSignalRuntimeDefinition
      )
      assert.deepStrictEqual(
        result.failure,
        new SignalRuntimeV2.DuplicateSignalRuntimeDefinition({
          name: "ApprovalGranted",
          version: "1.0.0"
        })
      )
    }))

  it.effect("never falls back to another name or version", () =>
    Effect.gen(function*() {
      const registry = yield* SignalRuntimeV2.makeMemory([runtimeDefinition()])
      for (
        const entry of [
          persisted({ name: "MissingSignal" }),
          persisted({ version: "2.0.0" })
        ]
      ) {
        const result = yield* registry.resolve(entry).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.instanceOf(result.failure, SignalRuntimeV2.SignalRuntimeNotFound)
      }
    }))

  it.effect("verifies every persisted definition, codec, and policy pin field", () =>
    Effect.gen(function*() {
      const registry = yield* SignalRuntimeV2.makeMemory([runtimeDefinition()])
      const mismatches: ReadonlyArray<
        readonly [string, SignalContractV2.SignalCatalogEntry]
      > = [
        [
          "definitionDigest",
          persisted({ definitionDigest: definitionDigest("e") })
        ],
        [
          "payloadCodec.id",
          persisted({ codecPin: codecPin({ id: "other-codec" }) })
        ],
        [
          "payloadCodec.version",
          persisted({ codecPin: codecPin({ version: "2.0.0" }) })
        ],
        [
          "payloadCodec.deploymentId",
          persisted({ codecPin: codecPin({ deploymentId: "other-codec-build" }) })
        ],
        [
          "payloadCodec.buildDigest",
          persisted({ codecPin: codecPin({ buildDigest: buildDigest("e") }) })
        ],
        [
          "payloadCodec.contractId",
          persisted({ codecPin: codecPin({ contractId: "orders.Other" }) })
        ],
        [
          "payloadCodec.contractVersion",
          persisted({ codecPin: codecPin({ contractVersion: "2.0.0" }) })
        ],
        [
          "payloadCodec.encodedSchemaDigest",
          persisted({ codecPin: codecPin({ encodedSchemaDigest: schemaDigest("e") }) })
        ],
        [
          "authorizationPolicy.id",
          persisted({ policyPin: policyPin({ id: "other-policy" }) })
        ],
        [
          "authorizationPolicy.version",
          persisted({ policyPin: policyPin({ version: "2.0.0" }) })
        ],
        [
          "authorizationPolicy.deploymentId",
          persisted({ policyPin: policyPin({ deploymentId: "other-policy-build" }) })
        ],
        [
          "authorizationPolicy.buildDigest",
          persisted({ policyPin: policyPin({ buildDigest: buildDigest("e") }) })
        ]
      ]

      for (const [field, entry] of mismatches) {
        const result = yield* registry.resolve(entry).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.instanceOf(result.failure, SignalRuntimeV2.SignalRuntimePinMismatch)
        assert.strictEqual(result.failure.field, field)
      }
    }))

  it.effect("strictly decodes, re-encodes, snapshots, and canonicalizes inline JSON", () =>
    Effect.gen(function*() {
      const resolved = yield* resolve()
      const result = yield* SignalRuntimeV2.decodePayload(resolved, {
        _tag: "Inline",
        value: {
          orderId: "order-1",
          amount: "7"
        }
      })

      assert.strictEqual(result._tag, "DecodedPayload")
      if (result._tag === "DecodedPayload") {
        assert.strictEqual(result.source, "Inline")
        assert.deepStrictEqual(result.value, {
          orderId: "order-1",
          amount: 7
        })
        assert.deepStrictEqual(result.encoded, {
          orderId: "order-1",
          amount: "7"
        })
        assert.strictEqual(
          result.canonicalEncoded,
          "{\"amount\":\"7\",\"orderId\":\"order-1\"}"
        )
        assert.strictEqual(
          result.encodedBytes,
          new TextEncoder().encode(result.canonicalEncoded).byteLength
        )
        assert.isTrue(Object.isFrozen(result))
        assert.isTrue(Object.isFrozen(result.encoded))
      }
    }))

  it.effect("rejects excess, cyclic, accessor, and oversized inline payloads without retaining them", () => {
    let getterReads = 0
    const accessor = Object.defineProperty(
      {
        _tag: "Inline"
      },
      "value",
      {
        enumerable: true,
        get: () => {
          getterReads++
          return { orderId: "order-1", amount: "7" }
        }
      }
    )
    const cyclic: Record<string, unknown> = {
      orderId: "order-1",
      amount: "7"
    }
    cyclic.self = cyclic

    return Effect.gen(function*() {
      const resolved = yield* resolve(
        runtimeDefinition(),
        persisted({ maximumBytes: 64 })
      )
      const cases: ReadonlyArray<unknown> = [
        {
          _tag: "Inline",
          value: { orderId: "order-1", amount: "7", excess: true }
        },
        { _tag: "Inline", value: cyclic },
        accessor,
        {
          _tag: "Inline",
          value: { orderId: "x".repeat(100), amount: "7" }
        }
      ]
      const expected = [
        SignalRuntimeV2.PayloadErrorCodes.DecodeFailed,
        SignalRuntimeV2.PayloadErrorCodes.InvalidEnvelope,
        SignalRuntimeV2.PayloadErrorCodes.InvalidEnvelope,
        SignalRuntimeV2.PayloadErrorCodes.PayloadTooLarge
      ]
      for (let index = 0; index < cases.length; index++) {
        const result = yield* SignalRuntimeV2.decodePayload(
          resolved,
          cases[index]
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.instanceOf(result.failure, SignalRuntimeV2.SignalPayloadError)
        assert.strictEqual(result.failure.code, expected[index])
        assert.notInclude(JSON.stringify(result.failure), "order-1")
        assert.notInclude(JSON.stringify(result.failure), "x".repeat(20))
      }
      assert.strictEqual(getterReads, 0)
    })
  })

  it.effect("returns allow, typed deny, and typed unavailable authorization outcomes", () =>
    Effect.gen(function*() {
      const actor = SignalRuntimeV2.makeTrustedActor(
        "actor-1",
        { token: "top-secret-token" },
        { capability: "private-capability" }
      )
      const payload = { orderId: "order-1", amount: 7 }

      const allowed = yield* SignalRuntimeV2.authorize(
        yield* resolve(runtimeDefinition(() => Effect.succeed("decision-allow-1"))),
        actor,
        payload
      )
      assert.strictEqual(allowed, "decision-allow-1")

      const deniedError = new SignalRuntimeV2.AuthorizationDenied({
        reasonCode: "ActorMayNotApprove",
        policyDecisionId: "decision-deny-1"
      })
      const denied = yield* SignalRuntimeV2.authorize(
        yield* resolve(runtimeDefinition(() => Effect.fail(deniedError))),
        actor,
        payload
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(denied))
      assert.strictEqual(denied.failure, deniedError)

      const unavailableError = new SignalRuntimeV2.AuthorizationUnavailable({
        reasonCode: "PolicyBackendUnavailable"
      })
      const unavailable = yield* SignalRuntimeV2.authorize(
        yield* resolve(runtimeDefinition(() => Effect.fail(unavailableError))),
        actor,
        payload
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unavailable))
      assert.strictEqual(unavailable.failure, unavailableError)

      assert.deepStrictEqual(JSON.parse(JSON.stringify(actor)), {
        actorId: "actor-1"
      })
      assert.notInclude(JSON.stringify(actor), "top-secret-token")
      assert.notInclude(JSON.stringify(actor), "private-capability")
      assert.notInclude(JSON.stringify(denied.failure), "top-secret-token")
      assert.notInclude(JSON.stringify(unavailable.failure), "top-secret-token")
    }))

  it.effect("contains malformed policies and rejects forged trusted actor JSON", () =>
    Effect.gen(function*() {
      const payload = { orderId: "order-1", amount: 7 }
      const actor = SignalRuntimeV2.makeTrustedActor("actor-1", {
        secret: "never-serialize"
      })

      const invalidDecision = yield* SignalRuntimeV2.authorize(
        yield* resolve(runtimeDefinition(() => Effect.succeed(""))),
        actor,
        payload
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalidDecision))
      assert.instanceOf(
        invalidDecision.failure,
        SignalRuntimeV2.AuthorizationUnavailable
      )
      assert.strictEqual(
        invalidDecision.failure.reasonCode,
        "InvalidPolicyDecision"
      )

      const forged = yield* SignalRuntimeV2.authorize(
        yield* resolve(),
        {
          actorId: "actor-1",
          claims: { secret: "forged" },
          context: undefined
        },
        payload
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(forged))
      assert.instanceOf(forged.failure, SignalRuntimeV2.AuthorizationUnavailable)
      assert.strictEqual(forged.failure.reasonCode, "InvalidTrustedActor")
      assert.notInclude(JSON.stringify(forged.failure), "forged")

      const invalidActor = SignalRuntimeV2.fromTrustedActor("", {
        secret: "never-serialize"
      })
      assert.isTrue(Result.isFailure(invalidActor))
      assert.instanceOf(invalidActor.failure, SignalRuntimeV2.InvalidTrustedActor)
      assert.notInclude(JSON.stringify(invalidActor.failure), "never-serialize")
      assert.throws(
        () => SignalRuntimeV2.makeTrustedActor(""),
        SignalRuntimeV2.InvalidTrustedActor
      )
    }))

  it.effect("hands blob references to an authority before decoding verified JSON", () =>
    Effect.gen(function*() {
      const resolved = yield* resolve()
      const payload = {
        _tag: "Blob" as const,
        ref: {
          blobVersion: 1 as const,
          digest: blobDigest("f"),
          encodedBytes: 40,
          mediaType: "application/json"
        }
      }
      const requirement = yield* SignalRuntimeV2.decodePayload(resolved, payload)

      assert.strictEqual(requirement._tag, "BlobResolutionRequired")
      if (requirement._tag === "BlobResolutionRequired") {
        assert.deepStrictEqual(requirement.ref, payload.ref)
        assert.strictEqual(requirement.definitionDigest, definitionDigest())
        assert.strictEqual(requirement.maximumEncodedBytes, 4_096)

        const decoded = yield* SignalRuntimeV2.decodeVerifiedBlob(
          resolved,
          requirement,
          { orderId: "order-1", amount: "7" }
        )
        assert.strictEqual(decoded.source, "Blob")
        assert.deepStrictEqual(decoded.value, {
          orderId: "order-1",
          amount: 7
        })
        assert.deepStrictEqual(decoded.payload, payload)
      }

      const otherResolved = yield* resolve()
      const mismatch = yield* SignalRuntimeV2.decodeVerifiedBlob(
        otherResolved,
        requirement as SignalRuntimeV2.BlobResolutionRequired,
        { orderId: "order-1", amount: "7" }
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(mismatch))
      assert.instanceOf(mismatch.failure, SignalRuntimeV2.SignalPayloadError)
      assert.strictEqual(
        mismatch.failure.code,
        SignalRuntimeV2.PayloadErrorCodes.BlobRequirementMismatch
      )
    }))

  it.effect("rejects oversized blob references before handing them to an authority", () =>
    Effect.gen(function*() {
      const resolved = yield* resolve(
        runtimeDefinition(),
        persisted({ maximumBytes: 32 })
      )
      const result = yield* SignalRuntimeV2.decodePayload(resolved, {
        _tag: "Blob",
        ref: {
          blobVersion: 1,
          digest: blobDigest("f"),
          encodedBytes: 33,
          mediaType: "application/json"
        }
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(result.failure, SignalRuntimeV2.SignalPayloadError)
      assert.strictEqual(
        result.failure.code,
        SignalRuntimeV2.PayloadErrorCodes.PayloadTooLarge
      )
      assert.strictEqual(result.failure.maximumBytes, 32)
      assert.strictEqual(result.failure.actualBytes, 33)
    }))
})
