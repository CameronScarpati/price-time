---
name: visual-craft
description: Use when designing or tuning any motion, color, timing, or composition change — the how-it-should-feel companion to truth-rules' what-is-allowed. This piece is still, wide, and sharp; adding motion is the change that needs defending, not removing it.
---

# Visual craft

Truth-rules says what may move; this says how to make it excellent. The
feeling of the piece lives entirely in this surface.

**The target feeling is STILLNESS.** A wide, held, sharp field you can look
INTO — a print you can stare at, not a screensaver that performs. Motion was
the medium once and is not any more: the piece asked for attention constantly
and got tuned, and tuned, and was still restless. The owner's verdict, on
hardware, after five versions of the trade flash: *"this piece should be
still, wide, and sharp. Motion is not the medium anymore. When in doubt,
remove animation rather than tune it."* That is the standing instruction, and
it beats every timing value below.

So the default answer to "should this move?" is **no**. The bar for adding
motion is that you can name the market event it belongs to AND say why the
book changing under it is not already enough. Removing motion needs no
defense at all — it cannot cost truth, because a thing that does not move
asserts nothing.

Three hard NOs remain, all owner-verified on real hardware, and a fourth
joins them: NO whole-field persistence/afterglow of any kind (reads as OLED
smearing), NO lingering event smears (950ms heat streaks read as motion blur
and caused literal headache), NO glow behind the field (the spread membrane,
even scissored and edge-faded, read as a stray beam of light) — and NO event
flash of any kind. Not softened, not gated, not brief. Gone.

## What is actually animated now (the whole list)

1. **The arrival ramp.** ~120ms alpha-in via the age channel in the cell
   shader, so a new cell does not pop into a field of settled ones.
2. **The camera's designed move.** 650ms smootherstep, centre and zoom
   together, fired only when the mid walks past a tenth of the viewport or
   the committed zoom changes. It lands and ends.
3. **The length scale's designed move.** The same 650ms, behind a very wide
   (0.5) deadband.
4. **The viewer's own glides.** Released pan, arrow-key travel, PageUp/Down
   leap: finite ease-out cubic, 160–480ms by distance, landing on the tick
   grid.
5. **The mode cross-fade.** 600ms sine luminance dip; the label changes
   first.
6. **Chrome fade.** ~200ms in on engagement, out after 4s idle.

That is the list. If a change adds a seventh, it needs the owner's word.

## Asymptotic easing is a bug here, not a taste

This is the hard-won mechanical rule behind the stillness, and it is easy to
reintroduce by accident. Every cell edge — left, right, top, bottom — snaps to
the DEVICE pixel grid in `cells.ts`. That is why the field is sharp. It also
means any value that eases exponentially toward a target never arrives, so
the field creeps by a fraction of a pixel forever and each row re-snaps a
whole device pixel at its own moment. The field boils, worst exactly while
the view is moving — and it reads as a frame-rate problem, which it is not.

Therefore: **nothing on the render path may ease asymptotically.** Either
travel a finite curve that ends on its target, or hold the value exactly.
`1 - exp(-dt/tau)` without a settle is the bug. Deadband first (do not commit
to a new target at all until it is a real change), then move once, then hold.

## Timing and framing values in use (tuned, not defaulted)

- Camera: bird's-eye. The frame holds the book's own extent, bounded by
  5e-5 of the mid price so the far constellation (asks past $21M, bids at a
  cent) cannot squash the market into a line. One profile for both layouts;
  `maxPpt` 4 is a ceiling on how CLOSE it may stand, so a thin book is a
  wide frame with space in it, never a close-up of three bricks.
- Reframe deadband: a tenth of the viewport height. Measured at 45s of the
  synthetic understudy, that is about one designed move per axis per 45s and
  ~96% of frames writing nothing at all. If a change makes that number worse,
  it is a regression whatever it looks like in a still.
- Auto-zoom deadband 12%; length-scale deadband 0.5 (lengths only have to be
  right relative to each other, and the median top-level size is noisy on a
  thin book).
- Age → luminance: flare `mix(base, white, 0.28·(1−age/8s))`, then ember decay
  ×0.4 over ~10min. Mix toward white, never multiply >1 — multiplying clips
  channels and washes amber into yellow-green (we hit this).
- The rAF loop renders at ≤60fps even on ProMotion: a mostly-still field gains
  nothing from 120Hz that is worth double the fill rate.
- Synthetic pacing is deliberately SLOWER than live's raw message rate
  (makers 9/s, noise 5/s across ~16-tick depth with ~11s lifetimes, takers
  0.22/s): live scatters its churn across thousands of offscreen levels
  while the understudy quotes inside the frame, so matching rates 1:1 reads
  frantic where live reads alive.

## The frame composition (order matters)

backdrop (room gradient + vignette folded into ONE opaque fullscreen pass —
it replaces the clear; every saved fullscreen pass is battery on a 3x 120Hz
phone) → cells (soft 0.7px edge feather, chrome exclusion bands top/bottom).
That is the whole frame. Nothing draws between backdrop and cells, and
nothing draws over the cells: the event sprite layer that used to sit there
is deleted, and the spread gap is empty room whose breathing is carried by
the cells' edges alone.

## Color discipline

Bids `#43AFF5` (blue), asks `#FFAA47` (amber), liquidation violet, background
`#0A0E12` (deep ink, never pure black). Side is always position + hue, never
hue alone (CVD). Age is luminance only. Do not add a third hue without a
domain meaning and an explainer entry. There is no white in the palette any
more — white was the flash.

## Composition rules

- The spread gap is the piece's center of gravity: at rest it sits mid-screen,
  breathing. Anything that competes with it must earn the attention.
- The frame ALWAYS contains both best bid and best ask — the camera's touch
  cap guarantees it. Row legibility yields on gappy books (a phone once
  showed only the bid side because the zoom floor won; it must never again).
- The standpoint does not re-choose itself. One profile, always. The
  dense/skeletal bimodal framing that used to switch on occupancy is deleted:
  a camera that changes its mind about how close to stand is a camera that
  looks like it is chasing.
- Empty space is the market being thin — leave it. Filling it is decoration,
  and so is zooming in until it goes away.
- Spine (phone) scales width by LEVEL depth (p80 top-level total spans ~62%
  of the width); scaling by order size left every row huddled at the left
  edge. Its words (price rules, readout) live on the empty right edge.
- Render at full devicePixelRatio up to 3× — capping at 2 made every modern
  phone visibly soft.
- Panning detaches the camera until the viewer recenters (chip, double-tap,
  Home). Never silently drag the viewer back mid-exploration.
- Travel is bounded by the book: the viewer may wander 15% of a screen past
  the last resting order and no further — beyond that is void in every
  direction (and below the deepest bid, soon negative price space). A fling
  into the boundary eases onto it; when the whole extent fits the frame the
  view pins to the book's middle.
- Edges are anti-aliased in DEVICE pixels (~0.8) and snapped to the device
  grid on all four sides. A CSS-pixel feather is dpr× device pixels of blur
  — on a 3x phone it made every box read faintly soft (owner-verified).
- Desktop = seam (two-sided, fronts meeting at the price axis); phone = spine
  (full-width rows, front at left). Same cells, two layouts — change both or
  neither, and keep `layout.ts` (CPU) in lockstep with `cells.ts` (shader).
- Wordless at rest: no numbers, no axes until engagement. The provenance line
  is the only standing text.

## Reduced motion is a second piece, not an absence

The gap has narrowed to almost nothing now that the piece itself is still:
the same designed moves happen, cut instead of eased, and the arrival ramp is
a whisper (0.1) rather than a fade. It should feel like a stiller sibling,
not a broken one — and "stiller than this" is now a fine hair. Test it every
time motion changes: `page.emulateMedia({ reducedMotion: "reduce" })` or the
OS toggle.

## Judging a change

Watch a full minute on desktop and on a narrow viewport (tools/screenshot.mjs
gives all three states). Ask: is anything moving that you cannot name the
event for? Does the frame hold — can you look at one row for ten seconds
without it shifting under you? Would you notice the change was reverted? If
not, drop it. And the version of that question that now decides most calls:
**would you notice if this animation were simply deleted?** If the answer is
"barely", delete it.
