import { describe, expect, it } from "vitest";
import {
  snapCenterToDeviceGrid, splitCenterForGpu, tickToY, yToTick,
} from "../../src/render/layout";

/**
 * The standpoint must survive the trip into a float32 uniform. At BTC's
 * price float32 spacing is half a tick (a whole tick past 2^23), so the
 * snapped float64 centre used to arrive on the GPU rounded, and pans moved
 * in 4px jumps with held frames between. These run the vertex shader's
 * `y = (uCenterTick - aTick) * uPxPerTick + uCenterYPx` with every operand
 * and every intermediate rounded through Math.fround — an emulation guard
 * for the CPU side of the split, not a proof about any particular GPU.
 */

const f = Math.fround;

/** cells.ts's y, as the shader computes it from the uniforms the split sends. */
function shaderY(tick: number, centerTick: number, ppt: number, centerYPx: number): number {
  const c = splitCenterForGpu(centerTick, ppt, centerYPx);
  return f(f(f(f(c.tick) - f(tick)) * f(ppt)) + f(c.yPx));
}

/** The same, uploading the centre unsplit — what shipped before. */
function unsplitShaderY(tick: number, centerTick: number, ppt: number, centerYPx: number): number {
  return f(f(f(f(centerTick) - f(tick)) * f(ppt)) + f(centerYPx));
}

const VIEW_H = 860;
const CASES = [
  { base: 6_500_000, ppt: 8, dpr: 2 },
  { base: 6_500_000, ppt: 7.368861259017553, dpr: 3 },
  { base: 10_000_000, ppt: 8, dpr: 2 },
  { base: 10_000_000, ppt: 1.0834, dpr: 3 },
];

/** A slow drag: 300 frames of sub-pixel steps, each drawn from the snapped
 * standpoint the renderer hands the shader. */
function* pan(base: number, ppt: number, dpr: number): Generator<number> {
  for (let i = 0; i < 300; i++) {
    yield snapCenterToDeviceGrid(base + 0.3 + i * (0.3 / ppt), ppt, dpr);
  }
}

const params = (centerTick: number, ppt: number) => ({
  viewW: 1440, viewH: VIEW_H, centerTick, pxPerTick: ppt, pxPerSat: 1, seamX: 720, layout: 0 as const,
});

describe("float32 standpoint split", () => {
  it("sends a whole tick that float32 holds exactly, and a remainder under half a tick", () => {
    for (const { base, ppt, dpr } of CASES) {
      for (const center of pan(base, ppt, dpr)) {
        const c = splitCenterForGpu(center, ppt, VIEW_H / 2);
        expect(f(c.tick)).toBe(c.tick);
        expect(Math.abs(c.yPx - VIEW_H / 2)).toBeLessThanOrEqual(0.5 * ppt + 1e-9);
      }
    }
  });

  it("draws every row within 1e-3 px of the float64 layout across a sub-pixel pan", () => {
    for (const { base, ppt, dpr } of CASES) {
      let worstSplit = 0;
      let worstUnsplit = 0;
      for (const center of pan(base, ppt, dpr)) {
        const p = params(center, ppt);
        for (let k = -40; k <= 40; k++) {
          const tick = base + k;
          const want = tickToY(tick, p);
          worstSplit = Math.max(worstSplit, Math.abs(shaderY(tick, center, ppt, VIEW_H / 2) - want));
          worstUnsplit = Math.max(worstUnsplit, Math.abs(unsplitShaderY(tick, center, ppt, VIEW_H / 2) - want));
        }
      }
      expect(worstSplit).toBeLessThan(1e-3);
      // The guard has teeth: the unsplit upload is off by whole pixels here.
      expect(worstUnsplit).toBeGreaterThan(0.5);
    }
  });

  it("keeps every row's device-pixel phase constant as the field pans", () => {
    for (const { base, ppt, dpr } of CASES) {
      const rows = [0, 1, 5, 13, 37].map((k) => base - k);
      let first: number[] | null = null;
      for (const center of pan(base, ppt, dpr)) {
        const phases = rows.map((tick) => {
          const y = shaderY(tick, center, ppt, VIEW_H / 2) * dpr;
          return y - Math.floor(y);
        });
        first ??= phases;
        phases.forEach((v, i) => {
          // Circular distance: a phase of 0.9999 and one of 0.0001 agree.
          const d = Math.abs(v - first![i]);
          expect(Math.min(d, 1 - d)).toBeLessThan(1e-3);
        });
      }
    }
  });

  it("agrees with float64 hit-testing: the drawn row resolves to its own tick", () => {
    for (const { base, ppt, dpr } of CASES) {
      for (const center of pan(base, ppt, dpr)) {
        const p = params(center, ppt);
        for (let k = -20; k <= 20; k++) {
          const tick = base + k;
          expect(yToTick(shaderY(tick, center, ppt, VIEW_H / 2), p)).toBe(tick);
        }
      }
    }
  });
});
