import { Side, opposite } from "../engine/types";
import {
  FRAME_BYTES, FRAME_HEADER_FLOATS, FRAME_STRIDE, Header,
  type FrameMeta, type MainToWorker, type WorkerToMain,
} from "../worker/protocol";
import { Camera } from "./camera";
import { CellPipeline } from "./gl/cells";
import { PostPipeline } from "./gl/post";
import { SpriteKind, SpritePipeline, type Sprite } from "./gl/sprites";
import { tickToY, type LayoutParams } from "./layout";
import { Overlay } from "./overlay";

/**
 * The main-thread renderer: draws the worker's latest frame, owns every
 * presentation clock (camera springs, flash decays, stagger offsets, the
 * mode-transition dip), and nothing else — it cannot invent a price, a size,
 * or an ordering, because everything it draws comes out of the transferred
 * frame or the event list attached to it.
 */

interface HeldFrame {
  buffer: ArrayBuffer;
  f32: Float32Array;
  meta: FrameMeta;
  consumed: boolean;
}

export interface RendererDelegate {
  /** Called once per worker frame with fresh metadata (UI updates from here). */
  onMeta(meta: FrameMeta): void;
  /** Current chrome opacity, 0 at rest → 1 engaged. */
  chromeAlpha(): number;
  reducedMotion(): boolean;
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly cells: CellPipeline;
  private readonly spritesGl: SpritePipeline;
  private readonly postFx: PostPipeline;
  private readonly overlay: Overlay;
  readonly camera = new Camera();

  private latest: HeldFrame | null = null;
  private spare: ArrayBuffer | null = null;
  private requestInFlight = false;

  private sprites: Sprite[] = [];
  private pxPerSat = 42 / 8_000_000;
  private transitionStartMs = 0;
  private dpr = 1;

  // Bimodal framing state, measured from the transferred frame (facts the
  // worker packed — the renderer derives a standpoint, never market state).
  // A skeletal book (a handful of populated levels near the touch) gets a
  // committed close-up of the queue; a dense book keeps the wide standpoint.
  private skeletal = false;
  private touchLevels = 99;
  private occupiedHalfSpanTicks = 0;

  private lastFrameMs = 0;
  /** Frame-time ring for the HUD and the recorded budget numbers. */
  readonly frameTimesMs: number[] = [];

  layoutParams: LayoutParams;
  bestBid = 0;
  bestAsk = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    overlayCanvas: HTMLCanvasElement,
    private readonly worker: Worker,
    private readonly delegate: RendererDelegate,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false, alpha: false, powerPreference: "high-performance",
    });
    if (gl === null) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.cells = new CellPipeline(gl);
    this.spritesGl = new SpritePipeline(gl);
    this.postFx = new PostPipeline(gl);
    this.overlay = new Overlay(overlayCanvas);
    this.layoutParams = {
      viewW: 0, viewH: 0, centerTick: 0, pxPerTick: 8,
      pxPerSat: this.pxPerSat, seamX: 0, layout: 0,
    };

    worker.addEventListener("message", (e: MessageEvent<WorkerToMain>) => {
      if (e.data.type !== "frame") return;
      this.requestInFlight = false;
      if (this.latest !== null) this.spare = this.latest.buffer;
      this.latest = {
        buffer: e.data.buffer,
        f32: new Float32Array(e.data.buffer),
        meta: e.data.meta,
        consumed: false,
      };
    });
    this.spare = new ArrayBuffer(FRAME_BYTES);
    this.latest = null;
    // Prime the pump with a second buffer so one can always be in flight.
    this.post({ type: "frame", buffer: new ArrayBuffer(FRAME_BYTES) }, []);
    this.requestInFlight = true;
  }

  private post(msg: MainToWorker, transfer: Transferable[]): void {
    if (msg.type === "frame") transfer = [msg.buffer];
    this.worker.postMessage(msg, transfer);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.overlay.resize(cssW, cssH, dpr);
    this.layoutParams.viewW = cssW;
    this.layoutParams.viewH = cssH;
  }

  /** One animation frame: request the next state, draw the current one. */
  tick(nowMs: number): void {
    const dtMs = this.lastFrameMs === 0 ? 16.7 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    if (this.frameTimesMs.push(dtMs) > 600) this.frameTimesMs.shift();

    if (!this.requestInFlight && this.spare !== null) {
      const buffer = this.spare;
      this.spare = null;
      this.requestInFlight = true;
      this.post({ type: "frame", buffer }, [buffer]);
    }

    const frame = this.latest;
    const reduced = this.delegate.reducedMotion();
    // One opaque backdrop draw replaces clear + room + vignette: room
    // gradient and vignette are the same static radial math, and on a 3x
    // 120Hz phone every saved fullscreen pass is real battery. (No phosphor,
    // no persistence — the field is crisp by hard rule; see visual-craft.)
    const isSpine = this.layoutParams.viewW / this.layoutParams.viewH < 0.8;
    this.postFx.backdrop(
      this.layoutParams.viewW, this.layoutParams.viewH,
      isSpine ? 0.28 : 0.3, isSpine ? 0.85 : 1, isSpine ? 1.2 : 1,
    );
    if (frame === null) return;
    if (!frame.consumed) {
      frame.consumed = true;
      this.measureOccupancy(frame.f32);
      this.consumeMeta(frame, nowMs, reduced);
    }

    const f32 = frame.f32;
    this.bestBid = f32[Header.BestBidTick];
    this.bestAsk = f32[Header.BestAskTick];
    const mid = f32[Header.MidTick];
    const cssW = this.layoutParams.viewW;
    const cssH = this.layoutParams.viewH;

    const p = this.layoutParams;
    p.layout = cssW / cssH < 0.8 ? 1 : 0;
    // The spine lifts the composition to the portrait optical center — the
    // provenance and safe area occupy the bottom. Lockstep: layout.ts reads
    // this and cells.ts receives it as uCenterYPx.
    p.centerYFrac = p.layout === 1 ? 0.44 : 0.5;
    // Framing is bimodal on occupancy. Dense books: a phone frames far more
    // of the field, smaller; a desktop sits closer. Skeletal books (live
    // quiet hours): the close-up of the queue IS the composition — frame the
    // occupied cluster itself and let the rows become countable bricks.
    // Hysteresis so the regime change is one slow camera breath, not a
    // flicker; the spring makes it presentation either way.
    if (this.skeletal) {
      if (this.touchLevels >= 10) this.skeletal = false;
    } else if (this.touchLevels < 8) {
      this.skeletal = true;
    }
    const spreadTicks = f32[Header.SpreadTicks];
    const spanHint = f32[Header.SpanHintTicks];
    const denseProfile =
      p.layout === 1
        ? { frac: 0.62, minPpt: 2.2, maxPpt: 10 }
        : { frac: 0.76, minPpt: 4.5, maxPpt: 14 };
    let profile = denseProfile;
    let halfSpan = spanHint;
    // A crossed book (external transient) has no meaningful touch cluster to
    // frame — a close-up on its phantom mid frames pure void. Dense
    // standpoint only until it uncrosses.
    if (this.skeletal && spreadTicks > 0) {
      // Frame the occupied cluster itself — but the close-up may only ever
      // stand CLOSER than the dense standpoint (a skeletal book whose few
      // levels still fill the near band keeps today's exact framing). The
      // touch cap inside the camera still guarantees both bests fit.
      // Phone close-up eased after hands-on feedback: monumental two-row
      // bricks read intentional but gave the viewer nothing to explore.
      const close =
        p.layout === 1
          ? { frac: 0.55, minPpt: 2.2, maxPpt: 13 }
          : { frac: 0.5, minPpt: 4.5, maxPpt: 32 };
      const nearHalf = Math.max(this.occupiedHalfSpanTicks * 1.1, spreadTicks * 0.8, 6);
      // Mirror of camera.follow's fit — evaluated for both standpoints so
      // the tighter one wins.
      const fit = (frac: number, min: number, max: number, half: number) =>
        Math.min(Math.max((cssH * frac) / Math.max(half * 2, 12), min), max);
      const pptDense = fit(denseProfile.frac, denseProfile.minPpt, denseProfile.maxPpt, spanHint);
      const pptClose = fit(close.frac, close.minPpt, close.maxPpt, nearHalf);
      if (pptClose > pptDense) {
        profile = close;
        halfSpan = nearHalf;
      }
    }
    this.camera.follow(mid, halfSpan, spreadTicks, cssH, profile);
    this.camera.update(dtMs, nowMs, reduced);

    // Length scale, eased so a shifting distribution rescales gently (scale
    // is presentation). Desktop: the median top-level ORDER reads ~26px —
    // queue segments are the star. Spine (phone): width is scarce, so scale
    // by LEVEL depth instead — a typical top row spans ~62% of the screen;
    // scaling by order size there left every row huddled at the left edge.
    let targetPxPerSat: number;
    if (p.layout === 1) {
      const p80Level = Math.max(f32[Header.CoreLevelP80Sats], 200_000);
      targetPxPerSat = (cssW * 0.62) / p80Level;
    } else if (profile !== denseProfile) {
      // Skeletal close-up: the vertical zoom committed to the queue, so the
      // horizontal scale must follow — a typical touch row reaches ~42% of
      // the frame from the seam instead of floating as a 100px pill. Same
      // truth-sanctioned length lens, wider aperture; never below the dense
      // scale.
      const p80Level = Math.max(f32[Header.CoreLevelP80Sats], 200_000);
      const coreMedian = Math.max(frame.meta.stats.coreMedianSats, 50_000);
      targetPxPerSat = Math.max((cssW * 0.42) / p80Level, 26 / coreMedian);
    } else {
      const coreMedian = Math.max(frame.meta.stats.coreMedianSats, 50_000);
      targetPxPerSat = 26 / coreMedian;
    }
    this.pxPerSat += (targetPxPerSat - this.pxPerSat) * (1 - Math.exp(-dtMs / 900));

    p.centerTick = this.camera.centerTick;
    p.pxPerTick = this.camera.pxPerTick;
    p.pxPerSat = this.pxPerSat;
    p.seamX = p.layout === 0 ? cssW * 0.5 : 10;

    let dim = 0;
    if (this.transitionStartMs > 0) {
      const t = (nowMs - this.transitionStartMs) / 600;
      if (t >= 1) this.transitionStartMs = 0;
      else dim = Math.sin(Math.PI * Math.min(t, 1));
    }

    this.cells.draw(f32, f32[Header.InstanceCount], {
      viewW: cssW, viewH: cssH,
      centerTick: p.centerTick, pxPerTick: p.pxPerTick, pxPerSat: p.pxPerSat,
      seamX: p.seamX, layout: p.layout, minCellPx: 1.5, maxCellPx: cssW * 1.25, dim,
      reduced,
      centerYPx: cssH * (p.centerYFrac ?? 0.5),
      dpr: this.dpr,
      bandTopPx: p.layout === 1 ? 18 : 22,
      bandBottomPx: p.layout === 1 ? 58 : 46,
    });

    this.advanceSprites(nowMs);
    this.spritesGl.draw(this.sprites, cssW, cssH);
    this.overlay.draw(p, this.bestBid, this.bestAsk, 2, this.delegate.chromeAlpha());
  }

  private consumeMeta(frame: HeldFrame, nowMs: number, reduced: boolean): void {
    const meta = frame.meta;
    if (meta.transition !== null) this.transitionStartMs = nowMs;
    this.delegate.onMeta(meta);

    // Spawn the decays of this frame's discrete events. Trades all get drawn
    // — staggered inside the burst so a sweep reads as a run, not a blob.
    let tradeIndex = 0;
    for (const event of meta.events) {
      const p = this.layoutParams;
      const y = tickToY(event.tick, p);
      if (y < -40 || y > p.viewH + 40) continue;
      if (event.kind === "trade") {
        // A heat streak reaching into the consumed side, slow to cool: rapid
        // trades pool into sustained warmth instead of strobing. Size grows
        // with the square root of quantity so glow AREA tracks size — a
        // linear radius would overstate big trades. Direction rides the sign
        // (sprites.ts); in the spine layout everything strikes rightward.
        const makerSide = opposite(event.aggressor);
        const dir = p.layout === 1 ? 1 : makerSide === Side.Bid ? -1 : 1;
        const sizePx = Math.min(8 + Math.sqrt(event.sats * this.pxPerSat) * 1.5, 22);
        this.sprites.push({
          xPx: p.seamX, yPx: y, sizePx: dir * sizePx,
          age01: 0,
          kind: reduced ? SpriteKind.Ring : SpriteKind.Flash,
          tint: event.liquidation ? 2 : event.aggressor === Side.Bid ? 1 : 0,
          delayMs: reduced ? 0 : Math.min(tradeIndex++ * 45, 220),
          bornMs: nowMs,
          lifeMs: reduced ? 1600 : 260,
        });
      } else if (!reduced) {
        const dir = p.layout === 1 ? 1 : event.side === Side.Bid ? -1 : 1;
        const x = p.seamX + dir * (event.aheadSats + event.sats / 2) * this.pxPerSat;
        // Footprint tied to the dead order's real on-screen length — the old
        // +4px floor made dust cancels puff far larger than the cell that
        // vanished.
        this.sprites.push({
          xPx: x, yPx: y,
          sizePx: Math.max(3, Math.min(event.sats * this.pxPerSat, 14)),
          age01: 0,
          kind: SpriteKind.Ghost,
          tint: event.side === Side.Bid ? 0 : 1,
          delayMs: 0, bornMs: nowMs, lifeMs: 150,
        });
      }
    }
    if (this.sprites.length > 480) this.sprites.splice(0, this.sprites.length - 480);
  }

  /**
   * Camera-framing statistics read off the transferred frame: how many
   * occupied levels sit within the near band of the touch, and how far the
   * farthest of them reaches. Purely a standpoint input (presentation) —
   * every number is already in the frame; nothing is invented. Instances
   * are packed per side touch-outward, so distinct ticks arrive in
   * distance order and each side's scan can stop at the band edge; levels
   * beyond the band never widen the close-up (they are the far
   * constellation, left to the viewer's own zoom-out).
   */
  private measureOccupancy(f32: Float32Array): void {
    const count = f32[Header.InstanceCount];
    const mid = f32[Header.MidTick];
    if (mid === 0 || count === 0) return; // keep the last regime while seeding
    const band = Math.max(4 * f32[Header.SpreadTicks], 30);
    let nearBid = 0, nearAsk = 0;
    let bidFirst = 0, bidDeep = 0, askFirst = 0, askDeep = 0;
    let lastBidTick = NaN, lastAskTick = NaN;
    let bidBeyond = false;
    for (let i = 0; i < count; i++) {
      const base = FRAME_HEADER_FLOATS + i * FRAME_STRIDE;
      const tick = f32[base];
      if (f32[base + 3] < 0.5) {
        if (bidBeyond || tick === lastBidTick) continue;
        lastBidTick = tick;
        const dist = mid - tick;
        if (dist <= band) {
          nearBid++;
          if (nearBid === 1) bidFirst = dist;
          if (nearBid <= 3) bidDeep = dist;
        } else {
          bidBeyond = true; // bids descend; nothing nearer follows
        }
      } else {
        if (tick === lastAskTick) continue;
        lastAskTick = tick;
        const dist = tick - mid;
        if (dist <= band) {
          nearAsk++;
          if (nearAsk === 1) askFirst = dist;
          if (nearAsk <= 3) askDeep = dist;
        } else {
          break; // asks ascend; nothing nearer follows
        }
      }
    }
    this.touchLevels = nearBid + nearAsk;
    // Each side contributes its queue FRONT plus breathing room: up to the
    // 3rd in-band level, but never chasing one more than ~8 ticks past the
    // best — the touch is the subject; an in-band stray is already the far
    // constellation and may fall off the close-up (only the bests are
    // guaranteed in frame, by the camera's touch cap).
    this.occupiedHalfSpanTicks = Math.max(
      Math.min(bidDeep, bidFirst + 8),
      Math.min(askDeep, askFirst + 8),
    );
  }

  private advanceSprites(nowMs: number): void {
    for (const s of this.sprites) {
      s.age01 = (nowMs - s.bornMs - s.delayMs) / s.lifeMs;
      if (s.age01 < 0) s.age01 = -1; // waiting for its stagger slot
    }
    this.sprites = this.sprites.filter((s) => s.age01 <= 1);
  }

  /** Dev hook: the latest frame's header and a sample of instances. */
  debugFrame(): { header: number[]; sample: number[][] } | null {
    const f = this.latest;
    if (f === null) return null;
    const header = [...f.f32.slice(0, 8)];
    const count = f.f32[Header.InstanceCount];
    const sample: number[][] = [];
    for (let i = 0; i < Math.min(count, 8); i++) {
      const base = 16 + i * 6;
      sample.push([...f.f32.slice(base, base + 6)]);
    }
    return { header, sample };
  }

  /** p50/p95/p99 over the recent window — the HUD and the recorded numbers. */
  frameStats(): { p50: number; p95: number; p99: number; over16_7: number } {
    const sorted = [...this.frameTimesMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(Math.floor(q * sorted.length), sorted.length - 1)] ?? 0;
    return {
      p50: at(0.5), p95: at(0.95), p99: at(0.99),
      over16_7: this.frameTimesMs.filter((t) => t > 16.7).length,
    };
  }
}
