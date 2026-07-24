# `@effect/workflow-builder`

`@effect/workflow-builder` is a UI-agnostic workflow plan compiler and execution
semantic layer for Effect applications.

The package separates four concerns deliberately:

- applications declare versioned node kinds, typed ports, schemas, and link
  policies;
- user interfaces persist a portable, versioned JSON plan;
- the compiler validates the complete plan and produces an executable graph;
- applications choose an explicit execution backend, including whether durable
  Effect Workflow integration is enabled.

Protocol version `3` is being shaped around a thin native Effect Workflow
adapter. Workflow Builder owns the portable DAG/BPMN meaning, deterministic
decisions, exact artifact pins, and business/audit semantics. The injected
`WorkflowEngine` owns replay, persistence, activities, deferred waits, clocks,
operational child propagation, interruption, queues, sharding, and failover.
This package will not implement `WorkflowEngine.Encoded` or clone
`ClusterWorkflowEngine`; applications select the memory layer for tests or a
durable engine layer for deployment.

Today the package provides:

- strict Effect Schema wire models for plans and semantic history;
- versioned typed nodes, ports, handler registries, and effectful link policies;
- aggregate compiler diagnostics, resource admission, cycle rejection, and a
  deterministic dependency schedule;
- canonical SHA-256 compiled-plan fingerprints, plus compiler-semantic-version
  `2` documents that remove presentation metadata, normalize unordered
  collections by code-unit order, retain workflow-boundary contracts and
  resolved endpoints, and commit the canonical static-DAG schedule;
- a direct Effect interpreter with fresh configuration decoding, detached frozen
  JSON routing, typed failures, hostile-container validation, bounded
  concurrency, dependency readiness, and structured interruption;
- a pure immutable history fold for the initial run/activity event vocabulary;
- a frozen sibling execution-protocol version `2` vocabulary with tenant-bound
  attempt/retry/timer/signal identities, immutable retry and timeout policy,
  bounded canonical UTC-millisecond deadline materialization, deterministic
  protocol-failure attribution, and fail-closed replay of history-order races
  without widening version `1`;
- a prepared protocol-v2 decision layer and one process-local atomic execution
  authority for exact durable starts, static-DAG scheduling, retries, activity
  timeouts, due timer firing, cancellation, dispatch/wake indexes, idempotent
  receipts, replay validation, exact decision-batch admission, and plan-bound
  schema validation of worker completions;
- a strict BPMN 2.0.2 semantic IR for processes, collaborations, black-box
  participants, message flows, hierarchical scopes, activities, gateways,
  sequence flows, standard loops, multi-instance activities, boundary events,
  event subprocesses, and reusable event definitions, with aggregate
  cross-reference and context validation;
- a durable BPMN execution-state foundation with token positions, scope and
  invocation identity, gateway/loop/multi-instance/call frames, subscriptions,
  timers, work items, compensation registrations, and cancellation regions,
  whose state version `5` carries a version `3` executable fingerprint
  reference and exact protocol-v3 task-resolution records;
- a normalized BPMN data/IO/interface slice and BPMNDI/DI/DC representation
  with aggregate reference, geometry, and semantic-kind validation;
- a resource-bounded namespace-aware XML infoset plus strict named profile
  `bpmn-2.0.2-core-process-di-v4` for fail-closed import, canonical export, and
  normalized round-trip of its explicitly bounded process/control-flow and DI
  surface, including source-level `callActivity` references as
  namespace-expanded QNames, Standard Loop characteristics, and represented
  Multi-Instance fields on generic Tasks. Multi-Instance cardinality,
  collection input/output references, sequential/parallel mode,
  `completionCondition`, behavior, and One/None event references round-trip;
  this interchange capability is wider than executable admission. The Standard
  Loop condition must be a formal expression with an exact language-version
  binding, `testBefore` selects pre-test or post-test behavior, and a positive
  `loopMaximum` is mandatory in this named profile;
- a bounded replayable BPMN token kernel for none start/end events, generic
  tasks, bounded Standard Loop Tasks, ordinary subprocesses,
  conditional/default flows, exclusive/parallel gateways, and
  `FixedMultiInstance/1`. That fixed Multi-Instance profile is Task-only: it
  evaluates one version-bound cardinality expression once at activation,
  freezes a closed member set under `maxMultiInstanceCardinality`, assigns
  stable `item:<index>` identities, and runs members sequentially or in
  parallel with BPMN behavior All. Ordered durable member state is independent
  of parallel completion order. At each decision boundary, generated instances
  equal active plus completed plus terminated instances; members not yet
  generated remain in the sequential pending suffix. These exact counters are
  supplied to an optional `completionCondition` after each committed member
  completion; its first `true` result terminates the remainder before emitting
  one continuation. Cardinality zero completes immediately. Boundary Error and
  terminal failure paths cancel remaining members, stale `completeTask`
  commands are fenced and idempotent, every boundary is journaled and replayed,
  and the native Effect Workflow task bridge derives a distinct exact
  occurrence from group activation and member index. Collection sources,
  behavior One/None/Complex, output aggregation, Multi-Instance SubProcesses
  and CallActivities, and open or draining groups are rejected by executable
  admission. Machine-readable coverage gates still declare no formal BPMN
  conformance claim;
- an explicitly bounded protocol-v3 Task/Boundary Error execution slice.
  Immutable task bindings and exact failure-identity-to-Error mappings are part
  of the executable fingerprint. `resolveTask` routes exact success normally,
  catches a mapped business failure through at most one matching interrupting
  Boundary Error, and fails the root execution for unmapped or uncaught
  failures. A native Effect Workflow bridge checks the exact compiled task
  binding before dispatch, executes the prepared retry invocation once, and
  returns a strict portable `resolveTask` command plus the raw retry outcome.
  Attempt and schedule-to-close timeouts, defects, interruption, and adapter
  failures remain outside BPMN Error routing. Durable resolutions are
  idempotent and causally replayed. `BpmnExecutable.compileXml` accepts task
  bindings explicitly as external compile options and commits them to the
  executable fingerprint; they are not inferred from BPMN XML. This does not
  yet cover the complete BPMN Activity lifecycle, parent-scope Error
  propagation, timers, BPMN Cancel, non-interrupting boundaries, or event
  subprocesses;
- a strict BPMN executable facade proving the named XML profile can be imported,
  compiled directly to that token kernel, executed through conditional/default
  parallel/subprocess, bounded Standard Loop, and fixed Multi-Instance paths,
  replayed, canonically exported, re-imported, recompiled, and replayed to the
  same marking without DAG lowering;
- Effectful BPMN kernel preparation that SHA-256 fingerprints the complete
  normalized semantic model, selected root, kernel semantics, limits, mapping
  profile, and exact evaluator-build manifest; state and journal replay reject
  cross-model or cross-profile substitution before interpreting a marking;
- strict build-pinned BPMN expression evaluator definitions and an Effect
  registry that permits old and new builds to coexist but performs no
  language-only, semver, or `latest` fallback; an Effect-native driver resolves
  and evaluates conditions asynchronously with fixed inputs/time, exact
  operation-local decision identities, timeouts, step limits, interruption
  preservation, and no partial transition batch; every committed condition
  event records its evaluator binding and bounded usage evidence;
- a content-addressed sealed BPMN journal artifact that verifies its complete
  causal history against an independently anchorable history digest before
  exact-kernel replay;
- an executable process-local version `2` signal authority with exact runtime
  codec and policy pins, authenticated same-principal idempotency, bounded blob
  verification, atomic accepted-event/expiry-timer commits, receipt recovery,
  and bounded dead-letter overflow;
- independent protocol-v3 wire primitives and domain-separated artifact,
  compiled-plan, boundary-contract, executable-build, and encoded-schema
  digests, together with strict inline-or-immutable-blob payload references;
- a protocol-v3 static-DAG artifact contract with exact compiler, definition,
  handler, codec, schema, boundary, retry-classifier, policy, and node-binding
  manifests; canonical relationship validation; fixed-order digest
  verification; process-local verification provenance; read-only store
  contracts; and artifact-derived child targets;
- a first thin native Effect Workflow host for already-admitted protocol-v3
  runs, with artifact-versioned native tags, strict detached
  request/success/failure envelopes, process-local prepared-binding provenance,
  exact verified-artifact provenance retained inside each semantic execution,
  collision-free tenant/run idempotency, handler registration, and lifecycle
  delegation to an injected `WorkflowEngine` without implementing its backend
  SPI;
- forked native Effect Workflow deferred-handshake primitives:
  token-addressed polling, canonical first-wins resolution that preserves a
  typed failure as data, and idempotent absolute scheduled resolution. Memory
  and persisted cluster implementations share the contract, including
  result-before-deadline, deadline-before-result, and duplicate-schedule races.
  These are backend coordination primitives, not Builder authorization,
  semantic worker leases, heartbeats, or completion admission. A cluster
  client using a custom shard group must have the workflow definition
  registered so its annotation can be recovered from the otherwise opaque
  deferred token. The token is an address, not an authenticated capability;
- a bounded protocol-v3 native-operation naming profile that maps exact dynamic
  occurrence, operation, and timer/deferred generation coordinates to
  replay-stable names, while semantic activity attempts use Effect's native
  `Activity.CurrentAttempt`; activity persistence, deferred completion, durable
  clocks, and nested execution remain Effect Workflow responsibilities.
  Memory-backed integration tests prove native activity replay, deferred
  suspension/resume, forced-durable business timers, and parent-child
  suspension;
- content-addressed protocol-v3 dynamic occurrences and activity/timer/deferred
  operation descriptors that commit tenant, run, artifact, node, nested scope
  activations, attempt/generation, encoded input, duration, owner, and
  result-schema meaning; activities additionally commit a closed
  node-handler/classifier/jitter/time-observation purpose and coherent exact
  artifact-codec, node-output-aggregate, or versioned built-in success/error
  contracts, while deferred waits pin distinct success/error codecs;
  process-local provenance and digest re-verification reject structural copies
  and persisted substitution;
- an exact process-local protocol-v3 executable registry that resolves an
  entire verified artifact atomically against build-attested node handlers,
  codecs, schemas, and retry classifiers, retains each executable's captured
  Effect context, and admits neither `latest` lookup nor version/build
  fallback;
- an initial semantic-to-native mapper that admits one-shot static-DAG
  occurrences only from an exact semantic execution, records each operation
  digest through a disjoint native guard activity before execution, rejects
  same-coordinate descriptor drift during replay, maps semantic attempts to
  native `Activity.CurrentAttempt`, requires an explicit infrastructure
  interruption policy, and forces every positive business timer through
  `DurableClock` with a zero in-memory threshold;
- authenticated ordered `FirstSettled` and `FirstSuccess` semantic races over
  exact node activities, durable timers, and pinned deferred generations.
  Race membership and result contracts are derived rather than caller-supplied;
  native replay preserves the identified winner, typed failures, and defects.
  `InterruptWaiters` cancels only the waiting fibers and is not a promise to
  roll back an external side effect already started by a losing activity;
- a protocol-v3 activity policy with exact classifier build pins, explicit
  non-retryable identities, an explicit policy-pinned mapping from encoded
  business failures to tag/code identity, bounded fixed/exponential backoff,
  deterministic no-jitter or replay-recorded jitter ranges, attempt/elapsed
  budgets, and a closed persistable application-failure/attempt-timeout
  classifier input plus an infallible retryable/non-retryable result contract,
  and independent schedule-to-start/start-to-close/schedule-to-close timeout
  dimensions;
- a managed protocol-v3 retry facade over native Effect Workflow primitives.
  Each semantic attempt is one exact build-pinned native activity whose success
  channel persists a closed success, application-failure, or authorized
  attempt-timeout outcome; only the user handler's typed failure is classified.
  The facade applies explicit
  non-retryable identities, the exact classifier, attempt and elapsed admission
  budgets, replay-recorded internal jitter, and native durable-clock backoff,
  and returns closed `NonRetryable` or `Exhausted` terminal explanations.
  An exact content-addressed schedule-to-close controller arms one stable
  injected-engine clock and obtains its durable acknowledgement before the
  initial time observation or any node attempt. Completion and clock contenders
  publish success-only envelopes to one native durable deferred; its backend
  first-wins result covers encoded success, terminal business failure, timeout,
  and non-interrupt defect. Native defects retain their full `Cause`; they are
  not encoded as business failure or timeout. Attempts and final publication
  are clock-fenced, typed winner coordinates and deterministic policy facts are
  revalidated, and loser interruption is fire-and-forget rather than joined.
  The timeout fences semantic completion but cannot promise rollback of an
  external side effect already dispatched. `executeDetailed` exposes that same
  closed durable outcome without decoding or rerunning the handler, allowing
  trusted adapters to retain attempt and activity coordinates.
  Schedule-to-start first persists one canonical `ScheduleToStartArmed`
  acknowledgement containing the activity/timer digests, attempt, `armedAt`,
  duration, and absolute deadline. Only that canonical acknowledgement is used
  to schedule the idempotent native clock and dispatch the activity, and replay
  reuses it instead of observing a new budget origin. The start gate runs inside
  the native Activity RPC immediately before handler preparation, so a
  canonical timeout winner prevents user code from starting. Timeout
  authorization is a lazy `Effect` evaluated only when the gate actually
  proposes a timeout. It derives the exact schedule-to-start expectation from
  the canonical arm acknowledgement, or the exact start-to-close expectation
  from canonical `Started`, then compares activity, attempt, timer, timeout kind,
  duration, and deadline. Thus the authorization is dynamic but cannot admit a
  timeout without its canonical persisted basis. This boundary means “entered
  the Activity RPC”, not “acquired a future authenticated distributed-queue
  lease”. A timed attempt therefore uses a start and terminal gate, plus the arm
  gate when schedule-to-start is configured.
  Start-to-close commits `startedAt` and its exact absolute deadline in the
  canonical `Started` acknowledgement, then idempotently schedules the terminal
  deferred; redelivery cannot reset that deadline. Native Effect Activity
  persistence records one `Completed` receipt containing the complete encoded
  `Exit` and a backend completion time observed after activity finalization.
  Replay returns that same receipt rather than reading the clock again. The
  terminal protocol uses its native `completedAt` for success, typed error, and
  defect alike, and validates the secondary timestamp carried by version `2`
  `Succeeded` and `ApplicationFailed` outcomes. A terminal recorded at or after
  the canonical deadline therefore becomes `AttemptTimedOut` even when timer
  delivery is late; a pre-deadline defect retains its non-interrupt native
  `Cause`. Pure interruption does not publish a terminal and interruption
  reasons are removed from a mixed terminal cause. Defect payloads may be
  normalized by the native `Schema.Defect` wire codec, so cross-process replay
  preserves the Cause model rather than JavaScript object identity.
  `AttemptTimedOut` is classified as an attempt-timeout cause but remains
  distinct from application failure and is never projected through BPMN
  Boundary Error as a business error. The outer schedule-to-close controller
  still has no equivalent absolute completion receipt for the whole retry loop;
  deterministic ordering of a post-budget defect against a late-delivered
  schedule-to-close timer remains a separate conformance obligation. A losing
  native scheduled resolution is not cancelled: first-wins makes its eventual
  delivery semantically inert, but it still consumes timer/backend capacity
  until its deadline. These handshakes do not provide an authenticated worker
  lease, heartbeat expiry, queue-acquisition fencing, cross-process
  cancellation, or proof that already-started external work stopped;
  `maximumElapsed` remains an admission budget and does not interrupt an
  attempt already running;
- protocol-v3 child-workflow collision-free identities, exact
  artifact/contract/deployment/build and bounded lineage pins,
  inline-or-blob inputs/results, a closed command/event vocabulary, and a pure
  immutable relation reducer that enforces start/cancel/terminal races,
  cause-specific parent-close policy, cancellation fencing, output-contract
  identity, replay order, and `CancelAndWait` barriers;
- an atomic process-local history store with optimistic sequencing, batch-level
  exact retry recognition, hostile-input validation, and immutable snapshots;
- a strict initial command vocabulary plus a pure prepared-plan decision layer
  for deterministic dependency-ready scheduling, routing, cancellation,
  failure, and terminal completion;
- effectful command validation through workflow-output sink schemas and
  provenance-checked preparation of atomic event/dispatch batches with exact
  queue and deployment targets;
- safe command-to-event, run-start, and single-activity boundaries with exact
  identity validation, fresh codecs, detached frozen JSON, and explicit
  interruption behavior;
- a process-local semantic runner that commits schedules before dispatch,
  re-decides stale command batches, reconciles result races, bounds concurrency,
  and resumes committed in-memory histories;
- exact durable-start admission with tenant-scoped immutable plan artifacts,
  execution-protocol, workflow, and handler deployment pins, content
  verification, restart recovery, and fail-closed recompilation;
- a process-local transactional reference authority for semantic history,
  activity outbox state, fair bounded runnable-run claims, coordinator leases,
  fenced decisions, relay leases, every issued worker delivery generation,
  cancellation delivery claims, and storage-atomic result commits;
- a one-shot durable coordinator driver that recovers exact pinned artifacts,
  decides from authoritative history, and either commits through the current
  run lease or acknowledges an unchanged idle sequence;
- pointer-and-digest broker envelopes, an at-least-once outbox relay, strict
  consumer ingress, stable business idempotency across redelivery, and separate
  operational delivery epochs; and
- deployment-aware executable handler registries and a durable worker boundary
  that verifies tenant, run, route, definition, artifact, and exact handler
  build before user code runs; and
- exact-generation activity-cancellation records with bounded claim/lease/ack
  delivery, plus a process-local worker registry that interrupts the matching
  Effect fiber, waits for finalizers, and preserves a tombstone when
  cancellation wins the acquire/register race;
- an explicit broker settlement boundary that acknowledges only durable
  completion or authoritative suppression, delays retryable ownership/storage
  failures, and dead-letters malformed or pin-conflicting deliveries.

The direct interpreter, local semantic runner, memory history stores, and both
memory execution authorities are intentionally **not a persistent backend**.
The local runner's dispatch is process-local and non-transactional, while the
reference authorities lose all history, artifacts, leases, receipts, timers,
and outbox state on process exit. They specify atomic and race semantics but
are not a database or broker, and they are not a design request to reimplement
native Effect Workflow against a database. Protocol-v2 static-DAG execution is
runnable through its process-local authority only as the current reference
path. Protocol-v3 production durability will instead require the thin native
adapter, an application-provided durable `WorkflowEngine` layer, exact
artifact-versioned native handlers, authorized deferred completion, stable
dynamic activity/child identities, forced-durable business timers, and
cross-process semantic conformance tests.

The current attempt-timeout contract tests exercise the native memory engine and
the cluster implementation over its in-memory cluster driver. They prove the
first-wins protocol and adapter wiring in those fixtures; they do not prove
survival of a process or machine crash, empty-cache recovery, multi-worker
failover, or a production storage deployment.

The forked native `PersistedQueue` Redis and SQL stores now fence every scoped
take with a fresh acquisition UUID. Lock refresh, completion, requeue,
interruption release, and failed-item settlement are conditional on that exact
acquisition, so a finalizer from an expired delivery cannot mutate its
replacement. This is transport ownership fencing only; it is not yet the
protocol-v3 semantic start permit, heartbeat, cancellation, or completion
authority. The implemented schedule-to-start clock currently ends at entry into
the native Activity RPC; it does not claim to measure acquisition of this or any
future authenticated distributed queue.

The BPMN model, named XML/DI mapping slice, durable marking, and bounded token
kernel are likewise not a BPMN conformance claim. Mapping outside
`bpmn-2.0.2-core-process-di-v4`, normative XSD validation, complete Common
Executable and Activity lifecycle semantics, a complete atomic normative
catalogue, persistent storage, authenticated history anchoring, official
fixtures, and published conformance evidence remain required. The package
provides no built-in FEEL, XPath, or other expression implementation; an
application must install an exact build-pinned evaluator, and strong CPU/heap
isolation requires a worker, process, or sandbox adapter. BPMN 2.0.2 itself
allows `loopMaximum` to be omitted and `loopCondition` to use the more
permissive `tExpression` form. Profile `v4` deliberately fails closed unless a
generic Task has a positive maximum and a version-bound formal condition; it
does not claim general Standard Loop support. Its separate
`FixedMultiInstance/1` execution intersection is deliberately limited to a
cardinality-based generic Task with behavior All and an optional formal
completion condition. XML v4 may round-trip collection and One/None/Complex
metadata that the kernel rejects. Collection data mapping and externalized
item manifests, output collection and input-order aggregation, Multi-Instance
SubProcesses and CallActivities, progressive One/None/Complex behavior events,
open/dynamic fan-out (WCP15), draining static or dynamic partial joins
(WCP34/WCP36), native collective cancellation/audit, normative XSD evidence,
and any formal BPMN conformance claim remain unimplemented. Open creation and
draining require a distinct `OpenForEachGroup/1` semantic profile rather than a
silent widening of the frozen group.

The fixed profile follows durable-engine lessons shared by Temporal, AWS Step
Functions, Argo, and similar systems: freeze the logical member set at
activation; keep logical member identity distinct from retry or delivery
attempts; bound semantic cardinality separately from operational worker
concurrency; require future aggregation to preserve input order even when
parallel completions arrive out of order; and segment or roll over histories
before large fan-outs become unbounded. Native Effect Workflow already supplies
persistence, replay, child execution, activities, deferreds, clocks, and
backend interruption. Workflow Builder records portable BPMN group semantics
and exact native occurrences; it does not reimplement those backend
capabilities.

A BPMN `callActivity` can be represented and round-tripped. Its protocol-v3
relation and replay semantics are modeled, but executable admission still
rejects it until source QNames resolve through a trusted
compiler-semantic-version-2 artifact family and a single transactional
parent/child authority is installed.
The compiler-v2 document, digest primitives, and static-DAG artifact verifier
establish exact content pins but do not yet constitute that execution
authority. Trusted executable-catalog attestation, persistent
content-addressed storage, atomic run binding, and a transactional parent/child
authority are still required.

See the runnable [typed DAG example](./examples/basic.ts),
[BPMN XML execution example](./examples/bpmn-executable.ts), and detailed
[architecture and prior-art record](./DESIGN.md). The
[standards and BPMN traceability baseline](./STANDARDS.md) records normative
claim rules, Workflow Patterns coverage, extension boundaries, and required
conformance evidence. The architecture record compares Temporal,
Restate, DBOS, Argo, Airflow, Prefect, Dagster, Inngest, n8n, Node-RED, Kestra,
Windmill, AWS Step Functions, Camunda/Zeebe, Conductor, Azure Durable Task,
Hatchet, Trigger.dev, and Netflix Maestro, and records which ideas this package
adopts or rejects.

The package is under active development alongside Effect 4. APIs beyond the
implemented foundation remain intentionally unclaimed.
