import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { Side, type Command, type EngineEvent } from "../../src/engine/types";

/**
 * A pinned digest of the full event stream for a fixed mixed command script.
 * The determinism suite proves run(x) === run(x) within one process; this
 * freezes the stream ACROSS versions, so any change to event content, order,
 * or field values is a conscious decision that re-pins this value.
 *
 * Provenance: the digest is a drift tripwire, not an independently derived
 * truth — the semantics it freezes are pinned case by case in
 * semantics.test.ts, and the digest was first recorded from the suite run on
 * the commit that introduced this file. FNV-1a over the JSON is integer-only
 * (imul + xor), so the digest itself is SPEC-exact given the same JSON text.
 */

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A script that walks every internal-authority path: rests on both sides,
 * partial fills, a sweep across levels, market/IOC/FOK, post-only accept and
 * reject, cancel, cancel-replace (priority reset + crossing replace),
 * duplicate-id and unknown-order rejections. */
const SCRIPT: Command[] = [
  { kind: "place", id: 1, side: Side.Bid, tick: 100, sats: 500, tif: "gtc" },
  { kind: "place", id: 2, side: Side.Bid, tick: 100, sats: 300, tif: "gtc" },
  { kind: "place", id: 3, side: Side.Bid, tick: 99, sats: 800, tif: "gtc" },
  { kind: "place", id: 4, side: Side.Ask, tick: 103, sats: 400, tif: "gtc" },
  { kind: "place", id: 5, side: Side.Ask, tick: 104, sats: 600, tif: "gtc" },
  { kind: "place", id: 6, side: Side.Ask, tick: 103, sats: 250, tif: "gtc" },
  // Partial fill: takes 150 of maker 4's 400.
  { kind: "place", id: 7, side: Side.Bid, tick: 103, sats: 150, tif: "gtc" },
  // Sweep: eats the rest of 4, all of 6, dips into 104, remainder rests.
  { kind: "place", id: 8, side: Side.Bid, tick: 104, sats: 700, tif: "gtc" },
  // Market sell into the bid stack; unfilled remainder evaporates.
  { kind: "place", id: 9, side: Side.Ask, tick: null, sats: 2000, tif: "ioc" },
  // FOK that cannot fill within limit: rejected whole.
  { kind: "place", id: 10, side: Side.Bid, tick: 104, sats: 5000, tif: "fok" },
  // Post-only that would cross: rejected. Then one that rests.
  { kind: "place", id: 11, side: Side.Bid, tick: 104, sats: 100, tif: "gtc", postOnly: true },
  { kind: "place", id: 12, side: Side.Bid, tick: 95, sats: 100, tif: "gtc", postOnly: true },
  { kind: "cancel", id: 3 },
  { kind: "cancel", id: 999 }, // unknown order
  { kind: "place", id: 12, side: Side.Bid, tick: 96, sats: 100, tif: "gtc" }, // duplicate id
  // Replace: loses queue position; a crossing replace executes.
  { kind: "place", id: 13, side: Side.Ask, tick: 105, sats: 300, tif: "gtc" },
  { kind: "replace", id: 13, tick: 104, sats: 300 },
  { kind: "replace", id: 12, tick: 104, sats: 150 },
];

describe("engine event-stream golden digest", () => {
  it("produces the pinned stream digest for the fixed script", () => {
    const engine = new Engine("internal");
    const events: EngineEvent[] = [];
    for (const cmd of SCRIPT) events.push(...engine.apply(cmd));
    const text = JSON.stringify(events);

    // Cheap structural anchors so a digest mismatch has a first diagnostic:
    // 9 rested, 8 trades, 1 unfilled, 5 rejected (fok, post-only cross, two
    // unknown-order cancels — id 3 was consumed by the market sell — and one
    // duplicate id), 2 canceled (the cancel halves of the two replaces).
    expect(events.length).toBe(25);
    expect(fnv1a(text)).toBe("1a763b5d");
  });

  it("is stable across two independent runs in this process", () => {
    const run = () => {
      const engine = new Engine("internal");
      const events: EngineEvent[] = [];
      for (const cmd of SCRIPT) events.push(...engine.apply(cmd));
      return JSON.stringify(events);
    };
    expect(run()).toBe(run());
  });
});
