/**
 * Structured diagnostics emitted while validating and compiling plans.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./internal/json.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A path segment into a portable plan document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PathSegment = Schema.Union([Schema.String, NonNegativeInt])

/**
 * The decoded type of {@link PathSegment}.
 *
 * @category models
 * @since 4.0.0
 */
export type PathSegment = typeof PathSegment.Type

const DiagnosticFields = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  path: Schema.Array(PathSegment),
  details: Schema.optionalKey(Schema.Json)
}).annotate({ parseOptions: strictParseOptions })

interface DiagnosticInput {
  readonly severity: "error" | "warning"
  readonly code: string
  readonly message: string
  readonly path: ReadonlyArray<PathSegment>
  readonly details?: Schema.Json | undefined
}

const snapshotDiagnosticInput = (input: unknown): DiagnosticInput => {
  const snapshot = Json.snapshot(input)
  if (Result.isFailure(snapshot)) {
    throw new TypeError(`Invalid diagnostic input: ${snapshot.failure.message}`)
  }
  return snapshot.success as unknown as DiagnosticInput
}

const diagnosticInstances = new WeakSet<object>()

const finalizeDiagnostic = (self: Diagnostic): true => {
  if (self.details !== undefined) {
    const details = Json.snapshot(self.details)
    if (Result.isFailure(details)) {
      throw new TypeError(`Invalid diagnostic details: ${details.failure.message}`)
    }
    Object.defineProperty(self, "details", {
      value: details.success,
      enumerable: true,
      configurable: false,
      writable: false
    })
  }
  Object.freeze(self.path)
  Object.freeze(self)
  diagnosticInstances.add(self)
  return true
}

/**
 * A machine-readable validation or compilation diagnostic.
 *
 * **Details**
 *
 * Codes are strings rather than a closed union so applications can use the
 * same model for custom workflow policies without losing forward
 * compatibility. Built-in compiler codes remain stable public API.
 *
 * Constructed instances are detached and recursively immutable. For hostile
 * live JavaScript objects, use {@link make}: generic Schema class decoding and
 * the raw generated constructor structurally inspect fields before class
 * finalization and therefore cannot promise accessor-free admission.
 *
 * @category models
 * @since 4.0.0
 */
export class Diagnostic extends Schema.Class<Diagnostic>(
  "@effect/workflow-builder/Diagnostic"
)(DiagnosticFields) {
  readonly #immutable = finalizeDiagnostic(this)

  override toString(): string {
    void this.#immutable
    return super.toString()
  }
}

/**
 * Safely constructs a diagnostic from an unknown strict-JSON value.
 *
 * **Details**
 *
 * The input is inspected through property descriptors, detached, and frozen
 * before the Schema class constructor can structurally inspect it. Accessors,
 * exotic containers, cycles, and non-JSON values are rejected.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (input: unknown): Diagnostic => new Diagnostic(snapshotDiagnosticInput(input))

const invalidCompilationErrorInput = (): never => {
  throw new TypeError("Invalid compilation error input")
}

const finalizeCompilationError = (self: CompilationError): true => {
  for (let index = 0; index < self.diagnostics.length; index++) {
    if (!diagnosticInstances.has(self.diagnostics[index]!)) {
      return invalidCompilationErrorInput()
    }
  }
  Object.freeze(self.diagnostics)
  const plainArgs = (self as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("effect/Data/Error/plainArgs")
  ]
  if (plainArgs !== null && typeof plainArgs === "object") {
    Object.freeze(plainArgs)
  }
  Object.freeze(self)
  return true
}

const CompilationErrorFields = Schema.Struct({
  _tag: Schema.tag("CompilationError"),
  diagnostics: Schema.NonEmptyArray(Diagnostic)
}).annotate({ parseOptions: strictParseOptions })

/**
 * Failure returned when a plan cannot be compiled.
 *
 * **Details**
 *
 * All independent errors found during an admission pass are returned together,
 * allowing a UI or API client to repair a plan without repeated fail-fast
 * round trips.
 *
 * @category errors
 * @since 4.0.0
 */
export class CompilationError extends Schema.ErrorClass<CompilationError>(
  "@effect/workflow-builder/Diagnostic/CompilationError"
)(CompilationErrorFields) {
  readonly #immutable = finalizeCompilationError(this)

  override toString(): string {
    void this.#immutable
    return super.toString()
  }
}

/**
 * Constructs an error diagnostic.
 *
 * @category constructors
 * @since 4.0.0
 */
export const error = (
  code: string,
  message: string,
  path: ReadonlyArray<PathSegment> = [],
  details?: Schema.Json
): Diagnostic =>
  make({
    severity: "error",
    code,
    message,
    path,
    ...(details === undefined ? undefined : { details })
  })

/**
 * Constructs a warning diagnostic.
 *
 * @category constructors
 * @since 4.0.0
 */
export const warning = (
  code: string,
  message: string,
  path: ReadonlyArray<PathSegment> = [],
  details?: Schema.Json
): Diagnostic =>
  make({
    severity: "warning",
    code,
    message,
    path,
    ...(details === undefined ? undefined : { details })
  })
