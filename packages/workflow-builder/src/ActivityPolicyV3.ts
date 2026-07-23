/**
 * Immutable, replay-safe activity retry and timeout policy for execution
 * protocol version `3`.
 *
 * **Details**
 *
 * Policy validation crosses a bounded descriptor-based JSON boundary, pins
 * the exact retry-classifier executable build, and admits no semantic
 * defaults. Jitter never draws randomness here: `RecordedRange` computes an
 * inclusive allowed interval and a separately recorded delay must be
 * validated against that interval during both execution and replay.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Maximum number of explicit non-retryable tags or codes in one policy list.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumNonRetryableIdentities = 256 as const

/**
 * Maximum UTF-16 length of a classifier identifier, version, error tag, or
 * error code.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumIdentityLength = 256 as const

/**
 * Permille denominator used by recorded jitter ranges.
 *
 * @category constants
 * @since 4.0.0
 */
export const JitterPermilleDenominator = 1_000 as const

/**
 * Largest recorded-jitter multiplier, equal to two times the base delay.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumJitterPermille = 2_000 as const

const BoundedIdentity = Wire.AtomicIdentifier.check(
  Schema.isMaxLength(MaximumIdentityLength)
).annotate({ identifier: "WorkflowActivityPolicyV3BoundedIdentity" })

const NonRetryableIdentities = Schema.Array(BoundedIdentity).check(
  Schema.isMaxLength(MaximumNonRetryableIdentities)
).annotate({
  identifier: "WorkflowActivityPolicyV3NonRetryableIdentities",
  parseOptions: strictParseOptions
})

const ExponentialMultiplier = Wire.PositiveSafeInt.check(
  Schema.isGreaterThanOrEqualTo(2)
).annotate({
  identifier: "WorkflowActivityPolicyV3ExponentialMultiplier"
})

const JitterPermille = Wire.NonNegativeSafeInt.check(
  Schema.isLessThanOrEqualTo(MaximumJitterPermille)
).annotate({ identifier: "WorkflowActivityPolicyV3JitterPermille" })

/**
 * Disables one activity timeout dimension explicitly.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeoutDisabled = Schema.TaggedStruct("Disabled", {}).annotate({
  identifier: "WorkflowActivityPolicyV3TimeoutDisabled",
  parseOptions: strictParseOptions
})

/**
 * Enables one activity timeout after a positive bounded duration.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeoutAfter = Schema.TaggedStruct("After", {
  durationMillis: Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityPolicyV3TimeoutAfter",
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
]).annotate({ identifier: "WorkflowActivityPolicyV3Timeout" })

/**
 * The decoded type of {@link Timeout}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timeout = Schema.Schema.Type<typeof Timeout>

/**
 * Allows retry attempts without a total elapsed-time ceiling.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ElapsedBudgetUnlimited = Schema.TaggedStruct(
  "Unlimited",
  {}
).annotate({
  identifier: "WorkflowActivityPolicyV3ElapsedBudgetUnlimited",
  parseOptions: strictParseOptions
})

/**
 * Stops retry scheduling at one total elapsed-time ceiling.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ElapsedBudgetLimit = Schema.TaggedStruct("Limit", {
  durationMillis: Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityPolicyV3ElapsedBudgetLimit",
  parseOptions: strictParseOptions
})

/**
 * The explicit maximum elapsed-time budget for semantic attempts and delays.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ElapsedBudget = Schema.Union([
  ElapsedBudgetUnlimited,
  ElapsedBudgetLimit
]).annotate({ identifier: "WorkflowActivityPolicyV3ElapsedBudget" })

/**
 * The decoded type of {@link ElapsedBudget}.
 *
 * @category models
 * @since 4.0.0
 */
export type ElapsedBudget = Schema.Schema.Type<typeof ElapsedBudget>

/**
 * Exact executable identity of the retry classifier selected by a policy.
 *
 * **Details**
 *
 * The logical identifier and version are diagnostic coordinates. The
 * `buildDigest` is the authoritative immutable executable identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryClassifierPin = Schema.Struct({
  classifierPinVersion: Schema.Literal(3),
  classifierId: BoundedIdentity,
  classifierVersion: BoundedIdentity,
  buildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowActivityPolicyV3RetryClassifierPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryClassifierPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryClassifierPin = Schema.Schema.Type<
  typeof RetryClassifierPin
>

/**
 * A fixed delay before every admitted retry.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FixedBackoff = Schema.TaggedStruct("Fixed", {
  delayMillis: Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityPolicyV3FixedBackoff",
  parseOptions: strictParseOptions
})

/**
 * Integer exponential backoff capped by a semantic maximum.
 *
 * **Details**
 *
 * The first retry uses `initialDelayMillis`; each later retry multiplies the
 * preceding base delay by `multiplier` and saturates at
 * `maximumDelayMillis`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExponentialBackoff = Schema.TaggedStruct("Exponential", {
  initialDelayMillis: Wire.SemanticDelayMillis,
  multiplier: ExponentialMultiplier,
  maximumDelayMillis: Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityPolicyV3ExponentialBackoff",
  parseOptions: strictParseOptions
})

/**
 * A fixed or bounded integer-exponential retry backoff.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Backoff = Schema.Union([
  FixedBackoff,
  ExponentialBackoff
]).annotate({ identifier: "WorkflowActivityPolicyV3Backoff" })

/**
 * The decoded type of {@link Backoff}.
 *
 * @category models
 * @since 4.0.0
 */
export type Backoff = Schema.Schema.Type<typeof Backoff>

/**
 * Selects the exact computed base delay without jitter.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NoJitter = Schema.TaggedStruct("NoJitter", {}).annotate({
  identifier: "WorkflowActivityPolicyV3NoJitter",
  parseOptions: strictParseOptions
})

/**
 * Admits an externally selected and durably recorded delay within a range.
 *
 * **Details**
 *
 * Bounds are integer permille multipliers of the base delay. A valid range
 * contains `1000`, so it always contains the unjittered base before protocol
 * duration and elapsed-budget caps are applied.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RecordedRange = Schema.TaggedStruct("RecordedRange", {
  minimumPermille: JitterPermille,
  maximumPermille: JitterPermille
}).annotate({
  identifier: "WorkflowActivityPolicyV3RecordedRange",
  parseOptions: strictParseOptions
})

/**
 * Explicit replay-safe retry jitter semantics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Jitter = Schema.Union([
  NoJitter,
  RecordedRange
]).annotate({ identifier: "WorkflowActivityPolicyV3Jitter" })

/**
 * The decoded type of {@link Jitter}.
 *
 * @category models
 * @since 4.0.0
 */
export type Jitter = Schema.Schema.Type<typeof Jitter>

const RetryPolicyStruct = Schema.Struct({
  retryPolicyVersion: Schema.Literal(3),
  maximumAttempts: Wire.PositiveSafeInt,
  maximumElapsed: ElapsedBudget,
  classifier: RetryClassifierPin,
  nonRetryableErrorTags: NonRetryableIdentities,
  nonRetryableErrorCodes: NonRetryableIdentities,
  backoff: Backoff,
  jitter: Jitter
}).annotate({
  identifier: "WorkflowActivityPolicyV3RetryPolicyStruct",
  parseOptions: strictParseOptions
})

type RetryPolicyStruct = Schema.Schema.Type<typeof RetryPolicyStruct>

interface PolicyIssue {
  readonly code: ValidationCode
  readonly message: string
  readonly path: ReadonlyArray<string | number>
}

const policyIssue = (
  code: ValidationCode,
  message: string,
  path: ReadonlyArray<string | number>
): PolicyIssue => ({ code, message, path })

const canonicalListIssue = (
  values: ReadonlyArray<string>,
  code: ValidationCode,
  path: string
): PolicyIssue | undefined => {
  for (let index = 1; index < values.length; index++) {
    if (values[index - 1]! >= values[index]!) {
      return policyIssue(
        code,
        "entries must be unique and sorted by ascending UTF-16 code-unit order",
        [path, index]
      )
    }
  }
  return undefined
}

const retryPolicyIssues = (
  retry: RetryPolicyStruct
): ReadonlyArray<PolicyIssue> => {
  const issues: Array<PolicyIssue> = []
  if (
    retry.backoff._tag === "Exponential" &&
    retry.backoff.initialDelayMillis > retry.backoff.maximumDelayMillis
  ) {
    issues.push(policyIssue(
      ValidationCodes.InvalidBackoffBounds,
      "exponential initialDelayMillis must not exceed maximumDelayMillis",
      ["backoff", "initialDelayMillis"]
    ))
  }
  if (
    retry.jitter._tag === "RecordedRange" &&
    (
      retry.jitter.minimumPermille > JitterPermilleDenominator ||
      retry.jitter.maximumPermille < JitterPermilleDenominator ||
      retry.jitter.minimumPermille > retry.jitter.maximumPermille
    )
  ) {
    issues.push(policyIssue(
      ValidationCodes.InvalidJitterRange,
      "recorded jitter bounds must be ordered and contain 1000 permille",
      ["jitter"]
    ))
  }
  const tags = canonicalListIssue(
    retry.nonRetryableErrorTags,
    ValidationCodes.NonCanonicalErrorTags,
    "nonRetryableErrorTags"
  )
  if (tags !== undefined) {
    issues.push(tags)
  }
  const codes = canonicalListIssue(
    retry.nonRetryableErrorCodes,
    ValidationCodes.NonCanonicalErrorCodes,
    "nonRetryableErrorCodes"
  )
  if (codes !== undefined) {
    issues.push(codes)
  }
  return issues
}

const toFilterIssue = (issue: PolicyIssue): Schema.FilterIssue => ({
  path: [...issue.path],
  issue: issue.message
})

/**
 * A complete immutable retry policy for execution protocol version `3`.
 *
 * **Details**
 *
 * `maximumAttempts` includes the initial attempt. Operational redelivery of
 * one semantic attempt does not consume another attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryPolicy = RetryPolicyStruct.check(
  Schema.makeFilter((retry) => retryPolicyIssues(retry).map(toFilterIssue))
).annotate({
  identifier: "WorkflowActivityPolicyV3RetryPolicy",
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
  identifier: "WorkflowActivityPolicyV3TimeoutPolicy",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimeoutPolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimeoutPolicy = Schema.Schema.Type<typeof TimeoutPolicy>

const PolicyStruct = Schema.Struct({
  policyVersion: Schema.Literal(3),
  retry: RetryPolicyStruct,
  timeouts: TimeoutPolicy
}).annotate({
  identifier: "WorkflowActivityPolicyV3PolicyStruct",
  parseOptions: strictParseOptions
})

type PolicyStruct = Schema.Schema.Type<typeof PolicyStruct>

const policyIssues = (policy: PolicyStruct): ReadonlyArray<PolicyIssue> =>
  retryPolicyIssues(policy.retry).map((issue) => ({
    ...issue,
    path: ["retry", ...issue.path]
  }))

/**
 * The immutable activity policy format for execution protocol version `3`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Policy = PolicyStruct.check(
  Schema.makeFilter((policy) => policyIssues(policy).map(toFilterIssue))
).annotate({
  identifier: "WorkflowActivityPolicyV3Policy",
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
 * Stable pure-validation failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ValidationCodes = {
  InvalidJson: "InvalidJson",
  InvalidSchema: "InvalidSchema",
  InvalidBackoffBounds: "InvalidBackoffBounds",
  InvalidJitterRange: "InvalidJitterRange",
  NonCanonicalErrorTags: "NonCanonicalErrorTags",
  NonCanonicalErrorCodes: "NonCanonicalErrorCodes"
} as const

/**
 * A stable activity-policy validation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ValidationCode = typeof ValidationCodes[keyof typeof ValidationCodes]

const ValidationCode = Schema.Literals([
  ValidationCodes.InvalidJson,
  ValidationCodes.InvalidSchema,
  ValidationCodes.InvalidBackoffBounds,
  ValidationCodes.InvalidJitterRange,
  ValidationCodes.NonCanonicalErrorTags,
  ValidationCodes.NonCanonicalErrorCodes
])

const ValidationPath = Schema.Array(Schema.Union([
  Schema.String,
  Wire.NonNegativeSafeInt
]))

/**
 * Raised when activity policy data is structurally or semantically invalid.
 *
 * @category errors
 * @since 4.0.0
 */
export class PolicyValidationError extends Schema.TaggedErrorClass<
  PolicyValidationError
>("@effect/workflow-builder/ActivityPolicyV3/PolicyValidationError")(
  "PolicyValidationError",
  {
    code: ValidationCode,
    message: Schema.NonEmptyString,
    path: ValidationPath
  },
  { parseOptions: strictParseOptions }
) {}

const validationError = (
  code: ValidationCode,
  message: string,
  path: ReadonlyArray<string | number>
): PolicyValidationError =>
  new PolicyValidationError({
    code,
    message,
    path: [...path]
  })

const decodePolicyStruct = Schema.decodeUnknownResult(
  PolicyStruct,
  strictParseOptions
)

/**
 * Detaches, recursively freezes, and validates a complete V3 activity policy
 * without invoking property accessors.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown
): Result.Result<Policy, PolicyValidationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidJson,
      `Activity policy must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }

  let decoded: ReturnType<typeof decodePolicyStruct>
  try {
    decoded = decodePolicyStruct(snapshot.success)
  } catch {
    return Result.fail(validationError(
      ValidationCodes.InvalidSchema,
      "Activity policy schema validation threw unexpectedly",
      []
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidSchema,
      `Invalid activity policy: ${decoded.failure.message}`,
      []
    ))
  }

  const issues = policyIssues(decoded.success)
  if (issues.length > 0) {
    const first = issues[0]!
    return Result.fail(validationError(first.code, first.message, first.path))
  }
  return Result.succeed(snapshot.success as unknown as Policy)
}

/**
 * Input to deterministic retry-delay evaluation after one failed semantic
 * attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryDelayInput = Schema.Struct({
  evaluationVersion: Schema.Literal(1),
  failedAttempt: Wire.PositiveSafeInt,
  elapsedMillis: Wire.SemanticDelayMillis
}).annotate({
  identifier: "WorkflowActivityPolicyV3RetryDelayInput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryDelayInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryDelayInput = Schema.Schema.Type<typeof RetryDelayInput>

/**
 * Stable reasons why a policy admits no next semantic attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryDeniedReason = Schema.Literals([
  "AttemptLimitReached",
  "ElapsedBudgetExhausted",
  "ElapsedBudgetInsufficient"
]).annotate({
  identifier: "WorkflowActivityPolicyV3RetryDeniedReason"
})

/**
 * The decoded type of {@link RetryDeniedReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryDeniedReason = Schema.Schema.Type<typeof RetryDeniedReason>

/**
 * A deterministic inclusive interval from which execution may record a retry
 * delay.
 *
 * @category schemas
 * @since 4.0.0
 */
const RetryDelayRangeStruct = Schema.TaggedStruct("Retry", {
  evaluationVersion: Schema.Literal(1),
  failedAttempt: Wire.PositiveSafeInt,
  nextAttempt: Wire.PositiveSafeInt,
  retryOrdinal: Wire.PositiveSafeInt,
  baseDelayMillis: Wire.SemanticDelayMillis,
  minimumDelayMillis: Wire.SemanticDelayMillis,
  maximumDelayMillis: Wire.SemanticDelayMillis
})

interface RetryDelayBounds {
  readonly failedAttempt: number
  readonly nextAttempt: number
  readonly retryOrdinal: number
  readonly baseDelayMillis: number
  readonly minimumDelayMillis: number
  readonly maximumDelayMillis: number
}

const retryDelayBoundsIssues = (
  value: RetryDelayBounds
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  if (
    value.failedAttempt === Number.MAX_SAFE_INTEGER ||
    value.nextAttempt !== value.failedAttempt + 1
  ) {
    issues.push({
      path: ["nextAttempt"],
      issue: "nextAttempt must be the safe integer immediately after failedAttempt"
    })
  }
  if (value.retryOrdinal !== value.failedAttempt) {
    issues.push({
      path: ["retryOrdinal"],
      issue: "retryOrdinal must equal failedAttempt"
    })
  }
  if (value.minimumDelayMillis > value.maximumDelayMillis) {
    issues.push({
      path: ["minimumDelayMillis"],
      issue: "minimumDelayMillis must not exceed maximumDelayMillis"
    })
  }
  if (value.minimumDelayMillis > value.baseDelayMillis) {
    issues.push({
      path: ["minimumDelayMillis"],
      issue: "minimumDelayMillis must not exceed baseDelayMillis"
    })
  }
  return issues
}

/**
 * A deterministic inclusive interval from which execution may record a retry
 * delay, with attempt and range invariants checked at decode time.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryDelayRange = RetryDelayRangeStruct.check(
  Schema.makeFilter(retryDelayBoundsIssues)
).annotate({
  identifier: "WorkflowActivityPolicyV3RetryDelayRange",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryDelayRange}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryDelayRange = Schema.Schema.Type<typeof RetryDelayRange>

/**
 * A deterministic decision that no retry may be scheduled.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryDenied = Schema.TaggedStruct("DoNotRetry", {
  evaluationVersion: Schema.Literal(1),
  failedAttempt: Wire.PositiveSafeInt,
  reason: RetryDeniedReason
}).annotate({
  identifier: "WorkflowActivityPolicyV3RetryDenied",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryDenied}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryDenied = Schema.Schema.Type<typeof RetryDenied>

/**
 * A retry-delay range or a deterministic budget denial.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryDelayDecision = Schema.Union([
  RetryDelayRange,
  RetryDenied
]).annotate({ identifier: "WorkflowActivityPolicyV3RetryDelayDecision" })

/**
 * The decoded type of {@link RetryDelayDecision}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryDelayDecision = Schema.Schema.Type<
  typeof RetryDelayDecision
>

/**
 * Stable retry-policy evaluation failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const EvaluationCodes = {
  InvalidPolicy: "InvalidPolicy",
  InvalidRetryInput: "InvalidRetryInput",
  InvalidFailureIdentity: "InvalidFailureIdentity",
  InvalidRecordedDelay: "InvalidRecordedDelay",
  RetryNotAllowed: "RetryNotAllowed",
  RecordedDelayOutsideRange: "RecordedDelayOutsideRange"
} as const

/**
 * A stable retry-policy evaluation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluationCode = typeof EvaluationCodes[keyof typeof EvaluationCodes]

const EvaluationCode = Schema.Literals([
  EvaluationCodes.InvalidPolicy,
  EvaluationCodes.InvalidRetryInput,
  EvaluationCodes.InvalidFailureIdentity,
  EvaluationCodes.InvalidRecordedDelay,
  EvaluationCodes.RetryNotAllowed,
  EvaluationCodes.RecordedDelayOutsideRange
])

/**
 * Raised when pure retry-policy evaluation cannot produce an admitted result.
 *
 * @category errors
 * @since 4.0.0
 */
export class PolicyEvaluationError extends Schema.TaggedErrorClass<
  PolicyEvaluationError
>("@effect/workflow-builder/ActivityPolicyV3/PolicyEvaluationError")(
  "PolicyEvaluationError",
  {
    code: EvaluationCode,
    message: Schema.NonEmptyString,
    path: ValidationPath
  },
  { parseOptions: strictParseOptions }
) {}

const evaluationError = (
  code: EvaluationCode,
  message: string,
  path: ReadonlyArray<string | number>
): PolicyEvaluationError =>
  new PolicyEvaluationError({
    code,
    message,
    path: [...path]
  })

const decodeRetryDelayInput = Schema.decodeUnknownResult(
  RetryDelayInput,
  strictParseOptions
)

const validateRetryDelayInput = (
  input: unknown
): Result.Result<RetryDelayInput, PolicyEvaluationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidRetryInput,
      `Retry input must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }
  let decoded: ReturnType<typeof decodeRetryDelayInput>
  try {
    decoded = decodeRetryDelayInput(snapshot.success)
  } catch {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidRetryInput,
      "Retry input schema validation threw unexpectedly",
      []
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(evaluationError(
      EvaluationCodes.InvalidRetryInput,
      `Invalid retry input: ${decoded.failure.message}`,
      []
    ))
    : Result.succeed(snapshot.success as unknown as RetryDelayInput)
}

const boundedMultiply = (
  value: number,
  multiplier: number,
  maximum: number
): number => {
  if (value === 0 || maximum === 0) {
    return 0
  }
  if (value >= maximum || multiplier > Math.floor(maximum / value)) {
    return maximum
  }
  return Math.min(maximum, value * multiplier)
}

const exponentialDelay = (
  backoff: Schema.Schema.Type<typeof ExponentialBackoff>,
  retryOrdinal: number
): number => {
  let delay = backoff.initialDelayMillis
  if (delay === 0) {
    return 0
  }
  let remainingMultiplications = retryOrdinal - 1
  while (
    remainingMultiplications > 0 &&
    delay < backoff.maximumDelayMillis
  ) {
    delay = boundedMultiply(
      delay,
      backoff.multiplier,
      backoff.maximumDelayMillis
    )
    remainingMultiplications--
  }
  return delay
}

const scaledFloor = (value: number, permille: number): number => {
  const quotient = Math.floor(value / JitterPermilleDenominator)
  const remainder = value % JitterPermilleDenominator
  return Math.min(
    Wire.MaximumSemanticDelayMillis,
    quotient * permille +
      Math.floor((remainder * permille) / JitterPermilleDenominator)
  )
}

const scaledCeiling = (value: number, permille: number): number => {
  const quotient = Math.floor(value / JitterPermilleDenominator)
  const remainder = value % JitterPermilleDenominator
  return Math.min(
    Wire.MaximumSemanticDelayMillis,
    quotient * permille +
      Math.ceil((remainder * permille) / JitterPermilleDenominator)
  )
}

const denied = (
  failedAttempt: number,
  reason: RetryDeniedReason
): RetryDenied =>
  Object.freeze({
    _tag: "DoNotRetry",
    evaluationVersion: 1,
    failedAttempt,
    reason
  }) as RetryDenied

/**
 * Computes the deterministic inclusive delay interval for a next attempt.
 *
 * **Details**
 *
 * The function performs bounded saturating arithmetic. It returns a denial
 * when the attempt budget is spent, the elapsed budget is already spent, or
 * even the minimum admitted jitter delay would cross the elapsed ceiling.
 * It never chooses a delay from a recorded range.
 *
 * @category evaluation
 * @since 4.0.0
 */
export const retryDelayRange = (
  policyInput: unknown,
  input: unknown
): Result.Result<RetryDelayDecision, PolicyEvaluationError> => {
  const admittedPolicy = validate(policyInput)
  if (Result.isFailure(admittedPolicy)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidPolicy,
      admittedPolicy.failure.message,
      admittedPolicy.failure.path
    ))
  }
  const admittedInput = validateRetryDelayInput(input)
  if (Result.isFailure(admittedInput)) {
    return Result.fail(admittedInput.failure)
  }

  const policy = admittedPolicy.success
  const evaluation = admittedInput.success
  if (evaluation.failedAttempt >= policy.retry.maximumAttempts) {
    return Result.succeed(denied(
      evaluation.failedAttempt,
      "AttemptLimitReached"
    ))
  }

  let remainingElapsed: number | undefined
  if (policy.retry.maximumElapsed._tag === "Limit") {
    if (
      evaluation.elapsedMillis >=
        policy.retry.maximumElapsed.durationMillis
    ) {
      return Result.succeed(denied(
        evaluation.failedAttempt,
        "ElapsedBudgetExhausted"
      ))
    }
    remainingElapsed = policy.retry.maximumElapsed.durationMillis -
      evaluation.elapsedMillis
  }

  const retryOrdinal = evaluation.failedAttempt
  const baseDelay = policy.retry.backoff._tag === "Fixed"
    ? policy.retry.backoff.delayMillis
    : exponentialDelay(policy.retry.backoff, retryOrdinal)
  let minimumDelay = baseDelay
  let maximumDelay = baseDelay
  if (policy.retry.jitter._tag === "RecordedRange") {
    minimumDelay = scaledFloor(
      baseDelay,
      policy.retry.jitter.minimumPermille
    )
    maximumDelay = scaledCeiling(
      baseDelay,
      policy.retry.jitter.maximumPermille
    )
  }

  if (remainingElapsed !== undefined) {
    if (minimumDelay > remainingElapsed) {
      return Result.succeed(denied(
        evaluation.failedAttempt,
        "ElapsedBudgetInsufficient"
      ))
    }
    maximumDelay = Math.min(maximumDelay, remainingElapsed)
  }

  return Result.succeed(Object.freeze({
    _tag: "Retry",
    evaluationVersion: 1,
    failedAttempt: evaluation.failedAttempt,
    nextAttempt: evaluation.failedAttempt + 1,
    retryOrdinal,
    baseDelayMillis: baseDelay,
    minimumDelayMillis: minimumDelay,
    maximumDelayMillis: maximumDelay
  }) as RetryDelayRange)
}

const RecordedRetryDelayStruct = Schema.Struct({
  recordingVersion: Schema.Literal(1),
  failedAttempt: Wire.PositiveSafeInt,
  nextAttempt: Wire.PositiveSafeInt,
  retryOrdinal: Wire.PositiveSafeInt,
  baseDelayMillis: Wire.SemanticDelayMillis,
  minimumDelayMillis: Wire.SemanticDelayMillis,
  maximumDelayMillis: Wire.SemanticDelayMillis,
  selectedDelayMillis: Wire.SemanticDelayMillis
})

/**
 * One externally selected retry delay admitted for durable recording.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RecordedRetryDelay = RecordedRetryDelayStruct.check(
  Schema.makeFilter((value) => {
    const issues = [...retryDelayBoundsIssues(value)]
    if (
      value.selectedDelayMillis < value.minimumDelayMillis ||
      value.selectedDelayMillis > value.maximumDelayMillis
    ) {
      issues.push({
        path: ["selectedDelayMillis"],
        issue: "selectedDelayMillis must be within the inclusive delay range"
      })
    }
    return issues
  })
).annotate({
  identifier: "WorkflowActivityPolicyV3RecordedRetryDelay",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RecordedRetryDelay}.
 *
 * @category models
 * @since 4.0.0
 */
export type RecordedRetryDelay = Schema.Schema.Type<
  typeof RecordedRetryDelay
>

const decodeRecordedDelay = Schema.decodeUnknownResult(
  Wire.SemanticDelayMillis,
  strictParseOptions
)

/**
 * Recomputes the policy interval and admits an externally recorded delay.
 *
 * **Details**
 *
 * Execution may obtain the selected value from any entropy source, but it
 * must call this function before committing it. Replay calls the same
 * function with the committed value. This module never samples entropy.
 *
 * @category evaluation
 * @since 4.0.0
 */
export const admitRecordedRetryDelay = (
  policyInput: unknown,
  input: unknown,
  selectedDelayInput: unknown
): Result.Result<RecordedRetryDelay, PolicyEvaluationError> => {
  const range = retryDelayRange(policyInput, input)
  if (Result.isFailure(range)) {
    return Result.fail(range.failure)
  }
  if (range.success._tag === "DoNotRetry") {
    return Result.fail(evaluationError(
      EvaluationCodes.RetryNotAllowed,
      `A retry delay cannot be recorded: ${range.success.reason}`,
      []
    ))
  }

  const snapshot = Json.snapshot(selectedDelayInput)
  if (Result.isFailure(snapshot)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidRecordedDelay,
      `Recorded delay must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }
  let selected: ReturnType<typeof decodeRecordedDelay>
  try {
    selected = decodeRecordedDelay(snapshot.success)
  } catch {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidRecordedDelay,
      "Recorded delay schema validation threw unexpectedly",
      []
    ))
  }
  if (Result.isFailure(selected)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidRecordedDelay,
      `Invalid recorded delay: ${selected.failure.message}`,
      []
    ))
  }
  if (
    selected.success < range.success.minimumDelayMillis ||
    selected.success > range.success.maximumDelayMillis
  ) {
    return Result.fail(evaluationError(
      EvaluationCodes.RecordedDelayOutsideRange,
      "Recorded delay is outside the inclusive policy range",
      []
    ))
  }

  return Result.succeed(Object.freeze({
    recordingVersion: 1,
    failedAttempt: range.success.failedAttempt,
    nextAttempt: range.success.nextAttempt,
    retryOrdinal: range.success.retryOrdinal,
    baseDelayMillis: range.success.baseDelayMillis,
    minimumDelayMillis: range.success.minimumDelayMillis,
    maximumDelayMillis: range.success.maximumDelayMillis,
    selectedDelayMillis: selected.success
  }) as RecordedRetryDelay)
}

/**
 * One application failure identity checked against explicit policy overrides.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FailureIdentity = Schema.Struct({
  failureIdentityVersion: Schema.Literal(1),
  errorTag: BoundedIdentity,
  errorCode: Schema.NullOr(BoundedIdentity)
}).annotate({
  identifier: "WorkflowActivityPolicyV3FailureIdentity",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link FailureIdentity}.
 *
 * @category models
 * @since 4.0.0
 */
export type FailureIdentity = Schema.Schema.Type<typeof FailureIdentity>

/**
 * A policy override that makes a failure non-retryable without executing the
 * classifier.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExplicitNonRetryable = Schema.TaggedStruct(
  "ExplicitNonRetryable",
  {
    matchedBy: Schema.Literals(["ErrorTag", "ErrorCode"])
  }
).annotate({
  identifier: "WorkflowActivityPolicyV3ExplicitNonRetryable",
  parseOptions: strictParseOptions
})

/**
 * Exact executable pin required to classify a failure not covered by an
 * explicit policy override.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ClassifierRequired = Schema.TaggedStruct("ClassifierRequired", {
  classifierId: BoundedIdentity,
  classifierVersion: BoundedIdentity,
  buildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowActivityPolicyV3ClassifierRequired",
  parseOptions: strictParseOptions
})

/**
 * Pure pre-classification disposition for one application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FailureDisposition = Schema.Union([
  ExplicitNonRetryable,
  ClassifierRequired
]).annotate({
  identifier: "WorkflowActivityPolicyV3FailureDisposition"
})

/**
 * The decoded type of {@link FailureDisposition}.
 *
 * @category models
 * @since 4.0.0
 */
export type FailureDisposition = Schema.Schema.Type<
  typeof FailureDisposition
>

const decodeFailureIdentity = Schema.decodeUnknownResult(
  FailureIdentity,
  strictParseOptions
)

/**
 * Applies explicit non-retryable overrides or returns the exact classifier
 * executable pin that must produce a durable decision.
 *
 * @category evaluation
 * @since 4.0.0
 */
export const failureDisposition = (
  policyInput: unknown,
  failureInput: unknown
): Result.Result<FailureDisposition, PolicyEvaluationError> => {
  const admittedPolicy = validate(policyInput)
  if (Result.isFailure(admittedPolicy)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidPolicy,
      admittedPolicy.failure.message,
      admittedPolicy.failure.path
    ))
  }
  const snapshot = Json.snapshot(failureInput)
  if (Result.isFailure(snapshot)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidFailureIdentity,
      `Failure identity must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }
  let decoded: ReturnType<typeof decodeFailureIdentity>
  try {
    decoded = decodeFailureIdentity(snapshot.success)
  } catch {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidFailureIdentity,
      "Failure identity schema validation threw unexpectedly",
      []
    ))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(evaluationError(
      EvaluationCodes.InvalidFailureIdentity,
      `Invalid failure identity: ${decoded.failure.message}`,
      []
    ))
  }

  const failure = decoded.success
  const retry = admittedPolicy.success.retry
  if (retry.nonRetryableErrorTags.includes(failure.errorTag)) {
    return Result.succeed(Object.freeze({
      _tag: "ExplicitNonRetryable",
      matchedBy: "ErrorTag"
    }))
  }
  if (
    failure.errorCode !== null &&
    retry.nonRetryableErrorCodes.includes(failure.errorCode)
  ) {
    return Result.succeed(Object.freeze({
      _tag: "ExplicitNonRetryable",
      matchedBy: "ErrorCode"
    }))
  }
  return Result.succeed(Object.freeze({
    _tag: "ClassifierRequired",
    classifierId: retry.classifier.classifierId,
    classifierVersion: retry.classifier.classifierVersion,
    buildDigest: retry.classifier.buildDigest
  }))
}
