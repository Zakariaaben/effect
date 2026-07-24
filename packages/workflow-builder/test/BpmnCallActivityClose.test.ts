import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as CallActivity from "../src/BpmnCallActivityV3.ts"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`

const timestamp = (
  second: number
): string => `2026-07-24T11:00:${String(second).padStart(2, "0")}.000Z`

const inline = <A>(value: A) => ({
  _tag: "Inline" as const,
  value
})

const tenantId = "tenant-call-close"
const parentRunId = "parent-call-close-17"
const ownerTokenId = "token-call-child-1"
const callActivityNodeId = "call-child"

type CloseAction = Child.ChildCloseAction
type ParentCause = Protocol.ParentCloseCause

const parentFailure = (
  parentCauseEventId = "parent-failure-1"
): ParentCause => ({
  _tag: "ParentFailure",
  parentCauseEventId
})

const parentCancellation = (
  parentCauseEventId = "parent-cancellation-1"
): ParentCause => ({
  _tag: "ParentCancellation",
  parentCauseEventId
})

const target = (
  onParentFailure: CloseAction = "CancelAndWait",
  onParentCancellation: CloseAction = "RequestCancel"
) => ({
  targetVersion: Child.ExecutionProtocolVersion,
  artifactVersion: Child.ExecutionProtocolVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  artifactDigest: digest("b"),
  plan: {
    id: "child-plan",
    revision: 4
  },
  compilerSemanticVersion: "2" as const,
  compiledFingerprint: digest("c"),
  definition: {
    id: "child",
    version: "4.0.0",
    deploymentId: "child-deployment-4",
    buildDigest: digest("4")
  },
  workflowFamilyIdentity: Child.workflowFamilyIdentity("child"),
  inputContractDigest: digest("d"),
  outputContractDigest: digest("e"),
  closePolicy: {
    closePolicyVersion: Child.ExecutionProtocolVersion,
    onParentFailure,
    onParentCancellation
  },
  recursionPolicy: "Forbid" as const,
  maxLineageDepth: Child.MaximumLineageDepth
})

const executionContext = () => {
  const artifactDigest = digest("a")
  const workflowFamilyIdentity = Child.workflowFamilyIdentity("parent")
  return {
    contextVersion: CallActivity.ExecutionContextVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    tenantId,
    runId: parentRunId,
    rootRunId: parentRunId,
    artifactDigest,
    workflowFamilyIdentity,
    ancestry: [{
      lineageEntryVersion: Child.ExecutionProtocolVersion,
      depth: 0,
      tenantId,
      runId: parentRunId,
      artifactDigest,
      workflowFamilyIdentity
    }]
  }
}

const binding = (
  onParentFailure: CloseAction = "CancelAndWait",
  onParentCancellation: CloseAction = "RequestCancel"
) => ({
  bindingVersion: CallActivity.CallActivityBindingVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  profileId: CallActivity.PortableChildProcessProfile,
  callActivityNodeId,
  calledElement: {
    namespaceUri: "urn:example:child",
    localName: "child"
  },
  target: target(onParentFailure, onParentCancellation),
  encodedInputExpression: {
    language: "effect-expression",
    version: "1",
    source: "encodeChildInput"
  },
  maxEncodedInputCanonicalBytes: CallActivity.MaximumEncodedInputCanonicalBytes
})

const success = <A, E>(
  result: Result.Result<A, E>
): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = <A>(
  result: Result.Result<
    A,
    CallActivity.CallActivityValidationError
  >,
  code: CallActivity.ValidationCode
): CallActivity.CallActivityValidationError => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error(`Expected ${code}`)
  }
  assert.strictEqual(result.failure.code, code)
  return result.failure
}

const relation = (
  onParentFailure: CloseAction = "CancelAndWait",
  onParentCancellation: CloseAction = "RequestCancel",
  nodeInstanceId = ownerTokenId
): Child.ChildRelation =>
  success(CallActivity.deriveRelation(
    executionContext(),
    binding(onParentFailure, onParentCancellation),
    nodeInstanceId
  ))

const scheduled = (
  childRelation: Child.ChildRelation
): Protocol.Event =>
  success(CallActivity.makeScheduledEvent(
    childRelation,
    inline({ documentId: "document-17" }),
    timestamp(0),
    "call-activity-entered"
  ))

const event = (
  childRelation: Child.ChildRelation,
  eventId: string,
  causationId: string,
  sequence: number,
  payload: Record<string, unknown>,
  recordedAt = timestamp(sequence)
): Protocol.Event =>
  success(Protocol.validateEvent({
    eventVersion: Protocol.EventVersion,
    executionProtocolVersion: Protocol.ExecutionProtocolVersion,
    eventId,
    tenantId: childRelation.parent.tenantId,
    parentRunId: childRelation.parent.parentRunId,
    callId: childRelation.parent.callId,
    sequence,
    recordedAt,
    causationId,
    correlationId: childRelation.parent.callId,
    payload
  }))

const startAccepted = (
  childRelation: Child.ChildRelation
): Protocol.Event => {
  const childRunStartedEventId = "child-run-started-1"
  return event(
    childRelation,
    Protocol.childStartProjectionEventId(
      childRelation.parent.tenantId,
      childRelation.parent.parentRunId,
      childRelation.parent.callId,
      childRunStartedEventId
    ),
    childRunStartedEventId,
    1,
    {
      _tag: "ChildStartAccepted",
      childRunId: childRelation.childRunId,
      startRequestId: childRelation.startRequestId,
      childRunStartedEventId
    }
  )
}

const closeCommand = (
  childRelation: Child.ChildRelation,
  cause: ParentCause
): CallActivity.ParentCloseCommand =>
  success(CallActivity.makeParentCloseCommand(
    childRelation,
    cause
  ))

const cancelledBeforeStart = (
  childRelation: Child.ChildRelation,
  command: CallActivity.ParentCloseCommand
): Protocol.Event => {
  assert.strictEqual(
    command.payload._tag,
    "RequestChildCancellation"
  )
  if (command.payload._tag !== "RequestChildCancellation") {
    throw new Error("Expected a cancellation command")
  }
  const parentCause = command.payload.parentCause
  const parentCauseEventId = parentCause.parentCauseEventId
  return event(
    childRelation,
    Protocol.childCancelledBeforeStartEventId(
      childRelation.parent.tenantId,
      childRelation.parent.parentRunId,
      childRelation.parent.callId,
      parentCauseEventId
    ),
    command.commandId,
    1,
    {
      _tag: "ChildCancelledBeforeStart",
      childRunId: childRelation.childRunId,
      startRequestId: childRelation.startRequestId,
      parentCause,
      parentCauseEventId,
      closeAction: command.payload.closeAction,
      cancellationCommandId: command.commandId
    }
  )
}

const frame = (
  childRelation: Child.ChildRelation,
  childEvents: ReadonlyArray<Protocol.Event>,
  options: {
    readonly parentCloseCommand?: CallActivity.ParentCloseCommand
    readonly updatedAt?: string
    readonly exitedAt?: string
  } = {}
) => ({
  frameVersion: CallActivity.CallFrameVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  callFrameId: childRelation.parent.callId,
  callActivityNodeId: childRelation.parent.nodeId,
  processId: "parent-process",
  scopeInstanceId: "parent-process-root",
  ownerTokenId: childRelation.parent.nodeInstanceId,
  childEvents: [...childEvents],
  ...(options.parentCloseCommand === undefined
    ? {}
    : { parentCloseCommand: options.parentCloseCommand }),
  enteredAt: childEvents[0]!.recordedAt,
  updatedAt: options.updatedAt ?? childEvents.at(-1)!.recordedAt,
  ...(options.exitedAt === undefined
    ? {}
    : { exitedAt: options.exitedAt })
})

describe("BpmnCallActivityV3 parent-close commands", () => {
  it("strictly validates and detaches only close commands", () => {
    const childRelation = relation()
    const input = structuredClone(
      closeCommand(childRelation, parentFailure())
    )
    const validated = success(
      CallActivity.validateParentCloseCommand(input)
    )
    if (input.payload._tag !== "RequestChildCancellation") {
      throw new Error("Expected a cancellation command")
    }
    input.payload.parentCause.parentCauseEventId = "mutated"

    assert.strictEqual(
      validated.payload.parentCause.parentCauseEventId,
      "parent-failure-1"
    )
    assert.notStrictEqual(validated, input)

    failure(
      CallActivity.validateParentCloseCommand({
        ...validated,
        unexpected: true
      }),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.validateParentCloseCommand({
        ...validated,
        payload: {
          ...validated.payload,
          unexpected: true
        }
      }),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.validateParentCloseCommand(
        success(CallActivity.makeScheduleCommand(
          childRelation,
          inline({ documentId: "document-17" }),
          "call-activity-entered"
        ))
      ),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
  })

  it("selects failure and cancellation policies with canonical identities", () => {
    const cases: ReadonlyArray<{
      readonly cause: ParentCause
      readonly action: CloseAction
    }> = [
      { cause: parentFailure("failure-wait"), action: "CancelAndWait" },
      { cause: parentFailure("failure-request"), action: "RequestCancel" },
      { cause: parentFailure("failure-abandon"), action: "Abandon" },
      {
        cause: parentCancellation("cancel-wait"),
        action: "CancelAndWait"
      },
      {
        cause: parentCancellation("cancel-request"),
        action: "RequestCancel"
      },
      {
        cause: parentCancellation("cancel-abandon"),
        action: "Abandon"
      }
    ]

    for (const { action, cause } of cases) {
      const childRelation = cause._tag === "ParentFailure"
        ? relation(action, "RequestCancel")
        : relation("CancelAndWait", action)
      const command = closeCommand(childRelation, cause)
      const expectedId = action === "Abandon"
        ? Child.abandonChildEventId(
          tenantId,
          parentRunId,
          childRelation.parent.callId,
          cause.parentCauseEventId
        )
        : Child.requestChildCancellationCommandId(
          tenantId,
          parentRunId,
          childRelation.parent.callId,
          cause.parentCauseEventId
        )

      assert.strictEqual(command.commandId, expectedId)
      assert.strictEqual(
        command.causationId,
        cause.parentCauseEventId
      )
      assert.strictEqual(
        command.correlationId,
        childRelation.parent.callId
      )
      assert.deepStrictEqual(command.relation, childRelation)
      assert.strictEqual(
        command.payload._tag,
        action === "Abandon"
          ? "AbandonChild"
          : "RequestChildCancellation"
      )
      assert.deepStrictEqual(command.payload.parentCause, cause)
      assert.strictEqual(command.payload.closeAction, action)
      assert.isTrue(Result.isSuccess(
        Protocol.validateCommand(command)
      ))
    }
  })

  it("rejects non-canonical, cause-divergent, and action-divergent commands", () => {
    const childRelation = relation(
      "CancelAndWait",
      "RequestCancel"
    )
    const command = closeCommand(
      childRelation,
      parentFailure("failure-source")
    )

    failure(
      CallActivity.validateParentCloseCommand({
        ...command,
        commandId: "non-canonical-close-command"
      }),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.validateParentCloseCommand({
        ...command,
        payload: {
          ...command.payload,
          parentCause: parentCancellation("failure-source")
        }
      }),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.validateParentCloseCommand({
        ...command,
        payload: {
          ...command.payload,
          closeAction: "RequestCancel"
        }
      }),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
  })
})

describe("BpmnCallActivityV3 parent-close event projection", () => {
  it("leaves scheduled cancellation to the start authority", () => {
    for (const action of ["CancelAndWait", "RequestCancel"] as const) {
      const childRelation = relation(action, action)
      const schedule = scheduled(childRelation)
      const command = closeCommand(
        childRelation,
        parentFailure(`failure-scheduled-${action}`)
      )
      const projected = success(CallActivity.makeParentCloseEvent(
        frame(childRelation, [schedule]),
        command,
        timestamp(1)
      ))

      assert.isUndefined(projected)
      assert.isTrue(Result.isSuccess(CallActivity.validateFrame(
        frame(childRelation, [schedule], {
          parentCloseCommand: command
        })
      )))
    }
  })

  it("projects exact cancellation requests for a running child", () => {
    for (const action of ["CancelAndWait", "RequestCancel"] as const) {
      const childRelation = relation(action, action)
      const history = [
        scheduled(childRelation),
        startAccepted(childRelation)
      ]
      const cause = parentFailure(`failure-running-${action}`)
      const command = closeCommand(childRelation, cause)
      const projected = success(CallActivity.makeParentCloseEvent(
        frame(childRelation, history),
        command,
        timestamp(2)
      ))

      assert.isDefined(projected)
      if (projected === undefined) {
        throw new Error("Expected a cancellation fact")
      }
      assert.strictEqual(
        projected.payload._tag,
        "ChildCancellationRequested"
      )
      assert.strictEqual(projected.eventId, command.commandId)
      assert.strictEqual(projected.causationId, cause.parentCauseEventId)
      assert.strictEqual(projected.sequence, 2)
      if (projected.payload._tag !== "ChildCancellationRequested") {
        throw new Error("Expected a cancellation fact")
      }
      assert.strictEqual(
        projected.payload.cancellationCommandId,
        command.commandId
      )
      assert.strictEqual(projected.payload.closeAction, action)
      assert.deepStrictEqual(projected.payload.parentCause, cause)

      assert.isTrue(Result.isSuccess(CallActivity.validateFrame(
        frame(childRelation, [...history, projected], {
          parentCloseCommand: command
        })
      )))
    }
  })

  it("abandons scheduled and running children with one terminal fact", () => {
    for (const running of [false, true]) {
      const childRelation = relation("Abandon", "Abandon")
      const history = [
        scheduled(childRelation),
        ...(running ? [startAccepted(childRelation)] : [])
      ]
      const cause = parentCancellation(
        running ? "cancel-running-abandon" : "cancel-scheduled-abandon"
      )
      const command = closeCommand(childRelation, cause)
      const projected = success(CallActivity.makeParentCloseEvent(
        frame(childRelation, history),
        command,
        timestamp(history.length)
      ))

      assert.isDefined(projected)
      if (projected === undefined) {
        throw new Error("Expected an abandon fact")
      }
      assert.strictEqual(projected.payload._tag, "ChildAbandoned")
      assert.strictEqual(projected.eventId, command.commandId)
      assert.strictEqual(projected.sequence, history.length)
      assert.deepStrictEqual(projected.payload, {
        _tag: "ChildAbandoned",
        childRunId: childRelation.childRunId,
        parentCause: cause,
        closeAction: "Abandon"
      })

      const terminalFrame = frame(
        childRelation,
        [...history, projected],
        {
          parentCloseCommand: command,
          updatedAt: projected.recordedAt,
          exitedAt: projected.recordedAt
        }
      )
      const state = success(CallActivity.foldFrame(terminalFrame))
      assert.strictEqual(state.phase._tag, "Abandoned")
      assert.strictEqual(
        success(CallActivity.parentCloseBarrier(terminalFrame)),
        "Discharged"
      )
      failure(
        CallActivity.validateFrame(
          frame(childRelation, [...history, projected], {
            updatedAt: projected.recordedAt,
            exitedAt: projected.recordedAt
          })
        ),
        CallActivity.ValidationCodes.InvalidFrame
      )
      failure(
        CallActivity.validateFrame(
          frame(childRelation, history, {
            parentCloseCommand: command
          })
        ),
        CallActivity.ValidationCodes.InvalidFrame
      )
    }
  })
})

describe("BpmnCallActivityV3 parent-close frame invariants", () => {
  it("requires the exact command alongside its committed close history", () => {
    const childRelation = relation(
      "CancelAndWait",
      "RequestCancel"
    )
    const history = [
      scheduled(childRelation),
      startAccepted(childRelation)
    ]
    const command = closeCommand(
      childRelation,
      parentFailure("failure-frame-coherence")
    )
    const projected = success(CallActivity.makeParentCloseEvent(
      frame(childRelation, history),
      command,
      timestamp(2)
    ))
    if (projected === undefined) {
      throw new Error("Expected a cancellation fact")
    }

    assert.isTrue(Result.isSuccess(CallActivity.validateFrame(
      frame(childRelation, [...history, projected], {
        parentCloseCommand: command
      })
    )))
    failure(
      CallActivity.validateFrame(
        frame(childRelation, [...history, projected])
      ),
      CallActivity.ValidationCodes.InvalidFrame
    )
    failure(
      CallActivity.validateFrame(
        frame(childRelation, history, {
          parentCloseCommand: command
        })
      ),
      CallActivity.ValidationCodes.InvalidFrame
    )

    const foreignRelation = relation(
      "CancelAndWait",
      "RequestCancel",
      "token-call-child-foreign"
    )
    failure(
      CallActivity.validateFrame(
        frame(childRelation, [...history, projected], {
          parentCloseCommand: closeCommand(
            foreignRelation,
            parentFailure("failure-frame-coherence")
          )
        })
      ),
      CallActivity.ValidationCodes.InvalidFrame
    )
  })

  it("rejects close histories whose cause or action diverges from the command", () => {
    const sameActionRelation = relation(
      "CancelAndWait",
      "CancelAndWait"
    )
    const sameActionHistory = [
      scheduled(sameActionRelation),
      startAccepted(sameActionRelation)
    ]
    const failureCommand = closeCommand(
      sameActionRelation,
      parentFailure("failure-cause")
    )
    const cancellationCommand = closeCommand(
      sameActionRelation,
      parentCancellation("cancellation-cause")
    )
    const cancellationFact = success(
      CallActivity.makeParentCloseEvent(
        frame(sameActionRelation, sameActionHistory),
        cancellationCommand,
        timestamp(2)
      )
    )
    if (cancellationFact === undefined) {
      throw new Error("Expected a cancellation fact")
    }
    failure(
      CallActivity.validateFrame(
        frame(
          sameActionRelation,
          [...sameActionHistory, cancellationFact],
          { parentCloseCommand: failureCommand }
        )
      ),
      CallActivity.ValidationCodes.InvalidFrame
    )

    const distinctActionRelation = relation(
      "CancelAndWait",
      "RequestCancel"
    )
    const distinctActionHistory = [
      scheduled(distinctActionRelation),
      startAccepted(distinctActionRelation)
    ]
    const waitCommand = closeCommand(
      distinctActionRelation,
      parentFailure("failure-action")
    )
    const requestCommand = closeCommand(
      distinctActionRelation,
      parentCancellation("cancellation-action")
    )
    const requestFact = success(CallActivity.makeParentCloseEvent(
      frame(distinctActionRelation, distinctActionHistory),
      requestCommand,
      timestamp(2)
    ))
    if (requestFact === undefined) {
      throw new Error("Expected a cancellation fact")
    }
    failure(
      CallActivity.validateFrame(
        frame(
          distinctActionRelation,
          [...distinctActionHistory, requestFact],
          { parentCloseCommand: waitCommand }
        )
      ),
      CallActivity.ValidationCodes.InvalidFrame
    )
  })

  it("distinguishes request-only and wait-for-terminal barriers", () => {
    const cases = [
      {
        action: "RequestCancel" as const,
        expected: "Discharged" as const
      },
      {
        action: "CancelAndWait" as const,
        expected: "WaitingForChildTerminal" as const
      }
    ]
    for (const { action, expected } of cases) {
      const childRelation = relation(action, action)
      const schedule = scheduled(childRelation)
      const command = closeCommand(
        childRelation,
        parentFailure(`failure-barrier-${action}`)
      )
      assert.strictEqual(
        success(CallActivity.parentCloseBarrier(
          frame(childRelation, [schedule], {
            parentCloseCommand: command
          })
        )),
        expected
      )

      const running = [schedule, startAccepted(childRelation)]
      const projected = success(CallActivity.makeParentCloseEvent(
        frame(childRelation, running),
        command,
        timestamp(2)
      ))
      if (projected === undefined) {
        throw new Error("Expected a cancellation fact")
      }
      assert.strictEqual(
        success(CallActivity.parentCloseBarrier(
          frame(childRelation, [...running, projected], {
            parentCloseCommand: command
          })
        )),
        expected
      )
    }
  })

  it("discharges both cancellation policies after an authoritative terminal fact", () => {
    for (const action of ["CancelAndWait", "RequestCancel"] as const) {
      const childRelation = relation(action, action)
      const schedule = scheduled(childRelation)
      const command = closeCommand(
        childRelation,
        parentFailure(`failure-terminal-${action}`)
      )
      const terminal = cancelledBeforeStart(childRelation, command)
      const terminalFrame = frame(
        childRelation,
        [schedule, terminal],
        {
          parentCloseCommand: command,
          updatedAt: terminal.recordedAt,
          exitedAt: terminal.recordedAt
        }
      )

      assert.strictEqual(
        success(CallActivity.parentCloseBarrier(terminalFrame)),
        "Discharged"
      )
      assert.isUndefined(success(CallActivity.makeParentCloseEvent(
        terminalFrame,
        command,
        timestamp(2)
      )))
    }
  })
})

describe("BpmnCallActivityV3 parent-close hostile JSON", () => {
  it("rejects cyclic and accessor-backed values without invoking user code", () => {
    const childRelation = relation()
    const command = closeCommand(childRelation, parentFailure())
    const cyclic: {
      self?: unknown
    } = {}
    cyclic.self = cyclic

    failure(
      CallActivity.validateParentCloseCommand(cyclic),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.makeParentCloseCommand(childRelation, cyclic),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.makeParentCloseEvent(cyclic, command, timestamp(1)),
      CallActivity.ValidationCodes.InvalidFrame
    )

    let reads = 0
    const hostileCause = {}
    Object.defineProperty(hostileCause, "parentCauseEventId", {
      enumerable: true,
      get() {
        reads++
        return "must-not-run"
      }
    })
    failure(
      CallActivity.makeParentCloseCommand(
        childRelation,
        hostileCause
      ),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )

    const hostileCommand = {}
    Object.defineProperty(hostileCommand, "payload", {
      enumerable: true,
      get() {
        reads++
        return command.payload
      }
    })
    failure(
      CallActivity.validateParentCloseCommand(hostileCommand),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    failure(
      CallActivity.makeParentCloseEvent(
        frame(childRelation, [scheduled(childRelation)]),
        hostileCommand,
        timestamp(1)
      ),
      CallActivity.ValidationCodes.InvalidCloseCommand
    )
    assert.strictEqual(reads, 0)
  })
})
