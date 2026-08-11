import { Side, opposite } from "../engine/types";
import { FRAME_BYTES, Header, type FrameMeta, type MainToWorker, type WorkerToMain } from "../worker/protocol";
import { Camera } from "./camera";
import { CellPipeline } from "./gl/cells";
import { PostPipeline } from "./gl/post";
import { SpriteKind, SpritePipeline, type Sprite } from "./gl/sprites";
import { tickToY, type LayoutParams } from "./layout";
import { Overlay } from "./overlay";

const BG: [number, number, number] = [0.039, 0.055, 0.07];

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
    // preserveDrawingBuffer carries the previous frame into this one, so the
    // fade pass can wash it toward the background instead of clearing —
    // ~100ms of phosphor afterglow on everything that moves.
    const gl = canvas.getContext("webgl2", {
      antialias: false, alpha: false, preserveDrawingBuffer: true,
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
    const gl = this.gl;
    const reduced = this.delegate.reducedMotion();
    if (reduced) {
      // Reduced motion gets no afterglow: discrete stillness, not smear.
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      // 0.22: ~70ms afterglow. Longer trails read as flow on a dense field
      // but as grime on a sparse one; this holds up on both.
      this.postFx.fade(BG, 0.22);
    }
    if (frame === null) return;
    if (!frame.consumed) {
      frame.consumed = true;
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
    // A phone frames far more of the field, smaller; a desktop sits closer.
    const profile =
      p.layout === 1
        ? { frac: 0.62, minPpt: 2.2, maxPpt: 10 }
        : { frac: 0.76, minPpt: 4.5, maxPpt: 14 };
    this.camera.follow(mid, f32[Header.SpanHintTicks], f32[Header.SpreadTicks], cssH, profile);
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
    });

    // The membrane: a faint luminous band whose height IS the spread —
    // breathing made barely visible. Skipped when the touch is off-frame.
    if (this.bestBid > 0 && this.bestAsk > 0 && !reduced) {
      const midY = tickToY((this.bestBid + this.bestAsk) / 2, p);
      if (midY > -50 && midY < cssH + 50) {
        const halfH = Math.max((f32[Header.SpreadTicks] * p.pxPerTick) / 2, 3);
        this.postFx.membrane(cssW, cssH, midY, Math.min(halfH, cssH * 0.3),
          p.layout === 0 ? p.seamX : cssW * 0.5, 0.05);
      }
    }

    this.advanceSprites(nowMs);
    this.spritesGl.draw(this.sprites, cssW, cssH);
    this.postFx.vignette(0.22);
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
        const sizePx = Math.min(8 + Math.sqrt(event.sats * this.pxPerSat) * 1.5, 26);
        this.sprites.push({
          xPx: p.seamX, yPx: y, sizePx: dir * sizePx,
          age01: 0,
          kind: reduced ? SpriteKind.Ring : SpriteKind.Flash,
          tint: event.liquidation ? 2 : event.aggressor === Side.Bid ? 1 : 0,
          delayMs: reduced ? 0 : Math.min(tradeIndex++ * 45, 220),
          bornMs: nowMs,
          lifeMs: reduced ? 1600 : 950,
        });
      } else if (!reduced) {
        const dir = p.layout === 1 ? 1 : event.side === Side.Bid ? -1 : 1;
        const x = p.seamX + dir * (event.aheadSats + event.sats / 2) * this.pxPerSat;
        this.sprites.push({
          xPx: x, yPx: y,
          sizePx: Math.min(4 + event.sats * this.pxPerSat * 0.4, 14),
          age01: 0,
          kind: SpriteKind.Ghost,
          tint: event.side === Side.Bid ? 0 : 1,
          delayMs: 0, bornMs: nowMs, lifeMs: 220,
        });
      }
    }
    if (this.sprites.length > 480) this.sprites.splice(0, this.sprites.length - 480);
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
