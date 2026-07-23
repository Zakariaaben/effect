import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnExpression from "../src/BpmnExpression.ts"
import * as Evaluator from "../src/BpmnExpressionEvaluator.ts"

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
): BpmnExpression.EvaluatorBinding =>
  Schema.decodeUnknownSync(BpmnExpression.EvaluatorBinding)({
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

const handler: Evaluator.EvaluatorHandler<"evaluation-failed"> = (request) =>
  request.source === "approved"
    ? Effect.succeed({ result: true, steps: 7 })
    : Effect.fail("evaluation-failed")

const definition = (
  exactBinding: BpmnExpression.EvaluatorBinding = binding(),
  evaluate: Evaluator.EvaluatorHandler<unknown> = handler
) => Evaluator.makeDefinition({ binding: exactBinding, evaluate })

describe("BpmnExpressionEvaluator", () => {
  it.effect("preserves the exact handler in an immutable registry and layer", () =>
    Effect.gen(function*() {
      const registered = definition()
      const registry = yield* Evaluator.makeMemory([registered])
      const resolved = yield* registry.resolve(binding())

      assert.strictEqual(registry.size, 1)
      assert.strictEqual(resolved, registered)
      assert.strictEqual(resolved.evaluate, handler)
      assert.isTrue(Object.isFrozen(registered))
      assert.isTrue(Object.isFrozen(registered.binding))
      assert.isTrue(Object.isFrozen(registered.binding.build))
      assert.isTrue(Object.isFrozen(registered.binding.limits))
      assert.isTrue(Evaluator.isEvaluatorDefinition(registered))
      assert.isTrue(Evaluator.isEvaluatorRegistry(registry))

      const evaluation = yield* resolved.evaluate({
        source: "approved",
        context: { amount: 42 }
      })
      assert.deepStrictEqual(evaluation, { result: true, steps: 7 })

      const context = yield* Effect.scoped(
        Layer.build(Evaluator.layerMemory([registered]))
      )
      const layered = Context.get(context, Evaluator.EvaluatorRegistry)
      assert.strictEqual(yield* layered.resolve(binding()), registered)
    }))

  it.effect("rejects duplicate complete bindings", () =>
    Effect.gen(function*() {
      const first = definition()
      const result = yield* Evaluator.makeMemory([first, first]).pipe(
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(result.failure, Evaluator.DuplicateEvaluatorDefinition)
      assert.deepStrictEqual(
        result.failure,
        new Evaluator.DuplicateEvaluatorDefinition({ binding: first.binding })
      )
    }))

  it.effect("allows the same language and version under distinct full build pins", () =>
    Effect.gen(function*() {
      const first = definition(binding({ deploymentId: "build-one" }))
      const second = definition(binding({
        deploymentId: "build-two",
        buildDigest: digest("b")
      }))
      const registry = yield* Evaluator.makeMemory([first, second])

      assert.strictEqual(registry.size, 2)
      assert.strictEqual(yield* registry.resolve(first.binding), first)
      assert.strictEqual(yield* registry.resolve(second.binding), second)
    }))

  it.effect("requires every tuple field and never falls back", () =>
    Effect.gen(function*() {
      const registered = definition()
      const registry = yield* Evaluator.makeMemory([registered])
      const alternatives = [
        binding({ language: "other" }),
        binding({ languageVersion: "2" }),
        binding({ id: "other" }),
        binding({ version: "4" }),
        binding({ deploymentId: "other" }),
        binding({ buildDigest: digest("b") }),
        binding({ maxSourceUtf8Bytes: 4_095 }),
        binding({ maxContextCanonicalBytes: 65_535 }),
        binding({ maxSteps: 99_999 }),
        binding({ timeoutMillis: 1_999 })
      ]

      for (const alternative of alternatives) {
        const result = yield* registry.resolve(alternative).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.instanceOf(result.failure, Evaluator.EvaluatorNotFound)
      }
    }))

  it.effect("rejects forged definitions and registries by provenance", () =>
    Effect.gen(function*() {
      const registered = definition()
      const registry = yield* Evaluator.makeMemory([registered])
      const forgedDefinition = { ...registered }
      const forgedRegistry = Evaluator.EvaluatorRegistry.of({
        size: 1,
        resolve: () => Effect.succeed(registered)
      })

      assert.isFalse(Evaluator.isEvaluatorDefinition(forgedDefinition))
      assert.isFalse(Evaluator.isEvaluatorRegistry({ ...registry }))
      assert.isFalse(Evaluator.isEvaluatorRegistry(forgedRegistry))

      const result = Evaluator.fromDefinitions([
        forgedDefinition as Evaluator.AnyEvaluatorDefinition
      ])
      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(result.failure, Evaluator.InvalidEvaluatorConfiguration)
    }))

  it("rejects accessors without invoking them", () => {
    let accessed = 0
    const hostile = Object.create(Object.prototype)
    Object.defineProperties(hostile, {
      binding: {
        enumerable: true,
        get() {
          accessed++
          return binding()
        }
      },
      evaluate: {
        enumerable: true,
        value: handler
      }
    })

    const result = Evaluator.fromDefinition(
      hostile as Evaluator.EvaluatorDefinitionOptions<"evaluation-failed">
    )
    assert.isTrue(Result.isFailure(result))
    assert.strictEqual(accessed, 0)
    assert.instanceOf(result.failure, Evaluator.InvalidEvaluatorConfiguration)
  })

  it.effect("rejects hostile binding descriptors during resolution", () =>
    Effect.gen(function*() {
      const registry = yield* Evaluator.makeMemory([definition()])
      let accessed = 0
      const hostile = {
        get language() {
          accessed++
          return "https://example.test/feel"
        },
        languageVersion: "1.5",
        build: binding().build,
        limits: binding().limits
      }
      const result = yield* registry.resolve(
        hostile as BpmnExpression.EvaluatorBinding
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(accessed, 0)
      assert.instanceOf(result.failure, Evaluator.InvalidEvaluatorConfiguration)
    }))

  it("retains invalid result shapes as schema failures", () => {
    const decode = Schema.decodeUnknownResult(
      Evaluator.EvaluationResult,
      { onExcessProperty: "error" }
    )

    assert.isTrue(Result.isSuccess(decode({ result: false, steps: 0 })))
    assert.isTrue(Result.isFailure(decode({ result: false, steps: -1 })))
    assert.isTrue(
      Result.isFailure(decode({ result: false, steps: 0, extra: true }))
    )
  })
})
