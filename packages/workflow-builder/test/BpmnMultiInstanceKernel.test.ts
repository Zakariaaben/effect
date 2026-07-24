import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnData from "../src/BpmnData.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import type * as BpmnExpressionEvaluator from "../src/BpmnExpressionEvaluator.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "process-multi-instance"
const taskNodeId = "task-multi-instance"
const now = "2026-07-24T10:00:00.000Z" as const

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const cardinalityExpression = expression("item-count")
const completionExpression = expression("completed-count >= 2")
const collectionExpression = expression("execution.items")
const alternateCollectionExpression = expression("execution.alternateItems")
const collectionInputRef = "items"
const collectionOutputRef = "results"

const limits: BpmnKernel.KernelLimits = {
  maxAutomaticTransitions: 1_000,
  maxExecutionInputCanonicalBytes: 1_048_576,
  maxMultiInstanceCardinality: 16,
  maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
  maxMultiInstanceItemCanonicalBytes: 262_144,
  maxMultiInstanceOutputCanonicalBytes: 1_048_576,
  maxMultiInstanceItemOutputCanonicalBytes: 262_144
}

const initializeCommand = (
  input: Schema.Json = null
): BpmnKernel.InitializeCommand => ({
  commandVersion: BpmnKernel.InitializeCommandVersion,
  input
})

const initializeKernel = (
  kernel: BpmnKernel.CompiledKernel,
  runtime: BpmnKernel.Services,
  input: Schema.Json = null
): ReturnType<typeof BpmnKernel.initialize> => BpmnKernel.initialize(kernel, initializeCommand(input), runtime)

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"1".repeat(64)}`)

const evaluatorBinding: BpmnExpression.EvaluatorBinding = {
  language: "feel",
  languageVersion: "1.0",
  build: {
    id: "multi-instance-test-evaluator",
    version: "1.0.0",
    deploymentId: "multi-instance-test-deployment",
    buildDigest: evaluatorBuildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 10_000,
    timeoutMillis: 1_000
  }
}

const semanticNodeId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("semantic-multi-instance")

const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"a".repeat(64)}`)

const occurrenceDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OccurrenceDigest
)(`sha256:${"b".repeat(64)}`)

const firstActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"c".repeat(64)}`)

const failedActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"d".repeat(64)}`)

const completedActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"6".repeat(64)}`)

const classificationActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"e".repeat(64)}`)

const taskBinding = (
  errorMappings: ReadonlyArray<{
    readonly errorTag: string
    readonly errorCode: string | null
    readonly errorRef: string
  }> = []
): BpmnActivityV3.TaskBinding =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBinding)({
    bindingVersion: BpmnActivityV3.BindingVersion,
    executionProtocolVersion: 3,
    taskNodeId,
    artifactDigest,
    semanticNodeId,
    errorMappings: errorMappings.map((mapping) => ({
      identity: {
        failureIdentityVersion: 1,
        errorTag: mapping.errorTag,
        errorCode: mapping.errorCode
      },
      errorRef: mapping.errorRef
    }))
  })

const failedOutcome = (
  errorTag: string,
  errorCode: string | null
): BpmnActivityV3.TaskBusinessFailed =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBusinessFailed)({
    _tag: "BusinessFailed",
    outcomeVersion: BpmnActivityV3.OutcomeVersion,
    artifactDigest,
    semanticNodeId,
    occurrenceDigest,
    firstActivityDigest,
    terminal: {
      _tag: "NonRetryable",
      terminalVersion: 1,
      decision: {
        _tag: "Classifier",
        decisionVersion: 1,
        classificationActivityDigest
      }
    },
    failedActivityDigest,
    attempt: 1,
    identity: {
      failureIdentityVersion: 1,
      errorTag,
      errorCode
    }
  })

const succeededOutcome = (
  output: Schema.Json
): BpmnActivityV3.TaskSucceeded =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskSucceeded)({
    _tag: "Succeeded",
    outcomeVersion: BpmnActivityV3.OutcomeVersion,
    artifactDigest,
    semanticNodeId,
    occurrenceDigest,
    firstActivityDigest,
    attempt: 1,
    completedActivityDigest,
    output: {
      _tag: "Inline",
      value: output
    }
  })

interface MultiInstanceFixtureOptions {
  readonly mode: "sequential" | "parallel"
  readonly cardinality?: BpmnModel.Expression
  readonly completionCondition?: BpmnModel.Expression
  readonly behavior?: "all" | "one" | "none" | "complex"
  readonly loopDataInputRef?: string
  readonly loopDataOutputRef?: string
  readonly inputDataItem?: boolean
  readonly outputDataItem?: boolean
  readonly oneBehaviorEventRef?: string
  readonly noneBehaviorEventRef?: string
}

const multiInstanceModel = (
  options: MultiInstanceFixtureOptions
): BpmnModel.BpmnModel => {
  const start: BpmnModel.StartEvent = {
    _tag: "StartEvent",
    id: "start",
    processId,
    parentScopeId: processId,
    incomingSequenceFlowIds: [],
    outgoingSequenceFlowIds: ["flow-start-task"],
    eventDefinitions: [],
    eventDefinitionRefs: [],
    extensionElements: []
  }
  const task: BpmnModel.Task = {
    _tag: "Task",
    id: taskNodeId,
    processId,
    parentScopeId: processId,
    taskKind: "generic",
    incomingSequenceFlowIds: ["flow-start-task"],
    outgoingSequenceFlowIds: ["flow-task-end"],
    loopCharacteristics: {
      _tag: "MultiInstanceCharacteristics",
      mode: options.mode,
      ...(options.cardinality === undefined
        ? {}
        : { cardinality: options.cardinality }),
      ...(options.completionCondition === undefined
        ? {}
        : { completionCondition: options.completionCondition }),
      ...(options.behavior === undefined
        ? {}
        : { behavior: options.behavior }),
      ...(options.loopDataInputRef === undefined
        ? {}
        : { loopDataInputRef: options.loopDataInputRef }),
      ...(options.loopDataOutputRef === undefined
        ? {}
        : { loopDataOutputRef: options.loopDataOutputRef }),
      ...(options.inputDataItem === true
        ? {
          inputDataItem: {
            id: "current-item",
            isCollection: false,
            extensionElements: []
          }
        }
        : {}),
      ...(options.outputDataItem === true
        ? {
          outputDataItem: {
            id: "current-result",
            isCollection: false,
            extensionElements: []
          }
        }
        : {}),
      ...(options.oneBehaviorEventRef === undefined
        ? {}
        : { oneBehaviorEventRef: options.oneBehaviorEventRef }),
      ...(options.noneBehaviorEventRef === undefined
        ? {}
        : { noneBehaviorEventRef: options.noneBehaviorEventRef })
    },
    extensionElements: []
  }
  const end: BpmnModel.EndEvent = {
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
  return {
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
    flowNodes: [start, task, end],
    sequenceFlows: [
      {
        id: "flow-start-task",
        processId,
        parentScopeId: processId,
        sourceId: start.id,
        targetId: task.id,
        kind: "normal",
        extensionElements: []
      },
      {
        id: "flow-task-end",
        processId,
        parentScopeId: processId,
        sourceId: task.id,
        targetId: end.id,
        kind: "normal",
        extensionElements: []
      }
    ]
  }
}

const collectionModel = (
  mode: "sequential" | "parallel",
  options: {
    readonly output?: boolean
    readonly declareInputDataItem?: boolean
  } = {}
): BpmnModel.BpmnModel =>
  multiInstanceModel({
    mode,
    loopDataInputRef: collectionInputRef,
    ...(options.output === true
      ? {
        loopDataOutputRef: collectionOutputRef,
        outputDataItem: true
      }
      : {}),
    ...(options.declareInputDataItem === false
      ? {}
      : { inputDataItem: true })
  })

const collectionDataDocument = (
  withOutput = false
): BpmnData.BpmnDataDocument => ({
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
    id: "multi-instance-io",
    ownerId: taskNodeId,
    dataInputs: [{
      id: collectionInputRef,
      isCollection: true,
      extensionElements: []
    }],
    dataOutputs: withOutput
      ? [{
        id: collectionOutputRef,
        isCollection: true,
        extensionElements: []
      }]
      : [],
    inputSets: [{
      id: "multi-instance-input-set",
      dataInputRefs: [collectionInputRef],
      optionalInputRefs: [],
      whileExecutingInputRefs: [],
      outputSetRefs: [],
      extensionElements: []
    }],
    outputSets: [{
      id: "multi-instance-output-set",
      dataOutputRefs: withOutput ? [collectionOutputRef] : [],
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

const collectionBinding = (
  selectedExpression: BpmnModel.Expression = collectionExpression
): BpmnKernel.MultiInstanceCollectionBinding => ({
  bindingVersion: BpmnKernel.MultiInstanceCollectionBindingVersion,
  taskNodeId,
  dataInputRef: collectionInputRef,
  collectionExpression: selectedExpression
})

const boundaryErrorModel = (
  options: MultiInstanceFixtureOptions,
  errorRef: string
): BpmnModel.BpmnModel => {
  const definition = multiInstanceModel(options)
  return {
    ...definition,
    errors: [{
      id: errorRef,
      errorCode: "MULTI_INSTANCE_REJECTED"
    }],
    flowNodes: [
      ...definition.flowNodes,
      {
        _tag: "BoundaryEvent",
        id: "boundary-error",
        processId,
        parentScopeId: processId,
        incomingSequenceFlowIds: [],
        outgoingSequenceFlowIds: ["flow-boundary-end"],
        eventDefinitions: [{
          _tag: "ErrorEventDefinition",
          errorRef
        }],
        eventDefinitionRefs: [],
        attachedToRef: taskNodeId,
        cancelActivity: true,
        extensionElements: []
      },
      {
        _tag: "EndEvent",
        id: "boundary-end",
        processId,
        parentScopeId: processId,
        incomingSequenceFlowIds: ["flow-boundary-end"],
        outgoingSequenceFlowIds: [],
        eventDefinitions: [],
        eventDefinitionRefs: [],
        extensionElements: []
      }
    ],
    sequenceFlows: [
      ...definition.sequenceFlows,
      {
        id: "flow-boundary-end",
        processId,
        parentScopeId: processId,
        sourceId: "boundary-error",
        targetId: "boundary-end",
        kind: "normal",
        extensionElements: []
      }
    ]
  }
}

const prepareResult = (
  model: BpmnModel.BpmnModel,
  selectedLimits: BpmnKernel.KernelLimits = limits,
  taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding> = [],
  options: {
    readonly dataDocument?: BpmnData.BpmnDataDocument
    readonly collectionBindings?: ReadonlyArray<
      BpmnKernel.MultiInstanceCollectionBinding
    >
  } = {}
): Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnKernel.prepare(model, {
      profileId: "multi-instance-kernel-tests",
      rootProcessId: processId,
      limits: selectedLimits,
      evaluatorBindings: [evaluatorBinding],
      ...(taskBindings.length === 0 ? {} : { taskBindings }),
      ...(options.dataDocument === undefined
        ? {}
        : { dataDocument: options.dataDocument }),
      ...(options.collectionBindings === undefined
        ? {}
        : { collectionBindings: options.collectionBindings })
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError>

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const compile = (
  model: BpmnModel.BpmnModel,
  selectedLimits: BpmnKernel.KernelLimits = limits,
  taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding> = [],
  options: {
    readonly dataDocument?: BpmnData.BpmnDataDocument
    readonly collectionBindings?: ReadonlyArray<
      BpmnKernel.MultiInstanceCollectionBinding
    >
  } = {}
): BpmnKernel.CompiledKernel =>
  success(
    prepareResult(model, selectedLimits, taskBindings, options)
  )

const compileCollection = (
  mode: "sequential" | "parallel",
  options: {
    readonly limits?: BpmnKernel.KernelLimits
    readonly output?: boolean
    readonly expression?: BpmnModel.Expression
  } = {}
): BpmnKernel.CompiledKernel =>
  compile(
    collectionModel(mode, { output: options.output }),
    options.limits ?? limits,
    options.output === true ? [taskBinding()] : [],
    {
      dataDocument: collectionDataDocument(options.output),
      collectionBindings: [
        collectionBinding(options.expression)
      ]
    }
  )

interface EvaluationObservation {
  readonly tag: BpmnKernel.EvaluationContext["_tag"]
  readonly expectedResult: BpmnExpressionEvaluator.ExpectedResult
  readonly itemIndex?: number
  readonly numberOfInstances?: number
  readonly numberOfActiveInstances?: number
  readonly numberOfCompletedInstances?: number
  readonly numberOfTerminatedInstances?: number
}

const services = (
  cardinality: unknown,
  completion: (
    context: BpmnKernel.MultiInstanceCompletionEvaluationContext
  ) => unknown = () => false,
  observations: Array<EvaluationObservation> = []
): BpmnKernel.Services => ({
  now,
  evaluateExpression: (context) => {
    observations.push({
      tag: context._tag,
      expectedResult: context.request.expectedResult,
      ...(context._tag === "MultiInstanceCompletionCondition"
        ? {
          itemIndex: context.completedMember.index,
          numberOfInstances: context.runtime.numberOfInstances,
          numberOfActiveInstances: context.runtime.numberOfActiveInstances,
          numberOfCompletedInstances: context.runtime.numberOfCompletedInstances,
          numberOfTerminatedInstances: context.runtime.numberOfTerminatedInstances
        }
        : {})
    })
    return Result.succeed({
      result: (
        context._tag === "MultiInstanceCardinality"
          ? cardinality
          : context._tag === "MultiInstanceCompletionCondition"
          ? completion(context)
          : false
      ) as Schema.Json,
      steps: 1
    })
  }
})

const collectionServices = (
  evaluate: (
    context: BpmnKernel.MultiInstanceCollectionEvaluationContext
  ) => unknown,
  observations: Array<EvaluationObservation> = []
): BpmnKernel.Services => ({
  now,
  evaluateExpression: (context) => {
    observations.push({
      tag: context._tag,
      expectedResult: context.request.expectedResult
    })
    return Result.succeed({
      result: (
        context._tag === "MultiInstanceCollection"
          ? evaluate(context)
          : false
      ) as Schema.Json,
      steps: 1
    })
  }
})

const activeTaskTokens = (
  state: BpmnKernel.TransitionBatch["state"]
): ReadonlyArray<BpmnKernel.TransitionBatch["state"]["tokens"][number]> =>
  state.tokens
    .filter((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === taskNodeId
    )
    .sort((left, right) => {
      const leftIndex = left.invocation.branch?._tag === "MultiInstanceItem"
        ? left.invocation.branch.itemIndex
        : -1
      const rightIndex = right.invocation.branch?._tag ===
          "MultiInstanceItem"
        ? right.invocation.branch.itemIndex
        : -1
      return leftIndex - rightIndex
    })

const target = (
  token: BpmnKernel.TransitionBatch["state"]["tokens"][number]
): BpmnKernel.CompleteTaskCommand => ({
  scopeInstanceId: token.scopeInstanceId,
  taskNodeId,
  tokenId: token.tokenId
})

const assertReplay = (
  kernel: BpmnKernel.CompiledKernel,
  events: ReadonlyArray<BpmnKernel.TransitionEvent>,
  expected: BpmnKernel.TransitionBatch["state"]
): void => {
  const replayed = success(BpmnKernel.replay(kernel, events))
  assert.deepStrictEqual(replayed, expected)
}

const assertReplayFailure = (
  kernel: BpmnKernel.CompiledKernel,
  events: unknown,
  expectedCode: BpmnKernel.Code = BpmnKernel.Codes.InvalidTransitionJournal
): void => {
  const replayed = BpmnKernel.replay(kernel, events)
  assert.isTrue(Result.isFailure(replayed))
  if (Result.isSuccess(replayed)) {
    throw new Error("expected transition-journal rejection")
  }
  assert(
    replayed.failure.diagnostics.some((diagnostic) => diagnostic.code === expectedCode)
  )
}

describe("BpmnKernel fixed multi-instance execution", () => {
  it("freezes one cardinality and executes three sequential members with exact replay boundaries", () => {
    const kernel = compile(multiInstanceModel({
      mode: "sequential",
      cardinality: cardinalityExpression
    }))
    const observations: Array<EvaluationObservation> = []
    const runtime = services(3, () => false, observations)
    const initialized = success(initializeKernel(kernel, runtime))
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]

    assert.deepStrictEqual(observations, [{
      tag: "MultiInstanceCardinality",
      expectedResult: "non-negative-integer"
    }])
    assert.strictEqual(activeTaskTokens(initialized.state).length, 1)
    assert.strictEqual(
      activeTaskTokens(initialized.state)[0]?.invocation.branch?._tag ===
          "MultiInstanceItem"
        ? activeTaskTokens(initialized.state)[0]!.invocation.branch.itemKey
        : undefined,
      "item:0"
    )
    assert.deepStrictEqual(
      initialized.state.multiInstanceGroups[0]?.members.map((member) => ({
        index: member.index,
        itemKey: member.itemKey,
        status: member.status
      })),
      [
        { index: 0, itemKey: "item:0", status: "active" },
        { index: 1, itemKey: "item:1", status: "pending" },
        { index: 2, itemKey: "item:2", status: "pending" }
      ]
    )
    assertReplay(kernel, journal, initialized.state)

    let state = initialized.state
    for (let index = 0; index < 3; index++) {
      const waiting = activeTaskTokens(state)
      assert.strictEqual(waiting.length, 1)
      const branch = waiting[0]?.invocation.branch
      assert.strictEqual(
        branch?._tag === "MultiInstanceItem"
          ? branch.itemIndex
          : undefined,
        index
      )
      const completed = success(
        BpmnKernel.completeTask(kernel, state, target(waiting[0]!), runtime)
      )
      journal.push(...completed.events)
      state = completed.state
      assertReplay(kernel, journal, state)
      if (index < 2) {
        const nextBranch = activeTaskTokens(state)[0]?.invocation.branch
        assert.deepStrictEqual(
          nextBranch?._tag === "MultiInstanceItem"
            ? {
              index: nextBranch.itemIndex,
              itemKey: nextBranch.itemKey
            }
            : undefined,
          {
            index: index + 1,
            itemKey: `item:${index + 1}`
          }
        )
      }
    }

    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups.map((group) => ({
        activation: group.activation,
        source: group.source,
        completedInstanceCount: group.completedInstanceCount,
        memberStatuses: group.members.map((member) => member.status),
        status: group.status,
        completionReason: group.completionReason
      })),
      [{
        activation: 0,
        source: { _tag: "Cardinality", value: 3 },
        completedInstanceCount: 3,
        memberStatuses: ["completed", "completed", "completed"],
        status: "completed",
        completionReason: "all-completed"
      }]
    )
    assert.strictEqual(
      journal.filter((event) => event._tag === "MultiInstanceCardinalityEvaluated").length,
      1
    )
    assert.strictEqual(
      journal.filter((event) =>
        event._tag === "OutgoingSelected" &&
        event.sourceNodeId === taskNodeId
      ).length,
      1
    )
  })

  it("keeps sequential BPMN runtime counters equal to generated active, completed, and terminated instances", () => {
    const kernel = compile(multiInstanceModel({
      mode: "sequential",
      cardinality: cardinalityExpression,
      completionCondition: completionExpression
    }))
    const observations: Array<EvaluationObservation> = []
    const runtime = services(3, () => false, observations)
    const initialized = success(initializeKernel(kernel, runtime))
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    let state = initialized.state

    for (let index = 0; index < 3; index++) {
      const waiting = activeTaskTokens(state)
      assert.strictEqual(waiting.length, 1)
      const completed = success(
        BpmnKernel.completeTask(kernel, state, target(waiting[0]!), runtime)
      )
      journal.push(...completed.events)
      state = completed.state
      assertReplay(kernel, journal, state)
    }

    assert.deepStrictEqual(
      observations,
      [
        {
          tag: "MultiInstanceCardinality",
          expectedResult: "non-negative-integer"
        },
        ...[1, 2, 3].map((numberOfCompletedInstances, itemIndex) => ({
          tag: "MultiInstanceCompletionCondition" as const,
          expectedResult: "boolean" as const,
          itemIndex,
          numberOfInstances: numberOfCompletedInstances,
          numberOfActiveInstances: 0,
          numberOfCompletedInstances,
          numberOfTerminatedInstances: 0
        }))
      ]
    )
    for (
      const counters of journal.flatMap((event) =>
        event._tag === "MultiInstanceCompletionConditionEvaluated"
          ? [event.counters]
          : []
      )
    ) {
      assert.strictEqual(
        counters.numberOfInstances,
        counters.numberOfActiveInstances +
          counters.numberOfCompletedInstances +
          counters.numberOfTerminatedInstances
      )
    }
  })

  it("keeps an early-completed sequential prefix and marks its never-generated suffix without inflating terminated counters", () => {
    const kernel = compile(multiInstanceModel({
      mode: "sequential",
      cardinality: cardinalityExpression,
      completionCondition: completionExpression
    }))
    const observations: Array<EvaluationObservation> = []
    const runtime = services(
      4,
      (context) => context.runtime.numberOfCompletedInstances >= 2,
      observations
    )
    const initialized = success(initializeKernel(kernel, runtime))
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    const generatedTokenIds: Array<string> = []
    let state = initialized.state

    for (let itemIndex = 0; itemIndex < 2; itemIndex++) {
      const waiting = activeTaskTokens(state)
      assert.strictEqual(waiting.length, 1)
      generatedTokenIds.push(waiting[0]!.tokenId)
      assert.strictEqual(
        waiting[0]?.invocation.branch?._tag === "MultiInstanceItem"
          ? waiting[0].invocation.branch.itemIndex
          : undefined,
        itemIndex
      )
      const completed = success(BpmnKernel.completeTask(
        kernel,
        state,
        target(waiting[0]!),
        runtime
      ))
      journal.push(...completed.events)
      state = completed.state
      assertReplay(kernel, journal, state)
    }

    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.members.map((member) => ({
        index: member.index,
        status: member.status,
        tokenId: member.tokenId,
        startedAt: member.startedAt,
        endedAt: member.endedAt,
        terminationReason: member.terminationReason,
        nonGenerationReason: member.nonGenerationReason
      })),
      [
        {
          index: 0,
          status: "completed",
          tokenId: generatedTokenIds[0],
          startedAt: now,
          endedAt: now,
          terminationReason: undefined,
          nonGenerationReason: undefined
        },
        {
          index: 1,
          status: "completed",
          tokenId: generatedTokenIds[1],
          startedAt: now,
          endedAt: now,
          terminationReason: undefined,
          nonGenerationReason: undefined
        },
        {
          index: 2,
          status: "not-generated",
          tokenId: undefined,
          startedAt: undefined,
          endedAt: undefined,
          terminationReason: undefined,
          nonGenerationReason: "completion-condition"
        },
        {
          index: 3,
          status: "not-generated",
          tokenId: undefined,
          startedAt: undefined,
          endedAt: undefined,
          terminationReason: undefined,
          nonGenerationReason: "completion-condition"
        }
      ]
    )
    assert.deepStrictEqual(
      observations,
      [
        {
          tag: "MultiInstanceCardinality",
          expectedResult: "non-negative-integer"
        },
        {
          tag: "MultiInstanceCompletionCondition",
          expectedResult: "boolean",
          itemIndex: 0,
          numberOfInstances: 1,
          numberOfActiveInstances: 0,
          numberOfCompletedInstances: 1,
          numberOfTerminatedInstances: 0
        },
        {
          tag: "MultiInstanceCompletionCondition",
          expectedResult: "boolean",
          itemIndex: 1,
          numberOfInstances: 2,
          numberOfActiveInstances: 0,
          numberOfCompletedInstances: 2,
          numberOfTerminatedInstances: 0
        }
      ]
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceItemNotGenerated"
          ? [{
            itemIndex: event.itemIndex,
            itemKey: event.itemKey,
            reason: event.reason
          }]
          : []
      ),
      [
        {
          itemIndex: 2,
          itemKey: "item:2",
          reason: "completion-condition"
        },
        {
          itemIndex: 3,
          itemKey: "item:3",
          reason: "completion-condition"
        }
      ]
    )
    assert.strictEqual(
      journal.filter((event) => event._tag === "MultiInstanceItemTerminated").length,
      0
    )
    for (
      const counters of journal.flatMap((event) =>
        event._tag === "MultiInstanceItemCompleted" ||
          event._tag === "MultiInstanceCompletionConditionEvaluated" ||
          event._tag === "MultiInstanceGroupCompleted"
          ? [event.counters]
          : []
      )
    ) {
      assert.strictEqual(counters.numberOfTerminatedInstances, 0)
      assert.strictEqual(
        counters.numberOfInstances,
        counters.numberOfActiveInstances +
          counters.numberOfCompletedInstances +
          counters.numberOfTerminatedInstances
      )
    }
    assertReplay(kernel, journal, state)

    const forgedIdentity = structuredClone(journal)
    const notGeneratedIndex = forgedIdentity.findIndex((event) => event._tag === "MultiInstanceItemNotGenerated")
    const notGenerated = forgedIdentity[notGeneratedIndex]
    if (notGenerated?._tag !== "MultiInstanceItemNotGenerated") {
      throw new Error("expected non-generation event")
    }
    forgedIdentity[notGeneratedIndex] = {
      _tag: "MultiInstanceItemTerminated",
      groupId: notGenerated.groupId,
      activityId: notGenerated.activityId,
      activation: notGenerated.activation,
      itemIndex: notGenerated.itemIndex,
      itemKey: notGenerated.itemKey,
      reason: notGenerated.reason,
      terminatedAt: notGenerated.notGeneratedAt
    }
    assertReplayFailure(kernel, forgedIdentity)

    const forgedOrder = structuredClone(journal)
    const forgedNotGenerated = forgedOrder.find((event) => event._tag === "MultiInstanceItemNotGenerated")
    if (forgedNotGenerated?._tag !== "MultiInstanceItemNotGenerated") {
      throw new Error("expected non-generation event")
    }
    forgedNotGenerated.itemIndex++
    assertReplayFailure(kernel, forgedOrder)
  })

  it("accepts out-of-order parallel completion while preserving ordered member state and one outgoing route", () => {
    const kernel = compile(multiInstanceModel({
      mode: "parallel",
      cardinality: cardinalityExpression
    }))
    const runtime = services(3)
    const initialized = success(initializeKernel(kernel, runtime))
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    let state = initialized.state

    assert.deepStrictEqual(
      activeTaskTokens(state).map((token) =>
        token.invocation.branch?._tag === "MultiInstanceItem"
          ? token.invocation.branch.itemIndex
          : undefined
      ),
      [0, 1, 2]
    )
    assertReplay(kernel, journal, state)

    for (const index of [2, 0, 1]) {
      const token = activeTaskTokens(state).find((candidate) =>
        candidate.invocation.branch?._tag === "MultiInstanceItem" &&
        candidate.invocation.branch.itemIndex === index
      )
      if (token === undefined) {
        throw new Error(`expected active parallel member ${index}`)
      }
      const completed = success(
        BpmnKernel.completeTask(kernel, state, target(token), runtime)
      )
      journal.push(...completed.events)
      state = completed.state
      assertReplay(kernel, journal, state)
    }

    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.members.map((member) => ({
        index: member.index,
        itemKey: member.itemKey,
        status: member.status
      })),
      [
        { index: 0, itemKey: "item:0", status: "completed" },
        { index: 1, itemKey: "item:1", status: "completed" },
        { index: 2, itemKey: "item:2", status: "completed" }
      ]
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceItemCompleted"
          ? [event.itemIndex]
          : []
      ),
      [2, 0, 1]
    )
    assert.strictEqual(
      journal.filter((event) =>
        event._tag === "OutgoingSelected" &&
        event.sourceNodeId === taskNodeId
      ).length,
      1
    )
  })

  it("derives distinct bound task occurrences from the group activation and member index", () => {
    const kernel = compile(
      multiInstanceModel({
        mode: "parallel",
        cardinality: cardinalityExpression
      }),
      limits,
      [taskBinding()]
    )
    const initialized = success(
      initializeKernel(kernel, services(3))
    )
    const coordinates = activeTaskTokens(initialized.state).map((token) =>
      success(BpmnKernel.taskOccurrence(
        kernel,
        initialized.state,
        target(token)
      ))
    )

    assert.deepStrictEqual(
      coordinates,
      [0, 1, 2].map((activation) => ({
        nodeId: semanticNodeId,
        scopePath: [{
          scopeActivationVersion: 1,
          scopeId: semanticNodeId,
          activation: 0
        }],
        activation
      }))
    )
  })

  it("evaluates completion after each commit, terminates remaining members on the first true result, and idempotently rejects late work", () => {
    const kernel = compile(multiInstanceModel({
      mode: "parallel",
      cardinality: cardinalityExpression,
      completionCondition: completionExpression
    }))
    const observations: Array<EvaluationObservation> = []
    const runtime = services(
      4,
      (context) => context.runtime.numberOfCompletedInstances >= 2,
      observations
    )
    const initialized = success(initializeKernel(kernel, runtime))
    const originalTokens = activeTaskTokens(initialized.state)
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    let state = initialized.state

    for (const index of [0, 1]) {
      const token = originalTokens[index]!
      const completed = success(
        BpmnKernel.completeTask(kernel, state, target(token), runtime)
      )
      journal.push(...completed.events)
      state = completed.state
      assertReplay(kernel, journal, state)
    }

    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      observations,
      [
        {
          tag: "MultiInstanceCardinality",
          expectedResult: "non-negative-integer"
        },
        {
          tag: "MultiInstanceCompletionCondition",
          expectedResult: "boolean",
          itemIndex: 0,
          numberOfInstances: 4,
          numberOfActiveInstances: 3,
          numberOfCompletedInstances: 1,
          numberOfTerminatedInstances: 0
        },
        {
          tag: "MultiInstanceCompletionCondition",
          expectedResult: "boolean",
          itemIndex: 1,
          numberOfInstances: 4,
          numberOfActiveInstances: 2,
          numberOfCompletedInstances: 2,
          numberOfTerminatedInstances: 0
        }
      ]
    )
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.members.map((member) => ({
        index: member.index,
        status: member.status,
        terminationReason: member.terminationReason
      })),
      [
        { index: 0, status: "completed", terminationReason: undefined },
        { index: 1, status: "completed", terminationReason: undefined },
        {
          index: 2,
          status: "terminated",
          terminationReason: "completion-condition"
        },
        {
          index: 3,
          status: "terminated",
          terminationReason: "completion-condition"
        }
      ]
    )
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.completionReason,
      "completion-condition"
    )
    assert.strictEqual(
      state.tokens.filter((token) =>
        token.status === "withdrawn" &&
        token.invocation.branch?._tag === "MultiInstanceItem"
      ).length,
      2
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceCompletionConditionEvaluated"
          ? [event.result]
          : []
      ),
      [false, true]
    )
    assert.strictEqual(
      journal.filter((event) =>
        event._tag === "OutgoingSelected" &&
        event.sourceNodeId === taskNodeId
      ).length,
      1
    )

    const observationCount = observations.length
    for (const token of [originalTokens[0]!, originalTokens[2]!]) {
      const late = success(
        BpmnKernel.completeTask(kernel, state, target(token), runtime)
      )
      assert.deepStrictEqual(late.state, state)
      assert.deepStrictEqual(
        late.events.map((event) => event._tag),
        ["TaskCompletionReplayed"]
      )
      journal.push(...late.events)
      assertReplay(kernel, journal, state)
    }
    assert.strictEqual(observations.length, observationCount)
  })

  it("completes cardinality zero immediately and rejects an over-limit cardinality atomically", () => {
    const emptyKernel = compile(multiInstanceModel({
      mode: "parallel",
      cardinality: cardinalityExpression
    }))
    const empty = success(
      initializeKernel(emptyKernel, services(0))
    )
    assert.strictEqual(empty.state.status, "completed")
    assert.deepStrictEqual(
      empty.state.multiInstanceGroups.map((group) => ({
        source: group.source,
        members: group.members,
        completedInstanceCount: group.completedInstanceCount,
        status: group.status,
        completionReason: group.completionReason
      })),
      [{
        source: { _tag: "Cardinality", value: 0 },
        members: [],
        completedInstanceCount: 0,
        status: "completed",
        completionReason: "empty"
      }]
    )
    assert.deepStrictEqual(
      empty.events.flatMap((event) =>
        event._tag === "MultiInstanceGroupCompleted"
          ? [{
            reason: event.reason,
            counters: event.counters
          }]
          : []
      ),
      [{
        reason: "empty",
        counters: {
          numberOfInstances: 0,
          numberOfActiveInstances: 0,
          numberOfCompletedInstances: 0,
          numberOfTerminatedInstances: 0
        }
      }]
    )
    assertReplay(emptyKernel, empty.events, empty.state)

    const boundedKernel = compile(
      multiInstanceModel({
        mode: "parallel",
        cardinality: cardinalityExpression
      }),
      {
        ...limits,
        maxAutomaticTransitions: 1_000,
        maxMultiInstanceCardinality: 2
      }
    )
    const snapshots: Array<number> = []
    const rejected = initializeKernel(boundedKernel, {
      now,
      evaluateExpression: (context) => {
        snapshots.push(context.state.multiInstanceGroups.length)
        return Result.succeed({ result: 3, steps: 1 })
      }
    })
    assert.isTrue(Result.isFailure(rejected))
    if (Result.isSuccess(rejected)) {
      throw new Error("expected over-limit cardinality rejection")
    }
    assert(
      rejected.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidKernelLimits)
    )
    assert.deepStrictEqual(snapshots, [0])
  })

  it("fails closed for invalid evaluator values and for a missing evaluator", () => {
    const kernel = compile(multiInstanceModel({
      mode: "sequential",
      cardinality: cardinalityExpression
    }))
    const invalidValues: ReadonlyArray<unknown> = [
      "3",
      -1,
      1.5,
      Number.NaN,
      BigInt(3)
    ]
    for (const value of invalidValues) {
      const initialized = initializeKernel(
        kernel,
        services(value)
      )
      assert.isTrue(
        Result.isFailure(initialized),
        `expected cardinality ${String(value)} to fail`
      )
      if (Result.isSuccess(initialized)) {
        throw new Error("expected invalid cardinality rejection")
      }
      assert(
        initialized.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.EvaluationFailed)
      )
    }

    const missing = initializeKernel(kernel, { now })
    assert.isTrue(Result.isFailure(missing))
    if (Result.isSuccess(missing)) {
      throw new Error("expected missing evaluator rejection")
    }
    assert(
      missing.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.EvaluationRequired)
    )
  })

  it("snapshots a collection once, preserves order and duplicates, exposes each declared inputDataItem, and replays out-of-order completion", () => {
    const kernel = compileCollection("parallel")
    const sourceItems = [
      { id: "first", nested: { value: 1 } },
      { id: "duplicate", nested: { value: 2 } },
      { id: "duplicate", nested: { value: 2 } }
    ]
    const commandInput = {
      items: sourceItems,
      requestId: "request-1"
    }
    const observations: Array<EvaluationObservation> = []
    const runtime = collectionServices((context) => {
      assert.deepStrictEqual(context.state.input, commandInput)
      assert.strictEqual(context.dataInputRef, collectionInputRef)
      assert.strictEqual(context.groupActivation, 0)
      return sourceItems
    }, observations)
    const initialized = success(
      initializeKernel(kernel, runtime, commandInput)
    )
    const expectedItems = structuredClone(sourceItems)

    commandInput.requestId = "mutated"
    sourceItems[0]!.id = "mutated"
    sourceItems.push({ id: "late", nested: { value: 4 } })

    assert.deepStrictEqual(observations, [{
      tag: "MultiInstanceCollection",
      expectedResult: "json-array"
    }])
    assert.deepStrictEqual(initialized.state.input, {
      items: expectedItems,
      requestId: "request-1"
    })
    assert.deepStrictEqual(
      initialized.state.multiInstanceGroups[0]?.source,
      {
        _tag: "Collection",
        dataInputRef: collectionInputRef,
        items: expectedItems
      }
    )
    assert.isTrue(Object.isFrozen(initialized.state))
    assert.isTrue(Object.isFrozen(
      initialized.state.multiInstanceGroups[0]?.source
    ))
    assert.deepStrictEqual(
      initialized.events.flatMap((event) =>
        event._tag === "MultiInstanceCollectionEvaluated"
          ? [{
            dataInputRef: event.dataInputRef,
            expectedItems: event.items,
            itemCanonicalBytes: event.itemCanonicalBytes
          }]
          : []
      ),
      [{
        dataInputRef: collectionInputRef,
        expectedItems,
        itemCanonicalBytes: expectedItems.map((item) => new TextEncoder().encode(JSON.stringify(item)).byteLength)
      }]
    )

    const initialTokens = activeTaskTokens(initialized.state)
    assert.strictEqual(initialTokens.length, expectedItems.length)
    assert.deepStrictEqual(
      initialTokens.map((token) =>
        success(BpmnKernel.taskCollectionItem(
          kernel,
          initialized.state,
          target(token)
        ))
      ),
      expectedItems.map((item, itemIndex) => ({
        dataInputRef: collectionInputRef,
        itemIndex,
        itemKey: `item:${itemIndex}`,
        item
      }))
    )

    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    let state = initialized.state
    for (const itemIndex of [2, 0, 1]) {
      const token = activeTaskTokens(state).find((candidate) =>
        candidate.invocation.branch?._tag === "MultiInstanceItem" &&
        candidate.invocation.branch.itemIndex === itemIndex
      )
      if (token === undefined) {
        throw new Error(`expected active collection member ${itemIndex}`)
      }
      const completed = success(
        BpmnKernel.completeTask(kernel, state, target(token), runtime)
      )
      journal.push(...completed.events)
      state = completed.state
    }

    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.members.map((member) => ({
        index: member.index,
        itemKey: member.itemKey,
        status: member.status
      })),
      [
        { index: 0, itemKey: "item:0", status: "completed" },
        { index: 1, itemKey: "item:1", status: "completed" },
        { index: 2, itemKey: "item:2", status: "completed" }
      ]
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceItemCompleted"
          ? [event.itemIndex]
          : []
      ),
      [2, 0, 1]
    )
    assertReplay(kernel, journal, state)
  })

  it("keeps taskCollectionItem opt-in and rejects collection output without a scalar outputDataItem or with a partial completion policy", () => {
    const withoutInputDataItem = compile(
      collectionModel("parallel", {
        declareInputDataItem: false
      }),
      limits,
      [],
      {
        dataDocument: collectionDataDocument(),
        collectionBindings: [collectionBinding()]
      }
    )
    const initialized = success(initializeKernel(
      withoutInputDataItem,
      collectionServices(() => ["private-item"])
    ))
    assert.strictEqual(
      success(BpmnKernel.taskCollectionItem(
        withoutInputDataItem,
        initialized.state,
        target(activeTaskTokens(initialized.state)[0]!)
      )),
      undefined
    )

    const invalidModels: ReadonlyArray<BpmnModel.BpmnModel> = [
      multiInstanceModel({
        mode: "parallel",
        loopDataInputRef: collectionInputRef,
        inputDataItem: true,
        loopDataOutputRef: collectionOutputRef
      }),
      multiInstanceModel({
        mode: "parallel",
        loopDataInputRef: collectionInputRef,
        inputDataItem: true,
        loopDataOutputRef: collectionOutputRef,
        outputDataItem: true,
        completionCondition: completionExpression
      })
    ]
    for (const candidate of invalidModels) {
      const rejected = prepareResult(
        candidate,
        limits,
        [taskBinding()],
        {
          dataDocument: collectionDataDocument(true),
          collectionBindings: [collectionBinding()]
        }
      )
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isSuccess(rejected)) {
        throw new Error("expected unsupported collection output policy")
      }
      assert(
        rejected.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.UnsupportedLoop)
      )
    }
  })

  it("executes collection members sequentially and completes an empty collection without creating work", () => {
    const sequentialKernel = compileCollection("sequential")
    const sequentialRuntime = collectionServices(() => ["a", "b", "c"])
    const initialized = success(
      initializeKernel(sequentialKernel, sequentialRuntime)
    )
    let state = initialized.state
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]

    for (let itemIndex = 0; itemIndex < 3; itemIndex++) {
      const waiting = activeTaskTokens(state)
      assert.strictEqual(waiting.length, 1)
      assert.strictEqual(
        waiting[0]?.invocation.branch?._tag === "MultiInstanceItem"
          ? waiting[0].invocation.branch.itemIndex
          : undefined,
        itemIndex
      )
      assert.deepStrictEqual(
        success(BpmnKernel.taskCollectionItem(
          sequentialKernel,
          state,
          target(waiting[0]!)
        )),
        {
          dataInputRef: collectionInputRef,
          itemIndex,
          itemKey: `item:${itemIndex}`,
          item: ["a", "b", "c"][itemIndex]
        }
      )
      const completed = success(BpmnKernel.completeTask(
        sequentialKernel,
        state,
        target(waiting[0]!),
        sequentialRuntime
      ))
      journal.push(...completed.events)
      state = completed.state
    }
    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.source,
      {
        _tag: "Collection",
        dataInputRef: collectionInputRef,
        items: ["a", "b", "c"]
      }
    )
    assertReplay(sequentialKernel, journal, state)

    const emptyKernel = compileCollection("parallel", { output: true })
    const empty = success(initializeKernel(
      emptyKernel,
      collectionServices(() => [])
    ))
    assert.strictEqual(empty.state.status, "completed")
    assert.deepStrictEqual(
      empty.state.multiInstanceGroups[0],
      {
        ...empty.state.multiInstanceGroups[0],
        members: [],
        completedInstanceCount: 0,
        source: {
          _tag: "Collection",
          dataInputRef: collectionInputRef,
          items: []
        },
        output: {
          dataOutputRef: collectionOutputRef,
          items: []
        },
        status: "completed",
        completionReason: "empty"
      }
    )
    assert.deepStrictEqual(
      empty.events.flatMap((event) =>
        event._tag === "MultiInstanceGroupCompleted"
          ? [{ reason: event.reason, output: event.output }]
          : []
      ),
      [{
        reason: "empty",
        output: {
          dataOutputRef: collectionOutputRef,
          items: []
        }
      }]
    )
    assertReplay(emptyKernel, empty.events, empty.state)
  })

  it("enforces execution-input, collection-cardinality, collection-byte, and item-byte limits atomically", () => {
    const cases: ReadonlyArray<{
      readonly selectedLimits: BpmnKernel.KernelLimits
      readonly items: ReadonlyArray<Schema.Json>
      readonly input?: Schema.Json
      readonly expectedPath: string
    }> = [
      {
        selectedLimits: {
          ...limits,
          maxExecutionInputCanonicalBytes: 3
        },
        items: [],
        expectedPath: "input"
      },
      {
        selectedLimits: {
          ...limits,
          maxMultiInstanceCardinality: 1
        },
        items: ["a", "b"],
        expectedPath: "limits"
      },
      {
        selectedLimits: {
          ...limits,
          maxMultiInstanceCollectionCanonicalBytes: 4
        },
        items: ["a"],
        expectedPath: "limits"
      },
      {
        selectedLimits: {
          ...limits,
          maxMultiInstanceItemCanonicalBytes: 4
        },
        items: ["oversized"],
        expectedPath: "maxMultiInstanceItemCanonicalBytes"
      }
    ]

    for (const testCase of cases) {
      let evaluationCount = 0
      const runtime = collectionServices(() => {
        evaluationCount++
        return testCase.items
      })
      const kernel = compileCollection("parallel", {
        limits: testCase.selectedLimits
      })
      const rejected = initializeKernel(
        kernel,
        runtime,
        testCase.input ?? null
      )
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isSuccess(rejected)) {
        throw new Error("expected compiled limit rejection")
      }
      assert(
        rejected.failure.diagnostics.some((diagnostic) =>
          diagnostic.code === BpmnKernel.Codes.InvalidKernelLimits &&
          diagnostic.path.includes(testCase.expectedPath)
        )
      )
      assert.strictEqual(
        evaluationCount,
        testCase.expectedPath === "input" ? 0 : 1
      )
    }
  })

  it("replays collection evidence and rejects tampered snapshots, measurements, and evaluator usage", () => {
    const kernel = compileCollection("parallel")
    const initialized = success(initializeKernel(
      kernel,
      collectionServices(() => [{ id: 1 }, { id: 2 }]),
      { requestId: "collection-replay" }
    ))
    assertReplay(kernel, initialized.events, initialized.state)

    const tamper = (
      mutation: (
        event: Extract<
          BpmnKernel.TransitionEvent,
          { readonly _tag: "MultiInstanceCollectionEvaluated" }
        >
      ) => void
    ): void => {
      const forged = structuredClone(initialized.events)
      const event = forged.find((candidate) => candidate._tag === "MultiInstanceCollectionEvaluated")
      if (event?._tag !== "MultiInstanceCollectionEvaluated") {
        throw new Error("expected collection-evaluated evidence")
      }
      mutation(event)
      assertReplayFailure(kernel, forged)
    }

    tamper((event) => {
      event.items[0] = { id: 99 }
    })
    tamper((event) => {
      event.collectionCanonicalBytes++
    })
    tamper((event) => {
      event.itemCanonicalBytes[0]!++
    })
    tamper((event) => {
      event.usage.steps = event.evaluatorBinding.limits.maxSteps + 1
    })
    tamper((event) => {
      event.usage.contextCanonicalBytes++
    })
  })

  it("commits BPMN data and collection bindings to the executable fingerprint", () => {
    const baseline = compileCollection("parallel")
    const differentlyBound = compileCollection("parallel", {
      expression: alternateCollectionExpression
    })
    const changedDocument = structuredClone(collectionDataDocument())
    changedDocument.inputOutputSpecifications[0]!.dataInputs[0]!.name = "Changed collection declaration"
    const differentlyDeclared = compile(
      collectionModel("parallel"),
      limits,
      [],
      {
        dataDocument: changedDocument,
        collectionBindings: [collectionBinding()]
      }
    )

    assert.notStrictEqual(
      baseline.modelReference.executableFingerprint,
      differentlyBound.modelReference.executableFingerprint
    )
    assert.notStrictEqual(
      baseline.modelReference.executableFingerprint,
      differentlyDeclared.modelReference.executableFingerprint
    )

    const initialized = success(initializeKernel(
      baseline,
      collectionServices(() => ["one"])
    ))
    assertReplayFailure(
      differentlyBound,
      initialized.events,
      BpmnKernel.Codes.BpmnJournalModelMismatch
    )
    assertReplayFailure(
      differentlyDeclared,
      initialized.events,
      BpmnKernel.Codes.BpmnJournalModelMismatch
    )
  })

  it("aggregates protocol-v3 member outputs in collection order and enforces output byte limits", () => {
    const kernel = compileCollection("parallel", { output: true })
    const runtime = collectionServices(() => [
      { id: "input-0" },
      { id: "input-1" },
      { id: "input-2" }
    ])
    const outputs: ReadonlyArray<Schema.Json> = [
      { id: "output-0" },
      { id: "output-1" },
      { id: "output-2" }
    ]
    const initialized = success(initializeKernel(kernel, runtime))
    const journal: Array<BpmnKernel.TransitionEvent> = [
      ...initialized.events
    ]
    let state = initialized.state

    for (const itemIndex of [2, 0, 1]) {
      const token = activeTaskTokens(state).find((candidate) =>
        candidate.invocation.branch?._tag === "MultiInstanceItem" &&
        candidate.invocation.branch.itemIndex === itemIndex
      )
      if (token === undefined) {
        throw new Error(`expected active output member ${itemIndex}`)
      }
      const resolved = success(BpmnKernel.resolveTask(
        kernel,
        state,
        {
          commandVersion: BpmnActivityV3.CommandVersion,
          ...target(token),
          outcome: succeededOutcome(outputs[itemIndex]!)
        },
        runtime
      ))
      journal.push(...resolved.events)
      state = resolved.state
    }

    assert.strictEqual(state.status, "completed")
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.members.map((member) => member.output),
      outputs
    )
    assert.deepStrictEqual(
      state.multiInstanceGroups[0]?.output,
      {
        dataOutputRef: collectionOutputRef,
        items: outputs
      }
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceGroupCompleted"
          ? [event.output]
          : []
      ),
      [{
        dataOutputRef: collectionOutputRef,
        items: outputs
      }]
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "MultiInstanceItemCompleted"
          ? [event.itemIndex]
          : []
      ),
      [2, 0, 1]
    )
    assertReplay(kernel, journal, state)

    const outputLimitCases: ReadonlyArray<{
      readonly selectedLimits: BpmnKernel.KernelLimits
      readonly expectedPath: string
    }> = [
      {
        selectedLimits: {
          ...limits,
          maxMultiInstanceItemOutputCanonicalBytes: 4
        },
        expectedPath: "maxMultiInstanceItemOutputCanonicalBytes"
      },
      {
        selectedLimits: {
          ...limits,
          maxMultiInstanceOutputCanonicalBytes: 4
        },
        expectedPath: "maxMultiInstanceOutputCanonicalBytes"
      }
    ]
    for (const testCase of outputLimitCases) {
      const boundedKernel = compileCollection("parallel", {
        limits: testCase.selectedLimits,
        output: true
      })
      const boundedRuntime = collectionServices(() => ["one"])
      const bounded = success(initializeKernel(
        boundedKernel,
        boundedRuntime
      ))
      const token = activeTaskTokens(bounded.state)[0]!
      const rejected = BpmnKernel.resolveTask(
        boundedKernel,
        bounded.state,
        {
          commandVersion: BpmnActivityV3.CommandVersion,
          ...target(token),
          outcome: succeededOutcome("oversized")
        },
        boundedRuntime
      )
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isSuccess(rejected)) {
        throw new Error("expected output byte limit rejection")
      }
      assert(
        rejected.failure.diagnostics.some((diagnostic) =>
          diagnostic.code === BpmnKernel.Codes.InvalidKernelLimits &&
          diagnostic.path.includes(testCase.expectedPath)
        )
      )
    }
  })

  it("rejects direct-state tampering that removes, oversizes, or over-aggregates collection outputs", () => {
    const completedState = (
      kernel: BpmnKernel.CompiledKernel,
      runtime: BpmnKernel.Services,
      outputs: ReadonlyArray<Schema.Json>
    ): BpmnKernel.TransitionBatch["state"] => {
      let state = success(initializeKernel(kernel, runtime)).state
      for (let itemIndex = 0; itemIndex < outputs.length; itemIndex++) {
        const token = activeTaskTokens(state).find((candidate) =>
          candidate.invocation.branch?._tag === "MultiInstanceItem" &&
          candidate.invocation.branch.itemIndex === itemIndex
        )
        if (token === undefined) {
          throw new Error(`expected active direct-state member ${itemIndex}`)
        }
        state = success(BpmnKernel.resolveTask(
          kernel,
          state,
          {
            commandVersion: BpmnActivityV3.CommandVersion,
            ...target(token),
            outcome: succeededOutcome(outputs[itemIndex]!)
          },
          runtime
        )).state
      }
      assert.strictEqual(state.status, "completed")
      assert(Result.isSuccess(BpmnKernel.advance(kernel, state, runtime)))
      return state
    }

    const assertStateRejectedAt = (
      kernel: BpmnKernel.CompiledKernel,
      runtime: BpmnKernel.Services,
      state: unknown,
      expectedPath: ReadonlyArray<string | number>
    ): void => {
      const rejected = BpmnKernel.advance(kernel, state, runtime)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isSuccess(rejected)) {
        throw new Error("expected direct-state tamper rejection")
      }
      assert(
        rejected.failure.diagnostics.some((diagnostic) =>
          JSON.stringify(diagnostic.path) === JSON.stringify(expectedPath)
        )
      )
    }

    const memberBoundedLimits: BpmnKernel.KernelLimits = {
      ...limits,
      maxMultiInstanceOutputCanonicalBytes: 100,
      maxMultiInstanceItemOutputCanonicalBytes: 8
    }
    const memberKernel = compileCollection("parallel", {
      limits: memberBoundedLimits,
      output: true
    })
    const memberRuntime = collectionServices(() => ["input-0", "input-1"])
    const validMemberState = completedState(
      memberKernel,
      memberRuntime,
      ["a", "b"]
    )

    const missingAggregate = structuredClone(validMemberState)
    delete (
      missingAggregate.multiInstanceGroups[0] as unknown as {
        output?: unknown
      }
    ).output
    assertStateRejectedAt(
      memberKernel,
      memberRuntime,
      missingAggregate,
      ["multiInstanceGroups", 0, "output"]
    )

    const oversizedMember = structuredClone(validMemberState)
    oversizedMember.multiInstanceGroups[0]!.members[0]!.output = "123456789"
    oversizedMember.multiInstanceGroups[0]!.output!.items[0] = "123456789"
    assertStateRejectedAt(
      memberKernel,
      memberRuntime,
      oversizedMember,
      ["multiInstanceGroups", 0, "members", 0, "output"]
    )

    const aggregateBoundedLimits: BpmnKernel.KernelLimits = {
      ...limits,
      maxMultiInstanceOutputCanonicalBytes: 10,
      maxMultiInstanceItemOutputCanonicalBytes: 10
    }
    const aggregateKernel = compileCollection("parallel", {
      limits: aggregateBoundedLimits,
      output: true
    })
    const aggregateRuntime = collectionServices(() => [
      "input-0",
      "input-1"
    ])
    const oversizedAggregate = structuredClone(completedState(
      aggregateKernel,
      aggregateRuntime,
      ["a", "b"]
    ))
    for (const member of oversizedAggregate.multiInstanceGroups[0]!.members) {
      member.output = "aaa"
    }
    oversizedAggregate.multiInstanceGroups[0]!.output!.items = [
      "aaa",
      "aaa"
    ]
    assertStateRejectedAt(
      aggregateKernel,
      aggregateRuntime,
      oversizedAggregate,
      ["multiInstanceGroups", 0, "output", "items"]
    )
  })

  it("rejects non-all behavior modes and collection profiles at their fail-closed boundary", () => {
    const unsupported: ReadonlyArray<
      readonly [
        BpmnModel.BpmnModel,
        string
      ]
    > = [
      [
        multiInstanceModel({
          mode: "parallel",
          cardinality: cardinalityExpression,
          behavior: "one",
          oneBehaviorEventRef: "one-event"
        }),
        BpmnKernel.Codes.UnsupportedLoop
      ],
      [
        multiInstanceModel({
          mode: "parallel",
          cardinality: cardinalityExpression,
          behavior: "none",
          noneBehaviorEventRef: "none-event"
        }),
        BpmnKernel.Codes.UnsupportedLoop
      ],
      [
        multiInstanceModel({
          mode: "parallel",
          cardinality: cardinalityExpression,
          behavior: "complex"
        }),
        BpmnKernel.Codes.UnsupportedLoop
      ],
      [
        multiInstanceModel({
          mode: "parallel",
          loopDataInputRef: "items"
        }),
        BpmnKernel.Codes.UnsupportedLoop
      ],
      [
        multiInstanceModel({
          mode: "parallel",
          cardinality: cardinalityExpression,
          loopDataInputRef: "items"
        }),
        BpmnModel.Codes.InvalidLoopCharacteristics
      ],
      [
        multiInstanceModel({
          mode: "parallel",
          cardinality: cardinalityExpression,
          loopDataOutputRef: "results"
        }),
        BpmnModel.Codes.InvalidLoopCharacteristics
      ]
    ]

    for (const [candidate, expectedCode] of unsupported) {
      const prepared = prepareResult(candidate)
      assert.isTrue(Result.isFailure(prepared))
      if (Result.isSuccess(prepared)) {
        throw new Error("expected unsupported multi-instance profile")
      }
      assert(
        prepared.failure.diagnostics.some((diagnostic) => diagnostic.code === expectedCode)
      )
    }
  })

  it("cancels every parallel member before routing one mapped Boundary Error and replays it exactly", () => {
    const errorRef = "error-multi-instance"
    const kernel = compile(
      boundaryErrorModel({
        mode: "parallel",
        cardinality: cardinalityExpression
      }, errorRef),
      limits,
      [taskBinding([{
        errorTag: "RejectedItem",
        errorCode: "REJECTED",
        errorRef
      }])]
    )
    const runtime = services(3)
    const initialized = success(initializeKernel(kernel, runtime))
    const tokens = activeTaskTokens(initialized.state)
    const failed = success(BpmnKernel.resolveTask(
      kernel,
      initialized.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        ...target(tokens[1]!),
        outcome: failedOutcome("RejectedItem", "REJECTED")
      },
      runtime
    ))
    const journal = [...initialized.events, ...failed.events]

    assert.strictEqual(failed.state.status, "completed")
    assert.deepStrictEqual(
      failed.state.multiInstanceGroups.map((group) => ({
        status: group.status,
        completionReason: group.completionReason,
        completedInstanceCount: group.completedInstanceCount,
        members: group.members.map((member) => ({
          index: member.index,
          status: member.status,
          terminationReason: member.terminationReason
        }))
      })),
      [{
        status: "cancelled",
        completionReason: "boundary-error-caught",
        completedInstanceCount: 0,
        members: [
          {
            index: 0,
            status: "terminated",
            terminationReason: "boundary-error-caught"
          },
          {
            index: 1,
            status: "terminated",
            terminationReason: "boundary-error-caught"
          },
          {
            index: 2,
            status: "terminated",
            terminationReason: "boundary-error-caught"
          }
        ]
      }]
    )
    assert.strictEqual(
      failed.state.tokens.filter((token) =>
        token.invocation.branch?._tag === "MultiInstanceItem" &&
        token.status === "withdrawn"
      ).length,
      3
    )
    assert.strictEqual(
      journal.filter((event) => event._tag === "BoundaryErrorCaught").length,
      1
    )
    assert.strictEqual(
      journal.filter((event) =>
        event._tag === "TokenEmitted" &&
        event.position._tag === "OnSequenceFlow" &&
        event.position.sequenceFlowId === "flow-boundary-end"
      ).length,
      1
    )
    assert.strictEqual(
      journal.filter((event) => event._tag === "MultiInstanceGroupCancelled").length,
      1
    )
    assertReplay(kernel, journal, failed.state)
  })

  it("cleans every parallel member after an unmapped business failure and replays the terminal failure", () => {
    const kernel = compile(
      multiInstanceModel({
        mode: "parallel",
        cardinality: cardinalityExpression
      }),
      limits,
      [taskBinding()]
    )
    const runtime = services(3)
    const initialized = success(initializeKernel(kernel, runtime))
    const token = activeTaskTokens(initialized.state)[0]!
    const failed = success(BpmnKernel.resolveTask(
      kernel,
      initialized.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        ...target(token),
        outcome: failedOutcome("UnmappedItemFailure", null)
      },
      runtime
    ))
    const journal = [...initialized.events, ...failed.events]

    assert.strictEqual(failed.state.status, "failed")
    assert.strictEqual(
      failed.state.tokens.filter((candidate) => candidate.status === "active").length,
      0
    )
    assert.deepStrictEqual(
      failed.state.multiInstanceGroups.map((group) => ({
        status: group.status,
        completionReason: group.completionReason,
        memberStatuses: group.members.map((member) => member.status),
        terminationReasons: group.members.map((member) => member.terminationReason)
      })),
      [{
        status: "cancelled",
        completionReason: "unmapped-business-failure",
        memberStatuses: ["terminated", "terminated", "terminated"],
        terminationReasons: [
          "unmapped-business-failure",
          "unmapped-business-failure",
          "unmapped-business-failure"
        ]
      }]
    )
    assert.deepStrictEqual(
      journal.flatMap((event) =>
        event._tag === "ExecutionFailed"
          ? [{
            taskNodeId: event.taskNodeId,
            sourceTokenId: event.sourceTokenId,
            failureKind: event.failureKind
          }]
          : []
      ),
      [{
        taskNodeId,
        sourceTokenId: token.tokenId,
        failureKind: "UnmappedBusinessFailure"
      }]
    )
    assert.strictEqual(
      journal.filter((event) => event._tag === "MultiInstanceGroupCancelled").length,
      1
    )
    assertReplay(kernel, journal, failed.state)
  })

  it("rejects tampered cardinality, item identity, ordering, counters, completion result, model fingerprint, and limits", () => {
    const definition = multiInstanceModel({
      mode: "parallel",
      cardinality: cardinalityExpression,
      completionCondition: completionExpression
    })
    const kernel = compile(definition)
    const runtime = services(
      3,
      (context) => context.runtime.numberOfCompletedInstances >= 2
    )
    const initialized = success(initializeKernel(kernel, runtime))
    const tokens = activeTaskTokens(initialized.state)
    const first = success(
      BpmnKernel.completeTask(
        kernel,
        initialized.state,
        target(tokens[0]!),
        runtime
      )
    )
    const second = success(
      BpmnKernel.completeTask(
        kernel,
        first.state,
        target(tokens[1]!),
        runtime
      )
    )
    const journal: ReadonlyArray<BpmnKernel.TransitionEvent> = [
      ...initialized.events,
      ...first.events,
      ...second.events
    ]
    assertReplay(kernel, journal, second.state)

    const tamper = (
      mutation: (events: Array<BpmnKernel.TransitionEvent>) => void
    ): void => {
      const forged = structuredClone(journal)
      mutation(forged)
      assertReplayFailure(kernel, forged)
    }

    tamper((events) => {
      const event = events.find((candidate) => candidate._tag === "MultiInstanceCardinalityEvaluated")
      if (event?._tag !== "MultiInstanceCardinalityEvaluated") {
        throw new Error("expected cardinality event")
      }
      event.cardinality++
    })
    tamper((events) => {
      const event = events.find((candidate) => candidate._tag === "MultiInstanceGroupOpened")
      if (event?._tag !== "MultiInstanceGroupOpened") {
        throw new Error("expected group-open event")
      }
      event.itemKeys[0] = "item:99"
    })
    tamper((events) => {
      const event = events.find((candidate) => candidate._tag === "MultiInstanceItemStarted")
      if (event?._tag !== "MultiInstanceItemStarted") {
        throw new Error("expected item-start event")
      }
      event.itemIndex++
    })
    tamper((events) => {
      const event = events.find((candidate) => candidate._tag === "MultiInstanceItemCompleted")
      if (event?._tag !== "MultiInstanceItemCompleted") {
        throw new Error("expected item-completed event")
      }
      event.counters.numberOfCompletedInstances++
    })
    tamper((events) => {
      const event = events.find((candidate) =>
        candidate._tag ===
          "MultiInstanceCompletionConditionEvaluated"
      )
      if (
        event?._tag !==
          "MultiInstanceCompletionConditionEvaluated"
      ) {
        throw new Error("expected completion-condition event")
      }
      event.result = !event.result
    })
    tamper((events) => {
      const index = events.findIndex((candidate) => candidate._tag === "MultiInstanceItemCompleted")
      if (index < 0) {
        throw new Error("expected item-completed event")
      }
      events.splice(index, 1)
    })
    tamper((events) => {
      const completedIndex = events.findIndex((candidate) => candidate._tag === "MultiInstanceItemCompleted")
      const conditionIndex = events.findIndex((candidate) =>
        candidate._tag ===
          "MultiInstanceCompletionConditionEvaluated"
      )
      if (completedIndex < 0 || conditionIndex < 0) {
        throw new Error("expected completion causal pair")
      }
      const completed = events[completedIndex]!
      events[completedIndex] = events[conditionIndex]!
      events[conditionIndex] = completed
    })
    const forgedModel = structuredClone(journal)
    {
      const header = forgedModel[0]
      if (header?._tag !== "JournalStarted") {
        throw new Error("expected journal header")
      }
      header.model.profileId = "forged-profile"
    }
    assertReplayFailure(
      kernel,
      forgedModel,
      BpmnKernel.Codes.BpmnJournalModelMismatch
    )

    const differentlyBounded = compile(definition, {
      ...limits,
      maxAutomaticTransitions: limits.maxAutomaticTransitions,
      maxMultiInstanceCardinality: limits.maxMultiInstanceCardinality - 1
    })
    assertReplayFailure(
      differentlyBounded,
      journal,
      BpmnKernel.Codes.BpmnJournalModelMismatch
    )
  })
})
