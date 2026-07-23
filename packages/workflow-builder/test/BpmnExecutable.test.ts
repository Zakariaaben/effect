import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnExecutable from "../src/BpmnExecutable.ts"
import type * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnXml from "../src/BpmnXml.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const modelNamespace = "http://www.omg.org/spec/BPMN/20100524/MODEL"
const bpmnDiNamespace = "http://www.omg.org/spec/BPMN/20100524/DI"
const diNamespace = "http://www.omg.org/spec/DD/20100524/DI"
const dcNamespace = "http://www.omg.org/spec/DD/20100524/DC"
const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance"
const expressionLanguage = "urn:workflow:conditions"
const expressionVersion = "1.0.0"
const rootProcessId = "process_main"
const now = "2026-07-23T10:00:00.000Z" as const

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"2".repeat(64)}`)

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() =>
      new Uint8Array(createHash("sha256").update(data).digest())
    )
})

const options: BpmnExecutable.CompileXmlOptions = {
  importOptions: {
    importId: "executable_slice",
    locator: "memory://executable-slice.bpmn",
    expressionLanguageBindings: [{
      language: expressionLanguage,
      version: expressionVersion
    }]
  },
  rootProcessId,
  limits: {
    maxAutomaticTransitions: 1_000
  },
  evaluatorBindings: [{
    language: expressionLanguage,
    languageVersion: expressionVersion,
    build: {
      id: "conditions",
      version: "1.0.0",
      deploymentId: "test-conditions",
      buildDigest: evaluatorBuildDigest
    },
    limits: {
      maxSourceUtf8Bytes: 4_096,
      maxContextCanonicalBytes: 1_048_576,
      maxSteps: 10_000,
      timeoutMillis: 1_000
    }
  }]
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="${modelNamespace}"
  xmlns:bpmndi="${bpmnDiNamespace}"
  xmlns:di="${diNamespace}"
  xmlns:dc="${dcNamespace}"
  xmlns:xsi="${xsiNamespace}"
  targetNamespace="urn:workflow:executable-slice"
  expressionLanguage="${expressionLanguage}">
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:task id="intake"/>
    <bpmn:exclusiveGateway
      id="decision"
      gatewayDirection="Diverging"
      default="flow_decision_default"/>
    <bpmn:parallelGateway id="split" gatewayDirection="Diverging"/>
    <bpmn:subProcess id="subprocess">
      <bpmn:startEvent id="sub_start"/>
      <bpmn:task id="sub_task"/>
      <bpmn:endEvent id="sub_end"/>
      <bpmn:sequenceFlow id="flow_sub_start_task" sourceRef="sub_start" targetRef="sub_task"/>
      <bpmn:sequenceFlow id="flow_sub_task_end" sourceRef="sub_task" targetRef="sub_end"/>
    </bpmn:subProcess>
    <bpmn:task id="side_task"/>
    <bpmn:parallelGateway id="join" gatewayDirection="Converging"/>
    <bpmn:endEvent id="success_end"/>
    <bpmn:endEvent id="default_end"/>
    <bpmn:sequenceFlow id="flow_start_intake" sourceRef="start" targetRef="intake"/>
    <bpmn:sequenceFlow id="flow_intake_decision" sourceRef="intake" targetRef="decision"/>
    <bpmn:sequenceFlow id="flow_decision_approved" sourceRef="decision" targetRef="split">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"><![CDATA[approved]]></bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="flow_decision_default" sourceRef="decision" targetRef="default_end"/>
    <bpmn:sequenceFlow id="flow_split_subprocess" sourceRef="split" targetRef="subprocess"/>
    <bpmn:sequenceFlow id="flow_split_side" sourceRef="split" targetRef="side_task"/>
    <bpmn:sequenceFlow id="flow_subprocess_join" sourceRef="subprocess" targetRef="join"/>
    <bpmn:sequenceFlow id="flow_side_join" sourceRef="side_task" targetRef="join"/>
    <bpmn:sequenceFlow id="flow_join_end" sourceRef="join" targetRef="success_end"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="diagram_main">
    <bpmndi:BPMNPlane id="plane_main" bpmnElement="${rootProcessId}">
      <bpmndi:BPMNShape id="shape_start" bpmnElement="start">
        <dc:Bounds x="10" y="20" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="shape_intake" bpmnElement="intake">
        <dc:Bounds x="90" y="8" width="100" height="60"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="edge_start_intake" bpmnElement="flow_start_intake">
        <di:waypoint x="46" y="38"/>
        <di:waypoint x="90" y="38"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`

const success = <A>(
  result: Result.Result<A, Diagnostic.CompilationError>
): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = <A>(
  result: Result.Result<A, Diagnostic.CompilationError>
): Diagnostic.CompilationError => {
  if (Result.isSuccess(result)) {
    throw new Error("expected failure")
  }
  return result.failure
}

const compileXml = (
  input: unknown,
  selectedOptions: unknown = options
): Result.Result<BpmnExecutable.CompiledXml, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnExecutable.compileXml(input, selectedOptions).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<
    BpmnExecutable.CompiledXml,
    Diagnostic.CompilationError
  >

const prepareKernel = (
  model: unknown
): Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnKernel.prepare(model, {
      profileId: BpmnXml.CoreProcessDiProfileId,
      rootProcessId: options.rootProcessId,
      limits: options.limits,
      evaluatorBindings: options.evaluatorBindings
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError>

const services = (approved: boolean): BpmnKernel.Services => ({
  now,
  evaluateCondition: ({ expression }) =>
    Result.succeed(
      {
        result:
          expression.language === expressionLanguage &&
          expression.version === expressionVersion &&
          expression.source.trim() === "approved" &&
          approved,
        steps: 1
      }
    )
})

const activeNodeIds = (
  state: BpmnExecutionState.BpmnExecutionState
): ReadonlyArray<string> =>
  state.tokens
    .filter((token) => token.status === "active" && token.position._tag === "AtNode")
    .map((token) => token.position._tag === "AtNode" ? token.position.nodeId : "")
    .sort()

const complete = (
  kernel: BpmnKernel.CompiledKernel,
  state: BpmnExecutionState.BpmnExecutionState,
  taskNodeId: string,
  approved: boolean
): BpmnKernel.TransitionBatch => {
  const token = state.tokens.find((candidate) =>
    candidate.status === "active" &&
    candidate.position._tag === "AtNode" &&
    candidate.position.nodeId === taskNodeId
  )
  if (token === undefined) {
    throw new Error(`expected an active token at '${taskNodeId}'`)
  }
  return success(BpmnKernel.completeTask(
    kernel,
    state,
    {
      scopeInstanceId: token.scopeInstanceId,
      taskNodeId,
      tokenId: token.tokenId
    },
    services(approved)
  ))
}

describe("BpmnExecutable", () => {
  it("round-trips and replays the executable XML subset through its conditional branch", () => {
    const compiled = success(compileXml(xml))
    assert.isTrue(Object.isFrozen(compiled))
    assert.deepStrictEqual(compiled.interchange.mappingReport.semanticLosses, [])
    assert.isTrue(
      compiled.interchange.model.flowNodes
        .filter((node) => node._tag === "Task")
        .every((node) => node.taskKind === "generic")
    )

    const initialized = success(BpmnKernel.initialize(compiled.kernel, services(true)))
    assert.deepStrictEqual(activeNodeIds(initialized.state), ["intake"])

    const afterIntake = complete(compiled.kernel, initialized.state, "intake", true)
    assert.deepStrictEqual(activeNodeIds(afterIntake.state), ["side_task", "sub_task"])

    const afterSubTask = complete(compiled.kernel, afterIntake.state, "sub_task", true)
    assert.deepStrictEqual(activeNodeIds(afterSubTask.state), ["side_task"])

    const completed = complete(compiled.kernel, afterSubTask.state, "side_task", true)
    assert.strictEqual(completed.state.status, "completed")
    assert.deepStrictEqual(activeNodeIds(completed.state), [])

    const journal: ReadonlyArray<BpmnKernel.TransitionEvent> = [
      ...initialized.events,
      ...afterIntake.events,
      ...afterSubTask.events,
      ...completed.events
    ]
    assert.isTrue(journal.some((event) =>
      event._tag === "ConditionEvaluated" &&
      event.sequenceFlowId === "flow_decision_approved" &&
      event.result
    ))
    assert.isTrue(journal.some((event) =>
      event._tag === "OutgoingSelected" &&
      event.sourceNodeId === "decision" &&
      event.sequenceFlowIds[0] === "flow_decision_approved"
    ))
    assert.isTrue(journal.some((event) => event._tag === "ScopeEntered" && event.definitionId === "subprocess"))
    assert.isTrue(journal.some((event) => event._tag === "ScopeCompleted" && event.definitionId === "subprocess"))
    assert.isTrue(journal.some((event) => event._tag === "GatewayFrameOpened" && event.gatewayId === "join"))
    assert.isTrue(journal.some((event) => event._tag === "GatewayFired" && event.gatewayId === "join"))
    assert.isTrue(journal.some((event) => event._tag === "ExecutionCompleted"))

    const replayed = success(BpmnKernel.replay(compiled.kernel, journal))
    assert.deepStrictEqual(replayed, completed.state)

    const canonical = success(BpmnXml.exportXml(compiled.interchange, { format: "compact" }))
    assert.strictEqual(
      success(BpmnXml.exportXml(compiled.interchange, { format: "compact" })),
      canonical
    )

    const recompiled = success(compileXml(canonical))
    assert.deepStrictEqual(recompiled.interchange.model, compiled.interchange.model)
    assert.deepStrictEqual(recompiled.interchange.di, compiled.interchange.di)
    assert.strictEqual(
      recompiled.kernel.modelReference.executableFingerprint,
      compiled.kernel.modelReference.executableFingerprint
    )
    assert.deepStrictEqual(
      success(BpmnKernel.replay(recompiled.kernel, journal)),
      completed.state
    )
    assert.strictEqual(
      success(BpmnXml.exportXml(recompiled.interchange, { format: "compact" })),
      canonical
    )
  })

  it("uses the exclusive gateway's explicit default when its condition is false", () => {
    const compiled = success(compileXml(xml))
    const initialized = success(BpmnKernel.initialize(compiled.kernel, services(false)))
    const completed = complete(compiled.kernel, initialized.state, "intake", false)
    const journal: ReadonlyArray<BpmnKernel.TransitionEvent> = [
      ...initialized.events,
      ...completed.events
    ]

    assert.strictEqual(completed.state.status, "completed")
    assert.isTrue(journal.some((event) =>
      event._tag === "ConditionEvaluated" &&
      event.sequenceFlowId === "flow_decision_approved" &&
      event.result === false
    ))
    assert.isTrue(journal.some((event) =>
      event._tag === "OutgoingSelected" &&
      event.sourceNodeId === "decision" &&
      event.sequenceFlowIds.length === 1 &&
      event.sequenceFlowIds[0] === "flow_decision_default"
    ))
    assert.deepStrictEqual(
      success(BpmnKernel.replay(compiled.kernel, journal)),
      completed.state
    )
  })

  it("rejects excess facade options before importing XML", () => {
    const invalid = failure(compileXml(xml, {
      ...options,
      unexpected: true
    }))

    assert.deepStrictEqual(
      invalid.diagnostics.map((diagnostic) => diagnostic.code),
      [BpmnExecutable.Codes.InvalidOptions]
    )
  })

  it("requires one exact evaluator build pin for every executable expression language", () => {
    const missing = failure(compileXml(xml, {
      ...options,
      evaluatorBindings: []
    }))
    const duplicate = failure(compileXml(xml, {
      ...options,
      evaluatorBindings: [
        ...options.evaluatorBindings,
        ...options.evaluatorBindings
      ]
    }))

    for (const rejected of [missing, duplicate]) {
      assert(
        rejected.diagnostics.some((diagnostic) =>
          diagnostic.code === BpmnKernel.Codes.InvalidKernelProfile
        )
      )
    }
  })

  it("preserves kernel diagnostics for an unspecified gateway direction", () => {
    const unspecified = xml.replace(
      " gatewayDirection=\"Diverging\"\n      default=\"flow_decision_default\"",
      "\n      default=\"flow_decision_default\""
    )
    const imported = success(BpmnXml.importXml(unspecified, options.importOptions))
    const direct = failure(prepareKernel(imported.model))
    const facade = failure(compileXml(unspecified))

    assert.isTrue(
      facade.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.UnsupportedGateway)
    )
    assert.deepStrictEqual(facade.diagnostics, direct.diagnostics)
  })

  it("rejects a second populated process instead of choosing one implicitly", () => {
    const multiple = xml.replace(
      "  <bpmndi:BPMNDiagram",
      `  <bpmn:process id="process_other" isExecutable="true">
    <bpmn:startEvent id="other_start"/>
    <bpmn:endEvent id="other_end"/>
    <bpmn:sequenceFlow id="other_flow" sourceRef="other_start" targetRef="other_end"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram`
    )
    const rejected = failure(compileXml(multiple))

    assert.isTrue(
      rejected.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.UnsupportedProcess)
    )
  })
})
