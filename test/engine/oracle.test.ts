import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { NIL, OrderStore } from "../../src/engine/store";
import { Side } from "../../src/engine/types";
import { Prng } from "../../src/sources/synthetic/prng";

/**
 * Canary tests for the invariant oracle itself. The property suites lean
 * entirely on checkInvariants: if it silently stopped reporting, every one
 * of their ~1,500 generated sequences would still pass while proving
 * nothing. Each test below corrupts a healthy book in a distinct way and
 * asserts the oracle actually says so.
 */

function healthyEngine(): Engine {
  const engine = new Engine("internal");
  engine.apply({ kind: "place", id: 1, side: Side.Bid, tick: 100, sats: 500, tif: "gtc" });
  engine.apply({ kind: "place", id: 2, side: Side.Bid, tick: 100, sats: 300, tif: "gtc" });
  engine.apply({ kind: "place", id: 3, side: Side.Bid, tick: 99, sats: 200, tif: "gtc" });
  engine.apply({ kind: "place", id: 4, side: Side.Ask, tick: 105, sats: 400, tif: "gtc" });
  expect(checkInvariants(engine)).toEqual([]);
  return engine;
}

function slotOf(engine: Engine, id: number): number {
  const slot = engine.store.slotOf(id);
  expect(slot).not.toBe(NIL);
  return slot;
}

describe("checkInvariants canaries", () => {
  it("reports a level total drifting from its queue sum", () => {
    const engine = healthyEngine();
    engine.bids.levels.get(100)!.totalSats += 1;
    expect(checkInvariants(engine).join("; ")).toMatch(/totalSats/);
  });

  it("reports a level count drifting from its queue length", () => {
    const engine = healthyEngine();
    engine.bids.levels.get(100)!.count += 1;
    expect(checkInvariants(engine).join("; ")).toMatch(/count/);
  });

  it("reports a broken prev link", () => {
    const engine = healthyEngine();
    engine.store.prev[slotOf(engine, 2)] = slotOf(engine, 3);
    expect(checkInvariants(engine).join("; ")).toMatch(/prev link/);
  });

  it("reports a queue out of arrival order", () => {
    const engine = healthyEngine();
    const a = slotOf(engine, 1);
    const b = slotOf(engine, 2);
    const swap = engine.store.seq[a];
    engine.store.seq[a] = engine.store.seq[b];
    engine.store.seq[b] = swap;
    expect(checkInvariants(engine).join("; ")).toMatch(/arrival order/);
  });

  it("reports a zero-quantity phantom", () => {
    const engine = healthyEngine();
    engine.store.sats[slotOf(engine, 3)] = 0;
    const report = checkInvariants(engine).join("; ");
    expect(report).toMatch(/rests 0 sats/);
    // The drifted level sum is also caught, independently.
    expect(report).toMatch(/totalSats/);
  });

  it("reports an id-index entry going missing", () => {
    const engine = healthyEngine();
    engine.store.idToSlot.delete(4);
    expect(checkInvariants(engine).join("; ")).toMatch(/id index/);
  });
});

describe("aheadSats", () => {
  // Differential: every cancel's aheadSats must equal a brute walk of the
  // level queue up to the dying order, summed BEFORE the cancel applies.
  // This number feeds the inspector and the cancel-ghost geometry; nothing
  // else asserts it.
  it("equals the brute-force queue walk on 400 seeded random cancels", () => {
    const prng = new Prng(2026);
    const engine = new Engine("internal");
    const live: number[] = [];
    let nextId = 1;
    let cancels = 0;

    for (let step = 0; step < 2000; step++) {
      if (live.length > 0 && prng.chance(0.35)) {
        const id = live.splice(prng.int(0, live.length - 1), 1)[0];
        const slot = engine.store.slotOf(id);
        expect(slot).not.toBe(NIL);
        const side = engine.store.side[slot] as Side;
        const tick = engine.store.tick[slot];
        // Brute walk: sum everything queued ahead of `slot` at its level.
        let brute = 0;
        const level = engine.sideBook(side).levels.get(tick)!;
        for (let s = level.head; s !== slot; s = engine.store.next[s]) {
          brute += engine.store.sats[s];
        }
        const events = engine.apply({ kind: "cancel", id });
        const canceled = events.find((e) => e.kind === "canceled");
        if (canceled?.kind !== "canceled") throw new Error(`order ${id}: no canceled event`);
        expect(canceled.aheadSats).toBe(brute);
        cancels++;
      } else {
        // Rest far from the touch so nothing crosses: bids below 100,
        // asks above 200, several orders per tick so queues get deep.
        const side = prng.chance(0.5) ? Side.Bid : Side.Ask;
        const tick = side === Side.Bid ? prng.int(90, 100) : prng.int(200, 210);
        const id = nextId++;
        engine.apply({ kind: "place", id, side, tick, sats: prng.int(1, 1000), tif: "gtc" });
        live.push(id);
      }
    }
    expect(cancels).toBeGreaterThan(400);
  });
});

describe("OrderStore.grow", () => {
  it("doubles capacity while keeping every pre-growth order intact", () => {
    const store = new OrderStore(4);
    const slots: number[] = [];
    for (let i = 0; i < 4; i++) {
      slots.push(store.alloc(100 + i, i % 2 === 0 ? Side.Bid : Side.Ask, 1000 + i, 50 + i, i, 10 + i));
    }
    expect(store.capacity).toBe(4);

    // The fifth alloc must grow, not clobber.
    const fifth = store.alloc(104, Side.Bid, 1004, 54, 4, 14);
    expect(store.capacity).toBe(8);
    expect(store.size).toBe(5);
    expect(slots).not.toContain(fifth);

    for (let i = 0; i < 4; i++) {
      const slot = slots[i];
      expect(store.id[slot]).toBe(100 + i);
      expect(store.tick[slot]).toBe(1000 + i);
      expect(store.sats[slot]).toBe(50 + i);
      expect(store.seq[slot]).toBe(i);
      expect(store.micro[slot]).toBe(10 + i);
      expect(store.slotOf(100 + i)).toBe(slot);
    }

    // The regrown free list must hand out the remaining fresh slots without
    // ever duplicating a live one, then grow again when exhausted.
    const seen = new Set<number>([...slots, fifth]);
    for (let i = 5; i < 9; i++) {
      const slot = store.alloc(100 + i, Side.Ask, 1000 + i, 50 + i, i, 10 + i);
      expect(seen.has(slot)).toBe(false);
      seen.add(slot);
    }
    expect(store.capacity).toBe(16);
    expect(store.size).toBe(9);

    // Freeing recycles: the next alloc reuses the freed slot.
    const freed = store.slotOf(107);
    store.free(freed);
    expect(store.size).toBe(8);
    expect(store.alloc(999, Side.Bid, 2000, 1, 99, 99)).toBe(freed);
  });
});
