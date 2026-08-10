---
name: truth-rules
description: Use whenever adding or changing anything visual — motion, easing, a new effect, a transition, a caption. This is the rule a well-meaning change violates precisely while trying to make something look better.
---

# The truth rules in practice

The piece's claim is that every moving pixel is caused by a real event in the
engine. Beauty that costs truth is a bug of the same severity as a wrong
number. The line is precise:

**Interpolate presentation, never data.** Presentation describes *looking*
(where the camera is, how a flash decays, when in the frame a sprite starts).
Data describes *the market* (prices, sizes, orderings, existence). If a change
would alter what a viewer concludes about the market, it is data.

## The architectural teeth

The worker owns every number that describes the market; the renderer owns
every number that describes looking. The renderer receives a read-only frame
and an event list — there is deliberately no path by which render code can
invent a price, size, or ordering. Keep it that way: if your feature needs
market state the frame doesn't carry, extend the frame in the worker; never
derive or guess it renderer-side.

## Worked examples — allowed

- The camera easing toward the mid. The mid itself is always the real mid; the
  camera is where you stand.
- A trade flash whose decay lasts 420ms. The trade was instantaneous; the
  afterglow is presentation. Same for the ~100ms fade of a cancelled cell.
- Staggering a burst's flashes across ~200ms so a sweep reads as a run. The
  events all really happened this frame; stagger is choreography of decays.
- The 600ms luminance dip on a mode transition — a designed announcement of a
  real mode change, with the label changing first.
- Min-clamping cell length to 1.5px (dust must be visible) and clamping raster
  length at ~1.25 viewports (a whale still reads "longer than the screen").
  Both are disclosed presentation of real sizes.
- Easing the length SCALE as the size distribution shifts — a scale is a lens.

## Worked examples — forbidden (each was tempting at some point)

- Tweening a cell from its old price to a new price on a modify. The venue
  cancelled and re-added it; drawing a slide asserts a false event. We render
  cancel + arrival, and the engine enforces it (relocation emits both).
- Smoothing the mid or spread over time "to reduce jitter". The jitter IS the
  market. The overlay prints the exact current values or nothing.
- A decorative idle animation when the market is quiet. Quiet is content: the
  camera may widen (presentation), the caption may say "quiet market" (true),
  but nothing may move without an event.
- Dropping trade events under load to keep frame rate. Coalesce book state,
  never trade prints (protocol.ts caps cancel sprites and REPORTS the drop).
- Letting the label lag a mode change by "one clean fade". The label leads,
  always — a viewer must never read simulated texture as live truth.

## Checklist for any new visual element

1. What engine event causes it? (No event → it may not move.)
2. Which of its parameters are data (position, magnitude, count) and which are
   presentation (decay, easing, stagger)? Write the split in a comment.
3. Does it read correctly in `prefers-reduced-motion`? Reduced motion is a
   second motion design (rings instead of flashes, snaps instead of springs),
   not an off switch.
4. Does it encode meaning in red/green alone? Side is position + blue/amber.
5. Could a viewer mistake it for something the market did not do? If unsure,
   it is data; put it in the worker or don't ship it.
