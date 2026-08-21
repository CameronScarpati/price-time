import { describe, expect, it } from "vitest";
import { Camera } from "../../src/render/camera";

/**
 * The released-pan glide is a promise to the hand: a finite motion that LANDS
 * on the tick grid and stops, rather than an asymptotic coast that drags its
 * feet. These tests pin the landing, not the easing curve — the curve is
 * presentation taste; the endpoint is the contract.
 */

const PROFILE = { frac: 0.5, minPpt: 4.5, maxPpt: 32 };

function primed(): Camera {
  const cam = new Camera();
  cam.follow(10_000, 30, 2, 800, PROFILE);
  cam.update(16, performance.now(), false);
  return cam;
}

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

  it("a held zoom past the both-bests cap does not pump with the spread's breath", () => {
    const cam = primed();
    cam.wheelZoom(-2000); // deep in: the hand-set scale sits far above the cap
    let now = performance.now() + 16;
    for (let i = 0; i < 60; i++) {
      now += 16;
      cam.follow(10_000, 30, 2 + 0.5 * (i % 2), 800, PROFILE);
      cam.update(16, now, false);
    }
    const settled = cam.pxPerTick;
    // The spread breathes every frame. The audited defect: min(held, rawCap)
    // retargeted on each breath and the whole field pumped ~5%. The
    // deadbanded cap must hold the scale still through the same breathing.
    const seen: number[] = [];
    for (let i = 0; i < 120; i++) {
      now += 16;
      cam.follow(10_000, 30, 2 + 0.5 * (i % 2), 800, PROFILE);
      cam.update(16, now, false);
      seen.push(cam.pxPerTick);
    }
    expect(Math.max(...seen) / Math.min(...seen) - 1).toBeLessThan(0.005);
    expect(Math.abs(cam.pxPerTick / settled - 1)).toBeLessThan(0.01);
  });

  it("the deadbanded cap still tightens instantly and releases on a real narrowing", () => {
    const cam = primed();
    cam.wheelZoom(-2000);
    let now = performance.now() + 16;
    for (let i = 0; i < 60; i++) {
      now += 16;
      cam.follow(10_000, 30, 2, 800, PROFILE);
      cam.update(16, now, false);
    }
    // The cap binds: held 64 ppt, cap 440/14 ~ 31.4.
    expect(cam.pxPerTick).toBeGreaterThan(30);
    expect(cam.pxPerTick).toBeLessThan(32);
    // Widen: both bests must keep fitting NOW — no deadband on the way down.
    for (let i = 0; i < 40; i++) {
      now += 16;
      cam.follow(10_000, 30, 20, 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(cam.pxPerTick).toBeLessThan(15);
    // Narrow far past the deadband: a designed release, more zoom allowed.
    for (let i = 0; i < 80; i++) {
      now += 16;
      cam.follow(10_000, 30, 0.5, 800, PROFILE);
      cam.update(16, now, false);
    }
    expect(cam.pxPerTick).toBeGreaterThan(30);
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
    expect(Math.abs(cam.pxPerTick / settled - 1)).toBeLessThan(0.02);
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
