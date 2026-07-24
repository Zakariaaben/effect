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
  whose state version `9` carries a version `7` executable fingerprint
  reference, exact protocol-v3 task and CallActivity records, atomic catch-wait
  groups, a global Message-delivery ledger, and durable `failing`/`cancelling`
  parent-close barriers;
- a normalized BPMN data/IO/interface slice and BPMNDI/DI/DC representation
  with aggregate reference, geometry, and semantic-kind validation;
- a resource-bounded namespace-aware XML infoset plus strict named profile
  `bpmn-2.0.2-core-process-di-v6` for fail-closed import, canonical export, and
  normalized round-trip of its explicitly bounded process/control-flow and DI
  surface, including source-level `callActivity` references as
  namespace-expanded QNames, Standard Loop characteristics, and represented
  Multi-Instance fields on generic Tasks. Multi-Instance cardinality,
  collection input/output references, sequential/parallel mode,
  scalar `inputDataItem`/`outputDataItem` declarations with namespace-expanded
  `itemSubjectRef` QNames and xsd:string names (including `name=""`),
  `completionCondition`, behavior, and One/None event references round-trip in
  BPMN XSD order; unsupported child content still fails closed. This
  interchange capability is wider than executable admission. The Standard Loop
  condition must be a formal expression with an exact language-version binding,
  `testBefore` selects pre-test or post-test behavior, and a positive
  `loopMaximum` is mandatory in this named profile. Version `6` additionally
  maps normal-flow Intermediate Catch Events with exactly one Message or Timer
  definition and exclusive, non-instantiating Event-Based Gateways whose direct
  branches are those catch events. Message `operationRef`, Timer `timeCycle`,
  conditional/multiple/parallel-multiple catch semantics, and other Event
  definitions fail closed;
- a bounded replayable BPMN token kernel for none start/end events, generic
  tasks, bounded Standard Loop Tasks, ordinary subprocesses,
  conditional/default flows, exclusive/parallel gateways, and
  two generic-Task-only closed-group profiles. `FixedMultiInstance/1` evaluates
  one version-bound cardinality expression once at activation.
  `CollectionMultiInstance/1` instead evaluates one exact, externally compiled
  `loopDataInputRef` binding once at activation and freezes its bounded
  canonical JSON array. Array indices define stable `item:<index>` identities;
  source order and duplicate values are preserved, and later source mutation
  cannot add or replace a member. Both profiles run sequentially or in parallel
  with BPMN behavior All. Ordered durable member state is independent of
  parallel completion order. At each decision boundary, generated instances
  equal active plus completed plus terminated instances; members not yet
  generated remain in the sequential pending suffix. A scalar
  `inputDataItem` explicitly opts a collection Task into per-member item
  mapping; when it is absent, the engine does not implicitly inject the item
  into the handler input. Complete output aggregation is separately opt-in:
  `loopDataOutputRef` plus one scalar `outputDataItem`, a collection-valued Task
  DataOutput declaration, and a protocol-v3 Task binding collect every
  codec-validated member output in original input-index order. An empty input
  creates no work and, when aggregation is configured, produces `[]`.
  Aggregation with `completionCondition` is rejected until an explicit partial
  result policy exists. Without aggregation, exact counters may be supplied to
  an optional `completionCondition` after each committed member completion; its
  first `true` result terminates any already generated active remainder and
  prevents a sequential planned suffix from being generated before emitting
  one continuation. That suffix is not counted as generated or terminated.
  Boundary Error and terminal failure paths cancel remaining generated
  members, stale `completeTask` commands are fenced and idempotent, and every
  boundary is journaled and replayed. The optional native Effect Workflow task
  bridge derives a distinct occurrence from group activation and member index;
  it is a selectable backend integration, not part of the portable collection
  semantics. Behavior One/None/Complex, Multi-Instance SubProcesses and
  CallActivities, open WCP15 groups, and draining WCP34/WCP36 groups remain
  rejected. Machine-readable coverage gates still declare no formal BPMN
  conformance claim;
- portable executable profile `CatchEventChoice/1` for a deliberately bounded
  Message/Timer Intermediate Catch Event slice. A standalone catch or one
  exclusive, non-instantiating Event-Based Gateway atomically opens exact
  Message and Timer arms. Message bindings commit an ordered, non-empty exact
  correlation key expression, payload codec contract, and authorization-policy
  build. The atomic delivery transition is the `acceptedAt` authority: the
  receipt value must equal `services.now` while the kernel validates the exact
  active arm, correlation, policy pin, payload bound, and winner. Sender time
  is never authoritative. An exact redelivery of an already committed receipt
  is recognized before this clock check and records only replay audit. Messages are
  transient-active-only: no pre-wait inbox or early-message buffering is
  implied. A Message wins only when its accepted instant is before every
  eligible Timer deadline; a Timer wins equality, and equal Timer deadlines are
  ordered by immutable branch ordinal. Winner selection, continuation, and
  loser-arm/Timer cancellation commit in one transition. The execution-global
  `deliveryId` ledger consumes both Message winners and Messages preempted by a
  Timer, so an accepted delivery cannot be reused against another activation.
  Version `7` causal journals replay the selected winner, evaluated correlation,
  materialized deadline, cancellations, fences, and ledger without rereading a
  clock, reevaluating an expression, or rerunning the race.
  Fingerprinted kernel budgets bound the evaluated Timer lexical value, the
  canonical execution-state snapshot, and both event count and canonical bytes
  of one replay journal. Fixed parser/kernel ceilings remain 4 KiB per Timer
  lexical, 8 MiB per state snapshot, and 65,536 events/16 MiB per journal;
  profiles may only lower them. Longer histories require an explicit segmented
  history/checkpoint authority rather than unbounded arrays. Signal,
  Conditional, Multiple, and Parallel Multiple Events; Timer `timeCycle`;
  Start, Boundary, throwing, Receive Task, and event-subprocess catches; and
  instantiating or Parallel Event-Based Gateways remain excluded;
- an optional `EffectWorkflowBpmnEventV3` adapter that creates one typed native
  deferred per catch wait group, including Message-only waits, and uses
  absolute idempotent `DurableClock` schedules for Timer arms. Timer-due and
  post-commit state-change values are typed first-wins wake hints only; recovery
  reloads portable state and the kernel remains the sole race authority. The
  adapter delegates to the injected native backend and implements no backend
  SPI, persistence store, outbox, inbox, correlation service, cancellation
  authority, transport authentication, or alternate replay engine. Its explicit
  native `workflowName`/`executionId` address is caller-owned and must be
  persisted by the host beside its execution binding; the derived Effect token
  is an address, not a credential. After a crash the host can reconstruct a
  post-commit notification from closed portable state, but must provide its own
  transactional outbox or equivalent delivery guarantee. Memory-backed tests
  are integration evidence, not production durability; persistent/cluster
  conformance, crash/restart, and failover evidence remain required;
- an optional `EffectWorkflowBpmnCallActivityV3` post-commit adapter for
  protocol-v3 child commands. It validates every command against its complete
  pinned relation, resolves only an exact prepared native artifact binding,
  and uses a caller-provided durable relation authority to fence the
  schedule-versus-close race before submitting native work. A two-stage
  schedule claim prevents target lookup from starting work after a close has
  already won; native start is addressed by the canonical tenant/child-run
  identity, so redelivery after a crash before locator recording is
  idempotent. Cancellation interrupts only the exact durably selected locator,
  while `Abandon` performs no binding lookup or native operation. All returned
  receipts explicitly state that no semantic child event was produced:
  `start` and `interrupt` acknowledgements are never relabelled as accepted
  start, cancellation, or termination. The host still supplies the
  transactional relation authority, outbox relay, cooperating child lifecycle
  reporter, authenticated ingress, and persistent/cluster conformance evidence;
- a strict `ChildWorkflowLifecycleV3` preparation boundary for authoritative
  child-start, cancellation-acceptance, success, failure, and cancellation
  facts. Source order and occurrence time remain in the immutable source fact,
  while the serialized parent authority supplies the monotonic projection time
  and compare-and-set relation sequence. Canonical event identity, causation,
  relation coordinates, contracts, and lifecycle are proved through the
  protocol-v3 reducer before an opaque preparation capability is returned. The
  native CallActivity adapter additionally checks the exact prepared artifact
  binding and deterministic child locator before returning an
  `ApplyChildEvent` command. Neither module persists or applies that command:
  source deduplication, first-write timestamp allocation, transactional inbox/
  outbox, authenticated delivery, and replay/conflict receipts remain host
  authority responsibilities;
- an optional `EffectWorkflowChildLifecycleV3` native child-host decorator.
  Stable `started` and shared `terminal` Activities submit strict reports to an
  injected `ChildLifecycleSourceOutbox`. The accepted-start receipt commits
  before the semantic handler is constructed; success is output-contract
  validated and typed failure is closed to the native `RunFailure` vocabulary
  before the terminal Activity. Each receipt repeats the exact report, first
  source sequence/time allocation, canonical fact, and outbox entry identity;
  native replay revalidates that complete receipt and detects success/failure
  or payload drift. Persisted publication errors repeat the complete report as
  a versioned portable envelope and are checked for the same replay drift
  before their typed error is restored. A caller policy is filtered to retry
  only interruption causes; typed outbox failures are never retried
  implicitly. The outbox must first-write the source fact and egress entry
  atomically and return exactly the first receipt after a crash. The decorator
  owns no store, relay, poller, clock, scheduler, application outbox retry
  policy, or alternate engine, and never infers cancellation from interruption,
  polling, suspension, defects, or workflow absence;
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
  propagation, Boundary Timers, BPMN Cancel, non-interrupting boundaries, or
  event subprocesses;
- `OperationalInstanceWithdrawal/1`, an external control-plane extension whose
  atomic portable transition records idempotent attribution, fences scheduling,
  closes supported owned descendants, emits no normal continuation, and fences
  late Task outcomes. Its optional `EffectWorkflowBpmnOperationalV3` adapter
  authenticates committed state before either notifying a cancelled local wait
  or safely interrupting an exact whole native host. This is partial logical
  WCP20 behavior, never BPMN Cancel, Terminate, compensation, rollback, WCP19,
  or a physical-stop guarantee;
- a strict BPMN executable facade that imports the named XML profile and
  compiles it directly to the token kernel without DAG lowering. Its
  end-to-end scenarios execute conditional/default parallel/subprocess,
  bounded Standard Loop, fixed Multi-Instance, and one bounded Message/Timer
  gateway equality race through journal replay, canonical export, re-import,
  recompilation, and same-state replay. Separate kernel scenarios execute
  portable CallActivity opening, child success, parent close, delayed child
  facts, and exact replay. Standalone Message/Timer catch shapes have compile
  and canonical round-trip evidence; this does not claim each shape has a
  separate end-to-end scenario;
- Effectful BPMN kernel preparation that SHA-256 fingerprints the complete
  normalized semantic model, selected root, kernel semantics, limits, mapping
  profile, exact evaluator-build manifest, and compiled CallActivity bindings;
  kernel semantic version `8`, state version `9`, executable fingerprint
  version `7`, and transition-journal version `8` reject cross-model or
  cross-profile substitution before
  interpreting a marking;
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
  digest and a generic execution-backend pin through disjoint native guard
  activities before execution, rejects same-coordinate descriptor/backend
  drift during replay, maps semantic attempts to native
  `Activity.CurrentAttempt`, exposes a transport-neutral encoded handler
  result, revalidates transport output/failure codecs and failure identity at
  the workflow host, requires an explicit infrastructure interruption policy,
  and forces every positive business timer through `DurableClock` with a zero
  in-memory threshold;
- an opt-in protocol-v3 native `DurableQueue` transport for distributed node
  handlers. Content-addressed routes pin logical queue, deployment, and handler
  build; strict work items carry the complete operation pin; every delivery
  reloads and verifies the artifact, operation, executable registry, route, and
  build before user code. Queue storage, worker loops, waiting, redelivery, and
  concurrency remain native Effect responsibilities. Offer and attestation
  retry plus the native queue acquisition-failure limit are explicit. The
  adapter rejects schedule-to-start/start-to-close until native worker-start
  fencing exists and claims neither remote cancellation, dead-letter repair,
  stale-worker completion fencing, nor exactly-once external effects;
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
  `executeWithExecutor` and `executeDetailedWithExecutor` accept a trusted
  attempt transport while the retry controller retains attempt creation,
  receipt-coordinate validation, classification, backoff, and
  schedule-to-close. An executor without a worker-start handshake is rejected
  before any durable deadline is armed when schedule-to-start or start-to-close
  is enabled.
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
`bpmn-2.0.2-core-process-di-v6`, normative XSD validation, complete Common
Executable and Activity lifecycle semantics, a complete atomic normative
catalogue, persistent storage, authenticated history anchoring, official
fixtures, and published conformance evidence remain required. The package
provides no built-in FEEL, XPath, or other expression implementation; an
application must install an exact build-pinned evaluator, and strong CPU/heap
isolation requires a worker, process, or sandbox adapter. BPMN 2.0.2 itself
allows `loopMaximum` to be omitted and `loopCondition` to use the more
permissive `tExpression` form. Profile `v6` deliberately fails closed unless a
generic Task has a positive maximum and a version-bound formal condition; it
does not claim general Standard Loop support. Its separate
`FixedMultiInstance/1` execution intersection is deliberately limited to a
cardinality-based generic Task with behavior All and an optional formal
completion condition. `CollectionMultiInstance/1` is a separate closed-group
intersection: its collection expression and declarations are exact external
compile inputs committed to the executable fingerprint, not inferred from XML
alone. It supports bounded input scatter and complete-success output gather,
but not an externalized or streaming item manifest, partial output policy,
One/None/Complex progressive behavior, Multi-Instance SubProcesses or
CallActivities, open/dynamic fan-out (WCP15), draining static or dynamic
partial joins (WCP34/WCP36), native collective cancellation/audit, normative
XSD evidence, or any formal BPMN conformance claim. Open creation and draining
require a distinct `OpenForEachGroup/1` semantic profile rather than a silent
widening of either frozen group.

The same profile's `CatchEventChoice/1` intersection is intentionally narrower
than BPMN's complete Event model: it admits only normal-flow Message and
fixed-duration/absolute-date Timer Intermediate Catch Events, standalone or
directly following an exclusive non-instantiating Event-Based Gateway. It does
not provide durable early-message retention, predicate or wildcard
correlation, `timeCycle`, Signal/Conditional/Multiple Events, Start/Boundary
Events, Receive Tasks, event subprocesses, or instantiating/Parallel
Event-Based Gateways. The optional native Effect Workflow adapter delegates
durable scheduling and wake-up hints to the selected backend; it does not own
portable race selection, correlation, cancellation, replay, or any broader
BPMN conformance. BPMN 2.0.2 Table 10.99 requires
`MessageEventDefinition.operationRef` for executable Processes, whereas this
slice rejects it and uses a fingerprinted external `MessageBinding`; §13.3.3
also describes predicate-based correlation that the exact-key profile rejects.
`CatchEventChoice/1` is therefore an implementation profile and bounded WCP16
evidence, not BPMN Process Execution Conformance.

`timeDuration` and `timeDate` are BPMN `tExpression` values. XML v6 preserves
their expression text; it does not claim that the BPMN XSD directly types that
text as `xsd:duration` or `xsd:dateTime`. Executable admission evaluates the
expression, requires a string result, and parses that value as a bounded
ISO-8601/XML Schema duration or date-time subset: non-negative fixed
day/time durations with exact millisecond representation, or zoned date-times
normalizable to the protocol timestamp. Calendar-relative units, negative or
lossy values, and `timeCycle` remain outside this profile.

`OperationalInstanceWithdrawal/1` is a separate external control-plane
extension implemented by `BpmnKernel.withdrawExecution`. A
`RequestInstanceWithdrawalCommand` carries one idempotent `requestId` plus
bounded `rootScopeInstanceId`, `WithdrawalAuditAttribution`, and optional
`reasonCode`. The successful portable state commit/CAS that records
`OperationalWithdrawalRequested` together with
`OperationalWithdrawalSchedulingFenced` is the linearization point. From that
point the kernel admits no new scheduling, closes owned embedded scopes,
gateway and loop frames, fixed/collection Multi-Instance groups, catch wait
groups, subscriptions, and timers, emits no outgoing Sequence Flow, and fences
late task success or failure as `TaskCompletionFenced` or
`TaskOutcomeFenced`. Exact replay records
`OperationalWithdrawalReplayed` rather than applying the withdrawal twice.

The terminal `OperationalWithdrawalCompleted` fact means that the portable
execution is logically closed. It does not mean that an already-started
external effect, remote service, or human action physically stopped, and it
does not undo a committed effect. This profile is only bounded partial WCP20
Cancel Case evidence. It is not BPMN `CancelEventDefinition`, a Transaction
Cancel, a Terminate End Event, compensation, rollback, or WCP19 targeted task
cancellation. Executable CallActivity frames participate in the same
parent-close transition: a parent failure or operational withdrawal derives
the target-pinned close command, commits it with the frame, and delays the
parent's failed or cancelled terminal fact until every `CancelAndWait` barrier
has a terminal child projection. `RequestCancel` is released after durable
cancellation intent and `Abandon` detaches without claiming that the child
stopped. Work-item/human-task withdrawal, targeted scope withdrawal, unrelated
or merely message-correlated process instances, and any physical-stop guarantee
remain excluded. Consequently:

`BPMN Process Execution Conformance: not claimed`.

For an Effect Workflow host, the portable commit is authoritative.
`EffectWorkflowBpmnOperationalV3.prepareCommittedWithdrawal` authenticates that
committed snapshot and returns an opaque post-commit capability. Local catch
waits use `prepareCancelledWaitNotification` followed by
`notifyCancelledWait`; the deferred state-change value is only a reload hint.
`interruptCommittedHost` is the separate safe choice when the addressed native
workflow execution is exactly the whole portable instance that must terminate.
Neither path is the semantic decision itself. The adapter must not use
`interruptUnsafe` or add a second scheduler, store, journal, or replay engine.

The closed profiles follow durable-engine lessons shared by Temporal, AWS Step
Functions, Argo, and similar systems: freeze the logical member set at
activation; keep logical member identity distinct from retry or delivery
attempts; bound semantic cardinality separately from operational worker
concurrency; aggregate complete results in input-index order even when parallel
completions arrive out of order; and segment or roll over histories before
large fan-outs become unbounded. Native Effect Workflow can supply persistence,
replay, child execution, activities, deferreds, clocks, and backend
interruption when selected. Workflow Builder records portable BPMN group
semantics and exact native occurrences; it does not reimplement or require
those backend capabilities.

A BPMN `callActivity` is executable in the bounded `PortableChildProcess/1`
profile. Compilation binds the source `calledElement` expanded QName, the exact
protocol-v3 child target pin (including artifact, contract, deployment,
lineage, recursion, and close-policy authority), and one explicit encoded-input
expression. The expression must produce a bounded protocol-v3 `EncodedPayload`;
the kernel neither guesses a codec nor infers a BPMN data association. Opening
the wait records the evaluated input, canonical `ChildScheduled` fact, durable
call frame, and canonical `ScheduleChild` outbox command. A trusted authority
feeds child facts back through `applyChildEvent`; event identity, relation,
target contracts, backend locator, and lifecycle are validated and replayed
without polling or re-running the child. A successful child consumes the
waiting token and follows normal outgoing flow exactly once. Other terminal
outcomes remain durable close/failure facts rather than being relabelled as
BPMN Error, Cancel, or success.

This is portable parent/child semantics plus an optional native dispatch
adapter, not a complete backend implementation. The package still supplies no
persistent relation store, scheduler, outbox relay, inbox/transport,
authoritative lifecycle source outbox implementation, or cluster/failover
authority. The package can record strict child-source reports through a native
Activity and prepare their exact parent projections, but a host outbox must
first-write and deduplicate each source fact, atomically coordinate the
committed parent transition and egress command, then deliver the canonical
fact. In particular, replay must reuse the first allocated source sequence and
occurrence time. Native start, safe interruption, and lifecycle Activity
receipts still derive no semantic cancellation from operational
acknowledgements. Persistent crash/restart and multi-worker evidence remains
pending, and the package makes no full BPMN Process Execution Conformance
claim.

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
