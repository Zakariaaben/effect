# Workflow standards traceability

Scope: `@effect/workflow-builder`\
Last reviewed: 2026-07-26

## Sources and claim discipline

The requirements catalogue is Russell, van der Aalst, and ter Hofstede,
*Workflow Patterns: The Definitive Guide* (2016), cross-checked against the
[Workflow Patterns Initiative](https://www.workflowpatterns.com/). Patterns
are cited as design requirements, not as a conformance certificate: a pattern
is listed as supported only when the portable plan can express it and the
engine executes it under replay.

BPMN 2.0.2 is prior art and a *design lens*, not this package's execution
format. The `Bpmn` module ships an importer and exporter over the executable
subset (`Bpmn.toPlan` / `Bpmn.fromPlan`), but **no BPMN Process Execution
Conformance is claimed**: the importer maps a bounded subset to the portable
plan and fails closed on unsupported vocabulary, while some token-flow shapes
are deliberately reinterpreted through the plan's join semantics rather than
executed as a BPMN engine would.

### Known BPMN divergences

These are intentional and documented, not conformance:

- **Exclusive gateway, no default flow, no case true.** BPMN raises a runtime
  error; the importer synthesizes a `default`-outcome fail node so an
  unmatched gateway fails the run (matching the *outcome*, not the error
  vocabulary).
- **Exclusive split → parallel join.** BPMN deadlocks awaiting the missing
  token; the plan's synchronizing merge fires on the live branch and does not
  deadlock. More forgiving than BPMN.
- **Parallel split → converging exclusive gateway (multi-merge, WCP8).** BPMN
  passes each token independently (two firings); the plan fires once. This
  shape should be avoided in imported models.
- **Export.** Emitted exclusive gateways carry routing in `wb:config` (not
  native `conditionExpression`/`default`), and outcome routing uses an
  extension attribute; a standards modeler can display and re-import the
  file faithfully, but a third-party BPMN engine cannot execute it. "Standard
  BPMN XML for interchange", not "portable executable BPMN".

## Control-flow patterns

| Pattern (WCP)                        | Status | Realization                                                                                      |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| WCP1 Sequence                        | ✅     | Control/data edges; readiness on settled dependencies                                            |
| WCP2 Parallel split                  | ✅     | Multiple control edges from one outcome (or plain data fan-out)                                  |
| WCP3 Synchronization                 | ✅     | `join: "all"` over live incoming branches                                                        |
| WCP4 Exclusive choice                | ✅     | `workflow/if`, `workflow/switch` (ordered cases, `default`)                                      |
| WCP5 Simple merge                    | ✅     | `join: "all"` after an exclusive split (dead-path aware: fires on the one live branch)           |
| WCP6 Multi-choice                    | ✅     | Independent conditional branches (several `if` guards from one point)                            |
| WCP7 Structured synchronizing merge  | ✅     | `join: "all"` after multi-choice — dead branches settle as skipped and the join fires on the live set |
| WCP8 Multi-merge                     | ❌     | A node settles once per run; re-entry requires loops (roadmap)                                   |
| WCP9 Structured discriminator        | ◐      | `join: "any"` fires once on the first live branch; remaining branches drain (no reset/re-entry)  |
| WCP10 Arbitrary cycles               | ❌     | Rejected (`CycleDetected`); iteration is structured (`forEach`, roadmap `while`)                 |
| WCP11 Implicit termination           | ✅     | A run completes when every node settles                                                          |
| WCP12–13 MI (design/runtime known)   | ✅     | `workflow/forEach`: member set frozen at activation, stable `item:<index>` identity, ordered gather |
| WCP14 MI (runtime, no a priori)      | ❌     | Open-ended fan-out is out of scope for the frozen-set semantics                                  |
| WCP16 Deferred choice                | ◐      | External decisions (human tasks, callbacks) race their outcomes and deadline first-wins; a race across multiple distinct event sources is roadmap |
| WCP19 Cancel task                    | ❌     | No targeted single-node cancellation                                                             |
| WCP20 Cancel case                    | ◐      | `Runs.cancel`: cooperative interrupt, child cascade, task cancellation, compensation hooks; no physical-stop claim |
| WCP21 Structured loop                | ✅     | `workflow/while`: pre-tested condition over recorded data, iterations as durable child runs with committed `iter:<n>` identity, hard bound |
| WCP22 Recursion                      | ✅     | `workflow/subWorkflow` may reference its own plan; bounded by run depth                          |
| WCP23 Transient trigger              | ❌     | Signals are durable, not transient                                                               |
| WCP24 Persistent trigger             | ✅     | `workflow/receive` + `Runs.signal`: first-wins durable delivery, retained if it arrives early    |

✅ supported ◐ partial (as described) ❌ not supported

**A note on `join: "all"`.** Despite the name, it is a *synchronizing* merge
with dead-path elimination, not a strict AND-join: it waits for every
incoming branch to settle, then fires when at least one incoming control edge
is live (settling as skipped when all are dead), and skipping propagates
transitively. This single mechanism realizes WCP3, WCP5, and WCP7 — and,
restricted to the admitted acyclic plan language, an acyclic OR-join. A pure
control merge never deadlocks; a merge whose dead branch is fed by an
unrelated slow node is latency-coupled to that node's settlement (never a
deadlock, but not "fire on first arrival").

**A note on dead-path references.** A required data-edge input from a skipped
node settles the consumer as skipped, but an *expression* reference
(`workflow/transform`/`if`/`switch` config, or a binding) to a skipped node's
output evaluates to a missing path and fails the run, matching Camunda's
"missing variable" behavior. Guard such references with `coalesce` when a
branch may legitimately not run (as when a zero-iteration `while` feeds a
downstream transform).

## Data patterns

- **Task-to-task data passing** — typed port wiring with schema validation on
  every hop (WDP data interaction patterns for task-to-task, block-task, and
  case-level data via workflow inputs/outputs).
- **Data transformation** — per-edge `transform` expressions and pure
  `workflow/transform` nodes (input/output transformation, WDP30–31).
- **Task precondition/postcondition on data** — required inputs gate
  execution (dead-path skip); output schemas validate postconditions.
- **Data-based routing** — expression conditions over recorded values
  (WDP43).
- Case data is immutable-once-recorded; there is no shared mutable variable
  scope by design (auditable data flow instead of blackboard state).

## Resource / human-work patterns

The engine implements the durable mechanism; staffing policy stays
application-owned by design:

- Work-item lifecycle: created → offered/claimed → completed | expired |
  cancelled, with first-wins decision authority in the durable deferred.
- Direct distribution (`assignee`), role-based distribution
  (`candidateGroups`), claim/release (WRP: direct allocation, role-based
  allocation, resource-initiated allocation).
- Deadline-based escalation: expiration outcome routable in the graph.
- Delegation, escalation chains, four-eyes separation, and organizational
  models are application policy above `HumanTasks`.

## Exception-handling patterns

- Typed business failures with policy-driven retry (backoff, non-retryable
  tags, budgets) and explicit `error`-outcome continuation — work-item
  failure with continuation (WEP patterns for task failure handling).
- Timeouts as distinct, non-business outcomes (attempt and total budget).
- Run-level abort (`workflow/fail`) and external cancellation with
  compensation hooks and work-item cleanup.
- Saga compensation: node kinds declare compensation handlers in code;
  completed compensable steps unwind as durable activities in reverse order
  on run failure or cancellation, before the terminal result is observable,
  and never for failures the plan routed as handled outcomes. No
  exactly-once claim: compensations are at-least-once like any activity.

## Time patterns

- Durable relative delays (`workflow/delay`), absolute-date waits
  (`workflow/waitUntil` over idempotent schedules), retry backoff as durable
  timers, decision deadlines as idempotent absolute schedules racing
  completion first-wins, and cron-based recurring starts (`Schedules`) with
  fire-time-derived idempotent run keys so restarts and duplicate runners
  cannot double-fire. Timezone-aware calendars remain roadmap (cron is
  UTC-based).
