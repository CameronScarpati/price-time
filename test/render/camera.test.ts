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

describe("camera scale ownership", () => {
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
