import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as Diagnostic from "../src/Diagnostic.ts"

const baseInput = () => ({
  severity: "error" as const,
  code: "InvalidPlan",
  message: "The plan is invalid",
  path: ["nodes", 0, "config"] as Array<Diagnostic.PathSegment>
})

describe("PathSegment", () => {
  const decode = Schema.decodeUnknownSync(Diagnostic.PathSegment)

  it("accepts strings and non-negative safe integers", () => {
    assert.strictEqual(decode("nodes"), "nodes")
    assert.strictEqual(decode(""), "")
    assert.strictEqual(decode(0), 0)
    assert.strictEqual(decode(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
  })

  it("rejects invalid numeric path segments", () => {
    const invalid: ReadonlyArray<unknown> = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1
    ]

    for (const input of invalid) {
      assert.throws(() => decode(input))
    }
  })
})

describe("Diagnostic", () => {
  it("detaches and recursively freezes path and details", () => {
    const path = baseInput().path
    const details = {
      nested: {
        values: [1, { valid: true }]
      }
    }
    const diagnostic = new Diagnostic.Diagnostic({ ...baseInput(), path, details })

    assert.isTrue(Object.isFrozen(diagnostic))
    assert.isTrue(Object.isFrozen(diagnostic.path))
    assert.isTrue(Object.isFrozen(diagnostic.details))
    assert.isTrue(Object.isFrozen((diagnostic.details as typeof details).nested))
    assert.isTrue(Object.isFrozen((diagnostic.details as typeof details).nested.values))
    assert.isTrue(Object.isFrozen((diagnostic.details as typeof details).nested.values[1]))
    assert.notStrictEqual(diagnostic.path, path)
    assert.notStrictEqual(diagnostic.details, details)

    path.push("caller-mutation")
    details.nested.values.push(2)
    assert.deepStrictEqual(diagnostic.path, ["nodes", 0, "config"])
    assert.deepStrictEqual(diagnostic.details, {
      nested: {
        values: [1, { valid: true }]
      }
    })
  })

  it("preserves prototype-like detail keys without pollution", () => {
    const details = JSON.parse(
      "{\"__proto__\":{\"polluted\":true},\"constructor\":\"constructor-value\",\"toString\":\"string-value\"}"
    )
    const diagnostic = Diagnostic.make({ ...baseInput(), details })
    const output = diagnostic.details as Readonly<Record<string, unknown>>

    assert.isTrue(Object.prototype.hasOwnProperty.call(output, "__proto__"))
    assert.isTrue(Object.prototype.hasOwnProperty.call(output, "constructor"))
    assert.isTrue(Object.prototype.hasOwnProperty.call(output, "toString"))
    assert.deepStrictEqual(output["__proto__"], { polluted: true })
    assert.strictEqual(output.constructor, "constructor-value")
    assert.strictEqual(output.toString, "string-value")
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
  })

  it("rejects accessors without invoking them through the safe constructor", () => {
    let getterCalls = 0
    const input = { ...baseInput() } as Record<string, unknown>
    Object.defineProperty(input, "details", {
      enumerable: true,
      get: () => {
        getterCalls++
        return { not: "observed" }
      }
    })

    assert.throws(() => Diagnostic.make(input))
    assert.strictEqual(getterCalls, 0)
  })

  it("rejects non-JSON and hostile detail containers", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const sparse = new Array<unknown>(2)
    sparse[1] = "present"
    const invalid: ReadonlyArray<unknown> = [
      { value: undefined },
      { value: 1n },
      { value: () => undefined },
      { value: Number.NaN },
      new Date(0),
      sparse,
      cyclic
    ]

    for (const details of invalid) {
      assert.throws(() => Diagnostic.make({ ...baseInput(), details }))
    }
  })

  it("rejects excess properties and invalid paths", () => {
    assert.throws(() => Diagnostic.make({ ...baseInput(), excess: true }))
    assert.throws(() => Schema.decodeUnknownSync(Diagnostic.Diagnostic)({ ...baseInput(), excess: true }))

    const invalidPaths: ReadonlyArray<ReadonlyArray<unknown>> = [
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [-1],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      [null]
    ]
    for (const path of invalidPaths) {
      assert.throws(() => Diagnostic.make({ ...baseInput(), path }))
    }
  })

  it("keeps convenience constructors on the safe detached path", () => {
    const path: Array<Diagnostic.PathSegment> = ["nodes", 0]
    const details = { reason: ["invalid"] }
    const error = Diagnostic.error("Invalid", "Invalid node", path, details)
    const warning = Diagnostic.warning("Deprecated", "Deprecated node", path, details)

    path.push("mutation")
    details.reason.push("mutation")
    assert.deepStrictEqual(error.path, ["nodes", 0])
    assert.deepStrictEqual(warning.path, ["nodes", 0])
    assert.deepStrictEqual(error.details, { reason: ["invalid"] })
    assert.deepStrictEqual(warning.details, { reason: ["invalid"] })
  })
})

describe("CompilationError", () => {
  const diagnostic = Diagnostic.error("InvalidPlan", "The plan is invalid")

  it("detaches and freezes its diagnostic array and hidden error state", () => {
    const source: [Diagnostic.Diagnostic, ...Array<Diagnostic.Diagnostic>] = [diagnostic]
    const error = new Diagnostic.CompilationError({ diagnostics: source })
    const plainArgs = (error as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("effect/Data/Error/plainArgs")
    ]

    assert.isTrue(Object.isFrozen(error))
    assert.isTrue(Object.isFrozen(error.diagnostics))
    assert.isTrue(Object.isFrozen(error.diagnostics[0]))
    assert.isTrue(Object.isFrozen(plainArgs))
    assert.notStrictEqual(error.diagnostics, source)

    source.push(Diagnostic.warning("CallerMutation", "Not retained"))
    assert.strictEqual(error.diagnostics.length, 1)
    assert.deepStrictEqual(error.diagnostics[0], diagnostic)
  })

  it("rejects excess properties at construction and decoding", () => {
    assert.throws(() => new Diagnostic.CompilationError({ diagnostics: [diagnostic], excess: true } as never))
    assert.throws(() =>
      Schema.decodeUnknownSync(Diagnostic.CompilationError)({
        _tag: "CompilationError",
        diagnostics: [diagnostic],
        excess: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Diagnostic.CompilationError)({
        _tag: "CompilationError",
        diagnostics: [{ ...baseInput(), excess: true }]
      })
    )
  })

  it("produces immutable instances when decoded from JSON-compatible input", () => {
    const error = Schema.decodeUnknownSync(Diagnostic.CompilationError)({
      _tag: "CompilationError",
      diagnostics: [{ ...baseInput(), details: { reason: ["invalid"] } }]
    })

    assert.isTrue(Object.isFrozen(error))
    assert.isTrue(Object.isFrozen(error.diagnostics))
    assert.isTrue(Object.isFrozen(error.diagnostics[0]))
    assert.isTrue(Object.isFrozen(error.diagnostics[0]!.path))
    assert.isTrue(Object.isFrozen(error.diagnostics[0]!.details))
    assert.isTrue(Object.isFrozen(
      (error.diagnostics[0]!.details as { readonly reason: ReadonlyArray<string> }).reason
    ))
  })
})
