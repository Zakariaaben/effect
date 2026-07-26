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
  templates, records, lists, boolean logic, comparisons, coalescing) used for
  mappings, conditions, and configuration. Deterministic and bounded.
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
- **Human tasks** — durable work items with user-composed decision outcomes,
  optional forms/payloads/assignment data, and an expiration deadline that
  races completion first-wins.
- **Waiting** — durable relative delays and named external signals.
- **Composition** — sub-workflow calls and bounded `forEach` fan-out over a
  collection, each iteration a durable child run with a stable identity.

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

## Guarantees and boundaries

- **Pinned meaning.** A run references `(planId, revision, fingerprint)`; the
  fingerprint covers only semantic content (never canvas metadata) and the
  engine fails closed on any drift.
- **Deterministic replay.** The interpreter reads only the pinned plan, the
  run input, and recorded results; clock observations and side effects cross
  activity boundaries. Handlers must keep their own nondeterminism inside
  their activity (it is recorded) and their external effects idempotent —
  activity execution is at-least-once.
- **Durability is the injected engine's.** `WorkflowEngine.layerMemory`
  drives tests; production durability, crash recovery, and distribution
  require a persistent engine layer (e.g. the cluster engine) plus durable
  `PlanStore`/`HumanTasks` implementations. This package ships memory layers
  and the semantics they must preserve.
- **Cancellation is cooperative.** `Runs.cancel` interrupts the run, cascades
  to children, cancels open work items, and runs compensation; it does not
  claim an already-started external effect stopped.
- **No BPMN conformance is claimed.** Earlier BPMN interchange work is parked
  in branch history; the portable plan is this package's native format. See
  [STANDARDS.md](./STANDARDS.md) for Workflow Patterns traceability.

See [DESIGN.md](./DESIGN.md) for the architecture record and the runnable
examples in [examples/](./examples).
