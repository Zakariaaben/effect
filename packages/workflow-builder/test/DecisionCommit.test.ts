import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Command from "../src/Command.ts"
import * as CommandRuntime from "../src/CommandRuntime.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as DecisionCommit from "../src/DecisionCommit.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as Identity from "../src/Identity.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as PlanStore from "../src/PlanStore.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import type * as RunState from "../src/RunState.ts"
import * as Workflow from "../src/Workflow.ts"

const timestamp = "2026-07-23T01:02:03.000Z" as const
const textContract = "decision-commit/text"
const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 16,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const pass = Node.make("Pass", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract: textContract })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: textContract })
  }
})

const definition = Workflow.make("decision-commit-workflow", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(Schema.String, { contract: textContract })
  },
  nodes: Registry.make(pass),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const mismatchDefinition = Workflow.make("decision-commit-output-mismatch", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(Schema.Number, { contract: textContract })
  },
  nodes: Registry.make(pass),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

class OutputDecoder extends Context.Service<OutputDecoder, {
  readonly seen: Array<string>
}>()("@effect/workflow-builder/test/DecisionCommit/OutputDecoder") {}

const ServiceDecodedOutput = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.gen(function*() {
          const decoder = yield* OutputDecoder
          decoder.seen.push(value)
          return value
        }),
      encode: Effect.succeed
    })
  )
)

const serviceOutputDefinition = Workflow.make("decision-commit-output-service", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(ServiceDecodedOutput, { contract: textContract })
  },
  nodes: Registry.make(pass),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const workflowInput = (input: string) => ({ _tag: "WorkflowInput" as const, input })
const nodeOutput = (nodeId: string, output: string) => ({ _tag: "NodeOutput" as const, nodeId, output })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })
const workflowOutput = (output: string) => ({ _tag: "WorkflowOutput" as const, output })

const planInput = {
  formatVersion: 1,
  id: "decision-commit-plan",
  revision: 1,
  definition: { id: definition.id, version: definition.version },
  nodes: [
    { id: "left", type: "Pass", version: "1.0.0", config: {} },
    { id: "right", type: "Pass", version: "1.0.0", config: {} }
  ],
  edges: [
    {
      _tag: "DataEdge" as const,
      id: "seed-left",
      source: workflowInput("seed"),
      target: nodeInput("left", "value")
    },
    {
      _tag: "DataEdge" as const,
      id: "seed-right",
      source: workflowInput("seed"),
      target: nodeInput("right", "value")
    },
    {
      _tag: "DataEdge" as const,
      id: "right-result",
      source: nodeOutput("right", "value"),
      target: workflowOutput("result")
    }
  ]
}

const mismatchPlanInput = {
  ...planInput,
  id: "decision-commit-output-mismatch-plan",
  definition: {
    id: mismatchDefinition.id,
    version: mismatchDefinition.version
  }
}

const serviceOutputPlanInput = {
  ...planInput,
  id: "decision-commit-output-service-plan",
  definition: {
    id: serviceOutputDefinition.id,
    version: serviceOutputDefinition.version
  }
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const output = new Uint8Array(32)
      for (let index = 0; index < data.length; index++) {
        output[index % output.length] = (output[index % output.length]! + data[index]! + index) & 0xff
      }
      return output
    })
})

const preparedPlan = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, planInput)
  return yield* Decision.prepare(compiled)
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const prepare = <W extends Workflow.Any>(workflow: W, input: unknown) =>
  Effect.gen(function*() {
    const compiled = yield* Compiler.compile(workflow, input)
    return yield* Decision.prepare(compiled)
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

const state = (
  plan: Decision.DecidablePlan,
  options: {
    readonly status?: RunState.RunState["status"] | undefined
    readonly activities?: ReadonlyArray<readonly [string, RunState.ActivityState]> | undefined
    readonly pins?: Readonly<Record<string, unknown>> | undefined
  } = {}
): RunState.RunState => {
  const status = options.status ?? "Running"
  const base = {
    runId: "run-1",
    status,
    sequence: 4,
    startedAt: timestamp,
    planId: plan.compiled.plan.id,
    planRevision: plan.compiled.plan.revision,
    definitionId: plan.compiled.definition.id,
    definitionVersion: plan.compiled.definition.version,
    compilerVersion: plan.compilerVersion,
    compiledFingerprint: plan.compiledFingerprint,
    backend: "durable" as const,
    input: { seed: "seed" },
    activities: HashMap.fromIterable(options.activities ?? []),
    seenEventIds: HashSet.empty(),
    ...options.pins
  }
  if (status === "CancellationRequested") {
    return { ...base, status, cancellationRequestedAt: timestamp } as RunState.RunState
  }
  return base as RunState.RunState
}

const activity = (
  nodeId: string,
  status: "Scheduled" | "Succeeded"
): readonly [string, RunState.ActivityState] => {
  const activityId = Command.activityId("run-1", nodeId, 1)
  const base = {
    activityId,
    nodeId,
    nodeInstanceId: nodeId,
    attempt: 1,
    idempotencyKey: Command.activityIdempotencyKey("run-1", nodeId),
    input: { value: "seed" },
    scheduledAt: timestamp
  }
  return status === "Scheduled"
    ? [activityId, { ...base, status }]
    : [activityId, {
      ...base,
      status,
      output: { value: nodeId },
      completedAt: timestamp
    }]
}

const targets = (): Record<string, { queue: string; deploymentId: string }> => ({
  left: { queue: "activities", deploymentId: "workers-v1" },
  right: { queue: "activities", deploymentId: "workers-v1" }
})

const artifactDigest = Schema.decodeUnknownSync(PlanStore.ArtifactDigest)(
  `sha256:${"d".repeat(64)}`
)

const boundPlan = (
  plan: Decision.DecidablePlan,
  overrides: {
    readonly runId?: string | undefined
    readonly fingerprint?: string | undefined
    readonly dispatchTargets?: PlanStore.DispatchTargets | undefined
  } = {}
): PlanStore.BoundPlan => {
  const runId = overrides.runId ?? "run-1"
  return {
    binding: {
      bindingVersion: 1,
      executionProtocolVersion: 1,
      key: { tenantId: "tenant-1", runId },
      artifactDigest,
      workflowIdentity: "decision-commit",
      requestId: "request-1",
      runStartedEventId: Identity.runStartedEventId(runId)
    },
    artifact: {
      artifactVersion: 1,
      executionProtocolVersion: 1,
      fingerprintDocument: Fingerprint.materialize(plan.compiled),
      compiledFingerprint: overrides.fingerprint ?? plan.compiledFingerprint,
      definitionDeploymentId: "orchestrator-v1",
      dispatchTargets: overrides.dispatchTargets ?? targets()
    }
  }
}

const some = (
  option: Option.Option<DecisionCommit.PreparedDecisionCommit>
): DecisionCommit.PreparedDecisionCommit => {
  assert.isTrue(Option.isSome(option))
  return option.value
}

describe("DecisionCommit", () => {
  it.effect("pairs every scheduled event with its exact command and immutable target", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const mutableBoundPlan = boundPlan(plan)
      const prepared = some(yield* DecisionCommit.prepare(plan, state(plan), mutableBoundPlan))
      const wire = prepared.wire

      assert.isTrue(DecisionCommit.isPrepared(prepared))
      assert.strictEqual(wire.commitVersion, 1)
      assert.deepStrictEqual(wire.key, { tenantId: "tenant-1", runId: "run-1" })
      assert.strictEqual(wire.expectedLastSequence, 4)
      assert.lengthOf(wire.events, 2)
      assert.lengthOf(wire.dispatches, 2)

      for (const dispatch of wire.dispatches) {
        const event = wire.events.find((event) => event.eventId === dispatch.sourceEventId)
        assert.isDefined(event)
        assert.strictEqual(dispatch.dispatchVersion, 1)
        assert.strictEqual(dispatch._tag, "Activity")
        assert.strictEqual(dispatch.intentId, dispatch.command.commandId)
        assert.strictEqual(dispatch.sourceEventId, dispatch.command.commandId)
        assert.strictEqual(event.payload._tag, "ActivityScheduled")
        assert.strictEqual(dispatch.command.payload._tag, "ScheduleActivity")
        if (event.payload._tag === "ActivityScheduled") {
          assert.deepStrictEqual(
            {
              ...dispatch.command.payload,
              _tag: "ActivityScheduled"
            },
            event.payload
          )
        }
      }

      ;(mutableBoundPlan.artifact.dispatchTargets.left as { queue: string }).queue = "mutated"
      assert.strictEqual(
        wire.dispatches.find((dispatch) => dispatch.command.payload.nodeId === "left")!.target.queue,
        "activities"
      )
      assert.isTrue(Object.isFrozen(wire))
      assert.isTrue(Object.isFrozen(wire.events))
      assert.isTrue(Object.isFrozen(wire.dispatches))
      assert.isTrue(Object.isFrozen(wire.dispatches[0]))
      assert.isTrue(Object.isFrozen(wire.dispatches[0]!.command))
      assert.isTrue(Object.isFrozen(wire.dispatches[0]!.command.payload))
      assert.isTrue(Object.isFrozen(wire.dispatches[0]!.target))

      const forged = { ...prepared } as DecisionCommit.PreparedDecisionCommit
      assert.isFalse(DecisionCommit.isPrepared(forged))
    }))

  it.effect("emits terminal events without dispatch intents", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const succeeded = some(
        yield* DecisionCommit.prepare(
          plan,
          state(plan, {
            activities: [activity("left", "Succeeded"), activity("right", "Succeeded")]
          }),
          boundPlan(plan)
        )
      )
      assert.strictEqual(succeeded.wire.events[0].payload._tag, "RunSucceeded")
      assert.deepStrictEqual(succeeded.wire.dispatches, [])

      const cancelled = some(
        yield* DecisionCommit.prepare(
          plan,
          state(plan, { status: "CancellationRequested" }),
          boundPlan(plan)
        )
      )
      assert.strictEqual(cancelled.wire.events[0].payload._tag, "RunCancelled")
      assert.deepStrictEqual(cancelled.wire.dispatches, [])
    }))

  it.effect("returns None exactly when the decision has no commands", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const result = yield* DecisionCommit.prepare(
        plan,
        state(plan, {
          activities: [activity("left", "Scheduled"), activity("right", "Scheduled")]
        }),
        boundPlan(plan)
      )
      assert.isTrue(Option.isNone(result))
    }))

  it.effect("requires a strict bound artifact with one valid target for every compiled node", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const cases: ReadonlyArray<
        readonly [PlanStore.DispatchTargets, DecisionCommit.DecisionCommitPreparationErrorCode]
      > = [
        [{ left: targets().left! }, DecisionCommit.Codes.InvalidBoundPlan],
        [{ ...targets(), extra: targets().left! }, DecisionCommit.Codes.InvalidBoundPlan],
        [
          { ...targets(), left: { queue: "", deploymentId: "workers-v1" } },
          DecisionCommit.Codes.InvalidBoundPlan
        ]
      ]

      for (const [dispatchTargets, expectedCode] of cases) {
        const error = yield* DecisionCommit.prepare(
          plan,
          state(plan),
          boundPlan(plan, { dispatchTargets })
        ).pipe(Effect.flip)
        assert.instanceOf(error, DecisionCommit.DecisionCommitPreparationError)
        if (error instanceof DecisionCommit.DecisionCommitPreparationError) {
          assert.strictEqual(error.code, expectedCode)
        }
      }
    }))

  it.effect("rejects hostile bound-plan descriptors without invoking accessors", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      let reads = 0
      const hostile = Object.defineProperty({}, "artifact", {
        enumerable: true,
        get: () => {
          reads++
          return boundPlan(plan).artifact
        }
      })
      Object.defineProperty(hostile, "binding", {
        enumerable: true,
        value: boundPlan(plan).binding
      })

      const error = yield* DecisionCommit.prepare(
        plan,
        state(plan),
        hostile as PlanStore.BoundPlan
      ).pipe(Effect.flip)
      assert.instanceOf(error, DecisionCommit.DecisionCommitPreparationError)
      assert.strictEqual(reads, 0)
    }))

  it.effect("rejects a binding for another run and an artifact for another compiled meaning", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const cases: ReadonlyArray<readonly [PlanStore.BoundPlan, DecisionCommit.DecisionCommitPreparationErrorCode]> = [
        [boundPlan(plan, { runId: "other-run" }), DecisionCommit.Codes.InvalidBoundPlan],
        [
          boundPlan(plan, { fingerprint: `sha256:${"e".repeat(64)}` }),
          DecisionCommit.Codes.ArtifactMismatch
        ]
      ]

      for (const [bound, expectedCode] of cases) {
        const error = yield* DecisionCommit.prepare(plan, state(plan), bound).pipe(Effect.flip)
        assert.instanceOf(error, DecisionCommit.DecisionCommitPreparationError)
        assert.strictEqual(error.code, expectedCode)
      }
    }))

  it.effect("propagates decision identity mismatches", () =>
    Effect.gen(function*() {
      const plan = yield* preparedPlan
      const error = yield* DecisionCommit.prepare(
        plan,
        state(plan, { pins: { planId: "other-plan" } }),
        boundPlan(plan)
      ).pipe(Effect.flip)
      assert.instanceOf(error, Decision.DecisionError)
      if (error instanceof Decision.DecisionError) {
        assert.strictEqual(error.code, Decision.Codes.PlanIdentityMismatch)
      }
    }))

  it.effect("validates successful outputs and provides target decoder services before conversion", () =>
    Effect.gen(function*() {
      const mismatchPlan = yield* prepare(mismatchDefinition, mismatchPlanInput)
      const mismatch = yield* DecisionCommit.prepare(
        mismatchPlan,
        state(mismatchPlan, {
          activities: [activity("left", "Succeeded"), activity("right", "Succeeded")]
        }),
        boundPlan(mismatchPlan)
      ).pipe(Effect.flip)
      assert.instanceOf(mismatch, CommandRuntime.CommandRuntimeError)
      assert.strictEqual(mismatch.code, CommandRuntime.Codes.InvalidWorkflowOutput)
      assert.strictEqual(mismatch.output, "result")

      const servicePlan = yield* prepare(serviceOutputDefinition, serviceOutputPlanInput)
      const decoder = { seen: [] as Array<string> }
      const prepared = some(
        yield* DecisionCommit.prepare(
          servicePlan,
          state(servicePlan, {
            activities: [activity("left", "Succeeded"), activity("right", "Succeeded")]
          }),
          boundPlan(servicePlan)
        ).pipe(Effect.provideService(OutputDecoder, decoder))
      )

      assert.strictEqual(prepared.wire.events[0].payload._tag, "RunSucceeded")
      assert.deepStrictEqual(decoder.seen, ["right"])
    }))
})
