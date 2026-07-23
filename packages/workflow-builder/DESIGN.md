# Workflow Builder architecture and decision record

Status: accepted direction; semantic core, runnable process-local protocol-v2
authority, BPMN semantic/data/DI/XML-slice/token foundations, and process-local
durable reference authorities plus a thin protocol-v3 native Effect Workflow
host implemented; complete native primitive mappings and execution semantics
planned\
Scope: `@effect/workflow-builder`\
Last reviewed: 2026-07-23

## Decision summary

Workflow Builder will be a UI-agnostic compiler and execution semantic layer, not
another hosted workflow product. Applications persist a strict, versioned JSON
plan; the package compiles that plan against an application-owned, versioned node
vocabulary; a backend executes the compiled plan through one semantic
event/history state machine; and all side effects cross an activity boundary.

Durability is an explicit backend choice. A direct backend will use the same
semantic model without crash recovery. A durable backend will persist history,
signals, timers, and dispatch intent before work can become externally visible.
Neither backend may silently substitute for the other.

Portable format version `1` remains an acyclic dependency graph and keeps its
existing deterministic topological semantics. It is not the universal control
model. A separate versioned control-flow IR will represent BPMN processes and
the Workflow Patterns admitted by named executable profiles with typed sequence
flows, gateways, events, scopes, token multiplicity, repeated invocations,
structured loops, and bounded arbitrary cycles. Complete pattern-catalogue
coverage remains an explicit machine-readable backlog rather than an implied IR
property. Structured regions remain the preferred authoring form, while imports
that rely on unsupported or ambiguous BPMN semantics fail with an explicit
loss/conformance diagnostic instead of being lowered to a DAG.

## Goals

- Define a portable, immutable, JSON-compatible plan that any editor, API, or
  repository can store without serializing functions, `Effect` values, services,
  or credentials.
- Let applications own a versioned node vocabulary with typed configuration,
  ports, outputs, failures, handlers, and authorization policies.
- Reject invalid or unsafe plans before execution and return all independent,
  path-addressed diagnostics in one pass.
- Give direct and durable backends the same observable workflow semantics while
  making their recovery and delivery guarantees explicit.
- Support long-running runs, buffered external signals, timers, retries,
  cancellation, structured control flow, and deterministic dynamic fan-out.
- Support standards-grounded process interchange and execution through explicit
  BPMN 2.0.2 conformance profiles, plus documented engine extensions for
  Workflow Patterns that BPMN does not express exactly.
- Make history sufficient to explain a run, rebuild semantic state, test replay,
  and migrate old data without mutating past facts.
- Remain Effect-native: `Schema` at every persistence or trust boundary, typed
  `Effect` failures and requirements, `Context.Service` interfaces, and
  replaceable `Layer` implementations.

## Non-goals

- Shipping a workflow canvas, integration marketplace, hosted control plane,
  scheduler UI, or credential vault in this package.
- Replacing `effect/unstable/workflow`; a durable adapter may build on it, while
  the portable IR and semantic state machine remain backend-independent.
- Running arbitrary user-supplied JavaScript, expressions, containers, or plugins
  merely because they appear in plan JSON. Executable behavior must be registered
  application code and admitted by policy.
- Providing an unbounded streaming/dataflow network. BPMN and workflow control
  cycles are supported only under explicit token, iteration, history, duration,
  and resource bounds.
- Promising exactly-once external side effects. General I/O cannot provide that
  guarantee without cooperation from the destination.
- Automatically upgrading a live run to a new plan, node implementation, schema,
  compiler semantic version, or backend.
- Treating large datasets as in-history values. History carries encoded small
  values or immutable, integrity-checked blob references.

## Principles

1. **Data is portable; code is registered.** A plan names `type@version` and
   contains JSON configuration. It never embeds a handler or service object.
2. **Pin meaning before starting.** A run pins an immutable plan revision,
   definition version, node versions, compiler semantic version, and compiled
   fingerprint.
3. **Compile once, fail closed.** Structural validation, contract compatibility,
   authorization, topology, and resource admission happen before dispatch.
4. **One semantic core, several adapters.** Backends implement storage, clocks,
   signals, leases, and dispatch, not different interpretations of the graph.
5. **Append facts; derive state.** A pure fold rebuilds run state from ordered
   facts. A pure decision function derives the next commands from that state and
   the pinned compiled plan.
6. **Persist intent before side effects.** Scheduling is a committed fact before
   an activity can be delivered. Results become semantic only after being encoded
   and committed.
7. **Identity and order are explicit.** Stable run, node-instance, activity,
   attempt, signal, branch, and iteration identities never depend on completion
   timing or array position alone.
8. **Capabilities and cost are policy.** Connections, services, concurrency,
   retries, history, payloads, and signals are bounded and authorized explicitly.
9. **Replay is a compatibility contract.** Old histories and pinned handlers are
   production data, not incidental implementation details.

## Native Effect Workflow backend boundary

The preferred durable-host direction for protocol version `3` is the native
public `effect/unstable/workflow` API. Workflow Builder will not implement
`WorkflowEngine.Encoded`, clone the cluster mailbox, or create competing
activity-result, deferred, clock, child-suspension, sharding, or failover
machinery. An application supplies a `WorkflowEngine` layer: the native memory
layer is suitable for tests, while `ClusterWorkflowEngine` can supply production
distribution and persistence without becoming a dependency of this package.

The boundary is deliberately above the native replay engine:

| Owner                            | Responsibilities                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow Builder semantic core   | Portable static-DAG and BPMN artifacts; compilation and exact version/build pins; deterministic token/branch/fan-out decisions; dynamic occurrence identities; business retry, timeout, signal, child-close, human-task, compensation, mapping, policy, audit, and operator semantics.                    |
| Effect Workflow adapter          | Register an artifact-versioned native workflow; map each already-admitted semantic occurrence to a stable native activity/deferred/clock/child/queue identity; delegate execute, poll, safe interrupt, and resume; translate native outcomes back into checked semantic inputs without inventing meaning. |
| Native `WorkflowEngine` backend  | Handler re-execution, durable activity result replay, suspension and resumption, deferred completion, durable clocks, parent-child operational propagation, workflow-scoped interruption, queues, persistence, mailbox delivery, sharding, failover, and backend-specific recovery.                       |
| Application / trusted deployment | Supply the selected engine layer, historical artifact handlers, executable-build attestation, signal/token authorization, secrets, tenant isolation, storage configuration, backup/restore, and any platform-specific worker placement or network policy.                                                 |

The first adapter must obey these invariants:

- It imports only the public `effect/unstable/workflow` surface. It does not
  import or construct `ClusterWorkflowEngine`; deployment chooses that layer.
- A native workflow tag pins the adapter/protocol version and exact artifact
  digest. Historical tags and handlers remain registered while matching
  executions can resume.
- Every dynamic activity name and child idempotency key includes the Builder
  occurrence/call identity. Reusing only a node definition name would alias
  loop or fan-out instances in the native activity cache.
- Native activity, timer, and deferred names use one bounded versioned tuple of
  semantic occurrence, operation slot, and renewable generation coordinates.
  Activity names remain logical across retries and the semantic attempt is
  supplied through native `Activity.CurrentAttempt`, which already participates
  in the Effect Workflow persistence key. This is the adapter's only naming
  layer; the semantic runtime invokes the corresponding public Effect primitive
  and does not introduce a parallel activity, timer, or deferred store.
- The same native execution, name, and native attempt must imply one
  byte-identical semantic operation descriptor. A disjoint native guard
  activity records the descriptor digest before the operation runs and compares
  it during replay. The digest is never placed in the operation name, because
  that would turn drift into a second side effect instead of rejecting it.
- Business deadlines force the durable-clock path. Native short in-memory
  sleeps are never silently treated as durable BPMN timers.
- A native deferred token is an address, not authorization. External completion
  crosses Builder admission policy before the token is completed.
- A semantic race commits ordered participants and returns an identified
  winner. Its `InterruptWaiters` disposition interrupts losing wait fibers; it
  does not assert cancellation, compensation, or rollback of external work
  already started by an activity.
- Backend conformance must distinguish durable replay from process-local
  scheduling. In particular, the native memory engine does not resume a
  pending deferred while a sibling activity keeps the same workflow execution
  fiber globally running. A preloaded deferred result is replay-safe, but this
  memory-layer behavior is not evidence for a live BPMN event race against
  remote work.
- Native `Complete` or `Suspended` status is operational state, not a substitute
  for the Builder domain timeline, BPMN marking, actor-attributed audit facts,
  migration metadata, or failure-branch meaning.
- Start-request conflict admission occurs before native execution. A native
  idempotency key deduplicates execution but does not explain a same-run,
  different-request conflict.

The version `1`/`2` memory stores and authorities remain executable semantic and
race conformance fixtures while they have callers. They are not a blueprint for
another persistent replay engine. New version `3` durability work starts at the
adapter boundary above; old draft authorities can be removed once their
semantic coverage has migrated to backend-neutral tests and no runtime path
uses them.

This package is still pre-release, so draft source APIs do not receive
compatibility adapters. Once a newer path completely replaces an older
implementation and every internal caller has migrated, the superseded module
and tests are removed. That development policy does not erase persisted
semantics: protocol, identity, artifact, compiler, and history versions remain
explicit because an admitted production run must replay under the meaning it
started with. The current version `1` and `2` modules are still used by runnable
authorities and therefore are not deletion candidates yet.

## Implemented foundation today

The package currently contains admission, fingerprinting, a deliberately
non-durable direct interpreter, the first strict semantic-history fold, and a
tenant-scoped process-local reference authority for durable races. The table is
descriptive, not a claim that an in-memory implementation survives process or
machine failure.

| Module                            | Implemented responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plan.ts`                         | Strict `Schema` definitions for portable format version `1`: plan identity/revision, exact workflow definition reference, versioned nodes with JSON config/metadata, data edges, and control edges. Excess properties and non-JSON values are rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Port.ts`                         | Typed JSON-encoded input/output schemas, application-owned contract identifiers, required/cardinality rules, output fan-out rules, annotations, and decoded value types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Node.ts`                         | Versioned node definitions, JSON-encoded config/input/output/failure schemas, Effect handler signature, declared requirements, annotations, and explicit direct/durable handler scope with stable run/node/attempt/idempotency identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Registry.ts`                     | Duplicate-safe `type@version` definition registry plus provenance-checked `HandlerRegistry` as a `Context.Service`; handler implementations and their captured context can be installed with a `Layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Workflow.ts`                     | Versioned application vocabulary, boundary ports, mandatory link policy, compile-time node/edge/fan-in/fan-out/depth limits, and annotations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LinkPolicy.ts`                   | Explicit effectful data-link authorization, including inspectable ordered rules and deny/allow policies. Contract compatibility remains the compiler's separate responsibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Diagnostic.ts`                   | Strict, detached, immutable, path-addressed diagnostics with safe hostile-input construction, non-negative safe-integer paths, and an aggregate typed `CompilationError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Compiler.ts`                     | Descriptor-safe detached JSON admission before strict schema decode; config validation; early graph-limit rejection; link authorization; contract/cardinality/fan-out/required-port checks; duplicate/endpoint/root-cycle checks; immutable deterministic topology; and exact result provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CompilerV2.ts`                   | Canonical compiler-semantic-version `2` IR separating metadata-free plan meaning, sorted workflow-boundary contracts, and a resolved static-DAG program; external documents are checked for canonical ordering, exact edge/adjacency correspondence, and a code-unit Kahn schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Fingerprint.ts`                  | Canonical recursive JSON serialization and a versioned SHA-256 fingerprint document containing the admitted portable plan and compiler-derived schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Interpreter.ts`                  | Explicitly non-durable direct execution with exact compiler/handler provenance, fresh config decoding, detached frozen JSON at every routed boundary, dependency-readiness scheduling, bounded runnable concurrency, captured/ambient Effect services, typed failures, hostile-result validation, and interruption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Identity.ts`                     | One collision-free versioned tuple scheme shared by command, start, result, terminal, and replay boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Event.ts`                        | Strict semantic-history format version `1`: pinned run start, committed activity scheduling/results, cancellation request, attributed activity failure, and terminal run facts in a versioned JSON envelope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RunState.ts`                     | Pure fail-closed history replay with exact sequence/run identity, canonical engine event IDs, duplicate event and activity protection, attributed failure matching, legal transition checks, encoded values, and immutable derived run/activity state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ActivityPolicy.ts`               | Strict immutable protocol version `2` retry classifier, fixed backoff, explicit no-jitter choice, and independent schedule-to-start, start-to-close, and schedule-to-close timeout dimensions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ActivityPolicyV3.ts`             | Protocol-v3-native exact classifier build pins, canonical explicit non-retryable identities, closed persistable application-failure/attempt-timeout causes and infallible retry decisions, attempt/elapsed budgets, fixed or capped exponential backoff, deterministic no-jitter or recorded-range jitter admission, and three independent timeout dimensions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `IdentityV2.ts`                   | Tenant-bound version `2` tuple identities separating logical activity, semantic attempt, operationally stable external idempotency, retry, timer, signal, wait, result, and terminal facts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `EventV2.ts`                      | Separate strict version `2` history vocabulary for attempts, retry, canonical millisecond timers, signal acceptance/wait/consumption facts, cancellation, and terminal attribution, with an explicit artifact/start identity and execution-protocol selector.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CommandV2.ts`                    | Separate tenant/run-bound version `2` decision vocabulary whose timer commands identify a committed anchor and delay but never supply store-owned absolute deadlines or external facts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SemanticTime.ts`                 | Clock-free checked materialization of one canonical UTC millisecond deadline from an already-committed timestamp plus a bounded semantic delay, with typed invalid-input and range failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RunStateV2.ts`                   | Pure fail-closed version `2` replay for semantic attempts, retry exhaustion and anchors, timer/result/cancellation races, ordered signal matching and expiry, owner-aware cleanup, canonical identities, nondecreasing time, and immutable derived state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ProtocolV2Wire.ts`               | Shared nominal digest, timestamp, bounded semantic-duration, payload/blob-reference, and admission-attribution wire primitives for protocol version `2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ProtocolV3Wire.ts`               | Protocol-v3-native safe bounds, canonical timestamps, nominal digest domains, and strict inline-or-immutable-blob payload references with no protocol-v2 dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DigestV3.ts`                     | Descriptor-safe canonical SHA-256 envelopes with audited, domain-separated artifact, compiler-v2 plan, boundary-contract, executable-build, and encoded-schema identities plus typed crypto/input failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PlanStoreV3.ts`                  | Strict static-DAG protocol-v3 artifact manifests for compiler, definition, handler, codec, schema, boundary, retry-classifier, policy, and node bindings; canonical relationship validation; fixed-order digest verification; WeakSet provenance; read-only store contracts; and artifact-derived child targets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EffectWorkflowBackendV3.ts`      | Thin optional native Effect Workflow host for already-admitted protocol-v3 runs: exact artifact-versioned workflow tags, detached request/result envelopes, binding and semantic-execution provenance retaining the exact verified artifact, tenant/run idempotency, handler registration, and delegated execute/poll/safe-interrupt/resume with no storage-engine SPI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EffectWorkflowOperationV3.ts`    | Strict bounded replay-stable naming coordinates for logical native activities, durable timer generations, and deferred generations. Semantic attempts use native `Activity.CurrentAttempt`; Effect Workflow remains the sole activity-result, deferred, clock, suspension, and replay implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SemanticOccurrenceV3.ts`         | Content-addressed dynamic node occurrences committing tenant/run/artifact/node identity, bounded root-to-parent scope activations, and replay-derived node activation; exact process-local provenance and persisted-pin digest verification prevent structural substitution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SemanticOperationV3.ts`          | Content-addressed operations with closed node-handler/classifier/jitter/time-observation activity purposes, coherent exact artifact-codec/node-output-aggregate/versioned-built-in result contracts, typed-owner timer generations, separately success/error-schema-and-codec-pinned deferred generations, and derived ordered race membership; exact occurrence provenance, persisted nested verification, and native-coordinate projection make drift detectable before side effects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SemanticExecutableRegistryV3.ts` | Immutable Effect service that atomically resolves every build-pinned node handler, codec/schema, and retry classifier required by one exact `VerifiedArtifact`; executable constructors and resolved activity/deferred/race views retain process provenance and captured contexts, dynamically derive exact race result schemas, and admit neither persistence, caching, nor fallback lookup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EffectWorkflowSemanticV3.ts`     | Authenticated one-shot static-DAG occurrence admission plus semantic-to-native mapping: descriptor-binding guard activities, checked replay drift, semantic attempts through native `Activity.CurrentAttempt`, explicitly selected infrastructure interruption policy, positive timers through forced-durable native `DurableClock`, authenticated deferred completion, and identified `FirstSettled`/`FirstSuccess` races without a second backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EffectWorkflowRetryV3.ts`        | Descriptor-safe managed retry over the native semantic mapper: exact node-attempt activities persist one closed success-or-application-failure outcome, handler typed failures are encoded and classified once, explicit non-retryable identities precede the exact captured classifier, and attempt/elapsed admission budgets, replay-recorded internal jitter, and native durable-clock backoff produce closed success, `NonRetryable`, or `Exhausted` results. A content-addressed schedule-to-close controller durably acknowledges one stable injected-engine clock before time observation or node execution. Detached contenders publish success-only envelopes to one native first-wins deferred; clock reads fence every attempt and final publication, and the coordinate-, timestamp-, classifier-, and policy-checked winner is replayed without joining loser shutdown. Timeout fences semantic completion without claiming external rollback. The injected engine/persistence remains the record-integrity trust boundary because native Effect Workflow exposes no independent read-only activity-journal proof API. Schedule-to-start and start-to-close remain rejected until persistent worker start/lease acknowledgement exists; `maximumElapsed` remains an admission budget, not an in-flight attempt deadline. |
| `IdentityV3.ts`                   | Collision-free tuple-framed child call, run, start, schedule, projection, cancellation, abandon, and start-failure identities for protocol version `3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DecisionV2.ts`                   | Exact prepared plan/artifact provenance and deterministic static-DAG protocol-v2 decisions for scheduling, retry, failure, cancellation, signal consumption, and terminal completion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CommandEventV2.ts`               | Public preview materialization accepts only the exact immutable batch produced by `DecisionV2.decide` for the exact reducer head; canonical command identity is validation rather than authorization. The unrestricted storage translator is package-internal, and the execution authority remains the atomic commit boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ExternalEventV2.ts`              | Pure privileged materialization of worker-start, worker-completion, due-timer, and cancellation facts with atomic owner/timer cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DurableStartV2.ts`               | Exact prepared protocol-v2 start admission with Effect Schema input encoding, deployment provenance, immutable artifact identity, and no caller-owned sequence, event identity, or timestamp.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ActivityCompletionV2.ts`         | Plan/state-bound unforgeable worker-completion capabilities that decode every successful output and encoded application failure through the exact compiled node schemas, including imported-history validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ExecutionAuthorityV2.ts`         | One process-local atomic `Ref` for prepared plans, histories, derived heads, receipts, timer/dispatch indexes, and wakes; it recomputes decisions under CAS, owns timestamps/sequences, admits only prepared completions, and records residual deadline overflow as deterministic protocol failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SignalContractV2.ts`             | Versioned signal definitions, codec/policy build pins, bounded inbox/dead-letter policy, and strict manifest relationships.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SignalRuntimeV2.ts`              | Exact signal codec/policy resolution, payload integrity and blob boundaries, authorization attribution, and bounded admission preparation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SignalAuthorityV2.ts`            | Process-local atomic signal admission, deduplication, expiry timer, receipt, pending-capacity, and dead-letter reference authority; intentionally separate from the execution authority until a persistent adapter can share the transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BpmnModel.ts`                    | Strict versioned BPMN semantic IR plus aggregate containment, flow, event, gateway, boundary, collaboration, and reference validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BpmnData.ts`                     | Strict normalized BPMN data, IO specification, data-association, interface, operation, message, error, and local callable-binding slice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `BpmnDi.ts`                       | Normalized BPMNDI/DI/DC diagrams, shapes, edges, labels, styles, geometry, identities, and semantic reference-kind validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BpmnActivityV3.ts`               | Pure protocol-v3 BPMN task bindings, exact failure-identity-to-Error promotion mappings, portable success/business-failure outcomes, and durable idempotent task-resolution records. It deliberately excludes defects, operational cancellation, BPMN Cancel, and boundary timers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `BpmnExecutionState.ts`           | Durable token, scope, invocation, gateway, loop, multi-instance, call, subscription, timer, work-item, compensation, cancellation, and exact task-resolution state foundation at state version `3`, with a version `2` executable-model fingerprint reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BpmnExpression.ts`               | Strict portable evaluator build pins and bounded source/context/step/timeout policies keyed by an exact language and language version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BpmnExpressionEvaluator.ts`      | Provenance-guarded service-closed evaluator definitions and an Effect `Context.Service` registry with complete-tuple lookup, build coexistence, and no fallback or latest resolution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BpmnExpressionRuntime.ts`        | Effect-native driver that repeatedly runs the same immutable pure-kernel operation, resolves only the first unknown exact condition, caches it under a canonical operation-local decision identity, and exposes only the final atomic batch while enforcing timeout, strict output, step limits, and Effect interruption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BpmnXmlAst.ts`                   | Resource-bounded namespace-expanded ordered XML infoset parsing, validation, spans, and deterministic serialization; deliberately not a general XSD validator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BpmnXml.ts`                      | Fail-closed named profile `bpmn-2.0.2-core-process-di-v2` for definitions metadata, ordinary process/subprocess control flow, source-level call-activity QNames, expression-version bindings, and the current complete normalized DI slice, with canonical export and explicit mapping reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BpmnKernel.ts`                   | Effectfully prepared, domain-separated executable fingerprints plus bounded deterministic token execution and versioned causal replay for the explicitly admitted none-event/task/subprocess/conditional/default/exclusive/parallel subset. Fingerprinted protocol-v3 task bindings add exact success routing, one interrupting Boundary Error catch, deterministic unmapped/uncaught root failure, and resolution idempotency. Condition facts include the exact evaluator binding and bounded usage evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BpmnHistory.ts`                  | Strict sealed BPMN journal artifacts whose complete model-bound causal payload is verified through a domain-separated history digest before replay; the digest is content identity, not authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BpmnExecutable.ts`               | Strict no-inference, Effectful admission from the named BPMN XML profile directly into a cryptographically prepared token kernel, preserving diagnostics and proving import/execution/journal replay/export/re-import/recompile equivalence without lowering through the version `1` DAG.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BpmnConformance.ts`              | Strict machine-readable requirements, coverage, evidence maturity, dependency, and formal-claim gates; checked-in coverage remains incomplete and declares no BPMN conformance claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ChildWorkflowV3.ts`              | Child-workflow protocol-v3 foundation with exact artifact/deployment/build/contract/close-policy pins, definition-derived family identity, bounded same-tenant lineage, recursion rejection, canonical relation identities, and reducer-owned structural phase types with no standalone state-admission API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ChildWorkflowProtocolV3.ts`      | Strict relation-bound schedule/cancel/abandon commands and complete child lifecycle projection facts with canonical identity, causation, correlation, contract, inline/blob payload, and descriptor-safe validation boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ChildWorkflowStateV3.ts`         | Pure immutable relation replay enforcing schedule-first sequencing, legal start/cancel/terminal races, cause-specific close policies, post-accept cancellation fencing, output-contract pins, abandonment suppression boundaries, and parent close barriers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `HistoryStore.ts`                 | Atomic expected-sequence history contract plus an explicitly process-local memory layer. The memory implementation assigns envelopes once, recognizes exact batch retries after head advancement, rejects ID overlap, validates hostile inputs, and uses persistent collections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Command.ts`                      | Strict version `1` scheduling/terminal command vocabulary plus stable collision-free activity, idempotency, and command identity helpers. The vocabulary intentionally contains no retry, timer, or signal commands yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Decision.ts`                     | Exact prepared-object provenance plus fingerprint pinning and a pure deterministic decision function for static DAG activities: dependency-ready scheduling, encoded routing, explicit cancellation precedence, plan-aware history validation, and frozen command output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CommandEvent.ts`                 | Descriptor-safe conversion of exact commands into immutable append-ready event drafts, preserving full activity-failure attribution and command causation without inventing correlation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CommandRuntime.ts`               | Effectful strict command boundary that validates successful encoded values through workflow-output sink schemas, including cardinality, required services, codec defects, and interruption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DecisionCommit.ts`               | Provenance-checked preparation of whole decision batches with exact pinned dispatch targets, effectful command validation, command-to-event conversion, and one matching dispatch draft per activity schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RunStart.ts`                     | Provenance-checked prepared-plan start drafts with exact typed workflow input encoding, strict JSON detachment, stable event identity, compiler/fingerprint pins, and an explicit direct-versus-durable backend choice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ActivityRuntime.ts`              | Process-local execution of one already-committed activity command with canonical identity checks, fresh config/input decoding, exact handler resolution, typed failure encoding, strict output snapshots, stable result event identities, and interruption propagation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LocalRunner.ts`                  | Direct-backend semantic driver over `HistoryStore`: atomic decision-batch commits, fresh re-decision after CAS conflicts, schedule-before-dispatch, bounded local activity concurrency, deterministic result order, result reconciliation, and explicit cancellation races.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Deployment.ts`                   | Exact workflow/handler deployment catalog with process-local definition provenance; no `latest` resolution after run admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PlanStore.ts`                    | Strict immutable plan artifacts and tenant-scoped run bindings with an explicit execution-protocol pin plus topology, stage, route, deployment, fingerprint, and artifact-digest validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PlanStoreV2.ts`                  | Separate version `2` artifact/binding schema that pins exact activity policies alongside topology, routes, deployments, content identity, and the execution protocol without widening version `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DurableStart.ts`                 | Provenance-checked durable admission that resolves exact workflow and handler deployment objects and prepares one atomic start/artifact/binding request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DurableRecovery.ts`              | Empty-cache recovery through tenant binding, artifact and digest verification, exact deployment resolution, recompilation, fingerprint comparison, and semantic history fold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Dispatch.ts`                     | Strict authoritative activity-dispatch, pointer-and-digest broker, and encoded worker-result models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ExecutionStore.ts`               | Tenant-scoped process-local reference authority sharing one atomic state for start, plan binding, history, outbox, coordinator wakes, relay state, every issued worker generation, cancellation intents/claims, and result completion. Durable decision commits require a current coordinator capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RunCoordinatorStore.ts`          | Fair bounded tenant-scoped runnable discovery, exact request receipts, renewable epoch/capability leases, sequence-guarded idle acknowledgement, and storage-atomic fenced decision commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DurableCoordinator.ts`           | One-shot durable decision driver that verifies a leased run through empty-cache recovery, prepares an exact decision, and performs a fenced commit or sequence-guarded idle acknowledgement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ActivityDeliveryStore.ts`        | Bounded outbox claims, independent relay and worker epochs, strict queue/digest/deployment checks, renewal, stale-generation rejection, duplicate-result recognition, and completion/history atomicity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ActivityCancellationDelivery.ts` | Exact issued-generation cancellation records and bounded, retry-safe, epoch/capability-fenced claim, acknowledge, and release contracts whose operational acknowledgement never gates semantic run cancellation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ActivityCancellationWorker.ts`   | Process-local exact-lease fiber registry and one-shot cancellation worker; interruption waits for finalizers, acquire/register races retain tombstones, and durable acknowledgement follows only an observed interruption or finished execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OutboxRelay.ts`                  | At-least-once parallel outbox publication through stable pointer-only messages; broker acknowledgement follows publication and per-item failures are isolated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ActivityConsumer.ts`             | Strict broker ingress that rejects inconsistent message identity and acquires authoritative stored work under exact queue, digest, and handler-deployment pins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DeploymentHandlers.ts`           | Provenance-checked executable handler registry indexed by immutable deployment, type, and version, allowing old and new builds to coexist safely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ActivityWorker.ts`               | Durable worker boundary that cross-checks recovered run, dispatch, artifact route, definition object, deployment registry, and handler build before execution, then commits under the worker fence; its cancellation-aware path registers the exact handler fiber first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ActivityBrokerWorker.ts`         | One-shot acquire/execute/complete/settle boundary, with a cancellation-aware variant, that acknowledges only durable completion or authoritative suppression, delays retryable delivery failures, audits poison work through dead-letter settlement, and preserves interruption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

There is currently no production Effect Workflow adapter.
`ExecutionStore.makeMemory` specifies the version `1` transaction/race model,
while `ExecutionAuthorityV2.makeMemory` runs exact protocol-v2 static-DAG
starts, decisions, retries, activity timeouts, due timers, cancellation, and
schema-admitted worker completions. `SignalAuthorityV2` specifies bounded signal
admission separately. All three authorities lose history, artifacts, receipts,
leases, timers, and outbox/inbox state on process exit, and their exact-request
ledgers are not a production retention strategy.

These memory authorities will not be translated mechanically into a competing
persistent workflow engine. The protocol-v3 adapter delegates replay,
persistence, durable activities, deferreds, clocks, interruption, distribution,
and recovery to the application's native `WorkflowEngine` layer. Builder-owned
domain facts may still be projected idempotently for audit, search, BPMN
markings, and explanations, but such a projection does not replace or fork the
native backend's execution journal. The version `1` memory reference retains
every issued execution generation and can deliver cancellation to an exact
process-local Effect fiber only as a race-model fixture. Protocol-v2 still
provides only late-commit fencing, and neither a cross-process cancellation
transport nor child-workflow authority propagation is implemented on that
legacy path.
`LocalRunner` remains the direct version `1` semantic driver and its dispatch is
process-local. `Interpreter` executes ordinary Effects without semantic
history. The public version `2` materializer accepts only the exact
process-local capability returned by a decision over the same reducer head;
its unrestricted storage translator is package-internal. The runnable authority
obtains the bound plan and exact state internally, recomputes decisions under
sequence CAS, and alone exposes the authoritative commit workflow.

`BpmnExecutable.compileXml` now proves the exact named XML-to-token-kernel
intersection without semantic inference or DAG lowering. Preparation uses the
explicit `Crypto` service to bind the normalized semantic model, selected root,
kernel semantic version, limits, named profile, and exact evaluator-build
manifest. Version `2` markings and the leading journal header carry that
fingerprint, condition events carry their exact evaluator binding and bounded
usage evidence, and `BpmnHistory` can seal the complete causal journal under an
independently anchorable history digest. The Effect evaluator registry performs
exact full-tuple resolution with no semver or latest fallback, while the Effect
driver evaluates asynchronously by rerunning one fixed immutable kernel input
and exposes no partial batch. These mechanisms provide portable content
identity and fail-closed replay; they are not
persistent storage, a signature/MAC, a bundled FEEL/XPath implementation, or a
formal BPMN conformance claim.

Unbound BPMN execution-state version `1` and headerless journals are not
silently upgraded. A future offline migrator must receive the authoritative
normalized model and execution profile, prepare and fingerprint them, validate
the complete legacy marking/history under that authority, and then emit the
version `2` reference and versioned header. IDs alone are never sufficient
migration evidence.

## Prior art and boundaries

The choices below are evaluations against this package's goals, not general
rankings of the projects.

The normative interoperability baseline is
[OMG BPMN 2.0.2](https://www.omg.org/spec/BPMN/2.0.2), including its normative
XML schemas and distinct Process Modeling, Process Execution, BPEL Process
Execution, and Choreography conformance types. The broader semantic requirements
catalogue comes from Russell, van der Aalst, and ter Hofstede, _Workflow
Patterns: The Definitive Guide_ (2016), cross-checked against the
[Workflow Patterns Initiative](https://www.workflowpatterns.com/). The pattern
catalogue is research-based requirements evidence, not a substitute for the
normative BPMN specification. Detailed traceability and claim rules live in
[`STANDARDS.md`](./STANDARDS.md).

| System                                                                                                                  | Adopt                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Reject or avoid inheriting                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Temporal](https://docs.temporal.io/workflow-execution/event)                                                           | • Append-only event history and deterministic recovery<br>• Explicit activities, messages, timers, history rollover, and declared pinned or Auto-Upgrade [Worker Deployment behavior](https://docs.temporal.io/worker-versioning)                                                                                                                                                                                                                     | • Replay of arbitrary workflow source as the primary meaning of a user-authored graph<br>• Importing source-code patch markers or optional Auto-Upgrade behavior as a substitute for explicit portable-plan migration                                                                                                                                        |
| [Restate](https://docs.restate.dev/foundations/key-concepts)                                                            | • Journaled steps, keyed workflow identity, durable promises/signals, and persist-before-suspend behavior<br>• Exclusive workflow-run mutation with constrained [shared handlers](https://docs.restate.dev/foundations/services)                                                                                                                                                                                                                      | • Coupling the IR to a server/SDK streaming protocol<br>• Treating ordinary handler code as an adequately inspectable portable definition                                                                                                                                                                                                                    |
| [DBOS](https://docs.dbos.dev/architecture)                                                                              | • Checkpointed outputs, deterministic step ordering, [application-version drain](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows), queues, [at-least-once steps until completion](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial), and narrowly scoped [exactly-once database transactions](https://docs.dbos.dev/typescript/reference/datasource)                                                                       | • Positional step identity as portable graph identity<br>• A database-specific core or extrapolating a transaction-scoped exactly-once guarantee to activities and external effects outside that transaction                                                                                                                                                 |
| [Argo Workflows](https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/)                                     | • Explicit DAG/steps, templates, retries, timeouts, exit behavior, parameters, and artifacts<br>• Acyclic root scheduling with deliberate fan-out                                                                                                                                                                                                                                                                                                     | • Kubernetes CRDs, containers, and YAML as the package's runtime or type system<br>• Cluster scheduling concerns inside the portable semantic core                                                                                                                                                                                                           |
| [Apache Airflow](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html)                         | • Clear DAG-run/task-instance separation, scheduling/backfills, pools, retries, and operational state<br>• [Version-capable DAG bundles](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/dag-bundles.html), currently Git-backed, that can pin a run and support explicit original/latest rerun choices                                                                                                           | • Batch/scheduler-first assumptions for interactive long-lived workflows<br>• Treating latest-only bundle backends, Python parse-time behavior, or XCom-like payload passing as portable IR semantics                                                                                                                                                        |
| [Prefect](https://docs.prefect.io/v3/concepts/states)                                                                   | • Rich run state taxonomy, pause/suspend, retries, caching, concurrency, explicit `wait_for` dependencies, and observable child runs                                                                                                                                                                                                                                                                                                                  | • Python runtime coupling or runtime futures as the sole portable graph representation<br>• Importing client-driven task-run transition behavior as this package's durable authority instead of a backend-neutral committed event contract                                                                                                                   |
| [Dagster](https://docs.dagster.io/guides/build/ops)                                                                     | • Typed ports, replaceable resources/I/O managers, isolated testing, rich execution events, and multi-language external compute through Pipes<br>• Strong lineage and materialization observability                                                                                                                                                                                                                                                   | • Asset/materialization semantics as the universal workflow model<br>• Python-authored orchestration definitions or an I/O-manager configuration without an explicit portable storage contract as the IR itself                                                                                                                                              |
| [Inngest](https://www.inngest.com/docs/learn/how-functions-are-executed)                                                | • Event triggers, durable named steps, memoized results, waits, retries, and keyed concurrency/rate controls                                                                                                                                                                                                                                                                                                                                          | • SDK re-entry/step-discovery replay, whether served over HTTP or persistent connection, as the package's execution contract<br>• Managed-platform assumptions in plan semantics                                                                                                                                                                             |
| [n8n](https://docs.n8n.io/workflows/executions/all-executions/)                                                         | • Excellent node-catalog/editor feedback, credentials separated from node config, per-node failure choices, data previews, and retry from a stored workflow snapshot/data                                                                                                                                                                                                                                                                             | • Loose item arrays, name-based dynamic expressions, and unrestricted code nodes as typed contracts<br>• Treating a stored editor snapshot as proof of an exact handler deployment pin                                                                                                                                                                       |
| [Node-RED](https://nodered.org/docs/user-guide/concepts)                                                                | • Small node/wire/palette model, reusable subflows, inspectable messages, approachable live debugging, and Git-backed Projects for flow/dependency history                                                                                                                                                                                                                                                                                            | • Arbitrary mutable JavaScript messages, shared global context, and feedback wiring as durable orchestration semantics<br>• Treating a Project revision or live runtime deployment as an immutable per-run handler/build pin                                                                                                                                 |
| [Kestra](https://kestra.io/docs/workflow-components/flow)                                                               | • Portable declarative flows; explicit runnable versus flowable tasks; structured branch/loop/parallel nodes; typed inputs, retries, timeouts, and concurrency                                                                                                                                                                                                                                                                                        | • Plugin class strings/YAML and a platform expression language as the universal API<br>• Applying [latest-revision concurrency](https://kestra.io/docs/workflow-components/concurrency) to already-running executions                                                                                                                                        |
| [Windmill](https://www.windmill.dev/docs/openflow)                                                                      | • Portable OpenFlow-style structured modules, immutable deployment versions, reusable resources, suspend/approval, retries, and step testing                                                                                                                                                                                                                                                                                                          | • Unrestricted scripts and JavaScript expressions as the default data contract or policy boundary<br>• Platform job/resume endpoints as portable run identity                                                                                                                                                                                                |
| [AWS Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-cd-aliasing-versioning.html)         | • Declarative JSON state machines, immutable versions/aliases, callback tokens, [explicit immutable Standard/Express workflow types](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html), Standard history, isolated state testing, and documented redrive semantics                                                                                                                                                    | • Starting unqualified “latest”, importing product-mode guarantee differences without an explicit portable mode, or using AWS service ARNs/JSONPath as universal portable-IR semantics                                                                                                                                                                       |
| [Camunda 8 / Zeebe](https://docs.camunda.io/docs/components/best-practices/operations/versioning-process-definitions/)  | • Coexisting process versions, explicit jobs/incidents/human work, and transactional [instance migration](https://docs.camunda.io/docs/components/concepts/process-instance-migration/) with active-element mappings                                                                                                                                                                                                                                  | • Letting an unchanged job type route an old instance to newly deployed implementation behavior<br>• Unconstrained shared variables or operator modification as substitutes for typed, auditable repair                                                                                                                                                      |
| [Conductor](https://orkes.io/content/developer-guides/workflows)                                                        | • Portable JSON definitions, unique task-instance references, explicit worker/system/human tasks, lifecycle states, timeouts, retries, rate controls, and queue-domain isolation                                                                                                                                                                                                                                                                      | • Mutable shared [task definitions](https://orkes.io/content/developer-guides/tasks) changing live retry/timeout meaning<br>• Dynamic JSON expressions or “restart with latest” as implicit schema/version migration                                                                                                                                         |
| [Azure Durable Functions / Durable Task](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-hubs) | • Task hubs persist history and pending work, unload waits, and support fan-out/fan-in<br>• Permanent per-instance [orchestration versions](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-orchestration-versioning), buffered [external events](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-external-events) for existing runs, and explicit at-least-once/dedup guidance                          | • Source-code replay and version-conditional orchestrator logic as portable graph meaning<br>• Backend-private checkpoints that [cannot migrate between providers](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-storage-providers), provider-dependent duplicate semantics, or discarding signals sent before an instance exists |
| [Hatchet](https://docs.hatchet.run/v1/architecture-and-guarantees)                                                      | • PostgreSQL as source of truth, transactional state transitions, and an explicit at-least-once task contract<br>• Event-log checkpoints with [evictable waits](https://docs.hatchet.run/v1/task-eviction) that free worker slots, plus [static DAGs](https://docs.hatchet.run/v1/directed-acyclic-graphs) and controlled runtime [child fan-out](https://docs.hatchet.run/v1/child-spawning)                                                         | • Replaying ordinary durable-task source and “exactly-once” checkpoint language as portable semantics or an external-side-effect guarantee<br>• Assuming transactional state implies atomic optional-broker publication, or live worker registration implicitly pins a handler deployment                                                                    |
| [Trigger.dev](https://trigger.dev/docs/how-it-works)                                                                    | • Atomic [run/deployment version locking](https://trigger.dev/docs/versioning) for retries and waited children, plus [scoped idempotency](https://trigger.dev/docs/idempotency)<br>• Checkpointed [waits release concurrency](https://trigger.dev/docs/queue-concurrency); [callback tokens](https://trigger.dev/docs/wait-for-token) and [batch child fan-out](https://trigger.dev/docs/triggering) are explicit                                     | • CRIU process/memory images as semantic checkpoints or backend-portable history<br>• Delayed starts resolving a version only at execution, fire-and-forget children using latest, or TTL idempotency as durable graph identity                                                                                                                              |
| [Netflix Maestro](https://netflixtechblog.com/maestro-netflixs-workflow-orchestrator-ee13a06f9c78)                      | • Immutable versioned JSON workflow definitions and [per-instance workflow-version identity](https://github.com/Netflix/maestro/blob/main/maestro-common/src/main/java/com/netflix/maestro/models/instance/WorkflowInstance.java)<br>• First-class DAG, foreach (one child workflow instance per iteration), subworkflow, conditional, [signal-dependency](https://github.com/Netflix/maestro/blob/main/maestro-signal/README.md), and retry patterns | • Active/latest or default subworkflow resolution where exact pins are required<br>• Cyclic root graphs, server-side SEL/code injection, runtime parameter/state mutation, or boundary-free “exactly once” signals in the portable core                                                                                                                      |

The resulting design combines durable-execution discipline with declarative
builder ergonomics: Temporal/Restate-style history, DBOS-style honesty about
transaction boundaries, Argo/Airflow-style DAG admission, Dagster-style typed
resources, and Kestra/Windmill-style structured control flow.
Camunda's migration constraints reinforce explicit state mappings, while
Conductor's mutable task catalog reinforces pinning semantic policy in each run
instead of resolving it from a live global definition.
Azure Durable Task adds persisted-work and duplicate-signal discipline; Hatchet
keeps worker redelivery and idle-wait capacity explicit; Trigger.dev separates
deployment locking from process-image checkpoint portability; and Maestro shows
versioned JSON and structured fan-out at scale while illustrating why “latest,”
root cycles, and runtime expressions stay outside the portable core.

The comparisons above imply concrete implementation invariants:

- **Version pins:** a run records the exact plan revision, compiled fingerprint,
  compiler semantic version, node definitions, handler deployment, and child
  workflow versions. “Latest” may be resolved before atomic start admission but
  is never re-resolved for a queued, running, retried, or resumed run.
- **Signals:** acceptance first writes a bounded durable inbox and deduplicates a
  caller-supplied signal ID. Signal transport is at least once; committed inbox
  order selects exactly one semantic consumption. Start plus first signal is one
  transaction or uses a durable pre-run inbox.
- **Transactions:** the selected durable backend records an admitted semantic
  occurrence before its external side effect can run. In the native adapter,
  stable `Activity`/deferred/clock/child identities and the `WorkflowEngine`
  journal provide that boundary; the Builder does not mirror it into a competing
  execution journal. A non-native adapter must prove equivalent persist-before-
  execute behavior. Neither transactional state nor a checkpoint upgrades
  external I/O to exactly once.
- **Workers:** activity delivery is at least once. Lease redelivery keeps the
  logical activity and idempotency key stable, gives each attempt a distinct
  identity, and fences late or duplicate completions.
- **Wait capacity:** a persisted wait releases worker/activity concurrency, but
  still consumes explicitly limited inbox, timer, history, storage, resume-queue,
  and per-tenant waiting-run capacity.
- **Portable semantic export:** versioned semantic facts, exact artifacts,
  encoded values, and integrity-checked blob references form the portable
  quiescent export. A running native execution is recovered by its
  `WorkflowEngine`; provider-private rows and warm memory do not become portable
  meaning. Moving a live run to another backend requires an explicit cutover
  protocol and is not implied by deterministic replay.
- **Graph growth:** portable format `1` keeps an admitted DAG and represents
  loops, branches, and parallel regions through structured nodes. The distinct
  BPMN semantic IR admits bounded arbitrary cycles and therefore executes a
  token marking rather than a topological cursor. In both formats, dynamic
  fan-out records or content-addresses the item set and order before spawning
  bounded children with stable item keys, child IDs, paging, and concurrency,
  so completion timing cannot change graph identity.

Semantic replay portability does not by itself provide live backend migration.
A quiesced export/import or authority cutover additionally needs one consistent
manifest covering the history head, artifacts, blobs, request receipts, pending
outbox work, active attempt identities, timers, accepted signals, child links,
and the rule for reconstructing or invalidating adapter-private leases and
capabilities. Until that protocol and its split-brain tests exist, another
adapter may rebuild semantic state from a completed or quiesced export but may
not claim transparent hot cutover of a live run.

### Remaining prior-art lessons converted into release work

The comparison also exposes work that prose alone does not satisfy:

| Priority    | Required product boundary                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 core     | Executable transition tables and conformance tests for retry exhaustion, timeout provenance, cancellation races, overload outcomes, callback/job completion, incidents, child close policy, and Continue-As-New carry/signal/child behavior.                                                                  |
| P0 runtime  | Thin native Effect Workflow adapter and cross-process conformance suite; stable occurrence-to-activity/deferred/clock/child mappings; authenticated worker-build registration; bounded domain projections; tenant isolation; backup/restore of the selected engine; and explicit authority-cutover manifests. |
| P1 core     | Durable schedules and event triggers with timezone/DST, catchup, overlap, backfill, correlation, deduplication, batching, and debounce; typed active-instance migration; query/update consistency; search attributes; and narrow application-transaction integration.                                         |
| P1 runtime  | Pinned semantic placement requirements separated from mutable worker capacity, archival/rehydration and artifact reachability, incident/batch repair, pause/drain/SLA behavior, and operator visibility.                                                                                                      |
| P1 patterns | Expand every Workflow Patterns family into atomic stable requirements with a design target and evidence status; prioritize control-flow gaps, TP1–TP10, human/resource patterns, service correlation, flexibility/change, and WAP1–WAP7 against business-use profiles.                                        |
| P2          | Optional cross-run caching and materialization lineage, connector/credential catalogs, editor/debugging support, and platform-specific CPU/RAM/GPU/container controls. These remain adapters or explicit extensions unless they change portable semantics.                                                    |

### Production release commitments

The following capabilities are release requirements for a serious workflow
engine, not optional canvas features. A capability is not considered supported
until its portable semantics, durable authority boundary, operator behavior, and
conformance evidence all exist. Adapters may differ operationally, but may not
silently weaken these meanings.

| Capability                        | Required engine semantics and release evidence                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standards and BPMN                | Versioned BPMN 2.0.2 XML import/export against the normative XSDs; typed token/scoping semantics; explicit modeling, execution, and extension profiles; loss reports; Workflow Patterns traceability; round-trip, marking, soundness, and scheduler-permutation suites. No conformance claim before every applicable normative requirement passes. |
| Conditional branching             | Structured `If`, `Switch`, and ordered rule regions with one recorded selection, an explicit default/no-match policy, typed branch outputs, and replay tests proving that timing cannot change the selected path.                                                                                                                                  |
| Loops and dynamic fan-out         | Bounded `ForEach`, `Map`, `Reduce`, and loop regions whose item set/order or content digest is committed before expansion; stable item identities, paging, concurrency, aggregation, and per-item failure policy; duplicate/reordered/crash tests.                                                                                                 |
| Subworkflows                      | Exactly pinned child artifacts, stable parent-child identities, input/output contracts, close and cancellation policies, child status projection, recursion/depth limits, and parent/child crash and race conformance.                                                                                                                             |
| Durable persistence               | An application-provided durable `WorkflowEngine` layer with artifact-versioned handlers, stable replay identities, empty-cache restart, backup/restore, corruption detection, crash injection, and failover tests. Builder domain projections remain rebuildable and never fork the native execution authority.                                    |
| Timers and waiting                | Durable delay, absolute-deadline, schedule, cron, signal, callback, and predicate waits; canonical committed deadlines, timezone/DST/catchup/overlap policy, evictable wait capacity, and restart/clock-skew/race tests.                                                                                                                           |
| External events and signals       | Authenticated, schema-decoded, bounded, durable inbox admission with caller idempotency, same-ID/different-content conflict, correlation, TTL, exactly one semantic consumption, receipts, and arrival-before-wait tests.                                                                                                                          |
| Human tasks                       | Versioned task definitions and created/claim/release/complete/reject/expire/escalate facts; assignments, groups, forms, delegation, quorum, separation of duties, deadlines, revocable capabilities, and audited race tests.                                                                                                                       |
| Retry semantics                   | Pinned classifier and policy, checked retry budgets, deterministic backoff/jitter choice, non-retryable failures, exhaustion, poison/dead-letter behavior, and exact anchor/deadline replay tests.                                                                                                                                                 |
| Timeouts and cancellation         | Independent run, step, queue, execution, and schedule timeout dimensions; cooperative cancellation with propagation and close policy; fenced late results and explicit cancel-versus-complete race tables.                                                                                                                                         |
| Failure branches                  | Typed success, business-failure, defect, timeout, cancellation, and policy/overload exits with explicit structured regions and join behavior; no magic exception edges or status mutation.                                                                                                                                                         |
| Compensation transactions         | Explicit Saga scopes, recorded compensation registration/order, idempotency identities, retry/failure/escalation policy, nested scopes, and crash tests for every forward/compensating boundary; no general exactly-once claim.                                                                                                                    |
| Data mapping and expressions      | Versioned, deterministic, resource-bounded expression and mapping definitions over typed encoded values; explicit missing/null/error behavior, static reference validation, sandboxed evaluation, and golden compatibility/fuzz tests.                                                                                                             |
| Runtime policy engine             | Pinned policy identifiers/build digests with trusted actor and resource context at start, signal, human, dispatch, secret, retry, migration, and repair boundaries; fail-closed decisions with nonsecret attribution and policy-upgrade tests.                                                                                                     |
| Triggers                          | Idempotent manual, HTTP, event, queue, schedule, and database-change adapters normalized through a versioned trigger-admission contract with schema/auth/dedup/correlation/backpressure rules and start-plus-event atomicity.                                                                                                                      |
| Concurrency controls              | Separate run/activity/wait capacity, rate limits, queues, priorities, tenant/key quotas, fairness, starvation policy, resource placement, atomic permit accounting, and overload/backpressure conformance.                                                                                                                                         |
| Worker distribution               | Authenticated build registration, exact pinned routing, leases, heartbeats, visibility renewal, fencing, drain/retirement, failover, locality/region constraints, and duplicate/stale/split-brain worker tests.                                                                                                                                    |
| Workflow versioning and migration | Independent plan, definition, node, compiler, artifact, handler, protocol, event, snapshot, and storage versions; side-by-side old execution, deterministic upcasters, typed active-instance mappings, rollback, and compatibility-removal audit.                                                                                                  |
| Operational controls              | Authorized pause, resume, cancel, retry, skip, redrive, fork, rerun-from-step, drain, and manual repair as explicit commands/facts with preconditions and effect-safety manifests; never in-place history editing.                                                                                                                                 |
| Observability                     | Sequence-aware execution timeline, per-node structured logs, metrics, traces, queue/wait timing, redacted inputs/outputs, derived failure explanations, telemetry correlation, search/read models, alerts, and stuck-run diagnostics.                                                                                                              |
| Auditability                      | Immutable actor/policy/causation-attributed semantic and administrative history; bounded security/ingress audit for rejected hostile traffic; integrity verification, retention/export, and tamper/cross-tenant tests.                                                                                                                             |
| Secrets and credentials           | Plans contain only typed references; runtime resolution uses capability-scoped services with access policy, version/rotation behavior, redaction, encryption, tenant isolation, audit attribution, and no secret material in history/logs/errors.                                                                                                  |
| Testing and simulation            | Mock activity/clock/broker/policy/secret services, dry-run admission and decision previews, deterministic full replay, breakpoints/step debugging, fixtures, fault injection, property/model tests, and backend conformance suites.                                                                                                                |

### Consequences for retries, time, and interaction

The current event and command format version `1` deliberately models one
activity attempt and has no timer or signal vocabulary. Durable retries, timers,
and signals will use an explicit later format rather than adding optional fields
whose absence would make old histories ambiguous.

The identity model for that format separates semantic retry from operational
redelivery:

| Identity                         | Stable across                                                               | Changes when                                                       |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Logical activity                 | Policy retries, worker restarts, broker duplicates, and lease expiry        | A new admitted node instance is created                            |
| External idempotency key         | Policy retries and delivery retries by default                              | An explicitly admitted business operation requires a different key |
| Activity attempt                 | Lease renewal, worker restart, and redelivery of the same scheduled attempt | The decision engine commits a logical retry                        |
| Delivery epoch / fencing token   | Nothing; it identifies one operational ownership generation                 | A lease is first acquired or stolen after expiry                   |
| Timer, signal, wait, and command | Physical delivery retries of the same already-committed semantic intent     | A new semantic timer, signal, wait, or command is admitted         |

A minimal future semantic vocabulary therefore needs activity-attempt
scheduled/started/failed/timed-out facts; an explicit retry-scheduled fact;
timer scheduled/fired/cancelled facts; and signal accepted/consumed facts.
Worker lease rows, heartbeat observations, broker delivery identifiers, and
relay acknowledgements remain operational state unless they cause one of those
semantic transitions.

The following rules are release invariants:

- Retry policy, failure-classifier version, handler/codec/deployment pins,
  timeout policy, and routing policy are immutable admitted data. Mutable code
  predicates do not decide whether an old attempt retries.
- Backoff and jitter may be calculated deterministically, but the selected delay
  and absolute deadline are committed once. Replay consumes the recorded choice
  instead of reading the wall clock or drawing randomness again.
- A retry-backoff deadline is anchored to the exact failed or timed-out attempt
  event, not to a later coordinator wake or decision timestamp. Coordinator
  latency therefore cannot silently extend policy backoff. The timer command,
  retry fact, and timer fact all identify the same committed anchor.
- A signal is authorized, strict-decoded, size checked, deduplicated by a
  caller-supplied ID, assigned a monotonic inbox sequence, and durably accepted
  in one transaction. Consumption records which accepted signal satisfied which
  wait; arrival before the wait remains eligible.
- Signal count, pending bytes, item size, TTL, and waiting-run capacity are
  pinned and bounded. Overflow, expiry, unauthorized admission, and dead-letter
  behavior are explicit outcomes rather than silent dropping.
- Event sequence and optimistic commit order decide cancellation, timeout,
  signal, and completion races. Once cancellation is requested, no new activity
  attempt, retry, or signal consumption is admitted; cancellation remains
  cooperative and does not claim that an external side effect stopped.
- A duplicate accepted result returns its original receipt. A stale-fence,
  timed-out, cancelled, superseded-attempt, or post-terminal completion creates
  no semantic event and cannot feed downstream nodes. A backend may retain an
  operational late-completion audit containing identities, reason, and payload
  digest.

Timer storage is deliberately narrower than timer semantics. Scheduling and
cancellation occur only inside the authoritative transactions that materialize
decision commands into history; a timer adapter exposes bounded due claims,
lease renewal or release, and a fenced fire operation. Firing reloads the latest
run head, verifies authoritative store time against the one committed deadline,
checks that the owner is still live, appends the canonical `TimerFired`, updates
the timer row, invalidates its lease, and wakes the run atomically. It never
accepts a caller-supplied deadline or expected history head.

Protocol version `2` semantic timestamps are canonical UTC strings at whole
millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Adapters normalize their
database clock before commit. Numeric-offset aliases and sub-millisecond text
are rejected instead of being silently normalized or truncated, matching the
whole-millisecond timeout and backoff units.

Owner creation and its required timer mutations are one transaction boundary:
activity scheduling creates schedule-to-start and schedule-to-close timers;
attempt start cancels schedule-to-start and creates start-to-close; attempt
completion cancels live attempt timers; retry admission creates its backoff
timer; and signal acceptance, signal-wait start, and sleep start create their
respective timers. For attempt timeout, the fire transaction should append
`TimerFired` and its attributed `ActivityAttemptTimedOut` consequence together.
This removes a crash window in which a later worker result or second timer could
interleave before the winning timeout was materialized. Every terminal event
requires all remaining timers to have been resolved earlier in the same batch.

These choices adopt Temporal's distinction between a logical activity and its
physical task deliveries, Azure Durable Task's durable timers and event
buffering, Restate's persist-before-suspend rule, Step Functions' explicit retry
and jitter configuration, and Camunda's distinction between job redelivery and
logical retry. They reject unlimited implicit retry defaults, worker-controlled
retry counters, provider-private time/checkpoint meaning, and redrive that
silently resets retry identity inside the same run.

## Chosen architecture

```text
unknown JSON
    |
    v  Schema decode / format migration
portable versioned Plan + exact Workflow.Definition
    |
    v  Compiler admission + canonical fingerprint
immutable CompiledPlan
    |
    v
fold(history) -> RunState -> decide(compiled plan, state) -> Commands
      ^                                                   |
      |                                                   v
      +---- committed Events <- backend <- activities / timers / signals
```

The compiler and semantic core must be deterministic for the same canonical
plan, definition set, and ordered history. Wall clock, randomness, network I/O,
secret lookup, and handler execution are backend/activity inputs whose chosen
results are recorded; they are never consulted by the pure fold or decision
function.

### 1. Admission and pinning

1. Decode unknown JSON using the plan format's strict `Schema`. If an older wire
   format is supported, apply pure, sequential format migrations first.
2. Resolve the exact `Workflow.Definition` named by `definition.id@version` and
   all exact node `type@version` values. No “latest compatible” lookup occurs.
3. Run `Compiler.compile`, including application link authorization and limits.
4. Canonicalize the semantic plan (excluding presentation-only metadata where
   explicitly specified) and compute a content fingerprint together with the
   compiler semantic version.
5. Before starting work, persist the immutable plan snapshot or content-addressed
   reference, its revision, definition/node pins, compiler version, fingerprint,
   encoded workflow input, and selected backend kind. A durable backend commits
   this pin atomically with `RunStarted`.

Run ingress has two identities. `runId` names one execution attempt; a reusable
business/workflow identity names the logical operation. Start also accepts a
client-generated request ID. `(tenantId, workflowIdentity, requestId)` is unique
for a declared retention window. Repeating it with the same encoded input and pin
digest returns the original run handle; reusing it with different input or pins
is an identity conflict. Implementations that accept a first signal at creation
must commit start and signal acceptance atomically, or use a durable pre-run inbox
so a signal cannot disappear between identity reservation and run creation. This
follows the explicit workflow-ID boundaries in
[DBOS](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) and
[Restate](https://docs.restate.dev/foundations/services), rather than overloading
a mutable editor name or a retry attempt ID.

Compilation can be repeated for validation, but a running execution uses its
pinned compiled meaning. An absent definition, handler, codec, or migration is a
hard compatibility failure; it must not be replaced silently.

A durable start needs two distinct content identities. The compiled fingerprint
identifies the portable plan, compiler semantic version, and derived topology.
An artifact digest additionally covers the exact workflow-definition build,
handler deployment/build pins, and per-node queue/routing pins. A reusable
strict artifact contains the canonical fingerprint document and those pins, but
never run input, tenant data, credentials, timestamps, or mutable capacity.

`startDurable` will atomically store or verify that artifact, create an immutable
tenant-scoped run-to-artifact binding, materialize `RunStarted`, and create the
history head. Artifact insertion is not a public operation that can be composed
before run creation. Every durable database key includes a mandatory nonempty
tenant/scope even if an application configures only one stable tenant. Current
event format version `1` can remain unchanged while the binding is required
alongside exported history; a future event version must carry the artifact
reference if a history is expected to be independently portable without that
binding.

After restart, recovery loads the binding and artifact, verifies both content
digests, resolves the exact pinned definition/deployment bundle, reconstructs
and fingerprints the compiled plan, validates every route, and only then makes a
decision. The current `type@version` handler registry is not by itself a durable
deployment pin; missing old code is a typed compatibility failure, never a
request to use the live `latest` implementation.

### 2. Semantic event/history state machine

The planned semantic core has three separable operations:

- `fold(history) -> RunState` is pure, total for admitted histories, and unaware
  of storage or workers.
- `decide(compiledPlan, state) -> readonly Command[]` is pure and emits stable,
  idempotent commands such as schedule activity, set timer, consume signal, or
  complete run.
- `commit(expectedSequence, events, outbox)` atomically appends the facts caused
  by accepted commands and, for a durable backend, their dispatch intent.

Read models, UI status, and queries derive from history/snapshots; they are not a
second authority. Snapshots are disposable acceleration structures containing a
history sequence and state-schema version. Deleting a snapshot must only affect
performance.

Concurrent completions are serialized by expected history sequence (or an
equivalent single-writer/fencing rule). Re-evaluating after a conflict is normal.
The committed event order, not network arrival order, determines semantics.
Compiled stages provide stable ordering and visualization, not implicit global
barriers: a node becomes ready when its own admitted dependencies are satisfied.

#### Run chains and history rollover

Long-lived behavior cannot rely on snapshots alone because snapshots do not
bound authoritative history. When configured limits approach, the state machine
may commit `RunContinuedAsNew` and atomically start a successor with a new
`runId`, stable `runChainId`, predecessor run/sequence/digest, encoded carry
state, and explicit policies for pending signals and child runs. Prior history is
never edited or discarded as part of rollover. Query, cancellation, business-ID
resolution, retention, and authorization APIs state explicitly whether they
target one run or follow the chain head. This takes the bounded-history lesson
from Temporal's
[Continue-As-New](https://docs.temporal.io/workflow-execution/continue-as-new)
without importing source-code replay into the IR.

### 3. Activities and Effect integration

A normal executable node becomes an activity command. Its stable logical
activity ID is derived from the run ID and structured node-instance ID. The
default external idempotency key is stable across delivery and retry attempts;
attempt identity never enters it implicitly. A business operation that must be
new on a later attempt uses a separately named explicit operation key.

At the worker boundary the runtime will:

1. Resolve the pinned `Node.Definition` and `Registry.HandlerRegistry` entry.
2. Decode the immutable pinned JSON configuration afresh for the activity and
   decode assembled inputs with their `Schema` values. A decoded config object
   is never cached in the compiled plan or shared with a later invocation.
3. Merge the handler's captured `Context` with explicitly allowed per-run
   services and provide `Node.HandlerContext`.
4. Execute the handler `Effect` under backend-provided timeout, interruption,
   retry, tracing, and resource policy.
5. Encode outputs or typed failure, then detach and recursively freeze the
   strict-JSON representation before committing a result event. Schema defects
   or a codec that emits a non-JSON runtime value are infrastructure/
   compatibility failures, not valid node failures.

Timeouts are not one undifferentiated number. Activity policy independently
defines schedule-to-start (queue wait), start-to-close (one attempt),
schedule-to-close (the total retry budget), and heartbeat/liveness timeouts.
Logical activity facts and attempt facts remain distinct. A completion carries
the current attempt identity and lease/fencing token, so an abandoned or retried
attempt cannot commit after ownership changes. Heartbeats are operational unless
their checkpoint changes retry behavior; a selected retry checkpoint is then a
committed semantic value or immutable referenced value. Cancellation delivered
through interruption or heartbeat remains cooperative and never proves that a
remote side effect stopped. See Temporal's
[activity failure-detection model](https://docs.temporal.io/encyclopedia/detecting-activity-failures).

`Schema` is required for future workflow inputs/outputs, node inputs/outputs,
failures, signal payloads, event payloads, and stored references. Every schema at
a portable payload boundary must expose a JSON-compatible encoded type, and the
runtime still validates the concrete encoded value because a custom codec can
violate its TypeScript declaration. An in-process annotation or `Context` is
never serialized implicitly.

Planned runtime capabilities will be narrow `Context.Service` interfaces such as
`PlanStore`, `HistoryStore`, `SignalInbox`, `ActivityDispatcher`, `DurableClock`,
`BlobStore`, `LeaseManager`, and `RunBackend`, each supplied by a `Layer`. The
names may evolve; the boundary will not: business handlers depend on application
capabilities, while orchestration depends on runtime capabilities. An Effect
Workflow adapter may implement the durable services using
`effect/unstable/workflow` workflows, activities, clocks, or deferreds without
leaking those types into `Plan`.

### 4. Explicit direct and durable backends

| Property       | Direct backend (implemented v1 slice)                          | Durable backend (planned)                                      |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Selection      | Explicit at run/start configuration                            | Explicit at run/start configuration                            |
| State/history  | In-memory, process-local semantic history                      | Transactional append-only history plus snapshots/read models   |
| Dispatch       | Local Effect fibers                                            | Durable outbox/queue with leases and fencing                   |
| Timers/signals | Process-local; lost on process exit                            | Persisted timers and inbox; resume after process exit          |
| Recovery       | None                                                           | Replay from committed history after crash or relocation        |
| Scaling        | One process                                                    | Multiple orchestrators/workers subject to single-writer rules  |
| Intended use   | Unit/integration tests, development, short request-scoped work | Long-lived, interactive, or production work requiring recovery |

Both backends run the same fold/decision conformance suite and produce the same
semantic events for the same accepted inputs. Operational events may differ. The
direct backend must advertise that a process crash loses progress; the durable
backend must refuse to start if its persistence/dispatch requirements are not
available. There is no implicit fallback from durable to direct.

### 5. Structured control nodes, not root cycles

Format version `1` currently represents ordinary nodes plus data/control edges,
and `Compiler` rejects every root cycle. Future control-flow support will extend
the IR rather than weakening that invariant.

Planned structured nodes include `Switch`/`If`, `Parallel`, `ForEach`, bounded
`While`/`Repeat`, `Try`/`Catch`/`Finally`, `WaitForSignal`, `Sleep`, and
`Subworkflow`. Each owns named nested regions or references a pinned child plan.
Each nested region is itself acyclic, and recursive subworkflow references are
rejected or bounded by an explicit policy.

Protocol version `2` remains a closed child-free vocabulary. Durable child
execution is introduced through a separate version `3` artifact, binding,
event, command, identity, reducer, decision, and authority family so older
histories cannot be silently reinterpreted. BPMN `calledElement` remains source
syntax: admission resolves its expanded QName to an exact child artifact,
contracts, deployment, close policy, and lineage bound before execution.

The parent-child relation is itself an authoritative sequenced stream. A
persistent implementation must compare-and-set `(tenantId, parentRunId,
callId)` and atomically mutate every record named by one relation transition:

- scheduling commits the parent fact, immutable relation and start outbox
  together;
- accepting a start creates the exact pinned child run, consumes the start
  intent, marks the relation running and enqueues the parent projection in one
  transaction;
- cancellation before start terminally suppresses the start intent in the same
  transaction, so a delayed relay cannot create the child afterward;
- live cancellation commits the relation fact and cancellation outbox
  together, while abandonment detaches without asserting that the child
  stopped; and
- a child terminal projection is deduplicated by its source event identity and
  cannot be accepted after the relation was abandoned.

Two independently atomic parent and child stores do not satisfy this boundary:
they permit start-versus-cancel split brain and cross-run partial commits. The
process-local reference authority therefore uses one state owner, while a
persistent adapter must provide an equivalent database transaction or an
explicitly proven coordination protocol. `CancelAndWait` additionally gates the
parent terminal fact until the child terminal projection commits;
`RequestCancel` gates only on durable cancellation intent; `Abandon` makes no
stopping claim.

- Branch selection is recorded before scheduling the chosen region.
- Iteration/fan-out input and order are recorded or content-addressed. Child
  instance IDs derive from the control node plus a stable item key/index.
- Large expansion is paged or streamed rather than materialized into one
  history event. Nested aggregate item limits, duplicate-key policy, active-item
  concurrency, per-item failure threshold/collection policy, and deterministic
  reduction order are explicit and pinned.
- Loops declare maximum iterations, wall duration, history growth, and parallel
  width; admission/runtime policy can lower those bounds.
- Parallel joins declare all/any/quorum and failure/cancellation behavior.
- Parent close and parallel-loser policy is one of `WAIT`, `REQUEST_CANCEL`,
  `ABANDON`, or privileged administrative `TERMINATE`; parent completion states
  whether child acknowledgement is required.
- Error and compensation regions are explicit semantics, not magic edges.
  Compensation registers only after the corresponding forward success commits,
  runs in reverse committed-completion order, has stable identity/retry/timeout/
  idempotency policy, and is shielded from ordinary cancellation within a
  bounded cleanup deadline. Compensation failures are aggregated into a manual-
  intervention state without erasing the original failure.
- A wait consumes a declared signal schema from the inbox; it does not install an
  ephemeral callback.

This provides the useful expressiveness of visual feedback loops without making
termination, resource use, replay, or authorization unknowable.

### 6. Durable signal inbox

Signals are commands from outside the run, not direct calls into a waiting fiber.

- A signal definition has a stable name/version and payload `Schema`, plus
  authorization and size/retention policy.
- The client supplies a stable `signalId`. Acceptance decodes and authorizes the
  payload, then deduplicates on `(tenant, runId, signalId)` and assigns a
  monotonic inbox sequence.
- Acceptance persists the encoded payload or blob reference even when the run is
  not currently waiting. Signals therefore cannot be lost in the “arrived before
  wait” race.
- The state machine selects matching, unconsumed signals in committed inbox order
  (with an explicit correlation key where declared) and atomically records
  `SignalConsumed` with the semantic transition.
- Duplicate delivery returns the original acceptance result. Unknown signal
  types, unauthorized senders, terminal runs, expired signals, and overflow are
  explicit rejected/audited outcomes.
- Per-run count/bytes, per-signal TTL, and overflow/dead-letter behavior are
  mandatory durable-backend policy.

Workflow messages have three distinct acknowledgement contracts, following the
useful separation in Temporal's
[message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing/):

- a query is read-only and does not mutate history;
- a signal is an asynchronously accepted write and does not imply a business
  result; and
- a tracked update is an idempotent write with durable accepted, rejected, and
  completed outcomes.

Human work is not modeled as an unstructured signal. A planned `HumanTask`
control node records created, claimed, released, completed, rejected, expired,
and escalated facts. Its definition pins assignee/group policy, unique-principal
quorum, separation of duties and self-approval restrictions, claim lease,
reassignment, deadline/escalation, and duplicate-decision behavior. Resume
capabilities are tenant/run/task bound, single-use, revocable, expiring, hashed
at rest, and audited. The relevant lessons are visible in
[Windmill approvals](https://www.windmill.dev/docs/flows/flow_approval) and AWS
[callback tasks](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html),
without making either platform's token format part of the portable IR.

### 7. Event vocabulary

Every semantic event will use a versioned envelope containing at least `eventId`,
`eventVersion`, `runId`, monotonically increasing `sequence`, backend-assigned
`recordedAt`, actor/tenant attribution where applicable, and causation/correlation
IDs. Payloads are schema encoded. Timestamps affect decisions only when the
relevant instant was itself committed, for example in `TimerScheduled`.

The initial semantic vocabulary should remain small:

| Area               | Facts                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                | `RunStarted`, `RunCancellationRequested`, `RunContinuedAsNew`, `RunSucceeded`, `RunFailed`, `RunCancelled`                                                                                     |
| Activity           | `ActivityScheduled`, `ActivityAttemptStarted`, `ActivityAttemptFailed`, `ActivityAttemptTimedOut`, `ActivitySucceeded`, `ActivityFailed`, `ActivityCancellationRequested`, `ActivityCancelled` |
| Retry/time         | `RetryScheduled`, `TimerScheduled`, `TimerFired`                                                                                                                                               |
| Interaction        | `SignalAccepted`, `SignalConsumed`, tracked-update lifecycle facts, and `SignalRejected` where rejection belongs in run history                                                                |
| Human work         | `HumanTaskCreated`, `HumanTaskClaimed`, `HumanTaskReleased`, `HumanTaskCompleted`, `HumanTaskRejected`, `HumanTaskExpired`, `HumanTaskEscalated`                                               |
| Structured control | `BranchSelected`, `FanOutExpanded`, `IterationStarted`, `IterationCompleted`, `RegionCompleted`                                                                                                |
| Child runs         | `ChildRunScheduled`, `ChildRunCompleted`, `ChildRunFailed`, `ChildRunCancellationRequested`                                                                                                    |

Readiness, stage completion, aggregate progress, and current status are normally
derived state, not events. Logs, traces, heartbeats, lease renewals, and worker
resource measurements belong in an operational telemetry stream unless a value
changes a semantic decision. This prevents history from becoming an accidental
log sink.

### 8. Delivery and failure semantics

- **History commits:** exactly one semantic append per stable event/command key,
  enforced by uniqueness plus expected sequence. This is a storage guarantee, not
  an external side-effect guarantee.
- **Activity delivery:** at least once. A worker may complete an external action
  and crash before its result is committed, so the activity may be delivered
  again.
- **External effects:** handlers must use the supplied stable idempotency key,
  destination deduplication, or an application transaction/outbox. If an
  application write and checkpoint share a transaction, a DBOS-like exactly-once
  transaction can be offered narrowly and named as such.
- **Signals:** at-least-once transport, deduplicated acceptance, and exactly one
  semantic consumption per accepted signal ID.
- **Retries:** policy is pinned at scheduling. Backoff deadlines and any jitter
  choice are committed so recovery does not redraw randomness.
- **Cancellation/timeouts:** cooperative and race-aware. A timeout or cancel
  request does not prove that a remote side effect stopped. Late results have an
  explicit ignore/record policy, and stale attempts cannot commit without the
  current fencing token.
- **Current version `1` cancellation race:** once
  `RunCancellationRequested` is committed for a nonterminal run, cancellation
  wins over activity success or failure already visible to the decision pass.
  If a terminal run fact committed first, `RunState` rejects a later cancellation
  request. Richer late-result recording remains future vocabulary, not an
  implicit change to this rule.
- **Outputs:** a result is successful only after schema encoding and durable
  commit. Large values use immutable blob references with digest, size, media
  type, authorization scope, and retention metadata.
- **Queries:** may use eventually consistent read models but expose their history
  sequence. Start, signal, cancel, and other mutations acknowledge only the
  authoritative commit.

### 9. Dispatch queues and operational policy

Semantic scheduling and physical dispatch are different decisions. An activity
pins its queue/routing key, semantic priority if any, and relevant delivery
policy. The backend defines FIFO tie-breaking, aging/starvation prevention,
per-tenant and per-key concurrency, rate limits distinct from concurrency limits,
partition ordering, backlog admission, and poison/dead-letter handling. Waiting
work consumes neither activity concurrency nor a run compute slot. Durable queue
admission and `ActivityScheduled` share one history/outbox transaction.

Broker settlement must preserve that at-least-once boundary. A consumer does
not acknowledge a message merely because it acquired the storage lease: it
either keeps and renews broker visibility until the fenced completion or
suppression receipt is durable, or the adapter supplies an independently
durable scanner that republishes abandoned authoritative attempts. Busy work is
delayed or nacked; malformed or permanently pin-incompatible work follows an
audited poison/dead-letter policy; transient store failures remain retryable.
Acknowledging before either recovery path exists can lose the only physical
delivery after the outbox has already been marked published.

Mutable capacity may change when and where work runs, but never what a live run
means. Worker count, fair-share weights, and an authorized tenant quota can delay
dispatch; they cannot silently change retries, timeouts, joins, failure behavior,
or the pinned plan. DBOS documents useful
[queue primitives](https://docs.dbos.dev/typescript/reference/queues), while
Argo's [synchronization queues](https://argo-workflows.readthedocs.io/en/latest/synchronization/)
show why ordering and multi-lock head-of-line behavior must be specified rather
than left to incidental worker timing.

## Versions and migrations

Version dimensions remain independent because they answer different questions.

| Dimension                             | Current/planned meaning                                                                        | Migration rule                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Plan `formatVersion`                  | JSON wire shape; currently literal `1`                                                         | Pure adjacent upcasters before current decode; retain original bytes/digest for audit        |
| Plan `revision`                       | Immutable edit/snapshot revision for one plan ID; currently a non-negative integer             | A semantic edit creates a new revision; live runs stay pinned                                |
| Workflow definition `id@version`      | Allowed vocabulary, boundary ports, limits, and link policy                                    | Register old and new definitions side by side; never resolve “latest” for a run              |
| Node `type@version`                   | Config/port/failure contract and handler behavior                                              | Incompatible behavior or schemas require a new version and explicit config/data migration    |
| Port contract                         | Application-owned link compatibility identity plus payload `Schema`                            | Contract changes are explicit; matching strings never waive runtime schema encoding/decoding |
| Compiler semantic version/fingerprint | Meaning of admission, topology, control lowering, and canonical compiled plan                  | Pin per run; replay verifies the fingerprint; recompile/migrate into a new plan revision     |
| Handler deployment/build revision     | Exact deployed implementation for otherwise compatible node versions                           | Route old runs to compatible workers or prove replay compatibility before retirement         |
| Execution protocol version            | Complete reducer, decision, command, event, timer, signal, and race semantics selected per run | Required artifact/binding/start pin; never inferred or switched in place from missing fields |
| Event envelope/payload version        | Durable fact schema                                                                            | Pure event upcasters on read; never rewrite history in place as the only migration strategy  |
| Snapshot/state version                | Cached fold representation                                                                     | Discard/rebuild or migrate from its recorded history sequence                                |
| Backend storage schema                | Tables, indexes, blobs, queues, leases                                                         | Expand/migrate/contract with rolling-version compatibility and backup/restore proof          |

Plan format migration only changes representation. Changing workflow meaning is a
new plan revision and usually a new definition or node version. Event upcasters
must be deterministic, side-effect free, transitively tested from every supported
version, and able to rebuild state without current wall time or external services.
Compatibility code can be removed only after retention policy proves that no live
run, retry, replay, or retained history requires it.

## Resume, redrive, fork, and repair

Administrative recovery never edits committed history. Resume continues the
same pinned run only from its current legal state. Redrive declares whether
retry counters, deadlines, signals, successful branches, and child state are
preserved or reset. Fork creates a new run and records source run/sequence,
operator and reason, selected plan/build pins, plus an explicit manifest of
reused outputs. Reusing a successful result requires schema and fingerprint
compatibility; it does not assert that repeating or skipping an external effect
is safe. These are separately authorized, fully audited operations, informed by
[DBOS fork](https://docs.dbos.dev/typescript/tutorials/workflow-management) and
AWS Step Functions
[redrive](https://docs.aws.amazon.com/step-functions/latest/dg/redrive-executions.html),
not a generic “set status” escape hatch.

## Security and resource policy

The portable plan, metadata, inputs, signals, and activity outputs are untrusted
data even when produced by an official editor.

### Admission controls

- Keep strict `Schema` decoding and excess-property rejection at every external
  boundary. Accumulate useful diagnostics without executing handlers.
- Preserve the existing explicit `LinkPolicy`, contract equality, port
  cardinality/fan-out, required connections, acyclic root topology, and
  workflow-specific node/edge/depth limits.
- Add allowlists for node and control types/versions, nested depth, dynamic
  expansion, retry budget, timers, subworkflows, and backend choice.
- Canonicalize and fingerprint the admitted plan; optionally require a trusted
  signature/approval before a durable production start.

### Runtime controls

- Bind an immutable `tenantId` into every run, event, inbox/outbox/blob/lease,
  queue key, idempotency namespace, and completion capability. A cross-tenant
  resource pool is allowed only as an explicit authorized policy; tenant/run/task
  identifiers and authorization scope are cryptographically bound into worker
  and human-task capabilities.
- Authorize start, read, signal, cancel, retry, migrate, and administrative repair
  separately, scoped by tenant/namespace and run. Record actor and policy decision
  identifiers without copying sensitive credentials into history.
- Plans contain credential/resource references only. A capability-scoped Layer
  resolves secrets at activity execution; secrets are never plan values, handler
  outputs, diagnostics, logs, or history by default.
- Enforce run/node concurrency, queue and tenant quotas, activity timeout, retry
  attempts/elapsed budget, loop/fan-out bounds, history event/byte limits, signal
  inbox limits/TTL, payload/blob sizes, retention, and downstream rate limits.
- Apply least-privilege network/filesystem/process capabilities to risky handlers.
  Sandbox/container isolation is a backend policy, not something the type system
  alone can guarantee.
- Encrypt transport and durable data, integrity-check blobs, redact schema-marked
  fields, and make PII retention/deletion behavior explicit. A history required
  for replay still needs a lawful deletion/crypto-shredding strategy.
- Use leases with fencing tokens for workers and orchestrators. A stale worker
  must be unable to commit after ownership changes.
- Apply fair-share/noisy-neighbor controls per tenant and ensure unauthorized
  reads, retries, and mutations do not become cross-tenant existence or timing
  oracles.

Resource rejection is a typed admission/runtime outcome, not an out-of-memory
strategy. Backpressure must stop new scheduling before a worker or history store
is exhausted.

## Planned modules and delivery phases

Names below describe intended responsibilities and may change before public API
stabilization.

| Phase                                           | Modules/responsibilities                                                                                                                                                                                                                                                                                                            | Exit gate                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Compiler foundation (implemented)            | `Plan`, `Port`, `Node`, `Registry`, `Workflow`, `LinkPolicy`, `Diagnostic`, `Compiler`                                                                                                                                                                                                                                              | Strict plan/config decode, aggregate semantic diagnostics, deterministic acyclic compile, API/type tests                                                                                   |
| 1. IR evolution (partial)                       | `Fingerprint` is implemented; `PlanMigration`, `Control`, nested-region compiler, resource analysis, and atomic Workflow Patterns catalogue expansion remain                                                                                                                                                                        | Golden wire migrations; canonical fingerprint fixtures; structured-control property tests; atomic pattern requirement/status mapping; old v1 plans remain accepted without changed meaning |
| 2. Semantic core and direct execution (partial) | Version `1` direct execution, process-local exact-generation cancellation delivery, protocol-v3 child relation contracts, and protocol-v2 process-local static-DAG decisions/retries/timers/signals are implemented; structured control, child authority execution, V2 cancellation integration, and complete BPMN execution remain | Golden replay tests; reducer/decision determinism; direct/backend parity; cancellation/retry/parallel/control conformance                                                                  |
| 3. Durable substrate (partial reference model)  | `DecisionCommit`, `ExecutionStore`, and `ExecutionAuthorityV2` specify strict atomic boundaries in memory; SQL persistence, shared execution/signal transactions, verified checkpoints/read models, cross-process timer and wake services, `BlobStore`, and `DurableBackend` remain                                                 | Crash injection at every commit/delivery boundary; duplicate/reordered delivery tests; multi-orchestrator fencing; restore and replay from empty caches                                    |
| 4. Effect Workflow and operations               | Optional Effect Workflow adapter, worker/client/query APIs, tracing/metrics, administrative inspection and repair tools                                                                                                                                                                                                             | Adapter passes the backend conformance suite; rolling-upgrade/replay tests; telemetry correlation and documented repair/runbooks                                                           |
| 5. Production hardening                         | Tenant policy, retention/redaction, quotas/backpressure, compatibility tooling, migration CLI/APIs                                                                                                                                                                                                                                  | Security review, malicious-plan fuzzing, load/soak/chaos tests, disaster recovery exercise, and support window documented                                                                  |

No phase should expose a public API that implies the next phase's guarantee. In
particular, a direct runner is not called durable, and an append-only store without
transactional dispatch, inboxes, timers, leases, and recovery tests is not a
durable backend.

## Production verification gates

Before durable production status, all of the following are release blockers:

- **Wire and compiler:** golden JSON fixtures for every supported format;
  encode/decode round trips; deterministic canonical fingerprints and schedules;
  fuzz/property tests for malformed endpoints, limits, authorization, contracts,
  ordering, paged/nested fan-out, duplicate item keys, per-item failure policy,
  deterministic reduction, and adversarial graph sizes.
- **Replay:** rebuild every golden history from sequence zero on every supported
  engine/event version; compare snapshots with full folds; run nondeterminism
  mutation tests; fail closed on missing pins/codecs/handlers.
- **Backend conformance:** the same scenario corpus against direct and every
  durable adapter, comparing semantic events and terminal outputs while allowing
  documented operational differences.
- **Authoring harness:** public single-node and control-state tests with mock
  activity results/failures, virtual time, a selected retry attempt, and
  inspection of routed inputs, outputs, and next commands. This powers fast
  editor feedback without claiming backend recovery coverage; AWS
  [TestState](https://docs.aws.amazon.com/step-functions/latest/dg/test-state-isolation.html)
  and Windmill [flow tests](https://www.windmill.dev/docs/flows/test_flows) show
  the value of this separate layer.
- **Failure injection:** process death before/after each history, outbox, inbox,
  timer, blob, and result commit; duplicate, delay, and reorder all deliveries;
  partition stores/workers; expire and steal leases; verify no invalid transition
  or unfenced commit.
- **Side effects:** demonstrate stable idempotency keys across retries/recovery,
  transactional integration where claimed, late completion policy, and the
  documented at-least-once behavior with a deliberately non-idempotent fixture.
- **Signals and time:** signal-before-wait, simultaneous signal/cancel/timeout,
  duplicate IDs, overflow/expiry, timer recovery, clock skew, and deterministic
  jitter tests.
- **Upgrades:** old plan/event/storage fixtures through every migration path;
  mixed old/new workers and rolling deploys; pinned implementation routing; safe
  rollback; compatibility removal audit.
- **Capacity:** measured limits for nodes, dynamic fan-out, concurrent runs,
  activity queues, history bytes/events, signal backlog, blobs, and read-model
  lag; soak tests prove backpressure and bounded memory.
- **Security:** threat model and tenant-isolation tests; RBAC on every mutation and
  query; secret/PII redaction tests; untrusted schema/config/expression fuzzing;
  noisy-neighbor fairness and cross-tenant existence-oracle tests; scoped worker/
  human capability tests; risky-handler capability and egress tests; dependency/
  supply-chain review.
- **Operations:** trace/log/metric correlation by run/node/activity/attempt without
  secrets; stuck-run and poison-message alerts; auditable repair operations;
  backup/point-in-time restore and regional/disaster recovery exercises with
  measured RPO/RTO.

Only after these gates pass may documentation describe a backend as durable or
state a stronger transactional guarantee. All user-facing guarantees must name
their boundary: history, activity delivery, application transaction, signal
consumption, or external side effect.
