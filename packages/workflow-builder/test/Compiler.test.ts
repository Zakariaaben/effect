import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Compiler from "../src/Compiler.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const step = Node.make("Step", {
  version: "1.0.0",
  config: Schema.Struct({ attempts: Schema.NumberFromString }),
  inputs: {
    value: Port.input(Schema.String, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  }
})

const merge = Node.make("Merge", {
  version: "1.0.0",
  inputs: {
    values: Port.input(Schema.String, {
      contract: "example/text",
      cardinality: "many"
    })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  }
})

const registry = Registry.make(step, merge)

interface LimitValues {
  readonly maxNodes: number
  readonly maxEdges: number
  readonly maxFanIn: number
  readonly maxFanOut: number
  readonly maxDepth: number
}

const defaultLimits: LimitValues = {
  maxNodes: 16,
  maxEdges: 32,
  maxFanIn: 8,
  maxFanOut: 8,
  maxDepth: 8
}

const limits = (overrides: Partial<LimitValues> = {}): Workflow.Limits =>
  new Workflow.Limits({ ...defaultLimits, ...overrides })

const makeWorkflow = <E, R>(
  linkPolicy: LinkPolicy.LinkPolicy<E, R>,
  options: {
    readonly limits?: Partial<LimitValues> | undefined
    readonly input?: Port.Output.Any | undefined
  } = {}
) =>
  Workflow.make("test-workflow", {
    version: "1.0.0",
    inputs: {
      value: options.input ?? Port.output(Schema.String, { contract: "example/text" })
    },
    outputs: {
      value: Port.input(Schema.String, { contract: "example/text" })
    },
    nodes: registry,
    linkPolicy,
    limits: limits(options.limits)
  })

const definition = makeWorkflow(LinkPolicy.allowAll)

const planNode = (
  id: string,
  type: string,
  version: string,
  config: unknown
) => ({ id, type, version, config })

const workflowInput = (input: string) => ({ _tag: "WorkflowInput" as const, input })
const nodeOutput = (nodeId: string, output: string) => ({ _tag: "NodeOutput" as const, nodeId, output })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })
const workflowOutput = (output: string) => ({ _tag: "WorkflowOutput" as const, output })

type TestSource = ReturnType<typeof workflowInput> | ReturnType<typeof nodeOutput>
type TestTarget = ReturnType<typeof nodeInput> | ReturnType<typeof workflowOutput>

const dataEdge = (
  id: string,
  source: TestSource,
  target: TestTarget,
  order?: number
) => ({
  _tag: "DataEdge" as const,
  id,
  source,
  target,
  ...(order === undefined ? {} : { order })
})

const controlEdge = (id: string, sourceNodeId: string, targetNodeId: string) => ({
  _tag: "ControlEdge" as const,
  id,
  sourceNodeId,
  targetNodeId
})

type TestNode = ReturnType<typeof planNode>
type TestEdge = ReturnType<typeof dataEdge> | ReturnType<typeof controlEdge>

const makePlan = (
  nodes: ReadonlyArray<TestNode>,
  edges: ReadonlyArray<TestEdge>,
  definitionReference: { readonly id: string; readonly version: string } = {
    id: "test-workflow",
    version: "1.0.0"
  }
) => ({
  formatVersion: 1,
  id: "test-plan",
  revision: 2,
  definition: definitionReference,
  nodes,
  edges
})

const basePlan = makePlan(
  [
    planNode("root", "Step", "1.0.0", { attempts: "1" }),
    planNode("left", "Step", "1.0.0", { attempts: "2" }),
    planNode("right", "Step", "1.0.0", { attempts: "3" }),
    planNode("merge", "Merge", "1.0.0", {})
  ],
  [
    dataEdge("input-root", workflowInput("value"), nodeInput("root", "value")),
    dataEdge("root-left", nodeOutput("root", "value"), nodeInput("left", "value")),
    dataEdge("root-right", nodeOutput("root", "value"), nodeInput("right", "value")),
    dataEdge("left-merge", nodeOutput("left", "value"), nodeInput("merge", "values"), 1),
    dataEdge("right-merge", nodeOutput("right", "value"), nodeInput("merge", "values"), 0),
    dataEdge("merge-output", nodeOutput("merge", "value"), workflowOutput("value"))
  ]
)

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

describe("Compiler", () => {
  it.effect("compiles a branched DAG with validated portable config and deterministic stages", () =>
    Effect.gen(function*() {
      const first = yield* Compiler.compile(definition, basePlan)
      const second = yield* Compiler.compile(definition, basePlan)

      assert.deepStrictEqual(first.topologicalOrder, ["root", "left", "right", "merge"])
      assert.deepStrictEqual(first.stages, [["root"], ["left", "right"], ["merge"]])
      assert.deepStrictEqual(second.topologicalOrder, first.topologicalOrder)
      assert.deepStrictEqual(second.stages, first.stages)
      assert.deepStrictEqual(first.nodes.get("root")?.node.config, { attempts: "1" })
      assert.deepStrictEqual(first.nodes.get("left")?.node.config, { attempts: "2" })
      assert.deepStrictEqual(first.nodes.get("right")?.node.config, { attempts: "3" })
      assert.strictEqual(first.dataEdges.length, 6)
      assert.strictEqual(first.controlEdges.length, 0)
      assert.deepStrictEqual(first.nodes.get("merge")?.dependencies, ["left", "right"])
      assert.deepStrictEqual(
        first.nodes.get("merge")?.incoming.map((edge) => edge.edge.id),
        ["right-merge", "left-merge"]
      )
    }))

  it.effect("protects compiled topology from runtime mutation", () =>
    Effect.gen(function*() {
      const callerPlan = {
        ...basePlan,
        nodes: basePlan.nodes.map((node) => ({
          ...node,
          config: { ...(node.config as Readonly<Record<string, unknown>>) }
        })),
        edges: basePlan.edges.map((edge) => ({ ...edge }))
      }
      const compiled = yield* Compiler.compile(definition, callerPlan)
      const nodes = compiled.nodes as ReadonlyMap<string, Compiler.CompiledNode> & {
        readonly clear?: unknown
        readonly set?: unknown
      }

      assert.strictEqual(nodes.clear, undefined)
      assert.strictEqual(nodes.set, undefined)
      assert.notStrictEqual(compiled.plan, callerPlan)
      assert.notStrictEqual(compiled.plan.nodes, callerPlan.nodes)
      assert.isFalse(Object.isFrozen(callerPlan))
      assert.isFalse(Object.isFrozen(callerPlan.nodes))
      assert.isFalse(Object.isFrozen(callerPlan.nodes[0]))
      assert.isTrue(Object.isFrozen(compiled.plan))
      assert.isTrue(Object.isFrozen(compiled.plan.nodes))
      assert.isTrue(Object.isFrozen(compiled.plan.nodes[0]))
      assert.isTrue(Object.isFrozen(compiled.plan.nodes[0]?.config))
      assert.isTrue(Object.isFrozen(compiled.dataEdges))
      assert.isTrue(Object.isFrozen(compiled.dataEdges[0]?.source))
      const callerConfig = callerPlan.nodes[0]!.config as Record<string, unknown>
      callerConfig.attempts = "99"
      assert.deepStrictEqual(compiled.plan.nodes[0]?.config, { attempts: "1" })
    }))

  it.effect("rejects hostile JSON containers without invoking accessors or defecting", () => {
    let getterCalls = 0
    const accessor = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterCalls++
        return "not-observed"
      }
    })

    const overriddenArray = [1]
    Object.defineProperty(overriddenArray, "map", {
      enumerable: true,
      value: () => []
    })

    const overriddenIterator = [1]
    Object.defineProperty(overriddenIterator, Symbol.iterator, {
      enumerable: false,
      value: () => [][Symbol.iterator]()
    })

    const sparseArray = new Array<unknown>(2)
    sparseArray[1] = "present"

    const decoratedArray = [1] as Array<number> & { decoration?: string }
    decoratedArray.decoration = "unexpected"

    const symbolProperty = { value: 1 }
    Object.defineProperty(symbolProperty, Symbol("hidden"), {
      enumerable: true,
      value: true
    })

    const nonEnumerableProperty = { value: 1 }
    Object.defineProperty(nonEnumerableProperty, "hidden", {
      enumerable: false,
      value: true
    })

    const customPrototype = Object.assign(Object.create({ inherited: true }), { value: 1 })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    const cases: ReadonlyArray<unknown> = [
      accessor,
      { nested: overriddenArray },
      { nested: overriddenIterator },
      { nested: sparseArray },
      { nested: decoratedArray },
      symbolProperty,
      nonEnumerableProperty,
      customPrototype,
      cyclic
    ].map((metadata) => ({ ...basePlan, metadata }))

    return Effect.gen(function*() {
      for (const input of cases) {
        const error = yield* Effect.flip(Compiler.compile(definition, input))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidPlanSchema])
      }
      assert.strictEqual(getterCalls, 0)
    })
  })

  it.effect("reports malformed portable plans as schema diagnostics", () =>
    Effect.gen(function*() {
      const malformed = [
        { ...basePlan, formatVersion: 2 },
        { ...basePlan, unexpected: true },
        {
          ...basePlan,
          nodes: [{ ...basePlan.nodes[0]!, config: { callback: () => undefined } }]
        }
      ]

      for (const input of malformed) {
        const error = yield* Effect.flip(Compiler.compile(definition, input))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidPlanSchema])
      }
    }))

  it.effect("rejects a plan pinned to a different workflow definition", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        definition: { id: "another-workflow", version: "9.0.0" }
      }))

      assert.deepStrictEqual(codes(error), [Compiler.Codes.DefinitionMismatch])
    }))

  it.effect("reports duplicate node and edge identifiers", () =>
    Effect.gen(function*() {
      const duplicateNode = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        nodes: [...basePlan.nodes, planNode("root", "Step", "1.0.0", { attempts: "4" })]
      }))
      assert.deepStrictEqual(codes(duplicateNode), [Compiler.Codes.DuplicateNodeId])

      const duplicateEdge = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        edges: [
          ...basePlan.edges,
          dataEdge("input-root", workflowInput("value"), nodeInput("root", "value"))
        ]
      }))
      assert.deepStrictEqual(codes(duplicateEdge), [Compiler.Codes.DuplicateEdgeId])
    }))

  it.effect("reports unknown node types and pinned versions", () =>
    Effect.gen(function*() {
      for (
        const replacement of [
          { type: "Missing", version: "1.0.0" },
          { type: "Step", version: "2.0.0" }
        ]
      ) {
        const error = yield* Effect.flip(Compiler.compile(definition, {
          ...basePlan,
          nodes: basePlan.nodes.map((node) => node.id === "left" ? { ...node, ...replacement } : node)
        }))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.UnknownNodeDefinition])
      }
    }))

  it.effect("reports data edges that reference unknown source and target nodes", () =>
    Effect.gen(function*() {
      const unknownSource = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        edges: basePlan.edges.map((edge) =>
          edge.id === "left-merge"
            ? dataEdge("left-merge", nodeOutput("ghost", "value"), nodeInput("merge", "values"), 1)
            : edge
        )
      }))
      assertIncludesCodes(unknownSource, [Compiler.Codes.UnknownSourceNode])

      const unknownTarget = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        edges: basePlan.edges.map((edge) =>
          edge.id === "root-left"
            ? dataEdge("root-left", nodeOutput("root", "value"), nodeInput("ghost", "value"))
            : edge
        )
      }))
      assertIncludesCodes(unknownTarget, [
        Compiler.Codes.UnknownTargetNode,
        Compiler.Codes.MissingRequiredInput
      ])
    }))

  it.effect("reports unknown workflow and node ports", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, unknown]> = [
        [Compiler.Codes.UnknownWorkflowInput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "input-root"
              ? dataEdge("input-root", workflowInput("missing"), nodeInput("root", "value"))
              : edge
          )
        }],
        [Compiler.Codes.UnknownWorkflowOutput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "merge-output"
              ? dataEdge("merge-output", nodeOutput("merge", "value"), workflowOutput("missing"))
              : edge
          )
        }],
        [Compiler.Codes.UnknownNodeInput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "input-root"
              ? dataEdge("input-root", workflowInput("value"), nodeInput("root", "missing"))
              : edge
          )
        }],
        [Compiler.Codes.UnknownNodeOutput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "root-left"
              ? dataEdge("root-left", nodeOutput("root", "missing"), nodeInput("left", "value"))
              : edge
          )
        }]
      ]

      for (const [expected, input] of cases) {
        const error = yield* Effect.flip(Compiler.compile(definition, input))
        assertIncludesCodes(error, [expected])
      }
    }))

  it.effect("never resolves inherited object properties as ports", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, unknown]> = [
        [Compiler.Codes.UnknownWorkflowInput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "input-root"
              ? dataEdge("input-root", workflowInput("toString"), nodeInput("root", "value"))
              : edge
          )
        }],
        [Compiler.Codes.UnknownNodeOutput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "root-left"
              ? dataEdge("root-left", nodeOutput("root", "toString"), nodeInput("left", "value"))
              : edge
          )
        }],
        [Compiler.Codes.UnknownWorkflowOutput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "merge-output"
              ? dataEdge("merge-output", nodeOutput("merge", "value"), workflowOutput("toString"))
              : edge
          )
        }],
        [Compiler.Codes.UnknownNodeInput, {
          ...basePlan,
          edges: basePlan.edges.map((edge) =>
            edge.id === "input-root"
              ? dataEdge("input-root", workflowInput("value"), nodeInput("root", "toString"))
              : edge
          )
        }]
      ]

      for (const [expected, input] of cases) {
        const error = yield* Effect.flip(Compiler.compile(definition, input))
        assertIncludesCodes(error, [expected])
      }
    }))

  it.effect("keeps composite endpoint identities collision-free", () => {
    const firstTarget = Node.make("FirstTarget", {
      version: "1.0.0",
      inputs: {
        c: Port.input(Schema.String, { contract: "example/text" })
      }
    })
    const secondTarget = Node.make("SecondTarget", {
      version: "1.0.0",
      inputs: {
        "b:input:c": Port.input(Schema.String, { contract: "example/text" })
      }
    })
    const collisionDefinition = Workflow.make("collision-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: "example/text" })
      },
      outputs: {},
      nodes: Registry.make(firstTarget, secondTarget),
      linkPolicy: LinkPolicy.allowAll,
      limits: limits()
    })
    const collisionPlan = {
      formatVersion: 1,
      id: "collision-plan",
      revision: 1,
      definition: { id: "collision-workflow", version: "1.0.0" },
      nodes: [
        planNode("a:input:b", "FirstTarget", "1.0.0", {}),
        planNode("a", "SecondTarget", "1.0.0", {})
      ],
      edges: [
        dataEdge("first", workflowInput("value"), nodeInput("a:input:b", "c")),
        dataEdge("second", workflowInput("value"), nodeInput("a", "b:input:c"))
      ]
    }

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(collisionDefinition, collisionPlan)
      assert.strictEqual(compiled.dataEdges.length, 2)
    })
  })

  it.effect("does not resolve a different type-version pair with the same display key", () => {
    const registered = Node.make("a@b", { version: "c" })
    const collisionDefinition = Workflow.make("registry-key-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {},
      nodes: Registry.make(registered),
      linkPolicy: LinkPolicy.allowAll,
      limits: limits()
    })
    const collisionPlan = makePlan(
      [planNode("node", "a", "b@c", {})],
      [],
      { id: "registry-key-workflow", version: "1.0.0" }
    )

    return Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(collisionDefinition, collisionPlan))
      assert.deepStrictEqual(codes(error), [Compiler.Codes.UnknownNodeDefinition])
    })
  })

  it.effect("reports invalid node configuration after plan decoding", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        nodes: basePlan.nodes.map((node) => node.id === "root" ? { ...node, config: { attempts: 1 } } : node)
      }))

      assert.deepStrictEqual(codes(error), [Compiler.Codes.InvalidNodeConfig])
    }))

  it.effect("enforces port contracts before link authorization", () => {
    const incompatible = makeWorkflow(LinkPolicy.allowAll, {
      input: Port.output(Schema.String, { contract: "example/other" })
    })

    return Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(incompatible, basePlan))
      assertIncludesCodes(error, [Compiler.Codes.IncompatibleContract])
    })
  })

  it.effect("reports links denied by the workflow policy", () => {
    const denied = makeWorkflow(LinkPolicy.denyAll)

    return Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(denied, basePlan))
      assertIncludesCodes(error, [Compiler.Codes.UnauthorizedLink])
    })
  })

  it.effect("reports missing required node inputs and workflow outputs", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        edges: basePlan.edges.filter((edge) => edge.id !== "input-root" && edge.id !== "merge-output")
      }))

      assert.deepStrictEqual(codes(error), [
        Compiler.Codes.MissingRequiredInput,
        Compiler.Codes.MissingRequiredOutput
      ])
    }))

  it.effect("enforces one-cardinality and many-input fan-in limits", () =>
    Effect.gen(function*() {
      const oneCardinality = yield* Effect.flip(Compiler.compile(definition, {
        ...basePlan,
        edges: [
          ...basePlan.edges,
          dataEdge("input-root-again", workflowInput("value"), nodeInput("root", "value"))
        ]
      }))
      assert.deepStrictEqual(codes(oneCardinality), [Compiler.Codes.InputCardinalityExceeded])

      const restricted = makeWorkflow(LinkPolicy.allowAll, {
        limits: { maxFanIn: 1 }
      })
      const manyCardinality = yield* Effect.flip(Compiler.compile(restricted, basePlan))
      assert.deepStrictEqual(codes(manyCardinality), [Compiler.Codes.InputCardinalityExceeded])
    }))

  it.effect("enforces output fan-out limits", () => {
    const restricted = makeWorkflow(LinkPolicy.allowAll, {
      limits: { maxFanOut: 1 }
    })

    return Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(restricted, basePlan))
      assert.deepStrictEqual(codes(error), [Compiler.Codes.OutputFanOutExceeded])
    })
  })

  it.effect("requires explicit unique ordering for many-input links", () =>
    Effect.gen(function*() {
      const missingOrder = {
        ...basePlan,
        edges: basePlan.edges.map((edge) =>
          edge.id === "left-merge"
            ? dataEdge("left-merge", nodeOutput("left", "value"), nodeInput("merge", "values"))
            : edge
        )
      }
      const duplicateOrder = {
        ...basePlan,
        edges: basePlan.edges.map((edge) =>
          edge.id === "left-merge"
            ? dataEdge("left-merge", nodeOutput("left", "value"), nodeInput("merge", "values"), 0)
            : edge
        )
      }

      for (const input of [missingOrder, duplicateOrder]) {
        const error = yield* Effect.flip(Compiler.compile(definition, input))
        assert.deepStrictEqual(codes(error), [Compiler.Codes.AmbiguousEdgeOrder])
      }
    }))

  it.effect("enforces node, edge, and graph-depth limits independently", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [Partial<LimitValues>, string]> = [
        [{ maxNodes: 3 }, "nodes"],
        [{ maxEdges: 5 }, "edges"],
        [{ maxDepth: 2 }, "depth"]
      ]

      for (const [limit, resource] of cases) {
        const restricted = makeWorkflow(LinkPolicy.allowAll, { limits: limit })
        const error = yield* Effect.flip(Compiler.compile(restricted, basePlan))
        const diagnostic = error.diagnostics.find((item) => item.code === Compiler.Codes.LimitExceeded)

        assert.isDefined(diagnostic)
        assert.strictEqual(diagnostic.details?.resource, resource)
      }
    }))

  it.effect("stops oversized plans before config decoding or link authorization", () => {
    let decoderCalls = 0
    let authorizationCalls = 0
    const countedConfig = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value) => {
          decoderCalls++
          return value
        }),
        encode: SchemaGetter.passthrough()
      })
    )
    const counted = Node.make("Counted", {
      version: "1.0.0",
      config: countedConfig
    })
    const countedDefinition = Workflow.make("counted-workflow", {
      version: "1.0.0",
      inputs: {
        value: Port.output(Schema.String, { contract: "example/text" })
      },
      outputs: {
        value: Port.input(Schema.String, { contract: "example/text" })
      },
      nodes: Registry.make(counted),
      linkPolicy: LinkPolicy.make(() => {
        authorizationCalls++
        return Effect.succeed(true)
      }),
      limits: limits({ maxNodes: 1, maxEdges: 1 })
    })
    const oversized = makePlan(
      [
        planNode("first", "Counted", "1.0.0", "first"),
        planNode("second", "Counted", "1.0.0", "second")
      ],
      [
        dataEdge("first", workflowInput("value"), workflowOutput("value")),
        dataEdge("second", workflowInput("value"), workflowOutput("value"))
      ],
      { id: "counted-workflow", version: "1.0.0" }
    )

    return Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(countedDefinition, oversized))
      assert.deepStrictEqual(codes(error), [
        Compiler.Codes.LimitExceeded,
        Compiler.Codes.LimitExceeded
      ])
      assert.strictEqual(decoderCalls, 0)
      assert.strictEqual(authorizationCalls, 0)
    })
  })

  it.effect("detects cycles introduced by data and control dependencies", () => {
    const loop = Node.make("Loop", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, {
          contract: "example/text",
          required: false
        })
      },
      outputs: {
        value: Port.output(Schema.String, { contract: "example/text" })
      }
    })
    const cyclicDefinition = Workflow.make("test-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {},
      nodes: Registry.make(loop),
      linkPolicy: LinkPolicy.allowAll,
      limits: limits()
    })
    const nodes = [
      planNode("a", "Loop", "1.0.0", {}),
      planNode("b", "Loop", "1.0.0", {})
    ]

    return Effect.gen(function*() {
      const dataCycle = yield* Effect.flip(Compiler.compile(
        cyclicDefinition,
        makePlan(nodes, [
          dataEdge("a-b", nodeOutput("a", "value"), nodeInput("b", "value")),
          dataEdge("b-a", nodeOutput("b", "value"), nodeInput("a", "value"))
        ])
      ))
      assert.deepStrictEqual(codes(dataCycle), [Compiler.Codes.CycleDetected])

      const controlCycle = yield* Effect.flip(Compiler.compile(
        cyclicDefinition,
        makePlan(nodes, [
          controlEdge("a-before-b", "a", "b"),
          controlEdge("b-before-a", "b", "a")
        ])
      ))
      assert.deepStrictEqual(codes(controlCycle), [Compiler.Codes.CycleDetected])
    })
  })

  it.effect("runs custom policies with Effect requirements", () => {
    class AllowedEdges extends Context.Service<AllowedEdges, ReadonlySet<string>>()(
      "@effect/workflow-builder/test/Compiler/AllowedEdges"
    ) {}

    const policy = LinkPolicy.make((context) => Effect.map(AllowedEdges, (allowed) => allowed.has(context.edgeId)))
    const customDefinition = makeWorkflow(policy)

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(customDefinition, basePlan)
      assert.strictEqual(compiled.dataEdges.length, basePlan.edges.length)
    }).pipe(
      Effect.provideService(
        AllowedEdges,
        new Set(basePlan.edges.map((edge) => edge.id))
      )
    )
  })

  it.effect("propagates custom policy errors without turning them into denials", () => {
    const policyFailure = { _tag: "PolicyFailure" as const, reason: "unavailable" }
    const failingDefinition = makeWorkflow(
      LinkPolicy.make(() => Effect.fail(policyFailure))
    )

    return Effect.gen(function*() {
      const error = yield* Effect.flip(Compiler.compile(failingDefinition, basePlan))
      assert.strictEqual(error, policyFailure)
    })
  })
})
