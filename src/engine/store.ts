import type { Micro, OrderId, PriceTick, Sats, Seq, Side } from "./types";

/**
 * Pooled order storage: parallel typed arrays indexed by slot, with an
 * intrusive doubly-linked list per price level (prev/next hold slot indices).
 *
 * Two reasons this isn't a Map of objects: the engine's hot path stays
 * allocation-free (slots recycle through a free list threaded through `next`),
 * and the frame packer (worker) reads these arrays directly when building the
 * binary frame the renderer consumes — the store IS the wire format's source.
 *
 * Numeric ranges: ticks fit Int32 (cents up to $21M); ids, sats, seq and micro
 * are integers < 2^53, stored exactly in Float64Array.
 */

export const NIL = -1;

/** Flag bits stored per order. */
export const FLAG_LIQUIDATION = 1;

export class OrderStore {
  capacity: number;
  id!: Float64Array;
  tick!: Int32Array;
  sats!: Float64Array;
  side!: Uint8Array;
  flags!: Uint8Array;
  seq!: Float64Array;
  micro!: Float64Array;
  prev!: Int32Array;
  next!: Int32Array;

  /** Head of the free-slot chain (threaded through `next`). */
  private freeHead = 0;
  /** Number of live (allocated) orders. */
  size = 0;

  readonly idToSlot = new Map<OrderId, number>();

  constructor(capacity = 16384) {
    this.capacity = capacity;
    this.allocateArrays(capacity);
    this.threadFreeList(0);
  }

  private allocateArrays(capacity: number): void {
    this.id = new Float64Array(capacity);
    this.tick = new Int32Array(capacity);
    this.sats = new Float64Array(capacity);
    this.side = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.seq = new Float64Array(capacity);
    this.micro = new Float64Array(capacity);
    this.prev = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
  }

  private threadFreeList(from: number): void {
    for (let i = from; i < this.capacity - 1; i++) this.next[i] = i + 1;
    this.next[this.capacity - 1] = NIL;
    this.freeHead = from;
  }

  private grow(): void {
    const old = {
      id: this.id, tick: this.tick, sats: this.sats, side: this.side,
      flags: this.flags, seq: this.seq, micro: this.micro,
      prev: this.prev, next: this.next,
    };
    const oldCap = this.capacity;
    this.capacity = oldCap * 2;
    this.allocateArrays(this.capacity);
    this.id.set(old.id); this.tick.set(old.tick); this.sats.set(old.sats);
    this.side.set(old.side); this.flags.set(old.flags); this.seq.set(old.seq);
    this.micro.set(old.micro); this.prev.set(old.prev); this.next.set(old.next);
    this.threadFreeList(oldCap);
  }

  alloc(
    id: OrderId, side: Side, tick: PriceTick, sats: Sats, seq: Seq,
    micro: Micro, flags = 0,
  ): number {
    if (this.freeHead === NIL) this.grow();
    const slot = this.freeHead;
    this.freeHead = this.next[slot];
    this.id[slot] = id;
    this.side[slot] = side;
    this.tick[slot] = tick;
    this.sats[slot] = sats;
    this.seq[slot] = seq;
    this.micro[slot] = micro;
    this.flags[slot] = flags;
    this.prev[slot] = NIL;
    this.next[slot] = NIL;
    this.idToSlot.set(id, slot);
    this.size++;
    return slot;
  }

  free(slot: number): void {
    this.idToSlot.delete(this.id[slot]);
    this.next[slot] = this.freeHead;
    this.prev[slot] = NIL;
    this.freeHead = slot;
    this.size--;
  }

  slotOf(id: OrderId): number {
    const slot = this.idToSlot.get(id);
    return slot === undefined ? NIL : slot;
  }

  clear(): void {
    this.idToSlot.clear();
    this.size = 0;
    this.threadFreeList(0);
  }
}
