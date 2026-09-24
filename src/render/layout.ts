import { Side } from "../engine/types";

/**
 * The CPU mirror of the vertex shader's layout math — used for hit-testing
 * (the inspector) and for placing the overlay's price rules and gap readout
 * against the rows they label. If this and cells.ts ever disagree, the
 * inspector reports the wrong order, so both quote the same formulas.
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

/**
 * The drawn standpoint as the vertex shader receives it: a WHOLE tick, with
 * the fraction folded into the pixel offset here, in float64.
 *
 * Uniforms reach the GPU as float32, and at BTC's price (~6.5M ticks) float32
 * spacing is half a tick — 4 CSS px at 8 px/tick. Uploading the snapped
 * centre as-is quantized every pan and designed move into 4px jumps with
 * held frames between, undoing the device-grid snap above. A whole tick is
 * exact in float32 below 2^24, so the shader's `uCenterTick - aTick` becomes
 * an exact integer subtraction, and the sub-tick remainder rides in
 * `uCenterYPx`, a few hundred pixels where float32 resolves ~3e-5 px. The
 * sum is `tickToY` rearranged, so hit-testing (which stays float64) agrees.
 */
export function splitCenterForGpu(
  centerTick: number, pxPerTick: number, centerYPx: number,
): { tick: number; yPx: number } {
  const tick = Math.round(centerTick);
  return { tick, yPx: centerYPx + (centerTick - tick) * pxPerTick };
}

export function tickToY(tick: number, p: LayoutParams): number {
  return (p.centerTick - tick) * p.pxPerTick + p.viewH * (p.centerYFrac ?? 0.5);
}

export function yToTick(y: number, p: LayoutParams): number {
  return Math.round(p.centerTick - (y - p.viewH * (p.centerYFrac ?? 0.5)) / p.pxPerTick);
}

/**
 * How far a pointer may land from a drawn cell and still pick it, in CSS px.
 * On the live frame a row is about one pixel tall, so a lookup that asked for
 * the exact row and the exact order under the pointer opened the inspector
 * on almost nothing a viewer aimed at. A finger covers more than a cursor.
 */
export const HIT_SLOP_PX = { mouse: 6, touch: 14 } as const;

/** What the worker searches for the order under the pointer: the rows on
 * `sides` within `tickRadius` of `tick`, nearest first, and in a row the
 * order whose queue span holds `cumSats`, allowing `satsSlop` past the end
 * of the queue (where the shortest cells are drawn longer than their size). */
export interface HitProbe {
  sides: Side[];
  tick: number;
  tickRadius: number;
  cumSats: number;
  satsSlop: number;
}

export function hitTest(
  x: number, y: number, p: LayoutParams, bestBid: number, bestAsk: number,
  slopPx: number = HIT_SLOP_PX.mouse,
): HitProbe | null {
  const tick = yToTick(y, p);
  if (tick <= 0) return null;
  const tickRadius = Math.floor(slopPx / p.pxPerTick);
  const satsSlop = slopPx / p.pxPerSat;
  if (p.layout === 0) {
    // The seam separates the sides spatially; price confirms it. A bid can
    // only rest at or below the best bid — the empty quadrants resolve to
    // nothing unless a row sits within reach.
    const side = x < p.seamX ? Side.Bid : Side.Ask;
    if (side === Side.Bid && tick > bestBid + tickRadius) return null;
    if (side === Side.Ask && tick < bestAsk - tickRadius) return null;
    return { sides: [side], tick, tickRadius, cumSats: Math.abs(x - p.seamX) / p.pxPerSat, satsSlop };
  }
  if (x < p.seamX - slopPx) return null;
  // The spine stacks both sides in one column; near the spread either may
  // be the nearer row, so both are searched.
  const sides: Side[] = [];
  if (tick - tickRadius <= bestBid) sides.push(Side.Bid);
  if (tick + tickRadius >= bestAsk) sides.push(Side.Ask);
  if (sides.length === 0) return null;
  return { sides, tick, tickRadius, cumSats: Math.max(x - p.seamX, 0) / p.pxPerSat, satsSlop };
}
