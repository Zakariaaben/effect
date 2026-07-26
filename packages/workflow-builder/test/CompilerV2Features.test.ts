import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as Expression from "../src/Expression.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const step = Node.make("Step", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  }
})

const risky = Node.make("Risky", {
  version: "1.0.0",
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  },
  failure: Schema.Struct({ reason: Schema.String })
})

const numberSink = Node.make("NumberSink", {
  version: "1.0.0",
  inputs: {
    count: Port.input(Schema.Number, { contract: "example/number" })
  }
})

const retriable = Node.make("Retriable", {
  version: "1.0.0",
  policy: {
    retry: { maxAttempts: 3, initialDelayMillis: 100 },
    timeouts: { attemptMillis: 1_000 }
  }
})

const registry = Registry.make(
  Builtins.If,
  Builtins.Switch,
  Builtins.Transform,
  Builtins.Receive,
  Builtins.Fail,
  Builtins.HumanTask,
  step,
  risky,
  numberSink,
  retriable
)

const limits = () =>
  new Workflow.Limits({
    maxNodes: 32,
    maxEdges: 64,
    maxFanIn: 8,
    maxFanOut: 8,
    maxDepth: 16
  })

const definition = Workflow.make("v2-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  },
  outputs: {},
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits: limits()
})

const planNode = (
  id: string,
  type: string,
  config: unknown = {},
  extra: Record<string, unknown> = {}
) => ({ id, type, version: "1.0.0", config, ...extra })

const stepNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "Step",
  version: "1.0.0",
  config: {},
  bindings: { value: Expression.literal("text") },
  ...extra
})

const nodeOutput = (nodeId: string, output: string) => ({ _tag: "NodeOutput" as const, nodeId, output })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })

const dataEdge = (
  id: string,
  source: ReturnType<typeof nodeOutput>,
  target: ReturnType<typeof nodeInput>,
  extra: Record<string, unknown> = {}
) => ({ _tag: "DataEdge" as const, id, source, target, ...extra })

const controlEdge = (
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  outcome?: string,
  metadata?: unknown
) => ({
  _tag: "ControlEdge" as const,
  id,
  sourceNodeId,
  targetNodeId,
  ...(outcome === undefined ? {} : { outcome }),
  ...(metadata === undefined ? {} : { metadata })
})

const makePlan = (
  nodes: ReadonlyArray<unknown>,
  edges: ReadonlyArray<unknown>,
  definitionReference: { readonly id: string; readonly version: string } = {
    id: "v2-workflow",
    version: "1.0.0"
  }
) => ({
  formatVersion: 2,
  id: "v2-plan",
  revision: 1,
  definition: definitionReference,
  nodes,
  edges
})

const codes = (error: Diagnostic.CompilationError): ReadonlyArray<string> =>
  error.diagnostics.map((diagnostic) => diagnostic.code)

const assertIncludesCodes = (
  error: Diagnostic.CompilationError,
  expected: ReadonlyArray<string>
): void => {
  const actual = codes(error)
  for (const code of expected) {
    assert.ok(actual.includes(code), `Expected diagnostic code ${code}; received ${actual.join(", ")}`)
  }
}

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

describe("CompilerV2Features", () => {
  describe("control edge outcomes", () => {
    it.effect("resolves the default 'done' outcome for untagged control edges", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(
          [stepNode("a"), stepNode("b")],
          [controlEdge("a-b", "a", "b")]
        ))

        assert.strictEqual(compiled.controlEdges.length, 1)
        assert.strictEqual(compiled.controlEdges[0]!.outcome, "done")
        assert.deepStrictEqual(compiled.nodes.get("b")?.dependencies, ["a"])
        assert.deepStrictEqual(compiled.topologicalOrder, ["a", "b"])
      }))

    it.effect("accepts declared branch outcomes and reports unknown ones with the available set", () =>
      Effect.gen(function*() {
        const gate = planNode("gate", "workflow/if", { condition: Expression.literal(true) })
        const compiled = yield* Compiler.compile(definition, makePlan(
          [gate, stepNode("then")],
          [controlEdge("gate-then", "gate", "then", "true")]
        ))
        assert.strictEqual(compiled.controlEdges[0]!.outcome, "true")
        assert.deepStrictEqual(compiled.nodes.get("gate")?.outcomes, ["true", "false"])

        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [gate, stepNode("then")],
          [controlEdge("gate-then", "gate", "then", "maybe")]
        )))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.UnknownOutcome])
        assert.deepStrictEqual(error.diagnostics[0]!.details, {
          nodeId: "gate",
          outcome: "maybe",
          available: ["true", "false"]
        })
      }))

    it.effect("routes the reserved 'error' outcome only for declared failures", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(
          [planNode("risky", "Risky"), stepNode("handler")],
          [controlEdge("on-error", "risky", "handler", "error")]
        ))
        assert.strictEqual(compiled.controlEdges[0]!.outcome, "error")
        assert.isTrue(compiled.nodes.get("risky")?.errorOutcome)

        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [stepNode("a"), stepNode("b")],
          [controlEdge("on-error", "a", "b", "error")]
        )))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.UnknownOutcome])
        assert.isFalse(compiled.nodes.get("handler")?.errorOutcome)
      }))
  })

  describe("outcomes from config", () => {
    it.effect("derives switch outcomes from case names plus 'default'", () =>
      Effect.gen(function*() {
        const route = planNode("route", "workflow/switch", {
          cases: [
            {
              name: "high",
              condition: Expression.compare("gt", Expression.ref("input", "amount"), Expression.literal(100))
            },
            { name: "low", condition: Expression.literal(true) }
          ]
        })
        const compiled = yield* Compiler.compile(definition, makePlan(
          [route, stepNode("h"), stepNode("l"), stepNode("d")],
          [
            controlEdge("route-h", "route", "h", "high"),
            controlEdge("route-l", "route", "l", "low"),
            controlEdge("route-d", "route", "d", "default")
          ]
        ))

        assert.deepStrictEqual(compiled.nodes.get("route")?.outcomes, ["high", "low", "default"])
        assert.strictEqual(compiled.controlEdges.length, 3)
      }))

    it.effect("rejects duplicate case names and cases shadowing 'default'", () =>
      Effect.gen(function*() {
        const duplicate = yield* Effect.flip(Compiler.compile(definition, makePlan([
          planNode("route", "workflow/switch", {
            cases: [
              { name: "dup", condition: Expression.literal(true) },
              { name: "dup", condition: Expression.literal(false) }
            ]
          })
        ], [])))
        assert.deepStrictEqual(codes(duplicate), [Compiler.Codes.InvalidOutcomes])

        const shadowed = yield* Effect.flip(Compiler.compile(definition, makePlan([
          planNode("route", "workflow/switch", {
            cases: [{ name: "default", condition: Expression.literal(true) }]
          })
        ], [])))
        assert.deepStrictEqual(codes(shadowed), [Compiler.Codes.InvalidOutcomes])
      }))

    it.effect("makes human task decisions routable, adding 'expired' only with a deadline", () =>
      Effect.gen(function*() {
        const base = { title: "Review order", outcomes: ["approve", "reject"] }
        const decided = yield* Compiler.compile(definition, makePlan(
          [planNode("review", "workflow/humanTask", base), stepNode("approved")],
          [controlEdge("on-approve", "review", "approved", "approve")]
        ))
        assert.deepStrictEqual(decided.nodes.get("review")?.outcomes, ["approve", "reject"])

        const expiring = yield* Compiler.compile(definition, makePlan(
          [planNode("review", "workflow/humanTask", { ...base, dueInMillis: 60_000 }), stepNode("escalate")],
          [controlEdge("on-expired", "review", "escalate", "expired")]
        ))
        assert.deepStrictEqual(expiring.nodes.get("review")?.outcomes, ["approve", "reject", "expired"])

        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [planNode("review", "workflow/humanTask", base), stepNode("escalate")],
          [controlEdge("on-expired", "review", "escalate", "expired")]
        )))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.UnknownOutcome])
      }))
  })

  describe("bindings", () => {
    it.effect("rejects bindings on undeclared input ports", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(definition, makePlan([
          stepNode("a", {
            bindings: {
              value: Expression.literal("text"),
              nope: Expression.literal(1)
            }
          })
        ], [])))

        assert.deepStrictEqual(codes(error), [Compiler.Codes.UnknownBindingInput])
      }))

    it.effect("rejects an input supplied by both a binding and a data edge", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [stepNode("src"), stepNode("b")],
          [dataEdge("src-b", nodeOutput("src", "value"), nodeInput("b", "value"))]
        )))

        assert.deepStrictEqual(codes(error), [Compiler.Codes.ConflictingInputBinding])
      }))

    it.effect("satisfies required inputs through bindings alone", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan([stepNode("only")], []))

        assert.deepStrictEqual(
          compiled.nodes.get("only")?.bindings.get("value"),
          Expression.literal("text")
        )
        assert.strictEqual(compiled.nodes.get("only")?.incoming.length, 0)
      }))
  })

  describe("expression references", () => {
    const boundStep = (expression: Expression.Expression) =>
      planNode("b", "Step", {}, { bindings: { value: expression } })

    it.effect("rejects references to unknown nodes, own outputs, and unknown ports", () =>
      Effect.gen(function*() {
        const unknownNode = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [stepNode("a"), boundStep(Expression.ref("nodes", "ghost", "value"))],
          []
        )))
        assert.deepStrictEqual(codes(unknownNode), [Compiler.Codes.InvalidExpression])

        const selfReference = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [boundStep(Expression.ref("nodes", "b", "value"))],
          []
        )))
        assert.deepStrictEqual(codes(selfReference), [Compiler.Codes.InvalidExpression])

        const unknownPort = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [stepNode("a"), boundStep(Expression.ref("nodes", "a", "missing"))],
          []
        )))
        assert.deepStrictEqual(codes(unknownPort), [Compiler.Codes.InvalidExpression])
      }))

    it.effect("accepts the 'input' root unconditionally and rejects unknown roots", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(
          [boundStep(Expression.ref("input", "anything", "deep"))],
          []
        ))
        assert.deepStrictEqual(compiled.nodes.get("b")?.dependencies, [])

        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [boundStep(Expression.ref("vars", "x"))],
          []
        )))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidExpression])
      }))

    it.effect("derives implicit dependencies from binding references", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(
          [stepNode("a"), boundStep(Expression.ref("nodes", "a", "value"))],
          []
        ))

        assert.deepStrictEqual(compiled.nodes.get("b")?.dependencies, ["a"])
        assert.deepStrictEqual(compiled.nodes.get("a")?.dependents, ["b"])
        assert.deepStrictEqual(compiled.topologicalOrder, ["a", "b"])
      }))
  })

  describe("edge transforms", () => {
    const nodes = [stepNode("src"), planNode("sink", "NumberSink")]

    it.effect("exempts transformed edges from contract equality", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(nodes, [
          dataEdge("src-sink", nodeOutput("src", "value"), nodeInput("sink", "count"), {
            transform: Expression.size(Expression.ref("value"))
          })
        ]))
        assert.strictEqual(compiled.dataEdges.length, 1)
        assert.deepStrictEqual(compiled.nodes.get("sink")?.dependencies, ["src"])

        const untransformed = yield* Effect.flip(Compiler.compile(definition, makePlan(nodes, [
          dataEdge("src-sink", nodeOutput("src", "value"), nodeInput("sink", "count"))
        ])))
        assertIncludesCodes(untransformed, [Compiler.Codes.IncompatibleContract])
      }))

    it.effect("validates transform expressions against the plan graph", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(nodes, [
          dataEdge("src-sink", nodeOutput("src", "value"), nodeInput("sink", "count"), {
            transform: Expression.ref("nodes", "ghost", "value")
          })
        ])))

        assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidExpression])
      }))
  })

  describe("wildcard contracts", () => {
    it.effect("connects builtin '*' outputs to typed inputs without a transform", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(
          [
            planNode("t", "workflow/transform", { value: Expression.literal("hello") }),
            planNode("s", "Step")
          ],
          [dataEdge("t-s", nodeOutput("t", "value"), nodeInput("s", "value"))]
        ))

        assert.strictEqual(compiled.dataEdges.length, 1)
        assert.deepStrictEqual(compiled.nodes.get("s")?.dependencies, ["t"])
      }))
  })

  describe("signals", () => {
    it.effect("rejects two receive nodes waiting on the same signal name", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(definition, makePlan([
          planNode("r1", "workflow/receive", { signal: "go" }),
          planNode("r2", "workflow/receive", { signal: "go" })
        ], [])))

        assert.deepStrictEqual(codes(error), [Compiler.Codes.DuplicateSignal])
      }))

    it.effect("maps distinct signal names to their waiting nodes", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan([
          planNode("r1", "workflow/receive", { signal: "go" }),
          planNode("r2", "workflow/receive", { signal: "stop" })
        ], []))

        assert.strictEqual(compiled.signals.size, 2)
        assert.strictEqual(compiled.signals.get("go"), "r1")
        assert.strictEqual(compiled.signals.get("stop"), "r2")
      }))
  })

  describe("joins", () => {
    it.effect("rejects join 'any' without incoming control edges", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(definition, makePlan(
          [stepNode("solo", { join: "any" })],
          []
        )))

        assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidJoin])
      }))

    it.effect("accepts join 'any' fed by a control edge", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan(
          [stepNode("first"), stepNode("solo", { join: "any" })],
          [controlEdge("first-solo", "first", "solo")]
        ))

        assert.strictEqual(compiled.nodes.get("solo")?.join, "any")
        assert.strictEqual(compiled.nodes.get("first")?.join, "all")
      }))
  })

  describe("definition validation", () => {
    it.effect("rejects app definitions squatting the reserved 'workflow/' namespace", () => {
      const rogue = Node.make("workflow/custom", { version: "1.0.0" })
      const reservedDefinition = Workflow.make("reserved-workflow", {
        version: "1.0.0",
        inputs: {},
        outputs: {},
        nodes: Registry.make(rogue),
        linkPolicy: LinkPolicy.allowAll,
        limits: limits()
      })

      return Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(
          reservedDefinition,
          makePlan([], [], { id: "reserved-workflow", version: "1.0.0" })
        ))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.ReservedTypeNamespace])
      })
    })

    it.effect("rejects definitions pairing a declared failure with an 'error' output port", () => {
      const clash = Node.make("Clash", {
        version: "1.0.0",
        outputs: {
          error: Port.output(Schema.String, { contract: "example/text" })
        },
        failure: Schema.Struct({ reason: Schema.String })
      })
      const clashDefinition = Workflow.make("clash-workflow", {
        version: "1.0.0",
        inputs: {},
        outputs: {},
        nodes: Registry.make(clash),
        linkPolicy: LinkPolicy.allowAll,
        limits: limits()
      })

      return Effect.gen(function*() {
        const error = yield* Effect.flip(Compiler.compile(
          clashDefinition,
          makePlan([], [], { id: "clash-workflow", version: "1.0.0" })
        ))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidDefinition])
      })
    })
  })

  describe("policy merge", () => {
    it.effect("overrides definition defaults wholesale per policy field", () =>
      Effect.gen(function*() {
        const compiled = yield* Compiler.compile(definition, makePlan([
          planNode("defaulted", "Retriable"),
          planNode("overridden", "Retriable", {}, { policy: { retry: { maxAttempts: 1 } } })
        ], []))

        assert.deepStrictEqual(compiled.nodes.get("defaulted")?.policy, {
          retry: { maxAttempts: 3, initialDelayMillis: 100 },
          timeouts: { attemptMillis: 1_000 }
        })
        assert.deepStrictEqual(compiled.nodes.get("overridden")?.policy, {
          retry: { maxAttempts: 1 },
          timeouts: { attemptMillis: 1_000 }
        })
      }))
  })

  describe("fingerprint stability", () => {
    it.effect("ignores metadata and authoring order but commits configuration", () =>
      Effect.gen(function*() {
        const planA = makePlan(
          [
            planNode("t1", "workflow/transform", { value: Expression.literal(1) }, { metadata: { x: 10 } }),
            planNode("r1", "Retriable", {}, { metadata: { y: 20 } })
          ],
          [controlEdge("t1-r1", "t1", "r1", undefined, { label: "after" })]
        )
        const planB = makePlan(
          [
            planNode("r1", "Retriable"),
            planNode("t1", "workflow/transform", { value: Expression.literal(1) }, { metadata: { moved: true } })
          ],
          [controlEdge("t1-r1", "t1", "r1", undefined, { label: "renamed" })]
        )
        const planC = makePlan(
          [
            planNode("t1", "workflow/transform", { value: Expression.literal(2) }, { metadata: { x: 10 } }),
            planNode("r1", "Retriable", {}, { metadata: { y: 20 } })
          ],
          [controlEdge("t1-r1", "t1", "r1", undefined, { label: "after" })]
        )

        const compiledA = yield* Compiler.compile(definition, planA)
        const compiledB = yield* Compiler.compile(definition, planB)
        const compiledC = yield* Compiler.compile(definition, planC)
        const fingerprintA = yield* Fingerprint.make(compiledA)
        const fingerprintB = yield* Fingerprint.make(compiledB)
        const fingerprintC = yield* Fingerprint.make(compiledC)

        assert.match(fingerprintA, /^sha256:[0-9a-f]{64}$/)
        assert.strictEqual(fingerprintA, fingerprintB)
        assert.notStrictEqual(fingerprintA, fingerprintC)
      }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
  })
})
