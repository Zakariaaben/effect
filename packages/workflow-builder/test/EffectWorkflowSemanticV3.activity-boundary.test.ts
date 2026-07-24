import { assert, describe, it } from "@effect/vitest"
import type * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NativeWorkflow from "effect/unstable/workflow/Workflow"
import { createHash } from "node:crypto"
import type * as ActivityPolicyV3 from "../src/ActivityPolicyV3.ts"
import * as ChildWorkflowV3 from "../src/ChildWorkflowV3.ts"
import * as CompilerV2 from "../src/CompilerV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as DigestV3 from "../src/DigestV3.ts"
import * as NativeSemantic from "../src/EffectWorkflowSemanticV3.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStoreV3 from "../src/PlanStoreV3.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Executables from "../src/SemanticExecutableRegistryV3.ts"
import * as Occurrence from "../src/SemanticOccurrenceV3.ts"
import * as Operation from "../src/SemanticOperationV3.ts"
import * as Workflow from "../src/Workflow.ts"

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const provideCrypto = Effect.provideService(Crypto.Crypto, crypto)

const textSchema = Schema.String
const configSchema = Schema.Struct({
  prefix: textSchema
})
const failureSchema = Schema.Struct({
  code: textSchema
})
const outputAggregateSchema = Schema.Struct({
  value: textSchema
})

const step = Node.make("BoundaryStep", {
  version: "1.0.0",
  config: configSchema,
  inputs: {
    value: Port.input(textSchema, {
      contract: "activity-boundary/text"
    })
  },
  outputs: {
    value: Port.output(textSchema, {
      contract: "activity-boundary/text"
    })
  },
  failure: failureSchema
})

const nodeRegistry = Registry.make(step)

const definition = Workflow.make("activity-boundary-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(textSchema, {
      contract: "activity-boundary/text",
      fanOut: "single"
    })
  },
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
  id: "activity-boundary-plan",
  revision: 7,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "step",
    type: step.type,
    version: step.version,
    config: {
      prefix: "handled:"
    }
  }],
  edges: [{
    _tag: "DataEdge" as const,
    id: "workflow-input-to-step",
    source: {
      _tag: "WorkflowInput" as const,
      input: "value"
    },
    target: {
      _tag: "NodeInput" as const,
      nodeId: "step",
      input: "value"
    }
  }]
}

const HandlerModes = {
  BusinessFailure: "business-failure",
  ThrowSync: "throw-sync",
  NonEffect: "non-effect",
  InvalidSchema: "invalid-schema",
  ExtraProperty: "extra-property",
  MissingProperty: "missing-property",
  SymbolProperty: "symbol-property",
  AccessorProperty: "accessor-property",
  ExoticPrototype: "exotic-prototype"
} as const

interface Telemetry {
  readonly requests: Array<Node.HandlerRequest<typeof step>>
  getterReads: number
}

const makeHandler = (
  telemetry: Telemetry
): Node.Handler<typeof step> =>
  ((request: Node.HandlerRequest<typeof step>): unknown => {
    telemetry.requests.push(request)
    switch (request.inputs.value) {
      case HandlerModes.BusinessFailure:
        return Effect.fail({ code: "BUSINESS_DENIED" })
      case HandlerModes.ThrowSync:
        throw new Error("synchronous handler failure")
      case HandlerModes.NonEffect:
        return { value: "not-an-effect" }
      case HandlerModes.InvalidSchema:
        return Effect.succeed({ value: 42 })
      case HandlerModes.ExtraProperty:
        return Effect.succeed({
          value: "ok",
          extra: true
        })
      case HandlerModes.MissingProperty:
        return Effect.succeed({})
      case HandlerModes.SymbolProperty:
        return Effect.succeed({
          value: "ok",
          [Symbol("hidden")]: "not-admitted"
        })
      case HandlerModes.AccessorProperty: {
        const output: Record<string, unknown> = {}
        Object.defineProperty(output, "value", {
          enumerable: true,
          get() {
            telemetry.getterReads++
            return "must-not-be-read"
          }
        })
        return Effect.succeed(output)
      }
      case HandlerModes.ExoticPrototype: {
        const output = Object.create({
          inherited: true
        }) as Record<string, unknown>
        output.value = "ok"
        return Effect.succeed(output)
      }
      default:
        return Effect.succeed({
          value: `${request.config.prefix}${request.inputs.value}`
        })
    }
  }) as unknown as Node.Handler<typeof step>

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

const activityPolicy = (
  classifierBuildDigest: PlanStoreV3.ExecutableBuildPin["buildDigest"]
): ActivityPolicyV3.Policy => ({
  policyVersion: 3,
  retry: {
    retryPolicyVersion: 3,
    maximumAttempts: 2,
    maximumElapsed: { _tag: "Unlimited" },
    classifier: {
      classifierPinVersion: 3,
      classifierId: "activity-boundary-classifier",
      classifierVersion: "1.0.0",
      buildDigest: classifierBuildDigest
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
})

interface Fixture {
  readonly verified: PlanStoreV3.VerifiedArtifact
  readonly resolvedArtifact: Executables.ResolvedArtifactExecutables
  readonly binding: PlanStoreV3.NodeBinding
  readonly failureCodec: PlanStoreV3.CodecPin
  readonly telemetry: Telemetry
}

const makeFixture = (
  config: Schema.Json = {
    prefix: "handled:"
  }
) =>
  Effect.gen(function*() {
    const compiled = yield* CompilerV2.compile(definition, plan)
    const semanticNode = compiled.fingerprintDocument.semanticPlan.nodes[0]!
    const fingerprintDocument = {
      ...compiled.fingerprintDocument,
      semanticPlan: {
        ...compiled.fingerprintDocument.semanticPlan,
        nodes: [{
          ...semanticNode,
          config
        }]
      }
    } satisfies CompilerV2.FingerprintDocument
    const definitionBuild = yield* buildPin(
      "WorkflowDefinition",
      definition.id,
      definition.version,
      "activity-boundary-definition"
    )
    const handlerBuild = yield* buildPin(
      "NodeHandler",
      step.type,
      step.version,
      "activity-boundary-handler"
    )
    const classifierBuild = yield* buildPin(
      "RetryClassifier",
      "activity-boundary-classifier",
      "1.0.0",
      "activity-boundary-classifier"
    )
    const codecs = yield* Effect.all([
      codecPin("activity-boundary-config", {
        type: "object",
        additionalProperties: false,
        required: ["prefix"],
        properties: {
          prefix: { type: "string" }
        }
      }),
      codecPin("activity-boundary-failure", {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: { type: "string" }
        }
      }),
      codecPin("activity-boundary-text", {
        type: "string"
      })
    ])
    codecs.sort((left, right) => left.key < right.key ? -1 : 1)

    const configCodecKey = PlanStoreV3.codecKey(
      "activity-boundary-config",
      "1.0.0"
    )
    const failureCodecKey = PlanStoreV3.codecKey(
      "activity-boundary-failure",
      "1.0.0"
    )
    const textCodecKey = PlanStoreV3.codecKey(
      "activity-boundary-text",
      "1.0.0"
    )
    const nodeDefinitionKey = PlanStoreV3.nodeDefinitionKey(
      step.type,
      step.version
    )
    const classifierKey = PlanStoreV3.classifierKey(
      "activity-boundary-classifier",
      "1.0.0"
    )
    const inputBoundaryDocument = {
      boundaryContractVersion: 3 as const,
      direction: "Input" as const,
      definition: {
        id: definition.id,
        version: definition.version
      },
      ports: [{
        name: "value",
        contract: "activity-boundary/text",
        fanOut: "single" as const,
        codecKey: textCodecKey
      }]
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
      fingerprintDocument,
      compiledFingerprint: yield* DigestV3.compiledPlan(
        fingerprintDocument
      ),
      workflowFamilyIdentity: ChildWorkflowV3.workflowFamilyIdentity(
        definition.id
      ),
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
        nodeType: step.type,
        nodeVersion: step.version,
        configCodecKey,
        failureCodecKey,
        inputs: [{
          name: "value",
          contract: "activity-boundary/text",
          cardinality: "one",
          required: true,
          codecKey: textCodecKey
        }],
        outputs: [{
          name: "value",
          contract: "activity-boundary/text",
          fanOut: "multiple",
          codecKey: textCodecKey
        }]
      }],
      codecs,
      policyExecutableBuilds: [{
        key: classifierKey,
        classifierId: "activity-boundary-classifier",
        classifierVersion: "1.0.0",
        build: classifierBuild
      }],
      nodeBindings: [{
        bindingVersion: 3,
        nodeId: "step",
        nodeType: step.type,
        nodeVersion: step.version,
        nodeDefinitionKey,
        queue: "activity-boundary-queue",
        handlerBuild,
        activityPolicy: activityPolicy(classifierBuild.buildDigest)
      }]
    }
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      yield* DigestV3.artifact(artifact)
    )

    const telemetry: Telemetry = {
      requests: [],
      getterReads: 0
    }
    const handlers = yield* nodeRegistry.toHandlers(nodeRegistry.of({
      "BoundaryStep@1.0.0": makeHandler(telemetry)
    }))
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
          step
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
      Executables.nodeHandler(
        deployedHandlers,
        handlerBuild
      )
    )
    const runtimeSchemas = {
      "activity-boundary-config": configSchema,
      "activity-boundary-failure": failureSchema,
      "activity-boundary-text": textSchema
    } as const
    const codecExecutables = yield* Effect.forEach(
      verified.artifact.codecs,
      (pin) =>
        Executables.codec(
          pin,
          runtimeSchemas[
            pin.codecId as keyof typeof runtimeSchemas
          ]
        )
    )
    const classifierExecutable = yield* Executables.retryClassifier(
      verified.artifact.policyExecutableBuilds[0]!,
      () =>
        Effect.succeed({
          _tag: "NonRetryable" as const,
          classificationVersion: 1 as const
        })
    )
    const registry = yield* Executables.make([
      workflowExecutable,
      nodeExecutable,
      ...codecExecutables,
      classifierExecutable
    ])
    const resolvedArtifact = yield* registry.resolveArtifact(verified)
    const failureCodec = verified.artifact.codecs.find(
      (pin) => pin.key === failureCodecKey
    )!

    return {
      verified,
      resolvedArtifact,
      binding: verified.artifact.nodeBindings[0]!,
      failureCodec,
      telemetry
    } satisfies Fixture
  })

const expectSuccess = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

interface PreparedActivity {
  readonly occurrence: Occurrence.PreparedOccurrence
  readonly operation: Operation.PreparedOperation
  readonly resolution: Executables.ResolvedNodeHandlerActivity
}

interface PreparedNodeAttempt {
  readonly occurrence: Occurrence.PreparedOccurrence
  readonly operation: Operation.PreparedOperation
  readonly resolution: Executables.ResolvedNodeAttemptActivity
}

const prepareActivity = (
  fixture: Fixture,
  options: {
    readonly runId: string
    readonly attempt?: number | undefined
    readonly input: Schema.Json
  }
) =>
  Effect.gen(function*() {
    const occurrence = yield* Occurrence.prepare({
      occurrenceVersion: Occurrence.OccurrenceVersion,
      executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
      tenantId: "tenant-boundary",
      runId: options.runId,
      artifactDigest: fixture.verified.artifactDigest,
      nodeId: fixture.binding.nodeId,
      scopePath: [],
      activation: 0
    })
    const operation = yield* Operation.prepare(occurrence, {
      _tag: "Activity",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: Operation.ExecutionProtocolVersion,
      operationId: "invoke-handler",
      attempt: options.attempt ?? 1,
      purpose: {
        _tag: "NodeHandler",
        purposeVersion: 1,
        nodeDefinitionKey: fixture.binding.nodeDefinitionKey,
        handlerBuildDigest: fixture.binding.handlerBuild.buildDigest
      },
      input: {
        _tag: "Inline",
        value: options.input
      },
      successContract: {
        _tag: "NodeOutputAggregate",
        contractReferenceVersion: 1,
        nodeDefinitionKey: fixture.binding.nodeDefinitionKey
      },
      errorContract: {
        _tag: "ArtifactCodec",
        contractReferenceVersion: 1,
        codecKey: fixture.failureCodec.key,
        schemaDigest: fixture.failureCodec.schemaDigest
      }
    })
    const resolution = expectSuccess(
      Executables.resolveActivity(
        fixture.resolvedArtifact,
        operation
      )
    )
    if (resolution._tag !== "NodeHandler") {
      return yield* Effect.die(
        "Expected an exact node-handler activity resolution"
      )
    }
    return {
      occurrence,
      operation,
      resolution
    } satisfies PreparedActivity
  })

const prepareNodeAttempt = (
  fixture: Fixture,
  options: {
    readonly runId: string
    readonly attempt?: number | undefined
    readonly input: Schema.Json
  }
) =>
  Effect.gen(function*() {
    const occurrence = yield* Occurrence.prepare({
      occurrenceVersion: Occurrence.OccurrenceVersion,
      executionProtocolVersion: Occurrence.ExecutionProtocolVersion,
      tenantId: "tenant-boundary",
      runId: options.runId,
      artifactDigest: fixture.verified.artifactDigest,
      nodeId: fixture.binding.nodeId,
      scopePath: [],
      activation: 0
    })
    const operation = yield* Operation.prepare(occurrence, {
      _tag: "Activity",
      operationVersion: Operation.OperationVersion,
      executionProtocolVersion: Operation.ExecutionProtocolVersion,
      operationId: "invoke-handler",
      attempt: options.attempt ?? 1,
      purpose: {
        _tag: "NodeAttempt",
        purposeVersion: 1,
        nodeDefinitionKey: fixture.binding.nodeDefinitionKey,
        handlerBuildDigest: fixture.binding.handlerBuild.buildDigest
      },
      input: {
        _tag: "Inline",
        value: options.input
      },
      successContract: {
        _tag: "BuiltIn",
        contractReferenceVersion: 1,
        vocabularyVersion: 2,
        schema: "NodeAttemptOutcome"
      },
      errorContract: {
        _tag: "BuiltIn",
        contractReferenceVersion: 1,
        vocabularyVersion: 2,
        schema: "Never"
      }
    })
    const resolution = expectSuccess(
      Executables.resolveActivity(
        fixture.resolvedArtifact,
        operation
      )
    )
    if (resolution._tag !== "NodeAttempt") {
      return yield* Effect.die(
        "Expected an exact managed node-attempt activity resolution"
      )
    }
    return {
      occurrence,
      operation,
      resolution
    } satisfies PreparedNodeAttempt
  })

const nodeAttemptTimeout = (
  prepared: PreparedNodeAttempt,
  options: {
    readonly attempt?: number | undefined
    readonly activityDigest?: Operation.PreparedOperation["operationDigest"] | undefined
  } = {}
): Operation.NodeAttemptTimedOut => {
  const document = prepared.operation.document
  if (document._tag !== "Activity") {
    throw new TypeError("Expected an Activity operation")
  }
  const attempt = options.attempt ?? document.attempt
  const activityDigest = options.activityDigest ??
    prepared.operation.operationDigest
  return Schema.decodeUnknownSync(Operation.NodeAttemptTimedOut)({
    _tag: "TimedOut",
    outcomeVersion: 2,
    attempt,
    activityDigest,
    timeout: {
      _tag: "AttemptTimeout",
      failureCauseVersion: 1,
      activityDigest,
      attempt,
      timeoutKind: "ScheduleToStart"
    },
    timerOperationDigest: prepared.operation.operationDigest,
    deadline: "2026-07-23T12:00:00.000Z",
    durationMillis: 5_000
  })
}

const noInterruptRetry = Schedule.recurs(0).pipe(
  Schedule.setInputType<Cause.Cause<unknown>>()
)

const BoundaryWorkflow = NativeWorkflow.make(
  "WorkflowBuilder/EffectWorkflowSemanticV3/ActivityBoundary",
  {
    payload: {
      id: Schema.String
    },
    success: Schema.String,
    error: Schema.Unknown,
    idempotencyKey: ({ id }) => id
  }
)

const runInWorkflow = (
  id: string,
  execute: Effect.Effect<
    string,
    unknown,
    NativeSemantic.Requirements
  >
) => {
  const registration = BoundaryWorkflow.toLayer(() => execute)
  return Effect.exit(
    BoundaryWorkflow.execute({ id })
  ).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () =>
        Effect.die(
          `Native boundary workflow '${id}' did not complete within 2 seconds`
        )
    }),
    Effect.map((exit) => ({
      _tag: "Complete" as const,
      exit
    })),
    Effect.provide(
      registration.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      )
    )
  )
}

const assertActivityDefect = (
  exit: Exit.Exit<unknown, unknown>,
  code: NativeSemantic.ActivityDefectCode
): void => {
  assert(Exit.isFailure(exit))
  if (Exit.isSuccess(exit)) return
  assert.isFalse(
    exit.cause.reasons.some((reason) => reason._tag === "Fail")
  )
  const reason = exit.cause.reasons.find(
    (reason) => reason._tag === "Die"
  )
  assert.isDefined(reason)
  if (reason?._tag !== "Die") return
  assert.isTrue(
    reason.defect instanceof
      NativeSemantic.EffectWorkflowActivityDefect
  )
  if (
    !(reason.defect instanceof
      NativeSemantic.EffectWorkflowActivityDefect)
  ) {
    return
  }
  assert.strictEqual(reason.defect.code, code)
  assert.strictEqual(reason.defect.nodeId, "step")
  assert.strictEqual(reason.defect.operationId, "invoke-handler")
}

describe("EffectWorkflowSemanticV3 node activity boundary", () => {
  it.effect("passes exact config, inputs, and complete stable durable handler context", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const first = yield* prepareActivity(fixture, {
        runId: "run-success",
        attempt: 1,
        input: { value: "first" }
      })
      const second = yield* prepareActivity(fixture, {
        runId: "run-success",
        attempt: 2,
        input: { value: "second" }
      })

      const terminal = yield* runInWorkflow(
        "automatic-handler-success",
        Effect.gen(function*() {
          const firstOutput = expectSuccess(
            Schema.decodeUnknownResult(outputAggregateSchema)(
              yield* NativeSemantic.activity(first.resolution, {
                interruptRetryPolicy: noInterruptRetry
              })
            )
          )
          const secondOutput = expectSuccess(
            Schema.decodeUnknownResult(outputAggregateSchema)(
              yield* NativeSemantic.activity(second.resolution, {
                interruptRetryPolicy: noInterruptRetry
              })
            )
          )
          return `${firstOutput.value}/${secondOutput.value}`
        })
      )

      assert(Exit.isSuccess(terminal.exit))
      if (Exit.isFailure(terminal.exit)) return
      assert.strictEqual(
        terminal.exit.value,
        "handled:first/handled:second"
      )
      assert.strictEqual(fixture.telemetry.requests.length, 2)
      const [firstRequest, secondRequest] = fixture.telemetry.requests
      assert.deepStrictEqual(firstRequest!.config, {
        prefix: "handled:"
      })
      assert.deepStrictEqual(firstRequest!.inputs, {
        value: "first"
      })
      assert.deepStrictEqual(secondRequest!.config, {
        prefix: "handled:"
      })
      assert.deepStrictEqual(secondRequest!.inputs, {
        value: "second"
      })

      for (const request of fixture.telemetry.requests) {
        assert.deepStrictEqual(request.context.scope, {
          _tag: "Durable",
          tenantId: "tenant-boundary",
          handlerDeploymentId: fixture.binding.handlerBuild.deploymentId
        })
        assert.strictEqual(request.context.runId, "run-success")
        assert.strictEqual(
          request.context.planId,
          "activity-boundary-plan"
        )
        assert.strictEqual(request.context.planRevision, 7)
        assert.strictEqual(request.context.nodeId, "step")
        assert.strictEqual(
          request.context.nodeInstanceId,
          first.occurrence.occurrenceDigest
        )
        assert.isTrue(Object.isFrozen(request.context))
        assert.isTrue(Object.isFrozen(request.context.scope))
      }
      assert.strictEqual(firstRequest!.context.attempt, 1)
      assert.strictEqual(secondRequest!.context.attempt, 2)
      assert.isNotEmpty(firstRequest!.context.idempotencyKey)
      assert.strictEqual(
        firstRequest!.context.idempotencyKey,
        secondRequest!.context.idempotencyKey
      )
    }).pipe(provideCrypto))

  it.effect("preserves the handler's exact typed business failure", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareActivity(fixture, {
        runId: "run-business-failure",
        input: {
          value: HandlerModes.BusinessFailure
        }
      })
      const terminal = yield* runInWorkflow(
        "typed-business-failure",
        NativeSemantic.activity(prepared.resolution, {
          interruptRetryPolicy: noInterruptRetry
        }).pipe(Effect.as("unreachable"))
      )

      assert(Exit.isFailure(terminal.exit))
      if (Exit.isSuccess(terminal.exit)) return
      assert.isFalse(
        terminal.exit.cause.reasons.some(
          (reason) => reason._tag === "Die"
        )
      )
      const reason = terminal.exit.cause.reasons.find(
        (reason) => reason._tag === "Fail"
      )
      assert.isDefined(reason)
      if (reason?._tag === "Fail") {
        assert.deepStrictEqual(reason.error, {
          code: "BUSINESS_DENIED"
        })
      }
      assert.strictEqual(fixture.telemetry.requests.length, 1)
    }).pipe(provideCrypto))

  it.effect("turns every invalid boundary shape into an activity defect without evaluating accessors", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const invalidConfigFixture = yield* makeFixture({
        prefix: 42
      })
      const cases = [
        {
          id: "invalid-config",
          prepared: yield* prepareActivity(invalidConfigFixture, {
            runId: "run-invalid-config",
            input: { value: "valid" }
          }),
          code: NativeSemantic.ActivityDefectCodes
            .InvalidConfiguration
        },
        {
          id: "invalid-input",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-invalid-input",
            input: { value: 42 }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidInput
        },
        {
          id: "throw-sync",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-throw-sync",
            input: { value: HandlerModes.ThrowSync }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidHandler
        },
        {
          id: "non-effect",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-non-effect",
            input: { value: HandlerModes.NonEffect }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidHandler
        },
        {
          id: "invalid-output-schema",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-invalid-output-schema",
            input: { value: HandlerModes.InvalidSchema }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidOutput
        },
        {
          id: "extra-output-property",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-extra-output-property",
            input: { value: HandlerModes.ExtraProperty }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidOutput
        },
        {
          id: "missing-output-property",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-missing-output-property",
            input: { value: HandlerModes.MissingProperty }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidOutput
        },
        {
          id: "symbol-output-property",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-symbol-output-property",
            input: { value: HandlerModes.SymbolProperty }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidOutput
        },
        {
          id: "accessor-output-property",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-accessor-output-property",
            input: { value: HandlerModes.AccessorProperty }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidOutput
        },
        {
          id: "exotic-output-prototype",
          prepared: yield* prepareActivity(fixture, {
            runId: "run-exotic-output-prototype",
            input: { value: HandlerModes.ExoticPrototype }
          }),
          code: NativeSemantic.ActivityDefectCodes.InvalidOutput
        }
      ] as const

      for (const testCase of cases) {
        const terminal = yield* runInWorkflow(
          testCase.id,
          NativeSemantic.activity(testCase.prepared.resolution, {
            interruptRetryPolicy: noInterruptRetry
          }).pipe(Effect.as("unreachable"))
        )
        assertActivityDefect(terminal.exit, testCase.code)
      }

      assert.strictEqual(
        invalidConfigFixture.telemetry.requests.length,
        0
      )
      assert.strictEqual(fixture.telemetry.requests.length, 8)
      assert.strictEqual(fixture.telemetry.getterReads, 0)
    }).pipe(provideCrypto))

  it.effect("returns and replays the durable successful node-attempt completion receipt", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareNodeAttempt(fixture, {
        runId: "run-node-attempt-completion-success",
        input: { value: "once" }
      })

      const terminal = yield* runInWorkflow(
        "managed-node-attempt-completion-success",
        Effect.gen(function*() {
          const first = yield* NativeSemantic.nodeAttemptCompletion(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )
          const replay = yield* NativeSemantic.nodeAttemptCompletion(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )

          assert(Exit.isSuccess(first.exit))
          assert(Exit.isSuccess(replay.exit))
          if (
            Exit.isFailure(first.exit) ||
            Exit.isFailure(replay.exit)
          ) {
            return "unreachable"
          }
          assert.strictEqual(first.exit.value._tag, "Succeeded")
          assert.deepStrictEqual(replay.exit.value, first.exit.value)
          assert.isTrue(
            Number.isSafeInteger(first.completedAt.epochMilliseconds)
          )
          assert.strictEqual(
            replay.completedAt.epochMilliseconds,
            first.completedAt.epochMilliseconds
          )
          return `${first.exit.value._tag}/${replay.exit.value._tag}`
        })
      )

      assert(Exit.isSuccess(terminal.exit))
      if (Exit.isFailure(terminal.exit)) return
      assert.strictEqual(terminal.exit.value, "Succeeded/Succeeded")
      assert.strictEqual(fixture.telemetry.requests.length, 1)
    }).pipe(provideCrypto))

  it.effect("returns a timestamped node-attempt completion receipt containing a native Die", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareNodeAttempt(fixture, {
        runId: "run-node-attempt-completion-defect",
        input: { value: HandlerModes.ThrowSync }
      })

      const terminal = yield* runInWorkflow(
        "managed-node-attempt-completion-defect",
        Effect.gen(function*() {
          const completion = yield* NativeSemantic.nodeAttemptCompletion(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )
          assert(Exit.isFailure(completion.exit))
          if (Exit.isSuccess(completion.exit)) return "unreachable"
          assert.isFalse(
            completion.exit.cause.reasons.some(
              (reason) => reason._tag === "Fail"
            )
          )
          assert.isTrue(
            completion.exit.cause.reasons.some(
              (reason) => reason._tag === "Die"
            )
          )
          assert.isTrue(
            Number.isSafeInteger(
              completion.completedAt.epochMilliseconds
            )
          )
          return "captured"
        })
      )

      assert(Exit.isSuccess(terminal.exit))
      if (Exit.isFailure(terminal.exit)) return
      assert.strictEqual(terminal.exit.value, "captured")
      assert.strictEqual(fixture.telemetry.requests.length, 1)
    }).pipe(provideCrypto))

  it.effect("re-emits the captured native Cause through the normal node-attempt API", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareNodeAttempt(fixture, {
        runId: "run-node-attempt-public-defect",
        input: { value: HandlerModes.ThrowSync }
      })

      const terminal = yield* runInWorkflow(
        "managed-node-attempt-public-defect",
        Effect.gen(function*() {
          const completion = yield* NativeSemantic.nodeAttemptCompletion(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry
            }
          )
          const publicExit = yield* Effect.exit(
            NativeSemantic.nodeAttempt(
              prepared.resolution,
              {
                interruptRetryPolicy: noInterruptRetry
              }
            )
          )

          assert(Exit.isFailure(completion.exit))
          assert(Exit.isFailure(publicExit))
          if (
            Exit.isSuccess(completion.exit) ||
            Exit.isSuccess(publicExit)
          ) {
            return "unreachable"
          }
          assert.deepStrictEqual(
            publicExit.cause.reasons.map((reason) => reason._tag),
            completion.exit.cause.reasons.map((reason) => reason._tag)
          )
          const capturedDie = completion.exit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          const publicDie = publicExit.cause.reasons.find(
            (reason) => reason._tag === "Die"
          )
          assert.isDefined(capturedDie)
          assert.isDefined(publicDie)
          if (
            capturedDie?._tag !== "Die" ||
            publicDie?._tag !== "Die"
          ) {
            return "unreachable"
          }
          assert.strictEqual(
            String(publicDie.defect),
            String(capturedDie.defect)
          )
          return "re-emitted"
        })
      )

      assert(Exit.isSuccess(terminal.exit))
      if (Exit.isFailure(terminal.exit)) return
      assert.strictEqual(terminal.exit.value, "re-emitted")
      assert.strictEqual(fixture.telemetry.requests.length, 1)
    }).pipe(provideCrypto))

  it.effect("does not construct or execute the handler when the native start gate times out", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareNodeAttempt(fixture, {
        runId: "run-start-gate-timeout",
        input: { value: "must-not-run" }
      })
      const timeout = nodeAttemptTimeout(prepared)

      const terminal = yield* runInWorkflow(
        "managed-start-gate-timeout",
        Effect.gen(function*() {
          const completion = yield* NativeSemantic.nodeAttemptCompletionWithStartGate(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry,
              expectedTimeout: Effect.succeed(timeout),
              startGate: Effect.succeed(timeout)
            }
          )
          assert(Exit.isSuccess(completion.exit))
          if (Exit.isFailure(completion.exit)) return "unreachable"
          assert.isTrue(
            Number.isSafeInteger(
              completion.completedAt.epochMilliseconds
            )
          )
          return completion.exit.value._tag
        })
      )

      assert(Exit.isSuccess(terminal.exit))
      if (Exit.isFailure(terminal.exit)) return
      assert.strictEqual(terminal.exit.value, "TimedOut")
      assert.strictEqual(fixture.telemetry.requests.length, 0)
    }).pipe(provideCrypto))

  it.effect("executes the handler exactly once when the native start gate proceeds", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareNodeAttempt(fixture, {
        runId: "run-start-gate-proceed",
        input: { value: "once" }
      })

      const terminal = yield* runInWorkflow(
        "managed-start-gate-proceed",
        NativeSemantic.nodeAttemptWithStartGate(
          prepared.resolution,
          {
            interruptRetryPolicy: noInterruptRetry,
            expectedTimeout: Effect.succeed(undefined),
            startGate: Effect.succeed(undefined)
          }
        ).pipe(Effect.map((outcome) => outcome._tag))
      )

      assert(Exit.isSuccess(terminal.exit))
      if (Exit.isFailure(terminal.exit)) return
      assert.strictEqual(terminal.exit.value, "Succeeded")
      assert.strictEqual(fixture.telemetry.requests.length, 1)
      assert.deepStrictEqual(
        fixture.telemetry.requests[0]!.inputs,
        { value: "once" }
      )
    }).pipe(provideCrypto))

  it.effect("defects when a start-gate timeout carries different outer attempt coordinates", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const prepared = yield* prepareNodeAttempt(fixture, {
        runId: "run-start-gate-invalid-coordinates",
        attempt: 1,
        input: { value: "must-not-run" }
      })
      const timeout = nodeAttemptTimeout(prepared, {
        attempt: 2
      })

      const terminal = yield* runInWorkflow(
        "managed-start-gate-invalid-coordinates",
        NativeSemantic.nodeAttemptWithStartGate(
          prepared.resolution,
          {
            interruptRetryPolicy: noInterruptRetry,
            expectedTimeout: Effect.succeed(timeout),
            startGate: Effect.succeed(timeout)
          }
        ).pipe(Effect.as("unreachable"))
      )

      assertActivityDefect(
        terminal.exit,
        NativeSemantic.ActivityDefectCodes.InvalidOutcome
      )
      assert.strictEqual(fixture.telemetry.requests.length, 0)
    }).pipe(provideCrypto))

  it.effect("rejects a timeout with valid outer coordinates but altered timer provenance before the handler", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const candidates = [
        {
          id: "timer-digest",
          alter: (expected: Operation.NodeAttemptTimedOut) => ({
            ...expected,
            timerOperationDigest: `sha256:${"f".repeat(64)}`
          })
        },
        {
          id: "duration",
          alter: (expected: Operation.NodeAttemptTimedOut) => ({
            ...expected,
            durationMillis: expected.durationMillis + 1
          })
        },
        {
          id: "deadline",
          alter: (expected: Operation.NodeAttemptTimedOut) => ({
            ...expected,
            deadline: "2026-07-23T12:00:01.000Z"
          })
        },
        {
          id: "timeout-kind",
          alter: (expected: Operation.NodeAttemptTimedOut) => ({
            ...expected,
            timeout: {
              ...expected.timeout,
              timeoutKind: "StartToClose"
            }
          })
        }
      ] as const

      for (const candidate of candidates) {
        const prepared = yield* prepareNodeAttempt(fixture, {
          runId: `run-start-gate-altered-${candidate.id}`,
          input: { value: "must-not-run" }
        })
        const expectedTimeout = nodeAttemptTimeout(prepared)
        const alteredTimeout = Schema.decodeUnknownSync(
          Operation.NodeAttemptTimedOut
        )(candidate.alter(expectedTimeout))

        const terminal = yield* runInWorkflow(
          `managed-start-gate-altered-${candidate.id}`,
          NativeSemantic.nodeAttemptWithStartGate(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry,
              expectedTimeout: Effect.succeed(expectedTimeout),
              startGate: Effect.succeed(alteredTimeout)
            }
          ).pipe(Effect.as("unreachable"))
        )

        assertActivityDefect(
          terminal.exit,
          NativeSemantic.ActivityDefectCodes.InvalidOutcome
        )
      }

      assert.strictEqual(fixture.telemetry.requests.length, 0)
    }).pipe(provideCrypto))

  it.effect("rejects success and application-failure values forged through the timeout-only gate", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const candidates = [
        {
          id: "success",
          outcome: (prepared: PreparedNodeAttempt) =>
            Schema.decodeUnknownSync(Operation.NodeAttemptOutcome)({
              _tag: "Succeeded",
              outcomeVersion: 2,
              attempt: 1,
              activityDigest: prepared.operation.operationDigest,
              completedAt: "2026-07-23T11:59:59.000Z",
              output: {
                _tag: "Inline",
                value: { value: "forged" }
              }
            })
        },
        {
          id: "application-failure",
          outcome: (prepared: PreparedNodeAttempt) =>
            Schema.decodeUnknownSync(Operation.NodeAttemptOutcome)({
              _tag: "ApplicationFailed",
              outcomeVersion: 2,
              attempt: 1,
              activityDigest: prepared.operation.operationDigest,
              completedAt: "2026-07-23T11:59:59.000Z",
              failure: {
                _tag: "ApplicationFailure",
                failureCauseVersion: 1,
                activityDigest: prepared.operation.operationDigest,
                attempt: 1,
                identity: {
                  failureIdentityVersion: 1,
                  errorTag: "ForgedFailure",
                  errorCode: "FORGED"
                },
                failure: {
                  _tag: "Inline",
                  value: { code: "FORGED" }
                }
              }
            })
        }
      ] as const

      for (const candidate of candidates) {
        const prepared = yield* prepareNodeAttempt(fixture, {
          runId: `run-start-gate-forged-${candidate.id}`,
          input: { value: "must-not-run" }
        })
        const forged = candidate.outcome(prepared) as unknown as Operation.NodeAttemptTimedOut
        const terminal = yield* runInWorkflow(
          `managed-start-gate-forged-${candidate.id}`,
          NativeSemantic.nodeAttemptWithStartGate(
            prepared.resolution,
            {
              interruptRetryPolicy: noInterruptRetry,
              expectedTimeout: Effect.succeed(undefined),
              startGate: Effect.succeed(forged)
            }
          ).pipe(Effect.as("unreachable"))
        )

        assertActivityDefect(
          terminal.exit,
          NativeSemantic.ActivityDefectCodes.InvalidOutcome
        )
      }

      assert.strictEqual(fixture.telemetry.requests.length, 0)
    }).pipe(provideCrypto))
})
