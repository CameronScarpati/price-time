import { afterEach, describe, expect, it, vi } from "vitest";
import { Pipeline, packedRestedAtSec } from "../../src/worker/pipeline";
import { FRAME_BYTES, FRAME_HEADER_FLOATS, FRAME_STRIDE, Header } from "../../src/worker/protocol";

/**
 * The pipeline hands a requested buffer back untouched when the book it was
 * packed from is still the live one. That is only sound because nothing in a
 * packed frame is derived from "now" — and it is only SAFE because every path
 * that can move the book calls invalidateFrame(). These pin both halves: the
 * skip really happens, and it stops happening the instant the market moves.
 *
 * The failure this guards against does not look like a crash. It looks like a
 * correct-seeming book that is a moment behind the market, which is the one
 * thing this project promises never to show.
 */

let pipeline: Pipeline | null = null;
afterEach(() => {
  pipeline?.stop();
  pipeline = null;
  vi.useRealTimers();
});

function started(): Pipeline {
  vi.useFakeTimers();
  const p = new Pipeline();
  p.start("synthetic", 42);
  pipeline = p;
  return p;
}

describe("unchanged-book frame skip", () => {
  it("returns a still-current buffer untouched", () => {
    const p = started();
    const buffer = new ArrayBuffer(FRAME_BYTES);
    p.fillFrame(buffer);
    const first = new Uint8Array(buffer).slice();
    const revision = new Float32Array(buffer)[Header.BookRevision];
    expect(revision).toBeGreaterThan(0); // 0 must always read as stale

    // No time advanced, so no market events: the second request must not
    // rewrite a single byte.
    p.fillFrame(buffer);
    expect(new Uint8Array(buffer)).toEqual(first);
    expect(new Float32Array(buffer)[Header.BookRevision]).toBe(revision);
  });

  it("re-packs a buffer that is behind, and a fresh one always", () => {
    const p = started();
    const held = new ArrayBuffer(FRAME_BYTES);
    p.fillFrame(held);
    const stale = new Uint8Array(held).slice();
    const before = new Float32Array(held)[Header.BookRevision];

    // Let the synthetic market actually quote.
    vi.advanceTimersByTime(2000);
    p.fillFrame(held);
    expect(new Float32Array(held)[Header.BookRevision]).not.toBe(before);
    expect(new Uint8Array(held)).not.toEqual(stale);

    // A zeroed buffer carries revision 0, which no live book ever matches.
    const fresh = new ArrayBuffer(FRAME_BYTES);
    p.fillFrame(fresh);
    expect(new Float32Array(fresh)[Header.InstanceCount]).toBeGreaterThan(0);
    expect(new Float32Array(fresh)[Header.BookRevision]).toBe(
      new Float32Array(held)[Header.BookRevision],
    );
  });

  it("hands the renderer a clock it can subtract restedAtSec from", () => {
    const p = started();
    const buffer = new ArrayBuffer(FRAME_BYTES);
    vi.advanceTimersByTime(3000);
    const meta = p.fillFrame(buffer);
    // Ages are nowSec minus the packed stamp, and must be sane and positive.
    expect(meta.nowSec).toBeGreaterThan(0);
    const f32 = new Float32Array(buffer);
    const count = f32[Header.InstanceCount];
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const age = meta.nowSec - f32[FRAME_HEADER_FLOATS + i * FRAME_STRIDE + 4];
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(3600);
    }
  });
});

describe("seeded orders and the arrival ramp", () => {
  const epoch = 1_000_000;
  const seedAt = epoch + 5_000;
  /** The cell shader's arrival factor (cells.ts) for a packed stamp. */
  const ramp = (packedSec: number, nowSec: number): number =>
    Math.min(Math.max(Math.max(nowSec - packedSec, 0) / 0.12, 0.3), 1);

  it("a seeded order is drawn at full alpha on the seed's own frame", () => {
    // A snapshot stamps every order with the one snapshot time: the seed.
    const packed = packedRestedAtSec(seedAt, epoch, seedAt);
    expect(ramp(packed, (seedAt - epoch) / 1000)).toBe(1);
  });

  it("an order that rests after the seed still fades in, from its true time", () => {
    const at = seedAt + 40;
    const packed = packedRestedAtSec(at, epoch, seedAt);
    expect(packed).toBe((at - epoch) / 1000);
    expect(ramp(packed, (at - epoch) / 1000)).toBe(0.3);
  });

  it("the ancient-order floor still holds for seeded stamps", () => {
    expect(packedRestedAtSec(epoch - 5e9, epoch, seedAt)).toBe(-1_000_000);
  });
});
