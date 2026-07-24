import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnData from "../src/BpmnData.ts"
import * as BpmnExecutable from "../src/BpmnExecutable.ts"
import type * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import * as BpmnExpressionEvaluator from "../src/BpmnExpressionEvaluator.ts"
import * as BpmnExpressionRuntime from "../src/BpmnExpressionRuntime.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnXml from "../src/BpmnXml.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const modelNamespace = "http://www.omg.org/spec/BPMN/20100524/MODEL"
const bpmnDiNamespace = "http://www.omg.org/spec/BPMN/20100524/DI"
const diNamespace = "http://www.omg.org/spec/DD/20100524/DI"
const dcNamespace = "http://www.omg.org/spec/DD/20100524/DC"
const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance"
const expressionLanguage = "urn:workflow:conditions"
const expressionVersion = "1.0.0"
const rootProcessId = "process_main"
const now = "2026-07-23T10:00:00.000Z" as const
const startCommand: BpmnKernel.InitializeCommand = {
  commandVersion: BpmnKernel.InitializeCommandVersion,
  input: null
}

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"2".repeat(64)}`)
const loopArtifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"3".repeat(64)}`)
const collectionArtifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"a".repeat(64)}`)

const occurrenceDigest = (
  character: string
): ProtocolV3Wire.OccurrenceDigest =>
  Schema.decodeUnknownSync(ProtocolV3Wire.OccurrenceDigest)(
    `sha256:${character.repeat(64)}`
  )

const operationDigest = (
  character: string
): ProtocolV3Wire.OperationDigest =>
  Schema.decodeUnknownSync(ProtocolV3Wire.OperationDigest)(
    `sha256:${character.repeat(64)}`
  )

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
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
    maxAutomaticTransitions: 1_000,
    maxExecutionInputCanonicalBytes: 1_048_576,
    maxMultiInstanceCardinality: 128,
    maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
    maxMultiInstanceItemCanonicalBytes: 262_144,
    maxMultiInstanceOutputCanonicalBytes: 1_048_576,
    maxMultiInstanceItemOutputCanonicalBytes: 262_144
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

const loopXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="${modelNamespace}"
  xmlns:xsi="${xsiNamespace}"
  targetNamespace="urn:workflow:executable-loop"
  expressionLanguage="${expressionLanguage}">
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="loop_start"/>
    <bpmn:task id="loop_task">
      <bpmn:standardLoopCharacteristics testBefore="false" loopMaximum="3">
        <bpmn:loopCondition xsi:type="bpmn:tFormalExpression"><![CDATA[repeat]]></bpmn:loopCondition>
      </bpmn:standardLoopCharacteristics>
    </bpmn:task>
    <bpmn:endEvent id="loop_end"/>
    <bpmn:sequenceFlow id="flow_loop_start" sourceRef="loop_start" targetRef="loop_task"/>
    <bpmn:sequenceFlow id="flow_loop_end" sourceRef="loop_task" targetRef="loop_end"/>
  </bpmn:process>
</bpmn:definitions>`

const multiInstanceXml = (
  mode: "sequential" | "parallel",
  cardinalitySource: string,
  completionConditionSource?: string
): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="${modelNamespace}"
  xmlns:xsi="${xsiNamespace}"
  targetNamespace="urn:workflow:executable-multi-instance"
  expressionLanguage="${expressionLanguage}">
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="mi_start"/>
    <bpmn:task id="mi_task">
      <bpmn:multiInstanceLoopCharacteristics isSequential="${mode === "sequential" ? "true" : "false"}">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression"><![CDATA[${cardinalitySource}]]></bpmn:loopCardinality>${
    completionConditionSource === undefined
      ? ""
      : `
        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression"><![CDATA[${completionConditionSource}]]></bpmn:completionCondition>`
  }
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>
    <bpmn:endEvent id="mi_end"/>
    <bpmn:sequenceFlow id="flow_mi_start" sourceRef="mi_start" targetRef="mi_task"/>
    <bpmn:sequenceFlow id="flow_mi_end" sourceRef="mi_task" targetRef="mi_end"/>
  </bpmn:process>
</bpmn:definitions>`

const collectionMultiInstanceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="${modelNamespace}"
  xmlns:tns="urn:workflow:executable-collection-multi-instance"
  targetNamespace="urn:workflow:executable-collection-multi-instance"
  expressionLanguage="${expressionLanguage}">
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="mi_start"/>
    <bpmn:task id="mi_task">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>tns:items</bpmn:loopDataInputRef>
        <bpmn:loopDataOutputRef>tns:results</bpmn:loopDataOutputRef>
        <bpmn:inputDataItem id="current_item" isCollection="false"/>
        <bpmn:outputDataItem id="current_result" isCollection="false"/>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>
    <bpmn:endEvent id="mi_end"/>
    <bpmn:sequenceFlow id="flow_mi_start" sourceRef="mi_start" targetRef="mi_task"/>
    <bpmn:sequenceFlow id="flow_mi_end" sourceRef="mi_task" targetRef="mi_end"/>
  </bpmn:process>
</bpmn:definitions>`

const nonExecutableMultiInstanceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="${modelNamespace}"
  xmlns:tns="urn:workflow:executable-multi-instance"
  targetNamespace="urn:workflow:executable-multi-instance"
  expressionLanguage="${expressionLanguage}">
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="mi_start"/>
    <bpmn:task id="mi_task">
      <bpmn:multiInstanceLoopCharacteristics
        isSequential="false"
        behavior="One"
        oneBehaviorEventRef="tns:first_completed">
        <bpmn:loopDataInputRef>tns:items</bpmn:loopDataInputRef>
        <bpmn:loopDataOutputRef>tns:results</bpmn:loopDataOutputRef>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>
    <bpmn:endEvent id="mi_end"/>
    <bpmn:sequenceFlow id="flow_mi_start" sourceRef="mi_start" targetRef="mi_task"/>
    <bpmn:sequenceFlow id="flow_mi_end" sourceRef="mi_task" targetRef="mi_end"/>
  </bpmn:process>
</bpmn:definitions>`

const loopTaskBinding: BpmnActivityV3.TaskBinding = {
  bindingVersion: BpmnActivityV3.BindingVersion,
  executionProtocolVersion: 3,
  taskNodeId: "loop_task",
  artifactDigest: loopArtifactDigest,
  semanticNodeId: "semantic_loop_task",
  errorMappings: []
}

const collectionTaskBinding: BpmnActivityV3.TaskBinding = {
  bindingVersion: BpmnActivityV3.BindingVersion,
  executionProtocolVersion: 3,
  taskNodeId: "mi_task",
  artifactDigest: collectionArtifactDigest,
  semanticNodeId: "semantic_mi_task",
  errorMappings: []
}

const collectionDataDocument: BpmnData.BpmnDataDocument = {
  documentKind: "BpmnDataDocument",
  documentVersion: BpmnData.BpmnDataDocumentVersion,
  bpmnSpecVersion: "2.0.2",
  extensionElements: [],
  itemDefinitions: [],
  dataStores: [],
  messages: [],
  errors: [],
  interfaces: [],
  dataObjects: [],
  dataObjectReferences: [],
  dataStoreReferences: [],
  properties: [],
  inputOutputSpecifications: [{
    id: "mi_task_io",
    ownerId: "mi_task",
    dataInputs: [{
      id: "items",
      isCollection: true,
      extensionElements: []
    }],
    dataOutputs: [{
      id: "results",
      isCollection: true,
      extensionElements: []
    }],
    inputSets: [{
      id: "mi_task_input_set",
      dataInputRefs: ["items"],
      optionalInputRefs: [],
      whileExecutingInputRefs: [],
      outputSetRefs: [],
      extensionElements: []
    }],
    outputSets: [{
      id: "mi_task_output_set",
      dataOutputRefs: ["results"],
      optionalOutputRefs: [],
      whileExecutingOutputRefs: [],
      inputSetRefs: [],
      extensionElements: []
    }],
    extensionElements: []
  }],
  dataAssociations: [],
  inputOutputBindings: []
}

const collectionBinding: BpmnKernel.MultiInstanceCollectionBinding = {
  bindingVersion: BpmnKernel.MultiInstanceCollectionBindingVersion,
  taskNodeId: "mi_task",
  dataInputRef: "items",
  collectionExpression: {
    language: expressionLanguage,
    version: expressionVersion,
    source: "execution.items"
  }
}

const loopOutcome = (
  iteration: 0 | 1
): BpmnActivityV3.TaskSucceeded => ({
  _tag: "Succeeded",
  outcomeVersion: BpmnActivityV3.OutcomeVersion,
  artifactDigest: loopArtifactDigest,
  semanticNodeId: loopTaskBinding.semanticNodeId,
  occurrenceDigest: occurrenceDigest(iteration === 0 ? "4" : "5"),
  firstActivityDigest: operationDigest(iteration === 0 ? "6" : "7"),
  attempt: 1,
  completedActivityDigest: operationDigest(iteration === 0 ? "8" : "9"),
  output: { _tag: "Inline", value: { iteration } }
})

const collectionOutcome = (
  itemIndex: 0 | 1 | 2,
  output: Schema.Json
): BpmnActivityV3.TaskSucceeded => ({
  _tag: "Succeeded",
  outcomeVersion: BpmnActivityV3.OutcomeVersion,
  artifactDigest: collectionArtifactDigest,
  semanticNodeId: collectionTaskBinding.semanticNodeId,
  occurrenceDigest: occurrenceDigest(["a", "b", "c"][itemIndex]!),
  firstActivityDigest: operationDigest(["d", "e", "f"][itemIndex]!),
  attempt: 1,
  completedActivityDigest: operationDigest(["7", "8", "9"][itemIndex]!),
  output: {
    _tag: "Inline",
    value: output
  }
})

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
  evaluateExpression: ({ expression }) =>
    Result.succeed(
      {
        result: expression.language === expressionLanguage &&
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

interface MultiInstanceEvaluationObservation {
  readonly tag: BpmnKernel.EvaluationContext["_tag"]
  readonly source: string
  readonly expectedResult: BpmnExpressionEvaluator.ExpectedResult
  readonly completedMemberIndex?: number
}

const multiInstanceServices = (
  cardinality: number,
  observations: Array<MultiInstanceEvaluationObservation>,
  completionCondition: boolean = false
): BpmnKernel.Services => ({
  now,
  evaluateExpression: (context) => {
    observations.push({
      tag: context._tag,
      source: context.expression.source,
      expectedResult: context.request.expectedResult,
      ...(context._tag === "MultiInstanceCompletionCondition"
        ? { completedMemberIndex: context.completedMember.index }
        : {})
    })
    return Result.succeed({
      result: context._tag === "MultiInstanceCardinality"
        ? cardinality
        : completionCondition,
      steps: observations.length
    })
  }
})

const activeMultiInstanceTokens = (
  state: BpmnExecutionState.BpmnExecutionState
): ReadonlyArray<BpmnExecutionState.BpmnExecutionState["tokens"][number]> =>
  state.tokens
    .filter((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === "mi_task" &&
      token.invocation.branch?._tag === "MultiInstanceItem"
    )
    .sort((left, right) => {
      const leftIndex = left.invocation.branch?._tag === "MultiInstanceItem"
        ? left.invocation.branch.itemIndex
        : -1
      const rightIndex = right.invocation.branch?._tag === "MultiInstanceItem"
        ? right.invocation.branch.itemIndex
        : -1
      return leftIndex - rightIndex
    })

const completeMultiInstanceToken = (
  kernel: BpmnKernel.CompiledKernel,
  state: BpmnExecutionState.BpmnExecutionState,
  token: BpmnExecutionState.BpmnExecutionState["tokens"][number],
  runtime: BpmnKernel.Services
): BpmnKernel.TransitionBatch =>
  success(BpmnKernel.completeTask(
    kernel,
    state,
    {
      scopeInstanceId: token.scopeInstanceId,
      taskNodeId: "mi_task",
      tokenId: token.tokenId
    },
    runtime
  ))

const assertMultiInstanceCanonicalReplay = (
  compiled: BpmnExecutable.CompiledXml,
  journal: ReadonlyArray<BpmnKernel.TransitionEvent>,
  expectedState: BpmnExecutionState.BpmnExecutionState
): void => {
  const canonical = success(BpmnXml.exportXml(
    compiled.interchange,
    { format: "compact" }
  ))
  const recompiled = success(compileXml(canonical))

  assert.strictEqual(
    recompiled.interchange.profileId,
    "bpmn-2.0.2-core-process-di-v5"
  )
  assert.deepStrictEqual(
    recompiled.interchange.model,
    compiled.interchange.model
  )
  assert.strictEqual(
    recompiled.kernel.modelReference.executableFingerprint,
    compiled.kernel.modelReference.executableFingerprint
  )
  assert.deepStrictEqual(
    success(BpmnKernel.replay(recompiled.kernel, journal)),
    expectedState
  )
  assert.strictEqual(
    success(BpmnXml.exportXml(
      recompiled.interchange,
      { format: "compact" }
    )),
    canonical
  )
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

    const initialized = success(BpmnKernel.initialize(
      compiled.kernel,
      startCommand,
      services(true)
    ))
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

  it.effect("imports, binds, executes, and replays a bounded Standard Loop through the Effect runtime", () =>
    Effect.gen(function*() {
      const compileOptions: BpmnExecutable.CompileXmlOptions = {
        ...options,
        taskBindings: [loopTaskBinding]
      }
      const compiled = success(compileXml(
        loopXml,
        compileOptions
      ))
      assert.deepStrictEqual(
        compiled.kernel.taskBindings,
        [loopTaskBinding]
      )

      const evaluatorBinding = options.evaluatorBindings[0]!
      const decisions = [true, false] as const
      const requests: Array<string> = []
      const registry = yield* BpmnExpressionEvaluator.makeMemory([
        BpmnExpressionEvaluator.makeDefinition({
          binding: evaluatorBinding,
          evaluate: (request) =>
            Effect.gen(function*() {
              requests.push(request.source)
              const decision = decisions[requests.length - 1]
              yield* Effect.yieldNow
              if (decision === undefined) {
                return yield* Effect.die(
                  "Unexpected duplicate Standard Loop evaluation"
                )
              }
              return {
                result: decision,
                steps: requests.length
              }
            })
        })
      ])
      const provideRegistry = Effect.provideService(
        BpmnExpressionEvaluator.EvaluatorRegistry,
        registry
      )
      const initialized = yield* BpmnExpressionRuntime.initialize(
        compiled.kernel,
        startCommand,
        { now }
      ).pipe(provideRegistry)
      assert.deepStrictEqual(requests, [])
      const firstToken = initialized.state.tokens.find((token) =>
        token.status === "active" &&
        token.position._tag === "AtNode" &&
        token.position.nodeId === "loop_task"
      )
      if (firstToken === undefined) {
        return yield* Effect.die(
          "Expected the first Standard Loop iteration"
        )
      }
      assert.strictEqual(
        firstToken.invocation.branch?._tag,
        "StandardLoopIteration"
      )
      if (firstToken.invocation.branch?._tag !== "StandardLoopIteration") {
        return yield* Effect.die("Expected Standard Loop branch identity")
      }
      assert.strictEqual(firstToken.invocation.branch.iteration, 0)
      const firstTarget = {
        scopeInstanceId: firstToken.scopeInstanceId,
        taskNodeId: "loop_task",
        tokenId: firstToken.tokenId
      }
      const firstOccurrence = success(BpmnKernel.taskOccurrence(
        compiled.kernel,
        initialized.state,
        firstTarget
      ))
      assert.strictEqual(firstOccurrence.activation, 0)

      const first = yield* BpmnExpressionRuntime.resolveTask(
        compiled.kernel,
        initialized.state,
        {
          commandVersion: BpmnActivityV3.CommandVersion,
          ...firstTarget,
          outcome: loopOutcome(0)
        },
        { now }
      ).pipe(provideRegistry)
      const secondToken = first.state.tokens.find((token) =>
        token.status === "active" &&
        token.position._tag === "AtNode" &&
        token.position.nodeId === "loop_task"
      )
      if (secondToken === undefined) {
        return yield* Effect.die(
          "Expected the second Standard Loop iteration"
        )
      }
      assert.strictEqual(
        secondToken.invocation.branch?._tag,
        "StandardLoopIteration"
      )
      if (secondToken.invocation.branch?._tag !== "StandardLoopIteration") {
        return yield* Effect.die("Expected Standard Loop branch identity")
      }
      assert.strictEqual(secondToken.invocation.branch.iteration, 1)
      assert.strictEqual(
        secondToken.invocation.branch.frameId,
        firstToken.invocation.branch.frameId
      )
      const secondTarget = {
        scopeInstanceId: secondToken.scopeInstanceId,
        taskNodeId: "loop_task",
        tokenId: secondToken.tokenId
      }
      const secondOccurrence = success(BpmnKernel.taskOccurrence(
        compiled.kernel,
        first.state,
        secondTarget
      ))
      assert.strictEqual(secondOccurrence.activation, 1)

      const completed = yield* BpmnExpressionRuntime.resolveTask(
        compiled.kernel,
        first.state,
        {
          commandVersion: BpmnActivityV3.CommandVersion,
          ...secondTarget,
          outcome: loopOutcome(1)
        },
        { now }
      ).pipe(provideRegistry)

      assert.deepStrictEqual(requests, ["repeat", "repeat"])
      assert.strictEqual(completed.state.status, "completed")
      assert.deepStrictEqual(
        completed.state.loopFrames.map((frame) => ({
          completedIterations: frame.completedIterations,
          activeIteration: frame.activeIteration,
          status: frame.status
        })),
        [{
          completedIterations: 2,
          activeIteration: undefined,
          status: "completed"
        }]
      )
      assert.deepStrictEqual(
        [...first.events, ...completed.events]
          .filter((event) => event._tag === "LoopConditionEvaluated")
          .map((event) =>
            event._tag === "LoopConditionEvaluated"
              ? {
                phase: event.phase,
                iteration: event.iteration,
                result: event.result
              }
              : undefined
          ),
        [
          { phase: "after", iteration: 0, result: true },
          { phase: "after", iteration: 1, result: false }
        ]
      )

      const journal: ReadonlyArray<BpmnKernel.TransitionEvent> = [
        ...initialized.events,
        ...first.events,
        ...completed.events
      ]
      assert.strictEqual(
        journal.filter((event) => event._tag === "TaskOutcomeAccepted").length,
        2
      )
      assert.deepStrictEqual(
        success(BpmnKernel.replay(compiled.kernel, journal)),
        completed.state
      )

      const canonical = success(BpmnXml.exportXml(
        compiled.interchange,
        { format: "compact" }
      ))
      const recompiled = success(compileXml(
        canonical,
        compileOptions
      ))
      assert.strictEqual(
        recompiled.kernel.modelReference.executableFingerprint,
        compiled.kernel.modelReference.executableFingerprint
      )
      assert.deepStrictEqual(
        success(BpmnKernel.replay(recompiled.kernel, journal)),
        completed.state
      )
    }))

  it("imports, compiles, executes, replays, and canonically recompiles a sequential Multi-Instance task", () => {
    const compiled = success(compileXml(
      multiInstanceXml("sequential", "requested-count", "keep-waiting")
    ))
    assert.strictEqual(
      BpmnXml.CoreProcessDiProfileId,
      "bpmn-2.0.2-core-process-di-v5"
    )
    assert.strictEqual(
      compiled.interchange.profileId,
      "bpmn-2.0.2-core-process-di-v5"
    )
    assert.deepStrictEqual(
      compiled.interchange.mappingReport.semanticLosses,
      []
    )

    const observations: Array<MultiInstanceEvaluationObservation> = []
    const runtime = multiInstanceServices(2, observations, false)
    const initialized = success(BpmnKernel.initialize(
      compiled.kernel,
      startCommand,
      runtime
    ))
    const firstToken = activeMultiInstanceTokens(initialized.state)[0]
    if (firstToken === undefined) {
      throw new Error("expected the first sequential Multi-Instance member")
    }
    assert.deepStrictEqual(observations, [{
      tag: "MultiInstanceCardinality",
      source: "requested-count",
      expectedResult: "non-negative-integer"
    }])
    assert.deepStrictEqual(
      initialized.state.multiInstanceGroups.map((group) => ({
        mode: group.mode,
        source: group.source,
        completedInstanceCount: group.completedInstanceCount,
        status: group.status,
        members: group.members.map((member) => ({
          index: member.index,
          itemKey: member.itemKey,
          status: member.status
        }))
      })),
      [{
        mode: "sequential",
        source: { _tag: "Cardinality", value: 2 },
        completedInstanceCount: 0,
        status: "active",
        members: [
          { index: 0, itemKey: "item:0", status: "active" },
          { index: 1, itemKey: "item:1", status: "pending" }
        ]
      }]
    )

    const first = completeMultiInstanceToken(
      compiled.kernel,
      initialized.state,
      firstToken,
      runtime
    )
    const secondToken = activeMultiInstanceTokens(first.state)[0]
    if (secondToken === undefined) {
      throw new Error("expected the second sequential Multi-Instance member")
    }
    assert.strictEqual(
      secondToken.invocation.branch?._tag === "MultiInstanceItem"
        ? secondToken.invocation.branch.itemIndex
        : undefined,
      1
    )
    assert.deepStrictEqual(
      first.state.multiInstanceGroups[0]?.members.map((member) => member.status),
      ["completed", "active"]
    )

    const completed = completeMultiInstanceToken(
      compiled.kernel,
      first.state,
      secondToken,
      runtime
    )
    const journal: ReadonlyArray<BpmnKernel.TransitionEvent> = [
      ...initialized.events,
      ...first.events,
      ...completed.events
    ]

    assert.deepStrictEqual(observations, [
      {
        tag: "MultiInstanceCardinality",
        source: "requested-count",
        expectedResult: "non-negative-integer"
      },
      {
        tag: "MultiInstanceCompletionCondition",
        source: "keep-waiting",
        expectedResult: "boolean",
        completedMemberIndex: 0
      },
      {
        tag: "MultiInstanceCompletionCondition",
        source: "keep-waiting",
        expectedResult: "boolean",
        completedMemberIndex: 1
      }
    ])
    assert.strictEqual(
      observations.filter((observation) => observation.tag === "MultiInstanceCardinality").length,
      1
    )
    assert.strictEqual(completed.state.status, "completed")
    assert.deepStrictEqual(
      completed.state.multiInstanceGroups.map((group) => ({
        source: group.source,
        completedInstanceCount: group.completedInstanceCount,
        status: group.status,
        completionReason: group.completionReason,
        memberStatuses: group.members.map((member) => member.status)
      })),
      [{
        source: { _tag: "Cardinality", value: 2 },
        completedInstanceCount: 2,
        status: "completed",
        completionReason: "all-completed",
        memberStatuses: ["completed", "completed"]
      }]
    )
    assert.strictEqual(
      journal.filter((event) => event._tag === "MultiInstanceCardinalityEvaluated").length,
      1
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceCompletionConditionEvaluated"
          ? [event.result]
          : []
      ),
      [false, false]
    )
    assert.deepStrictEqual(
      success(BpmnKernel.replay(compiled.kernel, journal)),
      completed.state
    )
    assertMultiInstanceCanonicalReplay(
      compiled,
      journal,
      completed.state
    )
  })

  it("preserves deterministic member identity across out-of-order parallel Multi-Instance completion and canonical replay", () => {
    const compiled = success(compileXml(
      multiInstanceXml("parallel", "parallel-count")
    ))
    assert.strictEqual(
      compiled.interchange.profileId,
      "bpmn-2.0.2-core-process-di-v5"
    )
    const observations: Array<MultiInstanceEvaluationObservation> = []
    const runtime = multiInstanceServices(3, observations)
    const initialized = success(BpmnKernel.initialize(
      compiled.kernel,
      startCommand,
      runtime
    ))
    assert.deepStrictEqual(observations, [{
      tag: "MultiInstanceCardinality",
      source: "parallel-count",
      expectedResult: "non-negative-integer"
    }])
    assert.deepStrictEqual(
      activeMultiInstanceTokens(initialized.state).map((token) =>
        token.invocation.branch?._tag === "MultiInstanceItem"
          ? {
            itemIndex: token.invocation.branch.itemIndex,
            itemKey: token.invocation.branch.itemKey
          }
          : undefined
      ),
      [
        { itemIndex: 0, itemKey: "item:0" },
        { itemIndex: 1, itemKey: "item:1" },
        { itemIndex: 2, itemKey: "item:2" }
      ]
    )

    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    let state = initialized.state
    for (const index of [2, 0, 1]) {
      const token = activeMultiInstanceTokens(state).find((candidate) =>
        candidate.invocation.branch?._tag === "MultiInstanceItem" &&
        candidate.invocation.branch.itemIndex === index
      )
      if (token === undefined) {
        throw new Error(`expected active parallel member '${index}'`)
      }
      const transition = completeMultiInstanceToken(
        compiled.kernel,
        state,
        token,
        runtime
      )
      journal.push(...transition.events)
      state = transition.state
    }

    assert.strictEqual(
      observations.filter((observation) => observation.tag === "MultiInstanceCardinality").length,
      1
    )
    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups.map((group) => ({
        mode: group.mode,
        source: group.source,
        completedInstanceCount: group.completedInstanceCount,
        status: group.status,
        completionReason: group.completionReason,
        members: group.members.map((member) => ({
          index: member.index,
          itemKey: member.itemKey,
          status: member.status
        }))
      })),
      [{
        mode: "parallel",
        source: { _tag: "Cardinality", value: 3 },
        completedInstanceCount: 3,
        status: "completed",
        completionReason: "all-completed",
        members: [
          { index: 0, itemKey: "item:0", status: "completed" },
          { index: 1, itemKey: "item:1", status: "completed" },
          { index: 2, itemKey: "item:2", status: "completed" }
        ]
      }]
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceItemCompleted"
          ? [event.itemIndex]
          : []
      ),
      [2, 0, 1]
    )
    assert.strictEqual(
      journal.filter((event) =>
        event._tag === "OutgoingSelected" &&
        event.sourceNodeId === "mi_task"
      ).length,
      1
    )
    assert.deepStrictEqual(
      success(BpmnKernel.replay(compiled.kernel, journal)),
      state
    )
    assertMultiInstanceCanonicalReplay(compiled, journal, state)
  })

  it.effect("executes CollectionMultiInstance/1 from XML through ordered output aggregation and exact replay", () =>
    Effect.gen(function*() {
      const compileOptions: BpmnExecutable.CompileXmlOptions = {
        ...options,
        taskBindings: [collectionTaskBinding],
        dataDocument: collectionDataDocument,
        collectionBindings: [collectionBinding]
      }
      const compiled = success(compileXml(
        collectionMultiInstanceXml,
        compileOptions
      ))
      const task = compiled.interchange.model.flowNodes.find(
        (candidate) => candidate.id === "mi_task"
      )
      if (
        task?._tag !== "Task" ||
        task.loopCharacteristics?._tag !==
          "MultiInstanceCharacteristics"
      ) {
        return yield* Effect.die(
          "Expected compiled collection Multi-Instance Task"
        )
      }
      assert.deepStrictEqual(task.loopCharacteristics, {
        _tag: "MultiInstanceCharacteristics",
        mode: "parallel",
        loopDataInputRef: "items",
        loopDataOutputRef: "results",
        inputDataItem: {
          id: "current_item",
          isCollection: false,
          extensionElements: []
        },
        outputDataItem: {
          id: "current_result",
          isCollection: false,
          extensionElements: []
        }
      })
      assert.deepStrictEqual(
        compiled.kernel.taskBindings,
        [collectionTaskBinding]
      )
      assert.deepStrictEqual(
        compiled.kernel.collectionBindings,
        [collectionBinding]
      )
      assert.deepStrictEqual(
        compiled.kernel.dataDocument,
        collectionDataDocument
      )

      const inputItems: ReadonlyArray<Schema.Json> = [
        { id: "first", rank: 1 },
        { id: "duplicate", rank: 2 },
        { id: "duplicate", rank: 2 }
      ]
      const startInput: Schema.Json = {
        requestId: "collection-request",
        items: inputItems
      }
      const requests: Array<
        BpmnExpressionEvaluator.EvaluationRequest
      > = []
      const evaluatorBinding = options.evaluatorBindings[0]!
      const registry = yield* BpmnExpressionEvaluator.makeMemory([
        BpmnExpressionEvaluator.makeDefinition({
          binding: evaluatorBinding,
          evaluate: (request) =>
            Effect.gen(function*() {
              requests.push(request)
              yield* Effect.yieldNow
              return {
                result: inputItems,
                steps: 7
              }
            })
        })
      ])
      const provideRegistry = Effect.provideService(
        BpmnExpressionEvaluator.EvaluatorRegistry,
        registry
      )
      const initialized = yield* BpmnExpressionRuntime.initialize(
        compiled.kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: startInput
        },
        { now }
      ).pipe(provideRegistry)

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0]?.source, "execution.items")
      assert.strictEqual(
        requests[0]?.expectedResult,
        "json-array"
      )
      assert.include(
        JSON.stringify(requests[0]?.context),
        "\"requestId\":\"collection-request\""
      )
      assert.deepStrictEqual(initialized.state.input, startInput)
      assert.deepStrictEqual(
        initialized.state.multiInstanceGroups[0]?.source,
        {
          _tag: "Collection",
          dataInputRef: "items",
          items: inputItems
        }
      )
      const initialTokens = activeMultiInstanceTokens(
        initialized.state
      )
      assert.strictEqual(initialTokens.length, 3)
      assert.deepStrictEqual(
        initialTokens.map((token) =>
          success(BpmnKernel.taskCollectionItem(
            compiled.kernel,
            initialized.state,
            {
              scopeInstanceId: token.scopeInstanceId,
              taskNodeId: "mi_task",
              tokenId: token.tokenId
            }
          ))
        ),
        inputItems.map((item, itemIndex) => ({
          dataInputRef: "items",
          itemIndex,
          itemKey: `item:${itemIndex}`,
          item
        }))
      )

      const outputs: ReadonlyArray<Schema.Json> = [
        { accepted: "first" },
        { accepted: "duplicate-1" },
        { accepted: "duplicate-2" }
      ]
      const journal: Array<BpmnKernel.TransitionEvent> = [
        ...initialized.events
      ]
      let state = initialized.state
      for (const itemIndex of [2, 0, 1] as const) {
        const token = activeMultiInstanceTokens(state).find(
          (candidate) =>
            candidate.invocation.branch?._tag ===
              "MultiInstanceItem" &&
            candidate.invocation.branch.itemIndex === itemIndex
        )
        if (token === undefined) {
          return yield* Effect.die(
            `Expected active collection member '${itemIndex}'`
          )
        }
        const resolved = yield* BpmnExpressionRuntime.resolveTask(
          compiled.kernel,
          state,
          {
            commandVersion: BpmnActivityV3.CommandVersion,
            scopeInstanceId: token.scopeInstanceId,
            taskNodeId: "mi_task",
            tokenId: token.tokenId,
            outcome: collectionOutcome(
              itemIndex,
              outputs[itemIndex]!
            )
          },
          { now }
        ).pipe(provideRegistry)
        journal.push(...resolved.events)
        state = resolved.state
      }

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(state.status, "completed")
      assert.deepStrictEqual(
        state.multiInstanceGroups[0]?.members.map((member) => ({
          index: member.index,
          itemKey: member.itemKey,
          status: member.status,
          output: member.output
        })),
        outputs.map((output, index) => ({
          index,
          itemKey: `item:${index}`,
          status: "completed",
          output
        }))
      )
      assert.deepStrictEqual(
        state.multiInstanceGroups[0]?.output,
        {
          dataOutputRef: "results",
          items: outputs
        }
      )
      assert.deepStrictEqual(
        journal.flatMap((event) =>
          event._tag === "MultiInstanceItemCompleted"
            ? [event.itemIndex]
            : []
        ),
        [2, 0, 1]
      )
      assert.deepStrictEqual(
        journal.flatMap((event) =>
          event._tag === "MultiInstanceGroupCompleted"
            ? [event.output]
            : []
        ),
        [{
          dataOutputRef: "results",
          items: outputs
        }]
      )
      assert.deepStrictEqual(
        success(BpmnKernel.replay(compiled.kernel, journal)),
        state
      )

      const canonical = success(BpmnXml.exportXml(
        compiled.interchange,
        { format: "compact" }
      ))
      assert.include(canonical, "<bpmn:inputDataItem")
      assert.include(canonical, "<bpmn:outputDataItem")
      const recompiled = success(compileXml(
        canonical,
        compileOptions
      ))
      assert.strictEqual(
        recompiled.kernel.modelReference.executableFingerprint,
        compiled.kernel.modelReference.executableFingerprint
      )
      assert.deepStrictEqual(
        success(BpmnKernel.replay(recompiled.kernel, journal)),
        state
      )
    }))

  it("round-trips collection and progressive Multi-Instance mapping while executable admission fails closed", () => {
    const imported = success(BpmnXml.importXml(
      nonExecutableMultiInstanceXml,
      options.importOptions
    ))
    assert.strictEqual(
      imported.profileId,
      "bpmn-2.0.2-core-process-di-v5"
    )
    const task = imported.model.flowNodes.find((node) => node.id === "mi_task")
    if (
      task?._tag !== "Task" ||
      task.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
    ) {
      throw new Error("expected imported collection Multi-Instance task")
    }
    assert.deepStrictEqual(task.loopCharacteristics, {
      _tag: "MultiInstanceCharacteristics",
      mode: "parallel",
      loopDataInputRef: "items",
      loopDataOutputRef: "results",
      behavior: "one",
      oneBehaviorEventRef: "first_completed"
    })
    assert.deepStrictEqual(imported.mappingReport.semanticLosses, [])

    const canonical = success(BpmnXml.exportXml(
      imported,
      { format: "compact" }
    ))
    const reimported = success(BpmnXml.importXml(
      canonical,
      options.importOptions
    ))
    assert.deepStrictEqual(reimported.model, imported.model)
    assert.strictEqual(
      success(BpmnXml.exportXml(reimported, { format: "compact" })),
      canonical
    )

    for (const candidate of [nonExecutableMultiInstanceXml, canonical]) {
      const rejected = failure(compileXml(candidate))
      assert(
        rejected.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.UnsupportedLoop)
      )
    }
  })

  it("uses the exclusive gateway's explicit default when its condition is false", () => {
    const compiled = success(compileXml(xml))
    const initialized = success(BpmnKernel.initialize(
      compiled.kernel,
      startCommand,
      services(false)
    ))
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
        rejected.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidKernelProfile)
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
