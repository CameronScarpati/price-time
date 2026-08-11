import { formatDecimal } from "../sources/bitstamp/decimal";
import { tickToY, type LayoutParams } from "./layout";

/**
 * The Canvas 2D chrome layer: price ticks along the seam and the mid/spread
 * readout inside the gap. Wordless at rest — everything here fades in with
 * engagement and back out with idleness (the alpha is handed in by the UI).
 */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
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

    // Price rules at a step that keeps labels ≥ 56px apart.
    const stepTicks = niceStep(56 / p.pxPerTick);
    const topTick = p.centerTick + (p.viewH / 2) / p.pxPerTick;
    const bottomTick = p.centerTick - (p.viewH / 2) / p.pxPerTick;
    const first = Math.ceil(bottomTick / stepTicks) * stepTicks;
    ctx.strokeStyle = "rgba(148, 163, 184, 0.10)";
    ctx.fillStyle = "rgba(148, 163, 184, 0.65)";
    ctx.textBaseline = "bottom";
    for (let tick = first; tick <= topTick; tick += stepTicks) {
      const y = tickToY(tick, p);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(p.viewW, y);
      ctx.stroke();
      const label = formatDecimal(tick, priceDecimals);
      if (p.layout === 0) {
        ctx.textAlign = "center";
        ctx.fillText(label, p.seamX, y - 2);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(label, 6, y - 2);
      }
    }

    // The gap readout: the mid and the living spread.
    const midY = tickToY((bestBid + bestAsk) / 2, p);
    const spread = bestAsk - bestBid;
    ctx.textAlign = p.layout === 0 ? "center" : "left";
    ctx.textBaseline = "middle";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
    const x = p.layout === 0 ? p.seamX : 8;
    ctx.fillText(
      `${formatDecimal(Math.round((bestBid + bestAsk) / 2), priceDecimals)}  ·  spread ${formatDecimal(spread, priceDecimals)}`,
      x, midY,
    );
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
