import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as LinkPolicy from "../src/LinkPolicy.ts"

const nodeLink: LinkPolicy.LinkContext = {
  edgeId: "fetch-to-transform",
  source: {
    kind: "NodeOutput",
    nodeId: "fetch-1",
    nodeType: "Fetch",
    nodeVersion: "1.0.0",
    port: "result",
    contract: "example/json"
  },
  target: {
    kind: "NodeInput",
    nodeId: "transform-1",
    nodeType: "Transform",
    nodeVersion: "2.0.0",
    port: "value",
    contract: "example/json"
  }
}

const workflowLink: LinkPolicy.LinkContext = {
  edgeId: "input-to-output",
  source: {
    kind: "WorkflowInput",
    port: "request",
    contract: "example/request"
  },
  target: {
    kind: "WorkflowOutput",
    port: "response",
    contract: "example/response"
  }
}

describe("LinkPolicy", () => {
  it.effect("denies by default and requires allow-all to be explicit", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* LinkPolicy.denyAll.authorize(nodeLink), false)
      assert.strictEqual(yield* LinkPolicy.allowAll.authorize(nodeLink), true)

      const noMatch = LinkPolicy.fromRules([
        LinkPolicy.rule("allow", {
          source: { kind: "WorkflowInput", port: "different" }
        })
      ], "deny")

      assert.strictEqual(yield* noMatch.authorize(workflowLink), false)
      assert.strictEqual(noMatch.fallback, "deny")
      assert.deepStrictEqual(noMatch.rules, [{
        decision: "allow",
        selector: {
          source: { kind: "WorkflowInput", port: "different" }
        }
      }])
    }))

  it.effect("uses the first matching rule as the precedence decision", () =>
    Effect.gen(function*() {
      const narrowAllow = LinkPolicy.rule("allow", {
        source: {
          kind: "NodeOutput",
          nodeType: "Fetch",
          port: "result"
        }
      })
      const broadDeny = LinkPolicy.rule("deny", {})

      const allowFirst = LinkPolicy.fromRules([narrowAllow, broadDeny], "deny")
      const denyFirst = LinkPolicy.fromRules([broadDeny, narrowAllow], "deny")

      assert.strictEqual(yield* allowFirst.authorize(nodeLink), true)
      assert.strictEqual(yield* denyFirst.authorize(nodeLink), false)
    }))

  it.effect("matches endpoint kind and optional endpoint attributes", () =>
    Effect.gen(function*() {
      const exactNodeLink = LinkPolicy.fromRules([
        LinkPolicy.rule("allow", {
          source: {
            kind: "NodeOutput",
            nodeType: "Fetch",
            nodeVersion: "1.0.0",
            port: "result",
            contract: "example/json"
          },
          target: {
            kind: "NodeInput",
            nodeType: "Transform",
            nodeVersion: "2.0.0",
            port: "value",
            contract: "example/json"
          }
        })
      ], "deny")

      assert.strictEqual(yield* exactNodeLink.authorize(nodeLink), true)
      assert.strictEqual(yield* exactNodeLink.authorize(workflowLink), false)
      assert.strictEqual(
        yield* exactNodeLink.authorize({
          ...nodeLink,
          source: { ...nodeLink.source, nodeVersion: "1.1.0" }
        }),
        false
      )

      const workflowEndpoints = LinkPolicy.fromRules([
        LinkPolicy.rule("allow", {
          source: { kind: "WorkflowInput", contract: "example/request" },
          target: { kind: "WorkflowOutput", port: "response" }
        })
      ], "deny")

      assert.strictEqual(yield* workflowEndpoints.authorize(workflowLink), true)
    }))

  it.effect("does not treat contract compatibility as authorization", () =>
    Effect.gen(function*() {
      const incompatibleContracts: LinkPolicy.LinkContext = {
        ...workflowLink,
        source: { ...workflowLink.source, contract: "contract/a" },
        target: { ...workflowLink.target, contract: "contract/b" }
      }

      assert.strictEqual(yield* LinkPolicy.allowAll.authorize(incompatibleContracts), true)
    }))

  it.effect("supports custom policies with Effect requirements", () => {
    class AllowedContracts extends Context.Service<
      AllowedContracts,
      ReadonlySet<string>
    >()("@effect/workflow-builder/test/AllowedContracts") {}

    const policy = LinkPolicy.make((context) =>
      Effect.map(AllowedContracts, (allowed) => allowed.has(context.source.contract))
    )

    return Effect.gen(function*() {
      assert.strictEqual(yield* policy.authorize(nodeLink), true)
      assert.strictEqual(yield* policy.authorize(workflowLink), false)
    }).pipe(Effect.provideService(AllowedContracts, new Set(["example/json"])))
  })

  it.effect("copies and freezes declarative policies without changing rule order", () =>
    Effect.gen(function*() {
      const source = Object.assign(Object.create(null), {
        kind: "NodeOutput",
        nodeType: "__proto__",
        nodeVersion: "constructor",
        port: "prototype",
        contract: "__proto__"
      }) as LinkPolicy.NodeOutputSelector
      const selector = Object.assign(Object.create(null), { source }) as LinkPolicy.LinkSelector
      const first = LinkPolicy.rule("allow", selector)
      const supplied = [first]
      const policy = LinkPolicy.fromRules(supplied, "deny")

      supplied[0] = LinkPolicy.rule("deny", {})
      const mutableSource = source as { nodeType?: string }
      mutableSource.nodeType = "changed"

      assert.strictEqual(Object.isFrozen(policy), true)
      assert.strictEqual(Object.isFrozen(policy.rules), true)
      assert.strictEqual(Object.isFrozen(policy.rules[0]), true)
      assert.strictEqual(Object.isFrozen(policy.rules[0]!.selector), true)
      assert.strictEqual(Object.isFrozen(policy.rules[0]!.selector.source), true)
      assert.strictEqual(
        yield* policy.authorize({
          ...nodeLink,
          source: {
            ...nodeLink.source,
            nodeType: "__proto__",
            nodeVersion: "constructor",
            port: "prototype",
            contract: "__proto__"
          }
        }),
        true
      )
    }))

  it("rejects unsupported own __proto__ properties without changing prototypes", () => {
    const selector = JSON.parse(
      "{\"source\":{\"kind\":\"WorkflowInput\",\"port\":\"request\",\"__proto__\":{\"polluted\":true}}}"
    ) as LinkPolicy.LinkSelector

    assert.throws(() => LinkPolicy.rule("allow", selector), TypeError)
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined)

    const parsedRule = JSON.parse(
      "{\"decision\":\"allow\",\"selector\":{},\"__proto__\":{\"polluted\":true}}"
    ) as LinkPolicy.Rule
    assert.throws(() => LinkPolicy.fromRules([parsedRule], "deny"), TypeError)
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined)
  })

  it("rejects sparse, decorated, and overridden rule arrays", () => {
    const valid = LinkPolicy.rule("allow", {})
    const sparse = new Array<LinkPolicy.Rule>(1)
    assert.throws(() => LinkPolicy.fromRules(sparse, "deny"), TypeError)

    const decorated = [valid] as Array<LinkPolicy.Rule> & { metadata?: string }
    Object.defineProperty(decorated, "metadata", {
      configurable: true,
      value: "unexpected"
    })
    assert.throws(() => LinkPolicy.fromRules(decorated, "deny"), TypeError)

    const overridden = [valid] as Array<LinkPolicy.Rule> & { map?: unknown }
    Object.defineProperty(overridden, "map", {
      configurable: true,
      enumerable: true,
      value: () => []
    })
    assert.throws(() => LinkPolicy.fromRules(overridden, "deny"), TypeError)

    const nonEnumerableIndex = [valid]
    Object.defineProperty(nonEnumerableIndex, "0", {
      configurable: true,
      enumerable: false,
      value: valid
    })
    assert.throws(() => LinkPolicy.fromRules(nonEnumerableIndex, "deny"), TypeError)

    const customPrototype = [valid]
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype))
    assert.throws(() => LinkPolicy.fromRules(customPrototype, "deny"), TypeError)
  })

  it("rejects accessors without invoking getters", () => {
    let getterCount = 0
    const selector = {}
    Object.defineProperty(selector, "source", {
      enumerable: true,
      get() {
        getterCount++
        return { kind: "WorkflowInput" }
      }
    })
    assert.throws(
      () => LinkPolicy.rule("allow", selector as LinkPolicy.LinkSelector),
      TypeError
    )

    const accessorRule = {
      selector: {}
    }
    Object.defineProperty(accessorRule, "decision", {
      enumerable: true,
      get() {
        getterCount++
        return "allow"
      }
    })
    assert.throws(
      () => LinkPolicy.fromRules([accessorRule as LinkPolicy.Rule], "deny"),
      TypeError
    )

    const accessorIndex = [LinkPolicy.rule("allow", {})]
    Object.defineProperty(accessorIndex, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCount++
        return LinkPolicy.rule("allow", {})
      }
    })
    assert.throws(() => LinkPolicy.fromRules(accessorIndex, "deny"), TypeError)

    const accessorArray = [LinkPolicy.rule("allow", {})]
    Object.defineProperty(accessorArray, Symbol.iterator, {
      get() {
        getterCount++
        return Array.prototype[Symbol.iterator]
      }
    })
    assert.throws(() => LinkPolicy.fromRules(accessorArray, "deny"), TypeError)
    assert.strictEqual(getterCount, 0)
  })

  it("rejects custom prototypes and non-data decorations throughout rules", () => {
    const customSelector = Object.assign(Object.create({ inherited: true }), {
      source: { kind: "WorkflowInput" }
    }) as LinkPolicy.LinkSelector
    assert.throws(() => LinkPolicy.rule("allow", customSelector), TypeError)

    const customEndpoint = Object.assign(Object.create({ inherited: true }), {
      kind: "WorkflowInput"
    }) as LinkPolicy.WorkflowInputSelector
    assert.throws(
      () => LinkPolicy.rule("allow", { source: customEndpoint }),
      TypeError
    )

    const customRule = Object.assign(Object.create({ inherited: true }), {
      decision: "allow",
      selector: {}
    }) as LinkPolicy.Rule
    assert.throws(() => LinkPolicy.fromRules([customRule], "deny"), TypeError)

    const nonEnumerable = {}
    Object.defineProperty(nonEnumerable, "source", {
      value: { kind: "WorkflowInput" }
    })
    assert.throws(
      () => LinkPolicy.rule("allow", nonEnumerable as LinkPolicy.LinkSelector),
      TypeError
    )

    const symbolDecorated = {
      source: { kind: "WorkflowInput" },
      [Symbol("metadata")]: true
    }
    assert.throws(
      () => LinkPolicy.rule("allow", symbolDecorated as LinkPolicy.LinkSelector),
      TypeError
    )

    assert.throws(
      () =>
        LinkPolicy.rule("allow", {
          source: { kind: "WorkflowOutput" }
        } as unknown as LinkPolicy.LinkSelector),
      TypeError
    )
  })

  it("rejects malformed decisions and fallbacks synchronously", () => {
    assert.throws(
      () => LinkPolicy.rule("approve" as LinkPolicy.Decision, {}),
      TypeError
    )
    assert.throws(
      () => LinkPolicy.fromRules([], "approve" as LinkPolicy.Decision),
      TypeError
    )
    assert.throws(
      () =>
        LinkPolicy.fromRules([{
          decision: "approve",
          selector: {}
        } as LinkPolicy.Rule], "deny"),
      TypeError
    )
  })
})
