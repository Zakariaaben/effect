import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Expression from "../src/Expression.ts"

const scope: Expression.Scope = {
  input: {
    name: "Ada",
    flag: true,
    nul: null,
    items: ["first", { deep: ["a", "b"] }],
    keyed: { "0": "zero" }
  },
  nodes: { fetch: { value: { status: 200 } } }
}

const success = (
  expression: Expression.Expression,
  evaluationScope: Expression.Scope = scope
): Schema.Json => {
  const result = Expression.evaluate(expression, evaluationScope)
  if (Result.isFailure(result)) {
    throw new Error(`Expected success, received ${result.failure.code}: ${result.failure.message}`)
  }
  return result.success
}

const failure = (
  expression: Expression.Expression,
  evaluationScope: Expression.Scope = scope
): Expression.EvaluationError => {
  const result = Expression.evaluate(expression, evaluationScope)
  if (Result.isSuccess(result)) {
    throw new Error(`Expected failure, received ${JSON.stringify(result.success)}`)
  }
  return result.failure
}

describe("Expression", () => {
  describe("evaluate", () => {
    it("yields literal constants unchanged", () => {
      assert.strictEqual(success(Expression.literal("text")), "text")
      assert.strictEqual(success(Expression.literal(null)), null)
      assert.deepStrictEqual(success(Expression.literal({ a: [1, true] })), { a: [1, true] })
    })

    it("resolves references through nested objects and arrays", () => {
      assert.strictEqual(success(Expression.ref("input", "name")), "Ada")
      assert.strictEqual(success(Expression.ref("input", "items", 0)), "first")
      assert.strictEqual(success(Expression.ref("input", "items", 1, "deep", 1)), "b")
      assert.strictEqual(success(Expression.ref("nodes", "fetch", "value", "status")), 200)
    })

    it("resolves numeric segments as object keys and rejects string array indices", () => {
      assert.strictEqual(success(Expression.ref("input", "keyed", 0)), "zero")
      assert.strictEqual(success(Expression.has("input", "items", 1)), true)
      assert.strictEqual(success(Expression.has("input", "items", "1")), false)
      assert.strictEqual(success(Expression.has("input", "items", 5)), false)
    })

    it("tests path presence without failing on absent paths", () => {
      assert.strictEqual(success(Expression.has("input", "name")), true)
      assert.strictEqual(success(Expression.has("input", "nul")), true)
      assert.strictEqual(success(Expression.has("input", "ghost")), false)
      assert.strictEqual(success(Expression.has("ghost")), false)
    })

    it("stringifies scalar template parts and rejects null and containers", () => {
      assert.strictEqual(
        success(Expression.template(
          "Hello, ",
          Expression.ref("input", "name"),
          "! n=",
          Expression.literal(42),
          " b=",
          Expression.literal(true)
        )),
        "Hello, Ada! n=42 b=true"
      )
      assert.strictEqual(success(Expression.template()), "")

      const nullPart = failure(Expression.template("x", Expression.literal(null)))
      assert.strictEqual(nullPart.code, "TypeMismatch")
      assert.deepStrictEqual(nullPart.expressionPath, ["parts", 1])

      const objectPart = failure(Expression.template(Expression.literal({})))
      assert.strictEqual(objectPart.code, "TypeMismatch")
      assert.deepStrictEqual(objectPart.expressionPath, ["parts", 0])
    })

    it("constructs records with deterministically sorted keys", () => {
      const value = success(Expression.record({
        zebra: Expression.literal(1),
        alpha: Expression.literal(2),
        mid: Expression.ref("input", "name")
      }))
      assert.deepStrictEqual(value, { alpha: 2, mid: "Ada", zebra: 1 })
      assert.deepStrictEqual(Object.keys(value as object), ["alpha", "mid", "zebra"])
    })

    it("constructs lists in item order", () => {
      assert.deepStrictEqual(
        success(Expression.list(
          Expression.literal(1),
          Expression.ref("input", "name"),
          Expression.list()
        )),
        [1, "Ada", []]
      )
    })

    it("negates strict booleans only", () => {
      assert.strictEqual(success(Expression.not(Expression.literal(false))), true)
      assert.strictEqual(success(Expression.not(Expression.has("input", "ghost"))), true)

      const mismatch = failure(Expression.not(Expression.literal(0)))
      assert.strictEqual(mismatch.code, "TypeMismatch")
      assert.deepStrictEqual(mismatch.expressionPath, ["operand"])
    })

    it("conjunction and disjunction operate on strict booleans with empty identities", () => {
      assert.strictEqual(success(Expression.and()), true)
      assert.strictEqual(success(Expression.or()), false)
      assert.strictEqual(success(Expression.and(Expression.literal(true), Expression.literal(true))), true)
      assert.strictEqual(success(Expression.and(Expression.literal(true), Expression.literal(false))), false)
      assert.strictEqual(success(Expression.or(Expression.literal(false), Expression.literal(true))), true)
      assert.strictEqual(success(Expression.or(Expression.literal(false), Expression.literal(false))), false)

      const nonBoolean = failure(Expression.and(Expression.literal(true), Expression.literal("yes")))
      assert.strictEqual(nonBoolean.code, "TypeMismatch")
      assert.deepStrictEqual(nonBoolean.expressionPath, ["operands", 1])
    })

    it("short-circuits without evaluating later failing operands", () => {
      const boom = Expression.ref("boom")
      assert.strictEqual(success(Expression.and(Expression.literal(false), boom)), false)
      assert.strictEqual(success(Expression.or(Expression.literal(true), boom)), true)
      assert.strictEqual(failure(Expression.and(Expression.literal(true), boom)).code, "PathNotFound")
      assert.strictEqual(failure(Expression.or(Expression.literal(false), boom)).code, "PathNotFound")
    })

    it("compares deep JSON equality independent of key order", () => {
      assert.strictEqual(
        success(Expression.eq(
          Expression.literal({ a: [1, { b: 2 }], c: null }),
          Expression.literal({ c: null, a: [1, { b: 2 }] })
        )),
        true
      )
      assert.strictEqual(
        success(Expression.eq(Expression.literal([1, 2]), Expression.literal([2, 1]))),
        false
      )
      assert.strictEqual(
        success(Expression.eq(Expression.literal([[1], [2]]), Expression.literal([[1], [2]]))),
        true
      )
      assert.strictEqual(success(Expression.eq(Expression.literal(1), Expression.literal("1"))), false)
      assert.strictEqual(success(Expression.eq(Expression.literal(null), Expression.literal(false))), false)
      assert.strictEqual(success(Expression.eq(Expression.literal({}), Expression.literal([]))), false)
    })

    it("orders two numbers or two strings and rejects mixed operands", () => {
      assert.strictEqual(success(Expression.compare("lt", Expression.literal(1), Expression.literal(2))), true)
      assert.strictEqual(success(Expression.compare("le", Expression.literal(2), Expression.literal(2))), true)
      assert.strictEqual(success(Expression.compare("gt", Expression.literal(3), Expression.literal(2))), true)
      assert.strictEqual(success(Expression.compare("ge", Expression.literal(2), Expression.literal(3))), false)
      assert.strictEqual(success(Expression.compare("lt", Expression.literal("a"), Expression.literal("b"))), true)
      assert.strictEqual(success(Expression.compare("ge", Expression.literal("b"), Expression.literal("b"))), true)

      const mixed = failure(Expression.compare("lt", Expression.literal(1), Expression.literal("2")))
      assert.strictEqual(mixed.code, "TypeMismatch")
      assert.deepStrictEqual(mixed.expressionPath, [])
    })

    it("sizes strings, arrays, and objects and rejects scalars", () => {
      assert.strictEqual(success(Expression.size(Expression.literal("abc"))), 3)
      assert.strictEqual(success(Expression.size(Expression.literal([1, 2]))), 2)
      assert.strictEqual(success(Expression.size(Expression.literal({ a: 1, b: 2 }))), 2)
      assert.strictEqual(success(Expression.size(Expression.literal(""))), 0)

      for (const scalar of [Expression.literal(5), Expression.literal(null), Expression.literal(true)]) {
        const mismatch = failure(Expression.size(scalar))
        assert.strictEqual(mismatch.code, "TypeMismatch")
        assert.deepStrictEqual(mismatch.expressionPath, ["operand"])
      }
    })

    it("coalesces past absent references and nulls to the first present value", () => {
      assert.strictEqual(
        success(Expression.coalesce(
          Expression.ref("input", "ghost"),
          Expression.literal(null),
          Expression.ref("input", "nul"),
          Expression.literal("fallback"),
          Expression.literal("later")
        )),
        "fallback"
      )
      assert.strictEqual(
        success(Expression.coalesce(Expression.ref("ghost"), Expression.literal(null))),
        null
      )
      assert.strictEqual(success(Expression.coalesce()), null)

      const propagated = failure(Expression.coalesce(
        Expression.not(Expression.literal(1)),
        Expression.literal("unreached")
      ))
      assert.strictEqual(propagated.code, "TypeMismatch")
      assert.deepStrictEqual(propagated.expressionPath, ["operands", 0, "operand"])
    })
  })

  describe("errors", () => {
    it("locates failures with expression and data paths", () => {
      const missingRoot = failure(Expression.ref("ghost"))
      assert.strictEqual(missingRoot.code, "PathNotFound")
      assert.deepStrictEqual(missingRoot.expressionPath, [])
      assert.deepStrictEqual(missingRoot.dataPath, ["ghost"])

      const missingKey = failure(Expression.and(
        Expression.literal(true),
        Expression.ref("input", "missing", "deep")
      ))
      assert.strictEqual(missingKey.code, "PathNotFound")
      assert.deepStrictEqual(missingKey.expressionPath, ["operands", 1])
      assert.deepStrictEqual(missingKey.dataPath, ["input", "missing"])

      const nested = failure(Expression.record({
        wrapped: Expression.list(Expression.ref("nodes", "fetch", "value", "missing"))
      }))
      assert.deepStrictEqual(nested.expressionPath, ["fields", "wrapped", "items", 0])
      assert.deepStrictEqual(nested.dataPath, ["nodes", "fetch", "value", "missing"])
    })

    it("omits data paths for pure type mismatches", () => {
      const mismatch = failure(Expression.not(Expression.literal("nope")))
      assert.strictEqual(mismatch.code, "TypeMismatch")
      assert.strictEqual(mismatch.dataPath, undefined)
    })
  })

  describe("references", () => {
    const sorted = (paths: ReadonlyArray<Expression.Path>): Array<Array<Expression.PathSegment>> =>
      paths
        .map((path) => [...path])
        .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1)

    it("collects Ref and Has paths nested inside templates and records", () => {
      const expression = Expression.record({
        greeting: Expression.template("Hi ", Expression.ref("input", "name")),
        present: Expression.has("nodes", "fetch", "value"),
        picks: Expression.list(
          Expression.ref("input", "items", 0),
          Expression.coalesce(Expression.ref("input", "nul"), Expression.literal(1))
        )
      })

      assert.deepStrictEqual(
        sorted(Expression.references(expression)),
        sorted([
          ["input", "name"],
          ["nodes", "fetch", "value"],
          ["input", "items", 0],
          ["input", "nul"]
        ])
      )
    })

    it("returns the reference of a bare Ref and nothing for literals", () => {
      assert.deepStrictEqual(sorted(Expression.references(Expression.ref("input"))), [["input"]])
      assert.deepStrictEqual(Expression.references(Expression.literal({ deep: [1] })), [])
    })
  })

  describe("validate", () => {
    it("accepts expressions within the node and depth limits", () => {
      const expression = Expression.and(
        Expression.eq(Expression.ref("input", "name"), Expression.literal("Ada")),
        Expression.not(Expression.has("input", "ghost"))
      )
      assert.isTrue(Result.isSuccess(Expression.validate(expression)))
    })

    it("rejects expressions with too many nodes", () => {
      const wide = Expression.list(
        ...Array.from({ length: Expression.MaxNodes + 1 }, () => Expression.literal(0))
      )
      const result = Expression.validate(wide)
      assert.isTrue(Result.isFailure(result))
      if (Result.isSuccess(result)) {
        throw new Error("Expected failure")
      }
      assert.strictEqual(result.failure.code, "LimitExceeded")
      assert.match(result.failure.message, /nodes/)
      assert.deepStrictEqual(result.failure.expressionPath, [])
    })

    it("rejects expressions nested beyond the depth limit", () => {
      let deep: Expression.Expression = Expression.literal(true)
      for (let index = 0; index <= Expression.MaxDepth; index++) {
        deep = Expression.not(deep)
      }
      const result = Expression.validate(deep)
      assert.isTrue(Result.isFailure(result))
      if (Result.isSuccess(result)) {
        throw new Error("Expected failure")
      }
      assert.strictEqual(result.failure.code, "LimitExceeded")
      assert.match(result.failure.message, /nesting/)
    })
  })

  describe("schema", () => {
    const decode = Schema.decodeUnknownSync(Expression.Expression)

    it("round-trips every constructor's wire document", () => {
      const samples: ReadonlyArray<Expression.Expression> = [
        Expression.literal({ a: [1, "two", null, true] }),
        Expression.ref("input", "items", 0),
        Expression.has("nodes", "fetch", "value"),
        Expression.template("Hello, ", Expression.ref("input", "name"), "!"),
        Expression.record({ a: Expression.literal(1), b: Expression.ref("input", "name") }),
        Expression.list(Expression.literal(1), Expression.list()),
        Expression.not(Expression.literal(true)),
        Expression.and(Expression.literal(true), Expression.has("input", "flag")),
        Expression.or(),
        Expression.eq(Expression.literal(1), Expression.ref("input", "items", 1)),
        Expression.compare("ge", Expression.literal(1), Expression.literal(2)),
        Expression.size(Expression.ref("input", "items")),
        Expression.coalesce(Expression.ref("input", "nul"), Expression.literal("x"))
      ]

      for (const sample of samples) {
        assert.deepStrictEqual(decode(sample), sample)
      }
    })

    it("rejects unknown tags, excess properties, and invalid paths", () => {
      assert.throws(() => decode({ _tag: "Custom", value: 1 }))
      assert.throws(() => decode({ ...Expression.literal(1), extra: true }))
      assert.throws(() => decode({ ...Expression.ref("input"), extra: true }))
      assert.throws(() =>
        decode(Expression.not({ _tag: "Literal", value: 1, extra: true } as unknown as Expression.Expression))
      )
      assert.throws(() => decode({ _tag: "Ref", path: [] }))
      assert.throws(() => decode({ _tag: "Ref", path: ["input", -1] }))
      assert.throws(() => decode({ _tag: "Ref", path: ["input", 1.5] }))
    })
  })
})
