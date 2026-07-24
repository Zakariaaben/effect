import { BpmnExecutable, BpmnKernel } from "@effect/workflow-builder"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="urn:example:approval">
  <bpmn:process id="approval" isExecutable="true">
    <bpmn:startEvent id="start"/>
    <bpmn:task id="review"/>
    <bpmn:endEvent id="approved"/>
    <bpmn:sequenceFlow id="start_review" sourceRef="start" targetRef="review"/>
    <bpmn:sequenceFlow id="review_approved" sourceRef="review" targetRef="approved"/>
  </bpmn:process>
</bpmn:definitions>`

const getOrThrow = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.promise(async () => {
      const copy = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(copy).set(bytes)
      return new Uint8Array(
        await globalThis.crypto.subtle.digest(algorithm, copy)
      )
    })
})

const program = Effect.gen(function*() {
  const compiled = yield* BpmnExecutable.compileXml(xml, {
    importOptions: {
      importId: "approval-example",
      expressionLanguageBindings: []
    },
    rootProcessId: "approval",
    limits: {
      maxAutomaticTransitions: 1_000,
      maxMultiInstanceCardinality: 128
    },
    evaluatorBindings: []
  })

  const services: BpmnKernel.Services = {
    now: "2026-07-23T00:00:00.000Z"
  }

  const initialized = getOrThrow(
    BpmnKernel.initialize(compiled.kernel, services)
  )
  const review = initialized.state.tokens.find((token) =>
    token.status === "active" &&
    token.position._tag === "AtNode" &&
    token.position.nodeId === "review"
  )
  if (review === undefined) {
    throw new Error("review task was not activated")
  }

  const completed = getOrThrow(BpmnKernel.completeTask(
    compiled.kernel,
    initialized.state,
    {
      scopeInstanceId: review.scopeInstanceId,
      taskNodeId: "review",
      tokenId: review.tokenId
    },
    services
  ))

  console.log(completed.state.status)
  // completed
})

Effect.runPromise(program.pipe(
  Effect.provideService(Crypto.Crypto, crypto)
))
