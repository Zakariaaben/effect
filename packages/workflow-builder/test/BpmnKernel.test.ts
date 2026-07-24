import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnActivityV3 from "../src/BpmnActivityV3.ts"
import * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const processId = "process-main"

const now = "2026-07-23T10:00:00.000Z" as const

const emptyExtensions = (): Array<BpmnModel.ExtensionElement> => []

const expression = (source: string): BpmnModel.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const services = (
  decisions: Readonly<Record<string, boolean>> = {}
): BpmnKernel.Services => ({
  now,
  evaluateExpression: ({ expression }) =>
    Result.succeed({
      result: decisions[expression.source] ?? false,
      steps: 1
    })
})

const limits: BpmnKernel.KernelLimits = {
  maxAutomaticTransitions: 1_000,
  maxExecutionInputCanonicalBytes: 1_048_576,
  maxMultiInstanceCardinality: 128,
  maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
  maxMultiInstanceItemCanonicalBytes: 262_144,
  maxMultiInstanceOutputCanonicalBytes: 1_048_576,
  maxMultiInstanceItemOutputCanonicalBytes: 262_144
}

const initializeCommand = {
  commandVersion: BpmnKernel.InitializeCommandVersion,
  input: null
} as const

const initializeKernel = (
  kernel: BpmnKernel.CompiledKernel,
  runtime: BpmnKernel.Services
): ReturnType<typeof BpmnKernel.initialize> => BpmnKernel.initialize(kernel, initializeCommand, runtime)

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const evaluatorBuildDigest = Schema.decodeUnknownSync(
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
const failedActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"e".repeat(64)}`)
const classificationActivityDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.OperationDigest
)(`sha256:${"f".repeat(64)}`)
const semanticNodeId = Schema.decodeUnknownSync(
  ProtocolV3Wire.AtomicIdentifier
)("semantic-task")

const taskBinding = (
  taskNodeId: string,
  errorMappings: ReadonlyArray<{
    readonly errorTag: string
    readonly errorCode?: string | null
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
        errorCode: mapping.errorCode ?? null
      },
      errorRef: mapping.errorRef
    }))
  })

const succeededOutcome = (
  overrides: Partial<BpmnActivityV3.TaskSucceeded> = {}
): BpmnActivityV3.TaskSucceeded =>
  Schema.decodeUnknownSync(BpmnActivityV3.TaskSucceeded)({
    _tag: "Succeeded",
    outcomeVersion: BpmnActivityV3.OutcomeVersion,
    artifactDigest,
    semanticNodeId,
    occurrenceDigest,
    firstActivityDigest,
    attempt: 2,
    completedActivityDigest,
    output: {
      _tag: "Inline",
      value: null
    },
    ...overrides
  })

const failedOutcome = (
  errorTag: string,
  errorCode: string | null = null,
  overrides: Partial<BpmnActivityV3.TaskBusinessFailed> = {}
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
    attempt: 2,
    identity: {
      failureIdentityVersion: 1,
      errorTag,
      errorCode
    },
    ...overrides
  })

const evaluatorBindings = (
  value: BpmnModel.BpmnModel
): ReadonlyArray<BpmnExpression.EvaluatorBinding> => {
  const unique = new Map<string, BpmnModel.Expression>()
  for (const sequenceFlow of value.sequenceFlows) {
    if (sequenceFlow.condition !== undefined) {
      unique.set(
        JSON.stringify([
          sequenceFlow.condition.language,
          sequenceFlow.condition.version
        ]),
        sequenceFlow.condition
      )
    }
  }
  for (const node of value.flowNodes) {
    if (
      node._tag === "Task" &&
      node.loopCharacteristics?._tag === "StandardLoopCharacteristics" &&
      node.loopCharacteristics.condition !== undefined &&
      node.loopCharacteristics.loopMaximum !== undefined
    ) {
      const condition = node.loopCharacteristics.condition
      unique.set(
        JSON.stringify([condition.language, condition.version]),
        condition
      )
    }
  }
  return [...unique.values()].map((candidate) => ({
    language: candidate.language,
    languageVersion: candidate.version,
    build: {
      id: "test-evaluator",
      version: "1.0.0",
      deploymentId: "test-deployment",
      buildDigest: evaluatorBuildDigest
    },
    limits: {
      maxSourceUtf8Bytes: 4_096,
      maxContextCanonicalBytes: 1_048_576,
      maxSteps: 10_000,
      timeoutMillis: 1_000
    }
  }))
}

const process = (): BpmnModel.Process => ({
  id: processId,
  isExecutable: true,
  extensionElements: emptyExtensions()
})

const model = (
  flowNodes: ReadonlyArray<BpmnModel.FlowNode>,
  sequenceFlows: ReadonlyArray<BpmnModel.SequenceFlow>,
  options: { readonly addScopeEnds?: boolean } = {}
): BpmnModel.BpmnModel => {
  const nodes = [...flowNodes]
  const flows = [...sequenceFlows]
  if (options.addScopeEnds !== false) {
    const scopeIds = new Set(
      nodes
        .filter((node) => node._tag === "StartEvent")
        .map((node) => node.parentScopeId)
    )
    for (const scopeId of scopeIds) {
      if (nodes.some((node) => node.parentScopeId === scopeId && node._tag === "EndEvent")) {
        continue
      }
      const startIndex = nodes.findIndex((node) => node.parentScopeId === scopeId && node._tag === "StartEvent")
      const start = nodes[startIndex] as BpmnModel.StartEvent
      const endId = `__fixture-end-${scopeId}`
      const flowId = `__fixture-flow-end-${scopeId}`
      nodes[startIndex] = {
        ...start,
        outgoingSequenceFlowIds: [...start.outgoingSequenceFlowIds, flowId]
      }
      nodes.push({
        _tag: "EndEvent",
        id: endId,
        processId: start.processId,
        parentScopeId: scopeId,
        incomingSequenceFlowIds: [flowId],
        outgoingSequenceFlowIds: [],
        eventDefinitions: [],
        eventDefinitionRefs: [],
        extensionElements: emptyExtensions()
      })
      flows.push({
        id: flowId,
        processId: start.processId,
        parentScopeId: scopeId,
        sourceId: start.id,
        targetId: endId,
        kind: "normal",
        extensionElements: emptyExtensions()
      })
    }
  }
  return {
    modelKind: "BpmnModel",
    modelVersion: BpmnModel.BpmnModelVersion,
    bpmnSpecVersion: "2.0.2",
    imports: [],
    extensionElements: [],
    collaborations: [],
    processes: [process()],
    flowNodes: nodes,
    sequenceFlows: flows
  }
}

const startEvent = (
  id: string,
  parentScopeId: string,
  outgoingSequenceFlowIds: ReadonlyArray<string>,
  eventDefinitions: ReadonlyArray<BpmnModel.EventDefinition> = [],
  eventDefinitionRefs: ReadonlyArray<string> = []
): BpmnModel.StartEvent => ({
  _tag: "StartEvent",
  id,
  processId,
  parentScopeId,
  incomingSequenceFlowIds: [],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  eventDefinitions: [...eventDefinitions],
  eventDefinitionRefs: [...eventDefinitionRefs],
  extensionElements: emptyExtensions()
})

const endEvent = (
  id: string,
  parentScopeId: string,
  incomingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.EndEvent => ({
  _tag: "EndEvent",
  id,
  processId,
  parentScopeId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [],
  eventDefinitions: [],
  eventDefinitionRefs: [],
  extensionElements: emptyExtensions()
})

const task = (
  id: string,
  parentScopeId: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>,
  overrides?: Partial<BpmnModel.Task>
): BpmnModel.Task => ({
  _tag: "Task",
  id,
  processId,
  parentScopeId,
  taskKind: "generic",
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: emptyExtensions(),
  ...overrides
})

const boundaryError = (
  id: string,
  attachedToRef: string,
  outgoingSequenceFlowId: string,
  errorRef?: string,
  overrides?: Partial<BpmnModel.BoundaryEvent>
): BpmnModel.BoundaryEvent => ({
  _tag: "BoundaryEvent",
  id,
  processId,
  parentScopeId: processId,
  incomingSequenceFlowIds: [],
  outgoingSequenceFlowIds: [outgoingSequenceFlowId],
  eventDefinitions: [{
    _tag: "ErrorEventDefinition",
    ...(errorRef === undefined ? {} : { errorRef })
  }],
  eventDefinitionRefs: [],
  attachedToRef,
  cancelActivity: true,
  extensionElements: emptyExtensions(),
  ...overrides
})

const subProcess = (
  id: string,
  parentScopeId: string,
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>
): BpmnModel.SubProcess => ({
  _tag: "SubProcess",
  id,
  processId,
  parentScopeId,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: emptyExtensions()
})

const gateway = (
  id: string,
  gatewayKind: BpmnModel.Gateway["gatewayKind"],
  gatewayDirection: BpmnModel.Gateway["gatewayDirection"],
  incomingSequenceFlowIds: ReadonlyArray<string>,
  outgoingSequenceFlowIds: ReadonlyArray<string>,
  overrides?: Partial<BpmnModel.Gateway>
): BpmnModel.Gateway => ({
  _tag: "Gateway",
  id,
  processId,
  parentScopeId: processId,
  gatewayKind,
  gatewayDirection,
  incomingSequenceFlowIds: [...incomingSequenceFlowIds],
  outgoingSequenceFlowIds: [...outgoingSequenceFlowIds],
  extensionElements: emptyExtensions(),
  ...overrides
})

const flow = (
  id: string,
  parentScopeId: string,
  sourceId: string,
  targetId: string,
  kind: BpmnModel.SequenceFlow["kind"],
  overrides?: Partial<BpmnModel.SequenceFlow>
): BpmnModel.SequenceFlow => ({
  id,
  processId,
  parentScopeId,
  sourceId,
  targetId,
  kind,
  extensionElements: emptyExtensions(),
  ...overrides
})

const standardLoopModel = (
  testBefore: boolean,
  loopMaximum: number | undefined,
  condition: BpmnModel.Expression | null = expression("repeat")
): BpmnModel.BpmnModel =>
  model(
    [
      startEvent("start-loop", processId, ["flow-start-loop"]),
      task("task-loop", processId, ["flow-start-loop"], ["flow-loop-end"], {
        loopCharacteristics: {
          _tag: "StandardLoopCharacteristics",
          testBefore,
          ...(condition === null ? {} : { condition }),
          ...(loopMaximum === undefined ? {} : { loopMaximum })
        }
      }),
      endEvent("end-loop", processId, ["flow-loop-end"])
    ],
    [
      flow(
        "flow-start-loop",
        processId,
        "start-loop",
        "task-loop",
        "normal"
      ),
      flow(
        "flow-loop-end",
        processId,
        "task-loop",
        "end-loop",
        "normal"
      )
    ],
    { addScopeEnds: false }
  )

const prepareResult = (
  value: BpmnModel.BpmnModel,
  selectedLimits: BpmnKernel.KernelLimits = limits,
  profileId = "test-bpmn-model-v1",
  selectedEvaluatorBindings = evaluatorBindings(value),
  selectedTaskBindings?: ReadonlyArray<BpmnActivityV3.TaskBinding>
): Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnKernel.prepare(value, {
      profileId,
      rootProcessId: processId,
      limits: selectedLimits,
      evaluatorBindings: selectedEvaluatorBindings,
      ...(selectedTaskBindings === undefined
        ? {}
        : { taskBindings: selectedTaskBindings })
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError>

const compile = (
  value: BpmnModel.BpmnModel,
  selectedTaskBindings?: ReadonlyArray<BpmnActivityV3.TaskBinding>
): BpmnKernel.CompiledKernel => {
  const compiled = prepareResult(
    value,
    limits,
    "test-bpmn-model-v1",
    evaluatorBindings(value),
    selectedTaskBindings
  )
  if (Result.isFailure(compiled)) {
    throw new Error(JSON.stringify(
      compiled.failure.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path
      })),
      null,
      2
    ))
  }
  return compiled.success
}

const activeNodeIds = (
  state: BpmnExecutionState.BpmnExecutionState
): ReadonlyArray<string> =>
  state.tokens
    .filter((token) => token.status === "active" && token.position._tag === "AtNode")
    .map((token) => token.position.nodeId)

describe("BpmnKernel", () => {
  it("initializes start fan-out directly into stable task waits", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-left", "flow-start-right"]),
        task("task-left", processId, ["flow-start-left"], []),
        task("task-right", processId, ["flow-start-right"], [])
      ],
      [
        flow("flow-start-left", processId, "start", "task-left", "normal", { isImmediate: true }),
        flow("flow-start-right", processId, "start", "task-right", "normal", { isImmediate: true })
      ]
    ))

    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    assert.deepStrictEqual(activeNodeIds(initialized.success.state).sort(), ["task-left", "task-right"])
    assert.deepStrictEqual(
      initialized.success.state.tokens.filter((token) =>
        token.status === "active" && token.position._tag === "OnSequenceFlow"
      ),
      []
    )
  })

  it("resolves a protocol-v3-bound task success and replays the exact durable outcome", () => {
    const definition = model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], ["flow-task-end"]),
        endEvent("end", processId, ["flow-task-end"])
      ],
      [
        flow("flow-start-task", processId, "start", "task", "normal"),
        flow("flow-task-end", processId, "task", "end", "normal")
      ]
    )
    const binding = taskBinding("task")
    const compiled = compile(definition, [binding])
    const resolvedBinding = BpmnKernel.taskBinding(compiled, "task")
    assert(Result.isSuccess(resolvedBinding))
    assert.deepStrictEqual(resolvedBinding.success, binding)
    const copiedKernelBinding = BpmnKernel.taskBinding(
      { ...compiled },
      "task"
    )
    assert(Result.isFailure(copiedKernelBinding))
    assert(
      copiedKernelBinding.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidKernel)
    )
    const missingBinding = BpmnKernel.taskBinding(compiled, "missing")
    assert(Result.isFailure(missingBinding))
    assert(
      missingBinding.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidCommand)
    )
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task"
    )
    if (token === undefined) {
      throw new Error("expected bound task token")
    }

    const legacyCompletion = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task",
        tokenId: token.tokenId
      },
      services()
    )
    assert(Result.isFailure(legacyCompletion))
    assert(
      legacyCompletion.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidCommand)
    )

    const outcome = succeededOutcome()
    const command: BpmnKernel.ResolveTaskCommand = {
      commandVersion: BpmnActivityV3.CommandVersion,
      scopeInstanceId: token.scopeInstanceId,
      taskNodeId: "task",
      tokenId: token.tokenId,
      outcome
    }
    const resolved = BpmnKernel.resolveTask(
      compiled,
      initialized.success.state,
      command,
      services()
    )
    assert(Result.isSuccess(resolved))
    assert.strictEqual(resolved.success.state.status, "completed")
    assert.deepStrictEqual(resolved.success.state.activityResolutions, [{
      resolutionVersion: BpmnActivityV3.ResolutionVersion,
      tokenId: token.tokenId,
      taskNodeId: "task",
      scopeInstanceId: token.scopeInstanceId,
      outcome,
      resolvedAt: now
    }])
    assert(
      resolved.success.events.some((event) =>
        event._tag === "TokenConsumed" &&
        event.tokenId === token.tokenId &&
        event.reason === "task-succeeded"
      )
    )

    const missingResolution = structuredClone(resolved.success.state)
    missingResolution.activityResolutions = []
    const rejectedMissingResolution = BpmnKernel.advance(
      compiled,
      missingResolution,
      services()
    )
    assert(Result.isFailure(rejectedMissingResolution))
    assert(
      rejectedMissingResolution.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.InvalidKernelState &&
        diagnostic.message.includes("successful activity resolution")
      )
    )

    const journal = [
      ...initialized.success.events,
      ...resolved.success.events
    ]
    const replayedState = BpmnKernel.replay(compiled, journal)
    assert(Result.isSuccess(replayedState))
    assert.deepStrictEqual(replayedState.success, resolved.success.state)
    const forgedLegacyReplay = BpmnKernel.replay(compiled, [
      ...journal,
      {
        _tag: "TaskCompletionReplayed",
        tokenId: token.tokenId,
        observedAt: now
      }
    ])
    assert(Result.isFailure(forgedLegacyReplay))
    assert(
      forgedLegacyReplay.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.InvalidTransitionJournal
      )
    )

    const replayedOutcome = BpmnKernel.resolveTask(
      compiled,
      resolved.success.state,
      command,
      services()
    )
    assert(Result.isSuccess(replayedOutcome))
    assert.deepStrictEqual(replayedOutcome.success.events, [{
      _tag: "TaskOutcomeReplayed",
      tokenId: token.tokenId,
      occurrenceDigest,
      observedAt: now
    }])

    const conflictingOutcome = BpmnKernel.resolveTask(
      compiled,
      resolved.success.state,
      {
        ...command,
        outcome: succeededOutcome({ attempt: 3 })
      },
      services()
    )
    assert(Result.isFailure(conflictingOutcome))
    assert(
      conflictingOutcome.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidCommand)
    )
  })

  it("catches an exactly mapped business failure at one interrupting Boundary Error and replays it", () => {
    const errorRef = "error-validation"
    const definition: BpmnModel.BpmnModel = {
      ...model(
        [
          startEvent("start", processId, ["flow-start-task"]),
          task("task", processId, ["flow-start-task"], ["flow-task-success"]),
          boundaryError("boundary-error", "task", "flow-error-end", errorRef),
          endEvent("end-success", processId, ["flow-task-success"]),
          endEvent("end-error", processId, ["flow-error-end"])
        ],
        [
          flow("flow-start-task", processId, "start", "task", "normal"),
          flow("flow-task-success", processId, "task", "end-success", "normal"),
          flow("flow-error-end", processId, "boundary-error", "end-error", "normal")
        ]
      ),
      errors: [{ id: errorRef, errorCode: "VALIDATION" }]
    }
    const binding = taskBinding("task", [{
      errorTag: "ValidationError",
      errorCode: "E_VALIDATION",
      errorRef
    }])
    const compiled = compile(definition, [binding])
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task"
    )
    if (token === undefined) {
      throw new Error("expected bound task token")
    }
    const outcome = failedOutcome("ValidationError", "E_VALIDATION")
    const resolved = BpmnKernel.resolveTask(
      compiled,
      initialized.success.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task",
        tokenId: token.tokenId,
        outcome
      },
      services()
    )

    assert(Result.isSuccess(resolved))
    assert.strictEqual(resolved.success.state.status, "completed")
    assert.strictEqual(
      resolved.success.state.tokens.find((candidate) => candidate.tokenId === token.tokenId)?.status,
      "withdrawn"
    )
    assert(
      resolved.success.events.some((event) =>
        event._tag === "BoundaryErrorCaught" &&
        event.taskNodeId === "task" &&
        event.boundaryEventId === "boundary-error" &&
        event.errorRef === errorRef
      )
    )
    assert.isFalse(
      resolved.success.events.some((event) => event._tag === "ExecutionFailed")
    )
    const replayed = BpmnKernel.replay(compiled, [
      ...initialized.success.events,
      ...resolved.success.events
    ])
    assert(Result.isSuccess(replayed))
    assert.deepStrictEqual(replayed.success, resolved.success.state)

    const forgedUnmappedCatch = structuredClone(resolved.success.state)
    const forgedOutcome = forgedUnmappedCatch.activityResolutions[0]?.outcome
    if (forgedOutcome?._tag !== "BusinessFailed") {
      throw new Error("expected durable business-failure resolution")
    }
    forgedOutcome.identity.errorTag = "OtherError"
    const rejectedForgery = BpmnKernel.advance(
      compiled,
      forgedUnmappedCatch,
      services()
    )
    assert(Result.isFailure(rejectedForgery))
    assert(
      rejectedForgery.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidKernelState)
    )
  })

  it("keeps an unmapped business failure terminal even when the Boundary Error is catch-all", () => {
    const mappedErrorRef = "error-mapped"
    const definition: BpmnModel.BpmnModel = {
      ...model(
        [
          startEvent("start", processId, ["flow-start-task"]),
          task("task", processId, ["flow-start-task"], ["flow-task-success"]),
          boundaryError("boundary-catch-all", "task", "flow-error-end"),
          endEvent("end-success", processId, ["flow-task-success"]),
          endEvent("end-error", processId, ["flow-error-end"])
        ],
        [
          flow("flow-start-task", processId, "start", "task", "normal"),
          flow("flow-task-success", processId, "task", "end-success", "normal"),
          flow("flow-error-end", processId, "boundary-catch-all", "end-error", "normal")
        ]
      ),
      errors: [{ id: mappedErrorRef }]
    }
    const compiled = compile(definition, [
      taskBinding("task", [{
        errorTag: "MappedError",
        errorRef: mappedErrorRef
      }])
    ])
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task"
    )
    if (token === undefined) {
      throw new Error("expected bound task token")
    }
    const resolved = BpmnKernel.resolveTask(
      compiled,
      initialized.success.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task",
        tokenId: token.tokenId,
        outcome: failedOutcome("UnmappedError")
      },
      services()
    )

    assert(Result.isSuccess(resolved))
    assert.strictEqual(resolved.success.state.status, "failed")
    assert.isFalse(
      resolved.success.events.some((event) => event._tag === "BoundaryErrorCaught")
    )
    assert(
      resolved.success.events.some((event) =>
        event._tag === "ExecutionFailed" &&
        event.failureKind === "UnmappedBusinessFailure" &&
        event.taskNodeId === "task"
      )
    )
    assert(
      resolved.success.state.scopeInstances.every((scope) => scope.status === "failed" || scope.status === "cancelled")
    )
    assert(
      resolved.success.state.tokens.every((candidate) => candidate.status !== "active")
    )
    const replayed = BpmnKernel.replay(compiled, [
      ...initialized.success.events,
      ...resolved.success.events
    ])
    assert(Result.isSuccess(replayed))
    assert.deepStrictEqual(replayed.success, resolved.success.state)
  })

  it("fails a mapped but uncaught BPMN Error and keeps near-match error codes unmapped", () => {
    const mappedErrorRef = "error-validation"
    const otherErrorRef = "error-other"
    const definition: BpmnModel.BpmnModel = {
      ...model(
        [
          startEvent("start", processId, ["flow-start-task"]),
          task("task", processId, ["flow-start-task"], ["flow-task-success"]),
          boundaryError(
            "boundary-other",
            "task",
            "flow-other-end",
            otherErrorRef
          ),
          endEvent("end-success", processId, ["flow-task-success"]),
          endEvent("end-other", processId, ["flow-other-end"])
        ],
        [
          flow("flow-start-task", processId, "start", "task", "normal"),
          flow("flow-task-success", processId, "task", "end-success", "normal"),
          flow("flow-other-end", processId, "boundary-other", "end-other", "normal")
        ]
      ),
      errors: [{ id: mappedErrorRef }, { id: otherErrorRef }]
    }
    const compiled = compile(definition, [
      taskBinding("task", [{
        errorTag: "ValidationError",
        errorCode: "E_VALIDATION",
        errorRef: mappedErrorRef
      }])
    ])

    const resolveFailure = (
      errorCode: string
    ): {
      readonly initialized: BpmnKernel.TransitionBatch
      readonly resolved: BpmnKernel.TransitionBatch
    } => {
      const initialized = initializeKernel(compiled, services())
      assert(Result.isSuccess(initialized))
      const token = initialized.success.state.tokens.find((candidate) =>
        candidate.status === "active" &&
        candidate.position._tag === "AtNode" &&
        candidate.position.nodeId === "task"
      )
      if (token === undefined) {
        throw new Error("expected bound task token")
      }
      const resolved = BpmnKernel.resolveTask(
        compiled,
        initialized.success.state,
        {
          commandVersion: BpmnActivityV3.CommandVersion,
          scopeInstanceId: token.scopeInstanceId,
          taskNodeId: "task",
          tokenId: token.tokenId,
          outcome: failedOutcome("ValidationError", errorCode)
        },
        services()
      )
      assert(Result.isSuccess(resolved))
      return {
        initialized: initialized.success,
        resolved: resolved.success
      }
    }

    const uncaught = resolveFailure("E_VALIDATION")
    assert.strictEqual(uncaught.resolved.state.status, "failed")
    assert(
      uncaught.resolved.events.some((event) =>
        event._tag === "ExecutionFailed" &&
        event.failureKind === "UncaughtBpmnError" &&
        event.errorRef === mappedErrorRef
      )
    )
    assert(
      uncaught.resolved.events.some((event) =>
        event._tag === "TokenWithdrawn" &&
        event.reason === "uncaught-bpmn-error"
      )
    )
    assert(
      uncaught.resolved.state.tokens.every((token) => token.status !== "active")
    )
    assert(
      uncaught.resolved.state.scopeInstances.every((scope) => scope.status !== "active")
    )
    const uncaughtReplay = BpmnKernel.replay(compiled, [
      ...uncaught.initialized.events,
      ...uncaught.resolved.events
    ])
    assert(Result.isSuccess(uncaughtReplay))
    assert.deepStrictEqual(
      uncaughtReplay.success,
      uncaught.resolved.state
    )

    const nearMatch = resolveFailure("E_OTHER")
    assert.strictEqual(nearMatch.resolved.state.status, "failed")
    assert(
      nearMatch.resolved.events.some((event) =>
        event._tag === "ExecutionFailed" &&
        event.failureKind === "UnmappedBusinessFailure" &&
        event.errorRef === undefined
      )
    )
    assert(
      nearMatch.resolved.events.some((event) =>
        event._tag === "TokenWithdrawn" &&
        event.reason === "unmapped-business-failure"
      )
    )
    const nearMatchReplay = BpmnKernel.replay(compiled, [
      ...nearMatch.initialized.events,
      ...nearMatch.resolved.events
    ])
    assert(Result.isSuccess(nearMatchReplay))
    assert.deepStrictEqual(
      nearMatchReplay.success,
      nearMatch.resolved.state
    )
  })

  it("routes completed task outputs through conditional selection, default fallback, and idempotent replay", () => {
    const definition = model(
      [
        startEvent("start", processId, ["flow-start-decide"]),
        task("task-decide", processId, ["flow-start-decide"], [
          "flow-decide-yes",
          "flow-decide-no",
          "flow-decide-default"
        ], {
          defaultFlowId: "flow-decide-default"
        }),
        task("task-yes", processId, ["flow-decide-yes"], []),
        task("task-no", processId, ["flow-decide-no"], []),
        task("task-default", processId, ["flow-decide-default"], [])
      ],
      [
        flow("flow-start-decide", processId, "start", "task-decide", "normal"),
        flow("flow-decide-yes", processId, "task-decide", "task-yes", "conditional", {
          condition: expression("yes")
        }),
        flow("flow-decide-no", processId, "task-decide", "task-no", "conditional", {
          condition: expression("no")
        }),
        flow("flow-decide-default", processId, "task-decide", "task-default", "default")
      ]
    )
    const compiled = compile(definition)
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task-decide"
    )
    if (token === undefined) {
      throw new Error("expected task wait token")
    }

    const routed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task-decide",
        tokenId: token.tokenId
      },
      services({ yes: true, no: false })
    )
    assert.isTrue(Result.isSuccess(routed))
    if (Result.isFailure(routed)) {
      throw routed.failure
    }
    assert.deepStrictEqual(activeNodeIds(routed.success.state), ["task-yes"])
    const routedReplay = BpmnKernel.replay(compiled, [
      ...initialized.success.events,
      ...routed.success.events
    ])
    assert(Result.isSuccess(routedReplay))
    assert.deepStrictEqual(routedReplay.success, routed.success.state)
    const conditionEvents = routed.success.events.filter((event) => event._tag === "ConditionEvaluated")
    assert.strictEqual(conditionEvents.length, 2)
    for (const event of conditionEvents) {
      if (event._tag !== "ConditionEvaluated") {
        throw new Error("expected condition event")
      }
      assert.deepStrictEqual(
        event.evaluatorBinding,
        compiled.evaluatorBindings[0]
      )
      assert.strictEqual(event.usage.steps, 1)
      assert.isAbove(event.usage.sourceUtf8Bytes, 0)
      assert.isAbove(event.usage.contextCanonicalBytes, 0)
    }

    const committedJournal = [
      ...initialized.success.events,
      ...routed.success.events
    ]
    const changedUsage = structuredClone(committedJournal)
    const usageEvent = changedUsage.find((event) => event._tag === "ConditionEvaluated")
    if (usageEvent?._tag !== "ConditionEvaluated") {
      throw new Error("expected condition event")
    }
    usageEvent.usage.contextCanonicalBytes++
    const changedBinding = structuredClone(committedJournal)
    const bindingEvent = changedBinding.find((event) => event._tag === "ConditionEvaluated")
    if (bindingEvent?._tag !== "ConditionEvaluated") {
      throw new Error("expected condition event")
    }
    bindingEvent.evaluatorBinding.build.deploymentId = "forged-deployment"
    for (const forged of [changedUsage, changedBinding]) {
      const rejected = BpmnKernel.replay(compiled, forged)
      assert(Result.isFailure(rejected))
      assert(
        rejected.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidTransitionJournal)
      )
    }

    const replayed = BpmnKernel.completeTask(
      compiled,
      routed.success.state,
      {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task-decide",
        tokenId: token.tokenId
      },
      services({ yes: true, no: false })
    )
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success.events, [{
      _tag: "TaskCompletionReplayed",
      tokenId: token.tokenId,
      observedAt: now
    }])

    const defaultInit = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(defaultInit))
    if (Result.isFailure(defaultInit)) {
      throw defaultInit.failure
    }
    const defaultToken = defaultInit.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === "task-decide"
    )
    if (defaultToken === undefined) {
      throw new Error("expected default task token")
    }
    const defaulted = BpmnKernel.completeTask(
      compiled,
      defaultInit.success.state,
      {
        scopeInstanceId: defaultToken.scopeInstanceId,
        taskNodeId: "task-decide",
        tokenId: defaultToken.tokenId
      },
      services({ yes: false, no: false })
    )
    assert.isTrue(Result.isSuccess(defaulted))
    if (Result.isFailure(defaulted)) {
      throw defaulted.failure
    }
    assert.deepStrictEqual(activeNodeIds(defaulted.success.state), ["task-default"])
  })

  it("fans an activity out across every normal and true conditional flow", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-source"]),
        task("task-source", processId, ["flow-start-source"], [
          "flow-source-normal",
          "flow-source-a",
          "flow-source-b",
          "flow-source-default"
        ], { defaultFlowId: "flow-source-default" }),
        task("task-normal", processId, ["flow-source-normal"], []),
        task("task-a", processId, ["flow-source-a"], []),
        task("task-b", processId, ["flow-source-b"], []),
        task("task-default", processId, ["flow-source-default"], [])
      ],
      [
        flow("flow-start-source", processId, "start", "task-source", "normal"),
        flow("flow-source-normal", processId, "task-source", "task-normal", "normal"),
        flow("flow-source-a", processId, "task-source", "task-a", "conditional", {
          condition: expression("a")
        }),
        flow("flow-source-b", processId, "task-source", "task-b", "conditional", {
          condition: expression("b")
        }),
        flow("flow-source-default", processId, "task-source", "task-default", "default")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const sourceToken = initialized.success.state.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === "task-source"
    )
    if (sourceToken === undefined) {
      throw new Error("expected source task token")
    }

    const completed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: sourceToken.scopeInstanceId,
        taskNodeId: "task-source",
        tokenId: sourceToken.tokenId
      },
      services({ a: true, b: true })
    )

    assert(Result.isSuccess(completed))
    assert.deepStrictEqual(activeNodeIds(completed.success.state).sort(), [
      "task-a",
      "task-b",
      "task-normal"
    ])
    assert(
      completed.success.events.some((event) =>
        event._tag === "OutgoingSelected" &&
        event.sequenceFlowIds.length === 3 &&
        !event.sequenceFlowIds.includes("flow-source-default")
      )
    )
  })

  it("uses deterministic exclusive-gateway ordering before default fallback", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-gateway"]),
        gateway(
          "gateway-exclusive",
          "exclusive",
          "diverging",
          ["flow-start-gateway"],
          ["flow-gateway-second", "flow-gateway-first", "flow-gateway-default"],
          { defaultFlowId: "flow-gateway-default" }
        ),
        task("task-first", processId, ["flow-gateway-first"], []),
        task("task-second", processId, ["flow-gateway-second"], []),
        task("task-default", processId, ["flow-gateway-default"], [])
      ],
      [
        flow("flow-start-gateway", processId, "start", "gateway-exclusive", "normal"),
        flow("flow-gateway-first", processId, "gateway-exclusive", "task-first", "conditional", {
          condition: expression("first"),
          order: 2
        }),
        flow("flow-gateway-second", processId, "gateway-exclusive", "task-second", "conditional", {
          condition: expression("second"),
          order: 1
        }),
        flow("flow-gateway-default", processId, "gateway-exclusive", "task-default", "default")
      ]
    ))

    const initialized = initializeKernel(compiled, services({ first: true, second: true }))
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    assert.deepStrictEqual(activeNodeIds(initialized.success.state), ["task-second"])
  })

  it("splits and joins parallel branches with exact join epochs", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-split"]),
        gateway("gateway-split", "parallel", "diverging", ["flow-start-split"], [
          "flow-split-a",
          "flow-split-b"
        ]),
        task("task-a", processId, ["flow-split-a"], ["flow-a-join"]),
        task("task-b", processId, ["flow-split-b"], ["flow-b-join"]),
        gateway("gateway-join", "parallel", "converging", ["flow-a-join", "flow-b-join"], ["flow-join-after"]),
        task("task-after", processId, ["flow-join-after"], [])
      ],
      [
        flow("flow-start-split", processId, "start", "gateway-split", "normal"),
        flow("flow-split-a", processId, "gateway-split", "task-a", "normal"),
        flow("flow-split-b", processId, "gateway-split", "task-b", "normal"),
        flow("flow-a-join", processId, "task-a", "gateway-join", "normal"),
        flow("flow-b-join", processId, "task-b", "gateway-join", "normal"),
        flow("flow-join-after", processId, "gateway-join", "task-after", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    assert.deepStrictEqual(activeNodeIds(initialized.success.state).sort(), ["task-a", "task-b"])

    const tokenA = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-a"
    )
    const tokenB = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-b"
    )
    if (tokenA === undefined || tokenB === undefined) {
      throw new Error("expected parallel task tokens")
    }

    const partial = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: tokenA.scopeInstanceId,
        taskNodeId: "task-a",
        tokenId: tokenA.tokenId
      },
      services()
    )
    assert.isTrue(Result.isSuccess(partial))
    if (Result.isFailure(partial)) {
      throw partial.failure
    }
    assert.deepStrictEqual(activeNodeIds(partial.success.state), ["task-b"])
    assert.isTrue(
      partial.success.state.gatewayFrames.some((frame) => frame.status === "waiting" && frame.joinEpoch === 1)
    )

    const completed = BpmnKernel.completeTask(
      compiled,
      partial.success.state,
      {
        scopeInstanceId: tokenB.scopeInstanceId,
        taskNodeId: "task-b",
        tokenId: tokenB.tokenId
      },
      services()
    )
    assert.isTrue(Result.isSuccess(completed))
    if (Result.isFailure(completed)) {
      throw completed.failure
    }
    assert.deepStrictEqual(activeNodeIds(completed.success.state), ["task-after"])
    assert.isTrue(
      completed.success.state.gatewayFrames.some((frame) => frame.status === "fired" && frame.joinEpoch === 1)
    )
    const replayed = BpmnKernel.replay(compiled, [
      ...initialized.success.events,
      ...partial.success.events,
      ...completed.success.events
    ])
    assert(Result.isSuccess(replayed))
    assert.deepStrictEqual(replayed.success, completed.success.state)
  })

  it("keeps interleaved parallel arrivals in distinct join epochs", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-split"]),
        gateway("gateway-split", "parallel", "diverging", ["flow-start-split"], [
          "flow-split-a",
          "flow-split-b"
        ]),
        task("task-a", processId, ["flow-split-a"], ["flow-a-join"]),
        task("task-b", processId, ["flow-split-b"], ["flow-b-join"]),
        gateway("gateway-join", "parallel", "converging", ["flow-a-join", "flow-b-join"], ["flow-join-after"]),
        task("task-after", processId, ["flow-join-after"], [])
      ],
      [
        flow("flow-start-split", processId, "start", "gateway-split", "normal"),
        flow("flow-split-a", processId, "gateway-split", "task-a", "normal"),
        flow("flow-split-b", processId, "gateway-split", "task-b", "normal"),
        flow("flow-a-join", processId, "task-a", "gateway-join", "normal"),
        flow("flow-b-join", processId, "task-b", "gateway-join", "normal"),
        flow("flow-join-after", processId, "gateway-join", "task-after", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const seeded = structuredClone(initialized.success.state)
    const tokenA = seeded.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-a"
    )
    const tokenB = seeded.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-b"
    )
    if (tokenA === undefined || tokenB === undefined) {
      throw new Error("expected parallel task tokens")
    }
    const tokenA2 = structuredClone(tokenA)
    const tokenB2 = structuredClone(tokenB)
    tokenA2.tokenId = "token:extra-a"
    tokenB2.tokenId = "token:extra-b"
    seeded.tokens.push(tokenA2, tokenB2)

    const complete = (
      state: BpmnExecutionState.BpmnExecutionState,
      token: BpmnExecutionState.Token,
      taskNodeId: string
    ): BpmnExecutionState.BpmnExecutionState => {
      const result = BpmnKernel.completeTask(
        compiled,
        state,
        {
          scopeInstanceId: token.scopeInstanceId,
          taskNodeId,
          tokenId: token.tokenId
        },
        services()
      )
      if (Result.isFailure(result)) {
        throw result.failure
      }
      return result.success.state
    }

    const afterA1 = complete(seeded, tokenA, "task-a")
    const afterA2 = complete(afterA1, tokenA2, "task-a")
    assert.deepStrictEqual(
      afterA2.gatewayFrames.filter((frame) => frame.status === "waiting").map((frame) => frame.joinEpoch),
      [1, 2]
    )
    const afterB1 = complete(afterA2, tokenB, "task-b")
    const afterB2 = complete(afterB1, tokenB2, "task-b")

    assert.deepStrictEqual(
      afterB2.gatewayFrames.filter((frame) => frame.status === "fired").map((frame) => frame.joinEpoch),
      [1, 2]
    )
    assert.deepStrictEqual(activeNodeIds(afterB2), ["task-after", "task-after"])
  })

  it("does not complete the root scope while a sibling branch still has work", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-split"]),
        gateway("gateway-split", "parallel", "diverging", ["flow-start-split"], [
          "flow-split-end",
          "flow-split-task"
        ]),
        endEvent("end-left", processId, ["flow-split-end"]),
        task("task-right", processId, ["flow-split-task"], [])
      ],
      [
        flow("flow-start-split", processId, "start", "gateway-split", "normal"),
        flow("flow-split-end", processId, "gateway-split", "end-left", "normal"),
        flow("flow-split-task", processId, "gateway-split", "task-right", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    assert.strictEqual(initialized.success.state.status, "active")
    assert.deepStrictEqual(activeNodeIds(initialized.success.state), ["task-right"])
  })

  it("enters embedded subprocess scopes and returns control to the parent scope", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-sub"]),
        subProcess("subprocess", processId, ["flow-start-sub"], ["flow-sub-after"]),
        task("task-after", processId, ["flow-sub-after"], ["flow-after-end"]),
        endEvent("end-main", processId, ["flow-after-end"]),
        startEvent("start-sub", "subprocess", ["flow-sub-inner"]),
        task("task-inner", "subprocess", ["flow-sub-inner"], ["flow-inner-end"]),
        endEvent("end-sub", "subprocess", ["flow-inner-end"])
      ],
      [
        flow("flow-start-sub", processId, "start", "subprocess", "normal"),
        flow("flow-sub-after", processId, "subprocess", "task-after", "normal"),
        flow("flow-after-end", processId, "task-after", "end-main", "normal"),
        flow("flow-sub-inner", "subprocess", "start-sub", "task-inner", "normal"),
        flow("flow-inner-end", "subprocess", "task-inner", "end-sub", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    assert.deepStrictEqual(activeNodeIds(initialized.success.state), ["task-inner"])
    const innerToken = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-inner"
    )
    if (innerToken === undefined) {
      throw new Error("expected inner task token")
    }

    const completed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: innerToken.scopeInstanceId,
        taskNodeId: "task-inner",
        tokenId: innerToken.tokenId
      },
      services()
    )
    assert.isTrue(Result.isSuccess(completed))
    if (Result.isFailure(completed)) {
      throw completed.failure
    }
    assert.deepStrictEqual(activeNodeIds(completed.success.state), ["task-after"])
    const childScope = completed.success.state.scopeInstances.find((scope) => scope.definitionId === "subprocess")
    assert.strictEqual(childScope?.status, "completed")
  })

  it("rejects forged exact-scope task positions through shared execution-state validation", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-sub"]),
        subProcess("subprocess", processId, ["flow-start-sub"], []),
        startEvent("start-sub", "subprocess", ["flow-sub-inner"]),
        task("task-inner", "subprocess", ["flow-sub-inner"], [])
      ],
      [
        flow("flow-start-sub", processId, "start", "subprocess", "normal"),
        flow("flow-sub-inner", "subprocess", "start-sub", "task-inner", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const rootScope = initialized.success.state.scopeInstances.find((scope) => scope.definitionId === processId)
    const innerToken = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-inner"
    )
    if (rootScope === undefined || innerToken === undefined) {
      throw new Error("expected initialized subprocess state")
    }
    const tampered = structuredClone(initialized.success.state)
    const tamperedToken = tampered.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === "task-inner"
    )
    if (tamperedToken === undefined) {
      throw new Error("expected tampered token")
    }
    tamperedToken.scopeInstanceId = rootScope.scopeInstanceId

    const advanced = BpmnKernel.advance(compiled, tampered, services())
    assert.isTrue(Result.isFailure(advanced))
    if (Result.isSuccess(advanced)) {
      throw new Error("expected invalid execution state")
    }
    assert.isTrue(
      advanced.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidTokenPosition
      )
    )
  })

  it("rejects wrong replay tuples and consumed non-task token identities", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], [])
      ],
      [flow("flow-start-task", processId, "start", "task", "normal")]
    ))
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const taskToken = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode"
    )
    if (taskToken === undefined) {
      throw new Error("expected task token")
    }
    const completed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: taskToken.scopeInstanceId,
        taskNodeId: "task",
        tokenId: taskToken.tokenId
      },
      services()
    )
    assert(Result.isSuccess(completed))
    const wrongTuple = BpmnKernel.completeTask(
      compiled,
      completed.success.state,
      {
        scopeInstanceId: taskToken.scopeInstanceId,
        taskNodeId: "start",
        tokenId: taskToken.tokenId
      },
      services()
    )
    const consumedFlow = completed.success.state.tokens.find((token) =>
      token.status === "consumed" && token.position._tag === "OnSequenceFlow"
    )
    if (consumedFlow === undefined) {
      throw new Error("expected consumed sequence-flow token")
    }
    const nonTaskReplay = BpmnKernel.completeTask(
      compiled,
      completed.success.state,
      {
        scopeInstanceId: consumedFlow.scopeInstanceId,
        taskNodeId: "task",
        tokenId: consumedFlow.tokenId
      },
      services()
    )

    assert(Result.isFailure(wrongTuple))
    assert(Result.isFailure(nonTaskReplay))
    assert(wrongTuple.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidCommand))
    assert(nonTaskReplay.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidCommand))
  })

  it("protects compiled authority and evaluator state from caller mutation", () => {
    const definition = model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], ["flow-task-next", "flow-task-default"], {
          defaultFlowId: "flow-task-default"
        }),
        task("task-next", processId, ["flow-task-next"], []),
        task("task-default", processId, ["flow-task-default"], [])
      ],
      [
        flow("flow-start-task", processId, "start", "task", "normal"),
        flow("flow-task-next", processId, "task", "task-next", "conditional", {
          condition: expression("go")
        }),
        flow("flow-task-default", processId, "task", "task-default", "default")
      ]
    )
    const compiled = compile(definition)
    ;(compiled.orderedOutgoingByNodeId as Map<string, ReadonlyArray<string>>).set("start", [])
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    assert.deepStrictEqual(activeNodeIds(initialized.success.state), ["task"])
    const forged = { ...compiled }
    const forgedResult = initializeKernel(forged, services())
    assert(Result.isFailure(forgedResult))
    assert(forgedResult.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidKernel))

    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" && candidate.position._tag === "AtNode"
    )
    if (token === undefined) {
      throw new Error("expected task token")
    }
    const before = structuredClone(initialized.success.state)
    const mutation = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task",
        tokenId: token.tokenId
      },
      {
        now,
        evaluateExpression: ({ state }) => {
          ;(state.tokens as Array<unknown>).push({})
          return Result.succeed({ result: true, steps: 1 })
        }
      }
    )

    assert(Result.isFailure(mutation))
    assert(mutation.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.EvaluationFailed))
    assert.deepStrictEqual(initialized.success.state, before)
  })

  it("rejects hostile services and clock regression without invoking accessors", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], [])
      ],
      [flow("flow-start-task", processId, "start", "task", "normal")]
    ))
    let getterRead = false
    const hostileServices = Object.defineProperty({}, "now", {
      enumerable: true,
      configurable: true,
      get() {
        getterRead = true
        return now
      }
    }) as BpmnKernel.Services
    const hostile = initializeKernel(compiled, hostileServices)
    assert(Result.isFailure(hostile))
    assert.isFalse(getterRead)
    assert(
      hostile.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidServices)
    )

    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const waiting = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode"
    )
    if (waiting === undefined) {
      throw new Error("expected task wait token")
    }
    const regressed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: waiting.scopeInstanceId,
        taskNodeId: "task",
        tokenId: waiting.tokenId
      },
      {
        now: "2026-07-23T09:59:59.999Z"
      }
    )
    assert(Result.isFailure(regressed))
    assert(
      regressed.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidServices)
    )
  })

  it("replays an ordered transition journal into the exact durable marking", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], ["flow-task-end"]),
        endEvent("end", processId, ["flow-task-end"])
      ],
      [
        flow("flow-start-task", processId, "start", "task", "normal"),
        flow("flow-task-end", processId, "task", "end", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const waiting = initialized.success.state.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === "task"
    )
    if (waiting === undefined) {
      throw new Error("expected task wait token")
    }
    const completed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: waiting.scopeInstanceId,
        taskNodeId: "task",
        tokenId: waiting.tokenId
      },
      services()
    )
    assert(Result.isSuccess(completed))

    const initialReplay = BpmnKernel.replay(compiled, initialized.success.events)
    const terminalReplay = BpmnKernel.replay(compiled, [
      ...initialized.success.events,
      ...completed.success.events
    ])

    assert(Result.isSuccess(initialReplay))
    assert(Result.isSuccess(terminalReplay))
    assert.deepStrictEqual(initialReplay.success, initialized.success.state)
    assert.deepStrictEqual(terminalReplay.success, completed.success.state)
    assert(Object.isFrozen(terminalReplay.success))
  })

  it("binds states and journals to the exact model and execution profile fingerprint", () => {
    const conditionalModel = (source: string): BpmnModel.BpmnModel =>
      model(
        [
          startEvent("start", processId, ["flow-start-task"]),
          task(
            "task",
            processId,
            ["flow-start-task"],
            ["flow-conditional", "flow-default"],
            { defaultFlowId: "flow-default" }
          ),
          endEvent("end-conditional", processId, ["flow-conditional"]),
          endEvent("end-default", processId, ["flow-default"])
        ],
        [
          flow("flow-start-task", processId, "start", "task", "normal"),
          flow(
            "flow-conditional",
            processId,
            "task",
            "end-conditional",
            "conditional",
            { condition: expression(source) }
          ),
          flow(
            "flow-default",
            processId,
            "task",
            "end-default",
            "default"
          )
        ]
      )

    const baselineModel = conditionalModel("approved")
    const changedModel = conditionalModel("rejected")
    const baseline = compile(baselineModel)
    const changed = compile(changedModel)
    const changedProfile = prepareResult(
      baselineModel,
      limits,
      "different-profile-v1"
    )
    const changedLimits = prepareResult(baselineModel, {
      ...limits,
      maxAutomaticTransitions: limits.maxAutomaticTransitions + 1,
      maxMultiInstanceCardinality: limits.maxMultiInstanceCardinality
    })
    const alternateBuildDigest = Schema.decodeUnknownSync(
      ProtocolV2Wire.BuildDigest
    )(`sha256:${"4".repeat(64)}`)
    const alternateExecutableFingerprint = Schema.decodeUnknownSync(
      ProtocolV2Wire.BpmnExecutableFingerprint
    )(`sha256:${"5".repeat(64)}`)
    const changedEvaluator = prepareResult(
      baselineModel,
      limits,
      "test-bpmn-model-v1",
      evaluatorBindings(baselineModel).map((binding) => ({
        ...binding,
        build: {
          ...binding.build,
          buildDigest: alternateBuildDigest
        }
      }))
    )
    const explicitEmptyBindings = prepareResult(
      baselineModel,
      limits,
      "test-bpmn-model-v1",
      evaluatorBindings(baselineModel),
      []
    )
    const protocolBound = prepareResult(
      baselineModel,
      limits,
      "test-bpmn-model-v1",
      evaluatorBindings(baselineModel),
      [taskBinding("task")]
    )
    assert(Result.isSuccess(changedProfile))
    assert(Result.isSuccess(changedLimits))
    assert(Result.isSuccess(changedEvaluator))
    assert(Result.isSuccess(explicitEmptyBindings))
    assert(Result.isSuccess(protocolBound))
    assert.strictEqual(
      explicitEmptyBindings.success.modelReference.executableFingerprint,
      baseline.modelReference.executableFingerprint
    )
    assert.notStrictEqual(
      protocolBound.success.modelReference.executableFingerprint,
      baseline.modelReference.executableFingerprint
    )

    const fingerprints = [
      changed.modelReference.executableFingerprint,
      changedProfile.success.modelReference.executableFingerprint,
      changedLimits.success.modelReference.executableFingerprint,
      changedEvaluator.success.modelReference.executableFingerprint
    ]
    for (const fingerprint of fingerprints) {
      assert.notStrictEqual(
        fingerprint,
        baseline.modelReference.executableFingerprint
      )
    }

    const initialized = initializeKernel(baseline, services())
    assert(Result.isSuccess(initialized))
    assert.strictEqual(
      initialized.success.events[0]?._tag,
      "JournalStarted"
    )
    assert.deepStrictEqual(
      initialized.success.state.model,
      baseline.modelReference
    )

    const crossedState = BpmnKernel.advance(
      changed,
      initialized.success.state,
      services()
    )
    assert(Result.isFailure(crossedState))
    assert(
      crossedState.failure.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          BpmnKernel.Codes.BpmnModelFingerprintMismatch
      )
    )

    const crossedJournal = BpmnKernel.replay(
      changed,
      initialized.success.events
    )
    assert(Result.isFailure(crossedJournal))
    assert(
      crossedJournal.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.BpmnJournalModelMismatch
      )
    )

    const tamperedState = structuredClone(initialized.success.state)
    tamperedState.model.executableFingerprint = alternateExecutableFingerprint
    const rejectedState = BpmnKernel.advance(
      baseline,
      tamperedState,
      services()
    )
    assert(Result.isFailure(rejectedState))
    assert(
      rejectedState.failure.diagnostics.some((diagnostic) =>
        diagnostic.code ===
          BpmnKernel.Codes.BpmnModelFingerprintMismatch
      )
    )

    const tamperedJournal = structuredClone(initialized.success.events)
    const header = tamperedJournal[0]
    if (header?._tag !== "JournalStarted") {
      throw new Error("expected journal header")
    }
    header.model.executableFingerprint = alternateExecutableFingerprint
    const rejectedJournal = BpmnKernel.replay(
      baseline,
      tamperedJournal
    )
    assert(Result.isFailure(rejectedJournal))
    assert(
      rejectedJournal.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.BpmnJournalModelMismatch
      )
    )

    const headerless = BpmnKernel.replay(
      baseline,
      initialized.success.events.slice(1)
    )
    assert(Result.isFailure(headerless))
    assert(
      headerless.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidTransitionJournal)
    )
  })

  it("rejects tampered, truncated, and hostile transition journals", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], [])
      ],
      [flow("flow-start-task", processId, "start", "task", "normal")]
    ))
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))

    const tampered = structuredClone(initialized.success.events)
    const emission = tampered.find((event) => event._tag === "TokenEmitted")
    if (emission === undefined || emission._tag !== "TokenEmitted") {
      throw new Error("expected emitted token event")
    }
    emission.tokenId = "token:forged"

    const truncated = initialized.success.events.slice(0, 1)
    let getterRead = false
    const hostile = Object.defineProperty([], "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterRead = true
        return initialized.success.events[0]
      }
    })
    Object.defineProperty(hostile, "length", {
      value: 1,
      enumerable: false,
      configurable: false,
      writable: true
    })

    for (const journal of [tampered, truncated, hostile]) {
      const replayed = BpmnKernel.replay(compiled, journal)
      assert(Result.isFailure(replayed))
      assert(
        replayed.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidTransitionJournal)
      )
    }
    assert.isFalse(getterRead)
  })

  it("rejects kernel-state forgery outside the admitted subset", () => {
    const definition: BpmnModel.BpmnModel = {
      ...model(
        [
          startEvent("start", processId, ["flow-start-task"]),
          task("task", processId, ["flow-start-task"], [])
        ],
        [flow("flow-start-task", processId, "start", "task", "normal")]
      ),
      processes: [
        process(),
        {
          id: "process-other",
          isExecutable: true,
          extensionElements: []
        }
      ]
    }
    const compiled = compile(definition)
    const initialized = initializeKernel(compiled, services())
    assert(Result.isSuccess(initialized))
    const activeToken = initialized.success.state.tokens.find((token) => token.status === "active")
    if (activeToken === undefined) {
      throw new Error("expected active task token")
    }

    const nonTaskPosition = structuredClone(initialized.success.state)
    const nonTaskToken = nonTaskPosition.tokens.find((token) => token.tokenId === activeToken.tokenId)!
    nonTaskToken.position = { _tag: "AtNode", nodeId: "start" }

    const auxiliary = structuredClone(initialized.success.state)
    auxiliary.cancellationRegions.push({
      regionId: "region-forged",
      scopeInstanceId: activeToken.scopeInstanceId,
      status: "open",
      memberScopeInstanceIds: [],
      memberTokenIds: [activeToken.tokenId]
    })

    const terminalWithWork = structuredClone(initialized.success.state)
    terminalWithWork.status = "completed"
    terminalWithWork.completedAt = now

    const failureWithoutResolution = structuredClone(
      initialized.success.state
    )
    failureWithoutResolution.status = "failed"
    failureWithoutResolution.completedAt = now
    failureWithoutResolution.scopeInstances = failureWithoutResolution.scopeInstances.map((scope) => ({
      ...scope,
      status: "failed" as const,
      exitedAt: now
    }))
    failureWithoutResolution.tokens = failureWithoutResolution.tokens.map((token) =>
      token.status === "active"
        ? {
          ...token,
          status: "withdrawn" as const,
          consumedAt: now
        }
        : token
    )

    const wrongRoot = structuredClone(initialized.success.state)
    wrongRoot.model.rootProcessId = "process-other"
    wrongRoot.status = "completed"
    wrongRoot.completedAt = now
    wrongRoot.tokens = []
    wrongRoot.scopeInstances = wrongRoot.scopeInstances.map((scope) => ({
      ...scope,
      definitionId: "process-other",
      processId: "process-other",
      status: "completed" as const,
      exitedAt: now
    }))

    for (
      const forged of [
        nonTaskPosition,
        auxiliary,
        failureWithoutResolution,
        wrongRoot
      ]
    ) {
      const result = BpmnKernel.advance(compiled, forged, services())
      assert(Result.isFailure(result))
      assert(
        result.failure.diagnostics.some((diagnostic) =>
          diagnostic.code === BpmnKernel.Codes.InvalidKernelState ||
          diagnostic.code === BpmnKernel.Codes.BpmnModelFingerprintMismatch
        ),
        result.failure.diagnostics.map((diagnostic) => diagnostic.code).join(",")
      )
    }
    const terminalResult = BpmnKernel.advance(compiled, terminalWithWork, services())
    assert(Result.isFailure(terminalResult))
    assert(
      terminalResult.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnExecutionState.Codes.InvalidState)
    )
  })

  it("bounds automatic subprocess cycles and emits immutable deterministic journals", () => {
    const automaticCycle = model(
      [
        startEvent("start", processId, ["flow-start-sub"]),
        subProcess("subprocess", processId, ["flow-start-sub", "flow-sub-loop"], ["flow-sub-loop"]),
        startEvent("start-sub", "subprocess", ["flow-sub-end"]),
        endEvent("end-sub", "subprocess", ["flow-sub-end"])
      ],
      [
        flow("flow-start-sub", processId, "start", "subprocess", "normal"),
        flow("flow-sub-loop", processId, "subprocess", "subprocess", "normal"),
        flow("flow-sub-end", "subprocess", "start-sub", "end-sub", "normal")
      ]
    )
    const bounded = prepareResult(automaticCycle, {
      ...limits,
      maxAutomaticTransitions: 8,
      maxMultiInstanceCardinality: limits.maxMultiInstanceCardinality
    })
    assert(
      Result.isSuccess(bounded),
      Result.isFailure(bounded)
        ? bounded.failure.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join(",")
        : undefined
    )
    const exceeded = initializeKernel(bounded.success, services())
    assert(Result.isFailure(exceeded))
    assert(
      exceeded.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.AutomaticTransitionLimitExceeded
      )
    )

    const deterministic = compile(model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], [])
      ],
      [flow("flow-start-task", processId, "start", "task", "normal")]
    ))
    const first = initializeKernel(deterministic, services())
    const second = initializeKernel(deterministic, services())
    assert(Result.isSuccess(first))
    assert(Result.isSuccess(second))
    assert.deepStrictEqual(first.success, second.success)
    assert(Object.isFrozen(first.success.events))
    assert(first.success.events.every(Object.isFrozen))
  })

  it("rejects silently ignored execution-affecting model attributes", () => {
    const unsupported = model(
      [
        startEvent("start", processId, ["flow-start-task"]),
        task("task", processId, ["flow-start-task"], [], {
          taskKind: "user",
          startQuantity: 2
        })
      ],
      [flow("flow-start-task", processId, "start", "task", "normal", {
        isImmediate: false
      })]
    )

    const result = prepareResult(unsupported)

    assert(Result.isFailure(result))
    assert.deepStrictEqual(
      new Set(result.failure.diagnostics.map((diagnostic) => diagnostic.code)),
      new Set([
        BpmnKernel.Codes.UnsupportedActivity,
        BpmnKernel.Codes.InvalidExecutableStructure
      ])
    )
  })

  it("rejects executable Boundary Errors without a protocol binding and duplicate failure mappings", () => {
    const errorRef = "error-validation"
    const definition: BpmnModel.BpmnModel = {
      ...model(
        [
          startEvent("start", processId, ["flow-start-task"]),
          task("task", processId, ["flow-start-task"], ["flow-task-success"]),
          boundaryError("boundary-error", "task", "flow-error-end", errorRef),
          endEvent("end-success", processId, ["flow-task-success"]),
          endEvent("end-error", processId, ["flow-error-end"])
        ],
        [
          flow("flow-start-task", processId, "start", "task", "normal"),
          flow("flow-task-success", processId, "task", "end-success", "normal"),
          flow("flow-error-end", processId, "boundary-error", "end-error", "normal")
        ]
      ),
      errors: [{ id: errorRef }]
    }

    const unbound = prepareResult(definition)
    assert(Result.isFailure(unbound))
    assert(
      unbound.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.UnsupportedEvent)
    )

    const duplicateMappings = prepareResult(
      definition,
      limits,
      "test-bpmn-model-v1",
      evaluatorBindings(definition),
      [taskBinding("task", [
        { errorTag: "ValidationError", errorRef },
        { errorTag: "ValidationError", errorRef }
      ])]
    )
    assert(Result.isFailure(duplicateMappings))
    assert(
      duplicateMappings.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.InvalidKernelProfile &&
        diagnostic.message.includes("repeats failure identity")
      )
    )
  })

  it("rejects implicit activity activation, a lone conditional output, and a missing end event", () => {
    const unsupported = model(
      [
        startEvent("start", processId, ["flow-start-source"]),
        task("source", processId, ["flow-start-source"], ["flow-source-target"]),
        task("target", processId, ["flow-source-target"], []),
        task("orphan", processId, [], [])
      ],
      [
        flow("flow-start-source", processId, "start", "source", "normal"),
        flow("flow-source-target", processId, "source", "target", "conditional", {
          condition: expression("only")
        })
      ],
      { addScopeEnds: false }
    )

    const result = prepareResult(unsupported)

    assert(Result.isFailure(result))
    const messages = result.failure.diagnostics.map((diagnostic) => diagnostic.message)
    assert(messages.some((message) => message.includes("implicit scope-entry activation")))
    assert(messages.some((message) => message.includes("conditional sequence flow as its only outgoing flow")))
    assert(messages.some((message) => message.includes("requires at least one end event")))
    assert(
      result.failure.diagnostics.every((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidExecutableStructure)
    )
  })

  it("rejects unsupported compile-time constructs with aggregate deterministic diagnostics", () => {
    const unsupported = {
      ...model(
        [
          startEvent("start", processId, ["flow-start-loop"], [{
            _tag: "MessageEventDefinition",
            messageRef: "message-start"
          }]),
          task("task-loop", processId, ["flow-start-loop"], ["flow-loop-end"], {
            loopCharacteristics: {
              _tag: "StandardLoopCharacteristics",
              testBefore: true,
              condition: expression("repeat")
            }
          }),
          {
            _tag: "CallActivity",
            id: "call-unsupported",
            processId,
            parentScopeId: processId,
            incomingSequenceFlowIds: [],
            outgoingSequenceFlowIds: [],
            extensionElements: emptyExtensions()
          },
          gateway("gateway-inclusive", "inclusive", "diverging", [], [])
        ] as Array<BpmnModel.FlowNode>,
        [
          flow("flow-start-loop", processId, "start", "task-loop", "normal"),
          flow("flow-loop-end", processId, "task-loop", "end-loop", "normal")
        ],
        { addScopeEnds: false }
      ),
      messages: [{ id: "message-start" }],
      flowNodes: [
        startEvent("start", processId, ["flow-start-loop"], [{
          _tag: "MessageEventDefinition",
          messageRef: "message-start"
        }]),
        task("task-loop", processId, ["flow-start-loop"], ["flow-loop-end"], {
          loopCharacteristics: {
            _tag: "StandardLoopCharacteristics",
            testBefore: true,
            condition: expression("repeat")
          }
        }),
        {
          _tag: "CallActivity",
          id: "call-unsupported",
          processId,
          parentScopeId: processId,
          incomingSequenceFlowIds: [],
          outgoingSequenceFlowIds: [],
          extensionElements: emptyExtensions()
        },
        gateway("gateway-inclusive", "inclusive", "diverging", [], []),
        endEvent("end-loop", processId, ["flow-loop-end"])
      ]
    } as BpmnModel.BpmnModel
    const compiled = prepareResult(unsupported)
    assert.isTrue(Result.isFailure(compiled))
    if (Result.isSuccess(compiled)) {
      throw new Error("expected unsupported subset failure")
    }
    assert.deepStrictEqual(
      new Set(compiled.failure.diagnostics.map((diagnostic) => diagnostic.code)),
      new Set([
        BpmnKernel.Codes.UnsupportedEvent,
        BpmnKernel.Codes.UnsupportedLoop,
        BpmnKernel.Codes.UnsupportedNode,
        BpmnKernel.Codes.UnsupportedGateway
      ])
    )
  })

  it("requires bounded explicit Standard Loop characteristics on generic tasks", () => {
    const withoutCondition = prepareResult(
      standardLoopModel(true, 3, null),
      limits,
      "loop-without-condition",
      []
    )
    const withoutMaximum = prepareResult(
      standardLoopModel(true, undefined),
      limits,
      "loop-without-maximum",
      []
    )
    for (
      const result of [
        withoutCondition,
        withoutMaximum
      ]
    ) {
      assert.isTrue(Result.isFailure(result))
      if (Result.isSuccess(result)) {
        throw new Error("expected unsupported loop profile")
      }
      assert(
        result.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.UnsupportedLoop)
      )
    }
  })

  it("executes and replays a test-before Standard Loop with zero iterations", () => {
    const compiled = compile(standardLoopModel(true, 3))
    const initialized = initializeKernel(
      compiled,
      services({ repeat: false })
    )
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }

    assert.strictEqual(initialized.success.state.status, "completed")
    assert.deepStrictEqual(
      initialized.success.state.loopFrames.map((frame) => ({
        activation: frame.activation,
        completedIterations: frame.completedIterations,
        status: frame.status
      })),
      [{
        activation: 0,
        completedIterations: 0,
        status: "completed"
      }]
    )
    assert.deepStrictEqual(
      initialized.success.events
        .filter((event) => event._tag.startsWith("Loop"))
        .map((event) => event._tag),
      ["LoopOpened", "LoopConditionEvaluated", "LoopCompleted"]
    )
    const replayed = BpmnKernel.replay(
      compiled,
      initialized.success.events
    )
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, initialized.success.state)
  })

  it("persists exact test-before iterations, replays them, and makes old completion idempotent", () => {
    const compiled = compile(standardLoopModel(true, 5))
    const initialized = initializeKernel(
      compiled,
      services({ repeat: true })
    )
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const firstToken = initialized.success.state.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === "task-loop"
    )
    if (firstToken === undefined) {
      throw new Error("expected first loop iteration")
    }
    const frameId = initialized.success.state.loopFrames[0]?.frameId
    assert.deepStrictEqual(firstToken.invocation.branch, {
      _tag: "StandardLoopIteration",
      frameId,
      iteration: 0
    })

    const firstCompletion = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: firstToken.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: firstToken.tokenId
      },
      services({ repeat: true })
    )
    assert.isTrue(Result.isSuccess(firstCompletion))
    if (Result.isFailure(firstCompletion)) {
      throw firstCompletion.failure
    }
    const secondToken = firstCompletion.success.state.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode" &&
      token.position.nodeId === "task-loop"
    )
    if (secondToken === undefined) {
      throw new Error("expected second loop iteration")
    }
    assert.deepStrictEqual(secondToken.invocation.branch, {
      _tag: "StandardLoopIteration",
      frameId,
      iteration: 1
    })
    assert.strictEqual(
      firstCompletion.success.state.loopFrames[0]?.completedIterations,
      1
    )

    const repeated = BpmnKernel.completeTask(
      compiled,
      firstCompletion.success.state,
      {
        scopeInstanceId: firstToken.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: firstToken.tokenId
      },
      services({ repeat: false })
    )
    assert.isTrue(Result.isSuccess(repeated))
    if (Result.isFailure(repeated)) {
      throw repeated.failure
    }
    assert.deepStrictEqual(
      repeated.success.state,
      firstCompletion.success.state
    )
    assert.deepStrictEqual(
      repeated.success.events.map((event) => event._tag),
      ["TaskCompletionReplayed"]
    )

    const secondCompletion = BpmnKernel.completeTask(
      compiled,
      firstCompletion.success.state,
      {
        scopeInstanceId: secondToken.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: secondToken.tokenId
      },
      services({ repeat: false })
    )
    assert.isTrue(Result.isSuccess(secondCompletion))
    if (Result.isFailure(secondCompletion)) {
      throw secondCompletion.failure
    }
    assert.strictEqual(secondCompletion.success.state.status, "completed")
    assert.deepStrictEqual(
      secondCompletion.success.state.loopFrames.map((frame) => ({
        completedIterations: frame.completedIterations,
        activeIteration: frame.activeIteration,
        status: frame.status
      })),
      [{
        completedIterations: 2,
        activeIteration: undefined,
        status: "completed"
      }]
    )
    const journal = [
      ...initialized.success.events,
      ...firstCompletion.success.events,
      ...secondCompletion.success.events
    ]
    const replayed = BpmnKernel.replay(compiled, journal)
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, secondCompletion.success.state)
  })

  it("executes test-after at least once and enforces loopMaximum without another evaluation", () => {
    const compiled = compile(standardLoopModel(false, 2))
    let evaluations = 0
    const loopServices: BpmnKernel.Services = {
      now,
      evaluateExpression: () => {
        evaluations++
        return Result.succeed({ result: true, steps: 1 })
      }
    }
    const initialized = initializeKernel(compiled, loopServices)
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    assert.strictEqual(evaluations, 0)
    const firstToken = initialized.success.state.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode"
    )
    if (firstToken === undefined) {
      throw new Error("expected mandatory first iteration")
    }
    const firstCompletion = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: firstToken.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: firstToken.tokenId
      },
      loopServices
    )
    assert.isTrue(Result.isSuccess(firstCompletion))
    if (Result.isFailure(firstCompletion)) {
      throw firstCompletion.failure
    }
    assert.strictEqual(evaluations, 1)
    const secondToken = firstCompletion.success.state.tokens.find((token) =>
      token.status === "active" &&
      token.position._tag === "AtNode"
    )
    if (secondToken === undefined) {
      throw new Error("expected second iteration")
    }
    const secondCompletion = BpmnKernel.completeTask(
      compiled,
      firstCompletion.success.state,
      {
        scopeInstanceId: secondToken.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: secondToken.tokenId
      },
      loopServices
    )
    assert.isTrue(Result.isSuccess(secondCompletion))
    if (Result.isFailure(secondCompletion)) {
      throw secondCompletion.failure
    }
    assert.strictEqual(evaluations, 1)
    assert.strictEqual(secondCompletion.success.state.status, "completed")
    const completion = secondCompletion.success.events.find((event) => event._tag === "LoopCompleted")
    assert.deepStrictEqual(
      completion?._tag === "LoopCompleted"
        ? {
          completedIterations: completion.completedIterations,
          reason: completion.reason
        }
        : undefined,
      {
        completedIterations: 2,
        reason: "maximum-reached"
      }
    )
  })

  it("rejects tampered Standard Loop activation, decision evidence, iteration, and completion cause", () => {
    const compiled = compile(standardLoopModel(true, 5))
    const initialized = initializeKernel(
      compiled,
      services({ repeat: true })
    )
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode"
    )
    if (token === undefined) {
      throw new Error("expected loop token")
    }
    const completed = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: token.tokenId
      },
      services({ repeat: false })
    )
    assert.isTrue(Result.isSuccess(completed))
    if (Result.isFailure(completed)) {
      throw completed.failure
    }
    const journal = [
      ...initialized.success.events,
      ...completed.success.events
    ]
    const tamper = (
      select: (event: BpmnKernel.TransitionEvent) => boolean,
      mutate: (event: BpmnKernel.TransitionEvent) => void
    ): void => {
      const forged = structuredClone(journal)
      const event = forged.find(select)
      if (event === undefined) {
        throw new Error("expected loop event to tamper")
      }
      mutate(event)
      assert.isTrue(Result.isFailure(BpmnKernel.replay(compiled, forged)))
    }
    tamper(
      (event) => event._tag === "LoopOpened",
      (event) => {
        if (event._tag === "LoopOpened") event.activation++
      }
    )
    tamper(
      (event) => event._tag === "LoopConditionEvaluated",
      (event) => {
        if (event._tag === "LoopConditionEvaluated") {
          event.usage.contextCanonicalBytes++
        }
      }
    )
    tamper(
      (event) => event._tag === "LoopIterationStarted",
      (event) => {
        if (event._tag === "LoopIterationStarted") event.iteration++
      }
    )
    tamper(
      (event) => event._tag === "LoopCompleted",
      (event) => {
        if (event._tag === "LoopCompleted") {
          event.reason = "maximum-reached"
        }
      }
    )
  })

  it("derives protocol-v3 occurrence coordinates from the exact active loop wait", () => {
    const compiled = compile(
      standardLoopModel(false, 3),
      [taskBinding("task-loop")]
    )
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const firstToken = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode"
    )
    if (firstToken === undefined) {
      throw new Error("expected bound loop token")
    }
    const target = {
      scopeInstanceId: firstToken.scopeInstanceId,
      taskNodeId: "task-loop",
      tokenId: firstToken.tokenId
    }
    const firstOccurrence = BpmnKernel.taskOccurrence(
      compiled,
      initialized.success.state,
      target
    )
    assert.isTrue(Result.isSuccess(firstOccurrence))
    if (Result.isFailure(firstOccurrence)) {
      throw firstOccurrence.failure
    }
    assert.deepStrictEqual(firstOccurrence.success, {
      nodeId: semanticNodeId,
      scopePath: [{
        scopeActivationVersion: 1,
        scopeId: semanticNodeId,
        activation: 0
      }],
      activation: 0
    })

    const firstCompletion = BpmnKernel.resolveTask(
      compiled,
      initialized.success.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        ...target,
        outcome: succeededOutcome()
      },
      services({ repeat: true })
    )
    assert.isTrue(Result.isSuccess(firstCompletion))
    if (Result.isFailure(firstCompletion)) {
      throw firstCompletion.failure
    }
    const secondToken = firstCompletion.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode"
    )
    if (secondToken === undefined) {
      throw new Error("expected second bound loop token")
    }
    const secondOccurrence = BpmnKernel.taskOccurrence(
      compiled,
      firstCompletion.success.state,
      {
        scopeInstanceId: secondToken.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: secondToken.tokenId
      }
    )
    assert.isTrue(Result.isSuccess(secondOccurrence))
    if (Result.isFailure(secondOccurrence)) {
      throw secondOccurrence.failure
    }
    assert.deepStrictEqual(secondOccurrence.success, {
      nodeId: semanticNodeId,
      scopePath: [{
        scopeActivationVersion: 1,
        scopeId: semanticNodeId,
        activation: 0
      }],
      activation: 1
    })
  })

  it("cancels and replays a bound Standard Loop before routing its Boundary Error", () => {
    const errorRef = "error-loop-business"
    const definition = standardLoopModel(false, 3)
    definition.errors = [{
      id: errorRef,
      errorCode: "LOOP_BUSINESS"
    }]
    definition.flowNodes.push(
      boundaryError(
        "boundary-loop-error",
        "task-loop",
        "flow-boundary-loop-end",
        errorRef
      ),
      endEvent(
        "end-loop-error",
        processId,
        ["flow-boundary-loop-end"]
      )
    )
    definition.sequenceFlows.push(
      flow(
        "flow-boundary-loop-end",
        processId,
        "boundary-loop-error",
        "end-loop-error",
        "normal"
      )
    )
    const compiled = compile(definition, [
      taskBinding("task-loop", [{
        errorTag: "LoopBusinessFailure",
        errorCode: "REJECTED",
        errorRef
      }])
    ])
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const token = initialized.success.state.tokens.find((candidate) =>
      candidate.status === "active" &&
      candidate.position._tag === "AtNode"
    )
    if (token === undefined) {
      throw new Error("expected bound loop token")
    }
    const resolved = BpmnKernel.resolveTask(
      compiled,
      initialized.success.state,
      {
        commandVersion: BpmnActivityV3.CommandVersion,
        scopeInstanceId: token.scopeInstanceId,
        taskNodeId: "task-loop",
        tokenId: token.tokenId,
        outcome: failedOutcome(
          "LoopBusinessFailure",
          "REJECTED"
        )
      },
      services()
    )
    assert.isTrue(Result.isSuccess(resolved))
    if (Result.isFailure(resolved)) {
      throw resolved.failure
    }
    assert.strictEqual(resolved.success.state.status, "completed")
    assert.deepStrictEqual(
      resolved.success.state.loopFrames.map((frame) => ({
        completedIterations: frame.completedIterations,
        status: frame.status
      })),
      [{
        completedIterations: 0,
        status: "cancelled"
      }]
    )
    const causalTags = resolved.success.events.map((event) => event._tag)
    assert(
      causalTags.indexOf("LoopFrameCancelled") >
        causalTags.indexOf("TokenWithdrawn")
    )
    assert(
      causalTags.indexOf("BoundaryErrorCaught") >
        causalTags.indexOf("LoopFrameCancelled")
    )
    const replayed = BpmnKernel.replay(compiled, [
      ...initialized.success.events,
      ...resolved.success.events
    ])
    assert.isTrue(Result.isSuccess(replayed))
    if (Result.isFailure(replayed)) {
      throw replayed.failure
    }
    assert.deepStrictEqual(replayed.success, resolved.success.state)
  })

  it("rejects duplicate arrivals recorded in the same join epoch", () => {
    const compiled = compile(model(
      [
        startEvent("start", processId, ["flow-start-split"]),
        gateway("gateway-split", "parallel", "diverging", ["flow-start-split"], [
          "flow-split-a",
          "flow-split-b"
        ]),
        task("task-a", processId, ["flow-split-a"], ["flow-a-join"]),
        task("task-b", processId, ["flow-split-b"], ["flow-b-join"]),
        gateway("gateway-join", "parallel", "converging", ["flow-a-join", "flow-b-join"], ["flow-join-after"]),
        task("task-after", processId, ["flow-join-after"], [])
      ],
      [
        flow("flow-start-split", processId, "start", "gateway-split", "normal"),
        flow("flow-split-a", processId, "gateway-split", "task-a", "normal"),
        flow("flow-split-b", processId, "gateway-split", "task-b", "normal"),
        flow("flow-a-join", processId, "task-a", "gateway-join", "normal"),
        flow("flow-b-join", processId, "task-b", "gateway-join", "normal"),
        flow("flow-join-after", processId, "gateway-join", "task-after", "normal")
      ]
    ))
    const initialized = initializeKernel(compiled, services())
    assert.isTrue(Result.isSuccess(initialized))
    if (Result.isFailure(initialized)) {
      throw initialized.failure
    }
    const tokenA = initialized.success.state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "AtNode" && token.position.nodeId === "task-a"
    )
    if (tokenA === undefined) {
      throw new Error("expected task-a token")
    }
    const partial = BpmnKernel.completeTask(
      compiled,
      initialized.success.state,
      {
        scopeInstanceId: tokenA.scopeInstanceId,
        taskNodeId: "task-a",
        tokenId: tokenA.tokenId
      },
      services()
    )
    assert.isTrue(Result.isSuccess(partial))
    if (Result.isFailure(partial)) {
      throw partial.failure
    }
    const tampered = structuredClone(partial.success.state)
    tampered.gatewayFrames[0]!.arrivedIncomingSequenceFlowIds = ["flow-a-join", "flow-a-join"]
    const advanced = BpmnKernel.advance(compiled, tampered, services())
    assert.isTrue(Result.isFailure(advanced))
    if (Result.isSuccess(advanced)) {
      throw new Error("expected duplicate join arrival rejection")
    }
    assert.isTrue(
      advanced.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnExecutionState.Codes.InvalidGatewayFrame
      )
    )
  })
})
