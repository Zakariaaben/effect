import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Types from "effect/Types"
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

const stringInput = Port.input(Schema.String, { contract: "example/text" })
const numberInput = Port.input(Schema.NumberFromString, { contract: "example/count" })
const structOutput = Port.output(
  Schema.Struct({ value: Schema.String, count: Schema.Number }),
  { contract: "example/result" }
)
const undefinedOutput = Port.output(UndefinedFromNull, { contract: "example/undefined" })

const verifyPortablePortSchemaTypes = (): void => {
  Port.input(Schema.String, { contract: "example/text" })
  Port.input(Schema.NumberFromString, { contract: "example/count" })
  Port.output(Schema.Struct({ value: Schema.String }), { contract: "example/result" })
  Port.output(UndefinedFromNull, { contract: "example/undefined" })

  // @ts-expect-error undefined is not a portable encoded representation
  Port.input(Schema.Undefined, { contract: "example/undefined" })
  // @ts-expect-error unknown does not declare a portable encoded representation
  Port.input(Schema.Unknown, { contract: "example/unknown" })
  // @ts-expect-error undefined is not a portable encoded representation
  Port.output(Schema.Undefined, { contract: "example/undefined" })
  // @ts-expect-error unknown does not declare a portable encoded representation
  Port.output(Schema.Unknown, { contract: "example/unknown" })
}

void verifyPortablePortSchemaTypes

describe("Port", () => {
  it("retains the concrete types of portable payload codecs", () => {
    assert.strictEqual(stringInput.schema, Schema.String)
    assert.strictEqual(numberInput.schema, Schema.NumberFromString)
    assert.strictEqual(undefinedOutput.schema, UndefinedFromNull)
    assert.strictEqual(stringInput.cardinality, "one")
    assert.isTrue(stringInput.required)
    assert.strictEqual(structOutput.fanOut, "multiple")

    assertType<Types.Equals<Port.Input.Value<typeof stringInput>, string>>(true)
    assertType<Types.Equals<Port.Input.Value<typeof numberInput>, number>>(true)
    assertType<
      Types.Equals<Port.Output.Value<typeof structOutput>, {
        readonly value: string
        readonly count: number
      }>
    >(true)
    assertType<Types.Equals<Port.Output.Value<typeof undefinedOutput>, undefined>>(true)
    assertType<Types.Equals<Port.Input.Schema<typeof numberInput>["Encoded"], string>>(true)
    assertType<Types.Equals<Port.Output.Schema<typeof undefinedOutput>["Encoded"], null>>(true)
  })
})
