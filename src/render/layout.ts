import { Side } from "../engine/types";

/**
 * The CPU mirror of the vertex shader's layout math — used for hit-testing
 * (the inspector) and for positioning event sprites at the cells they refer
 * to. If this and cells.ts ever disagree, the inspector reports the wrong
 * order, so both quote the same formulas.
 */
export interface LayoutParams {
  viewW: number;
  viewH: number;
  centerTick: number;
  pxPerTick: number;
  pxPerSat: number;
  seamX: number;
  layout: 0 | 1; // 0 seam, 1 spine
}

export function tickToY(tick: number, p: LayoutParams): number {
  return (p.centerTick - tick) * p.pxPerTick + p.viewH / 2;
}

export function yToTick(y: number, p: LayoutParams): number {
  return Math.round(p.centerTick - (y - p.viewH / 2) / p.pxPerTick);
}

/** Screen x of the front of a side's queue (where fills strike). */
export function frontX(side: Side, p: LayoutParams): number {
  return p.layout === 0 ? p.seamX : p.seamX;
}

export function hitTest(
  x: number, y: number, p: LayoutParams, bestBid: number, bestAsk: number,
): { side: Side; tick: number; cumSats: number } | null {
  const tick = yToTick(y, p);
  if (tick <= 0) return null;
  if (p.layout === 0) {
    const side = x < p.seamX ? Side.Bid : Side.Ask;
    // The seam separates the sides spatially; price confirms it. A bid can
    // only rest at or below the best bid's neighborhood — clicks in the
    // empty quadrants resolve to nothing.
    const cumSats = Math.abs(x - p.seamX) / p.pxPerSat;
    if (side === Side.Bid && tick > bestBid) return null;
    if (side === Side.Ask && tick < bestAsk) return null;
    return { side, tick, cumSats };
  }
  const side = tick <= bestBid ? Side.Bid : tick >= bestAsk ? Side.Ask : null;
  if (side === null || x < p.seamX) return null;
  return { side, tick, cumSats: (x - p.seamX) / p.pxPerSat };
}
