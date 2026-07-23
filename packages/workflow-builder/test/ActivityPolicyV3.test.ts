import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicy from "../src/ActivityPolicyV3.ts"
import * as Wire from "../src/ProtocolV3Wire.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const classifierBuildDigest = (): Wire.BuildDigest => Schema.decodeUnknownSync(Wire.BuildDigest)(digest("a"))

const policy = (): ActivityPolicy.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 5,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "default-error-classifier",
      classifierVersion: "1.0.0",
      buildDigest: classifierBuildDigest()
    },
    nonRetryableErrorTags: [
      "FatalError",
      "ValidationError"
    ],
    nonRetryableErrorCodes: [
      "E400",
      "E_FATAL"
    ],
    backoff: {
      _tag: "Fixed",
      delayMillis: 1_000
    },
    jitter: { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: {
      _tag: "After",
      durationMillis: 30_000
    },
    startToClose: {
      _tag: "After",
      durationMillis: 60_000
    },
    scheduleToClose: { _tag: "Disabled" }
  }
})

const retryInput = (
  failedAttempt: number,
  elapsedMillis = 0
): ActivityPolicy.RetryDelayInput => ({
  evaluationVersion: 1,
  failedAttempt,
  elapsedMillis
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) {
    throw new Error("Expected failure")
  }
  return result.failure
}

describe("ActivityPolicyV3", () => {
  it("strictly admits a detached recursively immutable V3 policy", () => {
    const source = policy()
    const admitted = success(ActivityPolicy.validate(source))

    assert.deepStrictEqual(admitted, source)
    assert.notStrictEqual(admitted, source)
    assert.notStrictEqual(admitted.retry, source.retry)
    assert.isTrue(Object.isFrozen(admitted))
    assert.isTrue(Object.isFrozen(admitted.retry))
    assert.isTrue(Object.isFrozen(admitted.retry.classifier))
    assert.isTrue(Object.isFrozen(admitted.retry.nonRetryableErrorTags))

    const mutableClassifier = source.retry.classifier as {
      classifierId: string
    }
    mutableClassifier.classifierId = "mutated"
    const mutableTags = source.retry.nonRetryableErrorTags as Array<string>
    mutableTags[0] = "ChangedError"

    assert.strictEqual(
      admitted.retry.classifier.classifierId,
      "default-error-classifier"
    )
    assert.deepStrictEqual(admitted.retry.nonRetryableErrorTags, [
      "FatalError",
      "ValidationError"
    ])

    const excess = {
      ...policy(),
      unexpected: true
    }
    assert.strictEqual(
      failure(ActivityPolicy.validate(excess)).code,
      ActivityPolicy.ValidationCodes.InvalidSchema
    )
    assert.throws(() => Schema.decodeUnknownSync(ActivityPolicy.Policy)(excess))
    assert.throws(() =>
      Schema.decodeUnknownSync(ActivityPolicy.Policy)({
        ...policy(),
        retry: {
          ...policy().retry,
          jitter: undefined
        }
      })
    )
  })

  it("pins a valid V3 classifier build and bounds every numeric field", () => {
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ActivityPolicy.Policy)(policy()),
      policy()
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ActivityPolicy.Policy)({
        ...policy(),
        retry: {
          ...policy().retry,
          classifier: {
            ...policy().retry.classifier,
            buildDigest: digest("A")
          }
        }
      })
    )

    for (
      const maximumAttempts of [
        0,
        1.5,
        Number.MAX_SAFE_INTEGER + 1
      ]
    ) {
      assert.throws(() =>
        Schema.decodeUnknownSync(ActivityPolicy.Policy)({
          ...policy(),
          retry: {
            ...policy().retry,
            maximumAttempts
          }
        })
      )
    }

    for (
      const durationMillis of [
        0,
        -1,
        1.5,
        Wire.MaximumSemanticDelayMillis + 1
      ]
    ) {
      assert.throws(() =>
        Schema.decodeUnknownSync(ActivityPolicy.Policy)({
          ...policy(),
          timeouts: {
            ...policy().timeouts,
            scheduleToStart: {
              _tag: "After",
              durationMillis
            }
          }
        })
      )
    }

    const boundary = {
      ...policy(),
      retry: {
        ...policy().retry,
        maximumAttempts: Number.MAX_SAFE_INTEGER,
        maximumElapsed: {
          _tag: "Limit",
          durationMillis: Wire.MaximumSemanticDelayMillis
        }
      },
      timeouts: {
        scheduleToStart: {
          _tag: "After",
          durationMillis: 1
        },
        startToClose: {
          _tag: "After",
          durationMillis: Wire.MaximumSemanticDelayMillis
        },
        scheduleToClose: { _tag: "Disabled" }
      }
    }
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ActivityPolicy.Policy)(boundary),
      boundary
    )
  })

  it("reports stable semantic codes for non-canonical policy values", () => {
    const invalidBackoff = {
      ...policy(),
      retry: {
        ...policy().retry,
        backoff: {
          _tag: "Exponential",
          initialDelayMillis: 11,
          multiplier: 2,
          maximumDelayMillis: 10
        }
      }
    }
    assert.strictEqual(
      failure(ActivityPolicy.validate(invalidBackoff)).code,
      ActivityPolicy.ValidationCodes.InvalidBackoffBounds
    )
    assert.throws(() => Schema.decodeUnknownSync(ActivityPolicy.Policy)(invalidBackoff))

    for (
      const jitter of [
        {
          _tag: "RecordedRange",
          minimumPermille: 1_001,
          maximumPermille: 1_500
        },
        {
          _tag: "RecordedRange",
          minimumPermille: 500,
          maximumPermille: 999
        },
        {
          _tag: "RecordedRange",
          minimumPermille: 1_500,
          maximumPermille: 500
        }
      ]
    ) {
      const invalid = {
        ...policy(),
        retry: {
          ...policy().retry,
          jitter
        }
      }
      assert.strictEqual(
        failure(ActivityPolicy.validate(invalid)).code,
        ActivityPolicy.ValidationCodes.InvalidJitterRange
      )
      assert.throws(() => Schema.decodeUnknownSync(ActivityPolicy.Policy)(invalid))
    }

    const nonCanonicalTags = {
      ...policy(),
      retry: {
        ...policy().retry,
        nonRetryableErrorTags: ["ValidationError", "FatalError"]
      }
    }
    assert.strictEqual(
      failure(ActivityPolicy.validate(nonCanonicalTags)).code,
      ActivityPolicy.ValidationCodes.NonCanonicalErrorTags
    )

    const duplicateCodes = {
      ...policy(),
      retry: {
        ...policy().retry,
        nonRetryableErrorCodes: ["E400", "E400"]
      }
    }
    assert.strictEqual(
      failure(ActivityPolicy.validate(duplicateCodes)).code,
      ActivityPolicy.ValidationCodes.NonCanonicalErrorCodes
    )
  })

  it("evaluates fixed backoff and independent attempt and elapsed budgets", () => {
    const admitted = success(
      ActivityPolicy.retryDelayRange(policy(), retryInput(1))
    )
    assert.deepStrictEqual(admitted, {
      _tag: "Retry",
      evaluationVersion: 1,
      failedAttempt: 1,
      nextAttempt: 2,
      retryOrdinal: 1,
      baseDelayMillis: 1_000,
      minimumDelayMillis: 1_000,
      maximumDelayMillis: 1_000
    })
    assert.isTrue(Object.isFrozen(admitted))

    const attemptsSpent = success(
      ActivityPolicy.retryDelayRange(policy(), retryInput(5))
    )
    assert.deepStrictEqual(attemptsSpent, {
      _tag: "DoNotRetry",
      evaluationVersion: 1,
      failedAttempt: 5,
      reason: "AttemptLimitReached"
    })

    const limited = {
      ...policy(),
      retry: {
        ...policy().retry,
        maximumElapsed: {
          _tag: "Limit",
          durationMillis: 1_500
        }
      }
    }
    assert.strictEqual(
      success(
        ActivityPolicy.retryDelayRange(limited, retryInput(1, 1_500))
      )._tag,
      "DoNotRetry"
    )
    assert.deepStrictEqual(
      success(
        ActivityPolicy.retryDelayRange(limited, retryInput(1, 1_000))
      ),
      {
        _tag: "DoNotRetry",
        evaluationVersion: 1,
        failedAttempt: 1,
        reason: "ElapsedBudgetInsufficient"
      }
    )
  })

  it("uses bounded saturating arithmetic for exponential retry ordinals", () => {
    const exponential = {
      ...policy(),
      retry: {
        ...policy().retry,
        maximumAttempts: Number.MAX_SAFE_INTEGER,
        backoff: {
          _tag: "Exponential",
          initialDelayMillis: 3,
          multiplier: 2,
          maximumDelayMillis: 20
        }
      }
    }
    const expected = [3, 6, 12, 20, 20]
    for (let failedAttempt = 1; failedAttempt <= expected.length; failedAttempt++) {
      const decision = success(ActivityPolicy.retryDelayRange(
        exponential,
        retryInput(failedAttempt)
      ))
      assert.strictEqual(decision._tag, "Retry")
      if (decision._tag === "Retry") {
        assert.strictEqual(
          decision.baseDelayMillis,
          expected[failedAttempt - 1]
        )
      }
    }

    const saturating = {
      ...policy(),
      retry: {
        ...policy().retry,
        maximumAttempts: Number.MAX_SAFE_INTEGER,
        backoff: {
          _tag: "Exponential",
          initialDelayMillis: 1,
          multiplier: Number.MAX_SAFE_INTEGER,
          maximumDelayMillis: Wire.MaximumSemanticDelayMillis
        }
      }
    }
    const decision = success(ActivityPolicy.retryDelayRange(
      saturating,
      retryInput(Number.MAX_SAFE_INTEGER - 1)
    ))
    assert.strictEqual(decision._tag, "Retry")
    if (decision._tag === "Retry") {
      assert.strictEqual(
        decision.baseDelayMillis,
        Wire.MaximumSemanticDelayMillis
      )
      assert.strictEqual(decision.nextAttempt, Number.MAX_SAFE_INTEGER)
    }

    const zeroBase = {
      ...saturating,
      retry: {
        ...saturating.retry,
        backoff: {
          _tag: "Exponential",
          initialDelayMillis: 0,
          multiplier: 2,
          maximumDelayMillis: Wire.MaximumSemanticDelayMillis
        }
      }
    }
    const zero = success(ActivityPolicy.retryDelayRange(
      zeroBase,
      retryInput(Number.MAX_SAFE_INTEGER - 1)
    ))
    assert.strictEqual(zero._tag, "Retry")
    if (zero._tag === "Retry") {
      assert.strictEqual(zero.baseDelayMillis, 0)
    }
  })

  it("computes replay-deterministic recorded jitter ranges without entropy", () => {
    const jittered = {
      ...policy(),
      retry: {
        ...policy().retry,
        backoff: {
          _tag: "Fixed",
          delayMillis: 1_001
        },
        jitter: {
          _tag: "RecordedRange",
          minimumPermille: 500,
          maximumPermille: 1_500
        }
      }
    }

    const originalRandom = Math.random
    Math.random = () => {
      throw new Error("ActivityPolicyV3 must not sample entropy")
    }
    try {
      const first = success(
        ActivityPolicy.retryDelayRange(jittered, retryInput(1))
      )
      const second = success(
        ActivityPolicy.retryDelayRange(jittered, retryInput(1))
      )
      assert.deepStrictEqual(first, second)
      assert.deepStrictEqual(first, {
        _tag: "Retry",
        evaluationVersion: 1,
        failedAttempt: 1,
        nextAttempt: 2,
        retryOrdinal: 1,
        baseDelayMillis: 1_001,
        minimumDelayMillis: 500,
        maximumDelayMillis: 1_502
      })
    } finally {
      Math.random = originalRandom
    }

    const budgetCapped = {
      ...jittered,
      retry: {
        ...jittered.retry,
        maximumElapsed: {
          _tag: "Limit",
          durationMillis: 2_000
        }
      }
    }
    const capped = success(ActivityPolicy.retryDelayRange(
      budgetCapped,
      retryInput(1, 600)
    ))
    assert.strictEqual(capped._tag, "Retry")
    if (capped._tag === "Retry") {
      assert.strictEqual(capped.minimumDelayMillis, 500)
      assert.strictEqual(capped.maximumDelayMillis, 1_400)
    }
  })

  it("validates inclusive externally recorded delays during execution and replay", () => {
    const jittered = {
      ...policy(),
      retry: {
        ...policy().retry,
        jitter: {
          _tag: "RecordedRange",
          minimumPermille: 500,
          maximumPermille: 1_500
        }
      }
    }

    for (const selected of [500, 1_000, 1_500]) {
      const recorded = success(ActivityPolicy.admitRecordedRetryDelay(
        jittered,
        retryInput(1),
        selected
      ))
      assert.strictEqual(recorded.selectedDelayMillis, selected)
      assert.isTrue(Object.isFrozen(recorded))
      assert.deepStrictEqual(
        success(ActivityPolicy.admitRecordedRetryDelay(
          jittered,
          retryInput(1),
          recorded.selectedDelayMillis
        )),
        recorded
      )
    }

    for (const selected of [499, 1_501]) {
      assert.strictEqual(
        failure(ActivityPolicy.admitRecordedRetryDelay(
          jittered,
          retryInput(1),
          selected
        )).code,
        ActivityPolicy.EvaluationCodes.RecordedDelayOutsideRange
      )
    }
    for (const selected of [-1, 0.5, Number.NaN]) {
      assert.strictEqual(
        failure(ActivityPolicy.admitRecordedRetryDelay(
          jittered,
          retryInput(1),
          selected
        )).code,
        ActivityPolicy.EvaluationCodes.InvalidRecordedDelay
      )
    }
    assert.strictEqual(
      failure(ActivityPolicy.admitRecordedRetryDelay(
        jittered,
        retryInput(5),
        1_000
      )).code,
      ActivityPolicy.EvaluationCodes.RetryNotAllowed
    )
  })

  it("rejects forged contradictory retry range and recorded-delay records", () => {
    const truncatedRange = {
      _tag: "Retry",
      evaluationVersion: 1,
      failedAttempt: 1,
      nextAttempt: 2,
      retryOrdinal: 1,
      baseDelayMillis: 1_000,
      minimumDelayMillis: 500,
      maximumDelayMillis: 750
    }
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ActivityPolicy.RetryDelayRange)(truncatedRange),
      truncatedRange
    )

    for (
      const forged of [
        { ...truncatedRange, nextAttempt: 3 },
        { ...truncatedRange, retryOrdinal: 2 },
        {
          ...truncatedRange,
          minimumDelayMillis: 751,
          maximumDelayMillis: 750
        },
        {
          ...truncatedRange,
          minimumDelayMillis: 1_001,
          maximumDelayMillis: 1_100
        },
        {
          ...truncatedRange,
          failedAttempt: Number.MAX_SAFE_INTEGER,
          nextAttempt: Number.MAX_SAFE_INTEGER,
          retryOrdinal: Number.MAX_SAFE_INTEGER
        }
      ]
    ) {
      assert.throws(() => Schema.decodeUnknownSync(ActivityPolicy.RetryDelayRange)(forged))
    }

    const recorded = {
      recordingVersion: 1,
      failedAttempt: 1,
      nextAttempt: 2,
      retryOrdinal: 1,
      baseDelayMillis: 1_000,
      minimumDelayMillis: 500,
      maximumDelayMillis: 750,
      selectedDelayMillis: 625
    }
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ActivityPolicy.RecordedRetryDelay)(recorded),
      recorded
    )

    for (
      const forged of [
        { ...recorded, nextAttempt: 3 },
        { ...recorded, retryOrdinal: 2 },
        {
          ...recorded,
          minimumDelayMillis: 751,
          maximumDelayMillis: 750
        },
        {
          ...recorded,
          minimumDelayMillis: 1_001,
          maximumDelayMillis: 1_100
        },
        { ...recorded, selectedDelayMillis: 499 },
        { ...recorded, selectedDelayMillis: 751 }
      ]
    ) {
      assert.throws(() => Schema.decodeUnknownSync(ActivityPolicy.RecordedRetryDelay)(forged))
    }
  })

  it("applies explicit non-retryable identities before requiring the pinned classifier", () => {
    const byTag = success(ActivityPolicy.failureDisposition(policy(), {
      failureIdentityVersion: 1,
      errorTag: "FatalError",
      errorCode: "E400"
    }))
    assert.deepStrictEqual(byTag, {
      _tag: "ExplicitNonRetryable",
      matchedBy: "ErrorTag"
    })

    const byCode = success(ActivityPolicy.failureDisposition(policy(), {
      failureIdentityVersion: 1,
      errorTag: "RemoteError",
      errorCode: "E400"
    }))
    assert.deepStrictEqual(byCode, {
      _tag: "ExplicitNonRetryable",
      matchedBy: "ErrorCode"
    })

    const classifier = success(ActivityPolicy.failureDisposition(policy(), {
      failureIdentityVersion: 1,
      errorTag: "RemoteError",
      errorCode: null
    }))
    assert.deepStrictEqual(classifier, {
      _tag: "ClassifierRequired",
      classifierId: "default-error-classifier",
      classifierVersion: "1.0.0",
      buildDigest: classifierBuildDigest()
    })
    assert.isTrue(Object.isFrozen(classifier))
  })

  it("rejects accessors and hostile proxies without invoking property getters", () => {
    let getterCalls = 0
    const accessorPolicy = Object.defineProperty({}, "policyVersion", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 3
      }
    })
    assert.strictEqual(
      failure(ActivityPolicy.validate(accessorPolicy)).code,
      ActivityPolicy.ValidationCodes.InvalidJson
    )

    const nestedAccessor = policy()
    Object.defineProperty(nestedAccessor.retry.classifier, "classifierId", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls++
        return "hostile"
      }
    })
    assert.strictEqual(
      failure(ActivityPolicy.validate(nestedAccessor)).code,
      ActivityPolicy.ValidationCodes.InvalidJson
    )

    const accessorInput = Object.defineProperty({}, "failedAttempt", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 1
      }
    })
    assert.strictEqual(
      failure(
        ActivityPolicy.retryDelayRange(policy(), accessorInput)
      ).code,
      ActivityPolicy.EvaluationCodes.InvalidRetryInput
    )

    const accessorFailure = Object.defineProperty({}, "errorTag", {
      enumerable: true,
      get: () => {
        getterCalls++
        return "FatalError"
      }
    })
    assert.strictEqual(
      failure(
        ActivityPolicy.failureDisposition(policy(), accessorFailure)
      ).code,
      ActivityPolicy.EvaluationCodes.InvalidFailureIdentity
    )
    assert.strictEqual(getterCalls, 0)

    const throwingProxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("hostile proxy")
      }
    })
    assert.strictEqual(
      failure(ActivityPolicy.validate(throwingProxy)).code,
      ActivityPolicy.ValidationCodes.InvalidJson
    )
    assert.strictEqual(
      failure(
        ActivityPolicy.retryDelayRange(policy(), throwingProxy)
      ).code,
      ActivityPolicy.EvaluationCodes.InvalidRetryInput
    )
  })

  it("rejects excess evaluation and failure properties with stable codes", () => {
    assert.strictEqual(
      failure(ActivityPolicy.retryDelayRange(policy(), {
        ...retryInput(1),
        entropySeed: "not-admitted"
      })).code,
      ActivityPolicy.EvaluationCodes.InvalidRetryInput
    )
    assert.strictEqual(
      failure(ActivityPolicy.failureDisposition(policy(), {
        failureIdentityVersion: 1,
        errorTag: "RemoteError",
        errorCode: null,
        retryable: true
      })).code,
      ActivityPolicy.EvaluationCodes.InvalidFailureIdentity
    )
    assert.strictEqual(
      failure(ActivityPolicy.retryDelayRange({
        ...policy(),
        retry: {
          ...policy().retry,
          extra: true
        }
      }, retryInput(1))).code,
      ActivityPolicy.EvaluationCodes.InvalidPolicy
    )
  })
})
