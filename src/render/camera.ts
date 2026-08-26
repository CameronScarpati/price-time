/**
 * The camera is pure presentation — it decides where you look, never what is
 * there — and it never moves on its own: every motion traces to data (the
 * market leaving the frame) or to the viewer's hand (zoom, pan). It frames
 * the book from a bird's eye and, above all, it HOLDS STILL.
 *
 * Rules learned from hands-on feedback:
 * - Stillness is the default state, not a resting point a spring approaches.
 *   While following, `centerTick` and `pxPerTick` are not written at all
 *   between designed moves. The old feed-forward-plus-spring pair meant the
 *   field was always creeping by a fraction of a pixel, and since every cell
 *   edge snaps to the device grid (cells.ts), each row re-snapped a whole
 *   device pixel at its own moment: the field boiled, worst exactly while
 *   the view was moving.
 * - There is exactly ONE automatic move: a finite 650ms transition that
 *   lands on the market and ends. It fires when the mid has drifted past the
 *   deadband, when the committed scale changes, or when the viewer asks to
 *   recenter — never continuously, never a little bit every frame.
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

/** How far off centre the market may drift, as a fraction of the viewport
 * height, before the frame is worth redrawing. Wide framing makes this cheap:
 * a tenth of the screen is many ticks of drift, so on a quiet market the
 * camera can hold one position for minutes. */
const REFRAME_DEADBAND_FRAC = 0.1;
/** A designed move: long enough to read as intent, short enough to be over. */
const TRANSITION_MS = 650;

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
    // Fit the worker's bird's-eye span into a fraction of the height. The
    // profile's maxPpt is a ceiling on how CLOSE the camera may stand, so a
    // book smaller than the frame sits inside it with room around it rather
    // than being zoomed up to fill it. The touch cap still binds on top:
    // both bests fit, always, whatever the span says.
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

  /** The scale the frame stands at, honoring who owns it. */
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

  /** Advance the camera by `dtMs`. In reduced motion the designed moves are
   * cut rather than eased — the same decisions, without the travel. */
  update(dtMs: number, nowMs: number, reduced: boolean): void {
    if (!this.initialized) return;
    const targetPxPerTick = this.targetScale();

    // Is the frame out of date? Only two things can make it so while
    // following: the market has walked past the deadband, or the committed
    // scale has changed under it. Neither is checked while the viewer's own
    // glide is in flight — their hand outranks the market.
    if (!this.detached && this.transitionStartMs === 0 && this.glideDurMs === 0) {
      const offPx = Math.abs(this.targetCenter - this.centerTick) * this.pxPerTick;
      // A HAND-set scale is not the framing's business: it has its own short
      // ease below, and routing it through a 650ms designed move would make
      // the wheel feel like syrup.
      const scaleStale = !this.scaleHeld && Math.abs(targetPxPerTick / this.pxPerTick - 1) > 0.005;
      if (offPx > this.viewH * REFRAME_DEADBAND_FRAC || scaleStale) {
        this.beginTransition(nowMs);
      }
    }

    if (reduced) {
      this.glideDurMs = 0;
      if (this.transitionStartMs > 0) {
        this.transitionStartMs = 0;
        this.centerTick = this.targetCenter;
      }
      this.pxPerTick = targetPxPerTick;
      if (this.detached) this.centerTick = this.clampCenter(this.centerTick);
      return;
    }

    // The one automatic move: smootherstep over 650ms that lands ON the
    // (still-moving) target and ENDS, rather than an asymptotic spring that
    // covers the distance fast and then audibly crawls the last forty
    // pixels. Centre and zoom travel together, so a reframe never reads as a
    // skip between two mismatched motions.
    if (this.transitionStartMs > 0) {
      const t = (nowMs - this.transitionStartMs) / TRANSITION_MS;
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

    // Zoom under the hand stays a short ease — a laggy pinch feels like
    // syrup — but it SETTLES: an asymptote never arrives, and every frame it
    // fails to arrive re-snaps every cell edge against the device grid.
    if (this.scaleHeld && this.pxPerTick !== targetPxPerTick) {
      this.pxPerTick += (targetPxPerTick - this.pxPerTick) * (1 - Math.exp(-dtMs / 180));
      if (Math.abs(targetPxPerTick / this.pxPerTick - 1) < 0.001) this.pxPerTick = targetPxPerTick;
    }
    // Re-assert the book bounds every frame: zooming out at an extreme can
    // push the edge past the extent even though every pan was clamped.
    if (this.detached) this.centerTick = this.clampCenter(this.centerTick);
  }
  private glideStartMs = 0;
  private glideDurMs = 0;
  private glideFromCenter = 0;
  private glideToCenter = 0;
  private transitionStartMs = 0;
  private transitionFromCenter = 0;
  private transitionFromPpt = 0;

  private beginTransition(nowMs: number): void {
    this.glideDurMs = 0;
    this.transitionStartMs = nowMs;
    this.transitionFromCenter = this.centerTick;
    this.transitionFromPpt = this.pxPerTick;
  }

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
    // A hand on the zoom cancels an in-flight reframe: the viewer's scale is
    // the one being eased toward now, not the framing's.
    this.transitionStartMs = 0;
    // Absolute bounds: deep enough out to hold the far constellation
    // (fishing orders sit millions of ticks away), close enough in that a
    // single row can fill a third of the screen.
    this.heldPpt = Math.min(Math.max(ppt, 0.0008), 64);
  }

  panTicks(dTicks: number): void {
    this.centerTick = this.clampCenter(this.centerTick + dTicks);
    this.detached = true;
    this.glideDurMs = 0;
    this.transitionStartMs = 0;
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

  /** Return to the market: the same finite designed transition a reframe
   * uses, so the way back looks like the way the frame moves on its own. */
  recenter(): void {
    this.detached = false;
    this.scaleHeld = false;
    this.beginTransition(performance.now());
  }
}
