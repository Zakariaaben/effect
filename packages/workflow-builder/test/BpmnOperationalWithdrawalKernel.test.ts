import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnEventV3 from "../src/BpmnEventV3.ts"
import type * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as BpmnOperationalV3 from "../src/BpmnOperationalV3.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "operational-withdrawal-process"
const initialTime = "2026-07-24T10:00:00.000Z" as const
const withdrawalTime = "2026-07-24T10:01:00.000Z" as const

const limits: BpmnKernel.KernelLimits = {
  maxAutomaticTransitions: 1_000,
  maxExecutionInputCanonicalBytes: 1_048_576,
  maxExecutionStateCanonicalBytes: 8_388_608,
  maxTransitionJournalEvents: 10_000,
  maxTransitionJournalCanonicalBytes: 16_777_216,
  maxCatchWaitArms: 32,
  maxTimerDelayMillis: 31_536_000_000,
  maxTimerExpressionUtf8Bytes: 4_096,
  maxMessageCorrelationComponents: 16,
  maxMessageCorrelationCanonicalBytes: 16_384,
  maxMessagePayloadCanonicalBytes: 1_048_576,
  maxMultiInstanceCardinality: 32,
  maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
  maxMultiInstanceItemCanonicalBytes: 262_144,
  maxMultiInstanceOutputCanonicalBytes: 1_048_576,
  maxMultiInstanceItemOutputCanonicalBytes: 262_144
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"1".repeat(64)}`)

const messageSchemaDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.SchemaDigest
)(`sha256:${"2".repeat(64)}`)

const messagePolicyBuildDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.BuildDigest
)(`sha256:${"3".repeat(64)}`)

const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"a".repeat(64)}`)

const occurrenceDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OccurrenceDigest
)(`sha256:${"b".repeat(64)}`)

const firstActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"c".repeat(64)}`)

const completedActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"d".repeat(64)}`)

const semanticNodeId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("operational-bound-task")

const evaluatorBinding: BpmnExpression.EvaluatorBinding = {
  language: "feel",
  languageVersion: "1.0",
  build: {
    id: "operational-withdrawal-test-evaluator",
    version: "1.0.0",
    deploymentId: "operational-withdrawal-test-deployment",
    buildDigest: evaluatorBuildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 10_000,
    timeoutMillis: 1_000
  }
}

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const services = (
  now: string,
  evaluations: Readonly<Record<string, unknown>> = {}
): BpmnKernel.Services => ({
  now: Schema.decodeUnknownSync(ProtocolV2Wire.Timestamp)(now),
  evaluateExpression: ({ expression }) =>
    Result.succeed({
      result: evaluations[expression.source],
      steps: 1
    })
})

const start = (
  id: string,
  parentScopeId: string,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.StartEvent => ({
  _tag: "StartEvent",
  id,
  processId,
  parentScopeId,
  incomingSequenceFlowIds: [],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: []
})

const end = (
  id: string,
  parentScopeId: string,
  incomingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.EndEvent => ({
  _tag: "EndEvent",
  id,
  processId,
  parentScopeId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: []
})

const task = (
  id: string,
  parentScopeId: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>,
  overrides: Partial<BpmnModel.Task> = {}
): BpmnModel.Task => ({
  _tag: "Task",
  id,
  processId,
  parentScopeId,
  taskKind: "generic",
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: [],
  ...overrides
})

const gateway = (
  id: string,
  parentScopeId: string,
  gatewayKind: BpmnModel.Gateway["gatewayKind"],
  gatewayDirection: BpmnModel.Gateway["gatewayDirection"],
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.Gateway => ({
  _tag: "Gateway",
  id,
  processId,
  parentScopeId,
  gatewayKind,
  gatewayDirection,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: []
})

const subProcess = (
  id: string,
  parentScopeId: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.SubProcess => ({
  _tag: "SubProcess",
  id,
  processId,
  parentScopeId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: []
})

const catchEvent = (
  id: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>,
  eventDefinition: BpmnModel.EventDefinition
): BpmnModel.IntermediateCatchEvent => ({
  _tag: "IntermediateCatchEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  eventDefinitions: [eventDefinition],
  eventDefinitionRefs: [],
  extensionElements: []
})

const flow = (
  id: string,
  parentScopeId: string,
  sourceId: string,
  targetId: string
): BpmnModel.SequenceFlow => ({
  id,
  processId,
  parentScopeId,
  sourceId,
  targetId,
  kind: "normal",
  extensionElements: []
})

const model = (
  flowNodes: ReadonlyArray<BpmnModel.FlowNode>,
  sequenceFlows: ReadonlyArray<BpmnModel.SequenceFlow>
): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  collaborations: [],
  processes: [{
    id: processId,
    isExecutable: true,
    extensionElements: []
  }],
  flowNodes: [...flowNodes],
  sequenceFlows: [...sequenceFlows]
})

const prepare = (
  definition: BpmnModel.BpmnModel,
  messageBindings: ReadonlyArray<BpmnEventV3.MessageBinding> = [],
  taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding> = []
): Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnKernel.prepare(definition, {
      profileId: "operational-instance-withdrawal-v1-tests",
      rootProcessId: processId,
      limits,
      evaluatorBindings: messageBindings.length > 0 ||
          definition.flowNodes.some((node) =>
            node._tag === "Task" &&
            node.loopCharacteristics !== undefined
          ) ||
          definition.flowNodes.some((node) =>
            (node._tag === "IntermediateCatchEvent" ||
              node._tag === "BoundaryEvent") &&
            node.eventDefinitions.some((eventDefinition) => eventDefinition._tag === "TimerEventDefinition")
          )
        ? [evaluatorBinding]
        : [],
      ...(messageBindings.length === 0
        ? {}
        : { messageBindings }),
      ...(taskBindings.length === 0 ? {} : { taskBindings })
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError>

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const compile = (
  definition: BpmnModel.BpmnModel,
  messageBindings: ReadonlyArray<BpmnEventV3.MessageBinding> = [],
  taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding> = []
): BpmnKernel.CompiledKernel => success(prepare(definition, messageBindings, taskBindings))

const initialize = (
  kernel: BpmnKernel.CompiledKernel,
  evaluations: Readonly<Record<string, unknown>> = {}
): BpmnKernel.TransitionBatch =>
  success(BpmnKernel.initialize(
    kernel,
    {
      commandVersion: BpmnKernel.InitializeCommandVersion,
      input: null
    },
    services(initialTime, evaluations)
  ))

const rootScope = (
  state: BpmnKernel.TransitionBatch["state"]
) => {
  const root = state.scopeInstances.find((scope) => scope.parentScopeInstanceId === undefined)
  if (root === undefined) {
    throw new Error("expected root scope")
  }
  return root
}

const withdrawalCommand = (
  state: BpmnKernel.TransitionBatch["state"],
  requestId = "withdrawal-request-1"
): BpmnOperationalV3.RequestInstanceWithdrawalCommand => ({
  commandVersion: BpmnOperationalV3.OperationalInstanceWithdrawalVersion,
  rootScopeInstanceId: rootScope(state).scopeInstanceId,
  requestId: Schema.decodeUnknownSync(
    ProtocolV3Wire.AtomicIdentifier
  )(requestId),
  attribution: {
    actorId: "operator-1",
    policyId: "ops-withdrawal",
    policyVersion: "1",
    policyDecisionId: "decision-1"
  },
  reasonCode: "operator-request"
})

const withdraw = (
  kernel: BpmnKernel.CompiledKernel,
  state: BpmnKernel.TransitionBatch["state"],
  requestId = "withdrawal-request-1"
): BpmnKernel.TransitionBatch =>
  success(BpmnKernel.withdrawExecution(
    kernel,
    state,
    withdrawalCommand(state, requestId),
    services(withdrawalTime)
  ))

const simpleTaskModel = (
  taskOverrides: Partial<BpmnModel.Task> = {}
): BpmnModel.BpmnModel =>
  model(
    [
      start("start", processId, ["start-task"]),
      task("task", processId, ["start-task"], ["task-end"], taskOverrides),
      end("end", processId, ["task-end"])
    ],
    [
      flow("start-task", processId, "start", "task"),
      flow("task-end", processId, "task", "end")
    ]
  )

const parallelTaskModel = (): BpmnModel.BpmnModel =>
  model(
    [
      start("start", processId, ["start-split"]),
      gateway(
        "split",
        processId,
        "parallel",
        "diverging",
        ["start-split"],
        ["split-left", "split-right"]
      ),
      task("left", processId, ["split-left"], ["left-join"]),
      task("right", processId, ["split-right"], ["right-join"]),
      gateway(
        "join",
        processId,
        "parallel",
        "converging",
        ["left-join", "right-join"],
        ["join-end"]
      ),
      end("end", processId, ["join-end"])
    ],
    [
      flow("start-split", processId, "start", "split"),
      flow("split-left", processId, "split", "left"),
      flow("split-right", processId, "split", "right"),
      flow("left-join", processId, "left", "join"),
      flow("right-join", processId, "right", "join"),
      flow("join-end", processId, "join", "end")
    ]
  )

const multiInstanceTaskModel = (
  mode: "parallel" | "sequential"
): BpmnModel.BpmnModel =>
  simpleTaskModel({
    loopCharacteristics: {
      _tag: "MultiInstanceCharacteristics",
      mode,
      cardinality: expression("cardinality")
    }
  })

const embeddedSubprocessModel = (): BpmnModel.BpmnModel =>
  model(
    [
      start("start", processId, ["start-sub"]),
      subProcess("outer", processId, ["start-sub"], ["outer-end"]),
      end("end", processId, ["outer-end"]),
      start("outer-start", "outer", ["outer-inner"]),
      subProcess("inner", "outer", ["outer-inner"], ["inner-after"]),
      task("outer-after", "outer", ["inner-after"], ["outer-finish"]),
      end("outer-end-event", "outer", ["outer-finish"]),
      start("inner-start", "inner", ["inner-task"]),
      task("deep-task", "inner", ["inner-task"], ["inner-finish"]),
      end("inner-end-event", "inner", ["inner-finish"])
    ],
    [
      flow("start-sub", processId, "start", "outer"),
      flow("outer-end", processId, "outer", "end"),
      flow("outer-inner", "outer", "outer-start", "inner"),
      flow("inner-after", "outer", "inner", "outer-after"),
      flow("outer-finish", "outer", "outer-after", "outer-end-event"),
      flow("inner-task", "inner", "inner-start", "deep-task"),
      flow("inner-finish", "inner", "deep-task", "inner-end-event")
    ]
  )

const messageBinding = (
  catchEventNodeId: string
): BpmnEventV3.MessageBinding => ({
  bindingVersion: 1,
  catchEventNodeId,
  messageRef: `${catchEventNodeId}-message`,
  correlationExpression: expression(`${catchEventNodeId}-correlation`),
  payloadContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: `${catchEventNodeId}-codec`,
    schemaDigest: messageSchemaDigest
  },
  authorizationPolicy: {
    policyVersion: 1,
    policyId: `${catchEventNodeId}-policy`,
    deploymentId: `${catchEventNodeId}-policy-deployment`,
    buildDigest: messagePolicyBuildDigest
  }
})

const standaloneMessageModel = (
  binding: BpmnEventV3.MessageBinding
): BpmnModel.BpmnModel => ({
  ...model(
    [
      start("start", processId, ["start-message"]),
      catchEvent(
        binding.catchEventNodeId,
        ["start-message"],
        ["message-end"],
        {
          _tag: "MessageEventDefinition",
          messageRef: binding.messageRef
        }
      ),
      end("end", processId, ["message-end"])
    ],
    [
      flow("start-message", processId, "start", binding.catchEventNodeId),
      flow("message-end", processId, binding.catchEventNodeId, "end")
    ]
  ),
  messages: [{ id: binding.messageRef }]
})

const standaloneTimerModel = (): BpmnModel.BpmnModel =>
  model(
    [
      start("start", processId, ["start-timer"]),
      catchEvent(
        "wait-timer",
        ["start-timer"],
        ["timer-end"],
        {
          _tag: "TimerEventDefinition",
          timeDuration: expression("timer-duration")
        }
      ),
      end("end", processId, ["timer-end"])
    ],
    [
      flow("start-timer", processId, "start", "wait-timer"),
      flow("timer-end", processId, "wait-timer", "end")
    ]
  )

const eventBasedChoiceModel = (
  binding: BpmnEventV3.MessageBinding
): BpmnModel.BpmnModel => ({
  ...model(
    [
      start("start", processId, ["start-choice"]),
      {
        ...gateway(
          "choice",
          processId,
          "event-based",
          "diverging",
          ["start-choice"],
          ["choice-message", "choice-timer"]
        ),
        instantiate: false,
        eventGatewayType: "exclusive" as const
      },
      catchEvent(
        binding.catchEventNodeId,
        ["choice-message"],
        ["message-end"],
        {
          _tag: "MessageEventDefinition",
          messageRef: binding.messageRef
        }
      ),
      catchEvent(
        "wait-choice-timer",
        ["choice-timer"],
        ["timer-end"],
        {
          _tag: "TimerEventDefinition",
          timeDuration: expression("timer-duration")
        }
      ),
      end("message-end-event", processId, ["message-end"]),
      end("timer-end-event", processId, ["timer-end"])
    ],
    [
      flow("start-choice", processId, "start", "choice"),
      flow("choice-message", processId, "choice", binding.catchEventNodeId),
      flow("choice-timer", processId, "choice", "wait-choice-timer"),
      flow("message-end", processId, binding.catchEventNodeId, "message-end-event"),
      flow("timer-end", processId, "wait-choice-timer", "timer-end-event")
    ]
  ),
  messages: [{ id: binding.messageRef }]
})

const catchTarget = (
  state: BpmnExecutionState.BpmnExecutionState,
  arm: BpmnExecutionState.Subscription
): BpmnEventV3.CatchArmTarget => {
  const group = state.catchWaitGroups.find((candidate) => candidate.waitGroupId === arm.waitGroupId)
  if (group === undefined) {
    throw new Error("expected catch wait group")
  }
  return {
    waitGroupId: group.waitGroupId,
    armId: arm.armId,
    scopeInstanceId: group.scopeInstanceId,
    catchEventNodeId: arm.ownerNodeId,
    tokenId: group.ownerTokenId,
    generation: group.generation
  }
}

const boundTaskBinding = (): BpmnActivityV3.TaskBinding =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBinding)({
    bindingVersion: BpmnActivityV3.BindingVersion,
    executionProtocolVersion: 3,
    taskNodeId: "task",
    artifactDigest,
    semanticNodeId,
    errorMappings: []
  })

const boundTaskOutcome = (): BpmnActivityV3.TaskSucceeded =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskSucceeded)({
    _tag: "Succeeded",
    outcomeVersion: BpmnActivityV3.OutcomeVersion,
    artifactDigest,
    semanticNodeId,
    occurrenceDigest,
    firstActivityDigest,
    attempt: 1,
    completedActivityDigest,
    output: {
      _tag: "Inline",
      value: null
    }
  })

const eventTags = (
  events: ReadonlyArray<BpmnKernel.TransitionEvent>
): ReadonlyArray<string> => events.map((event) => event._tag)

const assertNoSemanticProgress = (
  batch: BpmnKernel.TransitionBatch
): void => {
  const forbidden = new Set([
    "OutgoingSelected",
    "SequenceFlowSelected",
    "BoundaryErrorCaught",
    "CompensationRegistered",
    "CompensationTriggered",
    "CompensationCompleted"
  ])
  assert.isFalse(eventTags(batch.events).some((tag) => forbidden.has(tag)))
  assert.isFalse(batch.state.tokens.some((token) => token.status === "active"))
}

describe("BpmnKernel OperationalInstanceWithdrawal/1", () => {
  it("withdraws one waiting task, fences scheduling, and emits no BPMN continuation", () => {
    const kernel = compile(simpleTaskModel())
    const initialized = initialize(kernel)
    const batch = withdraw(kernel, initialized.state)

    assert.strictEqual(batch.state.status, "cancelled")
    assert.strictEqual(batch.state.completedAt, withdrawalTime)
    assert.strictEqual(rootScope(batch.state).status, "cancelled")
    assert(batch.state.tokens.every((token) => token.status !== "active"))
    assert.deepStrictEqual(eventTags(batch.events), [
      "OperationalWithdrawalRequested",
      "OperationalWithdrawalSchedulingFenced",
      "ParentCloseIntentCommitted",
      "TokenWithdrawn",
      "OperationalWithdrawalScopeClosed",
      "OperationalWithdrawalCompleted"
    ])
    assertNoSemanticProgress(batch)
  })

  it("withdraws every parallel branch without activating the join or outgoing work", () => {
    const kernel = compile(parallelTaskModel())
    const initialized = initialize(kernel)
    assert.strictEqual(
      initialized.state.tokens.filter((token) => token.status === "active")
        .length,
      2
    )

    const batch = withdraw(kernel, initialized.state)
    assertNoSemanticProgress(batch)
    assert(
      batch.state.gatewayFrames.every((frame) => frame.status === "cancelled" || frame.status === "fired")
    )
    assert.strictEqual(
      eventTags(batch.events).filter((tag) => tag === "OperationalWithdrawalGatewayFrameClosed").length,
      batch.state.gatewayFrames.filter((frame) => frame.status === "cancelled")
        .length
    )
  })

  it("closes an active Standard Loop without another condition evaluation or iteration", () => {
    const kernel = compile(simpleTaskModel({
      loopCharacteristics: {
        _tag: "StandardLoopCharacteristics",
        testBefore: false,
        condition: expression("repeat"),
        loopMaximum: 5
      }
    }))
    const initialized = initialize(kernel, { repeat: true })
    assert.strictEqual(initialized.state.loopFrames[0]?.status, "active")

    const batch = withdraw(kernel, initialized.state)
    assert.strictEqual(batch.state.loopFrames[0]?.status, "cancelled")
    assert.strictEqual(batch.state.loopFrames[0]?.closedAt, withdrawalTime)
    assert.strictEqual(
      eventTags(batch.events).filter((tag) => tag === "OperationalWithdrawalLoopFrameClosed").length,
      1
    )
    assertNoSemanticProgress(batch)
  })

  for (const mode of ["parallel", "sequential"] as const) {
    it(`withdraws ${mode} multi-instance members with an exact generated/pending partition`, () => {
      const kernel = compile(multiInstanceTaskModel(mode))
      const initialized = initialize(kernel, { cardinality: 3 })
      const before = initialized.state.multiInstanceGroups[0]
      assert(before)

      const batch = withdraw(kernel, initialized.state)
      const group = batch.state.multiInstanceGroups[0]
      assert(group)
      assert.strictEqual(group.status, "cancelled")
      assert.strictEqual(group.completionReason, "execution-cancelled")
      assert.strictEqual(group.closedAt, withdrawalTime)
      if (mode === "parallel") {
        assert.deepStrictEqual(
          group.members.map((member) => member.status),
          ["terminated", "terminated", "terminated"]
        )
      } else {
        assert.deepStrictEqual(
          before.members.map((member) => member.status),
          ["active", "pending", "pending"]
        )
        assert.deepStrictEqual(
          group.members.map((member) => member.status),
          ["terminated", "not-generated", "not-generated"]
        )
      }
      assert(group.members.every((member) =>
        member.status === "terminated"
          ? member.terminationReason === "execution-cancelled" &&
            member.endedAt === withdrawalTime
          : member.status === "not-generated" &&
            member.nonGenerationReason === "execution-cancelled"
      ))
      assert.strictEqual(
        eventTags(batch.events).filter((tag) => tag === "OperationalWithdrawalMultiInstanceGroupClosed").length,
        1
      )
      assertNoSemanticProgress(batch)
    })
  }

  it("closes embedded subprocess descendants before their root scope", () => {
    const kernel = compile(embeddedSubprocessModel())
    const initialized = initialize(kernel)
    assert.strictEqual(initialized.state.scopeInstances.length, 3)

    const batch = withdraw(kernel, initialized.state)
    assert(
      batch.state.scopeInstances.every((scope) => scope.status === "cancelled" && scope.exitedAt === withdrawalTime)
    )
    const closedScopeIds = batch.events.flatMap((event) =>
      event._tag === "OperationalWithdrawalScopeClosed"
        ? [event.scopeInstanceId]
        : []
    )
    const depths = closedScopeIds.map((scopeId) => {
      let depth = 0
      let current = batch.state.scopeInstances.find((scope) => scope.scopeInstanceId === scopeId)
      while (current?.parentScopeInstanceId !== undefined) {
        depth++
        current = batch.state.scopeInstances.find((scope) => scope.scopeInstanceId === current?.parentScopeInstanceId)
      }
      return depth
    })
    assert.deepStrictEqual(depths, [...depths].sort((left, right) => right - left))
    assertNoSemanticProgress(batch)
  })

  it("cancels standalone Message and Timer waits and fences their late ingress", () => {
    const binding = messageBinding("wait-message")
    const messageKernel = compile(
      standaloneMessageModel(binding),
      [binding]
    )
    const messageInitialized = initialize(messageKernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"]
    })
    const messageArm = messageInitialized.state.subscriptions[0]
    assert(messageArm?._tag === "MessageCatchSubscription")
    const messageWithdrawn = withdraw(
      messageKernel,
      messageInitialized.state
    )
    assert.strictEqual(
      messageWithdrawn.state.catchWaitGroups[0]?.status,
      "cancelled"
    )
    assert.strictEqual(
      messageWithdrawn.state.catchWaitGroups[0]?.closedAt,
      withdrawalTime
    )
    assert.strictEqual(
      messageWithdrawn.state.subscriptions[0]?.status,
      "cancelled"
    )
    assert.strictEqual(
      messageWithdrawn.state.subscriptions[0]?.closedAt,
      withdrawalTime
    )
    const lateMessage = success(BpmnKernel.deliverMessage(
      messageKernel,
      messageWithdrawn.state,
      {
        commandVersion: BpmnEventV3.DeliverMessageCommandVersion,
        target: catchTarget(messageInitialized.state, messageArm),
        receipt: {
          receiptVersion: 1,
          deliveryId: "late-message-delivery",
          messageRef: binding.messageRef,
          correlationKey: messageArm.correlationKey,
          payloadContract: binding.payloadContract,
          payload: { orderId: "order-42" },
          acceptedAt: withdrawalTime,
          authorization: {
            policy: binding.authorizationPolicy,
            decisionId: "late-message-decision",
            actorId: "trusted-ingress"
          }
        }
      },
      services(withdrawalTime)
    ))
    assert.deepStrictEqual(lateMessage.state, messageWithdrawn.state)
    assert.deepStrictEqual(eventTags(lateMessage.events), [
      "CatchIngressFenced"
    ])

    const timerKernel = compile(standaloneTimerModel())
    const timerInitialized = initialize(timerKernel, {
      "timer-duration": "PT5S"
    })
    const timerArm = timerInitialized.state.subscriptions[0]
    const timer = timerInitialized.state.timers[0]
    assert(timerArm?._tag === "TimerCatchSubscription")
    assert(timer)
    const armedAt = Schema.decodeUnknownSync(ProtocolV2Wire.Timestamp)(
      "2026-07-24T10:00:01.000Z"
    )
    const armed = success(BpmnKernel.acknowledgeTimerArm(
      timerKernel,
      timerInitialized.state,
      {
        commandVersion: BpmnEventV3.AcknowledgeTimerArmCommandVersion,
        target: catchTarget(timerInitialized.state, timerArm),
        timerId: timer.timerId,
        receipt: {
          receiptVersion: 1,
          backendId: "withdrawal-test-timer-backend",
          scheduleId: "withdrawal-test-schedule",
          receiptId: "withdrawal-test-receipt",
          armedAt
        }
      },
      services(armedAt)
    ))
    const timerWithdrawn = withdraw(timerKernel, armed.state)
    assert.strictEqual(timerWithdrawn.state.timers[0]?.status, "cancelled")
    assert.strictEqual(
      timerWithdrawn.state.timers[0]?.cancelledAt,
      withdrawalTime
    )
    const lateTimer = success(BpmnKernel.observeDueTimer(
      timerKernel,
      timerWithdrawn.state,
      {
        commandVersion: BpmnEventV3.ObserveDueTimerCommandVersion,
        target: catchTarget(timerInitialized.state, timerArm),
        timerId: timer.timerId,
        observedAt: withdrawalTime
      },
      services(withdrawalTime)
    ))
    assert.deepStrictEqual(lateTimer.state, timerWithdrawn.state)
    assert.deepStrictEqual(eventTags(lateTimer.events), [
      "CatchIngressFenced"
    ])
  })

  it("atomically cancels every event-based gateway arm and timer at one timestamp", () => {
    const binding = messageBinding("wait-choice-message")
    const kernel = compile(eventBasedChoiceModel(binding), [binding])
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"],
      "timer-duration": "PT5S"
    })
    assert.strictEqual(initialized.state.catchWaitGroups.length, 1)
    assert.strictEqual(initialized.state.subscriptions.length, 2)
    assert.strictEqual(initialized.state.timers.length, 1)

    const batch = withdraw(kernel, initialized.state)
    const group = batch.state.catchWaitGroups[0]
    assert(group)
    assert.strictEqual(group.status, "cancelled")
    assert.strictEqual(group.cancellationReason, "execution-cancelled")
    assert.strictEqual(group.closedAt, withdrawalTime)
    assert(batch.state.subscriptions.every((arm) =>
      arm.status === "cancelled" &&
      arm.cancellationReason === "execution-cancelled" &&
      arm.closedAt === withdrawalTime
    ))
    assert(batch.state.timers.every((timer) =>
      timer.status === "cancelled" &&
      timer.cancellationReason === "execution-cancelled" &&
      timer.cancelledAt === withdrawalTime
    ))
    assertNoSemanticProgress(batch)
  })

  it("replays the exact request idempotently, fences another request, and survives restart from the full journal", () => {
    const kernel = compile(simpleTaskModel())
    const initialized = initialize(kernel)
    const command = withdrawalCommand(initialized.state)
    const first = success(BpmnKernel.withdrawExecution(
      kernel,
      initialized.state,
      command,
      services(withdrawalTime)
    ))
    const repeated = success(BpmnKernel.withdrawExecution(
      kernel,
      first.state,
      command,
      services(withdrawalTime)
    ))
    assert.deepStrictEqual(repeated.state, first.state)
    assert.deepStrictEqual(eventTags(repeated.events), [
      "OperationalWithdrawalReplayed"
    ])

    const conflicting = BpmnKernel.withdrawExecution(
      kernel,
      first.state,
      withdrawalCommand(initialized.state, "withdrawal-request-2"),
      services(withdrawalTime)
    )
    assert.isTrue(Result.isFailure(conflicting))

    const journal = [...initialized.events, ...first.events]
    const restarted = success(BpmnKernel.replay(kernel, journal))
    assert.deepStrictEqual(restarted, first.state)
    const afterRestart = success(BpmnKernel.withdrawExecution(
      kernel,
      restarted,
      command,
      services(withdrawalTime)
    ))
    assert.deepStrictEqual(afterRestart.state, first.state)
    assert.deepStrictEqual(eventTags(afterRestart.events), [
      "OperationalWithdrawalReplayed"
    ])
  })

  it("linearizes completion and withdrawal in either order and fences late completion", () => {
    const kernel = compile(simpleTaskModel())
    const initialized = initialize(kernel)
    const token = initialized.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task"
    )
    assert(token)
    const completionCommand = {
      scopeInstanceId: token.scopeInstanceId,
      taskNodeId: "task",
      tokenId: token.tokenId
    }

    const completed = success(BpmnKernel.completeTask(
      kernel,
      initialized.state,
      completionCommand,
      services(withdrawalTime)
    ))
    assert.strictEqual(completed.state.status, "completed")
    assert.isTrue(Result.isFailure(BpmnKernel.withdrawExecution(
      kernel,
      completed.state,
      withdrawalCommand(initialized.state),
      services(withdrawalTime)
    )))

    const withdrawn = withdraw(kernel, initialized.state)
    const late = success(BpmnKernel.completeTask(
      kernel,
      withdrawn.state,
      completionCommand,
      services(withdrawalTime)
    ))
    assert.strictEqual(late.state.status, "cancelled")
    assert.deepStrictEqual(eventTags(late.events), ["TaskCompletionFenced"])
    assertNoSemanticProgress(late)
  })

  it("replays a late multi-instance completion fence and rejects a forged replay event", () => {
    const kernel = compile(multiInstanceTaskModel("parallel"))
    const initialized = initialize(kernel, { cardinality: 2 })
    const token = initialized.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task"
    )
    assert(token)
    const withdrawn = withdraw(kernel, initialized.state)
    const late = success(BpmnKernel.completeTask(
      kernel,
      withdrawn.state,
      {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task",
        tokenId: token.tokenId
      },
      services(withdrawalTime)
    ))
    assert.deepStrictEqual(eventTags(late.events), ["TaskCompletionFenced"])
    const journal = [
      ...initialized.events,
      ...withdrawn.events,
      ...late.events
    ]
    assert.deepStrictEqual(
      success(BpmnKernel.replay(kernel, journal)),
      withdrawn.state
    )

    const forged = structuredClone(journal)
    const fencedIndex = forged.findIndex((event) => event._tag === "TaskCompletionFenced")
    assert.isAtLeast(fencedIndex, 0)
    forged[fencedIndex] = {
      _tag: "TaskCompletionReplayed",
      tokenId: token.tokenId,
      observedAt: withdrawalTime
    }
    assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, forged)))
  })

  it("fences a late authenticated protocol-v3 task outcome without recording a resolution", () => {
    const binding = boundTaskBinding()
    const kernel = compile(simpleTaskModel(), [], [binding])
    const initialized = initialize(kernel)
    const token = initialized.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task"
    )
    assert(token)
    const withdrawn = withdraw(kernel, initialized.state)
    const late = success(BpmnKernel.resolveTask(
      kernel,
      withdrawn.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task",
        tokenId: token.tokenId,
        outcome: boundTaskOutcome()
      },
      services(withdrawalTime)
    ))
    assert.deepStrictEqual(late.state, withdrawn.state)
    assert.deepStrictEqual(eventTags(late.events), ["TaskOutcomeFenced"])
    assert.strictEqual(late.state.activityResolutions.length, 0)
    assertNoSemanticProgress(late)
  })

  it("rejects forged terminal state and tampered, reordered, or truncated withdrawal journals", () => {
    const kernel = compile(simpleTaskModel())
    const initialized = initialize(kernel)
    const first = withdraw(kernel, initialized.state)
    const journal = [...initialized.events, ...first.events]

    const forgedState = structuredClone(initialized.state)
    forgedState.status = "cancelled"
    forgedState.completedAt = withdrawalTime
    forgedState.scopeInstances = forgedState.scopeInstances.map((scope) => ({
      ...scope,
      status: "cancelled" as const,
      exitedAt: withdrawalTime
    }))
    forgedState.tokens = forgedState.tokens.map((token) => ({
      ...token,
      status: token.status === "active" ? "withdrawn" as const : token.status,
      ...(token.status === "active" ? { consumedAt: withdrawalTime } : {})
    }))
    assert.isTrue(Result.isFailure(BpmnKernel.advance(
      kernel,
      forgedState,
      services(withdrawalTime)
    )))

    const requestedIndex = journal.findIndex((event) => event._tag === "OperationalWithdrawalRequested")
    const completedIndex = journal.findIndex((event) => event._tag === "OperationalWithdrawalCompleted")
    assert.isAtLeast(requestedIndex, 0)
    assert.isAtLeast(completedIndex, 0)

    const attributionTamper = structuredClone(journal)
    const requested = attributionTamper[requestedIndex]
    assert(requested?._tag === "OperationalWithdrawalRequested")
    requested.record.command.attribution.actorId = "forged-actor"

    const timestampTamper = structuredClone(journal)
    const terminal = timestampTamper[completedIndex]
    assert(terminal?._tag === "OperationalWithdrawalCompleted")
    terminal.completedAt = initialTime

    const reordered = structuredClone(journal)
    const requestedEvent = reordered[requestedIndex]!
    const completedEvent = reordered[completedIndex]!
    reordered[requestedIndex] = completedEvent
    reordered[completedIndex] = requestedEvent

    const truncated = journal.slice(0, completedIndex)

    for (
      const forged of [
        attributionTamper,
        timestampTamper,
        reordered,
        truncated
      ]
    ) {
      assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, forged)))
    }
  })
})
