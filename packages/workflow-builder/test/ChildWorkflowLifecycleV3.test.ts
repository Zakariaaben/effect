import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as CallActivity from "../src/BpmnCallActivityV3.ts"
import * as Lifecycle from "../src/ChildWorkflowLifecycleV3.ts"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as State from "../src/ChildWorkflowStateV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`

const timestamp = (
  second: number
): string => `2026-07-24T10:00:${String(second).padStart(2, "0")}.000Z`

const inline = <A>(value: A) => ({
  _tag: "Inline" as const,
  value
})

const tenantId = "tenant-lifecycle"
const parentRunId = "parent-run-lifecycle"
const nodeId = "call-payment"
const nodeInstanceId = "call-payment-token-1"

const executionContext = () => ({
  contextVersion: CallActivity.ExecutionContextVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  tenantId,
  runId: parentRunId,
  rootRunId: parentRunId,
  artifactDigest: digest("a"),
  workflowFamilyIdentity: Child.workflowFamilyIdentity("orders"),
  ancestry: [{
    lineageEntryVersion: Child.ExecutionProtocolVersion,
    depth: 0,
    tenantId,
    runId: parentRunId,
    artifactDigest: digest("a"),
    workflowFamilyIdentity: Child.workflowFamilyIdentity("orders")
  }]
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

const binding = () => ({
  bindingVersion: CallActivity.CallActivityBindingVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  profileId: CallActivity.PortableChildProcessProfile,
  callActivityNodeId: nodeId,
  calledElement: {
    namespaceUri: "urn:example:payments",
    localName: "payment"
  },
  target: target(),
  encodedInputExpression: {
    language: "effect-expression",
    version: "1",
    source: "encodePaymentInput"
  },
  maxEncodedInputCanonicalBytes: CallActivity.MaximumEncodedInputCanonicalBytes
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failureCode = <A, E extends { readonly code: string }>(
  result: Result.Result<A, E>,
  code: string
): E => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error(`Expected ${code}`)
  }
  assert.strictEqual(result.failure.code, code)
  return result.failure
}

const relation = (): Child.ChildRelation =>
  success(
    CallActivity.deriveRelation(
      executionContext(),
      binding(),
      nodeInstanceId
    )
  )

const scheduledEvent = (
  childRelation: Child.ChildRelation = relation(),
  recordedAt = timestamp(0)
): Protocol.Event =>
  success(
    CallActivity.makeScheduledEvent(
      childRelation,
      inline({
        invoiceId: "invoice-1",
        amount: 42
      }),
      recordedAt,
      "parent-call-activated"
    )
  )

const scheduledState = (
  childRelation: Child.ChildRelation = relation(),
  recordedAt = timestamp(0)
): State.ChildWorkflowState => success(State.fold([scheduledEvent(childRelation, recordedAt)]))

const startAcceptedFact = (
  childRelation: Child.ChildRelation,
  childRunStartedEventId = "child-run-started",
  sourceSequence = 11,
  occurredAt = timestamp(40)
) => ({
  _tag: "ChildStartAccepted" as const,
  factVersion: Lifecycle.LifecycleFactVersion,
  childRunId: childRelation.childRunId,
  sourceSequence,
  occurredAt,
  childRunStartedEventId
})

const succeededFact = (
  childRelation: Child.ChildRelation,
  childTerminalEventId = "child-run-succeeded",
  sourceSequence = 12,
  occurredAt = timestamp(41)
) => ({
  _tag: "ChildSucceeded" as const,
  factVersion: Lifecycle.LifecycleFactVersion,
  childRunId: childRelation.childRunId,
  sourceSequence,
  occurredAt,
  childTerminalEventId,
  outputContractDigest: childRelation.target.outputContractDigest,
  encodedOutput: inline({
    receiptId: "receipt-1",
    status: "captured"
  })
})

const failedFact = (
  childRelation: Child.ChildRelation,
  childTerminalEventId = "child-run-failed",
  sourceSequence = 12,
  occurredAt = timestamp(41)
) => ({
  _tag: "ChildFailed" as const,
  factVersion: Lifecycle.LifecycleFactVersion,
  childRunId: childRelation.childRunId,
  sourceSequence,
  occurredAt,
  childTerminalEventId,
  failure: inline({
    code: "PaymentDeclined"
  })
})

const prepare = (
  state: State.ChildWorkflowState,
  fact: unknown,
  recordedAt: string
) =>
  Lifecycle.prepareLifecycleEvent(state, {
    requestVersion: Lifecycle.PreparationRequestVersion,
    recordedAt,
    fact
  })

const runningState = (
  childRelation: Child.ChildRelation = relation()
): State.ChildWorkflowState =>
  success(
    prepare(
      scheduledState(childRelation),
      startAcceptedFact(childRelation),
      timestamp(1)
    )
  ).nextState

const cancellationRequestedState = (
  childRelation: Child.ChildRelation = relation()
): State.ChildWorkflowState => {
  const running = runningState(childRelation)
  const parentCauseEventId = "parent-run-failed"
  const cancellationCommandId = Protocol.requestChildCancellationCommandId(
    childRelation.parent.tenantId,
    childRelation.parent.parentRunId,
    childRelation.parent.callId,
    parentCauseEventId
  )
  const request = success(Protocol.validateEvent({
    eventVersion: Protocol.EventVersion,
    executionProtocolVersion: Protocol.ExecutionProtocolVersion,
    eventId: cancellationCommandId,
    tenantId: childRelation.parent.tenantId,
    parentRunId: childRelation.parent.parentRunId,
    callId: childRelation.parent.callId,
    sequence: running.sequence + 1,
    recordedAt: timestamp(2),
    causationId: parentCauseEventId,
    correlationId: childRelation.parent.callId,
    payload: {
      _tag: "ChildCancellationRequested",
      childRunId: childRelation.childRunId,
      parentCause: {
        _tag: "ParentFailure",
        parentCauseEventId
      },
      closeAction: "CancelAndWait",
      cancellationCommandId
    }
  }))
  return success(State.reduce(running, request))
}

describe("ChildWorkflowLifecycleV3", () => {
  it("prepares the canonical start-accepted projection against one exact head", () => {
    const childRelation = relation()
    const state = scheduledState(childRelation)
    const childRunStartedEventId = "child-run-started-42"
    const fact = startAcceptedFact(
      childRelation,
      childRunStartedEventId,
      37,
      timestamp(45)
    )
    const prepared = success(prepare(state, fact, timestamp(1)))

    assert.isTrue(Lifecycle.isPreparedLifecycleEvent(prepared))
    assert.isTrue(Object.isFrozen(prepared))
    assert.strictEqual(
      prepared.preparedVersion,
      Lifecycle.PreparedLifecycleEventVersion
    )
    assert.strictEqual(prepared.expectedPreviousSequence, 0)
    assert.strictEqual(prepared.event.sequence, 1)
    assert.strictEqual(prepared.event.recordedAt, timestamp(1))
    assert.strictEqual(
      prepared.event.eventId,
      Protocol.childStartProjectionEventId(
        childRelation.parent.tenantId,
        childRelation.parent.parentRunId,
        childRelation.parent.callId,
        childRunStartedEventId
      )
    )
    assert.strictEqual(
      prepared.event.causationId,
      childRunStartedEventId
    )
    assert.strictEqual(
      prepared.event.correlationId,
      childRelation.parent.callId
    )
    assert.deepStrictEqual(prepared.event.payload, {
      _tag: "ChildStartAccepted",
      childRunId: childRelation.childRunId,
      startRequestId: childRelation.startRequestId,
      childRunStartedEventId
    })
    assert.strictEqual(prepared.nextState.phase._tag, "Running")
    assert.strictEqual(prepared.nextState.sequence, 1)
    assert.isTrue(State.isDerived(prepared.nextState))
  })

  it("prepares an authority-owned permanent start failure without inventing a child event", () => {
    const childRelation = relation()
    const decidedAt = timestamp(40)
    const fact = {
      _tag: "ChildStartFailed" as const,
      factVersion: Lifecycle.LifecycleFactVersion,
      childRunId: childRelation.childRunId,
      startRequestId: childRelation.startRequestId,
      decidedAt,
      failureKind: "RetriesExhausted" as const,
      failure: inline({
        code: "ChildStartRetriesExhausted"
      })
    }
    const prepared = success(
      prepare(scheduledState(childRelation), fact, timestamp(1))
    )

    assert.strictEqual(
      prepared.event.eventId,
      Protocol.childStartFailedEventId(
        childRelation.parent.tenantId,
        childRelation.parent.parentRunId,
        childRelation.parent.callId,
        childRelation.startRequestId
      )
    )
    assert.strictEqual(
      prepared.event.causationId,
      childRelation.startRequestId
    )
    assert.deepStrictEqual(prepared.event.payload, {
      _tag: "ChildStartFailed",
      childRunId: childRelation.childRunId,
      startRequestId: childRelation.startRequestId,
      failureKind: fact.failureKind,
      failure: fact.failure
    })
    assert.strictEqual(prepared.fact._tag, "ChildStartFailed")
    if (prepared.fact._tag === "ChildStartFailed") {
      assert.strictEqual(prepared.fact.decidedAt, decidedAt)
    }
    assert.strictEqual(prepared.nextState.phase._tag, "StartFailed")
    assert.isTrue(State.isTerminal(prepared.nextState))
  })

  it("prepares a successful terminal projection and proves its exact outcome", () => {
    const childRelation = relation()
    const running = runningState(childRelation)
    const fact = succeededFact(childRelation)
    const prepared = success(prepare(running, fact, timestamp(2)))

    assert.strictEqual(prepared.expectedPreviousSequence, 1)
    assert.strictEqual(prepared.event.sequence, 2)
    assert.deepStrictEqual(prepared.event.payload, {
      _tag: "ChildSucceeded",
      childRunId: childRelation.childRunId,
      childTerminalEventId: fact.childTerminalEventId,
      outputContractDigest: childRelation.target.outputContractDigest,
      encodedOutput: fact.encodedOutput
    })
    assert.strictEqual(prepared.nextState.phase._tag, "Succeeded")
    assert.strictEqual(prepared.nextState.outcome._tag, "Succeeded")
    assert.isTrue(State.isTerminal(prepared.nextState))
    if (prepared.nextState.outcome._tag === "Succeeded") {
      assert.strictEqual(
        prepared.nextState.outcome.outputContractDigest,
        childRelation.target.outputContractDigest
      )
      assert.deepStrictEqual(
        prepared.nextState.outcome.encodedOutput,
        fact.encodedOutput
      )
    }
  })

  it("accepts child cancellation only for the exact live durable request", () => {
    const childRelation = relation()
    const running = runningState(childRelation)
    const fact = {
      _tag: "ChildCancellationAccepted" as const,
      factVersion: Lifecycle.LifecycleFactVersion,
      childRunId: childRelation.childRunId,
      sourceSequence: 15,
      occurredAt: timestamp(43),
      childCancellationEventId: "child-cancellation-accepted"
    }

    failureCode(
      prepare(running, fact, timestamp(2)),
      Lifecycle.ErrorCodes.MissingCancellationRequest
    )

    const requested = cancellationRequestedState(childRelation)
    const prepared = success(prepare(requested, fact, timestamp(3)))

    assert.strictEqual(
      prepared.event.eventId,
      Protocol.childCancellationAcceptedEventId(
        childRelation.parent.tenantId,
        childRelation.parent.parentRunId,
        childRelation.parent.callId,
        fact.childCancellationEventId
      )
    )
    assert.strictEqual(
      prepared.event.causationId,
      fact.childCancellationEventId
    )
    assert.strictEqual(prepared.event.payload._tag, "ChildCancellationAccepted")
    if (prepared.event.payload._tag === "ChildCancellationAccepted") {
      assert.strictEqual(
        prepared.event.payload.parentCauseEventId,
        "parent-run-failed"
      )
      assert.strictEqual(
        prepared.event.payload.cancellationCommandId,
        requested.close._tag === "CancellationRequested"
          ? requested.close.cancellationCommandId
          : undefined
      )
    }
    assert.strictEqual(
      prepared.nextState.phase._tag,
      "CancellationAccepted"
    )
    assert.strictEqual(
      prepared.nextState.close._tag,
      "CancellationAccepted"
    )
  })

  it("rejects facts bound to another child run or start request", () => {
    const childRelation = relation()
    const state = scheduledState(childRelation)

    failureCode(
      prepare(
        state,
        {
          ...startAcceptedFact(childRelation),
          childRunId: "foreign-child-run"
        },
        timestamp(1)
      ),
      Lifecycle.ErrorCodes.SourceRelationMismatch
    )

    failureCode(
      prepare(
        state,
        {
          _tag: "ChildStartFailed",
          factVersion: Lifecycle.LifecycleFactVersion,
          childRunId: childRelation.childRunId,
          startRequestId: "foreign-start-request",
          decidedAt: timestamp(40),
          failureKind: "Rejected",
          failure: inline({ code: "NotAdmissible" })
        },
        timestamp(1)
      ),
      Lifecycle.ErrorCodes.SourceRelationMismatch
    )
  })

  it("delegates timestamp ordering and legal-transition proof to the reducer", () => {
    const childRelation = relation()
    const state = scheduledState(childRelation, timestamp(5))

    failureCode(
      prepare(
        state,
        startAcceptedFact(childRelation),
        timestamp(4)
      ),
      State.Codes.TimestampRegression
    )

    failureCode(
      prepare(
        state,
        succeededFact(childRelation),
        timestamp(6)
      ),
      State.Codes.IllegalTransition
    )
  })

  it("requires exact reducer and preparation capabilities, not structural copies", () => {
    const childRelation = relation()
    const state = scheduledState(childRelation)
    const request = {
      requestVersion: Lifecycle.PreparationRequestVersion,
      recordedAt: timestamp(1),
      fact: startAcceptedFact(childRelation)
    }

    const copiedState = {
      ...state
    } as State.ChildWorkflowState
    failureCode(
      Lifecycle.prepareLifecycleEvent(copiedState, request),
      Lifecycle.ErrorCodes.InvalidState
    )

    const prepared = success(
      Lifecycle.prepareLifecycleEvent(state, request)
    )
    assert.isTrue(Lifecycle.isPreparedLifecycleEvent(prepared))
    assert.isFalse(
      Lifecycle.isPreparedLifecycleEvent({
        ...prepared
      })
    )
    assert.isFalse(
      Lifecycle.isPreparedLifecycleEvent(
        JSON.parse(JSON.stringify(prepared))
      )
    )
  })

  it("keeps terminal projection identity stable and exposes same-id conflicts", () => {
    const childRelation = relation()
    const running = runningState(childRelation)
    const sourceEventId = "child-terminal-authority-event-7"
    const succeeded = succeededFact(
      childRelation,
      sourceEventId
    )
    const failed = failedFact(
      childRelation,
      sourceEventId
    )

    const firstId = success(
      Lifecycle.projectionEventId(running, succeeded)
    )
    const replayId = success(
      Lifecycle.projectionEventId(running, {
        ...succeeded
      })
    )
    const conflictingId = success(
      Lifecycle.projectionEventId(running, failed)
    )
    const preparedSucceeded = success(
      prepare(running, succeeded, timestamp(2))
    )
    const preparedFailed = success(
      prepare(running, failed, timestamp(2))
    )

    assert.strictEqual(firstId, replayId)
    assert.strictEqual(firstId, conflictingId)
    assert.strictEqual(
      firstId,
      Protocol.childTerminalProjectionEventId(
        childRelation.parent.tenantId,
        childRelation.parent.parentRunId,
        childRelation.parent.callId,
        sourceEventId
      )
    )
    assert.strictEqual(
      preparedSucceeded.event.eventId,
      preparedFailed.event.eventId
    )
    assert.notStrictEqual(
      preparedSucceeded.event.payload._tag,
      preparedFailed.event.payload._tag
    )
  })

  it("retains source ordering evidence separately from parent projection ordering", () => {
    const childRelation = relation()
    const running = runningState(childRelation)
    const sourceSequence = 9_001
    const occurredAt = timestamp(50)
    const fact = succeededFact(
      childRelation,
      "child-terminal-with-source-order",
      sourceSequence,
      occurredAt
    )
    const prepared = success(prepare(running, fact, timestamp(2)))

    fact.sourceSequence = 1
    fact.occurredAt = timestamp(1)

    assert.strictEqual(prepared.fact._tag, "ChildSucceeded")
    if (prepared.fact._tag === "ChildSucceeded") {
      assert.strictEqual(prepared.fact.sourceSequence, sourceSequence)
      assert.strictEqual(prepared.fact.occurredAt, occurredAt)
    }
    assert.strictEqual(prepared.event.sequence, running.sequence + 1)
    assert.strictEqual(prepared.event.recordedAt, timestamp(2))
    assert.isFalse("sourceSequence" in prepared.event.payload)
    assert.isFalse("occurredAt" in prepared.event.payload)
  })
})
