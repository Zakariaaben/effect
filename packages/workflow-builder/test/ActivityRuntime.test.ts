import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as ActivityRuntime from "../src/ActivityRuntime.ts"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

class RequestPrefix extends Context.Service<RequestPrefix, string>()(
  "@effect/workflow-builder/test/ActivityRuntime/RequestPrefix"
) {}

class CapturedSuffix extends Context.Service<CapturedSuffix, string>()(
  "@effect/workflow-builder/test/ActivityRuntime/CapturedSuffix"
) {}

const limits = new Workflow.Limits({
  maxNodes: 16,
  maxEdges: 32,
  maxFanIn: 8,
  maxFanOut: 8,
  maxDepth: 8
})

const domainFailure = Schema.Struct({
  _tag: Schema.Literal("DomainFailure"),
  reason: Schema.String
})

const activity = Node.make("Activity", {
  version: "1.0.0",
  config: Schema.Struct({ factor: Schema.FiniteFromString }),
  inputs: {
    value: Port.input(Schema.FiniteFromString, {
      contract: "example/number",
      cardinality: "one",
      required: true
    }),
    note: Port.input(Schema.String, {
      contract: "example/text",
      cardinality: "one",
      required: false
    }),
    values: Port.input(Schema.FiniteFromString, {
      contract: "example/number",
      cardinality: "many",
      required: true
    })
  },
  outputs: {
    result: Port.output(Schema.FiniteFromString, { contract: "example/number" }),
    metadata: Port.output(Schema.Json, { contract: "example/json" })
  },
  failure: domainFailure,
  dependencies: [RequestPrefix]
})

const registry = Registry.make(activity)

const definition = Workflow.make("activity-workflow", {
  version: "1.0.0",
  inputs: {
    value: Port.output(Schema.FiniteFromString, { contract: "example/number" }),
    first: Port.output(Schema.FiniteFromString, { contract: "example/number" }),
    second: Port.output(Schema.FiniteFromString, { contract: "example/number" })
  },
  outputs: {},
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const workflowInput = (input: string) => ({ _tag: "WorkflowInput" as const, input })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })

const plan = {
  formatVersion: 1,
  id: "activity-plan",
  revision: 3,
  definition: {
    id: definition.id,
    version: definition.version
  },
  nodes: [{
    id: "activity",
    type: activity.type,
    version: activity.version,
    config: { factor: "3" }
  }],
  edges: [
    {
      _tag: "DataEdge",
      id: "value-activity",
      source: workflowInput("value"),
      target: nodeInput("activity", "value")
    },
    {
      _tag: "DataEdge",
      id: "first-activity",
      source: workflowInput("first"),
      target: nodeInput("activity", "values"),
      order: 0
    },
    {
      _tag: "DataEdge",
      id: "second-activity",
      source: workflowInput("second"),
      target: nodeInput("activity", "values"),
      order: 1
    }
  ]
}

const schedule = (
  runId: string,
  overrides: Partial<Command.ScheduleActivity> = {}
): Command.ScheduleActivity => {
  const nodeId = overrides.nodeId ?? "activity"
  const nodeInstanceId = overrides.nodeInstanceId ?? Command.staticNodeInstanceId(nodeId)
  const attempt = overrides.attempt ?? 1
  return {
    _tag: "ScheduleActivity",
    nodeId,
    nodeInstanceId,
    attempt,
    activityId: Command.activityId(runId, nodeInstanceId, attempt),
    idempotencyKey: Command.activityIdempotencyKey(runId, nodeInstanceId),
    input: {
      value: "2",
      values: ["3", "4"]
    },
    ...overrides
  }
}

const command = (
  runId: string,
  payload: Command.ScheduleActivity = schedule(runId),
  commandId = Command.scheduleActivityCommandId(runId, payload.nodeInstanceId, payload.attempt)
): Command.Command => ({
  commandVersion: 1,
  commandId,
  payload
})

const assertRuntimeError = (
  error: unknown,
  phase: ActivityRuntime.Phase,
  message?: string
): ActivityRuntime.ActivityRuntimeError => {
  assert.instanceOf(error, ActivityRuntime.ActivityRuntimeError)
  const runtimeError = error as ActivityRuntime.ActivityRuntimeError
  assert.strictEqual(runtimeError.phase, phase)
  if (message !== undefined) {
    assert.include(runtimeError.message, message)
  }
  return runtimeError
}

describe("ActivityRuntime", () => {
  it.effect("decodes fresh configuration and routed inputs, preserves contexts, and emits frozen success drafts", () => {
    const factors: Array<number> = []
    const contexts: Array<Node.HandlerContext> = []
    const metadataValues: Array<{ value: string }> = []
    const handler = ((request: Node.HandlerRequest<typeof activity>) =>
      Effect.gen(function*() {
        const prefix = yield* RequestPrefix
        const suffix = yield* CapturedSuffix
        assert.isTrue(Option.isNone(request.inputs.note))
        assert.deepStrictEqual(request.inputs.values, [3, 4])
        assert.isTrue(Object.isFrozen(request.inputs.values))
        factors.push(request.config.factor)
        contexts.push(request.context)
        const factor = request.config.factor
        ;(request.config as { factor: number }).factor = 99
        const metadata = { value: `${prefix}:${suffix}` }
        metadataValues.push(metadata)
        return {
          result: (request.inputs.value + request.inputs.values.reduce((sum, value) => sum + value, 0)) * factor,
          metadata
        }
      })) as unknown as Node.Handler<typeof activity>

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": handler
      })).pipe(Effect.provideService(CapturedSuffix, "captured"))

      const first = yield* ActivityRuntime.execute(
        compiled,
        "run-1",
        command("run-1")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RequestPrefix, "request")
      )
      const second = yield* ActivityRuntime.execute(
        compiled,
        "run-2",
        command("run-2")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RequestPrefix, "request")
      )

      assert.strictEqual(first._tag, "Succeeded")
      assert.strictEqual(second._tag, "Succeeded")
      if (first._tag !== "Succeeded" || second._tag !== "Succeeded") {
        return yield* Effect.die("Expected successful activity outcomes")
      }
      assert.deepStrictEqual(factors, [3, 3])
      assert.deepStrictEqual(first.event, {
        eventVersion: 1,
        eventId: ActivityRuntime.activitySucceededEventId(schedule("run-1").activityId),
        causationId: Command.scheduleActivityCommandId("run-1", "activity", 1),
        payload: {
          _tag: "ActivitySucceeded",
          activityId: schedule("run-1").activityId,
          output: {
            result: "27",
            metadata: { value: "request:captured" }
          }
        }
      })
      assert.deepStrictEqual(contexts, [
        {
          scope: { _tag: "Direct" },
          runId: "run-1",
          planId: "activity-plan",
          planRevision: 3,
          nodeId: "activity",
          nodeInstanceId: "activity",
          attempt: 1,
          idempotencyKey: Command.activityIdempotencyKey("run-1", "activity")
        },
        {
          scope: { _tag: "Direct" },
          runId: "run-2",
          planId: "activity-plan",
          planRevision: 3,
          nodeId: "activity",
          nodeInstanceId: "activity",
          attempt: 1,
          idempotencyKey: Command.activityIdempotencyKey("run-2", "activity")
        }
      ])

      assert.isTrue(Object.isFrozen(first))
      assert.isTrue(Object.isFrozen(first.event))
      assert.isTrue(Object.isFrozen(first.event.payload))
      assert.isTrue(Object.isFrozen(first.event.payload.output))
      assert.isTrue(Object.isFrozen(first.event.payload.output.metadata))
      metadataValues[0]!.value = "mutated"
      assert.deepStrictEqual(first.event.payload.output.metadata, {
        value: "request:captured"
      })
      assert.deepStrictEqual(compiled.nodes.get("activity")?.node.config, { factor: "3" })
    })
  })

  it.effect("omits causation for a bare schedule and decodes present optional inputs", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": ({ inputs }) =>
          Effect.succeed({
            result: inputs.value,
            metadata: {
              note: Option.getOrElse(inputs.note, () => "missing")
            }
          })
      }))
      const outcome = yield* ActivityRuntime.execute(
        compiled,
        "bare-run",
        schedule("bare-run", {
          input: {
            value: "8",
            note: "present",
            values: ["1"]
          }
        })
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RequestPrefix, "request")
      )

      assert.strictEqual(outcome._tag, "Succeeded")
      if (outcome._tag !== "Succeeded") {
        return yield* Effect.die("Expected a successful activity outcome")
      }
      assert.isFalse(Object.prototype.hasOwnProperty.call(outcome.event, "causationId"))
      assert.deepStrictEqual(outcome.event.payload.output, {
        result: "8",
        metadata: { note: "present" }
      })
    }))

  it.effect("returns compatible typed failures with detached frozen failure events", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const failure = {
        _tag: "DomainFailure" as const,
        reason: "rejected"
      }
      const handlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": () => Effect.fail(failure)
      }))
      const outcome = yield* ActivityRuntime.execute(
        compiled,
        "failed-run",
        command("failed-run")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RequestPrefix, "request")
      )

      assert.strictEqual(outcome._tag, "Failed")
      if (outcome._tag !== "Failed") {
        return yield* Effect.die("Expected a failed activity outcome")
      }
      assert.strictEqual(outcome.failure, failure)
      assert.deepStrictEqual(outcome.event, {
        eventVersion: 1,
        eventId: ActivityRuntime.activityFailedEventId(schedule("failed-run").activityId),
        causationId: Command.scheduleActivityCommandId("failed-run", "activity", 1),
        payload: {
          _tag: "ActivityFailed",
          activityId: schedule("failed-run").activityId,
          failure: {
            _tag: "DomainFailure",
            reason: "rejected"
          }
        }
      })
      assert.isTrue(Object.isFrozen(outcome))
      assert.isTrue(Object.isFrozen(outcome.event))
      assert.isTrue(Object.isFrozen(outcome.event.payload.failure))
      failure.reason = "mutated"
      assert.deepStrictEqual(outcome.event.payload.failure, {
        _tag: "DomainFailure",
        reason: "rejected"
      })
    }))

  it.effect("rejects non-canonical activity, attempt, idempotency, command, and node identities", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": () => Effect.succeed({ result: 1, metadata: null })
      }))
      const runId = "identity-run"
      const unknown = schedule(runId, {
        nodeId: "unknown",
        nodeInstanceId: "unknown",
        activityId: Command.activityId(runId, "unknown", 1),
        idempotencyKey: Command.activityIdempotencyKey(runId, "unknown")
      })
      const cases: ReadonlyArray<Command.ScheduleActivity | Command.Command> = [
        schedule(runId, { nodeInstanceId: "wrong" }),
        schedule(runId, {
          attempt: 2,
          activityId: Command.activityId(runId, "activity", 2)
        }),
        schedule(runId, { activityId: "wrong" }),
        schedule(runId, { idempotencyKey: "wrong" }),
        command(runId, schedule(runId), "wrong"),
        unknown
      ]

      for (const input of cases) {
        const error = yield* ActivityRuntime.execute(compiled, runId, input).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.provideService(RequestPrefix, "request"),
          Effect.flip
        )
        assertRuntimeError(error, "identity")
      }
    }))

  it.effect("rejects structural copies of compiled plans", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const copied = { ...compiled } as Compiler.CompiledPlan<typeof definition>
      const handlers = Registry.HandlerRegistry.of({
        handlers: new Map<string, Registry.HandlerEntry>(),
        get: () => undefined
      })
      const error = yield* ActivityRuntime.execute(
        copied,
        "run-1",
        command("run-1")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RequestPrefix, "request"),
        Effect.flip
      )
      assertRuntimeError(error, "identity", "exact result of Compiler.compile")
    }))

  it.effect("validates exact encoded input keys and cardinality shapes", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const handlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": () => Effect.succeed({ result: 1, metadata: null })
      }))
      const cases: ReadonlyArray<readonly [Command.EncodedValues, string]> = [
        [{ values: ["1"] }, "missing required input"],
        [{ value: "1", values: "not-array" }, "must be a JSON array"],
        [{ value: "1", values: [] }, "at least one value"],
        [{ value: "1", values: ["not-number"] }, "Invalid encoded input"],
        [{ value: "1", values: ["2"], extra: true }, "unknown input"]
      ]

      for (const [input, message] of cases) {
        const error = yield* ActivityRuntime.execute(
          compiled,
          "input-run",
          schedule("input-run", { input })
        ).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.provideService(RequestPrefix, "request"),
          Effect.flip
        )
        assertRuntimeError(error, "input", message)
      }
    }))

  it.effect("rejects missing handlers, synchronous throws, and non-Effect handler results", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const missing = Registry.HandlerRegistry.of(Object.freeze({
        handlers: new Map(),
        get: () => undefined
      }))
      const missingError = yield* ActivityRuntime.execute(
        compiled,
        "missing-handler-run",
        command("missing-handler-run")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, missing),
        Effect.provideService(RequestPrefix, "request"),
        Effect.flip
      )
      assertRuntimeError(missingError, "handler", "No exact handler")

      const invalidHandlers: ReadonlyArray<Node.Handler<typeof activity>> = [
        (() => {
          throw new Error("synchronous")
        }) as Node.Handler<typeof activity>,
        (() => ({ result: 1, metadata: null })) as unknown as Node.Handler<typeof activity>
      ]
      for (const invalidHandler of invalidHandlers) {
        const handlers = yield* registry.toHandlers(registry.of({
          "Activity@1.0.0": invalidHandler
        }))
        const error = yield* ActivityRuntime.execute(
          compiled,
          "invalid-handler-run",
          command("invalid-handler-run")
        ).pipe(
          Effect.provideService(Registry.HandlerRegistry, handlers),
          Effect.provideService(RequestPrefix, "request"),
          Effect.flip
        )
        assertRuntimeError(error, "handler")
      }
    }))

  it.effect("rejects hostile output records without invoking accessors", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      let getterCalls = 0
      const output = {
        result: 1
      }
      Object.defineProperty(output, "metadata", {
        enumerable: true,
        get: () => {
          getterCalls++
          return null
        }
      })
      const handler = (() => Effect.succeed(output)) as unknown as Node.Handler<typeof activity>
      const handlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": handler
      }))
      const error = yield* ActivityRuntime.execute(
        compiled,
        "hostile-output-run",
        command("hostile-output-run")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.provideService(RequestPrefix, "request"),
        Effect.flip
      )

      assertRuntimeError(error, "output", "enumerable data property")
      assert.strictEqual(getterCalls, 0)
    }))

  it.effect("turns dishonest non-JSON output and failure codecs into runtime errors", () =>
    Effect.gen(function*() {
      const dishonestJson = Schema.Unknown as unknown as typeof Schema.Json
      const dishonest = Node.make("Dishonest", {
        version: "1.0.0",
        outputs: {
          value: Port.output(dishonestJson, { contract: "example/json" })
        },
        failure: dishonestJson
      })
      const dishonestRegistry = Registry.make(dishonest)
      const dishonestDefinition = Workflow.make("dishonest-activity-workflow", {
        version: "1.0.0",
        inputs: {},
        outputs: {},
        nodes: dishonestRegistry,
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      const dishonestPlan = {
        formatVersion: 1,
        id: "dishonest-plan",
        revision: 0,
        definition: {
          id: dishonestDefinition.id,
          version: dishonestDefinition.version
        },
        nodes: [{
          id: "dishonest",
          type: "Dishonest",
          version: "1.0.0",
          config: {}
        }],
        edges: []
      }
      const compiled = yield* Compiler.compile(dishonestDefinition, dishonestPlan)
      const dishonestSchedule = schedule("dishonest-run", {
        nodeId: "dishonest",
        nodeInstanceId: "dishonest",
        activityId: Command.activityId("dishonest-run", "dishonest", 1),
        idempotencyKey: Command.activityIdempotencyKey("dishonest-run", "dishonest"),
        input: {}
      })

      const outputHandlers = yield* dishonestRegistry.toHandlers(dishonestRegistry.of({
        "Dishonest@1.0.0": () => Effect.succeed({ value: undefined as unknown as Schema.Json })
      }))
      const outputError = yield* ActivityRuntime.execute(
        compiled,
        "dishonest-run",
        dishonestSchedule
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, outputHandlers),
        Effect.flip
      )
      assertRuntimeError(outputError, "output", "strict JSON")

      const failureHandlers = yield* dishonestRegistry.toHandlers(dishonestRegistry.of({
        "Dishonest@1.0.0": () => Effect.fail(1n as unknown as Schema.Json)
      }))
      const failureError = yield* ActivityRuntime.execute(
        compiled,
        "dishonest-run",
        dishonestSchedule
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, failureHandlers),
        Effect.flip
      )
      assertRuntimeError(failureError, "failure", "strict JSON")
    }))

  it.effect("types handler defects while preserving pure interruption", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, plan)
      const defectHandlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": () => Effect.die("handler defect")
      }))
      const defect = yield* ActivityRuntime.execute(
        compiled,
        "handler-defect-run",
        command("handler-defect-run")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, defectHandlers),
        Effect.provideService(RequestPrefix, "request"),
        Effect.flip
      )
      assertRuntimeError(defect, "handler", "unexpected defect")

      const interruptHandlers = yield* registry.toHandlers(registry.of({
        "Activity@1.0.0": () => Effect.interrupt
      }))
      const interrupted = yield* ActivityRuntime.execute(
        compiled,
        "handler-interrupt-run",
        command("handler-interrupt-run")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, interruptHandlers),
        Effect.provideService(RequestPrefix, "request"),
        Effect.exit
      )
      assert.isTrue(Exit.isFailure(interrupted))
      if (Exit.isFailure(interrupted)) {
        assert.isTrue(Cause.hasInterrupts(interrupted.cause))
      }
    }))

  it.effect("turns output and failure codec defects into phase-specific runtime errors", () => {
    const DefectOnEncode = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: Effect.succeed,
          encode: () => Effect.die("codec defect")
        })
      )
    )
    const outputDefect = Node.make("OutputDefect", {
      version: "1.0.0",
      outputs: {
        value: Port.output(DefectOnEncode, { contract: "example/defect" })
      },
      failure: domainFailure
    })
    const failureDefect = Node.make("FailureDefect", {
      version: "1.0.0",
      outputs: {
        value: Port.output(Schema.String, { contract: "example/text" })
      },
      failure: DefectOnEncode
    })
    const defectRegistry = Registry.make(outputDefect, failureDefect)
    const defectDefinition = Workflow.make("codec-defect-workflow", {
      version: "1.0.0",
      inputs: {},
      outputs: {},
      nodes: defectRegistry,
      linkPolicy: LinkPolicy.allowAll,
      limits
    })
    const defectPlan = {
      formatVersion: 1,
      id: "codec-defect-plan",
      revision: 0,
      definition: {
        id: defectDefinition.id,
        version: defectDefinition.version
      },
      nodes: [
        {
          id: "output",
          type: outputDefect.type,
          version: outputDefect.version,
          config: {}
        },
        {
          id: "failure",
          type: failureDefect.type,
          version: failureDefect.version,
          config: {}
        }
      ],
      edges: []
    }

    return Effect.gen(function*() {
      const compiled = yield* Compiler.compile(defectDefinition, defectPlan)
      const handlers = yield* defectRegistry.toHandlers(defectRegistry.of({
        "OutputDefect@1.0.0": () => Effect.succeed({ value: "value" }),
        "FailureDefect@1.0.0": () => Effect.fail("failure")
      }))
      const makeSchedule = (runId: string, nodeId: string): Command.ScheduleActivity => ({
        _tag: "ScheduleActivity",
        nodeId,
        nodeInstanceId: nodeId,
        attempt: 1,
        activityId: Command.activityId(runId, nodeId, 1),
        idempotencyKey: Command.activityIdempotencyKey(runId, nodeId),
        input: {}
      })

      const outputError = yield* ActivityRuntime.execute(
        compiled,
        "output-codec-run",
        makeSchedule("output-codec-run", "output")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )
      assertRuntimeError(outputError, "output", "failed unexpectedly")

      const failureError = yield* ActivityRuntime.execute(
        compiled,
        "failure-codec-run",
        makeSchedule("failure-codec-run", "failure")
      ).pipe(
        Effect.provideService(Registry.HandlerRegistry, handlers),
        Effect.flip
      )
      assertRuntimeError(failureError, "failure", "failed unexpectedly")
    })
  })
})
