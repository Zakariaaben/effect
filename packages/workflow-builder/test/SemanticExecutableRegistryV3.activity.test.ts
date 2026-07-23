import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import * as Wire from "../src/ProtocolV3Wire.ts"
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as SemanticOccurrenceV3 from "../src/SemanticOccurrenceV3.ts"
import * as SemanticOperationV3 from "../src/SemanticOperationV3.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const sha256Crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideSha256 = Effect.provideService(Crypto.Crypto, sha256Crypto)

class ClassifierService extends Context.Service<
  ClassifierService,
  { readonly decision: ActivityPolicyV3.RetryClassification }
>()("SemanticExecutableRegistryV3ActivityTest/ClassifierService") {}

const classifierService = {
  decision: {
    _tag: "Retryable",
    classificationVersion: 1
  }
} as const

const textSchema = Schema.String
const configSchema = Schema.Struct({ prefix: textSchema })
const failureSchema = Schema.Struct({ code: textSchema })

const step = Node.make("ActivityStep", {
  version: "1.0.0",
  config: configSchema,
  inputs: {
    value: Port.input(textSchema, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(textSchema, { contract: "example/text" })
  },
  failure: failureSchema
})

const nodeRegistry = Registry.make(step)

const definition = Workflow.make("activity-resolution-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(textSchema, {
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
    maxNodes: 4,
    maxEdges: 4,
    maxFanIn: 2,
    maxFanOut: 2,
    maxDepth: 2
  })
})

const plan = {
  formatVersion: 1 as const,
  id: "activity-resolution-plan",
  revision: 1,
  definition: {
    id: "activity-resolution-workflow",
    version: "1.0.0"
  },
  nodes: [{
    id: "step",
    type: "ActivityStep",
    version: "1.0.0",
    config: { prefix: "handled:" }
  }],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "workflow-input-to-step",
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
      id: "step-to-workflow-output",
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
    return {
      deploymentId,
      buildDocument,
      buildDigest: yield* DigestV3.executableBuild(buildDocument)
    } satisfies PlanStoreV3.ExecutableBuildPin
  })

const makeCodec = (
  codecId: string,
  schema: Schema.Json
) =>
  Effect.gen(function*() {
    const codecVersion = "1.0.0"
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
    return {
      codecPinVersion: 3,
      key,
      codecId,
      codecVersion,
      build,
      encodedSchema,
      schemaDigest: yield* DigestV3.encodedSchema(encodedSchema)
    } satisfies PlanStoreV3.CodecPin
  })

const activityPolicy = (
  classifierBuildDigest: Wire.BuildDigest
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 3,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "activity-classifier",
      classifierVersion: "1.0.0",
      buildDigest: classifierBuildDigest
    },
    failureIdentity: {
      _tag: "EffectTagged",
      identityContractVersion: 1,
      code: "OptionalString"
    },
    nonRetryableErrorTags: [],
    nonRetryableErrorCodes: [],
    backoff: {
      _tag: "Fixed",
      delayMillis: 100
    },
    jitter: { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: { _tag: "Disabled" },
    startToClose: {
      _tag: "After",
      durationMillis: 10_000
    },
    scheduleToClose: { _tag: "Disabled" }
  }
})

const classifier = (
  _failure: ActivityPolicyV3.RetryFailureCause
) => Effect.map(ClassifierService, (service) => service.decision)

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolved: Executables.ResolvedArtifactExecutables
  readonly nodeDefinitionKey: string
  readonly handlerBuildDigest: Wire.BuildDigest
  readonly failureCodec: Executables.CodecExecutable<typeof failureSchema>
  readonly classifierKey: string
  readonly classifierBuildDigest: Wire.BuildDigest
  readonly classifierExecutable: Executables.RetryClassifierExecutable
}

const makeFixture = Effect.gen(function*() {
  const prepared = yield* CompilerV2.compile(definition, plan)
  const compiledFingerprint = yield* DigestV3.compiledPlan(
    prepared.fingerprintDocument
  )
  const definitionBuild = yield* buildPin(
    "WorkflowDefinition",
    definition.id,
    definition.version,
    "activity-definition-deployment"
  )
  const handlerBuild = yield* buildPin(
    "NodeHandler",
    step.type,
    step.version,
    "activity-handler-deployment"
  )
  const classifierBuild = yield* buildPin(
    "RetryClassifier",
    "activity-classifier",
    "1.0.0",
    "activity-classifier-deployment"
  )
  const codecPins = yield* Effect.all([
    makeCodec("activity-config", {
      type: "object",
      required: ["prefix"],
      properties: { prefix: { type: "string" } }
    }),
    makeCodec("activity-failure", {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string" } }
    }),
    makeCodec("activity-text", { type: "string" })
  ])
  codecPins.sort((left, right) => left.key < right.key ? -1 : 1)

  const configCodecKey = PlanStoreV3.codecKey(
    "activity-config",
    "1.0.0"
  )
  const failureCodecKey = PlanStoreV3.codecKey(
    "activity-failure",
    "1.0.0"
  )
  const textCodecKey = PlanStoreV3.codecKey(
    "activity-text",
    "1.0.0"
  )
  const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
    step.type,
    step.version
  )
  const classifierKey = PlanStoreV3.classifierKey(
    "activity-classifier",
    "1.0.0"
  )
  const inputDocument = {
    boundaryContractVersion: 3 as const,
    direction: "Input" as const,
    definition: {
      id: definition.id,
      version: definition.version
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
      id: definition.id,
      version: definition.version
    },
    ports: [{
      name: "value",
      contract: "example/text",
      cardinality: "one" as const,
      required: true,
      codecKey: textCodecKey
    }]
  }
  const artifact: PlanStoreV3.StaticDagArtifact = {
    artifactVersion: 3,
    artifactKind: "StaticDag",
    executionProtocolVersion: 3,
    fingerprintDocument: prepared.fingerprintDocument,
    compiledFingerprint,
    workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(
      definition.id
    ),
    definition: {
      id: definition.id,
      version: definition.version,
      build: definitionBuild
    },
    inputBoundary: {
      document: inputDocument,
      digest: yield* DigestV3.boundaryContract(inputDocument)
    },
    outputBoundary: {
      document: outputDocument,
      digest: yield* DigestV3.boundaryContract(outputDocument)
    },
    nodeDefinitions: [{
      manifestVersion: 3,
      key: nodeDefinitionKey,
      nodeType: step.type,
      nodeVersion: step.version,
      configCodecKey,
      failureCodecKey,
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
    codecs: codecPins,
    policyExecutableBuilds: [{
      key: classifierKey,
      classifierId: "activity-classifier",
      classifierVersion: "1.0.0",
      build: classifierBuild
    }],
    nodeBindings: [{
      bindingVersion: 3,
      nodeId: "step",
      nodeType: step.type,
      nodeVersion: step.version,
      nodeDefinitionKey,
      queue: "activity-queue",
      handlerBuild,
      activityPolicy: activityPolicy(classifierBuild.buildDigest)
    }]
  }
  const verified = yield* PlanStoreV3.verifyArtifact(
    artifact,
    yield* DigestV3.artifact(artifact)
  )

  const handlers = yield* nodeRegistry.toHandlers(nodeRegistry.of({
    "ActivityStep@1.0.0": ({ config, inputs }) =>
      Effect.succeed({
        value: `${config.prefix}${inputs.value}`
      })
  }))
  const deploymentCatalog = yield* Deployment.makeMemory({
    workflowDefinitions: [
      Deployment.workflowDefinition(
        definitionBuild.deploymentId,
        definition
      )
    ],
    handlerDefinitions: [
      Deployment.handlerDefinition(
        handlerBuild.deploymentId,
        step
      )
    ]
  })
  const deployed = yield* DeploymentHandlers.make([
    DeploymentHandlers.handlerDeployment(
      handlerBuild.deploymentId,
      handlers
    )
  ]).pipe(
    Effect.provideService(
      Deployment.DeploymentCatalog,
      deploymentCatalog
    )
  )
  const workflowExecutable = yield* Executables.workflowDefinition(
    deploymentCatalog,
    definitionBuild
  )
  const nodeExecutable = success(
    Executables.nodeHandler(deployed, handlerBuild)
  )
  const runtimeSchemas: Readonly<Record<string, Schema.Top>> = {
    "activity-config": configSchema,
    "activity-failure": failureSchema,
    "activity-text": textSchema
  }
  const codecs = yield* Effect.forEach(
    verified.artifact.codecs,
    (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
  )
  const classifierExecutable = yield* Executables.retryClassifier(
    verified.artifact.policyExecutableBuilds[0]!,
    classifier
  ).pipe(
    Effect.provideService(ClassifierService, classifierService)
  )
  const registry = yield* Executables.make([
    workflowExecutable,
    nodeExecutable,
    ...codecs,
    classifierExecutable
  ])
  const resolved = yield* registry.resolveArtifact(verified)
  const failureCodec = codecs.find(
    (codec) => codec.pin.key === failureCodecKey
  ) as Executables.CodecExecutable<typeof failureSchema>

  return {
    verified,
    resolved,
    nodeDefinitionKey,
    handlerBuildDigest: handlerBuild.buildDigest,
    failureCodec,
    classifierKey,
    classifierBuildDigest: classifierBuild.buildDigest,
    classifierExecutable
  } satisfies Fixture
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("Expected failure")
  return result.failure
}

const builtIn = (
  schema: SemanticOperationV3.BuiltInSchemaName
) => ({
  _tag: "BuiltIn" as const,
  contractReferenceVersion: 1 as const,
  vocabularyVersion: 1 as const,
  schema
})

const occurrence = (
  artifactDigest: string
) =>
  SemanticOccurrenceV3.prepare({
    occurrenceVersion: SemanticOccurrenceV3.OccurrenceVersion,
    executionProtocolVersion: SemanticOccurrenceV3.ExecutionProtocolVersion,
    tenantId: "tenant-activity",
    runId: "run-activity",
    artifactDigest,
    nodeId: "step",
    scopePath: [],
    activation: 0
  })

const prepareActivity = (
  preparedOccurrence: SemanticOccurrenceV3.PreparedOccurrence,
  operationId: string,
  purpose: unknown,
  successContract: unknown,
  errorContract: unknown
) =>
  SemanticOperationV3.prepare(preparedOccurrence, {
    _tag: "Activity",
    operationVersion: SemanticOperationV3.OperationVersion,
    executionProtocolVersion: SemanticOperationV3.ExecutionProtocolVersion,
    operationId,
    attempt: 1,
    purpose,
    input: {
      _tag: "Inline",
      value: { input: "value" }
    },
    successContract,
    errorContract
  })

const nodeHandlerPurpose = (
  fixture: Fixture,
  overrides: {
    readonly nodeDefinitionKey?: string
    readonly handlerBuildDigest?: string
  } = {}
) => ({
  _tag: "NodeHandler" as const,
  purposeVersion: 1 as const,
  nodeDefinitionKey: overrides.nodeDefinitionKey ?? fixture.nodeDefinitionKey,
  handlerBuildDigest: overrides.handlerBuildDigest ?? fixture.handlerBuildDigest
})

const classifierPurpose = (
  fixture: Fixture,
  overrides: {
    readonly classifierKey?: string
    readonly classifierBuildDigest?: string
  } = {}
) => ({
  _tag: "RetryClassifier" as const,
  purposeVersion: 1 as const,
  failedActivityDigest: digest("a"),
  classifierKey: overrides.classifierKey ?? fixture.classifierKey,
  classifierBuildDigest: overrides.classifierBuildDigest ?? fixture.classifierBuildDigest
})

describe("SemanticExecutableRegistryV3 activity resolution", () => {
  it.effect("resolves all four purposes to exact handler, codec, built-in, callable, and context objects", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const preparedOccurrence = yield* occurrence(
        fixture.verified.artifactDigest
      )
      const handlerOperation = yield* prepareActivity(
        preparedOccurrence,
        "invoke-handler",
        nodeHandlerPurpose(fixture),
        {
          _tag: "NodeOutputAggregate",
          contractReferenceVersion: 1,
          nodeDefinitionKey: fixture.nodeDefinitionKey
        },
        {
          _tag: "ArtifactCodec",
          contractReferenceVersion: 1,
          codecKey: fixture.failureCodec.pin.key,
          schemaDigest: fixture.failureCodec.pin.schemaDigest
        }
      )
      const classifierOperation = yield* prepareActivity(
        preparedOccurrence,
        "classify-failure",
        classifierPurpose(fixture),
        builtIn("RetryClassification"),
        builtIn("Never")
      )
      const delayOperation = yield* prepareActivity(
        preparedOccurrence,
        "select-retry-delay",
        {
          _tag: "RetryDelaySelection",
          purposeVersion: 1,
          failedActivityDigest: handlerOperation.operationDigest,
          classificationActivityDigest: classifierOperation.operationDigest
        },
        builtIn("RecordedRetryDelay"),
        builtIn("Never")
      )
      const timeOperation = yield* prepareActivity(
        preparedOccurrence,
        "observe-time",
        {
          _tag: "TimeObservation",
          purposeVersion: 1,
          ownerOperationDigest: handlerOperation.operationDigest,
          observationKind: "Initial"
        },
        builtIn("CanonicalTimestamp"),
        builtIn("Never")
      )

      const handler = success(
        Executables.resolveActivity(
          fixture.resolved,
          handlerOperation
        )
      )
      assert.strictEqual(handler._tag, "NodeHandler")
      if (handler._tag !== "NodeHandler") return
      assert.strictEqual(handler.operation, handlerOperation)
      assert.strictEqual(
        handler.successSchema,
        handler.node.contract.successSchema
      )
      assert.strictEqual(
        handler.errorSchema,
        fixture.failureCodec.schema
      )
      assert.strictEqual(handler.errorSchema, failureSchema)
      assert.strictEqual(
        handler.context,
        handler.node.contract.codecContext
      )

      const resolvedClassifier = success(
        Executables.resolveActivity(
          fixture.resolved,
          classifierOperation
        )
      )
      assert.strictEqual(resolvedClassifier._tag, "RetryClassifier")
      if (resolvedClassifier._tag !== "RetryClassifier") return
      assert.strictEqual(
        resolvedClassifier.successSchema,
        ActivityPolicyV3.RetryClassification
      )
      assert.strictEqual(resolvedClassifier.errorSchema, Schema.Never)
      assert.strictEqual(
        resolvedClassifier.executable,
        fixture.classifierExecutable
      )
      assert.strictEqual(
        resolvedClassifier.executable.classifier,
        classifier
      )
      assert.strictEqual(
        resolvedClassifier.context,
        fixture.classifierExecutable.context
      )
      assert.strictEqual(
        Context.get(
          resolvedClassifier.context as Context.Context<ClassifierService>,
          ClassifierService
        ),
        classifierService
      )
      const decision = yield* resolvedClassifier.executable.classifier({
        _tag: "AttemptTimeout",
        failureCauseVersion: 1,
        activityDigest: handlerOperation.operationDigest,
        attempt: 1,
        timeoutKind: "StartToClose"
      }).pipe(
        Effect.updateContext((current) => Context.merge(resolvedClassifier.context, current))
      )
      assert.strictEqual(decision, classifierService.decision)

      const delay = success(
        Executables.resolveActivity(
          fixture.resolved,
          delayOperation
        )
      )
      assert.strictEqual(delay._tag, "RetryDelaySelection")
      assert.strictEqual(
        delay.successSchema,
        ActivityPolicyV3.RecordedRetryDelay
      )
      assert.strictEqual(delay.errorSchema, Schema.Never)
      assert.strictEqual(delay.context, Context.empty())

      const time = success(
        Executables.resolveActivity(
          fixture.resolved,
          timeOperation
        )
      )
      assert.strictEqual(time._tag, "TimeObservation")
      assert.strictEqual(time.successSchema, Wire.Timestamp)
      assert.strictEqual(time.errorSchema, Schema.Never)
      assert.strictEqual(time.context, Context.empty())

      for (
        const resolved of [
          handler,
          resolvedClassifier,
          delay,
          time
        ]
      ) {
        assert.isTrue(Executables.isResolvedActivity(resolved))
        assert.isFalse(
          Executables.isResolvedActivity({ ...resolved })
        )
        assert.isTrue(Object.isFrozen(resolved))
      }
    }).pipe(provideSha256))

  it.effect("rejects structural copies and a prepared operation from another artifact", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const preparedOccurrence = yield* occurrence(
        fixture.verified.artifactDigest
      )
      const operation = yield* prepareActivity(
        preparedOccurrence,
        "invoke-handler",
        nodeHandlerPurpose(fixture),
        {
          _tag: "NodeOutputAggregate",
          contractReferenceVersion: 1,
          nodeDefinitionKey: fixture.nodeDefinitionKey
        },
        {
          _tag: "ArtifactCodec",
          contractReferenceVersion: 1,
          codecKey: fixture.failureCodec.pin.key,
          schemaDigest: fixture.failureCodec.pin.schemaDigest
        }
      )

      assert.strictEqual(
        failure(Executables.resolveActivity(
          { ...fixture.resolved },
          operation
        )).code,
        Executables.ErrorCodes.UnresolvedArtifact
      )
      assert.strictEqual(
        failure(Executables.resolveActivity(
          fixture.resolved,
          { ...operation }
        )).code,
        Executables.ErrorCodes.UnpreparedOperation
      )

      const otherOccurrence = yield* occurrence(digest("b"))
      const otherArtifactOperation = yield* prepareActivity(
        otherOccurrence,
        "invoke-handler",
        nodeHandlerPurpose(fixture),
        {
          _tag: "NodeOutputAggregate",
          contractReferenceVersion: 1,
          nodeDefinitionKey: fixture.nodeDefinitionKey
        },
        {
          _tag: "ArtifactCodec",
          contractReferenceVersion: 1,
          codecKey: fixture.failureCodec.pin.key,
          schemaDigest: fixture.failureCodec.pin.schemaDigest
        }
      )
      assert.strictEqual(
        failure(Executables.resolveActivity(
          fixture.resolved,
          otherArtifactOperation
        )).code,
        Executables.ErrorCodes.ArtifactMismatch
      )
    }).pipe(provideSha256))

  it.effect("rejects artifact-conflicting handler and classifier references that remain valid activity contracts", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const preparedOccurrence = yield* occurrence(
        fixture.verified.artifactDigest
      )
      const handlerCases = [
        {
          label: "handler build digest",
          purpose: nodeHandlerPurpose(fixture, {
            handlerBuildDigest: digest("c")
          }),
          nodeDefinitionKey: fixture.nodeDefinitionKey,
          failureSchemaDigest: fixture.failureCodec.pin.schemaDigest
        },
        {
          label: "node definition key",
          purpose: nodeHandlerPurpose(fixture, {
            nodeDefinitionKey: "OtherActivityStep@1.0.0"
          }),
          nodeDefinitionKey: "OtherActivityStep@1.0.0",
          failureSchemaDigest: fixture.failureCodec.pin.schemaDigest
        },
        {
          label: "failure codec schema digest",
          purpose: nodeHandlerPurpose(fixture),
          nodeDefinitionKey: fixture.nodeDefinitionKey,
          failureSchemaDigest: digest("d")
        }
      ]
      for (const handlerCase of handlerCases) {
        const operation = yield* prepareActivity(
          preparedOccurrence,
          `wrong-${handlerCase.label.replaceAll(" ", "-")}`,
          handlerCase.purpose,
          {
            _tag: "NodeOutputAggregate",
            contractReferenceVersion: 1,
            nodeDefinitionKey: handlerCase.nodeDefinitionKey
          },
          {
            _tag: "ArtifactCodec",
            contractReferenceVersion: 1,
            codecKey: fixture.failureCodec.pin.key,
            schemaDigest: handlerCase.failureSchemaDigest
          }
        )
        const mismatch = failure(
          Executables.resolveActivity(fixture.resolved, operation)
        )
        assert.strictEqual(
          mismatch.code,
          Executables.ErrorCodes.PinMismatch,
          handlerCase.label
        )
      }

      for (
        const [label, purpose] of [
          [
            "classifier key",
            classifierPurpose(fixture, {
              classifierKey: "other-classifier@1.0.0"
            })
          ],
          [
            "classifier build digest",
            classifierPurpose(fixture, {
              classifierBuildDigest: digest("e")
            })
          ]
        ] as const
      ) {
        const operation = yield* prepareActivity(
          preparedOccurrence,
          `wrong-${label.replaceAll(" ", "-")}`,
          purpose,
          builtIn("RetryClassification"),
          builtIn("Never")
        )
        const mismatch = failure(
          Executables.resolveActivity(fixture.resolved, operation)
        )
        assert.strictEqual(
          mismatch.code,
          Executables.ErrorCodes.PinMismatch,
          label
        )
        assert.strictEqual(
          mismatch.executableKind,
          "RetryClassifier",
          label
        )
      }
    }).pipe(provideSha256))
})
