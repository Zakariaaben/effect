/**
 * Portable BPMN 2.0.2 Diagram Interchange foundations.
 *
 * **Details**
 *
 * This module defines a strict JSON representation of the BPMNDI, DI, and DC
 * concepts needed to preserve BPMN diagram geometry and presentation
 * references. It is not an XML infoset, an XSD validator, or a BPMN
 * interchange-conformance claim.
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
const Finite = Schema.Finite

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

const sortDiagnostics = (
  diagnostics: Array<Diagnostic.Diagnostic>
): Array<Diagnostic.Diagnostic> =>
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
 * A finite two-dimensional point from the OMG Diagram Common model.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Point = Schema.Struct({
  x: Finite,
  y: Finite
}).annotate({
  identifier: "WorkflowBpmnDiPoint",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Point}.
 *
 * @category models
 * @since 4.0.0
 */
export type Point = Schema.Schema.Type<typeof Point>

const Waypoints = Schema.Array(Point).check(Schema.isMinLength(2))

/**
 * Rectangular diagram bounds from the OMG Diagram Common model.
 *
 * **Details**
 *
 * `DC.xsd` uses unrestricted XML Schema doubles for all four attributes.
 * {@link validate} separately rejects negative dimensions as invalid diagram
 * geometry while this schema can still represent the normative XSD domain.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Bounds = Schema.Struct({
  x: Finite,
  y: Finite,
  width: Finite,
  height: Finite
}).annotate({
  identifier: "WorkflowBpmnDiBounds",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Bounds}.
 *
 * @category models
 * @since 4.0.0
 */
export type Bounds = Schema.Schema.Type<typeof Bounds>

/**
 * Diagram Common font presentation metadata for a BPMN label style.
 *
 * **Details**
 *
 * The fields correspond to the optional attributes of `dc:Font` in the
 * normative BPMN 2.0.2 `DC.xsd`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Font = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Finite),
  isBold: Schema.optionalKey(Schema.Boolean),
  isItalic: Schema.optionalKey(Schema.Boolean),
  isUnderline: Schema.optionalKey(Schema.Boolean),
  isStrikeThrough: Schema.optionalKey(Schema.Boolean)
}).annotate({
  identifier: "WorkflowBpmnDiFont",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Font}.
 *
 * @category models
 * @since 4.0.0
 */
export type Font = Schema.Schema.Type<typeof Font>

/**
 * Optional bounds and label-style reference for one BPMN diagram label.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Label = Schema.Struct({
  id: Schema.optionalKey(Identifier),
  bounds: Schema.optionalKey(Bounds),
  styleRef: Schema.optionalKey(Identifier),
  extensions: Schema.Array(BpmnModel.ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnDiLabel",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Label}.
 *
 * @category models
 * @since 4.0.0
 */
export type Label = Schema.Schema.Type<typeof Label>

/**
 * A named BPMN label style backed by Diagram Common font metadata.
 *
 * @category schemas
 * @since 4.0.0
 */
export const LabelStyle = Schema.Struct({
  id: Schema.optionalKey(Identifier),
  font: Font
}).annotate({
  identifier: "WorkflowBpmnDiLabelStyle",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link LabelStyle}.
 *
 * @category models
 * @since 4.0.0
 */
export type LabelStyle = Schema.Schema.Type<typeof LabelStyle>

/**
 * BPMN participant-band positions defined by BPMNDI.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ParticipantBandKind = Schema.Literals([
  "top_initiating",
  "middle_initiating",
  "bottom_initiating",
  "top_non_initiating",
  "middle_non_initiating",
  "bottom_non_initiating"
]).annotate({ identifier: "WorkflowBpmnDiParticipantBandKind" })

/**
 * The decoded type of {@link ParticipantBandKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type ParticipantBandKind = Schema.Schema.Type<typeof ParticipantBandKind>

/**
 * BPMN message-visibility kinds defined by BPMNDI.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessageVisibleKind = Schema.Literals([
  "initiating",
  "non_initiating"
]).annotate({ identifier: "WorkflowBpmnDiMessageVisibleKind" })

/**
 * The decoded type of {@link MessageVisibleKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type MessageVisibleKind = Schema.Schema.Type<typeof MessageVisibleKind>

/**
 * A BPMN diagram shape and its geometry.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Shape = Schema.TaggedStruct("Shape", {
  id: Schema.optionalKey(Identifier),
  bpmnElementId: Schema.optionalKey(Identifier),
  bounds: Bounds,
  label: Schema.optionalKey(Label),
  isHorizontal: Schema.optionalKey(Schema.Boolean),
  isExpanded: Schema.optionalKey(Schema.Boolean),
  isMarkerVisible: Schema.optionalKey(Schema.Boolean),
  isMessageVisible: Schema.optionalKey(Schema.Boolean),
  participantBandKind: Schema.optionalKey(ParticipantBandKind),
  choreographyActivityShapeId: Schema.optionalKey(Identifier),
  extensions: Schema.Array(BpmnModel.ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnDiShape",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Shape}.
 *
 * @category models
 * @since 4.0.0
 */
export type Shape = Schema.Schema.Type<typeof Shape>

/**
 * A BPMN diagram edge with at least two waypoints.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Edge = Schema.TaggedStruct("Edge", {
  id: Schema.optionalKey(Identifier),
  bpmnElementId: Schema.optionalKey(Identifier),
  sourceElementId: Schema.optionalKey(Identifier),
  targetElementId: Schema.optionalKey(Identifier),
  messageVisibleKind: Schema.optionalKey(MessageVisibleKind),
  waypoints: Waypoints,
  label: Schema.optionalKey(Label),
  extensions: Schema.Array(BpmnModel.ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnDiEdge",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Edge}.
 *
 * @category models
 * @since 4.0.0
 */
export type Edge = Schema.Schema.Type<typeof Edge>

/**
 * A shape or edge contained by a BPMN plane.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DiagramElement = Schema.Union([Shape, Edge]).annotate({
  identifier: "WorkflowBpmnDiDiagramElement"
})

/**
 * The decoded type of {@link DiagramElement}.
 *
 * @category models
 * @since 4.0.0
 */
export type DiagramElement = Schema.Schema.Type<typeof DiagramElement>

/**
 * A BPMN plane containing ordered shape and edge diagram elements.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Plane = Schema.Struct({
  id: Schema.optionalKey(Identifier),
  bpmnElementId: Schema.optionalKey(Identifier),
  diagramElements: Schema.Array(DiagramElement),
  extensions: Schema.Array(BpmnModel.ExtensionElement)
}).annotate({
  identifier: "WorkflowBpmnDiPlane",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Plane}.
 *
 * @category models
 * @since 4.0.0
 */
export type Plane = Schema.Schema.Type<typeof Plane>

/**
 * One BPMN diagram, its plane, and its label styles.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Diagram = Schema.Struct({
  id: Schema.optionalKey(Identifier),
  name: Schema.optionalKey(Schema.String),
  documentation: Schema.optionalKey(Schema.String),
  resolution: Schema.optionalKey(Finite),
  plane: Plane,
  labelStyles: Schema.Array(LabelStyle)
}).annotate({
  identifier: "WorkflowBpmnDiDiagram",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Diagram}.
 *
 * @category models
 * @since 4.0.0
 */
export type Diagram = Schema.Schema.Type<typeof Diagram>

/**
 * Version of the portable BPMN Diagram Interchange document.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnDiDocumentVersion = 1 as const

/**
 * A versioned collection of BPMN 2.0.2 diagrams.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BpmnDiDocument = Schema.Struct({
  documentKind: Schema.Literal("BpmnDiDocument"),
  documentVersion: Schema.Literal(BpmnDiDocumentVersion),
  bpmnSpecVersion: Schema.Literal("2.0.2"),
  diagrams: Schema.Array(Diagram)
}).annotate({
  identifier: "WorkflowBpmnDiDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link BpmnDiDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type BpmnDiDocument = Schema.Schema.Type<typeof BpmnDiDocument>

const decodeDocument = Schema.decodeUnknownResult(BpmnDiDocument, strictParseOptions)

/**
 * Stable BPMN Diagram Interchange validation codes.
 *
 * @category errors
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "InvalidJson",
  InvalidDocument: "InvalidDocument",
  DuplicateId: "DuplicateId",
  UnknownSemanticElementRef: "UnknownSemanticElementRef",
  UnknownLabelStyleRef: "UnknownLabelStyleRef",
  UnknownDiagramElementRef: "UnknownDiagramElementRef",
  UnknownChoreographyActivityShapeRef: "UnknownChoreographyActivityShapeRef",
  InvalidChoreographyActivityShapeRef: "InvalidChoreographyActivityShapeRef",
  InvalidBounds: "InvalidBounds",
  InvalidResolution: "InvalidResolution",
  DuplicateSemanticVisualization: "DuplicateSemanticVisualization"
} as const

/**
 * A stable BPMN Diagram Interchange validation code.
 *
 * @category errors
 * @since 4.0.0
 */
export type BpmnDiCode = typeof Codes[keyof typeof Codes]

const diError = (
  code: BpmnDiCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

const validateSemanticElementRef = (
  semanticElementIds: ReadonlySet<string>,
  diagnostics: Array<Diagnostic.Diagnostic>,
  id: string | undefined,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): void => {
  if (id !== undefined && !semanticElementIds.has(id)) {
    diagnostics.push(diError(
      Codes.UnknownSemanticElementRef,
      `${owner} references unknown BPMN semantic element '${id}'`,
      path
    ))
  }
}

const validateLabel = (
  label: Label | undefined,
  labelStyleIds: ReadonlySet<string>,
  diagnostics: Array<Diagnostic.Diagnostic>,
  path: ReadonlyArray<Diagnostic.PathSegment>
): void => {
  if (label?.styleRef !== undefined && !labelStyleIds.has(label.styleRef)) {
    diagnostics.push(diError(
      Codes.UnknownLabelStyleRef,
      `Label references unknown BPMN label style '${label.styleRef}'`,
      [...path, "styleRef"]
    ))
  }
}

const validateBounds = (
  bounds: Bounds | undefined,
  diagnostics: Array<Diagnostic.Diagnostic>,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  owner: string
): void => {
  if (bounds !== undefined && (bounds.width < 0 || bounds.height < 0)) {
    diagnostics.push(diError(
      Codes.InvalidBounds,
      `${owner} bounds must have nonnegative width and height`,
      path,
      { width: bounds.width, height: bounds.height }
    ))
  }
}

/**
 * Snapshots, strictly decodes, and semantically validates BPMN diagram data.
 *
 * **Details**
 *
 * The caller's document is first detached through descriptor-based JSON
 * snapshotting, so accessors and hostile proxies are rejected without invoking
 * getters. Semantic validation checks DI identity, diagram references, BPMN
 * semantic references, positive diagram resolution, and duplicate semantic
 * visualization within a plane. This function does not perform XML Schema
 * validation.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  input: unknown,
  semanticElementIds: ReadonlySet<string>
): Result.Result<BpmnDiDocument, Diagnostic.CompilationError> => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    return Result.fail(compilationError(
      diError(
        Codes.InvalidJson,
        snapshot.failure.message,
        snapshot.failure.path
      )
    ))
  }

  const decoded = decodeDocument(snapshot.success)
  if (Result.isFailure(decoded)) {
    return Result.fail(compilationError(
      diError(
        Codes.InvalidDocument,
        "Invalid BPMN Diagram Interchange document",
        [],
        { issue: String(decoded.failure) }
      )
    ))
  }

  const document = snapshot.success as unknown as BpmnDiDocument
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const ids = new Map<string, ReadonlyArray<Diagnostic.PathSegment>>()
  const diagramElementIds = new Set<string>()
  const shapeIds = new Set<string>()
  const labelStyleIds = new Set<string>()

  const registerId = (
    id: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): boolean => {
    const previous = ids.get(id)
    if (previous !== undefined) {
      diagnostics.push(diError(
        Codes.DuplicateId,
        `Duplicate BPMN DI id '${id}'`,
        path,
        { firstPath: previous }
      ))
      return false
    }
    ids.set(id, path)
    return true
  }

  for (let diagramIndex = 0; diagramIndex < document.diagrams.length; diagramIndex++) {
    const diagram = document.diagrams[diagramIndex]!
    const diagramPath = ["diagrams", diagramIndex] as const
    if (diagram.id !== undefined) {
      registerId(diagram.id, [...diagramPath, "id"])
    }
    for (let styleIndex = 0; styleIndex < diagram.labelStyles.length; styleIndex++) {
      const style = diagram.labelStyles[styleIndex]!
      if (
        style.id !== undefined &&
        registerId(style.id, [...diagramPath, "labelStyles", styleIndex, "id"])
      ) {
        labelStyleIds.add(style.id)
      }
    }

    const planePath = [...diagramPath, "plane"] as const
    if (
      diagram.plane.id !== undefined &&
      registerId(diagram.plane.id, [...planePath, "id"])
    ) {
      diagramElementIds.add(diagram.plane.id)
    }

    for (
      let elementIndex = 0;
      elementIndex < diagram.plane.diagramElements.length;
      elementIndex++
    ) {
      const element = diagram.plane.diagramElements[elementIndex]!
      const elementPath = [...planePath, "diagramElements", elementIndex] as const
      if (
        element.id !== undefined &&
        registerId(element.id, [...elementPath, "id"])
      ) {
        diagramElementIds.add(element.id)
        if (element._tag === "Shape") {
          shapeIds.add(element.id)
        }
      }
      if (
        element.label?.id !== undefined &&
        registerId(element.label.id, [...elementPath, "label", "id"])
      ) {
        diagramElementIds.add(element.label.id)
      }
    }
  }

  for (let diagramIndex = 0; diagramIndex < document.diagrams.length; diagramIndex++) {
    const diagram = document.diagrams[diagramIndex]!
    const diagramPath = ["diagrams", diagramIndex] as const
    const planePath = [...diagramPath, "plane"] as const

    if (diagram.resolution !== undefined && diagram.resolution <= 0) {
      diagnostics.push(diError(
        Codes.InvalidResolution,
        `BPMN diagram resolution must be positive, received '${diagram.resolution}'`,
        [...diagramPath, "resolution"]
      ))
    }

    validateSemanticElementRef(
      semanticElementIds,
      diagnostics,
      diagram.plane.bpmnElementId,
      [...planePath, "bpmnElementId"],
      `BPMN plane '${diagram.plane.id ?? `#${diagramIndex}`}'`
    )

    const semanticVisualizations = new Map<
      string,
      ReadonlyArray<Diagnostic.PathSegment>
    >()

    for (
      let elementIndex = 0;
      elementIndex < diagram.plane.diagramElements.length;
      elementIndex++
    ) {
      const element = diagram.plane.diagramElements[elementIndex]!
      const elementPath = [...planePath, "diagramElements", elementIndex] as const
      validateSemanticElementRef(
        semanticElementIds,
        diagnostics,
        element.bpmnElementId,
        [...elementPath, "bpmnElementId"],
        `BPMN DI ${element._tag.toLowerCase()} '${element.id ?? `#${elementIndex}`}'`
      )

      if (element.bpmnElementId !== undefined) {
        const previous = semanticVisualizations.get(element.bpmnElementId)
        if (previous !== undefined) {
          diagnostics.push(diError(
            Codes.DuplicateSemanticVisualization,
            `BPMN semantic element '${element.bpmnElementId}' is visualized more than once in plane '${
              diagram.plane.id ?? `#${diagramIndex}`
            }'`,
            [...elementPath, "bpmnElementId"],
            { firstPath: previous }
          ))
        } else {
          semanticVisualizations.set(
            element.bpmnElementId,
            [...elementPath, "bpmnElementId"]
          )
        }
      }

      validateLabel(
        element.label,
        labelStyleIds,
        diagnostics,
        [...elementPath, "label"]
      )
      validateBounds(
        element.label?.bounds,
        diagnostics,
        [...elementPath, "label", "bounds"],
        `BPMN label on ${element._tag.toLowerCase()} '${element.id ?? `#${elementIndex}`}'`
      )

      if (element._tag === "Shape") {
        validateBounds(
          element.bounds,
          diagnostics,
          [...elementPath, "bounds"],
          `BPMN shape '${element.id ?? `#${elementIndex}`}'`
        )
        const choreographyRef = element.choreographyActivityShapeId
        if (
          choreographyRef !== undefined &&
          !diagramElementIds.has(choreographyRef)
        ) {
          diagnostics.push(diError(
            Codes.UnknownChoreographyActivityShapeRef,
            `BPMN shape '${
              element.id ?? `#${elementIndex}`
            }' references unknown choreography activity shape '${choreographyRef}'`,
            [...elementPath, "choreographyActivityShapeId"]
          ))
        } else if (
          choreographyRef !== undefined &&
          !shapeIds.has(choreographyRef)
        ) {
          diagnostics.push(diError(
            Codes.InvalidChoreographyActivityShapeRef,
            `BPMN shape '${
              element.id ?? `#${elementIndex}`
            }' choreography activity reference '${choreographyRef}' does not identify a shape`,
            [...elementPath, "choreographyActivityShapeId"]
          ))
        }
        continue
      }

      const edgeRefs = [
        ["sourceElementId", element.sourceElementId],
        ["targetElementId", element.targetElementId]
      ] as const
      for (const [field, ref] of edgeRefs) {
        if (ref !== undefined && !diagramElementIds.has(ref)) {
          diagnostics.push(diError(
            Codes.UnknownDiagramElementRef,
            `BPMN edge '${element.id ?? `#${elementIndex}`}' references unknown diagram element '${ref}'`,
            [...elementPath, field]
          ))
        }
      }
    }
  }

  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }
  return Result.succeed(document)
}
