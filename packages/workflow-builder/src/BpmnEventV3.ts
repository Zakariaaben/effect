/**
 * Portable bindings and trusted receipts for executable BPMN catch events.
 *
 * **Details**
 *
 * This module contains no inbox, broker, timer store, clock, or Effect
 * Workflow integration. A trusted application ingress may translate an
 * authenticated external message into a {@link MessageReceipt}; the BPMN
 * kernel validates that receipt against the immutable binding committed by
 * the executable fingerprint.
 *
 * Message correlation is an exact, ordered, non-empty composite key. It is
 * intentionally distinct from `deliveryId`, which provides idempotency for
 * one accepted external fact. Predicate correlation, wildcard correlation,
 * buffering before a wait opens, and BPMN Signal broadcast are outside this
 * contract.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as BpmnModel from "./BpmnModel.ts"
import * as ProtocolV3Wire from "./ProtocolV3Wire.ts"
import * as SemanticOperationV3 from "./SemanticOperationV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = ProtocolV3Wire.Identifier

/**
 * Version of one externally compiled BPMN Message catch binding.
 *
 * @category constants
 * @since 4.0.0
 */
export const MessageBindingVersion = 1 as const

/**
 * Version of one exact external-message authorization policy pin.
 *
 * @category constants
 * @since 4.0.0
 */
export const AuthorizationPolicyVersion = 1 as const

/**
 * Version of one trusted external-message receipt.
 *
 * @category constants
 * @since 4.0.0
 */
export const MessageReceiptVersion = 1 as const

/**
 * Version of the optimistic message-delivery command.
 *
 * @category constants
 * @since 4.0.0
 */
export const DeliverMessageCommandVersion = 1 as const

/**
 * Version of one durable timer-arm receipt.
 *
 * @category constants
 * @since 4.0.0
 */
export const TimerArmReceiptVersion = 1 as const

/**
 * Version of the optimistic timer-arm acknowledgement command.
 *
 * @category constants
 * @since 4.0.0
 */
export const AcknowledgeTimerArmCommandVersion = 1 as const

/**
 * Version of the optimistic due-timer observation command.
 *
 * @category constants
 * @since 4.0.0
 */
export const ObserveDueTimerCommandVersion = 1 as const

/**
 * Exact immutable build selected to authorize one external BPMN Message.
 *
 * **Details**
 *
 * The policy implementation is application-owned and never persisted here.
 * These fields make its selected meaning inspectable and fingerprintable.
 * The runtime kernel must compare the complete pin, not only `policyId`,
 * before accepting a receipt.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AuthorizationPolicyPin = Schema.Struct({
  policyVersion: Schema.Literal(AuthorizationPolicyVersion),
  policyId: ProtocolV3Wire.Identifier,
  deploymentId: ProtocolV3Wire.Identifier,
  buildDigest: ProtocolV3Wire.BuildDigest
}).annotate({
  identifier: "WorkflowBpmnEventV3AuthorizationPolicyPin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AuthorizationPolicyPin}.
 *
 * @category models
 * @since 4.0.0
 */
export type AuthorizationPolicyPin = Schema.Schema.Type<
  typeof AuthorizationPolicyPin
>

/**
 * One exact complete composite correlation key.
 *
 * **Details**
 *
 * Components remain ordered because changing component order changes the
 * business key. Kernel limits independently bound component count and
 * canonical byte size.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CorrelationKey = Schema.NonEmptyArray(
  ProtocolV3Wire.AtomicIdentifier
).annotate({
  identifier: "WorkflowBpmnEventV3CorrelationKey",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CorrelationKey}.
 *
 * @category models
 * @since 4.0.0
 */
export type CorrelationKey = Schema.Schema.Type<typeof CorrelationKey>

/**
 * Immutable executable meaning of one BPMN Message intermediate catch.
 *
 * **Details**
 *
 * BPMN identifies the Message but does not provide an executable Effect
 * `Schema`, authorization implementation, or deployment-specific correlation
 * evaluator. Those explicit external authorities are therefore committed by
 * this binding instead of being inferred from XML.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessageBinding = Schema.Struct({
  bindingVersion: Schema.Literal(MessageBindingVersion),
  catchEventNodeId: Identifier,
  messageRef: Identifier,
  correlationExpression: BpmnModel.Expression,
  payloadContract: SemanticOperationV3.ArtifactCodecContract,
  authorizationPolicy: AuthorizationPolicyPin
}).annotate({
  identifier: "WorkflowBpmnEventV3MessageBinding",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MessageBinding}.
 *
 * @category models
 * @since 4.0.0
 */
export type MessageBinding = Schema.Schema.Type<typeof MessageBinding>

/**
 * Store-owned attribution proving which exact policy admitted a message.
 *
 * **Details**
 *
 * Arbitrary claims, credentials, payload-derived explanations, and policy
 * errors are deliberately excluded from durable BPMN state.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AuthorizationDecision = Schema.Struct({
  policy: AuthorizationPolicyPin,
  decisionId: ProtocolV3Wire.Identifier,
  actorId: ProtocolV3Wire.Identifier
}).annotate({
  identifier: "WorkflowBpmnEventV3AuthorizationDecision",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AuthorizationDecision}.
 *
 * @category models
 * @since 4.0.0
 */
export type AuthorizationDecision = Schema.Schema.Type<
  typeof AuthorizationDecision
>

/**
 * One authenticated and codec-validated external BPMN Message fact.
 *
 * **Details**
 *
 * In this transient profile without a durable inbox, `acceptedAt` is assigned
 * by the kernel authority at the atomic acceptance boundary and must equal the
 * trusted kernel clock supplied to `deliverMessage`. It is never copied from a
 * sender-controlled timestamp, and a delayed command cannot backdate it to
 * outrank a Timer.
 *
 * This receipt does not imply that the builder contains a message broker or
 * durable inbox. This profile is transient-active-only: an ingress may target
 * an already-open arm, while early-message buffering remains an explicit
 * application-owned capability.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessageReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(MessageReceiptVersion),
  deliveryId: ProtocolV3Wire.Identifier,
  messageRef: Identifier,
  correlationKey: CorrelationKey,
  payloadContract: SemanticOperationV3.ArtifactCodecContract,
  payload: Schema.Json,
  acceptedAt: ProtocolV3Wire.Timestamp,
  authorization: AuthorizationDecision
}).annotate({
  identifier: "WorkflowBpmnEventV3MessageReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link MessageReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type MessageReceipt = Schema.Schema.Type<typeof MessageReceipt>

/**
 * Exact optimistic target of a waiting catch-event arm.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CatchArmTarget = Schema.Struct({
  waitGroupId: Identifier,
  armId: Identifier,
  scopeInstanceId: Identifier,
  catchEventNodeId: Identifier,
  tokenId: Identifier,
  generation: ProtocolV3Wire.PositiveSafeInt
}).annotate({
  identifier: "WorkflowBpmnEventV3CatchArmTarget",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CatchArmTarget}.
 *
 * @category models
 * @since 4.0.0
 */
export type CatchArmTarget = Schema.Schema.Type<typeof CatchArmTarget>

/**
 * Delivers one trusted Message receipt to one exact active catch arm.
 *
 * **Details**
 *
 * `acceptedAt` is not sender or transport evidence. For a new active
 * acceptance it must equal the trusted kernel clock used by the command.
 *
 * @category schemas
 * @since 4.0.0
 */
export const DeliverMessageCommand = Schema.Struct({
  commandVersion: Schema.Literal(DeliverMessageCommandVersion),
  target: CatchArmTarget,
  receipt: MessageReceipt
}).annotate({
  identifier: "WorkflowBpmnEventV3DeliverMessageCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link DeliverMessageCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeliverMessageCommand = Schema.Schema.Type<
  typeof DeliverMessageCommand
>

/**
 * Durable acknowledgement returned by an application-selected timer backend.
 *
 * **Details**
 *
 * The portable kernel does not interpret backend-specific payloads. The
 * stable backend, schedule, and receipt identities provide idempotency and
 * audit evidence without pretending that the builder owns a timer table.
 *
 * @category schemas
 * @since 4.0.0
 */
export const TimerArmReceipt = Schema.Struct({
  receiptVersion: Schema.Literal(TimerArmReceiptVersion),
  backendId: ProtocolV3Wire.Identifier,
  scheduleId: ProtocolV3Wire.Identifier,
  receiptId: ProtocolV3Wire.Identifier,
  armedAt: ProtocolV3Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnEventV3TimerArmReceipt",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link TimerArmReceipt}.
 *
 * @category models
 * @since 4.0.0
 */
export type TimerArmReceipt = Schema.Schema.Type<typeof TimerArmReceipt>

/**
 * Acknowledges durable scheduling of one exact timer arm.
 *
 * @category schemas
 * @since 4.0.0
 */
export const AcknowledgeTimerArmCommand = Schema.Struct({
  commandVersion: Schema.Literal(AcknowledgeTimerArmCommandVersion),
  target: CatchArmTarget,
  timerId: Identifier,
  receipt: TimerArmReceipt
}).annotate({
  identifier: "WorkflowBpmnEventV3AcknowledgeTimerArmCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link AcknowledgeTimerArmCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type AcknowledgeTimerArmCommand = Schema.Schema.Type<
  typeof AcknowledgeTimerArmCommand
>

/**
 * Observes that one exact timer arm may now be due.
 *
 * **Details**
 *
 * This is a wake-up hint, not authority to select that timer blindly. The
 * kernel compares `observedAt` with every deadline in the same waiting choice
 * and deterministically selects the earliest eligible timer.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ObserveDueTimerCommand = Schema.Struct({
  commandVersion: Schema.Literal(ObserveDueTimerCommandVersion),
  target: CatchArmTarget,
  timerId: Identifier,
  observedAt: ProtocolV3Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnEventV3ObserveDueTimerCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ObserveDueTimerCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type ObserveDueTimerCommand = Schema.Schema.Type<
  typeof ObserveDueTimerCommand
>
