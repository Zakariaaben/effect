---
"@effect/workflow-builder": minor
---

Add the Effect-native workflow builder package with versioned plan schemas,
typed node and port definitions, explicit link policies, aggregate plan
compilation, canonical fingerprints, a non-durable direct interpreter, and a
strict semantic-history replay foundation with an atomic process-local history
store plus deterministic command/decision primitives, safe run-start and
activity boundaries, a process-local semantic runner, effectful terminal-command
validation, prepared decision commits, and an atomic process-local
history/outbox reference store. Add a sibling protocol-v2 model for retries,
timeouts, timers, signals, waits, exact runtime pins, domain-separated content
identities, fail-closed replay, and executable process-local signal and
execution authorities. The latter covers prepared starts, deterministic
decisions, retries, activity timers, cancellation, dispatch/wake indexes, and
exact decision-batch and plan-bound schema-admitted worker completions, with
bounded payload capture and deterministic deadline-overflow failure. Add the
standards baseline, Workflow Patterns traceability, strict BPMN 2.0.2
semantic/data/DI and durable token/scope foundations, a bounded token kernel,
and named XML/DI mapping profile `bpmn-2.0.2-core-process-di-v2` without
claiming normative XSD or BPMN conformance. Add a strict executable facade and
evidence that the named XML slice compiles directly to the token kernel,
executes, replays, exports, re-imports, recompiles, and replays equivalently.
The named XML profile also round-trips BPMN call-activity callable references as
namespace-expanded QNames while executable admission continues to reject them
until an immutable child target and durable parent/child protocol are present.
Workflow Patterns evidence is split by family with atomic executable status for
the currently proven control-flow subset, while complete atomic coverage
remains explicitly unsupported. Portable codecs declare JSON wire types, and
hostile plan, policy, diagnostic, interpreter, command, activity, history,
signal, XML, and dispatch boundaries are detached and validated without sharing
caller-owned payload containers. Prepare executable BPMN kernels through the
explicit Crypto service and bind markings and versioned journal headers to a
domain-separated fingerprint of the normalized model, kernel profile, limits,
and exact evaluator-build manifest. Add a no-fallback Effect evaluator registry,
an atomic asynchronous expression driver with fixed retry inputs, timeouts,
step limits and interruption preservation, condition provenance/resource
evidence, and content-addressed sealed BPMN journal artifacts without claiming
that a digest is a signature or that the current in-memory components are
persistent. Add exact-generation activity cancellation delivery to the
process-local reference authority, including an issued-generation ledger,
bounded fenced claims, acknowledgement/release, completion/cancellation race
tests, and a worker fiber registry that waits for finalizers and closes the
acquire/register race. Add a separate protocol-v3 child-target, lineage,
close-policy, canonical-relation, and call-state foundation without widening
protocol v2 or claiming child execution.
