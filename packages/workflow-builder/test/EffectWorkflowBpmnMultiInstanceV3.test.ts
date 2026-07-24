import { assert, describe, it } from "@effect/vitest"
import type * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnData from "../src/BpmnData.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as EffectWorkflowBpmnV3 from "../src/EffectWorkflowBpmnV3.ts"
import * as Retry from "../src/EffectWorkflowRetryV3.ts"
import * as NativeSemantic from "../src/EffectWorkflowSemanticV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import type * as WireV2 from "../src/ProtocolV2Wire.ts"
import type * as Wire from "../src/ProtocolV3Wire.ts"
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (
  character: string
): `sha256:${string}` => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const configSchema = Schema.Struct({})
const FailureSchema = Schema.Struct({
  _tag: Schema.Literal("MultiInstanceFailure"),
  code: Schema.String,
  message: Schema.String
})
const outputSchema = Schema.Number

const nativeNode = Node.make("multi-instance-native-node", {
  version: "1",
  config: configSchema,
  inputs: {},
  outputs: {
    value: Port.output(outputSchema, {
      contract: "effect-workflow-mi/number"
    })
  },
  failure: FailureSchema
})

const nodeRegistry = Registry.make(nativeNode)

const definition = Workflow.make("effect-workflow-mi-bridge", {
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
  id: "effect-workflow-mi-bridge-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "native-mi-step",
    type: nativeNode.type,
    version: nativeNode.version,
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

const activityPolicy = (
  classifierBuildDigest: Wire.BuildDigest
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 1,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "mi-native-classifier",
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
      delayMillis: 0
    },
    jitter: { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: { _tag: "Disabled" },
    startToClose: { _tag: "Disabled" },
    scheduleToClose: { _tag: "Disabled" }
  }
})

interface NativeFixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolved: Executables.ResolvedArtifactExecutables
}

const makeNativeFixture = (
  handler: Node.Handler<typeof nativeNode>
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "mi-native-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      nativeNode.type,
      nativeNode.version,
      "mi-native-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "mi-native-classifier",
      "1",
      "mi-native-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("mi-native-config", {
        type: "object",
        additionalProperties: false
      }),
      codecPin("mi-native-failure", {
        type: "object",
        additionalProperties: false,
        required: ["_tag", "code", "message"],
        properties: {
          _tag: { const: "MultiInstanceFailure" },
          code: { type: "string" },
          message: { type: "string" }
        }
      }),
      codecPin("mi-native-number", {
        type: "number"
      })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

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
        key: PlanStoreV3.nodeDefinitionKey(
          nativeNode.type,
          nativeNode.version
        ),
        nodeType: nativeNode.type,
        nodeVersion: nativeNode.version,
        configCodecKey: PlanStoreV3.codecKey("mi-native-config", "1"),
        failureCodecKey: PlanStoreV3.codecKey("mi-native-failure", "1"),
        inputs: [],
        outputs: [{
          name: "value",
          contract: "effect-workflow-mi/number",
          fanOut: "multiple",
          codecKey: PlanStoreV3.codecKey("mi-native-number", "1")
        }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: PlanStoreV3.classifierKey("mi-native-classifier", "1"),
        classifierId: "mi-native-classifier",
        classifierVersion: "1",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "native-mi-step",
        nodeType: nativeNode.type,
        nodeVersion: nativeNode.version,
        nodeDefinitionKey: PlanStoreV3.nodeDefinitionKey(
          nativeNode.type,
          nativeNode.version
        ),
        queue: "mi-native-queue",
        handlerBuild,
        activityPolicy: activityPolicy(classifierBuild.buildDigest)
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )
    const handlers = yield* nodeRegistry.toHandlers(
      nodeRegistry.of({
        "multi-instance-native-node@1": handler
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
          nativeNode
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
    const nodeExecutable = yield* Effect.fromResult(
      Executables.nodeHandler(deployedHandlers, handlerBuild)
    )
    const runtimeSchemas: Readonly<Record<string, Schema.Top>> = {
      "mi-native-config": configSchema,
      "mi-native-failure": FailureSchema,
      "mi-native-number": outputSchema
    }
    const codecExecutables = yield* Effect.forEach(
      codecs,
      (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
    )
    const classifierExecutable = yield* Executables.retryClassifier(
      artifact.policyExecutableBuilds[0]!,
      () =>
        Effect.succeed({
          _tag: "Retryable",
          classificationVersion: 1
        })
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      nodeExecutable,
      ...codecExecutables,
      classifierExecutable
    ])
    const resolved = yield* registry.resolveArtifact(verified)
    return { verified, resolved } satisfies NativeFixture
  })

const processId = "effect-workflow-mi-process"
const taskNodeId = "effect-workflow-mi-task"
const now = "2026-07-24T11:00:00.000Z" as const
const evaluatorBuildDigest = digest("9") as WireV2.BuildDigest

const cardinalityExpression: BpmnModel.Expression = {
  language: "feel",
  version: "1.0",
  source: "item-count"
}

const collectionDataInputRef = "native-mi-items"
const collectionExpression: BpmnModel.Expression = {
  language: "feel",
  version: "1.0",
  source: "collection-items"
}
const collectionItems: ReadonlyArray<Schema.Json> = [
  {},
  { itemId: "different" }
]

const evaluatorBinding: BpmnExpression.EvaluatorBinding = {
  language: "feel",
  languageVersion: "1.0",
  build: {
    id: "mi-bridge-feel",
    version: "1.0.0",
    deploymentId: "mi-bridge-feel-deployment",
    buildDigest: evaluatorBuildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 100,
    timeoutMillis: 1_000
  }
}

const kernelLimits = {
  maxAutomaticTransitions: 100,
  maxExecutionInputCanonicalBytes: 1_048_576,
  maxMultiInstanceCardinality: 16,
  maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
  maxMultiInstanceItemCanonicalBytes: 262_144,
  maxMultiInstanceOutputCanonicalBytes: 1_048_576,
  maxMultiInstanceItemOutputCanonicalBytes: 262_144
} satisfies BpmnKernel.KernelLimits

const bpmnModel = (): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: BpmnModel.BpmnModelVersion,
  bpmnSpecVersion: "2.0.2",
  imports: [],
  extensionElements: [],
  collaborations: [],
  processes: [{
    id: processId,
    isExecutable: true,
    extensionElements: []
  }],
  flowNodes: [
    {
      _tag: "StartEvent",
      id: "start",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: [],
      outgoingSequenceFlowIds: ["flow-start-task"],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    },
    {
      _tag: "Task",
      id: taskNodeId,
      processId,
      parentScopeId: processId,
      taskKind: "generic",
      incomingSequenceFlowIds: ["flow-start-task"],
      outgoingSequenceFlowIds: ["flow-task-end"],
      loopCharacteristics: {
        _tag: "MultiInstanceCharacteristics",
        mode: "parallel",
        cardinality: cardinalityExpression
      },
      extensionElements: []
    },
    {
      _tag: "EndEvent",
      id: "end",
      processId,
      parentScopeId: processId,
      incomingSequenceFlowIds: ["flow-task-end"],
      outgoingSequenceFlowIds: [],
      eventDefinitions: [],
      eventDefinitionRefs: [],
      extensionElements: []
    }
  ],
  sequenceFlows: [
    {
      id: "flow-start-task",
      processId,
      parentScopeId: processId,
      sourceId: "start",
      targetId: taskNodeId,
      kind: "normal",
      extensionElements: []
    },
    {
      id: "flow-task-end",
      processId,
      parentScopeId: processId,
      sourceId: taskNodeId,
      targetId: "end",
      kind: "normal",
      extensionElements: []
    }
  ]
})

const collectionBpmnModel = (
  bindInputDataItem = true
): BpmnModel.BpmnModel => {
  const model = bpmnModel()
  return {
    ...model,
    flowNodes: model.flowNodes.map((node): BpmnModel.FlowNode =>
      node.id === taskNodeId && node._tag === "Task"
        ? {
          ...node,
          loopCharacteristics: {
            _tag: "MultiInstanceCharacteristics",
            mode: "parallel",
            loopDataInputRef: collectionDataInputRef,
            ...(bindInputDataItem
              ? {
                inputDataItem: {
                  id: "native-mi-item",
                  isCollection: false,
                  extensionElements: []
                }
              }
              : undefined)
          }
        }
        : node
    )
  }
}

const collectionDataDocument = (): BpmnData.BpmnDataDocument => ({
  documentKind: "BpmnDataDocument",
  documentVersion: BpmnData.BpmnDataDocumentVersion,
  bpmnSpecVersion: "2.0.2",
  extensionElements: [],
  itemDefinitions: [],
  dataStores: [],
  messages: [],
  errors: [],
  interfaces: [],
  dataObjects: [],
  dataObjectReferences: [],
  dataStoreReferences: [],
  properties: [],
  inputOutputSpecifications: [{
    id: "native-mi-io",
    ownerId: taskNodeId,
    dataInputs: [{
      id: collectionDataInputRef,
      isCollection: true,
      extensionElements: []
    }],
    dataOutputs: [],
    inputSets: [{
      id: "native-mi-input-set",
      dataInputRefs: [collectionDataInputRef],
      optionalInputRefs: [],
      whileExecutingInputRefs: [],
      outputSetRefs: [],
      extensionElements: []
    }],
    outputSets: [{
      id: "native-mi-output-set",
      dataOutputRefs: [],
      optionalOutputRefs: [],
      whileExecutingOutputRefs: [],
      inputSetRefs: [],
      extensionElements: []
    }],
    extensionElements: []
  }],
  dataAssociations: [],
  inputOutputBindings: []
})

const bpmnServices = (): BpmnKernel.Services => ({
  now,
  evaluateExpression: (context) =>
    Result.succeed({
      result: context._tag === "MultiInstanceCardinality"
        ? 2
        : context._tag === "MultiInstanceCollection"
        ? collectionItems
        : false,
      steps: 1
    })
})

const target = (
  token: BpmnKernel.TransitionBatch["state"]["tokens"][number]
): EffectWorkflowBpmnV3.TaskResolutionTarget => ({
  scopeInstanceId: token.scopeInstanceId,
  taskNodeId,
  tokenId: token.tokenId
})

const activeTaskTokens = (
  state: BpmnKernel.TransitionBatch["state"]
) =>
  state.tokens
    .filter((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === taskNodeId
    )
    .sort((left, right) => {
      const leftBranch = left.invocation.branch
      const rightBranch = right.invocation.branch
      return (
        leftBranch?._tag === "MultiInstanceItem"
          ? leftBranch.itemIndex
          : -1
      ) - (
        rightBranch?._tag === "MultiInstanceItem"
          ? rightBranch.itemIndex
          : -1
      )
    })

const prepareInvocation = (
  fixture: NativeFixture,
  coordinates: BpmnKernel.TaskOccurrenceCoordinates,
  runId: string,
  input: Schema.Json = {}
) =>
  Effect.gen(function*() {
    const preparedOccurrence = yield* Occurrence.prepare({
      occurrenceVersion: Occurrence.OccurrenceVersion,
      executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
      tenantId: "tenant-mi-native",
      runId,
      artifactDigest: fixture.verified.artifactDigest,
      ...coordinates
    })
    const invocation = yield* Retry.prepare({
      artifact: fixture.resolved,
      occurrence: preparedOccurrence,
      input: { _tag: "Inline", value: input }
    })
    return { invocation, preparedOccurrence }
  })

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const BridgeWorkflowFailure = Schema.Union([
  EffectWorkflowBpmnV3.EffectWorkflowBpmnError,
  Retry.AttemptTimedOut,
  Retry.ScheduleToCloseTimedOut,
  Retry.EffectWorkflowRetryError,
  NativeSemantic.EffectWorkflowSemanticError
])

const MultiInstanceBridgeWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowBpmnV3/MultiInstance",
  {
    payload: {
      executionKey: Schema.String,
      itemIndex: Schema.Number
    },
    success: EffectWorkflowBpmnV3.ExecutedTaskResolution,
    error: BridgeWorkflowFailure,
    idempotencyKey: ({ executionKey }) => executionKey
  }
)

const pollUntilComplete = Effect.fnUntraced(function*(
  executionId: string
) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const polled = yield* MultiInstanceBridgeWorkflow.poll(executionId)
    if (
      Option.isSome(polled) &&
      polled.value._tag === "Complete"
    ) {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native multi-instance bridge workflow did not complete")
})

const expectBridgeFailure = <A, E>(
  exit: Exit.Exit<A, E>
): EffectWorkflowBpmnV3.EffectWorkflowBpmnError => {
  assert(Exit.isFailure(exit))
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected bridge rejection")
  }
  const failure = exit.cause.reasons.find(
    (reason) => reason._tag === "Fail"
  )
  assert.isDefined(failure)
  const error = failure?._tag === "Fail" ? failure.error : undefined
  assert.strictEqual(
    (error as { readonly _tag?: string } | undefined)?._tag,
    "EffectWorkflowBpmnError"
  )
  return error as EffectWorkflowBpmnV3.EffectWorkflowBpmnError
}

describe("EffectWorkflowBpmnV3 native Multi-Instance bridge", () => {
  it.effect("leaves collection members unbound without a BPMN inputDataItem", () =>
    Effect.gen(function*() {
      const kernel = yield* BpmnKernel.prepare(
        collectionBpmnModel(false),
        {
          profileId: "effect-workflow-mi-unbound-collection-v1",
          rootProcessId: processId,
          limits: kernelLimits,
          evaluatorBindings: [evaluatorBinding],
          dataDocument: collectionDataDocument(),
          collectionBindings: [{
            bindingVersion: BpmnKernel.MultiInstanceCollectionBindingVersion,
            taskNodeId,
            dataInputRef: collectionDataInputRef,
            collectionExpression
          }]
        }
      ).pipe(Effect.orDie)
      const initialized = BpmnKernel.initialize(
        kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: null
        },
        bpmnServices()
      )
      if (Result.isFailure(initialized)) {
        return yield* Effect.die(initialized.failure)
      }
      const tokens = activeTaskTokens(initialized.success.state)
      assert.strictEqual(tokens.length, 2)
      const selected = BpmnKernel.taskCollectionItem(
        kernel,
        initialized.success.state,
        target(tokens[0]!)
      )
      assert(Result.isSuccess(selected))
      assert.isUndefined(selected.success)
    }).pipe(provideCrypto))

  it.effect("authorizes exact member occurrences before dispatch and delegates replay/dedup to native Effect Workflow", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeNativeFixture(
        (() =>
          Effect.sync(() => ({
            value: ++handlerRuns
          }))) as Node.Handler<typeof nativeNode>
      )
      const binding: BpmnActivityV3.TaskBinding = {
        bindingVersion: BpmnActivityV3.BindingVersion,
        executionProtocolVersion: 3,
        taskNodeId,
        artifactDigest: fixture.verified.artifactDigest,
        semanticNodeId: "native-mi-step",
        errorMappings: []
      }
      const kernel = yield* BpmnKernel.prepare(bpmnModel(), {
        profileId: "effect-workflow-mi-native-bridge-v1",
        rootProcessId: processId,
        limits: kernelLimits,
        evaluatorBindings: [evaluatorBinding],
        taskBindings: [binding]
      }).pipe(Effect.orDie)
      const initializedResult = BpmnKernel.initialize(
        kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: null
        },
        bpmnServices()
      )
      if (Result.isFailure(initializedResult)) {
        return yield* Effect.die(initializedResult.failure)
      }
      const initialized = initializedResult.success
      const tokens = activeTaskTokens(initialized.state)
      assert.strictEqual(tokens.length, 2)

      const targets = tokens.map(target)
      const coordinates = targets.map((candidate) => {
        const result = BpmnKernel.taskOccurrence(
          kernel,
          initialized.state,
          candidate
        )
        if (Result.isFailure(result)) throw result.failure
        return result.success
      })
      assert.deepStrictEqual(coordinates, [
        {
          nodeId: "native-mi-step",
          scopePath: [{
            scopeActivationVersion: 1,
            scopeId: "native-mi-step",
            activation: 0
          }],
          activation: 0
        },
        {
          nodeId: "native-mi-step",
          scopePath: [{
            scopeActivationVersion: 1,
            scopeId: "native-mi-step",
            activation: 0
          }],
          activation: 1
        }
      ])

      const prepared = yield* Effect.all([
        prepareInvocation(
          fixture,
          coordinates[0]!,
          "mi-native-parent-execution"
        ),
        prepareInvocation(
          fixture,
          coordinates[1]!,
          "mi-native-parent-execution"
        )
      ])
      assert.notStrictEqual(
        prepared[0].preparedOccurrence.occurrenceDigest,
        prepared[1].preparedOccurrence.occurrenceDigest
      )

      const execute = (
        state: unknown,
        invocation: Retry.PreparedRetryInvocation,
        taskTarget: EffectWorkflowBpmnV3.TaskResolutionTarget
      ) =>
        EffectWorkflowBpmnV3.executeTask(
          kernel,
          state,
          invocation,
          taskTarget,
          { interruptRetryPolicy: noInterruptRetry }
        )

      const collision = yield* execute(
        initialized.state,
        prepared[1].invocation,
        targets[0]!
      ).pipe(Effect.exit)
      const collisionFailure = expectBridgeFailure(collision)
      assert.strictEqual(
        collisionFailure.code,
        EffectWorkflowBpmnV3.ErrorCodes.InvocationOccurrenceMismatch
      )
      assert.strictEqual(handlerRuns, 0)

      const initialGroup = initialized.state.multiInstanceGroups[0]!
      const firstBranch = tokens[0]!.invocation.branch
      assert.strictEqual(firstBranch?._tag, "MultiInstanceItem")
      if (firstBranch?._tag !== "MultiInstanceItem") {
        return yield* Effect.die("Expected first multi-instance branch")
      }
      const forgedStates = [
        {
          ...initialized.state,
          multiInstanceGroups: [{
            ...initialGroup,
            activation: initialGroup.activation + 1
          }]
        },
        {
          ...initialized.state,
          tokens: initialized.state.tokens.map((candidate) =>
            candidate.tokenId === tokens[0]!.tokenId
              ? {
                ...candidate,
                invocation: {
                  ...candidate.invocation,
                  branch: {
                    ...firstBranch,
                    itemIndex: 1
                  }
                }
              }
              : candidate
          )
        },
        {
          ...initialized.state,
          tokens: initialized.state.tokens.map((candidate) =>
            candidate.tokenId === tokens[0]!.tokenId
              ? {
                ...candidate,
                invocation: {
                  ...candidate.invocation,
                  branch: {
                    ...firstBranch,
                    itemKey: "item:1"
                  }
                }
              }
              : candidate
          )
        }
      ]
      for (const forgedState of forgedStates) {
        const rejected = yield* execute(
          forgedState,
          prepared[0].invocation,
          targets[0]!
        ).pipe(Effect.exit)
        expectBridgeFailure(rejected)
      }
      assert.strictEqual(handlerRuns, 0)

      const registration = MultiInstanceBridgeWorkflow.toLayer(
        ({ itemIndex }) =>
          execute(
            initialized.state,
            prepared[itemIndex]!.invocation,
            targets[itemIndex]!
          )
      )
      const receipts = yield* Effect.gen(function*() {
        const firstExecutionId = yield* MultiInstanceBridgeWorkflow.execute(
          {
            executionKey: "mi-member-0-native-execution",
            itemIndex: 0
          },
          { discard: true }
        )
        const replayExecutionId = yield* MultiInstanceBridgeWorkflow.execute(
          {
            executionKey: "mi-member-0-native-execution",
            itemIndex: 0
          },
          { discard: true }
        )
        assert.strictEqual(replayExecutionId, firstExecutionId)
        const secondExecutionId = yield* MultiInstanceBridgeWorkflow.execute(
          {
            executionKey: "mi-member-1-native-execution",
            itemIndex: 1
          },
          { discard: true }
        )
        const firstTerminal = yield* pollUntilComplete(firstExecutionId)
        const secondTerminal = yield* pollUntilComplete(secondExecutionId)
        if (
          Exit.isFailure(firstTerminal.exit) ||
          Exit.isFailure(secondTerminal.exit)
        ) {
          return yield* Effect.die(
            Exit.isFailure(firstTerminal.exit)
              ? firstTerminal.exit.cause
              : secondTerminal.exit.cause
          )
        }
        return [
          firstTerminal.exit.value,
          secondTerminal.exit.value
        ] as const
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )

      assert.strictEqual(handlerRuns, 2)
      assert.deepStrictEqual(
        receipts.map((receipt) => receipt.command.outcome.occurrenceDigest),
        prepared.map(({ preparedOccurrence }) => preparedOccurrence.occurrenceDigest)
      )

      const firstResolved = BpmnKernel.resolveTask(
        kernel,
        initialized.state,
        receipts[0].command,
        bpmnServices()
      )
      if (Result.isFailure(firstResolved)) {
        return yield* Effect.die(firstResolved.failure)
      }
      assert.strictEqual(firstResolved.success.state.status, "active")
      assert.strictEqual(
        firstResolved.success.state.multiInstanceGroups[0]
          ?.completedInstanceCount,
        1
      )
      const secondResolved = BpmnKernel.resolveTask(
        kernel,
        firstResolved.success.state,
        receipts[1].command,
        bpmnServices()
      )
      if (Result.isFailure(secondResolved)) {
        return yield* Effect.die(secondResolved.failure)
      }
      assert.strictEqual(secondResolved.success.state.status, "completed")
      assert.deepStrictEqual(
        secondResolved.success.state.multiInstanceGroups[0]?.members.map(
          (member) => ({
            index: member.index,
            itemKey: member.itemKey,
            status: member.status
          })
        ),
        [
          { index: 0, itemKey: "item:0", status: "completed" },
          { index: 1, itemKey: "item:1", status: "completed" }
        ]
      )
      const replayed = BpmnKernel.replay(kernel, [
        ...initialized.events,
        ...firstResolved.success.events,
        ...secondResolved.success.events
      ])
      if (Result.isFailure(replayed)) {
        return yield* Effect.die(replayed.failure)
      }
      assert.deepStrictEqual(
        replayed.success,
        secondResolved.success.state
      )
    }).pipe(provideCrypto))

  it.effect("binds native dispatch to the exact frozen collection item", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeNativeFixture(
        (() =>
          Effect.sync(() => ({
            value: ++handlerRuns
          }))) as Node.Handler<typeof nativeNode>
      )
      const binding: BpmnActivityV3.TaskBinding = {
        bindingVersion: BpmnActivityV3.BindingVersion,
        executionProtocolVersion: 3,
        taskNodeId,
        artifactDigest: fixture.verified.artifactDigest,
        semanticNodeId: "native-mi-step",
        errorMappings: []
      }
      const kernel = yield* BpmnKernel.prepare(
        collectionBpmnModel(),
        {
          profileId: "effect-workflow-mi-native-collection-bridge-v1",
          rootProcessId: processId,
          limits: kernelLimits,
          evaluatorBindings: [evaluatorBinding],
          taskBindings: [binding],
          dataDocument: collectionDataDocument(),
          collectionBindings: [{
            bindingVersion: BpmnKernel.MultiInstanceCollectionBindingVersion,
            taskNodeId,
            dataInputRef: collectionDataInputRef,
            collectionExpression
          }]
        }
      ).pipe(Effect.orDie)
      const initializedResult = BpmnKernel.initialize(
        kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: null
        },
        bpmnServices()
      )
      if (Result.isFailure(initializedResult)) {
        return yield* Effect.die(initializedResult.failure)
      }
      const initialized = initializedResult.success
      const tokens = activeTaskTokens(initialized.state)
      assert.strictEqual(tokens.length, 2)
      const taskTarget = target(tokens[0]!)

      const selectedItem = BpmnKernel.taskCollectionItem(
        kernel,
        initialized.state,
        taskTarget
      )
      assert(Result.isSuccess(selectedItem))
      assert.deepStrictEqual(selectedItem.success, {
        dataInputRef: collectionDataInputRef,
        itemIndex: 0,
        itemKey: "item:0",
        item: collectionItems[0]
      })
      assert.isTrue(Object.isFrozen(selectedItem.success?.item))

      const coordinates = BpmnKernel.taskOccurrence(
        kernel,
        initialized.state,
        taskTarget
      )
      if (Result.isFailure(coordinates)) {
        return yield* Effect.die(coordinates.failure)
      }
      const exact = yield* prepareInvocation(
        fixture,
        coordinates.success,
        "mi-native-collection-parent",
        collectionItems[0]!
      )
      const differentItem = yield* prepareInvocation(
        fixture,
        coordinates.success,
        "mi-native-collection-parent",
        collectionItems[1]!
      )

      const execute = (
        invocation: Retry.PreparedRetryInvocation
      ) =>
        EffectWorkflowBpmnV3.executeTask(
          kernel,
          initialized.state,
          invocation,
          taskTarget,
          { interruptRetryPolicy: noInterruptRetry }
        )

      const rejected = yield* execute(
        differentItem.invocation
      ).pipe(Effect.exit)
      const rejection = expectBridgeFailure(rejected)
      assert.strictEqual(
        rejection.code,
        EffectWorkflowBpmnV3.ErrorCodes.InvocationInputMismatch
      )
      assert.strictEqual(handlerRuns, 0)

      const registration = MultiInstanceBridgeWorkflow.toLayer(
        () => execute(exact.invocation)
      )
      const receipt = yield* Effect.gen(function*() {
        const executionId = yield* MultiInstanceBridgeWorkflow.execute(
          {
            executionKey: "mi-native-collection-exact-item",
            itemIndex: 0
          },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(executionId)
        if (Exit.isFailure(terminal.exit)) {
          return yield* Effect.die(terminal.exit.cause)
        }
        return terminal.exit.value
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )

      assert.strictEqual(handlerRuns, 1)
      assert.strictEqual(receipt.command.outcome._tag, "Succeeded")
      if (receipt.command.outcome._tag !== "Succeeded") {
        return yield* Effect.die("Expected exact collection item success")
      }
      assert.deepStrictEqual(receipt.command.outcome.output, {
        _tag: "Inline",
        value: { value: 1 }
      })
    }).pipe(provideCrypto))
})
