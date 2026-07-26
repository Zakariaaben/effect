import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Diagnostic from "../src/Diagnostic.ts"
import * as Engine from "../src/Engine.ts"
import * as Expression from "../src/Expression.ts"
import * as HumanTasks from "../src/HumanTasks.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Runs from "../src/Runs.ts"
import * as Workflow from "../src/Workflow.ts"

const limits = new Workflow.Limits({
  maxNodes: 16,
  maxEdges: 32,
  maxFanIn: 4,
  maxFanOut: 8,
  maxDepth: 8
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

const savePlan = (definition: Workflow.Any, plan: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, plan)
    const store = yield* PlanStore.PlanStore
    yield* store.save(compiled)
    return compiled
  })

const diagnosticCodes = (definition: Workflow.Any, plan: unknown) =>
  Compiler.compile(definition, plan).pipe(
    Effect.flip,
    Effect.map((error) => (error as Diagnostic.CompilationError).diagnostics.map((d) => d.code))
  )

const awaitStatus = (
  runId: string,
  done: (status: Runs.RunStatus) => boolean,
  adjust?: Duration.Input
) =>
  Effect.gen(function*() {
    let status = yield* Runs.status(runId)
    for (let index = 0; index < 200 && !done(status); index++) {
      if (adjust !== undefined) {
        yield* TestClock.adjust(adjust)
      }
      yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
      status = yield* Runs.status(runId)
    }
    return status
  })

// ----------------------------------------------------------------------------
// Open boundary: the plan declares its own interface
// ----------------------------------------------------------------------------

const doubler = Node.make("Double", {
  version: "1.0.0",
  inputs: { value: Port.input(Schema.Number, { contract: "test/number" }) },
  outputs: { value: Port.output(Schema.Number, { contract: "test/number" }) }
})

const openRegistry = Registry.make(doubler, Builtins.Transform)

const openDefinition = Workflow.make("test/open", {
  version: "1.0.0",
  contracts: { "test/number": Schema.Number },
  nodes: openRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const openHandlers = openRegistry.toLayer(openRegistry.of({
  "Double@1.0.0": ({ inputs }) => Effect.succeed({ value: inputs.value * 2 })
}))

const OpenLayer = Engine.layer(openDefinition).pipe(
  Layer.provideMerge(Layer.mergeAll(openHandlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

const openPlan = {
  formatVersion: 2,
  id: "open-plan",
  revision: 1,
  definition: { id: "test/open", version: "1.0.0" },
  inputs: [
    { name: "amount", contract: "test/number" },
    { name: "note", contract: "test/text", required: false }
  ],
  outputs: [{ name: "doubled", contract: "test/number" }],
  nodes: [{ id: "double", type: "Double", version: "1.0.0", config: {} }],
  edges: [
    {
      _tag: "DataEdge",
      id: "in",
      source: { _tag: "WorkflowInput", input: "amount" },
      target: { _tag: "NodeInput", nodeId: "double", input: "value" }
    },
    {
      _tag: "DataEdge",
      id: "out",
      source: { _tag: "NodeOutput", nodeId: "double", output: "value" },
      target: { _tag: "WorkflowOutput", output: "doubled" }
    }
  ]
}

// ----------------------------------------------------------------------------
// External completion
// ----------------------------------------------------------------------------

const issuedTokens = new Map<string, string>()

const signature = Node.make("Signature", {
  version: "1.0.0",
  config: Schema.Struct({ envelope: Schema.String }),
  outcomes: ["signed", "declined"],
  external: true
})

const timedSignature = Node.make("TimedSignature", {
  version: "1.0.0",
  config: Schema.Struct({ timeoutMillis: Schema.Int }),
  outcomes: ["signed", "expired"],
  external: { deadline: (config) => config.timeoutMillis }
})

const externalRegistry = Registry.make(signature, timedSignature, Builtins.Transform)

const externalDefinition = Workflow.make("test/external", {
  version: "1.0.0",
  nodes: externalRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const externalHandlers = externalRegistry.toLayer(externalRegistry.of({
  "Signature@1.0.0": ({ config, context }) =>
    Effect.sync(() => {
      issuedTokens.set(config.envelope, context.decisionToken!)
      return {}
    }),
  "TimedSignature@1.0.0": ({ context }) =>
    Effect.sync(() => {
      issuedTokens.set(context.planId, context.decisionToken!)
      return {}
    })
}))

const ExternalLayer = Engine.layer(externalDefinition).pipe(
  Layer.provideMerge(Layer.mergeAll(externalHandlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

describe("DualMode", () => {
  describe("open boundary", () => {
    it.effect("runs a plan that declares its own inputs and outputs", () =>
      Effect.gen(function*() {
        yield* savePlan(openDefinition, openPlan)
        const result = yield* Runs.execute("open-plan", { input: { amount: 21 } })
        assert.deepStrictEqual(result.outputs, { doubled: 42 })
      }).pipe(Effect.provide(OpenLayer)))

    it.effect("validates required and contract-typed inputs at run start", () =>
      Effect.gen(function*() {
        yield* savePlan(openDefinition, openPlan)

        const missing = yield* Runs.execute("open-plan", { input: {} }).pipe(Effect.flip)
        assert.strictEqual(missing._tag, "InputRejected")
        assert.strictEqual((missing as Engine.InputRejected).input, "amount")

        const mistyped = yield* Runs.execute("open-plan", { input: { amount: "NaN" } }).pipe(Effect.flip)
        assert.strictEqual(mistyped._tag, "InputRejected")
      }).pipe(Effect.provide(OpenLayer)))

    it.effect("rejects plan-declared boundaries against a closed definition", () =>
      Effect.gen(function*() {
        const closed = Workflow.make("test/closed", {
          version: "1.0.0",
          inputs: { amount: Port.output(Schema.Number, { contract: "test/number" }) },
          nodes: openRegistry,
          linkPolicy: LinkPolicy.allowAll,
          limits
        })
        const { outputs: _outputs, ...withoutOutputs } = openPlan
        const codes = yield* diagnosticCodes(closed, {
          ...withoutOutputs,
          definition: { id: "test/closed", version: "1.0.0" },
          edges: [openPlan.edges[0]]
        })
        assert.include(codes, Compiler.Codes.ClosedBoundary)
      }))

    it.effect("rejects duplicate plan-declared boundary names", () =>
      Effect.gen(function*() {
        const codes = yield* diagnosticCodes(openDefinition, {
          ...openPlan,
          inputs: [
            { name: "amount", contract: "test/number" },
            { name: "amount", contract: "test/number" }
          ]
        })
        assert.include(codes, Compiler.Codes.DuplicateBoundaryPort)
      }))
  })

  describe("external completion", () => {
    it.effect("completes an external node through its decision token", () =>
      Effect.gen(function*() {
        yield* savePlan(externalDefinition, {
          formatVersion: 2,
          id: "signing",
          revision: 1,
          definition: { id: "test/external", version: "1.0.0" },
          outputs: [{ name: "contract", contract: "*" }],
          nodes: [
            { id: "sign", type: "Signature", version: "1.0.0", config: { envelope: "env-1" } },
            {
              id: "confirm",
              type: "workflow/transform",
              version: "1.0.0",
              config: { value: Expression.ref("nodes", "sign", "decision", "documentUrl") }
            }
          ],
          edges: [
            { _tag: "ControlEdge", id: "ok", sourceNodeId: "sign", outcome: "signed", targetNodeId: "confirm" },
            {
              _tag: "DataEdge",
              id: "out",
              source: { _tag: "NodeOutput", nodeId: "confirm", output: "value" },
              target: { _tag: "WorkflowOutput", output: "contract" }
            }
          ]
        })

        const handle = yield* Runs.start("signing", { input: {} })
        for (let index = 0; index < 200 && !issuedTokens.has("env-1"); index++) {
          yield* Effect.sleep("5 millis").pipe(TestClock.withLive)
        }
        const token = issuedTokens.get("env-1")
        assert.isDefined(token)

        const canonical = yield* Runs.resolveDecision(token!, {
          outcome: "signed",
          output: { documentUrl: "s3://signed.pdf" }
        })
        assert.strictEqual(canonical.outcome, "signed")

        // A competing later decision observes the canonical winner instead.
        const loser = yield* Runs.resolveDecision(token!, { outcome: "declined", output: null })
        assert.strictEqual(loser.outcome, "signed")

        const status = yield* awaitStatus(handle.runId, (s) => s._tag !== "Running" && s._tag !== "Suspended")
        assert.strictEqual(status._tag, "Succeeded")
        assert.deepStrictEqual(
          (status as Extract<Runs.RunStatus, { _tag: "Succeeded" }>).value.outputs,
          { contract: "s3://signed.pdf" }
        )
      }).pipe(Effect.provide(ExternalLayer)))

    it.effect("expires an external node through its config-derived deadline", () =>
      Effect.gen(function*() {
        yield* savePlan(externalDefinition, {
          formatVersion: 2,
          id: "timed-signing",
          revision: 1,
          definition: { id: "test/external", version: "1.0.0" },
          outputs: [{ name: "expired", contract: "*" }],
          nodes: [
            { id: "sign", type: "TimedSignature", version: "1.0.0", config: { timeoutMillis: 5000 } },
            {
              id: "late",
              type: "workflow/transform",
              version: "1.0.0",
              config: { value: Expression.literal("deadline won") }
            }
          ],
          edges: [
            { _tag: "ControlEdge", id: "exp", sourceNodeId: "sign", outcome: "expired", targetNodeId: "late" },
            {
              _tag: "DataEdge",
              id: "out",
              source: { _tag: "NodeOutput", nodeId: "late", output: "value" },
              target: { _tag: "WorkflowOutput", output: "expired" }
            }
          ]
        })

        const handle = yield* Runs.start("timed-signing", { input: {} })
        const status = yield* awaitStatus(
          handle.runId,
          (s) => s._tag !== "Running" && s._tag !== "Suspended",
          "1 second"
        )
        assert.strictEqual(status._tag, "Succeeded")
        assert.deepStrictEqual(
          (status as Extract<Runs.RunStatus, { _tag: "Succeeded" }>).value.outputs,
          { expired: "deadline won" }
        )
      }).pipe(Effect.provide(ExternalLayer)))

    it.effect("rejects external definitions with declared outputs or missing expired outcome", () =>
      Effect.gen(function*() {
        const withOutputs = Node.make("BadExternal", {
          version: "1.0.0",
          outputs: { value: Port.output(Schema.String, { contract: "*" }) },
          external: true
        })
        const badRegistry = Registry.make(withOutputs)
        const badDefinition = Workflow.make("test/bad-external", {
          version: "1.0.0",
          nodes: badRegistry,
          linkPolicy: LinkPolicy.allowAll,
          limits
        })
        const codes = yield* diagnosticCodes(badDefinition, {
          formatVersion: 2,
          id: "bad",
          revision: 1,
          definition: { id: "test/bad-external", version: "1.0.0" },
          nodes: [{ id: "x", type: "BadExternal", version: "1.0.0", config: {} }],
          edges: []
        })
        assert.include(codes, Compiler.Codes.InvalidDefinition)

        const missingExpired = yield* diagnosticCodes(externalDefinition, {
          formatVersion: 2,
          id: "missing-expired",
          revision: 1,
          definition: { id: "test/external", version: "1.0.0" },
          nodes: [
            // TimedSignature declares "expired", so use a config-level check via
            // a definition without it.
            { id: "sign", type: "Signature", version: "1.0.0", config: { envelope: "e" } }
          ],
          edges: [{
            _tag: "ControlEdge",
            id: "bad-outcome",
            sourceNodeId: "sign",
            outcome: "expired",
            targetNodeId: "sign"
          }]
        })
        assert.include(missingExpired, Compiler.Codes.UnknownOutcome)
      }))
  })
})
