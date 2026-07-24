import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as BpmnEventV3 from "../src/BpmnEventV3.ts"
import * as BpmnExecutable from "../src/BpmnExecutable.ts"
import type * as BpmnExecutionState from "../src/BpmnExecutionState.ts"
import * as BpmnKernel from "../src/BpmnKernel.ts"
import * as BpmnModel from "../src/BpmnModel.ts"
import * as BpmnXml from "../src/BpmnXml.ts"
import type * as Diagnostic from "../src/Diagnostic.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const modelNamespace = "http://www.omg.org/spec/BPMN/20100524/MODEL"
const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance"
const targetNamespace = "urn:workflow:catch-event-executable"
const expressionLanguage = "urn:expression:catch-event"
const expressionVersion = "1.0.0"
const rootProcessId = "catch_process"

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const evaluatorBuildDigest = Schema.decodeUnknownSync(
  ProtocolV2Wire.BuildDigest
)(digest("2"))
const payloadSchemaDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.SchemaDigest
)(digest("3"))
const policyBuildDigest = Schema.decodeUnknownSync(
  ProtocolV3Wire.BuildDigest
)(digest("4"))

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))
})

const limits: BpmnKernel.KernelLimits = {
  maxAutomaticTransitions: 1_000,
  maxExecutionInputCanonicalBytes: 1_048_576,
  maxExecutionStateCanonicalBytes: 8_388_608,
  maxTransitionJournalEvents: 10_000,
  maxTransitionJournalCanonicalBytes: 16_777_216,
  maxCatchWaitArms: 32,
  maxTimerDelayMillis: 31_536_000_000,
  maxTimerExpressionUtf8Bytes: 4_096,
  maxMessageCorrelationComponents: 16,
  maxMessageCorrelationCanonicalBytes: 16_384,
  maxMessagePayloadCanonicalBytes: 1_048_576,
  maxMultiInstanceCardinality: 128,
  maxMultiInstanceCollectionCanonicalBytes: 1_048_576,
  maxMultiInstanceItemCanonicalBytes: 262_144,
  maxMultiInstanceOutputCanonicalBytes: 1_048_576,
  maxMultiInstanceItemOutputCanonicalBytes: 262_144
}

const evaluatorBinding: BpmnExecutable.CompileXmlOptions["evaluatorBindings"][number] = {
  language: expressionLanguage,
  languageVersion: expressionVersion,
  build: {
    id: "catch-event-expressions",
    version: "1.0.0",
    deploymentId: "catch-event-expressions-test",
    buildDigest: evaluatorBuildDigest
  },
  limits: {
    maxSourceUtf8Bytes: 4_096,
    maxContextCanonicalBytes: 1_048_576,
    maxSteps: 10_000,
    timeoutMillis: 1_000
  }
}

const messageBinding = (
  catchEventNodeId: string,
  correlationSource: string = "[$input.tenantId, $input.orderId]"
): BpmnEventV3.MessageBinding => ({
  bindingVersion: BpmnEventV3.MessageBindingVersion,
  catchEventNodeId,
  messageRef: "payment_message",
  correlationExpression: {
    language: expressionLanguage,
    version: expressionVersion,
    source: correlationSource
  },
  payloadContract: {
    _tag: "ArtifactCodec",
    contractReferenceVersion: 1,
    codecKey: "payment-message@1",
    schemaDigest: payloadSchemaDigest
  },
  authorizationPolicy: {
    policyVersion: BpmnEventV3.AuthorizationPolicyVersion,
    policyId: "payment-message-policy",
    deploymentId: "payment-message-policy-test",
    buildDigest: policyBuildDigest
  }
})

const options = (
  messageBindings: ReadonlyArray<BpmnEventV3.MessageBinding>
): BpmnExecutable.CompileXmlOptions => ({
  importOptions: {
    importId: "catch-event-executable",
    locator: "memory://catch-event-executable.bpmn",
    expressionLanguageBindings: [{
      language: expressionLanguage,
      version: expressionVersion
    }]
  },
  rootProcessId,
  limits,
  evaluatorBindings: [evaluatorBinding],
  messageBindings
})

const definitions = (contents: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="${modelNamespace}"
  xmlns:xsi="${xsiNamespace}"
  xmlns:tns="${targetNamespace}"
  targetNamespace="${targetNamespace}"
  expressionLanguage="${expressionLanguage}">
  ${contents}
</bpmn:definitions>`

const messageXml = (): string =>
  definitions(`<bpmn:message id="payment_message" name="Payment received"/>
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="start">
      <bpmn:outgoing>tns:to_message</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:intermediateCatchEvent id="catch_message">
      <bpmn:incoming>tns:to_message</bpmn:incoming>
      <bpmn:outgoing>tns:message_done</bpmn:outgoing>
      <bpmn:messageEventDefinition messageRef="tns:payment_message"/>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="end">
      <bpmn:incoming>tns:message_done</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="to_message" sourceRef="start" targetRef="catch_message"/>
    <bpmn:sequenceFlow id="message_done" sourceRef="catch_message" targetRef="end"/>
  </bpmn:process>`)

const timerXml = (
  timerElement: "timeDuration" | "timeDate",
  source: string
): string =>
  definitions(`<bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="start">
      <bpmn:outgoing>tns:to_timer</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:intermediateCatchEvent id="catch_timer">
      <bpmn:incoming>tns:to_timer</bpmn:incoming>
      <bpmn:outgoing>tns:timer_done</bpmn:outgoing>
      <bpmn:timerEventDefinition>
        <bpmn:${timerElement} xsi:type="bpmn:tFormalExpression">${source}</bpmn:${timerElement}>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="end">
      <bpmn:incoming>tns:timer_done</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="to_timer" sourceRef="start" targetRef="catch_timer"/>
    <bpmn:sequenceFlow id="timer_done" sourceRef="catch_timer" targetRef="end"/>
  </bpmn:process>`)

const eventBasedGatewayXml = (
  gatewayAttributes: string = "",
  timerElement: "timeDuration" | "timeDate" = "timeDuration",
  timerSource: string = "PT5M",
  secondArm: "timer" | "task" = "timer"
): string =>
  definitions(`<bpmn:message id="payment_message" name="Payment received"/>
  <bpmn:process id="${rootProcessId}" isExecutable="true">
    <bpmn:startEvent id="start">
      <bpmn:outgoing>tns:to_choice</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:eventBasedGateway
      id="choice"
      gatewayDirection="Diverging"
      instantiate="false"
      eventGatewayType="Exclusive"${gatewayAttributes}>
      <bpmn:incoming>tns:to_choice</bpmn:incoming>
      <bpmn:outgoing>tns:to_message</bpmn:outgoing>
      <bpmn:outgoing>tns:to_second</bpmn:outgoing>
    </bpmn:eventBasedGateway>
    <bpmn:intermediateCatchEvent id="catch_message">
      <bpmn:incoming>tns:to_message</bpmn:incoming>
      <bpmn:outgoing>tns:message_done</bpmn:outgoing>
      <bpmn:messageEventDefinition messageRef="tns:payment_message"/>
    </bpmn:intermediateCatchEvent>
    ${
    secondArm === "timer"
      ? `<bpmn:intermediateCatchEvent id="catch_timer">
      <bpmn:incoming>tns:to_second</bpmn:incoming>
      <bpmn:outgoing>tns:timer_done</bpmn:outgoing>
      <bpmn:timerEventDefinition>
        <bpmn:${timerElement} xsi:type="bpmn:tFormalExpression">${timerSource}</bpmn:${timerElement}>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>`
      : `<bpmn:task id="ordinary_task">
      <bpmn:incoming>tns:to_second</bpmn:incoming>
      <bpmn:outgoing>tns:timer_done</bpmn:outgoing>
    </bpmn:task>`
  }
    <bpmn:endEvent id="end">
      <bpmn:incoming>tns:message_done</bpmn:incoming>
      <bpmn:incoming>tns:timer_done</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="to_choice" sourceRef="start" targetRef="choice"/>
    <bpmn:sequenceFlow id="to_message" sourceRef="choice" targetRef="catch_message"/>
    <bpmn:sequenceFlow id="to_second" sourceRef="choice" targetRef="${
    secondArm === "timer" ? "catch_timer" : "ordinary_task"
  }"/>
    <bpmn:sequenceFlow id="message_done" sourceRef="catch_message" targetRef="end"/>
    <bpmn:sequenceFlow id="timer_done" sourceRef="${
    secondArm === "timer" ? "catch_timer" : "ordinary_task"
  }" targetRef="end"/>
  </bpmn:process>`)

const compileXml = (
  input: unknown,
  selectedOptions: unknown
): Result.Result<BpmnExecutable.CompiledXml, Diagnostic.CompilationError> =>
  Effect.runSync(
    BpmnExecutable.compileXml(input, selectedOptions).pipe(
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.result
    )
  ) as Result.Result<
    BpmnExecutable.CompiledXml,
    Diagnostic.CompilationError
  >

const success = <A>(
  result: Result.Result<A, Diagnostic.CompilationError>
): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = <A>(
  result: Result.Result<A, Diagnostic.CompilationError>
): Diagnostic.CompilationError => {
  if (Result.isSuccess(result)) {
    throw new Error("expected compilation failure")
  }
  return result.failure
}

const diagnosticCodes = (
  error: Diagnostic.CompilationError
): ReadonlyArray<string> => error.diagnostics.map((diagnostic) => diagnostic.code)

const timestamp = (value: string): ProtocolV2Wire.Timestamp => Schema.decodeUnknownSync(ProtocolV2Wire.Timestamp)(value)

const executionServices = (
  at: ProtocolV2Wire.Timestamp
): BpmnKernel.Services => ({
  now: at,
  evaluateExpression: ({ expression }) =>
    Result.succeed({
      result: expression.source === "PT5S"
        ? "PT5S"
        : ["tenant-1", "order-42"],
      steps: 1
    })
})

const catchTarget = (
  state: BpmnExecutionState.BpmnExecutionState,
  ownerNodeId: string
): {
  readonly target: BpmnEventV3.CatchArmTarget
  readonly arm: BpmnExecutionState.MessageCatchSubscription
} => {
  const arm = state.subscriptions.find((candidate) => candidate.ownerNodeId === ownerNodeId)
  if (arm === undefined || arm._tag !== "MessageCatchSubscription") {
    throw new Error(`expected Message arm '${ownerNodeId}'`)
  }
  const group = state.catchWaitGroups.find((candidate) => candidate.waitGroupId === arm.waitGroupId)
  if (group === undefined) {
    throw new Error(`expected catch wait group '${arm.waitGroupId}'`)
  }
  return {
    arm,
    target: {
      waitGroupId: group.waitGroupId,
      armId: arm.armId,
      scopeInstanceId: group.scopeInstanceId,
      catchEventNodeId: arm.ownerNodeId,
      tokenId: group.ownerTokenId,
      generation: group.generation
    }
  }
}

describe("BpmnCatchEventExecutable", () => {
  it("compiles Message, duration/date Timer, and Message/Timer event choice through XML profile v6", () => {
    const fixtures = [
      {
        name: "standalone Message",
        xml: messageXml(),
        bindings: [messageBinding("catch_message")],
        expectedDefinitions: ["MessageEventDefinition"]
      },
      {
        name: "duration Timer",
        xml: timerXml("timeDuration", "PT5M"),
        bindings: [],
        expectedDefinitions: ["TimerEventDefinition"]
      },
      {
        name: "date Timer",
        xml: timerXml("timeDate", "2030-01-02T03:04:05Z"),
        bindings: [],
        expectedDefinitions: ["TimerEventDefinition"]
      },
      {
        name: "event-based Message/Timer choice",
        xml: eventBasedGatewayXml(),
        bindings: [messageBinding("catch_message")],
        expectedDefinitions: [
          "MessageEventDefinition",
          "TimerEventDefinition"
        ]
      }
    ] as const

    for (const fixture of fixtures) {
      const selectedOptions = options(fixture.bindings)
      const compiled = success(compileXml(fixture.xml, selectedOptions))

      assert.strictEqual(
        compiled.interchange.profileId,
        "bpmn-2.0.2-core-process-di-v6",
        fixture.name
      )
      assert.strictEqual(
        compiled.interchange.profileId,
        BpmnXml.CoreProcessDiProfileId,
        fixture.name
      )
      assert.deepStrictEqual(
        compiled.kernel.messageBindings,
        fixture.bindings,
        fixture.name
      )
      assert.deepStrictEqual(
        compiled.interchange.model.flowNodes
          .filter((node) => node._tag === "IntermediateCatchEvent")
          .flatMap((node) =>
            node._tag === "IntermediateCatchEvent"
              ? node.eventDefinitions.map((definition) => definition._tag)
              : []
          )
          .sort(),
        [...fixture.expectedDefinitions].sort(),
        fixture.name
      )

      const canonical = success(BpmnXml.exportXml(
        compiled.interchange,
        { format: "compact" }
      ))
      const recompiled = success(compileXml(canonical, selectedOptions))

      assert.deepStrictEqual(
        recompiled.interchange.model,
        compiled.interchange.model,
        fixture.name
      )
      assert.strictEqual(
        success(BpmnXml.exportXml(
          recompiled.interchange,
          { format: "compact" }
        )),
        canonical,
        fixture.name
      )
      assert.strictEqual(
        recompiled.kernel.modelReference.executableFingerprint,
        compiled.kernel.modelReference.executableFingerprint,
        fixture.name
      )
    }
  })

  it("commits the complete external Message binding to the executable fingerprint", () => {
    const first = success(compileXml(
      messageXml(),
      options([messageBinding("catch_message")])
    ))
    const second = success(compileXml(
      messageXml(),
      options([
        messageBinding(
          "catch_message",
          "[$input.tenantId, $input.invoiceId]"
        )
      ])
    ))

    assert.notStrictEqual(
      first.kernel.modelReference.executableFingerprint,
      second.kernel.modelReference.executableFingerprint
    )
  })

  it("imports XML, executes an equal-deadline Message/Timer choice, and replays it after canonical recompilation", () => {
    const binding = messageBinding("catch_message")
    const selectedOptions = options([binding])
    const compiled = success(compileXml(
      eventBasedGatewayXml("", "timeDuration", "PT5S"),
      selectedOptions
    ))
    const openedAt = timestamp("2026-07-24T10:00:00.000Z")
    const deadline = timestamp("2026-07-24T10:00:05.000Z")
    const initialized = success(BpmnKernel.initialize(
      compiled.kernel,
      {
        commandVersion: BpmnKernel.InitializeCommandVersion,
        input: {
          tenantId: "tenant-1",
          orderId: "order-42"
        }
      },
      executionServices(openedAt)
    ))
    const { arm, target } = catchTarget(
      initialized.state,
      binding.catchEventNodeId
    )
    assert.deepStrictEqual(arm.correlationKey, [
      "tenant-1",
      "order-42"
    ])
    assert.strictEqual(
      initialized.state.timers[0]?.schedule.dueAt,
      deadline
    )

    const delivered = success(BpmnKernel.deliverMessage(
      compiled.kernel,
      initialized.state,
      {
        commandVersion: BpmnEventV3.DeliverMessageCommandVersion,
        target,
        receipt: {
          receiptVersion: BpmnEventV3.MessageReceiptVersion,
          deliveryId: "equal-deadline-delivery",
          messageRef: binding.messageRef,
          correlationKey: arm.correlationKey,
          payloadContract: binding.payloadContract,
          payload: {
            tenantId: "tenant-1",
            orderId: "order-42",
            amount: 1250
          },
          acceptedAt: deadline,
          authorization: {
            policy: binding.authorizationPolicy,
            decisionId: "equal-deadline-authorization",
            actorId: "trusted-ingress"
          }
        }
      },
      executionServices(deadline)
    ))

    assert.strictEqual(delivered.state.status, "completed")
    assert.strictEqual(
      delivered.state.catchWaitGroups[0]?.winner?._tag,
      "TimerWinner"
    )
    assert(
      delivered.events.some((event) =>
        event._tag === "CatchIngressFenced" &&
        event.ingressKind === "message"
      )
    )

    const journal: ReadonlyArray<BpmnKernel.TransitionEvent> = [
      ...initialized.events,
      ...delivered.events
    ]
    assert.deepStrictEqual(
      success(BpmnKernel.replay(compiled.kernel, journal)),
      delivered.state
    )

    const canonical = success(BpmnXml.exportXml(
      compiled.interchange,
      { format: "compact" }
    ))
    const recompiled = success(compileXml(canonical, selectedOptions))

    assert.deepStrictEqual(
      recompiled.interchange.model,
      compiled.interchange.model
    )
    assert.strictEqual(
      recompiled.kernel.modelReference.executableFingerprint,
      compiled.kernel.modelReference.executableFingerprint
    )
    assert.deepStrictEqual(
      success(BpmnKernel.replay(recompiled.kernel, journal)),
      delivered.state
    )
    assert.strictEqual(
      success(BpmnXml.exportXml(
        recompiled.interchange,
        { format: "compact" }
      )),
      canonical
    )
  })

  it("fails closed for absent, duplicate, unused, and mismatched Message bindings", () => {
    const exact = messageBinding("catch_message")
    const cases = [
      {
        name: "absent",
        xml: messageXml(),
        bindings: [],
        code: BpmnKernel.Codes.UnsupportedEvent
      },
      {
        name: "duplicate",
        xml: messageXml(),
        bindings: [exact, exact],
        code: BpmnKernel.Codes.InvalidKernelProfile
      },
      {
        name: "unused",
        xml: timerXml("timeDuration", "PT5M"),
        bindings: [messageBinding("catch_message")],
        code: BpmnKernel.Codes.InvalidKernelProfile
      },
      {
        name: "mismatched catch node",
        xml: messageXml(),
        bindings: [messageBinding("different_catch")],
        code: BpmnKernel.Codes.InvalidKernelProfile
      }
    ] as const

    for (const candidate of cases) {
      const rejected = failure(compileXml(
        candidate.xml,
        options(candidate.bindings)
      ))
      assert.include(
        diagnosticCodes(rejected),
        candidate.code,
        candidate.name
      )
    }
  })

  it("rejects unsupported event definitions and event-gateway modes before executable admission", () => {
    const validMessage = messageXml()
    const messageDefinition = `<bpmn:messageEventDefinition messageRef="tns:payment_message"/>`
    const cases = [
      {
        name: "Message operationRef",
        xml: validMessage.replace(
          messageDefinition,
          `<bpmn:messageEventDefinition messageRef="tns:payment_message" operationRef="tns:receive_payment"/>`
        ),
        code: BpmnXml.Codes.UnsupportedAttribute
      },
      {
        name: "Timer cycle",
        xml: timerXml("timeDuration", "PT5M").replaceAll(
          "timeDuration",
          "timeCycle"
        ),
        code: BpmnXml.Codes.UnsupportedElement
      },
      {
        name: "Signal catch",
        xml: validMessage.replace(
          messageDefinition,
          `<bpmn:signalEventDefinition signalRef="tns:payment_signal"/>`
        ),
        code: BpmnXml.Codes.UnsupportedElement
      },
      {
        name: "multiple catch definitions",
        xml: validMessage.replace(
          messageDefinition,
          `${messageDefinition}<bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1M</bpmn:timeDuration></bpmn:timerEventDefinition>`
        ),
        code: BpmnXml.Codes.InvalidStructure
      },
      {
        name: "parallelMultiple catch",
        xml: validMessage.replace(
          `<bpmn:intermediateCatchEvent id="catch_message">`,
          `<bpmn:intermediateCatchEvent id="catch_message" parallelMultiple="true">`
        ),
        code: BpmnXml.Codes.UnsupportedModel
      },
      {
        name: "instantiating event gateway",
        xml: eventBasedGatewayXml().replace(
          `instantiate="false"`,
          `instantiate="true"`
        ),
        code: BpmnXml.Codes.UnsupportedModel
      },
      {
        name: "parallel event gateway",
        xml: eventBasedGatewayXml().replace(
          `eventGatewayType="Exclusive"`,
          `eventGatewayType="Parallel"`
        ),
        code: BpmnXml.Codes.UnsupportedModel
      }
    ] as const

    for (const candidate of cases) {
      const rejected = failure(compileXml(
        candidate.xml,
        options([messageBinding("catch_message")])
      ))
      assert.include(
        diagnosticCodes(rejected),
        candidate.code,
        candidate.name
      )
    }
  })

  it("rejects an event-based gateway branch that is not a direct Message or Timer catch", () => {
    const rejected = failure(compileXml(
      eventBasedGatewayXml("", "timeDuration", "PT5M", "task"),
      options([messageBinding("catch_message")])
    ))

    assert.include(
      diagnosticCodes(rejected),
      BpmnModel.Codes.InvalidGateway
    )
  })
})
