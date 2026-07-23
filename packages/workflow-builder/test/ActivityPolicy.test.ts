import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const policy = (): ActivityPolicy.Policy => ({
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: 3,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: true,
      scheduleToStartTimeout: true,
      startToCloseTimeout: false
    },
    backoff: { _tag: "Fixed", delayMillis: 1_000 },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: { _tag: "After", durationMillis: 30_000 },
    startToClose: { _tag: "After", durationMillis: 60_000 },
    scheduleToClose: { _tag: "Disabled" }
  }
})

describe("ActivityPolicy", () => {
  it("strictly admits a complete immutable policy without semantic defaults", () => {
    const admitted = ActivityPolicy.validate(policy())
    assert.isTrue(Result.isSuccess(admitted))
    if (Result.isFailure(admitted)) {
      throw admitted.failure
    }
    assert.deepStrictEqual(admitted.success, policy())
    assert.isTrue(Object.isFrozen(admitted.success))
    assert.isTrue(Object.isFrozen(admitted.success.retry.retryOn))

    assert.throws(() =>
      Schema.decodeUnknownSync(ActivityPolicy.Policy)({
        ...policy(),
        retry: {
          ...policy().retry,
          jitter: undefined
        }
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ActivityPolicy.Policy)({
        ...policy(),
        extra: true
      })
    )
  })

  it("bounds attempts and semantic timeout durations independently", () => {
    for (const maximumAttempts of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() =>
        Schema.decodeUnknownSync(ActivityPolicy.Policy)({
          ...policy(),
          retry: { ...policy().retry, maximumAttempts }
        })
      )
    }
    for (
      const durationMillis of [
        0,
        -1,
        1.5,
        ProtocolV2Wire.MaximumSemanticDelayMillis + 1,
        Number.MAX_SAFE_INTEGER + 1
      ]
    ) {
      assert.throws(() =>
        Schema.decodeUnknownSync(ActivityPolicy.Policy)({
          ...policy(),
          timeouts: {
            ...policy().timeouts,
            startToClose: { _tag: "After", durationMillis }
          }
        })
      )
    }
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ActivityPolicy.Timeout)({ _tag: "Disabled" }),
      { _tag: "Disabled" }
    )
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ActivityPolicy.Timeout)({
        _tag: "After",
        durationMillis: ProtocolV2Wire.MaximumSemanticDelayMillis
      }),
      {
        _tag: "After",
        durationMillis: ProtocolV2Wire.MaximumSemanticDelayMillis
      }
    )
  })

  it("rejects hostile containers without invoking accessors", () => {
    let reads = 0
    const hostile = Object.defineProperty({}, "policyVersion", {
      enumerable: true,
      get: () => {
        reads++
        return 1
      }
    })
    const admitted = ActivityPolicy.validate(hostile)
    assert.isTrue(Result.isFailure(admitted))
    if (Result.isSuccess(admitted)) {
      throw new Error("Expected hostile policy rejection")
    }
    assert.strictEqual(admitted.failure.reason, "InvalidJson")
    assert.strictEqual(reads, 0)
  })
})
