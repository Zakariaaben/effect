import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Deployment from "../src/Deployment.ts"
import * as DurableStart from "../src/DurableStart.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunStart from "../src/RunStart.ts"
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

const jsonContract = "durable-start/json"

const consume = Node.make("Consume", {
  version: "1.0.0",
  inputs: {
    document: Port.input(Schema.Json, { contract: jsonContract })
  },
  outputs: {}
})

const definition = Workflow.make("durable-start-workflow", {
  version: "1.0.0",
  inputs: {
    document: Port.output(Schema.Json, { contract: jsonContract })
  },
  outputs: {},
  nodes: Registry.make(consume),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const deploymentCatalogResult = Deployment.fromEntries({
  workflowDefinitions: [
    Deployment.workflowDefinition("workflow-build-1", definition),
    Deployment.workflowDefinition("workflow-build-2", definition)
  ],
  handlerDefinitions: [
    Deployment.handlerDefinition("consume-build-1", consume),
    Deployment.handlerDefinition("consume-build-2", consume)
  ]
})
if (Result.isFailure(deploymentCatalogResult)) {
  throw deploymentCatalogResult.failure
}
const deploymentCatalog = deploymentCatalogResult.success

const planInput = {
  formatVersion: 1,
  id: "durable-start-plan",
  revision: 3,
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

const preparedPlan = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, planInput)
  return yield* Decision.prepare(compiled)
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const targets = () => ({
  worker: {
    queue: "documents",
    deploymentId: "consume-build-1"
  }
})

const options = (
  overrides: Partial<DurableStart.Options> = {}
): DurableStart.Options => ({
  tenantId: "tenant-1",
  runId: "run-1",
  workflowIdentity: "document-import",
  requestId: "request-1",
  definitionDeploymentId: "workflow-build-1",
  dispatchTargets: targets(),
  ...overrides
})

const prepare = (
  plan: Decision.DecidablePlan<typeof definition>,
  input: Workflow.InputValues<typeof definition>,
  startOptions: DurableStart.Options = options()
) =>
  DurableStart.prepare(plan, input, startOptions).pipe(
    Effect.provideService(Crypto.Crypto, testCrypto),
    Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog)
  )

const durableFailure = <A>(
  result: Result.Result<A, DurableStart.PrepareError>
): DurableStart.DurableStartPreparationError => {
  if (!Result.isFailure(result)) {
    throw new Error("Expected durable start preparation to fail")
  }
  assert.instanceOf(result.failure, DurableStart.DurableStartPreparationError)
  return result.failure as DurableStart.DurableStartPreparationError
}

describe("DurableStart", () => {
  it("exposes strict request and preparation-error schemas", () => {
    const decodeError = Schema.decodeUnknownSync(DurableStart.DurableStartPreparationError)
    const error = decodeError({
      _tag: "DurableStartPreparationError",
      code: DurableStart.Codes.InvalidTargets,
      message: "Invalid targets",
      details: { nodeId: "worker" }
    })

    assert.instanceOf(error, DurableStart.DurableStartPreparationError)
    assert.throws(() => decodeError({ ...error, unexpected: true }))
    assert.throws(() => decodeError({ ...error, code: "FutureError" }))

    const decodeRequest = Schema.decodeUnknownSync(DurableStart.Request)
    const request = decodeRequest({
      startVersion: 1,
      key: { tenantId: "tenant-1", runId: "run-1" },
      workflowIdentity: "identity",
      requestId: "request",
      artifactDigest: `sha256:${"0".repeat(64)}`,
      artifact: {
        artifactVersion: 1,
        executionProtocolVersion: 1,
        fingerprintDocument: {
          fingerprintVersion: Fingerprint.FingerprintVersion,
          compilerSemanticVersion: Fingerprint.CompilerSemanticVersion,
          plan: {
            formatVersion: 1,
            id: "plan",
            revision: 0,
            definition: { id: "workflow", version: "1" },
            nodes: [],
            edges: []
          },
          topologicalOrder: [],
          stages: []
        },
        compiledFingerprint: `sha256:${"1".repeat(64)}`,
        definitionDeploymentId: "workflow-build",
        dispatchTargets: {}
      },
      input: {}
    })

    assert.deepStrictEqual(decodeRequest(request), request)
    assert.throws(() => decodeRequest({ ...request, unexpected: true }))
    assert.throws(() =>
      decodeRequest({
        ...request,
        artifact: { ...request.artifact, runId: "not-reusable" }
      })
    )
  })

  it.effect("constructs the exact detached and recursively frozen request", () => {
    const callerDocument = { nested: { value: "before" } }
    const callerTargets = targets()
    const callerOptions = options({ dispatchTargets: callerTargets })

    return Effect.gen(function*() {
      const plan = yield* preparedPlan
      const prepared = yield* prepare(plan, { document: callerDocument }, callerOptions)
      const wire = prepared.wire
      const artifact = wire.artifact
      const encodedDocument = wire.input.document as Schema.JsonObject

      assert.isTrue(DurableStart.isPrepared(prepared))
      assert.isFalse(DurableStart.isPrepared({ ...prepared }))
      assert.deepStrictEqual(Object.keys(prepared), ["wire"])
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
      assert.deepStrictEqual(wire.key, {
        tenantId: "tenant-1",
        runId: "run-1"
      })
      assert.strictEqual(wire.startVersion, 1)
      assert.strictEqual(wire.workflowIdentity, "document-import")
      assert.strictEqual(wire.requestId, "request-1")
      assert.deepStrictEqual(wire.input, {
        document: { nested: { value: "before" } }
      })
      assert.deepStrictEqual(artifact, {
        artifactVersion: 1,
        executionProtocolVersion: 1,
        fingerprintDocument: Fingerprint.materialize(plan.compiled),
        compiledFingerprint: plan.compiledFingerprint,
        definitionDeploymentId: "workflow-build-1",
        dispatchTargets: {
          worker: {
            queue: "documents",
            deploymentId: "consume-build-1"
          }
        }
      })
      assert.deepStrictEqual(
        Object.keys(artifact).sort(),
        [
          "artifactVersion",
          "compiledFingerprint",
          "definitionDeploymentId",
          "dispatchTargets",
          "fingerprintDocument",
          "executionProtocolVersion"
        ].sort()
      )
      for (
        const excluded of [
          "tenantId",
          "runId",
          "workflowIdentity",
          "requestId",
          "input"
        ]
      ) {
        assert.isFalse(Object.prototype.hasOwnProperty.call(artifact, excluded))
      }

      const digest = yield* Fingerprint.digest(artifact as unknown as Schema.Json)
      assert.strictEqual(wire.artifactDigest, digest)
      assert.deepStrictEqual(Schema.decodeUnknownSync(DurableStart.Request)(wire), wire)

      assert.isTrue(Object.isFrozen(prepared))
      assert.isTrue(Object.isFrozen(wire))
      assert.isTrue(Object.isFrozen(wire.key))
      assert.isTrue(Object.isFrozen(wire.input))
      assert.isTrue(Object.isFrozen(encodedDocument))
      assert.isTrue(Object.isFrozen(encodedDocument.nested))
      assert.isTrue(Object.isFrozen(artifact))
      assert.isTrue(Object.isFrozen(artifact.fingerprintDocument))
      assert.isTrue(Object.isFrozen(artifact.fingerprintDocument.plan))
      assert.isTrue(Object.isFrozen(artifact.fingerprintDocument.plan.nodes))
      assert.isTrue(Object.isFrozen(artifact.fingerprintDocument.topologicalOrder))
      assert.isTrue(Object.isFrozen(artifact.fingerprintDocument.stages))
      assert.isTrue(Object.isFrozen(artifact.dispatchTargets))
      assert.isTrue(Object.isFrozen(artifact.dispatchTargets.worker))

      assert.notStrictEqual(artifact.dispatchTargets, callerTargets)
      assert.notStrictEqual(artifact.dispatchTargets.worker, callerTargets.worker)
      assert.notStrictEqual(encodedDocument, callerDocument)
      assert.notStrictEqual(encodedDocument.nested, callerDocument.nested)

      callerTargets.worker.queue = "mutated"
      callerDocument.nested.value = "after"
      assert.strictEqual(artifact.dispatchTargets.worker.queue, "documents")
      assert.deepStrictEqual(encodedDocument, { nested: { value: "before" } })
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })

  it.effect("hashes deployment and routing pins but excludes run identity and input", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const base = yield* prepare(plan, { document: { value: "one" } })
      const sameArtifact = yield* prepare(
        plan,
        { document: { value: "two" } },
        options({
          tenantId: "tenant-2",
          runId: "run-2",
          workflowIdentity: "another-identity",
          requestId: "request-2"
        })
      )
      const changedQueue = yield* prepare(
        plan,
        { document: { value: "one" } },
        options({
          dispatchTargets: {
            worker: {
              queue: "priority-documents",
              deploymentId: "consume-build-1"
            }
          }
        })
      )
      const changedHandlerBuild = yield* prepare(
        plan,
        { document: { value: "one" } },
        options({
          dispatchTargets: {
            worker: {
              queue: "documents",
              deploymentId: "consume-build-2"
            }
          }
        })
      )
      const changedWorkflowBuild = yield* prepare(
        plan,
        { document: { value: "one" } },
        options({ definitionDeploymentId: "workflow-build-2" })
      )

      assert.strictEqual(base.wire.artifactDigest, sameArtifact.wire.artifactDigest)
      assert.notStrictEqual(base.wire.artifactDigest, changedQueue.wire.artifactDigest)
      assert.notStrictEqual(base.wire.artifactDigest, changedHandlerBuild.wire.artifactDigest)
      assert.notStrictEqual(base.wire.artifactDigest, changedWorkflowBuild.wire.artifactDigest)

      for (
        const candidate of [
          sameArtifact,
          changedQueue,
          changedHandlerBuild,
          changedWorkflowBuild
        ]
      ) {
        assert.strictEqual(
          candidate.wire.artifact.compiledFingerprint,
          base.wire.artifact.compiledFingerprint
        )
        assert.deepStrictEqual(
          candidate.wire.artifact.fingerprintDocument,
          base.wire.artifact.fingerprintDocument
        )
      }
    }))

  it.effect("requires dispatch target keys to exactly match every compiled node", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const cases: ReadonlyArray<readonly [unknown, DurableStart.DurableStartPreparationErrorCode]> = [
        [{}, DurableStart.Codes.TargetKeyMismatch],
        [
          {
            ...targets(),
            extra: { queue: "extra", deploymentId: "extra-build" }
          },
          DurableStart.Codes.TargetKeyMismatch
        ],
        [
          { worker: { queue: "", deploymentId: "consume-build-1" } },
          DurableStart.Codes.InvalidTargets
        ],
        [
          {
            worker: {
              queue: "documents",
              deploymentId: "consume-build-1",
              capacity: 10
            }
          },
          DurableStart.Codes.InvalidTargets
        ]
      ]

      for (const [dispatchTargets, code] of cases) {
        const result = yield* Effect.result(
          prepare(
            plan,
            { document: null },
            options({
              dispatchTargets: dispatchTargets as PlanStore.DispatchTargets
            })
          )
        )
        assert.strictEqual(durableFailure(result).code, code)
      }
    }))

  it.effect("requires every deployment pin to resolve to the compiler's exact definitions", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan

      const missingWorkflow = yield* Effect.result(prepare(
        plan,
        { document: null },
        options({ definitionDeploymentId: "missing-workflow-build" })
      ))
      assert.isTrue(Result.isFailure(missingWorkflow))
      assert.instanceOf(missingWorkflow.failure, Deployment.DeploymentNotFound)

      const missingHandler = yield* Effect.result(prepare(
        plan,
        { document: null },
        options({
          dispatchTargets: {
            worker: { queue: "documents", deploymentId: "missing-handler-build" }
          }
        })
      ))
      assert.isTrue(Result.isFailure(missingHandler))
      assert.instanceOf(missingHandler.failure, Deployment.DeploymentNotFound)

      const differentWorkflow = Workflow.make("durable-start-workflow", {
        version: "1.0.0",
        inputs: {
          document: Port.output(Schema.Json, { contract: jsonContract })
        },
        outputs: {},
        nodes: Registry.make(consume),
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      const workflowMismatchCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition("workflow-build-1", differentWorkflow)
        ],
        handlerDefinitions: [
          Deployment.handlerDefinition("consume-build-1", consume)
        ]
      })
      const workflowMismatch = yield* DurableStart.prepare(
        plan,
        { document: null },
        options()
      ).pipe(
        Effect.provideService(Crypto.Crypto, testCrypto),
        Effect.provideService(Deployment.DeploymentCatalog, workflowMismatchCatalog),
        Effect.result
      )
      assert.strictEqual(
        durableFailure(workflowMismatch).code,
        DurableStart.Codes.DeploymentMismatch
      )

      const differentConsume = Node.make("Consume", {
        version: "1.0.0",
        inputs: {
          document: Port.input(Schema.Json, { contract: jsonContract })
        },
        outputs: {}
      })
      const handlerMismatchCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition("workflow-build-1", definition)
        ],
        handlerDefinitions: [
          Deployment.handlerDefinition("consume-build-1", differentConsume)
        ]
      })
      const handlerMismatch = yield* DurableStart.prepare(
        plan,
        { document: null },
        options()
      ).pipe(
        Effect.provideService(Crypto.Crypto, testCrypto),
        Effect.provideService(Deployment.DeploymentCatalog, handlerMismatchCatalog),
        Effect.result
      )
      assert.strictEqual(
        durableFailure(handlerMismatch).code,
        DurableStart.Codes.DeploymentMismatch
      )
    }))

  it.effect("rejects forged plans and hostile options without invoking getters", () => {
    let optionGetterReads = 0
    const accessorOptions = options() as unknown as Record<string, unknown>
    Object.defineProperty(accessorOptions, "runId", {
      enumerable: true,
      get: () => {
        optionGetterReads++
        return "hostile-run"
      }
    })

    let targetGetterReads = 0
    const accessorTarget = {}
    Object.defineProperty(accessorTarget, "queue", {
      enumerable: true,
      get: () => {
        targetGetterReads++
        return "hostile-queue"
      }
    })
    Object.defineProperty(accessorTarget, "deploymentId", {
      enumerable: true,
      value: "consume-build-1"
    })
    const nestedAccessorOptions = options({
      dispatchTargets: {
        worker: accessorTarget as PlanStore.DispatchTarget
      }
    })

    const trappedOptions = new Proxy(options(), {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap")
      }
    })

    let forgedOptionGetterReads = 0
    const forgedOptions = {}
    Object.defineProperty(forgedOptions, "runId", {
      enumerable: true,
      get: () => {
        forgedOptionGetterReads++
        return "must-not-be-read"
      }
    })

    return Effect.gen(function*() {
      const plan = yield* preparedPlan
      const copied = { ...plan } as Decision.DecidablePlan<typeof definition>
      const forged = yield* Effect.result(
        DurableStart.prepare(
          copied,
          { document: null },
          forgedOptions as DurableStart.Options
        ).pipe(
          Effect.provideService(Crypto.Crypto, testCrypto),
          Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog)
        )
      )
      const forgedError = durableFailure(forged)
      assert.strictEqual(forgedError.code, DurableStart.Codes.InvalidConfiguration)
      assert.include(forgedError.message, "Decision.prepare")
      assert.strictEqual(forgedOptionGetterReads, 0)

      const hostileCases = [
        accessorOptions,
        nestedAccessorOptions,
        trappedOptions,
        { ...options(), extra: true },
        { ...options(), tenantId: "" },
        Object.defineProperty(options(), Symbol("extra"), {
          enumerable: true,
          value: true
        })
      ]
      for (const candidate of hostileCases) {
        const result = yield* Effect.result(
          prepare(
            plan,
            { document: null },
            candidate as DurableStart.Options
          )
        )
        assert.strictEqual(
          durableFailure(result).code,
          DurableStart.Codes.InvalidConfiguration
        )
      }
      assert.strictEqual(optionGetterReads, 0)
      assert.strictEqual(targetGetterReads, 0)

      const nullPrototypeOptions = Object.assign(Object.create(null), options())
      const accepted = yield* prepare(
        plan,
        { document: null },
        nullPrototypeOptions
      )
      assert.strictEqual(accepted.wire.key.runId, "run-1")
    })
  })

  it.effect("delegates hostile input handling to RunStart without invoking getters", () => {
    let getterReads = 0
    const hostileInput = {}
    Object.defineProperty(hostileInput, "document", {
      enumerable: true,
      get: () => {
        getterReads++
        return null
      }
    })

    return Effect.gen(function*() {
      const plan = yield* preparedPlan
      const result = yield* Effect.result(
        prepare(plan, hostileInput as Workflow.InputValues<typeof definition>)
      )

      if (!Result.isFailure(result)) {
        throw new Error("Expected hostile workflow input to fail")
      }
      assert.instanceOf(result.failure, RunStart.RunStartError)
      assert.strictEqual((result.failure as RunStart.RunStartError).code, RunStart.Codes.InvalidInput)
      assert.strictEqual(getterReads, 0)
    })
  })

  it.effect("retains workflow input encoding services in the prepare type", () => {
    class WirePrefix extends Context.Service<WirePrefix, {
      readonly value: string
    }>()("DurableStartTest/WirePrefix") {}

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
    const serviceDefinition = Workflow.make("durable-start-service", {
      version: "1.0.0",
      inputs: {
        count: Port.output(NumberWithPrefix, { contract: "durable-start/count" })
      },
      outputs: {},
      nodes: Registry.make(),
      linkPolicy: LinkPolicy.allowAll,
      limits
    })

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(serviceDefinition, {
        formatVersion: 1,
        id: "durable-start-service-plan",
        revision: 1,
        definition: {
          id: serviceDefinition.id,
          version: serviceDefinition.version
        },
        nodes: [],
        edges: []
      })
      const plan = yield* Decision.prepare(compiled)
      const preparedEffect: Effect.Effect<
        DurableStart.PreparedStart,
        DurableStart.PrepareError,
        WirePrefix | Crypto.Crypto | Deployment.DeploymentCatalog
      > = DurableStart.prepare(plan, { count: 42 }, {
        tenantId: "tenant-1",
        runId: "service-run",
        workflowIdentity: "service-workflow",
        requestId: "service-request",
        definitionDeploymentId: "service-build-1",
        dispatchTargets: {}
      })
      const serviceCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition("service-build-1", serviceDefinition)
        ],
        handlerDefinitions: []
      })
      const prepared = yield* preparedEffect.pipe(
        Effect.provideService(WirePrefix, { value: "wire:" }),
        Effect.provideService(Deployment.DeploymentCatalog, serviceCatalog)
      )

      assert.deepStrictEqual(prepared.wire.input, { count: "wire:42" })
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })

  it.effect("propagates hash failures and preserves hash interruption", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const hashError = PlatformError.badArgument({
        module: "DurableStartTest",
        method: "digest",
        description: "hash unavailable"
      })
      const failingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(hashError)
      })
      const failed = yield* DurableStart.prepare(
        plan,
        { document: null },
        options()
      ).pipe(
        Effect.provideService(Crypto.Crypto, failingCrypto),
        Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog),
        Effect.result
      )

      if (!Result.isFailure(failed)) {
        throw new Error("Expected hash failure to propagate")
      }
      assert.strictEqual(failed.failure, hashError)

      const interruptingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.interrupt
      })
      const interrupted = yield* DurableStart.prepare(
        plan,
        { document: null },
        options()
      ).pipe(
        Effect.provideService(Crypto.Crypto, interruptingCrypto),
        Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog),
        Effect.exit
      )
      if (!Exit.isFailure(interrupted)) {
        throw new Error("Expected hash interruption")
      }
      assert.isTrue(Cause.hasInterrupts(interrupted.cause))
    }))

  it.effect("rejects a prepared fingerprint that does not match the active hash service", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const differentCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.succeed(new Uint8Array(32).fill(0xff))
      })
      const result = yield* DurableStart.prepare(
        plan,
        { document: null },
        options()
      ).pipe(
        Effect.provideService(Crypto.Crypto, differentCrypto),
        Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog),
        Effect.result
      )

      assert.strictEqual(
        durableFailure(result).code,
        DurableStart.Codes.FingerprintMismatch
      )
    }))
})
