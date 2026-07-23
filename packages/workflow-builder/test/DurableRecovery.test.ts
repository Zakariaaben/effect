import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as DecisionCommit from "../src/DecisionCommit.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DurableCoordinator from "../src/DurableCoordinator.ts"
import * as DurableRecovery from "../src/DurableRecovery.ts"
import * as DurableStart from "../src/DurableStart.ts"
import type * as Event from "../src/Event.ts"
import * as ExecutionStore from "../src/ExecutionStore.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import type * as HistoryStore from "../src/HistoryStore.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Registry from "../src/Registry.ts"
import * as RunCoordinatorStore from "../src/RunCoordinatorStore.ts"
import * as RunState from "../src/RunState.ts"
import * as Workflow from "../src/Workflow.ts"

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      let state = 0x811c9dc5
      for (let index = 0; index < data.length; index++) {
        state = Math.imul(state ^ data[index]!, 0x01000193)
      }
      const output = new Uint8Array(32)
      for (let index = 0; index < output.length; index++) {
        state = Math.imul(state ^ index, 0x45d9f3b)
        state ^= state >>> 16
        output[index] = state & 0xff
      }
      return output
    })
})

const step = Node.make("Step", {
  version: "1.0.0"
})

const otherStepObject = Node.make("Step", {
  version: "1.0.0",
  description: "different immutable handler object"
})

const definition = Workflow.make("durable-recovery-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(step),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const otherWorkflowObject = Workflow.make("durable-recovery-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(otherStepObject),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const planInput = {
  formatVersion: 1,
  id: "durable-recovery-plan",
  revision: 4,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    {
      id: "worker",
      type: step.type,
      version: step.version,
      config: {}
    }
  ],
  edges: []
}

const key: PlanStore.RunKey = {
  tenantId: "tenant-1",
  runId: "run-1"
}

const witness = Deployment.workflowDefinition(
  "workflow-build-1",
  definition
)

interface Fixture {
  readonly services: ExecutionStore.MemoryServices
  readonly catalog: Deployment.DeploymentCatalog.Service
  readonly witness: typeof witness
  readonly receipt: ExecutionStore.StartReceipt
  readonly history: HistoryStore.HistorySnapshot
  readonly preparedStart: DurableStart.PreparedStart
  readonly initialPlan: Decision.DecidablePlan<typeof definition>
}

const makeFixture = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, planInput)
  const initialPlan = yield* Decision.prepare(compiled)
  const catalog = yield* Deployment.makeMemory({
    workflowDefinitions: [witness],
    handlerDefinitions: [
      Deployment.handlerDefinition("handler-build-1", step)
    ]
  })
  const preparedStart = yield* DurableStart.prepare(initialPlan, {}, {
    tenantId: key.tenantId,
    runId: key.runId,
    workflowIdentity: "recovery",
    requestId: "request-1",
    definitionDeploymentId: witness.deploymentId,
    dispatchTargets: {
      worker: {
        queue: "steps",
        deploymentId: "handler-build-1"
      }
    }
  }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
  const services = yield* ExecutionStore.makeMemory
  const receipt = yield* services.executionStore.start(preparedStart)
  const history = yield* services.executionStore.read(key)
  return {
    services,
    catalog,
    witness,
    receipt,
    history,
    preparedStart,
    initialPlan
  }
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const recover = (
  fixture: Fixture,
  options: {
    readonly key?: PlanStore.RunKey | undefined
    readonly planStore?: PlanStore.PlanStore.Service | undefined
    readonly executionStore?: ExecutionStore.ExecutionStore.Service | undefined
    readonly catalog?: Deployment.DeploymentCatalog.Service | undefined
    readonly crypto?: Crypto.Crypto | undefined
    readonly expected?: Deployment.WorkflowDefinitionDeployment<typeof definition> | undefined
  } = {}
) =>
  DurableRecovery.recover(options.key ?? key, options.expected ?? fixture.witness).pipe(
    Effect.provideService(
      PlanStore.PlanStore,
      options.planStore ?? fixture.services.planStore
    ),
    Effect.provideService(
      ExecutionStore.ExecutionStore,
      options.executionStore ?? fixture.services.executionStore
    ),
    Effect.provideService(
      Deployment.DeploymentCatalog,
      options.catalog ?? fixture.catalog
    ),
    Effect.provideService(Crypto.Crypto, options.crypto ?? testCrypto)
  )

const mockPlanStore = (
  fixture: Fixture,
  bound: unknown
): PlanStore.PlanStore.Service =>
  PlanStore.PlanStore.of(Object.freeze({
    ...fixture.services.planStore,
    getForRun: () => Effect.succeed(bound as PlanStore.BoundPlan)
  }))

const mockExecutionStore = (
  fixture: Fixture,
  history: unknown
): ExecutionStore.ExecutionStore.Service =>
  ExecutionStore.ExecutionStore.of(Object.freeze({
    ...fixture.services.executionStore,
    read: () => Effect.succeed(history as HistoryStore.HistorySnapshot)
  }))

const recoveryFailure = <A, E>(
  result: Result.Result<A, E>
): E => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected durable recovery to fail")
  }
  return result.failure
}

const digestArtifact = Effect.fnUntraced(function*(
  artifact: PlanStore.PlanArtifact
): Effect.fn.Return<PlanStore.ArtifactDigest, PlatformError.PlatformError, Crypto.Crypto> {
  const digest = yield* Fingerprint.digest(artifact as unknown as Schema.Json)
  return Schema.decodeUnknownSync(PlanStore.ArtifactDigest)(digest)
})

describe("DurableRecovery", () => {
  it("exposes a strict schema-backed integrity error", () => {
    const decode = Schema.decodeUnknownSync(DurableRecovery.DurableRecoveryError)
    const decoded = decode({
      _tag: "DurableRecoveryError",
      code: DurableRecovery.Codes.StartMismatch,
      tenantId: "tenant-1",
      runId: "run-1",
      message: "Start mismatch",
      details: { expected: "start" }
    })

    assert.instanceOf(decoded, DurableRecovery.DurableRecoveryError)
    assert.throws(() => decode({ ...decoded, unexpected: true }))
    assert.throws(() => decode({ ...decoded, code: "FutureRecoveryError" }))
  })

  it.effect("reconstructs exact process-local provenance from detached durable data", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const recovered = yield* recover(fixture)

      assert.isTrue(DurableRecovery.isRecovered(recovered))
      assert.isFalse(DurableRecovery.isRecovered({ ...recovered }))
      assert.isTrue(Decision.isPrepared(recovered.plan))
      assert.notStrictEqual(recovered.plan, fixture.initialPlan)
      assert.strictEqual(recovered.plan.compiled.definition, definition)
      assert.strictEqual(recovered.plan.compiled.nodes.get("worker")?.definition, step)
      assert.strictEqual(recovered.key.tenantId, key.tenantId)
      assert.strictEqual(recovered.key.runId, key.runId)
      assert.strictEqual(recovered.binding.artifactDigest, fixture.preparedStart.wire.artifactDigest)
      assert.strictEqual(recovered.artifact.compiledFingerprint, fixture.initialPlan.compiledFingerprint)
      assert.strictEqual(recovered.boundPlan.binding, recovered.binding)
      assert.strictEqual(recovered.boundPlan.artifact, recovered.artifact)
      assert.strictEqual(recovered.dispatchTargets, recovered.artifact.dispatchTargets)
      assert.strictEqual(recovered.state.status, "Running")
      assert.strictEqual(recovered.state.sequence, 0)
      const commit = yield* DecisionCommit.prepare(
        recovered.plan,
        recovered.state,
        recovered.boundPlan
      )
      assert.isTrue(Option.isSome(commit))
      if (Option.isSome(commit)) {
        assert.deepStrictEqual(commit.value.wire.key, key)
        const claimed = yield* fixture.services.runCoordinatorStore.claimRunnableRuns({
          requestVersion: 1,
          tenantId: key.tenantId,
          coordinatorId: "recovery-coordinator",
          requestId: "recovery-claim-1",
          limit: 1,
          leaseDurationMillis: 60_000
        })
        const lease = claimed.leases[0]
        if (lease === undefined) {
          return yield* Effect.die("Expected recovered start to be runnable")
        }
        const receipt = yield* DecisionCommit.commit(
          commit.value,
          lease,
          "recovery-commit-1"
        ).pipe(
          Effect.provideService(
            RunCoordinatorStore.RunCoordinatorStore,
            fixture.services.runCoordinatorStore
          )
        )
        assert.strictEqual(receipt.previousSequence, 0)
        assert.strictEqual(receipt.lastSequence, 1)
      }

      assert.isTrue(Object.isFrozen(recovered))
      assert.isTrue(Object.isFrozen(recovered.key))
      assert.isTrue(Object.isFrozen(recovered.binding))
      assert.isTrue(Object.isFrozen(recovered.artifact))
      assert.isTrue(Object.isFrozen(recovered.history))
      assert.isTrue(Object.isFrozen(recovered.history.events))
      assert.isTrue(Object.isFrozen(recovered.dispatchTargets))
      assert.notStrictEqual(recovered.artifact, fixture.preparedStart.wire.artifact)
      assert.notStrictEqual(recovered.history, fixture.history)
    }))

  it.effect("recovers and commits one claimed durable decision through the coordinator driver", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const claimed = yield* fixture.services.runCoordinatorStore.claimRunnableRuns({
        requestVersion: 1,
        tenantId: key.tenantId,
        coordinatorId: "durable-driver",
        requestId: "durable-driver-claim",
        limit: 1,
        leaseDurationMillis: 60_000
      })
      const lease = claimed.leases[0]
      if (lease === undefined) {
        return yield* Effect.die("Expected durable driver fixture to be runnable")
      }
      const outcome = yield* DurableCoordinator.process({
        requestVersion: 1,
        lease,
        requestId: "durable-driver-decision"
      }, fixture.witness).pipe(
        Effect.provideService(PlanStore.PlanStore, fixture.services.planStore),
        Effect.provideService(ExecutionStore.ExecutionStore, fixture.services.executionStore),
        Effect.provideService(
          RunCoordinatorStore.RunCoordinatorStore,
          fixture.services.runCoordinatorStore
        ),
        Effect.provideService(Deployment.DeploymentCatalog, fixture.catalog),
        Effect.provideService(Crypto.Crypto, testCrypto)
      )
      assert.strictEqual(outcome._tag, "Committed")
      if (outcome._tag === "Committed") {
        assert.strictEqual(outcome.receipt.previousSequence, 0)
        assert.strictEqual(outcome.receipt.lastSequence, 1)
      }
      assert.strictEqual(
        (yield* fixture.services.executionStore.read(key)).lastSequence,
        1
      )
      assert.strictEqual(
        (yield* fixture.services.executionStore.inspectOutbox(key)).length,
        1
      )
    }))

  it.effect("rejects hostile store output and mismatched binding identity without invoking getters", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      let getterReads = 0
      const hostile = Object.defineProperty(
        {
          binding: fixture.receipt.binding
        },
        "artifact",
        {
          enumerable: true,
          get: () => {
            getterReads++
            return fixture.preparedStart.wire.artifact
          }
        }
      )
      const hostileResult = yield* Effect.result(recover(fixture, {
        planStore: mockPlanStore(fixture, hostile)
      }))

      const wrongKeyBinding: PlanStore.RunBinding = {
        ...fixture.receipt.binding,
        key: {
          tenantId: "tenant-2",
          runId: key.runId
        }
      }
      const keyResult = yield* Effect.result(recover(fixture, {
        planStore: mockPlanStore(fixture, {
          binding: wrongKeyBinding,
          artifact: fixture.preparedStart.wire.artifact
        })
      }))

      let expectedGetterReads = 0
      const hostileExpected = Object.defineProperty(
        {
          deploymentId: witness.deploymentId
        },
        "definition",
        {
          enumerable: true,
          get: () => {
            expectedGetterReads++
            return definition
          }
        }
      )
      const expectedResult = yield* Effect.result(recover(fixture, {
        expected: hostileExpected as unknown as typeof witness
      }))

      let keyGetterReads = 0
      const hostileKey = Object.defineProperty(
        {
          tenantId: key.tenantId
        },
        "runId",
        {
          enumerable: true,
          get: () => {
            keyGetterReads++
            return key.runId
          }
        }
      )
      const hostileKeyResult = yield* Effect.result(recover(fixture, {
        key: hostileKey as PlanStore.RunKey
      }))

      const hostileError = recoveryFailure(hostileResult)
      assert.instanceOf(hostileError, DurableRecovery.DurableRecoveryError)
      if (hostileError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(hostileError.code, DurableRecovery.Codes.InvalidBoundPlan)
      }
      const keyError = recoveryFailure(keyResult)
      assert.instanceOf(keyError, DurableRecovery.DurableRecoveryError)
      if (keyError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(keyError.code, DurableRecovery.Codes.BindingMismatch)
      }
      const expectedError = recoveryFailure(expectedResult)
      assert.instanceOf(expectedError, DurableRecovery.DurableRecoveryError)
      if (expectedError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(
          expectedError.code,
          DurableRecovery.Codes.InvalidExpectedDeployment
        )
      }
      const keyInputError = recoveryFailure(hostileKeyResult)
      assert.instanceOf(keyInputError, DurableRecovery.DurableRecoveryError)
      if (keyInputError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(keyInputError.code, DurableRecovery.Codes.InvalidKey)
      }
      assert.strictEqual(getterReads, 0)
      assert.strictEqual(expectedGetterReads, 0)
      assert.strictEqual(keyGetterReads, 0)
    }))

  it.effect("independently verifies compiled and artifact digests", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const changedFingerprintArtifact = {
        ...fixture.preparedStart.wire.artifact,
        compiledFingerprint: `sha256:${"f".repeat(64)}`
      } as PlanStore.PlanArtifact
      const fingerprintResult = yield* Effect.result(recover(fixture, {
        planStore: mockPlanStore(fixture, {
          binding: fixture.receipt.binding,
          artifact: changedFingerprintArtifact
        })
      }))

      const changedBinding: PlanStore.RunBinding = {
        ...fixture.receipt.binding,
        artifactDigest: Schema.decodeUnknownSync(PlanStore.ArtifactDigest)(
          `sha256:${"e".repeat(64)}`
        )
      }
      const artifactResult = yield* Effect.result(recover(fixture, {
        planStore: mockPlanStore(fixture, {
          binding: changedBinding,
          artifact: fixture.preparedStart.wire.artifact
        })
      }))

      const fingerprintError = recoveryFailure(fingerprintResult)
      assert.instanceOf(fingerprintError, DurableRecovery.DurableRecoveryError)
      if (fingerprintError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(
          fingerprintError.code,
          DurableRecovery.Codes.CompiledFingerprintMismatch
        )
      }
      const artifactError = recoveryFailure(artifactResult)
      assert.instanceOf(artifactError, DurableRecovery.DurableRecoveryError)
      if (artifactError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(
          artifactError.code,
          DurableRecovery.Codes.ArtifactDigestMismatch
        )
      }
    }))

  it.effect("cross-checks binding, start history, and artifact pins", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const first = fixture.history.events[0]!
      if (first.payload._tag !== "RunStarted") {
        throw new Error("Expected RunStarted")
      }
      const changedStart: Event.Event = {
        ...first,
        payload: {
          ...first.payload,
          planRevision: first.payload.planRevision + 1
        }
      } as Event.Event
      const history = {
        ...fixture.history,
        events: [changedStart]
      }
      const startResult = yield* Effect.result(recover(fixture, {
        executionStore: mockExecutionStore(fixture, history)
      }))

      const changedEventBinding: PlanStore.RunBinding = {
        ...fixture.receipt.binding,
        runStartedEventId: "different-start-event"
      }
      const bindingResult = yield* Effect.result(recover(fixture, {
        planStore: mockPlanStore(fixture, {
          binding: changedEventBinding,
          artifact: fixture.preparedStart.wire.artifact
        })
      }))

      const startError = recoveryFailure(startResult)
      assert.instanceOf(startError, DurableRecovery.DurableRecoveryError)
      if (startError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(startError.code, DurableRecovery.Codes.StartMismatch)
      }
      const bindingError = recoveryFailure(bindingResult)
      assert.instanceOf(bindingError, DurableRecovery.DurableRecoveryError)
      if (bindingError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(bindingError.code, DurableRecovery.Codes.StartMismatch)
      }
    }))

  it.effect("rejects incoherent or missing exact workflow and handler deployments", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const wrongWitness = Deployment.workflowDefinition(
        "workflow-build-other",
        definition
      )
      const witnessResult = yield* Effect.result(recover(fixture, {
        expected: wrongWitness
      }))

      const workflowObjectCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition(
            fixture.witness.deploymentId,
            otherWorkflowObject
          )
        ],
        handlerDefinitions: [
          Deployment.handlerDefinition("handler-build-1", otherStepObject)
        ]
      })
      const workflowObjectResult = yield* Effect.result(recover(fixture, {
        catalog: workflowObjectCatalog
      }))

      const mismatchedCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [fixture.witness],
        handlerDefinitions: [
          Deployment.handlerDefinition("handler-build-1", otherStepObject)
        ]
      })
      const handlerResult = yield* Effect.result(recover(fixture, {
        catalog: mismatchedCatalog
      }))

      const missingCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [fixture.witness],
        handlerDefinitions: []
      })
      const missingResult = yield* Effect.result(recover(fixture, {
        catalog: missingCatalog
      }))
      const missingWorkflowCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("handler-build-1", step)
        ]
      })
      const missingWorkflowResult = yield* Effect.result(recover(fixture, {
        catalog: missingWorkflowCatalog
      }))

      const witnessError = recoveryFailure(witnessResult)
      assert.instanceOf(witnessError, DurableRecovery.DurableRecoveryError)
      if (witnessError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(
          witnessError.code,
          DurableRecovery.Codes.WorkflowDeploymentMismatch
        )
      }

      const workflowObjectError = recoveryFailure(workflowObjectResult)
      assert.instanceOf(
        workflowObjectError,
        DurableRecovery.DurableRecoveryError
      )
      if (workflowObjectError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(
          workflowObjectError.code,
          DurableRecovery.Codes.WorkflowDeploymentMismatch
        )
      }

      const handlerError = recoveryFailure(handlerResult)
      assert.instanceOf(handlerError, DurableRecovery.DurableRecoveryError)
      if (handlerError instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(
          handlerError.code,
          DurableRecovery.Codes.HandlerDeploymentMismatch
        )
      }

      const missingError = recoveryFailure(missingResult)
      assert.instanceOf(missingError, Deployment.DeploymentNotFound)
      if (missingError instanceof Deployment.DeploymentNotFound) {
        assert.strictEqual(missingError.kind, "HandlerDefinition")
        assert.strictEqual(missingError.deploymentId, "handler-build-1")
      }

      const missingWorkflowError = recoveryFailure(missingWorkflowResult)
      assert.instanceOf(missingWorkflowError, Deployment.DeploymentNotFound)
      if (missingWorkflowError instanceof Deployment.DeploymentNotFound) {
        assert.strictEqual(missingWorkflowError.kind, "WorkflowDefinition")
        assert.strictEqual(
          missingWorkflowError.deploymentId,
          "workflow-build-1"
        )
      }
    }))

  it.effect("requires the recompiled fingerprint document to match exact stored topology", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const original = fixture.preparedStart.wire.artifact
      const changedDocument: Fingerprint.FingerprintDocument = {
        ...original.fingerprintDocument,
        plan: {
          ...original.fingerprintDocument.plan,
          nodes: [
            ...original.fingerprintDocument.plan.nodes,
            {
              id: "worker-2",
              type: step.type,
              version: step.version,
              config: {}
            }
          ]
        },
        topologicalOrder: ["worker", "worker-2"],
        stages: [["worker"], ["worker-2"]]
      }
      const compiledFingerprint = yield* Fingerprint.digest(
        changedDocument as unknown as Schema.Json
      )
      const changedArtifact: PlanStore.PlanArtifact = {
        ...original,
        fingerprintDocument: changedDocument,
        compiledFingerprint,
        dispatchTargets: {
          ...original.dispatchTargets,
          "worker-2": original.dispatchTargets.worker!
        }
      }
      const artifactDigest = yield* digestArtifact(changedArtifact)
      const changedBinding: PlanStore.RunBinding = {
        ...fixture.receipt.binding,
        artifactDigest
      }
      const first = fixture.history.events[0]!
      if (first.payload._tag !== "RunStarted") {
        throw new Error("Expected RunStarted")
      }
      const changedHistory: HistoryStore.HistorySnapshot = {
        ...fixture.history,
        events: [{
          ...first,
          payload: {
            ...first.payload,
            compiledFingerprint
          }
        } as Event.Event]
      }

      const result = yield* Effect.result(recover(fixture, {
        planStore: mockPlanStore(fixture, {
          binding: changedBinding,
          artifact: changedArtifact
        }),
        executionStore: mockExecutionStore(fixture, changedHistory)
      }))

      const error = recoveryFailure(result)
      assert.instanceOf(error, DurableRecovery.DurableRecoveryError)
      if (error instanceof DurableRecovery.DurableRecoveryError) {
        assert.strictEqual(error.code, DurableRecovery.Codes.RecompiledPlanMismatch)
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("propagates hash errors and preserves pure interruption", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const hashError = PlatformError.badArgument({
        module: "DurableRecoveryTest",
        method: "digest",
        description: "hash unavailable"
      })
      const failingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(hashError)
      })
      const failed = yield* Effect.result(recover(fixture, {
        crypto: failingCrypto
      }))
      assert.strictEqual(recoveryFailure(failed), hashError)

      const interruptingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.interrupt
      })
      const interrupted = yield* recover(fixture, {
        crypto: interruptingCrypto
      }).pipe(Effect.exit)
      if (!Exit.isFailure(interrupted)) {
        throw new Error("Expected durable recovery hash interruption")
      }
      assert.isTrue(Cause.hasInterrupts(interrupted.cause))
    }))

  it.effect("retains concrete compiler services instead of exposing Workflow.Any requirements", () => {
    class ConfigDecoder extends Context.Service<ConfigDecoder, {
      readonly prefix: string
    }>()("DurableRecoveryTest/ConfigDecoder") {}

    const ServiceConfig = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: (value) =>
            Effect.gen(function*() {
              const decoder = yield* ConfigDecoder
              return `${decoder.prefix}${value}`
            }),
          encode: Effect.succeed
        })
      )
    )
    const serviceStep = Node.make("ServiceStep", {
      version: "1.0.0",
      config: ServiceConfig
    })
    const serviceDefinition = Workflow.make("durable-recovery-service", {
      version: "1.0.0",
      inputs: {},
      outputs: {},
      nodes: Registry.make(serviceStep),
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const serviceWitness = Deployment.workflowDefinition(
      "service-workflow-build",
      serviceDefinition
    )
    const serviceKey: PlanStore.RunKey = {
      tenantId: "tenant-service",
      runId: "run-service"
    }

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(serviceDefinition, {
        formatVersion: 1,
        id: "durable-recovery-service-plan",
        revision: 1,
        definition: {
          id: serviceDefinition.id,
          version: serviceDefinition.version
        },
        nodes: [{
          id: "service-worker",
          type: serviceStep.type,
          version: serviceStep.version,
          config: "value"
        }],
        edges: []
      })
      const plan = yield* Decision.prepare(compiled)
      const catalog = yield* Deployment.makeMemory({
        workflowDefinitions: [serviceWitness],
        handlerDefinitions: [
          Deployment.handlerDefinition("service-handler-build", serviceStep)
        ]
      })
      const start = yield* DurableStart.prepare(plan, {}, {
        tenantId: serviceKey.tenantId,
        runId: serviceKey.runId,
        workflowIdentity: "service",
        requestId: "service-request",
        definitionDeploymentId: serviceWitness.deploymentId,
        dispatchTargets: {
          "service-worker": {
            queue: "service",
            deploymentId: "service-handler-build"
          }
        }
      }).pipe(Effect.provideService(Deployment.DeploymentCatalog, catalog))
      const services = yield* ExecutionStore.makeMemory
      yield* services.executionStore.start(start)

      const recoveryEffect: Effect.Effect<
        DurableRecovery.RecoveredRun<typeof serviceDefinition>,
        DurableRecovery.RecoverError<typeof serviceDefinition>,
        | PlanStore.PlanStore
        | ExecutionStore.ExecutionStore
        | Deployment.DeploymentCatalog
        | Crypto.Crypto
        | ConfigDecoder
      > = DurableRecovery.recover(serviceKey, serviceWitness)

      const recovered = yield* recoveryEffect.pipe(
        Effect.provideService(PlanStore.PlanStore, services.planStore),
        Effect.provideService(ExecutionStore.ExecutionStore, services.executionStore),
        Effect.provideService(Deployment.DeploymentCatalog, catalog)
      )
      assert.strictEqual(
        recovered.plan.compiled.nodes.get("service-worker")?.definition,
        serviceStep
      )
    }).pipe(
      Effect.provideService(ConfigDecoder, { prefix: "decoded:" }),
      Effect.provideService(Crypto.Crypto, testCrypto)
    )
  })

  it.effect("propagates strict history-fold failures before returning provenance", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture
      const first = fixture.history.events[0]!
      const invalidHistory: HistoryStore.HistorySnapshot = {
        ...fixture.history,
        events: [{
          ...first,
          eventId: "noncanonical"
        }]
      }
      const result = yield* Effect.result(recover(fixture, {
        executionStore: mockExecutionStore(fixture, invalidHistory)
      }))
      const error = recoveryFailure(result)

      assert.instanceOf(error, RunState.HistoryError)
      if (error instanceof RunState.HistoryError) {
        assert.strictEqual(error.code, RunState.Codes.NonCanonicalEventId)
      }
    }))
})
