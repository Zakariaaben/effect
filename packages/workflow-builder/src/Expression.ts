/**
 * A small, portable, deterministic expression language for plan data flow.
 *
 * Expressions are plain JSON documents, so a plan can carry data mappings,
 * branch conditions, and input bindings across process and persistence
 * boundaries without serializing functions. Evaluation is pure, total over a
 * validated tree, and free of clocks, randomness, and I/O, which makes every
 * committed evaluation safe to replay.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const strictParseOptions = { onExcessProperty: "error" } as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Maximum number of AST nodes accepted by {@link validate}.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxNodes = 512

/**
 * Maximum AST depth accepted by {@link validate}.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaxDepth = 32

/**
 * One step into a scope value: an object property or an array index.
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

/**
 * A non-empty path whose first segment names a scope root.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Path = Schema.NonEmptyArray(PathSegment)

/**
 * The decoded type of {@link Path}.
 *
 * @category models
 * @since 4.0.0
 */
export type Path = readonly [PathSegment, ...ReadonlyArray<PathSegment>]

/**
 * Comparison operators over two numbers or two strings.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CompareOp = Schema.Literals(["lt", "le", "gt", "ge"])

/**
 * The decoded type of {@link CompareOp}.
 *
 * @category models
 * @since 4.0.0
 */
export type CompareOp = typeof CompareOp.Type

/**
 * A portable expression tree.
 *
 * **Details**
 *
 * - `Literal` yields a constant JSON value.
 * - `Ref` reads a value out of the evaluation scope and fails when the path is
 *   absent.
 * - `Has` tests whether a path is present.
 * - `Template` concatenates literal text and stringified scalar results.
 * - `Record` and `List` construct containers from sub-expressions.
 * - `Not`, `And`, and `Or` operate on strict booleans; `And`/`Or` short
 *   circuit in operand order.
 * - `Eq` is deep JSON equality; `Compare` orders two numbers or two strings.
 * - `Size` yields string length, array length, or object key count.
 * - `Coalesce` yields the first operand that is neither absent nor `null`,
 *   or `null` when every operand is skipped.
 *
 * @category models
 * @since 4.0.0
 */
export type Expression =
  | { readonly _tag: "Literal"; readonly value: Schema.Json }
  | { readonly _tag: "Ref"; readonly path: Path }
  | { readonly _tag: "Has"; readonly path: Path }
  | { readonly _tag: "Template"; readonly parts: ReadonlyArray<string | Expression> }
  | { readonly _tag: "Record"; readonly fields: Readonly<{ [key: string]: Expression }> }
  | { readonly _tag: "List"; readonly items: ReadonlyArray<Expression> }
  | { readonly _tag: "Not"; readonly operand: Expression }
  | { readonly _tag: "And"; readonly operands: ReadonlyArray<Expression> }
  | { readonly _tag: "Or"; readonly operands: ReadonlyArray<Expression> }
  | { readonly _tag: "Eq"; readonly left: Expression; readonly right: Expression }
  | {
    readonly _tag: "Compare"
    readonly op: CompareOp
    readonly left: Expression
    readonly right: Expression
  }
  | { readonly _tag: "Size"; readonly operand: Expression }
  | { readonly _tag: "Coalesce"; readonly operands: ReadonlyArray<Expression> }

const Suspended: Schema.Codec<Expression, Expression> = Schema.suspend(
  (): Schema.Codec<Expression, Expression> => Expression
)

/**
 * Schema for {@link Expression} wire documents.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Expression: Schema.Codec<Expression, Expression> = Schema.Union([
  Schema.TaggedStruct("Literal", { value: Schema.Json }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Ref", { path: Path }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Has", { path: Path }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Template", {
    parts: Schema.Array(Schema.Union([Schema.String, Suspended]))
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Record", {
    fields: Schema.Record(Schema.String, Suspended)
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("List", { items: Schema.Array(Suspended) }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Not", { operand: Suspended }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("And", { operands: Schema.Array(Suspended) }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Or", { operands: Schema.Array(Suspended) }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Eq", { left: Suspended, right: Suspended }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Compare", {
    op: CompareOp,
    left: Suspended,
    right: Suspended
  }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Size", { operand: Suspended }).annotate({ parseOptions: strictParseOptions }),
  Schema.TaggedStruct("Coalesce", { operands: Schema.Array(Suspended) }).annotate({ parseOptions: strictParseOptions })
]).annotate({ identifier: "WorkflowExpression" }) as any

/**
 * The evaluation scope: named JSON roots such as `input`, `nodes`, or `value`.
 *
 * @category models
 * @since 4.0.0
 */
export type Scope = Readonly<{ [root: string]: Schema.Json }>

/**
 * Failure produced while evaluating or validating an expression.
 *
 * **Details**
 *
 * `expressionPath` locates the failing sub-expression inside the root
 * expression document. `dataPath` is present for scope reads and locates the
 * missing or mismatched value.
 *
 * @category models
 * @since 4.0.0
 */
export interface EvaluationError {
  readonly _tag: "ExpressionEvaluationError"
  readonly code: "PathNotFound" | "TypeMismatch" | "LimitExceeded"
  readonly message: string
  readonly expressionPath: ReadonlyArray<PathSegment>
  readonly dataPath?: ReadonlyArray<PathSegment> | undefined
}

const evaluationError = (
  code: EvaluationError["code"],
  message: string,
  expressionPath: ReadonlyArray<PathSegment>,
  dataPath?: ReadonlyArray<PathSegment>
): EvaluationError =>
  Object.freeze({
    _tag: "ExpressionEvaluationError",
    code,
    message,
    expressionPath: Object.freeze([...expressionPath]),
    ...(dataPath === undefined ? undefined : { dataPath: Object.freeze([...dataPath]) })
  })

// ----------------------------------------------------------------------------
// Constructors
// ----------------------------------------------------------------------------

/**
 * Constructs a constant expression.
 *
 * @category constructors
 * @since 4.0.0
 */
export const literal = (value: Schema.Json): Expression => ({ _tag: "Literal", value })

/**
 * Constructs a scope reference.
 *
 * @category constructors
 * @since 4.0.0
 */
export const ref = (...path: Path): Expression => ({ _tag: "Ref", path })

/**
 * Constructs a presence test for a scope path.
 *
 * @category constructors
 * @since 4.0.0
 */
export const has = (...path: Path): Expression => ({ _tag: "Has", path })

/**
 * Constructs a string template from literal text and scalar sub-expressions.
 *
 * @category constructors
 * @since 4.0.0
 */
export const template = (...parts: ReadonlyArray<string | Expression>): Expression => ({ _tag: "Template", parts })

/**
 * Constructs a JSON object from named sub-expressions.
 *
 * @category constructors
 * @since 4.0.0
 */
export const record = (fields: Readonly<{ [key: string]: Expression }>): Expression => ({ _tag: "Record", fields })

/**
 * Constructs a JSON array from sub-expressions.
 *
 * @category constructors
 * @since 4.0.0
 */
export const list = (...items: ReadonlyArray<Expression>): Expression => ({ _tag: "List", items })

/**
 * Constructs a strict boolean negation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const not = (operand: Expression): Expression => ({ _tag: "Not", operand })

/**
 * Constructs a short-circuiting conjunction. Empty input yields `true`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const and = (...operands: ReadonlyArray<Expression>): Expression => ({ _tag: "And", operands })

/**
 * Constructs a short-circuiting disjunction. Empty input yields `false`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const or = (...operands: ReadonlyArray<Expression>): Expression => ({ _tag: "Or", operands })

/**
 * Constructs a deep JSON equality test.
 *
 * @category constructors
 * @since 4.0.0
 */
export const eq = (left: Expression, right: Expression): Expression => ({ _tag: "Eq", left, right })

/**
 * Constructs an ordering comparison of two numbers or two strings.
 *
 * @category constructors
 * @since 4.0.0
 */
export const compare = (op: CompareOp, left: Expression, right: Expression): Expression => ({
  _tag: "Compare",
  op,
  left,
  right
})

/**
 * Constructs a size expression: string length, array length, or object key
 * count.
 *
 * @category constructors
 * @since 4.0.0
 */
export const size = (operand: Expression): Expression => ({ _tag: "Size", operand })

/**
 * Constructs an expression yielding the first operand that is neither an
 * absent reference nor `null`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const coalesce = (...operands: ReadonlyArray<Expression>): Expression => ({ _tag: "Coalesce", operands })

// ----------------------------------------------------------------------------
// Static analysis
// ----------------------------------------------------------------------------

interface StaticInfo {
  readonly nodes: number
  readonly depth: number
  readonly references: ReadonlyArray<Path>
}

const children = (expression: Expression): ReadonlyArray<Expression> => {
  switch (expression._tag) {
    case "Literal":
    case "Ref":
    case "Has":
      return []
    case "Template":
      return expression.parts.filter((part): part is Expression => typeof part !== "string")
    case "Record":
      return Object.keys(expression.fields).sort().map((key) => expression.fields[key]!)
    case "List":
      return expression.items
    case "Not":
    case "Size":
      return [expression.operand]
    case "And":
    case "Or":
    case "Coalesce":
      return expression.operands
    case "Eq":
    case "Compare":
      return [expression.left, expression.right]
  }
}

const analyze = (expression: Expression): StaticInfo => {
  let nodes = 0
  let maxDepth = 0
  const references: Array<Path> = []
  const stack: Array<readonly [Expression, number]> = [[expression, 1]]
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!
    nodes++
    maxDepth = Math.max(maxDepth, depth)
    if (nodes > MaxNodes || depth > MaxDepth) {
      return { nodes, depth: maxDepth, references }
    }
    if (current._tag === "Ref" || current._tag === "Has") {
      references.push(current.path)
    }
    for (const child of children(current)) {
      stack.push([child, depth + 1])
    }
  }
  return { nodes, depth: maxDepth, references: Object.freeze(references) }
}

/**
 * Collects every scope path referenced by `Ref` or `Has` sub-expressions.
 *
 * **Details**
 *
 * The compiler uses these paths to check that references name known scope
 * roots, nodes, and ports, and to derive implicit data dependencies from
 * bindings.
 *
 * @category static analysis
 * @since 4.0.0
 */
export const references = (expression: Expression): ReadonlyArray<Path> => analyze(expression).references

/**
 * Validates expression size and depth bounds.
 *
 * @category static analysis
 * @since 4.0.0
 */
export const validate = (expression: Expression): Result.Result<void, EvaluationError> => {
  const info = analyze(expression)
  if (info.nodes > MaxNodes) {
    return Result.fail(
      evaluationError("LimitExceeded", `Expression has more than ${MaxNodes} nodes`, [])
    )
  }
  if (info.depth > MaxDepth) {
    return Result.fail(
      evaluationError("LimitExceeded", `Expression nesting exceeds ${MaxDepth}`, [])
    )
  }
  return Result.succeed(undefined)
}

// ----------------------------------------------------------------------------
// Evaluation
// ----------------------------------------------------------------------------

const hasOwn = Object.prototype.hasOwnProperty

type Read =
  | { readonly _tag: "Found"; readonly value: Schema.Json }
  | { readonly _tag: "Absent"; readonly dataPath: ReadonlyArray<PathSegment> }

const read = (scope: Scope, path: Path): Read => {
  const root = path[0]
  if (typeof root !== "string" || !hasOwn.call(scope, root)) {
    return { _tag: "Absent", dataPath: [root] }
  }
  let current: Schema.Json = scope[root]!
  for (let index = 1; index < path.length; index++) {
    const segment = path[index]!
    if (Array.isArray(current)) {
      if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0 || segment >= current.length) {
        return { _tag: "Absent", dataPath: path.slice(0, index + 1) }
      }
      current = current[segment]!
      continue
    }
    if (current !== null && typeof current === "object") {
      const key = typeof segment === "number" ? String(segment) : segment
      if (!hasOwn.call(current, key)) {
        return { _tag: "Absent", dataPath: path.slice(0, index + 1) }
      }
      current = (current as Schema.JsonObject)[key]!
      continue
    }
    return { _tag: "Absent", dataPath: path.slice(0, index + 1) }
  }
  return { _tag: "Found", value: current }
}

const deepEquals = (left: Schema.Json, right: Schema.Json): boolean => {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => deepEquals(item, right[index]!))
  }
  if (left !== null && typeof left === "object") {
    if (right === null || typeof right !== "object" || Array.isArray(right)) {
      return false
    }
    const leftObject = left as Schema.JsonObject
    const rightObject = right as Schema.JsonObject
    const leftKeys = Object.keys(leftObject)
    const rightKeys = Object.keys(rightObject)
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => hasOwn.call(rightObject, key) && deepEquals(leftObject[key]!, rightObject[key]!))
  }
  return false
}

type Evaluation = Result.Result<Schema.Json, EvaluationError>

const evaluateBoolean = (
  expression: Expression,
  scope: Scope,
  expressionPath: ReadonlyArray<PathSegment>
): Result.Result<boolean, EvaluationError> => {
  const value = evaluateAt(expression, scope, expressionPath)
  if (Result.isFailure(value)) {
    return Result.fail(value.failure)
  }
  if (typeof value.success !== "boolean") {
    return Result.fail(evaluationError(
      "TypeMismatch",
      `Expected a boolean, received ${describe(value.success)}`,
      expressionPath
    ))
  }
  return Result.succeed(value.success)
}

const describe = (value: Schema.Json): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`

const evaluateAt = (
  expression: Expression,
  scope: Scope,
  expressionPath: ReadonlyArray<PathSegment>
): Evaluation => {
  switch (expression._tag) {
    case "Literal": {
      return Result.succeed(expression.value)
    }
    case "Ref": {
      const found = read(scope, expression.path)
      return found._tag === "Found"
        ? Result.succeed(found.value)
        : Result.fail(evaluationError(
          "PathNotFound",
          `Path '${expression.path.join(".")}' is not present in the evaluation scope`,
          expressionPath,
          found.dataPath
        ))
    }
    case "Has": {
      return Result.succeed(read(scope, expression.path)._tag === "Found")
    }
    case "Template": {
      const parts: Array<string> = []
      for (let index = 0; index < expression.parts.length; index++) {
        const part = expression.parts[index]!
        if (typeof part === "string") {
          parts.push(part)
          continue
        }
        const value = evaluateAt(part, scope, [...expressionPath, "parts", index])
        if (Result.isFailure(value)) {
          return value
        }
        const scalar = value.success
        if (typeof scalar !== "string" && typeof scalar !== "number" && typeof scalar !== "boolean") {
          return Result.fail(evaluationError(
            "TypeMismatch",
            `Template parts must be strings, numbers, or booleans, received ${describe(scalar)}`,
            [...expressionPath, "parts", index]
          ))
        }
        parts.push(typeof scalar === "string" ? scalar : JSON.stringify(scalar))
      }
      return Result.succeed(parts.join(""))
    }
    case "Record": {
      const output: { [key: string]: Schema.Json } = {}
      for (const key of Object.keys(expression.fields).sort()) {
        const value = evaluateAt(expression.fields[key]!, scope, [...expressionPath, "fields", key])
        if (Result.isFailure(value)) {
          return value
        }
        output[key] = value.success
      }
      return Result.succeed(output)
    }
    case "List": {
      const output: Array<Schema.Json> = []
      for (let index = 0; index < expression.items.length; index++) {
        const value = evaluateAt(expression.items[index]!, scope, [...expressionPath, "items", index])
        if (Result.isFailure(value)) {
          return value
        }
        output.push(value.success)
      }
      return Result.succeed(output)
    }
    case "Not": {
      const operand = evaluateBoolean(expression.operand, scope, [...expressionPath, "operand"])
      return Result.isFailure(operand) ? operand : Result.succeed(!operand.success)
    }
    case "And": {
      for (let index = 0; index < expression.operands.length; index++) {
        const operand = evaluateBoolean(expression.operands[index]!, scope, [...expressionPath, "operands", index])
        if (Result.isFailure(operand)) {
          return operand
        }
        if (!operand.success) {
          return Result.succeed(false)
        }
      }
      return Result.succeed(true)
    }
    case "Or": {
      for (let index = 0; index < expression.operands.length; index++) {
        const operand = evaluateBoolean(expression.operands[index]!, scope, [...expressionPath, "operands", index])
        if (Result.isFailure(operand)) {
          return operand
        }
        if (operand.success) {
          return Result.succeed(true)
        }
      }
      return Result.succeed(false)
    }
    case "Eq": {
      const left = evaluateAt(expression.left, scope, [...expressionPath, "left"])
      if (Result.isFailure(left)) {
        return left
      }
      const right = evaluateAt(expression.right, scope, [...expressionPath, "right"])
      if (Result.isFailure(right)) {
        return right
      }
      return Result.succeed(deepEquals(left.success, right.success))
    }
    case "Compare": {
      const left = evaluateAt(expression.left, scope, [...expressionPath, "left"])
      if (Result.isFailure(left)) {
        return left
      }
      const right = evaluateAt(expression.right, scope, [...expressionPath, "right"])
      if (Result.isFailure(right)) {
        return right
      }
      const l = left.success
      const r = right.success
      if (typeof l === "number" && typeof r === "number") {
        return Result.succeed(compareOrder(expression.op, l < r ? -1 : l > r ? 1 : 0))
      }
      if (typeof l === "string" && typeof r === "string") {
        return Result.succeed(compareOrder(expression.op, l < r ? -1 : l > r ? 1 : 0))
      }
      return Result.fail(evaluationError(
        "TypeMismatch",
        `Comparison requires two numbers or two strings, received ${describe(l)} and ${describe(r)}`,
        expressionPath
      ))
    }
    case "Size": {
      const value = evaluateAt(expression.operand, scope, [...expressionPath, "operand"])
      if (Result.isFailure(value)) {
        return value
      }
      const sized = value.success
      if (typeof sized === "string") {
        return Result.succeed(sized.length)
      }
      if (Array.isArray(sized)) {
        return Result.succeed(sized.length)
      }
      if (sized !== null && typeof sized === "object") {
        return Result.succeed(Object.keys(sized).length)
      }
      return Result.fail(evaluationError(
        "TypeMismatch",
        `Size requires a string, array, or object, received ${describe(sized)}`,
        [...expressionPath, "operand"]
      ))
    }
    case "Coalesce": {
      for (let index = 0; index < expression.operands.length; index++) {
        const value = evaluateAt(expression.operands[index]!, scope, [...expressionPath, "operands", index])
        if (Result.isFailure(value)) {
          if (value.failure.code === "PathNotFound") {
            continue
          }
          return value
        }
        if (value.success !== null) {
          return value
        }
      }
      return Result.succeed(null)
    }
  }
}

/**
 * Evaluates a validated expression against a scope of JSON roots.
 *
 * **Details**
 *
 * Evaluation is pure and deterministic: the same expression and scope always
 * produce the same result, so a durable engine can re-evaluate committed
 * decisions during replay without recording them separately.
 *
 * @category evaluation
 * @since 4.0.0
 */
export const evaluate = (expression: Expression, scope: Scope): Evaluation => evaluateAt(expression, scope, [])

const compareOrder = (op: CompareOp, ordering: -1 | 0 | 1): boolean => {
  switch (op) {
    case "lt":
      return ordering < 0
    case "le":
      return ordering <= 0
    case "gt":
      return ordering > 0
    case "ge":
      return ordering >= 0
  }
}
