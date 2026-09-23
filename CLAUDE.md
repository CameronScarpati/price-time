# price-time

A single-page visualization of a live matching engine: real order-by-order flow
from Bitstamp's public BTC/USD feed reconstructed through a price-time-priority
engine built here, rendered as a still, wide, sharp order book, with an
accuracy contract. `docs/brief.md` is the research it stands on;
`docs/design.md` records each design decision and its reasoning. The skills in
`.claude/skills/` cover one area each (truth rules, engine invariants, book
reconstruction, device performance, visual craft, verifying a change).

## Commands

- `pnpm dev` — dev server. `?hud=1` shows frame stats; `?mode=synthetic|replay|live`
  forces a mode; `?seed=42` fixes the synthetic seed.
- `pnpm test` / `pnpm typecheck` / `pnpm build` — build runs typecheck first.
- `SOAK=1 SOAK_MINUTES=60 npx vitest run test/soak/soak.test.ts` — live
  reconstruction benchmark; writes `docs/perf/soak-*.json`.
- `node tools/capture.mjs btcusd 600 out.jsonl` — record a real session
  (fixtures, replay assets).
- `node tools/screenshot.mjs <url> <prefix> <seconds>` — headless look at the
  piece (desktop, engaged, phone).
- Sandboxed environment (browser has no egress): `node tools/dev-relay.mjs`,
  then open `?ws=ws://localhost:8975&rest=http://localhost:8975/api/v2`.

## Architecture (where responsibility lives)

The worker owns **truth**; the main thread owns **looking**. That boundary is the
project's spine — market state crosses it only as a packed, transferred
`Float32Array` frame plus a per-frame meta object (`src/worker/protocol.ts`).

- `src/engine/` — pure deterministic matching engine. No I/O, no clocks, no
  randomness. Two authorities: `internal` (synthetic mode; matches arrivals,
  strict invariants) and `external` (live/replay; venue events applied as facts,
  disagreements counted as anomalies, never corrected). One shared
  queue-consumption path for both.
- `src/sources/` — three `FlowSource`s emitting one normalized stream:
  `bitstamp/` (WS + snapshot seeding + chain gap detection + divergence guard),
  `synthetic/` (seeded agents), `replay/` (capture format + player).
- `src/worker/` — pipeline (mode ladder, pause/catch-up clocks, calibration),
  frame packer, worker entry.
- `src/detect/` — phenomenon detectors → captions + screen-reader narration.
- `src/render/` — WebGL2 instanced cells, camera (bird's-eye framing, still
  between designed moves), Canvas2D overlay, layout math (CPU mirror of the
  shader — keep them in lockstep or the inspector lies).
- `src/ui/` — DOM chrome: provenance, controls, tape, inspector, explainer,
  ARIA narrator.

## Invariants

- **Truth rules.** Every pixel that moves is caused by an engine event — and
  most events now move no pixel of their own, only the book. Interpolate
  presentation (the camera's framing), never data (no smoothed prices, no
  tweened book states, no sliding modifies — a modify is cancel + re-add). If
  it changes what a viewer would conclude about the market, it is data. See
  `.claude/skills/truth-rules/`.
- **Engine invariants.** Internally-matched book never crossed; FIFO priority
  exact; per-order quantity conservation; cancels never resurrect; byte-identical
  determinism from a seed. Checked by `checkInvariants` in property tests after
  every command. See `.claude/skills/engine-invariants/`.
- **Reconstruction.** A detected gap (broken `event_id` chain) or sustained
  divergence means discard the book and re-seed. There is no patch path, on
  purpose. See `.claude/skills/book-reconstruction/`.
- **Disclosure.** The provenance mark always states the mode, and the label
  changes at or before the data does — never after.
- **Stillness.** The frame holds: between designed moves the camera writes
  nothing. Every automatic move is finite and lands on the endpoint it
  planned, and fires only for a drift that has held half a second. Nothing eases
  asymptotically anywhere on the render path — cell edges snap to the device
  grid, so a scale or centre that never arrives makes the whole field boil.
  The length scale is taken once per book, as a cut, and then held.
- **Backpressure.** Book state coalesces to one repaint per frame; discrete
  trade events are never dropped: every one reaches the worker's detectors,
  tape and trade stats. No event list crosses to the main thread, because
  nothing there draws a trade or a cancel.
- **The frame is a fact, not a derivative.** Nothing packed may be computed
  from "now" — instances carry `restedAtSec`, and age is `meta.nowSec` minus
  it in the shader — so an unchanged book packs to identical bytes. The
  worker stamps each frame with a book revision and skips the pack when the
  buffer handed back still matches; anything that can move the book calls
  `invalidateFrame()`. A per-frame derived value in the frame would stop the
  skip from working; a missed invalidation would show a stale book.
- **Numbers.** Integer ticks (cents) and sats only; venue decimal strings are
  parsed digit-wise (`parseDecimal`), never through floating point. Ticks are
  stored in Float64 — real books contain fishing orders past Int32 range.

## Conventions

- Zero runtime dependencies; TypeScript strict; domain vocabulary in code
  (maker/taker, aggressor, tick, sats, seq, BBO).
- Not implemented by design (reasons in `docs/design.md` §4, §7, §8, §10):
  stops, pegs, hidden orders, self-trade prevention, an aggregated (L2)
  fallback feed, a time-axis heatmap, looping replay, OffscreenCanvas,
  SharedArrayBuffer.

## Feed facts (verified live, 2026-08)

- `order_deleted`/`order_changed` carry `amount_traded` **per event**: 0 means
  cancel/resize, >0 means fill. This is the fill-vs-cancel attribution; no
  trades join needed for state.
- `order_changed` can carry a **price change** — a real venue modify. It must
  relocate the order to the back of the new level (cancel + re-add), never
  resize in place.
- `order_deleted` can name an order that never rested, priced off the cent
  grid (a recorded `63941.91523761`); a deletion is applied by id alone.
- `live_orders` messages form a verified hash chain (`pre_event_id` →
  `event_id`); ~100–160 msg/s quiet, 99.7% of deletions are cancels.
- `group=2` REST snapshots list same-price orders in queue order (ascending id),
  and include orders at absurd prices ($21M+ asks) — handle the range.
- Trade prints (`live_trades`) join by `buy_order_id`/`sell_order_id`; used for
  cross-validation and stats only — state flows from `live_orders` alone.

## Glossary (the vocabulary is load-bearing)

aggressor/taker (incoming order that removes liquidity) · maker (resting order
that provides it) · BBO (best bid and offer) · spread (ask − bid) · tick
(minimum price increment; here 1¢) · sats (1e-8 BTC, integer sizes) · L2/MBP
(aggregated per price) vs L3/MBO (order-by-order — the premise) · queue position
(who is ahead of you at your price; FIFO fills front-first) · sweep (one
aggressor eating multiple levels) · iceberg (hidden reserve refilling a shown
slice) · cross/auction (batch uncrossing at one price) · seq (engine sequence
number; defines time priority) · snapshot+delta (seed from REST, apply WS
events) · uncrossed (bid < ask; violated only transiently in external mode).
