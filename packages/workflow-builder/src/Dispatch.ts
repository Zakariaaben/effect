/**
 * Strict durable activity-dispatch and worker-result wire models.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as Command from "./Command.ts"
import * as Event from "./Event.ts"
import * as Fingerprint from "./Fingerprint.ts"
import * as PlanStore from "./PlanStore.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A narrowed command envelope that can dispatch one activity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ScheduleActivityCommand = Schema.Struct({
  commandVersion: Schema.Literal(1),
  commandId: Schema.NonEmptyString,
  payload: Command.ScheduleActivity
}).annotate({
  identifier: "WorkflowScheduleActivityCommandEnvelope",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ScheduleActivityCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ScheduleActivityCommand = Schema.Schema.Type<typeof ScheduleActivityCommand>

/**
 * A tenant-scoped immutable dispatch identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchKey = Schema.Struct({
  tenantId: Schema.NonEmptyString,
  intentId: Schema.NonEmptyString
}).annotate({
  identifier: "WorkflowDispatchKey",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DispatchKey}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchKey = Schema.Schema.Type<typeof DispatchKey>

/**
 * Append-ready dispatch intent committed with its source schedule event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityDispatchDraft = Schema.Struct({
  dispatchVersion: Schema.Literal(1),
  _tag: Schema.Literal("Activity"),
  intentId: Schema.NonEmptyString,
  sourceEventId: Schema.NonEmptyString,
  command: ScheduleActivityCommand,
  target: PlanStore.DispatchTarget
}).annotate({
  identifier: "WorkflowActivityDispatchDraft",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityDispatchDraft}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityDispatchDraft = Schema.Schema.Type<typeof ActivityDispatchDraft>

/**
 * Immutable activity work materialized by transactional execution storage.
 *
 * **Details**
 *
 * This is the authoritative worker payload. Broker messages carry a pointer and
 * digest; workers reload this record before acquiring an attempt lease.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityDispatch = Schema.Struct({
  dispatchVersion: Schema.Literal(1),
  _tag: Schema.Literal("Activity"),
  intentId: Schema.NonEmptyString,
  sourceEventId: Schema.NonEmptyString,
  tenantId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  sourceEventSequence: NonNegativeInt,
  enqueuedAt: Event.Timestamp,
  command: ScheduleActivityCommand,
  target: PlanStore.DispatchTarget
}).annotate({
  identifier: "WorkflowActivityDispatch",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ActivityDispatch}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityDispatch = Schema.Schema.Type<typeof ActivityDispatch>

/**
 * Broker-safe pointer to an authoritative stored dispatch.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DispatchPointer = Schema.Struct({
  pointerVersion: Schema.Literal(1),
  key: DispatchKey,
  dispatchDigest: Fingerprint.Digest
}).annotate({
  identifier: "WorkflowDispatchPointer",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DispatchPointer}.
 *
 * @category models
 * @since 4.0.0
 */
export type DispatchPointer = Schema.Schema.Type<typeof DispatchPointer>

/**
 * Encoded successful worker result before the store derives its semantic event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Succeeded = Schema.TaggedStruct("Succeeded", {
  output: Event.EncodedValues
}).annotate({
  identifier: "WorkflowActivityDeliverySucceeded",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Succeeded}.
 *
 * @category models
 * @since 4.0.0
 */
export type Succeeded = Schema.Schema.Type<typeof Succeeded>

/**
 * Encoded failed worker result before the store derives its semantic event.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Failed = Schema.TaggedStruct("Failed", {
  failure: Schema.Json
}).annotate({
  identifier: "WorkflowActivityDeliveryFailed",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Failed}.
 *
 * @category models
 * @since 4.0.0
 */
export type Failed = Schema.Schema.Type<typeof Failed>

/**
 * Strict encoded outcome accepted from an activity worker.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ActivityResult = Schema.Union([Succeeded, Failed]).annotate({
  identifier: "WorkflowActivityDeliveryResult"
})

/**
 * The decoded type of {@link ActivityResult}.
 *
 * @category models
 * @since 4.0.0
 */
export type ActivityResult = Schema.Schema.Type<typeof ActivityResult>
