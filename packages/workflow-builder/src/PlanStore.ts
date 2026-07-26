/**
 * Stores immutable, fingerprint-pinned revisions of portable plans.
 *
 * A run references its plan by `(planId, revision, fingerprint)`; the store's
 * only job is to return exactly the admitted document for that pin. Revisions
 * are append-only — saving a different plan under an existing revision is a
 * conflict, never an overwrite — so a running or resumed execution can always
 * recover the meaning it started with.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import type * as Compiler from "./Compiler.ts"
import * as CompilerModule from "./Compiler.ts"
import * as Fingerprint from "./Fingerprint.ts"
import type * as Plan from "./Plan.ts"

/**
 * Raised when a referenced plan revision does not exist.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanNotFoundError extends Schema.TaggedErrorClass<PlanNotFoundError>(
  "@effect/workflow-builder/PlanStore/PlanNotFoundError"
)("PlanNotFoundError", {
  planId: Schema.String,
  revision: Schema.optionalKey(Schema.Int)
}) {}

/**
 * Raised when a revision is saved again with different semantic content.
 *
 * @category errors
 * @since 4.0.0
 */
export class PlanConflictError extends Schema.TaggedErrorClass<PlanConflictError>(
  "@effect/workflow-builder/PlanStore/PlanConflictError"
)("PlanConflictError", {
  planId: Schema.String,
  revision: Schema.Int,
  existing: Fingerprint.Digest,
  submitted: Fingerprint.Digest
}) {}

/**
 * An admitted plan revision pinned by its canonical fingerprint.
 *
 * @category models
 * @since 4.0.0
 */
export interface StoredPlan {
  readonly planId: string
  readonly revision: number
  readonly fingerprint: Fingerprint.Fingerprint
  readonly plan: Plan.Plan
}

/**
 * Service storing admitted plan revisions.
 *
 * **Details**
 *
 * `save` accepts only a plan that passed compilation, computes its canonical
 * fingerprint, and is idempotent for identical content. `get` returns an
 * exact revision and `latest` the highest saved revision; both return the
 * pinned fingerprint so callers can fail closed on drift.
 *
 * @category services
 * @since 4.0.0
 */
export class PlanStore extends Context.Service<PlanStore, {
  readonly save: (
    compiled: Compiler.CompiledPlan
  ) => Effect.Effect<StoredPlan, PlanConflictError | PlatformError.PlatformError>
  readonly get: (planId: string, revision: number) => Effect.Effect<StoredPlan, PlanNotFoundError>
  readonly latest: (planId: string) => Effect.Effect<StoredPlan, PlanNotFoundError>
}>()("@effect/workflow-builder/PlanStore") {}

const storageKey = (planId: string, revision: number): string => JSON.stringify([planId, revision])

/**
 * In-memory plan store for tests and single-process deployments.
 *
 * **Details**
 *
 * Contents are lost on process exit. A durable deployment supplies its own
 * `PlanStore` layer over a database while keeping the same append-only and
 * fingerprint semantics.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<PlanStore, never, Crypto.Crypto> = Layer.effect(
  PlanStore,
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const revisions = new Map<string, StoredPlan>()
    const latestRevision = new Map<string, number>()

    const save: PlanStore["Service"]["save"] = (compiled) =>
      Effect.gen(function*() {
        if (!CompilerModule.isCompiled(compiled)) {
          return yield* Effect.die(
            new TypeError("PlanStore.save requires the exact compiled plan returned by Compiler.compile")
          )
        }
        const fingerprint = yield* Fingerprint.make(compiled)
        const planId = compiled.plan.id
        const revision = compiled.plan.revision
        const key = storageKey(planId, revision)
        const existing = revisions.get(key)
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return yield* Effect.fail(
              new PlanConflictError({
                planId,
                revision,
                existing: existing.fingerprint,
                submitted: fingerprint
              })
            )
          }
          return existing
        }
        const stored: StoredPlan = Object.freeze({
          planId,
          revision,
          fingerprint,
          plan: compiled.plan
        })
        revisions.set(key, stored)
        const currentLatest = latestRevision.get(planId)
        if (currentLatest === undefined || revision > currentLatest) {
          latestRevision.set(planId, revision)
        }
        return stored
      }).pipe(Effect.provideService(Crypto.Crypto, crypto))

    return PlanStore.of({
      save,
      get: (planId, revision) => {
        const stored = revisions.get(storageKey(planId, revision))
        return stored === undefined
          ? Effect.fail(new PlanNotFoundError({ planId, revision }))
          : Effect.succeed(stored)
      },
      latest: (planId) => {
        const revision = latestRevision.get(planId)
        const stored = revision === undefined ? undefined : revisions.get(storageKey(planId, revision))
        return stored === undefined
          ? Effect.fail(new PlanNotFoundError({ planId }))
          : Effect.succeed(stored)
      }
    })
  })
)
