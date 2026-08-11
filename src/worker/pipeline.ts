import { Engine } from "../engine/engine";
import { NIL } from "../engine/store";
import { Side, type EngineEvent, type SeedOrder } from "../engine/types";
import { Detectors, type BookGlance } from "../detect/detectors";
import { BitstampLiveSource } from "../sources/bitstamp/live";
import { BTCUSD } from "../sources/bitstamp/normalize";
import { loadCapture } from "../sources/replay/format";
import { ReplaySource } from "../sources/replay/player";
import { QUIET_BTCUSD, SyntheticMarket, type SyntheticCalibration } from "../sources/synthetic/market";
import type { FlowSource, SourceEvent, SourceKind } from "../sources/source";
import { packFrame } from "./packer";
import type { ClockInfo, FrameMeta, InspectionResult, RenderEvent, TapeRow } from "./protocol";

const MAX_CANCEL_EVENTS_PER_FRAME = 60;
const TAPE_LENGTH = 24;
const CATCH_UP_SPEED = 8;
/** How long live may stay non-flowing before the synthetic understudy steps in. */
const LIVE_GRACE_MS = 2_500;

/**
 * The worker's core: one engine, one active source, one truth (docs/design.md
 * §2 and §10). The pipeline folds source events into the engine, collects
 * render events and detector output, manages the degradation ladder
 * (live → synthetic seeded from the last good book), and owns the playback
 * clock that makes pause honest (live events buffer, then catch up, labeled).
 */
export class Pipeline {
  private engine = new Engine("external");
  private mode: SourceKind = "live";
  private live: BitstampLiveSource | null = null;
  private synthetic: SyntheticMarket | null = null;
  private replay: ReplaySource | null = null;
  private configMode: "auto" | SourceKind = "auto";
  private seed = 1;
  private wsUrl: string | undefined;
  private restBase: string | undefined;

  private readonly detectors = new Detectors();

  private renderEvents: RenderEvent[] = [];
  private droppedCancels = 0;
  private tape: TapeRow[] = [];
  private transition: { from: SourceKind; to: SourceKind } | null = null;
  private degraded = true;

  /** Wall time each order rested locally, for age display. Keyed by slot via
   * the store's arrays would be stale across engines; id keying survives. */
  private restedAtMs = new Map<number, number>();

  private paused = false;
  private pauseQueue: { event: SourceEvent; atMs: number }[] = [];
  private catchUpCursorMs = 0;

  /** Synthetic engine-time cursor (µs) and its wall anchor. */
  private synthCursorMicro = 0;
  private lastPumpMs = 0;

  private liveFlowing = false;
  private liveDownSinceMs: number | null = null;
  private hidden = false;
  private syntheticSeededFromLive = false;
  private crossedSinceMs: number | null = null;

  // Live-texture calibration for the synthetic understudy.
  private createTimes: number[] = [];
  private cancelTimes: number[] = [];
  private tradeTimes: number[] = [];
  private sizeSamples: number[] = [];
  private spreadEma = 2;
  private lastMid = 0;
  private volEma = 1.2;
  private lastVolSampleMs = 0;

  private msgCount = 0;
  private msgWindow: number[] = [];

  private pumpTimer: ReturnType<typeof setInterval> | null = null;

  start(
    configMode: "auto" | SourceKind, seed: number, replayUrl?: string,
    wsUrl?: string, restBase?: string,
  ): void {
    this.configMode = configMode;
    this.seed = seed;
    this.wsUrl = wsUrl;
    this.restBase = restBase;
    this.lastPumpMs = Date.now();
    this.pumpTimer = setInterval(() => this.pump(), 33);

    if (configMode === "replay" && replayUrl !== undefined) {
      void this.startReplay(replayUrl);
      return;
    }
    if (configMode === "synthetic") {
      this.startSynthetic([]);
      return;
    }
    this.startLive();
  }

  stop(): void {
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer);
    this.live?.stop();
    this.synthetic?.stop();
    this.replay?.stop();
  }

  // -------------------------------------------------------------------------
  // Sources and the degradation ladder.
  // -------------------------------------------------------------------------

  private startLive(): void {
    this.mode = "live";
    this.engine = new Engine("external");
    this.live = new BitstampLiveSource({
      instrument: BTCUSD,
      ...(this.wsUrl !== undefined ? { wsUrl: this.wsUrl } : {}),
      ...(this.restBase !== undefined ? { restBase: this.restBase } : {}),
      localTopOfBook: () => {
        const bidTick = this.engine.bestBid();
        const askTick = this.engine.bestAsk();
        return bidTick === undefined || askTick === undefined ? null : { bidTick, askTick };
      },
    });
    this.liveDownSinceMs = Date.now();
    this.live.start((event) => this.onSourceEvent("live", event));
  }

  private startSynthetic(seedBook: SeedOrder[]): void {
    const from = this.mode;
    this.mode = "synthetic";
    this.syntheticSeededFromLive = seedBook.length > 0;
    this.engine = new Engine("internal");
    this.restedAtMs.clear();
    const startMicro = Date.now() * 1000;
    this.synthCursorMicro = startMicro;
    this.synthetic = new SyntheticMarket({
      seed: this.seed,
      calibration: this.calibration(),
      seedBook: sanitizeSeed(seedBook),
      startMicro,
    });
    this.synthetic.start((event) => this.onSourceEvent("synthetic", event));
    this.degraded = false;
    if (from !== "synthetic") this.transition = { from, to: "synthetic" };
  }

  private async startReplay(url: string): Promise<void> {
    try {
      const records = await loadCapture(url);
      this.mode = "replay";
      this.engine = new Engine("external");
      this.restedAtMs.clear();
      this.replay = new ReplaySource(records, BTCUSD);
      this.replay.start((event) => this.onSourceEvent("replay", event));
    } catch {
      // No capture reachable: the understudy carries the piece alone.
      this.startSynthetic([]);
    }
  }

  private onSourceEvent(from: SourceKind, event: SourceEvent): void {
    if (from !== this.mode) {
      // A stale source still winding down after a mode switch.
      return;
    }
    if (event.type === "status") {
      this.onStatus(from, event);
      return;
    }
    if (this.paused || this.pauseQueue.length > 0) {
      this.pauseQueue.push({ event, atMs: Date.now() });
      return;
    }
    this.applyEvent(event);
  }

  private onStatus(from: SourceKind, event: Extract<SourceEvent, { type: "status" }>): void {
    const phase = event.status.phase;
    if (from === "live") {
      if (phase === "flowing") {
        this.liveFlowing = true;
        this.liveDownSinceMs = null;
        this.degraded = false;
      } else {
        this.liveFlowing = false;
        this.liveDownSinceMs ??= Date.now();
        this.degraded = true;
      }
    }
    if (from === "replay" && phase === "down") {
      // The capture ended. Loop nothing: hand off to the understudy seeded
      // from the capture's final state, labeled as the simulation it is.
      this.replay?.stop();
      this.replay = null;
      this.startSynthetic(this.exportBook());
    }
    if (from === "replay" && phase === "flowing") this.degraded = false;
  }

  private applyEvent(event: SourceEvent): void {
    if (event.type === "command") {
      const events = this.engine.apply(event.cmd);
      this.afterEngineEvents(events);
      if (this.mode === "synthetic") this.synthetic?.feedback(events);
      if (event.cmd.kind === "seed") {
        // A fresh book: ages restart from what the venue reported.
        this.restedAtMs.clear();
        const nowMs = Date.now();
        for (const o of event.cmd.orders) {
          this.restedAtMs.set(o.id, Math.min(o.micro / 1000, nowMs));
        }
      }
    }
    // Trade prints (live_trades) cross-check the order stream and are not a
    // second visual truth; state and animation both flow from the engine.
  }

  private afterEngineEvents(events: EngineEvent[]): void {
    const nowMs = Date.now();
    for (const event of events) {
      switch (event.kind) {
        case "rested":
          this.restedAtMs.set(event.id, nowMs);
          this.createTimes.push(nowMs);
          this.sizeSamples.push(event.sats);
          if (this.sizeSamples.length > 256) this.sizeSamples.shift();
          break;
        case "trade": {
          this.renderEvents.push({
            kind: "trade", tick: event.tick, sats: event.sats,
            aggressor: event.aggressor, liquidation: event.liquidation,
          });
          this.tape.push({ tick: event.tick, sats: event.sats, aggressor: event.aggressor, atMs: nowMs });
          if (this.tape.length > TAPE_LENGTH) this.tape.shift();
          this.tradeTimes.push(nowMs);
          if (event.makerRemaining === 0) this.restedAtMs.delete(event.makerId);
          break;
        }
        case "canceled": {
          let kept = 0;
          for (const e of this.renderEvents) if (e.kind === "cancel") kept++;
          if (kept < MAX_CANCEL_EVENTS_PER_FRAME) {
            this.renderEvents.push({
              kind: "cancel", tick: event.tick, side: event.side,
              sats: event.sats, aheadSats: event.aheadSats,
            });
          } else {
            this.droppedCancels++;
          }
          this.cancelTimes.push(nowMs);
          this.restedAtMs.delete(event.id);
          break;
        }
        default:
          break;
      }
      this.msgCount++;
    }
    this.msgWindow.push(nowMs);
    this.detectors.observe(events, nowMs);
  }

  // -------------------------------------------------------------------------
  // The pump: synthetic time, catch-up drain, mode watchdog.
  // -------------------------------------------------------------------------

  private pump(): void {
    const nowMs = Date.now();
    const dtMs = Math.min(nowMs - this.lastPumpMs, 250);
    this.lastPumpMs = nowMs;
    if (this.hidden) return;

    // A real venue book cannot REST crossed — crossings resolve in
    // milliseconds inside the matching engine. Our external book crossing
    // for seconds means the reconstruction is wrong (a phantom order
    // survived somewhere), and wrong books are discarded, never patched.
    // This heals in ~8s what the 30s-cadence divergence guard would take up
    // to a minute to catch.
    if (this.mode === "live") {
      const bid = this.engine.bestBid();
      const ask = this.engine.bestAsk();
      if (bid !== undefined && ask !== undefined && bid >= ask) {
        this.crossedSinceMs ??= nowMs;
        if (nowMs - this.crossedSinceMs > 8_000) {
          this.crossedSinceMs = null;
          this.live?.reseed("divergence");
        }
      } else {
        this.crossedSinceMs = null;
      }
    }

    if (this.mode === "synthetic" && !this.paused && this.synthetic !== null) {
      this.synthCursorMicro += dtMs * 1000;
      this.synthetic.generate(this.synthCursorMicro);
    }

    // Catch-up: drain the pause buffer at a labeled multiple of real time.
    if (!this.paused && this.pauseQueue.length > 0) {
      this.catchUpCursorMs += dtMs * CATCH_UP_SPEED;
      while (this.pauseQueue.length > 0 && this.pauseQueue[0].atMs <= this.catchUpCursorMs) {
        this.applyEvent(this.pauseQueue.shift()!.event);
      }
    }

    // Watchdog: live has been away too long — the understudy steps in,
    // continuing from the last good book so nothing on screen jumps.
    if (
      this.configMode === "auto" && this.mode === "live" &&
      this.liveDownSinceMs !== null && nowMs - this.liveDownSinceMs > LIVE_GRACE_MS
    ) {
      const book = this.exportBook();
      this.live?.stop();
      this.live = null;
      this.startSynthetic(book);
      this.retryLiveSoon();
    }

    this.updateVol(nowMs);
  }

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryLiveSoon(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.configMode !== "auto" || this.mode !== "synthetic") return;
      // Probe quietly: a fresh live source; the moment it flows, hand back.
      const probe = new BitstampLiveSource({
        instrument: BTCUSD,
        ...(this.wsUrl !== undefined ? { wsUrl: this.wsUrl } : {}),
        ...(this.restBase !== undefined ? { restBase: this.restBase } : {}),
      });
      const probeEvents: SourceEvent[] = [];
      probe.start((event) => {
        probeEvents.push(event);
        if (event.type === "status" && event.status.phase === "flowing") {
          // Hand the stage back to the real market.
          this.synthetic?.stop();
          this.synthetic = null;
          probe.stop();
          this.transition = { from: "synthetic", to: "live" };
          this.startLive();
        }
        if (event.type === "status" && event.status.phase === "down") {
          probe.stop();
          this.retryLiveSoon();
        }
      });
      // If the probe neither flows nor dies within 15s, give up this round.
      setTimeout(() => {
        if (this.mode === "synthetic") {
          probe.stop();
          this.retryLiveSoon();
        }
      }, 15_000);
    }, 10_000);
  }

  private updateVol(nowMs: number): void {
    if (nowMs - this.lastVolSampleMs < 1000) return;
    // Keep the calibration windows bounded — these grow at message rate and
    // the piece is built for long looks.
    const cutoff = nowMs - 60_000;
    this.createTimes = this.createTimes.filter((t) => t > cutoff);
    this.cancelTimes = this.cancelTimes.filter((t) => t > cutoff);
    this.tradeTimes = this.tradeTimes.filter((t) => t > cutoff);
    const bid = this.engine.bestBid();
    const ask = this.engine.bestAsk();
    if (bid === undefined || ask === undefined) return;
    const mid = (bid + ask) / 2;
    if (this.lastMid !== 0) {
      const dtSec = (nowMs - this.lastVolSampleMs) / 1000;
      this.volEma = this.volEma * 0.95 + (Math.abs(mid - this.lastMid) / Math.sqrt(dtSec)) * 0.05;
    }
    this.spreadEma = this.spreadEma * 0.9 + (ask - bid) * 0.1;
    this.lastMid = mid;
    this.lastVolSampleMs = nowMs;
  }

  private calibration(): SyntheticCalibration {
    const nowMs = Date.now();
    const inWindow = (times: number[]) => times.filter((t) => nowMs - t < 60_000).length / 60;
    const creates = inWindow(this.createTimes);
    const trades = inWindow(this.tradeTimes);
    if (creates < 1) return QUIET_BTCUSD;
    const median = this.sizeQuantile(0.5);
    // Scaled well below the live message rate: live spreads its churn across
    // thousands of mostly-offscreen levels, while the understudy quotes
    // inside the frame — a 1:1 rate reads frantic where live reads alive.
    return {
      makerWakesPerSec: Math.min(Math.max(creates * 0.25, 3), 14),
      noisePerSec: Math.min(Math.max(creates * 0.15, 2), 8),
      takersPerSec: Math.min(Math.max(trades * 0.8, 0.05), 0.6),
      sizeMedianSats: Math.max(median, 10_000),
      halfSpreadTicks: Math.max(1, Math.round(this.spreadEma / 2)),
      volTicksPerRootSec: Math.max(0.3, Math.min(this.volEma, 6)),
    };
  }

  // -------------------------------------------------------------------------
  // Frames, control, inspection.
  // -------------------------------------------------------------------------

  fillFrame(buffer: ArrayBuffer): FrameMeta {
    const nowMs = Date.now();
    const packed = packFrame(this.engine, buffer, (slot) => {
      const at = this.restedAtMs.get(this.engine.store.id[slot]);
      return at === undefined ? 0 : Math.max((nowMs - at) / 1000, 0);
    });

    const glance = this.glance();
    this.detectors.glance(glance, nowMs);

    this.msgWindow = this.msgWindow.filter((t) => nowMs - t < 5_000);
    const meta: FrameMeta = {
      mode: this.mode,
      seededFromLive: this.syntheticSeededFromLive,
      degraded: this.degraded,
      clock: this.clock(nowMs),
      events: this.renderEvents,
      droppedCancels: this.droppedCancels,
      tape: [...this.tape],
      caption: this.detectors.currentCaption(),
      narration: this.detectors.narrate(glance, BTCUSD.priceDecimals),
      stats: {
        msgsPerSec: this.msgWindow.length / 5,
        tradesPerMin: this.tradeTimes.filter((t) => nowMs - t < 60_000).length,
        orders: this.engine.store.size,
        anomalies: this.engine.unexpectedAnomalyCount(),
        coreMedianSats: packed.coreMedianSats,
      },
      transition: this.transition,
    };
    this.renderEvents = [];
    this.droppedCancels = 0;
    this.transition = null;
    return meta;
  }

  private glance(): BookGlance {
    const bid = this.engine.bestBid();
    const ask = this.engine.bestAsk();
    let bidNear = 0;
    let askNear = 0;
    if (bid !== undefined && ask !== undefined) {
      const mid = (bid + ask) / 2;
      const band = mid * 0.0015;
      for (const tick of this.engine.bids.ticks) {
        if (tick >= mid - band) bidNear += this.engine.bids.levels.get(tick)!.totalSats;
      }
      for (const tick of this.engine.asks.ticks) {
        if (tick <= mid + band) askNear += this.engine.asks.levels.get(tick)!.totalSats;
      }
    }
    return {
      midTick: bid !== undefined && ask !== undefined ? (bid + ask) / 2 : 0,
      spreadTicks: bid !== undefined && ask !== undefined ? ask - bid : 0,
      bidDepthNearSats: bidNear,
      askDepthNearSats: askNear,
      lastTradeTick: this.tape.length > 0 ? this.tape[this.tape.length - 1].tick : null,
    };
  }

  private sizeQuantile(q: number): number {
    if (this.sizeSamples.length === 0) return 8_000_000;
    const sorted = [...this.sizeSamples].sort((a, b) => a - b);
    return sorted[Math.min(Math.floor(q * sorted.length), sorted.length - 1)];
  }

  private clock(nowMs: number): ClockInfo {
    if (this.paused) {
      const oldest = this.pauseQueue[0];
      return { state: "paused", behindMs: oldest === undefined ? 0 : nowMs - oldest.atMs, speed: 0 };
    }
    if (this.pauseQueue.length > 0) {
      return { state: "behind", behindMs: nowMs - this.pauseQueue[0].atMs, speed: CATCH_UP_SPEED };
    }
    return { state: "live", behindMs: 0, speed: 1 };
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.mode === "replay") this.replay?.pause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.catchUpCursorMs = this.pauseQueue.length > 0 ? this.pauseQueue[0].atMs : 0;
    if (this.mode === "replay") this.replay?.resume();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) {
      // A hidden tab must not stream (battery, data): drop the socket; the
      // synthetic understudy is not started either — nothing is watching.
      if (this.mode === "live") {
        this.live?.stop();
        this.live = null;
        this.degraded = true;
      }
      if (this.mode === "replay") this.replay?.pause();
    } else {
      if (this.mode === "live" && this.live === null && this.configMode !== "synthetic") {
        this.startLive();
      }
      if (this.mode === "replay" && !this.paused) this.replay?.resume();
    }
  }

  inspect(side: Side, tick: number, cumSats: number): InspectionResult | null {
    const book = this.engine.sideBook(side);
    const level = book.levels.get(tick);
    if (level === undefined) return null;
    let cum = 0;
    let position = 0;
    for (let slot = level.head; slot !== NIL; slot = this.engine.store.next[slot]) {
      const sats = this.engine.store.sats[slot];
      position++;
      if (cumSats < cum + sats) {
        const id = this.engine.store.id[slot];
        const at = this.restedAtMs.get(id);
        return {
          id, side, tick, sats,
          aheadSats: cum,
          queuePosition: position,
          queueLength: level.count,
          ageSec: at === undefined ? 0 : (Date.now() - at) / 1000,
          liquidation: (this.engine.store.flags[slot] & 1) !== 0,
        };
      }
      cum += sats;
    }
    return null;
  }

  /** Re-locate a previously inspected order by id. Null once it has filled,
   * cancelled, or been swept away in a reseed — the caller closes the box
   * rather than keep describing an order that is no longer in the book. */
  inspectById(id: number): InspectionResult | null {
    const store = this.engine.store;
    const slot = store.idToSlot.get(id);
    if (slot === undefined) return null;
    const side = store.side[slot] as Side;
    const tick = store.tick[slot];
    const level = this.engine.sideBook(side).levels.get(tick);
    if (level === undefined) return null;
    let cum = 0;
    let position = 0;
    for (let s = level.head; s !== NIL; s = store.next[s]) {
      position++;
      if (s === slot) {
        const at = this.restedAtMs.get(id);
        return {
          id, side, tick,
          sats: store.sats[slot],
          aheadSats: cum,
          queuePosition: position,
          queueLength: level.count,
          ageSec: at === undefined ? 0 : (Date.now() - at) / 1000,
          liquidation: (store.flags[slot] & 1) !== 0,
        };
      }
      cum += store.sats[s];
    }
    return null;
  }

  /** The current book as seed orders (queue order preserved), for handoff. */
  private exportBook(): SeedOrder[] {
    const orders: SeedOrder[] = [];
    for (const side of [Side.Bid, Side.Ask] as Side[]) {
      const book = this.engine.sideBook(side);
      for (const tick of book.ticks) {
        const level = book.levels.get(tick)!;
        for (let slot = level.head; slot !== NIL; slot = this.engine.store.next[slot]) {
          orders.push({
            id: this.engine.store.id[slot],
            side,
            tick,
            sats: this.engine.store.sats[slot],
            micro: this.engine.store.micro[slot],
          });
        }
      }
    }
    return orders;
  }
}

/**
 * A live book can be transiently crossed (venue truth we absorbed); the
 * internal matcher must not START crossed, so a handoff seed drops crossing
 * orders, newest first — the stalest picture of the far side is likelier to
 * be the wrong one, and dropped simulation seed is disclosed simulation.
 */
export function sanitizeSeed(orders: SeedOrder[]): SeedOrder[] {
  const kept = [...orders];
  for (;;) {
    let bestBid: SeedOrder | null = null;
    let bestAsk: SeedOrder | null = null;
    for (const o of kept) {
      if (o.side === Side.Bid) {
        if (bestBid === null || o.tick > bestBid.tick) bestBid = o;
      } else if (bestAsk === null || o.tick < bestAsk.tick) {
        bestAsk = o;
      }
    }
    if (bestBid === null || bestAsk === null || bestBid.tick < bestAsk.tick) return kept;
    const crossing = kept.filter(
      (o) => (o.side === Side.Bid ? o.tick >= bestAsk!.tick : o.tick <= bestBid!.tick),
    );
    let drop = crossing[0];
    for (const o of crossing) if (o.micro > drop.micro || (o.micro === drop.micro && o.id > drop.id)) drop = o;
    kept.splice(kept.indexOf(drop), 1);
  }
}
