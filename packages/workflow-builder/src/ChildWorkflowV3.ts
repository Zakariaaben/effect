/**
 * Strict, immutable parent-child workflow protocol foundations for execution
 * protocol version `3`.
 *
 * **Details**
 *
 * This module is deliberately independent from protocol version `2`. It
 * defines portable pins, lineage, relation admission, reducer-owned phase
 * types, and collision-free identities. Phases are structural projections,
 * never independently admitted state: the sibling history reducer is their
 * sole authority. Starting child runs and atomically coordinating parent and
 * child histories remain execution-authority concerns.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as IdentityV3 from "./IdentityV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Execution protocol selected by child workflow foundations in this module.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 3 as const

/**
 * Canonical identity tuple version used by child workflow foundations.
 *
 * @category constants
 * @since 4.0.0
 */
export const IdentityVersion = IdentityV3.IdentityVersion

/**
 * Maximum child depth, and therefore maximum retained ancestry length.
 *
 * **Details**
 *
 * Roots have depth `0`. A parent link for a child at depth `n` contains
 * exactly `n` root-through-parent entries. The fixed protocol ceiling bounds
 * persisted state and cannot change underneath replay.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumLineageDepth = 64 as const

/**
 * Returns the stable identity of one child call site in a parent run.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCallId = IdentityV3.childCallId

/**
 * Returns the deterministic run identifier reserved for one child relation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childRunId = IdentityV3.childRunId

/**
 * Returns the deterministic durable-start request identifier for one child.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartRequestId = IdentityV3.childStartRequestId

/**
 * Returns the shared schedule command and event identity for one child call.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scheduleChildCommandId = IdentityV3.scheduleChildCommandId

/**
 * Returns the parent projection identity for a canonical child start event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartProjectionEventId = IdentityV3.childStartProjectionEventId

/**
 * Returns the parent projection identity for a canonical child terminal event.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childTerminalProjectionEventId = IdentityV3.childTerminalProjectionEventId

/**
 * Returns the cancellation command identity for one parent close cause.
 *
 * @category constructors
 * @since 4.0.0
 */
export const requestChildCancellationCommandId = IdentityV3.requestChildCancellationCommandId

/**
 * Returns the parent acknowledgement identity for a child cancellation fact.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCancellationAcceptedEventId = IdentityV3.childCancellationAcceptedEventId

/**
 * Returns the terminal relation identity when close wins before child start.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childCancelledBeforeStartEventId = IdentityV3.childCancelledBeforeStartEventId

/**
 * Returns the durable abandon identity for one parent close cause.
 *
 * @category constructors
 * @since 4.0.0
 */
export const abandonChildEventId = IdentityV3.abandonChildEventId

/**
 * Returns the durable identity of a permanent child-start failure.
 *
 * @category constructors
 * @since 4.0.0
 */
export const childStartFailedEventId = IdentityV3.childStartFailedEventId

/**
 * Returns the canonical recursion family identity for one workflow definition.
 *
 * @category constructors
 * @since 4.0.0
 */
export const workflowFamilyIdentity = IdentityV3.workflowFamilyIdentity

const ChildDepth = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MaximumLineageDepth)
).annotate({ identifier: "WorkflowChildV3Depth" })

const AncestorDepth = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MaximumLineageDepth - 1)
).annotate({ identifier: "WorkflowChildV3AncestorDepth" })

/**
 * A digest pin for an encoded child input or output contract.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ContractDigest = Wire.ContractDigest

/**
 * The decoded type of {@link ContractDigest}.
 *
 * @category models
 * @since 4.0.0
 */
export type ContractDigest = Schema.Schema.Type<typeof ContractDigest>

/**
 * A parent-close action whose exact meaning is pinned into a child target.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildCloseAction = Schema.Literals([
  "CancelAndWait",
  "RequestCancel",
  "Abandon"
]).annotate({ identifier: "WorkflowChildV3CloseAction" })

/**
 * The decoded type of {@link ChildCloseAction}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCloseAction = Schema.Schema.Type<typeof ChildCloseAction>

/**
 * Immutable close behavior selected independently for failure and cancellation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildClosePolicy = Schema.Struct({
  closePolicyVersion: Schema.Literal(3),
  onParentFailure: ChildCloseAction,
  onParentCancellation: ChildCloseAction
}).annotate({
  identifier: "WorkflowChildV3ClosePolicy",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildClosePolicy}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildClosePolicy = Schema.Schema.Type<typeof ChildClosePolicy>

const PlanPin = Schema.Struct({
  id: Wire.AtomicIdentifier,
  revision: Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowChildV3PlanPin",
  parseOptions: strictParseOptions
})

const DefinitionPin = Schema.Struct({
  id: Wire.AtomicIdentifier,
  version: Wire.AtomicIdentifier,
  deploymentId: Wire.AtomicIdentifier,
  buildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowChildV3DefinitionPin",
  parseOptions: strictParseOptions
})

const ChildTargetPinStruct = Schema.Struct({
  targetVersion: Schema.Literal(3),
  artifactVersion: Schema.Literal(3),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  artifactDigest: Wire.ArtifactDigest,
  plan: PlanPin,
  compilerSemanticVersion: Schema.Literal("2"),
  compiledFingerprint: Wire.CompiledFingerprint,
  definition: DefinitionPin,
  workflowFamilyIdentity: Wire.Identifier,
  inputContractDigest: ContractDigest,
  outputContractDigest: ContractDigest,
  closePolicy: ChildClosePolicy,
  recursionPolicy: Schema.Literal("Forbid"),
  maxLineageDepth: ChildDepth
}).annotate({
  identifier: "WorkflowChildV3TargetPinStruct",
  parseOptions: strictParseOptions
})

const targetFamilyIdentityMatches = (
  target: Schema.Schema.Type<typeof ChildTargetPinStruct>
): boolean =>
  target.workflowFamilyIdentity ===
    IdentityV3.workflowFamilyIdentity(target.definition.id)

/**
 * Exact content, compiler, deployment, contract, and close-policy pins for one
 * protocol version `3` child workflow target.
 *
 * **Details**
 *
 * Structural validation proves that the family identity is derived from the
 * definition identifier. Artifact-content and executable-build verification
 * remain admission-authority responsibilities; a canonical digest is an
 * integrity coordinate, not proof that the referenced artifact was resolved
 * from a trusted store.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildTargetPin = ChildTargetPinStruct.check(
  Schema.makeFilter(
    targetFamilyIdentityMatches,
    {
      expected: "workflowFamilyIdentity derived from the target definition identifier"
    }
  )
).annotate({
  identifier: "WorkflowChildV3TargetPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildTargetPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildTargetPin = Schema.Schema.Type<typeof ChildTargetPin>

/**
 * One immutable root-through-parent entry carried into a child start.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LineageEntry = Schema.Struct({
  lineageEntryVersion: Schema.Literal(3),
  depth: AncestorDepth,
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier,
  artifactDigest: Wire.ArtifactDigest,
  workflowFamilyIdentity: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3LineageEntry",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LineageEntry}.
 *
 * @category models
 * @since 4.0.0
 */
export type LineageEntry = Schema.Schema.Type<typeof LineageEntry>

/**
 * A bounded root-through-parent ancestry snapshot.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Ancestry = Schema.Array(LineageEntry).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MaximumLineageDepth)
).annotate({
  identifier: "WorkflowChildV3Ancestry",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Ancestry}.
 *
 * @category models
 * @since 4.0.0
 */
export type Ancestry = Schema.Schema.Type<typeof Ancestry>

const ParentRunLinkStruct = Schema.Struct({
  parentLinkVersion: Schema.Literal(3),
  tenantId: Wire.AtomicIdentifier,
  parentRunId: Wire.LineageIdentifier,
  parentArtifactDigest: Wire.ArtifactDigest,
  parentWorkflowFamilyIdentity: Wire.Identifier,
  callId: Wire.LineageIdentifier,
  nodeId: Wire.AtomicIdentifier,
  nodeInstanceId: Wire.AtomicIdentifier,
  scheduleEventId: Wire.LineageIdentifier,
  rootRunId: Wire.LineageIdentifier,
  lineageDepth: ChildDepth,
  ancestry: Ancestry
}).annotate({
  identifier: "WorkflowChildV3ParentRunLinkStruct",
  parseOptions: strictParseOptions
})

type ParentRunLinkStruct = Schema.Schema.Type<typeof ParentRunLinkStruct>

/**
 * Stable pure-validation failure codes for child workflow foundations.
 *
 * @category constants
 * @since 4.0.0
 */
export const ValidationCodes = {
  InvalidSchema: "InvalidSchema",
  NonV3ChildTarget: "NonV3ChildTarget",
  LineageDepthMismatch: "LineageDepthMismatch",
  LineageEntryDepthMismatch: "LineageEntryDepthMismatch",
  LineageTenantMismatch: "LineageTenantMismatch",
  RootRunMismatch: "RootRunMismatch",
  ParentRunMismatch: "ParentRunMismatch",
  RepeatedRun: "RepeatedRun",
  RepeatedArtifact: "RepeatedArtifact",
  RepeatedWorkflowIdentity: "RepeatedWorkflowIdentity",
  TargetDepthLimitExceeded: "TargetDepthLimitExceeded",
  IdentityMismatch: "IdentityMismatch"
} as const

/**
 * A stable child workflow validation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ValidationCode = typeof ValidationCodes[keyof typeof ValidationCodes]

const ValidationCode = Schema.Literals([
  ValidationCodes.InvalidSchema,
  ValidationCodes.NonV3ChildTarget,
  ValidationCodes.LineageDepthMismatch,
  ValidationCodes.LineageEntryDepthMismatch,
  ValidationCodes.LineageTenantMismatch,
  ValidationCodes.RootRunMismatch,
  ValidationCodes.ParentRunMismatch,
  ValidationCodes.RepeatedRun,
  ValidationCodes.RepeatedArtifact,
  ValidationCodes.RepeatedWorkflowIdentity,
  ValidationCodes.TargetDepthLimitExceeded,
  ValidationCodes.IdentityMismatch
])

const ValidationPath = Schema.Array(Schema.Union([
  Schema.String,
  Wire.NonNegativeSafeInt
]))

/**
 * Raised when detached child workflow protocol data is structurally or
 * relationally invalid.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChildWorkflowValidationError extends Schema.TaggedErrorClass<
  ChildWorkflowValidationError
>("@effect/workflow-builder/ChildWorkflowV3/ValidationError")(
  "ChildWorkflowValidationError",
  {
    code: ValidationCode,
    message: Schema.NonEmptyString,
    path: ValidationPath
  },
  { parseOptions: strictParseOptions }
) {}

interface RelationalIssue {
  readonly code: ValidationCode
  readonly message: string
  readonly path: ReadonlyArray<string | number>
}

const issue = (
  code: ValidationCode,
  message: string,
  path: ReadonlyArray<string | number>
): RelationalIssue => ({ code, message, path })

const toFilterIssue = (
  relationalIssue: RelationalIssue
): Schema.FilterIssue => ({
  path: [...relationalIssue.path],
  issue: relationalIssue.message
})

const parentLinkIssues = (
  link: ParentRunLinkStruct
): ReadonlyArray<RelationalIssue> => {
  const issues: Array<RelationalIssue> = []
  if (link.lineageDepth !== link.ancestry.length) {
    issues.push(issue(
      ValidationCodes.LineageDepthMismatch,
      "lineageDepth must equal the root-through-parent ancestry length",
      ["lineageDepth"]
    ))
  }

  for (let index = 0; index < link.ancestry.length; index++) {
    const entry = link.ancestry[index]!
    if (entry.depth !== index) {
      issues.push(issue(
        ValidationCodes.LineageEntryDepthMismatch,
        "each ancestry entry depth must equal its zero-based position",
        ["ancestry", index, "depth"]
      ))
    }
    if (entry.tenantId !== link.tenantId) {
      issues.push(issue(
        ValidationCodes.LineageTenantMismatch,
        "every ancestry entry must belong to the parent-link tenant",
        ["ancestry", index, "tenantId"]
      ))
    }
  }

  const root = link.ancestry[0]
  if (root !== undefined && root.runId !== link.rootRunId) {
    issues.push(issue(
      ValidationCodes.RootRunMismatch,
      "rootRunId must equal the first ancestry run identifier",
      ["rootRunId"]
    ))
  }

  const parent = link.ancestry[link.ancestry.length - 1]
  if (
    parent !== undefined &&
    (
      parent.runId !== link.parentRunId ||
      parent.artifactDigest !== link.parentArtifactDigest ||
      parent.workflowFamilyIdentity !== link.parentWorkflowFamilyIdentity
    )
  ) {
    issues.push(issue(
      ValidationCodes.ParentRunMismatch,
      "the last ancestry entry must exactly identify the parent run",
      ["ancestry", link.ancestry.length - 1]
    ))
  }

  const seenRuns = new Set<string>()
  const seenArtifacts = new Set<string>()
  const seenWorkflowIdentities = new Set<string>()
  for (let index = 0; index < link.ancestry.length; index++) {
    const entry = link.ancestry[index]!
    if (seenRuns.has(entry.runId)) {
      issues.push(issue(
        ValidationCodes.RepeatedRun,
        "ancestry must not repeat a run identifier",
        ["ancestry", index, "runId"]
      ))
    }
    if (seenArtifacts.has(entry.artifactDigest)) {
      issues.push(issue(
        ValidationCodes.RepeatedArtifact,
        "recursion-forbidden ancestry must not repeat an artifact digest",
        ["ancestry", index, "artifactDigest"]
      ))
    }
    if (seenWorkflowIdentities.has(entry.workflowFamilyIdentity)) {
      issues.push(issue(
        ValidationCodes.RepeatedWorkflowIdentity,
        "recursion-forbidden ancestry must not repeat a workflow identity",
        ["ancestry", index, "workflowFamilyIdentity"]
      ))
    }
    seenRuns.add(entry.runId)
    seenArtifacts.add(entry.artifactDigest)
    seenWorkflowIdentities.add(entry.workflowFamilyIdentity)
  }

  const expectedCallId = childCallId(
    link.tenantId,
    link.parentRunId,
    link.nodeInstanceId
  )
  if (link.callId !== expectedCallId) {
    issues.push(issue(
      ValidationCodes.IdentityMismatch,
      "callId must equal the canonical child-call identity",
      ["callId"]
    ))
  }
  const expectedScheduleEventId = scheduleChildCommandId(
    link.tenantId,
    link.parentRunId,
    link.callId
  )
  if (link.scheduleEventId !== expectedScheduleEventId) {
    issues.push(issue(
      ValidationCodes.IdentityMismatch,
      "scheduleEventId must equal the canonical schedule identity",
      ["scheduleEventId"]
    ))
  }
  return issues
}

/**
 * Immutable, same-tenant, root-through-parent relation carried by a child run.
 *
 * **Details**
 *
 * The ancestry includes the parent as its final entry. Its length must equal
 * the prospective child's depth. Direct schema decoding and pure validation
 * both enforce canonical call and schedule identities.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParentRunLink = ParentRunLinkStruct.check(
  Schema.makeFilter((link) => parentLinkIssues(link).map(toFilterIssue))
).annotate({
  identifier: "WorkflowChildV3ParentRunLink",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParentRunLink}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentRunLink = Schema.Schema.Type<typeof ParentRunLink>

const ChildRelationStruct = Schema.Struct({
  relationVersion: Schema.Literal(3),
  parent: ParentRunLinkStruct,
  target: ChildTargetPinStruct,
  childRunId: Wire.LineageIdentifier,
  startRequestId: Wire.LineageIdentifier,
  scheduleCommandId: Wire.LineageIdentifier
}).annotate({
  identifier: "WorkflowChildV3RelationStruct",
  parseOptions: strictParseOptions
})

type ChildRelationStruct = Schema.Schema.Type<typeof ChildRelationStruct>

const relationIssues = (
  relation: ChildRelationStruct
): ReadonlyArray<RelationalIssue> => {
  const issues = [...parentLinkIssues(relation.parent)]
  const parent = relation.parent
  const target = relation.target

  if (parent.lineageDepth > target.maxLineageDepth) {
    issues.push(issue(
      ValidationCodes.TargetDepthLimitExceeded,
      "child lineage depth must not exceed the target's pinned limit",
      ["target", "maxLineageDepth"]
    ))
  }
  if (
    parent.ancestry.some((entry) => entry.artifactDigest === target.artifactDigest)
  ) {
    issues.push(issue(
      ValidationCodes.RepeatedArtifact,
      "a recursion-forbidden child target must not repeat an ancestor artifact",
      ["target", "artifactDigest"]
    ))
  }
  if (!targetFamilyIdentityMatches(target)) {
    issues.push(issue(
      ValidationCodes.IdentityMismatch,
      "workflowFamilyIdentity must be derived from the target definition id",
      ["target", "workflowFamilyIdentity"]
    ))
  }
  if (
    parent.ancestry.some((entry) => entry.workflowFamilyIdentity === target.workflowFamilyIdentity)
  ) {
    issues.push(issue(
      ValidationCodes.RepeatedWorkflowIdentity,
      "a recursion-forbidden child target must not repeat an ancestor workflow identity",
      ["target", "workflowFamilyIdentity"]
    ))
  }

  const expectedChildRunId = childRunId(
    parent.tenantId,
    parent.parentRunId,
    parent.callId
  )
  if (relation.childRunId !== expectedChildRunId) {
    issues.push(issue(
      ValidationCodes.IdentityMismatch,
      "childRunId must equal the canonical child-run identity",
      ["childRunId"]
    ))
  }
  const expectedStartRequestId = childStartRequestId(
    parent.tenantId,
    parent.parentRunId,
    parent.callId
  )
  if (relation.startRequestId !== expectedStartRequestId) {
    issues.push(issue(
      ValidationCodes.IdentityMismatch,
      "startRequestId must equal the canonical child-start request identity",
      ["startRequestId"]
    ))
  }
  const expectedScheduleCommandId = scheduleChildCommandId(
    parent.tenantId,
    parent.parentRunId,
    parent.callId
  )
  if (
    relation.scheduleCommandId !== expectedScheduleCommandId ||
    relation.scheduleCommandId !== parent.scheduleEventId
  ) {
    issues.push(issue(
      ValidationCodes.IdentityMismatch,
      "scheduleCommandId must equal the canonical shared schedule identity",
      ["scheduleCommandId"]
    ))
  }
  return issues
}

/**
 * Deterministic immutable coordinates and exact target pins for one child call.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ChildRelation = ChildRelationStruct.check(
  Schema.makeFilter((relation) => relationIssues(relation).map(toFilterIssue))
).annotate({
  identifier: "WorkflowChildV3Relation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ChildRelation}.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildRelation = Schema.Schema.Type<typeof ChildRelation>

const ScheduledPhase = Schema.TaggedStruct("Scheduled", {}).annotate({
  identifier: "WorkflowChildV3ScheduledPhase",
  parseOptions: strictParseOptions
})

const RunningPhase = Schema.TaggedStruct("Running", {
  childRunStartedEventId: Wire.SourceEventIdentifier,
  startProjectionEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3RunningPhase",
  parseOptions: strictParseOptions
})

const StartFailedPhase = Schema.TaggedStruct("StartFailed", {
  startFailedEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3StartFailedPhase",
  parseOptions: strictParseOptions
})

const CancellationRequestedPhase = Schema.TaggedStruct("CancellationRequested", {
  parentCauseEventId: Wire.SourceEventIdentifier,
  cancellationCommandId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3CancellationRequestedPhase",
  parseOptions: strictParseOptions
})

const CancellationAcceptedPhase = Schema.TaggedStruct("CancellationAccepted", {
  parentCauseEventId: Wire.SourceEventIdentifier,
  cancellationCommandId: Wire.Identifier,
  childCancellationEventId: Wire.SourceEventIdentifier,
  acceptedEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3CancellationAcceptedPhase",
  parseOptions: strictParseOptions
})

const SucceededPhase = Schema.TaggedStruct("Succeeded", {
  childTerminalEventId: Wire.SourceEventIdentifier,
  terminalProjectionEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3SucceededPhase",
  parseOptions: strictParseOptions
})

const FailedPhase = Schema.TaggedStruct("Failed", {
  childTerminalEventId: Wire.SourceEventIdentifier,
  terminalProjectionEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3FailedPhase",
  parseOptions: strictParseOptions
})

const CancelledPhase = Schema.TaggedStruct("Cancelled", {
  childTerminalEventId: Wire.SourceEventIdentifier,
  terminalProjectionEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3CancelledPhase",
  parseOptions: strictParseOptions
})

const CancelledBeforeStartPhase = Schema.TaggedStruct("CancelledBeforeStart", {
  parentCauseEventId: Wire.SourceEventIdentifier,
  cancelledBeforeStartEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3CancelledBeforeStartPhase",
  parseOptions: strictParseOptions
})

const AbandonedPhase = Schema.TaggedStruct("Abandoned", {
  parentCauseEventId: Wire.SourceEventIdentifier,
  abandonEventId: Wire.Identifier
}).annotate({
  identifier: "WorkflowChildV3AbandonedPhase",
  parseOptions: strictParseOptions
})

const ChildCallPhaseSchema = Schema.Union([
  ScheduledPhase,
  RunningPhase,
  StartFailedPhase,
  CancellationRequestedPhase,
  CancellationAcceptedPhase,
  SucceededPhase,
  FailedPhase,
  CancelledPhase,
  CancelledBeforeStartPhase,
  AbandonedPhase
]).annotate({
  identifier: "WorkflowChildV3CallPhase",
  parseOptions: strictParseOptions
})

/**
 * Closed protocol version `3` child-call lifecycle phases derived by the
 * authoritative history reducer.
 *
 * @category models
 * @since 4.0.0
 */
export type ChildCallPhase = Schema.Schema.Type<typeof ChildCallPhaseSchema>

const validationError = (
  relationalIssue: RelationalIssue
): ChildWorkflowValidationError =>
  new ChildWorkflowValidationError({
    code: relationalIssue.code,
    message: relationalIssue.message,
    path: [...relationalIssue.path]
  })

const snapshotInput = (
  input: unknown,
  label: string
): Result.Result<Schema.Json, ChildWorkflowValidationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(
      new ChildWorkflowValidationError({
        code: ValidationCodes.InvalidSchema,
        message: `${label} must be strict JSON: ${snapshot.failure.message}`,
        path: [...snapshot.failure.path]
      })
    )
  }
  return Result.succeed(snapshot.success)
}

const decodeSnapshot = <A>(
  snapshot: Schema.Json,
  decode: (input: unknown) => Result.Result<A, unknown>,
  label: string
): Result.Result<A, ChildWorkflowValidationError> => {
  let decoded: Result.Result<A, unknown>
  try {
    decoded = decode(snapshot)
  } catch {
    return Result.fail(
      new ChildWorkflowValidationError({
        code: ValidationCodes.InvalidSchema,
        message: `${label} schema validation threw unexpectedly`,
        path: []
      })
    )
  }
  if (Result.isFailure(decoded)) {
    const parseError = decoded.failure
    const message = typeof parseError === "object" &&
        parseError !== null &&
        "message" in parseError &&
        typeof parseError.message === "string"
      ? parseError.message
      : String(parseError)
    return Result.fail(
      new ChildWorkflowValidationError({
        code: ValidationCodes.InvalidSchema,
        message: `Invalid ${label}: ${message}`,
        path: []
      })
    )
  }
  return Result.succeed(snapshot as unknown as A)
}

const jsonObject = (
  value: Schema.Json
): Schema.JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Schema.JsonObject
    : undefined

const nonV3TargetIssue = (
  value: Schema.Json,
  prefix: ReadonlyArray<string | number> = []
): RelationalIssue | undefined => {
  const target = jsonObject(value)
  if (target === undefined) {
    return undefined
  }
  const selectors: ReadonlyArray<readonly [string, Schema.Json]> = [
    ["targetVersion", 3],
    ["artifactVersion", 3],
    ["executionProtocolVersion", ExecutionProtocolVersion],
    ["compilerSemanticVersion", "2"]
  ]
  for (const [key, expected] of selectors) {
    if (key in target && target[key] !== expected) {
      return issue(
        ValidationCodes.NonV3ChildTarget,
        `${key} must select the protocol version 3 child target contract`,
        [...prefix, key]
      )
    }
  }
  return undefined
}

const decodeChildTargetPin = Schema.decodeUnknownResult(
  ChildTargetPinStruct,
  strictParseOptions
)
const decodeParentRunLink = Schema.decodeUnknownResult(
  ParentRunLinkStruct,
  strictParseOptions
)
const decodeChildRelation = Schema.decodeUnknownResult(
  ChildRelationStruct,
  strictParseOptions
)

/**
 * Detaches, recursively freezes, and validates one exact V3 child target pin.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateChildTargetPin = (
  input: unknown
): Result.Result<ChildTargetPin, ChildWorkflowValidationError> => {
  const snapshot = snapshotInput(input, "child target pin")
  if (Result.isFailure(snapshot)) {
    return Result.fail(snapshot.failure)
  }
  const versionIssue = nonV3TargetIssue(snapshot.success)
  if (versionIssue !== undefined) {
    return Result.fail(validationError(versionIssue))
  }
  const decoded = decodeSnapshot(
    snapshot.success,
    decodeChildTargetPin,
    "child target pin"
  )
  if (Result.isFailure(decoded)) {
    return decoded
  }
  if (!targetFamilyIdentityMatches(decoded.success)) {
    return Result.fail(validationError(issue(
      ValidationCodes.IdentityMismatch,
      "workflowFamilyIdentity must be derived from the target definition id",
      ["workflowFamilyIdentity"]
    )))
  }
  return Result.succeed(decoded.success as ChildTargetPin)
}

/**
 * Detaches, recursively freezes, and validates one parent lineage link.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateParentRunLink = (
  input: unknown
): Result.Result<ParentRunLink, ChildWorkflowValidationError> => {
  const snapshot = snapshotInput(input, "parent run link")
  if (Result.isFailure(snapshot)) {
    return Result.fail(snapshot.failure)
  }
  const decoded = decodeSnapshot(
    snapshot.success,
    decodeParentRunLink,
    "parent run link"
  )
  if (Result.isFailure(decoded)) {
    return decoded
  }
  const relationalIssue = parentLinkIssues(decoded.success)[0]
  return relationalIssue === undefined
    ? Result.succeed(decoded.success as ParentRunLink)
    : Result.fail(validationError(relationalIssue))
}

/**
 * Detaches, recursively freezes, and validates one deterministic child
 * relation, including ancestry recursion and target-depth checks.
 *
 * @category validation
 * @since 4.0.0
 */
export const validateChildRelation = (
  input: unknown
): Result.Result<ChildRelation, ChildWorkflowValidationError> => {
  const snapshot = snapshotInput(input, "child relation")
  if (Result.isFailure(snapshot)) {
    return Result.fail(snapshot.failure)
  }
  const relationObject = jsonObject(snapshot.success)
  const target = relationObject === undefined
    ? undefined
    : relationObject.target
  if (target !== undefined) {
    const versionIssue = nonV3TargetIssue(target, ["target"])
    if (versionIssue !== undefined) {
      return Result.fail(validationError(versionIssue))
    }
  }
  const decoded = decodeSnapshot(
    snapshot.success,
    decodeChildRelation,
    "child relation"
  )
  if (Result.isFailure(decoded)) {
    return decoded
  }
  const relationalIssue = relationIssues(decoded.success)[0]
  return relationalIssue === undefined
    ? Result.succeed(decoded.success as ChildRelation)
    : Result.fail(validationError(relationalIssue))
}
