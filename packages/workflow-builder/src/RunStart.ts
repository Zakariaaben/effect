/**
 * Constructs immutable, pinned start-event drafts for admitted workflow runs.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Decision from "./Decision.ts"
import type * as Event from "./Event.ts"
import type * as HistoryStore from "./HistoryStore.ts"
import * as Identity from "./Identity.ts"
import * as Json from "./internal/json.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Stable machine-readable failures emitted while constructing a run start.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidConfiguration: "InvalidConfiguration",
  InvalidInput: "InvalidInput"
} as const

/**
 * A stable machine-readable run-start failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type RunStartErrorCode = typeof Codes[keyof typeof Codes]

const RunStartErrorCode = Schema.Literals([
  Codes.InvalidConfiguration,
  Codes.InvalidInput
])

/**
 * Raised when a run-start configuration or workflow input cannot be admitted
 * safely.
 *
 * @category errors
 * @since 4.0.0
 */
export class RunStartError extends Schema.TaggedErrorClass<RunStartError>(
  "@effect/workflow-builder/RunStart/RunStartError"
)("RunStartError", {
  code: RunStartErrorCode,
  runId: Schema.String,
  message: Schema.NonEmptyString,
  input: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Execution boundary selected for the new run.
 *
 * @category models
 * @since 4.0.0
 */
export type Backend = "direct" | "durable"

/**
 * Explicit configuration for one new workflow run.
 *
 * @category configuration
 * @since 4.0.0
 */
export interface Options {
  readonly runId: string
  readonly backend: Backend
}

/**
 * Effect services required to encode the workflow inputs of a prepared plan.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> = Workflow.InputEncodingServices<W>

interface CapturedProperty {
  readonly key: PropertyKey
  readonly descriptor: PropertyDescriptor
}

const makeError = (
  code: RunStartErrorCode,
  runId: string,
  message: string,
  options: {
    readonly input?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): RunStartError =>
  new RunStartError({
    code,
    runId,
    message,
    ...(options.input === undefined ? undefined : { input: options.input }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const inputError = (
  runId: string,
  message: string,
  input?: string,
  details?: Schema.Json
): RunStartError =>
  makeError(Codes.InvalidInput, runId, message, {
    ...(input === undefined ? undefined : { input }),
    ...(details === undefined ? undefined : { details })
  })

const captureInput = Effect.fnUntraced(function*(
  input: unknown,
  runId: string
): Effect.fn.Return<ReadonlyArray<CapturedProperty>, RunStartError> {
  if (typeof input !== "object" || input === null) {
    return yield* Effect.fail(inputError(runId, "Workflow input must be an object"))
  }

  const captured = yield* Effect.try({
    try: () => {
      const prototype = Object.getPrototypeOf(input)
      const descriptors = Object.getOwnPropertyDescriptors(input)
      const properties = Reflect.ownKeys(descriptors).map((key): CapturedProperty => ({
        key,
        descriptor: Reflect.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor
      }))
      return { prototype, properties } as const
    },
    catch: () => inputError(runId, "Workflow input could not be inspected safely")
  })

  if (captured.prototype !== Object.prototype && captured.prototype !== null) {
    return yield* Effect.fail(inputError(
      runId,
      "Workflow input must have Object.prototype or null as its prototype"
    ))
  }
  return captured.properties
})

const isEnumerableDataProperty = (descriptor: PropertyDescriptor): boolean =>
  descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value")

const encodeInput = Effect.fnUntraced(function*<A, R>(
  construct: () => Effect.Effect<A, { readonly message: string }, R>,
  runId: string,
  input: string
): Effect.fn.Return<A, RunStartError, R> {
  const operation = yield* Effect.try({
    try: construct,
    catch: () =>
      inputError(
        runId,
        `Workflow input '${input}' codec could not be prepared safely`,
        input,
        { input }
      )
  })
  return yield* operation.pipe(
    Effect.mapError((error) =>
      inputError(
        runId,
        `Workflow input '${input}' could not be encoded: ${error.message}`,
        input,
        { input }
      )
    ),
    Effect.catchCauseIf(
      Cause.hasDies,
      () =>
        Effect.fail(inputError(
          runId,
          `Workflow input '${input}' codec failed unexpectedly`,
          input,
          { input }
        ))
    )
  )
})

/**
 * Returns the deterministic v1 identity of a run's start event.
 *
 * **Details**
 *
 * A versioned JSON tuple preserves the run-identifier boundary without relying
 * on delimiter conventions. The input is expected to be an admitted nonempty
 * run identifier; this helper does not perform validation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const eventId = (runId: string): string => Identity.runStartedEventId(runId)

/**
 * Constructs the immutable start-event draft for an already prepared plan.
 *
 * **Details**
 *
 * The workflow input is inspected through captured property descriptors, so
 * top-level accessors are rejected without invocation. Each declared value is
 * encoded by its source-port schema and detached through the strict-JSON
 * boundary before the complete draft is recursively frozen.
 *
 * This function only constructs semantic intent. It does not create a history,
 * select a store, or infer correlation and causation identifiers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*<W extends Workflow.Any>(
  plan: Decision.DecidablePlan<W>,
  input: Workflow.InputValues<W>,
  options: Options
): Effect.fn.Return<
  HistoryStore.EventDraft<Event.RunStarted>,
  RunStartError,
  Requirements<W>
> {
  const runId = typeof options.runId === "string" ? options.runId : ""
  if (runId.length === 0) {
    return yield* Effect.fail(makeError(
      Codes.InvalidConfiguration,
      runId,
      "Run start requires a non-empty runId"
    ))
  }
  if (options.backend !== "direct" && options.backend !== "durable") {
    return yield* Effect.fail(makeError(
      Codes.InvalidConfiguration,
      runId,
      "Run start backend must be 'direct' or 'durable'"
    ))
  }
  if (!Decision.isPrepared(plan)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidConfiguration,
      runId,
      "Run start requires a plan produced by Decision.prepare"
    ))
  }

  const declared = Object.entries(plan.compiled.definition.inputs)
  const declaredNames = new Set(declared.map(([name]) => name))
  const captured = yield* captureInput(input, runId)
  const inputValues = new Map<string, unknown>()

  for (const property of captured) {
    if (typeof property.key !== "string") {
      return yield* Effect.fail(inputError(
        runId,
        "Workflow input must not contain symbol properties"
      ))
    }
    if (!isEnumerableDataProperty(property.descriptor)) {
      return yield* Effect.fail(inputError(
        runId,
        `Workflow input '${property.key}' must be an enumerable data property`,
        property.key
      ))
    }
    if (!declaredNames.has(property.key)) {
      return yield* Effect.fail(inputError(
        runId,
        `Unknown workflow input '${property.key}'`,
        property.key
      ))
    }
    inputValues.set(property.key, property.descriptor.value)
  }

  const encodedEntries: Array<readonly [string, Schema.Json]> = []
  for (const [name, port] of declared) {
    if (!inputValues.has(name)) {
      return yield* Effect.fail(inputError(
        runId,
        `Workflow input is missing declared input '${name}'`,
        name
      ))
    }
    const encoded = yield* encodeInput(
      () => Schema.encodeUnknownEffect(port.schema)(inputValues.get(name)),
      runId,
      name
    )
    const snapped = Json.snapshot(encoded)
    if (Result.isFailure(snapped)) {
      return yield* Effect.fail(inputError(
        runId,
        `Workflow input '${name}' must encode to strict JSON: ${snapped.failure.message}`,
        name,
        {
          input: name,
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      ))
    }
    encodedEntries.push([name, snapped.success])
  }

  const draft = Json.snapshot({
    eventVersion: 1,
    eventId: eventId(runId),
    payload: {
      _tag: "RunStarted",
      planId: plan.compiled.plan.id,
      planRevision: plan.compiled.plan.revision,
      definitionId: plan.compiled.definition.id,
      definitionVersion: plan.compiled.definition.version,
      compilerVersion: plan.compilerVersion,
      compiledFingerprint: plan.compiledFingerprint,
      backend: options.backend,
      input: Object.fromEntries(encodedEntries)
    }
  })
  if (Result.isFailure(draft)) {
    return yield* Effect.fail(inputError(
      runId,
      `Run start draft must be strict JSON: ${draft.failure.message}`,
      undefined,
      {
        snapshotError: draft.failure.message,
        path: [...draft.failure.path]
      }
    ))
  }
  return draft.success as unknown as HistoryStore.EventDraft<Event.RunStarted>
})
