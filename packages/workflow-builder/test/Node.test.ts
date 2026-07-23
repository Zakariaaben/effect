import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Types from "effect/Types"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"

const assertType = <T extends true>(value: T): void => {
  assert.isTrue(value)
}

const UndefinedFromNull = Schema.Null.pipe(
  Schema.decodeTo(
    Schema.Undefined,
    SchemaTransformation.transform({
      decode: () => undefined,
      encode: () => null
    })
  )
)

const verifyPortableNodeSchemaTypes = (): void => {
  Node.make("PortablePrimitives", {
    version: "1.0.0",
    config: Schema.NumberFromString,
    failure: Schema.String
  })
  Node.make("PortableStruct", {
    version: "1.0.0",
    config: Schema.Struct({ label: Schema.String }),
    failure: Schema.Struct({ message: Schema.String })
  })
  Node.make("PortableUndefined", {
    version: "1.0.0",
    config: UndefinedFromNull,
    failure: UndefinedFromNull
  })

  Node.make("UndefinedConfig", {
    version: "1.0.0",
    // @ts-expect-error configuration must encode to portable JSON
    config: Schema.Undefined
  })
  Node.make("UnknownConfig", {
    version: "1.0.0",
    // @ts-expect-error configuration must declare a portable JSON encoding
    config: Schema.Unknown
  })
  Node.make("UndefinedFailure", {
    version: "1.0.0",
    // @ts-expect-error failures must encode to portable JSON
    failure: Schema.Undefined
  })
  Node.make("UnknownFailure", {
    version: "1.0.0",
    // @ts-expect-error failures must declare a portable JSON encoding
    failure: Schema.Unknown
  })
}

void verifyPortableNodeSchemaTypes

class PrimaryDependency extends Context.Service<PrimaryDependency, {
  readonly prefix: string
}>()("@effect/workflow-builder/test/Node/PrimaryDependency") {}

class SecondaryDependency extends Context.Service<SecondaryDependency, {
  readonly suffix: string
}>()("@effect/workflow-builder/test/Node/SecondaryDependency") {}

class NodeLabel extends Context.Service<NodeLabel, string>()(
  "@effect/workflow-builder/test/Node/Label"
) {}

class NodePriority extends Context.Service<NodePriority, number>()(
  "@effect/workflow-builder/test/Node/Priority"
) {}

class ConfigDecoder extends Context.Service<ConfigDecoder, string>()(
  "@effect/workflow-builder/test/Node/ConfigDecoder"
) {}

class InputDecoder extends Context.Service<InputDecoder, string>()(
  "@effect/workflow-builder/test/Node/InputDecoder"
) {}

class OutputEncoder extends Context.Service<OutputEncoder, string>()(
  "@effect/workflow-builder/test/Node/OutputEncoder"
) {}

class FailureEncoder extends Context.Service<FailureEncoder, string>()(
  "@effect/workflow-builder/test/Node/FailureEncoder"
) {}

const config = Schema.Struct({
  prefix: Schema.String,
  attempts: Schema.NumberFromString
})

const inputs = {
  value: Port.input(Schema.String, { contract: "example/text" }),
  optional: Port.input(Schema.Number, {
    contract: "example/count",
    required: false
  }),
  batch: Port.input(Schema.Boolean, {
    contract: "example/flags",
    cardinality: "many"
  })
}

const outputs = {
  result: Port.output(Schema.String, { contract: "example/text" })
}

const failure = Schema.Literal("TransformFailure")

const custom = Node.make("Transform", {
  version: "2.0.0",
  description: "Transforms text",
  config,
  inputs,
  outputs,
  failure,
  dependencies: [PrimaryDependency]
})

const withDependencies = custom.addDependency(SecondaryDependency)

const serviceDefinition = Node.make("Serviceful", {
  version: "1.0.0",
  config: Schema.String as Schema.Codec<string, string, ConfigDecoder, never>,
  inputs: {
    value: Port.input(
      Schema.String as Schema.Codec<string, string, InputDecoder, never>,
      { contract: "example/text" }
    )
  },
  outputs: {
    value: Port.output(
      Schema.String as Schema.Codec<string, string, never, OutputEncoder>,
      { contract: "example/text" }
    )
  },
  failure: Schema.String as Schema.Codec<string, string, never, FailureEncoder>,
  dependencies: [PrimaryDependency]
}).addDependency(SecondaryDependency)

describe("Node", () => {
  it("creates definitions with fail-closed defaults", () => {
    const definition = Node.make("Noop", { version: "1.0.0" })

    assert.strictEqual(Node.TypeId, "@effect/workflow-builder/Node")
    assert.isDefined(definition[Node.TypeId])
    assert.strictEqual(definition.id, "@effect/workflow-builder/Node/Noop/1.0.0")
    assert.strictEqual(definition.type, "Noop")
    assert.strictEqual(definition.version, "1.0.0")
    assert.strictEqual(definition.description, undefined)
    assert.strictEqual(definition.configSchema, Node.EmptyConfig)
    assert.deepStrictEqual(definition.inputs, {})
    assert.deepStrictEqual(definition.outputs, {})
    assert.strictEqual(definition.failureSchema, Schema.Never)
    assert.deepStrictEqual(definition.annotations, Context.empty())
    assert.strictEqual(Node.key(definition.type, definition.version), "Noop@1.0.0")

    assertType<Types.Equals<Node.Type<typeof definition>, "Noop">>(true)
    assertType<Types.Equals<Node.Version<typeof definition>, "1.0.0">>(true)
    assertType<Types.Equals<Node.Config<typeof definition>, {}>>(true)
    assertType<Types.Equals<Node.InputValues<typeof definition>, {}>>(true)
    assertType<Types.Equals<Node.OutputValues<typeof definition>, {}>>(true)
    assertType<Types.Equals<Node.Failure<typeof definition>, never>>(true)
    assertType<Types.Equals<Node.Requirements<typeof definition>, never>>(true)
  })

  it("retains unforgeable provenance across derived definitions", () => {
    const annotated = custom.annotate(NodeLabel, "annotated")
    const merged = custom.annotateMerge(Context.make(NodePriority, 1))

    for (const definition of [custom, withDependencies, annotated, merged]) {
      assert.isTrue(Node.isDefinition(definition))
    }
    assert.isFalse(Node.isDefinition({ ...custom }))
    assert.isFalse(Node.isDefinition(new Proxy(custom, {})))
    assert.isFalse(Node.isDefinition(Object.freeze(Object.assign(
      Object.create({ [Node.TypeId]: true }),
      { type: custom.type, version: custom.version }
    ))))
  })

  it("retains custom schemas and metadata", () => {
    assert.strictEqual(custom.id, "@effect/workflow-builder/Node/Transform/2.0.0")
    assert.strictEqual(custom.type, "Transform")
    assert.strictEqual(custom.version, "2.0.0")
    assert.strictEqual(custom.description, "Transforms text")
    assert.strictEqual(custom.configSchema, config)
    assert.deepStrictEqual(custom.inputs, inputs)
    assert.deepStrictEqual(custom.outputs, outputs)
    assert.strictEqual(custom.failureSchema, failure)
    assert.isTrue(Object.isFrozen(custom))
    assert.isTrue(Object.isFrozen(custom.inputs))
    assert.isTrue(Object.isFrozen(custom.outputs))

    const originalInput = Port.input(Schema.String, { contract: "example/original" })
    const callerInputs: Record<string, Port.Input.Any> = { value: originalInput }
    const copied = Node.make("Copied", {
      version: "1.0.0",
      inputs: callerInputs
    })
    callerInputs.value = Port.input(Schema.String, { contract: "example/replacement" })
    assert.strictEqual(copied.inputs.value, originalInput)

    assertType<
      Types.Equals<Node.Config<typeof custom>, {
        readonly prefix: string
        readonly attempts: number
      }>
    >(true)
    assertType<
      Types.Equals<Node.InputValues<typeof custom>, {
        readonly value: string
        readonly optional: Option.Option<number>
        readonly batch: ReadonlyArray<boolean>
      }>
    >(true)
    assertType<
      Types.Equals<Node.OutputValues<typeof custom>, {
        readonly result: string
      }>
    >(true)
    assertType<Types.Equals<Node.Failure<typeof custom>, "TransformFailure">>(true)
    assertType<Types.Equals<Node.Requirements<typeof custom>, PrimaryDependency>>(true)
    assertType<
      Types.Equals<Node.Requirements<typeof withDependencies>, PrimaryDependency | SecondaryDependency>
    >(true)
  })

  it("adds and merges annotations without mutating the original definition", () => {
    const annotated = custom
      .annotate(NodeLabel, "transform")
      .annotateMerge(Context.make(NodePriority, 10))

    assert.deepStrictEqual(Context.getOption(custom.annotations, NodeLabel), Option.none())
    assert.deepStrictEqual(Context.getOption(custom.annotations, NodePriority), Option.none())
    assert.deepStrictEqual(Context.getOption(annotated.annotations, NodeLabel), Option.some("transform"))
    assert.deepStrictEqual(Context.getOption(annotated.annotations, NodePriority), Option.some(10))
    assert.notStrictEqual(annotated, custom)
    assert.notStrictEqual(withDependencies, custom)
    assert.strictEqual(withDependencies.configSchema, custom.configSchema)
  })

  it("infers config, port, failure, and handler service requirements", () => {
    assertType<Types.Equals<Node.ConfigDecodingServices<typeof serviceDefinition>, ConfigDecoder>>(true)
    assertType<Types.Equals<Node.InputDecodingServices<typeof serviceDefinition>, InputDecoder>>(true)
    assertType<Types.Equals<Node.OutputEncodingServices<typeof serviceDefinition>, OutputEncoder>>(true)
    assertType<Types.Equals<Node.FailureEncodingServices<typeof serviceDefinition>, FailureEncoder>>(true)
    assertType<
      Types.Equals<Node.Requirements<typeof serviceDefinition>, PrimaryDependency | SecondaryDependency>
    >(true)

    type Handler = Node.Handler<typeof withDependencies>
    assertType<Types.Equals<Parameters<Handler>[0]["config"], Node.Config<typeof custom>>>(true)
    assertType<Types.Equals<Parameters<Handler>[0]["inputs"], Node.InputValues<typeof custom>>>(true)
    assertType<Types.Equals<Effect.Success<ReturnType<Handler>>, Node.OutputValues<typeof custom>>>(true)
    assertType<Types.Equals<Effect.Error<ReturnType<Handler>>, "TransformFailure">>(true)
    assertType<Types.Equals<Effect.Services<ReturnType<Handler>>, PrimaryDependency | SecondaryDependency>>(true)
  })
})
