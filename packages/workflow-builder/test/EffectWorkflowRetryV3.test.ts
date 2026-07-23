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
import * as SchemaTransformation from "effect/SchemaTransformation"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as EffectWorkflowBpmnV3 from "../src/EffectWorkflowBpmnV3.ts"
import * as NativeName from "../src/EffectWorkflowOperationV3.ts"
import * as Retry from "../src/EffectWorkflowRetryV3.ts"
import * as NativeSemantic from "../src/EffectWorkflowSemanticV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
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
const BusinessFailureSchema = Schema.Struct({
  _tag: Schema.Literal("BusinessFailure"),
  code: Schema.String,
  message: Schema.String
})
const SemanticLookingFailureSchema = Schema.Struct({
  _tag: Schema.Literal("EffectWorkflowSemanticError"),
  code: Schema.String,
  message: Schema.String
})
const FailureWire = Schema.Union([
  BusinessFailureSchema,
  SemanticLookingFailureSchema
])
const failureEncodeCounts = new Map<string, number>()
const failureSchema = FailureWire.pipe(
  Schema.decodeTo(
    FailureWire,
    SchemaTransformation.transform({
      decode: (value) => value,
      encode: (value) => {
        failureEncodeCounts.set(
          value.code,
          (failureEncodeCounts.get(value.code) ?? 0) + 1
        )
        return value
      }
    })
  )
)
const outputSchema = Schema.Number

const retryNode = Node.make("retry-contract-node", {
  version: "1",
  config: configSchema,
  inputs: {},
  outputs: {
    value: Port.output(outputSchema, {
      contract: "effect-workflow-retry/number"
    })
  },
  failure: failureSchema
})

const nodeRegistry = Registry.make(retryNode)

const definition = Workflow.make("effect-workflow-retry-contract", {
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
  id: "effect-workflow-retry-contract-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "retry-step",
    type: retryNode.type,
    version: retryNode.version,
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

interface FixtureOptions {
  readonly scheduleToStart?: ActivityPolicyV3.Timeout
  readonly startToClose?: ActivityPolicyV3.Timeout
  readonly scheduleToClose?: ActivityPolicyV3.Timeout
  readonly handler?: Node.Handler<typeof retryNode>
  readonly classifier?: (
    failure: ActivityPolicyV3.RetryFailureCause
  ) => Effect.Effect<ActivityPolicyV3.RetryClassification>
  readonly maximumAttempts?: number
  readonly maximumElapsed?: ActivityPolicyV3.ElapsedBudget
  readonly delayMillis?: number
  readonly jitter?: ActivityPolicyV3.Jitter
  readonly nonRetryableErrorTags?: ReadonlyArray<string>
  readonly nonRetryableErrorCodes?: ReadonlyArray<string>
}

const policy = (
  classifierBuildDigest: Wire.BuildDigest,
  options: FixtureOptions
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: options.maximumAttempts ?? 3,
    maximumElapsed: options.maximumElapsed ?? { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "retry-contract-classifier",
      classifierVersion: "1",
      buildDigest: classifierBuildDigest
    },
    failureIdentity: {
      _tag: "EffectTagged",
      identityContractVersion: 1,
      code: "OptionalString"
    },
    nonRetryableErrorTags: options.nonRetryableErrorTags ?? [],
    nonRetryableErrorCodes: options.nonRetryableErrorCodes ?? [],
    backoff: {
      _tag: "Fixed",
      delayMillis: options.delayMillis ?? 0
    },
    jitter: options.jitter ?? { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: options.scheduleToStart ?? { _tag: "Disabled" },
    startToClose: options.startToClose ?? { _tag: "Disabled" },
    scheduleToClose: options.scheduleToClose ?? { _tag: "Disabled" }
  }
})

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolved: Executables.ResolvedArtifactExecutables
}

const makeFixture = (
  options: FixtureOptions = {}
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "retry-contract-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      retryNode.type,
      retryNode.version,
      "retry-contract-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "retry-contract-classifier",
      "1",
      "retry-contract-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("retry-contract-config", {
        type: "object",
        additionalProperties: false
      }),
      codecPin("retry-contract-failure", {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["_tag", "code", "message"],
            properties: {
              _tag: { const: "BusinessFailure" },
              code: { type: "string" },
              message: { type: "string" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["_tag", "code", "message"],
            properties: {
              _tag: {
                const: "EffectWorkflowSemanticError"
              },
              code: { type: "string" },
              message: { type: "string" }
            }
          }
        ]
      }),
      codecPin("retry-contract-number", {
        type: "number"
      })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const configCodecKey = PlanStoreV3.codecKey(
      "retry-contract-config",
      "1"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "retry-contract-failure",
      "1"
    )
    const numberCodecKey = PlanStoreV3.codecKey(
      "retry-contract-number",
      "1"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      retryNode.type,
      retryNode.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "retry-contract-classifier",
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
        nodeType: retryNode.type,
        nodeVersion: retryNode.version,
        configCodecKey,
        failureCodecKey,
        inputs: [],
        outputs: [{
          name: "value",
          contract: "effect-workflow-retry/number",
          fanOut: "multiple",
          codecKey: numberCodecKey
        }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "retry-contract-classifier",
        classifierVersion: "1",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "retry-step",
        nodeType: retryNode.type,
        nodeVersion: retryNode.version,
        nodeDefinitionKey,
        queue: "retry-contract-queue",
        handlerBuild,
        activityPolicy: policy(
          classifierBuild.buildDigest,
          options
        )
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const handlers = yield* nodeRegistry.toHandlers(
      nodeRegistry.of({
        "retry-contract-node@1": options.handler ?? (() => Effect.succeed({ value: 1 }))
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
          retryNode
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
      "retry-contract-config": configSchema,
      "retry-contract-failure": failureSchema,
      "retry-contract-number": outputSchema
    }
    const codecExecutables = yield* Effect.forEach(
      codecs,
      (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
    )
    const classifierExecutable = yield* Executables.retryClassifier(
      artifact.policyExecutableBuilds[0]!,
      options.classifier ?? (() =>
        Effect.succeed({
          _tag: "Retryable",
          classificationVersion: 1
        }))
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      nodeExecutable,
      ...codecExecutables,
      classifierExecutable
    ])
    const resolved = yield* registry.resolveArtifact(verified)
    return { verified, resolved } satisfies Fixture
  })

const occurrence = (
  fixture: Fixture,
  runId: string
) =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-retry-contract",
    runId,
    artifactDigest: fixture.verified.artifactDigest,
    nodeId: "retry-step",
    scopePath: [],
    activation: 0
  })

const applicationFailure = {
  _tag: "ApplicationFailure" as const,
  failureCauseVersion: 1 as const,
  activityDigest: digest("a") as Wire.OperationDigest,
  attempt: 1,
  identity: {
    failureIdentityVersion: 1 as const,
    errorTag: "BusinessFailure",
    errorCode: "TEMPORARY"
  },
  failure: {
    _tag: "Inline" as const,
    value: {
      _tag: "BusinessFailure",
      code: "TEMPORARY",
      message: "try again"
    }
  }
}

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const WorkflowOutput = Schema.Struct({
  value: Schema.Number
})

const WorkflowFailure = Schema.Union([
  Retry.TerminalFailure,
  Retry.EffectWorkflowRetryError,
  NativeSemantic.EffectWorkflowSemanticError
])

const DetailedWorkflowFailure = Schema.Union([
  Retry.EffectWorkflowRetryError,
  NativeSemantic.EffectWorkflowSemanticError
])

const RuntimeWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Runtime",
  {
    payload: { id: Schema.String },
    success: WorkflowOutput,
    error: WorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const DetailedWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Detailed",
  {
    payload: { id: Schema.String },
    success: Retry.RetryExecutionOutcome,
    error: DetailedWorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const BridgeWorkflowFailure = Schema.Union([
  EffectWorkflowBpmnV3.EffectWorkflowBpmnError,
  Retry.AttemptTimedOut,
  Retry.ScheduleToCloseTimedOut,
  Retry.EffectWorkflowRetryError,
  NativeSemantic.EffectWorkflowSemanticError
])

const BridgeWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/BpmnBridge",
  {
    payload: { id: Schema.String },
    success: EffectWorkflowBpmnV3.ExecutedTaskResolution,
    error: BridgeWorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const ReplayWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Replay",
  {
    payload: { id: Schema.String },
    success: WorkflowOutput,
    error: WorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const DefectWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Defect",
  {
    payload: { id: Schema.String },
    success: WorkflowOutput,
    error: WorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const retryExecution = (
  invocation: Retry.PreparedRetryInvocation
) =>
  Retry.execute(invocation, {
    interruptRetryPolicy: noInterruptRetry
  }) as Effect.Effect<
    Schema.Schema.Type<typeof WorkflowOutput>,
    | Retry.TerminalFailure
    | Retry.EffectWorkflowRetryError
    | NativeSemantic.EffectWorkflowSemanticError,
    Crypto.Crypto | NativeSemantic.Requirements
  >

const detailedRetryExecution = (
  invocation: Retry.PreparedRetryInvocation
) =>
  Retry.executeDetailed(invocation, {
    interruptRetryPolicy: noInterruptRetry
  })

const bridgeRetryExecution = (
  kernel: BpmnKernel.CompiledKernel,
  invocation: Retry.PreparedRetryInvocation,
  target: EffectWorkflowBpmnV3.TaskResolutionTarget
) =>
  EffectWorkflowBpmnV3.executeTask(
    kernel,
    invocation,
    target,
    {
      interruptRetryPolicy: noInterruptRetry
    }
  )

const pollUntilObserved = Effect.fnUntraced(function*<
  W extends NativeWorkflow.AnyWithProps
>(
  workflow: W,
  executionId: string
) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
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
  for (let attempt = 0; attempt < 1_000; attempt++) {
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

const failReason = (
  exit: Exit.Exit<unknown, unknown>
): unknown => {
  assert(Exit.isFailure(exit))
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons.find(
    (candidate) => candidate._tag === "Fail"
  )
  assert.isDefined(reason)
  return reason?._tag === "Fail" ? reason.error : undefined
}

const nodeAttemptCompletedAt = "2026-01-02T03:04:05.006Z" as Wire.Timestamp

const withoutAttemptTimerDelivery = (
  timeoutKind: ActivityPolicyV3.AttemptTimeout["timeoutKind"],
  onSchedule: () => void
) =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine
  )(
    Effect.map(
      WorkflowEngine.WorkflowEngine,
      (delegate) => {
        let wrapped: typeof delegate
        wrapped = {
          ...delegate,
          register: ((workflow, execute) =>
            delegate.register(
              workflow,
              (payload, executionId) =>
                execute(payload, executionId).pipe(
                  Effect.provideService(
                    WorkflowEngine.WorkflowEngine,
                    wrapped
                  )
                )
            )) as typeof delegate.register,
          scheduleDeferred: ((deferred, options) => {
            const scheduledKind = (
              options.value as {
                readonly timeout?: {
                  readonly timeoutKind?: unknown
                }
              }
            ).timeout?.timeoutKind
            if (scheduledKind === timeoutKind) {
              return Effect.sync(onSchedule)
            }
            return delegate.scheduleDeferred(
              deferred,
              options
            )
          }) as typeof delegate.scheduleDeferred
        }
        return wrapped
      }
    )
  ).pipe(
    Layer.provide(WorkflowEngine.layerMemory)
  )

const businessFailure = (
  code: string,
  message = "business failure"
) => ({
  _tag: "BusinessFailure" as const,
  code,
  message
})

const bpmnNow = "2026-07-23T10:00:00.000Z" as const
const bpmnProcessId = "retry-bridge-process"
const bpmnTaskNodeId = "retry-bridge-task"

const bpmnServices = (): BpmnKernel.Services => ({
  now: bpmnNow,
  evaluateCondition: () =>
    Result.succeed({
      result: false,
      steps: 1
    })
})

const bridgeBpmnModel = (
  errorRef?: string | null
): BpmnModel.BpmnModel => {
  const hasBoundary = errorRef !== undefined
  const taskSuccessFlowId = "flow-task-success"
  const boundaryFlowId = "flow-boundary-error"
  return {
    modelKind: "BpmnModel",
    modelVersion: BpmnModel.BpmnModelVersion,
    bpmnSpecVersion: "2.0.2",
    imports: [],
    extensionElements: [],
    collaborations: [],
    processes: [{
      id: bpmnProcessId,
      isExecutable: true,
      extensionElements: []
    }],
    flowNodes: [
      {
        _tag: "StartEvent",
        id: "start",
        processId: bpmnProcessId,
        parentScopeId: bpmnProcessId,
        incomingSequenceFlowIds: [],
        outgoingSequenceFlowIds: ["flow-start-task"],
        eventDefinitions: [],
        eventDefinitionRefs: [],
        extensionElements: []
      },
      {
        _tag: "Task",
        id: bpmnTaskNodeId,
        processId: bpmnProcessId,
        parentScopeId: bpmnProcessId,
        taskKind: "generic",
        incomingSequenceFlowIds: ["flow-start-task"],
        outgoingSequenceFlowIds: [taskSuccessFlowId],
        extensionElements: []
      },
      ...(hasBoundary
        ? [{
          _tag: "BoundaryEvent" as const,
          id: "boundary-error",
          processId: bpmnProcessId,
          parentScopeId: bpmnProcessId,
          incomingSequenceFlowIds: [],
          outgoingSequenceFlowIds: [boundaryFlowId],
          eventDefinitions: [{
            _tag: "ErrorEventDefinition" as const,
            ...(errorRef === null ? {} : { errorRef })
          }],
          eventDefinitionRefs: [],
          attachedToRef: bpmnTaskNodeId,
          cancelActivity: true,
          extensionElements: []
        }]
        : []),
      {
        _tag: "EndEvent",
        id: "end-success",
        processId: bpmnProcessId,
        parentScopeId: bpmnProcessId,
        incomingSequenceFlowIds: [taskSuccessFlowId],
        outgoingSequenceFlowIds: [],
        eventDefinitions: [],
        eventDefinitionRefs: [],
        extensionElements: []
      },
      ...(hasBoundary
        ? [{
          _tag: "EndEvent" as const,
          id: "end-error",
          processId: bpmnProcessId,
          parentScopeId: bpmnProcessId,
          incomingSequenceFlowIds: [boundaryFlowId],
          outgoingSequenceFlowIds: [],
          eventDefinitions: [],
          eventDefinitionRefs: [],
          extensionElements: []
        }]
        : [])
    ],
    sequenceFlows: [
      {
        id: "flow-start-task",
        processId: bpmnProcessId,
        parentScopeId: bpmnProcessId,
        sourceId: "start",
        targetId: bpmnTaskNodeId,
        kind: "normal",
        extensionElements: []
      },
      {
        id: taskSuccessFlowId,
        processId: bpmnProcessId,
        parentScopeId: bpmnProcessId,
        sourceId: bpmnTaskNodeId,
        targetId: "end-success",
        kind: "normal",
        extensionElements: []
      },
      ...(hasBoundary
        ? [{
          id: boundaryFlowId,
          processId: bpmnProcessId,
          parentScopeId: bpmnProcessId,
          sourceId: "boundary-error",
          targetId: "end-error",
          kind: "normal" as const,
          extensionElements: []
        }]
        : [])
    ],
    ...(typeof errorRef !== "string"
      ? {}
      : {
        errors: [{
          id: errorRef,
          errorCode: "BRIDGE_BUSINESS"
        }]
      })
  }
}

const prepareBridgeKernel = (
  invocation: Retry.PreparedRetryInvocation,
  errorMapping?: {
    readonly errorTag: string
    readonly errorCode: string | null
    readonly errorRef: string
  },
  bindingOverrides: {
    readonly artifactDigest?: Wire.ArtifactDigest
    readonly semanticNodeId?: Wire.AtomicIdentifier
    readonly catchAllBoundary?: boolean
  } = {}
) =>
  Effect.gen(function*() {
    const binding: BpmnActivityV3.TaskBinding = {
      bindingVersion: BpmnActivityV3.BindingVersion,
      executionProtocolVersion: 3,
      taskNodeId: bpmnTaskNodeId,
      artifactDigest: bindingOverrides.artifactDigest ??
        invocation.artifactDigest,
      semanticNodeId: bindingOverrides.semanticNodeId ??
        invocation.nodeId,
      errorMappings: errorMapping === undefined
        ? []
        : [{
          identity: {
            failureIdentityVersion: 1,
            errorTag: errorMapping.errorTag,
            errorCode: errorMapping.errorCode
          },
          errorRef: errorMapping.errorRef
        }]
    }
    const kernel = yield* BpmnKernel.prepare(
      bridgeBpmnModel(
        bindingOverrides.catchAllBoundary
          ? null
          : errorMapping?.errorRef
      ),
      {
        profileId: "retry-bridge-profile-v1",
        rootProcessId: bpmnProcessId,
        limits: {
          maxAutomaticTransitions: 100
        },
        evaluatorBindings: [],
        taskBindings: [binding]
      }
    ).pipe(Effect.orDie)
    const initialized = BpmnKernel.initialize(
      kernel,
      bpmnServices()
    )
    if (Result.isFailure(initialized)) {
      return yield* Effect.die(initialized.failure)
    }
    const token = initialized.success.state.tokens.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.position._tag === "AtNode" &&
        candidate.position.nodeId === bpmnTaskNodeId
    )
    if (token === undefined) {
      return yield* Effect.die(
        "Expected initialized BPMN bridge Task token"
      )
    }
    return {
      kernel,
      initialized: initialized.success,
      target: {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: bpmnTaskNodeId,
        tokenId: token.tokenId
      } satisfies EffectWorkflowBpmnV3.TaskResolutionTarget
    }
  })

describe("EffectWorkflowRetryV3 contracts", () => {
  it("admits only the closed persisted node-attempt outcomes", () => {
    const succeeded = Schema.decodeUnknownSync(
      Retry.NodeAttemptOutcome
    )({
      _tag: "Succeeded",
      outcomeVersion: 2,
      attempt: 2,
      activityDigest: digest("b"),
      completedAt: nodeAttemptCompletedAt,
      output: {
        _tag: "Inline",
        value: { value: 42 }
      }
    })
    assert.strictEqual(succeeded._tag, "Succeeded")

    const failed = Schema.decodeUnknownSync(
      Retry.NodeAttemptOutcome
    )({
      _tag: "ApplicationFailed",
      outcomeVersion: 2,
      attempt: 1,
      activityDigest: digest("a"),
      completedAt: nodeAttemptCompletedAt,
      failure: applicationFailure
    })
    assert.strictEqual(failed._tag, "ApplicationFailed")
    if (failed._tag === "ApplicationFailed") {
      assert.deepStrictEqual(
        failed.failure.identity,
        applicationFailure.identity
      )
    }

    assert.throws(() =>
      Schema.decodeUnknownSync(Retry.NodeAttemptOutcome)({
        _tag: "ApplicationFailed",
        outcomeVersion: 2,
        attempt: 1,
        activityDigest: digest("a"),
        completedAt: nodeAttemptCompletedAt,
        failure: applicationFailure,
        decodedBusinessFailure: {
          _tag: "BusinessFailure"
        }
      })
    )

    assert.throws(() =>
      Schema.decodeUnknownSync(Retry.NodeAttemptOutcome)({
        _tag: "ApplicationFailed",
        outcomeVersion: 2,
        attempt: 2,
        activityDigest: digest("b"),
        completedAt: nodeAttemptCompletedAt,
        failure: applicationFailure
      })
    )
  })

  it("admits inspectable NonRetryable and Exhausted terminal explanations", () => {
    const nonRetryable = Schema.decodeUnknownSync(
      Retry.TerminalFailure
    )({
      _tag: "NonRetryable",
      terminalVersion: 1,
      cause: applicationFailure,
      initialObservedAt: "2026-01-02T03:04:05.006Z",
      failedObservedAt: "2026-01-02T03:04:05.106Z",
      elapsedMillis: 100,
      decision: {
        _tag: "PolicyOverride",
        decisionVersion: 1,
        matchedBy: "ErrorCode"
      }
    })
    assert.strictEqual(nonRetryable._tag, "NonRetryable")

    const exhausted = Schema.decodeUnknownSync(
      Retry.TerminalFailure
    )({
      _tag: "Exhausted",
      terminalVersion: 1,
      cause: applicationFailure,
      initialObservedAt: "2026-01-02T03:04:05.006Z",
      failedObservedAt: "2026-01-02T03:04:05.106Z",
      elapsedMillis: 100,
      classificationActivityDigest: digest("c"),
      reason: "AttemptLimitReached"
    })
    assert.strictEqual(exhausted._tag, "Exhausted")
  })

  it.effect("prepares only exact process-local inline invocations", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const preparedOccurrence = yield* occurrence(
        fixture,
        "prepared-inline"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: {
          _tag: "Inline",
          value: {}
        }
      })
      assert.isTrue(Retry.isPrepared(invocation))
      assert.isTrue(Object.isFrozen(invocation))
      assert.isFalse(Retry.isPrepared({ ...invocation }))
      assert.deepStrictEqual(invocation, {
        invocationVersion: 2,
        artifactDigest: fixture.verified.artifactDigest,
        occurrenceDigest: preparedOccurrence.occurrenceDigest,
        nodeId: "retry-step",
        firstActivityDigest: invocation.firstActivityDigest
      })
      assert.match(
        invocation.firstActivityDigest,
        /^sha256:[0-9a-f]{64}$/
      )

      let getterReads = 0
      const accessorOptions: Record<string, unknown> = {}
      Object.defineProperties(accessorOptions, {
        artifact: {
          enumerable: true,
          get() {
            getterReads++
            return fixture.resolved
          }
        },
        occurrence: {
          enumerable: true,
          value: preparedOccurrence
        },
        input: {
          enumerable: true,
          value: { _tag: "Inline", value: {} }
        }
      })
      const accessorFailure = yield* Retry.prepare(
        accessorOptions as unknown as Retry.PrepareOptions
      ).pipe(Effect.flip)
      assert.strictEqual(
        accessorFailure.code,
        Retry.ErrorCodes.InvalidInvocation
      )
      assert.strictEqual(getterReads, 0)

      let proxyReads = 0
      const proxiedOptions = new Proxy({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline" as const, value: {} }
      }, {
        get(target, property, receiver) {
          proxyReads++
          return Reflect.get(target, property, receiver)
        }
      })
      const proxied = yield* Retry.prepare(proxiedOptions)
      assert.isTrue(Retry.isPrepared(proxied))
      assert.strictEqual(proxyReads, 0)

      const copiedOccurrence = {
        ...preparedOccurrence
      } as Occurrence.PreparedOccurrence
      const copiedFailure = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: copiedOccurrence,
        input: {
          _tag: "Inline",
          value: {}
        }
      }).pipe(Effect.flip)
      assert.strictEqual(
        copiedFailure.code,
        Retry.ErrorCodes.InvalidInvocation
      )

      const blobFailure = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: {
          _tag: "Blob",
          ref: {
            blobVersion: 1,
            digest: digest("d") as Wire.BlobDigest,
            encodedBytes: 10,
            mediaType: "application/json"
          }
        }
      }).pipe(Effect.flip)
      assert.strictEqual(
        blobFailure.code,
        Retry.ErrorCodes.UnsupportedBlobPayload
      )
    }).pipe(provideCrypto))

  it.effect("prepares independent schedule-to-start and start-to-close timers", () =>
    Effect.gen(function*() {
      for (
        const testCase of [
          {
            id: "schedule-to-start",
            options: {
              scheduleToStart: {
                _tag: "After",
                durationMillis: 1_000
              }
            },
            scheduleToStart: true,
            startToClose: false
          },
          {
            id: "start-to-close",
            options: {
              startToClose: {
                _tag: "After",
                durationMillis: 1_000
              }
            },
            scheduleToStart: false,
            startToClose: true
          },
          {
            id: "both-attempt-timeouts",
            options: {
              scheduleToStart: {
                _tag: "After",
                durationMillis: 1_000
              },
              startToClose: {
                _tag: "After",
                durationMillis: 2_000
              }
            },
            scheduleToStart: true,
            startToClose: true
          }
        ] as const
      ) {
        const fixture = yield* makeFixture(testCase.options)
        const preparedOccurrence = yield* occurrence(
          fixture,
          testCase.id
        )
        const invocation = yield* Retry.prepare({
          artifact: fixture.resolved,
          occurrence: preparedOccurrence,
          input: {
            _tag: "Inline",
            value: {}
          }
        })
        assert.strictEqual(
          invocation.firstScheduleToStartTimerDigest !== undefined,
          testCase.scheduleToStart
        )
        assert.strictEqual(
          invocation.firstStartToCloseTimerDigest !== undefined,
          testCase.startToClose
        )
        if (
          invocation.firstScheduleToStartTimerDigest !== undefined &&
          invocation.firstStartToCloseTimerDigest !== undefined
        ) {
          assert.notStrictEqual(
            invocation.firstScheduleToStartTimerDigest,
            invocation.firstStartToCloseTimerDigest
          )
        }
      }
    }).pipe(provideCrypto))

  it.effect("prepares a content-addressed schedule-to-close controller", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        scheduleToClose: {
          _tag: "After",
          durationMillis: 250
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-controller"
      )
      const first = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: { request: 1 } }
      })
      const replay = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: { request: 1 } }
      })
      const changedInput = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: { request: 2 } }
      })

      assert.match(
        first.scheduleToCloseControllerDigest ?? "",
        /^sha256:[0-9a-f]{64}$/
      )
      assert.strictEqual(
        first.scheduleToCloseControllerDigest,
        replay.scheduleToCloseControllerDigest
      )
      assert.notStrictEqual(
        first.scheduleToCloseControllerDigest,
        changedInput.scheduleToCloseControllerDigest
      )
    }).pipe(provideCrypto))
})

describe("EffectWorkflowRetryV3 BPMN bridge integration", () => {
  it.effect("executes once, retains the raw success, and resolves and replays the exact BPMN Task", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 41 }
          })) as Node.Handler<typeof retryNode>
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-success"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(invocation)
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          authority.target
        )
      )

      const receipt = yield* Effect.gen(function*() {
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-success" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
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
      assert.strictEqual(receipt.retryOutcome._tag, "Succeeded")
      if (receipt.retryOutcome._tag !== "Succeeded") {
        return yield* Effect.die(
          "Expected native successful retry outcome"
        )
      }
      assert.deepStrictEqual(receipt.retryOutcome.output, {
        _tag: "Inline",
        value: { value: 41 }
      })
      assert.deepStrictEqual(receipt.command, {
        commandVersion: BpmnActivityV3.CommandVersion,
        scopeInstanceId: authority.target.scopeInstanceId,
        taskNodeId: authority.target.taskNodeId,
        tokenId: authority.target.tokenId,
        outcome: {
          _tag: "Succeeded",
          outcomeVersion: BpmnActivityV3.OutcomeVersion,
          artifactDigest: invocation.artifactDigest,
          semanticNodeId: invocation.nodeId,
          occurrenceDigest: invocation.occurrenceDigest,
          firstActivityDigest: invocation.firstActivityDigest,
          attempt: 1,
          completedActivityDigest: receipt.retryOutcome.activityDigest
        }
      })
      assert.strictEqual(
        receipt.retryOutcome.activityDigest,
        invocation.firstActivityDigest
      )

      const resolved = BpmnKernel.resolveTask(
        authority.kernel,
        authority.initialized.state,
        receipt.command,
        bpmnServices()
      )
      assert(Result.isSuccess(resolved))
      assert.strictEqual(resolved.success.state.status, "completed")
      assert.deepStrictEqual(
        resolved.success.state.activityResolutions[0]?.outcome,
        receipt.command.outcome
      )
      const replayed = BpmnKernel.resolveTask(
        authority.kernel,
        resolved.success.state,
        receipt.command,
        bpmnServices()
      )
      assert(Result.isSuccess(replayed))
      assert.deepStrictEqual(replayed.success.events, [{
        _tag: "TaskOutcomeReplayed",
        tokenId: authority.target.tokenId,
        occurrenceDigest: invocation.occurrenceDigest,
        observedAt: bpmnNow
      }])
    }).pipe(provideCrypto))

  it.effect("promotes an exact policy override into the mapped interrupting Boundary Error", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let classifierRuns = 0
      const errorRef = "bridge-business-error"
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.suspend(() => {
            handlerRuns++
            return Effect.fail(
              businessFailure(
                "BOUNDARY_DENIED",
                "mapped policy denial"
              )
            )
          })) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        nonRetryableErrorCodes: ["BOUNDARY_DENIED"]
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-business-failure"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(
        invocation,
        {
          errorTag: "BusinessFailure",
          errorCode: "BOUNDARY_DENIED",
          errorRef
        }
      )
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          authority.target
        )
      )

      const receipt = yield* Effect.gen(function*() {
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-business-failure" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
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
      assert.strictEqual(classifierRuns, 0)
      assert.strictEqual(
        receipt.retryOutcome._tag,
        "NonRetryable"
      )
      assert.strictEqual(
        receipt.command.outcome._tag,
        "BusinessFailed"
      )
      if (
        receipt.retryOutcome._tag !== "NonRetryable" ||
        receipt.command.outcome._tag !== "BusinessFailed"
      ) {
        return yield* Effect.die(
          "Expected exact bridged business terminal"
        )
      }
      assert.deepStrictEqual(
        receipt.retryOutcome.decision,
        {
          _tag: "PolicyOverride",
          decisionVersion: 1,
          matchedBy: "ErrorCode"
        }
      )
      assert.deepStrictEqual(
        receipt.command.outcome.identity,
        {
          failureIdentityVersion: 1,
          errorTag: "BusinessFailure",
          errorCode: "BOUNDARY_DENIED"
        }
      )
      assert.deepStrictEqual(
        receipt.command.outcome.terminal,
        {
          _tag: "NonRetryable",
          terminalVersion: 1,
          decision: receipt.retryOutcome.decision
        }
      )
      assert.strictEqual(
        receipt.command.outcome.failedActivityDigest,
        receipt.retryOutcome.cause.activityDigest
      )

      const resolved = BpmnKernel.resolveTask(
        authority.kernel,
        authority.initialized.state,
        receipt.command,
        bpmnServices()
      )
      assert(Result.isSuccess(resolved))
      assert.strictEqual(resolved.success.state.status, "completed")
      assert(
        resolved.success.events.some((event) =>
          event._tag === "BoundaryErrorCaught" &&
          event.taskNodeId === bpmnTaskNodeId &&
          event.boundaryEventId === "boundary-error" &&
          event.errorRef === errorRef
        )
      )
      assert.isFalse(
        resolved.success.events.some((event) => event._tag === "ExecutionFailed")
      )
    }).pipe(provideCrypto))

  it.effect("preserves an exhausted retry explanation in the BPMN business-failure command", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.suspend(() => {
            handlerRuns++
            return Effect.fail(
              businessFailure(
                "STILL_RETRYABLE",
                "attempt budget exhausted"
              )
            )
          })) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-exhausted"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(invocation)
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          authority.target
        )
      )

      const receipt = yield* Effect.gen(function*() {
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-exhausted" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
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
      assert.strictEqual(classifierRuns, 1)
      assert.strictEqual(receipt.retryOutcome._tag, "Exhausted")
      assert.strictEqual(
        receipt.command.outcome._tag,
        "BusinessFailed"
      )
      if (
        receipt.retryOutcome._tag !== "Exhausted" ||
        receipt.command.outcome._tag !== "BusinessFailed" ||
        receipt.command.outcome.terminal._tag !== "Exhausted"
      ) {
        return yield* Effect.die(
          "Expected exact bridged exhausted terminal"
        )
      }
      assert.strictEqual(
        receipt.retryOutcome.reason,
        "AttemptLimitReached"
      )
      assert.strictEqual(
        receipt.command.outcome.terminal.reason,
        receipt.retryOutcome.reason
      )
      assert.strictEqual(
        receipt.command.outcome.terminal
          .classificationActivityDigest,
        receipt.retryOutcome.classificationActivityDigest
      )
      assert.strictEqual(
        receipt.command.outcome.failedActivityDigest,
        receipt.retryOutcome.cause.activityDigest
      )
      assert.strictEqual(
        receipt.command.outcome.attempt,
        receipt.retryOutcome.cause.attempt
      )

      const resolved = BpmnKernel.resolveTask(
        authority.kernel,
        authority.initialized.state,
        receipt.command,
        bpmnServices()
      )
      assert(Result.isSuccess(resolved))
      assert.strictEqual(resolved.success.state.status, "failed")
      assert(
        resolved.success.events.some((event) =>
          event._tag === "ExecutionFailed" &&
          event.failureKind === "UnmappedBusinessFailure" &&
          event.taskNodeId === bpmnTaskNodeId
        )
      )
    }).pipe(provideCrypto))

  it.effect("rejects copied invocation provenance before the bridge handler runs", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 43 }
          })) as Node.Handler<typeof retryNode>
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-copied-invocation"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(invocation)
      const copied = {
        ...invocation
      } as Retry.PreparedRetryInvocation
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          copied,
          authority.target
        )
      )

      yield* Effect.gen(function*() {
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-copied-invocation" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.instanceOf(
          failure,
          EffectWorkflowBpmnV3.EffectWorkflowBpmnError
        )
        assert.strictEqual(
          (failure as EffectWorkflowBpmnV3.EffectWorkflowBpmnError)
            .code,
          EffectWorkflowBpmnV3.ErrorCodes.InvalidInvocation
        )
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("rejects an artifact-mismatched compiled Task binding before the handler runs", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 44 }
          })) as Node.Handler<typeof retryNode>
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-binding-mismatch"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(
        invocation,
        undefined,
        {
          artifactDigest: digest("f") as Wire.ArtifactDigest
        }
      )
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          authority.target
        )
      )

      yield* Effect.gen(function*() {
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-binding-mismatch" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.instanceOf(
          failure,
          EffectWorkflowBpmnV3.EffectWorkflowBpmnError
        )
        assert.strictEqual(
          (failure as EffectWorkflowBpmnV3.EffectWorkflowBpmnError)
            .code,
          EffectWorkflowBpmnV3.ErrorCodes
            .InvocationBindingMismatch
        )
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("rejects an accessor-backed Task target without invoking it or the handler", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let getterReads = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 45 }
          })) as Node.Handler<typeof retryNode>
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-accessor-target"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(invocation)
      const target: Record<string, unknown> = {
        scopeInstanceId: authority.target.scopeInstanceId,
        taskNodeId: authority.target.taskNodeId
      }
      Object.defineProperty(target, "tokenId", {
        enumerable: true,
        get() {
          getterReads++
          return authority.target.tokenId
        }
      })
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          target as unknown as EffectWorkflowBpmnV3.TaskResolutionTarget
        )
      )

      yield* Effect.gen(function*() {
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-accessor-target" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.instanceOf(
          failure,
          EffectWorkflowBpmnV3.EffectWorkflowBpmnError
        )
        assert.strictEqual(
          (failure as EffectWorkflowBpmnV3.EffectWorkflowBpmnError)
            .code,
          EffectWorkflowBpmnV3.ErrorCodes.InvalidTaskTarget
        )
        assert.strictEqual(getterReads, 0)
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps attempt timeout typed and away from a catch-all Boundary Error", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let handlerRuns = 0
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            handlerRuns++
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep(10_000)
            return { value: 46 }
          })) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classifierRuns++
            assert.strictEqual(failure._tag, "AttemptTimeout")
            if (failure._tag === "AttemptTimeout") {
              assert.strictEqual(
                failure.timeoutKind,
                "StartToClose"
              )
            }
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-start-to-close"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(
        invocation,
        undefined,
        { catchAllBoundary: true }
      )
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          authority.target
        )
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-start-to-close" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(101)
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "AttemptTimedOut"
        )
        const timedOut = failure as Retry.AttemptTimedOut
        assert.strictEqual(
          timedOut.timeout.timeout.timeoutKind,
          "StartToClose"
        )
        assert.strictEqual(timedOut.timeout.attempt, 1)
        assert.strictEqual(
          timedOut.timeout.activityDigest,
          invocation.firstActivityDigest
        )
        assert(
          Result.isFailure(
            Schema.decodeUnknownResult(
              EffectWorkflowBpmnV3.ResolvableRetryOutcome
            )(timedOut)
          )
        )
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classifierRuns, 1)

        assert.strictEqual(
          authority.initialized.state.status,
          "active"
        )
        assert.isFalse(
          authority.initialized.events.some((event) => event._tag === "BoundaryErrorCaught")
        )
        assert.isFalse(
          authority.initialized.state.activityResolutions.some(
            (resolution) => resolution.outcome._tag === "BusinessFailed"
          )
        )
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps schedule-to-close timeout in the typed bridge failure channel", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            handlerRuns++
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep(101)
            return { value: 47 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "bridge-schedule-to-close"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const authority = yield* prepareBridgeKernel(invocation)
      const registration = BridgeWorkflow.toLayer(() =>
        bridgeRetryExecution(
          authority.kernel,
          invocation,
          authority.target
        )
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* BridgeWorkflow.execute(
          { id: "bridge-schedule-to-close" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(101)
        const terminal = yield* pollUntilComplete(
          BridgeWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.strictEqual(handlerRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))
})

describe("EffectWorkflowRetryV3 managed runtime", () => {
  it.effect("returns one raw successful attempt with durable coordinates and encoded output", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 17 }
          })) as Node.Handler<typeof retryNode>
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "detailed-success"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* DetailedWorkflow.execute(
          { id: "detailed-success" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value._tag, "Succeeded")
          if (terminal.exit.value._tag === "Succeeded") {
            assert.strictEqual(terminal.exit.value.attempt, 1)
            assert.strictEqual(
              terminal.exit.value.activityDigest,
              invocation.firstActivityDigest
            )
            assert.deepStrictEqual(terminal.exit.value.output, {
              _tag: "Inline",
              value: { value: 17 }
            })
          }
        }
        assert.strictEqual(handlerRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns a business terminal as a detailed success value", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.suspend(() => {
            handlerRuns++
            return Effect.fail(
              businessFailure(
                "DETAILED_DENIED",
                "detailed denial"
              )
            )
          })) as Node.Handler<
            typeof retryNode
          >,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "NonRetryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "detailed-non-retryable"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* DetailedWorkflow.execute(
          { id: "detailed-non-retryable" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(
            terminal.exit.value._tag,
            "NonRetryable"
          )
          if (terminal.exit.value._tag === "NonRetryable") {
            assert.strictEqual(
              terminal.exit.value.cause.activityDigest,
              invocation.firstActivityDigest
            )
            assert.strictEqual(
              terminal.exit.value.cause.identity.errorCode,
              "DETAILED_DENIED"
            )
          }
        }
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classifierRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns schedule-to-close timeout as a detailed success value", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep(101)
            return { value: 29 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "detailed-schedule-to-close"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* DetailedWorkflow.execute(
          { id: "detailed-schedule-to-close" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(101)
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(
            terminal.exit.value._tag,
            "ScheduleToCloseTimedOut"
          )
          if (
            terminal.exit.value._tag ===
              "ScheduleToCloseTimedOut"
          ) {
            assert.strictEqual(
              terminal.exit.value.firstActivityDigest,
              invocation.firstActivityDigest
            )
            assert.strictEqual(
              terminal.exit.value.controllerOperationDigest,
              invocation.scheduleToCloseControllerDigest
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
    }).pipe(provideCrypto))

  it.effect("rejects a copied invocation before the detailed handler runs", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 23 }
          })) as Node.Handler<typeof retryNode>
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "detailed-copied-invocation"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const copied = {
        ...invocation
      } as Retry.PreparedRetryInvocation
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(copied))

      yield* Effect.gen(function*() {
        const executionId = yield* DetailedWorkflow.execute(
          { id: "detailed-copied-invocation" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as Retry.EffectWorkflowRetryError).code,
          Retry.ErrorCodes.InvalidInvocation
        )
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("completes the managed loop before an armed schedule-to-close deadline", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) =>
          Effect.sync(() => {
            attempts.push(request.context.attempt)
            return { value: 7 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-completes"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-completes" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, { value: 7 })
        }
        assert.deepStrictEqual(attempts, [1])
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("does not dispatch an attempt when the armed deadline is already due", () =>
    Effect.gen(function*() {
      const clockArmed = yield* Deferred.make<void>()
      const releaseClockAcknowledgement = yield* Deferred.make<void>()
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 31 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-already-due"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))
      const delayedEngine = Layer.effect(
        WorkflowEngine.WorkflowEngine
      )(
        Effect.map(
          WorkflowEngine.WorkflowEngine,
          (delegate) => {
            let wrapped: typeof delegate
            wrapped = {
              ...delegate,
              register: ((workflow, execute) =>
                delegate.register(
                  workflow,
                  (payload, executionId) =>
                    execute(payload, executionId).pipe(
                      Effect.provideService(
                        WorkflowEngine.WorkflowEngine,
                        wrapped
                      )
                    )
                )) as typeof delegate.register,
              scheduleClock: (workflow, options) =>
                Effect.gen(function*() {
                  // Delegate first: the native backend has durably armed the
                  // deadline before this acknowledgement is held back.
                  yield* delegate.scheduleClock(workflow, options)
                  yield* Deferred.succeed(clockArmed, undefined)
                  yield* Deferred.await(releaseClockAcknowledgement)
                })
            }
            return wrapped
          }
        )
      ).pipe(
        Layer.provide(WorkflowEngine.layerMemory)
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-already-due" },
          { discard: true }
        )
        yield* Deferred.await(clockArmed)

        // The backend clock is armed, but scheduleClock has not yet returned
        // to the retry controller, so no observation or attempt can start.
        yield* TestClock.adjust(100)
        yield* Deferred.succeed(releaseClockAcknowledgement, undefined)
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(delayedEngine)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns and replays timeout without joining an uninterruptible active attempt", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      let handlerRuns = 0
      let workflowPasses = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.uninterruptible(
            Effect.gen(function*() {
              handlerRuns++
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(blocked)
              return { value: 99 }
            })
          )) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-active-attempt"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowRetryV3/UninterruptibleTimeoutReplayGate"
      )
      const gateToken = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ReplayWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const result = yield* Effect.exit(
            retryExecution(invocation)
          )
          yield* Deferred.succeed(
            gateToken,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return yield* result
        })
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* ReplayWorkflow.execute(
          { id: "schedule-to-close-active-attempt" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(99)
        const beforeDeadline = yield* ReplayWorkflow.poll(executionId)
        assert.isTrue(
          Option.isNone(beforeDeadline) ||
            beforeDeadline.value._tag === "Suspended"
        )
        yield* TestClock.adjust(1)
        const token = yield* Deferred.await(gateToken)

        // Reaching the gate proves Retry.execute already returned timeout even
        // though the uninterruptible handler is still physically blocked.
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(workflowPasses, 1)
        const beforeUnblock = yield* ReplayWorkflow.poll(executionId)
        assert.isTrue(
          Option.isNone(beforeUnblock) ||
            beforeUnblock.value._tag === "Suspended"
        )

        yield* Deferred.succeed(blocked, undefined)
        const suspended = yield* pollUntilObserved(
          ReplayWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")
        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ReplayWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        const timedOut = failure as Retry.ScheduleToCloseTimedOut
        assert.strictEqual(timedOut.timeoutKind, "ScheduleToClose")
        assert.strictEqual(timedOut.durationMillis, 100)
        assert.strictEqual(
          timedOut.controllerOperationDigest,
          invocation.scheduleToCloseControllerDigest
        )
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(workflowPasses, 2)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("publishes timeout when a handler finishes after the durable deadline", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            handlerRuns++
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep(101)
            return { value: 101 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-late-success"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-late-success" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(101)
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.strictEqual(handlerRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("lets schedule-to-close win during durable retry backoff", () =>
    Effect.gen(function*() {
      const classified = yield* Deferred.make<void>()
      const attempts: Array<number> = []
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) =>
          Effect.sync(() => {
            attempts.push(request.context.attempt)
            return businessFailure("BACKOFF_TIMEOUT")
          }).pipe(Effect.flip)) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Deferred.succeed(classified, undefined).pipe(
            Effect.as({
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            })
          ),
        maximumAttempts: 3,
        delayMillis: 200,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-backoff"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-backoff" },
          { discard: true }
        )
        yield* Deferred.await(classified)
        yield* TestClock.adjust(100)
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.deepStrictEqual(attempts, [1])
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("replays a persisted completion winner without rerunning the handler", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let workflowPasses = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 17 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 1_000
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-winner-replay"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowRetryV3/ScheduleToCloseReplayGate"
      )
      const gateToken = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ReplayWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const output = yield* retryExecution(invocation)
          yield* Deferred.succeed(
            gateToken,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return output
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* ReplayWorkflow.execute(
          { id: "schedule-to-close-winner-replay" },
          { discard: true }
        )
        const token = yield* Deferred.await(gateToken)
        const suspended = yield* pollUntilObserved(
          ReplayWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(workflowPasses, 1)

        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ReplayWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, {
            value: 17
          })
        }
        assert.strictEqual(workflowPasses, 2)
        assert.strictEqual(handlerRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("defects on a persisted winner whose internal attempt coordinates are corrupt", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 23 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 1_000
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-corrupt-winner"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DefectWorkflow.toLayer(() => retryExecution(invocation))
      const operationName = expectSuccess(NativeName.name({
        _tag: "RetryScheduleToClose",
        coordinateVersion: NativeName.CoordinateVersion,
        occurrenceDigest: preparedOccurrence.occurrenceDigest,
        operationId: "workflow-builder.retry.schedule-to-close",
        generation: 0
      }))
      const durableWinner = NativeDeferred.make(
        `raceAll/${operationName}`,
        {
          success: Retry.RetryScheduleToCloseWinner,
          error: Schema.Never
        }
      )

      yield* Effect.gen(function*() {
        const payload = {
          id: "schedule-to-close-corrupt-winner"
        }
        const executionId = yield* DefectWorkflow.executionId(payload)
        const token = new NativeDeferred.TokenParsed({
          workflowName: DefectWorkflow._tag,
          executionId,
          deferredName: durableWinner.name
        }).asToken
        yield* NativeDeferred.succeed(durableWinner, {
          token,
          value: {
            _tag: "RetryScheduleToCloseWinner",
            outcomeEnvelopeVersion: 2,
            controllerOperationDigest: invocation.scheduleToCloseControllerDigest!,
            exit: Exit.succeed({
              _tag: "Succeeded",
              outcomeVersion: 2,
              attempt: 1,
              activityDigest: digest("f") as Wire.OperationDigest,
              completedAt: nodeAttemptCompletedAt,
              output: {
                _tag: "Inline",
                value: { value: 999 }
              }
            })
          }
        })

        yield* DefectWorkflow.execute(payload, { discard: true })
        const terminal = yield* pollUntilComplete(
          DefectWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          const died = terminal.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          assert.isDefined(died)
          if (died?._tag === "Die") {
            assert.strictEqual(
              (died.defect as { readonly _tag?: unknown })._tag,
              "EffectWorkflowRetryError"
            )
            assert.strictEqual(
              (died.defect as { readonly code?: unknown }).code,
              Retry.ErrorCodes.OperationPreparationFailed
            )
          }
        }
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("retries through internal jitter and a durable timer without rerunning the handler, classifier, or failure encoder on replay", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let randomRuns = 0
      let workflowPasses = 0
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) => {
          attempts.push(request.context.attempt)
          return request.context.attempt === 1
            ? Effect.fail(
              businessFailure("REPLAY_TEMPORARY")
            )
            : Effect.succeed({ value: 42 })
        }) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 3,
        delayMillis: 100,
        jitter: {
          _tag: "RecordedRange",
          minimumPermille: 500,
          maximumPermille: 1_500
        }
      })
      failureEncodeCounts.clear()
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-replay"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowRetryV3/ReplayGate"
      )
      const gateToken = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ReplayWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const output = yield* retryExecution(invocation)
          yield* Deferred.succeed(
            gateToken,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return output
        })
      )
      const random = {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => {
          randomRuns++
          return 0
        }
      }

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* ReplayWorkflow.execute(
          { id: "managed-replay" },
          { discard: true }
        )
        const timerState = yield* pollUntilObserved(
          ReplayWorkflow,
          executionId
        )
        assert.strictEqual(timerState._tag, "Suspended")
        assert.deepStrictEqual(attempts, [1])
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(randomRuns, 1)
        assert.strictEqual(
          failureEncodeCounts.get("REPLAY_TEMPORARY"),
          1
        )
        const classifiedFailure = classified[0]
        assert.strictEqual(
          classifiedFailure?._tag,
          "ApplicationFailure"
        )
        if (
          classifiedFailure?._tag === "ApplicationFailure"
        ) {
          assert.deepStrictEqual(classifiedFailure.identity, {
            failureIdentityVersion: 1,
            errorTag: "BusinessFailure",
            errorCode: "REPLAY_TEMPORARY"
          })
          assert.deepStrictEqual(classifiedFailure.failure, {
            _tag: "Inline",
            value: businessFailure("REPLAY_TEMPORARY")
          })
        }

        yield* TestClock.adjust(49)
        assert.deepStrictEqual(attempts, [1])
        yield* TestClock.adjust(1)
        const token = yield* Deferred.await(gateToken)
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual(workflowPasses, 2)

        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ReplayWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, {
            value: 42
          })
        }
        assert.strictEqual(workflowPasses, 2)
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(randomRuns, 1)
        assert.strictEqual(
          failureEncodeCounts.get("REPLAY_TEMPORARY"),
          1
        )
      }).pipe(
        Effect.provideService(Random.Random, random),
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns NonRetryable from the durable classifier decision", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.fail(
            businessFailure("DENIED", "approval denied")
          )) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "NonRetryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-non-retryable"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "managed-non-retryable" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "NonRetryable"
        )
        const nonRetryable = failure as Retry.NonRetryable
        assert.strictEqual(
          nonRetryable.decision._tag,
          "Classifier"
        )
        assert.strictEqual(
          nonRetryable.cause.identity.errorCode,
          "DENIED"
        )
        assert.strictEqual(classifierRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps an admitted EffectWorkflowSemanticError instance in the business-failure channel", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      let classified: ActivityPolicyV3.RetryFailureCause | undefined
      const semanticLooking = new NativeSemantic.EffectWorkflowSemanticError({
        code: NativeSemantic.ErrorCodes.InvalidActivityInput,
        message: "admitted business failure"
      })
      assert.instanceOf(
        semanticLooking,
        NativeSemantic.EffectWorkflowSemanticError
      )
      const fixture = yield* makeFixture({
        handler: (() => Effect.fail(semanticLooking)) as Node.Handler<
          typeof retryNode
        >,
        classifier: (failure) =>
          Effect.sync(() => {
            classifierRuns++
            classified = failure
            return {
              _tag: "NonRetryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-semantic-looking-business-failure"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "managed-semantic-looking-business-failure" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "NonRetryable"
        )
        assert.strictEqual(classifierRuns, 1)
        assert.strictEqual(
          classified?._tag,
          "ApplicationFailure"
        )
        if (classified?._tag === "ApplicationFailure") {
          assert.deepStrictEqual(classified.identity, {
            failureIdentityVersion: 1,
            errorTag: "EffectWorkflowSemanticError",
            errorCode: NativeSemantic.ErrorCodes.InvalidActivityInput
          })
          assert.deepStrictEqual(classified.failure, {
            _tag: "Inline",
            value: {
              _tag: "EffectWorkflowSemanticError",
              code: NativeSemantic.ErrorCodes.InvalidActivityInput,
              message: "admitted business failure"
            }
          })
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("short-circuits the classifier for explicit non-retryable error tags and codes", () =>
    Effect.gen(function*() {
      const cases = [
        {
          id: "managed-explicit-tag",
          code: "TAG_MATCH",
          nonRetryableErrorTags: ["BusinessFailure"],
          nonRetryableErrorCodes: [] as ReadonlyArray<string>,
          matchedBy: "ErrorTag" as const
        },
        {
          id: "managed-explicit-code",
          code: "CODE_MATCH",
          nonRetryableErrorTags: [] as ReadonlyArray<string>,
          nonRetryableErrorCodes: ["CODE_MATCH"],
          matchedBy: "ErrorCode" as const
        }
      ] as const

      for (const testCase of cases) {
        let classifierRuns = 0
        const fixture = yield* makeFixture({
          handler: (() =>
            Effect.fail(
              businessFailure(testCase.code)
            )) as Node.Handler<typeof retryNode>,
          classifier: () =>
            Effect.sync(() => {
              classifierRuns++
              return {
                _tag: "Retryable" as const,
                classificationVersion: 1 as const
              }
            }),
          nonRetryableErrorTags: testCase.nonRetryableErrorTags,
          nonRetryableErrorCodes: testCase.nonRetryableErrorCodes
        })
        const preparedOccurrence = yield* occurrence(
          fixture,
          testCase.id
        )
        const invocation = yield* Retry.prepare({
          artifact: fixture.resolved,
          occurrence: preparedOccurrence,
          input: { _tag: "Inline", value: {} }
        })
        const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

        yield* Effect.gen(function*() {
          const executionId = yield* RuntimeWorkflow.execute(
            { id: testCase.id },
            { discard: true }
          )
          const terminal = yield* pollUntilComplete(
            RuntimeWorkflow,
            executionId
          )
          const failure = failReason(terminal.exit)
          assert.strictEqual(
            (failure as { readonly _tag?: unknown })._tag,
            "NonRetryable"
          )
          const nonRetryable = failure as Retry.NonRetryable
          assert.deepStrictEqual(nonRetryable.decision, {
            _tag: "PolicyOverride",
            decisionVersion: 1,
            matchedBy: testCase.matchedBy
          })
          assert.strictEqual(classifierRuns, 0)
        }).pipe(
          Effect.provide(
            registration.pipe(
              Layer.provideMerge(WorkflowEngine.layerMemory)
            )
          )
        )
      }
    }).pipe(provideCrypto))

  it.effect("returns Exhausted after an exact retryable classification at the attempt limit", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return businessFailure("TEMPORARY")
          }).pipe(Effect.flip)) as Node.Handler<
            typeof retryNode
          >,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-exhausted"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "managed-exhausted" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "Exhausted"
        )
        assert.strictEqual(
          (failure as Retry.Exhausted).reason,
          "AttemptLimitReached"
        )
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classifierRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps a failure-codec violation as a defect and never classifies it", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.fail({
            _tag: "NotAdmitted",
            code: "INVALID",
            message: "invalid failure shape"
          })) as unknown as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-codec-defect"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DefectWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* DefectWorkflow.execute(
          { id: "managed-codec-defect" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          DefectWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          assert.isFalse(
            terminal.exit.cause.reasons.some(
              (reason) => reason._tag === "Fail"
            )
          )
          const died = terminal.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          assert.isDefined(died)
          if (died?._tag === "Die") {
            assert.strictEqual(
              (died.defect as { readonly _tag?: unknown })._tag,
              "EffectWorkflowActivityDefect"
            )
            assert.strictEqual(
              (died.defect as { readonly code?: unknown }).code,
              NativeSemantic.ActivityDefectCodes.InvalidFailure
            )
          }
        }
        assert.strictEqual(classifierRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("classifies schedule-to-start when dispatch cannot reach the worker boundary before its deadline", () =>
    Effect.gen(function*() {
      const activityDispatched = yield* Deferred.make<void>()
      const releaseActivityDispatch = yield* Deferred.make<void>()
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let handlerRuns = 0
      let scheduleAcknowledgements = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 71 }
          })) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1,
        scheduleToStart: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-start-dispatch-timeout"
      )
      const nodeAttemptName = expectSuccess(NativeName.name({
        _tag: "Activity",
        coordinateVersion: NativeName.CoordinateVersion,
        occurrenceDigest: preparedOccurrence.occurrenceDigest,
        operationId: "workflow-builder.retry.node-attempt"
      }))
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))
      const delayedEngine = Layer.effect(
        WorkflowEngine.WorkflowEngine
      )(
        Effect.map(
          WorkflowEngine.WorkflowEngine,
          (delegate) => {
            let wrapped: typeof delegate
            let nodeAttemptDelayed = false
            wrapped = {
              ...delegate,
              register: ((workflow, execute) =>
                delegate.register(
                  workflow,
                  (payload, executionId) =>
                    execute(payload, executionId).pipe(
                      Effect.provideService(
                        WorkflowEngine.WorkflowEngine,
                        wrapped
                      )
                    )
                )) as typeof delegate.register,
              activityExecute: ((activity, attempt) => {
                if (
                  activity.name !== nodeAttemptName ||
                  nodeAttemptDelayed
                ) {
                  return delegate.activityExecute(
                    activity,
                    attempt
                  )
                }
                nodeAttemptDelayed = true
                return Effect.gen(function*() {
                  yield* Deferred.succeed(
                    activityDispatched,
                    undefined
                  )
                  yield* Deferred.await(
                    releaseActivityDispatch
                  )
                  return yield* delegate.activityExecute(
                    activity,
                    attempt
                  )
                })
              }) as typeof delegate.activityExecute,
              scheduleDeferred: ((deferred, options) => {
                const scheduledKind = (
                  options.value as {
                    readonly timeout?: {
                      readonly timeoutKind?: unknown
                    }
                  }
                ).timeout?.timeoutKind
                if (scheduledKind === "ScheduleToStart") {
                  scheduleAcknowledgements++
                  // Model a backend which durably accepted the timer but
                  // delivers it late. The absolute armed deadline must still
                  // prevent a late worker from starting user code.
                  return Effect.void
                }
                return delegate.scheduleDeferred(
                  deferred,
                  options
                )
              }) as typeof delegate.scheduleDeferred
            }
            return wrapped
          }
        )
      ).pipe(
        Layer.provide(WorkflowEngine.layerMemory)
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* DetailedWorkflow.execute(
          { id: "schedule-to-start-dispatch-timeout" },
          { discard: true }
        )
        yield* Deferred.await(activityDispatched)
        assert.strictEqual(handlerRuns, 0)
        assert.strictEqual(scheduleAcknowledgements, 1)

        yield* TestClock.adjust(100)
        yield* Deferred.succeed(
          releaseActivityDispatch,
          undefined
        )
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(
            terminal.exit.value._tag,
            "AttemptTimedOut"
          )
          if (terminal.exit.value._tag === "AttemptTimedOut") {
            assert.strictEqual(
              terminal.exit.value.timeout.timeout.timeoutKind,
              "ScheduleToStart"
            )
            assert.strictEqual(
              terminal.exit.value.timeout.attempt,
              1
            )
            assert.strictEqual(
              terminal.exit.value.timeout.activityDigest,
              invocation.firstActivityDigest
            )
            assert.strictEqual(
              terminal.exit.value.decision._tag,
              "Exhausted"
            )
          }
        }
        assert.strictEqual(handlerRuns, 0)
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(classified[0]?._tag, "AttemptTimeout")
        if (classified[0]?._tag === "AttemptTimeout") {
          assert.strictEqual(
            classified[0].timeoutKind,
            "ScheduleToStart"
          )
          assert.strictEqual(classified[0].attempt, 1)
          assert.strictEqual(
            classified[0].activityDigest,
            invocation.firstActivityDigest
          )
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(delayedEngine)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns start-to-close timeout without joining an uninterruptible attempt", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.uninterruptible(
            Effect.gen(function*() {
              handlerRuns++
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(blocked)
              return { value: 73 }
            })
          )) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "start-to-close-uninterruptible-timeout"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* DetailedWorkflow.execute(
          { id: "start-to-close-uninterruptible-timeout" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(100)

        // Completion before releasing `blocked` proves the retry controller
        // observes the durable timeout without joining its losing activity.
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(
            terminal.exit.value._tag,
            "AttemptTimedOut"
          )
          if (terminal.exit.value._tag === "AttemptTimedOut") {
            assert.strictEqual(
              terminal.exit.value.timeout.timeout.timeoutKind,
              "StartToClose"
            )
            assert.strictEqual(
              terminal.exit.value.timeout.attempt,
              1
            )
            assert.strictEqual(
              terminal.exit.value.timeout.activityDigest,
              invocation.firstActivityDigest
            )
          }
        }
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(classified[0]?._tag, "AttemptTimeout")
        if (classified[0]?._tag === "AttemptTimeout") {
          assert.strictEqual(
            classified[0].timeoutKind,
            "StartToClose"
          )
        }
        yield* Deferred.succeed(blocked, undefined)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns the authorized start-to-close timeout when a persisted start acknowledgement is late", () =>
    Effect.gen(function*() {
      const startPersisted = yield* Deferred.make<void>()
      const releaseStartAcknowledgement = yield* Deferred.make<void>()
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let handlerRuns = 0
      let scheduleAcknowledgements = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 77 }
          })) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "start-to-close-late-start-acknowledgement"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))
      const delayedEngine = Layer.effect(
        WorkflowEngine.WorkflowEngine
      )(
        Effect.map(
          WorkflowEngine.WorkflowEngine,
          (delegate) => {
            let wrapped: typeof delegate
            let startAcknowledgementDelayed = false
            wrapped = {
              ...delegate,
              register: ((workflow, execute) =>
                delegate.register(
                  workflow,
                  (payload, executionId) =>
                    execute(payload, executionId).pipe(
                      Effect.provideService(
                        WorkflowEngine.WorkflowEngine,
                        wrapped
                      )
                    )
                )) as typeof delegate.register,
              deferredResolve: ((deferred, options) => {
                const isStarted = Exit.isSuccess(
                  options.exit
                ) &&
                  (
                      options.exit.value as {
                        readonly _tag?: unknown
                      }
                    )._tag === "Started"
                if (
                  !isStarted ||
                  startAcknowledgementDelayed
                ) {
                  return delegate.deferredResolve(
                    deferred,
                    options
                  )
                }
                startAcknowledgementDelayed = true
                return Effect.gen(function*() {
                  // Persist the canonical Started value first, then model a
                  // delayed backend acknowledgement to the activity worker.
                  const canonical = yield* delegate
                    .deferredResolve(deferred, options)
                  yield* Deferred.succeed(
                    startPersisted,
                    undefined
                  )
                  yield* Deferred.await(
                    releaseStartAcknowledgement
                  )
                  return canonical
                })
              }) as typeof delegate.deferredResolve,
              scheduleDeferred: ((deferred, options) => {
                const scheduledKind = (
                  options.value as {
                    readonly timeout?: {
                      readonly timeoutKind?: unknown
                    }
                  }
                ).timeout?.timeoutKind
                if (scheduledKind === "StartToClose") {
                  scheduleAcknowledgements++
                  return Effect.void
                }
                return delegate.scheduleDeferred(
                  deferred,
                  options
                )
              }) as typeof delegate.scheduleDeferred
            }
            return wrapped
          }
        )
      ).pipe(
        Layer.provide(WorkflowEngine.layerMemory)
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* DetailedWorkflow.execute(
          {
            id: "start-to-close-late-start-acknowledgement"
          },
          { discard: true }
        )
        yield* Deferred.await(startPersisted)
        assert.strictEqual(handlerRuns, 0)
        assert.strictEqual(scheduleAcknowledgements, 0)

        yield* TestClock.adjust(100)
        yield* Deferred.succeed(
          releaseStartAcknowledgement,
          undefined
        )
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(
            terminal.exit.value._tag,
            "AttemptTimedOut"
          )
          if (terminal.exit.value._tag === "AttemptTimedOut") {
            const timeout = terminal.exit.value.timeout
            assert.strictEqual(timeout.outcomeVersion, 2)
            assert.strictEqual(
              timeout.timeout.timeoutKind,
              "StartToClose"
            )
            assert.strictEqual(timeout.attempt, 1)
            assert.strictEqual(
              timeout.activityDigest,
              invocation.firstActivityDigest
            )
            assert.strictEqual(
              timeout.timerOperationDigest,
              invocation.firstStartToCloseTimerDigest
            )
            assert.strictEqual(timeout.durationMillis, 100)
            assert.strictEqual(
              timeout.deadline,
              "2026-01-02T03:04:05.106Z"
            )
          }
        }
        assert.strictEqual(scheduleAcknowledgements, 1)
        assert.strictEqual(handlerRuns, 0)
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(classified[0]?._tag, "AttemptTimeout")
        if (classified[0]?._tag === "AttemptTimeout") {
          assert.strictEqual(
            classified[0].timeoutKind,
            "StartToClose"
          )
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(delayedEngine)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("uses the absolute start-to-close deadline when timer delivery is late", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const releaseHandler = yield* Deferred.make<void>()
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let handlerRuns = 0
      let scheduleAcknowledgements = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            handlerRuns++
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(releaseHandler)
            return { value: 79 }
          })) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "start-to-close-late-timer-delivery"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))
      const delayedTimerEngine = withoutAttemptTimerDelivery(
        "StartToClose",
        () => {
          scheduleAcknowledgements++
        }
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* DetailedWorkflow.execute(
          { id: "start-to-close-late-timer-delivery" },
          { discard: true }
        )
        yield* Deferred.await(started)
        assert.strictEqual(scheduleAcknowledgements, 1)

        // No timer resolution is delivered. The handler's durable completion
        // timestamp alone must lose once it is beyond the absolute deadline.
        yield* TestClock.adjust(101)
        yield* Deferred.succeed(releaseHandler, undefined)
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(
            terminal.exit.value._tag,
            "AttemptTimedOut"
          )
          if (terminal.exit.value._tag === "AttemptTimedOut") {
            assert.strictEqual(
              terminal.exit.value.timeout.timeout.timeoutKind,
              "StartToClose"
            )
            assert.strictEqual(
              terminal.exit.value.timeout.attempt,
              1
            )
            assert.strictEqual(
              terminal.exit.value.timeout.activityDigest,
              invocation.firstActivityDigest
            )
          }
        }
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(classified[0]?._tag, "AttemptTimeout")
        if (classified[0]?._tag === "AttemptTimeout") {
          assert.strictEqual(
            classified[0].timeoutKind,
            "StartToClose"
          )
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(delayedTimerEngine)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps a completion before the start-to-close deadline when timer delivery is late", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const releaseHandler = yield* Deferred.make<void>()
      let scheduleAcknowledgements = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(releaseHandler)
            return { value: 83 }
          })) as Node.Handler<typeof retryNode>,
        maximumAttempts: 1,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "start-to-close-early-result-late-timer"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))
      const delayedTimerEngine = withoutAttemptTimerDelivery(
        "StartToClose",
        () => {
          scheduleAcknowledgements++
        }
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* DetailedWorkflow.execute(
          { id: "start-to-close-early-result-late-timer" },
          { discard: true }
        )
        yield* Deferred.await(started)
        assert.strictEqual(scheduleAcknowledgements, 1)

        yield* TestClock.adjust(99)
        yield* Deferred.succeed(releaseHandler, undefined)
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.strictEqual(terminal.exit.value._tag, "Succeeded")
          if (terminal.exit.value._tag === "Succeeded") {
            assert.deepStrictEqual(terminal.exit.value.output, {
              _tag: "Inline",
              value: { value: 83 }
            })
          }
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(delayedTimerEngine)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("rejects a completion timestamp before its canonical start after clock regression", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const releaseHandler = yield* Deferred.make<void>()
      let handlerRuns = 0
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            handlerRuns++
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(releaseHandler)
            return { value: 89 }
          })) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "start-to-close-clock-regression"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))

      yield* Effect.gen(function*() {
        const startedAt = Date.parse(
          "2026-01-02T03:04:05.006Z"
        )
        yield* TestClock.setTime(startedAt)
        const executionId = yield* DetailedWorkflow.execute(
          { id: "start-to-close-clock-regression" },
          { discard: true }
        )
        yield* Deferred.await(started)

        // Simulate a wall-clock rollback after Started was durably recorded.
        // Such a completion cannot be ordered against the absolute deadline.
        yield* TestClock.setTime(startedAt - 1)
        yield* Deferred.succeed(releaseHandler, undefined)
        const terminal = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          assert.isFalse(
            terminal.exit.cause.reasons.some(
              (reason) => reason._tag === "Fail"
            )
          )
          const died = terminal.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          assert.isDefined(died)
          if (died?._tag === "Die") {
            assert.instanceOf(died.defect, Error)
            assert.strictEqual(
              (died.defect as Error).name,
              "@effect/workflow-builder/EffectWorkflowRetryV3/Error"
            )
            assert.include(
              (died.defect as Error).message,
              "completion precedes its canonical start"
            )
          }
        }
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classifierRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("isolates a retry from a late start-to-close loser and preserves attempt two", () =>
    Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      const attempts: Array<number> = []
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let lateFirstCompleted = false
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) => {
          const attempt = request.context.attempt
          attempts.push(attempt)
          if (attempt === 1) {
            return Effect.uninterruptible(
              Effect.gen(function*() {
                yield* Deferred.succeed(
                  firstStarted,
                  undefined
                )
                yield* Deferred.await(releaseFirst)
                lateFirstCompleted = true
                return { value: 101 }
              })
            )
          }
          return Effect.gen(function*() {
            yield* Deferred.succeed(secondStarted, undefined)
            yield* Deferred.await(releaseSecond)
            return { value: 202 }
          })
        }) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 2,
        startToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "start-to-close-retry-isolation"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DetailedWorkflow.toLayer(() => detailedRetryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const payload = {
          id: "start-to-close-retry-isolation"
        }
        const executionId = yield* DetailedWorkflow.execute(
          payload,
          { discard: true }
        )
        yield* Deferred.await(firstStarted)
        yield* TestClock.adjust(100)
        yield* Deferred.await(secondStarted)
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(classified[0]?._tag, "AttemptTimeout")
        if (classified[0]?._tag === "AttemptTimeout") {
          assert.strictEqual(
            classified[0].timeoutKind,
            "StartToClose"
          )
          assert.strictEqual(classified[0].attempt, 1)
        }

        yield* Deferred.succeed(releaseSecond, undefined)
        const completed = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert(Exit.isSuccess(completed.exit))
        if (Exit.isSuccess(completed.exit)) {
          assert.strictEqual(completed.exit.value._tag, "Succeeded")
          if (completed.exit.value._tag === "Succeeded") {
            assert.strictEqual(completed.exit.value.attempt, 2)
            assert.notStrictEqual(
              completed.exit.value.activityDigest,
              invocation.firstActivityDigest
            )
            assert.deepStrictEqual(completed.exit.value.output, {
              _tag: "Inline",
              value: { value: 202 }
            })
          }
        }

        yield* Deferred.succeed(releaseFirst, undefined)
        for (
          let observation = 0;
          observation < 1_000 && !lateFirstCompleted;
          observation++
        ) {
          yield* Effect.yieldNow
        }
        assert.isTrue(lateFirstCompleted)

        // A late attempt-one handler completion cannot replace the recorded
        // attempt-two workflow result or cause either attempt to rerun.
        yield* DetailedWorkflow.execute(payload, { discard: true })
        const replayed = yield* pollUntilComplete(
          DetailedWorkflow,
          executionId
        )
        assert.deepStrictEqual(replayed, completed)
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual(classified.length, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))
})
