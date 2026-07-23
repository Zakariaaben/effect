/**
 * Strict command and event contracts for durable protocol version `3`
 * parent-child workflow execution.
 *
 * **Details**
 *
 * This module defines only portable wire facts and their cross-field
 * invariants. It does not authorize transitions, append history, start child
 * runs, or reduce state. Those responsibilities belong to a transactional
 * execution authority built on these contracts.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Child from "./ChildWorkflowV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Command envelope version defined by this module.
 *
 * @category constants
 * @since 4.0.0
 */
export const CommandVersion = 3 as const

/**
 * Event envelope version defined by this module.
 *
 * @category constants
 * @since 4.0.0
 */
export const EventVersion = 3 as const

/**
 * Execution protocol selected by every command and event in this module.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = Child.ExecutionProtocolVersion

/**
 * Returns the canonical child-call identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCallId = Child.childCallId

/**
 * Returns the canonical reserved child-run identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childRunId = Child.childRunId

/**
 * Returns the canonical durable child-start request identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartRequestId = Child.childStartRequestId

/**
 * Returns the shared canonical schedule command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleChildCommandId = Child.scheduleChildCommandId

/**
 * Returns the canonical parent projection identity for child start.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartProjectionEventId = Child.childStartProjectionEventId

/**
 * Returns the canonical parent projection identity for child termination.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childTerminalProjectionEventId = Child.childTerminalProjectionEventId

/**
 * Returns the canonical child-cancellation command and request-event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const requestChildCancellationCommandId = Child.requestChildCancellationCommandId

/**
 * Returns the canonical cancellation-acceptance projection identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCancellationAcceptedEventId = Child.childCancellationAcceptedEventId

/**
 * Returns the canonical cancellation-before-start identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCancelledBeforeStartEventId = Child.childCancelledBeforeStartEventId

/**
 * Returns the canonical abandon command and event identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const abandonChildEventId = Child.abandonChildEventId

/**
 * Returns the canonical permanent child-start failure identity.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartFailedEventId = Child.childStartFailedEventId

/**
 * A parent failure that selects the target's pinned failure close policy.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParentFailure = Schema.TaggedStruct("ParentFailure", {
  parentCauseEventId: Wire.SourceEventIdentifier
}).annotate({
  identifier: "WorkflowChildProtocolV3ParentFailure",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParentFailure}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentFailure = Schema.Schema.Type<typeof ParentFailure>

/**
 * A parent cancellation that selects the target's pinned cancellation policy.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParentCancellation = Schema.TaggedStruct("ParentCancellation", {
  parentCauseEventId: Wire.SourceEventIdentifier
}).annotate({
  identifier: "WorkflowChildProtocolV3ParentCancellation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParentCancellation}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentCancellation = Schema.Schema.Type<typeof ParentCancellation>

/**
 * Exact parent close causes admitted by child propagation commands and facts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParentCloseCause = Schema.Union([
  ParentFailure,
  ParentCancellation
]).annotate({
  identifier: "WorkflowChildProtocolV3ParentCloseCause",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParentCloseCause}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentCloseCause = Schema.Schema.Type<typeof ParentCloseCause>

/**
 * Child cancellation actions that retain a parent-child relation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationCloseAction = Schema.Literals([
  "CancelAndWait",
  "RequestCancel"
]).annotate({
  identifier: "WorkflowChildProtocolV3CancellationCloseAction"
})

/**
 * The decoded type of {@link CancellationCloseAction}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationCloseAction = Schema.Schema.Type<
  typeof CancellationCloseAction
>

/**
 * Permanent child-start failure classifications.
 *
 * **Details**
 *
 * `Rejected` means the start authority determined that retry cannot make the
 * pinned request admissible. `RetriesExhausted` means its finite operational
 * retry policy ended without an accepted child start. The encoded failure
 * remains separate from this stable classification.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildStartFailureKind = Schema.Literals([
  "Rejected",
  "RetriesExhausted"
]).annotate({
  identifier: "WorkflowChildProtocolV3StartFailureKind"
})

/**
 * The decoded type of {@link ChildStartFailureKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildStartFailureKind = Schema.Schema.Type<
  typeof ChildStartFailureKind
>

/**
 * Requests durable scheduling of one exactly pinned child relation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleChild = Schema.TaggedStruct("ScheduleChild", {
  inputContractDigest: Child.ContractDigest,
  encodedInput: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3ScheduleChild",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleChild}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleChild = Schema.Schema.Type<typeof ScheduleChild>

/**
 * Requests propagation of a parent close cause into an accepted child run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequestChildCancellation = Schema.TaggedStruct(
  "RequestChildCancellation",
  {
    parentCause: ParentCloseCause,
    closeAction: CancellationCloseAction
  }
).annotate({
  identifier: "WorkflowChildProtocolV3RequestChildCancellation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RequestChildCancellation}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequestChildCancellation = Schema.Schema.Type<
  typeof RequestChildCancellation
>

/**
 * Requests durable detachment from a child without cancelling or waiting.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AbandonChild = Schema.TaggedStruct("AbandonChild", {
  parentCause: ParentCloseCause,
  closeAction: Schema.Literal("Abandon")
}).annotate({
  identifier: "WorkflowChildProtocolV3AbandonChild",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AbandonChild}.
 *
 * @category models
 * @since 4.0.0
 */
export type AbandonChild = Schema.Schema.Type<typeof AbandonChild>

/**
 * Closed decision-command payload vocabulary for child execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CommandPayload = Schema.Union([
  ScheduleChild,
  RequestChildCancellation,
  AbandonChild
]).annotate({
  identifier: "WorkflowChildProtocolV3CommandPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CommandPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type CommandPayload = Schema.Schema.Type<typeof CommandPayload>

const CommandStruct = Schema.Struct({
  commandVersion: Schema.Literal(CommandVersion),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  tenantId: Wire.AtomicIdentifier,
  parentRunId: Wire.LineageIdentifier,
  callId: Wire.LineageIdentifier,
  commandId: Wire.Identifier,
  causationId: Wire.Identifier,
  correlationId: Wire.LineageIdentifier,
  relation: Child.ChildRelation,
  payload: CommandPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3CommandStruct",
  parseOptions: strictParseOptions
})

type CommandStruct = Schema.Schema.Type<typeof CommandStruct>

const selectedCloseAction = (
  relation: Child.ChildRelation,
  cause: ParentCloseCause
): Child.ChildCloseAction =>
  cause._tag === "ParentFailure"
    ? relation.target.closePolicy.onParentFailure
    : relation.target.closePolicy.onParentCancellation

const relationEnvelopeIssues = (
  relation: Child.ChildRelation,
  envelope: {
    readonly tenantId: string
    readonly parentRunId: string
    readonly callId: string
  },
  path: ReadonlyArray<string | number>
): Array<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  if (relation.parent.tenantId !== envelope.tenantId) {
    issues.push({
      path: [...path, "parent", "tenantId"],
      issue: "relation tenantId must equal the envelope tenantId"
    })
  }
  if (relation.parent.parentRunId !== envelope.parentRunId) {
    issues.push({
      path: [...path, "parent", "parentRunId"],
      issue: "relation parentRunId must equal the envelope parentRunId"
    })
  }
  if (relation.parent.callId !== envelope.callId) {
    issues.push({
      path: [...path, "parent", "callId"],
      issue: "relation callId must equal the envelope callId"
    })
  }
  return issues
}

const commandIssues = (
  command: CommandStruct
): ReadonlyArray<Schema.FilterIssue> => {
  const issues = relationEnvelopeIssues(command.relation, command, ["relation"])
  if (command.correlationId !== command.callId) {
    issues.push({
      path: ["correlationId"],
      issue: "child command correlationId must equal callId"
    })
  }

  const coordinates = [
    command.tenantId,
    command.parentRunId,
    command.callId
  ] as const

  switch (command.payload._tag) {
    case "ScheduleChild": {
      if (command.commandId !== scheduleChildCommandId(...coordinates)) {
        issues.push({
          path: ["commandId"],
          issue: "ScheduleChild commandId must be canonical"
        })
      }
      if (command.commandId !== command.relation.scheduleCommandId) {
        issues.push({
          path: ["relation", "scheduleCommandId"],
          issue: "relation scheduleCommandId must equal the envelope commandId"
        })
      }
      if (
        command.payload.inputContractDigest !==
          command.relation.target.inputContractDigest
      ) {
        issues.push({
          path: ["payload", "inputContractDigest"],
          issue: "input contract digest must equal the pinned child target digest"
        })
      }
      break
    }
    case "RequestChildCancellation": {
      const causeEventId = command.payload.parentCause.parentCauseEventId
      if (
        command.commandId !==
          requestChildCancellationCommandId(...coordinates, causeEventId)
      ) {
        issues.push({
          path: ["commandId"],
          issue: "RequestChildCancellation commandId must be canonical"
        })
      }
      if (command.causationId !== causeEventId) {
        issues.push({
          path: ["causationId"],
          issue: "cancellation command causationId must equal the parent cause event"
        })
      }
      if (
        selectedCloseAction(command.relation, command.payload.parentCause) !==
          command.payload.closeAction
      ) {
        issues.push({
          path: ["payload", "closeAction"],
          issue: "cancellation action must equal the target's pinned policy for this cause"
        })
      }
      break
    }
    case "AbandonChild": {
      const causeEventId = command.payload.parentCause.parentCauseEventId
      if (
        command.commandId !==
          abandonChildEventId(...coordinates, causeEventId)
      ) {
        issues.push({
          path: ["commandId"],
          issue: "AbandonChild commandId must be canonical"
        })
      }
      if (command.causationId !== causeEventId) {
        issues.push({
          path: ["causationId"],
          issue: "abandon command causationId must equal the parent cause event"
        })
      }
      if (
        selectedCloseAction(command.relation, command.payload.parentCause) !==
          "Abandon"
      ) {
        issues.push({
          path: ["payload", "closeAction"],
          issue: "abandon must equal the target's pinned policy for this cause"
        })
      }
      break
    }
  }
  return issues
}

/**
 * Strict relation-bound protocol version `3` child decision command.
 *
 * **Details**
 *
 * The full immutable relation is repeated deliberately. An authority can bind
 * a command to exact target, lineage, contract, and close-policy pins before
 * consulting mutable storage. Canonical identifiers remain consistency checks,
 * not authorization capabilities.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Command = CommandStruct.check(
  Schema.makeFilter(commandIssues)
).annotate({
  identifier: "WorkflowChildProtocolV3Command",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Command}.
 *
 * @category models
 * @since 4.0.0
 */
export type Command = Schema.Schema.Type<typeof Command>

/**
 * Records one durably scheduled child relation and its encoded input.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildScheduled = Schema.TaggedStruct("ChildScheduled", {
  relation: Child.ChildRelation,
  inputContractDigest: Child.ContractDigest,
  encodedInput: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildScheduled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildScheduled}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildScheduled = Schema.Schema.Type<typeof ChildScheduled>

/**
 * Projects the exact accepted child run-start fact into parent history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildStartAccepted = Schema.TaggedStruct("ChildStartAccepted", {
  childRunId: Wire.LineageIdentifier,
  startRequestId: Wire.LineageIdentifier,
  childRunStartedEventId: Wire.SourceEventIdentifier
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildStartAccepted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildStartAccepted}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildStartAccepted = Schema.Schema.Type<
  typeof ChildStartAccepted
>

/**
 * Records permanent failure to obtain an accepted child start.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildStartFailed = Schema.TaggedStruct("ChildStartFailed", {
  childRunId: Wire.LineageIdentifier,
  startRequestId: Wire.LineageIdentifier,
  failureKind: ChildStartFailureKind,
  failure: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildStartFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildStartFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildStartFailed = Schema.Schema.Type<typeof ChildStartFailed>

/**
 * Records durable propagation of one parent close cause to the child.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCancellationRequested = Schema.TaggedStruct(
  "ChildCancellationRequested",
  {
    childRunId: Wire.LineageIdentifier,
    parentCause: ParentCloseCause,
    closeAction: CancellationCloseAction,
    cancellationCommandId: Wire.Identifier
  }
).annotate({
  identifier: "WorkflowChildProtocolV3ChildCancellationRequested",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildCancellationRequested}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCancellationRequested = Schema.Schema.Type<
  typeof ChildCancellationRequested
>

/**
 * Projects authoritative acceptance of child cancellation into parent history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCancellationAccepted = Schema.TaggedStruct(
  "ChildCancellationAccepted",
  {
    childRunId: Wire.LineageIdentifier,
    parentCauseEventId: Wire.SourceEventIdentifier,
    cancellationCommandId: Wire.Identifier,
    childCancellationEventId: Wire.SourceEventIdentifier
  }
).annotate({
  identifier: "WorkflowChildProtocolV3ChildCancellationAccepted",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildCancellationAccepted}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCancellationAccepted = Schema.Schema.Type<
  typeof ChildCancellationAccepted
>

/**
 * Records cancellation that won atomically before child start acceptance.
 *
 * **Details**
 *
 * The tagged parent cause, repeated cause identifier, and selected close
 * action are retained as independent replay evidence. A reducer must bind the
 * selected action to the relation pinned by the preceding schedule fact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCancelledBeforeStart = Schema.TaggedStruct(
  "ChildCancelledBeforeStart",
  {
    childRunId: Wire.LineageIdentifier,
    startRequestId: Wire.LineageIdentifier,
    parentCause: ParentCloseCause,
    parentCauseEventId: Wire.SourceEventIdentifier,
    closeAction: CancellationCloseAction,
    cancellationCommandId: Wire.Identifier
  }
).annotate({
  identifier: "WorkflowChildProtocolV3ChildCancelledBeforeStart",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildCancelledBeforeStart}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCancelledBeforeStart = Schema.Schema.Type<
  typeof ChildCancelledBeforeStart
>

/**
 * Projects successful child termination and encoded output into parent history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildSucceeded = Schema.TaggedStruct("ChildSucceeded", {
  childRunId: Wire.LineageIdentifier,
  childTerminalEventId: Wire.SourceEventIdentifier,
  outputContractDigest: Child.ContractDigest,
  encodedOutput: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildSucceeded",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildSucceeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildSucceeded = Schema.Schema.Type<typeof ChildSucceeded>

/**
 * Projects failed child termination and its encoded failure into parent history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildFailed = Schema.TaggedStruct("ChildFailed", {
  childRunId: Wire.LineageIdentifier,
  childTerminalEventId: Wire.SourceEventIdentifier,
  failure: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildFailed = Schema.Schema.Type<typeof ChildFailed>

/**
 * Projects cancelled child termination and its encoded cause into parent history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCancelled = Schema.TaggedStruct("ChildCancelled", {
  childRunId: Wire.LineageIdentifier,
  childTerminalEventId: Wire.SourceEventIdentifier,
  cancellation: Wire.EncodedPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildCancelled",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildCancelled}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCancelled = Schema.Schema.Type<typeof ChildCancelled>

/**
 * Records durable detachment from a child without cancelling or waiting.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildAbandoned = Schema.TaggedStruct("ChildAbandoned", {
  childRunId: Wire.LineageIdentifier,
  parentCause: ParentCloseCause,
  closeAction: Schema.Literal("Abandon")
}).annotate({
  identifier: "WorkflowChildProtocolV3ChildAbandoned",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildAbandoned}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildAbandoned = Schema.Schema.Type<typeof ChildAbandoned>

/**
 * Closed semantic event payload vocabulary for child execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EventPayload = Schema.Union([
  ChildScheduled,
  ChildStartAccepted,
  ChildStartFailed,
  ChildCancellationRequested,
  ChildCancellationAccepted,
  ChildCancelledBeforeStart,
  ChildSucceeded,
  ChildFailed,
  ChildCancelled,
  ChildAbandoned
]).annotate({
  identifier: "WorkflowChildProtocolV3EventPayload",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EventPayload}.
 *
 * @category models
 * @since 4.0.0
 */
export type EventPayload = Schema.Schema.Type<typeof EventPayload>

const EventStruct = Schema.Struct({
  eventVersion: Schema.Literal(EventVersion),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  eventId: Wire.Identifier,
  tenantId: Wire.AtomicIdentifier,
  parentRunId: Wire.LineageIdentifier,
  callId: Wire.LineageIdentifier,
  sequence: Wire.NonNegativeSafeInt,
  recordedAt: Wire.Timestamp,
  causationId: Wire.Identifier,
  correlationId: Wire.LineageIdentifier,
  payload: EventPayload
}).annotate({
  identifier: "WorkflowChildProtocolV3EventStruct",
  parseOptions: strictParseOptions
})

type EventStruct = Schema.Schema.Type<typeof EventStruct>

const eventIssues = (
  event: EventStruct
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  if (event.correlationId !== event.callId) {
    issues.push({
      path: ["correlationId"],
      issue: "child event correlationId must equal callId"
    })
  }

  const coordinates = [
    event.tenantId,
    event.parentRunId,
    event.callId
  ] as const
  const expectedChildRunId = childRunId(...coordinates)
  const expectedStartRequestId = childStartRequestId(...coordinates)

  const expectChildRun = (actual: string): void => {
    if (actual !== expectedChildRunId) {
      issues.push({
        path: ["payload", "childRunId"],
        issue: "childRunId must be canonical for the event envelope"
      })
    }
  }
  const expectStartRequest = (actual: string): void => {
    if (actual !== expectedStartRequestId) {
      issues.push({
        path: ["payload", "startRequestId"],
        issue: "startRequestId must be canonical for the event envelope"
      })
    }
  }

  switch (event.payload._tag) {
    case "ChildScheduled": {
      issues.push(
        ...relationEnvelopeIssues(event.payload.relation, event, [
          "payload",
          "relation"
        ])
      )
      const expected = scheduleChildCommandId(...coordinates)
      if (event.eventId !== expected) {
        issues.push({
          path: ["eventId"],
          issue: "ChildScheduled eventId must be canonical"
        })
      }
      if (event.payload.relation.scheduleCommandId !== expected) {
        issues.push({
          path: ["payload", "relation", "scheduleCommandId"],
          issue: "scheduled relation must retain the canonical schedule identity"
        })
      }
      if (
        event.payload.inputContractDigest !==
          event.payload.relation.target.inputContractDigest
      ) {
        issues.push({
          path: ["payload", "inputContractDigest"],
          issue: "input contract digest must equal the pinned child target digest"
        })
      }
      break
    }
    case "ChildStartAccepted": {
      expectChildRun(event.payload.childRunId)
      expectStartRequest(event.payload.startRequestId)
      if (
        event.eventId !== childStartProjectionEventId(
          ...coordinates,
          event.payload.childRunStartedEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildStartAccepted eventId must be the canonical start projection"
        })
      }
      if (event.causationId !== event.payload.childRunStartedEventId) {
        issues.push({
          path: ["causationId"],
          issue: "start acceptance causationId must equal the child run-start event"
        })
      }
      break
    }
    case "ChildStartFailed": {
      expectChildRun(event.payload.childRunId)
      expectStartRequest(event.payload.startRequestId)
      if (
        event.eventId !== childStartFailedEventId(
          ...coordinates,
          event.payload.startRequestId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildStartFailed eventId must be canonical"
        })
      }
      if (event.causationId !== event.payload.startRequestId) {
        issues.push({
          path: ["causationId"],
          issue: "start failure causationId must equal the durable start request"
        })
      }
      break
    }
    case "ChildCancellationRequested": {
      expectChildRun(event.payload.childRunId)
      const parentCauseEventId = event.payload.parentCause.parentCauseEventId
      const expected = requestChildCancellationCommandId(
        ...coordinates,
        parentCauseEventId
      )
      if (
        event.payload.cancellationCommandId !== expected ||
        event.eventId !== expected
      ) {
        issues.push({
          path: ["payload", "cancellationCommandId"],
          issue: "cancellation request identities must be canonical and shared"
        })
      }
      if (event.causationId !== parentCauseEventId) {
        issues.push({
          path: ["causationId"],
          issue: "cancellation request causationId must equal the parent cause event"
        })
      }
      break
    }
    case "ChildCancellationAccepted": {
      expectChildRun(event.payload.childRunId)
      const expectedCommand = requestChildCancellationCommandId(
        ...coordinates,
        event.payload.parentCauseEventId
      )
      if (event.payload.cancellationCommandId !== expectedCommand) {
        issues.push({
          path: ["payload", "cancellationCommandId"],
          issue: "accepted cancellation must reference the canonical request"
        })
      }
      if (
        event.eventId !== childCancellationAcceptedEventId(
          ...coordinates,
          event.payload.childCancellationEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildCancellationAccepted eventId must be canonical"
        })
      }
      if (event.causationId !== event.payload.childCancellationEventId) {
        issues.push({
          path: ["causationId"],
          issue: "cancellation acceptance causationId must equal the child fact"
        })
      }
      break
    }
    case "ChildCancelledBeforeStart": {
      expectChildRun(event.payload.childRunId)
      expectStartRequest(event.payload.startRequestId)
      const parentCauseEventId = event.payload.parentCause.parentCauseEventId
      if (event.payload.parentCauseEventId !== parentCauseEventId) {
        issues.push({
          path: ["payload", "parentCauseEventId"],
          issue: "repeated parentCauseEventId must equal the tagged parent cause"
        })
      }
      const expectedCommand = requestChildCancellationCommandId(
        ...coordinates,
        parentCauseEventId
      )
      if (event.payload.cancellationCommandId !== expectedCommand) {
        issues.push({
          path: ["payload", "cancellationCommandId"],
          issue: "cancellation-before-start must reference the canonical request"
        })
      }
      if (
        event.eventId !== childCancelledBeforeStartEventId(
          ...coordinates,
          parentCauseEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildCancelledBeforeStart eventId must be canonical"
        })
      }
      if (event.causationId !== expectedCommand) {
        issues.push({
          path: ["causationId"],
          issue: "cancellation-before-start must be caused by its cancellation command"
        })
      }
      break
    }
    case "ChildSucceeded": {
      expectChildRun(event.payload.childRunId)
      if (
        event.eventId !== childTerminalProjectionEventId(
          ...coordinates,
          event.payload.childTerminalEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildSucceeded eventId must be the canonical terminal projection"
        })
      }
      if (event.causationId !== event.payload.childTerminalEventId) {
        issues.push({
          path: ["causationId"],
          issue: "child success causationId must equal the child terminal event"
        })
      }
      break
    }
    case "ChildFailed": {
      expectChildRun(event.payload.childRunId)
      if (
        event.eventId !== childTerminalProjectionEventId(
          ...coordinates,
          event.payload.childTerminalEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildFailed eventId must be the canonical terminal projection"
        })
      }
      if (event.causationId !== event.payload.childTerminalEventId) {
        issues.push({
          path: ["causationId"],
          issue: "child failure causationId must equal the child terminal event"
        })
      }
      break
    }
    case "ChildCancelled": {
      expectChildRun(event.payload.childRunId)
      if (
        event.eventId !== childTerminalProjectionEventId(
          ...coordinates,
          event.payload.childTerminalEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildCancelled eventId must be the canonical terminal projection"
        })
      }
      if (event.causationId !== event.payload.childTerminalEventId) {
        issues.push({
          path: ["causationId"],
          issue: "child cancellation causationId must equal the child terminal event"
        })
      }
      break
    }
    case "ChildAbandoned": {
      expectChildRun(event.payload.childRunId)
      const parentCauseEventId = event.payload.parentCause.parentCauseEventId
      if (
        event.eventId !== abandonChildEventId(
          ...coordinates,
          parentCauseEventId
        )
      ) {
        issues.push({
          path: ["eventId"],
          issue: "ChildAbandoned eventId must be canonical"
        })
      }
      if (event.causationId !== parentCauseEventId) {
        issues.push({
          path: ["causationId"],
          issue: "abandon causationId must equal the parent cause event"
        })
      }
      break
    }
  }
  return issues
}

/**
 * Strict immutable protocol version `3` parent-history child event.
 *
 * **Details**
 *
 * Child-originated start, cancellation, and terminal facts retain their exact
 * source event as causation. Decision-owned schedule, propagation, and abandon
 * facts use the shared canonical command/event identity where applicable.
 * Sequence legality remains a reducer invariant.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Event = EventStruct.check(
  Schema.makeFilter(eventIssues)
).annotate({
  identifier: "WorkflowChildProtocolV3Event",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Event}.
 *
 * @category models
 * @since 4.0.0
 */
export type Event = Schema.Schema.Type<typeof Event>

/**
 * Stable descriptor-safe protocol validation failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ValidationCodes = {
  InvalidCommand: "InvalidCommand",
  InvalidEvent: "InvalidEvent"
} as const

/**
 * A stable descriptor-safe protocol validation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ValidationCode = typeof ValidationCodes[keyof typeof ValidationCodes]

const ValidationCode = Schema.Literals([
  ValidationCodes.InvalidCommand,
  ValidationCodes.InvalidEvent
])

/**
 * Raised when detached child command or event data violates the V3 contract.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildWorkflowProtocolValidationError extends Schema.TaggedErrorClass<ChildWorkflowProtocolValidationError>(
  "@effect/workflow-builder/ChildWorkflowProtocolV3/ValidationError"
)("ChildWorkflowProtocolValidationError", {
  code: ValidationCode,
  message: Schema.NonEmptyString,
  path: Schema.Array(Schema.Union([
    Schema.String,
    Wire.NonNegativeSafeInt
  ]))
}, { parseOptions: strictParseOptions }) {}

type StrictDecoder<A> = (
  input: unknown
) => Result.Result<A, unknown>

const decodeCommand = Schema.decodeUnknownResult(Command, strictParseOptions)
const decodeEvent = Schema.decodeUnknownResult(Event, strictParseOptions)

const validate = <A>(
  input: unknown,
  code: ValidationCode,
  label: string,
  decoder: StrictDecoder<A>
): Result.Result<A, ChildWorkflowProtocolValidationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(
      new ChildWorkflowProtocolValidationError({
        code,
        message: `${label} must be bounded strict JSON: ${snapshot.failure.message}`,
        path: [...snapshot.failure.path]
      })
    )
  }

  let decoded: Result.Result<A, unknown>
  try {
    decoded = decoder(snapshot.success)
  } catch {
    return Result.fail(
      new ChildWorkflowProtocolValidationError({
        code,
        message: `${label} schema validation threw unexpectedly`,
        path: []
      })
    )
  }

  if (Result.isFailure(decoded)) {
    const failure = decoded.failure
    const message = typeof failure === "object" &&
        failure !== null &&
        "message" in failure &&
        typeof failure.message === "string"
      ? failure.message
      : String(failure)
    return Result.fail(
      new ChildWorkflowProtocolValidationError({
        code,
        message: `Invalid ${label}: ${message}`,
        path: []
      })
    )
  }

  return Result.succeed(snapshot.success as unknown as A)
}

/**
 * Detaches, recursively freezes, and validates one exact child command.
 *
 * **Details**
 *
 * Accessors, proxies that throw during descriptor inspection, cycles,
 * non-JSON values, excess properties, and non-canonical identities are
 * rejected without trusting caller-owned objects.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateCommand = (
  input: unknown
): Result.Result<Command, ChildWorkflowProtocolValidationError> =>
  validate(
    input,
    ValidationCodes.InvalidCommand,
    "protocol version 3 child command",
    decodeCommand
  )

/**
 * Detaches, recursively freezes, and validates one exact child event.
 *
 * **Details**
 *
 * The returned event is the frozen strict-JSON snapshot, never the original
 * caller-owned object.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateEvent = (
  input: unknown
): Result.Result<Event, ChildWorkflowProtocolValidationError> =>
  validate(
    input,
    ValidationCodes.InvalidEvent,
    "protocol version 3 child event",
    decodeEvent
  )
