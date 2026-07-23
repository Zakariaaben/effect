import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

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
  evaluateCondition: ({ expression }) =>
    Result.succeed({
      result: decisions[expression.source] ?? false,
      steps: 1
    })
})

const limits: BpmnKernel.KernelLimits = {
  maxAutomaticTransitions: 1_000
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() =>
      new Uint8Array(createHash("sha256").update(data).digest())
    )
})

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"1".repeat(64)}`)

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

const prepareResult = (
  value: BpmnModel.BpmnModel,
  selectedLimits: BpmnKernel.KernelLimits = limits,
  profileId = "test-bpmn-model-v1",
  selectedEvaluatorBindings = evaluatorBindings(value)
): Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnKernel.prepare(value, {
      profileId,
      rootProcessId: processId,
      limits: selectedLimits,
      evaluatorBindings: selectedEvaluatorBindings
    }).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
) as Result.Result<BpmnKernel.CompiledKernel, Diagnostic.CompilationError>

const compile = (value: BpmnModel.BpmnModel): BpmnKernel.CompiledKernel => {
  const compiled = prepareResult(value)
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

    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const conditionEvents = routed.success.events.filter((event) =>
      event._tag === "ConditionEvaluated"
    )
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
    const usageEvent = changedUsage.find((event) =>
      event._tag === "ConditionEvaluated"
    )
    if (usageEvent?._tag !== "ConditionEvaluated") {
      throw new Error("expected condition event")
    }
    usageEvent.usage.contextCanonicalBytes++
    const changedBinding = structuredClone(committedJournal)
    const bindingEvent = changedBinding.find((event) =>
      event._tag === "ConditionEvaluated"
    )
    if (bindingEvent?._tag !== "ConditionEvaluated") {
      throw new Error("expected condition event")
    }
    bindingEvent.evaluatorBinding.build.deploymentId =
      "forged-deployment"
    for (const forged of [changedUsage, changedBinding]) {
      const rejected = BpmnKernel.replay(compiled, forged)
      assert(Result.isFailure(rejected))
      assert(
        rejected.failure.diagnostics.some((diagnostic) =>
          diagnostic.code === BpmnKernel.Codes.InvalidTransitionJournal
        )
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

    const defaultInit = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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

    const initialized = BpmnKernel.initialize(compiled, services({ first: true, second: true }))
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
    assert(Result.isSuccess(initialized))
    assert.deepStrictEqual(activeNodeIds(initialized.success.state), ["task"])
    const forged = { ...compiled }
    const forgedResult = BpmnKernel.initialize(forged, services())
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
        evaluateCondition: ({ state }) => {
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
    const hostile = BpmnKernel.initialize(compiled, hostileServices)
    assert(Result.isFailure(hostile))
    assert.isFalse(getterRead)
    assert(
      hostile.failure.diagnostics.some((diagnostic) => diagnostic.code === BpmnKernel.Codes.InvalidServices)
    )

    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
      maxAutomaticTransitions: limits.maxAutomaticTransitions + 1
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
    assert(Result.isSuccess(changedProfile))
    assert(Result.isSuccess(changedLimits))
    assert(Result.isSuccess(changedEvaluator))

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

    const initialized = BpmnKernel.initialize(baseline, services())
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
    tamperedState.model.executableFingerprint =
      alternateExecutableFingerprint
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
    header.model.executableFingerprint =
      alternateExecutableFingerprint
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
      headerless.failure.diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnKernel.Codes.InvalidTransitionJournal
      )
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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

    for (const forged of [nonTaskPosition, auxiliary, wrongRoot]) {
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
      maxAutomaticTransitions: 8
    })
    assert(
      Result.isSuccess(bounded),
      Result.isFailure(bounded)
        ? bounded.failure.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join(",")
        : undefined
    )
    const exceeded = BpmnKernel.initialize(bounded.success, services())
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
    const first = BpmnKernel.initialize(deterministic, services())
    const second = BpmnKernel.initialize(deterministic, services())
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
    const initialized = BpmnKernel.initialize(compiled, services())
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
