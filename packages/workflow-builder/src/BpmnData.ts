/**
 * Bounded BPMN 2.0.2 data, IO, message, error, and interface slice.
 *
 * **Details**
 *
 * This module defines a strict normalized JSON semantic IR for data owned by
 * Processes, SubProcesses, Tasks, CallActivities, and GlobalTasks. A typed
 * {@link SemanticOwnerContext} supplies the containment information that XML
 * nesting normally carries.
 *
 * Direct Event IO, Event-owned Properties and DataAssociations, imported
 * CallableElements, task-kind-specific message mappings, CallActivity-to-
 * CallableElement IO equality, and expression-language type checking are
 * deliberately outside this slice. This module is not an XML binding, XSD
 * validator, complete Common Executable metamodel, or conformance claim.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnModel from "./BpmnModel.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString
const Text = Schema.String

/**
 * A pinned expression used by assignments and data transformations.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Expression = BpmnModel.Expression

/**
 * The decoded type of {@link Expression}.
 *
 * @category models
 * @since 4.0.0
 */
export type Expression = BpmnModel.Expression

/**
 * One namespaced extension element retained by the normalized model.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExtensionElement = BpmnModel.ExtensionElement

/**
 * The decoded type of {@link ExtensionElement}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExtensionElement = BpmnModel.ExtensionElement

const Extensions = Schema.Array(ExtensionElement)

/**
 * An explicitly local QName resolved against declarations in this document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LocalQName = Schema.TaggedStruct("LocalQName", {
  id: Identifier
}).annotate({
  identifier: "WorkflowBpmnDataLocalQName",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LocalQName}.
 *
 * @category models
 * @since 4.0.0
 */
export type LocalQName = Schema.Schema.Type<typeof LocalQName>

/**
 * A QName whose declaration belongs to an imported or external namespace.
 *
 * **Details**
 *
 * Namespace prefixes are intentionally not retained: importers resolve them
 * to a namespace URI and local name before constructing this IR.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExternalQName = Schema.TaggedStruct("ExternalQName", {
  namespaceUri: Identifier,
  localName: Identifier
}).annotate({
  identifier: "WorkflowBpmnDataExternalQName",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExternalQName}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExternalQName = Schema.Schema.Type<typeof ExternalQName>

/**
 * A normalized QName that makes local resolution explicit.
 *
 * **Details**
 *
 * This is distinct from the nonempty string fields used for XML `IDREF`
 * relationships, which must always resolve inside the normalized document or
 * supplied owner context.
 *
 * @category schemas
 * @since 4.0.0
 */
export const QName = Schema.Union([LocalQName, ExternalQName]).annotate({
  identifier: "WorkflowBpmnDataQName"
})

/**
 * The decoded type of {@link QName}.
 *
 * @category models
 * @since 4.0.0
 */
export type QName = Schema.Schema.Type<typeof QName>

/**
 * A BPMN Process owner and root scope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProcessOwner = Schema.TaggedStruct("Process", {
  id: Identifier,
  supportedInterfaceRefs: Schema.Array(QName)
}).annotate({
  identifier: "WorkflowBpmnDataProcessOwner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProcessOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProcessOwner = Schema.Schema.Type<typeof ProcessOwner>

/**
 * A reusable GlobalTask CallableElement owner.
 *
 * @category schemas
 * @since 4.0.0
 */
export const GlobalTaskOwner = Schema.TaggedStruct("GlobalTask", {
  id: Identifier,
  supportedInterfaceRefs: Schema.Array(QName)
}).annotate({
  identifier: "WorkflowBpmnDataGlobalTaskOwner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link GlobalTaskOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type GlobalTaskOwner = Schema.Schema.Type<typeof GlobalTaskOwner>

/**
 * A SubProcess scope nested in a Process or another SubProcess.
 *
 * **Details**
 *
 * Embedded SubProcesses are scope and Property owners in this slice, but
 * direct SubProcess IO specifications are intentionally rejected.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SubProcessOwner = Schema.TaggedStruct("SubProcess", {
  id: Identifier,
  processId: Identifier,
  parentScopeId: Identifier
}).annotate({
  identifier: "WorkflowBpmnDataSubProcessOwner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SubProcessOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type SubProcessOwner = Schema.Schema.Type<typeof SubProcessOwner>

/**
 * A Task owner in one exact Process/SubProcess scope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TaskOwner = Schema.TaggedStruct("Task", {
  id: Identifier,
  processId: Identifier,
  parentScopeId: Identifier,
  taskKind: Schema.Literals([
    "generic",
    "user",
    "service",
    "script",
    "manual",
    "business-rule",
    "receive",
    "send"
  ])
}).annotate({
  identifier: "WorkflowBpmnDataTaskOwner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TaskOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type TaskOwner = Schema.Schema.Type<typeof TaskOwner>

/**
 * A CallActivity owner in one exact Process/SubProcess scope.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CallActivityOwner = Schema.TaggedStruct("CallActivity", {
  id: Identifier,
  processId: Identifier,
  parentScopeId: Identifier
}).annotate({
  identifier: "WorkflowBpmnDataCallActivityOwner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CallActivityOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type CallActivityOwner = Schema.Schema.Type<typeof CallActivityOwner>

/**
 * Semantic owner kinds supported by this bounded data/IO slice.
 *
 * **Details**
 *
 * Events are deliberately absent because sound Event IO validation also needs
 * ordered EventDefinition payload mappings that this document does not carry.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticOwner = Schema.Union([
  ProcessOwner,
  GlobalTaskOwner,
  SubProcessOwner,
  TaskOwner,
  CallActivityOwner
]).annotate({ identifier: "WorkflowBpmnDataSemanticOwner" })

/**
 * The decoded type of {@link SemanticOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticOwner = Schema.Schema.Type<typeof SemanticOwner>

/**
 * Version of the semantic owner context passed to {@link validate}.
 *
 * @category constants
 * @since 4.0.0
 */
export const SemanticOwnerContextVersion = 1 as const

/**
 * Typed containment and CallableElement context for data validation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SemanticOwnerContext = Schema.Struct({
  contextKind: Schema.Literal("BpmnDataOwnerContext"),
  contextVersion: Schema.Literal(SemanticOwnerContextVersion),
  owners: Schema.Array(SemanticOwner)
}).annotate({
  identifier: "WorkflowBpmnDataSemanticOwnerContext",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SemanticOwnerContext}.
 *
 * @category models
 * @since 4.0.0
 */
export type SemanticOwnerContext = Schema.Schema.Type<typeof SemanticOwnerContext>

/**
 * A BPMN ItemDefinition root element.
 *
 * **Details**
 *
 * Normalization makes the BPMN defaults explicit: an omitted XML
 * `isCollection` maps to `false`, and an omitted XML `itemKind` maps to
 * `information`. Importers also map the XSD lexical values
 * `Information`/`Physical` to lower-case literals. `structureRef` denotes an
 * external data-language construct, not another ItemDefinition. `importRef`
 * names import metadata maintained outside this bounded document.
 *
 * BPMN BaseElement IDs are optional in XML. This IR deliberately requires
 * stable nonempty IDs for every represented element so flattened IDREF
 * relationships remain unambiguous.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ItemDefinition = Schema.Struct({
  id: Identifier,
  structureRef: Schema.optionalKey(ExternalQName),
  isCollection: Schema.Boolean,
  itemKind: Schema.Literals(["information", "physical"]),
  importRef: Schema.optionalKey(Identifier),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnItemDefinition",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ItemDefinition}.
 *
 * @category models
 * @since 4.0.0
 */
export type ItemDefinition = Schema.Schema.Type<typeof ItemDefinition>

/**
 * A BPMN DataState annotation.
 *
 * **Details**
 *
 * `name` follows XSD `string` lexical space and can be empty; only IDs and
 * references use the stricter nonempty-string normalization.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataState = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Text),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataState",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataState}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataState = Schema.Schema.Type<typeof DataState>

/**
 * A DataObject directly contained by a Process or SubProcess.
 *
 * **Details**
 *
 * BPMN states are represented on DataObjectReferences in this bounded slice;
 * DataObjects carry the reusable item and collection declaration. Importers
 * materialize an omitted XML `isCollection` value as `false`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataObject = Schema.Struct({
  id: Identifier,
  containerId: Identifier,
  name: Schema.optionalKey(Text),
  itemSubjectRef: Schema.optionalKey(QName),
  isCollection: Schema.Boolean,
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataObject",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataObject}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataObject = Schema.Schema.Type<typeof DataObject>

/**
 * A scoped appearance of an accessible DataObject.
 *
 * **Details**
 *
 * The item definition and collection status are derived from
 * `dataObjectRef`; a DataObjectReference cannot override them. The reference
 * remains optional to preserve the BPMN 2.0.2 XSD cardinality.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataObjectReference = Schema.Struct({
  id: Identifier,
  containerId: Identifier,
  name: Schema.optionalKey(Text),
  dataObjectRef: Schema.optionalKey(Identifier),
  dataState: Schema.optionalKey(DataState),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataObjectReference",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataObjectReference}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataObjectReference = Schema.Schema.Type<typeof DataObjectReference>

/**
 * A reusable BPMN DataStore root element.
 *
 * **Details**
 *
 * The `Semantic.xsd` default for `isUnlimited` is materialized as a required
 * boolean (`true` when the XML attribute is omitted). `capacity` remains an
 * unrestricted JSON-safe integer, matching `xsd:integer` rather than adding a
 * non-normative positivity rule.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataStore = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Text),
  capacity: Schema.optionalKey(Schema.Int),
  isUnlimited: Schema.Boolean,
  itemSubjectRef: Schema.optionalKey(QName),
  dataState: Schema.optionalKey(DataState),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataStore",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataStore}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataStore = Schema.Schema.Type<typeof DataStore>

/**
 * A scoped reference to a local or imported BPMN DataStore.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataStoreReference = Schema.Struct({
  id: Identifier,
  containerId: Identifier,
  name: Schema.optionalKey(Text),
  itemSubjectRef: Schema.optionalKey(QName),
  dataStoreRef: Schema.optionalKey(QName),
  dataState: Schema.optionalKey(DataState),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataStoreReference",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataStoreReference}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataStoreReference = Schema.Schema.Type<typeof DataStoreReference>

/**
 * A Property directly owned by a supported semantic owner.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Property = Schema.Struct({
  id: Identifier,
  ownerId: Identifier,
  name: Schema.optionalKey(Text),
  itemSubjectRef: Schema.optionalKey(QName),
  dataState: Schema.optionalKey(DataState),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnProperty",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Property}.
 *
 * @category models
 * @since 4.0.0
 */
export type Property = Schema.Schema.Type<typeof Property>

const IoElementFields = {
  id: Identifier,
  name: Schema.optionalKey(Text),
  itemSubjectRef: Schema.optionalKey(QName),
  isCollection: Schema.Boolean,
  dataState: Schema.optionalKey(DataState),
  extensionElements: Extensions
} as const

/**
 * One DataInput declared by an InputOutputSpecification.
 *
 * **Details**
 *
 * Importers materialize the BPMN `isCollection` default as `false`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataInput = Schema.Struct(IoElementFields).annotate({
  identifier: "WorkflowBpmnDataInput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataInput}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataInput = Schema.Schema.Type<typeof DataInput>

/**
 * One DataOutput declared by an InputOutputSpecification.
 *
 * **Details**
 *
 * Importers materialize the BPMN `isCollection` default as `false`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataOutput = Schema.Struct(IoElementFields).annotate({
  identifier: "WorkflowBpmnDataOutput",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataOutput}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataOutput = Schema.Schema.Type<typeof DataOutput>

/**
 * A BPMN InputSet and its local IDREF relationships.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InputSet = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Text),
  dataInputRefs: Schema.Array(Identifier),
  optionalInputRefs: Schema.Array(Identifier),
  whileExecutingInputRefs: Schema.Array(Identifier),
  outputSetRefs: Schema.Array(Identifier),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnInputSet",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InputSet}.
 *
 * @category models
 * @since 4.0.0
 */
export type InputSet = Schema.Schema.Type<typeof InputSet>

/**
 * A BPMN OutputSet and its local IDREF relationships.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OutputSet = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Text),
  dataOutputRefs: Schema.Array(Identifier),
  optionalOutputRefs: Schema.Array(Identifier),
  whileExecutingOutputRefs: Schema.Array(Identifier),
  inputSetRefs: Schema.Array(Identifier),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnOutputSet",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OutputSet}.
 *
 * @category models
 * @since 4.0.0
 */
export type OutputSet = Schema.Schema.Type<typeof OutputSet>

/**
 * A normalized IO specification owned by one supported semantic element.
 *
 * **Details**
 *
 * BPMN requires at least one InputSet and OutputSet. Direct embedded
 * SubProcess and Event IO are outside the supported owner set.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InputOutputSpecification = Schema.Struct({
  id: Identifier,
  ownerId: Identifier,
  dataInputs: Schema.Array(DataInput),
  dataOutputs: Schema.Array(DataOutput),
  inputSets: Schema.NonEmptyArray(InputSet),
  outputSets: Schema.NonEmptyArray(OutputSet),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnInputOutputSpecification",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InputOutputSpecification}.
 *
 * @category models
 * @since 4.0.0
 */
export type InputOutputSpecification = Schema.Schema.Type<typeof InputOutputSpecification>

/**
 * A BPMN Assignment with required source and destination Expressions.
 *
 * **Details**
 *
 * The Expressions remain language-specific. This model does not invent
 * element-reference semantics for their source text.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Assignment = Schema.Struct({
  id: Identifier,
  from: Expression,
  to: Expression,
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnAssignment",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Assignment}.
 *
 * @category models
 * @since 4.0.0
 */
export type Assignment = Schema.Schema.Type<typeof Assignment>

const DataAssociationFields = {
  id: Identifier,
  ownerId: Identifier,
  sourceRefs: Schema.Array(Identifier),
  targetRef: Identifier,
  transformation: Schema.optionalKey(Expression),
  assignments: Schema.Array(Assignment),
  extensionElements: Extensions
} as const

/**
 * An Activity-owned DataInputAssociation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataInputAssociation = Schema.TaggedStruct(
  "DataInputAssociation",
  DataAssociationFields
).annotate({
  identifier: "WorkflowBpmnDataInputAssociation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DataInputAssociation}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataInputAssociation = Schema.Schema.Type<typeof DataInputAssociation>

/**
 * An Activity-owned DataOutputAssociation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataOutputAssociation = Schema.TaggedStruct(
  "DataOutputAssociation",
  DataAssociationFields
).annotate({
  identifier: "WorkflowBpmnDataOutputAssociation",
  parseOptions: strictParseOptions
})

/**
 * The two concrete DataAssociation subtypes supported by this slice.
 *
 * **Details**
 *
 * BPMN DataAssociation is abstract. Consequently this union intentionally has
 * no untagged base-association inhabitant. Event-owned associations are also
 * outside this bounded model.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DataAssociation = Schema.Union([
  DataInputAssociation,
  DataOutputAssociation
]).annotate({ identifier: "WorkflowBpmnDataAssociation" })

/**
 * The decoded type of {@link DataAssociation}.
 *
 * @category models
 * @since 4.0.0
 */
export type DataAssociation = Schema.Schema.Type<typeof DataAssociation>

/**
 * A CallableElement binding to one operation in a supported Interface.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InputOutputBinding = Schema.Struct({
  id: Identifier,
  ownerId: Identifier,
  operationRef: QName,
  inputDataRef: Identifier,
  outputDataRef: Identifier,
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnInputOutputBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InputOutputBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type InputOutputBinding = Schema.Schema.Type<typeof InputOutputBinding>

/**
 * A reusable BPMN Message with retained BaseElement extensions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Message = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Text),
  itemRef: Schema.optionalKey(QName),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataMessage",
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
 * A reusable BPMN Error with retained BaseElement extensions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Error = Schema.Struct({
  id: Identifier,
  name: Schema.optionalKey(Text),
  errorCode: Schema.optionalKey(Text),
  structureRef: Schema.optionalKey(QName),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnDataError",
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
 * One Operation contained by an Interface.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Operation = Schema.Struct({
  id: Identifier,
  name: Text,
  implementationRef: Schema.optionalKey(ExternalQName),
  inMessageRef: QName,
  outMessageRef: Schema.optionalKey(QName),
  errorRefs: Schema.Array(QName),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnOperation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Operation}.
 *
 * @category models
 * @since 4.0.0
 */
export type Operation = Schema.Schema.Type<typeof Operation>

/**
 * A BPMN Interface containing one or more Operations.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Interface = Schema.Struct({
  id: Identifier,
  name: Text,
  implementationRef: Schema.optionalKey(ExternalQName),
  operations: Schema.NonEmptyArray(Operation),
  extensionElements: Extensions
}).annotate({
  identifier: "WorkflowBpmnInterface",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Interface}.
 *
 * @category models
 * @since 4.0.0
 */
export type Interface = Schema.Schema.Type<typeof Interface>

/**
 * Version of the bounded normalized BPMN data document.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnDataDocumentVersion = 1 as const

/**
 * Strict bounded BPMN 2.0.2 data and callable-IO document.
 *
 * **Details**
 *
 * The document contains declarations and normalized contained elements.
 * {@link validate} combines it with a {@link SemanticOwnerContext} to check
 * containment, accessibility, interface support, and local IDREFs.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BpmnDataDocument = Schema.Struct({
  documentKind: Schema.Literal("BpmnDataDocument"),
  documentVersion: Schema.Literal(BpmnDataDocumentVersion),
  bpmnSpecVersion: Schema.Literal("2.0.2"),
  extensionElements: Extensions,
  itemDefinitions: Schema.Array(ItemDefinition),
  dataStores: Schema.Array(DataStore),
  messages: Schema.Array(Message),
  errors: Schema.Array(Error),
  interfaces: Schema.Array(Interface),
  dataObjects: Schema.Array(DataObject),
  dataObjectReferences: Schema.Array(DataObjectReference),
  dataStoreReferences: Schema.Array(DataStoreReference),
  properties: Schema.Array(Property),
  inputOutputSpecifications: Schema.Array(InputOutputSpecification),
  dataAssociations: Schema.Array(DataAssociation),
  inputOutputBindings: Schema.Array(InputOutputBinding)
}).annotate({
  identifier: "WorkflowBpmnDataDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BpmnDataDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type BpmnDataDocument = Schema.Schema.Type<typeof BpmnDataDocument>

const decodeDocument = Schema.decodeUnknownResult(BpmnDataDocument, strictParseOptions)
const decodeOwnerContext = Schema.decodeUnknownResult(SemanticOwnerContext, strictParseOptions)

/**
 * Stable diagnostics emitted by {@link validate}.
 *
 * @category errors
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "InvalidJson",
  InvalidDocument: "InvalidDocument",
  InvalidOwnerContext: "InvalidOwnerContext",
  MissingOwnerContext: "MissingOwnerContext",
  DuplicateId: "DuplicateId",
  DuplicateReference: "DuplicateReference",
  UnknownOwnerRef: "UnknownOwnerRef",
  UnknownScopeRef: "UnknownScopeRef",
  InvalidContainment: "InvalidContainment",
  UnsupportedOwner: "UnsupportedOwner",
  UnknownLocalQNameRef: "UnknownLocalQNameRef",
  UnknownDataObjectRef: "UnknownDataObjectRef",
  UnknownDataRef: "UnknownDataRef",
  UnknownInputSetRef: "UnknownInputSetRef",
  UnknownOutputSetRef: "UnknownOutputSetRef",
  InvalidCollectionCompatibility: "InvalidCollectionCompatibility",
  InvalidItemCompatibility: "InvalidItemCompatibility",
  InvalidIoSetMembership: "InvalidIoSetMembership",
  InvalidIoSetReciprocity: "InvalidIoSetReciprocity",
  InvalidAssociationCardinality: "InvalidAssociationCardinality",
  InvalidAssociationEndpoint: "InvalidAssociationEndpoint",
  InaccessibleDataRef: "InaccessibleDataRef",
  InvalidBinding: "InvalidBinding",
  UnsupportedExternalOperationBinding: "UnsupportedExternalOperationBinding"
} as const

type Code = typeof Codes[keyof typeof Codes]

const error = (
  code: Code,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

const compilationError = (
  head: Diagnostic.Diagnostic,
  tail: ReadonlyArray<Diagnostic.Diagnostic> = []
): Diagnostic.CompilationError => new Diagnostic.CompilationError({ diagnostics: [head, ...tail] })

const comparePath = (
  left: ReadonlyArray<Diagnostic.PathSegment>,
  right: ReadonlyArray<Diagnostic.PathSegment>
): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]!
    const b = right[index]!
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return a - b
      continue
    }
    const ordered = String(a).localeCompare(String(b))
    if (ordered !== 0) return ordered
  }
  return left.length - right.length
}

const sortDiagnostics = (
  diagnostics: Array<Diagnostic.Diagnostic>
): Array<Diagnostic.Diagnostic> =>
  diagnostics.sort((left, right) => {
    const path = comparePath(left.path, right.path)
    if (path !== 0) return path
    const code = left.code.localeCompare(right.code)
    return code !== 0 ? code : left.message.localeCompare(right.message)
  })

const localQName = (ref: QName | undefined): string | undefined => ref?._tag === "LocalQName" ? ref.id : undefined

const qNameKey = (ref: QName | undefined): string | undefined => {
  if (ref === undefined) return undefined
  return ref._tag === "LocalQName"
    ? `local:${ref.id}`
    : `external:${ref.namespaceUri}\u0000${ref.localName}`
}

const qNameEqual = (left: QName | undefined, right: QName | undefined): boolean => qNameKey(left) === qNameKey(right)

interface Endpoint {
  readonly kind:
    | "DataObject"
    | "DataObjectReference"
    | "DataStoreReference"
    | "Property"
    | "DataInput"
    | "DataOutput"
  readonly itemRef?: QName | undefined
  readonly isCollection?: boolean | undefined
  readonly containerId?: string | undefined
  readonly ownerId?: string | undefined
}

interface OperationLocation {
  readonly operation: Operation
  readonly interfaceId: string
}

const needsOwnerContext = (document: BpmnDataDocument): boolean =>
  document.dataObjects.length > 0 ||
  document.dataObjectReferences.length > 0 ||
  document.dataStoreReferences.length > 0 ||
  document.properties.length > 0 ||
  document.inputOutputSpecifications.length > 0 ||
  document.dataAssociations.length > 0 ||
  document.inputOutputBindings.length > 0

/**
 * Snapshots, strictly decodes, and semantically validates a bounded data
 * document.
 *
 * **Details**
 *
 * Both arguments are inspected through strict-JSON property descriptors, so
 * accessors and hostile proxies are rejected without invoking getters.
 * `ownerContext` is required whenever the document contains scoped or owned
 * elements; root declarations alone can be validated without it.
 *
 * Validation resolves every local QName and IDREF, but deliberately accepts
 * external QNames without pretending their imported declarations are
 * available. Item equivalence and collection checks involving external types
 * therefore remain the responsibility of an import-aware integration layer.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown,
  ownerContext?: unknown
): Result.Result<BpmnDataDocument, Diagnostic.CompilationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidJson,
      snapshot.failure.message,
      snapshot.failure.path
    )))
  }
  const decoded = decodeDocument(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "Invalid bounded BPMN data document",
      [],
      { issue: String(decoded.failure) }
    )))
  }

  const document = snapshot.success as unknown as BpmnDataDocument
  let context: SemanticOwnerContext | undefined
  if (ownerContext !== undefined) {
    const contextSnapshot = Json.snapshot(ownerContext)
    if (Result.isFailure(contextSnapshot)) {
      return Result.fail(compilationError(error(
        Codes.InvalidOwnerContext,
        contextSnapshot.failure.message,
        contextSnapshot.failure.path
      )))
    }
    const decodedContext = decodeOwnerContext(contextSnapshot.success)
    if (Result.isFailure(decodedContext)) {
      return Result.fail(compilationError(error(
        Codes.InvalidOwnerContext,
        "Invalid BPMN data semantic owner context",
        [],
        { issue: String(decodedContext.failure) }
      )))
    }
    context = contextSnapshot.success as unknown as SemanticOwnerContext
  } else if (needsOwnerContext(document)) {
    return Result.fail(compilationError(error(
      Codes.MissingOwnerContext,
      "A semantic owner context is required for scoped or owned data elements",
      []
    )))
  }

  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const ids = new Map<string, ReadonlyArray<Diagnostic.PathSegment>>()
  const owners = new Map<string, SemanticOwner>()
  const scopes = new Map<string, ProcessOwner | SubProcessOwner>()
  const itemDefinitions = new Map<string, ItemDefinition>()
  const dataStores = new Map<string, DataStore>()
  const messages = new Map<string, Message>()
  const errors = new Map<string, Error>()
  const interfaces = new Map<string, Interface>()
  const operations = new Map<string, OperationLocation>()
  const dataObjects = new Map<string, DataObject>()
  const endpoints = new Map<string, Endpoint>()
  const ioSpecificationsByOwner = new Map<string, InputOutputSpecification>()
  const inputOwners = new Map<string, string>()
  const outputOwners = new Map<string, string>()

  const registerId = (
    id: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const first = ids.get(id)
    if (first !== undefined) {
      diagnostics.push(error(
        Codes.DuplicateId,
        `Duplicate BPMN id '${id}'`,
        path,
        { firstPath: first.map(String).join("/") }
      ))
    } else {
      ids.set(id, path)
    }
  }

  const registerState = (
    state: DataState | undefined,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    if (state !== undefined) registerId(state.id, [...path, "id"])
  }

  for (let index = 0; index < (context?.owners.length ?? 0); index++) {
    const owner = context!.owners[index]!
    registerId(owner.id, ["ownerContext", "owners", index, "id"])
    if (!owners.has(owner.id)) owners.set(owner.id, owner)
    if (owner._tag === "Process" || owner._tag === "SubProcess") {
      if (!scopes.has(owner.id)) scopes.set(owner.id, owner)
    }
  }

  const checkScope = (
    scopeId: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): ProcessOwner | SubProcessOwner | undefined => {
    const scope = scopes.get(scopeId)
    if (scope === undefined) {
      diagnostics.push(error(Codes.UnknownScopeRef, `Unknown data scope '${scopeId}'`, path))
    }
    return scope
  }

  const validateNestedOwner = (
    owner: SubProcessOwner | TaskOwner | CallActivityOwner,
    index: number
  ): void => {
    const path = ["ownerContext", "owners", index] as const
    const process = owners.get(owner.processId)
    if (process?._tag !== "Process") {
      diagnostics.push(error(
        Codes.InvalidContainment,
        `Owner '${owner.id}' references a processId that is not a Process`,
        [...path, "processId"]
      ))
    }
    const parent = checkScope(owner.parentScopeId, [...path, "parentScopeId"])
    if (
      parent !== undefined &&
      (parent._tag === "Process" ? parent.id : parent.processId) !== owner.processId
    ) {
      diagnostics.push(error(
        Codes.InvalidContainment,
        `Owner '${owner.id}' and parent scope '${owner.parentScopeId}' belong to different Processes`,
        [...path, "parentScopeId"]
      ))
    }
    if (owner.id === owner.parentScopeId) {
      diagnostics.push(error(
        Codes.InvalidContainment,
        `Owner '${owner.id}' cannot contain itself`,
        [...path, "parentScopeId"]
      ))
    }
  }

  for (let index = 0; index < (context?.owners.length ?? 0); index++) {
    const owner = context!.owners[index]!
    if (
      owner._tag === "SubProcess" ||
      owner._tag === "Task" ||
      owner._tag === "CallActivity"
    ) {
      validateNestedOwner(owner, index)
    }
  }

  for (let index = 0; index < (context?.owners.length ?? 0); index++) {
    const owner = context!.owners[index]!
    if (owner._tag !== "SubProcess") continue
    const seen = new Set<string>([owner.id])
    let current: ProcessOwner | SubProcessOwner | undefined = scopes.get(owner.parentScopeId)
    while (current?._tag === "SubProcess") {
      if (seen.has(current.id)) {
        diagnostics.push(error(
          Codes.InvalidContainment,
          `SubProcess scope '${owner.id}' participates in a containment cycle`,
          ["ownerContext", "owners", index, "parentScopeId"]
        ))
        break
      }
      seen.add(current.id)
      current = scopes.get(current.parentScopeId)
    }
  }

  const isAncestorScope = (ancestorId: string, descendantId: string): boolean => {
    const visited = new Set<string>()
    let current = scopes.get(descendantId)
    while (current !== undefined && !visited.has(current.id)) {
      if (current.id === ancestorId) return true
      visited.add(current.id)
      current = current._tag === "SubProcess" ? scopes.get(current.parentScopeId) : undefined
    }
    return false
  }

  const ownerScopeId = (owner: SemanticOwner | undefined): string | undefined => {
    switch (owner?._tag) {
      case "Process":
      case "SubProcess":
        return owner.id
      case "Task":
      case "CallActivity":
        return owner.parentScopeId
      default:
        return undefined
    }
  }

  for (let index = 0; index < document.itemDefinitions.length; index++) {
    const item = document.itemDefinitions[index]!
    registerId(item.id, ["itemDefinitions", index, "id"])
    if (!itemDefinitions.has(item.id)) itemDefinitions.set(item.id, item)
  }
  for (let index = 0; index < document.dataStores.length; index++) {
    const store = document.dataStores[index]!
    registerId(store.id, ["dataStores", index, "id"])
    registerState(store.dataState, ["dataStores", index, "dataState"])
    if (!dataStores.has(store.id)) dataStores.set(store.id, store)
  }
  for (let index = 0; index < document.messages.length; index++) {
    const message = document.messages[index]!
    registerId(message.id, ["messages", index, "id"])
    if (!messages.has(message.id)) messages.set(message.id, message)
  }
  for (let index = 0; index < document.errors.length; index++) {
    const declaredError = document.errors[index]!
    registerId(declaredError.id, ["errors", index, "id"])
    if (!errors.has(declaredError.id)) errors.set(declaredError.id, declaredError)
  }
  for (let interfaceIndex = 0; interfaceIndex < document.interfaces.length; interfaceIndex++) {
    const declaredInterface = document.interfaces[interfaceIndex]!
    registerId(declaredInterface.id, ["interfaces", interfaceIndex, "id"])
    if (!interfaces.has(declaredInterface.id)) interfaces.set(declaredInterface.id, declaredInterface)
    for (let operationIndex = 0; operationIndex < declaredInterface.operations.length; operationIndex++) {
      const operation = declaredInterface.operations[operationIndex]!
      registerId(operation.id, ["interfaces", interfaceIndex, "operations", operationIndex, "id"])
      if (!operations.has(operation.id)) {
        operations.set(operation.id, { operation, interfaceId: declaredInterface.id })
      }
    }
  }

  const validateLocalQName = (
    ref: QName | undefined,
    declarations: ReadonlyMap<string, unknown>,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    role: string
  ): void => {
    const id = localQName(ref)
    if (id !== undefined && !declarations.has(id)) {
      diagnostics.push(error(
        Codes.UnknownLocalQNameRef,
        `Unknown local ${role} '${id}'`,
        path
      ))
    }
  }

  for (let index = 0; index < document.messages.length; index++) {
    validateLocalQName(
      document.messages[index]!.itemRef,
      itemDefinitions,
      ["messages", index, "itemRef"],
      "ItemDefinition"
    )
  }
  for (let index = 0; index < document.errors.length; index++) {
    validateLocalQName(
      document.errors[index]!.structureRef,
      itemDefinitions,
      ["errors", index, "structureRef"],
      "ItemDefinition"
    )
  }
  for (let interfaceIndex = 0; interfaceIndex < document.interfaces.length; interfaceIndex++) {
    const declaredInterface = document.interfaces[interfaceIndex]!
    for (let operationIndex = 0; operationIndex < declaredInterface.operations.length; operationIndex++) {
      const operation = declaredInterface.operations[operationIndex]!
      const path = ["interfaces", interfaceIndex, "operations", operationIndex] as const
      validateLocalQName(operation.inMessageRef, messages, [...path, "inMessageRef"], "Message")
      validateLocalQName(operation.outMessageRef, messages, [...path, "outMessageRef"], "Message")
      const seen = new Set<string>()
      for (let errorIndex = 0; errorIndex < operation.errorRefs.length; errorIndex++) {
        const ref = operation.errorRefs[errorIndex]!
        const key = qNameKey(ref)!
        if (seen.has(key)) {
          diagnostics.push(error(
            Codes.DuplicateReference,
            `Operation '${operation.id}' repeats an Error reference`,
            [...path, "errorRefs", errorIndex]
          ))
        }
        seen.add(key)
        validateLocalQName(ref, errors, [...path, "errorRefs", errorIndex], "Error")
      }
    }
  }

  for (let index = 0; index < (context?.owners.length ?? 0); index++) {
    const owner = context!.owners[index]!
    if (owner._tag !== "Process" && owner._tag !== "GlobalTask") continue
    const seen = new Set<string>()
    for (let refIndex = 0; refIndex < owner.supportedInterfaceRefs.length; refIndex++) {
      const ref = owner.supportedInterfaceRefs[refIndex]!
      const key = qNameKey(ref)!
      if (seen.has(key)) {
        diagnostics.push(error(
          Codes.DuplicateReference,
          `CallableElement '${owner.id}' repeats a supported Interface`,
          ["ownerContext", "owners", index, "supportedInterfaceRefs", refIndex]
        ))
      }
      seen.add(key)
      validateLocalQName(
        ref,
        interfaces,
        ["ownerContext", "owners", index, "supportedInterfaceRefs", refIndex],
        "Interface"
      )
    }
  }

  const effectiveStoreItem = (reference: DataStoreReference): QName | undefined => {
    if (reference.itemSubjectRef !== undefined) return reference.itemSubjectRef
    const localStoreId = localQName(reference.dataStoreRef)
    return localStoreId === undefined ? undefined : dataStores.get(localStoreId)?.itemSubjectRef
  }

  const validateCollection = (
    elementId: string,
    itemRef: QName | undefined,
    isCollection: boolean,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const itemId = localQName(itemRef)
    if (itemId === undefined) return
    const item = itemDefinitions.get(itemId)
    if (item !== undefined && item.isCollection !== isCollection) {
      diagnostics.push(error(
        Codes.InvalidCollectionCompatibility,
        `Item-aware element '${elementId}' collection flag does not match ItemDefinition '${itemId}'`,
        path
      ))
    }
  }

  for (let index = 0; index < document.dataStores.length; index++) {
    const store = document.dataStores[index]!
    validateLocalQName(
      store.itemSubjectRef,
      itemDefinitions,
      ["dataStores", index, "itemSubjectRef"],
      "ItemDefinition"
    )
  }

  for (let index = 0; index < document.dataObjects.length; index++) {
    const value = document.dataObjects[index]!
    const path = ["dataObjects", index] as const
    registerId(value.id, [...path, "id"])
    checkScope(value.containerId, [...path, "containerId"])
    validateLocalQName(value.itemSubjectRef, itemDefinitions, [...path, "itemSubjectRef"], "ItemDefinition")
    validateCollection(value.id, value.itemSubjectRef, value.isCollection, [...path, "isCollection"])
    if (!dataObjects.has(value.id)) dataObjects.set(value.id, value)
    if (!endpoints.has(value.id)) {
      endpoints.set(value.id, {
        kind: "DataObject",
        containerId: value.containerId,
        itemRef: value.itemSubjectRef,
        isCollection: value.isCollection
      })
    }
  }

  for (let index = 0; index < document.dataObjectReferences.length; index++) {
    const reference = document.dataObjectReferences[index]!
    const path = ["dataObjectReferences", index] as const
    registerId(reference.id, [...path, "id"])
    checkScope(reference.containerId, [...path, "containerId"])
    registerState(reference.dataState, [...path, "dataState"])
    const object = reference.dataObjectRef === undefined
      ? undefined
      : dataObjects.get(reference.dataObjectRef)
    if (reference.dataObjectRef !== undefined && object === undefined) {
      diagnostics.push(error(
        Codes.UnknownDataObjectRef,
        `Unknown DataObject '${reference.dataObjectRef}'`,
        [...path, "dataObjectRef"]
      ))
    } else if (object !== undefined && !isAncestorScope(object.containerId, reference.containerId)) {
      diagnostics.push(error(
        Codes.InvalidContainment,
        `DataObjectReference '${reference.id}' cannot access DataObject '${object.id}' from its container`,
        [...path, "dataObjectRef"]
      ))
    }
    if (!endpoints.has(reference.id)) {
      endpoints.set(reference.id, {
        kind: "DataObjectReference",
        containerId: reference.containerId,
        itemRef: object?.itemSubjectRef,
        isCollection: object?.isCollection
      })
    }
  }

  for (let index = 0; index < document.dataStoreReferences.length; index++) {
    const reference = document.dataStoreReferences[index]!
    const path = ["dataStoreReferences", index] as const
    registerId(reference.id, [...path, "id"])
    checkScope(reference.containerId, [...path, "containerId"])
    registerState(reference.dataState, [...path, "dataState"])
    validateLocalQName(
      reference.itemSubjectRef,
      itemDefinitions,
      [...path, "itemSubjectRef"],
      "ItemDefinition"
    )
    validateLocalQName(reference.dataStoreRef, dataStores, [...path, "dataStoreRef"], "DataStore")
    const localStoreId = localQName(reference.dataStoreRef)
    const storeItem = localStoreId === undefined ? undefined : dataStores.get(localStoreId)?.itemSubjectRef
    if (
      reference.itemSubjectRef !== undefined &&
      storeItem !== undefined &&
      !qNameEqual(reference.itemSubjectRef, storeItem)
    ) {
      diagnostics.push(error(
        Codes.InvalidItemCompatibility,
        `DataStoreReference '${reference.id}' item does not match its DataStore`,
        [...path, "itemSubjectRef"]
      ))
    }
    if (!endpoints.has(reference.id)) {
      endpoints.set(reference.id, {
        kind: "DataStoreReference",
        containerId: reference.containerId,
        itemRef: effectiveStoreItem(reference)
      })
    }
  }

  for (let index = 0; index < document.properties.length; index++) {
    const property = document.properties[index]!
    const path = ["properties", index] as const
    registerId(property.id, [...path, "id"])
    registerState(property.dataState, [...path, "dataState"])
    const owner = owners.get(property.ownerId)
    if (owner === undefined) {
      diagnostics.push(error(Codes.UnknownOwnerRef, `Unknown Property owner '${property.ownerId}'`, [
        ...path,
        "ownerId"
      ]))
    } else if (owner._tag === "GlobalTask") {
      diagnostics.push(error(
        Codes.UnsupportedOwner,
        `GlobalTask-owned Properties are outside this bounded slice`,
        [...path, "ownerId"]
      ))
    }
    validateLocalQName(
      property.itemSubjectRef,
      itemDefinitions,
      [...path, "itemSubjectRef"],
      "ItemDefinition"
    )
    if (!endpoints.has(property.id)) {
      endpoints.set(property.id, {
        kind: "Property",
        ownerId: property.ownerId,
        itemRef: property.itemSubjectRef
      })
    }
  }

  for (
    let specificationIndex = 0;
    specificationIndex < document.inputOutputSpecifications.length;
    specificationIndex++
  ) {
    const specification = document.inputOutputSpecifications[specificationIndex]!
    const path = ["inputOutputSpecifications", specificationIndex] as const
    registerId(specification.id, [...path, "id"])
    const owner = owners.get(specification.ownerId)
    if (owner === undefined) {
      diagnostics.push(error(
        Codes.UnknownOwnerRef,
        `Unknown IO specification owner '${specification.ownerId}'`,
        [...path, "ownerId"]
      ))
    } else if (owner._tag === "SubProcess") {
      diagnostics.push(error(
        Codes.UnsupportedOwner,
        `Embedded SubProcess '${owner.id}' cannot directly own an IO specification in this slice`,
        [...path, "ownerId"]
      ))
    }
    if (ioSpecificationsByOwner.has(specification.ownerId)) {
      diagnostics.push(error(
        Codes.InvalidContainment,
        `Owner '${specification.ownerId}' has more than one IO specification`,
        [...path, "ownerId"]
      ))
    } else {
      ioSpecificationsByOwner.set(specification.ownerId, specification)
    }

    for (let inputIndex = 0; inputIndex < specification.dataInputs.length; inputIndex++) {
      const inputElement = specification.dataInputs[inputIndex]!
      const inputPath = [...path, "dataInputs", inputIndex] as const
      registerId(inputElement.id, [...inputPath, "id"])
      registerState(inputElement.dataState, [...inputPath, "dataState"])
      validateLocalQName(
        inputElement.itemSubjectRef,
        itemDefinitions,
        [...inputPath, "itemSubjectRef"],
        "ItemDefinition"
      )
      validateCollection(
        inputElement.id,
        inputElement.itemSubjectRef,
        inputElement.isCollection,
        [...inputPath, "isCollection"]
      )
      if (!endpoints.has(inputElement.id)) {
        endpoints.set(inputElement.id, {
          kind: "DataInput",
          ownerId: specification.ownerId,
          itemRef: inputElement.itemSubjectRef,
          isCollection: inputElement.isCollection
        })
      }
      if (!inputOwners.has(inputElement.id)) inputOwners.set(inputElement.id, specification.ownerId)
    }
    for (let outputIndex = 0; outputIndex < specification.dataOutputs.length; outputIndex++) {
      const outputElement = specification.dataOutputs[outputIndex]!
      const outputPath = [...path, "dataOutputs", outputIndex] as const
      registerId(outputElement.id, [...outputPath, "id"])
      registerState(outputElement.dataState, [...outputPath, "dataState"])
      validateLocalQName(
        outputElement.itemSubjectRef,
        itemDefinitions,
        [...outputPath, "itemSubjectRef"],
        "ItemDefinition"
      )
      validateCollection(
        outputElement.id,
        outputElement.itemSubjectRef,
        outputElement.isCollection,
        [...outputPath, "isCollection"]
      )
      if (!endpoints.has(outputElement.id)) {
        endpoints.set(outputElement.id, {
          kind: "DataOutput",
          ownerId: specification.ownerId,
          itemRef: outputElement.itemSubjectRef,
          isCollection: outputElement.isCollection
        })
      }
      if (!outputOwners.has(outputElement.id)) outputOwners.set(outputElement.id, specification.ownerId)
    }
    for (let setIndex = 0; setIndex < specification.inputSets.length; setIndex++) {
      registerId(specification.inputSets[setIndex]!.id, [...path, "inputSets", setIndex, "id"])
    }
    for (let setIndex = 0; setIndex < specification.outputSets.length; setIndex++) {
      registerId(specification.outputSets[setIndex]!.id, [...path, "outputSets", setIndex, "id"])
    }
  }

  const validateRefs = (
    refs: ReadonlyArray<string>,
    valid: ReadonlySet<string>,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    unknownCode: Code,
    role: string
  ): void => {
    const seen = new Set<string>()
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index]!
      if (seen.has(ref)) {
        diagnostics.push(error(
          Codes.DuplicateReference,
          `Duplicate ${role} IDREF '${ref}'`,
          [...path, index]
        ))
      }
      seen.add(ref)
      if (!valid.has(ref)) {
        diagnostics.push(error(unknownCode, `Unknown ${role} '${ref}'`, [...path, index]))
      }
    }
  }

  for (
    let specificationIndex = 0;
    specificationIndex < document.inputOutputSpecifications.length;
    specificationIndex++
  ) {
    const specification = document.inputOutputSpecifications[specificationIndex]!
    const inputIds = new Set(specification.dataInputs.map((value) => value.id))
    const outputIds = new Set(specification.dataOutputs.map((value) => value.id))
    const inputSets = new Map(specification.inputSets.map((value) => [value.id, value]))
    const outputSets = new Map(specification.outputSets.map((value) => [value.id, value]))
    const inputSetIds = new Set(inputSets.keys())
    const outputSetIds = new Set(outputSets.keys())
    const coveredInputs = new Set<string>()
    const coveredOutputs = new Set<string>()
    const path = ["inputOutputSpecifications", specificationIndex] as const

    for (let setIndex = 0; setIndex < specification.inputSets.length; setIndex++) {
      const set = specification.inputSets[setIndex]!
      const setPath = [...path, "inputSets", setIndex] as const
      validateRefs(set.dataInputRefs, inputIds, [...setPath, "dataInputRefs"], Codes.UnknownDataRef, "DataInput")
      for (const ref of set.dataInputRefs) coveredInputs.add(ref)
      validateRefs(
        set.optionalInputRefs,
        new Set(set.dataInputRefs),
        [...setPath, "optionalInputRefs"],
        Codes.InvalidIoSetMembership,
        "optional DataInput"
      )
      validateRefs(
        set.whileExecutingInputRefs,
        new Set(set.dataInputRefs),
        [...setPath, "whileExecutingInputRefs"],
        Codes.InvalidIoSetMembership,
        "while-executing DataInput"
      )
      validateRefs(
        set.outputSetRefs,
        outputSetIds,
        [...setPath, "outputSetRefs"],
        Codes.UnknownOutputSetRef,
        "OutputSet"
      )
      for (let refIndex = 0; refIndex < set.outputSetRefs.length; refIndex++) {
        const outputSetId = set.outputSetRefs[refIndex]!
        const outputSet = outputSets.get(outputSetId)
        if (outputSet !== undefined && !outputSet.inputSetRefs.includes(set.id)) {
          diagnostics.push(error(
            Codes.InvalidIoSetReciprocity,
            `InputSet '${set.id}' links OutputSet '${outputSetId}' without a reciprocal inputSetRef`,
            [...setPath, "outputSetRefs", refIndex]
          ))
        }
      }
    }

    for (let setIndex = 0; setIndex < specification.outputSets.length; setIndex++) {
      const set = specification.outputSets[setIndex]!
      const setPath = [...path, "outputSets", setIndex] as const
      validateRefs(
        set.dataOutputRefs,
        outputIds,
        [...setPath, "dataOutputRefs"],
        Codes.UnknownDataRef,
        "DataOutput"
      )
      for (const ref of set.dataOutputRefs) coveredOutputs.add(ref)
      validateRefs(
        set.optionalOutputRefs,
        new Set(set.dataOutputRefs),
        [...setPath, "optionalOutputRefs"],
        Codes.InvalidIoSetMembership,
        "optional DataOutput"
      )
      validateRefs(
        set.whileExecutingOutputRefs,
        new Set(set.dataOutputRefs),
        [...setPath, "whileExecutingOutputRefs"],
        Codes.InvalidIoSetMembership,
        "while-executing DataOutput"
      )
      validateRefs(
        set.inputSetRefs,
        inputSetIds,
        [...setPath, "inputSetRefs"],
        Codes.UnknownInputSetRef,
        "InputSet"
      )
      for (let refIndex = 0; refIndex < set.inputSetRefs.length; refIndex++) {
        const inputSetId = set.inputSetRefs[refIndex]!
        const inputSet = inputSets.get(inputSetId)
        if (inputSet !== undefined && !inputSet.outputSetRefs.includes(set.id)) {
          diagnostics.push(error(
            Codes.InvalidIoSetReciprocity,
            `OutputSet '${set.id}' links InputSet '${inputSetId}' without a reciprocal outputSetRef`,
            [...setPath, "inputSetRefs", refIndex]
          ))
        }
      }
    }

    for (let inputIndex = 0; inputIndex < specification.dataInputs.length; inputIndex++) {
      const id = specification.dataInputs[inputIndex]!.id
      if (!coveredInputs.has(id)) {
        diagnostics.push(error(
          Codes.InvalidIoSetMembership,
          `DataInput '${id}' is not referenced by any InputSet`,
          [...path, "dataInputs", inputIndex, "id"]
        ))
      }
    }
    for (let outputIndex = 0; outputIndex < specification.dataOutputs.length; outputIndex++) {
      const id = specification.dataOutputs[outputIndex]!.id
      if (!coveredOutputs.has(id)) {
        diagnostics.push(error(
          Codes.InvalidIoSetMembership,
          `DataOutput '${id}' is not referenced by any OutputSet`,
          [...path, "dataOutputs", outputIndex, "id"]
        ))
      }
    }
  }

  const endpointAccessible = (endpoint: Endpoint, associationOwner: SemanticOwner): boolean => {
    const associationScope = ownerScopeId(associationOwner)
    if (associationScope === undefined) return false
    if (endpoint.containerId !== undefined) {
      return isAncestorScope(endpoint.containerId, associationScope)
    }
    if (endpoint.ownerId === undefined) return false
    if (endpoint.ownerId === associationOwner.id) return true
    const propertyOwner = owners.get(endpoint.ownerId)
    const propertyScope = ownerScopeId(propertyOwner)
    return propertyScope !== undefined &&
      (propertyOwner?._tag === "Process" || propertyOwner?._tag === "SubProcess") &&
      isAncestorScope(propertyScope, associationScope)
  }

  const checkAssociationItemCompatibility = (
    association: DataAssociation,
    sources: ReadonlyArray<Endpoint | undefined>,
    target: Endpoint | undefined,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    if (association.transformation !== undefined || target === undefined) return
    const source = sources[0]
    const collectionMismatch = source?.isCollection !== undefined &&
      target.isCollection !== undefined &&
      source.isCollection !== target.isCollection
    if (
      source === undefined ||
      !qNameEqual(source.itemRef, target.itemRef) ||
      collectionMismatch
    ) {
      diagnostics.push(error(
        Codes.InvalidItemCompatibility,
        `Untransformed DataAssociation '${association.id}' must connect equivalent ItemDefinitions`,
        path
      ))
    }
  }

  for (let index = 0; index < document.dataAssociations.length; index++) {
    const association = document.dataAssociations[index]!
    const path = ["dataAssociations", index] as const
    registerId(association.id, [...path, "id"])
    for (let assignmentIndex = 0; assignmentIndex < association.assignments.length; assignmentIndex++) {
      registerId(
        association.assignments[assignmentIndex]!.id,
        [...path, "assignments", assignmentIndex, "id"]
      )
    }
    const owner = owners.get(association.ownerId)
    if (owner === undefined) {
      diagnostics.push(error(
        Codes.UnknownOwnerRef,
        `Unknown DataAssociation owner '${association.ownerId}'`,
        [...path, "ownerId"]
      ))
    } else if (owner._tag !== "Task" && owner._tag !== "CallActivity") {
      diagnostics.push(error(
        Codes.UnsupportedOwner,
        `Only Task and CallActivity associations are supported; '${owner.id}' is ${owner._tag}`,
        [...path, "ownerId"]
      ))
    }
    if (association.transformation === undefined && association.sourceRefs.length !== 1) {
      diagnostics.push(error(
        Codes.InvalidAssociationCardinality,
        `Untransformed DataAssociation '${association.id}' must have exactly one source`,
        [...path, "sourceRefs"]
      ))
    }

    const seen = new Set<string>()
    const sources: Array<Endpoint | undefined> = []
    for (let sourceIndex = 0; sourceIndex < association.sourceRefs.length; sourceIndex++) {
      const ref = association.sourceRefs[sourceIndex]!
      if (seen.has(ref)) {
        diagnostics.push(error(
          Codes.DuplicateReference,
          `DataAssociation '${association.id}' repeats source IDREF '${ref}'`,
          [...path, "sourceRefs", sourceIndex]
        ))
      }
      seen.add(ref)
      const endpoint = endpoints.get(ref)
      sources.push(endpoint)
      if (endpoint === undefined) {
        diagnostics.push(error(
          Codes.InvalidAssociationEndpoint,
          `Unknown DataAssociation source '${ref}'`,
          [...path, "sourceRefs", sourceIndex]
        ))
      } else if (owner !== undefined && !endpointAccessible(endpoint, owner)) {
        diagnostics.push(error(
          Codes.InaccessibleDataRef,
          `DataAssociation owner '${owner.id}' cannot access source '${ref}'`,
          [...path, "sourceRefs", sourceIndex]
        ))
      }
    }
    const target = endpoints.get(association.targetRef)
    if (target === undefined) {
      diagnostics.push(error(
        Codes.InvalidAssociationEndpoint,
        `Unknown DataAssociation target '${association.targetRef}'`,
        [...path, "targetRef"]
      ))
    } else if (owner !== undefined && !endpointAccessible(target, owner)) {
      diagnostics.push(error(
        Codes.InaccessibleDataRef,
        `DataAssociation owner '${owner.id}' cannot access target '${association.targetRef}'`,
        [...path, "targetRef"]
      ))
    }

    if (association._tag === "DataInputAssociation") {
      if (target?.kind !== "DataInput" || target.ownerId !== association.ownerId) {
        diagnostics.push(error(
          Codes.InvalidAssociationEndpoint,
          `DataInputAssociation '${association.id}' must target its owner's DataInput`,
          [...path, "targetRef"]
        ))
      }
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex]
        const sourceOwner = source?.ownerId === undefined ? undefined : owners.get(source.ownerId)
        if (
          source?.kind === "DataOutput" ||
          (source?.kind === "DataInput" && sourceOwner?._tag !== "Process")
        ) {
          diagnostics.push(error(
            Codes.InvalidAssociationEndpoint,
            `DataInputAssociation '${association.id}' source must be scoped data or an accessible Process DataInput`,
            [...path, "sourceRefs", sourceIndex]
          ))
        }
      }
    } else {
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex]
        if (source?.kind !== "DataOutput" || source.ownerId !== association.ownerId) {
          diagnostics.push(error(
            Codes.InvalidAssociationEndpoint,
            `DataOutputAssociation '${association.id}' sources must be its owner's DataOutputs`,
            [...path, "sourceRefs", sourceIndex]
          ))
        }
      }
      const targetOwner = target?.ownerId === undefined ? undefined : owners.get(target.ownerId)
      if (
        target?.kind === "DataInput" ||
        (target?.kind === "DataOutput" && targetOwner?._tag !== "Process")
      ) {
        diagnostics.push(error(
          Codes.InvalidAssociationEndpoint,
          `DataOutputAssociation '${association.id}' must target scoped data or an accessible Process DataOutput`,
          [...path, "targetRef"]
        ))
      }
    }
    checkAssociationItemCompatibility(association, sources, target, path)
  }

  const ownerSupportsInterface = (
    owner: ProcessOwner | GlobalTaskOwner,
    interfaceId: string
  ): boolean => owner.supportedInterfaceRefs.some((ref) => ref._tag === "LocalQName" && ref.id === interfaceId)

  for (let index = 0; index < document.inputOutputBindings.length; index++) {
    const binding = document.inputOutputBindings[index]!
    const path = ["inputOutputBindings", index] as const
    registerId(binding.id, [...path, "id"])
    const owner = owners.get(binding.ownerId)
    if (owner === undefined) {
      diagnostics.push(error(
        Codes.UnknownOwnerRef,
        `Unknown InputOutputBinding owner '${binding.ownerId}'`,
        [...path, "ownerId"]
      ))
    } else if (owner._tag !== "Process" && owner._tag !== "GlobalTask") {
      diagnostics.push(error(
        Codes.InvalidBinding,
        `InputOutputBinding owner '${owner.id}' is not a CallableElement supported by this slice`,
        [...path, "ownerId"]
      ))
    }

    const operationId = localQName(binding.operationRef)
    const operationLocation = operationId === undefined ? undefined : operations.get(operationId)
    if (binding.operationRef._tag === "ExternalQName") {
      diagnostics.push(error(
        Codes.UnsupportedExternalOperationBinding,
        "External Operation bindings cannot be verified against a CallableElement's supported Interfaces",
        [...path, "operationRef"]
      ))
    } else if (operationLocation === undefined) {
      diagnostics.push(error(
        Codes.UnknownLocalQNameRef,
        `Unknown local Operation '${binding.operationRef.id}'`,
        [...path, "operationRef"]
      ))
    } else if (
      (owner?._tag === "Process" || owner?._tag === "GlobalTask") &&
      !ownerSupportsInterface(owner, operationLocation.interfaceId)
    ) {
      diagnostics.push(error(
        Codes.InvalidBinding,
        `Operation '${operationId}' is not part of an Interface supported by '${owner.id}'`,
        [...path, "operationRef"]
      ))
    }

    const specification = ioSpecificationsByOwner.get(binding.ownerId)
    const input = endpoints.get(binding.inputDataRef)
    const output = endpoints.get(binding.outputDataRef)
    if (
      specification === undefined ||
      input?.kind !== "DataInput" ||
      inputOwners.get(binding.inputDataRef) !== binding.ownerId
    ) {
      diagnostics.push(error(
        Codes.InvalidBinding,
        `Binding input '${binding.inputDataRef}' is not owned by CallableElement '${binding.ownerId}'`,
        [...path, "inputDataRef"]
      ))
    }
    if (
      specification === undefined ||
      output?.kind !== "DataOutput" ||
      outputOwners.get(binding.outputDataRef) !== binding.ownerId
    ) {
      diagnostics.push(error(
        Codes.InvalidBinding,
        `Binding output '${binding.outputDataRef}' is not owned by CallableElement '${binding.ownerId}'`,
        [...path, "outputDataRef"]
      ))
    }

    if (operationLocation !== undefined && input?.kind === "DataInput") {
      const messageId = localQName(operationLocation.operation.inMessageRef)
      const messageItem = messageId === undefined ? undefined : messages.get(messageId)?.itemRef
      if (messageId !== undefined && !qNameEqual(input.itemRef, messageItem)) {
        diagnostics.push(error(
          Codes.InvalidItemCompatibility,
          `Binding input '${binding.inputDataRef}' does not match Operation input Message '${messageId}'`,
          [...path, "inputDataRef"]
        ))
      }
    }
    if (operationLocation !== undefined && output?.kind === "DataOutput") {
      const messageId = localQName(operationLocation.operation.outMessageRef)
      const messageItem = messageId === undefined ? undefined : messages.get(messageId)?.itemRef
      if (messageId !== undefined && !qNameEqual(output.itemRef, messageItem)) {
        diagnostics.push(error(
          Codes.InvalidItemCompatibility,
          `Binding output '${binding.outputDataRef}' does not match Operation output Message '${messageId}'`,
          [...path, "outputDataRef"]
        ))
      }
    }
  }

  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }
  return Result.succeed(document)
}
