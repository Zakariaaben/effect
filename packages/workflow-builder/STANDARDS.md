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

BPMN 2.0.2 is treated as prior art and a possible future import source, not
as this package's format. **No BPMN conformance is claimed.** The earlier
BPMN model/XML/kernel work is preserved in branch history
(`agent/workflow-builder-bpmn-foundations`) should an importer be revisited.

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
| WCP16 Deferred choice                | ◐      | Human-task decision vs. expiration deadline races first-wins; a general external-event race node is roadmap |
| WCP19 Cancel task                    | ❌     | No targeted single-node cancellation                                                             |
| WCP20 Cancel case                    | ◐      | `Runs.cancel`: cooperative interrupt, child cascade, task cancellation, compensation hooks; no physical-stop claim |
| WCP21 Structured loop                | ❌     | Roadmap (`while` with committed iteration identity)                                              |
| WCP22 Recursion                      | ✅     | `workflow/subWorkflow` may reference its own plan; bounded by run depth                          |
| WCP23 Transient trigger              | ❌     | Signals are durable, not transient                                                               |
| WCP24 Persistent trigger             | ✅     | `workflow/receive` + `Runs.signal`: first-wins durable delivery, retained if it arrives early    |

✅ supported ◐ partial (as described) ❌ not supported

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

## Time patterns

- Durable relative delays (`workflow/delay`), retry backoff as durable
  timers, human-task deadlines as idempotent absolute schedules racing the
  decision first-wins. Calendars/cron and absolute-date waits are roadmap.
