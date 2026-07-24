import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as CallActivity from "../src/BpmnCallActivityV3.ts"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`

const timestamp = (
  second: number
): string => `2026-07-24T09:30:${String(second).padStart(2, "0")}.000Z`

const inline = <A>(value: A) => ({
  _tag: "Inline" as const,
  value
})

const tenantId = "tenant-orders"
const parentRunId = "orders-run-42"
const parentArtifactDigest = digest("a")
const parentWorkflowFamilyIdentity = Child.workflowFamilyIdentity("orders")
const callActivityNodeId = "call-payment"
const ownerTokenId = "token-call-payment-1"

const executionContext = () => ({
  contextVersion: CallActivity.ExecutionContextVersion,
  executionProtocolVersion: Child.ExecutionProtocolVersion,
  tenantId,
  runId: parentRunId,
  rootRunId: parentRunId,
  artifactDigest: parentArtifactDigest,
  workflowFamilyIdentity: parentWorkflowFamilyIdentity,
  ancestry: [{
    lineageEntryVersion: Child.ExecutionProtocolVersion,
    depth: 0,
    tenantId,
    runId: parentRunId,
    artifactDigest: parentArtifactDigest,
    workflowFamilyIdentity: parentWorkflowFamilyIdentity
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
  callActivityNodeId,
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

const backendLocator = () => ({
  locatorVersion: CallActivity.BackendLocatorVersion,
  backendId: "effect-workflow",
  executionId: "effect-workflow/payment/42"
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
  nodeInstanceId = ownerTokenId
): Child.ChildRelation =>
  success(
    CallActivity.deriveRelation(
      executionContext(),
      binding(),
      nodeInstanceId
    )
  )

const scheduled = (
  childRelation: Child.ChildRelation = relation(),
  encodedInput = inline({
    orderId: "order-42",
    amount: 1250
  })
): Protocol.Event =>
  success(
    CallActivity.makeScheduledEvent(
      childRelation,
      encodedInput,
      timestamp(0),
      "call-activity-arrived"
    )
  )

const childEvent = (
  childRelation: Child.ChildRelation,
  eventId: string,
  causationId: string,
  sequence: number,
  payload: Record<string, unknown>,
  recordedAt = timestamp(sequence)
) => ({
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
})

const startAccepted = (
  childRelation: Child.ChildRelation = relation(),
  childRunStartedEventId = "child-run-started",
  sequence = 1
): Protocol.Event =>
  success(Protocol.validateEvent(
    childEvent(
      childRelation,
      Protocol.childStartProjectionEventId(
        childRelation.parent.tenantId,
        childRelation.parent.parentRunId,
        childRelation.parent.callId,
        childRunStartedEventId
      ),
      childRunStartedEventId,
      sequence,
      {
        _tag: "ChildStartAccepted",
        childRunId: childRelation.childRunId,
        startRequestId: childRelation.startRequestId,
        childRunStartedEventId
      }
    )
  ))

const succeeded = (
  childRelation: Child.ChildRelation = relation(),
  childTerminalEventId = "child-run-succeeded"
): Protocol.Event =>
  success(Protocol.validateEvent(
    childEvent(
      childRelation,
      Protocol.childTerminalProjectionEventId(
        childRelation.parent.tenantId,
        childRelation.parent.parentRunId,
        childRelation.parent.callId,
        childTerminalEventId
      ),
      childTerminalEventId,
      2,
      {
        _tag: "ChildSucceeded",
        childRunId: childRelation.childRunId,
        childTerminalEventId,
        outputContractDigest: childRelation.target.outputContractDigest,
        encodedOutput: inline({
          receiptId: "receipt-42",
          status: "captured"
        })
      }
    )
  ))

const frame = (
  childEvents: ReadonlyArray<Protocol.Event> = [scheduled()],
  updatedAt = timestamp(0),
  exitedAt?: string
) => {
  const initial = childEvents[0]!
  if (initial.payload._tag !== "ChildScheduled") {
    throw new Error("Test frame requires a ChildScheduled first fact")
  }
  return {
    frameVersion: CallActivity.CallFrameVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    callFrameId: initial.callId,
    callActivityNodeId: initial.payload.relation.parent.nodeId,
    processId: "orders-process",
    scopeInstanceId: "orders-process-root",
    ownerTokenId: initial.payload.relation.parent.nodeInstanceId,
    childEvents: [...childEvents],
    backendLocator: backendLocator(),
    enteredAt: initial.recordedAt,
    updatedAt,
    ...(exitedAt === undefined ? {} : { exitedAt })
  }
}

describe("BpmnCallActivityV3 execution context and binding", () => {
  it("validates and detaches a root-through-parent execution context", () => {
    const input = executionContext()
    const validated = success(
      CallActivity.validateExecutionContext(input)
    )

    input.ancestry[0]!.runId = "mutated-after-validation"
    input.runId = "mutated-after-validation"

    assert.strictEqual(validated.runId, parentRunId)
    assert.strictEqual(
      validated.ancestry[0]!.runId,
      parentRunId
    )
    assert.notStrictEqual(validated, input)
    assert.notStrictEqual(validated.ancestry, input.ancestry)
  })

  it("rejects malformed, inconsistent, recursive, and excess contexts", () => {
    const wrongRoot = executionContext()
    wrongRoot.rootRunId = "not-the-root"

    const wrongParent = executionContext()
    wrongParent.ancestry[0]!.artifactDigest = digest("9")

    const wrongDepth = executionContext()
    wrongDepth.ancestry[0]!.depth = 1

    const wrongTenant = executionContext()
    wrongTenant.ancestry[0]!.tenantId = "foreign-tenant"

    const repeated = executionContext()
    repeated.ancestry.push({
      ...repeated.ancestry[0]!,
      depth: 1
    })

    const cases: ReadonlyArray<unknown> = [
      wrongRoot,
      wrongParent,
      wrongDepth,
      wrongTenant,
      repeated,
      {
        ...executionContext(),
        ancestry: []
      },
      {
        ...executionContext(),
        unexpected: true
      }
    ]

    for (const invalid of cases) {
      failure(
        CallActivity.validateExecutionContext(invalid),
        CallActivity.ValidationCodes.InvalidExecutionContext
      )
    }
  })

  it("validates and detaches the exact source-to-target binding", () => {
    const input = binding()
    const validated = success(
      CallActivity.validateBinding(input)
    )

    input.calledElement.localName = "mutated"
    input.target.plan.id = "mutated"
    input.encodedInputExpression.source = "mutated"

    assert.deepStrictEqual(validated.calledElement, {
      namespaceUri: "urn:example:payments",
      localName: "payment"
    })
    assert.strictEqual(validated.target.plan.id, "payment-plan")
    assert.strictEqual(
      validated.encodedInputExpression.source,
      "encodePaymentInput"
    )
    assert.notStrictEqual(validated.target, input.target)
  })

  it("enforces the profile, expression, QName, strict shape, and byte bound", () => {
    const invalidProfile = binding()
    invalidProfile.profileId = "PortableChildProcess/2" as typeof invalidProfile.profileId

    const emptyLocalName = binding()
    emptyLocalName.calledElement.localName = ""

    const emptyExpression = binding()
    emptyExpression.encodedInputExpression.source = ""

    const zeroBound = binding()
    zeroBound.maxEncodedInputCanonicalBytes = 0

    const oversizedBound = binding()
    oversizedBound.maxEncodedInputCanonicalBytes = CallActivity.MaximumEncodedInputCanonicalBytes + 1

    const cases: ReadonlyArray<unknown> = [
      invalidProfile,
      emptyLocalName,
      emptyExpression,
      zeroBound,
      oversizedBound,
      {
        ...binding(),
        unexpected: true
      },
      {
        ...binding(),
        target: {
          ...target(),
          executionProtocolVersion: 2
        }
      }
    ]

    for (const invalid of cases) {
      failure(
        CallActivity.validateBinding(invalid),
        CallActivity.ValidationCodes.InvalidBinding
      )
    }
  })

  it("validates backend locators independently from semantic identity", () => {
    const input = backendLocator()
    const validated = success(
      CallActivity.validateBackendLocator(input)
    )
    input.executionId = "mutated"

    assert.deepStrictEqual(validated, backendLocator())

    for (
      const invalid of [
        { ...backendLocator(), backendId: "" },
        { ...backendLocator(), executionId: "" },
        { ...backendLocator(), locatorVersion: 2 },
        { ...backendLocator(), extra: "not-portable" }
      ]
    ) {
      failure(
        CallActivity.validateBackendLocator(invalid),
        CallActivity.ValidationCodes.InvalidBackendLocator
      )
    }
  })
})

describe("BpmnCallActivityV3 relation and schedule fact", () => {
  it("derives the exact deterministic child relation from parent coordinates", () => {
    const derived = relation()
    const expectedCallId = Child.childCallId(
      tenantId,
      parentRunId,
      ownerTokenId
    )

    assert.strictEqual(derived.parent.callId, expectedCallId)
    assert.strictEqual(
      derived.parent.scheduleEventId,
      Child.scheduleChildCommandId(
        tenantId,
        parentRunId,
        expectedCallId
      )
    )
    assert.strictEqual(derived.parent.nodeId, callActivityNodeId)
    assert.strictEqual(
      derived.parent.nodeInstanceId,
      ownerTokenId
    )
    assert.strictEqual(derived.parent.lineageDepth, 1)
    assert.deepStrictEqual(
      derived.parent.ancestry,
      executionContext().ancestry
    )
    assert.deepStrictEqual(derived.target, target())
    assert.strictEqual(
      derived.childRunId,
      Child.childRunId(tenantId, parentRunId, expectedCallId)
    )
    assert.strictEqual(
      derived.startRequestId,
      Child.childStartRequestId(
        tenantId,
        parentRunId,
        expectedCallId
      )
    )
    assert.deepStrictEqual(derived, relation())
    assert.notStrictEqual(
      relation("token-call-payment-2").parent.callId,
      expectedCallId
    )
  })

  it("rejects recursive targets and invalid activation coordinates", () => {
    const recursiveBinding = binding()
    recursiveBinding.target.artifactDigest = parentArtifactDigest

    failure(
      CallActivity.deriveRelation(
        executionContext(),
        recursiveBinding,
        ownerTokenId
      ),
      CallActivity.ValidationCodes.InvalidRelation
    )
    failure(
      CallActivity.deriveRelation(
        executionContext(),
        binding(),
        ""
      ),
      CallActivity.ValidationCodes.InvalidRelation
    )
    failure(
      CallActivity.deriveRelation(
        executionContext(),
        binding(),
        "x".repeat(257)
      ),
      CallActivity.ValidationCodes.InvalidRelation
    )

    const badContext = {
      ...executionContext(),
      rootRunId: "wrong-root"
    }
    failure(
      CallActivity.deriveRelation(
        badContext,
        binding(),
        ownerTokenId
      ),
      CallActivity.ValidationCodes.InvalidExecutionContext
    )
    failure(
      CallActivity.deriveRelation(
        executionContext(),
        { ...binding(), profileId: "unknown" },
        ownerTokenId
      ),
      CallActivity.ValidationCodes.InvalidBinding
    )
  })

  it("does not invoke an accessor supplied as a node instance id", () => {
    let reads = 0
    const hostile = {}
    Object.defineProperty(hostile, "id", {
      enumerable: true,
      get() {
        reads++
        return ownerTokenId
      }
    })

    failure(
      CallActivity.deriveRelation(
        executionContext(),
        binding(),
        hostile
      ),
      CallActivity.ValidationCodes.InvalidRelation
    )
    assert.strictEqual(reads, 0)
  })

  it("creates a detached canonical sequence-zero ChildScheduled fact", () => {
    const childRelation = relation()
    const input = inline({
      orderId: "order-42",
      amount: 1250
    })
    const fact = success(
      CallActivity.makeScheduledEvent(
        childRelation,
        input,
        timestamp(0),
        "call-activity-arrived"
      )
    )
    input.value.orderId = "mutated"

    assert.strictEqual(
      fact.eventId,
      childRelation.scheduleCommandId
    )
    assert.strictEqual(fact.sequence, 0)
    assert.strictEqual(fact.callId, childRelation.parent.callId)
    assert.strictEqual(
      fact.correlationId,
      childRelation.parent.callId
    )
    assert.strictEqual(fact.payload._tag, "ChildScheduled")
    if (fact.payload._tag === "ChildScheduled") {
      assert.deepStrictEqual(fact.payload.relation, childRelation)
      assert.strictEqual(
        fact.payload.inputContractDigest,
        childRelation.target.inputContractDigest
      )
      assert.deepStrictEqual(
        fact.payload.encodedInput,
        inline({
          orderId: "order-42",
          amount: 1250
        })
      )
    }
  })

  it("creates the exact ScheduleChild outbox command", () => {
    const childRelation = relation()
    const input = inline({
      orderId: "order-42",
      amount: 1250
    })
    const command = success(
      CallActivity.makeScheduleCommand(
        childRelation,
        input,
        ownerTokenId
      )
    )
    input.value.orderId = "mutated"

    assert.strictEqual(command.commandVersion, Protocol.CommandVersion)
    assert.strictEqual(
      command.executionProtocolVersion,
      Protocol.ExecutionProtocolVersion
    )
    assert.strictEqual(
      command.commandId,
      childRelation.scheduleCommandId
    )
    assert.strictEqual(command.causationId, ownerTokenId)
    assert.strictEqual(
      command.correlationId,
      childRelation.parent.callId
    )
    assert.deepStrictEqual(command.relation, childRelation)
    assert.deepStrictEqual(command.payload, {
      _tag: "ScheduleChild",
      inputContractDigest: childRelation.target.inputContractDigest,
      encodedInput: inline({
        orderId: "order-42",
        amount: 1250
      })
    })
    assert.isTrue(
      Result.isSuccess(Protocol.validateCommand(command))
    )
  })

  it("rejects malformed ScheduleChild command inputs", () => {
    const childRelation = relation()
    failure(
      CallActivity.makeScheduleCommand(
        {
          ...childRelation,
          childRunId: "wrong-child"
        },
        inline({}),
        ownerTokenId
      ),
      CallActivity.ValidationCodes.InvalidChildCommand
    )
    failure(
      CallActivity.makeScheduleCommand(
        childRelation,
        inline({ forbidden: undefined }),
        ownerTokenId
      ),
      CallActivity.ValidationCodes.InvalidChildCommand
    )
    failure(
      CallActivity.makeScheduleCommand(
        childRelation,
        inline({}),
        ""
      ),
      CallActivity.ValidationCodes.InvalidChildCommand
    )
  })

  it("rejects malformed relations, timestamps, causation, and encoded input", () => {
    const childRelation = relation()
    const wrongRelation = {
      ...childRelation,
      childRunId: "not-the-derived-child-run"
    }

    failure(
      CallActivity.makeScheduledEvent(
        wrongRelation,
        inline({}),
        timestamp(0),
        "call-activity-arrived"
      ),
      CallActivity.ValidationCodes.InvalidScheduledEvent
    )
    failure(
      CallActivity.makeScheduledEvent(
        childRelation,
        inline({}),
        "not-a-timestamp",
        "call-activity-arrived"
      ),
      CallActivity.ValidationCodes.InvalidScheduledEvent
    )
    failure(
      CallActivity.makeScheduledEvent(
        childRelation,
        inline({}),
        timestamp(0),
        ""
      ),
      CallActivity.ValidationCodes.InvalidScheduledEvent
    )
    failure(
      CallActivity.makeScheduledEvent(
        childRelation,
        {
          _tag: "Inline",
          value: {
            forbidden: undefined
          }
        },
        timestamp(0),
        "call-activity-arrived"
      ),
      CallActivity.ValidationCodes.InvalidScheduledEvent
    )
  })

  it("rejects cyclic and accessor-backed input without invoking user code", () => {
    const cyclic: {
      self?: unknown
    } = {}
    cyclic.self = cyclic

    failure(
      CallActivity.makeScheduledEvent(
        relation(),
        inline(cyclic),
        timestamp(0),
        "call-activity-arrived"
      ),
      CallActivity.ValidationCodes.InvalidScheduledEvent
    )

    let reads = 0
    const hostile = {}
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get() {
        reads++
        return "never-read"
      }
    })
    failure(
      CallActivity.makeScheduledEvent(
        relation(),
        inline(hostile),
        timestamp(0),
        "call-activity-arrived"
      ),
      CallActivity.ValidationCodes.InvalidScheduledEvent
    )
    assert.strictEqual(reads, 0)
  })
})

describe("BpmnCallActivityV3 frame projection", () => {
  it("validates and folds the scheduled frame with exact relation evidence", () => {
    const value = frame()
    const validated = success(CallActivity.validateFrame(value))
    const state = success(CallActivity.foldFrame(value))

    value.ownerTokenId = "mutated"
    value.childEvents.splice(0, value.childEvents.length)

    assert.strictEqual(validated.callFrameId, relation().parent.callId)
    assert.strictEqual(validated.childEvents.length, 1)
    assert.strictEqual(state.phase._tag, "Scheduled")
    assert.strictEqual(state.sequence, 0)
    assert.deepStrictEqual(state.relation, relation())
    assert.deepStrictEqual(
      validated.backendLocator,
      backendLocator()
    )
  })

  it("folds a running child while retaining the backend locator as routing metadata", () => {
    const childRelation = relation()
    const history = [
      scheduled(childRelation),
      startAccepted(childRelation)
    ]
    const state = success(
      CallActivity.foldFrame(frame(history, timestamp(1)))
    )

    assert.strictEqual(state.phase._tag, "Running")
    assert.strictEqual(state.sequence, 1)
    assert.strictEqual(state.lastRecordedAt, timestamp(1))
  })

  it("requires terminal exit evidence at the final parent commit", () => {
    const childRelation = relation()
    const history = [
      scheduled(childRelation),
      startAccepted(childRelation),
      succeeded(childRelation)
    ]
    const parentCommit = "2026-07-24T09:31:00.000Z"
    const terminalFrame = frame(
      history,
      parentCommit,
      parentCommit
    )
    const validated = success(
      CallActivity.validateFrame(terminalFrame)
    )
    const state = success(
      CallActivity.foldFrame(terminalFrame)
    )

    assert.strictEqual(validated.updatedAt, parentCommit)
    assert.strictEqual(validated.exitedAt, parentCommit)
    assert.notStrictEqual(
      validated.updatedAt,
      history[2]!.recordedAt
    )
    assert.strictEqual(state.phase._tag, "Succeeded")
    assert.strictEqual(state.outcome._tag, "Succeeded")
  })

  it("rejects coordinate drift and impossible parent timestamps", () => {
    const base = frame()
    const cases: ReadonlyArray<unknown> = [
      { ...base, callFrameId: "foreign-call" },
      { ...base, callActivityNodeId: "foreign-node" },
      { ...base, ownerTokenId: "foreign-token" },
      { ...base, enteredAt: timestamp(1) },
      {
        ...base,
        updatedAt: "2026-07-24T09:29:59.999Z"
      },
      { ...base, exitedAt: timestamp(0) },
      { ...base, unexpected: true }
    ]

    for (const invalid of cases) {
      failure(
        CallActivity.validateFrame(invalid),
        CallActivity.ValidationCodes.InvalidFrame
      )
    }
  })

  it("rejects terminal history without an exit or with a distinct exit commit", () => {
    const childRelation = relation()
    const history = [
      scheduled(childRelation),
      startAccepted(childRelation),
      succeeded(childRelation)
    ]
    const parentCommit = "2026-07-24T09:31:00.000Z"

    failure(
      CallActivity.validateFrame(frame(history, parentCommit)),
      CallActivity.ValidationCodes.InvalidFrame
    )
    failure(
      CallActivity.validateFrame({
        ...frame(history, parentCommit, parentCommit),
        exitedAt: "2026-07-24T09:31:01.000Z"
      }),
      CallActivity.ValidationCodes.InvalidFrame
    )
  })

  it("rejects sequence gaps, duplicate replay facts, and conflicting history", () => {
    const childRelation = relation()
    const accepted = startAccepted(childRelation)
    const skipped = {
      ...accepted,
      sequence: 2
    }
    const duplicate = [
      scheduled(childRelation),
      accepted,
      accepted
    ]
    const eventAfterTerminal = [
      scheduled(childRelation),
      accepted,
      succeeded(childRelation),
      startAccepted(childRelation, "late-child-start", 3)
    ]

    for (
      const history of [
        [scheduled(childRelation), skipped],
        duplicate,
        eventAfterTerminal
      ]
    ) {
      failure(
        CallActivity.validateFrame(
          frame(history as ReadonlyArray<Protocol.Event>, timestamp(2))
        ),
        CallActivity.ValidationCodes.InvalidChildHistory
      )
    }
  })
})

describe("BpmnCallActivityV3 command and canonical replay predicates", () => {
  it("validates and detaches a matching child-event ingress command", () => {
    const event = structuredClone(startAccepted())
    const command = {
      commandVersion: CallActivity.ApplyChildEventCommandVersion,
      executionProtocolVersion: Child.ExecutionProtocolVersion,
      callFrameId: event.callId,
      event,
      backendLocator: backendLocator()
    }
    const validated = success(
      CallActivity.validateApplyChildEventCommand(command)
    )
    ;(command.event as unknown as {
      payload: {
        _tag: string
      }
    }).payload = {
      _tag: "mutated-after-validation"
    }
    command.backendLocator.executionId = "mutated"

    assert.strictEqual(
      validated.event.payload._tag,
      "ChildStartAccepted"
    )
    assert.deepStrictEqual(
      validated.backendLocator,
      backendLocator()
    )
  })

  it("rejects foreign calls, invalid locators, excess fields, and hostile commands", () => {
    const event = startAccepted()
    failure(
      CallActivity.validateApplyChildEventCommand({
        commandVersion: CallActivity.ApplyChildEventCommandVersion,
        executionProtocolVersion: Child.ExecutionProtocolVersion,
        callFrameId: "foreign-call",
        event
      }),
      CallActivity.ValidationCodes.InvalidCommand
    )
    failure(
      CallActivity.validateApplyChildEventCommand({
        commandVersion: CallActivity.ApplyChildEventCommandVersion,
        executionProtocolVersion: Child.ExecutionProtocolVersion,
        callFrameId: event.callId,
        event,
        backendLocator: {
          ...backendLocator(),
          backendId: ""
        }
      }),
      CallActivity.ValidationCodes.InvalidCommand
    )
    failure(
      CallActivity.validateApplyChildEventCommand({
        commandVersion: CallActivity.ApplyChildEventCommandVersion,
        executionProtocolVersion: Child.ExecutionProtocolVersion,
        callFrameId: event.callId,
        event,
        extra: true
      }),
      CallActivity.ValidationCodes.InvalidCommand
    )

    let reads = 0
    const hostile = {}
    Object.defineProperty(hostile, "event", {
      enumerable: true,
      get() {
        reads++
        return event
      }
    })
    failure(
      CallActivity.validateApplyChildEventCommand(hostile),
      CallActivity.ValidationCodes.InvalidCommand
    )
    assert.strictEqual(reads, 0)
  })

  it("compares strict JSON canonically for deterministic replay detection", () => {
    assert.isTrue(CallActivity.canonicalEquals(
      {
        z: [3, 2, 1],
        a: {
          second: true,
          first: "value"
        }
      },
      {
        a: {
          first: "value",
          second: true
        },
        z: [3, 2, 1]
      }
    ))
    assert.isFalse(CallActivity.canonicalEquals(
      { values: [1, 2, 3] },
      { values: [3, 2, 1] }
    ))

    const cyclic: {
      self?: unknown
    } = {}
    cyclic.self = cyclic
    assert.isFalse(CallActivity.canonicalEquals(cyclic, cyclic))

    let reads = 0
    const hostile = {}
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        reads++
        return 1
      }
    })
    assert.isFalse(CallActivity.canonicalEquals(hostile, {}))
    assert.strictEqual(reads, 0)
  })

  it("compares only valid exact bindings and detects semantic changes", () => {
    const left = binding()
    const reordered = {
      maxEncodedInputCanonicalBytes: left.maxEncodedInputCanonicalBytes,
      encodedInputExpression: {
        source: left.encodedInputExpression.source,
        version: left.encodedInputExpression.version,
        language: left.encodedInputExpression.language
      },
      target: left.target,
      calledElement: {
        localName: left.calledElement.localName,
        namespaceUri: left.calledElement.namespaceUri
      },
      callActivityNodeId: left.callActivityNodeId,
      profileId: left.profileId,
      executionProtocolVersion: left.executionProtocolVersion,
      bindingVersion: left.bindingVersion
    }

    assert.isTrue(CallActivity.bindingEquals(left, reordered))
    assert.isFalse(CallActivity.bindingEquals(left, {
      ...reordered,
      callActivityNodeId: "call-refund"
    }))
    assert.isFalse(CallActivity.bindingEquals(left, {
      ...reordered,
      unknown: true
    }))
    assert.isFalse(CallActivity.bindingEquals(left, {
      ...reordered,
      maxEncodedInputCanonicalBytes: 0
    }))
  })
})
