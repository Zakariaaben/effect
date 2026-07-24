# Workflow standards and conformance plan

Status: family-level Workflow Patterns requirements plus atomic evidence for a
small control subset; semantic, data, DI, durable-state, bounded XML-infoset,
strict named core-process/DI XML mapping, and executable token-kernel
foundations; complete atomic pattern traceability, XML/XSD coverage, execution
semantics, and normative conformance suites pending\
Last reviewed: 2026-07-24

## Sources and authority

The normative interoperability source is
[OMG Business Process Model and Notation 2.0.2](https://www.omg.org/spec/BPMN/2.0.2),
including the normative specification PDF, `BPMN20.xsd`, `BPMNDI.xsd`,
`DC.xsd`, `DI.xsd`, and `Semantic.xsd`.

The semantic requirements catalogue is Russell, van der Aalst, and ter
Hofstede, _Workflow Patterns: The Definitive Guide_ (MIT Press, 2016), checked
against the [Workflow Patterns Initiative](https://www.workflowpatterns.com/).
The book is a systematic capability catalogue, not a normative standard. Where
its BPMN mapping, an implementation convention, or WS-HumanTask differs from
BPMN 2.0.2, the normative OMG specification controls the BPMN claim and the
extra behavior becomes an explicitly versioned engine extension.

## Claim discipline

BPMN 2.0.2 defines separate conformance types:

- Process Modeling Conformance, with Descriptive, Analytic, and Common
  Executable subclasses.
- Process Execution Conformance, requiring the operational execution semantics
  and Activity lifecycle plus import of BPMN Process diagrams and their
  definitional Collaboration.
- BPEL Process Execution Conformance.
- Choreography Modeling Conformance.
- Complete Conformance, which combines every applicable class.

The package currently claims none of them. A schema-valid XML parser, a familiar
gateway API, or the ability to draw equivalent shapes is not a conformance
claim. Product documentation must report exactly one of:

1. `BpmnInterchange` — loss-aware BPMN 2.0.2 XML and DI import/export.
2. `BpmnProcessModeling:<subclass>` — only after every required element,
   attribute, association, visual interchange, and semantic rule for that
   subclass passes.
3. `BpmnProcessExecution` — only after all applicable operational semantics,
   Activity lifecycle rules, and required imports pass.
4. `EffectWorkflowExtensions:<version>` — behavior outside portable BPMN.

Unsupported and implementation-defined constructs produce diagnostics. They are
never silently approximated while retaining a BPMN conformance label.

## Current implementation boundary

Implemented foundations:

- a strict, versioned BPMN 2.0.2 semantic IR for processes, collaborations,
  participants, message flows, typed sequence flows, hierarchical scopes,
  concrete activity kinds, gateways, loops, event subprocesses, boundary
  events, and inline or reusable event definitions;
- hostile-input-safe, aggregate validation for identifiers, references,
  containment, exact sequence-flow scope, reverse flow lists, default flows,
  gateway legality, event contexts, boundary attachment/interruption, ad-hoc
  restrictions, and collaboration ownership;
- a bounded normalized data, IO-specification, association, interface,
  operation, message, error, and local CallableElement-binding slice;
- a normalized BPMNDI/DI/DC semantic representation with reference and geometry
  validation;
- a separate durable execution-state schema for token markings, scope
  invocations, gateway/loop/multi-instance/call frames, catch subscriptions,
  timers, work items, compensation registrations, cancellation regions, and
  exact protocol-v3 task resolutions;
- a replayable bounded token kernel for an explicitly admitted subset of none
  start/end events, tasks, embedded subprocesses, conditional/default sequence
  flows, exclusive/parallel gateways, and Standard Loops on generic Tasks. The
  loop subset persists iteration and condition evidence, supports the
  `testBefore` pre-test/post-test choice, and requires a positive
  `loopMaximum`;
- `FixedMultiInstance/1`, a generic-Task-only executable profile over that
  kernel. It evaluates one exact cardinality expression once at activity
  activation, freezes a closed member set under
  `maxMultiInstanceCardinality`, assigns stable index/key identities, and
  schedules it sequentially or in parallel with behavior All. Exact runtime
  counters are supplied to an optional completion condition after every
  committed logical member completion. The first `true` result atomically
  terminates already generated active members and prevents a sequential planned
  suffix from being generated before one outgoing continuation; that suffix is
  not counted as terminated. Cardinality zero, out-of-order parallel
  completion, Boundary Error and failure cleanup, late-completion
  fencing/idempotency, exact native task occurrences, and causal journal replay
  are tested;
- `CollectionMultiInstance/1`, a second generic-Task-only closed-group profile.
  One exact externally compiled binding for `loopDataInputRef` is evaluated
  once at activity activation and its bounded canonical JSON array is frozen.
  Source indices, order, and duplicate values are preserved. A declared scalar
  `inputDataItem` opts into per-member item mapping; absence means no implicit
  item injection. Complete-result gathering requires `loopDataOutputRef`, one
  scalar `outputDataItem`, a matching collection-valued Task DataOutput, and a
  protocol-v3 Task binding. Every output is codec-validated and the final array
  follows input-index order rather than parallel completion order. Empty input
  creates no work and produces `[]` when gathering is configured. Output
  gathering with `completionCondition` fails closed until a partial-result
  policy is explicitly modeled. Collection/data bindings, declarations,
  limits, and evaluator pins are committed to the executable fingerprint;
- an atomic protocol-v3 Task/Boundary Error slice whose executable fingerprint
  commits immutable task bindings and exact business-failure identity mappings.
  Exact success follows the normal route; an explicitly promoted failure may
  be caught by one matching interrupting Boundary Error; unmapped or uncaught
  failure deterministically fails the root. A native Effect Workflow bridge
  checks the exact compiled binding before dispatch, executes the retry
  composition once, and emits a portable resolution command plus its raw
  outcome. Operational timeout, defects, and interruption are not promoted to
  BPMN Error. Resolution idempotency, terminal cleanup, and causal replay are
  enforced without claiming the complete Activity or event lifecycle. The XML
  executable facade accepts these immutable bindings explicitly through
  `CompileXmlOptions`; they are external executable inputs, not values inferred
  from BPMN XML; and
- a resource-bounded namespace-aware XML 1.0 infoset parser, semantic
  validator, and serializer;
- strict profile `bpmn-2.0.2-core-process-di-v5`, which fails closed while
  importing, validating, canonically exporting, and normalized-round-tripping
  definitions metadata, ordinary processes and recursive subprocesses, generic
  tasks, source-level call activities with namespace-expanded callable-element
  QNames, none start/end events, exclusive/parallel gateways, sequence flows,
  conditions, defaults, Standard Loop characteristics, represented
  Multi-Instance characteristics on Tasks, explicit expression-language
  version bindings, and the complete current normalized DI slice. The
  Multi-Instance XML mapping round-trips cardinality, collection references,
  scalar input/output data items with namespace-expanded subject QNames and
  xsd:string names including the empty string, sequential/parallel mode,
  completion condition, behavior, and One/None event references in BPMN XSD
  order, while its executable intersection is deliberately narrower.
  Unrepresented data-item children fail closed. A mapped Standard Loop requires
  one version-bound formal
  `loopCondition`, materializes the BPMN `testBefore=false` default when
  omitted, and requires a positive `loopMaximum`. BPMN 2.0.2 itself permits an
  absent `loopMaximum` and a more general or absent `tExpression`
  `loopCondition`; the stricter requirements are deliberate fail-closed
  executable-profile constraints, not statements about BPMN validity; and
- a strict executable-admission facade that composes that named XML profile
  with the bounded token kernel without lowering through the version `1` DAG,
  and proves import, conditional/default routing, parallel split/join,
  subprocess, bounded Standard Loop, fixed Multi-Instance, and collection
  Multi-Instance execution, journal replay, canonical export, re-import,
  recompilation, and same-journal replay. Optional task, data-document, and
  collection bindings are external compile inputs, not semantics inferred from
  BPMN XML alone;
- an Effectful executable-preparation boundary whose domain-separated
  SHA-256 fingerprint commits to the normalized semantic model, root process,
  kernel semantic version, limits, named profile, and exact evaluator-build
  manifest; kernel semantic version `5`, state version `6`, fingerprint version
  `4`, and transition-journal version `5` fail closed on a model/profile
  mismatch;
- a strict Effect evaluator registry with full language/version/build/limit
  tuple resolution and no compatibility or latest fallback, plus exact
  evaluator-binding and bounded usage evidence in condition journal events; an
  Effect driver keeps the pure kernel atomic while resolving asynchronous
  evaluators under fixed operation inputs/time, timeout and step limits, and
  interruption-preserving failure handling;
- a sealed journal artifact whose complete causal payload has an independently
  anchorable history digest; and
- separate protocol-version `3` child-target, parent-link, lineage,
  close-policy, definition-build, command/event, relation-identity, and pure
  replay contracts. They deliberately model durable parent/child facts without
  yet claiming transactional child execution; and
- a thin protocol-v3 host over an injected native Effect `WorkflowEngine`, plus
  bounded replay-stable operation names and memory-backed contract tests for
  native activity replay, deferred suspension/resume, forced-durable clocks,
  and nested parent-child suspension. This is backend evidence, not a BPMN
  conformance claim; and
- content-addressed dynamic occurrence and semantic-operation descriptors, plus
  separately pinned deferred success/error codecs, authenticated current
  static-DAG occurrence admission, closed activity purposes and exact result
  contract references, an atomic exact-build executable registry, and a native
  guard-activity mapping that rejects same-coordinate descriptor drift and
  forces positive semantic timers through durable clocks; and
- authenticated ordered `FirstSettled` and `FirstSuccess` races over exact
  node-activity, timer, and deferred operations. Participant kind, digest,
  contracts, order, result identity, generation, and waiter-interruption policy
  are committed before execution; replay, typed failures, and native defects
  are covered. This establishes a generic race primitive, not yet the complete
  BPMN Activity lifecycle, Event-Based Gateway, event-subscription, or
  human-work semantics; and
- managed native retry for exact node attempts, including policy-pinned failure
  identity, classifier resolution, attempt and elapsed admission budgets,
  replay-recorded jitter, durable-clock backoff, and a content-addressed
  schedule-to-close controller around the complete retry loop. A stable
  persistent clock is acknowledged before time observation or node execution;
  contenders publish success-only envelopes to one native first-wins deferred,
  attempts and publication are clock-fenced, and the recorded
  typed completion/timeout winner is coordinate-, timestamp-, and
  policy-checked. Native Activity persistence records the complete Exit and an
  authoritative completion timestamp after activity finalization. This closes
  start-to-close ordering for success, typed error, and defect even when timer
  delivery is late: pre-deadline defects retain their non-interrupt Cause
  semantics and at-or-after-deadline defects become the exact attempt timeout.
  Pure interruption does not publish a terminal, and interruption reasons are
  removed from a mixed terminal Cause. `Schema.Defect` may normalize a defect
  payload across a wire backend, so exact JavaScript object identity is not
  claimed. Absolute ordering of a defect escaping the complete retry loop
  against a late-delivered outer schedule-to-close timer remains open. Loser
  interruption is never joined; timeout fences semantic completion without
  claiming rollback of an external side effect.
  The same closed typed result is available through `executeDetailed` without
  another execution or successful output decoding. Schedule-to-start first
  persists a canonical `ScheduleToStartArmed` acknowledgement with its activity
  and timer digests, attempt, `armedAt`, duration, and absolute deadline.
  Scheduling and activity dispatch occur only after that acknowledgement, and
  replay reuses it rather than extending the deadline. The timed-attempt
  protocol has start and terminal first-wins gates, plus this arm gate when
  schedule-to-start is configured. The Activity-side start gate receives its
  expected timeout through a lazy `Effect` evaluated only after the gate returns
  a timeout. That authorization derives schedule-to-start from the canonical arm
  acknowledgement or start-to-close from canonical `Started`, then requires an
  exact match across activity, attempt, timer, kind, duration, and deadline. Its
  boundary remains entry into the native Activity RPC immediately before
  handler preparation, not acquisition of a future distributed worker queue or
  lease. The canonical `Started` acknowledgement pins the start-to-close
  duration and absolute deadline, so redelivery cannot extend it. Persisted
  version `2` `Succeeded` and `ApplicationFailed` outcomes carry `completedAt`
  as a portable observability fact that is validated against the native
  Activity receipt; that native receipt is the arbitration clock. An attempt
  timeout remains a distinct `AttemptTimedOut`
  terminal rather than an application failure and cannot enter BPMN Boundary
  Error routing. Losing scheduled resolutions are not cancelled and can consume
  backend timer capacity until their deadline even though first-wins makes them
  semantically inert. These primitives still do not provide authenticated
  deferred tokens, worker leases, heartbeat expiry, cancellation propagation,
  machine-crash or multi-worker proof, or proof that an external side effect
  stopped, so this remains backend evidence rather than a complete BPMN
  Activity or boundary-event implementation; and
- machine-readable requirement/coverage schemas that record the named mapping
  slice separately while declaring no BPMN conformance claim.

Not yet implemented and therefore not claimed:

- semantic and DI XML mapping outside the strict named slice, lossless unknown
  extension preservation, encoding protocol-v3 task bindings inside BPMN XML,
  and import/export validation against the normative XSDs. The executable
  facade accepts bindings only as explicit external compile options;
- the complete BPMN Common Executable metamodel, including its full data,
  resource, correlation, interface/operation, lane, artifact, and visual
  interchange surfaces;
- token-transition and Activity lifecycle semantics beyond the explicitly
  bounded kernel subset;
- externalized or streaming Multi-Instance item manifests, partial-result
  collection policy, Multi-Instance SubProcesses or CallActivities,
  One/None/Complex progressive behavior events, open/dynamic WCP15 fan-out,
  draining WCP34/WCP36 joins, and a native collective-cancellation/audit
  projection. Open creation and draining require a separate
  `OpenForEachGroup/1` profile instead of widening the closed
  `FixedMultiInstance/1` or `CollectionMultiInstance/1` journals;
- executable call activities, immutable callable-element resolution, a
  transactional parent/child execution authority, and integration of the
  implemented protocol-v3 linkage, cancellation, lineage, and replay semantics
  into BPMN token execution;
- a production native Effect Workflow adapter, rebuildable BPMN semantic
  timeline/export, externally authenticated history anchors, migration tooling
  for pre-fingerprint states/journals, and isolated evaluator adapters or any
  bundled FEEL/XPath implementation;
- a complete normative requirement catalogue, official fixture round-trips,
  marking equivalence, soundness analysis, and scheduler-permutation evidence;
  and
- any BPMN modeling, execution, choreography, BPEL, or complete conformance
  class.

## Architectural correction

Portable plan format version `1` remains a one-shot acyclic dependency graph.
Its existing compiler, fingerprint, and histories remain stable.

The standards-capable format is a distinct versioned semantic IR. It requires:

- Hierarchical `Process`, `SubProcess`, `Transaction`, `EventSubProcess`,
  `CallActivity`, `Activity`, `Gateway`, `Event`, and typed `SequenceFlow`
  definitions.
- Conditional and default flows with a pinned expression language, evaluation
  order, no-match policy, and recorded routing decisions.
- A persistent token multiset/marking rather than one topological cursor.
- Atomic token consumption and production with conservation checks.
- Dynamic invocation identity containing scope invocation, activation epoch,
  branch, loop iteration, multi-instance item, and repeated invocation
  generation.
- Durable gateway frames, loop frames, multi-instance groups, call frames,
  subscriptions, conversations, work items, data versions, timers,
  compensation registrations, and cancellation scopes.
- Bounded structured and arbitrary cycles with token, iteration, duration,
  history, fan-out, and resource limits.
- Separate successful, failed, canceled, incident, and terminate-success
  outcomes.
- Import/export provenance and a machine-readable loss report.

Structured regions remain the preferred authoring form because they are easier
to validate and migrate. Arbitrary BPMN cycles and unstructured flows require a
general marking interpreter; they must not be lowered to fake structured loops.

## Pattern notation

The tables use:

- **N** — directly represented by standard BPMN 2.0.2 semantics.
- **C** — representable by a composition or only under explicit contextual
  constraints.
- **E** — exact semantics require an engine extension.
- **I** — BPMN names the concept but leaves the operational subsystem to the
  implementation.

These labels are requirements-analysis results, not current implementation
status.

## Machine-readable Workflow Patterns status

The checked-in catalogue now separates the book's control-flow, data, resource,
exception, service/correlation, flexibility, change, scientific, time, and
workflow-activity families using printed-page locators from pp. 105–329. It
also records executable evidence for only eight atomic control patterns:
Sequence, Parallel Split, Synchronization, Exclusive Choice, the bounded Task
form of Structured Loop, fixed design-time and runtime-known Multi-Instance
groups (WCP13/WCP14), and the fixed cancelling partial Multi-Instance join
(WCP35).

This is intentionally not described as complete traceability. Requirement
`WFP-ATOMIC-CATALOG-COMPLETE` remains unsupported until every named pattern or
dimension has a stable identifier, a design/backlog target, a support status,
and implementation or test evidence. In particular, a family-level prose table
does not count as implementation support, and protocol-v2 timers do not imply
complete TP1–TP10 coverage.

## Control-flow traceability

### Branching

| Pattern and book pages    | Semantic obligation                                                                                               | BPMN                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Parallel split, 110–111   | One arrival atomically emits one token on every outgoing flow.                                                    | **N**, diverging Parallel Gateway                                         |
| Exclusive choice, 111–115 | Evaluate one committed snapshot; select exactly one ordered/default flow or raise a declared no-match incident.   | **N**, Exclusive Gateway                                                  |
| Deferred choice, 115–116  | Keep alternatives enabled until one external event wins atomically; withdraw losers and define late-event policy. | **N/C**, Event-Based Gateway; human work needs an implementation contract |
| Multi-choice, 117–119     | Select every true branch from one snapshot; explicitly handle an empty set.                                       | **N**, Inclusive Gateway                                                  |
| Thread split, 120–121     | Emit a fixed token multiplicity on one path and pin shared-versus-copied data behavior.                           | **C**, `completionQuantity`; portability-sensitive                        |

### Joining and merging

| Pattern and book pages                  | Semantic obligation                                                                                      | BPMN                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Full synchronization, 125–127           | One token per incoming flow and activation epoch; fire once when all arrive.                             | **N**, converging Parallel Gateway                   |
| Structured partial join, 127–129        | Fire once at threshold, let remaining branches drain, and reset only after all expected branches arrive. | **C**, Complex Gateway                               |
| Blocking partial join, 129–130          | Retain excess arrivals in per-branch queues until the current epoch fully resets.                        | **C**, Complex Gateway                               |
| Canceling partial join, 130–132         | At threshold, emit once and atomically cancel unfinished incoming regions.                               | **E**                                                |
| Generalized AND-join, 132–134           | Consume one token from every incoming multiset; preserve excess for later firings.                       | **N**, Parallel Gateway                              |
| Simple merge, 134–136                   | Pass each arrival independently under an admitted mutual-exclusion context.                              | **N/C**, Exclusive Gateway or implicit merge         |
| Multi-merge, 136–137                    | Pass every arrival, including concurrent arrivals, without synchronization or coalescing.                | **N**, converging Exclusive Gateway                  |
| Structured synchronizing merge, 138–141 | Wait only for the active branch set recorded by its paired split.                                        | **N**, Inclusive Gateway                             |
| Local synchronizing merge, 141–143      | Determine active/skipped inputs locally without mixing loop epochs.                                      | **N/C**, Inclusive Gateway                           |
| General synchronizing merge, 143–146    | Fire only when no absent input can still become active; reject unresolved cyclic “vicious circle” cases. | **C**, Inclusive Gateway with non-local reachability |
| Thread merge, 146–147                   | Consume a fixed number of tokens from one branch without mixing generations.                             | **C**, `startQuantity`                               |

The generic shape `Parallel { all | any | quorum }` is insufficient. Every join
must pin its threshold, loser policy, drain/reset rule, excess-token rule,
re-entry rule, and whether activation provenance is explicit or inferred.

The Workflow Patterns Initiative's canonical Discriminator aliases are not
additional semantics hidden from this table: the Structured Discriminator is
the structured partial join at threshold `1`, the Blocking Discriminator is the
blocking partial join at threshold `1`, and the Canceling Discriminator is the
canceling partial join at threshold `1`. The same reset, drain, excess-arrival,
and loser-cancellation obligations continue to apply.

### Repetition and multiple instances

| Pattern and book pages                 | Semantic obligation                                                                                | BPMN                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| Arbitrary cycles, 147–149              | Support multiple entries/exits and unequal repetition counts through a bounded general marking.    | **N**, backward Sequence Flows  |
| Structured loop, 149–150               | Distinguish pre-test, post-test, and combined pre/post tests; persist iteration identity.          | **N**, loop characteristics     |
| Recursion, 150–152                     | Pinned synchronous call frames, parent wait, base case, depth limit, and cancellation propagation. | **N**, recursive Call Activity  |
| MI without synchronization, 153–155    | Detached instances with explicit cardinality-evaluation time and parent-close behavior.            | **C**, MI behavior without join |
| MI with design-time knowledge, 155–157 | Fixed sequential/parallel cardinality; wait for all.                                               | **N**                           |
| MI with runtime knowledge, 158–159     | Snapshot cardinality or collection once at activation; later source mutation cannot add instances. | **N**                           |
| MI without a priori knowledge, 159–160 | Open group supporting durable spawn and close, then wait for outstanding instances.                | **E**                           |
| Static partial MI join, 160–162        | Emit at threshold while the remainder continues; reset only after full drain.                      | **E**                           |
| Canceling partial MI join, 162–164     | Emit at threshold and cancel the remainder under an explicit race table.                           | **N/C**, `completionCondition`  |
| Dynamic partial MI join, 164–165       | Open group; close creation at threshold; existing instances continue and drain.                    | **E**                           |

Current `WFP-WCP21-STRUCTURED-LOOP` executable evidence is intentionally
narrower than the complete repetition row: it covers while-style pre-test and
BPMN post-tested behavior on one generic Task, with a version-bound formal
condition whose `true` result means continue and a mandatory positive iteration
cap. The combined pre/post-test
variant, Standard Loops on SubProcesses, and arbitrary cycles remain
unsupported by this executable slice. Fixed Task Multi-Instance behavior is
tracked independently by requirements `WFP-WCP13-MULTI-INSTANCE-DESIGN-TIME`,
`WFP-WCP14-MULTI-INSTANCE-RUNTIME`, and
`WFP-WCP35-CANCELLING-PARTIAL-MI-JOIN`. This mapping
follows BPMN 2.0.2 §10.3.8/Table 10.28 and the specification's explicit WCP-21
reference in §13.3.6; it is not a broader process-execution claim.

`FixedMultiInstance/1` is the closed-group executable profile for one generic
Task. Its version-bound cardinality expression is evaluated exactly once before
member creation. A non-negative value is frozen under a compiled maximum; zero
completes without a member. Sequential mode starts only the next pending member,
while parallel mode starts the complete bounded set. Member identity is
`group activation + item index + item key`, independent of handler retry,
delivery, or native Activity attempt. Durable state and every completion
condition evaluation carry exact instance, active, completed, and terminated
counters. At each decision boundary, generated instances equal active plus
completed plus terminated instances; a sequential member not yet generated
remains in the durable pending suffix instead of corrupting that BPMN runtime
invariant. The optional condition is evaluated after each logical member
completion; its first `true` result terminates any already generated active
remainder, prevents a sequential planned suffix from being generated, fences
late `completeTask`, and emits one continuation. The ungenerated suffix is not
counted as terminated. Behavior absent or All is admitted. Boundary Error and
terminal failure cancel generated group members before their normal failure
semantics proceed. State, transition journal, replay, XML round-trip,
expression runtime, executable facade, and the exact native Effect Workflow
occurrence bridge all carry direct tests.

`CollectionMultiInstance/1` reuses that closed group without pretending a
collection is a mutable work queue. The exact collection binding is evaluated
once at activity activation, before member creation, and its canonical array is
copied into durable source evidence under separate collection, item, and
cardinality limits. Indices are stable semantic identities; array order and
duplicate values are retained. Mutation of the evaluator's later source cannot
change the group. Sequential mode exposes one member at a time and parallel
mode may finish in any order without changing durable index order. Empty input
completes immediately; configured output gathering records an empty array.

BPMN's `inputDataItem` is an explicit scalar mapping switch in this executable
profile. If it is present with `isCollection=false`, the exact current item,
index, key, and collection DataInput reference are available to the Task bridge.
If it is absent, no current item is injected implicitly. Complete output
gathering is also explicit: `loopDataOutputRef` and a scalar
`outputDataItem` must name a collection-valued Task DataOutput, and a
protocol-v3 Task binding must codec-validate each member output. The final
array is assembled by input index, never by completion order. Because a
first-true `completionCondition` deliberately terminates a suffix or subset,
combining it with output gathering is rejected until the model selects a
partial-result contract. External data documents, expression bindings,
collection bindings, Task bindings, and byte limits are fingerprinted; BPMN XML
alone is not treated as executable data authority.

Parallel mode supports WCP13 when a pinned expression represents a
design-time-fixed model cardinality and WCP14 when it obtains the cardinality
from activation data. A collection snapshot also supports WCP14 because its
membership is determined at runtime before expansion. Sequential mode is an
additional BPMN execution form, not evidence for those patterns' concurrent
reading. The parallel closed profiles support the cancelling portion of WCP35
with a first-true `completionCondition`, but collection output gathering is not
admitted in that mode. Neither supports WCP15 open creation or the draining
semantics of WCP34/WCP36: those need `OpenForEachGroup/1`, whose creation-close
fact and drain/ignore policy cannot be reconstructed from a closed group.
The pattern names and distinctions follow the official
[Workflow Patterns control-flow catalogue](https://www.workflowpatterns.com/patterns/control/).

The cross-engine comparison reinforces five rules. A closed item set is
snapshotted before expansion; logical item identity never aliases retry or
delivery identity; semantic cardinality and worker-concurrency limits are
separate; complete result aggregation preserves input order despite
out-of-order parallel completion; and very large groups require explicit
history segmentation or continuation rather than unbounded journals. Native
Effect Workflow can supply persistence, child execution, replay, activities,
deferreds, clocks, and backend interruption when selected. The builder owns
portable BPMN group semantics, expression evidence, and occurrence mapping; it
does not reimplement or require those native capabilities.

### Concurrency, triggers, cancellation, and completion

| Pattern and book pages                   | Semantic obligation                                                                                | BPMN                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Sequence, 167–168                        | Transfer each token independently; never coalesce concurrent invocations.                          | **N**                                                        |
| Interleaved routing, 168–169             | Execute every member exactly once in any order with one durable region mutex.                      | **C**, sequential ad-hoc SubProcess has completion ambiguity |
| Interleaved parallel routing, 169–171    | Respect a partial order while allowing only one member to execute at once.                         | **C**, sequential ad-hoc SubProcess                          |
| Critical section, 171–172                | Hold a fenced durable lease for a whole region, including crash/cancel release.                    | **E**                                                        |
| Milestone, 172–174                       | Atomically test a state window keyed by a milestone epoch; loops may reopen it.                    | **E**                                                        |
| Transient trigger, 174–176               | Consume only while a matching wait exists; otherwise discard.                                      | **N/C**, BPMN does not standardize transport retention       |
| Persistent trigger, 176–177              | Buffer each deduplicated trigger for later ordered consumption.                                    | **E**                                                        |
| Cancel task, 178–179                     | Withdraw enabled/running work, fence late results, and emit no normal continuation.                | **N/C**, interrupting boundary event                         |
| Cancel MI task, 180–181                  | Cancel unfinished group members, retain completed members, and emit no group success.              | **N**                                                        |
| Complete MI task, 181–183                | Force immediate successful group completion and cancel the remainder.                              | **C/E**, standard completion condition need not be immediate |
| Cancel region, 183–184                   | Cancel an explicit, possibly disconnected membership set.                                          | **C/E**, BPMN boundary cancellation is scope-connected       |
| Cancel case, 184–185                     | Cancel current/future root work, children, timers, and subscriptions; terminal status is canceled. | **N/C**, Terminate End Event plus engine status              |
| Explicit successful termination, 185–186 | Cancel other work but record successful completion.                                                | **E**                                                        |
| Implicit termination, 186–187            | Complete only at true quiescence; distinguish deadlock from success.                               | **N/C**, natural completion                                  |

## Data-pattern traceability

The data IR uses stable slot and binding identities, schemas, versions, scopes,
lifetimes, mutability, transfer modes, storage bindings, ACLs, and sensitivity.
Absent data is distinct from JSON `null`, empty values, zero, and false.

| Pattern group and book pages  | Named requirements                                                                                                                                                   | BPMN and extension boundary                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visibility, 190–203           | Task, block, arbitrary scope, MI instance, case, folder, global, and environment data.                                                                               | Task/block/case are **N**; MI is **N/C**; arbitrary scope and folder are **E**; DataStore only partially covers tenant-scoped global/external state. |
| Internal interaction, 203–214 | Task-to-task, block/subprocess parameters, MI scatter/gather with value/reference and shared/isolated data, and inter-case interaction.                              | Data Associations and Call Activity mappings are **N**; dynamic aggregation, references, and case relationship navigation are **E**.                 |
| External interaction, 214–221 | Process push, process pull, environment push, and environment pull with request/reply, authentication, correlation, inbox/outbox, timeout, and late-response policy. | Message events/tasks are **N/C**; connector consistency and remote-read transactions are **I/E**.                                                    |
| Transfer, 221–229             | By value, copy-in/copy-out, unlocked reference, locked reference, input transform, and output transform.                                                             | Value/copy/transform are **N**; transferable references, leases, and fencing are **E**.                                                              |
| Data routing, 230–237         | Existence/value preconditions, existence/value postconditions, event trigger, data trigger, and XOR/OR routing.                                                      | Events and gateways are **N/C**; full missing-data and postcondition policies need extensions.                                                       |

Required core ADTs include `DataScope`, `DataSlot`, `DataBinding`,
`TransferMode`, `Condition`, `UnmetConditionPolicy`, `ExternalInteraction`, and
MI scatter/gather definitions. Every nondeterministic read, routing snapshot,
external response, directory result, and transform version that affects control
flow is committed before use.

## Resource and human-work traceability

BPMN User Task, ResourceRole, HumanPerformer, PotentialOwner,
ResourceAssignmentExpression, and `actualOwner` do not define a complete
worklist protocol. WS-HumanTask-style claim, release, delegate, suspend, skip,
query, and escalation operations are implementation contracts and must not be
presented as portable BPMN core.

| Pattern group and book pages | Named requirements                                                                                                                                                    | Boundary                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Creation, 241–255            | Direct, role, deferred, capability, history, and organization distribution; authorization; separation of duties; case handling; retain familiar; automatic execution. | Resource expressions are **N/C**; directory, policy, SoD, case ownership, and selection algorithms are **I/E**. |
| Push, 255–265                | Offer one/many, allocate one, random, round-robin, shortest queue, early, on-enablement, and late distribution.                                                       | Candidate/owner concepts are partial **N**; lifecycle, CAS, selectors, and timing are **I/E**.                  |
| Pull, 265–271                | Claim, start allocated, claim-and-start offered, system/user worklist content, and selection autonomy.                                                                | **I/E**                                                                                                         |
| Detours, 271–279             | Delegation, escalation, deallocation, stateful/stateless reallocation, suspend/resume, skip, redo, and pre-do.                                                        | Generally **I/E**; fixed loops/compensation can compose some cases.                                             |
| Auto-start, 279–284          | Start on creation/allocation, piled execution, and chained execution.                                                                                                 | Automated tasks are **N**; human auto-start and cross-item chaining are **E**.                                  |
| Visibility, 284–286          | Configurable visibility of unallocated and allocated work, separately from form data.                                                                                 | **I/E**                                                                                                         |
| Multiple resources, 286–287  | Per-resource simultaneous work and several resources collaborating on one item.                                                                                       | Capacity/team/quorum/inventory behavior is **I/E**.                                                             |

The durable work-item state machine is at least:

`Created → Offered → Allocated → Started ↔ Suspended → Completed | Failed`,
with explicit `Released`, `Delegated`, `Escalated`, `Skipped`, `Expired`, and
`Canceled` transitions where policy permits them. Every command has an
idempotency identity, CAS precondition, actor, policy decision, reason, and
immutable audit fact. Assignment and ownership never imply authorization.

## Exceptions, conversations, flexibility, change, scientific workflows, time, and activities

- Expected exception policy is a product of trigger, current work-item phase
  action, case/related-case scope action, and recovery mode
  (`None | RollbackInternal | CompensateExternal`), not a generic retry flag
  (book pp. 291–297).
- Service and correlation patterns require stable conversation/message IDs,
  versioned correlation functions, participant resolution, lineage,
  FIFO/LIFO/custom order, quorum, consumption versus utilization counts,
  closure reason, and late-message policy (pp. 298–313).
- The 34 flexibility patterns are a separate capability family spanning
  design-time alternatives, runtime deviation, underspecification, and
  momentary or permanent change. Supporting migration alone does not satisfy
  this family; selection time, affected instance/type scope, duration,
  authorization, traceability, and return-to-model behavior must be explicit
  (pp. 314–315).
- Live-run change is never implicit. A migration pins source/target artifacts
  and maps every live token, activity, timer, subscription, conversation, child,
  compensation registration, work item, and data slot or refuses the migration
  (pp. 315–321). The AP1–AP14 adaptation patterns, PP1–PP4 late-binding/modeling
  patterns, and F1–F7 change-support features require separate type-level and
  instance-level evidence.
- Declarative constraints remain executable temporal monitors; compiling them
  to procedural gateways is allowed only with trace-language equivalence
  evidence (pp. 95–97).
- Scientific workflows require data-token multiplicity, ordering, subset
  activation, rate balancing, provenance, excess policies, and partial-rerun
  lineage (pp. 321–325).
- Time semantics cover lags, durations, absolute dates, calendars, schedules,
  rate restrictions, validity periods, time-dependent routing, cycles, and
  periodicity. BPMN needs extensions for exact schedule restrictions, rate
  restrictions, and validity periods, and only partially defines several
  arbitrary-event lags and periodic cases (pp. 325–328).
- Workflow Activity Patterns WAP1–WAP7 cover approval, question-answer,
  unidirectional and bidirectional performatives, notification, informative
  requests, and decisions. They compose human work, messaging/correlation,
  wait/continuation, and routing semantics and are not satisfied by naming a
  task `approval` or `notification` (p. 329).

## Engine extension profile

The first extension profile must use a namespace and version and cover only
semantics that cannot be represented exactly in portable BPMN:

- canceling partial joins;
- open/dynamic MI groups and noncanceling partial MI joins;
- region critical sections and milestone windows;
- explicit transient versus persistent trigger retention;
- disconnected cancellation regions;
- immediate forced MI completion;
- successful terminate-and-cancel-rest;
- folder/reference/lock data;
- full human-task/worklist/assignment policy;
- schedules, validity periods, and rate restrictions;
- typed live-run migration.

A future lossless extension profile must preserve unknown BPMN extension
elements and DI on round-trip. The current named core-process/DI profile instead
rejects unknown content explicitly. An executable import rejects an unknown
semantic extension unless an exact versioned handler is registered and
authorized.

## Conformance evidence

Every supported primitive needs:

1. A small reference marking interpreter that enumerates enabled sets and
   reachable markings, not only final traces.
2. Scheduler-permutation and property tests for every concurrent arrival order.
3. Crash injection after each committed semantic fact and before/after every
   outbox publication or external acknowledgement.
4. Duplicate, stale, late, reordered, and conflicting command/event delivery.
5. Conservation assertions for tokens, gateway firings, scopes, iterations,
   MI groups, messages, locks, and resources.
6. Direct/durable semantic-history parity.
7. BPMN XML import → IR → export → reimport comparison with an explicit
   structural, visual, and semantic loss report.
8. Normative XSD fixtures plus official/non-normative OMG example documents.
9. Soundness fixtures for option to complete, proper completion, dead
   activities, deadlock, livelock, orphan tokens, and unsafe token growth.
10. Data isolation, tenant isolation, authorization-before-query, revocation,
    SoD, lock fencing, and sensitive-field redaction tests.
11. Migration cuts before, inside, and after every changed region, including
    running work, queued messages, timers, calls, and compensation.
12. A generated coverage manifest linking each supported normative BPMN
    requirement and Workflow Pattern to implementation code and tests.

Release documentation must publish the generated manifest and all known losses.
Passing package unit tests without that manifest is not evidence of BPMN
conformance.
