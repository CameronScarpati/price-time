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

  /** Advance the camera by `dtMs`. In reduced motion, snap on a slow cadence
   * instead of easing — discrete stillness, not a smeared glide. */
  update(dtMs: number, nowMs: number, reduced: boolean): void {
    if (!this.initialized) return;
    const targetPxPerTick = this.autoPxPerTick * this.zoom;

    // Target velocity (EMA), for feed-forward. Clamped so a reseed's price
    // jump can't launch the camera; the transition/spring handles jumps.
    const rawVel = (this.targetCenter - this.prevTarget) / Math.max(dtMs, 1);
    this.prevTarget = this.targetCenter;
    const velCap = 1.5 / Math.max(this.pxPerTick, 0.01);
    this.targetVelTicksPerMs =
      this.targetVelTicksPerMs * 0.85 + Math.min(Math.max(rawVel, -velCap), velCap) * 0.15;

    if (reduced) {
      this.flingTicksPerMs = 0;
      this.transitionStartMs = 0;
      if (nowMs - this.lastSnapMs > 1000) {
        if (!this.detached) this.centerTick = this.targetCenter;
        this.pxPerTick = targetPxPerTick;
        this.lastSnapMs = nowMs;
      }
      return;
    }

    // A recenter is a finite, designed transition — smootherstep over 650ms
    // that lands ON the (still-moving) target and ends, rather than an
    // asymptotic spring that covers the distance fast and then audibly
    // crawls the last forty pixels. Center and zoom travel together, so the
    // return never reads as a skip between two mismatched motions.
    if (this.transitionStartMs > 0) {
      const t = (nowMs - this.transitionStartMs) / 650;
      if (t >= 1) {
        this.transitionStartMs = 0;
        this.centerTick = this.targetCenter;
        this.pxPerTick = targetPxPerTick;
      } else {
        const e = t * t * t * (t * (6 * t - 15) + 10);
        this.centerTick = this.transitionFromCenter + (this.targetCenter - this.transitionFromCenter) * e;
        this.pxPerTick = this.transitionFromPpt + (targetPxPerTick - this.transitionFromPpt) * e;
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

    if (!this.detached) {
      // Feed-forward: move WITH the market's current drift, then let the
      // spring correct only the residual. A bare spring trails a moving
      // target by (speed × its time constant) — the "camera towed behind a
      // running market" feel — and feed-forward removes exactly that lag.
      this.centerTick += this.targetVelTicksPerMs * dtMs;
      // The residual spring stays slow at rest (the trance) and tightens as
      // pixel error grows, so quote-to-quote jumps at single-order zoom
      // snap into frame.
      const errPx = Math.abs(this.targetCenter - this.centerTick) * this.pxPerTick;
      const tau = Math.min(Math.max(450 - (errPx - 20) * 1.8, 120), 450);
      this.centerTick += (this.targetCenter - this.centerTick) * (1 - Math.exp(-dtMs / tau));
    }
    this.pxPerTick += (targetPxPerTick - this.pxPerTick) * (1 - Math.exp(-dtMs / 450));
  }
  private lastSnapMs = 0;
  private flingTicksPerMs = 0;
  private prevTarget = 0;
  private targetVelTicksPerMs = 0;
  private transitionStartMs = 0;
  private transitionFromCenter = 0;
  private transitionFromPpt = 0;

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

  /** Return to the market: a finite designed transition, not a spring. */
  recenter(): void {
    this.detached = false;
    this.zoom = 1;
    this.flingTicksPerMs = 0;
    this.transitionStartMs = performance.now();
    this.transitionFromCenter = this.centerTick;
    this.transitionFromPpt = this.pxPerTick;
  }
}
