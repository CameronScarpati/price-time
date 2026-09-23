import { afterEach, describe, expect, it, vi } from "vitest";
import { LengthScale } from "../../src/render/renderer";
import { Pipeline } from "../../src/worker/pipeline";
import { FRAME_BYTES, Header } from "../../src/worker/protocol";

/**
 * The length scale is a lens, taken once per book and then held. Every
 * change to it re-lengthens every cell in the field at once, and a scale
 * that followed the noisy median did that two or three times a minute with
 * nothing happening. These pin the contract: nothing before the book has
 * assembled, one cut when it has, nothing after — until the book is
 * replaced. There is no reduced-motion variant to test: no path eases.
 */

const QUIET = { transition: null, degraded: false } as const;
const SEAM = 0 as const;

function committed(target = 2e-6): LengthScale {
  const ls = new LengthScale(5e-6);
  ls.frame(QUIET);
  ls.offer(target, 500, true, SEAM, 1440);
  return ls;
}

describe("length scale: one commit per book", () => {
  it("holds its scale until the book has assembled, then takes the target in one cut", () => {
    const ls = new LengthScale(5e-6);
    ls.frame(QUIET);
    ls.offer(1e-6, 23, true, SEAM, 1440); // too few orders to trust a median
    ls.offer(1e-6, 5_000, false, SEAM, 1440); // one side empty
    expect(ls.pxPerSat).toBe(5e-6);
    ls.offer(3e-6, 24, true, SEAM, 1440);
    expect(ls.pxPerSat).toBe(3e-6); // exactly the target: no travel
  });

  it("holds exactly at rest after the commit, whatever the statistic does", () => {
    const ls = committed(2e-6);
    for (let i = 0; i < 10_000; i++) {
      // The median wanders from a third to three times the committed value.
      ls.offer(2e-6 * (0.33 + 2.67 * ((i * 7919) % 1000) / 1000), 500, true, SEAM, 1440);
      expect(ls.pxPerSat).toBe(2e-6);
    }
  });

  it("re-commits after a reseed, and only once the new book is flowing", () => {
    const ls = committed(2e-6);
    // Reseeding: the old book is still on screen, two-sided and full — it
    // must not be taken as the new book's scale.
    ls.frame({ transition: null, degraded: true });
    ls.offer(9e-6, 500, true, SEAM, 1440);
    expect(ls.pxPerSat).toBe(2e-6);
    ls.frame(QUIET); // the snapshot landed and the source is flowing
    ls.offer(4e-6, 6_000, true, SEAM, 1440);
    expect(ls.pxPerSat).toBe(4e-6);
    ls.offer(8e-6, 6_000, true, SEAM, 1440);
    expect(ls.pxPerSat).toBe(4e-6);
  });

  it("re-commits on a mode switch", () => {
    const ls = committed(2e-6);
    ls.frame({ transition: { from: "live", to: "synthetic" }, degraded: false });
    ls.offer(3e-6, 6_000, true, SEAM, 1440); // a seeded handoff arrives whole
    expect(ls.pxPerSat).toBe(3e-6);
  });

  it("re-commits when the layout changes or the spine's width does, not otherwise", () => {
    const ls = new LengthScale(5e-6);
    ls.frame(QUIET);
    ls.offer(8e-6, 500, true, 1, 390);
    ls.offer(9e-6, 500, true, 1, 390);
    expect(ls.pxPerSat).toBe(8e-6);
    ls.offer(9e-6, 500, true, 1, 430); // the spine scales by width
    expect(ls.pxPerSat).toBe(9e-6);
    ls.offer(3e-6, 500, true, SEAM, 430); // the seam scales by order size
    expect(ls.pxPerSat).toBe(3e-6);
    // So a seam window dragged wider keeps its scale: no re-cut per resize.
    ls.offer(4e-6, 500, true, SEAM, 1440);
    ls.offer(5e-6, 500, true, SEAM, 1920);
    expect(ls.pxPerSat).toBe(3e-6);
  });
});

describe("length scale on the synthetic understudy", () => {
  let pipeline: Pipeline | null = null;
  afterEach(() => {
    pipeline?.stop();
    pipeline = null;
    vi.useRealTimers();
  });

  it("assembling from nothing, the scale is written once in a minute", () => {
    vi.useFakeTimers();
    pipeline = new Pipeline();
    pipeline.start("synthetic", 42);
    const buffer = new ArrayBuffer(FRAME_BYTES);
    const f32 = new Float32Array(buffer);
    const ls = new LengthScale(5e-6);
    const writes: { ms: number; orders: number }[] = [];
    for (let ms = 0; ms < 60_000; ms += 16) {
      vi.advanceTimersByTime(16);
      const meta = pipeline.fillFrame(buffer);
      ls.frame(meta);
      const before = ls.pxPerSat;
      const target = 26 / Math.max(meta.stats.coreMedianSats, 50_000); // the seam's rule
      ls.offer(target, f32[Header.InstanceCount], f32[Header.MidTick] !== 0, SEAM, 1440);
      if (ls.pxPerSat !== before) writes.push({ ms, orders: f32[Header.InstanceCount] });
    }
    expect(writes).toHaveLength(1);
    expect(writes[0].orders).toBeGreaterThanOrEqual(24);
    // Measured at seed 42: the book reaches two dozen orders ~2.5s in.
    expect(writes[0].ms).toBeLessThan(8_000);
  });
});
