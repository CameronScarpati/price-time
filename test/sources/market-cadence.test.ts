import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { Side } from "../../src/engine/types";
import type { SourceEvent } from "../../src/sources/source";
import { QUIET_BTCUSD, SyntheticMarket } from "../../src/sources/synthetic/market";

/**
 * The synthetic market's real determinism contract, pinned. The stream is a
 * pure function of (seed, calibration, handoff book, AND the sequence of
 * generate() cut points): fair-value drift consumes PRNG draws at every
 * generate() call boundary, so two runs that slice time differently draw
 * differently. The worker's pump quantizes its cuts, and the tests fix them
 * outright; this file makes the cut-dependence explicit so nobody upgrades
 * the docstring's claim (or weakens the fixed-cadence guarantee) unawares.
 */

function runWithCuts(seed: number, cuts: number[]): SourceEvent[] {
  const market = new SyntheticMarket({ seed, startTick: 6_500_000 });
  const engine = new Engine("internal");
  const events: SourceEvent[] = [];
  market.start((event) => {
    events.push(event);
    if (event.type === "command") {
      const out = engine.apply(event.cmd);
      market.feedback(out);
      const violations = checkInvariants(engine);
      if (violations.length > 0) throw new Error(violations.join("; "));
    }
  });
  for (const cut of cuts) market.generate(cut);
  return events;
}

function cadence(stepMicro: number, untilMicro: number): number[] {
  const cuts: number[] = [];
  for (let t = stepMicro; t <= untilMicro; t += stepMicro) cuts.push(t);
  return cuts;
}

describe("generate() cut-point contract", () => {
  it("identical cut sequences produce byte-identical streams", () => {
    const a = runWithCuts(42, cadence(100_000, 5_000_000));
    const b = runWithCuts(42, cadence(100_000, 5_000_000));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("different cut sequences legitimately diverge (the documented limit)", () => {
    // 100ms steps versus one 5s step: same seed, same span of engine time.
    // If this assertion ever FAILS as equal, drift draws stopped depending
    // on call cadence — update the market.ts determinism docstring and this
    // file together, in that order.
    const fine = runWithCuts(42, cadence(100_000, 5_000_000));
    const coarse = runWithCuts(42, [5_000_000]);
    expect(JSON.stringify(fine)).not.toBe(JSON.stringify(coarse));
  });

  it("pins the opening of the seed-42 stream at the pump cadence", () => {
    // Golden pin, ENGINE-exact tier: the stream passes through Math.log/cos
    // (exponential and Box-Muller draws), which the ECMAScript spec allows
    // to vary by engine, so this pin is attested on the Node/V8 the suite
    // runs in rather than derived independently. If it shifts on an engine
    // upgrade with no code change, re-verify the draw path deliberately and
    // re-pin; a shift on a code change means the seeded stream moved.
    const events = runWithCuts(42, cadence(100_000, 5_000_000));
    const commands = events.flatMap((e) => (e.type === "command" ? [e.cmd] : []));
    expect(commands.length).toBe(95);
    // A cold start always leads with an empty seed, then the makers quote.
    expect(commands.slice(0, 3)).toEqual([
      { kind: "seed", orders: [] },
      { kind: "place", id: 1, side: Side.Bid, tick: 6_499_998, sats: 7_611_118, tif: "gtc", postOnly: true },
      { kind: "place", id: 2, side: Side.Ask, tick: 6_500_004, sats: 16_209_647, tif: "gtc", postOnly: true },
    ]);
  });
});

describe("QUIET_BTCUSD preset integrity", () => {
  it("stays inside the live-calibration clamp bands", () => {
    // The pipeline clamps live-derived calibration into fixed bands
    // (pipeline.ts calibration()); the preset is the same type fed to the
    // same market. A preset outside those bands would mean cold-start and
    // handoff modes disagree about sane pacing — the config.test.ts lesson:
    // presets bypass the clamps, so their integrity is a test, not a hope.
    expect(QUIET_BTCUSD.makerWakesPerSec).toBeGreaterThanOrEqual(3);
    expect(QUIET_BTCUSD.makerWakesPerSec).toBeLessThanOrEqual(14);
    expect(QUIET_BTCUSD.noisePerSec).toBeGreaterThanOrEqual(2);
    expect(QUIET_BTCUSD.noisePerSec).toBeLessThanOrEqual(8);
    expect(QUIET_BTCUSD.takersPerSec).toBeGreaterThanOrEqual(0.05);
    expect(QUIET_BTCUSD.takersPerSec).toBeLessThanOrEqual(0.6);
    expect(QUIET_BTCUSD.sizeMedianSats).toBeGreaterThanOrEqual(10_000);
    expect(QUIET_BTCUSD.halfSpreadTicks).toBeGreaterThanOrEqual(1);
    expect(QUIET_BTCUSD.volTicksPerRootSec).toBeGreaterThanOrEqual(0.3);
    expect(QUIET_BTCUSD.volTicksPerRootSec).toBeLessThanOrEqual(6);
  });
});
