import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as BpmnTime from "../src/BpmnTime.ts"
import * as ProtocolV3Wire from "../src/ProtocolV3Wire.ts"

const protocolMaximum = ProtocolV3Wire.MaximumSemanticDelayMillis

const success = <A>(
  result: Result.Result<A, BpmnTime.BpmnTimeError>
): A => {
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const failure = <A>(
  result: Result.Result<A, BpmnTime.BpmnTimeError>
): BpmnTime.BpmnTimeError => {
  if (Result.isSuccess(result)) {
    throw new Error("Expected BPMN time operation to fail")
  }
  return result.failure
}

describe("BpmnTime", () => {
  it("normalizes every zero fixed-duration spelling", () => {
    for (const lexical of ["P0D", "PT0S", "PT0.0000S", "P0DT0H0M0S"]) {
      assert.deepStrictEqual(
        success(BpmnTime.parseFixedDuration(lexical, protocolMaximum)),
        {
          lexicalVersion: BpmnTime.LexicalVersion,
          lexical: "PT0S",
          delayMillis: 0
        }
      )
    }
  })

  it("parses and normalizes fixed days, hours, minutes, and seconds", () => {
    assert.deepStrictEqual(
      success(BpmnTime.parseFixedDuration(
        "P2DT3H4M5S",
        protocolMaximum
      )),
      {
        lexicalVersion: 1,
        lexical: "P2DT3H4M5S",
        delayMillis: 183_845_000
      }
    )
    assert.deepStrictEqual(
      success(BpmnTime.parseFixedDuration("PT25H61M60S", protocolMaximum)),
      {
        lexicalVersion: 1,
        lexical: "P1DT2H2M",
        delayMillis: 93_720_000
      }
    )
  })

  it("admits only exact whole-millisecond fractions", () => {
    const cases = [
      ["PT0.1S", 100, "PT0.1S"],
      ["PT0.01S", 10, "PT0.01S"],
      ["PT0.001S", 1, "PT0.001S"],
      ["PT1.23000S", 1_230, "PT1.23S"],
      ["PT001.000000S", 1_000, "PT1S"]
    ] as const

    for (const [input, delayMillis, lexical] of cases) {
      assert.deepStrictEqual(
        success(BpmnTime.parseFixedDuration(input, protocolMaximum)),
        { lexicalVersion: 1, lexical, delayMillis }
      )
    }

    for (const input of ["PT0.0001S", "PT1.1234S", "PT1.00000001S"]) {
      const timerError = failure(
        BpmnTime.parseFixedDuration(input, protocolMaximum)
      )
      assert.instanceOf(timerError, BpmnTime.BpmnTimeError)
      assert.strictEqual(
        timerError.code,
        BpmnTime.Codes.SubMillisecondPrecision
      )
    }
  })

  it("enforces the explicit and protocol delay ceilings without overflow", () => {
    assert.strictEqual(
      success(BpmnTime.parseFixedDuration("P36500D", protocolMaximum))
        .delayMillis,
      protocolMaximum
    )
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration("PT1.001S", 1_000)).code,
      BpmnTime.Codes.DelayExceedsMaximum
    )
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration(
        "P36500DT0.001S",
        protocolMaximum
      )).code,
      BpmnTime.Codes.DelayExceedsProtocolMaximum
    )
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration(
        "P999999999999999999999999999999999999999999999D",
        protocolMaximum
      )).code,
      BpmnTime.Codes.DelayExceedsProtocolMaximum
    )
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration(
        "PT0S",
        protocolMaximum + 1
      )).code,
      BpmnTime.Codes.InvalidMaximumDelay
    )
  })

  it("rejects calendar years and months while retaining time minutes", () => {
    for (const input of ["P1Y", "P1M", "P2Y3M4D", "P1Y1DT1M"]) {
      assert.strictEqual(
        failure(BpmnTime.parseFixedDuration(input, protocolMaximum)).code,
        BpmnTime.Codes.CalendarUnitUnsupported
      )
    }
    assert.strictEqual(
      success(BpmnTime.parseFixedDuration("PT1M", protocolMaximum))
        .delayMillis,
      60_000
    )
  })

  it("rejects negative and malformed fixed-duration values", () => {
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration("-PT1S", protocolMaximum)).code,
      BpmnTime.Codes.NegativeDuration
    )

    for (
      const input of [
        "P",
        "PT",
        "P1DT",
        "P1W",
        "PT.S",
        "PT.5S",
        "+PT1S",
        "pt1s",
        " PT1S",
        "",
        1
      ]
    ) {
      assert.strictEqual(
        failure(BpmnTime.parseFixedDuration(input, protocolMaximum)).code,
        BpmnTime.Codes.InvalidFixedDuration
      )
    }
  })

  it("rejects oversized duration and date fractions before lexical parsing", () => {
    const oversizedFraction = "0".repeat(
      BpmnTime.MaximumTimerLexicalUtf8Bytes
    )
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration(
        `PT0.${oversizedFraction}S`,
        protocolMaximum
      )).code,
      BpmnTime.Codes.InvalidFixedDuration
    )
    assert.strictEqual(
      failure(BpmnTime.parseTimeDate(
        `2026-07-24T00:00:00.${oversizedFraction}Z`
      )).code,
      BpmnTime.Codes.InvalidTimeDate
    )

    const boundedLossyFraction = `001${"0".repeat(64)}1`
    assert.strictEqual(
      failure(BpmnTime.parseFixedDuration(
        `PT0.${boundedLossyFraction}S`,
        protocolMaximum
      )).code,
      BpmnTime.Codes.SubMillisecondPrecision
    )
    assert.strictEqual(
      failure(BpmnTime.parseTimeDate(
        `2026-07-24T00:00:00.${boundedLossyFraction}Z`
      )).code,
      BpmnTime.Codes.SubMillisecondPrecision
    )
  })

  it("materializes canonical fixed-duration dueAt values with safe addition", () => {
    assert.deepStrictEqual(
      success(BpmnTime.durationDueAt(
        "2026-07-24T12:34:56.789Z",
        "PT0S",
        protocolMaximum
      )),
      {
        lexicalVersion: 1,
        lexical: "PT0S",
        delayMillis: 0,
        dueAt: "2026-07-24T12:34:56.789Z"
      }
    )
    assert.strictEqual(
      success(BpmnTime.durationDueAt(
        "2024-02-28T23:59:59.999Z",
        "PT0.001S",
        protocolMaximum
      )).dueAt,
      "2024-02-29T00:00:00.000Z"
    )
    assert.strictEqual(
      failure(BpmnTime.durationDueAt(
        "9999-12-31T23:59:59.999Z",
        "PT0.001S",
        protocolMaximum
      )).code,
      BpmnTime.Codes.DueAtOutOfRange
    )
    assert.strictEqual(
      failure(BpmnTime.durationDueAt(
        "2026-07-24T12:34:56Z" as never,
        "PT0S",
        protocolMaximum
      )).code,
      BpmnTime.Codes.InvalidScheduledAt
    )
  })

  it("normalizes valid Z and offset timeDate values to canonical UTC", () => {
    assert.deepStrictEqual(
      success(BpmnTime.parseTimeDate("2026-07-24T00:34:05Z")),
      {
        lexicalVersion: 1,
        lexical: "2026-07-24T00:34:05.000Z"
      }
    )
    assert.deepStrictEqual(
      success(BpmnTime.parseTimeDate(
        "2026-07-24T03:04:05.12000+02:30"
      )),
      {
        lexicalVersion: 1,
        lexical: "2026-07-24T00:34:05.120Z"
      }
    )
    assert.strictEqual(
      success(BpmnTime.parseTimeDate(
        "2026-07-23T19:34:05-05:00"
      )).lexical,
      "2026-07-24T00:34:05.000Z"
    )
  })

  it("rejects invalid or lossy timeDate values", () => {
    for (
      const input of [
        "2023-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-07-24T24:00:00Z",
        "2026-07-24T00:00:60Z",
        "2026-07-24T00:00:00",
        "2026-07-24T00:00:00z",
        "2026-07-24T00:00:00+14:01",
        "0000-01-01T00:00:00Z",
        "2026-07-24",
        ""
      ]
    ) {
      assert.strictEqual(
        failure(BpmnTime.parseTimeDate(input)).code,
        BpmnTime.Codes.InvalidTimeDate
      )
    }
    assert.strictEqual(
      failure(BpmnTime.parseTimeDate(
        "2026-07-24T00:00:00.0001Z"
      )).code,
      BpmnTime.Codes.SubMillisecondPrecision
    )
    assert.strictEqual(
      failure(BpmnTime.parseTimeDate(
        "0000-01-01T00:00:00+14:00"
      )).code,
      BpmnTime.Codes.InvalidTimeDate
    )
  })

  it("resolves past, present, future, offset, and bounded timeDate values", () => {
    const scheduledAt = "2026-07-24T00:00:00.000Z"

    assert.deepStrictEqual(
      success(BpmnTime.timeDateDueAt(
        scheduledAt,
        "2026-07-23T23:59:59.999Z",
        protocolMaximum
      )),
      {
        lexicalVersion: 1,
        lexical: "2026-07-23T23:59:59.999Z",
        delayMillis: 0,
        dueAt: "2026-07-23T23:59:59.999Z"
      }
    )
    assert.deepStrictEqual(
      success(BpmnTime.timeDateDueAt(
        scheduledAt,
        "2026-07-24T02:30:00+02:30",
        protocolMaximum
      )),
      {
        lexicalVersion: 1,
        lexical: scheduledAt,
        delayMillis: 0,
        dueAt: scheduledAt
      }
    )
    assert.deepStrictEqual(
      success(BpmnTime.timeDateDueAt(
        scheduledAt,
        "2026-07-24T00:00:01.500Z",
        1_500
      )),
      {
        lexicalVersion: 1,
        lexical: "2026-07-24T00:00:01.500Z",
        delayMillis: 1_500,
        dueAt: "2026-07-24T00:00:01.500Z"
      }
    )
    assert.strictEqual(
      failure(BpmnTime.timeDateDueAt(
        scheduledAt,
        "2026-07-24T00:00:01.501Z",
        1_500
      )).code,
      BpmnTime.Codes.DelayExceedsMaximum
    )
  })

  it("exports schemas that validate the normalized parser outputs", () => {
    const duration = success(
      BpmnTime.parseFixedDuration("PT60S", protocolMaximum)
    )
    const timeDate = success(
      BpmnTime.parseTimeDate("2026-07-24T01:00:00+01:00")
    )

    assert.deepStrictEqual(
      Schema.decodeUnknownSync(BpmnTime.FixedDuration)(duration),
      duration
    )
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(BpmnTime.TimeDate)(timeDate),
      timeDate
    )
  })
})
