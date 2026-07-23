import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as DigestV2 from "../src/DigestV2.ts"
import type * as EventV2 from "../src/EventV2.ts"
import * as IdentityV2 from "../src/IdentityV2.ts"
import type * as PlanStoreV2 from "../src/PlanStoreV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as SignalAuthorityV2 from "../src/SignalAuthorityV2.ts"
import * as SignalContractV2 from "../src/SignalContractV2.ts"
import * as SignalIngressV2 from "../src/SignalIngressV2.ts"
import * as SignalRuntimeV2 from "../src/SignalRuntimeV2.ts"

const tenantId = "tenant-1"
const runId = "run-1"
const epoch = Date.parse("2026-07-23T00:00:00.000Z")

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

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const buildDigest = (character: string) => Schema.decodeUnknownSync(ProtocolV2Wire.BuildDigest)(digest(character))

const schemaDigest = (character: string) => Schema.decodeUnknownSync(ProtocolV2Wire.SchemaDigest)(digest(character))

const compiledFingerprint = Schema.decodeUnknownSync(
  ProtocolV2Wire.CompiledFingerprint
)(digest("a"))

const Payload = Schema.Struct({
  orderId: Schema.NonEmptyString,
  amount: Schema.NumberFromString
})

type Payload = Schema.Schema.Type<typeof Payload>

const codecPin = (): SignalContractV2.CodecPin => ({
  id: "orders.approval-codec",
  version: "1.0.0",
  deploymentId: "approval-codec-build-1",
  buildDigest: buildDigest("b"),
  contractId: "orders.ApprovalGranted",
  contractVersion: "1.0.0",
  encodedSchemaDigest: schemaDigest("c")
})

const policyPin = (): SignalContractV2.BuildPin => ({
  id: "orders.approval-policy",
  version: "1.0.0",
  deploymentId: "approval-policy-build-1",
  buildDigest: buildDigest("d")
})

interface FixtureOptions {
  readonly maximumAccepted?: number
  readonly maximumPending?: number
  readonly maximumPendingBytes?: number
  readonly overflow?: SignalContractV2.SignalOverflow
  readonly authorize?: SignalRuntimeV2.AuthorizationPolicy<Payload>
  readonly blobReader?: SignalAuthorityV2.BlobReader
  readonly history?: ReadonlyArray<EventV2.Event>
}

const makeFixture = Effect.fnUntraced(function*(
  options: FixtureOptions = {}
) {
  const signalDefinition: SignalContractV2.SignalDefinition = {
    signalDefinitionVersion: 1,
    name: "ApprovalGranted",
    version: "1.0.0",
    payloadCodec: codecPin(),
    authorizationPolicy: policyPin(),
    correlation: "ExactRequired",
    ttlMillis: 60_000,
    maxEncodedPayloadBytes: 4_096
  }
  const signalDefinitionDigest = yield* DigestV2.definition(
    signalDefinition as unknown as Schema.Json
  )
  const signalEntry: SignalContractV2.SignalCatalogEntry = {
    key: SignalContractV2.signalDefinitionKey(
      signalDefinition.name,
      signalDefinition.version
    ),
    definitionDigest: signalDefinitionDigest,
    definition: signalDefinition
  }
  const artifact: PlanStoreV2.PlanArtifact = {
    artifactVersion: 2,
    executionProtocolVersion: 2,
    fingerprintDocument: {
      fingerprintVersion: 1,
      compilerSemanticVersion: "1",
      plan: {
        formatVersion: 1,
        id: "approval-plan",
        revision: 3,
        definition: {
          id: "approval-workflow",
          version: "2.1.0"
        },
        nodes: [],
        edges: []
      },
      topologicalOrder: [],
      stages: []
    },
    compiledFingerprint,
    definitionDeploymentId: "approval-workflow-build-1",
    dispatchTargets: {},
    activityPolicies: {},
    signalManifest: {
      catalogVersion: 1,
      definitions: [signalEntry],
      inboxPolicy: {
        policyVersion: 1,
        maxAcceptedCount: options.maximumAccepted ?? 100,
        maxPendingCount: options.maximumPending ?? 100,
        maxPendingEncodedBytes: options.maximumPendingBytes ?? 65_536,
        maxItemEncodedBytes: 4_096,
        maxSignalIdBytes: 64,
        maxCorrelationKeyBytes: 64,
        maxPendingWaits: 100,
        maxTtlMillis: 60_000,
        deduplicationScope: "RunLifetime",
        receiptRetentionAfterTerminalMillis: 60_000,
        overflow: options.overflow ?? { _tag: "Reject" }
      }
    }
  }
  const artifactDigest = yield* DigestV2.artifact(
    artifact as unknown as Schema.Json
  )
  const key = { tenantId, runId }
  const runStartedEventId = IdentityV2.runStartedEventId(tenantId, runId)
  const boundPlan: PlanStoreV2.BoundPlan = {
    binding: {
      bindingVersion: 2,
      executionProtocolVersion: 2,
      key,
      artifactDigest,
      workflowIdentity: "approval:order-1",
      requestId: "start-request-1",
      runStartedEventId
    },
    artifact
  }
  const runStarted: EventV2.Event = {
    eventVersion: 2,
    tenantId,
    runId,
    eventId: runStartedEventId,
    sequence: 0,
    recordedAt: new Date(epoch).toISOString(),
    payload: {
      _tag: "RunStarted",
      executionProtocolVersion: 2,
      artifactVersion: 2,
      artifactDigest,
      workflowIdentity: "approval:order-1",
      startRequestId: "start-request-1",
      planId: "approval-plan",
      planRevision: 3,
      definitionId: "approval-workflow",
      definitionVersion: "2.1.0",
      compilerVersion: "1",
      compiledFingerprint,
      backend: "durable",
      input: { orderId: "order-1" }
    }
  }
  const runtime = SignalRuntimeV2.makeDefinition({
    name: signalDefinition.name,
    version: signalDefinition.version,
    definitionDigest: signalDefinitionDigest,
    payloadCodec: {
      pin: signalDefinition.payloadCodec,
      schema: Payload
    },
    authorizationPolicy: {
      pin: signalDefinition.authorizationPolicy,
      authorize: options.authorize ??
        (() => Effect.succeed("decision-allow-1"))
    }
  })
  const runtimes = yield* SignalRuntimeV2.makeMemory([runtime])
  const authority = yield* SignalAuthorityV2.makeMemory({
    runs: [{
      boundPlan,
      history: options.history ?? [runStarted]
    }],
    runtimes,
    ...(options.blobReader === undefined
      ? undefined
      : { blobReader: options.blobReader })
  })
  return {
    authority,
    artifactDigest,
    boundPlan,
    key,
    runStarted,
    runtimes
  }
})

const request = (
  artifactDigest: ProtocolV2Wire.ArtifactDigest,
  signalId = "signal-1",
  payload: ProtocolV2Wire.EncodedPayload = {
    _tag: "Inline",
    value: {
      orderId: "order-1",
      amount: "7"
    }
  }
): SignalIngressV2.Request => ({
  ingressVersion: 2,
  key: { tenantId, runId },
  expectedArtifactDigest: artifactDigest,
  signalId,
  signalName: "ApprovalGranted",
  signalVersion: "1.0.0",
  correlation: { _tag: "Exact", key: "order-1" },
  payload
})

const actor = SignalIngressV2.makeAuthenticatedActor(
  "reviewer-1",
  { capability: "private-capability" }
)

const withCrypto = <A, E, R>(
  effect: Effect.Effect<A, E, R | Crypto.Crypto>
): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(Crypto.Crypto, testCrypto))

describe("SignalAuthorityV2", () => {
  it.effect("commits receipt, history pair, timer index, counters, and wake atomically", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture()
      const result = yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest),
        actor
      )

      assert.strictEqual(result._tag, "Accepted")
      if (result._tag !== "Accepted") {
        return
      }
      const snapshot = (yield* fixture.authority.inspect(fixture.key))!
      assert.strictEqual(snapshot.history.length, 3)
      assert.strictEqual(snapshot.history[1]!.payload._tag, "SignalAccepted")
      assert.strictEqual(snapshot.history[2]!.payload._tag, "TimerScheduled")
      assert.strictEqual(snapshot.replay.acceptedSignalCount, 1)
      assert.strictEqual(snapshot.replay.pendingSignalCount, 1)
      assert.strictEqual(snapshot.receipts.length, 1)
      assert.strictEqual(snapshot.indexedTimers.length, 1)
      assert.strictEqual(snapshot.wakeRevision, 1)
      assert.strictEqual(result.receipt.inboxSequence, 0)
      assert.strictEqual(result.receipt.historySequence, 1)
      assert.strictEqual(
        Date.parse(result.receipt.expiresAt) -
          Date.parse(result.receipt.acceptedAt),
        60_000
      )
      assert.strictEqual(
        result.receipt.admission.policyDecisionId,
        "decision-allow-1"
      )
      assert.notInclude(JSON.stringify(snapshot.history), "private-capability")
    })))

  it.effect("samples store time again after slow decoding and authorization", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture({
        authorize: () =>
          TestClock.setTime(epoch + 121_000).pipe(
            Effect.as("decision-after-delay")
          )
      })
      const result = yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest),
        actor
      )

      assert.strictEqual(result._tag, "Accepted")
      if (result._tag === "Accepted") {
        assert.strictEqual(
          Date.parse(result.receipt.acceptedAt),
          epoch + 121_000
        )
        assert.strictEqual(
          Date.parse(result.receipt.expiresAt),
          epoch + 181_000
        )
      }
    })))

  it.effect("returns the original receipt before reauthorization and conflicts on changed content", () => {
    let authorizations = 0
    return withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture({
        authorize: () => {
          authorizations++
          return Effect.succeed(`decision-${authorizations}`)
        }
      })
      const originalRequest = request(fixture.artifactDigest)
      const accepted = yield* fixture.authority.ingress.accept(
        originalRequest,
        actor
      )
      const unauthenticatedRetry = yield* fixture.authority.ingress.accept(
        originalRequest,
        { actorId: "", authenticationContext: null }
      )
      const duplicate = yield* fixture.authority.ingress.accept(
        originalRequest,
        actor
      )
      const conflict = yield* fixture.authority.ingress.accept(
        {
          ...originalRequest,
          payload: {
            _tag: "Inline",
            value: { orderId: "order-1", amount: "8" }
          }
        },
        actor
      )

      assert.strictEqual(accepted._tag, "Accepted")
      assert.deepStrictEqual(unauthenticatedRetry, {
        _tag: "Rejected",
        reason: "Unauthorized"
      })
      assert.strictEqual(duplicate._tag, "Duplicate")
      assert.strictEqual(authorizations, 1)
      if (accepted._tag === "Accepted" && duplicate._tag === "Duplicate") {
        assert.strictEqual(duplicate.receipt, accepted.receipt)
      }
      assert.deepStrictEqual(conflict, {
        _tag: "Rejected",
        reason: "SignalIdConflict"
      })
      assert.strictEqual(
        (yield* fixture.authority.inspect(fixture.key))!.history.length,
        3
      )
    }))
  })

  it.effect("rejects new signals during cancellation without mutating authority state", () => {
    let authorizations = 0
    return withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture({
        authorize: () => {
          authorizations++
          return Effect.succeed(`decision-${authorizations}`)
        },
        maximumAccepted: 1,
        maximumPending: 1,
        overflow: {
          _tag: "DeadLetter",
          maxCount: 1,
          maxEncodedBytes: 4_096,
          retentionMillis: 60_000
        }
      })
      const originalRequest = request(fixture.artifactDigest)
      const accepted = yield* fixture.authority.ingress.accept(
        originalRequest,
        actor
      )
      assert.strictEqual(accepted._tag, "Accepted")
      if (accepted._tag !== "Accepted") {
        return
      }

      const admitted = (yield* fixture.authority.inspect(fixture.key))!
      const cancellationRequestId = "cancel-request-1"
      const cancellation: EventV2.Event = {
        eventVersion: 2,
        tenantId,
        runId,
        eventId: IdentityV2.runCancellationRequestedEventId(
          tenantId,
          runId,
          cancellationRequestId
        ),
        sequence: admitted.replay.sequence + 1,
        recordedAt: new Date(epoch + 2_000).toISOString(),
        payload: {
          _tag: "RunCancellationRequested",
          requestId: cancellationRequestId
        }
      }
      const timerCleanup: EventV2.Event = {
        eventVersion: 2,
        tenantId,
        runId,
        eventId: IdentityV2.cancelTimerCommandId(
          tenantId,
          runId,
          accepted.receipt.expiryTimerId
        ),
        sequence: cancellation.sequence + 1,
        recordedAt: new Date(epoch + 3_000).toISOString(),
        payload: {
          _tag: "TimerCancelled",
          timerId: accepted.receipt.expiryTimerId,
          reason: "RunCancellationRequested"
        }
      }
      const recovered = yield* SignalAuthorityV2.makeMemory({
        runs: [{
          boundPlan: admitted.boundPlan,
          history: [...admitted.history, cancellation, timerCleanup]
        }],
        runtimes: fixture.runtimes
      })
      const before = (yield* recovered.inspect(fixture.key))!
      assert.strictEqual(before.replay.status, "CancellationRequested")

      const duplicate = yield* recovered.ingress.accept(
        originalRequest,
        actor
      )
      assert.strictEqual(duplicate._tag, "Duplicate")
      if (duplicate._tag === "Duplicate") {
        assert.deepStrictEqual(duplicate.receipt, accepted.receipt)
      }

      const duringCancellation = yield* Effect.result(
        recovered.ingress.accept(
          {
            ...request(fixture.artifactDigest, "signal-during-cancellation"),
            payload: {
              _tag: "Inline",
              value: { orderId: "order-1", amount: 7 }
            }
          },
          actor
        )
      )
      assert.ok(Result.isSuccess(duringCancellation))
      if (Result.isFailure(duringCancellation)) {
        return
      }
      assert.deepStrictEqual(duringCancellation.success, {
        _tag: "Rejected",
        reason: "TerminalRun"
      })
      assert.strictEqual(authorizations, 1)

      const after = (yield* recovered.inspect(fixture.key))!
      assert.deepStrictEqual(after.history, before.history)
      assert.deepStrictEqual(after.receipts, before.receipts)
      assert.deepStrictEqual(after.indexedTimers, before.indexedTimers)
      assert.deepStrictEqual(after.deadLetters, before.deadLetters)
      assert.strictEqual(after.wakeRevision, before.wakeRevision)
      assert.strictEqual(after.replay.sequence, before.replay.sequence)
      assert.strictEqual(
        after.replay.acceptedSignalCount,
        before.replay.acceptedSignalCount
      )
      assert.strictEqual(
        after.replay.pendingSignalCount,
        before.replay.pendingSignalCount
      )
      assert.strictEqual(
        after.replay.pendingSignalEncodedBytes,
        before.replay.pendingSignalEncodedBytes
      )
    }))
  })

  it.effect("rejects malformed, unknown, unauthorized, oversized, and invalid signals without facts", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture({
        authorize: () =>
          Effect.fail(
            new SignalRuntimeV2.AuthorizationDenied({
              reasonCode: "Denied"
            })
          )
      })
      const cases: ReadonlyArray<SignalIngressV2.Request> = [
        {
          ...request(fixture.artifactDigest, "unknown"),
          signalName: "Missing"
        },
        {
          ...request(fixture.artifactDigest, "invalid"),
          payload: {
            _tag: "Inline",
            value: { orderId: "order-1", amount: 7 }
          }
        },
        request(
          fixture.artifactDigest,
          "x".repeat(65)
        ),
        request(fixture.artifactDigest, "unauthorized")
      ]
      const reasons: Array<string> = []
      for (const item of cases) {
        const result = yield* fixture.authority.ingress.accept(item, actor)
        assert.strictEqual(result._tag, "Rejected")
        if (result._tag === "Rejected") {
          reasons.push(result.reason)
        }
      }
      assert.deepStrictEqual(reasons, [
        "UnknownSignal",
        "InvalidPayload",
        "SignalIdTooLarge",
        "Unauthorized"
      ])
      assert.strictEqual(
        (yield* fixture.authority.inspect(fixture.key))!.history.length,
        1
      )
    })))

  it.effect("serializes concurrent duplicate and distinct admissions", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture()
      const same = request(fixture.artifactDigest, "same")
      const results = yield* Effect.all([
        fixture.authority.ingress.accept(same, actor),
        fixture.authority.ingress.accept(same, actor),
        fixture.authority.ingress.accept(
          request(fixture.artifactDigest, "other"),
          actor
        )
      ], { concurrency: "unbounded" })

      assert.strictEqual(
        results.filter((result) => result._tag === "Accepted").length,
        2
      )
      assert.strictEqual(
        results.filter((result) => result._tag === "Duplicate").length,
        1
      )
      const snapshot = (yield* fixture.authority.inspect(fixture.key))!
      assert.strictEqual(snapshot.history.length, 5)
      assert.deepStrictEqual(
        snapshot.receipts.map((receipt) => receipt.inboxSequence),
        [0, 1]
      )
      assert.deepStrictEqual(
        snapshot.history.map((event) => event.sequence),
        [0, 1, 2, 3, 4]
      )
      assert.strictEqual(snapshot.wakeRevision, 2)
    })))

  it.effect("verifies immutable blob bytes before codec decoding", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const bytes = new TextEncoder().encode(
        " \n { \"amount\": \"7\", \"orderId\": \"order-1\" } \n "
      )
      const blobDigest = yield* DigestV2.blob(bytes)
      const fixture = yield* makeFixture({
        blobReader: {
          read: () => Effect.succeed(bytes.slice())
        }
      })
      const result = yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest, "blob-signal", {
          _tag: "Blob",
          ref: {
            blobVersion: 1,
            digest: blobDigest,
            encodedBytes: bytes.byteLength,
            mediaType: "application/json"
          }
        }),
        actor
      )

      assert.strictEqual(result._tag, "Accepted")
      if (result._tag === "Accepted") {
        assert.notStrictEqual(
          String(result.receipt.payloadDigest),
          String(blobDigest)
        )
      }
      assert.strictEqual(
        (yield* fixture.authority.inspect(fixture.key))!.replay
          .pendingSignalEncodedBytes,
        bytes.byteLength
      )
    })))

  it.effect("dead-letters bounded overflow without appending semantic history", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture({
        maximumPending: 1,
        overflow: {
          _tag: "DeadLetter",
          maxCount: 1,
          maxEncodedBytes: 4_096,
          retentionMillis: 60_000
        }
      })
      const first = yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest, "signal-1"),
        actor
      )
      const overflow = request(fixture.artifactDigest, "signal-2")
      const second = yield* fixture.authority.ingress.accept(overflow, actor)
      const duplicate = yield* fixture.authority.ingress.accept(overflow, actor)
      const full = yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest, "signal-3"),
        actor
      )

      assert.strictEqual(first._tag, "Accepted")
      assert.deepStrictEqual(second, {
        _tag: "Rejected",
        reason: "DeadLettered"
      })
      assert.deepStrictEqual(duplicate, second)
      assert.deepStrictEqual(full, {
        _tag: "Rejected",
        reason: "PendingCountExceeded"
      })
      const snapshot = (yield* fixture.authority.inspect(fixture.key))!
      assert.strictEqual(snapshot.history.length, 3)
      assert.strictEqual(snapshot.deadLetters.length, 1)
      assert.strictEqual(snapshot.deadLetters[0]!.signalId, "signal-2")
      assert.strictEqual(snapshot.wakeRevision, 1)
    })))

  it.effect("rebuilds receipts from history and preserves duplicate semantics after recovery", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture()
      const originalRequest = request(fixture.artifactDigest)
      const accepted = yield* fixture.authority.ingress.accept(
        originalRequest,
        actor
      )
      const snapshot = (yield* fixture.authority.inspect(fixture.key))!
      const recovered = yield* SignalAuthorityV2.makeMemory({
        runs: [{
          boundPlan: snapshot.boundPlan,
          history: snapshot.history
        }],
        runtimes: fixture.runtimes
      })
      const duplicate = yield* recovered.ingress.accept(
        originalRequest,
        actor
      )

      assert.strictEqual(accepted._tag, "Accepted")
      assert.strictEqual(duplicate._tag, "Duplicate")
      if (accepted._tag === "Accepted" && duplicate._tag === "Duplicate") {
        assert.deepStrictEqual(duplicate.receipt, accepted.receipt)
      }
      assert.strictEqual(
        (yield* recovered.inspect(fixture.key))!.history.length,
        3
      )
    })))

  it.effect("rejects historical inline payloads that fail their exact pinned codec", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture()
      yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest),
        actor
      )
      const snapshot = (yield* fixture.authority.inspect(fixture.key))!
      const accepted = snapshot.history[1]!
      assert.strictEqual(accepted.payload._tag, "SignalAccepted")
      if (accepted.payload._tag !== "SignalAccepted") {
        return
      }
      const invalidEncoded = {
        amount: 7,
        orderId: "order-1"
      }
      const payloadDigest = yield* DigestV2.payload(invalidEncoded)
      const tampered: EventV2.Event = {
        ...accepted,
        payload: {
          ...accepted.payload,
          payload: {
            _tag: "Inline",
            value: invalidEncoded
          },
          payloadDigest,
          encodedPayloadBytes: new TextEncoder().encode(
            JSON.stringify(invalidEncoded)
          ).byteLength
        }
      }
      const result = yield* SignalAuthorityV2.makeMemory({
        runs: [{
          boundPlan: snapshot.boundPlan,
          history: [
            snapshot.history[0]!,
            tampered,
            snapshot.history[2]!
          ]
        }],
        runtimes: fixture.runtimes
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(
        result.failure.code,
        SignalAuthorityV2.InvalidSeedCodes.BindingMismatch
      )
    })))

  it.effect("revalidates historical blob bytes, codec output, and payload digest", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const bytes = new TextEncoder().encode(
        " {\"amount\":\"7\",\"orderId\":\"order-1\"} "
      )
      const blobDigest = yield* DigestV2.blob(bytes)
      const blobReader: SignalAuthorityV2.BlobReader = {
        read: () => Effect.succeed(bytes.slice())
      }
      const fixture = yield* makeFixture({ blobReader })
      yield* fixture.authority.ingress.accept(
        request(fixture.artifactDigest, "blob-history", {
          _tag: "Blob",
          ref: {
            blobVersion: 1,
            digest: blobDigest,
            encodedBytes: bytes.byteLength,
            mediaType: "application/json"
          }
        }),
        actor
      )
      const snapshot = (yield* fixture.authority.inspect(fixture.key))!
      const accepted = snapshot.history[1]!
      assert.strictEqual(accepted.payload._tag, "SignalAccepted")
      if (accepted.payload._tag !== "SignalAccepted") {
        return
      }
      const tampered: EventV2.Event = {
        ...accepted,
        payload: {
          ...accepted.payload,
          payloadDigest: Schema.decodeUnknownSync(
            ProtocolV2Wire.PayloadDigest
          )(digest("f"))
        }
      }
      const result = yield* SignalAuthorityV2.makeMemory({
        runs: [{
          boundPlan: snapshot.boundPlan,
          history: [
            snapshot.history[0]!,
            tampered,
            snapshot.history[2]!
          ]
        }],
        runtimes: fixture.runtimes,
        blobReader
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(
        result.failure.code,
        SignalAuthorityV2.InvalidSeedCodes.BindingMismatch
      )
    })))

  it.effect("preserves interruption when infrastructure causes also contain defects", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture()
      const interruptingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () =>
          Effect.failCause(
            Cause.combine(
              Cause.interrupt(101),
              Cause.die(new Error("concurrent crypto defect"))
            )
          )
      })
      const exit = yield* SignalAuthorityV2.makeMemory({
        runs: [{
          boundPlan: fixture.boundPlan,
          history: [fixture.runStarted]
        }],
        runtimes: fixture.runtimes
      }).pipe(
        Effect.provideService(Crypto.Crypto, interruptingCrypto),
        Effect.exit
      )

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterrupts(exit.cause))
      }
    })))

  it.effect("rejects artifact tampering before exposing the authority", () =>
    withCrypto(Effect.gen(function*() {
      yield* TestClock.setTime(epoch + 1_000)
      const fixture = yield* makeFixture()
      const result = yield* SignalAuthorityV2.makeMemory({
        runs: [{
          boundPlan: {
            ...fixture.boundPlan,
            artifact: {
              ...fixture.boundPlan.artifact,
              definitionDeploymentId: "tampered-build"
            }
          },
          history: [fixture.runStarted]
        }],
        runtimes: fixture.runtimes
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(
        result.failure.code,
        SignalAuthorityV2.InvalidSeedCodes.ArtifactDigestMismatch
      )
    })))
})
