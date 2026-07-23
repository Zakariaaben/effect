import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const emptyExtensions = (): Array<BpmnModel.ExtensionElement> => []

const executableFingerprint = Schema.decodeUnknownSync(
  ProtocolV2Wire.BpmnExecutableFingerprint
)(`sha256:${"3".repeat(64)}`)
const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"a".repeat(64)}`)
const operationDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"b".repeat(64)}`)
const occurrenceDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OccurrenceDigest
)(`sha256:${"c".repeat(64)}`)

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const model = (): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [{ id: "message-review" }],
  signals: [{ id: "signal-review" }],
  eventDefinitions: [{
    _tag: "TimerEventDefinition",
    id: "definition-timeout",
    timeDuration: expression("PT5M")
  }],
  collaborations: [{
    id: "collaboration-main",
    participants: [{ id: "participant-main", processId: "process-main" }],
    extensionElements: []
  }],
  processes: [
    {
      id: "process-main",
      isExecutable: true,
      extensionElements: []
    },
    {
      id: "process-child",
      isExecutable: true,
      extensionElements: []
    }
  ],
  flowNodes: [
    {
      _tag: "StartEvent",
      id: "start-main",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-start-gateway"],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "Gateway",
      id: "gateway-main",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: ["flow-start-gateway"],
      outgoingSequenceFlowIds: ["flow-gateway-task", "flow-gateway-call"],
      defaultFlowId: "flow-gateway-call",
      gatewayKind: "exclusive",
      gatewayDirection: "diverging",
      extensionElements: []
    },
    {
      _tag: "Task",
      id: "task-review",
      processId: "process-main",
      parentScopeId: "process-main",
      taskKind: "user",
      incomingSequenceFlowIds: ["flow-gateway-task"],
      outgoingSequenceFlowIds: ["flow-task-end"],
      loopCharacteristics: {
        _tag: "MultiInstanceCharacteristics",
        mode: "parallel",
        cardinality: expression("items.length")
      },
      extensionElements: []
    },
    {
      _tag: "CallActivity",
      id: "call-child",
      processId: "process-main",
      parentScopeId: "process-main",
      calledElement: {
        namespaceUri: "urn:workflow:child",
        localName: "process-child"
      },
      incomingSequenceFlowIds: ["flow-gateway-call"],
      outgoingSequenceFlowIds: ["flow-call-end"],
      extensionElements: []
    },
    {
      _tag: "SubProcess",
      id: "sub-pack",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      loopCharacteristics: {
        _tag: "StandardLoopCharacteristics",
        testBefore: true,
        condition: expression("continuePacking")
      },
      extensionElements: []
    },
    {
      _tag: "EventSubProcess",
      id: "esp-timeout",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      extensionElements: []
    },
    {
      _tag: "StartEvent",
      id: "start-timeout",
      processId: "process-main",
      parentScopeId: "esp-timeout",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-timeout-end"],
      eventDefinitions: [],
      eventDefinitionRefs: ["definition-timeout"],
      isInterrupting: true,
      extensionElements: []
    },
    {
      _tag: "EndEvent",
      id: "end-timeout",
      processId: "process-main",
      parentScopeId: "esp-timeout",
      incomingSequenceFlowIds: ["flow-timeout-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "Task",
      id: "activity-pack",
      processId: "process-main",
      parentScopeId: "sub-pack",
      taskKind: "generic",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      extensionElements: []
    },
    {
      _tag: "BoundaryEvent",
      id: "boundary-review",
      processId: "process-main",
      parentScopeId: "process-main",
      attachedToRef: "task-review",
      cancelActivity: true,
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-boundary-end"],
      eventDefinitions: [{
        _tag: "TimerEventDefinition",
        timeDuration: expression("PT10M")
      }],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "EndEvent",
      id: "end-boundary",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: ["flow-boundary-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "Task",
      id: "task-review-outcome-source",
      processId: "process-main",
      parentScopeId: "process-main",
      taskKind: "generic",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-review-outcome-catch"],
      extensionElements: []
    },
    {
      _tag: "IntermediateCatchEvent",
      id: "catch-review-outcome",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: ["flow-review-outcome-catch"],
      outgoingSequenceFlowIds: ["flow-review-outcome-end"],
      eventDefinitions: [
        { _tag: "MessageEventDefinition", messageRef: "message-review" },
        { _tag: "SignalEventDefinition", signalRef: "signal-review" }
      ],
      eventDefinitionRefs: [],
      parallelMultiple: true,
      extensionElements: []
    },
    {
      _tag: "EndEvent",
      id: "end-review-outcome",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: ["flow-review-outcome-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "EndEvent",
      id: "end-main",
      processId: "process-main",
      parentScopeId: "process-main",
      incomingSequenceFlowIds: ["flow-task-end", "flow-call-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    }
  ],
  sequenceFlows: [
    {
      id: "flow-start-gateway",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "start-main",
      targetId: "gateway-main",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-gateway-task",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "gateway-main",
      targetId: "task-review",
      kind: "conditional",
      isImmediate: true,
      condition: expression("needsReview"),
      extensionElements: []
    },
    {
      id: "flow-gateway-call",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "gateway-main",
      targetId: "call-child",
      kind: "default",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-task-end",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "task-review",
      targetId: "end-main",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-call-end",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "call-child",
      targetId: "end-main",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-timeout-end",
      processId: "process-main",
      parentScopeId: "esp-timeout",
      sourceId: "start-timeout",
      targetId: "end-timeout",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-boundary-end",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "boundary-review",
      targetId: "end-boundary",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-review-outcome-catch",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "task-review-outcome-source",
      targetId: "catch-review-outcome",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    },
    {
      id: "flow-review-outcome-end",
      processId: "process-main",
      parentScopeId: "process-main",
      sourceId: "catch-review-outcome",
      targetId: "end-review-outcome",
      kind: "normal",
      isImmediate: true,
      extensionElements: []
    }
  ]
})

const state = (): BpmnExecutionState.BpmnExecutionState => ({
  stateKind: "BpmnExecutionState",
  stateVersion: BpmnExecutionState.BpmnExecutionStateVersion,
  model: {
    fingerprintVersion: BpmnExecutionState.BpmnExecutableFingerprintVersion,
    kernelSemanticVersion: BpmnExecutionState.BpmnKernelSemanticVersion,
    profileId: "test-bpmn-model-v1",
    modelKind: "BpmnModel",
    modelVersion: BpmnModel.BpmnModelVersion,
    bpmnSpecVersion: "2.0.2",
    rootProcessId: "process-main",
    executableFingerprint
  },
  status: "active",
  startedAt: "2026-07-23T10:00:00.000Z",
  extensionElements: [{
    namespaceUri: "urn:effect:test",
    localName: "meta",
    content: JSON.parse("{\"__proto__\":{\"polluted\":true},\"constructor\":\"safe\"}")
  }],
  scopeInstances: [
    {
      scopeInstanceId: "scope-root",
      definitionId: "process-main",
      processId: "process-main",
      invocation: {
        activationId: "activation-1",
        generation: 1
      },
      status: "active",
      enteredAt: "2026-07-23T10:00:00.000Z"
    },
    {
      scopeInstanceId: "scope-sub-pack",
      definitionId: "sub-pack",
      processId: "process-main",
      parentScopeInstanceId: "scope-root",
      invocation: {
        activationId: "activation-1",
        loopIteration: 0,
        generation: 1
      },
      status: "active",
      enteredAt: "2026-07-23T10:00:01.000Z"
    },
    {
      scopeInstanceId: "scope-timeout",
      definitionId: "esp-timeout",
      processId: "process-main",
      parentScopeInstanceId: "scope-root",
      invocation: {
        activationId: "activation-1",
        generation: 1
      },
      status: "active",
      enteredAt: "2026-07-23T10:00:02.000Z"
    }
  ],
  tokens: [{
    tokenId: "token-main",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    invocation: {
      activationId: "activation-1",
      generation: 1
    },
    status: "active",
    position: { _tag: "AtNode", nodeId: "gateway-main" },
    createdAt: "2026-07-23T10:00:03.000Z"
  }],
  activityResolutions: [],
  gatewayFrames: [{
    frameId: "frame-gateway",
    gatewayId: "gateway-main",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    activationId: "activation-1",
    joinEpoch: 1,
    expectedIncomingSequenceFlowIds: ["flow-start-gateway"],
    arrivedIncomingSequenceFlowIds: ["flow-start-gateway"],
    status: "satisfied"
  }],
  loopFrames: [{
    frameId: "frame-loop",
    activityId: "sub-pack",
    processId: "process-main",
    scopeInstanceId: "scope-sub-pack",
    iteration: 0,
    mode: "standard",
    status: "active"
  }],
  multiInstanceGroups: [{
    groupId: "group-review",
    activityId: "task-review",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    mode: "parallel",
    status: "active",
    cardinality: 3,
    completedInstanceCount: 1
  }],
  callFrames: [{
    callFrameId: "callframe-child",
    callActivityId: "call-child",
    processId: "process-main",
    parentScopeInstanceId: "scope-root",
    childExecutionId: "exec-child-1",
    childProcessId: "process-child",
    status: "active",
    enteredAt: "2026-07-23T10:00:04.000Z"
  }],
  subscriptions: [{
    subscriptionId: "subscription-timeout",
    ownerNodeId: "start-timeout",
    processId: "process-main",
    scopeInstanceId: "scope-timeout",
    kind: "timer",
    status: "waiting"
  }, {
    subscriptionId: "subscription-boundary",
    ownerNodeId: "boundary-review",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    kind: "timer",
    status: "waiting"
  }, {
    subscriptionId: "subscription-review-outcome",
    ownerNodeId: "catch-review-outcome",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    kind: "parallel-multiple",
    status: "waiting"
  }],
  timers: [{
    timerId: "timer-timeout",
    ownerType: "subscription",
    ownerId: "subscription-timeout",
    processId: "process-main",
    scopeInstanceId: "scope-timeout",
    deadline: "2026-07-23T10:05:00.000Z",
    status: "pending"
  }],
  workItems: [{
    workItemId: "work-review",
    taskId: "task-review",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    status: "started",
    assignee: "user-1",
    dueAt: "2026-07-23T10:10:00.000Z"
  }],
  compensationRegistrations: [{
    registrationId: "comp-review",
    activityId: "task-review",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    order: 0,
    status: "registered"
  }],
  cancellationRegions: [{
    regionId: "cancel-main",
    scopeInstanceId: "scope-root",
    status: "open",
    memberScopeInstanceIds: ["scope-timeout"],
    memberTokenIds: ["token-main"]
  }]
})

describe("BpmnExecutionState", () => {
  it("admits a durable BPMN execution-state snapshot against a validated model", () => {
    const result = BpmnExecutionState.validate(model(), state())

    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
    assert.isTrue(Object.isFrozen(result.success))
    assert.isTrue(Object.isFrozen(result.success.scopeInstances))
    assert.isTrue(Object.isFrozen(result.success.scopeInstances[0]))

    const content = result.success.extensionElements[0]!.content as Readonly<Record<string, unknown>>
    assert.deepStrictEqual(content["__proto__"], { polluted: true })
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
  })

  it("resolves reusable event-definition references and admits boundary-event subscriptions", () => {
    const referencedOnly = state()
    referencedOnly.subscriptions = referencedOnly.subscriptions.filter((subscription) =>
      subscription.subscriptionId === "subscription-timeout" ||
      subscription.subscriptionId === "subscription-boundary"
    )
    const valid = BpmnExecutionState.validate(model(), referencedOnly)

    assert.isTrue(Result.isSuccess(valid))

    const wrongKind = state()
    const referencedSubscription = wrongKind.subscriptions.find((subscription) =>
      subscription.subscriptionId === "subscription-timeout"
    )
    if (referencedSubscription === undefined) {
      throw new Error("missing referenced event-definition subscription fixture")
    }
    referencedSubscription.kind = "signal"

    const invalid = BpmnExecutionState.validate(model(), wrongKind)
    assert.isTrue(Result.isFailure(invalid))
    if (Result.isSuccess(invalid)) {
      throw new Error("expected validation failure")
    }
    assert.isTrue(
      invalid.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidSubscription &&
        diagnostic.path.join("/") === "subscriptions/0/kind"
      )
    )
  })

  it("requires explicit multiple and parallel-multiple subscription group semantics", () => {
    const parallelModel = model()
    const parallelState = state()
    const parallelSubscription = parallelState.subscriptions.find((subscription) =>
      subscription.subscriptionId === "subscription-review-outcome"
    )
    if (parallelSubscription === undefined) {
      throw new Error("missing multiple-event subscription fixture")
    }

    parallelSubscription.kind = "multiple"
    const wrongParallelKind = BpmnExecutionState.validate(parallelModel, parallelState)

    assert.isTrue(Result.isFailure(wrongParallelKind))
    if (Result.isSuccess(wrongParallelKind)) {
      throw new Error("expected validation failure")
    }
    assert.isTrue(
      wrongParallelKind.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidSubscription
      )
    )

    const exclusiveModel = model()
    const multipleEvent = exclusiveModel.flowNodes.find((node) => node.id === "catch-review-outcome")
    if (multipleEvent?._tag !== "IntermediateCatchEvent") {
      throw new Error("missing multiple-event fixture")
    }
    multipleEvent.parallelMultiple = false
    const exclusiveState = state()
    const exclusiveSubscription = exclusiveState.subscriptions.find((subscription) =>
      subscription.subscriptionId === "subscription-review-outcome"
    )
    if (exclusiveSubscription === undefined) {
      throw new Error("missing multiple-event subscription fixture")
    }
    exclusiveSubscription.kind = "multiple"

    const validExclusive = BpmnExecutionState.validate(exclusiveModel, exclusiveState)
    assert.isTrue(Result.isSuccess(validExclusive))
  })

  it("cross-validates exact durable protocol-v3 task resolutions", () => {
    const resolved = state()
    const token = resolved.tokens[0]!
    token.position = { _tag: "AtNode", nodeId: "task-review" }
    token.status = "consumed"
    token.consumedAt = "2026-07-23T10:00:05.000Z"
    resolved.activityResolutions = [{
      resolutionVersion: BpmnActivityV3.ResolutionVersion,
      tokenId: token.tokenId,
      taskNodeId: "task-review",
      scopeInstanceId: token.scopeInstanceId,
      outcome: {
        _tag: "Succeeded",
        outcomeVersion: BpmnActivityV3.OutcomeVersion,
        artifactDigest,
        semanticNodeId: "semantic-task",
        occurrenceDigest,
        firstActivityDigest: operationDigest,
        attempt: 1,
        completedActivityDigest: operationDigest
      },
      resolvedAt: token.consumedAt
    }]

    const valid = BpmnExecutionState.validate(model(), resolved)
    assert(Result.isSuccess(valid))

    const dangling = structuredClone(resolved)
    dangling.activityResolutions[0]!.tokenId = "missing-token"
    const invalidDangling = BpmnExecutionState.validate(model(), dangling)
    assert(Result.isFailure(invalidDangling))
    assert(
      invalidDangling.failure.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          BpmnExecutionState.Codes.UnknownActivityResolutionTokenRef
      )
    )

    const active = structuredClone(resolved)
    active.tokens[0]!.status = "active"
    delete active.tokens[0]!.consumedAt
    const invalidActive = BpmnExecutionState.validate(model(), active)
    assert(Result.isFailure(invalidActive))
    assert(
      invalidActive.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidActivityResolution
      )
    )
  })

  it("rejects cross-scope tokens and duplicate gateway arrivals within one join epoch", () => {
    const forged = state()
    forged.tokens[0]!.scopeInstanceId = "scope-sub-pack"
    forged.gatewayFrames[0]!.arrivedIncomingSequenceFlowIds = [
      "flow-start-gateway",
      "flow-start-gateway"
    ]

    const result = BpmnExecutionState.validate(model(), forged)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    const codes = new Set(result.failure.diagnostics.map((diagnostic) => diagnostic.code))
    assert.isTrue(codes.has(BpmnExecutionState.Codes.InvalidTokenPosition))
    assert.isTrue(codes.has(BpmnExecutionState.Codes.InvalidGatewayFrame))
    assert.isTrue(
      result.failure.diagnostics.some((diagnostic) => diagnostic.message.includes("join epoch"))
    )
  })

  it("rejects incoherent lifecycle states and backwards durable timestamps", () => {
    const backwards = state()
    backwards.scopeInstances[0]!.exitedAt = "2026-07-23T10:00:04.000Z"
    backwards.scopeInstances[1]!.enteredAt = "2026-07-23T09:59:59.000Z"
    backwards.tokens[0]!.createdAt = "2026-07-23T09:59:58.000Z"

    const invalidChronology = BpmnExecutionState.validate(model(), backwards)
    assert(Result.isFailure(invalidChronology))
    const chronologyCodes = new Set(
      invalidChronology.failure.diagnostics.map((diagnostic) => diagnostic.code)
    )
    assert(chronologyCodes.has(BpmnExecutionState.Codes.InvalidScopeInvocation))
    assert(chronologyCodes.has(BpmnExecutionState.Codes.InvalidTokenPosition))

    const terminal = state()
    terminal.status = "completed"
    terminal.completedAt = "2026-07-23T10:10:00.000Z"
    terminal.scopeInstances[0]!.status = "completed"
    terminal.scopeInstances[0]!.exitedAt = "2026-07-23T10:10:00.000Z"

    const invalidTerminal = BpmnExecutionState.validate(model(), terminal)
    assert(Result.isFailure(invalidTerminal))
    assert(
      invalidTerminal.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidScopeInvocation
      )
    )
    assert(
      invalidTerminal.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidGatewayFrame
      )
    )
  })

  it("requires a failed execution to retain a failed root scope", () => {
    const failed = state()
    failed.status = "failed"
    failed.completedAt = "2026-07-23T10:10:00.000Z"
    failed.scopeInstances[0]!.status = "completed"
    failed.scopeInstances[0]!.exitedAt = failed.completedAt

    const result = BpmnExecutionState.validate(model(), failed)

    assert(Result.isFailure(result))
    assert(
      result.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidState &&
        diagnostic.message.includes("failed root scope")
      )
    )
  })

  it("rejects hostile execution-state accessors without invoking them", () => {
    let getterCalls = 0
    const input = { stateKind: "BpmnExecutionState" } as Record<string, unknown>
    Object.defineProperty(input, "stateVersion", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 1
      }
    })

    const result = BpmnExecutionState.validate(model(), input)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    assert.strictEqual(getterCalls, 0)
    assert.strictEqual(result.failure.diagnostics[0]!.code, BpmnExecutionState.Codes.InvalidJson)
  })

  it("strictly rejects excess properties at the schema boundary", () => {
    const decode = Schema.decodeUnknownSync(BpmnExecutionState.BpmnExecutionState)
    const invalid = { ...state(), extra: true }

    assert.throws(() => decode(invalid))
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnExecutionState.ScopeInstance)({
        ...state().scopeInstances[0],
        extra: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnExecutionState.Token)({
        ...state().tokens[0],
        extra: true
      })
    )
  })

  it("aggregates dangling and type-mismatch diagnostics across durable runtime structures", () => {
    const invalidModel = model()
    const invalidState = state()

    invalidState.model.rootProcessId = "missing-root"
    invalidState.scopeInstances.push({
      scopeInstanceId: "scope-root",
      definitionId: "missing-scope",
      processId: "missing-process",
      parentScopeInstanceId: "missing-parent",
      invocation: {
        activationId: "activation-2",
        generation: 1
      },
      status: "completed",
      enteredAt: "2026-07-23T10:00:00.000Z"
    })
    invalidState.tokens.push({
      tokenId: "token-bad",
      processId: "process-main",
      scopeInstanceId: "missing-scope-instance",
      invocation: {
        activationId: "activation-x",
        generation: 1
      },
      status: "active",
      position: { _tag: "OnSequenceFlow", sequenceFlowId: "missing-flow" },
      createdAt: "2026-07-23T10:00:03.000Z"
    })
    invalidState.gatewayFrames.push({
      frameId: "frame-bad",
      gatewayId: "task-review",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      activationId: "activation-1",
      joinEpoch: 1,
      expectedIncomingSequenceFlowIds: ["missing-flow"],
      arrivedIncomingSequenceFlowIds: ["missing-flow"],
      status: "waiting"
    })
    invalidState.loopFrames.push({
      frameId: "frame-bad-loop",
      activityId: "gateway-main",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      iteration: 0,
      mode: "standard",
      status: "active"
    })
    invalidState.multiInstanceGroups.push({
      groupId: "group-bad",
      activityId: "sub-pack",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      mode: "parallel",
      status: "active"
    })
    invalidState.callFrames.push({
      callFrameId: "callframe-bad",
      callActivityId: "task-review",
      processId: "process-main",
      parentScopeInstanceId: "missing-parent",
      childExecutionId: "child-2",
      childProcessId: "missing-child",
      status: "active",
      enteredAt: "2026-07-23T10:00:04.000Z"
    })
    invalidState.subscriptions.push({
      subscriptionId: "subscription-bad",
      ownerNodeId: "task-review",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      kind: "message",
      status: "waiting"
    })
    invalidState.timers.push({
      timerId: "timer-bad",
      ownerType: "work-item",
      ownerId: "missing-work-item",
      processId: "process-main",
      scopeInstanceId: "missing-scope",
      deadline: "2026-07-23T10:05:00.000Z",
      status: "pending"
    })
    invalidState.workItems.push({
      workItemId: "work-bad",
      taskId: "call-child",
      processId: "process-main",
      scopeInstanceId: "missing-scope",
      status: "created"
    })
    invalidState.compensationRegistrations.push({
      registrationId: "comp-bad",
      activityId: "gateway-main",
      processId: "process-main",
      scopeInstanceId: "missing-scope",
      order: 0,
      status: "registered"
    })
    invalidState.cancellationRegions.push({
      regionId: "cancel-bad",
      scopeInstanceId: "missing-scope",
      status: "open",
      memberScopeInstanceIds: ["missing-scope"],
      memberTokenIds: ["missing-token"]
    })

    const result = BpmnExecutionState.validate(invalidModel, invalidState)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    const codes = new Set(result.failure.diagnostics.map((diagnostic) => diagnostic.code))

    assert.isFalse(codes.has(BpmnExecutionState.Codes.InvalidJson))
    for (
      const code of [
        BpmnExecutionState.Codes.RootProcessMismatch,
        BpmnExecutionState.Codes.DuplicateStateId,
        BpmnExecutionState.Codes.UnknownProcessRef,
        BpmnExecutionState.Codes.UnknownDefinitionRef,
        BpmnExecutionState.Codes.UnknownParentScopeInstanceRef,
        BpmnExecutionState.Codes.InvalidScopeInvocation,
        BpmnExecutionState.Codes.UnknownTokenScopeRef,
        BpmnExecutionState.Codes.InvalidTokenInvocation,
        BpmnExecutionState.Codes.InvalidTokenPosition,
        BpmnExecutionState.Codes.InvalidGatewayFrame,
        BpmnExecutionState.Codes.InvalidLoopFrame,
        BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
        BpmnExecutionState.Codes.InvalidCallFrame,
        BpmnExecutionState.Codes.InvalidSubscription,
        BpmnExecutionState.Codes.UnknownTimerOwnerRef,
        BpmnExecutionState.Codes.InvalidWorkItem,
        BpmnExecutionState.Codes.InvalidCompensationRegistration,
        BpmnExecutionState.Codes.UnknownCancellationMemberRef
      ] as const
    ) {
      assert.isTrue(codes.has(code), `expected diagnostics to include ${code}`)
    }
  })
})
