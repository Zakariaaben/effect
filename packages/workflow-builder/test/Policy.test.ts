import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as Policy from "../src/Policy.ts"

describe("Policy", () => {
  describe("delayMillis", () => {
    it("retries immediately without an initial delay", () => {
      assert.strictEqual(Policy.delayMillis({ maxAttempts: 3 }, 1), 0)
      assert.strictEqual(Policy.delayMillis({ maxAttempts: 3 }, 7), 0)
      assert.strictEqual(Policy.delayMillis({ maxAttempts: 3, initialDelayMillis: 0 }, 2), 0)
      assert.strictEqual(Policy.delayMillis(Policy.defaultRetry, 1), 0)
    })

    it("grows exponentially from the initial delay", () => {
      const retry: Policy.Retry = { maxAttempts: 5, initialDelayMillis: 100, backoffFactor: 2 }
      assert.strictEqual(Policy.delayMillis(retry, 1), 100)
      assert.strictEqual(Policy.delayMillis(retry, 2), 200)
      assert.strictEqual(Policy.delayMillis(retry, 3), 400)
    })

    it("defaults the backoff factor to 2 and floors fractional results", () => {
      const defaulted: Policy.Retry = { maxAttempts: 4, initialDelayMillis: 100 }
      assert.strictEqual(Policy.delayMillis(defaulted, 1), 100)
      assert.strictEqual(Policy.delayMillis(defaulted, 2), 200)
      assert.strictEqual(Policy.delayMillis(defaulted, 3), 400)

      const fractional: Policy.Retry = { maxAttempts: 4, initialDelayMillis: 100, backoffFactor: 1.5 }
      assert.strictEqual(Policy.delayMillis(fractional, 3), 225)
      assert.strictEqual(Policy.delayMillis(fractional, 4), 337)
    })

    it("caps delays at maxDelayMillis", () => {
      const retry: Policy.Retry = {
        maxAttempts: 10,
        initialDelayMillis: 100,
        backoffFactor: 2,
        maxDelayMillis: 250
      }
      assert.strictEqual(Policy.delayMillis(retry, 1), 100)
      assert.strictEqual(Policy.delayMillis(retry, 2), 200)
      assert.strictEqual(Policy.delayMillis(retry, 3), 250)
      assert.strictEqual(Policy.delayMillis(retry, 9), 250)
    })

    it("guards non-finite growth deterministically", () => {
      const capped: Policy.Retry = {
        maxAttempts: 3,
        initialDelayMillis: 100,
        maxDelayMillis: 30_000
      }
      assert.strictEqual(Policy.delayMillis(capped, 5_000), 30_000)

      const uncapped: Policy.Retry = { maxAttempts: 3, initialDelayMillis: 100 }
      assert.strictEqual(Policy.delayMillis(uncapped, 5_000), Number.MAX_SAFE_INTEGER)
    })
  })

  describe("isRetryableTag", () => {
    it("treats untagged failures and unrestricted policies as retryable", () => {
      assert.isTrue(Policy.isRetryableTag({ maxAttempts: 3 }, undefined))
      assert.isTrue(Policy.isRetryableTag({ maxAttempts: 3, nonRetryableTags: ["Fatal"] }, undefined))
      assert.isTrue(Policy.isRetryableTag({ maxAttempts: 3 }, "Fatal"))
    })

    it("terminates retries only for listed tags", () => {
      const retry: Policy.Retry = { maxAttempts: 3, nonRetryableTags: ["Fatal", "Rejected"] }
      assert.isFalse(Policy.isRetryableTag(retry, "Fatal"))
      assert.isFalse(Policy.isRetryableTag(retry, "Rejected"))
      assert.isTrue(Policy.isRetryableTag(retry, "Transient"))
    })
  })

  describe("merge", () => {
    const defaults: Policy.Policy = {
      retry: { maxAttempts: 3, initialDelayMillis: 250 },
      timeouts: { attemptMillis: 1_000, totalMillis: 5_000 }
    }

    it("replaces retry and timeouts wholesale rather than field-merging", () => {
      const override: Policy.Policy = { retry: { maxAttempts: 1 } }
      const merged = Policy.merge(defaults, override)

      assert.deepStrictEqual(merged, {
        retry: { maxAttempts: 1 },
        timeouts: { attemptMillis: 1_000, totalMillis: 5_000 }
      })
      assert.strictEqual(merged.retry, override.retry)
      assert.strictEqual(merged.timeouts, defaults.timeouts)
    })

    it("overrides timeouts independently of retry", () => {
      assert.deepStrictEqual(Policy.merge(defaults, { timeouts: { totalMillis: 100 } }), {
        retry: { maxAttempts: 3, initialDelayMillis: 250 },
        timeouts: { totalMillis: 100 }
      })
    })

    it("passes defaults through when the override declares nothing", () => {
      assert.deepStrictEqual(Policy.merge(defaults, undefined), defaults)
      assert.deepStrictEqual(Policy.merge(defaults, {}), defaults)
    })

    it("keeps override-only and empty merges minimal", () => {
      assert.deepStrictEqual(Policy.merge(undefined, { retry: { maxAttempts: 2 } }), {
        retry: { maxAttempts: 2 }
      })
      assert.deepStrictEqual(Policy.merge(undefined, undefined), {})
      assert.deepStrictEqual(Policy.merge({}, {}), {})
    })
  })

  describe("schemas", () => {
    const decodeRetry = Schema.decodeUnknownSync(Policy.Retry)
    const decodeTimeouts = Schema.decodeUnknownSync(Policy.Timeouts)
    const decodePolicy = Schema.decodeUnknownSync(Policy.Policy)

    it("accepts complete and minimal policy documents", () => {
      const retry = {
        maxAttempts: 3,
        initialDelayMillis: 0,
        backoffFactor: 1,
        maxDelayMillis: 1,
        nonRetryableTags: ["Fatal"]
      }
      assert.deepStrictEqual(decodeRetry(retry), retry)
      assert.deepStrictEqual(decodeRetry({ maxAttempts: 1 }), { maxAttempts: 1 })
      assert.deepStrictEqual(decodePolicy({}), {})
      assert.deepStrictEqual(
        decodePolicy({ retry: { maxAttempts: 2 }, timeouts: { attemptMillis: 10 } }),
        { retry: { maxAttempts: 2 }, timeouts: { attemptMillis: 10 } }
      )
    })

    it("rejects non-positive attempts, negative delays, and factors below 1", () => {
      assert.throws(() => decodeRetry({ maxAttempts: 0 }))
      assert.throws(() => decodeRetry({ maxAttempts: -1 }))
      assert.throws(() => decodeRetry({ maxAttempts: 1.5 }))
      assert.throws(() => decodeRetry({ maxAttempts: 3, initialDelayMillis: -1 }))
      assert.throws(() => decodeRetry({ maxAttempts: 3, maxDelayMillis: 0 }))
      assert.throws(() => decodeRetry({ maxAttempts: 3, backoffFactor: 0.5 }))
      assert.throws(() => decodeRetry({ maxAttempts: 3, nonRetryableTags: [""] }))
      assert.throws(() => decodeTimeouts({ attemptMillis: 0 }))
      assert.throws(() => decodeTimeouts({ totalMillis: -5 }))
    })

    it("rejects excess properties at every policy level", () => {
      assert.throws(() => decodeRetry({ maxAttempts: 1, unknown: true }))
      assert.throws(() => decodeTimeouts({ attemptMillis: 1, unknown: true }))
      assert.throws(() => decodePolicy({ unknown: true }))
      assert.throws(() => decodePolicy({ retry: { maxAttempts: 1, unknown: true } }))
      assert.throws(() => decodePolicy({ timeouts: { attemptMillis: 1, unknown: true } }))
    })
  })
})
