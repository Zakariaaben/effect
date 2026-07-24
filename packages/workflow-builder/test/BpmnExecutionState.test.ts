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
const buildDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.BuildDigest
)(`sha256:${"d".repeat(64)}`)
const schemaDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.SchemaDigest
)(`sha256:${"e".repeat(64)}`)

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
      loopCharacteristics: {
        _tag: "StandardLoopCharacteristics",
        testBefore: true,
        condition: expression("continuePackingItems"),
        loopMaximum: 3
      },
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
  input: {
    caseId: "case-1",
    reviewItems: [
      { documentId: "doc-1" },
      { documentId: "doc-2" },
      { documentId: "doc-3" }
    ]
  },
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
  tokens: [
    {
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
    },
    {
      tokenId: "token-loop",
      processId: "process-main",
      scopeInstanceId: "scope-sub-pack",
      invocation: {
        activationId: "activation-1",
        branch: {
          _tag: "StandardLoopIteration",
          frameId: "frame-loop",
          iteration: 0
        },
        generation: 1
      },
      status: "active",
      position: { _tag: "AtNode", nodeId: "activity-pack" },
      createdAt: "2026-07-23T10:00:03.000Z"
    },
    {
      tokenId: "token-review-0",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      invocation: {
        activationId: "activation-1",
        branch: {
          _tag: "MultiInstanceItem",
          groupId: "group-review",
          itemIndex: 0,
          itemKey: "review-0"
        },
        generation: 1
      },
      status: "consumed",
      position: { _tag: "AtNode", nodeId: "task-review" },
      createdAt: "2026-07-23T10:00:03.100Z",
      consumedAt: "2026-07-23T10:00:03.500Z"
    },
    {
      tokenId: "token-review-1",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      invocation: {
        activationId: "activation-1",
        branch: {
          _tag: "MultiInstanceItem",
          groupId: "group-review",
          itemIndex: 1,
          itemKey: "review-1"
        },
        generation: 1
      },
      status: "active",
      position: { _tag: "AtNode", nodeId: "task-review" },
      createdAt: "2026-07-23T10:00:03.100Z"
    },
    {
      tokenId: "token-review-2",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      invocation: {
        activationId: "activation-1",
        branch: {
          _tag: "MultiInstanceItem",
          groupId: "group-review",
          itemIndex: 2,
          itemKey: "review-2"
        },
        generation: 1
      },
      status: "active",
      position: { _tag: "AtNode", nodeId: "task-review" },
      createdAt: "2026-07-23T10:00:03.100Z"
    }
  ],
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
    activityId: "activity-pack",
    processId: "process-main",
    scopeInstanceId: "scope-sub-pack",
    activation: 0,
    completedIterations: 0,
    activeIteration: 0,
    status: "active",
    openedAt: "2026-07-23T10:00:02.000Z"
  }],
  multiInstanceGroups: [{
    groupId: "group-review",
    activityId: "task-review",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    activation: 0,
    mode: "parallel",
    source: { _tag: "Cardinality", value: 3 },
    members: [{
      index: 0,
      itemKey: "review-0",
      status: "completed",
      tokenId: "token-review-0",
      startedAt: "2026-07-23T10:00:03.100Z",
      endedAt: "2026-07-23T10:00:03.500Z"
    }, {
      index: 1,
      itemKey: "review-1",
      status: "active",
      tokenId: "token-review-1",
      startedAt: "2026-07-23T10:00:03.100Z"
    }, {
      index: 2,
      itemKey: "review-2",
      status: "active",
      tokenId: "token-review-2",
      startedAt: "2026-07-23T10:00:03.100Z"
    }],
    status: "active",
    completedInstanceCount: 1,
    openedAt: "2026-07-23T10:00:03.000Z"
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
  catchWaitGroups: [],
  subscriptions: [],
  timers: [],
  messageDeliveries: [],
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

const messageWaitModel = (): BpmnModel.BpmnModel => {
  const input = model()
  const catchEvent = input.flowNodes.find((node) => node.id === "catch-review-outcome")
  if (catchEvent?._tag !== "IntermediateCatchEvent") {
    throw new Error("missing intermediate catch event fixture")
  }
  catchEvent.eventDefinitions = [{
    _tag: "MessageEventDefinition",
    messageRef: "message-review"
  }]
  catchEvent.eventDefinitionRefs = []
  delete catchEvent.parallelMultiple
  return input
}

const waitingMessageState = (): BpmnExecutionState.BpmnExecutionState => {
  const input = state()
  const token = input.tokens.find((candidate) => candidate.tokenId === "token-main")
  if (token === undefined) {
    throw new Error("missing owner token fixture")
  }
  token.position = {
    _tag: "AtNode",
    nodeId: "catch-review-outcome"
  }
  input.catchWaitGroups = [{
    waitGroupId: "wait-review-outcome",
    source: {
      _tag: "StandaloneCatch",
      catchEventNodeId: "catch-review-outcome"
    },
    ownerTokenId: token.tokenId,
    processId: "process-main",
    scopeInstanceId: "scope-root",
    generation: 1,
    armIds: ["arm-review-message"],
    status: "waiting",
    openedAt: "2026-07-23T10:00:03.000Z"
  }]
  input.subscriptions = [{
    _tag: "MessageCatchSubscription",
    armId: "arm-review-message",
    waitGroupId: "wait-review-outcome",
    ownerNodeId: "catch-review-outcome",
    processId: "process-main",
    scopeInstanceId: "scope-root",
    tokenId: token.tokenId,
    generation: 1,
    ordinal: 0,
    status: "waiting",
    openedAt: "2026-07-23T10:00:03.000Z",
    messageRef: "message-review",
    correlationKey: ["tenant-1", "review-42"]
  }]
  return input
}

const wonMessageState = (): BpmnExecutionState.BpmnExecutionState => {
  const input = waitingMessageState()
  const token = input.tokens.find((candidate) => candidate.tokenId === "token-main")!
  token.status = "consumed"
  token.consumedAt = "2026-07-23T10:00:04.000Z"
  input.catchWaitGroups[0] = {
    ...input.catchWaitGroups[0]!,
    status: "won",
    winner: {
      _tag: "MessageWinner",
      armId: "arm-review-message",
      deliveryId: "delivery-review-1",
      acceptedAt: "2026-07-23T10:00:04.000Z",
      selectedAt: "2026-07-23T10:00:04.000Z",
      recordedAt: "2026-07-23T10:00:04.000Z"
    },
    closedAt: "2026-07-23T10:00:04.000Z"
  }
  const arm = input.subscriptions[0]
  if (arm?._tag !== "MessageCatchSubscription") {
    throw new Error("missing Message arm fixture")
  }
  arm.status = "won"
  arm.closedAt = "2026-07-23T10:00:04.000Z"
  arm.receipt = {
    receiptVersion: 1,
    deliveryId: "delivery-review-1",
    messageRef: "message-review",
    correlationKey: ["tenant-1", "review-42"],
    payloadContract: {
      _tag: "ArtifactCodec",
      contractReferenceVersion: 1,
      codecKey: "review-message-v1",
      schemaDigest
    },
    payload: {
      outcome: "approved"
    },
    acceptedAt: "2026-07-23T10:00:04.000Z",
    authorization: {
      policy: {
        policyVersion: 1,
        policyId: "review-message-policy",
        deploymentId: "policy-deployment-1",
        buildDigest
      },
      decisionId: "decision-review-1",
      actorId: "reviewer-1"
    }
  }
  input.messageDeliveries = [{
    target: {
      waitGroupId: "wait-review-outcome",
      armId: "arm-review-message",
      scopeInstanceId: "scope-root",
      catchEventNodeId: "catch-review-outcome",
      tokenId: token.tokenId,
      generation: 1
    },
    receipt: structuredClone(arm.receipt),
    disposition: "message-winner",
    recordedAt: "2026-07-23T10:00:04.000Z"
  }]
  return input
}

const completedStandardLoopState = (): BpmnExecutionState.BpmnExecutionState => {
  const input = state()
  const frame = input.loopFrames[0]!
  const tokenTemplate = input.tokens.find((token) =>
    token.invocation.branch?._tag === "StandardLoopIteration" &&
    token.invocation.branch.frameId === frame.frameId
  )!
  input.tokens = input.tokens.filter((token) => token !== tokenTemplate)
  frame.completedIterations = 3
  delete frame.activeIteration
  frame.status = "completed"
  frame.closedAt = "2026-07-23T10:00:04.000Z"

  const timestamps = [
    ["2026-07-23T10:00:02.100Z", "2026-07-23T10:00:02.200Z"],
    ["2026-07-23T10:00:02.300Z", "2026-07-23T10:00:02.400Z"],
    ["2026-07-23T10:00:02.500Z", "2026-07-23T10:00:02.600Z"]
  ] as const
  for (let iteration = 0; iteration < timestamps.length; iteration++) {
    const history = structuredClone(tokenTemplate)
    history.tokenId = `token-loop-history-${iteration}`
    if (history.invocation.branch?._tag !== "StandardLoopIteration") {
      throw new Error("missing standard loop branch")
    }
    history.invocation.branch.iteration = iteration
    history.status = "consumed"
    history.createdAt = timestamps[iteration]![0]
    history.consumedAt = timestamps[iteration]![1]
    input.tokens.push(history)
  }
  return input
}

const sequentialMultiInstanceFixture = (): {
  readonly model: BpmnModel.BpmnModel
  readonly state: BpmnExecutionState.BpmnExecutionState
} => {
  const inputModel = model()
  const activity = inputModel.flowNodes.find((node) => node.id === "task-review")
  if (
    activity?._tag !== "Task" ||
    activity.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
  ) {
    throw new Error("missing multi-instance task fixture")
  }
  activity.loopCharacteristics.mode = "sequential"

  const inputState = state()
  const group = inputState.multiInstanceGroups[0]!
  group.mode = "sequential"
  const pending = group.members[2]!
  pending.status = "pending"
  delete pending.tokenId
  delete pending.startedAt
  inputState.tokens = inputState.tokens.filter((token) => token.tokenId !== "token-review-2")

  return { model: inputModel, state: inputState }
}

const completedByConditionMultiInstanceState = (): BpmnExecutionState.BpmnExecutionState => {
  const input = state()
  const group = input.multiInstanceGroups[0]!
  const close = "2026-07-23T10:00:04.000Z"
  group.status = "completed"
  group.completionReason = "completion-condition"
  group.closedAt = close

  const activeMember = group.members[1]!
  activeMember.status = "terminated"
  activeMember.terminationReason = "completion-condition"
  activeMember.endedAt = close
  const activeToken = input.tokens.find((token) => token.tokenId === activeMember.tokenId)!
  activeToken.status = "withdrawn"
  activeToken.consumedAt = close

  const otherActiveMember = group.members[2]!
  otherActiveMember.status = "terminated"
  otherActiveMember.terminationReason = "completion-condition"
  otherActiveMember.endedAt = close
  const otherActiveToken = input.tokens.find((token) => token.tokenId === otherActiveMember.tokenId)!
  otherActiveToken.status = "withdrawn"
  otherActiveToken.consumedAt = close

  return input
}

const completedCollectionMultiInstanceFixture = (): {
  readonly model: BpmnModel.BpmnModel
  readonly state: BpmnExecutionState.BpmnExecutionState
} => {
  const inputModel = model()
  const activity = inputModel.flowNodes.find((node) => node.id === "task-review")
  if (
    activity?._tag !== "Task" ||
    activity.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
  ) {
    throw new Error("missing multi-instance task fixture")
  }
  delete activity.loopCharacteristics.cardinality
  activity.loopCharacteristics.loopDataInputRef = "review-items"
  activity.loopCharacteristics.loopDataOutputRef = "review-results"

  const inputState = state()
  const group = inputState.multiInstanceGroups[0]!
  const close = "2026-07-23T10:00:04.000Z"
  group.source = {
    _tag: "Collection",
    dataInputRef: "review-items",
    items: [
      { documentId: "doc-1" },
      { documentId: "doc-2" },
      { documentId: "doc-3" }
    ]
  }
  const outputs: ReadonlyArray<Schema.Json> = [
    { accepted: true, ordinal: 0 },
    { accepted: false, ordinal: 1 },
    { accepted: true, ordinal: 2 }
  ]
  for (let index = 0; index < group.members.length; index++) {
    const member = group.members[index]!
    const token = inputState.tokens.find((candidate) => candidate.tokenId === member.tokenId)!
    member.status = "completed"
    member.endedAt ??= close
    member.output = outputs[index]!
    token.status = "consumed"
    token.consumedAt = member.endedAt
  }
  group.completedInstanceCount = group.members.length
  group.status = "completed"
  group.completionReason = "all-completed"
  group.closedAt = close
  group.output = {
    dataOutputRef: "review-results",
    items: outputs.map((output) => structuredClone(output))
  }

  return { model: inputModel, state: inputState }
}

const assertDiagnostic = (
  result: ReturnType<typeof BpmnExecutionState.validate>,
  code: BpmnExecutionState.ExecutionStateCode,
  options?: {
    readonly path?: string
    readonly message?: string
  }
): void => {
  assert(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error("expected validation failure")
  }
  assert(
    result.failure.diagnostics.some((diagnostic) =>
      diagnostic.code === code &&
      (options?.path === undefined || diagnostic.path.join("/") === options.path) &&
      (options?.message === undefined || diagnostic.message.includes(options.message))
    ),
    `expected ${code}${options?.path === undefined ? "" : ` at ${options.path}`}`
  )
}

describe("BpmnExecutionState", () => {
  it("admits a durable BPMN execution-state snapshot against a validated model", () => {
    const result = BpmnExecutionState.validate(model(), state())

    assert.strictEqual(BpmnExecutionState.BpmnExecutionStateVersion, 7)
    assert.strictEqual(BpmnExecutionState.BpmnExecutableFingerprintVersion, 5)
    assert.strictEqual(BpmnExecutionState.BpmnKernelSemanticVersion, "6")
    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
    assert.isTrue(Object.isFrozen(result.success))
    assert.isTrue(Object.isFrozen(result.success.input))
    assert.isTrue(Object.isFrozen(result.success.scopeInstances))
    assert.isTrue(Object.isFrozen(result.success.scopeInstances[0]))

    const content = result.success.extensionElements[0]!.content as Readonly<Record<string, unknown>>
    assert.deepStrictEqual(content["__proto__"], { polluted: true })
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
  })

  it("admits advanced, completed, and cancelled standard-loop authority", () => {
    const advanced = state()
    const advancedFrame = advanced.loopFrames[0]!
    const currentIteration = advanced.tokens.find((token) =>
      token.invocation.branch?._tag === "StandardLoopIteration" &&
      token.invocation.branch.frameId === advancedFrame.frameId
    )!
    const previousIteration = structuredClone(currentIteration)
    previousIteration.tokenId = "token-loop-history-0"
    previousIteration.status = "consumed"
    previousIteration.createdAt = "2026-07-23T10:00:02.500Z"
    previousIteration.consumedAt = "2026-07-23T10:00:03.100Z"
    advanced.tokens.push(previousIteration)
    if (currentIteration.invocation.branch?._tag !== "StandardLoopIteration") {
      throw new Error("missing standard loop branch")
    }
    currentIteration.invocation.branch.iteration = 1
    currentIteration.createdAt = "2026-07-23T10:00:03.200Z"
    advancedFrame.completedIterations = 1
    advancedFrame.activeIteration = 1

    assert(Result.isSuccess(BpmnExecutionState.validate(model(), advanced)))

    const terminal = completedStandardLoopState()
    assert(Result.isSuccess(BpmnExecutionState.validate(model(), terminal)))

    const cancelled = state()
    const cancelledFrame = cancelled.loopFrames[0]!
    const withdrawn = cancelled.tokens.find((token) =>
      token.invocation.branch?._tag === "StandardLoopIteration" &&
      token.invocation.branch.frameId === cancelledFrame.frameId
    )!
    const completed = structuredClone(withdrawn)
    completed.tokenId = "token-loop-completed-before-cancel"
    completed.status = "consumed"
    completed.consumedAt = "2026-07-23T10:00:03.200Z"
    cancelled.tokens.push(completed)
    withdrawn.tokenId = "token-loop-cancelled-iteration"
    if (withdrawn.invocation.branch?._tag !== "StandardLoopIteration") {
      throw new Error("missing standard loop branch")
    }
    withdrawn.invocation.branch.iteration = 1
    withdrawn.status = "withdrawn"
    withdrawn.createdAt = "2026-07-23T10:00:03.300Z"
    withdrawn.consumedAt = "2026-07-23T10:00:04.000Z"
    cancelledFrame.completedIterations = 1
    delete cancelledFrame.activeIteration
    cancelledFrame.status = "cancelled"
    cancelledFrame.closedAt = withdrawn.consumedAt

    assert(Result.isSuccess(BpmnExecutionState.validate(model(), cancelled)))
  })

  it("admits exact parallel, sequential, and completion-condition multi-instance state", () => {
    assert(Result.isSuccess(BpmnExecutionState.validate(model(), state())))

    const sequential = sequentialMultiInstanceFixture()
    assert(Result.isSuccess(BpmnExecutionState.validate(sequential.model, sequential.state)))

    const sequentialCondition = sequentialMultiInstanceFixture()
    const sequentialGroup = sequentialCondition.state.multiInstanceGroups[0]!
    const sequentialClose = "2026-07-23T10:00:04.000Z"
    const sequentialTrigger = sequentialGroup.members[1]!
    sequentialTrigger.status = "completed"
    sequentialTrigger.endedAt = sequentialClose
    const sequentialTriggerToken = sequentialCondition.state.tokens.find((token) =>
      token.tokenId === sequentialTrigger.tokenId
    )!
    sequentialTriggerToken.status = "consumed"
    sequentialTriggerToken.consumedAt = sequentialClose
    const sequentialTail = sequentialGroup.members[2]!
    sequentialTail.status = "not-generated"
    sequentialTail.nonGenerationReason = "completion-condition"
    sequentialGroup.completedInstanceCount = 2
    sequentialGroup.status = "completed"
    sequentialGroup.completionReason = "completion-condition"
    sequentialGroup.closedAt = sequentialClose
    assert(Result.isSuccess(
      BpmnExecutionState.validate(sequentialCondition.model, sequentialCondition.state)
    ))

    const collectionModel = model()
    const collectionActivity = collectionModel.flowNodes.find((node) => node.id === "task-review")
    if (
      collectionActivity?._tag !== "Task" ||
      collectionActivity.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
    ) {
      throw new Error("missing multi-instance task fixture")
    }
    delete collectionActivity.loopCharacteristics.cardinality
    collectionActivity.loopCharacteristics.loopDataInputRef = "review-items"
    const collectionState = state()
    collectionState.multiInstanceGroups[0]!.source = {
      _tag: "Collection",
      dataInputRef: "review-items",
      items: [{ documentId: "doc-1" }, { documentId: "doc-2" }, { documentId: "doc-3" }]
    }
    assert(Result.isSuccess(BpmnExecutionState.validate(collectionModel, collectionState)))

    assert(Result.isSuccess(
      BpmnExecutionState.validate(model(), completedByConditionMultiInstanceState())
    ))
  })

  it("admits input-order aggregate output for an all-completed collection group", () => {
    const fixture = completedCollectionMultiInstanceFixture()
    const result = BpmnExecutionState.validate(fixture.model, fixture.state)
    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
    const group = result.success.multiInstanceGroups[0]!
    assert.deepStrictEqual(
      group.output?.items,
      group.members.map((member) => member.output)
    )
    assert.isTrue(Object.isFrozen(group.output))
    assert.isTrue(Object.isFrozen(group.output?.items))
    assert.isTrue(Object.isFrozen(group.members[0]!.output))
  })

  it("rejects member output before completion and incoherent aggregate output", () => {
    const activeMemberOutput = state()
    activeMemberOutput.multiInstanceGroups[0]!.members[1]!.output = {
      accepted: true
    }
    assertDiagnostic(
      BpmnExecutionState.validate(model(), activeMemberOutput),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/members/1/output",
        message: "Only a completed"
      }
    )

    const wrongSource = completedCollectionMultiInstanceFixture()
    wrongSource.state.multiInstanceGroups[0]!.source = {
      _tag: "Cardinality",
      value: 3
    }
    assertDiagnostic(
      BpmnExecutionState.validate(wrongSource.model, wrongSource.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/output",
        message: "requires a collection source"
      }
    )

    const wrongStatus = completedCollectionMultiInstanceFixture()
    const wrongStatusGroup = wrongStatus.state.multiInstanceGroups[0]!
    wrongStatusGroup.status = "cancelled"
    wrongStatusGroup.completionReason = "execution-cancelled"
    assertDiagnostic(
      BpmnExecutionState.validate(wrongStatus.model, wrongStatus.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/output",
        message: "only after all members completed"
      }
    )

    const wrongReference = completedCollectionMultiInstanceFixture()
    wrongReference.state.multiInstanceGroups[0]!.output!.dataOutputRef = "other-results"
    assertDiagnostic(
      BpmnExecutionState.validate(wrongReference.model, wrongReference.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/output/dataOutputRef",
        message: "exactly match"
      }
    )

    const wrongLength = completedCollectionMultiInstanceFixture()
    wrongLength.state.multiInstanceGroups[0]!.output!.items.pop()
    assertDiagnostic(
      BpmnExecutionState.validate(wrongLength.model, wrongLength.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/output/items",
        message: "length must equal"
      }
    )

    const missingMemberOutput = completedCollectionMultiInstanceFixture()
    delete missingMemberOutput.state.multiInstanceGroups[0]!.members[1]!.output
    assertDiagnostic(
      BpmnExecutionState.validate(missingMemberOutput.model, missingMemberOutput.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/members/1/output",
        message: "requires completed member"
      }
    )

    const mismatchedItem = completedCollectionMultiInstanceFixture()
    mismatchedItem.state.multiInstanceGroups[0]!.output!.items[1] = {
      accepted: true,
      ordinal: 1
    }
    assertDiagnostic(
      BpmnExecutionState.validate(mismatchedItem.model, mismatchedItem.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/output/items/1",
        message: "exactly equal"
      }
    )
  })

  it("rejects sparse aggregate output before semantic validation", () => {
    const fixture = completedCollectionMultiInstanceFixture()
    const sparse = new Array<Schema.Json>(3)
    sparse[0] = fixture.state.multiInstanceGroups[0]!.members[0]!.output!
    sparse[2] = fixture.state.multiInstanceGroups[0]!.members[2]!.output!
    fixture.state.multiInstanceGroups[0]!.output!.items = sparse
    assertDiagnostic(
      BpmnExecutionState.validate(fixture.model, fixture.state),
      BpmnExecutionState.Codes.InvalidJson,
      {
        path: "multiInstanceGroups/0/output/items",
        message: "dense"
      }
    )
  })

  it("rejects corrupt multi-instance source, ordering, counts, lifecycle, and activation authority", () => {
    const wrongSourceCount = state()
    const wrongSource = wrongSourceCount.multiInstanceGroups[0]!.source
    if (wrongSource._tag !== "Cardinality") {
      throw new Error("missing cardinality fixture")
    }
    wrongSource.value = 4
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongSourceCount),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members", message: "source count" }
    )

    const duplicateKey = state()
    duplicateKey.multiInstanceGroups[0]!.members[2]!.itemKey = "review-1"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), duplicateKey),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members/2/itemKey", message: "duplicate itemKey" }
    )

    const nonContiguous = state()
    nonContiguous.multiInstanceGroups[0]!.members[1]!.index = 2
    assertDiagnostic(
      BpmnExecutionState.validate(model(), nonContiguous),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members/1/index", message: "ordered position" }
    )

    const wrongCompletedCount = state()
    wrongCompletedCount.multiInstanceGroups[0]!.completedInstanceCount = 2
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongCompletedCount),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/completedInstanceCount", message: "exact completed member count" }
    )

    const malformedLifecycle = state()
    malformedLifecycle.multiInstanceGroups[0]!.members[1]!.endedAt = "2026-07-23T10:00:04.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), malformedLifecycle),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members/1", message: "startedAt only" }
    )

    const duplicateActivation = state()
    const duplicateGroup = structuredClone(duplicateActivation.multiInstanceGroups[0]!)
    duplicateGroup.groupId = "group-review-duplicate"
    duplicateGroup.status = "completed"
    duplicateGroup.completionReason = "all-completed"
    duplicateGroup.closedAt = "2026-07-23T10:00:04.000Z"
    for (const member of duplicateGroup.members) {
      member.status = "completed"
      member.endedAt ??= duplicateGroup.closedAt
    }
    duplicateGroup.completedInstanceCount = duplicateGroup.members.length
    duplicateActivation.multiInstanceGroups.push(duplicateGroup)
    assertDiagnostic(
      BpmnExecutionState.validate(model(), duplicateActivation),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/1/activation", message: "more than one group for activation" }
    )
  })

  it("enforces multi-instance token authority and terminal reasons fail-closed", () => {
    const forgedBranch = state()
    const forgedToken = forgedBranch.tokens.find((token) => token.tokenId === "token-review-1")!
    if (forgedToken.invocation.branch?._tag !== "MultiInstanceItem") {
      throw new Error("missing multi-instance token branch")
    }
    forgedToken.invocation.branch.itemKey = "forged-item"
    const forgedResult = BpmnExecutionState.validate(model(), forgedBranch)
    assertDiagnostic(
      forgedResult,
      BpmnExecutionState.Codes.InvalidTokenInvocation,
      { path: "tokens/3/invocation/branch", message: "exact member" }
    )
    assertDiagnostic(
      forgedResult,
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members/1/tokenId", message: "exact group, index, and itemKey" }
    )

    const missingToken = state()
    missingToken.tokens = missingToken.tokens.filter((token) => token.tokenId !== "token-review-2")
    assertDiagnostic(
      BpmnExecutionState.validate(model(), missingToken),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members/2/tokenId", message: "unknown token" }
    )

    const sequential = sequentialMultiInstanceFixture()
    sequential.state.multiInstanceGroups[0]!.members[0]!.status = "active"
    assertDiagnostic(
      BpmnExecutionState.validate(sequential.model, sequential.state),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      { path: "multiInstanceGroups/0/members", message: "exactly one active" }
    )

    const wrongReason = completedByConditionMultiInstanceState()
    wrongReason.multiInstanceGroups[0]!.members[1]!.terminationReason = "execution-cancelled"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongReason),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/members/1/terminationReason",
        message: "reason must match"
      }
    )

    const unactivatedParallelMember = completedByConditionMultiInstanceState()
    const parallelMember = unactivatedParallelMember.multiInstanceGroups[0]!.members[2]!
    unactivatedParallelMember.tokens = unactivatedParallelMember.tokens.filter((token) =>
      token.tokenId !== parallelMember.tokenId
    )
    delete parallelMember.tokenId
    delete parallelMember.startedAt
    delete parallelMember.endedAt
    assertDiagnostic(
      BpmnExecutionState.validate(model(), unactivatedParallelMember),
      BpmnExecutionState.Codes.InvalidMultiInstanceGroup,
      {
        path: "multiInstanceGroups/0/members/2",
        message: "complete activated token lifecycle"
      }
    )
  })

  it("uses a strict discriminated invocation branch union", () => {
    const decodeInvocation = Schema.decodeUnknownSync(BpmnExecutionState.InvocationIdentity)

    assert.throws(() =>
      decodeInvocation({
        activationId: "activation-1",
        branchId: "frame-loop",
        loopIteration: 0,
        generation: 1
      })
    )
    assert.throws(() =>
      decodeInvocation({
        activationId: "activation-1",
        branch: {
          _tag: "StandardLoopIteration",
          frameId: "frame-loop",
          iteration: 0,
          itemKey: "forbidden"
        },
        generation: 1
      })
    )
    assert.throws(() =>
      decodeInvocation({
        activationId: "activation-1",
        branch: {
          _tag: "MultiInstanceItem",
          groupId: "group-review",
          itemKey: "review-0"
        },
        generation: 1
      })
    )
  })

  it("cross-validates consumed and withdrawn standard-loop token history", () => {
    const impossibleCompletedIteration = completedStandardLoopState()
    const impossibleBranch = impossibleCompletedIteration.tokens[6]!.invocation.branch
    if (impossibleBranch?._tag !== "StandardLoopIteration") {
      throw new Error("missing standard loop history branch")
    }
    impossibleBranch.iteration = 3
    assertDiagnostic(
      BpmnExecutionState.validate(model(), impossibleCompletedIteration),
      BpmnExecutionState.Codes.InvalidTokenInvocation,
      {
        path: "tokens/6/invocation/branch/iteration",
        message: "iteration completed"
      }
    )

    const lateHistory = completedStandardLoopState()
    lateHistory.tokens[4]!.consumedAt = "2026-07-23T10:00:05.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), lateHistory),
      BpmnExecutionState.Codes.InvalidTokenInvocation,
      {
        path: "tokens/4/consumedAt",
        message: "after frame"
      }
    )

    const earlyHistory = completedStandardLoopState()
    earlyHistory.tokens[4]!.createdAt = "2026-07-23T10:00:01.500Z"
    earlyHistory.tokens[4]!.consumedAt = "2026-07-23T10:00:01.600Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), earlyHistory),
      BpmnExecutionState.Codes.InvalidTokenInvocation,
      {
        path: "tokens/4/createdAt",
        message: "before frame"
      }
    )

    const withdrawnWithoutCancellation = completedStandardLoopState()
    withdrawnWithoutCancellation.tokens[6]!.status = "withdrawn"
    const withdrawnBranch = withdrawnWithoutCancellation.tokens[6]!.invocation.branch
    if (withdrawnBranch?._tag !== "StandardLoopIteration") {
      throw new Error("missing standard loop history branch")
    }
    withdrawnBranch.iteration = 3
    assertDiagnostic(
      BpmnExecutionState.validate(model(), withdrawnWithoutCancellation),
      BpmnExecutionState.Codes.InvalidTokenInvocation,
      {
        path: "tokens/6/status",
        message: "requires cancelled"
      }
    )

    const wrongCancelledIteration = completedStandardLoopState()
    wrongCancelledIteration.loopFrames[0]!.status = "cancelled"
    wrongCancelledIteration.tokens[6]!.status = "withdrawn"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongCancelledIteration),
      BpmnExecutionState.Codes.InvalidTokenInvocation,
      {
        path: "tokens/6/invocation/branch/iteration",
        message: "iteration cancelled"
      }
    )
  })

  it("rejects duplicate standard-loop activation authority", () => {
    const duplicate = state()
    duplicate.loopFrames.push({
      frameId: "frame-loop-duplicate",
      activityId: "activity-pack",
      processId: "process-main",
      scopeInstanceId: "scope-sub-pack",
      activation: 0,
      completedIterations: 1,
      status: "completed",
      openedAt: "2026-07-23T10:00:02.000Z",
      closedAt: "2026-07-23T10:00:04.000Z"
    })

    assertDiagnostic(
      BpmnExecutionState.validate(model(), duplicate),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/1/activation",
        message: "more than one frame for activation"
      }
    )
  })

  it("rejects loop frames with incoherent process, scope, or activity ownership", () => {
    const wrongProcess = state()
    wrongProcess.loopFrames[0]!.processId = "process-child"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongProcess),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/processId",
        message: "does not match activity process"
      }
    )

    const wrongScope = state()
    wrongScope.loopFrames[0]!.scopeInstanceId = "scope-root"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongScope),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/scopeInstanceId",
        message: "does not own activity"
      }
    )

    const wrongOwner = state()
    wrongOwner.loopFrames[0]!.activityId = "sub-pack"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), wrongOwner),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/scopeInstanceId",
        message: "does not own activity"
      }
    )
  })

  it("enforces loop-frame timestamps and active versus terminal status fields", () => {
    const beforeExecution = state()
    beforeExecution.loopFrames[0]!.openedAt = "2026-07-23T09:59:59.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), beforeExecution),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/openedAt", message: "execution started" }
    )

    const beforeScope = state()
    beforeScope.loopFrames[0]!.openedAt = "2026-07-23T10:00:00.500Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), beforeScope),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/openedAt", message: "scope instance entered" }
    )

    const missingActiveIteration = state()
    delete missingActiveIteration.loopFrames[0]!.activeIteration
    assertDiagnostic(
      BpmnExecutionState.validate(model(), missingActiveIteration),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/activeIteration", message: "must record activeIteration" }
    )

    const mismatchedActiveIteration = state()
    mismatchedActiveIteration.loopFrames[0]!.activeIteration = 1
    assertDiagnostic(
      BpmnExecutionState.validate(model(), mismatchedActiveIteration),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/activeIteration", message: "must equal completedIterations" }
    )

    const closedWhileActive = state()
    closedWhileActive.loopFrames[0]!.closedAt = "2026-07-23T10:00:04.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), closedWhileActive),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/closedAt", message: "cannot record closedAt" }
    )

    const activeInTerminalScope = state()
    activeInTerminalScope.scopeInstances[1]!.status = "completed"
    activeInTerminalScope.scopeInstances[1]!.exitedAt = "2026-07-23T10:00:05.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), activeInTerminalScope),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/scopeInstanceId", message: "terminal scope" }
    )

    const terminalWithoutClose = state()
    terminalWithoutClose.tokens = terminalWithoutClose.tokens.filter((token) =>
      token.invocation.branch?._tag !== "StandardLoopIteration" ||
      token.invocation.branch.frameId !== "frame-loop"
    )
    terminalWithoutClose.loopFrames[0]!.status = "completed"
    delete terminalWithoutClose.loopFrames[0]!.activeIteration
    assertDiagnostic(
      BpmnExecutionState.validate(model(), terminalWithoutClose),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/closedAt", message: "must record closedAt" }
    )

    const terminalWithActiveIteration = structuredClone(terminalWithoutClose)
    terminalWithActiveIteration.loopFrames[0]!.activeIteration = 0
    terminalWithActiveIteration.loopFrames[0]!.closedAt = "2026-07-23T10:00:04.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), terminalWithActiveIteration),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/activeIteration", message: "cannot record activeIteration" }
    )

    const terminalBeforeOpen = structuredClone(terminalWithoutClose)
    terminalBeforeOpen.loopFrames[0]!.status = "cancelled"
    terminalBeforeOpen.loopFrames[0]!.closedAt = "2026-07-23T10:00:01.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), terminalBeforeOpen),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/closedAt", message: "closed before it opened" }
    )

    const afterTerminalScope = structuredClone(terminalWithoutClose)
    afterTerminalScope.scopeInstances[1]!.status = "completed"
    afterTerminalScope.scopeInstances[1]!.exitedAt = "2026-07-23T10:00:04.000Z"
    afterTerminalScope.loopFrames[0]!.closedAt = "2026-07-23T10:00:05.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), afterTerminalScope),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/closedAt", message: "scope instance exited" }
    )

    const openedAfterTerminalScope = structuredClone(terminalWithoutClose)
    openedAfterTerminalScope.scopeInstances[1]!.status = "completed"
    openedAfterTerminalScope.scopeInstances[1]!.exitedAt = "2026-07-23T10:00:01.500Z"
    openedAfterTerminalScope.loopFrames[0]!.closedAt = "2026-07-23T10:00:02.500Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), openedAfterTerminalScope),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/openedAt", message: "scope instance exited" }
    )
  })

  it("enforces the Standard Loop loopMaximum boundary", () => {
    const tooManyCompleted = state()
    tooManyCompleted.tokens = tooManyCompleted.tokens.filter((token) =>
      token.invocation.branch?._tag !== "StandardLoopIteration" ||
      token.invocation.branch.frameId !== "frame-loop"
    )
    tooManyCompleted.loopFrames[0]!.completedIterations = 4
    delete tooManyCompleted.loopFrames[0]!.activeIteration
    tooManyCompleted.loopFrames[0]!.status = "completed"
    tooManyCompleted.loopFrames[0]!.closedAt = "2026-07-23T10:00:04.000Z"
    assertDiagnostic(
      BpmnExecutionState.validate(model(), tooManyCompleted),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/completedIterations",
        message: "cannot exceed loopMaximum"
      }
    )

    const noRemainingIteration = state()
    noRemainingIteration.loopFrames[0]!.completedIterations = 3
    noRemainingIteration.loopFrames[0]!.activeIteration = 3
    assertDiagnostic(
      BpmnExecutionState.validate(model(), noRemainingIteration),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/activeIteration",
        message: "less than loopMaximum"
      }
    )
  })

  it("requires exactly one active AtNode token for an active standard loop frame", () => {
    const missing = state()
    missing.tokens = missing.tokens.filter((token) =>
      token.invocation.branch?._tag !== "StandardLoopIteration" ||
      token.invocation.branch.frameId !== "frame-loop"
    )
    assertDiagnostic(
      BpmnExecutionState.validate(model(), missing),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/frameId",
        message: "exactly one active AtNode token"
      }
    )

    const duplicated = state()
    const duplicateToken = structuredClone(duplicated.tokens[1]!)
    duplicateToken.tokenId = "token-loop-duplicate"
    duplicated.tokens.push(duplicateToken)
    assertDiagnostic(
      BpmnExecutionState.validate(model(), duplicated),
      BpmnExecutionState.Codes.InvalidLoopFrame,
      {
        path: "loopFrames/0/frameId",
        message: "exactly one active AtNode token"
      }
    )
  })

  it("rejects a forged token claiming a standard-loop frame invocation", () => {
    const forged = state()
    const loopToken = forged.tokens[1]!
    loopToken.processId = "process-child"
    loopToken.scopeInstanceId = "scope-root"
    loopToken.invocation.activationId = "activation-forged"
    if (loopToken.invocation.branch?._tag !== "StandardLoopIteration") {
      throw new Error("missing standard loop branch")
    }
    loopToken.invocation.branch.iteration = 1
    loopToken.invocation.generation = 2
    loopToken.status = "consumed"
    loopToken.position = { _tag: "AtNode", nodeId: "gateway-main" }
    loopToken.consumedAt = "2026-07-23T10:00:04.000Z"

    const result = BpmnExecutionState.validate(model(), forged)
    for (
      const path of [
        "tokens/1/processId",
        "tokens/1/scopeInstanceId",
        "tokens/1/position",
        "tokens/1/invocation/branch/iteration",
        "tokens/1/invocation/activationId",
        "tokens/1/invocation/generation"
      ]
    ) {
      assertDiagnostic(
        result,
        BpmnExecutionState.Codes.InvalidTokenInvocation,
        { path }
      )
    }
    assertDiagnostic(
      result,
      BpmnExecutionState.Codes.InvalidLoopFrame,
      { path: "loopFrames/0/frameId" }
    )
  })

  it("admits one exact active-window Message catch subscription", () => {
    const valid = BpmnExecutionState.validate(
      messageWaitModel(),
      waitingMessageState()
    )
    assert.isTrue(Result.isSuccess(valid))

    const invalid = waitingMessageState()
    invalid.catchWaitGroups[0]!.armIds = ["missing-arm"]
    assertDiagnostic(
      BpmnExecutionState.validate(messageWaitModel(), invalid),
      BpmnExecutionState.Codes.InvalidCatchWaitGroup,
      { path: "catchWaitGroups/0/armIds" }
    )
  })

  it("retains the exact trusted receipt only on the winning Message arm", () => {
    const valid = BpmnExecutionState.validate(
      messageWaitModel(),
      wonMessageState()
    )
    assert.isTrue(Result.isSuccess(valid))

    const wrongCorrelation = wonMessageState()
    const arm = wrongCorrelation.subscriptions[0]
    if (arm?._tag !== "MessageCatchSubscription" || arm.receipt === undefined) {
      throw new Error("missing winning Message arm fixture")
    }
    arm.receipt.correlationKey = ["tenant-1", "different-review"]
    assertDiagnostic(
      BpmnExecutionState.validate(messageWaitModel(), wrongCorrelation),
      BpmnExecutionState.Codes.InvalidSubscription,
      { path: "subscriptions/0/receipt" }
    )
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
        completedActivityDigest: operationDigest,
        output: {
          _tag: "Inline",
          value: { accepted: true }
        }
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
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnExecutionState.LoopFrame)({
        ...state().loopFrames[0],
        iteration: 0
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
      activation: 0,
      completedIterations: 0,
      activeIteration: 0,
      status: "active",
      openedAt: "2026-07-23T10:00:03.000Z"
    })
    invalidState.multiInstanceGroups.push({
      groupId: "group-bad",
      activityId: "sub-pack",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      activation: 0,
      mode: "parallel",
      source: { _tag: "Cardinality", value: 0 },
      members: [],
      completedInstanceCount: 0,
      status: "completed",
      completionReason: "empty",
      openedAt: "2026-07-23T10:00:03.000Z",
      closedAt: "2026-07-23T10:00:03.000Z"
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
    invalidState.catchWaitGroups.push({
      waitGroupId: "wait-bad",
      source: {
        _tag: "StandaloneCatch",
        catchEventNodeId: "task-review"
      },
      ownerTokenId: "token-main",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      generation: 1,
      armIds: ["subscription-bad"],
      status: "waiting",
      openedAt: "2026-07-23T10:00:03.000Z"
    })
    invalidState.subscriptions.push({
      _tag: "MessageCatchSubscription",
      armId: "subscription-bad",
      waitGroupId: "wait-bad",
      ownerNodeId: "task-review",
      processId: "process-main",
      scopeInstanceId: "scope-root",
      tokenId: "token-main",
      generation: 1,
      ordinal: 0,
      status: "waiting",
      openedAt: "2026-07-23T10:00:03.000Z",
      messageRef: "message-review",
      correlationKey: ["case-1"]
    })
    invalidState.timers.push({
      timerId: "timer-bad",
      armId: "missing-timer-arm",
      waitGroupId: "wait-bad",
      processId: "process-main",
      scopeInstanceId: "missing-scope",
      tokenId: "token-main",
      generation: 1,
      schedule: {
        _tag: "TimeDuration",
        lexicalVersion: 1,
        lexical: "PT5M",
        delayMillis: 300_000,
        dueAt: "2026-07-23T10:05:00.000Z"
      },
      scheduledAt: "2026-07-23T10:00:00.000Z",
      status: "scheduled"
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
