/**
 * Converts semantic workflow commands into immutable history-event drafts.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Command from "./Command.ts"
import type * as Event from "./Event.ts"
import type * as HistoryStore from "./HistoryStore.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Stable machine-readable failures emitted by command conversion.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "InvalidJson",
  InvalidCommand: "InvalidCommand"
} as const

/**
 * A stable machine-readable command-conversion failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandEventErrorCode = typeof Codes[keyof typeof Codes]

const CommandEventErrorCode = Schema.Literals([
  Codes.InvalidJson,
  Codes.InvalidCommand
])

/**
 * Raised when unknown input cannot be safely converted into a history-event
 * draft.
 *
 * @category errors
 * @since 4.0.0
 */
export class CommandEventError extends Schema.TaggedErrorClass<CommandEventError>(
  "@effect/workflow-builder/CommandEvent/CommandEventError"
)("CommandEventError", {
  code: CommandEventErrorCode,
  message: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json)
}, { parseOptions: strictParseOptions }) {}

const decodeCommand = Schema.decodeUnknownResult(Command.Command, strictParseOptions)

const invalidJson = (error: Json.JsonSnapshotError): CommandEventError =>
  new CommandEventError({
    code: Codes.InvalidJson,
    message: `Command is not strict JSON: ${error.message}`,
    details: {
      snapshotError: error.message,
      path: [...error.path]
    }
  })

const invalidCommand = (
  message: string,
  details?: Schema.Json
): CommandEventError =>
  new CommandEventError({
    code: Codes.InvalidCommand,
    message,
    ...(details === undefined ? undefined : { details })
  })

const mapPayload = (payload: Command.Payload): Event.Payload => {
  switch (payload._tag) {
    case "ScheduleActivity":
      return {
        _tag: "ActivityScheduled",
        activityId: payload.activityId,
        nodeId: payload.nodeId,
        nodeInstanceId: payload.nodeInstanceId,
        attempt: payload.attempt,
        idempotencyKey: payload.idempotencyKey,
        input: payload.input
      }
    case "SucceedRun":
      return {
        _tag: "RunSucceeded",
        output: payload.output
      }
    case "FailRun":
      return {
        _tag: "RunFailed",
        failure: payload.failure
      }
    case "CancelRun":
      return { _tag: "RunCancelled" }
  }
}

/**
 * Converts one strict semantic command into an immutable event draft.
 *
 * **Details**
 *
 * The unknown input is inspected through property descriptors and detached
 * before schema validation, so accessors are never invoked. The command
 * identifier becomes the event identifier, making an exact repeated decision
 * an exact history-store retry. Causation and correlation are deliberately not
 * inferred at this boundary.
 *
 * A failed-run event retains the complete activity-failure wrapper, including
 * activity, node-instance, and attempt attribution.
 *
 * @category converting
 * @since 4.0.0
 */
export const fromCommand = (
  input: unknown
): Result.Result<HistoryStore.EventDraft, CommandEventError> => {
  const snapped = Json.snapshot(input)
  if (Result.isFailure(snapped)) {
    return Result.fail(invalidJson(snapped.failure))
  }

  let decoded: Result.Result<Command.Command, { readonly message: string }>
  try {
    decoded = decodeCommand(snapped.success)
  } catch {
    return Result.fail(invalidCommand("Command schema validation threw unexpectedly"))
  }
  if (Result.isFailure(decoded)) {
    return Result.fail(invalidCommand("Invalid semantic command", {
      parseError: decoded.failure.message
    }))
  }

  const command = snapped.success as unknown as Command.Command
  const draft = Json.snapshot({
    eventVersion: 1,
    eventId: command.commandId,
    payload: mapPayload(command.payload)
  })
  if (Result.isFailure(draft)) {
    return Result.fail(invalidCommand("Converted event draft is not strict JSON", {
      snapshotError: draft.failure.message,
      path: [...draft.failure.path]
    }))
  }
  return Result.succeed(draft.success as unknown as HistoryStore.EventDraft)
}
