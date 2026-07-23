import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as BpmnXml from "../src/BpmnXml.ts"
import * as BpmnXmlAst from "../src/BpmnXmlAst.ts"

const modelNamespace = "http://www.omg.org/spec/BPMN/20100524/MODEL"
const bpmnDiNamespace = "http://www.omg.org/spec/BPMN/20100524/DI"
const diNamespace = "http://www.omg.org/spec/DD/20100524/DI"
const dcNamespace = "http://www.omg.org/spec/DD/20100524/DC"
const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance"

const options: BpmnXml.ImportOptions = {
  importId: "import_1",
  locator: "memory://orders.bpmn",
  expressionLanguageBindings: [{
    language: "urn:expression:rules",
    version: "3.2.1"
  }]
}

const success = <A>(result: Result.Result<A, unknown>): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failureCodes = (result: Result.Result<unknown, unknown>): ReadonlySet<string> => {
  if (Result.isSuccess(result)) {
    throw new Error("expected failure")
  }
  const failure = result.failure as {
    readonly diagnostics: ReadonlyArray<{ readonly code: string }>
  }
  return new Set(failure.diagnostics.map((diagnostic) => diagnostic.code))
}

const xml = (
  prefixes: {
    readonly model: string
    readonly bpmnDi: string
    readonly di: string
    readonly dc: string
    readonly xsi: string
    readonly target: string
  } = {
    model: "semantic",
    bpmnDi: "visual",
    di: "route",
    dc: "geometry",
    xsi: "schemaInstance",
    target: "domain"
  }
): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<${prefixes.model}:definitions
  xmlns:${prefixes.model}="${modelNamespace}"
  xmlns:${prefixes.bpmnDi}="${bpmnDiNamespace}"
  xmlns:${prefixes.di}="${diNamespace}"
  xmlns:${prefixes.dc}="${dcNamespace}"
  xmlns:${prefixes.xsi}="${xsiNamespace}"
  xmlns:${prefixes.target}="urn:workflow:orders"
  id="definitions_orders"
  name="Orders"
  targetNamespace="urn:workflow:orders"
  expressionLanguage="urn:expression:rules"
  exporter="Effect"
  exporterVersion="4">
  <${prefixes.model}:process id="process_orders" name="Orders" isExecutable="true">
    <${prefixes.model}:startEvent id="start">
      <${prefixes.model}:outgoing>${prefixes.target}:flow_start</${prefixes.model}:outgoing>
    </${prefixes.model}:startEvent>
    <${prefixes.model}:exclusiveGateway id="choice" gatewayDirection="Diverging" default="flow_default">
      <${prefixes.model}:incoming>${prefixes.target}:flow_start</${prefixes.model}:incoming>
      <${prefixes.model}:outgoing>${prefixes.target}:flow_condition</${prefixes.model}:outgoing>
      <${prefixes.model}:outgoing>${prefixes.target}:flow_default</${prefixes.model}:outgoing>
    </${prefixes.model}:exclusiveGateway>
    <${prefixes.model}:task id="approve" name="Approve">
      <${prefixes.model}:incoming>${prefixes.target}:flow_condition</${prefixes.model}:incoming>
      <${prefixes.model}:outgoing>${prefixes.target}:flow_approved</${prefixes.model}:outgoing>
    </${prefixes.model}:task>
    <${prefixes.model}:endEvent id="end">
      <${prefixes.model}:incoming>${prefixes.target}:flow_default</${prefixes.model}:incoming>
      <${prefixes.model}:incoming>${prefixes.target}:flow_approved</${prefixes.model}:incoming>
    </${prefixes.model}:endEvent>
    <${prefixes.model}:sequenceFlow id="flow_start" sourceRef="start" targetRef="choice"/>
    <${prefixes.model}:sequenceFlow id="flow_condition" sourceRef="choice" targetRef="approve">
      <${prefixes.model}:conditionExpression ${prefixes.xsi}:type="${prefixes.model}:tFormalExpression"><![CDATA[amount > 100]]></${prefixes.model}:conditionExpression>
    </${prefixes.model}:sequenceFlow>
    <${prefixes.model}:sequenceFlow id="flow_default" sourceRef="choice" targetRef="end"/>
    <${prefixes.model}:sequenceFlow id="flow_approved" sourceRef="approve" targetRef="end"/>
  </${prefixes.model}:process>
  <${prefixes.bpmnDi}:BPMNDiagram id="diagram_orders" name="Orders" resolution="96">
    <${prefixes.bpmnDi}:BPMNPlane id="plane_orders" bpmnElement="process_orders">
      <${prefixes.bpmnDi}:BPMNShape id="shape_start" bpmnElement="start" isExpanded="false">
        <${prefixes.dc}:Bounds x="10" y="20" width="36" height="36"/>
        <${prefixes.bpmnDi}:BPMNLabel labelStyle="style_default">
          <${prefixes.dc}:Bounds x="5" y="58" width="46" height="14"/>
        </${prefixes.bpmnDi}:BPMNLabel>
      </${prefixes.bpmnDi}:BPMNShape>
      <${prefixes.bpmnDi}:BPMNShape id="shape_choice" bpmnElement="choice">
        <${prefixes.dc}:Bounds x="100" y="13" width="50" height="50"/>
      </${prefixes.bpmnDi}:BPMNShape>
      <${prefixes.bpmnDi}:BPMNEdge
        id="edge_start"
        bpmnElement="flow_start"
        sourceElement="shape_start"
        targetElement="shape_choice">
        <${prefixes.di}:waypoint x="46" y="38"/>
        <${prefixes.di}:waypoint x="100" y="38"/>
      </${prefixes.bpmnDi}:BPMNEdge>
    </${prefixes.bpmnDi}:BPMNPlane>
    <${prefixes.bpmnDi}:BPMNLabelStyle id="style_default">
      <${prefixes.dc}:Font name="Inter" size="12" isBold="true"/>
    </${prefixes.bpmnDi}:BPMNLabelStyle>
  </${prefixes.bpmnDi}:BPMNDiagram>
</${prefixes.model}:definitions>`

describe("BpmnXml", () => {
  it("imports the complete named semantic and DI slice independent of prefix spelling", () => {
    const first = success(BpmnXml.importXml(xml(), options))
    const second = success(BpmnXml.importXml(
      xml({
        model: "m",
        bpmnDi: "bdi",
        di: "d",
        dc: "c",
        xsi: "x",
        target: "t"
      }),
      options
    ))

    assert.strictEqual(first.profileId, BpmnXml.CoreProcessDiProfileId)
    assert.deepStrictEqual(first.model, second.model)
    assert.deepStrictEqual(first.di, second.di)
    assert.strictEqual(first.definitions.typeLanguage, "http://www.w3.org/2001/XMLSchema")
    assert.strictEqual(first.model.processes[0]!.processType, "none")
    assert.strictEqual(first.model.processes[0]!.isClosed, false)
    assert.strictEqual(first.model.sequenceFlows[1]!.condition?.version, "3.2.1")
    assert.deepStrictEqual(first.mappingReport.semanticLosses, [])
    assert.isTrue(Object.isFrozen(first))
    assert.isTrue(Object.isFrozen(first.model))
    assert.isTrue(Object.isFrozen(first.di))
  })

  it("applies selected BPMN defaults without inventing expression versions", () => {
    const minimal = `<b:definitions xmlns:b="${modelNamespace}" targetNamespace="urn:minimal">
      <b:process id="p">
        <b:startEvent id="s"/>
        <b:parallelGateway id="g"/>
        <b:endEvent id="e"/>
        <b:sequenceFlow id="f1" sourceRef="s" targetRef="g"/>
        <b:sequenceFlow id="f2" sourceRef="g" targetRef="e"/>
      </b:process>
    </b:definitions>`
    const document = success(BpmnXml.importXml(minimal, {
      importId: "minimal",
      expressionLanguageBindings: []
    }))

    assert.strictEqual(document.definitions.expressionLanguage, "http://www.w3.org/1999/XPath")
    assert.strictEqual(document.definitions.typeLanguage, "http://www.w3.org/2001/XMLSchema")
    assert.deepStrictEqual(
      document.model.processes.map(({ processType, isClosed }) => ({ processType, isClosed })),
      [{ processType: "none", isClosed: false }]
    )
    assert.strictEqual(document.model.flowNodes[1]!._tag, "Gateway")
    const gateway = document.model.flowNodes[1]!
    assert.strictEqual(gateway._tag === "Gateway" ? gateway.gatewayDirection : undefined, "unspecified")
    assert.isAbove(document.mappingReport.defaultsApplied.length, 3)

    assert.include(
      failureCodes(BpmnXml.importXml(xml(), {
        importId: "missing-binding",
        expressionLanguageBindings: []
      })),
      BpmnXml.Codes.MissingExpressionBinding
    )
  })

  it("uses expanded names and rejects prefix spoofing, unsafe xsi:type, and foreign content", () => {
    const spoofedTask = xml().replace(
      "<semantic:task id=\"approve\" name=\"Approve\">",
      `<semantic:task xmlns:semantic="urn:spoofed" id="approve" name="Approve">`
    )
    const spoofedType = xml().replace(
      "schemaInstance:type=\"semantic:tFormalExpression\"",
      "xmlns:fake=\"urn:fake\" schemaInstance:type=\"fake:tFormalExpression\""
    )
    const extension = xml().replace(
      "</semantic:process>",
      "<semantic:extensionElements><vendor:data xmlns:vendor=\"urn:vendor\"/></semantic:extensionElements></semantic:process>"
    )

    assert.include(
      failureCodes(BpmnXml.importXml(spoofedTask, options)),
      BpmnXml.Codes.UnsupportedNamespace
    )
    assert.include(
      failureCodes(BpmnXml.importXml(spoofedType, options)),
      BpmnXml.Codes.InvalidStructure
    )
    assert.include(
      failureCodes(BpmnXml.importXml(extension, options)),
      BpmnXml.Codes.UnsupportedElement
    )
  })

  it("rejects stale, incomplete, cross-scope, and non-NCName references", () => {
    const stale = xml().replace("sourceRef=\"start\"", "sourceRef=\"missing\"")
    const incomplete = xml().replace(
      `<semantic:outgoing>domain:flow_default</semantic:outgoing>`,
      ""
    )
    const invalidId = xml().replace("id=\"flow_start\"", "id=\"flow:start\"")
    const crossScope = xml().replace(
      "<semantic:task id=\"approve\" name=\"Approve\">",
      "<semantic:subProcess id=\"nested\"><semantic:task id=\"inside\"/></semantic:subProcess><semantic:task id=\"approve\" name=\"Approve\">"
    ).replace("targetRef=\"approve\"", "targetRef=\"inside\"")

    assert.isTrue(Result.isFailure(BpmnXml.importXml(stale, options)))
    assert.include(
      failureCodes(BpmnXml.importXml(incomplete, options)),
      BpmnXml.Codes.InvalidReference
    )
    assert.include(
      failureCodes(BpmnXml.importXml(invalidId, options)),
      BpmnXml.Codes.InvalidId
    )
    assert.isTrue(Result.isFailure(BpmnXml.importXml(crossScope, options)))
  })

  it("fails closed for unknown attributes, DTDs, and caller-selected resource bounds", () => {
    const unknownAttribute = xml().replace(
      "id=\"process_orders\"",
      "id=\"process_orders\" vendor=\"ignored\""
    )

    assert.include(
      failureCodes(BpmnXml.importXml(unknownAttribute, options)),
      BpmnXml.Codes.UnsupportedAttribute
    )
    assert.include(
      failureCodes(BpmnXml.importXml(
        `<!DOCTYPE b:definitions><b:definitions xmlns:b="${modelNamespace}" targetNamespace="urn:x"><b:process id="p"/></b:definitions>`,
        { importId: "dtd", expressionLanguageBindings: [] }
      )),
      BpmnXmlAst.Codes.DtdForbidden
    )
    assert.include(
      failureCodes(BpmnXml.importXml(xml(), {
        ...options,
        limits: { maxDocumentCharacters: 20 }
      })),
      BpmnXmlAst.Codes.DocumentLimitExceeded
    )
  })

  it("validates DI geometry, semantic reference kinds, and global XML ids", () => {
    const negativeBounds = xml().replace("width=\"36\"", "width=\"-1\"")
    const wrongShapeRef = xml().replace(
      "bpmnElement=\"start\" isExpanded",
      "bpmnElement=\"flow_start\" isExpanded"
    )
    const duplicateAcrossLayers = xml().replace("id=\"shape_start\"", "id=\"start\"")
    const shortEdge = xml().replace(
      "<route:waypoint x=\"100\" y=\"38\"/>",
      ""
    )

    assert.isTrue(Result.isFailure(BpmnXml.importXml(negativeBounds, options)))
    assert.include(
      failureCodes(BpmnXml.importXml(wrongShapeRef, options)),
      BpmnXml.Codes.UnsupportedDi
    )
    assert.include(
      failureCodes(BpmnXml.importXml(duplicateAcrossLayers, options)),
      BpmnXml.Codes.DuplicateId
    )
    assert.include(
      failureCodes(BpmnXml.importXml(shortEdge, options)),
      BpmnXml.Codes.InvalidStructure
    )
  })

  it("normalizes empty and targetNamespace-qualified DI QNames to local ids", () => {
    const qualified = xml()
      .replace(
        `bpmnElement="process_orders"`,
        `bpmnElement="domain:process_orders"`
      )
      .replace(
        `bpmnElement="start" isExpanded`,
        `bpmnElement="domain:start" isExpanded`
      )
      .replace(
        `labelStyle="style_default"`,
        `labelStyle="domain:style_default"`
      )
      .replace(
        `bpmnElement="choice">`,
        `bpmnElement="domain:choice">`
      )
      .replace(
        `bpmnElement="flow_start"`,
        `bpmnElement="domain:flow_start"`
      )
      .replace(
        `sourceElement="shape_start"`,
        `sourceElement="domain:shape_start"`
      )
      .replace(
        `targetElement="shape_choice"`,
        `targetElement="domain:shape_choice"`
      )
    const document = success(BpmnXml.importXml(qualified, options))
    const plane = document.di!.diagrams[0]!.plane

    assert.strictEqual(plane.bpmnElementId, "process_orders")
    assert.deepStrictEqual(
      plane.diagramElements.map((element) => element.bpmnElementId),
      ["start", "choice", "flow_start"]
    )
    assert.strictEqual(plane.diagramElements[0]!.label?.styleRef, "style_default")
    const edge = plane.diagramElements[2]!
    assert.strictEqual(edge._tag, "Edge")
    if (edge._tag === "Edge") {
      assert.strictEqual(edge.sourceElementId, "shape_start")
      assert.strictEqual(edge.targetElementId, "shape_choice")
    }

    const unqualified = success(BpmnXml.importXml(xml(), options))
    assert.strictEqual(unqualified.di!.diagrams[0]!.plane.bpmnElementId, "process_orders")
  })

  it("enforces DI plane ownership and exact same-plane edge endpoint shapes", () => {
    const withOtherProcess = xml().replace(
      "  <visual:BPMNDiagram",
      `  <semantic:process id="process_other">
    <semantic:startEvent id="other_start"/>
    <semantic:endEvent id="other_end"/>
    <semantic:sequenceFlow id="other_flow" sourceRef="other_start" targetRef="other_end"/>
  </semantic:process>
  <visual:BPMNDiagram`
    )
    const shapeFromOtherProcess = withOtherProcess.replace(
      `bpmnElement="start" isExpanded`,
      `bpmnElement="other_start" isExpanded`
    )
    const edgeFromOtherProcess = withOtherProcess.replace(
      `bpmnElement="flow_start"`,
      `bpmnElement="other_flow"`
    )
    const selfEndpoint = xml().replace(
      `sourceElement="shape_start"`,
      `sourceElement="edge_start"`
    )
    const planeEndpoint = xml().replace(
      `sourceElement="shape_start"`,
      `sourceElement="plane_orders"`
    )
    const wrongDirection = xml().replace(
      `sourceElement="shape_start"`,
      `sourceElement="shape_choice"`
    )
    const crossDiagram = xml()
      .replace(
        `sourceElement="shape_start"`,
        `sourceElement="shape_approve"`
      )
      .replace(
        "</semantic:definitions>",
        `<visual:BPMNDiagram id="diagram_approve">
    <visual:BPMNPlane id="plane_approve" bpmnElement="process_orders">
      <visual:BPMNShape id="shape_approve" bpmnElement="approve">
        <geometry:Bounds x="200" y="20" width="80" height="50"/>
      </visual:BPMNShape>
    </visual:BPMNPlane>
  </visual:BPMNDiagram>
</semantic:definitions>`
      )

    for (
      const candidate of [
        shapeFromOtherProcess,
        edgeFromOtherProcess,
        selfEndpoint,
        planeEndpoint,
        wrongDirection,
        crossDiagram
      ]
    ) {
      assert.include(
        failureCodes(BpmnXml.importXml(candidate, options)),
        BpmnXml.Codes.UnsupportedDi
      )
    }
  })

  it("rejects collaboration-only DI attributes in the core-process profile", () => {
    const participantBand = xml().replace(
      `bpmnElement="start" isExpanded`,
      `bpmnElement="start" participantBandKind="top_initiating" isExpanded`
    )
    const choreographyShape = xml().replace(
      `bpmnElement="start" isExpanded`,
      `bpmnElement="start" choreographyActivityShape="shape_choice" isExpanded`
    )
    const messageVisibility = xml().replace(
      `targetElement="shape_choice">`,
      `targetElement="shape_choice" messageVisibleKind="initiating">`
    )

    for (const candidate of [participantBand, choreographyShape, messageVisibility]) {
      assert.include(
        failureCodes(BpmnXml.importXml(candidate, options)),
        BpmnXml.Codes.UnsupportedDi
      )
    }
  })

  it("preserves xsd:string enum whitespace and collapses formal-expression anyURI whitespace", () => {
    const paddedProcessType = xml().replace(
      `id="process_orders" name="Orders"`,
      `id="process_orders" name="Orders" processType=" None "`
    )
    const paddedGatewayDirection = xml().replace(
      `gatewayDirection="Diverging"`,
      `gatewayDirection=" Diverging "`
    )
    const blankLanguage = xml().replace(
      `schemaInstance:type="semantic:tFormalExpression"`,
      `schemaInstance:type="semantic:tFormalExpression" language=" \t "`
    )
    const collapsedLanguage = xml().replace(
      `schemaInstance:type="semantic:tFormalExpression"`,
      `schemaInstance:type="semantic:tFormalExpression" language="  urn:expression:rules \t "`
    )

    assert.include(
      failureCodes(BpmnXml.importXml(paddedProcessType, options)),
      BpmnXml.Codes.InvalidLexicalValue
    )
    assert.include(
      failureCodes(BpmnXml.importXml(paddedGatewayDirection, options)),
      BpmnXml.Codes.InvalidLexicalValue
    )
    assert.include(
      failureCodes(BpmnXml.importXml(blankLanguage, options)),
      BpmnXml.Codes.InvalidLexicalValue
    )
    const document = success(BpmnXml.importXml(collapsedLanguage, options))
    assert.strictEqual(document.model.sequenceFlows[1]!.condition?.language, "urn:expression:rules")
    assert.isTrue(
      document.mappingReport.lexicalNonPreservation.some((entry) => entry.code === "CollapsedTokenWhitespace")
    )
  })

  it("fails validation closed for unexportable XML strings and the hard XML depth cap", () => {
    const reservedNamespace = `<b:definitions
      xmlns:b="${modelNamespace}"
      targetNamespace="http://www.w3.org/XML/1998/namespace">
      <b:process id="p"/>
    </b:definitions>`
    assert.include(
      failureCodes(BpmnXml.importXml(reservedNamespace, {
        importId: "reserved",
        expressionLanguageBindings: []
      })),
      BpmnXmlAst.Codes.InvalidNamespaceBinding
    )

    const shallow = success(BpmnXml.importXml(
      `<b:definitions xmlns:b="${modelNamespace}" targetNamespace="urn:deep">
        <b:process id="p"><b:subProcess id="template"/></b:process>
      </b:definitions>`,
      { importId: "deep", expressionLanguageBindings: [] }
    ))
    const illegal = {
      ...shallow,
      definitions: {
        ...shallow.definitions,
        name: "forbidden\u0000name"
      }
    }
    assert.include(
      failureCodes(BpmnXml.validate(illegal)),
      BpmnXmlAst.Codes.InvalidCharacter
    )
    assert.include(
      failureCodes(BpmnXml.exportXml(illegal)),
      BpmnXmlAst.Codes.InvalidCharacter
    )

    const template = shallow.model.flowNodes[0]!
    const tooDeep = {
      ...shallow,
      model: {
        ...shallow.model,
        flowNodes: Array.from({ length: BpmnXmlAst.MaximumXmlDepth }, (_, index) => ({
          ...template,
          id: `nested_${index}`,
          parentScopeId: index === 0 ? "p" : `nested_${index - 1}`
        }))
      }
    }
    assert.include(
      failureCodes(BpmnXml.validate(tooDeep)),
      BpmnXmlAst.Codes.DepthLimitExceeded
    )
  })

  it("exports deterministically and round-trips normalized semantic and visual data", () => {
    const imported = success(BpmnXml.importXml(xml(), options))
    const first = success(BpmnXml.exportXml(imported))
    const second = success(BpmnXml.exportXml(imported))

    assert.strictEqual(first, second)
    assert.include(first, "<bpmn:definitions")
    assert.include(first, `xmlns:bpmndi="${bpmnDiNamespace}"`)
    assert.include(first, `xmlns:tns="urn:workflow:orders"`)
    assert.notInclude(first, "<semantic:")

    const roundTrip = success(BpmnXml.importXml(first, options))
    assert.deepStrictEqual(roundTrip.definitions, imported.definitions)
    assert.deepStrictEqual(roundTrip.expressionLanguageBindings, imported.expressionLanguageBindings)
    assert.deepStrictEqual(roundTrip.model, imported.model)
    assert.deepStrictEqual(roundTrip.di, imported.di)
  })

  it("round-trips recursive ordinary subprocess containment without flattening scope", () => {
    const nested = `<b:definitions
      xmlns:b="${modelNamespace}"
      xmlns:t="urn:nested"
      targetNamespace="urn:nested">
      <b:process id="p">
        <b:startEvent id="outer_start"/>
        <b:subProcess id="nested">
          <b:startEvent id="inner_start"/>
          <b:task id="inner_task"/>
          <b:endEvent id="inner_end"/>
          <b:sequenceFlow id="inner_1" sourceRef="inner_start" targetRef="inner_task"/>
          <b:sequenceFlow id="inner_2" sourceRef="inner_task" targetRef="inner_end"/>
        </b:subProcess>
        <b:endEvent id="outer_end"/>
        <b:sequenceFlow id="outer_1" sourceRef="outer_start" targetRef="nested"/>
        <b:sequenceFlow id="outer_2" sourceRef="nested" targetRef="outer_end"/>
      </b:process>
    </b:definitions>`
    const importOptions = {
      importId: "nested",
      expressionLanguageBindings: []
    } as const
    const first = success(BpmnXml.importXml(nested, importOptions))
    const serialized = success(BpmnXml.exportXml(first, { format: "compact" }))
    const second = success(BpmnXml.importXml(serialized, importOptions))

    assert.deepStrictEqual(second.model, first.model)
    assert.deepStrictEqual(
      second.model.flowNodes.map(({ id, parentScopeId }) => ({ id, parentScopeId })),
      [
        { id: "outer_start", parentScopeId: "p" },
        { id: "nested", parentScopeId: "p" },
        { id: "inner_start", parentScopeId: "nested" },
        { id: "inner_task", parentScopeId: "nested" },
        { id: "inner_end", parentScopeId: "nested" },
        { id: "outer_end", parentScopeId: "p" }
      ]
    )
  })

  it("round-trips callActivity calledElement as an expanded QName", () => {
    const callable = `<b:definitions
      xmlns:b="${modelNamespace}"
      xmlns:child="urn:workflow:child"
      targetNamespace="urn:workflow:parent">
      <b:process id="parent">
        <b:startEvent id="start"/>
        <b:callActivity id="invoke_child" name="Invoke child" calledElement="child:fulfillment"/>
        <b:endEvent id="end"/>
        <b:sequenceFlow id="to_call" sourceRef="start" targetRef="invoke_child"/>
        <b:sequenceFlow id="to_end" sourceRef="invoke_child" targetRef="end"/>
      </b:process>
    </b:definitions>`
    const importOptions = {
      importId: "call-activity",
      expressionLanguageBindings: []
    } as const
    const first = success(BpmnXml.importXml(callable, importOptions))
    const call = first.model.flowNodes[1]!

    assert.strictEqual(call._tag, "CallActivity")
    assert.deepStrictEqual(
      call._tag === "CallActivity" ? call.calledElement : undefined,
      { namespaceUri: "urn:workflow:child", localName: "fulfillment" }
    )

    const serialized = success(BpmnXml.exportXml(first, { format: "compact" }))
    assert.include(serialized, `xmlns:call0="urn:workflow:child"`)
    assert.include(serialized, `calledElement="call0:fulfillment"`)

    const second = success(BpmnXml.importXml(serialized, importOptions))
    assert.deepStrictEqual(second.model, first.model)
  })

  it("resolves empty, default, target, and implicit XML QName namespaces", () => {
    const callable = `<b:definitions
      xmlns:b="${modelNamespace}"
      xmlns:tns="urn:workflow:parent"
      targetNamespace="urn:workflow:parent">
      <b:process id="parent">
        <b:callActivity id="empty" calledElement="empty_child"/>
        <b:callActivity xmlns="urn:workflow:local" id="local" calledElement="local_child"/>
        <b:callActivity id="target" calledElement="tns:target_child"/>
        <b:callActivity id="xml" calledElement="xml:xml_child"/>
      </b:process>
    </b:definitions>`
    const importOptions = {
      importId: "call-activity-namespaces",
      expressionLanguageBindings: []
    } as const
    const first = success(BpmnXml.importXml(callable, importOptions))

    assert.deepStrictEqual(
      first.model.flowNodes.map((node) => node._tag === "CallActivity" ? node.calledElement : undefined),
      [
        { namespaceUri: "", localName: "empty_child" },
        { namespaceUri: "urn:workflow:local", localName: "local_child" },
        { namespaceUri: "urn:workflow:parent", localName: "target_child" },
        {
          namespaceUri: "http://www.w3.org/XML/1998/namespace",
          localName: "xml_child"
        }
      ]
    )

    const serialized = success(BpmnXml.exportXml(first, { format: "compact" }))
    assert.include(serialized, `xmlns:call0="urn:workflow:local"`)
    assert.notInclude(serialized, `xmlns:xml=`)
    assert.include(serialized, `calledElement="xml:xml_child"`)
    assert.deepStrictEqual(
      success(BpmnXml.importXml(serialized, importOptions)).model,
      first.model
    )
  })

  it("rejects malformed normalized callActivity QNames with a QName diagnostic", () => {
    const callable = `<b:definitions
      xmlns:b="${modelNamespace}"
      targetNamespace="urn:workflow:parent">
      <b:process id="parent">
        <b:callActivity id="invoke_child" calledElement="child"/>
      </b:process>
    </b:definitions>`
    const imported = success(BpmnXml.importXml(callable, {
      importId: "normalized-call-activity",
      expressionLanguageBindings: []
    }))
    const invalid = {
      ...imported,
      model: {
        ...imported.model,
        flowNodes: imported.model.flowNodes.map((node) =>
          node._tag === "CallActivity"
            ? {
              ...node,
              calledElement: {
                namespaceUri: "urn:workflow:child",
                localName: "bad:child"
              }
            }
            : node
        )
      }
    }

    assert.include(
      failureCodes(BpmnXml.validate(invalid)),
      BpmnXml.Codes.InvalidQName
    )
  })

  it("rejects malformed and unbound callActivity QNames", () => {
    const template = (calledElement: string): string =>
      `<b:definitions
      xmlns:b="${modelNamespace}"
      targetNamespace="urn:workflow:parent">
      <b:process id="parent">
        <b:callActivity id="invoke_child" calledElement="${calledElement}"/>
      </b:process>
    </b:definitions>`
    const importOptions = {
      importId: "invalid-call-activity",
      expressionLanguageBindings: []
    } as const

    assert.include(
      failureCodes(BpmnXml.importXml(template("missing:child"), importOptions)),
      BpmnXml.Codes.UnknownPrefix
    )
    assert.include(
      failureCodes(BpmnXml.importXml(template("too:many:parts"), importOptions)),
      BpmnXml.Codes.InvalidQName
    )
  })

  it("rejects hostile option and document descriptors without invoking getters", () => {
    let calls = 0
    const hostileOptions: Record<string, unknown> = {}
    Object.defineProperty(hostileOptions, "importId", {
      enumerable: true,
      get: () => {
        calls++
        return "unsafe"
      }
    })
    const hostileDocument: Record<string, unknown> = {}
    Object.defineProperty(hostileDocument, "profileId", {
      enumerable: true,
      get: () => {
        calls++
        return BpmnXml.CoreProcessDiProfileId
      }
    })

    assert.include(
      failureCodes(BpmnXml.importXml(xml(), hostileOptions)),
      BpmnXml.Codes.InvalidOptions
    )
    assert.include(
      failureCodes(BpmnXml.exportXml(hostileDocument)),
      BpmnXml.Codes.InvalidDocument
    )
    assert.strictEqual(calls, 0)
  })
})
