import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import type * as BpmnEventV3 from "../src/BpmnEventV3.ts"
import * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "catch-process"
const expressionLanguage = "feel"
const expressionLanguageVersion = "1.0"

const timestamp = (value: string): ProtocolV2Wire.Timestamp => Schema.decodeUnknownSync(ProtocolV2Wire.Timestamp)(value)

const startedAt = timestamp("2026-07-24T10:00:00.000Z")

const expression = (source: string): BpmnModel.Expression => ({
  language: expressionLanguage,
  version: expressionLanguageVersion,
  source
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"1".repeat(64)}`)

const schemaDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.SchemaDigest
)(`sha256:${"a".repeat(64)}`)

const policyBuildDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.BuildDigest
)(`sha256:${"b".repeat(64)}`)

const taskArtifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"c".repeat(64)}`)

const taskOccurrenceDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OccurrenceDigest
)(`sha256:${"d".repeat(64)}`)

const taskFirstActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"e".repeat(64)}`)

const taskFailedActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"f".repeat(64)}`)

const taskClassificationActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"0".repeat(64)}`)

const taskSemanticNodeId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("catch-cleanup-task")

const evaluatorBinding: BpmnExpression.EvaluatorBinding = {
  language: expressionLanguage,
  languageVersion: expressionLanguageVersion,
  build: {
    id: "catch-test-evaluator",
    version: "1.0.0",
    deploymentId: "catch-test-deployment",
    buildDigest: evaluatorBuildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 10_000,
    timeoutMillis: 1_000
  }
}

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
  maxMultiInstanceCardinality: 128,
  maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
  maxMultiInstanceItemCanonicalBytes: 262_144,
  maxMultiInstanceOutputCanonicalBytes: 1_048_576,
  maxMultiInstanceItemOutputCanonicalBytes: 262_144
}

const payloadContract = () => ({
  _tag: "ArtifactCodec" as const,
  contractReferenceVersion: 1 as const,
  codecKey: "catch-message-json",
  schemaDigest
})

const authorizationPolicy = () => ({
  policyVersion: 1 as const,
  policyId: "catch-message-policy",
  deploymentId: "catch-policy-deployment",
  buildDigest: policyBuildDigest
})

const taskBinding = (
  taskNodeId: string
): BpmnActivityV3.TaskBinding =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBinding)({
    bindingVersion: BpmnActivityV3.BindingVersion,
    executionProtocolVersion: 3,
    taskNodeId,
    artifactDigest: taskArtifactDigest,
    semanticNodeId: taskSemanticNodeId,
    errorMappings: []
  })

const unmappedBusinessFailure = (): BpmnActivityV3.TaskBusinessFailed =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBusinessFailed)({
    _tag: "BusinessFailed",
    outcomeVersion: BpmnActivityV3.OutcomeVersion,
    artifactDigest: taskArtifactDigest,
    semanticNodeId: taskSemanticNodeId,
    occurrenceDigest: taskOccurrenceDigest,
    firstActivityDigest: taskFirstActivityDigest,
    terminal: {
      _tag: "NonRetryable",
      terminalVersion: 1,
      decision: {
        _tag: "Classifier",
        decisionVersion: 1,
        classificationActivityDigest: taskClassificationActivityDigest
      }
    },
    failedActivityDigest: taskFailedActivityDigest,
    attempt: 1,
    identity: {
      failureIdentityVersion: 1,
      errorTag: "UnmappedBusinessFailure",
      errorCode: "UNMAPPED"
    }
  })

const messageBinding = (
  catchEventNodeId: string,
  messageRef = `${catchEventNodeId}-message`,
  correlationSource = `${catchEventNodeId}-correlation`
): BpmnEventV3.MessageBinding => ({
  bindingVersion: 1,
  catchEventNodeId,
  messageRef,
  correlationExpression: expression(correlationSource),
  payloadContract: payloadContract(),
  authorizationPolicy: authorizationPolicy()
})

const process = (): BpmnModel.Process => ({
  id: processId,
  isExecutable: true,
  extensionElements: []
})

const startEvent = (
  id: string,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.StartEvent => ({
  _tag: "StartEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: []
})

const endEvent = (
  id: string,
  incomingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.EndEvent => ({
  _tag: "EndEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: []
})

const task = (
  id: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.Task => ({
  _tag: "Task",
  id,
  processId,
  parentScopeId: processId,
  taskKind: "generic",
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: []
})

const catchEvent = (
  id: string,
  incomingSequenceFlowId: string,
  outgoingSequenceFlowId: string,
  definition: BpmnModel.EventDefinition
): BpmnModel.IntermediateCatchEvent => ({
  _tag: "IntermediateCatchEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [incomingSequenceFlowId],
  outgoingSequenceFlowIds: [outgoingSequenceFlowId],
  eventDefinitions: [definition],
  eventDefinitionRefs: [],
  extensionElements: []
})

const eventBasedGateway = (
  id: string,
  incomingSequenceFlowId: string,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.Gateway => ({
  _tag: "Gateway",
  id,
  processId,
  parentScopeId: processId,
  gatewayKind: "event-based",
  gatewayDirection: "diverging",
  instantiate: false,
  eventGatewayType: "exclusive",
  incomingSequenceFlowIds: [incomingSequenceFlowId],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: []
})

const flow = (
  id: string,
  sourceId: string,
  targetId: string
): BpmnModel.SequenceFlow => ({
  id,
  processId,
  parentScopeId: processId,
  sourceId,
  targetId,
  kind: "normal",
  extensionElements: []
})

const model = (
  flowNodes: ReadonlyArray<BpmnModel.FlowNode>,
  sequenceFlows: ReadonlyArray<BpmnModel.SequenceFlow>,
  messages: ReadonlyArray<BpmnModel.Message> = []
): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [...messages],
  collaborations: [],
  processes: [process()],
  flowNodes: [...flowNodes],
  sequenceFlows: [...sequenceFlows]
})

interface DefinitionFixture {
  readonly model: BpmnModel.BpmnModel
  readonly messageBindings: ReadonlyArray<BpmnEventV3.MessageBinding>
  readonly taskBindings?: ReadonlyArray<BpmnActivityV3.TaskBinding>
}

const standaloneMessageDefinition = (
  catchId = "wait-message"
): DefinitionFixture => {
  const binding = messageBinding(catchId)
  return {
    messageBindings: [binding],
    model: model(
      [
        startEvent("start", ["start-to-catch"]),
        catchEvent(
          catchId,
          "start-to-catch",
          "catch-to-end",
          {
            _tag: "MessageEventDefinition",
            messageRef: binding.messageRef
          }
        ),
        endEvent("end", ["catch-to-end"])
      ],
      [
        flow("start-to-catch", "start", catchId),
        flow("catch-to-end", catchId, "end")
      ],
      [{ id: binding.messageRef }]
    )
  }
}

const standaloneTimerDefinition = (
  timerKind: "timeDuration" | "timeDate",
  timerSource: string
): DefinitionFixture => ({
  messageBindings: [],
  model: model(
    [
      startEvent("start", ["start-to-timer"]),
      catchEvent(
        "wait-timer",
        "start-to-timer",
        "timer-to-end",
        timerKind === "timeDuration"
          ? {
            _tag: "TimerEventDefinition",
            timeDuration: expression(timerSource)
          }
          : {
            _tag: "TimerEventDefinition",
            timeDate: expression(timerSource)
          }
      ),
      endEvent("end", ["timer-to-end"])
    ],
    [
      flow("start-to-timer", "start", "wait-timer"),
      flow("timer-to-end", "wait-timer", "end")
    ]
  )
})

const messageTimerChoiceDefinition = (
  durationSource = "choice-duration"
): DefinitionFixture => {
  const binding = messageBinding("wait-message")
  return {
    messageBindings: [binding],
    model: model(
      [
        startEvent("start", ["start-to-choice"]),
        eventBasedGateway(
          "choice",
          "start-to-choice",
          ["choice-to-message", "choice-to-timer"]
        ),
        catchEvent(
          "wait-message",
          "choice-to-message",
          "message-to-end",
          {
            _tag: "MessageEventDefinition",
            messageRef: binding.messageRef
          }
        ),
        catchEvent(
          "wait-timer",
          "choice-to-timer",
          "timer-to-end",
          {
            _tag: "TimerEventDefinition",
            timeDuration: expression(durationSource)
          }
        ),
        endEvent("message-end", ["message-to-end"]),
        endEvent("timer-end", ["timer-to-end"])
      ],
      [
        flow("start-to-choice", "start", "choice"),
        flow("choice-to-message", "choice", "wait-message"),
        flow("choice-to-timer", "choice", "wait-timer"),
        flow("message-to-end", "wait-message", "message-end"),
        flow("timer-to-end", "wait-timer", "timer-end")
      ],
      [{ id: binding.messageRef }]
    )
  }
}

const parallelMessageTimerChoicesDefinition = (): DefinitionFixture => {
  const leftBinding = messageBinding(
    "wait-message-left",
    "left-message",
    "left-correlation"
  )
  const rightBinding = messageBinding(
    "wait-message-right",
    "right-message",
    "right-correlation"
  )
  return {
    messageBindings: [leftBinding, rightBinding],
    model: model(
      [
        startEvent("start", [
          "start-to-choice-left",
          "start-to-choice-right"
        ]),
        eventBasedGateway(
          "choice-left",
          "start-to-choice-left",
          ["choice-left-to-message", "choice-left-to-timer"]
        ),
        catchEvent(
          "wait-message-left",
          "choice-left-to-message",
          "message-left-to-end",
          {
            _tag: "MessageEventDefinition",
            messageRef: leftBinding.messageRef
          }
        ),
        catchEvent(
          "wait-timer-left",
          "choice-left-to-timer",
          "timer-left-to-end",
          {
            _tag: "TimerEventDefinition",
            timeDuration: expression("left-duration")
          }
        ),
        eventBasedGateway(
          "choice-right",
          "start-to-choice-right",
          ["choice-right-to-message", "choice-right-to-timer"]
        ),
        catchEvent(
          "wait-message-right",
          "choice-right-to-message",
          "message-right-to-end",
          {
            _tag: "MessageEventDefinition",
            messageRef: rightBinding.messageRef
          }
        ),
        catchEvent(
          "wait-timer-right",
          "choice-right-to-timer",
          "timer-right-to-end",
          {
            _tag: "TimerEventDefinition",
            timeDuration: expression("right-duration")
          }
        ),
        endEvent("message-left-end", ["message-left-to-end"]),
        endEvent("timer-left-end", ["timer-left-to-end"]),
        endEvent("message-right-end", ["message-right-to-end"]),
        endEvent("timer-right-end", ["timer-right-to-end"])
      ],
      [
        flow("start-to-choice-left", "start", "choice-left"),
        flow("start-to-choice-right", "start", "choice-right"),
        flow(
          "choice-left-to-message",
          "choice-left",
          "wait-message-left"
        ),
        flow(
          "choice-left-to-timer",
          "choice-left",
          "wait-timer-left"
        ),
        flow(
          "message-left-to-end",
          "wait-message-left",
          "message-left-end"
        ),
        flow(
          "timer-left-to-end",
          "wait-timer-left",
          "timer-left-end"
        ),
        flow(
          "choice-right-to-message",
          "choice-right",
          "wait-message-right"
        ),
        flow(
          "choice-right-to-timer",
          "choice-right",
          "wait-timer-right"
        ),
        flow(
          "message-right-to-end",
          "wait-message-right",
          "message-right-end"
        ),
        flow(
          "timer-right-to-end",
          "wait-timer-right",
          "timer-right-end"
        )
      ],
      [
        { id: leftBinding.messageRef },
        { id: rightBinding.messageRef }
      ]
    )
  }
}

const catchWaitAndBoundTaskDefinition = (): DefinitionFixture => {
  const binding = messageBinding(
    "wait-cleanup-message",
    "cleanup-message",
    "cleanup-correlation"
  )
  return {
    messageBindings: [binding],
    taskBindings: [taskBinding("task-fails")],
    model: model(
      [
        startEvent("start", [
          "start-to-choice",
          "start-to-task"
        ]),
        eventBasedGateway(
          "cleanup-choice",
          "start-to-choice",
          ["choice-to-message", "choice-to-timer"]
        ),
        catchEvent(
          "wait-cleanup-message",
          "choice-to-message",
          "message-to-end",
          {
            _tag: "MessageEventDefinition",
            messageRef: binding.messageRef
          }
        ),
        catchEvent(
          "wait-cleanup-timer",
          "choice-to-timer",
          "timer-to-end",
          {
            _tag: "TimerEventDefinition",
            timeDuration: expression("cleanup-duration")
          }
        ),
        task(
          "task-fails",
          ["start-to-task"],
          ["task-to-end"]
        ),
        endEvent("message-end", ["message-to-end"]),
        endEvent("timer-end", ["timer-to-end"]),
        endEvent("task-end", ["task-to-end"])
      ],
      [
        flow("start-to-choice", "start", "cleanup-choice"),
        flow("start-to-task", "start", "task-fails"),
        flow(
          "choice-to-message",
          "cleanup-choice",
          "wait-cleanup-message"
        ),
        flow(
          "choice-to-timer",
          "cleanup-choice",
          "wait-cleanup-timer"
        ),
        flow(
          "message-to-end",
          "wait-cleanup-message",
          "message-end"
        ),
        flow(
          "timer-to-end",
          "wait-cleanup-timer",
          "timer-end"
        ),
        flow("task-to-end", "task-fails", "task-end")
      ],
      [{ id: binding.messageRef }]
    )
  }
}

const twoTimerChoiceDefinition = (
  leftSource: string,
  rightSource: string
): DefinitionFixture => ({
  messageBindings: [],
  model: model(
    [
      startEvent("start", ["start-to-choice"]),
      eventBasedGateway(
        "choice",
        "start-to-choice",
        ["choice-to-left", "choice-to-right"]
      ),
      catchEvent(
        "wait-left",
        "choice-to-left",
        "left-to-end",
        {
          _tag: "TimerEventDefinition",
          timeDuration: expression(leftSource)
        }
      ),
      catchEvent(
        "wait-right",
        "choice-to-right",
        "right-to-end",
        {
          _tag: "TimerEventDefinition",
          timeDuration: expression(rightSource)
        }
      ),
      endEvent("left-end", ["left-to-end"]),
      endEvent("right-end", ["right-to-end"])
    ],
    [
      flow("start-to-choice", "start", "choice"),
      flow("choice-to-left", "choice", "wait-left"),
      flow("choice-to-right", "choice", "wait-right"),
      flow("left-to-end", "wait-left", "left-end"),
      flow("right-to-end", "wait-right", "right-end")
    ]
  )
})

const prepare = (
  fixture: DefinitionFixture,
  selectedLimits: BpmnKernel.KernelLimits = limits
): Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnKernel.prepare(fixture.model, {
      profileId: "catch-event-kernel-test-v1",
      rootProcessId: processId,
      limits: selectedLimits,
      evaluatorBindings: [evaluatorBinding],
      messageBindings: fixture.messageBindings,
      ...(fixture.taskBindings === undefined
        ? {}
        : { taskBindings: fixture.taskBindings })
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError>

const compile = (
  fixture: DefinitionFixture,
  selectedLimits: BpmnKernel.KernelLimits = limits
): BpmnKernel.CompiledKernel => {
  const compiled = prepare(fixture, selectedLimits)
  if (Result.isFailure(compiled)) {
    throw new Error(JSON.stringify(
      compiled.failure.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path
      })),
      null,
      2
    ))
  }
  return compiled.success
}

const services = (
  now: ProtocolV2Wire.Timestamp,
  values: Readonly<Record<string, Schema.Json>>
): BpmnKernel.Services => ({
  now,
  evaluateExpression: ({ expression }) => {
    if (!(expression.source in values)) {
      throw new Error(`Missing test expression '${expression.source}'`)
    }
    return Result.succeed({
      result: values[expression.source]!,
      steps: 1
    })
  }
})

const initialize = (
  kernel: BpmnKernel.CompiledKernel,
  values: Readonly<Record<string, Schema.Json>>,
  now = startedAt
): BpmnKernel.TransitionBatch => {
  const initialized = BpmnKernel.initialize(
    kernel,
    {
      commandVersion: BpmnKernel.InitializeCommandVersion,
      input: {
        tenantId: "tenant-1",
        orderId: "order-42"
      }
    },
    services(now, values)
  )
  if (Result.isFailure(initialized)) {
    throw new Error(JSON.stringify(initialized.failure.diagnostics, null, 2))
  }
  assert.isTrue(Result.isSuccess(initialized))
  return initialized.success
}

const waitingGroup = (
  state: BpmnExecutionState.BpmnExecutionState
): BpmnExecutionState.CatchWaitGroup => {
  const group = state.catchWaitGroups.find((candidate) => candidate.status === "waiting")
  if (group === undefined) {
    throw new Error("Expected one waiting catch group")
  }
  return group
}

const armForNode = (
  state: BpmnExecutionState.BpmnExecutionState,
  ownerNodeId: string
): BpmnExecutionState.Subscription => {
  const arm = state.subscriptions.find((candidate) => candidate.ownerNodeId === ownerNodeId)
  if (arm === undefined) {
    throw new Error(`Expected catch arm '${ownerNodeId}'`)
  }
  return arm
}

const targetForArm = (
  state: BpmnExecutionState.BpmnExecutionState,
  arm: BpmnExecutionState.Subscription
): BpmnEventV3.CatchArmTarget => {
  const group = state.catchWaitGroups.find((candidate) => candidate.waitGroupId === arm.waitGroupId)
  if (group === undefined) {
    throw new Error(`Expected catch group '${arm.waitGroupId}'`)
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

const messageReceipt = (
  binding: BpmnEventV3.MessageBinding,
  arm: BpmnExecutionState.MessageCatchSubscription,
  acceptedAt: ProtocolV2Wire.Timestamp,
  deliveryId = "delivery-1",
  overrides: Partial<BpmnEventV3.MessageReceipt> = {}
): BpmnEventV3.MessageReceipt => ({
  receiptVersion: 1,
  deliveryId,
  messageRef: binding.messageRef,
  correlationKey: arm.correlationKey,
  payloadContract: binding.payloadContract,
  payload: {
    orderId: "order-42",
    amount: 1250
  },
  acceptedAt,
  authorization: {
    policy: binding.authorizationPolicy,
    decisionId: "decision-1",
    actorId: "trusted-ingress"
  },
  ...overrides
})

const deliver = (
  kernel: BpmnKernel.CompiledKernel,
  state: BpmnExecutionState.BpmnExecutionState,
  binding: BpmnEventV3.MessageBinding,
  arm: BpmnExecutionState.MessageCatchSubscription,
  acceptedAt: ProtocolV2Wire.Timestamp,
  now: ProtocolV2Wire.Timestamp,
  overrides: Partial<BpmnEventV3.MessageReceipt> = {}
): Result.Result<BpmnKernel.TransitionBatch, Diagnostic.CompilationError> =>
  BpmnKernel.deliverMessage(
    kernel,
    state,
    {
      commandVersion: 1,
      target: targetForArm(state, arm),
      receipt: messageReceipt(
        binding,
        arm,
        acceptedAt,
        "delivery-1",
        overrides
      )
    },
    services(now, {})
  )

const assertInvalidCommand = (
  outcome: Result.Result<unknown, Diagnostic.CompilationError>
): void => {
  assert.isTrue(Result.isFailure(outcome))
  if (Result.isSuccess(outcome)) {
    throw new Error("Expected invalid command")
  }
  assert(
    outcome.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidCommand)
  )
}

describe("BpmnKernel catch events", () => {
  it("opens, delivers, replays, and idempotently redelivers one standalone Message catch", () => {
    const fixture = standaloneMessageDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"]
    })
    const group = waitingGroup(initialized.state)
    assert.strictEqual(group.source._tag, "StandaloneCatch")
    const arm = armForNode(initialized.state, binding.catchEventNodeId)
    if (arm._tag !== "MessageCatchSubscription") {
      throw new Error("Expected Message catch arm")
    }
    assert.deepStrictEqual(arm.correlationKey, [
      "tenant-1",
      "order-42"
    ])

    const recordedAt = timestamp("2026-07-24T10:00:01.000Z")
    const acceptedAt = recordedAt
    const delivered = deliver(
      kernel,
      initialized.state,
      binding,
      arm,
      acceptedAt,
      recordedAt
    )
    assert.isTrue(Result.isSuccess(delivered))
    if (Result.isFailure(delivered)) {
      throw delivered.failure
    }
    assert.strictEqual(delivered.success.state.status, "completed")
    const won = delivered.success.state.catchWaitGroups[0]!
    assert.deepStrictEqual(won.winner, {
      _tag: "MessageWinner",
      armId: arm.armId,
      deliveryId: "delivery-1",
      acceptedAt,
      selectedAt: acceptedAt,
      recordedAt
    })

    const journal = [
      ...initialized.events,
      ...delivered.success.events
    ]
    const replayed = BpmnKernel.replay(kernel, journal)
    if (Result.isFailure(replayed)) {
      throw new Error(JSON.stringify(
        {
          diagnostics: replayed.failure.diagnostics,
          tags: journal.map((event) => event._tag)
        },
        null,
        2
      ))
    }
    assert.isTrue(Result.isSuccess(replayed))
    assert.deepStrictEqual(replayed.success, delivered.success.state)

    const duplicate = deliver(
      kernel,
      delivered.success.state,
      binding,
      arm,
      acceptedAt,
      timestamp("2026-07-24T10:00:02.000Z")
    )
    assert.isTrue(Result.isSuccess(duplicate))
    if (Result.isFailure(duplicate)) {
      throw duplicate.failure
    }
    assert.deepStrictEqual(duplicate.success.state, delivered.success.state)
    assert.deepStrictEqual(
      duplicate.success.events.map((event) => event._tag),
      ["CatchIngressReplayed"]
    )
    assertInvalidCommand(deliver(
      kernel,
      delivered.success.state,
      binding,
      arm,
      acceptedAt,
      timestamp("2026-07-24T10:00:02.000Z"),
      {
        payload: {
          orderId: "forged-order"
        }
      }
    ))
  })

  it("arms, observes, and exactly replays one duration Timer catch", () => {
    const fixture = standaloneTimerDefinition(
      "timeDuration",
      "duration-five-seconds"
    )
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      "duration-five-seconds": "PT5S"
    })
    const arm = armForNode(initialized.state, "wait-timer")
    if (arm._tag !== "TimerCatchSubscription") {
      throw new Error("Expected Timer catch arm")
    }
    const timer = initialized.state.timers[0]!
    assert.strictEqual(timer.schedule._tag, "TimeDuration")
    assert.strictEqual(timer.schedule.lexical, "PT5S")
    assert.strictEqual(
      timer.schedule.dueAt,
      timestamp("2026-07-24T10:00:05.000Z")
    )

    const target = targetForArm(initialized.state, arm)
    const acknowledged = BpmnKernel.acknowledgeTimerArm(
      kernel,
      initialized.state,
      {
        commandVersion: 1,
        target,
        timerId: timer.timerId,
        receipt: {
          receiptVersion: 1,
          backendId: "effect-workflow",
          scheduleId: "schedule-1",
          receiptId: "arm-receipt-1",
          armedAt: timestamp("2026-07-24T10:00:00.500Z")
        }
      },
      services(timestamp("2026-07-24T10:00:01.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(acknowledged))
    if (Result.isFailure(acknowledged)) {
      throw acknowledged.failure
    }
    assert.strictEqual(acknowledged.success.state.timers[0]!.status, "armed")

    const armedJournal = [
      ...initialized.events,
      ...acknowledged.success.events
    ]
    const replayedArm = BpmnKernel.replay(kernel, armedJournal)
    assert.isTrue(Result.isSuccess(replayedArm))
    if (Result.isFailure(replayedArm)) {
      throw replayedArm.failure
    }
    assert.deepStrictEqual(replayedArm.success, acknowledged.success.state)

    const observedAt = timestamp("2026-07-24T10:00:05.000Z")
    const observed = BpmnKernel.observeDueTimer(
      kernel,
      acknowledged.success.state,
      {
        commandVersion: 1,
        target,
        timerId: timer.timerId,
        observedAt
      },
      services(timestamp("2026-07-24T10:00:05.500Z"), {})
    )
    assert.isTrue(Result.isSuccess(observed))
    if (Result.isFailure(observed)) {
      throw observed.failure
    }
    assert.strictEqual(observed.success.state.status, "completed")
    assert.strictEqual(
      observed.success.state.catchWaitGroups[0]!.winner?._tag,
      "TimerWinner"
    )
    const replayed = BpmnKernel.replay(kernel, [
      ...armedJournal,
      ...observed.success.events
    ])
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, observed.success.state)
  })

  it("resolves PT0S immediately and preserves a past timeDate while making it immediately eligible", () => {
    const cases = [
      {
        fixture: standaloneTimerDefinition(
          "timeDuration",
          "immediate-duration"
        ),
        values: { "immediate-duration": "PT0S" },
        scheduleTag: "TimeDuration",
        dueAt: startedAt
      },
      {
        fixture: standaloneTimerDefinition("timeDate", "past-date"),
        values: { "past-date": "2026-07-23T09:00:00.000Z" },
        scheduleTag: "TimeDate",
        dueAt: timestamp("2026-07-23T09:00:00.000Z")
      }
    ] as const

    for (const candidate of cases) {
      const kernel = compile(candidate.fixture)
      const initialized = initialize(kernel, candidate.values)
      assert.strictEqual(initialized.state.status, "completed")
      const timer = initialized.state.timers[0]!
      assert.strictEqual(timer.schedule._tag, candidate.scheduleTag)
      assert.strictEqual(timer.schedule.delayMillis, 0)
      assert.strictEqual(timer.schedule.dueAt, candidate.dueAt)
      assert.strictEqual(timer.status, "fired")
      const winner = initialized.state.catchWaitGroups[0]!.winner
      assert.strictEqual(winner?._tag, "TimerWinner")
      if (winner?._tag !== "TimerWinner") {
        throw new Error("Expected immediate Timer winner")
      }
      assert.strictEqual(winner.dueAt, candidate.dueAt)
      assert.strictEqual(winner.selectedAt, startedAt)
      const replayed = BpmnKernel.replay(kernel, initialized.events)
      assert.isTrue(Result.isSuccess(replayed))
      if (Result.isFailure(replayed)) {
        throw replayed.failure
      }
      assert.deepStrictEqual(replayed.success, initialized.state)
    }
  })

  it("bounds Timer expression UTF-8 bytes before persistence and replay", () => {
    const fixture = standaloneTimerDefinition(
      "timeDuration",
      "bounded-duration"
    )
    const kernel = compile(fixture, {
      ...limits,
      maxTimerExpressionUtf8Bytes: 64
    })
    const oversized = BpmnKernel.initialize(
      kernel,
      {
        commandVersion: BpmnKernel.InitializeCommandVersion,
        input: {
          tenantId: "tenant-1",
          orderId: "order-42"
        }
      },
      services(startedAt, {
        "bounded-duration": `PT0.${"0".repeat(65)}S`
      })
    )
    assert.isTrue(Result.isFailure(oversized))
    if (Result.isSuccess(oversized)) {
      throw new Error("Expected Timer expression byte rejection")
    }
    assert(
      oversized.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.InvalidKernelLimits &&
        diagnostic.path.join("/") ===
          "limits/maxTimerExpressionUtf8Bytes"
      )
    )

    const valid = initialize(kernel, {
      "bounded-duration": "PT1S"
    })
    const forgedJournal = structuredClone(valid.events)
    const evaluated = forgedJournal.find((event) => event._tag === "TimerExpressionEvaluated")
    if (evaluated?._tag !== "TimerExpressionEvaluated") {
      throw new Error("Expected TimerExpressionEvaluated")
    }
    evaluated.evaluatedValue = `PT0.${"0".repeat(65)}S`
    const replayed = BpmnKernel.replay(kernel, forgedJournal)
    assert.isTrue(Result.isFailure(replayed))
    if (Result.isSuccess(replayed)) {
      throw new Error("Expected oversized Timer replay rejection")
    }
    assert(
      replayed.failure.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          BpmnKernel.Codes.InvalidTransitionJournal &&
        diagnostic.message.includes("UTF-8 byte limit")
      )
    )

    const normalizationKernel = compile(fixture, {
      ...limits,
      maxTimerExpressionUtf8Bytes: 3
    })
    const persistedTooLarge = BpmnKernel.validateExecutionState(
      normalizationKernel,
      valid.state
    )
    assert.isTrue(Result.isFailure(persistedTooLarge))
    if (Result.isSuccess(persistedTooLarge)) {
      throw new Error("Expected persisted Timer lexical rejection")
    }
    assert(
      persistedTooLarge.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.InvalidKernelState &&
        diagnostic.message.includes("Persisted Timer lexical")
      )
    )
    const normalizedTooLarge = BpmnKernel.initialize(
      normalizationKernel,
      {
        commandVersion: BpmnKernel.InitializeCommandVersion,
        input: null
      },
      services(startedAt, { "bounded-duration": "P0D" })
    )
    assert.isTrue(Result.isFailure(normalizedTooLarge))
  })

  it("opens one atomic Event-Based Gateway group containing Message and Timer arms", () => {
    const fixture = messageTimerChoiceDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"],
      "choice-duration": "PT5S"
    })
    const group = waitingGroup(initialized.state)
    assert.deepStrictEqual(group.source, {
      _tag: "EventBasedGateway",
      gatewayNodeId: "choice"
    })
    assert.lengthOf(group.armIds, 2)
    assert.deepStrictEqual(
      initialized.state.subscriptions.map((arm) => [
        arm.ownerNodeId,
        arm.ordinal,
        arm._tag
      ]),
      [
        ["wait-message", 0, "MessageCatchSubscription"],
        ["wait-timer", 1, "TimerCatchSubscription"]
      ]
    )
    assert.lengthOf(initialized.state.timers, 1)
  })

  for (
    const candidate of [
      {
        label: "before",
        acceptedAt: "2026-07-24T10:00:04.999Z",
        expectedWinner: "MessageWinner"
      },
      {
        label: "exactly at",
        acceptedAt: "2026-07-24T10:00:05.000Z",
        expectedWinner: "TimerWinner"
      },
      {
        label: "after",
        acceptedAt: "2026-07-24T10:00:05.001Z",
        expectedWinner: "TimerWinner"
      }
    ] as const
  ) {
    it(`uses acceptedAt ${candidate.label} the deadline to select the Event-Based Gateway winner`, () => {
      const fixture = messageTimerChoiceDefinition()
      const binding = fixture.messageBindings[0]!
      const kernel = compile(fixture)
      const initialized = initialize(kernel, {
        [binding.correlationExpression.source]: ["tenant-1", "order-42"],
        "choice-duration": "PT5S"
      })
      const arm = armForNode(initialized.state, "wait-message")
      if (arm._tag !== "MessageCatchSubscription") {
        throw new Error("Expected Message catch arm")
      }
      const delivered = deliver(
        kernel,
        initialized.state,
        binding,
        arm,
        timestamp(candidate.acceptedAt),
        timestamp(candidate.acceptedAt)
      )
      assert.isTrue(Result.isSuccess(delivered))
      if (Result.isFailure(delivered)) {
        throw delivered.failure
      }
      assert.strictEqual(
        delivered.success.state.catchWaitGroups[0]!.winner?._tag,
        candidate.expectedWinner
      )
      if (candidate.expectedWinner === "TimerWinner") {
        assert(
          delivered.success.events.some((event) =>
            event._tag === "CatchIngressFenced" &&
            event.ingressKind === "message"
          )
        )
      }
      const replayed = BpmnKernel.replay(kernel, [
        ...initialized.events,
        ...delivered.success.events
      ])
      assert.isTrue(Result.isSuccess(replayed))
      if (Result.isFailure(replayed)) {
        throw replayed.failure
      }
      assert.deepStrictEqual(replayed.success, delivered.success.state)
    })
  }

  it("rejects a backdated acceptance after the Timer deadline and never lets it win", () => {
    const fixture = messageTimerChoiceDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: [
        "tenant-1",
        "order-42"
      ],
      "choice-duration": "PT5S"
    })
    const messageArm = armForNode(initialized.state, "wait-message")
    const timerArm = armForNode(initialized.state, "wait-timer")
    if (
      messageArm._tag !== "MessageCatchSubscription" ||
      timerArm._tag !== "TimerCatchSubscription"
    ) {
      throw new Error("Expected Message and Timer arms")
    }

    const delayed = deliver(
      kernel,
      initialized.state,
      binding,
      messageArm,
      timestamp("2026-07-24T10:00:04.000Z"),
      timestamp("2026-07-24T10:00:06.000Z"),
      { deliveryId: "delayed-delivery" }
    )
    assertInvalidCommand(delayed)
    if (Result.isFailure(delayed)) {
      assert(
        delayed.failure.diagnostics.some((diagnostic) =>
          diagnostic.path.join("/") ===
            "command/receipt/acceptedAt" &&
          diagnostic.message.includes("trusted kernel clock")
        )
      )
    }
    assert.strictEqual(
      initialized.state.catchWaitGroups[0]!.status,
      "waiting"
    )

    const timer = initialized.state.timers.find((candidate) => candidate.armId === timerArm.armId)!
    const observed = BpmnKernel.observeDueTimer(
      kernel,
      initialized.state,
      {
        commandVersion: 1,
        target: targetForArm(initialized.state, timerArm),
        timerId: timer.timerId,
        observedAt: timestamp("2026-07-24T10:00:06.000Z")
      },
      services(timestamp("2026-07-24T10:00:06.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(observed))
    if (Result.isFailure(observed)) {
      throw observed.failure
    }
    assert.strictEqual(
      observed.success.state.catchWaitGroups[0]!.winner?._tag,
      "TimerWinner"
    )
    assert.lengthOf(observed.success.state.messageDeliveries, 0)

    const serializedAfterTimer = deliver(
      kernel,
      observed.success.state,
      binding,
      messageArm,
      timestamp("2026-07-24T10:00:04.000Z"),
      timestamp("2026-07-24T10:00:06.000Z"),
      { deliveryId: "delayed-after-timer" }
    )
    assertInvalidCommand(serializedAfterTimer)
    assert.lengthOf(
      observed.success.state.messageDeliveries,
      0
    )
  })

  it("rejects forged winner, loser, Timer, and owner closure evidence through both validators", () => {
    const fixture = messageTimerChoiceDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: [
        "tenant-1",
        "order-42"
      ],
      "choice-duration": "PT5S"
    })
    const messageArm = armForNode(initialized.state, "wait-message")
    if (messageArm._tag !== "MessageCatchSubscription") {
      throw new Error("Expected Message arm")
    }
    const won = deliver(
      kernel,
      initialized.state,
      binding,
      messageArm,
      timestamp("2026-07-24T10:00:04.000Z"),
      timestamp("2026-07-24T10:00:04.000Z")
    )
    assert.isTrue(Result.isSuccess(won))
    if (Result.isFailure(won)) {
      throw won.failure
    }
    assert.isTrue(
      Result.isSuccess(
        BpmnKernel.validateExecutionState(kernel, won.success.state)
      )
    )
    const group = won.success.state.catchWaitGroups[0]!

    const wonStateTamperers: ReadonlyArray<
      (state: BpmnExecutionState.BpmnExecutionState) => void
    > = [
      (state) => {
        const token = state.tokens.find((candidate) => candidate.tokenId === group.ownerTokenId)!
        token.consumedAt = timestamp("2026-07-24T10:00:04.001Z")
      },
      (state) => {
        const arm = state.subscriptions.find((candidate) => candidate.armId === group.winner!.armId)!
        arm.closedAt = timestamp("2026-07-24T10:00:04.001Z")
      },
      (state) => {
        const arm = state.subscriptions.find((candidate) =>
          candidate.waitGroupId === group.waitGroupId &&
          candidate.armId !== group.winner!.armId
        )!
        arm.cancellationReason = "scope-cancelled"
      },
      (state) => {
        const timer = state.timers.find((candidate) => candidate.waitGroupId === group.waitGroupId)!
        timer.cancelledAt = timestamp("2026-07-24T10:00:04.001Z")
      },
      (state) => {
        const timer = state.timers.find((candidate) => candidate.waitGroupId === group.waitGroupId)!
        timer.cancellationReason = "scope-cancelled"
      }
    ]
    for (const tamper of wonStateTamperers) {
      const forged = structuredClone(won.success.state)
      tamper(forged)
      const structural = BpmnExecutionState.validate(
        fixture.model,
        forged
      )
      assert.isTrue(Result.isFailure(structural))
      if (Result.isSuccess(structural)) {
        throw new Error("Expected won catch-state rejection")
      }
      assert(
        structural.failure.diagnostics.some((diagnostic) =>
          diagnostic.code ===
            BpmnExecutionState.Codes.InvalidCatchWaitGroup ||
          diagnostic.code === BpmnExecutionState.Codes.InvalidSubscription ||
          diagnostic.code === BpmnExecutionState.Codes.InvalidTimer
        )
      )
      assert.isTrue(
        Result.isFailure(
          BpmnKernel.validateExecutionState(kernel, forged)
        )
      )
    }
  })

  it("selects the earliest eligible Timer even when a later Timer was observed", () => {
    const fixture = twoTimerChoiceDefinition(
      "later-duration",
      "earlier-duration"
    )
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      "later-duration": "PT5S",
      "earlier-duration": "PT3S"
    })
    const laterArm = armForNode(initialized.state, "wait-left")
    if (laterArm._tag !== "TimerCatchSubscription") {
      throw new Error("Expected later Timer arm")
    }
    const laterTimer = initialized.state.timers.find((timer) => timer.armId === laterArm.armId)!
    const observed = BpmnKernel.observeDueTimer(
      kernel,
      initialized.state,
      {
        commandVersion: 1,
        target: targetForArm(initialized.state, laterArm),
        timerId: laterTimer.timerId,
        observedAt: timestamp("2026-07-24T10:00:05.000Z")
      },
      services(timestamp("2026-07-24T10:00:05.500Z"), {})
    )
    assert.isTrue(Result.isSuccess(observed))
    if (Result.isFailure(observed)) {
      throw observed.failure
    }
    const winner = observed.success.state.catchWaitGroups[0]!.winner
    assert.strictEqual(winner?._tag, "TimerWinner")
    if (winner?._tag !== "TimerWinner") {
      throw new Error("Expected Timer winner")
    }
    assert.strictEqual(
      initialized.state.subscriptions.find((arm) => arm.armId === winner.armId)?.ownerNodeId,
      "wait-right"
    )
    assert.strictEqual(
      winner.selectedAt,
      timestamp("2026-07-24T10:00:03.000Z")
    )
  })

  it("breaks equal Timer deadlines by immutable branch ordinal", () => {
    const fixture = twoTimerChoiceDefinition(
      "left-duration",
      "right-duration"
    )
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      "left-duration": "PT5S",
      "right-duration": "PT5S"
    })
    const rightArm = armForNode(initialized.state, "wait-right")
    if (rightArm._tag !== "TimerCatchSubscription") {
      throw new Error("Expected right Timer arm")
    }
    const rightTimer = initialized.state.timers.find((timer) => timer.armId === rightArm.armId)!
    const observed = BpmnKernel.observeDueTimer(
      kernel,
      initialized.state,
      {
        commandVersion: 1,
        target: targetForArm(initialized.state, rightArm),
        timerId: rightTimer.timerId,
        observedAt: timestamp("2026-07-24T10:00:05.000Z")
      },
      services(timestamp("2026-07-24T10:00:05.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(observed))
    if (Result.isFailure(observed)) {
      throw observed.failure
    }
    const winner = observed.success.state.catchWaitGroups[0]!.winner
    assert.strictEqual(winner?._tag, "TimerWinner")
    if (winner?._tag !== "TimerWinner") {
      throw new Error("Expected Timer winner")
    }
    const winningArm = initialized.state.subscriptions.find((arm) => arm.armId === winner.armId)
    assert.strictEqual(winningArm?.ownerNodeId, "wait-left")
    assert.strictEqual(winningArm?.ordinal, 0)
  })

  it("makes Timer arm receipts idempotent while rejecting conflicts and cross-arm identity reuse", () => {
    const fixture = twoTimerChoiceDefinition(
      "left-duration",
      "right-duration"
    )
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      "left-duration": "PT5S",
      "right-duration": "PT6S"
    })
    const leftArm = armForNode(initialized.state, "wait-left")
    const rightArm = armForNode(initialized.state, "wait-right")
    if (
      leftArm._tag !== "TimerCatchSubscription" ||
      rightArm._tag !== "TimerCatchSubscription"
    ) {
      throw new Error("Expected two Timer arms")
    }
    const leftTimer = initialized.state.timers.find((timer) => timer.armId === leftArm.armId)!
    const rightTimer = initialized.state.timers.find((timer) => timer.armId === rightArm.armId)!
    const leftTarget = targetForArm(initialized.state, leftArm)
    const receipt = {
      receiptVersion: 1 as const,
      backendId: "effect-workflow",
      scheduleId: "schedule-shared",
      receiptId: "receipt-left",
      armedAt: timestamp("2026-07-24T10:00:00.500Z")
    }
    const acknowledged = BpmnKernel.acknowledgeTimerArm(
      kernel,
      initialized.state,
      {
        commandVersion: 1,
        target: leftTarget,
        timerId: leftTimer.timerId,
        receipt
      },
      services(timestamp("2026-07-24T10:00:01.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(acknowledged))
    if (Result.isFailure(acknowledged)) {
      throw acknowledged.failure
    }

    const replayed = BpmnKernel.acknowledgeTimerArm(
      kernel,
      acknowledged.success.state,
      {
        commandVersion: 1,
        target: leftTarget,
        timerId: leftTimer.timerId,
        receipt
      },
      services(timestamp("2026-07-24T10:00:02.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success.state, acknowledged.success.state)
    assert.deepStrictEqual(
      replayed.success.events.map((event) => event._tag),
      ["CatchIngressReplayed"]
    )

    assertInvalidCommand(BpmnKernel.acknowledgeTimerArm(
      kernel,
      acknowledged.success.state,
      {
        commandVersion: 1,
        target: leftTarget,
        timerId: leftTimer.timerId,
        receipt: {
          ...receipt,
          receiptId: "conflicting-left-receipt"
        }
      },
      services(timestamp("2026-07-24T10:00:02.000Z"), {})
    ))

    assertInvalidCommand(BpmnKernel.acknowledgeTimerArm(
      kernel,
      acknowledged.success.state,
      {
        commandVersion: 1,
        target: targetForArm(acknowledged.success.state, rightArm),
        timerId: rightTimer.timerId,
        receipt: {
          ...receipt,
          receiptId: "receipt-right"
        }
      },
      services(timestamp("2026-07-24T10:00:02.000Z"), {})
    ))

    const replayedJournal = BpmnKernel.replay(kernel, [
      ...initialized.events,
      ...acknowledged.success.events,
      ...replayed.success.events
    ])
    assert.isTrue(Result.isSuccess(replayedJournal))
    if (Result.isFailure(replayedJournal)) {
      throw replayedJournal.failure
    }
    assert.deepStrictEqual(
      replayedJournal.success,
      acknowledged.success.state
    )
  })

  it("fences a late Timer loser after Message victory and replays the no-state-change audit", () => {
    const fixture = messageTimerChoiceDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"],
      "choice-duration": "PT5S"
    })
    const messageArm = armForNode(initialized.state, "wait-message")
    const timerArm = armForNode(initialized.state, "wait-timer")
    if (
      messageArm._tag !== "MessageCatchSubscription" ||
      timerArm._tag !== "TimerCatchSubscription"
    ) {
      throw new Error("Expected Message and Timer arms")
    }
    const timer = initialized.state.timers[0]!
    const delivered = deliver(
      kernel,
      initialized.state,
      binding,
      messageArm,
      timestamp("2026-07-24T10:00:04.500Z"),
      timestamp("2026-07-24T10:00:04.500Z")
    )
    assert.isTrue(Result.isSuccess(delivered))
    if (Result.isFailure(delivered)) {
      throw delivered.failure
    }

    const lateTimer = BpmnKernel.observeDueTimer(
      kernel,
      delivered.success.state,
      {
        commandVersion: 1,
        target: targetForArm(initialized.state, timerArm),
        timerId: timer.timerId,
        observedAt: timestamp("2026-07-24T10:00:05.000Z")
      },
      services(timestamp("2026-07-24T10:00:06.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(lateTimer))
    if (Result.isFailure(lateTimer)) {
      throw lateTimer.failure
    }
    assert.deepStrictEqual(lateTimer.success.state, delivered.success.state)
    assert.deepStrictEqual(
      lateTimer.success.events.map((event) =>
        event._tag === "CatchIngressFenced"
          ? [event._tag, event.ingressKind, event.reason]
          : [event._tag]
      ),
      [["CatchIngressFenced", "timer-observation", "wait-closed"]]
    )

    const replayed = BpmnKernel.replay(kernel, [
      ...initialized.events,
      ...delivered.success.events,
      ...lateTimer.success.events
    ])
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, delivered.success.state)
  })

  it("fences a late Message loser and idempotently replays the winning Timer observation", () => {
    const fixture = messageTimerChoiceDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"],
      "choice-duration": "PT5S"
    })
    const messageArm = armForNode(initialized.state, "wait-message")
    const timerArm = armForNode(initialized.state, "wait-timer")
    if (
      messageArm._tag !== "MessageCatchSubscription" ||
      timerArm._tag !== "TimerCatchSubscription"
    ) {
      throw new Error("Expected Message and Timer arms")
    }
    const timer = initialized.state.timers[0]!
    const timerTarget = targetForArm(initialized.state, timerArm)
    const timerCommand = {
      commandVersion: 1 as const,
      target: timerTarget,
      timerId: timer.timerId,
      observedAt: timestamp("2026-07-24T10:00:05.000Z")
    }
    const observed = BpmnKernel.observeDueTimer(
      kernel,
      initialized.state,
      timerCommand,
      services(timestamp("2026-07-24T10:00:05.500Z"), {})
    )
    assert.isTrue(Result.isSuccess(observed))
    if (Result.isFailure(observed)) {
      throw observed.failure
    }

    const lateMessage = deliver(
      kernel,
      observed.success.state,
      binding,
      messageArm,
      timestamp("2026-07-24T10:00:06.000Z"),
      timestamp("2026-07-24T10:00:06.000Z"),
      { deliveryId: "late-delivery" }
    )
    assert.isTrue(Result.isSuccess(lateMessage))
    if (Result.isFailure(lateMessage)) {
      throw lateMessage.failure
    }
    assert.deepStrictEqual(lateMessage.success.state, observed.success.state)
    assert.deepStrictEqual(
      lateMessage.success.events.map((event) =>
        event._tag === "CatchIngressFenced"
          ? [event._tag, event.ingressKind, event.reason]
          : [event._tag]
      ),
      [["CatchIngressFenced", "message", "wait-closed"]]
    )

    const duplicateTimer = BpmnKernel.observeDueTimer(
      kernel,
      lateMessage.success.state,
      timerCommand,
      services(timestamp("2026-07-24T10:00:07.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(duplicateTimer))
    if (Result.isFailure(duplicateTimer)) {
      throw duplicateTimer.failure
    }
    assert.deepStrictEqual(
      duplicateTimer.success.state,
      observed.success.state
    )
    assert.deepStrictEqual(
      duplicateTimer.success.events.map((event) => event._tag),
      ["CatchIngressReplayed"]
    )

    const replayed = BpmnKernel.replay(kernel, [
      ...initialized.events,
      ...observed.success.events,
      ...lateMessage.success.events,
      ...duplicateTimer.success.events
    ])
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, observed.success.state)
  })

  it("consumes a Timer-preempted delivery globally across catch activations and replays its exact ledger", () => {
    const fixture = parallelMessageTimerChoicesDefinition()
    const [leftBinding, rightBinding] = fixture.messageBindings
    if (leftBinding === undefined || rightBinding === undefined) {
      throw new Error("Expected two Message bindings")
    }
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [leftBinding.correlationExpression.source]: [
        "tenant-1",
        "left-order"
      ],
      [rightBinding.correlationExpression.source]: [
        "tenant-1",
        "right-order"
      ],
      "left-duration": "PT5S",
      "right-duration": "PT5S"
    })
    assert.lengthOf(
      initialized.state.catchWaitGroups.filter((group) => group.status === "waiting"),
      2
    )
    const leftArm = armForNode(initialized.state, "wait-message-left")
    const rightArm = armForNode(initialized.state, "wait-message-right")
    if (
      leftArm._tag !== "MessageCatchSubscription" ||
      rightArm._tag !== "MessageCatchSubscription"
    ) {
      throw new Error("Expected two Message arms")
    }
    const leftTarget = targetForArm(initialized.state, leftArm)
    const receipt = messageReceipt(
      leftBinding,
      leftArm,
      timestamp("2026-07-24T10:00:06.000Z"),
      "delivery-shared"
    )
    const command = {
      commandVersion: 1 as const,
      target: leftTarget,
      receipt
    }
    const preempted = BpmnKernel.deliverMessage(
      kernel,
      initialized.state,
      command,
      services(timestamp("2026-07-24T10:00:06.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(preempted))
    if (Result.isFailure(preempted)) {
      throw preempted.failure
    }
    assert.strictEqual(preempted.success.state.status, "active")
    assert.deepStrictEqual(preempted.success.state.messageDeliveries, [{
      target: leftTarget,
      receipt,
      disposition: "timer-preempted",
      recordedAt: timestamp("2026-07-24T10:00:06.000Z")
    }])
    const leftGroup = preempted.success.state.catchWaitGroups.find(
      (group) => group.waitGroupId === leftTarget.waitGroupId
    )
    assert.strictEqual(leftGroup?.winner?._tag, "TimerWinner")
    const retainedLeftArm = preempted.success.state.subscriptions.find(
      (arm) => arm.armId === leftArm.armId
    )
    if (retainedLeftArm?._tag !== "MessageCatchSubscription") {
      throw new Error("Expected retained losing Message arm")
    }
    assert.isUndefined(retainedLeftArm.receipt)

    const journal = [
      ...initialized.events,
      ...preempted.success.events
    ]
    const replayed = BpmnKernel.replay(kernel, journal)
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, preempted.success.state)

    const duplicate = BpmnKernel.deliverMessage(
      kernel,
      preempted.success.state,
      command,
      services(timestamp("2026-07-24T10:00:07.000Z"), {})
    )
    assert.isTrue(Result.isSuccess(duplicate))
    if (Result.isFailure(duplicate)) {
      throw duplicate.failure
    }
    assert.deepStrictEqual(duplicate.success.state, preempted.success.state)
    assert.deepStrictEqual(
      duplicate.success.events.map((event) => event._tag),
      ["CatchIngressReplayed"]
    )
    const replayedDuplicate = BpmnKernel.replay(kernel, [
      ...journal,
      ...duplicate.success.events
    ])
    assert.isTrue(Result.isSuccess(replayedDuplicate))
    if (Result.isFailure(replayedDuplicate)) {
      throw replayedDuplicate.failure
    }
    assert.deepStrictEqual(
      replayedDuplicate.success,
      preempted.success.state
    )

    const reusedAgainstOtherActivation = BpmnKernel.deliverMessage(
      kernel,
      preempted.success.state,
      {
        commandVersion: 1,
        target: targetForArm(preempted.success.state, rightArm),
        receipt: messageReceipt(
          rightBinding,
          rightArm,
          timestamp("2026-07-24T10:00:04.000Z"),
          receipt.deliveryId
        )
      },
      services(timestamp("2026-07-24T10:00:07.000Z"), {})
    )
    assertInvalidCommand(reusedAgainstOtherActivation)

    const forgedDisposition = structuredClone(preempted.success.state)
    forgedDisposition.messageDeliveries[0]!.disposition = "message-winner"
    const rejectedDisposition = BpmnExecutionState.validate(
      fixture.model,
      forgedDisposition
    )
    assert.isTrue(Result.isFailure(rejectedDisposition))
    if (Result.isSuccess(rejectedDisposition)) {
      throw new Error("Expected forged delivery disposition rejection")
    }
    assert(
      rejectedDisposition.failure.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          BpmnExecutionState.Codes.InvalidMessageDelivery
      )
    )

    const resolutionIndex = journal.findIndex((event) =>
      event._tag === "CatchWaitResolved" &&
      event.trigger._tag === "MessageDelivery"
    )
    const resolution = journal[resolutionIndex]!
    if (
      resolution?._tag !== "CatchWaitResolved" ||
      resolution.trigger._tag !== "MessageDelivery"
    ) {
      throw new Error("Expected Timer-preempted Message resolution")
    }
    const forgedReceiptJournal = structuredClone(journal)
    forgedReceiptJournal[resolutionIndex] = {
      ...resolution,
      trigger: {
        ...resolution.trigger,
        receipt: {
          ...resolution.trigger.receipt,
          payloadContract: {
            ...resolution.trigger.receipt.payloadContract,
            codecKey: "forged-codec"
          }
        }
      }
    }
    assert.isTrue(
      Result.isFailure(
        BpmnKernel.replay(kernel, forgedReceiptJournal)
      )
    )
  })

  it("causally cancels an open catch choice when parallel protocol-v3 work fails terminally", () => {
    const fixture = catchWaitAndBoundTaskDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: [
        "tenant-1",
        "cleanup-order"
      ],
      "cleanup-duration": "PT30S"
    })
    const group = waitingGroup(initialized.state)
    const ownerToken = initialized.state.tokens.find((candidate) => candidate.tokenId === group.ownerTokenId)
    const taskToken = initialized.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task-fails"
    )
    if (ownerToken === undefined || taskToken === undefined) {
      throw new Error("Expected parallel catch-owner and bound-Task tokens")
    }
    assert.strictEqual(ownerToken.status, "active")
    assert.lengthOf(group.armIds, 2)
    assert.lengthOf(
      initialized.state.timers.filter((timer) => timer.waitGroupId === group.waitGroupId),
      1
    )

    const failedAt = timestamp("2026-07-24T10:00:01.000Z")
    const resolved = BpmnKernel.resolveTask(
      kernel,
      initialized.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        scopeInstanceId: taskToken.scopeInstanceId,
        taskNodeId: "task-fails",
        tokenId: taskToken.tokenId,
        outcome: unmappedBusinessFailure()
      },
      services(failedAt, {})
    )
    assert.isTrue(Result.isSuccess(resolved))
    if (Result.isFailure(resolved)) {
      throw resolved.failure
    }
    assert.strictEqual(resolved.success.state.status, "failed")
    assert.strictEqual(resolved.success.state.completedAt, failedAt)

    const cancelledGroup = resolved.success.state.catchWaitGroups.find(
      (candidate) => candidate.waitGroupId === group.waitGroupId
    )
    assert.deepStrictEqual(cancelledGroup, {
      ...group,
      status: "cancelled",
      cancellationReason: "execution-failed",
      closedAt: failedAt
    })
    const cancelledArms = resolved.success.state.subscriptions.filter(
      (arm) => arm.waitGroupId === group.waitGroupId
    )
    assert.lengthOf(cancelledArms, group.armIds.length)
    assert(
      cancelledArms.every((arm) =>
        arm.status === "cancelled" &&
        arm.cancellationReason === "execution-failed" &&
        arm.closedAt === failedAt
      )
    )
    const cancelledTimers = resolved.success.state.timers.filter(
      (timer) => timer.waitGroupId === group.waitGroupId
    )
    assert.lengthOf(cancelledTimers, 1)
    assert(
      cancelledTimers.every((timer) =>
        timer.status === "cancelled" &&
        timer.cancellationReason === "execution-failed" &&
        timer.cancelledAt === failedAt
      )
    )
    const withdrawnOwner = resolved.success.state.tokens.find(
      (candidate) => candidate.tokenId === group.ownerTokenId
    )
    assert.strictEqual(withdrawnOwner?.status, "withdrawn")
    assert.strictEqual(withdrawnOwner?.consumedAt, failedAt)
    assert(
      resolved.success.state.tokens.every((token) => token.status !== "active")
    )

    const cancellationIndex = resolved.success.events.findIndex((event) => event._tag === "CatchWaitCancelled")
    const ownerWithdrawalIndex = resolved.success.events.findIndex(
      (event) =>
        event._tag === "TokenWithdrawn" &&
        event.tokenId === group.ownerTokenId
    )
    const terminalIndex = resolved.success.events.findIndex((event) => event._tag === "ExecutionFailed")
    assert.isAtLeast(cancellationIndex, 0)
    assert.isAtLeast(ownerWithdrawalIndex, 0)
    assert.isAtLeast(terminalIndex, 0)
    assert.isBelow(ownerWithdrawalIndex, cancellationIndex)
    assert.isBelow(cancellationIndex, terminalIndex)
    const cancellation = resolved.success.events[cancellationIndex]!
    if (cancellation?._tag !== "CatchWaitCancelled") {
      throw new Error("Expected CatchWaitCancelled")
    }
    assert.deepStrictEqual(cancellation, {
      _tag: "CatchWaitCancelled",
      waitGroupId: group.waitGroupId,
      reason: "execution-failed",
      armIds: group.armIds,
      timerIds: cancelledTimers.map((timer) => timer.timerId),
      cancelledAt: failedAt
    })
    const terminal = resolved.success.events[terminalIndex]!
    assert(
      terminal._tag === "ExecutionFailed" &&
        terminal.failureKind === "UnmappedBusinessFailure" &&
        terminal.taskNodeId === "task-fails"
    )

    const journal = [
      ...initialized.events,
      ...resolved.success.events
    ]
    const replayed = BpmnKernel.replay(kernel, journal)
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, resolved.success.state)
    assert.isTrue(
      Result.isSuccess(
        BpmnKernel.validateExecutionState(
          kernel,
          resolved.success.state
        )
      )
    )

    const cancelledStateTamperers: ReadonlyArray<
      (state: BpmnExecutionState.BpmnExecutionState) => void
    > = [
      (state) => {
        const timer = state.timers.find((candidate) => candidate.waitGroupId === group.waitGroupId)!
        timer.cancelledAt = timestamp("2026-07-24T10:00:02.000Z")
      },
      (state) => {
        const timer = state.timers.find((candidate) => candidate.waitGroupId === group.waitGroupId)!
        timer.cancellationReason = "scope-cancelled"
      },
      (state) => {
        const arm = state.subscriptions.find((candidate) => candidate.waitGroupId === group.waitGroupId)!
        arm.closedAt = timestamp("2026-07-24T10:00:02.000Z")
      },
      (state) => {
        const arm = state.subscriptions.find((candidate) => candidate.waitGroupId === group.waitGroupId)!
        arm.cancellationReason = "scope-cancelled"
      },
      (state) => {
        const token = state.tokens.find((candidate) => candidate.tokenId === group.ownerTokenId)!
        token.consumedAt = timestamp("2026-07-24T10:00:02.000Z")
      }
    ]
    for (const tamper of cancelledStateTamperers) {
      const forged = structuredClone(resolved.success.state)
      tamper(forged)
      const structural = BpmnExecutionState.validate(
        fixture.model,
        forged
      )
      assert.isTrue(Result.isFailure(structural))
      if (Result.isSuccess(structural)) {
        throw new Error("Expected cancelled catch-state rejection")
      }
      assert(
        structural.failure.diagnostics.some((diagnostic) =>
          diagnostic.code ===
            BpmnExecutionState.Codes.InvalidCatchWaitGroup ||
          diagnostic.code === BpmnExecutionState.Codes.InvalidSubscription ||
          diagnostic.code === BpmnExecutionState.Codes.InvalidTimer
        )
      )
      assert.isTrue(
        Result.isFailure(
          BpmnKernel.validateExecutionState(kernel, forged)
        )
      )
    }

    const absoluteCancellationIndex = initialized.events.length +
      cancellationIndex
    const tampered = structuredClone(journal)
    const tamperedCancellation = tampered[absoluteCancellationIndex]!
    if (tamperedCancellation?._tag !== "CatchWaitCancelled") {
      throw new Error("Expected replay cancellation event")
    }
    tampered[absoluteCancellationIndex] = {
      ...tamperedCancellation,
      reason: "execution-cancelled"
    }
    assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, tampered)))

    const reordered = structuredClone(journal)
    const [movedCancellation] = reordered.splice(
      absoluteCancellationIndex,
      1
    )
    if (movedCancellation === undefined) {
      throw new Error("Expected movable cancellation event")
    }
    const reorderedTerminalIndex = reordered.findIndex((event) => event._tag === "ExecutionFailed")
    reordered.splice(
      reorderedTerminalIndex,
      0,
      movedCancellation
    )
    assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, reordered)))

    const truncated = journal.slice(0, absoluteCancellationIndex + 1)
    assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, truncated)))
  })

  it("fences every forged target coordinate and generation without mutating the waiting state", () => {
    const fixture = standaloneMessageDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"]
    })
    const arm = armForNode(initialized.state, binding.catchEventNodeId)
    if (arm._tag !== "MessageCatchSubscription") {
      throw new Error("Expected Message catch arm")
    }
    const exactTarget = targetForArm(initialized.state, arm)
    const forgedTargets: ReadonlyArray<BpmnEventV3.CatchArmTarget> = [
      {
        ...exactTarget,
        generation: exactTarget.generation + 1
      },
      {
        ...exactTarget,
        waitGroupId: "forged-wait-group"
      },
      {
        ...exactTarget,
        armId: "forged-arm"
      },
      {
        ...exactTarget,
        scopeInstanceId: "forged-scope"
      },
      {
        ...exactTarget,
        catchEventNodeId: "forged-catch"
      },
      {
        ...exactTarget,
        tokenId: "forged-token"
      }
    ]
    for (let index = 0; index < forgedTargets.length; index++) {
      const target = forgedTargets[index]!
      const deliveryId = `forged-target-delivery-${index}`
      const fenced = BpmnKernel.deliverMessage(
        kernel,
        initialized.state,
        {
          commandVersion: 1,
          target,
          receipt: messageReceipt(
            binding,
            arm,
            timestamp("2026-07-24T10:00:01.000Z"),
            deliveryId
          )
        },
        services(timestamp("2026-07-24T10:00:01.000Z"), {})
      )
      assert.isTrue(Result.isSuccess(fenced))
      if (Result.isFailure(fenced)) {
        throw fenced.failure
      }
      assert.deepStrictEqual(fenced.success.state, initialized.state)
      assert.deepStrictEqual(fenced.success.events, [{
        _tag: "CatchIngressFenced",
        ingressKind: "message",
        target,
        externalId: deliveryId,
        reason: "stale-generation",
        observedAt: timestamp("2026-07-24T10:00:01.000Z")
      }])
    }
  })

  it("rejects wrong correlation, payload bounds, policy pins, and future acceptance", () => {
    const fixture = standaloneMessageDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture, {
      ...limits,
      maxMessagePayloadCanonicalBytes: 64
    })
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"]
    })
    const arm = armForNode(initialized.state, binding.catchEventNodeId)
    if (arm._tag !== "MessageCatchSubscription") {
      throw new Error("Expected Message catch arm")
    }
    const observedAt = timestamp("2026-07-24T10:00:01.000Z")
    const acceptedAt = observedAt
    const invalidReceipts: ReadonlyArray<
      Partial<BpmnEventV3.MessageReceipt>
    > = [
      {
        correlationKey: ["tenant-1", "another-order"]
      },
      {
        payload: {
          text: "x".repeat(128)
        }
      },
      {
        payloadContract: {
          ...binding.payloadContract,
          codecKey: "forged-payload-codec"
        }
      },
      {
        authorization: {
          policy: {
            ...binding.authorizationPolicy,
            deploymentId: "forged-deployment"
          },
          decisionId: "decision-1",
          actorId: "trusted-ingress"
        }
      },
      {
        acceptedAt: timestamp("2026-07-24T10:00:02.000Z")
      }
    ]
    for (const overrides of invalidReceipts) {
      assertInvalidCommand(deliver(
        kernel,
        initialized.state,
        binding,
        arm,
        acceptedAt,
        observedAt,
        overrides
      ))
    }
  })

  it("rejects forged Message and non-minimal Timer winners during replay", () => {
    const messageFixture = messageTimerChoiceDefinition()
    const messageBinding = messageFixture.messageBindings[0]!
    const messageKernel = compile(messageFixture)
    const messageInitialized = initialize(messageKernel, {
      [messageBinding.correlationExpression.source]: [
        "tenant-1",
        "order-42"
      ],
      "choice-duration": "PT5S"
    })
    const messageArm = armForNode(
      messageInitialized.state,
      "wait-message"
    )
    const timerArm = armForNode(messageInitialized.state, "wait-timer")
    if (
      messageArm._tag !== "MessageCatchSubscription" ||
      timerArm._tag !== "TimerCatchSubscription"
    ) {
      throw new Error("Expected Message and Timer arms")
    }
    const timer = messageInitialized.state.timers[0]!
    const afterDeadline = deliver(
      messageKernel,
      messageInitialized.state,
      messageBinding,
      messageArm,
      timestamp("2026-07-24T10:00:06.000Z"),
      timestamp("2026-07-24T10:00:06.000Z")
    )
    assert.isTrue(Result.isSuccess(afterDeadline))
    if (Result.isFailure(afterDeadline)) {
      throw afterDeadline.failure
    }
    const messageJournal = [
      ...messageInitialized.events,
      ...afterDeadline.success.events
    ]
    const messageResolutionIndex = messageJournal.findIndex((event) => event._tag === "CatchWaitResolved")
    const messageResolution = messageJournal[messageResolutionIndex]!
    if (
      messageResolution?._tag !== "CatchWaitResolved" ||
      messageResolution.trigger._tag !== "MessageDelivery"
    ) {
      throw new Error("Expected Message-triggered Timer resolution")
    }
    const forgedMessageJournal = structuredClone(messageJournal)
    forgedMessageJournal[messageResolutionIndex] = {
      ...messageResolution,
      winner: {
        _tag: "MessageWinner",
        armId: messageArm.armId,
        deliveryId: messageResolution.trigger.receipt.deliveryId,
        acceptedAt: messageResolution.trigger.receipt.acceptedAt,
        selectedAt: messageResolution.trigger.receipt.acceptedAt,
        recordedAt: messageResolution.closedAt
      },
      cancelledArmIds: [timerArm.armId],
      cancelledTimerIds: [timer.timerId]
    }
    assert.isTrue(
      Result.isFailure(
        BpmnKernel.replay(messageKernel, forgedMessageJournal)
      )
    )

    const timerFixture = twoTimerChoiceDefinition(
      "later-duration",
      "earlier-duration"
    )
    const timerKernel = compile(timerFixture)
    const timerInitialized = initialize(timerKernel, {
      "later-duration": "PT5S",
      "earlier-duration": "PT3S"
    })
    const laterArm = armForNode(timerInitialized.state, "wait-left")
    const earlierArm = armForNode(timerInitialized.state, "wait-right")
    if (
      laterArm._tag !== "TimerCatchSubscription" ||
      earlierArm._tag !== "TimerCatchSubscription"
    ) {
      throw new Error("Expected two Timer arms")
    }
    const laterTimer = timerInitialized.state.timers.find((candidate) => candidate.armId === laterArm.armId)!
    const earlierTimer = timerInitialized.state.timers.find((candidate) => candidate.armId === earlierArm.armId)!
    const timerObserved = BpmnKernel.observeDueTimer(
      timerKernel,
      timerInitialized.state,
      {
        commandVersion: 1,
        target: targetForArm(timerInitialized.state, laterArm),
        timerId: laterTimer.timerId,
        observedAt: timestamp("2026-07-24T10:00:05.000Z")
      },
      services(timestamp("2026-07-24T10:00:05.500Z"), {})
    )
    assert.isTrue(Result.isSuccess(timerObserved))
    if (Result.isFailure(timerObserved)) {
      throw timerObserved.failure
    }
    const timerJournal = [
      ...timerInitialized.events,
      ...timerObserved.success.events
    ]
    const timerResolutionIndex = timerJournal.findIndex((event) => event._tag === "CatchWaitResolved")
    const timerResolution = timerJournal[timerResolutionIndex]!
    if (
      timerResolution?._tag !== "CatchWaitResolved" ||
      timerResolution.trigger._tag !== "TimerObservation"
    ) {
      throw new Error("Expected observed Timer resolution")
    }
    const forgedTimerJournal = structuredClone(timerJournal)
    forgedTimerJournal[timerResolutionIndex] = {
      ...timerResolution,
      winner: {
        _tag: "TimerWinner",
        armId: laterArm.armId,
        timerId: laterTimer.timerId,
        dueAt: laterTimer.schedule.dueAt,
        observedAt: timerResolution.trigger.observedAt,
        selectedAt: laterTimer.schedule.dueAt,
        recordedAt: timerResolution.closedAt
      },
      cancelledArmIds: [earlierArm.armId],
      cancelledTimerIds: [earlierTimer.timerId]
    }
    assert.isTrue(
      Result.isFailure(
        BpmnKernel.replay(timerKernel, forgedTimerJournal)
      )
    )
  })

  it("rejects tampered and causally truncated catch-event journals", () => {
    const fixture = standaloneMessageDefinition()
    const binding = fixture.messageBindings[0]!
    const kernel = compile(fixture)
    const initialized = initialize(kernel, {
      [binding.correlationExpression.source]: ["tenant-1", "order-42"]
    })
    const arm = armForNode(initialized.state, binding.catchEventNodeId)
    if (arm._tag !== "MessageCatchSubscription") {
      throw new Error("Expected Message catch arm")
    }
    const delivered = deliver(
      kernel,
      initialized.state,
      binding,
      arm,
      timestamp("2026-07-24T10:00:01.000Z"),
      timestamp("2026-07-24T10:00:01.000Z")
    )
    assert.isTrue(Result.isSuccess(delivered))
    if (Result.isFailure(delivered)) {
      throw delivered.failure
    }
    const journal = [
      ...initialized.events,
      ...delivered.success.events
    ]
    const resolutionIndex = journal.findIndex((event) => event._tag === "CatchWaitResolved")
    assert.isAtLeast(resolutionIndex, 0)
    const resolution = journal[resolutionIndex]!
    if (
      resolution._tag !== "CatchWaitResolved" ||
      resolution.winner._tag !== "MessageWinner"
    ) {
      throw new Error("Expected Message resolution")
    }
    const tampered = structuredClone(journal)
    tampered[resolutionIndex] = {
      ...resolution,
      winner: {
        ...resolution.winner,
        deliveryId: "forged-delivery"
      }
    }
    assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, tampered)))

    const truncated = journal.slice(0, resolutionIndex + 1)
    assert.isTrue(Result.isFailure(BpmnKernel.replay(kernel, truncated)))
  })
})
