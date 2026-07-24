import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as CallActivity from "../src/BpmnCallActivityV3.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as Evaluator from "../src/BpmnExpressionEvaluator.ts"
import * as Runtime from "../src/BpmnExpressionRuntime.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const processId = "orders-process"
const callActivityNodeId = "call-payment"
const calledElement = {
  namespaceUri: "urn:example:payments",
  localName: "payment"
} as const

const openedAt = "2026-07-24T10:00:00.000Z" as const
const startedAt = "2026-07-24T10:00:01.000Z" as const
const succeededAt = "2026-07-24T10:00:02.000Z" as const
const replayedAt = "2026-07-24T10:00:03.000Z" as const

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`

const inline = <A>(value: A) => ({
  _tag: "Inline" as const,
  value
})

const success = <A, E>(
  result: Result.Result<A, E>
): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  assert.isTrue(Result.isSuccess(result))
  return result.success
}

const failureWithCode = <A>(
  result: Result.Result<A, Diagnostic.CompilationError>,
  code: BpmnKernel.Code
): Diagnostic.CompilationError => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error(`Expected ${code}`)
  }
  assert.isTrue(
    result.failure.diagnostics.some((diagnostic) => diagnostic.code === code),
    JSON.stringify(result.failure.diagnostics)
  )
  return result.failure
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() =>
      new Uint8Array(
        createHash("sha256").update(data).digest()
      )
    )
})

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(digest("1"))

const inputExpression: BpmnModel.Expression = {
  language: "effect-call-input",
  version: "1",
  source: "encode-payment-input"
}

const evaluatorBinding = (): BpmnExpression.EvaluatorBinding => ({
  language: inputExpression.language,
  languageVersion: inputExpression.version,
  build: {
    id: "call-input-evaluator",
    version: "1.0.0",
    deploymentId: "call-input-evaluator-build-1",
    buildDigest: evaluatorBuildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 10_000,
    timeoutMillis: 1_000
  }
})

const target = () => ({
  targetVersion: Child.ExecutionProtocolVersion,
  artifactVersion: Child.ExecutionProtocolVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  artifactDigest: digest("b"),
  plan: {
    id: "payment-plan",
    revision: 7
  },
  compilerSemanticVersion: "2" as const,
  compiledFingerprint: digest("c"),
  definition: {
    id: "payment",
    version: "3.1.0",
    deploymentId: "payment-build-19",
    buildDigest: digest("6")
  },
  workflowFamilyIdentity: Child.workflowFamilyIdentity("payment"),
  inputContractDigest: digest("d"),
  outputContractDigest: digest("e"),
  closePolicy: {
    closePolicyVersion: Child.ExecutionProtocolVersion,
    onParentFailure: "CancelAndWait" as const,
    onParentCancellation: "RequestCancel" as const
  },
  recursionPolicy: "Forbid" as const,
  maxLineageDepth: Child.MaximumLineageDepth
})

const callBinding = (
  targetOverride: ReturnType<typeof target> = target()
): CallActivity.CallActivityBinding =>
  success(CallActivity.validateBinding({
    bindingVersion: CallActivity.CallActivityBindingVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    profileId: CallActivity.PortableChildProcessProfile,
    callActivityNodeId,
    calledElement,
    target: targetOverride,
    encodedInputExpression: inputExpression,
    maxEncodedInputCanonicalBytes: 1_048_576
  }))

const executionContext = (): CallActivity.ExecutionContext =>
  success(CallActivity.validateExecutionContext({
    contextVersion: CallActivity.ExecutionContextVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    tenantId: "tenant-orders",
    runId: "orders-run-42",
    rootRunId: "orders-run-42",
    artifactDigest: digest("a"),
    workflowFamilyIdentity: Child.workflowFamilyIdentity("orders"),
    ancestry: [{
      lineageEntryVersion: Child.ExecutionProtocolVersion,
      depth: 0,
      tenantId: "tenant-orders",
      runId: "orders-run-42",
      artifactDigest: digest("a"),
      workflowFamilyIdentity: Child.workflowFamilyIdentity("orders")
    }]
  }))

const model = (
  qName: BpmnModel.ExpandedQName = calledElement
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
  flowNodes: [
    {
      _tag: "StartEvent",
      id: "start",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-start-call"],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "CallActivity",
      id: callActivityNodeId,
      processId,
      parentScopeId: processId,
      calledElement: qName,
      incomingSequenceFlowIds: ["flow-start-call"],
      outgoingSequenceFlowIds: ["flow-call-end"],
      extensionElements: []
    },
    {
      _tag: "EndEvent",
      id: "end",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["flow-call-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    }
  ],
  sequenceFlows: [
    {
      id: "flow-start-call",
      processId,
      parentScopeId: processId,
      sourceId: "start",
      targetId: callActivityNodeId,
      kind: "normal",
      extensionElements: []
    },
    {
      id: "flow-call-end",
      processId,
      parentScopeId: processId,
      sourceId: callActivityNodeId,
      targetId: "end",
      kind: "normal",
      extensionElements: []
    }
  ]
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

const prepareResult = (
  definition: BpmnModel.BpmnModel = model(),
  bindings: ReadonlyArray<CallActivity.CallActivityBinding> = [
    callBinding()
  ]
): Result.Result<
  BpmnKernel.CompiledKernel,
  Diagnostic.CompilationError
> =>
  Effect.runSync(
    BpmnKernel.prepare(definition, {
      profileId: CallActivity.PortableChildProcessProfile,
      rootProcessId: processId,
      limits,
      evaluatorBindings: [evaluatorBinding()],
      callActivityBindings: bindings
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<
    BpmnKernel.CompiledKernel,
    Diagnostic.CompilationError
  >

const compile = (
  definition: BpmnModel.BpmnModel = model(),
  bindings: ReadonlyArray<CallActivity.CallActivityBinding> = [
    callBinding()
  ]
): BpmnKernel.CompiledKernel => success(prepareResult(definition, bindings))

const encodedInput = () =>
  inline({
    orderId: "order-42",
    amount: 1250,
    currency: "EUR"
  })

const services = (
  now: BpmnKernel.Services["now"],
  observed: Array<BpmnKernel.EvaluationContext> = []
): BpmnKernel.Services => ({
  now,
  evaluateExpression: (context) => {
    observed.push(context)
    return Result.succeed({
      result: encodedInput(),
      steps: 7
    })
  }
})

const initializeCommand = (
  includeContext = true
) => ({
  commandVersion: BpmnKernel.InitializeCommandVersion,
  input: {
    orderId: "order-42"
  },
  ...(includeContext
    ? { executionContext: executionContext() }
    : undefined)
})

const initialize = (
  kernel: BpmnKernel.CompiledKernel,
  observed: Array<BpmnKernel.EvaluationContext> = []
): BpmnKernel.TransitionBatch =>
  success(BpmnKernel.initialize(
    kernel,
    initializeCommand(),
    services(openedAt, observed)
  ))

const relationFrom = (
  batch: BpmnKernel.TransitionBatch
): Child.ChildRelation => {
  const frame = batch.state.callFrames[0]
  const first = frame?.childEvents[0]
  if (
    frame === undefined ||
    first === undefined ||
    first.payload._tag !== "ChildScheduled"
  ) {
    throw new Error("Expected one scheduled CallActivity frame")
  }
  return first.payload.relation
}

const startAcceptedEvent = (
  relation: Child.ChildRelation,
  recordedAt: string = startedAt
): Protocol.Event => {
  const childRunStartedEventId = "payment-run-started"
  return success(Protocol.validateEvent({
    eventVersion: Protocol.EventVersion,
    executionProtocolVersion: Protocol.ExecutionProtocolVersion,
    eventId: Protocol.childStartProjectionEventId(
      relation.parent.tenantId,
      relation.parent.parentRunId,
      relation.parent.callId,
      childRunStartedEventId
    ),
    tenantId: relation.parent.tenantId,
    parentRunId: relation.parent.parentRunId,
    callId: relation.parent.callId,
    sequence: 1,
    recordedAt,
    causationId: childRunStartedEventId,
    correlationId: relation.parent.callId,
    payload: {
      _tag: "ChildStartAccepted",
      childRunId: relation.childRunId,
      startRequestId: relation.startRequestId,
      childRunStartedEventId
    }
  }))
}

const succeededEvent = (
  relation: Child.ChildRelation,
  sequence = 2,
  recordedAt: string = succeededAt
): Protocol.Event => {
  const childTerminalEventId = "payment-run-succeeded"
  return success(Protocol.validateEvent({
    eventVersion: Protocol.EventVersion,
    executionProtocolVersion: Protocol.ExecutionProtocolVersion,
    eventId: Protocol.childTerminalProjectionEventId(
      relation.parent.tenantId,
      relation.parent.parentRunId,
      relation.parent.callId,
      childTerminalEventId
    ),
    tenantId: relation.parent.tenantId,
    parentRunId: relation.parent.parentRunId,
    callId: relation.parent.callId,
    sequence,
    recordedAt,
    causationId: childTerminalEventId,
    correlationId: relation.parent.callId,
    payload: {
      _tag: "ChildSucceeded",
      childRunId: relation.childRunId,
      childTerminalEventId,
      outputContractDigest: relation.target.outputContractDigest,
      encodedOutput: inline({
        receiptId: "receipt-42",
        status: "captured"
      })
    }
  }))
}

const locator = (
  executionId = "effect-workflow/payment/42"
): CallActivity.BackendLocator =>
  success(CallActivity.validateBackendLocator({
    locatorVersion: CallActivity.BackendLocatorVersion,
    backendId: "effect-workflow",
    executionId
  }))

const childCommand = (
  callFrameId: string,
  event: Protocol.Event,
  backendLocator?: CallActivity.BackendLocator
) => ({
  commandVersion: CallActivity.ApplyChildEventCommandVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  callFrameId,
  event,
  ...(backendLocator === undefined
    ? undefined
    : { backendLocator })
})

const appendJournal = (
  ...batches: ReadonlyArray<BpmnKernel.TransitionBatch>
): BpmnKernel.TransitionJournal => batches.flatMap((batch) => batch.events)

describe("BpmnKernel PortableChildProcess/1 compilation", () => {
  it("pins the exact QName, target, evaluator, and executable fingerprint", () => {
    const exact = callBinding()
    const compiled = compile(model(), [exact])
    const resolved = success(
      BpmnKernel.callActivityBinding(
        compiled,
        callActivityNodeId
      )
    )

    assert.deepStrictEqual(resolved, exact)
    assert.deepStrictEqual(compiled.callActivityBindings, [exact])
    assert.deepStrictEqual(compiled.evaluatorBindings, [
      evaluatorBinding()
    ])

    const changedTarget = target()
    changedTarget.definition.deploymentId = "payment-build-20"
    changedTarget.artifactDigest = digest("7")
    const changed = compile(model(), [
      callBinding(changedTarget)
    ])
    assert.notStrictEqual(
      changed.modelReference.executableFingerprint,
      compiled.modelReference.executableFingerprint
    )
  })

  it("rejects a missing binding and every source QName mismatch", () => {
    failureWithCode(
      prepareResult(model(), []),
      BpmnKernel.Codes.UnsupportedActivity
    )

    const mismatchedBinding = callBinding()
    const changedQName = {
      ...mismatchedBinding,
      calledElement: {
        ...mismatchedBinding.calledElement,
        localName: "refund"
      }
    }
    failureWithCode(
      prepareResult(
        model(),
        [changedQName as CallActivity.CallActivityBinding]
      ),
      BpmnKernel.Codes.InvalidKernelProfile
    )

    failureWithCode(
      prepareResult(model({
        namespaceUri: calledElement.namespaceUri,
        localName: "refund"
      })),
      BpmnKernel.Codes.InvalidKernelProfile
    )
  })
})

describe("BpmnKernel durable CallActivity execution", () => {
  it("requires executionContext before opening any child relation", () => {
    const kernel = compile()
    const rejected = BpmnKernel.initialize(
      kernel,
      initializeCommand(false),
      services(openedAt)
    )
    failureWithCode(rejected, BpmnKernel.Codes.InvalidCommand)

    const invalidContext = {
      ...initializeCommand(),
      executionContext: {
        ...executionContext(),
        rootRunId: "foreign-root"
      }
    }
    failureWithCode(
      BpmnKernel.initialize(
        kernel,
        invalidContext,
        services(openedAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )
  })

  it("opens one durable wait, evaluates encoded input once, and replays its exact journal", () => {
    const kernel = compile()
    const observed: Array<BpmnKernel.EvaluationContext> = []
    const initialized = initialize(kernel, observed)
    const frame = initialized.state.callFrames[0]

    assert.strictEqual(observed.length, 1)
    assert.strictEqual(observed[0]?._tag, "CallActivityInput")
    if (observed[0]?._tag === "CallActivityInput") {
      assert.strictEqual(
        observed[0].request.expectedResult,
        "json"
      )
      assert.deepStrictEqual(observed[0].binding, callBinding())
      assert.strictEqual(
        observed[0].ownerTokenId,
        frame?.ownerTokenId
      )
      assert.strictEqual(
        observed[0].callFrameId,
        frame?.callFrameId
      )
    }

    assert.strictEqual(initialized.state.status, "active")
    assert.deepStrictEqual(
      initialized.state.executionContext,
      executionContext()
    )
    assert.strictEqual(initialized.state.callFrames.length, 1)
    assert.isDefined(frame)
    assert.strictEqual(frame?.childEvents.length, 1)
    assert.strictEqual(
      frame?.childEvents[0]?.payload._tag,
      "ChildScheduled"
    )
    assert.isUndefined(frame?.backendLocator)

    const activeCallTokens = initialized.state.tokens.filter(
      (token) =>
        token.status === "active" &&
        token.position._tag === "AtNode" &&
        token.position.nodeId === callActivityNodeId
    )
    assert.strictEqual(activeCallTokens.length, 1)
    assert.strictEqual(
      activeCallTokens[0]?.tokenId,
      frame?.ownerTokenId
    )

    const evaluatedIndex = initialized.events.findIndex(
      (event) => event._tag === "CallActivityInputEvaluated"
    )
    const commandIndex = initialized.events.findIndex(
      (event) => event._tag === "CallActivityChildCommandCommitted"
    )
    const scheduledIndex = initialized.events.findIndex(
      (event) =>
        event._tag === "CallActivityChildEventCommitted" &&
        event.event.payload._tag === "ChildScheduled"
    )
    assert.isAtLeast(evaluatedIndex, 0)
    assert.isAbove(commandIndex, evaluatedIndex)
    assert.isAbove(scheduledIndex, commandIndex)

    const commandCommit = initialized.events[commandIndex]
    const scheduledCommit = initialized.events[scheduledIndex]
    if (
      commandCommit?._tag !==
        "CallActivityChildCommandCommitted"
    ) {
      throw new Error("Expected portable ScheduleChild outbox command")
    }
    if (
      scheduledCommit?._tag !==
        "CallActivityChildEventCommitted"
    ) {
      throw new Error("Expected scheduled child fact")
    }
    assert.deepStrictEqual(
      commandCommit.command,
      success(CallActivity.makeScheduleCommand(
        relationFrom(initialized),
        encodedInput(),
        frame!.ownerTokenId
      ))
    )
    assert.strictEqual(
      commandCommit.command.payload._tag,
      "ScheduleChild"
    )
    assert.strictEqual(
      commandCommit.command.commandId,
      scheduledCommit.event.eventId
    )
    assert.deepStrictEqual(
      scheduledCommit.event,
      frame?.childEvents[0]
    )

    const replayed = success(
      BpmnKernel.replay(kernel, initialized.events)
    )
    assert.deepStrictEqual(replayed, initialized.state)

    const missingOutboxCommand = initialized.events.filter(
      (event) => event._tag !== "CallActivityChildCommandCommitted"
    )
    failureWithCode(
      BpmnKernel.replay(kernel, missingOutboxCommand),
      BpmnKernel.Codes.InvalidTransitionJournal
    )

    const divergentOutboxCommand = initialized.events.map(
      (event) =>
        event._tag === "CallActivityChildCommandCommitted"
          ? {
            ...event,
            command: {
              ...event.command,
              causationId: "forged-causation"
            }
          }
          : event
    )
    failureWithCode(
      BpmnKernel.replay(kernel, divergentOutboxCommand),
      BpmnKernel.Codes.InvalidTransitionJournal
    )
  })

  it("requires and pins one backend locator on ChildStartAccepted", () => {
    const kernel = compile()
    const initialized = initialize(kernel)
    const relation = relationFrom(initialized)
    const event = startAcceptedEvent(relation)
    const frameId = relation.parent.callId

    failureWithCode(
      BpmnKernel.applyChildEvent(
        kernel,
        initialized.state,
        childCommand(frameId, event),
        services(startedAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )
    failureWithCode(
      BpmnKernel.applyChildEvent(
        kernel,
        initialized.state,
        {
          ...childCommand(frameId, event),
          backendLocator: {
            ...locator(),
            backendId: ""
          }
        },
        services(startedAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )

    const accepted = success(BpmnKernel.applyChildEvent(
      kernel,
      initialized.state,
      childCommand(frameId, event, locator()),
      services(startedAt)
    ))
    const frame = accepted.state.callFrames[0]
    const folded = success(CallActivity.foldFrame(frame))

    assert.strictEqual(folded.phase._tag, "Running")
    assert.deepStrictEqual(frame?.backendLocator, locator())
    assert.strictEqual(frame?.childEvents.length, 2)
    assert.deepStrictEqual(frame?.childEvents[1], event)
    assert.deepStrictEqual(
      accepted.events.map((entry) => entry._tag),
      ["CallActivityChildEventCommitted"]
    )

    const journal = appendJournal(initialized, accepted)
    assert.deepStrictEqual(
      success(BpmnKernel.replay(kernel, journal)),
      accepted.state
    )

    failureWithCode(
      BpmnKernel.applyChildEvent(
        kernel,
        accepted.state,
        childCommand(
          frameId,
          succeededEvent(relation),
          locator("effect-workflow/payment/foreign")
        ),
        services(succeededAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )
  })

  it("rejects divergent replay and individually valid illegal child history", () => {
    const kernel = compile()
    const initialized = initialize(kernel)
    const relation = relationFrom(initialized)
    const frameId = relation.parent.callId
    const acceptedEvent = startAcceptedEvent(relation)
    const accepted = success(BpmnKernel.applyChildEvent(
      kernel,
      initialized.state,
      childCommand(frameId, acceptedEvent, locator()),
      services(startedAt)
    ))

    const divergent = startAcceptedEvent(
      relation,
      "2026-07-24T10:00:01.500Z"
    )
    assert.strictEqual(divergent.eventId, acceptedEvent.eventId)
    failureWithCode(
      BpmnKernel.applyChildEvent(
        kernel,
        accepted.state,
        childCommand(frameId, divergent, locator()),
        services(succeededAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )

    const illegalTerminal = succeededEvent(
      relation,
      1,
      startedAt
    )
    failureWithCode(
      BpmnKernel.applyChildEvent(
        kernel,
        initialized.state,
        childCommand(frameId, illegalTerminal),
        services(startedAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )
    assert.strictEqual(
      initialized.state.callFrames[0]?.childEvents.length,
      1
    )
  })

  it("consumes and routes a successful child exactly once across live execution and replay", () => {
    const kernel = compile()
    const initialized = initialize(kernel)
    const relation = relationFrom(initialized)
    const frameId = relation.parent.callId
    const accepted = success(BpmnKernel.applyChildEvent(
      kernel,
      initialized.state,
      childCommand(
        frameId,
        startAcceptedEvent(relation),
        locator()
      ),
      services(startedAt)
    ))
    const terminalEvent = succeededEvent(relation)
    const completed = success(BpmnKernel.applyChildEvent(
      kernel,
      accepted.state,
      childCommand(frameId, terminalEvent, locator()),
      services(succeededAt)
    ))
    const completedFrame = completed.state.callFrames[0]
    const folded = success(
      CallActivity.foldFrame(completedFrame)
    )

    assert.strictEqual(folded.phase._tag, "Succeeded")
    assert.strictEqual(completed.state.status, "completed")
    assert.strictEqual(completedFrame?.exitedAt, succeededAt)
    assert.strictEqual(
      completed.events.filter(
        (event) =>
          event._tag === "TokenConsumed" &&
          event.reason === "call-activity-succeeded"
      ).length,
      1
    )
    assert.strictEqual(
      completed.events.filter(
        (event) => event._tag === "ExecutionCompleted"
      ).length,
      1
    )

    const terminalJournal = appendJournal(
      initialized,
      accepted,
      completed
    )
    assert.deepStrictEqual(
      success(BpmnKernel.replay(kernel, terminalJournal)),
      completed.state
    )

    const replay = success(BpmnKernel.applyChildEvent(
      kernel,
      completed.state,
      childCommand(frameId, terminalEvent, locator()),
      services(replayedAt)
    ))
    assert.deepStrictEqual(replay.state, completed.state)
    assert.deepStrictEqual(
      replay.events.map((event) => event._tag),
      ["CallActivityChildEventReplayed"]
    )
    assert.strictEqual(
      replay.events.filter(
        (event) => event._tag === "TokenConsumed"
      ).length,
      0
    )
    assert.deepStrictEqual(
      success(BpmnKernel.replay(
        kernel,
        appendJournal(
          initialized,
          accepted,
          completed,
          replay
        )
      )),
      completed.state
    )

    const divergentTerminal = {
      ...terminalEvent,
      recordedAt: replayedAt
    }
    failureWithCode(
      BpmnKernel.applyChildEvent(
        kernel,
        completed.state,
        childCommand(
          frameId,
          divergentTerminal,
          locator()
        ),
        services(replayedAt)
      ),
      BpmnKernel.Codes.InvalidCommand
    )
  })

  it.effect("exposes the same successful commit through BpmnExpressionRuntime.applyChildEvent", () =>
    Effect.gen(function*() {
      const kernel = compile()
      const initialized = initialize(kernel)
      const relation = relationFrom(initialized)
      const accepted = success(BpmnKernel.applyChildEvent(
        kernel,
        initialized.state,
        childCommand(
          relation.parent.callId,
          startAcceptedEvent(relation),
          locator()
        ),
        services(startedAt)
      ))
      const registry = yield* Evaluator.makeMemory([])
      const completed = yield* Runtime.applyChildEvent(
        kernel,
        accepted.state,
        childCommand(
          relation.parent.callId,
          succeededEvent(relation),
          locator()
        ),
        { now: succeededAt }
      ).pipe(
        Effect.provideService(
          Evaluator.EvaluatorRegistry,
          registry
        )
      )

      assert.strictEqual(completed.state.status, "completed")
      assert.strictEqual(
        success(
          CallActivity.foldFrame(
            completed.state.callFrames[0]
          )
        ).phase._tag,
        "Succeeded"
      )
      assert.strictEqual(
        completed.events.filter(
          (event) =>
            event._tag === "TokenConsumed" &&
            event.reason === "call-activity-succeeded"
        ).length,
        1
      )
    }))
})
