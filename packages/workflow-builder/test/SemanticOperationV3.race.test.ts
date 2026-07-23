import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { createHash } from "node:crypto"
import * as NativeName from "../src/EffectWorkflowOperationV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Operation from "../src/SemanticOperationV3.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const occurrence = (
  runId = "run-1",
  activation = 0
) =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-1",
    runId,
    artifactDigest: digest("a"),
    nodeId: "race-node",
    scopePath: [],
    activation
  })

const activity = (
  attempt = 1,
  operationId = "handler"
) => ({
  _tag: "Activity",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId,
  attempt,
  purpose: {
    _tag: "NodeHandler",
    purposeVersion: 1,
    nodeDefinitionKey: "race-node@1",
    handlerBuildDigest: digest("b")
  },
  input: {
    _tag: "Inline",
    value: { value: "input" }
  },
  successContract: {
    _tag: "NodeOutputAggregate",
    contractReferenceVersion: 1,
    nodeDefinitionKey: "race-node@1"
  },
  errorContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: "race-error@1",
    schemaDigest: digest("c")
  }
})

const classifier = () => ({
  _tag: "Activity",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "classifier",
  attempt: 1,
  purpose: {
    _tag: "RetryClassifier",
    purposeVersion: 1,
    failedActivityDigest: digest("d"),
    classifierKey: "classifier@1",
    classifierBuildDigest: digest("e")
  },
  input: {
    _tag: "Inline",
    value: {
      _tag: "AttemptTimeout",
      failureCauseVersion: 1,
      activityDigest: digest("d"),
      attempt: 1,
      timeoutKind: "StartToClose"
    }
  },
  successContract: {
    _tag: "BuiltIn",
    contractReferenceVersion: 1,
    vocabularyVersion: 2,
    schema: "RetryClassification"
  },
  errorContract: {
    _tag: "BuiltIn",
    contractReferenceVersion: 1,
    vocabularyVersion: 2,
    schema: "Never"
  }
})

const timer = (
  delayMillis = 1_000,
  generation = 0
) => ({
  _tag: "Timer",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "timeout",
  generation,
  owner: {
    _tag: "StartToClose",
    activityDigest: digest("d")
  },
  delayMillis
})

const deferred = () => ({
  _tag: "Deferred",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "signal",
  generation: 0,
  successCodecKey: "signal-success@1",
  errorCodecKey: "signal-error@1",
  successSchemaDigest: digest("f"),
  errorSchemaDigest: digest("0")
})

const race = (
  mode: "FirstSettled" | "FirstSuccess" = "FirstSettled",
  generation = 0
) => ({
  _tag: "Race",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "activity-or-timeout",
  generation,
  mode,
  loserDisposition: "InterruptWaiters",
  outcomeEnvelopeVersion: 1
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

describe("SemanticOperationV3 race", () => {
  it.effect("derives exact ordered membership and commits every race choice", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const handler = yield* Operation.prepare(
        preparedOccurrence,
        activity()
      )
      const timeout = yield* Operation.prepare(
        preparedOccurrence,
        timer()
      )
      const signal = yield* Operation.prepare(
        preparedOccurrence,
        deferred()
      )
      const first = yield* Operation.prepareRace(
        preparedOccurrence,
        race(),
        [
          ["handler", handler],
          ["timeout", timeout],
          ["signal", signal]
        ]
      )
      const replay = yield* Operation.prepareRace(
        preparedOccurrence,
        race(),
        [
          ["handler", handler],
          ["timeout", timeout],
          ["signal", signal]
        ]
      )
      const reordered = yield* Operation.prepareRace(
        preparedOccurrence,
        race(),
        [
          ["timeout", timeout],
          ["handler", handler],
          ["signal", signal]
        ]
      )
      const renamed = yield* Operation.prepareRace(
        preparedOccurrence,
        race(),
        [
          ["primary", handler],
          ["timeout", timeout],
          ["signal", signal]
        ]
      )
      const firstSuccess = yield* Operation.prepareRace(
        preparedOccurrence,
        race("FirstSuccess"),
        [
          ["handler", handler],
          ["timeout", timeout],
          ["signal", signal]
        ]
      )
      const renewed = yield* Operation.prepareRace(
        preparedOccurrence,
        race("FirstSettled", 1),
        [
          ["handler", handler],
          ["timeout", timeout],
          ["signal", signal]
        ]
      )

      assert.strictEqual(first.operationDigest, replay.operationDigest)
      for (
        const changed of [
          reordered,
          renamed,
          firstSuccess,
          renewed
        ]
      ) {
        assert.notStrictEqual(first.operationDigest, changed.operationDigest)
      }
      assert.strictEqual(first.document._tag, "Race")
      if (first.document._tag !== "Race") return
      assert.deepStrictEqual(
        first.document.participants.map((participant) => [
          participant.participantId,
          participant.participantKind,
          participant.operationDigest
        ]),
        [
          ["handler", "Activity", handler.operationDigest],
          ["timeout", "Timer", timeout.operationDigest],
          ["signal", "Deferred", signal.operationDigest]
        ]
      )
      assert.deepStrictEqual(
        first.document.participants[1]!.successContract,
        {
          _tag: "BuiltIn",
          contractReferenceVersion: 1,
          vocabularyVersion: 2,
          schema: "Void"
        }
      )
      assert.deepStrictEqual(
        first.document.participants[2]!.errorContract,
        {
          _tag: "ArtifactCodec",
          contractReferenceVersion: 1,
          codecKey: "signal-error@1",
          schemaDigest: digest("0")
        }
      )

      const generic = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...race(),
          participants: first.document.participants
        }
      ).pipe(Effect.flip)
      assert.strictEqual(generic.code, Operation.ErrorCodes.InvalidSpec)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("rejects forged, cross-occurrence, internal, and duplicate participants", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const otherOccurrence = yield* occurrence("run-2")
      const handler = yield* Operation.prepare(
        preparedOccurrence,
        activity()
      )
      const timeout = yield* Operation.prepare(
        preparedOccurrence,
        timer()
      )
      const driftedTimeout = yield* Operation.prepare(
        preparedOccurrence,
        timer(2_000)
      )
      const otherTimeout = yield* Operation.prepare(
        otherOccurrence,
        timer()
      )
      const internal = yield* Operation.prepare(
        preparedOccurrence,
        classifier()
      )

      const rejected = [
        Operation.prepareRace(
          preparedOccurrence,
          race(),
          [["copy", { ...handler } as Operation.PreparedOperation]]
        ),
        Operation.prepareRace(
          preparedOccurrence,
          race(),
          [["other", otherTimeout]]
        ),
        Operation.prepareRace(
          preparedOccurrence,
          race(),
          [["internal", internal]]
        ),
        Operation.prepareRace(
          preparedOccurrence,
          race(),
          [
            ["same", handler],
            ["same", timeout]
          ]
        ),
        Operation.prepareRace(
          preparedOccurrence,
          race(),
          [
            ["first", timeout],
            ["second", timeout]
          ]
        ),
        Operation.prepareRace(
          preparedOccurrence,
          race(),
          [
            ["first", timeout],
            ["second", driftedTimeout]
          ]
        )
      ] as const

      for (const candidate of rejected) {
        const failure = yield* candidate.pipe(Effect.flip)
        assert(
          failure.code === Operation.ErrorCodes.InvalidSpec ||
            failure.code === Operation.ErrorCodes.UnpreparedOperation
        )
      }
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("verifies persisted races and maps generations into a disjoint native namespace", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const handler = yield* Operation.prepare(
        preparedOccurrence,
        activity()
      )
      const timeout = yield* Operation.prepare(
        preparedOccurrence,
        timer()
      )
      const initial = yield* Operation.prepareRace(
        preparedOccurrence,
        race(),
        [
          ["handler", handler],
          ["timeout", timeout]
        ]
      )
      const renewed = yield* Operation.prepareRace(
        preparedOccurrence,
        race("FirstSettled", 1),
        [
          ["handler", handler],
          ["timeout", timeout]
        ]
      )
      const verified = yield* Operation.verify(
        JSON.parse(JSON.stringify(initial))
      )
      assert.strictEqual(verified.operationDigest, initial.operationDigest)
      assert.isTrue(Operation.isPrepared(verified))

      const initialCoordinates = success(
        Operation.nativeCoordinates(initial)
      )
      const renewedCoordinates = success(
        Operation.nativeCoordinates(renewed)
      )
      assert.strictEqual(initialCoordinates._tag, "Race")
      assert.notStrictEqual(
        success(NativeName.name(initialCoordinates)),
        success(NativeName.name(renewedCoordinates))
      )
      assert.notStrictEqual(
        success(NativeName.name(initialCoordinates)),
        success(NativeName.name(
          success(Operation.nativeCoordinates(timeout))
        ))
      )

      const tampered = {
        document: {
          ...initial.document,
          generation: 9
        },
        operationDigest: initial.operationDigest
      }
      const mismatch = yield* Operation.verify(tampered).pipe(Effect.flip)
      assert.strictEqual(mismatch.code, Operation.ErrorCodes.DigestMismatch)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))
})
