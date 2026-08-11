import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import type { EngineEvent } from "../../src/engine/types";
import type { SourceEvent } from "../../src/sources/source";
import { SyntheticMarket } from "../../src/sources/synthetic/market";

/** Run a synthetic market for `seconds` of engine time, returning everything
 * it and the engine said. Invariants are checked after every command. */
function run(seed: number, seconds: number) {
  const market = new SyntheticMarket({ seed, startTick: 6_500_000 });
  const engine = new Engine("internal");
  const sourceEvents: SourceEvent[] = [];
  const engineEvents: EngineEvent[] = [];
  market.start((event) => {
    sourceEvents.push(event);
    if (event.type === "command") {
      const out = engine.apply(event.cmd);
      engineEvents.push(...out);
      market.feedback(out);
      const violations = checkInvariants(engine);
      if (violations.length > 0) throw new Error(violations.join("; "));
    }
  });
  const stepMicro = 100_000; // 100ms pump steps, like the worker's cadence
  for (let t = stepMicro; t <= seconds * 1e6; t += stepMicro) market.generate(t);
  return { engine, sourceEvents, engineEvents };
}

describe("synthetic market", () => {
  it("is deterministic: same seed, same everything", () => {
    const a = run(42, 20);
    const b = run(42, 20);
    expect(JSON.stringify(a.sourceEvents)).toBe(JSON.stringify(b.sourceEvents));
    expect(JSON.stringify(a.engineEvents)).toBe(JSON.stringify(b.engineEvents));
  });

  it("different seeds diverge", () => {
    const a = run(1, 5);
    const b = run(2, 5);
    expect(JSON.stringify(a.sourceEvents)).not.toBe(JSON.stringify(b.sourceEvents));
  });

  it("produces a living, sane market with real texture", () => {
    const { engine, engineEvents } = run(7, 60);

    // Alive: a standing two-sided book with a positive, tight-ish spread.
    expect(engine.bestBid()).toBeDefined();
    expect(engine.bestAsk()).toBeDefined();
    const spread = engine.spreadTicks()!;
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(200);

    // Active: arrivals, trades, and the cancel-dominant churn of a real book.
    const trades = engineEvents.filter((e) => e.kind === "trade").length;
    const cancels = engineEvents.filter((e) => e.kind === "canceled").length;
    const rests = engineEvents.filter((e) => e.kind === "rested").length;
    expect(rests).toBeGreaterThan(500);
    expect(trades).toBeGreaterThan(5);
    expect(cancels).toBeGreaterThan(trades); // quotes are mostly withdrawn
  });
});
