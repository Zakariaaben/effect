import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as Compiler from "../src/Compiler.ts"
import * as DecisionV1 from "../src/Decision.ts"
import * as DecisionV2 from "../src/DecisionV2.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DigestV2 from "../src/DigestV2.ts"
import * as DurableStartV2 from "../src/DurableStartV2.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStoreV2 from "../src/PlanStoreV2.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

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

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const jsonContract = "durable-start-v2/json"
const consume = Node.make("ConsumeV2", {
  version: "1.0.0",
  inputs: {
    document: Port.input(Schema.Json, { contract: jsonContract })
  },
  outputs: {}
})

const definition = Workflow.make("durable-start-v2-workflow", {
  version: "1.0.0",
  inputs: {
    document: Port.output(Schema.Json, { contract: jsonContract })
  },
  outputs: {},
  nodes: Registry.make(consume),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const graphPlan = {
  formatVersion: 1,
  id: "durable-start-v2-plan",
  revision: 2,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [
    {
      id: "worker",
      type: consume.type,
      version: consume.version,
      config: {}
    }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "document-worker",
      source: {
        _tag: "WorkflowInput" as const,
        input: "document"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId: "worker",
        input: "document"
      }
    }
  ]
}

const policy: ActivityPolicy.Policy = {
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: 3,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: true,
      scheduleToStartTimeout: true,
      startToCloseTimeout: true
    },
    backoff: { _tag: "Fixed", delayMillis: 1_000 },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: { _tag: "After", durationMillis: 10_000 },
    startToClose: { _tag: "After", durationMillis: 20_000 },
    scheduleToClose: { _tag: "After", durationMillis: 30_000 }
  }
}

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

const artifact = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>,
  options: {
    readonly definitionDeploymentId: string
    readonly dispatchTargets: PlanStoreV2.DispatchTargets
    readonly activityPolicies: PlanStoreV2.ActivityPolicies
  }
) {
  const fingerprintDocument = Fingerprint.materialize(compiled)
  const compiledFingerprint = yield* DigestV2.compiledPlan(
    fingerprintDocument as unknown as Schema.Json
  )
  return {
    artifactVersion: 2,
    executionProtocolVersion: 2,
    fingerprintDocument,
    compiledFingerprint,
    definitionDeploymentId: options.definitionDeploymentId,
    dispatchTargets: options.dispatchTargets,
    activityPolicies: options.activityPolicies,
    signalManifest: {
      catalogVersion: 1,
      definitions: [],
      inboxPolicy
    }
  } satisfies PlanStoreV2.PlanArtifact
})

const fixture = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, graphPlan)
  const planArtifact = yield* artifact(compiled, {
    definitionDeploymentId: "workflow-build-1",
    dispatchTargets: {
      worker: {
        queue: "documents",
        deploymentId: "consume-build-1"
      }
    },
    activityPolicies: { worker: policy }
  })
  const plan = yield* DecisionV2.prepare(compiled, planArtifact)
  return { compiled, plan }
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const catalog = (
  workflow = definition,
  handler = consume,
  includeHandler = true
): Deployment.DeploymentCatalog.Service => {
  const result = Deployment.fromEntries({
    workflowDefinitions: [
      Deployment.workflowDefinition("workflow-build-1", workflow)
    ],
    handlerDefinitions: includeHandler
      ? [Deployment.handlerDefinition("consume-build-1", handler)]
      : []
  })
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const options = (
  overrides: Partial<DurableStartV2.Options> = {}
): DurableStartV2.Options => ({
  tenantId: "tenant-1",
  runId: "run-1",
  workflowIdentity: "document:run-1",
  requestId: "request-1",
  ...overrides
})

const prepare = (
  plan: DecisionV2.DecidablePlan<typeof definition>,
  input: Workflow.InputValues<typeof definition>,
  startOptions: DurableStartV2.Options = options(),
  deployments: Deployment.DeploymentCatalog.Service = catalog()
) =>
  DurableStartV2.prepare(plan, input, startOptions).pipe(
    Effect.provideService(Deployment.DeploymentCatalog, deployments)
  )

const preparationFailure = <A>(
  result: Result.Result<A, DurableStartV2.PrepareError>
): DurableStartV2.DurableStartPreparationError => {
  assert.isTrue(Result.isFailure(result))
  assert.instanceOf(
    result.failure,
    DurableStartV2.DurableStartPreparationError
  )
  return result.failure as DurableStartV2.DurableStartPreparationError
}

const emptyPlan = <W extends Workflow.Any>(
  workflow: W,
  definitionDeploymentId: string
) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(workflow, {
      formatVersion: 1,
      id: `${workflow.id}-plan`,
      revision: 1,
      definition: {
        id: workflow.id,
        version: workflow.version
      },
      nodes: [],
      edges: []
    })
    const planArtifact = yield* artifact(compiled, {
      definitionDeploymentId,
      dispatchTargets: {},
      activityPolicies: {}
    })
    return yield* DecisionV2.prepare(compiled, planArtifact)
  })

describe("DurableStartV2", () => {
  it("exposes strict request and preparation-error schemas without event-authority fields", () => {
    const decodeError = Schema.decodeUnknownSync(
      DurableStartV2.DurableStartPreparationError
    )
    const error = decodeError({
      _tag: "DurableStartPreparationError",
      code: DurableStartV2.Codes.InvalidInput,
      message: "Invalid input",
      input: "document",
      details: { input: "document" }
    })
    assert.instanceOf(error, DurableStartV2.DurableStartPreparationError)
    assert.throws(() => decodeError({ ...error, code: "FutureCode" }))
    assert.throws(() => decodeError({ ...error, extra: true }))

    const decodeRequest = Schema.decodeUnknownSync(DurableStartV2.Request)
    const base = {
      startVersion: 2,
      key: { tenantId: "tenant-1", runId: "run-1" },
      workflowIdentity: "workflow:run-1",
      requestId: "request-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifact: {
        artifactVersion: 2,
        executionProtocolVersion: 2,
        fingerprintDocument: {
          fingerprintVersion: 1,
          compilerSemanticVersion: "1",
          plan: {
            formatVersion: 1,
            id: "plan-1",
            revision: 0,
            definition: { id: "workflow-1", version: "1.0.0" },
            nodes: [],
            edges: []
          },
          topologicalOrder: [],
          stages: []
        },
        compiledFingerprint: `sha256:${"b".repeat(64)}`,
        definitionDeploymentId: "workflow-build-1",
        dispatchTargets: {},
        activityPolicies: {},
        signalManifest: {
          catalogVersion: 1,
          definitions: [],
          inboxPolicy
        }
      },
      input: {}
    } as const

    assert.deepStrictEqual(decodeRequest(base), base)
    for (
      const malformed of [
        { ...base, startVersion: 1 },
        { ...base, sequence: 0 },
        { ...base, eventId: "caller-event" },
        { ...base, recordedAt: "2026-07-23T00:00:00.000Z" },
        {
          ...base,
          artifact: {
            ...base.artifact,
            artifactVersion: 1,
            executionProtocolVersion: 1
          }
        }
      ]
    ) {
      assert.throws(() => decodeRequest(malformed))
    }
  })

  it.effect("reuses the exact prepared artifact and returns a detached recursively frozen request", () =>
    Effect.gen(function*() {
      const { plan } = yield* fixture
      const caller = { nested: { value: "before" } }
      const prepared = yield* prepare(plan, { document: caller })
      const wire = prepared.wire
      const document = wire.input.document as Schema.JsonObject

      assert.isTrue(DurableStartV2.isPrepared(prepared))
      assert.isFalse(DurableStartV2.isPrepared({ ...prepared }))
      assert.deepStrictEqual(Object.keys(prepared), ["wire"])
      assert.strictEqual(wire.startVersion, 2)
      assert.deepStrictEqual(wire.key, {
        tenantId: "tenant-1",
        runId: "run-1"
      })
      assert.strictEqual(wire.artifact, plan.artifact)
      assert.strictEqual(wire.artifactDigest, plan.artifactDigest)
      assert.deepStrictEqual(wire.input, {
        document: { nested: { value: "before" } }
      })
      assert.deepStrictEqual(
        Object.keys(wire).sort(),
        [
          "artifact",
          "artifactDigest",
          "input",
          "key",
          "requestId",
          "startVersion",
          "workflowIdentity"
        ].sort()
      )
      for (
        const excluded of [
          "sequence",
          "eventId",
          "recordedAt",
          "causationId",
          "correlationId"
        ]
      ) {
        assert.isFalse(Object.prototype.hasOwnProperty.call(wire, excluded))
      }
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(DurableStartV2.Request)(wire),
        wire
      )

      assert.isTrue(Object.isFrozen(prepared))
      assert.isTrue(Object.isFrozen(wire))
      assert.isTrue(Object.isFrozen(wire.key))
      assert.isTrue(Object.isFrozen(wire.artifact))
      assert.isTrue(Object.isFrozen(wire.artifact.dispatchTargets))
      assert.isTrue(Object.isFrozen(wire.artifact.dispatchTargets.worker))
      assert.isTrue(Object.isFrozen(wire.input))
      assert.isTrue(Object.isFrozen(document))
      assert.isTrue(Object.isFrozen(document.nested))
      assert.notStrictEqual(document, caller)
      assert.notStrictEqual(document.nested, caller.nested)

      caller.nested.value = "after"
      assert.deepStrictEqual(document, { nested: { value: "before" } })
    }))

  it.effect("resolves the workflow and every handler target to exact compiled objects", () =>
    Effect.gen(function*() {
      const { plan } = yield* fixture

      const differentWorkflow = Workflow.make(definition.id, {
        version: definition.version,
        inputs: definition.inputs,
        outputs: definition.outputs,
        nodes: definition.nodes,
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      const workflowMismatch = yield* prepare(
        plan,
        { document: null },
        options(),
        catalog(differentWorkflow)
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(workflowMismatch).code,
        DurableStartV2.Codes.DeploymentMismatch
      )

      const differentHandler = Node.make(consume.type, {
        version: consume.version,
        inputs: consume.inputs,
        outputs: consume.outputs
      })
      const handlerMismatch = yield* prepare(
        plan,
        { document: null },
        options(),
        catalog(definition, differentHandler)
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(handlerMismatch).code,
        DurableStartV2.Codes.DeploymentMismatch
      )

      const missingHandler = yield* prepare(
        plan,
        { document: null },
        options(),
        catalog(definition, consume, false)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingHandler))
      assert.instanceOf(
        missingHandler.failure,
        Deployment.DeploymentNotFound
      )
    }))

  it.effect("rejects forged plans and hostile options or input without invoking accessors", () => {
    let optionReads = 0
    const hostileOptions = options() as unknown as Record<string, unknown>
    Object.defineProperty(hostileOptions, "runId", {
      enumerable: true,
      get() {
        optionReads++
        throw new Error("must not run")
      }
    })
    const trappedOptions = new Proxy(options(), {
      ownKeys() {
        throw new Error("must be contained")
      }
    })

    let inputReads = 0
    const hostileInput = {}
    Object.defineProperty(hostileInput, "document", {
      enumerable: true,
      get() {
        inputReads++
        throw new Error("must not run")
      }
    })
    const trappedInput = new Proxy({ document: null }, {
      ownKeys() {
        throw new Error("must be contained")
      }
    })

    return Effect.gen(function*() {
      const { plan } = yield* fixture
      const copied = { ...plan } as DecisionV2.DecidablePlan<typeof definition>
      const forged = yield* DurableStartV2.prepare(
        copied,
        hostileInput as Workflow.InputValues<typeof definition>,
        hostileOptions as DurableStartV2.Options
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(forged).code,
        DurableStartV2.Codes.InvalidPreparedPlan
      )
      assert.strictEqual(optionReads, 0)
      assert.strictEqual(inputReads, 0)

      for (
        const candidate of [
          hostileOptions,
          trappedOptions,
          { ...options(), extra: true },
          { ...options(), tenantId: "" },
          Object.defineProperty(options(), Symbol("extra"), {
            enumerable: true,
            value: true
          })
        ]
      ) {
        const result = yield* DurableStartV2.prepare(
          plan,
          { document: null },
          candidate as DurableStartV2.Options
        ).pipe(
          Effect.provideService(Deployment.DeploymentCatalog, catalog()),
          Effect.result
        )
        assert.strictEqual(
          preparationFailure(result).code,
          DurableStartV2.Codes.InvalidConfiguration
        )
      }
      assert.strictEqual(optionReads, 0)

      for (
        const candidate of [
          hostileInput,
          trappedInput,
          { document: null, extra: true },
          { document: null, "": true },
          {},
          Object.defineProperty({ document: null }, Symbol("extra"), {
            enumerable: true,
            value: true
          })
        ]
      ) {
        const result = yield* prepare(
          plan,
          candidate as Workflow.InputValues<typeof definition>
        ).pipe(Effect.result)
        assert.strictEqual(
          preparationFailure(result).code,
          DurableStartV2.Codes.InvalidInput
        )
      }
      assert.strictEqual(inputReads, 0)

      const nullPrototype = Object.assign(
        Object.create(null),
        { document: { accepted: true } }
      )
      const accepted = yield* prepare(plan, nullPrototype)
      assert.deepStrictEqual(accepted.wire.input, {
        document: { accepted: true }
      })
    })
  })

  it.effect("freshly encodes every declared input with required Effect services", () => {
    class WirePrefix extends Context.Service<WirePrefix, {
      readonly value: string
    }>()("DurableStartV2Test/WirePrefix") {}

    const NumberWithPrefix = Schema.String.pipe(
      Schema.decodeTo(
        Schema.Number,
        SchemaTransformation.transformOrFail({
          decode: (value) => Effect.succeed(Number(value)),
          encode: (value) =>
            Effect.gen(function*() {
              const prefix = yield* WirePrefix
              return `${prefix.value}${value}`
            })
        })
      )
    )
    const serviceDefinition = Workflow.make("durable-start-v2-service", {
      version: "1.0.0",
      inputs: {
        count: Port.output(NumberWithPrefix, {
          contract: "durable-start-v2/count"
        })
      },
      outputs: {},
      nodes: Registry.make(),
      linkPolicy: LinkPolicy.allowAll,
      limits
    })

    return Effect.gen(function*() {
      const plan = yield* emptyPlan(
        serviceDefinition,
        "service-workflow-build-1"
      )
      const deployments = catalogForWorkflow(
        "service-workflow-build-1",
        serviceDefinition
      )
      const preparedEffect: Effect.Effect<
        DurableStartV2.PreparedStart,
        DurableStartV2.PrepareError,
        WirePrefix | Deployment.DeploymentCatalog
      > = DurableStartV2.prepare(plan, { count: 42 }, options())
      const first = yield* preparedEffect.pipe(
        Effect.provideService(WirePrefix, { value: "wire:" }),
        Effect.provideService(
          Deployment.DeploymentCatalog,
          deployments
        )
      )
      const second = yield* preparedEffect.pipe(
        Effect.provideService(WirePrefix, { value: "fresh:" }),
        Effect.provideService(
          Deployment.DeploymentCatalog,
          deployments
        )
      )

      assert.deepStrictEqual(first.wire.input, { count: "wire:42" })
      assert.deepStrictEqual(second.wire.input, { count: "fresh:42" })
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })

  it.effect("types codec failures and defects while preserving Effect interruption", () => {
    const Defecting = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: Effect.succeed,
          encode: () => Effect.die("codec defect")
        })
      )
    )
    const Interrupting = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: Effect.succeed,
          encode: () => Effect.interrupt
        })
      )
    )
    const dishonestJson = Schema.Unknown as unknown as typeof Schema.Json
    const defectDefinition = inputWorkflow(
      "durable-start-v2-defect",
      Defecting
    )
    const interruptDefinition = inputWorkflow(
      "durable-start-v2-interrupt",
      Interrupting
    )
    const dishonestDefinition = inputWorkflow(
      "durable-start-v2-dishonest",
      dishonestJson
    )

    let emittedGetterReads = 0
    const emitted = {}
    Object.defineProperty(emitted, "secret", {
      enumerable: true,
      get() {
        emittedGetterReads++
        throw new Error("must not run")
      }
    })

    return Effect.gen(function*() {
      const defectPlan = yield* emptyPlan(
        defectDefinition,
        "defect-build"
      )
      const defect = yield* DurableStartV2.prepare(
        defectPlan,
        { value: "input" },
        options()
      ).pipe(
        Effect.provideService(
          Deployment.DeploymentCatalog,
          catalogForWorkflow("defect-build", defectDefinition)
        ),
        Effect.result
      )
      assert.strictEqual(
        preparationFailure(defect).code,
        DurableStartV2.Codes.InvalidInput
      )
      assert.include(
        preparationFailure(defect).message,
        "codec failed unexpectedly"
      )

      const dishonestPlan = yield* emptyPlan(
        dishonestDefinition,
        "dishonest-build"
      )
      const dishonest = yield* DurableStartV2.prepare(
        dishonestPlan,
        { value: emitted as unknown as Schema.Json },
        options()
      ).pipe(
        Effect.provideService(
          Deployment.DeploymentCatalog,
          catalogForWorkflow("dishonest-build", dishonestDefinition)
        ),
        Effect.result
      )
      assert.strictEqual(
        preparationFailure(dishonest).code,
        DurableStartV2.Codes.InvalidInput
      )
      assert.strictEqual(emittedGetterReads, 0)

      const interruptPlan = yield* emptyPlan(
        interruptDefinition,
        "interrupt-build"
      )
      const interrupted = yield* DurableStartV2.prepare(
        interruptPlan,
        { value: "input" },
        options()
      ).pipe(
        Effect.provideService(
          Deployment.DeploymentCatalog,
          catalogForWorkflow("interrupt-build", interruptDefinition)
        ),
        Effect.exit
      )
      assert.isTrue(Exit.isFailure(interrupted))
      if (Exit.isFailure(interrupted)) {
        assert.isTrue(Cause.hasInterrupts(interrupted.cause))
      }
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })

  it.effect("rejects version 1 prepared-plan provenance before inspecting caller input", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, graphPlan)
      const v1Plan = yield* DecisionV1.prepare(compiled)
      let reads = 0
      const hostile = {}
      Object.defineProperty(hostile, "document", {
        enumerable: true,
        get() {
          reads++
          throw new Error("must not run")
        }
      })
      const result = yield* DurableStartV2.prepare(
        v1Plan as unknown as DecisionV2.DecidablePlan<typeof definition>,
        hostile as Workflow.InputValues<typeof definition>,
        options()
      ).pipe(Effect.result)

      assert.strictEqual(
        preparationFailure(result).code,
        DurableStartV2.Codes.InvalidPreparedPlan
      )
      assert.strictEqual(reads, 0)
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})

const catalogForWorkflow = (
  deploymentId: string,
  workflow: Workflow.Any
): Deployment.DeploymentCatalog.Service => {
  const result = Deployment.fromEntries({
    workflowDefinitions: [
      Deployment.workflowDefinition(deploymentId, workflow)
    ],
    handlerDefinitions: []
  })
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const inputWorkflow = <
  S extends Port.PayloadSchema
>(
  id: string,
  schema: S
) =>
  Workflow.make(id, {
    version: "1.0.0",
    inputs: {
      value: Port.output(schema, {
        contract: `${id}/value`
      })
    },
    outputs: {},
    nodes: Registry.make(),
    linkPolicy: LinkPolicy.allowAll,
    limits
  })
