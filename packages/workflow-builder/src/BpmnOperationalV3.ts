/**
 * Portable operational controls for protocol-v3 BPMN executions.
 *
 * **Details**
 *
 * Operational instance withdrawal is an execution-authority decision. It is
 * deliberately distinct from BPMN Cancel, Terminate End Events, and
 * compensation. This module contains only the bounded command and durable
 * audit vocabulary; it does not select or require a backend.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as ProtocolV2Wire from "./ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "./ProtocolV3Wire.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

/**
 * Version of the portable operational instance-withdrawal contract.
 *
 * @category constants
 * @since 4.0.0
 */
export const OperationalInstanceWithdrawalVersion = 1 as const

/**
 * Version of {@link RequestInstanceWithdrawalCommand}.
 *
 * @category constants
 * @since 4.0.0
 */
export const RequestInstanceWithdrawalCommandVersion = OperationalInstanceWithdrawalVersion

/**
 * Nonsecret, bounded attribution for one authorized operational decision.
 *
 * **Details**
 *
 * Credentials, claims, capabilities, free-form explanations, and policy
 * inputs are intentionally absent. These identifiers point to separately
 * retained authorization evidence without making secret or unbounded values
 * part of execution history.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WithdrawalAuditAttribution = Schema.Struct({
  actorId: ProtocolV3Wire.Identifier,
  policyId: ProtocolV3Wire.Identifier,
  policyVersion: ProtocolV3Wire.Identifier,
  policyDecisionId: ProtocolV3Wire.Identifier
}).annotate({
  identifier: "WorkflowBpmnOperationalV3WithdrawalAuditAttribution",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WithdrawalAuditAttribution}.
 *
 * @category models
 * @since 4.0.0
 */
export type WithdrawalAuditAttribution = Schema.Schema.Type<
  typeof WithdrawalAuditAttribution
>

/**
 * Requests the atomic operational withdrawal of one root BPMN instance.
 *
 * **Details**
 *
 * The command carries no timestamp. The kernel assigns the only authoritative
 * time from its `services.now` boundary. `requestId` is atomic so a native
 * adapter may reuse it directly as a post-commit change identity.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequestInstanceWithdrawalCommand = Schema.Struct({
  commandVersion: Schema.Literal(
    RequestInstanceWithdrawalCommandVersion
  ),
  rootScopeInstanceId: ProtocolV3Wire.Identifier,
  requestId: ProtocolV3Wire.AtomicIdentifier,
  attribution: WithdrawalAuditAttribution,
  reasonCode: Schema.optionalKey(ProtocolV3Wire.Identifier)
}).annotate({
  identifier: "WorkflowBpmnOperationalV3RequestInstanceWithdrawalCommand",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RequestInstanceWithdrawalCommand}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequestInstanceWithdrawalCommand = Schema.Schema.Type<
  typeof RequestInstanceWithdrawalCommand
>

/**
 * Exact durable evidence for one committed operational withdrawal.
 *
 * @category schemas
 * @since 4.0.0
 */
export const OperationalInstanceWithdrawalRecord = Schema.Struct({
  withdrawalVersion: Schema.Literal(
    OperationalInstanceWithdrawalVersion
  ),
  command: RequestInstanceWithdrawalCommand,
  requestedAt: ProtocolV2Wire.Timestamp
}).annotate({
  identifier: "WorkflowBpmnOperationalV3OperationalInstanceWithdrawalRecord",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link OperationalInstanceWithdrawalRecord}.
 *
 * @category models
 * @since 4.0.0
 */
export type OperationalInstanceWithdrawalRecord = Schema.Schema.Type<
  typeof OperationalInstanceWithdrawalRecord
>
