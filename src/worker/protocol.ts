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
} as const;

/** A discrete market event the renderer may animate (decay/stagger are the
 * renderer's; the event itself is data). Trades are never dropped; cancels
 * are capped per frame and the overflow count is reported. */
export type RenderEvent =
  | { kind: "trade"; tick: PriceTick; sats: Sats; aggressor: Side; liquidation: boolean }
  | { kind: "cancel"; tick: PriceTick; side: Side; sats: Sats };

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
  /** True while the source is degraded and the book may be stale (seeding). */
  degraded: boolean;
  clock: ClockInfo;
  events: RenderEvent[];
  droppedCancels: number;
  tape: TapeRow[];
  caption: { text: string; id: number } | null;
  narration: string;
  stats: { msgsPerSec: number; tradesPerMin: number; orders: number; anomalies: number };
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
  | { type: "init"; mode: "auto" | SourceKind; seed: number; replayUrl?: string }
  | { type: "frame"; buffer: ArrayBuffer }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "hidden"; hidden: boolean }
  | { type: "inspect"; token: number; side: Side; tick: PriceTick; cumSats: Sats };

export type WorkerToMain =
  | { type: "frame"; buffer: ArrayBuffer; meta: FrameMeta }
  | { type: "inspection"; token: number; result: InspectionResult | null }
  | { type: "fatal"; message: string };
