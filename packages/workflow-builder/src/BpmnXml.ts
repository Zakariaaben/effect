/**
 * Strict BPMN 2.0.2 core-process XML interchange profile.
 *
 * **Details**
 *
 * This module maps one deliberately bounded, named BPMN XML profile to the
 * portable {@link BpmnModel.BpmnModel} and {@link BpmnDi.BpmnDiDocument}
 * representations. The profile fails closed for every XML construct it cannot
 * represent. It applies selected structural and lexical rules from the BPMN
 * 2.0.2 XSDs, but is not a general XSD validator and makes no BPMN conformance
 * claim.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnDi from "./BpmnDi.ts"
import * as BpmnModel from "./BpmnModel.ts"
import * as BpmnXmlAst from "./BpmnXmlAst.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const ModelNamespace = "http://www.omg.org/spec/BPMN/20100524/MODEL"
const BpmnDiNamespace = "http://www.omg.org/spec/BPMN/20100524/DI"
const DiNamespace = "http://www.omg.org/spec/DD/20100524/DI"
const DcNamespace = "http://www.omg.org/spec/DD/20100524/DC"
const XsiNamespace = "http://www.w3.org/2001/XMLSchema-instance"
const XmlNamespace = "http://www.w3.org/XML/1998/namespace"
const XPath10Language = "http://www.w3.org/1999/XPath"
const XmlSchemaLanguage = "http://www.w3.org/2001/XMLSchema"

const EmptyExtensions: ReadonlyArray<BpmnModel.ExtensionElement> = Object.freeze([])
const jsonLimits: Json.SnapshotLimits = Object.freeze({
  maxArrayLength: 250_000,
  maxContainers: 500_000,
  maxDepth: 256,
  maxEntries: 2_000_000
})

const NonEmpty = Schema.NonEmptyString
const Path = Schema.Array(Diagnostic.PathSegment)

/**
 * Stable identifier of the bounded XML mapping profile.
 *
 * @category constants
 * @since 4.0.0
 */
export const CoreProcessDiProfileId = "bpmn-2.0.2-core-process-di-v2" as const

/**
 * Normalized metadata carried by one BPMN `definitions` element.
 *
 * **Details**
 *
 * `expressionLanguage` and `typeLanguage` are always materialized. When their
 * XML attributes are absent, the BPMN 2.0.2 defaults are used and recorded in
 * the mapping report.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DefinitionsMetadata = Schema.Struct({
  id: Schema.optionalKey(NonEmpty),
  name: Schema.optionalKey(Schema.String),
  targetNamespace: NonEmpty,
  expressionLanguage: NonEmpty,
  typeLanguage: NonEmpty,
  exporter: Schema.optionalKey(NonEmpty),
  exporterVersion: Schema.optionalKey(NonEmpty)
}).annotate({
  identifier: "WorkflowBpmnXmlDefinitionsMetadata",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DefinitionsMetadata}.
 *
 * @category models
 * @since 4.0.0
 */
export type DefinitionsMetadata = Schema.Schema.Type<typeof DefinitionsMetadata>

/**
 * Exact runtime version binding for an expression-language URI.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExpressionLanguageBinding = Schema.Struct({
  language: NonEmpty,
  version: NonEmpty
}).annotate({
  identifier: "WorkflowBpmnXmlExpressionLanguageBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExpressionLanguageBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExpressionLanguageBinding = Schema.Schema.Type<typeof ExpressionLanguageBinding>

/**
 * One deterministic explanation of a mapping default or normalization.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MappingNotice = Schema.Struct({
  code: NonEmpty,
  message: NonEmpty,
  path: Path
}).annotate({
  identifier: "WorkflowBpmnXmlMappingNotice",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MappingNotice}.
 *
 * @category models
 * @since 4.0.0
 */
export type MappingNotice = Schema.Schema.Type<typeof MappingNotice>

/**
 * Explicit loss, default, and lexical-normalization report for one mapping.
 *
 * **Details**
 *
 * A successful document in this profile always has an empty
 * `semanticLosses` array. Prefixes, insignificant formatting, XML declaration
 * details, and equivalent XSD lexical forms are intentionally not preserved
 * and are reported separately.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MappingReport = Schema.Struct({
  profileId: Schema.Literal(CoreProcessDiProfileId),
  semanticLosses: Schema.Array(MappingNotice),
  defaultsApplied: Schema.Array(MappingNotice),
  normalizations: Schema.Array(MappingNotice),
  lexicalNonPreservation: Schema.Array(MappingNotice)
}).annotate({
  identifier: "WorkflowBpmnXmlMappingReport",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MappingReport}.
 *
 * @category models
 * @since 4.0.0
 */
export type MappingReport = Schema.Schema.Type<typeof MappingReport>

/**
 * Portable result of importing the named core-process/DI profile.
 *
 * @category schemas
 * @since 4.0.0
 */
export const InterchangeDocument = Schema.Struct({
  profileId: Schema.Literal(CoreProcessDiProfileId),
  definitions: DefinitionsMetadata,
  expressionLanguageBindings: Schema.Array(ExpressionLanguageBinding),
  model: BpmnModel.BpmnModel,
  di: Schema.optionalKey(BpmnDi.BpmnDiDocument),
  mappingReport: MappingReport
}).annotate({
  identifier: "WorkflowBpmnXmlInterchangeDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link InterchangeDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type InterchangeDocument = Schema.Schema.Type<typeof InterchangeDocument>

/**
 * Strict import controls, including provenance and expression versions.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ImportOptions = Schema.Struct({
  importId: NonEmpty,
  locator: Schema.optionalKey(NonEmpty),
  expressionLanguageBindings: Schema.Array(ExpressionLanguageBinding),
  limits: Schema.optionalKey(BpmnXmlAst.XmlLimits)
}).annotate({
  identifier: "WorkflowBpmnXmlImportOptions",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ImportOptions}.
 *
 * @category models
 * @since 4.0.0
 */
export type ImportOptions = Schema.Schema.Type<typeof ImportOptions>

/**
 * Deterministic XML serialization controls.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExportOptions = Schema.Struct({
  format: Schema.optionalKey(Schema.Literals(["compact", "pretty"])),
  indent: Schema.optionalKey(Schema.String),
  newline: Schema.optionalKey(Schema.Literals(["\n", "\r\n"])),
  limits: Schema.optionalKey(BpmnXmlAst.XmlLimits)
}).annotate({
  identifier: "WorkflowBpmnXmlExportOptions",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExportOptions}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExportOptions = Schema.Schema.Type<typeof ExportOptions>

/**
 * Stable diagnostic codes emitted by the named XML profile.
 *
 * @category errors
 * @since 4.0.0
 */
export const Codes = {
  InvalidInput: "InvalidBpmnXmlInput",
  InvalidOptions: "InvalidBpmnXmlOptions",
  InvalidDocument: "InvalidBpmnXmlDocument",
  InvalidStructure: "InvalidBpmnXmlStructure",
  InvalidLexicalValue: "InvalidBpmnXmlLexicalValue",
  InvalidId: "InvalidBpmnXmlId",
  DuplicateId: "DuplicateBpmnXmlId",
  InvalidReference: "InvalidBpmnXmlReference",
  InvalidQName: "InvalidBpmnXmlQName",
  UnknownPrefix: "UnknownBpmnXmlPrefix",
  UnsupportedNamespace: "UnsupportedBpmnXmlNamespace",
  UnsupportedElement: "UnsupportedBpmnXmlElement",
  UnsupportedAttribute: "UnsupportedBpmnXmlAttribute",
  UnsupportedModel: "UnsupportedBpmnXmlModel",
  UnsupportedDi: "UnsupportedBpmnXmlDi",
  MissingExpressionBinding: "MissingBpmnExpressionBinding",
  DuplicateExpressionBinding: "DuplicateBpmnExpressionBinding",
  ExpressionVersionMismatch: "BpmnExpressionVersionMismatch",
  SemanticLoss: "BpmnXmlSemanticLoss"
} as const

/**
 * One stable diagnostic code emitted by this profile.
 *
 * @category models
 * @since 4.0.0
 */
export type BpmnXmlCode = typeof Codes[keyof typeof Codes]

const profileError = (
  code: BpmnXmlCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment> = [],
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

const compilationError = (
  head: Diagnostic.Diagnostic,
  tail: ReadonlyArray<Diagnostic.Diagnostic> = []
): Diagnostic.CompilationError =>
  new Diagnostic.CompilationError({
    diagnostics: [head, ...tail]
  })

class MappingAbort {
  readonly diagnostic: Diagnostic.Diagnostic

  constructor(diagnostic: Diagnostic.Diagnostic) {
    this.diagnostic = diagnostic
  }
}

const abort = (
  code: BpmnXmlCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment> = [],
  details?: Schema.Json
): never => {
  throw new MappingAbort(profileError(code, message, path, details))
}

const xmlPath = (
  element: BpmnXmlAst.XmlElement,
  suffix: ReadonlyArray<Diagnostic.PathSegment> = []
): ReadonlyArray<Diagnostic.PathSegment> => [
  "xml",
  element.span.start.offset,
  ...suffix
]

const decodeImportOptions = Schema.decodeUnknownResult(ImportOptions, strictParseOptions)
const decodeExportOptions = Schema.decodeUnknownResult(ExportOptions, strictParseOptions)
const decodeInterchange = Schema.decodeUnknownResult(InterchangeDocument, strictParseOptions)

const safeDecode = <A>(
  input: unknown,
  decode: (input: unknown) => Result.Result<A, unknown>,
  code: BpmnXmlCode,
  message: string
): Result.Result<A, Diagnostic.CompilationError> => {
  const snapshot = Json.snapshot(input, jsonLimits)
  if (Result.isFailure(snapshot)) {
    return Result.fail(compilationError(profileError(
      code,
      snapshot.failure.message,
      snapshot.failure.path
    )))
  }
  const decoded = decode(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(profileError(
      code,
      message,
      [],
      { issue: String(decoded.failure) }
    )))
  }
  return Result.succeed(snapshot.success as unknown as A)
}

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

interface MutableReport {
  readonly semanticLosses: Array<MappingNotice>
  readonly defaultsApplied: Array<MappingNotice>
  readonly normalizations: Array<MappingNotice>
  readonly lexicalNonPreservation: Array<MappingNotice>
}

const notice = (
  target: Array<MappingNotice>,
  code: string,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>
): void => {
  target.push({ code, message, path: [...path] })
}

const normalizeToken = (
  value: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): string => {
  const normalized = value
    .replaceAll(/[\t\n\r ]+/g, " ")
    .replace(/^ | $/g, "")
  if (normalized !== value) {
    notice(
      report.lexicalNonPreservation,
      "CollapsedTokenWhitespace",
      `${owner} uses the XML Schema collapsed token value '${normalized}'`,
      path
    )
  }
  return normalized
}

const normalizedAnyUri = (
  value: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): string => {
  const normalized = normalizeToken(value, report, path, owner)
  if (normalized.length === 0) {
    abort(Codes.InvalidLexicalValue, `${owner} must be non-empty`, path)
  }
  return normalized
}

const assertNormalizedAnyUri = (
  value: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): void => {
  const normalized = value
    .replaceAll(/[\t\n\r ]+/g, " ")
    .replace(/^ | $/g, "")
  if (normalized.length === 0 || normalized !== value) {
    abort(
      Codes.InvalidLexicalValue,
      `${owner} must be a non-empty whitespace-collapsed XML Schema anyURI`,
      path
    )
  }
}

const readId = (
  value: string | undefined,
  required: boolean,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): string | undefined => {
  if (value === undefined) {
    if (required) {
      abort(Codes.InvalidStructure, `${owner} requires an id`, path)
    }
    return undefined
  }
  const id = normalizeToken(value, report, path, `${owner} id`)
  if (!isNcName(id)) {
    abort(Codes.InvalidId, `${owner} id '${id}' is not an XML Schema NCName`, path)
  }
  return id
}

const readRequiredText = (
  value: string | undefined,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): string => {
  if (value === undefined || value.length === 0) {
    abort(Codes.InvalidStructure, `${owner} requires a non-empty value`, path)
  }
  return value!
}

const readBoolean = (
  value: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): boolean => {
  const normalized = normalizeToken(value, report, path, owner)
  switch (normalized) {
    case "true":
      return true
    case "false":
      return false
    case "1":
      notice(
        report.lexicalNonPreservation,
        "BooleanLexicalForm",
        `${owner} boolean lexical form '1' is normalized to 'true'`,
        path
      )
      return true
    case "0":
      notice(
        report.lexicalNonPreservation,
        "BooleanLexicalForm",
        `${owner} boolean lexical form '0' is normalized to 'false'`,
        path
      )
      return false
    default:
      return abort(Codes.InvalidLexicalValue, `${owner} is not an XML Schema boolean`, path)
  }
}

const doublePattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

const readDouble = (
  value: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): number => {
  const normalized = normalizeToken(value, report, path, owner)
  if (!doublePattern.test(normalized)) {
    abort(Codes.InvalidLexicalValue, `${owner} is not a supported finite XML Schema double`, path)
  }
  const number = Number(normalized)
  if (!Number.isFinite(number)) {
    abort(Codes.InvalidLexicalValue, `${owner} must be finite`, path)
  }
  if (String(number) !== normalized) {
    notice(
      report.lexicalNonPreservation,
      "DoubleLexicalForm",
      `${owner} numeric lexical form is normalized`,
      path
    )
  }
  return Object.is(number, -0) ? 0 : number
}

type NamespaceContext = ReadonlyMap<string, string>

const namespaceContext = (
  parent: NamespaceContext,
  element: BpmnXmlAst.XmlElement
): NamespaceContext => {
  if (element.namespaceDeclarations.length === 0) {
    return parent
  }
  const context = new Map(parent)
  for (const declaration of element.namespaceDeclarations) {
    context.set(declaration.prefix, declaration.namespaceUri)
  }
  return context
}

interface QName {
  readonly namespaceUri: string
  readonly localName: string
}

const readQName = (
  value: string,
  context: NamespaceContext,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): QName => {
  const normalized = normalizeToken(value, report, path, owner)
  const colon = normalized.indexOf(":")
  if (colon !== normalized.lastIndexOf(":")) {
    abort(Codes.InvalidQName, `${owner} is not an XML Schema QName`, path)
  }
  const prefix = colon < 0 ? "" : normalized.slice(0, colon)
  const localName = colon < 0 ? normalized : normalized.slice(colon + 1)
  if (!isNcName(localName) || prefix.length > 0 && !isNcName(prefix)) {
    abort(Codes.InvalidQName, `${owner} is not an XML Schema QName`, path)
  }
  const namespaceUri = context.get(prefix)
  if (prefix.length > 0 && namespaceUri === undefined) {
    abort(Codes.UnknownPrefix, `${owner} uses unbound prefix '${prefix}'`, path)
  }
  return {
    namespaceUri: namespaceUri ?? "",
    localName
  }
}

const readModelQNameRef = (
  value: string,
  context: NamespaceContext,
  targetNamespace: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): string => {
  const qname = readQName(value, context, report, path, owner)
  if (qname.namespaceUri !== "" && qname.namespaceUri !== targetNamespace) {
    abort(
      Codes.InvalidReference,
      `${owner} must resolve to the empty namespace or definitions targetNamespace`,
      path,
      { namespaceUri: qname.namespaceUri }
    )
  }
  return qname.localName
}

const readDiQNameRef = (
  value: string,
  context: NamespaceContext,
  targetNamespace: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): string => {
  const qname = readQName(value, context, report, path, owner)
  if (qname.namespaceUri !== "" && qname.namespaceUri !== targetNamespace) {
    abort(
      Codes.InvalidReference,
      `${owner} must resolve to the empty namespace or definitions targetNamespace`,
      path,
      { namespaceUri: qname.namespaceUri }
    )
  }
  return qname.localName
}

const expandedKey = (namespaceUri: string, localName: string): string => `{${namespaceUri}}${localName}`

const readAttributes = (
  element: BpmnXmlAst.XmlElement,
  unqualified: ReadonlySet<string>,
  expanded: ReadonlySet<string> = new Set()
): ReadonlyMap<string, string> => {
  const attributes = new Map<string, string>()
  for (const attribute of element.attributes) {
    const key = expandedKey(attribute.name.namespaceUri, attribute.name.localName)
    const allowed = attribute.name.namespaceUri === ""
      ? unqualified.has(attribute.name.localName)
      : expanded.has(key)
    if (!allowed) {
      abort(
        attribute.name.namespaceUri === "" ? Codes.UnsupportedAttribute : Codes.UnsupportedNamespace,
        `Attribute '${attribute.name.localName}' in namespace '${attribute.name.namespaceUri}' is not represented by this profile`,
        xmlPath(element, ["attributes", attribute.name.localName])
      )
    }
    attributes.set(key, attribute.value)
  }
  return attributes
}

const unqualifiedAttribute = (
  attributes: ReadonlyMap<string, string>,
  name: string
): string | undefined => attributes.get(expandedKey("", name))

const expandedAttribute = (
  attributes: ReadonlyMap<string, string>,
  namespaceUri: string,
  name: string
): string | undefined => attributes.get(expandedKey(namespaceUri, name))

const isElementNamed = (
  element: BpmnXmlAst.XmlElement,
  namespaceUri: string,
  localName: string
): boolean => element.name.namespaceUri === namespaceUri && element.name.localName === localName

const structuralChildren = (
  element: BpmnXmlAst.XmlElement
): ReadonlyArray<BpmnXmlAst.XmlElement> => {
  const children: Array<BpmnXmlAst.XmlElement> = []
  for (let index = 0; index < element.children.length; index++) {
    const child = element.children[index]!
    if (child._tag === "Text" && child.value.trim().length === 0) {
      continue
    }
    if (child._tag !== "Element") {
      abort(
        Codes.InvalidStructure,
        `Character data, comments, CDATA, and processing instructions are not allowed in '${element.name.localName}'`,
        xmlPath(element, ["children", index])
      )
    }
    children.push(child as BpmnXmlAst.XmlElement)
  }
  return children
}

const simpleContent = (
  element: BpmnXmlAst.XmlElement,
  report: MutableReport,
  owner: string
): string => {
  if (element.attributes.length > 0) {
    abort(
      Codes.UnsupportedAttribute,
      `${owner} does not allow attributes in this profile`,
      xmlPath(element, ["attributes"])
    )
  }
  let value = ""
  for (let index = 0; index < element.children.length; index++) {
    const child = element.children[index]!
    if (child._tag === "Text" || child._tag === "CData") {
      value += child.value
      if (child._tag === "CData") {
        notice(
          report.lexicalNonPreservation,
          "CDataLexicalForm",
          `${owner} CDATA boundaries are not preserved`,
          xmlPath(element, ["children", index])
        )
      }
      continue
    }
    abort(
      Codes.InvalidStructure,
      `${owner} only allows simple character content`,
      xmlPath(element, ["children", index])
    )
  }
  return value
}

interface BindingTable {
  readonly bindings: ReadonlyArray<ExpressionLanguageBinding>
  readonly byLanguage: ReadonlyMap<string, string>
}

const bindingTable = (
  bindings: ReadonlyArray<ExpressionLanguageBinding>,
  path: ReadonlyArray<Diagnostic.PathSegment>
): BindingTable => {
  const byLanguage = new Map<string, string>()
  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index]!
    assertNormalizedAnyUri(
      binding.language,
      [...path, index, "language"],
      "Expression language binding"
    )
    const previous = byLanguage.get(binding.language)
    if (previous !== undefined) {
      abort(
        Codes.DuplicateExpressionBinding,
        `Expression language '${binding.language}' has more than one version binding`,
        [...path, index, "language"],
        { previousVersion: previous, version: binding.version }
      )
    }
    byLanguage.set(binding.language, binding.version)
  }
  return { bindings, byLanguage }
}

interface ParserState {
  readonly metadata: DefinitionsMetadata
  readonly bindings: BindingTable
  readonly report: MutableReport
  readonly nodes: Array<BpmnModel.FlowNode>
  readonly flows: Array<BpmnModel.SequenceFlow>
  readonly parsedNodes: Array<ParsedNode>
  readonly processes: Array<BpmnModel.Process>
}

interface ParsedNode {
  readonly node: BpmnModel.FlowNode
  readonly suppliedRefs: boolean
  readonly incoming: ReadonlyArray<string>
  readonly outgoing: ReadonlyArray<string>
  readonly defaultRef: string | undefined
  readonly path: ReadonlyArray<Diagnostic.PathSegment>
}

const expression = (
  element: BpmnXmlAst.XmlElement,
  context: NamespaceContext,
  state: ParserState
): BpmnModel.Expression => {
  if (!isElementNamed(element, ModelNamespace, "conditionExpression")) {
    abort(
      Codes.UnsupportedElement,
      `Expected BPMN conditionExpression, received '${element.name.localName}'`,
      xmlPath(element)
    )
  }
  const attributes = readAttributes(
    element,
    new Set(["language"]),
    new Set([expandedKey(XsiNamespace, "type")])
  )
  const typeValue = expandedAttribute(attributes, XsiNamespace, "type")
  if (typeValue === undefined) {
    abort(
      Codes.InvalidStructure,
      "conditionExpression requires xsi:type resolving to BPMN tFormalExpression",
      xmlPath(element, ["attributes", "type"])
    )
  }
  const type = readQName(
    typeValue!,
    context,
    state.report,
    xmlPath(element, ["attributes", "type"]),
    "conditionExpression xsi:type"
  )
  if (type.namespaceUri !== ModelNamespace || type.localName !== "tFormalExpression") {
    abort(
      Codes.InvalidStructure,
      "conditionExpression xsi:type must resolve exactly to BPMN tFormalExpression",
      xmlPath(element, ["attributes", "type"]),
      { namespaceUri: type.namespaceUri, localName: type.localName }
    )
  }
  const languageLexical = unqualifiedAttribute(attributes, "language")
  const language = languageLexical === undefined
    ? state.metadata.expressionLanguage
    : normalizedAnyUri(
      languageLexical,
      state.report,
      xmlPath(element, ["attributes", "language"]),
      "conditionExpression language"
    )
  const version = state.bindings.byLanguage.get(language)
  if (version === undefined) {
    abort(
      Codes.MissingExpressionBinding,
      `No exact version binding was supplied for expression language '${language}'`,
      xmlPath(element, ["attributes", "language"])
    )
  }
  let source = ""
  for (let index = 0; index < element.children.length; index++) {
    const child = element.children[index]!
    if (child._tag === "Text" || child._tag === "CData") {
      source += child.value
      if (child._tag === "CData") {
        notice(
          state.report.lexicalNonPreservation,
          "ExpressionCDataLexicalForm",
          "Expression CDATA boundaries are not preserved",
          xmlPath(element, ["children", index])
        )
      }
      continue
    }
    abort(
      Codes.InvalidStructure,
      "conditionExpression cannot contain elements, comments, or processing instructions",
      xmlPath(element, ["children", index])
    )
  }
  if (source.length === 0) {
    abort(
      Codes.InvalidStructure,
      "conditionExpression source must be non-empty",
      xmlPath(element, ["children"])
    )
  }
  return { language, version: version!, source }
}

const parseReferenceChild = (
  element: BpmnXmlAst.XmlElement,
  context: NamespaceContext,
  state: ParserState,
  owner: string
): string =>
  readModelQNameRef(
    simpleContent(element, state.report, owner),
    context,
    state.metadata.targetNamespace,
    state.report,
    xmlPath(element, ["children"]),
    owner
  )

interface NodeChildren {
  readonly supplied: boolean
  readonly incoming: ReadonlyArray<string>
  readonly outgoing: ReadonlyArray<string>
  readonly contained: ReadonlyArray<BpmnXmlAst.XmlElement>
}

const parseNodeChildren = (
  element: BpmnXmlAst.XmlElement,
  context: NamespaceContext,
  state: ParserState,
  allowContained: boolean
): NodeChildren => {
  const incoming: Array<string> = []
  const outgoing: Array<string> = []
  const contained: Array<BpmnXmlAst.XmlElement> = []
  let stage = 0
  let supplied = false
  for (const child of structuralChildren(element)) {
    if (isElementNamed(child, ModelNamespace, "incoming")) {
      if (stage > 0) {
        abort(
          Codes.InvalidStructure,
          "BPMN incoming elements must precede outgoing and contained flow elements",
          xmlPath(child)
        )
      }
      supplied = true
      incoming.push(parseReferenceChild(
        child,
        namespaceContext(context, child),
        state,
        `${element.name.localName} incoming`
      ))
      continue
    }
    if (isElementNamed(child, ModelNamespace, "outgoing")) {
      if (stage > 1) {
        abort(
          Codes.InvalidStructure,
          "BPMN outgoing elements must precede contained flow elements",
          xmlPath(child)
        )
      }
      stage = 1
      supplied = true
      outgoing.push(parseReferenceChild(
        child,
        namespaceContext(context, child),
        state,
        `${element.name.localName} outgoing`
      ))
      continue
    }
    if (!allowContained) {
      abort(
        child.name.namespaceUri === ModelNamespace
          ? Codes.UnsupportedElement
          : Codes.UnsupportedNamespace,
        `Element '${child.name.localName}' is not represented inside '${element.name.localName}'`,
        xmlPath(child)
      )
    }
    stage = 2
    contained.push(child)
  }
  return { supplied, incoming, outgoing, contained }
}

const commonNodeAttributes = new Set([
  "id",
  "name"
])

const activityAttributes = new Set([
  ...commonNodeAttributes,
  "default",
  "isForCompensation",
  "startQuantity",
  "completionQuantity"
])

const readPositiveOne = (
  value: string,
  report: MutableReport,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): 1 => {
  const normalized = normalizeToken(value, report, path, owner)
  if (!/^[+]?\d+$/.test(normalized) || Number(normalized) !== 1) {
    abort(
      Codes.UnsupportedModel,
      `${owner} must be omitted or equal to 1 in this profile`,
      path
    )
  }
  return 1
}

const nodeName = (
  attributes: ReadonlyMap<string, string>,
  element: BpmnXmlAst.XmlElement
): string | undefined => {
  const name = unqualifiedAttribute(attributes, "name")
  if (name !== undefined && name.length === 0) {
    abort(
      Codes.UnsupportedModel,
      `${element.name.localName} empty names cannot be represented by the semantic IR`,
      xmlPath(element, ["attributes", "name"])
    )
  }
  return name
}

const parseNode = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  processId: string,
  scopeId: string,
  state: ParserState
): void => {
  const context = namespaceContext(parentContext, element)
  const localName = element.name.localName
  if (element.name.namespaceUri !== ModelNamespace) {
    abort(
      Codes.UnsupportedNamespace,
      `Flow element '${localName}' is not in the BPMN model namespace`,
      xmlPath(element)
    )
  }

  const isActivity = localName === "task" || localName === "callActivity" || localName === "subProcess"
  const allowedAttributes = localName === "startEvent"
    ? new Set([...commonNodeAttributes, "parallelMultiple", "isInterrupting"])
    : localName === "endEvent"
    ? commonNodeAttributes
    : localName === "exclusiveGateway"
    ? new Set([...commonNodeAttributes, "gatewayDirection", "default"])
    : localName === "parallelGateway"
    ? new Set([...commonNodeAttributes, "gatewayDirection"])
    : isActivity
    ? new Set([
      ...activityAttributes,
      ...(localName === "callActivity" ? ["calledElement"] : []),
      ...(localName === "subProcess" ? ["triggeredByEvent"] : [])
    ])
    : new Set<string>()

  if (allowedAttributes.size === 0) {
    abort(
      Codes.UnsupportedElement,
      `BPMN flow element '${localName}' is not represented by this profile`,
      xmlPath(element)
    )
  }

  const attributes = readAttributes(element, allowedAttributes)
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    true,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    localName
  )!
  const name = nodeName(attributes, element)
  const children = parseNodeChildren(
    element,
    context,
    state,
    localName === "subProcess"
  )
  const base = {
    id,
    processId,
    parentScopeId: scopeId,
    ...(name === undefined ? undefined : { name }),
    incomingSequenceFlowIds: [...children.incoming],
    outgoingSequenceFlowIds: [...children.outgoing],
    extensionElements: [...EmptyExtensions]
  }
  let node: BpmnModel.FlowNode
  let defaultRef: string | undefined

  switch (localName) {
    case "task": {
      defaultRef = unqualifiedAttribute(attributes, "default")
      const compensation = unqualifiedAttribute(attributes, "isForCompensation")
      const startQuantity = unqualifiedAttribute(attributes, "startQuantity")
      const completionQuantity = unqualifiedAttribute(attributes, "completionQuantity")
      node = {
        _tag: "Task",
        ...base,
        taskKind: "generic",
        ...(defaultRef === undefined ? undefined : { defaultFlowId: defaultRef }),
        ...(compensation === undefined
          ? undefined
          : {
            isForCompensation: readBoolean(
              compensation,
              state.report,
              xmlPath(element, ["attributes", "isForCompensation"]),
              "task isForCompensation"
            )
          }),
        ...(startQuantity === undefined
          ? undefined
          : {
            startQuantity: readPositiveOne(
              startQuantity,
              state.report,
              xmlPath(element, ["attributes", "startQuantity"]),
              "task startQuantity"
            )
          }),
        ...(completionQuantity === undefined
          ? undefined
          : {
            completionQuantity: readPositiveOne(
              completionQuantity,
              state.report,
              xmlPath(element, ["attributes", "completionQuantity"]),
              "task completionQuantity"
            )
          })
      }
      if (node.isForCompensation === true) {
        abort(
          Codes.UnsupportedModel,
          "Compensation activities are outside this XML profile",
          xmlPath(element, ["attributes", "isForCompensation"])
        )
      }
      break
    }
    case "callActivity": {
      defaultRef = unqualifiedAttribute(attributes, "default")
      const calledElement = unqualifiedAttribute(attributes, "calledElement")
      const compensation = unqualifiedAttribute(attributes, "isForCompensation")
      const startQuantity = unqualifiedAttribute(attributes, "startQuantity")
      const completionQuantity = unqualifiedAttribute(attributes, "completionQuantity")
      node = {
        _tag: "CallActivity",
        ...base,
        ...(defaultRef === undefined ? undefined : { defaultFlowId: defaultRef }),
        ...(calledElement === undefined
          ? undefined
          : {
            calledElement: readQName(
              calledElement,
              context,
              state.report,
              xmlPath(element, ["attributes", "calledElement"]),
              "callActivity calledElement"
            )
          }),
        ...(compensation === undefined
          ? undefined
          : {
            isForCompensation: readBoolean(
              compensation,
              state.report,
              xmlPath(element, ["attributes", "isForCompensation"]),
              "callActivity isForCompensation"
            )
          }),
        ...(startQuantity === undefined
          ? undefined
          : {
            startQuantity: readPositiveOne(
              startQuantity,
              state.report,
              xmlPath(element, ["attributes", "startQuantity"]),
              "callActivity startQuantity"
            )
          }),
        ...(completionQuantity === undefined
          ? undefined
          : {
            completionQuantity: readPositiveOne(
              completionQuantity,
              state.report,
              xmlPath(element, ["attributes", "completionQuantity"]),
              "callActivity completionQuantity"
            )
          })
      }
      if (node.isForCompensation === true) {
        abort(
          Codes.UnsupportedModel,
          "Compensation call activities are outside this XML profile",
          xmlPath(element, ["attributes", "isForCompensation"])
        )
      }
      break
    }
    case "subProcess": {
      defaultRef = unqualifiedAttribute(attributes, "default")
      const triggered = unqualifiedAttribute(attributes, "triggeredByEvent")
      if (
        triggered !== undefined &&
        readBoolean(
          triggered,
          state.report,
          xmlPath(element, ["attributes", "triggeredByEvent"]),
          "subProcess triggeredByEvent"
        )
      ) {
        abort(
          Codes.UnsupportedModel,
          "Event subprocesses are outside this XML profile",
          xmlPath(element, ["attributes", "triggeredByEvent"])
        )
      }
      if (triggered !== undefined) {
        notice(
          state.report.normalizations,
          "ExplicitSubProcessDefault",
          "Explicit triggeredByEvent='false' is represented by the ordinary SubProcess tag",
          xmlPath(element, ["attributes", "triggeredByEvent"])
        )
      }
      const compensation = unqualifiedAttribute(attributes, "isForCompensation")
      const startQuantity = unqualifiedAttribute(attributes, "startQuantity")
      const completionQuantity = unqualifiedAttribute(attributes, "completionQuantity")
      node = {
        _tag: "SubProcess",
        ...base,
        ...(defaultRef === undefined ? undefined : { defaultFlowId: defaultRef }),
        ...(compensation === undefined
          ? undefined
          : {
            isForCompensation: readBoolean(
              compensation,
              state.report,
              xmlPath(element, ["attributes", "isForCompensation"]),
              "subProcess isForCompensation"
            )
          }),
        ...(startQuantity === undefined
          ? undefined
          : {
            startQuantity: readPositiveOne(
              startQuantity,
              state.report,
              xmlPath(element, ["attributes", "startQuantity"]),
              "subProcess startQuantity"
            )
          }),
        ...(completionQuantity === undefined
          ? undefined
          : {
            completionQuantity: readPositiveOne(
              completionQuantity,
              state.report,
              xmlPath(element, ["attributes", "completionQuantity"]),
              "subProcess completionQuantity"
            )
          })
      }
      if (node.isForCompensation === true) {
        abort(
          Codes.UnsupportedModel,
          "Compensation subprocesses are outside this XML profile",
          xmlPath(element, ["attributes", "isForCompensation"])
        )
      }
      break
    }
    case "startEvent": {
      const parallelMultiple = unqualifiedAttribute(attributes, "parallelMultiple")
      const isInterrupting = unqualifiedAttribute(attributes, "isInterrupting")
      if (
        parallelMultiple !== undefined &&
        readBoolean(
          parallelMultiple,
          state.report,
          xmlPath(element, ["attributes", "parallelMultiple"]),
          "startEvent parallelMultiple"
        )
      ) {
        abort(
          Codes.UnsupportedModel,
          "Only none start events are supported; parallelMultiple must be false",
          xmlPath(element, ["attributes", "parallelMultiple"])
        )
      }
      if (
        isInterrupting !== undefined &&
        !readBoolean(
          isInterrupting,
          state.report,
          xmlPath(element, ["attributes", "isInterrupting"]),
          "startEvent isInterrupting"
        )
      ) {
        abort(
          Codes.UnsupportedModel,
          "Only interrupting none start events are supported",
          xmlPath(element, ["attributes", "isInterrupting"])
        )
      }
      node = {
        _tag: "StartEvent",
        ...base,
        eventDefinitions: [],
        eventDefinitionRefs: [],
        ...(parallelMultiple === undefined ? undefined : { parallelMultiple: false }),
        ...(isInterrupting === undefined ? undefined : { isInterrupting: true })
      }
      break
    }
    case "endEvent":
      node = {
        _tag: "EndEvent",
        ...base,
        eventDefinitions: [],
        eventDefinitionRefs: []
      }
      break
    case "exclusiveGateway":
    case "parallelGateway": {
      const directionLexical = unqualifiedAttribute(attributes, "gatewayDirection")
      const directions = {
        Unspecified: "unspecified",
        Converging: "converging",
        Diverging: "diverging",
        Mixed: "mixed"
      } as const
      let gatewayDirection: BpmnModel.Gateway["gatewayDirection"] = "unspecified"
      if (directionLexical === undefined) {
        notice(
          state.report.defaultsApplied,
          "GatewayDirectionDefault",
          "Absent gatewayDirection defaults to Unspecified",
          xmlPath(element, ["attributes", "gatewayDirection"])
        )
      } else {
        if (!(directionLexical in directions)) {
          abort(
            Codes.InvalidLexicalValue,
            `Unsupported BPMN gatewayDirection '${directionLexical}'`,
            xmlPath(element, ["attributes", "gatewayDirection"])
          )
        }
        gatewayDirection = directions[directionLexical as keyof typeof directions]
      }
      defaultRef = unqualifiedAttribute(attributes, "default")
      node = {
        _tag: "Gateway",
        ...base,
        gatewayKind: localName === "exclusiveGateway" ? "exclusive" : "parallel",
        gatewayDirection,
        ...(defaultRef === undefined ? undefined : { defaultFlowId: defaultRef })
      }
      break
    }
    default:
      return
  }

  state.nodes.push(node)
  state.parsedNodes.push({
    node,
    suppliedRefs: children.supplied,
    incoming: children.incoming,
    outgoing: children.outgoing,
    defaultRef,
    path: xmlPath(element)
  })

  if (localName === "subProcess") {
    parseScope(children.contained, context, processId, id, state)
  } else if (children.contained.length > 0) {
    abort(
      Codes.InvalidStructure,
      `${localName} cannot contain flow elements`,
      xmlPath(children.contained[0]!)
    )
  }
}

const parseSequenceFlow = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  processId: string,
  scopeId: string,
  state: ParserState
): void => {
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(
    element,
    new Set(["id", "name", "sourceRef", "targetRef", "isImmediate"])
  )
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    true,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "sequenceFlow"
  )!
  const sourceId = readId(
    unqualifiedAttribute(attributes, "sourceRef"),
    true,
    state.report,
    xmlPath(element, ["attributes", "sourceRef"]),
    "sequenceFlow sourceRef"
  )!
  const targetId = readId(
    unqualifiedAttribute(attributes, "targetRef"),
    true,
    state.report,
    xmlPath(element, ["attributes", "targetRef"]),
    "sequenceFlow targetRef"
  )!
  const name = unqualifiedAttribute(attributes, "name")
  if (name !== undefined && name.length === 0) {
    abort(
      Codes.UnsupportedModel,
      "Empty sequenceFlow names cannot be represented by the semantic IR",
      xmlPath(element, ["attributes", "name"])
    )
  }
  const children = structuralChildren(element)
  if (children.length > 1) {
    abort(
      Codes.InvalidStructure,
      "sequenceFlow permits at most one conditionExpression",
      xmlPath(element, ["children"])
    )
  }
  let condition: BpmnModel.Expression | undefined
  if (children.length === 1) {
    const child = children[0]!
    condition = expression(child, namespaceContext(context, child), state)
  }
  const isImmediateLexical = unqualifiedAttribute(attributes, "isImmediate")
  state.flows.push({
    id,
    processId,
    parentScopeId: scopeId,
    sourceId,
    targetId,
    kind: condition === undefined ? "normal" : "conditional",
    ...(name === undefined ? undefined : { name }),
    ...(isImmediateLexical === undefined
      ? undefined
      : {
        isImmediate: readBoolean(
          isImmediateLexical,
          state.report,
          xmlPath(element, ["attributes", "isImmediate"]),
          "sequenceFlow isImmediate"
        )
      }),
    ...(condition === undefined ? undefined : { condition }),
    extensionElements: [...EmptyExtensions]
  })
}

function parseScope(
  elements: ReadonlyArray<BpmnXmlAst.XmlElement>,
  context: NamespaceContext,
  processId: string,
  scopeId: string,
  state: ParserState
): void {
  for (const element of elements) {
    if (isElementNamed(element, ModelNamespace, "sequenceFlow")) {
      parseSequenceFlow(element, context, processId, scopeId, state)
      continue
    }
    parseNode(element, context, processId, scopeId, state)
  }
}

const parseProcess = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  state: ParserState
): void => {
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(
    element,
    new Set(["id", "name", "processType", "isClosed", "isExecutable"])
  )
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    true,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "process"
  )!
  const name = unqualifiedAttribute(attributes, "name")
  if (name !== undefined && name.length === 0) {
    abort(
      Codes.UnsupportedModel,
      "Empty process names cannot be represented by the semantic IR",
      xmlPath(element, ["attributes", "name"])
    )
  }
  const processTypes = {
    None: "none",
    Public: "public",
    Private: "private"
  } as const
  const processTypeLexical = unqualifiedAttribute(attributes, "processType")
  let processType: BpmnModel.Process["processType"] = "none"
  if (processTypeLexical === undefined) {
    notice(
      state.report.defaultsApplied,
      "ProcessTypeDefault",
      "Absent processType defaults to None",
      xmlPath(element, ["attributes", "processType"])
    )
  } else {
    if (!(processTypeLexical in processTypes)) {
      abort(
        Codes.InvalidLexicalValue,
        `Unsupported BPMN processType '${processTypeLexical}'`,
        xmlPath(element, ["attributes", "processType"])
      )
    }
    processType = processTypes[processTypeLexical as keyof typeof processTypes]
  }
  const closedLexical = unqualifiedAttribute(attributes, "isClosed")
  const isClosed = closedLexical === undefined
    ? false
    : readBoolean(
      closedLexical,
      state.report,
      xmlPath(element, ["attributes", "isClosed"]),
      "process isClosed"
    )
  if (closedLexical === undefined) {
    notice(
      state.report.defaultsApplied,
      "ProcessClosedDefault",
      "Absent isClosed defaults to false",
      xmlPath(element, ["attributes", "isClosed"])
    )
  }
  const executableLexical = unqualifiedAttribute(attributes, "isExecutable")
  const process: BpmnModel.Process = {
    id,
    ...(name === undefined ? undefined : { name }),
    processType,
    isClosed,
    ...(executableLexical === undefined
      ? undefined
      : {
        isExecutable: readBoolean(
          executableLexical,
          state.report,
          xmlPath(element, ["attributes", "isExecutable"]),
          "process isExecutable"
        )
      }),
    extensionElements: [...EmptyExtensions]
  }
  state.processes.push(process)
  parseScope(structuralChildren(element), context, id, id, state)
}

const equalStrings = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean => left.length === right.length && left.every((value, index) => value === right[index])

interface FlowReferenceIndex {
  readonly incoming: ReadonlyMap<string, ReadonlyArray<string>>
  readonly outgoing: ReadonlyMap<string, ReadonlyArray<string>>
}

const flowReferenceKey = (
  processId: string,
  scopeId: string,
  nodeId: string
): string => `${processId}\u0000${scopeId}\u0000${nodeId}`

const indexFlowReferences = (
  flows: ReadonlyArray<BpmnModel.SequenceFlow>
): FlowReferenceIndex => {
  const incoming = new Map<string, Array<string>>()
  const outgoing = new Map<string, Array<string>>()
  const append = (
    target: Map<string, Array<string>>,
    key: string,
    id: string
  ): void => {
    const values = target.get(key)
    if (values === undefined) {
      target.set(key, [id])
    } else {
      values.push(id)
    }
  }
  for (const flow of flows) {
    append(
      incoming,
      flowReferenceKey(flow.processId, flow.parentScopeId, flow.targetId),
      flow.id
    )
    append(
      outgoing,
      flowReferenceKey(flow.processId, flow.parentScopeId, flow.sourceId),
      flow.id
    )
  }
  return { incoming, outgoing }
}

const resolveFlowReferences = (state: ParserState): void => {
  const flowById = new Map(state.flows.map((flow) => [flow.id, flow]))
  const references = indexFlowReferences(state.flows)
  for (const parsed of state.parsedNodes) {
    const key = flowReferenceKey(
      parsed.node.processId,
      parsed.node.parentScopeId,
      parsed.node.id
    )
    const incoming = references.incoming.get(key) ?? []
    const outgoing = references.outgoing.get(key) ?? []
    if (
      parsed.suppliedRefs &&
      (!equalStrings(parsed.incoming, incoming) || !equalStrings(parsed.outgoing, outgoing))
    ) {
      abort(
        Codes.InvalidReference,
        `Explicit incoming/outgoing references for '${parsed.node.id}' are not complete and exact`,
        parsed.path,
        {
          expectedIncoming: incoming,
          expectedOutgoing: outgoing,
          actualIncoming: parsed.incoming,
          actualOutgoing: parsed.outgoing
        }
      )
    }
    ;(parsed.node.incomingSequenceFlowIds as Array<string>).splice(
      0,
      parsed.node.incomingSequenceFlowIds.length,
      ...incoming
    )
    ;(parsed.node.outgoingSequenceFlowIds as Array<string>).splice(
      0,
      parsed.node.outgoingSequenceFlowIds.length,
      ...outgoing
    )

    if (parsed.defaultRef !== undefined) {
      const defaultId = readId(
        parsed.defaultRef,
        true,
        state.report,
        [...parsed.path, "attributes", "default"],
        `${parsed.node.id} default`
      )!
      const flow = flowById.get(defaultId)
      if (
        flow === undefined ||
        flow.processId !== parsed.node.processId ||
        flow.parentScopeId !== parsed.node.parentScopeId ||
        flow.sourceId !== parsed.node.id
      ) {
        abort(
          Codes.InvalidReference,
          `Default flow '${defaultId}' is not an outgoing flow of '${parsed.node.id}'`,
          [...parsed.path, "attributes", "default"]
        )
      }
      const resolvedFlow = flow!
      if (resolvedFlow.condition !== undefined) {
        abort(
          Codes.InvalidStructure,
          `Default flow '${defaultId}' cannot also declare a conditionExpression`,
          [...parsed.path, "attributes", "default"]
        )
      }
      ;(resolvedFlow as { kind: BpmnModel.SequenceFlow["kind"] }).kind = "default"
      if (
        parsed.node._tag === "Task" ||
        parsed.node._tag === "CallActivity" ||
        parsed.node._tag === "SubProcess" ||
        parsed.node._tag === "Gateway"
      ) {
        ;(parsed.node as { defaultFlowId?: string }).defaultFlowId = defaultId
      }
    }
  }
}

const parseBounds = (
  element: BpmnXmlAst.XmlElement,
  state: ParserState
): BpmnDi.Bounds => {
  if (!isElementNamed(element, DcNamespace, "Bounds")) {
    abort(
      element.name.namespaceUri === DcNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `Expected dc:Bounds, received '${element.name.localName}'`,
      xmlPath(element)
    )
  }
  if (structuralChildren(element).length > 0) {
    abort(Codes.InvalidStructure, "dc:Bounds must be empty", xmlPath(element))
  }
  const attributes = readAttributes(element, new Set(["x", "y", "width", "height"]))
  const required = (name: string): string =>
    readRequiredText(
      unqualifiedAttribute(attributes, name),
      xmlPath(element, ["attributes", name]),
      `dc:Bounds ${name}`
    )
  return {
    x: readDouble(
      required("x"),
      state.report,
      xmlPath(element, ["attributes", "x"]),
      "dc:Bounds x"
    ),
    y: readDouble(
      required("y"),
      state.report,
      xmlPath(element, ["attributes", "y"]),
      "dc:Bounds y"
    ),
    width: readDouble(
      required("width"),
      state.report,
      xmlPath(element, ["attributes", "width"]),
      "dc:Bounds width"
    ),
    height: readDouble(
      required("height"),
      state.report,
      xmlPath(element, ["attributes", "height"]),
      "dc:Bounds height"
    )
  }
}

const parseWaypoint = (
  element: BpmnXmlAst.XmlElement,
  state: ParserState
): BpmnDi.Point => {
  if (!isElementNamed(element, DiNamespace, "waypoint")) {
    abort(
      element.name.namespaceUri === DiNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `Expected di:waypoint, received '${element.name.localName}'`,
      xmlPath(element)
    )
  }
  if (structuralChildren(element).length > 0) {
    abort(Codes.InvalidStructure, "di:waypoint must be empty", xmlPath(element))
  }
  const attributes = readAttributes(element, new Set(["x", "y"]))
  const x = readRequiredText(
    unqualifiedAttribute(attributes, "x"),
    xmlPath(element, ["attributes", "x"]),
    "di:waypoint x"
  )
  const y = readRequiredText(
    unqualifiedAttribute(attributes, "y"),
    xmlPath(element, ["attributes", "y"]),
    "di:waypoint y"
  )
  return {
    x: readDouble(
      x,
      state.report,
      xmlPath(element, ["attributes", "x"]),
      "di:waypoint x"
    ),
    y: readDouble(
      y,
      state.report,
      xmlPath(element, ["attributes", "y"]),
      "di:waypoint y"
    )
  }
}

const parseLabel = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  state: ParserState
): BpmnDi.Label => {
  if (!isElementNamed(element, BpmnDiNamespace, "BPMNLabel")) {
    abort(
      element.name.namespaceUri === BpmnDiNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `Expected bpmndi:BPMNLabel, received '${element.name.localName}'`,
      xmlPath(element)
    )
  }
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(element, new Set(["id", "labelStyle"]))
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "BPMNLabel"
  )
  const styleLexical = unqualifiedAttribute(attributes, "labelStyle")
  const styleRef = styleLexical === undefined
    ? undefined
    : readDiQNameRef(
      styleLexical,
      context,
      state.metadata.targetNamespace,
      state.report,
      xmlPath(element, ["attributes", "labelStyle"]),
      "BPMNLabel labelStyle"
    )
  const children = structuralChildren(element)
  if (children.length > 1 || children.length === 1 && !isElementNamed(children[0]!, DcNamespace, "Bounds")) {
    abort(
      Codes.InvalidStructure,
      "BPMNLabel permits only one optional dc:Bounds child",
      xmlPath(element, ["children"])
    )
  }
  return {
    ...(id === undefined ? undefined : { id }),
    ...(children.length === 0 ? undefined : { bounds: parseBounds(children[0]!, state) }),
    ...(styleRef === undefined ? undefined : { styleRef }),
    extensions: [...EmptyExtensions]
  }
}

const parseShape = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  state: ParserState
): BpmnDi.Shape => {
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(
    element,
    new Set([
      "id",
      "bpmnElement",
      "isHorizontal",
      "isExpanded",
      "isMarkerVisible",
      "isMessageVisible",
      "participantBandKind",
      "choreographyActivityShape"
    ])
  )
  for (const name of ["participantBandKind", "choreographyActivityShape"] as const) {
    if (unqualifiedAttribute(attributes, name) !== undefined) {
      abort(
        Codes.UnsupportedDi,
        `BPMNShape ${name} is outside the core-process DI profile`,
        xmlPath(element, ["attributes", name])
      )
    }
  }
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "BPMNShape"
  )
  const bpmnElementLexical = unqualifiedAttribute(attributes, "bpmnElement")
  if (bpmnElementLexical === undefined) {
    abort(
      Codes.InvalidStructure,
      "BPMNShape requires bpmnElement in this profile",
      xmlPath(element, ["attributes", "bpmnElement"])
    )
  }
  const bpmnElementId = readDiQNameRef(
    bpmnElementLexical!,
    context,
    state.metadata.targetNamespace,
    state.report,
    xmlPath(element, ["attributes", "bpmnElement"]),
    "BPMNShape bpmnElement"
  )
  const children = structuralChildren(element)
  if (
    children.length < 1 ||
    children.length > 2 ||
    !isElementNamed(children[0]!, DcNamespace, "Bounds") ||
    children.length === 2 && !isElementNamed(children[1]!, BpmnDiNamespace, "BPMNLabel")
  ) {
    abort(
      Codes.InvalidStructure,
      "BPMNShape requires dc:Bounds followed by at most one BPMNLabel",
      xmlPath(element, ["children"])
    )
  }
  const optionalBoolean = (name: string): boolean | undefined => {
    const lexical = unqualifiedAttribute(attributes, name)
    return lexical === undefined
      ? undefined
      : readBoolean(
        lexical,
        state.report,
        xmlPath(element, ["attributes", name]),
        `BPMNShape ${name}`
      )
  }
  const label = children.length === 2
    ? parseLabel(children[1]!, context, state)
    : undefined
  const isHorizontal = optionalBoolean("isHorizontal")
  const isExpanded = optionalBoolean("isExpanded")
  const isMarkerVisible = optionalBoolean("isMarkerVisible")
  const isMessageVisible = optionalBoolean("isMessageVisible")
  return {
    _tag: "Shape",
    ...(id === undefined ? undefined : { id }),
    bpmnElementId,
    bounds: parseBounds(children[0]!, state),
    ...(label === undefined ? undefined : { label }),
    ...(isHorizontal === undefined ? undefined : { isHorizontal }),
    ...(isExpanded === undefined ? undefined : { isExpanded }),
    ...(isMarkerVisible === undefined ? undefined : { isMarkerVisible }),
    ...(isMessageVisible === undefined ? undefined : { isMessageVisible }),
    extensions: [...EmptyExtensions]
  }
}

const parseEdge = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  state: ParserState
): BpmnDi.Edge => {
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(
    element,
    new Set([
      "id",
      "bpmnElement",
      "sourceElement",
      "targetElement",
      "messageVisibleKind"
    ])
  )
  if (unqualifiedAttribute(attributes, "messageVisibleKind") !== undefined) {
    abort(
      Codes.UnsupportedDi,
      "BPMNEdge messageVisibleKind is outside the core-process DI profile",
      xmlPath(element, ["attributes", "messageVisibleKind"])
    )
  }
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "BPMNEdge"
  )
  const bpmnElementLexical = unqualifiedAttribute(attributes, "bpmnElement")
  if (bpmnElementLexical === undefined) {
    abort(
      Codes.InvalidStructure,
      "BPMNEdge requires bpmnElement in this profile",
      xmlPath(element, ["attributes", "bpmnElement"])
    )
  }
  const ref = (name: string, required: boolean): string | undefined => {
    const lexical = unqualifiedAttribute(attributes, name)
    if (lexical === undefined) {
      if (required) {
        abort(
          Codes.InvalidStructure,
          `BPMNEdge requires ${name}`,
          xmlPath(element, ["attributes", name])
        )
      }
      return undefined
    }
    return readDiQNameRef(
      lexical,
      context,
      state.metadata.targetNamespace,
      state.report,
      xmlPath(element, ["attributes", name]),
      `BPMNEdge ${name}`
    )
  }
  const bpmnElementId = ref("bpmnElement", true)!
  const sourceElementId = ref("sourceElement", false)
  const targetElementId = ref("targetElement", false)
  const children = structuralChildren(element)
  const waypoints: Array<BpmnDi.Point> = []
  let label: BpmnDi.Label | undefined
  let seenLabel = false
  for (const child of children) {
    if (isElementNamed(child, DiNamespace, "waypoint") && !seenLabel) {
      waypoints.push(parseWaypoint(child, state))
      continue
    }
    if (isElementNamed(child, BpmnDiNamespace, "BPMNLabel") && !seenLabel) {
      seenLabel = true
      label = parseLabel(child, context, state)
      continue
    }
    abort(
      Codes.InvalidStructure,
      "BPMNEdge requires two or more di:waypoint children followed by at most one BPMNLabel",
      xmlPath(child)
    )
  }
  if (waypoints.length < 2) {
    abort(
      Codes.InvalidStructure,
      "BPMNEdge requires at least two di:waypoint children",
      xmlPath(element, ["children"])
    )
  }
  return {
    _tag: "Edge",
    ...(id === undefined ? undefined : { id }),
    bpmnElementId,
    ...(sourceElementId === undefined ? undefined : { sourceElementId }),
    ...(targetElementId === undefined ? undefined : { targetElementId }),
    waypoints,
    ...(label === undefined ? undefined : { label }),
    extensions: [...EmptyExtensions]
  }
}

const parsePlane = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  state: ParserState
): BpmnDi.Plane => {
  if (!isElementNamed(element, BpmnDiNamespace, "BPMNPlane")) {
    abort(
      element.name.namespaceUri === BpmnDiNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `Expected bpmndi:BPMNPlane, received '${element.name.localName}'`,
      xmlPath(element)
    )
  }
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(element, new Set(["id", "bpmnElement"]))
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "BPMNPlane"
  )
  const bpmnElementLexical = unqualifiedAttribute(attributes, "bpmnElement")
  if (bpmnElementLexical === undefined) {
    abort(
      Codes.InvalidStructure,
      "BPMNPlane requires bpmnElement in this profile",
      xmlPath(element, ["attributes", "bpmnElement"])
    )
  }
  const bpmnElementId = readDiQNameRef(
    bpmnElementLexical!,
    context,
    state.metadata.targetNamespace,
    state.report,
    xmlPath(element, ["attributes", "bpmnElement"]),
    "BPMNPlane bpmnElement"
  )
  const diagramElements: Array<BpmnDi.DiagramElement> = []
  for (const child of structuralChildren(element)) {
    if (isElementNamed(child, BpmnDiNamespace, "BPMNShape")) {
      diagramElements.push(parseShape(child, context, state))
      continue
    }
    if (isElementNamed(child, BpmnDiNamespace, "BPMNEdge")) {
      diagramElements.push(parseEdge(child, context, state))
      continue
    }
    abort(
      child.name.namespaceUri === BpmnDiNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `BPMNPlane child '${child.name.localName}' is not represented by this profile`,
      xmlPath(child)
    )
  }
  return {
    ...(id === undefined ? undefined : { id }),
    bpmnElementId,
    diagramElements,
    extensions: [...EmptyExtensions]
  }
}

const parseFont = (
  element: BpmnXmlAst.XmlElement,
  state: ParserState
): BpmnDi.Font => {
  if (!isElementNamed(element, DcNamespace, "Font")) {
    abort(
      element.name.namespaceUri === DcNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `Expected dc:Font, received '${element.name.localName}'`,
      xmlPath(element)
    )
  }
  if (structuralChildren(element).length > 0) {
    abort(Codes.InvalidStructure, "dc:Font must be empty", xmlPath(element))
  }
  const attributes = readAttributes(
    element,
    new Set(["name", "size", "isBold", "isItalic", "isUnderline", "isStrikeThrough"])
  )
  const size = unqualifiedAttribute(attributes, "size")
  const bool = (name: string): boolean | undefined => {
    const lexical = unqualifiedAttribute(attributes, name)
    return lexical === undefined
      ? undefined
      : readBoolean(
        lexical,
        state.report,
        xmlPath(element, ["attributes", name]),
        `dc:Font ${name}`
      )
  }
  const isBold = bool("isBold")
  const isItalic = bool("isItalic")
  const isUnderline = bool("isUnderline")
  const isStrikeThrough = bool("isStrikeThrough")
  return {
    ...(unqualifiedAttribute(attributes, "name") === undefined
      ? undefined
      : { name: unqualifiedAttribute(attributes, "name")! }),
    ...(size === undefined
      ? undefined
      : {
        size: readDouble(
          size,
          state.report,
          xmlPath(element, ["attributes", "size"]),
          "dc:Font size"
        )
      }),
    ...(isBold === undefined ? undefined : { isBold }),
    ...(isItalic === undefined ? undefined : { isItalic }),
    ...(isUnderline === undefined ? undefined : { isUnderline }),
    ...(isStrikeThrough === undefined ? undefined : { isStrikeThrough })
  }
}

const parseLabelStyle = (
  element: BpmnXmlAst.XmlElement,
  state: ParserState
): BpmnDi.LabelStyle => {
  const attributes = readAttributes(element, new Set(["id"]))
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "BPMNLabelStyle"
  )
  const children = structuralChildren(element)
  if (children.length !== 1 || !isElementNamed(children[0]!, DcNamespace, "Font")) {
    abort(
      Codes.InvalidStructure,
      "BPMNLabelStyle requires exactly one dc:Font child",
      xmlPath(element, ["children"])
    )
  }
  return {
    ...(id === undefined ? undefined : { id }),
    font: parseFont(children[0]!, state)
  }
}

const parseDiagram = (
  element: BpmnXmlAst.XmlElement,
  parentContext: NamespaceContext,
  state: ParserState
): BpmnDi.Diagram => {
  const context = namespaceContext(parentContext, element)
  const attributes = readAttributes(
    element,
    new Set(["id", "name", "documentation", "resolution"])
  )
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    state.report,
    xmlPath(element, ["attributes", "id"]),
    "BPMNDiagram"
  )
  const children = structuralChildren(element)
  if (
    children.length === 0 ||
    !isElementNamed(children[0]!, BpmnDiNamespace, "BPMNPlane")
  ) {
    abort(
      Codes.InvalidStructure,
      "BPMNDiagram requires BPMNPlane as its first child",
      xmlPath(element, ["children"])
    )
  }
  const labelStyles: Array<BpmnDi.LabelStyle> = []
  for (let index = 1; index < children.length; index++) {
    const child = children[index]!
    if (!isElementNamed(child, BpmnDiNamespace, "BPMNLabelStyle")) {
      abort(
        child.name.namespaceUri === BpmnDiNamespace
          ? Codes.UnsupportedElement
          : Codes.UnsupportedNamespace,
        "Only BPMNLabelStyle elements may follow BPMNPlane",
        xmlPath(child)
      )
    }
    labelStyles.push(parseLabelStyle(child, state))
  }
  const resolution = unqualifiedAttribute(attributes, "resolution")
  return {
    ...(id === undefined ? undefined : { id }),
    ...(unqualifiedAttribute(attributes, "name") === undefined
      ? undefined
      : { name: unqualifiedAttribute(attributes, "name")! }),
    ...(unqualifiedAttribute(attributes, "documentation") === undefined
      ? undefined
      : { documentation: unqualifiedAttribute(attributes, "documentation")! }),
    ...(resolution === undefined
      ? undefined
      : {
        resolution: readDouble(
          resolution,
          state.report,
          xmlPath(element, ["attributes", "resolution"]),
          "BPMNDiagram resolution"
        )
      }),
    plane: parsePlane(children[0]!, context, state),
    labelStyles
  }
}

const modelIds = (model: BpmnModel.BpmnModel): ReadonlySet<string> =>
  new Set([
    ...model.processes.map((value) => value.id),
    ...model.flowNodes.map((value) => value.id),
    ...model.sequenceFlows.map((value) => value.id)
  ])

const allDiIds = (document: BpmnDi.BpmnDiDocument): ReadonlyArray<
  readonly [
    id: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ]
> => {
  const ids: Array<readonly [string, ReadonlyArray<Diagnostic.PathSegment>]> = []
  for (let diagramIndex = 0; diagramIndex < document.diagrams.length; diagramIndex++) {
    const diagram = document.diagrams[diagramIndex]!
    const diagramPath = ["di", "diagrams", diagramIndex] as const
    if (diagram.id !== undefined) ids.push([diagram.id, [...diagramPath, "id"]])
    if (diagram.plane.id !== undefined) ids.push([diagram.plane.id, [...diagramPath, "plane", "id"]])
    for (let styleIndex = 0; styleIndex < diagram.labelStyles.length; styleIndex++) {
      const style = diagram.labelStyles[styleIndex]!
      if (style.id !== undefined) {
        ids.push([style.id, [...diagramPath, "labelStyles", styleIndex, "id"]])
      }
    }
    for (
      let elementIndex = 0;
      elementIndex < diagram.plane.diagramElements.length;
      elementIndex++
    ) {
      const element = diagram.plane.diagramElements[elementIndex]!
      const elementPath = [...diagramPath, "plane", "diagramElements", elementIndex] as const
      if (element.id !== undefined) ids.push([element.id, [...elementPath, "id"]])
      if (element.label?.id !== undefined) {
        ids.push([element.label.id, [...elementPath, "label", "id"]])
      }
    }
  }
  return ids
}

const assertNcName = (
  value: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): void => {
  if (!isNcName(value)) {
    abort(Codes.InvalidId, `${owner} '${value}' is not an XML Schema NCName`, path)
  }
}

const assertQNameLocalName = (
  value: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): void => {
  if (!isNcName(value)) {
    abort(Codes.InvalidQName, `${owner} '${value}' is not an XML Schema NCName`, path)
  }
}

const assertEmptyExtensions = (
  extensions: ReadonlyArray<BpmnModel.ExtensionElement>,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): void => {
  if (extensions.length !== 0) {
    abort(
      Codes.UnsupportedModel,
      `${owner} extension elements are outside this XML profile`,
      path
    )
  }
}

const assertExpression = (
  value: BpmnModel.Expression,
  bindings: BindingTable,
  path: ReadonlyArray<Diagnostic.PathSegment>
): void => {
  assertNormalizedAnyUri(
    value.language,
    [...path, "language"],
    "Expression language"
  )
  const version = bindings.byLanguage.get(value.language)
  if (version === undefined) {
    abort(
      Codes.MissingExpressionBinding,
      `No exact version binding exists for expression language '${value.language}'`,
      [...path, "language"]
    )
  }
  if (version !== value.version) {
    abort(
      Codes.ExpressionVersionMismatch,
      `Expression language '${value.language}' is bound to '${version}', not '${value.version}'`,
      [...path, "version"],
      { expected: version!, actual: value.version }
    )
  }
  if (value.source.length === 0) {
    abort(
      Codes.UnsupportedModel,
      "Expression source must be non-empty",
      [...path, "source"]
    )
  }
  if (value.metadata !== undefined) {
    abort(
      Codes.UnsupportedModel,
      "Expression metadata is outside this XML profile",
      [...path, "metadata"]
    )
  }
}

const assertModelProfile = (
  document: InterchangeDocument,
  bindings: BindingTable
): void => {
  const model = document.model
  if (model.extensionElements.length !== 0) {
    abort(
      Codes.UnsupportedModel,
      "Definitions-level extension elements are outside this XML profile",
      ["model", "extensionElements"]
    )
  }
  if (
    model.messages !== undefined ||
    model.signals !== undefined ||
    model.errors !== undefined ||
    model.escalations !== undefined ||
    model.eventDefinitions !== undefined
  ) {
    abort(
      Codes.UnsupportedModel,
      "Reusable BPMN root elements are outside this XML profile",
      ["model"]
    )
  }
  if (model.collaborations.length !== 0) {
    abort(
      Codes.UnsupportedModel,
      "BPMN collaborations are outside this XML profile",
      ["model", "collaborations"]
    )
  }
  if (model.processes.length === 0) {
    abort(
      Codes.InvalidStructure,
      "The core-process profile requires at least one process",
      ["model", "processes"]
    )
  }

  for (let index = 0; index < model.processes.length; index++) {
    const process = model.processes[index]!
    const path = ["model", "processes", index] as const
    assertNcName(process.id, [...path, "id"], "Process id")
    assertEmptyExtensions(process.extensionElements, [...path, "extensionElements"], "Process")
    if (process.processType === undefined || process.isClosed === undefined) {
      abort(
        Codes.UnsupportedModel,
        "Normalized profile processes must materialize processType and isClosed",
        path
      )
    }
    if (process.definitionalCollaborationRef !== undefined) {
      abort(
        Codes.UnsupportedModel,
        "definitionalCollaborationRef is outside this XML profile",
        [...path, "definitionalCollaborationRef"]
      )
    }
  }

  for (let index = 0; index < model.flowNodes.length; index++) {
    const node = model.flowNodes[index]!
    const path = ["model", "flowNodes", index] as const
    assertNcName(node.id, [...path, "id"], "Flow-node id")
    assertNcName(node.processId, [...path, "processId"], "Flow-node processId")
    assertNcName(node.parentScopeId, [...path, "parentScopeId"], "Flow-node parentScopeId")
    assertEmptyExtensions(node.extensionElements, [...path, "extensionElements"], "Flow node")
    for (let refIndex = 0; refIndex < node.incomingSequenceFlowIds.length; refIndex++) {
      assertNcName(
        node.incomingSequenceFlowIds[refIndex]!,
        [...path, "incomingSequenceFlowIds", refIndex],
        "Incoming sequence-flow reference"
      )
    }
    for (let refIndex = 0; refIndex < node.outgoingSequenceFlowIds.length; refIndex++) {
      assertNcName(
        node.outgoingSequenceFlowIds[refIndex]!,
        [...path, "outgoingSequenceFlowIds", refIndex],
        "Outgoing sequence-flow reference"
      )
    }

    switch (node._tag) {
      case "Task":
        if (
          node.taskKind !== "generic" ||
          node.loopCharacteristics !== undefined ||
          node.isForCompensation === true ||
          node.startQuantity !== undefined && node.startQuantity !== 1 ||
          node.completionQuantity !== undefined && node.completionQuantity !== 1 ||
          node.implementation !== undefined ||
          node.operationRef !== undefined ||
          node.messageRef !== undefined ||
          node.instantiate !== undefined ||
          node.scriptFormat !== undefined ||
          node.script !== undefined
        ) {
          abort(
            Codes.UnsupportedModel,
            `Task '${node.id}' uses fields outside the generic-task profile`,
            path
          )
        }
        break
      case "CallActivity":
        if (
          node.loopCharacteristics !== undefined ||
          node.isForCompensation === true ||
          node.startQuantity !== undefined && node.startQuantity !== 1 ||
          node.completionQuantity !== undefined && node.completionQuantity !== 1
        ) {
          abort(
            Codes.UnsupportedModel,
            `CallActivity '${node.id}' uses fields outside the callable-element profile`,
            path
          )
        }
        if (node.calledElement !== undefined) {
          if (node.calledElement.namespaceUri.length > 0) {
            assertNormalizedAnyUri(
              node.calledElement.namespaceUri,
              [...path, "calledElement", "namespaceUri"],
              "CallActivity calledElement namespace"
            )
          }
          assertQNameLocalName(
            node.calledElement.localName,
            [...path, "calledElement", "localName"],
            "CallActivity calledElement local name"
          )
        }
        break
      case "SubProcess":
        if (
          node.loopCharacteristics !== undefined ||
          node.isForCompensation === true ||
          node.startQuantity !== undefined && node.startQuantity !== 1 ||
          node.completionQuantity !== undefined && node.completionQuantity !== 1
        ) {
          abort(
            Codes.UnsupportedModel,
            `SubProcess '${node.id}' uses fields outside the ordinary-subprocess profile`,
            path
          )
        }
        break
      case "Gateway":
        if (
          node.gatewayKind !== "exclusive" && node.gatewayKind !== "parallel" ||
          node.instantiate !== undefined ||
          node.eventGatewayType !== undefined ||
          node.activationCondition !== undefined
        ) {
          abort(
            Codes.UnsupportedModel,
            `Gateway '${node.id}' is outside the exclusive/parallel profile`,
            path
          )
        }
        if (node.gatewayKind === "parallel" && node.defaultFlowId !== undefined) {
          abort(
            Codes.UnsupportedModel,
            "Parallel gateways cannot declare a default flow",
            [...path, "defaultFlowId"]
          )
        }
        break
      case "StartEvent":
        if (
          node.eventDefinitions.length !== 0 ||
          node.eventDefinitionRefs.length !== 0 ||
          node.parallelMultiple === true ||
          node.isInterrupting === false
        ) {
          abort(
            Codes.UnsupportedModel,
            `StartEvent '${node.id}' is not a supported none start event`,
            path
          )
        }
        break
      case "EndEvent":
        if (node.eventDefinitions.length !== 0 || node.eventDefinitionRefs.length !== 0) {
          abort(
            Codes.UnsupportedModel,
            `EndEvent '${node.id}' is not a supported none end event`,
            path
          )
        }
        break
      default:
        abort(
          Codes.UnsupportedModel,
          `Flow-node tag '${node._tag}' is outside this XML profile`,
          path
        )
    }
  }

  for (let index = 0; index < model.sequenceFlows.length; index++) {
    const flow = model.sequenceFlows[index]!
    const path = ["model", "sequenceFlows", index] as const
    assertNcName(flow.id, [...path, "id"], "Sequence-flow id")
    assertNcName(flow.processId, [...path, "processId"], "Sequence-flow processId")
    assertNcName(flow.parentScopeId, [...path, "parentScopeId"], "Sequence-flow parentScopeId")
    assertNcName(flow.sourceId, [...path, "sourceId"], "Sequence-flow sourceId")
    assertNcName(flow.targetId, [...path, "targetId"], "Sequence-flow targetId")
    assertEmptyExtensions(flow.extensionElements, [...path, "extensionElements"], "Sequence flow")
    if (flow.order !== undefined) {
      abort(
        Codes.UnsupportedModel,
        "Execution-only sequence-flow order is not a BPMN XML field in this profile",
        [...path, "order"]
      )
    }
    if (flow.kind === "conditional") {
      if (flow.condition === undefined) {
        abort(
          Codes.UnsupportedModel,
          "Conditional sequence flows require an expression",
          [...path, "condition"]
        )
      }
      assertExpression(flow.condition!, bindings, [...path, "condition"])
    } else if (flow.condition !== undefined) {
      abort(
        Codes.UnsupportedModel,
        `${flow.kind} sequence flows cannot carry conditionExpression`,
        [...path, "condition"]
      )
    }
  }

  const references = indexFlowReferences(model.sequenceFlows)
  for (let index = 0; index < model.flowNodes.length; index++) {
    const node = model.flowNodes[index]!
    const key = flowReferenceKey(node.processId, node.parentScopeId, node.id)
    const incoming = references.incoming.get(key) ?? []
    const outgoing = references.outgoing.get(key) ?? []
    if (
      !equalStrings(node.incomingSequenceFlowIds, incoming) ||
      !equalStrings(node.outgoingSequenceFlowIds, outgoing)
    ) {
      abort(
        Codes.InvalidReference,
        `Flow-node '${node.id}' incoming/outgoing references are not complete and canonical`,
        ["model", "flowNodes", index]
      )
    }
  }
}

const assertDiProfile = (
  document: InterchangeDocument
): void => {
  if (document.di === undefined) {
    return
  }
  const processById = new Map(document.model.processes.map((value) => [value.id, value]))
  const nodeById = new Map(document.model.flowNodes.map((value) => [value.id, value]))
  const flowById = new Map(document.model.sequenceFlows.map((value) => [value.id, value]))
  for (let diagramIndex = 0; diagramIndex < document.di.diagrams.length; diagramIndex++) {
    const diagram = document.di.diagrams[diagramIndex]!
    const diagramPath = ["di", "diagrams", diagramIndex] as const
    if (diagram.id !== undefined) {
      assertNcName(diagram.id, [...diagramPath, "id"], "BPMNDiagram id")
    }
    if (
      diagram.plane.bpmnElementId === undefined ||
      !processById.has(diagram.plane.bpmnElementId)
    ) {
      abort(
        Codes.UnsupportedDi,
        "BPMNPlane bpmnElement must identify a process in this profile",
        [...diagramPath, "plane", "bpmnElementId"]
      )
    }
    assertEmptyExtensions(
      diagram.plane.extensions,
      [...diagramPath, "plane", "extensions"],
      "BPMNPlane"
    )
    if (diagram.plane.id !== undefined) {
      assertNcName(diagram.plane.id, [...diagramPath, "plane", "id"], "BPMNPlane id")
    }
    for (let styleIndex = 0; styleIndex < diagram.labelStyles.length; styleIndex++) {
      const style = diagram.labelStyles[styleIndex]!
      if (style.id !== undefined) {
        assertNcName(
          style.id,
          [...diagramPath, "labelStyles", styleIndex, "id"],
          "BPMNLabelStyle id"
        )
      }
    }
    const planeProcessId = diagram.plane.bpmnElementId!
    const elementsById = new Map(
      diagram.plane.diagramElements.flatMap((element) =>
        element.id === undefined ? [] : [[element.id, element] as const]
      )
    )
    for (
      let elementIndex = 0;
      elementIndex < diagram.plane.diagramElements.length;
      elementIndex++
    ) {
      const element = diagram.plane.diagramElements[elementIndex]!
      const path = [...diagramPath, "plane", "diagramElements", elementIndex] as const
      assertEmptyExtensions(element.extensions, [...path, "extensions"], "BPMN diagram element")
      if (element.id !== undefined) {
        assertNcName(element.id, [...path, "id"], "BPMN diagram-element id")
      }
      if (element.label !== undefined) {
        assertEmptyExtensions(
          element.label.extensions,
          [...path, "label", "extensions"],
          "BPMNLabel"
        )
        if (element.label.id !== undefined) {
          assertNcName(element.label.id, [...path, "label", "id"], "BPMNLabel id")
        }
      }
      if (element._tag === "Shape") {
        const node = element.bpmnElementId === undefined
          ? undefined
          : nodeById.get(element.bpmnElementId)
        if (node === undefined) {
          abort(
            Codes.UnsupportedDi,
            "BPMNShape bpmnElement must identify a flow node in this profile",
            [...path, "bpmnElementId"]
          )
        }
        if (node!.processId !== planeProcessId) {
          abort(
            Codes.UnsupportedDi,
            `BPMNShape bpmnElement '${node!.id}' does not belong to BPMNPlane process '${planeProcessId}'`,
            [...path, "bpmnElementId"]
          )
        }
        if (
          element.participantBandKind !== undefined ||
          element.choreographyActivityShapeId !== undefined
        ) {
          abort(
            Codes.UnsupportedDi,
            "Participant-band and choreography shape fields are outside the core-process DI profile",
            path
          )
        }
        continue
      }

      const flow = element.bpmnElementId === undefined
        ? undefined
        : flowById.get(element.bpmnElementId)
      if (flow === undefined) {
        abort(
          Codes.UnsupportedDi,
          "BPMNEdge bpmnElement must identify a sequence flow in this profile",
          [...path, "bpmnElementId"]
        )
      }
      if (flow!.processId !== planeProcessId) {
        abort(
          Codes.UnsupportedDi,
          `BPMNEdge bpmnElement '${flow!.id}' does not belong to BPMNPlane process '${planeProcessId}'`,
          [...path, "bpmnElementId"]
        )
      }
      if (element.messageVisibleKind !== undefined) {
        abort(
          Codes.UnsupportedDi,
          "BPMNEdge messageVisibleKind is outside the core-process DI profile",
          [...path, "messageVisibleKind"]
        )
      }
      const assertEndpoint = (
        field: "sourceElementId" | "targetElementId",
        expectedNodeId: string
      ): void => {
        const reference = element[field]
        if (reference === undefined) {
          return
        }
        const endpoint = elementsById.get(reference)
        if (endpoint === undefined || endpoint._tag !== "Shape") {
          abort(
            Codes.UnsupportedDi,
            `BPMNEdge ${field} must identify a BPMNShape in the same BPMNPlane`,
            [...path, field],
            { reference }
          )
        }
        const endpointShape = endpoint as BpmnDi.Shape
        if (endpointShape.bpmnElementId !== expectedNodeId) {
          abort(
            Codes.UnsupportedDi,
            `BPMNEdge ${field} shape must visualize sequence-flow endpoint '${expectedNodeId}'`,
            [...path, field],
            {
              reference,
              expectedBpmnElementId: expectedNodeId,
              actualBpmnElementId: endpointShape.bpmnElementId ?? null
            }
          )
        }
      }
      assertEndpoint("sourceElementId", flow!.sourceId)
      assertEndpoint("targetElementId", flow!.targetId)
    }
  }
}

const assertGlobalIds = (document: InterchangeDocument): void => {
  const ids = new Map<string, ReadonlyArray<Diagnostic.PathSegment>>()
  const register = (
    id: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const previous = ids.get(id)
    if (previous !== undefined) {
      abort(
        Codes.DuplicateId,
        `BPMN XML Schema id '${id}' is duplicated across semantic and DI content`,
        path,
        { firstPath: previous }
      )
    }
    ids.set(id, path)
  }
  if (document.definitions.id !== undefined) {
    register(document.definitions.id, ["definitions", "id"])
  }
  for (let index = 0; index < document.model.processes.length; index++) {
    register(document.model.processes[index]!.id, ["model", "processes", index, "id"])
  }
  for (let index = 0; index < document.model.flowNodes.length; index++) {
    register(document.model.flowNodes[index]!.id, ["model", "flowNodes", index, "id"])
  }
  for (let index = 0; index < document.model.sequenceFlows.length; index++) {
    register(document.model.sequenceFlows[index]!.id, ["model", "sequenceFlows", index, "id"])
  }
  if (document.di !== undefined) {
    for (const [id, path] of allDiIds(document.di)) {
      register(id, path)
    }
  }
}

const validateDecoded = (
  document: InterchangeDocument
): Result.Result<InterchangeDocument, Diagnostic.CompilationError> => {
  try {
    if (document.profileId !== CoreProcessDiProfileId) {
      abort(
        Codes.UnsupportedModel,
        `Interchange document must use profile '${CoreProcessDiProfileId}'`,
        ["profileId"]
      )
    }
    if (document.mappingReport.profileId !== CoreProcessDiProfileId) {
      abort(
        Codes.UnsupportedModel,
        `Mapping report must use profile '${CoreProcessDiProfileId}'`,
        ["mappingReport", "profileId"]
      )
    }
    if (document.mappingReport.semanticLosses.length !== 0) {
      abort(
        Codes.SemanticLoss,
        "Documents with semantic mapping losses are not admitted by this profile",
        ["mappingReport", "semanticLosses"]
      )
    }
    if (document.definitions.id !== undefined) {
      assertNcName(document.definitions.id, ["definitions", "id"], "Definitions id")
    }
    assertNormalizedAnyUri(
      document.definitions.targetNamespace,
      ["definitions", "targetNamespace"],
      "Definitions targetNamespace"
    )
    assertNormalizedAnyUri(
      document.definitions.expressionLanguage,
      ["definitions", "expressionLanguage"],
      "Definitions expressionLanguage"
    )
    assertNormalizedAnyUri(
      document.definitions.typeLanguage,
      ["definitions", "typeLanguage"],
      "Definitions typeLanguage"
    )
    const bindings = bindingTable(
      document.expressionLanguageBindings,
      ["expressionLanguageBindings"]
    )
    assertModelProfile(document, bindings)
    assertGlobalIds(document)
    assertDiProfile(document)
  } catch (cause) {
    if (cause instanceof MappingAbort) {
      return Result.fail(compilationError(cause.diagnostic))
    }
    return Result.fail(compilationError(profileError(
      Codes.InvalidDocument,
      "BPMN XML profile validation failed safely",
      []
    )))
  }

  try {
    const exportable = BpmnXmlAst.serialize(exportAst(document), {
      format: "pretty",
      order: "preserve",
      indent: "  ",
      newline: "\n"
    })
    if (Result.isFailure(exportable)) {
      return Result.fail(exportable.failure)
    }
  } catch {
    return Result.fail(compilationError(profileError(
      Codes.InvalidDocument,
      "BPMN XML exportability validation failed safely",
      []
    )))
  }
  const semantic = BpmnModel.validate(document.model)
  if (Result.isFailure(semantic)) {
    return Result.fail(semantic.failure)
  }
  if (document.di !== undefined) {
    const visual = BpmnDi.validate(document.di, modelIds(document.model))
    if (Result.isFailure(visual)) {
      return Result.fail(visual.failure)
    }
  }
  return Result.succeed(document)
}

/**
 * Safely validates and freezes one core-process/DI interchange document.
 *
 * **Details**
 *
 * Validation first creates a bounded descriptor-safe JSON snapshot. It then
 * applies the named profile restrictions, the semantic model validator, and
 * the DI validator. Cross-document XML Schema ID uniqueness and semantic/DI
 * reference kinds are checked in addition to those component validators.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown
): Result.Result<InterchangeDocument, Diagnostic.CompilationError> => {
  const decoded = safeDecode(
    input,
    decodeInterchange,
    Codes.InvalidDocument,
    "Invalid BPMN XML interchange document"
  )
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure)
    : validateDecoded(decoded.success)
}

const rootElement = (
  document: BpmnXmlAst.XmlDocument
): BpmnXmlAst.XmlElement => {
  let root: BpmnXmlAst.XmlElement | undefined
  for (let index = 0; index < document.children.length; index++) {
    const child = document.children[index]!
    if (child._tag === "Text" && child.value.trim().length === 0) {
      continue
    }
    if (child._tag !== "Element") {
      abort(
        Codes.InvalidStructure,
        "BPMN XML must contain exactly one definitions root and only surrounding whitespace",
        ["xml", "children", index]
      )
    }
    if (root !== undefined) {
      abort(
        Codes.InvalidStructure,
        "BPMN XML must contain exactly one definitions root and only surrounding whitespace",
        ["xml", "children", index]
      )
    }
    root = child as BpmnXmlAst.XmlElement
  }
  if (root === undefined) {
    abort(
      Codes.InvalidStructure,
      "BPMN XML requires a definitions root element",
      ["xml", "children"]
    )
  }
  if (!isElementNamed(root!, ModelNamespace, "definitions")) {
    abort(
      root!.name.localName === "definitions"
        ? Codes.UnsupportedNamespace
        : Codes.UnsupportedElement,
      "BPMN XML root must be definitions in the BPMN 2.0 model namespace",
      xmlPath(root!)
    )
  }
  return root!
}

const definitionsMetadata = (
  root: BpmnXmlAst.XmlElement,
  report: MutableReport
): DefinitionsMetadata => {
  const attributes = readAttributes(
    root,
    new Set([
      "id",
      "name",
      "targetNamespace",
      "expressionLanguage",
      "typeLanguage",
      "exporter",
      "exporterVersion"
    ])
  )
  const targetNamespaceValue = unqualifiedAttribute(attributes, "targetNamespace")
  if (targetNamespaceValue === undefined) {
    abort(
      Codes.InvalidStructure,
      "definitions requires targetNamespace",
      xmlPath(root, ["attributes", "targetNamespace"])
    )
  }
  const targetNamespace = normalizedAnyUri(
    targetNamespaceValue!,
    report,
    xmlPath(root, ["attributes", "targetNamespace"]),
    "definitions targetNamespace"
  )
  const expressionLanguageValue = unqualifiedAttribute(attributes, "expressionLanguage")
  const typeLanguageValue = unqualifiedAttribute(attributes, "typeLanguage")
  const expressionLanguage = expressionLanguageValue === undefined
    ? XPath10Language
    : normalizedAnyUri(
      expressionLanguageValue,
      report,
      xmlPath(root, ["attributes", "expressionLanguage"]),
      "definitions expressionLanguage"
    )
  const typeLanguage = typeLanguageValue === undefined
    ? XmlSchemaLanguage
    : normalizedAnyUri(
      typeLanguageValue,
      report,
      xmlPath(root, ["attributes", "typeLanguage"]),
      "definitions typeLanguage"
    )
  if (expressionLanguageValue === undefined) {
    notice(
      report.defaultsApplied,
      "ExpressionLanguageDefault",
      `Absent expressionLanguage defaults to '${XPath10Language}'`,
      xmlPath(root, ["attributes", "expressionLanguage"])
    )
  }
  if (typeLanguageValue === undefined) {
    notice(
      report.defaultsApplied,
      "TypeLanguageDefault",
      `Absent typeLanguage defaults to '${XmlSchemaLanguage}'`,
      xmlPath(root, ["attributes", "typeLanguage"])
    )
  }
  const id = readId(
    unqualifiedAttribute(attributes, "id"),
    false,
    report,
    xmlPath(root, ["attributes", "id"]),
    "definitions"
  )
  const exporter = unqualifiedAttribute(attributes, "exporter")
  const exporterVersion = unqualifiedAttribute(attributes, "exporterVersion")
  if (exporter === "" || exporterVersion === "") {
    abort(
      Codes.UnsupportedModel,
      "Empty exporter metadata cannot be represented by this profile",
      xmlPath(root, ["attributes"])
    )
  }
  return {
    ...(id === undefined ? undefined : { id }),
    ...(unqualifiedAttribute(attributes, "name") === undefined
      ? undefined
      : { name: unqualifiedAttribute(attributes, "name")! }),
    targetNamespace,
    expressionLanguage,
    typeLanguage,
    ...(exporter === undefined ? undefined : { exporter }),
    ...(exporterVersion === undefined ? undefined : { exporterVersion })
  }
}

const importedDocument = (
  ast: BpmnXmlAst.XmlDocument,
  options: ImportOptions
): InterchangeDocument => {
  const report: MutableReport = {
    semanticLosses: [],
    defaultsApplied: [],
    normalizations: [],
    lexicalNonPreservation: []
  }
  notice(
    report.lexicalNonPreservation,
    "NamespacePrefixLexicalForm",
    "Namespace prefix spellings and declaration placement are not preserved",
    ["xml"]
  )
  notice(
    report.lexicalNonPreservation,
    "InsignificantXmlFormatting",
    "Insignificant element-only whitespace and empty-element spellings are not preserved",
    ["xml"]
  )
  if (ast.declaration !== undefined) {
    notice(
      report.lexicalNonPreservation,
      "XmlDeclarationLexicalForm",
      "The XML declaration is serialized in the profile's canonical form",
      ["xml", "declaration"]
    )
  }

  const root = rootElement(ast)
  const metadata = definitionsMetadata(root, report)
  const bindings = bindingTable(options.expressionLanguageBindings, [
    "options",
    "expressionLanguageBindings"
  ])
  const state: ParserState = {
    metadata,
    bindings,
    report,
    nodes: [],
    flows: [],
    parsedNodes: [],
    processes: []
  }
  const rootContext = namespaceContext(new Map([["xml", XmlNamespace]]), root)
  const diagrams: Array<BpmnDi.Diagram> = []
  let seenDiagram = false
  for (const child of structuralChildren(root)) {
    if (isElementNamed(child, ModelNamespace, "process")) {
      if (seenDiagram) {
        abort(
          Codes.InvalidStructure,
          "BPMN process elements must precede BPMNDiagram elements",
          xmlPath(child)
        )
      }
      parseProcess(child, rootContext, state)
      continue
    }
    if (isElementNamed(child, BpmnDiNamespace, "BPMNDiagram")) {
      seenDiagram = true
      diagrams.push(parseDiagram(child, rootContext, state))
      continue
    }
    abort(
      child.name.namespaceUri === ModelNamespace ||
        child.name.namespaceUri === BpmnDiNamespace
        ? Codes.UnsupportedElement
        : Codes.UnsupportedNamespace,
      `Definitions child '${child.name.localName}' in namespace '${child.name.namespaceUri}' is outside this profile`,
      xmlPath(child)
    )
  }
  if (state.processes.length === 0) {
    abort(
      Codes.InvalidStructure,
      "The core-process profile requires at least one process",
      xmlPath(root, ["children"])
    )
  }
  resolveFlowReferences(state)

  const mappingReport: MappingReport = {
    profileId: CoreProcessDiProfileId,
    semanticLosses: report.semanticLosses,
    defaultsApplied: report.defaultsApplied,
    normalizations: report.normalizations,
    lexicalNonPreservation: report.lexicalNonPreservation
  }
  const model: BpmnModel.BpmnModel = {
    modelKind: "BpmnModel",
    modelVersion: BpmnModel.BpmnModelVersion,
    bpmnSpecVersion: "2.0.2",
    imports: [{
      importId: options.importId,
      sourceKind: "bpmn-xml",
      ...(options.locator === undefined ? undefined : { locator: options.locator }),
      sourceVersion: "2.0.2"
    }],
    extensionElements: [],
    collaborations: [],
    processes: state.processes,
    flowNodes: state.nodes,
    sequenceFlows: state.flows
  }
  return {
    profileId: CoreProcessDiProfileId,
    definitions: metadata,
    expressionLanguageBindings: [...bindings.bindings],
    model,
    ...(diagrams.length === 0
      ? undefined
      : {
        di: {
          documentKind: "BpmnDiDocument",
          documentVersion: BpmnDi.BpmnDiDocumentVersion,
          bpmnSpecVersion: "2.0.2",
          diagrams
        }
      }),
    mappingReport
  }
}

/**
 * Imports one complete XML document using the strict named BPMN profile.
 *
 * **Details**
 *
 * Namespace prefixes are irrelevant: all element, attribute, QName, and type
 * decisions use expanded namespace names. DTDs and resource exhaustion are
 * rejected by {@link BpmnXmlAst.parse}. Selected XSD ordering, cardinality,
 * lexical, ID/IDREF, QName, and default rules are then enforced before the
 * semantic and DI component validators run.
 *
 * Every expression language used by a condition must have one caller-supplied
 * exact version binding. This function never guesses an implementation
 * version and never reads a clock.
 *
 * @category parsing
 * @since 4.0.0
 */
export const importXml = (
  input: unknown,
  optionsInput: unknown
): Result.Result<InterchangeDocument, Diagnostic.CompilationError> => {
  const options = safeDecode(
    optionsInput,
    decodeImportOptions,
    Codes.InvalidOptions,
    "Invalid BPMN XML import options"
  )
  if (Result.isFailure(options)) {
    return Result.fail(options.failure)
  }
  const ast = BpmnXmlAst.parse(input, options.success.limits)
  if (Result.isFailure(ast)) {
    return Result.fail(ast.failure)
  }
  try {
    return validate(importedDocument(ast.success, options.success))
  } catch (cause) {
    if (cause instanceof MappingAbort) {
      return Result.fail(compilationError(cause.diagnostic))
    }
    return Result.fail(compilationError(profileError(
      Codes.InvalidDocument,
      "BPMN XML mapping failed safely",
      []
    )))
  }
}

const zeroPosition: BpmnXmlAst.SourcePosition = Object.freeze({
  offset: 0,
  line: 1,
  column: 0
})
const zeroSpan: BpmnXmlAst.SourceSpan = Object.freeze({
  start: zeroPosition,
  end: zeroPosition
})

const xmlName = (
  namespaceUri: string,
  localName: string,
  prefix: string
): BpmnXmlAst.ExpandedName => ({ namespaceUri, localName, prefix })

const xmlAttribute = (
  localName: string,
  value: string,
  namespaceUri = "",
  prefix = ""
): BpmnXmlAst.XmlAttribute => ({
  name: xmlName(namespaceUri, localName, prefix),
  value,
  span: zeroSpan
})

const xmlText = (value: string): BpmnXmlAst.XmlText => ({
  _tag: "Text",
  value,
  span: zeroSpan
})

const xmlElement = (
  namespaceUri: string,
  localName: string,
  prefix: string,
  attributes: ReadonlyArray<BpmnXmlAst.XmlAttribute>,
  children: ReadonlyArray<BpmnXmlAst.XmlNode>,
  namespaceDeclarations: ReadonlyArray<BpmnXmlAst.NamespaceDeclaration> = []
): BpmnXmlAst.XmlElement => ({
  _tag: "Element",
  name: xmlName(namespaceUri, localName, prefix),
  namespaceDeclarations,
  attributes,
  children,
  span: zeroSpan
})

const bpmnElement = (
  localName: string,
  attributes: ReadonlyArray<BpmnXmlAst.XmlAttribute>,
  children: ReadonlyArray<BpmnXmlAst.XmlNode>
): BpmnXmlAst.XmlElement => xmlElement(ModelNamespace, localName, "bpmn", attributes, children)

const boolLexical = (value: boolean): string => value ? "true" : "false"

const doubleLexical = (value: number): string => Object.is(value, -0) ? "0" : String(value)

const addOptionalAttribute = (
  attributes: Array<BpmnXmlAst.XmlAttribute>,
  name: string,
  value: string | undefined
): void => {
  if (value !== undefined) {
    attributes.push(xmlAttribute(name, value))
  }
}

const exportCondition = (
  value: BpmnModel.Expression,
  definitions: DefinitionsMetadata
): BpmnXmlAst.XmlElement => {
  const attributes = [
    xmlAttribute("type", "bpmn:tFormalExpression", XsiNamespace, "xsi")
  ]
  if (value.language !== definitions.expressionLanguage) {
    attributes.push(xmlAttribute("language", value.language))
  }
  return bpmnElement("conditionExpression", attributes, [xmlText(value.source)])
}

const flowReferenceChildren = (
  node: BpmnModel.FlowNode
): ReadonlyArray<BpmnXmlAst.XmlElement> => [
  ...node.incomingSequenceFlowIds.map((id) => bpmnElement("incoming", [], [xmlText(`tns:${id}`)])),
  ...node.outgoingSequenceFlowIds.map((id) => bpmnElement("outgoing", [], [xmlText(`tns:${id}`)]))
]

const commonFlowNodeAttributes = (
  node: BpmnModel.FlowNode
): Array<BpmnXmlAst.XmlAttribute> => {
  const attributes = [xmlAttribute("id", node.id)]
  addOptionalAttribute(attributes, "name", node.name)
  return attributes
}

const addActivityAttributes = (
  attributes: Array<BpmnXmlAst.XmlAttribute>,
  node: BpmnModel.Task | BpmnModel.CallActivity | BpmnModel.SubProcess
): void => {
  addOptionalAttribute(attributes, "default", node.defaultFlowId)
  if (node.isForCompensation !== undefined) {
    attributes.push(xmlAttribute("isForCompensation", boolLexical(node.isForCompensation)))
  }
  if (node.startQuantity !== undefined) {
    attributes.push(xmlAttribute("startQuantity", String(node.startQuantity)))
  }
  if (node.completionQuantity !== undefined) {
    attributes.push(xmlAttribute("completionQuantity", String(node.completionQuantity)))
  }
}

const scopeKey = (
  processId: string,
  scopeId: string
): string => `${processId}\u0000${scopeId}`

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

interface ExportContext {
  readonly document: InterchangeDocument
  readonly nodesByScope: ReadonlyMap<string, ReadonlyArray<BpmnModel.FlowNode>>
  readonly flowsByScope: ReadonlyMap<string, ReadonlyArray<BpmnModel.SequenceFlow>>
  readonly callableNamespacePrefixes: ReadonlyMap<string, string>
}

const exportContext = (document: InterchangeDocument): ExportContext => {
  const nodesByScope = new Map<string, Array<BpmnModel.FlowNode>>()
  const flowsByScope = new Map<string, Array<BpmnModel.SequenceFlow>>()
  const callableNamespaceUris = new Set<string>()
  for (const node of document.model.flowNodes) {
    const key = scopeKey(node.processId, node.parentScopeId)
    const values = nodesByScope.get(key)
    if (values === undefined) {
      nodesByScope.set(key, [node])
    } else {
      values.push(node)
    }
    if (
      node._tag === "CallActivity" &&
      node.calledElement !== undefined &&
      node.calledElement.namespaceUri.length > 0 &&
      node.calledElement.namespaceUri !== document.definitions.targetNamespace &&
      node.calledElement.namespaceUri !== XmlNamespace
    ) {
      callableNamespaceUris.add(node.calledElement.namespaceUri)
    }
  }
  for (const flow of document.model.sequenceFlows) {
    const key = scopeKey(flow.processId, flow.parentScopeId)
    const values = flowsByScope.get(key)
    if (values === undefined) {
      flowsByScope.set(key, [flow])
    } else {
      values.push(flow)
    }
  }
  const callableNamespacePrefixes = new Map<string, string>([
    [document.definitions.targetNamespace, "tns"],
    [XmlNamespace, "xml"]
  ])
  const sortedCallableNamespaces = [...callableNamespaceUris].sort(compareCodeUnits)
  for (let index = 0; index < sortedCallableNamespaces.length; index++) {
    callableNamespacePrefixes.set(sortedCallableNamespaces[index]!, `call${index}`)
  }
  return { document, nodesByScope, flowsByScope, callableNamespacePrefixes }
}

const callableElementLexical = (
  value: BpmnModel.ExpandedQName,
  context: ExportContext
): string => {
  if (value.namespaceUri.length === 0) {
    return value.localName
  }
  const prefix = context.callableNamespacePrefixes.get(value.namespaceUri)
  if (prefix === undefined) {
    return abort(
      Codes.InvalidReference,
      `No deterministic namespace prefix exists for callable element '{${value.namespaceUri}}${value.localName}'`,
      ["model", "flowNodes"]
    )
  }
  return `${prefix}:${value.localName}`
}

const exportSequenceFlow = (
  flow: BpmnModel.SequenceFlow,
  definitions: DefinitionsMetadata
): BpmnXmlAst.XmlElement => {
  const attributes = [
    xmlAttribute("id", flow.id),
    xmlAttribute("sourceRef", flow.sourceId),
    xmlAttribute("targetRef", flow.targetId)
  ]
  addOptionalAttribute(attributes, "name", flow.name)
  if (flow.isImmediate !== undefined) {
    attributes.push(xmlAttribute("isImmediate", boolLexical(flow.isImmediate)))
  }
  return bpmnElement(
    "sequenceFlow",
    attributes,
    flow.condition === undefined ? [] : [exportCondition(flow.condition, definitions)]
  )
}

const exportNode = (
  node: BpmnModel.FlowNode,
  context: ExportContext
): BpmnXmlAst.XmlElement => {
  const attributes = commonFlowNodeAttributes(node)
  const referenceChildren = flowReferenceChildren(node)
  switch (node._tag) {
    case "Task":
      addActivityAttributes(attributes, node)
      return bpmnElement("task", attributes, referenceChildren)
    case "CallActivity":
      addActivityAttributes(attributes, node)
      if (node.calledElement !== undefined) {
        attributes.push(xmlAttribute(
          "calledElement",
          callableElementLexical(node.calledElement, context)
        ))
      }
      return bpmnElement("callActivity", attributes, referenceChildren)
    case "SubProcess": {
      addActivityAttributes(attributes, node)
      const key = scopeKey(node.processId, node.id)
      const contained = [
        ...(context.nodesByScope.get(key) ?? [])
          .map((child) => exportNode(child, context)),
        ...(context.flowsByScope.get(key) ?? [])
          .map((flow) => exportSequenceFlow(flow, context.document.definitions))
      ]
      return bpmnElement("subProcess", attributes, [...referenceChildren, ...contained])
    }
    case "StartEvent":
      if (node.parallelMultiple !== undefined) {
        attributes.push(xmlAttribute("parallelMultiple", boolLexical(node.parallelMultiple)))
      }
      if (node.isInterrupting !== undefined) {
        attributes.push(xmlAttribute("isInterrupting", boolLexical(node.isInterrupting)))
      }
      return bpmnElement("startEvent", attributes, referenceChildren)
    case "EndEvent":
      return bpmnElement("endEvent", attributes, referenceChildren)
    case "Gateway": {
      const directions = {
        unspecified: "Unspecified",
        converging: "Converging",
        diverging: "Diverging",
        mixed: "Mixed"
      } as const
      attributes.push(xmlAttribute("gatewayDirection", directions[node.gatewayDirection]))
      addOptionalAttribute(attributes, "default", node.defaultFlowId)
      return bpmnElement(
        node.gatewayKind === "exclusive" ? "exclusiveGateway" : "parallelGateway",
        attributes,
        referenceChildren
      )
    }
    default:
      return abort(
        Codes.UnsupportedModel,
        `Cannot export flow-node tag '${node._tag}'`,
        ["model", "flowNodes"]
      )
  }
}

const exportProcess = (
  process: BpmnModel.Process,
  context: ExportContext
): BpmnXmlAst.XmlElement => {
  const processTypes = {
    none: "None",
    public: "Public",
    private: "Private"
  } as const
  const attributes = [xmlAttribute("id", process.id)]
  addOptionalAttribute(attributes, "name", process.name)
  attributes.push(xmlAttribute("processType", processTypes[process.processType!]))
  attributes.push(xmlAttribute("isClosed", boolLexical(process.isClosed!)))
  if (process.isExecutable !== undefined) {
    attributes.push(xmlAttribute("isExecutable", boolLexical(process.isExecutable)))
  }
  const key = scopeKey(process.id, process.id)
  const children = [
    ...(context.nodesByScope.get(key) ?? []).map((node) => exportNode(node, context)),
    ...(context.flowsByScope.get(key) ?? [])
      .map((flow) => exportSequenceFlow(flow, context.document.definitions))
  ]
  return bpmnElement("process", attributes, children)
}

const exportBounds = (bounds: BpmnDi.Bounds): BpmnXmlAst.XmlElement =>
  xmlElement(DcNamespace, "Bounds", "dc", [
    xmlAttribute("x", doubleLexical(bounds.x)),
    xmlAttribute("y", doubleLexical(bounds.y)),
    xmlAttribute("width", doubleLexical(bounds.width)),
    xmlAttribute("height", doubleLexical(bounds.height))
  ], [])

const exportLabel = (label: BpmnDi.Label): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", label.id)
  addOptionalAttribute(attributes, "labelStyle", label.styleRef)
  return xmlElement(
    BpmnDiNamespace,
    "BPMNLabel",
    "bpmndi",
    attributes,
    label.bounds === undefined ? [] : [exportBounds(label.bounds)]
  )
}

const exportShape = (shape: BpmnDi.Shape): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", shape.id)
  addOptionalAttribute(attributes, "bpmnElement", shape.bpmnElementId)
  if (shape.isHorizontal !== undefined) {
    attributes.push(xmlAttribute("isHorizontal", boolLexical(shape.isHorizontal)))
  }
  if (shape.isExpanded !== undefined) {
    attributes.push(xmlAttribute("isExpanded", boolLexical(shape.isExpanded)))
  }
  if (shape.isMarkerVisible !== undefined) {
    attributes.push(xmlAttribute("isMarkerVisible", boolLexical(shape.isMarkerVisible)))
  }
  if (shape.isMessageVisible !== undefined) {
    attributes.push(xmlAttribute("isMessageVisible", boolLexical(shape.isMessageVisible)))
  }
  addOptionalAttribute(attributes, "participantBandKind", shape.participantBandKind)
  addOptionalAttribute(
    attributes,
    "choreographyActivityShape",
    shape.choreographyActivityShapeId
  )
  return xmlElement(
    BpmnDiNamespace,
    "BPMNShape",
    "bpmndi",
    attributes,
    [
      exportBounds(shape.bounds),
      ...(shape.label === undefined ? [] : [exportLabel(shape.label)])
    ]
  )
}

const exportWaypoint = (point: BpmnDi.Point): BpmnXmlAst.XmlElement =>
  xmlElement(DiNamespace, "waypoint", "di", [
    xmlAttribute("x", doubleLexical(point.x)),
    xmlAttribute("y", doubleLexical(point.y))
  ], [])

const exportEdge = (edge: BpmnDi.Edge): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", edge.id)
  addOptionalAttribute(attributes, "bpmnElement", edge.bpmnElementId)
  addOptionalAttribute(attributes, "sourceElement", edge.sourceElementId)
  addOptionalAttribute(attributes, "targetElement", edge.targetElementId)
  addOptionalAttribute(attributes, "messageVisibleKind", edge.messageVisibleKind)
  return xmlElement(
    BpmnDiNamespace,
    "BPMNEdge",
    "bpmndi",
    attributes,
    [
      ...edge.waypoints.map(exportWaypoint),
      ...(edge.label === undefined ? [] : [exportLabel(edge.label)])
    ]
  )
}

const exportPlane = (plane: BpmnDi.Plane): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", plane.id)
  addOptionalAttribute(attributes, "bpmnElement", plane.bpmnElementId)
  return xmlElement(
    BpmnDiNamespace,
    "BPMNPlane",
    "bpmndi",
    attributes,
    plane.diagramElements.map((element) => element._tag === "Shape" ? exportShape(element) : exportEdge(element))
  )
}

const exportFont = (font: BpmnDi.Font): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "name", font.name)
  if (font.size !== undefined) {
    attributes.push(xmlAttribute("size", doubleLexical(font.size)))
  }
  const bool = (name: string, value: boolean | undefined): void => {
    if (value !== undefined) {
      attributes.push(xmlAttribute(name, boolLexical(value)))
    }
  }
  bool("isBold", font.isBold)
  bool("isItalic", font.isItalic)
  bool("isUnderline", font.isUnderline)
  bool("isStrikeThrough", font.isStrikeThrough)
  return xmlElement(DcNamespace, "Font", "dc", attributes, [])
}

const exportLabelStyle = (style: BpmnDi.LabelStyle): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", style.id)
  return xmlElement(
    BpmnDiNamespace,
    "BPMNLabelStyle",
    "bpmndi",
    attributes,
    [exportFont(style.font)]
  )
}

const exportDiagram = (diagram: BpmnDi.Diagram): BpmnXmlAst.XmlElement => {
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", diagram.id)
  addOptionalAttribute(attributes, "name", diagram.name)
  addOptionalAttribute(attributes, "documentation", diagram.documentation)
  if (diagram.resolution !== undefined) {
    attributes.push(xmlAttribute("resolution", doubleLexical(diagram.resolution)))
  }
  return xmlElement(
    BpmnDiNamespace,
    "BPMNDiagram",
    "bpmndi",
    attributes,
    [
      exportPlane(diagram.plane),
      ...diagram.labelStyles.map(exportLabelStyle)
    ]
  )
}

const exportAst = (document: InterchangeDocument): BpmnXmlAst.XmlDocument => {
  const context = exportContext(document)
  const attributes: Array<BpmnXmlAst.XmlAttribute> = []
  addOptionalAttribute(attributes, "id", document.definitions.id)
  addOptionalAttribute(attributes, "name", document.definitions.name)
  attributes.push(xmlAttribute("targetNamespace", document.definitions.targetNamespace))
  attributes.push(xmlAttribute("expressionLanguage", document.definitions.expressionLanguage))
  attributes.push(xmlAttribute("typeLanguage", document.definitions.typeLanguage))
  addOptionalAttribute(attributes, "exporter", document.definitions.exporter)
  addOptionalAttribute(attributes, "exporterVersion", document.definitions.exporterVersion)
  const declaration = (prefix: string, namespaceUri: string): BpmnXmlAst.NamespaceDeclaration => ({
    prefix,
    namespaceUri,
    span: zeroSpan
  })
  const root = xmlElement(
    ModelNamespace,
    "definitions",
    "bpmn",
    attributes,
    [
      ...document.model.processes.map((process) => exportProcess(process, context)),
      ...(document.di?.diagrams.map(exportDiagram) ?? [])
    ],
    [
      declaration("bpmn", ModelNamespace),
      declaration("bpmndi", BpmnDiNamespace),
      declaration("di", DiNamespace),
      declaration("dc", DcNamespace),
      declaration("xsi", XsiNamespace),
      declaration("tns", document.definitions.targetNamespace),
      ...[...context.callableNamespacePrefixes.entries()]
        .filter(([namespaceUri]) =>
          namespaceUri !== document.definitions.targetNamespace &&
          namespaceUri !== XmlNamespace
        )
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([namespaceUri, prefix]) => declaration(prefix, namespaceUri))
    ]
  )
  return {
    documentKind: "XmlInfoset",
    documentVersion: BpmnXmlAst.XmlInfosetVersion,
    declaration: {
      version: "1.0",
      encoding: "UTF-8",
      span: zeroSpan
    },
    children: [root],
    span: zeroSpan
  }
}

/**
 * Deterministically exports one validated core-process/DI document as XML.
 *
 * **Details**
 *
 * Output always uses the canonical `bpmn`, `bpmndi`, `di`, `dc`, `xsi`, and
 * `tns` prefixes and canonical boolean/number spellings. This is deterministic
 * profile serialization, not W3C XML Canonicalization. The document is fully
 * revalidated before an infoset is built, and the infoset is then validated by
 * {@link BpmnXmlAst.serialize}.
 *
 * @category serialization
 * @since 4.0.0
 */
export const exportXml = (
  input: unknown,
  optionsInput: unknown = {}
): Result.Result<string, Diagnostic.CompilationError> => {
  const options = safeDecode(
    optionsInput,
    decodeExportOptions,
    Codes.InvalidOptions,
    "Invalid BPMN XML export options"
  )
  if (Result.isFailure(options)) {
    return Result.fail(options.failure)
  }
  const document = validate(input)
  if (Result.isFailure(document)) {
    return Result.fail(document.failure)
  }
  try {
    return BpmnXmlAst.serialize(exportAst(document.success), {
      format: options.success.format ?? "pretty",
      order: "preserve",
      indent: options.success.indent ?? "  ",
      newline: options.success.newline ?? "\n",
      ...(options.success.limits === undefined
        ? undefined
        : { limits: options.success.limits })
    })
  } catch {
    return Result.fail(compilationError(profileError(
      Codes.InvalidDocument,
      "BPMN XML serialization failed safely",
      []
    )))
  }
}
