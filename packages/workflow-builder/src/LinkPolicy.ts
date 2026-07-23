/**
 * Effectful authorization policies for resolved workflow data links.
 *
 * Link policies decide whether a structurally valid link is permitted. Port
 * contract compatibility is deliberately enforced by the workflow compiler,
 * before authorization, and is not inferred by this module.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as Types from "effect/Types"

/**
 * Runtime marker for link policies.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "@effect/workflow-builder/LinkPolicy"

/**
 * Type-level marker for link policies.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "@effect/workflow-builder/LinkPolicy"

/**
 * A resolved workflow-input source.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedWorkflowInput {
  readonly kind: "WorkflowInput"
  readonly port: string
  readonly contract: string
}

/**
 * A resolved node-output source.
 *
 * **Details**
 *
 * Node identity is retained for custom policies and diagnostics. Declarative
 * selectors intentionally match the portable node type and version instead.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeOutput {
  readonly kind: "NodeOutput"
  readonly nodeId: string
  readonly nodeType: string
  readonly nodeVersion: string
  readonly port: string
  readonly contract: string
}

/**
 * A resolved node-input target.
 *
 * **Details**
 *
 * Node identity is retained for custom policies and diagnostics. Declarative
 * selectors intentionally match the portable node type and version instead.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedNodeInput {
  readonly kind: "NodeInput"
  readonly nodeId: string
  readonly nodeType: string
  readonly nodeVersion: string
  readonly port: string
  readonly contract: string
}

/**
 * A resolved workflow-output target.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResolvedWorkflowOutput {
  readonly kind: "WorkflowOutput"
  readonly port: string
  readonly contract: string
}

/**
 * A resolved source endpoint for a compiled data link.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedSourceEndpoint = ResolvedWorkflowInput | ResolvedNodeOutput

/**
 * A resolved target endpoint for a compiled data link.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedTargetEndpoint = ResolvedNodeInput | ResolvedWorkflowOutput

/**
 * Any resolved endpoint for a compiled data link.
 *
 * @category models
 * @since 4.0.0
 */
export type ResolvedEndpoint = ResolvedSourceEndpoint | ResolvedTargetEndpoint

/**
 * The complete input to a link authorization decision.
 *
 * @category models
 * @since 4.0.0
 */
export interface LinkContext {
  readonly edgeId: string
  readonly source: ResolvedSourceEndpoint
  readonly target: ResolvedTargetEndpoint
}

/**
 * Selects workflow-input endpoints.
 *
 * **Details**
 *
 * Omitted fields are wildcards.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkflowInputSelector {
  readonly kind: "WorkflowInput"
  readonly port?: string | undefined
  readonly contract?: string | undefined
}

/**
 * Selects node-output endpoints.
 *
 * **Details**
 *
 * Omitted fields are wildcards. Node instance identifiers are deliberately
 * excluded so rules remain portable between plans.
 *
 * @category models
 * @since 4.0.0
 */
export interface NodeOutputSelector {
  readonly kind: "NodeOutput"
  readonly nodeType?: string | undefined
  readonly nodeVersion?: string | undefined
  readonly port?: string | undefined
  readonly contract?: string | undefined
}

/**
 * Selects node-input endpoints.
 *
 * **Details**
 *
 * Omitted fields are wildcards. Node instance identifiers are deliberately
 * excluded so rules remain portable between plans.
 *
 * @category models
 * @since 4.0.0
 */
export interface NodeInputSelector {
  readonly kind: "NodeInput"
  readonly nodeType?: string | undefined
  readonly nodeVersion?: string | undefined
  readonly port?: string | undefined
  readonly contract?: string | undefined
}

/**
 * Selects workflow-output endpoints.
 *
 * **Details**
 *
 * Omitted fields are wildcards.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkflowOutputSelector {
  readonly kind: "WorkflowOutput"
  readonly port?: string | undefined
  readonly contract?: string | undefined
}

/**
 * Selects a resolved data-link source.
 *
 * @category models
 * @since 4.0.0
 */
export type SourceEndpointSelector = WorkflowInputSelector | NodeOutputSelector

/**
 * Selects a resolved data-link target.
 *
 * @category models
 * @since 4.0.0
 */
export type TargetEndpointSelector = NodeInputSelector | WorkflowOutputSelector

/**
 * Selects any resolved endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export type EndpointSelector = SourceEndpointSelector | TargetEndpointSelector

/**
 * Selects links by source, target, or both.
 *
 * **Details**
 *
 * An omitted side is a wildcard. An empty selector therefore matches every
 * link.
 *
 * @category models
 * @since 4.0.0
 */
export interface LinkSelector {
  readonly source?: SourceEndpointSelector | undefined
  readonly target?: TargetEndpointSelector | undefined
}

/**
 * A rule or fallback authorization decision.
 *
 * @category models
 * @since 4.0.0
 */
export type Decision = "allow" | "deny"

/**
 * An introspectable declarative link-authorization rule.
 *
 * **Details**
 *
 * Rules are evaluated in array order and the first matching rule decides the
 * result.
 *
 * @category models
 * @since 4.0.0
 */
export interface Rule {
  readonly decision: Decision
  readonly selector: LinkSelector
}

/**
 * An effectful link authorization policy.
 *
 * **Details**
 *
 * The error and requirement channels are retained so policies can consult
 * application services, remote policy engines, or audit infrastructure.
 *
 * @category models
 * @since 4.0.0
 */
export interface LinkPolicy<out E = never, out R = never> extends Pipeable {
  readonly [TypeId]: {
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
  readonly _tag: "Custom" | "Rules"
  readonly authorize: (context: LinkContext) => Effect.Effect<boolean, E, R>
}

/**
 * A custom effectful link policy.
 *
 * @category models
 * @since 4.0.0
 */
export interface CustomPolicy<out E = never, out R = never> extends LinkPolicy<E, R> {
  readonly _tag: "Custom"
}

/**
 * A declarative policy whose ordered rules and fallback can be inspected.
 *
 * @category models
 * @since 4.0.0
 */
export interface RulesPolicy extends LinkPolicy<never, never> {
  readonly _tag: "Rules"
  readonly rules: ReadonlyArray<Rule>
  readonly fallback: Decision
}

const variance = Object.freeze({
  _E: identity,
  _R: identity
})

const ArrayPrototype = Array.prototype
const ObjectPrototype = Object.prototype
const arrayIsArray = Array.isArray
const defineProperty = Object.defineProperty
const freeze = Object.freeze
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const getPrototypeOf = Object.getPrototypeOf
const numberIsInteger = Number.isInteger
const ownKeys = Reflect.ownKeys

const PolicyProto = Object.freeze({
  [TypeId]: variance,
  pipe() {
    return pipeArguments(this, arguments)
  }
})

const invalid = (path: string, message: string): never => {
  throw new TypeError(`Invalid link policy ${path}: ${message}`)
}

const isSupportedKey = (supported: ReadonlyArray<string>, key: string): boolean => {
  for (let index = 0; index < supported.length; index++) {
    if (supported[index] === key) {
      return true
    }
  }
  return false
}

const inspectRecord = (
  input: unknown,
  path: string,
  supportedKeys: ReadonlyArray<string>,
  requiredKeys: ReadonlyArray<string>
): object => {
  if (typeof input !== "object" || input === null || arrayIsArray(input)) {
    return invalid(path, "expected a plain or null-prototype object")
  }

  const prototype = getPrototypeOf(input)
  if (prototype !== ObjectPrototype && prototype !== null) {
    return invalid(path, "expected a plain or null-prototype object")
  }

  for (const key of ownKeys(input)) {
    if (typeof key !== "string") {
      return invalid(path, "symbol properties are not supported")
    }
    if (!isSupportedKey(supportedKeys, key)) {
      return invalid(path, `unsupported property ${JSON.stringify(key)}`)
    }
    const descriptor = getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalid(`${path}.${key}`, "accessor properties are not supported")
    }
    if (!descriptor.enumerable) {
      return invalid(`${path}.${key}`, "non-enumerable properties are not supported")
    }
  }

  for (const key of requiredKeys) {
    if (getOwnPropertyDescriptor(input, key) === undefined) {
      return invalid(path, `missing required property ${JSON.stringify(key)}`)
    }
  }

  return input
}

const dataValue = (input: object, key: string): unknown => {
  const descriptor = getOwnPropertyDescriptor(input, key)
  return descriptor === undefined ? undefined : descriptor.value
}

const hasData = (input: object, key: string): boolean => getOwnPropertyDescriptor(input, key) !== undefined

const defineData = (target: object, key: string, value: unknown): void => {
  defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

const validateDecision = (decision: unknown, path: string): Decision => {
  if (decision !== "allow" && decision !== "deny") {
    return invalid(path, "expected \"allow\" or \"deny\"")
  }
  return decision
}

const endpointKeys = ["kind", "nodeType", "nodeVersion", "port", "contract"]
const workflowEndpointKeys = ["kind", "port", "contract"]
const nodeEndpointKeys = ["kind", "nodeType", "nodeVersion", "port", "contract"]
const endpointOptionalKeys = ["nodeType", "nodeVersion", "port", "contract"]

const copyEndpointSelector = <S extends EndpointSelector>(
  input: S,
  path: string,
  side: "source" | "target"
): S => {
  const selector = inspectRecord(input, path, endpointKeys, ["kind"])
  const kind = dataValue(selector, "kind")
  const supportedKeys = kind === "WorkflowInput" || kind === "WorkflowOutput"
    ? workflowEndpointKeys
    : kind === "NodeOutput" || kind === "NodeInput"
    ? nodeEndpointKeys
    : invalid(`${path}.kind`, "expected a supported endpoint kind")

  if (
    (side === "source" && kind !== "WorkflowInput" && kind !== "NodeOutput") ||
    (side === "target" && kind !== "NodeInput" && kind !== "WorkflowOutput")
  ) {
    return invalid(`${path}.kind`, `expected a ${side} endpoint kind`)
  }

  for (const key of ownKeys(selector)) {
    if (typeof key === "string" && !isSupportedKey(supportedKeys, key)) {
      return invalid(path, `property ${JSON.stringify(key)} is not supported for ${JSON.stringify(kind)}`)
    }
  }

  const copied: Record<string, unknown> = {}
  defineData(copied, "kind", kind)
  for (const key of endpointOptionalKeys) {
    if (!hasData(selector, key)) {
      continue
    }
    const value = dataValue(selector, key)
    if (value !== undefined && typeof value !== "string") {
      return invalid(`${path}.${key}`, "expected a string or undefined")
    }
    defineData(copied, key, value)
  }
  return freeze(copied) as S
}

const copyLinkSelector = (input: LinkSelector, path: string): LinkSelector => {
  const selector = inspectRecord(input, path, ["source", "target"], [])
  const copied: Record<string, unknown> = {}

  for (const key of ["source", "target"] as const) {
    if (!hasData(selector, key)) {
      continue
    }
    const endpoint = dataValue(selector, key)
    if (endpoint !== undefined) {
      defineData(copied, key, copyEndpointSelector(endpoint as EndpointSelector, `${path}.${key}`, key))
    }
  }

  return freeze(copied) as LinkSelector
}

const copyRule = (input: Rule, path: string): Rule => {
  const rule = inspectRecord(input, path, ["decision", "selector"], ["decision", "selector"])
  const decision = validateDecision(dataValue(rule, "decision"), `${path}.decision`)
  const selector = copyLinkSelector(dataValue(rule, "selector") as LinkSelector, `${path}.selector`)
  return freeze({ decision, selector })
}

const copyRules = (input: ReadonlyArray<Rule>): ReadonlyArray<Rule> => {
  if (!arrayIsArray(input) || getPrototypeOf(input) !== ArrayPrototype) {
    return invalid("rules", "expected an ordinary array")
  }

  const lengthDescriptor = getOwnPropertyDescriptor(input, "length")
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    !numberIsInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return invalid("rules.length", "expected an ordinary array length")
  }
  const length = lengthDescriptor.value

  for (const key of ownKeys(input)) {
    if (typeof key !== "string") {
      return invalid("rules", "symbol properties are not supported")
    }
    if (key === "length") {
      continue
    }
    const index = Number(key)
    if (!numberIsInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return invalid("rules", `decorated array property ${JSON.stringify(key)} is not supported`)
    }
  }

  const copied = new Array<Rule>(length)
  for (let index = 0; index < length; index++) {
    const descriptor = getOwnPropertyDescriptor(input, String(index))
    if (descriptor === undefined) {
      return invalid(`rules[${index}]`, "sparse arrays are not supported")
    }
    if (!("value" in descriptor)) {
      return invalid(`rules[${index}]`, "accessor properties are not supported")
    }
    if (!descriptor.enumerable) {
      return invalid(`rules[${index}]`, "non-enumerable properties are not supported")
    }
    copied[index] = copyRule(descriptor.value as Rule, `rules[${index}]`)
  }

  return freeze(copied)
}

/**
 * Tests whether an endpoint selector matches a resolved endpoint.
 *
 * @category predicates
 * @since 4.0.0
 */
export const matchesEndpoint = (selector: EndpointSelector, endpoint: ResolvedEndpoint): boolean => {
  if (selector.kind !== endpoint.kind) {
    return false
  }
  if (selector.port !== undefined && selector.port !== endpoint.port) {
    return false
  }
  if (selector.contract !== undefined && selector.contract !== endpoint.contract) {
    return false
  }
  if (selector.kind === "NodeOutput" || selector.kind === "NodeInput") {
    const resolvedNode = endpoint as ResolvedNodeOutput | ResolvedNodeInput
    if (selector.nodeType !== undefined && selector.nodeType !== resolvedNode.nodeType) {
      return false
    }
    if (selector.nodeVersion !== undefined && selector.nodeVersion !== resolvedNode.nodeVersion) {
      return false
    }
  }
  return true
}

/**
 * Tests whether a link selector matches an authorization context.
 *
 * @category predicates
 * @since 4.0.0
 */
export const matches = (selector: LinkSelector, context: LinkContext): boolean =>
  (selector.source === undefined || matchesEndpoint(selector.source, context.source)) &&
  (selector.target === undefined || matchesEndpoint(selector.target, context.target))

/**
 * Constructs an immutable declarative rule.
 *
 * @category constructors
 * @since 4.0.0
 */
export const rule = (decision: Decision, selector: LinkSelector): Rule => {
  const copiedDecision = validateDecision(decision, "rule.decision")
  return freeze({
    decision: copiedDecision,
    selector: copyLinkSelector(selector, "rule.selector")
  })
}

/**
 * Constructs a custom effectful link policy.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <E, R>(
  authorize: (context: LinkContext) => Effect.Effect<boolean, E, R>
): CustomPolicy<E, R> => {
  const policy = Object.create(PolicyProto) as CustomPolicy<E, R>
  defineData(policy, "_tag", "Custom")
  defineData(policy, "authorize", authorize)
  return freeze(policy)
}

/**
 * Constructs a policy from ordered allow and deny rules.
 *
 * **Details**
 *
 * The first matching rule wins. `fallback` is required and is used when no
 * rule matches, making the policy's default behavior explicit. The supplied
 * array and its values are copied into immutable, introspectable values.
 *
 * This constructor does not compare the source and target contracts for
 * compatibility; that is a separate compiler responsibility.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromRules = (
  rules: ReadonlyArray<Rule>,
  fallback: Decision
): RulesPolicy => {
  const copiedFallback = validateDecision(fallback, "fallback")
  const copiedRules = copyRules(rules)
  const policy = Object.create(PolicyProto) as RulesPolicy
  defineData(policy, "_tag", "Rules")
  defineData(policy, "rules", copiedRules)
  defineData(policy, "fallback", copiedFallback)
  defineData(policy, "authorize", (context: LinkContext) => {
    for (const current of copiedRules) {
      if (matches(current.selector, context)) {
        return Effect.succeed(current.decision === "allow")
      }
    }
    return Effect.succeed(copiedFallback === "allow")
  })
  return freeze(policy)
}

/**
 * A policy that denies every link.
 *
 * **Details**
 *
 * This is the safe default policy. Applications must opt in to
 * {@link allowAll} explicitly when unrestricted linking is intended.
 *
 * @category constructors
 * @since 4.0.0
 */
export const denyAll: RulesPolicy = fromRules([], "deny")

/**
 * A policy that explicitly permits every link.
 *
 * @category constructors
 * @since 4.0.0
 */
export const allowAll: RulesPolicy = fromRules([], "allow")
