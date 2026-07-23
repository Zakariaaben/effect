import { assert, describe, it } from "@effect/vitest"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Protocol from "../src/ChildWorkflowProtocolV3.ts"
import * as State from "../src/ChildWorkflowStateV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`

const inline = <A>(value: A) => ({
  _tag: "Inline" as const,
  value
})

const blob = (digit: string, encodedBytes = 128) => ({
  _tag: "Blob" as const,
  ref: {
    blobVersion: 1 as const,
    digest: digest(digit),
    encodedBytes,
    mediaType: "application/json"
  }
})

const tenantId = "tenant-a"
const parentRunId = "parent-run-a"
const nodeId = "charge-card"
const nodeInstanceId = "charge-card#1"
const callId = Protocol.childCallId(
  tenantId,
  parentRunId,
  nodeInstanceId
)
const inputContractDigest = digest("d")
const outputContractDigest = digest("e")

interface Coordinates {
  readonly tenantId: string
  readonly parentRunId: string
  readonly callId: string
}

const baseCoordinates: Coordinates = {
  tenantId,
  parentRunId,
  callId
}

const coordinates = (
  overrides: Partial<Coordinates> = {}
): Coordinates => ({
  ...baseCoordinates,
  ...overrides
})

type ClosePolicy = {
  readonly closePolicyVersion: 3
  readonly onParentFailure: Child.ChildCloseAction
  readonly onParentCancellation: Child.ChildCloseAction
}

const policy = (
  onParentFailure: Child.ChildCloseAction = "CancelAndWait",
  onParentCancellation: Child.ChildCloseAction = "RequestCancel"
): ClosePolicy => ({
  closePolicyVersion: 3,
  onParentFailure,
  onParentCancellation
})

const relation = (
  closePolicy: ClosePolicy = policy()
) => {
  const scheduleCommandId = Protocol.scheduleChildCommandId(
    tenantId,
    parentRunId,
    callId
  )
  return {
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
      scheduleEventId: scheduleCommandId,
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
      closePolicy,
      recursionPolicy: "Forbid" as const,
      maxLineageDepth: Child.MaximumLineageDepth
    },
    childRunId: Protocol.childRunId(tenantId, parentRunId, callId),
    startRequestId: Protocol.childStartRequestId(
      tenantId,
      parentRunId,
      callId
    ),
    scheduleCommandId
  }
}

const timestamp = (second: number): string => `2026-07-23T12:00:${String(second).padStart(2, "0")}.000Z`

const event = (
  at: Coordinates,
  eventId: string,
  causationId: string,
  sequence: number,
  payload: Record<string, unknown>,
  recordedAt = timestamp(sequence)
) => ({
  eventVersion: 3 as const,
  executionProtocolVersion: 3 as const,
  eventId,
  tenantId: at.tenantId,
  parentRunId: at.parentRunId,
  callId: at.callId,
  sequence,
  recordedAt,
  causationId,
  correlationId: at.callId,
  payload
})

const scheduled = (
  childRelation = relation(),
  encodedInput: ReturnType<typeof inline> | ReturnType<typeof blob> = inline({
    orderId: "order-1",
    amount: 42
  }),
  sequence = 0,
  recordedAt = timestamp(sequence)
) => {
  const at = coordinates()
  const eventId = Protocol.scheduleChildCommandId(
    at.tenantId,
    at.parentRunId,
    at.callId
  )
  return event(
    at,
    eventId,
    "parent-node-ready",
    sequence,
    {
      _tag: "ChildScheduled",
      relation: childRelation,
      inputContractDigest,
      encodedInput
    },
    recordedAt
  )
}

const startAccepted = (
  at = coordinates(),
  sequence = 1,
  recordedAt = timestamp(sequence),
  childRunStartedEventId = "child-run-started"
) =>
  event(
    at,
    Protocol.childStartProjectionEventId(
      at.tenantId,
      at.parentRunId,
      at.callId,
      childRunStartedEventId
    ),
    childRunStartedEventId,
    sequence,
    {
      _tag: "ChildStartAccepted",
      childRunId: Protocol.childRunId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      startRequestId: Protocol.childStartRequestId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      childRunStartedEventId
    },
    recordedAt
  )

const startFailed = (
  at = coordinates(),
  sequence = 1,
  recordedAt = timestamp(sequence)
) => {
  const startRequestId = Protocol.childStartRequestId(
    at.tenantId,
    at.parentRunId,
    at.callId
  )
  return event(
    at,
    Protocol.childStartFailedEventId(
      at.tenantId,
      at.parentRunId,
      at.callId,
      startRequestId
    ),
    startRequestId,
    sequence,
    {
      _tag: "ChildStartFailed",
      childRunId: Protocol.childRunId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      startRequestId,
      failureKind: "RetriesExhausted",
      failure: blob("f", 4096)
    },
    recordedAt
  )
}

const parentFailure = (parentCauseEventId = "parent-failed") => ({
  _tag: "ParentFailure" as const,
  parentCauseEventId
})

const parentCancellation = (
  parentCauseEventId = "parent-cancelled"
) => ({
  _tag: "ParentCancellation" as const,
  parentCauseEventId
})

type ParentCause =
  | ReturnType<typeof parentFailure>
  | ReturnType<typeof parentCancellation>

const cancellationRequested = (
  parentCause: ParentCause = parentFailure(),
  closeAction: "CancelAndWait" | "RequestCancel" = "CancelAndWait",
  at = coordinates(),
  sequence = 2,
  recordedAt = timestamp(sequence)
) => {
  const cancellationCommandId = Protocol.requestChildCancellationCommandId(
    at.tenantId,
    at.parentRunId,
    at.callId,
    parentCause.parentCauseEventId
  )
  return event(
    at,
    cancellationCommandId,
    parentCause.parentCauseEventId,
    sequence,
    {
      _tag: "ChildCancellationRequested",
      childRunId: Protocol.childRunId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      parentCause,
      closeAction,
      cancellationCommandId
    },
    recordedAt
  )
}

const cancellationAccepted = (
  parentCauseEventId = "parent-failed",
  at = coordinates(),
  sequence = 3,
  recordedAt = timestamp(sequence),
  childCancellationEventId = "child-cancellation-accepted"
) =>
  event(
    at,
    Protocol.childCancellationAcceptedEventId(
      at.tenantId,
      at.parentRunId,
      at.callId,
      childCancellationEventId
    ),
    childCancellationEventId,
    sequence,
    {
      _tag: "ChildCancellationAccepted",
      childRunId: Protocol.childRunId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      parentCauseEventId,
      cancellationCommandId: Protocol.requestChildCancellationCommandId(
        at.tenantId,
        at.parentRunId,
        at.callId,
        parentCauseEventId
      ),
      childCancellationEventId
    },
    recordedAt
  )

const cancelledBeforeStart = (
  parentCause: ParentCause = parentFailure(),
  closeAction: "CancelAndWait" | "RequestCancel" = "CancelAndWait",
  at = coordinates(),
  sequence = 1,
  recordedAt = timestamp(sequence)
) => {
  const parentCauseEventId = parentCause.parentCauseEventId
  const cancellationCommandId = Protocol.requestChildCancellationCommandId(
    at.tenantId,
    at.parentRunId,
    at.callId,
    parentCauseEventId
  )
  return event(
    at,
    Protocol.childCancelledBeforeStartEventId(
      at.tenantId,
      at.parentRunId,
      at.callId,
      parentCauseEventId
    ),
    cancellationCommandId,
    sequence,
    {
      _tag: "ChildCancelledBeforeStart",
      childRunId: Protocol.childRunId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      startRequestId: Protocol.childStartRequestId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      parentCause,
      parentCauseEventId,
      closeAction,
      cancellationCommandId
    },
    recordedAt
  )
}

type TerminalTag = "ChildSucceeded" | "ChildFailed" | "ChildCancelled"

const terminal = (
  tag: TerminalTag,
  at = coordinates(),
  sequence = 2,
  recordedAt = timestamp(sequence),
  childTerminalEventId = `child-terminal-${tag}`,
  successDigest = outputContractDigest
) => {
  const common = {
    _tag: tag,
    childRunId: Protocol.childRunId(
      at.tenantId,
      at.parentRunId,
      at.callId
    ),
    childTerminalEventId
  }
  const payload = tag === "ChildSucceeded"
    ? {
      ...common,
      outputContractDigest: successDigest,
      encodedOutput: inline({
        receiptId: "receipt-1",
        status: "captured"
      })
    }
    : tag === "ChildFailed"
    ? {
      ...common,
      failure: blob("1", 1024)
    }
    : {
      ...common,
      cancellation: inline({
        requestedBy: "parent"
      })
    }
  return event(
    at,
    Protocol.childTerminalProjectionEventId(
      at.tenantId,
      at.parentRunId,
      at.callId,
      childTerminalEventId
    ),
    childTerminalEventId,
    sequence,
    payload,
    recordedAt
  )
}

const abandoned = (
  parentCause: ParentCause = parentCancellation(),
  at = coordinates(),
  sequence = 1,
  recordedAt = timestamp(sequence)
) =>
  event(
    at,
    Protocol.abandonChildEventId(
      at.tenantId,
      at.parentRunId,
      at.callId,
      parentCause.parentCauseEventId
    ),
    parentCause.parentCauseEventId,
    sequence,
    {
      _tag: "ChildAbandoned",
      childRunId: Protocol.childRunId(
        at.tenantId,
        at.parentRunId,
        at.callId
      ),
      parentCause,
      closeAction: "Abandon"
    },
    recordedAt
  )

const success = <A>(
  result: Result.Result<A, State.ChildWorkflowHistoryError>
): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = <A>(
  result: Result.Result<A, State.ChildWorkflowHistoryError>,
  code: State.HistoryErrorCode
): State.ChildWorkflowHistoryError => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error(`Expected ${code}`)
  }
  assert.strictEqual(result.failure.code, code)
  return result.failure
}

const folded = (
  history: ReadonlyArray<unknown>
): State.ChildWorkflowState => success(State.fold(history))

const reduceAll = (
  history: ReadonlyArray<unknown>
): State.ChildWorkflowState => {
  let state: State.ChildWorkflowState | undefined
  for (const next of history) {
    state = success(State.reduce(state, next))
  }
  return state!
}

const stateView = (state: State.ChildWorkflowState) => ({
  stateVersion: state.stateVersion,
  tenantId: state.tenantId,
  parentRunId: state.parentRunId,
  callId: state.callId,
  relation: state.relation,
  inputContractDigest: state.inputContractDigest,
  encodedInput: state.encodedInput,
  scheduledAt: state.scheduledAt,
  sequence: state.sequence,
  lastRecordedAt: state.lastRecordedAt,
  phase: state.phase,
  close: state.close,
  outcome: state.outcome,
  seenEventIds: Array.from(state.seenEventIds).sort(),
  eventsById: HashMap.toEntries(state.eventsById).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
})

describe("ChildWorkflowStateV3", () => {
  it("folds scheduled, running, and successful child facts with exact evidence", () => {
    const history = [
      scheduled(relation(), blob("2", 2048)),
      startAccepted(),
      terminal("ChildSucceeded")
    ]
    const state = folded(history)

    assert.isTrue(State.isDerived(state))
    assert.isTrue(State.isTerminal(state))
    assert.strictEqual(State.parentCloseBarrier(state), "Discharged")
    assert.strictEqual(state.stateVersion, 3)
    assert.strictEqual(state.sequence, 2)
    assert.strictEqual(state.scheduledAt, timestamp(0))
    assert.strictEqual(state.lastRecordedAt, timestamp(2))
    assert.strictEqual(state.phase._tag, "Succeeded")
    assert.strictEqual(state.close._tag, "Open")
    assert.strictEqual(state.outcome._tag, "Succeeded")
    if (state.outcome._tag === "Succeeded") {
      assert.strictEqual(
        state.outcome.outputContractDigest,
        outputContractDigest
      )
      assert.deepStrictEqual(
        state.outcome.encodedOutput,
        inline({
          receiptId: "receipt-1",
          status: "captured"
        })
      )
    }
    assert.deepStrictEqual(state.encodedInput, blob("2", 2048))
    assert.strictEqual(HashSet.size(state.seenEventIds), history.length)
    assert.strictEqual(HashMap.size(state.eventsById), history.length)
    assert.deepStrictEqual(
      HashMap.toEntries(state.eventsById)
        .map(([, metadata]) => metadata.payloadTag)
        .sort(),
      ["ChildScheduled", "ChildStartAccepted", "ChildSucceeded"].sort()
    )
  })

  it("retains a permanent start failure and its blob-backed evidence", () => {
    const state = folded([
      scheduled(),
      startFailed()
    ])

    assert.strictEqual(state.phase._tag, "StartFailed")
    assert.strictEqual(state.outcome._tag, "StartFailed")
    if (state.outcome._tag === "StartFailed") {
      assert.strictEqual(state.outcome.failureKind, "RetriesExhausted")
      assert.deepStrictEqual(state.outcome.failure, blob("f", 4096))
    }
    assert.isTrue(State.isTerminal(state))
    assert.strictEqual(State.parentCloseBarrier(state), "Discharged")
  })

  it("closes atomically when parent cancellation wins before child start", () => {
    const cause = parentFailure("parent-failure-before-start")
    const state = folded([
      scheduled(),
      cancelledBeforeStart(cause)
    ])

    assert.strictEqual(state.phase._tag, "CancelledBeforeStart")
    assert.strictEqual(state.close._tag, "CancelledBeforeStart")
    assert.strictEqual(state.outcome._tag, "CancelledBeforeStart")
    if (state.close._tag === "CancelledBeforeStart") {
      assert.deepStrictEqual(state.close.parentCause, cause)
      assert.strictEqual(state.close.closeAction, "CancelAndWait")
      assert.strictEqual(
        state.close.cancellationCommandId,
        Protocol.requestChildCancellationCommandId(
          tenantId,
          parentRunId,
          callId,
          cause.parentCauseEventId
        )
      )
    }
    assert.strictEqual(State.parentCloseBarrier(state), "Discharged")
  })

  it("abandons either a scheduled or running relation without claiming child termination", () => {
    const closePolicy = policy("CancelAndWait", "Abandon")
    const scheduleOnly = folded([
      scheduled(relation(closePolicy)),
      abandoned()
    ])
    const running = folded([
      scheduled(relation(closePolicy)),
      startAccepted(),
      abandoned(parentCancellation(), coordinates(), 2)
    ])

    for (const state of [scheduleOnly, running]) {
      assert.strictEqual(state.phase._tag, "Abandoned")
      assert.strictEqual(state.close._tag, "Abandoned")
      assert.strictEqual(state.outcome._tag, "Abandoned")
      assert.isTrue(State.isTerminal(state))
      assert.strictEqual(State.parentCloseBarrier(state), "Discharged")
    }
  })

  it("tracks requested, accepted, and terminal cancellation as distinct durable facts", () => {
    const scheduleState = folded([scheduled()])
    const running = success(State.reduce(scheduleState, startAccepted()))
    const requested = success(
      State.reduce(running, cancellationRequested())
    )
    const accepted = success(
      State.reduce(requested, cancellationAccepted())
    )
    const cancelled = success(
      State.reduce(
        accepted,
        terminal(
          "ChildCancelled",
          coordinates(),
          4,
          timestamp(4),
          "child-terminal-cancelled-after-accept"
        )
      )
    )

    assert.strictEqual(State.parentCloseBarrier(scheduleState), "NotRequested")
    assert.strictEqual(State.parentCloseBarrier(running), "NotRequested")
    assert.strictEqual(requested.phase._tag, "CancellationRequested")
    assert.strictEqual(requested.close._tag, "CancellationRequested")
    assert.strictEqual(
      State.parentCloseBarrier(requested),
      "WaitingForChildTerminal"
    )
    assert.strictEqual(accepted.phase._tag, "CancellationAccepted")
    assert.strictEqual(accepted.close._tag, "CancellationAccepted")
    assert.strictEqual(
      State.parentCloseBarrier(accepted),
      "WaitingForChildTerminal"
    )
    assert.strictEqual(cancelled.phase._tag, "Cancelled")
    assert.strictEqual(cancelled.outcome._tag, "Cancelled")
    assert.strictEqual(State.parentCloseBarrier(cancelled), "Discharged")
    assert.strictEqual(cancelled.sequence, 4)
  })

  it("discharges a RequestCancel barrier without pretending the relation is terminal", () => {
    const closePolicy = policy("CancelAndWait", "RequestCancel")
    const cause = parentCancellation("parent-cancel-request")
    const requested = folded([
      scheduled(relation(closePolicy)),
      startAccepted(),
      cancellationRequested(cause, "RequestCancel")
    ])
    const accepted = success(
      State.reduce(
        requested,
        cancellationAccepted(
          cause.parentCauseEventId,
          coordinates(),
          3,
          timestamp(3),
          "child-accepted-request-cancel"
        )
      )
    )

    assert.isFalse(State.isTerminal(requested))
    assert.isFalse(State.isTerminal(accepted))
    assert.strictEqual(State.parentCloseBarrier(requested), "Discharged")
    assert.strictEqual(State.parentCloseBarrier(accepted), "Discharged")
  })

  it("lets terminal child facts win before cancellation acceptance", () => {
    for (
      const tag of [
        "ChildSucceeded",
        "ChildFailed",
        "ChildCancelled"
      ] as const
    ) {
      const requested = folded([
        scheduled(),
        startAccepted(),
        cancellationRequested()
      ])
      const terminalState = success(
        State.reduce(
          requested,
          terminal(
            tag,
            coordinates(),
            3,
            timestamp(3),
            `terminal-before-accept-${tag}`
          )
        )
      )

      assert.strictEqual(
        terminalState.phase._tag,
        tag === "ChildSucceeded"
          ? "Succeeded"
          : tag === "ChildFailed"
          ? "Failed"
          : "Cancelled"
      )
      const lateAcceptance = cancellationAccepted(
        "parent-failed",
        coordinates(),
        4,
        timestamp(4),
        `late-accept-${tag}`
      )
      failure(
        State.reduce(terminalState, lateAcceptance),
        State.Codes.IllegalTransition
      )
    }
  })

  it("fences success and failure after cancellation acceptance while admitting cancellation", () => {
    const accepted = folded([
      scheduled(),
      startAccepted(),
      cancellationRequested(),
      cancellationAccepted()
    ])

    for (const tag of ["ChildSucceeded", "ChildFailed"] as const) {
      const rejected = State.reduce(
        accepted,
        terminal(
          tag,
          coordinates(),
          4,
          timestamp(4),
          `terminal-after-accept-${tag}`
        )
      )
      failure(rejected, State.Codes.IllegalTransition)
    }

    const cancelled = success(
      State.reduce(
        accepted,
        terminal(
          "ChildCancelled",
          coordinates(),
          4,
          timestamp(4),
          "cancelled-after-accept"
        )
      )
    )
    assert.strictEqual(cancelled.outcome._tag, "Cancelled")
  })

  it("rejects every late fact after terminal or abandoned relation closure", () => {
    const terminalStates = [
      folded([scheduled(), startFailed()]),
      folded([scheduled(), startAccepted(), terminal("ChildSucceeded")]),
      folded([scheduled(), cancelledBeforeStart()]),
      folded([
        scheduled(relation(policy("CancelAndWait", "Abandon"))),
        abandoned()
      ])
    ]

    for (let index = 0; index < terminalStates.length; index++) {
      const state = terminalStates[index]!
      const nextSequence = state.sequence + 1
      const late = terminal(
        "ChildCancelled",
        coordinates(),
        nextSequence,
        timestamp(nextSequence),
        `late-terminal-${index}`
      )
      failure(
        State.reduce(state, late),
        State.Codes.IllegalTransition
      )
    }
  })

  it("binds every parent close event to the exact cause-specific pinned policy", () => {
    const pinned = policy("CancelAndWait", "Abandon")
    const running = folded([
      scheduled(relation(pinned)),
      startAccepted()
    ])
    failure(
      State.reduce(
        running,
        cancellationRequested(
          parentFailure(),
          "RequestCancel",
          coordinates(),
          2
        )
      ),
      State.Codes.ClosePolicyMismatch
    )
    failure(
      State.reduce(
        running,
        cancellationRequested(
          parentCancellation(),
          "RequestCancel",
          coordinates(),
          2
        )
      ),
      State.Codes.ClosePolicyMismatch
    )

    const scheduledState = folded([scheduled(relation(pinned))])
    failure(
      State.reduce(
        scheduledState,
        cancelledBeforeStart(
          parentFailure(),
          "RequestCancel"
        )
      ),
      State.Codes.ClosePolicyMismatch
    )

    const requestCancelPinned = folded([
      scheduled(relation(policy("CancelAndWait", "RequestCancel"))),
      startAccepted()
    ])
    failure(
      State.reduce(
        requestCancelPinned,
        abandoned(parentCancellation(), coordinates(), 2)
      ),
      State.Codes.ClosePolicyMismatch
    )
  })

  it("requires cancellation acceptance to reference the exact live request", () => {
    const requested = folded([
      scheduled(),
      startAccepted(),
      cancellationRequested()
    ])
    const mismatch = cancellationAccepted(
      "different-parent-cause",
      coordinates(),
      3,
      timestamp(3),
      "child-accepted-different-request"
    )
    failure(
      State.reduce(requested, mismatch),
      State.Codes.CancellationMismatch
    )
  })

  it("fences successful output to the target's pinned output contract", () => {
    const running = folded([
      scheduled(),
      startAccepted()
    ])
    const wrongDigest = digest("9")
    const rejected = State.reduce(
      running,
      terminal(
        "ChildSucceeded",
        coordinates(),
        2,
        timestamp(2),
        "child-success-wrong-contract",
        wrongDigest
      )
    )
    const error = failure(
      rejected,
      State.Codes.OutputContractMismatch
    )
    assert.deepStrictEqual(error.details, {
      expectedOutputContractDigest: outputContractDigest,
      actualOutputContractDigest: wrongDigest
    })
  })

  it("enforces schedule-first, exact sequence, monotonic time, and unique event identity", () => {
    failure(
      State.fold([]),
      State.Codes.MissingSchedule
    )
    failure(
      State.fold([startAccepted()]),
      State.Codes.MissingSchedule
    )
    failure(
      State.fold([scheduled(relation(), inline({}), 1)]),
      State.Codes.UnexpectedSequence
    )

    const scheduleState = folded([scheduled()])
    failure(
      State.reduce(
        scheduleState,
        startAccepted(coordinates(), 2)
      ),
      State.Codes.UnexpectedSequence
    )
    failure(
      State.reduce(
        scheduleState,
        startAccepted(
          coordinates(),
          1,
          "2026-07-23T11:59:59.999Z"
        )
      ),
      State.Codes.TimestampRegression
    )
    failure(
      State.reduce(scheduleState, scheduled()),
      State.Codes.DuplicateEventId
    )
  })

  it("rejects valid foreign tenant, parent-run, and call events at the state boundary", () => {
    const scheduleState = folded([scheduled()])
    const cases = [
      [
        startAccepted(coordinates({ tenantId: "tenant-b" })),
        State.Codes.TenantIdMismatch
      ],
      [
        startAccepted(coordinates({ parentRunId: "parent-run-b" })),
        State.Codes.ParentRunIdMismatch
      ],
      [
        startAccepted(coordinates({ callId: "other-call" })),
        State.Codes.CallIdMismatch
      ]
    ] as const

    for (const [foreignEvent, code] of cases) {
      failure(State.reduce(scheduleState, foreignEvent), code)
    }
  })

  it("rejects structural state copies even when their fields are unchanged", () => {
    const state = folded([
      scheduled(),
      startAccepted()
    ])
    const copy = Object.freeze({
      ...state
    }) as State.ChildWorkflowState

    assert.isFalse(State.isDerived(copy))
    failure(
      State.reduce(copy, terminal("ChildSucceeded")),
      State.Codes.InvalidState
    )
  })

  it("rejects descriptor-hostile histories without invoking accessors", () => {
    let getterCalls = 0
    const hostile = Object.create(null)
    Object.defineProperty(hostile, "eventVersion", {
      enumerable: true,
      get() {
        getterCalls++
        throw new Error("must not execute")
      }
    })

    const error = failure(
      State.fold([hostile]),
      State.Codes.InvalidHistory
    )
    assert.strictEqual(getterCalls, 0)
    assert.isUndefined(error.historyIndex)
  })

  it("detaches and recursively freezes scheduled data and terminal outcomes", () => {
    const rawInput = {
      order: {
        id: "order-1"
      }
    }
    const rawSchedule = scheduled(
      relation(),
      inline(rawInput)
    )
    const scheduledState = success(
      State.reduce(undefined, rawSchedule)
    )
    rawInput.order.id = "mutated-after-reduce"

    assert.deepStrictEqual(
      scheduledState.encodedInput,
      inline({ order: { id: "order-1" } })
    )
    assert.notStrictEqual(
      scheduledState.encodedInput,
      rawSchedule.payload.encodedInput
    )
    assert.isTrue(Object.isFrozen(scheduledState))
    assert.isTrue(Object.isFrozen(scheduledState.relation))
    assert.isTrue(Object.isFrozen(scheduledState.relation.parent.ancestry))
    assert.isTrue(Object.isFrozen(scheduledState.encodedInput))
    if (scheduledState.encodedInput._tag === "Inline") {
      assert.isTrue(Object.isFrozen(scheduledState.encodedInput.value))
    }

    const running = success(
      State.reduce(scheduledState, startAccepted())
    )
    const rawOutput = {
      receipt: {
        id: "receipt-1"
      }
    }
    const rawSuccess = terminal("ChildSucceeded")
    rawSuccess.payload.encodedOutput = inline(rawOutput)
    const succeeded = success(State.reduce(running, rawSuccess))
    rawOutput.receipt.id = "mutated-after-reduce"

    assert.strictEqual(succeeded.outcome._tag, "Succeeded")
    if (succeeded.outcome._tag === "Succeeded") {
      assert.deepStrictEqual(
        succeeded.outcome.encodedOutput,
        inline({ receipt: { id: "receipt-1" } })
      )
      assert.isTrue(Object.isFrozen(succeeded.outcome))
      assert.isTrue(Object.isFrozen(succeeded.outcome.encodedOutput))
      if (succeeded.outcome.encodedOutput._tag === "Inline") {
        assert.isTrue(
          Object.isFrozen(succeeded.outcome.encodedOutput.value)
        )
      }
    }
    assert.isTrue(Object.isFrozen(succeeded.phase))
  })

  it("annotates the exact failing history index", () => {
    const error = failure(
      State.fold([
        scheduled(),
        startAccepted(),
        terminal(
          "ChildSucceeded",
          coordinates(),
          4,
          timestamp(4)
        )
      ]),
      State.Codes.UnexpectedSequence
    )
    assert.strictEqual(error.historyIndex, 2)
  })

  it("produces identical semantic heads through fold and incremental reduce", () => {
    const histories = [
      [
        scheduled(),
        startAccepted(),
        terminal("ChildSucceeded")
      ],
      [
        scheduled(),
        startAccepted(),
        cancellationRequested(),
        cancellationAccepted(),
        terminal(
          "ChildCancelled",
          coordinates(),
          4,
          timestamp(4),
          "cancelled-parity"
        )
      ],
      [
        scheduled(relation(policy("CancelAndWait", "Abandon"))),
        startAccepted(),
        abandoned(parentCancellation(), coordinates(), 2)
      ],
      [
        scheduled(),
        startFailed()
      ]
    ] satisfies ReadonlyArray<ReadonlyArray<unknown>>

    for (const history of histories) {
      assert.deepStrictEqual(
        stateView(folded(history)),
        stateView(reduceAll(history))
      )
    }
  })
})
