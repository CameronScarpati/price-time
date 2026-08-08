import { BookSide } from "./book";
import { FLAG_LIQUIDATION, NIL, OrderStore } from "./store";
import {
  Side,
  opposite,
  type AnomalyKind,
  type Command,
  type EngineEvent,
  type MatchAuthority,
  type OrderId,
  type PlaceCmd,
  type PriceTick,
  type ReduceCmd,
  type RemoveCmd,
  type RestCmd,
  type Sats,
  type SeedOrder,
  type Seq,
} from "./types";

/**
 * A price-time-priority matching engine as a deterministic state machine:
 * an ordered command stream in, an event stream out, no clocks, no randomness,
 * no I/O. The same commands always produce the same events (tested by hash).
 *
 * Two authorities exist (docs/design.md §2): "internal" matches arrivals
 * itself and enforces strict invariants (the book can never cross); "external"
 * applies a venue's stream as fact — fills and cancels arrive as commands, the
 * matcher is bypassed, and venue assertions that contradict local state are
 * counted as anomalies, never corrected. Both authorities consume queues
 * through the same code path (`consumeSlot`), which is what keeps live mode
 * honest: the engine that renders is the engine that matches.
 */
export class Engine {
  readonly authority: MatchAuthority;
  readonly store = new OrderStore();
  readonly bids = new BookSide(Side.Bid);
  readonly asks = new BookSide(Side.Ask);

  /** Next sequence number; stamps every accepted command's effects. */
  private seq: Seq = 0;
  /** Venue-disagreement counters, by kind (live mode diagnostics). */
  readonly anomalies = new Map<AnomalyKind, number>();

  constructor(authority: MatchAuthority) {
    this.authority = authority;
  }

  sideBook(side: Side): BookSide {
    return side === Side.Bid ? this.bids : this.asks;
  }

  bestBid(): PriceTick | undefined {
    return this.bids.bestTick();
  }

  bestAsk(): PriceTick | undefined {
    return this.asks.bestTick();
  }

  spreadTicks(): number | undefined {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid === undefined || ask === undefined ? undefined : ask - bid;
  }

  apply(cmd: Command): EngineEvent[] {
    const events: EngineEvent[] = [];
    switch (cmd.kind) {
      case "place":
        this.place(cmd, events);
        break;
      case "cancel":
        this.cancel(cmd.id, events);
        break;
      case "replace":
        this.replace(cmd.id, cmd.tick, cmd.sats, events);
        break;
      case "seed":
        this.seed(cmd.orders, events);
        break;
      case "rest":
        this.rest(cmd, events);
        break;
      case "reduce":
        this.reduce(cmd, events);
        break;
      case "remove":
        this.remove(cmd, events);
        break;
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Internal matching path (synthetic mode).
  // -------------------------------------------------------------------------

  private place(cmd: PlaceCmd, events: EngineEvent[]): void {
    if (cmd.sats <= 0 || !Number.isSafeInteger(cmd.sats)) {
      events.push({ kind: "rejected", id: cmd.id, reason: "bad-quantity", seq: this.seq++ });
      return;
    }
    if (this.store.slotOf(cmd.id) !== NIL) {
      events.push({ kind: "rejected", id: cmd.id, reason: "duplicate-id", seq: this.seq++ });
      return;
    }
    if (cmd.postOnly) {
      if (cmd.tick === null) {
        events.push({ kind: "rejected", id: cmd.id, reason: "market-post-only", seq: this.seq++ });
        return;
      }
      if (this.wouldCross(cmd.side, cmd.tick)) {
        events.push({ kind: "rejected", id: cmd.id, reason: "post-only-cross", seq: this.seq++ });
        return;
      }
    }
    if (cmd.tif === "fok" && this.availableWithinLimit(cmd.side, cmd.tick) < cmd.sats) {
      events.push({ kind: "rejected", id: cmd.id, reason: "fok-unfillable", seq: this.seq++ });
      return;
    }

    let remaining = cmd.sats;
    const contra = this.sideBook(opposite(cmd.side));
    while (remaining > 0) {
      const level = contra.bestLevel();
      if (level === undefined) break;
      if (cmd.tick !== null && !crosses(cmd.side, cmd.tick, level.tick)) break;
      const maker = level.head;
      const qty = Math.min(remaining, this.store.sats[maker]);
      this.consumeSlot(maker, qty, cmd.side, cmd.id, events);
      remaining -= qty;
    }

    if (remaining > 0) {
      if (cmd.tick !== null && cmd.tif === "gtc") {
        const slot = this.store.alloc(cmd.id, cmd.side, cmd.tick, remaining, this.seq, 0);
        this.sideBook(cmd.side).enqueue(this.store, slot);
        events.push({
          kind: "rested", id: cmd.id, side: cmd.side, tick: cmd.tick,
          sats: remaining, seq: this.seq++,
        });
      } else {
        // Market and IOC remainders evaporate; the event keeps quantity
        // conservation observable (and shows an aggressor exhausting the book).
        events.push({ kind: "unfilled", id: cmd.id, side: cmd.side, sats: remaining, seq: this.seq++ });
      }
    }
  }

  private cancel(id: OrderId, events: EngineEvent[]): void {
    const slot = this.store.slotOf(id);
    if (slot === NIL) {
      events.push({ kind: "rejected", id, reason: "unknown-order", seq: this.seq++ });
      return;
    }
    this.removeResting(slot, events);
  }

  private replace(id: OrderId, tick: PriceTick, sats: Sats, events: EngineEvent[]): void {
    const slot = this.store.slotOf(id);
    if (slot === NIL) {
      events.push({ kind: "rejected", id, reason: "unknown-order", seq: this.seq++ });
      return;
    }
    const side = this.store.side[slot] as Side;
    this.removeResting(slot, events);
    // Re-enters as a fresh arrival: priority reset is the real venue rule,
    // and a replace that now crosses executes like any arrival would.
    this.place({ kind: "place", id, side, tick, sats, tif: "gtc" }, events);
  }

  private wouldCross(side: Side, tick: PriceTick): boolean {
    const contraBest = this.sideBook(opposite(side)).bestTick();
    return contraBest !== undefined && crosses(side, tick, contraBest);
  }

  /** Total contra-side quantity reachable at or better than `tick` (null = market). */
  private availableWithinLimit(side: Side, tick: PriceTick | null): Sats {
    const contra = this.sideBook(opposite(side));
    let sum = 0;
    if (side === Side.Bid) {
      for (const t of contra.ticks) {
        if (tick !== null && t > tick) break;
        sum += contra.levels.get(t)!.totalSats;
      }
    } else {
      for (let i = contra.ticks.length - 1; i >= 0; i--) {
        const t = contra.ticks[i];
        if (tick !== null && t < tick) break;
        sum += contra.levels.get(t)!.totalSats;
      }
    }
    return sum;
  }

  // -------------------------------------------------------------------------
  // External authority path (live / replay).
  // -------------------------------------------------------------------------

  private seed(orders: SeedOrder[], events: EngineEvent[]): void {
    this.store.clear();
    this.bids.ticks.length = 0;
    this.bids.levels.clear();
    this.asks.ticks.length = 0;
    this.asks.levels.clear();
    for (const o of orders) {
      // Seed arrival order is queue order (verified against the venue:
      // group=2 snapshots list same-price orders in ascending-id order).
      const slot = this.store.alloc(o.id, o.side, o.tick, o.sats, this.seq++, o.micro);
      this.sideBook(o.side).enqueue(this.store, slot);
    }
    events.push({ kind: "seeded", count: orders.length, seq: this.seq++ });
  }

  private rest(cmd: RestCmd, events: EngineEvent[]): void {
    const existing = this.store.slotOf(cmd.id);
    if (existing !== NIL) {
      // Idempotent re-apply (snapshot/buffer overlap): adopt the venue's
      // quantity, keep the queue position we already have.
      if (this.store.sats[existing] !== cmd.sats) {
        this.sideBook(this.store.side[existing] as Side).resize(this.store, existing, cmd.sats);
      }
      this.countAnomaly("rest-existing-order", cmd.id, events);
      return;
    }
    const flags = cmd.liquidation ? FLAG_LIQUIDATION : 0;
    const slot = this.store.alloc(cmd.id, cmd.side, cmd.tick, cmd.sats, this.seq, cmd.micro, flags);
    this.sideBook(cmd.side).enqueue(this.store, slot);
    events.push({
      kind: "rested", id: cmd.id, side: cmd.side, tick: cmd.tick, sats: cmd.sats, seq: this.seq++,
    });
  }

  private reduce(cmd: ReduceCmd, events: EngineEvent[]): void {
    const slot = this.store.slotOf(cmd.id);
    if (slot === NIL) {
      // An order from before our snapshot that we're only now hearing about:
      // adopt it at the venue's stated remaining rather than erroring.
      this.countAnomaly("reduce-unknown-order", cmd.id, events);
      if (cmd.sats > 0) {
        this.rest({
          kind: "rest", id: cmd.id, side: cmd.side, tick: cmd.tick,
          sats: cmd.sats, micro: cmd.micro,
        }, events);
      }
      return;
    }
    const current = this.store.sats[slot];
    if (cmd.tradedSats > 0 && cmd.sats < current) {
      this.consumeSlot(slot, current - cmd.sats, opposite(this.store.side[slot] as Side), null, events);
      return;
    }
    if (cmd.sats > current) this.countAnomaly("grew-in-place", cmd.id, events);
    if (cmd.sats !== current) {
      events.push({
        kind: "resized", id: cmd.id, side: this.store.side[slot] as Side,
        tick: this.store.tick[slot], from: current, to: cmd.sats, seq: this.seq++,
      });
      this.sideBook(this.store.side[slot] as Side).resize(this.store, slot, cmd.sats);
    }
  }

  private remove(cmd: RemoveCmd, events: EngineEvent[]): void {
    const slot = this.store.slotOf(cmd.id);
    if (slot === NIL) {
      // Deletion of an order that predates our snapshot: expected, ignored.
      this.countAnomaly("remove-unknown-order", cmd.id, events);
      return;
    }
    if (cmd.tradedSats > 0) {
      // The deletion was a fill consuming the remainder.
      this.consumeSlot(slot, this.store.sats[slot], opposite(this.store.side[slot] as Side), null, events);
      return;
    }
    this.removeResting(slot, events);
  }

  // -------------------------------------------------------------------------
  // Shared paths.
  // -------------------------------------------------------------------------

  /**
   * The one queue-consumption path (docs/design.md §2): every fill — matched
   * internally or asserted by the venue — reduces a resting maker through
   * here. In external mode a fill against a non-front order is applied (the
   * venue knows about hidden liquidity and sequencing we cannot see) and the
   * disagreement is counted.
   */
  private consumeSlot(
    slot: number, qty: Sats, aggressor: Side, takerId: OrderId | null,
    events: EngineEvent[],
  ): void {
    const side = this.store.side[slot] as Side;
    const book = this.sideBook(side);
    const level = book.levels.get(this.store.tick[slot]);
    if (level !== undefined && level.head !== slot) {
      this.countAnomaly("consume-not-front", this.store.id[slot], events);
    }
    const remaining = this.store.sats[slot] - qty;
    events.push({
      kind: "trade",
      makerId: this.store.id[slot],
      takerId,
      aggressor,
      tick: this.store.tick[slot],
      sats: qty,
      makerRemaining: remaining,
      seq: this.seq++,
    });
    if (remaining > 0) {
      book.resize(this.store, slot, remaining);
    } else {
      book.unlink(this.store, slot);
      this.store.free(slot);
    }
  }

  private removeResting(slot: number, events: EngineEvent[]): void {
    const side = this.store.side[slot] as Side;
    events.push({
      kind: "canceled",
      id: this.store.id[slot],
      side,
      tick: this.store.tick[slot],
      sats: this.store.sats[slot],
      seq: this.seq++,
    });
    this.sideBook(side).unlink(this.store, slot);
    this.store.free(slot);
  }

  private countAnomaly(anomaly: AnomalyKind, id: OrderId, events: EngineEvent[]): void {
    this.anomalies.set(anomaly, (this.anomalies.get(anomaly) ?? 0) + 1);
    events.push({ kind: "anomaly", anomaly, id, seq: this.seq++ });
  }
}

/** Does an order at `tick` on `side` cross a contra order at `contraTick`? */
export function crosses(side: Side, tick: PriceTick, contraTick: PriceTick): boolean {
  return side === Side.Bid ? tick >= contraTick : tick <= contraTick;
}
