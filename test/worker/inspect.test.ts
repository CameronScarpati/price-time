import { afterEach, describe, expect, it, vi } from "vitest";
import { NIL } from "../../src/engine/store";
import { Side } from "../../src/engine/types";
import type { Engine } from "../../src/engine/engine";
import { hitTest, type LayoutParams } from "../../src/render/layout";
import { Pipeline } from "../../src/worker/pipeline";

/**
 * The inspector names the order drawn nearest the pointer. On the live frame
 * a row is two pixels tall and a tick is about one, so a lookup that needed
 * the exact row and the exact queue span under the pointer missed most of
 * what a viewer aimed at. These pin the probe: a direct hit is still the
 * order under the pointer, a near miss finds the nearest row, and nothing
 * past the slop answers at all.
 */

let pipeline: Pipeline | null = null;
afterEach(() => {
  pipeline?.stop();
  pipeline = null;
  vi.useRealTimers();
});

function started(): { p: Pipeline; engine: Engine } {
  vi.useFakeTimers();
  const p = new Pipeline();
  p.start("synthetic", 42);
  vi.advanceTimersByTime(20_000);
  pipeline = p;
  return { p, engine: (p as unknown as { engine: Engine }).engine };
}

function queue(engine: Engine, side: Side, tick: number): { id: number; sats: number }[] {
  const level = engine.sideBook(side).levels.get(tick)!;
  const out: { id: number; sats: number }[] = [];
  for (let s = level.head; s !== NIL; s = engine.store.next[s]) {
    out.push({ id: engine.store.id[s], sats: engine.store.sats[s] });
  }
  return out;
}

describe("inspector probe (worker)", () => {
  it("still names the order whose queue span holds the pointer", () => {
    const { p, engine } = started();
    const tick = engine.bids.bestTick()!;
    const orders = queue(engine, Side.Bid, tick);
    let cum = 0;
    for (const o of orders) {
      const mid = cum + o.sats / 2;
      expect(p.inspect([Side.Bid], tick, 0, mid, 0)?.id).toBe(o.id);
      cum += o.sats;
    }
  });

  it("finds the nearest row within reach, and nothing beyond it", () => {
    const { p, engine } = started();
    const best = engine.bids.bestTick()!;
    const front = queue(engine, Side.Bid, best)[0]!;
    // No bid rests above the best bid, so three ticks up is empty space
    // three rows from the nearest bid.
    expect(p.inspect([Side.Bid], best + 3, 3, 0, 0)?.id).toBe(front.id);
    expect(p.inspect([Side.Bid], best + 3, 2.9, 0, 0)).toBeNull();
    // Reach is measured from the pointer's fractional tick, not a rounded one.
    expect(p.inspect([Side.Bid], best + 0.6, 0.6, 0, 0)?.id).toBe(front.id);
    expect(p.inspect([Side.Bid], best + 0.6, 0.55, 0, 0)).toBeNull();
  });

  it("searches only the rows inside the visible bounds", () => {
    const { p, engine } = started();
    const best = engine.bids.bestTick()!;
    const front = queue(engine, Side.Bid, best)[0]!;
    expect(p.inspect([Side.Bid], best + 0.6, 1, 0, 0, best, best)?.id).toBe(front.id);
    expect(p.inspect([Side.Bid], best + 0.6, 1, 0, 0, best + 1, Infinity)).toBeNull();
    expect(p.inspect([Side.Bid], best + 0.6, 1, 0, 0, 1, best - 1)).toBeNull();
  });

  it("takes the nearer of two rows first", () => {
    const { p, engine } = started();
    const ticks = engine.bids.ticks;
    // Two occupied bid levels with a gap: a pointer a little nearer either
    // one must name that one.
    let i = ticks.length - 1;
    while (i > 0 && ticks[i] - ticks[i - 1] < 2) i--;
    const hi = ticks[i];
    const lo = ticks[i - 1];
    const mid = (hi + lo) / 2;
    const reach = hi - lo;
    expect(p.inspect([Side.Bid], mid + 0.2, reach, 0, 0)?.tick).toBe(hi);
    expect(p.inspect([Side.Bid], mid - 0.2, reach, 0, 0)?.tick).toBe(lo);
  });

  it("takes the back of the queue within the slop past its end", () => {
    const { p, engine } = started();
    const tick = engine.asks.bestTick()!;
    const orders = queue(engine, Side.Ask, tick);
    const total = orders.reduce((a, o) => a + o.sats, 0);
    const last = orders[orders.length - 1]!;
    expect(p.inspect([Side.Ask], tick, 0, total + 500, 1000)?.id).toBe(last.id);
    expect(p.inspect([Side.Ask], tick, 0, total + 1500, 1000)).toBeNull();
  });
});

describe("inspector probe (layout)", () => {
  const seam: LayoutParams = {
    viewW: 1440, viewH: 860, centerTick: 1000, pxPerTick: 1.1, pxPerSat: 1e-5,
    seamX: 720, layout: 0, centerYFrac: 0.5,
  };

  it("sizes the reach and the queue slop from the pixel slop", () => {
    const hit = hitTest(700, 430, seam, 999, 1001, 6)!;
    expect(hit.sides).toEqual([Side.Bid]);
    expect(hit.tickAt).toBe(1000);
    // Half a 2px row, half a pixel of device snapping, and the slop.
    expect(hit.reachTicks).toBeCloseTo((1 + 0.5 + 6) / 1.1);
    expect(hit.satsSlop).toBeCloseTo(6 / 1e-5);
    expect(hitTest(700, 430, seam, 999, 1001, 14)!.reachTicks).toBeCloseTo((1 + 0.5 + 14) / 1.1);
  });

  it("keeps the slop when zoomed in, where a row is many pixels tall", () => {
    // At 20 px/tick a row is 19px tall: a pointer 12px from a row's centre
    // is 2.5px past its edge and must still reach it.
    const close = { ...seam, pxPerTick: 20 };
    const hit = hitTest(700, 430 - 12, close, 1001, 1002, 6)!;
    expect(hit.tickAt).toBeCloseTo(1000.6);
    expect(Math.abs(1000 - hit.tickAt)).toBeLessThanOrEqual(hit.reachTicks);
    // ... and 17px away (7.5px past the edge) it must not.
    const far = hitTest(700, 430 - 17, close, 1001, 1002, 6)!;
    expect(Math.abs(1000 - far.tickAt)).toBeGreaterThan(far.reachTicks);
  });

  it("does not answer inside the bottom band, where rows are not drawn", () => {
    expect(hitTest(700, 860 - 47, seam, 1200, 1201, 6)).not.toBeNull();
    expect(hitTest(700, 860 - 46, seam, 1200, 1201, 6)).toBeNull();
    const spine: LayoutParams = { ...seam, viewW: 390, viewH: 844, seamX: 10, layout: 1 };
    expect(hitTest(100, 844 - 58, spine, 1200, 1201, 6)).toBeNull();
  });

  it("lets no row drawn wholly inside the bottom band answer", () => {
    // The band starts at 814 in an 860-tall view. A pointer at 810 reaches
    // rows centred down to about 817 by distance; only those with a visible
    // pixel above 814 are in bounds.
    const hit = hitTest(700, 810, seam, 1200, 1201, 6)!;
    const bandTop = 860 - 46;
    const rowAt = (t: number) => (1000 - t) * 1.1 + 430;
    for (let t = Math.ceil(hit.tickAt - hit.reachTicks); t <= hit.tickAt + hit.reachTicks; t++) {
      const inBounds = t >= hit.tickMin && t <= hit.tickMax;
      expect(inBounds).toBe(rowAt(t) - 1 - 0.5 < bandTop);
    }
    expect(hit.tickMin).toBeGreaterThan(hit.tickAt - hit.reachTicks);
  });

  it("lets the lowest price answer below its centre", () => {
    // The $0.01 row, pointed at 0.8px and 5px below its centre: the pointer
    // is on the row, then inside the slop.
    const low = { ...seam, centerTick: 273.78, pxPerTick: 1.154 };
    const y1 = (273.78 - 1) * 1.154 + 430;
    for (const dy of [0.8, 5]) {
      const hit = hitTest(700, y1 + dy, low, 999, 1001, 6)!;
      expect(hit).not.toBeNull();
      expect(hit.tickMin).toBe(1);
      expect(Math.abs(1 - hit.tickAt)).toBeLessThanOrEqual(hit.reachTicks);
    }
    expect(hitTest(700, y1 + 9, low, 999, 1001, 6)).toBeNull();
  });

  it("probes in float64 at any price", () => {
    // The farthest ask in the bundled replay: float32 is 4,096 ticks coarse
    // there, and the probe must still name the tick under the pointer.
    const far = { ...seam, centerTick: 48_398_000_128 };
    const hit = hitTest(800, 430 - 11, far, 6_393_899, 6_393_900, 6)!;
    expect(hit.sides).toEqual([Side.Ask]);
    expect(hit.tickAt).toBeCloseTo(48_398_000_138, 6);
  });

  it("keeps the empty quadrants empty past the slop", () => {
    // Twenty rows above the best bid, left of the seam: no bid is in reach.
    expect(hitTest(700, 430 - 22, seam, 999, 1001, 6)).toBeNull();
  });

  it("searches both sides near the spread on the spine", () => {
    const spine: LayoutParams = { ...seam, viewW: 390, viewH: 844, seamX: 10, layout: 1 };
    const y = 844 / 2;
    expect(hitTest(100, y, spine, 999, 1001, 6)!.sides).toEqual([Side.Bid, Side.Ask]);
    expect(hitTest(100, y + 60, spine, 999, 1001, 6)!.sides).toEqual([Side.Bid]);
  });
});
