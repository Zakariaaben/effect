import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { createHash } from "node:crypto"
import * as BpmnHistory from "../src/BpmnHistory.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import type * as BpmnModel from "../src/BpmnModel.ts"

const now = "2026-07-23T10:00:00.000Z" as const
const processId = "process-history"

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const model = (taskName?: string): BpmnModel.BpmnModel => ({
  modelKind: "BpmnModel",
  modelVersion: 1,
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
      id: "task",
      processId,
      parentScopeId: processId,
      ...(taskName === undefined ? undefined : { name: taskName }),
      taskKind: "generic",
      incomingSequenceFlowIds: ["flow-start-task"],
      outgoingSequenceFlowIds: ["flow-task-end"],
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
      targetId: "task",
      kind: "normal",
      extensionElements: []
    },
    {
      id: "flow-task-end",
      processId,
      parentScopeId: processId,
      sourceId: "task",
      targetId: "end",
      kind: "normal",
      extensionElements: []
    }
  ]
})

const prepare = (input: BpmnModel.BpmnModel): BpmnKernel.CompiledKernel =>
  Effect.runSync(
    BpmnKernel.prepare(input, {
      profileId: "history-test-v1",
      rootProcessId: processId,
      limits: {
        maxAutomaticTransitions: 100,
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
        maxMultiInstanceCardinality: 128,
        maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
        maxMultiInstanceItemCanonicalBytes: 262_144,
        maxMultiInstanceOutputCanonicalBytes: 1_048_576,
        maxMultiInstanceItemOutputCanonicalBytes: 262_144
      },
      evaluatorBindings: []
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  )

const withCrypto = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Crypto.Crypto>> => effect.pipe(Effect.provideService(Crypto.Crypto, testCrypto))

describe("BpmnHistory", () => {
  it.effect("seals and verifies a complete exact-model journal", () =>
    Effect.gen(function*() {
      const kernel = prepare(model())
      const initialized = BpmnKernel.initialize(
        kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: null
        },
        { now }
      )
      assert(Result.isSuccess(initialized))

      const sealed = yield* BpmnHistory.seal(
        kernel,
        initialized.success.events
      )
      const replayed = yield* BpmnHistory.replay(kernel, sealed)

      assert.deepStrictEqual(replayed, initialized.success.state)
      assert.deepStrictEqual(sealed.model, kernel.modelReference)
      assert.match(sealed.historyDigest, /^sha256:[0-9a-f]{64}$/)
      assert.isTrue(Object.isFrozen(sealed))
      assert.isTrue(Object.isFrozen(sealed.events))

      const resealed = yield* BpmnHistory.seal(kernel, sealed.events)
      assert.strictEqual(resealed.historyDigest, sealed.historyDigest)
    }).pipe(withCrypto))

  it.effect("detects payload and digest corruption before kernel replay", () =>
    Effect.gen(function*() {
      const kernel = prepare(model())
      const initialized = BpmnKernel.initialize(
        kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: null
        },
        { now }
      )
      assert(Result.isSuccess(initialized))
      const sealed = yield* BpmnHistory.seal(
        kernel,
        initialized.success.events
      )

      const changedEvent = structuredClone(sealed)
      const emitted = changedEvent.events.find((event) => event._tag === "TokenEmitted")
      if (emitted?._tag !== "TokenEmitted") {
        throw new Error("expected token emission")
      }
      emitted.tokenId = "token:forged"

      const changedDigest = structuredClone(sealed)
      changedDigest.historyDigest = `sha256:${"f".repeat(64)}` as typeof changedDigest.historyDigest

      for (const candidate of [changedEvent, changedDigest]) {
        const result = yield* BpmnHistory.replay(
          kernel,
          candidate
        ).pipe(Effect.result)
        assert(Result.isFailure(result))
        assert.instanceOf(result.failure, BpmnHistory.BpmnHistoryError)
        assert.strictEqual(
          result.failure.code,
          BpmnHistory.Codes.HistoryDigestMismatch
        )
      }
    }).pipe(withCrypto))

  it.effect("rejects cross-model, headerless, and hostile artifacts", () =>
    Effect.gen(function*() {
      const kernel = prepare(model())
      const changedKernel = prepare(model("changed semantic name"))
      const initialized = BpmnKernel.initialize(
        kernel,
        {
          commandVersion: BpmnKernel.InitializeCommandVersion,
          input: null
        },
        { now }
      )
      assert(Result.isSuccess(initialized))
      const sealed = yield* BpmnHistory.seal(
        kernel,
        initialized.success.events
      )

      const crossed = yield* BpmnHistory.replay(
        changedKernel,
        sealed
      ).pipe(Effect.result)
      assert(Result.isFailure(crossed))
      assert(
        "diagnostics" in crossed.failure &&
          crossed.failure.diagnostics.some((diagnostic) =>
            diagnostic.code === BpmnKernel.Codes.BpmnJournalModelMismatch
          )
      )

      const headerless = yield* BpmnHistory.seal(
        kernel,
        initialized.success.events.slice(1)
      ).pipe(Effect.result)
      assert(Result.isFailure(headerless))

      let getterRead = false
      const hostile = Object.defineProperty({}, "events", {
        enumerable: true,
        get() {
          getterRead = true
          return sealed.events
        }
      })
      const rejected = yield* BpmnHistory.replay(
        kernel,
        hostile
      ).pipe(Effect.result)
      assert(Result.isFailure(rejected))
      assert.instanceOf(rejected.failure, BpmnHistory.BpmnHistoryError)
      assert.isFalse(getterRead)
    }).pipe(withCrypto))
})
