import type { FlowSource, SourceEvent, SourceSink } from "../source";
import { isOrderMessage, isTradeMessage } from "./messages";
import type { RawMessage, RawOrderMessage, RawSnapshot } from "./messages";
import { normalizeOrderMessage, normalizeSnapshot, normalizeTradeMessage } from "./normalize";
import type { Instrument } from "./normalize";
import { parseDecimal } from "./decimal";

export interface LiveSourceConfig {
  instrument: Instrument;
  wsUrl?: string;
  restBase?: string;
  /** Local top of book, for the divergence guard (defense in depth). */
  localTopOfBook?: () => { bidTick: number; askTick: number } | null;
  divergenceIntervalMs?: number;
  divergenceToleranceTicks?: number;
}

/** Live events buffered during seeding are capped; the snapshot that follows
 * subsumes anything this old, and idempotent apply makes trimming safe. */
const BUFFER_CAP = 100_000;
const SNAPSHOT_RETRY_MS = 2_000;
const RECONNECT_BACKOFF_BASE_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

/**
 * The live Bitstamp source (docs/design.md §5). Reconstruction discipline:
 *
 *  - Subscribe first, buffer everything, then fetch the group=2 snapshot and
 *    replay the buffer through the engine's idempotent external commands.
 *  - Verify the event_id chain on every order message. Any broken link is a
 *    gap, and a gap means the book is thrown away and re-seeded. There is no
 *    code path that patches across a gap — that absence is deliberate.
 *  - Every 30s, compare local top-of-book against the venue's aggregated REST
 *    book; two consecutive misses beyond tolerance count as divergence and
 *    force a re-seed. This is insurance against wrongness the chain can't see.
 */
export class BitstampLiveSource implements FlowSource {
  readonly kind = "live" as const;

  private readonly instrument: Instrument;
  private readonly wsUrl: string;
  private readonly restBase: string;
  private readonly localTopOfBook: (() => { bidTick: number; askTick: number } | null) | undefined;
  private readonly divergenceIntervalMs: number;
  private readonly divergenceToleranceTicks: number;

  private sink: SourceSink | null = null;
  private ws: WebSocket | null = null;
  private phase: "idle" | "connecting" | "seeding" | "flowing" = "idle";
  /** Bumped on every reseed/reconnect; async completions from older attempts check it and abort. */
  private generation = 0;
  private buffer: SourceEvent[] = [];
  private lastEventId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private divergenceTimer: ReturnType<typeof setInterval> | null = null;
  private divergenceStrikes = 0;

  readonly stats = {
    messages: 0,
    trades: 0,
    gaps: 0,
    reseeds: 0,
    reconnects: 0,
    divergenceReseeds: 0,
    subtypes: new Map<number, number>(),
  };

  constructor(config: LiveSourceConfig) {
    this.instrument = config.instrument;
    this.wsUrl = config.wsUrl ?? "wss://ws.bitstamp.net";
    this.restBase = config.restBase ?? "https://www.bitstamp.net/api/v2";
    this.localTopOfBook = config.localTopOfBook;
    this.divergenceIntervalMs = config.divergenceIntervalMs ?? 30_000;
    this.divergenceToleranceTicks = config.divergenceToleranceTicks ?? 1;
  }

  start(sink: SourceSink): void {
    this.sink = sink;
    this.connect();
  }

  stop(): void {
    this.generation++;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.phase = "idle";
    this.sink = null;
  }

  /** Public so the pipeline can force a rebuild (e.g. after resuming a hidden tab). */
  reseed(reason: "gap" | "divergence" | "reconnect"): void {
    if (this.phase === "idle") return;
    this.stats.reseeds++;
    this.emit({ type: "status", status: { phase: "reseeding", reason } });
    this.beginSeeding();
  }

  private emit(event: SourceEvent): void {
    this.sink?.(event);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    if (this.divergenceTimer !== null) clearInterval(this.divergenceTimer);
    this.reconnectTimer = null;
    this.snapshotTimer = null;
    this.divergenceTimer = null;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle.
  // -------------------------------------------------------------------------

  private connect(): void {
    this.generation++;
    this.phase = "connecting";
    this.emit({ type: "status", status: { phase: "connecting" } });
    this.lastEventId = null;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.scheduleReconnect(String(err));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      for (const channel of [`live_orders_${this.instrument.pair}`, `live_trades_${this.instrument.pair}`]) {
        ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel } }));
      }
      this.beginSeeding();
    };
    ws.onmessage = (m) => this.onMessage(String(m.data));
    ws.onclose = () => this.scheduleReconnect("socket closed");
    ws.onerror = () => {
      // onclose follows onerror; reconnect is scheduled there.
    };
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    this.phase = "connecting";
    this.stats.reconnects++;
    const delay = Math.min(
      RECONNECT_BACKOFF_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_BACKOFF_MAX_MS,
    );
    this.reconnectAttempts++;
    this.emit({ type: "status", status: { phase: "down", reason } });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // -------------------------------------------------------------------------
  // Seeding: buffer → snapshot → idempotent drain.
  // -------------------------------------------------------------------------

  private beginSeeding(): void {
    const generation = ++this.generation;
    this.phase = "seeding";
    this.buffer = [];
    this.divergenceStrikes = 0;
    this.emit({ type: "status", status: { phase: "seeding" } });
    void this.fetchSnapshotAndDrain(generation);
  }

  private async fetchSnapshotAndDrain(generation: number): Promise<void> {
    let snapshot: RawSnapshot;
    try {
      const res = await fetch(
        `${this.restBase}/order_book/${this.instrument.pair}/?group=2`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      snapshot = (await res.json()) as RawSnapshot;
    } catch {
      if (generation !== this.generation) return;
      this.snapshotTimer = setTimeout(() => void this.fetchSnapshotAndDrain(generation), SNAPSHOT_RETRY_MS);
      return;
    }
    if (generation !== this.generation) return;

    this.emit({
      type: "command",
      cmd: { kind: "seed", orders: normalizeSnapshot(snapshot, this.instrument) },
    });
    // Drain the buffer on top of the seed. Idempotent apply makes overlap
    // harmless in one direction only — the other direction is a trap: if the
    // socket lags the snapshot (slow tab, congested path), the buffer holds
    // rests/reduces from BEFORE the snapshot moment for orders the snapshot
    // already saw die. Applying those resurrects dead orders as phantoms that
    // cross the book. Deletions are always safe (unknown ids are ignored);
    // state-bearing events strictly older than the snapshot are dropped.
    const snapMicro = Number(snapshot.microtimestamp);
    const buffered = this.buffer;
    this.buffer = [];
    for (const event of buffered) {
      if (
        event.type === "command" &&
        (event.cmd.kind === "rest" || event.cmd.kind === "reduce") &&
        event.cmd.micro < snapMicro
      ) {
        continue;
      }
      this.emit(event);
    }

    this.phase = "flowing";
    this.reconnectAttempts = 0;
    this.emit({ type: "status", status: { phase: "flowing" } });
    this.startDivergenceGuard();
  }

  // -------------------------------------------------------------------------
  // Message handling.
  // -------------------------------------------------------------------------

  private onMessage(text: string): void {
    let msg: RawMessage;
    try {
      msg = JSON.parse(text) as RawMessage;
    } catch {
      return; // Not JSON: nothing in this protocol is worth guessing about.
    }

    if (isOrderMessage(msg)) {
      this.stats.messages++;
      this.stats.subtypes.set(
        msg.data.order_subtype,
        (this.stats.subtypes.get(msg.data.order_subtype) ?? 0) + 1,
      );
      if (this.checkChain(msg)) return; // gap → reseeding already begun
      this.route({ type: "command", cmd: normalizeOrderMessage(msg, this.instrument) });
      return;
    }
    if (isTradeMessage(msg)) {
      this.stats.messages++;
      this.stats.trades++;
      this.route({ type: "print", print: normalizeTradeMessage(msg, this.instrument) });
      return;
    }
    if (msg.event === "bts:request_reconnect") {
      // The venue is asking us to move; treat as a clean reconnect.
      this.reconnectAttempts = 0;
      this.scheduleReconnect("venue requested reconnect");
    }
  }

  /** Returns true if a gap was detected (and a reseed started). */
  private checkChain(msg: RawOrderMessage): boolean {
    const linked = this.lastEventId === null || msg.pre_event_id === this.lastEventId;
    this.lastEventId = msg.event_id;
    if (linked) return false;
    this.stats.gaps++;
    this.reseed("gap");
    return true;
  }

  private route(event: SourceEvent): void {
    if (this.phase === "seeding") {
      this.buffer.push(event);
      if (this.buffer.length > BUFFER_CAP) this.buffer.splice(0, BUFFER_CAP / 2);
      return;
    }
    if (this.phase === "flowing") this.emit(event);
  }

  // -------------------------------------------------------------------------
  // Divergence guard.
  // -------------------------------------------------------------------------

  private startDivergenceGuard(): void {
    if (this.divergenceTimer !== null) clearInterval(this.divergenceTimer);
    if (!this.localTopOfBook) return;
    this.divergenceTimer = setInterval(() => void this.checkDivergence(), this.divergenceIntervalMs);
  }

  private async checkDivergence(): Promise<void> {
    if (this.phase !== "flowing" || !this.localTopOfBook) return;
    const generation = this.generation;
    let reference: { bidTick: number; askTick: number };
    try {
      const res = await fetch(
        `${this.restBase}/order_book/${this.instrument.pair}/?group=1`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`reference HTTP ${res.status}`);
      const book = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
      if (book.bids.length === 0 || book.asks.length === 0) return;
      reference = {
        bidTick: parseDecimal(book.bids[0][0], this.instrument.priceDecimals),
        askTick: parseDecimal(book.asks[0][0], this.instrument.priceDecimals),
      };
    } catch {
      return; // A failed reference fetch is not evidence of divergence.
    }
    if (generation !== this.generation || this.phase !== "flowing") return;

    const local = this.localTopOfBook();
    if (local === null) return;
    const diverged =
      Math.abs(local.bidTick - reference.bidTick) > this.divergenceToleranceTicks ||
      Math.abs(local.askTick - reference.askTick) > this.divergenceToleranceTicks;

    if (!diverged) {
      this.divergenceStrikes = 0;
      return;
    }
    // The comparison races the live stream (the book can legitimately move
    // between our state and the venue's snapshot), so a single miss is only
    // a strike; two consecutive misses 30s apart is a wrong book.
    if (++this.divergenceStrikes >= 2) {
      this.divergenceStrikes = 0;
      this.stats.divergenceReseeds++;
      this.reseed("divergence");
    }
  }
}
