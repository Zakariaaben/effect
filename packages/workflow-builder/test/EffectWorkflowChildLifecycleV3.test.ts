import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import { WorkflowEngine } from "effect/unstable/workflow"
import { createHash } from "node:crypto"
import * as ChildLifecycle from "../src/ChildWorkflowLifecycleV3.ts"
import * as Child from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as Backend from "../src/EffectWorkflowBackendV3.ts"
import * as NativeCallActivity from "../src/EffectWorkflowBpmnCallActivityV3.ts"
import * as NativeLifecycle from "../src/EffectWorkflowChildLifecycleV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

const timestamp = (
  second: number
): string => `2026-07-24T12:00:${String(second).padStart(2, "0")}.000Z`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const permissiveInterruptRetry = Schedule.recurs(3).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const definition = Workflow.make("native-lifecycle-child", {
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
      id: "native-lifecycle-child-plan",
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
      `native-lifecycle-child-deployment-${revision}`
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

const invocation = (
  runId = "child-run-1"
): Backend.RunInvocation => ({
  tenantId: "tenant-1",
  runId,
  requestId: `start-${runId}`,
  input: {
    _tag: "Inline",
    value: { invoiceId: "invoice-1" }
  }
})

const completed = (
  binding: Backend.PreparedBinding,
  value: unknown = { accepted: true }
): Backend.RunSuccess => ({
  _tag: "Completed",
  completionVersion: 1,
  outputContractDigest: binding.outputContractDigest,
  output: {
    _tag: "Inline",
    value
  }
})

const runFailure = (
  kind: Backend.RunFailureKind = "BusinessFailure"
): Backend.RunFailure => ({
  _tag: "Failed",
  failureVersion: 1,
  failureKind: kind,
  failure: {
    _tag: "Inline",
    value: {
      code: "InvoiceRejected",
      details: {
        reason: "duplicate",
        retryable: false
      }
    }
  }
})

const reportBase = (
  sourceEventId: string,
  childRunId = "child-run-1"
) => ({
  reportVersion: NativeLifecycle.SourceReportVersion,
  adapterVersion: NativeLifecycle.AdapterVersion,
  executionProtocolVersion: Backend.ExecutionProtocolVersion,
  tenantId: "tenant-1",
  childRunId,
  startRequestId: `start-${childRunId}`,
  artifactDigest: digest("a"),
  locator: {
    locatorVersion: 1 as const,
    backendId: NativeCallActivity.BackendId,
    executionId: `native-${childRunId}`
  },
  sourceEventId
})

const startedReport = (
  sourceEventId = "child-started-1"
): NativeLifecycle.ChildStartAcceptedReport => ({
  _tag: "ChildStartAccepted",
  ...reportBase(sourceEventId)
})

const succeededReport = (
  sourceEventId = "child-succeeded-1"
): NativeLifecycle.ChildSucceededReport => ({
  _tag: "ChildSucceeded",
  ...reportBase(sourceEventId),
  outputContractDigest: digest("b"),
  encodedOutput: {
    _tag: "Inline",
    value: {
      invoiceId: "invoice-1",
      accepted: true
    }
  }
})

const failedReport = (
  sourceEventId = "child-failed-1"
): NativeLifecycle.ChildFailedReport => ({
  _tag: "ChildFailed",
  ...reportBase(sourceEventId),
  failure: runFailure()
})

const allocation = (
  sourceSequence = 1,
  occurredAt = timestamp(sourceSequence)
): NativeLifecycle.SourceFactAllocation => ({
  allocationVersion: NativeLifecycle.SourceAllocationVersion,
  sourceSequence,
  occurredAt
})

const receipt = (
  report: NativeLifecycle.ChildLifecycleSourceReport,
  sourceSequence = 1
): NativeLifecycle.CanonicalLifecycleReceipt => ({
  receiptVersion: NativeLifecycle.CanonicalReceiptVersion,
  outboxEntryId: `outbox-${sourceSequence}`,
  report,
  fact: success(
    NativeLifecycle.makeCanonicalFact(report, allocation(sourceSequence))
  )
})

interface OutboxFixture {
  readonly service: NativeLifecycle.ChildLifecycleSourceOutbox["Service"]
  readonly reports: Array<NativeLifecycle.ChildLifecycleSourceReport>
  readonly receipts: Map<string, NativeLifecycle.CanonicalLifecycleReceipt>
}

const makeOutboxFixture = (
  timeline: Array<string> = []
): OutboxFixture => {
  const reports: Array<NativeLifecycle.ChildLifecycleSourceReport> = []
  const receipts = new Map<
    string,
    NativeLifecycle.CanonicalLifecycleReceipt
  >()
  const service: NativeLifecycle.ChildLifecycleSourceOutbox["Service"] = {
    record: (report) =>
      Effect.suspend(() => {
        reports.push(report)
        timeline.push(`outbox:${report._tag}`)
        const key = JSON.stringify([
          report.tenantId,
          report.childRunId,
          report.sourceEventId
        ])
        const prior = receipts.get(key)
        if (prior !== undefined) {
          const replay = NativeLifecycle.validateCanonicalReceipt(
            report,
            prior
          )
          return Result.isSuccess(replay) ?
            Effect.succeed(prior) :
            Effect.fail(
              new NativeLifecycle.ChildLifecycleSourceOutboxError({
                code: NativeLifecycle.SourceOutboxErrorCodes.Conflict,
                message: "Lifecycle source identity was reused with different content",
                sourceEventId: report.sourceEventId,
                retryable: false
              })
            )
        }
        const sourceSequence = receipts.size + 1
        const first = {
          receiptVersion: NativeLifecycle.CanonicalReceiptVersion,
          outboxEntryId: `outbox-entry-${sourceSequence}`,
          report,
          fact: success(
            NativeLifecycle.makeCanonicalFact(
              report,
              allocation(sourceSequence)
            )
          )
        } satisfies NativeLifecycle.CanonicalLifecycleReceipt
        receipts.set(key, first)
        return Effect.succeed(first)
      })
  }
  return { service, reports, receipts }
}

const runtimeLayer = (
  registration: Layer.Layer<
    never,
    never,
    NativeLifecycle.RegistrationRequirements<never>
  >,
  outbox: NativeLifecycle.ChildLifecycleSourceOutbox["Service"]
) =>
  registration.pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(
      Layer.succeed(NativeLifecycle.ChildLifecycleSourceOutbox, outbox)
    )
  )

describe("EffectWorkflowChildLifecycleV3", () => {
  it("strictly validates source reports, allocations, and receipts", () => {
    const report = startedReport()
    const checked = NativeLifecycle.validateSourceReport(report)
    assert(Result.isSuccess(checked))
    assert.isTrue(Object.isFrozen(checked.success))

    const excessReport = NativeLifecycle.validateSourceReport({
      ...report,
      forged: true
    })
    assert(Result.isFailure(excessReport))
    assert.strictEqual(
      excessReport.failure.code,
      NativeLifecycle.ErrorCodes.InvalidReport
    )

    const invalidAllocation = NativeLifecycle.makeCanonicalFact(report, {
      ...allocation(),
      forged: true
    })
    assert(Result.isFailure(invalidAllocation))
    assert.strictEqual(
      invalidAllocation.failure.code,
      NativeLifecycle.ErrorCodes.InvalidAllocation
    )

    const excessReceipt = NativeLifecycle.validateCanonicalReceipt(
      report,
      {
        ...receipt(report),
        forged: true
      }
    )
    assert(Result.isFailure(excessReceipt))
    assert.strictEqual(
      excessReceipt.failure.code,
      NativeLifecycle.ErrorCodes.InvalidReceipt
    )
  })

  it("constructs exact start, success, and complete failure facts", () => {
    const started = success(
      NativeLifecycle.makeCanonicalFact(
        startedReport(),
        allocation(3, timestamp(3))
      )
    )
    assert.deepStrictEqual(started, {
      _tag: "ChildStartAccepted",
      factVersion: ChildLifecycle.LifecycleFactVersion,
      childRunId: "child-run-1",
      sourceSequence: 3,
      occurredAt: timestamp(3),
      childRunStartedEventId: "child-started-1"
    })

    const succeeded = success(
      NativeLifecycle.makeCanonicalFact(
        succeededReport(),
        allocation(4, timestamp(4))
      )
    )
    assert.deepStrictEqual(succeeded, {
      _tag: "ChildSucceeded",
      factVersion: ChildLifecycle.LifecycleFactVersion,
      childRunId: "child-run-1",
      sourceSequence: 4,
      occurredAt: timestamp(4),
      childTerminalEventId: "child-succeeded-1",
      outputContractDigest: digest("b"),
      encodedOutput: {
        _tag: "Inline",
        value: {
          invoiceId: "invoice-1",
          accepted: true
        }
      }
    })

    const failed = success(
      NativeLifecycle.makeCanonicalFact(
        failedReport(),
        allocation(5, timestamp(5))
      )
    )
    assert.deepStrictEqual(failed, {
      _tag: "ChildFailed",
      factVersion: ChildLifecycle.LifecycleFactVersion,
      childRunId: "child-run-1",
      sourceSequence: 5,
      occurredAt: timestamp(5),
      childTerminalEventId: "child-failed-1",
      failure: {
        _tag: "Inline",
        value: runFailure()
      }
    })
  })

  it("accepts only the exact first receipt and fails closed on drift", () => {
    const report = succeededReport()
    const exact = receipt(report, 7)
    const checked = NativeLifecycle.validateCanonicalReceipt(report, exact)
    assert(Result.isSuccess(checked))
    assert.deepStrictEqual(checked.success, exact)

    const drift = NativeLifecycle.validateCanonicalReceipt(
      succeededReport("different-source-event"),
      exact
    )
    assert(Result.isFailure(drift))
    assert.strictEqual(
      drift.failure.code,
      NativeLifecycle.ErrorCodes.ReceiptDrift
    )

    assert.strictEqual(exact.fact._tag, "ChildSucceeded")
    if (exact.fact._tag !== "ChildSucceeded") {
      return
    }
    const inconsistent = NativeLifecycle.validateCanonicalReceipt(report, {
      ...exact,
      fact: {
        ...exact.fact,
        childTerminalEventId: "substituted-terminal-event"
      }
    })
    assert(Result.isFailure(inconsistent))
    assert.strictEqual(
      inconsistent.failure.code,
      NativeLifecycle.ErrorCodes.InvalidReceipt
    )

    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile receipt")
      }
    })
    const rejectedHostile = NativeLifecycle.validateCanonicalReceipt(
      report,
      hostile
    )
    assert(Result.isFailure(rejectedHostile))
    assert.strictEqual(
      rejectedHostile.failure.code,
      NativeLifecycle.ErrorCodes.InvalidReceipt
    )
  })

  it("binds persisted publication failures to the complete source report", () => {
    const report = succeededReport()
    const applicationError: NativeLifecycle.LifecyclePublicationErrorSnapshot = {
      _tag: "ChildLifecycleSourceOutboxError",
      code: NativeLifecycle.SourceOutboxErrorCodes.Unavailable,
      message: "outbox unavailable",
      sourceEventId: report.sourceEventId,
      retryable: true
    }
    const failure: NativeLifecycle.LifecyclePublicationFailure = {
      _tag: "LifecyclePublicationFailed",
      failureVersion: NativeLifecycle.PublicationFailureVersion,
      report,
      error: applicationError
    }

    const exact = NativeLifecycle.validateLifecyclePublicationFailure(
      report,
      failure
    )
    assert(Result.isSuccess(exact))
    assert.deepStrictEqual(exact.success, failure)

    const drift = NativeLifecycle.validateLifecyclePublicationFailure(
      {
        ...report,
        encodedOutput: {
          _tag: "Inline",
          value: { accepted: false }
        }
      },
      failure
    )
    assert(Result.isFailure(drift))
    assert.strictEqual(
      drift.failure.code,
      NativeLifecycle.ErrorCodes.PublicationFailureDrift
    )

    const excess = NativeLifecycle.validateLifecyclePublicationFailure(
      report,
      {
        ...failure,
        forged: true
      }
    )
    assert(Result.isFailure(excess))
    assert.strictEqual(
      excess.failure.code,
      NativeLifecycle.ErrorCodes.InvalidPublicationFailure
    )

    const mismatchedError = NativeLifecycle
      .validateLifecyclePublicationFailure(
        report,
        {
          ...failure,
          error: {
            ...applicationError,
            sourceEventId: "different-source-event"
          }
        }
      )
    assert(Result.isFailure(mismatchedError))
    assert.strictEqual(
      mismatchedError.failure.code,
      NativeLifecycle.ErrorCodes.InvalidPublicationFailure
    )
  })

  it.effect("deduplicates first writes and returns the exact first receipt", () =>
    Effect.gen(function*() {
      const fixture = makeOutboxFixture()
      const report = startedReport()
      const first = yield* fixture.service.record(report)
      const replay = yield* fixture.service.record({
        ...report
      })

      assert.strictEqual(replay, first)
      assert.strictEqual(fixture.receipts.size, 1)
      assert.strictEqual(fixture.reports.length, 2)
    }))

  it.effect("rejects reuse of one source identity with different content", () =>
    Effect.gen(function*() {
      const fixture = makeOutboxFixture()
      const report = startedReport()
      yield* fixture.service.record(report)

      const conflict = yield* fixture.service.record({
        ...report,
        artifactDigest: digest("f")
      }).pipe(Effect.flip)

      assert.strictEqual(
        conflict.code,
        NativeLifecycle.SourceOutboxErrorCodes.Conflict
      )
      assert.isFalse(conflict.retryable)
      assert.strictEqual(conflict.sourceEventId, report.sourceEventId)
      assert.strictEqual(fixture.receipts.size, 1)
    }))

  it.effect("never retries a typed outbox failure through the interruption policy", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(6)
      const binding = success(Backend.prepare(verified))
      let attempts = 0
      const outbox: NativeLifecycle.ChildLifecycleSourceOutbox["Service"] = {
        record: (report) => {
          attempts++
          return Effect.fail(
            new NativeLifecycle.ChildLifecycleSourceOutboxError({
              code: NativeLifecycle.SourceOutboxErrorCodes.Unavailable,
              message: "outbox unavailable",
              sourceEventId: report.sourceEventId,
              retryable: true
            })
          )
        }
      }
      const registration = success(
        NativeLifecycle.toLayer(
          binding,
          () => Effect.succeed(completed(binding)),
          { interruptRetryPolicy: permissiveInterruptRetry }
        )
      )

      const exit = yield* Backend.execute(
        binding,
        invocation("typed-outbox-failure-run")
      ).pipe(
        Effect.provide(runtimeLayer(registration, outbox)),
        Effect.exit
      )

      assert(Exit.isFailure(exit))
      assert.isTrue(Cause.hasDies(exit.cause))
      const defect = Cause.squash(exit.cause)
      assert.instanceOf(
        defect,
        NativeLifecycle.ChildLifecycleSourceOutboxError
      )
      if (
        defect instanceof
          NativeLifecycle.ChildLifecycleSourceOutboxError
      ) {
        assert.strictEqual(
          defect.code,
          NativeLifecycle.SourceOutboxErrorCodes.Unavailable
        )
      }
      assert.strictEqual(attempts, 1)
    }).pipe(provideCrypto))

  it.effect("publishes Started before handler construction, then Succeeded, and replays natively", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const timeline: Array<string> = []
      const outbox = makeOutboxFixture(timeline)
      let handlerRuns = 0
      const registration = success(
        NativeLifecycle.toLayer(
          binding,
          () => {
            timeline.push("handler:constructed")
            return Effect.sync(() => {
              handlerRuns++
              timeline.push("handler:executed")
              return completed(binding)
            })
          },
          { interruptRetryPolicy: noInterruptRetry }
        )
      )

      yield* Effect.gen(function*() {
        const first = yield* Backend.execute(binding, invocation())
        const replay = yield* Backend.execute(binding, invocation())

        assert.deepStrictEqual(first, completed(binding))
        assert.deepStrictEqual(replay, first)
      }).pipe(
        Effect.provide(runtimeLayer(registration, outbox.service))
      )

      assert.deepStrictEqual(timeline, [
        "outbox:ChildStartAccepted",
        "handler:constructed",
        "handler:executed",
        "outbox:ChildSucceeded"
      ])
      assert.strictEqual(handlerRuns, 1)
      assert.deepStrictEqual(
        outbox.reports.map((report) => report._tag),
        ["ChildStartAccepted", "ChildSucceeded"]
      )
      assert.strictEqual(outbox.receipts.size, 2)
    }).pipe(provideCrypto))

  it.effect("publishes a typed RunFailure as the complete ChildFailed envelope", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(2)
      const binding = success(Backend.prepare(verified))
      const outbox = makeOutboxFixture()
      const expected = runFailure("PolicyFailure")
      const registration = success(
        NativeLifecycle.toLayer(
          binding,
          () => Effect.fail(expected),
          { interruptRetryPolicy: noInterruptRetry }
        )
      )

      const failure = yield* Backend.execute(
        binding,
        invocation("typed-failure-run")
      ).pipe(
        Effect.provide(runtimeLayer(registration, outbox.service)),
        Effect.flip
      )

      assert.deepStrictEqual(failure, expected)
      assert.deepStrictEqual(
        outbox.reports.map((report) => report._tag),
        ["ChildStartAccepted", "ChildFailed"]
      )
      const terminal = outbox.reports[1]
      assert.strictEqual(terminal?._tag, "ChildFailed")
      if (terminal?._tag === "ChildFailed") {
        assert.deepStrictEqual(terminal.failure, expected)
      }
      const terminalReceipt = Array.from(outbox.receipts.values())[1]
      assert.strictEqual(terminalReceipt?.fact._tag, "ChildFailed")
      if (terminalReceipt?.fact._tag === "ChildFailed") {
        assert.deepStrictEqual(terminalReceipt.fact.failure, {
          _tag: "Inline",
          value: expected
        })
      }
    }).pipe(provideCrypto))

  it.effect("closes an invalid success to AdapterInvariant and publishes ChildFailed", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(3)
      const binding = success(Backend.prepare(verified))
      const outbox = makeOutboxFixture()
      const registration = success(
        NativeLifecycle.toLayer(
          binding,
          () =>
            Effect.succeed({
              ...completed(binding),
              outputContractDigest: digest("f")
            }),
          { interruptRetryPolicy: noInterruptRetry }
        )
      )

      const failure = yield* Backend.execute(
        binding,
        invocation("invalid-success-run")
      ).pipe(
        Effect.provide(runtimeLayer(registration, outbox.service)),
        Effect.flip
      )

      assert.strictEqual(failure._tag, "Failed")
      assert.strictEqual(failure.failureKind, "AdapterInvariant")
      assert.deepStrictEqual(failure.failure, {
        _tag: "Inline",
        value: {
          code: "OutputContractMismatch",
          message: "Semantic handler output contract does not match the prepared artifact"
        }
      })
      assert.deepStrictEqual(
        outbox.reports.map((report) => report._tag),
        ["ChildStartAccepted", "ChildFailed"]
      )
      const terminal = outbox.reports[1]
      assert.strictEqual(terminal?._tag, "ChildFailed")
      if (terminal?._tag === "ChildFailed") {
        assert.deepStrictEqual(terminal.failure, failure)
      }
    }).pipe(provideCrypto))

  it.effect("does not manufacture a terminal or cancellation fact from a defect", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(4)
      const binding = success(Backend.prepare(verified))
      const outbox = makeOutboxFixture()
      const registration = success(
        NativeLifecycle.toLayer(
          binding,
          () => Effect.die("child handler defect"),
          { interruptRetryPolicy: noInterruptRetry }
        )
      )

      const exit = yield* Backend.execute(
        binding,
        invocation("defect-run")
      ).pipe(
        Effect.provide(runtimeLayer(registration, outbox.service)),
        Effect.exit
      )

      assert(Exit.isFailure(exit))
      assert.isTrue(Cause.hasDies(exit.cause))
      assert.deepStrictEqual(
        outbox.reports.map((report) => report._tag),
        ["ChildStartAccepted"]
      )
      assert.isFalse(
        outbox.reports.some((report) =>
          report._tag === "ChildSucceeded" ||
          report._tag === "ChildFailed"
        )
      )
    }).pipe(provideCrypto))

  it.effect("does not manufacture a terminal or cancellation fact from interruption", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(7)
      const binding = success(Backend.prepare(verified))
      const outbox = makeOutboxFixture()
      const registration = success(
        NativeLifecycle.toLayer(
          binding,
          () => Effect.interrupt,
          { interruptRetryPolicy: noInterruptRetry }
        )
      )

      const exit = yield* Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Backend.execute(
          binding,
          invocation("interrupted-run")
        ))
        return yield* Fiber.await(fiber)
      }).pipe(
        Effect.provide(runtimeLayer(registration, outbox.service))
      )

      assert(Exit.isFailure(exit))
      assert.isTrue(Cause.hasInterrupts(exit.cause))
      assert.deepStrictEqual(
        outbox.reports.map((report) => report._tag),
        ["ChildStartAccepted"]
      )
    }).pipe(provideCrypto))

  it.effect("checks the exact binding before classifying a terminal success", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(8)
      const binding = success(Backend.prepare(verified))
      const outbox = makeOutboxFixture()
      let observedCode: NativeLifecycle.ErrorCode | undefined
      const registration = success(
        Backend.toLayer(
          binding,
          (execution) =>
            NativeLifecycle.publishSucceeded(
              { ...binding },
              execution,
              completed(binding),
              { interruptRetryPolicy: noInterruptRetry }
            ).pipe(
              Effect.match({
                onFailure: (failure) => {
                  observedCode = failure.code
                  return completed(binding)
                },
                onSuccess: () => completed(binding)
              })
            )
        )
      )

      const result = yield* Backend.execute(
        binding,
        invocation("binding-precedence-run")
      ).pipe(
        Effect.provide(runtimeLayer(registration, outbox.service))
      )

      assert.deepStrictEqual(result, completed(binding))
      assert.strictEqual(
        observedCode,
        NativeLifecycle.ErrorCodes.InvalidBinding
      )
      assert.isEmpty(outbox.reports)
    }).pipe(provideCrypto))

  it.effect("rejects structural binding copies and hostile reports without throwing", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified(5)
      const binding = success(Backend.prepare(verified))
      const copied = NativeLifecycle.toLayer(
        { ...binding },
        () => Effect.succeed(completed(binding)),
        { interruptRetryPolicy: noInterruptRetry }
      )
      assert(Result.isFailure(copied))
      assert.strictEqual(
        copied.failure.code,
        Backend.ErrorCodes.UnpreparedBinding
      )

      const hostile = new Proxy({}, {
        ownKeys: () => {
          throw new Error("hostile report")
        }
      })
      const rejected = NativeLifecycle.validateSourceReport(hostile)
      assert(Result.isFailure(rejected))
      assert.strictEqual(
        rejected.failure.code,
        NativeLifecycle.ErrorCodes.InvalidReport
      )
    }).pipe(provideCrypto))
})
