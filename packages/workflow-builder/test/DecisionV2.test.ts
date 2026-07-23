import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import type * as Command from "../src/CommandV2.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/DecisionV2.ts"
import * as Digest from "../src/DigestV2.ts"
import type * as Event from "../src/EventV2.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as Identity from "../src/IdentityV2.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStore from "../src/PlanStoreV2.ts"
import * as Port from "../src/Port.ts"
import * as ProtocolWire from "../src/ProtocolV2Wire.ts"
import * as Registry from "../src/Registry.ts"
import * as RunState from "../src/RunStateV2.ts"
import * as Workflow from "../src/Workflow.ts"

const tenantId = "tenant-1"
const runId = "run-1"
const nodeId = "task"
const nodeInstanceId = nodeId
const textContract = "decision-v2/text"
const epoch = Date.parse("2026-07-23T00:00:00.000Z")
const time = (millis: number): Event.Timestamp => new Date(epoch + millis).toISOString()

const task = Node.make("Task", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract: textContract })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: textContract })
  }
})

const definition = Workflow.make("decision-v2-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    value: Port.input(Schema.String, { contract: textContract })
  },
  nodes: Registry.make(task),
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
  id: "decision-v2-plan",
  revision: 2,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    { id: nodeId, type: "Task", version: "1.0.0", config: {} }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "input-task",
      source: { _tag: "WorkflowInput" as const, input: "value" },
      target: { _tag: "NodeInput" as const, nodeId, input: "value" }
    },
    {
      _tag: "DataEdge" as const,
      id: "task-output",
      source: { _tag: "NodeOutput" as const, nodeId, output: "value" },
      target: { _tag: "WorkflowOutput" as const, output: "value" }
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

interface PolicyOptions {
  readonly maximumAttempts?: number
  readonly retryEncodedFailure?: boolean
  readonly delayMillis?: number
  readonly scheduleToStart?: ActivityPolicy.Timeout
  readonly scheduleToClose?: ActivityPolicy.Timeout
}

const policy = (options: PolicyOptions = {}): ActivityPolicy.Policy => ({
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
      delayMillis: options.delayMillis ?? 1_000
    },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: options.scheduleToStart ?? { _tag: "Disabled" },
    startToClose: { _tag: "Disabled" },
    scheduleToClose: options.scheduleToClose ?? { _tag: "Disabled" }
  }
})

const inboxPolicy: PlanStore.PlanArtifact["signalManifest"]["inboxPolicy"] = {
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

const makeFixture = Effect.fnUntraced(function*(
  activityPolicy: ActivityPolicy.Policy = policy()
) {
  const compiled = yield* Compiler.compile(definition, graphPlan)
  const fingerprintDocument = Fingerprint.materialize(compiled)
  const compiledFingerprint = yield* Digest.compiledPlan(
    fingerprintDocument as unknown as Schema.Json
  )
  const artifact: PlanStore.PlanArtifact = {
    artifactVersion: 2,
    executionProtocolVersion: 2,
    fingerprintDocument,
    compiledFingerprint,
    definitionDeploymentId: "decision-v2-build-1",
    dispatchTargets: {
      [nodeId]: {
        queue: "decision-v2",
        deploymentId: "task-build-1"
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
  const plan = yield* Decision.prepare(compiled, artifact)
  return { activityPolicy, artifact, compiled, plan }
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(
    Result.isSuccess(result),
    Result.isFailure(result) ? String(result.failure) : undefined
  )
  return result.success
}

const failure = <A>(
  result: Result.Result<A, Decision.DecisionError>
): Decision.DecisionError => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

const wireEvent = (
  sequence: number,
  payload: Event.Payload,
  eventId: string,
  recordedAt: Event.Timestamp = time(sequence * 100)
): Event.Event => ({
  eventVersion: 2,
  tenantId,
  eventId,
  runId,
  sequence,
  recordedAt,
  payload
})

const runStarted = (
  plan: Decision.DecidablePlan,
  artifactDigest = plan.artifactDigest
): Event.Event =>
  wireEvent(
    0,
    {
      _tag: "RunStarted",
      executionProtocolVersion: 2,
      artifactVersion: 2,
      artifactDigest,
      workflowIdentity: "decision-v2:value",
      startRequestId: "start-request-1",
      planId: plan.compiled.plan.id,
      planRevision: plan.compiled.plan.revision,
      definitionId: plan.compiled.definition.id,
      definitionVersion: plan.compiled.definition.version,
      compilerVersion: plan.compilerVersion,
      compiledFingerprint: plan.compiledFingerprint,
      backend: "durable",
      input: { value: "seed" }
    },
    Identity.runStartedEventId(tenantId, runId),
    time(0)
  )

const logicalActivityId = Identity.logicalActivityId(
  tenantId,
  runId,
  nodeInstanceId
)

const scheduled = (
  sequence: number,
  activityPolicy: ActivityPolicy.Policy
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityScheduled",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      ),
      nodeId,
      nodeInstanceId,
      attempt: 1,
      idempotencyKey: Identity.activityIdempotencyKey(
        tenantId,
        runId,
        nodeInstanceId
      ),
      input: { value: "seed" },
      policy: activityPolicy
    },
    Identity.scheduleActivityCommandId(
      tenantId,
      runId,
      nodeInstanceId,
      1
    )
  )

const attemptStarted = (sequence: number, attempt = 1): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityAttemptStarted",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt
    },
    Identity.activityAttemptStartedEventId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    )
  )

const attemptFailed = (sequence: number, attempt = 1): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityAttemptFailed",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt,
      failure: { _tag: "TransientFailure" }
    },
    Identity.activityAttemptFailedEventId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    )
  )

const activitySucceeded = (
  sequence: number,
  value: string,
  attempt = 1
): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivitySucceeded",
      logicalActivityId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        attempt
      ),
      attempt,
      output: { value }
    },
    Identity.activitySucceededEventId(
      tenantId,
      runId,
      nodeInstanceId,
      attempt
    )
  )

const totalTimer = (
  sequence: number,
  schedule: Event.Event,
  delayMillis: number
): Event.Event => {
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "ScheduleToClose",
    logicalActivityId
  )
  return wireEvent(
    sequence,
    {
      _tag: "TimerScheduled",
      timerId,
      purpose: { _tag: "ScheduleToClose", logicalActivityId },
      anchorEventId: schedule.eventId,
      delayMillis,
      deadline: new Date(
        Date.parse(schedule.recordedAt) + delayMillis
      ).toISOString()
    },
    Identity.scheduleTimerCommandId(tenantId, runId, timerId)
  )
}

const timerCancelled = (
  sequence: number,
  timerId: string,
  reason: Event.TimerCancellationReason
): Event.Event =>
  wireEvent(
    sequence,
    { _tag: "TimerCancelled", timerId, reason },
    Identity.cancelTimerCommandId(tenantId, runId, timerId)
  )

const finalActivityFailure = (sequence: number): Event.Event =>
  wireEvent(
    sequence,
    {
      _tag: "ActivityFailed",
      logicalActivityId,
      nodeId,
      nodeInstanceId,
      attemptId: Identity.activityAttemptId(
        tenantId,
        runId,
        nodeInstanceId,
        1
      ),
      attempt: 1,
      cause: {
        _tag: "EncodedFailure",
        failure: { _tag: "TransientFailure" }
      }
    },
    Identity.finalizeActivityFailureCommandId(
      tenantId,
      runId,
      nodeInstanceId
    )
  )

const requestDigest = Schema.decodeUnknownSync(ProtocolWire.RequestDigest)(
  `sha256:${"a".repeat(64)}`
)
const payloadDigest = Schema.decodeUnknownSync(ProtocolWire.PayloadDigest)(
  `sha256:${"b".repeat(64)}`
)
const definitionDigest = Schema.decodeUnknownSync(
  ProtocolWire.DefinitionDigest
)(`sha256:${"c".repeat(64)}`)

const signalAccepted = (
  sequence: number,
  signalId: string,
  inboxSequence: number
): Event.Event => {
  const acceptedAt = time(sequence * 100)
  const ttlMillis = 10_000
  return wireEvent(
    sequence,
    {
      _tag: "SignalAccepted",
      signalId,
      inboxSequence,
      signalName: "ApprovalGranted",
      signalVersion: "1.0.0",
      correlation: { _tag: "Any" },
      signalDefinitionDigest: definitionDigest,
      requestDigest,
      payload: {
        _tag: "Inline",
        value: { approvedBy: `reviewer-${inboxSequence}` }
      },
      payloadDigest,
      encodedPayloadBytes: 32,
      ttlMillis,
      admission: {
        actorId: `reviewer-${inboxSequence}`,
        policyId: "approval-policy",
        policyVersion: "1.0.0",
        policyDecisionId: `decision-${signalId}`
      },
      expiresAt: new Date(Date.parse(acceptedAt) + ttlMillis).toISOString(),
      expiryTimerId: Identity.timerId(
        tenantId,
        runId,
        "SignalExpiry",
        signalId
      )
    },
    Identity.signalAcceptedEventId(tenantId, runId, signalId),
    acceptedAt
  )
}

const signalExpiryTimer = (
  sequence: number,
  accepted: Event.Event,
  signalId: string,
  inboxSequence: number
): Event.Event => {
  const delayMillis = 10_000
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "SignalExpiry",
    signalId
  )
  return wireEvent(
    sequence,
    {
      _tag: "TimerScheduled",
      timerId,
      purpose: { _tag: "SignalExpiry", signalId, inboxSequence },
      anchorEventId: accepted.eventId,
      delayMillis,
      deadline: new Date(
        Date.parse(accepted.recordedAt) + delayMillis
      ).toISOString()
    },
    Identity.scheduleTimerCommandId(tenantId, runId, timerId)
  )
}

const signalWaitStarted = (
  sequence: number,
  durationMillis: number,
  instanceId = "approval"
): Event.Event => {
  const waitId = Identity.signalWaitId(tenantId, runId, instanceId)
  return wireEvent(
    sequence,
    {
      _tag: "SignalWaitStarted",
      waitId,
      nodeId: instanceId,
      nodeInstanceId: instanceId,
      signalName: "ApprovalGranted",
      signalVersion: "1.0.0",
      correlation: { _tag: "Any" },
      timeout: durationMillis === 0
        ? { _tag: "Disabled" }
        : { _tag: "After", durationMillis }
    },
    Identity.startSignalWaitCommandId(tenantId, runId, instanceId)
  )
}

const signalWaitTimer = (
  sequence: number,
  wait: Event.Event,
  durationMillis: number
): Event.Event => {
  const waitId = Identity.signalWaitId(tenantId, runId, "approval")
  const timerId = Identity.timerId(
    tenantId,
    runId,
    "SignalWaitTimeout",
    waitId
  )
  return wireEvent(
    sequence,
    {
      _tag: "TimerScheduled",
      timerId,
      purpose: {
        _tag: "SignalWaitTimeout",
        waitId,
        nodeInstanceId: "approval"
      },
      anchorEventId: wait.eventId,
      delayMillis: durationMillis,
      deadline: new Date(
        Date.parse(wait.recordedAt) + durationMillis
      ).toISOString()
    },
    Identity.scheduleTimerCommandId(tenantId, runId, timerId)
  )
}

const commandTags = (
  commands: ReadonlyArray<Command.Command>
): ReadonlyArray<Command.Payload["_tag"]> => commands.map((command) => command.payload._tag)

describe("DecisionV2", () => {
  it.effect("prepares exact compiler provenance and rejects hostile artifacts", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture().pipe(
        Effect.provideService(Crypto.Crypto, testCrypto)
      )
      assert.isTrue(Decision.isPrepared(fixture.plan))
      assert.isTrue(Object.isFrozen(fixture.plan))
      assert.strictEqual(
        fixture.plan.artifactDigest,
        yield* Digest.artifact(
          fixture.artifact as unknown as Schema.Json
        ).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
      )

      const copied = { ...fixture.compiled } as typeof fixture.compiled
      const provenanceError = yield* Effect.flip(
        Decision.prepare(copied, fixture.artifact)
      )
      assert.strictEqual(
        provenanceError.code,
        Decision.Codes.PlanProvenanceMismatch
      )

      const documentError = yield* Effect.flip(Decision.prepare(
        fixture.compiled,
        {
          ...fixture.artifact,
          fingerprintDocument: {
            ...fixture.artifact.fingerprintDocument,
            plan: {
              ...fixture.artifact.fingerprintDocument.plan,
              revision: fixture.artifact.fingerprintDocument.plan.revision + 1
            }
          }
        }
      ))
      assert.strictEqual(
        documentError.code,
        Decision.Codes.FingerprintDocumentMismatch
      )

      const fingerprintError = yield* Effect.flip(Decision.prepare(
        fixture.compiled,
        {
          ...fixture.artifact,
          compiledFingerprint: Schema.decodeUnknownSync(
            ProtocolWire.CompiledFingerprint
          )(`sha256:${"e".repeat(64)}`)
        }
      ))
      assert.strictEqual(
        fingerprintError.code,
        Decision.Codes.FingerprintMismatch
      )

      let reads = 0
      const hostile = Object.defineProperty({}, "artifactVersion", {
        enumerable: true,
        get: () => {
          reads++
          return 2
        }
      })
      const hostileError = yield* Effect.flip(
        Decision.prepare(fixture.compiled, hostile)
      )
      assert.strictEqual(hostileError.code, Decision.Codes.InvalidArtifact)
      assert.strictEqual(reads, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("emits frozen initial activity and relative timer commands", () =>
    Effect.gen(function*() {
      const activityPolicy = policy({
        scheduleToStart: { _tag: "After", durationMillis: 2_000 },
        scheduleToClose: { _tag: "After", durationMillis: 10_000 }
      })
      const { plan } = yield* makeFixture(activityPolicy)
      const state = success(RunState.fold([runStarted(plan)]))
      const first = success(Decision.decide(plan, state))
      const second = success(Decision.decide(plan, state))

      assert.deepStrictEqual(first, second)
      assert.deepStrictEqual(commandTags(first), [
        "ScheduleActivityAttempt",
        "ScheduleTimer",
        "ScheduleTimer"
      ])
      assert.isTrue(Object.isFrozen(first))
      assert.isTrue(first.every((item) => Object.isFrozen(item) && Object.isFrozen(item.payload)))
      const scheduleId = first[0]!.commandId
      for (const item of first.slice(1)) {
        assert.strictEqual(
          (item.payload as Command.ScheduleTimer).anchorEventId,
          scheduleId
        )
        assert.notProperty(item.payload, "deadline")
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("selects retry backoff and schedules only the retry attempt after it fires", () =>
    Effect.gen(function*() {
      const activityPolicy = policy({
        maximumAttempts: 2,
        retryEncodedFailure: true,
        delayMillis: 1_000
      })
      const { plan } = yield* makeFixture(activityPolicy)
      const failed = attemptFailed(3)
      const failedState = success(RunState.fold([
        runStarted(plan),
        scheduled(1, activityPolicy),
        attemptStarted(2),
        failed
      ]))
      const retry = success(Decision.decide(plan, failedState))
      assert.deepStrictEqual(commandTags(retry), [
        "ScheduleRetry",
        "ScheduleTimer"
      ])
      const retryPayload = retry[0]!.payload as Command.ScheduleRetry
      const timerPayload = retry[1]!.payload as Command.ScheduleTimer
      assert.strictEqual(retryPayload.anchorEventId, failed.eventId)
      assert.strictEqual(timerPayload.anchorEventId, failed.eventId)
      assert.strictEqual(retryPayload.selectedDelayMillis, 1_000)
      assert.notProperty(timerPayload, "deadline")

      const retryScheduled = wireEvent(
        4,
        {
          ...retryPayload,
          _tag: "RetryScheduled",
          deadline: time(1_300)
        },
        retry[0]!.commandId
      )
      const retryTimer = wireEvent(
        5,
        {
          ...timerPayload,
          _tag: "TimerScheduled",
          deadline: time(1_300)
        },
        retry[1]!.commandId
      )
      const readyState = success(RunState.fold([
        runStarted(plan),
        scheduled(1, activityPolicy),
        attemptStarted(2),
        failed,
        retryScheduled,
        retryTimer,
        wireEvent(
          6,
          { _tag: "TimerFired", timerId: timerPayload.timerId },
          Identity.timerFiredEventId(
            tenantId,
            runId,
            timerPayload.timerId
          ),
          time(1_300)
        )
      ]))
      assert.deepStrictEqual(
        commandTags(success(Decision.decide(plan, readyState))),
        ["ScheduleActivityAttempt"]
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("finalizes a non-retryable failure and later fails the run with cleanup", () =>
    Effect.gen(function*() {
      const activityPolicy = policy({
        maximumAttempts: 3,
        retryEncodedFailure: false,
        scheduleToClose: { _tag: "After", durationMillis: 20_000 }
      })
      const { plan } = yield* makeFixture(activityPolicy)
      const schedule = scheduled(1, activityPolicy)
      const total = totalTimer(2, schedule, 20_000)
      const failedAttempt = attemptFailed(4)
      const active = success(RunState.fold([
        runStarted(plan),
        schedule,
        total,
        attemptStarted(3),
        failedAttempt
      ]))
      const finalize = success(Decision.decide(plan, active))
      assert.deepStrictEqual(commandTags(finalize), [
        "FinalizeActivityFailure",
        "CancelTimer"
      ])
      assert.strictEqual(
        (finalize[1]!.payload as Command.CancelTimer).reason,
        "OwnerFailed"
      )

      const accepted = signalAccepted(5, "signal-pending", 0)
      const expiry = signalExpiryTimer(6, accepted, "signal-pending", 0)
      const wait = signalWaitStarted(7, 0)
      const failed = success(RunState.fold([
        runStarted(plan),
        schedule,
        total,
        attemptStarted(3),
        failedAttempt,
        accepted,
        expiry,
        wait,
        finalActivityFailure(8),
        timerCancelled(
          9,
          (total.payload as Event.TimerScheduled).timerId,
          "OwnerFailed"
        )
      ]))
      const terminal = success(Decision.decide(plan, failed))
      assert.deepStrictEqual(commandTags(terminal), [
        "CancelTimer",
        "FailRun"
      ])
      assert.isFalse(commandTags(terminal).includes("ConsumeSignal"))
      assert.strictEqual(
        (terminal[0]!.payload as Command.CancelTimer).reason,
        "RunTerminal"
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("routes terminal output and cleans pending timers before success", () =>
    Effect.gen(function*() {
      const activityPolicy = policy()
      const { plan } = yield* makeFixture(activityPolicy)
      const accepted = signalAccepted(4, "unused-signal", 0)
      const expiry = signalExpiryTimer(5, accepted, "unused-signal", 0)
      const running = success(RunState.fold([
        runStarted(plan),
        scheduled(1, activityPolicy),
        attemptStarted(2),
        activitySucceeded(3, "done"),
        accepted,
        expiry
      ]))
      const terminal = success(Decision.decide(plan, running))
      assert.deepStrictEqual(commandTags(terminal), [
        "CancelTimer",
        "SucceedRun"
      ])
      assert.deepStrictEqual(
        (terminal[1]!.payload as Command.SucceedRun).output,
        { value: "done" }
      )

      const completed = success(RunState.fold([
        runStarted(plan),
        scheduled(1, activityPolicy),
        attemptStarted(2),
        activitySucceeded(3, "done"),
        accepted,
        expiry,
        timerCancelled(
          6,
          (expiry.payload as Event.TimerScheduled).timerId,
          "RunTerminal"
        ),
        wireEvent(
          7,
          { _tag: "RunSucceeded", output: { value: "done" } },
          Identity.succeedRunCommandId(tenantId, runId)
        )
      ]))
      assert.deepStrictEqual(success(Decision.decide(plan, completed)), [])
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("consumes signals FIFO and cancels expiry and wait timers", () =>
    Effect.gen(function*() {
      const { plan } = yield* makeFixture()
      const first = signalAccepted(1, "signal-1", 0)
      const firstExpiry = signalExpiryTimer(2, first, "signal-1", 0)
      const second = signalAccepted(3, "signal-2", 1)
      const secondExpiry = signalExpiryTimer(4, second, "signal-2", 1)
      const wait = signalWaitStarted(5, 5_000)
      const waitTimer = signalWaitTimer(6, wait, 5_000)
      const state = success(RunState.fold([
        runStarted(plan),
        first,
        firstExpiry,
        second,
        secondExpiry,
        wait,
        waitTimer
      ]))
      const commands = success(Decision.decide(plan, state))
      assert.deepStrictEqual(commandTags(commands), [
        "ConsumeSignal",
        "CancelTimer",
        "CancelTimer"
      ])
      assert.strictEqual(
        (commands[0]!.payload as Command.ConsumeSignal).signalId,
        "signal-1"
      )
      assert.strictEqual(
        (commands[1]!.payload as Command.CancelTimer).timerId,
        (firstExpiry.payload as Event.TimerScheduled).timerId
      )
      assert.strictEqual(
        (commands[2]!.payload as Command.CancelTimer).timerId,
        (waitTimer.payload as Event.TimerScheduled).timerId
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("assigns competing signal waits in committed start order", () =>
    Effect.gen(function*() {
      const { plan } = yield* makeFixture()
      const firstWait = signalWaitStarted(1, 0, "z-first")
      const secondWait = signalWaitStarted(2, 0, "a-second")
      const accepted = signalAccepted(3, "signal-1", 0)
      const expiry = signalExpiryTimer(4, accepted, "signal-1", 0)
      const state = success(RunState.fold([
        runStarted(plan),
        firstWait,
        secondWait,
        accepted,
        expiry
      ]))
      const commands = success(Decision.decide(plan, state))
      assert.deepStrictEqual(commandTags(commands), [
        "ConsumeSignal",
        "CancelTimer"
      ])
      assert.strictEqual(
        (commands[0]!.payload as Command.ConsumeSignal).nodeInstanceId,
        "z-first"
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("makes committed wait timeout failure outrank a retryable activity", () =>
    Effect.gen(function*() {
      const activityPolicy = policy({
        maximumAttempts: 2,
        retryEncodedFailure: true
      })
      const { plan } = yield* makeFixture(activityPolicy)
      const wait = signalWaitStarted(4, 1_000)
      const waitTimer = signalWaitTimer(5, wait, 1_000)
      const timerId = (waitTimer.payload as Event.TimerScheduled).timerId
      const state = success(RunState.fold([
        runStarted(plan),
        scheduled(1, activityPolicy),
        attemptStarted(2),
        attemptFailed(3),
        wait,
        waitTimer,
        wireEvent(
          6,
          { _tag: "TimerFired", timerId },
          Identity.timerFiredEventId(tenantId, runId, timerId),
          time(1_400)
        )
      ]))
      assert.deepStrictEqual(
        commandTags(success(Decision.decide(plan, state))),
        ["FailRun"]
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("propagates cancellation with a canonical terminal command", () =>
    Effect.gen(function*() {
      const { plan } = yield* makeFixture()
      const requestId = "cancel-request-1"
      const requested = success(RunState.fold([
        runStarted(plan),
        wireEvent(
          1,
          { _tag: "RunCancellationRequested", requestId },
          Identity.runCancellationRequestedEventId(
            tenantId,
            runId,
            requestId
          )
        )
      ]))
      const commands = success(Decision.decide(plan, requested))
      assert.deepStrictEqual(commandTags(commands), ["CancelRun"])
      assert.strictEqual(
        commands[0]!.commandId,
        Identity.cancelRunCommandId(tenantId, runId)
      )

      const cancelled = success(RunState.fold([
        runStarted(plan),
        wireEvent(
          1,
          { _tag: "RunCancellationRequested", requestId },
          Identity.runCancellationRequestedEventId(
            tenantId,
            runId,
            requestId
          )
        ),
        wireEvent(
          2,
          { _tag: "RunCancelled" },
          Identity.cancelRunCommandId(tenantId, runId)
        )
      ]))
      assert.deepStrictEqual(success(Decision.decide(plan, cancelled)), [])
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("rejects forged provenance, identity pins, policies, and hostile state", () =>
    Effect.gen(function*() {
      const activityPolicy = policy()
      const fixture = yield* makeFixture(activityPolicy)
      const initial = success(RunState.fold([runStarted(fixture.plan)]))

      assert.strictEqual(
        failure(Decision.decide(
          { ...fixture.plan } as Decision.DecidablePlan,
          initial
        )).code,
        Decision.Codes.InvalidPreparedPlan
      )

      let reads = 0
      const hostile = Object.defineProperty({}, "tenantId", {
        enumerable: true,
        get: () => {
          reads++
          return tenantId
        }
      })
      assert.strictEqual(
        failure(Decision.decide(fixture.plan, hostile)).code,
        Decision.Codes.StateProvenanceMismatch
      )
      assert.strictEqual(reads, 0)

      const wrongDigest = Schema.decodeUnknownSync(
        ProtocolWire.ArtifactDigest
      )(`sha256:${"f".repeat(64)}`)
      const wrongArtifact = success(RunState.fold([
        runStarted(fixture.plan, wrongDigest)
      ]))
      assert.strictEqual(
        failure(Decision.decide(fixture.plan, wrongArtifact)).code,
        Decision.Codes.ArtifactIdentityMismatch
      )

      const wrongPolicy = policy({ maximumAttempts: 9 })
      const policyState = success(RunState.fold([
        runStarted(fixture.plan),
        scheduled(1, wrongPolicy)
      ]))
      assert.strictEqual(
        failure(Decision.decide(fixture.plan, policyState)).code,
        Decision.Codes.ActivityPolicyMismatch
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
