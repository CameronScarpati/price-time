/**
 * The camera is pure presentation — it decides where you look, never what is
 * there — and it never moves on its own: every motion traces to data (the mid
 * drifting) or to the viewer's hand (zoom, pan). At rest it frames the spread
 * neighborhood; zoomed out it holds the whole nine-thousand-order field.
 */
export class Camera {
  centerTick = 0;
  pxPerTick = 8;
  /** User zoom multiplier on the auto framing (wheel/pinch). */
  zoom = 1;
  /** While the viewer is panning we stop following; then we drift back. */
  private freeUntilMs = 0;
  private targetCenter = 0;
  private autoPxPerTick = 8;
  private initialized = false;

  follow(midTick: number, halfSpanTicks: number, viewH: number, nowMs: number): void {
    if (midTick === 0) return;
    this.targetCenter = midTick;
    // Fit the populated neighborhood (worker's span hint) into ~76% of
    // height — but never let default framing push rows below legibility
    // (~2px): on a scattered book, showing fewer levels beats hairlines.
    // The user's own zoom-out can still go all the way to the whole field.
    const span = Math.max(halfSpanTicks * 2, 24);
    this.autoPxPerTick = Math.min(Math.max((viewH * 0.76) / span, 4.5), 14);
    if (!this.initialized) {
      this.centerTick = midTick;
      this.pxPerTick = this.autoPxPerTick * this.zoom;
      this.initialized = true;
    }
  }

  /** Advance the spring by `dtMs`. In reduced motion, snap on a slow cadence
   * instead of easing — discrete stillness, not a smeared glide. */
  update(dtMs: number, nowMs: number, reduced: boolean): void {
    if (!this.initialized) return;
    const targetPxPerTick = this.autoPxPerTick * this.zoom;
    if (reduced) {
      if (nowMs - this.lastSnapMs > 1000) {
        this.centerTick = this.targetCenter;
        this.pxPerTick = targetPxPerTick;
        this.lastSnapMs = nowMs;
      }
      return;
    }
    const following = nowMs > this.freeUntilMs;
    const k = 1 - Math.exp(-dtMs / 280);
    if (following) this.centerTick += (this.targetCenter - this.centerTick) * k;
    this.pxPerTick += (targetPxPerTick - this.pxPerTick) * k;
  }
  private lastSnapMs = 0;

  wheelZoom(deltaY: number): void {
    this.zoom = Math.min(Math.max(this.zoom * Math.exp(-deltaY * 0.0012), 0.0004), 4);
  }

  pinchZoom(factor: number): void {
    this.zoom = Math.min(Math.max(this.zoom * factor, 0.0004), 4);
  }

  panTicks(dTicks: number, nowMs: number): void {
    this.centerTick += dTicks;
    this.freeUntilMs = nowMs + 5000;
  }
}
