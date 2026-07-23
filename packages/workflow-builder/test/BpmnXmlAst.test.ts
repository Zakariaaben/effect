import { assert, describe, it } from "@effect/vitest"
import * as BpmnXmlAst from "@effect/workflow-builder/BpmnXmlAst"
import * as Result from "effect/Result"

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failureCode = <A>(
  result: Result.Result<A, { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }>
): string => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isSuccess(result)) {
    throw new Error("Expected failure")
  }
  return result.failure.diagnostics[0]!.code
}

const rootElement = (document: BpmnXmlAst.XmlDocument): BpmnXmlAst.XmlElement => {
  const root = document.children.find((node) => node._tag === "Element")
  assert.isDefined(root)
  assert.strictEqual(root._tag, "Element")
  return root
}

const withoutSpans = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, child) => key === "span" ? undefined : child))

describe("BpmnXmlAst", () => {
  describe("parse", () => {
    it("resolves namespaces while preserving prefixes and lexical order", () => {
      const namespaceUri = "http://www.omg.org/spec/BPMN/20100524/MODEL"
      const input =
        `<?xml version="1.0"?><b:definitions xmlns:x="urn:test" xmlns:b="${namespaceUri}" id="defs" x:mode="strict"><b:process id="orders"/></b:definitions>`
      const document = success(BpmnXmlAst.parse(input))
      const root = rootElement(document)

      assert.deepStrictEqual(root.name, {
        namespaceUri,
        localName: "definitions",
        prefix: "b"
      })
      assert.deepStrictEqual(
        root.namespaceDeclarations.map(({ prefix, namespaceUri }) => ({ prefix, namespaceUri })),
        [
          { prefix: "x", namespaceUri: "urn:test" },
          { prefix: "b", namespaceUri }
        ]
      )
      assert.deepStrictEqual(
        root.attributes.map(({ name, value }) => ({ name, value })),
        [
          {
            name: { namespaceUri: "", localName: "id", prefix: "" },
            value: "defs"
          },
          {
            name: { namespaceUri: "urn:test", localName: "mode", prefix: "x" },
            value: "strict"
          }
        ]
      )
      assert.deepStrictEqual(
        root.namespaceDeclarations.map((declaration) =>
          input.slice(declaration.span.start.offset, declaration.span.end.offset)
        ),
        [`xmlns:x="urn:test"`, `xmlns:b="${namespaceUri}"`]
      )
      assert.deepStrictEqual(
        root.attributes.map((attribute) => input.slice(attribute.span.start.offset, attribute.span.end.offset)),
        [`id="defs"`, `x:mode="strict"`]
      )
      const process = root.children[0]!
      assert.strictEqual(process._tag, "Element")
      if (process._tag === "Element") {
        assert.deepStrictEqual(process.name, {
          namespaceUri,
          localName: "process",
          prefix: "b"
        })
      }

      const alternate = rootElement(success(BpmnXmlAst.parse(
        `<bpmn:definitions xmlns:bpmn="${namespaceUri}"/>`
      )))
      assert.strictEqual(alternate.name.namespaceUri, root.name.namespaceUri)
      assert.strictEqual(alternate.name.localName, root.name.localName)
      assert.strictEqual(alternate.name.prefix, "bpmn")
    })

    it("applies default namespaces, prefix shadowing, and unprefixed attribute rules", () => {
      const document = success(BpmnXmlAst.parse(
        "<r xmlns=\"urn:outer\" xmlns:p=\"urn:first\" plain=\"x\"><p:c xmlns=\"urn:inner\" xmlns:p=\"urn:second\" p:a=\"v\"><leaf/></p:c></r>"
      ))
      const root = rootElement(document)
      const child = root.children[0]!

      assert.strictEqual(root.name.namespaceUri, "urn:outer")
      assert.strictEqual(root.attributes[0]!.name.namespaceUri, "")
      assert.strictEqual(child._tag, "Element")
      if (child._tag === "Element") {
        assert.deepStrictEqual(child.name, {
          namespaceUri: "urn:second",
          localName: "c",
          prefix: "p"
        })
        assert.strictEqual(child.attributes[0]!.name.namespaceUri, "urn:second")
        const leaf = child.children[0]!
        assert.strictEqual(leaf._tag, "Element")
        if (leaf._tag === "Element") {
          assert.deepStrictEqual(leaf.name, {
            namespaceUri: "urn:inner",
            localName: "leaf",
            prefix: ""
          })
        }
      }

      const undeclared = rootElement(success(BpmnXmlAst.parse(
        "<r xmlns=\"urn:outer\"><local xmlns=\"\"><leaf/></local></r>"
      ))).children[0]!
      assert.strictEqual(undeclared._tag, "Element")
      if (undeclared._tag === "Element") {
        assert.strictEqual(undeclared.name.namespaceUri, "")
        assert.strictEqual(undeclared.children[0]!._tag, "Element")
        if (undeclared.children[0]!._tag === "Element") {
          assert.strictEqual(undeclared.children[0]!.name.namespaceUri, "")
        }
      }
    })

    it("preserves mixed text, CDATA, comments, and processing instructions in order", () => {
      const input = `<r xmlns="urn:root">a&amp;b<![CDATA[<c>]]><!--note--><?go now?>tail</r>`
      const document = success(BpmnXmlAst.parse(input))
      const root = rootElement(document)

      assert.deepStrictEqual(
        root.children.map((node) => node._tag),
        ["Text", "CData", "Comment", "ProcessingInstruction", "Text"]
      )
      assert.deepStrictEqual(
        root.children.map((node) =>
          node._tag === "ProcessingInstruction"
            ? [node.target, node.body]
            : node._tag === "Element"
            ? node.name.localName
            : node.value
        ),
        ["a&b", "<c>", "note", ["go", "now"], "tail"]
      )
      assert.deepStrictEqual(
        root.children.map((node) => input.slice(node.span.start.offset, node.span.end.offset)),
        ["a&amp;b", "<![CDATA[<c>]]>", "<!--note-->", "<?go now?>", "tail"]
      )
    })

    it("retains initial prolog whitespace without shifting markup spans", () => {
      const input = " \r\n<!--before--><?ready yes?><r/>"
      const document = success(BpmnXmlAst.parse(input))

      assert.deepStrictEqual(
        document.children.map((node) => node._tag),
        ["Text", "Comment", "ProcessingInstruction", "Element"]
      )
      const whitespace = document.children[0]!
      const comment = document.children[1]!
      const instruction = document.children[2]!
      assert.strictEqual(whitespace._tag, "Text")
      assert.strictEqual(comment._tag, "Comment")
      assert.strictEqual(instruction._tag, "ProcessingInstruction")
      if (
        whitespace._tag === "Text" &&
        comment._tag === "Comment" &&
        instruction._tag === "ProcessingInstruction"
      ) {
        assert.strictEqual(whitespace.value, " \n")
        assert.strictEqual(input.slice(whitespace.span.start.offset, whitespace.span.end.offset), " \r\n")
        assert.strictEqual(input.slice(comment.span.start.offset, comment.span.end.offset), "<!--before-->")
        assert.strictEqual(
          input.slice(instruction.span.start.offset, instruction.span.end.offset),
          "<?ready yes?>"
        )
      }
    })

    it("returns detached recursively frozen values with half-open source spans", () => {
      const input = "<r>\r\n  <c a=\"1\">text</c>\r</r>"
      const document = success(BpmnXmlAst.parse(input))
      const root = rootElement(document)
      const child = root.children.find((node) => node._tag === "Element")

      assert.isDefined(child)
      assert.strictEqual(document.span.start.offset, 0)
      assert.strictEqual(document.span.end.offset, input.length)
      assert.strictEqual(root.span.start.offset, 0)
      assert.strictEqual(root.span.end.offset, input.length)
      assert.strictEqual(child.span.start.line, 2)
      assert.strictEqual(child.span.start.column, 2)
      assert.strictEqual(input.slice(child.span.start.offset, child.span.end.offset), "<c a=\"1\">text</c>")
      assert.isTrue(Object.isFrozen(document))
      assert.isTrue(Object.isFrozen(document.children))
      assert.isTrue(Object.isFrozen(root))
      assert.isTrue(Object.isFrozen(root.name))
      assert.isTrue(Object.isFrozen(root.children))
      assert.isTrue(Object.isFrozen(child.span))
    })

    it("fails closed for malformed XML and every DTD", () => {
      for (
        const input of [
          "<r>",
          "<r><a></r>",
          "<r/><s/>",
          "<r>&unknown;</r>",
          "<?xml version=\"1.1\"?><r/>"
        ]
      ) {
        assert.strictEqual(failureCode(BpmnXmlAst.parse(input)), BpmnXmlAst.Codes.InvalidXml)
      }

      for (
        const input of [
          "<!DOCTYPE r><r/>",
          "<!DOCTYPE r [<!ENTITY x \"expanded\">]><r>&x;</r>",
          "<!DOCTYPE r SYSTEM \"https://example.invalid/external.dtd\"><r/>"
        ]
      ) {
        assert.strictEqual(failureCode(BpmnXmlAst.parse(input)), BpmnXmlAst.Codes.DtdForbidden)
      }
    })

    it("enforces each parser resource bound", () => {
      const cases: ReadonlyArray<
        readonly [
          input: string,
          limits: BpmnXmlAst.XmlLimits,
          code: BpmnXmlAst.XmlDiagnosticCode
        ]
      > = [
        ["<r/>", { maxDocumentCharacters: 3 }, BpmnXmlAst.Codes.DocumentLimitExceeded],
        ["<r><c/></r>", { maxDepth: 1 }, BpmnXmlAst.Codes.DepthLimitExceeded],
        ["<r><c/></r>", { maxNodes: 1 }, BpmnXmlAst.Codes.NodeLimitExceeded],
        ["<r a=\"1\" b=\"2\"/>", { maxAttributesPerElement: 1 }, BpmnXmlAst.Codes.AttributeLimitExceeded],
        [
          "<r xmlns:a=\"urn:a\" xmlns:b=\"urn:b\"/>",
          { maxNamespaceDeclarationsPerElement: 1 },
          BpmnXmlAst.Codes.NamespaceLimitExceeded
        ],
        ["<r>abc</r>", { maxTextCharactersPerNode: 2 }, BpmnXmlAst.Codes.TextLimitExceeded],
        ["<r>a<c>b</c></r>", { maxTotalTextCharacters: 1 }, BpmnXmlAst.Codes.TextLimitExceeded],
        ["<root/>", { maxNameCharacters: 1 }, BpmnXmlAst.Codes.NameLimitExceeded]
      ]

      for (const [input, limits, code] of cases) {
        assert.strictEqual(failureCode(BpmnXmlAst.parse(input, limits)), code)
      }

      const hostileDepth = BpmnXmlAst.MaximumXmlDepth + 1
      assert.strictEqual(
        failureCode(BpmnXmlAst.parse(
          `${"<n>".repeat(hostileDepth)}${"</n>".repeat(hostileDepth)}`,
          { maxDepth: hostileDepth } as BpmnXmlAst.XmlLimits
        )),
        BpmnXmlAst.Codes.InvalidOptions
      )
    })
  })

  describe("serialize", () => {
    it("round-trips the namespace-aware ordered infoset modulo source spans", () => {
      const input =
        `<?xml version="1.0" encoding="UTF-8"?><!--before--><r xmlns:z="urn:z" xmlns:a="urn:a" z:b="2" a:c="3" plain="&quot;&amp;&lt;&#x9;&#xA;&#xD;">x&amp;&lt;&gt;&#xD;<![CDATA[raw < text]]><?next ready?></r><!--after-->`
      const first = success(BpmnXmlAst.parse(input))
      const serialized = success(BpmnXmlAst.serialize(first))
      const second = success(BpmnXmlAst.parse(serialized))

      assert.deepStrictEqual(withoutSpans(second), withoutSpans(first))
      assert.include(serialized, "plain=\"&quot;&amp;&lt;&#x9;&#xA;&#xD;\"")
      assert.include(serialized, "x&amp;&lt;&gt;&#xD;")
    })

    it("supports deterministic preserve, canonical, and pretty output", () => {
      const document = success(BpmnXmlAst.parse(
        "<r xmlns:z=\"urn:z\" xmlns:a=\"urn:a\" z:b=\"2\" a:c=\"3\" b=\"1\"><x/><y/></r>"
      ))

      assert.strictEqual(
        success(BpmnXmlAst.serialize(document)),
        "<r xmlns:z=\"urn:z\" xmlns:a=\"urn:a\" z:b=\"2\" a:c=\"3\" b=\"1\"><x/><y/></r>"
      )
      assert.strictEqual(
        success(BpmnXmlAst.serialize(document, { order: "canonical" })),
        "<r xmlns:a=\"urn:a\" xmlns:z=\"urn:z\" b=\"1\" a:c=\"3\" z:b=\"2\"><x/><y/></r>"
      )
      assert.strictEqual(
        success(BpmnXmlAst.serialize(document, { format: "pretty", indent: "  " })),
        "<r xmlns:z=\"urn:z\" xmlns:a=\"urn:a\" z:b=\"2\" a:c=\"3\" b=\"1\">\n  <x/>\n  <y/>\n</r>"
      )
    })

    it("applies serializer resource bounds consistently", () => {
      const shallow = success(BpmnXmlAst.parse("<r>text</r>"))
      const deep = success(BpmnXmlAst.parse("<r><c/></r>"))
      const longName = success(BpmnXmlAst.parse("<root/>"))

      assert.strictEqual(
        success(BpmnXmlAst.serialize(shallow, { limits: { maxDepth: 1 } })),
        "<r>text</r>"
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(deep, { limits: { maxDepth: 1 } })),
        BpmnXmlAst.Codes.DepthLimitExceeded
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(longName, { limits: { maxNameCharacters: 1 } })),
        BpmnXmlAst.Codes.NameLimitExceeded
      )

      const depth = 101
      const deeplyNested = success(BpmnXmlAst.parse(
        `${"<n>".repeat(depth)}${"</n>".repeat(depth)}`
      ))
      const hugeIndent = " ".repeat(6_000_000)
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(deeplyNested, {
          format: "pretty",
          indent: hugeIndent,
          limits: {
            maxDepth: 200,
            maxDocumentCharacters: 10
          }
        })),
        BpmnXmlAst.Codes.DocumentLimitExceeded
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(deeplyNested, {
          format: "pretty",
          indent: hugeIndent,
          limits: {
            maxDepth: 200,
            maxDocumentCharacters: Number.MAX_SAFE_INTEGER
          }
        })),
        BpmnXmlAst.Codes.DocumentLimitExceeded
      )

      const base = success(BpmnXmlAst.parse("<r/>"))
      const baseRoot = rootElement(base)
      const sharedText: BpmnXmlAst.XmlText = {
        _tag: "Text",
        value: "x",
        span: baseRoot.span
      }
      const expandedSharedDag = {
        ...base,
        children: [{
          ...baseRoot,
          children: Array.from({ length: 10_000 }, () => sharedText)
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(expandedSharedDag, {
          limits: { maxNodes: 1 }
        })),
        BpmnXmlAst.Codes.NodeLimitExceeded
      )

      let hostileNode: BpmnXmlAst.XmlElement = {
        ...baseRoot,
        children: []
      }
      for (let index = 0; index < 12_000; index++) {
        hostileNode = {
          ...baseRoot,
          children: [hostileNode]
        }
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize({
          ...base,
          children: [hostileNode]
        })),
        BpmnXmlAst.Codes.DepthLimitExceeded
      )
    })

    it("validates semantic document and span invariants without serializing", () => {
      const base = success(BpmnXmlAst.parse("<r/>"))
      assert.deepStrictEqual(success(BpmnXmlAst.validate(base)), base)
      assert.deepStrictEqual(
        success(BpmnXmlAst.validate(base, { maxDocumentCharacters: 4 })),
        base
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate(base, { maxDocumentCharacters: 3 })),
        BpmnXmlAst.Codes.DocumentLimitExceeded
      )

      const root = rootElement(base)
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate({
          ...base,
          children: [root, root]
        })),
        BpmnXmlAst.Codes.InvalidDocument
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate({
          ...base,
          span: {
            start: base.span.end,
            end: base.span.start
          }
        })),
        BpmnXmlAst.Codes.InvalidDocument
      )

      const ordered = success(BpmnXmlAst.parse("<r><a/><b/></r>"))
      const orderedRoot = rootElement(ordered)
      const first = orderedRoot.children[0]!
      const second = orderedRoot.children[1]!
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate({
          ...ordered,
          children: [{
            ...orderedRoot,
            children: [
              { ...first, span: second.span },
              { ...second, span: first.span }
            ]
          }]
        })),
        BpmnXmlAst.Codes.InvalidDocument
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate({
          ...ordered,
          children: [{
            ...orderedRoot,
            children: [{
              ...first,
              span: {
                start: { offset: 100, line: 10, column: 0 },
                end: { offset: 104, line: 10, column: 4 }
              }
            }, second]
          }]
        })),
        BpmnXmlAst.Codes.InvalidDocument
      )
    })

    it("rejects hostile objects without invoking accessors", () => {
      let getterCalls = 0
      const hostile = {
        documentKind: "XmlInfoset",
        documentVersion: BpmnXmlAst.XmlInfosetVersion,
        span: {
          start: { offset: 0, line: 1, column: 0 },
          end: { offset: 4, line: 1, column: 4 }
        }
      } as Record<string, unknown>
      Object.defineProperty(hostile, "children", {
        enumerable: true,
        get() {
          getterCalls++
          return []
        }
      })

      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(hostile)),
        BpmnXmlAst.Codes.InvalidDocument
      )
      assert.strictEqual(getterCalls, 0)
    })

    it("rejects unexpected AST and option graphs before traversing them", () => {
      let inspectionCalls = 0
      const hiddenGraph = new Proxy({}, {
        ownKeys() {
          inspectionCalls++
          return []
        }
      })
      let compactDag: unknown = { leaf: true }
      for (let index = 0; index < 24; index++) {
        compactDag = { left: compactDag, right: compactDag }
      }

      const base = success(BpmnXmlAst.parse(
        "<?xml version=\"1.0\"?><r xmlns:p=\"urn:p\" p:a=\"v\">text<?go yes?></r>"
      ))
      const root = rootElement(base)
      const text = root.children[0]!
      const instruction = root.children[1]!
      const cases: ReadonlyArray<unknown> = [
        { ...base, unexpected: compactDag },
        { ...base, declaration: { ...base.declaration!, unexpected: hiddenGraph } },
        { ...base, span: { ...base.span, unexpected: hiddenGraph } },
        {
          ...base,
          children: [{
            ...root,
            unexpected: hiddenGraph
          }]
        },
        {
          ...base,
          children: [{
            ...root,
            name: { ...root.name, unexpected: hiddenGraph }
          }]
        },
        {
          ...base,
          children: [{
            ...root,
            span: {
              ...root.span,
              start: { ...root.span.start, unexpected: hiddenGraph }
            }
          }]
        },
        {
          ...base,
          children: [{
            ...root,
            namespaceDeclarations: [{
              ...root.namespaceDeclarations[0]!,
              unexpected: hiddenGraph
            }]
          }]
        },
        {
          ...base,
          children: [{
            ...root,
            attributes: [{ ...root.attributes[0]!, unexpected: hiddenGraph }]
          }]
        },
        {
          ...base,
          children: [{
            ...root,
            children: [{ ...text, unexpected: hiddenGraph }, instruction]
          }]
        },
        {
          ...base,
          children: [{
            ...root,
            children: [text, { ...instruction, unexpected: hiddenGraph }]
          }]
        }
      ]
      for (const input of cases) {
        assert.strictEqual(
          failureCode(BpmnXmlAst.validate(input)),
          BpmnXmlAst.Codes.InvalidDocument
        )
      }

      const children = [...root.children] as Array<BpmnXmlAst.XmlNode> & {
        unexpected?: unknown
      }
      children.unexpected = hiddenGraph
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate({
          ...base,
          children: [{ ...root, children }]
        })),
        BpmnXmlAst.Codes.InvalidDocument
      )

      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(base, {
          format: "compact",
          unexpected: compactDag
        } as BpmnXmlAst.SerializeOptions)),
        BpmnXmlAst.Codes.InvalidOptions
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(base, {
          indent: hiddenGraph
        } as BpmnXmlAst.SerializeOptions)),
        BpmnXmlAst.Codes.InvalidOptions
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.validate(base, {
          maxNodes: hiddenGraph
        } as BpmnXmlAst.XmlLimits)),
        BpmnXmlAst.Codes.InvalidOptions
      )
      assert.strictEqual(inspectionCalls, 0)
    })

    it("rejects invalid names, namespace bindings, and duplicate expanded attributes", () => {
      const base = success(BpmnXmlAst.parse(
        "<r xmlns:x=\"urn:same\" xmlns:y=\"urn:same\" x:a=\"1\"/>"
      ))
      const root = rootElement(base)
      const attribute = root.attributes[0]!

      const invalidName = {
        ...base,
        children: [{
          ...root,
          name: { ...root.name, localName: "bad:name" }
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(invalidName)),
        BpmnXmlAst.Codes.InvalidName
      )

      const injectedName = {
        ...base,
        children: [{
          ...root,
          name: { ...root.name, localName: "r/><x" }
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(injectedName)),
        BpmnXmlAst.Codes.InvalidName
      )

      const invalidBinding = {
        ...base,
        children: [{
          ...root,
          name: { ...root.name, namespaceUri: "urn:unbound" }
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(invalidBinding)),
        BpmnXmlAst.Codes.InvalidNamespaceBinding
      )

      const unboundEmptyPrefix = {
        ...base,
        children: [{
          ...root,
          name: { ...root.name, prefix: "p", namespaceUri: "" }
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(unboundEmptyPrefix)),
        BpmnXmlAst.Codes.InvalidNamespaceBinding
      )

      const duplicateAttribute = {
        ...base,
        children: [{
          ...root,
          attributes: [
            attribute,
            {
              ...attribute,
              name: { ...attribute.name, prefix: "y" }
            }
          ]
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(duplicateAttribute)),
        BpmnXmlAst.Codes.DuplicateAttribute
      )

      const duplicateNamespace = {
        ...base,
        children: [{
          ...root,
          namespaceDeclarations: [
            ...root.namespaceDeclarations,
            root.namespaceDeclarations[0]!
          ]
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(duplicateNamespace)),
        BpmnXmlAst.Codes.InvalidNamespaceBinding
      )

      const invalidNamespaceCharacter = {
        ...base,
        children: [{
          ...root,
          namespaceDeclarations: [{
            ...root.namespaceDeclarations[0]!,
            namespaceUri: "urn:\u0000invalid"
          }]
        }]
      }
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(invalidNamespaceCharacter)),
        BpmnXmlAst.Codes.InvalidCharacter
      )
    })

    it("rejects XML lexical forms that cannot be serialized safely", () => {
      const base = success(BpmnXmlAst.parse("<r/>"))
      const root = rootElement(base)
      const span = root.span
      const cases: ReadonlyArray<
        readonly [
          child: BpmnXmlAst.XmlNode,
          code: BpmnXmlAst.XmlDiagnosticCode
        ]
      > = [
        [{ _tag: "Comment", value: "bad--comment", span }, BpmnXmlAst.Codes.InvalidCharacter],
        [{ _tag: "CData", value: "bad]]>data", span }, BpmnXmlAst.Codes.InvalidCharacter],
        [
          { _tag: "ProcessingInstruction", target: "xml", body: "", span },
          BpmnXmlAst.Codes.InvalidName
        ],
        [
          { _tag: "ProcessingInstruction", target: "ok?><?evil", body: "", span },
          BpmnXmlAst.Codes.InvalidName
        ],
        [
          { _tag: "ProcessingInstruction", target: "p:q", body: "", span },
          BpmnXmlAst.Codes.InvalidName
        ],
        [
          { _tag: "ProcessingInstruction", target: "ok", body: "bad?>body", span },
          BpmnXmlAst.Codes.InvalidCharacter
        ],
        [
          { _tag: "ProcessingInstruction", target: "ok", body: " leading", span },
          BpmnXmlAst.Codes.InvalidDocument
        ],
        [{ _tag: "Text", value: "\u0000", span }, BpmnXmlAst.Codes.InvalidCharacter]
      ]

      for (const [child, code] of cases) {
        assert.strictEqual(
          failureCode(BpmnXmlAst.serialize({
            ...base,
            children: [{ ...root, children: [child] }]
          })),
          code
        )
      }

      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize(base, { format: "pretty", indent: "x" })),
        BpmnXmlAst.Codes.InvalidOptions
      )
      assert.strictEqual(
        failureCode(BpmnXmlAst.serialize({
          ...base,
          declaration: { version: "1.1", span }
        })),
        BpmnXmlAst.Codes.InvalidDocument
      )

      for (const value of ["\r", "\u00a0", "\u2028", "\ufeff"]) {
        assert.strictEqual(
          failureCode(BpmnXmlAst.serialize({
            ...base,
            children: [{ _tag: "Text", value, span }, root]
          })),
          BpmnXmlAst.Codes.InvalidDocument
        )
      }
      const documentWhitespace = success(BpmnXmlAst.serialize(
        success(BpmnXmlAst.parse("\t\n <r/>"))
      ))
      const reparsedWhitespace = success(BpmnXmlAst.parse(documentWhitespace))
      assert.strictEqual(reparsedWhitespace.children[0]!._tag, "Text")
      if (reparsedWhitespace.children[0]!._tag === "Text") {
        assert.strictEqual(reparsedWhitespace.children[0]!.value, "\t\n ")
      }
    })
  })
})
