/**
 * Machine-readable BPMN coverage and conformance evidence.
 *
 * **Details**
 *
 * The schemas in this module separate implemented building blocks from formal
 * BPMN conformance claims. A claim is admitted only when a complete normative
 * catalogue is paired with evidence for every requirement of the claimed
 * profile. This prevents a parser, diagram model, or partial token interpreter
 * from being presented as BPMN conformance on its own.
 *
 * @since 4.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Diagnostic from "./Diagnostic.ts"
import * as Json from "./internal/json.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const Identifier = Schema.NonEmptyString
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const comparePath = (
  left: ReadonlyArray<Diagnostic.PathSegment>,
  right: ReadonlyArray<Diagnostic.PathSegment>
): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]!
    const b = right[index]!
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) {
        return a - b
      }
      continue
    }
    const ordered = String(a).localeCompare(String(b))
    if (ordered !== 0) {
      return ordered
    }
  }
  return left.length - right.length
}

const sortDiagnostics = (diagnostics: Array<Diagnostic.Diagnostic>): Array<Diagnostic.Diagnostic> =>
  diagnostics.sort((left, right) => {
    const path = comparePath(left.path, right.path)
    if (path !== 0) {
      return path
    }
    const code = left.code.localeCompare(right.code)
    if (code !== 0) {
      return code
    }
    return left.message.localeCompare(right.message)
  })

const compilationError = (
  head: Diagnostic.Diagnostic,
  tail: ReadonlyArray<Diagnostic.Diagnostic> = []
): Diagnostic.CompilationError =>
  new Diagnostic.CompilationError({
    diagnostics: [head, ...tail]
  })

const error = (
  code: ConformanceCode,
  message: string,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  details?: Schema.Json
): Diagnostic.Diagnostic => Diagnostic.error(code, message, path, details)

/**
 * BPMN version governed by this evidence format.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnSpecificationVersion = "2.0.2" as const

/**
 * Version of the conformance evidence document format.
 *
 * @category constants
 * @since 4.0.0
 */
export const BpmnConformanceFormatVersion = 1 as const

/**
 * Implementation maturity recorded for one narrowly scoped requirement.
 *
 * **Details**
 *
 * These values are categories, not an ordinal scale. In particular,
 * `interchange` does not imply `executable`, and `executable` does not imply
 * XML interchange. Requirement identifiers therefore describe one facet only.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SupportLevel = Schema.Literals([
  "unsupported",
  "modeled",
  "state-modeled",
  "executable",
  "interchange",
  "extension"
])

/**
 * The decoded type of {@link SupportLevel}.
 *
 * @category models
 * @since 4.0.0
 */
export type SupportLevel = Schema.Schema.Type<typeof SupportLevel>

/**
 * The independently testable facet described by one requirement.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequirementFacet = Schema.Literals([
  "semantic-model",
  "execution-state",
  "execution",
  "xml-interchange",
  "diagram-interchange",
  "validation",
  "extension"
])

/**
 * The decoded type of {@link RequirementFacet}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementFacet = Schema.Schema.Type<typeof RequirementFacet>

/**
 * The role played by one evidence reference.
 *
 * @category schemas
 * @since 4.0.0
 */
export const EvidenceKind = Schema.Literals([
  "source",
  "schema-test",
  "state-test",
  "transition-test",
  "replay-test",
  "import-test",
  "export-test",
  "roundtrip-test",
  "xsd-validation-test",
  "normative-fixture",
  "profile-test",
  "specification"
])

/**
 * The decoded type of {@link EvidenceKind}.
 *
 * @category models
 * @since 4.0.0
 */
export type EvidenceKind = Schema.Schema.Type<typeof EvidenceKind>

/**
 * A resolvable implementation, test, fixture, or normative source reference.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Evidence = Schema.Struct({
  kind: EvidenceKind,
  path: Identifier,
  symbol: Schema.optionalKey(Identifier),
  testName: Schema.optionalKey(Identifier),
  locator: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnConformanceEvidence",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Evidence}.
 *
 * @category models
 * @since 4.0.0
 */
export type Evidence = Schema.Schema.Type<typeof Evidence>

/**
 * A normative or requirements-catalogue source for one requirement.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequirementSource = Schema.Struct({
  authority: Schema.Literals(["OMG", "WorkflowPatterns"]),
  document: Identifier,
  section: Schema.optionalKey(Identifier),
  pages: Schema.optionalKey(Identifier),
  url: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnRequirementSource",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RequirementSource}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementSource = Schema.Schema.Type<typeof RequirementSource>

/**
 * One atomic BPMN or workflow-pattern requirement.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Requirement = Schema.Struct({
  id: Identifier,
  title: Identifier,
  facet: RequirementFacet,
  source: RequirementSource,
  dependsOn: Schema.Array(Identifier),
  notes: Schema.optionalKey(Identifier)
}).annotate({
  identifier: "WorkflowBpmnRequirement",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link Requirement}.
 *
 * @category models
 * @since 4.0.0
 */
export type Requirement = Schema.Schema.Type<typeof Requirement>

/**
 * One requirement and the support levels accepted by a formal profile.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProfileRequirement = Schema.Struct({
  requirementId: Identifier,
  acceptedSupportLevels: Schema.NonEmptyArray(
    Schema.Literals(["modeled", "state-modeled", "executable", "interchange"])
  )
}).annotate({
  identifier: "WorkflowBpmnProfileRequirement",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProfileRequirement}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProfileRequirement = Schema.Schema.Type<typeof ProfileRequirement>

/**
 * A BPMN conformance profile and its complete requirement set.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ConformanceProfile = Schema.Struct({
  id: Identifier,
  name: Identifier,
  requirements: Schema.NonEmptyArray(ProfileRequirement)
}).annotate({
  identifier: "WorkflowBpmnConformanceProfile",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ConformanceProfile}.
 *
 * @category models
 * @since 4.0.0
 */
export type ConformanceProfile = Schema.Schema.Type<typeof ConformanceProfile>

/**
 * A versioned catalogue of BPMN requirements and formal profiles.
 *
 * **Details**
 *
 * `normativeCoverageComplete` must remain `false` until the catalogue covers
 * every applicable normative requirement for every listed profile. No formal
 * claim can be admitted while it is false.
 *
 * @category schemas
 * @since 4.0.0
 */
export const RequirementCatalog = Schema.Struct({
  formatVersion: Schema.Literal(BpmnConformanceFormatVersion),
  catalogId: Identifier,
  catalogRevision: NonNegativeInt,
  standard: Schema.Struct({
    name: Schema.Literal("Business Process Model and Notation"),
    version: Schema.Literal(BpmnSpecificationVersion),
    authority: Schema.Literal("Object Management Group"),
    specificationUrl: Identifier
  }),
  normativeCoverageComplete: Schema.Boolean,
  requirements: Schema.Array(Requirement),
  profiles: Schema.Array(ConformanceProfile)
}).annotate({
  identifier: "WorkflowBpmnRequirementCatalog",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link RequirementCatalog}.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementCatalog = Schema.Schema.Type<typeof RequirementCatalog>

/**
 * Explicit maturity details for behavior outside portable BPMN.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ExtensionSupport = Schema.Struct({
  profileId: Identifier,
  profileVersion: Identifier,
  supportLevel: Schema.Literals(["modeled", "state-modeled", "executable", "interchange"]),
  portabilityWarning: Identifier
}).annotate({
  identifier: "WorkflowBpmnExtensionSupport",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ExtensionSupport}.
 *
 * @category models
 * @since 4.0.0
 */
export type ExtensionSupport = Schema.Schema.Type<typeof ExtensionSupport>

/**
 * Coverage and evidence for one catalogue requirement.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CoverageEntry = Schema.Struct({
  requirementId: Identifier,
  supportLevel: SupportLevel,
  summary: Identifier,
  evidence: Schema.Array(Evidence),
  extension: Schema.optionalKey(ExtensionSupport)
}).annotate({
  identifier: "WorkflowBpmnCoverageEntry",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CoverageEntry}.
 *
 * @category models
 * @since 4.0.0
 */
export type CoverageEntry = Schema.Schema.Type<typeof CoverageEntry>

/**
 * A declared formal conformance claim.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ProfileClaim = Schema.Struct({
  profileId: Identifier,
  declaredAt: Identifier,
  evidence: Schema.NonEmptyArray(Evidence)
}).annotate({
  identifier: "WorkflowBpmnProfileClaim",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link ProfileClaim}.
 *
 * @category models
 * @since 4.0.0
 */
export type ProfileClaim = Schema.Schema.Type<typeof ProfileClaim>

/**
 * One implementation's complete coverage report for a catalogue revision.
 *
 * @category schemas
 * @since 4.0.0
 */
export const CoverageManifest = Schema.Struct({
  formatVersion: Schema.Literal(BpmnConformanceFormatVersion),
  catalogId: Identifier,
  catalogRevision: NonNegativeInt,
  implementation: Identifier,
  implementationVersion: Identifier,
  reviewedAt: Identifier,
  entries: Schema.Array(CoverageEntry),
  claims: Schema.Array(ProfileClaim)
}).annotate({
  identifier: "WorkflowBpmnCoverageManifest",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link CoverageManifest}.
 *
 * @category models
 * @since 4.0.0
 */
export type CoverageManifest = Schema.Schema.Type<typeof CoverageManifest>

/**
 * A validated catalogue paired with its coverage report.
 *
 * @category models
 * @since 4.0.0
 */
export interface ValidatedCoverage {
  readonly catalog: RequirementCatalog
  readonly manifest: CoverageManifest
}

/**
 * Stable diagnostics emitted by conformance-evidence validation.
 *
 * @category constants
 * @since 4.0.0
 */
export const Codes = {
  InvalidJson: "BPMN_CONFORMANCE_INVALID_JSON",
  InvalidCatalog: "BPMN_CONFORMANCE_INVALID_CATALOG",
  InvalidManifest: "BPMN_CONFORMANCE_INVALID_MANIFEST",
  CatalogMismatch: "BPMN_CONFORMANCE_CATALOG_MISMATCH",
  DuplicateRequirement: "BPMN_CONFORMANCE_DUPLICATE_REQUIREMENT",
  DuplicateProfile: "BPMN_CONFORMANCE_DUPLICATE_PROFILE",
  DuplicateProfileRequirement: "BPMN_CONFORMANCE_DUPLICATE_PROFILE_REQUIREMENT",
  UnknownDependency: "BPMN_CONFORMANCE_UNKNOWN_DEPENDENCY",
  CyclicDependency: "BPMN_CONFORMANCE_CYCLIC_DEPENDENCY",
  UnknownProfileRequirement: "BPMN_CONFORMANCE_UNKNOWN_PROFILE_REQUIREMENT",
  DuplicateCoverage: "BPMN_CONFORMANCE_DUPLICATE_COVERAGE",
  UnknownCoverageRequirement: "BPMN_CONFORMANCE_UNKNOWN_COVERAGE_REQUIREMENT",
  MissingCoverage: "BPMN_CONFORMANCE_MISSING_COVERAGE",
  InvalidExtensionEvidence: "BPMN_CONFORMANCE_INVALID_EXTENSION_EVIDENCE",
  MissingEvidence: "BPMN_CONFORMANCE_MISSING_EVIDENCE",
  DuplicateClaim: "BPMN_CONFORMANCE_DUPLICATE_CLAIM",
  UnknownClaimProfile: "BPMN_CONFORMANCE_UNKNOWN_CLAIM_PROFILE",
  IncompleteCatalogClaim: "BPMN_CONFORMANCE_INCOMPLETE_CATALOG_CLAIM",
  UnsatisfiedClaim: "BPMN_CONFORMANCE_UNSATISFIED_CLAIM",
  InvalidClaimEvidence: "BPMN_CONFORMANCE_INVALID_CLAIM_EVIDENCE"
} as const

/**
 * A code emitted by {@link validate}.
 *
 * @category models
 * @since 4.0.0
 */
export type ConformanceCode = typeof Codes[keyof typeof Codes]

const decodeCatalog = Schema.decodeUnknownResult(RequirementCatalog, strictParseOptions)
const decodeManifest = Schema.decodeUnknownResult(CoverageManifest, strictParseOptions)

const requiredEvidence = (supportLevel: SupportLevel): ReadonlyArray<EvidenceKind> => {
  switch (supportLevel) {
    case "unsupported":
      return []
    case "modeled":
      return ["source", "schema-test"]
    case "state-modeled":
      return ["source", "state-test"]
    case "executable":
      return ["source", "transition-test", "replay-test"]
    case "interchange":
      return ["source", "import-test", "export-test", "roundtrip-test", "xsd-validation-test"]
    case "extension":
      return []
  }
}

const addDuplicateDiagnostics = (
  values: ReadonlyArray<{ readonly id: string }>,
  path: ReadonlyArray<Diagnostic.PathSegment>,
  code: ConformanceCode,
  label: string,
  diagnostics: Array<Diagnostic.Diagnostic>
): void => {
  const seen = new Map<string, number>()
  for (let index = 0; index < values.length; index++) {
    const id = values[index]!.id
    const previous = seen.get(id)
    if (previous === undefined) {
      seen.set(id, index)
    } else {
      diagnostics.push(error(
        code,
        `Duplicate ${label} '${id}'`,
        [...path, index, "id"],
        { firstIndex: previous }
      ))
    }
  }
}

const addDependencyCycleDiagnostics = (
  requirements: ReadonlyArray<Requirement>,
  requirementById: ReadonlyMap<string, Requirement>,
  indexById: ReadonlyMap<string, number>,
  diagnostics: Array<Diagnostic.Diagnostic>
): void => {
  const state = new Map<string, "visiting" | "visited">()
  const reported = new Set<string>()

  const visit = (id: string, stack: ReadonlyArray<string>): void => {
    const currentState = state.get(id)
    if (currentState === "visited") {
      return
    }
    if (currentState === "visiting") {
      const cycleStart = stack.indexOf(id)
      const cycle = cycleStart < 0 ? [...stack, id] : [...stack.slice(cycleStart), id]
      const cycleKey = [...new Set(cycle)].sort().join("\u0000")
      if (!reported.has(cycleKey)) {
        reported.add(cycleKey)
        diagnostics.push(error(
          Codes.CyclicDependency,
          `Cyclic requirement dependency: ${cycle.join(" -> ")}`,
          ["requirements", indexById.get(id) ?? 0, "dependsOn"],
          { cycle }
        ))
      }
      return
    }

    state.set(id, "visiting")
    const requirement = requirementById.get(id)
    if (requirement !== undefined) {
      for (const dependency of requirement.dependsOn) {
        if (requirementById.has(dependency)) {
          visit(dependency, [...stack, id])
        }
      }
    }
    state.set(id, "visited")
  }

  for (const requirement of requirements) {
    visit(requirement.id, [])
  }
}

/**
 * Snapshots, strictly decodes, and validates a BPMN coverage catalogue pair.
 *
 * **Details**
 *
 * Validation is hostile-input safe and aggregates deterministic diagnostics.
 * It verifies catalogue identity, unique and resolvable requirements,
 * dependency acyclicity, complete coverage, maturity-specific evidence, and
 * every precondition for a declared profile claim. It deliberately does not
 * inspect the filesystem; repository CI should additionally resolve every
 * evidence path, symbol, test name, and fixture.
 *
 * @category validation
 * @since 4.0.0
 */
export const validate = (
  catalogInput: unknown,
  manifestInput: unknown
): Result.Result<ValidatedCoverage, Diagnostic.CompilationError> => {
  const catalogSnapshot = Json.snapshot(catalogInput)
  if (Result.isFailure(catalogSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidJson,
      catalogSnapshot.failure.message,
      ["catalog", ...catalogSnapshot.failure.path]
    )))
  }
  const manifestSnapshot = Json.snapshot(manifestInput)
  if (Result.isFailure(manifestSnapshot)) {
    return Result.fail(compilationError(error(
      Codes.InvalidJson,
      manifestSnapshot.failure.message,
      ["manifest", ...manifestSnapshot.failure.path]
    )))
  }

  const decodedCatalog = decodeCatalog(catalogSnapshot.success)
  if (Result.isFailure(decodedCatalog)) {
    return Result.fail(compilationError(error(
      Codes.InvalidCatalog,
      "Invalid BPMN conformance requirement catalogue",
      ["catalog"],
      { issue: String(decodedCatalog.failure) }
    )))
  }
  const decodedManifest = decodeManifest(manifestSnapshot.success)
  if (Result.isFailure(decodedManifest)) {
    return Result.fail(compilationError(error(
      Codes.InvalidManifest,
      "Invalid BPMN conformance coverage manifest",
      ["manifest"],
      { issue: String(decodedManifest.failure) }
    )))
  }

  const catalog = catalogSnapshot.success as unknown as RequirementCatalog
  const manifest = manifestSnapshot.success as unknown as CoverageManifest
  const diagnostics: Array<Diagnostic.Diagnostic> = []

  if (
    manifest.catalogId !== catalog.catalogId ||
    manifest.catalogRevision !== catalog.catalogRevision
  ) {
    diagnostics.push(error(
      Codes.CatalogMismatch,
      "Coverage manifest does not target the supplied catalogue revision",
      ["manifest", "catalogId"],
      {
        expectedCatalogId: catalog.catalogId,
        expectedCatalogRevision: catalog.catalogRevision,
        actualCatalogId: manifest.catalogId,
        actualCatalogRevision: manifest.catalogRevision
      }
    ))
  }

  addDuplicateDiagnostics(
    catalog.requirements,
    ["catalog", "requirements"],
    Codes.DuplicateRequirement,
    "requirement",
    diagnostics
  )
  addDuplicateDiagnostics(
    catalog.profiles,
    ["catalog", "profiles"],
    Codes.DuplicateProfile,
    "profile",
    diagnostics
  )

  const requirementById = new Map<string, Requirement>()
  const requirementIndexById = new Map<string, number>()
  for (let index = 0; index < catalog.requirements.length; index++) {
    const requirement = catalog.requirements[index]!
    if (!requirementById.has(requirement.id)) {
      requirementById.set(requirement.id, requirement)
      requirementIndexById.set(requirement.id, index)
    }
    const dependencies = new Set<string>()
    for (let dependencyIndex = 0; dependencyIndex < requirement.dependsOn.length; dependencyIndex++) {
      const dependency = requirement.dependsOn[dependencyIndex]!
      if (dependencies.has(dependency)) {
        diagnostics.push(error(
          Codes.DuplicateRequirement,
          `Requirement '${requirement.id}' repeats dependency '${dependency}'`,
          ["catalog", "requirements", index, "dependsOn", dependencyIndex]
        ))
      }
      dependencies.add(dependency)
      if (!catalog.requirements.some((candidate) => candidate.id === dependency)) {
        diagnostics.push(error(
          Codes.UnknownDependency,
          `Requirement '${requirement.id}' depends on unknown requirement '${dependency}'`,
          ["catalog", "requirements", index, "dependsOn", dependencyIndex]
        ))
      }
    }
  }
  addDependencyCycleDiagnostics(
    catalog.requirements,
    requirementById,
    requirementIndexById,
    diagnostics
  )

  const profileById = new Map<string, ConformanceProfile>()
  for (let profileIndex = 0; profileIndex < catalog.profiles.length; profileIndex++) {
    const profile = catalog.profiles[profileIndex]!
    if (!profileById.has(profile.id)) {
      profileById.set(profile.id, profile)
    }
    const profileRequirementIds = new Set<string>()
    for (
      let requirementIndex = 0;
      requirementIndex < profile.requirements.length;
      requirementIndex++
    ) {
      const profileRequirement = profile.requirements[requirementIndex]!
      if (profileRequirementIds.has(profileRequirement.requirementId)) {
        diagnostics.push(error(
          Codes.DuplicateProfileRequirement,
          `Profile '${profile.id}' repeats requirement '${profileRequirement.requirementId}'`,
          ["catalog", "profiles", profileIndex, "requirements", requirementIndex, "requirementId"]
        ))
      }
      profileRequirementIds.add(profileRequirement.requirementId)
      if (!requirementById.has(profileRequirement.requirementId)) {
        diagnostics.push(error(
          Codes.UnknownProfileRequirement,
          `Profile '${profile.id}' references unknown requirement '${profileRequirement.requirementId}'`,
          ["catalog", "profiles", profileIndex, "requirements", requirementIndex, "requirementId"]
        ))
      }
    }
  }

  const coverageByRequirementId = new Map<string, CoverageEntry>()
  for (let index = 0; index < manifest.entries.length; index++) {
    const entry = manifest.entries[index]!
    const previous = coverageByRequirementId.get(entry.requirementId)
    if (previous !== undefined) {
      diagnostics.push(error(
        Codes.DuplicateCoverage,
        `Duplicate coverage entry for requirement '${entry.requirementId}'`,
        ["manifest", "entries", index, "requirementId"]
      ))
    } else {
      coverageByRequirementId.set(entry.requirementId, entry)
    }
    if (!requirementById.has(entry.requirementId)) {
      diagnostics.push(error(
        Codes.UnknownCoverageRequirement,
        `Coverage references unknown requirement '${entry.requirementId}'`,
        ["manifest", "entries", index, "requirementId"]
      ))
    }

    if (entry.supportLevel === "extension") {
      if (entry.extension === undefined) {
        diagnostics.push(error(
          Codes.InvalidExtensionEvidence,
          `Extension coverage for '${entry.requirementId}' requires extension metadata`,
          ["manifest", "entries", index, "extension"]
        ))
      }
    } else if (entry.extension !== undefined) {
      diagnostics.push(error(
        Codes.InvalidExtensionEvidence,
        `Non-extension coverage for '${entry.requirementId}' cannot contain extension metadata`,
        ["manifest", "entries", index, "extension"]
      ))
    }

    const effectiveLevel = entry.supportLevel === "extension"
      ? entry.extension?.supportLevel
      : entry.supportLevel
    if (effectiveLevel !== undefined) {
      const evidenceKinds = new Set(entry.evidence.map((evidence) => evidence.kind))
      for (const kind of requiredEvidence(effectiveLevel)) {
        if (!evidenceKinds.has(kind)) {
          diagnostics.push(error(
            Codes.MissingEvidence,
            `Coverage '${entry.requirementId}' at level '${effectiveLevel}' requires '${kind}' evidence`,
            ["manifest", "entries", index, "evidence"],
            { requiredKind: kind }
          ))
        }
      }
    }
  }

  for (let index = 0; index < catalog.requirements.length; index++) {
    const requirement = catalog.requirements[index]!
    if (!coverageByRequirementId.has(requirement.id)) {
      diagnostics.push(error(
        Codes.MissingCoverage,
        `Requirement '${requirement.id}' has no coverage entry`,
        ["catalog", "requirements", index, "id"]
      ))
    }
  }

  const claimedProfiles = new Map<string, number>()
  for (let index = 0; index < manifest.claims.length; index++) {
    const claim = manifest.claims[index]!
    const previous = claimedProfiles.get(claim.profileId)
    if (previous === undefined) {
      claimedProfiles.set(claim.profileId, index)
    } else {
      diagnostics.push(error(
        Codes.DuplicateClaim,
        `Duplicate conformance claim for profile '${claim.profileId}'`,
        ["manifest", "claims", index, "profileId"],
        { firstIndex: previous }
      ))
    }
    const profile = profileById.get(claim.profileId)
    if (profile === undefined) {
      diagnostics.push(error(
        Codes.UnknownClaimProfile,
        `Conformance claim references unknown profile '${claim.profileId}'`,
        ["manifest", "claims", index, "profileId"]
      ))
      continue
    }
    if (!catalog.normativeCoverageComplete) {
      diagnostics.push(error(
        Codes.IncompleteCatalogClaim,
        `Profile '${claim.profileId}' cannot be claimed from an incomplete normative catalogue`,
        ["manifest", "claims", index, "profileId"]
      ))
    }

    for (const profileRequirement of profile.requirements) {
      const coverage = coverageByRequirementId.get(profileRequirement.requirementId)
      if (
        coverage === undefined ||
        !profileRequirement.acceptedSupportLevels.includes(
          coverage.supportLevel as "modeled" | "state-modeled" | "executable" | "interchange"
        )
      ) {
        diagnostics.push(error(
          Codes.UnsatisfiedClaim,
          `Profile '${claim.profileId}' requirement '${profileRequirement.requirementId}' is not satisfied`,
          ["manifest", "claims", index, "profileId"],
          {
            requirementId: profileRequirement.requirementId,
            acceptedSupportLevels: [...profileRequirement.acceptedSupportLevels],
            actualSupportLevel: coverage?.supportLevel ?? "missing"
          }
        ))
      }
    }
    const claimKinds = new Set(claim.evidence.map((evidence) => evidence.kind))
    for (const requiredKind of ["normative-fixture", "profile-test"] as const) {
      if (!claimKinds.has(requiredKind)) {
        diagnostics.push(error(
          Codes.InvalidClaimEvidence,
          `Profile '${claim.profileId}' claim requires '${requiredKind}' evidence`,
          ["manifest", "claims", index, "evidence"],
          { requiredKind }
        ))
      }
    }
  }

  if (diagnostics.length > 0) {
    const sorted = sortDiagnostics(diagnostics)
    return Result.fail(compilationError(sorted[0]!, sorted.slice(1)))
  }
  return Result.succeed({ catalog, manifest })
}
