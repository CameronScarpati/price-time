import { afterEach, describe, expect, it, vi } from "vitest";
import { Pipeline } from "../../src/worker/pipeline";
import { FRAME_BYTES } from "../../src/worker/protocol";

/**
 * What crosses the boundary each frame besides the packed book. Discrete
 * events travel as the tape and as detector output only: nothing on the main
 * thread draws a trade or a cancel, so a per-frame event list would be work
 * and structured-clone bytes for no reader.
 */

let pipeline: Pipeline | null = null;
afterEach(() => {
  pipeline?.stop();
  pipeline = null;
  vi.useRealTimers();
});

function started(seed: number): Pipeline {
  vi.useFakeTimers();
  const p = new Pipeline();
  p.start("synthetic", seed);
  pipeline = p;
  return p;
}

describe("frame meta", () => {
  it("carries the tape and the detectors, and no per-frame event list", () => {
    const p = started(42);
    const buffer = new ArrayBuffer(FRAME_BYTES);
    let traded = false;
    for (let i = 0; i < 60 * 30 && !traded; i++) {
      vi.advanceTimersByTime(16);
      const meta = p.fillFrame(buffer);
      expect(Object.keys(meta).sort()).toEqual([
        "caption", "clock", "degraded", "mode", "narration", "nowSec",
        "packsPerSec", "seededFromLive", "stats", "tape", "transition",
      ]);
      traded = meta.tape.length > 0;
    }
    // Trades still reach the tape without the event list beside them.
    expect(traded).toBe(true);
  });

  it("narrates no vacuum while a synthetic book assembles from nothing", () => {
    // Before the baseline, 7 of these 30 seeds captioned a vacuum inside
    // their first half second.
    for (let seed = 1; seed <= 30; seed++) {
      const p = started(seed);
      const buffer = new ArrayBuffer(FRAME_BYTES);
      for (let i = 0; i < 60 * 8; i++) {
        vi.advanceTimersByTime(16);
        const caption = p.fillFrame(buffer).caption;
        expect(caption?.text ?? "", `seed ${seed}`).not.toMatch(/vacuum/);
      }
      p.stop();
      vi.useRealTimers();
    }
  });
});
