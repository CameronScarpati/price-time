import type { EngineEvent, PriceTick, Sats, Side } from "../engine/types";
import { Side as S } from "../engine/types";
import { formatDecimal } from "../sources/bitstamp/decimal";

/**
 * Phenomenon detectors (docs/design.md §11): small state machines over the
 * engine's event stream that notice the moments worth narrating — a sweep, a
 * refill, a cancel storm, a vacuum, a quiet market — and produce the captions
 * and the screen-reader narration. Detection is data; when and how a caption
 * fades is presentation and lives with the renderer.
 *
 * All time here is wall-clock milliseconds from the pipeline (detection
 * happens at observation time, and cooldowns are about the viewer, not the
 * market).
 */

export interface BookGlance {
  midTick: number;
  spreadTicks: number;
  bidDepthNearSats: Sats;
  askDepthNearSats: Sats;
  lastTradeTick: PriceTick | null;
}

interface SweepState {
  aggressor: Side;
  ticks: Set<PriceTick>;
  sats: Sats;
  startedMs: number;
  /** Near-side depth when the sweep ended; the refill detector's baseline. */
  depthAfter?: Sats;
  endedMs?: number;
}

/** Caption-grade quantity: a narrated sentence rounds ("2.78 BTC"), because
 * eight satoshi decimals mid-sentence read as machine output, not narration.
 * The tape keeps full precision; this helper is caption-only. */
const btc = (sats: Sats): string => {
  const v = sats / 1e8;
  const s = v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(5);
  return `${s.replace(/0+$/, "").replace(/\.$/, "")} BTC`;
};

export class Detectors {
  private caption: { text: string; id: number } | null = null;
  private captionSeq = 0;
  private lastCaptionAt = new Map<string, number>();

  private sweep: SweepState | null = null;
  private watchingRefill: SweepState | null = null;

  private cancelTimes: number[] = [];
  private cancelBaselinePerSec = 4;
  private msgTimes: number[] = [];
  private lastTradeTick: PriceTick | null = null;
  private quietSince: number | null = null;

  /** Feed one batch of engine events observed at wall time `nowMs`. */
  observe(events: readonly EngineEvent[], nowMs: number): void {
    for (const event of events) {
      if (event.kind === "trade") {
        this.msgTimes.push(nowMs);
        this.lastTradeTick = event.tick;
        this.observeTrade(event.tick, event.sats, event.aggressor, nowMs);
      } else if (event.kind === "canceled") {
        this.msgTimes.push(nowMs);
        this.cancelTimes.push(nowMs);
      } else if (event.kind === "rested" || event.kind === "resized") {
        this.msgTimes.push(nowMs);
      }
    }
  }

  private observeTrade(tick: PriceTick, sats: Sats, aggressor: Side, nowMs: number): void {
    if (this.sweep !== null && (this.sweep.aggressor !== aggressor || nowMs - this.sweep.startedMs > 400)) {
      this.finishSweep(nowMs);
    }
    if (this.sweep === null) {
      this.sweep = { aggressor, ticks: new Set(), sats: 0, startedMs: nowMs };
    }
    this.sweep.ticks.add(tick);
    this.sweep.sats += sats;
  }

  private finishSweep(nowMs: number): void {
    const s = this.sweep;
    this.sweep = null;
    // Three levels AND meaningful size: tiny orders tick through levels
    // constantly on a fine-tick book, and narrating those is noise.
    if (s === null || s.ticks.size < 3 || s.sats < 20_000_000) return;
    const ms = Math.max(nowMs - s.startedMs, 1);
    const verb = s.aggressor === S.Bid ? "buy" : "sell";
    this.say(
      "sweep",
      `a ${verb} just swept ${s.ticks.size} levels — ${btc(s.sats)} in ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}`,
      nowMs, 8_000,
    );
    s.endedMs = nowMs;
    this.watchingRefill = s;
  }

  /** Called once per frame with the current book glance. */
  glance(book: BookGlance, nowMs: number): void {
    if (this.sweep !== null && nowMs - this.sweep.startedMs > 400) this.finishSweep(nowMs);

    // Refill: the near-book recovers to its pre-sweep neighborhood.
    const w = this.watchingRefill;
    if (w !== null) {
      const near = w.aggressor === S.Bid ? book.askDepthNearSats : book.bidDepthNearSats;
      const elapsed = nowMs - (w.endedMs ?? nowMs);
      if (w.depthAfter === undefined) {
        w.depthAfter = near;
      } else if (near >= w.depthAfter + w.sats * 0.7 && elapsed > 5_000) {
        this.say("refill", `the hole just refilled — ${(elapsed / 1000).toFixed(0)}s to heal`, nowMs, 20_000);
        this.watchingRefill = null;
      } else if (elapsed > 120_000) {
        this.watchingRefill = null;
      }
    }

    // Cancel storm: pace of withdrawals against a slow baseline.
    this.cancelTimes = this.cancelTimes.filter((t) => nowMs - t < 10_000);
    const cancelsPerSec = this.cancelTimes.length / 10;
    this.cancelBaselinePerSec = this.cancelBaselinePerSec * 0.999 + cancelsPerSec * 0.001;
    if (cancelsPerSec > this.cancelBaselinePerSec * 3 && this.cancelTimes.length > 120) {
      this.say(
        "cancel-storm",
        `${this.cancelTimes.length} quotes pulled in 10s — ${(cancelsPerSec / Math.max(this.cancelBaselinePerSec, 0.1)).toFixed(0)}× the usual pace`,
        nowMs, 30_000,
      );
    }

    // Vacuum: one side of the near book empties while the other stands.
    const { bidDepthNearSats: bid, askDepthNearSats: ask } = book;
    if (bid + ask > 0) {
      const thin = Math.min(bid, ask);
      const thick = Math.max(bid, ask);
      if (thick > 0 && thin / thick < 0.1 && thick > 10_000_000) {
        const side = bid < ask ? "bid" : "offer";
        this.say("vacuum", `the ${side} side just emptied near the touch — a liquidity vacuum`, nowMs, 30_000);
      }
    }

    // Quiet: a market where single orders become events.
    this.msgTimes = this.msgTimes.filter((t) => nowMs - t < 10_000);
    if (this.msgTimes.length < 40) {
      this.quietSince ??= nowMs;
      if (nowMs - this.quietSince > 30_000) {
        this.say("quiet", "a quiet market — single orders are events now", nowMs, 120_000);
      }
    } else {
      this.quietSince = null;
    }
  }

  private say(key: string, text: string, nowMs: number, cooldownMs: number): void {
    const last = this.lastCaptionAt.get(key);
    if (last !== undefined && nowMs - last < cooldownMs) return;
    this.lastCaptionAt.set(key, nowMs);
    this.caption = { text, id: ++this.captionSeq };
  }

  /** The most recent caption (renderer decides how long it lingers). */
  currentCaption(): { text: string; id: number } | null {
    return this.caption;
  }

  /** Discard a pending caption without touching cooldowns. Used once, at the
   * end of a cold-start warmup: a caption narrating something that happened
   * before the viewer arrived must not be the first thing they read. */
  dropCaption(): void {
    this.caption = null;
  }

  /** One plain sentence describing the market right now — the ARIA live
   * region's content, and the design's forcing function: if this sentence
   * can't be said, the visual probably isn't saying it either. */
  narrate(book: BookGlance, priceDecimals: number): string {
    if (book.midTick === 0) return "waiting for the book";
    const spread = formatDecimal(Math.round(book.spreadTicks), 0);
    const bid = book.bidDepthNearSats;
    const ask = book.askDepthNearSats;
    let lean = "evenly stacked";
    if (bid > ask * 2) lean = `bids stacked ${(bid / Math.max(ask, 1)).toFixed(0)} to 1`;
    else if (ask > bid * 2) lean = `offers stacked ${(ask / Math.max(bid, 1)).toFixed(0)} to 1`;
    const last =
      this.lastTradeTick !== null
        ? `, last trade ${formatDecimal(this.lastTradeTick, priceDecimals)}`
        : "";
    return `spread ${spread} tick${spread === "1" ? "" : "s"}, ${lean}${last}`;
  }
}
