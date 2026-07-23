import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`
const inline = <A>(value: A) => ({
  _tag: "Inline" as const,
  value
})

const tenantId = "tenant-a"
const parentRunId = "parent-run-a"
const nodeId = "payment"
const nodeInstanceId = "payment#1"
const callId = Protocol.childCallId(
  tenantId,
  parentRunId,
  nodeInstanceId
)
const reservedChildRunId = Protocol.childRunId(
  tenantId,
  parentRunId,
  callId
)
const startRequestId = Protocol.childStartRequestId(
  tenantId,
  parentRunId,
  callId
)
const scheduleId = Protocol.scheduleChildCommandId(
  tenantId,
  parentRunId,
  callId
)
const inputContractDigest = digest("d")
const outputContractDigest = digest("e")
const recordedAt = "2026-07-23T12:00:00.000Z"

const relation = () => ({
  relationVersion: 3 as const,
  parent: {
    parentLinkVersion: 3 as const,
    tenantId,
    parentRunId,
    parentArtifactDigest: digest("a"),
    parentWorkflowFamilyIdentity: Child.workflowFamilyIdentity("orders"),
    callId,
    nodeId,
    nodeInstanceId,
    scheduleEventId: scheduleId,
    rootRunId: parentRunId,
    lineageDepth: 1,
    ancestry: [{
      lineageEntryVersion: 3 as const,
      depth: 0,
      tenantId,
      runId: parentRunId,
      artifactDigest: digest("a"),
      workflowFamilyIdentity: Child.workflowFamilyIdentity("orders")
    }]
  },
  target: {
    targetVersion: 3 as const,
    artifactVersion: 3 as const,
    executionProtocolVersion: 3 as const,
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
    inputContractDigest,
    outputContractDigest,
    closePolicy: {
      closePolicyVersion: 3 as const,
      onParentFailure: "CancelAndWait" as const,
      onParentCancellation: "Abandon" as const
    },
    recursionPolicy: "Forbid" as const,
    maxLineageDepth: Child.MaximumLineageDepth
  },
  childRunId: reservedChildRunId,
  startRequestId,
  scheduleCommandId: scheduleId
})

const scheduleCommand = () => ({
  commandVersion: 3 as const,
  executionProtocolVersion: 3 as const,
  tenantId,
  parentRunId,
  callId,
  commandId: scheduleId,
  causationId: "parent-node-ready",
  correlationId: callId,
  relation: relation(),
  payload: {
    _tag: "ScheduleChild" as const,
    inputContractDigest,
    encodedInput: inline({
      invoiceId: "invoice-1",
      amount: 42
    })
  }
})

const cancellationCommand = () => {
  const parentCauseEventId = "parent-failed"
  return {
    commandVersion: 3 as const,
    executionProtocolVersion: 3 as const,
    tenantId,
    parentRunId,
    callId,
    commandId: Protocol.requestChildCancellationCommandId(
      tenantId,
      parentRunId,
      callId,
      parentCauseEventId
    ),
    causationId: parentCauseEventId,
    correlationId: callId,
    relation: relation(),
    payload: {
      _tag: "RequestChildCancellation" as const,
      parentCause: {
        _tag: "ParentFailure" as const,
        parentCauseEventId
      },
      closeAction: "CancelAndWait" as const
    }
  }
}

const abandonCommand = () => {
  const parentCauseEventId = "parent-cancellation-requested"
  return {
    commandVersion: 3 as const,
    executionProtocolVersion: 3 as const,
    tenantId,
    parentRunId,
    callId,
    commandId: Protocol.abandonChildEventId(
      tenantId,
      parentRunId,
      callId,
      parentCauseEventId
    ),
    causationId: parentCauseEventId,
    correlationId: callId,
    relation: relation(),
    payload: {
      _tag: "AbandonChild" as const,
      parentCause: {
        _tag: "ParentCancellation" as const,
        parentCauseEventId
      },
      closeAction: "Abandon" as const
    }
  }
}

const event = (
  eventId: string,
  causationId: string,
  payload: Record<string, unknown>,
  sequence = 1
) => ({
  eventVersion: 3 as const,
  executionProtocolVersion: 3 as const,
  eventId,
  tenantId,
  parentRunId,
  callId,
  sequence,
  recordedAt,
  causationId,
  correlationId: callId,
  payload
})

const scheduledEvent = () =>
  event(scheduleId, "parent-node-ready", {
    _tag: "ChildScheduled",
    relation: relation(),
    inputContractDigest,
    encodedInput: inline({
      invoiceId: "invoice-1",
      amount: 42
    })
  })

const startAcceptedEvent = () => {
  const childRunStartedEventId = "child-run-started"
  return event(
    Protocol.childStartProjectionEventId(
      tenantId,
      parentRunId,
      callId,
      childRunStartedEventId
    ),
    childRunStartedEventId,
    {
      _tag: "ChildStartAccepted",
      childRunId: reservedChildRunId,
      startRequestId,
      childRunStartedEventId
    },
    2
  )
}

const startFailedEvent = () =>
  event(
    Protocol.childStartFailedEventId(
      tenantId,
      parentRunId,
      callId,
      startRequestId
    ),
    startRequestId,
    {
      _tag: "ChildStartFailed",
      childRunId: reservedChildRunId,
      startRequestId,
      failureKind: "RetriesExhausted",
      failure: inline({
        code: "DEPLOYMENT_UNAVAILABLE",
        attempts: 5
      })
    },
    2
  )

const cancellationRequestedEvent = () => {
  const parentCauseEventId = "parent-failed"
  const cancellationCommandId = Protocol.requestChildCancellationCommandId(
    tenantId,
    parentRunId,
    callId,
    parentCauseEventId
  )
  return event(
    cancellationCommandId,
    parentCauseEventId,
    {
      _tag: "ChildCancellationRequested",
      childRunId: reservedChildRunId,
      parentCause: {
        _tag: "ParentFailure",
        parentCauseEventId
      },
      closeAction: "CancelAndWait",
      cancellationCommandId
    },
    3
  )
}

const cancellationAcceptedEvent = () => {
  const parentCauseEventId = "parent-failed"
  const childCancellationEventId = "child-cancellation-accepted"
  return event(
    Protocol.childCancellationAcceptedEventId(
      tenantId,
      parentRunId,
      callId,
      childCancellationEventId
    ),
    childCancellationEventId,
    {
      _tag: "ChildCancellationAccepted",
      childRunId: reservedChildRunId,
      parentCauseEventId,
      cancellationCommandId: Protocol.requestChildCancellationCommandId(
        tenantId,
        parentRunId,
        callId,
        parentCauseEventId
      ),
      childCancellationEventId
    },
    4
  )
}

const cancelledBeforeStartEvent = () => {
  const parentCauseEventId = "parent-failed"
  const cancellationCommandId = Protocol.requestChildCancellationCommandId(
    tenantId,
    parentRunId,
    callId,
    parentCauseEventId
  )
  return event(
    Protocol.childCancelledBeforeStartEventId(
      tenantId,
      parentRunId,
      callId,
      parentCauseEventId
    ),
    cancellationCommandId,
    {
      _tag: "ChildCancelledBeforeStart",
      childRunId: reservedChildRunId,
      startRequestId,
      parentCause: {
        _tag: "ParentFailure",
        parentCauseEventId
      },
      parentCauseEventId,
      closeAction: "CancelAndWait",
      cancellationCommandId
    },
    2
  )
}

const terminalEvent = (
  tag: "ChildSucceeded" | "ChildFailed" | "ChildCancelled"
) => {
  const childTerminalEventId = `child-terminal-${tag}`
  const common = {
    _tag: tag,
    childRunId: reservedChildRunId,
    childTerminalEventId
  }
  const payload = tag === "ChildSucceeded"
    ? {
      ...common,
      outputContractDigest,
      encodedOutput: inline({ receiptId: "receipt-1" })
    }
    : tag === "ChildFailed"
    ? {
      ...common,
      failure: inline({ code: "PAYMENT_DECLINED" })
    }
    : {
      ...common,
      cancellation: inline({ requestedBy: "parent" })
    }
  return event(
    Protocol.childTerminalProjectionEventId(
      tenantId,
      parentRunId,
      callId,
      childTerminalEventId
    ),
    childTerminalEventId,
    payload,
    3
  )
}

const abandonedEvent = () => {
  const parentCauseEventId = "parent-cancellation-requested"
  return event(
    Protocol.abandonChildEventId(
      tenantId,
      parentRunId,
      callId,
      parentCauseEventId
    ),
    parentCauseEventId,
    {
      _tag: "ChildAbandoned",
      childRunId: reservedChildRunId,
      parentCause: {
        _tag: "ParentCancellation",
        parentCauseEventId
      },
      closeAction: "Abandon"
    },
    3
  )
}

const strictDecode = <A>(
  schema: Schema.ConstraintDecoder<A>,
  input: unknown
): Result.Result<A, Schema.SchemaError> =>
  Schema.decodeUnknownResult(schema, {
    errors: "all",
    onExcessProperty: "error"
  })(input)

const expectCommand = (
  input: unknown
): Protocol.Command => {
  const result = Protocol.validateCommand(input)
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const expectEvent = (
  input: unknown
): Protocol.Event => {
  const result = Protocol.validateEvent(input)
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

describe("ChildWorkflowProtocolV3", () => {
  it("admits exact schedule, cancellation, and abandon commands", () => {
    const commands = [
      scheduleCommand(),
      cancellationCommand(),
      abandonCommand()
    ]

    for (const command of commands) {
      const validated = expectCommand(command)
      assert.strictEqual(validated.commandVersion, 3)
      assert.strictEqual(validated.executionProtocolVersion, 3)
      assert.strictEqual(validated.correlationId, callId)
      assert.isTrue(Result.isSuccess(
        strictDecode(Protocol.Command, command)
      ))
    }
  })

  it("admits the complete immutable child event vocabulary", () => {
    const events = [
      scheduledEvent(),
      startAcceptedEvent(),
      startFailedEvent(),
      cancellationRequestedEvent(),
      cancellationAcceptedEvent(),
      cancelledBeforeStartEvent(),
      terminalEvent("ChildSucceeded"),
      terminalEvent("ChildFailed"),
      terminalEvent("ChildCancelled"),
      abandonedEvent()
    ]

    assert.deepStrictEqual(
      events.map((candidate) => expectEvent(candidate).payload._tag),
      [
        "ChildScheduled",
        "ChildStartAccepted",
        "ChildStartFailed",
        "ChildCancellationRequested",
        "ChildCancellationAccepted",
        "ChildCancelledBeforeStart",
        "ChildSucceeded",
        "ChildFailed",
        "ChildCancelled",
        "ChildAbandoned"
      ]
    )
  })

  it("binds command coordinates, identities, digests, causation, and close policy", () => {
    const invalid = [
      {
        ...scheduleCommand(),
        commandId: "forged"
      },
      {
        ...scheduleCommand(),
        tenantId: "tenant-b"
      },
      {
        ...scheduleCommand(),
        correlationId: "another-call"
      },
      {
        ...scheduleCommand(),
        payload: {
          ...scheduleCommand().payload,
          inputContractDigest: digest("f")
        }
      },
      {
        ...cancellationCommand(),
        causationId: "another-cause"
      },
      {
        ...cancellationCommand(),
        payload: {
          ...cancellationCommand().payload,
          closeAction: "RequestCancel"
        }
      },
      {
        ...abandonCommand(),
        payload: {
          ...abandonCommand().payload,
          parentCause: {
            _tag: "ParentFailure",
            parentCauseEventId: "parent-cancellation-requested"
          }
        }
      }
    ]

    for (const candidate of invalid) {
      const decoded = Protocol.validateCommand(candidate)
      assert.isTrue(Result.isFailure(decoded))
      if (Result.isSuccess(decoded)) {
        throw new Error("expected invalid command")
      }
      assert.strictEqual(
        decoded.failure.code,
        Protocol.ValidationCodes.InvalidCommand
      )
    }
  })

  it("binds every projected event to exact source and relation coordinates", () => {
    const accepted = startAcceptedEvent()
    const beforeStart = cancelledBeforeStartEvent()
    const scheduled = scheduledEvent()
    const terminal = terminalEvent("ChildSucceeded")
    const requested = cancellationRequestedEvent()
    const invalid = [
      {
        ...accepted,
        eventId: "forged"
      },
      {
        ...accepted,
        causationId: "another-child-start"
      },
      {
        ...accepted,
        payload: {
          ...accepted.payload,
          childRunId: "another-child"
        }
      },
      {
        ...accepted,
        payload: {
          ...accepted.payload,
          startRequestId: "another-request"
        }
      },
      {
        ...scheduled,
        parentRunId: "another-parent"
      },
      {
        ...scheduled,
        payload: {
          ...scheduled.payload,
          inputContractDigest: digest("f")
        }
      },
      {
        ...terminal,
        causationId: "another-terminal"
      },
      {
        ...requested,
        payload: {
          ...requested.payload,
          cancellationCommandId: "forged"
        }
      },
      {
        ...beforeStart,
        payload: {
          ...beforeStart.payload,
          parentCauseEventId: "another-parent-cause"
        }
      },
      {
        ...beforeStart,
        causationId: "another-command"
      }
    ]

    for (const candidate of invalid) {
      const decoded = Protocol.validateEvent(candidate)
      assert.isTrue(Result.isFailure(decoded))
      if (Result.isSuccess(decoded)) {
        throw new Error("expected invalid event")
      }
      assert.strictEqual(
        decoded.failure.code,
        Protocol.ValidationCodes.InvalidEvent
      )
    }
  })

  it("rejects future versions, excess properties, and non-JSON payloads", () => {
    const invalidCommands: ReadonlyArray<unknown> = [
      {
        ...scheduleCommand(),
        commandVersion: 4
      },
      {
        ...scheduleCommand(),
        executionProtocolVersion: 2
      },
      {
        ...scheduleCommand(),
        unexpected: true
      },
      {
        ...scheduleCommand(),
        payload: {
          ...scheduleCommand().payload,
          unexpected: true
        }
      },
      {
        ...scheduleCommand(),
        payload: {
          ...scheduleCommand().payload,
          encodedInput: undefined
        }
      }
    ]
    for (const candidate of invalidCommands) {
      assert.isTrue(Result.isFailure(
        Protocol.validateCommand(candidate)
      ))
    }

    const validEvent = startAcceptedEvent()
    const invalidEvents: ReadonlyArray<unknown> = [
      {
        ...validEvent,
        eventVersion: 4
      },
      {
        ...validEvent,
        sequence: -1
      },
      {
        ...validEvent,
        recordedAt: "2026-07-23T12:00:00Z"
      },
      {
        ...validEvent,
        unexpected: true
      },
      {
        ...validEvent,
        payload: {
          ...validEvent.payload,
          unexpected: true
        }
      }
    ]
    for (const candidate of invalidEvents) {
      assert.isTrue(Result.isFailure(
        Protocol.validateEvent(candidate)
      ))
    }
  })

  it("rejects accessors without invoking them", () => {
    let commandAccesses = 0
    const hostileCommand = { ...scheduleCommand() } as Record<string, unknown>
    Object.defineProperty(hostileCommand, "tenantId", {
      enumerable: true,
      get() {
        commandAccesses++
        return tenantId
      }
    })

    const commandResult = Protocol.validateCommand(hostileCommand)
    assert.isTrue(Result.isFailure(commandResult))
    assert.strictEqual(commandAccesses, 0)
    if (Result.isSuccess(commandResult)) {
      throw new Error("expected hostile command rejection")
    }
    assert.instanceOf(
      commandResult.failure,
      Protocol.ChildWorkflowProtocolValidationError
    )

    let eventAccesses = 0
    const hostileEvent = { ...scheduledEvent() } as Record<string, unknown>
    Object.defineProperty(hostileEvent, "payload", {
      enumerable: true,
      get() {
        eventAccesses++
        return scheduledEvent().payload
      }
    })

    const eventResult = Protocol.validateEvent(hostileEvent)
    assert.isTrue(Result.isFailure(eventResult))
    assert.strictEqual(eventAccesses, 0)
    if (Result.isSuccess(eventResult)) {
      throw new Error("expected hostile event rejection")
    }
    assert.instanceOf(
      eventResult.failure,
      Protocol.ChildWorkflowProtocolValidationError
    )
  })

  it("returns detached recursively frozen snapshots", () => {
    const original = scheduleCommand()
    const validated = expectCommand(original)
    const encodedInput = validated.payload._tag === "ScheduleChild"
      ? validated.payload.encodedInput
      : undefined
    assert.isDefined(encodedInput)
    assert.isTrue(Object.isFrozen(validated))
    assert.isTrue(Object.isFrozen(validated.relation))
    assert.isTrue(Object.isFrozen(validated.payload))
    assert.isTrue(Object.isFrozen(encodedInput))

    original.payload.encodedInput.value.amount = 100
    assert.deepStrictEqual(encodedInput, {
      _tag: "Inline",
      value: {
        invoiceId: "invoice-1",
        amount: 42
      }
    })
  })

  it("retains collision-free canonical identity aliases", () => {
    assert.strictEqual(
      Protocol.childCallId(tenantId, parentRunId, nodeInstanceId),
      Child.childCallId(tenantId, parentRunId, nodeInstanceId)
    )
    assert.notStrictEqual(
      Protocol.childCallId("a", "b,c", "d"),
      Protocol.childCallId("a,b", "c", "d")
    )
    assert.notStrictEqual(
      Protocol.childTerminalProjectionEventId(
        tenantId,
        parentRunId,
        callId,
        "terminal-a"
      ),
      Protocol.childTerminalProjectionEventId(
        tenantId,
        parentRunId,
        callId,
        "terminal-b"
      )
    )
  })
})
