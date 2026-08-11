import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { Side } from "../../src/engine/types";
import { isOrderMessage, type RawSnapshot } from "../../src/sources/bitstamp/messages";
import { BTCUSD } from "../../src/sources/bitstamp/normalize";
import { parseDecimal } from "../../src/sources/bitstamp/decimal";
import { parseCapture } from "../../src/sources/replay/format";
import { ReplaySource } from "../../src/sources/replay/player";

/**
 * Golden test: 120 seconds of real captured BTC/USD flow (9,102 messages,
 * 2026-08-08) replayed through the same normalization live mode uses, into
 * the external-authority engine. The closing snapshot recorded at capture
 * end is the venue's own answer key for what the book should look like.
 */

const fixture = parseCapture(
  gunzipSync(
    readFileSync(fileURLToPath(new URL("../fixtures/btcusd-120s.jsonl.gz", import.meta.url))),
  ).toString("utf8"),
);

describe("reconstruction from a real captured session", () => {
  it("the event_id chain is continuous across the entire capture", () => {
    let last: string | null = null;
    let checked = 0;
    for (const record of fixture) {
      if (record.type !== "msg" || !isOrderMessage(record.data)) continue;
      if (last !== null) {
        expect(record.data.pre_event_id).toBe(last);
        checked++;
      }
      last = record.data.event_id;
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("replaying the capture rebuilds the venue's closing book", () => {
    const engine = new Engine("external");
    const replay = new ReplaySource(fixture, BTCUSD, Infinity);
    let commands = 0;
    replay.start((event) => {
      if (event.type === "command") {
        engine.apply(event.cmd);
        // Full invariant sweep every 500 commands keeps the test fast while
        // still catching corruption mid-stream, not just at the end.
        if (++commands % 500 === 0) expect(checkInvariants(engine)).toEqual([]);
      }
    });
    expect(checkInvariants(engine)).toEqual([]);

    const closing = fixture.find((r) => r.type === "closing_snapshot");
    expect(closing).toBeDefined();
    const reference = (closing as { data: RawSnapshot }).data;

    // Top of book within one tick of the venue's own closing snapshot (the
    // stream keeps moving between the last message and the snapshot fetch,
    // so exact equality is not even well-defined).
    const refBid = parseDecimal(reference.bids[0][0], 2);
    const refAsk = parseDecimal(reference.asks[0][0], 2);
    expect(Math.abs(engine.bestBid()! - refBid)).toBeLessThanOrEqual(2);
    expect(Math.abs(engine.bestAsk()! - refAsk)).toBeLessThanOrEqual(2);

    // Queue-level fidelity: the individual order ids near the top of the
    // reconstructed book should almost all appear in the venue's snapshot.
    const referenceIds = new Set<number>();
    for (const [, , id] of [...reference.bids, ...reference.asks]) referenceIds.add(Number(id));
    let matched = 0;
    let total = 0;
    for (const side of [engine.bids, engine.asks]) {
      const ticks = side.side === Side.Bid ? [...side.ticks].reverse() : side.ticks;
      for (const tick of ticks.slice(0, 30)) {
        const level = side.levels.get(tick)!;
        for (let slot = level.head; slot !== -1; slot = engine.store.next[slot]) {
          total++;
          if (referenceIds.has(engine.store.id[slot])) matched++;
        }
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(matched / total).toBeGreaterThan(0.9);

    // The texture finding the design leans on: deletions are overwhelmingly
    // cancels, and fills are rare. If this ratio ever collapses, the feed's
    // semantics changed and the attribution rule needs re-verification.
    const anomalies = [...engine.anomalies.values()].reduce((a, b) => a + b, 0);
    expect(anomalies / commands).toBeLessThan(0.2);
  });
});
