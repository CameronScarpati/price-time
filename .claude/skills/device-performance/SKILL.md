---
name: device-performance
description: Use when measuring or optimizing frame time, worker cost, or bundle size — and before believing ANY performance number produced in an emulator, headless browser, or this build sandbox.
---

# Real-device performance measurement

## Why the sandbox lies

This repo's build environment renders through SwiftShader (software GL) in
headless Chromium: frame times of 100ms+ there say nothing about real GPUs —
instanced quads that crawl in software raster are trivial for any phone GPU of
the last decade. Desktop DevTools throttling also does not model mobile GPU,
memory bandwidth, or thermals. **Numbers from emulation are not evidence and
must not be quoted against the budgets.**

## The budgets (design.md §8)

p99 ≤ 16.7ms over a ≥5-minute soak on a mid-range phone (Pixel 6a class /
iPhone SE class); zero >50ms long frames in steady state; 2,000 events/s with
zero dropped trade prints; ≤150KB gzip JS; <2s to first motion on 4G; <150MB
heap; zero steady-state per-frame allocation.

## How to measure

1. **On-device HUD**: open the deployed page with `?hud=1` on the real phone.
   It shows live p50/p95/p99 over the last 600 frames and the count over
   16.7ms, computed from rAF deltas — the exact numbers the budget names.
2. **Duration**: watch ≥5 minutes. Thermal throttling arrives after the first
   comfortable minute; a 30-second sample is a lie of omission. Record the
   percentiles at minute 1 and minute 5.
3. **Percentiles, not means**: jank lives at p95/p99. A 16.6ms mean with 80ms
   p99 stutters visibly.
4. **Ground truth below the browser** when needed: Android
   `adb shell dumpsys gfxinfo <package>` / Perfetto FrameTimeline; iOS Xcode
   Instruments (Core Animation). Long Animation Frames API
   (`PerformanceObserver({type:"long-animation-frame"})`) attributes >50ms
   main-thread stalls.
5. **Worker cost** is measurable anywhere Node runs:
   `npx vitest run test/perf/pack-bench.test.ts` — packFrame on the real
   8.7k-order fixture book (0.873ms at last record; >4ms fails the test).
6. **Bundle**: `pnpm build` prints gzip sizes; budget is the sum of JS.
7. **Work not done**: `?hud=1` reports `packs/s` against the ~60 frames a
   second the renderer requests. An unchanged book costs nothing — no pack, no
   upload, and when presentation is also still, at most one draw a second
   (the ember's age still advances, by about a third of an 8-bit step a
   second). If that number sits
   at 60 on a quiet market, something is deriving a per-frame value into the
   packed frame and the skip has stopped working.

## Load synthesis

For burst behavior, force synthetic mode with a hot calibration:
`?mode=synthetic&seed=1` and temporarily raise `takersPerSec`/excitation in
`QUIET_BTCUSD` (do not commit the hot values). Every trade must still reach
the worker's detectors, tape and trade stats (they are never dropped, even
though nothing is drawn from them), the book must coalesce to one repaint
per frame, and the HUD must hold budget through the burst.

## Recording results

Write measured numbers (device, date, percentiles, duration) into the README's
performance section. A missed budget is stated there as missed — never quietly
relaxed. If real-device numbers don't exist yet for a change, say so; absence
of evidence is a recordable fact.
