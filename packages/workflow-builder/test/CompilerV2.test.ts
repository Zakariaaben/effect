import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const makeDefinition = (contract: string) => {
  const step = Node.make("Step", {
    version: "1.0.0",
    config: Schema.Struct({ label: Schema.String }),
    inputs: {
      value: Port.input(Schema.String, { contract })
    },
    outputs: {
      value: Port.output(Schema.String, { contract })
    }
  })
  const merge = Node.make("Merge", {
    version: "1.0.0",
    config: Schema.Struct({ mode: Schema.Literal("all") }),
    inputs: {
      values: Port.input(Schema.String, {
        contract,
        cardinality: "many"
      })
    },
    outputs: {
      value: Port.output(Schema.String, { contract })
    }
  })
  return Workflow.make("compiler-v2-workflow", {
    version: "1.0.0",
    inputs: {
      "z-input": Port.output(Schema.String, { contract }),
      "A-input": Port.output(Schema.String, {
        contract,
        fanOut: "single"
      })
    },
    outputs: {
      "z-unused": Port.input(Schema.String, {
        contract,
        required: false
      }),
      "A-output": Port.input(Schema.String, { contract })
    },
    nodes: Registry.make(step, merge),
    linkPolicy: LinkPolicy.allowAll,
    limits: new Workflow.Limits({
      maxNodes: 16,
      maxEdges: 32,
      maxFanIn: 8,
      maxFanOut: 8,
      maxDepth: 8
    })
  })
}

const definition = makeDefinition("example/text")

const workflowInput = (input: string) => ({
  _tag: "WorkflowInput" as const,
  input
})

const nodeOutput = (nodeId: string, output: string) => ({
  _tag: "NodeOutput" as const,
  nodeId,
  output
})

const nodeInput = (nodeId: string, input: string) => ({
  _tag: "NodeInput" as const,
  nodeId,
  input
})

const workflowOutput = (output: string) => ({
  _tag: "WorkflowOutput" as const,
  output
})

const basePlan = {
  formatVersion: 1 as const,
  id: "compiler-v2-plan",
  revision: 7,
  definition: {
    id: "compiler-v2-workflow",
    version: "1.0.0"
  },
  nodes: [
    {
      id: "😀-sink",
      type: "Step",
      version: "1.0.0",
      config: { label: "sink" }
    },
    {
      id: "ä-merge",
      type: "Merge",
      version: "1.0.0",
      config: { mode: "all" }
    },
    {
      id: "z-root",
      type: "Step",
      version: "1.0.0",
      config: { label: "z" }
    },
    {
      id: "A-root",
      type: "Step",
      version: "1.0.0",
      config: { label: "A" }
    }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "z-sink-output",
      source: nodeOutput("😀-sink", "value"),
      target: workflowOutput("A-output")
    },
    {
      _tag: "DataEdge" as const,
      id: "y-merge-sink",
      source: nodeOutput("ä-merge", "value"),
      target: nodeInput("😀-sink", "value")
    },
    {
      _tag: "DataEdge" as const,
      id: "x-z-merge",
      source: nodeOutput("z-root", "value"),
      target: nodeInput("ä-merge", "values"),
      order: 1
    },
    {
      _tag: "DataEdge" as const,
      id: "w-a-merge",
      source: nodeOutput("A-root", "value"),
      target: nodeInput("ä-merge", "values"),
      order: 0
    },
    {
      _tag: "DataEdge" as const,
      id: "v-z-input",
      source: workflowInput("z-input"),
      target: nodeInput("z-root", "value")
    },
    {
      _tag: "DataEdge" as const,
      id: "u-a-input",
      source: workflowInput("A-input"),
      target: nodeInput("A-root", "value")
    }
  ]
}

const text = (document: CompilerV2.FingerprintDocument): string => JSON.stringify(document)

const expectValid = (
  input: unknown
): CompilerV2.FingerprintDocument => {
  const result = CompilerV2.validateFingerprintDocument(input)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

describe("CompilerV2", () => {
  it.effect("removes presentation metadata from canonical meaning", () =>
    Effect.gen(function*() {
      const plain = yield* CompilerV2.compile(definition, basePlan)
      const decorated = yield* CompilerV2.compile(definition, {
        ...basePlan,
        metadata: {
          title: "Designer-only title",
          viewport: { x: 20, y: 40 }
        },
        nodes: basePlan.nodes.map((node, index) => ({
          ...node,
          metadata: {
            position: [index * 10, index * 20],
            selected: index === 0
          }
        })),
        edges: basePlan.edges.map((edge, index) => ({
          ...edge,
          metadata: {
            label: `visual-${index}`,
            bendpoints: [[index, index + 1]]
          }
        }))
      })

      assert.deepStrictEqual(
        decorated.fingerprintDocument,
        plain.fingerprintDocument
      )
      assert.isFalse(
        Object.prototype.hasOwnProperty.call(
          plain.fingerprintDocument.semanticPlan,
          "metadata"
        )
      )
      assert.isFalse(
        Object.prototype.hasOwnProperty.call(
          plain.fingerprintDocument.semanticPlan.nodes[0]!,
          "metadata"
        )
      )
    }))

  it.effect("is invariant to source node and edge permutations", () =>
    Effect.gen(function*() {
      const original = yield* CompilerV2.compile(definition, basePlan)
      const permuted = yield* CompilerV2.compile(definition, {
        ...basePlan,
        nodes: [...basePlan.nodes].reverse(),
        edges: [
          basePlan.edges[2]!,
          basePlan.edges[5]!,
          basePlan.edges[0]!,
          basePlan.edges[4]!,
          basePlan.edges[1]!,
          basePlan.edges[3]!
        ]
      })

      assert.deepStrictEqual(
        permuted.fingerprintDocument,
        original.fingerprintDocument
      )
    }))

  it.effect("commits config, endpoints, explicit order, contracts, and topology", () =>
    Effect.gen(function*() {
      const baseline = yield* CompilerV2.compile(definition, basePlan)
      const changedConfig = yield* CompilerV2.compile(definition, {
        ...basePlan,
        nodes: basePlan.nodes.map((node) =>
          node.id === "A-root"
            ? { ...node, config: { label: "changed" } }
            : node
        )
      })
      const changedEndpoint = yield* CompilerV2.compile(definition, {
        ...basePlan,
        edges: basePlan.edges.map((edge) => {
          if (edge.id === "u-a-input") {
            return { ...edge, source: workflowInput("z-input") }
          }
          if (edge.id === "v-z-input") {
            return { ...edge, source: workflowInput("A-input") }
          }
          return edge
        })
      })
      const changedOrder = yield* CompilerV2.compile(definition, {
        ...basePlan,
        edges: basePlan.edges.map((edge) => {
          if (edge.id === "w-a-merge") {
            return { ...edge, order: 1 }
          }
          if (edge.id === "x-z-merge") {
            return { ...edge, order: 0 }
          }
          return edge
        })
      })
      const changedContract = yield* CompilerV2.compile(
        makeDefinition("example/alternate-text"),
        basePlan
      )
      const changedTopology = yield* CompilerV2.compile(definition, {
        ...basePlan,
        edges: [
          ...basePlan.edges,
          {
            _tag: "ControlEdge" as const,
            id: "t-z-before-a",
            sourceNodeId: "z-root",
            targetNodeId: "A-root"
          }
        ]
      })

      for (
        const changed of [
          changedConfig,
          changedEndpoint,
          changedOrder,
          changedContract,
          changedTopology
        ]
      ) {
        assert.notStrictEqual(
          text(changed.fingerprintDocument),
          text(baseline.fingerprintDocument)
        )
      }
      assert.notStrictEqual(
        JSON.stringify(
          changedTopology.fingerprintDocument.program.topologicalOrder
        ),
        JSON.stringify(
          baseline.fingerprintDocument.program.topologicalOrder
        )
      )
    }))

  it.effect("uses code-unit ordering and a canonical Kahn tie-break", () =>
    Effect.gen(function*() {
      const prepared = yield* CompilerV2.compile(definition, basePlan)
      const document = prepared.fingerprintDocument

      assert.deepStrictEqual(
        document.semanticPlan.nodes.map((node) => node.id),
        ["A-root", "z-root", "ä-merge", "😀-sink"]
      )
      assert.deepStrictEqual(
        document.semanticPlan.dataEdges.map((edge) => edge.id),
        [
          "u-a-input",
          "v-z-input",
          "w-a-merge",
          "x-z-merge",
          "y-merge-sink",
          "z-sink-output"
        ]
      )
      assert.deepStrictEqual(
        document.workflowInterface.inputs.map((input) => input.name),
        ["A-input", "z-input"]
      )
      assert.deepStrictEqual(
        document.workflowInterface.outputs.map((output) => output.name),
        ["A-output", "z-unused"]
      )
      assert.deepStrictEqual(document.program.topologicalOrder, [
        "A-root",
        "z-root",
        "ä-merge",
        "😀-sink"
      ])
      assert.deepStrictEqual(document.program.stages, [
        ["A-root", "z-root"],
        ["ä-merge"],
        ["😀-sink"]
      ])
      assert.deepStrictEqual(
        document.program.nodes.find((node) => node.id === "ä-merge"),
        {
          id: "ä-merge",
          type: "Merge",
          version: "1.0.0",
          incomingEdgeIds: ["w-a-merge", "x-z-merge"],
          outgoingEdgeIds: ["y-merge-sink"],
          dependencies: ["A-root", "z-root"],
          dependents: ["😀-sink"]
        }
      )
      assert.strictEqual(
        document.program.dataEdges.find((edge) => edge.id === "w-a-merge")?.order,
        0
      )
      assert.isTrue(Object.isFrozen(document))
      assert.isTrue(Object.isFrozen(document.program.stages[0]))
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(CompilerV2.FingerprintDocument)(document),
        document
      )
    }))

  it.effect("uses process-local provenance for prepared and compiled plans", () =>
    Effect.gen(function*() {
      const prepared = yield* CompilerV2.compile(definition, basePlan)

      assert.isTrue(CompilerV2.isPreparedPlan(prepared))
      assert.isFalse(CompilerV2.isPreparedPlan({ ...prepared }))
      assert.throws(() => CompilerV2.materialize({ ...prepared.compiled } as never))
      assert.deepStrictEqual(
        CompilerV2.materialize(prepared.compiled),
        prepared.fingerprintDocument
      )
    }))

  it.effect("rejects hostile, excess, and relationally forged documents without throwing", () =>
    Effect.gen(function*() {
      const prepared = yield* CompilerV2.compile(definition, basePlan)
      const document = prepared.fingerprintDocument
      let getterReads = 0
      const hostile = Object.defineProperty({}, "fingerprintVersion", {
        enumerable: true,
        get: () => {
          getterReads++
          return 2
        }
      })

      const hostileResult = CompilerV2.validateFingerprintDocument(hostile)
      assert.isTrue(Result.isFailure(hostileResult))
      assert.strictEqual(
        hostileResult.failure.code,
        CompilerV2.ValidationCodes.InvalidJson
      )
      assert.strictEqual(getterReads, 0)

      const excess = CompilerV2.validateFingerprintDocument({
        ...document,
        unexpected: true
      })
      assert.isTrue(Result.isFailure(excess))
      assert.strictEqual(
        excess.failure.code,
        CompilerV2.ValidationCodes.InvalidSchema
      )

      const unknownEndpoint = CompilerV2.validateFingerprintDocument({
        ...document,
        semanticPlan: {
          ...document.semanticPlan,
          dataEdges: document.semanticPlan.dataEdges.map((edge) =>
            edge.id === "w-a-merge"
              ? {
                ...edge,
                source: nodeOutput("missing-node", "value")
              }
              : edge
          )
        }
      })
      assert.isTrue(Result.isFailure(unknownEndpoint))
      assert.strictEqual(
        unknownEndpoint.failure.code,
        CompilerV2.ValidationCodes.InvalidRelation
      )

      const nonCanonical = CompilerV2.validateFingerprintDocument({
        ...document,
        program: {
          ...document.program,
          nodes: [...document.program.nodes].reverse()
        }
      })
      assert.isTrue(Result.isFailure(nonCanonical))
      assert.strictEqual(
        nonCanonical.failure.code,
        CompilerV2.ValidationCodes.NonCanonical
      )
    }))

  it.effect("rejects every compiler-v2 document version discriminator change", () =>
    Effect.gen(function*() {
      const prepared = yield* CompilerV2.compile(definition, basePlan)
      const document = prepared.fingerprintDocument
      const cases: ReadonlyArray<unknown> = [
        { ...document, fingerprintVersion: 1 },
        { ...document, compilerSemanticVersion: "1" },
        {
          ...document,
          workflowInterface: {
            ...document.workflowInterface,
            interfaceVersion: 1
          }
        },
        {
          ...document,
          program: {
            ...document.program,
            programVersion: 2
          }
        }
      ]

      for (const value of cases) {
        const result = CompilerV2.validateFingerprintDocument(value)
        assert.isTrue(Result.isFailure(result))
        assert.strictEqual(
          result.failure.code,
          CompilerV2.ValidationCodes.InvalidSchema
        )
      }
      assert.deepStrictEqual(expectValid(document), document)
    }))
})
