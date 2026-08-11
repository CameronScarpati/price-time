/**
 * The camera is pure presentation — it decides where you look, never what is
 * there — and it never moves on its own: every motion traces to data (the mid
 * drifting) or to the viewer's hand (zoom, pan). At rest it frames the spread
 * neighborhood; zoomed out it holds the whole nine-thousand-order field.
 *
 * Rules learned from hands-on feedback:
 * - The frame must ALWAYS contain both best bid and best ask while following.
 *   The row-legibility zoom floor once pushed a whole side off a phone screen
 *   when the book was gappy; showing the market beats fat rows, every time.
 * - Panning detaches following explicitly and stays detached until the
 *   viewer recenters (chip, double-tap, Home). A camera that quietly drags
 *   you back mid-exploration feels haunted, not helpful.
 * - The SCALE belongs to whoever touched it last. Auto framing retargets
 *   zoom only through a deadband (the span hint breathes with every book
 *   change; retargeting on each breath made the whole field pump), freezes
 *   entirely while the viewer is panned away, and stops the moment the
 *   viewer zooms — a hand-set scale holds rock-steady until recenter.
 */
export class Camera {
  centerTick = 0;
  pxPerTick = 8;
  /** True after a pan: following is off until the viewer recenters. */
  detached = false;
  /** True after a wheel/pinch: the viewer owns the scale until recenter. */
  scaleHeld = false;
  private heldPpt = 8;
  /** Deadbanded auto scale — the last retarget worth a designed move. */
  private commitPpt = 8;
  private autoPxPerTick = 8;
  private touchCapPpt = Infinity;
  private targetCenter = 0;
  private initialized = false;
  private loTick = 0;
  private hiTick = 0;
  private viewH = 800;

  /** Book extent from the frame header; 0/0 (no data) disables the clamp. */
  setBounds(loTick: number, hiTick: number): void {
    this.loTick = loTick;
    this.hiTick = hiTick;
  }

  /** The viewer may wander a little past the last resting order — 15% of a
   * screen of slack — and no further: beyond that is void in every
   * direction, and below the deepest bid it is soon negative price space.
   * When the whole extent fits the frame, the view pins to the book's
   * middle. Presentation only: a clamp decides where you may stand, never
   * what is there. */
  private clampCenter(tick: number): number {
    if (this.hiTick <= this.loTick) return tick;
    const half = (this.viewH * 0.5) / this.pxPerTick;
    const slack = (this.viewH * 0.15) / this.pxPerTick;
    const lo = this.loTick - slack + half;
    const hi = this.hiTick + slack - half;
    if (lo >= hi) return (this.loTick + this.hiTick) / 2;
    return Math.min(Math.max(tick, lo), hi);
  }

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
    this.viewH = viewH;
    const span = Math.max(halfSpanTicks * 2, 12);
    let ppt = Math.min(Math.max((viewH * profile.frac) / span, profile.minPpt), profile.maxPpt);
    // |spread|: an externally crossed book carries a negative spread, and its
    // displaced bests must STILL both fit the frame — the invariant survives
    // the anomaly by zooming out, never by hiding a side.
    this.touchCapPpt = (viewH * 0.55) / Math.max(Math.abs(spreadTicks) + 12, 12);
    ppt = Math.max(Math.min(ppt, this.touchCapPpt), 0.05);
    this.autoPxPerTick = ppt;
    if (!this.initialized) {
      this.centerTick = midTick;
      this.commitPpt = ppt;
      this.heldPpt = ppt;
      this.pxPerTick = ppt;
      this.initialized = true;
    }
  }

  /** The scale the next frame eases toward, honoring who owns it. */
  private targetScale(): number {
    if (this.scaleHeld) {
      // A hand-set scale holds absolutely while exploring; while following,
      // the both-bests cap still binds (zooming in cannot hide the market).
      return this.detached ? this.heldPpt : Math.min(this.heldPpt, this.touchCapPpt);
    }
    if (this.detached) return this.pxPerTick; // frozen: no unrequested zoom
    // Deadband: the auto fit changes with every book breath; commit to a new
    // scale only when it has drifted far enough to be a designed move. The
    // both-bests invariant bypasses the deadband — it shrinks NOW.
    if (this.commitPpt > this.touchCapPpt) this.commitPpt = this.touchCapPpt;
    else if (Math.abs(this.autoPxPerTick / this.commitPpt - 1) > 0.12) {
      this.commitPpt = this.autoPxPerTick;
    }
    return this.commitPpt;
  }

  /** Advance the camera by `dtMs`. In reduced motion, snap on a slow cadence
   * instead of easing — discrete stillness, not a smeared glide. */
  update(dtMs: number, nowMs: number, reduced: boolean): void {
    if (!this.initialized) return;
    const targetPxPerTick = this.targetScale();

    // Target velocity (EMA), for feed-forward. Clamped so a reseed's price
    // jump can't launch the camera; the transition/spring handles jumps.
    const rawVel = (this.targetCenter - this.prevTarget) / Math.max(dtMs, 1);
    this.prevTarget = this.targetCenter;
    const velCap = 1.5 / Math.max(this.pxPerTick, 0.01);
    this.targetVelTicksPerMs =
      this.targetVelTicksPerMs * 0.85 + Math.min(Math.max(rawVel, -velCap), velCap) * 0.15;

    if (reduced) {
      this.glideDurMs = 0;
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

    // A released pan (or a PageUp/Down leap) is a finite GLIDE to a known,
    // grid-snapped endpoint — ease-out cubic covers the ground fast and
    // LANDS, full stop. The old exponential friction curve was asymptotic
    // and audibly dragged its feet for the last half-second (hands-on).
    if (this.glideDurMs > 0) {
      const t = (nowMs - this.glideStartMs) / this.glideDurMs;
      if (t >= 1) {
        this.centerTick = this.glideToCenter;
        this.glideDurMs = 0;
      } else {
        const e = 1 - (1 - t) * (1 - t) * (1 - t);
        this.centerTick = this.glideFromCenter + (this.glideToCenter - this.glideFromCenter) * e;
      }
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
    // Scale easing: quick under the hand (a laggy zoom feels like syrup),
    // stately when the auto framing recomposes.
    const tauScale = this.scaleHeld ? 180 : 700;
    this.pxPerTick += (targetPxPerTick - this.pxPerTick) * (1 - Math.exp(-dtMs / tauScale));
    // Re-assert the book bounds every frame: zooming out at an extreme can
    // push the edge past the extent even though every pan was clamped.
    if (this.detached) this.centerTick = this.clampCenter(this.centerTick);
  }
  private lastSnapMs = 0;
  private glideStartMs = 0;
  private glideDurMs = 0;
  private glideFromCenter = 0;
  private glideToCenter = 0;
  private prevTarget = 0;
  private targetVelTicksPerMs = 0;
  private transitionStartMs = 0;
  private transitionFromCenter = 0;
  private transitionFromPpt = 0;

  wheelZoom(deltaY: number): void {
    this.holdScale(this.scaleRef() * Math.exp(-deltaY * 0.0012));
  }

  pinchZoom(factor: number): void {
    this.holdScale(this.scaleRef() * factor);
  }

  private scaleRef(): number {
    return this.scaleHeld ? this.heldPpt : this.pxPerTick;
  }

  private holdScale(ppt: number): void {
    this.scaleHeld = true;
    // Absolute bounds: deep enough out to hold the far constellation
    // (fishing orders sit millions of ticks away), close enough in that a
    // single row can fill a third of the screen.
    this.heldPpt = Math.min(Math.max(ppt, 0.0008), 64);
  }

  panTicks(dTicks: number): void {
    this.centerTick = this.clampCenter(this.centerTick + dTicks);
    this.detached = true;
    this.glideDurMs = 0;
  }

  /** Release a pan: plan a finite glide to where the old friction curve
   * would have coasted (v·τ, τ=260ms), snapped to whole ticks when rows are
   * legible. Call on EVERY release — at zero velocity it degrades to a short
   * settle that aligns the field to the grid. Presentation only. */
  fling(ticksPerMs: number): void {
    if (!Number.isFinite(ticksPerMs) || !this.initialized) return;
    this.planGlide(this.centerTick + ticksPerMs * 260, 160, 480);
  }

  /** Leap by a fixed distance (PageUp/Down): same glide, chainable — a rapid
   * second leap extends from the in-flight endpoint, not the current spot. */
  nudge(dTicks: number): void {
    if (!this.initialized) return;
    this.detached = true;
    const base = this.glideDurMs > 0 ? this.glideToCenter : this.centerTick;
    this.planGlide(base + dTicks, 220, 480);
  }

  private planGlide(endTick: number, minDurMs: number, maxDurMs: number): void {
    // A fling into the boundary eases onto it and stops — the clamp shortens
    // the glide's distance, and the ease-out makes the arrival look meant.
    let end = this.clampCenter(endTick);
    // Below ~3px/tick no row grid is discernible — snapping there would just
    // quantize a smooth glide for nothing.
    if (this.pxPerTick >= 3) end = Math.round(end);
    const distPx = Math.abs(end - this.centerTick) * this.pxPerTick;
    if (distPx < 0.5) {
      this.centerTick = end;
      return;
    }
    // Duration scales with distance so short nudges stop near-immediately,
    // capped so a hard flick still resolves in under half a second.
    this.glideDurMs = Math.min(Math.max(distPx * 1.2, minDurMs), maxDurMs);
    this.glideStartMs = performance.now();
    this.glideFromCenter = this.centerTick;
    this.glideToCenter = end;
  }

  /** Return to the market: a finite designed transition, not a spring. */
  recenter(): void {
    this.detached = false;
    this.scaleHeld = false;
    this.glideDurMs = 0;
    this.transitionStartMs = performance.now();
    this.transitionFromCenter = this.centerTick;
    this.transitionFromPpt = this.pxPerTick;
  }
}
