import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnModel from "../src/BpmnModel.ts"

const emptyExtensions = (): Array<BpmnModel.ExtensionElement> => []

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const validModel = (): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [{
    importId: "imp-1",
    sourceKind: "manual",
    locator: "catalog://orders",
    importedAt: "2026-07-23T10:00:00.000Z",
    sourceVersion: "1",
    lossReport: { approximated: [] }
  }],
  extensionElements: [{
    namespaceUri: "urn:effect:test",
    localName: "metadata",
    content: JSON.parse("{\"__proto__\":{\"polluted\":true},\"toString\":\"safe\"}")
  }],
  messages: [
    { id: "msg-order-created", name: "OrderCreated" },
    { id: "msg-ack", name: "Ack" }
  ],
  signals: [
    { id: "sig-ack", name: "AckSignal" }
  ],
  errors: [
    { id: "err-validation", name: "ValidationError", errorCode: "ORDER_400" }
  ],
  escalations: [
    { id: "esc-ops", name: "OpsEscalation", escalationCode: "OPS_1" }
  ],
  eventDefinitions: [{
    _tag: "TimerEventDefinition",
    id: "evt-timeout-start",
    timeDuration: expression("PT5M")
  }],
  collaborations: [{
    id: "collab-orders",
    name: "Orders",
    isClosed: false,
    participants: [
      {
        id: "participant-orders",
        name: "OrderProcess",
        processId: "process-orders",
        participantMultiplicity: {
          minimum: 1,
          maximum: 2
        }
      },
      {
        id: "participant-customer",
        name: "Customer"
      }
    ],
    messageFlows: [{
      id: "message-start-order",
      name: "Submit Order",
      sourceRef: "participant-customer",
      targetRef: "start-main",
      messageRef: "msg-order-created",
      extensionElements: emptyExtensions()
    }],
    extensionElements: emptyExtensions()
  }],
  processes: [{
    id: "process-orders",
    name: "Orders",
    processType: "private",
    isClosed: false,
    isExecutable: true,
    extensionElements: emptyExtensions()
  }],
  flowNodes: [
    {
      _tag: "StartEvent",
      id: "start-main",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Start",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-start-gateway"],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "Gateway",
      id: "gateway-race",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Wait First",
      incomingSequenceFlowIds: ["flow-start-gateway"],
      outgoingSequenceFlowIds: ["flow-gateway-receive", "flow-gateway-signal"],
      gatewayKind: "event-based",
      gatewayDirection: "diverging",
      eventGatewayType: "exclusive",
      extensionElements: emptyExtensions()
    },
    {
      _tag: "Task",
      id: "task-receive",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Receive Ack",
      taskKind: "receive",
      messageRef: "msg-ack",
      incomingSequenceFlowIds: ["flow-gateway-receive"],
      outgoingSequenceFlowIds: ["flow-receive-end"],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "IntermediateCatchEvent",
      id: "catch-signal",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Catch Signal",
      incomingSequenceFlowIds: ["flow-gateway-signal"],
      outgoingSequenceFlowIds: ["flow-signal-end"],
      eventDefinitions: [{ _tag: "SignalEventDefinition", signalRef: "sig-ack" }],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "BoundaryEvent",
      id: "boundary-timeout",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Timeout",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-boundary-timeout"],
      attachedToRef: "task-receive",
      cancelActivity: true,
      eventDefinitions: [{ _tag: "TimerEventDefinition", timeDuration: expression("PT1M") }],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "EndEvent",
      id: "end-main",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Complete",
      incomingSequenceFlowIds: ["flow-receive-end", "flow-signal-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "EndEvent",
      id: "end-timeout",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Escalate",
      incomingSequenceFlowIds: ["flow-boundary-timeout"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [{ _tag: "EscalationEventDefinition", escalationRef: "esc-ops" }],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "EventSubProcess",
      id: "esp-timeout",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Timeout Monitor",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "StartEvent",
      id: "start-timeout",
      processId: "process-orders",
      parentScopeId: "esp-timeout",
      name: "Timeout Start",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-esp-end"],
      eventDefinitions: [],
      eventDefinitionRefs: ["evt-timeout-start"],
      isInterrupting: true,
      extensionElements: emptyExtensions()
    },
    {
      _tag: "EndEvent",
      id: "end-esp",
      processId: "process-orders",
      parentScopeId: "esp-timeout",
      name: "Abort",
      incomingSequenceFlowIds: ["flow-esp-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [{ _tag: "TerminateEventDefinition" }],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "Transaction",
      id: "transaction-charge",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Charge",
      method: "##Compensate",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "AdHocSubProcess",
      id: "adhoc-pack",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Pack Items",
      ordering: "parallel",
      loopCharacteristics: {
        _tag: "StandardLoopCharacteristics",
        testBefore: false
      },
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      extensionElements: emptyExtensions()
    },
    {
      _tag: "CallActivity",
      id: "call-fulfillment",
      processId: "process-orders",
      parentScopeId: "process-orders",
      name: "Fulfill",
      loopCharacteristics: {
        _tag: "MultiInstanceCharacteristics",
        mode: "parallel"
      },
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      extensionElements: emptyExtensions()
    }
  ],
  sequenceFlows: [
    {
      id: "flow-start-gateway",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "start-main",
      targetId: "gateway-race",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    },
    {
      id: "flow-gateway-receive",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "gateway-race",
      targetId: "task-receive",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    },
    {
      id: "flow-gateway-signal",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "gateway-race",
      targetId: "catch-signal",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    },
    {
      id: "flow-receive-end",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "task-receive",
      targetId: "end-main",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    },
    {
      id: "flow-signal-end",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "catch-signal",
      targetId: "end-main",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    },
    {
      id: "flow-boundary-timeout",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "boundary-timeout",
      targetId: "end-timeout",
      kind: "normal",
      isImmediate: false,
      extensionElements: emptyExtensions()
    },
    {
      id: "flow-esp-end",
      processId: "process-orders",
      parentScopeId: "esp-timeout",
      sourceId: "start-timeout",
      targetId: "end-esp",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    }
  ]
})

describe("BpmnModel", () => {
  it("admits a strict BPMN semantic document with collaborations, reusable event definitions, boundary events, and event subprocesses", () => {
    const model = validModel()
    const decode = Schema.decodeUnknownSync(BpmnModel.BpmnModel)
    const decoded = decode(model)
    const validated = BpmnModel.validate(model)

    assert.deepStrictEqual(decoded, model)
    assert.isTrue(Result.isSuccess(validated))
    if (Result.isFailure(validated)) {
      throw validated.failure
    }
    assert.isTrue(Object.isFrozen(validated.success))
    assert.isTrue(Object.isFrozen(validated.success.flowNodes))
    assert.isTrue(Object.isFrozen(validated.success.flowNodes[0]))

    const content = validated.success.extensionElements[0]!.content as Readonly<Record<string, unknown>>
    assert.deepStrictEqual(content["__proto__"], { polluted: true })
    assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
  })

  it("rejects hostile inspection through validate without invoking accessors", () => {
    let getterCalls = 0
    const input = { modelKind: "BpmnModel" } as Record<string, unknown>
    Object.defineProperty(input, "modelVersion", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 1
      }
    })

    const result = BpmnModel.validate(input)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    assert.strictEqual(getterCalls, 0)
    assert.strictEqual(result.failure.diagnostics[0]!.code, BpmnModel.Codes.InvalidJson)
  })

  it("strictly rejects excess properties at the schema boundary", () => {
    const decode = Schema.decodeUnknownSync(BpmnModel.BpmnModel)
    const model = validModel() as Record<string, unknown>
    model["extra"] = true

    assert.throws(() => decode(model))
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnModel.FlowNode)({
        _tag: "BoundaryEvent",
        ...validModel().flowNodes.find((node) => node.id === "boundary-timeout"),
        extra: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnModel.SequenceFlow)({
        ...validModel().sequenceFlows[0],
        extra: true
      })
    )
  })

  it("validates normalized call-activity QNames at the semantic-model boundary", () => {
    const withCalledElement = (
      calledElement: BpmnModel.ExpandedQName
    ): BpmnModel.BpmnModel => {
      const model = validModel()
      return {
        ...model,
        flowNodes: model.flowNodes.map((node) =>
          node._tag === "CallActivity"
            ? { ...node, calledElement }
            : node
        )
      }
    }

    assert.isTrue(Result.isSuccess(BpmnModel.validate(withCalledElement({
      namespaceUri: "",
      localName: "child_process"
    }))))

    const invalid = BpmnModel.validate(withCalledElement({
      namespaceUri: " urn:workflow:child ",
      localName: "bad:child"
    }))
    assert.isTrue(Result.isFailure(invalid))
    if (Result.isSuccess(invalid)) {
      throw new Error("expected invalid call-activity QName")
    }
    assert.deepStrictEqual(
      invalid.failure.diagnostics.map((diagnostic) => diagnostic.code),
      [
        BpmnModel.Codes.InvalidCallActivity,
        BpmnModel.Codes.InvalidCallActivity
      ]
    )
  })

  it("aggregates participant, collaboration, boundary-event, event-subprocess, event-gateway, and sequence-scope diagnostics", () => {
    const model = validModel()
    const collaboration = model.collaborations[0]!
    const participant = collaboration.participants[0]!
    const messageFlow = collaboration.messageFlows![0]!
    const boundary = model.flowNodes.find((node) => node.id === "boundary-timeout")
    const task = model.flowNodes.find((node) => node.id === "task-receive")
    const espStart = model.flowNodes.find((node) => node.id === "start-timeout")
    const gateway = model.flowNodes.find((node) => node.id === "gateway-race")
    const startMain = model.flowNodes.find((node) => node.id === "start-main")
    const topFlow = model.sequenceFlows.find((flow) => flow.id === "flow-start-gateway")
    if (
      boundary === undefined || boundary._tag !== "BoundaryEvent" ||
      task === undefined || task._tag !== "Task" ||
      espStart === undefined || espStart._tag !== "StartEvent" ||
      gateway === undefined || gateway._tag !== "Gateway" ||
      startMain === undefined || startMain._tag !== "StartEvent" ||
      topFlow === undefined
    ) {
      throw new Error("expected seeded BPMN fixtures")
    }

    participant.participantMultiplicity = { minimum: 2, maximum: 1 }
    messageFlow.messageRef = "msg-missing"
    boundary.attachedToRef = "gateway-race"
    boundary.incomingSequenceFlowIds = ["flow-start-gateway"]
    boundary.eventDefinitions = [{ _tag: "CancelEventDefinition" }]
    espStart.eventDefinitionRefs = []
    model.flowNodes.push({
      _tag: "StartEvent",
      id: "start-timeout-duplicate",
      processId: "process-orders",
      parentScopeId: "esp-timeout",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [{ _tag: "SignalEventDefinition", signalRef: "sig-ack" }],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    })
    task.taskKind = "manual"
    task.incomingSequenceFlowIds.push("flow-extra-receive")
    startMain.outgoingSequenceFlowIds.push("flow-extra-receive")
    startMain.outgoingSequenceFlowIds.push("flow-extra-receive")
    model.sequenceFlows.push({
      id: "flow-extra-receive",
      processId: "process-orders",
      parentScopeId: "process-orders",
      sourceId: "start-main",
      targetId: "task-receive",
      kind: "normal",
      isImmediate: true,
      extensionElements: emptyExtensions()
    })
    topFlow.parentScopeId = "esp-timeout"

    const result = BpmnModel.validate(model)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    assert.deepStrictEqual(
      new Set(result.failure.diagnostics.map((diagnostic) => diagnostic.code)),
      new Set([
        BpmnModel.Codes.InvalidParticipant,
        BpmnModel.Codes.UnknownMessageRef,
        BpmnModel.Codes.InvalidBoundaryEvent,
        BpmnModel.Codes.InvalidEvent,
        BpmnModel.Codes.InvalidGateway,
        BpmnModel.Codes.InvalidTask,
        BpmnModel.Codes.InvalidSequenceFlow,
        BpmnModel.Codes.InvalidSequenceFlowRef
      ])
    )
  })

  it("accepts optional standard-loop conditions and multi-instance cardinality or collection absence", () => {
    const result = BpmnModel.validate(validModel())

    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
  })

  it("rejects invalid timer definitions, non-transaction cancel ends, and root error starts", () => {
    const model = validModel()
    const boundary = model.flowNodes.find((node) => node.id === "boundary-timeout")
    const start = model.flowNodes.find((node) => node.id === "start-main")
    if (
      boundary === undefined || boundary._tag !== "BoundaryEvent" ||
      start === undefined || start._tag !== "StartEvent"
    ) {
      throw new Error("expected seeded BPMN fixtures")
    }

    boundary.eventDefinitions = [{
      _tag: "TimerEventDefinition",
      timeDate: expression("2026-07-23T10:00:00Z"),
      timeDuration: expression("PT1M")
    }]
    start.eventDefinitions = [{ _tag: "ErrorEventDefinition", errorRef: "err-validation" }]
    model.flowNodes.push({
      _tag: "EndEvent",
      id: "end-cancel-root",
      processId: "process-orders",
      parentScopeId: "process-orders",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [{ _tag: "CancelEventDefinition" }],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    })

    const result = BpmnModel.validate(model)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    assert.deepStrictEqual(
      result.failure.diagnostics.map((diagnostic) => diagnostic.code),
      [
        BpmnModel.Codes.InvalidEvent,
        BpmnModel.Codes.InvalidEvent,
        BpmnModel.Codes.InvalidEvent,
        BpmnModel.Codes.InvalidEvent
      ]
    )
  })

  it("enforces BPMN event-context, boundary-interruption, ad-hoc, and collaboration rules", () => {
    const model = validModel()
    const process = model.processes[0]!
    const messageFlow = model.collaborations[0]!.messageFlows![0]!
    const start = model.flowNodes.find((node) => node.id === "start-main")
    const catchEvent = model.flowNodes.find((node) => node.id === "catch-signal")
    const boundary = model.flowNodes.find((node) => node.id === "boundary-timeout")
    if (
      start === undefined || start._tag !== "StartEvent" ||
      catchEvent === undefined || catchEvent._tag !== "IntermediateCatchEvent" ||
      boundary === undefined || boundary._tag !== "BoundaryEvent"
    ) {
      throw new Error("expected seeded BPMN fixtures")
    }

    process.definitionalCollaborationRef = "collaboration-missing"
    messageFlow.sourceRef = "task-receive"
    start.eventDefinitions = [{ _tag: "EscalationEventDefinition", escalationRef: "esc-ops" }]
    catchEvent.eventDefinitions = [{ _tag: "EscalationEventDefinition", escalationRef: "esc-ops" }]
    boundary.eventDefinitions = [{ _tag: "ErrorEventDefinition", errorRef: "err-validation" }]
    boundary.cancelActivity = false
    model.flowNodes.push({
      _tag: "StartEvent",
      id: "start-inside-adhoc",
      processId: "process-orders",
      parentScopeId: "adhoc-pack",
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-adhoc-start-end"],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    }, {
      _tag: "EndEvent",
      id: "end-inside-adhoc",
      processId: "process-orders",
      parentScopeId: "adhoc-pack",
      incomingSequenceFlowIds: ["flow-adhoc-start-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: emptyExtensions()
    })
    model.sequenceFlows.push({
      id: "flow-adhoc-start-end",
      processId: "process-orders",
      parentScopeId: "adhoc-pack",
      sourceId: "start-inside-adhoc",
      targetId: "end-inside-adhoc",
      kind: "normal",
      extensionElements: emptyExtensions()
    })

    const result = BpmnModel.validate(model)

    assert.isTrue(Result.isFailure(result))
    if (Result.isSuccess(result)) {
      throw new Error("expected validation failure")
    }
    const codes = new Set(result.failure.diagnostics.map((diagnostic) => diagnostic.code))
    assert.isTrue(codes.has(BpmnModel.Codes.InvalidCollaboration))
    assert.isTrue(codes.has(BpmnModel.Codes.InvalidEvent))
    assert.isTrue(codes.has(BpmnModel.Codes.InvalidBoundaryEvent))
  })

  it("models standard message, compensation, link, signal, loop, and optional sequence-flow fields", () => {
    const decodeDefinition = Schema.decodeUnknownSync(BpmnModel.EventDefinition)
    const decodeDeclaredDefinition = Schema.decodeUnknownSync(BpmnModel.DeclaredEventDefinition)
    const decodeSignal = Schema.decodeUnknownSync(BpmnModel.Signal)
    const decodeLoop = Schema.decodeUnknownSync(BpmnModel.LoopCharacteristics)
    const decodeFlow = Schema.decodeUnknownSync(BpmnModel.SequenceFlow)

    assert.deepStrictEqual(
      decodeDefinition({
        _tag: "MessageEventDefinition",
        messageRef: "message-1",
        operationRef: "operation-1"
      }),
      {
        _tag: "MessageEventDefinition",
        messageRef: "message-1",
        operationRef: "operation-1"
      }
    )
    assert.deepStrictEqual(
      decodeDefinition({
        _tag: "CompensationEventDefinition",
        activityRef: "activity-1",
        waitForCompletion: false
      }),
      {
        _tag: "CompensationEventDefinition",
        activityRef: "activity-1",
        waitForCompletion: false
      }
    )
    assert.deepStrictEqual(
      decodeDeclaredDefinition({
        _tag: "LinkEventDefinition",
        id: "link-source",
        name: "continue",
        sourceRefs: ["link-target"]
      }),
      {
        _tag: "LinkEventDefinition",
        id: "link-source",
        name: "continue",
        sourceRefs: ["link-target"]
      }
    )
    assert.deepStrictEqual(
      decodeSignal({
        id: "signal-1",
        structureRef: "item-order"
      }),
      {
        id: "signal-1",
        structureRef: "item-order"
      }
    )
    assert.deepStrictEqual(
      decodeLoop({
        _tag: "StandardLoopCharacteristics",
        testBefore: true,
        loopMaximum: 3
      }),
      {
        _tag: "StandardLoopCharacteristics",
        testBefore: true,
        loopMaximum: 3
      }
    )
    assert.deepStrictEqual(
      decodeFlow({
        id: "flow-1",
        processId: "process-1",
        parentScopeId: "process-1",
        sourceId: "task-1",
        targetId: "task-2",
        kind: "normal",
        extensionElements: []
      }),
      {
        id: "flow-1",
        processId: "process-1",
        parentScopeId: "process-1",
        sourceId: "task-1",
        targetId: "task-2",
        kind: "normal",
        extensionElements: []
      }
    )
  })
})
