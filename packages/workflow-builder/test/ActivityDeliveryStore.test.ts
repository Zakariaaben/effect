import { assert, describe, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityDeliveryStore from "../src/ActivityDeliveryStore.ts"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Deployment from "../src/Deployment.ts"
import * as Dispatch from "../src/Dispatch.ts"
import * as DurableStart from "../src/DurableStart.ts"
import type * as Event from "../src/Event.ts"
import * as ExecutionStore from "../src/ExecutionStore.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import type * as RunCoordinatorStore from "../src/RunCoordinatorStore.ts"
import * as Workflow from "../src/Workflow.ts"

const digestBytes = (data: Uint8Array): Uint8Array => {
  const output = new Uint8Array(32)
  for (let index = 0; index < data.length; index++) {
    const position = index % output.length
    output[position] = ((output[position]! * 33) ^ data[index]! ^ index) & 0xff
  }
  return output
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(digestBytes(data))
})

const clock = (millis: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  sleep: () => Effect.void
})

const at = <A, E, R>(millis: number, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Clock.Clock, clock(millis)))

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const contract = "activity-delivery/json"

const task = Node.make("DeliveryTask", {
  version: "1.0.0",
  inputs: {
    payload: Port.input(Schema.Json, { contract })
  },
  outputs: {}
})

const definition = Workflow.make("activity-delivery-workflow", {
  version: "1.0.0",
  inputs: {
    payload: Port.output(Schema.Json, { contract })
  },
  outputs: {},
  nodes: Registry.make(task),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "activity-delivery-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "task",
    type: task.type,
    version: task.version,
    config: {}
  }],
  edges: [{
    _tag: "DataEdge" as const,
    id: "payload-task",
    source: { _tag: "WorkflowInput" as const, input: "payload" },
    target: { _tag: "NodeInput" as const, nodeId: "task", input: "payload" }
  }]
}

const scheduleCommand = (runId: string): Dispatch.ScheduleActivityCommand => ({
  commandVersion: 1,
  commandId: Command.scheduleActivityCommandId(runId, "task", 1),
  payload: {
    _tag: "ScheduleActivity",
    activityId: Command.activityId(runId, "task", 1),
    nodeId: "task",
    nodeInstanceId: "task",
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey(runId, "task"),
    input: { payload: { id: "document-1" } }
  }
})

const scheduleEvent = (
  command: Dispatch.ScheduleActivityCommand
): HistoryStore.EventDraft<Event.ActivityScheduled> => ({
  eventVersion: 1,
  eventId: command.commandId,
  payload: {
    _tag: "ActivityScheduled",
    activityId: command.payload.activityId,
    nodeId: command.payload.nodeId,
    nodeInstanceId: command.payload.nodeInstanceId,
    attempt: command.payload.attempt,
    idempotencyKey: command.payload.idempotencyKey,
    input: command.payload.input
  }
})

interface Fixture {
  readonly key: PlanStore.RunKey
  readonly executionStore: ExecutionStore.ExecutionStore.Service
  readonly deliveryStore: ActivityDeliveryStore.ActivityDeliveryStore.Service
  readonly runCoordinatorStore: RunCoordinatorStore.RunCoordinatorStore.Service
  readonly dispatch: Dispatch.ActivityDispatch
}

const makeFixture = (
  tenantId = "tenant-a",
  runId = "run-1"
): Effect.Effect<Fixture, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(definition, planInput)
    const plan = yield* Decision.prepare(compiled)
    const catalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        Deployment.workflowDefinition("workflow-build-1", definition)
      ],
      handlerDefinitions: [
        Deployment.handlerDefinition("task-build-1", task)
      ]
    })
    const key = { tenantId, runId }
    const start = yield* DurableStart.prepare(plan, { payload: { id: "document-1" } }, {
      tenantId,
      runId,
      workflowIdentity: "document/document-1",
      requestId: `request-${runId}`,
      definitionDeploymentId: "workflow-build-1",
      dispatchTargets: {
        task: { queue: "tasks", deploymentId: "task-build-1" }
      }
    }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
    const services = yield* ExecutionStore.makeMemory
    yield* services.executionStore.start(start)
    const command = scheduleCommand(runId)
    const runnable = yield* services.runCoordinatorStore.claimRunnableRuns({
      requestVersion: 1,
      tenantId,
      coordinatorId: "fixture-coordinator",
      requestId: `claim-${runId}`,
      limit: 1,
      leaseDurationMillis: 60_000
    })
    const lease = runnable.leases[0]
    if (lease === undefined) {
      return yield* Effect.die("Expected started delivery fixture to be runnable")
    }
    const commit: ExecutionStore.DecisionCommitDraft = {
      commitVersion: 1,
      key,
      expectedLastSequence: 0,
      events: [scheduleEvent(command)],
      dispatches: [{
        dispatchVersion: 1,
        _tag: "Activity",
        intentId: command.commandId,
        sourceEventId: command.commandId,
        command,
        target: { queue: "tasks", deploymentId: "task-build-1" }
      }]
    }
    yield* services.executionStore.commitDecision(
      {
        requestVersion: 1,
        ref: lease.ref,
        requestId: `commit-${runId}`,
        commit
      } satisfies RunCoordinatorStore.CommitDecisionRequest
    )
    const outbox = yield* services.executionStore.inspectOutbox(key)
    return {
      key,
      executionStore: services.executionStore,
      deliveryStore: services.activityDeliveryStore,
      runCoordinatorStore: services.runCoordinatorStore,
      dispatch: outbox[0]!
    }
  })

const claimRequest = (
  fixture: Fixture,
  requestId = "relay-request-1"
): ActivityDeliveryStore.ClaimOutboxRequest => ({
  requestVersion: 1,
  tenantId: fixture.key.tenantId,
  relayId: "relay-1",
  requestId,
  queue: "tasks",
  limit: 10,
  leaseDurationMillis: 100
})

const acquireRequest = (
  claim: ActivityDeliveryStore.RelayClaim,
  requestId = "worker-request-1"
): ActivityDeliveryStore.AcquireAttemptRequest => ({
  requestVersion: 1,
  key: claim.pointer.key,
  dispatchDigest: claim.pointer.dispatchDigest,
  workerId: "worker-1",
  workerQueue: claim.dispatch.target.queue,
  workerDeploymentId: claim.dispatch.target.deploymentId,
  requestId,
  leaseDurationMillis: 100
})

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected operation to fail")
  }
  return result.failure
}

describe("ActivityDeliveryStore", () => {
  it("defines strict dispatch, lease, result, and receipt schemas", () => {
    const key = Schema.decodeUnknownSync(Dispatch.DispatchKey)({
      tenantId: "tenant-a",
      intentId: "intent-1"
    })
    const result = Schema.decodeUnknownSync(Dispatch.ActivityResult)({
      _tag: "Succeeded",
      output: { value: 1 }
    })

    assert.strictEqual(key.intentId, "intent-1")
    assert.deepStrictEqual(result, { _tag: "Succeeded", output: { value: 1 } })
    assert.throws(() => Schema.decodeUnknownSync(Dispatch.DispatchKey)({ ...key, extra: true }))
    assert.throws(() => Schema.decodeUnknownSync(Dispatch.ActivityResult)({ ...result, extra: true }))
    assert.throws(() =>
      Schema.decodeUnknownSync(ActivityDeliveryStore.ClaimOutboxRequest)({
        requestVersion: 1,
        tenantId: "tenant-a",
        relayId: "relay",
        requestId: "request",
        limit: 0,
        leaseDurationMillis: 100
      })
    )
  })

  it.effect("fences relay claims, supports exact retries, and republishes the identical pointer after expiry", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const first = yield* at(1_000, fixture.deliveryStore.claimOutbox(claimRequest(fixture)))
      const exact = yield* at(Number.MAX_SAFE_INTEGER, fixture.deliveryStore.claimOutbox(claimRequest(fixture)))
      assert.strictEqual(exact, first)
      assert.strictEqual(first.claims.length, 1)

      const competing = yield* at(
        1_050,
        fixture.deliveryStore.claimOutbox({
          ...claimRequest(fixture, "relay-request-competing"),
          relayId: "relay-2"
        })
      )
      assert.deepStrictEqual(competing.claims, [])

      const expiredAck = yield* Effect.result(at(
        1_100,
        fixture.deliveryStore.acknowledgePublished({
          requestVersion: 1,
          ref: first.claims[0]!.ref,
          brokerReceipt: { messageId: "message-1" }
        })
      ))
      assert.instanceOf(failure(expiredAck), ActivityDeliveryStore.StaleRelayLease)

      const reclaimed = yield* at(
        1_100,
        fixture.deliveryStore.claimOutbox({
          ...claimRequest(fixture, "relay-request-2"),
          relayId: "relay-2"
        })
      )
      assert.strictEqual(reclaimed.claims.length, 1)
      assert.strictEqual(reclaimed.claims[0]!.ref.relayEpoch, first.claims[0]!.ref.relayEpoch + 1)
      assert.strictEqual(reclaimed.claims[0]!.pointer.dispatchDigest, first.claims[0]!.pointer.dispatchDigest)
      assert.strictEqual(reclaimed.claims[0]!.dispatch, first.claims[0]!.dispatch)

      const staleAck = yield* Effect.result(at(
        1_150,
        fixture.deliveryStore.acknowledgePublished({
          requestVersion: 1,
          ref: first.claims[0]!.ref,
          brokerReceipt: { messageId: "message-1" }
        })
      ))
      assert.instanceOf(failure(staleAck), ActivityDeliveryStore.StaleRelayLease)

      const published = yield* at(
        1_150,
        fixture.deliveryStore.acknowledgePublished({
          requestVersion: 1,
          ref: reclaimed.claims[0]!.ref,
          brokerReceipt: { messageId: "message-2" }
        })
      )
      const publishedRetry = yield* at(
        Number.MAX_SAFE_INTEGER,
        fixture.deliveryStore.acknowledgePublished({
          requestVersion: 1,
          ref: reclaimed.claims[0]!.ref,
          brokerReceipt: { messageId: "message-2" }
        })
      )
      assert.strictEqual(publishedRetry, published)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("keeps a logical attempt stable while renewal and expiry fence worker generations", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const relay = yield* at(1_000, fixture.deliveryStore.claimOutbox(claimRequest(fixture)))
      const claim = relay.claims[0]!
      const first = yield* at(1_000, fixture.deliveryStore.acquireAttempt(acquireRequest(claim)))
      const exact = yield* at(Number.MAX_SAFE_INTEGER, fixture.deliveryStore.acquireAttempt(acquireRequest(claim)))
      assert.strictEqual(exact, first)
      assert.strictEqual(first.dispatch.command.payload.attempt, 1)

      const busy = yield* Effect.result(at(
        1_050,
        fixture.deliveryStore.acquireAttempt({
          ...acquireRequest(claim, "worker-request-busy"),
          workerId: "worker-2"
        })
      ))
      assert.instanceOf(failure(busy), ActivityDeliveryStore.ActivityLeaseBusy)

      const renewed = yield* at(
        1_050,
        fixture.deliveryStore.renewAttempt({
          requestVersion: 1,
          ref: first.ref,
          requestId: "renewal-1",
          leaseDurationMillis: 200
        })
      )
      assert.strictEqual(renewed.ref.deliveryEpoch, first.ref.deliveryEpoch)
      assert.strictEqual(renewed.ref.leaseId, first.ref.leaseId)

      const stolen = yield* at(
        1_250,
        fixture.deliveryStore.acquireAttempt({
          ...acquireRequest(claim, "worker-request-2"),
          workerId: "worker-2"
        })
      )
      assert.strictEqual(stolen.ref.deliveryEpoch, first.ref.deliveryEpoch + 1)
      assert.strictEqual(stolen.dispatch.command.payload.activityId, first.dispatch.command.payload.activityId)
      assert.strictEqual(stolen.dispatch.command.payload.idempotencyKey, first.dispatch.command.payload.idempotencyKey)

      const stale = yield* Effect.result(at(
        1_260,
        fixture.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: first.ref,
          requestId: "completion-stale",
          result: { _tag: "Succeeded", output: { receipt: "old" } }
        })
      ))
      assert.instanceOf(failure(stale), ActivityDeliveryStore.StaleActivityLease)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("rejects new renewals after cancellation while preserving exact earlier retries", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("tenant-a", "renew-after-cancel")
      const relay = yield* at(1_000, fixture.deliveryStore.claimOutbox(claimRequest(fixture)))
      const lease = yield* at(
        1_000,
        fixture.deliveryStore.acquireAttempt(acquireRequest(relay.claims[0]!))
      )
      const renewalRequest: ActivityDeliveryStore.RenewAttemptRequest = {
        requestVersion: 1,
        ref: lease.ref,
        requestId: "renewal-before-cancel",
        leaseDurationMillis: 200
      }
      const renewed = yield* at(1_010, fixture.deliveryStore.renewAttempt(renewalRequest))

      yield* at(
        1_020,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel-before-new-renewal"
        })
      )

      const exactRetry = yield* at(
        Number.MAX_SAFE_INTEGER,
        fixture.deliveryStore.renewAttempt(renewalRequest)
      )
      assert.strictEqual(exactRetry, renewed)

      const rejected = yield* Effect.result(at(
        1_030,
        fixture.deliveryStore.renewAttempt({
          ...renewalRequest,
          requestId: "renewal-after-cancel"
        })
      ))
      const stale = failure(rejected)
      assert.instanceOf(stale, ActivityDeliveryStore.StaleActivityLease)
      if (stale instanceof ActivityDeliveryStore.StaleActivityLease) {
        assert.strictEqual(stale.reason, "CancellationRequested")
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("rejects new renewals after terminal cancellation", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture("tenant-a", "renew-after-terminal")
      const relay = yield* at(1_000, fixture.deliveryStore.claimOutbox(claimRequest(fixture)))
      const lease = yield* at(
        1_000,
        fixture.deliveryStore.acquireAttempt(acquireRequest(relay.claims[0]!))
      )
      const cancellation = yield* at(
        1_010,
        fixture.executionStore.requestCancellation({
          requestVersion: 1,
          key: fixture.key,
          requestId: "cancel-before-terminal"
        })
      )
      const runnable = yield* at(
        1_020,
        fixture.runCoordinatorStore.claimRunnableRuns({
          requestVersion: 1,
          tenantId: fixture.key.tenantId,
          coordinatorId: "terminal-coordinator",
          requestId: "claim-terminal-cancellation",
          limit: 1,
          leaseDurationMillis: 100
        })
      )
      const coordinatorLease = runnable.leases[0]
      if (coordinatorLease === undefined) {
        return yield* Effect.die("Expected cancellation-requested run to be runnable")
      }
      yield* at(
        1_020,
        fixture.executionStore.commitDecision({
          requestVersion: 1,
          ref: coordinatorLease.ref,
          requestId: "commit-terminal-cancellation",
          commit: {
            commitVersion: 1,
            key: fixture.key,
            expectedLastSequence: cancellation.lastSequence,
            events: [{
              eventVersion: 1,
              eventId: Command.cancelRunCommandId(fixture.key.runId),
              payload: { _tag: "RunCancelled" }
            }],
            dispatches: []
          }
        })
      )

      const rejected = yield* Effect.result(at(
        1_030,
        fixture.deliveryStore.renewAttempt({
          requestVersion: 1,
          ref: lease.ref,
          requestId: "renewal-after-terminal",
          leaseDurationMillis: 200
        })
      ))
      const stale = failure(rejected)
      assert.instanceOf(stale, ActivityDeliveryStore.StaleActivityLease)
      if (stale instanceof ActivityDeliveryStore.StaleActivityLease) {
        assert.strictEqual(stale.reason, "RunTerminal")
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("atomically accepts one fenced result and returns exact retries after history advances", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const relay = yield* at(1_000, fixture.deliveryStore.claimOutbox(claimRequest(fixture)))
      const lease = yield* at(1_000, fixture.deliveryStore.acquireAttempt(acquireRequest(relay.claims[0]!)))
      const request: ActivityDeliveryStore.CompleteAttemptRequest = {
        requestVersion: 1,
        ref: lease.ref,
        requestId: "completion-1",
        result: { _tag: "Succeeded", output: { receipt: "ok" } }
      }
      const accepted = yield* at(1_050, fixture.deliveryStore.completeAttempt(request))
      const history = yield* fixture.executionStore.read(fixture.key)

      assert.strictEqual(accepted.previousSequence, 1)
      assert.strictEqual(accepted.lastSequence, 2)
      assert.strictEqual(accepted.event.payload._tag, "ActivitySucceeded")
      assert.strictEqual(accepted.event.causationId, fixture.dispatch.command.commandId)
      assert.strictEqual(history.lastSequence, 2)
      assert.strictEqual(history.events[2], accepted.event)

      const exact = yield* at(Number.MAX_SAFE_INTEGER, fixture.deliveryStore.completeAttempt(request))
      assert.strictEqual(exact, accepted)
      const sameResultNewRequest = yield* at(
        Number.MAX_SAFE_INTEGER,
        fixture.deliveryStore.completeAttempt({
          ...request,
          requestId: "completion-retry-new-id"
        })
      )
      assert.strictEqual(sameResultNewRequest, accepted)

      const changed = yield* Effect.result(at(
        1_060,
        fixture.deliveryStore.completeAttempt({
          ...request,
          requestId: "completion-conflict",
          result: { _tag: "Failed", failure: { reason: "different" } }
        })
      ))
      assert.instanceOf(failure(changed), ActivityDeliveryStore.ConflictingCompletion)
      assert.strictEqual((yield* fixture.executionStore.read(fixture.key)).lastSequence, 2)

      const afterCompletion = yield* Effect.result(at(
        1_060,
        fixture.deliveryStore.acquireAttempt({
          ...acquireRequest(relay.claims[0]!, "worker-after-completion"),
          workerId: "worker-2"
        })
      ))
      assert.instanceOf(failure(afterCompletion), ActivityDeliveryStore.ActivityCompletionSuppressed)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("linearizes competing completions and isolates tenant-scoped dispatch capabilities", () =>
    Effect.gen(function*() {
      const firstFixture = yield* makeFixture("tenant-a", "shared-run")
      const secondFixture = yield* makeFixture("tenant-b", "shared-run")
      const firstRelay = yield* at(1_000, firstFixture.deliveryStore.claimOutbox(claimRequest(firstFixture)))
      const secondRelay = yield* at(1_000, secondFixture.deliveryStore.claimOutbox(claimRequest(secondFixture)))
      const firstLease = yield* at(
        1_000,
        firstFixture.deliveryStore.acquireAttempt(acquireRequest(firstRelay.claims[0]!))
      )

      assert.strictEqual(
        firstRelay.claims[0]!.dispatch.intentId,
        secondRelay.claims[0]!.dispatch.intentId
      )
      const crossTenant = yield* Effect.result(at(
        1_010,
        firstFixture.deliveryStore.acquireAttempt({
          ...acquireRequest(secondRelay.claims[0]!, "cross-tenant"),
          workerId: "worker-cross"
        })
      ))
      assert.instanceOf(failure(crossTenant), ActivityDeliveryStore.DispatchNotFound)

      const outcomes = yield* Effect.all([
        firstFixture.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: firstLease.ref,
          requestId: "completion-success",
          result: { _tag: "Succeeded", output: { winner: "success" } }
        }).pipe(Effect.result),
        firstFixture.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: firstLease.ref,
          requestId: "completion-failure",
          result: { _tag: "Failed", failure: { winner: "failure" } }
        }).pipe(Effect.result)
      ], { concurrency: "unbounded" }).pipe(Effect.provideService(Clock.Clock, clock(1_050)))
      assert.strictEqual(outcomes.filter(Result.isSuccess).length, 1)
      assert.strictEqual(outcomes.filter(Result.isFailure).length, 1)
      assert.instanceOf(failure(outcomes.find(Result.isFailure)!), ActivityDeliveryStore.ConflictingCompletion)
      assert.strictEqual((yield* firstFixture.executionStore.read(firstFixture.key)).lastSequence, 2)
      assert.strictEqual((yield* secondFixture.executionStore.read(secondFixture.key)).lastSequence, 1)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("serializes completion and cancellation races without post-cancel result events", () =>
    Effect.gen(function*() {
      const cancelledFirst = yield* makeFixture("tenant-a", "cancel-first")
      const relay = yield* at(
        1_000,
        cancelledFirst.deliveryStore.claimOutbox(claimRequest(cancelledFirst))
      )
      const lease = yield* at(
        1_000,
        cancelledFirst.deliveryStore.acquireAttempt(acquireRequest(relay.claims[0]!))
      )
      const cancellation = yield* at(
        1_020,
        cancelledFirst.executionStore.requestCancellation({
          requestVersion: 1,
          key: cancelledFirst.key,
          requestId: "cancel-request-1"
        })
      )
      const cancellationRetry = yield* at(
        Number.MAX_SAFE_INTEGER,
        cancelledFirst.executionStore.requestCancellation({
          requestVersion: 1,
          key: cancelledFirst.key,
          requestId: "cancel-request-1"
        })
      )
      assert.strictEqual(cancellationRetry, cancellation)

      const lateCompletion = yield* Effect.result(at(
        1_030,
        cancelledFirst.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: lease.ref,
          requestId: "late-completion",
          result: { _tag: "Succeeded", output: { ignored: true } }
        })
      ))
      const suppressed = failure(lateCompletion)
      assert.instanceOf(suppressed, ActivityDeliveryStore.ActivityCompletionSuppressed)
      if (suppressed instanceof ActivityDeliveryStore.ActivityCompletionSuppressed) {
        assert.strictEqual(suppressed.reason, "CancellationRequested")
      }
      const history = yield* cancelledFirst.executionStore.read(cancelledFirst.key)
      assert.strictEqual(history.lastSequence, 2)
      assert.strictEqual(history.events[2]!.payload._tag, "RunCancellationRequested")

      const suppressedRelay = yield* at(
        1_200,
        cancelledFirst.deliveryStore.claimOutbox(
          claimRequest(cancelledFirst, "relay-after-cancel")
        )
      )
      assert.deepStrictEqual(suppressedRelay.claims, [])

      const completedFirst = yield* makeFixture("tenant-a", "complete-first")
      const secondRelay = yield* at(
        2_000,
        completedFirst.deliveryStore.claimOutbox(claimRequest(completedFirst, "relay-complete-first"))
      )
      const secondLease = yield* at(
        2_000,
        completedFirst.deliveryStore.acquireAttempt(acquireRequest(
          secondRelay.claims[0]!,
          "worker-complete-first"
        ))
      )
      yield* at(
        2_010,
        completedFirst.deliveryStore.completeAttempt({
          requestVersion: 1,
          ref: secondLease.ref,
          requestId: "completion-before-cancel",
          result: { _tag: "Succeeded", output: { committed: true } }
        })
      )
      yield* at(
        2_020,
        completedFirst.executionStore.requestCancellation({
          requestVersion: 1,
          key: completedFirst.key,
          requestId: "cancel-after-completion"
        })
      )
      const completedHistory = yield* completedFirst.executionStore.read(completedFirst.key)
      assert.strictEqual(completedHistory.lastSequence, 3)
      assert.strictEqual(completedHistory.events[2]!.payload._tag, "ActivitySucceeded")
      assert.strictEqual(completedHistory.events[3]!.payload._tag, "RunCancellationRequested")
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
