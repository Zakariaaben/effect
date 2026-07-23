/**
 * Content-addressed semantic operations for execution protocol version `3`.
 *
 * **Details**
 *
 * Native Effect Workflow persists operations by workflow execution, name, and
 * (for activities) attempt. Those coordinates are replay-safe only when they
 * always retain exactly the same semantic meaning. This module commits the
 * complete activity, timer, deferred, or race descriptor to a domain-separated
 * digest before a native adapter may execute it.
 *
 * The operation digest must be bound under the stable native coordinates and
 * compared on replay. It must not be appended to the native name: doing so
 * would turn semantic drift into a second operation instead of rejecting it.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ActivityPolicyV3 from "./ActivityPolicyV3.ts"
import * as DigestV3 from "./DigestV3.ts"
import type * as EffectWorkflowOperationV3 from "./EffectWorkflowOperationV3.ts"
import * as Json from "./internal/json.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import * as SemanticOccurrenceV3 from "./SemanticOccurrenceV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const preparedOperations = new WeakSet<object>()
const preparedOccurrences = new WeakMap<
  object,
  SemanticOccurrenceV3.PreparedOccurrence
>()

/**
 * Execution protocol whose operations are represented here.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 3 as const

/**
 * Independent format version of semantic operation descriptors.
 *
 * @category constants
 * @since 4.0.0
 */
export const OperationVersion = 1 as const

/**
 * Maximum number of participants admitted by one semantic race.
 *
 * **Details**
 *
 * The bound applies before dynamic result schemas or native fibers are
 * constructed. Runtime concurrency policy may impose a lower bound.
 *
 * @category constants
 * @since 4.0.0
 */
export const MaximumRaceParticipants = 1_024 as const

const CommonSpec = {
  operationVersion: Schema.Literal(OperationVersion),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  operationId: Wire.AtomicIdentifier
} as const

/**
 * A node-handler invocation bound to the occurrence's exact artifact node.
 *
 * **Details**
 *
 * The occurrence already commits the node ID and complete artifact. The
 * definition key and handler build digest are retained here because they are
 * the minimal independently inspectable coordinates needed to reject a
 * mismatched binding and explain which handler meaning was requested.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeHandlerPurpose = Schema.TaggedStruct("NodeHandler", {
  purposeVersion: Schema.Literal(1),
  nodeDefinitionKey: Wire.Identifier,
  handlerBuildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3NodeHandlerPurpose",
  parseOptions: strictParseOptions
})

/**
 * A managed node-handler invocation whose business result is persisted as one
 * closed outcome in the native activity success channel.
 *
 * **Details**
 *
 * Unlike `NodeHandler`, business failure is not a native typed error. The
 * native adapter encodes either the exact output aggregate or the exact
 * application failure before persistence and uses `Never` as the activity
 * error contract. This lets retry composition inspect a durable value without
 * catching or re-encoding a decoded replay failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptPurpose = Schema.TaggedStruct("NodeAttempt", {
  purposeVersion: Schema.Literal(1),
  nodeDefinitionKey: Wire.Identifier,
  handlerBuildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3NodeAttemptPurpose",
  parseOptions: strictParseOptions
})

/**
 * A retry classification owned by one exact failed activity and classifier
 * executable.
 *
 * **Details**
 *
 * The classifier key resolves the artifact policy pin while the build digest
 * prevents a same-key executable substitution. Complete deployment and
 * catalog coordinates remain in the artifact already committed by the
 * occurrence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryClassifierPurpose = Schema.TaggedStruct(
  "RetryClassifier",
  {
    purposeVersion: Schema.Literal(1),
    failedActivityDigest: Wire.OperationDigest,
    classifierKey: Wire.Identifier,
    classifierBuildDigest: Wire.BuildDigest
  }
).annotate({
  identifier: "WorkflowSemanticOperationV3RetryClassifierPurpose",
  parseOptions: strictParseOptions
})

/**
 * Replay-recorded retry-delay selection owned by one failed activity and its
 * exact classification operation.
 *
 * **Details**
 *
 * The selected delay is external entropy admitted against the deterministic
 * range carried by the activity input. It is not an implicit random choice in
 * the policy evaluator.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryDelaySelectionPurpose = Schema.TaggedStruct(
  "RetryDelaySelection",
  {
    purposeVersion: Schema.Literal(1),
    failedActivityDigest: Wire.OperationDigest,
    classificationActivityDigest: Wire.OperationDigest
  }
).annotate({
  identifier: "WorkflowSemanticOperationV3RetryDelaySelectionPurpose",
  parseOptions: strictParseOptions
})

/**
 * Closed elapsed-time role of a replay-recorded wall-clock observation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeObservationKind = Schema.Literals([
  "Initial",
  "Failure"
]).annotate({
  identifier: "WorkflowSemanticOperationV3TimeObservationKind"
})

/**
 * The decoded type of {@link TimeObservationKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimeObservationKind = Schema.Schema.Type<
  typeof TimeObservationKind
>

/**
 * A replay-recorded canonical wall-clock observation.
 *
 * **Details**
 *
 * `Initial` records the logical activity's elapsed-budget anchor. `Failure`
 * records the instant at which one failed attempt is evaluated. The owner
 * digest prevents the same observation coordinate from moving to a different
 * logical activity or failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimeObservationPurpose = Schema.TaggedStruct(
  "TimeObservation",
  {
    purposeVersion: Schema.Literal(1),
    ownerOperationDigest: Wire.OperationDigest,
    observationKind: TimeObservationKind
  }
).annotate({
  identifier: "WorkflowSemanticOperationV3TimeObservationPurpose",
  parseOptions: strictParseOptions
})

/**
 * Closed semantic purpose vocabulary for native activity attempts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityPurpose = Schema.Union([
  NodeHandlerPurpose,
  NodeAttemptPurpose,
  RetryClassifierPurpose,
  RetryDelaySelectionPurpose,
  TimeObservationPurpose
]).annotate({
  identifier: "WorkflowSemanticOperationV3ActivityPurpose",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityPurpose}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityPurpose = Schema.Schema.Type<typeof ActivityPurpose>

/**
 * A result encoded by one exact codec pin in the execution artifact.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ArtifactCodecContract = Schema.TaggedStruct("ArtifactCodec", {
  contractReferenceVersion: Schema.Literal(1),
  codecKey: Wire.Identifier,
  schemaDigest: Wire.SchemaDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3ArtifactCodecContract",
  parseOptions: strictParseOptions
})

/**
 * The aggregate of all declared outputs of one exact node definition.
 *
 * **Details**
 *
 * Its runtime schema is derived from the artifact's node-definition manifest
 * and exact output codec pins. The occurrence's artifact digest commits that
 * derivation, so no second independently mutable aggregate digest is stored.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeOutputAggregateContract = Schema.TaggedStruct(
  "NodeOutputAggregate",
  {
    contractReferenceVersion: Schema.Literal(1),
    nodeDefinitionKey: Wire.Identifier
  }
).annotate({
  identifier: "WorkflowSemanticOperationV3NodeOutputAggregateContract",
  parseOptions: strictParseOptions
})

/**
 * A managed node attempt whose exact output aggregate was encoded once inside
 * the native activity.
 *
 * **Details**
 *
 * Inline output is the only admitted representation until a
 * digest-verifying BlobStore adapter exists at the managed activity boundary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptSucceeded = Schema.TaggedStruct("Succeeded", {
  outcomeVersion: Schema.Literal(1),
  attempt: Wire.PositiveSafeInt,
  activityDigest: Wire.OperationDigest,
  output: Wire.InlineEncodedPayload
}).annotate({
  identifier: "WorkflowSemanticOperationV3NodeAttemptSucceeded",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeAttemptSucceeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptSucceeded = Schema.Schema.Type<
  typeof NodeAttemptSucceeded
>

const NodeAttemptApplicationFailedStruct = Schema.TaggedStruct(
  "ApplicationFailed",
  {
    outcomeVersion: Schema.Literal(1),
    attempt: Wire.PositiveSafeInt,
    activityDigest: Wire.OperationDigest,
    failure: ActivityPolicyV3.ApplicationFailure
  }
)

/**
 * A managed node attempt whose exact application failure was encoded once
 * inside the native activity.
 *
 * **Details**
 *
 * The duplicated outer coordinates make every outcome independently
 * inspectable. They must equal the coordinates retained by the nested
 * application failure.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptApplicationFailed = NodeAttemptApplicationFailedStruct.check(
  Schema.makeFilter((value) => {
    const issues: Array<Schema.FilterIssue> = []
    if (value.attempt !== value.failure.attempt) {
      issues.push({
        path: ["failure", "attempt"],
        issue: "failure attempt must equal the outer node-attempt outcome attempt"
      })
    }
    if (
      value.activityDigest !==
        value.failure.activityDigest
    ) {
      issues.push({
        path: ["failure", "activityDigest"],
        issue: "failure activityDigest must equal the outer node-attempt outcome digest"
      })
    }
    return issues
  })
).annotate({
  identifier: "WorkflowSemanticOperationV3NodeAttemptApplicationFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeAttemptApplicationFailed}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptApplicationFailed = Schema.Schema.Type<
  typeof NodeAttemptApplicationFailed
>

/**
 * Complete persisted success contract of one managed native node attempt.
 *
 * **Details**
 *
 * Native activity error is `Never`. Business failures are values in this
 * union; protocol, codec, and handler-boundary violations remain defects.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptOutcome = Schema.Union([
  NodeAttemptSucceeded,
  NodeAttemptApplicationFailed
]).annotate({
  identifier: "WorkflowSemanticOperationV3NodeAttemptOutcome",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeAttemptOutcome}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptOutcome = Schema.Schema.Type<
  typeof NodeAttemptOutcome
>

/**
 * Closed names in built-in result-schema vocabulary version `1`.
 *
 * **Details**
 *
 * These names refer respectively to Effect's impossible error channel, the
 * closed retry-classifier decision, an admitted replay-recorded retry delay,
 * and {@link Wire.Timestamp}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BuiltInSchemaName = Schema.Literals([
  "Never",
  "Void",
  "NodeAttemptOutcome",
  "RetryClassification",
  "RecordedRetryDelay",
  "CanonicalTimestamp"
]).annotate({
  identifier: "WorkflowSemanticOperationV3BuiltInSchemaName"
})

/**
 * The decoded type of {@link BuiltInSchemaName}.
 *
 * @category models
 * @since 4.0.0
 */
export type BuiltInSchemaName = Schema.Schema.Type<
  typeof BuiltInSchemaName
>

/**
 * A result governed by a closed, engine-owned schema vocabulary.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BuiltInContract = Schema.TaggedStruct("BuiltIn", {
  contractReferenceVersion: Schema.Literal(1),
  vocabularyVersion: Schema.Literal(1),
  schema: BuiltInSchemaName
}).annotate({
  identifier: "WorkflowSemanticOperationV3BuiltInContract",
  parseOptions: strictParseOptions
})

/**
 * Exact persistent reference to one activity result contract.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ResultContract = Schema.Union([
  ArtifactCodecContract,
  NodeOutputAggregateContract,
  BuiltInContract
]).annotate({
  identifier: "WorkflowSemanticOperationV3ResultContract",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ResultContract}.
 *
 * @category models
 * @since 4.0.0
 */
export type ResultContract = Schema.Schema.Type<typeof ResultContract>

interface ActivityContractShape {
  readonly purpose: ActivityPurpose
  readonly successContract: ResultContract
  readonly errorContract: ResultContract
}

const isBuiltInContract = (
  contract: ResultContract,
  schema: BuiltInSchemaName
): boolean =>
  contract._tag === "BuiltIn" &&
  contract.vocabularyVersion === 1 &&
  contract.schema === schema

const activityContractIssues = (
  activity: ActivityContractShape
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  switch (activity.purpose._tag) {
    case "NodeHandler": {
      if (
        activity.successContract._tag !== "NodeOutputAggregate" ||
        activity.successContract.nodeDefinitionKey !==
          activity.purpose.nodeDefinitionKey
      ) {
        issues.push({
          path: ["successContract"],
          issue: "NodeHandler success must be the output aggregate of its exact nodeDefinitionKey"
        })
      }
      if (activity.errorContract._tag !== "ArtifactCodec") {
        issues.push({
          path: ["errorContract"],
          issue: "NodeHandler error must reference one exact artifact codec"
        })
      }
      break
    }
    case "NodeAttempt": {
      if (
        !isBuiltInContract(
          activity.successContract,
          "NodeAttemptOutcome"
        )
      ) {
        issues.push({
          path: ["successContract"],
          issue: "NodeAttempt success must use built-in NodeAttemptOutcome"
        })
      }
      if (!isBuiltInContract(activity.errorContract, "Never")) {
        issues.push({
          path: ["errorContract"],
          issue: "NodeAttempt error must use built-in Never"
        })
      }
      break
    }
    case "RetryClassifier": {
      if (
        !isBuiltInContract(
          activity.successContract,
          "RetryClassification"
        )
      ) {
        issues.push({
          path: ["successContract"],
          issue: "RetryClassifier success must use built-in RetryClassification"
        })
      }
      if (!isBuiltInContract(activity.errorContract, "Never")) {
        issues.push({
          path: ["errorContract"],
          issue: "RetryClassifier error must use built-in Never"
        })
      }
      break
    }
    case "RetryDelaySelection": {
      if (
        !isBuiltInContract(
          activity.successContract,
          "RecordedRetryDelay"
        )
      ) {
        issues.push({
          path: ["successContract"],
          issue: "RetryDelaySelection success must use built-in RecordedRetryDelay"
        })
      }
      if (!isBuiltInContract(activity.errorContract, "Never")) {
        issues.push({
          path: ["errorContract"],
          issue: "RetryDelaySelection error must use built-in Never"
        })
      }
      break
    }
    case "TimeObservation": {
      if (
        !isBuiltInContract(
          activity.successContract,
          "CanonicalTimestamp"
        )
      ) {
        issues.push({
          path: ["successContract"],
          issue: "TimeObservation success must use built-in CanonicalTimestamp"
        })
      }
      if (!isBuiltInContract(activity.errorContract, "Never")) {
        issues.push({
          path: ["errorContract"],
          issue: "TimeObservation error must use built-in Never"
        })
      }
      break
    }
  }
  return issues
}

const ActivitySpecStruct = Schema.TaggedStruct("Activity", {
  ...CommonSpec,
  attempt: Wire.PositiveSafeInt,
  purpose: ActivityPurpose,
  input: Wire.EncodedPayload,
  successContract: ResultContract,
  errorContract: ResultContract
})

/**
 * Exactly one semantic activity attempt.
 *
 * **Details**
 *
 * The operation ID and occurrence form the logical native activity name.
 * `attempt` is supplied separately through native `Activity.CurrentAttempt`.
 * Policy retries create a new descriptor with the next attempt; operational
 * redelivery reuses the same descriptor.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivitySpec = ActivitySpecStruct.check(
  Schema.makeFilter(activityContractIssues)
).annotate({
  identifier: "WorkflowSemanticOperationV3ActivitySpec",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivitySpec}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivitySpec = Schema.Schema.Type<typeof ActivitySpec>

/**
 * A retry backoff owned by one failed semantic activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryBackoffOwner = Schema.TaggedStruct("RetryBackoff", {
  failedActivityDigest: Wire.OperationDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3RetryBackoffOwner",
  parseOptions: strictParseOptions
})

/**
 * A start-to-close deadline owned by one semantic activity attempt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const StartToCloseOwner = Schema.TaggedStruct("StartToClose", {
  activityDigest: Wire.OperationDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3StartToCloseOwner",
  parseOptions: strictParseOptions
})

/**
 * A schedule-to-close deadline owned by one semantic activity occurrence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleToCloseOwner = Schema.TaggedStruct("ScheduleToClose", {
  activityDigest: Wire.OperationDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3ScheduleToCloseOwner",
  parseOptions: strictParseOptions
})

/**
 * A timeout owned by one deferred generation.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeferredTimeoutOwner = Schema.TaggedStruct("DeferredTimeout", {
  deferredDigest: Wire.OperationDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3DeferredTimeoutOwner",
  parseOptions: strictParseOptions
})

/**
 * An explicit workflow sleep owned directly by its occurrence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SleepOwner = Schema.TaggedStruct("Sleep", {}).annotate({
  identifier: "WorkflowSemanticOperationV3SleepOwner",
  parseOptions: strictParseOptions
})

/**
 * A BPMN timer event definition owned by its dynamic occurrence.
 *
 * @category schemas
 * @since 4.0.0
 */
export const BpmnTimerOwner = Schema.TaggedStruct("BpmnTimer", {
  eventDefinitionId: Wire.AtomicIdentifier
}).annotate({
  identifier: "WorkflowSemanticOperationV3BpmnTimerOwner",
  parseOptions: strictParseOptions
})

/**
 * Closed semantic owner vocabulary for durable timers.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerOwner = Schema.Union([
  RetryBackoffOwner,
  StartToCloseOwner,
  ScheduleToCloseOwner,
  DeferredTimeoutOwner,
  SleepOwner,
  BpmnTimerOwner
]).annotate({
  identifier: "WorkflowSemanticOperationV3TimerOwner",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimerOwner}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerOwner = Schema.Schema.Type<typeof TimerOwner>

/**
 * One positive durable semantic timer generation.
 *
 * **Details**
 *
 * Zero-delay transitions are immediate semantic decisions and do not allocate
 * a durable timer. Every positive timer maps to `DurableClock.sleep` with the
 * native in-memory threshold forced to zero.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerSpec = Schema.TaggedStruct("Timer", {
  ...CommonSpec,
  generation: Wire.NonNegativeSafeInt,
  owner: TimerOwner,
  delayMillis: Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowSemanticOperationV3TimerSpec",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimerSpec}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerSpec = Schema.Schema.Type<typeof TimerSpec>

/**
 * One one-shot durable deferred generation.
 *
 * **Details**
 *
 * The exact codec and success/error schemas are pinned because a native
 * deferred reuses its recorded exit during replay. Authorization, ordered
 * buffering, correlation, and signal consumption remain separate ingress
 * semantics; a deferred token alone is only an address.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeferredSpec = Schema.TaggedStruct("Deferred", {
  ...CommonSpec,
  generation: Wire.NonNegativeSafeInt,
  successCodecKey: Wire.Identifier,
  errorCodecKey: Wire.Identifier,
  successSchemaDigest: Wire.SchemaDigest,
  errorSchemaDigest: Wire.SchemaDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3DeferredSpec",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DeferredSpec}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeferredSpec = Schema.Schema.Type<typeof DeferredSpec>

/**
 * Closed completion rule for a semantic race.
 *
 * **Details**
 *
 * `FirstSettled` records the first success, typed failure, or defect.
 * `FirstSuccess` ignores failures until one participant succeeds or every
 * participant has failed.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceMode = Schema.Literals([
  "FirstSettled",
  "FirstSuccess"
]).annotate({
  identifier: "WorkflowSemanticOperationV3RaceMode"
})

/**
 * The decoded type of {@link RaceMode}.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceMode = Schema.Schema.Type<typeof RaceMode>

/**
 * Honest loser handling supported by the native Effect Workflow adapter.
 *
 * **Details**
 *
 * The adapter interrupts fibers waiting for losing participants. It does not
 * claim to roll back side effects or durably cancel already dispatched work.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceLoserDisposition = Schema.Literal(
  "InterruptWaiters"
).annotate({
  identifier: "WorkflowSemanticOperationV3RaceLoserDisposition"
})

/**
 * The decoded type of {@link RaceLoserDisposition}.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceLoserDisposition = Schema.Schema.Type<
  typeof RaceLoserDisposition
>

/**
 * Kind of exact semantic operation allowed to participate in a race.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceParticipantKind = Schema.Literals([
  "Activity",
  "Timer",
  "Deferred"
]).annotate({
  identifier: "WorkflowSemanticOperationV3RaceParticipantKind"
})

/**
 * The decoded type of {@link RaceParticipantKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceParticipantKind = Schema.Schema.Type<
  typeof RaceParticipantKind
>

/**
 * Ordered exact participant committed by a semantic race.
 *
 * **Details**
 *
 * The referenced operation digest commits the participant's complete
 * descriptor. Repeating its result contracts here makes the race schema
 * independently inspectable and lets resolution reject a mismatched runtime
 * participant before any native effect starts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceParticipant = Schema.Struct({
  participantVersion: Schema.Literal(1),
  participantId: Wire.AtomicIdentifier,
  participantKind: RaceParticipantKind,
  operationDigest: Wire.OperationDigest,
  successContract: ResultContract,
  errorContract: ResultContract
}).annotate({
  identifier: "WorkflowSemanticOperationV3RaceParticipant",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RaceParticipant}.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceParticipant = Schema.Schema.Type<typeof RaceParticipant>

const raceParticipantIssues = (
  participants: ReadonlyArray<RaceParticipant>
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  const ids = new Set<string>()
  const digests = new Set<string>()
  for (let index = 0; index < participants.length; index++) {
    const participant = participants[index]!
    if (ids.has(participant.participantId)) {
      issues.push({
        path: [index, "participantId"],
        issue: "Race participant IDs must be unique"
      })
    }
    ids.add(participant.participantId)
    if (digests.has(participant.operationDigest)) {
      issues.push({
        path: [index, "operationDigest"],
        issue: "Race participant operation digests must be unique"
      })
    }
    digests.add(participant.operationDigest)
    if (
      participant.participantKind === "Timer" &&
      (
        !isBuiltInContract(participant.successContract, "Void") ||
        !isBuiltInContract(participant.errorContract, "Never")
      )
    ) {
      issues.push({
        path: [index],
        issue: "Timer race participants must use built-in Void/Never contracts"
      })
    }
    if (
      participant.participantKind === "Deferred" &&
      (
        participant.successContract._tag !== "ArtifactCodec" ||
        participant.errorContract._tag !== "ArtifactCodec"
      )
    ) {
      issues.push({
        path: [index],
        issue: "Deferred race participants must use exact artifact codec contracts"
      })
    }
  }
  return issues
}

/**
 * Bounded, ordered, non-empty semantic race membership.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceParticipants = Schema.NonEmptyArray(
  RaceParticipant
).check(
  Schema.isMaxLength(MaximumRaceParticipants),
  Schema.makeFilter(raceParticipantIssues)
).annotate({
  identifier: "WorkflowSemanticOperationV3RaceParticipants",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RaceParticipants}.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceParticipants = Schema.Schema.Type<typeof RaceParticipants>

/**
 * One renewable durable race over exact semantic operations.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceSpec = Schema.TaggedStruct("Race", {
  ...CommonSpec,
  generation: Wire.NonNegativeSafeInt,
  mode: RaceMode,
  loserDisposition: RaceLoserDisposition,
  outcomeEnvelopeVersion: Schema.Literal(1),
  participants: RaceParticipants
}).annotate({
  identifier: "WorkflowSemanticOperationV3RaceSpec",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RaceSpec}.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceSpec = Schema.Schema.Type<typeof RaceSpec>

/**
 * Caller-supplied race coordinates whose membership is derived separately
 * from exact prepared operations by {@link prepareRace}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RacePreparation = Schema.TaggedStruct("Race", {
  ...CommonSpec,
  generation: Wire.NonNegativeSafeInt,
  mode: RaceMode,
  loserDisposition: RaceLoserDisposition,
  outcomeEnvelopeVersion: Schema.Literal(1)
}).annotate({
  identifier: "WorkflowSemanticOperationV3RacePreparation",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RacePreparation}.
 *
 * @category models
 * @since 4.0.0
 */
export type RacePreparation = Schema.Schema.Type<typeof RacePreparation>

const retryScheduleToCloseIssues = (
  spec: Schema.Schema.Type<typeof RetryScheduleToCloseSpecStruct>
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  if (spec.activityPolicy.timeouts.scheduleToStart._tag !== "Disabled") {
    issues.push({
      path: ["activityPolicy", "timeouts", "scheduleToStart"],
      issue: "Retry schedule-to-close controllers require scheduleToStart to be disabled"
    })
  }
  if (spec.activityPolicy.timeouts.startToClose._tag !== "Disabled") {
    issues.push({
      path: ["activityPolicy", "timeouts", "startToClose"],
      issue: "Retry schedule-to-close controllers require startToClose to be disabled"
    })
  }
  const scheduleToClose = spec.activityPolicy.timeouts.scheduleToClose
  if (scheduleToClose._tag !== "After") {
    issues.push({
      path: ["activityPolicy", "timeouts", "scheduleToClose"],
      issue: "Retry schedule-to-close controllers require an enabled scheduleToClose timeout"
    })
  } else if (scheduleToClose.durationMillis !== spec.durationMillis) {
    issues.push({
      path: ["durationMillis"],
      issue: "Controller duration must equal the exact activity-policy scheduleToClose duration"
    })
  }
  return issues
}

const RetryScheduleToCloseSpecStruct = Schema.TaggedStruct(
  "RetryScheduleToClose",
  {
    ...CommonSpec,
    generation: Wire.NonNegativeSafeInt,
    controllerVersion: Schema.Literal(1),
    firstActivityDigest: Wire.OperationDigest,
    initialObservationDigest: Wire.OperationDigest,
    nodeDefinitionKey: Wire.Identifier,
    handlerBuildDigest: Wire.BuildDigest,
    input: Wire.InlineEncodedPayload,
    activityPolicy: ActivityPolicyV3.Policy,
    timeoutKind: Schema.Literal("ScheduleToClose"),
    durationMillis: Wire.PositiveSemanticDelayMillis,
    outcomeContractVersion: Schema.Literal(1),
    loserDisposition: RaceLoserDisposition
  }
)

/**
 * One content-addressed controller that fences a complete managed retry loop
 * with an exact schedule-to-close duration.
 *
 * **Details**
 *
 * The nested occurrence pins the artifact and dynamic node coordinates. The
 * descriptor repeats the exact handler, inline input, complete activity
 * policy, first managed-attempt digest, timeout kind, duration, outcome
 * contract, and honest waiter-interruption disposition so its native name can
 * never silently acquire different retry or timeout meaning.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryScheduleToCloseSpec = RetryScheduleToCloseSpecStruct.check(
  Schema.makeFilter(retryScheduleToCloseIssues)
).annotate({
  identifier: "WorkflowSemanticOperationV3RetryScheduleToCloseSpec",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RetryScheduleToCloseSpec}.
 *
 * @category models
 * @since 4.0.0
 */
export type RetryScheduleToCloseSpec = Schema.Schema.Type<
  typeof RetryScheduleToCloseSpec
>

/**
 * Closed semantic operation specification vocabulary currently admitted by
 * version `1`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OperationSpec = Schema.Union([
  ActivitySpec,
  TimerSpec,
  DeferredSpec,
  RaceSpec,
  RetryScheduleToCloseSpec
]).annotate({
  identifier: "WorkflowSemanticOperationV3Spec",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OperationSpec}.
 *
 * @category models
 * @since 4.0.0
 */
export type OperationSpec = Schema.Schema.Type<typeof OperationSpec>

const CommonDocument = {
  operationVersion: Schema.Literal(OperationVersion),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  occurrence: SemanticOccurrenceV3.OccurrencePin,
  operationId: Wire.AtomicIdentifier
} as const

const ActivityDocumentStruct = Schema.TaggedStruct("Activity", {
  ...CommonDocument,
  attempt: Wire.PositiveSafeInt,
  purpose: ActivityPurpose,
  input: Wire.EncodedPayload,
  successContract: ResultContract,
  errorContract: ResultContract
})

/**
 * Content-addressed activity-attempt document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityDocument = ActivityDocumentStruct.check(
  Schema.makeFilter(activityContractIssues)
).annotate({
  identifier: "WorkflowSemanticOperationV3ActivityDocument",
  parseOptions: strictParseOptions
})

/**
 * Content-addressed timer-generation document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerDocument = Schema.TaggedStruct("Timer", {
  ...CommonDocument,
  generation: Wire.NonNegativeSafeInt,
  owner: TimerOwner,
  delayMillis: Wire.PositiveSemanticDelayMillis
}).annotate({
  identifier: "WorkflowSemanticOperationV3TimerDocument",
  parseOptions: strictParseOptions
})

/**
 * Content-addressed deferred-generation document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeferredDocument = Schema.TaggedStruct("Deferred", {
  ...CommonDocument,
  generation: Wire.NonNegativeSafeInt,
  successCodecKey: Wire.Identifier,
  errorCodecKey: Wire.Identifier,
  successSchemaDigest: Wire.SchemaDigest,
  errorSchemaDigest: Wire.SchemaDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3DeferredDocument",
  parseOptions: strictParseOptions
})

/**
 * Content-addressed durable-race document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RaceDocument = Schema.TaggedStruct("Race", {
  ...CommonDocument,
  generation: Wire.NonNegativeSafeInt,
  mode: RaceMode,
  loserDisposition: RaceLoserDisposition,
  outcomeEnvelopeVersion: Schema.Literal(1),
  participants: RaceParticipants
}).annotate({
  identifier: "WorkflowSemanticOperationV3RaceDocument",
  parseOptions: strictParseOptions
})

/**
 * Content-addressed durable schedule-to-close retry-controller document.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RetryScheduleToCloseDocument = Schema.TaggedStruct(
  "RetryScheduleToClose",
  {
    ...CommonDocument,
    generation: Wire.NonNegativeSafeInt,
    controllerVersion: Schema.Literal(1),
    firstActivityDigest: Wire.OperationDigest,
    initialObservationDigest: Wire.OperationDigest,
    nodeDefinitionKey: Wire.Identifier,
    handlerBuildDigest: Wire.BuildDigest,
    input: Wire.InlineEncodedPayload,
    activityPolicy: ActivityPolicyV3.Policy,
    timeoutKind: Schema.Literal("ScheduleToClose"),
    durationMillis: Wire.PositiveSemanticDelayMillis,
    outcomeContractVersion: Schema.Literal(1),
    loserDisposition: RaceLoserDisposition
  }
).check(
  Schema.makeFilter(retryScheduleToCloseIssues)
).annotate({
  identifier: "WorkflowSemanticOperationV3RetryScheduleToCloseDocument",
  parseOptions: strictParseOptions
})

/**
 * Complete semantic operation digest preimage.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OperationDocument = Schema.Union([
  ActivityDocument,
  TimerDocument,
  DeferredDocument,
  RaceDocument,
  RetryScheduleToCloseDocument
]).annotate({
  identifier: "WorkflowSemanticOperationV3Document",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OperationDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type OperationDocument = Schema.Schema.Type<
  typeof OperationDocument
>

/**
 * Persistable operation document and its domain-separated content identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OperationPin = Schema.Struct({
  document: OperationDocument,
  operationDigest: Wire.OperationDigest
}).annotate({
  identifier: "WorkflowSemanticOperationV3Pin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OperationPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type OperationPin = Schema.Schema.Type<typeof OperationPin>

/**
 * Exact process-local operation returned by {@link prepare},
 * {@link prepareRace}, or {@link verify}.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedOperation extends OperationPin {}

/**
 * One caller-chosen participant ID paired with an exact prepared operation.
 *
 * **Details**
 *
 * {@link prepareRace} derives kind, digest, and result contracts from the
 * operation. Callers cannot provide or override those committed fields.
 *
 * @category models
 * @since 4.0.0
 */
export type RaceParticipantInput = readonly [
  participantId: string,
  operation: PreparedOperation
]

/**
 * Stable operation preparation and verification failure codes.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  UnpreparedOccurrence: "UnpreparedOccurrence",
  UnpreparedOperation: "UnpreparedOperation",
  InvalidSpec: "InvalidSpec",
  InvalidPin: "InvalidPin",
  DigestMismatch: "DigestMismatch"
} as const

/**
 * A stable semantic operation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.UnpreparedOccurrence,
  ErrorCodes.UnpreparedOperation,
  ErrorCodes.InvalidSpec,
  ErrorCodes.InvalidPin,
  ErrorCodes.DigestMismatch
])

/**
 * Raised when semantic operation preparation, provenance, or verification
 * fails.
 *
 * @category errors
 * @since 4.0.0
 */
export class SemanticOperationError extends Schema.TaggedErrorClass<
  SemanticOperationError
>("@effect/workflow-builder/SemanticOperationV3/Error")(
  "SemanticOperationError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString
  },
  { parseOptions: strictParseOptions }
) {}

const error = (
  code: ErrorCode,
  message: string
): SemanticOperationError => new SemanticOperationError({ code, message })

const snapshot = (
  input: unknown,
  code: typeof ErrorCodes.InvalidSpec | typeof ErrorCodes.InvalidPin,
  label: string
): Result.Result<Schema.Json, SemanticOperationError> => {
  const snapped = Json.snapshot(input, {
    maxArrayLength: 16_384,
    maxContainers: 65_536,
    maxDepth: 1_024,
    maxEntries: 262_144,
    maxStringBytes: 1_048_576,
    maxTotalBytes: 16_777_216
  })
  return Result.isFailure(snapped)
    ? Result.fail(error(
      code,
      `${label} must be bounded strict JSON: ${snapped.failure.message}`
    ))
    : Result.succeed(snapped.success)
}

const decodeSnapshot = <A>(
  schema: Schema.Codec<A, Schema.Json>,
  input: unknown,
  code: typeof ErrorCodes.InvalidSpec | typeof ErrorCodes.InvalidPin,
  label: string
): Result.Result<A, SemanticOperationError> => {
  const snapped = snapshot(input, code, label)
  if (Result.isFailure(snapped)) return Result.fail(snapped.failure)
  let decoded: Result.Result<A, Schema.SchemaError>
  try {
    decoded = Schema.decodeUnknownResult(schema, strictParseOptions)(
      snapped.success
    )
  } catch {
    return Result.fail(error(
      code,
      `${label} validation threw unexpectedly`
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(error(
      code,
      `Invalid ${label}: ${decoded.failure.message}`
    ))
    : Result.succeed(snapped.success as unknown as A)
}

const admit = (
  document: OperationDocument,
  operationDigest: Wire.OperationDigest,
  occurrence: SemanticOccurrenceV3.PreparedOccurrence
): PreparedOperation => {
  const prepared = Object.freeze({
    document,
    operationDigest
  })
  preparedOperations.add(prepared)
  preparedOccurrences.set(prepared, occurrence)
  return prepared
}

/**
 * Tests whether a value is an exact operation prepared in this process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPrepared = (
  value: unknown
): value is PreparedOperation =>
  typeof value === "object" &&
  value !== null &&
  preparedOperations.has(value) &&
  preparedOccurrences.has(value)

/**
 * Returns the exact prepared occurrence retained for an operation.
 *
 * @category accessors
 * @since 4.0.0
 */
export const occurrence = (
  operation: PreparedOperation
): Result.Result<
  SemanticOccurrenceV3.PreparedOccurrence,
  SemanticOperationError
> => {
  const value = preparedOccurrences.get(operation)
  return value === undefined
    ? Result.fail(error(
      ErrorCodes.UnpreparedOperation,
      "Expected the exact PreparedOperation returned by prepare or verify"
    ))
    : Result.succeed(value)
}

const prepareDecoded = (
  occurrence: SemanticOccurrenceV3.PreparedOccurrence,
  spec: OperationSpec
): Effect.Effect<
  PreparedOperation,
  | SemanticOperationError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  const document = decodeSnapshot(
    OperationDocument,
    {
      ...spec,
      occurrence: {
        document: occurrence.document,
        occurrenceDigest: occurrence.occurrenceDigest
      }
    },
    ErrorCodes.InvalidSpec,
    "semantic operation document"
  )
  if (Result.isFailure(document)) return Effect.fail(document.failure)
  return Effect.map(
    DigestV3.operation(document.success),
    (operationDigest) => admit(document.success, operationDigest, occurrence)
  )
}

const artifactCodecContract = (
  codecKey: string,
  schemaDigest: Wire.SchemaDigest
): ResultContract => ({
  _tag: "ArtifactCodec",
  contractReferenceVersion: 1,
  codecKey,
  schemaDigest
})

const builtInContract = (
  schema: BuiltInSchemaName
): ResultContract => ({
  _tag: "BuiltIn",
  contractReferenceVersion: 1,
  vocabularyVersion: 1,
  schema
})

const captureRaceParticipantInputs = (
  input: unknown
): Result.Result<
  ReadonlyArray<RaceParticipantInput>,
  SemanticOperationError
> => {
  try {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length === 0 ||
      input.length > MaximumRaceParticipants ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return Result.fail(error(
        ErrorCodes.InvalidSpec,
        `Race participants must be a plain non-empty array of at most ${MaximumRaceParticipants} exact pairs`
      ))
    }
    const inputDescriptors = Object.getOwnPropertyDescriptors(input)
    if (
      Object.getOwnPropertyNames(inputDescriptors).length !==
        input.length + 1
    ) {
      return Result.fail(error(
        ErrorCodes.InvalidSpec,
        "Race participant input must not contain holes or extra properties"
      ))
    }
    const captured: Array<RaceParticipantInput> = []
    for (let index = 0; index < input.length; index++) {
      const descriptor = inputDescriptors[String(index)]
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return Result.fail(error(
          ErrorCodes.InvalidSpec,
          "Race participant input must contain only enumerable data properties"
        ))
      }
      const pair = descriptor.value
      if (
        !Array.isArray(pair) ||
        Object.getPrototypeOf(pair) !== Array.prototype ||
        pair.length !== 2 ||
        Object.getOwnPropertySymbols(pair).length !== 0
      ) {
        return Result.fail(error(
          ErrorCodes.InvalidSpec,
          `Race participant ${index} must be a plain [participantId, PreparedOperation] pair`
        ))
      }
      const pairDescriptors = Object.getOwnPropertyDescriptors(pair)
      if (Object.getOwnPropertyNames(pairDescriptors).length !== 3) {
        return Result.fail(error(
          ErrorCodes.InvalidSpec,
          `Race participant ${index} must not contain holes or extra properties`
        ))
      }
      const id = pairDescriptors["0"]
      const operation = pairDescriptors["1"]
      if (
        id === undefined ||
        !("value" in id) ||
        operation === undefined ||
        !("value" in operation) ||
        !isPrepared(operation.value)
      ) {
        return Result.fail(error(
          ErrorCodes.UnpreparedOperation,
          `Race participant ${index} must retain the exact PreparedOperation returned by prepare or verify`
        ))
      }
      captured.push([
        id.value as string,
        operation.value
      ])
    }
    return Result.succeed(captured)
  } catch {
    return Result.fail(error(
      ErrorCodes.InvalidSpec,
      "Race participant input could not be inspected safely"
    ))
  }
}

const raceParticipantNativeKey = (
  operation: PreparedOperation
): string => {
  const document = operation.document
  switch (document._tag) {
    case "Activity":
      return JSON.stringify([
        document._tag,
        document.occurrence.occurrenceDigest,
        document.operationId,
        document.attempt
      ])
    case "Timer":
    case "Deferred":
      return JSON.stringify([
        document._tag,
        document.occurrence.occurrenceDigest,
        document.operationId,
        document.generation
      ])
    case "Race":
      return "unsupported"
    case "RetryScheduleToClose":
      return "unsupported"
  }
}

const deriveRaceParticipant = (
  participantId: string,
  operation: PreparedOperation,
  occurrenceDigest: Wire.OccurrenceDigest
): Result.Result<RaceParticipant, SemanticOperationError> => {
  const document = operation.document
  if (document.occurrence.occurrenceDigest !== occurrenceDigest) {
    return Result.fail(error(
      ErrorCodes.InvalidSpec,
      "Race participants must belong to the race's exact semantic occurrence"
    ))
  }
  switch (document._tag) {
    case "Activity":
      if (document.purpose._tag !== "NodeHandler") {
        return Result.fail(error(
          ErrorCodes.InvalidSpec,
          "Only node-handler activities may participate in a semantic race"
        ))
      }
      return Result.succeed({
        participantVersion: 1,
        participantId,
        participantKind: "Activity",
        operationDigest: operation.operationDigest,
        successContract: document.successContract,
        errorContract: document.errorContract
      })
    case "Timer":
      return Result.succeed({
        participantVersion: 1,
        participantId,
        participantKind: "Timer",
        operationDigest: operation.operationDigest,
        successContract: builtInContract("Void"),
        errorContract: builtInContract("Never")
      })
    case "Deferred":
      return Result.succeed({
        participantVersion: 1,
        participantId,
        participantKind: "Deferred",
        operationDigest: operation.operationDigest,
        successContract: artifactCodecContract(
          document.successCodecKey,
          document.successSchemaDigest
        ),
        errorContract: artifactCodecContract(
          document.errorCodecKey,
          document.errorSchemaDigest
        )
      })
    case "Race":
      return Result.fail(error(
        ErrorCodes.InvalidSpec,
        "Nested Race operations are not participants in race descriptor version 1"
      ))
    case "RetryScheduleToClose":
      return Result.fail(error(
        ErrorCodes.InvalidSpec,
        "Retry schedule-to-close controllers are not race participants"
      ))
  }
}

/**
 * Validates and fingerprints one non-race operation for an exact prepared
 * occurrence.
 *
 * **Details**
 *
 * Race membership is not accepted through this generic constructor because
 * its participant contracts must be derived from exact prepared operations.
 * Use {@link prepareRace} for races.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepare = (
  occurrence: SemanticOccurrenceV3.PreparedOccurrence,
  input: unknown
): Effect.Effect<
  PreparedOperation,
  | SemanticOperationError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  if (!SemanticOccurrenceV3.isPrepared(occurrence)) {
    return Effect.fail(error(
      ErrorCodes.UnpreparedOccurrence,
      "Semantic operations require the exact PreparedOccurrence returned by prepare or verify"
    ))
  }
  const spec = decodeSnapshot(
    OperationSpec,
    input,
    ErrorCodes.InvalidSpec,
    "semantic operation specification"
  )
  if (Result.isFailure(spec)) return Effect.fail(spec.failure)
  if (spec.success._tag === "Race") {
    return Effect.fail(error(
      ErrorCodes.InvalidSpec,
      "Race membership must be derived from exact prepared operations through prepareRace"
    ))
  }
  return prepareDecoded(occurrence, spec.success)
}

/**
 * Derives, validates, and fingerprints one semantic race from exact prepared
 * participant operations.
 *
 * **Details**
 *
 * Participant kind, operation digest, and success/error contracts are never
 * caller-supplied. All participants must belong to the same exact occurrence,
 * use unique native persistence coordinates, and be node-handler activities,
 * timers, or deferred generations.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareRace = (
  occurrence: SemanticOccurrenceV3.PreparedOccurrence,
  input: unknown,
  participantInput: ReadonlyArray<RaceParticipantInput>
): Effect.Effect<
  PreparedOperation,
  | SemanticOperationError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  if (!SemanticOccurrenceV3.isPrepared(occurrence)) {
    return Effect.fail(error(
      ErrorCodes.UnpreparedOccurrence,
      "Semantic races require the exact PreparedOccurrence returned by prepare or verify"
    ))
  }
  const preparation = decodeSnapshot(
    RacePreparation,
    input,
    ErrorCodes.InvalidSpec,
    "semantic race preparation"
  )
  if (Result.isFailure(preparation)) {
    return Effect.fail(preparation.failure)
  }
  const captured = captureRaceParticipantInputs(participantInput)
  if (Result.isFailure(captured)) return Effect.fail(captured.failure)
  const participants: Array<RaceParticipant> = []
  const nativeKeys = new Set<string>()
  for (const [participantId, operation] of captured.success) {
    const nativeKey = raceParticipantNativeKey(operation)
    if (nativeKeys.has(nativeKey)) {
      return Effect.fail(error(
        ErrorCodes.InvalidSpec,
        "Race participants must use unique native persistence coordinates"
      ))
    }
    nativeKeys.add(nativeKey)
    const participant = deriveRaceParticipant(
      participantId,
      operation,
      occurrence.occurrenceDigest
    )
    if (Result.isFailure(participant)) {
      return Effect.fail(participant.failure)
    }
    participants.push(participant.success)
  }
  const spec = decodeSnapshot(
    RaceSpec,
    {
      ...preparation.success,
      participants
    },
    ErrorCodes.InvalidSpec,
    "derived semantic race specification"
  )
  if (Result.isFailure(spec)) return Effect.fail(spec.failure)
  return prepareDecoded(occurrence, spec.success)
}

/**
 * Recomputes and verifies a persisted operation and nested occurrence pin.
 *
 * @category validation
 * @since 4.0.0
 */
export const verify = (
  input: unknown
): Effect.Effect<
  PreparedOperation,
  | SemanticOperationError
  | SemanticOccurrenceV3.SemanticOccurrenceError
  | DigestV3.DigestInputError
  | DigestV3.DigestCryptoError,
  Crypto.Crypto
> => {
  const pin = decodeSnapshot(
    OperationPin,
    input,
    ErrorCodes.InvalidPin,
    "semantic operation pin"
  )
  if (Result.isFailure(pin)) return Effect.fail(pin.failure)
  return Effect.flatMap(
    SemanticOccurrenceV3.verify(pin.success.document.occurrence),
    (occurrence) =>
      Effect.flatMap(
        DigestV3.operation(pin.success.document),
        (computed) =>
          computed !== pin.success.operationDigest
            ? Effect.fail(error(
              ErrorCodes.DigestMismatch,
              "Semantic operation digest does not match its document"
            ))
            : Effect.succeed(admit(
              pin.success.document,
              pin.success.operationDigest,
              occurrence
            ))
      )
  )
}

/**
 * Returns the exact native naming coordinates of a prepared operation.
 *
 * **Details**
 *
 * Activity attempts intentionally share one logical name; their positive
 * attempt is supplied through native `Activity.CurrentAttempt`. Timer,
 * deferred, and race generations participate in their native name.
 *
 * @category mapping
 * @since 4.0.0
 */
export const nativeCoordinates = (
  operation: PreparedOperation
): Result.Result<
  EffectWorkflowOperationV3.Coordinates,
  SemanticOperationError
> => {
  if (!isPrepared(operation)) {
    return Result.fail(error(
      ErrorCodes.UnpreparedOperation,
      "Native coordinates require an exact PreparedOperation"
    ))
  }
  const document = operation.document
  switch (document._tag) {
    case "Activity":
      return Result.succeed({
        _tag: "Activity",
        coordinateVersion: 3,
        occurrenceDigest: document.occurrence.occurrenceDigest,
        operationId: document.operationId
      })
    case "Timer":
      return Result.succeed({
        _tag: "Timer",
        coordinateVersion: 3,
        occurrenceDigest: document.occurrence.occurrenceDigest,
        operationId: document.operationId,
        generation: document.generation
      })
    case "Deferred":
      return Result.succeed({
        _tag: "Deferred",
        coordinateVersion: 3,
        occurrenceDigest: document.occurrence.occurrenceDigest,
        operationId: document.operationId,
        generation: document.generation
      })
    case "Race":
      return Result.succeed({
        _tag: "Race",
        coordinateVersion: 3,
        occurrenceDigest: document.occurrence.occurrenceDigest,
        operationId: document.operationId,
        generation: document.generation
      })
    case "RetryScheduleToClose":
      return Result.succeed({
        _tag: "RetryScheduleToClose",
        coordinateVersion: 3,
        occurrenceDigest: document.occurrence.occurrenceDigest,
        operationId: document.operationId,
        generation: document.generation
      })
  }
}
