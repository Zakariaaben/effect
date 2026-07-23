import { assert, describe, it } from "@effect/vitest"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as PlanStore from "../src/PlanStore.ts"

const digest = Schema.decodeUnknownSync(PlanStore.ArtifactDigest)(`sha256:${"a".repeat(64)}`)

const artifact: PlanStore.PlanArtifact = {
  artifactVersion: 1,
  executionProtocolVersion: 1,
  fingerprintDocument: {
    fingerprintVersion: 1,
    compilerSemanticVersion: "2",
    plan: {
      formatVersion: 1,
      id: "plan-1",
      revision: 0,
      definition: { id: "workflow-1", version: "1.0.0" },
      nodes: [],
      edges: []
    },
    topologicalOrder: [],
    stages: []
  },
  compiledFingerprint: digest,
  definitionDeploymentId: "definition-build-1",
  dispatchTargets: {}
}

describe("PlanStore", () => {
  it("defines strict tenant, artifact, target, and binding schemas", () => {
    const key = Schema.decodeUnknownSync(PlanStore.RunKey)({ tenantId: "tenant-1", runId: "run-1" })
    const decodedArtifact = Schema.decodeUnknownSync(PlanStore.PlanArtifact)(artifact)
    const binding = Schema.decodeUnknownSync(PlanStore.RunBinding)({
      bindingVersion: 1,
      executionProtocolVersion: 1,
      key,
      artifactDigest: digest,
      workflowIdentity: "document:42",
      requestId: "request-1",
      runStartedEventId: "event-1"
    })

    assert.deepStrictEqual(decodedArtifact, artifact)
    assert.deepStrictEqual(binding.key, key)
    const { executionProtocolVersion: _artifactProtocol, ...artifactWithoutProtocol } = artifact
    const { executionProtocolVersion: _bindingProtocol, ...bindingWithoutProtocol } = binding
    assert.throws(() => Schema.decodeUnknownSync(PlanStore.PlanArtifact)(artifactWithoutProtocol))
    assert.throws(() => Schema.decodeUnknownSync(PlanStore.RunBinding)(bindingWithoutProtocol))
    assert.throws(() =>
      Schema.decodeUnknownSync(PlanStore.PlanArtifact)({
        ...artifact,
        executionProtocolVersion: 2
      })
    )
    assert.throws(() => Schema.decodeUnknownSync(PlanStore.RunKey)({ ...key, extra: true }))
    assert.throws(() => Schema.decodeUnknownSync(PlanStore.PlanArtifact)({ ...artifact, extra: true }))
    assert.throws(() => Schema.decodeUnknownSync(PlanStore.DispatchTarget)({ queue: "q", deploymentId: "" }))
    assert.throws(() => Schema.decodeUnknownSync(Fingerprint.Digest)("sha256:not-a-digest"))
  })

  it("keeps artifacts reusable and run-specific data only in the binding", () => {
    const encoded = Schema.encodeSync(PlanStore.PlanArtifact)(artifact)

    assert.isFalse(Object.prototype.hasOwnProperty.call(encoded, "tenantId"))
    assert.isFalse(Object.prototype.hasOwnProperty.call(encoded, "runId"))
    assert.isFalse(Object.prototype.hasOwnProperty.call(encoded, "input"))
    assert.isFalse(Object.prototype.hasOwnProperty.call(encoded, "requestId"))
  })

  it("detaches artifacts and rejects duplicate or unpinned plan nodes", () => {
    const admitted = PlanStore.validateArtifact(artifact)
    assert.isTrue(Result.isSuccess(admitted))
    assert.notStrictEqual(admitted.success, artifact)
    assert.isTrue(Object.isFrozen(admitted.success))
    assert.isTrue(Object.isFrozen(admitted.success.fingerprintDocument.plan))

    const node = { id: "node-1", type: "task", version: "1", config: {} }
    const duplicate = PlanStore.validateArtifact({
      ...artifact,
      fingerprintDocument: {
        ...artifact.fingerprintDocument,
        plan: { ...artifact.fingerprintDocument.plan, nodes: [node, node] },
        topologicalOrder: ["node-1"],
        stages: [["node-1"]]
      },
      dispatchTargets: { "node-1": { queue: "q", deploymentId: "worker-1" } }
    })
    assert.isTrue(Result.isFailure(duplicate))
    assert.strictEqual(duplicate.failure.code, PlanStore.ArtifactValidationCodes.DuplicateNodeId)

    const unpinned = PlanStore.validateArtifact({
      ...artifact,
      fingerprintDocument: {
        ...artifact.fingerprintDocument,
        plan: { ...artifact.fingerprintDocument.plan, nodes: [node] },
        topologicalOrder: ["node-1"],
        stages: [["node-1"]]
      }
    })
    assert.isTrue(Result.isFailure(unpinned))
    assert.strictEqual(unpinned.failure.code, PlanStore.ArtifactValidationCodes.TargetKeyMismatch)
  })

  it("rejects hostile artifacts without invoking accessors", () => {
    let getterReads = 0
    const hostile = Object.defineProperty({}, "artifactVersion", {
      enumerable: true,
      get: () => {
        getterReads++
        return 1
      }
    })

    const result = PlanStore.validateArtifact(hostile)
    assert.isTrue(Result.isFailure(result))
    assert.strictEqual(result.failure.code, PlanStore.ArtifactValidationCodes.InvalidSchema)
    assert.strictEqual(getterReads, 0)
  })

  it("rejects topology that is incomplete, reversed, or inconsistent with its stages", () => {
    const first = { id: "first", type: "task", version: "1", config: {} }
    const second = { id: "second", type: "task", version: "1", config: {} }
    const targets = {
      first: { queue: "q", deploymentId: "worker-1" },
      second: { queue: "q", deploymentId: "worker-1" }
    }
    const withTopology = (topologicalOrder: ReadonlyArray<string>, stages: ReadonlyArray<ReadonlyArray<string>>) => ({
      ...artifact,
      fingerprintDocument: {
        ...artifact.fingerprintDocument,
        plan: {
          ...artifact.fingerprintDocument.plan,
          nodes: [first, second],
          edges: [{
            _tag: "ControlEdge" as const,
            id: "first-before-second",
            sourceNodeId: "first",
            targetNodeId: "second"
          }]
        },
        topologicalOrder,
        stages
      },
      dispatchTargets: targets
    })

    const incomplete = PlanStore.validateArtifact(withTopology(["first"], [["first"]]))
    assert.isTrue(Result.isFailure(incomplete))
    assert.strictEqual(incomplete.failure.code, PlanStore.ArtifactValidationCodes.InvalidTopology)

    const reversed = PlanStore.validateArtifact(withTopology(
      ["second", "first"],
      [["second"], ["first"]]
    ))
    assert.isTrue(Result.isFailure(reversed))
    assert.strictEqual(reversed.failure.code, PlanStore.ArtifactValidationCodes.InvalidTopology)

    const sameStage = PlanStore.validateArtifact(withTopology(
      ["first", "second"],
      [["first", "second"]]
    ))
    assert.isTrue(Result.isFailure(sameStage))
    assert.strictEqual(sameStage.failure.code, PlanStore.ArtifactValidationCodes.InvalidTopology)

    const inconsistentStages = PlanStore.validateArtifact(withTopology(
      ["first", "second"],
      [["second", "first"]]
    ))
    assert.isTrue(Result.isFailure(inconsistentStages))
    assert.strictEqual(inconsistentStages.failure.code, PlanStore.ArtifactValidationCodes.InvalidTopology)
  })

  it("exposes schema-backed tenant-aware lookup failures", () => {
    const missingRun = new PlanStore.RunBindingNotFound({ tenantId: "tenant-1", runId: "run-1" })
    const missingArtifact = new PlanStore.ArtifactNotFound({
      tenantId: "tenant-1",
      artifactDigest: digest
    })

    assert.strictEqual(missingRun._tag, "RunBindingNotFound")
    assert.strictEqual(missingArtifact._tag, "ArtifactNotFound")
    assert.throws(() =>
      Schema.decodeUnknownSync(PlanStore.RunBindingNotFound)({
        ...missingRun,
        unexpected: true
      })
    )
  })

  it("retains precise service effect signatures", () => {
    type GetForRun = PlanStore.PlanStore.Service["getForRun"]
    type GetArtifact = PlanStore.PlanStore.Service["getArtifact"]
    type _GetForRunSuccess = Types.Assert<
      Types.Equals<Effect.Success<ReturnType<GetForRun>>, PlanStore.BoundPlan>
    >
    type _GetArtifactSuccess = Types.Assert<
      Types.Equals<Effect.Success<ReturnType<GetArtifact>>, PlanStore.PlanArtifact>
    >
    const proofs: [_GetForRunSuccess, _GetArtifactSuccess] = [true, true]
    assert.deepStrictEqual(proofs, [true, true])
  })
})
