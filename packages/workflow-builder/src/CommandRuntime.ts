/**
 * Validates semantic commands at the workflow-definition boundary.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Command from "./Command.ts"
import type * as Compiler from "./Compiler.ts"
import * as Json from "./internal/json.ts"
import type * as Workflow from "./Workflow.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Stable machine-readable failures emitted by semantic command validation.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "InvalidJson",
  InvalidCommand: "InvalidCommand",
  InvalidWorkflowOutput: "InvalidWorkflowOutput"
} as const

/**
 * A stable machine-readable command-runtime failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandRuntimeErrorCode = typeof Codes[keyof typeof Codes]

const CommandRuntimeErrorCode = Schema.Literals([
  Codes.InvalidJson,
  Codes.InvalidCommand,
  Codes.InvalidWorkflowOutput
])

/**
 * Raised when a semantic command cannot safely cross its workflow-definition
 * boundary.
 *
 * @category errors
 * @since 4.0.0
 */
export class CommandRuntimeError extends Schema.TaggedErrorClass<CommandRuntimeError>(
  "@effect/workflow-builder/CommandRuntime/CommandRuntimeError"
)("CommandRuntimeError", {
  code: CommandRuntimeErrorCode,
  message: Schema.NonEmptyString,
  commandId: Schema.optionalKey(Schema.NonEmptyString),
  output: Schema.optionalKey(Schema.NonEmptyString),
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

/**
 * Effect services required to validate workflow-output commands.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Requirements<W extends Workflow.Any> = Workflow.OutputDecodingServices<W>

const makeError = (
  code: CommandRuntimeErrorCode,
  message: string,
  options: {
    readonly commandId?: string | undefined
    readonly output?: string | undefined
    readonly details?: Schema.Json | undefined
  } = {}
): CommandRuntimeError =>
  new CommandRuntimeError({
    code,
    message,
    ...(options.commandId === undefined ? undefined : { commandId: options.commandId }),
    ...(options.output === undefined ? undefined : { output: options.output }),
    ...(options.details === undefined ? undefined : { details: options.details })
  })

const runCodec = Effect.fnUntraced(function*<A, R>(
  construct: () => Effect.Effect<A, { readonly message: string }, R>,
  onFailure: (message: string) => CommandRuntimeError
): Effect.fn.Return<A, CommandRuntimeError, R> {
  const operation = yield* Effect.try({
    try: construct,
    catch: () => onFailure("Codec could not be prepared safely")
  })
  return yield* operation.pipe(
    Effect.mapError((error) => onFailure(error.message)),
    Effect.catchCauseIf(
      Cause.hasDies,
      () => Effect.fail(onFailure("Codec failed unexpectedly"))
    )
  )
})

const validateOutput = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>,
  command: Command.Command
): Effect.fn.Return<void, CommandRuntimeError, Requirements<W>> {
  if (command.payload._tag !== "SucceedRun") {
    return
  }

  const output = command.payload.output
  const connected = new Set(
    compiled.dataEdges.flatMap((edge) => edge.target.kind === "WorkflowOutput" ? [edge.target.port] : [])
  )
  const expectedNames = Object.entries(compiled.definition.outputs)
    .filter(([name, port]) => port.cardinality === "many" || port.required || connected.has(name))
    .map(([name]) => name)
    .sort()
  const actualNames = Object.keys(output).sort()
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    const mismatched = actualNames.find((name) => !expectedNames.includes(name)) ??
      expectedNames.find((name) => !actualNames.includes(name))
    return yield* Effect.fail(makeError(
      Codes.InvalidWorkflowOutput,
      "Successful command output keys must exactly match the compiled workflow outputs",
      {
        commandId: command.commandId,
        ...(mismatched === undefined ? undefined : { output: mismatched }),
        details: { expectedKeys: expectedNames, actualKeys: actualNames }
      }
    ))
  }

  for (const [name, port] of Object.entries(compiled.definition.outputs)) {
    const present = Object.prototype.hasOwnProperty.call(output, name)
    const outputError = (message: string, details?: Schema.Json) =>
      makeError(Codes.InvalidWorkflowOutput, message, {
        commandId: command.commandId,
        output: name,
        ...(details === undefined ? undefined : { details })
      })

    if (port.cardinality === "many") {
      if (!present) {
        return yield* Effect.fail(outputError(
          `Successful command is missing array workflow output '${name}'`
        ))
      }
      const encoded = output[name]
      if (!Array.isArray(encoded)) {
        return yield* Effect.fail(outputError(
          `Successful command workflow output '${name}' must be a JSON array`
        ))
      }
      if (port.required && encoded.length === 0) {
        return yield* Effect.fail(outputError(
          `Required many workflow output '${name}' must contain at least one value`
        ))
      }
      yield* Effect.forEach(
        encoded,
        (value, index) =>
          runCodec(
            () =>
              Schema.decodeUnknownEffect(port.schema)(value) as Effect.Effect<
                unknown,
                { readonly message: string },
                Requirements<W>
              >,
            (message) =>
              outputError(
                `Invalid encoded workflow output '${name}' at index ${index}: ${message}`,
                { index }
              )
          ),
        { concurrency: 1, discard: true }
      )
      continue
    }

    if (!present) {
      continue
    }
    yield* runCodec(
      () =>
        Schema.decodeUnknownEffect(port.schema)(output[name]) as Effect.Effect<
          unknown,
          { readonly message: string },
          Requirements<W>
        >,
      (message) => outputError(`Invalid encoded workflow output '${name}': ${message}`)
    )
  }
})

/**
 * Validates and snapshots one semantic command for a compiled workflow.
 *
 * **Details**
 *
 * Every command is first admitted as detached, recursively frozen strict JSON.
 * Successful-run outputs are then decoded through each target workflow-output
 * schema. One, many, required, and optional port shapes are enforced before a
 * caller can convert the command into a semantic history event.
 *
 * Codec construction throws and defects become typed
 * {@link CommandRuntimeError}s. Pure Effect interruption remains interruption.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = Effect.fnUntraced(function*<W extends Workflow.Any>(
  compiled: Compiler.CompiledPlan<W>,
  input: unknown
): Effect.fn.Return<Command.Command, CommandRuntimeError, Requirements<W>> {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return yield* Effect.fail(makeError(
      Codes.InvalidJson,
      `Semantic command must be strict JSON: ${snapped.failure.message}`,
      {
        details: {
          snapshotError: snapped.failure.message,
          path: [...snapped.failure.path]
        }
      }
    ))
  }

  yield* runCodec(
    () =>
      Schema.decodeUnknownEffect(Command.Command, strictParseOptions)(snapped.success) as Effect.Effect<
        Command.Command,
        { readonly message: string },
        never
      >,
    (message) => makeError(Codes.InvalidCommand, `Invalid semantic command: ${message}`)
  )

  const command = snapped.success as unknown as Command.Command
  yield* validateOutput(compiled, command)
  return command
})
