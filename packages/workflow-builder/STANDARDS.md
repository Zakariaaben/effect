# Workflow standards and conformance plan

Status: family-level Workflow Patterns requirements plus atomic evidence for a
small control subset; semantic, data, DI, durable-state, bounded XML-infoset,
strict named core-process/DI XML mapping, and executable token-kernel
foundations; complete atomic pattern traceability, XML/XSD coverage, execution
semantics, and normative conformance suites pending\
Last reviewed: 2026-07-23

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
  timers, work items, compensation registrations, and cancellation regions;
- a replayable bounded token kernel for an explicitly admitted subset of none
  start/end events, tasks, embedded subprocesses, conditional/default sequence
  flows, and exclusive/parallel gateways; and
- a resource-bounded namespace-aware XML 1.0 infoset parser, semantic
  validator, and serializer;
- strict profile `bpmn-2.0.2-core-process-di-v2`, which fails closed while
  importing, validating, canonically exporting, and normalized-round-tripping
  definitions metadata, ordinary processes and recursive subprocesses, generic
  tasks, source-level call activities with namespace-expanded callable-element
  QNames, none start/end events, exclusive/parallel gateways, sequence flows,
  conditions, defaults, explicit expression-language version bindings, and the
  complete current normalized DI slice; and
- a strict executable-admission facade that composes that named XML profile
  with the bounded token kernel without lowering through the version `1` DAG,
  and proves import, conditional/default routing, parallel split/join,
  subprocess execution, journal replay, canonical export, re-import,
  recompilation, and same-journal replay;
- an Effectful executable-preparation boundary whose domain-separated
  SHA-256 fingerprint commits to the normalized semantic model, root process,
  kernel semantic version, limits, named profile, and exact evaluator-build
  manifest; version `2` markings and versioned journal headers fail closed on a
  model/profile mismatch;
- a strict Effect evaluator registry with full language/version/build/limit
  tuple resolution and no compatibility or latest fallback, plus exact
  evaluator-binding and bounded usage evidence in condition journal events; an
  Effect driver keeps the pure kernel atomic while resolving asynchronous
  evaluators under fixed operation inputs/time, timeout and step limits, and
  interruption-preserving failure handling;
- a sealed journal artifact whose complete causal payload has an independently
  anchorable history digest; and
- a separate protocol-version `3` child-target, parent-link, lineage,
  close-policy, relation-identity, and call-state contract. It deliberately
  models durable parent/child pins without yet claiming child execution; and
- machine-readable requirement/coverage schemas that record the named mapping
  slice separately while declaring no BPMN conformance claim.

Not yet implemented and therefore not claimed:

- semantic and DI XML mapping outside the strict named slice, lossless unknown
  extension preservation, and import/export validation against the normative
  XSDs;
- the complete BPMN Common Executable metamodel, including its full data,
  resource, correlation, interface/operation, lane, artifact, and visual
  interchange surfaces;
- token-transition and Activity lifecycle semantics beyond the explicitly
  bounded kernel subset;
- executable call activities, immutable callable-element resolution,
  parent/child run linkage, cancellation propagation, and lineage/depth
  enforcement;
- a persistent BPMN execution store, externally authenticated history anchors,
  migration tooling for pre-fingerprint states/journals, and isolated evaluator
  adapters or any bundled FEEL/XPath implementation;
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
also records executable evidence for only four atomic control patterns:
Sequence, Parallel Split, Synchronization, and Exclusive Choice.

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
| Structured loop, 149–150               | Distinguish while, repeat-until, and combined pre/post tests; persist iteration identity.          | **N**, loop characteristics     |
| Recursion, 150–152                     | Pinned synchronous call frames, parent wait, base case, depth limit, and cancellation propagation. | **N**, recursive Call Activity  |
| MI without synchronization, 153–155    | Detached instances with explicit cardinality-evaluation time and parent-close behavior.            | **C**, MI behavior without join |
| MI with design-time knowledge, 155–157 | Fixed sequential/parallel cardinality; wait for all.                                               | **N**                           |
| MI with runtime knowledge, 158–159     | Snapshot cardinality or collection once at activation; later source mutation cannot add instances. | **N**                           |
| MI without a priori knowledge, 159–160 | Open group supporting durable spawn and close, then wait for outstanding instances.                | **E**                           |
| Static partial MI join, 160–162        | Emit at threshold while the remainder continues; reset only after full drain.                      | **E**                           |
| Canceling partial MI join, 162–164     | Emit at threshold and cancel the remainder under an explicit race table.                           | **N/C**, `completionCondition`  |
| Dynamic partial MI join, 164–165       | Open group; close creation at threshold; existing instances continue and drain.                    | **E**                           |

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
