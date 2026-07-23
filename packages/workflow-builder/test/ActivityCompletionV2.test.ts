import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as ActivityCompletionV2 from "../src/ActivityCompletionV2.ts"
import type * as ActivityPolicy from "../src/ActivityPolicy.ts"
import * as Compiler from "../src/Compiler.ts"
import * as DecisionV2 from "../src/DecisionV2.ts"
import * as DigestV2 from "../src/DigestV2.ts"
import type * as EventV2 from "../src/EventV2.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as IdentityV2 from "../src/IdentityV2.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import type * as PlanStoreV2 from "../src/PlanStoreV2.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunStateV2 from "../src/RunStateV2.ts"
import * as Workflow from "../src/Workflow.ts"

const tenantId = "tenant-completion-v2"
const runId = "run-completion-v2"
const nodeId = "task"
const contract = "activity-completion-v2/text"
const epoch = Date.parse("2026-07-23T00:00:00.000Z")
const time = (millis: number): EventV2.Timestamp => new Date(epoch + millis).toISOString()

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const task = Node.make("ActivityCompletionV2Task", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract })
  },
  outputs: {
    value: Port.output(Schema.String, { contract })
  },
  failure: Schema.String
})

const definition = Workflow.make("activity-completion-v2", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.String, { contract })
  },
  outputs: {
    value: Port.input(Schema.String, { contract })
  },
  nodes: Registry.make(task),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const graph = (
  workflow: Workflow.Any,
  node: Node.Any,
  id: string
) => ({
  formatVersion: 1,
  id,
  revision: 1,
  definition: {
    id: workflow.id,
    version: workflow.version
  },
  nodes: [{
    id: nodeId,
    type: node.type,
    version: node.version,
    config: {}
  }],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "workflow-task",
      source: {
        _tag: "WorkflowInput" as const,
        input: "value"
      },
      target: {
        _tag: "NodeInput" as const,
        nodeId,
        input: "value"
      }
    },
    {
      _tag: "DataEdge" as const,
      id: "task-workflow",
      source: {
        _tag: "NodeOutput" as const,
        nodeId,
        output: "value"
      },
      target: {
        _tag: "WorkflowOutput" as const,
        output: "value"
      }
    }
  ]
})

const graphPlan = graph(
  definition,
  task,
  "activity-completion-v2-plan"
)

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

const activityPolicy: ActivityPolicy.Policy = {
  policyVersion: 1,
  retry: {
    retryVersion: 1,
    maximumAttempts: 1,
    classifierVersion: 1,
    retryOn: {
      encodedFailure: false,
      scheduleToStartTimeout: false,
      startToCloseTimeout: false
    },
    backoff: {
      _tag: "Fixed",
      delayMillis: 1_000
    },
    jitter: { _tag: "None" }
  },
  timeouts: {
    scheduleToStart: { _tag: "Disabled" },
    startToClose: { _tag: "Disabled" },
    scheduleToClose: { _tag: "Disabled" }
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

const fixture = Effect.fnUntraced(function*<W extends Workflow.Any>(
  workflow: W,
  node: Node.Any,
  planInput: unknown
) {
  const compiled = yield* Compiler.compile(workflow, planInput)
  const fingerprintDocument = Fingerprint.materialize(compiled)
  const compiledFingerprint = yield* DigestV2.compiledPlan(
    fingerprintDocument as unknown as Schema.Json
  )
  const artifact: PlanStoreV2.PlanArtifact = {
    artifactVersion: 2,
    executionProtocolVersion: 2,
    fingerprintDocument,
    compiledFingerprint,
    definitionDeploymentId: `${workflow.id}-build`,
    dispatchTargets: {
      [nodeId]: {
        queue: "activity-completion-v2",
        deploymentId: `${node.type}-build`
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
  const plan = yield* DecisionV2.prepare(compiled, artifact)
  return { artifact, compiled, plan }
})

const primaryFixture = () => fixture(definition, task, graphPlan)

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(
    Result.isSuccess(result),
    Result.isFailure(result) ? String(result.failure) : undefined
  )
  return result.success
}

const event = (
  sequence: number,
  eventId: string,
  payload: EventV2.Payload
): EventV2.Event => ({
  eventVersion: 2,
  tenantId,
  eventId,
  runId,
  sequence,
  recordedAt: time(sequence * 100),
  payload
})

const logicalActivityId = IdentityV2.logicalActivityId(
  tenantId,
  runId,
  nodeId
)
const attemptId = IdentityV2.activityAttemptId(
  tenantId,
  runId,
  nodeId,
  1
)

const history = (
  plan: DecisionV2.DecidablePlan
): ReadonlyArray<EventV2.Event> => [
  event(
    0,
    IdentityV2.runStartedEventId(tenantId, runId),
    {
      _tag: "RunStarted",
      executionProtocolVersion: 2,
      artifactVersion: 2,
      artifactDigest: plan.artifactDigest,
      workflowIdentity: "activity-completion-v2:seed",
      startRequestId: "start-completion-v2",
      planId: plan.compiled.plan.id,
      planRevision: plan.compiled.plan.revision,
      definitionId: plan.compiled.definition.id,
      definitionVersion: plan.compiled.definition.version,
      compilerVersion: plan.compilerVersion,
      compiledFingerprint: plan.compiledFingerprint,
      backend: "durable",
      input: { value: "seed" }
    }
  ),
  event(
    1,
    IdentityV2.scheduleActivityCommandId(
      tenantId,
      runId,
      nodeId,
      1
    ),
    {
      _tag: "ActivityScheduled",
      logicalActivityId,
      attemptId,
      nodeId,
      nodeInstanceId: nodeId,
      attempt: 1,
      idempotencyKey: IdentityV2.activityIdempotencyKey(
        tenantId,
        runId,
        nodeId
      ),
      input: { value: "seed" },
      policy: activityPolicy
    }
  ),
  event(
    2,
    IdentityV2.activityAttemptStartedEventId(
      tenantId,
      runId,
      nodeId,
      1
    ),
    {
      _tag: "ActivityAttemptStarted",
      logicalActivityId,
      attemptId,
      attempt: 1
    }
  )
]

const startedState = (
  plan: DecisionV2.DecidablePlan
): RunStateV2.RunState => success(RunStateV2.fold(history(plan)))

const completion = (
  value:
    | { readonly _tag: "Succeeded"; readonly output: Readonly<Record<string, Schema.Json>> }
    | { readonly _tag: "Failed"; readonly failure: Schema.Json },
  overrides: {
    readonly tenantId?: string
    readonly runId?: string
    readonly logicalActivityId?: string
    readonly attemptId?: string
    readonly attempt?: number
  } = {}
) => ({
  key: {
    tenantId: overrides.tenantId ?? tenantId,
    runId: overrides.runId ?? runId
  },
  logicalActivityId: overrides.logicalActivityId ?? logicalActivityId,
  attemptId: overrides.attemptId ?? attemptId,
  attempt: overrides.attempt ?? 1,
  completion: value
})

const preparationFailure = (
  result: Result.Result<
    ActivityCompletionV2.PreparedCompletion,
    ActivityCompletionV2.ActivityCompletionError
  >
): ActivityCompletionV2.ActivityCompletionError => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

describe("ActivityCompletionV2", () => {
  it.effect("admits valid success and failure capabilities with exact associations", () =>
    Effect.gen(function*() {
      const { artifact, compiled, plan } = yield* primaryFixture()
      const state = startedState(plan)
      const succeeded = yield* ActivityCompletionV2.prepare(
        plan,
        state,
        completion({
          _tag: "Succeeded",
          output: { value: "done" }
        })
      )
      const failed = yield* ActivityCompletionV2.prepare(
        plan,
        state,
        completion({
          _tag: "Failed",
          failure: "application failure"
        })
      )

      assert.isTrue(ActivityCompletionV2.isPrepared(succeeded))
      assert.isTrue(ActivityCompletionV2.isPrepared(failed))
      assert.isTrue(Object.isFrozen(succeeded))
      assert.isTrue(Object.isFrozen(succeeded.wire))
      assert.isTrue(Object.isFrozen(succeeded.wire.completion))
      assert.strictEqual(succeeded.expectedSequence, state.sequence)
      assert.strictEqual(
        success(ActivityCompletionV2.resolve(plan, state, succeeded)),
        succeeded.wire
      )

      const copied = { ...succeeded }
      const copiedResult = ActivityCompletionV2.resolve(plan, state, copied)
      assert.isTrue(Result.isFailure(copiedResult))
      assert.strictEqual(
        copiedResult.failure.code,
        ActivityCompletionV2.Codes.InvalidPreparedCompletion
      )

      const secondPlan = yield* DecisionV2.prepare(compiled, artifact)
      const planResult = ActivityCompletionV2.resolve(
        secondPlan,
        state,
        succeeded
      )
      assert.isTrue(Result.isFailure(planResult))
      assert.strictEqual(
        planResult.failure.code,
        ActivityCompletionV2.Codes.PreparedPlanMismatch
      )

      const replayed = startedState(plan)
      assert.notStrictEqual(replayed, state)
      const stateResult = ActivityCompletionV2.resolve(
        plan,
        replayed,
        succeeded
      )
      assert.isTrue(Result.isFailure(stateResult))
      assert.strictEqual(
        stateResult.failure.code,
        ActivityCompletionV2.Codes.PreparedStateMismatch
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("rejects wrong output values and non-exact port sets", () =>
    Effect.gen(function*() {
      const { plan } = yield* primaryFixture()
      const state = startedState(plan)
      const candidates = [
        { value: 42 },
        {},
        { value: "done", extra: true }
      ]
      for (const output of candidates) {
        const result = yield* ActivityCompletionV2.prepare(
          plan,
          state,
          completion({ _tag: "Succeeded", output })
        ).pipe(Effect.result)
        assert.strictEqual(
          preparationFailure(result).code,
          ActivityCompletionV2.Codes.InvalidOutput
        )
      }

      const failed = yield* ActivityCompletionV2.prepare(
        plan,
        state,
        completion({ _tag: "Failed", failure: 42 })
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(failed).code,
        ActivityCompletionV2.Codes.InvalidFailure
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("requires the exact run, attempt, lifecycle, plan, and reducer state", () =>
    Effect.gen(function*() {
      const { plan } = yield* primaryFixture()
      const state = startedState(plan)
      const successOutput = {
        _tag: "Succeeded" as const,
        output: { value: "done" }
      }
      const cases: ReadonlyArray<
        readonly [
          unknown,
          ActivityCompletionV2.ActivityCompletionErrorCode
        ]
      > = [
        [
          completion(successOutput, { runId: "other-run" }),
          ActivityCompletionV2.Codes.RunKeyMismatch
        ],
        [
          completion(successOutput, {
            logicalActivityId: "other-activity"
          }),
          ActivityCompletionV2.Codes.ActivityNotFound
        ],
        [
          completion(successOutput, { attemptId: "other-attempt" }),
          ActivityCompletionV2.Codes.AttemptMismatch
        ],
        [
          completion(successOutput, { attempt: 2 }),
          ActivityCompletionV2.Codes.AttemptMismatch
        ]
      ]
      for (const [request, code] of cases) {
        const result = yield* ActivityCompletionV2.prepare(
          plan,
          state,
          request
        ).pipe(Effect.result)
        assert.strictEqual(preparationFailure(result).code, code)
      }

      const scheduled = success(RunStateV2.fold(history(plan).slice(0, 2)))
      const lifecycle = yield* ActivityCompletionV2.prepare(
        plan,
        scheduled,
        completion(successOutput)
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(lifecycle).code,
        ActivityCompletionV2.Codes.IllegalActivityTransition
      )

      const forgedState = { ...state }
      const stateFailure = yield* ActivityCompletionV2.prepare(
        plan,
        forgedState,
        completion(successOutput)
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(stateFailure).code,
        ActivityCompletionV2.Codes.InvalidRunState
      )

      const forgedPlan = { ...plan } as typeof plan
      const planFailure = yield* ActivityCompletionV2.prepare(
        forgedPlan,
        state,
        completion(successOutput)
      ).pipe(Effect.result)
      assert.strictEqual(
        preparationFailure(planFailure).code,
        ActivityCompletionV2.Codes.InvalidPreparedPlan
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("validates success and failure schemas in imported durable state", () =>
    Effect.gen(function*() {
      const { plan } = yield* primaryFixture()
      const base = history(plan)
      const succeeded = (output: Schema.Json): RunStateV2.RunState =>
        success(RunStateV2.fold([
          ...base,
          event(
            3,
            IdentityV2.activitySucceededEventId(
              tenantId,
              runId,
              nodeId,
              1
            ),
            {
              _tag: "ActivitySucceeded",
              logicalActivityId,
              attemptId,
              attempt: 1,
              output: { value: output }
            }
          )
        ]))
      const failed = (failure: Schema.Json): RunStateV2.RunState =>
        success(RunStateV2.fold([
          ...base,
          event(
            3,
            IdentityV2.activityAttemptFailedEventId(
              tenantId,
              runId,
              nodeId,
              1
            ),
            {
              _tag: "ActivityAttemptFailed",
              logicalActivityId,
              attemptId,
              attempt: 1,
              failure
            }
          )
        ]))

      const validSucceeded = succeeded("valid")
      assert.strictEqual(
        yield* ActivityCompletionV2.validateState(plan, validSucceeded),
        validSucceeded
      )
      yield* ActivityCompletionV2.validateState(plan, failed("valid"))

      const invalidOutput = yield* ActivityCompletionV2.validateState(
        plan,
        succeeded(42)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalidOutput))
      assert.strictEqual(
        invalidOutput.failure.code,
        ActivityCompletionV2.Codes.InvalidOutput
      )

      const invalidFailure = yield* ActivityCompletionV2.validateState(
        plan,
        failed(42)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalidFailure))
      assert.strictEqual(
        invalidFailure.failure.code,
        ActivityCompletionV2.Codes.InvalidFailure
      )
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("retains Effect Schema decoding-service requirements", () => {
    class DecodePrefix extends Context.Service<DecodePrefix, string>()(
      "ActivityCompletionV2Test/DecodePrefix"
    ) {}

    const ServiceDecoded = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: (value) =>
            Effect.gen(function*() {
              const prefix = yield* DecodePrefix
              return `${prefix}:${value}`
            }),
          encode: Effect.succeed
        })
      )
    )
    const serviceTask = Node.make("ActivityCompletionV2ServiceTask", {
      version: "1.0.0",
      inputs: {
        value: Port.input(Schema.String, { contract })
      },
      outputs: {
        value: Port.output(ServiceDecoded, { contract })
      },
      failure: Schema.String
    })
    const serviceDefinition = Workflow.make(
      "activity-completion-v2-service",
      {
        version: "1.0.0",
        inputs: {
          value: Port.output(Schema.String, { contract })
        },
        outputs: {
          value: Port.input(Schema.String, { contract })
        },
        nodes: Registry.make(serviceTask),
        linkPolicy: LinkPolicy.allowAll,
        limits
      }
    )
    const serviceGraph = graph(
      serviceDefinition,
      serviceTask,
      "activity-completion-v2-service-plan"
    )

    return Effect.gen(function*() {
      const { plan } = yield* fixture(
        serviceDefinition,
        serviceTask,
        serviceGraph
      )
      const state = startedState(plan)
      const admission: Effect.Effect<
        ActivityCompletionV2.PreparedCompletion,
        ActivityCompletionV2.ActivityCompletionError,
        DecodePrefix
      > = ActivityCompletionV2.prepare(
        plan,
        state,
        completion({
          _tag: "Succeeded",
          output: { value: "encoded" }
        })
      )
      const prepared = yield* admission.pipe(
        Effect.provideService(DecodePrefix, "decoded")
      )
      assert.isTrue(ActivityCompletionV2.isPrepared(prepared))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
  })
})
