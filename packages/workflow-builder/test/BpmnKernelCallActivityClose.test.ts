import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Activity from "../src/BpmnActivityV3.ts"
import * as Call from "../src/BpmnCallActivityV3.ts"
import * as Kernel from "../src/BpmnKernel.ts"
import * as Model from "../src/BpmnModel.ts"
import * as Operational from "../src/BpmnOperationalV3.ts"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"
import * as Wire2 from "../src/ProtocolV2Wire.ts"
import * as Wire3 from "../src/ProtocolV3Wire.ts"

const processId = "kernel-call-close"
const callId = "call-child"
const taskId = "fail-parent"
const digest = (x: string) => `sha256:${x.repeat(64)}`
const at = (n: number) => `2026-07-24T12:00:0${n}.000Z`
const inline = <A>(value: A) => ({ _tag: "Inline" as const, value })
const ok = <A, E>(value: Result.Result<A, E>): A => {
  if (Result.isFailure(value)) throw value.failure
  assert.isTrue(Result.isSuccess(value))
  return value.success
}
const crypto = Crypto.make({
  randomBytes: (n) => new Uint8Array(n),
  digest: (_a, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})
const wire = <A>(schema: Schema.Schema<A>, value: unknown): A => Schema.decodeUnknownSync(schema)(value)
const limits: Kernel.KernelLimits = {
  maxAutomaticTransitions: 1000,
  maxExecutionInputCanonicalBytes: 1048576,
  maxExecutionStateCanonicalBytes: 8388608,
  maxTransitionJournalEvents: 10000,
  maxTransitionJournalCanonicalBytes: 16777216,
  maxCatchWaitArms: 32,
  maxTimerDelayMillis: 31536000000,
  maxTimerExpressionUtf8Bytes: 4096,
  maxMessageCorrelationComponents: 16,
  maxMessageCorrelationCanonicalBytes: 16384,
  maxMessagePayloadCanonicalBytes: 1048576,
  maxMultiInstanceCardinality: 128,
  maxMultiInstanceCollectionCanonicalBytes: 1048576,
  maxMultiInstanceItemCanonicalBytes: 262144,
  maxMultiInstanceOutputCanonicalBytes: 1048576,
  maxMultiInstanceItemOutputCanonicalBytes: 262144
}
const expression: Model.Expression = { language: "close-input", version: "1", source: "input" }
const evaluator = {
  language: expression.language,
  languageVersion: expression.version,
  build: { id: "e", version: "1", deploymentId: "e-1", buildDigest: wire(Wire2.BuildDigest, digest("1")) },
  limits: { maxSourceUtf8Bytes: 4096, maxContextCanonicalBytes: 1048576, maxSteps: 10000, timeoutMillis: 1000 }
}
const target = (failure: Child.ChildCloseAction, cancellation: Child.ChildCloseAction) => ({
  targetVersion: Child.ExecutionProtocolVersion,
  artifactVersion: Child.ExecutionProtocolVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  artifactDigest: digest("2"),
  plan: { id: "child", revision: 1 },
  compilerSemanticVersion: "2" as const,
  compiledFingerprint: digest("3"),
  definition: { id: "child", version: "1", deploymentId: "child-1", buildDigest: digest("4") },
  workflowFamilyIdentity: Child.workflowFamilyIdentity("child"),
  inputContractDigest: digest("5"),
  outputContractDigest: digest("6"),
  closePolicy: {
    closePolicyVersion: Child.ExecutionProtocolVersion,
    onParentFailure: failure,
    onParentCancellation: cancellation
  },
  recursionPolicy: "Forbid" as const,
  maxLineageDepth: Child.MaximumLineageDepth
})
const binding = (failure: Child.ChildCloseAction, cancellation: Child.ChildCloseAction) =>
  ok(Call.validateBinding({
    bindingVersion: Call.CallActivityBindingVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    profileId: Call.PortableChildProcessProfile,
    callActivityNodeId: callId,
    calledElement: { namespaceUri: "urn:test", localName: "child" },
    target: target(failure, cancellation),
    encodedInputExpression: expression,
    maxEncodedInputCanonicalBytes: 1048576
  }))
const taskBinding = () =>
  wire(Activity.TaskBinding, {
    bindingVersion: Activity.BindingVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    taskNodeId: taskId,
    artifactDigest: digest("7"),
    semanticNodeId: "fail-parent",
    errorMappings: []
  })
const node = (value: Record<string, unknown>) => value as Model.FlowNode
const flow = (id: string, sourceId: string, targetId: string) => ({
  id,
  processId,
  parentScopeId: processId,
  sourceId,
  targetId,
  kind: "normal" as const,
  extensionElements: []
})
const model = (): Model.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: Model.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  collaborations: [],
  processes: [{ id: processId, isExecutable: true, extensionElements: [] }],
  flowNodes: [
    node({
      _tag: "StartEvent",
      id: "start",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["s-g"],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    }),
    node({
      _tag: "Gateway",
      id: "split",
      processId,
      parentScopeId: processId,
      gatewayKind: "parallel",
      gatewayDirection: "diverging",
      incomingSequenceFlowIds: ["s-g"],
      outgoingSequenceFlowIds: ["g-t", "g-c"],
      extensionElements: []
    }),
    node({
      _tag: "Task",
      id: taskId,
      processId,
      parentScopeId: processId,
      taskKind: "generic",
      incomingSequenceFlowIds: ["g-t"],
      outgoingSequenceFlowIds: ["t-e"],
      extensionElements: []
    }),
    node({
      _tag: "CallActivity",
      id: callId,
      processId,
      parentScopeId: processId,
      calledElement: { namespaceUri: "urn:test", localName: "child" },
      incomingSequenceFlowIds: ["g-c"],
      outgoingSequenceFlowIds: ["c-e"],
      extensionElements: []
    }),
    node({
      _tag: "EndEvent",
      id: "end-task",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["t-e"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    }),
    node({
      _tag: "EndEvent",
      id: "end-call",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["c-e"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    })
  ],
  sequenceFlows: [
    flow("s-g", "start", "split"),
    flow("g-t", "split", taskId),
    flow("g-c", "split", callId),
    flow("t-e", taskId, "end-task"),
    flow("c-e", callId, "end-call")
  ]
})
const services = (now: string): Kernel.Services => ({
  now: wire(Wire2.Timestamp, now),
  evaluateExpression: () => Result.succeed({ result: inline({ order: "42" }), steps: 1 })
})
const compile = (failure: Child.ChildCloseAction, cancellation: Child.ChildCloseAction) =>
  ok(Effect.runSync(
    Kernel.prepare(model(), {
      profileId: Call.PortableChildProcessProfile,
      rootProcessId: processId,
      limits,
      evaluatorBindings: [evaluator],
      callActivityBindings: [binding(failure, cancellation)],
      taskBindings: [taskBinding()]
    }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.result)
  ) as Result.Result<Kernel.CompiledKernel, unknown>)
const initial = (kernel: Kernel.CompiledKernel) =>
  ok(Kernel.initialize(kernel, {
    commandVersion: Kernel.InitializeCommandVersion,
    input: null,
    executionContext: {
      contextVersion: Call.ExecutionContextVersion,
      executionProtocolVersion: Child.ExecutionProtocolVersion,
      tenantId: "tenant",
      runId: "parent",
      rootRunId: "parent",
      artifactDigest: digest("8"),
      workflowFamilyIdentity: Child.workflowFamilyIdentity("parent"),
      ancestry: [{
        lineageEntryVersion: Child.ExecutionProtocolVersion,
        depth: 0,
        tenantId: "tenant",
        runId: "parent",
        artifactDigest: digest("8"),
        workflowFamilyIdentity: Child.workflowFamilyIdentity("parent")
      }]
    }
  }, services(at(0))))
const frame = (state: Kernel.TransitionBatch["state"]) => {
  const result = state.callFrames[0]
  if (result === undefined) throw new Error("missing call frame")
  return result
}
const relation = (state: Kernel.TransitionBatch["state"]) => {
  const event = frame(state).childEvents[0]
  if (event?.payload._tag !== "ChildScheduled") throw new Error("missing schedule")
  return event.payload.relation
}
const locator = () =>
  ok(
    Call.validateBackendLocator({
      locatorVersion: Call.BackendLocatorVersion,
      backendId: "test",
      executionId: "child-42"
    })
  )
const event = (
  r: Child.ChildRelation,
  eventId: string,
  causationId: string,
  sequence: number,
  recordedAt: string,
  payload: Record<string, unknown>
) =>
  ok(Protocol.validateEvent({
    eventVersion: Protocol.EventVersion,
    executionProtocolVersion: Protocol.ExecutionProtocolVersion,
    eventId,
    tenantId: r.parent.tenantId,
    parentRunId: r.parent.parentRunId,
    callId: r.parent.callId,
    sequence,
    recordedAt,
    causationId,
    correlationId: r.parent.callId,
    payload
  }))
const started = (r: Child.ChildRelation) =>
  event(
    r,
    Protocol.childStartProjectionEventId(r.parent.tenantId, r.parent.parentRunId, r.parent.callId, "started"),
    "started",
    1,
    at(1),
    {
      _tag: "ChildStartAccepted",
      childRunId: r.childRunId,
      startRequestId: r.startRequestId,
      childRunStartedEventId: "started"
    }
  )
const cancelled = (r: Child.ChildRelation) =>
  event(
    r,
    Protocol.childTerminalProjectionEventId(r.parent.tenantId, r.parent.parentRunId, r.parent.callId, "cancelled"),
    "cancelled",
    3,
    at(3),
    {
      _tag: "ChildCancelled",
      childRunId: r.childRunId,
      childTerminalEventId: "cancelled",
      cancellation: inline({ source: "parent" })
    }
  )
const cancelledBeforeStart = (
  r: Child.ChildRelation,
  command: Call.ParentCloseCommand
) => {
  assert.strictEqual(command.payload._tag, "RequestChildCancellation")
  if (command.payload._tag !== "RequestChildCancellation") {
    throw new Error("expected cancellation command")
  }
  const parentCause = command.payload.parentCause
  return event(
    r,
    Protocol.childCancelledBeforeStartEventId(
      r.parent.tenantId,
      r.parent.parentRunId,
      r.parent.callId,
      parentCause.parentCauseEventId
    ),
    command.commandId,
    1,
    at(3),
    {
      _tag: "ChildCancelledBeforeStart",
      childRunId: r.childRunId,
      startRequestId: r.startRequestId,
      parentCause,
      parentCauseEventId: parentCause.parentCauseEventId,
      closeAction: command.payload.closeAction,
      cancellationCommandId: command.commandId
    }
  )
}
const apply = (
  kernel: Kernel.CompiledKernel,
  state: Kernel.TransitionBatch["state"],
  child: Protocol.Event,
  now: string
) =>
  ok(Kernel.applyChildEvent(kernel, state, {
    commandVersion: Call.ApplyChildEventCommandVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    callFrameId: child.callId,
    event: child,
    backendLocator: locator()
  }, services(now)))
const applyWithoutLocator = (
  kernel: Kernel.CompiledKernel,
  state: Kernel.TransitionBatch["state"],
  child: Protocol.Event,
  now: string
) =>
  ok(Kernel.applyChildEvent(kernel, state, {
    commandVersion: Call.ApplyChildEventCommandVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    callFrameId: child.callId,
    event: child
  }, services(now)))
const failure = () =>
  wire(Activity.TaskBusinessFailed, {
    _tag: "BusinessFailed",
    outcomeVersion: Activity.OutcomeVersion,
    artifactDigest: digest("7"),
    semanticNodeId: "fail-parent",
    occurrenceDigest: digest("9"),
    firstActivityDigest: digest("a"),
    terminal: {
      _tag: "NonRetryable",
      terminalVersion: 1,
      decision: { _tag: "Classifier", decisionVersion: 1, classificationActivityDigest: digest("b") }
    },
    failedActivityDigest: digest("c"),
    attempt: 1,
    identity: { failureIdentityVersion: 1, errorTag: "parent-failure", errorCode: null }
  })
const succeeded = () =>
  wire(Activity.TaskSucceeded, {
    _tag: "Succeeded",
    outcomeVersion: Activity.OutcomeVersion,
    artifactDigest: digest("7"),
    semanticNodeId: "fail-parent",
    occurrenceDigest: digest("d"),
    firstActivityDigest: digest("e"),
    attempt: 1,
    completedActivityDigest: digest("f"),
    output: inline(null)
  })
const failParent = (kernel: Kernel.CompiledKernel, state: Kernel.TransitionBatch["state"]) => {
  const token = state.tokens.find((t) =>
    t.status === "active" && t.position._tag === "AtNode" && t.position.nodeId === taskId
  )
  if (token === undefined) throw new Error("missing failure task")
  return ok(Kernel.resolveTask(kernel, state, {
    commandVersion: Activity.CommandVersion,
    scopeInstanceId: token.scopeInstanceId,
    taskNodeId: taskId,
    tokenId: token.tokenId,
    outcome: failure()
  }, services(at(2))))
}
const withdraw = (kernel: Kernel.CompiledKernel, state: Kernel.TransitionBatch["state"]) => {
  const root = state.scopeInstances.find((s) => s.parentScopeInstanceId === undefined)
  if (root === undefined) throw new Error("missing root")
  return ok(Kernel.withdrawExecution(
    kernel,
    state,
    {
      commandVersion: Operational.OperationalInstanceWithdrawalVersion,
      rootScopeInstanceId: root.scopeInstanceId,
      requestId: "withdrawal",
      attribution: { actorId: "operator", policyId: "test", policyVersion: "1", policyDecisionId: "1" },
      reasonCode: "test"
    } satisfies Operational.RequestInstanceWithdrawalCommand,
    services(at(2))
  ))
}
const resolveParentTask = (
  kernel: Kernel.CompiledKernel,
  state: Kernel.TransitionBatch["state"],
  now: string
) => {
  const token = state.tokens.find((candidate) =>
    candidate.position._tag === "AtNode" &&
    candidate.position.nodeId === taskId
  )
  if (token === undefined) throw new Error("missing parent task")
  return ok(Kernel.resolveTask(kernel, state, {
    commandVersion: Activity.CommandVersion,
    scopeInstanceId: token.scopeInstanceId,
    taskNodeId: taskId,
    tokenId: token.tokenId,
    outcome: succeeded()
  }, services(now)))
}
const replay = (kernel: Kernel.CompiledKernel, ...batches: ReadonlyArray<Kernel.TransitionBatch>) =>
  ok(Kernel.replay(kernel, batches.flatMap((batch) => batch.events)))

describe("BpmnKernel CallActivity parent close", () => {
  it("waits across a started CancelAndWait child, survives replay, and idempotently accepts its late terminal fact", () => {
    const kernel = compile("CancelAndWait", "RequestCancel")
    const opened = initial(kernel)
    const running = apply(kernel, opened.state, started(relation(opened.state)), at(1))
    const closing = failParent(kernel, running.state)
    assert.strictEqual(closing.state.status, "failing")
    assert.strictEqual(frame(closing.state).parentCloseCommand?.payload.closeAction, "CancelAndWait")
    assert.deepStrictEqual(frame(closing.state).childEvents.map((entry) => entry.payload._tag), [
      "ChildScheduled",
      "ChildStartAccepted",
      "ChildCancellationRequested"
    ])
    assert.deepStrictEqual(replay(kernel, opened, running, closing), closing.state)
    const terminal = cancelled(relation(closing.state))
    const failed = apply(kernel, closing.state, terminal, at(3))
    assert.strictEqual(failed.state.status, "failed")
    assert.deepStrictEqual(replay(kernel, opened, running, closing, failed), failed.state)
    const late = apply(kernel, failed.state, terminal, at(3))
    assert.deepStrictEqual(late.state, failed.state)
    assert.deepStrictEqual(late.events.map((entry) => entry._tag), ["CallActivityChildEventReplayed"])
  })

  it("discharges scheduled RequestCancel on parent failure and abandons a started child on operational withdrawal", () => {
    const failureKernel = compile("RequestCancel", "RequestCancel")
    const opened = initial(failureKernel)
    const failed = failParent(failureKernel, opened.state)
    assert.strictEqual(failed.state.status, "failed")
    assert.strictEqual(frame(failed.state).parentCloseCommand?.payload.closeAction, "RequestCancel")
    assert.deepStrictEqual(replay(failureKernel, opened, failed), failed.state)

    const withdrawalKernel = compile("CancelAndWait", "Abandon")
    const withdrawalOpened = initial(withdrawalKernel)
    const running = apply(withdrawalKernel, withdrawalOpened.state, started(relation(withdrawalOpened.state)), at(1))
    const withdrawn = withdraw(withdrawalKernel, running.state)
    assert.strictEqual(withdrawn.state.status, "cancelled")
    assert.strictEqual(frame(withdrawn.state).parentCloseCommand?.payload.closeAction, "Abandon")
    assert.strictEqual(frame(withdrawn.state).childEvents.at(-1)?.payload._tag, "ChildAbandoned")
    assert.deepStrictEqual(replay(withdrawalKernel, withdrawalOpened, running, withdrawn), withdrawn.state)
    const repeated = withdraw(withdrawalKernel, withdrawn.state)
    assert.deepStrictEqual(repeated.state, withdrawn.state)
    assert.deepStrictEqual(repeated.events.map((entry) => entry._tag), ["OperationalWithdrawalReplayed"])
  })

  it("survives a scheduled CancelAndWait start race and finalizes only after cancellation wins", () => {
    const kernel = compile("CancelAndWait", "RequestCancel")
    const opened = initial(kernel)
    const closing = failParent(kernel, opened.state)
    const closeCommand = frame(closing.state).parentCloseCommand
    if (closeCommand === undefined) throw new Error("missing close command")
    assert.strictEqual(closing.state.status, "failing")
    assert.deepStrictEqual(replay(kernel, opened, closing), closing.state)

    const terminal = applyWithoutLocator(
      kernel,
      closing.state,
      cancelledBeforeStart(relation(closing.state), closeCommand),
      at(3)
    )
    assert.strictEqual(terminal.state.status, "failed")
    assert.strictEqual(
      frame(terminal.state).childEvents.at(-1)?.payload._tag,
      "ChildCancelledBeforeStart"
    )
    assert.deepStrictEqual(
      replay(kernel, opened, closing, terminal),
      terminal.state
    )
  })

  it("audits a late RequestCancel start and terminal fact without reopening its failed parent", () => {
    const kernel = compile("RequestCancel", "RequestCancel")
    const opened = initial(kernel)
    const failed = failParent(kernel, opened.state)
    assert.strictEqual(failed.state.status, "failed")

    const lateStart = apply(
      kernel,
      failed.state,
      started(relation(failed.state)),
      at(3)
    )
    assert.strictEqual(lateStart.state.status, "failed")
    assert.deepStrictEqual(
      frame(lateStart.state).childEvents.map((entry) => entry.payload._tag),
      [
        "ChildScheduled",
        "ChildStartAccepted",
        "ChildCancellationRequested"
      ]
    )
    assert.deepStrictEqual(
      replay(kernel, opened, failed, lateStart),
      lateStart.state
    )

    const lateTerminal = apply(
      kernel,
      lateStart.state,
      cancelled(relation(lateStart.state)),
      at(4)
    )
    assert.strictEqual(lateTerminal.state.status, "failed")
    assert.strictEqual(
      frame(lateTerminal.state).childEvents.at(-1)?.payload._tag,
      "ChildCancelled"
    )
    assert.deepStrictEqual(
      replay(kernel, opened, failed, lateStart, lateTerminal),
      lateTerminal.state
    )
  })

  it("fences ordinary progress while closing and audits a task outcome after delayed operational withdrawal", () => {
    const kernel = compile("RequestCancel", "CancelAndWait")
    const opened = initial(kernel)
    const running = apply(
      kernel,
      opened.state,
      started(relation(opened.state)),
      at(1)
    )
    const closing = withdraw(kernel, running.state)
    assert.strictEqual(closing.state.status, "cancelling")
    const advanced = Kernel.advance(kernel, closing.state, services(at(2)))
    assert.isTrue(Result.isFailure(advanced))
    if (Result.isSuccess(advanced)) throw new Error("closing advance succeeded")
    assert(
      advanced.failure.diagnostics.some((diagnostic) => diagnostic.code === Kernel.Codes.InvalidCommand)
    )

    const terminal = apply(
      kernel,
      closing.state,
      cancelled(relation(closing.state)),
      at(3)
    )
    assert.strictEqual(terminal.state.status, "cancelled")
    assert.strictEqual(terminal.state.completedAt, at(3))

    const fenced = resolveParentTask(kernel, terminal.state, at(4))
    assert.deepStrictEqual(
      fenced.events.map((entry) => entry._tag),
      ["TaskOutcomeFenced"]
    )
    assert.deepStrictEqual(fenced.state, terminal.state)
    assert.deepStrictEqual(
      replay(kernel, opened, running, closing, terminal, fenced),
      terminal.state
    )
  })
})
