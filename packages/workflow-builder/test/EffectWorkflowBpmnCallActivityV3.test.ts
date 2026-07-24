import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { WorkflowEngine } from "effect/unstable/workflow"
import { createHash } from "node:crypto"
import * as CallActivity from "../src/BpmnCallActivityV3.ts"
import * as ChildLifecycle from "../src/ChildWorkflowLifecycleV3.ts"
import * as ChildProtocol from "../src/ChildWorkflowProtocolV3.ts"
import * as ChildState from "../src/ChildWorkflowStateV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as Backend from "../src/EffectWorkflowBackendV3.ts"
import * as NativeCallActivity from "../src/EffectWorkflowBpmnCallActivityV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

const timestamp = (
  second: number
): string => `2026-07-24T10:00:${String(second).padStart(2, "0")}.000Z`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const definition = Workflow.make("native-call-child", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(),
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 1,
    maxEdges: 1,
    maxFanIn: 1,
    maxFanOut: 1,
    maxDepth: 1
  })
})

const buildPin = (
  executableKind: PlanStoreV3.ExecutableKind,
  executableId: string,
  executableVersion: string,
  deploymentId: string
) =>
  Effect.gen(function*() {
    const buildDocument: PlanStoreV3.ExecutableBuildDocument = {
      buildDocumentVersion: 3,
      executableKind,
      executableId,
      executableVersion,
      deploymentId,
      catalogBuildId: `catalog:${deploymentId}`
    }
    return {
      deploymentId,
      buildDocument,
      buildDigest: yield* DigestV3.executableBuild(buildDocument)
    } satisfies PlanStoreV3.ExecutableBuildPin
  })

const makeVerified = (revision = 1) =>
  Effect.gen(function*() {
    const plan = {
      formatVersion: 1 as const,
      id: "native-call-child-plan",
      revision,
      definition: {
        id: definition.id,
        version: definition.version
      },
      nodes: [],
      edges: []
    }
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      `native-call-child-deployment-${revision}`
    )
    const inputDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: []
    }
    const outputDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Output" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: []
    }
    const artifact: PlanStoreV3.StaticDagArtifact = {
      artifactVersion: 3,
      artifactKind: "StaticDag",
      executionProtocolVersion: 3,
      fingerprintDocument: compiled.fingerprintDocument,
      compiledFingerprint: yield* DigestV3.compiledPlan(
        compiled.fingerprintDocument
      ),
      workflowFamilyIdentity: Child.workflowFamilyIdentity(definition.id),
      definition: {
        id: definition.id,
        version: definition.version,
        build: definitionBuild
      },
      inputBoundary: {
        document: inputDocument,
        digest: yield* DigestV3.boundaryContract(inputDocument)
      },
      outputBoundary: {
        document: outputDocument,
        digest: yield* DigestV3.boundaryContract(outputDocument)
      },
      nodeDefinitions: [],
      codecs: [],
      policyExecutableBuilds: [],
      nodeBindings: []
    }
    return yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )
  })

const closePolicy = (
  onParentFailure: Child.ChildCloseAction = "CancelAndWait",
  onParentCancellation: Child.ChildCloseAction = "RequestCancel"
): Child.ChildClosePolicy => ({
  closePolicyVersion: Child.ExecutionProtocolVersion,
  onParentFailure,
  onParentCancellation
})

const makeTarget = (
  verified: PlanStoreV3.VerifiedArtifact,
  policy: Child.ChildClosePolicy = closePolicy()
) =>
  success(PlanStoreV3.deriveChildTarget(verified, {
    closePolicy: policy,
    maxLineageDepth: Child.MaximumLineageDepth
  }))

const makeRelation = (
  target: Child.ChildTargetPin,
  nodeInstanceId = "call-child-token-1"
) =>
  success(CallActivity.deriveRelation({
    contextVersion: CallActivity.ExecutionContextVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    tenantId: "tenant-1",
    runId: "parent-run-1",
    rootRunId: "parent-run-1",
    artifactDigest: digest("f"),
    workflowFamilyIdentity: Child.workflowFamilyIdentity("native-call-parent"),
    ancestry: [{
      lineageEntryVersion: Child.ExecutionProtocolVersion,
      depth: 0,
      tenantId: "tenant-1",
      runId: "parent-run-1",
      artifactDigest: digest("f"),
      workflowFamilyIdentity: Child.workflowFamilyIdentity(
        "native-call-parent"
      )
    }]
  }, {
    bindingVersion: CallActivity.CallActivityBindingVersion,
    executionProtocolVersion: Child.ExecutionProtocolVersion,
    profileId: CallActivity.PortableChildProcessProfile,
    callActivityNodeId: "call-child",
    calledElement: {
      namespaceUri: "urn:effect:workflow-builder:test",
      localName: "native-call-child"
    },
    target,
    encodedInputExpression: {
      language: "effect-expression",
      version: "1",
      source: "input"
    },
    maxEncodedInputCanonicalBytes: CallActivity.MaximumEncodedInputCanonicalBytes
  }, nodeInstanceId))

const makeSchedule = (
  relation: Child.ChildRelation
): ChildProtocol.Command =>
  success(CallActivity.makeScheduleCommand(
    relation,
    {
      _tag: "Inline",
      value: { invoiceId: "invoice-1" }
    },
    "parent-call-activated"
  ))

const makeScheduledState = (
  relation: Child.ChildRelation
): ChildState.ChildWorkflowState =>
  success(ChildState.fold([
    success(CallActivity.makeScheduledEvent(
      relation,
      {
        _tag: "Inline",
        value: { invoiceId: "invoice-1" }
      },
      timestamp(0),
      "parent-call-activated"
    ))
  ]))

const makeStartAcceptedIngress = (
  relation: Child.ChildRelation,
  locator?: NativeCallActivity.NativeBackendLocator
) => ({
  requestVersion: NativeCallActivity.LifecycleIngressRequestVersion,
  lifecycle: {
    requestVersion: ChildLifecycle.PreparationRequestVersion,
    recordedAt: timestamp(1),
    fact: {
      _tag: "ChildStartAccepted" as const,
      factVersion: ChildLifecycle.LifecycleFactVersion,
      childRunId: relation.childRunId,
      sourceSequence: 1,
      occurredAt: timestamp(1),
      childRunStartedEventId: "native-child-run-started"
    }
  },
  ...(locator === undefined ? {} : { locator })
})

const makeStartFailedIngress = (
  relation: Child.ChildRelation,
  locator?: NativeCallActivity.NativeBackendLocator
) => ({
  requestVersion: NativeCallActivity.LifecycleIngressRequestVersion,
  lifecycle: {
    requestVersion: ChildLifecycle.PreparationRequestVersion,
    recordedAt: timestamp(1),
    fact: {
      _tag: "ChildStartFailed" as const,
      factVersion: ChildLifecycle.LifecycleFactVersion,
      childRunId: relation.childRunId,
      startRequestId: relation.startRequestId,
      decidedAt: timestamp(1),
      failureKind: "Rejected" as const,
      failure: {
        _tag: "Inline" as const,
        value: { code: "ChildStartRejected" }
      }
    }
  },
  ...(locator === undefined ? {} : { locator })
})

const invocationFor = (
  command: ChildProtocol.Command,
  relation: Child.ChildRelation
): Backend.RunInvocation => {
  if (command.payload._tag !== "ScheduleChild") {
    throw new Error("Expected ScheduleChild")
  }
  return {
    tenantId: command.tenantId,
    runId: relation.childRunId,
    requestId: relation.startRequestId,
    input: command.payload.encodedInput
  }
}

const completed = (
  binding: Backend.PreparedBinding
): Backend.RunSuccess => ({
  _tag: "Completed",
  completionVersion: 1,
  outputContractDigest: binding.outputContractDigest,
  output: {
    _tag: "Inline",
    value: { completed: true }
  }
})

const makeClose = (
  relation: Child.ChildRelation,
  cause: ChildProtocol.ParentCloseCause
): CallActivity.ParentCloseCommand => success(CallActivity.makeParentCloseCommand(relation, cause))

const claimId = "native-child-start-claim-1"

const nativeLocator = (
  executionId: string
): NativeCallActivity.NativeBackendLocator => ({
  locatorVersion: CallActivity.BackendLocatorVersion,
  backendId: NativeCallActivity.BackendId,
  executionId
})

const makeAuthority = (
  overrides: Partial<NativeCallActivity.ChildRelationAuthority["Service"]> = {}
): NativeCallActivity.ChildRelationAuthority["Service"] =>
  NativeCallActivity.ChildRelationAuthority.of({
    prepareSchedule: (command) =>
      Effect.succeed({
        _tag: "ResolveNativeTarget",
        adapterVersion: NativeCallActivity.AdapterVersion,
        commandId: command.commandId,
        claimId
      }),
    admitNativeStart: ({ command, claimId, locator }) =>
      Effect.succeed({
        _tag: "SubmitNativeStart",
        adapterVersion: NativeCallActivity.AdapterVersion,
        commandId: command.commandId,
        claimId,
        locator
      }),
    recordNativeStart: ({ command, claimId, locator }) =>
      Effect.succeed({
        _tag: "NativeStartAddressRecorded",
        adapterVersion: NativeCallActivity.AdapterVersion,
        commandId: command.commandId,
        claimId,
        locator
      }),
    selectCancellation: (command) =>
      Effect.succeed({
        _tag: "NoNativeInterruption",
        adapterVersion: NativeCallActivity.AdapterVersion,
        commandId: command.commandId,
        reason: "CancelledBeforeStart"
      }),
    recordNativeInterruption: ({ command, claimId, locator }) =>
      Effect.succeed({
        _tag: "NativeInterruptionRecorded",
        adapterVersion: NativeCallActivity.AdapterVersion,
        commandId: command.commandId,
        claimId,
        locator
      }),
    acknowledgeAbandon: (command) =>
      Effect.succeed({
        _tag: "AbandonRecorded",
        adapterVersion: NativeCallActivity.AdapterVersion,
        commandId: command.commandId
      }),
    ...overrides
  })

const resolver = (
  binding: Backend.PreparedBinding
): NativeCallActivity.ChildBindingResolver["Service"] => success(NativeCallActivity.makeBindingResolver([binding]))

const nativeLayer = (
  binding: Backend.PreparedBinding,
  authority: NativeCallActivity.ChildRelationAuthority["Service"],
  handler: Backend.SemanticHandler = () => Effect.never
) => {
  const registration = success(Backend.toLayer(binding, handler))
  return Layer.mergeAll(
    registration.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
    Layer.succeed(NativeCallActivity.ChildBindingResolver, resolver(binding)),
    Layer.succeed(NativeCallActivity.ChildRelationAuthority, authority)
  )
}

describe("EffectWorkflowBpmnCallActivityV3", () => {
  it.effect("prepares an exact opaque start-accepted lifecycle ingress command", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const state = makeScheduledState(relation)
      const executionId = yield* Backend.executionIdForRun(binding, {
        tenantId: relation.parent.tenantId,
        runId: relation.childRunId
      })
      const locator = nativeLocator(executionId)

      const prepared = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        binding,
        state,
        makeStartAcceptedIngress(relation, locator)
      )

      assert.isTrue(
        NativeCallActivity.isPreparedNativeLifecycleIngress(prepared)
      )
      assert.isFalse(
        NativeCallActivity.isPreparedNativeLifecycleIngress({
          ...prepared
        })
      )
      assert.isTrue(Object.isFrozen(prepared))
      assert.strictEqual(
        prepared.preparedVersion,
        NativeCallActivity.PreparedLifecycleIngressVersion
      )
      assert.strictEqual(
        prepared.bindingArtifactDigest,
        binding.artifactDigest
      )
      assert.strictEqual(prepared.expectedPreviousSequence, 0)
      assert.deepStrictEqual(prepared.locator, locator)
      assert.strictEqual(prepared.lifecycle.event.sequence, 1)
      assert.strictEqual(
        prepared.lifecycle.event.eventId,
        ChildProtocol.childStartProjectionEventId(
          relation.parent.tenantId,
          relation.parent.parentRunId,
          relation.parent.callId,
          "native-child-run-started"
        )
      )
      assert.strictEqual(
        prepared.lifecycle.event.causationId,
        "native-child-run-started"
      )
      assert.deepStrictEqual(prepared.lifecycle.event.payload, {
        _tag: "ChildStartAccepted",
        childRunId: relation.childRunId,
        startRequestId: relation.startRequestId,
        childRunStartedEventId: "native-child-run-started"
      })
      assert.deepStrictEqual(prepared.command, {
        commandVersion: CallActivity.ApplyChildEventCommandVersion,
        executionProtocolVersion: ChildProtocol.ExecutionProtocolVersion,
        callFrameId: relation.parent.callId,
        event: prepared.lifecycle.event,
        backendLocator: locator
      })
    }).pipe(provideCrypto))

  it.effect("rejects a lifecycle locator for a different native child run", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const state = makeScheduledState(relation)
      const foreignExecutionId = yield* Backend.executionIdForRun(binding, {
        tenantId: relation.parent.tenantId,
        runId: `${relation.childRunId}-foreign`
      })

      const failure = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        binding,
        state,
        makeStartAcceptedIngress(
          relation,
          nativeLocator(foreignExecutionId)
        )
      ).pipe(Effect.flip)

      assert.strictEqual(
        failure.code,
        NativeCallActivity.ErrorCodes.NativeExecutionAddressMismatch
      )
    }).pipe(provideCrypto))

  it.effect("accepts start failure without a locator and rejects one that claims an address", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const state = makeScheduledState(relation)
      const executionId = yield* Backend.executionIdForRun(binding, {
        tenantId: relation.parent.tenantId,
        runId: relation.childRunId
      })

      const prepared = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        binding,
        state,
        makeStartFailedIngress(relation)
      )
      assert.strictEqual(
        prepared.lifecycle.event.payload._tag,
        "ChildStartFailed"
      )
      assert.isFalse("locator" in prepared)
      assert.isFalse("backendLocator" in prepared.command)

      const failure = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        binding,
        state,
        makeStartFailedIngress(
          relation,
          nativeLocator(executionId)
        )
      ).pipe(Effect.flip)
      assert.strictEqual(
        failure.code,
        NativeCallActivity.ErrorCodes.InvalidLifecycleIngressRequest
      )
    }).pipe(provideCrypto))

  it.effect("rejects a child-origin lifecycle fact without its native locator", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const failure = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        binding,
        makeScheduledState(relation),
        makeStartAcceptedIngress(relation)
      ).pipe(Effect.flip)

      assert.strictEqual(
        failure.code,
        NativeCallActivity.ErrorCodes.InvalidLifecycleIngressRequest
      )
    }).pipe(provideCrypto))

  it.effect("rejects lifecycle ingress through a binding for another target", () =>
    Effect.gen(function*() {
      const first = yield* makeVerified(1)
      const second = yield* makeVerified(2)
      const firstBinding = success(Backend.prepare(first))
      const relation = makeRelation(makeTarget(second))

      const failure = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        firstBinding,
        makeScheduledState(relation),
        makeStartAcceptedIngress(
          relation,
          nativeLocator("native-child-address")
        )
      ).pipe(Effect.flip)

      assert.strictEqual(
        failure.code,
        Backend.ErrorCodes.ChildTargetMismatch
      )
    }).pipe(provideCrypto))

  it.effect("rejects a structural copy of a prepared lifecycle binding", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const executionId = yield* Backend.executionIdForRun(binding, {
        tenantId: relation.parent.tenantId,
        runId: relation.childRunId
      })

      const failure = yield* NativeCallActivity.prepareNativeLifecycleIngress(
        { ...binding },
        makeScheduledState(relation),
        makeStartAcceptedIngress(
          relation,
          nativeLocator(executionId)
        )
      ).pipe(Effect.flip)

      assert.strictEqual(failure.code, Backend.ErrorCodes.UnpreparedBinding)
    }).pipe(provideCrypto))

  it.effect("submits the exact child address without manufacturing a semantic event", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const target = makeTarget(verified)
      const relation = makeRelation(target)
      const command = makeSchedule(relation)
      let starts = 0
      const layer = nativeLayer(
        binding,
        makeAuthority(),
        () =>
          Effect.sync(() => {
            starts++
            return completed(binding)
          })
      )
      const receipt = yield* Effect.gen(function*() {
        const receipt = yield* NativeCallActivity.dispatchSchedule(command)
        yield* Backend.execute(binding, invocationFor(command, relation))
        return receipt
      }).pipe(Effect.provide(layer))
      const expectedExecutionId = yield* Backend.executionId(binding, {
        ...invocationFor(command, relation)
      })

      assert.strictEqual(receipt._tag, "NativeStartSubmitted")
      assert.deepStrictEqual(receipt.locator, nativeLocator(expectedExecutionId))
      assert.isFalse(receipt.semanticEventProduced)
      assert.strictEqual(starts, 1)
    }).pipe(provideCrypto))

  it.effect("redelivers after a post-start record crash without starting a second child", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const command = makeSchedule(relation)
      let recordAttempts = 0
      let starts = 0
      const authority = makeAuthority({
        recordNativeStart: ({ command, claimId, locator }) => {
          recordAttempts++
          return recordAttempts === 1
            ? Effect.fail(
              new NativeCallActivity.ChildRelationAuthorityError({
                operation: "recordNativeStart",
                code: "InjectedCrash",
                message: "crash after native start submission",
                retryable: true,
                commandId: command.commandId
              })
            )
            : Effect.succeed({
              _tag: "NativeStartAddressAlreadyRecorded",
              adapterVersion: NativeCallActivity.AdapterVersion,
              commandId: command.commandId,
              claimId,
              locator
            })
        }
      })
      const layer = nativeLayer(
        binding,
        authority,
        () =>
          Effect.sync(() => {
            starts++
            return completed(binding)
          })
      )

      yield* Effect.gen(function*() {
        const first = yield* Effect.result(
          NativeCallActivity.dispatchSchedule(command)
        )
        assert(Result.isFailure(first))
        if (Result.isFailure(first)) {
          assert.instanceOf(
            first.failure,
            NativeCallActivity.ChildRelationAuthorityError
          )
        }

        const replayed = yield* NativeCallActivity.dispatchSchedule(command)
        yield* Backend.execute(binding, invocationFor(command, relation))
        assert.strictEqual(replayed._tag, "NativeStartSubmitted")
        assert.strictEqual(replayed.addressRecord, "AlreadyRecorded")
        assert.isFalse(replayed.semanticEventProduced)
        assert.strictEqual(recordAttempts, 2)
        assert.strictEqual(starts, 1)
      }).pipe(Effect.provide(layer))
    }).pipe(provideCrypto))

  it("suppresses cancellation before start without resolving or loading a native backend", async () => {
    const verified = await Effect.runPromise(makeVerified().pipe(provideCrypto))
    const relation = makeRelation(makeTarget(verified))
    const command = makeClose(relation, {
      _tag: "ParentFailure",
      parentCauseEventId: "parent-failed-before-child-start"
    })
    assert.strictEqual(command.payload._tag, "RequestChildCancellation")
    const receipt = await Effect.runPromise(
      NativeCallActivity.dispatchCancellation(command).pipe(
        Effect.provideService(
          NativeCallActivity.ChildRelationAuthority,
          makeAuthority()
        )
      ) as Effect.Effect<NativeCallActivity.CancellationDispatchReceipt, unknown>
    )

    assert.deepStrictEqual(receipt, {
      _tag: "NoNativeInterruption",
      receiptVersion: NativeCallActivity.ReceiptVersion,
      backendId: NativeCallActivity.BackendId,
      commandId: command.commandId,
      reason: "CancelledBeforeStart",
      semanticEventProduced: false
    })
  })

  it.effect("interrupts only the exact durably selected native child address", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const relation = makeRelation(makeTarget(verified))
      const schedule = makeSchedule(relation)
      const childStarted = yield* Deferred.make<void>()
      const releaseChild = yield* Deferred.make<void>()
      const childFinalized = yield* Deferred.make<void>()
      let selectedLocator:
        | NativeCallActivity.NativeBackendLocator
        | undefined
      let interruptionRecords = 0
      const authority = makeAuthority({
        selectCancellation: (command) =>
          Effect.succeed({
            _tag: "SubmitNativeInterruption",
            adapterVersion: NativeCallActivity.AdapterVersion,
            commandId: command.commandId,
            claimId: "native-child-cancel-claim-1",
            locator: selectedLocator!
          }),
        recordNativeInterruption: ({ command, claimId, locator }) =>
          Effect.sync(() => {
            interruptionRecords++
            return {
              _tag: "NativeInterruptionRecorded" as const,
              adapterVersion: NativeCallActivity.AdapterVersion,
              commandId: command.commandId,
              claimId,
              locator
            }
          })
      })

      yield* Effect.gen(function*() {
        const started = yield* NativeCallActivity.dispatchSchedule(schedule)
        selectedLocator = started.locator
        yield* Deferred.await(childStarted)
        const command = makeClose(relation, {
          _tag: "ParentFailure",
          parentCauseEventId: "parent-failed-after-child-start"
        })
        const receipt = yield* NativeCallActivity.dispatchCancellation(command)

        assert.strictEqual(receipt._tag, "NativeInterruptionSubmitted")
        assert.deepStrictEqual(receipt.locator, selectedLocator)
        assert.strictEqual(interruptionRecords, 1)
        assert.isFalse(receipt.semanticEventProduced)
        assert.isFalse(yield* Deferred.isDone(childFinalized))
        yield* Deferred.succeed(releaseChild, undefined)
        yield* Deferred.await(childFinalized)
      }).pipe(Effect.provide(nativeLayer(
        binding,
        authority,
        () =>
          Deferred.succeed(childStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseChild)),
            Effect.as(completed(binding)),
            Effect.ensuring(
              Deferred.succeed(childFinalized, undefined)
            )
          )
      )))
    }).pipe(provideCrypto))

  it("returns a RequestCancel dispatch result immediately without inventing completion", async () => {
    const verified = await Effect.runPromise(makeVerified().pipe(provideCrypto))
    const relation = makeRelation(makeTarget(verified))
    const command = makeClose(relation, {
      _tag: "ParentCancellation",
      parentCauseEventId: "parent-cancellation-requested"
    })
    assert.strictEqual(command.payload._tag, "RequestChildCancellation")
    if (command.payload._tag === "RequestChildCancellation") {
      assert.strictEqual(command.payload.closeAction, "RequestCancel")
    }
    const authority = makeAuthority({
      selectCancellation: (selected) =>
        Effect.succeed({
          _tag: "AwaitNativeStartAddress",
          adapterVersion: NativeCallActivity.AdapterVersion,
          commandId: selected.commandId
        })
    })
    const receipt = await Effect.runPromise(
      NativeCallActivity.dispatchCancellation(command).pipe(
        Effect.provideService(
          NativeCallActivity.ChildRelationAuthority,
          authority
        )
      ) as Effect.Effect<NativeCallActivity.CancellationDispatchReceipt, unknown>
    )

    assert.strictEqual(receipt._tag, "AwaitingNativeStartAddress")
    assert.isFalse(receipt.semanticEventProduced)
  })

  it("acknowledges Abandon without a resolver or WorkflowEngine", async () => {
    const verified = await Effect.runPromise(makeVerified().pipe(provideCrypto))
    const relation = makeRelation(makeTarget(
      verified,
      closePolicy("CancelAndWait", "Abandon")
    ))
    const command = makeClose(relation, {
      _tag: "ParentCancellation",
      parentCauseEventId: "parent-abandoned-child"
    })
    assert.strictEqual(command.payload._tag, "AbandonChild")
    const receipt = await Effect.runPromise(
      NativeCallActivity.dispatchAbandon(command).pipe(
        Effect.provideService(
          NativeCallActivity.ChildRelationAuthority,
          makeAuthority()
        )
      ) as Effect.Effect<NativeCallActivity.AbandonDispatchReceipt, unknown>
    )

    assert.deepStrictEqual(receipt, {
      _tag: "AbandonAcknowledged",
      receiptVersion: NativeCallActivity.ReceiptVersion,
      backendId: NativeCallActivity.BackendId,
      commandId: command.commandId,
      abandonRecord: "Recorded",
      semanticEventProduced: false
    })
  })

  it.effect("rejects incoherent durable-authority output before target resolution", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const command = makeSchedule(makeRelation(makeTarget(verified)))
      let resolutions = 0
      const badAuthority = makeAuthority({
        prepareSchedule: () =>
          Effect.succeed({
            _tag: "ResolveNativeTarget",
            adapterVersion: NativeCallActivity.AdapterVersion,
            commandId: "another-command",
            claimId
          })
      })
      const hostileResolver = NativeCallActivity.ChildBindingResolver.of({
        resolve: () =>
          Effect.sync(() => {
            resolutions++
            return binding
          })
      })
      const failure = yield* NativeCallActivity.dispatchSchedule(command).pipe(
        Effect.provideService(
          NativeCallActivity.ChildRelationAuthority,
          badAuthority
        ),
        Effect.provideService(
          NativeCallActivity.ChildBindingResolver,
          hostileResolver
        ),
        Effect.provide(WorkflowEngine.layerMemory),
        Effect.flip
      )

      assert.strictEqual(
        failure.code,
        NativeCallActivity.ErrorCodes.AuthorityCommandMismatch
      )
      assert.strictEqual(resolutions, 0)
    }).pipe(provideCrypto))

  it.effect("rejects a target pin resolved to a different prepared binding", () =>
    Effect.gen(function*() {
      const first = yield* makeVerified(1)
      const second = yield* makeVerified(2)
      const firstBinding = success(Backend.prepare(first))
      const command = makeSchedule(makeRelation(makeTarget(second)))
      const substitutingResolver = NativeCallActivity.ChildBindingResolver.of({
        resolve: () => Effect.succeed(firstBinding)
      })
      const failure = yield* NativeCallActivity.dispatchSchedule(command).pipe(
        Effect.provideService(
          NativeCallActivity.ChildRelationAuthority,
          makeAuthority()
        ),
        Effect.provideService(
          NativeCallActivity.ChildBindingResolver,
          substitutingResolver
        ),
        Effect.provide(WorkflowEngine.layerMemory),
        Effect.flip
      )

      assert.strictEqual(failure.code, Backend.ErrorCodes.ChildTargetMismatch)
    }).pipe(provideCrypto))
})
