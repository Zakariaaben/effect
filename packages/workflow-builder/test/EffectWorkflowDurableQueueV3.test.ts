import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as PersistedQueue from "effect/unstable/persistence/PersistedQueue"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeActivity from "effect/unstable/workflow/Activity"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as DurableQueue from "../src/EffectWorkflowDurableQueueV3.ts"
import * as Retry from "../src/EffectWorkflowRetryV3.ts"
import * as Semantic from "../src/EffectWorkflowSemanticV3.ts"
import * as Identity from "../src/Identity.ts"
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
const text = Schema.String
const config = Schema.Struct({ prefix: text })
const failure = Schema.Struct({ code: text })

const step = Node.make("DurableQueueStep", {
  version: "1.0.0",
  config,
  inputs: { value: Port.input(text, { contract: "durable-queue/text" }) },
  outputs: { value: Port.output(text, { contract: "durable-queue/text" }) },
  failure
})
const nodes = Registry.make(step)
const definition = Workflow.make("durable-queue-workflow", {
  version: "1.0.0",
  inputs: { value: Port.output(text, { contract: "durable-queue/text", fanOut: "single" }) },
  outputs: {},
  nodes,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({ maxNodes: 2, maxEdges: 2, maxFanIn: 2, maxFanOut: 2, maxDepth: 2 })
})
const plan = {
  formatVersion: 1 as const,
  id: "durable-queue-plan",
  revision: 1,
  definition: { id: definition.id, version: definition.version },
  nodes: [{ id: "step", type: step.type, version: step.version, config: { prefix: "queued:" } }],
  edges: [{
    _tag: "DataEdge" as const,
    id: "workflow-input-to-step",
    source: { _tag: "WorkflowInput" as const, input: "value" },
    target: { _tag: "NodeInput" as const, nodeId: "step", input: "value" }
  }]
}

const success = <A, E>(value: Result.Result<A, E>): A => {
  if (Result.isFailure(value)) throw value.failure
  return value.success
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

const codecPin = (codecId: string, encodedSchema: Schema.Json) =>
  Effect.gen(function*() {
    const codecVersion = "1.0.0"
    const key = PlanStoreV3.codecKey(codecId, codecVersion)
    const build = yield* buildPin("Codec", codecId, codecVersion, `codec:${codecId}`)
    const document: PlanStoreV3.EncodedSchemaDocument = {
      encodedSchemaVersion: 3,
      codecKey: key,
      codecId,
      codecVersion,
      format: "effect-schema-json/v1",
      schema: encodedSchema
    }
    return {
      codecPinVersion: 3,
      key,
      codecId,
      codecVersion,
      build,
      encodedSchema: document,
      schemaDigest: yield* DigestV3.encodedSchema(document)
    } satisfies PlanStoreV3.CodecPin
  })

interface Fixture {
  readonly artifact: PlanStoreV3.StaticDagArtifact
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolved: Executables.ResolvedArtifactExecutables
  readonly binding: PlanStoreV3.NodeBinding
  readonly failureCodec: PlanStoreV3.CodecPin
  readonly calls: Array<Node.HandlerRequest<typeof step>>
  readonly registry: Executables.SemanticExecutableRegistryV3
}

const fixture = (
  options: {
    readonly scheduleToStart?: boolean | undefined
    readonly startToClose?: boolean | undefined
    readonly scheduleToClose?: boolean | undefined
    readonly maximumAttempts?: number | undefined
    readonly retryableFailures?: boolean | undefined
    readonly retryDelayMillis?: number | undefined
  } = {}
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "durable-queue-definition"
    )
    const handlerBuild = yield* buildPin("NodeHandler", step.type, step.version, "durable-queue-handler")
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "durable-queue-classifier",
      "1.0.0",
      "durable-queue-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("durable-queue-config", {
        type: "object",
        additionalProperties: false,
        required: ["prefix"],
        properties: { prefix: { type: "string" } }
      }),
      codecPin("durable-queue-failure", {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { type: "string" } }
      }),
      codecPin("durable-queue-text", { type: "string" })
    ])
    codecs.sort((a, b) => a.key < b.key ? -1 : 1)
    const configKey = PlanStoreV3.codecKey("durable-queue-config", "1.0.0")
    const failureKey = PlanStoreV3.codecKey("durable-queue-failure", "1.0.0")
    const textKey = PlanStoreV3.codecKey("durable-queue-text", "1.0.0")
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(step.type, step.version)
    const classifierKey = PlanStoreV3.classifierKey("durable-queue-classifier", "1.0.0")
    const inputBoundary = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: { id: definition.id, version: definition.version },
      ports: [{ name: "value", contract: "durable-queue/text", fanOut: "single" as const, codecKey: textKey }]
    }
    const outputBoundary = {
      boundaryContractVersion: 3 as const,
      direction: "Output" as const,
      definition: { id: definition.id, version: definition.version },
      ports: []
    }
    const artifact: PlanStoreV3.StaticDagArtifact = {
      artifactVersion: 3,
      artifactKind: "StaticDag",
      executionProtocolVersion: 3,
      fingerprintDocument: compiled.fingerprintDocument,
      compiledFingerprint: yield* DigestV3.compiledPlan(compiled.fingerprintDocument),
      workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(definition.id),
      definition: { id: definition.id, version: definition.version, build: definitionBuild },
      inputBoundary: { document: inputBoundary, digest: yield* DigestV3.boundaryContract(inputBoundary) },
      outputBoundary: { document: outputBoundary, digest: yield* DigestV3.boundaryContract(outputBoundary) },
      nodeDefinitions: [{
        manifestVersion: 3,
        key: nodeDefinitionKey,
        nodeType: step.type,
        nodeVersion: step.version,
        configCodecKey: configKey,
        failureCodecKey: failureKey,
        inputs: [{
          name: "value",
          contract: "durable-queue/text",
          cardinality: "one",
          required: true,
          codecKey: textKey
        }],
        outputs: [{ name: "value", contract: "durable-queue/text", fanOut: "multiple", codecKey: textKey }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "durable-queue-classifier",
        classifierVersion: "1.0.0",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "step",
        nodeType: step.type,
        nodeVersion: step.version,
        nodeDefinitionKey,
        queue: "durable-queue",
        handlerBuild,
        activityPolicy: {
          policyVersion: 3,
          retry: {
            retryPolicyVersion: 3,
            maximumAttempts: options.maximumAttempts ?? 1,
            maximumElapsed: { _tag: "Unlimited" },
            classifier: {
              classifierPinVersion: 3,
              classifierId: "durable-queue-classifier",
              classifierVersion: "1.0.0",
              buildDigest: classifierBuild.buildDigest
            },
            failureIdentity: {
              _tag: "Constant",
              identityContractVersion: 1,
              errorTag: "DurableQueueFailure",
              errorCode: "DENIED"
            },
            nonRetryableErrorTags: [],
            nonRetryableErrorCodes: [],
            backoff: {
              _tag: "Fixed",
              delayMillis: options.retryDelayMillis ?? 1
            },
            jitter: { _tag: "NoJitter" }
          },
          timeouts: {
            scheduleToStart: options.scheduleToStart === true
              ? { _tag: "After", durationMillis: 1_000 }
              : { _tag: "Disabled" },
            startToClose: options.startToClose === true
              ? { _tag: "After", durationMillis: 1_000 }
              : { _tag: "Disabled" },
            scheduleToClose: options.scheduleToClose === true
              ? { _tag: "After", durationMillis: 1_000 }
              : { _tag: "Disabled" }
          }
        }
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(artifact, yield* DigestV3.artifact(artifact))
    const calls: Array<Node.HandlerRequest<typeof step>> = []
    const handlers = yield* nodes.toHandlers(nodes.of({
      "DurableQueueStep@1.0.0": ((request: Node.HandlerRequest<typeof step>) => {
        calls.push(request)
        return request.inputs.value === "fail" ||
            (
              request.inputs.value === "retry-once" &&
              calls.length === 1
            )
          ? Effect.fail({ code: "DENIED" })
          : Effect.succeed({ value: `${request.config.prefix}${request.inputs.value}` })
      }) as Node.Handler<typeof step>
    }))
    const catalog = yield* Deployment.makeMemory({
      workflowDefinitions: [Deployment.workflowDefinition(definitionBuild.deploymentId, definition)],
      handlerDefinitions: [Deployment.handlerDefinition(handlerBuild.deploymentId, step)]
    })
    const deployed = yield* DeploymentHandlers.make([
      DeploymentHandlers.handlerDeployment(handlerBuild.deploymentId, handlers)
    ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
    const workflowExecutable = yield* Executables.workflowDefinition(catalog, definitionBuild)
    const handlerExecutable = success(Executables.nodeHandler(deployed, handlerBuild))
    const schemas = {
      "durable-queue-config": config,
      "durable-queue-failure": failure,
      "durable-queue-text": text
    } as const
    const codecExecutables = yield* Effect.forEach(verified.artifact.codecs, (pin) =>
      Executables.codec(pin, schemas[pin.codecId as keyof typeof schemas]))
    const classifier = yield* Executables.retryClassifier(
      verified.artifact.policyExecutableBuilds[0]!,
      () =>
        Effect.succeed({
          _tag: options.retryableFailures === true
            ? "Retryable" as const
            : "NonRetryable" as const,
          classificationVersion: 1 as const
        })
    )
    const registry = yield* Executables.make([workflowExecutable, handlerExecutable, ...codecExecutables, classifier])
    return {
      artifact,
      verified,
      resolved: yield* registry.resolveArtifact(verified),
      binding: verified.artifact.nodeBindings[0]!,
      failureCodec: verified.artifact.codecs.find((pin) =>
        pin.key === failureKey
      )!,
      calls,
      registry
    } satisfies Fixture
  })

const attempt = (value: Fixture, runId: string, input: string) =>
  Effect.gen(function*() {
    const occurrence = yield* Occurrence.prepare({
      occurrenceVersion: Occurrence.OccurrenceVersion,
      executionProtocolVersion: 3,
      tenantId: "tenant-durable",
      runId,
      artifactDigest: value.verified.artifactDigest,
      nodeId: "step",
      scopePath: [],
      activation: 0
    })
    const operation = yield* Operation.prepare(occurrence, {
      _tag: "Activity",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: 3,
      operationId: "invoke-handler",
      attempt: 1,
      purpose: {
        _tag: "NodeAttempt",
        purposeVersion: 1,
        nodeDefinitionKey: value.binding.nodeDefinitionKey,
        handlerBuildDigest: value.binding.handlerBuild.buildDigest
      },
      input: { _tag: "Inline", value: { value: input } },
      successContract: {
        _tag: "BuiltIn",
        contractReferenceVersion: 1,
        vocabularyVersion: 2,
        schema: "NodeAttemptOutcome"
      },
      errorContract: { _tag: "BuiltIn", contractReferenceVersion: 1, vocabularyVersion: 2, schema: "Never" }
    })
    const resolution = success(Executables.resolveActivity(value.resolved, operation))
    if (resolution._tag !== "NodeAttempt") return yield* Effect.die("expected NodeAttempt")
    return { occurrence, operation, resolution }
  })

const noRetry = Schedule.recurs(0)
const queueLayer = PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreMemory))
const QueueWorkflow = NativeWorkflow.make("WorkflowBuilder/EffectWorkflowDurableQueueV3/Test", {
  payload: { id: Schema.String, input: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  idempotencyKey: ({ id }) => id
})
const BackendDriftWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowDurableQueueV3/BackendDrift",
  {
    payload: { id: Schema.String },
    success: Schema.Unknown,
    error: Schema.Unknown,
    idempotencyKey: ({ id }) => id
  }
)
const RetryQueueWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowDurableQueueV3/Retry",
  {
    payload: { id: Schema.String },
    success: Schema.Unknown,
    error: Schema.Unknown,
    idempotencyKey: ({ id }) => id
  }
)

const planStore = (
  value: Fixture,
  artifactAvailable = true,
  artifact: PlanStoreV3.StaticDagArtifact = value.artifact
): PlanStoreV3.PlanStoreV3.Service => ({
  getForRun: () => Effect.die("not used"),
  getArtifact: ({ artifactDigest, tenantId }) =>
    artifactAvailable &&
      artifactDigest === value.verified.artifactDigest
      ? Effect.succeed(artifact)
      : Effect.fail(
        new PlanStoreV3.ArtifactNotFound({
          tenantId,
          artifactDigest
        })
      )
})

const runtime = (
  value: Fixture,
  prepared: Effect.Effect.Success<ReturnType<typeof attempt>>,
  route: DurableQueue.PreparedWorkerRoute,
  options: {
    readonly artifactAvailable?: boolean | undefined
    readonly artifact?: PlanStoreV3.StaticDagArtifact | undefined
    readonly registry?:
      | Executables.SemanticExecutableRegistryV3.Service
      | undefined
    readonly secondAttempt?:
      | Effect.Effect.Success<
        ReturnType<typeof attempt>
      >
      | undefined
  } = {}
) => {
  const registration = QueueWorkflow.toLayer(() =>
    Effect.gen(function*() {
      const first = yield* DurableQueue.execute(route, prepared.resolution, {
        interruptRetryPolicy: noRetry,
        offerRetryPolicy: noRetry
      })
      const replay = yield* DurableQueue.execute(
        route,
        options.secondAttempt?.resolution ?? prepared.resolution,
        {
          interruptRetryPolicy: noRetry,
          offerRetryPolicy: noRetry
        }
      )
      return { first, replay }
    })
  )
  return Layer.mergeAll(
    registration,
    DurableQueue.worker(route, {
      concurrency: 1,
      nativeQueueMaxAttempts: 3,
      attestationRetryPolicy: noRetry
    })
  )
    .pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
      Layer.provideMerge(queueLayer),
      Layer.provideMerge(
        Layer.succeed(
          PlanStoreV3.PlanStoreV3,
          planStore(
            value,
            options.artifactAvailable !== false,
            options.artifact
          )
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          Executables.SemanticExecutableRegistryV3,
          options.registry ?? value.registry
        )
      ),
      Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto))
    )
}

const retryRuntime = (
  value: Fixture,
  invocation: Retry.PreparedRetryInvocation,
  route: DurableQueue.PreparedWorkerRoute
) => {
  const registration = RetryQueueWorkflow.toLayer(() =>
    Retry.executeWithExecutor(
      invocation,
      { interruptRetryPolicy: noRetry },
      DurableQueue.retryAttemptExecutor(route, {
        offerRetryPolicy: noRetry
      })
    )
  )
  return Layer.mergeAll(
    registration,
    DurableQueue.worker(route, {
      concurrency: 1,
      nativeQueueMaxAttempts: 3,
      attestationRetryPolicy: noRetry
    })
  ).pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(
      Layer.succeed(
        PlanStoreV3.PlanStoreV3,
        planStore(value)
      )
    ),
    Layer.provideMerge(
      Layer.succeed(
        Executables.SemanticExecutableRegistryV3,
        value.registry
      )
    ),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto))
  )
}

describe("EffectWorkflowDurableQueueV3", () => {
  it.effect("creates deterministic pinned routes and exact detached work payloads", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(value, "run-pins", "hello")
      const route = yield* DurableQueue.prepareRoute(prepared.resolution)
      const again = yield* DurableQueue.prepareRouteForNode(value.resolved, "step")
      const work = success(DurableQueue.makeWorkItem(route, prepared.resolution))
      assert.deepStrictEqual(route.document, again.document)
      assert.strictEqual(route.routeDigest, again.routeDigest)
      assert.strictEqual(work.route.routeDigest, route.routeDigest)
      assert.strictEqual(work.operation.operationDigest, prepared.operation.operationDigest)
      assert.strictEqual(
        work.handlerIdempotencyKey,
        Identity.durableActivityIdempotencyKey("tenant-durable", "run-pins", prepared.occurrence.occurrenceDigest)
      )
      assert.strictEqual(work.route.document.handlerBuildDigest, value.binding.handlerBuild.buildDigest)
    }).pipe(provideCrypto))

  it.effect("uses memory workflow and queue replay to invoke the handler once", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(value, "run-e2e", "once")
      const route = yield* DurableQueue.prepareRoute(prepared.resolution)
      const result = yield* Effect.exit(
        QueueWorkflow.execute({ id: "e2e-success", input: "once" }).pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die("durable queue workflow timed out") })
        )
      ).pipe(Effect.provide(runtime(value, prepared, route)))
      assert(Exit.isSuccess(result))
      if (Exit.isFailure(result)) return
      assert.strictEqual(
        (result.value as { first: { _tag: string }; replay: { _tag: string } }).first._tag,
        "Succeeded"
      )
      assert.deepStrictEqual(
        (result.value as { first: unknown; replay: unknown }).replay,
        (result.value as { first: unknown; replay: unknown }).first
      )
      assert.strictEqual(value.calls.length, 1)
    }).pipe(provideCrypto))

  it.effect("keeps a business failure in the ApplicationFailed vocabulary", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(value, "run-business", "fail")
      const route = yield* DurableQueue.prepareRoute(prepared.resolution)
      const result = yield* Effect.exit(
        QueueWorkflow.execute({ id: "business-failure", input: "fail" }).pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die("durable queue workflow timed out") })
        )
      ).pipe(Effect.provide(runtime(value, prepared, route)))
      assert(Exit.isSuccess(result))
      if (Exit.isFailure(result)) return
      assert.strictEqual((result.value as { first: { _tag: string } }).first._tag, "ApplicationFailed")
      assert.strictEqual(value.calls.length, 1)
    }).pipe(provideCrypto))

  it.effect("injects the queue transport under durable retry ownership", () =>
    Effect.gen(function*() {
      const value = yield* fixture({
        maximumAttempts: 2,
        retryableFailures: true,
        retryDelayMillis: 0
      })
      const seed = yield* attempt(
        value,
        "run-retry-executor",
        "retry-once"
      )
      const invocation = yield* Retry.prepare({
        artifact: value.resolved,
        occurrence: seed.occurrence,
        input: {
          _tag: "Inline",
          value: { value: "retry-once" }
        }
      })
      const route = yield* DurableQueue.prepareRouteForNode(
        value.resolved,
        "step"
      )
      const result = yield* Effect.exit(
        RetryQueueWorkflow.execute({
          id: "retry-executor"
        }).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.die("durable queue retry workflow timed out")
          })
        )
      ).pipe(
        Effect.provide(
          retryRuntime(value, invocation, route)
        )
      )

      assert(Exit.isSuccess(result))
      if (Exit.isFailure(result)) return
      assert.deepStrictEqual(result.value, {
        value: "queued:retry-once"
      })
      assert.strictEqual(value.calls.length, 2)
    }).pipe(provideCrypto))

  it.effect("rejects an injected executor receipt from another attempt", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const seed = yield* attempt(
        value,
        "run-forged-executor-receipt",
        "forged"
      )
      const invocation = yield* Retry.prepare({
        artifact: value.resolved,
        occurrence: seed.occurrence,
        input: {
          _tag: "Inline",
          value: { value: "forged" }
        }
      })
      const forgedExecutor: Retry.AttemptExecutor = (
        resolution,
        executionOptions
      ) =>
        Effect.map(
          Semantic.nodeAttemptCompletion(
            resolution,
            executionOptions
          ),
          (completion) => {
            if (
              Exit.isFailure(completion.exit) ||
              completion.exit.value._tag !== "Succeeded"
            ) {
              return completion
            }
            const outcome = completion.exit.value
            return new NativeActivity.Completed({
              exit: Exit.succeed({
                ...outcome,
                attempt: (outcome.attempt + 1) as typeof outcome.attempt
              }),
              completedAt: completion.completedAt
            })
          }
        )
      const registration = RetryQueueWorkflow.toLayer(() =>
        Retry.executeWithExecutor(
          invocation,
          { interruptRetryPolicy: noRetry },
          forgedExecutor
        )
      )
      const terminal = yield* Effect.exit(
        RetryQueueWorkflow.execute({
          id: "forged-executor-receipt"
        })
      ).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory),
            Layer.provideMerge(
              Layer.succeed(Crypto.Crypto, crypto)
            )
          )
        )
      )

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      const failureReason = terminal.cause.reasons.find(
        (reason) => reason._tag === "Fail"
      )
      assert.isDefined(failureReason)
      if (failureReason?._tag !== "Fail") return
      assert.strictEqual(
        (failureReason.error as Retry.EffectWorkflowRetryError)
          .code,
        Retry.ErrorCodes.OperationPreparationFailed
      )
      assert.strictEqual(value.calls.length, 1)
    }).pipe(provideCrypto))

  it.effect("rejects an injected executor without a worker-start timeout handshake", () =>
    Effect.gen(function*() {
      const value = yield* fixture({
        scheduleToStart: true,
        scheduleToClose: true
      })
      const seed = yield* attempt(
        value,
        "run-retry-timeout-contract",
        "must-not-run"
      )
      const invocation = yield* Retry.prepare({
        artifact: value.resolved,
        occurrence: seed.occurrence,
        input: {
          _tag: "Inline",
          value: { value: "must-not-run" }
        }
      })
      const route = yield* DurableQueue.prepareRouteForNode(
        value.resolved,
        "step"
      )
      const terminal = yield* Effect.exit(
        RetryQueueWorkflow.execute({
          id: "retry-timeout-contract"
        })
      ).pipe(
        Effect.provide(
          retryRuntime(value, invocation, route)
        )
      )

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      const failureReason = terminal.cause.reasons.find(
        (reason) => reason._tag === "Fail"
      )
      assert.isDefined(failureReason)
      if (failureReason?._tag !== "Fail") return
      assert.strictEqual(
        (failureReason.error as Retry.EffectWorkflowRetryError)
          .code,
        Retry.ErrorCodes.UnsupportedAttemptExecutor
      )
      assert.strictEqual(value.calls.length, 0)
    }).pipe(provideCrypto))

  it.effect("keeps schedule-to-close in the retry controller around the queue executor", () =>
    Effect.gen(function*() {
      const value = yield* fixture({
        scheduleToClose: true
      })
      const seed = yield* attempt(
        value,
        "run-queue-schedule-to-close",
        "deadline-success"
      )
      const invocation = yield* Retry.prepare({
        artifact: value.resolved,
        occurrence: seed.occurrence,
        input: {
          _tag: "Inline",
          value: { value: "deadline-success" }
        }
      })
      const route = yield* DurableQueue.prepareRouteForNode(
        value.resolved,
        "step"
      )
      const result = yield* Effect.exit(
        RetryQueueWorkflow.execute({
          id: "queue-schedule-to-close"
        })
      ).pipe(
        Effect.provide(
          retryRuntime(value, invocation, route)
        )
      )

      assert(Exit.isSuccess(result))
      if (Exit.isFailure(result)) return
      assert.deepStrictEqual(result.value, {
        value: "queued:deadline-success"
      })
      assert.strictEqual(value.calls.length, 1)
    }).pipe(provideCrypto))

  it.effect("persists worker attestation failure as a structured non-business defect", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(
        value,
        "run-attestation-failure",
        "must-not-run"
      )
      const route = yield* DurableQueue.prepareRoute(
        prepared.resolution
      )
      const terminal = yield* Effect.exit(
        QueueWorkflow.execute({
          id: "attestation-failure",
          input: "must-not-run"
        }).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
              Effect.die(
                "worker attestation failure left the workflow suspended"
              )
          })
        )
      ).pipe(
        Effect.provide(
          runtime(value, prepared, route, {
            artifactAvailable: false
          })
        )
      )

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      assert.isFalse(
        terminal.cause.reasons.some(
          (reason) => reason._tag === "Fail"
        )
      )
      const die = terminal.cause.reasons.find(
        (reason) => reason._tag === "Die"
      )
      assert.isDefined(die)
      if (die?._tag !== "Die") return
      const defect = die.defect as DurableQueue.WorkerDefect
      assert.strictEqual(
        defect._tag,
        "EffectWorkflowDurableQueueWorkerDefect"
      )
      assert.strictEqual(defect.defectVersion, 1)
      assert.strictEqual(
        defect.failure.code,
        DurableQueue.WorkerFailureCodes.ArtifactUnavailable
      )
      assert.strictEqual(
        defect.failure.operationDigest,
        prepared.operation.operationDigest
      )
      assert.strictEqual(
        defect.failure.routeDigest,
        route.routeDigest
      )
      assert.strictEqual(value.calls.length, 0)
    }).pipe(provideCrypto))

  it.effect("rejects an artifact whose content no longer matches its pin", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(
        value,
        "run-invalid-artifact",
        "must-not-run"
      )
      const route = yield* DurableQueue.prepareRoute(
        prepared.resolution
      )
      const artifact = {
        ...value.artifact,
        fingerprintDocument: {
          ...value.artifact.fingerprintDocument,
          semanticPlan: {
            ...value.artifact.fingerprintDocument.semanticPlan,
            revision: value.artifact.fingerprintDocument.semanticPlan
              .revision + 1
          }
        }
      } satisfies PlanStoreV3.StaticDagArtifact
      const terminal = yield* Effect.exit(
        QueueWorkflow.execute({
          id: "invalid-artifact",
          input: "must-not-run"
        })
      ).pipe(
        Effect.provide(
          runtime(value, prepared, route, { artifact })
        )
      )

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      const die = terminal.cause.reasons.find(
        (reason) => reason._tag === "Die"
      )
      assert.isDefined(die)
      if (die?._tag !== "Die") return
      const defect = die.defect as DurableQueue.WorkerDefect
      assert.strictEqual(
        defect.failure.code,
        DurableQueue.WorkerFailureCodes.ArtifactInvalid
      )
      assert.strictEqual(value.calls.length, 0)
    }).pipe(provideCrypto))

  it.effect("rejects a worker registry that cannot resolve the pinned artifact", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(
        value,
        "run-incomplete-registry",
        "must-not-run"
      )
      const route = yield* DurableQueue.prepareRoute(
        prepared.resolution
      )
      const registry = yield* Executables.make([])
      const terminal = yield* Effect.exit(
        QueueWorkflow.execute({
          id: "incomplete-registry",
          input: "must-not-run"
        })
      ).pipe(
        Effect.provide(
          runtime(value, prepared, route, { registry })
        )
      )

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      const die = terminal.cause.reasons.find(
        (reason) => reason._tag === "Die"
      )
      assert.isDefined(die)
      if (die?._tag !== "Die") return
      const defect = die.defect as DurableQueue.WorkerDefect
      assert.strictEqual(
        defect.failure.code,
        DurableQueue.WorkerFailureCodes
          .ArtifactResolutionFailed
      )
      assert.strictEqual(value.calls.length, 0)
    }).pipe(provideCrypto))

  it.effect("rejects unsupported distributed start-timeout policies before enqueue", () =>
    Effect.gen(function*() {
      for (
        const policy of [
          { scheduleToStart: true },
          { startToClose: true }
        ] as const
      ) {
        const value = yield* fixture(policy)
        const prepared = yield* attempt(
          value,
          `run-unsupported-${Object.keys(policy)[0]}`,
          "must-not-run"
        )
        const route = yield* DurableQueue.prepareRoute(
          prepared.resolution
        )
        const result = DurableQueue.makeWorkItem(
          route,
          prepared.resolution
        )
        assert(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(
            result.failure.code,
            DurableQueue.ErrorCodes.UnsupportedPolicy
          )
        }
        assert.strictEqual(value.calls.length, 0)
      }
    }).pipe(provideCrypto))

  it.effect("rejects direct-to-queue backend drift before enqueue", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(
        value,
        "run-backend-drift",
        "direct-only"
      )
      const route = yield* DurableQueue.prepareRoute(
        prepared.resolution
      )
      const registration = BackendDriftWorkflow.toLayer(() =>
        Effect.gen(function*() {
          yield* Semantic.nodeAttempt(prepared.resolution, {
            interruptRetryPolicy: noRetry
          })
          return yield* DurableQueue.execute(
            route,
            prepared.resolution,
            {
              interruptRetryPolicy: noRetry,
              offerRetryPolicy: noRetry
            }
          )
        })
      )
      const layer = registration.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory),
        Layer.provideMerge(queueLayer)
      )
      const terminal = yield* Effect.exit(
        BackendDriftWorkflow.execute({
          id: "direct-to-queue"
        })
      ).pipe(Effect.provide(layer))

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      const failureReason = terminal.cause.reasons.find(
        (reason) => reason._tag === "Fail"
      )
      assert.isDefined(failureReason)
      if (failureReason?._tag !== "Fail") return
      assert.strictEqual(
        (failureReason.error as Semantic.EffectWorkflowSemanticError)
          .code,
        Semantic.ErrorCodes.ExecutionBackendDrift
      )
      assert.strictEqual(value.calls.length, 1)
    }).pipe(provideCrypto))

  it.effect("binds semantic coordinates before a changed queue payload can enqueue", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const first = yield* attempt(
        value,
        "run-descriptor-drift",
        "first"
      )
      const changed = yield* attempt(
        value,
        "run-descriptor-drift",
        "changed"
      )
      assert.notStrictEqual(
        first.operation.operationDigest,
        changed.operation.operationDigest
      )
      const route = yield* DurableQueue.prepareRoute(
        first.resolution
      )
      const terminal = yield* Effect.exit(
        QueueWorkflow.execute({
          id: "descriptor-drift",
          input: "first"
        }).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.die("descriptor drift workflow timed out")
          })
        )
      ).pipe(
        Effect.provide(
          runtime(value, first, route, {
            secondAttempt: changed
          })
        )
      )

      assert(Exit.isFailure(terminal))
      if (Exit.isSuccess(terminal)) return
      const failureReason = terminal.cause.reasons.find(
        (reason) => reason._tag === "Fail"
      )
      assert.isDefined(failureReason)
      if (failureReason?._tag !== "Fail") return
      assert.strictEqual(
        (failureReason.error as Semantic.EffectWorkflowSemanticError)
          .code,
        Semantic.ErrorCodes.DescriptorDrift
      )
      assert.strictEqual(value.calls.length, 1)
    }).pipe(provideCrypto))

  it.effect("rejects a copied route before executing user code", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(value, "run-invalid-route", "must-not-run")
      const route = yield* DurableQueue.prepareRoute(prepared.resolution)
      const copied = Object.freeze({ ...route, document: { ...route.document } }) as DurableQueue.PreparedWorkerRoute
      const result = DurableQueue.makeWorkItem(copied, prepared.resolution)
      assert(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.code, DurableQueue.ErrorCodes.InvalidRoute)
      assert.strictEqual(value.calls.length, 0)
    }).pipe(provideCrypto))

  it.effect("rejects non-positive worker limits", () =>
    Effect.gen(function*() {
      const value = yield* fixture()
      const prepared = yield* attempt(value, "run-invalid-concurrency", "unused")
      const route = yield* DurableQueue.prepareRoute(prepared.resolution)
      for (
        const limits of [
          { concurrency: 0, nativeQueueMaxAttempts: 1 },
          { concurrency: 1, nativeQueueMaxAttempts: 0 }
        ]
      ) {
        const exit = yield* Effect.exit(
          Layer.build(DurableQueue.worker(route, {
            ...limits,
            attestationRetryPolicy: noRetry
          }))
        )
        assert(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
          assert.isDefined(reason)
          if (reason?._tag === "Fail") {
            assert.strictEqual(
              (reason.error as DurableQueue.EffectWorkflowDurableQueueError).code,
              DurableQueue.ErrorCodes.InvalidWorkerOptions
            )
          }
        }
      }
    }).pipe(provideCrypto))
})
