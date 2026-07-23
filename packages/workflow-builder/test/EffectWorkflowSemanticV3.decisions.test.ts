import { assert, describe, it } from "@effect/vitest"
import type * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
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
import * as Wire from "../src/ProtocolV3Wire.ts"
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

const configSchema = Schema.Struct({})
const failureSchema = Schema.Never
const outputSchema = Schema.Number

const decisionNode = Node.make("decision-node", {
  version: "1",
  config: configSchema,
  inputs: {},
  outputs: {
    value: Port.output(outputSchema, {
      contract: "semantic-decisions/number"
    })
  },
  failure: failureSchema
})

const nodeRegistry = Registry.make(decisionNode)

const definition = Workflow.make("semantic-decision-workflow", {
  version: "1",
  inputs: {},
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
  id: "semantic-decision-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "decision-node",
    type: decisionNode.type,
    version: decisionNode.version,
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

const decisionPolicy = (
  classifierBuildDigest: Wire.BuildDigest,
  options: {
    readonly jitter?: ActivityPolicyV3.Jitter
    readonly delayMillis?: number
  } = {}
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 3,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "semantic-decision-classifier",
      classifierVersion: "1",
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
      delayMillis: options.delayMillis ?? 250
    },
    jitter: options.jitter ?? { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: { _tag: "Disabled" },
    startToClose: { _tag: "Disabled" },
    scheduleToClose: { _tag: "Disabled" }
  }
})

interface DecisionFixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolvedArtifact: Executables.ResolvedArtifactExecutables
  readonly binding: PlanStoreV3.NodeBinding
  readonly classifierKey: string
  readonly classifierExecutable: Executables.RetryClassifierExecutable
}

const makeFixture = (
  classifier: (
    failure: ActivityPolicyV3.RetryFailureCause
  ) => Effect.Effect<ActivityPolicyV3.RetryClassification>,
  policyOptions: {
    readonly jitter?: ActivityPolicyV3.Jitter
    readonly delayMillis?: number
  } = {}
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "semantic-decision-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      decisionNode.type,
      decisionNode.version,
      "semantic-decision-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "semantic-decision-classifier",
      "1",
      "semantic-decision-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("decision-config", {
        type: "object",
        additionalProperties: false
      }),
      codecPin("decision-failure", { not: {} }),
      codecPin("decision-number", { type: "number" })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const configCodecKey = PlanStoreV3.codecKey(
      "decision-config",
      "1"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "decision-failure",
      "1"
    )
    const numberCodecKey = PlanStoreV3.codecKey(
      "decision-number",
      "1"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      decisionNode.type,
      decisionNode.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "semantic-decision-classifier",
      "1"
    )
    const inputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: []
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
    const policy = decisionPolicy(
      classifierBuild.buildDigest,
      policyOptions
    )
    const artifact: PlanStoreV3.StaticDagArtifact = {
      artifactVersion: 3,
      artifactKind: "StaticDag",
      executionProtocolVersion: 3,
      fingerprintDocument: compiled.fingerprintDocument,
      compiledFingerprint: yield* DigestV3.compiledPlan(
        compiled.fingerprintDocument
      ),
      workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(definition.id),
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
        nodeType: decisionNode.type,
        nodeVersion: decisionNode.version,
        configCodecKey,
        failureCodecKey,
        inputs: [],
        outputs: [{
          name: "value",
          contract: "semantic-decisions/number",
          fanOut: "multiple",
          codecKey: numberCodecKey
        }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "semantic-decision-classifier",
        classifierVersion: "1",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "decision-node",
        nodeType: decisionNode.type,
        nodeVersion: decisionNode.version,
        nodeDefinitionKey,
        queue: "semantic-decision-queue",
        handlerBuild,
        activityPolicy: policy
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const handlers = yield* nodeRegistry.toHandlers(
      nodeRegistry.of({
        "decision-node@1": () => Effect.succeed({ value: 0 })
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
          handlerBuild.deploymentId,
          decisionNode
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
      Executables.nodeHandler(deployedHandlers, handlerBuild)
    )
    const runtimeSchemas: Readonly<Record<string, Schema.Top>> = {
      "decision-config": configSchema,
      "decision-failure": failureSchema,
      "decision-number": outputSchema
    }
    const codecExecutables = yield* Effect.forEach(
      codecs,
      (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
    )
    const classifierExecutable = yield* Executables.retryClassifier(
      artifact.policyExecutableBuilds[0]!,
      classifier
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      nodeExecutable,
      ...codecExecutables,
      classifierExecutable
    ])
    const resolvedArtifact = yield* registry.resolveArtifact(verified)

    return {
      verified,
      resolvedArtifact,
      binding: artifact.nodeBindings[0]!,
      classifierKey,
      classifierExecutable
    } satisfies DecisionFixture
  })

const builtIn = (
  schema: Operation.BuiltInSchemaName
) => ({
  _tag: "BuiltIn" as const,
  contractReferenceVersion: 1 as const,
  vocabularyVersion: 1 as const,
  schema
})

const inline = (value: Schema.Json) => ({
  _tag: "Inline" as const,
  value
})

const blob = {
  _tag: "Blob" as const,
  ref: {
    blobVersion: 1 as const,
    digest: digest("f"),
    encodedBytes: 32,
    mediaType: "application/json"
  }
}

interface DecisionResolutions {
  readonly classifier: Executables.ResolvedRetryClassifierActivity
  readonly delay: Executables.ResolvedRetryDelaySelectionActivity
  readonly time: Executables.ResolvedTimeObservationActivity
}

const makeResolutions = (
  fixture: DecisionFixture,
  inputs: {
    readonly classifier?: unknown
    readonly delay?: unknown
    readonly time?: unknown
  } = {}
) =>
  Effect.gen(function*() {
    const occurrence = yield* Occurrence.prepare({
      occurrenceVersion: Occurrence.OccurrenceVersion,
      executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
      tenantId: "tenant-decisions",
      runId: "run-decisions",
      artifactDigest: fixture.verified.artifactDigest,
      nodeId: fixture.binding.nodeId,
      scopePath: [],
      activation: 0
    })
    const classifierOperation = yield* Operation.prepare(occurrence, {
      _tag: "Activity",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: Operation.ExecutionProtocolVersion,
      operationId: "classify-failure",
      attempt: 1,
      purpose: {
        _tag: "RetryClassifier",
        purposeVersion: 1,
        failedActivityDigest: digest("a"),
        classifierKey: fixture.classifierKey,
        classifierBuildDigest: fixture.binding.activityPolicy.retry.classifier.buildDigest
      },
      input: inputs.classifier ?? inline({
        _tag: "AttemptTimeout",
        failureCauseVersion: 1,
        activityDigest: digest("a"),
        attempt: 1,
        timeoutKind: "StartToClose"
      }),
      successContract: builtIn("RetryClassification"),
      errorContract: builtIn("Never")
    })
    const delayOperation = yield* Operation.prepare(occurrence, {
      _tag: "Activity",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: Operation.ExecutionProtocolVersion,
      operationId: "select-retry-delay",
      attempt: 1,
      purpose: {
        _tag: "RetryDelaySelection",
        purposeVersion: 1,
        failedActivityDigest: digest("a"),
        classificationActivityDigest: classifierOperation.operationDigest
      },
      input: inputs.delay ?? inline({
        evaluationVersion: 1,
        failedAttempt: 1,
        elapsedMillis: 0
      }),
      successContract: builtIn("RecordedRetryDelay"),
      errorContract: builtIn("Never")
    })
    const timeOperation = yield* Operation.prepare(occurrence, {
      _tag: "Activity",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: Operation.ExecutionProtocolVersion,
      operationId: "observe-time",
      attempt: 1,
      purpose: {
        _tag: "TimeObservation",
        purposeVersion: 1,
        ownerOperationDigest: delayOperation.operationDigest,
        observationKind: "Failure"
      },
      input: inputs.time ?? inline(null),
      successContract: builtIn("CanonicalTimestamp"),
      errorContract: builtIn("Never")
    })

    const classifier = expectSuccess(
      Executables.resolveActivity(
        fixture.resolvedArtifact,
        classifierOperation
      )
    )
    const delay = expectSuccess(
      Executables.resolveActivity(
        fixture.resolvedArtifact,
        delayOperation
      )
    )
    const time = expectSuccess(
      Executables.resolveActivity(
        fixture.resolvedArtifact,
        timeOperation
      )
    )
    if (
      classifier._tag !== "RetryClassifier" ||
      delay._tag !== "RetryDelaySelection" ||
      time._tag !== "TimeObservation"
    ) {
      return yield* Effect.die(
        "Decision operations resolved to unexpected activity purposes"
      )
    }
    return { classifier, delay, time } satisfies DecisionResolutions
  })

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const DecisionResult = Schema.Struct({
  classification: ActivityPolicyV3.RetryClassification,
  delay: ActivityPolicyV3.RecordedRetryDelay,
  observedAt: Wire.Timestamp
})

const DecisionWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/Decisions",
  {
    payload: { id: Schema.String },
    success: DecisionResult,
    error: NativeSemantic.EffectWorkflowSemanticError,
    idempotencyKey: ({ id }) => id
  }
)

const DefectWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/DecisionDefect",
  {
    payload: { id: Schema.String },
    success: Schema.String,
    error: NativeSemantic.EffectWorkflowSemanticError,
    idempotencyKey: ({ id }) => id
  }
)

const pollUntilObserved = Effect.fnUntraced(function*<
  W extends NativeWorkflow.AnyWithProps
>(
  workflow: W,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* workflow.poll(executionId)
    if (Option.isSome(polled)) return polled.value
    yield* Effect.yieldNow
  }
  return yield* Effect.die(
    "Native workflow did not expose observable state"
  )
})

const pollUntilComplete = Effect.fnUntraced(function*<
  W extends NativeWorkflow.AnyWithProps
>(
  workflow: W,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* workflow.poll(executionId)
    if (
      Option.isSome(polled) &&
      polled.value._tag === "Complete"
    ) {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native workflow did not complete")
})

describe("EffectWorkflowSemanticV3 durable decisions", () => {
  it.effect("records classifier, selected delay, and TestClock observation exactly once across replay", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture(() =>
        Effect.sync(() => {
          classifierRuns++
          return {
            _tag: "Retryable" as const,
            classificationVersion: 1 as const
          }
        })
      )
      const resolutions = yield* makeResolutions(fixture)
      let workflowPasses = 0
      const initialMillis = Date.parse(
        "2026-01-02T03:04:05.006Z"
      )
      const replayMillis = Date.parse(
        "2030-06-07T08:09:10.011Z"
      )
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowSemanticV3/DecisionReplayGate"
      )
      const token = yield* Deferred.make<NativeDeferred.Token>()
      const registration = DecisionWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const classification = yield* NativeSemantic.retryClassifier(
            resolutions.classifier,
            { interruptRetryPolicy: noInterruptRetry }
          )
          const delay = yield* NativeSemantic.retryDelaySelection(
            resolutions.delay,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )
          const observedAt = yield* NativeSemantic.timeObservation(
            resolutions.time,
            { interruptRetryPolicy: noInterruptRetry }
          )
          yield* Deferred.succeed(
            token,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return { classification, delay, observedAt }
        })
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(initialMillis)
        const executionId = yield* DecisionWorkflow.execute(
          { id: "durable-decisions-replay" },
          { discard: true }
        )
        const completionToken = yield* Deferred.await(token)
        const suspended = yield* pollUntilObserved(
          DecisionWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")
        assert.strictEqual(workflowPasses, 1)
        assert.strictEqual(classifierRuns, 1)

        yield* TestClock.setTime(replayMillis)
        yield* NativeDeferred.succeed(gate, {
          token: completionToken,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          DecisionWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, {
            classification: {
              _tag: "Retryable",
              classificationVersion: 1
            },
            delay: {
              recordingVersion: 1,
              failedAttempt: 1,
              nextAttempt: 2,
              retryOrdinal: 1,
              baseDelayMillis: 250,
              minimumDelayMillis: 250,
              maximumDelayMillis: 250,
              selectedDelayMillis: 250
            },
            observedAt: "2026-01-02T03:04:05.006Z"
          })
        }
        assert.strictEqual(workflowPasses, 2)
        assert.strictEqual(classifierRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("samples internal Random entropy inside the inclusive jitter bounds", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(
        () =>
          Effect.succeed({
            _tag: "Retryable" as const,
            classificationVersion: 1 as const
          }),
        {
          jitter: {
            _tag: "RecordedRange",
            minimumPermille: 500,
            maximumPermille: 1_500
          }
        }
      )
      const resolutions = yield* makeResolutions(fixture)
      let randomRuns = 0
      const random = {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => {
          randomRuns++
          return 1 - Number.EPSILON
        }
      }
      const registration = DefectWorkflow.toLayer(() =>
        NativeSemantic.retryDelaySelection(
          resolutions.delay,
          {
            interruptRetryPolicy: noInterruptRetry
          }
        ).pipe(
          Effect.map((delay) => String(delay.selectedDelayMillis))
        )
      )

      yield* Effect.gen(function*() {
        const executionId = yield* DefectWorkflow.execute(
          { id: "internal-jitter-bounds" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          DefectWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "375")
        }
        assert.strictEqual(randomRuns, 1)
      }).pipe(
        Effect.provideService(Random.Random, random),
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("rejects DoNotRetry and blob inputs before invoking entropy, classifier, or native execution", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture(() =>
        Effect.sync(() => {
          classifierRuns++
          return {
            _tag: "Retryable" as const,
            classificationVersion: 1 as const
          }
        })
      )
      const denied = yield* makeResolutions(fixture, {
        delay: inline({
          evaluationVersion: 1,
          failedAttempt: 3,
          elapsedMillis: 0
        })
      })
      const deniedFailure = yield* NativeSemantic
        .retryDelaySelection(denied.delay, {
          interruptRetryPolicy: noInterruptRetry
        })
        .pipe(Effect.flip)
      assert.strictEqual(
        deniedFailure.code,
        NativeSemantic.ErrorCodes.InvalidActivityInput
      )
      assert.include(
        deniedFailure.message,
        "AttemptLimitReached"
      )

      const blobResolutions = yield* makeResolutions(fixture, {
        classifier: blob,
        delay: blob,
        time: blob
      })
      const classifierFailure = yield* NativeSemantic
        .retryClassifier(blobResolutions.classifier, {
          interruptRetryPolicy: noInterruptRetry
        })
        .pipe(Effect.flip)
      const delayFailure = yield* NativeSemantic
        .retryDelaySelection(blobResolutions.delay, {
          interruptRetryPolicy: noInterruptRetry
        })
        .pipe(Effect.flip)
      const timeFailure = yield* NativeSemantic
        .timeObservation(blobResolutions.time, {
          interruptRetryPolicy: noInterruptRetry
        })
        .pipe(Effect.flip)
      for (
        const failure of [
          classifierFailure,
          delayFailure,
          timeFailure
        ]
      ) {
        assert.strictEqual(
          failure.code,
          NativeSemantic.ErrorCodes.UnsupportedBlobPayload
        )
      }
      assert.strictEqual(classifierRuns, 0)
    }).pipe(provideCrypto))

  it.effect("rejects copied and wrong-purpose resolutions before decision execution", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture(() =>
        Effect.sync(() => {
          classifierRuns++
          return {
            _tag: "Retryable" as const,
            classificationVersion: 1 as const
          }
        })
      )
      const resolutions = yield* makeResolutions(fixture)

      const copiedClassifier = yield* NativeSemantic
        .retryClassifier(
          { ...resolutions.classifier },
          { interruptRetryPolicy: noInterruptRetry }
        )
        .pipe(Effect.flip)
      const copiedDelay = yield* NativeSemantic
        .retryDelaySelection(
          { ...resolutions.delay },
          {
            interruptRetryPolicy: noInterruptRetry
          }
        )
        .pipe(Effect.flip)
      const copiedTime = yield* NativeSemantic
        .timeObservation(
          { ...resolutions.time },
          { interruptRetryPolicy: noInterruptRetry }
        )
        .pipe(Effect.flip)

      const wrongClassifier = yield* NativeSemantic
        .retryClassifier(
          resolutions.delay as unknown as Executables.ResolvedRetryClassifierActivity,
          { interruptRetryPolicy: noInterruptRetry }
        )
        .pipe(Effect.flip)
      const wrongDelay = yield* NativeSemantic
        .retryDelaySelection(
          resolutions.time as unknown as Executables.ResolvedRetryDelaySelectionActivity,
          {
            interruptRetryPolicy: noInterruptRetry
          }
        )
        .pipe(Effect.flip)
      const wrongTime = yield* NativeSemantic
        .timeObservation(
          resolutions.classifier as unknown as Executables.ResolvedTimeObservationActivity,
          { interruptRetryPolicy: noInterruptRetry }
        )
        .pipe(Effect.flip)

      for (
        const failure of [
          copiedClassifier,
          copiedDelay,
          copiedTime,
          wrongClassifier,
          wrongDelay,
          wrongTime
        ]
      ) {
        assert.strictEqual(
          failure.code,
          NativeSemantic.ErrorCodes.InvalidActivityResolution
        )
      }
      assert.strictEqual(classifierRuns, 0)
    }).pipe(provideCrypto))
})
