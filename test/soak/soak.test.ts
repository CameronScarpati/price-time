import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { parseDecimal } from "../../src/sources/bitstamp/decimal";
import { BitstampLiveSource } from "../../src/sources/bitstamp/live";
import { BTCUSD } from "../../src/sources/bitstamp/normalize";

/**
 * The live soak benchmark from docs/brief.md's recommendations: run the real
 * reconstruction against the venue and verify the rebuilt top-of-book tracks
 * the venue's own REST book within one tick, continuously.
 *
 * Not part of the normal suite (it needs the network and real time):
 *   SOAK=1 SOAK_MINUTES=60 npx vitest run test/soak/soak.test.ts
 * Results are written to docs/perf/ and quoted in the README.
 */

const minutes = Number(process.env.SOAK_MINUTES ?? 5);

describe.runIf(process.env.SOAK === "1")("live reconstruction soak", () => {
  it(
    `tracks the venue's top of book for ${minutes} minutes`,
    { timeout: minutes * 60_000 + 120_000 },
    async () => {
      const engine = new Engine("external");
      const source = new BitstampLiveSource({
        instrument: BTCUSD,
        localTopOfBook: () => {
          const bidTick = engine.bestBid();
          const askTick = engine.bestAsk();
          return bidTick === undefined || askTick === undefined ? null : { bidTick, askTick };
        },
      });

      let commands = 0;
      let flowingAt: number | null = null;
      source.start((event) => {
        if (event.type === "command") {
          engine.apply(event.cmd);
          commands++;
        } else if (event.type === "status" && event.status.phase === "flowing") {
          flowingAt ??= Date.now();
        }
      });

      interface Sample {
        atSec: number;
        localBid: number;
        localAsk: number;
        refBid: number;
        refAsk: number;
        bidDiff: number;
        askDiff: number;
        withinOneTick: boolean;
      }
      const samples: Sample[] = [];
      const t0 = Date.now();
      const endAt = t0 + minutes * 60_000;

      while (Date.now() < endAt) {
        await new Promise((r) => setTimeout(r, 10_000));
        try {
          const res = await fetch("https://www.bitstamp.net/api/v2/order_book/btcusd/?group=1", {
            cache: "no-store",
          });
          const book = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
          const refBid = parseDecimal(book.bids[0][0], 2);
          const refAsk = parseDecimal(book.asks[0][0], 2);
          const localBid = engine.bestBid() ?? 0;
          const localAsk = engine.bestAsk() ?? 0;
          const bidDiff = Math.abs(localBid - refBid);
          const askDiff = Math.abs(localAsk - refAsk);
          samples.push({
            atSec: Math.round((Date.now() - t0) / 1000),
            localBid, localAsk, refBid, refAsk, bidDiff, askDiff,
            withinOneTick: bidDiff <= 1 && askDiff <= 1,
          });
        } catch {
          // A failed reference fetch says nothing about the reconstruction.
        }
      }
      source.stop();

      const within = samples.filter((s) => s.withinOneTick).length;
      const report = {
        ranAt: new Date(t0).toISOString(),
        minutes,
        commandsApplied: commands,
        samples: samples.length,
        samplesWithinOneTick: within,
        matchRatio: within / Math.max(samples.length, 1),
        maxBidDiffTicks: Math.max(0, ...samples.map((s) => s.bidDiff)),
        maxAskDiffTicks: Math.max(0, ...samples.map((s) => s.askDiff)),
        stats: {
          messages: source.stats.messages,
          trades: source.stats.trades,
          gaps: source.stats.gaps,
          reseeds: source.stats.reseeds,
          reconnects: source.stats.reconnects,
          divergenceReseeds: source.stats.divergenceReseeds,
          subtypes: Object.fromEntries(source.stats.subtypes),
        },
        anomalies: Object.fromEntries(engine.anomalies),
        invariantViolations: checkInvariants(engine),
        detail: samples,
      };
      mkdirSync("docs/perf", { recursive: true });
      writeFileSync(
        `docs/perf/soak-${new Date(t0).toISOString().slice(0, 16).replace(":", "")}.json`,
        JSON.stringify(report, null, 2),
      );

      expect(report.invariantViolations).toEqual([]);
      expect(samples.length).toBeGreaterThan((minutes * 60) / 10 - 5);
      // The 10s sampling races a moving market, so demand "almost always
      // within one tick" rather than always; sustained divergence would tank
      // this ratio (and trigger the source's own divergence reseed).
      expect(report.matchRatio).toBeGreaterThan(0.85);
    },
  );
});
