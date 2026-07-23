import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as NativeName from "../src/EffectWorkflowOperationV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Operation from "../src/SemanticOperationV3.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const occurrence = () =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-1",
    runId: "run-1",
    artifactDigest: digest("a"),
    nodeId: "generate-document",
    scopePath: [{
      scopeActivationVersion: 1,
      scopeId: "foreach-document",
      activation: 7
    }],
    activation: 2
  })

const activity = (
  attempt: number,
  value: unknown = { documentId: 42 }
) => ({
  _tag: "Activity",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "invoke-handler",
  attempt,
  purpose: {
    _tag: "NodeHandler",
    purposeVersion: 1,
    nodeDefinitionKey: "document-generator@1",
    handlerBuildDigest: digest("f")
  },
  input: {
    _tag: "Inline",
    value
  },
  successContract: {
    _tag: "NodeOutputAggregate",
    contractReferenceVersion: 1,
    nodeDefinitionKey: "document-generator@1"
  },
  errorContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: "document-error@1",
    schemaDigest: digest("1")
  }
})

const timer = (
  generation: number,
  delayMillis: number
) => ({
  _tag: "Timer",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "retry-backoff",
  generation,
  owner: {
    _tag: "RetryBackoff",
    failedActivityDigest: digest("b")
  },
  delayMillis
})

const deferred = (
  generation: number,
  successSchemaDigest = digest("c")
) => ({
  _tag: "Deferred",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "human-approval",
  generation,
  successCodecKey: "approval-result@1",
  errorCodecKey: "approval-error@1",
  successSchemaDigest,
  errorSchemaDigest: digest("d")
})

const retryController = () => ({
  _tag: "RetryScheduleToClose",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "retry-controller",
  generation: 0,
  controllerVersion: 2,
  firstActivityDigest: digest("4"),
  initialObservationDigest: digest("5"),
  nodeDefinitionKey: "document-generator@1",
  handlerBuildDigest: digest("f"),
  input: {
    _tag: "Inline",
    value: { documentId: 42 }
  },
  activityPolicy: {
    policyVersion: 3,
    retry: {
      retryPolicyVersion: 3,
      maximumAttempts: 3,
      maximumElapsed: { _tag: "Unlimited" },
      classifier: {
        classifierPinVersion: 3,
        classifierId: "default-error-classifier",
        classifierVersion: "1.0.0",
        buildDigest: digest("6")
      },
      failureIdentity: {
        _tag: "EffectTagged",
        identityContractVersion: 1,
        code: "OptionalString"
      },
      nonRetryableErrorTags: [],
      nonRetryableErrorCodes: [],
      backoff: {
        _tag: "Fixed",
        delayMillis: 1_000
      },
      jitter: { _tag: "NoJitter" }
    },
    timeouts: {
      scheduleToStart: {
        _tag: "After",
        durationMillis: 10_000
      },
      startToClose: {
        _tag: "After",
        durationMillis: 20_000
      },
      scheduleToClose: {
        _tag: "After",
        durationMillis: 30_000
      }
    }
  },
  timeoutKind: "ScheduleToClose",
  durationMillis: 30_000,
  outcomeContractVersion: 1,
  loserDisposition: "InterruptWaiters"
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

describe("SemanticOperationV3", () => {
  it("strictly admits timeout outcomes and rejects mismatched attempt coordinates", () => {
    const timedOut = {
      _tag: "TimedOut",
      outcomeVersion: 2,
      attempt: 2,
      activityDigest: digest("4"),
      timeout: {
        _tag: "AttemptTimeout",
        failureCauseVersion: 1,
        attempt: 2,
        activityDigest: digest("4"),
        timeoutKind: "ScheduleToStart"
      },
      timerOperationDigest: digest("5"),
      deadline: "2026-07-23T12:00:00.000Z",
      durationMillis: 30_000
    }
    const decode = Schema.decodeUnknownResult(
      Operation.NodeAttemptOutcome,
      {
        errors: "all",
        onExcessProperty: "error"
      }
    )
    assert(Result.isSuccess(decode(timedOut)))

    for (
      const candidate of [
        {
          ...timedOut,
          attempt: 3
        },
        {
          ...timedOut,
          activityDigest: digest("6")
        },
        {
          ...timedOut,
          timeout: {
            ...timedOut.timeout,
            attempt: 3
          }
        },
        {
          ...timedOut,
          timeout: {
            ...timedOut.timeout,
            activityDigest: digest("6")
          }
        },
        {
          ...timedOut,
          timeout: {
            ...timedOut.timeout,
            forged: true
          }
        },
        {
          ...timedOut,
          forged: true
        }
      ]
    ) {
      assert(Result.isFailure(decode(candidate)))
    }
  })

  it.effect("admits schedule-to-start timer ownership and all timeout dimensions on retry controllers", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const scheduled = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...timer(0, 10_000),
          operationId: "schedule-to-start",
          owner: {
            _tag: "ScheduleToStart",
            activityDigest: digest("4")
          }
        }
      )
      assert.strictEqual(scheduled.document._tag, "Timer")
      if (scheduled.document._tag === "Timer") {
        assert.deepStrictEqual(scheduled.document.owner, {
          _tag: "ScheduleToStart",
          activityDigest: digest("4")
        })
      }

      const controller = yield* Operation.prepare(
        preparedOccurrence,
        retryController()
      )
      assert.strictEqual(controller.document._tag, "RetryScheduleToClose")
      if (controller.document._tag === "RetryScheduleToClose") {
        assert.strictEqual(controller.document.controllerVersion, 2)
        assert.strictEqual(
          controller.document.activityPolicy.timeouts.scheduleToStart._tag,
          "After"
        )
        assert.strictEqual(
          controller.document.activityPolicy.timeouts.startToClose._tag,
          "After"
        )
      }

      const oldController = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...retryController(),
          controllerVersion: 1
        }
      ).pipe(Effect.flip)
      assert.strictEqual(oldController.code, Operation.ErrorCodes.InvalidSpec)

      const oldOperation = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...timer(0, 10_000),
          operationVersion: 1
        }
      ).pipe(Effect.flip)
      assert.strictEqual(oldOperation.code, Operation.ErrorCodes.InvalidSpec)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("pins activity meaning while retaining one logical native name across attempts", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const first = yield* Operation.prepare(
        preparedOccurrence,
        activity(1)
      )
      const replay = yield* Operation.prepare(
        preparedOccurrence,
        activity(1)
      )
      const retry = yield* Operation.prepare(
        preparedOccurrence,
        activity(2)
      )
      const changedInput = yield* Operation.prepare(
        preparedOccurrence,
        activity(1, { documentId: 43 })
      )
      const changedPurpose = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...activity(1),
          purpose: {
            ...activity(1).purpose,
            handlerBuildDigest: digest("2")
          }
        }
      )
      const changedContract = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...activity(1),
          errorContract: {
            ...activity(1).errorContract,
            codecKey: "document-error@2",
            schemaDigest: digest("3")
          }
        }
      )

      assert.strictEqual(first.operationDigest, replay.operationDigest)
      assert.notStrictEqual(first.operationDigest, retry.operationDigest)
      assert.notStrictEqual(
        first.operationDigest,
        changedInput.operationDigest
      )
      assert.notStrictEqual(
        first.operationDigest,
        changedPurpose.operationDigest
      )
      assert.notStrictEqual(
        first.operationDigest,
        changedContract.operationDigest
      )
      assert.isTrue(Operation.isPrepared(first))
      assert.isFalse(Operation.isPrepared({ ...first }))
      const firstName = success(NativeName.name(
        success(Operation.nativeCoordinates(first))
      ))
      for (
        const candidate of [
          retry,
          changedPurpose,
          changedContract
        ]
      ) {
        assert.strictEqual(
          firstName,
          success(NativeName.name(
            success(Operation.nativeCoordinates(candidate))
          ))
        )
      }
      assert.deepStrictEqual(
        success(Operation.occurrence(first)),
        preparedOccurrence
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("separates generations but exposes same-coordinate semantic drift", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const initialTimer = yield* Operation.prepare(
        preparedOccurrence,
        timer(0, 1_000)
      )
      const driftedTimer = yield* Operation.prepare(
        preparedOccurrence,
        timer(0, 2_000)
      )
      const renewedTimer = yield* Operation.prepare(
        preparedOccurrence,
        timer(1, 1_000)
      )
      const initialName = success(NativeName.name(
        success(Operation.nativeCoordinates(initialTimer))
      ))
      const driftedName = success(NativeName.name(
        success(Operation.nativeCoordinates(driftedTimer))
      ))
      const renewedName = success(NativeName.name(
        success(Operation.nativeCoordinates(renewedTimer))
      ))

      assert.strictEqual(initialName, driftedName)
      assert.notStrictEqual(
        initialTimer.operationDigest,
        driftedTimer.operationDigest
      )
      assert.notStrictEqual(initialName, renewedName)

      const initialDeferred = yield* Operation.prepare(
        preparedOccurrence,
        deferred(0)
      )
      const driftedDeferred = yield* Operation.prepare(
        preparedOccurrence,
        deferred(0, digest("e"))
      )
      const changedErrorCodec = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...deferred(0),
          errorCodecKey: "approval-error@2"
        }
      )
      assert.strictEqual(
        success(NativeName.name(
          success(Operation.nativeCoordinates(initialDeferred))
        )),
        success(NativeName.name(
          success(Operation.nativeCoordinates(driftedDeferred))
        ))
      )
      assert.notStrictEqual(
        initialDeferred.operationDigest,
        driftedDeferred.operationDigest
      )
      assert.notStrictEqual(
        initialDeferred.operationDigest,
        changedErrorCodec.operationDigest
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("round trips every closed activity purpose and exact result contract", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const builtIn = (
        schema:
          | "Never"
          | "RetryClassification"
          | "RecordedRetryDelay"
          | "CanonicalTimestamp"
      ) => ({
        _tag: "BuiltIn" as const,
        contractReferenceVersion: 1 as const,
        vocabularyVersion: 2 as const,
        schema
      })
      const specifications = [
        activity(1),
        {
          ...activity(1),
          operationId: "classify-failure",
          purpose: {
            _tag: "RetryClassifier",
            purposeVersion: 1,
            failedActivityDigest: digest("4"),
            classifierKey: "default-classifier@1",
            classifierBuildDigest: digest("5")
          },
          successContract: builtIn("RetryClassification"),
          errorContract: builtIn("Never")
        },
        {
          ...activity(1),
          operationId: "select-retry-delay",
          purpose: {
            _tag: "RetryDelaySelection",
            purposeVersion: 1,
            failedActivityDigest: digest("4"),
            classificationActivityDigest: digest("6")
          },
          successContract: builtIn("RecordedRetryDelay"),
          errorContract: builtIn("Never")
        },
        {
          ...activity(1),
          operationId: "observe-failure-time",
          purpose: {
            _tag: "TimeObservation",
            purposeVersion: 1,
            ownerOperationDigest: digest("4"),
            observationKind: "Failure"
          },
          successContract: builtIn("CanonicalTimestamp"),
          errorContract: builtIn("Never")
        }
      ]

      for (const specification of specifications) {
        const prepared = yield* Operation.prepare(
          preparedOccurrence,
          specification
        )
        const verified = yield* Operation.verify({
          document: prepared.document,
          operationDigest: prepared.operationDigest
        })
        assert.deepStrictEqual(verified, prepared)
        assert.strictEqual(
          verified.operationDigest,
          prepared.operationDigest
        )
      }

      const failureObservation = yield* Operation.prepare(
        preparedOccurrence,
        specifications[3]
      )
      const initialObservation = yield* Operation.prepare(
        preparedOccurrence,
        {
          ...specifications[3],
          purpose: {
            ...specifications[3]!.purpose,
            observationKind: "Initial"
          }
        }
      )
      assert.notStrictEqual(
        failureObservation.operationDigest,
        initialObservation.operationDigest
      )
      assert.strictEqual(
        success(NativeName.name(
          success(Operation.nativeCoordinates(failureObservation))
        )),
        success(NativeName.name(
          success(Operation.nativeCoordinates(initialObservation))
        ))
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("verifies persisted pins and rejects occurrence or operation substitution", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const prepared = yield* Operation.prepare(
        preparedOccurrence,
        activity(1)
      )
      const verified = yield* Operation.verify({
        document: prepared.document,
        operationDigest: prepared.operationDigest
      })
      assert.deepStrictEqual(verified, prepared)
      assert.isTrue(Operation.isPrepared(verified))

      const changedOperation = yield* Operation.verify({
        document: {
          ...prepared.document,
          input: {
            _tag: "Inline",
            value: { documentId: 43 }
          }
        },
        operationDigest: prepared.operationDigest
      }).pipe(Effect.flip)
      assert.strictEqual(changedOperation._tag, "SemanticOperationError")
      if (changedOperation._tag === "SemanticOperationError") {
        assert.strictEqual(
          changedOperation.code,
          Operation.ErrorCodes.DigestMismatch
        )
      }

      const changedOccurrence = yield* Operation.verify({
        document: {
          ...prepared.document,
          occurrence: {
            ...prepared.document.occurrence,
            document: {
              ...prepared.document.occurrence.document,
              activation: 3
            }
          }
        },
        operationDigest: prepared.operationDigest
      }).pipe(Effect.flip)
      assert.strictEqual(
        changedOccurrence._tag,
        "SemanticOccurrenceError"
      )
      if (changedOccurrence._tag === "SemanticOccurrenceError") {
        assert.strictEqual(
          changedOccurrence.code,
          Occurrence.ErrorCodes.DigestMismatch
        )
      }
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("requires occurrence provenance and rejects hostile or invalid specs", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* occurrence()
      const copiedOccurrence = { ...preparedOccurrence }
      const unprepared = yield* Operation.prepare(
        copiedOccurrence,
        activity(1)
      ).pipe(Effect.flip)
      assert.strictEqual(unprepared._tag, "SemanticOperationError")
      if (unprepared._tag === "SemanticOperationError") {
        assert.strictEqual(
          unprepared.code,
          Operation.ErrorCodes.UnpreparedOccurrence
        )
      }

      let reads = 0
      const hostile = {
        ...activity(1),
        get operationId() {
          reads++
          return "invoke-handler"
        }
      }
      const invalidBuiltIn = {
        ...activity(1),
        operationId: "classify-failure",
        purpose: {
          _tag: "RetryClassifier",
          purposeVersion: 1,
          failedActivityDigest: digest("4"),
          classifierKey: "default-classifier@1",
          classifierBuildDigest: digest("5")
        },
        successContract: {
          _tag: "BuiltIn",
          contractReferenceVersion: 1,
          vocabularyVersion: 2,
          schema: "SomethingElse"
        },
        errorContract: {
          _tag: "BuiltIn",
          contractReferenceVersion: 1,
          vocabularyVersion: 2,
          schema: "Never"
        }
      }
      const invalidSpecs = [
        hostile,
        { ...activity(1), forged: true },
        activity(0),
        {
          ...activity(1),
          purpose: {
            _tag: "CustomHandler",
            purposeVersion: 1
          }
        },
        invalidBuiltIn,
        {
          ...invalidBuiltIn,
          successContract: {
            _tag: "BuiltIn",
            contractReferenceVersion: 1,
            vocabularyVersion: 2,
            schema: "RetryClassification",
            forged: true
          }
        },
        {
          ...invalidBuiltIn,
          successContract: {
            _tag: "BuiltIn",
            contractReferenceVersion: 1,
            vocabularyVersion: 2,
            schema: "CanonicalTimestamp"
          }
        },
        {
          ...invalidBuiltIn,
          successContract: {
            _tag: "BuiltIn",
            contractReferenceVersion: 1,
            vocabularyVersion: 1,
            schema: "RetryClassification"
          }
        },
        {
          ...activity(1),
          operationId: "observe-time",
          purpose: {
            _tag: "TimeObservation",
            purposeVersion: 1,
            ownerOperationDigest: digest("4"),
            observationKind: "Arbitrary"
          },
          successContract: {
            _tag: "BuiltIn",
            contractReferenceVersion: 1,
            vocabularyVersion: 2,
            schema: "CanonicalTimestamp"
          },
          errorContract: {
            _tag: "BuiltIn",
            contractReferenceVersion: 1,
            vocabularyVersion: 2,
            schema: "Never"
          }
        },
        timer(0, 0),
        deferred(-1)
      ]
      for (const spec of invalidSpecs) {
        const rejected = yield* Operation.prepare(
          preparedOccurrence,
          spec
        ).pipe(Effect.flip)
        assert.strictEqual(rejected._tag, "SemanticOperationError")
        if (rejected._tag === "SemanticOperationError") {
          assert.strictEqual(
            rejected.code,
            Operation.ErrorCodes.InvalidSpec
          )
        }
      }
      assert.strictEqual(reads, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))
})
