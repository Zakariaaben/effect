/**
 * Pure executable BPMN token-kernel foundations.
 *
 * **Details**
 *
 * This module intentionally supports only one coherent executable subset of
 * BPMN 2.0.2: root and embedded subprocess scopes, none start and end events,
 * tasks, normal / conditional / default sequence flows, exclusive gateways,
 * and parallel gateways. Unsupported BPMN constructs are rejected at compile
 * time with aggregate diagnostics.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnExecutionState from "./BpmnExecutionState.ts"
import * as BpmnExpression from "./BpmnExpression.ts"
import * as BpmnExpressionEvaluator from "./BpmnExpressionEvaluator.ts"
import * as BpmnModel from "./BpmnModel.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as DigestV2 from "./DigestV2.ts"
import * as Json from "./internal/json.ts"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString
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
export const KernelSemanticVersion =
  BpmnExecutionState.BpmnKernelSemanticVersion

/**
 * Version of the transition-journal envelope represented by its leading
 * {@link TransitionEvent} header.
 *
 * @category constants
 * @since 4.0.0
 */
export const TransitionJournalVersion = 1 as const

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
      "parallel-join-arrival",
      "end-reached",
      "subprocess-entered"
    ]),
    consumedAt: ProtocolV2Wire.Timestamp
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
  Schema.TaggedStruct("ScopeCompleted", {
    scopeInstanceId: Identifier,
    definitionId: Identifier,
    exitedAt: ProtocolV2Wire.Timestamp
  }),
  Schema.TaggedStruct("ExecutionCompleted", {
    rootScopeInstanceId: Identifier,
    completedAt: ProtocolV2Wire.Timestamp
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
export interface EvaluationContext {
  readonly expression: BpmnModel.Expression
  readonly evaluatorBinding: BpmnExpression.EvaluatorBinding
  readonly request: BpmnExpressionEvaluator.EvaluationRequest
  readonly sequenceFlow: BpmnModel.SequenceFlow
  readonly sourceNode: BpmnModel.Task | BpmnModel.SubProcess | BpmnModel.Gateway
  readonly scopeInstance: BpmnExecutionState.ScopeInstance | MutableScopeInstance
  readonly state: BpmnExecutionState.BpmnExecutionState | MutableState
}

/**
 * Services needed while advancing executable BPMN state.
 *
 * @category models
 * @since 4.0.0
 */
export interface Services {
  readonly now: ProtocolV2Wire.Timestamp
  readonly evaluateCondition?: (
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
  maxAutomaticTransitions: PositiveInt
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
  evaluatorBindings: Schema.Array(BpmnExpression.EvaluatorBinding)
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
  readonly rootProcessId: string
  readonly rootStartEventId: string
  readonly limits: KernelLimits
  readonly startEventIdByScopeId: ReadonlyMap<string, string>
  readonly nodeById: ReadonlyMap<string, BpmnModel.FlowNode>
  readonly flowById: ReadonlyMap<string, BpmnModel.SequenceFlow>
  readonly orderedOutgoingByNodeId: ReadonlyMap<string, ReadonlyArray<string>>
}

interface CompiledStructure {
  readonly model: BpmnModel.BpmnModel
  readonly profileId: string
  readonly evaluatorBindings: ReadonlyArray<BpmnExpression.EvaluatorBinding>
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

const directClone = <A>(value: A): Mutable<A> => structuredClone(value) as Mutable<A>

const trustedKernels = new WeakMap<object, CompiledKernel>()
const decodeCompileOptions = Schema.decodeUnknownResult(
  CompileOptions,
  strictParseOptions
)
const decodeCompleteTaskCommand = Schema.decodeUnknownResult(CompleteTaskCommand, strictParseOptions)
const decodeTransitionJournal = Schema.decodeUnknownResult(TransitionJournal, strictParseOptions)
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
  const evaluatorDescriptor = descriptors.evaluateCondition
  if (
    evaluatorDescriptor !== undefined &&
    ("get" in evaluatorDescriptor ||
      (evaluatorDescriptor.value !== undefined && typeof evaluatorDescriptor.value !== "function"))
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidServices,
      "Token-kernel services.evaluateCondition must be an own function data property when present",
      ["services", "evaluateCondition"]
    )))
  }
  return Result.succeed({
    now,
    ...(evaluatorDescriptor?.value === undefined
      ? undefined
      : {
        evaluateCondition: evaluatorDescriptor.value as Exclude<
          Services["evaluateCondition"],
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

const sameInvocation = (
  left: BpmnExecutionState.InvocationIdentity,
  right: BpmnExecutionState.InvocationIdentity
): boolean =>
  left.activationId === right.activationId &&
  left.branchId === right.branchId &&
  left.loopIteration === right.loopIteration &&
  left.multiInstanceItemKey === right.multiInstanceItemKey &&
  left.generation === right.generation

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
        expectedExecutableFingerprint:
          kernel.modelReference.executableFingerprint,
        actualExecutableFingerprint: state.model.executableFingerprint
      }
    ))
  }
  if (state.status !== "active" && state.status !== "completed") {
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

  for (let index = 0; index < state.scopeInstances.length; index++) {
    const scope = state.scopeInstances[index]!
    if (scope.status !== "active" && scope.status !== "completed") {
      stateError(
        `Scope status '${scope.status}' is outside this token-kernel subset`,
        ["scopeInstances", index, "status"]
      )
    }
  }

  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index]!
    if (token.status !== "active" && token.status !== "consumed") {
      stateError(
        `Token status '${token.status}' is outside this token-kernel subset`,
        ["tokens", index, "status"]
      )
    }
    const scope = scopeById.get(token.scopeInstanceId)
    if (scope !== undefined && !sameInvocation(token.invocation, scope.invocation)) {
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
    }
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
    if (frame.status === "cancelled") {
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

  const unsupportedStructures = [
    ["loopFrames", state.loopFrames],
    ["multiInstanceGroups", state.multiInstanceGroups],
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

  if (state.status === "completed") {
    if (state.scopeInstances.some((scope) => scope.status === "active")) {
      stateError("A completed execution cannot retain active scopes", ["scopeInstances"])
    }
    if (state.tokens.some((token) => token.status === "active")) {
      stateError("A completed execution cannot retain active tokens", ["tokens"])
    }
    if (state.gatewayFrames.some((frame) => frame.status === "waiting" || frame.status === "satisfied")) {
      stateError("A completed execution cannot retain open gateway frames", ["gatewayFrames"])
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
  now: ProtocolV2Wire.Timestamp
): BpmnExecutionState.Token => ({
  tokenId: nextId(state.tokens.map((token) => token.tokenId), "token:"),
  processId: scopeInstance.processId,
  scopeInstanceId: scopeInstance.scopeInstanceId,
  invocation: directClone(scopeInstance.invocation),
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

const routeConditional = (
  kernel: CompiledKernel,
  services: Services,
  expression: BpmnModel.Expression,
  sequenceFlow: BpmnModel.SequenceFlow,
  sourceNode: BpmnModel.Task | BpmnModel.SubProcess | BpmnModel.Gateway,
  scopeInstance: MutableScopeInstance,
  state: MutableState,
  journal: Array<TransitionEvent>
): Result.Result<boolean, Diagnostic.CompilationError> => {
  if (services.evaluateCondition === undefined) {
    return Result.fail(compilationError(error(
      Codes.EvaluationRequired,
      `Conditional sequence flow '${sequenceFlow.id}' requires an evaluation service`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  const stateSnapshot = Json.snapshot(state)
  if (Result.isFailure(stateSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not create an immutable evaluation snapshot for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
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
      ["sequenceFlows"],
      {
        sequenceFlowId: sequenceFlow.id,
        language: expression.language,
        languageVersion: expression.version
      }
    )))
  }
  const contextSnapshot = Json.snapshot({
    expression,
    sequenceFlow,
    sourceNode,
    scopeInstance: frozenScope,
    state: frozenState
  })
  if (Result.isFailure(contextSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Could not create a canonical evaluator context for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
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
      `Could not measure evaluator input for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  if (sourceUtf8Bytes > evaluatorBinding.limits.maxSourceUtf8Bytes) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition source for sequence flow '${sequenceFlow.id}' exceeds its evaluator byte limit`,
      ["sequenceFlows"],
      {
        sequenceFlowId: sequenceFlow.id,
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
      `Condition context for sequence flow '${sequenceFlow.id}' exceeds its evaluator byte limit`,
      ["sequenceFlows"],
      {
        sequenceFlowId: sequenceFlow.id,
        actual: contextCanonicalBytes,
        maximum: evaluatorBinding.limits.maxContextCanonicalBytes
      }
    )))
  }
  const request: BpmnExpressionEvaluator.EvaluationRequest = {
    source: expression.source,
    context: contextSnapshot.success
  }

  let evaluated: unknown
  try {
    evaluated = services.evaluateCondition({
      expression,
      evaluatorBinding,
      request,
      sequenceFlow,
      sourceNode,
      scopeInstance: frozenScope,
      state: frozenState
    })
  } catch {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition evaluator threw for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  if (!Result.isResult(evaluated)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition evaluator returned an invalid result for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  if (Result.isFailure(evaluated)) {
    if (evaluated.failure instanceof Diagnostic.CompilationError) {
      return Result.fail(evaluated.failure)
    }
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition evaluator returned an invalid failure for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  const evaluatedSnapshot = Json.snapshot(evaluated.success)
  if (Result.isFailure(evaluatedSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition evaluator returned a non-JSON result for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  const decodedEvaluation = decodeEvaluationResult(evaluatedSnapshot.success)
  if (Result.isFailure(decodedEvaluation)) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition evaluator returned an invalid result for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      { sequenceFlowId: sequenceFlow.id }
    )))
  }
  const outcome = evaluatedSnapshot.success as unknown as
    BpmnExpressionEvaluator.EvaluationResult
  if (outcome.steps > evaluatorBinding.limits.maxSteps) {
    return Result.fail(compilationError(error(
      Codes.EvaluationFailed,
      `Condition evaluator exceeded its step limit for sequence flow '${sequenceFlow.id}'`,
      ["sequenceFlows"],
      {
        sequenceFlowId: sequenceFlow.id,
        actual: outcome.steps,
        maximum: evaluatorBinding.limits.maxSteps
      }
    )))
  }
  recordEvent(journal, {
    _tag: "ConditionEvaluated",
    sequenceFlowId: sequenceFlow.id,
    expression,
    evaluatorBinding,
    usage: {
      sourceUtf8Bytes,
      contextCanonicalBytes,
      steps: outcome.steps
    },
    result: outcome.result
  })
  return Result.succeed(outcome.result)
}

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
  reason: "flow-advanced" | "task-completed" | "parallel-join-arrival" | "end-reached" | "subprocess-entered",
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
  startedAt: ProtocolV2Wire.Timestamp
): MutableState => ({
  stateKind: "BpmnExecutionState",
  stateVersion: BpmnExecutionState.BpmnExecutionStateVersion,
  model: directClone(kernel.modelReference),
  status: "active",
  startedAt,
  extensionElements: [],
  scopeInstances: [],
  tokens: [],
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
        expectedExecutableFingerprint:
          kernel.modelReference.executableFingerprint,
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

  const state = emptyReplayState(kernel, header.startedAt)
  let pendingEmissions: Array<ExpectedEmission> = []
  let pendingRoute: PendingRoute | undefined
  let pendingScopeEntry: PendingScopeEntry | undefined
  let pendingGatewayArrival: PendingGatewayArrival | undefined
  let pendingTaskWait: PendingTaskWait | undefined
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

  for (let index = 1; index < events.length; index++) {
    const event = events[index]!
    const eventTimestamp = event._tag === "ScopeEntered"
      ? event.enteredAt
      : event._tag === "TokenConsumed"
      ? event.consumedAt
      : event._tag === "TokenEmitted"
      ? event.createdAt
      : event._tag === "TaskWaiting"
      ? event.enteredAt
      : event._tag === "GatewayFired"
      ? event.firedAt
      : event._tag === "TaskCompletionReplayed"
      ? event.observedAt
      : event._tag === "ScopeCompleted"
      ? event.exitedAt
      : event._tag === "ExecutionCompleted"
      ? event.completedAt
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
    if (pendingExecutionCompletion !== undefined && event._tag !== "ExecutionCompleted") {
      return journalFailure(index, "Root-scope completion must be followed by execution completion")
    }
    if (
      state.status === "completed" &&
      event._tag !== "TaskCompletionReplayed"
    ) {
      return journalFailure(index, "A completed execution cannot accept further state-changing events")
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
          if (task?._tag !== "Task" || event.reason !== "task-completed") {
            return journalFailure(index, `Token '${event.tokenId}' has an invalid task-consumption reason`)
          }
          pendingRoute = {
            sourceNode: task,
            scopeInstanceId: token.scopeInstanceId,
            routingKind: "activity",
            routedAt: event.consumedAt,
            evaluations: new Map()
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
            pendingEmissions = [{
              processId: scope.processId,
              scopeInstanceId: scope.scopeInstanceId,
              invocation: directClone(scope.invocation),
              position: { _tag: "AtNode", nodeId: target.id },
              createdAt: event.consumedAt
            }]
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

      case "TaskCompletionReplayed": {
        const token = state.tokens.find((candidate) => candidate.tokenId === event.tokenId)
        if (
          token === undefined ||
          token.status !== "consumed" ||
          token.position._tag !== "AtNode" ||
          token.consumedAt === undefined ||
          event.observedAt < token.consumedAt
        ) {
          return journalFailure(index, `Task-completion replay '${event.tokenId}' has no completed task token`)
        }
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
          state.gatewayFrames.some((frame) => frame.status === "waiting" || frame.status === "satisfied")
        ) {
          return journalFailure(index, "Execution completion is inconsistent with the terminal marking")
        }
        state.status = "completed"
        state.completedAt = event.completedAt
        pendingExecutionCompletion = undefined
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
    pendingExecutionCompletion !== undefined
  ) {
    return journalFailure(events.length, "The transition journal ends before its causal transition completes")
  }
  return validateKernelState(kernel, state)
}

const compileStructure = (
  modelInput: unknown,
  options: CompileOptions
): Result.Result<CompiledStructure, Diagnostic.CompilationError> => {
  const { limits, profileId, rootProcessId } = options
  const validated = BpmnModel.validate(modelInput)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const model = validated.success
  const diagnostics: Array<Diagnostic.Diagnostic> = []
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
    if (
      node._tag === "CallActivity" || node._tag === "Transaction" || node._tag === "AdHocSubProcess" ||
      node._tag === "EventSubProcess" || node._tag === "BoundaryEvent" || node._tag === "IntermediateCatchEvent" ||
      node._tag === "IntermediateThrowEvent"
    ) {
      diagnostics.push(error(
        node._tag === "BoundaryEvent" || node._tag === "IntermediateCatchEvent" ||
          node._tag === "IntermediateThrowEvent"
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
        diagnostics.push(error(
          Codes.UnsupportedLoop,
          `Node '${node.id}' loop characteristics are not executable in this token-kernel subset`,
          [...path, "loopCharacteristics"]
        ))
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
    rootProcessId,
    rootStartEventId: startEventIdByScopeId.get(rootProcessId)!,
    limits,
    startEventIdByScopeId: new Map(startEventIdByScopeId),
    nodeById: new Map(nodeById),
    flowById: new Map(flowById),
    orderedOutgoingByNodeId: internalOutgoing
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
    orderedOutgoingByNodeId: publicOutgoing
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
    fingerprintVersion:
      BpmnExecutionState.BpmnExecutableFingerprintVersion,
    kernelSemanticVersion: KernelSemanticVersion,
    bpmnSpecVersion: "2.0.2",
    profileId: structure.profileId,
    rootProcessId: structure.rootProcessId,
    limits: structure.limits,
    evaluatorBindings: structure.evaluatorBindings,
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
    fingerprintVersion:
      BpmnExecutionState.BpmnExecutableFingerprintVersion,
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
  services: Services
): Result.Result<TransitionBatch, Diagnostic.CompilationError> => {
  const resolvedKernel = resolveKernel(kernel)
  if (Result.isFailure(resolvedKernel)) {
    return Result.fail(resolvedKernel.failure)
  }
  const authority = resolvedKernel.success
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
    startedAt: runtimeServices.now,
    extensionElements: [],
    scopeInstances: [],
    tokens: [],
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
  const routed = routeActivityOutgoing(authority, runtimeServices, state, node, scope, journal)
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
