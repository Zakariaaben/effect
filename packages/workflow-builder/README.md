# `@effect/workflow-builder`

A typed workflow plan compiler and durable execution engine for Effect.

Applications declare a **vocabulary** of versioned, schema-typed node kinds in
code. End users compose those nodes — through any UI or API — into **portable
JSON plans**: graphs with data wiring, expressions, conditional routing,
retry policies, human tasks, timers, signals, and sub-workflows. The
**compiler** validates a complete plan in one pass and pins its meaning with a
canonical fingerprint. The **engine** executes compiled plans durably on the
native `effect/unstable/workflow` runtime — suspension, replay, retries
across crashes, and distribution come from the injected `WorkflowEngine`
layer, not from this package.

```
vocabulary (code)      plan (JSON)         compiled plan          durable run
Node / Port / ─────►   nodes, edges, ────► validated graph, ────► one native workflow
Registry / Policy      expressions,        fingerprint pin        interpreting the plan
                       policies                                   on WorkflowEngine
```

## Two ways to own a workflow

Both integration styles are first-class, decided per boundary side by one
rule: **declared in code → closed and typed; omitted in code → the plan owns
it.**

- **Code-first (static).** The application declares the workflow's `inputs`
  and `outputs` ports on the definition. Every plan shares that exact typed
  contract — right for embedded pipelines like *send email → reduce stock →
  charge account*, where the app owns the workflow's identity and wants
  compile-time types end to end.
- **End-user-composed (dynamic).** The definition declares no boundary — only
  the node catalog, link policy, limits, and a **contract catalog** mapping
  contract names to schemas. Each plan then declares its own interface
  (`inputs: [{name, contract, required?}]`, `outputs: [{name, contract}]`),
  because only the end user knows what their workflow consumes and produces.
  Contracts absent from the catalog validate as JSON, and every value is
  re-validated at each consuming port regardless.

## The division of labor

| Layer                        | Owns                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Application code             | Node definitions (schemas, handlers, services), link policy, limits, which built-ins end users may compose                 |
| Portable plan (JSON)         | Node instances and configuration, data edges with transforms, outcome-routed control edges, bindings, per-node policy      |
| Compiler                     | Structural + semantic validation with aggregate path-addressed diagnostics; deterministic schedule; canonical fingerprint  |
| Engine (this package)        | Deterministic interpretation: readiness, outcome routing, dead-path skipping, managed retries, expression evaluation       |
| Native `WorkflowEngine`      | Activity result persistence and replay, suspension/resumption, durable deferreds and clocks, child executions, interruption |

## Defining a vocabulary

```ts
import { Builtins, LinkPolicy, Node, Port, Registry, Workflow } from "@effect/workflow-builder"
import { Effect, Schema } from "effect"

const Ocr = Node.make("document/ocr", {
  version: "1.0.0",
  inputs: { document: Port.input(Schema.String, { contract: "app/document-url" }) },
  outputs: { text: Port.output(Schema.String, { contract: "app/text" }) },
  policy: { retry: { maxAttempts: 3, initialDelayMillis: 1000 } }
})

const registry = Registry.make(
  Ocr,
  // The application curates which control constructs end users may compose.
  Builtins.If,
  Builtins.Switch,
  Builtins.HumanTask,
  Builtins.Transform
)

const definition = Workflow.make("app/document-flow", {
  version: "1.0.0",
  inputs: { document: Port.output(Schema.String, { contract: "app/document-url" }) },
  outputs: { result: Port.input(Schema.Json, { contract: "*", required: false }) },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({ maxNodes: 64, maxEdges: 128, maxFanIn: 8, maxFanOut: 8, maxDepth: 32 })
})
```

Handlers are registered separately, so the same vocabulary can be compiled in
a browser and executed on a server:

```ts
const handlers = registry.toLayer(registry.of({
  "document/ocr@1.0.0": ({ inputs }) => Effect.succeed({ text: recognize(inputs.document) })
}))
```

## What plans can express

- **Data flow** — typed port-to-port edges; per-edge `transform` expressions;
  literal/expression `bindings` on input ports; the wildcard `*` contract for
  generic JSON interop.
- **Expressions** — a small, pure, JSON-portable language (references,
  templates, records, lists, boolean logic, comparisons, arithmetic,
  coalescing) used for mappings, conditions, and configuration.
  Deterministic and bounded; a visual builder emits the AST directly.
- **Control flow** — every node completes with an *outcome*; control edges
  route on outcomes (`if` → `true`/`false`, `switch` → case names, human
  tasks → their configured decisions). Untaken branches settle as skipped and
  skipping propagates. Joins are `all` (default, with dead-path awareness) or
  `any` (first live branch).
- **Failure routing** — a node with a typed failure schema exposes a reserved
  `error` outcome and `error` data port. Wire them to handle business
  failures in the graph; leave them unwired to fail the run.
- **Policies** — per-node retry (attempts, exponential backoff, non-retryable
  tags) and timeouts (per-attempt, total budget), declared in the plan and
  merged over definition defaults; backoff waits are durable timers.
- **External completion** — any registered node kind may declare
  `external: true`: its handler only *registers* the work (it receives an
  opaque decision token to hand to an e-signature provider, a webhook
  consumer, a legacy worker, an email gateway), and the node's result is the
  durable `{outcome, output}` decision later resolved against that token via
  `Runs.resolveDecision` — first-wins against an optional config-derived
  deadline, exposed on the reserved `decision` output.
- **Human tasks** — durable work items with user-composed decision outcomes,
  optional forms/payloads/assignment data, and an expiration deadline that
  races completion first-wins. Implemented as a profile of the external
  completion primitive, plus the `HumanTasks` work-item inventory
  (list/claim/complete) for application UIs.
- **Waiting** — durable relative delays, absolute-time waits
  (`workflow/waitUntil`, restart-proof idempotent schedules), and named
  external signals.
- **Loops** — bounded `forEach` fan-out and pre-tested `workflow/while`
  loops whose iterations are durable child runs with committed identities
  and a hard iteration cap.
- **Composition** — sub-workflow calls and bounded `forEach` fan-out over a
  collection, each iteration a durable child run with a stable identity.
- **Sagas** — a node kind may declare a `compensation` handler in code
  (refund the charge, release the reservation); compensations arm as
  compensable steps complete and unwind as durable activities, in reverse
  order, when the run fails or is cancelled — never on a failure the plan
  routed as a handled `error` outcome. Nodes without a declared compensation
  simply have nothing to undo, and a cancelled sub-workflow unwinds its own
  compensations recursively.

## Running plans

```ts
import { Compiler, Engine, HumanTasks, PlanStore, Runs } from "@effect/workflow-builder"
import { WorkflowEngine } from "effect/unstable/workflow"

const EngineLive = Engine.layer(definition).pipe(
  Layer.provideMerge(Layer.mergeAll(handlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory) // or a durable cluster engine layer
)

const program = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, planJson)
  const store = yield* PlanStore.PlanStore
  yield* store.save(compiled)

  const handle = yield* Runs.start("my-plan", { input: { document: "s3://..." } })
  // ... later, from any process sharing the WorkflowEngine:
  yield* Runs.signal(handle.runId, "docReady", { url: "..." })
  const status = yield* Runs.status(handle.runId)
})
```

Human work is completed through the `HumanTasks` service:

```ts
const tasks = yield* HumanTasks.HumanTasks
const open = yield* tasks.list({ state: "open", candidateGroup: "finance" })
yield* tasks.complete(open[0].taskId, { outcome: "approve", output: { amount: 1200 } })
```

## Triggers

- **Schedules (cron).** `Schedules.create({ scheduleId, planId, cron, input })`
  registers a recurring start (UTC cron, validated at creation, optional
  revision pin); the `Schedules.runner` layer fires due schedules. Firing is
  **idempotent by construction**: the run key derives from the schedule id
  and the exact fire time, so restarts and duplicate runners join the same
  run instead of double-firing, and a backlog of missed occurrences
  collapses to one fire for the latest. Memory and SQL stores included.
- **Webhooks and events.** Admission is a one-liner on the existing API:
  `Runs.start(planId, { input, runKey: deliveryId })` — the caller-supplied
  key makes redelivered webhooks join the original run. Authentication and
  payload validation happen in your HTTP layer before admission.

## Observing runs

`Runs.status` reads a run's state without blocking; `Runs.await` waits for
the terminal result from any process. Providing `RunJournal.layerMemory` or
`RunJournal.layerSql` switches on a per-run **timeline projection** — run
started, every node settlement with its attempt count, work items created,
decisions recorded, compensations run, and the terminal outcome — queryable
with `RunJournal.timeline(runId)`. The journal is deliberately
non-authoritative: entries are idempotent under replay, a journal failure
never fails a run, and a rebuilt journal cannot corrupt anything.

## Security model

The engine is a library inside your trust boundary; it deliberately ships
**mechanism, not user policy**:

- **Tokens are addresses, not capabilities.** Decision tokens and signal
  addresses locate durable state; possessing one must not imply permission.
  Your application authenticates and authorizes every caller of
  `HumanTasks.complete`, `Runs.resolveDecision`, `Runs.signal`, and the run
  lifecycle operations before invoking them — exactly where your user model
  and directory live.
- **Plans are untrusted input.** Everything a plan can do was registered in
  code and admitted by your link policy and limits; expressions are pure and
  bounded; plans carry no code and no credentials. Secrets belong in handler
  services, never in configuration.
- **Tenancy** is the deployment's concern: separate databases (or table
  prefixes) per tenant, and the `tenantId` engine option flows into every
  handler's context for per-tenant service scoping.

## Operations

- **Recovery latency** is governed by the sharding poll interval
  (`DurableEngine` `shardingConfig.entityMessagePollInterval`, default 10s —
  lower it for latency-sensitive deployments, keep tests at ~100ms).
- **Keep stable across restarts** of one database: `shardsPerGroup`, shard
  groups, and the storage table prefix.
- **Retention**: the native message storage grows with completed runs;
  schedule external pruning of processed rows per your compliance window.
  The `RunJournal` and `HumanTasks` tables are projections and may be
  archived independently.
- **At-least-once effects**: handler side effects and compensations may
  re-execute after crashes; integrate idempotency keys (provided in every
  handler context) with external systems.

## Guarantees and boundaries

- **Pinned meaning.** A run references `(planId, revision, fingerprint)`; the
  fingerprint covers only semantic content (never canvas metadata) and the
  engine fails closed on any drift.
- **Deterministic replay.** The interpreter reads only the pinned plan, the
  run input, and recorded results; clock observations and side effects cross
  activity boundaries. Handlers must keep their own nondeterminism inside
  their activity (it is recorded) and their external effects idempotent —
  activity execution is at-least-once.
- **Durability is real and single-node friendly.** `WorkflowEngine.layerMemory`
  drives tests; `DurableEngine.layer` provides the persistent engine over any
  `SqlClient` (SQLite for one box, Postgres/MySQL for a server) — no
  multi-node deployment required — with `PlanStore.layerSql` and
  `HumanTasks.layerSql` persisting plans and work items beside it. Runs
  survive process crashes: committed steps replay from their recorded
  results, suspended waits wake on completion or their scheduled deadline,
  and the restart proof lives in `test/Durability.test.ts`.
- **Cancellation is cooperative.** `Runs.cancel` interrupts the run, cascades
  to children, cancels open work items, and runs compensation; it does not
  claim an already-started external effect stopped.
- **No BPMN conformance is claimed.** Earlier BPMN interchange work is parked
  in branch history; the portable plan is this package's native format. See
  [STANDARDS.md](./STANDARDS.md) for Workflow Patterns traceability.

See [DESIGN.md](./DESIGN.md) for the architecture record and the runnable
examples in [examples/](./examples).
