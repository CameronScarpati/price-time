import { describe, expect, it } from "vitest";
import { Detectors, type BookGlance } from "../../src/detect/detectors";

/**
 * A vacuum is an EVENT — one side of the near book emptying while the other
 * stands — so it needs a two-sided book to empty from. The false narration
 * this pins: a synthetic book assembling from nothing fills one side first,
 * and the detector used to call that a vacuum half a second in.
 */

const M = 1_000_000;

function glance(bidNear: number, askNear: number): BookGlance {
  const twoSided = bidNear > 0 || askNear > 0;
  return {
    midTick: twoSided ? 11_300_000 : 0,
    spreadTicks: twoSided ? 2 : 0,
    bidDepthNearSats: bidNear,
    askDepthNearSats: askNear,
    lastTradeTick: null,
  };
}

/** Frames at 60Hz over [fromMs, toMs), each showing the same near book.
 * Returns the ids of the vacuum captions said along the way. */
function hold(d: Detectors, fromMs: number, toMs: number, bidNear: number, askNear: number): Set<number> {
  const said = new Set<number>();
  for (let t = fromMs; t < toMs; t += 16) {
    d.glance(glance(bidNear, askNear), t);
    const c = d.currentCaption();
    if (c !== null && c.text.includes("vacuum")) said.add(c.id);
  }
  return said;
}

const vacuumSaid = (d: Detectors) => d.currentCaption()?.text.includes("vacuum") ?? false;

describe("vacuum detector", () => {
  it("stays silent while a book assembles from nothing, one side first", () => {
    const d = new Detectors();
    d.bookReplaced();
    hold(d, 0, 300, 0, 0); // empty
    hold(d, 300, 800, 91.7 * M, 5.3 * M); // the cold-start shape that was narrated
    expect(d.currentCaption()).toBeNull();
    hold(d, 800, 3_000, 91.7 * M, 0.4 * M); // still lopsided, still assembling
    expect(d.currentCaption()).toBeNull();
  });

  it("speaks when a side that stood empties", () => {
    const d = new Detectors();
    d.bookReplaced();
    hold(d, 0, 12_000, 80 * M, 60 * M); // two-sided, established
    expect(d.currentCaption()).toBeNull();
    hold(d, 12_000, 12_100, 80 * M, 2 * M); // the offer side empties
    expect(d.currentCaption()?.text).toBe(
      "the offer side just emptied near the touch — a liquidity vacuum",
    );
  });

  it("needs the baseline to have stood long enough", () => {
    const d = new Detectors();
    d.bookReplaced();
    hold(d, 0, 4_000, 80 * M, 60 * M); // two-sided, but only for 4s
    hold(d, 4_000, 4_100, 80 * M, 2 * M);
    expect(d.currentCaption()).toBeNull();
  });

  it("treats a side swept out entirely as the vacuum it is", () => {
    const d = new Detectors();
    d.bookReplaced();
    hold(d, 0, 12_000, 80 * M, 60 * M);
    // The asks are gone altogether: no touch, so the glance reads 0/0 ...
    hold(d, 12_000, 12_200, 0, 0);
    expect(d.currentCaption()).toBeNull();
    // ... and the first frame a sliver refills is the vacuum.
    hold(d, 12_200, 12_300, 80 * M, 1 * M);
    expect(vacuumSaid(d)).toBe(true);
  });

  it("says a lasting imbalance once, not every cooldown", () => {
    const d = new Detectors();
    d.bookReplaced();
    hold(d, 0, 12_000, 80 * M, 60 * M);
    // Well past the 30s cooldown, the same lopsided book throughout.
    expect(hold(d, 12_000, 80_000, 80 * M, 2 * M).size).toBe(1);
  });

  it("starts over when the book is replaced", () => {
    const d = new Detectors();
    hold(d, 0, 12_000, 80 * M, 60 * M);
    d.bookReplaced(); // a new seed: the old book is no baseline for this one
    hold(d, 12_000, 12_500, 80 * M, 2 * M);
    expect(d.currentCaption()).toBeNull();
  });
});
