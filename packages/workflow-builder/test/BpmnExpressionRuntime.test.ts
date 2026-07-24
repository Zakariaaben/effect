import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnData from "../src/BpmnData.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as Evaluator from "../src/BpmnExpressionEvaluator.ts"
import * as Runtime from "../src/BpmnExpressionRuntime.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "process-main"
const now = "2026-07-23T10:00:00.000Z" as const
const startCommand: BpmnKernel.InitializeCommand = {
  commandVersion: BpmnKernel.InitializeCommandVersion,
  input: null
}
const emptyExtensions = (): Array<BpmnModel.ExtensionElement> => []

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const buildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"1".repeat(64)}`)

const artifactDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.ArtifactDigest
)(`sha256:${"a".repeat(64)}`)

const occurrenceDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OccurrenceDigest
)(`sha256:${"b".repeat(64)}`)

const firstActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"c".repeat(64)}`)

const completedActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"d".repeat(64)}`)

const semanticNodeId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("semantic-loop")

const binding = (
  overrides: {
    readonly maxSteps?: number
    readonly timeoutMillis?: number
    readonly deploymentId?: string
  } = {}
): BpmnExpression.EvaluatorBinding => ({
  language: "feel",
  languageVersion: "1.0",
  build: {
    id: "test-feel",
    version: "1.0.0",
    deploymentId: overrides.deploymentId ?? "test-deployment",
    buildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: overrides.maxSteps ?? 100,
    timeoutMillis: overrides.timeoutMillis ?? 1_000
  }
})

const taskBinding = (
  taskNodeId: string
): BpmnActivityV3.TaskBinding =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskBinding)({
    bindingVersion: BpmnActivityV3.BindingVersion,
    executionProtocolVersion: 3,
    taskNodeId,
    artifactDigest,
    semanticNodeId,
    errorMappings: []
  })

const succeededOutcome = (): BpmnActivityV3.TaskSucceeded =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskSucceeded)({
    _tag: "Succeeded",
    outcomeVersion: BpmnActivityV3.OutcomeVersion,
    artifactDigest,
    semanticNodeId,
    occurrenceDigest,
    firstActivityDigest,
    attempt: 1,
    completedActivityDigest,
    output: { _tag: "Inline", value: null }
  })

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const start = (
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.StartEvent => ({
  _tag: "StartEvent",
  id: "start",
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: emptyExtensions()
})

const task = (
  id: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>,
  defaultFlowId?: string
): BpmnModel.Task => ({
  _tag: "Task",
  id,
  processId,
  parentScopeId: processId,
  taskKind: "generic",
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  ...(defaultFlowId === undefined ? undefined : { defaultFlowId }),
  extensionElements: emptyExtensions()
})

const end = (
  incomingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.EndEvent => ({
  _tag: "EndEvent",
  id: "end",
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: emptyExtensions()
})

const exclusive = (
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.Gateway => ({
  _tag: "Gateway",
  id: "choose",
  processId,
  parentScopeId: processId,
  gatewayKind: "exclusive",
  gatewayDirection: "diverging",
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  defaultFlowId: "flow-default",
  extensionElements: emptyExtensions()
})

const flow = (
  id: string,
  sourceId: string,
  targetId: string,
  kind: BpmnModel.SequenceFlow["kind"],
  condition?: BpmnModel.Expression
): BpmnModel.SequenceFlow => ({
  id,
  processId,
  parentScopeId: processId,
  sourceId,
  targetId,
  kind,
  ...(condition === undefined ? undefined : { condition }),
  extensionElements: emptyExtensions()
})

const makeModel = (
  flowNodes: ReadonlyArray<BpmnModel.FlowNode>,
  sequenceFlows: ReadonlyArray<BpmnModel.SequenceFlow>
): BpmnModel.BpmnModel => ({
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
  flowNodes: [...flowNodes],
  sequenceFlows: [...sequenceFlows]
})

const gatewayModel = (): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      exclusive(["flow-start"], ["flow-one", "flow-two", "flow-default"]),
      task("task-one", ["flow-one"], ["flow-one-end"]),
      task("task-two", ["flow-two"], ["flow-two-end"]),
      task("task-default", ["flow-default"], ["flow-default-end"]),
      end(["flow-one-end", "flow-two-end", "flow-default-end"])
    ],
    [
      flow("flow-start", "start", "choose", "normal"),
      flow("flow-one", "choose", "task-one", "conditional", expression("one")),
      flow("flow-two", "choose", "task-two", "conditional", expression("two")),
      flow("flow-default", "choose", "task-default", "default"),
      flow("flow-one-end", "task-one", "end", "normal"),
      flow("flow-two-end", "task-two", "end", "normal"),
      flow("flow-default-end", "task-default", "end", "normal")
    ]
  )

const taskModel = (): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      task(
        "decide",
        ["flow-start"],
        ["flow-one", "flow-two", "flow-default"],
        "flow-default"
      ),
      task("task-one", ["flow-one"], ["flow-one-end"]),
      task("task-two", ["flow-two"], ["flow-two-end"]),
      task("task-default", ["flow-default"], ["flow-default-end"]),
      end(["flow-one-end", "flow-two-end", "flow-default-end"])
    ],
    [
      flow("flow-start", "start", "decide", "normal"),
      flow("flow-one", "decide", "task-one", "conditional", expression("one")),
      flow("flow-two", "decide", "task-two", "conditional", expression("two")),
      flow("flow-default", "decide", "task-default", "default"),
      flow("flow-one-end", "task-one", "end", "normal"),
      flow("flow-two-end", "task-two", "end", "normal"),
      flow("flow-default-end", "task-default", "end", "normal")
    ]
  )

const straightModel = (): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      task("wait", ["flow-start"], ["flow-end"]),
      end(["flow-end"])
    ],
    [
      flow("flow-start", "start", "wait", "normal"),
      flow("flow-end", "wait", "end", "normal")
    ]
  )

const standardLoopModel = (
  testBefore: boolean
): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      {
        ...task("loop", ["flow-start"], ["flow-end"]),
        loopCharacteristics: {
          _tag: "StandardLoopCharacteristics",
          testBefore,
          condition: expression("repeat"),
          loopMaximum: 3
        }
      },
      end(["flow-end"])
    ],
    [
      flow("flow-start", "start", "loop", "normal"),
      flow("flow-end", "loop", "end", "normal")
    ]
  )

const multiInstanceModel = (
  mode: "sequential" | "parallel",
  completionCondition?: BpmnModel.Expression
): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      {
        ...task("multi", ["flow-start"], ["flow-end"]),
        loopCharacteristics: {
          _tag: "MultiInstanceCharacteristics",
          mode,
          cardinality: expression("items-count"),
          ...(completionCondition === undefined
            ? undefined
            : { completionCondition })
        }
      },
      end(["flow-end"])
    ],
    [
      flow("flow-start", "start", "multi", "normal"),
      flow("flow-end", "multi", "end", "normal")
    ]
  )

const collectionMultiInstanceModel = (): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      {
        ...task("multi", ["flow-start"], ["flow-end"]),
        loopCharacteristics: {
          _tag: "MultiInstanceCharacteristics",
          mode: "parallel",
          loopDataInputRef: "items",
          inputDataItem: {
            id: "current-item",
            isCollection: false,
            extensionElements: []
          }
        }
      },
      end(["flow-end"])
    ],
    [
      flow("flow-start", "start", "multi", "normal"),
      flow("flow-end", "multi", "end", "normal")
    ]
  )

const collectionDataDocument: BpmnData.BpmnDataDocument = {
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
    id: "multi-io",
    ownerId: "multi",
    dataInputs: [{
      id: "items",
      isCollection: true,
      extensionElements: []
    }],
    dataOutputs: [],
    inputSets: [{
      id: "multi-input-set",
      dataInputRefs: ["items"],
      optionalInputRefs: [],
      whileExecutingInputRefs: [],
      outputSetRefs: [],
      extensionElements: []
    }],
    outputSets: [{
      id: "multi-output-set",
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
}

const routedStandardLoopModel = (): BpmnModel.BpmnModel =>
  makeModel(
    [
      start(["flow-start"]),
      {
        ...task(
          "loop",
          ["flow-start"],
          ["flow-route", "flow-default"],
          "flow-default"
        ),
        loopCharacteristics: {
          _tag: "StandardLoopCharacteristics",
          testBefore: true,
          condition: expression("repeat"),
          loopMaximum: 3
        }
      },
      task("task-selected", ["flow-route"], ["flow-selected-end"]),
      task("task-default", ["flow-default"], ["flow-default-end"]),
      end(["flow-selected-end", "flow-default-end"])
    ],
    [
      flow("flow-start", "start", "loop", "normal"),
      flow(
        "flow-route",
        "loop",
        "task-selected",
        "conditional",
        expression("route")
      ),
      flow("flow-default", "loop", "task-default", "default"),
      flow("flow-selected-end", "task-selected", "end", "normal"),
      flow("flow-default-end", "task-default", "end", "normal")
    ]
  )

const prepare = (
  model: BpmnModel.BpmnModel,
  evaluatorBinding: BpmnExpression.EvaluatorBinding,
  taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding> = [],
  options: {
    readonly dataDocument?: BpmnData.BpmnDataDocument
    readonly collectionBindings?: ReadonlyArray<
      BpmnKernel.MultiInstanceCollectionBinding
    >
  } = {}
): Effect.Effect<BpmnKernel.CompiledKernel, unknown> =>
  BpmnKernel.prepare(model, {
    profileId: "runtime-test-v1",
    rootProcessId: processId,
    limits: {
      maxAutomaticTransitions: 1_000,
      maxExecutionInputCanonicalBytes: 1_048_576,
      maxExecutionStateCanonicalBytes: 8_388_608,
      maxTransitionJournalEvents: 10_000,
      maxTransitionJournalCanonicalBytes: 16_777_216,
      maxCatchWaitArms: 32,
      maxTimerDelayMillis: 31_536_000_000,
      maxTimerExpressionUtf8Bytes: 4_096,
      maxMessageCorrelationComponents: 16,
      maxMessageCorrelationCanonicalBytes: 16_384,
      maxMessagePayloadCanonicalBytes: 1_048_576,
      maxMultiInstanceCardinality: 100,
      maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
      maxMultiInstanceItemCanonicalBytes: 262_144,
      maxMultiInstanceOutputCanonicalBytes: 1_048_576,
      maxMultiInstanceItemOutputCanonicalBytes: 262_144
    },
    evaluatorBindings: model.sequenceFlows.some((candidate) => candidate.condition !== undefined) ||
        model.flowNodes.some((candidate) =>
          candidate._tag === "Task" &&
          (
            (
              candidate.loopCharacteristics?._tag === "StandardLoopCharacteristics" &&
              candidate.loopCharacteristics.condition !== undefined
            ) ||
            (
              candidate.loopCharacteristics?._tag === "MultiInstanceCharacteristics" &&
              (
                candidate.loopCharacteristics.cardinality !== undefined ||
                candidate.loopCharacteristics.completionCondition !== undefined
              )
            )
          )
        ) ||
        (options.collectionBindings?.length ?? 0) > 0
      ? [evaluatorBinding]
      : [],
    ...(taskBindings.length === 0 ? undefined : { taskBindings }),
    ...(options.dataDocument === undefined
      ? undefined
      : { dataDocument: options.dataDocument }),
    ...(options.collectionBindings === undefined
      ? undefined
      : { collectionBindings: options.collectionBindings })
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const activeNodeIds = (
  batch: BpmnKernel.TransitionBatch
): ReadonlyArray<string> =>
  batch.state.tokens
    .filter((token) => token.status === "active" && token.position._tag === "AtNode")
    .map((token) => token.position._tag === "AtNode" ? token.position.nodeId : "")

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Evaluator.EvaluatorRegistry>,
  registry: Evaluator.EvaluatorRegistry.Service
): Effect.Effect<A, E> => Effect.provideService(effect, Evaluator.EvaluatorRegistry, registry)

const initializeRuntime = (
  kernel: BpmnKernel.CompiledKernel,
  services: BpmnKernel.Services
) => Runtime.initialize(kernel, startCommand, services)

describe("BpmnExpressionRuntime", () => {
  it("admits only exclusive complete runtime-error decision coordinates", () => {
    const decode = Schema.decodeUnknownResult(Runtime.RuntimeError)
    const base = {
      _tag: "BpmnExpressionRuntimeError",
      operation: "initialize",
      code: Runtime.Codes.EvaluatorFailed,
      ordinal: 0
    } as const
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      sequenceFlowId: "flow-one"
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      loopActivityId: "loop",
      loopFrameId: "loop-frame:1",
      loopActivation: 0,
      loopPhase: "before",
      loopIteration: 0
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      operation: "applyChildEvent",
      callActivityNodeId: "call-child",
      callFrameId: "child-call:1",
      callActivityOwnerTokenId: "token-call"
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      multiInstanceActivityId: "multi",
      multiInstanceGroupId: "multi-instance-group:1",
      multiInstanceGroupActivation: 0
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      multiInstanceActivityId: "multi",
      multiInstanceGroupId: "multi-instance-group:1",
      multiInstanceGroupActivation: 0,
      multiInstanceDataInputRef: "items"
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      multiInstanceActivityId: "multi",
      multiInstanceGroupId: "multi-instance-group:1",
      multiInstanceGroupActivation: 0,
      multiInstanceCompletedItemIndex: 1,
      multiInstanceCompletedItemKey: "item:1",
      multiInstanceLoopCounter: 1,
      multiInstanceNumberOfInstances: 3,
      multiInstanceNumberOfActiveInstances: 2,
      multiInstanceNumberOfCompletedInstances: 1,
      multiInstanceNumberOfTerminatedInstances: 0
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      operation: "deliverMessage",
      catchEventNodeId: "message-catch",
      catchWaitGroupId: "catch-wait:1",
      catchArmId: "catch-arm:1",
      catchGeneration: 1,
      catchMessageRef: "message-one"
    })))
    assert.isTrue(Result.isSuccess(decode({
      ...base,
      operation: "observeDueTimer",
      catchEventNodeId: "timer-catch",
      catchWaitGroupId: "catch-wait:1",
      catchArmId: "catch-arm:2",
      catchGeneration: 1,
      catchTimerId: "timer:1",
      catchTimerKind: "timeDuration",
      catchTimerScheduledAt: now
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      sequenceFlowId: "flow-one",
      loopActivityId: "loop",
      loopFrameId: "loop-frame:1",
      loopActivation: 0,
      loopPhase: "before",
      loopIteration: 0
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      loopActivityId: "loop",
      loopFrameId: "loop-frame:1"
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      callActivityNodeId: "call-child",
      callFrameId: "child-call:1"
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      sequenceFlowId: "flow-one",
      callActivityNodeId: "call-child",
      callFrameId: "child-call:1",
      callActivityOwnerTokenId: "token-call"
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      sequenceFlowId: "flow-one",
      multiInstanceActivityId: "multi",
      multiInstanceGroupId: "multi-instance-group:1",
      multiInstanceGroupActivation: 0
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      multiInstanceActivityId: "multi",
      multiInstanceGroupId: "multi-instance-group:1",
      multiInstanceGroupActivation: 0,
      multiInstanceCompletedItemIndex: 1
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      multiInstanceDataInputRef: "items"
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      sequenceFlowId: "flow-one",
      multiInstanceDataInputRef: "items"
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      multiInstanceActivityId: "multi",
      multiInstanceGroupId: "multi-instance-group:1",
      multiInstanceGroupActivation: 0,
      multiInstanceDataInputRef: "items",
      multiInstanceCompletedItemIndex: 1,
      multiInstanceCompletedItemKey: "item:1",
      multiInstanceLoopCounter: 1,
      multiInstanceNumberOfInstances: 3,
      multiInstanceNumberOfActiveInstances: 2,
      multiInstanceNumberOfCompletedInstances: 1,
      multiInstanceNumberOfTerminatedInstances: 0
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      catchEventNodeId: "message-catch",
      catchWaitGroupId: "catch-wait:1",
      catchArmId: "catch-arm:1",
      catchGeneration: 1
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      catchEventNodeId: "timer-catch",
      catchWaitGroupId: "catch-wait:1",
      catchArmId: "catch-arm:2",
      catchGeneration: 1,
      catchTimerId: "timer:1",
      catchTimerKind: "timeDuration"
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      catchEventNodeId: "timer-catch",
      catchWaitGroupId: "catch-wait:1",
      catchArmId: "catch-arm:2",
      catchGeneration: 1,
      catchMessageRef: "message-one",
      catchTimerId: "timer:1",
      catchTimerKind: "timeDuration",
      catchTimerScheduledAt: now
    })))
    assert.isTrue(Result.isFailure(decode({
      ...base,
      sequenceFlowId: "flow-one",
      catchEventNodeId: "message-catch",
      catchWaitGroupId: "catch-wait:1",
      catchArmId: "catch-arm:1",
      catchGeneration: 1,
      catchMessageRef: "message-one"
    })))
  })

  it.effect("resolves the exact binding and evaluates an asynchronous condition", () =>
    Effect.gen(function*() {
      const exactBinding = binding()
      const kernel = yield* prepare(gatewayModel(), exactBinding)
      let requests = 0
      const services: BpmnKernel.Services = { now }
      const definition = Evaluator.makeDefinition({
        binding: exactBinding,
        evaluate: (request) =>
          Effect.gen(function*() {
            requests++
            assert.strictEqual(request.expectedResult, "boolean")
            ;(services as { now: string }).now = "2026-07-23T11:00:00.000Z"
            yield* Effect.yieldNow
            return {
              result: request.source === "one",
              steps: 7
            }
          })
      })
      const registry = yield* Evaluator.makeMemory([definition])
      const batch = yield* provideRegistry(
        initializeRuntime(kernel, services),
        registry
      )

      assert.deepStrictEqual(activeNodeIds(batch), ["task-one"])
      assert.strictEqual(requests, 1)
      const evaluated = batch.events.filter((event) => event._tag === "ConditionEvaluated")
      assert.strictEqual(evaluated.length, 1)
      assert.strictEqual(evaluated[0]?._tag, "ConditionEvaluated")
      if (evaluated[0]?._tag === "ConditionEvaluated") {
        assert.deepStrictEqual(evaluated[0].evaluatorBinding, exactBinding)
        assert.strictEqual(evaluated[0].usage.steps, 7)
      }
      const waiting = batch.events.find((event) => event._tag === "TaskWaiting")
      assert.strictEqual(
        waiting?._tag === "TaskWaiting" ? waiting.enteredAt : undefined,
        now
      )
    }))

  it.effect("keeps a standard-loop decision stable across asynchronous reruns", () =>
    Effect.gen(function*() {
      const exactBinding = binding({ deploymentId: "loop-reruns" })
      const kernel = yield* prepare(routedStandardLoopModel(), exactBinding)
      const calls: Array<string> = []
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: (request) =>
            Effect.gen(function*() {
              calls.push(request.source)
              yield* Effect.yieldNow
              return {
                result: request.source === "route",
                steps: calls.length
              }
            })
        })
      ])
      const batch = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      )

      assert.deepStrictEqual(calls, ["repeat", "route"])
      assert.deepStrictEqual(activeNodeIds(batch), ["task-selected"])
      const loopEvaluations = batch.events.filter(
        (event) => event._tag === "LoopConditionEvaluated"
      )
      assert.strictEqual(loopEvaluations.length, 1)
      const evaluated = loopEvaluations[0]
      assert.strictEqual(evaluated?._tag, "LoopConditionEvaluated")
      if (evaluated?._tag === "LoopConditionEvaluated") {
        assert.strictEqual(evaluated.frameId, "loop-frame:1")
        assert.strictEqual(evaluated.activityId, "loop")
        assert.strictEqual(evaluated.activation, 0)
        assert.strictEqual(evaluated.phase, "before")
        assert.strictEqual(evaluated.iteration, 0)
        assert.isFalse(evaluated.result)
      }
      assert.strictEqual(
        batch.events.filter((event) => event._tag === "ConditionEvaluated")
          .length,
        1
      )
    }))

  it.effect("keeps one asynchronous multi-instance cardinality decision stable across reruns", () =>
    Effect.gen(function*() {
      const exactBinding = binding({ deploymentId: "multi-cardinality-reruns" })
      const kernel = yield* prepare(
        multiInstanceModel("parallel"),
        exactBinding
      )
      const requests: Array<Evaluator.EvaluationRequest> = []
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: (request) =>
            Effect.gen(function*() {
              requests.push(request)
              yield* Effect.yieldNow
              return { result: 3, steps: 4 }
            })
        })
      ])
      const batch = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      )

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0]?.source, "items-count")
      assert.strictEqual(
        requests[0]?.expectedResult,
        "non-negative-integer"
      )
      const group = batch.state.multiInstanceGroups[0]
      assert.strictEqual(group?.groupId, "multi-instance-group:1")
      assert.strictEqual(group?.activityId, "multi")
      assert.strictEqual(group?.activation, 0)
      assert.strictEqual(group?.source._tag, "Cardinality")
      if (group?.source._tag === "Cardinality") {
        assert.strictEqual(group.source.value, 3)
      }
      assert.deepStrictEqual(
        group?.members.map((member) => member.itemKey),
        ["item:0", "item:1", "item:2"]
      )
      assert.strictEqual(
        batch.events.filter(
          (event) => event._tag === "MultiInstanceCardinalityEvaluated"
        ).length,
        1
      )
      assert.strictEqual(
        batch.events.filter(
          (event) => event._tag === "MultiInstanceGroupOpened"
        ).length,
        1
      )
    }))

  it.effect("evaluates and snapshots one collection with exact durable runtime coordinates", () =>
    Effect.gen(function*() {
      const exactBinding = binding({
        deploymentId: "multi-collection-reruns"
      })
      const collectionExpression = expression("execution.items")
      const requests: Array<Evaluator.EvaluationRequest> = []
      const items = [{ id: "a" }, { id: "a" }, null] as const
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: (request) =>
            Effect.gen(function*() {
              requests.push(request)
              yield* Effect.yieldNow
              return { result: items, steps: 5 }
            })
        })
      ])
      const kernel = yield* prepare(
        collectionMultiInstanceModel(),
        exactBinding,
        [],
        {
          dataDocument: collectionDataDocument,
          collectionBindings: [{
            bindingVersion: BpmnKernel.MultiInstanceCollectionBindingVersion,
            taskNodeId: "multi",
            dataInputRef: "items",
            collectionExpression
          }]
        }
      )
      const initialized = yield* provideRegistry(
        Runtime.initialize(
          kernel,
          {
            commandVersion: BpmnKernel.InitializeCommandVersion,
            input: { items: [...items] }
          },
          { now }
        ),
        registry
      )

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0]?.source, "execution.items")
      assert.strictEqual(requests[0]?.expectedResult, "json-array")
      assert.include(
        JSON.stringify(requests[0]?.context),
        "\"items\":[{\"id\":\"a\"},{\"id\":\"a\"},null]"
      )
      const group = initialized.state.multiInstanceGroups[0]
      assert.strictEqual(group?.source._tag, "Collection")
      if (group?.source._tag === "Collection") {
        assert.strictEqual(group.source.dataInputRef, "items")
        assert.deepStrictEqual(group.source.items, items)
      }
      assert.deepStrictEqual(
        group?.members.map((member) => member.itemKey),
        ["item:0", "item:1", "item:2"]
      )
      const evaluated = initialized.events.filter(
        (event) => event._tag === "MultiInstanceCollectionEvaluated"
      )
      assert.strictEqual(evaluated.length, 1)
      assert.strictEqual(
        evaluated[0]?._tag === "MultiInstanceCollectionEvaluated"
          ? evaluated[0].usage.steps
          : undefined,
        5
      )
      assert.deepStrictEqual(
        BpmnKernel.replay(kernel, initialized.events),
        Result.succeed(initialized.state)
      )
    }))

  it.effect("reports a failed collection evaluation with its data-input coordinate", () =>
    Effect.gen(function*() {
      const exactBinding = binding({
        deploymentId: "multi-collection-failure"
      })
      const kernel = yield* prepare(
        collectionMultiInstanceModel(),
        exactBinding,
        [],
        {
          dataDocument: collectionDataDocument,
          collectionBindings: [{
            bindingVersion: BpmnKernel.MultiInstanceCollectionBindingVersion,
            taskNodeId: "multi",
            dataInputRef: "items",
            collectionExpression: expression("execution.items")
          }]
        }
      )
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: () => Effect.fail("private-collection-error")
        })
      ])
      const result = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (
        Result.isSuccess(result) ||
        !(result.failure instanceof Runtime.RuntimeError)
      ) {
        throw new Error("expected collection runtime error")
      }
      assert.strictEqual(result.failure.code, Runtime.Codes.EvaluatorFailed)
      assert.strictEqual(result.failure.multiInstanceActivityId, "multi")
      assert.strictEqual(
        result.failure.multiInstanceGroupId,
        "multi-instance-group:1"
      )
      assert.strictEqual(result.failure.multiInstanceGroupActivation, 0)
      assert.strictEqual(result.failure.multiInstanceDataInputRef, "items")
      assert.notInclude(
        JSON.stringify(result.failure),
        "private-collection-error"
      )
    }))

  it.effect("uses collision-free completion decisions for distinct multi-instance items", () =>
    Effect.gen(function*() {
      const exactBinding = binding({ deploymentId: "multi-completion-items" })
      const requests: Array<Evaluator.EvaluationRequest> = []
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: (request) =>
            Effect.gen(function*() {
              requests.push(request)
              yield* Effect.yieldNow
              return request.expectedResult === "non-negative-integer"
                ? { result: 2, steps: 1 }
                : { result: false, steps: requests.length }
            })
        })
      ])
      const kernel = yield* prepare(
        multiInstanceModel("parallel", expression("done-enough")),
        exactBinding
      )
      const initialized = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      )
      const members = initialized.state.tokens
        .filter((candidate) =>
          candidate.status === "active" &&
          candidate.position._tag === "AtNode" &&
          candidate.position.nodeId === "multi" &&
          candidate.invocation.branch?._tag === "MultiInstanceItem"
        )
        .sort((left, right) => {
          const leftBranch = left.invocation.branch
          const rightBranch = right.invocation.branch
          return leftBranch?._tag === "MultiInstanceItem" &&
              rightBranch?._tag === "MultiInstanceItem"
            ? leftBranch.itemIndex - rightBranch.itemIndex
            : 0
        })
      assert.strictEqual(members.length, 2)
      const first = members[0]
      const second = members[1]
      if (first === undefined || second === undefined) {
        throw new Error("expected two parallel multi-instance members")
      }
      const firstCompleted = yield* provideRegistry(
        Runtime.completeTask(
          kernel,
          initialized.state,
          {
            scopeInstanceId: first.scopeInstanceId,
            taskNodeId: "multi",
            tokenId: first.tokenId
          },
          { now }
        ),
        registry
      )
      const secondCompleted = yield* provideRegistry(
        Runtime.completeTask(
          kernel,
          firstCompleted.state,
          {
            scopeInstanceId: second.scopeInstanceId,
            taskNodeId: "multi",
            tokenId: second.tokenId
          },
          { now }
        ),
        registry
      )

      const completionRequests = requests.filter(
        (request) => request.source === "done-enough"
      )
      assert.strictEqual(completionRequests.length, 2)
      assert.deepStrictEqual(
        completionRequests.map((request) => request.expectedResult),
        ["boolean", "boolean"]
      )
      const canonicalContexts = completionRequests.map((request) => JSON.stringify(request.context))
      assert.notStrictEqual(canonicalContexts[0], canonicalContexts[1])
      assert.include(canonicalContexts[0] ?? "", "\"itemKey\":\"item:0\"")
      assert.include(canonicalContexts[1] ?? "", "\"itemKey\":\"item:1\"")
      assert.strictEqual(secondCompleted.state.status, "completed")
      assert.strictEqual(
        secondCompleted.state.multiInstanceGroups[0]?.completionReason,
        "all-completed"
      )
    }))

  it.effect("reports exact cardinality and per-item completion coordinates", () =>
    Effect.gen(function*() {
      const cardinalityBinding = binding({
        deploymentId: "multi-cardinality-failure"
      })
      const cardinalityKernel = yield* prepare(
        multiInstanceModel("parallel"),
        cardinalityBinding
      )
      const cardinalityRegistry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: cardinalityBinding,
          evaluate: () => Effect.fail("private-cardinality-error")
        })
      ])
      const cardinalityResult = yield* provideRegistry(
        initializeRuntime(cardinalityKernel, { now }),
        cardinalityRegistry
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(cardinalityResult))
      if (
        Result.isSuccess(cardinalityResult) ||
        !(cardinalityResult.failure instanceof Runtime.RuntimeError)
      ) {
        throw new Error("expected multi-instance cardinality runtime error")
      }
      assert.strictEqual(
        cardinalityResult.failure.code,
        Runtime.Codes.EvaluatorFailed
      )
      assert.strictEqual(
        cardinalityResult.failure.multiInstanceActivityId,
        "multi"
      )
      assert.strictEqual(
        cardinalityResult.failure.multiInstanceGroupId,
        "multi-instance-group:1"
      )
      assert.strictEqual(
        cardinalityResult.failure.multiInstanceGroupActivation,
        0
      )
      assert.isFalse(
        Object.prototype.hasOwnProperty.call(
          cardinalityResult.failure,
          "multiInstanceCompletedItemIndex"
        )
      )
      assert.notInclude(
        JSON.stringify(cardinalityResult.failure),
        "private-cardinality-error"
      )

      const completionBinding = binding({
        deploymentId: "multi-completion-failure"
      })
      const completionKernel = yield* prepare(
        multiInstanceModel("parallel", expression("done-enough")),
        completionBinding
      )
      const completionRegistry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: completionBinding,
          evaluate: (request) =>
            request.expectedResult === "non-negative-integer"
              ? Effect.succeed({ result: 2, steps: 1 })
              : Effect.fail("private-completion-error")
        })
      ])
      const initialized = yield* provideRegistry(
        initializeRuntime(completionKernel, { now }),
        completionRegistry
      )
      const token = initialized.state.tokens.find((candidate) =>
        candidate.status === "active" &&
        candidate.position._tag === "AtNode" &&
        candidate.position.nodeId === "multi" &&
        candidate.invocation.branch?._tag === "MultiInstanceItem" &&
        candidate.invocation.branch.itemIndex === 0
      )
      if (token === undefined) {
        throw new Error("expected first multi-instance member")
      }
      const completionResult = yield* provideRegistry(
        Runtime.completeTask(
          completionKernel,
          initialized.state,
          {
            scopeInstanceId: token.scopeInstanceId,
            taskNodeId: "multi",
            tokenId: token.tokenId
          },
          { now }
        ),
        completionRegistry
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(completionResult))
      if (
        Result.isSuccess(completionResult) ||
        !(completionResult.failure instanceof Runtime.RuntimeError)
      ) {
        throw new Error("expected multi-instance completion runtime error")
      }
      assert.strictEqual(
        completionResult.failure.code,
        Runtime.Codes.EvaluatorFailed
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceActivityId,
        "multi"
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceGroupId,
        "multi-instance-group:1"
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceGroupActivation,
        0
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceCompletedItemIndex,
        0
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceCompletedItemKey,
        "item:0"
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceLoopCounter,
        0
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceNumberOfInstances,
        2
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceNumberOfActiveInstances,
        1
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceNumberOfCompletedInstances,
        1
      )
      assert.strictEqual(
        completionResult.failure.multiInstanceNumberOfTerminatedInstances,
        0
      )
      assert.notInclude(
        JSON.stringify(completionResult.failure),
        "private-completion-error"
      )
    }))

  it.effect("resolves a protocol-v3 loop task through an asynchronous after condition", () =>
    Effect.gen(function*() {
      const exactBinding = binding({ deploymentId: "loop-resolve-task" })
      const kernel = yield* prepare(
        standardLoopModel(false),
        exactBinding,
        [taskBinding("loop")]
      )
      let calls = 0
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: () =>
            Effect.gen(function*() {
              calls++
              yield* Effect.yieldNow
              return { result: false, steps: 2 }
            })
        })
      ])
      const initialized = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      )
      assert.strictEqual(calls, 0)
      const token = initialized.state.tokens.find((candidate) =>
        candidate.status === "active" &&
        candidate.position._tag === "AtNode" &&
        candidate.position.nodeId === "loop"
      )
      if (token === undefined) {
        throw new Error("expected protocol-v3 loop task token")
      }
      const outcome = succeededOutcome()
      const resolved = yield* provideRegistry(
        Runtime.resolveTask(
          kernel,
          initialized.state,
          {
            commandVersion: BpmnActivityV3.CommandVersion,
            scopeInstanceId: token.scopeInstanceId,
            taskNodeId: "loop",
            tokenId: token.tokenId,
            outcome
          },
          { now }
        ),
        registry
      )

      assert.strictEqual(calls, 1)
      assert.strictEqual(resolved.state.status, "completed")
      assert.deepStrictEqual(
        resolved.state.activityResolutions[0]?.outcome,
        outcome
      )
      assert.strictEqual(
        resolved.events.filter((event) => event._tag === "TaskOutcomeAccepted")
          .length,
        1
      )
      const evaluated = resolved.events.find(
        (event) => event._tag === "LoopConditionEvaluated"
      )
      assert.strictEqual(evaluated?._tag, "LoopConditionEvaluated")
      if (evaluated?._tag === "LoopConditionEvaluated") {
        assert.strictEqual(evaluated.frameId, "loop-frame:1")
        assert.strictEqual(evaluated.activityId, "loop")
        assert.strictEqual(evaluated.activation, 0)
        assert.strictEqual(evaluated.phase, "after")
        assert.strictEqual(evaluated.iteration, 0)
        assert.isFalse(evaluated.result)
      }
    }))

  it.effect("reports complete standard-loop coordinates for evaluator errors and timeouts", () =>
    Effect.gen(function*() {
      const assertLoopFailure = (
        failure: Runtime.RuntimeError,
        code: Runtime.Code
      ): void => {
        assert.strictEqual(failure.operation, "initialize")
        assert.strictEqual(failure.code, code)
        assert.strictEqual(failure.ordinal, 0)
        assert.isFalse(
          Object.prototype.hasOwnProperty.call(failure, "sequenceFlowId")
        )
        assert.strictEqual(failure.loopActivityId, "loop")
        assert.strictEqual(failure.loopFrameId, "loop-frame:1")
        assert.strictEqual(failure.loopActivation, 0)
        assert.strictEqual(failure.loopPhase, "before")
        assert.strictEqual(failure.loopIteration, 0)
      }

      const failedBinding = binding({ deploymentId: "loop-failure" })
      const failedKernel = yield* prepare(
        standardLoopModel(true),
        failedBinding
      )
      const failedRegistry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: failedBinding,
          evaluate: () => Effect.fail({ private: "not-portable" })
        })
      ])
      const failedResult = yield* provideRegistry(
        initializeRuntime(failedKernel, { now }),
        failedRegistry
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(failedResult))
      if (Result.isSuccess(failedResult)) {
        throw new Error("expected loop evaluator failure")
      }
      assert.instanceOf(failedResult.failure, Runtime.RuntimeError)
      if (!(failedResult.failure instanceof Runtime.RuntimeError)) {
        throw new Error("expected expression runtime error")
      }
      assertLoopFailure(failedResult.failure, Runtime.Codes.EvaluatorFailed)
      assert.notInclude(JSON.stringify(failedResult.failure), "not-portable")

      const timeoutBinding = binding({
        deploymentId: "loop-timeout",
        timeoutMillis: 10
      })
      const timeoutKernel = yield* prepare(
        standardLoopModel(true),
        timeoutBinding
      )
      const timeoutRegistry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: timeoutBinding,
          evaluate: () => Effect.never
        })
      ])
      const fiber = yield* provideRegistry(
        initializeRuntime(timeoutKernel, { now }),
        timeoutRegistry
      ).pipe(Effect.result, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      const timeoutResult = yield* Fiber.join(fiber)
      assert.isTrue(Result.isFailure(timeoutResult))
      if (Result.isSuccess(timeoutResult)) {
        throw new Error("expected loop evaluator timeout")
      }
      assert.instanceOf(timeoutResult.failure, Runtime.RuntimeError)
      if (!(timeoutResult.failure instanceof Runtime.RuntimeError)) {
        throw new Error("expected expression runtime error")
      }
      assertLoopFailure(
        timeoutResult.failure,
        Runtime.Codes.EvaluationTimedOut
      )
    }))

  it.effect("fails when the complete compiled binding is absent", () =>
    Effect.gen(function*() {
      const kernel = yield* prepare(gatewayModel(), binding())
      const registry = yield* Evaluator.makeMemory([])
      const result = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isSuccess(result)) {
        throw new Error("expected missing evaluator failure")
      }
      const failure = result.failure
      assert.instanceOf(failure, Runtime.RuntimeError)
      if (!(failure instanceof Runtime.RuntimeError)) {
        throw new Error("expected expression runtime error")
      }
      assert.strictEqual(
        failure.code,
        Runtime.Codes.EvaluatorResolutionFailed
      )
      assert.strictEqual(failure.sequenceFlowId, "flow-one")
    }))

  it.effect("normalizes evaluator failures, defects, invalid output, and step overflow", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly code: Runtime.Code
        readonly exactBinding: BpmnExpression.EvaluatorBinding
        readonly evaluate: Evaluator.EvaluatorHandler<unknown>
      }> = [
        {
          code: Runtime.Codes.EvaluatorFailed,
          exactBinding: binding({ deploymentId: "typed-failure" }),
          evaluate: () => Effect.fail({ secret: "typed-secret" })
        },
        {
          code: Runtime.Codes.EvaluatorDefect,
          exactBinding: binding({ deploymentId: "defect" }),
          evaluate: () => Effect.die({ secret: "defect-secret" })
        },
        {
          code: Runtime.Codes.InvalidEvaluationResult,
          exactBinding: binding({ deploymentId: "invalid-output" }),
          evaluate: () =>
            Effect.succeed({
              result: true,
              steps: 1,
              extra: "not-allowed"
            } as unknown as Evaluator.EvaluationResult)
        },
        {
          code: Runtime.Codes.EvaluationStepLimitExceeded,
          exactBinding: binding({
            deploymentId: "step-overflow",
            maxSteps: 1
          }),
          evaluate: () => Effect.succeed({ result: true, steps: 2 })
        }
      ]

      for (const testCase of cases) {
        const kernel = yield* prepare(
          gatewayModel(),
          testCase.exactBinding
        )
        const registry = yield* Evaluator.makeMemory([
          Evaluator.makeDefinition({
            binding: testCase.exactBinding,
            evaluate: testCase.evaluate
          })
        ])
        const result = yield* provideRegistry(
          initializeRuntime(kernel, { now }),
          registry
        ).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isSuccess(result)) {
          throw new Error(`expected '${testCase.code}' failure`)
        }
        const failure = result.failure
        assert.instanceOf(failure, Runtime.RuntimeError)
        if (!(failure instanceof Runtime.RuntimeError)) {
          throw new Error("expected expression runtime error")
        }
        assert.strictEqual(failure.code, testCase.code)
        assert.notInclude(JSON.stringify(failure), "secret")
      }
    }))

  it.effect("preserves evaluator interruption as Effect interruption", () =>
    Effect.gen(function*() {
      const exactBinding = binding({ deploymentId: "interrupted" })
      const kernel = yield* prepare(gatewayModel(), exactBinding)
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: () => Effect.interrupt
        })
      ])
      const exit = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      ).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterrupts(exit.cause))
      }
    }))

  it.effect("applies the exact binding timeout", () =>
    Effect.gen(function*() {
      const exactBinding = binding({
        deploymentId: "timeout",
        timeoutMillis: 10
      })
      const kernel = yield* prepare(gatewayModel(), exactBinding)
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: () => Effect.never
        })
      ])
      const fiber = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      ).pipe(Effect.result, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      const result = yield* Fiber.join(fiber)

      assert.isTrue(Result.isFailure(result))
      if (Result.isSuccess(result)) {
        throw new Error("expected timeout failure")
      }
      const failure = result.failure
      assert.instanceOf(failure, Runtime.RuntimeError)
      if (!(failure instanceof Runtime.RuntimeError)) {
        throw new Error("expected expression runtime error")
      }
      assert.strictEqual(
        failure.code,
        Runtime.Codes.EvaluationTimedOut
      )
    }))

  it.effect("evaluates multiple conditions once and exposes no duplicate committed prefix", () =>
    Effect.gen(function*() {
      const exactBinding = binding()
      const kernel = yield* prepare(taskModel(), exactBinding)
      const calls: Array<string> = []
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: (request) =>
            Effect.sync(() => {
              calls.push(request.source)
              return { result: false, steps: calls.length }
            })
        })
      ])
      const initialized = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      )
      const token = initialized.state.tokens.find((candidate) =>
        candidate.status === "active" &&
        candidate.position._tag === "AtNode" &&
        candidate.position.nodeId === "decide"
      )
      if (token === undefined) {
        throw new Error("expected decision task token")
      }
      const completed = yield* provideRegistry(
        Runtime.completeTask(
          kernel,
          initialized.state,
          {
            scopeInstanceId: token.scopeInstanceId,
            taskNodeId: "decide",
            tokenId: token.tokenId
          },
          { now }
        ),
        registry
      )

      assert.deepStrictEqual(calls, ["one", "two"])
      assert.deepStrictEqual(activeNodeIds(completed), ["task-default"])
      const conditions = completed.events.filter((event) => event._tag === "ConditionEvaluated")
      assert.deepStrictEqual(
        conditions.map((event) =>
          event._tag === "ConditionEvaluated"
            ? event.sequenceFlowId
            : ""
        ),
        ["flow-one", "flow-two"]
      )
      assert.strictEqual(
        new Set(conditions.map((event) =>
          event._tag === "ConditionEvaluated"
            ? event.sequenceFlowId
            : ""
        )).size,
        conditions.length
      )
    }))

  it.effect("does not call evaluators on initialize and advance paths without conditions", () =>
    Effect.gen(function*() {
      const exactBinding = binding()
      const kernel = yield* prepare(straightModel(), exactBinding)
      let calls = 0
      const registry = yield* Evaluator.makeMemory([
        Evaluator.makeDefinition({
          binding: exactBinding,
          evaluate: () =>
            Effect.sync(() => {
              calls++
              return { result: true, steps: 1 }
            })
        })
      ])
      const initialized = yield* provideRegistry(
        initializeRuntime(kernel, { now }),
        registry
      )
      const advanced = yield* provideRegistry(
        Runtime.advance(kernel, initialized.state, { now }),
        registry
      )

      assert.strictEqual(calls, 0)
      assert.deepStrictEqual(activeNodeIds(initialized), ["wait"])
      assert.deepStrictEqual(activeNodeIds(advanced), ["wait"])
      assert.deepStrictEqual(advanced.events, [])
    }))

  it.effect("rejects a structurally valid but forged registry service", () =>
    Effect.gen(function*() {
      const exactBinding = binding()
      const kernel = yield* prepare(gatewayModel(), exactBinding)
      const definition = Evaluator.makeDefinition({
        binding: exactBinding,
        evaluate: () => Effect.succeed({ result: true, steps: 1 })
      })
      const forged = Evaluator.EvaluatorRegistry.of({
        size: 1,
        resolve: () => Effect.succeed(definition)
      })
      const result = yield* Effect.provideService(
        initializeRuntime(kernel, { now }),
        Evaluator.EvaluatorRegistry,
        forged
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isSuccess(result)) {
        throw new Error("expected forged-registry failure")
      }
      const failure = result.failure
      assert.instanceOf(failure, Runtime.RuntimeError)
      if (!(failure instanceof Runtime.RuntimeError)) {
        throw new Error("expected expression runtime error")
      }
      assert.strictEqual(
        failure.code,
        Runtime.Codes.InvalidEvaluatorRegistry
      )
    }))
})
