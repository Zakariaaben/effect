import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Child from "../src/ChildWorkflowV3.ts"

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`
const numberedDigest = (value: number): string => `sha256:${value.toString(16).padStart(64, "0")}`

const tenantId = "tenant-1"
const parentRunId = "parent-run-1"
const nodeId = "charge-card"
const nodeInstanceId = "charge-card#1"
const rootArtifactDigest = digest("a")
const rootWorkflowIdentity = "orders:3"

const closePolicy = () => ({
  closePolicyVersion: 3 as const,
  onParentFailure: "CancelAndWait" as const,
  onParentCancellation: "RequestCancel" as const
})

const target = () => ({
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
    deploymentId: "payment-build-19"
  },
  workflowIdentity: "payment:3.1.0",
  inputContractDigest: digest("d"),
  outputContractDigest: digest("e"),
  closePolicy: closePolicy(),
  recursionPolicy: "Forbid" as const,
  maxLineageDepth: Child.MaximumLineageDepth
})

const parentLink = () => {
  const callId = Child.childCallId(tenantId, parentRunId, nodeInstanceId)
  return {
    parentLinkVersion: 3 as const,
    tenantId,
    parentRunId,
    parentArtifactDigest: rootArtifactDigest,
    parentWorkflowIdentity: rootWorkflowIdentity,
    callId,
    nodeId,
    nodeInstanceId,
    scheduleEventId: Child.scheduleChildCommandId(
      tenantId,
      parentRunId,
      callId
    ),
    rootRunId: parentRunId,
    lineageDepth: 1,
    ancestry: [{
      lineageEntryVersion: 3 as const,
      depth: 0,
      tenantId,
      runId: parentRunId,
      artifactDigest: rootArtifactDigest,
      workflowIdentity: rootWorkflowIdentity
    }]
  }
}

const twoLevelParentLink = () => {
  const parent = parentLink()
  const rootRunId = "root-run"
  const root = {
    lineageEntryVersion: 3 as const,
    depth: 0,
    tenantId,
    runId: rootRunId,
    artifactDigest: digest("1"),
    workflowIdentity: "root:3"
  }
  const directParent = {
    lineageEntryVersion: 3 as const,
    depth: 1,
    tenantId,
    runId: parentRunId,
    artifactDigest: rootArtifactDigest,
    workflowIdentity: rootWorkflowIdentity
  }
  return {
    ...parent,
    rootRunId,
    lineageDepth: 2,
    ancestry: [root, directParent]
  }
}

const relation = () => {
  const parent = parentLink()
  return {
    relationVersion: 3 as const,
    parent,
    target: target(),
    childRunId: Child.childRunId(
      parent.tenantId,
      parent.parentRunId,
      parent.callId
    ),
    startRequestId: Child.childStartRequestId(
      parent.tenantId,
      parent.parentRunId,
      parent.callId
    ),
    scheduleCommandId: Child.scheduleChildCommandId(
      parent.tenantId,
      parent.parentRunId,
      parent.callId
    )
  }
}

const state = (phase: Record<string, unknown>) => ({
  callStateVersion: 3 as const,
  relation: relation(),
  phase
})

const expectSuccess = <A>(
  result: Result.Result<A, Child.ChildWorkflowValidationError>
): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const expectCode = <A>(
  result: Result.Result<A, Child.ChildWorkflowValidationError>,
  code: Child.ValidationCode
): Child.ChildWorkflowValidationError => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error(`Expected ${code}`)
  }
  assert.strictEqual(result.failure.code, code)
  return result.failure
}

const tuple = (
  kind: string,
  ...parts: ReadonlyArray<string | number>
): string =>
  JSON.stringify([
    "@effect/workflow-builder",
    3,
    kind,
    ...parts
  ])

describe("ChildWorkflowV3", () => {
  it("uses stable collision-free canonical identities for the full relation vocabulary", () => {
    const callId = Child.childCallId(tenantId, parentRunId, nodeInstanceId)
    const childRunId = Child.childRunId(tenantId, parentRunId, callId)
    const startRequestId = Child.childStartRequestId(
      tenantId,
      parentRunId,
      callId
    )
    const fixtures: ReadonlyArray<readonly [string, string]> = [
      [
        callId,
        tuple("ChildCall", tenantId, parentRunId, nodeInstanceId)
      ],
      [
        childRunId,
        tuple("ChildRun", tenantId, parentRunId, callId)
      ],
      [
        startRequestId,
        tuple("ChildStartRequest", tenantId, parentRunId, callId)
      ],
      [
        Child.scheduleChildCommandId(tenantId, parentRunId, callId),
        tuple("ScheduleChild", tenantId, parentRunId, callId)
      ],
      [
        Child.childStartProjectionEventId(
          tenantId,
          parentRunId,
          callId,
          "child-started-1"
        ),
        tuple(
          "ChildStartProjection",
          tenantId,
          parentRunId,
          callId,
          "child-started-1"
        )
      ],
      [
        Child.childTerminalProjectionEventId(
          tenantId,
          parentRunId,
          callId,
          "child-terminal-1"
        ),
        tuple(
          "ChildTerminalProjection",
          tenantId,
          parentRunId,
          callId,
          "child-terminal-1"
        )
      ],
      [
        Child.requestChildCancellationCommandId(
          tenantId,
          parentRunId,
          callId,
          "parent-cause-1"
        ),
        tuple(
          "RequestChildCancellation",
          tenantId,
          parentRunId,
          callId,
          "parent-cause-1"
        )
      ],
      [
        Child.childCancellationAcceptedEventId(
          tenantId,
          parentRunId,
          callId,
          "child-cancel-1"
        ),
        tuple(
          "ChildCancellationAccepted",
          tenantId,
          parentRunId,
          callId,
          "child-cancel-1"
        )
      ],
      [
        Child.childCancelledBeforeStartEventId(
          tenantId,
          parentRunId,
          callId,
          "parent-cause-1"
        ),
        tuple(
          "ChildCancelledBeforeStart",
          tenantId,
          parentRunId,
          callId,
          "parent-cause-1"
        )
      ],
      [
        Child.abandonChildEventId(
          tenantId,
          parentRunId,
          callId,
          "parent-cause-1"
        ),
        tuple(
          "AbandonChild",
          tenantId,
          parentRunId,
          callId,
          "parent-cause-1"
        )
      ],
      [
        Child.childStartFailedEventId(
          tenantId,
          parentRunId,
          callId,
          startRequestId
        ),
        tuple(
          "ChildStartFailed",
          tenantId,
          parentRunId,
          callId,
          startRequestId
        )
      ]
    ]

    for (const [actual, expected] of fixtures) {
      assert.strictEqual(actual, expected)
    }
    assert.strictEqual(
      new Set(fixtures.map(([actual]) => actual)).size,
      fixtures.length
    )
    assert.strictEqual(
      Child.childRunId(tenantId, parentRunId, callId),
      childRunId
    )
    assert.notStrictEqual(
      Child.childRunId("tenant-2", parentRunId, callId),
      childRunId
    )
    assert.notStrictEqual(
      Child.childRunId(tenantId, "parent-run-2", callId),
      childRunId
    )
    assert.notStrictEqual(
      Child.childRunId(tenantId, parentRunId, `${callId}-other`),
      childRunId
    )
    assert.notStrictEqual(
      Child.childStartProjectionEventId(
        tenantId,
        parentRunId,
        callId,
        "child-started-1"
      ),
      Child.childStartProjectionEventId(
        tenantId,
        parentRunId,
        callId,
        "child-started-2"
      )
    )
    assert.notStrictEqual(
      Child.childCallId("a", "b,c", "d"),
      Child.childCallId("a,b", "c", "d")
    )
    assert.notStrictEqual(
      Child.childCallId("a", "b", "c,d"),
      Child.childCallId("a", "b,c", "d")
    )
  })

  it("provides strict closed schemas at every persisted boundary", () => {
    const validTarget = target()
    const validParent = parentLink()
    const validRelation = relation()
    const validState = state({ _tag: "Scheduled" })

    Schema.decodeUnknownSync(Child.ChildClosePolicy)(validTarget.closePolicy)
    Schema.decodeUnknownSync(Child.ChildTargetPin)(validTarget)
    Schema.decodeUnknownSync(Child.ParentRunLink)(validParent)
    Schema.decodeUnknownSync(Child.ChildRelation)(validRelation)
    Schema.decodeUnknownSync(Child.ChildCallState)(validState)

    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ChildClosePolicy)({
        ...validTarget.closePolicy,
        futurePolicy: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ChildTargetPin)({
        ...validTarget,
        futurePin: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ChildTargetPin)({
        ...validTarget,
        plan: { ...validTarget.plan, futurePlanPin: true }
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ParentRunLink)({
        ...validParent,
        ancestry: [{
          ...validParent.ancestry[0]!,
          futureLineage: true
        }]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ChildRelation)({
        ...validRelation,
        futureRelation: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ChildCallState)({
        ...validState,
        phase: { _tag: "Scheduled", futurePhase: true }
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Child.ChildCallState)({
        ...validState,
        callStateVersion: 2
      })
    )
  })

  it("rejects every non-V3 target selector and malformed target bounds", () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { targetVersion: 2 },
      { artifactVersion: 2 },
      { executionProtocolVersion: 2 },
      { compilerSemanticVersion: "1" }
    ]
    for (const override of cases) {
      expectCode(
        Child.validateChildTargetPin({ ...target(), ...override }),
        Child.ValidationCodes.NonV3ChildTarget
      )
    }

    expectCode(
      Child.validateChildTargetPin({
        ...target(),
        maxLineageDepth: Child.MaximumLineageDepth + 1
      }),
      Child.ValidationCodes.InvalidSchema
    )
    expectCode(
      Child.validateChildTargetPin({
        ...target(),
        closePolicy: {
          ...closePolicy(),
          onParentFailure: "Terminate"
        }
      }),
      Child.ValidationCodes.InvalidSchema
    )
    expectCode(
      Child.validateChildTargetPin({
        ...target(),
        unknownPin: true
      }),
      Child.ValidationCodes.InvalidSchema
    )
  })

  it("rejects off-by-one, cross-tenant, root, and parent lineage mismatches", () => {
    const valid = parentLink()

    expectCode(
      Child.validateParentRunLink({
        ...valid,
        lineageDepth: 2
      }),
      Child.ValidationCodes.LineageDepthMismatch
    )
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        ancestry: [{
          ...valid.ancestry[0]!,
          depth: 1
        }]
      }),
      Child.ValidationCodes.LineageEntryDepthMismatch
    )
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        ancestry: [{
          ...valid.ancestry[0]!,
          tenantId: "tenant-2"
        }]
      }),
      Child.ValidationCodes.LineageTenantMismatch
    )
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        rootRunId: "different-root"
      }),
      Child.ValidationCodes.RootRunMismatch
    )
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        parentArtifactDigest: digest("f")
      }),
      Child.ValidationCodes.ParentRunMismatch
    )
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        callId: "caller-selected-call"
      }),
      Child.ValidationCodes.IdentityMismatch
    )
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        scheduleEventId: "caller-selected-schedule"
      }),
      Child.ValidationCodes.IdentityMismatch
    )
  })

  it("rejects repeated lineage runs, artifacts, and workflow identities", () => {
    const valid = twoLevelParentLink()
    const root = valid.ancestry[0]!
    const parent = valid.ancestry[1]!

    const repeatedRunParent = {
      ...parent,
      runId: root.runId
    }
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        parentRunId: repeatedRunParent.runId,
        callId: Child.childCallId(
          tenantId,
          repeatedRunParent.runId,
          nodeInstanceId
        ),
        scheduleEventId: Child.scheduleChildCommandId(
          tenantId,
          repeatedRunParent.runId,
          Child.childCallId(
            tenantId,
            repeatedRunParent.runId,
            nodeInstanceId
          )
        ),
        ancestry: [root, repeatedRunParent]
      }),
      Child.ValidationCodes.RepeatedRun
    )

    const repeatedArtifactParent = {
      ...parent,
      artifactDigest: root.artifactDigest
    }
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        parentArtifactDigest: repeatedArtifactParent.artifactDigest,
        ancestry: [root, repeatedArtifactParent]
      }),
      Child.ValidationCodes.RepeatedArtifact
    )

    const repeatedWorkflowParent = {
      ...parent,
      workflowIdentity: root.workflowIdentity
    }
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        parentWorkflowIdentity: repeatedWorkflowParent.workflowIdentity,
        ancestry: [root, repeatedWorkflowParent]
      }),
      Child.ValidationCodes.RepeatedWorkflowIdentity
    )
  })

  it("enforces the fixed ancestry ceiling before relational validation", () => {
    const ancestry = Array.from(
      { length: Child.MaximumLineageDepth + 1 },
      (_, index) => ({
        lineageEntryVersion: 3 as const,
        depth: Math.min(index, Child.MaximumLineageDepth - 1),
        tenantId,
        runId: `run-${index}`,
        artifactDigest: numberedDigest(index + 1),
        workflowIdentity: `workflow-${index}`
      })
    )
    const valid = parentLink()
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        lineageDepth: Child.MaximumLineageDepth,
        ancestry
      }),
      Child.ValidationCodes.InvalidSchema
    )
    assert.throws(() => Schema.decodeUnknownSync(Child.Ancestry)(ancestry))
  })

  it("rejects recursive targets, target depth overflow, and forged relation identities", () => {
    const valid = relation()
    expectCode(
      Child.validateChildRelation({
        ...valid,
        target: {
          ...valid.target,
          executionProtocolVersion: 2
        }
      }),
      Child.ValidationCodes.NonV3ChildTarget
    )
    expectCode(
      Child.validateChildRelation({
        ...valid,
        target: {
          ...valid.target,
          artifactDigest: valid.parent.ancestry[0]!.artifactDigest
        }
      }),
      Child.ValidationCodes.RepeatedArtifact
    )
    expectCode(
      Child.validateChildRelation({
        ...valid,
        target: {
          ...valid.target,
          workflowIdentity: valid.parent.ancestry[0]!.workflowIdentity
        }
      }),
      Child.ValidationCodes.RepeatedWorkflowIdentity
    )

    const deepParent = twoLevelParentLink()
    const deepCallId = deepParent.callId
    expectCode(
      Child.validateChildRelation({
        ...valid,
        parent: deepParent,
        target: {
          ...valid.target,
          maxLineageDepth: 1
        },
        childRunId: Child.childRunId(
          tenantId,
          parentRunId,
          deepCallId
        ),
        startRequestId: Child.childStartRequestId(
          tenantId,
          parentRunId,
          deepCallId
        ),
        scheduleCommandId: Child.scheduleChildCommandId(
          tenantId,
          parentRunId,
          deepCallId
        )
      }),
      Child.ValidationCodes.TargetDepthLimitExceeded
    )

    for (
      const override of [
        { childRunId: "forged-child-run" },
        { startRequestId: "forged-start-request" },
        { scheduleCommandId: "forged-schedule" }
      ]
    ) {
      expectCode(
        Child.validateChildRelation({ ...valid, ...override }),
        Child.ValidationCodes.IdentityMismatch
      )
    }
  })

  it("validates canonical identities for every closed child-call phase", () => {
    const validRelation = relation()
    const parent = validRelation.parent
    const coordinates = [
      parent.tenantId,
      parent.parentRunId,
      parent.callId
    ] as const
    const causeEventId = "parent-cause-1"
    const childCancellationEventId = "child-cancellation-1"
    const childStartedEventId = "child-started-1"
    const childTerminalEventId = "child-terminal-1"
    const phases: ReadonlyArray<Record<string, unknown>> = [
      { _tag: "Scheduled" },
      {
        _tag: "Running",
        childRunStartedEventId: childStartedEventId,
        startProjectionEventId: Child.childStartProjectionEventId(
          ...coordinates,
          childStartedEventId
        )
      },
      {
        _tag: "StartFailed",
        startFailedEventId: Child.childStartFailedEventId(
          ...coordinates,
          validRelation.startRequestId
        )
      },
      {
        _tag: "CancellationRequested",
        parentCauseEventId: causeEventId,
        cancellationCommandId: Child.requestChildCancellationCommandId(
          ...coordinates,
          causeEventId
        )
      },
      {
        _tag: "CancellationAccepted",
        parentCauseEventId: causeEventId,
        cancellationCommandId: Child.requestChildCancellationCommandId(
          ...coordinates,
          causeEventId
        ),
        childCancellationEventId,
        acceptedEventId: Child.childCancellationAcceptedEventId(
          ...coordinates,
          childCancellationEventId
        )
      },
      ...(["Succeeded", "Failed", "Cancelled"] as const).map((_tag) => ({
        _tag,
        childTerminalEventId,
        terminalProjectionEventId: Child.childTerminalProjectionEventId(
          ...coordinates,
          childTerminalEventId
        )
      })),
      {
        _tag: "CancelledBeforeStart",
        parentCauseEventId: causeEventId,
        cancelledBeforeStartEventId: Child.childCancelledBeforeStartEventId(
          ...coordinates,
          causeEventId
        )
      },
      {
        _tag: "Abandoned",
        parentCauseEventId: causeEventId,
        abandonEventId: Child.abandonChildEventId(
          ...coordinates,
          causeEventId
        )
      }
    ]

    for (const phase of phases) {
      expectSuccess(Child.validateChildCallState({
        callStateVersion: 3,
        relation: validRelation,
        phase
      }))
    }

    const forgedPhases: ReadonlyArray<Record<string, unknown>> = [
      {
        ...phases[1]!,
        startProjectionEventId: "forged"
      },
      {
        ...phases[2]!,
        startFailedEventId: "forged"
      },
      {
        ...phases[3]!,
        cancellationCommandId: "forged"
      },
      {
        ...phases[4]!,
        acceptedEventId: "forged"
      },
      {
        ...phases[5]!,
        terminalProjectionEventId: "forged"
      },
      {
        ...phases[8]!,
        cancelledBeforeStartEventId: "forged"
      },
      {
        ...phases[9]!,
        abandonEventId: "forged"
      }
    ]
    for (const phase of forgedPhases) {
      expectCode(
        Child.validateChildCallState({
          callStateVersion: 3,
          relation: validRelation,
          phase
        }),
        Child.ValidationCodes.IdentityMismatch
      )
    }
  })

  it("returns detached recursively frozen target, lineage, relation, and state records", () => {
    const original = state({ _tag: "Scheduled" })
    const admitted = expectSuccess(
      Child.validateChildCallState(original)
    )

    assert.isTrue(Object.isFrozen(admitted))
    assert.isTrue(Object.isFrozen(admitted.relation))
    assert.isTrue(Object.isFrozen(admitted.relation.target))
    assert.isTrue(Object.isFrozen(admitted.relation.target.plan))
    assert.isTrue(Object.isFrozen(admitted.relation.target.definition))
    assert.isTrue(Object.isFrozen(admitted.relation.target.closePolicy))
    assert.isTrue(Object.isFrozen(admitted.relation.parent))
    assert.isTrue(Object.isFrozen(admitted.relation.parent.ancestry))
    assert.isTrue(Object.isFrozen(admitted.relation.parent.ancestry[0]))
    assert.isTrue(Object.isFrozen(admitted.phase))

    original.relation.parent.ancestry[0]!.runId = "mutated-run"
    original.relation.target.plan.id = "mutated-plan"
    const mutableClosePolicy = original.relation.target.closePolicy as {
      onParentFailure: string
    }
    mutableClosePolicy.onParentFailure = "Abandon"
    assert.strictEqual(
      admitted.relation.parent.ancestry[0]!.runId,
      parentRunId
    )
    assert.strictEqual(admitted.relation.target.plan.id, "payment-plan")
    assert.strictEqual(
      admitted.relation.target.closePolicy.onParentFailure,
      "CancelAndWait"
    )

    let reads = 0
    const hostile = Object.defineProperty({}, "targetVersion", {
      enumerable: true,
      get: () => {
        reads++
        return 3
      }
    })
    expectCode(
      Child.validateChildTargetPin(hostile),
      Child.ValidationCodes.InvalidSchema
    )
    assert.strictEqual(reads, 0)
  })
})
