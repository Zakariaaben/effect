import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import type * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as SemanticOccurrenceV3 from "../src/SemanticOccurrenceV3.ts"
import * as SemanticOperationV3 from "../src/SemanticOperationV3.ts"
import * as Workflow from "../src/Workflow.ts"

const sha256Crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideSha256 = Effect.provideService(Crypto.Crypto, sha256Crypto)

class CapturedService extends Context.Service<
  CapturedService,
  { readonly value: string }
>()("SemanticExecutableRegistryV3Test/CapturedService") {}

const textSchema = Schema.String
const stepConfigSchema = Schema.Struct({ prefix: textSchema })
const stepFailureSchema = Schema.String

const step = Node.make("Step", {
  version: "1.0.0",
  config: stepConfigSchema,
  inputs: {
    value: Port.input(textSchema, { contract: "example/text" }),
    optionalOne: Port.input(textSchema, {
      contract: "example/text",
      required: false
    }),
    requiredMany: Port.input(textSchema, {
      contract: "example/text",
      cardinality: "many",
      required: true
    }),
    optionalMany: Port.input(textSchema, {
      contract: "example/text",
      cardinality: "many",
      required: false
    })
  },
  outputs: {
    value: Port.output(textSchema, { contract: "example/text" })
  },
  failure: stepFailureSchema
})

const nodeRegistry = Registry.make(step)

const definition = Workflow.make("artifact-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(textSchema, {
      contract: "example/text",
      fanOut: "single"
    }),
    values: Port.output(textSchema, {
      contract: "example/text",
      fanOut: "single"
    })
  },
  outputs: {
    value: Port.input(textSchema, {
      contract: "example/text",
      required: true
    })
  },
  nodes: nodeRegistry,
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
      id: "input-step-many",
      source: {
        _tag: "WorkflowInput" as const,
        input: "values"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId: "step",
        input: "requiredMany"
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
  deploymentId: string,
  catalogBuildId = `catalog:${deploymentId}`
) =>
  Effect.gen(function*() {
    const buildDocument: PlanStoreV3.ExecutableBuildDocument = {
      buildDocumentVersion: 3,
      executableKind,
      executableId,
      executableVersion,
      deploymentId,
      catalogBuildId
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

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("Expected failure")
  return result.failure
}

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly deploymentCatalog: Deployment.DeploymentCatalog["Service"]
  readonly deployed: DeploymentHandlers.DeploymentHandlerRegistry["Service"]
  readonly workflow: Executables.WorkflowDefinitionExecutable
  readonly node: Executables.NodeHandlerExecutable
  readonly codecs: ReadonlyArray<Executables.CodecExecutable>
  readonly classifier: Executables.RetryClassifierExecutable
  readonly entries: ReadonlyArray<Executables.ExecutableEntry>
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
    ports: [
      {
        name: "value",
        contract: "example/text",
        fanOut: "single" as const,
        codecKey: textCodecKey
      },
      {
        name: "values",
        contract: "example/text",
        fanOut: "single" as const,
        codecKey: textCodecKey
      }
    ]
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
      inputs: [
        {
          name: "optionalMany",
          contract: "example/text",
          cardinality: "many",
          required: false,
          codecKey: textCodecKey
        },
        {
          name: "optionalOne",
          contract: "example/text",
          cardinality: "one",
          required: false,
          codecKey: textCodecKey
        },
        {
          name: "requiredMany",
          contract: "example/text",
          cardinality: "many",
          required: true,
          codecKey: textCodecKey
        },
        {
          name: "value",
          contract: "example/text",
          cardinality: "one",
          required: true,
          codecKey: textCodecKey
        }
      ],
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
  const verified = yield* PlanStoreV3.verifyArtifact(
    artifact,
    artifactDigest
  )

  const handlers = yield* nodeRegistry.toHandlers(nodeRegistry.of({
    "Step@1.0.0": ({ config, inputs }) => Effect.succeed({ value: `${config.prefix}${inputs.value}` })
  }))
  const deploymentCatalog = yield* Deployment.makeMemory({
    workflowDefinitions: [
      Deployment.workflowDefinition(
        "definition-deployment-1",
        definition
      )
    ],
    handlerDefinitions: [
      Deployment.handlerDefinition(
        "step-handler-deployment-1",
        step
      )
    ]
  })
  const deployed = yield* DeploymentHandlers.make([
    DeploymentHandlers.handlerDeployment(
      "step-handler-deployment-1",
      handlers
    )
  ]).pipe(
    Effect.provideService(
      Deployment.DeploymentCatalog,
      deploymentCatalog
    )
  )

  const workflow = yield* Executables.workflowDefinition(
    deploymentCatalog,
    verified.artifact.definition.build
  )
  const node = success(Executables.nodeHandler(
    deployed,
    verified.artifact.nodeBindings[0]!.handlerBuild
  ))
  const runtimeSchemas: Readonly<Record<string, Schema.Top>> = {
    config: stepConfigSchema,
    failure: stepFailureSchema,
    text: textSchema
  }
  const codecEntries = yield* Effect.forEach(
    verified.artifact.codecs,
    (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
  )
  const classifier = yield* Executables.retryClassifier(
    verified.artifact.policyExecutableBuilds[0]!,
    () =>
      Effect.succeed({
        _tag: "Retryable" as const,
        classificationVersion: 1 as const
      })
  )
  const entries = Object.freeze([
    workflow,
    node,
    ...codecEntries,
    classifier
  ])
  return {
    verified,
    deploymentCatalog,
    deployed,
    workflow,
    node,
    codecs: codecEntries,
    classifier,
    entries
  } satisfies Fixture
})

describe("SemanticExecutableRegistryV3", () => {
  it.effect("atomically resolves every exact artifact executable without caching", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const registry = yield* Executables.make(fixture.entries)
      const first = yield* registry.resolveArtifact(fixture.verified)
      const second = yield* registry.resolveArtifact(fixture.verified)

      assert.isTrue(Executables.isSemanticExecutableRegistry(registry))
      assert.isFalse(Executables.isSemanticExecutableRegistry({ ...registry }))
      assert.strictEqual(registry.size, 6)
      assert.isTrue(Executables.isResolvedArtifactExecutables(first))
      assert.isFalse(
        Executables.isResolvedArtifactExecutables({ ...first })
      )
      assert.notStrictEqual(first, second)
      assert.strictEqual(first.verifiedArtifact, fixture.verified)
      assert.strictEqual(
        first.artifactDigest,
        fixture.verified.artifactDigest
      )
      assert.strictEqual(first.nodeHandlers.size, 1)
      assert.strictEqual(first.codecs.size, 3)
      assert.strictEqual(first.retryClassifiers.size, 1)
      assert.strictEqual(first.workflowExecutable, fixture.workflow)
      assert.strictEqual(first.workflowDefinition, definition)
      assert.strictEqual(fixture.workflow.definition, definition)
      assert.deepStrictEqual(
        fixture.workflow.build,
        fixture.verified.artifact.definition.build
      )
      assert.strictEqual(
        first.nodeHandlers.get("step")!.executable,
        fixture.node
      )
      assert.strictEqual(
        first.nodeHandlers.get("step")!.definition,
        step
      )
      assert.strictEqual(
        first.retryClassifiers.values().next().value,
        fixture.classifier
      )
      assert.isUndefined(
        (first.codecs as unknown as { readonly set?: unknown }).set
      )
      assert.isTrue(Object.isFrozen(first))
      assert.isTrue(Object.isFrozen(first.nodeHandlers.get("step")))
    }).pipe(provideSha256))

  it.effect("retains the exact manifest codecs and immutable port maps in each node contract", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const registry = yield* Executables.make(fixture.entries)
      const resolved = yield* registry.resolveArtifact(fixture.verified)
      const node = resolved.nodeHandlers.get("step")!
      const contract = node.contract
      const manifest = fixture.verified.artifact.nodeDefinitions[0]!
      const config = fixture.codecs.find(
        (entry) => entry.pin.codecId === "config"
      )!
      const failureCodec = fixture.codecs.find(
        (entry) => entry.pin.codecId === "failure"
      )!
      const text = fixture.codecs.find(
        (entry) => entry.pin.codecId === "text"
      )!

      assert.strictEqual(contract.manifest, manifest)
      assert.strictEqual(contract.config, config)
      assert.strictEqual(contract.failure, failureCodec)
      assert.deepStrictEqual(
        Array.from(contract.inputs.keys()),
        manifest.inputs.map((port) => port.name)
      )
      assert.deepStrictEqual(
        Array.from(contract.outputs.keys()),
        manifest.outputs.map((port) => port.name)
      )
      for (const port of manifest.inputs) {
        const input = contract.inputs.get(port.name)!
        assert.strictEqual(input.manifest, port)
        assert.strictEqual(input.codec, text)
        assert.isTrue(Object.isFrozen(input))
      }
      for (const port of manifest.outputs) {
        const output = contract.outputs.get(port.name)!
        assert.strictEqual(output.manifest, port)
        assert.strictEqual(output.codec, text)
        assert.isTrue(Object.isFrozen(output))
      }
      assert.isUndefined(
        (contract.inputs as unknown as { readonly set?: unknown }).set
      )
      assert.isUndefined(
        (contract.outputs as unknown as { readonly set?: unknown }).set
      )
      assert.isTrue(Object.isFrozen(contract))
      assert.strictEqual(node.definition.configSchema, contract.config.schema)
      assert.strictEqual(node.definition.failureSchema, contract.failure.schema)
    }).pipe(provideSha256))

  it.effect("builds strict aggregate input schemas for every input cardinality", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const registry = yield* Executables.make(fixture.entries)
      const resolved = yield* registry.resolveArtifact(fixture.verified)
      const schema = resolved.nodeHandlers.get("step")!.contract.inputSchema
      const decode = Schema.decodeUnknownResult(schema)

      const omittedOptionalOne = success(decode({
        value: "one",
        requiredMany: ["first"],
        optionalMany: []
      })) as {
        readonly value: string
        readonly optionalOne: Option.Option<string>
        readonly requiredMany: ReadonlyArray<string>
        readonly optionalMany: ReadonlyArray<string>
      }
      assert.strictEqual(omittedOptionalOne.value, "one")
      assert.deepStrictEqual(omittedOptionalOne.optionalOne, Option.none())
      assert.deepStrictEqual(omittedOptionalOne.requiredMany, ["first"])
      assert.deepStrictEqual(omittedOptionalOne.optionalMany, [])

      const presentOptionalOne = success(decode({
        value: "one",
        optionalOne: "present",
        requiredMany: ["first", "second"],
        optionalMany: ["optional"]
      })) as {
        readonly optionalOne: Option.Option<string>
      }
      assert.deepStrictEqual(
        presentOptionalOne.optionalOne,
        Option.some("present")
      )

      assert.isTrue(Result.isFailure(decode({
        requiredMany: ["first"],
        optionalMany: []
      })))
      assert.isTrue(Result.isFailure(decode({
        value: "one",
        requiredMany: [],
        optionalMany: []
      })))
      assert.isTrue(Result.isFailure(decode({
        value: "one",
        optionalMany: []
      })))
      assert.isTrue(Result.isFailure(decode({
        value: "one",
        requiredMany: ["first"]
      })))
      assert.isTrue(Result.isFailure(decode({
        value: "one",
        requiredMany: ["first"],
        optionalMany: [],
        excess: true
      })))
    }).pipe(provideSha256))

  it.effect("builds a strict output aggregate requiring every declared output", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const registry = yield* Executables.make(fixture.entries)
      const resolved = yield* registry.resolveArtifact(fixture.verified)
      const schema = resolved.nodeHandlers.get("step")!.contract.successSchema
      const decode = Schema.decodeUnknownResult(schema)

      assert.deepStrictEqual(success(decode({ value: "done" })), {
        value: "done"
      })
      assert.isTrue(Result.isFailure(decode({})))
      assert.isTrue(Result.isFailure(decode({
        value: "done",
        excess: true
      })))
    }).pipe(provideSha256))

  it.effect("rejects conflicting codec services while preserving identical service identity", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const config = fixture.codecs.find(
        (entry) => entry.pin.codecId === "config"
      )!
      const text = fixture.codecs.find(
        (entry) => entry.pin.codecId === "text"
      )!
      const left = { value: "left" }
      const right = { value: "right" }
      const conflictingConfig = yield* Executables.codec(
        config.pin,
        stepConfigSchema
      ).pipe(Effect.provideService(CapturedService, left))
      const conflictingText = yield* Executables.codec(
        text.pin,
        textSchema
      ).pipe(Effect.provideService(CapturedService, right))
      const conflictingRegistry = yield* Executables.make(
        fixture.entries.map((entry) =>
          entry === config
            ? conflictingConfig
            : entry === text
            ? conflictingText
            : entry
        )
      )
      const conflict = yield* conflictingRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(
        conflict.code,
        Executables.ErrorCodes.ConflictingExecutable
      )
      assert.strictEqual(conflict.executableKind, "Codec")
      assert.strictEqual(conflict.key, text.pin.key)
      assert.strictEqual(conflict.nodeId, "step")
      assert.include(conflict.message, CapturedService.key)

      const shared = { value: "shared" }
      const sharedConfig = yield* Executables.codec(
        config.pin,
        stepConfigSchema
      ).pipe(Effect.provideService(CapturedService, shared))
      const sharedText = yield* Executables.codec(
        text.pin,
        textSchema
      ).pipe(Effect.provideService(CapturedService, shared))
      const compatibleRegistry = yield* Executables.make(
        fixture.entries.map((entry) =>
          entry === config
            ? sharedConfig
            : entry === text
            ? sharedText
            : entry
        )
      )
      const compatible = yield* compatibleRegistry.resolveArtifact(
        fixture.verified
      )
      const contract = compatible.nodeHandlers.get("step")!.contract
      assert.strictEqual(
        Context.get(
          contract.invocationCodecContext as Context.Context<CapturedService>,
          CapturedService
        ),
        shared
      )
      assert.strictEqual(
        Context.get(
          contract.resultCodecContext as Context.Context<CapturedService>,
          CapturedService
        ),
        shared
      )
    }).pipe(provideSha256))

  it.effect("rejects a boundary codec whose exact pin carries a non-identical runtime Schema", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const text = fixture.codecs.find(
        (entry) => entry.pin.codecId === "text"
      )!
      const equivalentTextSchema = textSchema.annotate({
        identifier: "EquivalentButUnattestedBoundaryText"
      })
      assert.notStrictEqual(equivalentTextSchema, textSchema)

      const replacement = yield* Executables.codec(
        text.pin,
        equivalentTextSchema
      )
      const registry = yield* Executables.make(
        fixture.entries.map((entry) => entry === text ? replacement : entry)
      )
      const mismatch = yield* registry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)

      assert.strictEqual(mismatch.code, Executables.ErrorCodes.PinMismatch)
      assert.strictEqual(mismatch.executableKind, "Codec")
      assert.strictEqual(mismatch.key, text.pin.key)
      assert.include(mismatch.message, "Workflow input 'value'")
    }).pipe(provideSha256))

  it.effect("rejects a node codec whose exact pin carries a non-identical runtime Schema", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const config = fixture.codecs.find(
        (entry) => entry.pin.codecId === "config"
      )!
      const equivalentConfigSchema = Schema.Struct({
        prefix: textSchema
      })
      assert.notStrictEqual(equivalentConfigSchema, step.configSchema)

      const replacement = yield* Executables.codec(
        config.pin,
        equivalentConfigSchema
      )
      const registry = yield* Executables.make(
        fixture.entries.map((entry) => entry === config ? replacement : entry)
      )
      const mismatch = yield* registry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)

      assert.strictEqual(mismatch.code, Executables.ErrorCodes.PinMismatch)
      assert.strictEqual(mismatch.executableKind, "Codec")
      assert.strictEqual(mismatch.key, config.pin.key)
      assert.include(
        mismatch.message,
        "configuration must use the exact runtime Schema object"
      )
    }).pipe(provideSha256))

  it.effect("requires exact artifact and executable provenance", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const registry = yield* Executables.make(fixture.entries)
      const artifactFailure = yield* registry.resolveArtifact({
        ...fixture.verified
      }).pipe(Effect.flip)
      assert.strictEqual(
        artifactFailure.code,
        Executables.ErrorCodes.UnverifiedArtifact
      )

      const forgedRegistry = {
        ...fixture.deployed
      } as DeploymentHandlers.DeploymentHandlerRegistry["Service"]
      const forgedNode = failure(Executables.nodeHandler(
        forgedRegistry,
        fixture.verified.artifact.nodeBindings[0]!.handlerBuild
      ))
      assert.strictEqual(
        forgedNode.code,
        Executables.ErrorCodes.UntrustedExecutable
      )

      const copiedEntry = {
        ...fixture.node
      } as Executables.NodeHandlerExecutable
      const copiedFailure = yield* Executables.make([
        copiedEntry
      ]).pipe(Effect.flip)
      assert.strictEqual(
        copiedFailure.code,
        Executables.ErrorCodes.UntrustedExecutable
      )
      const copiedWorkflow = {
        ...fixture.workflow
      } as Executables.WorkflowDefinitionExecutable
      const copiedWorkflowFailure = yield* Executables.make([
        copiedWorkflow
      ]).pipe(Effect.flip)
      assert.strictEqual(
        copiedWorkflowFailure.code,
        Executables.ErrorCodes.UntrustedExecutable
      )
      assert.isFalse(
        Executables.isWorkflowDefinitionExecutable(copiedWorkflow)
      )
      const forgedCatalog = {
        ...fixture.deploymentCatalog,
        resolveWorkflowDefinition: () => Effect.succeed({ ...definition } as Workflow.Any)
      } as Deployment.DeploymentCatalog["Service"]
      const copiedDefinitionFailure = yield* Executables.workflowDefinition(
        forgedCatalog,
        fixture.verified.artifact.definition.build
      ).pipe(Effect.flip)
      assert.strictEqual(
        copiedDefinitionFailure.code,
        Executables.ErrorCodes.InvalidExecutable
      )
      assert.isFalse(Executables.isNodeHandlerExecutable(copiedEntry))
      assert.isFalse(
        Executables.isCodecExecutable({ ...fixture.codecs[0]! })
      )
      assert.isFalse(
        Executables.isRetryClassifierExecutable({
          ...fixture.classifier
        })
      )
    }).pipe(provideSha256))

  it.effect("retains Effect context before codec and classifier type erasure", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const codecPin = fixture.verified.artifact.codecs.find(
        (pin) => pin.codecId === "text"
      )!
      const classifierPin = fixture.verified.artifact.policyExecutableBuilds[0]!
      const captured = { value: "captured" }
      const codec = yield* Executables.codec(
        codecPin,
        Schema.String
      ).pipe(Effect.provideService(CapturedService, captured))
      const classifier = yield* Executables.retryClassifier(
        classifierPin,
        () =>
          Effect.map(
            CapturedService,
            (service) => ({
              _tag: service.value === "captured"
                ? "Retryable" as const
                : "NonRetryable" as const,
              classificationVersion: 1 as const
            })
          )
      ).pipe(Effect.provideService(CapturedService, captured))

      assert.strictEqual(
        Context.get(
          codec.context as Context.Context<CapturedService>,
          CapturedService
        ),
        captured
      )
      assert.strictEqual(
        Context.get(
          classifier.context as Context.Context<CapturedService>,
          CapturedService
        ),
        captured
      )
    }).pipe(provideSha256))

  it.effect("distinguishes missing pins from exact pin mismatch and never falls back", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const text = fixture.codecs.find(
        (entry) => entry.pin.codecId === "text"
      )!
      const alternateBuild = yield* buildPin(
        "Codec",
        "text",
        "1.0.0",
        "codec:text:alternate"
      )
      const alternate = yield* Executables.codec({
        ...text.pin,
        build: alternateBuild
      }, Schema.String)
      const withoutExact = fixture.entries.filter(
        (entry) => entry !== text
      )
      const mismatchRegistry = yield* Executables.make([
        ...withoutExact,
        alternate
      ])
      const mismatch = yield* mismatchRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(mismatch.code, Executables.ErrorCodes.PinMismatch)
      assert.strictEqual(mismatch.executableKind, "Codec")
      assert.strictEqual(mismatch.key, text.pin.key)

      const missingRegistry = yield* Executables.make(withoutExact)
      const missing = yield* missingRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(
        missing.code,
        Executables.ErrorCodes.MissingExecutable
      )

      const bothRegistry = yield* Executables.make([
        ...fixture.entries,
        alternate
      ])
      const resolved = yield* bothRegistry.resolveArtifact(fixture.verified)
      assert.strictEqual(resolved.codecs.get(text.pin.key), text)
    }).pipe(provideSha256))

  it.effect("requires the exact workflow build while allowing extra immutable builds to coexist", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const alternateBuild = yield* buildPin(
        "WorkflowDefinition",
        definition.id,
        definition.version,
        "definition-deployment-2"
      )
      const catalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition(
            fixture.verified.artifact.definition.build.deploymentId,
            definition
          ),
          Deployment.workflowDefinition(
            alternateBuild.deploymentId,
            definition
          )
        ],
        handlerDefinitions: []
      })
      const alternate = yield* Executables.workflowDefinition(
        catalog,
        alternateBuild
      )
      const withoutExact = fixture.entries.filter(
        (entry) => entry !== fixture.workflow
      )

      const mismatchRegistry = yield* Executables.make([
        ...withoutExact,
        alternate
      ])
      const mismatch = yield* mismatchRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(mismatch.code, Executables.ErrorCodes.PinMismatch)
      assert.strictEqual(
        mismatch.executableKind,
        "WorkflowDefinition"
      )

      const missingRegistry = yield* Executables.make(withoutExact)
      const missing = yield* missingRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(
        missing.code,
        Executables.ErrorCodes.MissingExecutable
      )
      assert.strictEqual(
        missing.executableKind,
        "WorkflowDefinition"
      )

      const complete = yield* Executables.make([
        ...fixture.entries,
        alternate
      ])
      const resolved = yield* complete.resolveArtifact(fixture.verified)
      assert.strictEqual(
        resolved.workflowExecutable,
        fixture.workflow
      )
      assert.strictEqual(resolved.workflowDefinition, definition)
    }).pipe(provideSha256))

  it.effect("delegates workflow deployment resolution without id/version fallback", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const emptyCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: []
      })
      const missing = yield* Executables.workflowDefinition(
        emptyCatalog,
        fixture.verified.artifact.definition.build
      ).pipe(Effect.flip)
      assert.strictEqual(
        missing.code,
        Executables.ErrorCodes.MissingExecutable
      )

      const mismatchedBuild = yield* buildPin(
        "WorkflowDefinition",
        "different-workflow",
        definition.version,
        fixture.verified.artifact.definition.build.deploymentId
      )
      const mismatch = yield* Executables.workflowDefinition(
        fixture.deploymentCatalog,
        mismatchedBuild
      ).pipe(Effect.flip)
      assert.strictEqual(
        mismatch.code,
        Executables.ErrorCodes.PinMismatch
      )
    }).pipe(provideSha256))

  it.effect("binds artifact boundaries and node handlers to the exact runtime workflow definition", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const boundaryMismatchDefinition = Workflow.make(
        "artifact-workflow",
        {
          version: "1.0.0",
          inputs: {
            value: Port.output(Schema.String, {
              contract: "example/different",
              fanOut: "single"
            })
          },
          outputs: definition.outputs,
          nodes: nodeRegistry,
          linkPolicy: LinkPolicy.allowAll,
          limits: definition.limits
        }
      )
      const boundaryCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition(
            fixture.verified.artifact.definition.build.deploymentId,
            boundaryMismatchDefinition
          )
        ],
        handlerDefinitions: []
      })
      const boundaryExecutable = yield* Executables.workflowDefinition(
        boundaryCatalog,
        fixture.verified.artifact.definition.build
      )
      const boundaryRegistry = yield* Executables.make([
        boundaryExecutable,
        ...fixture.entries.filter(
          (entry) => entry !== fixture.workflow
        )
      ])
      const boundaryMismatch = yield* boundaryRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(
        boundaryMismatch.code,
        Executables.ErrorCodes.PinMismatch
      )
      assert.strictEqual(
        boundaryMismatch.executableKind,
        "WorkflowDefinition"
      )

      const copiedStep = Node.make("Step", {
        version: "1.0.0",
        config: Schema.Struct({ prefix: Schema.String }),
        inputs: {
          value: Port.input(Schema.String, {
            contract: "example/text"
          })
        },
        outputs: {
          value: Port.output(Schema.String, {
            contract: "example/text"
          })
        },
        failure: Schema.String
      })
      const copiedNodes = Registry.make(copiedStep)
      const copiedNodeDefinition = Workflow.make(
        "artifact-workflow",
        {
          version: "1.0.0",
          inputs: definition.inputs,
          outputs: definition.outputs,
          nodes: copiedNodes,
          linkPolicy: LinkPolicy.allowAll,
          limits: definition.limits
        }
      )
      const copiedNodeCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition(
            fixture.verified.artifact.definition.build.deploymentId,
            copiedNodeDefinition
          )
        ],
        handlerDefinitions: []
      })
      const copiedNodeExecutable = yield* Executables.workflowDefinition(
        copiedNodeCatalog,
        fixture.verified.artifact.definition.build
      )
      const copiedNodeRegistry = yield* Executables.make([
        copiedNodeExecutable,
        ...fixture.entries.filter(
          (entry) => entry !== fixture.workflow
        )
      ])
      const nodeMismatch = yield* copiedNodeRegistry.resolveArtifact(
        fixture.verified
      ).pipe(Effect.flip)
      assert.strictEqual(
        nodeMismatch.code,
        Executables.ErrorCodes.PinMismatch
      )
      assert.strictEqual(nodeMismatch.executableKind, "NodeHandler")
    }).pipe(provideSha256))

  it.effect("rejects duplicate and conflicting immutable catalog coordinates", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const text = fixture.codecs.find(
        (entry) => entry.pin.codecId === "text"
      )!
      const duplicate = yield* Executables.make([
        text,
        text
      ]).pipe(Effect.flip)
      assert.strictEqual(
        duplicate.code,
        Executables.ErrorCodes.DuplicateExecutable
      )
      const duplicateWorkflow = yield* Executables.make([
        fixture.workflow,
        fixture.workflow
      ]).pipe(Effect.flip)
      assert.strictEqual(
        duplicateWorkflow.code,
        Executables.ErrorCodes.DuplicateExecutable
      )

      const conflictingBuild = yield* buildPin(
        "Codec",
        "text",
        "1.0.0",
        text.pin.build.deploymentId,
        "catalog:conflicting"
      )
      const conflicting = yield* Executables.codec({
        ...text.pin,
        build: conflictingBuild
      }, Schema.String)
      const conflict = yield* Executables.make([
        text,
        conflicting
      ]).pipe(Effect.flip)
      assert.strictEqual(
        conflict.code,
        Executables.ErrorCodes.ConflictingExecutable
      )

      const conflictingWorkflowBuild = yield* buildPin(
        "WorkflowDefinition",
        definition.id,
        definition.version,
        fixture.workflow.build.deploymentId,
        "catalog:conflicting-workflow"
      )
      const conflictingWorkflow = yield* Executables.workflowDefinition(
        fixture.deploymentCatalog,
        conflictingWorkflowBuild
      )
      const workflowConflict = yield* Executables.make([
        fixture.workflow,
        conflictingWorkflow
      ]).pipe(Effect.flip)
      assert.strictEqual(
        workflowConflict.code,
        Executables.ErrorCodes.ConflictingExecutable
      )
    }).pipe(provideSha256))

  it.effect("resolves distinct exact deferred success and error codecs from the same artifact", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const registry = yield* Executables.make(fixture.entries)
      const resolved = yield* registry.resolveArtifact(fixture.verified)
      const text = fixture.codecs.find(
        (entry) => entry.pin.codecId === "text"
      )!
      const failureCodec = fixture.codecs.find(
        (entry) => entry.pin.codecId === "failure"
      )!
      const occurrence = yield* SemanticOccurrenceV3.prepare({
        occurrenceVersion: SemanticOccurrenceV3.OccurrenceVersion,
        executionProtocolVersion: SemanticOccurrenceV3.ExecutionProtocolVersion,
        tenantId: "tenant-1",
        runId: "run-1",
        artifactDigest: fixture.verified.artifactDigest,
        nodeId: "step",
        scopePath: [],
        activation: 0
      })
      const operation = yield* SemanticOperationV3.prepare(occurrence, {
        _tag: "Deferred",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: "approval",
        generation: 0,
        successCodecKey: text.pin.key,
        errorCodecKey: failureCodec.pin.key,
        successSchemaDigest: text.pin.schemaDigest,
        errorSchemaDigest: failureCodec.pin.schemaDigest
      })
      const codecs = success(
        Executables.resolveDeferred(resolved, operation)
      )
      assert.strictEqual(codecs.success, text)
      assert.strictEqual(codecs.error, failureCodec)
      assert.isTrue(Executables.isResolvedDeferredCodecs(codecs))
      assert.isFalse(
        Executables.isResolvedDeferredCodecs({ ...codecs })
      )

      const drifted = yield* SemanticOperationV3.prepare(occurrence, {
        _tag: "Deferred",
        operationVersion: SemanticOperationV3.OperationVersion,
        executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
        operationId: "approval",
        generation: 0,
        successCodecKey: text.pin.key,
        errorCodecKey: failureCodec.pin.key,
        successSchemaDigest: `sha256:${"f".repeat(64)}`,
        errorSchemaDigest: failureCodec.pin.schemaDigest
      })
      assert.strictEqual(
        failure(Executables.resolveDeferred(resolved, drifted)).code,
        Executables.ErrorCodes.PinMismatch
      )
      assert.strictEqual(
        failure(Executables.resolveDeferred(
          { ...resolved },
          operation
        )).code,
        Executables.ErrorCodes.UnresolvedArtifact
      )
      assert.strictEqual(
        failure(Executables.resolveDeferred(
          resolved,
          { ...operation }
        )).code,
        Executables.ErrorCodes.UnpreparedOperation
      )
    }).pipe(provideSha256))
})
