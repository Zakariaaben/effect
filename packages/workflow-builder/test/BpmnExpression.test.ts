import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnExpression from "../src/BpmnExpression.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const binding = (
  overrides: {
    readonly language?: string
    readonly languageVersion?: string
    readonly id?: string
    readonly version?: string
    readonly deploymentId?: string
    readonly buildDigest?: string
    readonly maxSourceUtf8Bytes?: number
    readonly maxContextCanonicalBytes?: number
    readonly maxSteps?: number
    readonly timeoutMillis?: number
  } = {}
) => ({
  language: overrides.language ?? "https://example.test/feel",
  languageVersion: overrides.languageVersion ?? "1.5",
  build: {
    id: overrides.id ?? "feel-evaluator",
    version: overrides.version ?? "3.2.1",
    deploymentId: overrides.deploymentId ?? "feel-build-42",
    buildDigest: overrides.buildDigest ?? digest("a")
  },
  limits: {
    maxSourceUtf8Bytes: overrides.maxSourceUtf8Bytes ?? 4_096,
    maxContextCanonicalBytes: overrides.maxContextCanonicalBytes ?? 65_536,
    maxSteps: overrides.maxSteps ?? 100_000,
    timeoutMillis: overrides.timeoutMillis ?? 2_000
  }
})

describe("BpmnExpression", () => {
  it("decodes one strict portable evaluator binding", () => {
    const decoded = Schema.decodeUnknownResult(
      BpmnExpression.EvaluatorBinding,
      { onExcessProperty: "error" }
    )(binding())

    assert.isTrue(Result.isSuccess(decoded))
    if (Result.isFailure(decoded)) {
      return
    }
    assert.strictEqual(decoded.success.languageVersion, "1.5")
    assert.strictEqual(decoded.success.build.deploymentId, "feel-build-42")
    assert.strictEqual(decoded.success.limits.maxSteps, 100_000)
  })

  it("rejects excess fields at every portable boundary", () => {
    const decode = Schema.decodeUnknownResult(
      BpmnExpression.EvaluatorBinding,
      { errors: "all", onExcessProperty: "error" }
    )
    const inputs = [
      { ...binding(), extra: true },
      { ...binding(), build: { ...binding().build, extra: true } },
      { ...binding(), limits: { ...binding().limits, extra: true } }
    ]

    for (const input of inputs) {
      assert.isTrue(Result.isFailure(decode(input)))
    }
  })

  it("enforces positive explicit ceilings for every evaluation limit", () => {
    const decode = Schema.decodeUnknownResult(BpmnExpression.EvaluationLimits)
    const maximums = {
      maxSourceUtf8Bytes: BpmnExpression.MaximumSourceUtf8Bytes,
      maxContextCanonicalBytes: BpmnExpression.MaximumContextCanonicalBytes,
      maxSteps: BpmnExpression.MaximumEvaluationSteps,
      timeoutMillis: BpmnExpression.MaximumEvaluationTimeoutMillis
    }

    assert.isTrue(Result.isSuccess(decode(maximums)))
    for (const key of Object.keys(maximums) as ReadonlyArray<keyof typeof maximums>) {
      assert.isTrue(Result.isFailure(decode({ ...maximums, [key]: 0 })))
      assert.isTrue(
        Result.isFailure(decode({ ...maximums, [key]: maximums[key] + 1 }))
      )
    }
  })

  it("keys the complete tuple without delimiter collisions", () => {
    const decode = Schema.decodeUnknownSync(BpmnExpression.EvaluatorBinding)
    const base = decode(binding())
    const variants = [
      binding({ language: "other" }),
      binding({ languageVersion: "2" }),
      binding({ id: "other" }),
      binding({ version: "4" }),
      binding({ deploymentId: "other" }),
      binding({ buildDigest: digest("b") }),
      binding({ maxSourceUtf8Bytes: 4_095 }),
      binding({ maxContextCanonicalBytes: 65_535 }),
      binding({ maxSteps: 99_999 }),
      binding({ timeoutMillis: 1_999 }),
      binding({ language: "a\",\"b", languageVersion: "c" })
    ].map(decode)

    const keys = new Set([
      BpmnExpression.evaluatorBindingKey(base),
      ...variants.map(BpmnExpression.evaluatorBindingKey)
    ])
    assert.strictEqual(keys.size, variants.length + 1)
  })
})
