import type { PriceTick, Sats, Side } from "../engine/types";
import type { SourceKind } from "../sources/source";

/**
 * The worker/main boundary is also the truth boundary (docs/design.md §9):
 * everything in these messages describes the market; everything the renderer
 * adds on top (easing, decay, stagger) describes looking at it.
 *
 * State crosses as one transferred ArrayBuffer per animation frame, ping-
 * ponged so steady state allocates nothing. Layout, all Float32:
 *
 *   [0..HEADER)                     header (see Header indices below)
 *   [HEADER + i*STRIDE ...]         one resting order per instance:
 *       +0  tick        price in ticks
 *       +1  cumBefore   sats resting ahead of this order at its level
 *       +2  sats        remaining quantity
 *       +3  side        0 bid / 1 ask
 *       +4  ageSec      seconds since this order rested (at pack time)
 *       +5  flags       bit0 liquidation
 *
 * f32 holds ticks near the BTC/USD mid exactly (< 2^24); the far tail loses
 * cent precision only where a cent is far below one pixel.
 */
export const FRAME_HEADER_FLOATS = 16;
export const FRAME_STRIDE = 6;
export const FRAME_MAX_INSTANCES = 32_768;
export const FRAME_BYTES =
  (FRAME_HEADER_FLOATS + FRAME_MAX_INSTANCES * FRAME_STRIDE) * 4;

export const Header = {
  InstanceCount: 0,
  BestBidTick: 1,
  BestAskTick: 2,
  /** 0 when either side is empty. */
  MidTick: 3,
  SpreadTicks: 4,
  BidDepthNearSats: 5,
  AskDepthNearSats: 6,
  /** Camera hint: half-span (ticks from mid) that keeps ~15 occupied levels
   * per side in frame. Books are gappy — a fixed tick span frames nothing on
   * a thin day and a wall on a dense one. */
  SpanHintTicks: 7,
  /** 80th-percentile LEVEL depth among the top levels — the spine layout's
   * width scale, so a typical row spans most of a phone screen instead of
   * every order huddling at the left edge. */
  CoreLevelP80Sats: 8,
} as const;

/** A discrete market event the renderer may animate (decay/stagger are the
 * renderer's; the event itself is data). Trades are never dropped; cancels
 * are capped per frame and the overflow count is reported. */
export type RenderEvent =
  | { kind: "trade"; tick: PriceTick; sats: Sats; aggressor: Side; liquidation: boolean }
  | { kind: "cancel"; tick: PriceTick; side: Side; sats: Sats; aheadSats: Sats };

export interface TapeRow {
  tick: PriceTick;
  sats: Sats;
  aggressor: Side;
  atMs: number;
}

export interface ClockInfo {
  /** live = riding the feed's edge; behind = catching up after pause. */
  state: "live" | "paused" | "behind";
  behindMs: number;
  speed: number;
}

export interface FrameMeta {
  mode: SourceKind;
  /** Synthetic only: whether the simulation continues a real book (handoff)
   * or assembled from nothing — the provenance line words differ. */
  seededFromLive: boolean;
  /** True while the source is degraded and the book may be stale (seeding). */
  degraded: boolean;
  clock: ClockInfo;
  events: RenderEvent[];
  droppedCancels: number;
  tape: TapeRow[];
  caption: { text: string; id: number } | null;
  narration: string;
  stats: {
    msgsPerSec: number;
    tradesPerMin: number;
    orders: number;
    anomalies: number;
    /** Median size of the orders in the book's top levels — the renderer's
     * length-scale anchor. A global statistic won't do: whale quotes and
     * far-tail dust drag it across decades. */
    coreMedianSats: number;
  };
  /** Set on the frame where authority changed; triggers the cross-fade. */
  transition: { from: SourceKind; to: SourceKind } | null;
}

export interface InspectionResult {
  id: number;
  side: Side;
  tick: PriceTick;
  sats: Sats;
  aheadSats: Sats;
  queuePosition: number;
  queueLength: number;
  ageSec: number;
  liquidation: boolean;
}

export type MainToWorker =
  | {
      type: "init";
      mode: "auto" | SourceKind;
      seed: number;
      replayUrl?: string;
      /** Dev-only endpoint overrides (local relay in sandboxed environments). */
      wsUrl?: string;
      restBase?: string;
    }
  | { type: "frame"; buffer: ArrayBuffer }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "hidden"; hidden: boolean }
  | { type: "inspect"; token: number; side: Side; tick: PriceTick; cumSats: Sats }
  /** Re-resolve a previously inspected order by id. A null reply means it
   * left the book (filled or cancelled) — the inspector's cue to close. */
  | { type: "watch"; token: number; id: number };

export type WorkerToMain =
  | { type: "frame"; buffer: ArrayBuffer; meta: FrameMeta }
  | { type: "inspection"; token: number; result: InspectionResult | null }
  | { type: "fatal"; message: string };
