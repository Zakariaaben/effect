/**
 * Portable BPMN 2.0.2 semantic model foundations.
 *
 * **Details**
 *
 * This module defines a strict JSON semantic IR that can express BPMN process
 * structure without claiming BPMN conformance on its own. XML parsing,
 * interchange fidelity, and execution semantics remain separate concerns.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const isNcNameStart = (code: number): boolean =>
  code === 0x5f ||
  code >= 0x41 && code <= 0x5a ||
  code >= 0x61 && code <= 0x7a ||
  code >= 0xc0 && code <= 0xd6 ||
  code >= 0xd8 && code <= 0xf6 ||
  code >= 0xf8 && code <= 0x2ff ||
  code >= 0x370 && code <= 0x37d ||
  code >= 0x37f && code <= 0x1fff ||
  code >= 0x200c && code <= 0x200d ||
  code >= 0x2070 && code <= 0x218f ||
  code >= 0x2c00 && code <= 0x2fef ||
  code >= 0x3001 && code <= 0xd7ff ||
  code >= 0xf900 && code <= 0xfdcf ||
  code >= 0xfdf0 && code <= 0xfffd ||
  code >= 0x10000 && code <= 0xeffff

const isNcNameCharacter = (code: number): boolean =>
  isNcNameStart(code) ||
  code === 0x2d ||
  code === 0x2e ||
  code >= 0x30 && code <= 0x39 ||
  code === 0xb7 ||
  code >= 0x300 && code <= 0x36f ||
  code >= 0x203f && code <= 0x2040

const isNcName = (value: string): boolean => {
  if (value.length === 0 || value.includes(":")) {
    return false
  }
  let index = 0
  const first = value.codePointAt(index)
  if (first === undefined || !isNcNameStart(first)) {
    return false
  }
  index += first > 0xffff ? 2 : 1
  while (index < value.length) {
    const code = value.codePointAt(index)
    if (code === undefined || !isNcNameCharacter(code)) {
      return false
    }
    index += code > 0xffff ? 2 : 1
  }
  return true
}

const isCollapsedUri = (value: string): boolean =>
  value.length > 0 &&
  value === value
      .replaceAll(/[\t\n\r ]+/g, " ")
      .replace(/^ | $/g, "")

const actualEventDefinitionTags = [
  "MessageEventDefinition",
  "TimerEventDefinition",
  "SignalEventDefinition",
  "ErrorEventDefinition",
  "EscalationEventDefinition",
  "CompensationEventDefinition",
  "ConditionalEventDefinition",
  "LinkEventDefinition",
  "CancelEventDefinition",
  "TerminateEventDefinition"
] as const

const flowNodeTags = [
  "Task",
  "CallActivity",
  "SubProcess",
  "AdHocSubProcess",
  "Transaction",
  "EventSubProcess",
  "Gateway",
  "StartEvent",
  "BoundaryEvent",
  "IntermediateCatchEvent",
  "IntermediateThrowEvent",
  "EndEvent"
] as const

type FlowNodeTag = typeof flowNodeTags[number]
type ActualEventDefinitionTag = typeof actualEventDefinitionTags[number]

const scopeCarrierTags = new Set<FlowNodeTag>([
  "SubProcess",
  "AdHocSubProcess",
  "Transaction",
  "EventSubProcess"
])

const defaultCapableTags = new Set<FlowNodeTag>([
  "Task",
  "CallActivity",
  "SubProcess",
  "AdHocSubProcess",
  "Transaction",
  "Gateway"
])

const attachableActivityTags = new Set<FlowNodeTag>([
  "Task",
  "CallActivity",
  "SubProcess",
  "AdHocSubProcess",
  "Transaction"
])

const sortablePathKey = (path: ReadonlyArray<Diagnostic.PathSegment>): string =>
  path.map((segment) => typeof segment === "number" ? `#${segment}` : segment).join("/")

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

/**
 * One namespaced extension element retained by the semantic model.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExtensionElement = Schema.Struct({
  namespaceUri: Identifier,
  localName: Identifier,
  content: Schema.Json
}).annotate({
  identifier: "WorkflowBpmnExtensionElement",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExtensionElement}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExtensionElement = Schema.Schema.Type<typeof ExtensionElement>

/**
 * A pinned expression used by executable BPMN semantics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Expression = Schema.Struct({
  language: Identifier,
  version: Identifier,
  source: Identifier,
  metadata: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowBpmnExpression",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Expression}.
 *
 * @category models
 * @since 4.0.0
 */
export type Expression = Schema.Schema.Type<typeof Expression>

/**
 * Provenance and loss information for one model import.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ImportProvenance = Schema.Struct({
  importId: Identifier,
  sourceKind: Schema.Literals(["bpmn-xml", "manual", "adapter", "generated"]),
  locator: Schema.optionalKey(Identifier),
  importedAt: Schema.optionalKey(Identifier),
  sourceVersion: Schema.optionalKey(Identifier),
  lossReport: Schema.optionalKey(Schema.Json)
}).annotate({
  identifier: "WorkflowBpmnImportProvenance",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ImportProvenance}.
 *
 * @category models
 * @since 4.0.0
 */
export type ImportProvenance = Schema.Schema.Type<typeof ImportProvenance>

/**
 * Standard BPMN loop characteristics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StandardLoopCharacteristics = Schema.TaggedStruct("StandardLoopCharacteristics", {
  testBefore: Schema.Boolean,
  condition: Schema.optionalKey(Expression),
  loopMaximum: Schema.optionalKey(PositiveInt)
}).annotate({
  identifier: "WorkflowBpmnStandardLoopCharacteristics",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StandardLoopCharacteristics}.
 *
 * @category models
 * @since 4.0.0
 */
export type StandardLoopCharacteristics = Schema.Schema.Type<typeof StandardLoopCharacteristics>

/**
 * Standard BPMN sequential or parallel multi-instance characteristics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiInstanceCharacteristics = Schema.TaggedStruct("MultiInstanceCharacteristics", {
  mode: Schema.Literals(["sequential", "parallel"]),
  cardinality: Schema.optionalKey(Expression),
  loopDataInputRef: Schema.optionalKey(Identifier),
  loopDataOutputRef: Schema.optionalKey(Identifier),
  completionCondition: Schema.optionalKey(Expression),
  behavior: Schema.optionalKey(Schema.Literals(["all", "one", "none", "complex"])),
  oneBehaviorEventRef: Schema.optionalKey(Identifier),
  noneBehaviorEventRef: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnMultiInstanceCharacteristics",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MultiInstanceCharacteristics}.
 *
 * @category models
 * @since 4.0.0
 */
export type MultiInstanceCharacteristics = Schema.Schema.Type<typeof MultiInstanceCharacteristics>

/**
 * Supported BPMN activity loop characteristics.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LoopCharacteristics = Schema.Union([
  StandardLoopCharacteristics,
  MultiInstanceCharacteristics
]).annotate({ identifier: "WorkflowBpmnLoopCharacteristics" })

/**
 * The decoded type of {@link LoopCharacteristics}.
 *
 * @category models
 * @since 4.0.0
 */
export type LoopCharacteristics = Schema.Schema.Type<typeof LoopCharacteristics>

/**
 * A reusable BPMN message root element.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Message = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  itemRef: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnMessage",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Message}.
 *
 * @category models
 * @since 4.0.0
 */
export type Message = Schema.Schema.Type<typeof Message>

/**
 * A reusable BPMN signal root element.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Signal = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  structureRef: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnSignal",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Signal}.
 *
 * @category models
 * @since 4.0.0
 */
export type Signal = Schema.Schema.Type<typeof Signal>

/**
 * A reusable BPMN error root element.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Error = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  errorCode: Schema.optionalKey(Identifier),
  structureRef: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnError",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Error}.
 *
 * @category models
 * @since 4.0.0
 */
export type Error = Schema.Schema.Type<typeof Error>

/**
 * A reusable BPMN escalation root element.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Escalation = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  escalationCode: Schema.optionalKey(Identifier),
  structureRef: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnEscalation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Escalation}.
 *
 * @category models
 * @since 4.0.0
 */
export type Escalation = Schema.Schema.Type<typeof Escalation>

/**
 * A BPMN process root and its execution-relevant metadata.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Process = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  processType: Schema.optionalKey(Schema.Literals(["none", "public", "private"])),
  isClosed: Schema.optionalKey(Schema.Boolean),
  isExecutable: Schema.optionalKey(Schema.Boolean),
  definitionalCollaborationRef: Schema.optionalKey(Identifier),
  extensionElements: Schema.Array(ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnProcess",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Process}.
 *
 * @category models
 * @since 4.0.0
 */
export type Process = Schema.Schema.Type<typeof Process>

/**
 * Cardinality constraints for participant instances.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParticipantMultiplicity = Schema.Struct({
  minimum: Schema.optionalKey(NonNegativeInt),
  maximum: Schema.optionalKey(NonNegativeInt)
}).annotate({
  identifier: "WorkflowBpmnParticipantMultiplicity",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ParticipantMultiplicity}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParticipantMultiplicity = Schema.Schema.Type<typeof ParticipantMultiplicity>

/**
 * A BPMN collaboration participant, including black-box participants.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Participant = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  processId: Schema.optionalKey(Identifier),
  participantMultiplicity: Schema.optionalKey(ParticipantMultiplicity)
}).annotate({
  identifier: "WorkflowBpmnParticipant",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Participant}.
 *
 * @category models
 * @since 4.0.0
 */
export type Participant = Schema.Schema.Type<typeof Participant>

/**
 * A message flow between distinct collaboration participants.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessageFlow = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  sourceRef: Identifier,
  targetRef: Identifier,
  messageRef: Schema.optionalKey(Identifier),
  extensionElements: Schema.Array(ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnMessageFlow",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MessageFlow}.
 *
 * @category models
 * @since 4.0.0
 */
export type MessageFlow = Schema.Schema.Type<typeof MessageFlow>

/**
 * A BPMN collaboration and its participants and message flows.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Collaboration = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Identifier),
  isClosed: Schema.optionalKey(Schema.Boolean),
  participants: Schema.Array(Participant),
  messageFlows: Schema.optionalKey(Schema.Array(MessageFlow)),
  extensionElements: Schema.Array(ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnCollaboration",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Collaboration}.
 *
 * @category models
 * @since 4.0.0
 */
export type Collaboration = Schema.Schema.Type<typeof Collaboration>

const BaseFlowNodeFields = {
  id: Identifier,
  processId: Identifier,
  parentScopeId: Identifier,
  name: Schema.optionalKey(Identifier),
  incomingSequenceFlowIds: Schema.Array(Identifier),
  outgoingSequenceFlowIds: Schema.Array(Identifier),
  extensionElements: Schema.Array(ExtensionElement)
} as const

const DefaultFlowFields = {
  defaultFlowId: Schema.optionalKey(Identifier)
} as const

const ActivityFields = {
  ...BaseFlowNodeFields,
  ...DefaultFlowFields,
  loopCharacteristics: Schema.optionalKey(LoopCharacteristics),
  isForCompensation: Schema.optionalKey(Schema.Boolean),
  startQuantity: Schema.optionalKey(PositiveInt),
  completionQuantity: Schema.optionalKey(PositiveInt)
} as const

/**
 * Namespace-expanded form of an XML Schema QName.
 *
 * **Details**
 *
 * Prefix spellings are an XML serialization concern and are intentionally not
 * retained. This value identifies source-level BPMN references; executable
 * workflow targets must still be resolved and pinned by a durable compiler.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExpandedQName = Schema.Struct({
  namespaceUri: Schema.String,
  localName: Identifier
}).annotate({
  identifier: "WorkflowBpmnExpandedQName",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExpandedQName}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExpandedQName = Schema.Schema.Type<typeof ExpandedQName>

/**
 * A concrete BPMN task subtype.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Task = Schema.TaggedStruct("Task", {
  ...ActivityFields,
  taskKind: Schema.Literals([
    "generic",
    "user",
    "service",
    "script",
    "manual",
    "business-rule",
    "receive",
    "send"
  ]),
  implementation: Schema.optionalKey(Identifier),
  operationRef: Schema.optionalKey(Identifier),
  messageRef: Schema.optionalKey(Identifier),
  instantiate: Schema.optionalKey(Schema.Boolean),
  scriptFormat: Schema.optionalKey(Identifier),
  script: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnTask",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Task}.
 *
 * @category models
 * @since 4.0.0
 */
export type Task = Schema.Schema.Type<typeof Task>

/**
 * A BPMN call activity with a source-level callable-element QName.
 *
 * **Details**
 *
 * `calledElement` is not an executable deployment pin. A runtime compiler must
 * resolve it to an immutable child-workflow artifact before admitting a run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CallActivity = Schema.TaggedStruct("CallActivity", {
  ...ActivityFields,
  calledElement: Schema.optionalKey(ExpandedQName)
}).annotate({
  identifier: "WorkflowBpmnCallActivity",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CallActivity}.
 *
 * @category models
 * @since 4.0.0
 */
export type CallActivity = Schema.Schema.Type<typeof CallActivity>

/**
 * A regular embedded BPMN subprocess.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SubProcess = Schema.TaggedStruct("SubProcess", ActivityFields).annotate({
  identifier: "WorkflowBpmnSubProcess",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SubProcess}.
 *
 * @category models
 * @since 4.0.0
 */
export type SubProcess = Schema.Schema.Type<typeof SubProcess>

/**
 * A BPMN ad-hoc subprocess.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AdHocSubProcess = Schema.TaggedStruct("AdHocSubProcess", {
  ...ActivityFields,
  ordering: Schema.optionalKey(Schema.Literals(["parallel", "sequential"])),
  completionCondition: Schema.optionalKey(Expression),
  cancelRemainingInstances: Schema.optionalKey(Schema.Boolean)
}).annotate({
  identifier: "WorkflowBpmnAdHocSubProcess",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AdHocSubProcess}.
 *
 * @category models
 * @since 4.0.0
 */
export type AdHocSubProcess = Schema.Schema.Type<typeof AdHocSubProcess>

/**
 * A BPMN transaction subprocess.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Transaction = Schema.TaggedStruct("Transaction", {
  ...ActivityFields,
  method: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnTransaction",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Transaction}.
 *
 * @category models
 * @since 4.0.0
 */
export type Transaction = Schema.Schema.Type<typeof Transaction>

/**
 * A canonical BPMN event subprocess scope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EventSubProcess = Schema.TaggedStruct("EventSubProcess", BaseFlowNodeFields).annotate({
  identifier: "WorkflowBpmnEventSubProcess",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EventSubProcess}.
 *
 * @category models
 * @since 4.0.0
 */
export type EventSubProcess = Schema.Schema.Type<typeof EventSubProcess>

/**
 * A BPMN gateway with kind-specific semantic attributes.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Gateway = Schema.TaggedStruct("Gateway", {
  ...BaseFlowNodeFields,
  ...DefaultFlowFields,
  gatewayKind: Schema.Literals(["exclusive", "inclusive", "parallel", "event-based", "complex"]),
  gatewayDirection: Schema.Literals(["unspecified", "converging", "diverging", "mixed"]),
  instantiate: Schema.optionalKey(Schema.Boolean),
  eventGatewayType: Schema.optionalKey(Schema.Literals(["exclusive", "parallel"])),
  activationCondition: Schema.optionalKey(Expression)
}).annotate({
  identifier: "WorkflowBpmnGateway",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Gateway}.
 *
 * @category models
 * @since 4.0.0
 */
export type Gateway = Schema.Schema.Type<typeof Gateway>

const MessageEventDefinition = Schema.TaggedStruct("MessageEventDefinition", {
  messageRef: Schema.optionalKey(Identifier),
  operationRef: Schema.optionalKey(Identifier)
})

const TimerEventDefinition = Schema.TaggedStruct("TimerEventDefinition", {
  timeDate: Schema.optionalKey(Expression),
  timeDuration: Schema.optionalKey(Expression),
  timeCycle: Schema.optionalKey(Expression)
})

const SignalEventDefinition = Schema.TaggedStruct("SignalEventDefinition", {
  signalRef: Schema.optionalKey(Identifier)
})

const ErrorEventDefinition = Schema.TaggedStruct("ErrorEventDefinition", {
  errorRef: Schema.optionalKey(Identifier)
})

const EscalationEventDefinition = Schema.TaggedStruct("EscalationEventDefinition", {
  escalationRef: Schema.optionalKey(Identifier)
})

const CompensationEventDefinition = Schema.TaggedStruct("CompensationEventDefinition", {
  activityRef: Schema.optionalKey(Identifier),
  waitForCompletion: Schema.optionalKey(Schema.Boolean)
})

const ConditionalEventDefinition = Schema.TaggedStruct("ConditionalEventDefinition", {
  condition: Expression
})

const LinkEventDefinition = Schema.TaggedStruct("LinkEventDefinition", {
  name: Identifier,
  sourceRefs: Schema.Array(Identifier),
  targetRef: Schema.optionalKey(Identifier)
})

const CancelEventDefinition = Schema.TaggedStruct("CancelEventDefinition", {})

const TerminateEventDefinition = Schema.TaggedStruct("TerminateEventDefinition", {})

/**
 * An inline concrete BPMN event definition.
 *
 * **Details**
 *
 * Multiple and parallel-multiple events are represented by the number of
 * definitions on the carrier and its `parallelMultiple` flag, as required by
 * BPMN, rather than by invented event-definition subtypes.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EventDefinition = Schema.Union([
  MessageEventDefinition,
  TimerEventDefinition,
  SignalEventDefinition,
  ErrorEventDefinition,
  EscalationEventDefinition,
  CompensationEventDefinition,
  ConditionalEventDefinition,
  LinkEventDefinition,
  CancelEventDefinition,
  TerminateEventDefinition
]).annotate({ identifier: "WorkflowBpmnEventDefinition" })

/**
 * The decoded type of {@link EventDefinition}.
 *
 * @category models
 * @since 4.0.0
 */
export type EventDefinition = Schema.Schema.Type<typeof EventDefinition>

/**
 * Alias for a concrete inline {@link EventDefinition}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ConcreteEventDefinition = EventDefinition

/**
 * The decoded type of {@link ConcreteEventDefinition}.
 *
 * @category models
 * @since 4.0.0
 */
export type ConcreteEventDefinition = EventDefinition

/**
 * A reusable top-level BPMN event definition with stable identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeclaredEventDefinition = Schema.Union([
  Schema.TaggedStruct("MessageEventDefinition", {
    id: Identifier,
    messageRef: Schema.optionalKey(Identifier),
    operationRef: Schema.optionalKey(Identifier)
  }),
  Schema.TaggedStruct("TimerEventDefinition", {
    id: Identifier,
    timeDate: Schema.optionalKey(Expression),
    timeDuration: Schema.optionalKey(Expression),
    timeCycle: Schema.optionalKey(Expression)
  }),
  Schema.TaggedStruct("SignalEventDefinition", {
    id: Identifier,
    signalRef: Schema.optionalKey(Identifier)
  }),
  Schema.TaggedStruct("ErrorEventDefinition", {
    id: Identifier,
    errorRef: Schema.optionalKey(Identifier)
  }),
  Schema.TaggedStruct("EscalationEventDefinition", {
    id: Identifier,
    escalationRef: Schema.optionalKey(Identifier)
  }),
  Schema.TaggedStruct("CompensationEventDefinition", {
    id: Identifier,
    activityRef: Schema.optionalKey(Identifier),
    waitForCompletion: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.TaggedStruct("ConditionalEventDefinition", {
    id: Identifier,
    condition: Expression
  }),
  Schema.TaggedStruct("LinkEventDefinition", {
    id: Identifier,
    name: Identifier,
    sourceRefs: Schema.Array(Identifier),
    targetRef: Schema.optionalKey(Identifier)
  }),
  Schema.TaggedStruct("CancelEventDefinition", {
    id: Identifier
  }),
  Schema.TaggedStruct("TerminateEventDefinition", {
    id: Identifier
  })
]).annotate({ identifier: "WorkflowBpmnDeclaredEventDefinition" })

/**
 * The decoded type of {@link DeclaredEventDefinition}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeclaredEventDefinition = Schema.Schema.Type<typeof DeclaredEventDefinition>

const EventFields = {
  ...BaseFlowNodeFields,
  eventDefinitions: Schema.Array(EventDefinition),
  eventDefinitionRefs: Schema.Array(Identifier)
} as const

const CatchEventFields = {
  ...EventFields,
  parallelMultiple: Schema.optionalKey(Schema.Boolean)
} as const

/**
 * A BPMN start event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StartEvent = Schema.TaggedStruct("StartEvent", {
  ...CatchEventFields,
  isInterrupting: Schema.optionalKey(Schema.Boolean)
}).annotate({
  identifier: "WorkflowBpmnStartEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link StartEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export type StartEvent = Schema.Schema.Type<typeof StartEvent>

/**
 * A BPMN catch event attached to an activity boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BoundaryEvent = Schema.TaggedStruct("BoundaryEvent", {
  ...CatchEventFields,
  attachedToRef: Identifier,
  cancelActivity: Schema.optionalKey(Schema.Boolean)
}).annotate({
  identifier: "WorkflowBpmnBoundaryEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BoundaryEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export type BoundaryEvent = Schema.Schema.Type<typeof BoundaryEvent>

/**
 * A BPMN intermediate catch event in normal flow.
 *
 * @category schemas
 * @since 4.0.0
 */
export const IntermediateCatchEvent = Schema.TaggedStruct("IntermediateCatchEvent", CatchEventFields).annotate({
  identifier: "WorkflowBpmnIntermediateCatchEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link IntermediateCatchEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export type IntermediateCatchEvent = Schema.Schema.Type<typeof IntermediateCatchEvent>

/**
 * A BPMN intermediate throw event in normal flow.
 *
 * @category schemas
 * @since 4.0.0
 */
export const IntermediateThrowEvent = Schema.TaggedStruct("IntermediateThrowEvent", EventFields).annotate({
  identifier: "WorkflowBpmnIntermediateThrowEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link IntermediateThrowEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export type IntermediateThrowEvent = Schema.Schema.Type<typeof IntermediateThrowEvent>

/**
 * A BPMN end event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EndEvent = Schema.TaggedStruct("EndEvent", EventFields).annotate({
  identifier: "WorkflowBpmnEndEvent",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link EndEvent}.
 *
 * @category models
 * @since 4.0.0
 */
export type EndEvent = Schema.Schema.Type<typeof EndEvent>

/**
 * The supported BPMN process flow-node union.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FlowNode = Schema.Union([
  Task,
  CallActivity,
  SubProcess,
  AdHocSubProcess,
  Transaction,
  EventSubProcess,
  Gateway,
  StartEvent,
  BoundaryEvent,
  IntermediateCatchEvent,
  IntermediateThrowEvent,
  EndEvent
]).annotate({ identifier: "WorkflowBpmnFlowNode" })

/**
 * The decoded type of {@link FlowNode}.
 *
 * @category models
 * @since 4.0.0
 */
export type FlowNode = Schema.Schema.Type<typeof FlowNode>

/**
 * A typed BPMN sequence flow within one exact process scope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SequenceFlow = Schema.Struct({
  id: Identifier,
  processId: Identifier,
  parentScopeId: Identifier,
  sourceId: Identifier,
  targetId: Identifier,
  kind: Schema.Literals(["normal", "conditional", "default"]),
  isImmediate: Schema.optionalKey(Schema.Boolean),
  condition: Schema.optionalKey(Expression),
  name: Schema.optionalKey(Identifier),
  order: Schema.optionalKey(NonNegativeInt),
  extensionElements: Schema.Array(ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnSequenceFlow",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SequenceFlow}.
 *
 * @category models
 * @since 4.0.0
 */
export type SequenceFlow = Schema.Schema.Type<typeof SequenceFlow>

/**
 * Version of the BPMN semantic model document.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnModelVersion = 1 as const

/**
 * Strict portable BPMN 2.0.2 semantic model foundation.
 *
 * **Details**
 *
 * This schema is an execution-oriented semantic IR, not a BPMN XML document or
 * a conformance certificate. {@link validate} applies cross-reference, scope,
 * event, collaboration, and gateway rules that a structural schema cannot.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BpmnModel = Schema.Struct({
  modelKind: Schema.Literal("BpmnModel"),
  modelVersion: Schema.Literal(BpmnModelVersion),
  bpmnSpecVersion: Schema.Literal("2.0.2"),
  imports: Schema.Array(ImportProvenance),
  extensionElements: Schema.Array(ExtensionElement),
  messages: Schema.optionalKey(Schema.Array(Message)),
  signals: Schema.optionalKey(Schema.Array(Signal)),
  errors: Schema.optionalKey(Schema.Array(Error)),
  escalations: Schema.optionalKey(Schema.Array(Escalation)),
  eventDefinitions: Schema.optionalKey(Schema.Array(DeclaredEventDefinition)),
  collaborations: Schema.Array(Collaboration),
  processes: Schema.Array(Process),
  flowNodes: Schema.Array(FlowNode),
  sequenceFlows: Schema.Array(SequenceFlow)
}).annotate({
  identifier: "WorkflowBpmnModel",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BpmnModel}.
 *
 * @category models
 * @since 4.0.0
 */
export type BpmnModel = Schema.Schema.Type<typeof BpmnModel>

const decodeModel = Schema.decodeUnknownResult(BpmnModel, strictParseOptions)

/**
 * Stable BPMN semantic-model diagnostic codes.
 *
 * @category errors
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "InvalidJson",
  InvalidModel: "InvalidModel",
  DuplicateId: "DuplicateId",
  DuplicateProcessId: "DuplicateProcessId",
  UnknownProcessRef: "UnknownProcessRef",
  UnknownParentScopeRef: "UnknownParentScopeRef",
  InvalidParentScope: "InvalidParentScope",
  UnknownSequenceFlowRef: "UnknownSequenceFlowRef",
  InvalidSequenceFlowRef: "InvalidSequenceFlowRef",
  IllegalDefaultFlowRef: "IllegalDefaultFlowRef",
  InvalidSequenceFlow: "InvalidSequenceFlow",
  InvalidGateway: "InvalidGateway",
  InvalidTask: "InvalidTask",
  InvalidCallActivity: "InvalidCallActivity",
  InvalidEvent: "InvalidEvent",
  InvalidLoopCharacteristics: "InvalidLoopCharacteristics",
  UnknownMessageRef: "UnknownMessageRef",
  UnknownSignalRef: "UnknownSignalRef",
  UnknownErrorRef: "UnknownErrorRef",
  UnknownEscalationRef: "UnknownEscalationRef",
  UnknownEventDefinitionRef: "UnknownEventDefinitionRef",
  InvalidBoundaryEvent: "InvalidBoundaryEvent",
  InvalidParticipant: "InvalidParticipant",
  InvalidCollaboration: "InvalidCollaboration"
} as const

type Codes = typeof Codes[keyof typeof Codes]

const error = (
  code: Codes,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

const eventDefinitionAllowedByNode: Readonly<Record<FlowNodeTag, ReadonlyArray<ActualEventDefinitionTag>>> = {
  Task: [],
  CallActivity: [],
  SubProcess: [],
  AdHocSubProcess: [],
  Transaction: [],
  EventSubProcess: [],
  Gateway: [],
  StartEvent: [
    "MessageEventDefinition",
    "TimerEventDefinition",
    "SignalEventDefinition",
    "ErrorEventDefinition",
    "EscalationEventDefinition",
    "CompensationEventDefinition",
    "ConditionalEventDefinition"
  ],
  BoundaryEvent: [
    "MessageEventDefinition",
    "TimerEventDefinition",
    "SignalEventDefinition",
    "ErrorEventDefinition",
    "EscalationEventDefinition",
    "CompensationEventDefinition",
    "ConditionalEventDefinition",
    "CancelEventDefinition"
  ],
  IntermediateCatchEvent: [
    "MessageEventDefinition",
    "TimerEventDefinition",
    "SignalEventDefinition",
    "ConditionalEventDefinition",
    "LinkEventDefinition"
  ],
  IntermediateThrowEvent: [
    "MessageEventDefinition",
    "SignalEventDefinition",
    "EscalationEventDefinition",
    "CompensationEventDefinition",
    "LinkEventDefinition"
  ],
  EndEvent: [
    "MessageEventDefinition",
    "SignalEventDefinition",
    "ErrorEventDefinition",
    "EscalationEventDefinition",
    "CompensationEventDefinition",
    "CancelEventDefinition",
    "TerminateEventDefinition"
  ]
}

type EventCarrier = StartEvent | BoundaryEvent | IntermediateCatchEvent | IntermediateThrowEvent | EndEvent

const hasDefinitionTag = (
  definitions: ReadonlyArray<EventDefinition>,
  refs: ReadonlyArray<DeclaredEventDefinition>,
  tag: ActualEventDefinitionTag
): boolean =>
  definitions.some((definition) => definition._tag === tag) ||
  refs.some((definition) => definition._tag === tag)

const validateConcreteEventDefinition = (
  definition: EventDefinition | DeclaredEventDefinition,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  diagnostics: Array<Diagnostic.Diagnostic>,
  messageIds: ReadonlySet<string>,
  signalIds: ReadonlySet<string>,
  errorIds: ReadonlySet<string>,
  escalationIds: ReadonlySet<string>
): void => {
  switch (definition._tag) {
    case "MessageEventDefinition":
      if (definition.messageRef !== undefined && !messageIds.has(definition.messageRef)) {
        diagnostics.push(error(
          Codes.UnknownMessageRef,
          `Message event definition references unknown message '${definition.messageRef}'`,
          [...path, "messageRef"]
        ))
      }
      break
    case "TimerEventDefinition": {
      const declared = [
        definition.timeDate,
        definition.timeDuration,
        definition.timeCycle
      ].filter((value) => value !== undefined).length
      if (declared !== 1) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          "Timer event definition must declare exactly one of timeDate, timeDuration, or timeCycle",
          path
        ))
      }
      break
    }
    case "SignalEventDefinition":
      if (definition.signalRef !== undefined && !signalIds.has(definition.signalRef)) {
        diagnostics.push(error(
          Codes.UnknownSignalRef,
          `Signal event definition references unknown signal '${definition.signalRef}'`,
          [...path, "signalRef"]
        ))
      }
      break
    case "ErrorEventDefinition":
      if (definition.errorRef !== undefined && !errorIds.has(definition.errorRef)) {
        diagnostics.push(error(
          Codes.UnknownErrorRef,
          `Error event definition references unknown error '${definition.errorRef}'`,
          [...path, "errorRef"]
        ))
      }
      break
    case "EscalationEventDefinition":
      if (definition.escalationRef !== undefined && !escalationIds.has(definition.escalationRef)) {
        diagnostics.push(error(
          Codes.UnknownEscalationRef,
          `Escalation event definition references unknown escalation '${definition.escalationRef}'`,
          [...path, "escalationRef"]
        ))
      }
      break
    case "LinkEventDefinition":
      if (definition.sourceRefs.length > 0 && definition.targetRef !== undefined) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          "Link event definition cannot be both a source and a target link",
          path
        ))
      }
      if (new Set(definition.sourceRefs).size !== definition.sourceRefs.length) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          "Link event definition cannot repeat a source reference",
          [...path, "sourceRefs"]
        ))
      }
      break
  }
}

const validateEventCarrier = (
  node: EventCarrier,
  nodePath: ReadonlyArray<Diagnostic.PathSegment>,
  diagnostics: Array<Diagnostic.Diagnostic>,
  declaredEventDefinitions: ReadonlyMap<string, DeclaredEventDefinition>,
  messageIds: ReadonlySet<string>,
  signalIds: ReadonlySet<string>,
  errorIds: ReadonlySet<string>,
  escalationIds: ReadonlySet<string>,
  scopeOwners: ReadonlyMap<string, FlowNode>,
  nodeById: ReadonlyMap<string, FlowNode>
): void => {
  const allowed = eventDefinitionAllowedByNode[node._tag]
  const inlineDefinitions = [...node.eventDefinitions]
  const referencedDefinitions: Array<DeclaredEventDefinition> = []
  const seenEventDefinitionRefs = new Set<string>()

  for (let index = 0; index < node.eventDefinitions.length; index++) {
    validateConcreteEventDefinition(
      node.eventDefinitions[index]!,
      [...nodePath, "eventDefinitions", index],
      diagnostics,
      messageIds,
      signalIds,
      errorIds,
      escalationIds
    )
  }

  for (let index = 0; index < node.eventDefinitionRefs.length; index++) {
    const ref = node.eventDefinitionRefs[index]!
    if (seenEventDefinitionRefs.has(ref)) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `Event '${node.id}' references event definition '${ref}' more than once`,
        [...nodePath, "eventDefinitionRefs", index]
      ))
      continue
    }
    seenEventDefinitionRefs.add(ref)
    const declaration = declaredEventDefinitions.get(ref)
    if (declaration === undefined) {
      diagnostics.push(error(
        Codes.UnknownEventDefinitionRef,
        `Event '${node.id}' references unknown event definition '${ref}'`,
        [...nodePath, "eventDefinitionRefs", index]
      ))
      continue
    }
    referencedDefinitions.push(declaration)
    validateConcreteEventDefinition(
      declaration,
      [...nodePath, "eventDefinitionRefs", index],
      diagnostics,
      messageIds,
      signalIds,
      errorIds,
      escalationIds
    )
  }

  const totalDefinitionCount = inlineDefinitions.length + referencedDefinitions.length

  for (let index = 0; index < inlineDefinitions.length; index++) {
    const definition = inlineDefinitions[index]!
    if (!allowed.includes(definition._tag)) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `${node._tag} '${node.id}' cannot use event definition '${definition._tag}'`,
        [...nodePath, "eventDefinitions", index, "_tag"]
      ))
    }
  }

  for (let index = 0; index < referencedDefinitions.length; index++) {
    const definition = referencedDefinitions[index]!
    if (!allowed.includes(definition._tag)) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `${node._tag} '${node.id}' cannot reference event definition '${definition._tag}'`,
        [...nodePath, "eventDefinitionRefs", index]
      ))
    }
  }

  if (node._tag === "IntermediateCatchEvent" || node._tag === "BoundaryEvent") {
    if (totalDefinitionCount === 0) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `${node._tag} '${node.id}' must declare at least one event definition or reference`,
        [...nodePath, "eventDefinitions"]
      ))
    }
  }

  if (node._tag === "StartEvent") {
    const owner = scopeOwners.get(node.parentScopeId)
    const inEventSubProcess = owner?._tag === "EventSubProcess"
    if (inEventSubProcess && totalDefinitionCount === 0) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `Start event '${node.id}' inside an event subprocess must declare a trigger`,
        [...nodePath, "eventDefinitions"]
      ))
    }
    if (owner !== undefined && !inEventSubProcess && totalDefinitionCount > 0) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `Start event '${node.id}' inside '${owner._tag}' must be a none start event`,
        [...nodePath, "eventDefinitions"]
      ))
    }
    if (
      !inEventSubProcess && (
        hasDefinitionTag(inlineDefinitions, referencedDefinitions, "ErrorEventDefinition") ||
        hasDefinitionTag(inlineDefinitions, referencedDefinitions, "EscalationEventDefinition") ||
        hasDefinitionTag(inlineDefinitions, referencedDefinitions, "CompensationEventDefinition")
      )
    ) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `Start event '${node.id}' may only use escalation, error, or compensation triggers inside an event subprocess`,
        [...nodePath, "eventDefinitions"]
      ))
    }
    if (
      inEventSubProcess &&
      node.isInterrupting === false &&
      hasDefinitionTag(inlineDefinitions, referencedDefinitions, "ErrorEventDefinition")
    ) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `Error start event '${node.id}' in an event subprocess must be interrupting`,
        [...nodePath, "isInterrupting"]
      ))
    }
  }

  if ("parallelMultiple" in node && node.parallelMultiple === true && totalDefinitionCount < 2) {
    diagnostics.push(error(
      Codes.InvalidEvent,
      `Parallel-multiple catch event '${node.id}' requires at least two event definitions`,
      [...nodePath, "parallelMultiple"]
    ))
  }
  if (
    hasDefinitionTag(inlineDefinitions, referencedDefinitions, "LinkEventDefinition") &&
    totalDefinitionCount !== 1
  ) {
    diagnostics.push(error(
      Codes.InvalidEvent,
      `Link event '${node.id}' must have exactly one link event definition`,
      [...nodePath, "eventDefinitions"]
    ))
  }

  if (node._tag === "BoundaryEvent") {
    const hasCancel = hasDefinitionTag(inlineDefinitions, referencedDefinitions, "CancelEventDefinition")
    const hasCompensation = hasDefinitionTag(
      inlineDefinitions,
      referencedDefinitions,
      "CompensationEventDefinition"
    )
    const hasError = hasDefinitionTag(inlineDefinitions, referencedDefinitions, "ErrorEventDefinition")
    const attached = nodeById.get(node.attachedToRef)
    if (attached === undefined) {
      diagnostics.push(error(
        Codes.InvalidBoundaryEvent,
        `Boundary event '${node.id}' references unknown attached node '${node.attachedToRef}'`,
        [...nodePath, "attachedToRef"]
      ))
    } else {
      if (!attachableActivityTags.has(attached._tag)) {
        diagnostics.push(error(
          Codes.InvalidBoundaryEvent,
          `Boundary event '${node.id}' must attach to an activity-like node`,
          [...nodePath, "attachedToRef"]
        ))
      }
      if (attached.processId !== node.processId || attached.parentScopeId !== node.parentScopeId) {
        diagnostics.push(error(
          Codes.InvalidBoundaryEvent,
          `Boundary event '${node.id}' must share the exact parent scope of its attached node`,
          [...nodePath, "attachedToRef"]
        ))
      }
      if (hasCancel && attached._tag !== "Transaction") {
        diagnostics.push(error(
          Codes.InvalidBoundaryEvent,
          `Boundary cancel event '${node.id}' must attach to a transaction`,
          [...nodePath, "attachedToRef"]
        ))
      }
    }
    if (node.incomingSequenceFlowIds.length > 0) {
      diagnostics.push(error(
        Codes.InvalidBoundaryEvent,
        `Boundary event '${node.id}' cannot have incoming sequence flows`,
        [...nodePath, "incomingSequenceFlowIds"]
      ))
    }
    if ((hasError || hasCancel) && node.cancelActivity === false) {
      diagnostics.push(error(
        Codes.InvalidBoundaryEvent,
        `Boundary error or cancel event '${node.id}' must interrupt its attached activity`,
        [...nodePath, "cancelActivity"]
      ))
    }
    if (hasCompensation && node.cancelActivity !== undefined) {
      diagnostics.push(error(
        Codes.InvalidBoundaryEvent,
        `Boundary compensation event '${node.id}' cannot apply cancelActivity`,
        [...nodePath, "cancelActivity"]
      ))
    }
    if (hasCompensation && node.outgoingSequenceFlowIds.length > 0) {
      diagnostics.push(error(
        Codes.InvalidBoundaryEvent,
        `Boundary compensation event '${node.id}' cannot have outgoing sequence flows`,
        [...nodePath, "outgoingSequenceFlowIds"]
      ))
    }
    if (!hasCompensation && node.outgoingSequenceFlowIds.length === 0) {
      diagnostics.push(error(
        Codes.InvalidBoundaryEvent,
        `Boundary event '${node.id}' must have an outgoing sequence flow`,
        [...nodePath, "outgoingSequenceFlowIds"]
      ))
    }
  }

  if (node._tag === "EndEvent") {
    let withinTransaction = false
    let scopeId = node.parentScopeId
    while (scopeId !== node.processId) {
      const owner = scopeOwners.get(scopeId)
      if (owner === undefined) {
        break
      }
      if (owner._tag === "Transaction") {
        withinTransaction = true
        break
      }
      scopeId = owner.parentScopeId
    }
    if (
      hasDefinitionTag(inlineDefinitions, referencedDefinitions, "CancelEventDefinition") &&
      !withinTransaction
    ) {
      diagnostics.push(error(
        Codes.InvalidEvent,
        `Cancel end event '${node.id}' must be contained by a transaction`,
        [...nodePath, "eventDefinitions"]
      ))
    }
  }
}

const validateLoopCharacteristics = (
  node: Task | CallActivity | SubProcess | AdHocSubProcess | Transaction,
  nodePath: ReadonlyArray<Diagnostic.PathSegment>,
  diagnostics: Array<Diagnostic.Diagnostic>
): void => {
  const characteristics = node.loopCharacteristics
  if (
    characteristics === undefined ||
    characteristics._tag !== "MultiInstanceCharacteristics"
  ) {
    return
  }

  const path = [...nodePath, "loopCharacteristics"] as const
  const hasCardinality = characteristics.cardinality !== undefined
  const hasCollection = characteristics.loopDataInputRef !== undefined

  if (!hasCardinality && !hasCollection) {
    diagnostics.push(error(
      Codes.InvalidLoopCharacteristics,
      `Multi-instance activity '${node.id}' must declare exactly one instance source: cardinality or loopDataInputRef`,
      path
    ))
  } else if (hasCardinality && hasCollection) {
    diagnostics.push(error(
      Codes.InvalidLoopCharacteristics,
      `Multi-instance activity '${node.id}' cannot declare both cardinality and loopDataInputRef`,
      [...path, "loopDataInputRef"]
    ))
  }

  if (
    characteristics.loopDataOutputRef !== undefined &&
    characteristics.loopDataInputRef === undefined
  ) {
    diagnostics.push(error(
      Codes.InvalidLoopCharacteristics,
      `Multi-instance activity '${node.id}' loopDataOutputRef requires loopDataInputRef`,
      [...path, "loopDataOutputRef"]
    ))
  }

  if (
    characteristics.oneBehaviorEventRef !== undefined &&
    characteristics.behavior !== "one"
  ) {
    diagnostics.push(error(
      Codes.InvalidLoopCharacteristics,
      `Multi-instance activity '${node.id}' oneBehaviorEventRef requires behavior 'one'`,
      [...path, "oneBehaviorEventRef"]
    ))
  }

  if (
    characteristics.noneBehaviorEventRef !== undefined &&
    characteristics.behavior !== "none"
  ) {
    diagnostics.push(error(
      Codes.InvalidLoopCharacteristics,
      `Multi-instance activity '${node.id}' noneBehaviorEventRef requires behavior 'none'`,
      [...path, "noneBehaviorEventRef"]
    ))
  }
}

/**
 * Snapshots, strictly decodes, and semantically validates a BPMN model.
 *
 * **Details**
 *
 * Validation accumulates deterministic diagnostics and never invokes getters
 * on the caller's input.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown
): Result.Result<BpmnModel, Diagnostic.CompilationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(compilationError(
      error(
        Codes.InvalidJson,
        snapshot.failure.message,
        snapshot.failure.path
      )
    ))
  }

  const decoded = decodeModel(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(
      error(
        Codes.InvalidModel,
        "Invalid BPMN semantic model document",
        [],
        { issue: String(decoded.failure) }
      )
    ))
  }

  const model = snapshot.success as unknown as BpmnModel
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const ids = new Map<string, ReadonlyArray<Diagnostic.PathSegment>>()
  const processIds = new Map<string, number>()
  const collaborationIds = new Set<string>()
  const scopeOwners = new Map<string, FlowNode>()
  const nodeById = new Map<string, FlowNode>()
  const flowById = new Map<string, SequenceFlow>()
  const childrenByScopeId = new Map<string, Array<FlowNode>>()
  const messageIds = new Set((model.messages ?? []).map((value) => value.id))
  const signalIds = new Set((model.signals ?? []).map((value) => value.id))
  const errorIds = new Set((model.errors ?? []).map((value) => value.id))
  const escalationIds = new Set((model.escalations ?? []).map((value) => value.id))
  const declaredEventDefinitions = new Map<string, DeclaredEventDefinition>()

  const registerId = (
    id: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const previous = ids.get(id)
    if (previous !== undefined) {
      diagnostics.push(error(
        Codes.DuplicateId,
        `Duplicate BPMN id '${id}'`,
        path,
        { firstPath: sortablePathKey(previous) }
      ))
    } else {
      ids.set(id, path)
    }
  }

  for (let index = 0; index < model.processes.length; index++) {
    const process = model.processes[index]!
    const path = ["processes", index, "id"] as const
    if (processIds.has(process.id)) {
      diagnostics.push(error(
        Codes.DuplicateProcessId,
        `Duplicate process id '${process.id}'`,
        path
      ))
    } else {
      processIds.set(process.id, index)
    }
    registerId(process.id, path)
  }

  for (let index = 0; index < (model.messages ?? []).length; index++) {
    registerId(model.messages![index]!.id, ["messages", index, "id"])
  }
  for (let index = 0; index < (model.signals ?? []).length; index++) {
    registerId(model.signals![index]!.id, ["signals", index, "id"])
  }
  for (let index = 0; index < (model.errors ?? []).length; index++) {
    registerId(model.errors![index]!.id, ["errors", index, "id"])
  }
  for (let index = 0; index < (model.escalations ?? []).length; index++) {
    registerId(model.escalations![index]!.id, ["escalations", index, "id"])
  }

  for (let index = 0; index < (model.eventDefinitions ?? []).length; index++) {
    const definition = model.eventDefinitions![index]!
    registerId(definition.id, ["eventDefinitions", index, "id"])
    declaredEventDefinitions.set(definition.id, definition)
    validateConcreteEventDefinition(
      definition,
      ["eventDefinitions", index],
      diagnostics,
      messageIds,
      signalIds,
      errorIds,
      escalationIds
    )
  }
  for (let index = 0; index < (model.eventDefinitions ?? []).length; index++) {
    const definition = model.eventDefinitions![index]!
    if (definition._tag !== "LinkEventDefinition") {
      continue
    }
    const refs = [
      ...definition.sourceRefs.map((ref, sourceIndex) => ({
        ref,
        path: ["eventDefinitions", index, "sourceRefs", sourceIndex] as const
      })),
      ...(definition.targetRef === undefined
        ? []
        : [{
          ref: definition.targetRef,
          path: ["eventDefinitions", index, "targetRef"] as const
        }])
    ]
    for (const { path, ref } of refs) {
      const target = declaredEventDefinitions.get(ref)
      if (target === undefined) {
        diagnostics.push(error(
          Codes.UnknownEventDefinitionRef,
          `Link event definition '${definition.id}' references unknown event definition '${ref}'`,
          path
        ))
      } else if (target._tag !== "LinkEventDefinition") {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `Link event definition '${definition.id}' must reference another link event definition`,
          path
        ))
      }
    }
  }

  for (let index = 0; index < model.collaborations.length; index++) {
    const collaboration = model.collaborations[index]!
    registerId(collaboration.id, ["collaborations", index, "id"])
    collaborationIds.add(collaboration.id)
    const participantProcessIds = new Set<string>()
    for (let participantIndex = 0; participantIndex < collaboration.participants.length; participantIndex++) {
      const participant = collaboration.participants[participantIndex]!
      const participantPath = ["collaborations", index, "participants", participantIndex] as const
      registerId(participant.id, [...participantPath, "id"])
      if (participant.processId !== undefined && !processIds.has(participant.processId)) {
        diagnostics.push(error(
          Codes.UnknownProcessRef,
          `Participant '${participant.id}' references unknown process '${participant.processId}'`,
          [...participantPath, "processId"]
        ))
      }
      if (
        participant.processId !== undefined &&
        participantProcessIds.has(participant.processId)
      ) {
        diagnostics.push(error(
          Codes.InvalidCollaboration,
          `Collaboration '${collaboration.id}' contains more than one participant for process '${participant.processId}'`,
          [...participantPath, "processId"]
        ))
      } else if (participant.processId !== undefined) {
        participantProcessIds.add(participant.processId)
      }
      if (
        participant.participantMultiplicity?.minimum !== undefined &&
        participant.participantMultiplicity.maximum !== undefined &&
        participant.participantMultiplicity.maximum < participant.participantMultiplicity.minimum
      ) {
        diagnostics.push(error(
          Codes.InvalidParticipant,
          `Participant '${participant.id}' has multiplicity maximum below minimum`,
          [...participantPath, "participantMultiplicity"]
        ))
      }
    }
    for (let messageFlowIndex = 0; messageFlowIndex < (collaboration.messageFlows ?? []).length; messageFlowIndex++) {
      const messageFlow = collaboration.messageFlows![messageFlowIndex]!
      const messageFlowPath = ["collaborations", index, "messageFlows", messageFlowIndex] as const
      registerId(messageFlow.id, [...messageFlowPath, "id"])
      if (!ids.has(messageFlow.sourceRef) && !nodeById.has(messageFlow.sourceRef)) {
        // deferred check after all nodes are registered
      }
      if (messageFlow.messageRef !== undefined && !messageIds.has(messageFlow.messageRef)) {
        diagnostics.push(error(
          Codes.UnknownMessageRef,
          `Message flow '${messageFlow.id}' references unknown message '${messageFlow.messageRef}'`,
          [...messageFlowPath, "messageRef"]
        ))
      }
    }
  }

  for (let index = 0; index < model.processes.length; index++) {
    const process = model.processes[index]!
    if (
      process.definitionalCollaborationRef !== undefined &&
      !collaborationIds.has(process.definitionalCollaborationRef)
    ) {
      diagnostics.push(error(
        Codes.InvalidCollaboration,
        `Process '${process.id}' references unknown definitional collaboration '${process.definitionalCollaborationRef}'`,
        ["processes", index, "definitionalCollaborationRef"]
      ))
    }
  }

  for (let index = 0; index < model.flowNodes.length; index++) {
    const node = model.flowNodes[index]!
    registerId(node.id, ["flowNodes", index, "id"])
    nodeById.set(node.id, node)
    if (scopeCarrierTags.has(node._tag)) {
      scopeOwners.set(node.id, node)
    }
    const children = childrenByScopeId.get(node.parentScopeId)
    if (children === undefined) {
      childrenByScopeId.set(node.parentScopeId, [node])
    } else {
      children.push(node)
    }
    if (!processIds.has(node.processId)) {
      diagnostics.push(error(
        Codes.UnknownProcessRef,
        `Flow node '${node.id}' references unknown process '${node.processId}'`,
        ["flowNodes", index, "processId"]
      ))
    }
  }

  for (let index = 0; index < model.sequenceFlows.length; index++) {
    const flow = model.sequenceFlows[index]!
    registerId(flow.id, ["sequenceFlows", index, "id"])
    flowById.set(flow.id, flow)
    if (!processIds.has(flow.processId)) {
      diagnostics.push(error(
        Codes.UnknownProcessRef,
        `Sequence flow '${flow.id}' references unknown process '${flow.processId}'`,
        ["sequenceFlows", index, "processId"]
      ))
    }
  }

  for (let index = 0; index < model.collaborations.length; index++) {
    const collaboration = model.collaborations[index]!
    const participantById = new Map(
      collaboration.participants.map((participant) => [participant.id, participant] as const)
    )
    const participantByProcessId = new Map(
      collaboration.participants.flatMap((participant) =>
        participant.processId === undefined
          ? []
          : [[participant.processId, participant] as const]
      )
    )
    const resolveEndpointParticipant = (ref: string): Participant | undefined => {
      const participant = participantById.get(ref)
      if (participant !== undefined) {
        return participant
      }
      const node = nodeById.get(ref)
      return node === undefined ? undefined : participantByProcessId.get(node.processId)
    }
    for (let messageFlowIndex = 0; messageFlowIndex < (collaboration.messageFlows ?? []).length; messageFlowIndex++) {
      const messageFlow = collaboration.messageFlows![messageFlowIndex]!
      const messageFlowPath = ["collaborations", index, "messageFlows", messageFlowIndex] as const
      const sourceEndpointExists = participantById.has(messageFlow.sourceRef) || nodeById.has(messageFlow.sourceRef)
      const targetEndpointExists = participantById.has(messageFlow.targetRef) || nodeById.has(messageFlow.targetRef)
      if (!sourceEndpointExists) {
        diagnostics.push(error(
          Codes.InvalidCollaboration,
          `Message flow '${messageFlow.id}' references unknown source '${messageFlow.sourceRef}'`,
          [...messageFlowPath, "sourceRef"]
        ))
      }
      if (!targetEndpointExists) {
        diagnostics.push(error(
          Codes.InvalidCollaboration,
          `Message flow '${messageFlow.id}' references unknown target '${messageFlow.targetRef}'`,
          [...messageFlowPath, "targetRef"]
        ))
      }
      const sourceParticipant = resolveEndpointParticipant(messageFlow.sourceRef)
      const targetParticipant = resolveEndpointParticipant(messageFlow.targetRef)
      if (
        sourceEndpointExists &&
        targetEndpointExists &&
        (sourceParticipant === undefined || targetParticipant === undefined)
      ) {
        diagnostics.push(error(
          Codes.InvalidCollaboration,
          `Message flow '${messageFlow.id}' must connect endpoints owned by participants in collaboration '${collaboration.id}'`,
          messageFlowPath
        ))
      } else if (
        sourceParticipant !== undefined &&
        targetParticipant !== undefined &&
        sourceParticipant.id === targetParticipant.id
      ) {
        diagnostics.push(error(
          Codes.InvalidCollaboration,
          `Message flow '${messageFlow.id}' cannot connect two endpoints in participant '${sourceParticipant.id}'`,
          messageFlowPath
        ))
      }
    }
  }

  for (let index = 0; index < model.flowNodes.length; index++) {
    const node = model.flowNodes[index]!
    const nodePath = ["flowNodes", index] as const

    if ("loopCharacteristics" in node) {
      validateLoopCharacteristics(node, nodePath, diagnostics)
    }

    if (node._tag === "CallActivity" && node.calledElement !== undefined) {
      if (!isNcName(node.calledElement.localName)) {
        diagnostics.push(error(
          Codes.InvalidCallActivity,
          `Call activity '${node.id}' calledElement local name is not an XML Schema NCName`,
          [...nodePath, "calledElement", "localName"]
        ))
      }
      if (
        node.calledElement.namespaceUri.length > 0 &&
        !isCollapsedUri(node.calledElement.namespaceUri)
      ) {
        diagnostics.push(error(
          Codes.InvalidCallActivity,
          `Call activity '${node.id}' calledElement namespace must be a whitespace-collapsed XML Schema anyURI`,
          [...nodePath, "calledElement", "namespaceUri"]
        ))
      }
    }

    if (node.parentScopeId === node.id) {
      diagnostics.push(error(
        Codes.InvalidParentScope,
        `Flow node '${node.id}' cannot contain itself`,
        [...nodePath, "parentScopeId"]
      ))
    } else if (node.parentScopeId !== node.processId) {
      const seen = new Set<string>([node.id])
      let currentScopeId = node.parentScopeId
      while (currentScopeId !== node.processId) {
        if (seen.has(currentScopeId)) {
          diagnostics.push(error(
            Codes.InvalidParentScope,
            `Flow node '${node.id}' participates in a cyclic parent-scope chain`,
            [...nodePath, "parentScopeId"]
          ))
          break
        }
        seen.add(currentScopeId)
        const parent = scopeOwners.get(currentScopeId)
        if (parent === undefined) {
          diagnostics.push(error(
            Codes.UnknownParentScopeRef,
            `Flow node '${node.id}' references unknown parent scope '${currentScopeId}'`,
            [...nodePath, "parentScopeId"]
          ))
          break
        }
        if (parent.processId !== node.processId) {
          diagnostics.push(error(
            Codes.InvalidParentScope,
            `Flow node '${node.id}' cannot cross process boundaries through parent scope '${currentScopeId}'`,
            [...nodePath, "parentScopeId"]
          ))
          break
        }
        currentScopeId = parent.parentScopeId
      }
    } else if (!processIds.has(node.processId)) {
      diagnostics.push(error(
        Codes.UnknownParentScopeRef,
        `Flow node '${node.id}' references unknown root scope '${node.parentScopeId}'`,
        [...nodePath, "parentScopeId"]
      ))
    }

    const seenIncoming = new Set<string>()
    for (let incomingIndex = 0; incomingIndex < node.incomingSequenceFlowIds.length; incomingIndex++) {
      const flowId = node.incomingSequenceFlowIds[incomingIndex]!
      if (seenIncoming.has(flowId)) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlowRef,
          `Incoming sequence flow '${flowId}' is listed more than once on '${node.id}'`,
          [...nodePath, "incomingSequenceFlowIds", incomingIndex]
        ))
      } else {
        seenIncoming.add(flowId)
      }
      const flow = flowById.get(flowId)
      if (flow === undefined) {
        diagnostics.push(error(
          Codes.UnknownSequenceFlowRef,
          `Incoming sequence flow '${flowId}' does not exist`,
          [...nodePath, "incomingSequenceFlowIds", incomingIndex]
        ))
      } else if (flow.targetId !== node.id) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlowRef,
          `Incoming sequence flow '${flowId}' does not target '${node.id}'`,
          [...nodePath, "incomingSequenceFlowIds", incomingIndex]
        ))
      }
    }

    const seenOutgoing = new Set<string>()
    for (let outgoingIndex = 0; outgoingIndex < node.outgoingSequenceFlowIds.length; outgoingIndex++) {
      const flowId = node.outgoingSequenceFlowIds[outgoingIndex]!
      if (seenOutgoing.has(flowId)) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlowRef,
          `Outgoing sequence flow '${flowId}' is listed more than once on '${node.id}'`,
          [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
        ))
      } else {
        seenOutgoing.add(flowId)
      }
      const flow = flowById.get(flowId)
      if (flow === undefined) {
        diagnostics.push(error(
          Codes.UnknownSequenceFlowRef,
          `Outgoing sequence flow '${flowId}' does not exist`,
          [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
        ))
      } else if (flow.sourceId !== node.id) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlowRef,
          `Outgoing sequence flow '${flowId}' does not originate at '${node.id}'`,
          [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
        ))
      }
    }

    if ("defaultFlowId" in node && node.defaultFlowId !== undefined) {
      if (!defaultCapableTags.has(node._tag)) {
        diagnostics.push(error(
          Codes.IllegalDefaultFlowRef,
          `Flow node '${node.id}' cannot declare a default sequence flow`,
          [...nodePath, "defaultFlowId"]
        ))
      }
      const flow = flowById.get(node.defaultFlowId)
      if (flow === undefined) {
        diagnostics.push(error(
          Codes.IllegalDefaultFlowRef,
          `Default sequence flow '${node.defaultFlowId}' does not exist`,
          [...nodePath, "defaultFlowId"]
        ))
      } else {
        if (flow.sourceId !== node.id) {
          diagnostics.push(error(
            Codes.IllegalDefaultFlowRef,
            `Default sequence flow '${node.defaultFlowId}' must originate at '${node.id}'`,
            [...nodePath, "defaultFlowId"]
          ))
        }
        if (!node.outgoingSequenceFlowIds.includes(node.defaultFlowId)) {
          diagnostics.push(error(
            Codes.IllegalDefaultFlowRef,
            `Default sequence flow '${node.defaultFlowId}' must be listed among outgoing flows`,
            [...nodePath, "defaultFlowId"]
          ))
        }
        if (flow.kind !== "default") {
          diagnostics.push(error(
            Codes.IllegalDefaultFlowRef,
            `Default sequence flow '${node.defaultFlowId}' must have kind 'default'`,
            [...nodePath, "defaultFlowId"]
          ))
        }
      }
    }

    if (node._tag === "Task") {
      if (node.messageRef !== undefined && !messageIds.has(node.messageRef)) {
        diagnostics.push(error(
          Codes.UnknownMessageRef,
          `Task '${node.id}' references unknown message '${node.messageRef}'`,
          [...nodePath, "messageRef"]
        ))
      }
      if (
        node.messageRef !== undefined &&
        node.taskKind !== "receive" &&
        node.taskKind !== "send"
      ) {
        diagnostics.push(error(
          Codes.InvalidTask,
          `Only receive and send tasks may declare a messageRef`,
          [...nodePath, "messageRef"]
        ))
      }
      if (node.instantiate !== undefined && node.taskKind !== "receive") {
        diagnostics.push(error(
          Codes.InvalidTask,
          `Only a receive task may declare instantiate`,
          [...nodePath, "instantiate"]
        ))
      }
      if (node.taskKind === "receive" && node.instantiate === true && node.incomingSequenceFlowIds.length > 0) {
        diagnostics.push(error(
          Codes.InvalidTask,
          `Instantiating receive task '${node.id}' cannot have incoming sequence flows`,
          [...nodePath, "instantiate"]
        ))
      }
      if (
        node.taskKind !== "script" &&
        (node.script !== undefined || node.scriptFormat !== undefined)
      ) {
        diagnostics.push(error(
          Codes.InvalidTask,
          `Only a script task may declare script or scriptFormat`,
          [...nodePath, node.script !== undefined ? "script" : "scriptFormat"]
        ))
      }
    }

    if (node._tag === "Gateway") {
      if (node.activationCondition !== undefined && node.gatewayKind !== "complex") {
        diagnostics.push(error(
          Codes.InvalidGateway,
          `Only a complex gateway may declare an activationCondition`,
          [...nodePath, "activationCondition"]
        ))
      }
      if (
        node.gatewayKind !== "event-based" &&
        (node.instantiate !== undefined || node.eventGatewayType !== undefined)
      ) {
        diagnostics.push(error(
          Codes.InvalidGateway,
          `Only an event-based gateway may declare instantiate or eventGatewayType`,
          [...nodePath, node.instantiate !== undefined ? "instantiate" : "eventGatewayType"]
        ))
      }
      if (
        node.defaultFlowId !== undefined &&
        !["exclusive", "inclusive", "complex"].includes(node.gatewayKind)
      ) {
        diagnostics.push(error(
          Codes.IllegalDefaultFlowRef,
          `Gateway '${node.id}' kind '${node.gatewayKind}' cannot declare a default flow`,
          [...nodePath, "defaultFlowId"]
        ))
      }
      if (
        node.defaultFlowId !== undefined &&
        ["converging", "mixed"].includes(node.gatewayDirection)
      ) {
        diagnostics.push(error(
          Codes.IllegalDefaultFlowRef,
          `Gateway '${node.id}' direction '${node.gatewayDirection}' cannot declare a default flow`,
          [...nodePath, "defaultFlowId"]
        ))
      }
      if (node.gatewayKind === "event-based") {
        if (node.gatewayDirection === "converging" || node.gatewayDirection === "mixed") {
          diagnostics.push(error(
            Codes.InvalidGateway,
            `Event-based gateway '${node.id}' cannot be '${node.gatewayDirection}'`,
            [...nodePath, "gatewayDirection"]
          ))
        }
        if (node.defaultFlowId !== undefined) {
          diagnostics.push(error(
            Codes.InvalidGateway,
            `Event-based gateway '${node.id}' cannot declare a default flow`,
            [...nodePath, "defaultFlowId"]
          ))
        }
        if (node.outgoingSequenceFlowIds.length < 2) {
          diagnostics.push(error(
            Codes.InvalidGateway,
            `Event-based gateway '${node.id}' requires at least two outgoing flows`,
            [...nodePath, "outgoingSequenceFlowIds"]
          ))
        }
        if (node.instantiate === true && node.incomingSequenceFlowIds.length > 0) {
          diagnostics.push(error(
            Codes.InvalidGateway,
            `Instantiate event-based gateway '${node.id}' cannot have incoming sequence flows`,
            [...nodePath, "instantiate"]
          ))
        }
        if (node.instantiate !== true && node.incomingSequenceFlowIds.length === 0) {
          diagnostics.push(error(
            Codes.InvalidGateway,
            `Event-based gateway '${node.id}' without incoming flows must set instantiate=true`,
            [...nodePath, "instantiate"]
          ))
        }
        if (node.instantiate === true && node.eventGatewayType === "parallel") {
          diagnostics.push(error(
            Codes.InvalidGateway,
            `Instantiate event-based gateway '${node.id}' cannot be parallel`,
            [...nodePath, "eventGatewayType"]
          ))
        }
        for (let outgoingIndex = 0; outgoingIndex < node.outgoingSequenceFlowIds.length; outgoingIndex++) {
          const flowId = node.outgoingSequenceFlowIds[outgoingIndex]!
          const flow = flowById.get(flowId)
          const target = flow === undefined ? undefined : nodeById.get(flow.targetId)
          if (flow !== undefined && flow.kind !== "normal") {
            diagnostics.push(error(
              Codes.InvalidGateway,
              `Event-based gateway '${node.id}' may only use normal outgoing flows`,
              [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
            ))
          }
          if (target !== undefined) {
            const isReceiveTask = target._tag === "Task" && target.taskKind === "receive"
            if (target._tag !== "IntermediateCatchEvent" && !isReceiveTask) {
              diagnostics.push(error(
                Codes.InvalidGateway,
                `Event-based gateway '${node.id}' must target only an intermediate catch event or receive task`,
                [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
              ))
            }
            if (target.incomingSequenceFlowIds.length !== 1 || target.incomingSequenceFlowIds[0] !== flowId) {
              diagnostics.push(error(
                Codes.InvalidGateway,
                `Event-based gateway target '${target.id}' cannot have other incoming sequence flows`,
                [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
              ))
            }
            if (isReceiveTask && target._tag === "Task" && target.instantiate === true) {
              diagnostics.push(error(
                Codes.InvalidGateway,
                `Event-based gateway target receive task '${target.id}' cannot itself instantiate a process`,
                [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
              ))
            }
            if (target._tag === "IntermediateCatchEvent") {
              const inlineDefinitions = [...target.eventDefinitions]
              const referencedDefinitions = target.eventDefinitionRefs
                .map((ref) => declaredEventDefinitions.get(ref))
                .filter((value): value is DeclaredEventDefinition => value !== undefined)
              const invalidTrigger = [...inlineDefinitions, ...referencedDefinitions].some((definition) =>
                ![
                  "MessageEventDefinition",
                  "TimerEventDefinition",
                  "SignalEventDefinition",
                  "ConditionalEventDefinition"
                ].includes(definition._tag)
              )
              if (invalidTrigger) {
                diagnostics.push(error(
                  Codes.InvalidGateway,
                  `Event-based gateway '${node.id}' target '${target.id}' uses an unsupported trigger`,
                  [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
                ))
              }
            }
          }
        }
      }
      if (node.gatewayKind === "parallel") {
        for (let outgoingIndex = 0; outgoingIndex < node.outgoingSequenceFlowIds.length; outgoingIndex++) {
          const flowId = node.outgoingSequenceFlowIds[outgoingIndex]!
          const flow = flowById.get(flowId)
          if (flow !== undefined && flow.kind !== "normal") {
            diagnostics.push(error(
              Codes.InvalidGateway,
              `Parallel gateway '${node.id}' may only use normal outgoing flows`,
              [...nodePath, "outgoingSequenceFlowIds", outgoingIndex]
            ))
          }
        }
      }
    }

    if (node._tag === "EventSubProcess") {
      if (node.incomingSequenceFlowIds.length > 0 || node.outgoingSequenceFlowIds.length > 0) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `Event subprocess '${node.id}' cannot connect through sequence flows`,
          nodePath
        ))
      }
    }

    if (
      node._tag === "StartEvent" ||
      node._tag === "BoundaryEvent" ||
      node._tag === "IntermediateCatchEvent" ||
      node._tag === "IntermediateThrowEvent" ||
      node._tag === "EndEvent"
    ) {
      validateEventCarrier(
        node,
        nodePath,
        diagnostics,
        declaredEventDefinitions,
        messageIds,
        signalIds,
        errorIds,
        escalationIds,
        scopeOwners,
        nodeById
      )
      if (node._tag === "StartEvent" && node.incomingSequenceFlowIds.length > 0) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `Start event '${node.id}' cannot have incoming sequence flows`,
          [...nodePath, "incomingSequenceFlowIds"]
        ))
      }
      if (node._tag === "StartEvent" && node.outgoingSequenceFlowIds.length === 0) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `Start event '${node.id}' must have an outgoing sequence flow`,
          [...nodePath, "outgoingSequenceFlowIds"]
        ))
      }
      if (node._tag === "EndEvent" && node.outgoingSequenceFlowIds.length > 0) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `End event '${node.id}' cannot have outgoing sequence flows`,
          [...nodePath, "outgoingSequenceFlowIds"]
        ))
      }
      if (node._tag === "EndEvent" && node.incomingSequenceFlowIds.length === 0) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `End event '${node.id}' must have an incoming sequence flow`,
          [...nodePath, "incomingSequenceFlowIds"]
        ))
      }
      if (node._tag === "IntermediateCatchEvent" || node._tag === "IntermediateThrowEvent") {
        const resolvedDefinitions = [
          ...node.eventDefinitions,
          ...node.eventDefinitionRefs
            .map((ref) => declaredEventDefinitions.get(ref))
            .filter((definition): definition is DeclaredEventDefinition => definition !== undefined)
        ]
        const isLink = resolvedDefinitions.some((definition) => definition._tag === "LinkEventDefinition")
        if (isLink && node._tag === "IntermediateCatchEvent") {
          if (node.incomingSequenceFlowIds.length > 0 || node.outgoingSequenceFlowIds.length === 0) {
            diagnostics.push(error(
              Codes.InvalidEvent,
              `Catching link event '${node.id}' must have no incoming and at least one outgoing sequence flow`,
              nodePath
            ))
          }
        } else if (isLink && node._tag === "IntermediateThrowEvent") {
          if (node.incomingSequenceFlowIds.length === 0 || node.outgoingSequenceFlowIds.length > 0) {
            diagnostics.push(error(
              Codes.InvalidEvent,
              `Throwing link event '${node.id}' must have at least one incoming and no outgoing sequence flow`,
              nodePath
            ))
          }
        } else if (
          node.incomingSequenceFlowIds.length === 0 ||
          node.outgoingSequenceFlowIds.length === 0
        ) {
          diagnostics.push(error(
            Codes.InvalidEvent,
            `${node._tag} '${node.id}' in normal flow must have incoming and outgoing sequence flows`,
            nodePath
          ))
        }
      }
    }
  }

  for (let index = 0; index < model.flowNodes.length; index++) {
    const node = model.flowNodes[index]!
    if (node._tag === "AdHocSubProcess") {
      const forbidden = (childrenByScopeId.get(node.id) ?? []).find((child) =>
        child._tag === "StartEvent" || child._tag === "EndEvent"
      )
      if (forbidden !== undefined) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `Ad-hoc subprocess '${node.id}' cannot contain '${forbidden._tag}'`,
          ["flowNodes", index, "id"]
        ))
      }
    }
    if (node._tag === "EventSubProcess") {
      const starts = (childrenByScopeId.get(node.id) ?? []).filter((child) => child._tag === "StartEvent")
      if (starts.length !== 1) {
        diagnostics.push(error(
          Codes.InvalidEvent,
          `Event subprocess '${node.id}' must contain exactly one start event`,
          ["flowNodes", index, "id"]
        ))
      }
    }
  }

  for (let index = 0; index < model.sequenceFlows.length; index++) {
    const flow = model.sequenceFlows[index]!
    const flowPath = ["sequenceFlows", index] as const
    const source = nodeById.get(flow.sourceId)
    const target = nodeById.get(flow.targetId)
    if (source === undefined) {
      diagnostics.push(error(
        Codes.UnknownSequenceFlowRef,
        `Sequence flow '${flow.id}' references unknown source '${flow.sourceId}'`,
        [...flowPath, "sourceId"]
      ))
    }
    if (target === undefined) {
      diagnostics.push(error(
        Codes.UnknownSequenceFlowRef,
        `Sequence flow '${flow.id}' references unknown target '${flow.targetId}'`,
        [...flowPath, "targetId"]
      ))
    }
    if (source !== undefined && source.processId !== flow.processId) {
      diagnostics.push(error(
        Codes.InvalidSequenceFlow,
        `Sequence flow '${flow.id}' process '${flow.processId}' does not match source process '${source.processId}'`,
        [...flowPath, "processId"]
      ))
    }
    if (target !== undefined && target.processId !== flow.processId) {
      diagnostics.push(error(
        Codes.InvalidSequenceFlow,
        `Sequence flow '${flow.id}' process '${flow.processId}' does not match target process '${target.processId}'`,
        [...flowPath, "processId"]
      ))
    }
    if (source !== undefined && target !== undefined) {
      if (source.processId !== target.processId) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlow,
          `Sequence flow '${flow.id}' cannot cross process boundaries`,
          [...flowPath, "targetId"]
        ))
      }
      if (source.parentScopeId !== target.parentScopeId || flow.parentScopeId !== source.parentScopeId) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlow,
          `Sequence flow '${flow.id}' must stay within one exact parent scope`,
          [...flowPath, "parentScopeId"]
        ))
      }
      if (!source.outgoingSequenceFlowIds.includes(flow.id)) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlowRef,
          `Sequence flow '${flow.id}' must appear in source '${source.id}' outgoingSequenceFlowIds`,
          [...flowPath, "sourceId"]
        ))
      }
      if (!target.incomingSequenceFlowIds.includes(flow.id)) {
        diagnostics.push(error(
          Codes.InvalidSequenceFlowRef,
          `Sequence flow '${flow.id}' must appear in target '${target.id}' incomingSequenceFlowIds`,
          [...flowPath, "targetId"]
        ))
      }
    }
    if (
      source !== undefined &&
      (
        source._tag === "StartEvent" ||
        source._tag === "BoundaryEvent" ||
        source._tag === "IntermediateCatchEvent" ||
        source._tag === "IntermediateThrowEvent"
      ) &&
      flow.kind !== "normal"
    ) {
      diagnostics.push(error(
        Codes.InvalidSequenceFlow,
        `Sequence flow '${flow.id}' leaving '${source._tag}' must be normal`,
        [...flowPath, "kind"]
      ))
    }
    if (flow.kind === "conditional" && flow.condition === undefined) {
      diagnostics.push(error(
        Codes.InvalidSequenceFlow,
        `Conditional sequence flow '${flow.id}' requires a condition`,
        [...flowPath, "condition"]
      ))
    }
    if (flow.kind === "normal" && flow.condition !== undefined) {
      diagnostics.push(error(
        Codes.InvalidSequenceFlow,
        `Normal sequence flow '${flow.id}' cannot declare a condition`,
        [...flowPath, "condition"]
      ))
    }
    if (flow.kind === "default" && source !== undefined) {
      if (!("defaultFlowId" in source) || source.defaultFlowId !== flow.id) {
        diagnostics.push(error(
          Codes.IllegalDefaultFlowRef,
          `Default sequence flow '${flow.id}' must be selected by its source node`,
          [...flowPath, "kind"]
        ))
      }
    }
  }

  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }
  return Result.succeed(model)
}
