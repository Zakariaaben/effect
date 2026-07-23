import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunStart from "../src/RunStart.ts"
import * as Workflow from "../src/Workflow.ts"

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (output[index % output.length]! + data[index]! + index) & 0xff
      }
      return output
    })
})

const makeDefinition = <const Inputs extends Port.Outputs>(
  id: string,
  inputs: Inputs
) =>
  Workflow.make(id, {
    version: "1.0.0",
    inputs,
    outputs: {},
    nodes: Registry.make(),
    linkPolicy: LinkPolicy.allowAll,
    limits
  })

const prepare = <W extends Workflow.Any>(definition: W) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, {
      formatVersion: 1,
      id: `${definition.id}-plan`,
      revision: 7,
      definition: {
        id: definition.id,
        version: definition.version
      },
      nodes: [],
      edges: []
    })
    return yield* Decision.prepare(compiled)
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const stringDefinition = makeDefinition("run-start", {
  value: Port.output(Schema.String, { contract: "run-start/string" })
})

const failure = <A>(
  result: Result.Result<A, RunStart.RunStartError>
): RunStart.RunStartError => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

describe("RunStart", () => {
  it("exposes a strict schema-backed RunStartError", () => {
    const decode = Schema.decodeUnknownSync(RunStart.RunStartError)
    const decoded = decode({
      _tag: "RunStartError",
      code: RunStart.Codes.InvalidInput,
      runId: "run-1",
      message: "Invalid input",
      input: "value",
      details: { input: "value" }
    })

    assert.instanceOf(decoded, RunStart.RunStartError)
    assert.throws(() => decode({ ...decoded, unexpected: true }))
    assert.throws(() => decode({ ...decoded, code: "FutureRunStartError" }))
  })

  it.effect("constructs the exact immutable draft and pins the prepared meaning", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(stringDefinition)
      const draft = yield* RunStart.make(plan, { value: "hello" }, {
        runId: "run-1",
        backend: "durable"
      })

      assert.deepStrictEqual(draft, {
        eventVersion: 1,
        eventId: RunStart.eventId("run-1"),
        payload: {
          _tag: "RunStarted",
          planId: plan.compiled.plan.id,
          planRevision: plan.compiled.plan.revision,
          definitionId: plan.compiled.definition.id,
          definitionVersion: plan.compiled.definition.version,
          compilerVersion: Fingerprint.CompilerSemanticVersion,
          compiledFingerprint: plan.compiledFingerprint,
          backend: "durable",
          input: { value: "hello" }
        }
      })
      assert.isFalse(Object.prototype.hasOwnProperty.call(draft, "causationId"))
      assert.isFalse(Object.prototype.hasOwnProperty.call(draft, "correlationId"))
      assert.isTrue(Object.isFrozen(draft))
      assert.isTrue(Object.isFrozen(draft.payload))
      assert.isTrue(Object.isFrozen(draft.payload.input))
      assert.deepStrictEqual(Schema.decodeUnknownSync(Schema.Json)(draft), draft)
    }))

  it.effect("rejects forged and structurally copied prepared plans", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(stringDefinition)
      const clone = { ...plan } as Decision.DecidablePlan<typeof stringDefinition>
      const forged = {} as Decision.DecidablePlan<typeof stringDefinition>

      assert.isTrue(Decision.isPrepared(plan))
      assert.isFalse(Decision.isPrepared(clone))
      assert.isFalse(Decision.isPrepared(forged))

      for (const candidate of [clone, forged]) {
        const result = yield* Effect.result(RunStart.make(candidate, { value: "input" }, {
          runId: "forged-run",
          backend: "durable"
        }))
        const error = failure(result)
        assert.strictEqual(error.code, RunStart.Codes.InvalidConfiguration)
        assert.include(error.message, "Decision.prepare")
      }
    }))

  it.effect("uses workflow schema transformations and their encoding services", () => {
    class WirePrefix extends Context.Service<WirePrefix, {
      readonly value: string
    }>()("RunStartTest/WirePrefix") {}

    const NumberWithPrefix = Schema.String.pipe(
      Schema.decodeTo(
        Schema.Number,
        SchemaTransformation.transformOrFail({
          decode: (value) => Effect.succeed(Number(value)),
          encode: (value) =>
            Effect.gen(function*() {
              const prefix = yield* WirePrefix
              return `${prefix.value}${value}`
            })
        })
      )
    )
    const definition = makeDefinition("run-start-service", {
      count: Port.output(NumberWithPrefix, { contract: "run-start/count" })
    })

    return Effect.gen(function*() {
      const plan = yield* prepare(definition)
      const draft = yield* RunStart.make(plan, { count: 42 }, {
        runId: "service-run",
        backend: "direct"
      }).pipe(Effect.provideService(WirePrefix, { value: "wire:" }))

      assert.deepStrictEqual(draft.payload.input, { count: "wire:42" })
    })
  })

  it.effect("detaches caller-owned encoded values and freezes them recursively", () => {
    const definition = makeDefinition("run-start-json", {
      document: Port.output(Schema.Json, { contract: "run-start/json" })
    })
    const caller = { nested: { value: "before" } }

    return Effect.gen(function*() {
      const plan = yield* prepare(definition)
      const draft = yield* RunStart.make(plan, { document: caller }, {
        runId: "snapshot-run",
        backend: "durable"
      })
      const encoded = draft.payload.input.document as Schema.JsonObject

      assert.notStrictEqual(encoded, caller)
      assert.notStrictEqual(encoded.nested, caller.nested)
      assert.isTrue(Object.isFrozen(encoded))
      assert.isTrue(Object.isFrozen(encoded.nested))
      caller.nested.value = "after"
      assert.deepStrictEqual(encoded, { nested: { value: "before" } })
    })
  })

  it.effect("rejects hostile input containers without invoking getters", () => {
    let ownGetterCalls = 0
    const accessorInput = {}
    Object.defineProperty(accessorInput, "value", {
      enumerable: true,
      get: () => {
        ownGetterCalls++
        return "accessor"
      }
    })

    let inheritedGetterCalls = 0
    const inheritedPrototype = {}
    Object.defineProperty(inheritedPrototype, "value", {
      enumerable: true,
      get: () => {
        inheritedGetterCalls++
        return "inherited"
      }
    })
    const inheritedInput = Object.create(inheritedPrototype)

    const nonEnumerableInput = {}
    Object.defineProperty(nonEnumerableInput, "value", {
      enumerable: false,
      value: "hidden"
    })

    const symbolInput = { value: "input" }
    Object.defineProperty(symbolInput, Symbol("extra"), {
      enumerable: true,
      value: "symbol"
    })

    const trappedInput = new Proxy({ value: "input" }, {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap")
      }
    })

    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, "must be an object"],
      [["input"], "Object.prototype or null"],
      [new Date(), "Object.prototype or null"],
      [accessorInput, "enumerable data property"],
      [inheritedInput, "Object.prototype or null"],
      [nonEnumerableInput, "enumerable data property"],
      [symbolInput, "symbol properties"],
      [{ value: "input", extra: true }, "Unknown workflow input 'extra'"],
      [{}, "missing declared input 'value'"],
      [trappedInput, "could not be inspected safely"]
    ]

    return Effect.gen(function*() {
      const plan = yield* prepare(stringDefinition)
      for (const [input, message] of cases) {
        const result = yield* Effect.result(RunStart.make(plan, input as never, {
          runId: "hostile-run",
          backend: "durable"
        }))
        const error = failure(result)
        assert.strictEqual(error.code, RunStart.Codes.InvalidInput)
        assert.include(error.message, message)
      }
      assert.strictEqual(ownGetterCalls, 0)
      assert.strictEqual(inheritedGetterCalls, 0)

      const accepted = Object.assign(Object.create(null), { value: "accepted" })
      const draft = yield* RunStart.make(plan, accepted, {
        runId: "null-prototype-run",
        backend: "direct"
      })
      assert.deepStrictEqual(draft.payload.input, { value: "accepted" })
    })
  })

  it.effect("preserves prototype-like workflow input names as own data", () => {
    const inputs = Object.fromEntries([
      ["__proto__", Port.output(Schema.String, { contract: "run-start/prototype" })],
      ["constructor", Port.output(Schema.String, { contract: "run-start/prototype" })],
      ["toString", Port.output(Schema.String, { contract: "run-start/prototype" })]
    ]) as {
      readonly "__proto__": ReturnType<typeof Port.output<typeof Schema.String, "run-start/prototype">>
      readonly constructor: ReturnType<typeof Port.output<typeof Schema.String, "run-start/prototype">>
      readonly toString: ReturnType<typeof Port.output<typeof Schema.String, "run-start/prototype">>
    }
    const definition = makeDefinition("run-start-prototype", inputs)
    const input = Object.assign(
      Object.create(null),
      Object.fromEntries([
        ["__proto__", "proto-value"],
        ["constructor", "constructor-value"],
        ["toString", "to-string-value"]
      ])
    )

    return Effect.gen(function*() {
      const plan = yield* prepare(definition)
      const draft = yield* RunStart.make(plan, input, {
        runId: "prototype-run",
        backend: "durable"
      })
      const encoded = draft.payload.input

      assert.deepStrictEqual(Object.keys(encoded).sort(), ["__proto__", "constructor", "toString"].sort())
      assert.strictEqual(Object.getPrototypeOf(encoded), Object.prototype)
      assert.strictEqual(Object.prototype.hasOwnProperty.call(encoded, "__proto__"), true)
      assert.strictEqual(encoded["__proto__"], "proto-value")
      assert.strictEqual(encoded.constructor, "constructor-value")
      assert.strictEqual(encoded.toString, "to-string-value")
      assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined)
    })
  })

  it.effect("rejects a dishonest codec that emits non-JSON without invoking accessors", () => {
    const dishonestJson = Schema.Unknown as unknown as typeof Schema.Json
    const definition = makeDefinition("run-start-dishonest", {
      value: Port.output(dishonestJson, { contract: "run-start/dishonest" })
    })
    let getterCalls = 0
    const emitted = {}
    Object.defineProperty(emitted, "secret", {
      enumerable: true,
      get: () => {
        getterCalls++
        return "secret"
      }
    })

    return Effect.gen(function*() {
      const plan = yield* prepare(definition)
      const result = yield* Effect.result(RunStart.make(plan, {
        value: emitted as unknown as Schema.Json
      }, {
        runId: "dishonest-run",
        backend: "durable"
      }))
      const error = failure(result)

      assert.strictEqual(error.code, RunStart.Codes.InvalidInput)
      assert.strictEqual(error.input, "value")
      assert.include(error.message, "must encode to strict JSON")
      assert.strictEqual(getterCalls, 0)
    })
  })

  it.effect("types codec defects while preserving Effect interruption", () => {
    const Defecting = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: Effect.succeed,
          encode: () => Effect.die("codec defect")
        })
      )
    )
    const Interrupting = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: Effect.succeed,
          encode: () => Effect.interrupt
        })
      )
    )
    const defectDefinition = makeDefinition("run-start-defect", {
      value: Port.output(Defecting, { contract: "run-start/defect" })
    })
    const interruptDefinition = makeDefinition("run-start-interrupt", {
      value: Port.output(Interrupting, { contract: "run-start/interrupt" })
    })

    return Effect.gen(function*() {
      const defectPlan = yield* prepare(defectDefinition)
      const defect = yield* Effect.result(RunStart.make(defectPlan, { value: "input" }, {
        runId: "defect-run",
        backend: "durable"
      }))
      const error = failure(defect)
      assert.strictEqual(error.code, RunStart.Codes.InvalidInput)
      assert.include(error.message, "codec failed unexpectedly")

      const interruptPlan = yield* prepare(interruptDefinition)
      const interrupted = yield* RunStart.make(interruptPlan, { value: "input" }, {
        runId: "interrupt-run",
        backend: "durable"
      }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(interrupted))
      assert.isTrue(Cause.hasInterrupts(interrupted.cause))
    })
  })

  it.effect("validates configuration and uses stable collision-free event identities", () =>
    Effect.gen(function*() {
      const plan = yield* prepare(stringDefinition)
      const invalidRun = yield* Effect.result(RunStart.make(plan, { value: "input" }, {
        runId: "",
        backend: "durable"
      }))
      const invalidBackend = yield* Effect.result(RunStart.make(plan, { value: "input" }, {
        runId: "run-1",
        backend: "" as RunStart.Backend
      }))

      assert.strictEqual(failure(invalidRun).code, RunStart.Codes.InvalidConfiguration)
      assert.strictEqual(failure(invalidBackend).code, RunStart.Codes.InvalidConfiguration)

      const first = yield* RunStart.make(plan, { value: "input" }, {
        runId: "run:[one,two]",
        backend: "direct"
      })
      const retried = yield* RunStart.make(plan, { value: "input" }, {
        runId: "run:[one,two]",
        backend: "durable"
      })
      const distinct = RunStart.eventId("run:[one],[two]")

      assert.strictEqual(first.eventId, retried.eventId)
      assert.notStrictEqual(first.eventId, distinct)
      assert.notStrictEqual(first.eventId, Command.succeedRunCommandId("run:[one,two]"))
      assert.deepStrictEqual(JSON.parse(first.eventId), [
        "@effect/workflow-builder",
        1,
        "RunStarted",
        "run:[one,two]"
      ])
    }))
})
