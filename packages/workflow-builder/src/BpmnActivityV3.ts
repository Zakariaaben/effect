/**
 * Pure protocol-v3 bindings and durable outcome references for executable
 * BPMN tasks.
 *
 * **Details**
 *
 * This module contains no Effect Workflow runtime integration. A trusted
 * adapter may translate an authenticated protocol-v3 retry result into a
 * {@link TaskOutcome}; the BPMN kernel only validates that portable outcome
 * against the immutable task binding committed by its executable
 * fingerprint.
 *
 * Business failures become BPMN Errors only through an exact, compiled
 * {@link ErrorMapping}. Defects, operational cancellation, BPMN Cancel, and
 * boundary timers are deliberately absent from this vocabulary.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString

/**
 * Version of the BPMN-to-protocol-v3 task-binding contract.
 *
 * @category constants
 * @since 4.0.0
 */
export const BindingVersion = 1 as const

/**
 * Version of the portable logical-task outcome summary.
 *
 * @category constants
 * @since 4.0.0
 */
export const OutcomeVersion = 1 as const

/**
 * Version of the task-resolution command.
 *
 * @category constants
 * @since 4.0.0
 */
export const CommandVersion = 1 as const

/**
 * Version of one durable activity-resolution record.
 *
 * @category constants
 * @since 4.0.0
 */
export const ResolutionVersion = 1 as const

/**
 * Exact promotion of one protocol-v3 application-failure identity to one
 * declared BPMN Error root element.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ErrorMapping = Schema.Struct({
  identity: ActivityPolicyV3.FailureIdentity,
  errorRef: Identifier
}).annotate({
  identifier: "WorkflowBpmnActivityV3ErrorMapping",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ErrorMapping}.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorMapping = Schema.Schema.Type<typeof ErrorMapping>

/**
 * Immutable executable identity selected by one BPMN task.
 *
 * **Details**
 *
 * `artifactDigest` commits the complete verified protocol-v3 artifact;
 * `semanticNodeId` selects the exact node binding inside it. Error mappings
 * are compiled authority and are never accepted from a completion command.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskBinding = Schema.Struct({
  bindingVersion: Schema.Literal(BindingVersion),
  executionProtocolVersion: Schema.Literal(3),
  taskNodeId: Identifier,
  artifactDigest: Wire.ArtifactDigest,
  semanticNodeId: Wire.AtomicIdentifier,
  errorMappings: Schema.Array(ErrorMapping)
}).annotate({
  identifier: "WorkflowBpmnActivityV3TaskBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskBinding = Schema.Schema.Type<typeof TaskBinding>

const OutcomeCoordinates = {
  outcomeVersion: Schema.Literal(OutcomeVersion),
  artifactDigest: Wire.ArtifactDigest,
  semanticNodeId: Wire.AtomicIdentifier,
  occurrenceDigest: Wire.OccurrenceDigest,
  firstActivityDigest: Wire.OperationDigest
} as const

/**
 * Successful completion of one logical protocol-v3 task invocation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskSucceeded = Schema.TaggedStruct("Succeeded", {
  ...OutcomeCoordinates,
  attempt: Wire.PositiveSafeInt,
  completedActivityDigest: Wire.OperationDigest
}).annotate({
  identifier: "WorkflowBpmnActivityV3TaskSucceeded",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskSucceeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskSucceeded = Schema.Schema.Type<typeof TaskSucceeded>

/**
 * Terminal application failure after protocol-v3 retry policy evaluation.
 *
 * **Details**
 *
 * This is a routing summary, not the failure payload. The native activity
 * history identified by the operation digests remains authoritative for the
 * encoded payload and complete retry explanation.
 *
 * @category schemas
 * @since 4.0.0
 */
const PolicyOverrideDecision = Schema.TaggedStruct("PolicyOverride", {
  decisionVersion: Schema.Literal(1),
  matchedBy: Schema.Literals(["ErrorTag", "ErrorCode"])
})

const ClassifierDecision = Schema.TaggedStruct("Classifier", {
  decisionVersion: Schema.Literal(1),
  classificationActivityDigest: Wire.OperationDigest
})

/**
 * Closed non-retryable explanation retained without importing the native
 * retry runtime facade.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NonRetryableTerminal = Schema.TaggedStruct("NonRetryable", {
  terminalVersion: Schema.Literal(1),
  decision: Schema.Union([
    PolicyOverrideDecision,
    ClassifierDecision
  ])
}).annotate({
  identifier: "WorkflowBpmnActivityV3NonRetryableTerminal",
  parseOptions: strictParseOptions
})

/**
 * Closed exhausted-retry explanation retained without importing the native
 * retry runtime facade.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExhaustedTerminal = Schema.TaggedStruct("Exhausted", {
  terminalVersion: Schema.Literal(1),
  classificationActivityDigest: Wire.OperationDigest,
  reason: ActivityPolicyV3.RetryDeniedReason
}).annotate({
  identifier: "WorkflowBpmnActivityV3ExhaustedTerminal",
  parseOptions: strictParseOptions
})

/**
 * Exact terminal retry summary needed for durable idempotency.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BusinessFailureTerminal = Schema.Union([
  NonRetryableTerminal,
  ExhaustedTerminal
]).annotate({
  identifier: "WorkflowBpmnActivityV3BusinessFailureTerminal",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BusinessFailureTerminal}.
 *
 * @category models
 * @since 4.0.0
 */
export type BusinessFailureTerminal = Schema.Schema.Type<
  typeof BusinessFailureTerminal
>

export const TaskBusinessFailed = Schema.TaggedStruct("BusinessFailed", {
  ...OutcomeCoordinates,
  terminal: BusinessFailureTerminal,
  failedActivityDigest: Wire.OperationDigest,
  attempt: Wire.PositiveSafeInt,
  identity: ActivityPolicyV3.FailureIdentity
}).annotate({
  identifier: "WorkflowBpmnActivityV3TaskBusinessFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskBusinessFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskBusinessFailed = Schema.Schema.Type<
  typeof TaskBusinessFailed
>

/**
 * Closed outcome vocabulary admitted by the semantic BPMN task slice.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskOutcome = Schema.Union([
  TaskSucceeded,
  TaskBusinessFailed
]).annotate({
  identifier: "WorkflowBpmnActivityV3TaskOutcome",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskOutcome}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskOutcome = Schema.Schema.Type<typeof TaskOutcome>

/**
 * Durable idempotency record for one resolved task token.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityResolution = Schema.Struct({
  resolutionVersion: Schema.Literal(ResolutionVersion),
  tokenId: Identifier,
  taskNodeId: Identifier,
  scopeInstanceId: Identifier,
  outcome: TaskOutcome,
  resolvedAt: Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnActivityV3ActivityResolution",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityResolution}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityResolution = Schema.Schema.Type<
  typeof ActivityResolution
>

/**
 * Optimistic resolution of one exact waiting task token.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolveTaskCommand = Schema.Struct({
  commandVersion: Schema.Literal(CommandVersion),
  scopeInstanceId: Identifier,
  taskNodeId: Identifier,
  tokenId: Identifier,
  outcome: TaskOutcome
}).annotate({
  identifier: "WorkflowBpmnActivityV3ResolveTaskCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResolveTaskCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolveTaskCommand = Schema.Schema.Type<
  typeof ResolveTaskCommand
>

/**
 * Collision-free identity key used to canonicalize exact failure mappings.
 *
 * @category identity
 * @since 4.0.0
 */
export const failureIdentityKey = (
  identity: ActivityPolicyV3.FailureIdentity
): string =>
  JSON.stringify([
    identity.errorTag,
    identity.errorCode
  ])
