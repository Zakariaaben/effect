/**
 * Defines typed input and output ports for workflow nodes and workflow
 * boundaries.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import { identity } from "effect/Function"
import type * as Option from "effect/Option"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as Schema from "effect/Schema"
import type * as Types from "effect/Types"

/**
 * Runtime marker for input ports.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const InputTypeId: InputTypeId = "@effect/workflow-builder/Port/Input"

/**
 * Type-level marker for input ports.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type InputTypeId = "@effect/workflow-builder/Port/Input"

/**
 * Runtime marker for output ports.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const OutputTypeId: OutputTypeId = "@effect/workflow-builder/Port/Output"

/**
 * Type-level marker for output ports.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type OutputTypeId = "@effect/workflow-builder/Port/Output"

/**
 * Controls how many links may feed an input port.
 *
 * @category models
 * @since 4.0.0
 */
export type Cardinality = "one" | "many"

/**
 * Controls whether an output can be connected once or broadcast to several
 * downstream inputs.
 *
 * @category models
 * @since 4.0.0
 */
export type FanOut = "single" | "multiple"

/**
 * A schema whose encoded representation can be stored as portable JSON.
 *
 * **Details**
 *
 * This constraint rejects schemas whose declared encoded type is not
 * assignable to {@link Schema.Json}. It preserves the concrete decoded type,
 * encoded type, and service requirements of schemas accepted by port and node
 * constructors.
 *
 * The constraint is a compile-time guarantee for honest codecs. Interpreters
 * and durable backends must still validate values at runtime because a custom
 * codec or type assertion can misrepresent its encoded value.
 *
 * @category models
 * @since 4.0.0
 */
export interface PayloadSchema extends Schema.Top {
  readonly Encoded: Schema.Json
}

/**
 * A typed sink in a workflow graph.
 *
 * **Details**
 *
 * `contract` is a stable, application-owned compatibility identifier. Schema
 * values validate payloads, while the contract gives the compiler a deliberate
 * and portable way to decide whether two independently declared ports are
 * link-compatible.
 *
 * @category models
 * @since 4.0.0
 */
export interface Input<
  out S extends PayloadSchema,
  out Contract extends string,
  out C extends Cardinality,
  out Required extends boolean
> extends Pipeable {
  readonly [InputTypeId]: {
    readonly _Schema: Types.Covariant<S>
    readonly _Contract: Types.Covariant<Contract>
  }
  readonly _tag: "InputPort"
  readonly schema: S
  readonly contract: Contract
  readonly cardinality: C
  readonly required: Required
  readonly description?: string | undefined
  readonly annotations: Context.Context<never>

  /**
   * Adds an application annotation to this port.
   */
  annotate<I, A>(key: Context.Key<I, A>, value: A): Input<S, Contract, C, Required>

  /**
   * Merges application annotations into this port.
   */
  annotateMerge<I>(annotations: Context.Context<I>): Input<S, Contract, C, Required>
}

/**
 * A typed source in a workflow graph.
 *
 * @category models
 * @since 4.0.0
 */
export interface Output<
  out S extends PayloadSchema,
  out Contract extends string,
  out Fanout extends FanOut
> extends Pipeable {
  readonly [OutputTypeId]: {
    readonly _Schema: Types.Covariant<S>
    readonly _Contract: Types.Covariant<Contract>
  }
  readonly _tag: "OutputPort"
  readonly schema: S
  readonly contract: Contract
  readonly fanOut: Fanout
  readonly description?: string | undefined
  readonly annotations: Context.Context<never>

  /**
   * Adds an application annotation to this port.
   */
  annotate<I, A>(key: Context.Key<I, A>, value: A): Output<S, Contract, Fanout>

  /**
   * Merges application annotations into this port.
   */
  annotateMerge<I>(annotations: Context.Context<I>): Output<S, Contract, Fanout>
}

/**
 * A record of input port declarations.
 *
 * @category models
 * @since 4.0.0
 */
export type Inputs = Readonly<Record<string, Input.Any>>

/**
 * A record of output port declarations.
 *
 * @category models
 * @since 4.0.0
 */
export type Outputs = Readonly<Record<string, Output.Any>>

/**
 * Namespace containing input-port utility types.
 *
 * @since 4.0.0
 */
export declare namespace Input {
  /**
   * Type-erased input port.
   *
   * @category utility types
   * @since 4.0.0
   */
  export interface Any extends Input<PayloadSchema, string, Cardinality, boolean> {}

  /**
   * Runtime value accepted by an input port.
   *
   * **Details**
   *
   * Optional single-value ports are represented with `Option`; many-value
   * ports are always represented as arrays and are checked for non-emptiness
   * by the compiler when required.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Value<P> = P extends Input<infer S, infer _Contract, infer C, infer Required> ?
    C extends "many" ? ReadonlyArray<S["Type"]>
    : Required extends true ? S["Type"]
    : Option.Option<S["Type"]>
    : never

  /**
   * Extracts the payload schema from an input port.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Schema<P> = P extends Input<infer S, infer _Contract, infer _C, infer _Required> ? S : never
}

/**
 * Namespace containing output-port utility types.
 *
 * @since 4.0.0
 */
export declare namespace Output {
  /**
   * Type-erased output port.
   *
   * @category utility types
   * @since 4.0.0
   */
  export interface Any extends Output<PayloadSchema, string, FanOut> {}

  /**
   * Runtime value emitted through an output port.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Value<P> = P extends Output<infer S, infer _Contract, infer _Fanout> ? S["Type"] : never

  /**
   * Extracts the payload schema from an output port.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Schema<P> = P extends Output<infer S, infer _Contract, infer _Fanout> ? S : never
}

/**
 * Services required to decode values for an input-port record.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputDecodingServices<P extends Inputs> = {
  readonly [K in keyof P]: Input.Schema<P[K]>["DecodingServices"]
}[keyof P]

/**
 * Services required to encode values for an input-port record.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputEncodingServices<P extends Inputs> = {
  readonly [K in keyof P]: Input.Schema<P[K]>["EncodingServices"]
}[keyof P]

/**
 * Services required to decode values for an output-port record.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputDecodingServices<P extends Outputs> = {
  readonly [K in keyof P]: Output.Schema<P[K]>["DecodingServices"]
}[keyof P]

/**
 * Services required to encode values for an output-port record.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputEncodingServices<P extends Outputs> = {
  readonly [K in keyof P]: Output.Schema<P[K]>["EncodingServices"]
}[keyof P]

/**
 * Maps input declarations to the value object received by a node handler.
 *
 * @category utility types
 * @since 4.0.0
 */
export type InputValues<P extends Inputs> = {
  readonly [K in keyof P]: Input.Value<P[K]>
}

/**
 * Maps output declarations to the value object returned by a node handler.
 *
 * @category utility types
 * @since 4.0.0
 */
export type OutputValues<P extends Outputs> = {
  readonly [K in keyof P]: Output.Value<P[K]>
}

const InputProto = {
  [InputTypeId]: {
    _Schema: identity,
    _Contract: identity
  },
  _tag: "InputPort",
  pipe() {
    return pipeArguments(this, arguments)
  },
  annotate<I, A>(this: Input.Any, key: Context.Key<I, A>, value: A) {
    return Object.freeze(Object.assign(Object.create(InputProto), this, {
      annotations: Context.add(this.annotations, key, value)
    }))
  },
  annotateMerge<I>(this: Input.Any, annotations: Context.Context<I>) {
    return Object.freeze(Object.assign(Object.create(InputProto), this, {
      annotations: Context.merge(this.annotations, annotations)
    }))
  }
}

const OutputProto = {
  [OutputTypeId]: {
    _Schema: identity,
    _Contract: identity
  },
  _tag: "OutputPort",
  pipe() {
    return pipeArguments(this, arguments)
  },
  annotate<I, A>(this: Output.Any, key: Context.Key<I, A>, value: A) {
    return Object.freeze(Object.assign(Object.create(OutputProto), this, {
      annotations: Context.add(this.annotations, key, value)
    }))
  },
  annotateMerge<I>(this: Output.Any, annotations: Context.Context<I>) {
    return Object.freeze(Object.assign(Object.create(OutputProto), this, {
      annotations: Context.merge(this.annotations, annotations)
    }))
  }
}

/**
 * Declares a typed input port.
 *
 * **Details**
 *
 * The schema's declared encoded representation must be portable JSON. Runtime
 * decoding still validates values supplied by plans and durable history.
 *
 * @category constructors
 * @since 4.0.0
 */
export function input<
  S extends PayloadSchema,
  const Contract extends string,
  const C extends Cardinality,
  const Required extends boolean
>(schema: S, options: {
  readonly contract: Contract
  readonly cardinality: C
  readonly required: Required
  readonly description?: string | undefined
}): Input<S, Contract, C, Required>
export function input<S extends PayloadSchema, const Contract extends string, const C extends Cardinality>(
  schema: S,
  options: {
    readonly contract: Contract
    readonly cardinality: C
    readonly required?: undefined
    readonly description?: string | undefined
  }
): Input<S, Contract, C, true>
export function input<S extends PayloadSchema, const Contract extends string, const Required extends boolean>(
  schema: S,
  options: {
    readonly contract: Contract
    readonly cardinality?: undefined
    readonly required: Required
    readonly description?: string | undefined
  }
): Input<S, Contract, "one", Required>
export function input<S extends PayloadSchema, const Contract extends string>(
  schema: S,
  options: {
    readonly contract: Contract
    readonly cardinality?: undefined
    readonly required?: undefined
    readonly description?: string | undefined
  }
): Input<S, Contract, "one", true>
export function input<
  S extends PayloadSchema,
  const Contract extends string,
  const C extends Cardinality = "one",
  const Required extends boolean = true
>(schema: S, options: {
  readonly contract: Contract
  readonly cardinality?: C | undefined
  readonly required?: Required | undefined
  readonly description?: string | undefined
}): Input<S, Contract, C, Required>
export function input<S extends PayloadSchema, const Contract extends string>(schema: S, options: {
  readonly contract: Contract
  readonly cardinality?: Cardinality | undefined
  readonly required?: boolean | undefined
  readonly description?: string | undefined
}): Input<S, Contract, Cardinality, boolean> {
  return Object.freeze(Object.assign(Object.create(InputProto), {
    schema,
    contract: options.contract,
    cardinality: options.cardinality ?? "one",
    required: options.required ?? true,
    description: options.description,
    annotations: Context.empty()
  }))
}

/**
 * Declares a typed output port.
 *
 * **Details**
 *
 * The schema's declared encoded representation must be portable JSON. Runtime
 * encoding still validates values returned by node handlers.
 *
 * @category constructors
 * @since 4.0.0
 */
export function output<
  S extends PayloadSchema,
  const Contract extends string,
  const Fanout extends FanOut
>(schema: S, options: {
  readonly contract: Contract
  readonly fanOut: Fanout
  readonly description?: string | undefined
}): Output<S, Contract, Fanout>
export function output<S extends PayloadSchema, const Contract extends string>(
  schema: S,
  options: {
    readonly contract: Contract
    readonly fanOut?: undefined
    readonly description?: string | undefined
  }
): Output<S, Contract, "multiple">
export function output<
  S extends PayloadSchema,
  const Contract extends string,
  const Fanout extends FanOut = "multiple"
>(schema: S, options: {
  readonly contract: Contract
  readonly fanOut?: Fanout | undefined
  readonly description?: string | undefined
}): Output<S, Contract, Fanout>
export function output<S extends PayloadSchema, const Contract extends string>(schema: S, options: {
  readonly contract: Contract
  readonly fanOut?: FanOut | undefined
  readonly description?: string | undefined
}): Output<S, Contract, FanOut> {
  return Object.freeze(Object.assign(Object.create(OutputProto), {
    schema,
    contract: options.contract,
    fanOut: options.fanOut ?? "multiple",
    description: options.description,
    annotations: Context.empty()
  }))
}
