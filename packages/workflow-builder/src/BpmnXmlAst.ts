/**
 * Strict, bounded XML infoset foundations for BPMN interchange.
 *
 * **Details**
 *
 * This module parses and serializes namespace-aware XML 1.0 while preserving
 * the ordered information needed by a later BPMN 2.0.2 interchange mapper. It
 * is deliberately not a BPMN semantic-model mapper, an XSD validator, or a
 * claim of BPMN conformance.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { SaxesParser } from "saxes"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const PositiveSafeInt = PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const XmlNamespaceUri = "http://www.w3.org/XML/1998/namespace"
const XmlnsNamespaceUri = "http://www.w3.org/2000/xmlns/"

const compilationError = (diagnostic: Diagnostic.Diagnostic): Diagnostic.CompilationError =>
  new Diagnostic.CompilationError({ diagnostics: [diagnostic] })

const error = (
  code: XmlDiagnosticCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

/**
 * Version of the portable XML infoset document.
 *
 * @category constants
 * @since 4.0.0
 */
export const XmlInfosetVersion = 1 as const

/**
 * A zero-based UTF-16 source offset and column with a one-based line.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SourcePosition = Schema.Struct({
  offset: NonNegativeInt,
  line: PositiveInt,
  column: NonNegativeInt
}).annotate({
  identifier: "WorkflowBpmnXmlSourcePosition",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SourcePosition}.
 *
 * @category models
 * @since 4.0.0
 */
export type SourcePosition = Schema.Schema.Type<typeof SourcePosition>

/**
 * Structural representation of a half-open source span.
 *
 * **Details**
 *
 * Positional ordering is guaranteed by parser output. Consumers admitting
 * unknown documents should use {@link validate} rather than decoding this
 * structural codec alone.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SourceSpan = Schema.Struct({
  start: SourcePosition,
  end: SourcePosition
}).annotate({
  identifier: "WorkflowBpmnXmlSourceSpan",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SourceSpan}.
 *
 * @category models
 * @since 4.0.0
 */
export type SourceSpan = Schema.Schema.Type<typeof SourceSpan>

/**
 * An XML name resolved to its namespace URI while retaining its lexical prefix.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExpandedName = Schema.Struct({
  namespaceUri: Schema.String,
  localName: Schema.NonEmptyString,
  prefix: Schema.String
}).annotate({
  identifier: "WorkflowBpmnXmlExpandedName",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExpandedName}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExpandedName = Schema.Schema.Type<typeof ExpandedName>

/**
 * One namespace declaration in lexical declaration order.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NamespaceDeclaration = Schema.Struct({
  prefix: Schema.String,
  namespaceUri: Schema.String,
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlNamespaceDeclaration",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NamespaceDeclaration}.
 *
 * @category models
 * @since 4.0.0
 */
export type NamespaceDeclaration = Schema.Schema.Type<typeof NamespaceDeclaration>

/**
 * One non-namespace XML attribute in lexical attribute order.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlAttribute = Schema.Struct({
  name: ExpandedName,
  value: Schema.String,
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlAttribute",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlAttribute}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlAttribute = Schema.Schema.Type<typeof XmlAttribute>

/**
 * An XML declaration retained separately from document children.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlDeclaration = Schema.Struct({
  version: Schema.Literal("1.0"),
  encoding: Schema.optionalKey(Schema.NonEmptyString),
  standalone: Schema.optionalKey(Schema.Literals(["yes", "no"])),
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlDeclaration",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlDeclaration}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlDeclaration = Schema.Schema.Type<typeof XmlDeclaration>

/**
 * A text information item.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlText = Schema.TaggedStruct("Text", {
  value: Schema.String,
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlText",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlText}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlText = Schema.Schema.Type<typeof XmlText>

/**
 * A CDATA section retained as a distinct lexical information item.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlCData = Schema.TaggedStruct("CData", {
  value: Schema.String,
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlCData",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlCData}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlCData = Schema.Schema.Type<typeof XmlCData>

/**
 * An XML comment.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlComment = Schema.TaggedStruct("Comment", {
  value: Schema.String,
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlComment",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlComment}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlComment = Schema.Schema.Type<typeof XmlComment>

/**
 * An XML processing instruction.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlProcessingInstruction = Schema.TaggedStruct("ProcessingInstruction", {
  target: Schema.NonEmptyString,
  body: Schema.String,
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlProcessingInstruction",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlProcessingInstruction}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlProcessingInstruction = Schema.Schema.Type<typeof XmlProcessingInstruction>

/**
 * A namespace-aware XML element.
 *
 * @category models
 * @since 4.0.0
 */
export interface XmlElement {
  readonly _tag: "Element"
  readonly name: ExpandedName
  readonly namespaceDeclarations: ReadonlyArray<NamespaceDeclaration>
  readonly attributes: ReadonlyArray<XmlAttribute>
  readonly children: ReadonlyArray<XmlNode>
  readonly span: SourceSpan
}

/**
 * One ordered XML document or element child.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlNode = XmlElement | XmlText | XmlCData | XmlComment | XmlProcessingInstruction

/**
 * Schema for a namespace-aware XML element.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlElement: Schema.Codec<XmlElement> = Schema.TaggedStruct("Element", {
  name: ExpandedName,
  namespaceDeclarations: Schema.Array(NamespaceDeclaration),
  attributes: Schema.Array(XmlAttribute),
  children: Schema.Array(Schema.suspend((): Schema.Codec<XmlNode> => XmlNode)),
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlElement",
  parseOptions: strictParseOptions
})

/**
 * Schema for one ordered XML document or element child.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlNode: Schema.Codec<XmlNode> = Schema.Union([
  XmlElement,
  XmlText,
  XmlCData,
  XmlComment,
  XmlProcessingInstruction
]).annotate({ identifier: "WorkflowBpmnXmlNode" })

/**
 * Structural codec for an XML infoset document.
 *
 * **Details**
 *
 * This codec checks the portable JSON shape only. Document grammar, namespace
 * bindings, lexical XML constraints, source-span ordering, and resource bounds
 * are enforced by {@link parse}, {@link validate}, and {@link serialize}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlDocument = Schema.Struct({
  documentKind: Schema.Literal("XmlInfoset"),
  documentVersion: Schema.Literal(XmlInfosetVersion),
  declaration: Schema.optionalKey(XmlDeclaration),
  children: Schema.Array(XmlNode),
  span: SourceSpan
}).annotate({
  identifier: "WorkflowBpmnXmlDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlDocument = Schema.Schema.Type<typeof XmlDocument>

/**
 * Non-overridable XML nesting ceiling used to preserve total error handling.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumXmlDepth = 256 as const

/**
 * Optional bounds applied while parsing or validating an XML infoset.
 *
 * @category schemas
 * @since 4.0.0
 */
export const XmlLimits = Schema.Struct({
  maxDocumentCharacters: Schema.optionalKey(PositiveSafeInt),
  maxDepth: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(MaximumXmlDepth))),
  maxNodes: Schema.optionalKey(PositiveSafeInt),
  maxAttributesPerElement: Schema.optionalKey(PositiveSafeInt),
  maxNamespaceDeclarationsPerElement: Schema.optionalKey(PositiveSafeInt),
  maxTextCharactersPerNode: Schema.optionalKey(PositiveSafeInt),
  maxTotalTextCharacters: Schema.optionalKey(PositiveSafeInt),
  maxNameCharacters: Schema.optionalKey(PositiveSafeInt)
}).annotate({
  identifier: "WorkflowBpmnXmlLimits",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link XmlLimits}.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlLimits = Schema.Schema.Type<typeof XmlLimits>

interface ResolvedXmlLimits {
  readonly maxDocumentCharacters: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxAttributesPerElement: number
  readonly maxNamespaceDeclarationsPerElement: number
  readonly maxTextCharactersPerNode: number
  readonly maxTotalTextCharacters: number
  readonly maxNameCharacters: number
}

/**
 * Conservative default bounds for untrusted XML documents.
 *
 * @category constants
 * @since 4.0.0
 */
export const defaultXmlLimits: Readonly<ResolvedXmlLimits> = Object.freeze({
  maxDocumentCharacters: 5_000_000,
  maxDepth: MaximumXmlDepth,
  maxNodes: 250_000,
  maxAttributesPerElement: 256,
  maxNamespaceDeclarationsPerElement: 64,
  maxTextCharactersPerNode: 1_000_000,
  maxTotalTextCharacters: 5_000_000,
  maxNameCharacters: 512
})

/**
 * Formatting and ordering controls for deterministic serialization.
 *
 * **Details**
 *
 * Canonical ordering sorts namespace declarations and attributes but is not
 * W3C XML Canonicalization. Pretty formatting inserts whitespace into
 * element-only content; use compact formatting when preserving the infoset
 * across a serialize/parse round trip matters.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SerializeOptions = Schema.Struct({
  format: Schema.optionalKey(Schema.Literals(["compact", "pretty"])),
  order: Schema.optionalKey(Schema.Literals(["preserve", "canonical"])),
  indent: Schema.optionalKey(Schema.String),
  newline: Schema.optionalKey(Schema.Literals(["\n", "\r\n"])),
  limits: Schema.optionalKey(XmlLimits)
}).annotate({
  identifier: "WorkflowBpmnXmlSerializeOptions",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link SerializeOptions}.
 *
 * @category models
 * @since 4.0.0
 */
export type SerializeOptions = Schema.Schema.Type<typeof SerializeOptions>

interface ResolvedSerializeOptions {
  readonly format: "compact" | "pretty"
  readonly order: "preserve" | "canonical"
  readonly indent: string
  readonly newline: "\n" | "\r\n"
  readonly limits: ResolvedXmlLimits
}

/**
 * Stable XML parser and serializer diagnostic codes.
 *
 * @category errors
 * @since 4.0.0
 */
export const Codes = {
  InvalidInput: "InvalidXmlInput",
  InvalidOptions: "InvalidXmlOptions",
  InvalidDocument: "InvalidXmlDocument",
  InvalidXml: "InvalidXml",
  DtdForbidden: "XmlDtdForbidden",
  DocumentLimitExceeded: "XmlDocumentLimitExceeded",
  DepthLimitExceeded: "XmlDepthLimitExceeded",
  NodeLimitExceeded: "XmlNodeLimitExceeded",
  AttributeLimitExceeded: "XmlAttributeLimitExceeded",
  NamespaceLimitExceeded: "XmlNamespaceLimitExceeded",
  TextLimitExceeded: "XmlTextLimitExceeded",
  NameLimitExceeded: "XmlNameLimitExceeded",
  InvalidName: "InvalidXmlName",
  InvalidCharacter: "InvalidXmlCharacter",
  DuplicateAttribute: "DuplicateXmlAttribute",
  InvalidNamespaceBinding: "InvalidXmlNamespaceBinding"
} as const

/**
 * A stable XML parser or serializer diagnostic code.
 *
 * @category models
 * @since 4.0.0
 */
export type XmlDiagnosticCode = typeof Codes[keyof typeof Codes]

const decodeLimits = Schema.decodeUnknownResult(XmlLimits, strictParseOptions)
const decodeSerializeOptions = Schema.decodeUnknownResult(SerializeOptions, strictParseOptions)
const decodeDocument = Schema.decodeUnknownResult(XmlDocument, strictParseOptions)

const exactDataRecord = (
  input: unknown,
  allowedKeys: ReadonlySet<string>,
  code: XmlDiagnosticCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>
): Result.Result<void, Diagnostic.CompilationError> => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return Result.fail(compilationError(error(code, message, path)))
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      return Result.fail(compilationError(error(code, message, path)))
    }
    const keys = Reflect.ownKeys(input)
    for (const key of keys) {
      if (typeof key !== "string" || !allowedKeys.has(key)) {
        return Result.fail(compilationError(error(
          code,
          `${message}: unexpected property '${typeof key === "string" ? key : "symbol"}'`,
          path
        )))
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined || "get" in descriptor || !descriptor.enumerable) {
        return Result.fail(compilationError(error(
          code,
          `${message}: property '${key}' must be an enumerable data property`,
          [...path, key]
        )))
      }
    }
    return Result.succeed(undefined)
  } catch {
    return Result.fail(compilationError(error(code, `${message}: value could not be inspected safely`, path)))
  }
}

const limitKeys = new Set([
  "maxDocumentCharacters",
  "maxDepth",
  "maxNodes",
  "maxAttributesPerElement",
  "maxNamespaceDeclarationsPerElement",
  "maxTextCharactersPerNode",
  "maxTotalTextCharacters",
  "maxNameCharacters"
])

const serializeOptionKeys = new Set(["format", "order", "indent", "newline", "limits"])

const preflightLimitsInput = (
  input: unknown,
  path: ReadonlyArray<Diagnostic.PathSegment>
): Result.Result<void, Diagnostic.CompilationError> => {
  if (input === undefined) {
    return Result.succeed(undefined)
  }
  const exact = exactDataRecord(input, limitKeys, Codes.InvalidOptions, "Invalid XML limits", path)
  if (Result.isFailure(exact)) {
    return exact
  }
  try {
    for (const key of limitKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input as object, key)
      if (descriptor !== undefined && typeof descriptor.value === "object" && descriptor.value !== null) {
        return Result.fail(compilationError(error(
          Codes.InvalidOptions,
          `XML limit '${key}' must be a scalar value`,
          [...path, key]
        )))
      }
    }
    return Result.succeed(undefined)
  } catch {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      "XML limits could not be inspected safely",
      path
    )))
  }
}

const preflightSerializeOptionsInput = (
  input: unknown
): Result.Result<void, Diagnostic.CompilationError> => {
  if (input === undefined) {
    return Result.succeed(undefined)
  }
  const exact = exactDataRecord(
    input,
    serializeOptionKeys,
    Codes.InvalidOptions,
    "Invalid XML serializer options",
    []
  )
  if (Result.isFailure(exact)) {
    return exact
  }
  try {
    for (const key of ["format", "order", "indent", "newline"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(input as object, key)
      if (descriptor !== undefined && typeof descriptor.value === "object" && descriptor.value !== null) {
        return Result.fail(compilationError(error(
          Codes.InvalidOptions,
          `XML serializer option '${key}' must be a scalar value`,
          [key]
        )))
      }
    }
    const limits = Object.getOwnPropertyDescriptor(input as object, "limits")
    return limits === undefined ? Result.succeed(undefined) : preflightLimitsInput(limits.value, ["limits"])
  } catch {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      "XML serializer options could not be inspected safely",
      []
    )))
  }
}

const resolveLimits = (
  input: unknown
): Result.Result<ResolvedXmlLimits, Diagnostic.CompilationError> => {
  if (input === undefined) {
    return Result.succeed(defaultXmlLimits)
  }
  const preflight = preflightLimitsInput(input, ["limits"])
  if (Result.isFailure(preflight)) {
    return Result.fail(preflight.failure)
  }
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      snapshot.failure.message,
      ["limits", ...snapshot.failure.path]
    )))
  }
  const decoded = decodeLimits(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      "Invalid XML limits",
      ["limits"],
      { issue: String(decoded.failure) }
    )))
  }
  const limits = snapshot.success as unknown as XmlLimits
  return Result.succeed(Object.freeze({
    maxDocumentCharacters: limits.maxDocumentCharacters ?? defaultXmlLimits.maxDocumentCharacters,
    maxDepth: limits.maxDepth ?? defaultXmlLimits.maxDepth,
    maxNodes: limits.maxNodes ?? defaultXmlLimits.maxNodes,
    maxAttributesPerElement: limits.maxAttributesPerElement ?? defaultXmlLimits.maxAttributesPerElement,
    maxNamespaceDeclarationsPerElement: limits.maxNamespaceDeclarationsPerElement ??
      defaultXmlLimits.maxNamespaceDeclarationsPerElement,
    maxTextCharactersPerNode: limits.maxTextCharactersPerNode ?? defaultXmlLimits.maxTextCharactersPerNode,
    maxTotalTextCharacters: limits.maxTotalTextCharacters ?? defaultXmlLimits.maxTotalTextCharacters,
    maxNameCharacters: limits.maxNameCharacters ?? defaultXmlLimits.maxNameCharacters
  }))
}

const resolveSerializeOptions = (
  input: unknown
): Result.Result<ResolvedSerializeOptions, Diagnostic.CompilationError> => {
  if (input === undefined) {
    return Result.succeed(Object.freeze({
      format: "compact",
      order: "preserve",
      indent: "  ",
      newline: "\n",
      limits: defaultXmlLimits
    }))
  }
  const preflight = preflightSerializeOptionsInput(input)
  if (Result.isFailure(preflight)) {
    return Result.fail(preflight.failure)
  }
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      snapshot.failure.message,
      snapshot.failure.path
    )))
  }
  const decoded = decodeSerializeOptions(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      "Invalid XML serializer options",
      [],
      { issue: String(decoded.failure) }
    )))
  }
  const options = snapshot.success as unknown as SerializeOptions
  const limits = resolveLimits(options.limits)
  if (Result.isFailure(limits)) {
    return Result.fail(limits.failure)
  }
  if (!/^[\t ]*$/.test(options.indent ?? "  ")) {
    return Result.fail(compilationError(error(
      Codes.InvalidOptions,
      "Pretty-print indentation may contain only spaces and tabs",
      ["indent"]
    )))
  }
  return Result.succeed(Object.freeze({
    format: options.format ?? "compact",
    order: options.order ?? "preserve",
    indent: options.indent ?? "  ",
    newline: options.newline ?? "\n",
    limits: limits.success
  }))
}

class ParseAbort extends Error {
  readonly diagnostic: Diagnostic.Diagnostic

  constructor(diagnostic: Diagnostic.Diagnostic) {
    super(diagnostic.message)
    this.diagnostic = diagnostic
  }
}

interface MutableSpan {
  start: SourcePosition
  end: SourcePosition
}

interface MutableElement {
  _tag: "Element"
  name: ExpandedName
  namespaceDeclarations: Array<NamespaceDeclaration>
  attributes: Array<XmlAttribute>
  children: Array<XmlNode>
  span: MutableSpan
}

interface ElementFrame {
  readonly element: MutableElement
  readonly path: ReadonlyArray<Diagnostic.PathSegment>
}

interface PendingAttribute {
  readonly name: string
  readonly prefix: string
  readonly local: string
  readonly value: string
  readonly span: SourceSpan
}

interface PendingTag {
  readonly path: ReadonlyArray<Diagnostic.PathSegment>
  readonly start: SourcePosition
  readonly attributes: Array<PendingAttribute>
  attributeCursor: number
  attributeCount: number
  namespaceCount: number
}

const lineStartOffsets = (input: string): ReadonlyArray<number> => {
  const output = [0]
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (code === 13) {
      if (input.charCodeAt(index + 1) === 10) {
        index++
      }
      output.push(index + 1)
    } else if (code === 10) {
      output.push(index + 1)
    }
  }
  return output
}

const sourcePosition = (
  input: string,
  starts: ReadonlyArray<number>,
  rawOffset: number
): SourcePosition => {
  const offset = Math.max(0, Math.min(input.length, rawOffset))
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle]! <= offset) {
      low = middle
    } else {
      high = middle
    }
  }
  const lineStart = starts[low]!
  return {
    offset,
    line: low + 1,
    column: offset - lineStart
  }
}

const sourceSpan = (
  input: string,
  starts: ReadonlyArray<number>,
  start: number,
  end: number
): SourceSpan => ({
  start: sourcePosition(input, starts, start),
  end: sourcePosition(input, starts, end)
})

const detailsAt = (
  input: string,
  starts: ReadonlyArray<number>,
  offset: number
): Schema.JsonObject => {
  const position = sourcePosition(input, starts, offset)
  return {
    offset: position.offset,
    line: position.line,
    column: position.column
  }
}

/**
 * Parses one complete XML document into a detached, recursively frozen infoset.
 *
 * **Details**
 *
 * Parsing is namespace-aware, rejects all DTDs, applies explicit resource
 * limits, and fails closed on the first syntax or policy error. It does not
 * validate BPMN elements or any XML Schema.
 *
 * @category parsing
 * @since 4.0.0
 */
export const parse = (
  input: unknown,
  limitsInput?: XmlLimits
): Result.Result<XmlDocument, Diagnostic.CompilationError> => {
  if (typeof input !== "string") {
    return Result.fail(compilationError(error(
      Codes.InvalidInput,
      "XML input must be a string",
      []
    )))
  }
  const resolvedLimits = resolveLimits(limitsInput)
  if (Result.isFailure(resolvedLimits)) {
    return Result.fail(resolvedLimits.failure)
  }
  const limits = resolvedLimits.success
  if (input.length > limits.maxDocumentCharacters) {
    return Result.fail(compilationError(error(
      Codes.DocumentLimitExceeded,
      `XML document exceeds ${limits.maxDocumentCharacters} characters`,
      [],
      { actual: input.length, maximum: limits.maxDocumentCharacters }
    )))
  }

  const starts = lineStartOffsets(input)
  const documentChildren: Array<XmlNode> = []
  const stack: Array<ElementFrame> = []
  let declaration: XmlDeclaration | undefined
  let pendingTag: PendingTag | undefined
  let cursorOffset = input.charCodeAt(0) === 0xfeff ? 1 : 0
  let nodeCount = 0
  let totalTextCharacters = 0
  let firstFailure: Diagnostic.Diagnostic | undefined

  const currentChildren = (): Array<XmlNode> =>
    stack.length === 0 ? documentChildren : stack[stack.length - 1]!.element.children

  const nextChildPath = (): ReadonlyArray<Diagnostic.PathSegment> => {
    const children = currentChildren()
    if (stack.length === 0) {
      return ["children", children.length]
    }
    return [...stack[stack.length - 1]!.path, "children", children.length]
  }

  const abort = (
    code: XmlDiagnosticCode,
    message: string,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    offset: number,
    details?: Schema.JsonObject
  ): never => {
    const diagnostic = error(
      code,
      message,
      path,
      details === undefined
        ? detailsAt(input, starts, offset)
        : { ...detailsAt(input, starts, offset), ...details }
    )
    firstFailure ??= diagnostic
    throw new ParseAbort(firstFailure)
  }

  const countNode = (
    path: ReadonlyArray<Diagnostic.PathSegment>,
    offset: number
  ): void => {
    nodeCount++
    if (nodeCount > limits.maxNodes) {
      abort(
        Codes.NodeLimitExceeded,
        `XML document exceeds ${limits.maxNodes} nodes`,
        path,
        offset,
        { actual: nodeCount, maximum: limits.maxNodes }
      )
    }
  }

  const countText = (
    value: string,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    offset: number,
    field: "body" | "value" = "value"
  ): void => {
    if (value.length > limits.maxTextCharactersPerNode) {
      abort(
        Codes.TextLimitExceeded,
        `XML text item exceeds ${limits.maxTextCharactersPerNode} characters`,
        [...path, field],
        offset,
        { actual: value.length, maximum: limits.maxTextCharactersPerNode }
      )
    }
    totalTextCharacters += value.length
    if (totalTextCharacters > limits.maxTotalTextCharacters) {
      abort(
        Codes.TextLimitExceeded,
        `XML document exceeds ${limits.maxTotalTextCharacters} text characters`,
        [...path, field],
        offset,
        { actual: totalTextCharacters, maximum: limits.maxTotalTextCharacters }
      )
    }
  }

  const appendNode = (
    node: XmlNode,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    offset: number
  ): void => {
    countNode(path, offset)
    currentChildren().push(node)
  }

  const appendText = (value: string, endOffset: number): void => {
    if (value.length === 0) {
      cursorOffset = endOffset
      return
    }
    const children = currentChildren()
    const previous = children[children.length - 1]
    const path = previous?._tag === "Text"
      ? [
        ...(stack.length === 0 ? [] : stack[stack.length - 1]!.path),
        "children",
        children.length - 1
      ]
      : nextChildPath()
    countText(value, path, cursorOffset)
    if (previous?._tag === "Text") {
      const mergedLength = previous.value.length + value.length
      if (mergedLength > limits.maxTextCharactersPerNode) {
        abort(
          Codes.TextLimitExceeded,
          `XML text item exceeds ${limits.maxTextCharactersPerNode} characters`,
          [
            ...(stack.length === 0 ? [] : stack[stack.length - 1]!.path),
            "children",
            children.length - 1,
            "value"
          ],
          cursorOffset,
          { actual: mergedLength, maximum: limits.maxTextCharactersPerNode }
        )
      }
      children[children.length - 1] = {
        ...previous,
        value: previous.value + value,
        span: {
          start: previous.span.start,
          end: sourcePosition(input, starts, endOffset)
        }
      }
    } else {
      appendNode(
        {
          _tag: "Text",
          value,
          span: sourceSpan(input, starts, cursorOffset, endOffset)
        },
        path,
        cursorOffset
      )
    }
    cursorOffset = endOffset
  }

  const appendWhitespaceBeforeMarkup = (markupOffset: number): void => {
    if (markupOffset <= cursorOffset) {
      return
    }
    const raw = input.slice(cursorOffset, markupOffset)
    for (let index = 0; index < raw.length; index++) {
      const code = raw.charCodeAt(index)
      if (code !== 9 && code !== 10 && code !== 13 && code !== 32) {
        abort(
          Codes.InvalidXml,
          "Unexpected content before XML markup",
          nextChildPath(),
          cursorOffset + index
        )
      }
    }
    appendText(raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), markupOffset)
  }

  const parser = new SaxesParser({
    xmlns: true,
    fragment: false,
    position: true
  })

  parser.on("error", (cause) => {
    abort(
      Codes.InvalidXml,
      "Malformed XML document",
      stack.length === 0 ? [] : stack[stack.length - 1]!.path,
      parser.position,
      { issue: cause.message }
    )
  })

  parser.on("doctype", () => {
    abort(
      Codes.DtdForbidden,
      "XML DTD and entity declarations are forbidden",
      [],
      parser.position
    )
  })

  parser.on("xmldecl", (value) => {
    const startOffset = cursorOffset
    const endOffset = parser.position
    if (value.version !== "1.0") {
      abort(
        Codes.InvalidXml,
        "Only XML 1.0 documents are supported",
        ["declaration", "version"],
        startOffset
      )
    }
    declaration = {
      version: "1.0",
      ...(value.encoding === undefined ? undefined : { encoding: value.encoding }),
      ...(value.standalone === undefined
        ? undefined
        : { standalone: value.standalone as "yes" | "no" }),
      span: sourceSpan(input, starts, startOffset, endOffset)
    }
    cursorOffset = endOffset
  })

  parser.on("opentagstart", (tag) => {
    const lastMarkupStart = input.lastIndexOf("<", Math.max(0, parser.position - 1))
    const startOffset = lastMarkupStart < 0
      ? Math.max(0, parser.position - tag.name.length - 2)
      : lastMarkupStart
    appendWhitespaceBeforeMarkup(startOffset)
    const path = nextChildPath()
    if (tag.name.length > limits.maxNameCharacters) {
      abort(
        Codes.NameLimitExceeded,
        `XML qualified name exceeds ${limits.maxNameCharacters} characters`,
        [...path, "name"],
        startOffset,
        { actual: tag.name.length, maximum: limits.maxNameCharacters }
      )
    }
    pendingTag = {
      path,
      start: sourcePosition(input, starts, startOffset),
      attributes: [],
      attributeCursor: parser.position,
      attributeCount: 0,
      namespaceCount: 0
    }
  })

  parser.on("attribute", (attribute) => {
    const pending = pendingTag
    if (pending === undefined) {
      return abort(Codes.InvalidXml, "XML attribute appeared outside an opening tag", [], parser.position)
    }
    let startOffset = pending.attributeCursor
    while (startOffset < parser.position) {
      const code = input.charCodeAt(startOffset)
      if (code !== 9 && code !== 10 && code !== 13 && code !== 32) {
        break
      }
      startOffset++
    }
    const endOffset = parser.position
    const isNamespace = attribute.name === "xmlns" || attribute.prefix === "xmlns"
    if (isNamespace) {
      pending.namespaceCount++
      if (pending.namespaceCount > limits.maxNamespaceDeclarationsPerElement) {
        abort(
          Codes.NamespaceLimitExceeded,
          `XML element exceeds ${limits.maxNamespaceDeclarationsPerElement} namespace declarations`,
          [...pending.path, "namespaceDeclarations", pending.namespaceCount - 1],
          startOffset,
          {
            actual: pending.namespaceCount,
            maximum: limits.maxNamespaceDeclarationsPerElement
          }
        )
      }
    } else {
      pending.attributeCount++
      if (pending.attributeCount > limits.maxAttributesPerElement) {
        abort(
          Codes.AttributeLimitExceeded,
          `XML element exceeds ${limits.maxAttributesPerElement} attributes`,
          [...pending.path, "attributes", pending.attributeCount - 1],
          startOffset,
          { actual: pending.attributeCount, maximum: limits.maxAttributesPerElement }
        )
      }
    }
    if (
      attribute.name.length > limits.maxNameCharacters ||
      attribute.local.length > limits.maxNameCharacters ||
      attribute.prefix.length > limits.maxNameCharacters
    ) {
      abort(
        Codes.NameLimitExceeded,
        `XML attribute name exceeds ${limits.maxNameCharacters} characters`,
        [
          ...pending.path,
          isNamespace ? "namespaceDeclarations" : "attributes",
          isNamespace ? pending.namespaceCount - 1 : pending.attributeCount - 1
        ],
        startOffset
      )
    }
    pending.attributes.push({
      name: attribute.name,
      prefix: attribute.prefix,
      local: attribute.local,
      value: attribute.value,
      span: sourceSpan(input, starts, startOffset, endOffset)
    })
    pending.attributeCursor = endOffset
  })

  parser.on("opentag", (tag) => {
    const pending = pendingTag
    if (pending === undefined) {
      return abort(Codes.InvalidXml, "XML opening tag has no pending tag state", [], parser.position)
    }
    const depth = stack.length + 1
    if (depth > limits.maxDepth) {
      abort(
        Codes.DepthLimitExceeded,
        `XML document exceeds depth ${limits.maxDepth}`,
        pending.path,
        pending.start.offset,
        { actual: depth, maximum: limits.maxDepth }
      )
    }
    const namespaceDeclarations: Array<NamespaceDeclaration> = []
    const attributes: Array<XmlAttribute> = []
    for (const attribute of pending.attributes) {
      if (attribute.name === "xmlns" || attribute.prefix === "xmlns") {
        namespaceDeclarations.push({
          prefix: attribute.name === "xmlns" ? "" : attribute.local,
          namespaceUri: attribute.value,
          span: attribute.span
        })
      } else {
        const resolved = tag.attributes[attribute.name]
        if (resolved === undefined) {
          abort(
            Codes.InvalidXml,
            `XML parser could not resolve attribute '${attribute.name}'`,
            [...pending.path, "attributes", attributes.length],
            attribute.span.start.offset
          )
        }
        attributes.push({
          name: {
            namespaceUri: resolved.uri,
            localName: resolved.local,
            prefix: resolved.prefix
          },
          value: resolved.value,
          span: attribute.span
        })
      }
    }
    const element: MutableElement = {
      _tag: "Element",
      name: {
        namespaceUri: tag.uri,
        localName: tag.local,
        prefix: tag.prefix
      },
      namespaceDeclarations,
      attributes,
      children: [],
      span: {
        start: pending.start,
        end: sourcePosition(input, starts, parser.position)
      }
    }
    appendNode(element as XmlElement, pending.path, pending.start.offset)
    stack.push({ element, path: pending.path })
    pendingTag = undefined
    cursorOffset = parser.position
  })

  parser.on("closetag", () => {
    const frame = stack.pop()
    if (frame === undefined) {
      return abort(Codes.InvalidXml, "XML closing tag has no open element", [], parser.position)
    }
    frame.element.span.end = sourcePosition(input, starts, parser.position)
    cursorOffset = parser.position
  })

  parser.on("text", (value) => {
    const endOffset = input.charCodeAt(parser.position - 1) === 60
      ? parser.position - 1
      : parser.position
    appendText(value, endOffset)
  })

  parser.on("cdata", (value) => {
    const markupOffset = input.indexOf("<![CDATA[", cursorOffset)
    if (markupOffset >= 0) {
      appendWhitespaceBeforeMarkup(markupOffset)
    }
    const path = nextChildPath()
    countText(value, path, cursorOffset)
    appendNode(
      {
        _tag: "CData",
        value,
        span: sourceSpan(input, starts, cursorOffset, parser.position)
      },
      path,
      cursorOffset
    )
    cursorOffset = parser.position
  })

  parser.on("comment", (value) => {
    const markupOffset = input.lastIndexOf("<!--", parser.position)
    if (markupOffset >= 0) {
      appendWhitespaceBeforeMarkup(markupOffset)
    }
    const path = nextChildPath()
    countText(value, path, cursorOffset)
    const endOffset = input.charCodeAt(parser.position) === 62
      ? parser.position + 1
      : parser.position
    appendNode(
      {
        _tag: "Comment",
        value,
        span: sourceSpan(input, starts, cursorOffset, endOffset)
      },
      path,
      cursorOffset
    )
    cursorOffset = endOffset
  })

  parser.on("processinginstruction", (value) => {
    const markupOffset = input.indexOf("<?", cursorOffset)
    if (markupOffset >= 0) {
      appendWhitespaceBeforeMarkup(markupOffset)
    }
    const path = nextChildPath()
    countText(value.body, path, cursorOffset, "body")
    if (value.target.length > limits.maxNameCharacters) {
      abort(
        Codes.NameLimitExceeded,
        `XML processing-instruction target exceeds ${limits.maxNameCharacters} characters`,
        [...path, "target"],
        cursorOffset,
        { actual: value.target.length, maximum: limits.maxNameCharacters }
      )
    }
    appendNode(
      {
        _tag: "ProcessingInstruction",
        target: value.target,
        body: value.body,
        span: sourceSpan(input, starts, cursorOffset, parser.position)
      },
      path,
      cursorOffset
    )
    cursorOffset = parser.position
  })

  try {
    parser.write(input).close()
  } catch (cause) {
    if (cause instanceof ParseAbort) {
      return Result.fail(compilationError(cause.diagnostic))
    }
    return Result.fail(compilationError(
      firstFailure ?? error(
        Codes.InvalidXml,
        "Malformed XML document",
        stack.length === 0 ? [] : stack[stack.length - 1]!.path,
        detailsAt(input, starts, parser.position)
      )
    ))
  }

  const document = {
    documentKind: "XmlInfoset",
    documentVersion: XmlInfosetVersion,
    ...(declaration === undefined ? undefined : { declaration }),
    children: documentChildren,
    span: sourceSpan(input, starts, 0, input.length)
  } satisfies XmlDocument
  return safelyValidateDocument(document, limits)
}

const qualifiedName = (name: ExpandedName): string =>
  name.prefix.length === 0 ? name.localName : `${name.prefix}:${name.localName}`

const qualifiedNameLength = (name: ExpandedName): number =>
  name.localName.length + (name.prefix.length === 0 ? 0 : name.prefix.length + 1)

const isXmlCharacterData = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index)
    if (first === 9 || first === 10 || first === 13 || first >= 0x20 && first <= 0xd7ff) {
      continue
    }
    if (first >= 0xe000 && first <= 0xfffd) {
      continue
    }
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        index++
        continue
      }
    }
    return false
  }
  return true
}

const isDocumentWhitespace = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code !== 9 && code !== 10 && code !== 32) {
      return false
    }
  }
  return true
}

const ncNameCache = new Map<string, boolean>()
const MaxCachedNcNames = 1_024

const isNcName = (value: string): boolean => {
  const cached = ncNameCache.get(value)
  if (cached !== undefined) {
    return cached
  }
  if (value.length === 0 || value.includes(":")) {
    return false
  }
  let valid = true
  let opened = false
  const parser = new SaxesParser({ xmlns: true, fragment: true })
  parser.on("error", () => {
    valid = false
    throw new Error("invalid NCName")
  })
  parser.on("opentag", (tag) => {
    if (opened || tag.name !== value) {
      valid = false
      throw new Error("invalid NCName")
    }
    opened = true
  })
  try {
    parser.write(`<${value}/>`).close()
  } catch {
    valid = false
  }
  valid &&= opened
  if (ncNameCache.size >= MaxCachedNcNames) {
    ncNameCache.clear()
  }
  ncNameCache.set(value, valid)
  return valid
}

const isProcessingInstructionTarget = (value: string): boolean => {
  return value.toLowerCase() !== "xml" && isNcName(value)
}

const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const compareExpandedNames = (left: XmlAttribute, right: XmlAttribute): number => {
  const uri = compareStrings(left.name.namespaceUri, right.name.namespaceUri)
  if (uri !== 0) {
    return uri
  }
  const local = compareStrings(left.name.localName, right.name.localName)
  return local !== 0 ? local : compareStrings(left.name.prefix, right.name.prefix)
}

const adjacentTextIndex = (nodes: ReadonlyArray<XmlNode>): number | undefined => {
  for (let index = 1; index < nodes.length; index++) {
    if (nodes[index - 1]!._tag === "Text" && nodes[index]!._tag === "Text") {
      return index
    }
  }
  return undefined
}

class PreflightAbort extends Error {
  readonly diagnostic: Diagnostic.Diagnostic

  constructor(diagnostic: Diagnostic.Diagnostic) {
    super(diagnostic.message)
    this.diagnostic = diagnostic
  }
}

const documentKeys = new Set(["documentKind", "documentVersion", "declaration", "children", "span"])
const declarationKeys = new Set(["version", "encoding", "standalone", "span"])
const elementKeys = new Set([
  "_tag",
  "name",
  "namespaceDeclarations",
  "attributes",
  "children",
  "span"
])
const valueNodeKeys = new Set(["_tag", "value", "span"])
const processingInstructionKeys = new Set(["_tag", "target", "body", "span"])
const expandedNameKeys = new Set(["namespaceUri", "localName", "prefix"])
const namespaceDeclarationKeys = new Set(["prefix", "namespaceUri", "span"])
const attributeKeys = new Set(["name", "value", "span"])
const spanKeys = new Set(["start", "end"])
const positionKeys = new Set(["offset", "line", "column"])

const preflightDocumentStructure = (
  input: unknown,
  limits: ResolvedXmlLimits
): Result.Result<void, Diagnostic.CompilationError> => {
  const abort = (
    code: XmlDiagnosticCode,
    message: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): never => {
    throw new PreflightAbort(error(code, message, path))
  }
  const dataProperty = (
    value: object,
    key: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || "get" in descriptor) {
      return abort(
        Codes.InvalidDocument,
        `XML infoset property '${key}' must be an own data property`,
        path
      )
    }
    return descriptor.value
  }
  const exactObject = (
    value: unknown,
    keys: ReadonlySet<string>,
    path: ReadonlyArray<Diagnostic.PathSegment>,
    message: string
  ): object => {
    const exact = exactDataRecord(value, keys, Codes.InvalidDocument, message, path)
    if (Result.isFailure(exact)) {
      throw new PreflightAbort(exact.failure.diagnostics[0]!)
    }
    return value as object
  }
  const scalarProperty = (
    value: object,
    key: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): unknown => {
    const child = dataProperty(value, key, path)
    if (child !== null && typeof child === "object") {
      return abort(
        Codes.InvalidDocument,
        `XML infoset scalar property '${key}' cannot contain an object graph`,
        path
      )
    }
    return child
  }
  const arrayLength = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): number => {
    if (!Array.isArray(value)) {
      return abort(Codes.InvalidDocument, "XML infoset collection must be an array", path)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (
      descriptor === undefined ||
      "get" in descriptor ||
      typeof descriptor.value !== "number" ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    ) {
      return abort(Codes.InvalidDocument, "XML infoset array has an invalid length", path)
    }
    return descriptor.value
  }
  const exactArray = (
    value: ReadonlyArray<unknown>,
    length: number,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1) {
      return abort(
        Codes.InvalidDocument,
        "XML infoset arrays must be dense and contain only indexed data properties",
        path
      )
    }
    for (const key of keys) {
      if (key === "length") {
        continue
      }
      if (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= length
      ) {
        return abort(
          Codes.InvalidDocument,
          "XML infoset arrays must be dense and contain only indexed data properties",
          path
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || "get" in descriptor || !descriptor.enumerable) {
        return abort(
          Codes.InvalidDocument,
          "XML infoset arrays must contain only enumerable indexed data properties",
          [...path, Number(key)]
        )
      }
    }
  }
  const indexedValue = (
    value: ReadonlyArray<unknown>,
    index: number,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): unknown => dataProperty(value, String(index), path)
  const inspectPosition = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const position = exactObject(value, positionKeys, path, "Invalid XML source position")
    scalarProperty(position, "offset", [...path, "offset"])
    scalarProperty(position, "line", [...path, "line"])
    scalarProperty(position, "column", [...path, "column"])
  }
  const inspectSpan = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const span = exactObject(value, spanKeys, path, "Invalid XML source span")
    inspectPosition(dataProperty(span, "start", [...path, "start"]), [...path, "start"])
    inspectPosition(dataProperty(span, "end", [...path, "end"]), [...path, "end"])
  }
  const inspectName = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const name = exactObject(value, expandedNameKeys, path, "Invalid expanded XML name")
    scalarProperty(name, "namespaceUri", [...path, "namespaceUri"])
    scalarProperty(name, "localName", [...path, "localName"])
    scalarProperty(name, "prefix", [...path, "prefix"])
  }
  const inspectDeclaration = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const declaration = exactObject(value, declarationKeys, path, "Invalid XML declaration")
    scalarProperty(declaration, "version", [...path, "version"])
    const encoding = Object.getOwnPropertyDescriptor(declaration, "encoding")
    if (encoding !== undefined) {
      scalarProperty(declaration, "encoding", [...path, "encoding"])
    }
    const standalone = Object.getOwnPropertyDescriptor(declaration, "standalone")
    if (standalone !== undefined) {
      scalarProperty(declaration, "standalone", [...path, "standalone"])
    }
    inspectSpan(dataProperty(declaration, "span", [...path, "span"]), [...path, "span"])
  }
  const inspectAttribute = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const attribute = exactObject(value, attributeKeys, path, "Invalid XML attribute")
    inspectName(dataProperty(attribute, "name", [...path, "name"]), [...path, "name"])
    scalarProperty(attribute, "value", [...path, "value"])
    inspectSpan(dataProperty(attribute, "span", [...path, "span"]), [...path, "span"])
  }
  const inspectNamespaceDeclaration = (
    value: unknown,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): void => {
    const declaration = exactObject(
      value,
      namespaceDeclarationKeys,
      path,
      "Invalid XML namespace declaration"
    )
    scalarProperty(declaration, "prefix", [...path, "prefix"])
    scalarProperty(declaration, "namespaceUri", [...path, "namespaceUri"])
    inspectSpan(dataProperty(declaration, "span", [...path, "span"]), [...path, "span"])
  }

  try {
    const document = exactObject(input, documentKeys, [], "Invalid XML infoset document")
    scalarProperty(document, "documentKind", ["documentKind"])
    scalarProperty(document, "documentVersion", ["documentVersion"])
    inspectSpan(dataProperty(document, "span", ["span"]), ["span"])
    const declaration = Object.getOwnPropertyDescriptor(document, "declaration")
    if (declaration !== undefined) {
      inspectDeclaration(declaration.value, ["declaration"])
    }
    const rootChildren = dataProperty(document, "children", ["children"])
    const rootLength = arrayLength(rootChildren, ["children"])
    if (rootLength > limits.maxNodes) {
      return Result.fail(compilationError(error(
        Codes.NodeLimitExceeded,
        `XML infoset exceeds ${limits.maxNodes} nodes`,
        ["children"]
      )))
    }
    exactArray(rootChildren as ReadonlyArray<unknown>, rootLength, ["children"])

    const tasks: Array<{
      readonly value: unknown
      readonly path: ReadonlyArray<Diagnostic.PathSegment>
      readonly depth: number
    }> = []
    for (let index = rootLength - 1; index >= 0; index--) {
      tasks.push({
        value: indexedValue(rootChildren as ReadonlyArray<unknown>, index, ["children", index]),
        path: ["children", index],
        depth: 1
      })
    }
    let scheduledNodes = rootLength
    let totalAttributes = 0
    let totalNamespaceDeclarations = 0

    while (tasks.length > 0) {
      const task = tasks.pop()!
      if (task.value === null || typeof task.value !== "object" || Array.isArray(task.value)) {
        return abort(Codes.InvalidDocument, "XML infoset node must be a plain object", task.path)
      }
      const tag = dataProperty(task.value, "_tag", [...task.path, "_tag"])
      if (tag !== "Element") {
        if (
          tag !== "Text" &&
          tag !== "CData" &&
          tag !== "Comment" &&
          tag !== "ProcessingInstruction"
        ) {
          return abort(Codes.InvalidDocument, "XML infoset node has an unknown tag", [...task.path, "_tag"])
        }
        const node = exactObject(
          task.value,
          tag === "ProcessingInstruction" ? processingInstructionKeys : valueNodeKeys,
          task.path,
          "Invalid XML infoset node"
        )
        scalarProperty(node, "_tag", [...task.path, "_tag"])
        if (tag === "ProcessingInstruction") {
          scalarProperty(node, "target", [...task.path, "target"])
          scalarProperty(node, "body", [...task.path, "body"])
        } else {
          scalarProperty(node, "value", [...task.path, "value"])
        }
        inspectSpan(dataProperty(node, "span", [...task.path, "span"]), [...task.path, "span"])
        continue
      }
      const element = exactObject(task.value, elementKeys, task.path, "Invalid XML element")
      scalarProperty(element, "_tag", [...task.path, "_tag"])
      inspectName(dataProperty(element, "name", [...task.path, "name"]), [...task.path, "name"])
      inspectSpan(dataProperty(element, "span", [...task.path, "span"]), [...task.path, "span"])
      if (task.depth > limits.maxDepth) {
        return abort(
          Codes.DepthLimitExceeded,
          `XML infoset exceeds depth ${limits.maxDepth}`,
          task.path
        )
      }
      const attributes = dataProperty(element, "attributes", [...task.path, "attributes"])
      const attributeLength = arrayLength(attributes, [...task.path, "attributes"])
      if (attributeLength > limits.maxAttributesPerElement) {
        return abort(
          Codes.AttributeLimitExceeded,
          `XML element exceeds ${limits.maxAttributesPerElement} attributes`,
          [...task.path, "attributes"]
        )
      }
      exactArray(
        attributes as ReadonlyArray<unknown>,
        attributeLength,
        [...task.path, "attributes"]
      )
      for (let index = 0; index < attributeLength; index++) {
        inspectAttribute(
          indexedValue(
            attributes as ReadonlyArray<unknown>,
            index,
            [...task.path, "attributes", index]
          ),
          [...task.path, "attributes", index]
        )
      }
      totalAttributes += attributeLength
      if (totalAttributes > limits.maxDocumentCharacters) {
        return abort(
          Codes.DocumentLimitExceeded,
          "XML infoset attribute count cannot fit within the serialized document bound",
          [...task.path, "attributes"]
        )
      }

      const declarations = dataProperty(
        element,
        "namespaceDeclarations",
        [...task.path, "namespaceDeclarations"]
      )
      const declarationLength = arrayLength(declarations, [...task.path, "namespaceDeclarations"])
      if (declarationLength > limits.maxNamespaceDeclarationsPerElement) {
        return abort(
          Codes.NamespaceLimitExceeded,
          `XML element exceeds ${limits.maxNamespaceDeclarationsPerElement} namespace declarations`,
          [...task.path, "namespaceDeclarations"]
        )
      }
      exactArray(
        declarations as ReadonlyArray<unknown>,
        declarationLength,
        [...task.path, "namespaceDeclarations"]
      )
      for (let index = 0; index < declarationLength; index++) {
        inspectNamespaceDeclaration(
          indexedValue(
            declarations as ReadonlyArray<unknown>,
            index,
            [...task.path, "namespaceDeclarations", index]
          ),
          [...task.path, "namespaceDeclarations", index]
        )
      }
      totalNamespaceDeclarations += declarationLength
      if (totalNamespaceDeclarations > limits.maxDocumentCharacters) {
        return abort(
          Codes.DocumentLimitExceeded,
          "XML infoset namespace count cannot fit within the serialized document bound",
          [...task.path, "namespaceDeclarations"]
        )
      }

      const children = dataProperty(element, "children", [...task.path, "children"])
      const childLength = arrayLength(children, [...task.path, "children"])
      if (scheduledNodes + childLength > limits.maxNodes) {
        return abort(
          Codes.NodeLimitExceeded,
          `XML infoset exceeds ${limits.maxNodes} nodes`,
          [...task.path, "children"]
        )
      }
      scheduledNodes += childLength
      exactArray(children as ReadonlyArray<unknown>, childLength, [...task.path, "children"])
      for (let index = childLength - 1; index >= 0; index--) {
        tasks.push({
          value: indexedValue(
            children as ReadonlyArray<unknown>,
            index,
            [...task.path, "children", index]
          ),
          path: [...task.path, "children", index],
          depth: task.depth + 1
        })
      }
    }
    return Result.succeed(undefined)
  } catch (cause) {
    if (cause instanceof PreflightAbort) {
      return Result.fail(compilationError(cause.diagnostic))
    }
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML infoset could not be inspected safely",
      []
    )))
  }
}

const saturated = (value: number): number => Number.isSafeInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER

const orderedPosition = (left: SourcePosition, right: SourcePosition): boolean =>
  left.offset <= right.offset &&
  left.line <= right.line &&
  (left.line !== right.line || left.column <= right.column)

const orderedSpan = (span: SourceSpan): boolean => orderedPosition(span.start, span.end)

const containsSpan = (parent: SourceSpan, child: SourceSpan): boolean =>
  orderedPosition(parent.start, child.start) && orderedPosition(child.end, parent.end)

const spansInSourceOrder = (
  spans: ReadonlyArray<SourceSpan>
): boolean => {
  for (let index = 1; index < spans.length; index++) {
    if (!orderedPosition(spans[index - 1]!.end, spans[index]!.start)) {
      return false
    }
  }
  return true
}

const spanStartsInSourceOrder = (
  spans: ReadonlyArray<SourceSpan>
): boolean => {
  for (let index = 1; index < spans.length; index++) {
    if (!orderedPosition(spans[index - 1]!.start, spans[index]!.start)) {
      return false
    }
  }
  return true
}

const validateDocumentForSerialization = (
  input: unknown,
  limits: ResolvedXmlLimits
): Result.Result<XmlDocument, Diagnostic.CompilationError> => {
  const preflight = preflightDocumentStructure(input, limits)
  if (Result.isFailure(preflight)) {
    return Result.fail(preflight.failure)
  }
  const snapshot = Json.snapshot(input, {
    maxArrayLength: Math.max(
      limits.maxNodes,
      limits.maxAttributesPerElement,
      limits.maxNamespaceDeclarationsPerElement,
      16
    ),
    maxContainers: saturated(limits.maxDocumentCharacters * 8 + 64),
    maxDepth: limits.maxDepth * 2 + 8,
    maxEntries: saturated(limits.maxDocumentCharacters * 16 + 128)
  })
  if (Result.isFailure(snapshot)) {
    const bounded = snapshot.failure.message.includes("exceeds")
    return Result.fail(compilationError(error(
      bounded ? Codes.DocumentLimitExceeded : Codes.InvalidDocument,
      snapshot.failure.message,
      snapshot.failure.path
    )))
  }

  const raw = snapshot.success
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const root = raw as Schema.JsonObject
    const children = root.children
    if (Array.isArray(children)) {
      let rawNodeCount = 0
      const tasks: Array<readonly [Schema.Json, number, ReadonlyArray<Diagnostic.PathSegment>]> = []
      for (let index = children.length - 1; index >= 0; index--) {
        tasks.push([children[index]!, 1, ["children", index]])
      }
      while (tasks.length > 0) {
        const [node, depth, path] = tasks.pop()!
        rawNodeCount++
        if (rawNodeCount > limits.maxNodes) {
          return Result.fail(compilationError(error(
            Codes.NodeLimitExceeded,
            `XML infoset exceeds ${limits.maxNodes} nodes`,
            path
          )))
        }
        if (
          node !== null &&
          typeof node === "object" &&
          !Array.isArray(node) &&
          (node as Schema.JsonObject)._tag === "Element" &&
          depth > limits.maxDepth
        ) {
          return Result.fail(compilationError(error(
            Codes.DepthLimitExceeded,
            `XML infoset exceeds depth ${limits.maxDepth}`,
            path
          )))
        }
        if (node !== null && typeof node === "object" && !Array.isArray(node)) {
          const nested = (node as Schema.JsonObject).children
          if (Array.isArray(nested)) {
            for (let index = nested.length - 1; index >= 0; index--) {
              tasks.push([nested[index]!, depth + 1, [...path, "children", index]])
            }
          }
        }
      }
    }
  }

  const decoded = decodeDocument(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "Invalid XML infoset document",
      [],
      { issue: String(decoded.failure) }
    )))
  }
  const document = snapshot.success as unknown as XmlDocument
  if (!orderedSpan(document.span)) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML document source span is not ordered",
      ["span"]
    )))
  }
  if (document.declaration !== undefined && !orderedSpan(document.declaration.span)) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML declaration source span is not ordered",
      ["declaration", "span"]
    )))
  }
  if (
    document.declaration !== undefined &&
    !containsSpan(document.span, document.declaration.span)
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML declaration source span must be contained by the document span",
      ["declaration", "span"]
    )))
  }
  for (let index = 0; index < document.children.length; index++) {
    if (!containsSpan(document.span, document.children[index]!.span)) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "XML document child source span must be contained by the document span",
        ["children", index, "span"]
      )))
    }
  }
  if (!spansInSourceOrder(document.children.map((node) => node.span))) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML document child source spans must follow lexical child order",
      ["children"]
    )))
  }
  if (
    document.declaration !== undefined &&
    document.children.length > 0 &&
    !orderedPosition(document.declaration.span.end, document.children[0]!.span.start)
  ) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML declaration source span must precede document children",
      ["declaration", "span"]
    )))
  }
  const rootElements = document.children.filter((node) => node._tag === "Element")
  if (rootElements.length !== 1) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML document must contain exactly one root element",
      ["children"]
    )))
  }
  const adjacentDocumentText = adjacentTextIndex(document.children)
  if (adjacentDocumentText !== undefined) {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "Adjacent XML text nodes are not independently representable",
      ["children", adjacentDocumentText]
    )))
  }

  let nodeCount = 0
  let totalTextCharacters = 0
  const tasks: Array<{
    readonly node: XmlNode
    readonly path: ReadonlyArray<Diagnostic.PathSegment>
    readonly depth: number
    readonly namespaces: ReadonlyMap<string, string>
    readonly outsideRoot: boolean
  }> = []
  for (let index = document.children.length - 1; index >= 0; index--) {
    const node = document.children[index]!
    const outsideRoot = node._tag !== "Element"
    tasks.push({
      node,
      path: ["children", index],
      depth: node._tag === "Element" ? 1 : 0,
      namespaces: new Map([["xml", XmlNamespaceUri]]),
      outsideRoot
    })
  }

  while (tasks.length > 0) {
    const task = tasks.pop()!
    const { node, path } = task
    nodeCount++
    if (nodeCount > limits.maxNodes) {
      return Result.fail(compilationError(error(
        Codes.NodeLimitExceeded,
        `XML infoset exceeds ${limits.maxNodes} nodes`,
        path
      )))
    }
    if (node._tag === "Element" && task.depth > limits.maxDepth) {
      return Result.fail(compilationError(error(
        Codes.DepthLimitExceeded,
        `XML infoset exceeds depth ${limits.maxDepth}`,
        path
      )))
    }
    if (!orderedSpan(node.span)) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "XML node source span is not ordered",
        [...path, "span"]
      )))
    }

    if (node._tag !== "Element") {
      const value = node._tag === "ProcessingInstruction" ? node.body : node.value
      if (value.length > limits.maxTextCharactersPerNode) {
        return Result.fail(compilationError(error(
          Codes.TextLimitExceeded,
          `XML text item exceeds ${limits.maxTextCharactersPerNode} characters`,
          [...path, node._tag === "ProcessingInstruction" ? "body" : "value"]
        )))
      }
      totalTextCharacters += value.length
      if (totalTextCharacters > limits.maxTotalTextCharacters) {
        return Result.fail(compilationError(error(
          Codes.TextLimitExceeded,
          `XML infoset exceeds ${limits.maxTotalTextCharacters} text characters`,
          path
        )))
      }
      if (!isXmlCharacterData(value)) {
        return Result.fail(compilationError(error(
          Codes.InvalidCharacter,
          "XML content contains a forbidden character",
          [...path, node._tag === "ProcessingInstruction" ? "body" : "value"]
        )))
      }
      if (task.outsideRoot) {
        if (node._tag === "CData" || node._tag === "Text" && !isDocumentWhitespace(node.value)) {
          return Result.fail(compilationError(error(
            Codes.InvalidDocument,
            "Only spaces, tabs, line feeds, comments, and processing instructions may surround the root element",
            path
          )))
        }
      }
      if (node._tag === "Text" && node.value.length === 0) {
        return Result.fail(compilationError(error(
          Codes.InvalidDocument,
          "Empty text nodes are not representable in an XML infoset",
          [...path, "value"]
        )))
      }
      if (node._tag === "CData" && (node.value.includes("]]>") || node.value.includes("\r"))) {
        return Result.fail(compilationError(error(
          Codes.InvalidCharacter,
          "CDATA cannot contain ']]>' or carriage returns",
          [...path, "value"]
        )))
      }
      if (
        node._tag === "Comment" &&
        (node.value.includes("--") || node.value.endsWith("-") || node.value.includes("\r"))
      ) {
        return Result.fail(compilationError(error(
          Codes.InvalidCharacter,
          "XML comments cannot contain '--', end with '-', or contain carriage returns",
          [...path, "value"]
        )))
      }
      if (node._tag === "ProcessingInstruction") {
        if (node.target.length > limits.maxNameCharacters) {
          return Result.fail(compilationError(error(
            Codes.NameLimitExceeded,
            `XML processing-instruction target exceeds ${limits.maxNameCharacters} characters`,
            [...path, "target"]
          )))
        }
        if (!isProcessingInstructionTarget(node.target)) {
          return Result.fail(compilationError(error(
            Codes.InvalidName,
            `Invalid XML processing-instruction target '${node.target}'`,
            [...path, "target"]
          )))
        }
        if (node.body.includes("?>") || node.body.includes("\r")) {
          return Result.fail(compilationError(error(
            Codes.InvalidCharacter,
            "XML processing-instruction bodies cannot contain '?>' or carriage returns",
            [...path, "body"]
          )))
        }
        if (node.body.length > 0) {
          const first = node.body.charCodeAt(0)
          if (first === 9 || first === 10 || first === 32) {
            return Result.fail(compilationError(error(
              Codes.InvalidDocument,
              "XML processing-instruction bodies cannot begin with whitespace",
              [...path, "body"]
            )))
          }
        }
      }
      continue
    }

    const elementNameLength = qualifiedNameLength(node.name)
    if (elementNameLength > limits.maxNameCharacters) {
      return Result.fail(compilationError(error(
        Codes.NameLimitExceeded,
        `XML qualified name exceeds ${limits.maxNameCharacters} characters`,
        [...path, "name"]
      )))
    }
    if (
      !isNcName(node.name.localName) ||
      node.name.prefix.length > 0 && !isNcName(node.name.prefix) ||
      node.name.prefix === "xmlns"
    ) {
      return Result.fail(compilationError(error(
        Codes.InvalidName,
        `Invalid XML element name '${qualifiedName(node.name)}'`,
        [...path, "name"]
      )))
    }
    if (node.namespaceDeclarations.length > limits.maxNamespaceDeclarationsPerElement) {
      return Result.fail(compilationError(error(
        Codes.NamespaceLimitExceeded,
        `XML element exceeds ${limits.maxNamespaceDeclarationsPerElement} namespace declarations`,
        [...path, "namespaceDeclarations"]
      )))
    }
    if (node.attributes.length > limits.maxAttributesPerElement) {
      return Result.fail(compilationError(error(
        Codes.AttributeLimitExceeded,
        `XML element exceeds ${limits.maxAttributesPerElement} attributes`,
        [...path, "attributes"]
      )))
    }
    const adjacentElementText = adjacentTextIndex(node.children)
    if (adjacentElementText !== undefined) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "Adjacent XML text nodes are not independently representable",
        [...path, "children", adjacentElementText]
      )))
    }
    for (let index = 0; index < node.children.length; index++) {
      if (!containsSpan(node.span, node.children[index]!.span)) {
        return Result.fail(compilationError(error(
          Codes.InvalidDocument,
          "XML element child source span must be contained by its parent element span",
          [...path, "children", index, "span"]
        )))
      }
    }
    if (!spansInSourceOrder(node.children.map((child) => child.span))) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "XML element child source spans must follow lexical child order",
        [...path, "children"]
      )))
    }
    for (let index = 0; index < node.namespaceDeclarations.length; index++) {
      if (!containsSpan(node.span, node.namespaceDeclarations[index]!.span)) {
        return Result.fail(compilationError(error(
          Codes.InvalidDocument,
          "XML namespace declaration span must be contained by its element span",
          [...path, "namespaceDeclarations", index, "span"]
        )))
      }
    }
    for (let index = 0; index < node.attributes.length; index++) {
      if (!containsSpan(node.span, node.attributes[index]!.span)) {
        return Result.fail(compilationError(error(
          Codes.InvalidDocument,
          "XML attribute span must be contained by its element span",
          [...path, "attributes", index, "span"]
        )))
      }
    }
    const namespaces = new Map(task.namespaces)
    const declaredPrefixes = new Set<string>()
    for (let index = 0; index < node.namespaceDeclarations.length; index++) {
      const declaration = node.namespaceDeclarations[index]!
      const declarationPath = [...path, "namespaceDeclarations", index]
      if (!orderedSpan(declaration.span)) {
        return Result.fail(compilationError(error(
          Codes.InvalidDocument,
          "XML namespace declaration source span is not ordered",
          [...declarationPath, "span"]
        )))
      }
      const declarationNameLength = declaration.prefix.length === 0
        ? "xmlns".length
        : "xmlns:".length + declaration.prefix.length
      if (declarationNameLength > limits.maxNameCharacters) {
        return Result.fail(compilationError(error(
          Codes.NameLimitExceeded,
          `XML namespace declaration name exceeds ${limits.maxNameCharacters} characters`,
          [...declarationPath, "prefix"]
        )))
      }
      if (
        declaration.prefix.length > 0 && !isNcName(declaration.prefix) ||
        declaredPrefixes.has(declaration.prefix)
      ) {
        return Result.fail(compilationError(error(
          declaration.prefix.length > 0 && !isNcName(declaration.prefix)
            ? Codes.InvalidName
            : Codes.InvalidNamespaceBinding,
          declaredPrefixes.has(declaration.prefix)
            ? `Duplicate namespace declaration for prefix '${declaration.prefix}'`
            : `Invalid namespace prefix '${declaration.prefix}'`,
          [...declarationPath, "prefix"]
        )))
      }
      declaredPrefixes.add(declaration.prefix)
      if (!isXmlCharacterData(declaration.namespaceUri)) {
        return Result.fail(compilationError(error(
          Codes.InvalidCharacter,
          "XML namespace URI contains a forbidden character",
          [...declarationPath, "namespaceUri"]
        )))
      }
      if (
        declaration.prefix === "xmlns" ||
        declaration.namespaceUri === XmlnsNamespaceUri ||
        declaration.prefix.length > 0 && declaration.namespaceUri.length === 0 ||
        declaration.prefix === "xml" && declaration.namespaceUri !== XmlNamespaceUri ||
        declaration.prefix !== "xml" && declaration.namespaceUri === XmlNamespaceUri
      ) {
        return Result.fail(compilationError(error(
          Codes.InvalidNamespaceBinding,
          `Invalid XML namespace binding for prefix '${declaration.prefix}'`,
          declarationPath
        )))
      }
      namespaces.set(declaration.prefix, declaration.namespaceUri)
    }
    if (!spanStartsInSourceOrder(node.namespaceDeclarations.map((declaration) => declaration.span))) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "XML namespace declaration spans must follow lexical declaration order",
        [...path, "namespaceDeclarations"]
      )))
    }

    const elementNamespace = node.name.prefix.length === 0
      ? namespaces.get("") ?? ""
      : namespaces.get(node.name.prefix)
    if (elementNamespace === undefined || elementNamespace !== node.name.namespaceUri) {
      return Result.fail(compilationError(error(
        Codes.InvalidNamespaceBinding,
        `Element prefix '${node.name.prefix}' is not bound to the requested namespace URI`,
        [...path, "name"]
      )))
    }

    const expandedAttributes = new Set<string>()
    for (let index = 0; index < node.attributes.length; index++) {
      const attribute = node.attributes[index]!
      const attributePath = [...path, "attributes", index]
      if (!orderedSpan(attribute.span)) {
        return Result.fail(compilationError(error(
          Codes.InvalidDocument,
          "XML attribute source span is not ordered",
          [...attributePath, "span"]
        )))
      }
      const attributeNameLength = qualifiedNameLength(attribute.name)
      if (attributeNameLength > limits.maxNameCharacters) {
        return Result.fail(compilationError(error(
          Codes.NameLimitExceeded,
          `XML attribute name exceeds ${limits.maxNameCharacters} characters`,
          [...attributePath, "name"]
        )))
      }
      if (
        !isNcName(attribute.name.localName) ||
        attribute.name.prefix.length > 0 && !isNcName(attribute.name.prefix) ||
        attribute.name.prefix === "xmlns" ||
        attribute.name.prefix.length === 0 && attribute.name.localName === "xmlns"
      ) {
        return Result.fail(compilationError(error(
          Codes.InvalidName,
          `Invalid XML attribute name '${qualifiedName(attribute.name)}'`,
          [...attributePath, "name"]
        )))
      }
      if (!isXmlCharacterData(attribute.value)) {
        return Result.fail(compilationError(error(
          Codes.InvalidCharacter,
          "XML attribute contains a forbidden character",
          [...attributePath, "value"]
        )))
      }
      const attributeNamespace = attribute.name.prefix.length === 0
        ? ""
        : namespaces.get(attribute.name.prefix)
      if (attributeNamespace === undefined || attributeNamespace !== attribute.name.namespaceUri) {
        return Result.fail(compilationError(error(
          Codes.InvalidNamespaceBinding,
          `Attribute prefix '${attribute.name.prefix}' is not bound to the requested namespace URI`,
          [...attributePath, "name"]
        )))
      }
      const expanded = `${attribute.name.namespaceUri}\u0000${attribute.name.localName}`
      if (expandedAttributes.has(expanded)) {
        return Result.fail(compilationError(error(
          Codes.DuplicateAttribute,
          `Duplicate expanded XML attribute '${attribute.name.localName}'`,
          attributePath
        )))
      }
      expandedAttributes.add(expanded)
    }
    if (!spanStartsInSourceOrder(node.attributes.map((attribute) => attribute.span))) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "XML attribute spans must follow lexical attribute order",
        [...path, "attributes"]
      )))
    }

    for (let index = node.children.length - 1; index >= 0; index--) {
      tasks.push({
        node: node.children[index]!,
        path: [...path, "children", index],
        depth: task.depth + 1,
        namespaces,
        outsideRoot: false
      })
    }
  }

  if (document.declaration?.encoding !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(document.declaration.encoding)) {
      return Result.fail(compilationError(error(
        Codes.InvalidName,
        "Invalid XML encoding name",
        ["declaration", "encoding"]
      )))
    }
  }
  return Result.succeed(document)
}

const safelyValidateDocument = (
  input: unknown,
  limits: ResolvedXmlLimits
): Result.Result<XmlDocument, Diagnostic.CompilationError> => {
  try {
    return validateDocumentForSerialization(input, limits)
  } catch {
    return Result.fail(compilationError(error(
      Codes.InvalidDocument,
      "XML infoset validation failed within the supported resource ceiling",
      []
    )))
  }
}

/**
 * Validates and snapshots an unknown XML infoset without serializing it.
 *
 * **Details**
 *
 * Unlike the structural {@link XmlDocument} codec, this operation enforces
 * document grammar, namespace bindings, XML lexical constraints, ordered
 * and hierarchically contained source spans, and caller-selected resource
 * bounds. The document-character bound is measured using deterministic compact
 * preserve-order serialization. The hard
 * {@link MaximumXmlDepth} ceiling cannot be raised.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown,
  limitsInput?: XmlLimits
): Result.Result<XmlDocument, Diagnostic.CompilationError> => {
  const limits = resolveLimits(limitsInput)
  if (Result.isFailure(limits)) {
    return Result.fail(limits.failure)
  }
  const validated = safelyValidateDocument(input, limits.success)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const measuredLength = measureDocument(validated.success, {
    format: "compact",
    order: "preserve",
    indent: "  ",
    newline: "\n",
    limits: limits.success
  })
  if (measuredLength === undefined) {
    return Result.fail(compilationError(error(
      Codes.DocumentLimitExceeded,
      `Serialized XML exceeds ${limits.success.maxDocumentCharacters} characters`,
      [],
      { maximum: limits.success.maxDocumentCharacters }
    )))
  }
  return validated
}

const escapeText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;")

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\r", "&#xD;")

const measureEscaped = (
  value: string,
  attribute: boolean,
  maximum: number
): number | undefined => {
  let output = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const width = code === 38
      ? 5
      : code === 60 || !attribute && code === 62
      ? 4
      : attribute && code === 34
      ? 6
      : code === 13 || attribute && (code === 9 || code === 10)
      ? 5
      : 1
    if (width > maximum - output) {
      return undefined
    }
    output += width
  }
  return output
}

const measureNode = (
  node: XmlNode,
  depth: number,
  options: ResolvedSerializeOptions,
  maximum: number
): number | undefined => {
  let total = 0
  const add = (length: number | undefined): boolean => {
    if (length === undefined || length > maximum - total) {
      return false
    }
    total += length
    return true
  }
  const addIndent = (repetitions: number): boolean => {
    const width = options.indent.length
    if (width === 0) {
      return true
    }
    const remaining = maximum - total
    if (repetitions > Math.floor(remaining / width)) {
      return false
    }
    total += repetitions * width
    return true
  }

  switch (node._tag) {
    case "Text":
      return measureEscaped(node.value, false, maximum)
    case "CData":
      return add("<![CDATA[".length) && add(node.value.length) && add("]]>".length)
        ? total
        : undefined
    case "Comment":
      return add("<!--".length) && add(node.value.length) && add("-->".length)
        ? total
        : undefined
    case "ProcessingInstruction":
      return add("<?".length) &&
          add(node.target.length) &&
          (node.body.length === 0 || add(1) && add(node.body.length)) &&
          add("?>".length)
        ? total
        : undefined
    case "Element": {
      if (!add(1) || !add(qualifiedNameLength(node.name))) {
        return undefined
      }
      for (const declaration of node.namespaceDeclarations) {
        if (
          !add(declaration.prefix.length === 0 ? ` xmlns="`.length : ` xmlns:`.length) ||
          declaration.prefix.length > 0 && (!add(declaration.prefix.length) || !add(`="`.length)) ||
          !add(measureEscaped(declaration.namespaceUri, true, maximum - total)) ||
          !add(1)
        ) {
          return undefined
        }
      }
      for (const attribute of node.attributes) {
        if (
          !add(1) ||
          !add(qualifiedNameLength(attribute.name)) ||
          !add(`="`.length) ||
          !add(measureEscaped(attribute.value, true, maximum - total)) ||
          !add(1)
        ) {
          return undefined
        }
      }
      if (node.children.length === 0) {
        return add("/>".length) ? total : undefined
      }
      if (!add(1)) {
        return undefined
      }

      const pretty = options.format === "pretty" &&
        !node.children.some((child) => child._tag === "Text" || child._tag === "CData")
      if (pretty) {
        if (!add(options.newline.length)) {
          return undefined
        }
        for (let index = 0; index < node.children.length; index++) {
          if (
            index > 0 && !add(options.newline.length) ||
            !addIndent(depth + 1) ||
            !add(measureNode(node.children[index]!, depth + 1, options, maximum - total))
          ) {
            return undefined
          }
        }
        if (!add(options.newline.length) || !addIndent(depth)) {
          return undefined
        }
      } else {
        for (const child of node.children) {
          if (!add(measureNode(child, depth + 1, options, maximum - total))) {
            return undefined
          }
        }
      }
      return add("</".length) && add(qualifiedNameLength(node.name)) && add(1)
        ? total
        : undefined
    }
  }
}

const measureDocument = (
  document: XmlDocument,
  options: ResolvedSerializeOptions
): number | undefined => {
  const maximum = options.limits.maxDocumentCharacters
  let total = 0
  const add = (length: number | undefined): boolean => {
    if (length === undefined || length > maximum - total) {
      return false
    }
    total += length
    return true
  }
  if (document.declaration !== undefined) {
    const declaration = document.declaration
    if (
      !add(`<?xml version="`.length) ||
      !add(declaration.version.length) ||
      !add(1) ||
      declaration.encoding !== undefined &&
        (!add(` encoding="`.length) || !add(declaration.encoding.length) || !add(1)) ||
      declaration.standalone !== undefined &&
        (!add(` standalone="`.length) || !add(declaration.standalone.length) || !add(1)) ||
      !add("?>".length)
    ) {
      return undefined
    }
  }
  if (
    options.format === "pretty" &&
    total > 0 &&
    document.children.length > 0 &&
    !add(options.newline.length)
  ) {
    return undefined
  }
  for (let index = 0; index < document.children.length; index++) {
    if (
      !add(measureNode(document.children[index]!, 0, options, maximum - total)) ||
      options.format === "pretty" &&
        index < document.children.length - 1 &&
        !add(options.newline.length)
    ) {
      return undefined
    }
  }
  return total
}

const serializeNode = (
  node: XmlNode,
  depth: number,
  options: ResolvedSerializeOptions
): string => {
  switch (node._tag) {
    case "Text":
      return escapeText(node.value)
    case "CData":
      return `<![CDATA[${node.value}]]>`
    case "Comment":
      return `<!--${node.value}-->`
    case "ProcessingInstruction":
      return `<?${node.target}${node.body.length === 0 ? "" : ` ${node.body}`}?>`
    case "Element": {
      const namespaceDeclarations = options.order === "canonical"
        ? [...node.namespaceDeclarations].sort((left, right) => compareStrings(left.prefix, right.prefix))
        : node.namespaceDeclarations
      const attributes = options.order === "canonical"
        ? [...node.attributes].sort(compareExpandedNames)
        : node.attributes
      const start = [`<${qualifiedName(node.name)}`]
      for (const declaration of namespaceDeclarations) {
        start.push(
          declaration.prefix.length === 0
            ? ` xmlns="${escapeAttribute(declaration.namespaceUri)}"`
            : ` xmlns:${declaration.prefix}="${escapeAttribute(declaration.namespaceUri)}"`
        )
      }
      for (const attribute of attributes) {
        start.push(` ${qualifiedName(attribute.name)}="${escapeAttribute(attribute.value)}"`)
      }
      if (node.children.length === 0) {
        start.push("/>")
        return start.join("")
      }
      start.push(">")

      const hasCharacterContent = node.children.some((child) => child._tag === "Text" || child._tag === "CData")
      if (options.format === "pretty" && !hasCharacterContent) {
        const indentation = options.indent.repeat(depth + 1)
        const children = node.children
          .map((child) => `${indentation}${serializeNode(child, depth + 1, options)}`)
          .join(options.newline)
        return `${start.join("")}${options.newline}${children}${options.newline}${options.indent.repeat(depth)}</${
          qualifiedName(node.name)
        }>`
      }
      return `${start.join("")}${node.children.map((child) => serializeNode(child, depth + 1, options)).join("")}</${
        qualifiedName(node.name)
      }>`
    }
  }
}

/**
 * Deterministically serializes a validated XML infoset document.
 *
 * **Details**
 *
 * The caller's input is first snapshotted without invoking accessors. Namespace
 * bindings, names, duplicate expanded attributes, XML characters, document
 * shape, and resource limits are validated before output is produced.
 *
 * @category serialization
 * @since 4.0.0
 */
export const serialize = (
  input: unknown,
  optionsInput?: SerializeOptions
): Result.Result<string, Diagnostic.CompilationError> => {
  const resolvedOptions = resolveSerializeOptions(optionsInput)
  if (Result.isFailure(resolvedOptions)) {
    return Result.fail(resolvedOptions.failure)
  }
  const options = resolvedOptions.success
  const validated = safelyValidateDocument(input, options.limits)
  if (Result.isFailure(validated)) {
    return Result.fail(validated.failure)
  }
  const document = validated.success
  const measuredLength = measureDocument(document, options)
  if (measuredLength === undefined) {
    return Result.fail(compilationError(error(
      Codes.DocumentLimitExceeded,
      `Serialized XML exceeds ${options.limits.maxDocumentCharacters} characters`,
      [],
      { maximum: options.limits.maxDocumentCharacters }
    )))
  }
  try {
    const output: Array<string> = []
    if (document.declaration !== undefined) {
      const declaration = document.declaration
      output.push(
        `<?xml version="${declaration.version}"${
          declaration.encoding === undefined ? "" : ` encoding="${declaration.encoding}"`
        }${declaration.standalone === undefined ? "" : ` standalone="${declaration.standalone}"`}?>`
      )
    }
    if (options.format === "pretty" && output.length > 0 && document.children.length > 0) {
      output.push(options.newline)
    }
    for (let index = 0; index < document.children.length; index++) {
      const node = document.children[index]!
      output.push(serializeNode(node, 0, options))
      if (options.format === "pretty" && index < document.children.length - 1) {
        output.push(options.newline)
      }
    }
    const serialized = output.join("")
    if (
      serialized.length !== measuredLength ||
      serialized.length > options.limits.maxDocumentCharacters
    ) {
      return Result.fail(compilationError(error(
        Codes.DocumentLimitExceeded,
        `Serialized XML exceeds ${options.limits.maxDocumentCharacters} characters`,
        [],
        { actual: serialized.length, maximum: options.limits.maxDocumentCharacters }
      )))
    }
    return Result.succeed(serialized)
  } catch (cause) {
    if (!(cause instanceof RangeError)) {
      return Result.fail(compilationError(error(
        Codes.InvalidDocument,
        "XML serialization failed within the supported resource ceiling",
        []
      )))
    }
    return Result.fail(compilationError(error(
      Codes.DocumentLimitExceeded,
      "Serialized XML exceeds the runtime string-size limit",
      [],
      { maximum: options.limits.maxDocumentCharacters }
    )))
  }
}
