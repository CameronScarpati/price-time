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
 *   lands where it planned to and ends. It fires when the mid has stayed
 *   past the deadband for half a second, when the committed scale changes,
 *   or when the viewer asks to recenter — never continuously, never a
 *   little bit every frame, and never for a blip: a sweep that empties the
 *   touch and refills a few packs later is not a place the market went.
 * - The frame must contain both best bid and best ask while following, once
 *   a widening has held for half a second. The row-legibility zoom floor
 *   once pushed a whole side off a phone screen when the book was gappy;
 *   showing the market beats fat rows, every time. A crossed pack is not
 *   framed at all (see follow()).
 * - Panning detaches following explicitly and stays detached until the
 *   viewer recenters (chip, double-tap, Home). A camera that quietly drags
 *   you back mid-exploration feels haunted, not helpful.
 * - The SCALE belongs to whoever touched it last. Auto framing retargets
 *   zoom only through a deadband (the span hint breathes with every book
 *   change; retargeting on each breath made the whole field pump), freezes
 *   entirely while the viewer is panned away, and stops the moment the
 *   viewer zooms — a hand-set scale holds rock-steady until recenter. The
 *   both-bests cap may only ever TIGHTEN a hand-set scale, never hand it
 *   back: a cap that followed the spread both ways pumped the field.
 */

/** How far off centre the market may drift, as a fraction of the viewport
 * height, before the frame is worth redrawing. Wide framing makes this cheap:
 * a tenth of the screen is many ticks of drift, so on a quiet market the
 * camera can hold one position for minutes. */
const REFRAME_DEADBAND_FRAC = 0.1;
/** A designed move: long enough to read as intent, short enough to be over. */
const TRANSITION_MS = 650;
/** How long the frame must stay out of date before it moves, and how long a
 * wider spread must hold before the both-bests cap tightens for it. A sweep
 * that empties the touch jumps the mid and widens the spread for a pack or
 * two; a move started on that chased a target that snapped back mid-flight
 * (measured on a phone: reversals and one-frame jumps of 40 and 181 device
 * px), and a hand-set zoom tightened for it stayed tightened for good. */
const REFRAME_HOLD_MS = 500;

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
  /** The both-bests cap the camera honours: it lifts at once and tightens
   * only for a spread that has held (REFRAME_HOLD_MS). */
  private touchCapPpt = Infinity;
  /** The cap the latest pack asks for. */
  private rawCapPpt = Infinity;
  private capTightSinceMs: number | null = null;
  private capPending = 0;
  /** The uncapped bird's-eye fit for the latest pack. */
  private fitPpt = 8;
  /** When the mid first went past the deadband; null while inside it. */
  private driftSinceMs: number | null = null;
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
    // A crossed pack (spread < 0) is not a frame to stand on. Live flow
    // crosses for a message at a time — an aggressive order rests at its
    // limit until the fills behind it land — and one such pack moved the mid
    // ~1,151 ticks and collapsed the touch cap; in reduced motion that was a
    // one-frame whole-field zoom cut and back. No crossed book is worth a
    // move: keep the last target, in both modes. On live, a crossing that
    // persists means the reconstruction is wrong and the pipeline reseeds it
    // (~8s); a replayed capture has no such guard, so a crossed stretch of a
    // recording holds the last frame until it uncrosses.
    if (spreadTicks < 0) return;
    this.targetCenter = midTick;
    // Fit the worker's bird's-eye span into a fraction of the height. The
    // profile's maxPpt is a ceiling on how CLOSE the camera may stand, so a
    // book smaller than the frame sits inside it with room around it rather
    // than being zoomed up to fill it. The touch cap still binds on top:
    // both bests fit, whatever the span says (settleCap has the timing).
    this.viewH = viewH;
    const span = Math.max(halfSpanTicks * 2, 12);
    this.fitPpt = Math.min(Math.max((viewH * profile.frac) / span, profile.minPpt), profile.maxPpt);
    this.rawCapPpt = (viewH * 0.55) / (spreadTicks + 12);
    if (!this.initialized) {
      // The first frame has nothing to hold against.
      this.touchCapPpt = this.rawCapPpt;
      const ppt = Math.max(Math.min(this.fitPpt, this.touchCapPpt), 0.05);
      this.autoPxPerTick = ppt;
      this.centerTick = midTick;
      this.commitPpt = ppt;
      this.heldPpt = ppt;
      this.pxPerTick = ppt;
      this.initialized = true;
    }
  }

  /** Settle the both-bests cap for this frame. A narrower spread lifts it at
   * once: lifting forces no motion (a held scale never follows it up, and
   * the auto path answers only through its deadband). A wider one tightens
   * it only once it has held for REFRAME_HOLD_MS, and then to the loosest
   * cap seen over that stretch — the widening that actually persisted. */
  private settleCap(nowMs: number): void {
    const raw = this.rawCapPpt;
    if (raw >= this.touchCapPpt) {
      this.touchCapPpt = raw;
      this.capTightSinceMs = null;
      return;
    }
    if (this.capTightSinceMs === null) {
      this.capTightSinceMs = nowMs;
      this.capPending = raw;
    } else {
      this.capPending = Math.max(this.capPending, raw);
    }
    if (nowMs - this.capTightSinceMs >= REFRAME_HOLD_MS) {
      this.touchCapPpt = this.capPending;
      this.capTightSinceMs = null;
    }
  }

  /** The scale the frame stands at, honoring who owns it. */
  private targetScale(): number {
    if (this.scaleHeld) {
      // A hand-set scale holds absolutely while exploring; while following,
      // the both-bests cap still binds (zooming in cannot hide the market) —
      // but only downward, and it is written INTO the held scale. The old
      // min(held, cap) re-read the raw spread every frame and the eased
      // scale chased each breath (measured: 34% peak-to-peak, 865 of 1680
      // frames moving). Tighten-only means the view zooms out once when a
      // wider spread has held long enough to force it, never zooms back in
      // on its own, and is exactly still in between.
      if (!this.detached && this.heldPpt > this.touchCapPpt) this.heldPpt = this.touchCapPpt;
      return this.heldPpt;
    }
    if (this.detached) return this.pxPerTick; // frozen: no unrequested zoom
    // Deadband: the auto fit changes with every book breath; commit to a new
    // scale only when it has drifted far enough to be a designed move. The
    // both-bests invariant bypasses the deadband — once the cap has settled
    // (settleCap), it shrinks NOW.
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
    this.settleCap(nowMs);
    this.autoPxPerTick = Math.max(Math.min(this.fitPpt, this.touchCapPpt), 0.05);
    const targetPxPerTick = this.targetScale();

    // Is the frame out of date? Only two things can make it so while
    // following: the market has walked past the deadband and STAYED there
    // for REFRAME_HOLD_MS, or the committed scale has changed under it.
    // Neither is checked while the viewer's own glide is in flight — their
    // hand outranks the market.
    if (!this.detached && this.transitionStartMs === 0 && this.glideDurMs === 0) {
      const offPx = Math.abs(this.targetCenter - this.centerTick) * this.pxPerTick;
      if (offPx > this.viewH * REFRAME_DEADBAND_FRAC) this.driftSinceMs ??= nowMs;
      else this.driftSinceMs = null;
      const drifted = this.driftSinceMs !== null && nowMs - this.driftSinceMs >= REFRAME_HOLD_MS;
      // A HAND-set scale is not the framing's business: it has its own short
      // ease below, and routing it through a 650ms designed move would make
      // the wheel feel like syrup.
      const scaleStale = !this.scaleHeld && Math.abs(targetPxPerTick / this.pxPerTick - 1) > 0.005;
      if (drifted || scaleStale) this.beginTransition(nowMs);
    } else {
      this.driftSinceMs = null;
    }

    if (reduced) {
      // Cut, not dropped: a planned glide (PageUp/Down, a released drag)
      // lands on its endpoint this frame. Clearing it without landing it
      // made PageUp/Down do nothing at all but detach.
      if (this.glideDurMs > 0) {
        this.centerTick = this.glideToCenter;
        this.glideDurMs = 0;
      }
      if (this.transitionStartMs > 0) {
        this.transitionStartMs = 0;
        this.centerTick = this.targetCenter;
      }
      this.pxPerTick = targetPxPerTick;
      if (this.detached) this.centerTick = this.clampCenter(this.centerTick);
      return;
    }

    // The one automatic move: smootherstep over 650ms to an endpoint fixed
    // when it starts, and then it ENDS — rather than an asymptotic spring
    // that covers the distance fast and then audibly crawls the last forty
    // pixels. The endpoint does not follow the market in flight: a move that
    // chased a target jumping under it reversed and, near its end, jumped
    // the whole field in one frame. If the market has moved on by the time
    // it lands, the deadband decides afresh. Centre and zoom travel
    // together, so a reframe never reads as a skip between two mismatched
    // motions — unless the hand owns the scale: then the centre finishes its
    // one move and the zoom keeps its own short ease below. (Cancelling the
    // move on every wheel event restarted it from rest each time, so a
    // wheeling hand made the centre stall.)
    if (this.transitionStartMs > 0) {
      if (!this.transitionPlanned) {
        this.transitionToCenter = this.targetCenter;
        this.transitionToPpt = targetPxPerTick;
        this.transitionPlanned = true;
      }
      const t = (nowMs - this.transitionStartMs) / TRANSITION_MS;
      const moveScale = !this.scaleHeld;
      if (t >= 1) {
        this.transitionStartMs = 0;
        this.centerTick = this.transitionToCenter;
        if (moveScale) this.pxPerTick = this.transitionToPpt;
      } else {
        const e = t * t * t * (t * (6 * t - 15) + 10);
        this.centerTick = this.transitionFromCenter + (this.transitionToCenter - this.transitionFromCenter) * e;
        if (moveScale) this.pxPerTick = this.transitionFromPpt + (this.transitionToPpt - this.transitionFromPpt) * e;
      }
      if (moveScale) return;
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
  private transitionToCenter = 0;
  private transitionToPpt = 0;
  /** False until the first update() of a move has fixed its endpoint. */
  private transitionPlanned = false;

  private beginTransition(nowMs: number): void {
    this.glideDurMs = 0;
    this.driftSinceMs = null;
    this.transitionStartMs = nowMs;
    this.transitionFromCenter = this.centerTick;
    this.transitionFromPpt = this.pxPerTick;
    this.transitionPlanned = false;
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
    // The hand outranks the market, as with a pan: a leap cancels an
    // in-flight reframe rather than queueing behind it and then jumping to
    // an endpoint planned from where the reframe began.
    this.transitionStartMs = 0;
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
