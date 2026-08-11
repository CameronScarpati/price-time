import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { BitstampLiveSource } from "../../src/sources/bitstamp/live";
import { BTCUSD } from "../../src/sources/bitstamp/normalize";

/**
 * Diagnostic soak: watch for the book crossing (stale orders surviving on the
 * wrong side of the market). CROSS_WS/CROSS_REST route through the dev relay
 * to isolate relay-induced corruption from source bugs.
 *   CROSS=1 CROSS_SECONDS=90 npx vitest run test/soak/cross-check.test.ts
 */
describe.runIf(process.env.CROSS === "1")("crossed-book diagnostic", () => {
  it("book stays uncrossed (or reseeds itself) against the live venue", {
    timeout: Number(process.env.CROSS_SECONDS ?? 90) * 1000 + 60_000,
  }, async () => {
    const engine = new Engine("external");
    const source = new BitstampLiveSource({
      instrument: BTCUSD,
      ...(process.env.CROSS_WS ? { wsUrl: process.env.CROSS_WS } : {}),
      ...(process.env.CROSS_REST ? { restBase: process.env.CROSS_REST } : {}),
      localTopOfBook: () => {
        const bidTick = engine.bestBid();
        const askTick = engine.bestAsk();
        return bidTick === undefined || askTick === undefined ? null : { bidTick, askTick };
      },
    });
    source.start((event) => {
      if (event.type === "command") engine.apply(event.cmd);
    });

    const seconds = Number(process.env.CROSS_SECONDS ?? 90);
    let worstCross = 0;
    let crossedSamples = 0;
    for (let i = 0; i < seconds; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const bid = engine.bestBid();
      const ask = engine.bestAsk();
      if (bid !== undefined && ask !== undefined && bid >= ask) {
        crossedSamples++;
        worstCross = Math.max(worstCross, bid - ask + 1);
        if (crossedSamples === 1) {
          // Dump the stale top of book once, with ids, for diagnosis.
          const askBook = engine.asks;
          const staleTicks = askBook.ticks.slice(0, 5).map((t) => {
            const level = askBook.levels.get(t)!;
            const ids: number[] = [];
            for (let s = level.head; s !== -1; s = engine.store.next[s]) {
              ids.push(engine.store.id[s]);
            }
            return { tick: t, ids };
          });
          console.log("CROSSED", { bid, ask, staleTicks });
        }
      }
    }
    console.log(JSON.stringify({
      crossedSamples, worstCross,
      stats: { ...source.stats, subtypes: Object.fromEntries(source.stats.subtypes) },
      anomalies: Object.fromEntries(engine.anomalies),
    }));
    source.stop();
    expect(crossedSamples).toBe(0);
  });
});
