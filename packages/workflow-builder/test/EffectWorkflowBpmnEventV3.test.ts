import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeClock from "effect/unstable/workflow/DurableClock"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnEventV3 from "../src/BpmnEventV3.ts"
import * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as NativeCatch from "../src/EffectWorkflowBpmnEventV3.ts"
import type * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "native-catch-process"
const startMillis = Date.parse("2026-07-24T10:00:00.000Z")
const startedAt = "2026-07-24T10:00:00.000Z" as ProtocolV2Wire.Timestamp

const timestamp = (millis: number): ProtocolV2Wire.Timestamp =>
  DateTime.formatIso(
    DateTime.makeUnsafe(millis)
  ) as ProtocolV2Wire.Timestamp

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() =>
      new Uint8Array(
        createHash("sha256").update(data).digest()
      )
    )
})

const evaluatorBinding: BpmnExpression.EvaluatorBinding = {
  language: "feel",
  languageVersion: "1.0",
  build: {
    id: "native-catch-test-evaluator",
    version: "1.0.0",
    deploymentId: "native-catch-test-deployment",
    buildDigest: `sha256:${"1".repeat(64)}` as BpmnExpression.EvaluatorBinding[
      "build"
    ]["buildDigest"]
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 10_000,
    timeoutMillis: 1_000
  }
}

const messageBinding = (): BpmnEventV3.MessageBinding => ({
  bindingVersion: 1,
  catchEventNodeId: "wait-message",
  messageRef: "native-catch-message",
  correlationExpression: expression("message-correlation"),
  payloadContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: "native-catch-message-json",
    schemaDigest: Schema.decodeUnknownSync(
      ProtocolV3Wire.SchemaDigest
    )(`sha256:${"a".repeat(64)}`)
  },
  authorizationPolicy: {
    policyVersion: 1,
    policyId: "native-catch-message-policy",
    deploymentId: "native-catch-policy-deployment",
    buildDigest: Schema.decodeUnknownSync(
      ProtocolV3Wire.BuildDigest
    )(`sha256:${"b".repeat(64)}`)
  }
})

const taskArtifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"c".repeat(64)}`)

const taskSemanticNodeId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("native-catch-failing-task")

const failingTaskBinding = (): BpmnActivityV3.TaskBinding =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBinding)({
    bindingVersion: BpmnActivityV3.BindingVersion,
    executionProtocolVersion: 3,
    taskNodeId: "task-fails",
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
    occurrenceDigest: `sha256:${"d".repeat(64)}`,
    firstActivityDigest: `sha256:${"e".repeat(64)}`,
    terminal: {
      _tag: "NonRetryable",
      terminalVersion: 1,
      decision: {
        _tag: "Classifier",
        decisionVersion: 1,
        classificationActivityDigest: `sha256:${"0".repeat(64)}`
      }
    },
    failedActivityDigest: `sha256:${"f".repeat(64)}`,
    attempt: 1,
    identity: {
      failureIdentityVersion: 1,
      errorTag: "UnmappedBusinessFailure",
      errorCode: "UNMAPPED"
    }
  })

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

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const process = (): BpmnModel.Process => ({
  id: processId,
  isExecutable: true,
  extensionElements: []
})

const startEvent = (
  outgoingSequenceFlowId: string
): BpmnModel.StartEvent => ({
  _tag: "StartEvent",
  id: "start",
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [],
  outgoingSequenceFlowIds: [outgoingSequenceFlowId],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: []
})

const endEvent = (
  id: string,
  incomingSequenceFlowId: string
): BpmnModel.EndEvent => ({
  _tag: "EndEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [incomingSequenceFlowId],
  outgoingSequenceFlowIds: [],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: []
})

const timerCatch = (
  id: string,
  incomingSequenceFlowId: string,
  outgoingSequenceFlowId: string,
  source: string
): BpmnModel.IntermediateCatchEvent => ({
  _tag: "IntermediateCatchEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [incomingSequenceFlowId],
  outgoingSequenceFlowIds: [outgoingSequenceFlowId],
  eventDefinitions: [{
    _tag: "TimerEventDefinition",
    timeDuration: expression(source)
  }],
  eventDefinitionRefs: [],
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

const standaloneTimerModel = (): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [],
  collaborations: [],
  processes: [process()],
  flowNodes: [
    startEvent("start-to-timer"),
    timerCatch(
      "wait-timer",
      "start-to-timer",
      "timer-to-end",
      "timer-duration"
    ),
    endEvent("end", "timer-to-end")
  ],
  sequenceFlows: [
    flow("start-to-timer", "start", "wait-timer"),
    flow("timer-to-end", "wait-timer", "end")
  ]
})

const standaloneMessageModel = (
  binding: BpmnEventV3.MessageBinding
): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [{ id: binding.messageRef }],
  collaborations: [],
  processes: [process()],
  flowNodes: [
    startEvent("start-to-message"),
    {
      _tag: "IntermediateCatchEvent",
      id: binding.catchEventNodeId,
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["start-to-message"],
      outgoingSequenceFlowIds: ["message-to-end"],
      eventDefinitions: [{
        _tag: "MessageEventDefinition",
        messageRef: binding.messageRef
      }],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    endEvent("end", "message-to-end")
  ],
  sequenceFlows: [
    flow("start-to-message", "start", binding.catchEventNodeId),
    flow("message-to-end", binding.catchEventNodeId, "end")
  ]
})

const twoTimerChoiceModel = (): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [],
  collaborations: [],
  processes: [process()],
  flowNodes: [
    startEvent("start-to-choice"),
    {
      _tag: "Gateway",
      id: "choice",
      processId,
      parentScopeId: processId,
      gatewayKind: "event-based",
      gatewayDirection: "diverging",
      instantiate: false,
      eventGatewayType: "exclusive",
      incomingSequenceFlowIds: ["start-to-choice"],
      outgoingSequenceFlowIds: ["choice-to-left", "choice-to-right"],
      extensionElements: []
    },
    timerCatch(
      "wait-left",
      "choice-to-left",
      "left-to-end",
      "left-duration"
    ),
    timerCatch(
      "wait-right",
      "choice-to-right",
      "right-to-end",
      "right-duration"
    ),
    endEvent("left-end", "left-to-end"),
    endEvent("right-end", "right-to-end")
  ],
  sequenceFlows: [
    flow("start-to-choice", "start", "choice"),
    flow("choice-to-left", "choice", "wait-left"),
    flow("choice-to-right", "choice", "wait-right"),
    flow("left-to-end", "wait-left", "left-end"),
    flow("right-to-end", "wait-right", "right-end")
  ]
})

const messageTimerChoiceModel = (
  binding: BpmnEventV3.MessageBinding
): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [{ id: binding.messageRef }],
  collaborations: [],
  processes: [process()],
  flowNodes: [
    startEvent("start-to-choice"),
    {
      _tag: "Gateway",
      id: "choice",
      processId,
      parentScopeId: processId,
      gatewayKind: "event-based",
      gatewayDirection: "diverging",
      instantiate: false,
      eventGatewayType: "exclusive",
      incomingSequenceFlowIds: ["start-to-choice"],
      outgoingSequenceFlowIds: [
        "choice-to-message",
        "choice-to-timer"
      ],
      extensionElements: []
    },
    {
      _tag: "IntermediateCatchEvent",
      id: binding.catchEventNodeId,
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["choice-to-message"],
      outgoingSequenceFlowIds: ["message-to-end"],
      eventDefinitions: [{
        _tag: "MessageEventDefinition",
        messageRef: binding.messageRef
      }],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    timerCatch(
      "wait-timer",
      "choice-to-timer",
      "timer-to-end",
      "timer-duration"
    ),
    endEvent("message-end", "message-to-end"),
    endEvent("timer-end", "timer-to-end")
  ],
  sequenceFlows: [
    flow("start-to-choice", "start", "choice"),
    flow(
      "choice-to-message",
      "choice",
      binding.catchEventNodeId
    ),
    flow("choice-to-timer", "choice", "wait-timer"),
    flow(
      "message-to-end",
      binding.catchEventNodeId,
      "message-end"
    ),
    flow("timer-to-end", "wait-timer", "timer-end")
  ]
})

const catchWaitAndFailingTaskModel = (
  binding: BpmnEventV3.MessageBinding
): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [{ id: binding.messageRef }],
  collaborations: [],
  processes: [process()],
  flowNodes: [
    {
      ...startEvent("start-to-choice"),
      outgoingSequenceFlowIds: ["start-to-choice", "start-to-task"]
    },
    {
      _tag: "Gateway",
      id: "cleanup-choice",
      processId,
      parentScopeId: processId,
      gatewayKind: "event-based",
      gatewayDirection: "diverging",
      instantiate: false,
      eventGatewayType: "exclusive",
      incomingSequenceFlowIds: ["start-to-choice"],
      outgoingSequenceFlowIds: [
        "choice-to-message",
        "choice-to-timer"
      ],
      extensionElements: []
    },
    {
      _tag: "IntermediateCatchEvent",
      id: binding.catchEventNodeId,
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["choice-to-message"],
      outgoingSequenceFlowIds: ["message-to-end"],
      eventDefinitions: [{
        _tag: "MessageEventDefinition",
        messageRef: binding.messageRef
      }],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    timerCatch(
      "wait-cleanup-timer",
      "choice-to-timer",
      "timer-to-end",
      "cleanup-duration"
    ),
    {
      _tag: "Task",
      id: "task-fails",
      processId,
      parentScopeId: processId,
      taskKind: "generic",
      incomingSequenceFlowIds: ["start-to-task"],
      outgoingSequenceFlowIds: ["task-to-end"],
      extensionElements: []
    },
    endEvent("message-end", "message-to-end"),
    endEvent("timer-end", "timer-to-end"),
    endEvent("task-end", "task-to-end")
  ],
  sequenceFlows: [
    flow("start-to-choice", "start", "cleanup-choice"),
    flow("start-to-task", "start", "task-fails"),
    flow(
      "choice-to-message",
      "cleanup-choice",
      binding.catchEventNodeId
    ),
    flow(
      "choice-to-timer",
      "cleanup-choice",
      "wait-cleanup-timer"
    ),
    flow(
      "message-to-end",
      binding.catchEventNodeId,
      "message-end"
    ),
    flow("timer-to-end", "wait-cleanup-timer", "timer-end"),
    flow("task-to-end", "task-fails", "task-end")
  ]
})

const compile = (
  model: BpmnModel.BpmnModel,
  messageBindings: ReadonlyArray<BpmnEventV3.MessageBinding> = [],
  taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding> = []
): BpmnKernel.CompiledKernel =>
  Effect.runSync(
    BpmnKernel.prepare(model, {
      profileId: "native-catch-adapter-test-v1",
      rootProcessId: processId,
      limits,
      evaluatorBindings: [evaluatorBinding],
      messageBindings,
      taskBindings
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto)
    )
  )

const services = (
  now: ProtocolV2Wire.Timestamp,
  values: Readonly<Record<string, Schema.Json>>
): BpmnKernel.Services => ({
  now,
  evaluateExpression: ({ expression }) => {
    const value = values[expression.source]
    return value === undefined
      ? Result.fail({
        _tag: "EvaluationFailure",
        code: "MissingTestExpression",
        message: `Missing '${expression.source}'`
      })
      : Result.succeed({
        result: value,
        steps: 1
      })
  }
})

const initialize = (
  kernel: BpmnKernel.CompiledKernel,
  values: Readonly<Record<string, Schema.Json>>
): BpmnExecutionState.BpmnExecutionState => {
  const initialized = BpmnKernel.initialize(
    kernel,
    {
      commandVersion: BpmnKernel.InitializeCommandVersion,
      input: {}
    },
    services(startedAt, values)
  )
  if (Result.isFailure(initialized)) {
    throw new Error(initialized.failure.message)
  }
  return initialized.success.state
}

const prepare = (
  kernel: BpmnKernel.CompiledKernel,
  state: BpmnExecutionState.BpmnExecutionState,
  timerId: string,
  address: NativeCatch.NativeExecutionAddress
): NativeCatch.PreparedTimerArm =>
  Effect.runSync(
    NativeCatch.prepareTimerArm(
      kernel,
      state,
      timerId,
      address
    ).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto)
    )
  )

const externalAddress = (
  executionId: string
): NativeCatch.NativeExecutionAddress => ({
  workflowName: "NativeCatchAdapterTest/External",
  executionId
})

const explicitToken = (
  prepared: NativeCatch.PreparedWaitGroup
): NativeDeferred.Token =>
  new NativeDeferred.TokenParsed({
    workflowName: prepared.address.workflowName,
    executionId: prepared.address.executionId,
    deferredName: prepared.deferredName
  }).asToken

const pollWake = (
  prepared: NativeCatch.PreparedWaitGroup,
  token: NativeDeferred.Token
) => NativeDeferred.poll(prepared.deferred, { token })

const pollUntilComplete = <A, E, R>(
  poll: Effect.Effect<
    Option.Option<NativeWorkflow.Result<A, E>>,
    never,
    R
  >
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let index = 0; index < 10 && (Option.isNone(result) || result.value._tag !== "Complete"); index++) {
      yield* Effect.yieldNow
      yield* Effect.sleep("10 millis").pipe(TestClock.withLive)
      result = yield* poll
    }
    return result
  })

const WaitWorkflow = NativeWorkflow.make(
  "NativeCatchAdapterTest/WaitWorkflow",
  {
    payload: { id: Schema.String },
    success: NativeCatch.NativeCatchWakeV1,
    idempotencyKey: ({ id }) => id
  }
)

const ObserveWorkflow = NativeWorkflow.make(
  "NativeCatchAdapterTest/ObserveWorkflow",
  {
    payload: { id: Schema.String },
    success: BpmnEventV3.ObserveDueTimerCommand,
    idempotencyKey: ({ id }) => id
  }
)

const waitWorkflowAddress = (
  id: string
): NativeCatch.NativeExecutionAddress => ({
  workflowName: WaitWorkflow._tag,
  executionId: createHash("sha256")
    .update(`${WaitWorkflow._tag}-${id}`)
    .digest("hex")
    .slice(0, 32)
})

const observeWorkflowAddress = (
  id: string
): NativeCatch.NativeExecutionAddress => ({
  workflowName: ObserveWorkflow._tag,
  executionId: createHash("sha256")
    .update(`${ObserveWorkflow._tag}-${id}`)
    .digest("hex")
    .slice(0, 32)
})

describe("EffectWorkflowBpmnEventV3", () => {
  it.effect("re-arms one absolute schedule id without moving its deadline or replacing its value", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const kernel = compile(standaloneTimerModel())
      const state = initialize(kernel, {
        "timer-duration": "PT10S"
      })
      const timer = state.timers[0]!
      const address = externalAddress("recovery")
      const first = prepare(
        kernel,
        state,
        timer.timerId,
        address
      )
      const recovered = prepare(
        kernel,
        state,
        timer.timerId,
        address
      )
      assert.strictEqual(
        recovered.waitGroup.deferredName,
        first.waitGroup.deferredName
      )
      assert.strictEqual(recovered.scheduleId, first.scheduleId)
      assert.strictEqual(recovered.receiptId, first.receiptId)
      assert.strictEqual(
        first.wakeUpAt,
        "2026-07-24T10:00:10.000Z"
      )

      const token = explicitToken(first.waitGroup)
      const firstAck = yield* NativeCatch.armTimer(first, token)
      yield* TestClock.adjust("1 second")
      const recoveredAck = yield* NativeCatch.armTimer(recovered, token)
      assert.strictEqual(
        recoveredAck.receipt.backendId,
        firstAck.receipt.backendId
      )
      assert.strictEqual(
        recoveredAck.receipt.scheduleId,
        firstAck.receipt.scheduleId
      )
      assert.strictEqual(
        recoveredAck.receipt.receiptId,
        firstAck.receipt.receiptId
      )
      assert.notStrictEqual(
        recoveredAck.receipt.armedAt,
        firstAck.receipt.armedAt
      )

      yield* NativeClock.schedule(first.waitGroup.deferred, {
        token,
        scheduleId: first.scheduleId,
        wakeUp: DateTime.makeUnsafe(startMillis + 2_000),
        value: {
          _tag: "StateChanged",
          wakeVersion: 1,
          backendId: NativeCatch.BackendId,
          target: first.waitGroup.target,
          changeId: "replacement-must-not-win",
          reason: "repaired",
          committedStateVersion: BpmnExecutionState.BpmnExecutionStateVersion,
          notifiedAt: timestamp(startMillis + 1_000)
        }
      })
      yield* TestClock.adjust("1 second")
      assert.isTrue(
        Option.isNone(yield* pollWake(first.waitGroup, token))
      )

      yield* TestClock.adjust("8 seconds")
      const completed = yield* pollWake(first.waitGroup, token)
      assert.isTrue(Option.isSome(completed))
      if (
        Option.isSome(completed) &&
        Exit.isSuccess(completed.value)
      ) {
        assert.strictEqual(completed.value.value._tag, "TimerDueHint")
        assert.strictEqual(
          completed.value.value._tag === "TimerDueHint"
            ? completed.value.value.scheduleId
            : "",
          first.scheduleId
        )
      }
      const canonical = yield* NativeCatch.notifyStateChanged(
        first.waitGroup,
        token,
        {
          changeId: "late-state-change",
          reason: "repaired"
        }
      )
      assert.strictEqual(canonical._tag, "TimerDueHint")
    }).pipe(
      Effect.provide(WorkflowEngine.layerMemory)
    ))

  it.effect("uses token and await on the typed deferred while keeping the wake a hint", () => {
    const workflowId = "timer-wake"
    const kernel = compile(standaloneTimerModel())
    const state = initialize(kernel, {
      "timer-duration": "PT5S"
    })
    const prepared = prepare(
      kernel,
      state,
      state.timers[0]!.timerId,
      waitWorkflowAddress(workflowId)
    )
    const layer = WaitWorkflow.toLayer(() =>
      Effect.gen(function*() {
        const token = yield* NativeCatch.wakeToken(
          prepared.waitGroup
        )
        yield* NativeCatch.armTimer(prepared, token)
        return (yield* NativeCatch.awaitWake(
          prepared.waitGroup
        )).wake
      })
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const executionId = yield* WaitWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      yield* TestClock.adjust("5 seconds")
      const completed = yield* pollUntilComplete(
        WaitWorkflow.poll(executionId)
      )
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      if (
        Option.isSome(completed) &&
        completed.value._tag === "Complete" &&
        Exit.isSuccess(completed.value.exit)
      ) {
        assert.strictEqual(
          completed.value.exit.value._tag,
          "TimerDueHint"
        )
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("re-prepares an acknowledged armed Timer after a crash and awaits it without rescheduling", () => {
    const workflowId = "armed-recovery"
    const address = observeWorkflowAddress(workflowId)
    const kernel = compile(standaloneTimerModel())
    const state = initialize(kernel, {
      "timer-duration": "PT5S"
    })
    const initial = prepare(
      kernel,
      state,
      state.timers[0]!.timerId,
      address
    )
    let recovered!: NativeCatch.PreparedTimerArm
    const layer = ObserveWorkflow.toLayer(() =>
      Effect.gen(function*() {
        const observed = yield* NativeCatch.awaitWake(
          recovered.waitGroup
        )
        const command = yield* NativeCatch.timerObservationFromWake(
          recovered,
          observed
        )
        if (command === undefined) {
          return yield* Effect.die(
            "Expected recovered Timer wake"
          )
        }
        return command
      })
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const token = explicitToken(initial.waitGroup)
      const acknowledgement = yield* NativeCatch.armTimer(
        initial,
        token
      )
      const acknowledged = BpmnKernel.acknowledgeTimerArm(
        kernel,
        state,
        acknowledgement,
        services(timestamp(startMillis + 1), {})
      )
      if (Result.isFailure(acknowledged)) {
        throw new Error(acknowledged.failure.message)
      }
      recovered = yield* NativeCatch.prepareTimerArm(
        kernel,
        acknowledged.success.state,
        initial.timerId,
        address
      )
      assert.strictEqual(recovered.observedTimerStatus, "armed")
      assert.strictEqual(recovered.scheduleId, initial.scheduleId)
      assert.strictEqual(recovered.receiptId, initial.receiptId)
      assert.isTrue(Result.isFailure(
        yield* Effect.result(
          NativeCatch.armTimer(recovered, token)
        )
      ))

      const executionId = yield* ObserveWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      yield* TestClock.adjust("5 seconds")
      const completed = yield* pollUntilComplete(
        ObserveWorkflow.poll(executionId)
      )
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      if (
        Option.isSome(completed) &&
        completed.value._tag === "Complete" &&
        Exit.isSuccess(completed.value.exit)
      ) {
        assert.strictEqual(
          completed.value.exit.value.timerId,
          initial.timerId
        )
      }
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(layer)
    )
  })

  it.effect("keeps the first post-commit StateChanged hint", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const kernel = compile(standaloneTimerModel())
      const state = initialize(kernel, {
        "timer-duration": "PT10S"
      })
      const prepared = prepare(
        kernel,
        state,
        state.timers[0]!.timerId,
        externalAddress("state-changed")
      )
      const token = explicitToken(prepared.waitGroup)
      const first = yield* NativeCatch.notifyStateChanged(
        prepared.waitGroup,
        token,
        {
          changeId: "commit-1",
          reason: "repaired"
        }
      )
      yield* TestClock.adjust("1 second")
      const duplicate = yield* NativeCatch.notifyStateChanged(
        prepared.waitGroup,
        token,
        {
          changeId: "commit-2",
          reason: "repaired"
        }
      )
      assert.strictEqual(first._tag, "StateChanged")
      assert.deepStrictEqual(duplicate, first)
      if (first._tag === "StateChanged") {
        assert.strictEqual(first.changeId, "commit-1")
        assert.strictEqual(first.notifiedAt, startedAt)
      }
    }).pipe(
      Effect.provide(WorkflowEngine.layerMemory)
    ))

  it.effect("awaits and notifies a Message-only wait group without inventing a Timer", () => {
    const workflowId = "message-only-wake"
    const address = waitWorkflowAddress(workflowId)
    const binding = messageBinding()
    const kernel = compile(
      standaloneMessageModel(binding),
      [binding]
    )
    const state = initialize(kernel, {
      "message-correlation": ["tenant-1", "order-42"]
    })
    assert.lengthOf(state.timers, 0)
    const waitGroupId = state.catchWaitGroups[0]!.waitGroupId
    const liveGroup = Effect.runSync(
      NativeCatch.prepareWaitGroup(
        kernel,
        state,
        waitGroupId,
        address
      ).pipe(
        Effect.provideService(Crypto.Crypto, testCrypto)
      )
    )
    const arm = state.subscriptions[0]!
    if (arm._tag !== "MessageCatchSubscription") {
      throw new Error("Expected one Message catch arm")
    }
    const groupState = state.catchWaitGroups[0]!
    const deliveryId = "message-delivery-committed"
    const delivered = BpmnKernel.deliverMessage(
      kernel,
      state,
      {
        commandVersion: BpmnEventV3.DeliverMessageCommandVersion,
        target: {
          waitGroupId,
          armId: arm.armId,
          scopeInstanceId: groupState.scopeInstanceId,
          catchEventNodeId: arm.ownerNodeId,
          tokenId: groupState.ownerTokenId,
          generation: groupState.generation
        },
        receipt: {
          receiptVersion: BpmnEventV3.MessageReceiptVersion,
          deliveryId,
          messageRef: binding.messageRef,
          correlationKey: arm.correlationKey,
          payloadContract: binding.payloadContract,
          payload: { orderId: "order-42" },
          acceptedAt: timestamp(startMillis + 1),
          authorization: {
            policy: binding.authorizationPolicy,
            decisionId: "message-decision",
            actorId: "trusted-ingress"
          }
        }
      },
      services(timestamp(startMillis + 1), {})
    )
    if (Result.isFailure(delivered)) {
      throw new Error(delivered.failure.message)
    }
    assert.strictEqual(
      delivered.success.state.catchWaitGroups[0]!.status,
      "won"
    )
    assert.strictEqual(
      delivered.success.state.messageDeliveries[0]!.receipt.deliveryId,
      deliveryId
    )
    const recoveredClosedGroup = Effect.runSync(
      NativeCatch.prepareWaitGroup(
        kernel,
        delivered.success.state,
        waitGroupId,
        address
      ).pipe(
        Effect.provideService(Crypto.Crypto, testCrypto)
      )
    )
    assert.strictEqual(recoveredClosedGroup.observedStatus, "won")
    assert.strictEqual(
      recoveredClosedGroup.observedMessageDeliveryId,
      deliveryId
    )
    assert.strictEqual(
      recoveredClosedGroup.deferredName,
      liveGroup.deferredName
    )
    const layer = WaitWorkflow.toLayer(() =>
      Effect.map(
        NativeCatch.awaitWake(liveGroup),
        (observed) => observed.wake
      )
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const executionId = yield* WaitWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      const token = NativeDeferred.tokenFromExecutionId(
        recoveredClosedGroup.deferred,
        {
          workflow: WaitWorkflow,
          executionId
        }
      )
      const preCommitCapability = yield* Effect.result(
        NativeCatch.notifyStateChanged(
          liveGroup,
          token,
          {
            changeId: deliveryId,
            reason: "message-committed"
          }
        )
      )
      assert.isTrue(Result.isFailure(preCommitCapability))
      const notified = yield* NativeCatch.notifyStateChanged(
        recoveredClosedGroup,
        token,
        {
          changeId: deliveryId,
          reason: "message-committed"
        }
      )
      assert.strictEqual(notified._tag, "StateChanged")
      const completed = yield* pollUntilComplete(
        WaitWorkflow.poll(executionId)
      )
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      if (
        Option.isSome(completed) &&
        completed.value._tag === "Complete" &&
        Exit.isSuccess(completed.value.exit)
      ) {
        assert.deepStrictEqual(completed.value.exit.value, notified)
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("wakes after a causally committed terminal failure cancels the catch group", () => {
    const workflowId = "cancelled-post-commit"
    const address = waitWorkflowAddress(workflowId)
    const binding = messageBinding()
    const taskBinding = failingTaskBinding()
    const kernel = compile(
      catchWaitAndFailingTaskModel(binding),
      [binding],
      [taskBinding]
    )
    const state = initialize(kernel, {
      "message-correlation": ["tenant-1", "cleanup-order"],
      "cleanup-duration": "PT30S"
    })
    const group = state.catchWaitGroups[0]!
    const timer = state.timers.find(
      (candidate) => candidate.waitGroupId === group.waitGroupId
    )
    const taskToken = state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === taskBinding.taskNodeId
    )
    if (timer === undefined || taskToken === undefined) {
      throw new Error("Expected parallel live Timer and bound Task")
    }
    const liveGroup = Effect.runSync(
      NativeCatch.prepareWaitGroup(
        kernel,
        state,
        group.waitGroupId,
        address
      ).pipe(
        Effect.provideService(Crypto.Crypto, testCrypto)
      )
    )
    let recoveredClosedGroup!: NativeCatch.PreparedWaitGroup
    const layer = WaitWorkflow.toLayer(() =>
      Effect.gen(function*() {
        const observed = yield* NativeCatch.awaitWake(liveGroup)
        const closedAwait = yield* Effect.result(
          NativeCatch.awaitWake(recoveredClosedGroup)
        )
        assert.isTrue(Result.isFailure(closedAwait))
        if (Result.isFailure(closedAwait)) {
          assert.strictEqual(
            closedAwait.failure.code,
            NativeCatch.ErrorCodes.WaitGroupNotLive
          )
        }
        return observed.wake
      })
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const executionId = yield* WaitWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      yield* TestClock.adjust("1 second")
      const failedAt = timestamp(startMillis + 1_000)
      const resolved = BpmnKernel.resolveTask(
        kernel,
        state,
        {
          commandVersion: BpmnActivityV3.CommandVersion,
          scopeInstanceId: taskToken.scopeInstanceId,
          taskNodeId: taskBinding.taskNodeId,
          tokenId: taskToken.tokenId,
          outcome: unmappedBusinessFailure()
        },
        services(failedAt, {})
      )
      assert.isTrue(Result.isSuccess(resolved))
      if (Result.isFailure(resolved)) {
        throw new Error(resolved.failure.message)
      }
      assert.strictEqual(resolved.success.state.status, "failed")
      const cancelledGroup = resolved.success.state.catchWaitGroups.find(
        (candidate) => candidate.waitGroupId === group.waitGroupId
      )
      const cancelledTimer = resolved.success.state.timers.find(
        (candidate) => candidate.timerId === timer.timerId
      )
      assert.strictEqual(cancelledGroup?.status, "cancelled")
      assert.strictEqual(
        cancelledGroup?.cancellationReason,
        "execution-failed"
      )
      assert.strictEqual(cancelledTimer?.status, "cancelled")
      assert.strictEqual(
        cancelledTimer?.cancellationReason,
        "execution-failed"
      )

      recoveredClosedGroup = yield* NativeCatch.prepareWaitGroup(
        kernel,
        resolved.success.state,
        group.waitGroupId,
        address
      )
      assert.strictEqual(
        recoveredClosedGroup.observedStatus,
        "cancelled"
      )
      assert.strictEqual(
        recoveredClosedGroup.deferredName,
        liveGroup.deferredName
      )
      const cancelledTimerPreparation = yield* Effect.result(
        NativeCatch.prepareTimerArm(
          kernel,
          resolved.success.state,
          timer.timerId,
          address
        )
      )
      assert.isTrue(Result.isFailure(cancelledTimerPreparation))
      if (Result.isFailure(cancelledTimerPreparation)) {
        assert.strictEqual(
          cancelledTimerPreparation.failure.code,
          NativeCatch.ErrorCodes.TimerNotSchedulable
        )
      }

      const token = NativeDeferred.tokenFromExecutionId(
        recoveredClosedGroup.deferred,
        {
          workflow: WaitWorkflow,
          executionId
        }
      )
      const notified = yield* NativeCatch.notifyStateChanged(
        recoveredClosedGroup,
        token,
        {
          changeId: "terminal-failure-committed",
          reason: "cancelled"
        }
      )
      assert.strictEqual(notified._tag, "StateChanged")
      if (notified._tag === "StateChanged") {
        assert.strictEqual(notified.reason, "cancelled")
      }
      const completed = yield* pollUntilComplete(
        WaitWorkflow.poll(executionId)
      )
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      if (
        Option.isSome(completed) &&
        completed.value._tag === "Complete" &&
        Exit.isSuccess(completed.value.exit)
      ) {
        assert.deepStrictEqual(completed.value.exit.value, notified)
      }
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(layer)
    )
  })

  it.effect("accepts message-committed evidence when the delivery ledger records Timer preemption", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(startMillis + 7_000)
      const binding = messageBinding()
      const kernel = compile(
        messageTimerChoiceModel(binding),
        [binding]
      )
      const state = initialize(kernel, {
        "message-correlation": ["tenant-1", "order-42"],
        "timer-duration": "PT5S"
      })
      const group = state.catchWaitGroups[0]!
      const arm = state.subscriptions.find(
        (candidate) => candidate._tag === "MessageCatchSubscription"
      )
      if (arm?._tag !== "MessageCatchSubscription") {
        throw new Error("Expected a Message arm")
      }
      const deliveryId = "timer-preempted-delivery"
      const delivered = BpmnKernel.deliverMessage(
        kernel,
        state,
        {
          commandVersion: 1,
          target: {
            waitGroupId: group.waitGroupId,
            armId: arm.armId,
            scopeInstanceId: group.scopeInstanceId,
            catchEventNodeId: arm.ownerNodeId,
            tokenId: group.ownerTokenId,
            generation: group.generation
          },
          receipt: {
            receiptVersion: 1,
            deliveryId,
            messageRef: binding.messageRef,
            correlationKey: arm.correlationKey,
            payloadContract: binding.payloadContract,
            payload: { orderId: "order-42" },
            acceptedAt: timestamp(startMillis + 6_000),
            authorization: {
              policy: binding.authorizationPolicy,
              decisionId: "preempted-decision",
              actorId: "trusted-ingress"
            }
          }
        },
        services(timestamp(startMillis + 6_000), {})
      )
      if (Result.isFailure(delivered)) {
        throw new Error(delivered.failure.message)
      }
      assert.strictEqual(
        delivered.success.state.messageDeliveries[0]!.disposition,
        "timer-preempted"
      )
      const address = externalAddress("timer-preempted-ledger")
      const recovered = yield* NativeCatch.prepareWaitGroup(
        kernel,
        delivered.success.state,
        group.waitGroupId,
        address
      )
      assert.strictEqual(
        recovered.observedMessageDeliveryId,
        deliveryId
      )
      const notified = yield* NativeCatch.notifyStateChanged(
        recovered,
        explicitToken(recovered),
        {
          changeId: deliveryId,
          reason: "message-committed"
        }
      )
      assert.strictEqual(notified._tag, "StateChanged")
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(WorkflowEngine.layerMemory)
    ))

  it.effect("accepts a Timer wake across distinct opaque capabilities for the same exact multi-Timer wait group", () => {
    const workflowId = "multi-timer-equivalent-group"
    const address = observeWorkflowAddress(workflowId)
    const kernel = compile(twoTimerChoiceModel())
    const state = initialize(kernel, {
      "left-duration": "PT5S",
      "right-duration": "PT10S"
    })
    const timerFor = (ownerNodeId: string) =>
      state.timers.find((timer) =>
        state.subscriptions.some((arm) =>
          arm.ownerNodeId === ownerNodeId &&
          arm._tag === "TimerCatchSubscription" &&
          arm.timerId === timer.timerId
        )
      )!
    const left = prepare(
      kernel,
      state,
      timerFor("wait-left").timerId,
      address
    )
    const right = prepare(
      kernel,
      state,
      timerFor("wait-right").timerId,
      address
    )
    assert.notStrictEqual(left.waitGroup, right.waitGroup)
    assert.strictEqual(
      left.waitGroup.deferredName,
      right.waitGroup.deferredName
    )
    const layer = ObserveWorkflow.toLayer(() =>
      Effect.gen(function*() {
        const token = yield* NativeCatch.wakeToken(
          right.waitGroup
        )
        yield* NativeCatch.armTimer(left, token)
        yield* NativeCatch.armTimer(right, token)
        const observed = yield* NativeCatch.awaitWake(
          right.waitGroup
        )
        assert.strictEqual(observed.wake._tag, "TimerDueHint")
        if (observed.wake._tag !== "TimerDueHint") {
          return yield* Effect.die("Expected the left Timer wake")
        }
        assert.strictEqual(observed.wake.timerId, left.timerId)
        assert.isTrue(Object.isFrozen(observed))
        assert.isTrue(Object.isFrozen(observed.wake))
        assert.isTrue(Object.isFrozen(observed.wake.target))
        assert.isFalse(Reflect.set(
          observed,
          "wake",
          right.timerDueHint
        ))
        assert.isFalse(Reflect.set(
          observed.wake,
          "timerId",
          right.timerId
        ))
        assert.isFalse(Reflect.set(
          observed.wake.target,
          "armId",
          right.target.armId
        ))
        const crossArm = yield* Effect.result(
          NativeCatch.timerObservationFromWake(right, observed)
        )
        assert.isTrue(Result.isFailure(crossArm))
        const command = yield* NativeCatch.timerObservationFromWake(
          left,
          observed
        )
        if (command === undefined) {
          return yield* Effect.die(
            "Expected one multi-Timer wake"
          )
        }
        return command
      })
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const executionId = yield* ObserveWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      yield* TestClock.adjust("5 seconds")
      const completed = yield* pollUntilComplete(
        ObserveWorkflow.poll(executionId)
      )
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      if (
        Option.isSome(completed) &&
        completed.value._tag === "Complete" &&
        Exit.isSuccess(completed.value.exit)
      ) {
        assert.strictEqual(
          completed.value.exit.value.timerId,
          left.timerId
        )
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a forged hint and lets the BPMN kernel select the winner after a proven native wake", () => {
    const workflowId = "kernel-authority"
    const kernel = compile(twoTimerChoiceModel())
    const state = initialize(kernel, {
      "left-duration": "PT5S",
      "right-duration": "PT10S"
    })
    const leftTimer = state.timers.find((timer) =>
      state.subscriptions.some((arm) =>
        arm.ownerNodeId === "wait-left" &&
        arm._tag === "TimerCatchSubscription" &&
        arm.timerId === timer.timerId
      )
    )!
    const rightTimer = state.timers.find((timer) =>
      state.subscriptions.some((arm) =>
        arm.ownerNodeId === "wait-right" &&
        arm._tag === "TimerCatchSubscription" &&
        arm.timerId === timer.timerId
      )
    )!
    const rightPrepared = prepare(
      kernel,
      state,
      rightTimer.timerId,
      observeWorkflowAddress(workflowId)
    )
    const layer = ObserveWorkflow.toLayer(() =>
      Effect.gen(function*() {
        const token = yield* NativeCatch.wakeToken(
          rightPrepared.waitGroup
        )
        yield* NativeCatch.armTimer(rightPrepared, token)
        const observed = yield* NativeCatch.awaitWake(
          rightPrepared.waitGroup
        )
        const command = yield* NativeCatch.timerObservationFromWake(
          rightPrepared,
          observed
        )
        if (command === undefined) {
          return yield* Effect.die(
            "Expected a Timer observation command"
          )
        }
        return command
      })
    ).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const forged = yield* Effect.result(
        NativeCatch.timerObservationFromWake(
          rightPrepared,
          { wake: rightPrepared.timerDueHint }
        )
      )
      assert.isTrue(Result.isFailure(forged))

      const executionId = yield* ObserveWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      yield* TestClock.adjust("10 seconds")
      const completed = yield* pollUntilComplete(
        ObserveWorkflow.poll(executionId)
      )
      assert(
        Option.isSome(completed) &&
          completed.value._tag === "Complete" &&
          Exit.isSuccess(completed.value.exit)
      )
      if (
        Option.isNone(completed) ||
        completed.value._tag !== "Complete" ||
        Exit.isFailure(completed.value.exit)
      ) {
        return
      }
      const command = completed.value.exit.value
      assert.strictEqual(command.timerId, rightTimer.timerId)
      const observed = BpmnKernel.observeDueTimer(
        kernel,
        state,
        command,
        services(timestamp(startMillis + 10_001), {})
      )
      assert.isTrue(Result.isSuccess(observed))
      if (Result.isFailure(observed)) return
      const winner = observed.success.state.catchWaitGroups[0]!.winner
      assert.strictEqual(winner?._tag, "TimerWinner")
      if (winner?._tag === "TimerWinner") {
        assert.strictEqual(winner.timerId, leftTimer.timerId)
        assert.notStrictEqual(winner.timerId, command.timerId)
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects armed, non-live, invalid-deadline, and coordinate-forged snapshots before native work", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(startMillis)
      const kernel = compile(standaloneTimerModel())
      const state = initialize(kernel, {
        "timer-duration": "PT10S"
      })
      const timer = state.timers[0]!
      const address = externalAddress("reject-stale")
      const prepared = prepare(
        kernel,
        state,
        timer.timerId,
        address
      )
      const wrongToken = new NativeDeferred.TokenParsed({
        workflowName: address.workflowName,
        executionId: "other-execution",
        deferredName: prepared.waitGroup.deferredName
      }).asToken
      const mismatchedToken = yield* Effect.result(
        NativeCatch.armTimer(prepared, wrongToken)
      )
      assert.isTrue(Result.isFailure(mismatchedToken))
      if (Result.isFailure(mismatchedToken)) {
        assert.strictEqual(
          mismatchedToken.failure.code,
          NativeCatch.ErrorCodes.InconsistentCoordinates
        )
      }
      const wrongWorkflowToken = new NativeDeferred.TokenParsed({
        workflowName: "NativeCatchAdapterTest/OtherWorkflow",
        executionId: address.executionId,
        deferredName: prepared.waitGroup.deferredName
      }).asToken
      assert.isTrue(Result.isFailure(
        yield* Effect.result(
          NativeCatch.armTimer(prepared, wrongWorkflowToken)
        )
      ))
      const token = explicitToken(
        prepared.waitGroup
      )
      const acknowledgement = yield* NativeCatch.armTimer(
        prepared,
        token
      )
      const acknowledged = BpmnKernel.acknowledgeTimerArm(
        kernel,
        state,
        acknowledgement,
        services(timestamp(startMillis + 1), {})
      )
      assert.isTrue(Result.isSuccess(acknowledged))
      if (Result.isFailure(acknowledged)) return

      const armed = yield* NativeCatch.prepareTimerArm(
        kernel,
        acknowledged.success.state,
        timer.timerId,
        address
      )
      assert.strictEqual(armed.observedTimerStatus, "armed")
      const duplicateArm = yield* Effect.result(
        NativeCatch.armTimer(armed, token)
      )
      assert.isTrue(Result.isFailure(duplicateArm))

      const invalidDeadline = structuredClone(state)
      invalidDeadline.timers[0]!.schedule.dueAt = "2026-02-30T10:00:10.000Z" as ProtocolV2Wire.Timestamp
      const badDeadline = yield* Effect.result(
        NativeCatch.prepareTimerArm(
          kernel,
          invalidDeadline,
          timer.timerId,
          address
        )
      )
      assert.isTrue(Result.isFailure(badDeadline))

      const inconsistent = structuredClone(state)
      inconsistent.timers[0]!.armId = "forged-arm"
      const forged = yield* Effect.result(
        NativeCatch.prepareTimerArm(
          kernel,
          inconsistent,
          timer.timerId,
          address
        )
      )
      assert.isTrue(Result.isFailure(forged))
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(WorkflowEngine.layerMemory)
    ))
})
