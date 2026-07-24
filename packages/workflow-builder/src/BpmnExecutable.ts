/**
 * Strict XML admission facade for the executable BPMN token-kernel subset.
 *
 * **Details**
 *
 * This module composes the bounded {@link BpmnXml} interchange profile with
 * {@link BpmnKernel.prepare}. It makes no BPMN conformance claim and performs
 * no semantic projection or inference. In particular, executable gateways
 * must declare a supported direction explicitly, and the selected root process
 * must be the only process containing flow nodes.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnActivityV3 from "./BpmnActivityV3.ts"
import * as BpmnData from "./BpmnData.ts"
import * as BpmnExpression from "./BpmnExpression.ts"
import * as BpmnKernel from "./BpmnKernel.ts"
import * as BpmnXml from "./BpmnXml.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Stable machine-readable executable-facade diagnostics.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidOptions: "InvalidBpmnExecutableOptions"
} as const

/**
 * A stable machine-readable executable-facade diagnostic code.
 *
 * @category models
 * @since 4.0.0
 */
export type Code = typeof Codes[keyof typeof Codes]

/**
 * Strict controls for importing and compiling one executable XML document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompileXmlOptions = Schema.Struct({
  importOptions: BpmnXml.ImportOptions,
  rootProcessId: Schema.NonEmptyString,
  limits: BpmnKernel.KernelLimits,
  evaluatorBindings: Schema.Array(BpmnExpression.EvaluatorBinding),
  taskBindings: Schema.optionalKey(
    Schema.Array(BpmnActivityV3.TaskBinding)
  ),
  dataDocument: Schema.optionalKey(BpmnData.BpmnDataDocument),
  collectionBindings: Schema.optionalKey(
    Schema.Array(BpmnKernel.MultiInstanceCollectionBinding)
  )
}).annotate({
  identifier: "WorkflowBpmnExecutableCompileXmlOptions",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CompileXmlOptions}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompileXmlOptions = Schema.Schema.Type<typeof CompileXmlOptions>

/**
 * One admitted interchange document and its compiled token kernel.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompiledXml {
  readonly interchange: BpmnXml.InterchangeDocument
  readonly kernel: BpmnKernel.CompiledKernel
}

const decodeCompileXmlOptions = Schema.decodeUnknownResult(
  CompileXmlOptions,
  strictParseOptions
)

const invalidOptions = (
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment> = [],
  details?: Schema.Json
): Diagnostic.CompilationError =>
  new Diagnostic.CompilationError({
    diagnostics: [
      Diagnostic.error(Codes.InvalidOptions, message, path, details)
    ]
  })

/**
 * Imports and compiles one BPMN XML document without weakening either phase.
 *
 * **Details**
 *
 * Options are snapshotted and decoded with excess-property rejection before
 * XML parsing begins. Import and kernel diagnostics are returned unchanged.
 * Evaluator bindings, optional protocol-v3 Task bindings, the normalized BPMN
 * data document, and collection-value bindings are supplied as explicit
 * deployment authority outside the XML interchange slice and become part of
 * the executable fingerprint. A `loopDataInputRef` remains an IDREF: this
 * facade never misinterprets it as expression source. The function does not
 * infer an unspecified gateway direction, choose among multiple populated
 * processes, or claim BPMN conformance.
 *
 * @category constructors
 * @since 4.0.0
 */
export const compileXml = Effect.fnUntraced(function*(
  input: unknown,
  optionsInput: unknown
): Effect.fn.Return<
  CompiledXml,
  Diagnostic.CompilationError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const snapshot = Json.snapshot(optionsInput)
  if (Result.isFailure(snapshot)) {
    return yield* Effect.fail(invalidOptions(
      snapshot.failure.message,
      ["options", ...snapshot.failure.path]
    ))
  }
  const options = decodeCompileXmlOptions(snapshot.success)
  if (Result.isFailure(options)) {
    return yield* Effect.fail(invalidOptions(
      "Invalid executable BPMN XML compile options",
      ["options"],
      { issue: String(options.failure) }
    ))
  }
  const imported = BpmnXml.importXml(input, options.success.importOptions)
  if (Result.isFailure(imported)) {
    return yield* Effect.fail(imported.failure)
  }
  const kernel = yield* BpmnKernel.prepare(
    imported.success.model,
    {
      profileId: imported.success.profileId,
      rootProcessId: options.success.rootProcessId,
      limits: options.success.limits,
      evaluatorBindings: options.success.evaluatorBindings,
      ...(options.success.taskBindings === undefined
        ? undefined
        : { taskBindings: options.success.taskBindings }),
      ...(options.success.dataDocument === undefined
        ? undefined
        : { dataDocument: options.success.dataDocument }),
      ...(options.success.collectionBindings === undefined
        ? undefined
        : {
          collectionBindings: options.success.collectionBindings
        })
    }
  )
  return Object.freeze({
    interchange: imported.success,
    kernel
  })
})
