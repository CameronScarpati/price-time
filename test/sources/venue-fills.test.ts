import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { Side } from "../../src/engine/types";
import { BTCUSD } from "../../src/sources/bitstamp/normalize";
import { parseCapture } from "../../src/sources/replay/format";
import { ReplaySource } from "../../src/sources/replay/player";

/**
 * Bitstamp reports every fill twice on live_orders: once on the maker, and
 * once on the taker, which arrives as order_created at its own limit and so
 * rests for the length of its matching step. The venue prints each fill once
 * on live_trades, at the maker's price. The engine has to print the same set:
 * one trade per venue fill, from the maker's report, at the maker's price,
 * with the taker's side as aggressor.
 *
 * The check is an exact join against the venue's own prints on (maker id,
 * price, size, aggressor), which is stricter than bounding each trade's
 * distance from the touch. A touch bound cannot be the test here: a replayed
 * book carries snapshot orders that no message ever names and the closing
 * snapshot no longer holds, and a replay has no crossed-book guard to remove
 * them, while a taker mid-step rests inside the spread. Either can put the
 * reconstructed touch more than a dollar from where the venue traded while
 * every print is correct.
 */

function load(path: string) {
  return parseCapture(
    gunzipSync(readFileSync(fileURLToPath(new URL(path, import.meta.url)))).toString("utf8"),
  );
}

const captures = [
  { name: "the bundled replay session", path: "../../public/replay/session.jsonl.gz" },
  { name: "the 120s golden capture", path: "../fixtures/btcusd-120s.jsonl.gz" },
];

describe("venue fills through the external engine", () => {
  for (const capture of captures) {
    it(`${capture.name}: prints each venue fill once, from the maker, at its price`, () => {
      const engine = new Engine("external");
      const replay = new ReplaySource(load(capture.path), BTCUSD, Infinity);
      const key = (maker: number, tick: number, sats: number, aggressor: number) =>
        `${maker}:${tick}:${sats}:${aggressor}`;

      // The venue's prints, as a multiset: one maker can fill twice at one
      // price for one size, and each of those is its own print.
      const venue = new Map<string, number>();
      let venuePrints = 0;
      const trades: string[] = [];
      replay.start((event) => {
        if (event.type === "command") {
          for (const e of engine.apply(event.cmd)) {
            if (e.kind === "trade") trades.push(key(e.makerId, e.tick, e.sats, e.aggressor));
          }
        } else if (event.type === "print") {
          const p = event.print;
          const maker = p.aggressor === Side.Bid ? p.sellOrderId : p.buyOrderId;
          const k = key(maker, p.tick, p.sats, p.aggressor);
          venue.set(k, (venue.get(k) ?? 0) + 1);
          venuePrints++;
        }
      });

      // Every engine trade takes one venue print; any left over on either
      // side is a fill printed twice, printed wrong, or not printed at all.
      let unmatched = 0;
      for (const k of trades) {
        const left = venue.get(k) ?? 0;
        if (left > 0) venue.set(k, left - 1);
        else unmatched++;
      }
      let unprinted = 0;
      for (const left of venue.values()) unprinted += left;

      expect(venuePrints).toBeGreaterThan(50);
      expect({ trades: trades.length, unmatched, unprinted }).toEqual({
        trades: venuePrints,
        unmatched: 0,
        unprinted: 0,
      });
    });
  }
});
