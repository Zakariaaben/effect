import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Bpmn from "../src/Bpmn.ts"
import * as Builtins from "../src/Builtins.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Engine from "../src/Engine.ts"
import * as Expression from "../src/Expression.ts"
import * as HumanTasks from "../src/HumanTasks.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Runs from "../src/Runs.ts"
import * as Workflow from "../src/Workflow.ts"

const definitionReference = { id: "test/bpmn", version: "1.0.0" }

const score = Node.make("Score", {
  version: "1.0.0",
  outputs: { value: Port.output(Schema.Number, { contract: "test/number" }) }
})

const registry = Registry.make(
  score,
  Builtins.Switch,
  Builtins.Transform,
  Builtins.HumanTask,
  Builtins.Fail,
  Builtins.Delay,
  Builtins.Receive,
  Builtins.SubWorkflow
)

const definition = Workflow.make("test/bpmn", {
  version: "1.0.0",
  contracts: { "test/number": Schema.Number },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 32,
    maxEdges: 64,
    maxFanIn: 8,
    maxFanOut: 8,
    maxDepth: 16
  })
})

const condition = (comparison: "gt" | "le") =>
  JSON.stringify(Expression.compare(comparison, Expression.ref("nodes", "score", "value"), Expression.literal(10)))

const scoringXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:wb="${Bpmn.ExtensionNamespace}" id="defs" targetNamespace="urn:test">
  <bpmn:process id="scoring" isExecutable="true">
    <bpmn:extensionElements>
      <wb:outputs>[{"name":"band","contract":"*"}]</wb:outputs>
      <wb:dataEdges>[
        {"_tag":"DataEdge","id":"hi-out","source":{"_tag":"NodeOutput","nodeId":"high","output":"value"},"target":{"_tag":"WorkflowOutput","output":"band"}},
        {"_tag":"DataEdge","id":"lo-out","source":{"_tag":"NodeOutput","nodeId":"low","output":"value"},"target":{"_tag":"WorkflowOutput","output":"band"}}
      ]</wb:dataEdges>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="score" name="Score the case">
      <bpmn:extensionElements>
        <wb:node type="Score" version="1.0.0"/>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:exclusiveGateway id="band" default="toLow"/>
    <bpmn:serviceTask id="high">
      <bpmn:extensionElements>
        <wb:node type="workflow/transform" version="1.0.0"/>
        <wb:config>{"value":{"_tag":"Literal","value":"high"}}</wb:config>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="low">
      <bpmn:extensionElements>
        <wb:node type="workflow/transform" version="1.0.0"/>
        <wb:config>{"value":{"_tag":"Literal","value":"low"}}</wb:config>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="done"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="score"/>
    <bpmn:sequenceFlow id="f2" sourceRef="score" targetRef="band"/>
    <bpmn:sequenceFlow id="toHigh" name="high" sourceRef="band" targetRef="high">
      <bpmn:conditionExpression language="${Bpmn.ExpressionLanguage}">${condition("gt")}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="toLow" name="low" sourceRef="band" targetRef="low"/>
    <bpmn:sequenceFlow id="f3" sourceRef="high" targetRef="done"/>
    <bpmn:sequenceFlow id="f4" sourceRef="low" targetRef="done"/>
  </bpmn:process>
</bpmn:definitions>`

const approvalXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:wb="${Bpmn.ExtensionNamespace}" id="defs" targetNamespace="urn:test">
  <bpmn:message id="msg1" name="docReady"/>
  <bpmn:process id="approval" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:intermediateCatchEvent id="waitDoc">
      <bpmn:messageEventDefinition messageRef="msg1"/>
    </bpmn:intermediateCatchEvent>
    <bpmn:userTask id="review" name="Review the document"/>
    <bpmn:intermediateCatchEvent id="cooldown">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT5M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:serviceTask id="archive">
      <bpmn:extensionElements>
        <wb:node type="Score" version="1.0.0"/>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="archiveError" attachedToRef="archive">
      <bpmn:errorEventDefinition/>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="rejected" name="Rejected">
      <bpmn:errorEventDefinition errorRef="REJECTED"/>
    </bpmn:endEvent>
    <bpmn:endEvent id="done"/>
    <bpmn:parallelGateway id="join"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="waitDoc"/>
    <bpmn:sequenceFlow id="f2" sourceRef="waitDoc" targetRef="review"/>
    <bpmn:sequenceFlow id="ok" name="approve" sourceRef="review" targetRef="cooldown"/>
    <bpmn:sequenceFlow id="no" name="reject" sourceRef="review" targetRef="rejected"/>
    <bpmn:sequenceFlow id="f3" sourceRef="cooldown" targetRef="join"/>
    <bpmn:sequenceFlow id="f4" sourceRef="join" targetRef="archive"/>
    <bpmn:sequenceFlow id="f5" sourceRef="archive" targetRef="done"/>
    <bpmn:sequenceFlow id="f6" sourceRef="archiveError" targetRef="rejected"/>
  </bpmn:process>
</bpmn:definitions>`

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

const handlers = registry.toLayer(registry.of({
  "Score@1.0.0": () => Effect.succeed({ value: 42 })
}))

const TestLayer = Engine.layer(definition).pipe(
  Layer.provideMerge(Layer.mergeAll(handlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(testCrypto))
)

const importPlan = (xml: string) => Bpmn.toPlan(xml, { definition: definitionReference })

const controlEdgesOf = (plan: Plan.Plan) =>
  plan.edges
    .filter((edge): edge is Plan.ControlEdge => edge._tag === "ControlEdge")
    .map((edge) => [edge.sourceNodeId, edge.outcome ?? "done", edge.targetNodeId])

describe("Bpmn", () => {
  it.effect("imports the executable subset into a portable plan", () =>
    Effect.gen(function*() {
      const imported = yield* importPlan(approvalXml)
      const types = new Map(imported.plan.nodes.map((node) => [node.id, node.type]))
      assert.deepStrictEqual(types.get("waitDoc"), "workflow/receive")
      assert.deepStrictEqual(types.get("review"), "workflow/humanTask")
      assert.deepStrictEqual(types.get("cooldown"), "workflow/delay")
      assert.deepStrictEqual(types.get("archive"), "Score")
      assert.deepStrictEqual(types.get("rejected"), "workflow/fail")

      const review = imported.plan.nodes.find((node) => node.id === "review")!
      assert.deepStrictEqual(
        (review.config as { outcomes: ReadonlyArray<string> }).outcomes,
        ["approve", "reject"]
      )
      const cooldown = imported.plan.nodes.find((node) => node.id === "cooldown")!
      assert.strictEqual((cooldown.config as { durationMillis: number }).durationMillis, 300_000)

      // The parallel join gateway dissolved into a direct edge, the boundary
      // error became an error-outcome edge, and end events disappeared.
      assert.deepStrictEqual(controlEdgesOf(imported.plan), [
        ["waitDoc", "done", "review"],
        ["review", "approve", "cooldown"],
        ["review", "reject", "rejected"],
        ["cooldown", "done", "archive"],
        ["archive", "error", "rejected"]
      ])
    }))

  it.effect("executes a BPMN-designed process end to end", () =>
    Effect.gen(function*() {
      const imported = yield* importPlan(scoringXml)
      const compiled = yield* Compiler.compile(definition, imported.plan)
      const store = yield* PlanStore.PlanStore
      yield* store.save(compiled)

      const result = yield* Runs.execute("scoring", { input: {} })
      assert.deepStrictEqual(result.outputs, { band: "high" })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips execution meaning through export and reimport", () =>
    Effect.gen(function*() {
      const imported = yield* importPlan(scoringXml)
      const xml = yield* Bpmn.fromPlan(imported.plan)
      const reimported = yield* Bpmn.toPlan(xml, {
        definition: definitionReference,
        planId: imported.plan.id
      })

      const project = (plan: Plan.Plan) => ({
        nodes: [...plan.nodes]
          .map(({ metadata: _metadata, ...node }) => node)
          .sort((left, right) => left.id < right.id ? -1 : 1),
        edges: [...plan.edges].sort((left, right) => left.id < right.id ? -1 : 1),
        outputs: plan.outputs
      })
      assert.deepStrictEqual(project(reimported.plan), project(imported.plan))
    }))

  it.effect("fails closed on constructs outside the executable subset", () =>
    Effect.gen(function*() {
      const codesOf = (error: Bpmn.BpmnError) => error.diagnostics.map((diagnostic) => diagnostic.code)

      const inclusive = yield* importPlan(`<?xml version="1.0"?>
        <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="urn:t">
          <bpmn:process id="p">
            <bpmn:startEvent id="s"/>
            <bpmn:inclusiveGateway id="g"/>
          </bpmn:process>
        </bpmn:definitions>`).pipe(Effect.flip)
      assert.include(codesOf(inclusive), Bpmn.Codes.UnsupportedElement)

      const unpinned = yield* importPlan(`<?xml version="1.0"?>
        <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="urn:t">
          <bpmn:process id="p">
            <bpmn:startEvent id="s"/>
            <bpmn:serviceTask id="t"/>
          </bpmn:process>
        </bpmn:definitions>`).pipe(Effect.flip)
      assert.include(codesOf(unpinned), Bpmn.Codes.MissingVocabularyPin)

      const badDuration = yield* importPlan(`<?xml version="1.0"?>
        <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="urn:t">
          <bpmn:process id="p">
            <bpmn:startEvent id="s"/>
            <bpmn:intermediateCatchEvent id="t">
              <bpmn:timerEventDefinition>
                <bpmn:timeDuration>P1M</bpmn:timeDuration>
              </bpmn:timerEventDefinition>
            </bpmn:intermediateCatchEvent>
          </bpmn:process>
        </bpmn:definitions>`).pipe(Effect.flip)
      assert.include(codesOf(badDuration), Bpmn.Codes.InvalidDuration)
    }))

  it.effect("synthesizes a fail for an exclusive gateway with no default flow", () =>
    Effect.gen(function*() {
      const imported = yield* importPlan(`<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:wb="${Bpmn.ExtensionNamespace}" id="defs" targetNamespace="urn:test">
  <bpmn:process id="nodefault" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:serviceTask id="score" name="Score">
      <bpmn:extensionElements><wb:node type="Score" version="1.0.0"/></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:exclusiveGateway id="gate"/>
    <bpmn:serviceTask id="high">
      <bpmn:extensionElements>
        <wb:node type="workflow/transform" version="1.0.0"/>
        <wb:config>{"value":{"_tag":"Literal","value":"high"}}</wb:config>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="mid">
      <bpmn:extensionElements>
        <wb:node type="workflow/transform" version="1.0.0"/>
        <wb:config>{"value":{"_tag":"Literal","value":"mid"}}</wb:config>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="done"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="score"/>
    <bpmn:sequenceFlow id="f2" sourceRef="score" targetRef="gate"/>
    <bpmn:sequenceFlow id="toHigh" name="high" sourceRef="gate" targetRef="high">
      <bpmn:conditionExpression language="${Bpmn.ExpressionLanguage}">${condition("gt")}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="toMid" name="mid" sourceRef="gate" targetRef="mid">
      <bpmn:conditionExpression language="${Bpmn.ExpressionLanguage}">${condition("le")}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f3" sourceRef="high" targetRef="done"/>
    <bpmn:sequenceFlow id="f4" sourceRef="mid" targetRef="done"/>
  </bpmn:process>
</bpmn:definitions>`)

      const failNode = imported.plan.nodes.find((node) => node.type === "workflow/fail")
      assert.isDefined(failNode)
      assert.strictEqual((failNode!.config as { code: string }).code, "BPMN_NO_OUTGOING_FLOW")
      assert.include(controlEdgesOf(imported.plan).map((edge) => `${edge[0]}:${edge[1]}`), "gate:default")

      // The synthesized plan compiles: the unmatched default is now routable.
      const compiled = yield* Compiler.compile(definition, imported.plan)
      assert.isTrue(Compiler.isCompiled(compiled))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("honors a pinned single-outcome gateway instead of dissolving it", () =>
    Effect.gen(function*() {
      const plan = {
        formatVersion: 2 as const,
        id: "single-case",
        revision: 1,
        definition: definitionReference,
        nodes: [
          {
            id: "route",
            type: "workflow/switch",
            version: "1.0.0",
            config: { cases: [{ name: "only", condition: Expression.literal(true) }] }
          },
          { id: "after", type: "workflow/transform", version: "1.0.0", config: { value: Expression.literal("x") } }
        ],
        edges: [
          { _tag: "ControlEdge" as const, id: "e", sourceNodeId: "route", outcome: "only", targetNodeId: "after" }
        ]
      }
      const xml = yield* Bpmn.fromPlan(plan as unknown as Plan.Plan)
      const reimported = yield* Bpmn.toPlan(xml, { definition: definitionReference, planId: "single-case" })
      // The switch survived the round trip; it did not silently dissolve.
      assert.isDefined(reimported.plan.nodes.find((node) => node.id === "route" && node.type === "workflow/switch"))
    }).pipe(Effect.provide(TestLayer)))

  it("parses and renders calendar-free ISO-8601 durations", () => {
    assert.strictEqual(Bpmn.parseDurationMillis("PT5M"), 300_000)
    assert.strictEqual(Bpmn.parseDurationMillis("P1DT2H3M4.5S"), ((26 * 60 + 3) * 60 + 4.5) * 1000)
    assert.isUndefined(Bpmn.parseDurationMillis("P1M"))
    assert.isUndefined(Bpmn.parseDurationMillis("PT0S"))
    assert.strictEqual(Bpmn.parseDurationMillis("PT5M"), Bpmn.parseDurationMillis("PT300S"))
  })
})
