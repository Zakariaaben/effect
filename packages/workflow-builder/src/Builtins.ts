/**
 * Engine-interpreted node kinds for control flow, waiting, and human work.
 *
 * Built-ins are ordinary {@link Node.Definition} values so an application
 * curates exactly which constructs its end users may compose: add the chosen
 * definitions to the registry like any other vocabulary entry. They carry no
 * registered handler — the engine recognizes the {@link Kind} annotation and
 * interprets each occurrence itself.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import * as Expression from "./Expression.ts"
import * as Node from "./Node.ts"
import * as Policy from "./Policy.ts"
import * as Port from "./Port.ts"

const strictParseOptions = { onExcessProperty: "error" } as const

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * The version shared by every built-in definition in this engine generation.
 *
 * @category constants
 * @since 4.0.0
 */
export const Version = "1.0.0" as const

/**
 * Discriminates which engine interpretation a built-in definition selects.
 *
 * @category models
 * @since 4.0.0
 */
export type Builtin =
  | "if"
  | "switch"
  | "transform"
  | "forEach"
  | "subWorkflow"
  | "humanTask"
  | "delay"
  | "receive"
  | "fail"

/**
 * Annotation marking a definition as engine-interpreted.
 *
 * **Details**
 *
 * Definitions carrying this annotation take no entry in the handler table:
 * their execution semantics belong to the engine, not to application code.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Kind extends Context.Service<Kind, Builtin>()(
  "@effect/workflow-builder/Builtins/Kind"
) {}

/**
 * Reads the built-in kind of a definition, if any.
 *
 * @category annotations
 * @since 4.0.0
 */
export const kindOf = (definition: Node.Any): Builtin | undefined =>
  Context.getOrUndefined(definition.annotations, Kind)

/**
 * A reference to a stored plan, optionally pinned to an exact revision.
 *
 * **Details**
 *
 * Without `revision`, the engine resolves the latest stored revision once,
 * durably, when the parent run starts — never again for that run.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PlanReference = Schema.Struct({
  planId: Schema.NonEmptyString,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
}).annotate({
  identifier: "WorkflowPlanReference",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link PlanReference}.
 *
 * @category models
 * @since 4.0.0
 */
export type PlanReference = Schema.Schema.Type<typeof PlanReference>

const output = <S extends Port.PayloadSchema>(schema: S) => Port.output(schema, { contract: Port.AnyContract })

/**
 * Exclusive boolean branch.
 *
 * **Details**
 *
 * The condition is evaluated against the run scope (`input`, `nodes`) at
 * activation. Exactly one of the `true`/`false` outcomes becomes live.
 *
 * @category definitions
 * @since 4.0.0
 */
export const If = Node.make("workflow/if", {
  version: Version,
  description: "Routes control flow along the 'true' or 'false' outcome of a condition",
  config: Schema.Struct({
    condition: Expression.Expression
  }).annotate({ parseOptions: strictParseOptions }),
  outcomes: ["true", "false"]
}).annotate(Kind, "if")

/**
 * Exclusive multi-way branch with ordered cases and a default.
 *
 * **Details**
 *
 * Case conditions are evaluated in array order against the run scope; the
 * first `true` case selects its named outcome, otherwise `default` is
 * selected. Case names become the node's outcomes, so an end user's routing
 * vocabulary is visible in the plan document.
 *
 * @category definitions
 * @since 4.0.0
 */
export const Switch = Node.make("workflow/switch", {
  version: Version,
  description: "Routes control flow to the first matching case, or 'default'",
  config: Schema.Struct({
    cases: Schema.NonEmptyArray(
      Schema.Struct({
        name: Schema.NonEmptyString,
        condition: Expression.Expression
      }).annotate({ parseOptions: strictParseOptions })
    )
  }).annotate({ parseOptions: strictParseOptions }),
  outcomes: (config) => [...config.cases.map((c) => c.name), "default"]
}).annotate(Kind, "switch")

/**
 * Pure data mapping evaluated by the engine without an activity boundary.
 *
 * @category definitions
 * @since 4.0.0
 */
export const Transform = Node.make("workflow/transform", {
  version: Version,
  description: "Produces a value from a pure expression over the run scope",
  config: Schema.Struct({
    value: Expression.Expression
  }).annotate({ parseOptions: strictParseOptions }),
  outputs: {
    value: output(Schema.Json)
  }
}).annotate(Kind, "transform")

/**
 * Bounded multi-instance execution of a stored plan, one child run per item.
 *
 * **Details**
 *
 * `items` must evaluate to an array; the member set and order are frozen at
 * activation, and each member keeps the stable identity `item:<index>` across
 * retries and crashes. Each child receives `{ item, index }` as its workflow
 * input unless `input` maps something else (evaluated with `item` and `index`
 * scope roots). Results aggregate in input order regardless of completion
 * order.
 *
 * @category definitions
 * @since 4.0.0
 */
export const ForEach = Node.make("workflow/forEach", {
  version: Version,
  description: "Runs a stored plan once per collection item",
  config: Schema.Struct({
    items: Expression.Expression,
    plan: PlanReference,
    mode: Schema.optionalKey(Schema.Literals(["sequential", "parallel"])),
    concurrency: Schema.optionalKey(PositiveInt),
    input: Schema.optionalKey(Expression.Expression)
  }).annotate({ parseOptions: strictParseOptions }),
  outputs: {
    results: output(Schema.Array(Schema.Json))
  },
  failure: Schema.Json
}).annotate(Kind, "forEach")

/**
 * Synchronous execution of another stored plan as a child run.
 *
 * **Details**
 *
 * The child is pinned when the parent run starts and executes with full
 * durability: child suspension suspends the parent and parent interruption
 * propagates to the child. A failing child surfaces on the `error` outcome as
 * data, or fails the run when unrouted.
 *
 * @category definitions
 * @since 4.0.0
 */
export const SubWorkflow = Node.make("workflow/subWorkflow", {
  version: Version,
  description: "Runs another stored plan and returns its outputs",
  config: Schema.Struct({
    plan: PlanReference,
    input: Schema.optionalKey(Expression.Expression)
  }).annotate({ parseOptions: strictParseOptions }),
  outputs: {
    output: output(Schema.Json)
  },
  failure: Schema.Json
}).annotate(Kind, "subWorkflow")

/**
 * Durable human work item with user-composed decision outcomes.
 *
 * **Details**
 *
 * The engine creates a work item through the `HumanTasks` service and
 * suspends durably until an authorized completion selects one of the
 * configured outcomes. `payload` materializes case data for the assignee;
 * `form` travels opaquely to the application's rendering layer. With
 * `dueInMillis` an absolute deadline is scheduled at activation and the extra
 * `expired` outcome becomes routable.
 *
 * @category definitions
 * @since 4.0.0
 */
export const HumanTask = Node.make("workflow/humanTask", {
  version: Version,
  description: "Waits for a person to complete a work item with one of the configured outcomes",
  config: Schema.Struct({
    title: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.String),
    outcomes: Schema.NonEmptyArray(Schema.NonEmptyString),
    form: Schema.optionalKey(Schema.Json),
    payload: Schema.optionalKey(Expression.Expression),
    assignee: Schema.optionalKey(Expression.Expression),
    candidateGroups: Schema.optionalKey(Expression.Expression),
    dueInMillis: Schema.optionalKey(PositiveInt)
  }).annotate({ parseOptions: strictParseOptions }),
  outputs: {
    output: output(Schema.Json)
  },
  outcomes: (config) => config.dueInMillis === undefined ? config.outcomes : [...config.outcomes, "expired"]
}).annotate(Kind, "humanTask")

/**
 * Durable relative delay.
 *
 * @category definitions
 * @since 4.0.0
 */
export const Delay = Node.make("workflow/delay", {
  version: Version,
  description: "Waits a fixed or computed number of milliseconds",
  config: Schema.Struct({
    durationMillis: Schema.Union([PositiveInt, Expression.Expression])
  }).annotate({ parseOptions: strictParseOptions })
}).annotate(Kind, "delay")

/**
 * Durable wait for one named external signal.
 *
 * **Details**
 *
 * A signal name is unique within a plan, so external senders address a wait
 * by `(runId, signal)` without knowing graph positions. The accepted payload
 * becomes the `payload` output.
 *
 * @category definitions
 * @since 4.0.0
 */
export const Receive = Node.make("workflow/receive", {
  version: Version,
  description: "Waits for an external signal and exposes its payload",
  config: Schema.Struct({
    signal: Schema.NonEmptyString
  }).annotate({ parseOptions: strictParseOptions }),
  outputs: {
    payload: output(Schema.Json)
  }
}).annotate(Kind, "receive")

/**
 * Explicit business termination of the whole run.
 *
 * **Details**
 *
 * `fail` never completes and therefore declares no outcomes; reaching it
 * fails the run with the configured code and message. Use it to model
 * rejection paths that must not produce workflow outputs.
 *
 * @category definitions
 * @since 4.0.0
 */
export const Fail = Node.make("workflow/fail", {
  version: Version,
  description: "Fails the run with a configured business code",
  config: Schema.Struct({
    code: Schema.NonEmptyString,
    message: Schema.optionalKey(Schema.Union([Schema.String, Expression.Expression]))
  }).annotate({ parseOptions: strictParseOptions }),
  outcomes: []
}).annotate(Kind, "fail")

/**
 * Every built-in definition, for registries that admit the complete set.
 *
 * @category definitions
 * @since 4.0.0
 */
export const all: ReadonlyArray<Node.Any> = Object.freeze([
  If,
  Switch,
  Transform,
  ForEach,
  SubWorkflow,
  HumanTask,
  Delay,
  Receive,
  Fail
])

/**
 * Default execution policy suitable for retryable built-ins.
 *
 * **Details**
 *
 * Built-ins have no default retry: engine steps are deterministic and human
 * or timer waits are not attempts. This constant exists for applications that
 * want to attach an explicit policy when curating definitions.
 *
 * @category constants
 * @since 4.0.0
 */
export const noRetry: Policy.Policy = Object.freeze({})
