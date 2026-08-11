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
