import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Json from "../src/internal/json.ts"

describe("internal/json", () => {
  it("normalizes negative zero before values can be hashed or executed", () => {
    const result = Json.snapshot({
      positive: 0,
      negative: -0,
      nested: [-0]
    })
    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
    const value = result.success as {
      readonly positive: number
      readonly negative: number
      readonly nested: ReadonlyArray<number>
    }
    assert.isFalse(Object.is(value.negative, -0))
    assert.isFalse(Object.is(value.nested[0], -0))
    assert.deepStrictEqual(value, {
      positive: 0,
      negative: 0,
      nested: [0]
    })
    assert.strictEqual(
      Json.canonicalizeSnapshot(result.success),
      "{\"negative\":0,\"nested\":[0],\"positive\":0}"
    )
  })

  it("bounds expanded shared-object graphs instead of amplifying them without limit", () => {
    let value: unknown = { leaf: true }
    for (let index = 0; index < 15; index++) {
      value = { left: value, right: value }
    }

    const result = Json.snapshot(value)
    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("Expected the expanded graph to exceed the container budget")
    }
    assert.include(result.failure.message, "container count exceeds")
  })

  it("charges encoded strings, property names, structure, and repeated occurrences", () => {
    const string = Json.snapshot("😀", {
      maxStringBytes: 6,
      maxTotalBytes: 6
    })
    assert.isTrue(Result.isSuccess(string))

    const escaped = Json.snapshot("\u0000", {
      maxStringBytes: 8,
      maxTotalBytes: 8
    })
    assert.isTrue(Result.isSuccess(escaped))

    const tooLong = Json.snapshot("😀", {
      maxStringBytes: 6,
      maxTotalBytes: 5
    })
    assert.isTrue(Result.isFailure(tooLong))
    if (Result.isFailure(tooLong)) {
      assert.include(tooLong.failure.message, "size exceeds")
    }

    const shared = { value: "abc" }
    const repeated = Json.snapshot({ left: shared, right: shared }, {
      maxStringBytes: 32,
      maxTotalBytes: 30
    })
    assert.isTrue(Result.isFailure(repeated))
    if (Result.isFailure(repeated)) {
      assert.include(repeated.failure.message, "size exceeds")
    }

    const property = Json.snapshot({ property: true }, {
      maxStringBytes: 9,
      maxTotalBytes: 64
    })
    assert.isTrue(Result.isFailure(property))
    if (Result.isFailure(property)) {
      assert.include(property.failure.message, "property name exceeds")
      assert.deepStrictEqual(property.failure.path, ["property"])
    }
  })

  it("retains iterative support for large but bounded tree-shaped JSON", () => {
    let value: unknown = null
    for (let index = 0; index < 10_000; index++) {
      value = { value }
    }
    const result = Json.snapshot(value)
    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
    assert.isTrue(Object.isFrozen(result.success))
  })
})
