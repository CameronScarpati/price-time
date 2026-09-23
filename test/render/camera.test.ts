import { describe, expect, it } from "vitest";
import { Camera } from "../../src/render/camera";

/**
 * Two contracts, both about ENDINGS. The released-pan glide is a promise to
 * the hand: a finite motion that LANDS on the tick grid and stops, rather
 * than an asymptotic coast that drags its feet. And the frame itself is
 * still by default — between designed moves the camera writes nothing at
 * all, because a field that creeps by a fraction of a pixel re-snaps every
 * cell edge against the device grid and boils. These tests pin the landings
 * and the stillness, not the easing curves — the curve is presentation
 * taste; the endpoint is the contract.
 */

const PROFILE = { frac: 0.5, minPpt: 4.5, maxPpt: 32 };
/** The both-bests cap at an 800px viewport, computed as the camera does. */
const cap = (spread: number): number => (800 * 0.55) / (spread + 12);

function primed(): Camera {
  const cam = new Camera();
  cam.follow(10_000, 30, 2, 800, PROFILE);
  cam.update(16, performance.now(), false);
  return cam;
}

/** Half a second: how long a drift or a wider spread must hold, as in the camera. */
const HOLD_MS = 500;

function runFrames(cam: Camera, frames: number): void {
  let now = performance.now();
  for (let i = 0; i < frames; i++) {
    now += 16;
    cam.update(16, now, false);
  }
}

describe("camera released-pan glide", () => {
  it("a flick lands exactly on a whole tick and stays there", () => {
    const cam = primed();
    cam.panTicks(-25.3);
    cam.fling(0.37);
    runFrames(cam, 60); // ~1s: well past the 480ms duration cap
    expect(Number.isInteger(cam.centerTick)).toBe(true);
    const landed = cam.centerTick;
    runFrames(cam, 30);
    expect(cam.centerTick).toBe(landed); // stopped means STOPPED
  });

  it("a zero-velocity release settles onto the grid", () => {
    const cam = primed();
    cam.panTicks(-25.3); // centerTick now 9974.7
    cam.fling(0);
    runFrames(cam, 30);
    expect(cam.centerTick).toBe(9975);
  });

  it("panning mid-glide cancels the glide", () => {
    const cam = primed();
    cam.panTicks(-25.3);
    cam.fling(0.37);
    runFrames(cam, 2);
    cam.panTicks(5);
    const held = cam.centerTick;
    runFrames(cam, 30);
    expect(cam.centerTick).toBe(held);
  });
});

describe("camera scale ownership and book bounds", () => {
  it("holds a hand-set zoom against changing auto framing", () => {
    const cam = primed();
    cam.wheelZoom(600); // zoom well out
    runFrames(cam, 60);
    const settled = cam.pxPerTick;
    // The book breathes: span hint and spread churn frame to frame.
    let now = performance.now() + 16 * 62;
    for (let i = 0; i < 90; i++) {
      now += 16;
      cam.follow(10_000, 30 + (i % 7) * 9, 2 + (i % 3), 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(Math.abs(cam.pxPerTick / settled - 1)).toBeLessThan(0.01);
  });

  it("a held zoom past the both-bests cap tightens once, then holds exactly still through the spread's breath", () => {
    const cam = primed();
    cam.wheelZoom(-2000); // deep in: the hand-set scale sits far above the cap
    // Whole-tick spreads breathing 2 <-> 4 on a 192ms period: slow enough
    // that a scale chasing the raw cap would visibly move with it. (A flip
    // every frame hid exactly that pump: the 180ms zoom ease averaged it.)
    // Every stretch at 4 lasts 96ms, under the hold, so the cap the camera
    // honours is the spread that persists: 2.
    const spreadAt = (i: number): number => (Math.floor(i / 6) % 2 === 0 ? 2 : 4);
    let now = performance.now() + 16;
    for (let i = 0; i < 120; i++) {
      now += 16;
      cam.follow(10_000, 30, spreadAt(i), 800, PROFILE);
      cam.update(16, now, false);
    }
    // The one tighten: down to the persisting spread's cap, 440 / (2 + 12).
    expect(cam.pxPerTick).toBe(cap(2));
    const seen = new Set<number>();
    for (let i = 120; i < 360; i++) {
      now += 16;
      cam.follow(10_000, 30, spreadAt(i), 800, PROFILE);
      cam.update(16, now, false);
      seen.add(cam.pxPerTick);
    }
    // Not "within a percent" — one value, every frame.
    expect([...seen]).toEqual([cap(2)]);
  });

  it("a one-pack spread spike cannot tighten a held zoom for good", () => {
    // Replayed live flow: 4.64 px/tick held, then one sweep's 218-tick
    // spread for a pack or two, and the tighten-only cap kept the view at
    // 2.06 px/tick for the rest of the session.
    const cam = primed();
    cam.wheelZoom(-2000);
    let now = performance.now() + 16;
    const run = (spread: number, frames: number): void => {
      for (let i = 0; i < frames; i++) {
        now += 16;
        cam.follow(10_000, 30, spread, 800, PROFILE);
        cam.update(16, now, false);
      }
    };
    run(2, 120);
    expect(cam.pxPerTick).toBe(cap(2));
    run(218, 3); // 48ms: a sweep, refilled
    run(2, 120);
    expect(cam.pxPerTick).toBe(cap(2));
  });

  it("a held zoom's both-bests cap tightens when the spread widens and never releases on its own", () => {
    const cam = primed();
    cam.wheelZoom(-2000);
    let now = performance.now() + 16;
    const run = (spread: number, frames: number): void => {
      for (let i = 0; i < frames; i++) {
        now += 16;
        cam.follow(10_000, 30, spread, 800, PROFILE);
        cam.update(16, now, false);
      }
    };
    // The cap binds: held 64 ppt, cap 440/14 ~ 31.4.
    run(2, 120);
    expect(cam.pxPerTick).toBe(cap(2));
    // Widen: both bests must keep fitting, so the held scale shrinks.
    run(20, 120);
    expect(cam.pxPerTick).toBe(cap(20));
    // Narrow: the cap lifts, but the scale is the hand's, tightened — the
    // camera does not zoom back in by itself.
    run(1, 120);
    expect(cam.pxPerTick).toBe(cap(20));
  });

  it("a hand on the zoom mid-reframe does not restart the move: the centre lands on time", () => {
    const cam = primed();
    let now = performance.now() + 16;
    // The market walks 30 ticks out (past the 80px band at ~6.7 px/tick) and
    // stays; after the hold (frame 33) the move begins.
    for (let i = 0; i < 33; i++) {
      now += 16;
      cam.follow(10_030, 30, 2, 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(cam.centerTick).toBe(10_000);
    let prev = cam.pxPerTick;
    // The viewer wheels out a notch on EVERY frame of the move.
    for (let i = 0; i < 41; i++) {
      now += 16;
      cam.follow(10_030, 30, 2, 800, PROFILE);
      cam.wheelZoom(40);
      cam.update(16, now, false);
      // The hand's zoom answers every event: never flat across a wheel.
      expect(cam.pxPerTick).toBeLessThan(prev);
      prev = cam.pxPerTick;
    }
    // 41 frames x 16ms = 656ms after the move began: one 650ms move, landed.
    // Cancelling on each wheel event restarted it from rest every frame and
    // the centre did not move at all while the hand was on the wheel.
    expect(cam.centerTick).toBe(10_030);
  });

  it("a PageUp/Down leap during a reframe cancels it rather than jumping at its end", () => {
    const cam = primed();
    let now = performance.now() + 16;
    for (let i = 0; i < 33; i++) {
      now += 16;
      cam.follow(10_030, 30, 2, 800, PROFILE);
      cam.update(16, now, false); // the drift holds; the reframe begins
    }
    now += 160;
    cam.update(16, now, false);
    const partway = cam.centerTick;
    expect(partway).toBeGreaterThan(10_000);
    expect(partway).toBeLessThan(10_030);
    cam.nudge(-20);
    const seen: number[] = [partway];
    let t = performance.now();
    for (let i = 0; i < 60; i++) {
      t += 16;
      cam.follow(10_030, 30, 2, 800, PROFILE);
      cam.update(16, t, false);
      seen.push(cam.centerTick);
    }
    expect(cam.centerTick).toBe(Math.round(partway - 20));
    // One direction only: the leap, never a leg back toward the market.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
  });

  it("freezes auto zoom while detached", () => {
    const cam = primed();
    cam.panTicks(-400); // wander away, no zoom touched
    const scale = cam.pxPerTick;
    let now = performance.now() + 32;
    for (let i = 0; i < 90; i++) {
      now += 16;
      cam.follow(10_000, 30 + (i % 7) * 9, 2 + (i % 3), 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(cam.pxPerTick).toBe(scale);
  });

  it("ignores auto-framing breath inside the deadband while following", () => {
    const cam = primed();
    runFrames(cam, 30);
    const settled = cam.pxPerTick;
    let now = performance.now() + 16 * 32;
    for (let i = 0; i < 90; i++) {
      now += 16;
      // ±5% span wobble: inside the 12% deadband, so no retarget.
      cam.follow(10_000, 30 * (1 + 0.05 * Math.sin(i)), 2, 800, PROFILE);
      cam.update(16, now, false);
    }
    // Not "close to" — identical. The deadband's job is that nothing is
    // written at all, so the device-grid snap never re-fires.
    expect(cam.pxPerTick).toBe(settled);
  });

  it("holds the frame absolutely still while the market drifts inside the deadband", () => {
    const cam = primed();
    runFrames(cam, 10);
    const center = cam.centerTick;
    const ppt = cam.pxPerTick;
    // Deadband is 10% of the 800px viewport = 80px; at ~6.7 px/tick that is
    // ~12 ticks of drift. Walk the mid 9 ticks over a second of frames.
    let now = performance.now() + 16 * 11;
    for (let i = 0; i < 60; i++) {
      now += 16;
      cam.follow(10_000 + i * 0.15, 30, 2, 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(cam.centerTick).toBe(center);
    expect(cam.pxPerTick).toBe(ppt);
  });

  it("answers a walk out of the deadband with one finite move, then stillness", () => {
    const cam = primed();
    runFrames(cam, 10);
    let now = performance.now() + 16 * 11;
    for (let i = 0; i < 80; i++) {
      now += 16;
      cam.follow(10_030, 30, 2, 800, PROFILE); // 30 ticks out: past the band
      cam.update(16, now, false);
    }
    // Landed exactly on the market, not asymptotically near it.
    expect(cam.centerTick).toBe(10_030);
    // And then it is over: no residual creep toward anything.
    for (let i = 0; i < 60; i++) {
      now += 16;
      cam.follow(10_030, 30, 2, 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(cam.centerTick).toBe(10_030);
  });

  it("cuts rather than eases the same move in reduced motion", () => {
    const cam = primed();
    runFrames(cam, 10);
    const t = performance.now() + 16 * 12;
    cam.follow(10_030, 30, 2, 800, PROFILE);
    cam.update(16, t, true);
    expect(cam.centerTick).toBe(10_000); // not yet: a drift must hold
    cam.follow(10_030, 30, 2, 800, PROFILE);
    cam.update(16, t + HOLD_MS + 1, true);
    expect(cam.centerTick).toBe(10_030); // then one frame, not 650ms
  });

  it("never frames a blip: a mid that jumps out and back within the hold moves nothing", () => {
    // A sweep empties the touch and refills a few packs later; the mid
    // jumps ~9 ticks for 100ms. Framing that started a move toward a target
    // that had already gone home.
    for (const reduced of [false, true]) {
      const cam = primed();
      let now = performance.now() + 16;
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        now += 16;
        const blip = i % 50 < 6; // 96ms out, every 800ms
        cam.follow(blip ? 10_030 : 10_000, 30, blip ? 23 : 2, 800, PROFILE);
        cam.update(16, now, reduced);
        seen.add(cam.centerTick);
        seen.add(cam.pxPerTick * 1e9);
      }
      expect(seen.size).toBe(2); // one centre, one scale, every frame
    }
  });

  it("a move lands where it planned to, even when the market jumps in flight, then moves again", () => {
    const cam = primed();
    let now = performance.now() + 16;
    const path: number[] = [];
    let begun = -1;
    for (let i = 0; i < 200; i++) {
      now += 16;
      if (begun < 0 && cam.centerTick !== 10_000) begun = i;
      // Out to 10_030 and held; mid-move the market jumps on to 10_060.
      const mid = begun >= 0 && i >= begun + 20 ? 10_060 : 10_030;
      cam.follow(mid, 30, 2, 800, PROFILE);
      cam.update(16, now, false);
      path.push(cam.centerTick);
    }
    // The first move ends exactly on its own endpoint...
    expect(path).toContain(10_030);
    // ...and the second finishes on the market.
    expect(path[path.length - 1]).toBe(10_060);
    // One direction only, and no frame steps further than smootherstep's
    // steepest 16ms of a 30-tick, 650ms move (1.875 x 30 x 16/650 ~ 1.38).
    for (let i = 1; i < path.length; i++) {
      expect(path[i]).toBeGreaterThanOrEqual(path[i - 1]);
      expect(path[i] - path[i - 1]).toBeLessThanOrEqual(1.39);
    }
  });

  it("cuts PageUp/Down and a released drag in reduced motion instead of dropping them", () => {
    const cam = primed();
    let now = performance.now();
    cam.nudge(-50);
    cam.update(16, (now += 16), true);
    expect(cam.centerTick).toBe(9_950); // the leap, in one frame
    cam.nudge(-50); // chains from where the last one landed
    cam.update(16, (now += 16), true);
    expect(cam.centerTick).toBe(9_900);
    cam.panTicks(-25.3); // 9874.7
    cam.fling(0.37); // would coast ~96 ticks
    cam.update(16, (now += 16), true);
    expect(cam.centerTick).toBe(9_971); // landed, on the tick grid
  });

  it("a crossed pack does not move the frame, in either motion mode", () => {
    for (const reduced of [false, true]) {
      const cam = new Camera();
      let now = performance.now();
      cam.follow(10_000, 30, 2, 800, PROFILE);
      cam.update(16, now, reduced);
      const center = cam.centerTick;
      const ppt = cam.pxPerTick;
      // A real fixture moment: one pack crossed by 2,302 ticks, its mid
      // 1,151 ticks away. |spread| would have collapsed the touch cap to
      // ~0.19 px/tick — in reduced motion, a one-frame whole-field cut.
      cam.follow(11_151, 30, -2_302, 800, PROFILE);
      cam.update(16, (now += 16), reduced);
      expect(cam.centerTick).toBe(center);
      expect(cam.pxPerTick).toBe(ppt);
      // Uncrossed again: nothing to undo, and no move was started.
      for (let i = 0; i < 60; i++) {
        cam.follow(10_000, 30, 2, 800, PROFILE);
        cam.update(16, (now += 16), reduced);
        expect(cam.centerTick).toBe(center);
        expect(cam.pxPerTick).toBe(ppt);
      }
    }
  });

  it("a crossed pack cannot ratchet a held zoom out", () => {
    const cam = primed();
    cam.wheelZoom(-2000);
    let now = performance.now() + 16;
    const run = (mid: number, spread: number, frames: number): void => {
      for (let i = 0; i < frames; i++) {
        now += 16;
        cam.follow(mid, 30, spread, 800, PROFILE);
        cam.update(16, now, false);
      }
    };
    run(10_000, 2, 120);
    expect(cam.pxPerTick).toBe(cap(2));
    // Tighten-only would keep a cap this deep forever; the pack is ignored.
    run(11_151, -2_302, 1);
    run(10_000, 2, 120);
    expect(cam.pxPerTick).toBe(cap(2));
  });

  it("clamps panning a little past the deepest order, no further", () => {
    const cam = primed();
    cam.setBounds(9_900, 10_100);
    cam.panTicks(-1e6);
    // Bottom edge stops 15% of a screen past the deepest order.
    const half = 400 / cam.pxPerTick;
    const slack = 120 / cam.pxPerTick;
    expect(cam.centerTick).toBeCloseTo(9_900 - slack + half, 6);
    cam.panTicks(1e6);
    expect(cam.centerTick).toBeCloseTo(10_100 + slack - half, 6);
  });

  it("a fling into the boundary eases onto it and stops", () => {
    const cam = primed();
    cam.setBounds(9_900, 10_100);
    cam.panTicks(-40);
    cam.fling(-3); // a hard downward flick, far past the extent
    runFrames(cam, 60);
    const lo = 9_900 - 120 / cam.pxPerTick + 400 / cam.pxPerTick;
    expect(Math.abs(cam.centerTick - lo)).toBeLessThan(1);
    const rest = cam.centerTick;
    runFrames(cam, 20);
    expect(cam.centerTick).toBe(rest);
  });

  it("pins to the book middle when the whole extent fits the frame", () => {
    const cam = primed();
    cam.setBounds(9_950, 10_050);
    cam.wheelZoom(4000); // far out: view span dwarfs the book extent
    runFrames(cam, 120);
    cam.panTicks(500);
    expect(cam.centerTick).toBe(10_000);
  });

  it("recenter restores auto framing after a hand-set zoom", () => {
    const cam = primed();
    runFrames(cam, 60);
    const autoScale = cam.pxPerTick;
    cam.wheelZoom(600);
    runFrames(cam, 60);
    expect(cam.pxPerTick).toBeLessThan(autoScale * 0.6);
    cam.recenter();
    runFrames(cam, 80); // through the 650ms transition
    expect(Math.abs(cam.pxPerTick / autoScale - 1)).toBeLessThan(0.05);
  });
});
