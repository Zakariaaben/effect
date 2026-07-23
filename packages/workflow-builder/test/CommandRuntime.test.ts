import { assert, assertType, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Types from "effect/Types"
import type * as Command from "../src/Command.ts"
import * as CommandRuntime from "../src/CommandRuntime.ts"
import * as Compiler from "../src/Compiler.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 16,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const dataEdge = (
  id: string,
  source: { readonly _tag: "NodeOutput"; readonly nodeId: string; readonly output: string },
  target: { readonly _tag: "WorkflowOutput"; readonly output: string }
) => ({
  _tag: "DataEdge" as const,
  id,
  source,
  target
})

const nodeOutput = (nodeId: string, output: string) => ({
  _tag: "NodeOutput" as const,
  nodeId,
  output
})

const workflowOutput = (output: string) => ({
  _tag: "WorkflowOutput" as const,
  output
})

const shapeContract = "command-runtime/shape"
const shapeSource = Node.make("CommandShapeSource", {
  version: "1.0.0",
  outputs: {
    required: Port.output(Schema.String, { contract: shapeContract }),
    optional: Port.output(Schema.Number, { contract: shapeContract }),
    flag: Port.output(Schema.Boolean, { contract: shapeContract })
  }
})
const shapeDefinition = Workflow.make("command-runtime-shape", {
  version: "1.0.0",
  inputs: {},
  outputs: {
    required: Port.input(Schema.String, { contract: shapeContract }),
    optional: Port.input(Schema.Number, {
      contract: shapeContract,
      required: false
    }),
    connectedOptional: Port.input(Schema.Number, {
      contract: shapeContract,
      required: false
    }),
    items: Port.input(Schema.Boolean, {
      contract: shapeContract,
      cardinality: "many",
      required: false
    }),
    requiredItems: Port.input(Schema.Boolean, {
      contract: shapeContract,
      cardinality: "many",
      required: true
    })
  },
  nodes: Registry.make(shapeSource),
  linkPolicy: LinkPolicy.allowAll,
  limits
})
const shapePlan = {
  formatVersion: 1,
  id: "command-runtime-shape-plan",
  revision: 1,
  definition: {
    id: shapeDefinition.id,
    version: shapeDefinition.version
  },
  nodes: [{
    id: "source",
    type: shapeSource.type,
    version: shapeSource.version,
    config: {}
  }],
  edges: [
    dataEdge("required", nodeOutput("source", "required"), workflowOutput("required")),
    dataEdge("connected-optional", nodeOutput("source", "optional"), workflowOutput("connectedOptional")),
    dataEdge("required-items", nodeOutput("source", "flag"), workflowOutput("requiredItems"))
  ]
}

const mismatchContract = "command-runtime/same-contract"
const stringSource = Node.make("CommandStringSource", {
  version: "1.0.0",
  outputs: {
    value: Port.output(Schema.String, { contract: mismatchContract })
  }
})
const mismatchDefinition = Workflow.make("command-runtime-mismatch", {
  version: "1.0.0",
  inputs: {},
  outputs: {
    value: Port.input(Schema.Number, { contract: mismatchContract })
  },
  nodes: Registry.make(stringSource),
  linkPolicy: LinkPolicy.allowAll,
  limits
})
const mismatchPlan = {
  formatVersion: 1,
  id: "command-runtime-mismatch-plan",
  revision: 1,
  definition: {
    id: mismatchDefinition.id,
    version: mismatchDefinition.version
  },
  nodes: [{
    id: "source",
    type: stringSource.type,
    version: stringSource.version,
    config: {}
  }],
  edges: [
    dataEdge("value", nodeOutput("source", "value"), workflowOutput("value"))
  ]
}

class DecodePrefix extends Context.Service<DecodePrefix, string>()(
  "@effect/workflow-builder/test/CommandRuntime/DecodePrefix"
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

const serviceContract = "command-runtime/service"
const serviceSource = Node.make("CommandServiceSource", {
  version: "1.0.0",
  outputs: {
    value: Port.output(Schema.String, { contract: serviceContract })
  }
})
const serviceDefinition = Workflow.make("command-runtime-service", {
  version: "1.0.0",
  inputs: {},
  outputs: {
    value: Port.input(ServiceDecoded, { contract: serviceContract })
  },
  nodes: Registry.make(serviceSource),
  linkPolicy: LinkPolicy.allowAll,
  limits
})
const servicePlan = {
  formatVersion: 1,
  id: "command-runtime-service-plan",
  revision: 1,
  definition: {
    id: serviceDefinition.id,
    version: serviceDefinition.version
  },
  nodes: [{
    id: "source",
    type: serviceSource.type,
    version: serviceSource.version,
    config: {}
  }],
  edges: [
    dataEdge("value", nodeOutput("source", "value"), workflowOutput("value"))
  ]
}

const successCommand = (
  output: Command.EncodedValues,
  commandId = "succeed-command"
): Command.Command => ({
  commandVersion: 1,
  commandId,
  payload: {
    _tag: "SucceedRun",
    output
  }
})

describe("CommandRuntime", () => {
  it.effect("enforces exact output names and one, many, required, and optional shapes", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(shapeDefinition, shapePlan)
      const valid = yield* CommandRuntime.validate(
        compiled,
        successCommand({
          required: "ok",
          connectedOptional: 1,
          items: [],
          requiredItems: [true]
        })
      )
      assert.isTrue(Object.isFrozen(valid))
      assert.isTrue(Object.isFrozen(valid.payload))
      if (valid.payload._tag === "SucceedRun") {
        assert.isTrue(Object.isFrozen(valid.payload.output))
        assert.isTrue(Object.isFrozen(valid.payload.output.items))
      }

      const cases: ReadonlyArray<readonly [Command.EncodedValues, string | undefined]> = [
        [
          { required: "ok", connectedOptional: 1, items: [], requiredItems: [true], extra: true },
          "extra"
        ],
        [{ connectedOptional: 1, items: [], requiredItems: [true] }, "required"],
        [{ required: "ok", items: [], requiredItems: [true] }, "connectedOptional"],
        [{ required: "ok", connectedOptional: 1, requiredItems: [true] }, "items"],
        [{ required: "ok", connectedOptional: 1, items: true, requiredItems: [true] }, "items"],
        [{ required: "ok", connectedOptional: 1, items: [], requiredItems: [] }, "requiredItems"],
        [
          { required: "ok", connectedOptional: "not-a-number", items: [], requiredItems: [true] },
          "connectedOptional"
        ],
        [
          { required: "ok", optional: 1, connectedOptional: 1, items: [], requiredItems: [true] },
          "optional"
        ]
      ]
      for (const [output, expectedOutput] of cases) {
        const error = yield* CommandRuntime.validate(compiled, successCommand(output)).pipe(Effect.flip)
        assert.instanceOf(error, CommandRuntime.CommandRuntimeError)
        assert.strictEqual(error.code, CommandRuntime.Codes.InvalidWorkflowOutput)
        assert.strictEqual(error.output, expectedOutput)
      }
    }))

  it.effect("rejects a String source routed to a same-contract Number sink", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(mismatchDefinition, mismatchPlan)
      const error = yield* CommandRuntime.validate(
        compiled,
        successCommand({ value: "not-a-number" })
      ).pipe(Effect.flip)

      assert.strictEqual(error.code, CommandRuntime.Codes.InvalidWorkflowOutput)
      assert.strictEqual(error.output, "value")
      assert.include(error.message, "Invalid encoded workflow output")
    }))

  it.effect("runs target decoders with their declared Effect services", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(serviceDefinition, servicePlan)
      const validation = CommandRuntime.validate(
        compiled,
        successCommand({ value: "wire" })
      )
      assertType<Types.Equals<Effect.Services<typeof validation>, DecodePrefix>>(true)
      const command = yield* validation.pipe(Effect.provideService(DecodePrefix, "decoded"))

      assert.strictEqual(command.payload._tag, "SucceedRun")
    }))

  it.effect("strictly snapshots nonterminal commands without consulting output codecs", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(serviceDefinition, servicePlan)
      const caller = {
        commandVersion: 1 as const,
        commandId: "schedule-command",
        payload: {
          _tag: "ScheduleActivity" as const,
          activityId: "activity",
          nodeId: "source",
          nodeInstanceId: "source",
          attempt: 1,
          idempotencyKey: "idempotency",
          input: { nested: { before: true } }
        }
      }
      const command = yield* CommandRuntime.validate(compiled, caller)
      caller.payload.input.nested.before = false

      assert.isTrue(Object.isFrozen(command))
      assert.deepStrictEqual(
        command.payload._tag === "ScheduleActivity" ? command.payload.input : undefined,
        { nested: { before: true } }
      )

      const cancelled = yield* CommandRuntime.validate(compiled, {
        commandVersion: 1,
        commandId: "cancel-command",
        payload: { _tag: "CancelRun" }
      })
      assert.strictEqual(cancelled.payload._tag, "CancelRun")
    }))

  it.effect("rejects hostile JSON descriptors without invoking them", () =>
    Effect.gen(function*() {
      const compiled = yield* Compiler.compile(shapeDefinition, shapePlan)
      let reads = 0
      const hostile = {
        commandVersion: 1,
        commandId: "hostile-command"
      }
      Object.defineProperty(hostile, "payload", {
        enumerable: true,
        get: () => {
          reads++
          return { _tag: "CancelRun" }
        }
      })

      const error = yield* CommandRuntime.validate(compiled, hostile).pipe(Effect.flip)
      assert.strictEqual(error.code, CommandRuntime.Codes.InvalidJson)
      assert.strictEqual(reads, 0)
    }))

  it.effect("types decoder defects while preserving pure interruption", () => {
    const Defecting = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: () => Effect.die("decoder defect"),
          encode: Effect.succeed
        })
      )
    )
    const Interrupting = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: () => Effect.interrupt,
          encode: Effect.succeed
        })
      )
    )
    const compile = (id: string, schema: Port.PayloadSchema) => {
      const source = Node.make(`${id}Source`, {
        version: "1.0.0",
        outputs: {
          value: Port.output(Schema.String, { contract: id })
        }
      })
      const definition = Workflow.make(id, {
        version: "1.0.0",
        inputs: {},
        outputs: {
          value: Port.input(schema, { contract: id })
        },
        nodes: Registry.make(source),
        linkPolicy: LinkPolicy.allowAll,
        limits
      })
      return Compiler.compile(definition, {
        formatVersion: 1,
        id: `${id}-plan`,
        revision: 1,
        definition: { id, version: definition.version },
        nodes: [{ id: "source", type: source.type, version: source.version, config: {} }],
        edges: [dataEdge("value", nodeOutput("source", "value"), workflowOutput("value"))]
      })
    }

    return Effect.gen(function*() {
      const defecting = yield* compile("command-runtime-defect", Defecting)
      const defect = yield* CommandRuntime.validate(
        defecting,
        successCommand({ value: "wire" })
      ).pipe(Effect.flip)
      assert.strictEqual(defect.code, CommandRuntime.Codes.InvalidWorkflowOutput)
      assert.include(defect.message, "Codec failed unexpectedly")

      const interrupting = yield* compile("command-runtime-interrupt", Interrupting)
      const interrupted = yield* CommandRuntime.validate(
        interrupting,
        successCommand({ value: "wire" })
      ).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(interrupted))
      if (Exit.isFailure(interrupted)) {
        assert.isTrue(Cause.hasInterrupts(interrupted.cause))
      }
    })
  })
})
