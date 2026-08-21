import { describe, expect, it } from "vitest";
import { Prng } from "../../src/sources/synthetic/prng";

/**
 * Direct tests for the PRNG every synthetic stream flows from. A wrong
 * constant or shifted draw here would silently reshape every seeded run
 * while the determinism tests (same seed twice) kept passing.
 *
 * Golden provenance: mulberry32 is a published algorithm (Tommy Ettinger;
 * bryc's JS PRNG collection). The pinned uniforms below were produced by an
 * independently typed copy of that reference implementation, run separately
 * from this codebase, and are SPEC-exact: the algorithm uses only integer
 * ops, Math.imul, and one division by 2^32, all IEEE-754-mandated, so these
 * values are identical on every conforming JS engine.
 *
 * Known deliberate difference from the reference, on record: the reference
 * wraps its state to 32 bits each step (`a = a + 0x6D2B79F5 | 0`) while this
 * implementation accumulates the state in a float. The two agree exactly
 * until the accumulated state loses integer precision at 2^53, roughly 4.9
 * million draws in; past that the stream is still deterministic per seed but
 * no longer canonical mulberry32. No run in this piece consumes that many
 * draws between reseeds.
 */

const GOLDEN_SEED_42 = [
  0.60110375192016363, 0.44829055899754167, 0.85246579349040985,
  0.66973404143936932, 0.17481389874592423, 0.52659254218451679,
  0.27322799433022738, 0.62474465393461287,
];
const GOLDEN_SEED_2026 = [
  0.45540769933722913, 0.30849614599719644, 0.66115744924172759,
  0.61847521830350161,
];

/** Counts every uniform drawn, then delegates to the real generator. */
class CountingPrng extends Prng {
  draws = 0;
  override next(): number {
    this.draws++;
    return super.next();
  }
}

describe("Prng.next", () => {
  it("matches the independently computed mulberry32 reference exactly", () => {
    const prng = new Prng(42);
    expect(GOLDEN_SEED_42.map(() => prng.next())).toEqual(GOLDEN_SEED_42);
    const prng2 = new Prng(2026);
    expect(GOLDEN_SEED_2026.map(() => prng2.next())).toEqual(GOLDEN_SEED_2026);
  });

  it("stays in [0, 1) over 10,000 draws", () => {
    const prng = new Prng(7);
    for (let i = 0; i < 10_000; i++) {
      const u = prng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("is deterministic per seed, and different seeds differ", () => {
    const a = new Prng(42);
    const b = new Prng(42);
    const c = new Prng(43);
    const streamA = Array.from({ length: 100 }, () => a.next());
    const streamB = Array.from({ length: 100 }, () => b.next());
    const streamC = Array.from({ length: 100 }, () => c.next());
    expect(streamA).toEqual(streamB);
    expect(streamA).not.toEqual(streamC);
  });
});

describe("draw-count contract", () => {
  // Every seeded run replays only because each helper consumes a FIXED
  // number of uniforms. A branch that adds or skips a draw shifts every
  // downstream value in every synthetic stream; this pins the budget.
  it("next=1, exponential=1, int=1, chance=1, pick=1, size=2", () => {
    const prng = new CountingPrng(42);
    prng.next();
    expect(prng.draws).toBe(1);
    prng.exponential(3);
    expect(prng.draws).toBe(2);
    prng.int(1, 6);
    expect(prng.draws).toBe(3);
    prng.chance(0.5);
    expect(prng.draws).toBe(4);
    prng.pick([10, 20, 30]);
    expect(prng.draws).toBe(5);
    prng.size(1000);
    expect(prng.draws).toBe(7);
  });
});

describe("derived draws", () => {
  // The helpers are checked against a manual re-derivation fed by a twin
  // generator on the same seed: this verifies the wiring (which uniform goes
  // where, 1-u vs u) without pinning engine-specific Math.log/cos output.
  it("exponential(rate) is -ln(1 - u) / rate of the next uniform", () => {
    const prng = new Prng(11);
    const twin = new Prng(11);
    for (const rate of [0.25, 1, 9]) {
      const expected = -Math.log(1 - twin.next()) / rate;
      expect(prng.exponential(rate)).toBe(expected);
    }
  });

  it("size(median, spread) is the Box-Muller lognormal of the next two uniforms", () => {
    const prng = new Prng(11);
    const twin = new Prng(11);
    for (const [median, spread] of [
      [8_000_000, 1],
      [1000, 0.4],
    ] as const) {
      const u1 = twin.next();
      const u2 = twin.next();
      const gaussian = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
      const expected = Math.max(1, Math.round(median * Math.exp(spread * gaussian)));
      expect(prng.size(median, spread)).toBe(expected);
    }
  });

  it("size never returns below 1 sat", () => {
    const prng = new Prng(3);
    for (let i = 0; i < 2000; i++) {
      expect(prng.size(2, 3)).toBeGreaterThanOrEqual(1);
    }
  });

  it("int(min, max) is inclusive on both ends and never escapes", () => {
    const prng = new Prng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = prng.int(2, 7);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    // 5000 draws across 6 buckets: every value including both endpoints.
    expect([...seen].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("chance(0) is never true; chance(1) is always true", () => {
    const prng = new Prng(9);
    for (let i = 0; i < 1000; i++) {
      expect(prng.chance(0)).toBe(false);
      expect(prng.chance(1)).toBe(true);
    }
  });
});
