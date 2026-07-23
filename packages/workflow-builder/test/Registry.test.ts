import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Node from "../src/Node.ts"
import * as Port from "../src/Port.ts"
import * as Registry from "../src/Registry.ts"

const assertType = <T extends true>(value: T): void => {
  assert.isTrue(value)
}

const uppercase = Node.make("Uppercase", {
  version: "1.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(Schema.String, { contract: "example/text" })
  }
})

const length = Node.make("Length", {
  version: "2.0.0",
  inputs: {
    value: Port.input(Schema.String, { contract: "example/text" })
  },
  outputs: {
    value: Port.output(Schema.Number, { contract: "example/count" })
  }
})

const registry = Registry.make(uppercase, length)

const implementations = registry.of({
  "Uppercase@1.0.0": ({ inputs }) => Effect.succeed({ value: inputs.value.toUpperCase() }),
  "Length@2.0.0": ({ inputs }) => Effect.succeed({ value: inputs.value.length })
})

type Handlers = Registry.HandlersFrom<Registry.Definitions<typeof registry>>

class CapturedService extends Context.Service<CapturedService, {
  readonly value: string
}>()("@effect/workflow-builder/test/Registry/CapturedService") {}

class BuildService extends Context.Service<BuildService, {
  readonly enabled: boolean
}>()("@effect/workflow-builder/test/Registry/BuildService") {}

class BuildError {
  readonly _tag = "BuildError"
}

describe("Registry", () => {
  it("indexes definitions by stable type and version keys", () => {
    assert.deepStrictEqual(Object.keys(registry.definitions), ["Uppercase@1.0.0", "Length@2.0.0"])
    assert.strictEqual(registry.definitions["Uppercase@1.0.0"], uppercase)
    assert.strictEqual(registry.definitions["Length@2.0.0"], length)

    assertType<Types.Equals<keyof Registry.Definitions<typeof registry>, "Uppercase@1.0.0" | "Length@2.0.0">>(
      true
    )
    assertType<Types.Equals<Registry.Definitions<typeof registry>["Uppercase@1.0.0"], typeof uppercase>>(true)
    assertType<Types.Equals<Registry.Definitions<typeof registry>["Length@2.0.0"], typeof length>>(true)
  })

  it("reports duplicate definitions as data or throws for programmer configuration", () => {
    const result = Registry.fromIterable([uppercase, uppercase])

    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) {
      assert.instanceOf(result.failure, Registry.DuplicateDefinitionError)
      assert.strictEqual(result.failure._tag, "DuplicateDefinitionError")
      assert.strictEqual(result.failure.type, "Uppercase")
      assert.strictEqual(result.failure.version, "1.0.0")
    }

    assert.throws(
      () => Registry.make(uppercase, uppercase),
      Registry.DuplicateDefinitionError
    )
  })

  it("checks complete handler records while retaining their inferred functions", () => {
    assert.strictEqual(registry.of(implementations), implementations)

    assertType<Types.Equals<keyof Handlers, "Uppercase@1.0.0" | "Length@2.0.0">>(true)
    assertType<Types.Equals<Parameters<typeof registry.of>[0], Handlers>>(true)
    assertType<Types.Equals<ReturnType<typeof registry.of>, Handlers>>(true)
    assertType<Types.Equals<{} extends Pick<Handlers, "Uppercase@1.0.0"> ? true : false, false>>(true)
    assertType<Types.Equals<{} extends Pick<Handlers, "Length@2.0.0"> ? true : false, false>>(true)
    assertType<
      Types.Equals<Parameters<typeof implementations["Uppercase@1.0.0"]>[0]["inputs"], {
        readonly value: string
      }>
    >(true)
    assertType<
      Types.Equals<Effect.Success<ReturnType<typeof implementations["Length@2.0.0"]>>, {
        readonly value: number
      }>
    >(true)
  })

  it.effect("builds handlers, supports lookup, and captures the construction context", () =>
    Effect.gen(function*() {
      const service = yield* registry.toHandlers(Effect.gen(function*() {
        const buildService = yield* BuildService
        assert.isTrue(buildService.enabled)
        return implementations
      })).pipe(
        Effect.provideService(BuildService, { enabled: true }),
        Effect.provideService(CapturedService, { value: "captured" })
      )

      const uppercaseEntry = service.get("Uppercase", "1.0.0")
      const lengthEntry = service.get("Length", "2.0.0")

      assert.isDefined(uppercaseEntry)
      assert.isDefined(lengthEntry)
      assert.strictEqual(service.handlers.size, 2)
      assert.strictEqual(uppercaseEntry.definition, uppercase)
      assert.strictEqual(uppercaseEntry.handler, implementations["Uppercase@1.0.0"])
      assert.strictEqual(lengthEntry.definition, length)
      assert.strictEqual(lengthEntry.handler, implementations["Length@2.0.0"])
      assert.deepStrictEqual(
        Context.getOption(uppercaseEntry.context, CapturedService),
        Option.some({ value: "captured" })
      )
      assert.deepStrictEqual(
        Context.getOption(uppercaseEntry.context, BuildService),
        Option.some({ enabled: true })
      )
      assert.strictEqual(service.get("Uppercase", "9.0.0"), undefined)
      assert.strictEqual(service.get("Missing", "1.0.0"), undefined)
    }))

  it.effect("does not confuse composite type and version keys during lookup", () => {
    const composite = Node.make("a@b", {
      version: "c",
      outputs: {
        value: Port.output(Schema.String, { contract: "example/text" })
      }
    })
    const compositeRegistry = Registry.make(composite)

    return Effect.gen(function*() {
      const service = yield* compositeRegistry.toHandlers(compositeRegistry.of({
        "a@b@c": () => Effect.succeed({ value: "ok" })
      }))

      assert.strictEqual(service.get("a@b", "c")?.definition, composite)
      assert.strictEqual(service.get("a", "b@c"), undefined)
    })
  })

  it.effect("constructs a HandlerRegistry layer", () =>
    Effect.gen(function*() {
      const context = yield* Effect.scoped(Layer.build(registry.toLayer(implementations)))
      const service = Context.get(context, Registry.HandlerRegistry)

      assert.strictEqual(service.get("Uppercase", "1.0.0")?.definition, uppercase)
      assert.strictEqual(service.get("Length", "2.0.0")?.definition, length)
    }))

  it.effect("rejects a missing runtime implementation supplied through an adversarial cast", () =>
    Effect.gen(function*() {
      const missing = {
        "Uppercase@1.0.0": implementations["Uppercase@1.0.0"]
      } as unknown as Handlers

      const error = yield* Effect.flip(registry.toHandlers(missing))

      assert.instanceOf(error, Registry.InvalidHandlerError)
      assert.deepStrictEqual(
        error,
        new Registry.InvalidHandlerError({
          key: "Length@2.0.0",
          type: "Length",
          version: "2.0.0"
        })
      )
    }))

  it.effect("rejects an undefined runtime implementation while constructing a layer", () =>
    Effect.gen(function*() {
      const undefinedHandler = {
        ...implementations,
        "Length@2.0.0": undefined
      } as unknown as Handlers

      const error = yield* Effect.flip(Effect.scoped(Layer.build(registry.toLayer(undefinedHandler))))

      assert.instanceOf(error, Registry.InvalidHandlerError)
      assert.deepStrictEqual(
        error,
        new Registry.InvalidHandlerError({
          key: "Length@2.0.0",
          type: "Length",
          version: "2.0.0"
        })
      )
    }))

  it("preserves build errors and services in the handler and layer APIs", () => {
    const build = Effect.gen(function*() {
      yield* BuildService
      return yield* Effect.fail(new BuildError())
    }) as Effect.Effect<Handlers, BuildError, BuildService>
    const handlers = registry.toHandlers(build)
    const layer = registry.toLayer(build)

    assertType<Types.Equals<Effect.Error<typeof handlers>, BuildError | Registry.InvalidHandlerError>>(true)
    assertType<Types.Equals<Effect.Services<typeof handlers>, BuildService>>(true)
    assertType<Types.Equals<Layer.Error<typeof layer>, BuildError | Registry.InvalidHandlerError>>(true)
    assertType<Types.Equals<Layer.Services<typeof layer>, BuildService>>(true)
    assertType<Types.Equals<Layer.Success<typeof layer>, Registry.HandlerRegistry>>(true)
  })
})
