import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as EventV2 from "../src/EventV2.ts"
import * as ProtocolV2Wire from "../src/ProtocolV2Wire.ts"
import * as SemanticTime from "../src/SemanticTime.ts"

const success = (
  result: Result.Result<EventV2.Timestamp, SemanticTime.SemanticTimeError>
): EventV2.Timestamp => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = (
  result: Result.Result<EventV2.Timestamp, SemanticTime.SemanticTimeError>
): SemanticTime.SemanticTimeError => {
  if (Result.isSuccess(result)) {
    throw new Error("Expected semantic deadline materialization to fail")
  }
  return result.failure
}

describe("SemanticTime", () => {
  it("returns one canonical UTC millisecond timestamp, including at zero delay", () => {
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2026-07-23T01:02:03.000Z",
        0
      )),
      "2026-07-23T01:02:03.000Z"
    )
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2026-07-23T01:02:03.100Z",
        0
      )),
      "2026-07-23T01:02:03.100Z"
    )

    const canonical = success(SemanticTime.materializeDeadline(
      "2026-07-23T01:02:03.123Z",
      456
    ))
    assert.match(canonical, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.strictEqual(
      Schema.decodeUnknownSync(EventV2.Timestamp)(canonical),
      canonical
    )
  })

  it("rejects alternate offset spellings instead of hiding normalization", () => {
    for (
      const anchor of [
        "2026-07-23T02:30:00.000+02:30",
        "2026-07-22T19:00:00.000-05:00",
        "2026-07-23T00:00:00Z",
        "2026-07-23T00:00:00.0001Z"
      ]
    ) {
      assert.instanceOf(
        failure(SemanticTime.materializeDeadline(anchor as EventV2.Timestamp, 1)),
        SemanticTime.InvalidAnchor
      )
    }
  })

  it("crosses leap-day, century, and calendar-year boundaries exactly", () => {
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2024-02-28T23:59:59.999Z",
        1
      )),
      "2024-02-29T00:00:00.000Z"
    )
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2024-02-29T00:00:00.000Z",
        86_400_000
      )),
      "2024-03-01T00:00:00.000Z"
    )
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2000-02-28T00:00:00.000Z",
        86_400_000
      )),
      "2000-02-29T00:00:00.000Z"
    )
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2100-02-28T23:59:59.999Z",
        1
      )),
      "2100-03-01T00:00:00.000Z"
    )
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "2026-12-31T23:59:59.999Z",
        1
      )),
      "2027-01-01T00:00:00.000Z"
    )
  })

  it("returns InvalidAnchor for malformed calendar or timestamp values", () => {
    for (
      const anchor of [
        "2023-02-29T00:00:00.000Z",
        "2024-04-31T00:00:00.000Z",
        "2026-07-23T00:00:00",
        "2026-07-23",
        ""
      ]
    ) {
      const error = failure(SemanticTime.materializeDeadline(
        anchor as EventV2.Timestamp,
        0
      ))
      assert.instanceOf(error, SemanticTime.InvalidAnchor)
      assert.strictEqual(error._tag, "InvalidAnchor")
    }
  })

  it("rejects hostile anchors and delays without invoking accessors", () => {
    let anchorReads = 0
    const hostileAnchor = Object.defineProperty({}, "timestamp", {
      enumerable: true,
      get: () => {
        anchorReads++
        return "2026-07-23T00:00:00.000Z"
      }
    }) as unknown as EventV2.Timestamp
    const anchorError = failure(SemanticTime.materializeDeadline(
      hostileAnchor,
      0
    ))

    let delayReads = 0
    const hostileDelay = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        delayReads++
        return 1
      }
    }) as unknown as number
    const delayError = failure(SemanticTime.materializeDeadline(
      "2026-07-23T00:00:00.000Z",
      hostileDelay
    ))

    assert.instanceOf(anchorError, SemanticTime.InvalidAnchor)
    assert.instanceOf(delayError, SemanticTime.InvalidDelay)
    assert.strictEqual(anchorReads, 0)
    assert.strictEqual(delayReads, 0)
  })

  it("returns InvalidDelay for every non-negative-safe-integer violation", () => {
    for (
      const delayMillis of [
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY
      ]
    ) {
      const error = failure(SemanticTime.materializeDeadline(
        "2026-07-23T00:00:00.000Z",
        delayMillis
      ))
      assert.instanceOf(error, SemanticTime.InvalidDelay)
      assert.strictEqual(error._tag, "InvalidDelay")
    }
  })

  it("bounds operational delays and reports residual calendar-range overflow", () => {
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "9999-12-31T23:59:59.999Z",
        0
      )),
      "9999-12-31T23:59:59.999Z"
    )
    assert.strictEqual(
      success(SemanticTime.materializeDeadline(
        "1970-01-01T00:00:00.000Z",
        ProtocolV2Wire.MaximumSemanticDelayMillis
      )),
      "2069-12-07T00:00:00.000Z"
    )

    const calendarOverflow = failure(SemanticTime.materializeDeadline(
      "9999-12-31T23:59:59.999Z",
      1
    ))
    const excessiveDelay = failure(SemanticTime.materializeDeadline(
      "1970-01-01T00:00:00.000Z",
      ProtocolV2Wire.MaximumSemanticDelayMillis + 1
    ))
    assert.instanceOf(calendarOverflow, SemanticTime.DeadlineOutOfRange)
    assert.strictEqual(calendarOverflow._tag, "DeadlineOutOfRange")
    assert.instanceOf(excessiveDelay, SemanticTime.InvalidDelay)
    assert.strictEqual(excessiveDelay._tag, "InvalidDelay")
    if (
      calendarOverflow instanceof SemanticTime.DeadlineOutOfRange
    ) {
      assert.strictEqual(calendarOverflow.reason, "CalendarRange")
    }
  })
})
