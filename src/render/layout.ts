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
  /** Vertical fraction where the center tick sits: 0.5 on the seam; the
   * spine lifts it to the portrait optical center (provenance + safe area
   * occupy the bottom). Must stay in lockstep with cells.ts's uCenterYPx. */
  centerYFrac?: number;
}

/**
 * Where the camera STANDS, rounded to a whole device pixel.
 *
 * Every cell edge is snapped to the device grid (cells.ts) because that is
 * what makes the field sharp. The cost is that a centre which moves by a
 * fraction of a device pixel makes each row's top and bottom cross the grid
 * at different moments — rows shift and change height against each other
 * while the field slides, which is exactly what a pan looked like. Moving
 * the whole field in whole device pixels preserves every row's phase.
 *
 * Presentation only, and by construction the smallest possible: it can never
 * move anything by as much as one device pixel, so no position, ordering, or
 * magnitude a viewer could read is affected. The renderer writes the result
 * into `LayoutParams.centerTick`, so the shader and the inspector's
 * hit-testing both work from the same snapped standpoint.
 */
export function snapCenterToDeviceGrid(
  centerTick: number, pxPerTick: number, dpr: number,
): number {
  const devicePerTick = pxPerTick * dpr;
  if (!(devicePerTick > 0) || !Number.isFinite(devicePerTick)) return centerTick;
  return Math.round(centerTick * devicePerTick) / devicePerTick;
}

export function tickToY(tick: number, p: LayoutParams): number {
  return (p.centerTick - tick) * p.pxPerTick + p.viewH * (p.centerYFrac ?? 0.5);
}

export function yToTick(y: number, p: LayoutParams): number {
  return Math.round(p.centerTick - (y - p.viewH * (p.centerYFrac ?? 0.5)) / p.pxPerTick);
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
