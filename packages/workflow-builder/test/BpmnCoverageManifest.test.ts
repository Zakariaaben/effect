import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type * as BpmnConformance from "../src/BpmnConformance.ts"
import { validate } from "../src/BpmnConformance.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(packageRoot, path), "utf8"))

const catalog = readJson("conformance/bpmn-2.0.2.requirements.json")
const manifest = readJson("conformance/bpmn-2.0.2.coverage.json")

const validated = (): BpmnConformance.ValidatedCoverage => {
  const result = validate(catalog, manifest)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const evidencePath = (path: string): string => {
  const resolved = resolve(packageRoot, path)
  assert(
    resolved === packageRoot || resolved.startsWith(`${packageRoot}${sep}`),
    `Evidence path escapes package root: ${path}`
  )
  return resolved
}

describe("BPMN coverage manifest", () => {
  it("validates the checked-in catalogue and records no premature claim", () => {
    const coverage = validated()

    assert.strictEqual(coverage.catalog.normativeCoverageComplete, false)
    assert.deepStrictEqual(coverage.manifest.claims, [])
    assert.strictEqual(
      coverage.manifest.entries.length,
      coverage.catalog.requirements.length
    )
  })

  it("resolves every repository evidence path, symbol, and test name", () => {
    const coverage = validated()

    for (const entry of coverage.manifest.entries) {
      for (const evidence of entry.evidence) {
        if (evidence.path.startsWith("https://")) {
          continue
        }
        const path = evidencePath(evidence.path)
        assert(existsSync(path), `Missing evidence '${evidence.path}' for '${entry.requirementId}'`)
        if (evidence.symbol === undefined && evidence.testName === undefined) {
          continue
        }
        const source = readFileSync(path, "utf8")
        if (evidence.symbol !== undefined) {
          assert(
            source.includes(evidence.symbol),
            `Missing symbol '${evidence.symbol}' in '${evidence.path}'`
          )
        }
        if (evidence.testName !== undefined) {
          assert(
            source.includes(JSON.stringify(evidence.testName)),
            `Missing test '${evidence.testName}' in '${evidence.path}'`
          )
        }
      }
    }
  })

  it("keeps Workflow Patterns families distinct from evidenced atomic support", () => {
    const coverage = validated()
    const requirements = new Map(
      coverage.catalog.requirements.map((requirement) => [requirement.id, requirement])
    )
    const entries = new Map(
      coverage.manifest.entries.map((entry) => [entry.requirementId, entry])
    )
    const familyIds = [
      "WFP-CONTROL-FLOW-CATALOG",
      "WFP-DATA-CATALOG",
      "WFP-RESOURCE-CATALOG",
      "WFP-EXCEPTION-HANDLING-CATALOG",
      "WFP-SERVICE-CORRELATION-CATALOG",
      "WFP-FLEXIBILITY-CATALOG",
      "WFP-CHANGE-CATALOG",
      "WFP-SCIENTIFIC-CATALOG",
      "WFP-TIME-CATALOG",
      "WFP-ACTIVITY-CATALOG"
    ] as const

    assert.isFalse(requirements.has("WFP-CONTROL-DATA-RESOURCE-EXCEPTION-TIME"))
    for (const familyId of familyIds) {
      assert(requirements.has(familyId), `Missing Workflow Patterns family '${familyId}'`)
      assert.strictEqual(entries.get(familyId)?.supportLevel, "unsupported")
    }
    assert.strictEqual(
      requirements.get("WFP-ATOMIC-CATALOG-COMPLETE")?.source.pages,
      "105-329"
    )
    assert.strictEqual(
      entries.get("WFP-ATOMIC-CATALOG-COMPLETE")?.supportLevel,
      "unsupported"
    )
    for (
      const requirementId of [
        "WFP-WCP01-SEQUENCE",
        "WFP-WCP02-PARALLEL-SPLIT",
        "WFP-WCP03-SYNCHRONIZATION",
        "WFP-WCP04-EXCLUSIVE-CHOICE"
      ] as const
    ) {
      assert.strictEqual(entries.get(requirementId)?.supportLevel, "executable")
    }
  })

  it("ships strict JSON Schemas for requirement and coverage tooling", () => {
    const coverageSchema = readJson("conformance/bpmn-coverage.schema.json") as {
      readonly $schema?: unknown
      readonly additionalProperties?: unknown
      readonly properties?: {
        readonly claims?: unknown
        readonly entries?: unknown
      }
    }
    const requirementSchema = readJson("conformance/bpmn-requirements.schema.json") as {
      readonly $schema?: unknown
      readonly additionalProperties?: unknown
      readonly properties?: {
        readonly requirements?: unknown
        readonly profiles?: unknown
      }
    }

    assert.strictEqual(coverageSchema.$schema, "https://json-schema.org/draft/2020-12/schema")
    assert.strictEqual(coverageSchema.additionalProperties, false)
    assert(coverageSchema.properties?.entries !== undefined)
    assert(coverageSchema.properties?.claims !== undefined)
    assert.strictEqual(requirementSchema.$schema, "https://json-schema.org/draft/2020-12/schema")
    assert.strictEqual(requirementSchema.additionalProperties, false)
    assert(requirementSchema.properties?.requirements !== undefined)
    assert(requirementSchema.properties?.profiles !== undefined)
  })
})
