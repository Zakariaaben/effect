import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as CommandEventV2 from "../src/CommandEventV2.ts"
import * as Compiler from "../src/Compiler.ts"
import * as DecisionV2 from "../src/DecisionV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DigestV2 from "../src/DigestV2.ts"
import * as DurableStartV2 from "../src/DurableStartV2.ts"
import type * as EventV2 from "../src/EventV2.ts"
import * as ExternalEventV2 from "../src/ExternalEventV2.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as IdentityV2 from "../src/IdentityV2.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStoreV2 from "../src/PlanStoreV2.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunStateV2 from "../src/RunStateV2.ts"
import * as Workflow from "../src/Workflow.ts"

const tenantId = "tenant-protocol-v2"
const runId = "run-protocol-v2"
const nodeId = "transform"
const contract = "protocol-v2/text"
const epoch = Date.parse("2026-07-23T00:00:00.000Z")
const time = (millis: number): EventV2.Timestamp => new Date(epoch + millis).toISOString()

const transform = Node.make("ProtocolV2Transform", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract })
  },
  outputs: {
    value: Port.output(Schema.String, { contract })
  }
})

const definition = Workflow.make("protocol-v2-integration", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, { contract })
  },
  outputs: {
    value: Port.input(Schema.String, { contract })
  },
  nodes: Registry.make(transform),
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 8,
    maxEdges: 8,
    maxFanIn: 4,
    maxFanOut: 4,
    maxDepth: 4
  })
})

const graphPlan = {
  formatVersion: 1,
  id: "protocol-v2-integration-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    {
      id: nodeId,
      type: transform.type,
      version: transform.version,
      config: {}
    }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "workflow-transform",
      source: {
        _tag: "WorkflowInput" as const,
        input: "value"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId,
        input: "value"
      }
    },
    {
      _tag: "DataEdge" as const,
      id: "transform-workflow",
      source: {
        _tag: "NodeOutput" as const,
        nodeId,
        output: "value"
      },
      target: {
        _tag: "WorkflowOutput" as const,
        output: "value"
      }
    }
  ]
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (
          output[index % output.length]! +
          data[index]! +
          index
        ) & 0xff
      }
      return output
    })
})

const inboxPolicy: PlanStoreV2.PlanArtifact["signalManifest"]["inboxPolicy"] = {
  policyVersion: 1,
  maxAcceptedCount: 100,
  maxPendingCount: 100,
  maxPendingEncodedBytes: 65_536,
  maxItemEncodedBytes: 4_096,
  maxSignalIdBytes: 64,
  maxCorrelationKeyBytes: 64,
  maxPendingWaits: 100,
  maxTtlMillis: 60_000,
  deduplicationScope: "RunLifetime",
  receiptRetentionAfterTerminalMillis: 60_000,
  overflow: { _tag: "Reject" }
}

interface PolicyOptions {
  readonly maximumAttempts?: number
  readonly retryEncodedFailure?: boolean
  readonly retryDelayMillis?: number
  readonly scheduleToStart?: ActivityPolicy.Timeout
  readonly startToClose?: ActivityPolicy.Timeout
  readonly scheduleToClose?: ActivityPolicy.Timeout
}

const policy = (
  options: PolicyOptions = {}
): ActivityPolicy.Policy => ({
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: options.maximumAttempts ?? 2,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: options.retryEncodedFailure ?? true,
      scheduleToStartTimeout: true,
      startToCloseTimeout: true
    },
    backoff: {
      _tag: "Fixed",
      delayMillis: options.retryDelayMillis ?? 1_000
    },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: options.scheduleToStart ?? { _tag: "Disabled" },
    startToClose: options.startToClose ?? { _tag: "Disabled" },
    scheduleToClose: options.scheduleToClose ?? { _tag: "Disabled" }
  }
})

const catalog = (): Deployment.DeploymentCatalog.Service => {
  const deployments = Deployment.fromEntries({
    workflowDefinitions: [
      Deployment.workflowDefinition("protocol-v2-workflow-build", definition)
    ],
    handlerDefinitions: [
      Deployment.handlerDefinition("protocol-v2-transform-build", transform)
    ]
  })
  if (Result.isFailure(deployments)) {
    throw deployments.failure
  }
  return deployments.success
}

const fixture = Effect.fnUntraced(function*(
  activityPolicy: ActivityPolicy.Policy
) {
  const compiled = yield* Compiler.compile(definition, graphPlan)
  const fingerprintDocument = Fingerprint.materialize(compiled)
  const compiledFingerprint = yield* DigestV2.compiledPlan(
    fingerprintDocument as unknown as Schema.Json
  )
  const artifact: PlanStoreV2.PlanArtifact = {
    artifactVersion: 2,
    executionProtocolVersion: 2,
    fingerprintDocument,
    compiledFingerprint,
    definitionDeploymentId: "protocol-v2-workflow-build",
    dispatchTargets: {
      [nodeId]: {
        queue: "protocol-v2",
        deploymentId: "protocol-v2-transform-build"
      }
    },
    activityPolicies: {
      [nodeId]: activityPolicy
    },
    signalManifest: {
      catalogVersion: 1,
      definitions: [],
      inboxPolicy
    }
  }
  const plan = yield* DecisionV2.prepare(compiled, artifact)
  const start = yield* DurableStartV2.prepare(
    plan,
    { value: "seed" },
    {
      tenantId,
      runId,
      workflowIdentity: "protocol-v2:seed",
      requestId: "start-protocol-v2"
    }
  ).pipe(
    Effect.provideService(Deployment.DeploymentCatalog, catalog())
  )
  return { plan, start }
})

const runStarted = (
  plan: DecisionV2.DecidablePlan,
  start: DurableStartV2.PreparedStart
): EventV2.Event => ({
  eventVersion: 2,
  tenantId: start.wire.key.tenantId,
  eventId: IdentityV2.runStartedEventId(
    start.wire.key.tenantId,
    start.wire.key.runId
  ),
  runId: start.wire.key.runId,
  sequence: 0,
  recordedAt: time(0),
  payload: {
    _tag: "RunStarted",
    executionProtocolVersion: 2,
    artifactVersion: 2,
    artifactDigest: start.wire.artifactDigest,
    workflowIdentity: start.wire.workflowIdentity,
    startRequestId: start.wire.requestId,
    planId: plan.compiled.plan.id,
    planRevision: plan.compiled.plan.revision,
    definitionId: plan.compiled.definition.id,
    definitionVersion: plan.compiled.definition.version,
    compilerVersion: plan.compilerVersion,
    compiledFingerprint: plan.compiledFingerprint,
    backend: "durable",
    input: start.wire.input
  }
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(
    Result.isSuccess(result),
    Result.isFailure(result) ? String(result.failure) : undefined
  )
  return result.success
}

const commands = (
  plan: DecisionV2.DecidablePlan,
  state: RunStateV2.RunState
) => success(DecisionV2.decide(plan, state))

const materialize = (
  state: RunStateV2.RunState,
  batch: ReadonlyArray<unknown>,
  recordedAt: EventV2.Timestamp
) => success(CommandEventV2.materialize(state, batch, recordedAt))

const attemptOwner = (attempt: number) => ({
  key: { tenantId, runId },
  logicalActivityId: IdentityV2.logicalActivityId(
    tenantId,
    runId,
    nodeId
  ),
  attemptId: IdentityV2.activityAttemptId(
    tenantId,
    runId,
    nodeId,
    attempt
  ),
  attempt
})

describe("ProtocolV2 integration", () => {
  it.effect("rejects a reconstructed batch with canonical command identities", () =>
    fixture(policy()).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.map(({ plan, start }) => {
        const state = success(RunStateV2.fold([runStarted(plan, start)]))
        const decided = commands(plan, state)

        assert.isTrue(Result.isSuccess(
          CommandEventV2.materialize(state, decided, time(100))
        ))

        const reconstructed = decided.map((command) => ({
          ...command,
          payload: { ...command.payload }
        }))
        const rejected = CommandEventV2.materialize(
          state,
          reconstructed,
          time(100)
        )
        assert.isTrue(Result.isFailure(rejected))
        if (Result.isFailure(rejected)) {
          assert.strictEqual(
            rejected.failure.code,
            CommandEventV2.Codes.InvalidCommandBatch
          )
        }
      })
    ))

  it.effect("joins prepared start, decisions, worker facts, cleanup, and terminal replay", () =>
    fixture(policy({
      scheduleToStart: { _tag: "After", durationMillis: 10_000 },
      startToClose: { _tag: "After", durationMillis: 20_000 },
      scheduleToClose: { _tag: "After", durationMillis: 30_000 }
    })).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.map(({ plan, start }) => {
        assert.isTrue(DurableStartV2.isPrepared(start))
        const history: Array<EventV2.Event> = [runStarted(plan, start)]
        let state = success(RunStateV2.fold(history))

        const scheduled = materialize(
          state,
          commands(plan, state),
          time(100)
        )
        assert.deepStrictEqual(
          scheduled.events.map((event) => event.payload._tag),
          ["ActivityScheduled", "TimerScheduled", "TimerScheduled"]
        )
        history.push(...scheduled.events)
        state = scheduled.state

        const started = success(ExternalEventV2.recordActivityStarted(
          state,
          attemptOwner(1),
          time(200)
        ))
        assert.deepStrictEqual(
          started.events.map((event) => event.payload._tag),
          ["ActivityAttemptStarted", "TimerCancelled", "TimerScheduled"]
        )
        history.push(...started.events)
        state = started.state

        const completed = success(ExternalEventV2.completeActivityAttempt(
          state,
          {
            ...attemptOwner(1),
            completion: {
              _tag: "Succeeded",
              output: { value: "done" }
            }
          },
          time(300)
        ))
        assert.deepStrictEqual(
          completed.events.map((event) => event.payload._tag),
          ["ActivitySucceeded", "TimerCancelled", "TimerCancelled"]
        )
        history.push(...completed.events)
        state = completed.state

        const terminal = materialize(
          state,
          commands(plan, state),
          time(400)
        )
        assert.deepStrictEqual(
          terminal.events.map((event) => event.payload._tag),
          ["RunSucceeded"]
        )
        history.push(...terminal.events)
        state = terminal.state

        assert.strictEqual(state.status, "Succeeded")
        if (state.status === "Succeeded") {
          assert.deepStrictEqual(state.output, { value: "done" })
        }
        assert.strictEqual(commands(plan, state).length, 0)

        const replayed = success(RunStateV2.fold(history))
        assert.strictEqual(replayed.status, "Succeeded")
        assert.strictEqual(replayed.sequence, state.sequence)
        assert.strictEqual(replayed.lastRecordedAt, state.lastRecordedAt)
        assert.strictEqual(
          HashSet.size(replayed.seenEventIds),
          history.length
        )
      })
    ))

  it.effect("anchors retry time to history and executes the next semantic attempt", () =>
    fixture(policy({
      maximumAttempts: 2,
      retryEncodedFailure: true,
      retryDelayMillis: 1_000
    })).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.map(({ plan, start }) => {
        const history: Array<EventV2.Event> = [runStarted(plan, start)]
        let state = success(RunStateV2.fold(history))

        const scheduled = materialize(
          state,
          commands(plan, state),
          time(100)
        )
        history.push(...scheduled.events)
        state = scheduled.state

        const started = success(ExternalEventV2.recordActivityStarted(
          state,
          attemptOwner(1),
          time(200)
        ))
        history.push(...started.events)
        state = started.state

        const failed = success(ExternalEventV2.completeActivityAttempt(
          state,
          {
            ...attemptOwner(1),
            completion: {
              _tag: "Failed",
              failure: { _tag: "Transient" }
            }
          },
          time(300)
        ))
        history.push(...failed.events)
        state = failed.state

        const retry = materialize(
          state,
          commands(plan, state),
          time(400)
        )
        assert.deepStrictEqual(
          retry.events.map((event) => event.payload._tag),
          ["RetryScheduled", "TimerScheduled"]
        )
        history.push(...retry.events)
        state = retry.state

        const retryTimer = Array.from(HashMap.values(state.timers)).find(
          (timer) =>
            timer.status === "Pending" &&
            timer.purpose._tag === "RetryBackoff"
        )
        assert.isDefined(retryTimer)
        assert.strictEqual(retryTimer!.deadline, time(1_300))

        const fired = success(ExternalEventV2.fireTimer(
          state,
          {
            key: { tenantId, runId },
            timerId: retryTimer!.timerId
          },
          time(1_300)
        ))
        history.push(...fired.events)
        state = fired.state

        const secondSchedule = materialize(
          state,
          commands(plan, state),
          time(1_400)
        )
        assert.deepStrictEqual(
          secondSchedule.events.map((event) => event.payload._tag),
          ["ActivityScheduled"]
        )
        history.push(...secondSchedule.events)
        state = secondSchedule.state

        const secondStarted = success(ExternalEventV2.recordActivityStarted(
          state,
          attemptOwner(2),
          time(1_500)
        ))
        history.push(...secondStarted.events)
        state = secondStarted.state

        const secondCompleted = success(
          ExternalEventV2.completeActivityAttempt(
            state,
            {
              ...attemptOwner(2),
              completion: {
                _tag: "Succeeded",
                output: { value: "retried" }
              }
            },
            time(1_600)
          )
        )
        history.push(...secondCompleted.events)
        state = secondCompleted.state

        const terminal = materialize(
          state,
          commands(plan, state),
          time(1_700)
        )
        history.push(...terminal.events)
        state = terminal.state

        assert.strictEqual(state.status, "Succeeded")
        const activity = HashMap.getUnsafe(
          state.activities,
          attemptOwner(2).logicalActivityId
        )
        assert.strictEqual(activity.currentAttempt, 2)
        assert.strictEqual(
          HashMap.getUnsafe(activity.attempts, 1).status,
          "Failed"
        )
        assert.strictEqual(
          HashMap.getUnsafe(activity.attempts, 2).status,
          "Succeeded"
        )

        const replayed = success(RunStateV2.fold(history))
        assert.strictEqual(replayed.status, "Succeeded")
        assert.strictEqual(replayed.sequence, state.sequence)
      })
    ))

  it.effect("cancels a live timed activity through one durable terminal head", () =>
    fixture(policy({
      scheduleToStart: { _tag: "After", durationMillis: 10_000 },
      scheduleToClose: { _tag: "After", durationMillis: 30_000 }
    })).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.map(({ plan, start }) => {
        const started = runStarted(plan, start)
        let state = success(RunStateV2.fold([started]))

        const scheduled = materialize(
          state,
          commands(plan, state),
          time(100)
        )
        state = scheduled.state
        assert.strictEqual(
          Array.from(HashMap.values(state.timers)).filter(
            (timer) => timer.status === "Pending"
          ).length,
          2
        )

        const cancellation = success(ExternalEventV2.requestCancellation(
          state,
          {
            key: { tenantId, runId },
            requestId: "cancel-live-timed-run"
          },
          time(200)
        ))
        assert.deepStrictEqual(
          cancellation.events.map((event) => event.payload._tag),
          [
            "RunCancellationRequested",
            "TimerCancelled",
            "TimerCancelled"
          ]
        )
        state = cancellation.state
        assert.strictEqual(state.status, "CancellationRequested")

        const terminal = materialize(
          state,
          commands(plan, state),
          time(300)
        )
        state = terminal.state
        assert.deepStrictEqual(
          terminal.events.map((event) => event.payload._tag),
          ["RunCancelled"]
        )
        assert.strictEqual(state.status, "Cancelled")
        assert.strictEqual(
          success(RunStateV2.validateDurableHead(state)).sequence,
          state.sequence
        )
        assert.strictEqual(
          HashMap.getUnsafe(
            state.activities,
            attemptOwner(1).logicalActivityId
          ).status,
          "Active"
        )
      })
    ))
})
