import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Operation from "../src/EffectWorkflowOperationV3.ts"

const activity = (
  occurrenceDigest: string,
  operationId: string
) => ({
  _tag: "Activity",
  coordinateVersion: Operation.CoordinateVersion,
  occurrenceDigest,
  operationId
})

const digest = (character: string): string => `sha256:${character.repeat(64)}`

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

describe("EffectWorkflowOperationV3", () => {
  it("maps exact coordinates to stable collision-free bounded names", () => {
    const first = success(Operation.name(activity(
      digest("a"),
      "handler[\"primary\"]"
    )))
    const replay = success(Operation.name(activity(
      digest("a"),
      "handler[\"primary\"]"
    )))
    const otherOccurrence = success(Operation.name(activity(
      digest("b"),
      "handler[\"primary\"]"
    )))
    const otherOperation = success(Operation.name(activity(
      digest("a"),
      "handler/[\"primary\"]"
    )))

    assert.strictEqual(first, replay)
    assert.notStrictEqual(first, otherOccurrence)
    assert.notStrictEqual(first, otherOperation)
    assert.isTrue(first.startsWith(Operation.NamePrefix))
    const binding = success(Operation.bindingName(activity(
      digest("a"),
      "handler[\"primary\"]"
    )))
    assert.isTrue(binding.startsWith(Operation.BindingNamePrefix))
    assert.notStrictEqual(binding, first)
    assert.strictEqual(
      binding.slice(Operation.BindingNamePrefix.length),
      first.slice(Operation.NamePrefix.length)
    )
    assert.isAtMost(
      new TextEncoder().encode(first).byteLength,
      Operation.MaximumNameBytes
    )
  })

  it("separates activity, timer, deferred, and race namespaces", () => {
    const activityName = success(Operation.name(activity(digest("a"), "main")))
    const timerName = success(Operation.name({
      _tag: "Timer",
      coordinateVersion: Operation.CoordinateVersion,
      occurrenceDigest: digest("a"),
      operationId: "main",
      generation: 1
    }))
    const deferredName = success(Operation.name({
      _tag: "Deferred",
      coordinateVersion: Operation.CoordinateVersion,
      occurrenceDigest: digest("a"),
      operationId: "main",
      generation: 1
    }))
    const raceName = success(Operation.name({
      _tag: "Race",
      coordinateVersion: Operation.CoordinateVersion,
      occurrenceDigest: digest("a"),
      operationId: "main",
      generation: 1
    }))

    assert.notStrictEqual(activityName, timerName)
    assert.notStrictEqual(activityName, deferredName)
    assert.notStrictEqual(activityName, raceName)
    assert.notStrictEqual(timerName, deferredName)
    assert.notStrictEqual(timerName, raceName)
    assert.notStrictEqual(deferredName, raceName)
  })

  it("rejects excess, malformed, unsafe, and oversized coordinates", () => {
    const excess = Operation.name({
      ...activity(digest("a"), "main"),
      forged: true
    })
    const obsoleteAttemptCoordinate = Operation.name({
      ...activity(digest("a"), "main"),
      attempt: 1
    })
    const unsafeGeneration = Operation.name({
      _tag: "Timer",
      coordinateVersion: Operation.CoordinateVersion,
      occurrenceDigest: digest("a"),
      operationId: "main",
      generation: Number.MAX_SAFE_INTEGER + 1
    })
    const negativeGeneration = Operation.name({
      _tag: "Deferred",
      coordinateVersion: Operation.CoordinateVersion,
      occurrenceDigest: digest("a"),
      operationId: "main",
      generation: -1
    })
    const negativeRaceGeneration = Operation.name({
      _tag: "Race",
      coordinateVersion: Operation.CoordinateVersion,
      occurrenceDigest: digest("a"),
      operationId: "main",
      generation: -1
    })
    const invalidDigest = Operation.name(activity("not-a-digest", "main"))
    const oversized = Operation.name(activity(digest("a"), "x".repeat(257)))

    for (
      const rejected of [
        excess,
        obsoleteAttemptCoordinate,
        unsafeGeneration,
        negativeGeneration,
        negativeRaceGeneration,
        invalidDigest,
        oversized
      ]
    ) {
      assert(Result.isFailure(rejected))
      assert.strictEqual(
        rejected.failure.code,
        Operation.ErrorCodes.InvalidCoordinates
      )
    }
  })

  it("does not inspect coordinate accessors", () => {
    let reads = 0
    const hostile = {
      ...activity(digest("a"), "main"),
      get occurrenceDigest() {
        reads++
        return digest("a")
      }
    }

    const rejected = Operation.name(hostile)
    assert(Result.isFailure(rejected))
    assert.strictEqual(
      rejected.failure.code,
      Operation.ErrorCodes.InvalidCoordinates
    )
    assert.strictEqual(reads, 0)
  })
})
