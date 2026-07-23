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
const rootWorkflowFamilyIdentity = Child.workflowFamilyIdentity("orders")

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
    deploymentId: "payment-build-19",
    buildDigest: digest("6")
  },
  workflowFamilyIdentity: Child.workflowFamilyIdentity("payment"),
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
    parentWorkflowFamilyIdentity: rootWorkflowFamilyIdentity,
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
      workflowFamilyIdentity: rootWorkflowFamilyIdentity
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
    workflowFamilyIdentity: Child.workflowFamilyIdentity("root")
  }
  const directParent = {
    lineageEntryVersion: 3 as const,
    depth: 1,
    tenantId,
    runId: parentRunId,
    artifactDigest: rootArtifactDigest,
    workflowFamilyIdentity: rootWorkflowFamilyIdentity
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
): string => {
  const field = (value: string | number): string => {
    const text = String(value)
    return `${typeof value === "number" ? "n" : "s"}${new TextEncoder().encode(text).length}:${text}`
  }
  return [
    field("@effect/workflow-builder"),
    field(3),
    field(kind),
    ...parts.map(field)
  ].join("")
}

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
        tuple(
          "ChildRun",
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId
        )
      ],
      [
        startRequestId,
        tuple(
          "ChildStartRequest",
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId
        )
      ],
      [
        Child.scheduleChildCommandId(tenantId, parentRunId, callId),
        tuple(
          "ScheduleChild",
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId
        )
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
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
          "CanonicalCall",
          tenantId,
          parentRunId,
          nodeInstanceId,
          "CanonicalStartRequest"
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

    Schema.decodeUnknownSync(Child.ChildClosePolicy)(validTarget.closePolicy)
    Schema.decodeUnknownSync(Child.ChildTargetPin)(validTarget)
    Schema.decodeUnknownSync(Child.ParentRunLink)(validParent)
    Schema.decodeUnknownSync(Child.ChildRelation)(validRelation)

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
    const mismatchedFamily = {
      ...target(),
      workflowFamilyIdentity: Child.workflowFamilyIdentity("other")
    }
    expectCode(
      Child.validateChildTargetPin(mismatchedFamily),
      Child.ValidationCodes.IdentityMismatch
    )
    assert.throws(() => Schema.decodeUnknownSync(Child.ChildTargetPin)(mismatchedFamily))

    expectCode(
      Child.validateChildTargetPin({
        ...target(),
        definition: {
          ...target().definition,
          id: "\ud800"
        }
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
      workflowFamilyIdentity: root.workflowFamilyIdentity
    }
    expectCode(
      Child.validateParentRunLink({
        ...valid,
        parentWorkflowFamilyIdentity: repeatedWorkflowParent.workflowFamilyIdentity,
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
        workflowFamilyIdentity: Child.workflowFamilyIdentity(
          `workflow-${index}`
        )
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
          definition: {
            ...valid.target.definition,
            id: "orders"
          },
          workflowFamilyIdentity: valid.parent.ancestry[0]!.workflowFamilyIdentity
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

  it("returns detached recursively frozen target, lineage, and relation records", () => {
    const original = relation()
    const admitted = expectSuccess(
      Child.validateChildRelation(original)
    )

    assert.isTrue(Object.isFrozen(admitted))
    assert.isTrue(Object.isFrozen(admitted.target))
    assert.isTrue(Object.isFrozen(admitted.target.plan))
    assert.isTrue(Object.isFrozen(admitted.target.definition))
    assert.isTrue(Object.isFrozen(admitted.target.closePolicy))
    assert.isTrue(Object.isFrozen(admitted.parent))
    assert.isTrue(Object.isFrozen(admitted.parent.ancestry))
    assert.isTrue(Object.isFrozen(admitted.parent.ancestry[0]))

    original.parent.ancestry[0]!.runId = "mutated-run"
    original.target.plan.id = "mutated-plan"
    const mutableClosePolicy = original.target.closePolicy as {
      onParentFailure: string
    }
    mutableClosePolicy.onParentFailure = "Abandon"
    assert.strictEqual(
      admitted.parent.ancestry[0]!.runId,
      parentRunId
    )
    assert.strictEqual(admitted.target.plan.id, "payment-plan")
    assert.strictEqual(
      admitted.target.closePolicy.onParentFailure,
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
