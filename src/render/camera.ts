/**
 * The camera is pure presentation — it decides where you look, never what is
 * there — and it never moves on its own: every motion traces to data (the mid
 * drifting) or to the viewer's hand (zoom, pan). At rest it frames the spread
 * neighborhood; zoomed out it holds the whole nine-thousand-order field.
 *
 * Two rules learned from hands-on feedback:
 * - The frame must ALWAYS contain both best bid and best ask. The row-
 *   legibility zoom floor once pushed a whole side off a phone screen when
 *   the book was gappy; showing the market beats fat rows, every time.
 * - Panning detaches following explicitly and stays detached until the
 *   viewer recenters (chip, double-tap, Home). A camera that quietly drags
 *   you back mid-exploration feels haunted, not helpful.
 */
export class Camera {
  centerTick = 0;
  pxPerTick = 8;
  /** User zoom multiplier on the auto framing (wheel/pinch). */
  zoom = 1;
  /** True after a pan: following is off until the viewer recenters. */
  detached = false;
  private targetCenter = 0;
  private autoPxPerTick = 8;
  private initialized = false;

  follow(
    midTick: number, halfSpanTicks: number, spreadTicks: number,
    viewH: number,
    profile: { frac: number; minPpt: number; maxPpt: number },
  ): void {
    if (midTick === 0) return;
    this.targetCenter = midTick;
    // Fit the populated neighborhood (worker's span hint) into a fraction of
    // the height, prefer legible rows — but cap so the touch (both bests
    // plus margin) always fits the frame. The profile differs by viewport:
    // a phone frames far more context, smaller (hands-on feedback: default
    // phone framing once felt like staring at three bricks).
    // Floor at 12 ticks so a skeletal book's close-up profile can actually
    // commit to the queue; dense profiles hit their maxPpt long before this
    // floor matters, so their framing is unchanged.
    const span = Math.max(halfSpanTicks * 2, 12);
    let ppt = Math.min(Math.max((viewH * profile.frac) / span, profile.minPpt), profile.maxPpt);
    // |spread|: an externally crossed book carries a negative spread, and its
    // displaced bests must STILL both fit the frame — the invariant survives
    // the anomaly by zooming out, never by hiding a side.
    const touchCap = (viewH * 0.55) / Math.max(Math.abs(spreadTicks) + 12, 12);
    ppt = Math.max(Math.min(ppt, touchCap), 0.05);
    this.autoPxPerTick = ppt;
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
      this.flingTicksPerMs = 0;
      if (nowMs - this.lastSnapMs > 1000) {
        if (!this.detached) this.centerTick = this.targetCenter;
        this.pxPerTick = targetPxPerTick;
        this.lastSnapMs = nowMs;
      }
      return;
    }
    // Fling momentum: a released pan glides out with native-feeling friction
    // instead of stopping dead the frame the finger lifts.
    if (this.flingTicksPerMs !== 0) {
      this.centerTick += this.flingTicksPerMs * dtMs;
      this.flingTicksPerMs *= Math.exp(-dtMs / 260);
      if (Math.abs(this.flingTicksPerMs * this.pxPerTick) < 0.02) this.flingTicksPerMs = 0;
    }
    // The follow spring is slow at rest (the camera is part of the trance)
    // but tightens as the pixel error grows: zoomed to single orders, a
    // quote-to-quote jump is hundreds of pixels, and a dreamy spring there
    // reads as the view sliding long after the market stopped.
    const errPx = Math.abs(this.targetCenter - this.centerTick) * this.pxPerTick;
    const tau = Math.min(Math.max(450 - (errPx - 40) * 1.6, 140), 450);
    const k = 1 - Math.exp(-dtMs / tau);
    if (!this.detached) this.centerTick += (this.targetCenter - this.centerTick) * k;
    this.pxPerTick += (targetPxPerTick - this.pxPerTick) * (1 - Math.exp(-dtMs / 450));
  }
  private lastSnapMs = 0;
  private flingTicksPerMs = 0;

  wheelZoom(deltaY: number): void {
    this.zoom = Math.min(Math.max(this.zoom * Math.exp(-deltaY * 0.0012), 0.0004), 4);
  }

  pinchZoom(factor: number): void {
    this.zoom = Math.min(Math.max(this.zoom * factor, 0.0004), 4);
  }

  panTicks(dTicks: number): void {
    this.centerTick += dTicks;
    this.detached = true;
    this.flingTicksPerMs = 0;
  }

  /** Release a pan with velocity: the glide-out is presentation. */
  fling(ticksPerMs: number): void {
    if (!Number.isFinite(ticksPerMs)) return;
    this.flingTicksPerMs = ticksPerMs;
  }

  /** Snap back to the market: re-attach following and reset zoom. */
  recenter(): void {
    this.detached = false;
    this.zoom = 1;
    this.flingTicksPerMs = 0;
  }
}
