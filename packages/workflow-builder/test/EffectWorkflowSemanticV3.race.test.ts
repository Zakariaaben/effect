import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as NativeSemantic from "../src/EffectWorkflowSemanticV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Operation from "../src/SemanticOperationV3.ts"
import * as Workflow from "../src/Workflow.ts"

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const textSchema = Schema.String
const configSchema = Schema.Struct({
  prefix: textSchema
})
const failureSchema = Schema.Struct({
  code: textSchema
})
const raceFailureSchema = Schema.Union([
  NativeSemantic.EffectWorkflowSemanticError,
  failureSchema
])

const raceNode = Node.make("NativeRaceStep", {
  version: "1.0.0",
  config: configSchema,
  inputs: {
    value: Port.input(textSchema, {
      contract: "native-race/text"
    })
  },
  outputs: {
    value: Port.output(textSchema, {
      contract: "native-race/text"
    })
  },
  failure: raceFailureSchema
})

const nodeRegistry = Registry.make(raceNode)

const definition = Workflow.make("native-race-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(textSchema, {
      contract: "native-race/text",
      fanOut: "single"
    })
  },
  outputs: {},
  nodes: nodeRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 2,
    maxEdges: 2,
    maxFanIn: 2,
    maxFanOut: 2,
    maxDepth: 2
  })
})

const plan = {
  formatVersion: 1 as const,
  id: "native-race-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "step",
    type: raceNode.type,
    version: raceNode.version,
    config: {
      prefix: "handled:"
    }
  }],
  edges: [{
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
  }]
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
      classifierId: "native-race-classifier",
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
  readonly binding: PlanStoreV3.NodeBinding
  readonly failureCodec: PlanStoreV3.CodecPin
  readonly textCodec: PlanStoreV3.CodecPin
}

const makeFixture = (
  handler: Node.Handler<typeof raceNode>
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "native-race-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      raceNode.type,
      raceNode.version,
      "native-race-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "native-race-classifier",
      "1.0.0",
      "native-race-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("native-race-config", {
        type: "object",
        additionalProperties: false,
        required: ["prefix"],
        properties: {
          prefix: { type: "string" }
        }
      }),
      codecPin("native-race-failure", {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["_tag", "code", "message"],
            properties: {
              _tag: {
                const: "EffectWorkflowSemanticError"
              },
              code: { type: "string" },
              message: { type: "string" },
              nodeId: { type: "string" },
              operationId: { type: "string" },
              currentDigest: { type: "string" },
              committedDigest: { type: "string" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["code"],
            properties: {
              code: { type: "string" }
            }
          }
        ]
      }),
      codecPin("native-race-text", {
        type: "string"
      })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const configCodecKey = PlanStoreV3.codecKey(
      "native-race-config",
      "1.0.0"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "native-race-failure",
      "1.0.0"
    )
    const textCodecKey = PlanStoreV3.codecKey(
      "native-race-text",
      "1.0.0"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      raceNode.type,
      raceNode.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "native-race-classifier",
      "1.0.0"
    )
    const inputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: [{
        name: "value",
        contract: "native-race/text",
        fanOut: "single" as const,
        codecKey: textCodecKey
      }]
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
      nodeDefinitions: [{
        manifestVersion: 3,
        key: nodeDefinitionKey,
        nodeType: raceNode.type,
        nodeVersion: raceNode.version,
        configCodecKey,
        failureCodecKey,
        inputs: [{
          name: "value",
          contract: "native-race/text",
          cardinality: "one",
          required: true,
          codecKey: textCodecKey
        }],
        outputs: [{
          name: "value",
          contract: "native-race/text",
          fanOut: "multiple",
          codecKey: textCodecKey
        }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "native-race-classifier",
        classifierVersion: "1.0.0",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "step",
        nodeType: raceNode.type,
        nodeVersion: raceNode.version,
        nodeDefinitionKey,
        queue: "native-race-queue",
        handlerBuild,
        activityPolicy: activityPolicy(
          classifierBuild.buildDigest
        )
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const handlers = yield* nodeRegistry.toHandlers(nodeRegistry.of({
      "NativeRaceStep@1.0.0": handler
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
          raceNode
        )
      ]
    })
    const deployedHandlers = yield* DeploymentHandlers.make([
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
    const nodeExecutable = expectSuccess(
      Executables.nodeHandler(
        deployedHandlers,
        handlerBuild
      )
    )
    const runtimeSchemas = {
      "native-race-config": configSchema,
      "native-race-failure": raceFailureSchema,
      "native-race-text": textSchema
    } as const
    const codecExecutables = yield* Effect.forEach(
      verified.artifact.codecs,
      (pin) =>
        Executables.codec(
          pin,
          runtimeSchemas[
            pin.codecId as keyof typeof runtimeSchemas
          ]
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
      nodeExecutable,
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
      binding: verified.artifact.nodeBindings[0]!,
      failureCodec: pin("native-race-failure"),
      textCodec: pin("native-race-text")
    } satisfies Fixture
  })

const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const prepareOccurrence = (
  fixture: Fixture,
  runId: string
) =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-native-race",
    runId,
    artifactDigest: fixture.verified.artifactDigest,
    nodeId: fixture.binding.nodeId,
    scopePath: [],
    activation: 0
  })

const prepareActivity = (
  fixture: Fixture,
  occurrence: Occurrence.PreparedOccurrence,
  options: {
    readonly operationId: string
    readonly value: string
    readonly attempt?: number | undefined
  }
) =>
  Operation.prepare(occurrence, {
    _tag: "Activity",
    operationVersion: Operation.OperationVersion,
    executionProtocolVersion: Operation.ExecutionProtocolVersion,
    operationId: options.operationId,
    attempt: options.attempt ?? 1,
    purpose: {
      _tag: "NodeHandler",
      purposeVersion: 1,
      nodeDefinitionKey: fixture.binding.nodeDefinitionKey,
      handlerBuildDigest: fixture.binding.handlerBuild.buildDigest
    },
    input: {
      _tag: "Inline",
      value: { value: options.value }
    },
    successContract: {
      _tag: "NodeOutputAggregate",
      contractReferenceVersion: 1,
      nodeDefinitionKey: fixture.binding.nodeDefinitionKey
    },
    errorContract: {
      _tag: "ArtifactCodec",
      contractReferenceVersion: 1,
      codecKey: fixture.failureCodec.key,
      schemaDigest: fixture.failureCodec.schemaDigest
    }
  })

const prepareTimer = (
  occurrence: Occurrence.PreparedOccurrence,
  operationId: string
) =>
  Operation.prepare(occurrence, {
    _tag: "Timer",
    operationVersion: Operation.OperationVersion,
    executionProtocolVersion: Operation.ExecutionProtocolVersion,
    operationId,
    generation: 0,
    owner: { _tag: "Sleep" },
    delayMillis: 60_000
  })

const prepareDeferred = (
  fixture: Fixture,
  occurrence: Occurrence.PreparedOccurrence,
  operationId: string
) =>
  Operation.prepare(occurrence, {
    _tag: "Deferred",
    operationVersion: Operation.OperationVersion,
    executionProtocolVersion: Operation.ExecutionProtocolVersion,
    operationId,
    generation: 0,
    successCodecKey: fixture.textCodec.key,
    errorCodecKey: fixture.failureCodec.key,
    successSchemaDigest: fixture.textCodec.schemaDigest,
    errorSchemaDigest: fixture.failureCodec.schemaDigest
  })

const resolveParticipant = (
  fixture: Fixture,
  operation: Operation.PreparedOperation
): Executables.ResolvedRaceParticipant => {
  switch (operation.document._tag) {
    case "Activity": {
      const resolution = expectSuccess(
        Executables.resolveActivity(
          fixture.resolvedArtifact,
          operation
        )
      )
      if (resolution._tag !== "NodeHandler") {
        throw new Error("Expected node-handler activity resolution")
      }
      return resolution
    }
    case "Timer":
      return operation as Executables.ResolvedRaceTimer
    case "Deferred":
      return expectSuccess(Executables.resolveDeferred(
        fixture.resolvedArtifact,
        operation
      ))
    case "Race":
      throw new Error("Nested races are not participants")
  }
}

interface PreparedNativeRace {
  readonly operation: Operation.PreparedOperation
  readonly resolution: Executables.ResolvedRace
}

const prepareResolvedRace = (
  fixture: Fixture,
  occurrence: Occurrence.PreparedOccurrence,
  options: {
    readonly operationId: string
    readonly mode: Operation.RaceMode
    readonly participants: ReadonlyArray<
      readonly [string, Operation.PreparedOperation]
    >
  }
) =>
  Effect.gen(function*() {
    const operation = yield* Operation.prepareRace(
      occurrence,
      {
        _tag: "Race",
        operationVersion: Operation.OperationVersion,
        executionProtocolVersion: Operation.ExecutionProtocolVersion,
        operationId: options.operationId,
        generation: 0,
        mode: options.mode,
        loserDisposition: "InterruptWaiters",
        outcomeEnvelopeVersion: 1
      },
      options.participants
    )
    return {
      operation,
      resolution: expectSuccess(Executables.resolveRace(
        fixture.resolvedArtifact,
        operation,
        options.participants.map(([, participant]) => resolveParticipant(fixture, participant))
      ))
    } satisfies PreparedNativeRace
  })

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const RuntimeRaceWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/RuntimeRace",
  {
    payload: {
      id: Schema.String
    },
    success: Schema.String,
    error: Schema.Unknown,
    idempotencyKey: ({ id }) => id
  }
)

const pollUntilObserved = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* RuntimeRaceWorkflow.poll(executionId)
    if (Option.isSome(polled)) return polled.value
    yield* Effect.yieldNow
  }
  return yield* Effect.die(
    "Native workflow did not expose observable state"
  )
})

const pollUntilComplete = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = yield* pollUntilObserved(executionId)
    if (observed._tag === "Complete") return observed
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native workflow did not complete")
})

const workflowLayer = (
  execute: Effect.Effect<
    string,
    unknown,
    NativeSemantic.Requirements
  >
) =>
  RuntimeRaceWorkflow.toLayer(() => execute).pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory)
  )

describe("EffectWorkflowSemanticV3 native races", () => {
  it.effect("records an activity winner against a timer and replays it without rerunning the handler", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture((request) =>
        Effect.sync(() => {
          handlerRuns++
          return {
            value: `${request.config.prefix}${request.inputs.value}`
          }
        })
      )
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-activity-replay"
      )
      const activity = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "activity",
          value: "winner"
        }
      )
      const timer = yield* prepareTimer(occurrence, "timer")
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "activity-vs-timer",
          mode: "FirstSettled",
          participants: [
            ["activity", activity],
            ["timer", timer]
          ]
        }
      )
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowSemanticV3/RaceReplayGate"
      )
      const tokenLatch = yield* Deferred.make<
        NativeDeferred.Token
      >()
      const winners: Array<NativeSemantic.RaceResult> = []
      const registration = workflowLayer(
        Effect.gen(function*() {
          const winner = yield* NativeSemantic.race(
            prepared.resolution,
            { interruptRetryPolicy: noInterruptRetry }
          )
          winners.push(winner)
          yield* Deferred.succeed(
            tokenLatch,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return winner.participantId
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "activity-replay" },
          { discard: true }
        )
        const token = yield* Deferred.await(tokenLatch)
        assert.strictEqual(
          (yield* pollUntilObserved(executionId))._tag,
          "Suspended"
        )
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(winners[0]?.participantId, "activity")

        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(executionId)
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "activity")
        }
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(winners.length, 2)
        assert.strictEqual(winners[1]?.participantId, "activity")
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))

  it.effect("lets an early deferred failure win FirstSettled against a late activity success", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture((request) =>
        Effect.succeed({
          value: `${request.config.prefix}${request.inputs.value}`
        }).pipe(Effect.delay("1 second"))
      )
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-deferred-failure"
      )
      const deferred = yield* prepareDeferred(
        fixture,
        occurrence,
        "external-signal"
      )
      const activity = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "late-activity",
          value: "late"
        }
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "deferred-vs-late",
          mode: "FirstSettled",
          participants: [
            ["late", activity],
            ["signal", deferred]
          ]
        }
      )
      const deferredResolution = resolveParticipant(
        fixture,
        deferred
      )
      if (
        !Executables.isResolvedDeferredCodecs(deferredResolution)
      ) {
        return yield* Effect.die(
          "Expected deferred codec resolution"
        )
      }
      const tokenLatch = yield* Deferred.make<
        NativeDeferred.Token
      >()
      const startGate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowSemanticV3/DeferredRaceStart"
      )
      const startGateTokenLatch = yield* Deferred.make<
        NativeDeferred.Token
      >()
      let winner: NativeSemantic.RaceResult | undefined
      const registration = workflowLayer(
        Effect.gen(function*() {
          yield* Deferred.succeed(
            tokenLatch,
            yield* NativeSemantic.deferredToken(
              deferredResolution
            )
          )
          yield* Deferred.succeed(
            startGateTokenLatch,
            yield* NativeDeferred.token(startGate)
          )
          yield* NativeDeferred.await(startGate)
          winner = yield* NativeSemantic.race(
            prepared.resolution,
            { interruptRetryPolicy: noInterruptRetry }
          )
          return winner.participantId
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "deferred-failure" },
          { discard: true }
        )
        const token = yield* Deferred.await(tokenLatch)
        const startGateToken = yield* Deferred.await(
          startGateTokenLatch
        )
        assert.strictEqual(
          (yield* pollUntilObserved(executionId))._tag,
          "Suspended"
        )

        yield* NativeSemantic.failDeferred(
          deferredResolution,
          token,
          { code: "EARLY_FAILURE" }
        )
        yield* NativeDeferred.succeed(startGate, {
          token: startGateToken,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(executionId)
        assert(
          Exit.isSuccess(terminal.exit),
          Exit.isFailure(terminal.exit)
            ? Cause.pretty(terminal.exit.cause)
            : undefined
        )
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "signal")
        }
        assert.strictEqual(winner?._tag, "RaceWinner")
        if (winner?._tag === "RaceWinner" && "exit" in winner) {
          assert(Exit.isFailure(winner.exit))
          if (Exit.isFailure(winner.exit)) {
            const failure = winner.exit.cause.reasons.find(
              (reason) => reason._tag === "Fail"
            )
            assert.deepStrictEqual(
              failure?._tag === "Fail"
                ? failure.error
                : undefined,
              { code: "EARLY_FAILURE" }
            )
          }
        }
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))

  it.effect("keeps an admitted EffectWorkflowSemanticError instance typed in FirstSettled", () =>
    Effect.gen(function*() {
      const semanticFailure = new NativeSemantic.EffectWorkflowSemanticError({
        code: NativeSemantic.ErrorCodes.InvalidActivityInput,
        message: "admitted race business failure"
      })
      const fixture = yield* makeFixture(() => Effect.fail(semanticFailure))
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-semantic-looking-first-settled"
      )
      const activity = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "semantic-looking-failure",
          value: "semantic"
        }
      )
      const timer = yield* prepareTimer(
        occurrence,
        "semantic-looking-timer"
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "semantic-looking-first-settled",
          mode: "FirstSettled",
          participants: [
            ["semantic", activity],
            ["timer", timer]
          ]
        }
      )
      let winner: NativeSemantic.RaceResult | undefined
      const registration = workflowLayer(
        Effect.gen(function*() {
          winner = yield* NativeSemantic.race(
            prepared.resolution,
            { interruptRetryPolicy: noInterruptRetry }
          )
          return winner.participantId
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "semantic-looking-first-settled" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(
          Exit.isSuccess(terminal.exit),
          Exit.isFailure(terminal.exit)
            ? Cause.pretty(terminal.exit.cause)
            : undefined
        )
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "semantic")
        }
        assert.strictEqual(winner?._tag, "RaceWinner")
        if (winner?._tag !== "RaceWinner" || !("exit" in winner)) {
          return
        }
        assert(Exit.isFailure(winner.exit))
        if (Exit.isSuccess(winner.exit)) return
        const typed = winner.exit.cause.reasons.find(
          (reason) => reason._tag === "Fail"
        )
        assert.isDefined(typed)
        if (typed?._tag === "Fail") {
          assert.instanceOf(
            typed.error,
            NativeSemantic.EffectWorkflowSemanticError
          )
          assert.strictEqual(
            typed.error.code,
            NativeSemantic.ErrorCodes.InvalidActivityInput
          )
        }
        assert.strictEqual(
          winner.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          ),
          undefined
        )
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))

  it.effect("keeps an admitted EffectWorkflowSemanticError instance identified in FirstSuccess", () =>
    Effect.gen(function*() {
      const semanticFailure = new NativeSemantic.EffectWorkflowSemanticError({
        code: NativeSemantic.ErrorCodes.InvalidActivityInput,
        message: "admitted first-success business failure"
      })
      const fixture = yield* makeFixture(() => Effect.fail(semanticFailure))
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-semantic-looking-first-success"
      )
      const semantic = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "semantic-looking-first-success-failure",
          value: "semantic"
        }
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "semantic-looking-first-success",
          mode: "FirstSuccess",
          participants: [
            ["semantic", semantic]
          ]
        }
      )
      const registration = workflowLayer(
        NativeSemantic.race(
          prepared.resolution,
          { interruptRetryPolicy: noInterruptRetry }
        ).pipe(Effect.as("unreachable"))
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "semantic-looking-first-success" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) return
        const semanticReason = terminal.exit.cause.reasons.find(
          (reason) =>
            reason._tag === "Fail" &&
            typeof reason.error === "object" &&
            reason.error !== null &&
            (reason.error as { readonly participantId?: unknown })
                .participantId === "semantic"
        )
        assert.isDefined(
          semanticReason,
          Cause.pretty(terminal.exit.cause)
        )
        if (semanticReason?._tag === "Fail") {
          const failure = semanticReason.error as NativeSemantic.FirstSuccessRaceFailure
          assert.strictEqual(failure._tag, "RaceFailure")
          assert.instanceOf(
            failure.error,
            NativeSemantic.EffectWorkflowSemanticError
          )
          assert.strictEqual(
            (failure.error as NativeSemantic.EffectWorkflowSemanticError).code,
            NativeSemantic.ErrorCodes.InvalidActivityInput
          )
        }
        assert.strictEqual(
          terminal.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          ),
          undefined
        )
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))

  it.effect("records a non-interrupt defect as the FirstSettled winner", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture(() =>
        Effect.sync(() => {
          handlerRuns++
        }).pipe(
          Effect.andThen(Effect.die(new Error("race-boom")))
        )
      )
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-defect"
      )
      const activity = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "defect-activity",
          value: "defect"
        }
      )
      const timer = yield* prepareTimer(
        occurrence,
        "defect-timer"
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "defect-vs-timer",
          mode: "FirstSettled",
          participants: [
            ["defect", activity],
            ["timer", timer]
          ]
        }
      )
      let winner: NativeSemantic.RaceResult | undefined
      const registration = workflowLayer(
        Effect.gen(function*() {
          winner = yield* NativeSemantic.race(
            prepared.resolution,
            { interruptRetryPolicy: noInterruptRetry }
          )
          return winner.participantId
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "defect-winner" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(
          Exit.isSuccess(terminal.exit),
          Exit.isFailure(terminal.exit)
            ? Cause.pretty(terminal.exit.cause)
            : undefined
        )
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "defect")
        }
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(winner?._tag, "RaceWinner")
        if (winner?._tag === "RaceWinner" && "exit" in winner) {
          assert(Exit.isFailure(winner.exit))
          if (Exit.isFailure(winner.exit)) {
            const defect = winner.exit.cause.reasons.find(
              (reason) => reason._tag === "Die"
            )
            assert.strictEqual(
              defect?._tag === "Die" &&
                defect.defect instanceof Error
                ? defect.defect.message
                : undefined,
              "race-boom"
            )
          }
        }
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))

  it.effect("keeps identified FirstSuccess failures typed and participant defects native", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture((request) =>
        request.inputs.value === "typed"
          ? Effect.fail({ code: "TYPED" })
          : Effect.die(new Error("native-defect"))
      )
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-first-success-failures"
      )
      const typed = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "typed-failure",
          value: "typed"
        }
      )
      const defect = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "defect-failure",
          value: "defect"
        }
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "first-success-failures",
          mode: "FirstSuccess",
          participants: [
            ["typed", typed],
            ["defect", defect]
          ]
        }
      )
      const registration = workflowLayer(
        NativeSemantic.race(
          prepared.resolution,
          { interruptRetryPolicy: noInterruptRetry }
        ).pipe(Effect.as("unreachable"))
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "first-success-failures" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) return
        const typedFailure = terminal.exit.cause.reasons.find(
          (reason) =>
            reason._tag === "Fail" &&
            typeof reason.error === "object" &&
            reason.error !== null &&
            (reason.error as { readonly _tag?: unknown })._tag ===
              "RaceFailure"
        )
        assert.isDefined(typedFailure)
        if (typedFailure?._tag === "Fail") {
          assert.strictEqual(
            (
              typedFailure.error as NativeSemantic.FirstSuccessRaceFailure
            ).participantId,
            "typed"
          )
          assert.deepStrictEqual(
            (
              typedFailure.error as NativeSemantic.FirstSuccessRaceFailure
            ).error,
            { code: "TYPED" }
          )
        }
        const nativeDefect = terminal.exit.cause.reasons.find(
          (reason) => reason._tag === "Die"
        )
        assert.strictEqual(
          nativeDefect?._tag === "Die" &&
            nativeDefect.defect instanceof Error
            ? nativeDefect.defect.message
            : undefined,
          "native-defect"
        )
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))

  it.effect("rejects forged race resolutions before native execution", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture((request) =>
        Effect.sync(() => {
          handlerRuns++
          return {
            value: `${request.config.prefix}${request.inputs.value}`
          }
        })
      )
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-forged"
      )
      const activity = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "forged-activity",
          value: "forged"
        }
      )
      const timer = yield* prepareTimer(
        occurrence,
        "forged-timer"
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "forged-race",
          mode: "FirstSettled",
          participants: [
            ["activity", activity],
            ["timer", timer]
          ]
        }
      )
      const rejected = yield* NativeSemantic.race(
        { ...prepared.resolution },
        { interruptRetryPolicy: noInterruptRetry }
      ).pipe(Effect.flip)

      assert.strictEqual(
        rejected.code,
        NativeSemantic.ErrorCodes.InvalidRaceResolution
      )
      assert.strictEqual(handlerRuns, 0)
    }).pipe(provideCrypto))

  it.effect("binds every participant before starting any handler side effect", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture((request) =>
        Effect.sync(() => {
          handlerRuns++
          return {
            value: `${request.config.prefix}${request.inputs.value}`
          }
        })
      )
      const occurrence = yield* prepareOccurrence(
        fixture,
        "run-participant-drift"
      )
      const first = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "first-activity",
          value: "first"
        }
      )
      const staleSecond = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "second-activity",
          value: "stale"
        }
      )
      const currentSecond = yield* prepareActivity(
        fixture,
        occurrence,
        {
          operationId: "second-activity",
          value: "current"
        }
      )
      const prepared = yield* prepareResolvedRace(
        fixture,
        occurrence,
        {
          operationId: "participant-drift-race",
          mode: "FirstSettled",
          participants: [
            ["first", first],
            ["second", currentSecond]
          ]
        }
      )
      const registration = workflowLayer(
        Effect.andThen(
          NativeSemantic.bind(staleSecond),
          NativeSemantic.race(
            prepared.resolution,
            { interruptRetryPolicy: noInterruptRetry }
          ).pipe(Effect.as("unreachable"))
        )
      )

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeRaceWorkflow.execute(
          { id: "participant-drift" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) return
        const failure = terminal.exit.cause.reasons.find(
          (reason) =>
            reason._tag === "Fail" &&
            reason.error instanceof
              NativeSemantic.EffectWorkflowSemanticError
        )
        assert.isDefined(failure)
        if (
          failure?._tag === "Fail" &&
          failure.error instanceof
            NativeSemantic.EffectWorkflowSemanticError
        ) {
          assert.strictEqual(
            failure.error.code,
            NativeSemantic.ErrorCodes.DescriptorDrift
          )
          assert.strictEqual(
            failure.error.committedDigest,
            staleSecond.operationDigest
          )
          assert.strictEqual(
            failure.error.currentDigest,
            currentSecond.operationDigest
          )
        }
        assert.strictEqual(handlerRuns, 0)
      }).pipe(Effect.provide(registration))
    }).pipe(provideCrypto))
})
