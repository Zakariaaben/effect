/**
 * Durable BPMN execution-state foundations.
 *
 * **Details**
 *
 * This module models one live or terminal BPMN execution snapshot against a
 * validated {@link BpmnModel.BpmnModel}. It records tokens, scope instances,
 * exact protocol-v3 task resolutions, and durable control frames without
 * claiming full BPMN execution conformance.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnActivityV3 from "./BpmnActivityV3.ts"
import * as BpmnModel from "./BpmnModel.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const activityLikeTags = new Set<BpmnModel.FlowNode["_tag"]>([
  "Task",
  "CallActivity",
  "SubProcess",
  "AdHocSubProcess",
  "Transaction"
])

const catchEventTags = new Set<BpmnModel.FlowNode["_tag"]>([
  "StartEvent",
  "BoundaryEvent",
  "IntermediateCatchEvent"
])

const eventDefinitionKinds = {
  MessageEventDefinition: "message",
  TimerEventDefinition: "timer",
  SignalEventDefinition: "signal",
  ConditionalEventDefinition: "conditional",
  CompensationEventDefinition: "compensation",
  EscalationEventDefinition: "escalation",
  ErrorEventDefinition: "error",
  CancelEventDefinition: "cancel",
  LinkEventDefinition: "link",
  TerminateEventDefinition: "terminate"
} as const

const comparePath = (
  left: ReadonlyArray<Diagnostic.PathSegment>,
  right: ReadonlyArray<Diagnostic.PathSegment>
): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]!
    const b = right[index]!
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) {
        return a - b
      }
      continue
    }
    const ordered = String(a).localeCompare(String(b))
    if (ordered !== 0) {
      return ordered
    }
  }
  return left.length - right.length
}

const sortDiagnostics = (diagnostics: Array<Diagnostic.Diagnostic>): Array<Diagnostic.Diagnostic> =>
  diagnostics.sort((left, right) => {
    const path = comparePath(left.path, right.path)
    if (path !== 0) {
      return path
    }
    const code = left.code.localeCompare(right.code)
    if (code !== 0) {
      return code
    }
    return left.message.localeCompare(right.message)
  })

const compilationError = (
  head: Diagnostic.Diagnostic,
  tail: ReadonlyArray<Diagnostic.Diagnostic> = []
): Diagnostic.CompilationError =>
  new Diagnostic.CompilationError({
    diagnostics: [head, ...tail]
  })

const codeError = (
  code: ExecutionStateCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

/**
 * Version of the durable BPMN execution-state snapshot.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnExecutionStateVersion = 3 as const

/**
 * Version of the executable BPMN fingerprint preimage.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnExecutableFingerprintVersion = 2 as const

/**
 * Version of the token-kernel semantics committed by an execution.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnKernelSemanticVersion = "2" as const

/**
 * Execution snapshot identity pinned to one BPMN semantic model version.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ModelReference = Schema.Struct({
  fingerprintVersion: Schema.Literal(BpmnExecutableFingerprintVersion),
  kernelSemanticVersion: Schema.Literal(BpmnKernelSemanticVersion),
  profileId: Identifier,
  modelKind: Schema.Literal("BpmnModel"),
  modelVersion: Schema.Literal(BpmnModel.BpmnModelVersion),
  bpmnSpecVersion: Schema.Literal("2.0.2"),
  rootProcessId: Identifier,
  executableFingerprint: ProtocolV2Wire.BpmnExecutableFingerprint
}).annotate({
  identifier: "WorkflowBpmnExecutionModelReference",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ModelReference}.
 *
 * @category models
 * @since 4.0.0
 */
export type ModelReference = Schema.Schema.Type<typeof ModelReference>

/**
 * Stable invocation identity for one scope activation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InvocationIdentity = Schema.Struct({
  activationId: Identifier,
  branchId: Schema.optionalKey(Identifier),
  loopIteration: Schema.optionalKey(NonNegativeInt),
  multiInstanceItemKey: Schema.optionalKey(Identifier),
  generation: PositiveInt
}).annotate({
  identifier: "WorkflowBpmnInvocationIdentity",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InvocationIdentity}.
 *
 * @category models
 * @since 4.0.0
 */
export type InvocationIdentity = Schema.Schema.Type<typeof InvocationIdentity>

/**
 * One active or terminal scope instance.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScopeInstance = Schema.Struct({
  scopeInstanceId: Identifier,
  definitionId: Identifier,
  processId: Identifier,
  parentScopeInstanceId: Schema.optionalKey(Identifier),
  invocation: InvocationIdentity,
  status: Schema.Literals(["active", "completed", "cancelled", "failed", "compensated"]),
  enteredAt: ProtocolV2Wire.Timestamp,
  exitedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
}).annotate({
  identifier: "WorkflowBpmnScopeInstance",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScopeInstance}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScopeInstance = Schema.Schema.Type<typeof ScopeInstance>

/**
 * One token location in the durable marking.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TokenPosition = Schema.Union([
  Schema.TaggedStruct("AtNode", {
    nodeId: Identifier
  }),
  Schema.TaggedStruct("OnSequenceFlow", {
    sequenceFlowId: Identifier
  })
]).annotate({ identifier: "WorkflowBpmnTokenPosition" })

/**
 * The decoded type of {@link TokenPosition}.
 *
 * @category models
 * @since 4.0.0
 */
export type TokenPosition = Schema.Schema.Type<typeof TokenPosition>

/**
 * One token in the durable marking.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Token = Schema.Struct({
  tokenId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  invocation: InvocationIdentity,
  status: Schema.Literals(["active", "consumed", "withdrawn"]),
  position: TokenPosition,
  createdAt: ProtocolV2Wire.Timestamp,
  consumedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
}).annotate({
  identifier: "WorkflowBpmnToken",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Token}.
 *
 * @category models
 * @since 4.0.0
 */
export type Token = Schema.Schema.Type<typeof Token>

/**
 * Durable gateway-join or routing frame.
 *
 * @category schemas
 * @since 4.0.0
 */
export const GatewayFrame = Schema.Struct({
  frameId: Identifier,
  gatewayId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  activationId: Identifier,
  joinEpoch: PositiveInt,
  expectedIncomingSequenceFlowIds: Schema.Array(Identifier),
  arrivedIncomingSequenceFlowIds: Schema.Array(Identifier),
  status: Schema.Literals(["waiting", "satisfied", "fired", "cancelled"])
}).annotate({
  identifier: "WorkflowBpmnGatewayFrame",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link GatewayFrame}.
 *
 * @category models
 * @since 4.0.0
 */
export type GatewayFrame = Schema.Schema.Type<typeof GatewayFrame>

/**
 * Durable loop frame for one looping activity activation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LoopFrame = Schema.Struct({
  frameId: Identifier,
  activityId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  iteration: NonNegativeInt,
  mode: Schema.Literals(["standard", "multi-instance"]),
  status: Schema.Literals(["active", "completed", "cancelled"])
}).annotate({
  identifier: "WorkflowBpmnLoopFrame",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LoopFrame}.
 *
 * @category models
 * @since 4.0.0
 */
export type LoopFrame = Schema.Schema.Type<typeof LoopFrame>

/**
 * Durable multi-instance group state.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceGroup = Schema.Struct({
  groupId: Identifier,
  activityId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  mode: Schema.Literals(["sequential", "parallel"]),
  status: Schema.Literals(["spawning", "active", "completed", "cancelled"]),
  cardinality: Schema.optionalKey(NonNegativeInt),
  collectionSnapshot: Schema.optionalKey(Schema.Json),
  completedInstanceCount: Schema.optionalKey(NonNegativeInt)
}).annotate({
  identifier: "WorkflowBpmnMultiInstanceGroup",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceGroup}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceGroup = Schema.Schema.Type<typeof MultiInstanceGroup>

/**
 * Durable child-workflow call frame.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CallFrame = Schema.Struct({
  callFrameId: Identifier,
  callActivityId: Identifier,
  processId: Identifier,
  parentScopeInstanceId: Identifier,
  childExecutionId: Identifier,
  childProcessId: Identifier,
  status: Schema.Literals(["active", "completed", "cancelled", "failed"]),
  enteredAt: ProtocolV2Wire.Timestamp,
  exitedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
}).annotate({
  identifier: "WorkflowBpmnCallFrame",
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
 * Durable catch-event subscription.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Subscription = Schema.Struct({
  subscriptionId: Identifier,
  ownerNodeId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  kind: Schema.Literals([
    "message",
    "timer",
    "signal",
    "conditional",
    "compensation",
    "escalation",
    "error",
    "cancel",
    "link",
    "multiple",
    "parallel-multiple"
  ]),
  status: Schema.Literals(["waiting", "matched", "cancelled", "expired"]),
  correlationKey: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnSubscription",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Subscription}.
 *
 * @category models
 * @since 4.0.0
 */
export type Subscription = Schema.Schema.Type<typeof Subscription>

/**
 * Durable timer instance.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Timer = Schema.Struct({
  timerId: Identifier,
  ownerType: Schema.Literals(["subscription", "loop-frame", "multi-instance-group", "work-item"]),
  ownerId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  deadline: ProtocolV2Wire.Timestamp,
  status: Schema.Literals(["pending", "fired", "cancelled"])
}).annotate({
  identifier: "WorkflowBpmnTimer",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Timer}.
 *
 * @category models
 * @since 4.0.0
 */
export type Timer = Schema.Schema.Type<typeof Timer>

/**
 * Durable human-work item state.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkItem = Schema.Struct({
  workItemId: Identifier,
  taskId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  status: Schema.Literals([
    "created",
    "offered",
    "allocated",
    "started",
    "suspended",
    "completed",
    "failed",
    "expired",
    "cancelled"
  ]),
  assignee: Schema.optionalKey(Identifier),
  dueAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
}).annotate({
  identifier: "WorkflowBpmnWorkItem",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkItem}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkItem = Schema.Schema.Type<typeof WorkItem>

/**
 * Durable compensation registration.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompensationRegistration = Schema.Struct({
  registrationId: Identifier,
  activityId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  order: NonNegativeInt,
  status: Schema.Literals(["registered", "triggered", "completed", "cancelled"])
}).annotate({
  identifier: "WorkflowBpmnCompensationRegistration",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompensationRegistration}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompensationRegistration = Schema.Schema.Type<typeof CompensationRegistration>

/**
 * Durable cancellation region.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CancellationRegion = Schema.Struct({
  regionId: Identifier,
  scopeInstanceId: Identifier,
  status: Schema.Literals(["open", "cancelling", "cancelled"]),
  memberScopeInstanceIds: Schema.Array(Identifier),
  memberTokenIds: Schema.Array(Identifier)
}).annotate({
  identifier: "WorkflowBpmnCancellationRegion",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CancellationRegion}.
 *
 * @category models
 * @since 4.0.0
 */
export type CancellationRegion = Schema.Schema.Type<typeof CancellationRegion>

/**
 * Durable BPMN execution-state snapshot.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BpmnExecutionState = Schema.Struct({
  stateKind: Schema.Literal("BpmnExecutionState"),
  stateVersion: Schema.Literal(BpmnExecutionStateVersion),
  model: ModelReference,
  status: Schema.Literals(["active", "completed", "failed", "cancelled", "terminated"]),
  startedAt: ProtocolV2Wire.Timestamp,
  completedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  extensionElements: Schema.Array(BpmnModel.ExtensionElement),
  scopeInstances: Schema.Array(ScopeInstance),
  tokens: Schema.Array(Token),
  activityResolutions: Schema.Array(BpmnActivityV3.ActivityResolution),
  gatewayFrames: Schema.Array(GatewayFrame),
  loopFrames: Schema.Array(LoopFrame),
  multiInstanceGroups: Schema.Array(MultiInstanceGroup),
  callFrames: Schema.Array(CallFrame),
  subscriptions: Schema.Array(Subscription),
  timers: Schema.Array(Timer),
  workItems: Schema.Array(WorkItem),
  compensationRegistrations: Schema.Array(CompensationRegistration),
  cancellationRegions: Schema.Array(CancellationRegion)
}).annotate({
  identifier: "WorkflowBpmnExecutionState",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BpmnExecutionState}.
 *
 * @category models
 * @since 4.0.0
 */
export type BpmnExecutionState = Schema.Schema.Type<typeof BpmnExecutionState>

const decodeExecutionState = Schema.decodeUnknownResult(BpmnExecutionState, strictParseOptions)

/**
 * Stable machine-readable validation codes for durable BPMN execution state.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "InvalidJson",
  InvalidState: "InvalidState",
  DuplicateStateId: "DuplicateStateId",
  RootProcessMismatch: "RootProcessMismatch",
  UnknownProcessRef: "UnknownProcessRef",
  UnknownDefinitionRef: "UnknownDefinitionRef",
  InvalidScopeDefinition: "InvalidScopeDefinition",
  UnknownParentScopeInstanceRef: "UnknownParentScopeInstanceRef",
  InvalidParentScopeInstance: "InvalidParentScopeInstance",
  InvalidScopeInvocation: "InvalidScopeInvocation",
  UnknownTokenScopeRef: "UnknownTokenScopeRef",
  InvalidTokenPosition: "InvalidTokenPosition",
  InvalidTokenInvocation: "InvalidTokenInvocation",
  UnknownActivityResolutionTokenRef: "UnknownActivityResolutionTokenRef",
  InvalidActivityResolution: "InvalidActivityResolution",
  UnknownGatewayRef: "UnknownGatewayRef",
  InvalidGatewayFrame: "InvalidGatewayFrame",
  UnknownLoopActivityRef: "UnknownLoopActivityRef",
  InvalidLoopFrame: "InvalidLoopFrame",
  UnknownMultiInstanceActivityRef: "UnknownMultiInstanceActivityRef",
  InvalidMultiInstanceGroup: "InvalidMultiInstanceGroup",
  UnknownCallActivityRef: "UnknownCallActivityRef",
  InvalidCallFrame: "InvalidCallFrame",
  UnknownSubscriptionOwnerRef: "UnknownSubscriptionOwnerRef",
  InvalidSubscription: "InvalidSubscription",
  UnknownTimerOwnerRef: "UnknownTimerOwnerRef",
  InvalidTimer: "InvalidTimer",
  UnknownWorkItemTaskRef: "UnknownWorkItemTaskRef",
  InvalidWorkItem: "InvalidWorkItem",
  UnknownCompensationActivityRef: "UnknownCompensationActivityRef",
  InvalidCompensationRegistration: "InvalidCompensationRegistration",
  UnknownCancellationMemberRef: "UnknownCancellationMemberRef",
  InvalidCancellationRegion: "InvalidCancellationRegion"
} as const

/**
 * A stable machine-readable durable BPMN execution-state validation code.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutionStateCode = typeof Codes[keyof typeof Codes]

const registerId = (
  seen: Map<string, ReadonlyArray<Diagnostic.PathSegment>>,
  diagnostics: Array<Diagnostic.Diagnostic>,
  id: string,
  path: ReadonlyArray<Diagnostic.PathSegment>
): void => {
  const existing = seen.get(id)
  if (existing !== undefined) {
    diagnostics.push(codeError(
      Codes.DuplicateStateId,
      `Duplicate durable execution-state id '${id}'`,
      path
    ))
    return
  }
  seen.set(id, path)
}

const rootDefinition = (
  model: BpmnModel.BpmnModel
): ReadonlySet<string> => new Set(model.processes.map((process) => process.id))

const scopeDefinitions = (
  model: BpmnModel.BpmnModel
): ReadonlyMap<string, BpmnModel.FlowNode> => {
  const output = new Map<string, BpmnModel.FlowNode>()
  for (const node of model.flowNodes) {
    if (
      node._tag === "SubProcess" ||
      node._tag === "AdHocSubProcess" ||
      node._tag === "Transaction" ||
      node._tag === "EventSubProcess"
    ) {
      output.set(node.id, node)
    }
  }
  return output
}

type CatchEventNode = BpmnModel.StartEvent | BpmnModel.BoundaryEvent | BpmnModel.IntermediateCatchEvent

const resolvedEventDefinitions = (
  node: CatchEventNode,
  declaredById: ReadonlyMap<string, BpmnModel.DeclaredEventDefinition>
): ReadonlyArray<BpmnModel.EventDefinition | BpmnModel.DeclaredEventDefinition> => [
  ...node.eventDefinitions,
  ...node.eventDefinitionRefs.flatMap((ref) => {
    const definition = declaredById.get(ref)
    return definition === undefined ? [] : [definition]
  })
]

const expectedSubscriptionKind = (
  node: CatchEventNode,
  definitions: ReadonlyArray<BpmnModel.EventDefinition | BpmnModel.DeclaredEventDefinition>
): Subscription["kind"] | undefined => {
  if (definitions.length === 0) {
    return undefined
  }
  if (definitions.length > 1) {
    return node.parallelMultiple === true ? "parallel-multiple" : "multiple"
  }
  const definition = definitions[0]!
  const kind = eventDefinitionKinds[definition._tag]
  return kind === "terminate" ? undefined : kind
}

/**
 * Safely validates one durable BPMN execution-state snapshot against a
 * validated semantic model.
 *
 * @category constructors
 * @since 4.0.0
 */
export const validate = (
  modelInput: unknown,
  stateInput: unknown
): Result.Result<BpmnExecutionState, Diagnostic.CompilationError> => {
  const validatedModel = BpmnModel.validate(modelInput)
  if (Result.isFailure(validatedModel)) {
    return Result.fail(validatedModel.failure)
  }

  const snapped = Json.snapshot(stateInput)
  if (Result.isFailure(snapped)) {
    return Result.fail(compilationError(codeError(
      Codes.InvalidJson,
      snapped.failure.message,
      snapped.failure.path
    )))
  }

  const decoded = decodeExecutionState(snapped.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(codeError(
      Codes.InvalidState,
      "Invalid BPMN execution-state document",
      [],
      { issue: String(decoded.failure) }
    )))
  }

  const model = validatedModel.success
  const state = snapped.success as unknown as BpmnExecutionState
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const processIds = rootDefinition(model)
  const nodeById = new Map(model.flowNodes.map((node) => [node.id, node] as const))
  const flowById = new Map(model.sequenceFlows.map((flow) => [flow.id, flow] as const))
  const scopeDefinitionById = scopeDefinitions(model)
  const declaredEventDefinitionById = new Map(
    (model.eventDefinitions ?? []).map((definition) => [definition.id, definition] as const)
  )
  const seenStateIds = new Map<string, ReadonlyArray<Diagnostic.PathSegment>>()
  const scopeInstances = new Map(state.scopeInstances.map((scope) => [scope.scopeInstanceId, scope] as const))
  const tokens = new Map(state.tokens.map((token) => [token.tokenId, token] as const))
  const subscriptions = new Map(
    state.subscriptions.map((subscription) => [subscription.subscriptionId, subscription] as const)
  )
  const loopFrames = new Map(state.loopFrames.map((frame) => [frame.frameId, frame] as const))
  const groups = new Map(state.multiInstanceGroups.map((group) => [group.groupId, group] as const))
  const workItems = new Map(state.workItems.map((item) => [item.workItemId, item] as const))

  if (!processIds.has(state.model.rootProcessId)) {
    diagnostics.push(codeError(
      Codes.RootProcessMismatch,
      `Execution snapshot root process '${state.model.rootProcessId}' is not defined in the BPMN model`,
      ["model", "rootProcessId"]
    ))
  }
  const rootScopes = state.scopeInstances.filter((scope) => scope.parentScopeInstanceId === undefined)
  if (
    rootScopes.length !== 1 ||
    rootScopes[0]?.definitionId !== state.model.rootProcessId
  ) {
    diagnostics.push(codeError(
      Codes.RootProcessMismatch,
      `Execution snapshot must contain exactly one root scope for process '${state.model.rootProcessId}'`,
      ["scopeInstances"]
    ))
  }
  if (state.status === "active" && state.completedAt !== undefined) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "Active BPMN execution state cannot record completedAt",
      ["completedAt"]
    ))
  }
  if (state.status !== "active" && state.completedAt === undefined) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      `Terminal BPMN execution state '${state.status}' must record completedAt`,
      ["completedAt"]
    ))
  }
  if (state.completedAt !== undefined && state.completedAt < state.startedAt) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "Execution completedAt cannot precede startedAt",
      ["completedAt"]
    ))
  }
  const rootScope = rootScopes.length === 1 ? rootScopes[0] : undefined
  if (state.status === "active" && rootScope !== undefined && rootScope.status !== "active") {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "An active BPMN execution requires an active root scope",
      ["scopeInstances"]
    ))
  }
  if (state.status === "completed" && rootScope !== undefined && rootScope.status !== "completed") {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "A completed BPMN execution requires a completed root scope",
      ["scopeInstances"]
    ))
  }
  if (state.status === "failed" && rootScope !== undefined && rootScope.status !== "failed") {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "A failed BPMN execution requires a failed root scope",
      ["scopeInstances"]
    ))
  }

  for (let index = 0; index < state.scopeInstances.length; index++) {
    const scope = state.scopeInstances[index]!
    const path = ["scopeInstances", index, "scopeInstanceId"] as const
    registerId(seenStateIds, diagnostics, scope.scopeInstanceId, path)
    if (!processIds.has(scope.processId)) {
      diagnostics.push(codeError(
        Codes.UnknownProcessRef,
        `Scope instance '${scope.scopeInstanceId}' references unknown process '${scope.processId}'`,
        ["scopeInstances", index, "processId"]
      ))
    }
    if (processIds.has(scope.definitionId)) {
      if (scope.parentScopeInstanceId !== undefined) {
        diagnostics.push(codeError(
          Codes.InvalidScopeDefinition,
          `Root process scope instance '${scope.scopeInstanceId}' cannot have a parent scope instance`,
          ["scopeInstances", index, "parentScopeInstanceId"]
        ))
      }
    } else {
      const definition = scopeDefinitionById.get(scope.definitionId)
      if (definition === undefined) {
        diagnostics.push(codeError(
          Codes.UnknownDefinitionRef,
          `Scope instance '${scope.scopeInstanceId}' references unknown scope definition '${scope.definitionId}'`,
          ["scopeInstances", index, "definitionId"]
        ))
      } else if (definition.processId !== scope.processId) {
        diagnostics.push(codeError(
          Codes.InvalidScopeDefinition,
          `Scope instance '${scope.scopeInstanceId}' process '${scope.processId}' does not match definition process '${definition.processId}'`,
          ["scopeInstances", index, "processId"]
        ))
      }
      if (scope.parentScopeInstanceId === undefined) {
        diagnostics.push(codeError(
          Codes.UnknownParentScopeInstanceRef,
          `Nested scope instance '${scope.scopeInstanceId}' requires a parent scope instance`,
          ["scopeInstances", index, "parentScopeInstanceId"]
        ))
      }
    }
    if (scope.status !== "active" && scope.exitedAt === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidScopeInvocation,
        `Terminal scope instance '${scope.scopeInstanceId}' must record exitedAt`,
        ["scopeInstances", index, "exitedAt"]
      ))
    }
    if (scope.status === "active" && scope.exitedAt !== undefined) {
      diagnostics.push(codeError(
        Codes.InvalidScopeInvocation,
        `Active scope instance '${scope.scopeInstanceId}' cannot record exitedAt`,
        ["scopeInstances", index, "exitedAt"]
      ))
    }
    if (scope.enteredAt < state.startedAt) {
      diagnostics.push(codeError(
        Codes.InvalidScopeInvocation,
        `Scope instance '${scope.scopeInstanceId}' entered before the execution started`,
        ["scopeInstances", index, "enteredAt"]
      ))
    }
    if (scope.exitedAt !== undefined && scope.exitedAt < scope.enteredAt) {
      diagnostics.push(codeError(
        Codes.InvalidScopeInvocation,
        `Scope instance '${scope.scopeInstanceId}' exited before it entered`,
        ["scopeInstances", index, "exitedAt"]
      ))
    }
  }

  for (let index = 0; index < state.scopeInstances.length; index++) {
    const scope = state.scopeInstances[index]!
    if (scope.parentScopeInstanceId === undefined) {
      continue
    }
    const parent = scopeInstances.get(scope.parentScopeInstanceId)
    if (parent === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Scope instance '${scope.scopeInstanceId}' references unknown parent scope instance '${scope.parentScopeInstanceId}'`,
        ["scopeInstances", index, "parentScopeInstanceId"]
      ))
    } else if (parent.processId !== scope.processId) {
      diagnostics.push(codeError(
        Codes.InvalidParentScopeInstance,
        `Scope instance '${scope.scopeInstanceId}' cannot cross process boundaries through parent scope instance '${scope.parentScopeInstanceId}'`,
        ["scopeInstances", index, "parentScopeInstanceId"]
      ))
    } else {
      const definition = scopeDefinitionById.get(scope.definitionId)
      if (definition !== undefined && parent.definitionId !== definition.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidParentScopeInstance,
          `Scope instance '${scope.scopeInstanceId}' parent definition '${parent.definitionId}' does not own scope definition '${definition.id}'`,
          ["scopeInstances", index, "parentScopeInstanceId"]
        ))
      }
      if (parent.invocation.activationId !== scope.invocation.activationId) {
        diagnostics.push(codeError(
          Codes.InvalidScopeInvocation,
          `Scope instance '${scope.scopeInstanceId}' must inherit activationId '${parent.invocation.activationId}' from its parent scope instance`,
          ["scopeInstances", index, "invocation", "activationId"]
        ))
      }
      if (scope.enteredAt < parent.enteredAt) {
        diagnostics.push(codeError(
          Codes.InvalidScopeInvocation,
          `Scope instance '${scope.scopeInstanceId}' entered before its parent scope instance`,
          ["scopeInstances", index, "enteredAt"]
        ))
      }
      if (parent.exitedAt !== undefined && scope.enteredAt > parent.exitedAt) {
        diagnostics.push(codeError(
          Codes.InvalidScopeInvocation,
          `Scope instance '${scope.scopeInstanceId}' entered after its parent scope instance exited`,
          ["scopeInstances", index, "enteredAt"]
        ))
      }
      if (
        scope.exitedAt !== undefined &&
        parent.exitedAt !== undefined &&
        scope.exitedAt > parent.exitedAt
      ) {
        diagnostics.push(codeError(
          Codes.InvalidScopeInvocation,
          `Scope instance '${scope.scopeInstanceId}' exited after its parent scope instance`,
          ["scopeInstances", index, "exitedAt"]
        ))
      }
      if (scope.status === "active" && parent.status !== "active") {
        diagnostics.push(codeError(
          Codes.InvalidScopeInvocation,
          `Active scope instance '${scope.scopeInstanceId}' cannot have a terminal parent scope instance`,
          ["scopeInstances", index, "parentScopeInstanceId"]
        ))
      }
    }
  }

  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index]!
    registerId(seenStateIds, diagnostics, token.tokenId, ["tokens", index, "tokenId"])
    const scope = scopeInstances.get(token.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownTokenScopeRef,
        `Token '${token.tokenId}' references unknown scope instance '${token.scopeInstanceId}'`,
        ["tokens", index, "scopeInstanceId"]
      ))
    } else {
      if (scope.processId !== token.processId) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' process '${token.processId}' does not match scope process '${scope.processId}'`,
          ["tokens", index, "processId"]
        ))
      }
      if (scope.invocation.activationId !== token.invocation.activationId) {
        diagnostics.push(codeError(
          Codes.InvalidTokenInvocation,
          `Token '${token.tokenId}' activationId must match its scope instance activationId`,
          ["tokens", index, "invocation", "activationId"]
        ))
      }
      if (token.createdAt < scope.enteredAt) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' was created before its scope instance entered`,
          ["tokens", index, "createdAt"]
        ))
      }
      if (scope.exitedAt !== undefined && token.createdAt > scope.exitedAt) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' was created after its scope instance exited`,
          ["tokens", index, "createdAt"]
        ))
      }
    }
    if (token.createdAt < state.startedAt) {
      diagnostics.push(codeError(
        Codes.InvalidTokenPosition,
        `Token '${token.tokenId}' was created before the execution started`,
        ["tokens", index, "createdAt"]
      ))
    }
    if (token.position._tag === "AtNode") {
      const node = nodeById.get(token.position.nodeId)
      if (node === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' references unknown node '${token.position.nodeId}'`,
          ["tokens", index, "position", "nodeId"]
        ))
      } else if (node.processId !== token.processId) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' node '${token.position.nodeId}' belongs to process '${node.processId}'`,
          ["tokens", index, "position", "nodeId"]
        ))
      } else if (scope !== undefined && scope.definitionId !== node.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' scope definition '${scope.definitionId}' does not own node '${node.id}'`,
          ["tokens", index, "scopeInstanceId"]
        ))
      }
    } else {
      const flow = flowById.get(token.position.sequenceFlowId)
      if (flow === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' references unknown sequence flow '${token.position.sequenceFlowId}'`,
          ["tokens", index, "position", "sequenceFlowId"]
        ))
      } else if (flow.processId !== token.processId) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' sequence flow '${token.position.sequenceFlowId}' belongs to process '${flow.processId}'`,
          ["tokens", index, "position", "sequenceFlowId"]
        ))
      } else if (scope !== undefined && scope.definitionId !== flow.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidTokenPosition,
          `Token '${token.tokenId}' scope definition '${scope.definitionId}' does not own sequence flow '${flow.id}'`,
          ["tokens", index, "scopeInstanceId"]
        ))
      }
    }
    if (token.status === "active" && token.consumedAt !== undefined) {
      diagnostics.push(codeError(
        Codes.InvalidTokenPosition,
        `Active token '${token.tokenId}' cannot record consumedAt`,
        ["tokens", index, "consumedAt"]
      ))
    }
    if (token.status !== "active" && token.consumedAt === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidTokenPosition,
        `Inactive token '${token.tokenId}' must record consumedAt`,
        ["tokens", index, "consumedAt"]
      ))
    }
    if (token.consumedAt !== undefined && token.consumedAt < token.createdAt) {
      diagnostics.push(codeError(
        Codes.InvalidTokenPosition,
        `Token '${token.tokenId}' was consumed before it was created`,
        ["tokens", index, "consumedAt"]
      ))
    }
    if (
      token.consumedAt !== undefined &&
      scope?.exitedAt !== undefined &&
      token.consumedAt > scope.exitedAt
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTokenPosition,
        `Token '${token.tokenId}' was consumed after its scope instance exited`,
        ["tokens", index, "consumedAt"]
      ))
    }
    if (token.status === "active" && scope !== undefined && scope.status !== "active") {
      diagnostics.push(codeError(
        Codes.InvalidTokenPosition,
        `Active token '${token.tokenId}' cannot belong to terminal scope '${scope.scopeInstanceId}'`,
        ["tokens", index, "scopeInstanceId"]
      ))
    }
  }

  const resolvedTokenIds = new Set<string>()
  for (let index = 0; index < state.activityResolutions.length; index++) {
    const resolution = state.activityResolutions[index]!
    const path = ["activityResolutions", index] as const
    if (resolvedTokenIds.has(resolution.tokenId)) {
      diagnostics.push(codeError(
        Codes.InvalidActivityResolution,
        `Task token '${resolution.tokenId}' has more than one durable activity resolution`,
        [...path, "tokenId"]
      ))
    } else {
      resolvedTokenIds.add(resolution.tokenId)
    }
    const token = tokens.get(resolution.tokenId)
    if (token === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownActivityResolutionTokenRef,
        `Activity resolution references unknown task token '${resolution.tokenId}'`,
        [...path, "tokenId"]
      ))
      continue
    }
    const node = token.position._tag === "AtNode"
      ? nodeById.get(token.position.nodeId)
      : undefined
    if (
      node?._tag !== "Task" ||
      node.id !== resolution.taskNodeId ||
      token.scopeInstanceId !== resolution.scopeInstanceId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidActivityResolution,
        `Activity resolution for token '${resolution.tokenId}' does not match its exact task wait`,
        path
      ))
    }
    if (token.status === "active" || token.consumedAt === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidActivityResolution,
        `Resolved task token '${resolution.tokenId}' must be inactive`,
        [...path, "tokenId"]
      ))
    } else if (token.consumedAt !== resolution.resolvedAt) {
      diagnostics.push(codeError(
        Codes.InvalidActivityResolution,
        `Activity resolution for token '${resolution.tokenId}' must share its terminal token timestamp`,
        [...path, "resolvedAt"]
      ))
    }
    if (resolution.resolvedAt < token.createdAt) {
      diagnostics.push(codeError(
        Codes.InvalidActivityResolution,
        `Activity resolution for token '${resolution.tokenId}' predates its task wait`,
        [...path, "resolvedAt"]
      ))
    }
  }

  const gatewayEpochKeys = new Set<string>()
  for (let index = 0; index < state.gatewayFrames.length; index++) {
    const frame = state.gatewayFrames[index]!
    registerId(seenStateIds, diagnostics, frame.frameId, ["gatewayFrames", index, "frameId"])
    const epochKey =
      `${frame.processId}\u0000${frame.scopeInstanceId}\u0000${frame.gatewayId}\u0000${frame.activationId}\u0000${frame.joinEpoch}`
    if (gatewayEpochKeys.has(epochKey)) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway '${frame.gatewayId}' has more than one frame for join epoch '${frame.joinEpoch}'`,
        ["gatewayFrames", index, "joinEpoch"]
      ))
    } else {
      gatewayEpochKeys.add(epochKey)
    }
    const gateway = nodeById.get(frame.gatewayId)
    const scope = scopeInstances.get(frame.scopeInstanceId)
    if (gateway === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownGatewayRef,
        `Gateway frame '${frame.frameId}' references unknown gateway '${frame.gatewayId}'`,
        ["gatewayFrames", index, "gatewayId"]
      ))
    } else if (gateway._tag !== "Gateway") {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway frame '${frame.frameId}' must reference a gateway node`,
        ["gatewayFrames", index, "gatewayId"]
      ))
    } else if (gateway.processId !== frame.processId) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway frame '${frame.frameId}' process '${frame.processId}' does not match gateway process '${gateway.processId}'`,
        ["gatewayFrames", index, "processId"]
      ))
    }
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Gateway frame '${frame.frameId}' references unknown scope instance '${frame.scopeInstanceId}'`,
        ["gatewayFrames", index, "scopeInstanceId"]
      ))
    } else {
      if (scope.processId !== frame.processId) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Gateway frame '${frame.frameId}' process must match its scope instance`,
          ["gatewayFrames", index, "processId"]
        ))
      }
      if (scope.invocation.activationId !== frame.activationId) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Gateway frame '${frame.frameId}' activationId must match its scope instance`,
          ["gatewayFrames", index, "activationId"]
        ))
      }
      if (gateway?._tag === "Gateway" && scope.definitionId !== gateway.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Gateway frame '${frame.frameId}' scope definition '${scope.definitionId}' does not own gateway '${gateway.id}'`,
          ["gatewayFrames", index, "scopeInstanceId"]
        ))
      }
      if (
        (frame.status === "waiting" || frame.status === "satisfied") &&
        scope.status !== "active"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Open gateway frame '${frame.frameId}' cannot belong to terminal scope '${scope.scopeInstanceId}'`,
          ["gatewayFrames", index, "scopeInstanceId"]
        ))
      }
    }
    const expectedSet = new Set(frame.expectedIncomingSequenceFlowIds)
    if (expectedSet.size !== frame.expectedIncomingSequenceFlowIds.length) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway frame '${frame.frameId}' cannot repeat an expected incoming sequence flow`,
        ["gatewayFrames", index, "expectedIncomingSequenceFlowIds"]
      ))
    }
    const arrivedSet = new Set(frame.arrivedIncomingSequenceFlowIds)
    if (arrivedSet.size !== frame.arrivedIncomingSequenceFlowIds.length) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway frame '${frame.frameId}' cannot record the same incoming arrival twice in join epoch '${frame.joinEpoch}'`,
        ["gatewayFrames", index, "arrivedIncomingSequenceFlowIds"]
      ))
    }
    if (
      gateway?._tag === "Gateway" &&
      (
        gateway.incomingSequenceFlowIds.length !== expectedSet.size ||
        gateway.incomingSequenceFlowIds.some((flowId) => !expectedSet.has(flowId))
      )
    ) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway frame '${frame.frameId}' expected incoming set must exactly match gateway '${gateway.id}'`,
        ["gatewayFrames", index, "expectedIncomingSequenceFlowIds"]
      ))
    }
    for (let flowIndex = 0; flowIndex < frame.expectedIncomingSequenceFlowIds.length; flowIndex++) {
      const flowId = frame.expectedIncomingSequenceFlowIds[flowIndex]!
      const flow = flowById.get(flowId)
      if (flow === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Gateway frame '${frame.frameId}' expects unknown sequence flow '${flowId}'`,
          ["gatewayFrames", index, "expectedIncomingSequenceFlowIds", flowIndex]
        ))
      } else if (flow.targetId !== frame.gatewayId) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Gateway frame '${frame.frameId}' expected flow '${flowId}' does not target gateway '${frame.gatewayId}'`,
          ["gatewayFrames", index, "expectedIncomingSequenceFlowIds", flowIndex]
        ))
      }
    }
    for (let flowIndex = 0; flowIndex < frame.arrivedIncomingSequenceFlowIds.length; flowIndex++) {
      const flowId = frame.arrivedIncomingSequenceFlowIds[flowIndex]!
      if (!frame.expectedIncomingSequenceFlowIds.includes(flowId)) {
        diagnostics.push(codeError(
          Codes.InvalidGatewayFrame,
          `Gateway frame '${frame.frameId}' cannot record arrival for unexpected flow '${flowId}'`,
          ["gatewayFrames", index, "arrivedIncomingSequenceFlowIds", flowIndex]
        ))
      }
    }
    const allExpectedArrived = expectedSet.size > 0 &&
      [...expectedSet].every((flowId) => arrivedSet.has(flowId))
    if (frame.status === "waiting" && allExpectedArrived) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Waiting gateway frame '${frame.frameId}' already has every expected arrival`,
        ["gatewayFrames", index, "status"]
      ))
    }
    if (
      (frame.status === "satisfied" || frame.status === "fired") &&
      !allExpectedArrived
    ) {
      diagnostics.push(codeError(
        Codes.InvalidGatewayFrame,
        `Gateway frame '${frame.frameId}' status '${frame.status}' requires every expected arrival`,
        ["gatewayFrames", index, "status"]
      ))
    }
  }

  for (let index = 0; index < state.loopFrames.length; index++) {
    const frame = state.loopFrames[index]!
    registerId(seenStateIds, diagnostics, frame.frameId, ["loopFrames", index, "frameId"])
    const node = nodeById.get(frame.activityId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownLoopActivityRef,
        `Loop frame '${frame.frameId}' references unknown activity '${frame.activityId}'`,
        ["loopFrames", index, "activityId"]
      ))
      continue
    }
    if (!activityLikeTags.has(node._tag)) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop frame '${frame.frameId}' must reference an activity-like node`,
        ["loopFrames", index, "activityId"]
      ))
      continue
    }
    if (!("loopCharacteristics" in node) || node.loopCharacteristics === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop frame '${frame.frameId}' requires loop characteristics on activity '${frame.activityId}'`,
        ["loopFrames", index, "activityId"]
      ))
      continue
    }
    if (
      frame.mode === "standard" && node.loopCharacteristics._tag !== "StandardLoopCharacteristics" ||
      frame.mode === "multi-instance" && node.loopCharacteristics._tag !== "MultiInstanceCharacteristics"
    ) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop frame '${frame.frameId}' mode '${frame.mode}' does not match activity '${frame.activityId}'`,
        ["loopFrames", index, "mode"]
      ))
    }
  }

  for (let index = 0; index < state.multiInstanceGroups.length; index++) {
    const group = state.multiInstanceGroups[index]!
    registerId(seenStateIds, diagnostics, group.groupId, ["multiInstanceGroups", index, "groupId"])
    const node = nodeById.get(group.activityId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownMultiInstanceActivityRef,
        `Multi-instance group '${group.groupId}' references unknown activity '${group.activityId}'`,
        ["multiInstanceGroups", index, "activityId"]
      ))
      continue
    }
    if (
      !activityLikeTags.has(node._tag) || !("loopCharacteristics" in node) ||
      node.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
    ) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' must reference a multi-instance activity`,
        ["multiInstanceGroups", index, "activityId"]
      ))
      continue
    }
    if (node.loopCharacteristics.mode !== group.mode) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' mode '${group.mode}' does not match activity '${group.activityId}'`,
        ["multiInstanceGroups", index, "mode"]
      ))
    }
    if (group.cardinality === undefined && group.collectionSnapshot === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' must record cardinality or collection snapshot`,
        ["multiInstanceGroups", index]
      ))
    }
  }

  for (let index = 0; index < state.callFrames.length; index++) {
    const frame = state.callFrames[index]!
    registerId(seenStateIds, diagnostics, frame.callFrameId, ["callFrames", index, "callFrameId"])
    const node = nodeById.get(frame.callActivityId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownCallActivityRef,
        `Call frame '${frame.callFrameId}' references unknown call activity '${frame.callActivityId}'`,
        ["callFrames", index, "callActivityId"]
      ))
    } else if (node._tag !== "CallActivity") {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' must reference a call activity`,
        ["callFrames", index, "callActivityId"]
      ))
    }
    if (!scopeInstances.has(frame.parentScopeInstanceId)) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Call frame '${frame.callFrameId}' references unknown parent scope instance '${frame.parentScopeInstanceId}'`,
        ["callFrames", index, "parentScopeInstanceId"]
      ))
    }
    if (!processIds.has(frame.childProcessId)) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' references unknown child process '${frame.childProcessId}'`,
        ["callFrames", index, "childProcessId"]
      ))
    }
  }

  for (let index = 0; index < state.subscriptions.length; index++) {
    const subscription = state.subscriptions[index]!
    registerId(seenStateIds, diagnostics, subscription.subscriptionId, ["subscriptions", index, "subscriptionId"])
    const node = nodeById.get(subscription.ownerNodeId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownSubscriptionOwnerRef,
        `Subscription '${subscription.subscriptionId}' references unknown node '${subscription.ownerNodeId}'`,
        ["subscriptions", index, "ownerNodeId"]
      ))
      continue
    }
    if (!catchEventTags.has(node._tag)) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.subscriptionId}' must reference a catching event`,
        ["subscriptions", index, "ownerNodeId"]
      ))
      continue
    }
    const catchEvent = node as CatchEventNode
    const definitions = resolvedEventDefinitions(catchEvent, declaredEventDefinitionById)
    const expected = expectedSubscriptionKind(catchEvent, definitions)
    if (expected === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.subscriptionId}' cannot be attached to catching event '${node.id}' without a subscribable event definition`,
        ["subscriptions", index, "ownerNodeId"]
      ))
      continue
    }
    if (subscription.kind !== expected) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.subscriptionId}' kind '${subscription.kind}' does not match catching event '${node.id}' kind '${expected}'`,
        ["subscriptions", index, "kind"]
      ))
    }
    const scope = scopeInstances.get(subscription.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Subscription '${subscription.subscriptionId}' references unknown scope instance '${subscription.scopeInstanceId}'`,
        ["subscriptions", index, "scopeInstanceId"]
      ))
    } else {
      if (scope.processId !== subscription.processId || node.processId !== subscription.processId) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Subscription '${subscription.subscriptionId}' process must match its catching event and scope instance`,
          ["subscriptions", index, "processId"]
        ))
      }
      if (scope.definitionId !== node.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Subscription '${subscription.subscriptionId}' scope definition '${scope.definitionId}' does not own catching event '${node.id}'`,
          ["subscriptions", index, "scopeInstanceId"]
        ))
      }
    }
  }

  for (let index = 0; index < state.timers.length; index++) {
    const timer = state.timers[index]!
    registerId(seenStateIds, diagnostics, timer.timerId, ["timers", index, "timerId"])
    if (!scopeInstances.has(timer.scopeInstanceId)) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Timer '${timer.timerId}' references unknown scope instance '${timer.scopeInstanceId}'`,
        ["timers", index, "scopeInstanceId"]
      ))
    }
    const ownerExists = timer.ownerType === "subscription"
      ? subscriptions.has(timer.ownerId)
      : timer.ownerType === "loop-frame"
      ? loopFrames.has(timer.ownerId)
      : timer.ownerType === "multi-instance-group"
      ? groups.has(timer.ownerId)
      : workItems.has(timer.ownerId)
    if (!ownerExists) {
      diagnostics.push(codeError(
        Codes.UnknownTimerOwnerRef,
        `Timer '${timer.timerId}' references unknown ${timer.ownerType} '${timer.ownerId}'`,
        ["timers", index, "ownerId"]
      ))
    }
  }

  for (let index = 0; index < state.workItems.length; index++) {
    const item = state.workItems[index]!
    registerId(seenStateIds, diagnostics, item.workItemId, ["workItems", index, "workItemId"])
    const node = nodeById.get(item.taskId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownWorkItemTaskRef,
        `Work item '${item.workItemId}' references unknown task '${item.taskId}'`,
        ["workItems", index, "taskId"]
      ))
    } else if (node._tag !== "Task" || !["user", "manual"].includes(node.taskKind)) {
      diagnostics.push(codeError(
        Codes.InvalidWorkItem,
        `Work item '${item.workItemId}' must reference a user or manual task`,
        ["workItems", index, "taskId"]
      ))
    }
    if (!scopeInstances.has(item.scopeInstanceId)) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Work item '${item.workItemId}' references unknown scope instance '${item.scopeInstanceId}'`,
        ["workItems", index, "scopeInstanceId"]
      ))
    }
  }

  for (let index = 0; index < state.compensationRegistrations.length; index++) {
    const registration = state.compensationRegistrations[index]!
    registerId(
      seenStateIds,
      diagnostics,
      registration.registrationId,
      ["compensationRegistrations", index, "registrationId"]
    )
    const node = nodeById.get(registration.activityId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownCompensationActivityRef,
        `Compensation registration '${registration.registrationId}' references unknown activity '${registration.activityId}'`,
        ["compensationRegistrations", index, "activityId"]
      ))
    } else if (!activityLikeTags.has(node._tag)) {
      diagnostics.push(codeError(
        Codes.InvalidCompensationRegistration,
        `Compensation registration '${registration.registrationId}' must reference an activity-like node`,
        ["compensationRegistrations", index, "activityId"]
      ))
    }
    if (!scopeInstances.has(registration.scopeInstanceId)) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Compensation registration '${registration.registrationId}' references unknown scope instance '${registration.scopeInstanceId}'`,
        ["compensationRegistrations", index, "scopeInstanceId"]
      ))
    }
  }

  for (let index = 0; index < state.cancellationRegions.length; index++) {
    const region = state.cancellationRegions[index]!
    registerId(seenStateIds, diagnostics, region.regionId, ["cancellationRegions", index, "regionId"])
    if (!scopeInstances.has(region.scopeInstanceId)) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Cancellation region '${region.regionId}' references unknown scope instance '${region.scopeInstanceId}'`,
        ["cancellationRegions", index, "scopeInstanceId"]
      ))
    }
    for (let memberIndex = 0; memberIndex < region.memberScopeInstanceIds.length; memberIndex++) {
      const scopeId = region.memberScopeInstanceIds[memberIndex]!
      if (!scopeInstances.has(scopeId)) {
        diagnostics.push(codeError(
          Codes.UnknownCancellationMemberRef,
          `Cancellation region '${region.regionId}' references unknown member scope instance '${scopeId}'`,
          ["cancellationRegions", index, "memberScopeInstanceIds", memberIndex]
        ))
      }
    }
    for (let memberIndex = 0; memberIndex < region.memberTokenIds.length; memberIndex++) {
      const tokenId = region.memberTokenIds[memberIndex]!
      if (!tokens.has(tokenId)) {
        diagnostics.push(codeError(
          Codes.UnknownCancellationMemberRef,
          `Cancellation region '${region.regionId}' references unknown member token '${tokenId}'`,
          ["cancellationRegions", index, "memberTokenIds", memberIndex]
        ))
      }
    }
    if (region.memberScopeInstanceIds.length === 0 && region.memberTokenIds.length === 0) {
      diagnostics.push(codeError(
        Codes.InvalidCancellationRegion,
        `Cancellation region '${region.regionId}' must include at least one scope or token member`,
        ["cancellationRegions", index]
      ))
    }
  }

  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }

  return Result.succeed(state)
}
