import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Deployment from "../src/Deployment.ts"
import * as LinkPolicy from "../src/LinkPolicy.ts"
import * as Node from "../src/Node.ts"
import * as Registry from "../src/Registry.ts"
import * as Workflow from "../src/Workflow.ts"

const assertType = <T extends true>(value: T): void => {
  assert.isTrue(value)
}

class WorkflowAnnotation extends Context.Service<WorkflowAnnotation, string>()(
  "@effect/workflow-builder/test/Deployment/WorkflowAnnotation"
) {}

const limits = new Workflow.Limits({
  maxNodes: 8,
  maxEdges: 8,
  maxFanIn: 4,
  maxFanOut: 4,
  maxDepth: 4
})

const stepA = Node.make("Step", {
  version: "1.0.0",
  description: "first immutable implementation"
})

const stepB = Node.make("Step", {
  version: "1.0.0",
  description: "second immutable implementation"
})

const other = Node.make("Other", {
  version: "2.0.0"
})

const workflow = (
  definition: typeof stepA | typeof stepB,
  description: string
) =>
  Workflow.make("orders", {
    version: "3.0.0",
    description,
    inputs: {},
    outputs: {},
    nodes: Registry.make(definition),
    linkPolicy: LinkPolicy.allowAll,
    limits
  })

const workflowA = workflow(stepA, "first immutable definition deployment")
const workflowB = workflow(stepB, "second immutable definition deployment")
const otherWorkflow = Workflow.make("other-workflow", {
  version: "1.0.0",
  inputs: {},
  outputs: {},
  nodes: Registry.make(other),
  linkPolicy: LinkPolicy.allowAll,
  limits
})

const entries = (): Deployment.DeploymentCatalogEntries => ({
  workflowDefinitions: [
    Deployment.workflowDefinition("workflow-build-a", workflowA),
    Deployment.workflowDefinition("workflow-build-b", workflowB)
  ],
  handlerDefinitions: [
    Deployment.handlerDefinition("handler-build-a", stepA),
    Deployment.handlerDefinition("handler-build-b", stepB),
    Deployment.handlerDefinition("handler-build-other", other)
  ]
})

const failure = <A, E>(result: Result.Result<A, E>): E => {
  assert.ok(Result.isFailure(result))
  return result.failure
}

describe("Deployment", () => {
  it("recognizes exact node and workflow definition provenance", () => {
    const annotated = workflowA.annotate(WorkflowAnnotation, "value")

    assert.isTrue(Node.isDefinition(stepA))
    assert.isTrue(Workflow.isDefinition(workflowA))
    assert.isTrue(Workflow.isDefinition(annotated))
    assert.isFalse(Node.isDefinition({ ...stepA }))
    assert.isFalse(Workflow.isDefinition({ ...workflowA }))
    assert.isFalse(Workflow.isDefinition(new Proxy(workflowA, {})))
  })

  it("exposes strict schema-backed pins and errors", () => {
    const workflowPin = Schema.decodeUnknownSync(Deployment.WorkflowDefinitionPin)({
      deploymentId: "workflow-build-a",
      definitionId: "orders",
      definitionVersion: "3.0.0"
    })
    const handlerPin = Schema.decodeUnknownSync(Deployment.HandlerDefinitionPin)({
      deploymentId: "handler-build-a",
      type: "Step",
      version: "1.0.0"
    })
    const notFound = Schema.decodeUnknownSync(Deployment.DeploymentNotFound)({
      _tag: "DeploymentNotFound",
      kind: "HandlerDefinition",
      deploymentId: "missing",
      requestedName: "Step",
      requestedVersion: "1.0.0"
    })

    assert.strictEqual(workflowPin.definitionId, "orders")
    assert.strictEqual(handlerPin.type, "Step")
    assert.instanceOf(notFound, Deployment.DeploymentNotFound)
    assert.throws(() =>
      Schema.decodeUnknownSync(Deployment.HandlerDefinitionPin)({
        ...handlerPin,
        extra: true
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(Deployment.DeploymentNotFound)({
        ...notFound,
        extra: true
      })
    )
  })

  it.effect("resolves two exact deployments with the same portable identities", () =>
    Effect.gen(function*() {
      const catalog = yield* Deployment.makeMemory(entries())

      const firstWorkflow = yield* catalog.resolveWorkflowDefinition({
        deploymentId: "workflow-build-a",
        definitionId: "orders",
        definitionVersion: "3.0.0"
      })
      const secondWorkflow = yield* catalog.resolveWorkflowDefinition({
        deploymentId: "workflow-build-b",
        definitionId: "orders",
        definitionVersion: "3.0.0"
      })
      const firstHandler = yield* catalog.resolveHandlerDefinition({
        deploymentId: "handler-build-a",
        type: "Step",
        version: "1.0.0"
      })
      const secondHandler = yield* catalog.resolveHandlerDefinition({
        deploymentId: "handler-build-b",
        type: "Step",
        version: "1.0.0"
      })

      assert.strictEqual(firstWorkflow, workflowA)
      assert.strictEqual(secondWorkflow, workflowB)
      assert.notStrictEqual(firstWorkflow, secondWorkflow)
      assert.strictEqual(firstHandler, stepA)
      assert.strictEqual(secondHandler, stepB)
      assert.notStrictEqual(firstHandler, secondHandler)
    }))

  it.effect("distinguishes missing exact handlers from workflow deployments with mismatched pins", () =>
    Effect.gen(function*() {
      const catalog = yield* Deployment.makeMemory(entries())

      const missing = yield* Effect.result(catalog.resolveHandlerDefinition({
        deploymentId: "missing-handler",
        type: "Step",
        version: "1.0.0"
      }))
      const handlerMismatch = yield* Effect.result(catalog.resolveHandlerDefinition({
        deploymentId: "handler-build-a",
        type: "Other",
        version: "2.0.0"
      }))
      const workflowMismatch = yield* Effect.result(catalog.resolveWorkflowDefinition({
        deploymentId: "workflow-build-a",
        definitionId: "orders",
        definitionVersion: "9.0.0"
      }))

      const missingError = failure(missing)
      assert.instanceOf(missingError, Deployment.DeploymentNotFound)
      assert.strictEqual(missingError.deploymentId, "missing-handler")

      const handlerError = failure(handlerMismatch)
      assert.instanceOf(handlerError, Deployment.DeploymentNotFound)
      assert.strictEqual(handlerError.deploymentId, "handler-build-a")
      assert.strictEqual(handlerError.requestedName, "Other")

      const workflowError = failure(workflowMismatch)
      assert.instanceOf(workflowError, Deployment.DeploymentPinMismatch)
      if (workflowError instanceof Deployment.DeploymentPinMismatch) {
        assert.strictEqual(workflowError.expectedVersion, "9.0.0")
        assert.strictEqual(workflowError.actualVersion, "3.0.0")
      }
    }))

  it.effect("rejects duplicate deployment IDs and conflicting immutable bindings", () =>
    Effect.gen(function*() {
      const duplicate = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("same", stepA),
          Deployment.handlerDefinition("same", stepA)
        ]
      }))
      const differentObject = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("same", stepA),
          Deployment.handlerDefinition("same", stepB)
        ]
      }))
      const differentPin = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition("same", workflowA),
          Deployment.workflowDefinition("same", otherWorkflow)
        ],
        handlerDefinitions: []
      }))
      const sameBundle = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("same", stepA),
          Deployment.handlerDefinition("same", other)
        ]
      })

      assert.instanceOf(failure(duplicate), Deployment.DuplicateDeploymentId)

      const objectConflict = failure(differentObject)
      assert.instanceOf(objectConflict, Deployment.DeploymentIdConflict)
      if (objectConflict instanceof Deployment.DeploymentIdConflict) {
        assert.strictEqual(objectConflict.reason, "DifferentObject")
        assert.strictEqual(objectConflict.existingName, "Step")
        assert.strictEqual(objectConflict.requestedName, "Step")
      }

      const pinConflict = failure(differentPin)
      assert.instanceOf(pinConflict, Deployment.DeploymentIdConflict)
      if (pinConflict instanceof Deployment.DeploymentIdConflict) {
        assert.strictEqual(pinConflict.reason, "DifferentPin")
        assert.strictEqual(pinConflict.existingName, "orders")
        assert.strictEqual(pinConflict.requestedName, "other-workflow")
      }

      assert.strictEqual(
        yield* sameBundle.resolveHandlerDefinition({
          deploymentId: "same",
          type: "Step",
          version: "1.0.0"
        }),
        stepA
      )
      assert.strictEqual(
        yield* sameBundle.resolveHandlerDefinition({
          deploymentId: "same",
          type: "Other",
          version: "2.0.0"
        }),
        other
      )
    }))

  it.effect("allows one immutable handler deployment to host multiple node type and version definitions", () =>
    Effect.gen(function*() {
      const catalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("worker-bundle-2026-07-23", stepA),
          Deployment.handlerDefinition("worker-bundle-2026-07-23", other)
        ]
      })

      assert.strictEqual(
        yield* catalog.resolveHandlerDefinition({
          deploymentId: "worker-bundle-2026-07-23",
          type: "Step",
          version: "1.0.0"
        }),
        stepA
      )
      assert.strictEqual(
        yield* catalog.resolveHandlerDefinition({
          deploymentId: "worker-bundle-2026-07-23",
          type: "Other",
          version: "2.0.0"
        }),
        other
      )
    }))

  it.effect("keeps workflow and handler deployment ID domains distinct", () =>
    Effect.gen(function*() {
      const catalog = yield* Deployment.makeMemory({
        workflowDefinitions: [
          Deployment.workflowDefinition("shared-deployment", workflowA)
        ],
        handlerDefinitions: [
          Deployment.handlerDefinition("shared-deployment", stepA)
        ]
      })

      assert.strictEqual(
        yield* catalog.resolveWorkflowDefinition({
          deploymentId: "shared-deployment",
          definitionId: "orders",
          definitionVersion: "3.0.0"
        }),
        workflowA
      )
      assert.strictEqual(
        yield* catalog.resolveHandlerDefinition({
          deploymentId: "shared-deployment",
          type: "Step",
          version: "1.0.0"
        }),
        stepA
      )
    }))

  it.effect("uses collision-free tuple keys for delimiter-bearing pins", () => {
    const first = Node.make("a@b", { version: "c" })
    const second = Node.make("a", { version: "b@c" })

    return Effect.gen(function*() {
      const catalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("bundle", first),
          Deployment.handlerDefinition("bundle", second)
        ]
      })

      assert.strictEqual(
        yield* catalog.resolveHandlerDefinition({
          deploymentId: "bundle",
          type: "a@b",
          version: "c"
        }),
        first
      )
      assert.strictEqual(
        yield* catalog.resolveHandlerDefinition({
          deploymentId: "bundle",
          type: "a",
          version: "b@c"
        }),
        second
      )
      const crossed = yield* Effect.result(catalog.resolveHandlerDefinition({
        deploymentId: "bundle",
        type: "b",
        version: "a@c"
      }))
      assert.instanceOf(failure(crossed), Deployment.DeploymentNotFound)
    })
  })

  it.effect("rejects malformed and forged catalog values without invoking accessors", () =>
    Effect.gen(function*() {
      let reads = 0
      const hostile = Object.defineProperty(
        {
          deploymentId: "hostile"
        },
        "definition",
        {
          enumerable: true,
          get: () => {
            reads++
            return stepA
          }
        }
      )
      const hostileResult = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          hostile as unknown as Deployment.HandlerDefinitionDeployment
        ]
      }))
      const invalidId = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("", stepA)
        ]
      }))
      const forged = Object.freeze({ ...stepA }) as typeof stepA
      const forgedResult = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("forged", forged)
        ]
      }))
      const forgedPrototype = Object.freeze(Object.assign(
        Object.create({ [Node.TypeId]: true }),
        { type: "Forged", version: "1.0.0" }
      )) as Node.Any
      const forgedPrototypeResult = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("forged-prototype", forgedPrototype)
        ]
      }))
      const proxiedResult = yield* Effect.result(Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("proxied", new Proxy(stepA, {}) as typeof stepA)
        ]
      }))
      const hostileId = new Proxy({}, {
        get: () => {
          throw new Error("hostile deployment id")
        },
        getPrototypeOf: () => {
          throw new Error("hostile deployment id")
        }
      }) as unknown as string
      const hostileIdEntries: Deployment.DeploymentCatalogEntries = {
        workflowDefinitions: [],
        handlerDefinitions: [Deployment.handlerDefinition(hostileId, stepA)]
      }
      let hostileIdEffect!: ReturnType<typeof Deployment.makeMemory>
      assert.doesNotThrow(() => {
        hostileIdEffect = Deployment.makeMemory(hostileIdEntries)
      })
      const hostileIdResult = yield* Effect.result(hostileIdEffect)
      const eagerHostileId = Deployment.fromEntries(hostileIdEntries)

      assert.instanceOf(failure(hostileResult), Deployment.InvalidDeployment)
      assert.instanceOf(failure(invalidId), Deployment.InvalidDeployment)
      assert.instanceOf(failure(forgedResult), Deployment.InvalidDeployment)
      assert.instanceOf(failure(forgedPrototypeResult), Deployment.InvalidDeployment)
      assert.instanceOf(failure(proxiedResult), Deployment.InvalidDeployment)
      assert.instanceOf(failure(hostileIdResult), Deployment.InvalidDeployment)
      assert.instanceOf(failure(eagerHostileId), Deployment.InvalidDeployment)
      assert.strictEqual(reads, 0)
    }))

  it.effect("strictly snapshots resolution pins without invoking accessors", () =>
    Effect.gen(function*() {
      const catalog = yield* Deployment.makeMemory(entries())
      let reads = 0
      const hostile = Object.defineProperty(
        {
          type: "Step",
          version: "1.0.0"
        },
        "deploymentId",
        {
          enumerable: true,
          get: () => {
            reads++
            return "handler-build-a"
          }
        }
      )

      const resolved = yield* Effect.result(catalog.resolveHandlerDefinition(
        hostile as unknown as Deployment.HandlerDefinitionPin
      ))

      assert.instanceOf(failure(resolved), Deployment.InvalidDeployment)
      assert.strictEqual(reads, 0)
    }))

  it.effect("constructs an immutable layer and detaches catalog membership from caller arrays", () => {
    const workflowDefinitions = [
      Deployment.workflowDefinition("workflow-build-a", workflowA)
    ]
    const handlerDefinitions: Array<Deployment.HandlerDefinitionDeployment> = [
      Deployment.handlerDefinition("handler-build-a", stepA)
    ]
    const layer = Deployment.layerMemory({
      workflowDefinitions,
      handlerDefinitions
    })

    assertType<Types.Equals<Layer.Success<typeof layer>, Deployment.DeploymentCatalog>>(true)
    assertType<Types.Equals<Layer.Error<typeof layer>, Deployment.DeploymentCatalogBuildError>>(true)
    assertType<Types.Equals<Layer.Services<typeof layer>, never>>(true)

    return Effect.gen(function*() {
      const context = yield* Effect.scoped(Layer.build(layer))
      const catalog = Context.get(context, Deployment.DeploymentCatalog)
      handlerDefinitions.push(Deployment.handlerDefinition("late", other))

      assert.isTrue(Object.isFrozen(catalog))
      assert.isTrue(Object.isFrozen(workflowDefinitions[0]))
      assert.isTrue(Object.isFrozen(handlerDefinitions[0]))
      assert.isTrue(Object.isFrozen(
        yield* catalog.resolveWorkflowDefinition({
          deploymentId: "workflow-build-a",
          definitionId: "orders",
          definitionVersion: "3.0.0"
        })
      ))
      const late = yield* Effect.result(catalog.resolveHandlerDefinition({
        deploymentId: "late",
        type: "Other",
        version: "2.0.0"
      }))
      assert.instanceOf(failure(late), Deployment.DeploymentNotFound)
    })
  })
})
