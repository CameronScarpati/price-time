---
name: visual-craft
description: Use when designing or tuning any motion, color, timing, or composition change — the how-it-should-feel companion to truth-rules' what-is-allowed. Motion is this piece's medium; framework-default easing is a bug.
---

# Visual craft

Truth-rules says what may move; this says how to make it excellent. The
feeling of the piece lives entirely in this surface.

## Timing values in use (tuned, not defaulted)

- Trade flash: 420ms life, decay `fade²` (hot core cools into the side's hue);
  radius grows ~0.9× over life. Radius ∝ √quantity so glow AREA tracks size —
  linear radius overstates big trades (area perception is compressive).
- Burst stagger: i-th trade in a frame starts at `min(i·45ms, 220ms)`. A sweep
  must read as a RUN up the book, never one merged blob. Never stagger so far
  that event order inverts on screen.
- Cancel puff: 260ms, small, cool, alpha ≤0.16 — a sigh, not an event. Cancels
  are 300× more common than trades; at trade-level salience they'd be noise.
- Arrival ramp: 120ms alpha-in via the age channel in the cell shader.
- Age → luminance: flare `mix(base, white, 0.28·(1−age/8s))`, then ember decay
  ×0.4 over ~10min. Mix toward white, never multiply >1 — multiplying clips
  channels and washes amber into yellow-green (we hit this).
- Camera spring: `1−exp(−dt/280ms)` — settles in ~1s, never overshoots.
- Mode cross-fade: 600ms sine luminance dip; label changes before the dip.
- Chrome: fades in over ~200ms on engagement, out after 4s idle.

## Color discipline

Bids `#43AFF5` (blue), asks `#FFAA47` (amber), liquidation violet, flash
white-hot, background `#0A0E12` (deep ink, never pure black). Side is always
position + hue, never hue alone (CVD). Age is luminance only. Do not add a
third hue without a domain meaning and an explainer entry.

## Composition rules

- The spread gap is the piece's center of gravity: at rest it sits mid-screen,
  breathing. Anything that competes with it must earn the attention.
- Desktop = seam (two-sided, fronts meeting at the price axis); phone = spine
  (full-width rows, front at left). Same cells, two layouts — change both or
  neither, and keep `layout.ts` (CPU) in lockstep with `cells.ts` (shader).
- Wordless at rest: no numbers, no axes until engagement. The provenance line
  is the only standing text.
- Empty space is the market being thin — leave it. Filling it is decoration.

## Reduced motion is a second piece, not an absence

Springs → 1s snaps; flashes → slow quiet rings (1.6s); no arrival flare beyond
a whisper (0.1); captions appear/disappear without slide. It should feel like
a stiller sibling, not a broken one. Test it every time motion changes:
`page.emulateMedia({ reducedMotion: "reduce" })` or the OS toggle.

## Judging a change

Watch a full minute on desktop and on a narrow viewport (tools/screenshot.mjs
gives all three states). Ask: does the first glance still land in 3 seconds?
Does a burst read as texture or noise? Does anything move that you cannot name
the event for? Would you notice the change was reverted? If not, drop it —
motion that isn't earning attention is spending it.
