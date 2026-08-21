import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { Side, type SeedOrder } from "../../src/engine/types";
import { sanitizeSeed } from "../../src/worker/pipeline";

/**
 * sanitizeSeed guards the live -> synthetic handoff: the internal matcher
 * throws on a crossed seed, so this is the only thing standing between a
 * transiently-crossed live book and a dead understudy. It was previously
 * untested.
 */

function order(id: number, side: Side, tick: number, micro: number): SeedOrder {
  return { id, side, tick, sats: 100, micro };
}

describe("sanitizeSeed examples", () => {
  it("returns a clean book untouched, in order", () => {
    const seed = [
      order(1, Side.Bid, 100, 5),
      order(2, Side.Bid, 99, 6),
      order(3, Side.Ask, 101, 7),
    ];
    expect(sanitizeSeed(seed)).toEqual(seed);
  });

  it("drops the newest crossing order first", () => {
    // Ask 100 (older) and bid 105 (newer) cross each other; the newer bid
    // goes, the older ask stays — the stalest picture is likelier wrong on
    // the side that MOVED, and the newest crossing order carries the move.
    const older = order(1, Side.Ask, 100, 10);
    const newer = order(2, Side.Bid, 105, 20);
    expect(sanitizeSeed([older, newer])).toEqual([older]);
  });

  it("breaks micro ties by dropping the higher id", () => {
    const a = order(1, Side.Ask, 100, 10);
    const b = order(2, Side.Bid, 100, 10);
    expect(sanitizeSeed([a, b])).toEqual([a]);
  });

  it("keeps dropping until the touch uncrosses", () => {
    const seed = [
      order(1, Side.Bid, 90, 1),
      order(2, Side.Ask, 95, 2),
      order(3, Side.Bid, 96, 3),
      order(4, Side.Bid, 97, 4),
    ];
    // 97 and 96 both cross the 95 ask; newest-first removal drops 97 then
    // 96, leaving bid 90 / ask 95.
    expect(sanitizeSeed(seed)).toEqual([order(1, Side.Bid, 90, 1), order(2, Side.Ask, 95, 2)]);
  });
});

describe("sanitizeSeed properties", () => {
  const arbSeed = fc
    .array(
      fc.record({
        side: fc.constantFrom<Side>(Side.Bid, Side.Ask),
        // A narrow tick band forces frequent crossings.
        tick: fc.integer({ min: 95, max: 105 }),
        micro: fc.integer({ min: 0, max: 50 }),
      }),
      { maxLength: 40 },
    )
    .map((rows) => rows.map((row, i) => ({ id: i + 1, sats: 100, ...row })));

  it("output is never crossed, is a subset, and the internal engine accepts it", () => {
    fc.assert(
      fc.property(arbSeed, (seed) => {
        const kept = sanitizeSeed(seed);

        const bids = kept.filter((o) => o.side === Side.Bid).map((o) => o.tick);
        const asks = kept.filter((o) => o.side === Side.Ask).map((o) => o.tick);
        if (bids.length > 0 && asks.length > 0) {
          expect(Math.max(...bids)).toBeLessThan(Math.min(...asks));
        }

        // Subset, order preserved: every kept order is an input order.
        const inputIds = new Set(seed.map((o) => o.id));
        for (const o of kept) expect(inputIds.has(o.id)).toBe(true);

        // Idempotent: sanitizing a sane book changes nothing.
        expect(sanitizeSeed(kept)).toEqual(kept);

        // The whole point: the strict internal matcher must accept the seed.
        const engine = new Engine("internal");
        engine.apply({ kind: "seed", orders: kept });
        expect(checkInvariants(engine)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
