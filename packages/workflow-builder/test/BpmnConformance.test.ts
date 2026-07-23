import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as BpmnConformance from "../src/BpmnConformance.ts"

const catalog = (): BpmnConformance.RequirementCatalog => ({
  formatVersion: BpmnConformance.BpmnConformanceFormatVersion,
  catalogId: "bpmn-2.0.2-foundation",
  catalogRevision: 1,
  standard: {
    name: "Business Process Model and Notation",
    version: "2.0.2",
    authority: "Object Management Group",
    specificationUrl: "https://www.omg.org/spec/BPMN/2.0.2"
  },
  normativeCoverageComplete: false,
  requirements: [
    {
      id: "BPMN-MODEL-BASE",
      title: "Semantic model foundation",
      facet: "semantic-model",
      source: {
        authority: "OMG",
        document: "BPMN 2.0.2",
        section: "8"
      },
      dependsOn: []
    },
    {
      id: "BPMN-STATE-MARKING",
      title: "Durable token marking",
      facet: "execution-state",
      source: {
        authority: "OMG",
        document: "BPMN 2.0.2",
        section: "13"
      },
      dependsOn: ["BPMN-MODEL-BASE"]
    },
    {
      id: "BPMN-EXEC-PROCESS",
      title: "Process execution semantics",
      facet: "execution",
      source: {
        authority: "OMG",
        document: "BPMN 2.0.2",
        section: "14"
      },
      dependsOn: ["BPMN-STATE-MARKING"]
    }
  ],
  profiles: [{
    id: "BPMN-PROCESS-MODELING-DESCRIPTIVE",
    name: "Process Modeling Conformance - Descriptive",
    requirements: [{
      requirementId: "BPMN-MODEL-BASE",
      acceptedSupportLevels: ["modeled"]
    }]
  }]
})

const manifest = (): BpmnConformance.CoverageManifest => ({
  formatVersion: BpmnConformance.BpmnConformanceFormatVersion,
  catalogId: "bpmn-2.0.2-foundation",
  catalogRevision: 1,
  implementation: "@effect/workflow-builder",
  implementationVersion: "4.0.0-beta.100",
  reviewedAt: "2026-07-23",
  entries: [
    {
      requirementId: "BPMN-MODEL-BASE",
      supportLevel: "modeled",
      summary: "Strict semantic schemas and aggregate reference validation.",
      evidence: [
        {
          kind: "source",
          path: "src/BpmnModel.ts",
          symbol: "BpmnModel"
        },
        {
          kind: "schema-test",
          path: "test/BpmnModel.test.ts",
          testName: "validates a complete semantic model"
        }
      ]
    },
    {
      requirementId: "BPMN-STATE-MARKING",
      supportLevel: "state-modeled",
      summary: "Durable tokens and scope instances are modeled but not a conformance claim.",
      evidence: [
        {
          kind: "source",
          path: "src/BpmnExecutionState.ts",
          symbol: "BpmnExecutionState"
        },
        {
          kind: "state-test",
          path: "test/BpmnExecutionState.test.ts",
          testName: "validates a complete execution snapshot"
        }
      ]
    },
    {
      requirementId: "BPMN-EXEC-PROCESS",
      supportLevel: "unsupported",
      summary: "The complete normative execution profile is not implemented.",
      evidence: []
    }
  ],
  claims: []
})

const codes = (
  result: Result.Result<unknown, { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }>
): ReadonlyArray<string> => Result.isFailure(result) ? result.failure.diagnostics.map((value) => value.code) : []

describe("BpmnConformance", () => {
  it("validates an honest partial-coverage manifest without making a claim", () => {
    const result = BpmnConformance.validate(catalog(), manifest())

    assert(Result.isSuccess(result))
    assert.strictEqual(result.success.catalog.normativeCoverageComplete, false)
    assert.deepStrictEqual(result.success.manifest.claims, [])
  })

  it("requires maturity-specific evidence", () => {
    const valid = manifest()
    const invalid: BpmnConformance.CoverageManifest = {
      ...valid,
      entries: valid.entries.map((entry, index) =>
        index === 0 ?
          {
            ...entry,
            evidence: [{
              kind: "source",
              path: "src/BpmnModel.ts"
            }]
          } :
          entry
      )
    }

    const result = BpmnConformance.validate(catalog(), invalid)

    assert(Result.isFailure(result))
    assert(codes(result).includes(BpmnConformance.Codes.MissingEvidence))
  })

  it("rejects formal claims while the normative catalogue is incomplete", () => {
    const valid = manifest()
    const invalid: BpmnConformance.CoverageManifest = {
      ...valid,
      claims: [{
        profileId: "BPMN-PROCESS-MODELING-DESCRIPTIVE",
        declaredAt: "2026-07-23",
        evidence: [
          {
            kind: "normative-fixture",
            path: "test/fixtures/bpmn"
          },
          {
            kind: "profile-test",
            path: "test/BpmnConformanceProfile.test.ts"
          }
        ]
      }]
    }

    const result = BpmnConformance.validate(catalog(), invalid)

    assert(Result.isFailure(result))
    assert(codes(result).includes(BpmnConformance.Codes.IncompleteCatalogClaim))
  })

  it("aggregates unknown and cyclic dependencies with missing coverage", () => {
    const validCatalog = catalog()
    const invalidCatalog: BpmnConformance.RequirementCatalog = {
      ...validCatalog,
      requirements: validCatalog.requirements.map((requirement, index) => {
        if (index === 0) {
          return {
            ...requirement,
            dependsOn: ["BPMN-STATE-MARKING", "MISSING"]
          }
        }
        if (index === 1) {
          return {
            ...requirement,
            dependsOn: ["BPMN-MODEL-BASE"]
          }
        }
        return requirement
      })
    }
    const validManifest = manifest()
    const invalidManifest: BpmnConformance.CoverageManifest = {
      ...validManifest,
      entries: validManifest.entries.filter((_, index) => index !== 1)
    }

    const result = BpmnConformance.validate(invalidCatalog, invalidManifest)
    const diagnosticCodes = codes(result)

    assert(Result.isFailure(result))
    assert(diagnosticCodes.includes(BpmnConformance.Codes.UnknownDependency))
    assert(diagnosticCodes.includes(BpmnConformance.Codes.CyclicDependency))
    assert(diagnosticCodes.includes(BpmnConformance.Codes.MissingCoverage))
  })

  it("reports duplicate catalogue identities from the catalogue root", () => {
    const valid = catalog()
    const result = BpmnConformance.validate({
      ...valid,
      requirements: [
        ...valid.requirements,
        valid.requirements[0]!
      ],
      profiles: [
        ...valid.profiles,
        valid.profiles[0]!
      ]
    }, manifest())

    assert(Result.isFailure(result))
    const duplicates = result.failure.diagnostics.filter((diagnostic) =>
      diagnostic.code === BpmnConformance.Codes.DuplicateRequirement ||
      diagnostic.code === BpmnConformance.Codes.DuplicateProfile
    )
    assert.deepStrictEqual(
      duplicates.map((diagnostic) => diagnostic.path),
      [
        ["catalog", "profiles", 1, "id"],
        ["catalog", "requirements", 3, "id"]
      ]
    )
  })

  it("requires extension metadata only for extension coverage", () => {
    const valid = manifest()
    const missingMetadata: BpmnConformance.CoverageManifest = {
      ...valid,
      entries: valid.entries.map((entry, index) =>
        index === 2 ? { ...entry, supportLevel: "extension" as const } : entry
      )
    }
    const strayMetadata: BpmnConformance.CoverageManifest = {
      ...valid,
      entries: valid.entries.map((entry, index) =>
        index === 2 ?
          {
            ...entry,
            extension: {
              profileId: "EffectWorkflowExtensions",
              profileVersion: "1",
              supportLevel: "modeled" as const,
              portabilityWarning: "Not portable BPMN."
            }
          } :
          entry
      )
    }

    const missingResult = BpmnConformance.validate(catalog(), missingMetadata)
    const strayResult = BpmnConformance.validate(catalog(), strayMetadata)

    assert(Result.isFailure(missingResult))
    assert(codes(missingResult).includes(BpmnConformance.Codes.InvalidExtensionEvidence))
    assert(Result.isFailure(strayResult))
    assert(codes(strayResult).includes(BpmnConformance.Codes.InvalidExtensionEvidence))
  })

  it("never invokes accessors on hostile input", () => {
    let invoked = false
    const hostile = Object.create(null)
    Object.defineProperty(hostile, "formatVersion", {
      enumerable: true,
      get: () => {
        invoked = true
        return 1
      }
    })

    const result = BpmnConformance.validate(hostile, manifest())

    assert(Result.isFailure(result))
    assert.strictEqual(invoked, false)
    assert.deepStrictEqual(codes(result), [BpmnConformance.Codes.InvalidJson])
  })

  it("rejects excess schema properties", () => {
    const invalid = {
      ...catalog(),
      accidentalClaim: true
    }

    const result = BpmnConformance.validate(invalid, manifest())

    assert(Result.isFailure(result))
    assert.deepStrictEqual(codes(result), [BpmnConformance.Codes.InvalidCatalog])
  })
})
