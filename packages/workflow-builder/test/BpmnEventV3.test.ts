import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as BpmnEventV3 from "../src/BpmnEventV3.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const schemaDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.SchemaDigest
)(digest("a"))

const buildDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.BuildDigest
)(digest("b"))

const payloadContract = () => ({
  _tag: "ArtifactCodec" as const,
  contractReferenceVersion: 1 as const,
  codecKey: "order-message-json",
  schemaDigest
})

const authorizationPolicy = () => ({
  policyVersion: 1 as const,
  policyId: "orders-message-policy",
  deploymentId: "orders-production",
  buildDigest
})

const authorization = () => ({
  policy: authorizationPolicy(),
  decisionId: "decision-42",
  actorId: "orders-ingress"
})

const messageBinding = () => ({
  bindingVersion: 1 as const,
  catchEventNodeId: "wait-for-payment",
  messageRef: "PaymentReceived",
  correlationExpression: {
    language: "feel",
    version: "1.0",
    source: "[orderId, tenantId]"
  },
  payloadContract: payloadContract(),
  authorizationPolicy: authorizationPolicy()
})

const messageReceipt = (
  deliveryId = "delivery-42",
  correlationKey: ReadonlyArray<string> = ["tenant-1", "order-42"]
) => ({
  receiptVersion: 1 as const,
  deliveryId,
  messageRef: "PaymentReceived",
  correlationKey,
  payloadContract: payloadContract(),
  payload: {
    orderId: "order-42",
    amount: 1250
  },
  acceptedAt: "2026-07-24T08:09:10.011Z",
  authorization: authorization()
})

const catchArmTarget = (generation = 1) => ({
  waitGroupId: "wait-group-7",
  armId: "message-arm-0",
  scopeInstanceId: "scope-1",
  catchEventNodeId: "wait-for-payment",
  tokenId: "token-9",
  generation
})

const timerArmReceipt = () => ({
  receiptVersion: 1 as const,
  backendId: "effect-workflow",
  scheduleId: "schedule-7",
  receiptId: "timer-arm-receipt-7",
  armedAt: "2026-07-24T08:09:11.012Z"
})

describe("BpmnEventV3", () => {
  it("decodes complete immutable message authorities and trusted receipts", () => {
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(BpmnEventV3.MessageBinding)(messageBinding()),
      messageBinding()
    )
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(BpmnEventV3.MessageReceipt)(messageReceipt()),
      messageReceipt()
    )

    const command = {
      commandVersion: 1 as const,
      target: catchArmTarget(),
      receipt: messageReceipt()
    }
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(BpmnEventV3.DeliverMessageCommand)(command),
      command
    )
  })

  it("keeps delivery identity independent from exact composite correlation", () => {
    const decode = Schema.decodeUnknownSync(BpmnEventV3.MessageReceipt)
    const first = decode(messageReceipt("delivery-a"))
    const retryOfAnotherDelivery = decode(messageReceipt("delivery-b"))

    assert.notStrictEqual(first.deliveryId, retryOfAnotherDelivery.deliveryId)
    assert.deepStrictEqual(
      first.correlationKey,
      retryOfAnotherDelivery.correlationKey
    )
    assert.deepStrictEqual(first.correlationKey, ["tenant-1", "order-42"])

    const duplicateComponents = decode(
      messageReceipt("delivery-c", ["tenant-1", "tenant-1"])
    )
    assert.deepStrictEqual(duplicateComponents.correlationKey, [
      "tenant-1",
      "tenant-1"
    ])
  })

  it("requires a non-empty ordered key of bounded atomic components", () => {
    const decode = Schema.decodeUnknownSync(BpmnEventV3.CorrelationKey)
    const boundary = "a".repeat(ProtocolV3Wire.MaximumAtomicIdentifierBytes)

    assert.deepStrictEqual(decode(["tenant", "order"]), [
      "tenant",
      "order"
    ])
    assert.deepStrictEqual(decode([boundary]), [boundary])

    for (
      const invalid of [
        [],
        [""],
        ["\ud800"],
        [
          "a".repeat(
            ProtocolV3Wire.MaximumAtomicIdentifierBytes + 1
          )
        ]
      ]
    ) {
      assert.throws(() => decode(invalid))
    }
  })

  it("rejects excess properties at every externally supplied boundary", () => {
    const decodeBinding = Schema.decodeUnknownSync(
      BpmnEventV3.MessageBinding
    )
    const decodeReceipt = Schema.decodeUnknownSync(
      BpmnEventV3.MessageReceipt
    )
    const decodeDelivery = Schema.decodeUnknownSync(
      BpmnEventV3.DeliverMessageCommand
    )
    const decodeArm = Schema.decodeUnknownSync(
      BpmnEventV3.AcknowledgeTimerArmCommand
    )
    const decodeObservation = Schema.decodeUnknownSync(
      BpmnEventV3.ObserveDueTimerCommand
    )

    assert.throws(() =>
      decodeBinding({
        ...messageBinding(),
        unexpected: true
      })
    )
    assert.throws(() =>
      decodeBinding({
        ...messageBinding(),
        authorizationPolicy: {
          ...authorizationPolicy(),
          unexpected: true
        }
      })
    )
    assert.throws(() =>
      decodeBinding({
        ...messageBinding(),
        payloadContract: {
          ...payloadContract(),
          unexpected: true
        }
      })
    )
    assert.throws(() =>
      decodeReceipt({
        ...messageReceipt(),
        authorization: {
          ...authorization(),
          unexpected: true
        }
      })
    )
    assert.throws(() =>
      decodeDelivery({
        commandVersion: 1,
        target: {
          ...catchArmTarget(),
          unexpected: true
        },
        receipt: messageReceipt()
      })
    )
    assert.throws(() =>
      decodeArm({
        commandVersion: 1,
        target: catchArmTarget(),
        timerId: "timer-7",
        receipt: {
          ...timerArmReceipt(),
          unexpected: true
        }
      })
    )
    assert.throws(() =>
      decodeObservation({
        commandVersion: 1,
        target: catchArmTarget(),
        timerId: "timer-7",
        observedAt: "2026-07-24T08:10:00.000Z",
        unexpected: true
      })
    )
  })

  it("requires a positive safe generation on every exact catch target", () => {
    const decodeTarget = Schema.decodeUnknownSync(BpmnEventV3.CatchArmTarget)

    assert.deepStrictEqual(decodeTarget(catchArmTarget(1)), catchArmTarget(1))
    assert.deepStrictEqual(
      decodeTarget(catchArmTarget(Number.MAX_SAFE_INTEGER)),
      catchArmTarget(Number.MAX_SAFE_INTEGER)
    )

    for (
      const generation of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY
      ]
    ) {
      assert.throws(() => decodeTarget(catchArmTarget(generation)))
    }

    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.DeliverMessageCommand)({
        commandVersion: 1,
        target: catchArmTarget(0),
        receipt: messageReceipt()
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.AcknowledgeTimerArmCommand)({
        commandVersion: 1,
        target: catchArmTarget(0),
        timerId: "timer-7",
        receipt: timerArmReceipt()
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.ObserveDueTimerCommand)({
        commandVersion: 1,
        target: catchArmTarget(0),
        timerId: "timer-7",
        observedAt: "2026-07-24T08:10:00.000Z"
      })
    )
  })

  it("requires canonical trusted timestamps on message and timer receipts", () => {
    const decodeMessage = Schema.decodeUnknownSync(
      BpmnEventV3.MessageReceipt
    )
    const decodeArmReceipt = Schema.decodeUnknownSync(
      BpmnEventV3.TimerArmReceipt
    )
    const decodeObservation = Schema.decodeUnknownSync(
      BpmnEventV3.ObserveDueTimerCommand
    )

    for (
      const invalid of [
        "2026-07-24T08:09:10Z",
        "2026-07-24T08:09:10.011+00:00",
        "2026-02-29T08:09:10.011Z",
        "2026-07-24T24:09:10.011Z"
      ]
    ) {
      assert.throws(() =>
        decodeMessage({
          ...messageReceipt(),
          acceptedAt: invalid
        })
      )
      assert.throws(() =>
        decodeArmReceipt({
          ...timerArmReceipt(),
          armedAt: invalid
        })
      )
      assert.throws(() =>
        decodeObservation({
          commandVersion: 1,
          target: catchArmTarget(),
          timerId: "timer-7",
          observedAt: invalid
        })
      )
    }
  })

  it("decodes timer arm acknowledgements and due observations without backend payloads", () => {
    const acknowledgement = {
      commandVersion: 1 as const,
      target: catchArmTarget(),
      timerId: "timer-7",
      receipt: timerArmReceipt()
    }
    const observation = {
      commandVersion: 1 as const,
      target: catchArmTarget(),
      timerId: "timer-7",
      observedAt: "2026-07-24T08:10:00.000Z"
    }

    assert.deepStrictEqual(
      Schema.decodeUnknownSync(
        BpmnEventV3.AcknowledgeTimerArmCommand
      )(acknowledgement),
      acknowledgement
    )
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(
        BpmnEventV3.ObserveDueTimerCommand
      )(observation),
      observation
    )
  })

  it("rejects wrong versions, invalid policy pins, and non-JSON payloads", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.MessageBinding)({
        ...messageBinding(),
        bindingVersion: 2
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.MessageReceipt)({
        ...messageReceipt(),
        receiptVersion: 2
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.MessageReceipt)({
        ...messageReceipt(),
        payload: undefined
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.AuthorizationPolicyPin)({
        ...authorizationPolicy(),
        buildDigest: digest("A")
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.TimerArmReceipt)({
        ...timerArmReceipt(),
        receiptVersion: 2
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.DeliverMessageCommand)({
        commandVersion: 2,
        target: catchArmTarget(),
        receipt: messageReceipt()
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.AcknowledgeTimerArmCommand)({
        commandVersion: 2,
        target: catchArmTarget(),
        timerId: "timer-7",
        receipt: timerArmReceipt()
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(BpmnEventV3.ObserveDueTimerCommand)({
        commandVersion: 2,
        target: catchArmTarget(),
        timerId: "timer-7",
        observedAt: "2026-07-24T08:10:00.000Z"
      })
    )
  })
})
