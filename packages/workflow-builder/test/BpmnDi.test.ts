import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnDi from "../src/BpmnDi.ts"

const semanticIds = new Set([
  "process-orders",
  "task-accept",
  "task-ship",
  "flow-accept-ship"
])

const validDocument = (): BpmnDi.BpmnDiDocument => ({
  documentKind: "BpmnDiDocument",
  documentVersion: BpmnDi.BpmnDiDocumentVersion,
  bpmnSpecVersion: "2.0.2",
  diagrams: [{
    id: "diagram-orders",
    name: "Orders",
    documentation: "Order handling diagram",
    resolution: 96,
    plane: {
      id: "plane-orders",
      bpmnElementId: "process-orders",
      diagramElements: [
        {
          _tag: "Shape",
          id: "shape-accept",
          bpmnElementId: "task-accept",
          bounds: { x: -20, y: 10, width: 120, height: 80 },
          label: {
            bounds: { x: 0, y: 92, width: 100, height: 20 },
            styleRef: "style-default",
            extensions: []
          },
          isHorizontal: true,
          isExpanded: false,
          isMarkerVisible: true,
          isMessageVisible: false,
          extensions: []
        },
        {
          _tag: "Shape",
          id: "shape-ship",
          bpmnElementId: "task-ship",
          bounds: { x: 200, y: 10, width: 120, height: 80 },
          participantBandKind: "top_non_initiating",
          choreographyActivityShapeId: "shape-accept",
          extensions: []
        },
        {
          _tag: "Edge",
          id: "edge-accept-ship",
          bpmnElementId: "flow-accept-ship",
          sourceElementId: "shape-accept",
          targetElementId: "shape-ship",
          messageVisibleKind: "initiating",
          waypoints: [
            { x: 100, y: 50 },
            { x: 200, y: 50 }
          ],
          label: { styleRef: "style-default", extensions: [] },
          extensions: []
        }
      ],
      extensions: []
    },
    labelStyles: [{
      id: "style-default",
      font: {
        name: "Inter",
        size: 12,
        isBold: true,
        isItalic: false,
        isUnderline: false,
        isStrikeThrough: false
      }
    }]
  }]
})

const failureCodes = (
  result: Result.Result<BpmnDi.BpmnDiDocument, unknown>
): ReadonlySet<string> => {
  if (Result.isSuccess(result)) {
    throw new Error("expected validation failure")
  }
  const error = result.failure as {
    readonly diagnostics: ReadonlyArray<{ readonly code: string }>
  }
  return new Set(error.diagnostics.map((diagnostic) => diagnostic.code))
}

describe("BpmnDi", () => {
  it("admits and freezes a strict BPMN Diagram Interchange document", () => {
    const document = validDocument()
    const decoded = Schema.decodeUnknownSync(BpmnDi.BpmnDiDocument)(document)
    const result = BpmnDi.validate(document, semanticIds)

    assert.deepStrictEqual(decoded, document)
    assert.isTrue(Result.isSuccess(result))
    if (Result.isFailure(result)) {
      throw result.failure
    }
    assert.isTrue(Object.isFrozen(result.success))
    assert.isTrue(Object.isFrozen(result.success.diagrams))
    assert.isTrue(
      Object.isFrozen(result.success.diagrams[0]!.plane.diagramElements[0])
    )
  })

  it("reports dangling semantic, style, diagram-element, and choreography references", () => {
    const document = validDocument()
    const diagram = document.diagrams[0]!
    const first = diagram.plane.diagramElements[0]!
    const second = diagram.plane.diagramElements[1]!
    const edge = diagram.plane.diagramElements[2]!
    if (first._tag !== "Shape" || second._tag !== "Shape" || edge._tag !== "Edge") {
      throw new Error("expected seeded diagram elements")
    }

    diagram.plane.bpmnElementId = "missing-process"
    first.bpmnElementId = "missing-task"
    first.label = { styleRef: "missing-style", extensions: [] }
    second.choreographyActivityShapeId = "missing-shape"
    edge.bpmnElementId = "missing-flow"
    edge.sourceElementId = "missing-source"
    edge.targetElementId = "missing-target"

    const result = BpmnDi.validate(document, semanticIds)

    assert.deepStrictEqual(
      failureCodes(result),
      new Set([
        BpmnDi.Codes.UnknownSemanticElementRef,
        BpmnDi.Codes.UnknownLabelStyleRef,
        BpmnDi.Codes.UnknownDiagramElementRef,
        BpmnDi.Codes.UnknownChoreographyActivityShapeRef
      ])
    )
  })

  it("diagnoses globally duplicate DI ids and duplicate semantic visualization in one plane", () => {
    const document = validDocument()
    const elements = document.diagrams[0]!.plane.diagramElements
    const second = elements[1]!
    const edge = elements[2]!

    edge.id = second.id
    edge.bpmnElementId = second.bpmnElementId

    const result = BpmnDi.validate(document, semanticIds)

    assert.deepStrictEqual(
      failureCodes(result),
      new Set([
        BpmnDi.Codes.DuplicateId,
        BpmnDi.Codes.DuplicateSemanticVisualization
      ])
    )
  })

  it("requires choreography activity references to identify shapes", () => {
    const document = validDocument()
    const elements = document.diagrams[0]!.plane.diagramElements
    const second = elements[1]!
    const edge = elements[2]!
    if (second._tag !== "Shape" || edge._tag !== "Edge") {
      throw new Error("expected seeded diagram elements")
    }
    second.choreographyActivityShapeId = edge.id

    assert.deepStrictEqual(
      failureCodes(BpmnDi.validate(document, semanticIds)),
      new Set([BpmnDi.Codes.InvalidChoreographyActivityShapeRef])
    )
  })

  it("rejects hostile getters and proxies without invoking an accessor", () => {
    let getterCalls = 0
    const getterInput = { documentKind: "BpmnDiDocument" } as Record<
      string,
      unknown
    >
    Object.defineProperty(getterInput, "documentVersion", {
      enumerable: true,
      get: () => {
        getterCalls++
        return 1
      }
    })
    const proxyInput = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile")
      }
    })

    const getterResult = BpmnDi.validate(getterInput, semanticIds)
    const proxyResult = BpmnDi.validate(proxyInput, semanticIds)

    assert.strictEqual(getterCalls, 0)
    assert.deepStrictEqual(
      failureCodes(getterResult),
      new Set([BpmnDi.Codes.InvalidJson])
    )
    assert.deepStrictEqual(
      failureCodes(proxyResult),
      new Set([BpmnDi.Codes.InvalidJson])
    )
  })

  it("strictly rejects excess document and nested shape properties", () => {
    const document = validDocument() as unknown as Record<string, unknown>
    document["extra"] = true
    const shape = validDocument().diagrams[0]!.plane.diagramElements[0]!

    assert.throws(() => Schema.decodeUnknownSync(BpmnDi.BpmnDiDocument)(document))
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnDi.Shape)({
        ...shape,
        extra: true
      })
    )
    assert.deepStrictEqual(
      failureCodes(BpmnDi.validate(document, semanticIds)),
      new Set([BpmnDi.Codes.InvalidDocument])
    )
  })

  it("rejects negative bounds semantically and malformed waypoint or coordinate schemas", () => {
    const invalidBounds = validDocument()
    const boundsShape = invalidBounds.diagrams[0]!.plane.diagramElements[0]!
    if (boundsShape._tag !== "Shape") {
      throw new Error("expected seeded shape")
    }
    boundsShape.bounds.width = -1

    const invalidWaypoints = validDocument()
    const shortEdge = invalidWaypoints.diagrams[0]!.plane.diagramElements[2]!
    if (shortEdge._tag !== "Edge") {
      throw new Error("expected seeded edge")
    }
    shortEdge.waypoints.splice(1)

    assert.deepStrictEqual(
      Schema.decodeUnknownSync(BpmnDi.Bounds)({
        x: 0,
        y: 0,
        width: -1,
        height: 10
      }),
      { x: 0, y: 0, width: -1, height: 10 }
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnDi.Edge)({
        _tag: "Edge",
        id: "edge-short",
        waypoints: [{ x: 0, y: 0 }],
        extensions: []
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnDi.Point)({
        x: Number.POSITIVE_INFINITY,
        y: 0
      })
    )
    assert.deepStrictEqual(
      failureCodes(BpmnDi.validate(invalidBounds, semanticIds)),
      new Set([BpmnDi.Codes.InvalidBounds])
    )
    assert.deepStrictEqual(
      failureCodes(BpmnDi.validate(invalidWaypoints, semanticIds)),
      new Set([BpmnDi.Codes.InvalidDocument])
    )
  })

  it("preserves the optional IDs allowed by the normative DI schemas", () => {
    const document = validDocument()
    const diagram = document.diagrams[0]!
    const shape = diagram.plane.diagramElements[0]!
    const secondShape = diagram.plane.diagramElements[1]!
    const edge = diagram.plane.diagramElements[2]!

    delete diagram.plane.id
    delete shape.id
    delete shape.label?.id
    delete edge.id
    delete diagram.labelStyles[0]!.id
    if (shape._tag !== "Shape" || secondShape._tag !== "Shape" || edge._tag !== "Edge") {
      throw new Error("expected seeded shapes and edge")
    }
    delete secondShape.choreographyActivityShapeId
    delete shape.label?.styleRef
    delete edge.sourceElementId
    delete edge.targetElementId
    delete edge.label?.styleRef

    const result = BpmnDi.validate(document, semanticIds)

    assert(Result.isSuccess(result))
  })

  it("semantically rejects non-positive diagram resolution", () => {
    const zero = validDocument()
    const negative = validDocument()
    zero.diagrams[0]!.resolution = 0
    negative.diagrams[0]!.resolution = -1

    assert.deepStrictEqual(
      failureCodes(BpmnDi.validate(zero, semanticIds)),
      new Set([BpmnDi.Codes.InvalidResolution])
    )
    assert.deepStrictEqual(
      failureCodes(BpmnDi.validate(negative, semanticIds)),
      new Set([BpmnDi.Codes.InvalidResolution])
    )
  })
})
