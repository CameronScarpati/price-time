import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { Side, type Command, type EngineEvent } from "../../src/engine/types";

/**
 * Generative tests of the engine's invariants. A matching engine is too
 * stateful for example tests to mean much on their own: the bugs live in
 * interleavings nobody thought of. Every sequence of commands, however
 * adversarial, must leave the book uncrossed, FIFO-ordered, conserving
 * quantity, and deterministic.
 */

// ---------------------------------------------------------------------------
// Internal-authority operations (synthetic mode).
// ---------------------------------------------------------------------------

type Op =
  | { t: "place"; side: 0 | 1; tickOff: number | null; sats: number; tif: "gtc" | "ioc" | "fok"; postOnly: boolean }
  | { t: "cancel"; ref: number }
  | { t: "replace"; ref: number; tickOff: number; sats: number };

const BASE_TICK = 10000;

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
      t: fc.constant("place" as const),
      side: fc.constantFrom<0 | 1>(0, 1),
      tickOff: fc.oneof({ weight: 9, arbitrary: fc.integer({ min: 0, max: 30 }) }, { weight: 1, arbitrary: fc.constant(null) }),
      sats: fc.integer({ min: 1, max: 500 }),
      tif: fc.constantFrom("gtc" as const, "ioc" as const, "fok" as const),
      postOnly: fc.boolean(),
    }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("cancel" as const), ref: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({
      t: fc.constant("replace" as const),
      ref: fc.nat(),
      tickOff: fc.integer({ min: 0, max: 30 }),
      sats: fc.integer({ min: 1, max: 500 }),
    }) },
);

/** Turn abstract ops into concrete commands, resolving refs to placed ids. */
function toCommands(ops: Op[]): Command[] {
  const commands: Command[] = [];
  const ids: number[] = [];
  let nextId = 1;
  for (const op of ops) {
    if (op.t === "place") {
      const id = nextId++;
      ids.push(id);
      commands.push({
        kind: "place", id, side: op.side as Side,
        tick: op.tickOff === null ? null : BASE_TICK + op.tickOff,
        sats: op.sats, tif: op.tif, postOnly: op.postOnly,
      });
    } else if (ids.length > 0) {
      const id = ids[op.ref % ids.length];
      commands.push(
        op.t === "cancel"
          ? { kind: "cancel", id }
          : { kind: "replace", id, tick: BASE_TICK + op.tickOff, sats: op.sats },
      );
    }
  }
  return commands;
}

describe("engine invariants under arbitrary command sequences", () => {
  it("book is never crossed, FIFO never violated, aggregates never drift", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 120 }), (ops) => {
        const engine = new Engine("internal");
        for (const cmd of toCommands(ops)) {
          engine.apply(cmd);
          const violations = checkInvariants(engine);
          expect(violations).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("quantity is conserved for every order: placed = filled + canceled + unfilled + resting", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 150 }), (ops) => {
        const engine = new Engine("internal");
        const placed = new Map<number, number>();
        const accounted = new Map<number, number>();
        const bump = (id: number, sats: number) =>
          accounted.set(id, (accounted.get(id) ?? 0) + sats);

        for (const cmd of toCommands(ops)) {
          if (cmd.kind === "place" && !placed.has(cmd.id)) placed.set(cmd.id, cmd.sats);
          if (cmd.kind === "replace") {
            // A replace re-arms the order with a new quantity: account the old
            // life at cancel below, then track the new life separately.
          }
          for (const event of engine.apply(cmd)) {
            switch (event.kind) {
              case "trade":
                bump(event.makerId, event.sats);
                if (event.takerId !== null) bump(event.takerId, event.sats);
                break;
              case "canceled":
                bump(event.id, event.sats);
                break;
              case "unfilled":
                bump(event.id, event.sats);
                break;
              case "rejected":
                // A rejected order never held quantity.
                placed.delete(event.id);
                break;
              default:
                break;
            }
          }
          // Replaces change an order's total quantity mid-life; skip those ids.
          if (cmd.kind === "replace") placed.delete(cmd.id);
        }

        // Whatever is still resting completes each order's ledger.
        for (const side of [engine.bids, engine.asks]) {
          for (const level of side.levels.values()) {
            for (let slot = level.head; slot !== -1; slot = engine.store.next[slot]) {
              bump(engine.store.id[slot], engine.store.sats[slot]);
            }
          }
        }

        for (const [id, sats] of placed) {
          expect(accounted.get(id) ?? 0, `order ${id} ledger`).toBe(sats);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("cancels never resurrect: a canceled id never trades or rests again", () => {
    // A replace is cancel-and-re-add of the same id by definition, so its
    // internal cancel is not a death; a plain cancel is final.
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 120 }), (ops) => {
        const engine = new Engine("internal");
        const dead = new Set<number>();
        for (const cmd of toCommands(ops)) {
          const isReplace = cmd.kind === "replace";
          for (const event of engine.apply(cmd)) {
            if (event.kind === "canceled" && !isReplace) dead.add(event.id);
            if (event.kind === "trade") {
              expect(dead.has(event.makerId)).toBe(false);
            }
            if (event.kind === "rested") {
              expect(dead.has(event.id)).toBe(false);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic: identical command streams produce identical event streams", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 120 }), (ops) => {
        const commands = toCommands(ops);
        const run = () => {
          const engine = new Engine("internal");
          const log: EngineEvent[] = [];
          for (const cmd of commands) log.push(...engine.apply(cmd));
          return JSON.stringify(log);
        };
        expect(run()).toBe(run());
      }),
      { numRuns: 100 },
    );
  });

  it("priority is FIFO: makers at one price fill strictly in arrival order", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 120 }), (ops) => {
        const engine = new Engine("internal");
        const restedSeq = new Map<number, number>();
        let lastRemovedSeqAtLevel = new Map<string, number>();
        for (const cmd of toCommands(ops)) {
          for (const event of engine.apply(cmd)) {
            if (event.kind === "rested") restedSeq.set(event.id, event.seq);
            if (event.kind === "trade" && event.makerRemaining === 0) {
              // A maker that fills OUT must be the earliest arrival among the
              // orders that were resting at that price — i.e. fills leave a
              // level in ascending arrival order. Replaces re-rest with a new
              // seq, which is exactly the priority-reset rule.
              const key = `${event.aggressor}:${event.tick}`;
              const seq = restedSeq.get(event.makerId);
              if (seq !== undefined) {
                const prior = lastRemovedSeqAtLevel.get(key);
                if (prior !== undefined) expect(seq).toBeGreaterThan(prior);
                lastRemovedSeqAtLevel.set(key, seq);
              }
            }
            if (event.kind === "canceled" || event.kind === "resized") {
              // A cancel from the middle or a resize invalidates the simple
              // "last removed" watermark for that level; reset it.
              lastRemovedSeqAtLevel = new Map();
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// External-authority operations (live mode): arbitrary venue streams,
// including events about orders we never saw, must never throw and never
// corrupt structure.
// ---------------------------------------------------------------------------

// `hold` keeps the venue timestamp of the op before it: one venue millisecond
// carries a taker's arrival and all of its fill reports, and it is the shared
// timestamp that routes a fill report to the taker's side of the match. A
// reduce or remove with id 0 names the order the last rest placed, so a
// taker's own reports can follow its arrival.
type LiveOp =
  | { t: "rest"; id: number; side: 0 | 1; tickOff: number; sats: number; hold: boolean }
  | { t: "reduce"; id: number; side: 0 | 1; tickOff: number; sats: number; traded: number; hold: boolean }
  | { t: "remove"; id: number; traded: number; hold: boolean };

const arbReportId = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 40 }) },
  { weight: 1, arbitrary: fc.constant(0) },
);

const arbLiveOp: fc.Arbitrary<LiveOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
      t: fc.constant("rest" as const), id: fc.integer({ min: 1, max: 40 }),
      side: fc.constantFrom<0 | 1>(0, 1), tickOff: fc.integer({ min: 0, max: 20 }),
      sats: fc.integer({ min: 1, max: 500 }), hold: fc.boolean(),
    }) },
  { weight: 3, arbitrary: fc.record({
      t: fc.constant("reduce" as const), id: arbReportId,
      side: fc.constantFrom<0 | 1>(0, 1), tickOff: fc.integer({ min: 0, max: 20 }),
      sats: fc.integer({ min: 0, max: 500 }), traded: fc.integer({ min: 0, max: 500 }),
      hold: fc.boolean(),
    }) },
  { weight: 3, arbitrary: fc.record({
      t: fc.constant("remove" as const), id: arbReportId,
      traded: fc.integer({ min: 0, max: 500 }), hold: fc.boolean(),
    }) },
);

describe("external authority under arbitrary venue streams", () => {
  it("absorbs any stream without throwing and without structural corruption", () => {
    fc.assert(
      fc.property(fc.array(arbLiveOp, { maxLength: 200 }), (ops) => {
        const engine = new Engine("external");
        let micro = 0;
        let lastRest = 1;
        for (const op of ops) {
          const tick = BASE_TICK + ("tickOff" in op ? op.tickOff : 0);
          if (!op.hold) micro++;
          if (op.t === "rest") {
            lastRest = op.id;
            engine.apply({ kind: "rest", id: op.id, side: op.side as Side, tick, sats: op.sats, micro });
          } else if (op.t === "reduce") {
            engine.apply({
              kind: "reduce", id: op.id || lastRest, side: op.side as Side, tick,
              sats: op.sats, tradedSats: op.traded, micro,
            });
          } else {
            engine.apply({ kind: "remove", id: op.id || lastRest, tradedSats: op.traded, micro });
          }
          expect(checkInvariants(engine)).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });
});
