import type { PriceTick, Sats, Side } from "../engine/types";
import type { SourceKind } from "../sources/source";

/**
 * The worker/main boundary is also the truth boundary (docs/design.md §9):
 * everything in these messages describes the market; everything the renderer
 * adds on top (framing, easing, age-to-brightness) describes looking at it.
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
 *       +4  restedAtSec when this order rested, seconds from the frame's age
 *                       epoch — a FACT about the order, constant for as long
 *                       as it rests, not a per-frame derivative. Age is
 *                       `meta.nowSec - restedAtSec`, done in the shader. This
 *                       is what makes the instance block byte-identical
 *                       between market events, which is what lets the worker
 *                       skip the pack and the renderer skip the upload.
 *       +5  flags       bit0 liquidation
 *       +6  tickLo      tick - fround(tick): the part of the price float32
 *                       drops. +0 holds fround(tick), which is the exact tick
 *                       only below 2^24 ($167,772.16). Past that +0 alone is
 *                       off by up to half its float32 spacing: 128 ticks at
 *                       $21M, 2,048 at the $484M asks a real book rests. The
 *                       shader subtracts the two halves separately (cells.ts),
 *                       so a row a viewer pans out to is drawn at its price.
 *                       0 for every order near the BTC/USD mid.
 */
export const FRAME_HEADER_FLOATS = 16;
export const FRAME_STRIDE = 7;
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
  /** Camera hint: half-span (ticks from mid) for the bird's-eye standpoint —
   * the body of the book (the nearest three quarters of occupied levels, plus
   * air), bounded by a fraction of the price so the far constellation cannot
   * squash the market into a line. On a live book the bound is what sets it.
   * See packer.ts. */
  SpanHintTicks: 7,
  /** 80th-percentile LEVEL depth among the top levels — the spine layout's
   * width scale, so a typical row spans most of a phone screen instead of
   * every order huddling at the left edge. */
  CoreLevelP80Sats: 8,
  /** Extent of the resting book: lowest and highest occupied tick across
   * both sides (0/0 while empty). The camera's pan clamp — the viewer may
   * wander a little past the last order, never into the void beyond. */
  LoTick: 9,
  HiTick: 10,
  /** The float32 remainders of LoTick and HiTick (value - fround(value)), as
   * for an instance's tickLo: the camera clamps to the exact extent, and the
   * farthest real ask is two thousand ticks past its float32 rounding. */
  LoTickLo: 12,
  HiTickLo: 13,
  /** Which book state this buffer holds. The worker stamps it; on the next
   * request it compares the stamp against the live book and re-packs only if
   * they differ, so a buffer that is still correct is returned untouched.
   * Never 0 (a fresh, zeroed buffer must always read as stale), and wrapped
   * well inside f32's exact-integer range. */
  BookRevision: 11,
} as const;

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
  /** The pack-time clock, seconds from the same age epoch the instances'
   * restedAtSec use. The renderer hands it to the cell shader, which is the
   * only place age is turned into brightness. Whoever reads it must take it
   * with the frame it arrived on: the epoch can be re-based, and when it is,
   * every instance is re-packed in that same frame. */
  nowSec: number;
  /** The last trades, newest last: the only discrete events that cross.
   * Nothing on the main thread marks a trade or a cancel (the book changing
   * is the mark), so there is no per-frame event list to carry. */
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
  /** Frames actually packed in the last second, against the ~60 requested.
   * HUD only — the on-device proof that an unchanged book costs nothing. */
  packsPerSec: number;
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
  /** Find the order drawn nearest the pointer (render/layout.ts HitProbe). */
  | {
    type: "inspect"; token: number; sides: Side[]; tickAt: number;
    reachTicks: number; cumSats: Sats; satsSlop: Sats;
  }
  /** Re-resolve a previously inspected order by id. A null reply means it
   * left the book (filled or cancelled) — the inspector's cue to close. */
  | { type: "watch"; token: number; id: number };

export type WorkerToMain =
  | { type: "frame"; buffer: ArrayBuffer; meta: FrameMeta }
  | { type: "inspection"; token: number; result: InspectionResult | null }
  | { type: "fatal"; message: string };
