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
import type * as BpmnExpression from "../src/BpmnExpression.ts"
import * as Evaluator from "../src/BpmnExpressionEvaluator.ts"
import * as Runtime from "../src/BpmnExpressionRuntime.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"

const processId = "process-main"
const now = "2026-07-23T10:00:00.000Z" as const
const emptyExtensions = (): Array<BpmnModel.ExtensionElement> => []

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const buildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(`sha256:${"1".repeat(64)}`)

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

const prepare = (
  model: BpmnModel.BpmnModel,
  evaluatorBinding: BpmnExpression.EvaluatorBinding
): Effect.Effect<BpmnKernel.CompiledKernel, unknown> =>
  BpmnKernel.prepare(model, {
    profileId: "runtime-test-v1",
    rootProcessId: processId,
    limits: { maxAutomaticTransitions: 1_000 },
    evaluatorBindings: model.sequenceFlows.some((candidate) => candidate.condition !== undefined)
      ? [evaluatorBinding]
      : []
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

describe("BpmnExpressionRuntime", () => {
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
        Runtime.initialize(kernel, services),
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

  it.effect("fails when the complete compiled binding is absent", () =>
    Effect.gen(function*() {
      const kernel = yield* prepare(gatewayModel(), binding())
      const registry = yield* Evaluator.makeMemory([])
      const result = yield* provideRegistry(
        Runtime.initialize(kernel, { now }),
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
          Runtime.initialize(kernel, { now }),
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
        Runtime.initialize(kernel, { now }),
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
        Runtime.initialize(kernel, { now }),
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
        Runtime.initialize(kernel, { now }),
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
        Runtime.initialize(kernel, { now }),
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
        Runtime.initialize(kernel, { now }),
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
