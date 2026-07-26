/**
 * BPMN 2.0 interchange: standard-notation design over the portable plan.
 *
 * BPMN is a *lens*, not a second execution semantics. {@link toPlan} imports
 * the executable subset of a BPMN 2.0 XML document into a plan v2 — the only
 * format the engine runs — and fails closed with aggregate, path-addressed
 * diagnostics on anything outside that subset. {@link fromPlan} renders a
 * plan back as standard BPMN XML (with diagram interchange when layout is
 * known) so any BPMN modeler can display and edit it.
 *
 * Vocabulary pins, configuration, bindings, policies, and data wiring ride
 * in the `wb` extension namespace — the same pattern Camunda and Zeebe use —
 * so a round trip through a standards-compliant modeler preserves execution
 * meaning exactly.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { SaxesParser } from "saxes"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"
import * as Plan from "./Plan.ts"

// ----------------------------------------------------------------------------
// Namespaces and diagnostics
// ----------------------------------------------------------------------------

const BPMN = "http://www.omg.org/spec/BPMN/20100524/MODEL"
const BPMNDI = "http://www.omg.org/spec/BPMN/20100524/DI"
const DC = "http://www.omg.org/spec/DD/20100524/DC"

/**
 * The extension namespace carrying execution meaning through BPMN documents.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExtensionNamespace = "http://effect.website/workflow-builder"

/**
 * The expression language URI for BPMN `conditionExpression` bodies.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExpressionLanguage = `${ExtensionNamespace}/expression`

/**
 * Stable diagnostic codes emitted by the BPMN importer and exporter.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidXml: "BpmnInvalidXml",
  MissingProcess: "BpmnMissingProcess",
  MultipleProcesses: "BpmnMultipleProcesses",
  UnsupportedElement: "BpmnUnsupportedElement",
  MissingStart: "BpmnMissingStart",
  MultipleStarts: "BpmnMultipleStarts",
  MissingVocabularyPin: "BpmnMissingVocabularyPin",
  InvalidExtension: "BpmnInvalidExtension",
  InvalidExpression: "BpmnInvalidExpression",
  InvalidDuration: "BpmnInvalidDuration",
  AmbiguousOutcome: "BpmnAmbiguousOutcome",
  UnresolvedReference: "BpmnUnresolvedReference",
  GatewayShape: "BpmnGatewayShape",
  InvalidPlan: "BpmnInvalidPlan"
} as const

/**
 * Failure aggregating every independent problem found in one pass.
 *
 * @category errors
 * @since 4.0.0
 */
export class BpmnError extends Schema.ErrorClass<BpmnError>(
  "@effect/workflow-builder/Bpmn/BpmnError"
)({
  _tag: Schema.tag("BpmnError"),
  diagnostics: Schema.NonEmptyArray(Diagnostic.Diagnostic)
}) {}

// ----------------------------------------------------------------------------
// Minimal namespaced XML infoset
// ----------------------------------------------------------------------------

interface XmlElement {
  readonly uri: string
  readonly local: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: ReadonlyArray<XmlElement>
  readonly text: string
}

const parseXml = (xml: string): Result.Result<XmlElement, string> => {
  const parser = new SaxesParser({ xmlns: true })
  const stack: Array<{
    uri: string
    local: string
    attributes: Record<string, string>
    children: Array<XmlElement>
    text: string
  }> = []
  let root: XmlElement | undefined
  let failure: string | undefined

  parser.on("error", (error) => {
    failure = failure ?? String(error.message ?? error)
  })
  parser.on("opentag", (tag) => {
    const attributes: Record<string, string> = {}
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === "http://www.w3.org/2000/xmlns/") {
        continue
      }
      attributes[attribute.local] = attribute.value
    }
    stack.push({
      uri: tag.uri ?? "",
      local: tag.local,
      attributes,
      children: [],
      text: ""
    })
  })
  parser.on("text", (text) => {
    const current = stack[stack.length - 1]
    if (current !== undefined) {
      current.text += text
    }
  })
  parser.on("cdata", (text) => {
    const current = stack[stack.length - 1]
    if (current !== undefined) {
      current.text += text
    }
  })
  parser.on("closetag", () => {
    const finished = stack.pop()!
    const element: XmlElement = Object.freeze({
      uri: finished.uri,
      local: finished.local,
      attributes: Object.freeze(finished.attributes),
      children: Object.freeze(finished.children),
      text: finished.text
    })
    const parent = stack[stack.length - 1]
    if (parent !== undefined) {
      parent.children.push(element)
    } else {
      root = element
    }
  })

  try {
    parser.write(xml).close()
  } catch (error) {
    return Result.fail(String(error))
  }
  if (failure !== undefined) {
    return Result.fail(failure)
  }
  if (root === undefined) {
    return Result.fail("The document contains no root element")
  }
  return Result.succeed(root)
}

const childrenOf = (element: XmlElement, uri: string, local: string): ReadonlyArray<XmlElement> =>
  element.children.filter((child) => child.uri === uri && child.local === local)

const childOf = (element: XmlElement, uri: string, local: string): XmlElement | undefined =>
  element.children.find((child) => child.uri === uri && child.local === local)

const extensionOf = (element: XmlElement, local: string): XmlElement | undefined => {
  const extensions = childOf(element, BPMN, "extensionElements")
  return extensions === undefined ? undefined : childOf(extensions, ExtensionNamespace, local)
}

// ----------------------------------------------------------------------------
// ISO-8601 durations (day/time subset)
// ----------------------------------------------------------------------------

const durationPattern = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/

/**
 * Parses the calendar-free ISO-8601 duration subset (`PnDTnHnMnS`) into
 * whole milliseconds. Calendar-relative units (years, months, weeks) are
 * rejected because they have no fixed length.
 *
 * @category interchange
 * @since 4.0.0
 */
export const parseDurationMillis = (text: string): number | undefined => {
  const match = durationPattern.exec(text.trim())
  if (
    match === null || (match[1] === undefined && match[2] === undefined &&
      match[3] === undefined && match[4] === undefined)
  ) {
    return undefined
  }
  const days = match[1] === undefined ? 0 : Number(match[1])
  const hours = match[2] === undefined ? 0 : Number(match[2])
  const minutes = match[3] === undefined ? 0 : Number(match[3])
  const seconds = match[4] === undefined ? 0 : Number(match[4])
  const millis = Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000)
  return Number.isSafeInteger(millis) && millis > 0 ? millis : undefined
}

const renderDuration = (millis: number): string => {
  let seconds = millis / 1000
  const days = Math.floor(seconds / 86400)
  seconds -= days * 86400
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60
  const date = days > 0 ? `${days}D` : ""
  const time = [
    hours > 0 ? `${hours}H` : "",
    minutes > 0 ? `${minutes}M` : "",
    seconds > 0 ? `${Number(seconds.toFixed(3))}S` : ""
  ].join("")
  return `P${date}${time === "" ? "T0S" : `T${time}`}`
}

// ----------------------------------------------------------------------------
// Import
// ----------------------------------------------------------------------------

/**
 * Options for {@link toPlan}.
 *
 * @category models
 * @since 4.0.0
 */
export interface ImportOptions {
  /** The workflow definition the plan targets. */
  readonly definition: { readonly id: string; readonly version: string }
  /** Plan id; defaults to the BPMN process id. */
  readonly planId?: string | undefined
  /** Plan revision; defaults to `1`. */
  readonly revision?: number | undefined
}

/**
 * The result of a successful import.
 *
 * @category models
 * @since 4.0.0
 */
export interface Imported {
  readonly plan: Plan.Plan
  readonly warnings: ReadonlyArray<Diagnostic.Diagnostic>
}

interface ImportedNode {
  readonly id: string
  readonly type: string
  readonly version: string
  readonly config: Schema.Json
  readonly bindings?: Schema.Json
  readonly policy?: Schema.Json
  readonly join?: string
}

type Resolution =
  | { readonly _tag: "Node"; readonly id: string }
  | { readonly _tag: "Start" }
  | { readonly _tag: "End" }
  | { readonly _tag: "Dissolved"; readonly id: string }
  | { readonly _tag: "Boundary"; readonly attachedTo: string }

interface Flow {
  readonly id: string
  readonly sourceRef: string
  readonly targetRef: string
  readonly name: string | undefined
  readonly outcome: string | undefined
  readonly element: XmlElement
}

const supportedProcessChildren = new Set([
  "startEvent",
  "endEvent",
  "task",
  "serviceTask",
  "userTask",
  "exclusiveGateway",
  "parallelGateway",
  "intermediateCatchEvent",
  "boundaryEvent",
  "callActivity",
  "sequenceFlow",
  "extensionElements",
  "documentation",
  "laneSet",
  "textAnnotation",
  "association"
])

/**
 * Imports the executable subset of a BPMN 2.0 XML document as a portable
 * plan.
 *
 * **Details**
 *
 * Elements carrying a `wb:node` extension import exactly as pinned; plain
 * BPMN maps by convention (`userTask` → human task, exclusive gateways with
 * conditions → switch, timer/message catches → delay/receive, interrupting
 * error boundaries → `error`-outcome edges, error end events → fail,
 * `callActivity` → sub-workflow or for-each). Converging and plain parallel
 * gateways dissolve into edges — the plan's join semantics carry their
 * meaning. Everything else fails closed with a diagnostic naming the
 * offending element; nothing silently degrades.
 *
 * The imported plan is untrusted data like any other: compile it against
 * the vocabulary before saving or running it.
 *
 * @category interchange
 * @since 4.0.0
 */
export const toPlan = Effect.fnUntraced(function*(
  xml: string,
  options: ImportOptions
): Effect.fn.Return<Imported, BpmnError> {
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const warnings: Array<Diagnostic.Diagnostic> = []
  const fail = (): Effect.Effect<never, BpmnError> =>
    Effect.fail(
      new BpmnError({
        diagnostics: diagnostics as [Diagnostic.Diagnostic, ...Array<Diagnostic.Diagnostic>]
      })
    )
  const report = (code: string, message: string, path: ReadonlyArray<Diagnostic.PathSegment> = []) => {
    diagnostics.push(Diagnostic.error(code, message, path))
  }

  const parsed = parseXml(xml)
  if (Result.isFailure(parsed)) {
    report(Codes.InvalidXml, parsed.failure)
    return yield* fail()
  }
  const definitions = parsed.success
  if (definitions.uri !== BPMN || definitions.local !== "definitions") {
    report(Codes.InvalidXml, "The root element must be bpmn:definitions")
    return yield* fail()
  }
  const processes = childrenOf(definitions, BPMN, "process")
  if (processes.length === 0) {
    report(Codes.MissingProcess, "The document contains no bpmn:process")
    return yield* fail()
  }
  if (processes.length > 1) {
    report(Codes.MultipleProcesses, "Collaborations with multiple processes are not supported")
    return yield* fail()
  }
  const process = processes[0]!
  const processId = process.attributes.id ?? "process"

  const messages = new Map<string, string>()
  for (const message of childrenOf(definitions, BPMN, "message")) {
    if (message.attributes.id !== undefined) {
      messages.set(message.attributes.id, message.attributes.name ?? message.attributes.id)
    }
  }

  const jsonExtension = (
    element: XmlElement,
    local: string,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): Schema.Json | undefined => {
    const extension = extensionOf(element, local)
    if (extension === undefined) {
      return undefined
    }
    try {
      return JSON.parse(extension.text) as Schema.Json
    } catch {
      report(Codes.InvalidExtension, `wb:${local} must contain JSON`, path)
      return undefined
    }
  }

  const expressionOf = (
    element: XmlElement,
    path: ReadonlyArray<Diagnostic.PathSegment>
  ): Schema.Json | undefined => {
    const language = element.attributes.language
    if (language !== undefined && language !== ExpressionLanguage) {
      report(
        Codes.InvalidExpression,
        `Condition expressions must use the '${ExpressionLanguage}' language`,
        path
      )
      return undefined
    }
    try {
      return JSON.parse(element.text) as Schema.Json
    } catch {
      report(Codes.InvalidExpression, "Condition expressions must contain a JSON expression document", path)
      return undefined
    }
  }

  // --- first pass: classify every element ----------------------------------

  const nodes: Array<ImportedNode> = []
  const resolutions = new Map<string, Resolution>()
  const flows: Array<Flow> = []
  const gatewayFlowOutcomes = new Map<string, string>()
  const gatewaysWithoutDefault: Array<string> = []
  const outcomesByNode = new Map<string, ReadonlyArray<string>>()
  const flowsBySource = new Map<string, Array<Flow>>()
  const flowsByTarget = new Map<string, Array<Flow>>()
  let startCount = 0

  const addNode = (node: ImportedNode) => {
    nodes.push(node)
    resolutions.set(node.id, { _tag: "Node", id: node.id })
  }

  const elementPath = (element: XmlElement): ReadonlyArray<Diagnostic.PathSegment> => [
    element.local,
    element.attributes.id ?? ""
  ]

  for (const element of process.children) {
    if (element.uri !== BPMN) {
      continue
    }
    if (!supportedProcessChildren.has(element.local)) {
      report(
        Codes.UnsupportedElement,
        `bpmn:${element.local} is outside the executable subset`,
        elementPath(element)
      )
      continue
    }
    if (element.local === "sequenceFlow") {
      const flow: Flow = {
        id: element.attributes.id ?? `flow_${flows.length}`,
        sourceRef: element.attributes.sourceRef ?? "",
        targetRef: element.attributes.targetRef ?? "",
        name: element.attributes.name,
        outcome: element.attributes.outcome,
        element
      }
      flows.push(flow)
      const bySource = flowsBySource.get(flow.sourceRef) ?? []
      bySource.push(flow)
      flowsBySource.set(flow.sourceRef, bySource)
      const byTarget = flowsByTarget.get(flow.targetRef) ?? []
      byTarget.push(flow)
      flowsByTarget.set(flow.targetRef, byTarget)
    }
  }

  for (const element of process.children) {
    if (element.uri !== BPMN || !supportedProcessChildren.has(element.local)) {
      continue
    }
    const id = element.attributes.id ?? ""
    const path = elementPath(element)
    const pin = extensionOf(element, "node")
    const config = jsonExtension(element, "config", path)
    const bindings = jsonExtension(element, "bindings", path)
    const policy = jsonExtension(element, "policy", path)
    const join = extensionOf(element, "join")?.text.trim()
    const withCommon = (node: ImportedNode): ImportedNode => ({
      ...node,
      ...(bindings === undefined ? undefined : { bindings }),
      ...(policy === undefined ? undefined : { policy }),
      ...(join === undefined || join === "" ? undefined : { join })
    })
    const pinned = (fallback: () => void) => {
      if (pin !== undefined) {
        const type = pin.attributes.type
        const version = pin.attributes.version
        if (type === undefined || version === undefined) {
          report(Codes.InvalidExtension, "wb:node requires 'type' and 'version' attributes", path)
          return
        }
        addNode(withCommon({ id, type, version, config: config ?? {} }))
        return
      }
      fallback()
    }

    switch (element.local) {
      case "sequenceFlow":
      case "extensionElements":
      case "documentation":
      case "laneSet":
      case "textAnnotation":
      case "association":
        break

      case "startEvent": {
        startCount++
        if (element.children.some((child) => child.uri === BPMN && child.local.endsWith("EventDefinition"))) {
          report(Codes.UnsupportedElement, "Only none start events are supported", path)
          break
        }
        resolutions.set(id, { _tag: "Start" })
        break
      }

      case "endEvent": {
        const error = childOf(element, BPMN, "errorEventDefinition")
        const others = element.children.filter((child) =>
          child.uri === BPMN && child.local.endsWith("EventDefinition") && child.local !== "errorEventDefinition"
        )
        if (others.length > 0) {
          report(Codes.UnsupportedElement, `Unsupported end event definition on '${id}'`, path)
          break
        }
        if (error === undefined) {
          resolutions.set(id, { _tag: "End" })
          break
        }
        pinned(() => {
          addNode(withCommon({
            id,
            type: "workflow/fail",
            version: "1.0.0",
            config: config ?? { code: error.attributes.errorRef ?? element.attributes.name ?? id }
          }))
        })
        break
      }

      case "userTask": {
        pinned(() => {
          const explicit = jsonExtension(element, "outcomes", path)
          const derived = (flowsBySource.get(id) ?? [])
            .map((flow) => flow.outcome ?? flow.name)
            .filter((outcome): outcome is string => outcome !== undefined && outcome.length > 0)
          const outcomes = explicit ?? (derived.length > 0 ? derived : ["done"])
          const base = {
            title: element.attributes.name ?? id,
            outcomes
          }
          const merged = config !== null && typeof config === "object" && !Array.isArray(config)
            ? { ...base, ...config }
            : base
          addNode(withCommon({ id, type: "workflow/humanTask", version: "1.0.0", config: merged }))
        })
        const node = nodes.find((candidate) => candidate.id === id)
        if (
          node !== undefined && node.config !== null && typeof node.config === "object" &&
          !Array.isArray(node.config) && Array.isArray((node.config as { outcomes?: unknown }).outcomes)
        ) {
          outcomesByNode.set(id, (node.config as { outcomes: ReadonlyArray<string> }).outcomes)
        }
        break
      }

      case "task":
      case "serviceTask": {
        pinned(() => {
          report(
            Codes.MissingVocabularyPin,
            `bpmn:${element.local} '${id}' requires a wb:node extension naming a registered node kind`,
            path
          )
        })
        break
      }

      case "callActivity": {
        pinned(() => {
          const calledElement = element.attributes.calledElement
          if (calledElement === undefined) {
            report(Codes.UnresolvedReference, `callActivity '${id}' requires calledElement`, path)
            return
          }
          const multiInstance = childOf(element, BPMN, "multiInstanceLoopCharacteristics")
          const base = { plan: { planId: calledElement } }
          const merged = config !== null && typeof config === "object" && !Array.isArray(config)
            ? { ...base, ...config }
            : base
          if (multiInstance === undefined) {
            addNode(withCommon({ id, type: "workflow/subWorkflow", version: "1.0.0", config: merged }))
            return
          }
          const sequential = multiInstance.attributes.isSequential === "true"
          const forEach: Record<string, Schema.Json> = {
            mode: sequential ? "sequential" : "parallel",
            ...merged
          }
          if (forEach.items === undefined) {
            report(
              Codes.InvalidExtension,
              `Multi-instance callActivity '${id}' requires an 'items' expression in wb:config`,
              path
            )
            return
          }
          addNode(withCommon({ id, type: "workflow/forEach", version: "1.0.0", config: forEach }))
        })
        break
      }

      case "intermediateCatchEvent": {
        pinned(() => {
          const timer = childOf(element, BPMN, "timerEventDefinition")
          const message = childOf(element, BPMN, "messageEventDefinition")
          if (timer !== undefined) {
            const duration = childOf(timer, BPMN, "timeDuration")
            if (duration === undefined) {
              report(Codes.UnsupportedElement, `Timer '${id}' supports only timeDuration`, path)
              return
            }
            const millis = parseDurationMillis(duration.text)
            if (millis === undefined) {
              report(
                Codes.InvalidDuration,
                `Timer '${id}' duration must be a positive calendar-free ISO-8601 duration`,
                path
              )
              return
            }
            addNode(withCommon({
              id,
              type: "workflow/delay",
              version: "1.0.0",
              config: config ?? { durationMillis: millis }
            }))
            return
          }
          if (message !== undefined) {
            const reference = message.attributes.messageRef
            const signal = reference === undefined ? undefined : messages.get(reference) ?? reference
            if (signal === undefined) {
              report(Codes.UnresolvedReference, `Message catch '${id}' requires messageRef`, path)
              return
            }
            addNode(withCommon({
              id,
              type: "workflow/receive",
              version: "1.0.0",
              config: config ?? { signal }
            }))
            return
          }
          report(Codes.UnsupportedElement, `Catch event '${id}' supports only timer or message definitions`, path)
        })
        break
      }

      case "exclusiveGateway": {
        const outgoing = flowsBySource.get(id) ?? []
        // A pinned gateway is always honored as a node; only an unpinned
        // pass-through (0 or 1 outgoing flow, no explicit routing) dissolves.
        if (pin === undefined && outgoing.length <= 1) {
          resolutions.set(id, { _tag: "Dissolved", id })
          break
        }
        pinned(() => {
          const defaultFlow = element.attributes.default
          // BPMN mandates a runtime error when no outgoing flow is enabled and
          // no default is declared. Our switch would instead complete on an
          // unwired `default`; synthesize a fail so the semantics match.
          if (defaultFlow === undefined) {
            gatewaysWithoutDefault.push(id)
          }
          const cases: Array<{ name: string; condition: Schema.Json }> = []
          for (const flow of outgoing) {
            const name = flow.outcome ?? flow.name ?? flow.id
            if (flow.id === defaultFlow) {
              gatewayFlowOutcomes.set(flow.id, "default")
              continue
            }
            const condition = childOf(flow.element, BPMN, "conditionExpression")
            if (condition === undefined) {
              report(
                Codes.GatewayShape,
                `Exclusive gateway '${id}': non-default flow '${flow.id}' requires a condition`,
                path
              )
              continue
            }
            const expression = expressionOf(condition, [...path, flow.id])
            if (expression === undefined) {
              continue
            }
            cases.push({ name, condition: expression })
            gatewayFlowOutcomes.set(flow.id, name)
          }
          addNode(withCommon({
            id,
            type: "workflow/switch",
            version: "1.0.0",
            config: config ?? { cases }
          }))
        })
        if (pin !== undefined) {
          for (const flow of flowsBySource.get(id) ?? []) {
            const outcome = flow.outcome ?? flow.name
            if (outcome !== undefined) {
              gatewayFlowOutcomes.set(flow.id, outcome)
            }
          }
        }
        break
      }

      case "parallelGateway": {
        const incoming = flowsByTarget.get(id) ?? []
        const outgoing = flowsBySource.get(id) ?? []
        if (incoming.length > 1 && outgoing.length > 1) {
          report(
            Codes.GatewayShape,
            `Parallel gateway '${id}' may not both join and split; use two gateways`,
            path
          )
          break
        }
        resolutions.set(id, { _tag: "Dissolved", id })
        break
      }

      case "boundaryEvent": {
        const attachedTo = element.attributes.attachedToRef
        const error = childOf(element, BPMN, "errorEventDefinition")
        if (attachedTo === undefined || error === undefined || element.attributes.cancelActivity === "false") {
          report(
            Codes.UnsupportedElement,
            `Boundary event '${id}' supports only interrupting error definitions on an activity`,
            path
          )
          break
        }
        resolutions.set(id, { _tag: "Boundary", attachedTo })
        break
      }
    }
  }

  if (startCount === 0) {
    report(Codes.MissingStart, "The process requires exactly one none start event")
  }
  if (startCount > 1) {
    report(Codes.MultipleStarts, "The process requires exactly one none start event")
  }

  // --- second pass: resolve flows into control edges ------------------------

  interface EdgeSource {
    readonly nodeId: string
    readonly outcome: string | undefined
  }

  const sourcesOf = (flow: Flow, seen: ReadonlySet<string>): ReadonlyArray<EdgeSource> => {
    const resolution = resolutions.get(flow.sourceRef)
    if (resolution === undefined) {
      report(Codes.UnresolvedReference, `Flow '${flow.id}' references unknown source '${flow.sourceRef}'`)
      return []
    }
    switch (resolution._tag) {
      case "Start":
      case "End":
        return []
      case "Boundary":
        return [{ nodeId: resolution.attachedTo, outcome: Plan.ErrorOutcome }]
      case "Dissolved": {
        if (seen.has(resolution.id)) {
          report(Codes.GatewayShape, `Gateway '${resolution.id}' participates in a gateway cycle`)
          return []
        }
        const next = new Set(seen)
        next.add(resolution.id)
        return (flowsByTarget.get(resolution.id) ?? []).flatMap((incoming) => sourcesOf(incoming, next))
      }
      case "Node": {
        const explicit = gatewayFlowOutcomes.get(flow.id) ?? flow.outcome
        if (explicit !== undefined) {
          return [{ nodeId: resolution.id, outcome: explicit }]
        }
        const declared = outcomesByNode.get(resolution.id)
        if (declared !== undefined && declared.length > 1 && flow.name === undefined) {
          report(
            Codes.AmbiguousOutcome,
            `Flow '${flow.id}' from '${resolution.id}' must name one of its outcomes`
          )
          return []
        }
        if (declared !== undefined && declared.length >= 1) {
          const named = flow.name !== undefined && declared.includes(flow.name)
            ? flow.name
            : declared.length === 1
            ? declared[0]!
            : undefined
          if (named === undefined) {
            report(
              Codes.AmbiguousOutcome,
              `Flow '${flow.id}' from '${resolution.id}' must name one of its outcomes`
            )
            return []
          }
          return [{ nodeId: resolution.id, outcome: named === Plan.DefaultOutcome ? undefined : named }]
        }
        return [{ nodeId: resolution.id, outcome: undefined }]
      }
    }
  }

  const targetsOf = (flow: Flow, seen: ReadonlySet<string>): ReadonlyArray<string> => {
    const resolution = resolutions.get(flow.targetRef)
    if (resolution === undefined) {
      report(Codes.UnresolvedReference, `Flow '${flow.id}' references unknown target '${flow.targetRef}'`)
      return []
    }
    switch (resolution._tag) {
      case "End":
      case "Start":
        return []
      case "Boundary": {
        report(Codes.UnresolvedReference, `Flow '${flow.id}' may not target a boundary event`)
        return []
      }
      case "Dissolved": {
        if (seen.has(resolution.id)) {
          report(Codes.GatewayShape, `Gateway '${resolution.id}' participates in a gateway cycle`)
          return []
        }
        const next = new Set(seen)
        next.add(resolution.id)
        return (flowsBySource.get(resolution.id) ?? []).flatMap((outgoing) => targetsOf(outgoing, next))
      }
      case "Node":
        return [resolution.id]
    }
  }

  const edges: Array<Schema.Json> = []
  const seenEdgeIds = new Set<string>()
  for (const flow of flows) {
    const sourceResolution = resolutions.get(flow.sourceRef)
    if (sourceResolution?._tag === "Dissolved") {
      // Flows out of dissolved gateways materialize through the flows that
      // enter them.
      continue
    }
    const sources = sourcesOf(flow, new Set())
    const targets = targetsOf(flow, new Set())
    for (const source of sources) {
      for (const target of targets) {
        const base = flow.id
        let id = base
        for (let suffix = 2; seenEdgeIds.has(id); suffix++) {
          id = `${base}~${suffix}`
        }
        seenEdgeIds.add(id)
        edges.push({
          _tag: "ControlEdge",
          id,
          sourceNodeId: source.nodeId,
          ...(source.outcome === undefined ? undefined : { outcome: source.outcome }),
          targetNodeId: target
        })
      }
    }
  }

  // --- process-level extensions and diagram interchange ----------------------

  const inputs = jsonExtension(process, "inputs", ["process"])
  const outputs = jsonExtension(process, "outputs", ["process"])
  const dataEdges = jsonExtension(process, "dataEdges", ["process"])
  if (Array.isArray(dataEdges)) {
    for (const edge of dataEdges) {
      edges.push(edge)
    }
  } else if (dataEdges !== undefined) {
    report(Codes.InvalidExtension, "wb:dataEdges must contain a JSON array of data edges", ["process"])
  }

  const bounds = new Map<string, Schema.Json>()
  const diagram = childOf(definitions, BPMNDI, "BPMNDiagram")
  const plane = diagram === undefined ? undefined : childOf(diagram, BPMNDI, "BPMNPlane")
  if (plane !== undefined) {
    for (const shape of childrenOf(plane, BPMNDI, "BPMNShape")) {
      const reference = shape.attributes.bpmnElement
      const box = childOf(shape, DC, "Bounds")
      if (reference === undefined || box === undefined) {
        continue
      }
      bounds.set(reference, {
        x: Number(box.attributes.x ?? 0),
        y: Number(box.attributes.y ?? 0),
        width: Number(box.attributes.width ?? 0),
        height: Number(box.attributes.height ?? 0)
      })
    }
  }

  // Synthesize a `default`-outcome fail for every exclusive gateway lacking a
  // default flow, so an unmatched gateway fails the run as BPMN requires
  // rather than completing silently on an unwired outcome. Skipped when the
  // plan already wired the `default` outcome itself.
  for (const gatewayId of gatewaysWithoutDefault) {
    const alreadyRouted = edges.some((edge) =>
      typeof edge === "object" && edge !== null && !Array.isArray(edge) &&
      (edge as { _tag?: unknown })._tag === "ControlEdge" &&
      (edge as { sourceNodeId?: unknown }).sourceNodeId === gatewayId &&
      (edge as { outcome?: unknown }).outcome === "default"
    )
    if (alreadyRouted) {
      continue
    }
    const failId = `${gatewayId}__nodefault`
    nodes.push({
      id: failId,
      type: "workflow/fail",
      version: "1.0.0",
      config: { code: "BPMN_NO_OUTGOING_FLOW" }
    })
    edges.push({
      _tag: "ControlEdge",
      id: `${gatewayId}__nodefault_flow`,
      sourceNodeId: gatewayId,
      outcome: "default",
      targetNodeId: failId
    })
  }

  if (diagnostics.length > 0) {
    return yield* fail()
  }

  const planDocument = {
    formatVersion: Plan.FormatVersion,
    id: options.planId ?? processId,
    revision: options.revision ?? 1,
    definition: options.definition,
    ...(inputs === undefined ? undefined : { inputs }),
    ...(outputs === undefined ? undefined : { outputs }),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      version: node.version,
      config: node.config,
      ...(node.bindings === undefined ? undefined : { bindings: node.bindings }),
      ...(node.policy === undefined ? undefined : { policy: node.policy }),
      ...(node.join === undefined ? undefined : { join: node.join }),
      ...(bounds.has(node.id) ? { metadata: { bpmn: bounds.get(node.id)! } } : undefined)
    })),
    edges,
    metadata: { bpmn: { processId } }
  }

  const decoded = yield* Effect.result(
    Schema.decodeUnknownEffect(Plan.Plan, { errors: "all", onExcessProperty: "error" })(planDocument)
  )
  if (Result.isFailure(decoded)) {
    report(Codes.InvalidPlan, decoded.failure.message)
    return yield* fail()
  }
  const snapshot = Json.snapshot(planDocument)
  if (Result.isFailure(snapshot)) {
    report(Codes.InvalidPlan, snapshot.failure.message)
    return yield* fail()
  }
  return {
    plan: snapshot.success as unknown as Plan.Plan,
    warnings: Object.freeze(warnings)
  }
})

// ----------------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------------

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case "\"":
        return "&quot;"
      default:
        return "&apos;"
    }
  })

interface Writer {
  readonly lines: Array<string>
  indent: number
}

const line = (writer: Writer, text: string): void => {
  writer.lines.push(`${"  ".repeat(writer.indent)}${text}`)
}

const attribute = (name: string, value: string | undefined): string =>
  value === undefined ? "" : ` ${name}="${escapeXml(value)}"`

/**
 * Renders a plan as a standard BPMN 2.0 XML document.
 *
 * **Details**
 *
 * Node kinds choose their most faithful BPMN notation — human tasks become
 * `userTask`, branches become exclusive gateways with condition flows,
 * delays and receives become catch events, fails become error end events,
 * sub-workflows and for-each become `callActivity` — and every element
 * carries its exact `wb:node`/`wb:config` pin so importing the document
 * reproduces the plan's execution meaning verbatim. Data edges, boundary
 * declarations, bindings, and policies travel as process- and node-level
 * extensions. Diagram interchange is emitted when every node carries BPMN
 * bounds in its metadata (as produced by {@link toPlan}).
 *
 * @category interchange
 * @since 4.0.0
 */
export const fromPlan = Effect.fnUntraced(function*(
  plan: Plan.Plan
): Effect.fn.Return<string, BpmnError> {
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const configOf = (node: Plan.PlanNode): Record<string, Schema.Json> =>
    node.config !== null && typeof node.config === "object" && !Array.isArray(node.config)
      ? node.config as Record<string, Schema.Json>
      : {}

  const controlEdges = plan.edges.filter((edge): edge is Plan.ControlEdge => edge._tag === "ControlEdge")
  const dataEdges = plan.edges.filter((edge): edge is Plan.DataEdge => edge._tag === "DataEdge")
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of controlEdges) {
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1)
    outgoing.set(edge.sourceNodeId, (outgoing.get(edge.sourceNodeId) ?? 0) + 1)
  }

  const messages = new Map<string, string>()
  const errors = new Map<string, string>()
  for (const node of plan.nodes) {
    const config = configOf(node)
    if (node.type === "workflow/receive" && typeof config.signal === "string") {
      messages.set(config.signal, `message_${messages.size}`)
    }
    if (node.type === "workflow/fail" && typeof config.code === "string") {
      errors.set(config.code, `error_${errors.size}`)
    }
  }

  const writer: Writer = { lines: [], indent: 0 }
  line(writer, `<?xml version="1.0" encoding="UTF-8"?>`)
  line(
    writer,
    `<bpmn:definitions xmlns:bpmn="${BPMN}" xmlns:bpmndi="${BPMNDI}" xmlns:dc="${DC}" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xmlns:wb="${ExtensionNamespace}" id="definitions_${escapeXml(plan.id)}" ` +
      `targetNamespace="${ExtensionNamespace}/plans">`
  )
  writer.indent++
  for (const [signal, id] of messages) {
    line(writer, `<bpmn:message id="${escapeXml(id)}" name="${escapeXml(signal)}"/>`)
  }
  for (const [code, id] of errors) {
    line(writer, `<bpmn:error id="${escapeXml(id)}" errorCode="${escapeXml(code)}"/>`)
  }

  const bpmnMetadata = plan.metadata !== null && typeof plan.metadata === "object" && !Array.isArray(plan.metadata)
    ? (plan.metadata as { bpmn?: { processId?: string } }).bpmn
    : undefined
  const processId = bpmnMetadata?.processId ?? `process_${plan.id.replace(/[^A-Za-z0-9_]/g, "_")}`
  line(writer, `<bpmn:process id="${escapeXml(processId)}" isExecutable="true">`)
  writer.indent++

  const processExtensions: Array<readonly [string, Schema.Json]> = []
  if (plan.inputs !== undefined) {
    processExtensions.push(["inputs", plan.inputs as unknown as Schema.Json])
  }
  if (plan.outputs !== undefined) {
    processExtensions.push(["outputs", plan.outputs as unknown as Schema.Json])
  }
  if (dataEdges.length > 0) {
    processExtensions.push(["dataEdges", dataEdges as unknown as Schema.Json])
  }
  if (processExtensions.length > 0) {
    line(writer, `<bpmn:extensionElements>`)
    writer.indent++
    for (const [name, value] of processExtensions) {
      line(writer, `<wb:${name}>${escapeXml(JSON.stringify(value))}</wb:${name}>`)
    }
    writer.indent--
    line(writer, `</bpmn:extensionElements>`)
  }

  const nodeExtensions = (node: Plan.PlanNode): void => {
    line(writer, `<bpmn:extensionElements>`)
    writer.indent++
    line(writer, `<wb:node type="${escapeXml(node.type)}" version="${escapeXml(node.version)}"/>`)
    line(writer, `<wb:config>${escapeXml(JSON.stringify(node.config))}</wb:config>`)
    if (node.bindings !== undefined) {
      line(writer, `<wb:bindings>${escapeXml(JSON.stringify(node.bindings))}</wb:bindings>`)
    }
    if (node.policy !== undefined) {
      line(writer, `<wb:policy>${escapeXml(JSON.stringify(node.policy))}</wb:policy>`)
    }
    if (node.join !== undefined) {
      line(writer, `<wb:join>${escapeXml(node.join)}</wb:join>`)
    }
    writer.indent--
    line(writer, `</bpmn:extensionElements>`)
  }

  const boundaryFor = new Map<string, string>()
  const startId = "wb_start"
  const endId = "wb_end"

  for (const node of plan.nodes) {
    const config = configOf(node)
    const open = (element: string, attributes: string): void => {
      line(writer, `<bpmn:${element} id="${escapeXml(node.id)}"${attributes}>`)
      writer.indent++
      nodeExtensions(node)
      writer.indent--
    }
    const close = (element: string): void => {
      line(writer, `</bpmn:${element}>`)
    }
    switch (node.type) {
      case "workflow/humanTask": {
        open("userTask", attribute("name", typeof config.title === "string" ? config.title : node.id))
        close("userTask")
        break
      }
      case "workflow/if":
      case "workflow/switch": {
        open("exclusiveGateway", "")
        close("exclusiveGateway")
        break
      }
      case "workflow/delay": {
        const millis = config.durationMillis
        open("intermediateCatchEvent", "")
        if (typeof millis === "number") {
          writer.indent++
          line(writer, `<bpmn:timerEventDefinition>`)
          writer.indent++
          line(
            writer,
            `<bpmn:timeDuration xsi:type="bpmn:tFormalExpression">${renderDuration(millis)}</bpmn:timeDuration>`
          )
          writer.indent--
          line(writer, `</bpmn:timerEventDefinition>`)
          writer.indent--
        }
        close("intermediateCatchEvent")
        break
      }
      case "workflow/receive": {
        const signal = typeof config.signal === "string" ? config.signal : node.id
        open("intermediateCatchEvent", "")
        writer.indent++
        line(writer, `<bpmn:messageEventDefinition messageRef="${escapeXml(messages.get(signal) ?? signal)}"/>`)
        writer.indent--
        close("intermediateCatchEvent")
        break
      }
      case "workflow/fail": {
        const code = typeof config.code === "string" ? config.code : node.id
        open("endEvent", attribute("name", code))
        writer.indent++
        line(writer, `<bpmn:errorEventDefinition errorRef="${escapeXml(errors.get(code) ?? code)}"/>`)
        writer.indent--
        close("endEvent")
        break
      }
      case "workflow/subWorkflow":
      case "workflow/forEach": {
        const reference = config.plan
        const planId = reference !== null && typeof reference === "object" && !Array.isArray(reference) &&
            typeof (reference as { planId?: unknown }).planId === "string"
          ? (reference as { planId: string }).planId
          : node.id
        open("callActivity", attribute("calledElement", planId))
        if (node.type === "workflow/forEach") {
          writer.indent++
          line(
            writer,
            `<bpmn:multiInstanceLoopCharacteristics isSequential="${config.mode === "sequential" ? "true" : "false"}"/>`
          )
          writer.indent--
        }
        close("callActivity")
        break
      }
      default: {
        open("serviceTask", attribute("name", node.type))
        close("serviceTask")
      }
    }
  }

  // Boundary events for error-outcome edges.
  for (const edge of controlEdges) {
    if (edge.outcome === Plan.ErrorOutcome && !boundaryFor.has(edge.sourceNodeId)) {
      const id = `wb_boundary_${edge.sourceNodeId.replace(/[^A-Za-z0-9_]/g, "_")}`
      boundaryFor.set(edge.sourceNodeId, id)
      line(writer, `<bpmn:boundaryEvent id="${escapeXml(id)}" attachedToRef="${escapeXml(edge.sourceNodeId)}">`)
      writer.indent++
      line(writer, `<bpmn:errorEventDefinition/>`)
      writer.indent--
      line(writer, `</bpmn:boundaryEvent>`)
    }
  }

  line(writer, `<bpmn:startEvent id="${startId}"/>`)
  line(writer, `<bpmn:endEvent id="${endId}"/>`)

  const flowsOut: Array<string> = []
  for (const edge of controlEdges) {
    const source = edge.outcome === Plan.ErrorOutcome
      ? boundaryFor.get(edge.sourceNodeId)!
      : edge.sourceNodeId
    const outcomeAttributes = edge.outcome === undefined || edge.outcome === Plan.ErrorOutcome
      ? ""
      : `${attribute("name", edge.outcome)}${attribute("outcome", edge.outcome)}`
    flowsOut.push(
      `<bpmn:sequenceFlow id="${escapeXml(edge.id)}" sourceRef="${escapeXml(source)}" ` +
        `targetRef="${escapeXml(edge.targetNodeId)}"${outcomeAttributes}/>`
    )
  }
  let synthetic = 0
  for (const node of plan.nodes) {
    if (node.type === "workflow/fail") {
      continue
    }
    if ((incoming.get(node.id) ?? 0) === 0) {
      flowsOut.push(
        `<bpmn:sequenceFlow id="wb_flow_start_${synthetic++}" sourceRef="${startId}" targetRef="${
          escapeXml(node.id)
        }"/>`
      )
    }
    if ((outgoing.get(node.id) ?? 0) === 0) {
      flowsOut.push(
        `<bpmn:sequenceFlow id="wb_flow_end_${synthetic++}" sourceRef="${escapeXml(node.id)}" targetRef="${endId}"/>`
      )
    }
  }
  for (const flow of flowsOut) {
    line(writer, flow)
  }

  writer.indent--
  line(writer, `</bpmn:process>`)

  // Diagram interchange when every node knows its bounds.
  const boundsOf = (node: Plan.PlanNode): { x: number; y: number; width: number; height: number } | undefined => {
    const metadata = node.metadata
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      return undefined
    }
    const bpmn = (metadata as { bpmn?: unknown }).bpmn
    if (bpmn === null || typeof bpmn !== "object" || Array.isArray(bpmn)) {
      return undefined
    }
    const box = bpmn as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    return typeof box.x === "number" && typeof box.y === "number" &&
        typeof box.width === "number" && typeof box.height === "number"
      ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : undefined
  }
  const allBounds = plan.nodes.map((node) => [node, boundsOf(node)] as const)
  if (plan.nodes.length > 0 && allBounds.every(([, box]) => box !== undefined)) {
    const minX = Math.min(...allBounds.map(([, box]) => box!.x))
    const maxX = Math.max(...allBounds.map(([, box]) => box!.x + box!.width))
    const midY = allBounds[0] === undefined ? 100 : allBounds[0][1]!.y
    line(writer, `<bpmndi:BPMNDiagram id="diagram_0">`)
    writer.indent++
    line(writer, `<bpmndi:BPMNPlane id="plane_0" bpmnElement="${escapeXml(processId)}">`)
    writer.indent++
    for (const [node, box] of allBounds) {
      line(writer, `<bpmndi:BPMNShape id="shape_${escapeXml(node.id)}" bpmnElement="${escapeXml(node.id)}">`)
      writer.indent++
      line(writer, `<dc:Bounds x="${box!.x}" y="${box!.y}" width="${box!.width}" height="${box!.height}"/>`)
      writer.indent--
      line(writer, `</bpmndi:BPMNShape>`)
    }
    line(writer, `<bpmndi:BPMNShape id="shape_${startId}" bpmnElement="${startId}">`)
    writer.indent++
    line(writer, `<dc:Bounds x="${minX - 80}" y="${midY}" width="36" height="36"/>`)
    writer.indent--
    line(writer, `</bpmndi:BPMNShape>`)
    line(writer, `<bpmndi:BPMNShape id="shape_${endId}" bpmnElement="${endId}">`)
    writer.indent++
    line(writer, `<dc:Bounds x="${maxX + 44}" y="${midY}" width="36" height="36"/>`)
    writer.indent--
    line(writer, `</bpmndi:BPMNShape>`)
    writer.indent--
    line(writer, `</bpmndi:BPMNPlane>`)
    writer.indent--
    line(writer, `</bpmndi:BPMNDiagram>`)
  }

  writer.indent--
  line(writer, `</bpmn:definitions>`)

  if (diagnostics.length > 0) {
    return yield* Effect.fail(
      new BpmnError({
        diagnostics: diagnostics as [Diagnostic.Diagnostic, ...Array<Diagnostic.Diagnostic>]
      })
    )
  }
  return writer.lines.join("\n")
})
