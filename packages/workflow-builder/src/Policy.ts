/**
 * Declarative, portable retry and timeout policy for plan nodes.
 *
 * Policies are plain JSON data pinned into a compiled plan, never mutable
 * code, so a running plan keeps the retry meaning it was admitted with. The
 * engine derives every backoff delay deterministically from the committed
 * policy and the failing attempt number, which makes retry scheduling
 * replay-safe without recording each decision separately.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"

const strictParseOptions = { onExcessProperty: "error" } as const

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Retry policy for a node's business failures.
 *
 * **Details**
 *
 * `maxAttempts` counts every attempt including the first; `1` disables
 * retries. Delays grow exponentially from `initialDelayMillis` by
 * `backoffFactor`, bounded by `maxDelayMillis`. Failures whose typed `_tag`
 * appears in `nonRetryableTags` terminate the retry loop immediately.
 *
 * Attempt timeouts are retried like any other failure; defects and
 * interruption are never business retries.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Retry = Schema.Struct({
  maxAttempts: PositiveInt,
  initialDelayMillis: Schema.optionalKey(NonNegativeInt),
  backoffFactor: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
  maxDelayMillis: Schema.optionalKey(PositiveInt),
  nonRetryableTags: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
}).annotate({
  identifier: "WorkflowRetryPolicy",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Retry}.
 *
 * @category models
 * @since 4.0.0
 */
export type Retry = Schema.Schema.Type<typeof Retry>

/**
 * Independent timeout dimensions for one node.
 *
 * **Details**
 *
 * `attemptMillis` bounds a single attempt from handler start to completion.
 * `totalMillis` bounds the whole node from first schedule to final outcome,
 * including retries and backoff waits. A timeout is a distinct engine outcome:
 * it is not a business failure and is never routed through a node's `error`
 * outcome.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timeouts = Schema.Struct({
  attemptMillis: Schema.optionalKey(PositiveInt),
  totalMillis: Schema.optionalKey(PositiveInt)
}).annotate({
  identifier: "WorkflowTimeoutPolicy",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Timeouts}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timeouts = Schema.Schema.Type<typeof Timeouts>

/**
 * Complete execution policy attachable to a plan node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Policy = Schema.Struct({
  retry: Schema.optionalKey(Retry),
  timeouts: Schema.optionalKey(Timeouts)
}).annotate({
  identifier: "WorkflowNodePolicy",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Policy}.
 *
 * @category models
 * @since 4.0.0
 */
export type Policy = Schema.Schema.Type<typeof Policy>

/**
 * The policy applied when a node declares nothing: one attempt, no timeouts.
 *
 * @category constants
 * @since 4.0.0
 */
export const defaultRetry: Retry = Object.freeze({ maxAttempts: 1 })

/**
 * Merges a plan-authored policy over a node definition's default policy.
 *
 * **Details**
 *
 * `retry` and `timeouts` are replaced wholesale rather than field-merged, so
 * an end user overriding retry behavior sees exactly what they wrote instead
 * of a mixture of two documents.
 *
 * @category combinators
 * @since 4.0.0
 */
export const merge = (defaults: Policy | undefined, override: Policy | undefined): Policy => ({
  ...(override?.retry !== undefined
    ? { retry: override.retry }
    : defaults?.retry !== undefined
    ? { retry: defaults.retry }
    : undefined),
  ...(override?.timeouts !== undefined
    ? { timeouts: override.timeouts }
    : defaults?.timeouts !== undefined
    ? { timeouts: defaults.timeouts }
    : undefined)
})

/**
 * Tests whether a typed failure tag is retryable under a policy.
 *
 * @category evaluation
 * @since 4.0.0
 */
export const isRetryableTag = (retry: Retry, tag: string | undefined): boolean =>
  tag === undefined || retry.nonRetryableTags === undefined || !retry.nonRetryableTags.includes(tag)

/**
 * Computes the deterministic backoff delay after a failed attempt.
 *
 * **Details**
 *
 * `failedAttempt` is one-based. The delay before attempt `n + 1` is
 * `initialDelayMillis * backoffFactor^(n - 1)`, capped by `maxDelayMillis`
 * and rounded down to whole milliseconds. Without `initialDelayMillis` the
 * retry is immediate.
 *
 * @category evaluation
 * @since 4.0.0
 */
export const delayMillis = (retry: Retry, failedAttempt: number): number => {
  const initial = retry.initialDelayMillis ?? 0
  if (initial <= 0) {
    return 0
  }
  const factor = retry.backoffFactor ?? 2
  const exponent = Math.max(0, failedAttempt - 1)
  const raw = initial * Math.pow(factor, exponent)
  const capped = retry.maxDelayMillis === undefined ? raw : Math.min(raw, retry.maxDelayMillis)
  return Number.isFinite(capped) ? Math.floor(capped) : retry.maxDelayMillis ?? Number.MAX_SAFE_INTEGER
}
