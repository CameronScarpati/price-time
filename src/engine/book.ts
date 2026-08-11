import { NIL, OrderStore } from "./store";
import { Side, type PriceTick, type Sats } from "./types";

/**
 * One price level: a FIFO queue of resting orders (head = front of queue =
 * first to fill) plus cached aggregates. The queue itself lives in the
 * OrderStore's prev/next arrays; the level only holds its ends.
 */
export interface Level {
  tick: PriceTick;
  head: number;
  tail: number;
  count: number;
  totalSats: Sats;
}

/**
 * One side of the book: levels keyed by tick, plus a sorted (ascending) array
 * of active ticks for ordered traversal. Binary-search splice is deliberately
 * boring: level creation happens a few hundred times a second at most, on a
 * few thousand elements, where splice cost is unmeasurable.
 */
export class BookSide {
  readonly side: Side;
  readonly ticks: PriceTick[] = [];
  readonly levels = new Map<PriceTick, Level>();

  constructor(side: Side) {
    this.side = side;
  }

  /** Best price: highest tick for bids, lowest for asks. */
  bestTick(): PriceTick | undefined {
    if (this.ticks.length === 0) return undefined;
    return this.side === Side.Bid ? this.ticks[this.ticks.length - 1] : this.ticks[0];
  }

  bestLevel(): Level | undefined {
    const t = this.bestTick();
    return t === undefined ? undefined : this.levels.get(t);
  }

  totalSats(): Sats {
    let sum = 0;
    for (const level of this.levels.values()) sum += level.totalSats;
    return sum;
  }

  /** Index of `tick` in the sorted array, or the insertion point if absent. */
  private searchTick(tick: PriceTick): number {
    let lo = 0;
    let hi = this.ticks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ticks[mid] < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private getOrCreateLevel(tick: PriceTick): Level {
    let level = this.levels.get(tick);
    if (level === undefined) {
      level = { tick, head: NIL, tail: NIL, count: 0, totalSats: 0 };
      this.levels.set(tick, level);
      this.ticks.splice(this.searchTick(tick), 0, tick);
    }
    return level;
  }

  private dropLevelIfEmpty(level: Level): void {
    if (level.count > 0) return;
    this.levels.delete(level.tick);
    const i = this.searchTick(level.tick);
    if (this.ticks[i] === level.tick) this.ticks.splice(i, 1);
  }

  /** Append an already-allocated order slot to the back of its level's queue. */
  enqueue(store: OrderStore, slot: number): void {
    const level = this.getOrCreateLevel(store.tick[slot]);
    store.prev[slot] = level.tail;
    store.next[slot] = NIL;
    if (level.tail === NIL) level.head = slot;
    else store.next[level.tail] = slot;
    level.tail = slot;
    level.count++;
    level.totalSats += store.sats[slot];
  }

  /** Unlink an order slot from its level's queue (any position, O(1)). */
  unlink(store: OrderStore, slot: number): void {
    const level = this.levels.get(store.tick[slot]);
    if (level === undefined) return;
    const p = store.prev[slot];
    const n = store.next[slot];
    if (p === NIL) level.head = n;
    else store.next[p] = n;
    if (n === NIL) level.tail = p;
    else store.prev[n] = p;
    level.count--;
    level.totalSats -= store.sats[slot];
    this.dropLevelIfEmpty(level);
  }

  /** Adjust a resting order's quantity in place (queue position kept). */
  resize(store: OrderStore, slot: number, newSats: Sats): void {
    const level = this.levels.get(store.tick[slot]);
    if (level !== undefined) level.totalSats += newSats - store.sats[slot];
    store.sats[slot] = newSats;
  }
}
