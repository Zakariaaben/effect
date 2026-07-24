/**
 * Pure executable BPMN token-kernel foundations.
 *
 * **Details**
 *
 * This module intentionally supports only one coherent executable subset of
 * BPMN 2.0.2: root and embedded subprocess scopes, none start and end events,
 * generic tasks (including immutable protocol-v3 bindings, bounded standard
 * loops, and fixed cardinality- or collection-based multi-instance execution),
 * at most one
 * interrupting Boundary Error per bound task, normal / conditional / default
 * sequence flows, exclusive gateways, and parallel gateways. Unsupported BPMN
 * constructs are rejected at compile time with aggregate diagnostics.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnActivityV3 from "./BpmnActivityV3.ts"
import * as BpmnData from "./BpmnData.ts"
import * as BpmnExecutionState from "./BpmnExecutionState.ts"
import * as BpmnExpression from "./BpmnExpression.ts"
import * as BpmnExpressionEvaluator from "./BpmnExpressionEvaluator.ts"
import * as BpmnModel from "./BpmnModel.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as DigestV2 from "./DigestV2.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "./ProtocolV3Wire.ts"
import * as SemanticOccurrenceV3 from "./SemanticOccurrenceV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const sortPath = (
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

const sortDiagnostics = (
  diagnostics: Array<Diagnostic.Diagnostic>
): Array<Diagnostic.Diagnostic> =>
  diagnostics.sort((left, right) => {
    const path = sortPath(left.path, right.path)
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

/**
 * Stable machine-readable token-kernel diagnostics.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  UnsupportedProcess: "UnsupportedProcess",
  UnsupportedNode: "UnsupportedNode",
  UnsupportedGateway: "UnsupportedGateway",
  UnsupportedEvent: "UnsupportedEvent",
  UnsupportedLoop: "UnsupportedLoop",
  UnsupportedActivity: "UnsupportedActivity",
  InvalidExecutableStructure: "InvalidExecutableStructure",
  InvalidCommand: "InvalidCommand",
  InvalidKernel: "InvalidKernel",
  InvalidKernelLimits: "InvalidKernelLimits",
  InvalidKernelProfile: "InvalidKernelProfile",
  InvalidKernelState: "InvalidKernelState",
  InvalidServices: "InvalidServices",
  InvalidTransitionJournal: "InvalidTransitionJournal",
  BpmnModelFingerprintMismatch: "BpmnModelFingerprintMismatch",
  BpmnJournalModelMismatch: "BpmnJournalModelMismatch",
  EvaluationRequired: "EvaluationRequired",
  EvaluationFailed: "EvaluationFailed",
  AutomaticTransitionLimitExceeded: "AutomaticTransitionLimitExceeded"
} as const

/**
 * A stable machine-readable BPMN token-kernel diagnostic code.
 *
 * @category models
 * @since 4.0.0
 */
export type Code = typeof Codes[keyof typeof Codes]

const error = (
  code: Code,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

/**
 * Version of the executable BPMN token-kernel semantics.
 *
 * **Details**
 *
 * This value is committed by every executable fingerprint and must change
 * whenever the same normalized model and profile can acquire different
 * execution meaning.
 *
 * @category constants
 * @since 4.0.0
 */
export const KernelSemanticVersion = BpmnExecutionState.BpmnKernelSemanticVersion

/**
 * Version of the transition-journal envelope represented by its leading
 * {@link TransitionEvent} header.
 *
 * @category constants
 * @since 4.0.0
 */
export const TransitionJournalVersion = 5 as const

/**
 * Version of the durable execution-start command.
 *
 * @category constants
 * @since 4.0.0
 */
export const InitializeCommandVersion = 1 as const

/**
 * Version of the external value binding used by the fixed collection
 * multi-instance profile.
 *
 * @category constants
 * @since 4.0.0
 */
export const MultiInstanceCollectionBindingVersion = 1 as const

/**
 * One explicit, build-pinned value binding for a BPMN collection DataInput.
 *
 * **Details**
 *
 * `loopDataInputRef` is an IDREF, not an expression. This binding therefore
 * remains separate from the BPMN model: it describes how the selected
 * deployment derives that DataInput value from the durable execution and
 * scope context. The expression and its exact evaluator build become part of
 * the executable fingerprint.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceCollectionBinding = Schema.Struct({
  bindingVersion: Schema.Literal(MultiInstanceCollectionBindingVersion),
  taskNodeId: Identifier,
  dataInputRef: Identifier,
  collectionExpression: BpmnModel.Expression
}).annotate({
  identifier: "WorkflowBpmnMultiInstanceCollectionBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceCollectionBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceCollectionBinding = Schema.Schema.Type<
  typeof MultiInstanceCollectionBinding
>

/**
 * Versioned input used to start one BPMN execution.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InitializeCommand = Schema.Struct({
  commandVersion: Schema.Literal(InitializeCommandVersion),
  input: Schema.Json
}).annotate({
  identifier: "WorkflowBpmnInitializeCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InitializeCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type InitializeCommand = Schema.Schema.Type<typeof InitializeCommand>

/**
 * BPMN multi-instance runtime counters captured at one decision boundary.
 *
 * **Details**
 *
 * `numberOfInstances` counts members generated by that boundary, not the
 * cardinality still waiting in the sequential group's pending suffix. The
 * other three counters therefore sum exactly to `numberOfInstances`, matching
 * the BPMN runtime invariant. The frozen source cardinality remains available
 * on the durable group.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceRuntimeCounters = Schema.Struct({
  numberOfInstances: NonNegativeInt,
  numberOfActiveInstances: NonNegativeInt,
  numberOfCompletedInstances: NonNegativeInt,
  numberOfTerminatedInstances: NonNegativeInt
}).check(
  Schema.makeFilter(
    (counters) =>
      counters.numberOfInstances ===
        counters.numberOfActiveInstances +
          counters.numberOfCompletedInstances +
          counters.numberOfTerminatedInstances,
    {
      expected: "numberOfInstances equals active plus completed plus terminated instances"
    }
  )
).annotate({
  identifier: "WorkflowBpmnMultiInstanceRuntimeCounters",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceRuntimeCounters}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceRuntimeCounters = Schema.Schema.Type<
  typeof MultiInstanceRuntimeCounters
>

/**
 * Transition journal event emitted by the executable token kernel.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TransitionEvent = Schema.Union([
  Schema.TaggedStruct("JournalStarted", {
    journalVersion: Schema.Literal(TransitionJournalVersion),
    model: BpmnExecutionState.ModelReference,
    input: Schema.Json,
    inputCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
    startedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ScopeEntered", {
    scopeInstanceId: Identifier,
    definitionId: Identifier,
    processId: Identifier,
    parentScopeInstanceId: Schema.optionalKey(Identifier),
    invocation: BpmnExecutionState.InvocationIdentity,
    enteredAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("TokenConsumed", {
    tokenId: Identifier,
    reason: Schema.Literals([
      "flow-advanced",
      "task-completed",
      "task-succeeded",
      "parallel-join-arrival",
      "end-reached",
      "subprocess-entered"
    ]),
    consumedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("TokenWithdrawn", {
    tokenId: Identifier,
    reason: Schema.Literals([
      "boundary-error-caught",
      "multi-instance-completion-condition",
      "execution-cancelled",
      "uncaught-bpmn-error",
      "unmapped-business-failure"
    ]),
    withdrawnAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("TokenEmitted", {
    tokenId: Identifier,
    processId: Identifier,
    scopeInstanceId: Identifier,
    invocation: BpmnExecutionState.InvocationIdentity,
    position: BpmnExecutionState.TokenPosition,
    createdAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("TaskWaiting", {
    tokenId: Identifier,
    taskNodeId: Identifier,
    scopeInstanceId: Identifier,
    enteredAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("LoopOpened", {
    frameId: Identifier,
    activityId: Identifier,
    processId: Identifier,
    scopeInstanceId: Identifier,
    activation: NonNegativeInt,
    openedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("LoopConditionEvaluated", {
    frameId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    phase: Schema.Literals(["before", "after"]),
    iteration: NonNegativeInt,
    expression: BpmnModel.Expression,
    evaluatorBinding: BpmnExpression.EvaluatorBinding,
    usage: Schema.Struct({
      sourceUtf8Bytes: ProtocolV2Wire.NonNegativeSafeInt,
      contextCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
      steps: ProtocolV2Wire.NonNegativeSafeInt
    }),
    result: Schema.Boolean
  }),
  Schema.TaggedStruct("LoopIterationStarted", {
    frameId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    iteration: NonNegativeInt,
    startedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("LoopIterationCompleted", {
    frameId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    iteration: NonNegativeInt,
    completedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("LoopCompleted", {
    frameId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    completedIterations: NonNegativeInt,
    reason: Schema.Literals(["condition-false", "maximum-reached"]),
    completedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("LoopFrameCancelled", {
    frameId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    sourceTokenId: Identifier,
    reason: Schema.Literals([
      "boundary-error-caught",
      "uncaught-bpmn-error",
      "unmapped-business-failure"
    ]),
    cancelledAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceCardinalityEvaluated", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    expression: BpmnModel.Expression,
    evaluatorBinding: BpmnExpression.EvaluatorBinding,
    usage: Schema.Struct({
      sourceUtf8Bytes: ProtocolV2Wire.NonNegativeSafeInt,
      contextCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
      steps: ProtocolV2Wire.NonNegativeSafeInt
    }),
    cardinality: NonNegativeInt
  }),
  Schema.TaggedStruct("MultiInstanceCollectionEvaluated", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    dataInputRef: Identifier,
    expression: BpmnModel.Expression,
    evaluatorBinding: BpmnExpression.EvaluatorBinding,
    usage: Schema.Struct({
      sourceUtf8Bytes: ProtocolV2Wire.NonNegativeSafeInt,
      contextCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
      steps: ProtocolV2Wire.NonNegativeSafeInt
    }),
    collectionCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
    itemCanonicalBytes: Schema.Array(
      ProtocolV2Wire.NonNegativeSafeInt
    ),
    items: Schema.Array(Schema.Json)
  }),
  Schema.TaggedStruct("MultiInstanceGroupOpened", {
    groupId: Identifier,
    activityId: Identifier,
    processId: Identifier,
    scopeInstanceId: Identifier,
    activation: NonNegativeInt,
    mode: Schema.Literals(["sequential", "parallel"]),
    source: BpmnExecutionState.MultiInstanceSource,
    itemKeys: Schema.Array(Identifier),
    openedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceItemStarted", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    itemIndex: NonNegativeInt,
    itemKey: Identifier,
    startedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceItemCompleted", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    itemIndex: NonNegativeInt,
    itemKey: Identifier,
    output: Schema.optionalKey(Schema.Json),
    counters: MultiInstanceRuntimeCounters,
    completedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceCompletionConditionEvaluated", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    itemIndex: NonNegativeInt,
    itemKey: Identifier,
    expression: BpmnModel.Expression,
    evaluatorBinding: BpmnExpression.EvaluatorBinding,
    usage: Schema.Struct({
      sourceUtf8Bytes: ProtocolV2Wire.NonNegativeSafeInt,
      contextCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
      steps: ProtocolV2Wire.NonNegativeSafeInt
    }),
    counters: MultiInstanceRuntimeCounters,
    result: Schema.Boolean
  }),
  Schema.TaggedStruct("MultiInstanceItemTerminated", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    itemIndex: NonNegativeInt,
    itemKey: Identifier,
    reason: BpmnExecutionState.MultiInstanceClosureReason,
    terminatedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceItemNotGenerated", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    itemIndex: NonNegativeInt,
    itemKey: Identifier,
    reason: BpmnExecutionState.MultiInstanceClosureReason,
    notGeneratedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceGroupCompleted", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    counters: MultiInstanceRuntimeCounters,
    output: Schema.optionalKey(BpmnExecutionState.MultiInstanceOutput),
    reason: Schema.Literals([
      "all-completed",
      "completion-condition",
      "empty"
    ]),
    completedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("MultiInstanceGroupCancelled", {
    groupId: Identifier,
    activityId: Identifier,
    activation: NonNegativeInt,
    sourceTokenId: Identifier,
    counters: MultiInstanceRuntimeCounters,
    reason: Schema.Literals([
      "boundary-error-caught",
      "uncaught-bpmn-error",
      "unmapped-business-failure",
      "execution-cancelled"
    ]),
    cancelledAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("GatewayFrameOpened", {
    frameId: Identifier,
    gatewayId: Identifier,
    processId: Identifier,
    scopeInstanceId: Identifier,
    activationId: Identifier,
    joinEpoch: PositiveInt,
    expectedIncomingSequenceFlowIds: Schema.Array(Identifier)
  }),
  Schema.TaggedStruct("GatewayArrivalRecorded", {
    frameId: Identifier,
    gatewayId: Identifier,
    joinEpoch: PositiveInt,
    sequenceFlowId: Identifier,
    arrivedIncomingSequenceFlowIds: Schema.Array(Identifier)
  }),
  Schema.TaggedStruct("GatewayFired", {
    frameId: Identifier,
    gatewayId: Identifier,
    joinEpoch: PositiveInt,
    firedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ConditionEvaluated", {
    sequenceFlowId: Identifier,
    expression: BpmnModel.Expression,
    evaluatorBinding: BpmnExpression.EvaluatorBinding,
    usage: Schema.Struct({
      sourceUtf8Bytes: ProtocolV2Wire.NonNegativeSafeInt,
      contextCanonicalBytes: ProtocolV2Wire.NonNegativeSafeInt,
      steps: ProtocolV2Wire.NonNegativeSafeInt
    }),
    result: Schema.Boolean
  }),
  Schema.TaggedStruct("OutgoingSelected", {
    sourceNodeId: Identifier,
    routingKind: Schema.Literals(["activity", "exclusive-gateway"]),
    sequenceFlowIds: Schema.Array(Identifier)
  }),
  Schema.TaggedStruct("TaskCompletionReplayed", {
    tokenId: Identifier,
    observedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("TaskOutcomeAccepted", {
    resolution: BpmnActivityV3.ActivityResolution
  }),
  Schema.TaggedStruct("TaskOutcomeReplayed", {
    tokenId: Identifier,
    occurrenceDigest: ProtocolV3Wire.OccurrenceDigest,
    observedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("BoundaryErrorCaught", {
    tokenId: Identifier,
    taskNodeId: Identifier,
    boundaryEventId: Identifier,
    errorRef: Identifier,
    caughtAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("GatewayFrameCancelled", {
    frameId: Identifier,
    sourceTokenId: Identifier,
    cancelledAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ScopeInterruptedByError", {
    scopeInstanceId: Identifier,
    definitionId: Identifier,
    sourceTokenId: Identifier,
    exitedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ScopeFailed", {
    scopeInstanceId: Identifier,
    definitionId: Identifier,
    sourceTokenId: Identifier,
    exitedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ScopeCompleted", {
    scopeInstanceId: Identifier,
    definitionId: Identifier,
    exitedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ExecutionCompleted", {
    rootScopeInstanceId: Identifier,
    completedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ExecutionFailed", {
    rootScopeInstanceId: Identifier,
    sourceTokenId: Identifier,
    taskNodeId: Identifier,
    failureKind: Schema.Literals([
      "UnmappedBusinessFailure",
      "UncaughtBpmnError"
    ]),
    errorRef: Schema.optionalKey(Identifier),
    failedAt: ProtocolV2Wire.Timestamp
  })
]).annotate({
  identifier: "WorkflowBpmnTransitionEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TransitionEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export type TransitionEvent = Schema.Schema.Type<typeof TransitionEvent>

/**
 * A complete ordered token-kernel transition journal.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TransitionJournal = Schema.Array(TransitionEvent).annotate({
  identifier: "WorkflowBpmnTransitionJournal",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TransitionJournal}.
 *
 * @category models
 * @since 4.0.0
 */
export type TransitionJournal = Schema.Schema.Type<typeof TransitionJournal>

/**
 * Condition-evaluation context supplied by the caller.
 *
 * @category models
 * @since 4.0.0
 */
interface EvaluationContextBase {
  readonly expression: BpmnModel.Expression
  readonly evaluatorBinding: BpmnExpression.EvaluatorBinding
  readonly request: BpmnExpressionEvaluator.EvaluationRequest
  readonly scopeInstance: BpmnExecutionState.ScopeInstance | MutableScopeInstance
  readonly state: BpmnExecutionState.BpmnExecutionState | MutableState
}

/**
 * Evaluation of one conditional sequence flow.
 *
 * @category models
 * @since 4.0.0
 */
export interface SequenceFlowEvaluationContext extends EvaluationContextBase {
  readonly _tag: "SequenceFlowCondition"
  readonly sequenceFlow: BpmnModel.SequenceFlow
  readonly sourceNode: BpmnModel.Task | BpmnModel.SubProcess | BpmnModel.Gateway
}

/**
 * Evaluation of one bounded BPMN standard-loop condition.
 *
 * **Details**
 *
 * `iteration` is the zero-based candidate iteration for `before`, and the
 * zero-based iteration that just completed for `after`.
 *
 * @category models
 * @since 4.0.0
 */
export interface StandardLoopEvaluationContext extends EvaluationContextBase {
  readonly _tag: "StandardLoopCondition"
  readonly activity: BpmnModel.Task
  readonly loopFrame: BpmnExecutionState.LoopFrame
  readonly phase: "before" | "after"
  readonly iteration: number
}

/**
 * Evaluation of a fixed multi-instance cardinality.
 *
 * **Details**
 *
 * The expression is evaluated exactly once for one activity activation before
 * any member is generated.
 *
 * @category models
 * @since 4.0.0
 */
export interface MultiInstanceCardinalityEvaluationContext extends EvaluationContextBase {
  readonly _tag: "MultiInstanceCardinality"
  readonly activity: BpmnModel.Task
  readonly groupId: string
  readonly groupActivation: number
}

/**
 * Resolution of one fixed collection DataInput before any member is generated.
 *
 * @category models
 * @since 4.0.0
 */
export interface MultiInstanceCollectionEvaluationContext extends EvaluationContextBase {
  readonly _tag: "MultiInstanceCollection"
  readonly activity: BpmnModel.Task
  readonly groupId: string
  readonly groupActivation: number
  readonly dataInputRef: string
}

/**
 * Evaluation of a multi-instance completion condition after one logical
 * member completion has committed.
 *
 * @category models
 * @since 4.0.0
 */
export interface MultiInstanceCompletionEvaluationContext extends EvaluationContextBase {
  readonly _tag: "MultiInstanceCompletionCondition"
  readonly activity: BpmnModel.Task
  readonly multiInstanceGroup: BpmnExecutionState.MultiInstanceGroup
  readonly completedMember: BpmnExecutionState.MultiInstanceMember
  readonly runtime: {
    readonly loopCounter: number
    readonly numberOfInstances: number
    readonly numberOfActiveInstances: number
    readonly numberOfCompletedInstances: number
    readonly numberOfTerminatedInstances: number
  }
}

/**
 * Exact immutable context supplied to one expression evaluator.
 *
 * @category models
 * @since 4.0.0
 */
export type EvaluationContext =
  | SequenceFlowEvaluationContext
  | StandardLoopEvaluationContext
  | MultiInstanceCardinalityEvaluationContext
  | MultiInstanceCollectionEvaluationContext
  | MultiInstanceCompletionEvaluationContext

/**
 * Services needed while advancing executable BPMN state.
 *
 * @category models
 * @since 4.0.0
 */
export interface Services {
  readonly now: ProtocolV2Wire.Timestamp
  readonly evaluateExpression?: (
    context: EvaluationContext
  ) => Result.Result<
    BpmnExpressionEvaluator.EvaluationResult,
    Diagnostic.CompilationError
  >
}

/**
 * Explicit safety bounds for one compiled token kernel.
 *
 * @category schemas
 * @since 4.0.0
 */
export const KernelLimits = Schema.Struct({
  maxAutomaticTransitions: PositiveInt,
  maxExecutionInputCanonicalBytes: PositiveInt,
  maxMultiInstanceCardinality: PositiveInt,
  maxMultiInstanceCollectionCanonicalBytes: PositiveInt,
  maxMultiInstanceItemCanonicalBytes: PositiveInt,
  maxMultiInstanceOutputCanonicalBytes: PositiveInt,
  maxMultiInstanceItemOutputCanonicalBytes: PositiveInt
}).annotate({
  identifier: "WorkflowBpmnKernelLimits",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link KernelLimits}.
 *
 * @category models
 * @since 4.0.0
 */
export type KernelLimits = Schema.Schema.Type<typeof KernelLimits>

/**
 * Exact portable profile used to prepare one executable token kernel.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompileOptions = Schema.Struct({
  profileId: Identifier,
  rootProcessId: Identifier,
  limits: KernelLimits,
  evaluatorBindings: Schema.Array(BpmnExpression.EvaluatorBinding),
  taskBindings: Schema.optionalKey(Schema.Array(BpmnActivityV3.TaskBinding)),
  dataDocument: Schema.optionalKey(BpmnData.BpmnDataDocument),
  collectionBindings: Schema.optionalKey(
    Schema.Array(MultiInstanceCollectionBinding)
  )
}).annotate({
  identifier: "WorkflowBpmnKernelCompileOptions",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompileOptions}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompileOptions = Schema.Schema.Type<typeof CompileOptions>

/**
 * Canonical document committed by an executable BPMN fingerprint.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExecutableFingerprintDocument = Schema.Struct({
  fingerprintVersion: Schema.Literal(
    BpmnExecutionState.BpmnExecutableFingerprintVersion
  ),
  kernelSemanticVersion: Schema.Literal(KernelSemanticVersion),
  bpmnSpecVersion: Schema.Literal("2.0.2"),
  profileId: Identifier,
  rootProcessId: Identifier,
  limits: KernelLimits,
  evaluatorBindings: Schema.Array(BpmnExpression.EvaluatorBinding),
  taskBindings: Schema.Array(BpmnActivityV3.TaskBinding),
  dataDocument: Schema.NullOr(BpmnData.BpmnDataDocument),
  collectionBindings: Schema.Array(MultiInstanceCollectionBinding),
  model: BpmnModel.BpmnModel
}).annotate({
  identifier: "WorkflowBpmnExecutableFingerprintDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExecutableFingerprintDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExecutableFingerprintDocument = Schema.Schema.Type<
  typeof ExecutableFingerprintDocument
>

/**
 * One validated executable BPMN subset.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledKernel {
  readonly model: BpmnModel.BpmnModel
  readonly modelReference: BpmnExecutionState.ModelReference
  readonly profileId: string
  readonly evaluatorBindings: ReadonlyArray<BpmnExpression.EvaluatorBinding>
  readonly taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding>
  readonly dataDocument: BpmnData.BpmnDataDocument | null
  readonly collectionBindings: ReadonlyArray<MultiInstanceCollectionBinding>
  readonly rootProcessId: string
  readonly rootStartEventId: string
  readonly limits: KernelLimits
  readonly startEventIdByScopeId: ReadonlyMap<string, string>
  readonly nodeById: ReadonlyMap<string, BpmnModel.FlowNode>
  readonly flowById: ReadonlyMap<string, BpmnModel.SequenceFlow>
  readonly orderedOutgoingByNodeId: ReadonlyMap<string, ReadonlyArray<string>>
  readonly taskBindingByTaskNodeId: ReadonlyMap<string, BpmnActivityV3.TaskBinding>
  readonly collectionBindingByTaskNodeId: ReadonlyMap<
    string,
    MultiInstanceCollectionBinding
  >
  readonly boundaryErrorByTaskNodeId: ReadonlyMap<string, BpmnModel.BoundaryEvent>
}

interface CompiledStructure {
  readonly model: BpmnModel.BpmnModel
  readonly profileId: string
  readonly evaluatorBindings: ReadonlyArray<BpmnExpression.EvaluatorBinding>
  readonly taskBindings: ReadonlyArray<BpmnActivityV3.TaskBinding>
  readonly dataDocument: BpmnData.BpmnDataDocument | null
  readonly collectionBindings: ReadonlyArray<MultiInstanceCollectionBinding>
  readonly rootProcessId: string
  readonly rootStartEventId: string
  readonly limits: KernelLimits
  readonly startEventIdByScopeId: ReadonlyMap<string, string>
  readonly nodeById: ReadonlyMap<string, BpmnModel.FlowNode>
  readonly flowById: ReadonlyMap<string, BpmnModel.SequenceFlow>
  readonly orderedOutgoingByNodeId: ReadonlyMap<
    string,
    ReadonlyArray<string>
  >
  readonly taskBindingByTaskNodeId: ReadonlyMap<string, BpmnActivityV3.TaskBinding>
  readonly collectionBindingByTaskNodeId: ReadonlyMap<
    string,
    MultiInstanceCollectionBinding
  >
  readonly boundaryErrorByTaskNodeId: ReadonlyMap<string, BpmnModel.BoundaryEvent>
}

/**
 * One pure token-kernel state transition batch.
 *
 * @category models
 * @since 4.0.0
 */
export interface TransitionBatch {
  readonly state: BpmnExecutionState.BpmnExecutionState
  readonly events: ReadonlyArray<TransitionEvent>
}

/**
 * One optimistic task-completion command.
 *
 * @category models
 * @since 4.0.0
 */
export const CompleteTaskCommand = Schema.Struct({
  scopeInstanceId: Identifier,
  taskNodeId: Identifier,
  tokenId: Identifier
}).annotate({
  identifier: "WorkflowBpmnCompleteTaskCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompleteTaskCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompleteTaskCommand = Schema.Schema.Type<typeof CompleteTaskCommand>

/**
 * One protocol-v3 task-outcome command admitted by this kernel.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResolveTaskCommand = BpmnActivityV3.ResolveTaskCommand

/**
 * The decoded type of {@link ResolveTaskCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolveTaskCommand = BpmnActivityV3.ResolveTaskCommand

/**
 * Replay-derived protocol-v3 coordinates for one exact active BPMN Task wait.
 *
 * **Details**
 *
 * Root-scope one-shot tasks retain the static-DAG shape (`scopePath: []`,
 * activation `0`). Re-entry receives the journal-derived task-token ordinal.
 * A standard loop appends its semantic node as a scope activation and uses
 * the current zero-based iteration as the node activation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskOccurrenceCoordinates = Schema.Struct({
  nodeId: ProtocolV3Wire.AtomicIdentifier,
  scopePath: SemanticOccurrenceV3.ScopePath,
  activation: ProtocolV3Wire.NonNegativeSafeInt
}).annotate({
  identifier: "WorkflowBpmnTaskOccurrenceCoordinates",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskOccurrenceCoordinates}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskOccurrenceCoordinates = Schema.Schema.Type<
  typeof TaskOccurrenceCoordinates
>

/**
 * Frozen collection member value selected by one exact active Task wait.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskCollectionItem = Schema.Struct({
  dataInputRef: Identifier,
  itemIndex: NonNegativeInt,
  itemKey: Identifier,
  item: Schema.Json
}).annotate({
  identifier: "WorkflowBpmnTaskCollectionItem",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskCollectionItem}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskCollectionItem = Schema.Schema.Type<
  typeof TaskCollectionItem
>

const supportedScopeNode = (
  node: BpmnModel.FlowNode
): node is BpmnModel.SubProcess => node._tag === "SubProcess"

type Mutable<T> = T extends ReadonlyArray<infer U> ? Array<Mutable<U>>
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T

type MutableState = Mutable<BpmnExecutionState.BpmnExecutionState>
type MutableToken = Mutable<BpmnExecutionState.Token>
type MutableScopeInstance = Mutable<BpmnExecutionState.ScopeInstance>
type MutableGatewayFrame = Mutable<BpmnExecutionState.GatewayFrame>
type MutableLoopFrame = Mutable<BpmnExecutionState.LoopFrame>
type MutableMultiInstanceGroup = Mutable<BpmnExecutionState.MultiInstanceGroup>
type MutableMultiInstanceMember = Mutable<BpmnExecutionState.MultiInstanceMember>

const directClone = <A>(value: A): Mutable<A> => structuredClone(value) as Mutable<A>

const trustedKernels = new WeakMap<object, CompiledKernel>()
const decodeCompileOptions = Schema.decodeUnknownResult(
  CompileOptions,
  strictParseOptions
)
const decodeInitializeCommand = Schema.decodeUnknownResult(
  InitializeCommand,
  strictParseOptions
)
const decodeCompleteTaskCommand = Schema.decodeUnknownResult(CompleteTaskCommand, strictParseOptions)
const decodeResolveTaskCommand = Schema.decodeUnknownResult(ResolveTaskCommand, strictParseOptions)
const decodeTransitionJournal = Schema.decodeUnknownResult(TransitionJournal, strictParseOptions)
const decodeTaskOccurrenceCoordinates = Schema.decodeUnknownResult(
  TaskOccurrenceCoordinates,
  strictParseOptions
)
const decodeTimestamp = Schema.decodeUnknownResult(ProtocolV2Wire.Timestamp, strictParseOptions)
const decodeEvaluationResult = Schema.decodeUnknownResult(
  BpmnExpressionEvaluator.EvaluationResult,
  strictParseOptions
)

const latestStateTimestamp = (
  state: BpmnExecutionState.BpmnExecutionState
): ProtocolV2Wire.Timestamp => {
  const timestamps: Array<ProtocolV2Wire.Timestamp> = [state.startedAt]
  if (state.completedAt !== undefined) {
    timestamps.push(state.completedAt)
  }
  for (const scope of state.scopeInstances) {
    timestamps.push(scope.enteredAt)
    if (scope.exitedAt !== undefined) {
      timestamps.push(scope.exitedAt)
    }
  }
  for (const token of state.tokens) {
    timestamps.push(token.createdAt)
    if (token.consumedAt !== undefined) {
      timestamps.push(token.consumedAt)
    }
  }
  for (const resolution of state.activityResolutions) {
    timestamps.push(resolution.resolvedAt)
  }
  for (const frame of state.loopFrames) {
    timestamps.push(frame.openedAt)
    if (frame.closedAt !== undefined) {
      timestamps.push(frame.closedAt)
    }
  }
  for (const group of state.multiInstanceGroups) {
    timestamps.push(group.openedAt)
    if (group.closedAt !== undefined) {
      timestamps.push(group.closedAt)
    }
    for (const member of group.members) {
      if (member.startedAt !== undefined) {
        timestamps.push(member.startedAt)
      }
      if (member.endedAt !== undefined) {
        timestamps.push(member.endedAt)
      }
    }
  }
  return timestamps.reduce((latest, timestamp) => timestamp > latest ? timestamp : latest)
}

const resolveServices = (
  input: unknown,
  earliest?: ProtocolV2Wire.Timestamp
): Result.Result<Services, Diagnostic.CompilationError> => {
  let descriptors: PropertyDescriptorMap
  try {
    if (input === null || typeof input !== "object") {
      return Result.fail(compilationError(error(
        Codes.InvalidServices,
        "Token-kernel services must be an object",
        ["services"]
      )))
    }
    descriptors = Object.getOwnPropertyDescriptors(input)
  } catch {
    return Result.fail(compilationError(error(
      Codes.InvalidServices,
      "Token-kernel services could not be inspected safely",
      ["services"]
    )))
  }
  const nowDescriptor = descriptors.now
  if (
    nowDescriptor === undefined ||
    "get" in nowDescriptor
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidServices,
      "Token-kernel services.now must be an own data property",
      ["services", "now"]
    )))
  }
  const decodedNow = decodeTimestamp(nowDescriptor.value)
  if (Result.isFailure(decodedNow)) {
    return Result.fail(compilationError(error(
      Codes.InvalidServices,
      "Token-kernel services.now must be a canonical UTC timestamp",
      ["services", "now"],
      { issue: String(decodedNow.failure) }
    )))
  }
  const now = nowDescriptor.value as ProtocolV2Wire.Timestamp
  if (earliest !== undefined && now < earliest) {
    return Result.fail(compilationError(error(
      Codes.InvalidServices,
      `Token-kernel services.now '${now}' precedes durable state time '${earliest}'`,
      ["services", "now"],
      { earliest }
    )))
  }
  const evaluatorDescriptor = descriptors.evaluateExpression
  if (
    evaluatorDescriptor !== undefined &&
    ("get" in evaluatorDescriptor ||
      (evaluatorDescriptor.value !== undefined && typeof evaluatorDescriptor.value !== "function"))
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidServices,
      "Token-kernel services.evaluateExpression must be an own function data property when present",
      ["services", "evaluateExpression"]
    )))
  }
  return Result.succeed({
    now,
    ...(evaluatorDescriptor?.value === undefined
      ? undefined
      : {
        evaluateExpression: evaluatorDescriptor.value as Exclude<
          Services["evaluateExpression"],
          undefined
        >
      })
  })
}

const recordEvent = (
  journal: Array<TransitionEvent>,
  event: TransitionEvent
): void => {
  const snapshot = Json.snapshot(event)
  if (Result.isFailure(snapshot)) {
    throw new TypeError(`Invalid internal BPMN transition event: ${snapshot.failure.message}`)
  }
  journal.push(snapshot.success as unknown as TransitionEvent)
}

const immutableEvents = (
  journal: ReadonlyArray<TransitionEvent>
): ReadonlyArray<TransitionEvent> => Object.freeze([...journal])

const resolveKernel = (
  input: unknown
): Result.Result<CompiledKernel, Diagnostic.CompilationError> => {
  const trusted = input !== null && typeof input === "object"
    ? trustedKernels.get(input)
    : undefined
  if (trusted === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidKernel,
      "Token-kernel operations require an authority returned by compile",
      ["kernel"]
    )))
  }
  return Result.succeed(trusted)
}

/**
 * Resolves the immutable protocol-v3 binding for one BPMN Task from an exact
 * compiled-kernel authority.
 *
 * **Details**
 *
 * This accessor is intended for trusted execution adapters that must reject a
 * mismatched semantic invocation before dispatching its first activity. A
 * structural copy of a kernel is not an authority and is rejected.
 *
 * @category accessors
 * @since 4.0.0
 */
export const taskBinding = (
  kernel: CompiledKernel,
  taskNodeId: unknown
): Result.Result<BpmnActivityV3.TaskBinding, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  if (typeof taskNodeId !== "string" || taskNodeId.length === 0) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Task-binding lookup requires a non-empty task node identifier",
      ["taskNodeId"]
    )))
  }
  const binding = resolvedKernel.success.taskBindingByTaskNodeId.get(
    taskNodeId
  )
  if (binding === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task '${taskNodeId}' has no compiled protocol-v3 binding`,
      ["taskNodeId"]
    )))
  }
  return Result.succeed(binding)
}

/**
 * Derives the exact protocol-v3 occurrence coordinates of one active BPMN
 * Task wait from validated replay state.
 *
 * **Details**
 *
 * The caller supplies only optimistic wait coordinates. The invocation
 * counters, scope activations, loop frame, and task ordinal come from the
 * validated state owned by the exact compiled-kernel authority. This function
 * does not hash an occurrence document; a trusted Effect Workflow bridge must
 * compare these coordinates with the exact occurrence retained by its
 * prepared native invocation.
 *
 * @category accessors
 * @since 4.0.0
 */
export const taskOccurrence = (
  kernel: CompiledKernel,
  stateInput: unknown,
  targetInput: unknown
): Result.Result<TaskOccurrenceCoordinates, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
  const targetSnapshot = Json.snapshot(targetInput)
  if (Result.isFailure(targetSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      targetSnapshot.failure.message,
      ["target", ...targetSnapshot.failure.path]
    )))
  }
  const decodedTarget = decodeCompleteTaskCommand(targetSnapshot.success)
  if (Result.isFailure(decodedTarget)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Invalid BPMN Task wait target",
      ["target"],
      { issue: String(decodedTarget.failure) }
    )))
  }
  const target = targetSnapshot.success as unknown as CompleteTaskCommand
  const validated = validateKernelState(authority, stateInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const state = validated.success
  const token = state.tokens.find((candidate) => candidate.tokenId === target.tokenId)
  const task = authority.nodeById.get(target.taskNodeId)
  const binding = authority.taskBindingByTaskNodeId.get(target.taskNodeId)
  if (
    token === undefined ||
    token.status !== "active" ||
    token.scopeInstanceId !== target.scopeInstanceId ||
    token.position._tag !== "AtNode" ||
    token.position.nodeId !== target.taskNodeId ||
    task?._tag !== "Task" ||
    binding === undefined
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task wait '${target.tokenId}' is not one active protocol-v3-bound Task occurrence`,
      ["target"]
    )))
  }
  const scope = state.scopeInstances.find((candidate) => candidate.scopeInstanceId === token.scopeInstanceId)
  if (scope === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task wait '${target.tokenId}' has no owning scope`,
      ["target", "scopeInstanceId"]
    )))
  }
  const nestedPath: Array<SemanticOccurrenceV3.ScopeActivation> = []
  let current: BpmnExecutionState.ScopeInstance | undefined = scope
  while (current.parentScopeInstanceId !== undefined) {
    nestedPath.push({
      scopeActivationVersion: 1,
      scopeId: current.definitionId as ProtocolV3Wire.AtomicIdentifier,
      activation: current.invocation.generation - 1
    })
    current = state.scopeInstances.find((candidate) => candidate.scopeInstanceId === current!.parentScopeInstanceId)
    if (current === undefined) {
      return Result.fail(compilationError(error(
        Codes.InvalidCommand,
        `Task wait '${target.tokenId}' has an incomplete scope ancestry`,
        ["target", "scopeInstanceId"]
      )))
    }
  }
  nestedPath.reverse()

  let activation: number
  if (
    task.loopCharacteristics?._tag === "StandardLoopCharacteristics"
  ) {
    const branch = standardLoopBranch(token.invocation)
    const frame = branch === undefined
      ? undefined
      : state.loopFrames.find((candidate) => candidate.frameId === branch.frameId)
    if (
      frame === undefined ||
      frame.status !== "active" ||
      frame.activeIteration === undefined ||
      frame.activeIteration !== branch?.iteration
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidCommand,
        `Task wait '${target.tokenId}' has no exact active standard-loop frame`,
        ["target", "tokenId"]
      )))
    }
    nestedPath.push({
      scopeActivationVersion: 1,
      scopeId: binding.semanticNodeId,
      activation: frame.activation
    })
    activation = frame.activeIteration
  } else if (
    task.loopCharacteristics?._tag === "MultiInstanceCharacteristics"
  ) {
    const branch = multiInstanceBranch(token.invocation)
    const group = branch === undefined
      ? undefined
      : state.multiInstanceGroups.find((candidate) => candidate.groupId === branch.groupId)
    const member = branch === undefined || group === undefined
      ? undefined
      : group.members.find((candidate) =>
        candidate.index === branch.itemIndex &&
        candidate.itemKey === branch.itemKey
      )
    if (
      branch === undefined ||
      group === undefined ||
      group.status !== "active" ||
      member === undefined ||
      member.status !== "active" ||
      member.tokenId !== token.tokenId
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidCommand,
        `Task wait '${target.tokenId}' has no exact active multi-instance member`,
        ["target", "tokenId"]
      )))
    }
    nestedPath.push({
      scopeActivationVersion: 1,
      scopeId: binding.semanticNodeId,
      activation: group.activation
    })
    activation = member.index
  } else {
    const occurrences = state.tokens.filter((candidate) =>
      candidate.scopeInstanceId === token.scopeInstanceId &&
      candidate.position._tag === "AtNode" &&
      candidate.position.nodeId === task.id &&
      candidate.invocation.branch === undefined
    )
    activation = occurrences.findIndex((candidate) => candidate.tokenId === token.tokenId)
    if (activation < 0) {
      return Result.fail(compilationError(error(
        Codes.InvalidCommand,
        `Task wait '${target.tokenId}' has no replay-derived activation ordinal`,
        ["target", "tokenId"]
      )))
    }
  }
  const coordinates = {
    nodeId: binding.semanticNodeId,
    scopePath: nestedPath,
    activation
  }
  const decodedCoordinates = decodeTaskOccurrenceCoordinates(coordinates)
  if (Result.isFailure(decodedCoordinates)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task wait '${target.tokenId}' cannot be represented as protocol-v3 occurrence coordinates`,
      ["target"],
      { issue: String(decodedCoordinates.failure) }
    )))
  }
  return Result.succeed(
    coordinates as TaskOccurrenceCoordinates
  )
}

/**
 * Resolves the immutable collection item for one active multi-instance Task
 * wait, or `undefined` when the wait is not collection-backed or does not
 * declare a BPMN `inputDataItem`.
 *
 * **Details**
 *
 * The item is recovered only from validated durable state and exposed only
 * when the BPMN model explicitly maps one scalar `inputDataItem`. Execution
 * adapters use this accessor to compare a prepared native invocation's
 * encoded input before the first activity dispatch.
 *
 * @category accessors
 * @since 4.0.0
 */
export const taskCollectionItem = (
  kernel: CompiledKernel,
  stateInput: unknown,
  targetInput: unknown
): Result.Result<
  TaskCollectionItem | undefined,
  Diagnostic.CompilationError
> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
  const targetSnapshot = Json.snapshot(targetInput)
  if (Result.isFailure(targetSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      targetSnapshot.failure.message,
      ["target", ...targetSnapshot.failure.path]
    )))
  }
  const decodedTarget = decodeCompleteTaskCommand(targetSnapshot.success)
  if (Result.isFailure(decodedTarget)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Invalid BPMN Task wait target",
      ["target"],
      { issue: String(decodedTarget.failure) }
    )))
  }
  const target = targetSnapshot.success as unknown as CompleteTaskCommand
  const validated = validateKernelState(authority, stateInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const state = validated.success
  const token = state.tokens.find((candidate) => candidate.tokenId === target.tokenId)
  if (
    token === undefined ||
    token.status !== "active" ||
    token.scopeInstanceId !== target.scopeInstanceId ||
    token.position._tag !== "AtNode" ||
    token.position.nodeId !== target.taskNodeId
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task wait '${target.tokenId}' is not active`,
      ["target"]
    )))
  }
  const activity = authority.nodeById.get(target.taskNodeId)
  if (
    activity?._tag !== "Task" ||
    activity.loopCharacteristics?._tag !==
      "MultiInstanceCharacteristics" ||
    activity.loopCharacteristics.inputDataItem === undefined
  ) {
    return Result.succeed(undefined)
  }
  const branch = multiInstanceBranch(token.invocation)
  if (branch === undefined) {
    return Result.succeed(undefined)
  }
  const group = state.multiInstanceGroups.find((candidate) => candidate.groupId === branch.groupId)
  if (group?.source._tag !== "Collection") {
    return Result.succeed(undefined)
  }
  const member = group.members[branch.itemIndex]
  const item = group.source.items[branch.itemIndex]
  if (
    group.status !== "active" ||
    member === undefined ||
    member.status !== "active" ||
    member.itemKey !== branch.itemKey ||
    member.tokenId !== token.tokenId ||
    item === undefined
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task wait '${target.tokenId}' has no exact active collection item`,
      ["target", "tokenId"]
    )))
  }
  return Result.succeed({
    dataInputRef: group.source.dataInputRef,
    itemIndex: member.index,
    itemKey: member.itemKey,
    item
  })
}

const sameInvocation = (
  left: BpmnExecutionState.InvocationIdentity,
  right: BpmnExecutionState.InvocationIdentity
): boolean =>
  left.activationId === right.activationId &&
  (
    left.branch === undefined && right.branch === undefined ||
    left.branch !== undefined &&
      right.branch !== undefined &&
      sameJson(left.branch, right.branch)
  ) &&
  left.generation === right.generation

const sameJson = (left: unknown, right: unknown): boolean => {
  const leftSnapshot = Json.snapshot(left)
  const rightSnapshot = Json.snapshot(right)
  return Result.isSuccess(leftSnapshot) &&
    Result.isSuccess(rightSnapshot) &&
    Json.canonicalizeSnapshot(leftSnapshot.success) ===
      Json.canonicalizeSnapshot(rightSnapshot.success)
}

const canonicalUtf8Bytes = (
  value: Schema.Json
): Result.Result<number, Diagnostic.CompilationError> => {
  try {
    return Result.succeed(
      new TextEncoder().encode(Json.canonicalizeSnapshot(value)).byteLength
    )
  } catch {
    return Result.fail(compilationError(error(
      Codes.InvalidKernelState,
      "A durable JSON value could not be canonicalized",
      []
    )))
  }
}

const standardLoopBranch = (
  invocation: BpmnExecutionState.InvocationIdentity
):
  | Extract<
    BpmnExecutionState.InvocationBranch,
    { readonly _tag: "StandardLoopIteration" }
  >
  | undefined =>
  invocation.branch?._tag === "StandardLoopIteration"
    ? invocation.branch
    : undefined

const multiInstanceBranch = (
  invocation: BpmnExecutionState.InvocationIdentity
):
  | Extract<
    BpmnExecutionState.InvocationBranch,
    { readonly _tag: "MultiInstanceItem" }
  >
  | undefined =>
  invocation.branch?._tag === "MultiInstanceItem"
    ? invocation.branch
    : undefined

const sameFailureIdentity = (
  left: BpmnActivityV3.TaskBusinessFailed["identity"],
  right: BpmnActivityV3.TaskBusinessFailed["identity"]
): boolean =>
  left.failureIdentityVersion === right.failureIdentityVersion &&
  left.errorTag === right.errorTag &&
  left.errorCode === right.errorCode

const bindingMatchesOutcome = (
  binding: BpmnActivityV3.TaskBinding,
  outcome: BpmnActivityV3.TaskOutcome
): boolean =>
  binding.artifactDigest === outcome.artifactDigest &&
  binding.semanticNodeId === outcome.semanticNodeId

const mappedErrorRef = (
  binding: BpmnActivityV3.TaskBinding,
  outcome: BpmnActivityV3.TaskBusinessFailed
): string | undefined =>
  binding.errorMappings.find((mapping) => sameFailureIdentity(mapping.identity, outcome.identity))?.errorRef

const sameModelReference = (
  left: BpmnExecutionState.ModelReference,
  right: BpmnExecutionState.ModelReference
): boolean =>
  left.fingerprintVersion === right.fingerprintVersion &&
  left.kernelSemanticVersion === right.kernelSemanticVersion &&
  left.profileId === right.profileId &&
  left.modelKind === right.modelKind &&
  left.modelVersion === right.modelVersion &&
  left.bpmnSpecVersion === right.bpmnSpecVersion &&
  left.rootProcessId === right.rootProcessId &&
  left.executableFingerprint === right.executableFingerprint

const validateKernelState = (
  kernel: CompiledKernel,
  input: unknown
): Result.Result<BpmnExecutionState.BpmnExecutionState, Diagnostic.CompilationError> => {
  const validated = BpmnExecutionState.validate(kernel.model, input)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const state = validated.success
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const stateError = (
    message: string,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    details?: Schema.Json
  ): void => {
    diagnostics.push(error(Codes.InvalidKernelState, message, path, details))
  }

  if (!sameModelReference(state.model, kernel.modelReference)) {
    diagnostics.push(error(
      Codes.BpmnModelFingerprintMismatch,
      "Execution model reference does not match the prepared token kernel",
      ["model"],
      {
        expectedExecutableFingerprint: kernel.modelReference.executableFingerprint,
        actualExecutableFingerprint: state.model.executableFingerprint
      }
    ))
  }
  const inputBytes = canonicalUtf8Bytes(state.input)
  if (Result.isFailure(inputBytes)) {
    stateError(
      "Execution input is not canonical strict JSON",
      ["input"]
    )
  } else if (
    inputBytes.success > kernel.limits.maxExecutionInputCanonicalBytes
  ) {
    stateError(
      "Execution input exceeds the compiled canonical-byte limit",
      ["input"],
      {
        actual: inputBytes.success,
        maximum: kernel.limits.maxExecutionInputCanonicalBytes
      }
    )
  }
  if (
    state.status !== "active" &&
    state.status !== "completed" &&
    state.status !== "failed"
  ) {
    stateError(
      `Execution status '${state.status}' is outside this token-kernel subset`,
      ["status"]
    )
  }

  const scopeById = new Map(state.scopeInstances.map((scope) => [scope.scopeInstanceId, scope] as const))
  const rootScope = state.scopeInstances.find((scope) => scope.parentScopeInstanceId === undefined)
  if (state.status === "active" && rootScope?.status !== "active") {
    stateError("An active execution requires an active root scope", ["scopeInstances"])
  }
  if (state.status === "completed" && rootScope?.status !== "completed") {
    stateError("A completed execution requires a completed root scope", ["scopeInstances"])
  }
  if (state.status === "failed" && rootScope?.status !== "failed") {
    stateError("A failed execution requires a failed root scope", ["scopeInstances"])
  }

  for (let index = 0; index < state.scopeInstances.length; index++) {
    const scope = state.scopeInstances[index]!
    if (
      scope.status !== "active" &&
      scope.status !== "completed" &&
      !(state.status === "failed" &&
        (scope.status === "failed" || scope.status === "cancelled"))
    ) {
      stateError(
        `Scope status '${scope.status}' is outside this token-kernel subset`,
        ["scopeInstances", index, "status"]
      )
    }
  }
  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index]!
    const resolution = state.activityResolutions.find((candidate) => candidate.tokenId === token.tokenId)
    const loopBranch = standardLoopBranch(token.invocation)
    const loopFrame = loopBranch === undefined
      ? undefined
      : state.loopFrames.find((frame) => frame.frameId === loopBranch.frameId)
    const itemBranch = multiInstanceBranch(token.invocation)
    const multiInstanceGroup = itemBranch === undefined
      ? undefined
      : state.multiInstanceGroups.find((group) => group.groupId === itemBranch.groupId)
    const multiInstanceMember = itemBranch === undefined || multiInstanceGroup === undefined
      ? undefined
      : multiInstanceGroup.members.find((member) =>
        member.index === itemBranch.itemIndex &&
        member.itemKey === itemBranch.itemKey
      )
    const admittedWithdrawal = token.status === "withdrawn" &&
      (
        state.status === "failed" ||
        resolution?.outcome._tag === "BusinessFailed" ||
        multiInstanceMember?.status === "terminated"
      )
    if (
      token.status !== "active" &&
      token.status !== "consumed" &&
      !admittedWithdrawal
    ) {
      stateError(
        `Token status '${token.status}' is outside this token-kernel subset`,
        ["tokens", index, "status"]
      )
    }
    const scope = scopeById.get(token.scopeInstanceId)
    if (scope !== undefined && loopBranch !== undefined) {
      if (
        loopFrame === undefined ||
        loopFrame.scopeInstanceId !== token.scopeInstanceId ||
        loopFrame.processId !== token.processId ||
        token.invocation.activationId !== scope.invocation.activationId ||
        token.invocation.generation !== scope.invocation.generation
      ) {
        stateError(
          `Token '${token.tokenId}' does not carry an exact standard-loop invocation`,
          ["tokens", index, "invocation"]
        )
      } else if (
        token.status === "active" &&
        (
          loopFrame.status !== "active" ||
          loopFrame.activeIteration === undefined ||
          loopBranch.iteration !== loopFrame.activeIteration
        )
      ) {
        stateError(
          `Active token '${token.tokenId}' does not match its standard-loop current iteration`,
          ["tokens", index, "invocation"]
        )
      } else if (
        token.status === "consumed" &&
        (
          loopBranch.iteration >= loopFrame.completedIterations
        )
      ) {
        stateError(
          `Consumed token '${token.tokenId}' is not one completed standard-loop iteration`,
          ["tokens", index, "invocation"]
        )
      } else if (
        token.status === "withdrawn" &&
        (
          loopFrame.status !== "cancelled" ||
          loopBranch.iteration !== loopFrame.completedIterations
        )
      ) {
        stateError(
          `Withdrawn token '${token.tokenId}' is not the iteration cancelled with its standard-loop frame`,
          ["tokens", index, "invocation"]
        )
      }
    } else if (scope !== undefined && itemBranch !== undefined) {
      if (
        multiInstanceGroup === undefined ||
        multiInstanceMember === undefined ||
        multiInstanceGroup.scopeInstanceId !== token.scopeInstanceId ||
        multiInstanceGroup.processId !== token.processId ||
        multiInstanceMember.tokenId !== token.tokenId ||
        token.invocation.activationId !== scope.invocation.activationId ||
        token.invocation.generation !== scope.invocation.generation
      ) {
        stateError(
          `Token '${token.tokenId}' does not carry an exact multi-instance member invocation`,
          ["tokens", index, "invocation"]
        )
      } else if (
        token.status === "active" &&
        (
          multiInstanceGroup.status !== "active" ||
          multiInstanceMember.status !== "active"
        )
      ) {
        stateError(
          `Active token '${token.tokenId}' does not match one active multi-instance member`,
          ["tokens", index, "invocation"]
        )
      } else if (
        token.status === "consumed" &&
        multiInstanceMember.status !== "completed"
      ) {
        stateError(
          `Consumed token '${token.tokenId}' is not one completed multi-instance member`,
          ["tokens", index, "invocation"]
        )
      } else if (
        token.status === "withdrawn" &&
        multiInstanceMember.status !== "terminated"
      ) {
        stateError(
          `Withdrawn token '${token.tokenId}' is not one terminated multi-instance member`,
          ["tokens", index, "invocation"]
        )
      }
    } else if (scope !== undefined && !sameInvocation(token.invocation, scope.invocation)) {
      stateError(
        `Token '${token.tokenId}' invocation does not exactly match its scope invocation`,
        ["tokens", index, "invocation"]
      )
    }
    if (token.position._tag === "AtNode") {
      const node = kernel.nodeById.get(token.position.nodeId)
      if (node?._tag !== "Task") {
        stateError(
          `Stable node token '${token.tokenId}' must identify a task in this token-kernel subset`,
          ["tokens", index, "position", "nodeId"]
        )
      }
      const binding = node?._tag === "Task"
        ? kernel.taskBindingByTaskNodeId.get(node.id)
        : undefined
      if (resolution !== undefined) {
        if (
          binding === undefined ||
          resolution.taskNodeId !== node?.id ||
          !bindingMatchesOutcome(binding, resolution.outcome)
        ) {
          stateError(
            `Activity resolution for task token '${token.tokenId}' does not match its compiled binding`,
            ["activityResolutions"]
          )
        }
        if (
          resolution.outcome._tag === "Succeeded" &&
          token.status !== "consumed"
        ) {
          stateError(
            `Successful task resolution '${token.tokenId}' requires a consumed token`,
            ["tokens", index, "status"]
          )
        }
        if (
          resolution.outcome._tag === "BusinessFailed" &&
          token.status !== "withdrawn"
        ) {
          stateError(
            `Business-failed task resolution '${token.tokenId}' requires a withdrawn token`,
            ["tokens", index, "status"]
          )
        }
      } else if (
        binding !== undefined &&
        token.status === "consumed"
      ) {
        stateError(
          `Consumed protocol-v3-bound task token '${token.tokenId}' requires its exact successful activity resolution`,
          ["activityResolutions"]
        )
      }
    }
  }

  const uncaughtBusinessFailures = state.activityResolutions.filter(
    (resolution) => {
      if (resolution.outcome._tag !== "BusinessFailed") {
        return false
      }
      const binding = kernel.taskBindingByTaskNodeId.get(
        resolution.taskNodeId
      )
      if (binding === undefined) {
        return true
      }
      const errorRef = mappedErrorRef(binding, resolution.outcome)
      return errorRef === undefined ||
        matchingBoundaryError(
            kernel,
            resolution.taskNodeId,
            errorRef
          ) === undefined
    }
  )
  if (state.status === "failed") {
    if (uncaughtBusinessFailures.length !== 1) {
      stateError(
        "A failed token-kernel execution requires exactly one uncaught durable business-failure resolution",
        ["activityResolutions"]
      )
    }
  } else if (uncaughtBusinessFailures.length > 0) {
    stateError(
      "An unmapped or uncaught business-failure resolution requires a failed execution",
      ["activityResolutions"]
    )
  }

  for (let index = 0; index < state.gatewayFrames.length; index++) {
    const frame = state.gatewayFrames[index]!
    const gateway = kernel.nodeById.get(frame.gatewayId)
    if (
      gateway?._tag !== "Gateway" ||
      gateway.gatewayKind !== "parallel" ||
      gateway.gatewayDirection !== "converging"
    ) {
      stateError(
        `Gateway frame '${frame.frameId}' must belong to a converging parallel gateway`,
        ["gatewayFrames", index, "gatewayId"]
      )
    }
    if (frame.status === "cancelled" && state.status !== "failed") {
      stateError(
        `Gateway frame status '${frame.status}' is outside this token-kernel subset`,
        ["gatewayFrames", index, "status"]
      )
    }
    if (frame.arrivedIncomingSequenceFlowIds.length === 0) {
      stateError(
        `Gateway frame '${frame.frameId}' must record at least one real arrival`,
        ["gatewayFrames", index, "arrivedIncomingSequenceFlowIds"]
      )
    }
  }

  for (let index = 0; index < state.loopFrames.length; index++) {
    const frame = state.loopFrames[index]!
    const activity = kernel.nodeById.get(frame.activityId)
    if (
      activity?._tag !== "Task" ||
      activity.loopCharacteristics?._tag !== "StandardLoopCharacteristics"
    ) {
      stateError(
        `Loop frame '${frame.frameId}' is outside the executable bounded standard-loop subset`,
        ["loopFrames", index]
      )
    }
    if (frame.status === "active") {
      const matching = state.tokens.filter((token) =>
        token.status === "active" &&
        token.scopeInstanceId === frame.scopeInstanceId &&
        token.position._tag === "AtNode" &&
        token.position.nodeId === frame.activityId &&
        standardLoopBranch(token.invocation)?.frameId === frame.frameId &&
        standardLoopBranch(token.invocation)?.iteration === frame.activeIteration
      )
      if (matching.length !== 1) {
        stateError(
          `Active standard-loop frame '${frame.frameId}' requires exactly one active iteration token`,
          ["loopFrames", index]
        )
      }
    }
  }

  for (let index = 0; index < state.multiInstanceGroups.length; index++) {
    const group = state.multiInstanceGroups[index]!
    const activity = kernel.nodeById.get(group.activityId)
    if (
      activity?._tag !== "Task" ||
      activity.loopCharacteristics?._tag !== "MultiInstanceCharacteristics"
    ) {
      stateError(
        `Multi-instance group '${group.groupId}' is outside the executable fixed Task profile`,
        ["multiInstanceGroups", index]
      )
    }
    if (group.members.length > kernel.limits.maxMultiInstanceCardinality) {
      stateError(
        `Multi-instance group '${group.groupId}' exceeds the compiled cardinality limit`,
        ["multiInstanceGroups", index, "members"],
        {
          actual: group.members.length,
          maximum: kernel.limits.maxMultiInstanceCardinality
        }
      )
    }
    for (
      let memberIndex = 0;
      memberIndex < group.members.length;
      memberIndex++
    ) {
      const output = group.members[memberIndex]!.output
      if (output === undefined) {
        continue
      }
      const outputBytes = canonicalUtf8Bytes(output)
      if (
        Result.isFailure(outputBytes) ||
        outputBytes.success >
          kernel.limits.maxMultiInstanceItemOutputCanonicalBytes
      ) {
        stateError(
          `Multi-instance member output '${group.groupId}:${memberIndex}' exceeds its compiled canonical-byte limit`,
          [
            "multiInstanceGroups",
            index,
            "members",
            memberIndex,
            "output"
          ],
          Result.isFailure(outputBytes)
            ? undefined
            : {
              actual: outputBytes.success,
              maximum: kernel.limits.maxMultiInstanceItemOutputCanonicalBytes
            }
        )
      }
    }
    if (group.output !== undefined) {
      const outputBytes = canonicalUtf8Bytes(
        group.output.items as Schema.Json
      )
      if (
        Result.isFailure(outputBytes) ||
        outputBytes.success >
          kernel.limits.maxMultiInstanceOutputCanonicalBytes
      ) {
        stateError(
          `Multi-instance aggregate output '${group.groupId}' exceeds its compiled canonical-byte limit`,
          ["multiInstanceGroups", index, "output", "items"],
          Result.isFailure(outputBytes)
            ? undefined
            : {
              actual: outputBytes.success,
              maximum: kernel.limits.maxMultiInstanceOutputCanonicalBytes
            }
        )
      }
    }
    if (group.source._tag === "Collection") {
      const binding = kernel.collectionBindingByTaskNodeId.get(group.activityId)
      if (
        binding === undefined ||
        binding.dataInputRef !== group.source.dataInputRef
      ) {
        stateError(
          `Collection group '${group.groupId}' does not match its compiled DataInput binding`,
          ["multiInstanceGroups", index, "source", "dataInputRef"]
        )
      }
      const collectionBytes = canonicalUtf8Bytes(
        group.source.items as Schema.Json
      )
      if (
        Result.isFailure(collectionBytes) ||
        collectionBytes.success >
          kernel.limits.maxMultiInstanceCollectionCanonicalBytes
      ) {
        stateError(
          `Collection group '${group.groupId}' exceeds its compiled canonical-byte limit`,
          ["multiInstanceGroups", index, "source", "items"],
          Result.isFailure(collectionBytes)
            ? undefined
            : {
              actual: collectionBytes.success,
              maximum: kernel.limits.maxMultiInstanceCollectionCanonicalBytes
            }
        )
      }
      for (
        let itemIndex = 0;
        itemIndex < group.source.items.length;
        itemIndex++
      ) {
        const itemBytes = canonicalUtf8Bytes(
          group.source.items[itemIndex]!
        )
        if (
          Result.isFailure(itemBytes) ||
          itemBytes.success >
            kernel.limits.maxMultiInstanceItemCanonicalBytes
        ) {
          stateError(
            `Collection item '${group.groupId}:${itemIndex}' exceeds its compiled canonical-byte limit`,
            [
              "multiInstanceGroups",
              index,
              "source",
              "items",
              itemIndex
            ],
            Result.isFailure(itemBytes)
              ? undefined
              : {
                actual: itemBytes.success,
                maximum: kernel.limits.maxMultiInstanceItemCanonicalBytes
              }
          )
        }
      }
    }
  }

  const unsupportedStructures = [
    ["callFrames", state.callFrames],
    ["subscriptions", state.subscriptions],
    ["timers", state.timers],
    ["workItems", state.workItems],
    ["compensationRegistrations", state.compensationRegistrations],
    ["cancellationRegions", state.cancellationRegions]
  ] as const
  for (const [field, values] of unsupportedStructures) {
    if (values.length > 0) {
      stateError(
        `Runtime structure '${field}' is outside this token-kernel subset`,
        [field]
      )
    }
  }

  if (state.status === "completed" || state.status === "failed") {
    if (state.scopeInstances.some((scope) => scope.status === "active")) {
      stateError(`A ${state.status} execution cannot retain active scopes`, ["scopeInstances"])
    }
    if (state.tokens.some((token) => token.status === "active")) {
      stateError(`A ${state.status} execution cannot retain active tokens`, ["tokens"])
    }
    if (state.gatewayFrames.some((frame) => frame.status === "waiting" || frame.status === "satisfied")) {
      stateError(`A ${state.status} execution cannot retain open gateway frames`, ["gatewayFrames"])
    }
    if (state.loopFrames.some((frame) => frame.status === "active")) {
      stateError(`A ${state.status} execution cannot retain active loop frames`, ["loopFrames"])
    }
    if (state.multiInstanceGroups.some((group) => group.status === "active")) {
      stateError(`A ${state.status} execution cannot retain active multi-instance groups`, ["multiInstanceGroups"])
    }
  }

  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }
  return Result.succeed(state)
}

const orderedOutgoing = (
  node: BpmnModel.FlowNode,
  flowById: ReadonlyMap<string, BpmnModel.SequenceFlow>
): ReadonlyArray<string> =>
  [...node.outgoingSequenceFlowIds]
    .map((flowId, index) => ({ flow: flowById.get(flowId), flowId, index }))
    .filter((
      entry
    ): entry is { readonly flow: BpmnModel.SequenceFlow; readonly flowId: string; readonly index: number } =>
      entry.flow !== undefined
    )
    .sort((left, right) => {
      const leftOrder = left.flow.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.flow.order ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder
      }
      return left.index - right.index
    })
    .map((entry) => entry.flowId)

const activeTokens = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "tokens">,
  scopeInstanceId: string
): ReadonlyArray<BpmnExecutionState.Token> =>
  state.tokens.filter((token) => token.status === "active" && token.scopeInstanceId === scopeInstanceId)

const waitingFrames = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "gatewayFrames">,
  scopeInstanceId: string
): ReadonlyArray<BpmnExecutionState.GatewayFrame> =>
  state.gatewayFrames.filter((frame) =>
    frame.scopeInstanceId === scopeInstanceId &&
    (frame.status === "waiting" || frame.status === "satisfied")
  )

const activeLoopFrames = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "loopFrames">,
  scopeInstanceId: string
): ReadonlyArray<BpmnExecutionState.LoopFrame> =>
  state.loopFrames.filter((frame) =>
    frame.scopeInstanceId === scopeInstanceId &&
    frame.status === "active"
  )

const activeMultiInstanceGroups = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "multiInstanceGroups">,
  scopeInstanceId: string
): ReadonlyArray<BpmnExecutionState.MultiInstanceGroup> =>
  state.multiInstanceGroups.filter((group) =>
    group.scopeInstanceId === scopeInstanceId &&
    group.status === "active"
  )

const activeChildScopes = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "scopeInstances">,
  scopeInstanceId: string
): ReadonlyArray<BpmnExecutionState.ScopeInstance> =>
  state.scopeInstances.filter((scope) =>
    scope.parentScopeInstanceId === scopeInstanceId &&
    scope.status === "active"
  )

const currentFrameEpoch = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "gatewayFrames">,
  gatewayId: string,
  scopeInstanceId: string,
  activationId: string
): number =>
  state.gatewayFrames
    .filter((frame) =>
      frame.gatewayId === gatewayId &&
      frame.scopeInstanceId === scopeInstanceId &&
      frame.activationId === activationId
    )
    .reduce((max, frame) => Math.max(max, frame.joinEpoch), 0)

const nextId = (
  existing: ReadonlyArray<string>,
  prefix: string
): string => {
  let counter = 1
  while (existing.includes(`${prefix}${counter}`)) {
    counter++
  }
  return `${prefix}${counter}`
}

const createToken = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "tokens">,
  scopeInstance: BpmnExecutionState.ScopeInstance,
  position: BpmnExecutionState.TokenPosition,
  now: ProtocolV2Wire.Timestamp,
  invocation: BpmnExecutionState.InvocationIdentity = scopeInstance.invocation
): BpmnExecutionState.Token => ({
  tokenId: nextId(state.tokens.map((token) => token.tokenId), "token:"),
  processId: scopeInstance.processId,
  scopeInstanceId: scopeInstance.scopeInstanceId,
  invocation: directClone(invocation),
  status: "active",
  position,
  createdAt: now
})

const createScopeInstance = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "scopeInstances">,
  definitionId: string,
  processId: string,
  parentScopeInstanceId: string | undefined,
  activationId: string,
  now: ProtocolV2Wire.Timestamp
): BpmnExecutionState.ScopeInstance => {
  const scopeInstanceId = nextId(
    state.scopeInstances.map((scope) => scope.scopeInstanceId),
    `scope:${definitionId}:`
  )
  const generation =
    state.scopeInstances.filter((scope) =>
      scope.definitionId === definitionId && scope.invocation.activationId === activationId
    ).length + 1
  return {
    scopeInstanceId,
    definitionId,
    processId,
    ...(parentScopeInstanceId === undefined ? undefined : { parentScopeInstanceId }),
    invocation: {
      activationId,
      generation
    },
    status: "active",
    enteredAt: now
  }
}

type EvaluationTarget =
  | {
    readonly _tag: "SequenceFlowCondition"
    readonly sequenceFlow: BpmnModel.SequenceFlow
    readonly sourceNode: BpmnModel.Task | BpmnModel.SubProcess | BpmnModel.Gateway
  }
  | {
    readonly _tag: "StandardLoopCondition"
    readonly activity: BpmnModel.Task
    readonly frame: MutableLoopFrame
    readonly phase: "before" | "after"
    readonly iteration: number
  }
  | {
    readonly _tag: "MultiInstanceCardinality"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly activation: number
  }
  | {
    readonly _tag: "MultiInstanceCollection"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly activation: number
    readonly dataInputRef: string
    readonly expression: BpmnModel.Expression
  }
  | {
    readonly _tag: "MultiInstanceCompletionCondition"
    readonly activity: BpmnModel.Task
    readonly group: MutableMultiInstanceGroup
    readonly completedMember: MutableMultiInstanceMember
  }

const multiInstanceCounters = (
  group: Pick<BpmnExecutionState.MultiInstanceGroup, "members">
): MultiInstanceRuntimeCounters => {
  const numberOfActiveInstances = group.members.filter((member) => member.status === "active").length
  const numberOfCompletedInstances = group.members.filter((member) => member.status === "completed").length
  const numberOfTerminatedInstances = group.members.filter((member) => member.status === "terminated").length
  return {
    numberOfInstances: numberOfActiveInstances +
      numberOfCompletedInstances +
      numberOfTerminatedInstances,
    numberOfActiveInstances,
    numberOfCompletedInstances,
    numberOfTerminatedInstances
  }
}

const evaluateExpression = (
  kernel: CompiledKernel,
  services: Services,
  expression: BpmnModel.Expression,
  target: EvaluationTarget,
  scopeInstance: MutableScopeInstance,
  state: MutableState,
  journal: Array<TransitionEvent>
): Result.Result<Schema.Json, Diagnostic.CompilationError> => {
  const targetId = target._tag === "SequenceFlowCondition"
    ? target.sequenceFlow.id
    : target.activity.id
  const targetLabel = target._tag === "SequenceFlowCondition"
    ? `sequence flow '${targetId}'`
    : target._tag === "StandardLoopCondition"
    ? `standard loop on activity '${targetId}'`
    : target._tag === "MultiInstanceCardinality"
    ? `multi-instance cardinality on activity '${targetId}'`
    : target._tag === "MultiInstanceCollection"
    ? `multi-instance collection on activity '${targetId}'`
    : `multi-instance completion condition on activity '${targetId}'`
  const targetPath: ReadonlyArray<Diagnostic.PathSegment> = target._tag === "SequenceFlowCondition"
    ? ["sequenceFlows"]
    : ["flowNodes"]
  const targetDetails: Schema.Json = target._tag === "SequenceFlowCondition"
    ? { sequenceFlowId: targetId }
    : target._tag === "StandardLoopCondition"
    ? {
      activityId: targetId,
      frameId: target.frame.frameId,
      phase: target.phase,
      iteration: target.iteration
    }
    : target._tag === "MultiInstanceCardinality"
    ? {
      activityId: targetId,
      groupId: target.groupId,
      activation: target.activation
    }
    : target._tag === "MultiInstanceCollection"
    ? {
      activityId: targetId,
      groupId: target.groupId,
      activation: target.activation,
      dataInputRef: target.dataInputRef
    }
    : {
      activityId: targetId,
      groupId: target.group.groupId,
      activation: target.group.activation,
      itemIndex: target.completedMember.index,
      itemKey: target.completedMember.itemKey
    }
  if (services.evaluateExpression === undefined) {
    return Result.fail(compilationError(error(
      Codes.EvaluationRequired,
      `Expression for ${targetLabel} requires an evaluation service`,
      targetPath,
      targetDetails
    )))
  }
  const stateSnapshot = Json.snapshot(state)
  if (Result.isFailure(stateSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not create an immutable evaluation snapshot for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  const frozenState = stateSnapshot.success as unknown as BpmnExecutionState.BpmnExecutionState
  const frozenScope = frozenState.scopeInstances.find((candidate) =>
    candidate.scopeInstanceId === scopeInstance.scopeInstanceId
  )
  if (frozenScope === undefined) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not resolve evaluation scope '${scopeInstance.scopeInstanceId}'`,
      ["scopeInstances"]
    )))
  }
  const evaluatorBinding = kernel.evaluatorBindings.find((binding) =>
    binding.language === expression.language &&
    binding.languageVersion === expression.version
  )
  if (evaluatorBinding === undefined) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `No compiled evaluator binding exists for expression language '${expression.language}' version '${expression.version}'`,
      targetPath,
      {
        ...targetDetails as Record<string, Schema.Json>,
        language: expression.language,
        languageVersion: expression.version
      }
    )))
  }
  const frozenFrame = target._tag === "StandardLoopCondition"
    ? frozenState.loopFrames.find((frame) => frame.frameId === target.frame.frameId)
    : undefined
  if (
    target._tag === "StandardLoopCondition" &&
    frozenFrame === undefined
  ) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not resolve evaluation frame '${target.frame.frameId}'`,
      ["loopFrames"],
      targetDetails
    )))
  }
  const frozenGroup = target._tag === "MultiInstanceCompletionCondition"
    ? frozenState.multiInstanceGroups.find((group) => group.groupId === target.group.groupId)
    : undefined
  const frozenMember = target._tag === "MultiInstanceCompletionCondition"
    ? frozenGroup?.members.find((member) =>
      member.index === target.completedMember.index &&
      member.itemKey === target.completedMember.itemKey
    )
    : undefined
  if (
    target._tag === "MultiInstanceCompletionCondition" &&
    (frozenGroup === undefined || frozenMember === undefined)
  ) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not resolve multi-instance completion context for group '${target.group.groupId}'`,
      ["multiInstanceGroups"],
      targetDetails
    )))
  }
  const contextInput = target._tag === "SequenceFlowCondition"
    ? {
      _tag: "SequenceFlowCondition" as const,
      expression,
      sequenceFlow: target.sequenceFlow,
      sourceNode: target.sourceNode,
      scopeInstance: frozenScope,
      state: frozenState
    }
    : target._tag === "StandardLoopCondition"
    ? {
      _tag: "StandardLoopCondition" as const,
      expression,
      activity: target.activity,
      loopFrame: frozenFrame!,
      phase: target.phase,
      iteration: target.iteration,
      scopeInstance: frozenScope,
      state: frozenState
    }
    : target._tag === "MultiInstanceCardinality"
    ? {
      _tag: "MultiInstanceCardinality" as const,
      expression,
      activity: target.activity,
      groupId: target.groupId,
      groupActivation: target.activation,
      scopeInstance: frozenScope,
      state: frozenState
    }
    : target._tag === "MultiInstanceCollection"
    ? {
      _tag: "MultiInstanceCollection" as const,
      expression,
      activity: target.activity,
      groupId: target.groupId,
      groupActivation: target.activation,
      dataInputRef: target.dataInputRef,
      scopeInstance: frozenScope,
      state: frozenState
    }
    : {
      _tag: "MultiInstanceCompletionCondition" as const,
      expression,
      activity: target.activity,
      multiInstanceGroup: frozenGroup!,
      completedMember: frozenMember!,
      runtime: {
        loopCounter: frozenMember!.index,
        ...multiInstanceCounters(frozenGroup!)
      },
      scopeInstance: frozenScope,
      state: frozenState
    }
  const contextSnapshot = Json.snapshot(contextInput)
  if (Result.isFailure(contextSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not create a canonical evaluator context for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  let sourceUtf8Bytes: number
  let contextCanonicalBytes: number
  try {
    sourceUtf8Bytes = new TextEncoder().encode(expression.source).byteLength
    contextCanonicalBytes = new TextEncoder().encode(
      Json.canonicalizeSnapshot(contextSnapshot.success)
    ).byteLength
  } catch {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not measure evaluator input for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  if (sourceUtf8Bytes > evaluatorBinding.limits.maxSourceUtf8Bytes) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression source for ${targetLabel} exceeds its evaluator byte limit`,
      targetPath,
      {
        ...targetDetails as Record<string, Schema.Json>,
        actual: sourceUtf8Bytes,
        maximum: evaluatorBinding.limits.maxSourceUtf8Bytes
      }
    )))
  }
  if (
    contextCanonicalBytes >
      evaluatorBinding.limits.maxContextCanonicalBytes
  ) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression context for ${targetLabel} exceeds its evaluator byte limit`,
      targetPath,
      {
        ...targetDetails as Record<string, Schema.Json>,
        actual: contextCanonicalBytes,
        maximum: evaluatorBinding.limits.maxContextCanonicalBytes
      }
    )))
  }
  const request: BpmnExpressionEvaluator.EvaluationRequest = {
    source: expression.source,
    context: contextSnapshot.success,
    expectedResult: target._tag === "MultiInstanceCardinality"
      ? "non-negative-integer"
      : target._tag === "MultiInstanceCollection"
      ? "json-array"
      : "boolean"
  }

  let evaluated: unknown
  try {
    const context = {
      ...contextInput,
      evaluatorBinding,
      request
    } as EvaluationContext
    evaluated = services.evaluateExpression(context)
  } catch {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator threw for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  if (!Result.isResult(evaluated)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator returned an invalid result for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  if (Result.isFailure(evaluated)) {
    if (evaluated.failure instanceof Diagnostic.CompilationError) {
      return Result.fail(evaluated.failure)
    }
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator returned an invalid failure for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  const evaluatedSnapshot = Json.snapshot(evaluated.success)
  if (Result.isFailure(evaluatedSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator returned a non-JSON result for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  const decodedEvaluation = decodeEvaluationResult(evaluatedSnapshot.success)
  if (Result.isFailure(decodedEvaluation)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator returned an invalid result for ${targetLabel}`,
      targetPath,
      targetDetails
    )))
  }
  const outcome = evaluatedSnapshot.success as unknown as BpmnExpressionEvaluator.EvaluationResult
  if (outcome.steps > evaluatorBinding.limits.maxSteps) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator exceeded its step limit for ${targetLabel}`,
      targetPath,
      {
        ...targetDetails as Record<string, Schema.Json>,
        actual: outcome.steps,
        maximum: evaluatorBinding.limits.maxSteps
      }
    )))
  }
  if (
    target._tag === "MultiInstanceCardinality"
      ? typeof outcome.result !== "number" ||
        !Number.isSafeInteger(outcome.result) ||
        outcome.result < 0
      : target._tag === "MultiInstanceCollection"
      ? !Array.isArray(outcome.result)
      : typeof outcome.result !== "boolean"
  ) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Expression evaluator returned a result with the wrong semantic type for ${targetLabel}`,
      targetPath,
      {
        ...targetDetails as Record<string, Schema.Json>,
        expectedResult: target._tag === "MultiInstanceCardinality"
          ? "non-negative-integer"
          : target._tag === "MultiInstanceCollection"
          ? "json-array"
          : "boolean"
      }
    )))
  }
  let collectionCanonicalBytes: number | undefined
  let itemCanonicalBytes: Array<number> | undefined
  if (target._tag === "MultiInstanceCollection") {
    const items = outcome.result as ReadonlyArray<Schema.Json>
    const measuredCollection = canonicalUtf8Bytes(
      items as Schema.Json
    )
    if (Result.isFailure(measuredCollection)) {
      return Result.fail(measuredCollection.failure)
    }
    if (
      items.length > kernel.limits.maxMultiInstanceCardinality ||
      measuredCollection.success >
        kernel.limits.maxMultiInstanceCollectionCanonicalBytes
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidKernelLimits,
        `Multi-instance collection for task '${target.activity.id}' exceeds its compiled limit`,
        ["limits"],
        {
          itemCount: items.length,
          maximumItemCount: kernel.limits.maxMultiInstanceCardinality,
          canonicalBytes: measuredCollection.success,
          maximumCanonicalBytes: kernel.limits.maxMultiInstanceCollectionCanonicalBytes
        }
      )))
    }
    const measuredItems: Array<number> = []
    for (let index = 0; index < items.length; index++) {
      const measured = canonicalUtf8Bytes(items[index]!)
      if (Result.isFailure(measured)) {
        return Result.fail(measured.failure)
      }
      if (
        measured.success >
          kernel.limits.maxMultiInstanceItemCanonicalBytes
      ) {
        return Result.fail(compilationError(error(
          Codes.InvalidKernelLimits,
          `Multi-instance collection item '${index}' for task '${target.activity.id}' exceeds its compiled limit`,
          ["limits", "maxMultiInstanceItemCanonicalBytes"],
          {
            itemIndex: index,
            actual: measured.success,
            maximum: kernel.limits.maxMultiInstanceItemCanonicalBytes
          }
        )))
      }
      measuredItems.push(measured.success)
    }
    collectionCanonicalBytes = measuredCollection.success
    itemCanonicalBytes = measuredItems
  }
  const usage = {
    sourceUtf8Bytes,
    contextCanonicalBytes,
    steps: outcome.steps
  }
  switch (target._tag) {
    case "SequenceFlowCondition": {
      recordEvent(journal, {
        _tag: "ConditionEvaluated",
        sequenceFlowId: target.sequenceFlow.id,
        expression,
        evaluatorBinding,
        usage,
        result: outcome.result as boolean
      })
      break
    }
    case "StandardLoopCondition": {
      recordEvent(journal, {
        _tag: "LoopConditionEvaluated",
        frameId: target.frame.frameId,
        activityId: target.activity.id,
        activation: target.frame.activation,
        phase: target.phase,
        iteration: target.iteration,
        expression,
        evaluatorBinding,
        usage,
        result: outcome.result as boolean
      })
      break
    }
    case "MultiInstanceCardinality": {
      recordEvent(journal, {
        _tag: "MultiInstanceCardinalityEvaluated",
        groupId: target.groupId,
        activityId: target.activity.id,
        activation: target.activation,
        expression,
        evaluatorBinding,
        usage,
        cardinality: outcome.result as number
      })
      break
    }
    case "MultiInstanceCollection": {
      recordEvent(journal, {
        _tag: "MultiInstanceCollectionEvaluated",
        groupId: target.groupId,
        activityId: target.activity.id,
        activation: target.activation,
        dataInputRef: target.dataInputRef,
        expression,
        evaluatorBinding,
        usage,
        collectionCanonicalBytes: collectionCanonicalBytes!,
        itemCanonicalBytes: itemCanonicalBytes!,
        items: outcome.result as Array<Schema.Json>
      })
      break
    }
    case "MultiInstanceCompletionCondition": {
      recordEvent(journal, {
        _tag: "MultiInstanceCompletionConditionEvaluated",
        groupId: target.group.groupId,
        activityId: target.activity.id,
        activation: target.group.activation,
        itemIndex: target.completedMember.index,
        itemKey: target.completedMember.itemKey,
        expression,
        evaluatorBinding,
        usage,
        counters: multiInstanceCounters(target.group),
        result: outcome.result as boolean
      })
      break
    }
  }
  return Result.succeed(outcome.result)
}

const evaluateBooleanExpression = (
  kernel: CompiledKernel,
  services: Services,
  expression: BpmnModel.Expression,
  target: Exclude<
    EvaluationTarget,
    | { readonly _tag: "MultiInstanceCardinality" }
    | { readonly _tag: "MultiInstanceCollection" }
  >,
  scopeInstance: MutableScopeInstance,
  state: MutableState,
  journal: Array<TransitionEvent>
): Result.Result<boolean, Diagnostic.CompilationError> =>
  Result.flatMap(
    evaluateExpression(
      kernel,
      services,
      expression,
      target,
      scopeInstance,
      state,
      journal
    ),
    (value) =>
      typeof value === "boolean"
        ? Result.succeed(value)
        : Result.fail(compilationError(error(
          Codes.EvaluationFailed,
          "Expression evaluator returned a non-boolean result",
          target._tag === "SequenceFlowCondition"
            ? ["sequenceFlows"]
            : ["flowNodes"]
        )))
  )

const routeConditional = (
  kernel: CompiledKernel,
  services: Services,
  expression: BpmnModel.Expression,
  sequenceFlow: BpmnModel.SequenceFlow,
  sourceNode: BpmnModel.Task | BpmnModel.SubProcess | BpmnModel.Gateway,
  scopeInstance: MutableScopeInstance,
  state: MutableState,
  journal: Array<TransitionEvent>
): Result.Result<boolean, Diagnostic.CompilationError> =>
  evaluateBooleanExpression(
    kernel,
    services,
    expression,
    {
      _tag: "SequenceFlowCondition",
      sequenceFlow,
      sourceNode
    },
    scopeInstance,
    state,
    journal
  )

const emitFlowTokens = (
  state: MutableState,
  journal: Array<TransitionEvent>,
  scopeInstance: MutableScopeInstance,
  flowIds: ReadonlyArray<string>,
  now: ProtocolV2Wire.Timestamp
): void => {
  for (const flowId of flowIds) {
    const token = createToken(state, scopeInstance, {
      _tag: "OnSequenceFlow",
      sequenceFlowId: flowId
    }, now)
    state.tokens.push(token)
    recordEvent(journal, {
      _tag: "TokenEmitted",
      tokenId: token.tokenId,
      processId: token.processId,
      scopeInstanceId: token.scopeInstanceId,
      invocation: token.invocation,
      position: token.position,
      createdAt: token.createdAt
    })
  }
}

const consumeToken = (
  token: MutableToken,
  journal: Array<TransitionEvent>,
  reason:
    | "flow-advanced"
    | "task-completed"
    | "task-succeeded"
    | "parallel-join-arrival"
    | "end-reached"
    | "subprocess-entered",
  now: ProtocolV2Wire.Timestamp
): void => {
  token.status = "consumed"
  token.consumedAt = now
  recordEvent(journal, {
    _tag: "TokenConsumed",
    tokenId: token.tokenId,
    reason,
    consumedAt: now
  })
}

type WithdrawalReason =
  | "boundary-error-caught"
  | "multi-instance-completion-condition"
  | "execution-cancelled"
  | "uncaught-bpmn-error"
  | "unmapped-business-failure"

const withdrawToken = (
  token: MutableToken,
  journal: Array<TransitionEvent>,
  reason: WithdrawalReason,
  now: ProtocolV2Wire.Timestamp
): void => {
  token.status = "withdrawn"
  token.consumedAt = now
  recordEvent(journal, {
    _tag: "TokenWithdrawn",
    tokenId: token.tokenId,
    reason,
    withdrawnAt: now
  })
}

const matchingBoundaryError = (
  kernel: CompiledKernel,
  taskNodeId: string,
  errorRef: string
): BpmnModel.BoundaryEvent | undefined => {
  const boundary = kernel.boundaryErrorByTaskNodeId.get(taskNodeId)
  if (boundary === undefined) {
    return undefined
  }
  const caughtRef = boundaryErrorRef(kernel.model, boundary)
  return caughtRef === undefined || caughtRef === errorRef
    ? boundary
    : undefined
}

const routeActivityOutgoing = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  sourceNode: BpmnModel.Task | BpmnModel.SubProcess,
  scopeInstance: MutableScopeInstance,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const ordered = kernel.orderedOutgoingByNodeId.get(sourceNode.id) ?? []
  const selected: Array<string> = []
  let defaultFlowId: string | undefined = undefined
  for (const flowId of ordered) {
    const flow = kernel.flowById.get(flowId)
    if (flow === undefined) {
      continue
    }
    if (flow.kind === "default") {
      defaultFlowId = flow.id
      continue
    }
    if (flow.kind === "normal") {
      selected.push(flow.id)
      continue
    }
    const evaluated = routeConditional(
      kernel,
      services,
      flow.condition!,
      flow,
      sourceNode,
      scopeInstance,
      state,
      journal
    )
    if (Result.isFailure(evaluated)) {
      return Result.fail(evaluated.failure)
    }
    if (evaluated.success === true) {
      selected.push(flow.id)
    }
  }
  const selectedFlowIds = selected.length > 0
    ? selected
    : defaultFlowId === undefined
    ? []
    : [defaultFlowId]
  recordEvent(journal, {
    _tag: "OutgoingSelected",
    sourceNodeId: sourceNode.id,
    routingKind: "activity",
    sequenceFlowIds: selectedFlowIds
  })
  emitFlowTokens(
    state,
    journal,
    scopeInstance,
    selectedFlowIds,
    services.now
  )
  return Result.succeed(undefined)
}

const nextLoopActivation = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "loopFrames">,
  activityId: string,
  scopeInstanceId: string
): number =>
  state.loopFrames
    .filter((frame) =>
      frame.activityId === activityId &&
      frame.scopeInstanceId === scopeInstanceId
    )
    .reduce((maximum, frame) => Math.max(maximum, frame.activation), -1) + 1

const startStandardLoopIteration = (
  state: MutableState,
  frame: MutableLoopFrame,
  activity: BpmnModel.Task,
  scope: MutableScopeInstance,
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): void => {
  const iteration = frame.completedIterations
  frame.activeIteration = iteration
  recordEvent(journal, {
    _tag: "LoopIterationStarted",
    frameId: frame.frameId,
    activityId: activity.id,
    activation: frame.activation,
    iteration,
    startedAt: now
  })
  const waiting = createToken(
    state as unknown as BpmnExecutionState.BpmnExecutionState,
    scope,
    {
      _tag: "AtNode",
      nodeId: activity.id
    },
    now,
    {
      activationId: scope.invocation.activationId,
      branch: {
        _tag: "StandardLoopIteration",
        frameId: frame.frameId,
        iteration
      },
      generation: scope.invocation.generation
    }
  )
  state.tokens.push(waiting)
  recordEvent(journal, {
    _tag: "TokenEmitted",
    tokenId: waiting.tokenId,
    processId: waiting.processId,
    scopeInstanceId: waiting.scopeInstanceId,
    invocation: waiting.invocation,
    position: waiting.position,
    createdAt: waiting.createdAt
  })
  recordEvent(journal, {
    _tag: "TaskWaiting",
    tokenId: waiting.tokenId,
    taskNodeId: activity.id,
    scopeInstanceId: waiting.scopeInstanceId,
    enteredAt: now
  })
}

const completeStandardLoopFrame = (
  frame: MutableLoopFrame,
  activity: BpmnModel.Task,
  reason: "condition-false" | "maximum-reached",
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): void => {
  frame.status = "completed"
  delete frame.activeIteration
  frame.closedAt = now
  recordEvent(journal, {
    _tag: "LoopCompleted",
    frameId: frame.frameId,
    activityId: activity.id,
    activation: frame.activation,
    completedIterations: frame.completedIterations,
    reason,
    completedAt: now
  })
}

const cancelStandardLoopFrame = (
  frame: MutableLoopFrame,
  sourceTokenId: string,
  reason:
    | "boundary-error-caught"
    | "uncaught-bpmn-error"
    | "unmapped-business-failure",
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): void => {
  frame.status = "cancelled"
  delete frame.activeIteration
  frame.closedAt = now
  recordEvent(journal, {
    _tag: "LoopFrameCancelled",
    frameId: frame.frameId,
    activityId: frame.activityId,
    activation: frame.activation,
    sourceTokenId,
    reason,
    cancelledAt: now
  })
}

const openStandardLoop = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  activity: BpmnModel.Task,
  scope: MutableScopeInstance,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const characteristics = activity.loopCharacteristics
  if (
    characteristics?._tag !== "StandardLoopCharacteristics" ||
    characteristics.condition === undefined ||
    characteristics.loopMaximum === undefined
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Task '${activity.id}' does not have executable bounded standard-loop characteristics`,
      ["flowNodes"]
    )))
  }
  const frame: MutableLoopFrame = {
    frameId: nextId(
      state.loopFrames.map((candidate) => candidate.frameId),
      "loop-frame:"
    ),
    activityId: activity.id,
    processId: activity.processId,
    scopeInstanceId: scope.scopeInstanceId,
    activation: nextLoopActivation(
      state as unknown as BpmnExecutionState.BpmnExecutionState,
      activity.id,
      scope.scopeInstanceId
    ),
    completedIterations: 0,
    status: "active",
    openedAt: services.now
  }
  state.loopFrames.push(frame)
  recordEvent(journal, {
    _tag: "LoopOpened",
    frameId: frame.frameId,
    activityId: frame.activityId,
    processId: frame.processId,
    scopeInstanceId: frame.scopeInstanceId,
    activation: frame.activation,
    openedAt: frame.openedAt
  })
  if (characteristics.testBefore) {
    const evaluated = evaluateBooleanExpression(
      kernel,
      services,
      characteristics.condition,
      {
        _tag: "StandardLoopCondition",
        activity,
        frame,
        phase: "before",
        iteration: 0
      },
      scope,
      state,
      journal
    )
    if (Result.isFailure(evaluated)) {
      return Result.fail(evaluated.failure)
    }
    if (!evaluated.success) {
      completeStandardLoopFrame(
        frame,
        activity,
        "condition-false",
        journal,
        services.now
      )
      return routeActivityOutgoing(
        kernel,
        services,
        state,
        activity,
        scope,
        journal
      )
    }
  }
  startStandardLoopIteration(
    state,
    frame,
    activity,
    scope,
    journal,
    services.now
  )
  return Result.succeed(undefined)
}

const completeStandardLoopIteration = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  activity: BpmnModel.Task,
  scope: MutableScopeInstance,
  token: MutableToken,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const characteristics = activity.loopCharacteristics
  const branch = standardLoopBranch(token.invocation)
  const frame = branch === undefined
    ? undefined
    : state.loopFrames.find((candidate) => candidate.frameId === branch.frameId)
  if (
    characteristics?._tag !== "StandardLoopCharacteristics" ||
    characteristics.condition === undefined ||
    characteristics.loopMaximum === undefined ||
    frame === undefined ||
    frame.status !== "active" ||
    frame.activeIteration === undefined ||
    frame.activeIteration !== branch?.iteration
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Task token '${token.tokenId}' does not match one executable standard-loop iteration`,
      ["tokens"]
    )))
  }
  const completedIteration = frame.activeIteration
  delete frame.activeIteration
  frame.completedIterations++
  recordEvent(journal, {
    _tag: "LoopIterationCompleted",
    frameId: frame.frameId,
    activityId: activity.id,
    activation: frame.activation,
    iteration: completedIteration,
    completedAt: services.now
  })
  if (frame.completedIterations >= characteristics.loopMaximum) {
    completeStandardLoopFrame(
      frame,
      activity,
      "maximum-reached",
      journal,
      services.now
    )
    return routeActivityOutgoing(
      kernel,
      services,
      state,
      activity,
      scope,
      journal
    )
  }
  const phase = characteristics.testBefore ? "before" : "after"
  const conditionIteration = characteristics.testBefore
    ? frame.completedIterations
    : completedIteration
  const evaluated = evaluateBooleanExpression(
    kernel,
    services,
    characteristics.condition,
    {
      _tag: "StandardLoopCondition",
      activity,
      frame,
      phase,
      iteration: conditionIteration
    },
    scope,
    state,
    journal
  )
  if (Result.isFailure(evaluated)) {
    return Result.fail(evaluated.failure)
  }
  if (!evaluated.success) {
    completeStandardLoopFrame(
      frame,
      activity,
      "condition-false",
      journal,
      services.now
    )
    return routeActivityOutgoing(
      kernel,
      services,
      state,
      activity,
      scope,
      journal
    )
  }
  startStandardLoopIteration(
    state,
    frame,
    activity,
    scope,
    journal,
    services.now
  )
  return Result.succeed(undefined)
}

const nextMultiInstanceActivation = (
  state: Pick<BpmnExecutionState.BpmnExecutionState, "multiInstanceGroups">,
  activityId: string,
  scopeInstanceId: string
): number =>
  state.multiInstanceGroups
    .filter((group) =>
      group.activityId === activityId &&
      group.scopeInstanceId === scopeInstanceId
    )
    .reduce((maximum, group) => Math.max(maximum, group.activation), -1) + 1

const startMultiInstanceMember = (
  state: MutableState,
  group: MutableMultiInstanceGroup,
  member: MutableMultiInstanceMember,
  activity: BpmnModel.Task,
  scope: MutableScopeInstance,
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): void => {
  member.status = "active"
  member.startedAt = now
  recordEvent(journal, {
    _tag: "MultiInstanceItemStarted",
    groupId: group.groupId,
    activityId: activity.id,
    activation: group.activation,
    itemIndex: member.index,
    itemKey: member.itemKey,
    startedAt: now
  })
  const waiting = createToken(
    state as unknown as BpmnExecutionState.BpmnExecutionState,
    scope,
    {
      _tag: "AtNode",
      nodeId: activity.id
    },
    now,
    {
      activationId: scope.invocation.activationId,
      branch: {
        _tag: "MultiInstanceItem",
        groupId: group.groupId,
        itemIndex: member.index,
        itemKey: member.itemKey
      },
      generation: scope.invocation.generation
    }
  )
  member.tokenId = waiting.tokenId
  state.tokens.push(waiting)
  recordEvent(journal, {
    _tag: "TokenEmitted",
    tokenId: waiting.tokenId,
    processId: waiting.processId,
    scopeInstanceId: waiting.scopeInstanceId,
    invocation: waiting.invocation,
    position: waiting.position,
    createdAt: waiting.createdAt
  })
  recordEvent(journal, {
    _tag: "TaskWaiting",
    tokenId: waiting.tokenId,
    taskNodeId: activity.id,
    scopeInstanceId: waiting.scopeInstanceId,
    enteredAt: now
  })
}

type MultiInstanceClosureReason = BpmnExecutionState.MultiInstanceClosureReason

const closeMultiInstanceMember = (
  state: MutableState,
  group: MutableMultiInstanceGroup,
  member: MutableMultiInstanceMember,
  reason: MultiInstanceClosureReason,
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): void => {
  if (
    member.status === "completed" ||
    member.status === "terminated" ||
    member.status === "not-generated"
  ) {
    return
  }
  if (member.status === "pending") {
    member.status = "not-generated"
    member.nonGenerationReason = reason
    recordEvent(journal, {
      _tag: "MultiInstanceItemNotGenerated",
      groupId: group.groupId,
      activityId: group.activityId,
      activation: group.activation,
      itemIndex: member.index,
      itemKey: member.itemKey,
      reason,
      notGeneratedAt: now
    })
    return
  }
  const token = member.tokenId === undefined
    ? undefined
    : state.tokens.find((candidate) => candidate.tokenId === member.tokenId)
  if (token?.status === "active") {
    withdrawToken(
      token,
      journal,
      reason === "completion-condition"
        ? "multi-instance-completion-condition"
        : reason,
      now
    )
  }
  member.status = "terminated"
  member.terminationReason = reason
  if (member.startedAt !== undefined) {
    member.endedAt = now
  }
  recordEvent(journal, {
    _tag: "MultiInstanceItemTerminated",
    groupId: group.groupId,
    activityId: group.activityId,
    activation: group.activation,
    itemIndex: member.index,
    itemKey: member.itemKey,
    reason,
    terminatedAt: now
  })
}

const completeMultiInstanceGroup = (
  kernel: CompiledKernel,
  group: MutableMultiInstanceGroup,
  activity: BpmnModel.Task,
  reason: "all-completed" | "completion-condition" | "empty",
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): Result.Result<void, Diagnostic.CompilationError> => {
  const characteristics = activity.loopCharacteristics
  const dataOutputRef = characteristics?._tag === "MultiInstanceCharacteristics"
    ? characteristics.loopDataOutputRef
    : undefined
  if (dataOutputRef !== undefined) {
    if (reason === "completion-condition") {
      return Result.fail(compilationError(error(
        Codes.InvalidExecutableStructure,
        `Collection output '${dataOutputRef}' requires complete all-member success`,
        ["multiInstanceGroups"]
      )))
    }
    const items: Array<Schema.Json> = []
    for (const member of group.members) {
      if (
        member.status !== "completed" ||
        member.output === undefined
      ) {
        return Result.fail(compilationError(error(
          Codes.InvalidCommand,
          `Multi-instance member '${group.groupId}:${member.index}' has no output for '${dataOutputRef}'`,
          ["multiInstanceGroups"]
        )))
      }
      const measured = canonicalUtf8Bytes(member.output)
      if (
        Result.isFailure(measured) ||
        measured.success >
          kernel.limits.maxMultiInstanceItemOutputCanonicalBytes
      ) {
        return Result.fail(compilationError(error(
          Codes.InvalidKernelLimits,
          `Multi-instance output item '${group.groupId}:${member.index}' exceeds its compiled limit`,
          ["limits", "maxMultiInstanceItemOutputCanonicalBytes"]
        )))
      }
      items.push(member.output)
    }
    const measured = canonicalUtf8Bytes(items as Schema.Json)
    if (
      Result.isFailure(measured) ||
      measured.success >
        kernel.limits.maxMultiInstanceOutputCanonicalBytes
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidKernelLimits,
        `Multi-instance output collection '${dataOutputRef}' exceeds its compiled limit`,
        ["limits", "maxMultiInstanceOutputCanonicalBytes"]
      )))
    }
    group.output = {
      dataOutputRef,
      items: directClone(items) as Mutable<
        BpmnExecutionState.MultiInstanceOutput["items"]
      >
    }
  }
  group.status = "completed"
  group.completionReason = reason
  group.closedAt = now
  recordEvent(journal, {
    _tag: "MultiInstanceGroupCompleted",
    groupId: group.groupId,
    activityId: activity.id,
    activation: group.activation,
    counters: multiInstanceCounters(group),
    ...(group.output === undefined
      ? undefined
      : { output: group.output }),
    reason,
    completedAt: now
  })
  return Result.succeed(undefined)
}

const cancelMultiInstanceGroup = (
  state: MutableState,
  group: MutableMultiInstanceGroup,
  sourceTokenId: string,
  reason: Exclude<MultiInstanceClosureReason, "completion-condition">,
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): void => {
  for (const member of group.members) {
    if (
      member.status === "completed" ||
      member.status === "terminated" ||
      member.status === "not-generated"
    ) {
      continue
    }
    const token = member.tokenId === undefined
      ? undefined
      : state.tokens.find((candidate) => candidate.tokenId === member.tokenId)
    if (token?.status === "active") {
      withdrawToken(token, journal, reason, now)
    }
  }
  for (const member of group.members) {
    closeMultiInstanceMember(
      state,
      group,
      member,
      reason,
      journal,
      now
    )
  }
  group.status = "cancelled"
  group.completionReason = reason
  group.closedAt = now
  recordEvent(journal, {
    _tag: "MultiInstanceGroupCancelled",
    groupId: group.groupId,
    activityId: group.activityId,
    activation: group.activation,
    sourceTokenId,
    counters: multiInstanceCounters(group),
    reason,
    cancelledAt: now
  })
}

const openMultiInstance = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  activity: BpmnModel.Task,
  scope: MutableScopeInstance,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const characteristics = activity.loopCharacteristics
  if (
    characteristics?._tag !== "MultiInstanceCharacteristics" ||
    (
      characteristics.cardinality === undefined &&
      characteristics.loopDataInputRef === undefined
    ) ||
    (
      characteristics.cardinality !== undefined &&
      characteristics.loopDataInputRef !== undefined
    ) ||
    (characteristics.behavior !== undefined && characteristics.behavior !== "all")
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Task '${activity.id}' does not have executable fixed multi-instance characteristics`,
      ["flowNodes"]
    )))
  }
  const activation = nextMultiInstanceActivation(
    state as unknown as BpmnExecutionState.BpmnExecutionState,
    activity.id,
    scope.scopeInstanceId
  )
  const groupId = nextId(
    state.multiInstanceGroups.map((candidate) => candidate.groupId),
    "multi-instance-group:"
  )
  let source: BpmnExecutionState.MultiInstanceSource
  if (characteristics.cardinality !== undefined) {
    const evaluated = evaluateExpression(
      kernel,
      services,
      characteristics.cardinality,
      {
        _tag: "MultiInstanceCardinality",
        activity,
        groupId,
        activation
      },
      scope,
      state,
      journal
    )
    if (Result.isFailure(evaluated)) {
      return Result.fail(evaluated.failure)
    }
    const cardinality = evaluated.success
    if (
      typeof cardinality !== "number" ||
      !Number.isSafeInteger(cardinality) ||
      cardinality < 0
    ) {
      return Result.fail(compilationError(error(
        Codes.EvaluationFailed,
        `Multi-instance cardinality for task '${activity.id}' must be a non-negative safe integer`,
        ["flowNodes"]
      )))
    }
    if (cardinality > kernel.limits.maxMultiInstanceCardinality) {
      return Result.fail(compilationError(error(
        Codes.InvalidKernelLimits,
        `Multi-instance cardinality '${cardinality}' for task '${activity.id}' exceeds the compiled limit`,
        ["limits", "maxMultiInstanceCardinality"],
        {
          actual: cardinality,
          maximum: kernel.limits.maxMultiInstanceCardinality
        }
      )))
    }
    source = {
      _tag: "Cardinality",
      value: cardinality
    }
  } else {
    const dataInputRef = characteristics.loopDataInputRef!
    const binding = kernel.collectionBindingByTaskNodeId.get(activity.id)
    if (
      binding === undefined ||
      binding.dataInputRef !== dataInputRef
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidExecutableStructure,
        `Task '${activity.id}' has no exact collection DataInput binding`,
        ["flowNodes"]
      )))
    }
    const evaluated = evaluateExpression(
      kernel,
      services,
      binding.collectionExpression,
      {
        _tag: "MultiInstanceCollection",
        activity,
        groupId,
        activation,
        dataInputRef,
        expression: binding.collectionExpression
      },
      scope,
      state,
      journal
    )
    if (
      Result.isFailure(evaluated) ||
      !Array.isArray(evaluated.success)
    ) {
      return Result.isFailure(evaluated)
        ? Result.fail(evaluated.failure)
        : Result.fail(compilationError(error(
          Codes.EvaluationFailed,
          `Multi-instance DataInput '${dataInputRef}' for task '${activity.id}' must resolve to a JSON array`,
          ["flowNodes"]
        )))
    }
    source = {
      _tag: "Collection",
      dataInputRef,
      items: evaluated.success
    }
  }
  const cardinality = source._tag === "Cardinality"
    ? source.value
    : source.items.length
  const members: Array<MutableMultiInstanceMember> = Array.from(
    { length: cardinality },
    (_, index) => ({
      index,
      itemKey: `item:${index}`,
      status: "pending" as const
    })
  )
  const group: MutableMultiInstanceGroup = {
    groupId,
    activityId: activity.id,
    processId: activity.processId,
    scopeInstanceId: scope.scopeInstanceId,
    activation,
    mode: characteristics.mode,
    source: directClone(source),
    members,
    completedInstanceCount: 0,
    status: "active",
    openedAt: services.now
  }
  state.multiInstanceGroups.push(group)
  recordEvent(journal, {
    _tag: "MultiInstanceGroupOpened",
    groupId: group.groupId,
    activityId: group.activityId,
    processId: group.processId,
    scopeInstanceId: group.scopeInstanceId,
    activation: group.activation,
    mode: group.mode,
    source: group.source,
    itemKeys: group.members.map((member) => member.itemKey),
    openedAt: group.openedAt
  })
  if (cardinality === 0) {
    const completed = completeMultiInstanceGroup(
      kernel,
      group,
      activity,
      "empty",
      journal,
      services.now
    )
    if (Result.isFailure(completed)) {
      return Result.fail(completed.failure)
    }
    return routeActivityOutgoing(
      kernel,
      services,
      state,
      activity,
      scope,
      journal
    )
  }
  const toStart = group.mode === "parallel"
    ? group.members
    : [group.members[0]!]
  for (const member of toStart) {
    startMultiInstanceMember(
      state,
      group,
      member,
      activity,
      scope,
      journal,
      services.now
    )
  }
  return Result.succeed(undefined)
}

const completeMultiInstanceMember = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  activity: BpmnModel.Task,
  scope: MutableScopeInstance,
  token: MutableToken,
  journal: Array<TransitionEvent>,
  output?: Schema.Json
): Result.Result<void, Diagnostic.CompilationError> => {
  const characteristics = activity.loopCharacteristics
  const branch = multiInstanceBranch(token.invocation)
  const group = branch === undefined
    ? undefined
    : state.multiInstanceGroups.find((candidate) => candidate.groupId === branch.groupId)
  const member = branch === undefined || group === undefined
    ? undefined
    : group.members.find((candidate) =>
      candidate.index === branch.itemIndex &&
      candidate.itemKey === branch.itemKey
    )
  if (
    characteristics?._tag !== "MultiInstanceCharacteristics" ||
    group === undefined ||
    group.status !== "active" ||
    member === undefined ||
    member.status !== "active" ||
    member.tokenId !== token.tokenId
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Task token '${token.tokenId}' does not match one active multi-instance member`,
      ["tokens"]
    )))
  }
  member.status = "completed"
  member.endedAt = services.now
  if (output !== undefined) {
    const measuredOutput = canonicalUtf8Bytes(output)
    if (
      Result.isFailure(measuredOutput) ||
      measuredOutput.success >
        kernel.limits.maxMultiInstanceItemOutputCanonicalBytes
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidKernelLimits,
        `Multi-instance member output '${group.groupId}:${member.index}' exceeds its compiled limit`,
        ["limits", "maxMultiInstanceItemOutputCanonicalBytes"]
      )))
    }
    member.output = directClone(output)
  }
  group.completedInstanceCount++
  recordEvent(journal, {
    _tag: "MultiInstanceItemCompleted",
    groupId: group.groupId,
    activityId: activity.id,
    activation: group.activation,
    itemIndex: member.index,
    itemKey: member.itemKey,
    ...(member.output === undefined
      ? undefined
      : { output: member.output }),
    counters: multiInstanceCounters(group),
    completedAt: services.now
  })

  if (characteristics.completionCondition !== undefined) {
    const evaluated = evaluateBooleanExpression(
      kernel,
      services,
      characteristics.completionCondition,
      {
        _tag: "MultiInstanceCompletionCondition",
        activity,
        group,
        completedMember: member
      },
      scope,
      state,
      journal
    )
    if (Result.isFailure(evaluated)) {
      return Result.fail(evaluated.failure)
    }
    if (evaluated.success) {
      for (const remaining of group.members) {
        if (
          remaining.status === "completed" ||
          remaining.status === "terminated" ||
          remaining.status === "not-generated"
        ) {
          continue
        }
        const remainingToken = remaining.tokenId === undefined
          ? undefined
          : state.tokens.find((candidate) => candidate.tokenId === remaining.tokenId)
        if (remainingToken?.status === "active") {
          withdrawToken(
            remainingToken,
            journal,
            "multi-instance-completion-condition",
            services.now
          )
        }
      }
      for (const remaining of group.members) {
        closeMultiInstanceMember(
          state,
          group,
          remaining,
          "completion-condition",
          journal,
          services.now
        )
      }
      const completed = completeMultiInstanceGroup(
        kernel,
        group,
        activity,
        "completion-condition",
        journal,
        services.now
      )
      if (Result.isFailure(completed)) {
        return Result.fail(completed.failure)
      }
      return routeActivityOutgoing(
        kernel,
        services,
        state,
        activity,
        scope,
        journal
      )
    }
  }

  if (group.completedInstanceCount === group.members.length) {
    const completed = completeMultiInstanceGroup(
      kernel,
      group,
      activity,
      "all-completed",
      journal,
      services.now
    )
    if (Result.isFailure(completed)) {
      return Result.fail(completed.failure)
    }
    return routeActivityOutgoing(
      kernel,
      services,
      state,
      activity,
      scope,
      journal
    )
  }
  if (group.mode === "sequential") {
    const next = group.members.find((candidate) => candidate.status === "pending")
    if (next === undefined) {
      return Result.fail(compilationError(error(
        Codes.InvalidExecutableStructure,
        `Sequential multi-instance group '${group.groupId}' has no deterministic next member`,
        ["multiInstanceGroups"]
      )))
    }
    startMultiInstanceMember(
      state,
      group,
      next,
      activity,
      scope,
      journal,
      services.now
    )
  }
  return Result.succeed(undefined)
}

const routeExclusiveGateway = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  gateway: BpmnModel.Gateway,
  scopeInstance: MutableScopeInstance,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const ordered = kernel.orderedOutgoingByNodeId.get(gateway.id) ?? []
  let defaultFlowId: string | undefined = undefined
  let winner: string | undefined = undefined
  for (const flowId of ordered) {
    const flow = kernel.flowById.get(flowId)
    if (flow === undefined) {
      continue
    }
    if (flow.kind === "default") {
      defaultFlowId = flow.id
      continue
    }
    if (flow.kind === "normal") {
      winner = flow.id
      break
    }
    const evaluated = routeConditional(
      kernel,
      services,
      flow.condition!,
      flow,
      gateway,
      scopeInstance,
      state,
      journal
    )
    if (Result.isFailure(evaluated)) {
      return Result.fail(evaluated.failure)
    }
    if (evaluated.success === true) {
      winner = flow.id
      break
    }
  }
  if (winner === undefined) {
    winner = defaultFlowId
  }
  if (winner === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Exclusive gateway '${gateway.id}' has no selected outgoing flow`,
      ["flowNodes"]
    )))
  }
  recordEvent(journal, {
    _tag: "OutgoingSelected",
    sourceNodeId: gateway.id,
    routingKind: "exclusive-gateway",
    sequenceFlowIds: [winner]
  })
  emitFlowTokens(state, journal, scopeInstance, [winner], services.now)
  return Result.succeed(undefined)
}

const findScope = (
  state: MutableState,
  scopeInstanceId: string
): MutableScopeInstance | undefined => state.scopeInstances.find((scope) => scope.scopeInstanceId === scopeInstanceId)

type RootFailureKind =
  | "UnmappedBusinessFailure"
  | "UncaughtBpmnError"

const failExecutionFromTask = (
  state: MutableState,
  sourceToken: MutableToken,
  taskNodeId: string,
  failureKind: RootFailureKind,
  errorRef: string | undefined,
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): Result.Result<void, Diagnostic.CompilationError> => {
  const owningScope = findScope(state, sourceToken.scopeInstanceId)
  if (owningScope === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Failed task token '${sourceToken.tokenId}' has no owning scope`,
      ["tokens"]
    )))
  }
  const failureChain: Array<MutableScopeInstance> = []
  let current: MutableScopeInstance | undefined = owningScope
  while (current !== undefined) {
    failureChain.push(current)
    current = current.parentScopeInstanceId === undefined
      ? undefined
      : findScope(state, current.parentScopeInstanceId)
  }
  const rootScope = failureChain[failureChain.length - 1]
  if (rootScope === undefined || rootScope.parentScopeInstanceId !== undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Failed task token '${sourceToken.tokenId}' has no root failure chain`,
      ["scopeInstances"]
    )))
  }
  const reason: WithdrawalReason = failureKind === "UncaughtBpmnError"
    ? "uncaught-bpmn-error"
    : "unmapped-business-failure"
  for (const token of state.tokens) {
    if (token.status === "active") {
      withdrawToken(token, journal, reason, now)
    }
  }
  for (const frame of state.gatewayFrames) {
    if (frame.status === "waiting" || frame.status === "satisfied") {
      frame.status = "cancelled"
      recordEvent(journal, {
        _tag: "GatewayFrameCancelled",
        frameId: frame.frameId,
        sourceTokenId: sourceToken.tokenId,
        cancelledAt: now
      })
    }
  }
  for (const frame of state.loopFrames) {
    if (frame.status === "active") {
      cancelStandardLoopFrame(
        frame,
        sourceToken.tokenId,
        reason,
        journal,
        now
      )
    }
  }
  for (const group of state.multiInstanceGroups) {
    if (group.status === "active") {
      cancelMultiInstanceGroup(
        state,
        group,
        sourceToken.tokenId,
        reason,
        journal,
        now
      )
    }
  }
  const failureScopeIds = new Set(
    failureChain.map((scope) => scope.scopeInstanceId)
  )
  for (const scope of [...state.scopeInstances].reverse()) {
    if (scope.status !== "active" || failureScopeIds.has(scope.scopeInstanceId)) {
      continue
    }
    scope.status = "cancelled"
    scope.exitedAt = now
    recordEvent(journal, {
      _tag: "ScopeInterruptedByError",
      scopeInstanceId: scope.scopeInstanceId,
      definitionId: scope.definitionId,
      sourceTokenId: sourceToken.tokenId,
      exitedAt: now
    })
  }
  for (const scope of failureChain) {
    if (scope.status !== "active") {
      continue
    }
    scope.status = "failed"
    scope.exitedAt = now
    recordEvent(journal, {
      _tag: "ScopeFailed",
      scopeInstanceId: scope.scopeInstanceId,
      definitionId: scope.definitionId,
      sourceTokenId: sourceToken.tokenId,
      exitedAt: now
    })
  }
  state.status = "failed"
  state.completedAt = now
  recordEvent(journal, {
    _tag: "ExecutionFailed",
    rootScopeInstanceId: rootScope.scopeInstanceId,
    sourceTokenId: sourceToken.tokenId,
    taskNodeId,
    failureKind,
    ...(errorRef === undefined ? undefined : { errorRef }),
    failedAt: now
  })
  return Result.succeed(undefined)
}

const enterScope = (
  kernel: CompiledKernel,
  state: MutableState,
  definitionId: string,
  processId: string,
  parentScopeInstanceId: string | undefined,
  activationId: string,
  journal: Array<TransitionEvent>,
  now: ProtocolV2Wire.Timestamp
): Result.Result<BpmnExecutionState.ScopeInstance, Diagnostic.CompilationError> => {
  const scope = createScopeInstance(
    state as unknown as BpmnExecutionState.BpmnExecutionState,
    definitionId,
    processId,
    parentScopeInstanceId,
    activationId,
    now
  )
  state.scopeInstances.push(scope)
  recordEvent(journal, {
    _tag: "ScopeEntered",
    scopeInstanceId: scope.scopeInstanceId,
    definitionId,
    processId,
    ...(scope.parentScopeInstanceId === undefined
      ? undefined
      : { parentScopeInstanceId: scope.parentScopeInstanceId }),
    invocation: scope.invocation,
    enteredAt: scope.enteredAt
  })
  const startEventId = kernel.startEventIdByScopeId.get(definitionId)
  if (startEventId === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Scope '${definitionId}' has no compiled start event`,
      ["flowNodes"]
    )))
  }
  const startEvent = kernel.nodeById.get(startEventId)
  if (startEvent === undefined || startEvent._tag !== "StartEvent") {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Scope '${definitionId}' compiled an invalid start event`,
      ["flowNodes"]
    )))
  }
  emitFlowTokens(
    state,
    journal,
    scope,
    kernel.orderedOutgoingByNodeId.get(startEvent.id) ?? [],
    now
  )
  return Result.succeed(scope)
}

const fireSatisfiedFrame = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  frame: MutableGatewayFrame,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const gateway = kernel.nodeById.get(frame.gatewayId)
  const scope = findScope(state, frame.scopeInstanceId)
  if (
    gateway === undefined ||
    gateway._tag !== "Gateway" ||
    gateway.gatewayKind !== "parallel" ||
    gateway.gatewayDirection !== "converging" ||
    scope === undefined
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Gateway frame '${frame.frameId}' cannot fire`,
      ["gatewayFrames"]
    )))
  }
  frame.status = "fired"
  recordEvent(journal, {
    _tag: "GatewayFired",
    frameId: frame.frameId,
    gatewayId: frame.gatewayId,
    joinEpoch: frame.joinEpoch,
    firedAt: services.now
  })
  emitFlowTokens(
    state,
    journal,
    scope,
    kernel.orderedOutgoingByNodeId.get(gateway.id) ?? [],
    services.now
  )
  return Result.succeed(undefined)
}

const tryCompleteScopes = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  journal: Array<TransitionEvent>
): Result.Result<boolean, Diagnostic.CompilationError> => {
  const active = state.scopeInstances
    .filter((scope) => scope.status === "active")
    .sort((left, right) => right.scopeInstanceId.localeCompare(left.scopeInstanceId))
  for (const scope of active) {
    if (activeTokens(state as unknown as BpmnExecutionState.BpmnExecutionState, scope.scopeInstanceId).length > 0) {
      continue
    }
    if (waitingFrames(state as unknown as BpmnExecutionState.BpmnExecutionState, scope.scopeInstanceId).length > 0) {
      continue
    }
    if (
      activeLoopFrames(
        state as unknown as BpmnExecutionState.BpmnExecutionState,
        scope.scopeInstanceId
      ).length > 0
    ) {
      continue
    }
    if (
      activeMultiInstanceGroups(
        state as unknown as BpmnExecutionState.BpmnExecutionState,
        scope.scopeInstanceId
      ).length > 0
    ) {
      continue
    }
    if (
      activeChildScopes(state as unknown as BpmnExecutionState.BpmnExecutionState, scope.scopeInstanceId).length > 0
    ) {
      continue
    }
    scope.status = "completed"
    scope.exitedAt = services.now
    recordEvent(journal, {
      _tag: "ScopeCompleted",
      scopeInstanceId: scope.scopeInstanceId,
      definitionId: scope.definitionId,
      exitedAt: services.now
    })
    if (scope.parentScopeInstanceId === undefined) {
      state.status = "completed"
      state.completedAt = services.now
      recordEvent(journal, {
        _tag: "ExecutionCompleted",
        rootScopeInstanceId: scope.scopeInstanceId,
        completedAt: services.now
      })
      return Result.succeed(true)
    }
    const parentScope = findScope(state, scope.parentScopeInstanceId)
    const subprocess = kernel.nodeById.get(scope.definitionId)
    if (parentScope !== undefined && subprocess !== undefined && subprocess._tag === "SubProcess") {
      return Result.map(
        routeActivityOutgoing(kernel, services, state, subprocess, parentScope, journal),
        () => true
      )
    }
    return Result.succeed(true)
  }
  return Result.succeed(false)
}

const routeNodeArrival = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  token: MutableToken,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  const scope = findScope(state, token.scopeInstanceId)
  if (scope === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidExecutableStructure,
      `Token '${token.tokenId}' references an unknown scope while advancing`,
      ["tokens"]
    )))
  }
  if (token.position._tag === "OnSequenceFlow") {
    const flow = kernel.flowById.get(token.position.sequenceFlowId)
    if (flow === undefined) {
      return Result.fail(compilationError(error(
        Codes.InvalidExecutableStructure,
        `Unknown sequence flow '${token.position.sequenceFlowId}'`,
        ["sequenceFlows"]
      )))
    }
    const target = kernel.nodeById.get(flow.targetId)
    if (target === undefined) {
      return Result.fail(compilationError(error(
        Codes.InvalidExecutableStructure,
        `Sequence flow '${flow.id}' targets unknown node '${flow.targetId}'`,
        ["sequenceFlows"]
      )))
    }
    const consumeReason = target._tag === "EndEvent"
      ? "end-reached"
      : target._tag === "SubProcess"
      ? "subprocess-entered"
      : target._tag === "Gateway" &&
          target.gatewayKind === "parallel" &&
          target.gatewayDirection === "converging"
      ? "parallel-join-arrival"
      : "flow-advanced"
    consumeToken(token, journal, consumeReason, services.now)
    if (target._tag === "Task") {
      if (
        target.loopCharacteristics?._tag ===
          "StandardLoopCharacteristics"
      ) {
        return openStandardLoop(
          kernel,
          services,
          state,
          target,
          scope,
          journal
        )
      }
      if (
        target.loopCharacteristics?._tag ===
          "MultiInstanceCharacteristics"
      ) {
        return openMultiInstance(
          kernel,
          services,
          state,
          target,
          scope,
          journal
        )
      }
      const waiting = createToken(state as unknown as BpmnExecutionState.BpmnExecutionState, scope, {
        _tag: "AtNode",
        nodeId: target.id
      }, services.now)
      state.tokens.push(waiting)
      recordEvent(journal, {
        _tag: "TokenEmitted",
        tokenId: waiting.tokenId,
        processId: waiting.processId,
        scopeInstanceId: waiting.scopeInstanceId,
        invocation: waiting.invocation,
        position: waiting.position,
        createdAt: waiting.createdAt
      })
      recordEvent(journal, {
        _tag: "TaskWaiting",
        tokenId: waiting.tokenId,
        taskNodeId: target.id,
        scopeInstanceId: waiting.scopeInstanceId,
        enteredAt: services.now
      })
      return Result.succeed(undefined)
    }
    if (target._tag === "SubProcess") {
      return Result.map(
        enterScope(
          kernel,
          state,
          target.id,
          target.processId,
          scope.scopeInstanceId,
          scope.invocation.activationId,
          journal,
          services.now
        ),
        () => undefined
      )
    }
    if (target._tag === "EndEvent") {
      return Result.succeed(undefined)
    }
    if (target._tag === "Gateway") {
      if (target.gatewayKind === "exclusive") {
        if (target.gatewayDirection === "diverging") {
          return routeExclusiveGateway(kernel, services, state, target, scope, journal)
        }
        emitFlowTokens(
          state,
          journal,
          scope,
          kernel.orderedOutgoingByNodeId.get(target.id) ?? [],
          services.now
        )
        return Result.succeed(undefined)
      }
      if (target.gatewayDirection === "diverging") {
        emitFlowTokens(
          state,
          journal,
          scope,
          kernel.orderedOutgoingByNodeId.get(target.id) ?? [],
          services.now
        )
        return Result.succeed(undefined)
      }
      const waiting = state.gatewayFrames
        .filter((frame) =>
          frame.gatewayId === target.id &&
          frame.scopeInstanceId === scope.scopeInstanceId &&
          frame.activationId === scope.invocation.activationId &&
          frame.status === "waiting" &&
          !frame.arrivedIncomingSequenceFlowIds.includes(flow.id)
        )
        .sort((left, right) => left.joinEpoch - right.joinEpoch)[0]
      const frame = waiting ?? (() => {
        const created: MutableGatewayFrame = {
          frameId: nextId(state.gatewayFrames.map((candidate) => candidate.frameId), "frame:"),
          gatewayId: target.id,
          processId: target.processId,
          scopeInstanceId: scope.scopeInstanceId,
          activationId: scope.invocation.activationId,
          joinEpoch: currentFrameEpoch(
            state as unknown as BpmnExecutionState.BpmnExecutionState,
            target.id,
            scope.scopeInstanceId,
            scope.invocation.activationId
          ) + 1,
          expectedIncomingSequenceFlowIds: [...target.incomingSequenceFlowIds],
          arrivedIncomingSequenceFlowIds: [],
          status: "waiting"
        }
        state.gatewayFrames.push(created)
        recordEvent(journal, {
          _tag: "GatewayFrameOpened",
          frameId: created.frameId,
          gatewayId: created.gatewayId,
          processId: created.processId,
          scopeInstanceId: created.scopeInstanceId,
          activationId: created.activationId,
          joinEpoch: created.joinEpoch,
          expectedIncomingSequenceFlowIds: created.expectedIncomingSequenceFlowIds
        })
        return created
      })()
      frame.arrivedIncomingSequenceFlowIds.push(flow.id)
      recordEvent(journal, {
        _tag: "GatewayArrivalRecorded",
        frameId: frame.frameId,
        gatewayId: frame.gatewayId,
        joinEpoch: frame.joinEpoch,
        sequenceFlowId: flow.id,
        arrivedIncomingSequenceFlowIds: frame.arrivedIncomingSequenceFlowIds
      })
      if (
        frame.expectedIncomingSequenceFlowIds.every((flowId) => frame.arrivedIncomingSequenceFlowIds.includes(flowId))
      ) {
        frame.status = "satisfied"
      }
      return Result.succeed(undefined)
    }
  }
  return Result.fail(compilationError(error(
    Codes.InvalidExecutableStructure,
    `Only task wait states may remain active between transitions`,
    ["tokens"]
  )))
}

const advanceMutable = (
  kernel: CompiledKernel,
  services: Services,
  state: MutableState,
  journal: Array<TransitionEvent>
): Result.Result<void, Diagnostic.CompilationError> => {
  if (state.status !== "active") {
    return Result.succeed(undefined)
  }
  let automaticTransitions = 0
  const consumeAutomaticTransition = (): Result.Result<void, Diagnostic.CompilationError> => {
    if (automaticTransitions >= kernel.limits.maxAutomaticTransitions) {
      return Result.fail(compilationError(error(
        Codes.AutomaticTransitionLimitExceeded,
        `Automatic BPMN transition limit '${kernel.limits.maxAutomaticTransitions}' was exceeded`,
        ["limits", "maxAutomaticTransitions"],
        { maxAutomaticTransitions: kernel.limits.maxAutomaticTransitions }
      )))
    }
    automaticTransitions++
    return Result.succeed(undefined)
  }
  let progressed = true
  while (progressed) {
    progressed = false
    const flowToken = state.tokens.find((token) =>
      token.status === "active" && token.position._tag === "OnSequenceFlow"
    )
    if (flowToken !== undefined) {
      const budget = consumeAutomaticTransition()
      if (Result.isFailure(budget)) {
        return Result.fail(budget.failure)
      }
      const routed = routeNodeArrival(kernel, services, state, flowToken, journal)
      if (Result.isFailure(routed)) {
        return routed
      }
      progressed = true
      continue
    }
    const satisfiedFrame = state.gatewayFrames.find((frame) => frame.status === "satisfied")
    if (satisfiedFrame !== undefined) {
      const budget = consumeAutomaticTransition()
      if (Result.isFailure(budget)) {
        return Result.fail(budget.failure)
      }
      const fired = fireSatisfiedFrame(kernel, services, state, satisfiedFrame, journal)
      if (Result.isFailure(fired)) {
        return fired
      }
      progressed = true
      continue
    }
    const completedScope = tryCompleteScopes(kernel, services, state, journal)
    if (Result.isFailure(completedScope)) {
      return Result.fail(completedScope.failure)
    }
    if (completedScope.success) {
      const budget = consumeAutomaticTransition()
      if (Result.isFailure(budget)) {
        return Result.fail(budget.failure)
      }
    }
    progressed = completedScope.success
  }
  return Result.succeed(undefined)
}

interface ExpectedEmission {
  readonly processId: string
  readonly scopeInstanceId: string
  readonly invocation: BpmnExecutionState.InvocationIdentity
  readonly position: BpmnExecutionState.TokenPosition
  readonly createdAt?: ProtocolV2Wire.Timestamp
}

interface PendingRoute {
  readonly sourceNode: BpmnModel.Task | BpmnModel.SubProcess | BpmnModel.Gateway
  readonly scopeInstanceId: string
  readonly routingKind: "activity" | "exclusive-gateway"
  readonly routedAt: ProtocolV2Wire.Timestamp
  readonly evaluations: Map<string, boolean>
}

interface PendingScopeEntry {
  readonly definitionId: string
  readonly processId: string
  readonly parentScopeInstanceId: string
  readonly invocation: BpmnExecutionState.InvocationIdentity
  readonly enteredAt: ProtocolV2Wire.Timestamp
}

interface PendingGatewayArrival {
  readonly gateway: BpmnModel.Gateway
  readonly sequenceFlowId: string
  readonly scopeInstanceId: string
  readonly activationId: string
  readonly expectedFrameId: string
  readonly expectedJoinEpoch: number
  frameOpened: boolean
}

interface PendingTaskWait {
  readonly tokenId: string
  readonly taskNodeId: string
  readonly scopeInstanceId: string
  readonly enteredAt: ProtocolV2Wire.Timestamp
}

interface PendingResolvedTask {
  readonly resolution: BpmnActivityV3.ActivityResolution
  readonly kind: "Succeeded" | "Caught"
  readonly boundary?: BpmnModel.BoundaryEvent | undefined
  readonly errorRef?: string | undefined
}

interface PendingBoundaryErrorCatch {
  readonly resolution: BpmnActivityV3.ActivityResolution
  readonly boundary: BpmnModel.BoundaryEvent
  readonly errorRef: string
}

type PendingLoopTransition =
  | {
    readonly kind: "open"
    readonly activity: BpmnModel.Task
    readonly scopeInstanceId: string
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "condition"
    readonly activity: BpmnModel.Task
    readonly frameId: string
    readonly phase: "before" | "after"
    readonly iteration: number
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "iteration-start"
    readonly activity: BpmnModel.Task
    readonly frameId: string
    readonly iteration: number
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "iteration-complete"
    readonly activity: BpmnModel.Task
    readonly frameId: string
    readonly iteration: number
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "complete"
    readonly activity: BpmnModel.Task
    readonly frameId: string
    readonly reason: "condition-false" | "maximum-reached"
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "cancel-before-boundary"
    readonly activity: BpmnModel.Task
    readonly frameId: string
    readonly sourceTokenId: string
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }

type PendingMultiInstanceTransition =
  | {
    readonly kind: "cardinality"
    readonly activity: BpmnModel.Task
    readonly scopeInstanceId: string
    readonly groupId: string
    readonly activation: number
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "collection"
    readonly activity: BpmnModel.Task
    readonly scopeInstanceId: string
    readonly groupId: string
    readonly activation: number
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "open"
    readonly activity: BpmnModel.Task
    readonly scopeInstanceId: string
    readonly groupId: string
    readonly activation: number
    readonly source: BpmnExecutionState.MultiInstanceSource
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "start-items"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly itemIndexes: Array<number>
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "complete-item"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly itemIndex: number
    readonly itemKey: string
    readonly output?: Schema.Json | undefined
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "completion-condition"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly itemIndex: number
    readonly itemKey: string
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "finish"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly reason: "all-completed" | "completion-condition" | "empty"
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "terminate-and-finish"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly tokenIds: Array<string>
    readonly itemIndexes: Array<number>
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }
  | {
    readonly kind: "cancel-before-boundary"
    readonly activity: BpmnModel.Task
    readonly groupId: string
    readonly sourceTokenId: string
    readonly tokenIds: Array<string>
    readonly itemIndexes: Array<number>
    readonly transitionedAt: ProtocolV2Wire.Timestamp
  }

interface PendingFailureCleanup {
  readonly resolution: BpmnActivityV3.ActivityResolution
  readonly failureKind: RootFailureKind
  readonly errorRef?: string | undefined
  readonly tokenIds: Array<string>
  readonly frameIds: Array<string>
  readonly loopFrameIds: Array<string>
  readonly multiInstanceGroups: Array<{
    readonly groupId: string
    readonly itemIndexes: Array<number>
  }>
  readonly interruptedScopeIds: Array<string>
  readonly failedScopeIds: Array<string>
  readonly rootScopeInstanceId: string
}

const samePosition = (
  left: BpmnExecutionState.TokenPosition,
  right: BpmnExecutionState.TokenPosition
): boolean =>
  left._tag === right._tag &&
  (left._tag === "AtNode"
    ? right._tag === "AtNode" && left.nodeId === right.nodeId
    : right._tag === "OnSequenceFlow" && left.sequenceFlowId === right.sequenceFlowId)

const sameStringArray = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index])

const sameExpression = (
  left: BpmnModel.Expression,
  right: BpmnModel.Expression
): boolean =>
  Json.canonicalizeSnapshot(left as unknown as Schema.Json) ===
    Json.canonicalizeSnapshot(right as unknown as Schema.Json)

const journalFailure = (
  index: number,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment> = [],
  details?: Schema.Json
): Result.Result<never, Diagnostic.CompilationError> =>
  Result.fail(compilationError(error(
    Codes.InvalidTransitionJournal,
    message,
    ["events", index, ...path],
    details
  )))

const emptyReplayState = (
  kernel: CompiledKernel,
  input: Schema.Json,
  startedAt: ProtocolV2Wire.Timestamp
): MutableState => ({
  stateKind: "BpmnExecutionState",
  stateVersion: BpmnExecutionState.BpmnExecutionStateVersion,
  model: directClone(kernel.modelReference),
  status: "active",
  input: directClone(input),
  startedAt,
  extensionElements: [],
  scopeInstances: [],
  tokens: [],
  activityResolutions: [],
  gatewayFrames: [],
  loopFrames: [],
  multiInstanceGroups: [],
  callFrames: [],
  subscriptions: [],
  timers: [],
  workItems: [],
  compensationRegistrations: [],
  cancellationRegions: []
})

const expectedCondition = (
  kernel: CompiledKernel,
  route: PendingRoute
): BpmnModel.SequenceFlow | undefined => {
  const ordered = kernel.orderedOutgoingByNodeId.get(route.sourceNode.id) ?? []
  if (route.routingKind === "activity") {
    return ordered
      .map((flowId) => kernel.flowById.get(flowId))
      .filter((flow): flow is BpmnModel.SequenceFlow => flow?.kind === "conditional")
      .find((flow) => !route.evaluations.has(flow.id))
  }
  for (const flowId of ordered) {
    const flow = kernel.flowById.get(flowId)
    if (flow === undefined || flow.kind === "default") {
      continue
    }
    if (flow.kind === "normal") {
      return undefined
    }
    const evaluated = route.evaluations.get(flow.id)
    if (evaluated === undefined) {
      return flow
    }
    if (evaluated) {
      return undefined
    }
  }
  return undefined
}

const expectedSelection = (
  kernel: CompiledKernel,
  route: PendingRoute
): ReadonlyArray<string> | undefined => {
  if (expectedCondition(kernel, route) !== undefined) {
    return undefined
  }
  const ordered = kernel.orderedOutgoingByNodeId.get(route.sourceNode.id) ?? []
  let defaultFlowId: string | undefined = undefined
  if (route.routingKind === "activity") {
    const selected: Array<string> = []
    for (const flowId of ordered) {
      const flow = kernel.flowById.get(flowId)
      if (flow === undefined) {
        continue
      }
      if (flow.kind === "default") {
        defaultFlowId = flow.id
      } else if (flow.kind === "normal" || route.evaluations.get(flow.id) === true) {
        selected.push(flow.id)
      }
    }
    return selected.length > 0
      ? selected
      : defaultFlowId === undefined
      ? []
      : [defaultFlowId]
  }
  for (const flowId of ordered) {
    const flow = kernel.flowById.get(flowId)
    if (flow === undefined) {
      continue
    }
    if (flow.kind === "default") {
      defaultFlowId = flow.id
      continue
    }
    if (flow.kind === "normal" || route.evaluations.get(flow.id) === true) {
      return [flow.id]
    }
  }
  return defaultFlowId === undefined ? undefined : [defaultFlowId]
}

const replayJournal = (
  kernel: CompiledKernel,
  events: TransitionJournal
): Result.Result<BpmnExecutionState.BpmnExecutionState, Diagnostic.CompilationError> => {
  const header = events[0]
  if (
    header === undefined ||
    header._tag !== "JournalStarted" ||
    header.journalVersion !== TransitionJournalVersion
  ) {
    return journalFailure(
      0,
      "A transition journal must begin with its versioned model-binding header"
    )
  }
  if (!sameModelReference(header.model, kernel.modelReference)) {
    return Result.fail(compilationError(error(
      Codes.BpmnJournalModelMismatch,
      "Transition-journal model reference does not match the prepared token kernel",
      ["events", 0, "model"],
      {
        expectedExecutableFingerprint: kernel.modelReference.executableFingerprint,
        actualExecutableFingerprint: header.model.executableFingerprint
      }
    )))
  }
  const first = events[1]
  if (
    first === undefined ||
    first._tag !== "ScopeEntered" ||
    first.definitionId !== kernel.rootProcessId ||
    first.processId !== kernel.rootProcessId ||
    first.parentScopeInstanceId !== undefined ||
    first.enteredAt !== header.startedAt
  ) {
    return journalFailure(
      1,
      `A transition journal must begin by entering root process '${kernel.rootProcessId}'`
    )
  }

  const measuredInput = canonicalUtf8Bytes(header.input)
  if (
    Result.isFailure(measuredInput) ||
    measuredInput.success !== header.inputCanonicalBytes ||
    measuredInput.success >
      kernel.limits.maxExecutionInputCanonicalBytes
  ) {
    return journalFailure(
      0,
      "Transition-journal execution input has invalid canonical-byte evidence"
    )
  }
  const state = emptyReplayState(
    kernel,
    header.input,
    header.startedAt
  )
  let pendingEmissions: Array<ExpectedEmission> = []
  let pendingRoute: PendingRoute | undefined
  let pendingScopeEntry: PendingScopeEntry | undefined
  let pendingGatewayArrival: PendingGatewayArrival | undefined
  let pendingTaskWait: PendingTaskWait | undefined
  let pendingResolvedTask: PendingResolvedTask | undefined
  let pendingBoundaryErrorCatch: PendingBoundaryErrorCatch | undefined
  let pendingLoopTransition: PendingLoopTransition | undefined
  let pendingMultiInstanceTransition: PendingMultiInstanceTransition | undefined
  let pendingFailureCleanup: PendingFailureCleanup | undefined
  let pendingExecutionCompletion: string | undefined
  let lastTimestamp = header.startedAt

  const queueFlowEmissions = (
    scope: MutableScopeInstance,
    flowIds: ReadonlyArray<string>,
    createdAt?: ProtocolV2Wire.Timestamp
  ): void => {
    pendingEmissions = flowIds.map((sequenceFlowId) => ({
      processId: scope.processId,
      scopeInstanceId: scope.scopeInstanceId,
      invocation: directClone(scope.invocation),
      position: { _tag: "OnSequenceFlow", sequenceFlowId },
      ...(createdAt === undefined ? undefined : { createdAt })
    }))
  }
  const expectedMemberClosureTag = (
    groupId: string,
    itemIndex: number | undefined
  ):
    | "MultiInstanceItemTerminated"
    | "MultiInstanceItemNotGenerated" =>
  {
    const group = state.multiInstanceGroups.find((candidate) => candidate.groupId === groupId)
    return itemIndex !== undefined &&
        group?.members[itemIndex]?.status === "pending"
      ? "MultiInstanceItemNotGenerated"
      : "MultiInstanceItemTerminated"
  }

  for (let index = 1; index < events.length; index++) {
    const event = events[index]!
    const eventTimestamp = event._tag === "ScopeEntered"
      ? event.enteredAt
      : event._tag === "TokenConsumed"
      ? event.consumedAt
      : event._tag === "TokenWithdrawn"
      ? event.withdrawnAt
      : event._tag === "TokenEmitted"
      ? event.createdAt
      : event._tag === "TaskWaiting"
      ? event.enteredAt
      : event._tag === "LoopOpened"
      ? event.openedAt
      : event._tag === "LoopIterationStarted"
      ? event.startedAt
      : event._tag === "LoopIterationCompleted"
      ? event.completedAt
      : event._tag === "LoopCompleted"
      ? event.completedAt
      : event._tag === "LoopFrameCancelled"
      ? event.cancelledAt
      : event._tag === "MultiInstanceGroupOpened"
      ? event.openedAt
      : event._tag === "MultiInstanceItemStarted"
      ? event.startedAt
      : event._tag === "MultiInstanceItemCompleted"
      ? event.completedAt
      : event._tag === "MultiInstanceItemTerminated"
      ? event.terminatedAt
      : event._tag === "MultiInstanceItemNotGenerated"
      ? event.notGeneratedAt
      : event._tag === "MultiInstanceGroupCompleted"
      ? event.completedAt
      : event._tag === "MultiInstanceGroupCancelled"
      ? event.cancelledAt
      : event._tag === "GatewayFired"
      ? event.firedAt
      : event._tag === "TaskCompletionReplayed"
      ? event.observedAt
      : event._tag === "TaskOutcomeAccepted"
      ? event.resolution.resolvedAt
      : event._tag === "TaskOutcomeReplayed"
      ? event.observedAt
      : event._tag === "BoundaryErrorCaught"
      ? event.caughtAt
      : event._tag === "GatewayFrameCancelled"
      ? event.cancelledAt
      : event._tag === "ScopeInterruptedByError"
      ? event.exitedAt
      : event._tag === "ScopeFailed"
      ? event.exitedAt
      : event._tag === "ScopeCompleted"
      ? event.exitedAt
      : event._tag === "ExecutionCompleted"
      ? event.completedAt
      : event._tag === "ExecutionFailed"
      ? event.failedAt
      : undefined
    if (eventTimestamp !== undefined) {
      if (eventTimestamp < lastTimestamp) {
        return journalFailure(index, "Transition timestamps must be monotonically non-decreasing")
      }
      lastTimestamp = eventTimestamp
    }

    if (pendingEmissions.length > 0 && event._tag !== "TokenEmitted") {
      return journalFailure(index, "The journal omitted or reordered a causally required token emission")
    }
    if (pendingTaskWait !== undefined && event._tag !== "TaskWaiting") {
      return journalFailure(index, "The journal omitted or reordered a causally required task wait")
    }
    if (pendingScopeEntry !== undefined && event._tag !== "ScopeEntered") {
      return journalFailure(index, "The journal omitted or reordered a causally required subprocess entry")
    }
    if (
      pendingGatewayArrival !== undefined &&
      (pendingGatewayArrival.frameOpened
        ? event._tag !== "GatewayArrivalRecorded"
        : event._tag !== "GatewayFrameOpened")
    ) {
      return journalFailure(index, "The journal omitted or reordered a causally required parallel-gateway arrival")
    }
    if (
      pendingRoute !== undefined &&
      event._tag !== "ConditionEvaluated" &&
      event._tag !== "OutgoingSelected"
    ) {
      return journalFailure(index, "The journal omitted or reordered a causally required routing decision")
    }
    if (pendingLoopTransition !== undefined) {
      const expectedTag = pendingLoopTransition.kind === "open"
        ? "LoopOpened"
        : pendingLoopTransition.kind === "condition"
        ? "LoopConditionEvaluated"
        : pendingLoopTransition.kind === "iteration-start"
        ? "LoopIterationStarted"
        : pendingLoopTransition.kind === "iteration-complete"
        ? "LoopIterationCompleted"
        : pendingLoopTransition.kind === "complete"
        ? "LoopCompleted"
        : "LoopFrameCancelled"
      if (event._tag !== expectedTag) {
        return journalFailure(index, "The journal omitted or reordered a causally required standard-loop transition")
      }
    }
    if (
      pendingMultiInstanceTransition !== undefined &&
      pendingEmissions.length === 0 &&
      pendingTaskWait === undefined
    ) {
      const pending = pendingMultiInstanceTransition
      const expectedTag = pending.kind === "cardinality"
        ? "MultiInstanceCardinalityEvaluated"
        : pending.kind === "collection"
        ? "MultiInstanceCollectionEvaluated"
        : pending.kind === "open"
        ? "MultiInstanceGroupOpened"
        : pending.kind === "start-items"
        ? "MultiInstanceItemStarted"
        : pending.kind === "complete-item"
        ? "MultiInstanceItemCompleted"
        : pending.kind === "completion-condition"
        ? "MultiInstanceCompletionConditionEvaluated"
        : pending.kind === "finish"
        ? "MultiInstanceGroupCompleted"
        : pending.tokenIds.length > 0
        ? "TokenWithdrawn"
        : pending.itemIndexes.length > 0
        ? expectedMemberClosureTag(
          pending.groupId,
          pending.itemIndexes[0]
        )
        : pending.kind === "terminate-and-finish"
        ? "MultiInstanceGroupCompleted"
        : "MultiInstanceGroupCancelled"
      if (event._tag !== expectedTag) {
        return journalFailure(index, "The journal omitted or reordered a causally required multi-instance transition")
      }
    }
    if (pendingExecutionCompletion !== undefined && event._tag !== "ExecutionCompleted") {
      return journalFailure(index, "Root-scope completion must be followed by execution completion")
    }
    if (
      pendingResolvedTask !== undefined &&
      event._tag !== (
          pendingResolvedTask.kind === "Succeeded"
            ? "TokenConsumed"
            : "TokenWithdrawn"
        )
    ) {
      return journalFailure(index, "A task outcome must be followed by its exact token transition")
    }
    if (
      pendingBoundaryErrorCatch !== undefined &&
      pendingLoopTransition?.kind !== "cancel-before-boundary" &&
      pendingMultiInstanceTransition?.kind !== "cancel-before-boundary" &&
      event._tag !== "BoundaryErrorCaught"
    ) {
      return journalFailure(index, "An interrupted failed task must be followed by its Boundary Error catch")
    }
    if (pendingFailureCleanup !== undefined) {
      const expectedTag = pendingFailureCleanup.tokenIds.length > 0
        ? "TokenWithdrawn"
        : pendingFailureCleanup.frameIds.length > 0
        ? "GatewayFrameCancelled"
        : pendingFailureCleanup.loopFrameIds.length > 0
        ? "LoopFrameCancelled"
        : pendingFailureCleanup.multiInstanceGroups.length > 0 &&
            pendingFailureCleanup.multiInstanceGroups[0]!.itemIndexes.length > 0
        ? expectedMemberClosureTag(
          pendingFailureCleanup.multiInstanceGroups[0]!.groupId,
          pendingFailureCleanup.multiInstanceGroups[0]!.itemIndexes[0]
        )
        : pendingFailureCleanup.multiInstanceGroups.length > 0
        ? "MultiInstanceGroupCancelled"
        : pendingFailureCleanup.interruptedScopeIds.length > 0
        ? "ScopeInterruptedByError"
        : pendingFailureCleanup.failedScopeIds.length > 0
        ? "ScopeFailed"
        : "ExecutionFailed"
      if (event._tag !== expectedTag) {
        return journalFailure(index, "Unmatched business failure cleanup was omitted or reordered")
      }
    }
    if (
      (state.status === "completed" || state.status === "failed") &&
      event._tag !== "TaskCompletionReplayed" &&
      event._tag !== "TaskOutcomeReplayed"
    ) {
      return journalFailure(index, "A terminal execution cannot accept further state-changing events")
    }

    switch (event._tag) {
      case "JournalStarted": {
        return journalFailure(index, "A transition journal may contain only one leading header")
      }

      case "ScopeEntered": {
        if (index > 1 && pendingScopeEntry === undefined) {
          return journalFailure(index, `Scope '${event.scopeInstanceId}' has no subprocess-entry cause`)
        }
        const expectedScopeInstanceId = nextId(
          state.scopeInstances.map((scope) => scope.scopeInstanceId),
          `scope:${event.definitionId}:`
        )
        if (event.scopeInstanceId !== expectedScopeInstanceId) {
          return journalFailure(index, `Scope instance id '${event.scopeInstanceId}' is not the deterministic next id`)
        }
        if (index === 1) {
          const expectedInvocation: BpmnExecutionState.InvocationIdentity = {
            activationId: `activation:${kernel.rootProcessId}:1`,
            generation: 1
          }
          if (!sameInvocation(event.invocation, expectedInvocation)) {
            return journalFailure(index, "Root-scope invocation identity is not kernel-generated")
          }
        } else {
          const expected = pendingScopeEntry!
          if (
            event.definitionId !== expected.definitionId ||
            event.processId !== expected.processId ||
            event.parentScopeInstanceId !== expected.parentScopeInstanceId ||
            event.enteredAt !== expected.enteredAt ||
            !sameInvocation(event.invocation, expected.invocation)
          ) {
            return journalFailure(index, `Subprocess scope entry '${event.scopeInstanceId}' does not match its cause`)
          }
        }
        const parent = event.parentScopeInstanceId === undefined
          ? undefined
          : findScope(state, event.parentScopeInstanceId)
        if (
          event.parentScopeInstanceId !== undefined &&
          (parent === undefined || parent.status !== "active")
        ) {
          return journalFailure(index, `Scope '${event.scopeInstanceId}' has no active parent scope`)
        }
        const scope: MutableScopeInstance = {
          scopeInstanceId: event.scopeInstanceId,
          definitionId: event.definitionId,
          processId: event.processId,
          ...(event.parentScopeInstanceId === undefined
            ? undefined
            : { parentScopeInstanceId: event.parentScopeInstanceId }),
          invocation: directClone(event.invocation),
          status: "active",
          enteredAt: event.enteredAt
        }
        state.scopeInstances.push(scope)
        pendingScopeEntry = undefined
        const startEventId = kernel.startEventIdByScopeId.get(scope.definitionId)
        const startEvent = startEventId === undefined ? undefined : kernel.nodeById.get(startEventId)
        if (startEvent === undefined || startEvent._tag !== "StartEvent") {
          return journalFailure(index, `Scope '${scope.definitionId}' has no compiled start event`)
        }
        queueFlowEmissions(
          scope,
          kernel.orderedOutgoingByNodeId.get(startEvent.id) ?? [],
          event.enteredAt
        )
        break
      }

      case "TokenEmitted": {
        if (pendingEmissions.length === 0) {
          return journalFailure(index, `Token '${event.tokenId}' has no emission cause`)
        }
        const expected = pendingEmissions.shift()!
        const expectedTokenId = nextId(state.tokens.map((token) => token.tokenId), "token:")
        if (
          event.tokenId !== expectedTokenId ||
          event.processId !== expected.processId ||
          event.scopeInstanceId !== expected.scopeInstanceId ||
          !sameInvocation(event.invocation, expected.invocation) ||
          !samePosition(event.position, expected.position) ||
          (expected.createdAt !== undefined && event.createdAt !== expected.createdAt)
        ) {
          return journalFailure(index, `Token emission '${event.tokenId}' does not match its causal transition`)
        }
        const scope = findScope(state, event.scopeInstanceId)
        if (scope === undefined || scope.status !== "active") {
          return journalFailure(index, `Token '${event.tokenId}' was emitted into a non-active scope`)
        }
        state.tokens.push({
          tokenId: event.tokenId,
          processId: event.processId,
          scopeInstanceId: event.scopeInstanceId,
          invocation: directClone(event.invocation),
          status: "active",
          position: directClone(event.position),
          createdAt: event.createdAt
        })
        if (event.position._tag === "AtNode") {
          pendingTaskWait = {
            tokenId: event.tokenId,
            taskNodeId: event.position.nodeId,
            scopeInstanceId: event.scopeInstanceId,
            enteredAt: event.createdAt
          }
        }
        break
      }

      case "TaskWaiting": {
        if (pendingTaskWait === undefined) {
          return journalFailure(index, `Task wait '${event.tokenId}' has no emitted task token cause`)
        }
        const expected = pendingTaskWait!
        if (
          event.tokenId !== expected.tokenId ||
          event.taskNodeId !== expected.taskNodeId ||
          event.scopeInstanceId !== expected.scopeInstanceId ||
          event.enteredAt !== expected.enteredAt
        ) {
          return journalFailure(index, `Task wait '${event.tokenId}' does not match its emitted token`)
        }
        const node = kernel.nodeById.get(event.taskNodeId)
        if (node?._tag !== "Task") {
          return journalFailure(index, `Task wait '${event.tokenId}' references a non-task node`)
        }
        pendingTaskWait = undefined
        break
      }

      case "LoopOpened": {
        const pending = pendingLoopTransition
        if (pending?.kind !== "open") {
          return journalFailure(
            index,
            `Loop frame '${event.frameId}' has no task-arrival cause`
          )
        }
        const scope = findScope(state, pending.scopeInstanceId)
        const characteristics = pending.activity.loopCharacteristics
        const expectedFrameId = nextId(
          state.loopFrames.map((frame) => frame.frameId),
          "loop-frame:"
        )
        const expectedActivation = nextLoopActivation(
          state as unknown as BpmnExecutionState.BpmnExecutionState,
          pending.activity.id,
          pending.scopeInstanceId
        )
        if (
          characteristics?._tag !== "StandardLoopCharacteristics" ||
          characteristics.condition === undefined ||
          characteristics.loopMaximum === undefined ||
          scope === undefined ||
          scope.status !== "active" ||
          event.frameId !== expectedFrameId ||
          event.activityId !== pending.activity.id ||
          event.processId !== pending.activity.processId ||
          event.scopeInstanceId !== pending.scopeInstanceId ||
          event.activation !== expectedActivation ||
          event.openedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Loop frame '${event.frameId}' does not match its deterministic task activation`
          )
        }
        state.loopFrames.push({
          frameId: event.frameId,
          activityId: event.activityId,
          processId: event.processId,
          scopeInstanceId: event.scopeInstanceId,
          activation: event.activation,
          completedIterations: 0,
          status: "active",
          openedAt: event.openedAt
        })
        pendingLoopTransition = characteristics.testBefore
          ? {
            kind: "condition",
            activity: pending.activity,
            frameId: event.frameId,
            phase: "before",
            iteration: 0,
            transitionedAt: event.openedAt
          }
          : {
            kind: "iteration-start",
            activity: pending.activity,
            frameId: event.frameId,
            iteration: 0,
            transitionedAt: event.openedAt
          }
        break
      }

      case "LoopConditionEvaluated": {
        const pending = pendingLoopTransition
        if (pending?.kind !== "condition") {
          return journalFailure(
            index,
            `Loop condition for '${event.frameId}' has no evaluation cause`
          )
        }
        const frame = state.loopFrames.find((candidate) => candidate.frameId === pending.frameId)
        const scope = frame === undefined
          ? undefined
          : findScope(state, frame.scopeInstanceId)
        const characteristics = pending.activity.loopCharacteristics
        const expression = characteristics?._tag ===
            "StandardLoopCharacteristics"
          ? characteristics.condition
          : undefined
        const expectedBinding = expression === undefined
          ? undefined
          : kernel.evaluatorBindings.find((binding) =>
            binding.language === expression.language &&
            binding.languageVersion === expression.version
          )
        if (
          frame === undefined ||
          frame.status !== "active" ||
          frame.activeIteration !== undefined ||
          scope === undefined ||
          expression === undefined ||
          expectedBinding === undefined ||
          event.frameId !== frame.frameId ||
          event.activityId !== pending.activity.id ||
          event.activation !== frame.activation ||
          event.phase !== pending.phase ||
          event.iteration !== pending.iteration ||
          !sameExpression(event.expression, expression) ||
          BpmnExpression.evaluatorBindingKey(event.evaluatorBinding) !==
            BpmnExpression.evaluatorBindingKey(expectedBinding)
        ) {
          return journalFailure(
            index,
            `Loop condition for frame '${event.frameId}' is out of order or invalid`
          )
        }
        const contextSnapshot = Json.snapshot({
          _tag: "StandardLoopCondition",
          expression,
          activity: pending.activity,
          loopFrame: frame,
          phase: pending.phase,
          iteration: pending.iteration,
          scopeInstance: scope,
          state
        })
        if (Result.isFailure(contextSnapshot)) {
          return journalFailure(
            index,
            `Loop condition for frame '${event.frameId}' has no canonical context`
          )
        }
        let sourceUtf8Bytes: number
        let contextCanonicalBytes: number
        try {
          sourceUtf8Bytes = new TextEncoder().encode(
            expression.source
          ).byteLength
          contextCanonicalBytes = new TextEncoder().encode(
            Json.canonicalizeSnapshot(contextSnapshot.success)
          ).byteLength
        } catch {
          return journalFailure(
            index,
            `Loop condition for frame '${event.frameId}' has invalid usage evidence`
          )
        }
        if (
          event.usage.sourceUtf8Bytes !== sourceUtf8Bytes ||
          event.usage.contextCanonicalBytes !== contextCanonicalBytes ||
          event.usage.steps > expectedBinding.limits.maxSteps ||
          sourceUtf8Bytes > expectedBinding.limits.maxSourceUtf8Bytes ||
          contextCanonicalBytes >
            expectedBinding.limits.maxContextCanonicalBytes
        ) {
          return journalFailure(
            index,
            `Loop condition for frame '${event.frameId}' has invalid usage evidence`
          )
        }
        pendingLoopTransition = event.result
          ? {
            kind: "iteration-start",
            activity: pending.activity,
            frameId: frame.frameId,
            iteration: frame.completedIterations,
            transitionedAt: pending.transitionedAt
          }
          : {
            kind: "complete",
            activity: pending.activity,
            frameId: frame.frameId,
            reason: "condition-false",
            transitionedAt: pending.transitionedAt
          }
        break
      }

      case "LoopIterationStarted": {
        const pending = pendingLoopTransition
        if (pending?.kind !== "iteration-start") {
          return journalFailure(
            index,
            `Loop iteration '${event.frameId}:${event.iteration}' has no start cause`
          )
        }
        const frame = state.loopFrames.find((candidate) => candidate.frameId === pending.frameId)
        const scope = frame === undefined
          ? undefined
          : findScope(state, frame.scopeInstanceId)
        const characteristics = pending.activity.loopCharacteristics
        if (
          frame === undefined ||
          frame.status !== "active" ||
          frame.activeIteration !== undefined ||
          scope === undefined ||
          scope.status !== "active" ||
          characteristics?._tag !== "StandardLoopCharacteristics" ||
          characteristics.loopMaximum === undefined ||
          pending.iteration !== frame.completedIterations ||
          pending.iteration >= characteristics.loopMaximum ||
          event.frameId !== frame.frameId ||
          event.activityId !== pending.activity.id ||
          event.activation !== frame.activation ||
          event.iteration !== pending.iteration ||
          event.startedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Loop iteration '${event.frameId}:${event.iteration}' is not the deterministic next iteration`
          )
        }
        frame.activeIteration = event.iteration
        pendingLoopTransition = undefined
        pendingEmissions = [{
          processId: scope.processId,
          scopeInstanceId: scope.scopeInstanceId,
          invocation: {
            activationId: scope.invocation.activationId,
            branch: {
              _tag: "StandardLoopIteration",
              frameId: frame.frameId,
              iteration: event.iteration
            },
            generation: scope.invocation.generation
          },
          position: {
            _tag: "AtNode",
            nodeId: pending.activity.id
          },
          createdAt: event.startedAt
        }]
        break
      }

      case "LoopIterationCompleted": {
        const pending = pendingLoopTransition
        if (pending?.kind !== "iteration-complete") {
          return journalFailure(
            index,
            `Loop iteration completion '${event.frameId}:${event.iteration}' has no completed task cause`
          )
        }
        const frame = state.loopFrames.find((candidate) => candidate.frameId === pending.frameId)
        const characteristics = pending.activity.loopCharacteristics
        if (
          frame === undefined ||
          frame.status !== "active" ||
          frame.activeIteration !== pending.iteration ||
          characteristics?._tag !== "StandardLoopCharacteristics" ||
          characteristics.condition === undefined ||
          characteristics.loopMaximum === undefined ||
          event.frameId !== frame.frameId ||
          event.activityId !== pending.activity.id ||
          event.activation !== frame.activation ||
          event.iteration !== pending.iteration ||
          event.completedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Loop iteration completion '${event.frameId}:${event.iteration}' is invalid`
          )
        }
        delete frame.activeIteration
        frame.completedIterations++
        pendingLoopTransition = frame.completedIterations >= characteristics.loopMaximum
          ? {
            kind: "complete",
            activity: pending.activity,
            frameId: frame.frameId,
            reason: "maximum-reached",
            transitionedAt: event.completedAt
          }
          : {
            kind: "condition",
            activity: pending.activity,
            frameId: frame.frameId,
            phase: characteristics.testBefore ? "before" : "after",
            iteration: characteristics.testBefore
              ? frame.completedIterations
              : pending.iteration,
            transitionedAt: event.completedAt
          }
        break
      }

      case "LoopCompleted": {
        const pending = pendingLoopTransition
        if (pending?.kind !== "complete") {
          return journalFailure(
            index,
            `Loop completion '${event.frameId}' has no completion decision`
          )
        }
        const frame = state.loopFrames.find((candidate) => candidate.frameId === pending.frameId)
        const scope = frame === undefined
          ? undefined
          : findScope(state, frame.scopeInstanceId)
        if (
          frame === undefined ||
          frame.status !== "active" ||
          frame.activeIteration !== undefined ||
          scope === undefined ||
          scope.status !== "active" ||
          event.frameId !== frame.frameId ||
          event.activityId !== pending.activity.id ||
          event.activation !== frame.activation ||
          event.completedIterations !== frame.completedIterations ||
          event.reason !== pending.reason ||
          event.completedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Loop completion '${event.frameId}' is inconsistent with its decision`
          )
        }
        frame.status = "completed"
        frame.closedAt = event.completedAt
        pendingLoopTransition = undefined
        pendingRoute = {
          sourceNode: pending.activity,
          scopeInstanceId: scope.scopeInstanceId,
          routingKind: "activity",
          routedAt: event.completedAt,
          evaluations: new Map()
        }
        break
      }

      case "MultiInstanceCardinalityEvaluated": {
        const pending = pendingMultiInstanceTransition
        if (pending?.kind !== "cardinality") {
          return journalFailure(
            index,
            `Multi-instance cardinality for '${event.groupId}' has no task-arrival cause`
          )
        }
        const characteristics = pending.activity.loopCharacteristics
        const expression = characteristics?._tag === "MultiInstanceCharacteristics"
          ? characteristics.cardinality
          : undefined
        const scope = findScope(state, pending.scopeInstanceId)
        const expectedBinding = expression === undefined
          ? undefined
          : kernel.evaluatorBindings.find((binding) =>
            binding.language === expression.language &&
            binding.languageVersion === expression.version
          )
        if (
          expression === undefined ||
          scope === undefined ||
          scope.status !== "active" ||
          expectedBinding === undefined ||
          event.groupId !== pending.groupId ||
          event.activityId !== pending.activity.id ||
          event.activation !== pending.activation ||
          event.cardinality > kernel.limits.maxMultiInstanceCardinality ||
          !sameExpression(event.expression, expression) ||
          BpmnExpression.evaluatorBindingKey(event.evaluatorBinding) !==
            BpmnExpression.evaluatorBindingKey(expectedBinding)
        ) {
          return journalFailure(
            index,
            `Multi-instance cardinality for '${event.groupId}' is out of order or invalid`
          )
        }
        const contextSnapshot = Json.snapshot({
          _tag: "MultiInstanceCardinality",
          expression,
          activity: pending.activity,
          groupId: pending.groupId,
          groupActivation: pending.activation,
          scopeInstance: scope,
          state
        })
        if (Result.isFailure(contextSnapshot)) {
          return journalFailure(index, `Multi-instance cardinality for '${event.groupId}' has no canonical context`)
        }
        let sourceUtf8Bytes: number
        let contextCanonicalBytes: number
        try {
          sourceUtf8Bytes = new TextEncoder().encode(expression.source).byteLength
          contextCanonicalBytes = new TextEncoder().encode(
            Json.canonicalizeSnapshot(contextSnapshot.success)
          ).byteLength
        } catch {
          return journalFailure(index, `Multi-instance cardinality for '${event.groupId}' has invalid usage evidence`)
        }
        if (
          event.usage.sourceUtf8Bytes !== sourceUtf8Bytes ||
          event.usage.contextCanonicalBytes !== contextCanonicalBytes ||
          event.usage.steps > expectedBinding.limits.maxSteps ||
          sourceUtf8Bytes > expectedBinding.limits.maxSourceUtf8Bytes ||
          contextCanonicalBytes > expectedBinding.limits.maxContextCanonicalBytes
        ) {
          return journalFailure(index, `Multi-instance cardinality for '${event.groupId}' has invalid usage evidence`)
        }
        pendingMultiInstanceTransition = {
          kind: "open",
          activity: pending.activity,
          scopeInstanceId: pending.scopeInstanceId,
          groupId: pending.groupId,
          activation: pending.activation,
          source: {
            _tag: "Cardinality",
            value: event.cardinality
          },
          transitionedAt: pending.transitionedAt
        }
        break
      }

      case "MultiInstanceCollectionEvaluated": {
        const pending = pendingMultiInstanceTransition
        if (pending?.kind !== "collection") {
          return journalFailure(
            index,
            `Multi-instance collection for '${event.groupId}' has no task-arrival cause`
          )
        }
        const characteristics = pending.activity.loopCharacteristics
        const dataInputRef = characteristics?._tag === "MultiInstanceCharacteristics"
          ? characteristics.loopDataInputRef
          : undefined
        const binding = kernel.collectionBindingByTaskNodeId.get(
          pending.activity.id
        )
        const expression = binding?.collectionExpression
        const scope = findScope(state, pending.scopeInstanceId)
        const expectedBinding = expression === undefined
          ? undefined
          : kernel.evaluatorBindings.find((candidate) =>
            candidate.language === expression.language &&
            candidate.languageVersion === expression.version
          )
        if (
          dataInputRef === undefined ||
          binding === undefined ||
          expression === undefined ||
          scope === undefined ||
          scope.status !== "active" ||
          expectedBinding === undefined ||
          event.groupId !== pending.groupId ||
          event.activityId !== pending.activity.id ||
          event.activation !== pending.activation ||
          event.dataInputRef !== dataInputRef ||
          event.items.length >
            kernel.limits.maxMultiInstanceCardinality ||
          event.itemCanonicalBytes.length !== event.items.length ||
          !sameExpression(event.expression, expression) ||
          BpmnExpression.evaluatorBindingKey(event.evaluatorBinding) !==
            BpmnExpression.evaluatorBindingKey(expectedBinding)
        ) {
          return journalFailure(
            index,
            `Multi-instance collection for '${event.groupId}' is out of order or invalid`
          )
        }
        const contextSnapshot = Json.snapshot({
          _tag: "MultiInstanceCollection",
          expression,
          activity: pending.activity,
          groupId: pending.groupId,
          groupActivation: pending.activation,
          dataInputRef,
          scopeInstance: scope,
          state
        })
        if (Result.isFailure(contextSnapshot)) {
          return journalFailure(
            index,
            `Multi-instance collection for '${event.groupId}' has no canonical context`
          )
        }
        let sourceUtf8Bytes: number
        let contextCanonicalBytes: number
        try {
          sourceUtf8Bytes = new TextEncoder().encode(expression.source).byteLength
          contextCanonicalBytes = new TextEncoder().encode(
            Json.canonicalizeSnapshot(contextSnapshot.success)
          ).byteLength
        } catch {
          return journalFailure(
            index,
            `Multi-instance collection for '${event.groupId}' has invalid usage evidence`
          )
        }
        const collectionBytes = canonicalUtf8Bytes(
          event.items as Schema.Json
        )
        const itemBytes = event.items.map((item) => canonicalUtf8Bytes(item))
        if (
          event.usage.sourceUtf8Bytes !== sourceUtf8Bytes ||
          event.usage.contextCanonicalBytes !== contextCanonicalBytes ||
          event.usage.steps > expectedBinding.limits.maxSteps ||
          sourceUtf8Bytes > expectedBinding.limits.maxSourceUtf8Bytes ||
          contextCanonicalBytes >
            expectedBinding.limits.maxContextCanonicalBytes ||
          Result.isFailure(collectionBytes) ||
          collectionBytes.success !== event.collectionCanonicalBytes ||
          collectionBytes.success >
            kernel.limits.maxMultiInstanceCollectionCanonicalBytes ||
          itemBytes.some(Result.isFailure) ||
          itemBytes.some((measured, itemIndex) =>
            Result.isSuccess(measured) &&
            (
              measured.success !==
                event.itemCanonicalBytes[itemIndex] ||
              measured.success >
                kernel.limits.maxMultiInstanceItemCanonicalBytes
            )
          )
        ) {
          return journalFailure(
            index,
            `Multi-instance collection for '${event.groupId}' has invalid usage or size evidence`
          )
        }
        pendingMultiInstanceTransition = {
          kind: "open",
          activity: pending.activity,
          scopeInstanceId: pending.scopeInstanceId,
          groupId: pending.groupId,
          activation: pending.activation,
          source: {
            _tag: "Collection",
            dataInputRef,
            items: directClone(event.items)
          },
          transitionedAt: pending.transitionedAt
        }
        break
      }

      case "MultiInstanceGroupOpened": {
        const pending = pendingMultiInstanceTransition
        if (pending?.kind !== "open") {
          return journalFailure(
            index,
            `Multi-instance group '${event.groupId}' has no cardinality decision`
          )
        }
        const characteristics = pending.activity.loopCharacteristics
        const scope = findScope(state, pending.scopeInstanceId)
        const cardinality = pending.source._tag === "Cardinality"
          ? pending.source.value
          : pending.source.items.length
        const expectedKeys = Array.from(
          { length: cardinality },
          (_, itemIndex) => `item:${itemIndex}`
        )
        if (
          characteristics?._tag !== "MultiInstanceCharacteristics" ||
          scope === undefined ||
          scope.status !== "active" ||
          event.groupId !== pending.groupId ||
          event.activityId !== pending.activity.id ||
          event.processId !== pending.activity.processId ||
          event.scopeInstanceId !== pending.scopeInstanceId ||
          event.activation !== pending.activation ||
          event.mode !== characteristics.mode ||
          !sameJson(event.source, pending.source) ||
          !sameStringArray(event.itemKeys, expectedKeys) ||
          event.openedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Multi-instance group '${event.groupId}' does not match its fixed activation`
          )
        }
        const members: Array<MutableMultiInstanceMember> = expectedKeys.map(
          (itemKey, itemIndex) => ({
            index: itemIndex,
            itemKey,
            status: "pending"
          })
        )
        state.multiInstanceGroups.push({
          groupId: event.groupId,
          activityId: event.activityId,
          processId: event.processId,
          scopeInstanceId: event.scopeInstanceId,
          activation: event.activation,
          mode: event.mode,
          source: directClone(event.source),
          members,
          completedInstanceCount: 0,
          status: "active",
          openedAt: event.openedAt
        })
        pendingMultiInstanceTransition = cardinality === 0
          ? {
            kind: "finish",
            activity: pending.activity,
            groupId: event.groupId,
            reason: "empty",
            transitionedAt: event.openedAt
          }
          : {
            kind: "start-items",
            activity: pending.activity,
            groupId: event.groupId,
            itemIndexes: event.mode === "parallel"
              ? expectedKeys.map((_, itemIndex) => itemIndex)
              : [0],
            transitionedAt: event.openedAt
          }
        break
      }

      case "MultiInstanceItemStarted": {
        const pending = pendingMultiInstanceTransition
        if (pending?.kind !== "start-items") {
          return journalFailure(
            index,
            `Multi-instance item '${event.groupId}:${event.itemIndex}' has no generation cause`
          )
        }
        const group = state.multiInstanceGroups.find((candidate) => candidate.groupId === pending.groupId)
        const scope = group === undefined ? undefined : findScope(state, group.scopeInstanceId)
        const expectedIndex = pending.itemIndexes[0]
        const member = expectedIndex === undefined
          ? undefined
          : group?.members[expectedIndex]
        if (
          group === undefined ||
          group.status !== "active" ||
          scope === undefined ||
          scope.status !== "active" ||
          expectedIndex === undefined ||
          member === undefined ||
          member.status !== "pending" ||
          event.groupId !== group.groupId ||
          event.activityId !== pending.activity.id ||
          event.activation !== group.activation ||
          event.itemIndex !== expectedIndex ||
          event.itemKey !== member.itemKey ||
          event.startedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Multi-instance item '${event.groupId}:${event.itemIndex}' is not the deterministic next member`
          )
        }
        const tokenId = nextId(state.tokens.map((token) => token.tokenId), "token:")
        member.status = "active"
        member.tokenId = tokenId
        member.startedAt = event.startedAt
        pending.itemIndexes.shift()
        pendingMultiInstanceTransition = pending.itemIndexes.length === 0
          ? undefined
          : pending
        pendingEmissions = [{
          processId: scope.processId,
          scopeInstanceId: scope.scopeInstanceId,
          invocation: {
            activationId: scope.invocation.activationId,
            branch: {
              _tag: "MultiInstanceItem",
              groupId: group.groupId,
              itemIndex: member.index,
              itemKey: member.itemKey
            },
            generation: scope.invocation.generation
          },
          position: {
            _tag: "AtNode",
            nodeId: pending.activity.id
          },
          createdAt: event.startedAt
        }]
        break
      }

      case "MultiInstanceItemCompleted": {
        const pending = pendingMultiInstanceTransition
        if (pending?.kind !== "complete-item") {
          return journalFailure(
            index,
            `Multi-instance item completion '${event.groupId}:${event.itemIndex}' has no completed task cause`
          )
        }
        const group = state.multiInstanceGroups.find((candidate) => candidate.groupId === pending.groupId)
        const member = group?.members[pending.itemIndex]
        const characteristics = pending.activity.loopCharacteristics
        if (
          group === undefined ||
          group.status !== "active" ||
          member === undefined ||
          member.status !== "active" ||
          characteristics?._tag !== "MultiInstanceCharacteristics" ||
          event.groupId !== group.groupId ||
          event.activityId !== pending.activity.id ||
          event.activation !== group.activation ||
          event.itemIndex !== pending.itemIndex ||
          event.itemKey !== pending.itemKey ||
          !(
            event.output === undefined &&
              pending.output === undefined ||
            event.output !== undefined &&
              pending.output !== undefined &&
              sameJson(event.output, pending.output)
          ) ||
          event.completedAt !== pending.transitionedAt
        ) {
          return journalFailure(
            index,
            `Multi-instance item completion '${event.groupId}:${event.itemIndex}' is invalid`
          )
        }
        member.status = "completed"
        member.endedAt = event.completedAt
        if (event.output !== undefined) {
          const measuredOutput = canonicalUtf8Bytes(event.output)
          if (
            Result.isFailure(measuredOutput) ||
            measuredOutput.success >
              kernel.limits.maxMultiInstanceItemOutputCanonicalBytes
          ) {
            return journalFailure(
              index,
              `Multi-instance item completion '${event.groupId}:${event.itemIndex}' has an invalid output`
            )
          }
          member.output = directClone(event.output)
        }
        group.completedInstanceCount++
        if (!sameJson(event.counters, multiInstanceCounters(group))) {
          return journalFailure(
            index,
            `Multi-instance item completion '${event.groupId}:${event.itemIndex}' has invalid counters`
          )
        }
        if (characteristics.completionCondition !== undefined) {
          pendingMultiInstanceTransition = {
            kind: "completion-condition",
            activity: pending.activity,
            groupId: group.groupId,
            itemIndex: member.index,
            itemKey: member.itemKey,
            transitionedAt: event.completedAt
          }
        } else if (group.completedInstanceCount === group.members.length) {
          pendingMultiInstanceTransition = {
            kind: "finish",
            activity: pending.activity,
            groupId: group.groupId,
            reason: "all-completed",
            transitionedAt: event.completedAt
          }
        } else if (group.mode === "sequential") {
          const next = group.members.find((candidate) => candidate.status === "pending")
          if (next === undefined) {
            return journalFailure(index, `Sequential group '${group.groupId}' has no next member`)
          }
          pendingMultiInstanceTransition = {
            kind: "start-items",
            activity: pending.activity,
            groupId: group.groupId,
            itemIndexes: [next.index],
            transitionedAt: event.completedAt
          }
        } else {
          pendingMultiInstanceTransition = undefined
        }
        break
      }

      case "MultiInstanceCompletionConditionEvaluated": {
        const pending = pendingMultiInstanceTransition
        if (pending?.kind !== "completion-condition") {
          return journalFailure(
            index,
            `Multi-instance completion condition '${event.groupId}:${event.itemIndex}' has no member-completion cause`
          )
        }
        const group = state.multiInstanceGroups.find((candidate) => candidate.groupId === pending.groupId)
        const scope = group === undefined ? undefined : findScope(state, group.scopeInstanceId)
        const member = group?.members[pending.itemIndex]
        const characteristics = pending.activity.loopCharacteristics
        const expression = characteristics?._tag === "MultiInstanceCharacteristics"
          ? characteristics.completionCondition
          : undefined
        const expectedBinding = expression === undefined
          ? undefined
          : kernel.evaluatorBindings.find((binding) =>
            binding.language === expression.language &&
            binding.languageVersion === expression.version
          )
        if (
          group === undefined ||
          group.status !== "active" ||
          scope === undefined ||
          member === undefined ||
          member.status !== "completed" ||
          expression === undefined ||
          expectedBinding === undefined ||
          event.groupId !== group.groupId ||
          event.activityId !== pending.activity.id ||
          event.activation !== group.activation ||
          event.itemIndex !== member.index ||
          event.itemKey !== member.itemKey ||
          !sameJson(event.counters, multiInstanceCounters(group)) ||
          !sameExpression(event.expression, expression) ||
          BpmnExpression.evaluatorBindingKey(event.evaluatorBinding) !==
            BpmnExpression.evaluatorBindingKey(expectedBinding)
        ) {
          return journalFailure(
            index,
            `Multi-instance completion condition '${event.groupId}:${event.itemIndex}' is invalid`
          )
        }
        const contextSnapshot = Json.snapshot({
          _tag: "MultiInstanceCompletionCondition",
          expression,
          activity: pending.activity,
          multiInstanceGroup: group,
          completedMember: member,
          runtime: {
            loopCounter: member.index,
            ...multiInstanceCounters(group)
          },
          scopeInstance: scope,
          state
        })
        if (Result.isFailure(contextSnapshot)) {
          return journalFailure(
            index,
            `Multi-instance completion condition '${event.groupId}:${event.itemIndex}' has no canonical context`
          )
        }
        let sourceUtf8Bytes: number
        let contextCanonicalBytes: number
        try {
          sourceUtf8Bytes = new TextEncoder().encode(expression.source).byteLength
          contextCanonicalBytes = new TextEncoder().encode(
            Json.canonicalizeSnapshot(contextSnapshot.success)
          ).byteLength
        } catch {
          return journalFailure(
            index,
            `Multi-instance completion condition '${event.groupId}:${event.itemIndex}' has invalid usage evidence`
          )
        }
        if (
          event.usage.sourceUtf8Bytes !== sourceUtf8Bytes ||
          event.usage.contextCanonicalBytes !== contextCanonicalBytes ||
          event.usage.steps > expectedBinding.limits.maxSteps ||
          sourceUtf8Bytes > expectedBinding.limits.maxSourceUtf8Bytes ||
          contextCanonicalBytes > expectedBinding.limits.maxContextCanonicalBytes
        ) {
          return journalFailure(
            index,
            `Multi-instance completion condition '${event.groupId}:${event.itemIndex}' has invalid usage evidence`
          )
        }
        if (event.result) {
          const remaining = group.members.filter((candidate) =>
            candidate.status === "active" || candidate.status === "pending"
          )
          pendingMultiInstanceTransition = {
            kind: "terminate-and-finish",
            activity: pending.activity,
            groupId: group.groupId,
            tokenIds: remaining.flatMap((candidate) => {
              if (candidate.tokenId === undefined) {
                return []
              }
              const token = state.tokens.find((entry) => entry.tokenId === candidate.tokenId)
              return token?.status === "active" ? [token.tokenId] : []
            }),
            itemIndexes: remaining.map((candidate) => candidate.index),
            transitionedAt: pending.transitionedAt
          }
        } else if (group.completedInstanceCount === group.members.length) {
          pendingMultiInstanceTransition = {
            kind: "finish",
            activity: pending.activity,
            groupId: group.groupId,
            reason: "all-completed",
            transitionedAt: pending.transitionedAt
          }
        } else if (group.mode === "sequential") {
          const next = group.members.find((candidate) => candidate.status === "pending")
          if (next === undefined) {
            return journalFailure(index, `Sequential group '${group.groupId}' has no next member`)
          }
          pendingMultiInstanceTransition = {
            kind: "start-items",
            activity: pending.activity,
            groupId: group.groupId,
            itemIndexes: [next.index],
            transitionedAt: pending.transitionedAt
          }
        } else {
          pendingMultiInstanceTransition = undefined
        }
        break
      }

      case "MultiInstanceItemTerminated": {
        const pending = pendingMultiInstanceTransition
        const cleanup = pendingFailureCleanup
        const pendingGroup = pending?.kind === "terminate-and-finish" ||
            pending?.kind === "cancel-before-boundary"
          ? pending
          : undefined
        const cleanupGroup = cleanup?.multiInstanceGroups[0]
        const groupId = pendingGroup?.groupId ?? cleanupGroup?.groupId
        const group = groupId === undefined
          ? undefined
          : state.multiInstanceGroups.find((candidate) => candidate.groupId === groupId)
        const expectedIndex = pendingGroup?.itemIndexes[0] ??
          cleanupGroup?.itemIndexes[0]
        const member = expectedIndex === undefined ? undefined : group?.members[expectedIndex]
        const expectedReason: MultiInstanceClosureReason | undefined = pendingGroup?.kind === "terminate-and-finish"
          ? "completion-condition"
          : pendingGroup?.kind === "cancel-before-boundary"
          ? "boundary-error-caught"
          : cleanup?.failureKind === "UncaughtBpmnError"
          ? "uncaught-bpmn-error"
          : cleanup === undefined
          ? undefined
          : "unmapped-business-failure"
        const token = member?.tokenId === undefined
          ? undefined
          : state.tokens.find((candidate) => candidate.tokenId === member.tokenId)
        if (
          group === undefined ||
          group.status !== "active" ||
          expectedIndex === undefined ||
          member === undefined ||
          member.status !== "active" ||
          token?.status === "active" ||
          event.groupId !== group.groupId ||
          event.activityId !== group.activityId ||
          event.activation !== group.activation ||
          event.itemIndex !== member.index ||
          event.itemKey !== member.itemKey ||
          event.reason !== expectedReason ||
          event.terminatedAt !== (
              pendingGroup?.transitionedAt ?? cleanup?.resolution.resolvedAt
            )
        ) {
          return journalFailure(
            index,
            `Multi-instance termination '${event.groupId}:${event.itemIndex}' is not causally authorized`
          )
        }
        member.status = "terminated"
        member.terminationReason = event.reason
        if (member.startedAt !== undefined) {
          member.endedAt = event.terminatedAt
        }
        if (pendingGroup !== undefined) {
          pendingGroup.itemIndexes.shift()
        } else {
          cleanupGroup!.itemIndexes.shift()
        }
        break
      }

      case "MultiInstanceItemNotGenerated": {
        const pending = pendingMultiInstanceTransition
        const cleanup = pendingFailureCleanup
        const pendingGroup = pending?.kind === "terminate-and-finish" ||
            pending?.kind === "cancel-before-boundary"
          ? pending
          : undefined
        const cleanupGroup = cleanup?.multiInstanceGroups[0]
        const groupId = pendingGroup?.groupId ?? cleanupGroup?.groupId
        const group = groupId === undefined
          ? undefined
          : state.multiInstanceGroups.find((candidate) => candidate.groupId === groupId)
        const expectedIndex = pendingGroup?.itemIndexes[0] ??
          cleanupGroup?.itemIndexes[0]
        const member = expectedIndex === undefined
          ? undefined
          : group?.members[expectedIndex]
        const expectedReason:
          | MultiInstanceClosureReason
          | undefined = pendingGroup?.kind === "terminate-and-finish"
            ? "completion-condition"
            : pendingGroup?.kind === "cancel-before-boundary"
            ? "boundary-error-caught"
            : cleanup?.failureKind === "UncaughtBpmnError"
            ? "uncaught-bpmn-error"
            : cleanup === undefined
            ? undefined
            : "unmapped-business-failure"
        if (
          group === undefined ||
          group.status !== "active" ||
          expectedIndex === undefined ||
          member === undefined ||
          member.status !== "pending" ||
          member.tokenId !== undefined ||
          event.groupId !== group.groupId ||
          event.activityId !== group.activityId ||
          event.activation !== group.activation ||
          event.itemIndex !== member.index ||
          event.itemKey !== member.itemKey ||
          event.reason !== expectedReason ||
          event.notGeneratedAt !== (
              pendingGroup?.transitionedAt ??
                cleanup?.resolution.resolvedAt
            )
        ) {
          return journalFailure(
            index,
            `Multi-instance non-generation '${event.groupId}:${event.itemIndex}' is not causally authorized`
          )
        }
        member.status = "not-generated"
        member.nonGenerationReason = event.reason
        if (pendingGroup !== undefined) {
          pendingGroup.itemIndexes.shift()
        } else {
          cleanupGroup!.itemIndexes.shift()
        }
        break
      }

      case "MultiInstanceGroupCompleted": {
        const pending = pendingMultiInstanceTransition
        if (
          pending?.kind !== "finish" &&
          pending?.kind !== "terminate-and-finish"
        ) {
          return journalFailure(index, `Multi-instance completion '${event.groupId}' has no completion decision`)
        }
        const group = state.multiInstanceGroups.find((candidate) => candidate.groupId === pending.groupId)
        const scope = group === undefined ? undefined : findScope(state, group.scopeInstanceId)
        const expectedReason = pending.kind === "finish"
          ? pending.reason
          : "completion-condition"
        const characteristics = pending.activity.loopCharacteristics
        const dataOutputRef = characteristics?._tag === "MultiInstanceCharacteristics"
          ? characteristics.loopDataOutputRef
          : undefined
        const expectedOutput = dataOutputRef === undefined
          ? undefined
          : {
            dataOutputRef,
            items: group?.members.flatMap((member) => member.output === undefined ? [] : [member.output]) ?? []
          }
        if (
          group === undefined ||
          group.status !== "active" ||
          scope === undefined ||
          scope.status !== "active" ||
          (pending.kind === "terminate-and-finish" &&
            (pending.tokenIds.length > 0 || pending.itemIndexes.length > 0)) ||
          group.members.some((member) => member.status === "active" || member.status === "pending") ||
          event.groupId !== group.groupId ||
          event.activityId !== pending.activity.id ||
          event.activation !== group.activation ||
          !sameJson(event.counters, multiInstanceCounters(group)) ||
          !(
            event.output === undefined &&
              expectedOutput === undefined ||
            event.output !== undefined &&
              expectedOutput !== undefined &&
              expectedOutput.items.length === group.members.length &&
              sameJson(event.output, expectedOutput)
          ) ||
          event.reason !== expectedReason ||
          event.completedAt !== pending.transitionedAt
        ) {
          return journalFailure(index, `Multi-instance completion '${event.groupId}' is inconsistent`)
        }
        group.status = "completed"
        group.completionReason = event.reason
        group.closedAt = event.completedAt
        if (event.output !== undefined) {
          const measured = canonicalUtf8Bytes(
            event.output.items as Schema.Json
          )
          if (
            Result.isFailure(measured) ||
            measured.success >
              kernel.limits.maxMultiInstanceOutputCanonicalBytes
          ) {
            return journalFailure(
              index,
              `Multi-instance completion '${event.groupId}' has an oversized output collection`
            )
          }
          group.output = directClone(event.output)
        }
        pendingMultiInstanceTransition = undefined
        pendingRoute = {
          sourceNode: pending.activity,
          scopeInstanceId: group.scopeInstanceId,
          routingKind: "activity",
          routedAt: event.completedAt,
          evaluations: new Map()
        }
        break
      }

      case "MultiInstanceGroupCancelled": {
        const pending = pendingMultiInstanceTransition
        const cleanup = pendingFailureCleanup
        const boundaryPending = pending?.kind === "cancel-before-boundary"
          ? pending
          : undefined
        const cleanupGroup = cleanup?.multiInstanceGroups[0]
        const groupId = boundaryPending?.groupId ?? cleanupGroup?.groupId
        const group = groupId === undefined
          ? undefined
          : state.multiInstanceGroups.find((candidate) => candidate.groupId === groupId)
        const expectedReason: Exclude<MultiInstanceClosureReason, "completion-condition"> | undefined =
          boundaryPending !== undefined
            ? "boundary-error-caught"
            : cleanup?.failureKind === "UncaughtBpmnError"
            ? "uncaught-bpmn-error"
            : cleanup === undefined
            ? undefined
            : "unmapped-business-failure"
        if (
          group === undefined ||
          group.status !== "active" ||
          (boundaryPending !== undefined &&
            (boundaryPending.tokenIds.length > 0 || boundaryPending.itemIndexes.length > 0)) ||
          (cleanupGroup !== undefined && cleanupGroup.itemIndexes.length > 0) ||
          group.members.some((member) => member.status === "active" || member.status === "pending") ||
          event.groupId !== group.groupId ||
          event.activityId !== group.activityId ||
          event.activation !== group.activation ||
          event.sourceTokenId !== (
              boundaryPending?.sourceTokenId ?? cleanup?.resolution.tokenId
            ) ||
          !sameJson(event.counters, multiInstanceCounters(group)) ||
          event.reason !== expectedReason ||
          event.cancelledAt !== (
              boundaryPending?.transitionedAt ?? cleanup?.resolution.resolvedAt
            )
        ) {
          return journalFailure(index, `Multi-instance cancellation '${event.groupId}' is inconsistent`)
        }
        group.status = "cancelled"
        group.completionReason = event.reason
        group.closedAt = event.cancelledAt
        if (boundaryPending !== undefined) {
          pendingMultiInstanceTransition = undefined
        } else {
          cleanup!.multiInstanceGroups.shift()
        }
        break
      }

      case "TaskOutcomeAccepted": {
        const resolution = event.resolution
        const token = state.tokens.find((candidate) => candidate.tokenId === resolution.tokenId)
        const task = kernel.nodeById.get(resolution.taskNodeId)
        const binding = kernel.taskBindingByTaskNodeId.get(
          resolution.taskNodeId
        )
        if (
          token === undefined ||
          token.status !== "active" ||
          token.position._tag !== "AtNode" ||
          token.position.nodeId !== resolution.taskNodeId ||
          token.scopeInstanceId !== resolution.scopeInstanceId ||
          task?._tag !== "Task" ||
          binding === undefined ||
          !bindingMatchesOutcome(binding, resolution.outcome) ||
          resolution.resolvedAt < token.createdAt ||
          state.activityResolutions.some((candidate) => candidate.tokenId === resolution.tokenId)
        ) {
          return journalFailure(
            index,
            `Task outcome '${resolution.tokenId}' does not match one active compiled task binding`
          )
        }
        state.activityResolutions.push(directClone(resolution))
        if (resolution.outcome._tag === "Succeeded") {
          pendingResolvedTask = {
            resolution,
            kind: "Succeeded"
          }
          break
        }
        const errorRef = mappedErrorRef(binding, resolution.outcome)
        const boundary = errorRef === undefined
          ? undefined
          : matchingBoundaryError(
            kernel,
            resolution.taskNodeId,
            errorRef
          )
        if (boundary !== undefined && errorRef !== undefined) {
          pendingResolvedTask = {
            resolution,
            kind: "Caught",
            boundary,
            errorRef
          }
          break
        }
        const owningScope = findScope(state, resolution.scopeInstanceId)
        if (owningScope === undefined) {
          return journalFailure(
            index,
            `Failed task outcome '${resolution.tokenId}' has no owning scope`
          )
        }
        const failureScopes: Array<MutableScopeInstance> = []
        let current: MutableScopeInstance | undefined = owningScope
        while (current !== undefined) {
          failureScopes.push(current)
          current = current.parentScopeInstanceId === undefined
            ? undefined
            : findScope(state, current.parentScopeInstanceId)
        }
        const rootScope = failureScopes[failureScopes.length - 1]
        if (rootScope === undefined || rootScope.parentScopeInstanceId !== undefined) {
          return journalFailure(
            index,
            `Failed task outcome '${resolution.tokenId}' has no root scope`
          )
        }
        const failureScopeIds = new Set(
          failureScopes.map((scope) => scope.scopeInstanceId)
        )
        pendingFailureCleanup = {
          resolution,
          failureKind: errorRef === undefined
            ? "UnmappedBusinessFailure"
            : "UncaughtBpmnError",
          ...(errorRef === undefined ? undefined : { errorRef }),
          tokenIds: state.tokens
            .filter((candidate) => candidate.status === "active")
            .map((candidate) => candidate.tokenId),
          frameIds: state.gatewayFrames
            .filter((frame) => frame.status === "waiting" || frame.status === "satisfied")
            .map((frame) => frame.frameId),
          loopFrameIds: state.loopFrames
            .filter((frame) => frame.status === "active")
            .map((frame) => frame.frameId),
          multiInstanceGroups: state.multiInstanceGroups
            .filter((group) => group.status === "active")
            .map((group) => ({
              groupId: group.groupId,
              itemIndexes: group.members
                .filter((member) => member.status === "active" || member.status === "pending")
                .map((member) => member.index)
            })),
          interruptedScopeIds: [...state.scopeInstances]
            .reverse()
            .filter((scope) =>
              scope.status === "active" &&
              !failureScopeIds.has(scope.scopeInstanceId)
            )
            .map((scope) => scope.scopeInstanceId),
          failedScopeIds: failureScopes.map((scope) => scope.scopeInstanceId),
          rootScopeInstanceId: rootScope.scopeInstanceId
        }
        break
      }

      case "TokenConsumed": {
        const token = state.tokens.find((candidate) => candidate.tokenId === event.tokenId)
        if (token === undefined || token.status !== "active") {
          return journalFailure(index, `Token '${event.tokenId}' is missing or is not active`)
        }
        if (event.consumedAt < token.createdAt) {
          return journalFailure(index, `Token '${event.tokenId}' was consumed before it was created`)
        }
        if (token.position._tag === "AtNode") {
          const task = kernel.nodeById.get(token.position.nodeId)
          const isProtocolSuccess = event.reason === "task-succeeded" &&
            pendingResolvedTask?.kind === "Succeeded" &&
            pendingResolvedTask.resolution.tokenId === token.tokenId
          const isLegacyCompletion = event.reason === "task-completed" &&
            pendingResolvedTask === undefined &&
            task?._tag === "Task" &&
            !kernel.taskBindingByTaskNodeId.has(task.id)
          if (
            task?._tag !== "Task" ||
            (!isProtocolSuccess && !isLegacyCompletion)
          ) {
            return journalFailure(index, `Token '${event.tokenId}' has an invalid task-consumption reason`)
          }
          const taskOutput = isProtocolSuccess &&
              pendingResolvedTask?.resolution.outcome._tag ===
                "Succeeded"
            ? pendingResolvedTask.resolution.outcome.output.value
            : undefined
          pendingResolvedTask = undefined
          if (
            task.loopCharacteristics?._tag ===
              "StandardLoopCharacteristics"
          ) {
            const branch = standardLoopBranch(token.invocation)
            const frame = branch === undefined
              ? undefined
              : state.loopFrames.find((candidate) => candidate.frameId === branch.frameId)
            if (
              frame === undefined ||
              frame.status !== "active" ||
              frame.activeIteration === undefined ||
              frame.activeIteration !== branch?.iteration
            ) {
              return journalFailure(
                index,
                `Loop task token '${token.tokenId}' has no exact active loop frame`
              )
            }
            pendingLoopTransition = {
              kind: "iteration-complete",
              activity: task,
              frameId: frame.frameId,
              iteration: frame.activeIteration,
              transitionedAt: event.consumedAt
            }
          } else if (
            task.loopCharacteristics?._tag ===
              "MultiInstanceCharacteristics"
          ) {
            const branch = multiInstanceBranch(token.invocation)
            const group = branch === undefined
              ? undefined
              : state.multiInstanceGroups.find((candidate) => candidate.groupId === branch.groupId)
            const member = branch === undefined || group === undefined
              ? undefined
              : group.members.find((candidate) =>
                candidate.index === branch.itemIndex &&
                candidate.itemKey === branch.itemKey
              )
            if (
              group === undefined ||
              group.status !== "active" ||
              member === undefined ||
              member.status !== "active" ||
              member.tokenId !== token.tokenId
            ) {
              return journalFailure(
                index,
                `Multi-instance task token '${token.tokenId}' has no exact active member`
              )
            }
            pendingMultiInstanceTransition = {
              kind: "complete-item",
              activity: task,
              groupId: group.groupId,
              itemIndex: member.index,
              itemKey: member.itemKey,
              ...(taskOutput === undefined
                ? undefined
                : { output: taskOutput }),
              transitionedAt: event.consumedAt
            }
          } else {
            pendingRoute = {
              sourceNode: task,
              scopeInstanceId: token.scopeInstanceId,
              routingKind: "activity",
              routedAt: event.consumedAt,
              evaluations: new Map()
            }
          }
        } else {
          const firstActiveFlowToken = state.tokens.find((candidate) =>
            candidate.status === "active" && candidate.position._tag === "OnSequenceFlow"
          )
          if (firstActiveFlowToken?.tokenId !== token.tokenId) {
            return journalFailure(index, `Flow token '${event.tokenId}' violates deterministic advancement order`)
          }
          const flow = kernel.flowById.get(token.position.sequenceFlowId)
          const target = flow === undefined ? undefined : kernel.nodeById.get(flow.targetId)
          if (flow === undefined || target === undefined) {
            return journalFailure(index, `Token '${event.tokenId}' references an unknown flow target`)
          }
          const expectedReason = target._tag === "EndEvent"
            ? "end-reached"
            : target._tag === "SubProcess"
            ? "subprocess-entered"
            : target._tag === "Gateway" &&
                target.gatewayKind === "parallel" &&
                target.gatewayDirection === "converging"
            ? "parallel-join-arrival"
            : "flow-advanced"
          if (event.reason !== expectedReason) {
            return journalFailure(index, `Token '${event.tokenId}' has an invalid flow-consumption reason`)
          }
          const scope = findScope(state, token.scopeInstanceId)
          if (scope === undefined || scope.status !== "active") {
            return journalFailure(index, `Token '${event.tokenId}' has no active owning scope`)
          }
          if (target._tag === "Task") {
            if (
              target.loopCharacteristics?._tag ===
                "StandardLoopCharacteristics"
            ) {
              pendingLoopTransition = {
                kind: "open",
                activity: target,
                scopeInstanceId: scope.scopeInstanceId,
                transitionedAt: event.consumedAt
              }
            } else if (
              target.loopCharacteristics?._tag ===
                "MultiInstanceCharacteristics"
            ) {
              const characteristics = target.loopCharacteristics
              pendingMultiInstanceTransition = {
                kind: characteristics.cardinality === undefined
                  ? "collection"
                  : "cardinality",
                activity: target,
                scopeInstanceId: scope.scopeInstanceId,
                groupId: nextId(
                  state.multiInstanceGroups.map((group) => group.groupId),
                  "multi-instance-group:"
                ),
                activation: nextMultiInstanceActivation(
                  state as unknown as BpmnExecutionState.BpmnExecutionState,
                  target.id,
                  scope.scopeInstanceId
                ),
                transitionedAt: event.consumedAt
              }
            } else {
              pendingEmissions = [{
                processId: scope.processId,
                scopeInstanceId: scope.scopeInstanceId,
                invocation: directClone(scope.invocation),
                position: { _tag: "AtNode", nodeId: target.id },
                createdAt: event.consumedAt
              }]
            }
          } else if (target._tag === "SubProcess") {
            const generation = state.scopeInstances.filter((candidate) =>
              candidate.definitionId === target.id &&
              candidate.invocation.activationId === scope.invocation.activationId
            ).length + 1
            pendingScopeEntry = {
              definitionId: target.id,
              processId: target.processId,
              parentScopeInstanceId: scope.scopeInstanceId,
              invocation: {
                activationId: scope.invocation.activationId,
                generation
              },
              enteredAt: event.consumedAt
            }
          } else if (target._tag === "Gateway") {
            if (target.gatewayKind === "exclusive" && target.gatewayDirection === "diverging") {
              pendingRoute = {
                sourceNode: target,
                scopeInstanceId: scope.scopeInstanceId,
                routingKind: "exclusive-gateway",
                routedAt: event.consumedAt,
                evaluations: new Map()
              }
            } else if (
              target.gatewayKind === "parallel" &&
              target.gatewayDirection === "converging"
            ) {
              const waiting = state.gatewayFrames
                .filter((frame) =>
                  frame.gatewayId === target.id &&
                  frame.scopeInstanceId === scope.scopeInstanceId &&
                  frame.activationId === scope.invocation.activationId &&
                  frame.status === "waiting" &&
                  !frame.arrivedIncomingSequenceFlowIds.includes(flow.id)
                )
                .sort((left, right) => left.joinEpoch - right.joinEpoch)[0]
              pendingGatewayArrival = {
                gateway: target,
                sequenceFlowId: flow.id,
                scopeInstanceId: scope.scopeInstanceId,
                activationId: scope.invocation.activationId,
                expectedFrameId: waiting?.frameId ??
                  nextId(state.gatewayFrames.map((frame) => frame.frameId), "frame:"),
                expectedJoinEpoch: waiting?.joinEpoch ??
                  currentFrameEpoch(
                      state as unknown as BpmnExecutionState.BpmnExecutionState,
                      target.id,
                      scope.scopeInstanceId,
                      scope.invocation.activationId
                    ) + 1,
                frameOpened: waiting !== undefined
              }
            } else {
              queueFlowEmissions(
                scope,
                kernel.orderedOutgoingByNodeId.get(target.id) ?? [],
                event.consumedAt
              )
            }
          }
        }
        token.status = "consumed"
        token.consumedAt = event.consumedAt
        break
      }

      case "TokenWithdrawn": {
        const token = state.tokens.find((candidate) => candidate.tokenId === event.tokenId)
        if (
          token === undefined ||
          token.status !== "active" ||
          event.withdrawnAt < token.createdAt
        ) {
          return journalFailure(
            index,
            `Withdrawn token '${event.tokenId}' is missing, inactive, or chronologically invalid`
          )
        }
        const pendingMultiInstance = pendingMultiInstanceTransition
        if (
          pendingMultiInstance?.kind === "terminate-and-finish" ||
          pendingMultiInstance?.kind === "cancel-before-boundary"
        ) {
          const expectedTokenId = pendingMultiInstance.tokenIds[0]
          const expectedReason: WithdrawalReason = pendingMultiInstance.kind === "terminate-and-finish"
            ? "multi-instance-completion-condition"
            : "boundary-error-caught"
          if (
            event.tokenId !== expectedTokenId ||
            event.reason !== expectedReason ||
            event.withdrawnAt !== pendingMultiInstance.transitionedAt
          ) {
            return journalFailure(
              index,
              `Multi-instance token withdrawal '${event.tokenId}' is out of order`
            )
          }
          token.status = "withdrawn"
          token.consumedAt = event.withdrawnAt
          pendingMultiInstance.tokenIds.shift()
          break
        }
        if (pendingResolvedTask?.kind === "Caught") {
          if (
            pendingResolvedTask.resolution.tokenId !== event.tokenId ||
            event.reason !== "boundary-error-caught" ||
            event.withdrawnAt !==
              pendingResolvedTask.resolution.resolvedAt ||
            token.position._tag !== "AtNode"
          ) {
            return journalFailure(
              index,
              `Boundary-error withdrawal '${event.tokenId}' does not match its failed task outcome`
            )
          }
          token.status = "withdrawn"
          token.consumedAt = event.withdrawnAt
          pendingBoundaryErrorCatch = {
            resolution: pendingResolvedTask.resolution,
            boundary: pendingResolvedTask.boundary!,
            errorRef: pendingResolvedTask.errorRef!
          }
          const task = kernel.nodeById.get(
            pendingResolvedTask.resolution.taskNodeId
          )
          const branch = standardLoopBranch(token.invocation)
          const frame = branch === undefined
            ? undefined
            : state.loopFrames.find((candidate) => candidate.frameId === branch.frameId)
          if (
            task?._tag === "Task" &&
            task.loopCharacteristics?._tag ===
              "StandardLoopCharacteristics"
          ) {
            if (frame === undefined || frame.status !== "active") {
              return journalFailure(
                index,
                `Boundary-error loop token '${token.tokenId}' has no active loop frame`
              )
            }
            pendingLoopTransition = {
              kind: "cancel-before-boundary",
              activity: task,
              frameId: frame.frameId,
              sourceTokenId: token.tokenId,
              transitionedAt: event.withdrawnAt
            }
          } else if (
            task?._tag === "Task" &&
            task.loopCharacteristics?._tag ===
              "MultiInstanceCharacteristics"
          ) {
            const itemBranch = multiInstanceBranch(token.invocation)
            const group = itemBranch === undefined
              ? undefined
              : state.multiInstanceGroups.find((candidate) => candidate.groupId === itemBranch.groupId)
            if (group === undefined || group.status !== "active") {
              return journalFailure(
                index,
                `Boundary-error multi-instance token '${token.tokenId}' has no active group`
              )
            }
            const remaining = group.members.filter((member) =>
              member.status === "active" || member.status === "pending"
            )
            pendingMultiInstanceTransition = {
              kind: "cancel-before-boundary",
              activity: task,
              groupId: group.groupId,
              sourceTokenId: token.tokenId,
              tokenIds: remaining.flatMap((member) => {
                if (member.tokenId === undefined || member.tokenId === token.tokenId) {
                  return []
                }
                const memberToken = state.tokens.find((candidate) => candidate.tokenId === member.tokenId)
                return memberToken?.status === "active"
                  ? [memberToken.tokenId]
                  : []
              }),
              itemIndexes: remaining.map((member) => member.index),
              transitionedAt: event.withdrawnAt
            }
          }
          pendingResolvedTask = undefined
          break
        }
        const cleanup = pendingFailureCleanup
        const expectedTokenId = cleanup?.tokenIds[0]
        const expectedReason: WithdrawalReason | undefined = cleanup?.failureKind === "UncaughtBpmnError"
          ? "uncaught-bpmn-error"
          : cleanup === undefined
          ? undefined
          : "unmapped-business-failure"
        if (
          cleanup === undefined ||
          event.tokenId !== expectedTokenId ||
          event.reason !== expectedReason ||
          event.withdrawnAt !== cleanup.resolution.resolvedAt
        ) {
          return journalFailure(
            index,
            `Token withdrawal '${event.tokenId}' is not the next unmatched-failure cleanup`
          )
        }
        token.status = "withdrawn"
        token.consumedAt = event.withdrawnAt
        cleanup.tokenIds.shift()
        break
      }

      case "GatewayFrameOpened": {
        if (pendingGatewayArrival === undefined) {
          return journalFailure(index, `Gateway frame '${event.frameId}' has no arrival cause`)
        }
        const expected = pendingGatewayArrival!
        const scope = findScope(state, expected.scopeInstanceId)
        if (
          event.frameId !== expected.expectedFrameId ||
          event.gatewayId !== expected.gateway.id ||
          event.processId !== expected.gateway.processId ||
          event.scopeInstanceId !== expected.scopeInstanceId ||
          event.activationId !== expected.activationId ||
          event.joinEpoch !== expected.expectedJoinEpoch ||
          !sameStringArray(
            event.expectedIncomingSequenceFlowIds,
            expected.gateway.incomingSequenceFlowIds
          ) ||
          scope === undefined
        ) {
          return journalFailure(index, `Gateway frame '${event.frameId}' does not match its first arrival`)
        }
        state.gatewayFrames.push({
          frameId: event.frameId,
          gatewayId: event.gatewayId,
          processId: event.processId,
          scopeInstanceId: event.scopeInstanceId,
          activationId: event.activationId,
          joinEpoch: event.joinEpoch,
          expectedIncomingSequenceFlowIds: [...event.expectedIncomingSequenceFlowIds],
          arrivedIncomingSequenceFlowIds: [],
          status: "waiting"
        })
        expected.frameOpened = true
        break
      }

      case "GatewayArrivalRecorded": {
        if (pendingGatewayArrival === undefined) {
          return journalFailure(index, `Gateway arrival '${event.frameId}' has no consumed flow-token cause`)
        }
        const expected = pendingGatewayArrival!
        const frame = state.gatewayFrames.find((candidate) => candidate.frameId === expected.expectedFrameId)
        if (
          frame === undefined ||
          frame.status !== "waiting" ||
          event.frameId !== frame.frameId ||
          event.gatewayId !== frame.gatewayId ||
          event.joinEpoch !== frame.joinEpoch ||
          event.sequenceFlowId !== expected.sequenceFlowId ||
          !sameStringArray(
            event.arrivedIncomingSequenceFlowIds,
            [...frame.arrivedIncomingSequenceFlowIds, event.sequenceFlowId]
          )
        ) {
          return journalFailure(index, `Gateway arrival for frame '${event.frameId}' is inconsistent`)
        }
        frame.arrivedIncomingSequenceFlowIds.push(event.sequenceFlowId)
        if (
          frame.expectedIncomingSequenceFlowIds.every((flowId) => frame.arrivedIncomingSequenceFlowIds.includes(flowId))
        ) {
          frame.status = "satisfied"
        }
        pendingGatewayArrival = undefined
        break
      }

      case "GatewayFired": {
        if (state.tokens.some((token) => token.status === "active" && token.position._tag === "OnSequenceFlow")) {
          return journalFailure(index, `Gateway frame '${event.frameId}' fired before pending flow tokens advanced`)
        }
        const firstSatisfied = state.gatewayFrames.find((frame) => frame.status === "satisfied")
        if (
          firstSatisfied === undefined ||
          event.frameId !== firstSatisfied.frameId ||
          event.gatewayId !== firstSatisfied.gatewayId ||
          event.joinEpoch !== firstSatisfied.joinEpoch
        ) {
          return journalFailure(index, `Gateway frame '${event.frameId}' is not the next satisfied frame`)
        }
        const gateway = kernel.nodeById.get(event.gatewayId)
        const scope = findScope(state, firstSatisfied.scopeInstanceId)
        if (
          gateway === undefined ||
          gateway._tag !== "Gateway" ||
          gateway.gatewayKind !== "parallel" ||
          gateway.gatewayDirection !== "converging" ||
          scope === undefined
        ) {
          return journalFailure(index, `Gateway frame '${event.frameId}' cannot fire`)
        }
        firstSatisfied.status = "fired"
        queueFlowEmissions(
          scope,
          kernel.orderedOutgoingByNodeId.get(gateway.id) ?? [],
          event.firedAt
        )
        break
      }

      case "GatewayFrameCancelled": {
        const cleanup = pendingFailureCleanup
        const expectedFrameId = cleanup?.frameIds[0]
        const frame = state.gatewayFrames.find((candidate) => candidate.frameId === event.frameId)
        if (
          cleanup === undefined ||
          event.frameId !== expectedFrameId ||
          event.sourceTokenId !== cleanup.resolution.tokenId ||
          event.cancelledAt !== cleanup.resolution.resolvedAt ||
          frame === undefined ||
          (frame.status !== "waiting" && frame.status !== "satisfied")
        ) {
          return journalFailure(
            index,
            `Gateway-frame cancellation '${event.frameId}' is not the next unmatched-failure cleanup`
          )
        }
        frame.status = "cancelled"
        cleanup.frameIds.shift()
        break
      }

      case "LoopFrameCancelled": {
        const pending = pendingLoopTransition
        if (pending?.kind === "cancel-before-boundary") {
          const frame = state.loopFrames.find((candidate) => candidate.frameId === pending.frameId)
          if (
            frame === undefined ||
            frame.status !== "active" ||
            event.frameId !== frame.frameId ||
            event.activityId !== pending.activity.id ||
            event.activation !== frame.activation ||
            event.sourceTokenId !== pending.sourceTokenId ||
            event.reason !== "boundary-error-caught" ||
            event.cancelledAt !== pending.transitionedAt
          ) {
            return journalFailure(
              index,
              `Loop-frame cancellation '${event.frameId}' does not match its Boundary Error`
            )
          }
          frame.status = "cancelled"
          delete frame.activeIteration
          frame.closedAt = event.cancelledAt
          pendingLoopTransition = undefined
          break
        }
        const cleanup = pendingFailureCleanup
        const expectedFrameId = cleanup?.loopFrameIds[0]
        const frame = state.loopFrames.find((candidate) => candidate.frameId === event.frameId)
        const expectedReason = cleanup?.failureKind === "UncaughtBpmnError"
          ? "uncaught-bpmn-error"
          : cleanup === undefined
          ? undefined
          : "unmapped-business-failure"
        if (
          cleanup === undefined ||
          event.frameId !== expectedFrameId ||
          event.sourceTokenId !== cleanup.resolution.tokenId ||
          event.reason !== expectedReason ||
          event.cancelledAt !== cleanup.resolution.resolvedAt ||
          frame === undefined ||
          frame.status !== "active" ||
          event.activityId !== frame.activityId ||
          event.activation !== frame.activation
        ) {
          return journalFailure(
            index,
            `Loop-frame cancellation '${event.frameId}' is not the next unmatched-failure cleanup`
          )
        }
        frame.status = "cancelled"
        delete frame.activeIteration
        frame.closedAt = event.cancelledAt
        cleanup.loopFrameIds.shift()
        break
      }

      case "ConditionEvaluated": {
        if (pendingRoute === undefined) {
          return journalFailure(index, `Condition event '${event.sequenceFlowId}' has no routing cause`)
        }
        const route = pendingRoute!
        const expected = expectedCondition(kernel, route)
        const expectedBinding = expected?.condition === undefined
          ? undefined
          : kernel.evaluatorBindings.find((binding) =>
            binding.language === expected.condition!.language &&
            binding.languageVersion === expected.condition!.version
          )
        if (
          expected === undefined ||
          event.sequenceFlowId !== expected.id ||
          expected.condition === undefined ||
          !sameExpression(event.expression, expected.condition) ||
          expectedBinding === undefined ||
          BpmnExpression.evaluatorBindingKey(event.evaluatorBinding) !==
            BpmnExpression.evaluatorBindingKey(expectedBinding)
        ) {
          return journalFailure(index, `Condition event for flow '${event.sequenceFlowId}' is out of order or invalid`)
        }
        const scope = findScope(state, route.scopeInstanceId)
        if (scope === undefined) {
          return journalFailure(index, `Condition event for flow '${event.sequenceFlowId}' has no evaluation scope`)
        }
        const contextSnapshot = Json.snapshot({
          _tag: "SequenceFlowCondition",
          expression: expected.condition,
          sequenceFlow: expected,
          sourceNode: route.sourceNode,
          scopeInstance: scope,
          state
        })
        if (Result.isFailure(contextSnapshot)) {
          return journalFailure(index, `Condition event for flow '${event.sequenceFlowId}' has no canonical context`)
        }
        let sourceUtf8Bytes: number
        let contextCanonicalBytes: number
        try {
          sourceUtf8Bytes = new TextEncoder().encode(
            expected.condition.source
          ).byteLength
          contextCanonicalBytes = new TextEncoder().encode(
            Json.canonicalizeSnapshot(contextSnapshot.success)
          ).byteLength
        } catch {
          return journalFailure(index, `Condition event for flow '${event.sequenceFlowId}' has invalid usage evidence`)
        }
        if (
          event.usage.sourceUtf8Bytes !== sourceUtf8Bytes ||
          event.usage.contextCanonicalBytes !== contextCanonicalBytes ||
          event.usage.steps > expectedBinding.limits.maxSteps ||
          sourceUtf8Bytes > expectedBinding.limits.maxSourceUtf8Bytes ||
          contextCanonicalBytes >
            expectedBinding.limits.maxContextCanonicalBytes
        ) {
          return journalFailure(index, `Condition event for flow '${event.sequenceFlowId}' has invalid usage evidence`)
        }
        route.evaluations.set(event.sequenceFlowId, event.result)
        break
      }

      case "OutgoingSelected": {
        if (pendingRoute === undefined) {
          return journalFailure(index, `Outgoing selection '${event.sourceNodeId}' has no routing cause`)
        }
        const route = pendingRoute!
        const selected = expectedSelection(kernel, route)
        if (
          event.sourceNodeId !== route.sourceNode.id ||
          event.routingKind !== route.routingKind ||
          selected === undefined ||
          !sameStringArray(event.sequenceFlowIds, selected)
        ) {
          return journalFailure(index, `Outgoing selection for '${event.sourceNodeId}' is inconsistent`)
        }
        const scope = findScope(state, route.scopeInstanceId)
        if (
          scope === undefined ||
          scope.status !== "active" ||
          scope.definitionId !== route.sourceNode.parentScopeId
        ) {
          return journalFailure(index, `Outgoing selection '${event.sourceNodeId}' has no active owning scope`)
        }
        pendingRoute = undefined
        queueFlowEmissions(scope, selected, route.routedAt)
        break
      }

      case "BoundaryErrorCaught": {
        const pending = pendingBoundaryErrorCatch
        if (
          pending === undefined ||
          event.tokenId !== pending.resolution.tokenId ||
          event.taskNodeId !== pending.resolution.taskNodeId ||
          event.boundaryEventId !== pending.boundary.id ||
          event.errorRef !== pending.errorRef ||
          event.caughtAt !== pending.resolution.resolvedAt
        ) {
          return journalFailure(
            index,
            `Boundary Error catch '${event.boundaryEventId}' does not match its interrupted task`
          )
        }
        const scope = findScope(state, pending.resolution.scopeInstanceId)
        if (scope === undefined || scope.status !== "active") {
          return journalFailure(
            index,
            `Boundary Error catch '${event.boundaryEventId}' has no active owning scope`
          )
        }
        pendingBoundaryErrorCatch = undefined
        queueFlowEmissions(
          scope,
          kernel.orderedOutgoingByNodeId.get(pending.boundary.id) ?? [],
          event.caughtAt
        )
        break
      }

      case "TaskCompletionReplayed": {
        const token = state.tokens.find((candidate) => candidate.tokenId === event.tokenId)
        const task = token?.position._tag === "AtNode"
          ? kernel.nodeById.get(token.position.nodeId)
          : undefined
        const itemBranch = token === undefined
          ? undefined
          : multiInstanceBranch(token.invocation)
        const group = itemBranch === undefined
          ? undefined
          : state.multiInstanceGroups.find((candidate) => candidate.groupId === itemBranch.groupId)
        const member = itemBranch === undefined || group === undefined
          ? undefined
          : group.members.find((candidate) =>
            candidate.index === itemBranch.itemIndex &&
            candidate.itemKey === itemBranch.itemKey
          )
        const terminalTaskWait = token?.status === "consumed" ||
          (
            token?.status === "withdrawn" &&
            member?.status === "terminated" &&
            member.tokenId === token.tokenId
          )
        if (
          token === undefined ||
          !terminalTaskWait ||
          token.position._tag !== "AtNode" ||
          task?._tag !== "Task" ||
          kernel.taskBindingByTaskNodeId.has(task.id) ||
          state.activityResolutions.some((resolution) => resolution.tokenId === token.tokenId) ||
          token.consumedAt === undefined ||
          event.observedAt < token.consumedAt
        ) {
          return journalFailure(index, `Task-completion replay '${event.tokenId}' has no completed task token`)
        }
        break
      }

      case "TaskOutcomeReplayed": {
        const resolution = state.activityResolutions.find((candidate) => candidate.tokenId === event.tokenId)
        const token = state.tokens.find((candidate) => candidate.tokenId === event.tokenId)
        if (
          resolution === undefined ||
          token === undefined ||
          token.status === "active" ||
          resolution.outcome.occurrenceDigest !== event.occurrenceDigest ||
          token.consumedAt === undefined ||
          event.observedAt < token.consumedAt
        ) {
          return journalFailure(
            index,
            `Task-outcome replay '${event.tokenId}' has no identical durable resolution`
          )
        }
        break
      }

      case "ScopeInterruptedByError": {
        const cleanup = pendingFailureCleanup
        const expectedScopeId = cleanup?.interruptedScopeIds[0]
        const scope = state.scopeInstances.find((candidate) => candidate.scopeInstanceId === event.scopeInstanceId)
        if (
          cleanup === undefined ||
          event.scopeInstanceId !== expectedScopeId ||
          event.sourceTokenId !== cleanup.resolution.tokenId ||
          event.exitedAt !== cleanup.resolution.resolvedAt ||
          scope === undefined ||
          scope.status !== "active" ||
          event.definitionId !== scope.definitionId
        ) {
          return journalFailure(
            index,
            `Scope interruption '${event.scopeInstanceId}' is not the next unmatched-failure cleanup`
          )
        }
        scope.status = "cancelled"
        scope.exitedAt = event.exitedAt
        cleanup.interruptedScopeIds.shift()
        break
      }

      case "ScopeFailed": {
        const cleanup = pendingFailureCleanup
        const expectedScopeId = cleanup?.failedScopeIds[0]
        const scope = state.scopeInstances.find((candidate) => candidate.scopeInstanceId === event.scopeInstanceId)
        if (
          cleanup === undefined ||
          event.scopeInstanceId !== expectedScopeId ||
          event.sourceTokenId !== cleanup.resolution.tokenId ||
          event.exitedAt !== cleanup.resolution.resolvedAt ||
          scope === undefined ||
          scope.status !== "active" ||
          event.definitionId !== scope.definitionId
        ) {
          return journalFailure(
            index,
            `Scope failure '${event.scopeInstanceId}' is not the next unmatched-failure cleanup`
          )
        }
        scope.status = "failed"
        scope.exitedAt = event.exitedAt
        cleanup.failedScopeIds.shift()
        break
      }

      case "ScopeCompleted": {
        if (
          state.tokens.some((token) => token.status === "active" && token.position._tag === "OnSequenceFlow") ||
          state.gatewayFrames.some((frame) => frame.status === "satisfied")
        ) {
          return journalFailure(index, `Scope '${event.scopeInstanceId}' completed before automatic work drained`)
        }
        const eligible = state.scopeInstances
          .filter((scope) => scope.status === "active")
          .sort((left, right) => right.scopeInstanceId.localeCompare(left.scopeInstanceId))
          .find((scope) =>
            activeTokens(
                state as unknown as BpmnExecutionState.BpmnExecutionState,
                scope.scopeInstanceId
              ).length === 0 &&
            waitingFrames(
                state as unknown as BpmnExecutionState.BpmnExecutionState,
                scope.scopeInstanceId
              ).length === 0 &&
            activeLoopFrames(
                state as unknown as BpmnExecutionState.BpmnExecutionState,
                scope.scopeInstanceId
              ).length === 0 &&
            activeMultiInstanceGroups(
                state as unknown as BpmnExecutionState.BpmnExecutionState,
                scope.scopeInstanceId
              ).length === 0 &&
            activeChildScopes(
                state as unknown as BpmnExecutionState.BpmnExecutionState,
                scope.scopeInstanceId
              ).length === 0
          )
        if (
          eligible === undefined ||
          event.scopeInstanceId !== eligible.scopeInstanceId ||
          event.definitionId !== eligible.definitionId ||
          event.exitedAt < eligible.enteredAt
        ) {
          return journalFailure(
            index,
            `Scope completion '${event.scopeInstanceId}' is not the next eligible completion`
          )
        }
        eligible.status = "completed"
        eligible.exitedAt = event.exitedAt
        if (eligible.parentScopeInstanceId === undefined) {
          pendingExecutionCompletion = eligible.scopeInstanceId
        } else {
          const subprocess = kernel.nodeById.get(eligible.definitionId)
          if (subprocess === undefined || subprocess._tag !== "SubProcess") {
            return journalFailure(index, `Completed child scope '${eligible.scopeInstanceId}' is not a subprocess`)
          }
          const parentScope = findScope(state, eligible.parentScopeInstanceId)
          if (parentScope === undefined || parentScope.status !== "active") {
            return journalFailure(index, `Completed child scope '${eligible.scopeInstanceId}' has no active parent`)
          }
          pendingRoute = {
            sourceNode: subprocess,
            scopeInstanceId: parentScope.scopeInstanceId,
            routingKind: "activity",
            routedAt: event.exitedAt,
            evaluations: new Map()
          }
        }
        break
      }

      case "ExecutionCompleted": {
        if (pendingExecutionCompletion === undefined) {
          return journalFailure(index, "Execution completion has no completed root-scope cause")
        }
        const rootScope = state.scopeInstances.find((scope) => scope.scopeInstanceId === pendingExecutionCompletion)
        if (
          rootScope === undefined ||
          rootScope.parentScopeInstanceId !== undefined ||
          rootScope.status !== "completed" ||
          event.rootScopeInstanceId !== rootScope.scopeInstanceId ||
          event.completedAt !== rootScope.exitedAt ||
          state.scopeInstances.some((scope) => scope.status === "active") ||
          state.tokens.some((token) => token.status === "active") ||
          state.gatewayFrames.some((frame) => frame.status === "waiting" || frame.status === "satisfied") ||
          state.loopFrames.some((frame) => frame.status === "active") ||
          state.multiInstanceGroups.some((group) => group.status === "active")
        ) {
          return journalFailure(index, "Execution completion is inconsistent with the terminal marking")
        }
        state.status = "completed"
        state.completedAt = event.completedAt
        pendingExecutionCompletion = undefined
        break
      }

      case "ExecutionFailed": {
        const cleanup = pendingFailureCleanup
        const rootScope = state.scopeInstances.find((scope) => scope.scopeInstanceId === event.rootScopeInstanceId)
        if (
          cleanup === undefined ||
          cleanup.tokenIds.length !== 0 ||
          cleanup.frameIds.length !== 0 ||
          cleanup.loopFrameIds.length !== 0 ||
          cleanup.multiInstanceGroups.length !== 0 ||
          cleanup.interruptedScopeIds.length !== 0 ||
          cleanup.failedScopeIds.length !== 0 ||
          event.rootScopeInstanceId !== cleanup.rootScopeInstanceId ||
          event.sourceTokenId !== cleanup.resolution.tokenId ||
          event.taskNodeId !== cleanup.resolution.taskNodeId ||
          event.failureKind !== cleanup.failureKind ||
          event.errorRef !== cleanup.errorRef ||
          event.failedAt !== cleanup.resolution.resolvedAt ||
          rootScope === undefined ||
          rootScope.parentScopeInstanceId !== undefined ||
          rootScope.status !== "failed" ||
          state.scopeInstances.some((scope) => scope.status === "active") ||
          state.tokens.some((token) => token.status === "active") ||
          state.gatewayFrames.some((frame) => frame.status === "waiting" || frame.status === "satisfied") ||
          state.loopFrames.some((frame) => frame.status === "active") ||
          state.multiInstanceGroups.some((group) => group.status === "active")
        ) {
          return journalFailure(
            index,
            "Execution failure is inconsistent with unmatched business-failure cleanup"
          )
        }
        state.status = "failed"
        state.completedAt = event.failedAt
        pendingFailureCleanup = undefined
        break
      }
    }
  }

  if (
    pendingEmissions.length > 0 ||
    pendingRoute !== undefined ||
    pendingScopeEntry !== undefined ||
    pendingGatewayArrival !== undefined ||
    pendingTaskWait !== undefined ||
    pendingResolvedTask !== undefined ||
    pendingBoundaryErrorCatch !== undefined ||
    pendingLoopTransition !== undefined ||
    pendingMultiInstanceTransition !== undefined ||
    pendingFailureCleanup !== undefined ||
    pendingExecutionCompletion !== undefined
  ) {
    return journalFailure(events.length, "The transition journal ends before its causal transition completes")
  }
  return validateKernelState(kernel, state)
}

type ResolvedEventDefinition =
  | BpmnModel.EventDefinition
  | BpmnModel.DeclaredEventDefinition

const resolvedEventDefinitions = (
  model: BpmnModel.BpmnModel,
  event: BpmnModel.BoundaryEvent
): ReadonlyArray<ResolvedEventDefinition> => {
  const declaredById = new Map(
    (model.eventDefinitions ?? []).map((definition) =>
      [
        definition.id,
        definition
      ] as const
    )
  )
  return [
    ...event.eventDefinitions,
    ...event.eventDefinitionRefs.flatMap((ref) => {
      const definition = declaredById.get(ref)
      return definition === undefined ? [] : [definition]
    })
  ]
}

const boundaryErrorRef = (
  model: BpmnModel.BpmnModel,
  event: BpmnModel.BoundaryEvent
): string | undefined => {
  const definitions = resolvedEventDefinitions(model, event)
  const definition = definitions.length === 1
    ? definitions[0]
    : undefined
  return definition?._tag === "ErrorEventDefinition"
    ? definition.errorRef
    : undefined
}

const canonicalTaskBindings = (
  bindings: ReadonlyArray<BpmnActivityV3.TaskBinding>
): ReadonlyArray<BpmnActivityV3.TaskBinding> =>
  Object.freeze(
    bindings
      .map((binding) =>
        Object.freeze({
          ...binding,
          errorMappings: Object.freeze(
            binding.errorMappings
              .map((mapping) =>
                Object.freeze({
                  identity: Object.freeze({ ...mapping.identity }),
                  errorRef: mapping.errorRef
                })
              )
              .sort((left, right) => {
                const identity = BpmnActivityV3.failureIdentityKey(
                  left.identity
                ).localeCompare(
                  BpmnActivityV3.failureIdentityKey(right.identity)
                )
                return identity !== 0
                  ? identity
                  : left.errorRef.localeCompare(right.errorRef)
              })
          )
        })
      )
      .sort((left, right) => left.taskNodeId.localeCompare(right.taskNodeId))
  )

const canonicalCollectionBindings = (
  bindings: ReadonlyArray<MultiInstanceCollectionBinding>
): ReadonlyArray<MultiInstanceCollectionBinding> =>
  Object.freeze(
    bindings
      .map((binding) =>
        Object.freeze({
          ...binding,
          collectionExpression: Object.freeze({
            ...binding.collectionExpression
          })
        })
      )
      .sort((left, right) => {
        const task = left.taskNodeId.localeCompare(right.taskNodeId)
        return task !== 0
          ? task
          : left.dataInputRef.localeCompare(right.dataInputRef)
      })
  )

const dataOwnerContext = (
  model: BpmnModel.BpmnModel
): BpmnData.SemanticOwnerContext => ({
  contextKind: "BpmnDataOwnerContext",
  contextVersion: BpmnData.SemanticOwnerContextVersion,
  owners: [
    ...model.processes.map((process) => ({
      _tag: "Process" as const,
      id: process.id,
      supportedInterfaceRefs: []
    })),
    ...model.flowNodes.flatMap((node): Array<BpmnData.SemanticOwner> => {
      if (node._tag === "Task") {
        return [{
          _tag: "Task",
          id: node.id,
          processId: node.processId,
          parentScopeId: node.parentScopeId,
          taskKind: node.taskKind
        }]
      }
      if (node._tag === "CallActivity") {
        return [{
          _tag: "CallActivity",
          id: node.id,
          processId: node.processId,
          parentScopeId: node.parentScopeId
        }]
      }
      if (
        node._tag === "SubProcess" ||
        node._tag === "AdHocSubProcess" ||
        node._tag === "Transaction" ||
        node._tag === "EventSubProcess"
      ) {
        return [{
          _tag: "SubProcess",
          id: node.id,
          processId: node.processId,
          parentScopeId: node.parentScopeId
        }]
      }
      return []
    })
  ]
})

const compileStructure = (
  modelInput: unknown,
  options: CompileOptions
): Result.Result<CompiledStructure, Diagnostic.CompilationError> => {
  const { limits, profileId, rootProcessId } = options
  const taskBindings = canonicalTaskBindings(options.taskBindings ?? [])
  const collectionBindings = canonicalCollectionBindings(
    options.collectionBindings ?? []
  )
  const validated = BpmnModel.validate(modelInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const model = validated.success
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  let dataDocument: BpmnData.BpmnDataDocument | null = null
  if (options.dataDocument !== undefined) {
    const validatedData = BpmnData.validate(
      options.dataDocument,
      dataOwnerContext(model)
    )
    if (Result.isFailure(validatedData)) {
      diagnostics.push(...validatedData.failure.diagnostics)
    } else {
      dataDocument = validatedData.success
    }
  }
  const requiredExpressionBindings = new Map<
    string,
    BpmnModel.Expression
  >()
  for (const flow of model.sequenceFlows) {
    if (flow.condition !== undefined) {
      requiredExpressionBindings.set(
        JSON.stringify([flow.condition.language, flow.condition.version]),
        flow.condition
      )
    }
  }
  for (const binding of collectionBindings) {
    requiredExpressionBindings.set(
      JSON.stringify([
        binding.collectionExpression.language,
        binding.collectionExpression.version
      ]),
      binding.collectionExpression
    )
  }
  for (const node of model.flowNodes) {
    const characteristics = node._tag === "Task" ||
        node._tag === "SubProcess"
      ? node.loopCharacteristics
      : undefined
    if (
      node._tag === "Task" &&
      characteristics?._tag === "StandardLoopCharacteristics" &&
      characteristics.condition !== undefined &&
      characteristics.loopMaximum !== undefined
    ) {
      requiredExpressionBindings.set(
        JSON.stringify([
          characteristics.condition.language,
          characteristics.condition.version
        ]),
        characteristics.condition
      )
    }
    if (
      node._tag === "Task" &&
      characteristics?._tag === "MultiInstanceCharacteristics"
    ) {
      if (characteristics.cardinality !== undefined) {
        requiredExpressionBindings.set(
          JSON.stringify([
            characteristics.cardinality.language,
            characteristics.cardinality.version
          ]),
          characteristics.cardinality
        )
      }
      if (characteristics.completionCondition !== undefined) {
        requiredExpressionBindings.set(
          JSON.stringify([
            characteristics.completionCondition.language,
            characteristics.completionCondition.version
          ]),
          characteristics.completionCondition
        )
      }
    }
  }
  const configuredExpressionBindings = new Map<
    string,
    BpmnExpression.EvaluatorBinding
  >()
  for (let index = 0; index < options.evaluatorBindings.length; index++) {
    const binding = options.evaluatorBindings[index]!
    const key = JSON.stringify([binding.language, binding.languageVersion])
    if (configuredExpressionBindings.has(key)) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Expression language '${binding.language}' version '${binding.languageVersion}' has more than one evaluator binding`,
        ["options", "evaluatorBindings", index]
      ))
    } else {
      configuredExpressionBindings.set(key, binding)
    }
    if (!requiredExpressionBindings.has(key)) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Evaluator binding '${binding.language}' version '${binding.languageVersion}' is not used by this executable model`,
        ["options", "evaluatorBindings", index]
      ))
    }
  }
  for (const [key, expression] of requiredExpressionBindings) {
    if (!configuredExpressionBindings.has(key)) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Expression language '${expression.language}' version '${expression.version}' requires one exact evaluator binding`,
        ["options", "evaluatorBindings"],
        {
          language: expression.language,
          languageVersion: expression.version
        }
      ))
    }
  }
  const process = model.processes.find((candidate) => candidate.id === rootProcessId)
  if (process === undefined) {
    diagnostics.push(error(
      Codes.UnsupportedProcess,
      `Root process '${rootProcessId}' does not exist`,
      ["processes"]
    ))
  } else {
    if (process.isExecutable !== true) {
      diagnostics.push(error(
        Codes.UnsupportedProcess,
        `Root process '${rootProcessId}' must declare isExecutable=true`,
        ["processes", model.processes.indexOf(process), "isExecutable"]
      ))
    }
    if (process.processType === "public") {
      diagnostics.push(error(
        Codes.UnsupportedProcess,
        `Public process '${rootProcessId}' is not executable by this token-kernel subset`,
        ["processes", model.processes.indexOf(process), "processType"]
      ))
    }
  }
  const nodeById = new Map(model.flowNodes.map((node) => [node.id, node] as const))
  const flowById = new Map(model.sequenceFlows.map((flow) => [flow.id, flow] as const))
  const errorIds = new Set(
    (model.errors ?? []).map((declaredError) => declaredError.id)
  )
  const taskBindingByTaskNodeId = new Map<string, BpmnActivityV3.TaskBinding>()
  for (let index = 0; index < taskBindings.length; index++) {
    const binding = taskBindings[index]!
    const path = ["options", "taskBindings", index] as const
    const node = nodeById.get(binding.taskNodeId)
    if (node === undefined || node._tag !== "Task") {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Task binding '${binding.taskNodeId}' must reference one exact BPMN Task`,
        [...path, "taskNodeId"]
      ))
    } else if (node.processId !== rootProcessId) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Task binding '${binding.taskNodeId}' is outside executable root process '${rootProcessId}'`,
        [...path, "taskNodeId"]
      ))
    }
    if (taskBindingByTaskNodeId.has(binding.taskNodeId)) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Task '${binding.taskNodeId}' has more than one protocol-v3 binding`,
        [...path, "taskNodeId"]
      ))
    } else {
      taskBindingByTaskNodeId.set(binding.taskNodeId, binding)
    }
    const identities = new Set<string>()
    for (
      let mappingIndex = 0;
      mappingIndex < binding.errorMappings.length;
      mappingIndex++
    ) {
      const mapping = binding.errorMappings[mappingIndex]!
      const key = BpmnActivityV3.failureIdentityKey(mapping.identity)
      if (identities.has(key)) {
        diagnostics.push(error(
          Codes.InvalidKernelProfile,
          `Task binding '${binding.taskNodeId}' repeats failure identity '${key}'`,
          [...path, "errorMappings", mappingIndex, "identity"]
        ))
      } else {
        identities.add(key)
      }
      if (!errorIds.has(mapping.errorRef)) {
        diagnostics.push(error(
          Codes.InvalidKernelProfile,
          `Task binding '${binding.taskNodeId}' maps to unknown BPMN Error '${mapping.errorRef}'`,
          [...path, "errorMappings", mappingIndex, "errorRef"]
        ))
      }
    }
  }
  const collectionBindingByTaskNodeId = new Map<
    string,
    MultiInstanceCollectionBinding
  >()
  for (let index = 0; index < collectionBindings.length; index++) {
    const binding = collectionBindings[index]!
    const path = ["options", "collectionBindings", index] as const
    const node = nodeById.get(binding.taskNodeId)
    const characteristics = node?._tag === "Task"
      ? node.loopCharacteristics
      : undefined
    if (
      node?._tag !== "Task" ||
      node.processId !== rootProcessId ||
      characteristics?._tag !== "MultiInstanceCharacteristics" ||
      characteristics.cardinality !== undefined ||
      characteristics.loopDataInputRef !== binding.dataInputRef
    ) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Collection binding '${binding.taskNodeId}:${binding.dataInputRef}' must match one collection-based multi-instance Task`,
        path
      ))
    }
    if (collectionBindingByTaskNodeId.has(binding.taskNodeId)) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Task '${binding.taskNodeId}' has more than one collection binding`,
        [...path, "taskNodeId"]
      ))
    } else {
      collectionBindingByTaskNodeId.set(
        binding.taskNodeId,
        binding
      )
    }
    const specification = dataDocument?.inputOutputSpecifications.find(
      (candidate) => candidate.ownerId === binding.taskNodeId
    )
    const dataInput = specification?.dataInputs.find(
      (candidate) => candidate.id === binding.dataInputRef
    )
    if (
      dataDocument === null ||
      specification === undefined ||
      dataInput === undefined ||
      dataInput.isCollection !== true
    ) {
      diagnostics.push(error(
        Codes.InvalidKernelProfile,
        `Collection binding '${binding.taskNodeId}:${binding.dataInputRef}' requires a collection-valued Task DataInput in the validated BPMN data document`,
        [...path, "dataInputRef"]
      ))
    }
  }
  const boundaryErrorByTaskNodeId = new Map<
    string,
    BpmnModel.BoundaryEvent
  >()
  const startEventIdByScopeId = new Map<string, string>()
  const childrenByScopeId = new Map<string, Array<BpmnModel.FlowNode>>()
  for (const node of model.flowNodes) {
    const children = childrenByScopeId.get(node.parentScopeId)
    if (children === undefined) {
      childrenByScopeId.set(node.parentScopeId, [node])
    } else {
      children.push(node)
    }
  }
  for (let index = 0; index < model.processes.length; index++) {
    const candidate = model.processes[index]!
    if (candidate.id !== rootProcessId && model.flowNodes.some((node) => node.processId === candidate.id)) {
      diagnostics.push(error(
        Codes.UnsupportedProcess,
        `Process '${candidate.id}' is outside the executable root process '${rootProcessId}'`,
        ["processes", index, "id"]
      ))
    }
  }
  for (let index = 0; index < model.flowNodes.length; index++) {
    const node = model.flowNodes[index]!
    const path = ["flowNodes", index] as const
    if (node.processId !== rootProcessId) {
      diagnostics.push(error(
        Codes.UnsupportedProcess,
        `Flow node '${node.id}' is outside executable root process '${rootProcessId}'`,
        [...path, "processId"]
      ))
      continue
    }
    if (node._tag === "BoundaryEvent") {
      const definitions = resolvedEventDefinitions(model, node)
      const definition = definitions.length === 1
        ? definitions[0]
        : undefined
      const attached = nodeById.get(node.attachedToRef)
      const outgoing = node.outgoingSequenceFlowIds[0] === undefined
        ? undefined
        : flowById.get(node.outgoingSequenceFlowIds[0])
      const binding = taskBindingByTaskNodeId.get(node.attachedToRef)
      const admitted = attached?._tag === "Task" &&
        binding !== undefined &&
        definition?._tag === "ErrorEventDefinition" &&
        node.parallelMultiple !== true &&
        node.cancelActivity !== false &&
        node.outgoingSequenceFlowIds.length === 1 &&
        outgoing?.kind === "normal"
      if (!admitted) {
        diagnostics.push(error(
          Codes.UnsupportedEvent,
          `Boundary event '${node.id}' must be the single interrupting Error boundary of one protocol-v3-bound Task with exactly one normal outgoing flow`,
          path
        ))
        continue
      }
      if (boundaryErrorByTaskNodeId.has(node.attachedToRef)) {
        diagnostics.push(error(
          Codes.UnsupportedEvent,
          `Task '${node.attachedToRef}' may declare at most one executable Boundary Error in this token-kernel slice`,
          path
        ))
      } else {
        boundaryErrorByTaskNodeId.set(node.attachedToRef, node)
      }
      continue
    }
    if (
      node._tag === "CallActivity" || node._tag === "Transaction" || node._tag === "AdHocSubProcess" ||
      node._tag === "EventSubProcess" || node._tag === "IntermediateCatchEvent" ||
      node._tag === "IntermediateThrowEvent"
    ) {
      diagnostics.push(error(
        node._tag === "IntermediateCatchEvent" || node._tag === "IntermediateThrowEvent"
          ? Codes.UnsupportedEvent
          : Codes.UnsupportedNode,
        `Node '${node.id}' of type '${node._tag}' is outside the executable token-kernel subset`,
        path
      ))
      continue
    }
    if (node._tag === "Task" || node._tag === "SubProcess") {
      if (node.incomingSequenceFlowIds.length === 0) {
        diagnostics.push(error(
          Codes.InvalidExecutableStructure,
          `Activity '${node.id}' has no incoming sequence flow; implicit scope-entry activation is outside this token-kernel subset`,
          [...path, "incomingSequenceFlowIds"]
        ))
      }
      if (
        node.outgoingSequenceFlowIds.length === 1 &&
        flowById.get(node.outgoingSequenceFlowIds[0]!)?.kind === "conditional"
      ) {
        diagnostics.push(error(
          Codes.InvalidExecutableStructure,
          `Activity '${node.id}' cannot have a conditional sequence flow as its only outgoing flow`,
          [...path, "outgoingSequenceFlowIds"]
        ))
      }
      if (node.loopCharacteristics !== undefined) {
        const characteristics = node.loopCharacteristics
        if (node._tag !== "Task") {
          diagnostics.push(error(
            Codes.UnsupportedLoop,
            `Node '${node.id}' loop characteristics are outside the executable Task-loop subset`,
            [...path, "loopCharacteristics"]
          ))
        } else if (characteristics._tag === "StandardLoopCharacteristics") {
          if (characteristics.condition === undefined) {
            diagnostics.push(error(
              Codes.UnsupportedLoop,
              `Standard loop task '${node.id}' requires an explicit loop condition in this executable profile`,
              [...path, "loopCharacteristics", "condition"]
            ))
          }
          if (characteristics.loopMaximum === undefined) {
            diagnostics.push(error(
              Codes.UnsupportedLoop,
              `Standard loop task '${node.id}' requires loopMaximum in this executable profile`,
              [...path, "loopCharacteristics", "loopMaximum"]
            ))
          }
        } else {
          if (characteristics.cardinality === undefined) {
            const collectionBinding = collectionBindingByTaskNodeId.get(node.id)
            if (
              characteristics.loopDataInputRef === undefined ||
              collectionBinding === undefined ||
              collectionBinding.dataInputRef !==
                characteristics.loopDataInputRef
            ) {
              diagnostics.push(error(
                Codes.UnsupportedLoop,
                `Collection multi-instance task '${node.id}' requires one exact compiled collection binding`,
                [
                  ...path,
                  "loopCharacteristics",
                  "loopDataInputRef"
                ]
              ))
            }
            if (characteristics.loopDataOutputRef !== undefined) {
              if (characteristics.outputDataItem === undefined) {
                diagnostics.push(error(
                  Codes.UnsupportedLoop,
                  `Collection multi-instance task '${node.id}' loopDataOutputRef requires one scalar outputDataItem in this executable profile`,
                  [
                    ...path,
                    "loopCharacteristics",
                    "outputDataItem"
                  ]
                ))
              }
              const specification = dataDocument?.inputOutputSpecifications.find(
                (candidate) => candidate.ownerId === node.id
              )
              const dataOutput = specification?.dataOutputs.find(
                (candidate) =>
                  candidate.id ===
                    characteristics.loopDataOutputRef
              )
              if (
                dataOutput === undefined ||
                dataOutput.isCollection !== true
              ) {
                diagnostics.push(error(
                  Codes.UnsupportedLoop,
                  `Collection multi-instance task '${node.id}' loopDataOutputRef must identify a collection-valued Task DataOutput`,
                  [
                    ...path,
                    "loopCharacteristics",
                    "loopDataOutputRef"
                  ]
                ))
              }
              if (
                characteristics.completionCondition !== undefined
              ) {
                diagnostics.push(error(
                  Codes.UnsupportedLoop,
                  `Collection multi-instance task '${node.id}' cannot combine output aggregation with completionCondition until an explicit partial-result policy is selected`,
                  [
                    ...path,
                    "loopCharacteristics",
                    "completionCondition"
                  ]
                ))
              }
              if (!taskBindingByTaskNodeId.has(node.id)) {
                diagnostics.push(error(
                  Codes.UnsupportedLoop,
                  `Collection multi-instance task '${node.id}' output aggregation requires a protocol-v3 Task binding with codec-validated output`,
                  [
                    ...path,
                    "loopCharacteristics",
                    "loopDataOutputRef"
                  ]
                ))
              }
            }
          } else if (
            collectionBindingByTaskNodeId.has(node.id)
          ) {
            diagnostics.push(error(
              Codes.InvalidKernelProfile,
              `Cardinality multi-instance task '${node.id}' cannot declare a collection binding`,
              ["options", "collectionBindings"]
            ))
          }
          if (
            characteristics.behavior !== undefined &&
            characteristics.behavior !== "all"
          ) {
            diagnostics.push(error(
              Codes.UnsupportedLoop,
              `Multi-instance task '${node.id}' behavior '${characteristics.behavior}' requires progressive boundary-event semantics`,
              [...path, "loopCharacteristics", "behavior"]
            ))
          }
          if (
            characteristics.oneBehaviorEventRef !== undefined ||
            characteristics.noneBehaviorEventRef !== undefined
          ) {
            diagnostics.push(error(
              Codes.UnsupportedLoop,
              `Multi-instance task '${node.id}' cannot bind behavior events in the fixed all-behavior profile`,
              [
                ...path,
                "loopCharacteristics",
                characteristics.oneBehaviorEventRef !== undefined
                  ? "oneBehaviorEventRef"
                  : "noneBehaviorEventRef"
              ]
            ))
          }
        }
      }
      if (node.isForCompensation === true) {
        diagnostics.push(error(
          Codes.UnsupportedActivity,
          `Node '${node.id}' compensation semantics are not executable in this token-kernel subset`,
          [...path, "isForCompensation"]
        ))
      }
      if ((node.startQuantity ?? 1) !== 1 || (node.completionQuantity ?? 1) !== 1) {
        diagnostics.push(error(
          Codes.UnsupportedActivity,
          `Node '${node.id}' startQuantity and completionQuantity must both be one in this token-kernel subset`,
          [...path, (node.startQuantity ?? 1) !== 1 ? "startQuantity" : "completionQuantity"]
        ))
      }
      if (node._tag === "Task" && node.taskKind !== "generic") {
        diagnostics.push(error(
          Codes.UnsupportedActivity,
          `Task '${node.id}' kind '${node.taskKind}' requires lifecycle semantics outside this token-kernel subset`,
          [...path, "taskKind"]
        ))
      }
    }
    if (node._tag === "StartEvent") {
      if (node.eventDefinitions.length > 0 || node.eventDefinitionRefs.length > 0 || node.parallelMultiple === true) {
        diagnostics.push(error(
          Codes.UnsupportedEvent,
          `Start event '${node.id}' must be a none start event in this token-kernel subset`,
          [...path, "eventDefinitions"]
        ))
      }
      const current = startEventIdByScopeId.get(node.parentScopeId)
      if (current !== undefined) {
        diagnostics.push(error(
          Codes.InvalidExecutableStructure,
          `Scope '${node.parentScopeId}' has more than one start event in the executable token-kernel subset`,
          [...path, "parentScopeId"]
        ))
      } else {
        startEventIdByScopeId.set(node.parentScopeId, node.id)
      }
    }
    if (node._tag === "EndEvent" && (node.eventDefinitions.length > 0 || node.eventDefinitionRefs.length > 0)) {
      diagnostics.push(error(
        Codes.UnsupportedEvent,
        `End event '${node.id}' must be a none end event in this token-kernel subset`,
        [...path, "eventDefinitions"]
      ))
    }
    if (node._tag === "Gateway") {
      if (!["exclusive", "parallel"].includes(node.gatewayKind)) {
        diagnostics.push(error(
          Codes.UnsupportedGateway,
          `Gateway '${node.id}' kind '${node.gatewayKind}' is outside the executable token-kernel subset`,
          [...path, "gatewayKind"]
        ))
      }
      if (!["diverging", "converging"].includes(node.gatewayDirection)) {
        diagnostics.push(error(
          Codes.UnsupportedGateway,
          `Gateway '${node.id}' direction '${node.gatewayDirection}' is outside the executable token-kernel subset`,
          [...path, "gatewayDirection"]
        ))
      }
      if (node.gatewayKind === "exclusive" && node.gatewayDirection === "converging") {
        if (node.defaultFlowId !== undefined) {
          diagnostics.push(error(
            Codes.UnsupportedGateway,
            `Converging exclusive gateway '${node.id}' cannot declare a default flow in this token-kernel subset`,
            [...path, "defaultFlowId"]
          ))
        }
        if (node.outgoingSequenceFlowIds.length > 1) {
          diagnostics.push(error(
            Codes.UnsupportedGateway,
            `Converging exclusive gateway '${node.id}' may expose at most one outgoing flow in this token-kernel subset`,
            [...path, "outgoingSequenceFlowIds"]
          ))
        }
        const outgoing = node.outgoingSequenceFlowIds[0] === undefined
          ? undefined
          : flowById.get(node.outgoingSequenceFlowIds[0])
        if (outgoing !== undefined && outgoing.kind !== "normal") {
          diagnostics.push(error(
            Codes.UnsupportedGateway,
            `Converging exclusive gateway '${node.id}' requires one normal outgoing flow`,
            [...path, "outgoingSequenceFlowIds", 0]
          ))
        }
      }
      if (
        node.gatewayKind === "parallel" && node.gatewayDirection === "converging" &&
        node.incomingSequenceFlowIds.length < 2
      ) {
        diagnostics.push(error(
          Codes.UnsupportedGateway,
          `Converging parallel gateway '${node.id}' requires at least two incoming sequence flows`,
          [...path, "incomingSequenceFlowIds"]
        ))
      }
      if (
        (node.gatewayKind === "exclusive" || node.gatewayKind === "parallel") &&
        node.gatewayDirection === "diverging" &&
        (node.incomingSequenceFlowIds.length !== 1 || node.outgoingSequenceFlowIds.length < 2)
      ) {
        diagnostics.push(error(
          Codes.UnsupportedGateway,
          `Diverging ${node.gatewayKind} gateway '${node.id}' requires exactly one incoming and at least two outgoing flows`,
          [
            ...path,
            node.incomingSequenceFlowIds.length !== 1
              ? "incomingSequenceFlowIds"
              : "outgoingSequenceFlowIds"
          ]
        ))
      }
      if (
        (node.gatewayKind === "exclusive" || node.gatewayKind === "parallel") &&
        node.gatewayDirection === "converging" &&
        (node.incomingSequenceFlowIds.length < 2 || node.outgoingSequenceFlowIds.length !== 1)
      ) {
        diagnostics.push(error(
          Codes.UnsupportedGateway,
          `Converging ${node.gatewayKind} gateway '${node.id}' requires at least two incoming and exactly one outgoing flow`,
          [
            ...path,
            node.incomingSequenceFlowIds.length < 2
              ? "incomingSequenceFlowIds"
              : "outgoingSequenceFlowIds"
          ]
        ))
      }
    }
  }
  for (let index = 0; index < model.sequenceFlows.length; index++) {
    const flow = model.sequenceFlows[index]!
    if (flow.isImmediate === false) {
      diagnostics.push(error(
        Codes.InvalidExecutableStructure,
        `Sequence flow '${flow.id}' declares isImmediate=false, which this immediate token kernel cannot preserve`,
        ["sequenceFlows", index, "isImmediate"]
      ))
    }
  }
  for (const scopeId of [rootProcessId, ...model.flowNodes.filter(supportedScopeNode).map((node) => node.id)]) {
    if (!startEventIdByScopeId.has(scopeId)) {
      diagnostics.push(error(
        Codes.InvalidExecutableStructure,
        `Scope '${scopeId}' requires exactly one none start event`,
        ["flowNodes"]
      ))
    } else if (!(childrenByScopeId.get(scopeId) ?? []).some((node) => node._tag === "EndEvent")) {
      diagnostics.push(error(
        Codes.InvalidExecutableStructure,
        `Scope '${scopeId}' requires at least one end event when it declares a start event`,
        ["flowNodes"]
      ))
    }
  }
  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }
  const orderedOutgoingByNodeId = new Map<string, ReadonlyArray<string>>()
  for (const node of model.flowNodes) {
    orderedOutgoingByNodeId.set(node.id, orderedOutgoing(node, flowById))
  }
  const internalOutgoing = new Map<string, ReadonlyArray<string>>()
  for (const [nodeId, flowIds] of orderedOutgoingByNodeId) {
    internalOutgoing.set(nodeId, Object.freeze([...flowIds]))
  }
  const evaluatorBindings = Object.freeze(
    [...options.evaluatorBindings].sort((left, right) => {
      const language = left.language.localeCompare(right.language)
      return language !== 0
        ? language
        : left.languageVersion.localeCompare(right.languageVersion)
    })
  )
  return Result.succeed(Object.freeze({
    model,
    profileId,
    evaluatorBindings,
    taskBindings,
    dataDocument,
    collectionBindings,
    rootProcessId,
    rootStartEventId: startEventIdByScopeId.get(rootProcessId)!,
    limits,
    startEventIdByScopeId: new Map(startEventIdByScopeId),
    nodeById: new Map(nodeById),
    flowById: new Map(flowById),
    orderedOutgoingByNodeId: internalOutgoing,
    taskBindingByTaskNodeId: new Map(taskBindingByTaskNodeId),
    collectionBindingByTaskNodeId: new Map(
      collectionBindingByTaskNodeId
    ),
    boundaryErrorByTaskNodeId: new Map(boundaryErrorByTaskNodeId)
  }))
}

const authorizeKernel = (
  structure: CompiledStructure,
  modelReference: BpmnExecutionState.ModelReference
): CompiledKernel => {
  const internalKernel: CompiledKernel = Object.freeze({
    ...structure,
    modelReference
  })
  const publicOutgoing = new Map<string, ReadonlyArray<string>>()
  for (const [nodeId, flowIds] of structure.orderedOutgoingByNodeId) {
    publicOutgoing.set(nodeId, Object.freeze([...flowIds]))
  }
  const publicKernel: CompiledKernel = Object.freeze({
    ...structure,
    modelReference,
    startEventIdByScopeId: new Map(structure.startEventIdByScopeId),
    nodeById: new Map(structure.nodeById),
    flowById: new Map(structure.flowById),
    orderedOutgoingByNodeId: publicOutgoing,
    taskBindingByTaskNodeId: new Map(structure.taskBindingByTaskNodeId),
    collectionBindingByTaskNodeId: new Map(
      structure.collectionBindingByTaskNodeId
    ),
    boundaryErrorByTaskNodeId: new Map(
      structure.boundaryErrorByTaskNodeId
    )
  })
  trustedKernels.set(publicKernel, internalKernel)
  return publicKernel
}

/**
 * Validates, fingerprints, and authorizes one executable BPMN token kernel.
 *
 * **Details**
 *
 * The executable fingerprint is computed through the explicit
 * {@link Crypto.Crypto} service. Callers cannot supply a digest or forge an
 * executable authority by copying its public fields. The fingerprint excludes
 * BPMN DI and raw XML spelling, and commits to the complete normalized semantic
 * model, selected profile, root process, safety limits, evaluator manifest,
 * and kernel semantic version.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = Effect.fnUntraced(function*(
  modelInput: unknown,
  optionsInput: unknown
): Effect.fn.Return<
  CompiledKernel,
  Diagnostic.CompilationError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const optionsSnapshot = Json.snapshot(optionsInput)
  if (Result.isFailure(optionsSnapshot)) {
    return yield* Effect.fail(compilationError(error(
      Codes.InvalidKernelProfile,
      optionsSnapshot.failure.message,
      ["options", ...optionsSnapshot.failure.path]
    )))
  }
  const decodedOptions = decodeCompileOptions(optionsSnapshot.success)
  if (Result.isFailure(decodedOptions)) {
    return yield* Effect.fail(compilationError(error(
      Codes.InvalidKernelProfile,
      "Invalid executable token-kernel profile",
      ["options"],
      { issue: String(decodedOptions.failure) }
    )))
  }
  const options = optionsSnapshot.success as unknown as CompileOptions
  const structure = yield* Effect.fromResult(
    compileStructure(modelInput, options)
  )
  const documentSnapshot = Json.snapshot({
    fingerprintVersion: BpmnExecutionState.BpmnExecutableFingerprintVersion,
    kernelSemanticVersion: KernelSemanticVersion,
    bpmnSpecVersion: "2.0.2",
    profileId: structure.profileId,
    rootProcessId: structure.rootProcessId,
    limits: structure.limits,
    evaluatorBindings: structure.evaluatorBindings,
    taskBindings: structure.taskBindings,
    dataDocument: structure.dataDocument,
    collectionBindings: structure.collectionBindings,
    model: structure.model
  })
  if (Result.isFailure(documentSnapshot)) {
    return yield* Effect.fail(compilationError(error(
      Codes.InvalidKernelProfile,
      documentSnapshot.failure.message,
      ["fingerprint", ...documentSnapshot.failure.path]
    )))
  }
  const executableFingerprint = (
    yield* DigestV2.bpmnExecutable(documentSnapshot.success)
  ) as ProtocolV2Wire.BpmnExecutableFingerprint
  const modelReference: BpmnExecutionState.ModelReference = {
    fingerprintVersion: BpmnExecutionState.BpmnExecutableFingerprintVersion,
    kernelSemanticVersion: KernelSemanticVersion,
    profileId: structure.profileId,
    modelKind: "BpmnModel",
    modelVersion: BpmnModel.BpmnModelVersion,
    bpmnSpecVersion: "2.0.2",
    rootProcessId: structure.rootProcessId,
    executableFingerprint
  }
  Object.freeze(modelReference)
  return authorizeKernel(structure, modelReference)
})

/**
 * Initializes one new execution and advances it to the next stable wait state.
 *
 * @category constructors
 * @since 4.0.0
 */
export const initialize = (
  kernel: CompiledKernel,
  commandInput: unknown,
  services: Services
): Result.Result<TransitionBatch, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
  const commandSnapshot = Json.snapshot(commandInput)
  if (Result.isFailure(commandSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      commandSnapshot.failure.message,
      ["command", ...commandSnapshot.failure.path]
    )))
  }
  const decodedCommand = decodeInitializeCommand(
    commandSnapshot.success
  )
  if (Result.isFailure(decodedCommand)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Invalid BPMN execution-start command",
      ["command"],
      { issue: String(decodedCommand.failure) }
    )))
  }
  const command = commandSnapshot.success as unknown as InitializeCommand
  const measuredInput = canonicalUtf8Bytes(command.input)
  if (Result.isFailure(measuredInput)) {
    return Result.fail(measuredInput.failure)
  }
  if (
    measuredInput.success >
      authority.limits.maxExecutionInputCanonicalBytes
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidKernelLimits,
      "Execution input exceeds the compiled canonical-byte limit",
      ["command", "input"],
      {
        actual: measuredInput.success,
        maximum: authority.limits.maxExecutionInputCanonicalBytes
      }
    )))
  }
  const resolvedServices = resolveServices(services)
  if (Result.isFailure(resolvedServices)) {
    return Result.fail(resolvedServices.failure)
  }
  const runtimeServices = resolvedServices.success
  const state: MutableState = {
    stateKind: "BpmnExecutionState",
    stateVersion: BpmnExecutionState.BpmnExecutionStateVersion,
    model: directClone(authority.modelReference),
    status: "active",
    input: directClone(command.input),
    startedAt: runtimeServices.now,
    extensionElements: [],
    scopeInstances: [],
    tokens: [],
    activityResolutions: [],
    gatewayFrames: [],
    loopFrames: [],
    multiInstanceGroups: [],
    callFrames: [],
    subscriptions: [],
    timers: [],
    workItems: [],
    compensationRegistrations: [],
    cancellationRegions: []
  }
  const journal: Array<TransitionEvent> = []
  recordEvent(journal, {
    _tag: "JournalStarted",
    journalVersion: TransitionJournalVersion,
    model: authority.modelReference,
    input: command.input,
    inputCanonicalBytes: measuredInput.success,
    startedAt: runtimeServices.now
  })
  const entered = enterScope(
    authority,
    state,
    authority.rootProcessId,
    authority.rootProcessId,
    undefined,
    `activation:${authority.rootProcessId}:1`,
    journal,
    runtimeServices.now
  )
  if (Result.isFailure(entered)) {
    return Result.fail(entered.failure)
  }
  const advanced = advanceMutable(authority, runtimeServices, state, journal)
  if (Result.isFailure(advanced)) {
    return Result.fail(advanced.failure)
  }
  const validated = validateKernelState(authority, state)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  return Result.succeed({
    state: validated.success,
    events: immutableEvents(journal)
  })
}

/**
 * Advances an existing execution to its next stable wait state.
 *
 * @category constructors
 * @since 4.0.0
 */
export const advance = (
  kernel: CompiledKernel,
  stateInput: unknown,
  services: Services
): Result.Result<TransitionBatch, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
  const validated = validateKernelState(authority, stateInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const resolvedServices = resolveServices(services, latestStateTimestamp(validated.success))
  if (Result.isFailure(resolvedServices)) {
    return Result.fail(resolvedServices.failure)
  }
  const state = directClone(validated.success) as MutableState
  const journal: Array<TransitionEvent> = []
  const advanced = advanceMutable(authority, resolvedServices.success, state, journal)
  if (Result.isFailure(advanced)) {
    return Result.fail(advanced.failure)
  }
  const checked = validateKernelState(authority, state)
  if (Result.isFailure(checked)) {
    return Result.fail(checked.failure)
  }
  return Result.succeed({
    state: checked.success,
    events: immutableEvents(journal)
  })
}

/**
 * Rebuilds and validates an execution solely from its ordered transition journal.
 *
 * **Details**
 *
 * The journal must begin with the events returned by {@link initialize} and
 * then contain every subsequent transition batch in order. Replay validates
 * causal ordering, deterministic identities, routing selections, join epochs,
 * lifecycle transitions, and the reconstructed marking before returning it.
 *
 * @category constructors
 * @since 4.0.0
 */
export const replay = (
  kernel: CompiledKernel,
  eventsInput: unknown
): Result.Result<BpmnExecutionState.BpmnExecutionState, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const eventsSnapshot = Json.snapshot(eventsInput)
  if (Result.isFailure(eventsSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidTransitionJournal,
      eventsSnapshot.failure.message,
      ["events", ...eventsSnapshot.failure.path]
    )))
  }
  const decoded = decodeTransitionJournal(eventsSnapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(error(
      Codes.InvalidTransitionJournal,
      "Invalid BPMN transition journal",
      ["events"],
      { issue: String(decoded.failure) }
    )))
  }
  return replayJournal(
    resolvedKernel.success,
    eventsSnapshot.success as unknown as TransitionJournal
  )
}

/**
 * Completes one waiting task token and advances the execution to stability.
 *
 * @category constructors
 * @since 4.0.0
 */
export const completeTask = (
  kernel: CompiledKernel,
  stateInput: unknown,
  commandInput: unknown,
  services: Services
): Result.Result<TransitionBatch, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
  const commandSnapshot = Json.snapshot(commandInput)
  if (Result.isFailure(commandSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      commandSnapshot.failure.message,
      ["command", ...commandSnapshot.failure.path]
    )))
  }
  const decodedCommand = decodeCompleteTaskCommand(commandSnapshot.success)
  if (Result.isFailure(decodedCommand)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Invalid task-completion command",
      ["command"],
      { issue: String(decodedCommand.failure) }
    )))
  }
  const command = commandSnapshot.success as unknown as CompleteTaskCommand
  const validated = validateKernelState(authority, stateInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const resolvedServices = resolveServices(services, latestStateTimestamp(validated.success))
  if (Result.isFailure(resolvedServices)) {
    return Result.fail(resolvedServices.failure)
  }
  const runtimeServices = resolvedServices.success
  const state = directClone(validated.success) as MutableState
  const journal: Array<TransitionEvent> = []
  const token = state.tokens.find((candidate) => candidate.tokenId === command.tokenId)
  if (token === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Unknown task token '${command.tokenId}'`,
      ["tokens"]
    )))
  }
  if (
    token.scopeInstanceId !== command.scopeInstanceId || token.position._tag !== "AtNode" ||
    token.position.nodeId !== command.taskNodeId
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task token '${command.tokenId}' does not match completion command`,
      ["tokens"]
    )))
  }
  if (authority.taskBindingByTaskNodeId.has(command.taskNodeId)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Protocol-v3-bound task '${command.taskNodeId}' requires resolveTask`,
      ["command", "taskNodeId"]
    )))
  }
  if (token.status !== "active") {
    recordEvent(journal, {
      _tag: "TaskCompletionReplayed",
      tokenId: token.tokenId,
      observedAt: runtimeServices.now
    })
    return Result.succeed({
      state: validated.success,
      events: immutableEvents(journal)
    })
  }
  const scope = findScope(state, token.scopeInstanceId)
  const node = authority.nodeById.get(command.taskNodeId)
  if (scope === undefined || node === undefined || node._tag !== "Task") {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task completion command targets an invalid task wait state`,
      ["tokens"]
    )))
  }
  consumeToken(token, journal, "task-completed", runtimeServices.now)
  const routed = node.loopCharacteristics?._tag ===
      "StandardLoopCharacteristics"
    ? completeStandardLoopIteration(
      authority,
      runtimeServices,
      state,
      node,
      scope,
      token,
      journal
    )
    : node.loopCharacteristics?._tag === "MultiInstanceCharacteristics"
    ? completeMultiInstanceMember(
      authority,
      runtimeServices,
      state,
      node,
      scope,
      token,
      journal
    )
    : routeActivityOutgoing(
      authority,
      runtimeServices,
      state,
      node,
      scope,
      journal
    )
  if (Result.isFailure(routed)) {
    return Result.fail(routed.failure)
  }
  const advanced = advanceMutable(authority, runtimeServices, state, journal)
  if (Result.isFailure(advanced)) {
    return Result.fail(advanced.failure)
  }
  const checked = validateKernelState(authority, state)
  if (Result.isFailure(checked)) {
    return Result.fail(checked.failure)
  }
  return Result.succeed({
    state: checked.success,
    events: immutableEvents(journal)
  })
}

/**
 * Applies one authenticated protocol-v3 logical-task outcome and advances the
 * BPMN execution to stability.
 *
 * **Details**
 *
 * The pure kernel authenticates only the immutable artifact and node
 * coordinates committed by its task binding. Producing this command from a
 * native Effect Workflow result remains the responsibility of a trusted
 * adapter. Only an exactly mapped application-failure identity may be
 * promoted to a BPMN Error.
 *
 * @category constructors
 * @since 4.0.0
 */
export const resolveTask = (
  kernel: CompiledKernel,
  stateInput: unknown,
  commandInput: unknown,
  services: Services
): Result.Result<TransitionBatch, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
  const commandSnapshot = Json.snapshot(commandInput)
  if (Result.isFailure(commandSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      commandSnapshot.failure.message,
      ["command", ...commandSnapshot.failure.path]
    )))
  }
  const decodedCommand = decodeResolveTaskCommand(commandSnapshot.success)
  if (Result.isFailure(decodedCommand)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Invalid protocol-v3 task-resolution command",
      ["command"],
      { issue: String(decodedCommand.failure) }
    )))
  }
  const command = commandSnapshot.success as unknown as ResolveTaskCommand
  const validated = validateKernelState(authority, stateInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const resolvedServices = resolveServices(
    services,
    latestStateTimestamp(validated.success)
  )
  if (Result.isFailure(resolvedServices)) {
    return Result.fail(resolvedServices.failure)
  }
  const runtimeServices = resolvedServices.success
  const state = directClone(validated.success) as MutableState
  const journal: Array<TransitionEvent> = []
  const token = state.tokens.find((candidate) => candidate.tokenId === command.tokenId)
  if (
    token === undefined ||
    token.scopeInstanceId !== command.scopeInstanceId ||
    token.position._tag !== "AtNode" ||
    token.position.nodeId !== command.taskNodeId
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task token '${command.tokenId}' does not match resolution command`,
      ["command", "tokenId"]
    )))
  }
  const binding = authority.taskBindingByTaskNodeId.get(command.taskNodeId)
  if (binding === undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task '${command.taskNodeId}' has no compiled protocol-v3 binding`,
      ["command", "taskNodeId"]
    )))
  }
  if (!bindingMatchesOutcome(binding, command.outcome)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Task outcome does not match the compiled artifact and semantic node for '${command.taskNodeId}'`,
      ["command", "outcome"]
    )))
  }
  const existing = state.activityResolutions.find((candidate) => candidate.tokenId === command.tokenId)
  if (existing !== undefined) {
    if (
      existing.taskNodeId !== command.taskNodeId ||
      existing.scopeInstanceId !== command.scopeInstanceId ||
      !sameJson(existing.outcome, command.outcome)
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidCommand,
        `Task token '${command.tokenId}' was already resolved with a different outcome`,
        ["command", "outcome"]
      )))
    }
    recordEvent(journal, {
      _tag: "TaskOutcomeReplayed",
      tokenId: command.tokenId,
      occurrenceDigest: command.outcome.occurrenceDigest,
      observedAt: runtimeServices.now
    })
    return Result.succeed({
      state: validated.success,
      events: immutableEvents(journal)
    })
  }
  if (token.status !== "active") {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      `Inactive bound task token '${command.tokenId}' has no durable activity resolution`,
      ["command", "tokenId"]
    )))
  }
  const scope = findScope(state, token.scopeInstanceId)
  const node = authority.nodeById.get(command.taskNodeId)
  if (scope === undefined || node?._tag !== "Task") {
    return Result.fail(compilationError(error(
      Codes.InvalidCommand,
      "Task resolution targets an invalid task wait state",
      ["command"]
    )))
  }
  const resolution: BpmnActivityV3.ActivityResolution = {
    resolutionVersion: BpmnActivityV3.ResolutionVersion,
    tokenId: token.tokenId,
    taskNodeId: node.id,
    scopeInstanceId: scope.scopeInstanceId,
    outcome: command.outcome,
    resolvedAt: runtimeServices.now
  }
  state.activityResolutions.push(directClone(resolution))
  recordEvent(journal, {
    _tag: "TaskOutcomeAccepted",
    resolution
  })

  if (command.outcome._tag === "Succeeded") {
    consumeToken(
      token,
      journal,
      "task-succeeded",
      runtimeServices.now
    )
    const routed = node.loopCharacteristics?._tag ===
        "StandardLoopCharacteristics"
      ? completeStandardLoopIteration(
        authority,
        runtimeServices,
        state,
        node,
        scope,
        token,
        journal
      )
      : node.loopCharacteristics?._tag === "MultiInstanceCharacteristics"
      ? completeMultiInstanceMember(
        authority,
        runtimeServices,
        state,
        node,
        scope,
        token,
        journal,
        command.outcome.output.value
      )
      : routeActivityOutgoing(
        authority,
        runtimeServices,
        state,
        node,
        scope,
        journal
      )
    if (Result.isFailure(routed)) {
      return Result.fail(routed.failure)
    }
  } else {
    const errorRef = mappedErrorRef(binding, command.outcome)
    const boundary = errorRef === undefined
      ? undefined
      : matchingBoundaryError(authority, node.id, errorRef)
    if (boundary === undefined) {
      const failed = failExecutionFromTask(
        state,
        token,
        node.id,
        errorRef === undefined
          ? "UnmappedBusinessFailure"
          : "UncaughtBpmnError",
        errorRef,
        journal,
        runtimeServices.now
      )
      if (Result.isFailure(failed)) {
        return Result.fail(failed.failure)
      }
    } else {
      withdrawToken(
        token,
        journal,
        "boundary-error-caught",
        runtimeServices.now
      )
      const loopBranch = standardLoopBranch(token.invocation)
      const loopFrame = loopBranch === undefined
        ? undefined
        : state.loopFrames.find((candidate) => candidate.frameId === loopBranch.frameId)
      if (loopFrame?.status === "active") {
        cancelStandardLoopFrame(
          loopFrame,
          token.tokenId,
          "boundary-error-caught",
          journal,
          runtimeServices.now
        )
      }
      const itemBranch = multiInstanceBranch(token.invocation)
      const multiInstanceGroup = itemBranch === undefined
        ? undefined
        : state.multiInstanceGroups.find((candidate) => candidate.groupId === itemBranch.groupId)
      if (multiInstanceGroup?.status === "active") {
        cancelMultiInstanceGroup(
          state,
          multiInstanceGroup,
          token.tokenId,
          "boundary-error-caught",
          journal,
          runtimeServices.now
        )
      }
      recordEvent(journal, {
        _tag: "BoundaryErrorCaught",
        tokenId: token.tokenId,
        taskNodeId: node.id,
        boundaryEventId: boundary.id,
        errorRef: errorRef!,
        caughtAt: runtimeServices.now
      })
      emitFlowTokens(
        state,
        journal,
        scope,
        authority.orderedOutgoingByNodeId.get(boundary.id) ?? [],
        runtimeServices.now
      )
    }
  }
  const advanced = advanceMutable(
    authority,
    runtimeServices,
    state,
    journal
  )
  if (Result.isFailure(advanced)) {
    return Result.fail(advanced.failure)
  }
  const checked = validateKernelState(authority, state)
  if (Result.isFailure(checked)) {
    return Result.fail(checked.failure)
  }
  return Result.succeed({
    state: checked.success,
    events: immutableEvents(journal)
  })
}
