import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { Side, type SeedOrder } from "../../src/engine/types";
import { packFrame } from "../../src/worker/packer";
import {
  FRAME_BYTES,
  FRAME_HEADER_FLOATS,
  FRAME_MAX_INSTANCES,
  FRAME_STRIDE,
  Header,
} from "../../src/worker/protocol";

/**
 * Content tests for the frame packer. The perf suite proves packFrame is
 * fast; nothing previously asserted that a single packed byte was CORRECT —
 * a wrong stride offset, cum sum, or percentile index would render a
 * plausible-looking wrong book with every test green.
 *
 * Golden provenance: the book below is small enough that every header field
 * and instance record is computed by hand in the comments, from the layout
 * contract in protocol.ts and the iteration order documented in packer.ts.
 * All values are small integers or exactly representable in Float32, so the
 * pins are exact, not approximate.
 */

function seededEngine(orders: SeedOrder[]): Engine {
  const engine = new Engine("external");
  engine.apply({ kind: "seed", orders });
  return engine;
}

// Hand-built book (ticks are f32-exact: all < 2^24):
//   bids: 6503790 -> [100, 250] sats (queue order), 6503780 -> [500]
//   asks: 6503800 -> [300, 50], 6503820 -> [1000]
const BOOK: SeedOrder[] = [
  { id: 1, side: Side.Bid, tick: 6_503_790, sats: 100, micro: 10 },
  { id: 2, side: Side.Bid, tick: 6_503_790, sats: 250, micro: 11 },
  { id: 3, side: Side.Bid, tick: 6_503_780, sats: 500, micro: 12 },
  { id: 4, side: Side.Ask, tick: 6_503_800, sats: 300, micro: 13 },
  { id: 5, side: Side.Ask, tick: 6_503_820, sats: 1000, micro: 14 },
  { id: 6, side: Side.Ask, tick: 6_503_800, sats: 50, micro: 15 },
];

describe("packFrame content", () => {
  it("packs every header field of the hand-built book exactly", () => {
    const engine = seededEngine(BOOK);
    const buffer = new ArrayBuffer(FRAME_BYTES);
    const result = packFrame(engine, buffer, () => 7);
    const f32 = new Float32Array(buffer);

    expect(result.instances).toBe(6);
    expect(result.droppedFarOrders).toBe(0);
    // Core sizes sorted: [50, 100, 250, 300, 500, 1000]; median index 6>>1=3.
    expect(result.coreMedianSats).toBe(300);

    expect(f32[Header.InstanceCount]).toBe(6);
    expect(f32[Header.BestBidTick]).toBe(6_503_790);
    expect(f32[Header.BestAskTick]).toBe(6_503_800);
    expect(f32[Header.MidTick]).toBe(6_503_795);
    expect(f32[Header.SpreadTicks]).toBe(10);
    // Near band = mid * 0.0015 ~ 9756 ticks: the whole book is inside it.
    expect(f32[Header.BidDepthNearSats]).toBe(850);
    expect(f32[Header.AskDepthNearSats]).toBe(1350);
    // spanHint: bidAt = bids.ticks[max(2-4,0)] = 6503780,
    // askAt = asks.ticks[min(3,1)] = 6503820, spread = 10;
    // toFourth = max(15, 25, 18) = 25; min(25, max(40, 30)) * 1.15 = 28.75
    // (exact in f32: 0.75 is a dyadic fraction).
    expect(f32[Header.SpanHintTicks]).toBe(28.75);
    // Level totals in pack order: bids-from-touch [350, 500], asks [350, 1000];
    // sorted [350, 350, 500, 1000]; index min(floor(4*0.8), 3) = 3.
    expect(f32[Header.CoreLevelP80Sats]).toBe(1000);
    expect(f32[Header.LoTick]).toBe(6_503_780);
    expect(f32[Header.HiTick]).toBe(6_503_820);
  });

  it("packs each instance record in touch-outward queue order", () => {
    const engine = seededEngine(BOOK);
    const buffer = new ArrayBuffer(FRAME_BYTES);
    packFrame(engine, buffer, () => 7);
    const f32 = new Float32Array(buffer);

    // [tick, cumBefore, sats, side, ageSec, flags] per instance. Bids pack
    // first from the touch outward, then asks; within a level, queue order.
    const expected = [
      [6_503_790, 0, 100, Side.Bid, 7, 0],
      [6_503_790, 100, 250, Side.Bid, 7, 0],
      [6_503_780, 0, 500, Side.Bid, 7, 0],
      [6_503_800, 0, 300, Side.Ask, 7, 0],
      [6_503_800, 300, 50, Side.Ask, 7, 0],
      [6_503_820, 0, 1000, Side.Ask, 7, 0],
    ];
    const actual = expected.map((_, i) => {
      const at = FRAME_HEADER_FLOATS + i * FRAME_STRIDE;
      return Array.from(f32.slice(at, at + FRAME_STRIDE));
    });
    expect(actual).toEqual(expected);
  });

  it("zeroes the touch fields on an empty book", () => {
    const engine = new Engine("external");
    const buffer = new ArrayBuffer(FRAME_BYTES);
    const result = packFrame(engine, buffer, () => 0);
    const f32 = new Float32Array(buffer);
    expect(result.instances).toBe(0);
    // Empty-book fallbacks are part of the contract (renderer trusts them).
    expect(result.coreMedianSats).toBe(8_000_000);
    expect(f32[Header.InstanceCount]).toBe(0);
    expect(f32[Header.BestBidTick]).toBe(0);
    expect(f32[Header.BestAskTick]).toBe(0);
    expect(f32[Header.MidTick]).toBe(0);
    expect(f32[Header.SpreadTicks]).toBe(0);
    expect(f32[Header.CoreLevelP80Sats]).toBe(20_000_000);
    expect(f32[Header.LoTick]).toBe(0);
    expect(f32[Header.HiTick]).toBe(0);
  });

  it("drops only the far tail at the instance cap, and reports the drop", () => {
    // One bid at the touch plus FRAME_MAX_INSTANCES+1 asks ascending from
    // the touch: the two orders past the cap are the two FARTHEST asks.
    // This book also forces OrderStore.grow() (33k orders > 16384 capacity),
    // so the invariant sweep below doubles as a growth integrity check.
    const orders: SeedOrder[] = [
      { id: 1, side: Side.Bid, tick: 999, sats: 5, micro: 1 },
    ];
    for (let i = 0; i <= FRAME_MAX_INSTANCES; i++) {
      orders.push({ id: 1000 + i, side: Side.Ask, tick: 1000 + i, sats: 7, micro: 2 });
    }
    const engine = seededEngine(orders);
    expect(checkInvariants(engine)).toEqual([]);

    const buffer = new ArrayBuffer(FRAME_BYTES);
    const result = packFrame(engine, buffer, () => 0);
    const f32 = new Float32Array(buffer);

    expect(result.instances).toBe(FRAME_MAX_INSTANCES);
    expect(result.droppedFarOrders).toBe(2);
    expect(f32[Header.InstanceCount]).toBe(FRAME_MAX_INSTANCES);
    // The last packed instance is the last one INSIDE the cap: the bid plus
    // the first FRAME_MAX_INSTANCES-1 asks end at tick 1000 + (cap-2).
    const lastAt = FRAME_HEADER_FLOATS + (FRAME_MAX_INSTANCES - 1) * FRAME_STRIDE;
    expect(f32[lastAt]).toBe(1000 + FRAME_MAX_INSTANCES - 2);
    // The extent header still reports the true book, dropped tail included.
    expect(f32[Header.HiTick]).toBe(1000 + FRAME_MAX_INSTANCES);
  });
});
