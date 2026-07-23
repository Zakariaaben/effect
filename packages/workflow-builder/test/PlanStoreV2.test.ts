import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as PlanStoreV1 from "../src/PlanStore.ts"
import * as PlanStoreV2 from "../src/PlanStoreV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const artifactDigest = Schema.decodeUnknownSync(PlanStoreV2.ArtifactDigest)(
  `sha256:${"a".repeat(64)}`
)
const compiledFingerprint = Schema.decodeUnknownSync(ProtocolV2Wire.CompiledFingerprint)(
  `sha256:${"b".repeat(64)}`
)

const artifact = (): PlanStoreV2.PlanArtifact => ({
  artifactVersion: 2,
  executionProtocolVersion: 2,
  fingerprintDocument: {
    fingerprintVersion: 1,
    compilerSemanticVersion: "2",
    plan: {
      formatVersion: 1,
      id: "plan-2",
      revision: 0,
      definition: { id: "workflow-2", version: "2.0.0" },
      nodes: [],
      edges: []
    },
    topologicalOrder: [],
    stages: []
  },
  compiledFingerprint,
  definitionDeploymentId: "definition-build-2",
  dispatchTargets: {},
  activityPolicies: {},
  signalManifest: {
    catalogVersion: 1,
    definitions: [],
    inboxPolicy: {
      policyVersion: 1,
      maxAcceptedCount: 1_000,
      maxPendingCount: 100,
      maxPendingEncodedBytes: 1_048_576,
      maxItemEncodedBytes: 65_536,
      maxSignalIdBytes: 256,
      maxCorrelationKeyBytes: 512,
      maxPendingWaits: 100,
      maxTtlMillis: 604_800_000,
      deduplicationScope: "RunLifetime",
      receiptRetentionAfterTerminalMillis: 604_800_000,
      overflow: { _tag: "Reject" }
    }
  }
})

describe("PlanStoreV2", () => {
  it("requires explicit version 2 artifact and binding selectors", () => {
    const admitted = PlanStoreV2.validateArtifact(artifact())
    assert.isTrue(Result.isSuccess(admitted))
    if (Result.isFailure(admitted)) {
      throw admitted.failure
    }
    assert.deepStrictEqual(admitted.success, artifact())

    const binding = Schema.decodeUnknownSync(PlanStoreV2.RunBinding)({
      bindingVersion: 2,
      executionProtocolVersion: 2,
      key: { tenantId: "tenant-1", runId: "run-1" },
      artifactDigest,
      workflowIdentity: "order:1",
      requestId: "start-1",
      runStartedEventId: "run-started-1"
    })
    assert.strictEqual(binding.executionProtocolVersion, 2)

    assert.throws(() =>
      Schema.decodeUnknownSync(PlanStoreV2.PlanArtifact)({
        ...artifact(),
        executionProtocolVersion: 1
      })
    )
    const withoutSignals = { ...artifact() } as Record<string, unknown>
    delete withoutSignals.signalManifest
    assert.throws(() => Schema.decodeUnknownSync(PlanStoreV2.PlanArtifact)(withoutSignals))
    assert.throws(() =>
      Schema.decodeUnknownSync(PlanStoreV2.RunBinding)({
        ...binding,
        bindingVersion: 1
      })
    )
    assert.throws(() => Schema.decodeUnknownSync(PlanStoreV1.PlanArtifact)(artifact()))
  })

  it("reuses exact topology and dispatch-target invariants", () => {
    const invalid = PlanStoreV2.validateArtifact({
      ...artifact(),
      dispatchTargets: { unknown: { queue: "q", deploymentId: "build" } }
    })
    assert.isTrue(Result.isFailure(invalid))
    if (Result.isSuccess(invalid)) {
      throw new Error("Expected target-set rejection")
    }
    assert.strictEqual(invalid.failure.code, PlanStoreV1.ArtifactValidationCodes.TargetKeyMismatch)

    const nodePolicyMismatch = PlanStoreV2.validateArtifact({
      ...artifact(),
      activityPolicies: {
        unknown: {
          policyVersion: 1,
          retry: {
            retryVersion: 1,
            maximumAttempts: 1,
            classifierVersion: 1,
            retryOn: {
              encodedFailure: false,
              scheduleToStartTimeout: false,
              startToCloseTimeout: false
            },
            backoff: { _tag: "Fixed", delayMillis: 0 },
            jitter: { _tag: "None" }
          },
          timeouts: {
            scheduleToStart: { _tag: "Disabled" },
            startToClose: { _tag: "Disabled" },
            scheduleToClose: { _tag: "Disabled" }
          }
        }
      }
    })
    assert.isTrue(Result.isFailure(nodePolicyMismatch))
    if (Result.isSuccess(nodePolicyMismatch)) {
      throw new Error("Expected activity-policy key rejection")
    }
    assert.strictEqual(
      nodePolicyMismatch.failure.code,
      PlanStoreV2.ArtifactValidationCodes.PolicyKeyMismatch
    )

    const invalidSignalPolicy = PlanStoreV2.validateArtifact({
      ...artifact(),
      signalManifest: {
        ...artifact().signalManifest,
        inboxPolicy: {
          ...artifact().signalManifest.inboxPolicy,
          maxPendingCount: 1_001
        }
      }
    })
    assert.isTrue(Result.isFailure(invalidSignalPolicy))
    if (Result.isSuccess(invalidSignalPolicy)) {
      throw new Error("Expected signal-manifest rejection")
    }
    assert.strictEqual(
      invalidSignalPolicy.failure.code,
      PlanStoreV2.ArtifactValidationCodes.InvalidSchema
    )
  })

  it("rejects hostile artifact containers without invoking accessors", () => {
    let reads = 0
    const hostile = Object.defineProperty({}, "artifactVersion", {
      enumerable: true,
      get: () => {
        reads++
        return 2
      }
    })
    const admitted = PlanStoreV2.validateArtifact(hostile)
    assert.isTrue(Result.isFailure(admitted))
    assert.strictEqual(reads, 0)
  })
})
