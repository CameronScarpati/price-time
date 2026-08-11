import type { Engine } from "../engine/engine";
import { NIL } from "../engine/store";
import { FLAG_LIQUIDATION } from "../engine/store";
import { Side } from "../engine/types";
import { FRAME_HEADER_FLOATS, FRAME_MAX_INSTANCES, FRAME_STRIDE, Header } from "./protocol";

/**
 * Serialize the engine's resting book into the binary frame the renderer
 * draws from (layout in protocol.ts). Pure function of engine state plus the
 * pack-time clock used to turn each order's arrival stamp into an age.
 *
 * Iteration order is by side, then price from the touch outward, then queue
 * position — so if the instance cap is ever hit, what's dropped is the far
 * tail, never the living core (and the drop is reported, not silent).
 */
export function packFrame(
  engine: Engine,
  buffer: ArrayBuffer,
  ageSecOf: (slot: number) => number,
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
        f32[write + 4] = ageSecOf(slot);
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

  // Camera span hint: distance from mid to the ~4th occupied level on each
  // side, so the frame always holds a populated neighborhood. Four, not more:
  // real levels scatter tens of ticks apart even on dense days, and framing
  // many of them squeezes rows below legibility — queue cells are the point.
  let spanHint = 30;
  if (bestBid !== undefined && bestAsk !== undefined) {
    const mid = (bestBid + bestAsk) / 2;
    const bidTicks = engine.bids.ticks;
    const askTicks = engine.asks.ticks;
    const bidAt = bidTicks[Math.max(bidTicks.length - 4, 0)];
    const askAt = askTicks[Math.min(3, askTicks.length - 1)];
    const spread = bestAsk - bestBid;
    const toFourth = Math.max(mid - bidAt, askAt - mid, spread + 8);
    // On a skeletal book the 4th level can sit hundreds of ticks out;
    // framing it fills the screen with void. Cap the frame at a few spreads
    // around the touch — the queue there is the piece — and leave the far
    // constellation to the viewer's own zoom-out.
    spanHint = Math.min(toFourth, Math.max(spread * 4, 30)) * 1.15;
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
