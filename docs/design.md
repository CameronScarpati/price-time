# price-time — design

A single web page that makes a live matching engine visible. Real order-by-order flow
from Bitstamp's public feed runs through a deterministic price-time-priority engine
built here, and every pixel that moves is caused by an event in that engine. This
document records the decisions, the reasoning, and what was rejected. The research
brief (`docs/brief.md`) is the authority on domain facts; this document is the
authority on what gets built. Where this design deviates from the brief, the
deviation is called out explicitly and argued.

---

## 1. Verified against the live venue (2026-08-08)

The brief's addendum gated the build on several verifications. All were performed
against the live API before this design was written. Several findings are *better*
than the brief assumed, and they reshape parts of the design, so they come first.

**REST snapshot has per-order identity.** `GET /api/v2/order_book/btcusd/?group=2`
returns bids and asks as `[price, amount, order_id]` triples. Observed: 8,725 resting
orders (4,159 bids / 4,566 asks) across ~6,500 price levels. In every one of the 311
multi-order levels observed, same-price orders were listed in ascending-id order,
and ids increase with creation time — so queue order at seed is the listing order.
(Corroborated, not documented by the venue; the soak test re-validates it, §12.)

**`live_orders` events confirmed, with a larger field set than the brief had.**
`order_created` / `order_changed` / `order_deleted` each carry:
`id`, `id_str`, `order_type` (0=buy, 1=sell), `order_subtype` (observed 4, 5, 6 —
semantics unknown, treated as opaque), `price`/`price_str`, `amount`/`amount_str`,
**`amount_traded`**, **`amount_at_create`**, `datetime`, `microtimestamp`,
`is_liquidation`, plus envelope fields **`event_id`**, **`pre_event_id`**, and
`order_source` (observed only `"orderbook"`).

**Fill-vs-cancel attribution is built into the order stream.** The brief's Addendum A
called this unresolved and prescribed a join against `live_trades`. It is simpler
than that: `amount_traded` on `order_changed`/`order_deleted` is the quantity traded
*in that event* (verified across multi-fill sequences: per-event values sum to
`amount_at_create − amount`). So a deletion with `amount_traded = 0` is a cancel and
a deletion with `amount_traded > 0` is a fill — directly, per event, no join needed
for the distinction. The trades join is still used, but for what it is uniquely good
for: aggressor side, the trade print itself, and cross-validation (§5).

**The event stream is a verified chain — exact gap detection exists.** Every
`live_orders` message carries `event_id` and `pre_event_id`, and in a 710-message
probe, all 709 possible links held: each message's `pre_event_id` equaled the
previous message's `event_id`. The brief believed Bitstamp had no sequencing and
prescribed periodic re-snapshots as the only insurance. Instead we get provable
continuity: a broken link is a detected gap, and a detected gap means discard and
re-seed — never patch. (Chain continuity over long sessions is re-verified by the
soak test; the divergence guard remains as defense in depth.)

**`live_trades` fields confirmed.** `trade` events carry `id`, `price`, `amount`,
`type` (0 = buy aggressor, 1 = sell aggressor), `microtimestamp`, and
**`buy_order_id`** / **`sell_order_id`**, which join cleanly against `live_orders`
ids (verified live: a trade's maker id matched an `order_changed` with the same
`amount_traded` at the same microtimestamp).

**Aggressors that rest are visible.** An arriving order that partially fills and
rests appears in `live_orders` with its fill history (`order_changed` on arrival
showing `amount_traded`, then `order_created` for the remainder). Only aggressors
that fully fill on arrival never appear — their existence is known solely from the
trade print, which is exactly what the trade join provides.

**Rates and texture.** Quiet-market observation: ~90–160 messages/s sustained on
BTC/USD; in 90s: 3,915 creates, 3,920 deletes, 13 trades. 99.7% of deletions were
cancels. Median spread observed: $0.01 on a ~$65,000 instrument. The book's living
core is small: ~300 orders within ±0.5% of mid, ~425 within ±1%, with a long sparse
tail of stale distant orders. The cancel-storm texture (phenomenon 4) is not an
occasional event; it is the dominant fabric of the market.

**Terms of service (Addendum C, resolved).** Bitstamp's API page states: *"Bitstamp
allows the incorporation and redistribution of our exchange data … the right to
create ratios, calculations, new original works, statistics, and similar, based on
the exchange data,"* with a Commercial Use Data License Agreement (partners@bitstamp.net)
required for commercial use. This piece is free, non-commercial, consumes rather than
re-serves the feed, and attributes Bitstamp by name on the page — squarely inside the
permitted posture. If the piece ever acquires a commercial frame, a license agreement
is required first. Re-check terms before any public launch (they change).

Open items carried forward from verification: `order_subtype` semantics; whether
`order_source` takes other values; cross-channel ordering skew between `live_orders`
and `live_trades` (measured during capture, §5). None block the build.

---

## 2. The shape of the system

One engine, one book, three sources — the brief's Addendum B, adopted exactly. What
varies across modes is *who has authority to declare a match*, and nothing else:

- **Live** — Bitstamp's order stream is the authority. Fill events arrive as
  `order_changed`/`order_deleted` with `amount_traded > 0`; the engine applies them
  through the same queue-consumption code path its own matcher uses. Trade prints
  from `live_trades` attach aggressor side and drive the tape and trade animation.
- **Synthetic** — seeded agents generate arrivals; the engine matches internally,
  under strict invariants. Always available, deterministic from a seed.
- **Replay** — a recorded capture of either of the above, authority preserved.

All three sources implement one interface: they emit a single ordered stream of
normalized `SourceEvent`s stamped with a local sequence number. The engine is a pure
fold over that stream: `(State, Event) → (State, EngineEvent[])`. The renderer is a
function of engine state plus an animation clock. Nothing downstream knows which
mode it is in except the provenance system.

```
Bitstamp WS ──┐
REST snapshot ─┤→ reconstruct ─┐
               │                ├→ normalize → ENGINE → frame packer ─(ArrayBuffer)→ renderer
synthetic agents ───────────────┤       ↓                    (worker)      (main thread)
replay player ──────────────────┘   detectors → captions/narrator
```

Everything left of the ArrayBuffer lives in a Web Worker. The main thread renders,
handles input, and owns all *presentation* state. This boundary is also the truth
boundary: **state that changes what the book says lives in the worker; state that
only changes how it looks lives in the renderer** (§9).

---

## 3. Stack

Every dependency defended in a sentence; everything else is written here.

- **TypeScript (strict)** — a stateful domain with dense vocabulary needs types that
  say `PriceTick`, `Sats`, `OrderId`, not `number`.
- **Vite** — boring, standard dev server + static build with first-class worker
  support; output deploys to any static host.
- **Vitest** — test runner that shares Vite's pipeline; nothing exotic needed.
- **fast-check** — property-based testing engine; writing shrinking and generators
  by hand would be materially worse than this mature library.
- **Zero runtime dependencies.** No framework: the page is one canvas plus a handful
  of DOM panels; a component tree has nothing to manage. No WebGL wrapper: the
  renderer needs exactly one instanced-quad pipeline and one textured-quad pipeline;
  three.js/pixi/regl would add hundreds of KB to avoid ~300 lines of GL setup.
- **Playwright (dev-only)** — smoke screenshots in CI using the preinstalled
  Chromium; not shipped.

Prices are integer cents (`PriceTick`), sizes integer satoshis (`Sats`). Both fit
exactly in JS numbers (2.1e15 sats max < 2^53). No floating point in the engine —
string fields from the feed are parsed directly to integers.

---

## 4. The engine

A pure module. No DOM, no timers, no I/O, no `Date.now()`; time enters only as event
timestamps and sequence numbers.

**Structures.** Two sides. Each side: a `Map<PriceTick, Level>` plus a sorted array
of active ticks (binary-search insert; at a few hundred level-creations per second
on ~3k levels, splice cost is negligible — boring wins). Each `Level` owns an
intrusive doubly-linked FIFO queue of orders. Order nodes live in a pooled
typed-array store (parallel arrays: price, size, side, flags, created-at, links)
indexed by slot, with a `Map<OrderId, slot>`; this makes the hot path allocation-free
and doubles as the source the frame packer reads (§8). Cancel from the middle and
fill from the front are O(1).

**Commands.** `place` (limit, market, IOC, FOK, post-only), `cancel`, `replace`
(cancel-replace; resets time priority, as it should), and `consume` — the live-mode
authority command: "resting order X traded quantity Q, aggressor side S." `consume`
runs through the same queue-consumption code as internal matching, so live mode
exercises the same code path synthetic mode does. Deliberate v1 subset: stops,
pegs, hidden, GTD are **out** — the live feed cannot express them and the v1 scenes
don't need them; iceberg is implemented for synthetic mode only (it is inferable
but not certain from live data). This subset is a decision, not an accident.

**Allocation.** Price-time (FIFO) is the rule, matching Bitstamp. A pro-rata
allocator exists behind the same interface for the staged comparison scene
(synthetic mode only, v1.5) — fills raining across a whole level at once instead of
eating it front-to-back is the single clearest way to show *why* time priority
matters.

**Events out.** `orderRested`, `orderReduced`, `orderCanceled`, `orderFilled`,
`trade` (maker id, taker ref, price, qty, aggressor side), `bookSeeded`,
`gapDetected`, `modeChanged`. The renderer consumes these for animation triggers;
the frame packer consumes state for the resting field.

**Determinism.** The engine is a deterministic state machine over its command log.
Synthetic mode uses a seeded PRNG (xoshiro128**); same seed → bit-identical event
log (tested by hashing). Live mode is recordable: the normalized event stream is the
command log, so any live session replays exactly.

**Invariants — and the live-mode asymmetry.** In synthetic mode, strict: the book is
never crossed; fills come only from the front of the queue; quantity is conserved
across every fill/cancel/rest; cancels never resurrect; priority is never violated.
In live mode, the venue is the authority and our reconstruction is a shadow of it:
a `consume` may name an order that is not at our queue front (hidden orders,
self-trade prevention, and internal sequencing we cannot see). The rule: **apply the
venue's truth, count the anomaly, and surface it in the divergence metric** — never
"correct" the venue to satisfy a local invariant. This asymmetry is explicit in the
types (`MatchAuthority`), in the tests, and in the engine-invariants skill.

---

## 5. Live source: reconstruction and resync

**Seeding.** Subscribe `live_orders_btcusd` + `live_trades_btcusd`; buffer events;
fetch the `group=2` snapshot; build the book with queue order = listing order; then
replay the buffer **idempotently**: `order_created` → upsert, `order_changed` →
upsert (set amount), `order_deleted` → remove-if-present, any event for an unknown
id that predates the snapshot → apply what it implies, never error. Idempotent
replay makes the snapshot/buffer overlap safe without trusting timestamp
comparisons at microsecond granularity — in one direction. The other direction was
found the hard way during the build (a congested path made it reproducible): **if
socket delivery lags the snapshot, the buffer holds creates and changes from before
the snapshot moment for orders the snapshot already saw die, and replaying them
resurrects dead orders as phantoms** — stale quotes inside the spread, a book that
crosses itself and looks plausible doing it. So the drain has one timestamp rule:
deletions always apply (unknown ids are ignored), but rests and reduces strictly
older than the snapshot's `microtimestamp` are dropped. Venue event stamps and the
snapshot stamp share the venue's clock, which is what makes the comparison sound.

**Gap detection.** Maintain the `event_id` chain. Any message whose `pre_event_id`
does not equal the last seen `event_id` is a gap. On gap: discard the book,
re-seed from REST. Never patch across a gap — every patched book is a book that
looks right and is wrong. Same response to `bts:request_reconnect` and socket loss:
reconnect, re-subscribe, re-seed. If re-seeding takes longer than ~1s, the piece
cross-fades to synthetic (seeded from the last good state) rather than showing a
stall, and fades back when live is healthy (§10).

**Fills vs cancels.** From the order stream alone (§1): `amount_traded > 0` means
fill, `= 0` means cancel. The engine's state authority is therefore the single,
chain-verified `live_orders` stream — no cross-channel sequencing is needed for
correctness. `live_trades` events join by order id to attach aggressor side and feed
the tape, the trade flash, and the sweep detector; the join tolerates a small
arrival skew between channels (annotations may attach ~50ms late; state never
waits for them). Skew is measured and logged during capture.

**Divergence guard (defense in depth).** Every 30s, fetch the aggregated REST book
(`group=1`) and compare best bid/offer within one tick plus top-10-level depth
within tolerance. Sustained divergence → treat as a gap: discard, re-seed, log.
The brief's acceptance benchmark stands: **reconstructed BBO matches the venue
within one tick continuously for an hour** (soak harness, §12), and chain
continuity plus divergence stats are recorded in the same run.

---

## 6. Synthetic source

Not a screensaver — load-bearing infrastructure (brief, Addendum C). A small
population of agents drives the same engine through the same interface:

- **Makers** quote both sides with inventory; accumulated position skews their
  quotes (this is what makes phenomenon 7 — inventory skew — honestly showable,
  since here we *own* the inventories).
- **Takers** send market/IOC flow with bursty arrivals (thinned Poisson with a
  self-excitation term — cheap Hawkes flavor, giving the irregular rhythm real flow
  has).
- **Noise quoters** place-and-cancel at realistic lifetimes.

Calibration is continuous: while live mode runs, the worker maintains rolling
estimates (arrival rates by distance-from-mid, size distribution, cancel-lifetime
distribution, trade intensity) and the synthetic agents consume them. A cross-fade
to synthetic therefore continues the *statistical texture* of the market it
replaces, seeded from the last real book state, and the book itself does not jump
at the transition — only the flow authority changes. Fully deterministic from
(seed, calibration snapshot).

---

## 7. Composition — what is on screen

### Desktop: the seam

Price runs vertically. The screen's center vertical line is the price axis — the
**seam**. Bids press on it from the left, below the mid; asks press on it from the
right, above the mid. Each price level is a horizontal row of individual order
cells in queue order, **front of queue at the seam**, later arrivals stacked
outward. Cell length is linear in order size; 1px separators keep individual orders
countable near the seam. The two sides form facing staircases, and their
silhouettes *are* the depth profile — the classic depth chart emerges from real
individuals instead of being drawn.

Dead center, between the lowest ask row and the highest bid row, is the **spread**:
a living gap whose height is the spread in price units. It breathes with the data,
which is phenomenon 1 and the first three seconds.

What each visual channel carries (per the brief's encoding findings):

| Channel | Carries | Note |
|---|---|---|
| Vertical position | Price | the one metric, ordered quantity gets the best channel |
| Horizontal position in row | Queue position | distance from the seam = distance from the trade |
| Cell length | Order size | linear; min-clamp 1.5px, disclosed in explainer; never max-clamped — a whale order being enormous is the truth |
| Luminance | Age | new orders arrive bright and settle; long-resting orders dim to embers — waiting made visible |
| Hue | Side (redundant with position) | blue/cyan bids, amber asks — CVD-safe pair, never red/green |
| Flash | A trade | instantaneous event; only its decay is animated |

Events: an arriving order materializes at the back of its queue (~120ms fade/scale
in — presentation of an instantaneous fact). A cancel fades out in place (~100ms).
A fill lays a **heat streak** along the consumed row — fast attack, ~1s
exponential cool-down, reaching into the eaten side — so rapid trades pool into
sustained warmth instead of strobing. A sweep reads as a run of streaks climbing
or descending the seam, staggered within their frames' decay windows, never
merged. In live mode, fully filled aggressors never rest, so the aggressor is
drawn as the strike arriving at the queue front — presentation of a real trade
event whose side is known from the trade print. `is_liquidation` orders get a
distinct mark (explained in the explainer; rare, worth celebrating).

The frame is composed for trance through stillness and calm pacing (the Listen
to Wikipedia lesson: one soft bell per second beats forty pops). Two persistence
experiments were shipped and reverted after real-device review: a whole-field
phosphor wash (read as OLED afterimage smearing) and 950ms trade heat streaks
(read as motion blur). A third — a warm/cool luminous membrane inside the
spread gap — survived longer but went the same way: even scissored and edge-
faded it read as a stray glow behind the field, and the owner's verdict was no
glow behind the field at all. A fourth followed: the compact elliptical trade
strike at the queue front — caught mid-decay, or orphaned in empty space after
the price moved on — read as dirty smudges. The trade mark is now a BITE: the
exact rectangular span the level lost, flashing white-hot flush against the
bar and cooling out in 220ms. The standing rule hardened by all four: the
field is crisp — hard clear every frame — event light lives in the geometry of
the row it happened to, and nothing soft or round floats free of the bars.
What holds the room instead is static: a dithered radial gradient, cell
material with a luminous core, and a vignette.
The spread gap needs no fill — the empty band between the bests, breathing
with the spread, IS the composition's center. The synthetic market runs deliberately
slower than live's raw message rate (its whole population quotes on screen;
live scatters churn across thousands of unseen levels), because the simulation's
job is to be watchable, honestly labeled, not to impersonate a firehose.

The camera frames the **populated neighborhood** at rest — out to roughly the 4th
occupied level each side, clamped so rows never fall below queue legibility — and
tracks the mid with slow spring easing (presentation). A fixed percentage band was
the original design and it failed against reality twice in one afternoon: on a thin
day it framed two lonely levels in a void, and any fixed tick span assumes a level
density real books don't have (BTC/USD levels scatter tens of ticks apart even when
liquid). Likewise the cell length scale anchors on the *visible core's* median
order size, not any global statistic — whale quotes and far-tail dust drag a global
median across decades. **The camera never moves on its own** — it moves only in
response to data (mid drift, a detected moment) or the user (scroll/pinch to zoom).
Scale is owned by whoever touched it last: auto reframing passes a 12% deadband
before committing (the fit breathes with every book change; chasing each breath
made the field pump), freezes while the viewer is panned away, and yields
entirely to a hand-set zoom until recenter — a viewer contemplating the whole
field must never feel the camera stir under them. Travel is bounded by the book
itself: 15% of a screen of slack past the last resting order, then a firm edge —
infinite empty scroll reads as being lost, and price space below the deepest bid
is soon negative.
Zooming out reveals the whole ~9,000-order field, the long sparse tail of distant
stale orders glowing dim — and as cell separators drop below a pixel, individual
orders optically merge into solid depth bars: the L3→L2 aggregation happens in the
viewer's eye, which is the most honest possible way to show what aggregation is.

At rest the screen is wordless except the provenance line (§10). No axes, no
numbers, nothing to read. The composition *is* the information.

### Phone: the spine

Portrait rotates the priorities, not just the layout. Price still runs vertically —
the long axis goes to the ordered quantity — asks stacked above, bids below, the
spread gap at dead center where thumb and eye rest. Each level is a full-width row;
queue front at the **left edge** (where consumption begins), arrivals joining at the
right. Side is encoded by position (above/below the gap) plus the same hue pair.
No history, no panels at rest; the instantaneous cross-section only. The desktop
seam and the phone spine are two layouts of the same instanced cells; the resize/
rotation transition between them is a designed moment (a single choreographed
re-layout, not a reflow).

### On engagement (progressive disclosure)

Nothing at rest; everything within one gesture:

1. **Touch/hover an order cell** → inspector: size, price, age, queue position
   ("3rd of 7 — 0.42 BTC ahead of it"), and how it will die (front-of-queue next to
   trade, or cancel like 99.7% of its peers). Desktop: thin callout; phone: bottom
   sheet.
2. **First tap/click anywhere** → quiet chrome fades in: mid/spread readout in the
   gap, price ticks along the seam, the control strip (pause, speed, mode), the
   tape (recent prints with aggressor side) in the bottom-right dead quadrant on
   desktop, a pull-up sheet on phone. Fades away after idle.
3. **Detector captions** (§11) — when the market does something, one quiet sentence
   appears near the seam ("a sell just swept 3 levels — $41k in 80ms"), then fades.
   These fire without engagement; they are the piece narrating itself, and the tenth
   minute's reward.
4. **The explainer** — from the provenance mark: what this is, what the queue means,
   what to watch for, what is and isn't real. Three short layers, never a wall.

### Attribution and framing

This is a portfolio piece by **Cameron Scarpati**, and the page says so without
crowding the spell: the explainer's first layer opens with the byline and the
framing — the beauty of markets, as he sees it — and a one-line credit sits in the
engaged chrome next to the provenance mark ("a piece by Cameron Scarpati · data:
Bitstamp"). Page `<title>`, meta description, and social-card tags carry the same
credit. The README leads with the byline and is written to be read by someone
deciding whether to hire the person who built it. Bitstamp's attribution (required
posture, §1) and the author's credit are the only two names on the page.

Rejected composition: the Bookmap-style time-axis heatmap. The brief identifies it
as both honest and cliché; more decisively, a scrolling history axis makes the
present a thin edge of the screen, and this piece is about the *present tense* of
the queue — who is in line now, waiting. Time is shown instead where it actually
lives in a book: in the ages of the orders (luminance) and in the decay of events.
History exists only in explicit replay/scrub mode, labeled.

---

## 8. Rendering and performance

**Substrate: WebGL2 instanced quads, Canvas 2D overlay, DOM panels.** The zoom-out
draws all ~9k orders (well past the brief's ~3k Canvas threshold), and instancing
makes 10k quads trivial for any phone GPU. The overlay canvas draws text and ticks
(crisp text is WebGL's known weakness); DOM carries the panels and a11y. The brief's
flip condition (Canvas-only if the aesthetic had used aggregated levels) does not
apply — per-order cells are the premise. WebGPU rejected as base bet per brief
(long-tail Android). OffscreenCanvas rejected for v1: rendering on main keeps
input, resize, and debugging simple, and the main thread does nothing else; flip
condition — if profiling shows main-thread contention from upload + draw, move the
GL context to the worker behind the same frame-buffer interface.

**The boundary.** The worker packs, at most once per frame, a compact binary frame:
parallel typed arrays for live cells (price tick, size, side/flags, age-base, queue
offset — queue prefix-sums computed in the worker), a small event list for
animation triggers (trades, arrivals, cancels since last frame), and a stats block
(BBO, spread, depth, mode, clocks, divergence). Transferred, not copied; two
buffers ping-pong so steady state allocates nothing. The renderer draws the latest
frame it has; if two arrive between paints it drops the stale one — **resting-book
states coalesce; discrete trade events are never dropped** (they ride the event
list and all get drawn, staggered within the frame's decay).

**Backpressure** follows the brief exactly: coalesce book state per frame; never
drop a trade print; never batch below frame rate; deliberate slow-motion is a
labeled playback-time effect (§10), never a silent lag.

**Budgets** — measured, recorded in the README, misses stated rather than relaxed:

| Budget | Number | Method |
|---|---|---|
| Frame time | p99 ≤ 16.7ms over a 5-minute soak; zero >50ms long frames in steady state | rAF delta distribution + Long Animation Frames API, on-device |
| Device target | mid-range Android (Pixel 6a class) + iPhone SE class | real hardware; emulators lie about GPU and thermals |
| Soak duration | ≥ 5 min continuous | long enough to expose thermal throttling |
| Event throughput | 2,000 events/s sustained, zero dropped trade prints | synthetic flood harness (planned; not yet built) |
| Simultaneous cells | 10,000 at 60fps | full book + headroom, flood scene (planned; not yet built) |
| Time to first motion | < 2.0s on 4G-class network | first order/trade animation after navigation |
| JS heap | < 150MB; zero steady-state per-frame allocation | DevTools allocation sampling on-device |
| Bundle | ≤ 150KB gzipped JS | build output; no framework makes this comfortable |
| Battery/data | hidden tab disconnects WS within 5s; live stream ≈ 30KB/s disclosed in explainer; metered/reduced-data falls back to replay | Page Visibility API; Network Information where available |

An in-page perf HUD (`?hud=1`) shows the live frame-time distribution so on-device
measurement is a matter of opening the page, per the performance skill.

**Measured so far** (results also in the README): worker-side `packFrame` costs
1.27ms for the full 8,768-order live book (Node bench, `test/perf/pack-bench`);
shipped JS is ~10KB gzip main + ~12KB worker against the 150KB budget; the live
soak numbers are in `docs/perf/`. Frame-time percentiles from this build
environment's software-rasterized headless Chromium are not meaningful GPU numbers
and are not quoted as such; the on-device measurements the budget requires are an
open item recorded in the README until run on real hardware.

---

## 9. The truth boundary, operationally

The brief's rule — interpolate presentation, never data — is enforced by
architecture, not vigilance: the worker owns every number that describes the
market; the renderer owns every number that describes *looking* (camera position,
flash decay clocks, fade alphas, stagger offsets). A pixel may move only in
response to (a) a frame-state change from the worker or (b) a presentation clock
advancing. There is no path by which renderer code can invent a price, a size, or
an ordering; the packed frame is read-only truth.

Concrete applications: the mid line sits at the real mid, never an eased one — the
*camera* eases toward it, which changes where you look, not what is there. A
modify is a death and a birth (venue semantics), never a slide. Trades are
instantaneous; decay is presentation. Replay time-compression is a labeled
transformation of playback time. The reduced-motion mode (§13) replaces decays and
easing with discrete cross-fades — a change of presentation only.

---

## 10. Modes, degradation, and disclosure

The piece is never down. The ladder:

1. **Live** — Bitstamp flow through the local engine.
2. **Synthetic** — on socket loss, forced reconnect, gap re-seed >1s, or venue
   outage: cross-fade to agents seeded from the last good book and calibrated to
   recent live statistics. Reconnect keeps retrying in the background (with
   backoff); when live is healthy again, fade back.
3. **Replay** — for contexts that should not stream (reduced-data preference,
   metered connection where detectable, no WebSocket): a bundled recorded real
   session, lazy-loaded (~a few MB once beats ~100MB/hr streaming). Also a
   user-selectable mode for scrubbing.

**Deviation from the brief (argued):** the brief positions Binance L2 as "fallback
texture." This design drops Binance entirely. An L2 book cannot show a queue, so an
L2 fallback silently swaps in a different *kind* of picture — one that fails the
piece's premise — while doubling the reconstruction surface (second protocol,
second stitch algorithm, second failure set). The brief's own degradation design
(synthetic seeded from live, then replay) covers every outage more honestly.
Second deviation, small: a looping replay would violate "never loops," so replay
is not the terminal fallback for outages — when a capture ends in auto-fallback
contexts, it hands off to synthetic seeded from the capture's final state, labeled.

**Pause and time.** Three clocks, kept distinct: engine time (event sequence), wall
clock, playback time. Pause freezes playback while buffering live events (ring
buffer, ~10 minutes); resume either fast-forwards (labeled "catching up ×8") or
hard-cuts to live (buffer dropped, labeled). Speed control scales playback against
wall clock and exists only behind the live edge. A clock chip in the engaged chrome
always says which clock the viewer is riding ("live" / "−38s · catching up").

**Provenance.** One quiet, always-present line, bottom edge:

- `● live — Bitstamp BTC/USD order flow → local matching engine`
- `● simulated — seeded from live state 14s ago`
- `● replay — recorded 2026-08-07, real Bitstamp flow`

The dot's shape+color encodes mode redundantly. **The label leads the data:** on
any mode transition the mark changes at or before the first non-live pixel, never
after. The cross-fade itself is a designed moment: the book state is continuous by
construction (same seed state), so nothing jumps — the field takes one slow breath
(a ~600ms global luminance dip and recovery) while the mark rotates, and the flow's
character changes honestly on the other side. The piece never claims to be
Bitstamp's engine — the explainer states plainly that this is Bitstamp's public
flow reconstructed through a local engine, and that matches can differ at the
margin from the venue's internal ones.

---

## 11. Scenes and phenomena

A detector layer watches engine events and cues captions and (subtle) camera moves.
V1 detectors, chosen from the brief's ranking for frequency × payoff:

1. **Spread breathing** — ambient; carried by the composition itself, no detector.
2. **Sweep** — multi-level consumption by one aggressor side within a short window;
   caption with levels, quantity, and dollar value; slight camera push.
3. **Replenishment** — refill rate into swept levels; caption when a hole knits
   closed ("refilled in 21s").
4. **Cancel storm** — cancel-rate spike vs rolling baseline; caption cites the live
   cancel-to-trade ratio (routinely ~300:1, a number worth saying out loud).
5. **Liquidity vacuum** — one side thin beyond threshold; the rarest and most
   startling; celebrated when it occurs.
6. **Quiet market** — low-rate regime (3am Sunday): slower camera, wider frame,
   caption embraces it ("quiet — single orders are events now").

Staged scenes (v1.5, synthetic/replay only, labeled): the opening-cross auction
(book frozen, imbalance glowing, indicative price hunting, everything crossing at
once), FIFO-vs-pro-rata side-by-side, iceberg reveal. Deliberately not in v1: the
spine must be solid first, and the brief agrees on the ordering.

---

## 12. Testing

- **Engine invariants, property-based (fast-check):** arbitrary command
  interleavings preserve — book never crossed (strict mode); fills only from queue
  front; per-order and global quantity conservation; cancels never resurrect;
  priority never violated by later arrivals; IOC/FOK/post-only exact semantics.
- **Determinism:** same seed → identical event-log hash, run-to-run and under
  command-log replay; live capture replays bit-identically.
- **Reconstruction:** golden tests on captured real fixtures; property tests that
  idempotent seeding is correct under arbitrary snapshot/buffer overlap; injected
  chain gaps must trigger discard-and-reseed and never a patch (asserted by
  construction: there is no patch code path to call).
- **Live-mode asymmetry:** `consume` naming a non-front order applies cleanly and
  increments the anomaly counter (never throws, never reorders).
- **Soak harness** (`test/soak/soak.test.ts`, run manually via `SOAK=1`, results
  recorded in `docs/perf/`): one
  hour live — BBO within one tick of the venue's REST book continuously, chain
  continuity stats, divergence and anomaly counts, cross-channel skew distribution.
- **CI smoke:** build + tests + a Playwright screenshot of the page running a
  deterministic synthetic seed, diffed loosely for "something is drawn."
- **Manual visual checks** (CLAUDE.md): watch it for a full minute; watch a narrow
  viewport; watch the live→synthetic fade by killing the network; watch
  reduced-motion mode.

---

## 13. Accessibility

- **Side never rides on red/green** — blue/amber hue pair, redundant with position
  (left/right of seam, above/below gap). Verified with a CVD simulator.
- **`prefers-reduced-motion`** gets a second piece of motion design, not an
  absence: no camera easing (periodic hard reframes), no flashes or sparks; the
  book updates as discrete gentle cross-fades on a ~1s cadence; trades appear as
  quiet rings that fade slowly. Same information, no vestibular triggers.
- **Narration:** an ARIA live region updated every ~4s and on detector events with
  the sentence the worker already computes for captions — "spread two dollars,
  bids stacked three to one, a sell just swept two levels." The forcing function
  runs both ways: if the sentence can't be said, the visual probably isn't saying
  it either.
- **Keyboard:** every disclosed control reachable; inspector navigable to the
  top-of-book orders; explainer fully readable without a pointer.

---

## 14. Repository layout

```
src/
  engine/        book, levels, matching (fifo/pro-rata), commands, events, invariants
  sources/       source interface; bitstamp/ (ws, snapshot, chain, normalize);
                 synthetic/ (agents, calibration); replay/ (capture, player)
  detect/        phenomenon detectors, caption text
  worker/        worker entry, pipeline (clocks, degradation ladder), frame
                 packing (typed arrays, transfer)
  render/        gl (context, instanced cells, text texture), camera, motion,
                 layouts (seam, spine), overlay (canvas 2d)
  ui/            provenance, inspector, tape, controls, explainer, narrator
  app.ts
tools/           capture, dev-relay, net-probe, screenshot, smoke
docs/            brief.md, design.md
.claude/skills/  book-reconstruction, engine-invariants, device-performance,
                 truth-rules, visual-craft, verifying-a-change
                 (+ capture-replay if it earns its place)
```

Build order (per the brief's recommendations and Stage B's discipline): engine +
tests → bitstamp source + reconstruction + soak validation → source interface
proven across synthetic + replay → ugly end-to-end vertical slice (real events →
real pixels) → composition and motion craft → detectors and disclosure → skills,
CLAUDE.md, README with screenshots.

---

## 15. Rejected along the way

- **React/any framework** — one canvas and five panels; a component tree manages
  nothing here and costs bundle and indirection.
- **three.js / pixi / regl** — hundreds of KB to avoid ~300 lines of GL for two
  pipelines.
- **WebGPU as base** — not universal on long-tail Android (brief); nothing here
  needs it.
- **OffscreenCanvas in v1** — debuggability of main-thread rendering wins while the
  main thread has nothing else to do; flip condition recorded in §8.
- **SharedArrayBuffer** — requires cross-origin isolation headers, which breaks
  "deploys to any ordinary static host"; transferred buffers are fast enough.
- **Binance L2 fallback** — fails the premise (no queue), doubles reconstruction
  surface; explicit deviation from the brief, argued in §10.
- **Time-axis heatmap composition** — honest but cliché (brief), and it demotes the
  present-tense queue that is the piece's subject; argued in §7.
- **Smoothing anything the market did** — forbidden by the truth rules; the only
  eased quantities are camera and decay, which describe looking, not the market.
- **A "demo mode" that stages drama in live mode** — the whole value of live is
  that nobody staged it.

## 16. Known limitations and open questions

- The reconstructed book is a shadow of the venue's: hidden liquidity, internal
  sequencing, and auction state are invisible; local matches can differ at the
  margin. Disclosed in the explainer, quantified by the divergence metric.
- `order_subtype` semantics unknown (values 4/5/6 observed); captured and counted,
  not interpreted, until understood.
- Queue order at seed relies on the corroborated-but-undocumented listing-order
  property; the soak test cross-checks it (a wrong assumption would surface as
  front-of-queue fill anomalies).
- Chain continuity verified over short probes; the soak run must confirm it over
  hours before the periodic-reseed insurance is deleted (until then the divergence
  guard stays regardless).
- Bitstamp is a single point of failure by construction; the synthetic fallback is
  load-bearing and built early for exactly this reason.
- The Field/Large/Nywall pro-rata attribution stays out of shipped copy until
  verified (brief addendum); the direction of the finding may be used.
