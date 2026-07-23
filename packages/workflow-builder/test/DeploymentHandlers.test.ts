import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Deployment from "../src/Deployment.ts"
import * as DeploymentHandlers from "../src/DeploymentHandlers.ts"
import * as Node from "../src/Node.ts"
import * as Registry from "../src/Registry.ts"

const task = Node.make("PinnedTask", { version: "1.0.0" })
const otherTaskObject = Node.make("PinnedTask", {
  version: "1.0.0",
  description: "same portable identity, different exact object"
})
const registry = Registry.make(task)

const makeHandlers = (label: string) =>
  registry.toHandlers(registry.of({
    "PinnedTask@1.0.0": () => Effect.succeed({ label } as never)
  }))

const catalog = Deployment.makeMemory({
  workflowDefinitions: [],
  handlerDefinitions: [
    Deployment.handlerDefinition("task-build-a", task),
    Deployment.handlerDefinition("task-build-b", task)
  ]
})

describe("DeploymentHandlers", () => {
  it.effect("resolves different implementations only through their exact deployment pins", () =>
    Effect.gen(function*() {
      const handlersA = yield* makeHandlers("a")
      const handlersB = yield* makeHandlers("b")
      const deploymentCatalog = yield* catalog
      const deployed = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-a", handlersA),
        DeploymentHandlers.handlerDeployment("task-build-b", handlersB)
      ]).pipe(Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog))

      const entryA = deployed.get("task-build-a", task.type, task.version)
      const entryB = deployed.get("task-build-b", task.type, task.version)
      assert.isDefined(entryA)
      assert.isDefined(entryB)
      assert.strictEqual(entryA.definition, task)
      assert.strictEqual(entryB.definition, task)
      assert.notStrictEqual(entryA.handler, entryB.handler)
      assert.strictEqual(deployed.get("missing", task.type, task.version), undefined)
      assert.isTrue(DeploymentHandlers.isDeploymentHandlerRegistry(deployed))
      assert.isFalse(DeploymentHandlers.isDeploymentHandlerRegistry({ ...deployed }))
    }))

  it.effect("rejects a deployment catalog that resolves another exact definition object", () =>
    Effect.gen(function*() {
      const handlers = yield* makeHandlers("a")
      const mismatchedCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: [
          Deployment.handlerDefinition("task-build-a", otherTaskObject)
        ]
      })
      const result = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-a", handlers)
      ]).pipe(
        Effect.provideService(Deployment.DeploymentCatalog, mismatchedCatalog),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(result.failure, DeploymentHandlers.InvalidDeploymentHandlers)
    }))

  it.effect("propagates missing exact deployment pins", () =>
    Effect.gen(function*() {
      const handlers = yield* makeHandlers("a")
      const emptyCatalog = yield* Deployment.makeMemory({
        workflowDefinitions: [],
        handlerDefinitions: []
      })
      const result = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("missing-build", handlers)
      ]).pipe(
        Effect.provideService(Deployment.DeploymentCatalog, emptyCatalog),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(result.failure, Deployment.DeploymentNotFound)
    }))

  it.effect("rejects duplicate deployment/type/version implementations", () =>
    Effect.gen(function*() {
      const handlers = yield* makeHandlers("a")
      const deploymentCatalog = yield* catalog
      const result = yield* DeploymentHandlers.make([
        DeploymentHandlers.handlerDeployment("task-build-a", handlers),
        DeploymentHandlers.handlerDeployment("task-build-a", handlers)
      ]).pipe(
        Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      assert.instanceOf(result.failure, DeploymentHandlers.DuplicateDeploymentHandler)
    }))

  it.effect("rejects forged, proxied, and accessor-based handler registry entries", () => {
    let getterReads = 0
    const accessor = Object.defineProperty(
      { deploymentId: "task-build-a" },
      "handlers",
      {
        enumerable: true,
        get: () => {
          getterReads++
          return Registry.HandlerRegistry.of({} as never)
        }
      }
    )
    return Effect.gen(function*() {
      const handlers = yield* makeHandlers("a")
      assert.isTrue(Registry.isHandlerRegistry(handlers))
      assert.isFalse(Registry.isHandlerRegistry({ ...handlers }))
      assert.isFalse(Registry.isHandlerRegistry(new Proxy(handlers, {})))
      const deploymentCatalog = yield* catalog
      const cases = [
        DeploymentHandlers.handlerDeployment(
          "task-build-a",
          { ...handlers } as Registry.HandlerRegistry["Service"]
        ),
        accessor as unknown as DeploymentHandlers.HandlerDeployment
      ]
      for (const candidate of cases) {
        const result = yield* DeploymentHandlers.make([candidate]).pipe(
          Effect.provideService(Deployment.DeploymentCatalog, deploymentCatalog),
          Effect.result
        )
        assert.isTrue(Result.isFailure(result))
        assert.instanceOf(result.failure, DeploymentHandlers.InvalidDeploymentHandlers)
      }
      assert.strictEqual(getterReads, 0)

      class Marker extends Context.Service<Marker, { readonly value: string }>()("DeploymentHandlersTest/Marker") {}
      const captured = yield* registry.toHandlers(registry.of({
        "PinnedTask@1.0.0": () =>
          Effect.gen(function*() {
            const marker = yield* Marker
            return { marker: marker.value } as never
          })
      })).pipe(Effect.provideService(Marker, { value: "captured" }))
      assert.isTrue(Registry.isHandlerRegistry(captured))
    })
  })
})
