import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
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

interface CodecWitnessValue {
  readonly id: string
  readonly encoded: Array<string>
  readonly decoded: Array<string>
}

class CodecWitness extends Context.Service<
  CodecWitness,
  CodecWitnessValue
>()("EffectWorkflowSemanticV3DeferredTest/CodecWitness") {}

const makeWitness = (id: string): CodecWitnessValue => ({
  id,
  encoded: [],
  decoded: []
})

const witnessedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.gen(function*() {
          const witness = yield* CodecWitness
          witness.decoded.push(value)
          return value
        }),
      encode: (value) =>
        Effect.gen(function*() {
          const witness = yield* CodecWitness
          witness.encoded.push(value)
          return value
        })
    })
  )
)

const nodeConfigSchema = Schema.Struct({})
const nodeFailureSchema = Schema.Never
const deferredSuccessSchema = Schema.Struct({
  value: witnessedString
})
const deferredErrorSchema = Schema.Struct({
  code: witnessedString
})
const workflowSuccessSchema = Schema.Struct({
  value: Schema.String
})
const workflowDeferredErrorSchema = Schema.Struct({
  code: Schema.String
})
const workflowErrorSchema = Schema.Union([
  workflowDeferredErrorSchema,
  NativeSemantic.EffectWorkflowSemanticError
])

const deferredNode = Node.make("deferred-node", {
  version: "1",
  config: nodeConfigSchema,
  inputs: {},
  outputs: {},
  failure: nodeFailureSchema
})

const nodeRegistry = Registry.make(deferredNode)

const definition = Workflow.make("semantic-deferred-definition", {
  version: "1",
  inputs: {
    deferredSuccess: Port.output(deferredSuccessSchema, {
      contract: "semantic-deferred/success",
      fanOut: "single"
    })
  },
  outputs: {
    deferredError: Port.input(deferredErrorSchema, {
      contract: "semantic-deferred/error",
      required: false
    })
  },
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
  id: "semantic-deferred-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "deferred-node",
    type: deferredNode.type,
    version: deferredNode.version,
    config: {}
  }],
  edges: []
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
    const codecVersion = "1"
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

const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolvedArtifact: Executables.ResolvedArtifactExecutables
  readonly successPin: PlanStoreV3.CodecPin
  readonly errorPin: PlanStoreV3.CodecPin
}

const makeFixture = (
  successWitness: CodecWitnessValue,
  errorWitness: CodecWitnessValue
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "semantic-deferred-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      deferredNode.type,
      deferredNode.version,
      "semantic-deferred-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "semantic-deferred-classifier",
      "1",
      "semantic-deferred-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("deferred-node-config", {
        type: "object",
        additionalProperties: false
      }),
      codecPin("deferred-node-failure", { not: {} }),
      codecPin("deferred-success", {
        type: "object",
        required: ["value"],
        additionalProperties: false,
        properties: {
          value: { type: "string" }
        }
      }),
      codecPin("deferred-error", {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: {
          code: { type: "string" }
        }
      })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const configCodecKey = PlanStoreV3.codecKey(
      "deferred-node-config",
      "1"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "deferred-node-failure",
      "1"
    )
    const successCodecKey = PlanStoreV3.codecKey(
      "deferred-success",
      "1"
    )
    const errorCodecKey = PlanStoreV3.codecKey(
      "deferred-error",
      "1"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      deferredNode.type,
      deferredNode.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "semantic-deferred-classifier",
      "1"
    )
    const activityPolicy = {
      policyVersion: 3,
      retry: {
        retryPolicyVersion: 3,
        maximumAttempts: 1,
        maximumElapsed: { _tag: "Unlimited" },
        classifier: {
          classifierPinVersion: 3,
          classifierId: "semantic-deferred-classifier",
          classifierVersion: "1",
          buildDigest: classifierBuild.buildDigest
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
    } satisfies ActivityPolicyV3.Policy
    const inputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: [{
        name: "deferredSuccess",
        contract: "semantic-deferred/success",
        fanOut: "single",
        codecKey: successCodecKey
      }]
    }
    const outputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Output" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: [{
        name: "deferredError",
        contract: "semantic-deferred/error",
        cardinality: "one",
        required: false,
        codecKey: errorCodecKey
      }]
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
        digest: yield* DigestV3.boundaryContract(inputBoundaryDocument)
      },
      outputBoundary: {
        document: outputBoundaryDocument,
        digest: yield* DigestV3.boundaryContract(outputBoundaryDocument)
      },
      nodeDefinitions: [{
        manifestVersion: 3,
        key: nodeDefinitionKey,
        nodeType: deferredNode.type,
        nodeVersion: deferredNode.version,
        configCodecKey,
        failureCodecKey,
        inputs: [],
        outputs: []
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "semantic-deferred-classifier",
        classifierVersion: "1",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "deferred-node",
        nodeType: deferredNode.type,
        nodeVersion: deferredNode.version,
        nodeDefinitionKey,
        queue: "semantic-deferred-queue",
        handlerBuild,
        activityPolicy
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const handlers = yield* nodeRegistry.toHandlers(nodeRegistry.of({
      "deferred-node@1": () => Effect.succeed({})
    }))
    const catalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        Deployment.workflowDefinition(
          "semantic-deferred-definition",
          definition
        )
      ],
      handlerDefinitions: [
        Deployment.handlerDefinition(
          "semantic-deferred-handler",
          deferredNode
        )
      ]
    })
    const deployedHandlers = yield* DeploymentHandlers.make([
      DeploymentHandlers.handlerDeployment(
        "semantic-deferred-handler",
        handlers
      )
    ]).pipe(
      Effect.provideService(Deployment.DeploymentCatalog, catalog)
    )
    const workflowExecutable = yield* Executables.workflowDefinition(
      catalog,
      definitionBuild
    )
    const nodeExecutable = expectSuccess(Executables.nodeHandler(
      deployedHandlers,
      handlerBuild
    ))

    const configPin = codecs.find((pin) => pin.key === configCodecKey)!
    const failurePin = codecs.find((pin) => pin.key === failureCodecKey)!
    const successPin = codecs.find((pin) => pin.key === successCodecKey)!
    const errorPin = codecs.find((pin) => pin.key === errorCodecKey)!
    const configExecutable = yield* Executables.codec(
      configPin,
      nodeConfigSchema
    )
    const failureExecutable = yield* Executables.codec(
      failurePin,
      nodeFailureSchema
    )
    const successExecutable = yield* Executables.codec(
      successPin,
      deferredSuccessSchema
    ).pipe(Effect.provideService(CodecWitness, successWitness))
    const errorExecutable = yield* Executables.codec(
      errorPin,
      deferredErrorSchema
    ).pipe(Effect.provideService(CodecWitness, errorWitness))
    const classifierExecutable = yield* Executables.retryClassifier(
      artifact.policyExecutableBuilds[0]!,
      () =>
        Effect.succeed({
          _tag: "NonRetryable" as const,
          classificationVersion: 1 as const
        })
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      nodeExecutable,
      configExecutable,
      failureExecutable,
      successExecutable,
      errorExecutable,
      classifierExecutable
    ])
    const resolvedArtifact = yield* registry.resolveArtifact(verified)
    return {
      verified,
      resolvedArtifact,
      successPin,
      errorPin
    } satisfies Fixture
  })

const prepareDeferred = (
  fixture: Fixture,
  generation: number
) =>
  Effect.gen(function*() {
    const occurrence = yield* Occurrence.prepare({
      occurrenceVersion: Occurrence.OccurrenceVersion,
      executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
      tenantId: "tenant-1",
      runId: "run-1",
      artifactDigest: fixture.verified.artifactDigest,
      nodeId: "deferred-node",
      scopePath: [],
      activation: 0
    })
    const operation = yield* Operation.prepare(occurrence, {
      _tag: "Deferred",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: Operation.ExecutionProtocolVersion,
      operationId: "external-decision",
      generation,
      successCodecKey: fixture.successPin.key,
      errorCodecKey: fixture.errorPin.key,
      successSchemaDigest: fixture.successPin.schemaDigest,
      errorSchemaDigest: fixture.errorPin.schemaDigest
    })
    return {
      operation,
      resolution: expectSuccess(Executables.resolveDeferred(
        fixture.resolvedArtifact,
        operation
      ))
    }
  })

const DeferredWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/Deferred",
  {
    payload: {
      id: Schema.String
    },
    success: workflowSuccessSchema,
    error: workflowErrorSchema,
    idempotencyKey: ({ id }) => id
  }
)

const decodeWorkflowSuccess = (input: unknown) =>
  expectSuccess(
    Schema.decodeUnknownResult(workflowSuccessSchema)(input)
  )

const decodeWorkflowError = (input: unknown) =>
  expectSuccess(
    Schema.decodeUnknownResult(workflowErrorSchema)(input)
  )

const pollUntilObserved = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* DeferredWorkflow.poll(executionId)
    if (Option.isSome(polled)) return polled.value
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Deferred workflow did not expose observable state")
})

const pollUntilComplete = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* DeferredWorkflow.poll(executionId)
    if (
      Option.isSome(polled) &&
      polled.value._tag === "Complete"
    ) {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Deferred workflow did not complete")
})

const registration = (
  resolution: Executables.ResolvedDeferredCodecs,
  token: Deferred.Deferred<NativeDeferred.Token>
) =>
  DeferredWorkflow.toLayer(() =>
    Effect.gen(function*() {
      yield* Deferred.succeed(
        token,
        yield* NativeSemantic.deferredToken(resolution)
      )
      const value = yield* NativeSemantic.awaitDeferred(
        resolution
      ).pipe(Effect.mapError(decodeWorkflowError))
      return decodeWorkflowSuccess(value)
    })
  )

describe("EffectWorkflowSemanticV3 deferred operations", () => {
  it.effect("binds exact codecs, rejects invalid ingress, and replays one immutable success", () =>
    Effect.gen(function*() {
      const witness = makeWitness("shared")
      const fixture = yield* makeFixture(witness, witness)
      const first = yield* prepareDeferred(fixture, 0)
      const other = yield* prepareDeferred(fixture, 1)
      const tokenLatch = yield* Deferred.make<NativeDeferred.Token>()
      const workflowLayer = registration(
        first.resolution,
        tokenLatch
      )

      assert.isTrue(
        Executables.isResolvedDeferredCodecs(first.resolution)
      )
      assert.isFalse(
        Executables.isResolvedDeferredCodecs({
          ...first.resolution
        })
      )
      assert.notStrictEqual(
        first.resolution.success,
        first.resolution.error
      )
      assert.strictEqual(
        Context.get(
          first.resolution.context as Context.Context<CodecWitness>,
          CodecWitness
        ),
        witness
      )

      const structuralCopy = yield* NativeSemantic.deferredToken({
        ...first.resolution
      }).pipe(Effect.flip)
      assert.strictEqual(
        structuralCopy.code,
        NativeSemantic.ErrorCodes.InvalidActivityResolution
      )

      yield* Effect.gen(function*() {
        const payload = { id: "deferred-success" }
        const executionId = yield* DeferredWorkflow.execute(
          payload,
          { discard: true }
        )
        const token = yield* Deferred.await(tokenLatch)
        const suspended = yield* pollUntilObserved(executionId)
        assert.strictEqual(suspended._tag, "Suspended")

        const copiedResolution = yield* NativeSemantic.succeedDeferred(
          { ...first.resolution },
          token,
          { value: "copied" }
        ).pipe(Effect.flip)
        assert.strictEqual(
          copiedResolution.code,
          NativeSemantic.ErrorCodes.InvalidActivityResolution
        )

        const malformed = yield* NativeSemantic.succeedDeferred(
          first.resolution,
          "not-a-token",
          { value: "malformed" }
        ).pipe(Effect.flip)
        assert.strictEqual(
          malformed.code,
          NativeSemantic.ErrorCodes.InvalidDeferredToken
        )

        const parsed = NativeDeferred.TokenParsed.fromString(token)
        const nonCanonical = Encoding.encodeBase64Url(
          JSON.stringify(
            [
              parsed.workflowName,
              parsed.executionId,
              parsed.deferredName
            ],
            null,
            1
          )
        )
        assert.notStrictEqual(nonCanonical, token)
        assert(Result.isSuccess(
          Schema.decodeUnknownResult(
            NativeDeferred.TokenParsed.FromString
          )(nonCanonical)
        ))
        const rejectedNonCanonical = yield* NativeSemantic
          .succeedDeferred(
            first.resolution,
            nonCanonical,
            { value: "noncanonical" }
          )
          .pipe(Effect.flip)
        assert.strictEqual(
          rejectedNonCanonical.code,
          NativeSemantic.ErrorCodes.InvalidDeferredToken
        )

        const crossDeferred = yield* NativeSemantic.succeedDeferred(
          other.resolution,
          token,
          { value: "crossed" }
        ).pipe(Effect.flip)
        assert.strictEqual(
          crossDeferred.code,
          NativeSemantic.ErrorCodes.InvalidDeferredToken
        )

        const invalidValue = yield* NativeSemantic.succeedDeferred(
          first.resolution,
          token,
          { value: 42 }
        ).pipe(Effect.flip)
        assert.strictEqual(
          invalidValue.code,
          NativeSemantic.ErrorCodes.InvalidDeferredCompletion
        )
        assert.strictEqual(
          (yield* pollUntilObserved(executionId))._tag,
          "Suspended"
        )

        yield* NativeSemantic.succeedDeferred(
          first.resolution,
          token,
          { value: "approved" }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, {
            value: "approved"
          })
        }
        assert.include(witness.encoded, "approved")
        assert.include(witness.decoded, "approved")

        const decodedCount = witness.decoded.length
        assert.deepStrictEqual(
          yield* DeferredWorkflow.execute(payload),
          { value: "approved" }
        )
        assert.strictEqual(witness.decoded.length, decodedCount)

        yield* NativeSemantic.succeedDeferred(
          first.resolution,
          token,
          { value: "ignored-second-completion" }
        )
        assert.deepStrictEqual(
          yield* DeferredWorkflow.execute(payload),
          { value: "approved" }
        )
        assert.strictEqual(witness.decoded.length, decodedCount)
      }).pipe(
        Effect.provide(
          workflowLayer.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("rejects invalid failure values before recording one typed failure", () =>
    Effect.gen(function*() {
      const witness = makeWitness("failure")
      const fixture = yield* makeFixture(witness, witness)
      const prepared = yield* prepareDeferred(fixture, 0)
      const tokenLatch = yield* Deferred.make<NativeDeferred.Token>()
      const workflowLayer = registration(
        prepared.resolution,
        tokenLatch
      )

      yield* Effect.gen(function*() {
        const executionId = yield* DeferredWorkflow.execute(
          { id: "deferred-failure" },
          { discard: true }
        )
        const token = yield* Deferred.await(tokenLatch)
        assert.strictEqual(
          (yield* pollUntilObserved(executionId))._tag,
          "Suspended"
        )

        const invalidFailure = yield* NativeSemantic.failDeferred(
          prepared.resolution,
          token,
          { code: 42 }
        ).pipe(Effect.flip)
        assert.strictEqual(
          invalidFailure.code,
          NativeSemantic.ErrorCodes.InvalidDeferredCompletion
        )
        assert.strictEqual(
          (yield* pollUntilObserved(executionId))._tag,
          "Suspended"
        )

        yield* NativeSemantic.failDeferred(
          prepared.resolution,
          token,
          { code: "DENIED" }
        )
        const terminal = yield* pollUntilComplete(executionId)
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          const reason = terminal.exit.cause.reasons[0]
          assert.strictEqual(reason?._tag, "Fail")
          if (reason?._tag === "Fail") {
            assert.deepStrictEqual(reason.error, {
              code: "DENIED"
            })
          }
        }
        assert.include(witness.encoded, "DENIED")
        assert.include(witness.decoded, "DENIED")
      }).pipe(
        Effect.provide(
          workflowLayer.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("rejects conflicting success and error codec contexts during resolution", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(
        makeWitness("success"),
        makeWitness("error")
      )
      const occurrence = yield* Occurrence.prepare({
        occurrenceVersion: Occurrence.OccurrenceVersion,
        executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
        tenantId: "tenant-1",
        runId: "run-1",
        artifactDigest: fixture.verified.artifactDigest,
        nodeId: "deferred-node",
        scopePath: [],
        activation: 0
      })
      const operation = yield* Operation.prepare(occurrence, {
        _tag: "Deferred",
        operationVersion: Operation.OperationVersion,
        executionProtocolVersion: Operation.ExecutionProtocolVersion,
        operationId: "external-decision",
        generation: 0,
        successCodecKey: fixture.successPin.key,
        errorCodecKey: fixture.errorPin.key,
        successSchemaDigest: fixture.successPin.schemaDigest,
        errorSchemaDigest: fixture.errorPin.schemaDigest
      })
      const conflict = expectSuccess(Result.flip(
        Executables.resolveDeferred(
          fixture.resolvedArtifact,
          operation
        )
      ))

      assert.strictEqual(
        conflict.code,
        Executables.ErrorCodes.ConflictingExecutable
      )
      assert.strictEqual(conflict.executableKind, "Codec")
      assert.include(conflict.message, CodecWitness.key)
      assert.include(conflict.message, "Deferred")
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))
})
