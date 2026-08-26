import type { Engine } from "../engine/engine";
import { NIL } from "../engine/store";
import { FLAG_LIQUIDATION } from "../engine/store";
import { Side } from "../engine/types";
import { FRAME_HEADER_FLOATS, FRAME_MAX_INSTANCES, FRAME_STRIDE, Header } from "./protocol";

/**
 * Serialize the engine's resting book into the binary frame the renderer
 * draws from (layout in protocol.ts). A pure function of engine state: every
 * field, `restedAtSec` included, is constant for as long as an order rests,
 * so two packs of an unchanged book produce identical bytes. That is load
 * bearing — the pipeline skips the pack entirely when the book has not moved,
 * and it can only do that because nothing here is derived from "now".
 *
 * Iteration order is by side, then price from the touch outward, then queue
 * position — so if the instance cap is ever hit, what's dropped is the far
 * tail, never the living core (and the drop is reported, not silent).
 */
export function packFrame(
  engine: Engine,
  buffer: ArrayBuffer,
  restedAtSecOf: (slot: number) => number,
): { instances: number; droppedFarOrders: number; coreMedianSats: number } {
  const f32 = new Float32Array(buffer);
  const store = engine.store;
  let write = FRAME_HEADER_FLOATS;
  let instances = 0;
  let dropped = 0;
  // Sizes of the orders in the top levels — the cells actually on screen at
  // rest. The renderer anchors its length scale on their median, because any
  // global statistic is dragged around by whale quotes and far-tail dust.
  const coreSizes: number[] = [];
  // Total depth of each top level — the spine (phone) layout scales width by
  // level totals, not per-order sizes.
  const coreLevelTotals: number[] = [];

  const packSide = (side: Side): void => {
    const book = engine.sideBook(side);
    const ticks = book.ticks;
    // Bids descend from the touch, asks ascend: index from the correct end.
    const n = ticks.length;
    for (let i = 0; i < n; i++) {
      const tick = side === Side.Bid ? ticks[n - 1 - i] : ticks[i];
      const level = book.levels.get(tick)!;
      if (i < 15) coreLevelTotals.push(level.totalSats);
      let cumBefore = 0;
      for (let slot = level.head; slot !== NIL; slot = store.next[slot]) {
        if (instances >= FRAME_MAX_INSTANCES) {
          dropped++;
          cumBefore += store.sats[slot];
          continue;
        }
        if (i < 15) coreSizes.push(store.sats[slot]);
        f32[write] = store.tick[slot];
        f32[write + 1] = cumBefore;
        f32[write + 2] = store.sats[slot];
        f32[write + 3] = side;
        f32[write + 4] = restedAtSecOf(slot);
        f32[write + 5] = (store.flags[slot] & FLAG_LIQUIDATION) !== 0 ? 1 : 0;
        write += FRAME_STRIDE;
        instances++;
        cumBefore += store.sats[slot];
      }
    }
  };
  packSide(Side.Bid);
  packSide(Side.Ask);
  coreSizes.sort((a, b) => a - b);
  const coreMedianSats = coreSizes.length > 0 ? coreSizes[coreSizes.length >> 1] : 8_000_000;
  coreLevelTotals.sort((a, b) => a - b);
  const coreLevelP80 =
    coreLevelTotals.length > 0
      ? coreLevelTotals[Math.min(Math.floor(coreLevelTotals.length * 0.8), coreLevelTotals.length - 1)]
      : 20_000_000;

  const bestBid = engine.bestBid();
  const bestAsk = engine.bestAsk();

  // Book extent for the camera: deepest bid (or the whole book's low) and
  // farthest ask, O(1) off the ends of the ascending tick arrays.
  const bt = engine.bids.ticks;
  const at = engine.asks.ticks;
  const lows = [bt[0], at[0]].filter((t) => t !== undefined);
  const highs = [bt[bt.length - 1], at[at.length - 1]].filter((t) => t !== undefined);
  const loTick = lows.length > 0 ? Math.min(...lows) : 0;
  const hiTick = highs.length > 0 ? Math.max(...highs) : 0;
  f32[Header.LoTick] = loTick;
  f32[Header.HiTick] = hiTick;

  // Camera span hint: a BIRD'S EYE — the frame holds the BODY of the book,
  // and holds the same amount of it from one minute to the next. A
  // standpoint that keeps re-choosing itself is what made the piece restless.
  //
  // "Body", not extent, and the difference is the whole reason rows are
  // legible: framing the absolute extent lets ONE lone order set the scale
  // for everything else. Measured on the synthetic understudy, the farthest
  // resting order sits 68 to 172 ticks out depending on nothing but luck,
  // and framing it squeezed every row to 3px and made the zoom lurch when
  // that order died. A percentile of the occupied levels is both closer and
  // far steadier. Three quarters, not more: the 85th sits at 40-50 ticks and
  // still wobbles enough to keep re-committing the zoom (measured: 68
  // distinct scale values in 40s), while the 75th sits at a flat 35-36 and
  // barely moves at all (5 values in 40s), which lets the profile ceiling do
  // the framing and hold it exactly. Rows land at ~7px. The quarter left
  // outside is the far tail, still reachable by pan (travel is clamped to
  // the TRUE extent) or by the viewer's own zoom-out.
  //
  // The price bound on top is not optional: a real book's far constellation
  // is not a neighborhood at all. BTC/USD rests asks past $21M and bids at a
  // cent, and 6,536 occupied levels put even the 75th percentile $65,000 out
  // — no percentile saves that, so the bound does. It is a fraction of the
  // PRICE, not of the spread: price is the instrument's own scale and barely
  // moves, where the spread breathes every second and would drag the
  // standpoint with it. At BTC's price it is a few dollars either side.
  //
  // Cost: the walk stops at the percentile OR at the bound, whichever comes
  // first, so a deep live book costs the handful of levels inside a few
  // dollars, not a scan of all 6,536.
  let spanHint = 30;
  if (bestBid !== undefined && bestAsk !== undefined) {
    const mid = (bestBid + bestAsk) / 2;
    const bound = Math.max(mid * 5e-5, 200);
    const target = Math.ceil((bt.length + at.length) * 0.75);
    // Both sides are sorted ascending, so distance from mid grows as the bid
    // index walks down and the ask index walks up: a two-pointer merge visits
    // occupied levels in true distance order.
    let bi = bt.length - 1;
    let ai = 0;
    let seen = 0;
    let reach = 0;
    while (seen < target) {
      const dBid = bi >= 0 ? mid - bt[bi] : Infinity;
      const dAsk = ai < at.length ? at[ai] - mid : Infinity;
      const next = Math.min(dBid, dAsk);
      if (next > bound) break; // the bound governs; no need to walk the tail
      reach = next;
      if (dBid <= dAsk) bi--;
      else ai++;
      seen++;
    }
    // A little air past the last framed level, so the body of the book does
    // not sit flush against the frame edge.
    spanHint = Math.max(Math.min(seen < target ? bound : reach * 1.1, bound), 24);
  }
  f32[Header.SpanHintTicks] = spanHint;
  f32[Header.CoreLevelP80Sats] = coreLevelP80;

  f32[Header.InstanceCount] = instances;
  f32[Header.BestBidTick] = bestBid ?? 0;
  f32[Header.BestAskTick] = bestAsk ?? 0;
  f32[Header.MidTick] =
    bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : 0;
  f32[Header.SpreadTicks] =
    bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : 0;

  // Near-mid depth (±0.15% of mid): the input to the vacuum detector and the
  // narrator's "stacked three to one" phrasing.
  let bidNear = 0;
  let askNear = 0;
  if (bestBid !== undefined && bestAsk !== undefined) {
    const mid = (bestBid + bestAsk) / 2;
    const band = mid * 0.0015;
    for (const tick of engine.bids.ticks) {
      if (tick >= mid - band) bidNear += engine.bids.levels.get(tick)!.totalSats;
    }
    for (const tick of engine.asks.ticks) {
      if (tick <= mid + band) askNear += engine.asks.levels.get(tick)!.totalSats;
    }
  }
  f32[Header.BidDepthNearSats] = bidNear;
  f32[Header.AskDepthNearSats] = askNear;

  return { instances, droppedFarOrders: dropped, coreMedianSats };
}
