/**
 * Durable BPMN execution-state foundations.
 *
 * **Details**
 *
 * This module models one live or terminal BPMN execution snapshot against a
 * validated {@link BpmnModel.BpmnModel}. It records tokens, scope instances,
 * exact protocol-v3 task resolutions, and durable control frames without
 * claiming full BPMN execution conformance. A terminal snapshot may also
 * retain the exact portable `OperationalInstanceWithdrawal/1` control-plane
 * record; that record is not a BPMN Cancel, Terminate, or compensation fact.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnActivityV3 from "./BpmnActivityV3.ts"
import * as BpmnCallActivityV3 from "./BpmnCallActivityV3.ts"
import * as BpmnEventV3 from "./BpmnEventV3.ts"
import * as BpmnModel from "./BpmnModel.ts"
import * as BpmnOperationalV3 from "./BpmnOperationalV3.ts"
import * as BpmnTime from "./BpmnTime.ts"
import * as ChildWorkflowProtocolV3 from "./ChildWorkflowProtocolV3.ts"
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

const sameJson = (left: Schema.Json, right: Schema.Json): boolean =>
  Json.canonicalizeSnapshot(left) === Json.canonicalizeSnapshot(right)

const sameStrings = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index])

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
export const BpmnExecutionStateVersion = 9 as const

/**
 * Version of the executable BPMN fingerprint preimage.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnExecutableFingerprintVersion = 7 as const

/**
 * Version of the token-kernel semantics committed by an execution.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnKernelSemanticVersion = "8" as const

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
 * Durable branch identity within one scope activation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InvocationBranch = Schema.Union([
  Schema.TaggedStruct("StandardLoopIteration", {
    frameId: Identifier,
    iteration: NonNegativeInt
  }),
  Schema.TaggedStruct("MultiInstanceItem", {
    groupId: Identifier,
    itemIndex: NonNegativeInt,
    itemKey: Identifier
  })
]).annotate({
  identifier: "WorkflowBpmnInvocationBranch",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InvocationBranch}.
 *
 * @category models
 * @since 4.0.0
 */
export type InvocationBranch = Schema.Schema.Type<typeof InvocationBranch>

/**
 * Stable invocation identity for one scope activation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InvocationIdentity = Schema.Struct({
  activationId: Identifier,
  branch: Schema.optionalKey(InvocationBranch),
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
  activation: NonNegativeInt,
  completedIterations: NonNegativeInt,
  activeIteration: Schema.optionalKey(NonNegativeInt),
  status: Schema.Literals(["active", "completed", "cancelled"]),
  openedAt: ProtocolV2Wire.Timestamp,
  closedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
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
export const MultiInstanceSource = Schema.Union([
  Schema.TaggedStruct("Cardinality", {
    value: NonNegativeInt
  }),
  Schema.TaggedStruct("Collection", {
    dataInputRef: Identifier,
    items: Schema.Array(Schema.Json)
  })
]).annotate({
  identifier: "WorkflowBpmnMultiInstanceSource",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceSource}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceSource = Schema.Schema.Type<typeof MultiInstanceSource>

/**
 * Durable input-order aggregate produced by one collection-backed
 * multi-instance activation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceOutput = Schema.Struct({
  dataOutputRef: Identifier,
  items: Schema.Array(Schema.Json)
}).annotate({
  identifier: "WorkflowBpmnMultiInstanceOutput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceOutput = Schema.Schema.Type<typeof MultiInstanceOutput>

/**
 * Why one generated member was terminated or one planned sequential member
 * was never generated.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceClosureReason = Schema.Literals([
  "completion-condition",
  "boundary-error-caught",
  "uncaught-bpmn-error",
  "unmapped-business-failure",
  "execution-cancelled"
]).annotate({
  identifier: "WorkflowBpmnMultiInstanceClosureReason"
})

/**
 * The decoded type of {@link MultiInstanceClosureReason}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceClosureReason = Schema.Schema.Type<
  typeof MultiInstanceClosureReason
>

/**
 * One durable member of a multi-instance activation.
 *
 * **Details**
 *
 * A sequential group's `pending` suffix records the fixed source partition
 * without claiming that those BPMN instances have been generated.
 * `not-generated` is the terminal evidence that group completion or
 * cancellation suppressed one such slot. Only `active`, `completed`, and
 * `terminated` members are generated instances and participate in the BPMN
 * runtime instance counters.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceMember = Schema.Struct({
  index: NonNegativeInt,
  itemKey: Identifier,
  status: Schema.Literals([
    "pending",
    "active",
    "completed",
    "terminated",
    "not-generated"
  ]),
  terminationReason: Schema.optionalKey(MultiInstanceClosureReason),
  nonGenerationReason: Schema.optionalKey(MultiInstanceClosureReason),
  tokenId: Schema.optionalKey(Identifier),
  startedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  endedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  output: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowBpmnMultiInstanceMember",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceMember}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceMember = Schema.Schema.Type<typeof MultiInstanceMember>

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
  activation: NonNegativeInt,
  mode: Schema.Literals(["sequential", "parallel"]),
  source: MultiInstanceSource,
  members: Schema.Array(MultiInstanceMember),
  output: Schema.optionalKey(MultiInstanceOutput),
  completedInstanceCount: NonNegativeInt,
  status: Schema.Literals(["active", "completed", "cancelled"]),
  completionReason: Schema.optionalKey(Schema.Literals([
    "all-completed",
    "completion-condition",
    "empty",
    "boundary-error-caught",
    "uncaught-bpmn-error",
    "unmapped-business-failure",
    "execution-cancelled"
  ])),
  openedAt: ProtocolV2Wire.Timestamp,
  closedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
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
export const CallFrame = BpmnCallActivityV3.CallFrame

/**
 * The decoded type of {@link CallFrame}.
 *
 * @category models
 * @since 4.0.0
 */
export type CallFrame = BpmnCallActivityV3.CallFrame

/**
 * Exact winner of one atomic catch-event wait group.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CatchWaitWinner = Schema.Union([
  Schema.TaggedStruct("MessageWinner", {
    armId: Identifier,
    deliveryId: Identifier,
    acceptedAt: ProtocolV2Wire.Timestamp,
    selectedAt: ProtocolV2Wire.Timestamp,
    recordedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("TimerWinner", {
    armId: Identifier,
    timerId: Identifier,
    dueAt: ProtocolV2Wire.Timestamp,
    observedAt: ProtocolV2Wire.Timestamp,
    selectedAt: ProtocolV2Wire.Timestamp,
    recordedAt: ProtocolV2Wire.Timestamp
  })
]).annotate({
  identifier: "WorkflowBpmnCatchWaitWinner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CatchWaitWinner}.
 *
 * @category models
 * @since 4.0.0
 */
export type CatchWaitWinner = Schema.Schema.Type<typeof CatchWaitWinner>

/**
 * One durable atomic wait opened by a standalone catch event or by an
 * exclusive event-based gateway.
 *
 * **Details**
 *
 * All arms are opened in one kernel transition. A terminal group retains
 * exactly one winner or an explicit cancellation reason; losing arms never
 * remain live.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CatchWaitGroup = Schema.Struct({
  waitGroupId: Identifier,
  source: Schema.Union([
    Schema.TaggedStruct("StandaloneCatch", {
      catchEventNodeId: Identifier
    }),
    Schema.TaggedStruct("EventBasedGateway", {
      gatewayNodeId: Identifier
    })
  ]),
  ownerTokenId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  generation: PositiveInt,
  armIds: Schema.NonEmptyArray(Identifier),
  status: Schema.Literals(["waiting", "won", "cancelled"]),
  winner: Schema.optionalKey(CatchWaitWinner),
  cancellationReason: Schema.optionalKey(Schema.Literals([
    "scope-cancelled",
    "execution-cancelled",
    "execution-failed",
    "execution-terminated"
  ])),
  openedAt: ProtocolV2Wire.Timestamp,
  closedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp)
}).annotate({
  identifier: "WorkflowBpmnCatchWaitGroup",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CatchWaitGroup}.
 *
 * @category models
 * @since 4.0.0
 */
export type CatchWaitGroup = Schema.Schema.Type<typeof CatchWaitGroup>

const CatchArmFields = {
  armId: Identifier,
  waitGroupId: Identifier,
  ownerNodeId: Identifier,
  sourceSequenceFlowId: Schema.optionalKey(Identifier),
  processId: Identifier,
  scopeInstanceId: Identifier,
  tokenId: Identifier,
  generation: PositiveInt,
  ordinal: NonNegativeInt,
  status: Schema.Literals(["waiting", "won", "cancelled"]),
  openedAt: ProtocolV2Wire.Timestamp,
  closedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  cancellationReason: Schema.optionalKey(Schema.Literals([
    "choice-lost",
    "scope-cancelled",
    "execution-cancelled",
    "execution-failed",
    "execution-terminated"
  ]))
} as const

/**
 * Durable catch-event subscription arm.
 *
 * **Details**
 *
 * A Message arm freezes its exact ordered correlation key. A Timer arm points
 * to one separately persisted timer intent. Only a winning Message arm may
 * retain the trusted receipt which consumed its delivery identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Subscription = Schema.Union([
  Schema.TaggedStruct("MessageCatchSubscription", {
    ...CatchArmFields,
    messageRef: Identifier,
    correlationKey: BpmnEventV3.CorrelationKey,
    receipt: Schema.optionalKey(BpmnEventV3.MessageReceipt)
  }),
  Schema.TaggedStruct("TimerCatchSubscription", {
    ...CatchArmFields,
    timerId: Identifier
  })
]).annotate({
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
  armId: Identifier,
  waitGroupId: Identifier,
  processId: Identifier,
  scopeInstanceId: Identifier,
  tokenId: Identifier,
  generation: PositiveInt,
  schedule: Schema.Union([
    Schema.TaggedStruct("TimeDuration", {
      lexicalVersion: Schema.Literal(BpmnTime.LexicalVersion),
      lexical: BpmnTime.FixedDurationLexical,
      delayMillis: ProtocolV2Wire.NonNegativeSafeInt,
      dueAt: ProtocolV2Wire.Timestamp
    }),
    Schema.TaggedStruct("TimeDate", {
      lexicalVersion: Schema.Literal(BpmnTime.LexicalVersion),
      lexical: ProtocolV2Wire.Timestamp,
      delayMillis: ProtocolV2Wire.NonNegativeSafeInt,
      dueAt: ProtocolV2Wire.Timestamp
    })
  ]),
  scheduledAt: ProtocolV2Wire.Timestamp,
  status: Schema.Literals(["scheduled", "armed", "fired", "cancelled"]),
  armReceipt: Schema.optionalKey(BpmnEventV3.TimerArmReceipt),
  armAcknowledgedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  observedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  firedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  cancelledAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  cancellationReason: Schema.optionalKey(Schema.Literals([
    "choice-lost",
    "scope-cancelled",
    "execution-cancelled",
    "execution-failed",
    "execution-terminated"
  ]))
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
 * One Message delivery identity durably consumed by an atomic catch wait.
 *
 * **Details**
 *
 * The record is retained whether the Message itself wins or an already-due
 * Timer preempts it. This makes `deliveryId` a global execution-level
 * idempotency identity even when no Message receipt may remain on a losing
 * subscription arm.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessageDeliveryRecord = Schema.Struct({
  target: BpmnEventV3.CatchArmTarget,
  receipt: BpmnEventV3.MessageReceipt,
  disposition: Schema.Literals([
    "message-winner",
    "timer-preempted"
  ]),
  recordedAt: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnMessageDeliveryRecord",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MessageDeliveryRecord}.
 *
 * @category models
 * @since 4.0.0
 */
export type MessageDeliveryRecord = Schema.Schema.Type<
  typeof MessageDeliveryRecord
>

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
 * Format version of a durable parent-close intent.
 *
 * @category constants
 * @since 4.0.0
 */
export const ParentCloseIntentVersion = 1 as const

/**
 * Durable failure intent retained while synchronous child cancellation waits.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FailureCloseIntent = Schema.TaggedStruct("Failure", {
  intentVersion: Schema.Literal(ParentCloseIntentVersion),
  cause: ChildWorkflowProtocolV3.ParentFailure,
  sourceTokenId: Identifier,
  taskNodeId: Identifier,
  failureKind: Schema.Literals([
    "UnmappedBusinessFailure",
    "UncaughtBpmnError"
  ]),
  errorRef: Schema.optionalKey(Identifier),
  requestedAt: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnFailureCloseIntent",
  parseOptions: strictParseOptions
})

/**
 * Durable operational-withdrawal intent retained while children close.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OperationalWithdrawalCloseIntent = Schema.TaggedStruct(
  "OperationalWithdrawal",
  {
    intentVersion: Schema.Literal(ParentCloseIntentVersion),
    cause: ChildWorkflowProtocolV3.ParentCancellation,
    requestId: Identifier,
    rootScopeInstanceId: Identifier,
    requestedAt: ProtocolV2Wire.Timestamp
  }
).annotate({
  identifier: "WorkflowBpmnOperationalWithdrawalCloseIntent",
  parseOptions: strictParseOptions
})

/**
 * Exact parent close that fences normal scheduling and may wait for children.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParentCloseIntent = Schema.Union([
  FailureCloseIntent,
  OperationalWithdrawalCloseIntent
]).annotate({
  identifier: "WorkflowBpmnParentCloseIntent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParentCloseIntent}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParentCloseIntent = Schema.Schema.Type<
  typeof ParentCloseIntent
>

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
  status: Schema.Literals([
    "active",
    "failing",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "terminated"
  ]),
  startedAt: ProtocolV2Wire.Timestamp,
  input: Schema.Json,
  executionContext: Schema.optionalKey(
    BpmnCallActivityV3.ExecutionContext
  ),
  completedAt: Schema.optionalKey(ProtocolV2Wire.Timestamp),
  operationalWithdrawal: Schema.optionalKey(
    BpmnOperationalV3.OperationalInstanceWithdrawalRecord
  ),
  parentCloseIntent: Schema.optionalKey(ParentCloseIntent),
  extensionElements: Schema.Array(BpmnModel.ExtensionElement),
  scopeInstances: Schema.Array(ScopeInstance),
  tokens: Schema.Array(Token),
  activityResolutions: Schema.Array(BpmnActivityV3.ActivityResolution),
  gatewayFrames: Schema.Array(GatewayFrame),
  loopFrames: Schema.Array(LoopFrame),
  multiInstanceGroups: Schema.Array(MultiInstanceGroup),
  callFrames: Schema.Array(CallFrame),
  catchWaitGroups: Schema.Array(CatchWaitGroup),
  subscriptions: Schema.Array(Subscription),
  timers: Schema.Array(Timer),
  messageDeliveries: Schema.Array(MessageDeliveryRecord),
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
  UnknownCatchWaitGroupRef: "UnknownCatchWaitGroupRef",
  InvalidCatchWaitGroup: "InvalidCatchWaitGroup",
  UnknownSubscriptionOwnerRef: "UnknownSubscriptionOwnerRef",
  InvalidSubscription: "InvalidSubscription",
  UnknownTimerOwnerRef: "UnknownTimerOwnerRef",
  InvalidTimer: "InvalidTimer",
  InvalidMessageDelivery: "InvalidMessageDelivery",
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
  const catchWaitGroups = new Map(
    state.catchWaitGroups.map((group) => [group.waitGroupId, group] as const)
  )
  const subscriptions = new Map(
    state.subscriptions.map((subscription) => [subscription.armId, subscription] as const)
  )
  const timers = new Map(state.timers.map((timer) => [timer.timerId, timer] as const))
  const loopFrames = new Map(state.loopFrames.map((frame) => [frame.frameId, frame] as const))
  const groups = new Map(state.multiInstanceGroups.map((group) => [group.groupId, group] as const))

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
  const isClosing = state.status === "failing" ||
    state.status === "cancelling"
  const isTerminal = state.status !== "active" &&
    !isClosing
  if (
    (state.status === "active" || isClosing) &&
    state.completedAt !== undefined
  ) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      `Non-terminal BPMN execution state '${state.status}' cannot record completedAt`,
      ["completedAt"]
    ))
  }
  if (isTerminal && state.completedAt === undefined) {
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
  if (
    (state.status === "active" || isClosing) &&
    rootScope !== undefined &&
    rootScope.status !== "active"
  ) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      `A non-terminal BPMN execution '${state.status}' requires an active root scope`,
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
  if (state.status === "cancelled" && rootScope !== undefined && rootScope.status !== "cancelled") {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "An operationally withdrawn BPMN execution requires a cancelled root scope",
      ["scopeInstances"]
    ))
  }
  if (state.status === "cancelled") {
    const withdrawal = state.operationalWithdrawal
    const intent = state.parentCloseIntent
    if (
      withdrawal === undefined ||
      intent?._tag !== "OperationalWithdrawal" ||
      rootScope === undefined ||
      withdrawal.command.rootScopeInstanceId !== rootScope.scopeInstanceId ||
      withdrawal.command.requestId !== intent.requestId ||
      withdrawal.requestedAt !== intent.requestedAt ||
      intent.cause.parentCauseEventId !== intent.requestId ||
      state.completedAt === undefined ||
      state.completedAt < intent.requestedAt
    ) {
      diagnostics.push(codeError(
        Codes.InvalidState,
        "A cancelled BPMN execution requires exact operational-withdrawal intent and terminal evidence",
        ["operationalWithdrawal"]
      ))
    }
  } else if (state.status === "cancelling") {
    const withdrawal = state.operationalWithdrawal
    const intent = state.parentCloseIntent
    if (
      withdrawal === undefined ||
      intent?._tag !== "OperationalWithdrawal" ||
      rootScope === undefined ||
      withdrawal.command.rootScopeInstanceId !== rootScope.scopeInstanceId ||
      withdrawal.command.requestId !== intent.requestId ||
      withdrawal.requestedAt !== intent.requestedAt ||
      intent.cause.parentCauseEventId !== intent.requestId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidState,
        "A cancelling BPMN execution requires exact operational-withdrawal intent",
        ["operationalWithdrawal"]
      ))
    }
  } else if (state.operationalWithdrawal !== undefined) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "Only a cancelling or cancelled BPMN execution may retain operational-withdrawal evidence",
      ["operationalWithdrawal"]
    ))
  }
  if (
    (state.status === "failing" || state.status === "failed") &&
    state.parentCloseIntent?._tag !== "Failure"
  ) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      `A ${state.status} BPMN execution requires an exact failure close intent`,
      ["parentCloseIntent"]
    ))
  } else if (
    (state.status === "cancelling" ||
      state.status === "cancelled") &&
    state.parentCloseIntent?._tag !== "OperationalWithdrawal"
  ) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      `A ${state.status} BPMN execution requires an exact operational close intent`,
      ["parentCloseIntent"]
    ))
  } else if (
    (
      state.status === "active" ||
      state.status === "completed" ||
      state.status === "terminated"
    ) &&
    state.parentCloseIntent !== undefined
  ) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      `Execution status '${state.status}' cannot retain a parent close intent`,
      ["parentCloseIntent"]
    ))
  }
  if (
    state.parentCloseIntent !== undefined &&
    state.parentCloseIntent.requestedAt < state.startedAt
  ) {
    diagnostics.push(codeError(
      Codes.InvalidState,
      "Parent close intent cannot precede execution start",
      ["parentCloseIntent", "requestedAt"]
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
      if (scope.invocation.generation !== token.invocation.generation) {
        diagnostics.push(codeError(
          Codes.InvalidTokenInvocation,
          `Token '${token.tokenId}' generation must match its scope instance generation`,
          ["tokens", index, "invocation", "generation"]
        ))
      }
      if (
        token.invocation.branch === undefined &&
        scope.invocation.branch !== undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidTokenInvocation,
          `Unbranched token '${token.tokenId}' must inherit the exact invocation of its scope instance`,
          ["tokens", index, "invocation", "branch"]
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
    const branch = token.invocation.branch
    if (branch?._tag === "StandardLoopIteration") {
      const loopFrame = loopFrames.get(branch.frameId)
      if (loopFrame === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidTokenInvocation,
          `Standard loop token '${token.tokenId}' references unknown loop frame '${branch.frameId}'`,
          ["tokens", index, "invocation", "branch", "frameId"]
        ))
      } else {
        const loopScope = scopeInstances.get(loopFrame.scopeInstanceId)
        if (token.processId !== loopFrame.processId) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Loop token '${token.tokenId}' process must match standard loop frame '${loopFrame.frameId}'`,
            ["tokens", index, "processId"]
          ))
        }
        if (token.scopeInstanceId !== loopFrame.scopeInstanceId) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Loop token '${token.tokenId}' scope instance must match standard loop frame '${loopFrame.frameId}'`,
            ["tokens", index, "scopeInstanceId"]
          ))
        }
        if (
          token.position._tag !== "AtNode" ||
          token.position.nodeId !== loopFrame.activityId
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Loop token '${token.tokenId}' must wait AtNode on standard loop activity '${loopFrame.activityId}'`,
            ["tokens", index, "position"]
          ))
        }
        if (
          loopScope !== undefined &&
          token.invocation.activationId !== loopScope.invocation.activationId
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Loop token '${token.tokenId}' activationId must be inherited from standard loop frame scope '${loopScope.scopeInstanceId}'`,
            ["tokens", index, "invocation", "activationId"]
          ))
        }
        if (
          loopScope !== undefined &&
          token.invocation.generation !== loopScope.invocation.generation
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Loop token '${token.tokenId}' generation must be inherited from standard loop frame scope '${loopScope.scopeInstanceId}'`,
            ["tokens", index, "invocation", "generation"]
          ))
        }
        if (token.createdAt < loopFrame.openedAt) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Standard loop token '${token.tokenId}' was created before frame '${loopFrame.frameId}' opened`,
            ["tokens", index, "createdAt"]
          ))
        }
        if (
          loopFrame.closedAt !== undefined &&
          token.createdAt > loopFrame.closedAt
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Standard loop token '${token.tokenId}' was created after frame '${loopFrame.frameId}' closed`,
            ["tokens", index, "createdAt"]
          ))
        }
        if (
          loopFrame.closedAt !== undefined &&
          token.consumedAt !== undefined &&
          token.consumedAt > loopFrame.closedAt
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Standard loop token '${token.tokenId}' became terminal after frame '${loopFrame.frameId}' closed`,
            ["tokens", index, "consumedAt"]
          ))
        }
        if (token.status === "active") {
          if (loopFrame.status !== "active") {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Active loop token '${token.tokenId}' cannot reference terminal standard loop frame '${loopFrame.frameId}'`,
              ["tokens", index, "invocation", "branch", "frameId"]
            ))
          }
          if (
            loopFrame.activeIteration === undefined ||
            branch.iteration !== loopFrame.activeIteration
          ) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Active loop token '${token.tokenId}' iteration must match standard loop frame '${loopFrame.frameId}' activeIteration`,
              ["tokens", index, "invocation", "branch", "iteration"]
            ))
          }
        } else if (token.status === "consumed") {
          if (
            branch.iteration >= loopFrame.completedIterations
          ) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Consumed loop token '${token.tokenId}' iteration must identify an iteration completed by standard loop frame '${loopFrame.frameId}'`,
              ["tokens", index, "invocation", "branch", "iteration"]
            ))
          }
        } else {
          if (loopFrame.status !== "cancelled") {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Withdrawn loop token '${token.tokenId}' requires cancelled standard loop frame '${loopFrame.frameId}'`,
              ["tokens", index, "status"]
            ))
          }
          if (
            branch.iteration !== loopFrame.completedIterations
          ) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Withdrawn loop token '${token.tokenId}' iteration must identify the iteration cancelled by standard loop frame '${loopFrame.frameId}'`,
              ["tokens", index, "invocation", "branch", "iteration"]
            ))
          }
        }
      }
    } else if (branch?._tag === "MultiInstanceItem") {
      const group = groups.get(branch.groupId)
      if (group === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidTokenInvocation,
          `Multi-instance token '${token.tokenId}' references unknown group '${branch.groupId}'`,
          ["tokens", index, "invocation", "branch", "groupId"]
        ))
      } else {
        const member = group.members[branch.itemIndex]
        if (
          member === undefined ||
          member.index !== branch.itemIndex ||
          member.itemKey !== branch.itemKey
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Multi-instance token '${token.tokenId}' branch does not identify an exact member of group '${group.groupId}'`,
            ["tokens", index, "invocation", "branch"]
          ))
        } else {
          if (member.tokenId !== token.tokenId) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Multi-instance token '${token.tokenId}' is not the token owned by member '${member.itemKey}'`,
              ["tokens", index, "tokenId"]
            ))
          }
          const expectedTokenStatus = member.status === "active"
            ? "active"
            : member.status === "completed"
            ? "consumed"
            : member.status === "terminated"
            ? "withdrawn"
            : undefined
          if (expectedTokenStatus === undefined || token.status !== expectedTokenStatus) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Multi-instance token '${token.tokenId}' status '${token.status}' does not match member status '${member.status}'`,
              ["tokens", index, "status"]
            ))
          }
          if (
            member.startedAt === undefined ||
            token.createdAt !== member.startedAt
          ) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Multi-instance token '${token.tokenId}' createdAt must exactly match its member startedAt`,
              ["tokens", index, "createdAt"]
            ))
          }
          if (token.consumedAt !== member.endedAt) {
            diagnostics.push(codeError(
              Codes.InvalidTokenInvocation,
              `Multi-instance token '${token.tokenId}' consumedAt must exactly match its member endedAt`,
              ["tokens", index, "consumedAt"]
            ))
          }
        }
        if (token.processId !== group.processId) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Multi-instance token '${token.tokenId}' process must match group '${group.groupId}'`,
            ["tokens", index, "processId"]
          ))
        }
        if (token.scopeInstanceId !== group.scopeInstanceId) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Multi-instance token '${token.tokenId}' scope instance must match group '${group.groupId}'`,
            ["tokens", index, "scopeInstanceId"]
          ))
        }
        if (
          token.position._tag !== "AtNode" ||
          token.position.nodeId !== group.activityId
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Multi-instance token '${token.tokenId}' must wait AtNode on activity '${group.activityId}'`,
            ["tokens", index, "position"]
          ))
        }
        if (token.createdAt < group.openedAt) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Multi-instance token '${token.tokenId}' was created before group '${group.groupId}' opened`,
            ["tokens", index, "createdAt"]
          ))
        }
        if (
          group.closedAt !== undefined &&
          token.consumedAt !== undefined &&
          token.consumedAt > group.closedAt
        ) {
          diagnostics.push(codeError(
            Codes.InvalidTokenInvocation,
            `Multi-instance token '${token.tokenId}' became terminal after group '${group.groupId}' closed`,
            ["tokens", index, "consumedAt"]
          ))
        }
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
  if (state.parentCloseIntent?._tag === "Failure") {
    const intent = state.parentCloseIntent
    const resolution = state.activityResolutions.find((candidate) =>
      candidate.tokenId === intent.sourceTokenId &&
      candidate.taskNodeId === intent.taskNodeId
    )
    if (
      resolution?.outcome._tag !== "BusinessFailed" ||
      resolution.resolvedAt !== intent.requestedAt ||
      resolution.outcome.failedActivityDigest !==
        intent.cause.parentCauseEventId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidState,
        "Failure close intent does not match one exact durable task failure",
        ["parentCloseIntent"]
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

  const loopActivationKeys = new Set<string>()
  for (let index = 0; index < state.loopFrames.length; index++) {
    const frame = state.loopFrames[index]!
    registerId(seenStateIds, diagnostics, frame.frameId, ["loopFrames", index, "frameId"])
    const activationKey = JSON.stringify([
      frame.processId,
      frame.scopeInstanceId,
      frame.activityId,
      frame.activation
    ])
    if (loopActivationKeys.has(activationKey)) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop activity '${frame.activityId}' has more than one frame for activation '${frame.activation}' in scope '${frame.scopeInstanceId}'`,
        ["loopFrames", index, "activation"]
      ))
    } else {
      loopActivationKeys.add(activationKey)
    }

    const node = nodeById.get(frame.activityId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownLoopActivityRef,
        `Loop frame '${frame.frameId}' references unknown activity '${frame.activityId}'`,
        ["loopFrames", index, "activityId"]
      ))
    } else if (!activityLikeTags.has(node._tag)) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop frame '${frame.frameId}' must reference an activity-like node`,
        ["loopFrames", index, "activityId"]
      ))
    } else if (
      !("loopCharacteristics" in node) ||
      node.loopCharacteristics?._tag !== "StandardLoopCharacteristics"
    ) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop frame '${frame.frameId}' requires Standard Loop characteristics on activity '${frame.activityId}'`,
        ["loopFrames", index, "activityId"]
      ))
    } else {
      if (node.processId !== frame.processId) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Loop frame '${frame.frameId}' process '${frame.processId}' does not match activity process '${node.processId}'`,
          ["loopFrames", index, "processId"]
        ))
      }
      if (
        node.loopCharacteristics.loopMaximum !== undefined
      ) {
        const loopMaximum = node.loopCharacteristics.loopMaximum
        if (frame.completedIterations > loopMaximum) {
          diagnostics.push(codeError(
            Codes.InvalidLoopFrame,
            `Standard loop frame '${frame.frameId}' completedIterations cannot exceed loopMaximum '${loopMaximum}'`,
            ["loopFrames", index, "completedIterations"]
          ))
        }
        if (
          frame.activeIteration !== undefined &&
          frame.activeIteration >= loopMaximum
        ) {
          diagnostics.push(codeError(
            Codes.InvalidLoopFrame,
            `Standard loop frame '${frame.frameId}' activeIteration must be less than loopMaximum '${loopMaximum}'`,
            ["loopFrames", index, "activeIteration"]
          ))
        }
      }
    }

    const scope = scopeInstances.get(frame.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Loop frame '${frame.frameId}' references unknown scope instance '${frame.scopeInstanceId}'`,
        ["loopFrames", index, "scopeInstanceId"]
      ))
    } else {
      if (scope.processId !== frame.processId) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Loop frame '${frame.frameId}' process must match its scope instance`,
          ["loopFrames", index, "processId"]
        ))
      }
      if (node !== undefined && scope.definitionId !== node.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Loop frame '${frame.frameId}' scope definition '${scope.definitionId}' does not own activity '${node.id}'`,
          ["loopFrames", index, "scopeInstanceId"]
        ))
      }
      if (frame.openedAt < scope.enteredAt) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Loop frame '${frame.frameId}' opened before its scope instance entered`,
          ["loopFrames", index, "openedAt"]
        ))
      }
      if (scope.exitedAt !== undefined && frame.openedAt > scope.exitedAt) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Loop frame '${frame.frameId}' opened after its scope instance exited`,
          ["loopFrames", index, "openedAt"]
        ))
      }
      if (frame.status === "active" && scope.status !== "active") {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Active loop frame '${frame.frameId}' cannot belong to terminal scope '${scope.scopeInstanceId}'`,
          ["loopFrames", index, "scopeInstanceId"]
        ))
      }
      if (
        frame.status !== "active" &&
        frame.closedAt !== undefined &&
        scope.status !== "active" &&
        scope.exitedAt !== undefined &&
        frame.closedAt > scope.exitedAt
      ) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Terminal loop frame '${frame.frameId}' closed after its scope instance exited`,
          ["loopFrames", index, "closedAt"]
        ))
      }
    }

    if (frame.openedAt < state.startedAt) {
      diagnostics.push(codeError(
        Codes.InvalidLoopFrame,
        `Loop frame '${frame.frameId}' opened before the execution started`,
        ["loopFrames", index, "openedAt"]
      ))
    }
    if (frame.status === "active") {
      if (frame.activeIteration === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Active loop frame '${frame.frameId}' must record activeIteration`,
          ["loopFrames", index, "activeIteration"]
        ))
      } else if (frame.activeIteration !== frame.completedIterations) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Active loop frame '${frame.frameId}' activeIteration must equal completedIterations`,
          ["loopFrames", index, "activeIteration"]
        ))
      }
      if (frame.closedAt !== undefined) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Active loop frame '${frame.frameId}' cannot record closedAt`,
          ["loopFrames", index, "closedAt"]
        ))
      }
    } else {
      if (frame.activeIteration !== undefined) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Terminal loop frame '${frame.frameId}' cannot record activeIteration`,
          ["loopFrames", index, "activeIteration"]
        ))
      }
      if (frame.closedAt === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Terminal loop frame '${frame.frameId}' must record closedAt`,
          ["loopFrames", index, "closedAt"]
        ))
      } else if (frame.closedAt < frame.openedAt) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Terminal loop frame '${frame.frameId}' closed before it opened`,
          ["loopFrames", index, "closedAt"]
        ))
      }
    }

    if (frame.status === "active") {
      const activeLoopTokens = scope === undefined || frame.activeIteration === undefined
        ? []
        : state.tokens.filter((token) =>
          token.status === "active" &&
          token.processId === frame.processId &&
          token.scopeInstanceId === frame.scopeInstanceId &&
          token.position._tag === "AtNode" &&
          token.position.nodeId === frame.activityId &&
          token.invocation.branch?._tag === "StandardLoopIteration" &&
          token.invocation.branch.frameId === frame.frameId &&
          token.invocation.branch.iteration === frame.activeIteration &&
          token.invocation.activationId === scope.invocation.activationId &&
          token.invocation.generation === scope.invocation.generation
        )
      if (activeLoopTokens.length !== 1) {
        diagnostics.push(codeError(
          Codes.InvalidLoopFrame,
          `Active standard loop frame '${frame.frameId}' must own exactly one active AtNode token for its current iteration`,
          ["loopFrames", index, "frameId"]
        ))
      }
    }
  }

  const multiInstanceActivationKeys = new Set<string>()
  for (let index = 0; index < state.multiInstanceGroups.length; index++) {
    const group = state.multiInstanceGroups[index]!
    const groupPath = ["multiInstanceGroups", index] as const
    registerId(seenStateIds, diagnostics, group.groupId, [...groupPath, "groupId"])

    const activationKey = JSON.stringify([
      group.processId,
      group.scopeInstanceId,
      group.activityId,
      group.activation
    ])
    if (multiInstanceActivationKeys.has(activationKey)) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance activity '${group.activityId}' has more than one group for activation '${group.activation}' in scope '${group.scopeInstanceId}'`,
        [...groupPath, "activation"]
      ))
    } else {
      multiInstanceActivationKeys.add(activationKey)
    }

    const node = nodeById.get(group.activityId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownMultiInstanceActivityRef,
        `Multi-instance group '${group.groupId}' references unknown activity '${group.activityId}'`,
        [...groupPath, "activityId"]
      ))
    } else if (
      !activityLikeTags.has(node._tag) ||
      !("loopCharacteristics" in node) ||
      node.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
    ) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' must reference an activity with Multi-Instance characteristics`,
        [...groupPath, "activityId"]
      ))
    } else {
      if (node.processId !== group.processId) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' process '${group.processId}' does not match activity process '${node.processId}'`,
          [...groupPath, "processId"]
        ))
      }
      if (node.loopCharacteristics.mode !== group.mode) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' mode '${group.mode}' does not match activity '${group.activityId}'`,
          [...groupPath, "mode"]
        ))
      }
      if (
        group.source._tag === "Cardinality" &&
        node.loopCharacteristics.cardinality === undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' records a cardinality snapshot but activity '${group.activityId}' has no loop cardinality`,
          [...groupPath, "source"]
        ))
      }
      if (
        group.source._tag === "Collection" &&
        node.loopCharacteristics.loopDataInputRef !== group.source.dataInputRef
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' collection dataInputRef must exactly match activity '${group.activityId}'`,
          [...groupPath, "source", "dataInputRef"]
        ))
      }
      if (group.status === "active" && node._tag !== "Task") {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Active multi-instance group '${group.groupId}' currently requires a Task activity; '${node._tag}' execution is not yet supported`,
          [...groupPath, "activityId"]
        ))
      }
    }

    const scope = scopeInstances.get(group.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Multi-instance group '${group.groupId}' references unknown scope instance '${group.scopeInstanceId}'`,
        [...groupPath, "scopeInstanceId"]
      ))
    } else {
      if (scope.processId !== group.processId) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' process must match its scope instance`,
          [...groupPath, "processId"]
        ))
      }
      if (node !== undefined && scope.definitionId !== node.parentScopeId) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' scope definition '${scope.definitionId}' does not own activity '${node.id}'`,
          [...groupPath, "scopeInstanceId"]
        ))
      }
      if (group.openedAt < scope.enteredAt) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' opened before its scope instance entered`,
          [...groupPath, "openedAt"]
        ))
      }
      if (scope.exitedAt !== undefined && group.openedAt > scope.exitedAt) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' opened after its scope instance exited`,
          [...groupPath, "openedAt"]
        ))
      }
      if (group.status === "active" && scope.status !== "active") {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Active multi-instance group '${group.groupId}' cannot belong to terminal scope '${scope.scopeInstanceId}'`,
          [...groupPath, "scopeInstanceId"]
        ))
      }
      if (
        group.closedAt !== undefined &&
        scope.exitedAt !== undefined &&
        group.closedAt > scope.exitedAt
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' closed after its scope instance exited`,
          [...groupPath, "closedAt"]
        ))
      }
    }

    if (group.openedAt < state.startedAt) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' opened before the execution started`,
        [...groupPath, "openedAt"]
      ))
    }

    const sourceCount = group.source._tag === "Cardinality"
      ? group.source.value
      : group.source.items.length
    if (sourceCount !== group.members.length) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' source count '${sourceCount}' must equal members length '${group.members.length}'`,
        [...groupPath, "members"]
      ))
    }

    const itemKeys = new Set<string>()
    let exactCompletedCount = 0
    let activeCount = 0
    let pendingCount = 0
    let terminatedCount = 0
    let notGeneratedCount = 0
    for (let memberIndex = 0; memberIndex < group.members.length; memberIndex++) {
      const member = group.members[memberIndex]!
      const memberPath = [...groupPath, "members", memberIndex] as const
      if (member.index !== memberIndex) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' member index '${member.index}' must equal its ordered position '${memberIndex}'`,
          [...memberPath, "index"]
        ))
      }
      if (itemKeys.has(member.itemKey)) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' contains duplicate itemKey '${member.itemKey}'`,
          [...memberPath, "itemKey"]
        ))
      } else {
        itemKeys.add(member.itemKey)
      }

      if (member.status === "completed") {
        exactCompletedCount++
      } else if (member.status === "active") {
        activeCount++
      } else if (member.status === "pending") {
        pendingCount++
      } else if (member.status === "terminated") {
        terminatedCount++
      } else {
        notGeneratedCount++
      }

      if (member.status !== "completed" && member.output !== undefined) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Only a completed multi-instance member may retain output`,
          [...memberPath, "output"]
        ))
      }

      if (member.status === "pending") {
        if (
          member.tokenId !== undefined ||
          member.startedAt !== undefined ||
          member.endedAt !== undefined ||
          member.terminationReason !== undefined ||
          member.nonGenerationReason !== undefined
        ) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Pending multi-instance member '${member.itemKey}' cannot record token or lifecycle timestamps`,
            memberPath
          ))
        }
      } else if (member.status === "active") {
        if (
          member.tokenId === undefined ||
          member.startedAt === undefined ||
          member.endedAt !== undefined ||
          member.terminationReason !== undefined ||
          member.nonGenerationReason !== undefined
        ) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Active multi-instance member '${member.itemKey}' requires tokenId and startedAt only`,
            memberPath
          ))
        }
      } else if (member.status === "completed") {
        if (
          member.tokenId === undefined ||
          member.startedAt === undefined ||
          member.endedAt === undefined ||
          member.terminationReason !== undefined ||
          member.nonGenerationReason !== undefined
        ) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Completed multi-instance member '${member.itemKey}' requires tokenId, startedAt, and endedAt without a termination reason`,
            memberPath
          ))
        }
      } else if (member.status === "terminated") {
        const hasTerminalActivation = member.tokenId !== undefined &&
          member.startedAt !== undefined &&
          member.endedAt !== undefined
        if (
          member.terminationReason === undefined ||
          member.nonGenerationReason !== undefined ||
          !hasTerminalActivation
        ) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Terminated multi-instance member '${member.itemKey}' requires a termination reason and a complete activated token lifecycle`,
            memberPath
          ))
        }
      } else if (
        member.tokenId !== undefined ||
        member.startedAt !== undefined ||
        member.endedAt !== undefined ||
        member.terminationReason !== undefined ||
        member.nonGenerationReason === undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Not-generated multi-instance member '${member.itemKey}' requires only a non-generation reason`,
          memberPath
        ))
      }
      if (
        member.status === "not-generated" &&
        group.mode === "parallel"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Parallel multi-instance member '${member.itemKey}' cannot be marked not-generated`,
          memberPath
        ))
      }

      if (member.startedAt !== undefined && member.startedAt < group.openedAt) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance member '${member.itemKey}' started before group '${group.groupId}' opened`,
          [...memberPath, "startedAt"]
        ))
      }
      if (
        member.endedAt !== undefined &&
        member.startedAt !== undefined &&
        member.endedAt < member.startedAt
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance member '${member.itemKey}' ended before it started`,
          [...memberPath, "endedAt"]
        ))
      }
      if (
        member.endedAt !== undefined &&
        group.closedAt !== undefined &&
        member.endedAt > group.closedAt
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance member '${member.itemKey}' ended after group '${group.groupId}' closed`,
          [...memberPath, "endedAt"]
        ))
      }

      if (member.tokenId !== undefined) {
        const token = tokens.get(member.tokenId)
        if (token === undefined) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Multi-instance member '${member.itemKey}' references unknown token '${member.tokenId}'`,
            [...memberPath, "tokenId"]
          ))
        } else {
          const branch = token.invocation.branch
          if (
            branch?._tag !== "MultiInstanceItem" ||
            branch.groupId !== group.groupId ||
            branch.itemIndex !== member.index ||
            branch.itemKey !== member.itemKey
          ) {
            diagnostics.push(codeError(
              Codes.InvalidMultiInstanceGroup,
              `Multi-instance member '${member.itemKey}' token does not carry its exact group, index, and itemKey branch identity`,
              [...memberPath, "tokenId"]
            ))
          }
          if (
            token.processId !== group.processId ||
            token.scopeInstanceId !== group.scopeInstanceId ||
            token.position._tag !== "AtNode" ||
            token.position.nodeId !== group.activityId
          ) {
            diagnostics.push(codeError(
              Codes.InvalidMultiInstanceGroup,
              `Multi-instance member '${member.itemKey}' token does not wait on its exact activity, process, and scope`,
              [...memberPath, "tokenId"]
            ))
          }
          const expectedTokenStatus = member.status === "active"
            ? "active"
            : member.status === "completed"
            ? "consumed"
            : "withdrawn"
          if (
            token.status !== expectedTokenStatus ||
            token.createdAt !== member.startedAt ||
            token.consumedAt !== member.endedAt
          ) {
            diagnostics.push(codeError(
              Codes.InvalidMultiInstanceGroup,
              `Multi-instance member '${member.itemKey}' token lifecycle does not exactly match its durable member lifecycle`,
              [...memberPath, "tokenId"]
            ))
          }
        }
      }
    }

    const characteristics = node !== undefined &&
        activityLikeTags.has(node._tag) &&
        "loopCharacteristics" in node &&
        node.loopCharacteristics?._tag === "MultiInstanceCharacteristics"
      ? node.loopCharacteristics
      : undefined
    if (group.output !== undefined) {
      if (
        group.status !== "completed" ||
        (
          group.completionReason !== "all-completed" &&
          !(
            group.completionReason === "empty" &&
            group.members.length === 0 &&
            group.output.items.length === 0
          )
        )
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' may retain aggregate output only after all members completed or an empty collection completed`,
          [...groupPath, "output"]
        ))
      }
      if (group.source._tag !== "Collection") {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' aggregate output requires a collection source`,
          [...groupPath, "output"]
        ))
      }
      if (
        characteristics?.loopDataOutputRef === undefined ||
        characteristics.loopDataOutputRef !== group.output.dataOutputRef
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' dataOutputRef must exactly match its activity loopDataOutputRef`,
          [...groupPath, "output", "dataOutputRef"]
        ))
      }
      if (group.output.items.length !== group.members.length) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' aggregate output length must equal its members length`,
          [...groupPath, "output", "items"]
        ))
      }
      for (let memberIndex = 0; memberIndex < group.members.length; memberIndex++) {
        const member = group.members[memberIndex]!
        if (member.status !== "completed" || member.output === undefined) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Multi-instance group '${group.groupId}' aggregate output requires completed member '${member.itemKey}' to retain output`,
            [...groupPath, "members", memberIndex, "output"]
          ))
          continue
        }
        const item = group.output.items[memberIndex]
        if (item !== undefined && !sameJson(item, member.output)) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Multi-instance group '${group.groupId}' aggregate output item '${memberIndex}' must exactly equal its member output`,
            [...groupPath, "output", "items", memberIndex]
          ))
        }
      }
    }
    if (
      group.status === "completed" &&
      characteristics?.loopDataOutputRef !== undefined &&
      group.output === undefined
    ) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Completed multi-instance group '${group.groupId}' must retain the aggregate output required by its activity`,
        [...groupPath, "output"]
      ))
    }

    if (group.completedInstanceCount !== exactCompletedCount) {
      diagnostics.push(codeError(
        Codes.InvalidMultiInstanceGroup,
        `Multi-instance group '${group.groupId}' completedInstanceCount '${group.completedInstanceCount}' must equal exact completed member count '${exactCompletedCount}'`,
        [...groupPath, "completedInstanceCount"]
      ))
    }

    if (group.status === "active") {
      if (group.closedAt !== undefined || group.completionReason !== undefined) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Active multi-instance group '${group.groupId}' cannot record closedAt or completionReason`,
          groupPath
        ))
      }
      if (
        sourceCount === 0 ||
        activeCount === 0 ||
        terminatedCount > 0 ||
        notGeneratedCount > 0
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Active multi-instance group '${group.groupId}' requires at least one active member and cannot contain closed members`,
          [...groupPath, "members"]
        ))
      }
      if (group.mode === "sequential") {
        if (activeCount !== 1) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Active sequential multi-instance group '${group.groupId}' must contain exactly one active member`,
            [...groupPath, "members"]
          ))
        }
        let phase: "completed" | "active" | "pending" = "completed"
        for (let memberIndex = 0; memberIndex < group.members.length; memberIndex++) {
          const member = group.members[memberIndex]!
          const valid = phase === "completed"
            ? member.status === "completed" || member.status === "active"
            : phase === "active"
            ? member.status === "pending"
            : member.status === "pending"
          if (!valid) {
            diagnostics.push(codeError(
              Codes.InvalidMultiInstanceGroup,
              `Sequential multi-instance group '${group.groupId}' members must be an ordered completed prefix, one active member, then a pending suffix`,
              [...groupPath, "members", memberIndex, "status"]
            ))
            break
          }
          if (member.status === "active") {
            phase = "active"
          } else if (phase === "active") {
            phase = "pending"
          }
        }
      } else if (pendingCount > 0) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Active parallel multi-instance group '${group.groupId}' cannot retain pending members`,
          [...groupPath, "members"]
        ))
      }
    } else {
      if (group.closedAt === undefined || group.completionReason === undefined) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Terminal multi-instance group '${group.groupId}' must record closedAt and completionReason`,
          groupPath
        ))
      } else if (group.closedAt < group.openedAt) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Terminal multi-instance group '${group.groupId}' closed before it opened`,
          [...groupPath, "closedAt"]
        ))
      }
      if (activeCount > 0 || pendingCount > 0) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Terminal multi-instance group '${group.groupId}' cannot retain active or pending members`,
          [...groupPath, "members"]
        ))
      }
      const completedReasons = new Set<MultiInstanceGroup["completionReason"]>([
        "all-completed",
        "completion-condition",
        "empty"
      ])
      if (
        group.status === "completed" &&
        !completedReasons.has(group.completionReason)
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Completed multi-instance group '${group.groupId}' has incompatible completionReason '${group.completionReason}'`,
          [...groupPath, "completionReason"]
        ))
      }
      if (
        group.status === "cancelled" &&
        (group.completionReason === undefined || completedReasons.has(group.completionReason))
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Cancelled multi-instance group '${group.groupId}' requires a cancellation completionReason`,
          [...groupPath, "completionReason"]
        ))
      }
      if (
        group.completionReason === "empty" &&
        (sourceCount !== 0 || group.members.length !== 0)
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' can use completionReason 'empty' only for an empty source`,
          [...groupPath, "completionReason"]
        ))
      }
      if (
        group.completionReason === "all-completed" &&
        (sourceCount === 0 || exactCompletedCount !== group.members.length)
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' can use completionReason 'all-completed' only when every member of a non-empty source completed`,
          [...groupPath, "completionReason"]
        ))
      }
      if (
        group.completionReason === "completion-condition" &&
        exactCompletedCount === 0
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Multi-instance group '${group.groupId}' completion condition can only terminate after at least one member completed`,
          [...groupPath, "completionReason"]
        ))
      }
      if (group.status === "cancelled" && terminatedCount === 0) {
        diagnostics.push(codeError(
          Codes.InvalidMultiInstanceGroup,
          `Cancelled multi-instance group '${group.groupId}' must retain at least one terminated member`,
          [...groupPath, "members"]
        ))
      }
      if (group.mode === "sequential") {
        let phase: "completed" | "terminated" | "not-generated" = "completed"
        for (let memberIndex = 0; memberIndex < group.members.length; memberIndex++) {
          const member = group.members[memberIndex]!
          const valid = phase === "completed"
            ? member.status === "completed" ||
              member.status === "terminated" ||
              member.status === "not-generated"
            : phase === "terminated"
            ? member.status === "not-generated"
            : member.status === "not-generated"
          if (!valid) {
            diagnostics.push(codeError(
              Codes.InvalidMultiInstanceGroup,
              `Terminal sequential multi-instance group '${group.groupId}' must retain a completed prefix, at most one terminated generated member, then a not-generated suffix`,
              [...groupPath, "members", memberIndex, "status"]
            ))
            break
          }
          if (member.status === "terminated") {
            phase = "terminated"
          } else if (member.status === "not-generated") {
            phase = "not-generated"
          }
        }
      }
      for (let memberIndex = 0; memberIndex < group.members.length; memberIndex++) {
        const member = group.members[memberIndex]!
        if (
          member.status === "terminated" &&
          member.terminationReason !== group.completionReason
        ) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Terminated member '${member.itemKey}' reason must match group '${group.groupId}' completionReason`,
            [...groupPath, "members", memberIndex, "terminationReason"]
          ))
        }
        if (
          member.status === "not-generated" &&
          member.nonGenerationReason !== group.completionReason
        ) {
          diagnostics.push(codeError(
            Codes.InvalidMultiInstanceGroup,
            `Not-generated member '${member.itemKey}' reason must match group '${group.groupId}' completionReason`,
            [
              ...groupPath,
              "members",
              memberIndex,
              "nonGenerationReason"
            ]
          ))
        }
      }
    }
  }

  for (let index = 0; index < state.callFrames.length; index++) {
    const frame = state.callFrames[index]!
    registerId(seenStateIds, diagnostics, frame.callFrameId, ["callFrames", index, "callFrameId"])
    const framePath = ["callFrames", index] as const
    const validatedFrame = BpmnCallActivityV3.validateFrame(frame)
    const foldedFrame = BpmnCallActivityV3.foldFrame(frame)
    if (Result.isFailure(validatedFrame) || Result.isFailure(foldedFrame)) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' has an invalid child relation history`,
        framePath,
        {
          issue: Result.isFailure(validatedFrame)
            ? validatedFrame.failure.message
            : Result.isFailure(foldedFrame)
            ? foldedFrame.failure.message
            : "invalid-frame"
        }
      ))
      continue
    }
    const child = foldedFrame.success
    const relation = child.relation
    const node = nodeById.get(frame.callActivityNodeId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownCallActivityRef,
        `Call frame '${frame.callFrameId}' references unknown call activity '${frame.callActivityNodeId}'`,
        [...framePath, "callActivityNodeId"]
      ))
    } else if (node._tag !== "CallActivity") {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' must reference a call activity`,
        [...framePath, "callActivityNodeId"]
      ))
    } else if (node.processId !== frame.processId) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' process does not match its CallActivity`,
        [...framePath, "processId"]
      ))
    }
    const scope = scopeInstances.get(frame.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Call frame '${frame.callFrameId}' references unknown owning scope '${frame.scopeInstanceId}'`,
        [...framePath, "scopeInstanceId"]
      ))
    } else if (
      scope.processId !== frame.processId ||
      node?._tag === "CallActivity" &&
        scope.definitionId !== node.parentScopeId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' does not belong to the CallActivity owning scope`,
        [...framePath, "scopeInstanceId"]
      ))
    }
    const ownerToken = tokens.get(frame.ownerTokenId)
    if (
      ownerToken === undefined ||
      ownerToken.processId !== frame.processId ||
      ownerToken.scopeInstanceId !== frame.scopeInstanceId ||
      ownerToken.position._tag !== "AtNode" ||
      ownerToken.position.nodeId !== frame.callActivityNodeId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' has no exact owner token at its CallActivity`,
        [...framePath, "ownerTokenId"]
      ))
    } else if (
      state.status === "cancelled" ||
        state.status === "failed"
        ? ownerToken.status !== "withdrawn"
        : child.phase._tag === "Succeeded"
        ? ownerToken.status !== "consumed"
        : ownerToken.status !== "active"
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' owner token status does not match child phase '${child.phase._tag}'`,
        [...framePath, "ownerTokenId"]
      ))
    }
    if (
      frame.callFrameId !== relation.parent.callId ||
      frame.callActivityNodeId !== relation.parent.nodeId ||
      frame.ownerTokenId !== relation.parent.nodeInstanceId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' does not match its canonical parent-child relation`,
        framePath
      ))
    }
    const executionContext = state.executionContext
    if (
      executionContext === undefined ||
      executionContext.tenantId !== relation.parent.tenantId ||
      executionContext.runId !== relation.parent.parentRunId ||
      executionContext.rootRunId !== relation.parent.rootRunId ||
      executionContext.artifactDigest !==
        relation.parent.parentArtifactDigest ||
      executionContext.workflowFamilyIdentity !==
        relation.parent.parentWorkflowFamilyIdentity ||
      Json.canonicalizeSnapshot(
          executionContext.ancestry as unknown as Schema.Json
        ) !==
        Json.canonicalizeSnapshot(
          relation.parent.ancestry as unknown as Schema.Json
        )
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' relation does not match the execution context`,
        ["executionContext"]
      ))
    }
    const closeBarrier = BpmnCallActivityV3.parentCloseBarrier(frame)
    const closeIntent = state.parentCloseIntent
    const closeCommand = frame.parentCloseCommand
    if (Result.isFailure(closeBarrier)) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Call frame '${frame.callFrameId}' has an invalid parent-close barrier`,
        [...framePath, "parentCloseCommand"],
        { issue: closeBarrier.failure.message }
      ))
    } else if (
      (state.status === "active" ||
        state.status === "completed") &&
      closeCommand !== undefined
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCallFrame,
        `Execution status '${state.status}' cannot retain a CallActivity parent-close command`,
        [...framePath, "parentCloseCommand"]
      ))
    } else if (
      state.status === "failing" ||
      state.status === "cancelling" ||
      state.status === "failed" ||
      state.status === "cancelled"
    ) {
      if (closeBarrier.success === "NotRequested") {
        diagnostics.push(codeError(
          Codes.InvalidCallFrame,
          `Parent close has not propagated to CallActivity frame '${frame.callFrameId}'`,
          [...framePath, "parentCloseCommand"]
        ))
      }
      if (
        (state.status === "failed" ||
          state.status === "cancelled") &&
        closeBarrier.success !== "Discharged"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCallFrame,
          `Terminal execution cannot pass CallActivity barrier '${closeBarrier.success}'`,
          [...framePath, "parentCloseCommand"]
        ))
      }
      if (
        closeCommand !== undefined &&
        closeIntent !== undefined &&
        closeCommand.payload._tag !== "ScheduleChild"
      ) {
        const cause = closeCommand.payload.parentCause
        if (
          cause._tag !== closeIntent.cause._tag ||
          cause.parentCauseEventId !==
            closeIntent.cause.parentCauseEventId
        ) {
          diagnostics.push(codeError(
            Codes.InvalidCallFrame,
            `Call frame '${frame.callFrameId}' close command does not match the execution close intent`,
            [...framePath, "parentCloseCommand", "payload", "parentCause"]
          ))
        }
      }
    }
  }

  const armsByWaitGroup = new Map<string, Array<Subscription>>()
  for (const subscription of state.subscriptions) {
    const groupArms = armsByWaitGroup.get(subscription.waitGroupId)
    if (groupArms === undefined) {
      armsByWaitGroup.set(subscription.waitGroupId, [subscription])
    } else {
      groupArms.push(subscription)
    }
  }

  for (let index = 0; index < state.catchWaitGroups.length; index++) {
    const group = state.catchWaitGroups[index]!
    const groupPath = ["catchWaitGroups", index] as const
    registerId(
      seenStateIds,
      diagnostics,
      group.waitGroupId,
      [...groupPath, "waitGroupId"]
    )
    const sourceNodeId = group.source._tag === "StandaloneCatch"
      ? group.source.catchEventNodeId
      : group.source.gatewayNodeId
    const sourceNode = nodeById.get(sourceNodeId)
    if (
      sourceNode === undefined ||
      (group.source._tag === "StandaloneCatch"
        ? sourceNode._tag !== "IntermediateCatchEvent"
        : sourceNode._tag !== "Gateway" ||
          sourceNode.gatewayKind !== "event-based")
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' source '${sourceNodeId}' does not match its declared source kind`,
        [...groupPath, "source"]
      ))
    }

    const scope = scopeInstances.get(group.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Wait group '${group.waitGroupId}' references unknown scope instance '${group.scopeInstanceId}'`,
        [...groupPath, "scopeInstanceId"]
      ))
    } else if (
      scope.processId !== group.processId ||
      scope.invocation.generation !== group.generation ||
      (sourceNode !== undefined &&
        (sourceNode.processId !== group.processId ||
          sourceNode.parentScopeId !== scope.definitionId))
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' process, scope, source, and generation must identify one exact activation`,
        groupPath
      ))
    }

    const ownerToken = tokens.get(group.ownerTokenId)
    if (ownerToken === undefined) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' references unknown owner token '${group.ownerTokenId}'`,
        [...groupPath, "ownerTokenId"]
      ))
    } else {
      const atExpectedSource = ownerToken.position._tag === "AtNode" &&
        ownerToken.position.nodeId === sourceNodeId
      if (
        ownerToken.processId !== group.processId ||
        ownerToken.scopeInstanceId !== group.scopeInstanceId ||
        ownerToken.invocation.generation !== group.generation ||
        !atExpectedSource
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Wait group '${group.waitGroupId}' owner token must identify its exact source activation`,
          [...groupPath, "ownerTokenId"]
        ))
      }
      if (
        (group.status === "waiting" && ownerToken.status !== "active") ||
        (group.status !== "waiting" && ownerToken.status === "active")
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Wait group '${group.waitGroupId}' owner token lifecycle does not match group status '${group.status}'`,
          [...groupPath, "status"]
        ))
      }
      if (
        group.status === "won" &&
        (
          ownerToken.status !== "consumed" ||
          ownerToken.consumedAt !== group.closedAt
        )
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Won group '${group.waitGroupId}' must consume its owner token exactly at closure`,
          [...groupPath, "ownerTokenId"]
        ))
      }
      if (
        group.status === "cancelled" &&
        (
          ownerToken.status !== "withdrawn" ||
          ownerToken.consumedAt !== group.closedAt
        )
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Cancelled group '${group.waitGroupId}' must withdraw its owner token exactly at closure`,
          [...groupPath, "ownerTokenId"]
        ))
      }
      if (ownerToken.createdAt > group.openedAt) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Wait group '${group.waitGroupId}' opened before its owner token existed`,
          [...groupPath, "openedAt"]
        ))
      }
    }

    if (group.openedAt < state.startedAt) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' opened before the execution started`,
        [...groupPath, "openedAt"]
      ))
    }
    if (
      group.closedAt !== undefined &&
      group.closedAt < group.openedAt
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' closed before it opened`,
        [...groupPath, "closedAt"]
      ))
    }

    const uniqueArmIds = new Set(group.armIds)
    const actualArms = armsByWaitGroup.get(group.waitGroupId) ?? []
    if (
      uniqueArmIds.size !== group.armIds.length ||
      actualArms.length !== group.armIds.length ||
      group.armIds.some((armId) => !subscriptions.has(armId)) ||
      actualArms.some((arm) => group.armIds[arm.ordinal] !== arm.armId)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' must own one exact, uniquely ordered arm set`,
        [...groupPath, "armIds"]
      ))
    }
    if (
      (group.source._tag === "StandaloneCatch" &&
        group.armIds.length !== 1) ||
      (group.source._tag === "EventBasedGateway" &&
        group.armIds.length < 2)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Wait group '${group.waitGroupId}' arm cardinality does not match its source kind`,
        [...groupPath, "armIds"]
      ))
    }

    const wonArms = actualArms.filter((arm) => arm.status === "won")
    const waitingArms = actualArms.filter((arm) => arm.status === "waiting")
    const actualTimers = state.timers.filter((timer) => timer.waitGroupId === group.waitGroupId)
    if (group.status === "waiting") {
      if (
        group.winner !== undefined ||
        group.cancellationReason !== undefined ||
        group.closedAt !== undefined ||
        waitingArms.length !== actualArms.length
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Waiting group '${group.waitGroupId}' must retain only live arms and no terminal evidence`,
          groupPath
        ))
      }
    } else if (group.status === "won") {
      if (
        group.winner === undefined ||
        group.cancellationReason !== undefined ||
        group.closedAt === undefined ||
        wonArms.length !== 1 ||
        wonArms[0]?.armId !== group.winner?.armId ||
        waitingArms.length !== 0
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Won group '${group.waitGroupId}' must retain exactly one matching winner and closed loser arms`,
          groupPath
        ))
      }
      if (
        group.winner !== undefined &&
        group.closedAt !== undefined &&
        (group.winner.recordedAt !== group.closedAt ||
          group.winner.recordedAt < group.winner.selectedAt)
      ) {
        diagnostics.push(codeError(
          Codes.InvalidCatchWaitGroup,
          `Wait group '${group.waitGroupId}' winner recordedAt must equal group closedAt and cannot precede semantic selection`,
          [...groupPath, "winner", "recordedAt"]
        ))
      }
      if (group.winner !== undefined && group.closedAt !== undefined) {
        for (const arm of actualArms) {
          const winning = arm.armId === group.winner.armId
          if (
            winning
              ? arm.status !== "won" ||
                arm.closedAt !== group.closedAt ||
                arm.cancellationReason !== undefined
              : arm.status !== "cancelled" ||
                arm.closedAt !== group.closedAt ||
                arm.cancellationReason !== "choice-lost"
          ) {
            diagnostics.push(codeError(
              Codes.InvalidCatchWaitGroup,
              `Won group '${group.waitGroupId}' must retain one exact winner and choice-lost arms at closure`,
              [...groupPath, "armIds"]
            ))
            break
          }
        }
        for (const timer of actualTimers) {
          const winning = group.winner._tag === "TimerWinner" &&
            timer.timerId === group.winner.timerId &&
            timer.armId === group.winner.armId
          if (
            winning
              ? timer.status !== "fired" ||
                timer.cancelledAt !== undefined ||
                timer.cancellationReason !== undefined
              : timer.status !== "cancelled" ||
                timer.cancelledAt !== group.closedAt ||
                timer.cancellationReason !== "choice-lost"
          ) {
            diagnostics.push(codeError(
              Codes.InvalidCatchWaitGroup,
              `Won group '${group.waitGroupId}' must fire only its Timer winner and cancel every losing Timer as choice-lost at closure`,
              [...groupPath, "winner"]
            ))
            break
          }
        }
      }
    } else if (
      group.winner !== undefined ||
      group.cancellationReason === undefined ||
      group.closedAt === undefined ||
      waitingArms.length !== 0 ||
      wonArms.length !== 0
    ) {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Cancelled group '${group.waitGroupId}' must retain one cancellation reason and only cancelled arms`,
        groupPath
      ))
    } else {
      for (const arm of actualArms) {
        if (
          arm.status !== "cancelled" ||
          arm.closedAt !== group.closedAt ||
          arm.cancellationReason !== group.cancellationReason
        ) {
          diagnostics.push(codeError(
            Codes.InvalidCatchWaitGroup,
            `Cancelled group '${group.waitGroupId}' must close every arm with its exact reason and timestamp`,
            [...groupPath, "armIds"]
          ))
          break
        }
      }
      for (const timer of actualTimers) {
        if (
          timer.status !== "cancelled" ||
          timer.cancelledAt !== group.closedAt ||
          timer.cancellationReason !== group.cancellationReason
        ) {
          diagnostics.push(codeError(
            Codes.InvalidCatchWaitGroup,
            `Cancelled group '${group.waitGroupId}' must cancel every Timer with its exact reason and timestamp`,
            [...groupPath, "closedAt"]
          ))
          break
        }
      }
    }
    if (state.status !== "active" && group.status === "waiting") {
      diagnostics.push(codeError(
        Codes.InvalidCatchWaitGroup,
        `Terminal execution '${state.status}' cannot retain waiting group '${group.waitGroupId}'`,
        [...groupPath, "status"]
      ))
    }
  }

  const consumedDeliveryIds = new Set<string>()
  for (let index = 0; index < state.subscriptions.length; index++) {
    const subscription = state.subscriptions[index]!
    const subscriptionPath = ["subscriptions", index] as const
    registerId(
      seenStateIds,
      diagnostics,
      subscription.armId,
      [...subscriptionPath, "armId"]
    )
    const group = catchWaitGroups.get(subscription.waitGroupId)
    if (group === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownCatchWaitGroupRef,
        `Subscription '${subscription.armId}' references unknown wait group '${subscription.waitGroupId}'`,
        [...subscriptionPath, "waitGroupId"]
      ))
    } else {
      if (
        group.ownerTokenId !== subscription.tokenId ||
        group.processId !== subscription.processId ||
        group.scopeInstanceId !== subscription.scopeInstanceId ||
        group.generation !== subscription.generation ||
        group.openedAt !== subscription.openedAt ||
        group.armIds[subscription.ordinal] !== subscription.armId
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Subscription '${subscription.armId}' does not identify its exact ordered wait-group activation`,
          subscriptionPath
        ))
      }
      if (
        group.status === "waiting" &&
        subscription.status !== "waiting"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Waiting group '${group.waitGroupId}' cannot retain terminal arm '${subscription.armId}'`,
          [...subscriptionPath, "status"]
        ))
      }
      if (
        group.status === "cancelled" &&
        subscription.status !== "cancelled"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Cancelled group '${group.waitGroupId}' must cancel arm '${subscription.armId}'`,
          [...subscriptionPath, "status"]
        ))
      }
    }

    const node = nodeById.get(subscription.ownerNodeId)
    if (node === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownSubscriptionOwnerRef,
        `Subscription '${subscription.armId}' references unknown node '${subscription.ownerNodeId}'`,
        [...subscriptionPath, "ownerNodeId"]
      ))
      continue
    }
    if (node._tag !== "IntermediateCatchEvent") {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.armId}' must reference an intermediate catch event`,
        [...subscriptionPath, "ownerNodeId"]
      ))
      continue
    }

    const definitions = resolvedEventDefinitions(
      node,
      declaredEventDefinitionById
    )
    const expectedDefinitionTag = subscription._tag ===
        "MessageCatchSubscription"
      ? "MessageEventDefinition"
      : "TimerEventDefinition"
    if (
      definitions.length !== 1 ||
      definitions[0]?._tag !== expectedDefinitionTag
    ) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.armId}' requires exactly one matching ${expectedDefinitionTag}`,
        [...subscriptionPath, "ownerNodeId"]
      ))
    }

    const scope = scopeInstances.get(subscription.scopeInstanceId)
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Subscription '${subscription.armId}' references unknown scope instance '${subscription.scopeInstanceId}'`,
        [...subscriptionPath, "scopeInstanceId"]
      ))
    } else if (
      scope.processId !== subscription.processId ||
      scope.invocation.generation !== subscription.generation ||
      node.processId !== subscription.processId ||
      scope.definitionId !== node.parentScopeId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.armId}' process, scope, node, and generation must identify one exact activation`,
        subscriptionPath
      ))
    }

    if (group?.source._tag === "StandaloneCatch") {
      if (
        group.source.catchEventNodeId !== subscription.ownerNodeId ||
        subscription.sourceSequenceFlowId !== undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Standalone arm '${subscription.armId}' must be owned directly by its catch event`,
          [...subscriptionPath, "sourceSequenceFlowId"]
        ))
      }
    } else if (group?.source._tag === "EventBasedGateway") {
      const sourceFlow = subscription.sourceSequenceFlowId === undefined
        ? undefined
        : flowById.get(subscription.sourceSequenceFlowId)
      if (
        sourceFlow === undefined ||
        sourceFlow.sourceId !== group.source.gatewayNodeId ||
        sourceFlow.targetId !== subscription.ownerNodeId ||
        sourceFlow.kind !== "normal"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Event-based arm '${subscription.armId}' must identify its direct normal gateway branch`,
          [...subscriptionPath, "sourceSequenceFlowId"]
        ))
      }
    }

    if (subscription.openedAt < state.startedAt) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.armId}' opened before the execution started`,
        [...subscriptionPath, "openedAt"]
      ))
    }
    if (subscription.status === "waiting") {
      if (
        subscription.closedAt !== undefined ||
        subscription.cancellationReason !== undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Waiting subscription '${subscription.armId}' cannot retain terminal evidence`,
          subscriptionPath
        ))
      }
    } else if (subscription.status === "won") {
      if (
        subscription.closedAt === undefined ||
        subscription.cancellationReason !== undefined ||
        group?.status !== "won" ||
        group.winner?.armId !== subscription.armId
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Winning subscription '${subscription.armId}' must match its closed wait-group winner`,
          subscriptionPath
        ))
      }
    } else if (
      subscription.closedAt === undefined ||
      subscription.cancellationReason === undefined
    ) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Cancelled subscription '${subscription.armId}' requires closure evidence`,
        subscriptionPath
      ))
    }
    if (
      subscription.closedAt !== undefined &&
      (subscription.closedAt < subscription.openedAt ||
        (group?.closedAt !== undefined &&
          subscription.closedAt !== group.closedAt))
    ) {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Subscription '${subscription.armId}' closure must equal its wait-group closure and follow opening`,
        [...subscriptionPath, "closedAt"]
      ))
    }
    if (state.status !== "active" && subscription.status === "waiting") {
      diagnostics.push(codeError(
        Codes.InvalidSubscription,
        `Terminal execution '${state.status}' cannot retain waiting subscription '${subscription.armId}'`,
        [...subscriptionPath, "status"]
      ))
    }

    if (subscription._tag === "MessageCatchSubscription") {
      const definition = definitions[0]
      if (
        definition?._tag === "MessageEventDefinition" &&
        definition.messageRef !== subscription.messageRef
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Message subscription '${subscription.armId}' messageRef does not match its catch definition`,
          [...subscriptionPath, "messageRef"]
        ))
      }
      if (subscription.status === "won") {
        const receipt = subscription.receipt
        if (
          receipt === undefined ||
          receipt.messageRef !== subscription.messageRef ||
          !sameStrings(receipt.correlationKey, subscription.correlationKey) ||
          receipt.acceptedAt < subscription.openedAt ||
          group?.winner?._tag !== "MessageWinner" ||
          group.winner.deliveryId !== receipt.deliveryId ||
          group.winner.acceptedAt !== receipt.acceptedAt ||
          group.winner.selectedAt !== receipt.acceptedAt ||
          group.winner.recordedAt !== receipt.acceptedAt
        ) {
          diagnostics.push(codeError(
            Codes.InvalidSubscription,
            `Winning Message arm '${subscription.armId}' must retain its exact active-window receipt and winner evidence`,
            [...subscriptionPath, "receipt"]
          ))
        } else if (consumedDeliveryIds.has(receipt.deliveryId)) {
          diagnostics.push(codeError(
            Codes.InvalidSubscription,
            `Message delivery '${receipt.deliveryId}' cannot win more than one wait group`,
            [...subscriptionPath, "receipt", "deliveryId"]
          ))
        } else {
          consumedDeliveryIds.add(receipt.deliveryId)
        }
      } else if (subscription.receipt !== undefined) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Only a winning Message arm may retain a receipt`,
          [...subscriptionPath, "receipt"]
        ))
      }
    } else {
      const timer = timers.get(subscription.timerId)
      if (
        timer === undefined ||
        timer.armId !== subscription.armId ||
        timer.waitGroupId !== subscription.waitGroupId
      ) {
        diagnostics.push(codeError(
          Codes.UnknownTimerOwnerRef,
          `Timer subscription '${subscription.armId}' must own exact timer '${subscription.timerId}'`,
          [...subscriptionPath, "timerId"]
        ))
      }
      if (
        subscription.status === "won" &&
        group?.winner?._tag !== "TimerWinner"
      ) {
        diagnostics.push(codeError(
          Codes.InvalidSubscription,
          `Winning Timer arm '${subscription.armId}' must match a Timer winner`,
          [...subscriptionPath, "status"]
        ))
      }
    }
  }

  const scheduleIds = new Set<string>()
  const timerReceiptIds = new Set<string>()
  for (let index = 0; index < state.timers.length; index++) {
    const timer = state.timers[index]!
    const timerPath = ["timers", index] as const
    registerId(
      seenStateIds,
      diagnostics,
      timer.timerId,
      [...timerPath, "timerId"]
    )
    const arm = subscriptions.get(timer.armId)
    const group = catchWaitGroups.get(timer.waitGroupId)
    const scope = scopeInstances.get(timer.scopeInstanceId)
    const token = tokens.get(timer.tokenId)
    if (
      arm?._tag !== "TimerCatchSubscription" ||
      arm.timerId !== timer.timerId ||
      arm.waitGroupId !== timer.waitGroupId
    ) {
      diagnostics.push(codeError(
        Codes.UnknownTimerOwnerRef,
        `Timer '${timer.timerId}' must reference its exact Timer subscription arm`,
        [...timerPath, "armId"]
      ))
    }
    if (group === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownCatchWaitGroupRef,
        `Timer '${timer.timerId}' references unknown wait group '${timer.waitGroupId}'`,
        [...timerPath, "waitGroupId"]
      ))
    }
    if (scope === undefined) {
      diagnostics.push(codeError(
        Codes.UnknownParentScopeInstanceRef,
        `Timer '${timer.timerId}' references unknown scope instance '${timer.scopeInstanceId}'`,
        [...timerPath, "scopeInstanceId"]
      ))
    }
    if (
      group !== undefined &&
      (timer.processId !== group.processId ||
        timer.scopeInstanceId !== group.scopeInstanceId ||
        timer.tokenId !== group.ownerTokenId ||
        timer.generation !== group.generation ||
        timer.scheduledAt !== group.openedAt)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Timer '${timer.timerId}' must identify its exact wait-group activation and schedule anchor`,
        timerPath
      ))
    }
    if (
      scope !== undefined &&
      (scope.processId !== timer.processId ||
        scope.invocation.generation !== timer.generation)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Timer '${timer.timerId}' process and generation must match its scope`,
        timerPath
      ))
    }
    if (
      token !== undefined &&
      (token.processId !== timer.processId ||
        token.scopeInstanceId !== timer.scopeInstanceId ||
        token.invocation.generation !== timer.generation)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Timer '${timer.timerId}' token must identify the same activation`,
        [...timerPath, "tokenId"]
      ))
    }

    const scheduledEpoch = Date.parse(timer.scheduledAt)
    const dueEpoch = Date.parse(timer.schedule.dueAt)
    const expectedDelay = Math.max(0, dueEpoch - scheduledEpoch)
    let invalidFixedDuration = false
    if (timer.schedule._tag === "TimeDuration") {
      const fixedDuration = BpmnTime.parseFixedDuration(
        timer.schedule.lexical,
        timer.schedule.delayMillis
      )
      invalidFixedDuration = Result.isFailure(fixedDuration) ||
        fixedDuration.success.delayMillis !== timer.schedule.delayMillis ||
        dueEpoch !== scheduledEpoch + timer.schedule.delayMillis
    }
    if (
      !Number.isSafeInteger(scheduledEpoch) ||
      !Number.isSafeInteger(dueEpoch) ||
      timer.schedule.delayMillis !== expectedDelay ||
      invalidFixedDuration ||
      (timer.schedule._tag === "TimeDate" &&
        timer.schedule.lexical !== timer.schedule.dueAt)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Timer '${timer.timerId}' lexical value, delay, anchor, and absolute dueAt must agree exactly`,
        [...timerPath, "schedule"]
      ))
    }

    const receipt = timer.armReceipt
    if (
      (receipt === undefined) !==
        (timer.armAcknowledgedAt === undefined)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Timer '${timer.timerId}' arm receipt and acknowledgement time must appear together`,
        [...timerPath, "armReceipt"]
      ))
    }
    if (receipt !== undefined && timer.armAcknowledgedAt !== undefined) {
      if (
        receipt.armedAt < timer.scheduledAt ||
        timer.armAcknowledgedAt < receipt.armedAt ||
        scheduleIds.has(receipt.scheduleId) ||
        timerReceiptIds.has(receipt.receiptId)
      ) {
        diagnostics.push(codeError(
          Codes.InvalidTimer,
          `Timer '${timer.timerId}' arm receipt must be unique and cannot predate scheduling`,
          [...timerPath, "armReceipt"]
        ))
      } else {
        scheduleIds.add(receipt.scheduleId)
        timerReceiptIds.add(receipt.receiptId)
      }
    }

    if (timer.status === "scheduled") {
      if (
        receipt !== undefined ||
        timer.armAcknowledgedAt !== undefined ||
        timer.observedAt !== undefined ||
        timer.firedAt !== undefined ||
        timer.cancelledAt !== undefined ||
        timer.cancellationReason !== undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidTimer,
          `Scheduled timer '${timer.timerId}' cannot retain arm or terminal evidence`,
          timerPath
        ))
      }
    } else if (timer.status === "armed") {
      if (
        receipt === undefined ||
        timer.armAcknowledgedAt === undefined ||
        timer.observedAt !== undefined ||
        timer.firedAt !== undefined ||
        timer.cancelledAt !== undefined ||
        timer.cancellationReason !== undefined
      ) {
        diagnostics.push(codeError(
          Codes.InvalidTimer,
          `Armed timer '${timer.timerId}' requires only its durable arm receipt`,
          timerPath
        ))
      }
    } else if (timer.status === "fired") {
      const logicalFireAt = timer.schedule.dueAt < timer.scheduledAt
        ? timer.scheduledAt
        : timer.schedule.dueAt
      if (
        timer.observedAt === undefined ||
        timer.firedAt !== logicalFireAt ||
        timer.observedAt < logicalFireAt ||
        timer.cancelledAt !== undefined ||
        timer.cancellationReason !== undefined ||
        arm?.status !== "won" ||
        group?.winner?._tag !== "TimerWinner" ||
        group.winner.timerId !== timer.timerId ||
        group.winner.dueAt !== timer.schedule.dueAt ||
        group.winner.observedAt !== timer.observedAt ||
        group.winner.selectedAt !== logicalFireAt ||
        group.winner.recordedAt < group.winner.observedAt
      ) {
        diagnostics.push(codeError(
          Codes.InvalidTimer,
          `Fired timer '${timer.timerId}' must retain exact logical-deadline winner evidence`,
          timerPath
        ))
      }
    } else if (
      timer.cancelledAt === undefined ||
      timer.cancellationReason === undefined ||
      timer.observedAt !== undefined ||
      timer.firedAt !== undefined ||
      arm?.status !== "cancelled" ||
      (timer.armAcknowledgedAt !== undefined &&
        timer.armAcknowledgedAt > timer.cancelledAt)
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Cancelled timer '${timer.timerId}' must retain only consistent cancellation and optional prior arm evidence`,
        timerPath
      ))
    }
    if (
      timer.cancelledAt !== undefined &&
      timer.cancelledAt < timer.scheduledAt
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Timer '${timer.timerId}' cannot be cancelled before scheduling`,
        [...timerPath, "cancelledAt"]
      ))
    }
    if (
      state.status !== "active" &&
      (timer.status === "scheduled" || timer.status === "armed")
    ) {
      diagnostics.push(codeError(
        Codes.InvalidTimer,
        `Terminal execution '${state.status}' cannot retain live timer '${timer.timerId}'`,
        [...timerPath, "status"]
      ))
    }
  }

  const recordedDeliveryIds = new Set<string>()
  const deliveryByWaitGroup = new Map<string, MessageDeliveryRecord>()
  for (let index = 0; index < state.messageDeliveries.length; index++) {
    const delivery = state.messageDeliveries[index]!
    const deliveryPath = ["messageDeliveries", index] as const
    const group = catchWaitGroups.get(delivery.target.waitGroupId)
    const arm = subscriptions.get(delivery.target.armId)
    const token = tokens.get(delivery.target.tokenId)
    const duplicateDelivery = recordedDeliveryIds.has(
      delivery.receipt.deliveryId
    )
    const duplicateGroup = deliveryByWaitGroup.has(
      delivery.target.waitGroupId
    )
    if (
      group === undefined ||
      arm?._tag !== "MessageCatchSubscription" ||
      token === undefined ||
      group.ownerTokenId !== delivery.target.tokenId ||
      group.scopeInstanceId !== delivery.target.scopeInstanceId ||
      group.generation !== delivery.target.generation ||
      arm.waitGroupId !== delivery.target.waitGroupId ||
      arm.ownerNodeId !== delivery.target.catchEventNodeId ||
      arm.scopeInstanceId !== delivery.target.scopeInstanceId ||
      arm.tokenId !== delivery.target.tokenId ||
      arm.generation !== delivery.target.generation ||
      delivery.receipt.messageRef !== arm.messageRef ||
      !sameStrings(
        delivery.receipt.correlationKey,
        arm.correlationKey
      ) ||
      delivery.receipt.acceptedAt < arm.openedAt ||
      delivery.recordedAt !== delivery.receipt.acceptedAt ||
      group.closedAt !== delivery.recordedAt ||
      duplicateDelivery ||
      duplicateGroup
    ) {
      diagnostics.push(codeError(
        Codes.InvalidMessageDelivery,
        `Message delivery '${delivery.receipt.deliveryId}' must identify one unique, exact, closed catch activation`,
        deliveryPath
      ))
      continue
    }
    if (delivery.disposition === "message-winner") {
      if (
        group.status !== "won" ||
        group.winner?._tag !== "MessageWinner" ||
        group.winner.armId !== arm.armId ||
        group.winner.deliveryId !== delivery.receipt.deliveryId ||
        group.winner.acceptedAt !== delivery.receipt.acceptedAt ||
        arm.status !== "won" ||
        arm.receipt === undefined ||
        !sameJson(
          arm.receipt as unknown as Schema.Json,
          delivery.receipt as unknown as Schema.Json
        )
      ) {
        diagnostics.push(codeError(
          Codes.InvalidMessageDelivery,
          `Message-winning delivery '${delivery.receipt.deliveryId}' does not match its retained winner receipt`,
          [...deliveryPath, "disposition"]
        ))
        continue
      }
    } else if (
      group.status !== "won" ||
      group.winner?._tag !== "TimerWinner" ||
      group.winner.observedAt !== delivery.receipt.acceptedAt ||
      group.winner.selectedAt > delivery.receipt.acceptedAt ||
      arm.status !== "cancelled" ||
      arm.receipt !== undefined
    ) {
      diagnostics.push(codeError(
        Codes.InvalidMessageDelivery,
        `Timer-preempted delivery '${delivery.receipt.deliveryId}' does not match its due Timer winner`,
        [...deliveryPath, "disposition"]
      ))
      continue
    }
    recordedDeliveryIds.add(delivery.receipt.deliveryId)
    deliveryByWaitGroup.set(delivery.target.waitGroupId, delivery)
  }
  for (let index = 0; index < state.subscriptions.length; index++) {
    const arm = state.subscriptions[index]!
    if (
      arm._tag === "MessageCatchSubscription" &&
      arm.receipt !== undefined &&
      deliveryByWaitGroup.get(arm.waitGroupId)?.receipt.deliveryId !==
        arm.receipt.deliveryId
    ) {
      diagnostics.push(codeError(
        Codes.InvalidMessageDelivery,
        `Winning Message arm '${arm.armId}' requires its exact delivery ledger record`,
        ["subscriptions", index, "receipt"]
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
