/**
 * Immutable retry and timeout policy admitted for semantic activity attempts.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const PositiveSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Disables one activity timeout dimension explicitly.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeoutDisabled = Schema.TaggedStruct("Disabled", {}).annotate({
  identifier: "WorkflowActivityTimeoutDisabled",
  parseOptions: strictParseOptions
})

/**
 * Enables one activity timeout after a positive bounded duration.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeoutAfter = Schema.TaggedStruct("After", {
  durationMillis: ProtocolV2Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityTimeoutAfter",
  parseOptions: strictParseOptions
})

/**
 * An explicitly enabled or disabled activity timeout dimension.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timeout = Schema.Union([
  TimeoutDisabled,
  TimeoutAfter
]).annotate({ identifier: "WorkflowActivityTimeout" })

/**
 * The decoded type of {@link Timeout}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timeout = Schema.Schema.Type<typeof Timeout>

/**
 * Built-in immutable classification choices for semantic retry version `1`.
 *
 * **Details**
 *
 * Version `1` deliberately avoids a code predicate whose later deployment
 * could reinterpret retained failures. A future classifier adds a new policy
 * version instead of changing these meanings.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryOn = Schema.Struct({
  encodedFailure: Schema.Boolean,
  scheduleToStartTimeout: Schema.Boolean,
  startToCloseTimeout: Schema.Boolean
}).annotate({
  identifier: "WorkflowActivityRetryOnV1",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryOn}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryOn = Schema.Schema.Type<typeof RetryOn>

/**
 * A fixed semantic retry delay selected without consulting mutable code.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FixedBackoff = Schema.TaggedStruct("Fixed", {
  delayMillis: ProtocolV2Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityFixedBackoffV1",
  parseOptions: strictParseOptions
})

/**
 * The only jitter policy admitted by policy version `1`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NoJitter = Schema.TaggedStruct("None", {}).annotate({
  identifier: "WorkflowActivityNoJitterV1",
  parseOptions: strictParseOptions
})

/**
 * A complete immutable semantic retry policy.
 *
 * **Details**
 *
 * `maximumAttempts` includes the initial attempt. Worker redelivery and lease
 * changes do not consume this budget because they are operational generations,
 * not semantic attempts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryPolicy = Schema.Struct({
  retryVersion: Schema.Literal(1),
  maximumAttempts: PositiveSafeInt,
  classifierVersion: Schema.Literal(1),
  retryOn: RetryOn,
  backoff: FixedBackoff,
  jitter: NoJitter
}).annotate({
  identifier: "WorkflowActivityRetryPolicyV1",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryPolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryPolicy = Schema.Schema.Type<typeof RetryPolicy>

/**
 * Independent queue, attempt, and total semantic activity timeouts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeoutPolicy = Schema.Struct({
  scheduleToStart: Timeout,
  startToClose: Timeout,
  scheduleToClose: Timeout
}).annotate({
  identifier: "WorkflowActivityTimeoutPolicyV1",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimeoutPolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimeoutPolicy = Schema.Schema.Type<typeof TimeoutPolicy>

/**
 * The first immutable activity policy format used by execution protocol `2`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Policy = Schema.Struct({
  policyVersion: Schema.Literal(1),
  retry: RetryPolicy,
  timeouts: TimeoutPolicy
}).annotate({
  identifier: "WorkflowActivityPolicyV1",
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
 * Raised when unknown activity policy data is not strict admitted JSON.
 *
 * @category errors
 * @since 4.0.0
 */
export class PolicyValidationError extends Schema.TaggedErrorClass<PolicyValidationError>(
  "@effect/workflow-builder/ActivityPolicy/PolicyValidationError"
)("PolicyValidationError", {
  reason: Schema.Literals(["InvalidJson", "InvalidSchema"]),
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const decodePolicy = Schema.decodeUnknownResult(Policy, strictParseOptions)

/**
 * Detaches and validates an immutable activity policy without invoking accessors.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown
): Result.Result<Policy, PolicyValidationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(
      new PolicyValidationError({
        reason: "InvalidJson",
        message: `Activity policy must be strict JSON: ${snapshot.failure.message}`,
        details: {
          snapshotError: snapshot.failure.message,
          path: [...snapshot.failure.path]
        }
      })
    )
  }

  let decoded: ReturnType<typeof decodePolicy>
  try {
    decoded = decodePolicy(snapshot.success)
  } catch {
    return Result.fail(
      new PolicyValidationError({
        reason: "InvalidSchema",
        message: "Activity policy schema validation threw unexpectedly"
      })
    )
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new PolicyValidationError({
        reason: "InvalidSchema",
        message: "Invalid activity policy",
        details: { parseError: decoded.failure.message }
      })
    )
  }
  return Result.succeed(snapshot.success as unknown as Policy)
}
