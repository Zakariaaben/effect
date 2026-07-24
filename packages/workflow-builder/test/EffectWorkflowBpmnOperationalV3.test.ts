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
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import * as BpmnEventV3 from "../src/BpmnEventV3.ts"
import type * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as Backend from "../src/EffectWorkflowBackendV3.ts"
import * as NativeCatch from "../src/EffectWorkflowBpmnEventV3.ts"
import * as Operational from "../src/EffectWorkflowBpmnOperationalV3.ts"
import type * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "operational-withdrawal-process"
const startedAt = "2026-07-24T10:00:00.000Z" as ProtocolV2Wire.Timestamp
const withdrawnAt = "2026-07-24T10:00:01.000Z" as ProtocolV2Wire.Timestamp
const startMillis = Date.parse(startedAt)
const requestId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("operational-withdrawal-request")

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
    id: "operational-withdrawal-test-evaluator",
    version: "1.0.0",
    deploymentId: "operational-withdrawal-test-deployment",
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

const simpleTaskModel = (): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  messages: [],
  collaborations: [],
  processes: [process()],
  flowNodes: [
    startEvent("start-to-task"),
    {
      _tag: "Task",
      id: "task",
      processId,
      parentScopeId: processId,
      taskKind: "generic",
      incomingSequenceFlowIds: ["start-to-task"],
      outgoingSequenceFlowIds: ["task-to-end"],
      extensionElements: []
    },
    endEvent("end", "task-to-end")
  ],
  sequenceFlows: [
    flow("start-to-task", "start", "task"),
    flow("task-to-end", "task", "end")
  ]
})

const messageBinding = (): BpmnEventV3.MessageBinding => ({
  bindingVersion: BpmnEventV3.MessageBindingVersion,
  catchEventNodeId: "wait-message",
  messageRef: "operational-withdrawal-message",
  correlationExpression: expression("message-correlation"),
  payloadContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: "operational-withdrawal-message-json",
    schemaDigest: Schema.decodeUnknownSync(
      ProtocolV3Wire.SchemaDigest
    )(`sha256:${"a".repeat(64)}`)
  },
  authorizationPolicy: {
    policyVersion: 1,
    policyId: "operational-withdrawal-message-policy",
    deploymentId: "operational-withdrawal-policy-deployment",
    buildDigest: Schema.decodeUnknownSync(
      ProtocolV3Wire.BuildDigest
    )(`sha256:${"b".repeat(64)}`)
  }
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
    {
      _tag: "IntermediateCatchEvent",
      id: "wait-timer",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["choice-to-timer"],
      outgoingSequenceFlowIds: ["timer-to-end"],
      eventDefinitions: [{
        _tag: "TimerEventDefinition",
        timeDuration: expression("timer-duration")
      }],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    endEvent("message-end", "message-to-end"),
    endEvent("timer-end", "timer-to-end")
  ],
  sequenceFlows: [
    flow("start-to-choice", "start", "choice"),
    flow("choice-to-message", "choice", binding.catchEventNodeId),
    flow("choice-to-timer", "choice", "wait-timer"),
    flow("message-to-end", binding.catchEventNodeId, "message-end"),
    flow("timer-to-end", "wait-timer", "timer-end")
  ]
})

const compile = (
  model: BpmnModel.BpmnModel,
  messageBindings: ReadonlyArray<BpmnEventV3.MessageBinding> = [],
  evaluatorBindings: ReadonlyArray<BpmnExpression.EvaluatorBinding> = []
) =>
  BpmnKernel.prepare(model, {
    profileId: "operational-withdrawal-adapter-test-v1",
    rootProcessId: processId,
    limits,
    evaluatorBindings,
    messageBindings,
    taskBindings: []
  })

const services = (
  now: ProtocolV2Wire.Timestamp,
  values: Readonly<Record<string, Schema.Json>> = {}
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

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const initialize = (
  kernel: BpmnKernel.CompiledKernel,
  values: Readonly<Record<string, Schema.Json>> = {}
): BpmnExecutionState.BpmnExecutionState =>
  success(BpmnKernel.initialize(
    kernel,
    {
      commandVersion: BpmnKernel.InitializeCommandVersion,
      input: {}
    },
    services(startedAt, values)
  )).state

const withdrawalCommand = (
  state: BpmnExecutionState.BpmnExecutionState
) => ({
  commandVersion: 1 as const,
  rootScopeInstanceId: state.scopeInstances.find(
    (scope) => scope.parentScopeInstanceId === undefined
  )!.scopeInstanceId,
  requestId,
  attribution: {
    actorId: "operator-1",
    policyId: "withdrawal-policy",
    policyVersion: "1",
    policyDecisionId: "withdrawal-decision-1"
  },
  reasonCode: "operator-request"
})

const withdraw = (
  kernel: BpmnKernel.CompiledKernel,
  state: BpmnExecutionState.BpmnExecutionState
): BpmnKernel.TransitionBatch =>
  success(BpmnKernel.withdrawExecution(
    kernel,
    state,
    withdrawalCommand(state),
    services(withdrawnAt)
  ))

const errorCode = <E extends { readonly code: string }>(
  result: Result.Result<unknown, E>
): string => {
  assert.isTrue(Result.isFailure(result))
  return Result.isFailure(result) ? result.failure.code : ""
}

const WaitWorkflow = NativeWorkflow.make(
  "OperationalWithdrawalAdapterTest/WaitWorkflow",
  {
    payload: { id: Schema.String },
    success: NativeCatch.NativeCatchWakeV1,
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

const pollUntilObserved = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* WaitWorkflow.poll(executionId)
    if (Option.isSome(polled)) return polled.value
    yield* Effect.yieldNow
  }
  return yield* Effect.die(
    "Operational withdrawal host did not expose observable state"
  )
})

const pollUntilComplete = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* WaitWorkflow.poll(executionId)
    if (
      Option.isSome(polled) &&
      polled.value._tag === "Complete"
    ) {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die(
    "Operational withdrawal host did not complete"
  )
})

const rejectionBinding = (
  workflowTag: string,
  state: BpmnExecutionState.BpmnExecutionState
): Backend.PreparedBinding =>
  ({
    adapterVersion: Backend.AdapterVersion,
    executionProtocolVersion: 3,
    workflowTag,
    artifactDigest: `sha256:${"c".repeat(64)}`,
    definitionId: "rejection-only-binding",
    definitionVersion: "1.0.0",
    inputContractDigest: state.model.executableFingerprint,
    outputContractDigest: state.model.executableFingerprint
  }) as unknown as Backend.PreparedBinding

describe("EffectWorkflowBpmnOperationalV3", () => {
  it.effect("authenticates only a committed withdrawal and keeps its capability opaque", () =>
    Effect.gen(function*() {
      const kernel = yield* compile(simpleTaskModel())
      const active = initialize(kernel)
      const command = withdrawalCommand(active)

      const precommit = yield* Effect.result(
        Operational.prepareCommittedWithdrawal(
          kernel,
          active,
          command.requestId
        )
      )
      assert.strictEqual(
        errorCode(precommit),
        Operational.ErrorCodes.WithdrawalNotCommitted
      )

      const forged = {
        ...structuredClone(active),
        status: "cancelled",
        completedAt: withdrawnAt,
        operationalWithdrawal: {
          withdrawalVersion: 1,
          command,
          requestedAt: withdrawnAt
        }
      }
      const forgedResult = yield* Effect.result(
        Operational.prepareCommittedWithdrawal(
          kernel,
          forged,
          command.requestId
        )
      )
      assert.strictEqual(
        errorCode(forgedResult),
        Operational.ErrorCodes.InvalidExecutionState
      )

      const withdrawn = withdraw(kernel, active)
      const mismatched = yield* Effect.result(
        Operational.prepareCommittedWithdrawal(
          kernel,
          withdrawn.state,
          "different-withdrawal-request"
        )
      )
      assert.strictEqual(
        errorCode(mismatched),
        Operational.ErrorCodes.WithdrawalRequestMismatch
      )

      const prepared = yield* Operational.prepareCommittedWithdrawal(
        kernel,
        withdrawn.state,
        command.requestId
      )
      assert.isTrue(Object.isFrozen(prepared))
      assert.isTrue(Object.isFrozen(prepared.cancelledWaitGroupIds))
      assert.strictEqual(prepared.requestId, command.requestId)
      assert.strictEqual(
        prepared.rootScopeInstanceId,
        command.rootScopeInstanceId
      )
      assert.strictEqual(prepared.withdrawnAt, withdrawnAt)

      const copied = { ...prepared }
      const copiedResult = yield* Effect.result(
        Operational.prepareCancelledWaitNotification(
          copied,
          "unavailable-wait-group",
          waitWorkflowAddress("copied-capability")
        )
      )
      assert.strictEqual(
        errorCode(copiedResult),
        Operational.ErrorCodes.UnpreparedWithdrawal
      )
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto)
    ))

  it.effect("notifies one cancelled native wait only after portable withdrawal commits", () => {
    let liveGroup!: NativeCatch.PreparedWaitGroup
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
      const binding = messageBinding()
      const kernel = yield* compile(
        messageTimerChoiceModel(binding),
        [binding],
        [evaluatorBinding]
      )
      const active = initialize(kernel, {
        "message-correlation": ["tenant-1", "order-42"],
        "timer-duration": "PT30S"
      })
      const waitGroup = active.catchWaitGroups[0]!
      const workflowId = "cancelled-post-commit"
      const address = waitWorkflowAddress(workflowId)
      liveGroup = yield* NativeCatch.prepareWaitGroup(
        kernel,
        active,
        waitGroup.waitGroupId,
        address
      )
      assert.strictEqual(liveGroup.observedStatus, "waiting")

      const executionId = yield* WaitWorkflow.execute(
        { id: workflowId },
        { discard: true }
      )
      const suspended = yield* pollUntilObserved(executionId)
      assert.strictEqual(suspended._tag, "Suspended")

      const withdrawn = withdraw(kernel, active)
      const closedGroup = withdrawn.state.catchWaitGroups.find(
        (group) => group.waitGroupId === waitGroup.waitGroupId
      )
      assert.strictEqual(closedGroup?.status, "cancelled")
      assert.strictEqual(
        closedGroup?.cancellationReason,
        "execution-cancelled"
      )
      assert.strictEqual(closedGroup?.winner, undefined)

      const committed = yield* Operational.prepareCommittedWithdrawal(
        kernel,
        withdrawn.state,
        requestId
      )
      const cancelled = yield* Operational.prepareCancelledWaitNotification(
        committed,
        waitGroup.waitGroupId,
        address
      )
      assert.strictEqual(
        cancelled.preparedWaitGroup.deferredName,
        liveGroup.deferredName
      )
      assert.strictEqual(
        cancelled.preparedWaitGroup.observedStatus,
        "cancelled"
      )
      assert.strictEqual(cancelled.requestId, requestId)
      assert.strictEqual(cancelled.waitGroupId, waitGroup.waitGroupId)

      const token = NativeDeferred.tokenFromExecutionId(
        cancelled.preparedWaitGroup.deferred,
        {
          workflow: WaitWorkflow,
          executionId
        }
      )
      const notified = yield* Operational.notifyCancelledWait(
        cancelled,
        token
      )
      assert.strictEqual(notified._tag, "StateChanged")
      if (notified._tag === "StateChanged") {
        assert.strictEqual(notified.reason, "cancelled")
        assert.strictEqual(notified.changeId, requestId)
      }
      assert.strictEqual(closedGroup?.winner, undefined)

      const completed = yield* pollUntilComplete(executionId)
      assert.isTrue(Exit.isSuccess(completed.exit))
      if (Exit.isSuccess(completed.exit)) {
        assert.deepStrictEqual(completed.exit.value, notified)
      }
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(layer)
    )
  })

  it.effect("rejects uncommitted or copied authority and a mismatched native host address", () =>
    Effect.gen(function*() {
      const kernel = yield* compile(simpleTaskModel())
      const active = initialize(kernel)
      const command = withdrawalCommand(active)
      const binding = rejectionBinding(
        "OperationalWithdrawalAdapterTest/ExpectedHost",
        active
      )
      const address = {
        workflowName: binding.workflowTag,
        executionId: "operational-withdrawal-host"
      }
      const precommitCapability = Object.freeze({
        adapterVersion: Operational.AdapterVersion,
        requestId: command.requestId,
        rootScopeInstanceId: command.rootScopeInstanceId,
        executableFingerprint: active.model.executableFingerprint,
        withdrawnAt,
        cancelledWaitGroupIds: Object.freeze([])
      }) satisfies Operational.PreparedCommittedWithdrawal

      const precommitInterrupt = yield* Effect.result(
        Operational.interruptCommittedHost(
          precommitCapability,
          binding,
          address
        )
      )
      assert.strictEqual(
        errorCode(precommitInterrupt),
        Operational.ErrorCodes.UnpreparedWithdrawal
      )

      const withdrawn = withdraw(kernel, active)
      const committed = yield* Operational.prepareCommittedWithdrawal(
        kernel,
        withdrawn.state,
        command.requestId
      )
      const copiedInterrupt = yield* Effect.result(
        Operational.interruptCommittedHost(
          { ...committed },
          binding,
          address
        )
      )
      assert.strictEqual(
        errorCode(copiedInterrupt),
        Operational.ErrorCodes.UnpreparedWithdrawal
      )

      const mismatchedAddress = yield* Effect.result(
        Operational.interruptCommittedHost(
          committed,
          binding,
          {
            ...address,
            workflowName: "OperationalWithdrawalAdapterTest/OtherHost"
          }
        )
      )
      assert.strictEqual(
        errorCode(mismatchedAddress),
        Operational.ErrorCodes.NativeExecutionAddressMismatch
      )
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(WorkflowEngine.layerMemory)
    ))
})
