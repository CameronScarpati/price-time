---
name: visual-craft
description: Use when designing or tuning any motion, color, timing, or composition change — the how-it-should-feel companion to truth-rules' what-is-allowed. Motion is this piece's medium; framework-default easing is a bug.
---

# Visual craft

Truth-rules says what may move; this says how to make it excellent. The
feeling of the piece lives entirely in this surface. The target feeling is
HYPNOSIS — zone-out, screensaver gravity — via **event scarcity with calm
pacing** (Listen to Wikipedia is captivating at one bell per second;
machine-gun pops kill the trance) and **a lit, still room** (gradient,
membrane, vignette). Two hard NOs, both owner-verified on real hardware:
NO whole-field persistence/afterglow of any kind (reads as OLED smearing),
and NO lingering event smears (the 950ms heat streaks read as motion blur
and caused literal headache). Crisp field, brief crisp events.

## The frame composition (order matters)

hard clear → static dithered room gradient → cells (soft 0.7px edge feather,
chrome exclusion bands top/bottom) → the membrane (a faint warm/cool band
inside the spread whose height IS the spread; data-driven) → event sprites
(crisp, short) → vignette (static).

## Timing values in use (tuned, not defaulted)

- Trade = a crisp STRIKE: a compact white-hot pulse in the side's hue at the
  queue front, 260ms life, sharp attack, `fade²` decay, no travel and no
  tail. The journey here: round blooms (UFOs) → fast ellipses (weird at
  speed) → 950ms heat streaks (read as motion blur and literally made the
  owner's head hurt). Lingering smears of any kind are OUT — brief crisp
  flashes only. Size ∝ √quantity so glow AREA tracks size; max ~22px.
- Burst stagger: i-th trade in a frame starts at `min(i·45ms, 220ms)`. A sweep
  must read as a RUN up the book, never one merged blob. Never stagger so far
  that event order inverts on screen.
- Cancel sliver: 150ms, row-shaped, alpha ≤0.08 — a sigh, not an event. Cancels
  are 300× more common than trades; at trade-level salience they'd be noise.
- Arrival ramp: 120ms alpha-in via the age channel in the cell shader.
- Age → luminance: flare `mix(base, white, 0.28·(1−age/8s))`, then ember decay
  ×0.4 over ~10min. Mix toward white, never multiply >1 — multiplying clips
  channels and washes amber into yellow-green (we hit this).
- Camera spring: `1−exp(−dt/450ms)` — slow on purpose; the camera is part of
  the trance. Desktop frames the ~4th occupied level (rows 4.5–14px/tick);
  a phone frames roughly twice the context at ~15px median cells (hands-on:
  the phone once felt like staring at three bricks).
- Synthetic pacing is deliberately SLOWER than live's raw message rate
  (makers 9/s, noise 5/s across ~16-tick depth with ~11s lifetimes, takers
  0.22/s): live scatters its churn across thousands of offscreen levels
  while the understudy quotes inside the frame, so matching rates 1:1 reads
  frantic where live reads alive.
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
- The frame ALWAYS contains both best bid and best ask — the camera's touch
  cap guarantees it. Row legibility yields on gappy books (a phone once
  showed only the bid side because the zoom floor won; it must never again).
- On skeletal books the frame caps at a few spreads around the touch
  (max(4·spread, 30) ticks): framing the 4th level hundreds of ticks out
  fills the screen with void. The close-up of the queue IS the composition;
  zoom-out remains the viewer's.
- Spine (phone) scales width by LEVEL depth (p80 top-level total spans ~62%
  of the width); scaling by order size left every row huddled at the left
  edge. Its words (price rules, readout) live on the empty right edge.
- Render at full devicePixelRatio up to 3× — capping at 2 made every modern
  phone visibly soft.
- Panning detaches the camera until the viewer recenters (chip, double-tap,
  Home). Never silently drag the viewer back mid-exploration.
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
