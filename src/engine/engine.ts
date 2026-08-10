import { BookSide } from "./book";
import { FLAG_LIQUIDATION, NIL, OrderStore } from "./store";
import {
  EXPECTED_ANOMALIES,
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
 *
 * Commands from the wrong authority throw: the pipeline owns exactly one
 * stream per engine, so a mixed stream is a programming error, not a market
 * condition to absorb.
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

  /** Disagreements that indicate genuine divergence (reconstruction-protocol
   * artifacts excluded) — the number the provenance UI surfaces. */
  unexpectedAnomalyCount(): number {
    let sum = 0;
    for (const [kind, count] of this.anomalies) {
      if (!EXPECTED_ANOMALIES.has(kind)) sum += count;
    }
    return sum;
  }

  apply(cmd: Command): EngineEvent[] {
    const events: EngineEvent[] = [];
    switch (cmd.kind) {
      case "place":
        this.requireAuthority("internal", cmd.kind);
        this.place(cmd, events);
        break;
      case "cancel":
        this.requireAuthority("internal", cmd.kind);
        this.cancel(cmd.id, events);
        break;
      case "replace":
        this.requireAuthority("internal", cmd.kind);
        this.replace(cmd.id, cmd.tick, cmd.sats, events);
        break;
      case "seed":
        this.seed(cmd.orders, events);
        break;
      case "rest":
        this.requireAuthority("external", cmd.kind);
        this.rest(cmd, events);
        break;
      case "reduce":
        this.requireAuthority("external", cmd.kind);
        this.reduce(cmd, events);
        break;
      case "remove":
        this.requireAuthority("external", cmd.kind);
        this.remove(cmd, events);
        break;
    }
    return events;
  }

  private requireAuthority(needed: MatchAuthority, kind: string): void {
    if (this.authority !== needed) {
      throw new Error(`"${kind}" requires ${needed} authority; this engine is ${this.authority}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internal matching path (synthetic mode).
  // -------------------------------------------------------------------------

  private place(cmd: PlaceCmd, events: EngineEvent[]): void {
    if (!isValidSats(cmd.sats)) {
      events.push({ kind: "rejected", id: cmd.id, reason: "bad-quantity", seq: this.seq++ });
      return;
    }
    if (cmd.tick !== null && !isValidTick(cmd.tick)) {
      events.push({ kind: "rejected", id: cmd.id, reason: "bad-price", seq: this.seq++ });
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
        this.enqueueNew(cmd.id, cmd.side, cmd.tick, remaining, 0, 0, events);
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
    // Validate everything BEFORE touching the resting order: a rejected
    // replace must leave the original standing (cancel-replace is atomic).
    if (!isValidSats(sats)) {
      events.push({ kind: "rejected", id, reason: "bad-quantity", seq: this.seq++ });
      return;
    }
    if (!isValidTick(tick)) {
      events.push({ kind: "rejected", id, reason: "bad-price", seq: this.seq++ });
      return;
    }
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
    let seeded = 0;
    for (const o of orders) {
      if (!isValidSats(o.sats) || !isValidTick(o.tick)) {
        this.countAnomaly("invalid-external-value", o.id, events);
        continue;
      }
      if (this.store.slotOf(o.id) !== NIL) {
        // A snapshot listing one id twice is corrupt input; keeping the first
        // occurrence and counting beats stranding an unreachable phantom.
        this.countAnomaly("seed-duplicate-id", o.id, events);
        continue;
      }
      // Seed arrival order is queue order (verified against the venue:
      // group=2 snapshots list same-price orders in ascending-id order).
      const slot = this.store.alloc(o.id, o.side, o.tick, o.sats, this.seq++, o.micro);
      this.sideBook(o.side).enqueue(this.store, slot);
      seeded++;
    }
    if (this.authority === "internal") {
      // The internal matcher guarantees an uncrossed book, so it must not
      // START crossed. The pipeline sanitizes handoff seeds; a crossed seed
      // reaching this point is a bug upstream, and it fails loudly.
      const bid = this.bestBid();
      const ask = this.bestAsk();
      if (bid !== undefined && ask !== undefined && bid >= ask) {
        throw new Error(`internal seed is crossed: bid ${bid} >= ask ${ask}`);
      }
    }
    events.push({ kind: "seeded", count: seeded, seq: this.seq++ });
  }

  private rest(cmd: RestCmd, events: EngineEvent[]): void {
    if (!isValidSats(cmd.sats) || !isValidTick(cmd.tick)) {
      this.countAnomaly("invalid-external-value", cmd.id, events);
      return;
    }
    const existing = this.store.slotOf(cmd.id);
    if (existing !== NIL) {
      this.reconcileKnown(existing, cmd.side, cmd.tick, cmd.sats, events);
      this.countAnomaly("rest-existing-order", cmd.id, events);
      return;
    }
    const flags = cmd.liquidation ? FLAG_LIQUIDATION : 0;
    this.enqueueNew(cmd.id, cmd.side, cmd.tick, cmd.sats, cmd.micro, flags, events);
  }

  private reduce(cmd: ReduceCmd, events: EngineEvent[]): void {
    if (!isValidTick(cmd.tick) || !Number.isSafeInteger(cmd.sats) || cmd.sats < 0) {
      this.countAnomaly("invalid-external-value", cmd.id, events);
      return;
    }
    const slot = this.store.slotOf(cmd.id);
    if (slot === NIL) {
      // An order from before our snapshot that we're only now hearing about:
      // adopt it at the venue's stated remaining rather than erroring.
      this.countAnomaly("reduce-unknown-order", cmd.id, events);
      if (cmd.sats > 0) this.enqueueNew(cmd.id, cmd.side, cmd.tick, cmd.sats, cmd.micro, 0, events);
      return;
    }

    if ((this.store.side[slot] as Side) !== cmd.side || this.store.tick[slot] !== cmd.tick) {
      // The venue moved the order (a price modify is a real Bitstamp
      // order_changed) — and a move is a cancel plus a re-add at the back,
      // never a slide. A side change would be stranger still; both relocate,
      // only the side change counts as an anomaly.
      if ((this.store.side[slot] as Side) !== cmd.side) {
        this.countAnomaly("side-changed", cmd.id, events);
      }
      const liquidation = (this.store.flags[slot] & FLAG_LIQUIDATION) !== 0;
      this.removeResting(slot, events);
      if (cmd.sats > 0) {
        this.enqueueNew(
          cmd.id, cmd.side, cmd.tick, cmd.sats, cmd.micro,
          liquidation ? FLAG_LIQUIDATION : 0, events,
        );
      }
      return;
    }

    const current = this.store.sats[slot];
    const delta = current - cmd.sats;
    if (cmd.tradedSats > 0 && delta > 0) {
      // A fill. The venue's own per-event traded quantity should equal our
      // local delta; when it doesn't, the venue knows something we don't —
      // apply the venue's end state and count the disagreement.
      if (delta !== cmd.tradedSats) this.countAnomaly("traded-mismatch", cmd.id, events);
      this.consumeSlot(slot, delta, opposite(cmd.side), null, events);
      return;
    }
    if (cmd.tradedSats > 0 && delta <= 0) this.countAnomaly("traded-mismatch", cmd.id, events);
    if (cmd.sats === current) return;
    if (cmd.sats === 0) {
      // Resized to nothing without a trade: that is a cancel, and leaving a
      // zero-quantity order enqueued would fake the BBO.
      this.removeResting(slot, events);
      return;
    }
    if (cmd.sats > current) this.countAnomaly("grew-in-place", cmd.id, events);
    events.push({
      kind: "resized", id: cmd.id, side: cmd.side, tick: cmd.tick,
      from: current, to: cmd.sats, seq: this.seq++,
    });
    this.sideBook(cmd.side).resize(this.store, slot, cmd.sats);
  }

  private remove(cmd: RemoveCmd, events: EngineEvent[]): void {
    const slot = this.store.slotOf(cmd.id);
    if (slot === NIL) {
      // Deletion of an order that predates our snapshot: expected, ignored.
      this.countAnomaly("remove-unknown-order", cmd.id, events);
      return;
    }
    if (cmd.tradedSats > 0) {
      // The deletion was a fill consuming the remainder. Our remainder should
      // equal the venue's final traded slice; book what actually left our
      // book, and count any disagreement in magnitude.
      const current = this.store.sats[slot];
      if (Number.isSafeInteger(cmd.tradedSats) && cmd.tradedSats !== current) {
        this.countAnomaly("traded-mismatch", cmd.id, events);
      }
      this.consumeSlot(slot, current, opposite(this.store.side[slot] as Side), null, events);
      return;
    }
    this.removeResting(slot, events);
  }

  /** Snapshot/buffer overlap reconciliation for an id we already hold: adopt
   * the venue's price/side/quantity; a same-price resize keeps queue position
   * (this path is protocol overlap, not a venue modify). */
  private reconcileKnown(
    slot: number, side: Side, tick: PriceTick, sats: Sats, events: EngineEvent[],
  ): void {
    if ((this.store.side[slot] as Side) !== side || this.store.tick[slot] !== tick) {
      const id = this.store.id[slot];
      const micro = this.store.micro[slot];
      const liquidation = (this.store.flags[slot] & FLAG_LIQUIDATION) !== 0;
      this.removeResting(slot, events);
      this.enqueueNew(id, side, tick, sats, micro, liquidation ? FLAG_LIQUIDATION : 0, events);
      return;
    }
    if (this.store.sats[slot] !== sats) {
      this.sideBook(side).resize(this.store, slot, sats);
    }
  }

  // -------------------------------------------------------------------------
  // Shared paths.
  // -------------------------------------------------------------------------

  private enqueueNew(
    id: OrderId, side: Side, tick: PriceTick, sats: Sats, micro: number,
    flags: number, events: EngineEvent[],
  ): void {
    const slot = this.store.alloc(id, side, tick, sats, this.seq, micro, flags);
    this.sideBook(side).enqueue(this.store, slot);
    events.push({ kind: "rested", id, side, tick, sats, seq: this.seq++ });
  }

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
      liquidation: (this.store.flags[slot] & FLAG_LIQUIDATION) !== 0,
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
    let aheadSats = 0;
    for (let p = this.store.prev[slot]; p !== NIL; p = this.store.prev[p]) {
      aheadSats += this.store.sats[p];
    }
    events.push({
      kind: "canceled",
      id: this.store.id[slot],
      side,
      tick: this.store.tick[slot],
      sats: this.store.sats[slot],
      aheadSats,
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

function isValidSats(sats: number): boolean {
  return Number.isSafeInteger(sats) && sats > 0;
}

function isValidTick(tick: number): boolean {
  return Number.isSafeInteger(tick) && tick > 0;
}
