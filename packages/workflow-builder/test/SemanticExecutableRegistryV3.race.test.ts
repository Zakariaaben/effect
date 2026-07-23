import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Operation from "../src/SemanticOperationV3.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

class RaceCodecService extends Context.Service<
  RaceCodecService,
  { readonly value: string }
>()("SemanticExecutableRegistryV3RaceTest/CodecService") {}

const textSchema = Schema.String
const numberSchema = Schema.Number
const alphaConfigSchema = Schema.Struct({
  prefix: textSchema
})
const alphaFailureSchema = Schema.Struct({
  code: textSchema
})
const betaConfigSchema = Schema.Struct({
  multiplier: numberSchema
})
const betaFailureSchema = Schema.Struct({
  reason: textSchema
})

const alphaStep = Node.make("AlphaStep", {
  version: "1.0.0",
  config: alphaConfigSchema,
  inputs: {
    value: Port.input(textSchema, {
      contract: "race/text"
    })
  },
  outputs: {
    value: Port.output(textSchema, {
      contract: "race/text"
    })
  },
  failure: alphaFailureSchema
})

const betaStep = Node.make("BetaStep", {
  version: "1.0.0",
  config: betaConfigSchema,
  inputs: {
    value: Port.input(numberSchema, {
      contract: "race/number"
    })
  },
  outputs: {
    value: Port.output(numberSchema, {
      contract: "race/number"
    })
  },
  failure: betaFailureSchema
})

const alphaRegistry = Registry.make(alphaStep)
const betaRegistry = Registry.make(betaStep)
const nodeRegistry = Registry.make(alphaStep, betaStep)

const definition = Workflow.make("race-resolution-workflow", {
  version: "1.0.0",
  inputs: {
    number: Port.output(numberSchema, {
      contract: "race/number",
      fanOut: "single"
    }),
    text: Port.output(textSchema, {
      contract: "race/text",
      fanOut: "single"
    })
  },
  outputs: {},
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
  id: "race-resolution-plan",
  revision: 3,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    {
      id: "alpha",
      type: alphaStep.type,
      version: alphaStep.version,
      config: { prefix: "alpha:" }
    },
    {
      id: "beta",
      type: betaStep.type,
      version: betaStep.version,
      config: { multiplier: 2 }
    }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "number-to-beta",
      source: {
        _tag: "WorkflowInput" as const,
        input: "number"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId: "beta",
        input: "value"
      }
    },
    {
      _tag: "DataEdge" as const,
      id: "text-to-alpha",
      source: {
        _tag: "WorkflowInput" as const,
        input: "text"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId: "alpha",
        input: "value"
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

const codecPin = (
  codecId: string,
  encodedJsonSchema: Schema.Json
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
      schema: encodedJsonSchema
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
  classifierBuildDigest: PlanStoreV3.ExecutableBuildPin["buildDigest"]
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 2,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "race-classifier",
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
      delayMillis: 1
    },
    jitter: { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: { _tag: "Disabled" },
    startToClose: { _tag: "Disabled" },
    scheduleToClose: { _tag: "Disabled" }
  }
})

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolvedArtifact: Executables.ResolvedArtifactExecutables
  readonly alphaBinding: PlanStoreV3.NodeBinding
  readonly betaBinding: PlanStoreV3.NodeBinding
  readonly alphaFailure: PlanStoreV3.CodecPin
  readonly betaFailure: PlanStoreV3.CodecPin
  readonly text: PlanStoreV3.CodecPin
  readonly number: PlanStoreV3.CodecPin
  readonly alphaService: { readonly value: string }
  readonly betaService: { readonly value: string }
}

const makeFixture = (
  conflictingContexts = false
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "race-definition"
    )
    const alphaBuild = yield* buildPin(
      "NodeHandler",
      alphaStep.type,
      alphaStep.version,
      "race-alpha-handler"
    )
    const betaBuild = yield* buildPin(
      "NodeHandler",
      betaStep.type,
      betaStep.version,
      "race-beta-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "race-classifier",
      "1.0.0",
      "race-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("alpha-config", {
        type: "object",
        additionalProperties: false,
        required: ["prefix"],
        properties: {
          prefix: { type: "string" }
        }
      }),
      codecPin("alpha-failure", {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: { type: "string" }
        }
      }),
      codecPin("beta-config", {
        type: "object",
        additionalProperties: false,
        required: ["multiplier"],
        properties: {
          multiplier: { type: "number" }
        }
      }),
      codecPin("beta-failure", {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: {
          reason: { type: "string" }
        }
      }),
      codecPin("number", { type: "number" }),
      codecPin("text", { type: "string" })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const codecKey = (id: string) => PlanStoreV3.codecKey(id, "1.0.0")
    const alphaDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      alphaStep.type,
      alphaStep.version
    )
    const betaDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      betaStep.type,
      betaStep.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "race-classifier",
      "1.0.0"
    )
    const inputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: compiled.fingerprintDocument.workflowInterface.inputs.map(
        (port) => ({
          ...port,
          codecKey: port.name === "number"
            ? codecKey("number")
            : codecKey("text")
        })
      )
    }
    const outputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Output" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: []
    }
    const artifact: PlanStoreV3.StaticDagArtifact = {
      artifactVersion: 3,
      artifactKind: "StaticDag",
      executionProtocolVersion: 3,
      fingerprintDocument: compiled.fingerprintDocument,
      compiledFingerprint: yield* DigestV3.compiledPlan(
        compiled.fingerprintDocument
      ),
      workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(
        definition.id
      ),
      definition: {
        id: definition.id,
        version: definition.version,
        build: definitionBuild
      },
      inputBoundary: {
        document: inputBoundaryDocument,
        digest: yield* DigestV3.boundaryContract(
          inputBoundaryDocument
        )
      },
      outputBoundary: {
        document: outputBoundaryDocument,
        digest: yield* DigestV3.boundaryContract(
          outputBoundaryDocument
        )
      },
      nodeDefinitions: [
        {
          manifestVersion: 3,
          key: alphaDefinitionKey,
          nodeType: alphaStep.type,
          nodeVersion: alphaStep.version,
          configCodecKey: codecKey("alpha-config"),
          failureCodecKey: codecKey("alpha-failure"),
          inputs: [{
            name: "value",
            contract: "race/text",
            cardinality: "one",
            required: true,
            codecKey: codecKey("text")
          }],
          outputs: [{
            name: "value",
            contract: "race/text",
            fanOut: "multiple",
            codecKey: codecKey("text")
          }]
        },
        {
          manifestVersion: 3,
          key: betaDefinitionKey,
          nodeType: betaStep.type,
          nodeVersion: betaStep.version,
          configCodecKey: codecKey("beta-config"),
          failureCodecKey: codecKey("beta-failure"),
          inputs: [{
            name: "value",
            contract: "race/number",
            cardinality: "one",
            required: true,
            codecKey: codecKey("number")
          }],
          outputs: [{
            name: "value",
            contract: "race/number",
            fanOut: "multiple",
            codecKey: codecKey("number")
          }]
        }
      ],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "race-classifier",
        classifierVersion: "1.0.0",
        build: classifierBuild
      }],
      nodeBindings: compiled.fingerprintDocument.program.nodes.map((node) => {
        const alpha = node.id === "alpha"
        return {
          bindingVersion: 3,
          nodeId: node.id,
          nodeType: node.type,
          nodeVersion: node.version,
          nodeDefinitionKey: alpha
            ? alphaDefinitionKey
            : betaDefinitionKey,
          queue: alpha ? "race-alpha-queue" : "race-beta-queue",
          handlerBuild: alpha ? alphaBuild : betaBuild,
          activityPolicy: activityPolicy(
            classifierBuild.buildDigest
          )
        }
      })
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const alphaHandlers = yield* alphaRegistry.toHandlers(
      alphaRegistry.of({
        "AlphaStep@1.0.0": ({ config, inputs }) =>
          Effect.succeed({
            value: `${config.prefix}${inputs.value}`
          })
      })
    )
    const betaHandlers = yield* betaRegistry.toHandlers(
      betaRegistry.of({
        "BetaStep@1.0.0": ({ config, inputs }) =>
          Effect.succeed({
            value: config.multiplier * inputs.value
          })
      })
    )
    const deploymentCatalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        Deployment.workflowDefinition(
          definitionBuild.deploymentId,
          definition
        )
      ],
      handlerDefinitions: [
        Deployment.handlerDefinition(
          alphaBuild.deploymentId,
          alphaStep
        ),
        Deployment.handlerDefinition(
          betaBuild.deploymentId,
          betaStep
        )
      ]
    })
    const deployedHandlers = yield* DeploymentHandlers.make([
      DeploymentHandlers.handlerDeployment(
        alphaBuild.deploymentId,
        alphaHandlers
      ),
      DeploymentHandlers.handlerDeployment(
        betaBuild.deploymentId,
        betaHandlers
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
    const nodeExecutables = verified.artifact.nodeBindings.map(
      (binding) =>
        expectSuccess(Executables.nodeHandler(
          deployedHandlers,
          binding.handlerBuild
        ))
    )
    const runtimeSchemas = {
      "alpha-config": alphaConfigSchema,
      "alpha-failure": alphaFailureSchema,
      "beta-config": betaConfigSchema,
      "beta-failure": betaFailureSchema,
      number: numberSchema,
      text: textSchema
    } as const
    const shared = { value: "shared" }
    const alphaService = conflictingContexts
      ? { value: "alpha" }
      : shared
    const betaService = conflictingContexts
      ? { value: "beta" }
      : shared
    const alphaCodecIds = new Set([
      "alpha-config",
      "alpha-failure",
      "text"
    ])
    const codecExecutables = yield* Effect.forEach(
      verified.artifact.codecs,
      (pin) =>
        Executables.codec(
          pin,
          runtimeSchemas[
            pin.codecId as keyof typeof runtimeSchemas
          ]
        ).pipe(
          Effect.provideService(
            RaceCodecService,
            alphaCodecIds.has(pin.codecId)
              ? alphaService
              : betaService
          )
        )
    )
    const classifierExecutable = yield* Executables.retryClassifier(
      verified.artifact.policyExecutableBuilds[0]!,
      () =>
        Effect.succeed({
          _tag: "NonRetryable" as const,
          classificationVersion: 1 as const
        })
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      ...nodeExecutables,
      ...codecExecutables,
      classifierExecutable
    ])
    const resolvedArtifact = yield* registry.resolveArtifact(verified)
    const pin = (id: string) =>
      verified.artifact.codecs.find(
        (candidate) => candidate.codecId === id
      )!

    return {
      verified,
      resolvedArtifact,
      alphaBinding: verified.artifact.nodeBindings.find(
        (binding) => binding.nodeId === "alpha"
      )!,
      betaBinding: verified.artifact.nodeBindings.find(
        (binding) => binding.nodeId === "beta"
      )!,
      alphaFailure: pin("alpha-failure"),
      betaFailure: pin("beta-failure"),
      text: pin("text"),
      number: pin("number"),
      alphaService,
      betaService
    } satisfies Fixture
  })

const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const expectFailure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) {
    throw new Error("Expected failure")
  }
  return result.failure
}

const prepareOccurrence = (
  fixture: Fixture,
  runId: string
) =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-race",
    runId,
    artifactDigest: fixture.verified.artifactDigest,
    nodeId: "alpha",
    scopePath: [],
    activation: 0
  })

const prepareActivity = (
  fixture: Fixture,
  occurrence: Occurrence.PreparedOccurrence,
  operationId = "invoke-alpha"
) =>
  Operation.prepare(occurrence, {
    _tag: "Activity",
    operationVersion: Operation.OperationVersion,
    executionProtocolVersion: Operation.ExecutionProtocolVersion,
    operationId,
    attempt: 1,
    purpose: {
      _tag: "NodeHandler",
      purposeVersion: 1,
      nodeDefinitionKey: fixture.alphaBinding.nodeDefinitionKey,
      handlerBuildDigest: fixture.alphaBinding.handlerBuild.buildDigest
    },
    input: {
      _tag: "Inline",
      value: { value: "input" }
    },
    successContract: {
      _tag: "NodeOutputAggregate",
      contractReferenceVersion: 1,
      nodeDefinitionKey: fixture.alphaBinding.nodeDefinitionKey
    },
    errorContract: {
      _tag: "ArtifactCodec",
      contractReferenceVersion: 1,
      codecKey: fixture.alphaFailure.key,
      schemaDigest: fixture.alphaFailure.schemaDigest
    }
  })

const prepareTimer = (
  occurrence: Occurrence.PreparedOccurrence,
  operationId = "deadline"
) =>
  Operation.prepare(occurrence, {
    _tag: "Timer",
    operationVersion: Operation.OperationVersion,
    executionProtocolVersion: Operation.ExecutionProtocolVersion,
    operationId,
    generation: 0,
    owner: { _tag: "Sleep" },
    delayMillis: 1_000
  })

const prepareDeferred = (
  fixture: Fixture,
  occurrence: Occurrence.PreparedOccurrence,
  operationId = "signal",
  useAlphaCodecs = false
) => {
  const success = useAlphaCodecs ? fixture.text : fixture.number
  const failure = useAlphaCodecs
    ? fixture.alphaFailure
    : fixture.betaFailure
  return Operation.prepare(occurrence, {
    _tag: "Deferred",
    operationVersion: Operation.OperationVersion,
    executionProtocolVersion: Operation.ExecutionProtocolVersion,
    operationId,
    generation: 0,
    successCodecKey: success.key,
    errorCodecKey: failure.key,
    successSchemaDigest: success.schemaDigest,
    errorSchemaDigest: failure.schemaDigest
  })
}

interface PreparedRace {
  readonly occurrence: Occurrence.PreparedOccurrence
  readonly activity: Operation.PreparedOperation
  readonly timer: Operation.PreparedOperation
  readonly deferred: Operation.PreparedOperation
  readonly race: Operation.PreparedOperation
  readonly activityResolution: Executables.ResolvedNodeHandlerActivity
  readonly deferredResolution: Executables.ResolvedDeferredCodecs
  readonly ordered: ReadonlyArray<
    Executables.ResolvedRaceParticipant
  >
}

const prepareRace = (
  fixture: Fixture,
  mode: Operation.RaceMode,
  runId = `run-${mode}`
) =>
  Effect.gen(function*() {
    const occurrence = yield* prepareOccurrence(fixture, runId)
    const activity = yield* prepareActivity(fixture, occurrence)
    const timer = yield* prepareTimer(occurrence)
    const deferred = yield* prepareDeferred(fixture, occurrence)
    const race = yield* Operation.prepareRace(
      occurrence,
      {
        _tag: "Race",
        operationVersion: Operation.OperationVersion,
        executionProtocolVersion: Operation.ExecutionProtocolVersion,
        operationId: "main-race",
        generation: 0,
        mode,
        loserDisposition: "InterruptWaiters",
        outcomeEnvelopeVersion: 1
      },
      [
        ["handler", activity],
        ["deadline", timer],
        ["signal", deferred]
      ]
    )
    const activityResolution = expectSuccess(
      Executables.resolveActivity(
        fixture.resolvedArtifact,
        activity
      )
    )
    if (activityResolution._tag !== "NodeHandler") {
      return yield* Effect.die(
        "Expected node-handler activity resolution"
      )
    }
    const deferredResolution = expectSuccess(
      Executables.resolveDeferred(
        fixture.resolvedArtifact,
        deferred
      )
    )
    return {
      occurrence,
      activity,
      timer,
      deferred,
      race,
      activityResolution,
      deferredResolution,
      ordered: [
        activityResolution,
        timer as Executables.ResolvedRaceTimer,
        deferredResolution
      ]
    } satisfies PreparedRace
  })

const raceEnvelope = (
  prepared: PreparedRace,
  index: number
) => {
  const race = prepared.race.document
  if (race._tag !== "Race") {
    throw new Error("Expected Race document")
  }
  const participant = race.participants[index]!
  return {
    outcomeEnvelopeVersion: 1 as const,
    participantId: participant.participantId,
    index,
    participantOperationDigest: participant.operationDigest
  }
}

const verifyRaceDocument = (
  document: Extract<
    Operation.OperationDocument,
    { readonly _tag: "Race" }
  >
) =>
  Effect.gen(function*() {
    return yield* Operation.verify({
      document,
      operationDigest: yield* DigestV3.operation(document)
    })
  })

describe("SemanticExecutableRegistryV3 race resolution", () => {
  it.effect("resolves FirstSettled to exact ordered participants, Exit envelopes, Never, and merged context", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareRace(
        fixture,
        "FirstSettled"
      )
      const resolved = expectSuccess(Executables.resolveRace(
        fixture.resolvedArtifact,
        prepared.race,
        prepared.ordered
      ))

      assert.isTrue(Executables.isResolvedRace(resolved))
      assert.isTrue(Object.isFrozen(resolved))
      assert.isTrue(Object.isFrozen(resolved.participants))
      assert.strictEqual(resolved.artifact, fixture.resolvedArtifact)
      assert.strictEqual(resolved.operation, prepared.race)
      assert.strictEqual(
        resolved.participants[0],
        prepared.activityResolution
      )
      assert.strictEqual(resolved.participants[1], prepared.timer)
      assert.strictEqual(
        resolved.participants[2],
        prepared.deferredResolution
      )
      assert.strictEqual(resolved.errorSchema, Schema.Never)
      assert.strictEqual(
        Context.get(
          resolved.context as Context.Context<RaceCodecService>,
          RaceCodecService
        ),
        fixture.alphaService
      )

      const decode = Schema.decodeUnknownResult(
        resolved.successSchema
      )
      const encodeJson = Schema.encodeUnknownResult(
        Schema.toCodecJson(resolved.successSchema)
      )
      assert.isTrue(Result.isSuccess(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 0),
        exit: Exit.succeed({ value: "alpha:input" })
      })))
      assert.isTrue(Result.isSuccess(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 0),
        exit: Exit.fail({ code: "DENIED" })
      })))
      assert.isTrue(Result.isSuccess(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 1),
        exit: Exit.succeed(undefined)
      })))
      assert.isTrue(Result.isSuccess(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        exit: Exit.succeed(42)
      })))
      assert.isTrue(Result.isSuccess(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        exit: Exit.fail({ reason: "DECLINED" })
      })))
      assert.isTrue(Result.isSuccess(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        exit: Exit.die({
          name: "Error",
          message: "boom"
        })
      })))
      assert.isTrue(Result.isSuccess(encodeJson({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 0),
        exit: Exit.fail({ code: "DENIED" })
      })))
      assert.isTrue(Result.isSuccess(encodeJson({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        exit: Exit.die(new Error("boom"))
      })))
      assert.isTrue(Result.isFailure(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        exit: Exit.succeed(42),
        unexpected: true
      })))
      assert.isTrue(Result.isFailure(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        participantId: "handler",
        exit: Exit.succeed(42)
      })))
      assert.isTrue(Result.isFailure(decode({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        index: 1,
        exit: Exit.succeed(42)
      })))
    }).pipe(provideCrypto))

  it.effect("derives identified FirstSuccess success and typed-failure unions while defects remain outside the typed channel", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareRace(
        fixture,
        "FirstSuccess"
      )
      const resolved = expectSuccess(Executables.resolveRace(
        fixture.resolvedArtifact,
        prepared.race,
        prepared.ordered
      ))
      const decodeSuccess = Schema.decodeUnknownResult(
        resolved.successSchema
      )
      const decodeError = Schema.decodeUnknownResult(
        resolved.errorSchema
      )

      assert.notStrictEqual(resolved.errorSchema, Schema.Never)
      assert.isTrue(Result.isSuccess(decodeSuccess({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 0),
        value: { value: "alpha:input" }
      })))
      assert.isTrue(Result.isSuccess(decodeSuccess({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 1),
        value: undefined
      })))
      assert.isTrue(Result.isSuccess(decodeSuccess({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 2),
        value: 42
      })))
      assert.isTrue(Result.isSuccess(decodeError({
        _tag: "RaceFailure",
        ...raceEnvelope(prepared, 0),
        error: { code: "DENIED" }
      })))
      assert.isTrue(Result.isSuccess(decodeError({
        _tag: "RaceFailure",
        ...raceEnvelope(prepared, 2),
        error: { reason: "DECLINED" }
      })))
      assert.isTrue(Result.isFailure(decodeSuccess({
        _tag: "RaceWinner",
        ...raceEnvelope(prepared, 0),
        value: { value: "alpha:input" },
        unexpected: true
      })))
      assert.isTrue(Result.isFailure(decodeError({
        _tag: "RaceFailure",
        ...raceEnvelope(prepared, 0),
        error: { code: "DENIED" },
        unexpected: true
      })))
      assert.isTrue(Result.isFailure(decodeError({
        _tag: "RaceFailure",
        ...raceEnvelope(prepared, 1),
        error: "impossible"
      })))
      assert.isTrue(Result.isFailure(decodeError({
        _tag: "RaceFailure",
        ...raceEnvelope(prepared, 2),
        error: {
          _tag: "Die",
          defect: "not-a-typed-failure"
        }
      })))
    }).pipe(provideCrypto))

  it.effect("rejects structural copies, arbitrary effects, and hostile resolution arrays", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareRace(
        fixture,
        "FirstSettled",
        "run-provenance"
      )
      const resolved = expectSuccess(Executables.resolveRace(
        fixture.resolvedArtifact,
        prepared.race,
        prepared.ordered
      ))
      assert.isFalse(Executables.isResolvedRace({ ...resolved }))

      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          { ...fixture.resolvedArtifact },
          prepared.race,
          prepared.ordered
        )).code,
        Executables.ErrorCodes.UnresolvedArtifact
      )
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          { ...prepared.race },
          prepared.ordered
        )).code,
        Executables.ErrorCodes.UnpreparedOperation
      )

      const copiedActivity = [...prepared.ordered]
      copiedActivity[0] = {
        ...prepared.activityResolution
      } as Executables.ResolvedNodeHandlerActivity
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          copiedActivity
        )).code,
        Executables.ErrorCodes.UntrustedExecutable
      )

      const copiedTimer = [...prepared.ordered]
      copiedTimer[1] = {
        ...prepared.timer
      } as Executables.ResolvedRaceTimer
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          copiedTimer
        )).code,
        Executables.ErrorCodes.UnpreparedOperation
      )

      const copiedDeferred = [...prepared.ordered]
      copiedDeferred[2] = {
        ...prepared.deferredResolution
      } as Executables.ResolvedDeferredCodecs
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          copiedDeferred
        )).code,
        Executables.ErrorCodes.UntrustedExecutable
      )

      const arbitrary = [...prepared.ordered]
      arbitrary[0] = Effect.succeed("not admitted") as never
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          arbitrary
        )).code,
        Executables.ErrorCodes.UntrustedExecutable
      )

      let getterReads = 0
      const hostile: Array<
        Executables.ResolvedRaceParticipant
      > = []
      Object.defineProperty(hostile, "0", {
        enumerable: true,
        get() {
          getterReads++
          return prepared.activityResolution
        }
      })
      hostile.length = 1
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          hostile
        )).code,
        Executables.ErrorCodes.InvalidExecutable
      )
      assert.strictEqual(getterReads, 0)
    }).pipe(provideCrypto))

  it.effect("rejects count, kind, order, digest, contracts, artifact, and occurrence drift", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareRace(
        fixture,
        "FirstSettled",
        "run-drift"
      )

      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          prepared.ordered.slice(0, 2)
        )).code,
        Executables.ErrorCodes.PinMismatch
      )
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          [
            prepared.timer as Executables.ResolvedRaceTimer,
            prepared.activityResolution,
            prepared.deferredResolution
          ]
        )).code,
        Executables.ErrorCodes.UntrustedExecutable
      )

      const firstDeferred = yield* prepareDeferred(
        fixture,
        prepared.occurrence,
        "first-signal",
        true
      )
      const secondDeferred = yield* prepareDeferred(
        fixture,
        prepared.occurrence,
        "second-signal"
      )
      const deferredRace = yield* Operation.prepareRace(
        prepared.occurrence,
        {
          _tag: "Race",
          operationVersion: Operation.OperationVersion,
          executionProtocolVersion: Operation.ExecutionProtocolVersion,
          operationId: "ordered-deferred-race",
          generation: 0,
          mode: "FirstSettled",
          loserDisposition: "InterruptWaiters",
          outcomeEnvelopeVersion: 1
        },
        [
          ["first", firstDeferred],
          ["second", secondDeferred]
        ]
      )
      const firstResolution = expectSuccess(
        Executables.resolveDeferred(
          fixture.resolvedArtifact,
          firstDeferred
        )
      )
      const secondResolution = expectSuccess(
        Executables.resolveDeferred(
          fixture.resolvedArtifact,
          secondDeferred
        )
      )
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          deferredRace,
          [secondResolution, firstResolution]
        )).code,
        Executables.ErrorCodes.PinMismatch
      )

      if (prepared.race.document._tag !== "Race") {
        return yield* Effect.die("Expected Race document")
      }
      const digestDocument = {
        ...prepared.race.document,
        participants: prepared.race.document.participants.map(
          (participant, index) =>
            index === 0
              ? {
                ...participant,
                operationDigest: digest("f")
              }
              : participant
        )
      } as Extract<
        Operation.OperationDocument,
        { readonly _tag: "Race" }
      >
      const digestRace = yield* verifyRaceDocument(digestDocument)
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          digestRace,
          prepared.ordered
        )).code,
        Executables.ErrorCodes.PinMismatch
      )

      const contractDocument = {
        ...prepared.race.document,
        participants: prepared.race.document.participants.map(
          (participant, index) =>
            index === 0
              ? {
                ...participant,
                successContract: {
                  _tag: "NodeOutputAggregate" as const,
                  contractReferenceVersion: 1 as const,
                  nodeDefinitionKey: fixture.betaBinding.nodeDefinitionKey
                }
              }
              : participant
        )
      } as Extract<
        Operation.OperationDocument,
        { readonly _tag: "Race" }
      >
      const contractRace = yield* verifyRaceDocument(
        contractDocument
      )
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          contractRace,
          prepared.ordered
        )).code,
        Executables.ErrorCodes.PinMismatch
      )

      const otherFixture = yield* makeFixture()
      const otherPrepared = yield* prepareRace(
        otherFixture,
        "FirstSettled",
        "run-drift"
      )
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          prepared.race,
          [
            otherPrepared.activityResolution,
            prepared.timer as Executables.ResolvedRaceTimer,
            prepared.deferredResolution
          ]
        )).code,
        Executables.ErrorCodes.ArtifactMismatch
      )

      const otherOccurrence = yield* prepareOccurrence(
        fixture,
        "run-other-occurrence"
      )
      const otherTimer = yield* prepareTimer(
        otherOccurrence,
        "other-deadline"
      )
      const occurrenceDocument = {
        ...prepared.race.document,
        participants: prepared.race.document.participants.map(
          (participant, index) =>
            index === 1
              ? {
                ...participant,
                operationDigest: otherTimer.operationDigest
              }
              : participant
        )
      } as Extract<
        Operation.OperationDocument,
        { readonly _tag: "Race" }
      >
      const occurrenceRace = yield* verifyRaceDocument(
        occurrenceDocument
      )
      assert.strictEqual(
        expectFailure(Executables.resolveRace(
          fixture.resolvedArtifact,
          occurrenceRace,
          [
            prepared.activityResolution,
            otherTimer as Executables.ResolvedRaceTimer,
            prepared.deferredResolution
          ]
        )).code,
        Executables.ErrorCodes.ArtifactMismatch
      )
    }).pipe(provideCrypto))

  it.effect("rejects conflicting participant codec contexts and accepts identical service identity", () =>
    Effect.gen(function*() {
      const sharedFixture = yield* makeFixture()
      const sharedPrepared = yield* prepareRace(
        sharedFixture,
        "FirstSettled",
        "run-shared-context"
      )
      const shared = expectSuccess(Executables.resolveRace(
        sharedFixture.resolvedArtifact,
        sharedPrepared.race,
        sharedPrepared.ordered
      ))
      assert.strictEqual(
        Context.get(
          shared.context as Context.Context<RaceCodecService>,
          RaceCodecService
        ),
        sharedFixture.alphaService
      )
      assert.strictEqual(
        sharedFixture.alphaService,
        sharedFixture.betaService
      )

      const conflictFixture = yield* makeFixture(true)
      const conflictPrepared = yield* prepareRace(
        conflictFixture,
        "FirstSettled",
        "run-conflicting-context"
      )
      const conflict = expectFailure(Executables.resolveRace(
        conflictFixture.resolvedArtifact,
        conflictPrepared.race,
        conflictPrepared.ordered
      ))
      assert.strictEqual(
        conflict.code,
        Executables.ErrorCodes.ConflictingExecutable
      )
      assert.strictEqual(conflict.operation, "resolveRace")
      assert.include(conflict.message, RaceCodecService.key)
      assert.include(conflict.message, "handler")
      assert.include(conflict.message, "signal")
    }).pipe(provideCrypto))
})
