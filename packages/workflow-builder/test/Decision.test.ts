import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Command from "../src/Command.ts"
import * as Compiler from "../src/Compiler.ts"
import * as Decision from "../src/Decision.ts"
import * as Fingerprint from "../src/Fingerprint.ts"
import * as Identity from "../src/Identity.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as RunState from "../src/RunState.ts"
import * as Workflow from "../src/Workflow.ts"

const timestamp = "2026-07-23T01:02:03.000Z" as const
const textContract = "decision/text"
const limits = new Workflow.Limits({
  maxNodes: 16,
  maxEdges: 32,
  maxFanIn: 8,
  maxFanOut: 8,
  maxDepth: 8
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

const join = Node.make("Join", {
  version: "1.0.0",
  inputs: {
    values: Port.input(Schema.String, { contract: textContract, cardinality: "many" }),
    optional: Port.input(Schema.String, { contract: textContract, required: false }),
    optionalMany: Port.input(Schema.String, {
      contract: textContract,
      cardinality: "many",
      required: false
    }),
    nullable: Port.input(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.output(Schema.String, { contract: textContract })
  }
})

const registry = Registry.make(pass, join)
const definition = Workflow.make("decision-workflow", {
  version: "1.0.0",
  inputs: {
    seed: Port.output(Schema.String, { contract: textContract }),
    nullable: Port.output(Schema.String, { contract: textContract })
  },
  outputs: {
    result: Port.input(Schema.String, { contract: textContract })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const workflowInput = (input: string) => ({ _tag: "WorkflowInput" as const, input })
const nodeOutput = (nodeId: string, output: string) => ({ _tag: "NodeOutput" as const, nodeId, output })
const nodeInput = (nodeId: string, input: string) => ({ _tag: "NodeInput" as const, nodeId, input })
const workflowOutput = (output: string) => ({ _tag: "WorkflowOutput" as const, output })

const dataEdge = (
  id: string,
  source: ReturnType<typeof workflowInput> | ReturnType<typeof nodeOutput>,
  target: ReturnType<typeof nodeInput> | ReturnType<typeof workflowOutput>,
  order?: number
) => ({
  _tag: "DataEdge" as const,
  id,
  source,
  target,
  ...(order === undefined ? undefined : { order })
})

const graphPlan = {
  formatVersion: 1,
  id: "decision-plan",
  revision: 3,
  definition: { id: definition.id, version: definition.version },
  nodes: [
    { id: "root", type: "Pass", version: "1.0.0", config: {} },
    { id: "left", type: "Pass", version: "1.0.0", config: {} },
    { id: "right", type: "Pass", version: "1.0.0", config: {} },
    { id: "tail", type: "Pass", version: "1.0.0", config: {} },
    { id: "join", type: "Join", version: "1.0.0", config: {} }
  ],
  edges: [
    dataEdge("seed-root", workflowInput("seed"), nodeInput("root", "value")),
    dataEdge("root-left", nodeOutput("root", "value"), nodeInput("left", "value")),
    dataEdge("root-right", nodeOutput("root", "value"), nodeInput("right", "value")),
    dataEdge("left-tail", nodeOutput("left", "value"), nodeInput("tail", "value")),
    dataEdge("left-join", nodeOutput("left", "value"), nodeInput("join", "values"), 1),
    dataEdge("right-join", nodeOutput("right", "value"), nodeInput("join", "values"), 0),
    dataEdge("nullable-join", workflowInput("nullable"), nodeInput("join", "nullable")),
    dataEdge("join-result", nodeOutput("join", "result"), workflowOutput("result"))
  ]
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

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  return result.success
}

const failure = <A>(result: Result.Result<A, Decision.DecisionError>): Decision.DecisionError => {
  assert.isTrue(Result.isFailure(result))
  return result.failure
}

const state = (
  plan: Decision.DecidablePlan,
  options: {
    readonly status?: RunState.RunState["status"] | undefined
    readonly input?: unknown
    readonly activities?: ReadonlyArray<readonly [string, RunState.ActivityState]> | undefined
    readonly output?: unknown
    readonly failure?: Schema.Json | undefined
    readonly pins?: Readonly<Record<string, unknown>> | undefined
  } = {}
): RunState.RunState => {
  const status = options.status ?? "Running"
  const base = {
    runId: "run-1",
    status,
    sequence: 0,
    startedAt: timestamp,
    planId: plan.compiled.plan.id,
    planRevision: plan.compiled.plan.revision,
    definitionId: plan.compiled.definition.id,
    definitionVersion: plan.compiled.definition.version,
    compilerVersion: plan.compilerVersion,
    compiledFingerprint: plan.compiledFingerprint,
    backend: "durable" as const,
    input: options.input ?? { seed: "seed", nullable: null },
    activities: HashMap.fromIterable(options.activities ?? []),
    seenEventIds: HashSet.empty(),
    ...options.pins
  }
  if (status === "Succeeded") {
    return { ...base, status, output: options.output ?? {}, completedAt: timestamp } as RunState.RunState
  }
  if (status === "Failed") {
    return { ...base, status, failure: options.failure ?? null, completedAt: timestamp } as RunState.RunState
  }
  if (status === "Cancelled") {
    return {
      ...base,
      status,
      cancellationRequestedAt: timestamp,
      completedAt: timestamp
    } as RunState.RunState
  }
  if (status === "CancellationRequested") {
    return { ...base, status, cancellationRequestedAt: timestamp } as RunState.RunState
  }
  return base as RunState.RunState
}

const defaultActivityInput = (nodeId: string): Command.EncodedValues => {
  switch (nodeId) {
    case "root":
    case "gate":
    case "controlled":
      return { value: "seed" }
    case "left":
    case "right":
      return { value: "root" }
    case "tail":
      return { value: "left" }
    case "join":
      return { values: ["right", "left"], optionalMany: [], nullable: null }
    default:
      return {}
  }
}

const activity = (
  runId: string,
  nodeId: string,
  status: RunState.ActivityState["status"],
  options: {
    readonly input?: unknown
    readonly output?: unknown
    readonly failure?: Schema.Json | undefined
    readonly activityId?: string | undefined
    readonly nodeInstanceId?: string | undefined
    readonly attempt?: number | undefined
    readonly idempotencyKey?: string | undefined
  } = {}
): readonly [string, RunState.ActivityState] => {
  const nodeInstanceId = options.nodeInstanceId ?? Command.staticNodeInstanceId(nodeId)
  const attempt = options.attempt ?? 1
  const activityId = options.activityId ?? Command.activityId(runId, nodeInstanceId, attempt)
  const base = {
    activityId,
    nodeId,
    nodeInstanceId,
    attempt,
    idempotencyKey: options.idempotencyKey ?? Command.activityIdempotencyKey(runId, nodeInstanceId),
    input: options.input ?? defaultActivityInput(nodeId),
    scheduledAt: timestamp
  }
  const value = status === "Succeeded"
    ? { ...base, status, output: options.output ?? {}, completedAt: timestamp }
    : status === "Failed"
    ? { ...base, status, failure: options.failure ?? null, completedAt: timestamp }
    : { ...base, status }
  return [activityId, value as RunState.ActivityState]
}

const preparedGraph = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, graphPlan)
  return yield* Decision.prepare(compiled)
}).pipe(Effect.provideService(Crypto.Crypto, testCrypto))

describe("Decision", () => {
  it("exposes a strict schema-backed DecisionError", () => {
    const decode = Schema.decodeUnknownSync(Decision.DecisionError)
    const decoded = decode({
      _tag: "DecisionError",
      code: Decision.Codes.MissingSourceValue,
      message: "A source is missing",
      nodeId: "node",
      details: { edgeId: "edge" }
    })
    assert.instanceOf(decoded, Decision.DecisionError)
    assert.throws(() => decode({ ...decoded, unexpected: true }))
    assert.throws(() => decode({ ...decoded, code: "FutureDecisionError" }))
  })

  it.effect("prepares exact compiler and fingerprint pins once", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, graphPlan)
      let digests = 0
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) => {
          digests++
          return testCrypto.digest(algorithm, data)
        }
      })
      const plan = yield* Decision.prepare(compiled).pipe(Effect.provideService(Crypto.Crypto, crypto))
      assert.strictEqual(digests, 1)
      assert.strictEqual(plan.compilerVersion, Fingerprint.CompilerSemanticVersion)
      assert.match(plan.compiledFingerprint, /^sha256:[0-9a-f]{64}$/)
      assert.isTrue(Object.isFrozen(plan))
    }))

  it.effect("rejects structural compiled-plan copies before fingerprinting", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, graphPlan)
      assert.isTrue(Compiler.isCompiled(compiled))

      const copied = {
        ...compiled,
        plan: {
          ...compiled.plan,
          formatVersion: 999
        }
      } as unknown as Compiler.CompiledPlan<typeof definition>
      assert.isFalse(Compiler.isCompiled(copied))

      let digests = 0
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) => {
          digests++
          return testCrypto.digest(algorithm, data)
        }
      })
      const result = yield* Effect.result(
        Decision.prepare(copied).pipe(Effect.provideService(Crypto.Crypto, crypto))
      )
      const error = failure(result)
      assert.instanceOf(error, Decision.DecisionError)
      assert.strictEqual(error.code, Decision.Codes.PlanIdentityMismatch)
      assert.strictEqual(digests, 0)
    }))

  it.effect("validates all immutable pins before considering terminal status", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const cases: ReadonlyArray<readonly [Readonly<Record<string, unknown>>, Decision.DecisionErrorCode]> = [
        [{ planId: "other" }, Decision.Codes.PlanIdentityMismatch],
        [{ planRevision: 99 }, Decision.Codes.PlanIdentityMismatch],
        [{ definitionId: "other" }, Decision.Codes.PlanIdentityMismatch],
        [{ definitionVersion: "other" }, Decision.Codes.PlanIdentityMismatch],
        [{ compilerVersion: "other" }, Decision.Codes.CompilerVersionMismatch],
        [{ compiledFingerprint: `sha256:${"0".repeat(64)}` }, Decision.Codes.FingerprintMismatch]
      ]
      for (const [pins, code] of cases) {
        assert.strictEqual(failure(Decision.decide(plan, state(plan, { status: "Failed", pins }))).code, code)
      }

      const unsupported = {
        ...plan,
        compilerVersion: "future"
      } as unknown as Decision.DecidablePlan
      assert.strictEqual(
        failure(Decision.decide(
          unsupported,
          { ...state(plan), compilerVersion: "future" } as RunState.RunState
        )).code,
        Decision.Codes.PlanIdentityMismatch
      )

      const malformedFingerprint = {
        ...plan,
        compiledFingerprint: "sha256:not-a-digest"
      } as unknown as Decision.DecidablePlan
      assert.strictEqual(
        failure(Decision.decide(
          malformedFingerprint,
          { ...state(plan), compiledFingerprint: "sha256:not-a-digest" } as RunState.RunState
        )).code,
        Decision.Codes.PlanIdentityMismatch
      )

      const unprepared = {
        compiled: plan.compiled,
        compilerVersion: plan.compilerVersion,
        compiledFingerprint: plan.compiledFingerprint
      } as unknown as Decision.DecidablePlan
      assert.strictEqual(
        failure(Decision.decide(unprepared, state(plan))).code,
        Decision.Codes.PlanIdentityMismatch
      )

      const alternateCompiled = yield* Compiler.compile(definition, {
        ...graphPlan,
        edges: graphPlan.edges.map((edge, index) => ({ ...edge, id: `alternate-${index}` }))
      })
      const substituted = {
        ...plan,
        compiled: alternateCompiled
      } as unknown as Decision.DecidablePlan
      assert.strictEqual(
        failure(Decision.decide(substituted, state(plan))).code,
        Decision.Codes.PlanIdentityMismatch
      )
    }))

  it.effect("schedules roots once with canonical collision-free identity", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const first = success(Decision.decide(plan, state(plan)))
      const second = success(Decision.decide(plan, state(plan)))
      assert.deepStrictEqual(second, first)
      assert.lengthOf(first, 1)
      const command = first[0]!
      assert.strictEqual(command.payload._tag, "ScheduleActivity")
      if (command.payload._tag === "ScheduleActivity") {
        assert.strictEqual(command.payload.nodeId, "root")
        assert.strictEqual(command.payload.activityId, Command.activityId("run-1", "root", 1))
        assert.strictEqual(command.payload.idempotencyKey, Command.activityIdempotencyKey("run-1", "root"))
        assert.deepStrictEqual(command.payload.input, { value: "seed" })
      }

      const hostileRun = "run|1:[\"x\"]"
      const hostileNode = "node|1:[\"x\"]"
      const hostileCompiled = yield* Compiler.compile(definition, {
        formatVersion: 1,
        id: "hostile-plan",
        revision: 0,
        definition: { id: definition.id, version: definition.version },
        nodes: [{ id: hostileNode, type: "Pass", version: "1.0.0", config: {} }],
        edges: [
          dataEdge("hostile-input", workflowInput("seed"), nodeInput(hostileNode, "value")),
          dataEdge("hostile-output", nodeOutput(hostileNode, "value"), workflowOutput("result"))
        ]
      })
      const hostilePlan = yield* Decision.prepare(hostileCompiled).pipe(
        Effect.provideService(Crypto.Crypto, testCrypto)
      )
      const hostileState = { ...state(hostilePlan), runId: hostileRun } as RunState.RunState
      const hostileCommand = success(Decision.decide(hostilePlan, hostileState))[0]!
      assert.strictEqual(hostileCommand.payload._tag, "ScheduleActivity")
      if (hostileCommand.payload._tag === "ScheduleActivity") {
        assert.strictEqual(hostileCommand.payload.nodeId, hostileNode)
        assert.strictEqual(
          hostileCommand.payload.activityId,
          Command.activityId(hostileRun, hostileNode, 1)
        )
      }
      assert.notStrictEqual(
        Command.activityId(hostileRun, hostileNode, 1),
        Command.activityId(`${hostileRun}|${hostileNode}`, "1", 1)
      )
    }))

  it.effect("gates readiness on control dependencies", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(definition, {
        formatVersion: 1,
        id: "control-plan",
        revision: 0,
        definition: { id: definition.id, version: definition.version },
        nodes: [
          { id: "gate", type: "Pass", version: "1.0.0", config: {} },
          { id: "controlled", type: "Pass", version: "1.0.0", config: {} }
        ],
        edges: [
          dataEdge("gate-input", workflowInput("seed"), nodeInput("gate", "value")),
          dataEdge("controlled-input", workflowInput("seed"), nodeInput("controlled", "value")),
          dataEdge("controlled-output", nodeOutput("controlled", "value"), workflowOutput("result")),
          {
            _tag: "ControlEdge" as const,
            id: "gate-controlled",
            sourceNodeId: "gate",
            targetNodeId: "controlled"
          }
        ]
      })
      const plan = yield* Decision.prepare(compiled).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
      const initial = success(Decision.decide(plan, state(plan)))
      assert.deepStrictEqual(
        initial.map((command) =>
          command.payload._tag === "ScheduleActivity" ? command.payload.nodeId : command.payload._tag
        ),
        ["gate"]
      )
      const gateSucceeded = [activity("run-1", "gate", "Succeeded", { output: { value: "gate" } })]
      const ready = success(Decision.decide(plan, state(plan, { activities: gateSucceeded })))
      assert.deepStrictEqual(
        ready.map((command) =>
          command.payload._tag === "ScheduleActivity" ? command.payload.nodeId : command.payload._tag
        ),
        ["controlled"]
      )
    }))

  it.effect("does not reschedule committed activities and has no global stage barrier", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const activities = [
        activity("run-1", "root", "Succeeded", { output: { value: "root" } }),
        activity("run-1", "left", "Succeeded", { output: { value: "left" } }),
        activity("run-1", "right", "Scheduled")
      ]
      const commands = success(Decision.decide(plan, state(plan, { activities })))
      assert.deepStrictEqual(
        commands.map((command) =>
          command.payload._tag === "ScheduleActivity" ? command.payload.nodeId : command.payload._tag
        ),
        ["tail"]
      )
    }))

  it.effect("routes node outputs, explicit many order, optional omission, and present null", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const activities = [
        activity("run-1", "root", "Succeeded", { output: { value: "root" } }),
        activity("run-1", "left", "Succeeded", { output: { value: "left" } }),
        activity("run-1", "right", "Succeeded", { output: { value: "right" } }),
        activity("run-1", "tail", "Scheduled")
      ]
      const commands = success(Decision.decide(plan, state(plan, { activities })))
      const joinCommand = commands.find((command) =>
        command.payload._tag === "ScheduleActivity" && command.payload.nodeId === "join"
      )
      assert.isDefined(joinCommand)
      assert.strictEqual(joinCommand.payload._tag, "ScheduleActivity")
      if (joinCommand.payload._tag === "ScheduleActivity") {
        assert.deepStrictEqual(joinCommand.payload.input, {
          values: ["right", "left"],
          optionalMany: [],
          nullable: null
        })
        assert.notProperty(joinCommand.payload.input, "optional")
        assert.isTrue(Object.isFrozen(joinCommand.payload.input))
        assert.isTrue(Object.isFrozen(joinCommand.payload.input.values))
      }
    }))

  it.effect("routes prototype-like port names as collision-free own properties", () =>
    Effect.gen(function*() {
      const prototypeNode = Node.make("PrototypePorts", {
        version: "1",
        inputs: {
          ["__proto__"]: Port.input(Schema.String, { contract: textContract })
        },
        outputs: {
          constructor: Port.output(Schema.String, { contract: textContract })
        }
      })
      const prototypeRegistry = Registry.make(prototypeNode)
      const prototypeDefinition = Workflow.make("prototype-decision", {
        version: "1",
        inputs: {
          toString: Port.output(Schema.String, { contract: textContract })
        },
        outputs: {
          ["__proto__"]: Port.input(Schema.String, { contract: textContract })
        },
        nodes: prototypeRegistry,
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      const compiled = yield* Compiler.compile(prototypeDefinition, {
        formatVersion: 1,
        id: "prototype-plan",
        revision: 0,
        definition: { id: prototypeDefinition.id, version: prototypeDefinition.version },
        nodes: [{ id: "node", type: "PrototypePorts", version: "1", config: {} }],
        edges: [
          dataEdge("prototype-input", workflowInput("toString"), nodeInput("node", "__proto__")),
          dataEdge("prototype-output", nodeOutput("node", "constructor"), workflowOutput("__proto__"))
        ]
      })
      const plan = yield* Decision.prepare(compiled).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
      const initial = state(plan, { input: { toString: "seed" } })
      const scheduled = success(Decision.decide(plan, initial))[0]!
      assert.strictEqual(scheduled.payload._tag, "ScheduleActivity")
      if (scheduled.payload._tag !== "ScheduleActivity") {
        return
      }
      assert.isTrue(Object.prototype.hasOwnProperty.call(scheduled.payload.input, "__proto__"))
      assert.strictEqual(scheduled.payload.input["__proto__"], "seed")

      const encodedNodeInput = Object.fromEntries([["__proto__", "seed"]])
      const completed = activity("run-1", "node", "Succeeded", {
        input: encodedNodeInput,
        output: { constructor: "done" }
      })
      const terminal = success(Decision.decide(
        plan,
        state(plan, {
          input: { toString: "seed" },
          activities: [completed]
        })
      ))[0]!
      assert.strictEqual(terminal.payload._tag, "SucceedRun")
      if (terminal.payload._tag === "SucceedRun") {
        assert.isTrue(Object.prototype.hasOwnProperty.call(terminal.payload.output, "__proto__"))
        assert.strictEqual(terminal.payload.output["__proto__"], "done")
      }
      assert.strictEqual(({} as { readonly polluted?: boolean }).polluted, undefined)
    }))

  it.effect("reports invalid encoded records and missing own source properties", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { input: [] }))).code,
        Decision.Codes.InvalidEncodedValues
      )
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { input: { nullable: null } }))).code,
        Decision.Codes.InvalidEncodedValues
      )
      assert.strictEqual(
        failure(Decision.decide(
          plan,
          state(plan, {
            input: { seed: "seed", nullable: null, extra: true }
          })
        )).code,
        Decision.Codes.InvalidEncodedValues
      )
      const missingOutput = [activity("run-1", "root", "Succeeded", { output: {} })]
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: missingOutput }))).code,
        Decision.Codes.InvalidEncodedValues
      )
      const invalidOutput = [activity("run-1", "root", "Succeeded", { output: [] })]
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: invalidOutput }))).code,
        Decision.Codes.InvalidEncodedValues
      )
      const wrongInput = [activity("run-1", "root", "Scheduled", { input: { value: "other" } })]
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: wrongInput }))).code,
        Decision.Codes.InvalidActivityIdentity
      )
      const premature = [activity("run-1", "left", "Scheduled")]
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: premature }))).code,
        Decision.Codes.InvalidActivityIdentity
      )
    }))

  it.effect("requires every declared workflow input even when the graph does not use it", () =>
    Effect.gen(function*() {
      const unusedInputDefinition = Workflow.make("unused-input-decision", {
        version: "1",
        inputs: {
          unused: Port.output(Schema.String, { contract: textContract })
        },
        outputs: {},
        nodes: Registry.make(),
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      const compiled = yield* Compiler.compile(unusedInputDefinition, {
        formatVersion: 1,
        id: "unused-input-plan",
        revision: 0,
        definition: { id: unusedInputDefinition.id, version: unusedInputDefinition.version },
        nodes: [],
        edges: []
      })
      const plan = yield* Decision.prepare(compiled).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { input: {} }))).code,
        Decision.Codes.InvalidEncodedValues
      )
      assert.strictEqual(
        success(Decision.decide(plan, state(plan, { input: { unused: "present" } })))[0]?.payload._tag,
        "SucceedRun"
      )
    }))

  it.effect("rejects unknown, noncanonical, and duplicate node activities", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const unknown = [activity("run-1", "unknown", "Scheduled")]
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: unknown }))).code,
        Decision.Codes.UnknownActivityNode
      )

      const invalid = [activity("run-1", "root", "Scheduled", { attempt: 2 })]
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: invalid }))).code,
        Decision.Codes.InvalidActivityIdentity
      )

      const first = activity("run-1", "root", "Scheduled", { activityId: "first" })
      const second = activity("run-1", "root", "Scheduled", { activityId: "second" })
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { activities: [second, first] }))).code,
        Decision.Codes.DuplicateNodeActivity
      )
    }))

  it.effect("selects the first failed node in compiled order regardless of HashMap insertion", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const left = activity("run-1", "left", "Failed", { failure: { code: "left" } })
      const right = activity("run-1", "right", "Failed", { failure: { code: "right" } })
      const root = activity("run-1", "root", "Succeeded", { output: { value: "root" } })
      const first = success(Decision.decide(plan, state(plan, { activities: [right, root, left] })))
      const second = success(Decision.decide(plan, state(plan, { activities: [left, right, root] })))
      assert.deepStrictEqual(second, first)
      assert.strictEqual(first[0]?.payload._tag, "FailRun")
      if (first[0]?.payload._tag === "FailRun") {
        assert.strictEqual(first[0].payload.failure.nodeId, "left")
        assert.deepStrictEqual(first[0].payload.failure.failure, { code: "left" })
      }
    }))

  it.effect("committed cancellation wins over activity failure and completion", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const expected = [{
        commandVersion: 1,
        commandId: Command.cancelRunCommandId("run-1"),
        payload: { _tag: "CancelRun" }
      }] as const
      const failedActivities = [
        activity("run-1", "root", "Succeeded", { output: { value: "root" } }),
        activity("run-1", "left", "Failed", { failure: { code: "left" } })
      ]
      const succeededActivities = [
        activity("run-1", "root", "Succeeded", { output: { value: "root" } }),
        activity("run-1", "left", "Succeeded", { output: { value: "left" } }),
        activity("run-1", "right", "Succeeded", { output: { value: "right" } }),
        activity("run-1", "tail", "Succeeded", { output: { value: "tail" } }),
        activity("run-1", "join", "Succeeded", { output: { result: "done" } })
      ]
      assert.deepStrictEqual(
        success(Decision.decide(plan, state(plan, { status: "CancellationRequested" }))),
        expected
      )
      assert.deepStrictEqual(
        success(Decision.decide(
          plan,
          state(plan, {
            status: "CancellationRequested",
            activities: failedActivities
          })
        )),
        expected
      )
      assert.deepStrictEqual(
        success(Decision.decide(
          plan,
          state(plan, {
            status: "CancellationRequested",
            activities: succeededActivities
          })
        )),
        expected
      )
      assert.deepStrictEqual(success(Decision.decide(plan, state(plan, { status: "Failed" }))), [])
      assert.deepStrictEqual(success(Decision.decide(plan, state(plan, { status: "Cancelled" }))), [])
    }))

  it.effect("succeeds with assembled workflow output and validates successful terminal history", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const activities = [
        activity("run-1", "root", "Succeeded", { output: { value: "root" } }),
        activity("run-1", "left", "Succeeded", { output: { value: "left" } }),
        activity("run-1", "right", "Succeeded", { output: { value: "right" } }),
        activity("run-1", "tail", "Succeeded", { output: { value: "tail" } }),
        activity("run-1", "join", "Succeeded", { output: { result: "done" } })
      ]
      const commands = success(Decision.decide(plan, state(plan, { activities })))
      assert.deepStrictEqual(commands, [{
        commandVersion: 1,
        commandId: Command.succeedRunCommandId("run-1"),
        payload: { _tag: "SucceedRun", output: { result: "done" } }
      }])
      assert.deepStrictEqual(
        success(Decision.decide(plan, state(plan, { status: "Succeeded", activities, output: { result: "done" } }))),
        []
      )
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { status: "Succeeded", activities: activities.slice(0, 4) }))).code,
        Decision.Codes.InvalidTerminalState
      )
      assert.strictEqual(
        failure(Decision.decide(
          plan,
          state(plan, {
            status: "Succeeded",
            activities,
            output: { result: "wrong" }
          })
        )).code,
        Decision.Codes.InvalidTerminalState
      )
    }))

  it.effect("succeeds an empty graph and recursively freezes every emitted structure", () =>
    Effect.gen(function*() {
      const emptyDefinition = Workflow.make("empty-decision", {
        version: "1",
        inputs: {},
        outputs: {},
        nodes: Registry.make(),
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      const compiled = yield* Compiler.compile(emptyDefinition, {
        formatVersion: 1,
        id: "empty-plan",
        revision: 0,
        definition: { id: emptyDefinition.id, version: emptyDefinition.version },
        nodes: [],
        edges: []
      })
      const plan = yield* Decision.prepare(compiled).pipe(Effect.provideService(Crypto.Crypto, testCrypto))
      const commands = success(Decision.decide(plan, state(plan, { input: {} })))
      assert.strictEqual(commands[0]?.payload._tag, "SucceedRun")
      assert.isTrue(Object.isFrozen(commands))
      assert.isTrue(Object.isFrozen(commands[0]))
      assert.isTrue(Object.isFrozen(commands[0]!.payload))
      if (commands[0]?.payload._tag === "SucceedRun") {
        assert.isTrue(Object.isFrozen(commands[0].payload.output))
      }
      assert.strictEqual(
        failure(Decision.decide(plan, state(plan, { input: { rogue: true } }))).code,
        Decision.Codes.InvalidEncodedValues
      )
    }))

  it.effect("routes deeply nested JSON replayed through RunState without recursive decision walks", () =>
    Effect.gen(function*() {
      const plan = yield* preparedGraph
      const depth = 2_000
      let deep: Schema.Json = "leaf"
      for (let index = 0; index < depth; index++) {
        deep = { next: deep }
      }
      const replayed = success(RunState.fold([{
        eventVersion: 1,
        eventId: Identity.runStartedEventId("run-1"),
        runId: "run-1",
        sequence: 0,
        recordedAt: timestamp,
        payload: {
          _tag: "RunStarted",
          planId: plan.compiled.plan.id,
          planRevision: plan.compiled.plan.revision,
          definitionId: plan.compiled.definition.id,
          definitionVersion: plan.compiled.definition.version,
          compilerVersion: plan.compilerVersion,
          compiledFingerprint: plan.compiledFingerprint,
          backend: "durable",
          input: { seed: deep, nullable: null }
        }
      }]))
      const commands = success(Decision.decide(plan, replayed))
      assert.strictEqual(commands[0]?.payload._tag, "ScheduleActivity")
      if (commands[0]?.payload._tag !== "ScheduleActivity") {
        return
      }
      let current = commands[0].payload.input.value
      for (let index = 0; index < depth; index++) {
        assert.isTrue(current !== null && typeof current === "object" && !Array.isArray(current))
        current = (current as Schema.JsonObject).next!
      }
      assert.strictEqual(current, "leaf")
    }))

  it("makes no retry, timer, signal, or lost-delivery recovery claim", () => {
    const vocabulary = ["ScheduleActivity", "SucceedRun", "FailRun", "CancelRun"]
    assert.deepStrictEqual(vocabulary, ["ScheduleActivity", "SucceedRun", "FailRun", "CancelRun"])
    const module = Command as Readonly<Record<string, unknown>>
    assert.notProperty(module, "RetryActivity")
    assert.notProperty(module, "ScheduleTimer")
    assert.notProperty(module, "WaitForSignal")
    assert.notProperty(module, "RescheduleActivity")
  })
})
