import { assert, describe, it } from "@effect/vitest"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as IdentityV3 from "../src/IdentityV3.ts"

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

describe("IdentityV3", () => {
  it("derives recursion family identity only from the workflow definition id", () => {
    assert.strictEqual(
      IdentityV3.workflowFamilyIdentity("payments"),
      tuple("WorkflowFamily", "payments")
    )
    assert.notStrictEqual(
      IdentityV3.workflowFamilyIdentity("payments"),
      IdentityV3.workflowFamilyIdentity("orders")
    )
  })

  it("has stable canonical fixtures for the complete child vocabulary", () => {
    const tenantId = "tenant-1"
    const parentRunId = "parent-run-1"
    const nodeInstanceId = "charge#1"
    const callId = IdentityV3.childCallId(
      tenantId,
      parentRunId,
      nodeInstanceId
    )
    const childRunId = IdentityV3.childRunId(
      tenantId,
      parentRunId,
      callId
    )
    const startRequestId = IdentityV3.childStartRequestId(
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
        IdentityV3.scheduleChildCommandId(tenantId, parentRunId, callId),
        tuple("ScheduleChild", tenantId, parentRunId, callId)
      ],
      [
        IdentityV3.childStartProjectionEventId(
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
        IdentityV3.childTerminalProjectionEventId(
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
        IdentityV3.requestChildCancellationCommandId(
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
        IdentityV3.childCancellationAcceptedEventId(
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
        IdentityV3.childCancelledBeforeStartEventId(
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
        IdentityV3.abandonChildEventId(
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
        IdentityV3.childStartFailedEventId(
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
      assert.deepStrictEqual(JSON.parse(actual), JSON.parse(expected))
    }
    assert.strictEqual(
      new Set(fixtures.map(([actual]) => actual)).size,
      fixtures.length
    )
  })

  it("is byte-compatible with every identity currently exposed by ChildWorkflowV3", () => {
    const tenantId = "tenant"
    const parentRunId = "parent"
    const nodeInstanceId = "node#1"
    const callId = IdentityV3.childCallId(
      tenantId,
      parentRunId,
      nodeInstanceId
    )
    const startRequestId = IdentityV3.childStartRequestId(
      tenantId,
      parentRunId,
      callId
    )

    const pairs: ReadonlyArray<readonly [string, string]> = [
      [
        IdentityV3.childCallId(tenantId, parentRunId, nodeInstanceId),
        ChildWorkflowV3.childCallId(tenantId, parentRunId, nodeInstanceId)
      ],
      [
        IdentityV3.childRunId(tenantId, parentRunId, callId),
        ChildWorkflowV3.childRunId(tenantId, parentRunId, callId)
      ],
      [
        startRequestId,
        ChildWorkflowV3.childStartRequestId(tenantId, parentRunId, callId)
      ],
      [
        IdentityV3.scheduleChildCommandId(tenantId, parentRunId, callId),
        ChildWorkflowV3.scheduleChildCommandId(
          tenantId,
          parentRunId,
          callId
        )
      ],
      [
        IdentityV3.childStartProjectionEventId(
          tenantId,
          parentRunId,
          callId,
          "started"
        ),
        ChildWorkflowV3.childStartProjectionEventId(
          tenantId,
          parentRunId,
          callId,
          "started"
        )
      ],
      [
        IdentityV3.childTerminalProjectionEventId(
          tenantId,
          parentRunId,
          callId,
          "terminal"
        ),
        ChildWorkflowV3.childTerminalProjectionEventId(
          tenantId,
          parentRunId,
          callId,
          "terminal"
        )
      ],
      [
        IdentityV3.requestChildCancellationCommandId(
          tenantId,
          parentRunId,
          callId,
          "cause"
        ),
        ChildWorkflowV3.requestChildCancellationCommandId(
          tenantId,
          parentRunId,
          callId,
          "cause"
        )
      ],
      [
        IdentityV3.childCancellationAcceptedEventId(
          tenantId,
          parentRunId,
          callId,
          "cancelled"
        ),
        ChildWorkflowV3.childCancellationAcceptedEventId(
          tenantId,
          parentRunId,
          callId,
          "cancelled"
        )
      ],
      [
        IdentityV3.childCancelledBeforeStartEventId(
          tenantId,
          parentRunId,
          callId,
          "cause"
        ),
        ChildWorkflowV3.childCancelledBeforeStartEventId(
          tenantId,
          parentRunId,
          callId,
          "cause"
        )
      ],
      [
        IdentityV3.abandonChildEventId(
          tenantId,
          parentRunId,
          callId,
          "cause"
        ),
        ChildWorkflowV3.abandonChildEventId(
          tenantId,
          parentRunId,
          callId,
          "cause"
        )
      ],
      [
        IdentityV3.childStartFailedEventId(
          tenantId,
          parentRunId,
          callId,
          startRequestId
        ),
        ChildWorkflowV3.childStartFailedEventId(
          tenantId,
          parentRunId,
          callId,
          startRequestId
        )
      ]
    ]

    for (const [canonical, legacyLocation] of pairs) {
      assert.strictEqual(canonical, legacyLocation)
    }
  })

  it("binds every coordinate and semantic identity kind", () => {
    const tenantId = "tenant"
    const parentRunId = "parent"
    const callId = "call"
    const childSourceId = "source"
    const base = IdentityV3.childTerminalProjectionEventId(
      tenantId,
      parentRunId,
      callId,
      childSourceId
    )

    assert.notStrictEqual(
      base,
      IdentityV3.childTerminalProjectionEventId(
        "tenant-other",
        parentRunId,
        callId,
        childSourceId
      )
    )
    assert.notStrictEqual(
      base,
      IdentityV3.childTerminalProjectionEventId(
        tenantId,
        "parent-other",
        callId,
        childSourceId
      )
    )
    assert.notStrictEqual(
      base,
      IdentityV3.childTerminalProjectionEventId(
        tenantId,
        parentRunId,
        "call-other",
        childSourceId
      )
    )
    assert.notStrictEqual(
      base,
      IdentityV3.childTerminalProjectionEventId(
        tenantId,
        parentRunId,
        callId,
        "source-other"
      )
    )

    const sameCoordinates = [
      IdentityV3.childRunId(tenantId, parentRunId, callId),
      IdentityV3.childStartRequestId(tenantId, parentRunId, callId),
      IdentityV3.scheduleChildCommandId(tenantId, parentRunId, callId)
    ]
    assert.strictEqual(
      new Set(sameCoordinates).size,
      sameCoordinates.length
    )
  })

  it("resists delimiter, quote, nesting, and unicode tuple collisions", () => {
    const pairs: ReadonlyArray<
      readonly [
        readonly [string, string, string],
        readonly [string, string, string]
      ]
    > = [
      [
        ["a", "b,c", "d"],
        ["a,b", "c", "d"]
      ],
      [
        ["a", "b", "c,d"],
        ["a", "b,c", "d"]
      ],
      [
        ["a", "b", "\"]"],
        ["a", "b\"]", ""]
      ],
      [
        ["tenant", "[\"parent\"", "node"],
        ["tenant[", "\"parent\"", "node"]
      ],
      [
        ["é", "parent", "node"],
        ["e\u0301", "parent", "node"]
      ],
      [
        ["tenant", "parent", "\u0000node"],
        ["tenant", "parent\u0000", "node"]
      ]
    ]

    for (const [left, right] of pairs) {
      assert.notStrictEqual(
        IdentityV3.childCallId(...left),
        IdentityV3.childCallId(...right)
      )
    }
  })
})
