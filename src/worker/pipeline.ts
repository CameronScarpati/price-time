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
import { Header, type ClockInfo, type FrameMeta, type InspectionResult, type TapeRow } from "./protocol";

const TAPE_LENGTH = 24;
const CATCH_UP_SPEED = 8;
/** How long live may stay non-flowing before the synthetic understudy steps in. */
const LIVE_GRACE_MS = 2_500;
/** The cell shader's arrival ramp: alpha rises over an order's first 120ms
 * of age (cells.ts). */
const ARRIVAL_RAMP_MS = 120;

/**
 * The worker's core: one engine, one active source, one truth (docs/design.md
 * §2 and §10). The pipeline folds source events into the engine, collects
 * the tape and detector output, manages the degradation ladder
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

  private tape: TapeRow[] = [];
  private transition: { from: SourceKind; to: SourceKind } | null = null;
  private degraded = true;

  /** Wall time each order rested locally, for age display. Keyed by slot via
   * the store's arrays would be stale across engines; id keying survives. */
  private restedAtMs = new Map<number, number>();
  /** Age epoch. Instances carry `restedAtSec` relative to this, and the frame
   * carries `nowSec` relative to it, so the renderer can compute age without
   * anything in the buffer changing between market events. Relative, because
   * epoch-milliseconds do not survive Float32: 1.77e12 rounds to the nearest
   * 128k there, where seconds-since-session-start keeps microsecond
   * resolution for a day. Re-based before precision could ever bite. */
  private ageEpochMs = Date.now();
  /** When the current book was last seeded. Orders stamped at or before it
   * came with the seed rather than arriving. */
  private seedAtMs = -Infinity;
  /** Which book state the packed frame describes. Bumped by every engine
   * event, so an unchanged book packs to identical bytes and can be skipped.
   * Starts at 1: a fresh, zeroed buffer reads 0 and must always look stale. */
  private bookRevision = 1;
  private lastCoreMedianSats = 8_000_000;
  /** Pack timestamps over the last second — the HUD's evidence that skipping
   * is actually happening on real hardware, where it can be believed. */
  private packTimes: number[] = [];

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
    this.invalidateFrame();
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
    this.invalidateFrame();
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
      this.invalidateFrame();
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
      // Unconditional, and deliberately so: "a command reached the engine"
      // is a rule one can check by reading this line, where "an event came
      // back" would need every command's semantics audited to be sure the
      // book really cannot have moved. A no-op command costs one skipped
      // skip; a missed invalidation would show a stale book, which is the
      // one thing this project does not do.
      this.invalidateFrame();
      const events = this.engine.apply(event.cmd);
      this.afterEngineEvents(events);
      if (this.mode === "synthetic") this.synthetic?.feedback(events);
      if (event.cmd.kind === "seed") {
        // A fresh book: ages restart from what the venue reported, and the
        // detectors' baselines restart with it.
        this.detectors.bookReplaced();
        this.restedAtMs.clear();
        const nowMs = Date.now();
        this.seedAtMs = nowMs;
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
          this.tape.push({ tick: event.tick, sats: event.sats, aggressor: event.aggressor, atMs: nowMs });
          if (this.tape.length > TAPE_LENGTH) this.tape.shift();
          this.tradeTimes.push(nowMs);
          if (event.makerRemaining === 0) this.restedAtMs.delete(event.makerId);
          break;
        }
        case "canceled": {
          this.cancelTimes.push(nowMs);
          this.restedAtMs.delete(event.id);
          break;
        }
        case "taken":
          // The taker's side of a venue fill. The maker's trade is the print.
          if (event.remaining === 0) this.restedAtMs.delete(event.id);
          break;
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
    // Keep the epoch young enough that Float32 still resolves the 120ms
    // arrival ramp. A day in gives ~10ms of resolution; re-basing shifts
    // every instance's stamp, so it counts as a book change.
    if (nowMs - this.ageEpochMs > 86_400_000) {
      this.ageEpochMs = nowMs;
      this.invalidateFrame();
    }
    const nowSec = (nowMs - this.ageEpochMs) / 1000;

    // The buffer carries the book state it was packed from. If that is still
    // the live one, its bytes are still correct — nothing in them is derived
    // from "now" — so the whole pack is skipped and the buffer goes back
    // untouched. The renderer reads the same stamp and skips its upload.
    const f32 = new Float32Array(buffer);
    if (f32[Header.BookRevision] !== this.bookRevision) {
      const packed = packFrame(this.engine, buffer, (slot) => {
        const at = this.restedAtMs.get(this.engine.store.id[slot]);
        if (at === undefined) return nowSec;
        return packedRestedAtSec(at, this.ageEpochMs, this.seedAtMs);
      });
      this.lastCoreMedianSats = packed.coreMedianSats;
      f32[Header.BookRevision] = this.bookRevision;
      this.packTimes.push(nowMs);
    }

    const glance = this.glance();
    this.detectors.glance(glance, nowMs);

    this.msgWindow = this.msgWindow.filter((t) => nowMs - t < 5_000);
    const meta: FrameMeta = {
      mode: this.mode,
      seededFromLive: this.syntheticSeededFromLive,
      degraded: this.degraded,
      clock: this.clock(nowMs),
      nowSec,
      tape: [...this.tape],
      caption: this.detectors.currentCaption(),
      narration: this.detectors.narrate(glance, BTCUSD.priceDecimals),
      stats: {
        msgsPerSec: this.msgWindow.length / 5,
        tradesPerMin: this.tradeTimes.filter((t) => nowMs - t < 60_000).length,
        orders: this.engine.store.size,
        anomalies: this.engine.unexpectedAnomalyCount(),
        coreMedianSats: this.lastCoreMedianSats,
      },
      transition: this.transition,
      packsPerSec: this.packRate(nowMs),
    };
    this.transition = null;
    return meta;
  }

  /** Mark the packed frame stale. Wrapped well inside Float32's exact-integer
   * range, and only two buffers are ever in flight, so a stamp cannot survive
   * a wrap and come back looking current. */
  private invalidateFrame(): void {
    this.bookRevision = (this.bookRevision % 8_388_607) + 1;
  }

  private packRate(nowMs: number): number {
    this.packTimes = this.packTimes.filter((t) => nowMs - t < 1000);
    return this.packTimes.length;
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

  /**
   * The order drawn nearest the pointer: rows are searched outward from
   * `tickAt`, the fractional tick under the pointer, nearest first and no
   * farther than `reachTicks` and only inside `tickMin..tickMax` (the rows
   * with a visible pixel), and in a row the order whose queue span holds
   * `cumSats` wins; past the back of the queue, within `satsSlop`, the last
   * order does (the renderer draws the shortest cells longer than their size,
   * so the visible end of a queue can sit a pixel or two past its total).
   */
  inspect(
    sides: readonly Side[], tickAt: number, reachTicks: number, cumSats: number, satsSlop: number,
    tickMin = 1, tickMax = Infinity,
  ): InspectionResult | null {
    const near = Math.round(tickAt);
    // |near - tickAt| <= 0.5, so taking the nearer of each pair first keeps
    // the whole walk in order of distance.
    const below = tickAt < near;
    for (let d = 0; d <= Math.ceil(reachTicks) + 1; d++) {
      for (let k = 0; k < (d === 0 ? 1 : 2); k++) {
        const t = d === 0 ? near : (k === 0) === below ? near - d : near + d;
        if (Math.abs(t - tickAt) > reachTicks || t < tickMin || t > tickMax) continue;
        for (const side of sides) {
          const found = this.inspectLevel(side, t, cumSats, satsSlop);
          if (found !== null) return found;
        }
      }
    }
    return null;
  }

  private inspectLevel(side: Side, tick: number, cumSats: number, satsSlop: number): InspectionResult | null {
    const level = this.engine.sideBook(side).levels.get(tick);
    if (level === undefined || cumSats > level.totalSats + satsSlop) return null;
    const store = this.engine.store;
    let cum = 0;
    let position = 0;
    for (let slot = level.head; slot !== NIL; slot = store.next[slot]) {
      const sats = store.sats[slot];
      position++;
      if (cumSats < cum + sats || store.next[slot] === NIL) {
        const id = store.id[slot];
        const at = this.restedAtMs.get(id);
        return {
          id, side, tick, sats,
          aheadSats: cum,
          queuePosition: position,
          queueLength: level.count,
          ageSec: at === undefined ? 0 : (Date.now() - at) / 1000,
          liquidation: (store.flags[slot] & 1) !== 0,
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
 * An order's rest time as the cell shader reads it, in seconds from the age
 * epoch. A seeded order did not arrive at the seed: the book was already
 * there, and a snapshot stamps every order with the one snapshot time. So it
 * is packed one arrival ramp earlier, which keeps a reseed from fading the
 * whole field in from 30% as if every order had just landed. This is the
 * shader's copy only; the inspector reads the unshifted time, and 120ms
 * changes nothing else the shader does with age (the ember starts at 60s).
 *
 * Floored well before Float32 gets coarse. Anything this old is fully
 * embered in the shader, so the clamp changes no pixel — and it must be a
 * CONSTANT floor, not one relative to now, or an ancient order would
 * re-write itself on every frame and defeat the whole point.
 */
export function packedRestedAtSec(atMs: number, epochMs: number, seedAtMs: number): number {
  const shown = atMs <= seedAtMs ? atMs - ARRIVAL_RAMP_MS : atMs;
  return Math.max((shown - epochMs) / 1000, -1_000_000);
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
