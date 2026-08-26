import { describe, expect, it } from "vitest";
import { snapCenterToDeviceGrid, tickToY } from "../../src/render/layout";

/**
 * The field slides in whole device pixels or it glitches. Every cell edge is
 * snapped to the device grid in the shader, so a standpoint that moves by a
 * fraction of a device pixel makes each row cross that grid at its own
 * moment — rows change height and spacing against each other mid-pan. These
 * pin the two halves of the contract: the snap really lands on the grid, and
 * it never moves anything far enough to be visible.
 */
describe("device-grid standpoint", () => {
  const CASES = [
    { ppt: 7.368861259017553, dpr: 2 },
    { ppt: 8, dpr: 2 },
    { ppt: 1.0834, dpr: 3 },
    { ppt: 0.05, dpr: 1 },
  ];

  it("lands the centre on a whole device pixel", () => {
    for (const { ppt, dpr } of CASES) {
      for (let i = 0; i < 40; i++) {
        const raw = 6_500_000 + i * 0.137;
        const snapped = snapCenterToDeviceGrid(raw, ppt, dpr);
        const devicePx = snapped * ppt * dpr;
        expect(Math.abs(devicePx - Math.round(devicePx))).toBeLessThan(1e-6);
      }
    }
  });

  it("never moves the standpoint as much as one device pixel", () => {
    for (const { ppt, dpr } of CASES) {
      for (let i = 0; i < 40; i++) {
        const raw = 6_500_000 + i * 0.137;
        const offDevicePx = Math.abs(snapCenterToDeviceGrid(raw, ppt, dpr) - raw) * ppt * dpr;
        expect(offDevicePx).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it("keeps every row's subpixel phase constant as the field pans", () => {
    // The real invariant: with a snapped centre, the distance from any row to
    // the device grid does not change while the camera travels — so the row
    // renders at the same height in every frame of the pan.
    const ppt = 7.368861259017553;
    const dpr = 2;
    const p = { viewW: 1440, viewH: 860, centerTick: 0, pxPerTick: ppt, pxPerSat: 1, seamX: 720, layout: 0 as const };
    const phases = (center: number): number[] => {
      p.centerTick = snapCenterToDeviceGrid(center, ppt, dpr);
      return [0, 1, 5, 13, 37].map((k) => {
        const y = tickToY(6_500_000 - k, p) * dpr;
        return y - Math.floor(y);
      });
    };
    const first = phases(6_500_000);
    for (let i = 1; i < 30; i++) {
      const next = phases(6_500_000 + i * 0.211);
      next.forEach((v, k) => expect(Math.abs(v - first[k])).toBeLessThan(1e-6));
    }
  });

  it("degrades to a no-op rather than NaN at a degenerate scale", () => {
    expect(snapCenterToDeviceGrid(6_500_000, 0, 2)).toBe(6_500_000);
  });
});
