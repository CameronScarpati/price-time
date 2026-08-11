import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { Side, type Command, type EngineEvent } from "../../src/engine/types";

/** Example-based tests of order-type semantics. The generative suite in
 * properties.test.ts covers the state space; these pin the exact meanings. */

let nextId = 1;
function place(
  engine: Engine,
  side: Side,
  tick: number | null,
  sats: number,
  opts: { tif?: "gtc" | "ioc" | "fok"; postOnly?: boolean; id?: number } = {},
): { id: number; events: EngineEvent[] } {
  const id = opts.id ?? nextId++;
  const cmd: Command = {
    kind: "place", id, side, tick, sats,
    tif: opts.tif ?? "gtc",
    ...(opts.postOnly !== undefined ? { postOnly: opts.postOnly } : {}),
  };
  return { id, events: engine.apply(cmd) };
}

function trades(events: EngineEvent[]) {
  return events.filter((e) => e.kind === "trade");
}

describe("limit orders", () => {
  it("rests when it does not cross", () => {
    const engine = new Engine("internal");
    const { events } = place(engine, Side.Bid, 10000, 100);
    expect(events).toEqual([
      { kind: "rested", id: expect.any(Number), side: Side.Bid, tick: 10000, sats: 100, seq: 0 },
    ]);
    expect(engine.bestBid()).toBe(10000);
  });

  it("executes against the far side up to its limit, then rests the remainder", () => {
    const engine = new Engine("internal");
    const a = place(engine, Side.Ask, 10001, 50);
    place(engine, Side.Ask, 10002, 50);
    const { events } = place(engine, Side.Bid, 10001, 120);
    const ts = trades(events);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ makerId: a.id, tick: 10001, sats: 50, aggressor: Side.Bid });
    // 10002 is beyond the buy limit: the remaining 70 rests at 10001.
    expect(events.at(-1)).toMatchObject({ kind: "rested", tick: 10001, sats: 70 });
    expect(engine.bestBid()).toBe(10001);
    expect(engine.bestAsk()).toBe(10002);
  });

  it("walks multiple levels and fills at each maker's price (price improvement)", () => {
    const engine = new Engine("internal");
    place(engine, Side.Ask, 10001, 30);
    place(engine, Side.Ask, 10002, 30);
    place(engine, Side.Ask, 10003, 30);
    const { events } = place(engine, Side.Bid, 10005, 90);
    expect(trades(events).map((t) => t.tick)).toEqual([10001, 10002, 10003]);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it("fills the front of the queue first, in arrival order", () => {
    const engine = new Engine("internal");
    const first = place(engine, Side.Ask, 10001, 40);
    const second = place(engine, Side.Ask, 10001, 40);
    const { events } = place(engine, Side.Bid, 10001, 60);
    const ts = trades(events);
    expect(ts.map((t) => t.makerId)).toEqual([first.id, second.id]);
    expect(ts.map((t) => t.sats)).toEqual([40, 20]);
  });
});

describe("market orders", () => {
  it("takes at any price and never rests", () => {
    const engine = new Engine("internal");
    place(engine, Side.Ask, 10001, 30);
    place(engine, Side.Ask, 20000, 30);
    const { events } = place(engine, Side.Bid, null, 100);
    expect(trades(events).map((t) => t.tick)).toEqual([10001, 20000]);
    expect(events.at(-1)).toMatchObject({ kind: "unfilled", sats: 40 });
    expect(engine.bestBid()).toBeUndefined();
  });
});

describe("IOC and FOK", () => {
  it("IOC takes what it can and leaves nothing on the book", () => {
    const engine = new Engine("internal");
    place(engine, Side.Ask, 10001, 30);
    const { events } = place(engine, Side.Bid, 10001, 100, { tif: "ioc" });
    expect(trades(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "unfilled", sats: 70 });
    expect(engine.bestBid()).toBeUndefined();
  });

  it("FOK executes fully or not at all — and checks reachability within the limit", () => {
    const engine = new Engine("internal");
    place(engine, Side.Ask, 10001, 30);
    place(engine, Side.Ask, 10005, 100);
    // 130 sats exist, but only 30 within the 10001 limit: kill.
    const killed = place(engine, Side.Bid, 10001, 50, { tif: "fok" });
    expect(killed.events).toEqual([
      { kind: "rejected", id: killed.id, reason: "fok-unfillable", seq: expect.any(Number) },
    ]);
    expect(engine.asks.totalSats()).toBe(130);
    const filled = place(engine, Side.Bid, 10005, 130, { tif: "fok" });
    expect(trades(filled.events).reduce((s, t) => s + t.sats, 0)).toBe(130);
  });
});

describe("post-only", () => {
  it("rejects rather than takes", () => {
    const engine = new Engine("internal");
    place(engine, Side.Ask, 10001, 30);
    const rejected = place(engine, Side.Bid, 10001, 30, { postOnly: true });
    expect(rejected.events[0]).toMatchObject({ kind: "rejected", reason: "post-only-cross" });
    const ok = place(engine, Side.Bid, 10000, 30, { postOnly: true });
    expect(ok.events[0]).toMatchObject({ kind: "rested", tick: 10000 });
  });
});

describe("cancel and cancel-replace", () => {
  it("cancel removes the remaining quantity; the id cannot act again", () => {
    const engine = new Engine("internal");
    const { id } = place(engine, Side.Bid, 10000, 100);
    const events = engine.apply({ kind: "cancel", id });
    expect(events[0]).toMatchObject({ kind: "canceled", id, sats: 100 });
    expect(engine.apply({ kind: "cancel", id })[0]).toMatchObject({
      kind: "rejected", reason: "unknown-order",
    });
  });

  it("replace resets queue priority — the real cost of modifying an order", () => {
    const engine = new Engine("internal");
    const first = place(engine, Side.Ask, 10001, 40);
    const second = place(engine, Side.Ask, 10001, 40);
    engine.apply({ kind: "replace", id: first.id, tick: 10001, sats: 50 });
    const { events } = place(engine, Side.Bid, 10001, 40);
    // `second` now fills first: `first` went to the back when it replaced.
    expect(trades(events)[0]).toMatchObject({ makerId: second.id });
  });

  it("a replace that crosses executes like any arrival", () => {
    const engine = new Engine("internal");
    place(engine, Side.Ask, 10002, 40);
    const bid = place(engine, Side.Bid, 10000, 40);
    const events = engine.apply({ kind: "replace", id: bid.id, tick: 10002, sats: 40 });
    expect(trades(events)).toHaveLength(1);
  });

  it("an invalid replace rejects atomically — the resting order survives", () => {
    const engine = new Engine("internal");
    const { id } = place(engine, Side.Bid, 10000, 100);
    const events = engine.apply({ kind: "replace", id, tick: 10000, sats: 0 });
    expect(events).toEqual([
      { kind: "rejected", id, reason: "bad-quantity", seq: expect.any(Number) },
    ]);
    expect(engine.bids.levels.get(10000)!.totalSats).toBe(100);
  });
});

describe("validation and authority", () => {
  it("rejects non-integer or non-positive prices and quantities", () => {
    const engine = new Engine("internal");
    expect(place(engine, Side.Bid, 10000.5, 10).events[0]).toMatchObject({
      kind: "rejected", reason: "bad-price",
    });
    expect(place(engine, Side.Bid, NaN, 10).events[0]).toMatchObject({
      kind: "rejected", reason: "bad-price",
    });
    expect(place(engine, Side.Bid, 10000, 0.5).events[0]).toMatchObject({
      kind: "rejected", reason: "bad-quantity",
    });
  });

  it("absorbs malformed external values without corrupting the book", () => {
    const engine = new Engine("external");
    engine.apply({ kind: "rest", id: 1, side: Side.Bid, tick: NaN, sats: 50, micro: 1 });
    engine.apply({ kind: "rest", id: 2, side: Side.Bid, tick: 10000, sats: NaN, micro: 2 });
    expect(engine.bestBid()).toBeUndefined();
    expect(engine.anomalies.get("invalid-external-value")).toBe(2);
  });

  it("throws on commands from the wrong authority — a mixed stream is a bug, not a market", () => {
    const internal = new Engine("internal");
    expect(() => internal.apply({ kind: "remove", id: 1, tradedSats: 0, micro: 1 })).toThrow();
    const external = new Engine("external");
    expect(() =>
      external.apply({ kind: "place", id: 1, side: Side.Bid, tick: 10000, sats: 10, tif: "gtc" }),
    ).toThrow();
  });

  it("seed skips duplicate ids instead of stranding a phantom", () => {
    const engine = new Engine("external");
    const events = engine.apply({
      kind: "seed",
      orders: [
        { id: 1, side: Side.Bid, tick: 10000, sats: 10, micro: 1 },
        { id: 1, side: Side.Bid, tick: 10000, sats: 20, micro: 1 },
      ],
    });
    expect(events.at(-1)).toMatchObject({ kind: "seeded", count: 1 });
    expect(engine.bids.levels.get(10000)!.count).toBe(1);
    expect(engine.anomalies.get("seed-duplicate-id")).toBe(1);
  });

  it("a crossed seed under internal authority fails loudly — the pipeline must sanitize", () => {
    const engine = new Engine("internal");
    expect(() =>
      engine.apply({
        kind: "seed",
        orders: [
          { id: 1, side: Side.Bid, tick: 10001, sats: 10, micro: 1 },
          { id: 2, side: Side.Ask, tick: 10000, sats: 10, micro: 1 },
        ],
      }),
    ).toThrow(/crossed/);
  });
});

describe("external authority (live mode)", () => {
  it("applies venue fills through the shared consumption path", () => {
    const engine = new Engine("external");
    engine.apply({
      kind: "seed",
      orders: [{ id: 7, side: Side.Bid, tick: 10000, sats: 100, micro: 1 }],
    });
    const events = engine.apply({
      kind: "reduce", id: 7, side: Side.Bid, tick: 10000, sats: 60, tradedSats: 40, micro: 2,
    });
    expect(trades(events)[0]).toMatchObject({
      makerId: 7, sats: 40, makerRemaining: 60, aggressor: Side.Ask, takerId: null,
    });
  });

  it("a deletion with traded quantity is a fill; without, a cancel", () => {
    const engine = new Engine("external");
    engine.apply({
      kind: "seed",
      orders: [
        { id: 1, side: Side.Ask, tick: 10001, sats: 50, micro: 1 },
        { id: 2, side: Side.Ask, tick: 10001, sats: 50, micro: 1 },
      ],
    });
    const filled = engine.apply({ kind: "remove", id: 1, tradedSats: 50, micro: 2 });
    expect(filled[0]).toMatchObject({ kind: "trade", makerId: 1, sats: 50 });
    const canceled = engine.apply({ kind: "remove", id: 2, tradedSats: 0, micro: 3 });
    expect(canceled[0]).toMatchObject({ kind: "canceled", id: 2, sats: 50 });
  });

  it("venue fills against a non-front order are applied and counted, not corrected", () => {
    const engine = new Engine("external");
    engine.apply({
      kind: "seed",
      orders: [
        { id: 1, side: Side.Ask, tick: 10001, sats: 50, micro: 1 },
        { id: 2, side: Side.Ask, tick: 10001, sats: 50, micro: 1 },
      ],
    });
    const events = engine.apply({ kind: "remove", id: 2, tradedSats: 50, micro: 2 });
    expect(events.some((e) => e.kind === "anomaly" && e.anomaly === "consume-not-front")).toBe(true);
    expect(events.some((e) => e.kind === "trade" && e.makerId === 2)).toBe(true);
    expect(engine.anomalies.get("consume-not-front")).toBe(1);
  });

  it("events about orders that predate the snapshot are absorbed, not errors", () => {
    const engine = new Engine("external");
    const removed = engine.apply({ kind: "remove", id: 999, tradedSats: 0, micro: 1 });
    expect(removed[0]).toMatchObject({ kind: "anomaly", anomaly: "remove-unknown-order" });
    // A reduce for an unknown order adopts it at the venue's stated remaining.
    const reduced = engine.apply({
      kind: "reduce", id: 998, side: Side.Bid, tick: 9999, sats: 25, tradedSats: 0, micro: 2,
    });
    expect(reduced.some((e) => e.kind === "rested" && e.sats === 25)).toBe(true);
  });

  it("a venue resize-to-zero is a cancel, never a zero-quantity phantom", () => {
    const engine = new Engine("external");
    engine.apply({ kind: "rest", id: 1, side: Side.Bid, tick: 10000, sats: 50, micro: 1 });
    const events = engine.apply({
      kind: "reduce", id: 1, side: Side.Bid, tick: 10000, sats: 0, tradedSats: 0, micro: 2,
    });
    expect(events[0]).toMatchObject({ kind: "canceled", id: 1, sats: 50 });
    expect(engine.bestBid()).toBeUndefined();
  });

  it("a venue price modify relocates to the back of the new level — cancel plus re-add, never a slide", () => {
    const engine = new Engine("external");
    engine.apply({ kind: "rest", id: 1, side: Side.Bid, tick: 10000, sats: 50, micro: 1 });
    engine.apply({ kind: "rest", id: 2, side: Side.Bid, tick: 10001, sats: 50, micro: 2 });
    const events = engine.apply({
      kind: "reduce", id: 1, side: Side.Bid, tick: 10001, sats: 50, tradedSats: 0, micro: 3,
    });
    expect(events.map((e) => e.kind)).toEqual(["canceled", "rested"]);
    const level = engine.bids.levels.get(10001)!;
    expect(level.count).toBe(2);
    expect(engine.store.id[level.head]).toBe(2); // the mover lost priority
    expect(engine.unexpectedAnomalyCount()).toBe(0); // a price modify is normal
  });

  it("venue traded quantities that disagree with local state are applied and counted", () => {
    const engine = new Engine("external");
    engine.apply({ kind: "rest", id: 1, side: Side.Ask, tick: 10001, sats: 50, micro: 1 });
    const events = engine.apply({ kind: "remove", id: 1, tradedSats: 30, micro: 2 });
    // The order leaves our book with its full local remainder...
    expect(events.some((e) => e.kind === "trade" && e.sats === 50)).toBe(true);
    // ...and the magnitude disagreement is counted, not hidden.
    expect(engine.anomalies.get("traded-mismatch")).toBe(1);
    expect(engine.unexpectedAnomalyCount()).toBe(1);
  });

  it("reconstruction-protocol anomalies stay out of the divergence count", () => {
    const engine = new Engine("external");
    engine.apply({ kind: "remove", id: 999, tradedSats: 0, micro: 1 });
    engine.apply({ kind: "rest", id: 5, side: Side.Bid, tick: 10000, sats: 10, micro: 2 });
    engine.apply({ kind: "rest", id: 5, side: Side.Bid, tick: 10000, sats: 10, micro: 3 });
    expect(engine.anomalies.get("remove-unknown-order")).toBe(1);
    expect(engine.anomalies.get("rest-existing-order")).toBe(1);
    expect(engine.unexpectedAnomalyCount()).toBe(0);
  });

  it("re-applying a rest for a known order is idempotent and keeps queue position", () => {
    const engine = new Engine("external");
    engine.apply({ kind: "rest", id: 1, side: Side.Bid, tick: 10000, sats: 50, micro: 1 });
    engine.apply({ kind: "rest", id: 2, side: Side.Bid, tick: 10000, sats: 50, micro: 2 });
    engine.apply({ kind: "rest", id: 1, side: Side.Bid, tick: 10000, sats: 40, micro: 3 });
    const level = engine.bids.levels.get(10000)!;
    expect(level.count).toBe(2);
    expect(level.totalSats).toBe(90);
    expect(engine.store.id[level.head]).toBe(1); // still front of queue
  });
});
