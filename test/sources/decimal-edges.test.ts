import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatDecimal, parseDecimal } from "../../src/sources/bitstamp/decimal";

/**
 * Edge-of-domain pins for the exact-decimal layer, complementing the venue
 * goldens in normalize.test.ts. Each pin documents current behavior on
 * inputs the venue never sends, so a refactor that changes them is caught
 * and argued rather than silent.
 */

describe("parseDecimal edges", () => {
  it("accepts the largest safe value and rejects one past it", () => {
    // 2^53 - 1 = 9007199254740991: the largest integer Float64 stores
    // exactly (provenance: IEEE-754 double, Number.MAX_SAFE_INTEGER).
    expect(parseDecimal("90071992547409.91", 2)).toBe(9_007_199_254_740_991);
    expect(Number.MAX_SAFE_INTEGER).toBe(9_007_199_254_740_991);
    // One cent more lands exactly on 2^53, which is not safe: loud failure.
    expect(() => parseDecimal("90071992547409.92", 2)).toThrow(/safe integer/);
  });

  it("passes negative values through by sign concatenation", () => {
    // The venue never sends negative prices or sizes; nothing downstream
    // validates sign here. Pinned so the behavior is a documented fact, not
    // an accident: "-1" + "50" concatenates to "-150".
    expect(parseDecimal("-1.50", 2)).toBe(-150);
    expect(parseDecimal("-0.05", 2)).toBe(-5);
  });

  it("is guarded by safe-integer range, not by format strictness", () => {
    // Number() accepts exponent notation, so "1e2" with two decimals pads to
    // "1e200" and trips the safe-integer guard rather than a format error.
    expect(() => parseDecimal("1e2", 2)).toThrow(/safe integer/);
    // An empty string pads to all zeros and parses to 0. Documented quirk:
    // the feed's *_str fields are never empty, and a stricter parser here
    // would be dead code guarding against a message shape that cannot occur.
    expect(parseDecimal("", 2)).toBe(0);
    // A trailing dot parses as its whole part.
    expect(parseDecimal("65037.", 2)).toBe(6_503_700);
  });
});

describe("formatDecimal edges", () => {
  it("formats zero, negatives, and zero-decimal instruments exactly", () => {
    expect(formatDecimal(0, 2)).toBe("0.00");
    expect(formatDecimal(-5, 2)).toBe("-0.05");
    expect(formatDecimal(-150, 2)).toBe("-1.50");
    expect(formatDecimal(650, 0)).toBe("650");
    expect(formatDecimal(7768, 8)).toBe("0.00007768");
  });

  it("round-trips negative values too", () => {
    // Mirrors the non-negative round-trip in normalize.test.ts; the sign
    // path goes through separate string handling in both directions.
    fc.assert(
      fc.property(
        fc.integer({ min: -2_100_000_000_000_000, max: 0 }),
        fc.integer({ min: 0, max: 8 }),
        (value, decimals) => {
          expect(parseDecimal(formatDecimal(value, decimals), decimals)).toBe(value);
        },
      ),
    );
  });
});
