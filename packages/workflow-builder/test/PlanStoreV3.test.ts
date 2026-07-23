import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import type * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const sha256Crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideSha256 = Effect.provideService(Crypto.Crypto, sha256Crypto)

const step = Node.make("Step", {
  version: "1.0.0",
  config: Schema.Struct({ prefix: Schema.String }),
  inputs: {
    value: Port.input(Schema.String, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  },
  failure: Schema.String
})

const definition = Workflow.make("artifact-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, {
      contract: "example/text",
      fanOut: "single"
    })
  },
  outputs: {
    value: Port.input(Schema.String, {
      contract: "example/text",
      required: true
    })
  },
  nodes: Registry.make(step),
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 8,
    maxEdges: 8,
    maxFanIn: 4,
    maxFanOut: 4,
    maxDepth: 4
  })
})

const plan = {
  formatVersion: 1 as const,
  id: "artifact-plan",
  revision: 4,
  definition: {
    id: "artifact-workflow",
    version: "1.0.0"
  },
  nodes: [{
    id: "step",
    type: "Step",
    version: "1.0.0",
    config: { prefix: "verified:" }
  }],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "input-step",
      source: {
        _tag: "WorkflowInput" as const,
        input: "value"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId: "step",
        input: "value"
      }
    },
    {
      _tag: "DataEdge" as const,
      id: "step-output",
      source: {
        _tag: "NodeOutput" as const,
        nodeId: "step",
        output: "value"
      },
      target: {
        _tag: "WorkflowOutput" as const,
        output: "value"
      }
    }
  ]
}

const buildPin = (
  executableKind: PlanStoreV3.ExecutableKind,
  executableId: string,
  executableVersion: string,
  deploymentId: string
) =>
  Effect.gen(function*() {
    const buildDocument: PlanStoreV3.ExecutableBuildDocument = {
      buildDocumentVersion: 3,
      executableKind,
      executableId,
      executableVersion,
      deploymentId,
      catalogBuildId: `catalog:${deploymentId}`
    }
    const buildDigest = yield* DigestV3.executableBuild(buildDocument)
    return {
      deploymentId,
      buildDocument,
      buildDigest
    } satisfies PlanStoreV3.ExecutableBuildPin
  })

const makeCodec = (
  codecId: string,
  codecVersion: string,
  schema: Schema.Json
) =>
  Effect.gen(function*() {
    const key = PlanStoreV3.codecKey(codecId, codecVersion)
    const build = yield* buildPin(
      "Codec",
      codecId,
      codecVersion,
      `codec:${codecId}:${codecVersion}`
    )
    const encodedSchema: PlanStoreV3.EncodedSchemaDocument = {
      encodedSchemaVersion: 3,
      codecKey: key,
      codecId,
      codecVersion,
      format: "effect-schema-json/v1",
      schema
    }
    const schemaDigest = yield* DigestV3.encodedSchema(encodedSchema)
    return {
      codecPinVersion: 3,
      key,
      codecId,
      codecVersion,
      build,
      encodedSchema,
      schemaDigest
    } satisfies PlanStoreV3.CodecPin
  })

const policy = (
  classifierBuildDigest: ProtocolV3Wire.BuildDigest
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 3,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "default-classifier",
      classifierVersion: "1.0.0",
      buildDigest: classifierBuildDigest
    },
    failureIdentity: {
      _tag: "EffectTagged",
      identityContractVersion: 1,
      code: "OptionalString"
    },
    nonRetryableErrorTags: ["FatalError"],
    nonRetryableErrorCodes: ["E_FATAL"],
    backoff: {
      _tag: "Fixed",
      delayMillis: 1_000
    },
    jitter: { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: {
      _tag: "After",
      durationMillis: 30_000
    },
    startToClose: {
      _tag: "After",
      durationMillis: 60_000
    },
    scheduleToClose: { _tag: "Disabled" }
  }
})

interface Fixture {
  readonly artifact: PlanStoreV3.StaticDagArtifact
  readonly artifactDigest: ProtocolV3Wire.ArtifactDigest
}

const makeFixture = Effect.gen(function*() {
  const prepared = yield* CompilerV2.compile(definition, plan)
  const compiledFingerprint = yield* DigestV3.compiledPlan(
    prepared.fingerprintDocument
  )
  const definitionBuild = yield* buildPin(
    "WorkflowDefinition",
    "artifact-workflow",
    "1.0.0",
    "definition-deployment-1"
  )
  const handlerBuild = yield* buildPin(
    "NodeHandler",
    "Step",
    "1.0.0",
    "step-handler-deployment-1"
  )
  const classifierBuild = yield* buildPin(
    "RetryClassifier",
    "default-classifier",
    "1.0.0",
    "classifier-deployment-1"
  )
  const codecs = yield* Effect.all([
    makeCodec("config", "1.0.0", {
      type: "object",
      required: ["prefix"],
      properties: { prefix: { type: "string" } }
    }),
    makeCodec("failure", "1.0.0", { type: "string" }),
    makeCodec("text", "1.0.0", { type: "string" })
  ])
  codecs.sort((left, right) => left.key < right.key ? -1 : 1)
  const textCodecKey = PlanStoreV3.codecKey("text", "1.0.0")
  const inputDocument = {
    boundaryContractVersion: 3 as const,
    direction: "Input" as const,
    definition: {
      id: "artifact-workflow",
      version: "1.0.0"
    },
    ports: [{
      name: "value",
      contract: "example/text",
      fanOut: "single" as const,
      codecKey: textCodecKey
    }]
  }
  const outputDocument = {
    boundaryContractVersion: 3 as const,
    direction: "Output" as const,
    definition: {
      id: "artifact-workflow",
      version: "1.0.0"
    },
    ports: [{
      name: "value",
      contract: "example/text",
      cardinality: "one" as const,
      required: true,
      codecKey: textCodecKey
    }]
  }
  const inputDigest = yield* DigestV3.boundaryContract(inputDocument)
  const outputDigest = yield* DigestV3.boundaryContract(outputDocument)
  const nodeKey = PlanStoreV3.nodeDefinitionKey("Step", "1.0.0")
  const classifierPinKey = PlanStoreV3.classifierKey(
    "default-classifier",
    "1.0.0"
  )
  const artifact: PlanStoreV3.StaticDagArtifact = {
    artifactVersion: 3,
    artifactKind: "StaticDag",
    executionProtocolVersion: 3,
    fingerprintDocument: prepared.fingerprintDocument,
    compiledFingerprint,
    workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity("artifact-workflow"),
    definition: {
      id: "artifact-workflow",
      version: "1.0.0",
      build: definitionBuild
    },
    inputBoundary: {
      document: inputDocument,
      digest: inputDigest
    },
    outputBoundary: {
      document: outputDocument,
      digest: outputDigest
    },
    nodeDefinitions: [{
      manifestVersion: 3,
      key: nodeKey,
      nodeType: "Step",
      nodeVersion: "1.0.0",
      configCodecKey: PlanStoreV3.codecKey("config", "1.0.0"),
      failureCodecKey: PlanStoreV3.codecKey("failure", "1.0.0"),
      inputs: [{
        name: "value",
        contract: "example/text",
        cardinality: "one",
        required: true,
        codecKey: textCodecKey
      }],
      outputs: [{
        name: "value",
        contract: "example/text",
        fanOut: "multiple",
        codecKey: textCodecKey
      }]
    }],
    codecs,
    policyExecutableBuilds: [{
      key: classifierPinKey,
      classifierId: "default-classifier",
      classifierVersion: "1.0.0",
      build: classifierBuild
    }],
    nodeBindings: [{
      bindingVersion: 3,
      nodeId: "step",
      nodeType: "Step",
      nodeVersion: "1.0.0",
      nodeDefinitionKey: nodeKey,
      queue: "activity-queue",
      handlerBuild,
      activityPolicy: policy(classifierBuild.buildDigest)
    }]
  }
  const artifactDigest = yield* DigestV3.artifact(artifact)
  return { artifact, artifactDigest } satisfies Fixture
})

const clone = <A>(value: A): A => JSON.parse(JSON.stringify(value))

const duplicateDataEdge = (
  artifact: PlanStoreV3.StaticDagArtifact,
  edgeId: "input-step" | "step-output",
  duplicateId: string,
  orders?: readonly [number, number]
): void => {
  const semanticEdge = artifact.fingerprintDocument.semanticPlan.dataEdges
    .find((edge) => edge.id === edgeId)!
  const programEdge = artifact.fingerprintDocument.program.dataEdges
    .find((edge) => edge.id === edgeId)!
  if (orders !== undefined) {
    Reflect.set(semanticEdge, "order", orders[0])
    Reflect.set(programEdge, "order", orders[0])
  }
  const semanticDuplicate = {
    ...clone(semanticEdge),
    id: duplicateId,
    ...(orders === undefined ? undefined : { order: orders[1] })
  }
  const programDuplicate = {
    ...clone(programEdge),
    id: duplicateId,
    ...(orders === undefined ? undefined : { order: orders[1] })
  }
  Reflect.set(
    artifact.fingerprintDocument.semanticPlan,
    "dataEdges",
    [...artifact.fingerprintDocument.semanticPlan.dataEdges, semanticDuplicate]
      .sort((left, right) => left.id < right.id ? -1 : 1)
  )
  Reflect.set(
    artifact.fingerprintDocument.program,
    "dataEdges",
    [...artifact.fingerprintDocument.program.dataEdges, programDuplicate]
      .sort((left, right) => left.id < right.id ? -1 : 1)
  )
  const node = artifact.fingerprintDocument.program.nodes.find(
    (candidate) => candidate.id === "step"
  )!
  const property = edgeId === "input-step"
    ? "incomingEdgeIds"
    : "outgoingEdgeIds"
  Reflect.set(
    node,
    property,
    [...node[property], duplicateId].sort()
  )
}

const removeDataEdge = (
  artifact: PlanStoreV3.StaticDagArtifact,
  edgeId: "input-step" | "step-output"
): void => {
  Reflect.set(
    artifact.fingerprintDocument.semanticPlan,
    "dataEdges",
    artifact.fingerprintDocument.semanticPlan.dataEdges.filter(
      (edge) => edge.id !== edgeId
    )
  )
  Reflect.set(
    artifact.fingerprintDocument.program,
    "dataEdges",
    artifact.fingerprintDocument.program.dataEdges.filter(
      (edge) => edge.id !== edgeId
    )
  )
  const node = artifact.fingerprintDocument.program.nodes.find(
    (candidate) => candidate.id === "step"
  )!
  const property = edgeId === "input-step"
    ? "incomingEdgeIds"
    : "outgoingEdgeIds"
  Reflect.set(
    node,
    property,
    node[property].filter((candidate) => candidate !== edgeId)
  )
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("Expected failure")
  return result.failure
}

describe("PlanStoreV3", () => {
  it.effect("validates and cryptographically verifies a canonical immutable artifact", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const validated = success(
        PlanStoreV3.validateArtifact(fixture.artifact)
      )
      const verified = yield* PlanStoreV3.verifyArtifact(
        fixture.artifact,
        fixture.artifactDigest
      )

      assert.strictEqual(verified.artifactDigest, fixture.artifactDigest)
      assert.deepStrictEqual(verified.artifact, validated)
      assert.isTrue(PlanStoreV3.isVerifiedArtifact(verified))
      assert.isFalse(PlanStoreV3.isVerifiedArtifact({ ...verified }))
      assert.isFalse(PlanStoreV3.isVerifiedArtifact(new Proxy(verified, {})))
      assert.isTrue(Object.isFrozen(verified))
      assert.isTrue(Object.isFrozen(verified.artifact))
      assert.isTrue(Object.isFrozen(verified.artifact.codecs))

      const withoutExpectation = yield* PlanStoreV3.verifyArtifact(
        fixture.artifact
      )
      assert.strictEqual(
        withoutExpectation.artifactDigest,
        fixture.artifactDigest
      )
    }).pipe(provideSha256))

  it.effect("derives a replay-complete child target only from verified provenance", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const verified = yield* PlanStoreV3.verifyArtifact(
        fixture.artifact,
        fixture.artifactDigest
      )
      const target = success(PlanStoreV3.deriveChildTarget(verified, {
        closePolicy: {
          closePolicyVersion: 3,
          onParentFailure: "CancelAndWait",
          onParentCancellation: "RequestCancel"
        },
        maxLineageDepth: 16
      }))

      assert.strictEqual(target.artifactDigest, fixture.artifactDigest)
      assert.strictEqual(target.plan.id, "artifact-plan")
      assert.strictEqual(target.plan.revision, 4)
      assert.strictEqual(
        target.definition.deploymentId,
        "definition-deployment-1"
      )
      assert.strictEqual(
        target.inputContractDigest,
        fixture.artifact.inputBoundary.digest
      )
      assert.strictEqual(target.maxLineageDepth, 16)
      assert.isTrue(Object.isFrozen(target))

      const forged = failure(PlanStoreV3.deriveChildTarget(
        { ...verified },
        {
          closePolicy: {
            closePolicyVersion: 3,
            onParentFailure: "Abandon",
            onParentCancellation: "Abandon"
          },
          maxLineageDepth: 1
        }
      ))
      assert.strictEqual(
        forged.code,
        PlanStoreV3.ChildTargetDerivationCodes.UnverifiedArtifact
      )
      assert.strictEqual(
        failure(PlanStoreV3.deriveChildTarget(verified, {
          closePolicy: {
            closePolicyVersion: 3,
            onParentFailure: "Abandon",
            onParentCancellation: "Abandon"
          },
          maxLineageDepth: 65
        })).code,
        PlanStoreV3.ChildTargetDerivationCodes.InvalidOptions
      )
    }).pipe(provideSha256))

  it.effect("detects every pinned digest role before trusting the artifact digest", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const wrongDigest = `sha256:${"f".repeat(64)}`
      const cases: ReadonlyArray<{
        readonly role: PlanStoreV3.VerifiedDigestRole
        readonly mutate: (
          artifact: PlanStoreV3.StaticDagArtifact
        ) => void
      }> = [
        {
          role: "CompiledPlan",
          mutate: (artifact) => {
            Reflect.set(artifact, "compiledFingerprint", wrongDigest)
          }
        },
        {
          role: "InputBoundary",
          mutate: (artifact) => {
            Reflect.set(artifact.inputBoundary, "digest", wrongDigest)
          }
        },
        {
          role: "OutputBoundary",
          mutate: (artifact) => {
            Reflect.set(artifact.outputBoundary, "digest", wrongDigest)
          }
        },
        {
          role: "DefinitionBuild",
          mutate: (artifact) => {
            Reflect.set(artifact.definition.build, "buildDigest", wrongDigest)
          }
        },
        {
          role: "HandlerBuild",
          mutate: (artifact) => {
            Reflect.set(
              artifact.nodeBindings[0]!.handlerBuild,
              "buildDigest",
              wrongDigest
            )
          }
        },
        {
          role: "CodecBuild",
          mutate: (artifact) => {
            Reflect.set(artifact.codecs[0]!.build, "buildDigest", wrongDigest)
          }
        },
        {
          role: "EncodedSchema",
          mutate: (artifact) => {
            Reflect.set(artifact.codecs[0]!, "schemaDigest", wrongDigest)
          }
        },
        {
          role: "PolicyExecutableBuild",
          mutate: (artifact) => {
            Reflect.set(
              artifact.policyExecutableBuilds[0]!.build,
              "buildDigest",
              wrongDigest
            )
            Reflect.set(
              artifact.nodeBindings[0]!.activityPolicy.retry.classifier,
              "buildDigest",
              wrongDigest
            )
          }
        }
      ]

      for (const testCase of cases) {
        const artifact = clone(fixture.artifact)
        testCase.mutate(artifact)
        const result = yield* PlanStoreV3.verifyArtifact(
          artifact,
          fixture.artifactDigest
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        assert.strictEqual(result.failure._tag, "ArtifactDigestMismatch")
        if (result.failure._tag === "ArtifactDigestMismatch") {
          assert.strictEqual(result.failure.role, testCase.role)
        }
      }

      const artifactDigestMismatch = yield* PlanStoreV3.verifyArtifact(
        fixture.artifact,
        wrongDigest
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(artifactDigestMismatch))
      assert.strictEqual(
        artifactDigestMismatch.failure._tag,
        "ArtifactDigestMismatch"
      )
      if (
        artifactDigestMismatch.failure._tag === "ArtifactDigestMismatch"
      ) {
        assert.strictEqual(artifactDigestMismatch.failure.role, "Artifact")
      }
    }).pipe(provideSha256))

  it.effect("verifies digest domains in the documented fixed order", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const domains: Array<string> = []
      const recordingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) =>
          Effect.sync(() => {
            const document = JSON.parse(new TextDecoder().decode(data)) as {
              readonly domain: string
            }
            domains.push(document.domain)
            return new Uint8Array(createHash("sha256").update(data).digest())
          })
      })

      yield* PlanStoreV3.verifyArtifact(
        fixture.artifact,
        fixture.artifactDigest
      ).pipe(Effect.provideService(Crypto.Crypto, recordingCrypto))

      assert.deepStrictEqual(domains, [
        DigestV3.Domains.CompiledPlan,
        DigestV3.Domains.BoundaryContract,
        DigestV3.Domains.BoundaryContract,
        DigestV3.Domains.ExecutableBuild,
        DigestV3.Domains.ExecutableBuild,
        DigestV3.Domains.ExecutableBuild,
        DigestV3.Domains.EncodedSchema,
        DigestV3.Domains.ExecutableBuild,
        DigestV3.Domains.EncodedSchema,
        DigestV3.Domains.ExecutableBuild,
        DigestV3.Domains.EncodedSchema,
        DigestV3.Domains.ExecutableBuild,
        DigestV3.Domains.Artifact
      ])
    }).pipe(provideSha256))

  it.effect("reports canonical, coverage, and relationship failures with stable codes", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const cases: ReadonlyArray<{
        readonly code: PlanStoreV3.ArtifactValidationCode
        readonly mutate: (
          artifact: PlanStoreV3.StaticDagArtifact
        ) => void
      }> = [
        {
          code: PlanStoreV3.ArtifactValidationCodes.NonCanonical,
          mutate: (artifact) => {
            Reflect.set(artifact, "codecs", [...artifact.codecs].reverse())
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.NodeBindingMismatch,
          mutate: (artifact) => {
            Reflect.set(artifact, "nodeBindings", [])
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.DefinitionMismatch,
          mutate: (artifact) => {
            Reflect.set(artifact.definition, "id", "other-workflow")
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.BoundaryMismatch,
          mutate: (artifact) => {
            Reflect.set(
              artifact.inputBoundary.document.ports[0]!,
              "contract",
              "example/other"
            )
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.CodecCoverageMismatch,
          mutate: (artifact) => {
            Reflect.set(artifact, "codecs", artifact.codecs.slice(1))
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.NodeCoverageMismatch,
          mutate: (artifact) => {
            Reflect.set(
              artifact.nodeDefinitions[0]!.outputs[0]!,
              "contract",
              "example/other"
            )
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.InvalidCompilerDocument,
          mutate: (artifact) => {
            Reflect.set(
              artifact.fingerprintDocument.program,
              "topologicalOrder",
              []
            )
          }
        },
        {
          code: PlanStoreV3.ArtifactValidationCodes.ActivityPolicyMismatch,
          mutate: (artifact) => {
            Reflect.set(artifact, "policyExecutableBuilds", [])
          }
        }
      ]

      for (const testCase of cases) {
        const artifact = clone(fixture.artifact)
        testCase.mutate(artifact)
        const error = failure(PlanStoreV3.validateArtifact(artifact))
        assert.strictEqual(error.code, testCase.code)
      }

      const wrongKind = clone(fixture.artifact)
      Reflect.set(wrongKind, "artifactKind", "BpmnExecutable")
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(wrongKind)).code,
        PlanStoreV3.ArtifactValidationCodes.NonV3StaticDagArtifact
      )
    }).pipe(provideSha256))

  it.effect("re-enforces required, cardinality, order, and fan-out graph invariants", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture

      const missingNodeInput = clone(fixture.artifact)
      removeDataEdge(missingNodeInput, "input-step")
      success(CompilerV2.validateFingerprintDocument(
        missingNodeInput.fingerprintDocument
      ))
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(missingNodeInput)).code,
        PlanStoreV3.ArtifactValidationCodes.NodeCoverageMismatch
      )

      const oneNodeInput = clone(fixture.artifact)
      duplicateDataEdge(oneNodeInput, "input-step", "input-step-2")
      success(CompilerV2.validateFingerprintDocument(
        oneNodeInput.fingerprintDocument
      ))
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(oneNodeInput)).code,
        PlanStoreV3.ArtifactValidationCodes.NodeCoverageMismatch
      )

      const unorderedManyNodeInput = clone(fixture.artifact)
      duplicateDataEdge(
        unorderedManyNodeInput,
        "input-step",
        "input-step-2"
      )
      Reflect.set(
        unorderedManyNodeInput.nodeDefinitions[0]!.inputs[0]!,
        "cardinality",
        "many"
      )
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(unorderedManyNodeInput)).code,
        PlanStoreV3.ArtifactValidationCodes.NodeCoverageMismatch
      )

      const singleNodeOutput = clone(fixture.artifact)
      duplicateDataEdge(singleNodeOutput, "step-output", "step-output-2")
      Reflect.set(
        singleNodeOutput.nodeDefinitions[0]!.outputs[0]!,
        "fanOut",
        "single"
      )
      success(CompilerV2.validateFingerprintDocument(
        singleNodeOutput.fingerprintDocument
      ))
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(singleNodeOutput)).code,
        PlanStoreV3.ArtifactValidationCodes.NodeCoverageMismatch
      )

      const singleWorkflowInput = clone(fixture.artifact)
      duplicateDataEdge(
        singleWorkflowInput,
        "input-step",
        "input-step-2",
        [0, 1]
      )
      Reflect.set(
        singleWorkflowInput.nodeDefinitions[0]!.inputs[0]!,
        "cardinality",
        "many"
      )
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(singleWorkflowInput)).code,
        PlanStoreV3.ArtifactValidationCodes.BoundaryMismatch
      )

      const oneWorkflowOutput = clone(fixture.artifact)
      duplicateDataEdge(
        oneWorkflowOutput,
        "step-output",
        "step-output-2"
      )
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(oneWorkflowOutput)).code,
        PlanStoreV3.ArtifactValidationCodes.BoundaryMismatch
      )

      const unorderedManyWorkflowOutput = clone(fixture.artifact)
      duplicateDataEdge(
        unorderedManyWorkflowOutput,
        "step-output",
        "step-output-2"
      )
      Reflect.set(
        unorderedManyWorkflowOutput.outputBoundary.document.ports[0]!,
        "cardinality",
        "many"
      )
      assert.strictEqual(
        failure(
          PlanStoreV3.validateArtifact(unorderedManyWorkflowOutput)
        ).code,
        PlanStoreV3.ArtifactValidationCodes.BoundaryMismatch
      )

      const missingWorkflowOutput = clone(fixture.artifact)
      removeDataEdge(missingWorkflowOutput, "step-output")
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(missingWorkflowOutput)).code,
        PlanStoreV3.ArtifactValidationCodes.BoundaryMismatch
      )
    }).pipe(provideSha256))

  it.effect("rejects getters, hostile proxies, and excess properties without escaping validation", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      let getterReads = 0
      const accessor = Object.defineProperty({}, "artifactVersion", {
        enumerable: true,
        get: () => {
          getterReads++
          return 3
        }
      })
      const hostileProxy = new Proxy({}, {
        getPrototypeOf: () => {
          throw new Error("hostile proxy trap")
        }
      })
      const excess = {
        ...fixture.artifact,
        unexpected: true
      }
      const unpairedCompilerDefinition = clone(fixture.artifact)
      Reflect.set(
        unpairedCompilerDefinition.fingerprintDocument.semanticPlan.definition,
        "id",
        "\ud800"
      )

      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(accessor)).code,
        PlanStoreV3.ArtifactValidationCodes.InvalidJson
      )
      assert.strictEqual(getterReads, 0)
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(hostileProxy)).code,
        PlanStoreV3.ArtifactValidationCodes.InvalidJson
      )
      assert.strictEqual(
        failure(PlanStoreV3.validateArtifact(excess)).code,
        PlanStoreV3.ArtifactValidationCodes.InvalidSchema
      )
      assert.strictEqual(
        failure(
          PlanStoreV3.validateArtifact(unpairedCompilerDefinition)
        ).code,
        PlanStoreV3.ArtifactValidationCodes.InvalidSchema
      )
    }).pipe(provideSha256))

  it.effect("preserves cryptographic failures and rejects malformed expected digests", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const failingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "BadResource",
            module: "test",
            method: "digest",
            description: "unavailable"
          }))
      })
      const failedCrypto = yield* PlanStoreV3.verifyArtifact(
        fixture.artifact
      ).pipe(
        Effect.provideService(Crypto.Crypto, failingCrypto),
        Effect.result
      )
      assert.isTrue(Result.isFailure(failedCrypto))
      assert.strictEqual(failedCrypto.failure._tag, "DigestCryptoError")
      if (failedCrypto.failure._tag === "DigestCryptoError") {
        assert.strictEqual(
          failedCrypto.failure.domain,
          DigestV3.Domains.CompiledPlan
        )
      }

      const invalidExpected = yield* PlanStoreV3.verifyArtifact(
        fixture.artifact,
        "sha256:not-canonical"
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalidExpected))
      assert.strictEqual(invalidExpected.failure._tag, "ArtifactValidationError")
      if (invalidExpected.failure._tag === "ArtifactValidationError") {
        assert.strictEqual(
          invalidExpected.failure.code,
          PlanStoreV3.ArtifactValidationCodes.InvalidExpectedArtifactDigest
        )
      }
    }).pipe(provideSha256))

  it.effect("defines independent strict V3 run bindings, bound plans, and store errors", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const key = Schema.decodeUnknownSync(PlanStoreV3.RunKey)({
        tenantId: "tenant-1",
        runId: "run-1"
      })
      const binding = Schema.decodeUnknownSync(PlanStoreV3.RunBinding)({
        bindingVersion: 3,
        executionProtocolVersion: 3,
        key,
        artifactDigest: fixture.artifactDigest,
        workflowIdentity: "document:42",
        requestId: "request-1",
        runStartedEventId: "event-1"
      })
      const bound = Schema.decodeUnknownSync(PlanStoreV3.BoundPlan)({
        binding,
        artifact: fixture.artifact
      })

      assert.deepStrictEqual(bound.binding, binding)
      assert.throws(() =>
        Schema.decodeUnknownSync(PlanStoreV3.RunBinding)({
          ...binding,
          bindingVersion: 2
        })
      )
      assert.throws(() =>
        Schema.decodeUnknownSync(PlanStoreV3.BoundPlan)({
          binding,
          artifact: fixture.artifact,
          unexpected: true
        })
      )
      assert.strictEqual(
        new PlanStoreV3.RunBindingNotFound({
          tenantId: "tenant-1",
          runId: "run-1"
        })._tag,
        "RunBindingNotFound"
      )
      assert.strictEqual(
        new PlanStoreV3.ArtifactNotFound({
          tenantId: "tenant-1",
          artifactDigest: fixture.artifactDigest
        })._tag,
        "ArtifactNotFound"
      )
      assert.strictEqual(
        new PlanStoreV3.PlanStoreFailure({
          operation: "getArtifact",
          message: "unavailable"
        })._tag,
        "PlanStoreFailure"
      )
    }).pipe(provideSha256))
})
