import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeActivity from "effect/unstable/workflow/Activity"
import * as NativeClock from "effect/unstable/workflow/DurableClock"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as Backend from "../src/EffectWorkflowBackendV3.ts"
import * as NativeOperation from "../src/EffectWorkflowOperationV3.ts"
import * as NativeSemantic from "../src/EffectWorkflowSemanticV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Registry from "../src/Registry.ts"
import * as SemanticOccurrence from "../src/SemanticOccurrenceV3.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const occurrenceDigest = (
  character: string
): NativeOperation.Coordinates["occurrenceDigest"] =>
  digest(character) as NativeOperation.Coordinates["occurrenceDigest"]

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const nativeStep = Node.make("NativeStep", {
  version: "1.0.0"
})

const definition = Workflow.make("native-host-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(nativeStep),
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 4,
    maxEdges: 4,
    maxFanIn: 4,
    maxFanOut: 4,
    maxDepth: 4
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

const codecPin = (
  codecId: string,
  schema: Schema.Json
) =>
  Effect.gen(function*() {
    const codecVersion = "1.0.0"
    const key = PlanStoreV3.codecKey(codecId, codecVersion)
    const build = yield* buildPin(
      "Codec",
      codecId,
      codecVersion,
      `codec:${codecId}:${codecVersion}`
    )
    const encodedSchema: PlanStoreV3.EncodedSchemaDocument = {
      encodedSchemaVersion: 3,
      codecKey: key,
      codecId,
      codecVersion,
      format: "effect-schema-json/v1",
      schema
    }
    return {
      codecPinVersion: 3,
      key,
      codecId,
      codecVersion,
      build,
      encodedSchema,
      schemaDigest: yield* DigestV3.encodedSchema(encodedSchema)
    } satisfies PlanStoreV3.CodecPin
  })

const makeVerified = (revision = 1) =>
  Effect.gen(function*() {
    const plan = {
      formatVersion: 1 as const,
      id: "native-host-plan",
      revision,
      definition: {
        id: definition.id,
        version: definition.version
      },
      nodes: [{
        id: "native-step",
        type: nativeStep.type,
        version: nativeStep.version,
        config: {}
      }],
      edges: []
    }
    const compiled = yield* CompilerV2.compile(definition, plan)
    const compiledFingerprint = yield* DigestV3.compiledPlan(
      compiled.fingerprintDocument
    )
    const build = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "native-host-deployment"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      nativeStep.type,
      nativeStep.version,
      "native-step-deployment"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "native-classifier",
      "1.0.0",
      "native-classifier-deployment"
    )
    const codecs = yield* Effect.all([
      codecPin("native-config", {
        type: "object",
        additionalProperties: false
      }),
      codecPin("native-failure", { not: {} })
    ])
    const configCodecKey = PlanStoreV3.codecKey(
      "native-config",
      "1.0.0"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "native-failure",
      "1.0.0"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      nativeStep.type,
      nativeStep.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "native-classifier",
      "1.0.0"
    )
    const activityPolicy: ActivityPolicyV3.Policy = {
      policyVersion: 3,
      retry: {
        retryPolicyVersion: 3,
        maximumAttempts: 1,
        maximumElapsed: { _tag: "Unlimited" },
        classifier: {
          classifierPinVersion: 3,
          classifierId: "native-classifier",
          classifierVersion: "1.0.0",
          buildDigest: classifierBuild.buildDigest
        },
        failureIdentity: {
          _tag: "EffectTagged",
          identityContractVersion: 1,
          code: "OptionalString"
        },
        nonRetryableErrorTags: [],
        nonRetryableErrorCodes: [],
        backoff: {
          _tag: "Fixed",
          delayMillis: 1
        },
        jitter: { _tag: "NoJitter" }
      },
      timeouts: {
        scheduleToStart: { _tag: "Disabled" },
        startToClose: { _tag: "Disabled" },
        scheduleToClose: { _tag: "Disabled" }
      }
    }
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
      compiledFingerprint,
      workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(definition.id),
      definition: {
        id: definition.id,
        version: definition.version,
        build
      },
      inputBoundary: {
        document: inputDocument,
        digest: yield* DigestV3.boundaryContract(inputDocument)
      },
      outputBoundary: {
        document: outputDocument,
        digest: yield* DigestV3.boundaryContract(outputDocument)
      },
      nodeDefinitions: [{
        manifestVersion: 3,
        key: nodeDefinitionKey,
        nodeType: nativeStep.type,
        nodeVersion: nativeStep.version,
        configCodecKey,
        failureCodecKey,
        inputs: [],
        outputs: []
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "native-classifier",
        classifierVersion: "1.0.0",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "native-step",
        nodeType: nativeStep.type,
        nodeVersion: nativeStep.version,
        nodeDefinitionKey,
        queue: "native-activity-queue",
        handlerBuild,
        activityPolicy
      }]
    }
    return yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )
  })

const invocation = (value: unknown = { approved: true }) => ({
  tenantId: "tenant-1",
  runId: "run-1",
  requestId: "request-1",
  input: {
    _tag: "Inline",
    value
  }
})

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

const output = (
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

const operationName = (
  coordinates: NativeOperation.Coordinates
): string => success(NativeOperation.name(coordinates))

const pollUntilObserved = Effect.fnUntraced(function*(
  binding: Backend.PreparedBinding,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* Backend.poll(binding, executionId)
    if (Option.isSome(polled)) {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native workflow did not expose an observable state")
})

const pollUntilComplete = Effect.fnUntraced(function*(
  binding: Backend.PreparedBinding,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* Backend.poll(binding, executionId)
    if (Option.isSome(polled) && polled.value._tag === "Complete") {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native workflow did not complete after resumption")
})

describe("EffectWorkflowBackendV3", () => {
  it.effect("pins verified artifact identity and rejects structural provenance copies", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const differentVerified = yield* makeVerified(2)
      const first = success(Backend.prepare(verified))
      const same = success(Backend.prepare(verified))
      const different = success(
        Backend.prepare(differentVerified)
      )

      assert.strictEqual(
        first.workflowTag,
        `${Backend.WorkflowTagPrefix}${verified.artifactDigest}`
      )
      assert.strictEqual(same.workflowTag, first.workflowTag)
      assert.notStrictEqual(different.workflowTag, first.workflowTag)
      assert.isTrue(Backend.isPrepared(first))
      assert.isTrue(Object.isFrozen(first))
      assert.strictEqual(
        first.outputContractDigest,
        verified.artifact.outputBoundary.digest
      )

      const copiedArtifact = Backend.prepare({ ...verified })
      assert(Result.isFailure(copiedArtifact))
      assert.strictEqual(
        copiedArtifact.failure.code,
        Backend.ErrorCodes.UnverifiedArtifact
      )

      const copy = { ...first }
      assert.isFalse(Backend.isPrepared(copy))
      assert.isFalse(Backend.isPrepared(new Proxy(first, {})))
      const rejectedRequest = Backend.makeRequest(copy, invocation())
      assert(Result.isFailure(rejectedRequest))
      assert.strictEqual(
        rejectedRequest.failure.code,
        Backend.ErrorCodes.UnpreparedBinding
      )
      const rejectedLayer = Backend.toLayer(
        copy,
        () => Effect.succeed(output(first))
      )
      assert(Result.isFailure(rejectedLayer))
      assert.strictEqual(
        rejectedLayer.failure.code,
        Backend.ErrorCodes.UnpreparedBinding
      )
    }).pipe(provideCrypto))

  it.effect("constructs detached exact-pin requests and rejects substitution", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const request = success(Backend.makeRequest(
        binding,
        invocation({ nested: [-0] })
      ))

      assert.strictEqual(request.adapterVersion, Backend.AdapterVersion)
      assert.strictEqual(
        request.executionProtocolVersion,
        Backend.ExecutionProtocolVersion
      )
      assert.strictEqual(
        request.artifactDigest,
        binding.artifactDigest
      )
      assert.isTrue(Object.isFrozen(request))
      assert.isFalse(
        Object.is(
          request.input._tag === "Inline"
            ? (request.input.value as { nested: Array<number> }).nested[0]
            : undefined,
          -0
        )
      )

      const substituted = Backend.validateRequest(binding, {
        ...request,
        artifactDigest: digest("f")
      })
      assert(Result.isFailure(substituted))
      assert.strictEqual(
        substituted.failure.code,
        Backend.ErrorCodes.ArtifactMismatch
      )

      const excess = Backend.makeRequest(binding, {
        ...invocation(),
        forged: true
      })
      assert(Result.isFailure(excess))
      assert.strictEqual(
        excess.failure.code,
        Backend.ErrorCodes.InvalidInvocation
      )

      const initialId = yield* Backend.executionId(
        binding,
        invocation({ version: 1 })
      )
      const duplicateRunId = yield* Backend.executionId(binding, {
        ...invocation({ version: 2 }),
        requestId: "different-request"
      })
      const differentRunId = yield* Backend.executionId(binding, {
        ...invocation({ version: 1 }),
        runId: "run-2"
      })
      assert.strictEqual(duplicateRunId, initialId)
      assert.notStrictEqual(differentRunId, initialId)
    }).pipe(provideCrypto))

  it.effect("delegates execution, polling, interruption, and resumption to the native engine", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      let observedExecution: Backend.SemanticExecution | undefined
      const registration = success(Backend.toLayer(
        binding,
        (execution) => {
          observedExecution = execution
          const {
            artifact,
            nativeExecutionId,
            request,
            verifiedArtifact
          } = execution
          assert.isAbove(nativeExecutionId.length, 0)
          assert.strictEqual(
            request.artifactDigest,
            binding.artifactDigest
          )
          assert.strictEqual(verifiedArtifact, verified)
          assert.isTrue(PlanStoreV3.isVerifiedArtifact(verifiedArtifact))
          assert.strictEqual(verifiedArtifact.artifact, artifact)
          assert.strictEqual(artifact.definition.id, binding.definitionId)
          return Effect.succeed(output(binding, {
            echoed: request.input._tag === "Inline"
              ? request.input.value
              : null
          }))
        }
      ))

      yield* Effect.gen(function*() {
        const expectedExecutionId = yield* Backend.executionId(
          binding,
          invocation()
        )
        const startedExecutionId = yield* Backend.start(
          binding,
          invocation()
        )
        assert.strictEqual(startedExecutionId, expectedExecutionId)

        const completed = yield* Backend.execute(binding, invocation())
        assert.deepStrictEqual(
          completed,
          output(binding, {
            echoed: { approved: true }
          })
        )
        assert.isTrue(Backend.isSemanticExecution(observedExecution))
        assert.isTrue(Object.isFrozen(observedExecution))
        assert.isFalse(Backend.isSemanticExecution({
          ...observedExecution
        }))
        assert.isFalse(
          Backend.isSemanticExecution(
            new Proxy(observedExecution!, {})
          )
        )
        const preparedOccurrence = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 0
          }
        )
        assert.isTrue(SemanticOccurrence.isPrepared(preparedOccurrence))
        assert.deepStrictEqual(preparedOccurrence.document, {
          occurrenceVersion: SemanticOccurrence.OccurrenceVersion,
          executionProtocolVersion: SemanticOccurrence.ExecutionProtocolVersion,
          tenantId: "tenant-1",
          runId: "run-1",
          artifactDigest: binding.artifactDigest,
          nodeId: "native-step",
          scopePath: [],
          activation: 0
        })
        const replayedOccurrence = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 0
          }
        )
        assert.strictEqual(
          replayedOccurrence.occurrenceDigest,
          preparedOccurrence.occurrenceDigest
        )

        const copiedExecution = yield* NativeSemantic.staticDagOccurrence(
          { ...observedExecution! },
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 0
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          copiedExecution.code,
          NativeSemantic.ErrorCodes.InvalidSemanticExecution
        )
        const proxiedExecution = yield* NativeSemantic.staticDagOccurrence(
          new Proxy(observedExecution!, {}),
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 0
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          proxiedExecution.code,
          NativeSemantic.ErrorCodes.InvalidSemanticExecution
        )

        let executionReads = 0
        const hostileExecution = {
          get request() {
            executionReads++
            throw new Error("must not read forged execution")
          }
        } as unknown as Backend.SemanticExecution
        const forgedExecution = yield* NativeSemantic.staticDagOccurrence(
          hostileExecution,
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 0
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          forgedExecution.code,
          NativeSemantic.ErrorCodes.InvalidSemanticExecution
        )
        assert.strictEqual(executionReads, 0)

        const unknownNode = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "missing-step",
            scopePath: [],
            activation: 0
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          unknownNode.code,
          NativeSemantic.ErrorCodes.UnknownNode
        )

        const dynamicScopeOccurrence = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: [{
              scopeActivationVersion: 1,
              scopeId: "future-loop",
              activation: 0
            }],
            activation: 0
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          dynamicScopeOccurrence.code,
          NativeSemantic.ErrorCodes.UnsupportedOccurrence
        )
        const reenteredOccurrence = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 1
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          reenteredOccurrence.code,
          NativeSemantic.ErrorCodes.UnsupportedOccurrence
        )

        let coordinateReads = 0
        const hostileCoordinates = {
          get nodeId() {
            coordinateReads++
            return "native-step"
          },
          scopePath: [],
          activation: 0
        }
        const hostile = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          hostileCoordinates
        ).pipe(Effect.flip)
        assert.strictEqual(
          hostile.code,
          NativeSemantic.ErrorCodes.InvalidOccurrenceCoordinates
        )
        assert.strictEqual(coordinateReads, 0)
        const excess = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: [],
            activation: 0,
            tenantId: "forged-tenant"
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          excess.code,
          NativeSemantic.ErrorCodes.InvalidOccurrenceCoordinates
        )
        const negative = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: [],
            activation: -1
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          negative.code,
          NativeSemantic.ErrorCodes.InvalidOccurrenceCoordinates
        )
        const excessiveScopePath = yield* NativeSemantic.staticDagOccurrence(
          observedExecution!,
          {
            nodeId: "native-step",
            scopePath: Array.from(
              {
                length: SemanticOccurrence.MaximumScopeDepth + 1
              },
              (_, activation) => ({
                scopeActivationVersion: 1,
                scopeId: `scope-${activation}`,
                activation
              })
            ),
            activation: 0
          }
        ).pipe(Effect.flip)
        assert.strictEqual(
          excessiveScopePath.code,
          NativeSemantic.ErrorCodes.InvalidOccurrenceCoordinates
        )

        const polled = yield* Backend.poll(binding, startedExecutionId)
        assert(Option.isSome(polled))
        assert.strictEqual(polled.value._tag, "Complete")
        if (polled.value._tag === "Complete") {
          assert(Exit.isSuccess(polled.value.exit))
          assert.deepStrictEqual(polled.value.exit.value, completed)
        }

        yield* Backend.resume(binding, startedExecutionId)
        yield* Backend.interrupt(binding, startedExecutionId)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("turns handler contract substitution into a checked native failure", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const registration = success(Backend.toLayer(
        binding,
        () =>
          Effect.succeed({
            ...output(binding),
            outputContractDigest: digest("f") as Backend.RunSuccess[
              "outputContractDigest"
            ]
          })
      ))

      yield* Effect.gen(function*() {
        const failure = yield* Backend.execute(
          binding,
          invocation()
        ).pipe(Effect.flip)
        assert.strictEqual(failure._tag, "Failed")
        if (failure._tag === "Failed") {
          assert.strictEqual(failure.failureKind, "AdapterInvariant")
          assert.deepStrictEqual(failure.failure, {
            _tag: "Inline",
            value: {
              code: "OutputContractMismatch",
              message: "Semantic handler output contract does not match the prepared artifact"
            }
          })
        }
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("reuses native activities and deferred replay instead of implementing their storage", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const token = yield* Deferred.make<NativeDeferred.Token>()
      const firstName = operationName({
        _tag: "Activity",
        coordinateVersion: NativeOperation.CoordinateVersion,
        occurrenceDigest: occurrenceDigest("1"),
        operationId: "invoke-handler"
      })
      const waitName = operationName({
        _tag: "Deferred",
        coordinateVersion: NativeOperation.CoordinateVersion,
        occurrenceDigest: occurrenceDigest("2"),
        operationId: "external-result",
        generation: 0
      })
      const wait = NativeDeferred.make(waitName, {
        success: Schema.String
      })
      let executions = 0
      const registration = success(Backend.toLayer(
        binding,
        () =>
          Effect.gen(function*() {
            const first = yield* NativeActivity.make({
              name: firstName,
              success: Schema.Number,
              execute: Effect.sync(() => ++executions)
            }).pipe(
              Effect.provideService(NativeActivity.CurrentAttempt, 1)
            )
            const second = yield* NativeActivity.make({
              name: firstName,
              success: Schema.Number,
              execute: Effect.sync(() => ++executions)
            }).pipe(
              Effect.provideService(NativeActivity.CurrentAttempt, 2)
            )
            yield* Deferred.succeed(
              token,
              yield* NativeDeferred.token(wait)
            )
            const resumedWith = yield* NativeDeferred.await(wait)
            return output(binding, { first, resumedWith, second })
          })
      ))

      yield* Effect.gen(function*() {
        const executionId = yield* Backend.start(binding, invocation())
        const completionToken = yield* Deferred.await(token)
        const suspended = yield* pollUntilObserved(binding, executionId)
        assert.strictEqual(suspended._tag, "Suspended")
        assert.strictEqual(executions, 2)

        yield* NativeDeferred.succeed(wait, {
          token: completionToken,
          value: "approved"
        })
        const completed = yield* Backend.execute(binding, invocation())
        assert.deepStrictEqual(
          completed,
          output(binding, {
            first: 1,
            resumedWith: "approved",
            second: 2
          })
        )
        assert.strictEqual(executions, 2)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("forces business timers through the native durable-clock path", () =>
    Effect.gen(function*() {
      const verified = yield* makeVerified()
      const binding = success(Backend.prepare(verified))
      const timerName = operationName({
        _tag: "Timer",
        coordinateVersion: NativeOperation.CoordinateVersion,
        occurrenceDigest: occurrenceDigest("3"),
        operationId: "approval-timeout",
        generation: 0
      })
      const registration = success(Backend.toLayer(
        binding,
        () =>
          Effect.gen(function*() {
            yield* NativeClock.sleep({
              name: timerName,
              duration: Duration.seconds(10),
              inMemoryThreshold: Duration.zero
            })
            return output(binding, { timer: "fired" })
          })
      ))

      yield* Effect.gen(function*() {
        const executionId = yield* Backend.start(binding, invocation())
        const suspended = yield* pollUntilObserved(binding, executionId)
        assert.strictEqual(suspended._tag, "Suspended")

        yield* TestClock.adjust(Duration.seconds(10))
        const completed = yield* Backend.execute(binding, invocation())
        assert.deepStrictEqual(
          completed,
          output(binding, { timer: "fired" })
        )
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("uses ordinary native nested execution with the child call identity in its run id", () =>
    Effect.gen(function*() {
      const parentVerified = yield* makeVerified(1)
      const childVerified = yield* makeVerified(2)
      const parentBinding = success(Backend.prepare(parentVerified))
      const childBinding = success(Backend.prepare(childVerified))
      const token = yield* Deferred.make<NativeDeferred.Token>()
      const childWait = NativeDeferred.make(
        operationName({
          _tag: "Deferred",
          coordinateVersion: NativeOperation.CoordinateVersion,
          occurrenceDigest: occurrenceDigest("4"),
          operationId: "completion",
          generation: 0
        }),
        { success: Schema.String }
      )
      const callId = ChildWorkflowV3.childCallId(
        "tenant-1",
        "run-1",
        "child-call-node-1"
      )
      const childInvocation = {
        tenantId: "tenant-1",
        runId: ChildWorkflowV3.childRunId(
          "tenant-1",
          "run-1",
          callId
        ),
        requestId: ChildWorkflowV3.childStartRequestId(
          "tenant-1",
          "run-1",
          callId
        ),
        input: {
          _tag: "Inline" as const,
          value: { callId }
        }
      }
      const childRegistration = success(Backend.toLayer(
        childBinding,
        () =>
          Effect.gen(function*() {
            yield* Deferred.succeed(
              token,
              yield* NativeDeferred.token(childWait)
            )
            const value = yield* NativeDeferred.await(childWait)
            return output(childBinding, { value })
          })
      ))
      const parentRegistration = success(Backend.toLayer(
        parentBinding,
        () =>
          Effect.gen(function*() {
            const child = yield* Backend.execute(
              childBinding,
              childInvocation
            ).pipe(
              Effect.mapError((failure): Backend.RunFailure =>
                failure._tag === "Failed"
                  ? failure
                  : {
                    _tag: "Failed",
                    failureVersion: 1,
                    failureKind: "AdapterInvariant",
                    failure: {
                      _tag: "Inline",
                      value: {
                        code: failure.code,
                        message: failure.message
                      }
                    }
                  }
              )
            )
            return output(parentBinding, { child: child.output })
          })
      ))

      yield* Effect.gen(function*() {
        const parentExecutionId = yield* Backend.start(
          parentBinding,
          invocation()
        )
        const suspended = yield* pollUntilObserved(
          parentBinding,
          parentExecutionId
        )
        assert.strictEqual(suspended._tag, "Suspended")
        const completionToken = yield* Deferred.await(token)

        yield* NativeDeferred.succeed(childWait, {
          token: completionToken,
          value: "child-complete"
        })
        const terminal = yield* pollUntilComplete(
          parentBinding,
          parentExecutionId
        )
        assert(Exit.isSuccess(terminal.exit))
        const completed = yield* Backend.execute(
          parentBinding,
          invocation()
        )
        assert.deepStrictEqual(
          completed,
          output(parentBinding, {
            child: {
              _tag: "Inline",
              value: { value: "child-complete" }
            }
          })
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            parentRegistration,
            childRegistration
          ).pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))
})
