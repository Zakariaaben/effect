import { assert, describe, it } from "@effect/vitest"
import type * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { TestClock } from "effect/testing"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeDeferred from "effect/unstable/workflow/DurableDeferred"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as NativeName from "../src/EffectWorkflowOperationV3.ts"
import * as Retry from "../src/EffectWorkflowRetryV3.ts"
import * as NativeSemantic from "../src/EffectWorkflowSemanticV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import * as Wire from "../src/ProtocolV3Wire.ts"
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Workflow from "../src/Workflow.ts"

const digest = (
  character: string
): `sha256:${string}` => `sha256:${character.repeat(64)}`

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const configSchema = Schema.Struct({})
const BusinessFailureSchema = Schema.Struct({
  _tag: Schema.Literal("BusinessFailure"),
  code: Schema.String,
  message: Schema.String
})
const SemanticLookingFailureSchema = Schema.Struct({
  _tag: Schema.Literal("EffectWorkflowSemanticError"),
  code: Schema.String,
  message: Schema.String
})
const FailureWire = Schema.Union([
  BusinessFailureSchema,
  SemanticLookingFailureSchema
])
const failureEncodeCounts = new Map<string, number>()
const failureSchema = FailureWire.pipe(
  Schema.decodeTo(
    FailureWire,
    SchemaTransformation.transform({
      decode: (value) => value,
      encode: (value) => {
        failureEncodeCounts.set(
          value.code,
          (failureEncodeCounts.get(value.code) ?? 0) + 1
        )
        return value
      }
    })
  )
)
const outputSchema = Schema.Number

const retryNode = Node.make("retry-contract-node", {
  version: "1",
  config: configSchema,
  inputs: {},
  outputs: {
    value: Port.output(outputSchema, {
      contract: "effect-workflow-retry/number"
    })
  },
  failure: failureSchema
})

const nodeRegistry = Registry.make(retryNode)

const definition = Workflow.make("effect-workflow-retry-contract", {
  version: "1",
  inputs: {},
  outputs: {},
  nodes: nodeRegistry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({
    maxNodes: 2,
    maxEdges: 2,
    maxFanIn: 2,
    maxFanOut: 2,
    maxDepth: 2
  })
})

const plan = {
  formatVersion: 1 as const,
  id: "effect-workflow-retry-contract-plan",
  revision: 1,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "retry-step",
    type: retryNode.type,
    version: retryNode.version,
    config: {}
  }],
  edges: []
}

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
  encodedJsonSchema: Schema.Json
) =>
  Effect.gen(function*() {
    const codecVersion = "1"
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
      schema: encodedJsonSchema
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

const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

interface FixtureOptions {
  readonly scheduleToStart?: ActivityPolicyV3.Timeout
  readonly startToClose?: ActivityPolicyV3.Timeout
  readonly scheduleToClose?: ActivityPolicyV3.Timeout
  readonly handler?: Node.Handler<typeof retryNode>
  readonly classifier?: (
    failure: ActivityPolicyV3.RetryFailureCause
  ) => Effect.Effect<ActivityPolicyV3.RetryClassification>
  readonly maximumAttempts?: number
  readonly maximumElapsed?: ActivityPolicyV3.ElapsedBudget
  readonly delayMillis?: number
  readonly jitter?: ActivityPolicyV3.Jitter
  readonly nonRetryableErrorTags?: ReadonlyArray<string>
  readonly nonRetryableErrorCodes?: ReadonlyArray<string>
}

const policy = (
  classifierBuildDigest: Wire.BuildDigest,
  options: FixtureOptions
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: options.maximumAttempts ?? 3,
    maximumElapsed: options.maximumElapsed ?? { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "retry-contract-classifier",
      classifierVersion: "1",
      buildDigest: classifierBuildDigest
    },
    failureIdentity: {
      _tag: "EffectTagged",
      identityContractVersion: 1,
      code: "OptionalString"
    },
    nonRetryableErrorTags: options.nonRetryableErrorTags ?? [],
    nonRetryableErrorCodes: options.nonRetryableErrorCodes ?? [],
    backoff: {
      _tag: "Fixed",
      delayMillis: options.delayMillis ?? 0
    },
    jitter: options.jitter ?? { _tag: "NoJitter" }
  },
  timeouts: {
    scheduleToStart: options.scheduleToStart ?? { _tag: "Disabled" },
    startToClose: options.startToClose ?? { _tag: "Disabled" },
    scheduleToClose: options.scheduleToClose ?? { _tag: "Disabled" }
  }
})

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolved: Executables.ResolvedArtifactExecutables
}

const makeFixture = (
  options: FixtureOptions = {}
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "retry-contract-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      retryNode.type,
      retryNode.version,
      "retry-contract-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "retry-contract-classifier",
      "1",
      "retry-contract-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("retry-contract-config", {
        type: "object",
        additionalProperties: false
      }),
      codecPin("retry-contract-failure", {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["_tag", "code", "message"],
            properties: {
              _tag: { const: "BusinessFailure" },
              code: { type: "string" },
              message: { type: "string" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["_tag", "code", "message"],
            properties: {
              _tag: {
                const: "EffectWorkflowSemanticError"
              },
              code: { type: "string" },
              message: { type: "string" }
            }
          }
        ]
      }),
      codecPin("retry-contract-number", {
        type: "number"
      })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const configCodecKey = PlanStoreV3.codecKey(
      "retry-contract-config",
      "1"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "retry-contract-failure",
      "1"
    )
    const numberCodecKey = PlanStoreV3.codecKey(
      "retry-contract-number",
      "1"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      retryNode.type,
      retryNode.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "retry-contract-classifier",
      "1"
    )
    const inputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: []
    }
    const outputBoundaryDocument = {
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
      workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(definition.id),
      definition: {
        id: definition.id,
        version: definition.version,
        build: definitionBuild
      },
      inputBoundary: {
        document: inputBoundaryDocument,
        digest: yield* DigestV3.boundaryContract(
          inputBoundaryDocument
        )
      },
      outputBoundary: {
        document: outputBoundaryDocument,
        digest: yield* DigestV3.boundaryContract(
          outputBoundaryDocument
        )
      },
      nodeDefinitions: [{
        manifestVersion: 3,
        key: nodeDefinitionKey,
        nodeType: retryNode.type,
        nodeVersion: retryNode.version,
        configCodecKey,
        failureCodecKey,
        inputs: [],
        outputs: [{
          name: "value",
          contract: "effect-workflow-retry/number",
          fanOut: "multiple",
          codecKey: numberCodecKey
        }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "retry-contract-classifier",
        classifierVersion: "1",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "retry-step",
        nodeType: retryNode.type,
        nodeVersion: retryNode.version,
        nodeDefinitionKey,
        queue: "retry-contract-queue",
        handlerBuild,
        activityPolicy: policy(
          classifierBuild.buildDigest,
          options
        )
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const handlers = yield* nodeRegistry.toHandlers(
      nodeRegistry.of({
        "retry-contract-node@1": options.handler ?? (() => Effect.succeed({ value: 1 }))
      })
    )
    const deploymentCatalog = yield* Deployment.makeMemory({
      workflowDefinitions: [
        Deployment.workflowDefinition(
          definitionBuild.deploymentId,
          definition
        )
      ],
      handlerDefinitions: [
        Deployment.handlerDefinition(
          handlerBuild.deploymentId,
          retryNode
        )
      ]
    })
    const deployedHandlers = yield* DeploymentHandlers.make([
      DeploymentHandlers.handlerDeployment(
        handlerBuild.deploymentId,
        handlers
      )
    ]).pipe(
      Effect.provideService(
        Deployment.DeploymentCatalog,
        deploymentCatalog
      )
    )
    const workflowExecutable = yield* Executables.workflowDefinition(
      deploymentCatalog,
      definitionBuild
    )
    const nodeExecutable = expectSuccess(
      Executables.nodeHandler(deployedHandlers, handlerBuild)
    )
    const runtimeSchemas: Readonly<Record<string, Schema.Top>> = {
      "retry-contract-config": configSchema,
      "retry-contract-failure": failureSchema,
      "retry-contract-number": outputSchema
    }
    const codecExecutables = yield* Effect.forEach(
      codecs,
      (pin) => Executables.codec(pin, runtimeSchemas[pin.codecId]!)
    )
    const classifierExecutable = yield* Executables.retryClassifier(
      artifact.policyExecutableBuilds[0]!,
      options.classifier ?? (() =>
        Effect.succeed({
          _tag: "Retryable",
          classificationVersion: 1
        }))
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      nodeExecutable,
      ...codecExecutables,
      classifierExecutable
    ])
    const resolved = yield* registry.resolveArtifact(verified)
    return { verified, resolved } satisfies Fixture
  })

const occurrence = (
  fixture: Fixture,
  runId: string
) =>
  Occurrence.prepare({
    occurrenceVersion: Occurrence.OccurrenceVersion,
    executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
    tenantId: "tenant-retry-contract",
    runId,
    artifactDigest: fixture.verified.artifactDigest,
    nodeId: "retry-step",
    scopePath: [],
    activation: 0
  })

const applicationFailure = {
  _tag: "ApplicationFailure" as const,
  failureCauseVersion: 1 as const,
  activityDigest: digest("a") as Wire.OperationDigest,
  attempt: 1,
  identity: {
    failureIdentityVersion: 1 as const,
    errorTag: "BusinessFailure",
    errorCode: "TEMPORARY"
  },
  failure: {
    _tag: "Inline" as const,
    value: {
      _tag: "BusinessFailure",
      code: "TEMPORARY",
      message: "try again"
    }
  }
}

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const WorkflowOutput = Schema.Struct({
  value: Schema.Number
})

const WorkflowFailure = Schema.Union([
  Retry.TerminalFailure,
  Retry.EffectWorkflowRetryError,
  NativeSemantic.EffectWorkflowSemanticError
])

const RuntimeWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Runtime",
  {
    payload: { id: Schema.String },
    success: WorkflowOutput,
    error: WorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const ReplayWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Replay",
  {
    payload: { id: Schema.String },
    success: WorkflowOutput,
    error: WorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const DefectWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowRetryV3/Defect",
  {
    payload: { id: Schema.String },
    success: WorkflowOutput,
    error: WorkflowFailure,
    idempotencyKey: ({ id }) => id
  }
)

const retryExecution = (
  invocation: Retry.PreparedRetryInvocation
) =>
  Retry.execute(invocation, {
    interruptRetryPolicy: noInterruptRetry
  }) as Effect.Effect<
    Schema.Schema.Type<typeof WorkflowOutput>,
    | Retry.TerminalFailure
    | Retry.EffectWorkflowRetryError
    | NativeSemantic.EffectWorkflowSemanticError,
    Crypto.Crypto | NativeSemantic.Requirements
  >

const pollUntilObserved = Effect.fnUntraced(function*<
  W extends NativeWorkflow.AnyWithProps
>(
  workflow: W,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* workflow.poll(executionId)
    if (Option.isSome(polled)) return polled.value
    yield* Effect.yieldNow
  }
  return yield* Effect.die(
    "Native workflow did not expose observable state"
  )
})

const pollUntilComplete = Effect.fnUntraced(function*<
  W extends NativeWorkflow.AnyWithProps
>(
  workflow: W,
  executionId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = yield* workflow.poll(executionId)
    if (
      Option.isSome(polled) &&
      polled.value._tag === "Complete"
    ) {
      return polled.value
    }
    yield* Effect.yieldNow
  }
  return yield* Effect.die("Native workflow did not complete")
})

const failReason = (
  exit: Exit.Exit<unknown, unknown>
): unknown => {
  assert(Exit.isFailure(exit))
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons.find(
    (candidate) => candidate._tag === "Fail"
  )
  assert.isDefined(reason)
  return reason?._tag === "Fail" ? reason.error : undefined
}

const businessFailure = (
  code: string,
  message = "business failure"
) => ({
  _tag: "BusinessFailure" as const,
  code,
  message
})

describe("EffectWorkflowRetryV3 contracts", () => {
  it("admits only the closed persisted node-attempt outcomes", () => {
    const succeeded = Schema.decodeUnknownSync(
      Retry.NodeAttemptOutcome
    )({
      _tag: "Succeeded",
      outcomeVersion: 1,
      attempt: 2,
      activityDigest: digest("b"),
      output: {
        _tag: "Inline",
        value: { value: 42 }
      }
    })
    assert.strictEqual(succeeded._tag, "Succeeded")

    const failed = Schema.decodeUnknownSync(
      Retry.NodeAttemptOutcome
    )({
      _tag: "ApplicationFailed",
      outcomeVersion: 1,
      attempt: 1,
      activityDigest: digest("a"),
      failure: applicationFailure
    })
    assert.strictEqual(failed._tag, "ApplicationFailed")
    if (failed._tag === "ApplicationFailed") {
      assert.deepStrictEqual(
        failed.failure.identity,
        applicationFailure.identity
      )
    }

    assert.throws(() =>
      Schema.decodeUnknownSync(Retry.NodeAttemptOutcome)({
        _tag: "ApplicationFailed",
        outcomeVersion: 1,
        attempt: 1,
        activityDigest: digest("a"),
        failure: applicationFailure,
        decodedBusinessFailure: {
          _tag: "BusinessFailure"
        }
      })
    )

    assert.throws(() =>
      Schema.decodeUnknownSync(Retry.NodeAttemptOutcome)({
        _tag: "ApplicationFailed",
        outcomeVersion: 1,
        attempt: 2,
        activityDigest: digest("b"),
        failure: applicationFailure
      })
    )
  })

  it("admits inspectable NonRetryable and Exhausted terminal explanations", () => {
    const nonRetryable = Schema.decodeUnknownSync(
      Retry.TerminalFailure
    )({
      _tag: "NonRetryable",
      terminalVersion: 1,
      cause: applicationFailure,
      initialObservedAt: "2026-01-02T03:04:05.006Z",
      failedObservedAt: "2026-01-02T03:04:05.106Z",
      elapsedMillis: 100,
      decision: {
        _tag: "PolicyOverride",
        decisionVersion: 1,
        matchedBy: "ErrorCode"
      }
    })
    assert.strictEqual(nonRetryable._tag, "NonRetryable")

    const exhausted = Schema.decodeUnknownSync(
      Retry.TerminalFailure
    )({
      _tag: "Exhausted",
      terminalVersion: 1,
      cause: applicationFailure,
      initialObservedAt: "2026-01-02T03:04:05.006Z",
      failedObservedAt: "2026-01-02T03:04:05.106Z",
      elapsedMillis: 100,
      classificationActivityDigest: digest("c"),
      reason: "AttemptLimitReached"
    })
    assert.strictEqual(exhausted._tag, "Exhausted")
  })

  it.effect("prepares only exact process-local inline invocations", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const preparedOccurrence = yield* occurrence(
        fixture,
        "prepared-inline"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: {
          _tag: "Inline",
          value: {}
        }
      })
      assert.isTrue(Retry.isPrepared(invocation))
      assert.isTrue(Object.isFrozen(invocation))
      assert.isFalse(Retry.isPrepared({ ...invocation }))
      assert.deepStrictEqual(invocation, {
        invocationVersion: 1,
        artifactDigest: fixture.verified.artifactDigest,
        occurrenceDigest: preparedOccurrence.occurrenceDigest,
        nodeId: "retry-step",
        firstActivityDigest: invocation.firstActivityDigest
      })
      assert.match(
        invocation.firstActivityDigest,
        /^sha256:[0-9a-f]{64}$/
      )

      let getterReads = 0
      const accessorOptions: Record<string, unknown> = {}
      Object.defineProperties(accessorOptions, {
        artifact: {
          enumerable: true,
          get() {
            getterReads++
            return fixture.resolved
          }
        },
        occurrence: {
          enumerable: true,
          value: preparedOccurrence
        },
        input: {
          enumerable: true,
          value: { _tag: "Inline", value: {} }
        }
      })
      const accessorFailure = yield* Retry.prepare(
        accessorOptions as unknown as Retry.PrepareOptions
      ).pipe(Effect.flip)
      assert.strictEqual(
        accessorFailure.code,
        Retry.ErrorCodes.InvalidInvocation
      )
      assert.strictEqual(getterReads, 0)

      let proxyReads = 0
      const proxiedOptions = new Proxy({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline" as const, value: {} }
      }, {
        get(target, property, receiver) {
          proxyReads++
          return Reflect.get(target, property, receiver)
        }
      })
      const proxied = yield* Retry.prepare(proxiedOptions)
      assert.isTrue(Retry.isPrepared(proxied))
      assert.strictEqual(proxyReads, 0)

      const copiedOccurrence = {
        ...preparedOccurrence
      } as Occurrence.PreparedOccurrence
      const copiedFailure = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: copiedOccurrence,
        input: {
          _tag: "Inline",
          value: {}
        }
      }).pipe(Effect.flip)
      assert.strictEqual(
        copiedFailure.code,
        Retry.ErrorCodes.InvalidInvocation
      )

      const blobFailure = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: {
          _tag: "Blob",
          ref: {
            blobVersion: 1,
            digest: digest("d") as Wire.BlobDigest,
            encodedBytes: 10,
            mediaType: "application/json"
          }
        }
      }).pipe(Effect.flip)
      assert.strictEqual(
        blobFailure.code,
        Retry.ErrorCodes.UnsupportedBlobPayload
      )
    }).pipe(provideCrypto))

  it.effect("rejects unsupported schedule-to-start and start-to-close dimensions", () =>
    Effect.gen(function*() {
      for (
        const testCase of [
          {
            id: "unsupported-schedule-to-start",
            dimension: "scheduleToStart",
            options: {
              scheduleToStart: {
                _tag: "After",
                durationMillis: 1_000
              }
            }
          },
          {
            id: "unsupported-start-to-close",
            dimension: "startToClose",
            options: {
              startToClose: {
                _tag: "After",
                durationMillis: 1_000
              }
            }
          }
        ] as const
      ) {
        const fixture = yield* makeFixture(testCase.options)
        const preparedOccurrence = yield* occurrence(
          fixture,
          testCase.id
        )
        const failure = yield* Retry.prepare({
          artifact: fixture.resolved,
          occurrence: preparedOccurrence,
          input: {
            _tag: "Inline",
            value: {}
          }
        }).pipe(Effect.flip)
        assert.strictEqual(
          failure.code,
          Retry.ErrorCodes.UnsupportedTimeoutPolicy
        )
        assert.include(failure.message, testCase.dimension)
      }
    }).pipe(provideCrypto))

  it.effect("prepares a content-addressed schedule-to-close controller", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        scheduleToClose: {
          _tag: "After",
          durationMillis: 250
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-controller"
      )
      const first = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: { request: 1 } }
      })
      const replay = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: { request: 1 } }
      })
      const changedInput = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: { request: 2 } }
      })

      assert.match(
        first.scheduleToCloseControllerDigest ?? "",
        /^sha256:[0-9a-f]{64}$/
      )
      assert.strictEqual(
        first.scheduleToCloseControllerDigest,
        replay.scheduleToCloseControllerDigest
      )
      assert.notStrictEqual(
        first.scheduleToCloseControllerDigest,
        changedInput.scheduleToCloseControllerDigest
      )
    }).pipe(provideCrypto))
})

describe("EffectWorkflowRetryV3 managed runtime", () => {
  it.effect("completes the managed loop before an armed schedule-to-close deadline", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) =>
          Effect.sync(() => {
            attempts.push(request.context.attempt)
            return { value: 7 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-completes"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-completes" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, { value: 7 })
        }
        assert.deepStrictEqual(attempts, [1])
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("does not dispatch an attempt when the armed deadline is already due", () =>
    Effect.gen(function*() {
      const clockArmed = yield* Deferred.make<void>()
      const releaseClockAcknowledgement = yield* Deferred.make<void>()
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 31 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-already-due"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))
      const delayedEngine = Layer.effect(
        WorkflowEngine.WorkflowEngine
      )(
        Effect.map(
          WorkflowEngine.WorkflowEngine,
          (delegate) => {
            let wrapped: typeof delegate
            wrapped = {
              ...delegate,
              register: ((workflow, execute) =>
                delegate.register(
                  workflow,
                  (payload, executionId) =>
                    execute(payload, executionId).pipe(
                      Effect.provideService(
                        WorkflowEngine.WorkflowEngine,
                        wrapped
                      )
                    )
                )) as typeof delegate.register,
              scheduleClock: (workflow, options) =>
                Effect.gen(function*() {
                  // Delegate first: the native backend has durably armed the
                  // deadline before this acknowledgement is held back.
                  yield* delegate.scheduleClock(workflow, options)
                  yield* Deferred.succeed(clockArmed, undefined)
                  yield* Deferred.await(releaseClockAcknowledgement)
                })
            }
            return wrapped
          }
        )
      ).pipe(
        Layer.provide(WorkflowEngine.layerMemory)
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-already-due" },
          { discard: true }
        )
        yield* Deferred.await(clockArmed)

        // The backend clock is armed, but scheduleClock has not yet returned
        // to the retry controller, so no observation or attempt can start.
        yield* TestClock.adjust(100)
        yield* Deferred.succeed(releaseClockAcknowledgement, undefined)
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(delayedEngine)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns and replays timeout without joining an uninterruptible active attempt", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      let handlerRuns = 0
      let workflowPasses = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.uninterruptible(
            Effect.gen(function*() {
              handlerRuns++
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(blocked)
              return { value: 99 }
            })
          )) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-active-attempt"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowRetryV3/UninterruptibleTimeoutReplayGate"
      )
      const gateToken = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ReplayWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const result = yield* Effect.exit(
            retryExecution(invocation)
          )
          yield* Deferred.succeed(
            gateToken,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return yield* result
        })
      )

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* ReplayWorkflow.execute(
          { id: "schedule-to-close-active-attempt" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(99)
        const beforeDeadline = yield* ReplayWorkflow.poll(executionId)
        assert.isTrue(
          Option.isNone(beforeDeadline) ||
            beforeDeadline.value._tag === "Suspended"
        )
        yield* TestClock.adjust(1)
        const token = yield* Deferred.await(gateToken)

        // Reaching the gate proves Retry.execute already returned timeout even
        // though the uninterruptible handler is still physically blocked.
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(workflowPasses, 1)
        const beforeUnblock = yield* ReplayWorkflow.poll(executionId)
        assert.isTrue(
          Option.isNone(beforeUnblock) ||
            beforeUnblock.value._tag === "Suspended"
        )

        yield* Deferred.succeed(blocked, undefined)
        const suspended = yield* pollUntilObserved(
          ReplayWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")
        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ReplayWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        const timedOut = failure as Retry.ScheduleToCloseTimedOut
        assert.strictEqual(timedOut.timeoutKind, "ScheduleToClose")
        assert.strictEqual(timedOut.durationMillis, 100)
        assert.strictEqual(
          timedOut.controllerOperationDigest,
          invocation.scheduleToCloseControllerDigest
        )
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(workflowPasses, 2)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("publishes timeout when a handler finishes after the durable deadline", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.gen(function*() {
            handlerRuns++
            yield* Deferred.succeed(started, undefined)
            yield* Effect.sleep(101)
            return { value: 101 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-late-success"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-late-success" },
          { discard: true }
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(101)
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.strictEqual(handlerRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("lets schedule-to-close win during durable retry backoff", () =>
    Effect.gen(function*() {
      const classified = yield* Deferred.make<void>()
      const attempts: Array<number> = []
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) =>
          Effect.sync(() => {
            attempts.push(request.context.attempt)
            return businessFailure("BACKOFF_TIMEOUT")
          }).pipe(Effect.flip)) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Deferred.succeed(classified, undefined).pipe(
            Effect.as({
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            })
          ),
        maximumAttempts: 3,
        delayMillis: 200,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 100
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-backoff"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "schedule-to-close-backoff" },
          { discard: true }
        )
        yield* Deferred.await(classified)
        yield* TestClock.adjust(100)
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "ScheduleToCloseTimedOut"
        )
        assert.deepStrictEqual(attempts, [1])
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("replays a persisted completion winner without rerunning the handler", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let workflowPasses = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 17 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 1_000
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-winner-replay"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowRetryV3/ScheduleToCloseReplayGate"
      )
      const gateToken = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ReplayWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const output = yield* retryExecution(invocation)
          yield* Deferred.succeed(
            gateToken,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return output
        })
      )

      yield* Effect.gen(function*() {
        const executionId = yield* ReplayWorkflow.execute(
          { id: "schedule-to-close-winner-replay" },
          { discard: true }
        )
        const token = yield* Deferred.await(gateToken)
        const suspended = yield* pollUntilObserved(
          ReplayWorkflow,
          executionId
        )
        assert.strictEqual(suspended._tag, "Suspended")
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(workflowPasses, 1)

        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ReplayWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, {
            value: 17
          })
        }
        assert.strictEqual(workflowPasses, 2)
        assert.strictEqual(handlerRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("defects on a persisted winner whose internal attempt coordinates are corrupt", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return { value: 23 }
          })) as Node.Handler<typeof retryNode>,
        scheduleToClose: {
          _tag: "After",
          durationMillis: 1_000
        }
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "schedule-to-close-corrupt-winner"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DefectWorkflow.toLayer(() => retryExecution(invocation))
      const operationName = expectSuccess(NativeName.name({
        _tag: "RetryScheduleToClose",
        coordinateVersion: NativeName.CoordinateVersion,
        occurrenceDigest: preparedOccurrence.occurrenceDigest,
        operationId: "workflow-builder.retry.schedule-to-close",
        generation: 0
      }))
      const durableWinner = NativeDeferred.make(
        `raceAll/${operationName}`,
        {
          success: Retry.RetryScheduleToCloseWinner,
          error: Schema.Never
        }
      )

      yield* Effect.gen(function*() {
        const payload = {
          id: "schedule-to-close-corrupt-winner"
        }
        const executionId = yield* DefectWorkflow.executionId(payload)
        const token = new NativeDeferred.TokenParsed({
          workflowName: DefectWorkflow._tag,
          executionId,
          deferredName: durableWinner.name
        }).asToken
        yield* NativeDeferred.succeed(durableWinner, {
          token,
          value: {
            _tag: "RetryScheduleToCloseWinner",
            outcomeEnvelopeVersion: 1,
            controllerOperationDigest: invocation.scheduleToCloseControllerDigest!,
            exit: Exit.succeed({
              _tag: "Succeeded",
              outcomeVersion: 1,
              attempt: 1,
              activityDigest: digest("f") as Wire.OperationDigest,
              output: {
                _tag: "Inline",
                value: { value: 999 }
              }
            })
          }
        })

        yield* DefectWorkflow.execute(payload, { discard: true })
        const terminal = yield* pollUntilComplete(
          DefectWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          const died = terminal.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          assert.isDefined(died)
          if (died?._tag === "Die") {
            assert.strictEqual(
              (died.defect as { readonly _tag?: unknown })._tag,
              "EffectWorkflowRetryError"
            )
            assert.strictEqual(
              (died.defect as { readonly code?: unknown }).code,
              Retry.ErrorCodes.OperationPreparationFailed
            )
          }
        }
        assert.strictEqual(handlerRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("retries through internal jitter and a durable timer without rerunning the handler, classifier, or failure encoder on replay", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const classified: Array<ActivityPolicyV3.RetryFailureCause> = []
      let randomRuns = 0
      let workflowPasses = 0
      const fixture = yield* makeFixture({
        handler: ((
          request: Node.HandlerRequest<typeof retryNode>
        ) => {
          attempts.push(request.context.attempt)
          return request.context.attempt === 1
            ? Effect.fail(
              businessFailure("REPLAY_TEMPORARY")
            )
            : Effect.succeed({ value: 42 })
        }) as Node.Handler<typeof retryNode>,
        classifier: (failure) =>
          Effect.sync(() => {
            classified.push(failure)
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 3,
        delayMillis: 100,
        jitter: {
          _tag: "RecordedRange",
          minimumPermille: 500,
          maximumPermille: 1_500
        }
      })
      failureEncodeCounts.clear()
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-replay"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const gate = NativeDeferred.make(
        "WorkflowBuilder/EffectWorkflowRetryV3/ReplayGate"
      )
      const gateToken = yield* Deferred.make<NativeDeferred.Token>()
      const registration = ReplayWorkflow.toLayer(() =>
        Effect.gen(function*() {
          workflowPasses++
          const output = yield* retryExecution(invocation)
          yield* Deferred.succeed(
            gateToken,
            yield* NativeDeferred.token(gate)
          )
          yield* NativeDeferred.await(gate)
          return output
        })
      )
      const random = {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => {
          randomRuns++
          return 0
        }
      }

      yield* Effect.gen(function*() {
        yield* TestClock.setTime(
          Date.parse("2026-01-02T03:04:05.006Z")
        )
        const executionId = yield* ReplayWorkflow.execute(
          { id: "managed-replay" },
          { discard: true }
        )
        const timerState = yield* pollUntilObserved(
          ReplayWorkflow,
          executionId
        )
        assert.strictEqual(timerState._tag, "Suspended")
        assert.deepStrictEqual(attempts, [1])
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(randomRuns, 1)
        assert.strictEqual(
          failureEncodeCounts.get("REPLAY_TEMPORARY"),
          1
        )
        const classifiedFailure = classified[0]
        assert.strictEqual(
          classifiedFailure?._tag,
          "ApplicationFailure"
        )
        if (
          classifiedFailure?._tag === "ApplicationFailure"
        ) {
          assert.deepStrictEqual(classifiedFailure.identity, {
            failureIdentityVersion: 1,
            errorTag: "BusinessFailure",
            errorCode: "REPLAY_TEMPORARY"
          })
          assert.deepStrictEqual(classifiedFailure.failure, {
            _tag: "Inline",
            value: businessFailure("REPLAY_TEMPORARY")
          })
        }

        yield* TestClock.adjust(49)
        assert.deepStrictEqual(attempts, [1])
        yield* TestClock.adjust(1)
        const token = yield* Deferred.await(gateToken)
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual(workflowPasses, 2)

        yield* NativeDeferred.succeed(gate, {
          token,
          value: undefined
        })
        const terminal = yield* pollUntilComplete(
          ReplayWorkflow,
          executionId
        )
        assert(Exit.isSuccess(terminal.exit))
        if (Exit.isSuccess(terminal.exit)) {
          assert.deepStrictEqual(terminal.exit.value, {
            value: 42
          })
        }
        assert.strictEqual(workflowPasses, 2)
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual(classified.length, 1)
        assert.strictEqual(randomRuns, 1)
        assert.strictEqual(
          failureEncodeCounts.get("REPLAY_TEMPORARY"),
          1
        )
      }).pipe(
        Effect.provideService(Random.Random, random),
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("returns NonRetryable from the durable classifier decision", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.fail(
            businessFailure("DENIED", "approval denied")
          )) as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "NonRetryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-non-retryable"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "managed-non-retryable" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "NonRetryable"
        )
        const nonRetryable = failure as Retry.NonRetryable
        assert.strictEqual(
          nonRetryable.decision._tag,
          "Classifier"
        )
        assert.strictEqual(
          nonRetryable.cause.identity.errorCode,
          "DENIED"
        )
        assert.strictEqual(classifierRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps an admitted EffectWorkflowSemanticError instance in the business-failure channel", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      let classified: ActivityPolicyV3.RetryFailureCause | undefined
      const semanticLooking = new NativeSemantic.EffectWorkflowSemanticError({
        code: NativeSemantic.ErrorCodes.InvalidActivityInput,
        message: "admitted business failure"
      })
      assert.instanceOf(
        semanticLooking,
        NativeSemantic.EffectWorkflowSemanticError
      )
      const fixture = yield* makeFixture({
        handler: (() => Effect.fail(semanticLooking)) as Node.Handler<
          typeof retryNode
        >,
        classifier: (failure) =>
          Effect.sync(() => {
            classifierRuns++
            classified = failure
            return {
              _tag: "NonRetryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-semantic-looking-business-failure"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "managed-semantic-looking-business-failure" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "NonRetryable"
        )
        assert.strictEqual(classifierRuns, 1)
        assert.strictEqual(
          classified?._tag,
          "ApplicationFailure"
        )
        if (classified?._tag === "ApplicationFailure") {
          assert.deepStrictEqual(classified.identity, {
            failureIdentityVersion: 1,
            errorTag: "EffectWorkflowSemanticError",
            errorCode: NativeSemantic.ErrorCodes.InvalidActivityInput
          })
          assert.deepStrictEqual(classified.failure, {
            _tag: "Inline",
            value: {
              _tag: "EffectWorkflowSemanticError",
              code: NativeSemantic.ErrorCodes.InvalidActivityInput,
              message: "admitted business failure"
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

  it.effect("short-circuits the classifier for explicit non-retryable error tags and codes", () =>
    Effect.gen(function*() {
      const cases = [
        {
          id: "managed-explicit-tag",
          code: "TAG_MATCH",
          nonRetryableErrorTags: ["BusinessFailure"],
          nonRetryableErrorCodes: [] as ReadonlyArray<string>,
          matchedBy: "ErrorTag" as const
        },
        {
          id: "managed-explicit-code",
          code: "CODE_MATCH",
          nonRetryableErrorTags: [] as ReadonlyArray<string>,
          nonRetryableErrorCodes: ["CODE_MATCH"],
          matchedBy: "ErrorCode" as const
        }
      ] as const

      for (const testCase of cases) {
        let classifierRuns = 0
        const fixture = yield* makeFixture({
          handler: (() =>
            Effect.fail(
              businessFailure(testCase.code)
            )) as Node.Handler<typeof retryNode>,
          classifier: () =>
            Effect.sync(() => {
              classifierRuns++
              return {
                _tag: "Retryable" as const,
                classificationVersion: 1 as const
              }
            }),
          nonRetryableErrorTags: testCase.nonRetryableErrorTags,
          nonRetryableErrorCodes: testCase.nonRetryableErrorCodes
        })
        const preparedOccurrence = yield* occurrence(
          fixture,
          testCase.id
        )
        const invocation = yield* Retry.prepare({
          artifact: fixture.resolved,
          occurrence: preparedOccurrence,
          input: { _tag: "Inline", value: {} }
        })
        const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

        yield* Effect.gen(function*() {
          const executionId = yield* RuntimeWorkflow.execute(
            { id: testCase.id },
            { discard: true }
          )
          const terminal = yield* pollUntilComplete(
            RuntimeWorkflow,
            executionId
          )
          const failure = failReason(terminal.exit)
          assert.strictEqual(
            (failure as { readonly _tag?: unknown })._tag,
            "NonRetryable"
          )
          const nonRetryable = failure as Retry.NonRetryable
          assert.deepStrictEqual(nonRetryable.decision, {
            _tag: "PolicyOverride",
            decisionVersion: 1,
            matchedBy: testCase.matchedBy
          })
          assert.strictEqual(classifierRuns, 0)
        }).pipe(
          Effect.provide(
            registration.pipe(
              Layer.provideMerge(WorkflowEngine.layerMemory)
            )
          )
        )
      }
    }).pipe(provideCrypto))

  it.effect("returns Exhausted after an exact retryable classification at the attempt limit", () =>
    Effect.gen(function*() {
      let handlerRuns = 0
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.sync(() => {
            handlerRuns++
            return businessFailure("TEMPORARY")
          }).pipe(Effect.flip)) as Node.Handler<
            typeof retryNode
          >,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          }),
        maximumAttempts: 1
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-exhausted"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = RuntimeWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* RuntimeWorkflow.execute(
          { id: "managed-exhausted" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          RuntimeWorkflow,
          executionId
        )
        const failure = failReason(terminal.exit)
        assert.strictEqual(
          (failure as { readonly _tag?: unknown })._tag,
          "Exhausted"
        )
        assert.strictEqual(
          (failure as Retry.Exhausted).reason,
          "AttemptLimitReached"
        )
        assert.strictEqual(handlerRuns, 1)
        assert.strictEqual(classifierRuns, 1)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))

  it.effect("keeps a failure-codec violation as a defect and never classifies it", () =>
    Effect.gen(function*() {
      let classifierRuns = 0
      const fixture = yield* makeFixture({
        handler: (() =>
          Effect.fail({
            _tag: "NotAdmitted",
            code: "INVALID",
            message: "invalid failure shape"
          })) as unknown as Node.Handler<typeof retryNode>,
        classifier: () =>
          Effect.sync(() => {
            classifierRuns++
            return {
              _tag: "Retryable" as const,
              classificationVersion: 1 as const
            }
          })
      })
      const preparedOccurrence = yield* occurrence(
        fixture,
        "managed-codec-defect"
      )
      const invocation = yield* Retry.prepare({
        artifact: fixture.resolved,
        occurrence: preparedOccurrence,
        input: { _tag: "Inline", value: {} }
      })
      const registration = DefectWorkflow.toLayer(() => retryExecution(invocation))

      yield* Effect.gen(function*() {
        const executionId = yield* DefectWorkflow.execute(
          { id: "managed-codec-defect" },
          { discard: true }
        )
        const terminal = yield* pollUntilComplete(
          DefectWorkflow,
          executionId
        )
        assert(Exit.isFailure(terminal.exit))
        if (Exit.isFailure(terminal.exit)) {
          assert.isFalse(
            terminal.exit.cause.reasons.some(
              (reason) => reason._tag === "Fail"
            )
          )
          const died = terminal.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          assert.isDefined(died)
          if (died?._tag === "Die") {
            assert.strictEqual(
              (died.defect as { readonly _tag?: unknown })._tag,
              "EffectWorkflowActivityDefect"
            )
            assert.strictEqual(
              (died.defect as { readonly code?: unknown }).code,
              NativeSemantic.ActivityDefectCodes.InvalidFailure
            )
          }
        }
        assert.strictEqual(classifierRuns, 0)
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provideMerge(WorkflowEngine.layerMemory)
          )
        )
      )
    }).pipe(provideCrypto))
})
