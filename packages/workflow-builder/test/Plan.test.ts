import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Plan from "../src/Plan.ts"

const validPlan = JSON.parse(`{
  "formatVersion": 2,
  "id": "order-processing",
  "revision": 3,
  "definition": {
    "id": "order-workflow",
    "version": "4.2.0"
  },
  "nodes": [
    {
      "id": "validate",
      "type": "ValidateOrder",
      "version": "1.0.0",
      "config": { "strict": true },
      "metadata": { "position": [20, 40] }
    },
    {
      "id": "persist",
      "type": "PersistOrder",
      "version": "2.1.0",
      "config": null
    }
  ],
  "edges": [
    {
      "_tag": "DataEdge",
      "id": "order-to-validator",
      "source": { "_tag": "WorkflowInput", "input": "order" },
      "target": { "_tag": "NodeInput", "nodeId": "validate", "input": "order" },
      "order": 0,
      "metadata": { "label": "order" }
    },
    {
      "_tag": "DataEdge",
      "id": "validator-to-output",
      "source": { "_tag": "NodeOutput", "nodeId": "validate", "output": "validated" },
      "target": { "_tag": "WorkflowOutput", "output": "validatedOrder" }
    },
    {
      "_tag": "ControlEdge",
      "id": "validate-before-persist",
      "sourceNodeId": "validate",
      "targetNodeId": "persist",
      "metadata": { "label": "after validation" }
    }
  ],
  "metadata": { "title": "Order processing" }
}`)

const decode = Schema.decodeUnknownSync(Plan.Plan)

describe("Plan", () => {
  it("decodes a complete JSON plan", () => {
    assert.deepStrictEqual(decode(validPlan), validPlan)
  })

  it("rejects malformed plans", () => {
    const malformed = [
      { ...validPlan, formatVersion: 1 },
      { ...validPlan, id: "" },
      { ...validPlan, revision: -1 },
      {
        ...validPlan,
        definition: { ...validPlan.definition, id: "" }
      },
      {
        ...validPlan,
        definition: { ...validPlan.definition, version: "" }
      },
      {
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0], id: "" }]
      },
      {
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0], type: "" }]
      },
      {
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0], version: "" }]
      },
      {
        ...validPlan,
        edges: [{ ...validPlan.edges[0], order: -1 }]
      }
    ]

    for (const input of malformed) {
      assert.throws(() => decode(input))
    }
  })

  it("rejects non-JSON config and metadata", () => {
    assert.throws(() =>
      decode({
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0], config: { run: () => undefined } }]
      })
    )
    assert.throws(() => decode({ ...validPlan, metadata: { attempts: 1n } }))
  })

  it("rejects unknown edge and endpoint tags", () => {
    assert.throws(() =>
      decode({
        ...validPlan,
        edges: [{ ...validPlan.edges[0], _tag: "UnknownEdge" }]
      })
    )
    assert.throws(() =>
      decode({
        ...validPlan,
        edges: [{
          ...validPlan.edges[0],
          source: { _tag: "UnknownSource", input: "order" }
        }]
      })
    )
    assert.throws(() =>
      decode({
        ...validPlan,
        edges: [{
          ...validPlan.edges[0],
          target: { _tag: "UnknownTarget", output: "order" }
        }]
      })
    )
  })

  it("rejects excess properties at every plan level", () => {
    assert.throws(() => decode({ ...validPlan, unknown: true }))
    assert.throws(() =>
      decode({
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0], unknown: true }]
      })
    )
    assert.throws(() =>
      decode({
        ...validPlan,
        edges: [{
          ...validPlan.edges[0],
          source: { ...validPlan.edges[0].source, unknown: true }
        }]
      })
    )
  })
})
