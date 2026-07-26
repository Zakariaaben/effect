import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Engine from "../src/Engine.ts"
import * as Expression from "../src/Expression.ts"
import * as HumanTasks from "../src/HumanTasks.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunJournal from "../src/RunJournal.ts"
import * as Runs from "../src/Runs.ts"
import * as Workflow from "../src/Workflow.ts"

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

describe("Hardening", () => {
  describe("expression evaluation is stack-safe on deep data", () => {
    it("compares deeply nested values without overflowing", () => {
      const deep = (depth: number): Schema.Json => {
        let value: Schema.Json = 0
        for (let index = 0; index < depth; index++) {
          value = { next: value }
        }
        return value
      }
      const expression = Expression.eq(Expression.ref("input", "a"), Expression.ref("input", "b"))
      const equal = Expression.evaluate(expression, { input: { a: deep(20000), b: deep(20000) } })
      assert.deepStrictEqual(equal, Result.succeed(true))

      const unequal = Expression.evaluate(expression, { input: { a: deep(20000), b: deep(19999) } })
      assert.deepStrictEqual(unequal, Result.succeed(false))
    })
  })

  describe("expression record with a __proto__ field", () => {
    it("keeps __proto__ as data without mutating the result prototype", () => {
      // A hostile plan carries `__proto__` as a genuine own key (as JSON.parse
      // produces), not the object-literal prototype-set syntax.
      const record = Schema.decodeUnknownSync(Expression.Expression)(
        JSON.parse(
          `{"_tag":"Record","fields":{"__proto__":{"_tag":"Literal","value":"payload"},"ok":{"_tag":"Literal","value":1}}}`
        )
      )
      const evaluated = Expression.evaluate(record, {})
      assert.isTrue(Result.isSuccess(evaluated))
      if (Result.isSuccess(evaluated)) {
        const value = evaluated.success as Record<string, unknown>
        assert.strictEqual(Object.getPrototypeOf(value), Object.prototype)
        assert.deepStrictEqual(Object.keys(value).sort(), ["__proto__", "ok"])
        assert.strictEqual((value as { ok: number }).ok, 1)
        // Object.prototype was not polluted.
        assert.isUndefined(({} as Record<string, unknown>).payload)
      }
    })
  })

  describe("plan admission bounds nesting before schema decode", () => {
    const definition = Workflow.make("test/hardening", {
      version: "1.0.0",
      nodes: Registry.make(Builtins.Transform),
      linkPolicy: LinkPolicy.allowAll,
      limits: new Workflow.Limits({
        maxNodes: 8,
        maxEdges: 8,
        maxFanIn: 4,
        maxFanOut: 4,
        maxDepth: 4
      })
    })

    it.effect("rejects an overdeep expression as a diagnostic, not a stack overflow", () =>
      Effect.gen(function*() {
        let condition: Schema.Json = { _tag: "Literal", value: true }
        for (let index = 0; index < Compiler.AdmissionMaxDepth + 50; index++) {
          condition = { _tag: "Not", operand: condition }
        }
        const plan = {
          formatVersion: 2,
          id: "overdeep",
          revision: 1,
          definition: { id: "test/hardening", version: "1.0.0" },
          nodes: [{ id: "gate", type: "workflow/if", version: "1.0.0", config: { condition } }],
          edges: []
        }
        const error = yield* Compiler.compile(definition, plan).pipe(Effect.flip)
        assert.strictEqual(error._tag, "CompilationError")
        assert.strictEqual(error.diagnostics[0].code, Compiler.Codes.InvalidPlanSchema)
      }).pipe(Effect.provide(Layer.succeed(Crypto.Crypto)(testCrypto))))
  })

  describe("fan-out bounds reject denial-of-service plans at admission", () => {
    const registry = Registry.make(Builtins.While, Builtins.ForEach, Builtins.Delay)
    const definition = Workflow.make("test/bounds", {
      version: "1.0.0",
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits: new Workflow.Limits({ maxNodes: 8, maxEdges: 8, maxFanIn: 4, maxFanOut: 4, maxDepth: 4 })
    })
    const boundsPlan = (nodeConfig: object, type: string) => ({
      formatVersion: 2,
      id: "bounds",
      revision: 1,
      definition: { id: "test/bounds", version: "1.0.0" },
      nodes: [{ id: "n", type, version: "1.0.0", config: nodeConfig }],
      edges: []
    })
    const rejects = (type: string, config: object) =>
      Effect.gen(function*() {
        const error = yield* Compiler.compile(definition, boundsPlan(config, type)).pipe(Effect.flip)
        assert.strictEqual(error._tag, "CompilationError")
        assert.include(error.diagnostics.map((diagnostic) => diagnostic.code), Compiler.Codes.InvalidNodeConfig)
      }).pipe(Effect.provide(Layer.succeed(Crypto.Crypto)(testCrypto)))

    it.effect("rejects an unbounded while iteration count", () =>
      rejects("workflow/while", {
        condition: { _tag: "Literal", value: true },
        plan: { planId: "body" },
        maxIterations: Builtins.MaxIterations + 1
      }))

    it.effect("rejects an oversized forEach concurrency", () =>
      rejects("workflow/forEach", {
        items: { _tag: "Literal", value: [] },
        plan: { planId: "body" },
        mode: "parallel",
        concurrency: Builtins.MaxConcurrency + 1
      }))

    it.effect("rejects a wait horizon beyond the hard ceiling", () =>
      rejects("workflow/delay", { durationMillis: Builtins.MaxWaitMillis + 1 }))
  })

  describe("run journal timeline is causally ordered", () => {
    const probe = Node.make("Probe", {
      version: "1.0.0",
      outputs: { value: Port.output(Schema.String, { contract: "*" }) }
    })
    const registry = Registry.make(probe, Builtins.Transform)
    const definition = Workflow.make("test/journal-order", {
      version: "1.0.0",
      nodes: registry,
      linkPolicy: LinkPolicy.allowAll,
      limits: new Workflow.Limits({ maxNodes: 8, maxEdges: 8, maxFanIn: 4, maxFanOut: 4, maxDepth: 4 })
    })
    const handlers = registry.toLayer(registry.of({
      "Probe@1.0.0": () => Effect.succeed({ value: "x" })
    }))
    const layer = Engine.layer(definition).pipe(
      Layer.provideMerge(
        Layer.mergeAll(handlers, PlanStore.layerMemory, HumanTasks.layerMemory, RunJournal.layerMemory)
      ),
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
    )

    it.effect("orders RunStarted first and RunSucceeded last regardless of wall clock", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, {
          formatVersion: 2,
          id: "ordered",
          revision: 1,
          definition: { id: "test/journal-order", version: "1.0.0" },
          nodes: [
            { id: "a", type: "Probe", version: "1.0.0", config: {} },
            { id: "b", type: "Probe", version: "1.0.0", config: {} },
            { id: "c", type: "Probe", version: "1.0.0", config: {} }
          ],
          edges: []
        })
        const store = yield* PlanStore.PlanStore
        yield* store.save(compiled)

        const handle = yield* Runs.start("ordered", { input: {}, runKey: "timeline" })
        yield* Runs.await(handle.runId, { pollInterval: "5 millis" }).pipe(TestClock.withLive)
        const entries = yield* RunJournal.timeline(handle.runId)

        assert.strictEqual(entries[0]!._tag, "RunStarted")
        assert.strictEqual(entries[entries.length - 1]!._tag, "RunSucceeded")
        const sequences = entries.map((entry) => entry.sequence)
        const sorted = [...sequences].sort((left, right) => left - right)
        assert.deepStrictEqual(sequences, sorted)
      }).pipe(Effect.provide(layer)))
  })
})
