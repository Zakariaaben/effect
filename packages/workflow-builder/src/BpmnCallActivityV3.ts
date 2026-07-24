/**
 * Portable protocol-v3 foundations for executable BPMN CallActivity waits.
 *
 * **Details**
 *
 * This module binds one source-level `calledElement` QName to an exact
 * content-addressed child target and projects the existing ChildWorkflowV3
 * protocol into a JSON-persistable CallActivity frame. It owns no store,
 * scheduler, clock, worker, lease, backend, or transaction boundary.
 *
 * The child event list is intentionally small and authoritative for the
 * frame projection. Lifecycle legality is delegated to
 * `ChildWorkflowStateV3`; the non-JSON reducer state is never persisted.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnModel from "./BpmnModel.ts"
import * as ChildWorkflowProtocolV3 from "./ChildWorkflowProtocolV3.ts"
import * as ChildWorkflowStateV3 from "./ChildWorkflowStateV3.ts"
import * as ChildWorkflowV3 from "./ChildWorkflowV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Format version of an execution context retained by a BPMN parent run.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionContextVersion = 1 as const

/**
 * Format version of one compiled CallActivity binding.
 *
 * @category constants
 * @since 4.0.0
 */
export const CallActivityBindingVersion = 1 as const

/**
 * Format version of one portable backend locator.
 *
 * @category constants
 * @since 4.0.0
 */
export const BackendLocatorVersion = 1 as const

/**
 * Format version of one durable CallActivity frame.
 *
 * @category constants
 * @since 4.0.0
 */
export const CallFrameVersion = 1 as const

/**
 * Format version of a child-event ingress command.
 *
 * @category constants
 * @since 4.0.0
 */
export const ApplyChildEventCommandVersion = 1 as const

/**
 * Executable portable CallActivity profile implemented by this contract.
 *
 * **Details**
 *
 * `CancelAndWait` is the BPMN-synchronous close behavior. `RequestCancel`
 * and `Abandon` remain explicit workflow-engine extensions selected by the
 * exact child target; this identifier does not relabel them as BPMN behavior.
 *
 * @category constants
 * @since 4.0.0
 */
export const PortableChildProcessProfile = "PortableChildProcess/1" as const

/**
 * Hard ceiling for the canonical JSON representation of one encoded input.
 *
 * **Details**
 *
 * Blob payloads are bounded here by their immutable reference; an adapter
 * must additionally enforce the referenced `encodedBytes` against its blob
 * policy before dispatch.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumEncodedInputCanonicalBytes = 16 * 1_024 * 1_024

const PositiveEncodedInputBytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MaximumEncodedInputCanonicalBytes)
)

const ExecutionContextStruct = Schema.Struct({
  contextVersion: Schema.Literal(ExecutionContextVersion),
  executionProtocolVersion: Schema.Literal(
    ChildWorkflowV3.ExecutionProtocolVersion
  ),
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier,
  rootRunId: Wire.LineageIdentifier,
  artifactDigest: Wire.ArtifactDigest,
  workflowFamilyIdentity: Wire.Identifier,
  ancestry: ChildWorkflowV3.Ancestry
}).annotate({
  identifier: "WorkflowBpmnCallActivityV3ExecutionContextStruct",
  parseOptions: strictParseOptions
})

type ExecutionContextStruct = Schema.Schema.Type<
  typeof ExecutionContextStruct
>

const executionContextIssues = (
  context: ExecutionContextStruct
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  const first = context.ancestry[0]
  const last = context.ancestry[context.ancestry.length - 1]
  if (first?.runId !== context.rootRunId) {
    issues.push({
      path: ["rootRunId"],
      issue: "rootRunId must equal the first ancestry run"
    })
  }
  if (
    last === undefined ||
    last.runId !== context.runId ||
    last.artifactDigest !== context.artifactDigest ||
    last.workflowFamilyIdentity !== context.workflowFamilyIdentity
  ) {
    issues.push({
      path: ["ancestry", Math.max(0, context.ancestry.length - 1)],
      issue: "the final ancestry entry must exactly identify the parent run"
    })
  }
  const runIds = new Set<string>()
  const artifactDigests = new Set<string>()
  const workflowFamilies = new Set<string>()
  for (let index = 0; index < context.ancestry.length; index++) {
    const entry = context.ancestry[index]!
    if (entry.depth !== index) {
      issues.push({
        path: ["ancestry", index, "depth"],
        issue: "ancestry entry depth must equal its zero-based position"
      })
    }
    if (entry.tenantId !== context.tenantId) {
      issues.push({
        path: ["ancestry", index, "tenantId"],
        issue: "every ancestry entry must belong to the execution tenant"
      })
    }
    if (runIds.has(entry.runId)) {
      issues.push({
        path: ["ancestry", index, "runId"],
        issue: "ancestry must not repeat a run identifier"
      })
    }
    if (artifactDigests.has(entry.artifactDigest)) {
      issues.push({
        path: ["ancestry", index, "artifactDigest"],
        issue: "recursion-forbidden ancestry must not repeat an artifact"
      })
    }
    if (workflowFamilies.has(entry.workflowFamilyIdentity)) {
      issues.push({
        path: ["ancestry", index, "workflowFamilyIdentity"],
        issue: "recursion-forbidden ancestry must not repeat a workflow family"
      })
    }
    runIds.add(entry.runId)
    artifactDigests.add(entry.artifactDigest)
    workflowFamilies.add(entry.workflowFamilyIdentity)
  }
  return issues
}

/**
 * Exact root-through-parent identity needed to derive child relations.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExecutionContext = ExecutionContextStruct.check(
  Schema.makeFilter(executionContextIssues)
).annotate({
  identifier: "WorkflowBpmnCallActivityV3ExecutionContext",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExecutionContext}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutionContext = Schema.Schema.Type<
  typeof ExecutionContext
>

/**
 * Exact source QName, child target, and input mapper pinned by compilation.
 *
 * **Details**
 *
 * The expression result must be a complete protocol-v3 `EncodedPayload`.
 * The kernel never selects or guesses a codec.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CallActivityBinding = Schema.Struct({
  bindingVersion: Schema.Literal(CallActivityBindingVersion),
  executionProtocolVersion: Schema.Literal(
    ChildWorkflowV3.ExecutionProtocolVersion
  ),
  profileId: Schema.Literal(PortableChildProcessProfile),
  callActivityNodeId: Wire.AtomicIdentifier,
  calledElement: BpmnModel.ExpandedQName,
  target: ChildWorkflowV3.ChildTargetPin,
  encodedInputExpression: BpmnModel.Expression,
  maxEncodedInputCanonicalBytes: PositiveEncodedInputBytes
}).annotate({
  identifier: "WorkflowBpmnCallActivityV3Binding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CallActivityBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type CallActivityBinding = Schema.Schema.Type<
  typeof CallActivityBinding
>

/**
 * Backend-specific routing hint kept outside semantic child identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BackendLocator = Schema.Struct({
  locatorVersion: Schema.Literal(BackendLocatorVersion),
  backendId: Wire.AtomicIdentifier,
  executionId: Wire.Identifier
}).annotate({
  identifier: "WorkflowBpmnCallActivityV3BackendLocator",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BackendLocator}.
 *
 * @category models
 * @since 4.0.0
 */
export type BackendLocator = Schema.Schema.Type<
  typeof BackendLocator
>

/**
 * One relation-bound parent-close command retained until its policy barrier
 * is discharged.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParentCloseCommand = ChildWorkflowProtocolV3.Command.check(
  Schema.makeFilter(
    (command) =>
      command.payload._tag !== "ScheduleChild" ||
      [{
        path: ["payload", "_tag"],
        issue: "a parent-close command cannot schedule a child"
      }]
  )
).annotate({
  identifier: "WorkflowBpmnCallActivityV3ParentCloseCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParentCloseCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentCloseCommand = Schema.Schema.Type<
  typeof ParentCloseCommand
>

const CallFrameStruct = Schema.Struct({
  frameVersion: Schema.Literal(CallFrameVersion),
  executionProtocolVersion: Schema.Literal(
    ChildWorkflowV3.ExecutionProtocolVersion
  ),
  callFrameId: Wire.LineageIdentifier,
  callActivityNodeId: Wire.AtomicIdentifier,
  processId: Wire.AtomicIdentifier,
  scopeInstanceId: Wire.AtomicIdentifier,
  ownerTokenId: Wire.AtomicIdentifier,
  childEvents: Schema.NonEmptyArray(
    ChildWorkflowProtocolV3.Event
  ),
  parentCloseCommand: Schema.optionalKey(ParentCloseCommand),
  backendLocator: Schema.optionalKey(BackendLocator),
  enteredAt: Wire.Timestamp,
  updatedAt: Wire.Timestamp,
  exitedAt: Schema.optionalKey(Wire.Timestamp)
}).annotate({
  identifier: "WorkflowBpmnCallActivityV3FrameStruct",
  parseOptions: strictParseOptions
})

/**
 * JSON-persistable projection of one child relation history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CallFrame = CallFrameStruct.annotate({
  identifier: "WorkflowBpmnCallActivityV3Frame",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CallFrame}.
 *
 * @category models
 * @since 4.0.0
 */
export type CallFrame = Schema.Schema.Type<typeof CallFrame>

/**
 * One trusted-authority child fact presented to the BPMN parent kernel.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ApplyChildEventCommand = Schema.Struct({
  commandVersion: Schema.Literal(ApplyChildEventCommandVersion),
  executionProtocolVersion: Schema.Literal(
    ChildWorkflowV3.ExecutionProtocolVersion
  ),
  callFrameId: Wire.LineageIdentifier,
  event: ChildWorkflowProtocolV3.Event,
  backendLocator: Schema.optionalKey(BackendLocator)
}).check(
  Schema.makeFilter(
    (command) =>
      command.callFrameId === command.event.callId ||
      [{
        path: ["event", "callId"],
        issue: "child event callId must equal callFrameId"
      }]
  )
).annotate({
  identifier: "WorkflowBpmnCallActivityV3ApplyChildEventCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ApplyChildEventCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ApplyChildEventCommand = Schema.Schema.Type<
  typeof ApplyChildEventCommand
>

/**
 * Stable validation failure codes for this portable domain.
 *
 * @category constants
 * @since 4.0.0
 */
export const ValidationCodes = {
  InvalidExecutionContext: "InvalidExecutionContext",
  InvalidBinding: "InvalidBinding",
  InvalidBackendLocator: "InvalidBackendLocator",
  InvalidFrame: "InvalidFrame",
  InvalidCommand: "InvalidCommand",
  InvalidChildCommand: "InvalidChildCommand",
  InvalidCloseCommand: "InvalidCloseCommand",
  InvalidCloseEvent: "InvalidCloseEvent",
  InvalidRelation: "InvalidRelation",
  InvalidScheduledEvent: "InvalidScheduledEvent",
  InvalidChildHistory: "InvalidChildHistory"
} as const

/**
 * A stable validation failure code for this portable domain.
 *
 * @category models
 * @since 4.0.0
 */
export type ValidationCode = typeof ValidationCodes[keyof typeof ValidationCodes]

const ValidationCode = Schema.Literals([
  ValidationCodes.InvalidExecutionContext,
  ValidationCodes.InvalidBinding,
  ValidationCodes.InvalidBackendLocator,
  ValidationCodes.InvalidFrame,
  ValidationCodes.InvalidCommand,
  ValidationCodes.InvalidChildCommand,
  ValidationCodes.InvalidCloseCommand,
  ValidationCodes.InvalidCloseEvent,
  ValidationCodes.InvalidRelation,
  ValidationCodes.InvalidScheduledEvent,
  ValidationCodes.InvalidChildHistory
])

/**
 * Bounded detached-data validation failure.
 *
 * @category errors
 * @since 4.0.0
 */
export class CallActivityValidationError extends Schema.TaggedErrorClass<
  CallActivityValidationError
>("@effect/workflow-builder/BpmnCallActivityV3/ValidationError")(
  "CallActivityValidationError",
  {
    code: ValidationCode,
    message: Schema.NonEmptyString,
    path: Schema.Array(Schema.Union([
      Schema.String,
      Wire.NonNegativeSafeInt
    ]))
  },
  { parseOptions: strictParseOptions }
) {}

const validationError = (
  code: ValidationCode,
  message: string,
  path: ReadonlyArray<string | number> = []
): CallActivityValidationError =>
  new CallActivityValidationError({
    code,
    message,
    path: [...path]
  })

const validateWith = <A>(
  input: unknown,
  schema: Schema.Codec<A, Schema.Json>,
  code: ValidationCode,
  label: string
): Result.Result<A, CallActivityValidationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(validationError(
      code,
      `${label} must be bounded strict JSON: ${snapshot.failure.message}`,
      snapshot.failure.path
    ))
  }
  let decoded: Result.Result<A, unknown>
  try {
    decoded = Schema.decodeUnknownResult(
      schema,
      strictParseOptions
    )(snapshot.success)
  } catch {
    return Result.fail(validationError(
      code,
      `${label} validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(validationError(
      code,
      `Invalid ${label}: ${decoded.failure instanceof Error ? decoded.failure.message : String(decoded.failure)}`
    ))
    : Result.succeed(snapshot.success as unknown as A)
}

/**
 * Detaches and validates one parent execution context.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateExecutionContext = (
  input: unknown
): Result.Result<ExecutionContext, CallActivityValidationError> =>
  validateWith(
    input,
    ExecutionContext,
    ValidationCodes.InvalidExecutionContext,
    "CallActivity execution context"
  )

/**
 * Detaches and validates one compiled binding.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateBinding = (
  input: unknown
): Result.Result<CallActivityBinding, CallActivityValidationError> =>
  validateWith(
    input,
    CallActivityBinding,
    ValidationCodes.InvalidBinding,
    "CallActivity binding"
  )

/**
 * Detaches and validates one backend locator.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateBackendLocator = (
  input: unknown
): Result.Result<BackendLocator, CallActivityValidationError> =>
  validateWith(
    input,
    BackendLocator,
    ValidationCodes.InvalidBackendLocator,
    "CallActivity backend locator"
  )

/**
 * Detaches and validates one relation-bound parent-close command.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateParentCloseCommand = (
  input: unknown
): Result.Result<
  ParentCloseCommand,
  CallActivityValidationError
> =>
  validateWith(
    input,
    ParentCloseCommand,
    ValidationCodes.InvalidCloseCommand,
    "CallActivity parent-close command"
  )

/**
 * Detaches and validates one child-event ingress command.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateApplyChildEventCommand = (
  input: unknown
): Result.Result<
  ApplyChildEventCommand,
  CallActivityValidationError
> =>
  validateWith(
    input,
    ApplyChildEventCommand,
    ValidationCodes.InvalidCommand,
    "CallActivity child-event command"
  )

const decodeAtomicIdentifier = Schema.decodeUnknownResult(
  Wire.AtomicIdentifier,
  strictParseOptions
)

/**
 * Derives the canonical, recursion-checked child relation for one activation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const deriveRelation = (
  executionContextInput: unknown,
  bindingInput: unknown,
  nodeInstanceIdInput: unknown
): Result.Result<
  ChildWorkflowV3.ChildRelation,
  CallActivityValidationError
> => {
  const context = validateExecutionContext(executionContextInput)
  if (Result.isFailure(context)) return Result.fail(context.failure)
  const binding = validateBinding(bindingInput)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  const nodeSnapshot = Json.snapshot(nodeInstanceIdInput, {
    maxArrayLength: 1,
    maxContainers: 1,
    maxDepth: 1,
    maxEntries: 1,
    maxStringBytes: 4_096,
    maxTotalBytes: 4_096
  })
  if (Result.isFailure(nodeSnapshot)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidRelation,
      `CallActivity node instance id must be strict JSON: ${nodeSnapshot.failure.message}`
    ))
  }
  const nodeInstance = decodeAtomicIdentifier(nodeSnapshot.success)
  if (Result.isFailure(nodeInstance)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidRelation,
      "CallActivity node instance id must be one atomic identifier",
      ["nodeInstanceId"]
    ))
  }
  try {
    const callId = ChildWorkflowV3.childCallId(
      context.success.tenantId,
      context.success.runId,
      nodeInstance.success
    )
    const scheduleCommandId = ChildWorkflowV3.scheduleChildCommandId(
      context.success.tenantId,
      context.success.runId,
      callId
    )
    const relation = ChildWorkflowV3.validateChildRelation({
      relationVersion: 3,
      parent: {
        parentLinkVersion: 3,
        tenantId: context.success.tenantId,
        parentRunId: context.success.runId,
        parentArtifactDigest: context.success.artifactDigest,
        parentWorkflowFamilyIdentity: context.success.workflowFamilyIdentity,
        callId,
        nodeId: binding.success.callActivityNodeId,
        nodeInstanceId: nodeInstance.success,
        scheduleEventId: scheduleCommandId,
        rootRunId: context.success.rootRunId,
        lineageDepth: context.success.ancestry.length,
        ancestry: context.success.ancestry
      },
      target: binding.success.target,
      childRunId: ChildWorkflowV3.childRunId(
        context.success.tenantId,
        context.success.runId,
        callId
      ),
      startRequestId: ChildWorkflowV3.childStartRequestId(
        context.success.tenantId,
        context.success.runId,
        callId
      ),
      scheduleCommandId
    })
    return Result.isFailure(relation)
      ? Result.fail(validationError(
        ValidationCodes.InvalidRelation,
        relation.failure.message,
        relation.failure.path
      ))
      : Result.succeed(relation.success)
  } catch {
    return Result.fail(validationError(
      ValidationCodes.InvalidRelation,
      "CallActivity relation identity derivation failed"
    ))
  }
}

/**
 * Creates the canonical sequence-zero `ChildScheduled` fact.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeScheduledEvent = (
  relationInput: unknown,
  encodedInput: unknown,
  recordedAt: unknown,
  causationId: unknown
): Result.Result<
  ChildWorkflowProtocolV3.Event,
  CallActivityValidationError
> => {
  const relation = ChildWorkflowV3.validateChildRelation(
    relationInput
  )
  if (Result.isFailure(relation)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidScheduledEvent,
      relation.failure.message,
      relation.failure.path
    ))
  }
  const candidate = {
    eventVersion: ChildWorkflowProtocolV3.EventVersion,
    executionProtocolVersion: ChildWorkflowProtocolV3.ExecutionProtocolVersion,
    eventId: relation.success.scheduleCommandId,
    tenantId: relation.success.parent.tenantId,
    parentRunId: relation.success.parent.parentRunId,
    callId: relation.success.parent.callId,
    sequence: 0,
    recordedAt,
    causationId,
    correlationId: relation.success.parent.callId,
    payload: {
      _tag: "ChildScheduled",
      relation: relation.success,
      inputContractDigest: relation.success.target.inputContractDigest,
      encodedInput
    }
  }
  const event = ChildWorkflowProtocolV3.validateEvent(candidate)
  return Result.isFailure(event)
    ? Result.fail(validationError(
      ValidationCodes.InvalidScheduledEvent,
      event.failure.message,
      event.failure.path
    ))
    : Result.succeed(event.success)
}

/**
 * Creates the exact portable egress command for one scheduled child.
 *
 * **Details**
 *
 * The command is intended for an outbox committed atomically with the parent
 * state. Executing it is an adapter concern and never occurs inside the pure
 * BPMN kernel.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeScheduleCommand = (
  relationInput: unknown,
  encodedInput: unknown,
  causationId: unknown
): Result.Result<
  ChildWorkflowProtocolV3.Command,
  CallActivityValidationError
> => {
  const relation = ChildWorkflowV3.validateChildRelation(
    relationInput
  )
  if (Result.isFailure(relation)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidChildCommand,
      relation.failure.message,
      relation.failure.path
    ))
  }
  const candidate = {
    commandVersion: ChildWorkflowProtocolV3.CommandVersion,
    executionProtocolVersion: ChildWorkflowProtocolV3.ExecutionProtocolVersion,
    tenantId: relation.success.parent.tenantId,
    parentRunId: relation.success.parent.parentRunId,
    callId: relation.success.parent.callId,
    commandId: relation.success.scheduleCommandId,
    causationId,
    correlationId: relation.success.parent.callId,
    relation: relation.success,
    payload: {
      _tag: "ScheduleChild",
      inputContractDigest: relation.success.target.inputContractDigest,
      encodedInput
    }
  }
  const command = ChildWorkflowProtocolV3.validateCommand(candidate)
  return Result.isFailure(command)
    ? Result.fail(validationError(
      ValidationCodes.InvalidChildCommand,
      command.failure.message,
      command.failure.path
    ))
    : Result.succeed(command.success)
}

const decodeParentCloseCause = Schema.decodeUnknownResult(
  ChildWorkflowProtocolV3.ParentCloseCause,
  strictParseOptions
)

const sameParentCloseCause = (
  left: ChildWorkflowProtocolV3.ParentCloseCause,
  right: ChildWorkflowProtocolV3.ParentCloseCause
): boolean =>
  left._tag === right._tag &&
  left.parentCauseEventId === right.parentCauseEventId

/**
 * Creates the exact relation-bound command selected by a child target's
 * cause-specific parent-close policy.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeParentCloseCommand = (
  relationInput: unknown,
  parentCauseInput: unknown
): Result.Result<
  ParentCloseCommand,
  CallActivityValidationError
> => {
  const relation = ChildWorkflowV3.validateChildRelation(
    relationInput
  )
  if (Result.isFailure(relation)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseCommand,
      relation.failure.message,
      relation.failure.path
    ))
  }
  const causeSnapshot = Json.snapshot(parentCauseInput)
  if (Result.isFailure(causeSnapshot)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseCommand,
      `Parent close cause must be bounded strict JSON: ${causeSnapshot.failure.message}`,
      causeSnapshot.failure.path
    ))
  }
  const cause = decodeParentCloseCause(causeSnapshot.success)
  if (Result.isFailure(cause)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseCommand,
      "Invalid parent close cause"
    ))
  }
  const closeAction = cause.success._tag === "ParentFailure"
    ? relation.success.target.closePolicy.onParentFailure
    : relation.success.target.closePolicy.onParentCancellation
  try {
    const commandId = closeAction === "Abandon"
      ? ChildWorkflowV3.abandonChildEventId(
        relation.success.parent.tenantId,
        relation.success.parent.parentRunId,
        relation.success.parent.callId,
        cause.success.parentCauseEventId
      )
      : ChildWorkflowV3.requestChildCancellationCommandId(
        relation.success.parent.tenantId,
        relation.success.parent.parentRunId,
        relation.success.parent.callId,
        cause.success.parentCauseEventId
      )
    return validateParentCloseCommand({
      commandVersion: ChildWorkflowProtocolV3.CommandVersion,
      executionProtocolVersion: ChildWorkflowProtocolV3.ExecutionProtocolVersion,
      tenantId: relation.success.parent.tenantId,
      parentRunId: relation.success.parent.parentRunId,
      callId: relation.success.parent.callId,
      commandId,
      causationId: cause.success.parentCauseEventId,
      correlationId: relation.success.parent.callId,
      relation: relation.success,
      payload: closeAction === "Abandon"
        ? {
          _tag: "AbandonChild",
          parentCause: cause.success,
          closeAction
        }
        : {
          _tag: "RequestChildCancellation",
          parentCause: cause.success,
          closeAction
        }
    })
  } catch {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseCommand,
      "CallActivity parent-close identity derivation failed"
    ))
  }
}

/**
 * Creates the local parent-history close fact when the reducer can commit it
 * without pretending to arbitrate a backend start race.
 *
 * **Details**
 *
 * A scheduled child and a cancellation command return `undefined`: the
 * start authority must next project either `ChildCancelledBeforeStart` or
 * `ChildStartAccepted`. An accepted start lets the parent commit
 * `ChildCancellationRequested` in the same ingress transaction.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeParentCloseEvent = (
  frameInput: unknown,
  commandInput: unknown,
  recordedAt: unknown
): Result.Result<
  ChildWorkflowProtocolV3.Event | undefined,
  CallActivityValidationError
> => {
  const frame = decodeFrame(frameInput)
  if (Result.isFailure(frame)) {
    return Result.fail(frame.failure)
  }
  const command = validateParentCloseCommand(commandInput)
  if (Result.isFailure(command)) {
    return Result.fail(command.failure)
  }
  const child = foldDecodedFrame(frame.success, false)
  if (Result.isFailure(child)) {
    return Result.fail(child.failure)
  }
  if (
    command.success.callId !== frame.success.callFrameId ||
    !canonicalEquals(
      command.success.relation,
      child.success.relation
    )
  ) {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseEvent,
      "Parent-close command does not belong to the CallActivity frame"
    ))
  }
  if (ChildWorkflowStateV3.isTerminal(child.success)) {
    return Result.succeed(undefined)
  }
  const payload = command.success.payload
  if (payload._tag === "ScheduleChild") {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseCommand,
      "A parent-close command cannot schedule a child"
    ))
  }
  let eventPayload:
    | ChildWorkflowProtocolV3.EventPayload
    | undefined
  if (payload._tag === "AbandonChild") {
    if (child.success.close._tag !== "Open") {
      return Result.fail(validationError(
        ValidationCodes.InvalidCloseEvent,
        "Abandon cannot replace an existing child close request"
      ))
    }
    eventPayload = {
      _tag: "ChildAbandoned",
      childRunId: child.success.relation.childRunId,
      parentCause: payload.parentCause,
      closeAction: "Abandon"
    }
  } else if (child.success.phase._tag === "Scheduled") {
    return Result.succeed(undefined)
  } else if (child.success.phase._tag === "Running") {
    eventPayload = {
      _tag: "ChildCancellationRequested",
      childRunId: child.success.relation.childRunId,
      parentCause: payload.parentCause,
      closeAction: payload.closeAction,
      cancellationCommandId: command.success.commandId
    }
  } else if (
    child.success.close._tag === "CancellationRequested" ||
    child.success.close._tag === "CancellationAccepted"
  ) {
    return sameParentCloseCause(
        child.success.close.parentCause,
        payload.parentCause
      ) &&
        child.success.close.closeAction === payload.closeAction &&
        child.success.close.cancellationCommandId ===
          command.success.commandId
      ? Result.succeed(undefined)
      : Result.fail(validationError(
        ValidationCodes.InvalidCloseEvent,
        "Parent-close command conflicts with the live child cancellation"
      ))
  } else {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseEvent,
      `Child phase '${child.success.phase._tag}' cannot accept this parent-close command`
    ))
  }
  const event = ChildWorkflowProtocolV3.validateEvent({
    eventVersion: ChildWorkflowProtocolV3.EventVersion,
    executionProtocolVersion: ChildWorkflowProtocolV3.ExecutionProtocolVersion,
    eventId: command.success.commandId,
    tenantId: child.success.tenantId,
    parentRunId: child.success.parentRunId,
    callId: child.success.callId,
    sequence: child.success.sequence + 1,
    recordedAt,
    causationId: command.success.causationId,
    correlationId: child.success.callId,
    payload: eventPayload
  })
  if (Result.isFailure(event)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidCloseEvent,
      event.failure.message,
      event.failure.path
    ))
  }
  const reduced = ChildWorkflowStateV3.reduce(
    child.success,
    event.success
  )
  return Result.isFailure(reduced)
    ? Result.fail(validationError(
      ValidationCodes.InvalidCloseEvent,
      reduced.failure.message
    ))
    : Result.succeed(event.success)
}

const decodeFrame = (
  input: unknown
): Result.Result<CallFrame, CallActivityValidationError> =>
  validateWith(
    input,
    CallFrameStruct,
    ValidationCodes.InvalidFrame,
    "CallActivity frame"
  )

const foldDecodedFrame = (
  frame: CallFrame,
  validateCloseCommand = true
): Result.Result<
  ChildWorkflowStateV3.ChildWorkflowState,
  CallActivityValidationError
> => {
  const folded = ChildWorkflowStateV3.fold(frame.childEvents)
  if (Result.isFailure(folded)) {
    return Result.fail(validationError(
      ValidationCodes.InvalidChildHistory,
      folded.failure.message,
      folded.failure.historyIndex === undefined
        ? []
        : ["childEvents", folded.failure.historyIndex]
    ))
  }
  const state = folded.success
  if (
    frame.callFrameId !== state.relation.parent.callId ||
    frame.callActivityNodeId !== state.relation.parent.nodeId ||
    frame.ownerTokenId !==
      state.relation.parent.nodeInstanceId ||
    frame.enteredAt !== state.scheduledAt ||
    frame.updatedAt < frame.enteredAt
  ) {
    return Result.fail(validationError(
      ValidationCodes.InvalidFrame,
      "CallActivity frame coordinates or parent timestamps do not match its child history"
    ))
  }
  if (validateCloseCommand) {
    const closeCommand = frame.parentCloseCommand
    if (closeCommand === undefined) {
      if (state.close._tag !== "Open") {
        return Result.fail(validationError(
          ValidationCodes.InvalidFrame,
          "A child close fact requires its exact committed parent-close command",
          ["parentCloseCommand"]
        ))
      }
    } else {
      if (
        closeCommand.callId !== state.callId ||
        !canonicalEquals(closeCommand.relation, state.relation)
      ) {
        return Result.fail(validationError(
          ValidationCodes.InvalidFrame,
          "CallActivity parent-close command does not match the child relation",
          ["parentCloseCommand"]
        ))
      }
      const payload = closeCommand.payload
      if (payload._tag === "ScheduleChild") {
        return Result.fail(validationError(
          ValidationCodes.InvalidFrame,
          "CallActivity parent-close command cannot schedule a child",
          ["parentCloseCommand", "payload"]
        ))
      }
      if (payload._tag === "AbandonChild") {
        if (
          state.phase._tag !== "Abandoned" ||
          state.close._tag !== "Abandoned" ||
          state.phase.abandonEventId !== closeCommand.commandId ||
          !sameParentCloseCause(
            state.close.parentCause,
            payload.parentCause
          )
        ) {
          return Result.fail(validationError(
            ValidationCodes.InvalidFrame,
            "An AbandonChild command requires its exact terminal child fact",
            ["parentCloseCommand"]
          ))
        }
      } else if (state.close._tag === "Open") {
        if (
          state.phase._tag !== "Scheduled" &&
          state.phase._tag !== "StartFailed"
        ) {
          return Result.fail(validationError(
            ValidationCodes.InvalidFrame,
            "An accepted child start must project its committed cancellation request",
            ["parentCloseCommand"]
          ))
        }
      } else if (
        state.close._tag === "CancellationRequested" ||
        state.close._tag === "CancellationAccepted" ||
        state.close._tag === "CancelledBeforeStart"
      ) {
        if (
          !sameParentCloseCause(
            state.close.parentCause,
            payload.parentCause
          ) ||
          state.close.closeAction !== payload.closeAction ||
          state.close.cancellationCommandId !==
            closeCommand.commandId
        ) {
          return Result.fail(validationError(
            ValidationCodes.InvalidFrame,
            "Child cancellation history conflicts with its committed parent-close command",
            ["parentCloseCommand"]
          ))
        }
      } else {
        return Result.fail(validationError(
          ValidationCodes.InvalidFrame,
          "Child close history conflicts with its committed parent-close command",
          ["parentCloseCommand"]
        ))
      }
    }
  }
  const terminal = ChildWorkflowStateV3.isTerminal(state)
  if (
    terminal
      ? frame.exitedAt === undefined ||
        frame.exitedAt !== frame.updatedAt
      : frame.exitedAt !== undefined
  ) {
    return Result.fail(validationError(
      ValidationCodes.InvalidFrame,
      terminal
        ? "A terminal CallActivity frame must exit at its final parent commit"
        : "A non-terminal CallActivity frame cannot record exitedAt",
      ["exitedAt"]
    ))
  }
  return Result.succeed(state)
}

/**
 * Rebuilds the exact non-persisted child state from one frame.
 *
 * @category folding
 * @since 4.0.0
 */
export const foldFrame = (
  input: unknown
): Result.Result<
  ChildWorkflowStateV3.ChildWorkflowState,
  CallActivityValidationError
> => {
  const frame = decodeFrame(input)
  return Result.isFailure(frame)
    ? Result.fail(frame.failure)
    : foldDecodedFrame(frame.success)
}

/**
 * Rebuilds child history while allowing one atomically incomplete
 * parent-close projection.
 *
 * **Details**
 *
 * This is a kernel-only staging boundary: callers must append the required
 * local close fact and finish with {@link validateFrame} before exposing
 * state.
 *
 * @category folding
 * @since 4.0.0
 */
export const foldFrameHistory = (
  input: unknown
): Result.Result<
  ChildWorkflowStateV3.ChildWorkflowState,
  CallActivityValidationError
> => {
  const frame = decodeFrame(input)
  return Result.isFailure(frame)
    ? Result.fail(frame.failure)
    : foldDecodedFrame(frame.success, false)
}

/**
 * Detaches and validates a frame and its complete child relation history.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateFrame = (
  input: unknown
): Result.Result<CallFrame, CallActivityValidationError> => {
  const frame = decodeFrame(input)
  if (Result.isFailure(frame)) return frame
  const folded = foldDecodedFrame(frame.success)
  return Result.isFailure(folded)
    ? Result.fail(folded.failure)
    : Result.succeed(frame.success)
}

/**
 * Derives whether a parent terminal transition may pass this CallActivity.
 *
 * **Details**
 *
 * A durable `RequestCancel` command is sufficient to release the parent even
 * while start arbitration is pending. `CancelAndWait` remains blocked until
 * an authoritative terminal child fact arrives.
 *
 * @category getters
 * @since 4.0.0
 */
export const parentCloseBarrier = (
  input: unknown
): Result.Result<
  ChildWorkflowStateV3.ParentCloseBarrier,
  CallActivityValidationError
> => {
  const frame = validateFrame(input)
  if (Result.isFailure(frame)) {
    return Result.fail(frame.failure)
  }
  const child = foldDecodedFrame(frame.success)
  if (Result.isFailure(child)) {
    return Result.fail(child.failure)
  }
  if (ChildWorkflowStateV3.isTerminal(child.success)) {
    return Result.succeed("Discharged")
  }
  const command = frame.success.parentCloseCommand
  if (command === undefined) {
    return Result.succeed(
      ChildWorkflowStateV3.parentCloseBarrier(child.success)
    )
  }
  switch (command.payload._tag) {
    case "ScheduleChild":
      return Result.fail(validationError(
        ValidationCodes.InvalidFrame,
        "A parent-close barrier cannot use ScheduleChild"
      ))
    case "AbandonChild":
      return Result.succeed("Discharged")
    case "RequestChildCancellation":
      return Result.succeed(
        command.payload.closeAction === "RequestCancel"
          ? "Discharged"
          : "WaitingForChildTerminal"
      )
  }
}

/**
 * Canonically compares two bounded strict-JSON values without invoking
 * accessors. Invalid values are never equal.
 *
 * @category predicates
 * @since 4.0.0
 */
export const canonicalEquals = (
  left: unknown,
  right: unknown
): boolean => {
  const leftSnapshot = Json.snapshot(left)
  if (Result.isFailure(leftSnapshot)) return false
  const rightSnapshot = Json.snapshot(right)
  if (Result.isFailure(rightSnapshot)) return false
  try {
    return Json.canonicalizeSnapshot(leftSnapshot.success) ===
      Json.canonicalizeSnapshot(rightSnapshot.success)
  } catch {
    return false
  }
}

/**
 * Exact semantic equality of two compiled CallActivity bindings.
 *
 * @category predicates
 * @since 4.0.0
 */
export const bindingEquals = (
  left: unknown,
  right: unknown
): boolean => {
  const a = validateBinding(left)
  const b = validateBinding(right)
  return Result.isSuccess(a) &&
    Result.isSuccess(b) &&
    canonicalEquals(a.success, b.success)
}
