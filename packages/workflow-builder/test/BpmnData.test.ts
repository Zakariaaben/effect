import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as BpmnData from "../src/BpmnData.ts"

const extensions = (): Array<BpmnData.ExtensionElement> => []

const local = (id: string): BpmnData.LocalQName => ({
  _tag: "LocalQName",
  id
})

const external = (
  namespaceUri: string,
  localName: string
): BpmnData.ExternalQName => ({
  _tag: "ExternalQName",
  namespaceUri,
  localName
})

const expression = (source: string): BpmnData.Expression => ({
  language: "feel",
  version: "1.0",
  source
})

const ownerContext = (): BpmnData.SemanticOwnerContext => ({
  contextKind: "BpmnDataOwnerContext",
  contextVersion: BpmnData.SemanticOwnerContextVersion,
  owners: [
    {
      _tag: "Process",
      id: "process-orders",
      supportedInterfaceRefs: []
    },
    {
      _tag: "SubProcess",
      id: "subprocess-quote",
      processId: "process-orders",
      parentScopeId: "process-orders"
    },
    {
      _tag: "SubProcess",
      id: "subprocess-nested",
      processId: "process-orders",
      parentScopeId: "subprocess-quote"
    },
    {
      _tag: "SubProcess",
      id: "subprocess-sibling",
      processId: "process-orders",
      parentScopeId: "process-orders"
    },
    {
      _tag: "Task",
      id: "task-price",
      processId: "process-orders",
      parentScopeId: "subprocess-nested",
      taskKind: "service"
    },
    {
      _tag: "CallActivity",
      id: "call-fulfilment",
      processId: "process-orders",
      parentScopeId: "process-orders"
    },
    {
      _tag: "GlobalTask",
      id: "global-price",
      supportedInterfaceRefs: [local("interface-pricing")]
    }
  ]
})

const ioSpecification = (
  id: string,
  ownerId: string,
  stem: string
): BpmnData.InputOutputSpecification => ({
  id,
  ownerId,
  dataInputs: [{
    id: `${stem}-input`,
    name: "",
    itemSubjectRef: local("item-order"),
    isCollection: false,
    dataState: {
      id: `${stem}-input-state`,
      name: "available",
      extensionElements: extensions()
    },
    extensionElements: extensions()
  }],
  dataOutputs: [{
    id: `${stem}-output`,
    name: "priced order",
    itemSubjectRef: local("item-order"),
    isCollection: false,
    extensionElements: extensions()
  }],
  inputSets: [{
    id: `${stem}-input-set`,
    dataInputRefs: [`${stem}-input`],
    optionalInputRefs: [],
    whileExecutingInputRefs: [`${stem}-input`],
    outputSetRefs: [`${stem}-output-set`],
    extensionElements: extensions()
  }],
  outputSets: [{
    id: `${stem}-output-set`,
    dataOutputRefs: [`${stem}-output`],
    optionalOutputRefs: [],
    whileExecutingOutputRefs: [],
    inputSetRefs: [`${stem}-input-set`],
    extensionElements: extensions()
  }],
  extensionElements: extensions()
})

const validDocument = (): BpmnData.BpmnDataDocument => ({
  documentKind: "BpmnDataDocument",
  documentVersion: BpmnData.BpmnDataDocumentVersion,
  bpmnSpecVersion: "2.0.2",
  extensionElements: [{
    namespaceUri: "urn:effect:test",
    localName: "origin",
    content: { source: "manual" }
  }],
  itemDefinitions: [
    {
      id: "item-order",
      structureRef: external("urn:example:types", "Order"),
      isCollection: false,
      itemKind: "information",
      importRef: "import-types",
      extensionElements: extensions()
    },
    {
      id: "item-lines",
      structureRef: external("urn:example:types", "Line"),
      isCollection: true,
      itemKind: "information",
      extensionElements: extensions()
    }
  ],
  dataStores: [{
    id: "store-orders",
    name: "Orders",
    capacity: 1000,
    isUnlimited: false,
    itemSubjectRef: local("item-order"),
    dataState: {
      id: "state-persisted",
      name: "persisted",
      extensionElements: extensions()
    },
    extensionElements: [{
      namespaceUri: "urn:effect:test",
      localName: "retention",
      content: { days: 30 }
    }]
  }],
  messages: [
    {
      id: "message-price-request",
      name: "",
      itemRef: local("item-order"),
      extensionElements: [{
        namespaceUri: "urn:effect:test",
        localName: "transport",
        content: { kind: "request" }
      }]
    },
    {
      id: "message-price-response",
      name: "PriceResponse",
      itemRef: local("item-order"),
      extensionElements: extensions()
    },
    {
      id: "message-imported",
      itemRef: external("urn:partner:types", "Payload"),
      extensionElements: extensions()
    }
  ],
  errors: [{
    id: "error-pricing",
    name: "PricingError",
    errorCode: "",
    structureRef: local("item-order"),
    extensionElements: [{
      namespaceUri: "urn:effect:test",
      localName: "retryable",
      content: true
    }]
  }],
  interfaces: [{
    id: "interface-pricing",
    name: "",
    implementationRef: external("urn:example:services", "PricingPort"),
    operations: [{
      id: "operation-price",
      name: "price",
      implementationRef: external("urn:example:services", "price"),
      inMessageRef: local("message-price-request"),
      outMessageRef: local("message-price-response"),
      errorRefs: [local("error-pricing")],
      extensionElements: extensions()
    }],
    extensionElements: extensions()
  }],
  dataObjects: [
    {
      id: "data-order",
      containerId: "process-orders",
      name: "Order",
      itemSubjectRef: local("item-order"),
      isCollection: false,
      extensionElements: extensions()
    },
    {
      id: "data-quote",
      containerId: "subprocess-quote",
      name: "Quote",
      itemSubjectRef: local("item-order"),
      isCollection: false,
      extensionElements: extensions()
    },
    {
      id: "data-lines",
      containerId: "subprocess-quote",
      name: "Lines",
      itemSubjectRef: local("item-lines"),
      isCollection: true,
      extensionElements: extensions()
    }
  ],
  dataObjectReferences: [
    {
      id: "data-order-ref",
      containerId: "subprocess-nested",
      dataObjectRef: "data-order",
      dataState: {
        id: "state-quoted",
        name: "quoted",
        extensionElements: extensions()
      },
      extensionElements: extensions()
    },
    {
      id: "data-quote-ref",
      containerId: "subprocess-nested",
      dataObjectRef: "data-quote",
      extensionElements: extensions()
    },
    {
      id: "data-lines-ref",
      containerId: "subprocess-nested",
      dataObjectRef: "data-lines",
      extensionElements: extensions()
    }
  ],
  dataStoreReferences: [{
    id: "store-orders-ref",
    containerId: "subprocess-nested",
    name: "Orders store",
    itemSubjectRef: local("item-order"),
    dataStoreRef: local("store-orders"),
    extensionElements: extensions()
  }],
  properties: [{
    id: "property-correlation",
    ownerId: "process-orders",
    name: "Correlation",
    itemSubjectRef: local("item-order"),
    extensionElements: extensions()
  }],
  inputOutputSpecifications: [
    ioSpecification("io-price", "task-price", "price"),
    ioSpecification("io-global-price", "global-price", "global-price"),
    ioSpecification("io-process", "process-orders", "process")
  ],
  dataAssociations: [
    {
      _tag: "DataInputAssociation",
      id: "association-input",
      ownerId: "task-price",
      sourceRefs: ["process-input"],
      targetRef: "price-input",
      assignments: [{
        id: "assignment-correlation",
        from: expression("quote.id"),
        to: expression("correlation"),
        extensionElements: extensions()
      }],
      extensionElements: extensions()
    },
    {
      _tag: "DataOutputAssociation",
      id: "association-output",
      ownerId: "task-price",
      sourceRefs: ["price-output"],
      targetRef: "process-output",
      assignments: [],
      extensionElements: extensions()
    }
  ],
  inputOutputBindings: [{
    id: "binding-price",
    ownerId: "global-price",
    operationRef: local("operation-price"),
    inputDataRef: "global-price-input",
    outputDataRef: "global-price-output",
    extensionElements: extensions()
  }]
})

const diagnosticsOf = (
  result: ReturnType<typeof BpmnData.validate>
) => {
  assert(Result.isFailure(result))
  return result.failure.diagnostics
}

describe("BpmnData", () => {
  it("accepts the bounded rich graph with ancestor accessibility and callable binding", () => {
    const result = BpmnData.validate(validDocument(), ownerContext())
    assert(Result.isSuccess(result))
    assert.deepStrictEqual(result.success, validDocument())
    assert(Object.isFrozen(result.success))
    assert(Object.isFrozen(result.success.messages[0]!.extensionElements))
    assert.equal(result.success.messages[0]!.name, "")
    assert.equal(result.success.errors[0]!.errorCode, "")
  })

  it("distinguishes resolvable local QNames from accepted external QNames", () => {
    const valid = BpmnData.validate(validDocument(), ownerContext())
    assert(Result.isSuccess(valid))

    const document = validDocument()
    document.messages[0]!.itemRef = local("missing-item")
    document.interfaces[0]!.operations[0]!.inMessageRef = local("missing-message")
    document.errors[0]!.structureRef = external("urn:partner:types", "Fault")

    const diagnostics = diagnosticsOf(BpmnData.validate(document, ownerContext()))
    assert.equal(
      diagnostics.filter((diagnostic) => diagnostic.code === BpmnData.Codes.UnknownLocalQNameRef).length,
      2
    )
    assert(
      diagnostics.every((diagnostic) => !diagnostic.message.includes("urn:partner:types"))
    )
  })

  it("checks explicit collection defaults and untransformed item compatibility", () => {
    const document = validDocument()
    document.inputOutputSpecifications[0]!.dataInputs[0]!.isCollection = true
    document.dataAssociations[0]!.sourceRefs = ["data-lines-ref"]

    const diagnostics = diagnosticsOf(BpmnData.validate(document, ownerContext()))
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidCollectionCompatibility)
    )
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidItemCompatibility)
    )

    const collectionOnly = validDocument()
    collectionOnly.dataObjects.push({
      id: "data-untyped-collection",
      containerId: "process-orders",
      isCollection: true,
      extensionElements: extensions()
    })
    delete (collectionOnly.inputOutputSpecifications[0]!.dataInputs[0] as unknown as Record<
      string,
      unknown
    >).itemSubjectRef
    collectionOnly.dataAssociations[0]!.sourceRefs = ["data-untyped-collection"]
    const collectionDiagnostics = diagnosticsOf(
      BpmnData.validate(collectionOnly, ownerContext())
    )
    assert(
      collectionDiagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidItemCompatibility)
    )
  })

  it("enforces association source cardinality and permits zero sources with a transformation", () => {
    const invalid = validDocument()
    invalid.dataAssociations[0]!.sourceRefs = []
    const diagnostics = diagnosticsOf(BpmnData.validate(invalid, ownerContext()))
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidAssociationCardinality)
    )

    const transformed = validDocument()
    transformed.dataAssociations[0]!.sourceRefs = []
    transformed.dataAssociations[0]!.transformation = expression("lookup()")
    assert(Result.isSuccess(BpmnData.validate(transformed, ownerContext())))
  })

  it("validates DataObjectReference containment and descendant accessibility", () => {
    const document = validDocument()
    document.dataObjectReferences[1]!.containerId = "subprocess-sibling"

    const diagnostics = diagnosticsOf(BpmnData.validate(document, ownerContext()))
    assert(
      diagnostics.some((diagnostic) =>
        diagnostic.code === BpmnData.Codes.InvalidContainment &&
        diagnostic.path.join("/") === "dataObjectReferences/1/dataObjectRef"
      )
    )

    const ancestorReference = validDocument()
    ancestorReference.dataObjectReferences[1]!.dataObjectRef = "data-order"
    assert(Result.isSuccess(BpmnData.validate(ancestorReference, ownerContext())))
  })

  it("rejects inaccessible sibling data and invalid association orientation", () => {
    const document = validDocument()
    document.dataObjects.push({
      id: "data-sibling",
      containerId: "subprocess-sibling",
      itemSubjectRef: local("item-order"),
      isCollection: false,
      extensionElements: extensions()
    })
    document.dataAssociations[0]!.sourceRefs = ["data-sibling"]
    document.dataAssociations[1]!.sourceRefs = ["data-order-ref"]
    document.dataAssociations[1]!.targetRef = "price-input"

    const diagnostics = diagnosticsOf(BpmnData.validate(document, ownerContext()))
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InaccessibleDataRef)
    )
    assert(
      diagnostics.filter((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidAssociationEndpoint).length >= 2
    )
  })

  it("requires reciprocal IO-set rules and exact local membership", () => {
    const document = validDocument()
    const specification = document.inputOutputSpecifications[0]!
    specification.inputSets[0]!.outputSetRefs = []
    specification.outputSets[0]!.dataOutputRefs = []
    specification.inputSets[0]!.optionalInputRefs = ["missing-input"]

    const diagnostics = diagnosticsOf(BpmnData.validate(document, ownerContext()))
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidIoSetReciprocity)
    )
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidIoSetMembership)
    )
  })

  it("binds only CallableElements to operations from supported Interfaces", () => {
    const unsupportedContext = ownerContext()
    const global = unsupportedContext.owners.find((owner) => owner._tag === "GlobalTask")!
    assert(global._tag === "GlobalTask")
    global.supportedInterfaceRefs = []

    const unsupported = diagnosticsOf(
      BpmnData.validate(validDocument(), unsupportedContext)
    )
    assert(
      unsupported.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidBinding)
    )

    const externalOperation = validDocument()
    externalOperation.inputOutputBindings[0]!.operationRef = external(
      "urn:partner:services",
      "price"
    )
    const externalDiagnostics = diagnosticsOf(
      BpmnData.validate(externalOperation, ownerContext())
    )
    assert(
      externalDiagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.UnsupportedExternalOperationBinding)
    )

    const taskBinding = validDocument()
    taskBinding.inputOutputBindings[0]!.ownerId = "task-price"
    taskBinding.inputOutputBindings[0]!.inputDataRef = "price-input"
    taskBinding.inputOutputBindings[0]!.outputDataRef = "price-output"
    const taskDiagnostics = diagnosticsOf(
      BpmnData.validate(taskBinding, ownerContext())
    )
    assert(
      taskDiagnostics.some((diagnostic) =>
        diagnostic.code === BpmnData.Codes.InvalidBinding &&
        diagnostic.path.join("/") === "inputOutputBindings/0/ownerId"
      )
    )
  })

  it("rejects invented base associations and DataObjectReference item overrides", () => {
    const baseAssociation = validDocument() as unknown as {
      dataAssociations: Array<Record<string, unknown>>
    }
    delete baseAssociation.dataAssociations[0]!._tag
    assert.equal(
      diagnosticsOf(BpmnData.validate(baseAssociation, ownerContext()))[0]!.code,
      BpmnData.Codes.InvalidDocument
    )

    const itemOverride = validDocument() as unknown as {
      dataObjectReferences: Array<Record<string, unknown>>
    }
    itemOverride.dataObjectReferences[0]!.itemSubjectRef = local("item-lines")
    assert.equal(
      diagnosticsOf(BpmnData.validate(itemOverride, ownerContext()))[0]!.code,
      BpmnData.Codes.InvalidDocument
    )
  })

  it("rejects direct Event IO as outside the typed owner boundary", () => {
    const context = ownerContext() as unknown as {
      owners: Array<Record<string, unknown>>
    }
    context.owners.push({
      _tag: "Event",
      id: "catch-message",
      processId: "process-orders",
      parentScopeId: "process-orders"
    })

    const diagnostics = diagnosticsOf(BpmnData.validate(validDocument(), context))
    assert.equal(diagnostics[0]!.code, BpmnData.Codes.InvalidOwnerContext)
  })

  it("enforces XSD cardinalities and one IO specification per owner", () => {
    const noInputSet = validDocument() as unknown as {
      inputOutputSpecifications: Array<{ inputSets: Array<unknown> }>
    }
    noInputSet.inputOutputSpecifications[0]!.inputSets = []
    assert.equal(
      diagnosticsOf(BpmnData.validate(noInputSet, ownerContext()))[0]!.code,
      BpmnData.Codes.InvalidDocument
    )

    const noOperation = validDocument() as unknown as {
      interfaces: Array<{ operations: Array<unknown> }>
    }
    noOperation.interfaces[0]!.operations = []
    assert.equal(
      diagnosticsOf(BpmnData.validate(noOperation, ownerContext()))[0]!.code,
      BpmnData.Codes.InvalidDocument
    )

    const duplicateIo = validDocument()
    duplicateIo.inputOutputSpecifications.push(
      ioSpecification("io-price-2", "task-price", "price-2")
    )
    const diagnostics = diagnosticsOf(
      BpmnData.validate(duplicateIo, ownerContext())
    )
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidContainment)
    )
  })

  it("requires typed context for scoped data and validates context containment", () => {
    assert.equal(
      diagnosticsOf(BpmnData.validate(validDocument()))[0]!.code,
      BpmnData.Codes.MissingOwnerContext
    )

    const context = ownerContext()
    const nested = context.owners.find((owner) => owner._tag === "SubProcess" && owner.id === "subprocess-nested")!
    assert(nested._tag === "SubProcess")
    nested.parentScopeId = "subprocess-sibling"
    nested.processId = "missing-process"
    const diagnostics = diagnosticsOf(BpmnData.validate(validDocument(), context))
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === BpmnData.Codes.InvalidContainment)
    )
  })

  it("does not invoke hostile document or owner-context getters", () => {
    let documentCalls = 0
    const document = validDocument() as unknown as Record<string, unknown>
    Object.defineProperty(document, "interfaces", {
      enumerable: true,
      get() {
        documentCalls++
        throw new Error("must not run")
      }
    })
    const documentDiagnostics = diagnosticsOf(
      BpmnData.validate(document, ownerContext())
    )
    assert.equal(documentCalls, 0)
    assert.equal(documentDiagnostics[0]!.code, BpmnData.Codes.InvalidJson)

    let contextCalls = 0
    const context = ownerContext() as unknown as Record<string, unknown>
    Object.defineProperty(context, "owners", {
      enumerable: true,
      get() {
        contextCalls++
        throw new Error("must not run")
      }
    })
    const contextDiagnostics = diagnosticsOf(
      BpmnData.validate(validDocument(), context)
    )
    assert.equal(contextCalls, 0)
    assert.equal(contextDiagnostics[0]!.code, BpmnData.Codes.InvalidOwnerContext)

    const proxy = new Proxy(validDocument(), {
      ownKeys() {
        throw new Error("hostile proxy")
      }
    })
    assert.equal(
      diagnosticsOf(BpmnData.validate(proxy, ownerContext()))[0]!.code,
      BpmnData.Codes.InvalidJson
    )
  })

  it("rejects strict excess properties at nested levels", () => {
    const document = validDocument() as unknown as {
      interfaces: Array<{ operations: Array<Record<string, unknown>> }>
    }
    document.interfaces[0]!.operations[0]!.unexpected = true
    const diagnostics = diagnosticsOf(BpmnData.validate(document, ownerContext()))
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0]!.code, BpmnData.Codes.InvalidDocument)
  })
})
