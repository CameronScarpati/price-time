import { formatDecimal } from "../sources/bitstamp/decimal";
import { tickToY, type LayoutParams } from "./layout";

/**
 * The Canvas 2D chrome layer: price ticks along the seam and the mid/spread
 * readout inside the gap. Wordless at rest — everything here fades in with
 * engagement and back out with idleness (the alpha is handed in by the UI).
 */

/** Matches the room pass's center tone: text etches over cells, not through. */
const HALO = "rgba(10, 14, 18, 0.92)";
/** Top chrome band (controls) and bottom band (provenance): labels never
 * enter them — three text layers at one y read like dirt behind glass. */
const TOP_BAND = 48;
const BOTTOM_BAND = 26;

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(
    p: LayoutParams,
    bestBid: number,
    bestAsk: number,
    priceDecimals: number,
    alpha: number,
  ): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, p.viewW, p.viewH);
    if (alpha <= 0.01 || bestBid === 0 || bestAsk === 0) return;
    ctx.globalAlpha = alpha;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.lineJoin = "round";

    // Price rules at a step that keeps labels ≥ 56px apart.
    const stepTicks = niceStep(56 / p.pxPerTick);
    const frac = p.centerYFrac ?? 0.5;
    const topTick = p.centerTick + (p.viewH * frac) / p.pxPerTick;
    const bottomTick = p.centerTick - (p.viewH * (1 - frac)) / p.pxPerTick;
    const first = Math.ceil(bottomTick / stepTicks) * stepTicks;
    ctx.fillStyle = "rgba(148, 163, 184, 0.65)";
    ctx.textBaseline = "bottom";
    for (let tick = first; tick <= topTick; tick += stepTicks) {
      const y = tickToY(tick, p);
      // The top chrome band is the buttons' room: a rule + label ghosting
      // through the translucent chrome reads as three stacked text layers.
      if (y < TOP_BAND) continue;
      // Snap hairlines to the device grid so their weight stops varying
      // with subpixel phase (labels keep their exact y — text is its own
      // antialiasing; a ≤0.5px rule snap is presentation).
      const ys = (Math.round(y * this.dpr - 0.5) + 0.5) / this.dpr;
      ctx.strokeStyle = "rgba(148, 163, 184, 0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ys);
      ctx.lineTo(p.viewW, ys);
      ctx.stroke();
      // The provenance band keeps its rule but not the label.
      if (y > p.viewH - BOTTOM_BAND) continue;
      const label = formatDecimal(tick, priceDecimals);
      let lx: number;
      if (p.layout === 0) {
        // Each tick's guaranteed-empty quadrant: at ask ticks no cell can
        // rest left of the seam, at bid ticks none right of it. The dead
        // quadrants become the label gutter instead of striking through
        // queue fronts.
        if (tick >= bestAsk) {
          ctx.textAlign = "right";
          lx = p.seamX - 8;
        } else if (tick <= bestBid) {
          ctx.textAlign = "left";
          lx = p.seamX + 8;
        } else {
          ctx.textAlign = "center";
          lx = p.seamX;
        }
      } else {
        // Spine rows grow from the left, so words live on the right edge —
        // labels over the cells read as strikethroughs.
        ctx.textAlign = "right";
        lx = p.viewW - 6;
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = HALO;
      ctx.strokeText(label, lx, y - 2);
      ctx.fillText(label, lx, y - 2);
    }

    // The gap readout: the mid and the living spread. When the gap is
    // tighter than the text (live BTC/USD, most of the time) it moves to the
    // right edge instead of stamping across the best-ask cells.
    const midY = tickToY((bestBid + bestAsk) / 2, p);
    const spread = bestAsk - bestBid;
    // Visible gap = spread minus the touch rows' own height (cells.ts rowH):
    // at deep zoom a 1-tick spread is 1px of dark, not pxPerTick worth.
    const rowH = p.pxPerTick >= 3 ? Math.max(p.pxPerTick - 1, 2.6) : p.pxPerTick * 0.86;
    const gapPx = spread * p.pxPerTick - rowH;
    ctx.textBaseline = "middle";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    let rx: number;
    if (p.layout === 0 && gapPx >= 18) {
      ctx.textAlign = "center";
      rx = p.seamX;
    } else {
      ctx.textAlign = "right";
      rx = p.viewW - 8;
    }
    const readout =
      `${formatDecimal(Math.round((bestBid + bestAsk) / 2), priceDecimals)}  ·  spread ${formatDecimal(spread, priceDecimals)}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = HALO;
    ctx.strokeText(readout, rx, midY);
    ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
    ctx.fillText(readout, rx, midY);
    ctx.globalAlpha = 1;
  }
}

/** 1-2-5 ladder: the smallest "round" step not below `minTicks`. */
function niceStep(minTicks: number): number {
  let step = 1;
  for (;;) {
    for (const m of [1, 2, 5]) {
      if (step * m >= minTicks) return step * m;
    }
    step *= 10;
  }
}
