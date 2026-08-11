import type { BookSide } from "./book";
import type { Engine } from "./engine";
import { NIL } from "./store";
import { Side } from "./types";

/**
 * The invariants that define a correct book. Called after every command in
 * property tests; any violation is a bug in matching logic, full stop.
 *
 * Strictness follows authority (docs/design.md §4): an internally-matched book
 * can never cross — that would mean the matcher left money on the table. An
 * externally-driven book reflects a venue whose hidden state we cannot see,
 * so crossing is possible during reconstruction and is monitored as a
 * divergence signal rather than an invariant violation.
 */
export function checkInvariants(engine: Engine): string[] {
  const violations: string[] = [];
  checkSide(engine, engine.bids, violations);
  checkSide(engine, engine.asks, violations);

  if (engine.authority === "internal") {
    const bid = engine.bestBid();
    const ask = engine.bestAsk();
    if (bid !== undefined && ask !== undefined && bid >= ask) {
      violations.push(`book is crossed: best bid ${bid} >= best ask ${ask}`);
    }
  }

  // Every stored order is on the book exactly once, and vice versa.
  let onBook = 0;
  for (const side of [engine.bids, engine.asks]) {
    for (const level of side.levels.values()) onBook += level.count;
  }
  if (onBook !== engine.store.size) {
    violations.push(`store holds ${engine.store.size} orders but book links ${onBook}`);
  }
  if (engine.store.idToSlot.size !== engine.store.size) {
    violations.push(
      `id index has ${engine.store.idToSlot.size} entries for ${engine.store.size} orders`,
    );
  }
  return violations;
}

function checkSide(engine: Engine, book: BookSide, violations: string[]): void {
  const store = engine.store;
  const label = book.side === Side.Bid ? "bid" : "ask";

  for (let i = 0; i < book.ticks.length; i++) {
    const tick = book.ticks[i];
    if (i > 0 && book.ticks[i - 1] >= tick) {
      violations.push(`${label} ticks not strictly ascending at index ${i}`);
    }
    const level = book.levels.get(tick);
    if (level === undefined) {
      violations.push(`${label} tick ${tick} has no level`);
      continue;
    }

    let count = 0;
    let totalSats = 0;
    let lastSeq = -Infinity;
    let prevSlot = NIL;
    for (let slot = level.head; slot !== NIL; slot = store.next[slot]) {
      if (++count > level.count + 1) {
        violations.push(`${label} level ${tick} queue longer than its count — cycle?`);
        break;
      }
      if (store.prev[slot] !== prevSlot) {
        violations.push(`${label} level ${tick}: broken prev link at slot ${slot}`);
      }
      if (store.tick[slot] !== tick) {
        violations.push(`${label} level ${tick} holds order at tick ${store.tick[slot]}`);
      }
      if (store.side[slot] !== book.side) {
        violations.push(`${label} level ${tick} holds an order from the other side`);
      }
      if (store.sats[slot] <= 0) {
        violations.push(`${label} level ${tick}: order ${store.id[slot]} rests ${store.sats[slot]} sats`);
      }
      // Time priority: queue order is arrival order, front to back, always.
      if (store.seq[slot] <= lastSeq) {
        violations.push(`${label} level ${tick}: queue out of arrival order at slot ${slot}`);
      }
      lastSeq = store.seq[slot];
      totalSats += store.sats[slot];
      prevSlot = slot;
    }
    if (count !== level.count) {
      violations.push(`${label} level ${tick}: count ${level.count} but queue holds ${count}`);
    }
    if (totalSats !== level.totalSats) {
      violations.push(`${label} level ${tick}: totalSats ${level.totalSats} but queue sums ${totalSats}`);
    }
    if (level.tail !== prevSlot) {
      violations.push(`${label} level ${tick}: tail does not reach end of queue`);
    }
  }

  if (book.ticks.length !== book.levels.size) {
    violations.push(`${label}: ${book.ticks.length} ticks but ${book.levels.size} levels`);
  }
}
