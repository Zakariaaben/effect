import { assert, describe, it } from "@effect/vitest"
import type * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
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

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const activityConfigSchema = Schema.Struct({})
const activityFailureSchema = Schema.Never
const activityValueSchema = Schema.Number
const activityOutputSchema = Schema.Struct({
  value: activityValueSchema
})

const activityNode = Node.make("activity-node", {
  version: "1",
  config: activityConfigSchema,
  inputs: {
    value: Port.input(activityValueSchema, {
      contract: "semantic-test/number",
      required: false
    })
  },
  outputs: {
    value: Port.output(activityValueSchema, {
      contract: "semantic-test/number"
    })
  },
  failure: activityFailureSchema
})

const activityNodeRegistry = Registry.make(activityNode)

const activityDefinition = Workflow.make("semantic-activity-workflow", {
  version: "1",
  inputs: {},
  outputs: {},
  nodes: activityNodeRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 2,
    maxEdges: 2,
    maxFanIn: 2,
    maxFanOut: 2,
    maxDepth: 2
  })
})

const activityPlan = {
  formatVersion: 1 as const,
  id: "semantic-activity-plan",
  revision: 1,
  definition: {
    id: activityDefinition.id,
    version: activityDefinition.version
  },
  nodes: [{
    id: "activity-node",
    type: activityNode.type,
    version: activityNode.version,
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

const expectNodeActivity = (
  result: Result.Result<
    Executables.ResolvedActivity,
    Executables.SemanticExecutableRegistryError
  >
): Executables.ResolvedNodeHandlerActivity => {
  const resolution = expectSuccess(result)
  if (resolution._tag !== "NodeHandler") {
    throw new Error("Expected a resolved node-handler activity")
  }
  return resolution
}

const makeActivityFixture = Effect.gen(function*() {
  const compiled = yield* CompilerV2.compile(
    activityDefinition,
    activityPlan
  )
  const definitionBuild = yield* buildPin(
    "WorkflowDefinition",
    activityDefinition.id,
    activityDefinition.version,
    "semantic-activity-definition"
  )
  const handlerBuild = yield* buildPin(
    "NodeHandler",
    activityNode.type,
    activityNode.version,
    "semantic-activity-handler"
  )
  const classifierBuild = yield* buildPin(
    "RetryClassifier",
    "semantic-classifier",
    "1",
    "semantic-activity-classifier"
  )
  const codecs = yield* Effect.all([
    codecPin("activity-config", {
      type: "object",
      additionalProperties: false
    }),
    codecPin("activity-failure", { not: {} }),
    codecPin("activity-number", { type: "number" })
  ])
  codecs.sort((left, right) => left.key < right.key ? -1 : 1)

  const configCodecKey = PlanStoreV3.codecKey(
    "activity-config",
    "1"
  )
  const failureCodecKey = PlanStoreV3.codecKey(
    "activity-failure",
    "1"
  )
  const numberCodecKey = PlanStoreV3.codecKey(
    "activity-number",
    "1"
  )
  const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
    activityNode.type,
    activityNode.version
  )
  const classifierKey = PlanStoreV3.classifierKey(
    "semantic-classifier",
    "1"
  )
  const activityPolicy = {
    policyVersion: 3,
    retry: {
      retryPolicyVersion: 3,
      maximumAttempts: 2,
      maximumElapsed: { _tag: "Unlimited" },
      classifier: {
        classifierPinVersion: 3,
        classifierId: "semantic-classifier",
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
      id: activityDefinition.id,
      version: activityDefinition.version
    },
    ports: []
  }
  const outputBoundaryDocument = {
    boundaryContractVersion: 3 as const,
    direction: "Output" as const,
    definition: {
      id: activityDefinition.id,
      version: activityDefinition.version
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
      activityDefinition.id
    ),
    definition: {
      id: activityDefinition.id,
      version: activityDefinition.version,
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
      nodeType: activityNode.type,
      nodeVersion: activityNode.version,
      configCodecKey,
      failureCodecKey,
      inputs: [{
        name: "value",
        contract: "semantic-test/number",
        cardinality: "one",
        required: false,
        codecKey: numberCodecKey
      }],
      outputs: [{
        name: "value",
        contract: "semantic-test/number",
        fanOut: "multiple",
        codecKey: numberCodecKey
      }]
    }],
    codecs,
    policyExecutableBuilds: [{
      key: classifierKey,
      classifierId: "semantic-classifier",
      classifierVersion: "1",
      build: classifierBuild
    }],
    nodeBindings: [{
      bindingVersion: 3,
      nodeId: "activity-node",
      nodeType: activityNode.type,
      nodeVersion: activityNode.version,
      nodeDefinitionKey,
      queue: "semantic-activity-queue",
      handlerBuild,
      activityPolicy
    }]
  }
  const verified = yield* PlanStoreV3.verifyArtifact(
    artifact,
    yield* DigestV3.artifact(artifact)
  )

  const executionState = { count: 0 }
  const handlers = yield* activityNodeRegistry.toHandlers(
    activityNodeRegistry.of({
      "activity-node@1": ({ inputs }) =>
        Effect.sync(() => {
          executionState.count++
          return {
            value: Option.isSome(inputs.value)
              ? inputs.value.value
              : -1
          }
        })
    })
  )
  const deploymentCatalog = yield* Deployment.makeMemory({
    workflowDefinitions: [
      Deployment.workflowDefinition(
        "semantic-activity-definition",
        activityDefinition
      )
    ],
    handlerDefinitions: [
      Deployment.handlerDefinition(
        "semantic-activity-handler",
        activityNode
      )
    ]
  })
  const deployedHandlers = yield* DeploymentHandlers.make([
    DeploymentHandlers.handlerDeployment(
      "semantic-activity-handler",
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
  const nodeExecutable = expectSuccess(Executables.nodeHandler(
    deployedHandlers,
    handlerBuild
  ))
  const runtimeSchemas: Readonly<Record<string, Schema.Top>> = {
    "activity-config": activityConfigSchema,
    "activity-failure": activityFailureSchema,
    "activity-number": activityValueSchema
  }
  const codecExecutables = yield* Effect.forEach(
    codecs,
    (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
  )
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
    ...codecExecutables,
    classifierExecutable
  ])
  const resolvedArtifact = yield* registry.resolveArtifact(verified)
  const binding = artifact.nodeBindings[0]!
  const failureCodec = codecs.find(
    (pin) => pin.key === failureCodecKey
  )!
  return {
    verified,
    resolvedArtifact,
    binding,
    failureCodec,
    executionState
  }
})

const makeOccurrence = (
  nodeId: string,
  artifactDigest: string = digest("a")
) =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-1",
    runId: "run-1",
    artifactDigest,
    nodeId,
    scopePath: [],
    activation: 0
  })

const activity = (value: number) => ({
  _tag: "Activity",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "invoke-handler",
  attempt: 1,
  purpose: {
    _tag: "NodeHandler",
    purposeVersion: 1,
    nodeDefinitionKey: "activity-node@1",
    handlerBuildDigest: digest("b")
  },
  input: {
    _tag: "Inline",
    value: { value }
  },
  successContract: {
    _tag: "NodeOutputAggregate",
    contractReferenceVersion: 1,
    nodeDefinitionKey: "activity-node@1"
  },
  errorContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: "activity-error@1",
    schemaDigest: digest("c")
  }
})

const resolvedActivityDocument = (
  value: number,
  attempt: number,
  binding: PlanStoreV3.NodeBinding,
  failureCodec: PlanStoreV3.CodecPin
) => ({
  _tag: "Activity" as const,
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "invoke-handler",
  attempt,
  purpose: {
    _tag: "NodeHandler" as const,
    purposeVersion: 1 as const,
    nodeDefinitionKey: binding.nodeDefinitionKey,
    handlerBuildDigest: binding.handlerBuild.buildDigest
  },
  input: {
    _tag: "Inline" as const,
    value: { value }
  },
  successContract: {
    _tag: "NodeOutputAggregate" as const,
    contractReferenceVersion: 1 as const,
    nodeDefinitionKey: binding.nodeDefinitionKey
  },
  errorContract: {
    _tag: "ArtifactCodec" as const,
    contractReferenceVersion: 1 as const,
    codecKey: failureCodec.key,
    schemaDigest: failureCodec.schemaDigest
  }
})

const timer = (delayMillis: number) => ({
  _tag: "Timer",
  operationVersion: Operation.OperationVersion,
  executionProtocolVersion: Operation.ExecutionProtocolVersion,
  operationId: "business-deadline",
  generation: 0,
  owner: {
    _tag: "Sleep"
  },
  delayMillis
})

const DriftWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/Drift",
  {
    payload: {
      id: Schema.String
    },
    success: Schema.String,
    error: NativeSemantic.EffectWorkflowSemanticError,
    idempotencyKey: ({ id }) => id
  }
)

const TimerWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/Timer",
  {
    payload: {
      id: Schema.String
    },
    success: Schema.String,
    error: NativeSemantic.EffectWorkflowSemanticError,
    idempotencyKey: ({ id }) => id
  }
)

const ActivityWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/Activity",
  {
    payload: {
      id: Schema.String
    },
    success: Schema.String,
    error: NativeSemantic.EffectWorkflowSemanticError,
    idempotencyKey: ({ id }) => id
  }
)

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
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
  return yield* Effect.die("Native workflow did not expose observable state")
})

const pollUntilComplete = Effect.fnUntraced(function*<
  W extends NativeWorkflow.AnyWithProps
>(
  workflow: W,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* workflow.poll(executionId)
    if (Option.isSome(polled) && polled.value._tag === "Complete") {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native workflow did not complete")
})

describe("EffectWorkflowSemanticV3", () => {
  it.effect("fails replay before a stable native coordinate can acquire changed meaning", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* makeOccurrence("activity-node")
      const original = yield* Operation.prepare(
        preparedOccurrence,
        activity(1)
      )
      const drifted = yield* Operation.prepare(
        preparedOccurrence,
        activity(2)
      )
      let selected = original
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowSemanticV3/DriftGate"
      )
      const token = yield* Deferred.make<NativeDeferred.Token>()
      const registration = DriftWorkflow.toLayer(() =>
        Effect.gen(function*() {
          yield* NativeSemantic.bind(selected)
          yield* Deferred.succeed(
            token,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return "completed"
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* DriftWorkflow.execute(
          { id: "drift-run" },
          { discard: true }
        )
        const completionToken = yield* Deferred.await(token)
        const suspended = yield* pollUntilObserved(
          DriftWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")

        selected = drifted
        yield* NativeDeferred.succeed(gate, {
          token: completionToken,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          DriftWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          const failure = terminal.exit.cause.reasons[0]
          assert.strictEqual(failure?._tag, "Fail")
          if (
            failure?._tag === "Fail" &&
            failure.error._tag === "EffectWorkflowSemanticError"
          ) {
            assert.strictEqual(
              failure.error.code,
              NativeSemantic.ErrorCodes.DescriptorDrift
            )
            assert.strictEqual(
              failure.error.committedDigest,
              original.operationDigest
            )
            assert.strictEqual(
              failure.error.currentDigest,
              drifted.operationDigest
            )
          }
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("runs positive business timers through the forced native durable-clock path", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* makeOccurrence("timer-node")
      const preparedTimer = yield* Operation.prepare(
        preparedOccurrence,
        timer(10_000)
      )
      const registration = TimerWorkflow.toLayer(() =>
        Effect.gen(function*() {
          yield* NativeSemantic.sleep(preparedTimer)
          return "timer-fired"
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* TimerWorkflow.execute(
          { id: "timer-run" },
          { discard: true }
        )
        const suspended = yield* pollUntilObserved(
          TimerWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")

        yield* TestClock.adjust(10_000)
        const terminal = yield* pollUntilComplete(
          TimerWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "timer-fired")
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("maps semantic attempts onto one native activity name and distinct native attempts", () =>
    Effect.gen(function*() {
      const fixture = yield* makeActivityFixture
      const preparedOccurrence = yield* makeOccurrence(
        "activity-node",
        fixture.verified.artifactDigest
      )
      const firstAttempt = yield* Operation.prepare(
        preparedOccurrence,
        resolvedActivityDocument(
          1,
          1,
          fixture.binding,
          fixture.failureCodec
        )
      )
      const secondAttempt = yield* Operation.prepare(
        preparedOccurrence,
        resolvedActivityDocument(
          2,
          2,
          fixture.binding,
          fixture.failureCodec
        )
      )
      const firstResolution = expectNodeActivity(
        Executables.resolveActivity(
          fixture.resolvedArtifact,
          firstAttempt
        )
      )
      const secondResolution = expectNodeActivity(
        Executables.resolveActivity(
          fixture.resolvedArtifact,
          secondAttempt
        )
      )
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowSemanticV3/ActivityGate"
      )
      const token = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ActivityWorkflow.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* NativeSemantic.activity(
            firstResolution,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )
          const second = yield* NativeSemantic.activity(
            secondResolution,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )
          const decodedFirst = expectSuccess(
            Schema.decodeUnknownResult(activityOutputSchema)(first)
          )
          const decodedSecond = expectSuccess(
            Schema.decodeUnknownResult(activityOutputSchema)(second)
          )
          yield* Deferred.succeed(
            token,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return `${decodedFirst.value}:${decodedSecond.value}`
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* ActivityWorkflow.execute(
          { id: "activity-run" },
          { discard: true }
        )
        const suspended = yield* pollUntilObserved(
          ActivityWorkflow,
          executionId
        )
        if (suspended._tag === "Complete" && Exit.isFailure(suspended.exit)) {
          const reason = suspended.exit.cause.reasons[0]
          if (reason?._tag === "Die") throw reason.defect
        }
        assert.strictEqual(
          suspended._tag,
          "Suspended",
          JSON.stringify(suspended, null, 2)
        )
        const completionToken = yield* Deferred.await(token)
        assert.strictEqual(fixture.executionState.count, 2)

        yield* NativeDeferred.succeed(gate, {
          token: completionToken,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ActivityWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value, "1:2")
        }
        assert.strictEqual(fixture.executionState.count, 2)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("rejects structural activity-resolution copies before native execution", () =>
    Effect.gen(function*() {
      const fixture = yield* makeActivityFixture
      const preparedOccurrence = yield* makeOccurrence(
        "activity-node",
        fixture.verified.artifactDigest
      )
      const prepared = yield* Operation.prepare(
        preparedOccurrence,
        resolvedActivityDocument(
          1,
          1,
          fixture.binding,
          fixture.failureCodec
        )
      )
      const resolution = expectNodeActivity(
        Executables.resolveActivity(
          fixture.resolvedArtifact,
          prepared
        )
      )
      const rejected = yield* NativeSemantic.activity(
        { ...resolution },
        {
          interruptRetryPolicy: noInterruptRetry
        }
      ).pipe(Effect.flip)

      assert.strictEqual(
        rejected.code,
        NativeSemantic.ErrorCodes.InvalidActivityResolution
      )
      assert.strictEqual(fixture.executionState.count, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))

  it.effect("rejects structural operation copies and non-timer sleeps before native execution", () =>
    Effect.gen(function*() {
      const preparedOccurrence = yield* makeOccurrence("activity-node")
      const prepared = yield* Operation.prepare(
        preparedOccurrence,
        activity(1)
      )
      const copied = yield* NativeSemantic.bind({
        ...prepared
      }).pipe(Effect.flip)
      assert.strictEqual(
        copied.code,
        NativeSemantic.ErrorCodes.UnpreparedOperation
      )

      const wrongKind = yield* NativeSemantic.sleep(prepared).pipe(
        Effect.flip
      )
      assert.strictEqual(
        wrongKind.code,
        NativeSemantic.ErrorCodes.UnsupportedOperation
      )
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)))
})
