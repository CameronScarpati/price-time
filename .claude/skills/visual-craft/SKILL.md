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

1. **The arrival ramp.** ~120ms alpha-in (from 0.3) via the age channel in
   the cell shader, so a new cell does not pop into a field of settled ones.
   It is alpha only: an arrival is never brighter than its neighbors. A
   seeded order did not arrive, so it is packed past the ramp
   (`packedRestedAtSec` in `pipeline.ts`) and a reseed does not fade the
   whole field in.
2. **The camera's designed move.** 650ms smootherstep, centre and zoom
   together, fired only when the mid has stayed past a tenth of the viewport
   for half a second, or the committed zoom changes. Its endpoint is fixed
   when it starts: it lands there and ends, and the deadband then decides
   afresh. A move that chased the live target reversed and, near its end,
   jumped the whole field 40 and 181 device px in single frames on a phone
   (measured 2026-09-23, headless); the half-second hold keeps a sweep that
   refills a few packs later from being framed at all. While the hand owns the
   scale, only the centre makes the move, and a wheel or pinch does not
   restart it. A crossed pack (negative spread) is never a target.
3. **The viewer's own motion.** Released pan, arrow-key travel, PageUp/Down
   leap: finite ease-out cubic, 160–480ms by distance, landing on the tick
   grid. Zoom under the hand: an ease with a 180ms time constant that snaps
   exactly onto its target within 0.1%, so it arrives.
4. **The mode cross-fade.** 600ms sine luminance dip; the label changes
   first.
5. **Chrome fades, all opacity only.** The chrome itself: a straight 200ms
   line that lands exactly (`chromeFadeAlpha` in `ui.ts`), in on engagement,
   out after 4s idle. Inside it, a caption's own fade (in over ~0.36s, out
   over the last ~1.2s of 6s, no rise), shown only while the chrome is up.
   The follow chip (150ms) and the inspector (120ms).

That is the list. If a change adds a sixth, it needs the owner's word.

Deliberately NOT on it: the length scale (committed once per book as a cut,
then held exactly; `LengthScale` in `renderer.ts`), the mode dot (degraded
is a held, dimmed dot, not a pulse), any flare or flash on an arrival, a
trade or a cancel, and any caption at rest.

Owner decisions of 2026-09-23: the arrival flare is deleted (an order no longer arrives bright),
captions appear only while the viewer is engaged, and the length scale is
held once committed. None of the three comes back without the owner's word.

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

The same grid has a second, sharper edge: anything that MOVES across it must
move in whole device pixels, and any dimension measured against it must be a
whole number of them. Two rules fall out, both measured:

- **Row height is rounded to whole device pixels** before the edges are
  snapped. A 7.685 CSS-px row at dpr 2 is 15.37 device pixels, which renders
  as 15 *or* 16 depending on where the row happens to sit — and each row
  flips between them at its own moment as the field slides. That mixed,
  flickering field is what "the bars glitch when I scroll" was.
- **The drawn standpoint is rounded to a whole device pixel**
  (`snapCenterToDeviceGrid`). The camera's own centre stays continuous —
  the deadband and glide math need it — but what reaches the shader stands on
  the grid, so a pan slides the field in whole pixels and every row keeps its
  phase. `layout.ts` reads the same snapped value, so hit-testing agrees.
  It reaches the shader as a whole tick plus a pixel remainder
  (`splitCenterForGpu`): a float32 uniform at BTC's price resolves only half
  a tick, which quantized every pan and designed move into 4px jumps at 8
  px/tick and undid the snap. Past 2^24 ticks ($167,772.16) float32 cannot
  hold a whole tick either, so every tick, the centre's and each order's,
  crosses as two whole-number halves (`tick mod 2^24`, `floor(tick / 2^24)`)
  that the shader subtracts as integers, exact in any evaluation order;
  without it the far asks drew thousands of pixels off their price.

Both are presentation at the smallest scale that exists here: neither can
move anything by as much as one device pixel.

## Timing and framing values in use (tuned, not defaulted)

- Camera: bird's-eye. The frame holds the BODY of the book — the innermost
  75% of occupied levels — bounded by 5e-5 of the mid price so the far
  constellation (asks past $21M, bids at a cent) cannot squash the market
  into a line. Body, not extent: one lone order 170 ticks out was setting the
  scale for everything else and squeezing rows to 3px. One profile for both
  layouts; `maxPpt` 8 is a ceiling on how CLOSE it may stand, so a thin book
  is a wide frame with space in it, never a close-up of three bricks — and on
  a small book that ceiling BINDS, which is the stillest state there is.
- That describes the synthetic understudy. On the live feed neither the body
  nor the ceiling sets the frame: a live book holds ~6,500 occupied levels
  and only 6 to 126 of them sit inside the price bound, so the 75% walk
  always stops at the bound (`packer.ts`) and the frame is 5e-5 of mid,
  about ±320 ticks ($3.20 either side). That is ~1.1 px/tick, which drew rows ~1 CSS
  px (0.67 on a 3x phone whose view is 750px tall) until 2026-09-24, with a
  median of 12-16 occupied levels on screen (measured 2026-09-23 by packing
  the 120s fixture and the bundled replay).
- Row weight is bought with the span above 3 px/tick: rows are `ppt - 1`
  px, so every tick of span you frame is height taken off every row. On the
  synthetic understudy the 8 px/tick ceiling gives ~7px rows, the answer to
  the owner's "too thin for sure" at 3px (measured in synthetic only; no
  owner review of 7px rows is recorded). Below 3 px/tick a row keeps a floor
  of `MIN_ROW_PX` = 2 CSS px (`cells.ts`, 2026-09-24, on the owner's "make
  the lines a little thicker"): live rows are 2px, not the ~1px hairlines
  that were too faint to read and too thin to point at, and occupied
  neighbours one tick apart overlap into one band. Price grouping stays
  unexplored. Do not retune the floor without the owner.
- The inspector's hit test is a probe, not an exact lookup (`hitTest` in
  `layout.ts`, `inspect` in `pipeline.ts`): rows within `HIT_SLOP_PX` (6 CSS
  px for a cursor, 14 for a finger), nearest first, and the same slop past the
  back of a queue. An exact row-and-order lookup on 1px rows missed most
  pointer positions on a drawn cell.
- Reframe deadband: a tenth of the viewport height. Measured at 45s of the
  synthetic understudy, that is about one designed move per axis per 45s and
  ~96% of frames writing nothing at all. If a change makes that number worse,
  it is a regression whatever it looks like in a still.
- Auto-zoom deadband 12%. A hand-set zoom holds; the both-bests cap may only
  tighten it, only for a wider spread that has held half a second, and never
  hands it back (a cap that followed the spread both ways pumped the field,
  measured 34% peak-to-peak; one that tightened for any pack kept a held
  4.64 px/tick at 2.06 for good after a single sweep on the recorded fixture).
- Length scale: no deadband and no move. It is committed once per book, on
  the first frame a two-sided book holds 24 orders, as a cut, and then held
  exactly. A new book (mode switch, reseed, reconnect, hidden tab) or a new
  layout or width takes it again. Lengths only have to be right relative to
  each other, and a scale that followed the noisy median behind a 0.5
  deadband still re-lengthened every cell two or three times a minute at
  rest (measured: x0.41 to x1.55).
- Age → luminance: an order holds its side's color for its first 60s, then
  travels to its ember anchor over the next 540s,
  `mix(base, ember, clamp((age−60)/540))`, along a hue path rather than a
  grey lerp. There is no arrival flare: the 28% mix toward a hot tint over
  an order's first 8s was an event flash (and a whole-field one on every
  reseed), and it is deleted. The cells' luminous core keeps the old rule:
  mix toward white, never multiply >1 — multiplying clips channels and
  washes amber into yellow-green (we hit this).
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
domain meaning and an explainer entry. White is never laid on the field as
an event: white was the flash, and the arrival flare (which peaked at pure
white on liquidations) went the same way. The only white left in the shader
is the cells' constant luminous core, a 16% mix that is the same in every
frame.

## Composition rules

- The spread gap is the piece's center of gravity: at rest it sits mid-screen,
  breathing. Anything that competes with it must earn the attention.
- The frame contains both best bid and best ask once a widening has held
  half a second — the camera's touch cap guarantees it, and a one-pack spike
  is not framed. Row legibility yields on gappy books (a phone once
  showed only the bid side because the zoom floor won; it must never again).
  The one exception is a crossed pack, which the camera ignores: live flow
  crosses for a message at a time, and on live a crossing that persists is a
  wrong book the pipeline reseeds (~8s). A replayed capture has no such
  guard, so a crossed stretch of a recording holds the last frame.
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
- Wordless at rest: no numbers, no axes, no captions until engagement. The
  provenance line is the only standing text. A caption that fires at rest
  is dropped, not saved for later, and hiding the chrome ends a caption for
  good; the detectors and the screen-reader narration run regardless.

## Reduced motion is a second piece, not an absence

The gap has narrowed to almost nothing now that the piece itself is still:
the same designed moves happen, cut instead of eased (the camera's move,
PageUp/Down and a released drag each land in one frame), an arrival appears
at full strength with no ramp, the chrome appears and leaves without a fade,
and a caption holds and fades out over its last 0.7s. The mode dip stays: it
is a change of light, not of position. It should feel like a stiller
sibling, not a broken one — and "stiller than this" is now a fine hair. Test
it every time motion changes: `page.emulateMedia({ reducedMotion: "reduce" })`
or the OS toggle.

## Judging a change

Watch a full minute on desktop and on a narrow viewport (tools/screenshot.mjs
gives all three states). Ask: is anything moving that you cannot name the
event for? Does the frame hold — can you look at one row for ten seconds
without it shifting under you? Would you notice the change was reverted? If
not, drop it. And the version of that question that now decides most calls:
**would you notice if this animation were simply deleted?** If the answer is
"barely", delete it.
