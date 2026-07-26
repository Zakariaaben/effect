# Workflow Builder — architecture and decision record

Status: consolidated engine implemented on native Effect Workflow\
Scope: `@effect/workflow-builder`\
Last reviewed: 2026-07-26

## Decision summary

Workflow Builder is a typed plan compiler and a durable plan interpreter, not
a hosted workflow product and not a second durable-execution runtime.

- Applications own a versioned **vocabulary**: node kinds with schema-typed
  configuration, ports, failures, and handlers; a link policy; admission
  limits; a contract catalog naming the data types the platform speaks; and
  the curated set of engine built-ins their end users may compose.
- End users own **plans**: portable JSON documents wiring node instances with
  data edges, expressions, outcome-routed control edges, bindings, and
  per-node policy. Plans never contain code. When the definition leaves a
  boundary side open, the plan also owns that side of the workflow's
  interface — named, contract-typed inputs and outputs — because only its
  author knows them. A side declared in code is closed and fully typed
  instead; both modes share one compiler, one resolved boundary, and one
  engine.
- The **compiler** admits a complete plan in one pass, returning every
  independent diagnostic with a path into the document, and produces an
  immutable compiled graph plus a canonical fingerprint free of presentation
  metadata.
- The **engine** is one generic native workflow that deterministically
  interprets a pinned compiled plan. All durability — activity persistence,
  replay, suspension, timers, deferred completion, child executions,
  interruption — is delegated to the injected `effect/unstable/workflow`
  `WorkflowEngine`.

### The consolidation (2026-07-26)

This package previously accumulated three coexisting protocol generations and
a large BPMN interchange slice (~200K lines with tests) without a working
end-to-end engine: the scheduling core was never built, while defensive
ceremony (per-module provenance registries, double-entry pin restatement,
version-frozen envelope vocabularies) grew unboundedly. The consolidation:

- **Kept** the typed vocabulary spine — `Node`, `Port`, `Registry`,
  `LinkPolicy`, `Workflow`, `Plan`, `Compiler`, `Diagnostic`, `Fingerprint` —
  which was sound, and extended it with expressions, outcomes, policies, and
  the plan v2 format.
- **Kept the ideas** worth keeping from the removed protocol-v3 layer:
  collision-free durable names (JSON tuples, never concatenation), attempt
  identity through `Activity.CurrentAttempt` rather than name suffixes,
  business retry as engine-managed attempts distinct from operational
  interrupt retry, failure outcomes encoded inside the activity result, and
  fingerprint-pinned meaning verified fail-closed at run admission.
- **Removed** the V1/V2 process-local execution authorities (history stores,
  decision engines, outbox/broker/worker/lease machinery) — the design
  document itself had already concluded durable execution belongs to the
  native runtime — and the V3 adapter ceremony that surrounded a missing
  interpreter.
- **Parked** the BPMN model/XML/token-kernel work in branch history. The
  portable plan is the native format; BPMN interchange, if revisited, is a
  separate importer producing plans, not a second execution semantics.

Everything removed remains recoverable from git history on
`agent/workflow-builder-bpmn-foundations`.

## Goals

- A portable, immutable, JSON plan any editor or API can store, containing no
  functions, no service references, and no credentials.
- Application-owned vocabularies with typed configuration, ports, outputs,
  failures, handlers, and authorization; end users orchestrate what the
  application registered, and nothing else.
- Reject invalid plans before execution with all independent, path-addressed
  diagnostics in one pass.
- Production semantics: managed retries with durable backoff, timeouts,
  conditional routing, failure routing, human tasks, timers, signals,
  sub-workflows, bounded fan-out, cooperative cancellation, resumption.
- Deterministic replay as a first-class contract.
- Remain Effect-native: `Schema` at every trust boundary, typed failures and
  requirements, `Context.Service` interfaces, replaceable `Layer`
  implementations.

## Non-goals

- Shipping a canvas, form renderer, notification system, directory,
  credential vault, or hosted control plane.
- Reimplementing `effect/unstable/workflow`: no competing journal, activity
  cache, deferred store, clock scheduler, mailbox, or sharding.
- Running user-supplied code because it appears in plan JSON. Executable
  behavior is registered application code; plans select and configure it.
- Exactly-once external side effects. Activity execution is at-least-once;
  handlers integrate idempotency or their own fencing.
- BPMN conformance claims.

## Architecture

```
              Application (code)                        End user (data)
  ┌────────────────────────────────────┐    ┌────────────────────────────────┐
  │ Node.make / Registry.make          │    │ Plan JSON (formatVersion 2)    │
  │ Builtins.* (curated)               │    │  nodes, config, bindings,      │
  │ Workflow.make (boundary, policy,   │    │  policy, data edges+transforms,│
  │   limits) + handlers layer         │    │  outcome control edges         │
  └──────────────┬─────────────────────┘    └──────────────┬─────────────────┘
                 │                                         │
                 └──────────────► Compiler.compile ◄───────┘
                                      │
                     CompiledPlan + Fingerprint (canonical, semantic-only)
                                      │
                              PlanStore.save (append-only revisions)
                                      │
        Runs.start ── payload {planId, revision, fingerprint, input, runKey}
                                      │
                     Engine.Run (one generic native workflow)
                        │ deterministic interpretation:
                        │   readiness → outcomes → dead paths → joins
                        │   expressions (pure)   policies (managed retry)
                        ▼
        native primitives: Activity (node attempts, clock observations,
        task creation) · DurableDeferred (human decisions, signals) ·
        DurableClock (backoff, delays, deadlines) · child executions
        (subWorkflow, forEach) · interrupt/resume
                        ▼
              injected WorkflowEngine layer
              (memory for tests; durable/cluster for production)
```

### Execution semantics

Every node settles exactly once:

- `Completed(outcome, outputs)` — success outcomes come from the definition
  (statically or derived from configuration); the reserved `error` outcome
  exists iff the definition declares a typed failure.
- `Skipped` — the node was on a dead path.

A control edge is *live* when its source completed with exactly the edge's
outcome. Readiness:

- `join: "all"` (default): wait for every dependency (data-edge sources,
  control-edge sources, and expression-referenced nodes) to settle. If the
  node has incoming control edges and none is live, it skips. If a required
  input's feeding edges are all dead (and no binding), it skips. Skipping
  propagates.
- `join: "any"`: run once when the first incoming control edge becomes live;
  skip when all settle dead. Inputs resolve from sources settled at firing
  time — plans should feed any-join inputs from the joined branches.

Failure handling per attempt outcome:

- Typed handler failure → classified against the node's retry policy
  (non-retryable tags, attempt budget); retryable failures wait a
  deterministic durable backoff and retry with a fresh attempt number. On
  exhaustion, the failure routes through the `error` outcome when the plan
  wired it, else fails the run as `NodeFailed`.
- Attempt timeout (`timeouts.attemptMillis`, enforced inside the activity) is
  retryable but never routes as a business error; final timeout fails the run
  as `NodeTimedOut`.
- `timeouts.totalMillis` is an admission budget checked at attempt
  boundaries; it does not preempt a wait in progress.
- Defects propagate as run defects (captured by the native engine); they are
  never encoded as business failures.

### Determinism contract

Replay re-executes the interpreter; correctness requires that everything the
interpreter branches on is either pinned or recorded:

- The plan is pinned by fingerprint and verified at admission; compilation is
  re-run on replay against the same document (link policies should be pure).
- Expressions are pure and total over recorded values.
- Every clock read is an activity (`["node", id, "time", n]`).
- Node attempts, task creation, plan-pin resolution for children, and every
  other side effect are activities, keyed by collision-free JSON-tuple names,
  with the attempt number carried by `Activity.CurrentAttempt` (which
  participates in the native persistence key).
- Human decisions and signals are durable deferred values; the expiration
  race commits first-wins in the deferred, not in the projection store.

### Identity model

| Identity          | Derivation                                                     | Stable across                          |
| ----------------- | -------------------------------------------------------------- | -------------------------------------- |
| Run (executionId) | native hash of workflow tag + `planId:revision:runKey`          | processes, restarts, redelivery        |
| Node occurrence   | JSON tuple `["node", nodeId]` within the run                    | attempts, replays                      |
| Attempt           | `Activity.CurrentAttempt` (managed by the engine's retry loop)  | redelivery of the same attempt         |
| Child run         | parent executionId + node id (+ `item:<index>` for forEach)     | crashes, retries, parallel completion  |
| Human task        | `[executionId, nodeId]`                                         | redelivery of the creating activity    |
| Signal address    | `(workflow tag, executionId, ["signal", name])` deferred        | any process holding the engine layer   |

For-each freezes its item set at activation from a recorded evaluation, and
array index is member identity: completion order cannot change meaning, and
results aggregate in input order.

### External completion

The engine's waiting primitive is not "a human": it is a **durable external
decision** — an opaque token handed out by a registration step, resolved
first-wins by whoever the application authorizes, optionally raced by an
idempotent absolute deadline. Any registered node kind opts in with
`external: true`: its handler becomes the registration step (receiving
`decisionToken` in its context, retried under the normal node policy), and
its settlement is the decision's outcome with the payload on the reserved
`decision` output. `workflow/humanTask` is deliberately implemented as a
profile of this primitive — registration creates a `HumanTasks` work item and
expiry updates its projection — which keeps "human" concerns (claiming,
forms, directories, escalation) in the application-owned service where they
belong while e-signature envelopes, payment webhooks, mail gateways, and
legacy workers use the same machinery.

### Services

- `PlanStore` — append-only, fingerprint-pinned plan revisions. `save` is
  idempotent for identical content and conflicts on divergent content under
  the same revision. Memory layer included; durable stores implement the same
  contract.
- `HumanTasks` — work-item projections plus the completion authority:
  `complete` validates the configured outcome and resolves the run's decision
  deferred first-wins; racing an expiration deadline yields a typed conflict,
  and the projection reconciles to the canonical decision. Memory layer
  included.
- `Runs` — start/execute (idempotent by run key), status, cancel (cooperative
  interrupt + task cancellation + compensation), resume, signal.

## Native Effect Workflow boundary

| Owner                        | Responsibilities                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Workflow Builder             | Plan meaning: compilation, pins, routing decisions, retry/timeout policy, expressions, task vocabulary  |
| Native workflow primitives   | Activity persistence/replay, deferred completion, durable clocks, suspension, child propagation, interrupt |
| Application / deployment     | The `WorkflowEngine` layer, durable `PlanStore`/`HumanTasks`, handler services, authorization, tenancy  |

Invariants at this boundary:

- Durable names are JSON tuples of coordinates; digests and attempt numbers
  never ride in names.
- Business deadlines use durable clocks/schedules; scheduled resolution is
  idempotent by schedule id and cannot move a committed deadline.
- A deferred token is an address, not a capability: `HumanTasks.complete` is
  the authorization boundary for decisions; `Runs.signal` delivery is
  first-wins. Applications gate both behind their own authentication.
- The memory engine is test evidence, not production durability. Cluster
  conformance (crash/restart, failover, cross-process completion) is the
  application's deployment responsibility and this package's test roadmap.

## Prior art

The comparison record retained from the original design work — Temporal,
Restate, DBOS, Argo, Airflow, Prefect, Dagster, Inngest, n8n, Node-RED,
Kestra, Windmill, AWS Step Functions, Camunda/Zeebe, Conductor, Azure Durable
Task, Hatchet, Trigger.dev, Netflix Maestro — shaped these standing choices:

- **Versioned JSON definitions with per-run pins** (Maestro, Step Functions,
  Conductor): a run never re-resolves "latest"; children pin once at start.
- **Durable-execution discipline** (Temporal, Restate, DBOS): append-only
  recorded results, replay as re-execution, logical step identity separate
  from delivery attempts, at-least-once side effects stated honestly.
- **Typed ports and replaceable resources** (Dagster), **structured control
  nodes over root cycles** (Kestra, Windmill, Maestro), **editor-grade
  aggregate diagnostics** (n8n's feedback loop, without its loose typing).
- **Human work as engine state with application-owned presentation**
  (Camunda, Conductor): decisions are durable facts; forms and directories
  stay injectable.
- **Explicit outcome routing instead of magic error edges** (Step Functions'
  catch/retry vocabulary, Camunda's boundary errors) via the reserved `error`
  outcome.

## Roadmap

Durable execution is implemented: `DurableEngine.layer` composes the native
cluster workflow engine into a single-node persistent engine over an
application-supplied `SqlClient`, `PlanStore.layerSql`/`HumanTasks.layerSql`
persist the surrounding state, and `test/Durability.test.ts` proves
crash/restart recovery — a run suspended on a human task survives full
runtime disposal, its completed steps replay from persisted results, and it
resumes to completion in a fresh process over the same database.

Implemented since the consolidation: run observability (`RunJournal`
timeline projection with idempotent replay-safe emission), structured
`while` loops with committed iteration identity, absolute-time waits, cron
schedules with fire-time-idempotent starts, blocking `Runs.await`,
arithmetic in the expression language, and store API completeness
(plan listing/revisions, work-item pagination and reassignment).

Explicit non-goals of this iteration — listed because faking them would be
worse than lacking them:

1. **Multi-runner failover evidence** — the storage model is the cluster
   engine's own and already supports multiple runners; certifying it
   honestly requires a real multi-process harness over Postgres, not a
   simulated one.
2. **Active-instance migration** — typed mappings from a running plan
   revision to a successor (Camunda-style). Running runs stay pinned;
   new runs pick up new revisions.
3. **Plan-level saga regions** — node-kind compensation is implemented;
   explicit compensation *scopes* in the plan format remain future work.
4. **Schedule-to-close preemption** — `timeouts.totalMillis` remains an
   attempt-boundary budget; a deferred-raced hard deadline that preempts
   waits is future work.
5. **Distributed rate quotas and tenant fairness** — per-key concurrency
   and rate controls need a shared-store token authority.
6. **Timezone-aware calendars** — cron evaluation is UTC.
7. **Connector catalog, editor UI, credential vault** — product layers by
   design; the engine stays UI-agnostic.

### Review-panel residuals (hardening backlog)

A six-reviewer panel (three integration personas, three experts) validated
the engine and surfaced work worth tracking. Confirmed correctness and
security issues were fixed with tests (expression stack-safety and admission
bounds; null-prototype scopes; causal journal ordering; fan-out DoS caps;
the two BPMN token-flow divergences; the any-join data race; typed
`InputRejected`). The remaining, deliberately-deferred items:

- **Token defense-in-depth** — HMAC-signed decision/signal tokens with a
  deployment secret, and not returning raw tokens from `HumanTasks`
  list/get, so an authorization lapse is insufficient for compromise.
- **Engine-enforced tenancy** — a tenant column and mandatory predicate on
  every store, `tenantId` in the run identity, and an ownership check before
  a plan may reference another plan.
- **Compiled-plan caching** by `(planId, revision, fingerprint)` — today the
  plan recompiles on every run and every replay.
- **Draft/partial compile mode and an encoded-config introspection helper**
  for canvas UIs, plus structured field paths on schema/config diagnostics.
- **A typed `PlanBuilder`** that emits portable plan JSON with compile-time
  wiring checks, and a `CompiledPlan`-typed `Runs` facade, for code-first
  authoring ergonomics.
- **Run inventory** (`Runs.list` by plan/state/tenant) and a generic
  external-decision registry (the human-task work-item store, generalized).
