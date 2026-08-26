import {
  FRAME_BYTES, FRAME_HEADER_FLOATS, FRAME_STRIDE, Header,
  type FrameMeta, type MainToWorker, type WorkerToMain,
} from "../worker/protocol";
import { Camera } from "./camera";
import { CellPipeline } from "./gl/cells";
import { PostPipeline } from "./gl/post";
import { snapCenterToDeviceGrid, type LayoutParams } from "./layout";
import { Overlay } from "./overlay";

/**
 * The main-thread renderer: draws the worker's latest frame, owns the two
 * presentation clocks left (the camera's framing and the mode-transition
 * dip), and nothing else — it cannot invent a price, a size, or an
 * ordering, because everything it draws comes out of the transferred frame.
 */

/** The one framing profile, both layouts. See the camera's follow(). maxPpt
 * is a ceiling on how CLOSE the camera may ever stand; the body-of-the-book
 * span normally binds well before it (~7-9 px/tick), and it exists so a
 * four-level book cannot become a close-up of four bricks. */
/** Frame-time history the HUD reports over — ~10s at 60fps. */
const FRAME_TIME_WINDOW = 600;

const BIRDS_EYE = { frac: 0.82, minPpt: 0.05, maxPpt: 8 } as const;

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
  private readonly postFx: PostPipeline;
  private readonly overlay: Overlay;
  readonly camera = new Camera();

  private latest: HeldFrame | null = null;
  /** Which book state the GPU's instance buffer already holds. */
  private uploadedRevision = -1;
  private spare: ArrayBuffer | null = null;
  private requestInFlight = false;

  private pxPerSat = 42 / 8_000_000;
  /** Deadbanded length scale plus the finite move onto it — same contract as
   * the camera's zoom, for the same reason: the median size shifts every
   * frame, and chasing it forever kept every cell's ends re-snapping against
   * the device grid, which is a field that quietly boils. */
  private committedPxPerSat = 42 / 8_000_000;
  private scaleFromPxPerSat = 42 / 8_000_000;
  private scaleMoveStartMs = 0;
  private transitionStartMs = 0;
  private dpr = 1;

  private lastFrameMs = 0;
  /** Frame-time ring for the HUD and the recorded budget numbers. */
  readonly frameTimesMs: number[] = [];
  private frameTimeAt = 0;
  private lastRevision = -1;
  private bookChangedAtMs = 0;
  private lastDrawMs = 0;

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
    // Ring, not push/shift: Array#shift moves every element, and this runs on
    // every frame of a piece that is otherwise doing almost nothing.
    this.frameTimesMs[this.frameTimeAt] = dtMs;
    this.frameTimeAt = (this.frameTimeAt + 1) % FRAME_TIME_WINDOW;

    if (!this.requestInFlight && this.spare !== null) {
      const buffer = this.spare;
      this.spare = null;
      this.requestInFlight = true;
      this.post({ type: "frame", buffer }, [buffer]);
    }

    const frame = this.latest;
    const reduced = this.delegate.reducedMotion();
    if (frame === null) {
      this.drawBackdrop();
      return;
    }
    if (!frame.consumed) {
      frame.consumed = true;
      this.consumeMeta(frame.meta, nowMs);
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
    // One standpoint, always: the bird's eye the worker sized (packer.ts).
    // The bimodal dense/skeletal framing that used to live here is gone —
    // it re-chose how close to stand every time occupancy crossed a
    // threshold, and a standpoint that re-chooses itself is what made the
    // piece feel like it was chasing the market instead of showing it.
    // maxPpt is the whole point: it is a ceiling on how CLOSE the camera may
    // ever stand, so a thin book is a wide frame with space in it, never a
    // close-up of three bricks. minPpt is left far below any real fit so
    // legibility can never argue the frame narrower than the book.
    const spreadTicks = f32[Header.SpreadTicks];
    this.camera.follow(mid, f32[Header.SpanHintTicks], spreadTicks, cssH, BIRDS_EYE);
    this.camera.setBounds(f32[Header.LoTick], f32[Header.HiTick]);
    this.camera.update(dtMs, nowMs, reduced);

    // Length scale (scale is presentation — a lens on real sizes). Desktop:
    // the median top-level ORDER reads ~26px — queue segments are the star.
    // Spine (phone): width is scarce, so scale by LEVEL depth instead — a
    // typical top row spans ~62% of the screen; scaling by order size there
    // left every row huddled at the left edge.
    let targetPxPerSat: number;
    if (p.layout === 1) {
      const p80Level = Math.max(f32[Header.CoreLevelP80Sats], 200_000);
      targetPxPerSat = (cssW * 0.62) / p80Level;
    } else {
      const coreMedian = Math.max(frame.meta.stats.coreMedianSats, 50_000);
      targetPxPerSat = 26 / coreMedian;
    }
    this.advanceLengthScale(targetPxPerSat, nowMs);

    // The camera's own centre stays continuous (the deadband and the glide
    // math need it); what gets DRAWN stands on the device grid, so a pan
    // slides the field in whole pixels instead of smearing every row's edges
    // across them. See snapCenterToDeviceGrid.
    p.centerTick = snapCenterToDeviceGrid(this.camera.centerTick, this.camera.pxPerTick, this.dpr);
    p.pxPerTick = this.camera.pxPerTick;
    p.pxPerSat = this.pxPerSat;
    p.seamX = p.layout === 0 ? cssW * 0.5 : 10;

    let dim = 0;
    if (this.transitionStartMs > 0) {
      const t = (nowMs - this.transitionStartMs) / 600;
      if (t >= 1) this.transitionStartMs = 0;
      else dim = Math.sin(Math.PI * Math.min(t, 1));
    }

    // Is this frame's picture the one already on screen? Every number that
    // reaches a shader is compared; nothing is inferred. A canvas that is not
    // drawn to keeps showing its last presented frame, so skipping here shows
    // the same pixels rather than a stale approximation of them.
    const revision = f32[Header.BookRevision];
    if (revision !== this.lastRevision) {
      this.lastRevision = revision;
      this.bookChangedAtMs = nowMs;
    }
    const alpha = this.delegate.chromeAlpha();
    const same = this.sameAsDrawn(
      revision, f32[Header.InstanceCount],
      p.centerTick, p.pxPerTick, p.pxPerSat, p.seamX, p.layout, p.centerYFrac ?? 0.5,
      p.viewW, p.viewH, this.dpr, dim, reduced ? 1 : 0, alpha,
    );
    // The one thing NOT in that list is the clock, which advances every
    // frame: age drives brightness, so a skipped frame is a frame whose
    // colours are a few milliseconds stale. Two guards keep that invisible.
    // The arrival ramp is the fastest age effect at 120ms, and it only runs
    // on orders that just arrived — which is a book change — so a book that
    // has been still for longer than the ramp has none in flight. Past that,
    // the quickest thing left is the 8s settle, and a tenth of a second of it
    // is under half a percent of luminance.
    const rampQuiet = nowMs - this.bookChangedAtMs > 130;
    const ageFresh = nowMs - this.lastDrawMs < 100;
    if (same && rampQuiet && ageFresh) return;
    this.lastDrawMs = nowMs;

    const fresh = this.uploadedRevision !== revision;
    this.uploadedRevision = revision;
    this.drawBackdrop();
    this.cells.draw(f32, f32[Header.InstanceCount], {
      viewW: cssW, viewH: cssH,
      centerTick: p.centerTick, pxPerTick: p.pxPerTick, pxPerSat: p.pxPerSat,
      seamX: p.seamX, layout: p.layout, minCellPx: 1.5, maxCellPx: cssW * 1.25, dim,
      reduced,
      centerYPx: cssH * (p.centerYFrac ?? 0.5),
      dpr: this.dpr,
      nowSec: frame.meta.nowSec,
      bandTopPx: p.layout === 1 ? 18 : 22,
      bandBottomPx: p.layout === 1 ? 58 : 46,
    }, fresh);

    this.overlay.draw(p, this.bestBid, this.bestAsk, 2, this.delegate.chromeAlpha());
  }

  /** Commit the length scale only when the distribution has really moved,
   * then travel onto it once, finitely, and hold it exactly. */
  private advanceLengthScale(target: number, nowMs: number): void {
    // A very wide deadband, far wider than the camera's: the median
    // top-level order size is a noisy statistic on a thin book, and every
    // commit is 650ms of every cell in the field changing length. Cell
    // lengths only ever have to be right RELATIVE to each other, so being
    // half or double the ideal median is invisible while a field that keeps
    // re-scaling is not. Measured at 45s of the synthetic understudy: the
    // scale moves on under 2% of frames here, against ~10% at 0.3 and every
    // single frame under the old asymptotic ease.
    if (Math.abs(target / this.committedPxPerSat - 1) > 0.5) {
      this.committedPxPerSat = target;
      this.scaleFromPxPerSat = this.pxPerSat;
      this.scaleMoveStartMs = nowMs;
    }
    if (this.scaleMoveStartMs === 0) return;
    const t = (nowMs - this.scaleMoveStartMs) / 650;
    if (t >= 1) {
      this.pxPerSat = this.committedPxPerSat;
      this.scaleMoveStartMs = 0;
      return;
    }
    const e = t * t * t * (t * (6 * t - 15) + 10);
    this.pxPerSat = this.scaleFromPxPerSat + (this.committedPxPerSat - this.scaleFromPxPerSat) * e;
  }

  /** One opaque backdrop draw replaces clear + room + vignette: room gradient
   * and vignette are the same static radial math, and on a 3x 120Hz phone
   * every saved fullscreen pass is real battery. (No phosphor, no
   * persistence — the field is crisp by hard rule; see visual-craft.) */
  private drawBackdrop(): void {
    const isSpine = this.layoutParams.viewW / this.layoutParams.viewH < 0.8;
    this.postFx.backdrop(
      this.layoutParams.viewW, this.layoutParams.viewH,
      isSpine ? 0.28 : 0.3, isSpine ? 0.85 : 1, isSpine ? 1.2 : 1,
    );
  }

  /** Every value that reaches a shader, against the last frame actually
   * drawn. Kept as a flat number list so the comparison allocates nothing on
   * a path that runs sixty times a second. */
  private readonly drawn: number[] = [];
  private sameAsDrawn(...values: number[]): boolean {
    const drawn = this.drawn;
    let same = drawn.length === values.length;
    for (let i = 0; i < values.length; i++) {
      if (drawn[i] !== values[i]) same = false;
      drawn[i] = values[i];
    }
    return same;
  }

  /** A new worker frame's metadata: the UI's cue, and the mode-transition
   * dip's start. Discrete events no longer spawn anything to draw — a trade
   * is visible as the bar it consumed getting shorter, and a cancel as the
   * cell going; both are the book itself changing, not an effect over it. */
  private consumeMeta(meta: FrameMeta, nowMs: number): void {
    if (meta.transition !== null) this.transitionStartMs = nowMs;
    this.delegate.onMeta(meta);
  }

  /** Dev hook: the latest frame's header and a sample of instances. */
  debugFrame(): { header: number[]; sample: number[][] } | null {
    const f = this.latest;
    if (f === null) return null;
    const header = [...f.f32.slice(0, FRAME_HEADER_FLOATS)];
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
