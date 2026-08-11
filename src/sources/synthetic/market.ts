import { Side, opposite, type EngineEvent, type Micro, type OrderId, type PriceTick, type Sats, type SeedOrder } from "../../engine/types";
import type { FlowSource, SourceEvent, SourceSink } from "../source";
import { Prng } from "./prng";

/**
 * The synthetic market (docs/design.md §6): a small agent population driving
 * the engine's internal matcher. It exists so the piece keeps breathing when
 * the live feed cannot — seeded from the last real book, calibrated to the
 * texture live mode measured, always labeled "simulated".
 *
 * Determinism: all randomness flows from one seeded PRNG and all scheduling
 * happens in engine time via generate(untilMicro). The same (seed, calibration,
 * handoff book) always produces the identical event stream; wall-clock only
 * decides how fast the pump asks for it.
 *
 * The agent model is deliberately modest, but each behavior earns its place
 * by producing a real phenomenon: makers re-quoting (spread breathing and the
 * cancel flicker), maker inventory skew (quotes leaning after fills), bursty
 * takers with self-excitation (sweeps and clustered trading), noise quoters
 * with finite lifetimes (queue churn at depth).
 */

export interface SyntheticCalibration {
  /** Combined maker re-quote wakes per second. */
  makerWakesPerSec: number;
  /** Noise order placements per second. */
  noisePerSec: number;
  /** Baseline taker arrivals per second (excitation multiplies this). */
  takersPerSec: number;
  /** Median resting order size, sats. */
  sizeMedianSats: Sats;
  /** Median half-spread quoted by makers, ticks. */
  halfSpreadTicks: number;
  /** Fair-value volatility, ticks per √second. */
  volTicksPerRootSec: number;
}

/** Default synthetic pacing. Deliberately SLOWER than the live message rate:
 * live spreads its ~40 events/s across thousands of mostly-offscreen levels,
 * while the synthetic population quotes almost entirely inside the frame —
 * matching raw rates made the simulation feel frantic where live feels
 * alive. The trance lives at a few visible events per second (the Listen-
 * to-Wikipedia lesson: scarcity plus long decays, not machine-gun pops). */
export const QUIET_BTCUSD: SyntheticCalibration = {
  makerWakesPerSec: 9,
  noisePerSec: 5,
  takersPerSec: 0.22,
  sizeMedianSats: 8_000_000,
  halfSpreadTicks: 2,
  volTicksPerRootSec: 0.7,
};

interface MakerState {
  bidId: OrderId | null;
  askId: OrderId | null;
  /** Signed position, sats. Positive = long = lean quotes down to shed it. */
  inventorySats: number;
}

interface PendingCancel {
  micro: Micro;
  id: OrderId;
}

const MAKER_COUNT = 6;
/** Inventory that shifts a maker's quotes by one tick, sats. */
const INVENTORY_PER_TICK = 50_000_000;

export class SyntheticMarket implements FlowSource {
  readonly kind = "synthetic" as const;

  private readonly prng: Prng;
  private readonly cal: SyntheticCalibration;
  private readonly seedBook: SeedOrder[];
  private sink: SourceSink | null = null;

  /** Engine-time cursor, microseconds. */
  private nowMicro: Micro = 0;
  private nextMakerMicro = 0;
  private nextNoiseMicro = 0;
  private nextTakerMicro = 0;
  /** Taker self-excitation multiplier; decays toward 1, bumps on trades. */
  private excitation = 1;
  private lastExcitationMicro = 0;

  /** Fair value the makers chase, in fractional ticks. */
  private fairTick: number;
  private momentum = 0;

  private nextOrderId: OrderId = 1;
  private readonly makers: MakerState[] = [];
  private readonly pendingCancels: PendingCancel[] = [];
  /** Ids this market owns and believes are resting (pruned via feedback). */
  private readonly resting = new Map<OrderId, { side: Side; tick: PriceTick }>();
  private readonly makerByOrder = new Map<OrderId, { maker: number; side: Side }>();

  constructor(opts: {
    seed: number;
    calibration?: SyntheticCalibration;
    /** Book to continue from (live handoff); empty means assemble from nothing. */
    seedBook?: SeedOrder[];
    startTick?: PriceTick;
    startMicro?: Micro;
  }) {
    this.prng = new Prng(opts.seed);
    this.cal = opts.calibration ?? QUIET_BTCUSD;
    this.seedBook = opts.seedBook ?? [];
    this.nowMicro = opts.startMicro ?? 0;
    this.fairTick = opts.startTick ?? this.midOfSeed() ?? 6_500_000;
    for (let i = 0; i < MAKER_COUNT; i++) {
      this.makers.push({ bidId: null, askId: null, inventorySats: 0 });
    }
  }

  private midOfSeed(): PriceTick | null {
    let bestBid = -Infinity;
    let bestAsk = Infinity;
    for (const o of this.seedBook) {
      if (o.side === Side.Bid) bestBid = Math.max(bestBid, o.tick);
      else bestAsk = Math.min(bestAsk, o.tick);
    }
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
    return Math.round((bestBid + bestAsk) / 2);
  }

  start(sink: SourceSink): void {
    this.sink = sink;
    sink({ type: "command", cmd: { kind: "seed", orders: this.seedBook } });
    for (const o of this.seedBook) this.resting.set(o.id, { side: o.side, tick: o.tick });
    this.scheduleAll();
    sink({ type: "status", status: { phase: "flowing" } });
  }

  stop(): void {
    this.sink = null;
  }

  private scheduleAll(): void {
    this.nextMakerMicro = this.nowMicro + this.prng.exponential(this.cal.makerWakesPerSec) * 1e6;
    this.nextNoiseMicro = this.nowMicro + this.prng.exponential(this.cal.noisePerSec) * 1e6;
    this.nextTakerMicro = this.nowMicro + this.prng.exponential(this.cal.takersPerSec) * 1e6;
    this.lastExcitationMicro = this.nowMicro;
  }

  /**
   * Learn from the engine's events: fills move maker inventories (the input
   * to quote skew) and anything consumed or canceled leaves `resting`.
   */
  feedback(events: readonly EngineEvent[]): void {
    for (const event of events) {
      if (event.kind === "trade") {
        if (event.makerRemaining === 0) this.resting.delete(event.makerId);
        const owner = this.makerByOrder.get(event.makerId);
        if (owner !== undefined) {
          const signed = owner.side === Side.Bid ? event.sats : -event.sats;
          this.makers[owner.maker].inventorySats += signed;
          if (event.makerRemaining === 0) {
            this.makerByOrder.delete(event.makerId);
            const m = this.makers[owner.maker];
            if (m.bidId === event.makerId) m.bidId = null;
            if (m.askId === event.makerId) m.askId = null;
          }
        }
        // Trading excites more trading — the Hawkes flavor behind volume
        // clustering and sweeps arriving in bunches. Kept subcritical: the
        // bump must not sustain the rate it creates, or trading runs away.
        this.excitation = Math.min(this.excitation + 0.8, 6);
      } else if (event.kind === "canceled" || event.kind === "rejected") {
        this.resting.delete(event.id);
        this.makerByOrder.delete(event.id);
      }
    }
  }

  /** Advance engine time to `untilMicro`, emitting everything due. */
  generate(untilMicro: Micro): void {
    const sink = this.sink;
    if (sink === null) return;

    while (true) {
      const nextCancel = this.pendingCancels.length > 0 ? this.pendingCancels[0].micro : Infinity;
      const next = Math.min(this.nextMakerMicro, this.nextNoiseMicro, this.nextTakerMicro, nextCancel);
      if (next > untilMicro) break;
      this.decayExcitation(next);
      this.driftFairValue(next);
      this.nowMicro = next;

      if (next === nextCancel) {
        const cancel = this.pendingCancels.shift()!;
        if (this.resting.has(cancel.id)) {
          sink({ type: "command", cmd: { kind: "cancel", id: cancel.id } });
          this.resting.delete(cancel.id);
        }
      } else if (next === this.nextMakerMicro) {
        this.makerWake(sink);
        this.nextMakerMicro = next + this.prng.exponential(this.cal.makerWakesPerSec) * 1e6;
      } else if (next === this.nextNoiseMicro) {
        this.noiseWake(sink);
        this.nextNoiseMicro = next + this.prng.exponential(this.cal.noisePerSec) * 1e6;
      } else {
        this.takerWake(sink);
        this.nextTakerMicro =
          next + this.prng.exponential(this.cal.takersPerSec * this.excitation) * 1e6;
      }
    }
    this.driftFairValue(untilMicro);
    this.nowMicro = untilMicro;
  }

  private decayExcitation(atMicro: Micro): void {
    const dtSec = (atMicro - this.lastExcitationMicro) / 1e6;
    this.excitation = 1 + (this.excitation - 1) * Math.exp(-dtSec / 8);
    this.lastExcitationMicro = atMicro;
  }

  private driftFairValue(toMicro: Micro): void {
    const dtSec = (toMicro - this.nowMicro) / 1e6;
    if (dtSec <= 0) return;
    const gaussian =
      Math.sqrt(-2 * Math.log(1 - this.prng.next())) * Math.cos(2 * Math.PI * this.prng.next());
    this.fairTick += gaussian * this.cal.volTicksPerRootSec * Math.sqrt(dtSec);
    this.momentum = this.momentum * Math.exp(-dtSec / 20) + gaussian * Math.sqrt(dtSec);
    // Rare news-like repricing: the fair value jumps, stale quotes get run
    // over, takers pile in — the adverse-selection scene, on nature's cue.
    if (this.prng.chance(dtSec * 0.006)) {
      this.fairTick += (this.prng.chance(0.5) ? 1 : -1) * this.prng.int(8, 30);
      this.excitation = Math.min(this.excitation + 3, 6);
    }
  }

  // -------------------------------------------------------------------------
  // Agents.
  // -------------------------------------------------------------------------

  private place(
    sink: SourceSink, side: Side, tick: PriceTick | null, sats: Sats,
    tif: "gtc" | "ioc" | "fok" = "gtc", postOnly = false,
  ): OrderId {
    const id = this.nextOrderId++;
    sink({
      type: "command",
      cmd: { kind: "place", id, side, tick, sats, tif, postOnly },
    });
    if (tif === "gtc" && tick !== null) this.resting.set(id, { side, tick });
    return id;
  }

  private cancel(sink: SourceSink, id: OrderId): void {
    if (!this.resting.has(id)) return;
    sink({ type: "command", cmd: { kind: "cancel", id } });
    this.resting.delete(id);
  }

  /** One maker refreshes one side of its quote toward fair value ± skew. */
  private makerWake(sink: SourceSink): void {
    const makerIdx = this.prng.int(0, MAKER_COUNT - 1);
    const maker = this.makers[makerIdx];
    const side = this.prng.chance(0.5) ? Side.Bid : Side.Ask;
    const skewTicks = -maker.inventorySats / INVENTORY_PER_TICK;
    const half = Math.max(1, Math.round(this.cal.halfSpreadTicks + Math.abs(skewTicks) * 0.2));
    const target =
      side === Side.Bid
        ? Math.floor(this.fairTick + skewTicks - half)
        : Math.ceil(this.fairTick + skewTicks + half);

    const currentId = side === Side.Bid ? maker.bidId : maker.askId;
    if (currentId !== null && this.resting.has(currentId)) {
      const current = this.resting.get(currentId)!;
      if (current.tick === target && this.prng.chance(0.7)) return; // quote still right
      this.cancel(sink, currentId);
      this.makerByOrder.delete(currentId);
    }
    // Post-only, like real makers: a quote that would cross gets rejected
    // and re-tried on a later wake, instead of accidentally taking.
    const id = this.place(sink, side, target, this.prng.size(this.cal.sizeMedianSats, 0.9), "gtc", true);
    this.makerByOrder.set(id, { maker: makerIdx, side });
    if (side === Side.Bid) maker.bidId = id;
    else maker.askId = id;
  }

  /** Noise: rest at depth, die young-ish — the churn that fills real books.
   * Spread across more depth and living longer than real median lifetimes:
   * the simulation's whole population is on screen, so per-level flicker
   * must stay gentle for the field to read as breathing, not boiling. */
  private noiseWake(sink: SourceSink): void {
    const side = this.prng.chance(0.5) ? Side.Bid : Side.Ask;
    const depth = 1 + Math.floor(this.prng.exponential(1 / 16));
    const tick =
      side === Side.Bid
        ? Math.floor(this.fairTick - this.cal.halfSpreadTicks - depth)
        : Math.ceil(this.fairTick + this.cal.halfSpreadTicks + depth);
    const id = this.place(sink, side, tick, this.prng.size(this.cal.sizeMedianSats, 1.2), "gtc", true);
    const lifetimeSec = this.prng.exponential(1 / 11);
    this.schedulePendingCancel({ micro: this.nowMicro + lifetimeSec * 1e6, id });
  }

  private schedulePendingCancel(cancel: PendingCancel): void {
    let i = this.pendingCancels.length;
    while (i > 0 && this.pendingCancels[i - 1].micro > cancel.micro) i--;
    this.pendingCancels.splice(i, 0, cancel);
  }

  /** Takers cross the spread: mostly small IOCs, occasionally a sweep. */
  private takerWake(sink: SourceSink): void {
    const side =
      this.momentum > 0
        ? this.prng.chance(0.65) ? Side.Bid : Side.Ask
        : this.prng.chance(0.65) ? Side.Ask : Side.Bid;
    if (this.prng.chance(0.08)) {
      // A size that walks levels: the sweep-and-replenish phenomenon.
      this.place(sink, side, null, this.prng.size(this.cal.sizeMedianSats * 12, 0.8));
      return;
    }
    const through = this.prng.int(0, 2);
    const tick =
      side === Side.Bid
        ? Math.ceil(this.fairTick + this.cal.halfSpreadTicks + through)
        : Math.floor(this.fairTick - this.cal.halfSpreadTicks - through);
    this.place(sink, side, tick, this.prng.size(this.cal.sizeMedianSats * 0.6, 1), "ioc");
  }
}

/** In synthetic mode the engine's own matches are the prints; this adapter
 * turns a trade event into the same shape the venue's tape would carry. */
export function printFromTrade(
  event: Extract<EngineEvent, { kind: "trade" }>, micro: Micro,
): { tradeId: number; tick: PriceTick; sats: Sats; aggressor: Side; buyOrderId: OrderId; sellOrderId: OrderId; micro: Micro } {
  const takerId = event.takerId ?? 0;
  return {
    tradeId: event.seq,
    tick: event.tick,
    sats: event.sats,
    aggressor: event.aggressor,
    buyOrderId: event.aggressor === Side.Bid ? takerId : event.makerId,
    sellOrderId: event.aggressor === Side.Ask ? takerId : event.makerId,
    micro,
  };
}

/** Aggressor side of a print relative to a maker order — used when joining
 * venue prints to the book (live) or engine trades to the tape (synthetic). */
export function aggressorOfMaker(makerSide: Side): Side {
  return opposite(makerSide);
}
