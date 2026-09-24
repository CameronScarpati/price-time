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
  from `live_trades` are a cross-check on that stream, not a second source: the
  tape and the detectors read the engine's own trade events.
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
- **No linter.** The static check is `tsc --noEmit` in strict mode with
  `noFallthroughCasesInSwitch`, `noImplicitOverride` and
  `exactOptionalPropertyTypes` on; it gates every `pnpm build` and is the first
  check in CI. Correctness is carried by the tests: golden streams, invariant
  property suites with canaries for the oracle itself, and the replay played end
  to end. What a linter would add here is mostly style, which is kept by matching
  the surrounding code, so it would be a dependency and a config for little.

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
`gapDetected`, `modeChanged`. The worker pipeline consumes these for the tape, the
detectors and the order ages; the frame packer consumes state for the resting
field. Nothing on the render side consumes events: since the sprite layer was
removed, the book changing is the only mark a trade or a cancel makes.

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
correctness. `live_trades` events join by order id and serve cross-validation and
stats. The tape and the sweep detector read the engine's own trade events, whose
aggressor is the side opposite the maker, so neither waits on the second channel.
Skew between the channels is measured and logged during capture.

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
| Luminance | Age | an order holds its side's color for its first minute, then dims to an ember over the next nine minutes: waiting made visible. No arrival brightening (removed 2026-09-23) |
| Hue | Side (redundant with position) | blue/cyan bids, amber asks — CVD-safe pair, never red/green |
| Bar shortening | A trade | the level lost exactly that much queue; no mark of its own |

Events: an arriving order materializes at the back of its queue (~120ms alpha
ramp — presentation of an instantaneous fact). That ramp is now the ONLY
per-event animation in the piece, and it is alpha only: until 2026-09-23 a new
order also arrived bright, a 28% mix toward a hot tint that settled over 8s,
and that flare was removed as an event flash (recorded as an owner decision with
the change). A seeded order is not an arrival, so it skips the ramp: a
snapshot stamps every order with one time, and the whole field used to fade
in from 30% on every reseed. In reduced motion there is no ramp; an arrival
simply appears. A
cancel is the cell going, at the instant it
went. A trade is the consumed queue getting shorter, at the instant it was
consumed — the level's own geometry, not a mark laid over it. A sweep reads as
queue after queue emptying up or down the seam. `is_liquidation` orders get a
distinct mark (explained in the explainer; rare, worth celebrating).

This is a **deliberate deviation from the brief** (§2 there: "show a trade as
an instantaneous event — a flash, a spark — and let the decay of that flash be
the only animated part"). Five versions of that flash were built and reviewed
on hardware, and the last of them was correct by every rule and still wrong in
the room: the piece's owner does not want a light going off. Removing it costs
no truth — a removed animation cannot assert anything — and the trade remains
visible in the only place it was ever real, which is the book. What the brief
was protecting against (interpolating the trade's TIME) is protected harder
now: there is nothing to interpolate.

The frame is composed for trance through stillness and calm pacing (the Listen
to Wikipedia lesson: one soft bell per second beats forty pops). Two persistence
experiments were shipped and reverted after real-device review: a whole-field
phosphor wash (read as OLED afterimage smearing) and 950ms trade heat streaks
(read as motion blur). A third — a warm/cool luminous membrane inside the
spread gap — survived longer but went the same way: even scissored and edge-
faded it read as a stray glow behind the field, and the owner's verdict was no
glow behind the field at all. A fourth followed: the compact elliptical trade
strike at the queue front — caught mid-decay, or orphaned in empty space after
the price moved on — read as dirty smudges. A fifth answered every one of
those objections: a BITE, the exact rectangular span the level lost, flashing
white-hot flush against the bar and cooling out in 220ms, anchored so it could
never float. It was reverted too, and this time not for a defect — the owner's
verdict was that a trade should not flash AT ALL, tuned or otherwise. The
sprite layer went with it, cancel sigh included, and one blended fullscreen
pass per frame went with that. The rule the whole lineage converges on: the
field is crisp, nothing is laid OVER the book, and when in doubt an animation
is removed rather than tuned. What holds the room is static: a dithered radial
gradient, cell material with a luminous core, and a vignette.
The spread gap needs no fill — the empty band between the bests, breathing
with the spread, IS the composition's center. The synthetic market runs deliberately
slower than live's raw message rate (its whole population quotes on screen;
live scatters churn across thousands of unseen levels), because the simulation's
job is to be watchable, honestly labeled, not to impersonate a firehose.

The camera takes a **bird's-eye** standpoint and, above all, HOLDS STILL. The
span it frames is the **body** of the book — the innermost 75% of occupied
levels plus 10% air — bounded by a small fraction of the price (5e-5 of mid,
a few dollars either side at BTC's price). Body rather than extent, because
framing the absolute extent let one lone resting order set the scale for
everything else: the farthest synthetic order sits anywhere from 68 to 172
ticks out on luck alone, which squeezed every row to 3px and lurched the zoom
whenever that order died. Three quarters and not more is a stillness choice,
measured: the 85th percentile still wobbles enough to re-commit the zoom 68
times in 40s, where the 75th sits flat at 35-36 ticks and commits 5 times,
which lets the profile ceiling hold the scale exactly. Two earlier
rules died to get here. A fixed percentage band failed against reality twice in
one afternoon: on a thin day it framed two lonely levels in a void, and any
fixed tick span assumes a level density real books don't have (BTC/USD levels
scatter tens of ticks apart even when liquid). Its replacement — the 4th
occupied level each side, capped at a few spreads — was a close-up by
construction, and it re-chose how close to stand every time occupancy crossed a
threshold, which is what made the piece read as chasing the market. The bound
on the extent is not optional: this feed rests asks past $21M and bids at a
cent, and a captured session's true extent is 2.15 BILLION ticks wide. It
bounds FRAMING only; `LoTick`/`HiTick` still cross whole for the pan clamp,
because the extent is data and only the standpoint is ours. The profile's
`maxPpt` (8 px/tick) is a ceiling on how CLOSE the camera may ever stand, so a
book smaller than the frame sits inside it with room around it: a thin market
reads thin. On the synthetic understudy that ceiling is what normally binds,
which is the point — a fixed standpoint cannot drift, and rows come out ~7px
tall instead of the 3px the raw extent produced.

That is the synthetic picture only. On the live feed the frame is set by the
price bound, not by the body or the ceiling: a live book holds ~6,500 occupied
levels and only 6 to 126 of them sit within 5e-5 of mid, so the 75% walk in
`packer.ts` always stops at the bound. The half-span is then about 320 ticks
($3.20 either side), which gives ~1.1 px/tick, rows ~1 CSS px (0.67 on a 3x
phone whose view is 750px tall), and a median of 12 to 16 occupied levels on
screen (measured 2026-09-23 by packing the 120s test fixture and the bundled
replay session).
Rows drawn to that pitch were hairlines: too faint to read, and a one-pixel
target the inspector almost never found under the pointer. Since 2026-09-24 a
zoomed-out row keeps a 2 CSS px floor (`MIN_ROW_PX` in `cells.ts`), so live
rows are 2px and occupied neighbours one tick apart overlap into one band; each
row's centre still sits on its price. Price grouping stays unexplored, and the
~7px figure above says nothing about live.

The inspector does not demand a direct hit either. `hitTest` (`layout.ts`)
sends the worker a probe: the rows within 6 CSS px of the pointer (14 for a
finger), searched nearest first, and in a row the order whose queue span holds
the pointer, with the same slop past the back of the queue. On the bundled
replay, the old exact lookup opened the inspector for 56% of pointer positions
on a drawn cell and 12% of those within 3px of one at 1440x860 (56% and 4% on a
390x844 3x phone); the probe opens it for all of both, at both sizes (measured
headlessly, 2026-09-24).

Stillness is then the default state, not a resting point something approaches.
**The camera never moves on its own** — and now it very nearly never moves at
all. Between designed moves, `centerTick` and `pxPerTick` are not written. The
follow spring and its velocity feed-forward are gone, and the reason is worth
recording because it looked like a frame-rate problem and was not: every cell
edge snaps to the device grid (that is why the field is sharp), while the
camera eased ASYMPTOTICALLY and therefore never arrived — so the field crept by
a fraction of a pixel forever and each row re-snapped a whole device pixel at
its own moment. A boil, loudest exactly while the view was moving. The same grid has a second edge, and it is what a
pan tripped over: anything moving across it must move in WHOLE device pixels,
and any dimension measured against it must be a whole number of them. So the
row height is rounded to whole device pixels before its edges are snapped (a
7.685 CSS-px row at dpr 2 is 15.37 device pixels — it renders as 15 or 16
depending where it sits, and each row flips at its own moment as the field
slides), and the DRAWN standpoint is rounded to a whole device pixel while the
camera's own centre stays continuous for the deadband and glide math
(`snapCenterToDeviceGrid`; `layout.ts` reads the same value, so hit-testing
agrees). That snapped centre reaches the shader as a whole tick plus a pixel
remainder (`splitCenterForGpu`), because a float32 uniform at BTC's price
resolves only half a tick, which had quantized every pan and designed move
into 4px jumps at 8 px/tick. There is now
exactly one automatic move: a 650ms smootherstep to an endpoint fixed when it
starts, fired when the mid has stayed more than a tenth of the viewport off
centre for half a second, or when the committed zoom changes. The half second
keeps a sweep that empties the touch and refills a few packs later from being
framed at all; the fixed endpoint keeps a move from chasing a target that
jumps under it. On a phone, a move started on such a blip reversed and then
jumped the whole field 40 and 181 device px in single frames (measured
2026-09-23, headless). If the market has moved on when the move lands, the
deadband decides afresh. A hand on the zoom does not restart it (the
centre finishes its move while the hand keeps the scale), and a crossed pack
is not a target at all: live flow crosses for a message at a time, and on
live a crossing that persists is a wrong book the pipeline reseeds (~8s). A
replayed capture has no such guard, so a crossed stretch of a recording holds
the last frame. Measured over 45s
of the synthetic understudy, sampled every 100ms: centre, zoom, and length
scale each take about nine distinct values — roughly one designed move apiece,
and ~96% of frames write nothing at all. (That run predates the single commit
of the length scale described next; the scale now takes one value per book.)

The cell length scale anchors on the *visible core's* median order size, not any
global statistic — whale quotes and far-tail dust drag a global median across
decades. It is committed once per book, as a cut, and then held exactly:
lengths only ever have to be right relative to each other, and a scale that
followed the noisy median behind a 0.5 deadband still re-lengthened every cell
in the field two or three times a minute at rest (measured: x0.41 to x1.55).
It is taken on the first frame a two-sided book holds 24 orders, and taken
again only for a new book (a mode switch, or a degraded source: reseeding,
reconnecting, a hidden tab) or a layout or width the old scale no longer fits.
There is no eased move to cut in reduced motion; both modes get the same single
cut. (Recorded 2026-09-23 as an owner decision with the change: the length scale
is held once committed.) Zoom is owned by whoever touched it last: auto reframing
passes a 12% deadband before committing
(the fit breathes with every book change; chasing each breath made the field
pump), freezes while the viewer is panned away, and yields entirely to a
hand-set zoom until recenter — a viewer contemplating the whole field must
never feel the camera stir under them. The one thing that may still change a
hand-set zoom is the both-bests cap, and only by tightening it when a wider
spread has held for half a second: it never hands the scale back (a cap that
followed the spread both ways pumped the field, measured 34% peak-to-peak; one
that tightened for any single pack kept a held 4.64 px/tick at 2.06 for good
after one sweep on the recorded fixture). Travel is bounded by the book itself:
15% of a screen of slack past the last resting order, then a firm edge —
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
seam and the phone spine are two layouts of the same instanced cells. A resize or
rotation that crosses between them re-lays the same cells out in one frame, as a
cut, and the length scale is taken again for the new layout.

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
3. **Detector captions** (§11) — when the market does something while the viewer is
   engaged, one quiet sentence fades in near the top of the frame ("a sell just swept 3
   levels: $41k in 80ms"), holds, and fades out. Captions are chrome: one that
   fires at rest is dropped, not saved for later, and when the chrome hides the
   caption ends with it. The detectors keep running either way, and the
   screen-reader narration does not wait on engagement. Until 2026-09-23 captions
   fired without engagement and rose 4px as they appeared; they now show only
   while engaged, opacity only (recorded as an owner decision with the change).
4. **The explainer** — from the provenance mark: what this is, what the queue means,
   what to watch for, what is and isn't real. Three short layers, never a wall.

### Attribution and framing

The page credits its author without crowding the spell: a one-line credit sits in
the engaged chrome next to the provenance mark ("a piece by Cameron Scarpati · data:
Bitstamp"), the explainer closes with the same credit and a link to the source, and
the meta description and social-card tags carry it too. Bitstamp's attribution
(required posture, §1) and the author's credit are the only two names on the page.

Rejected composition: the Bookmap-style time-axis heatmap. The brief identifies it
as both honest and cliché; more decisively, a scrolling history axis makes the
present a thin edge of the screen, and this piece is about the *present tense* of
the queue — who is in line now, waiting. Time is shown instead where it actually
lives in a book: in the ages of the orders (luminance).
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
offset — queue prefix-sums computed in the worker), a header (BBO, spread, depth,
the camera's span hint, the book's extent, a book revision), and a meta object
beside it (mode, clocks, the tape of recent trades, the caption and narration,
stats). There is no event list: nothing on the main thread draws a trade or a
cancel. Transferred, not copied; two buffers ping-pong so steady state allocates
nothing.

The "age-base" in that list is load bearing, and for a long time the code did
not honour it: each instance carried its age at pack time, a number that
changes every frame, so no two frames were ever identical even when the market
had not moved. Instances now carry `restedAtSec` — a fact about the order,
constant for as long as it rests — and the frame's clock rides in the meta,
with the subtraction done once per vertex in the shader. The renderer still
invents nothing: both numbers come from the worker.

What that buys is the right to do nothing. Every packed frame is stamped with
the book revision it describes, and on the next request the worker compares
the stamp in the buffer handed back to it against the live book: if they
match, the bytes are still correct and the whole pack is skipped, buffer
returned untouched. The renderer reads the same stamp and skips its upload,
and — when nothing on the presentation side moved either — the draw. That last
one has two guards, because age drives brightness and the clock does advance:
it waits until the book has been still for longer than the 120ms arrival ramp
(so none is in flight), and it never lets a drawn frame get older than one
second. Past the ramp the only age effect is the ember, which moves about a
third of an 8-bit step per second, so a second of staleness is below what the
display can show. Invalidation is deliberately blunt —
any command reaching the engine, and any engine replacement, marks the frame
stale, whether or not the book actually moved — because a rule you can check
by reading one line beats one that needs every command's semantics audited.
The failure it guards against is not a crash; it is a correct-looking book
that is a moment behind the market.

The saving scales with how quiet the market is, which is the right shape for
this piece: at 60fps against the synthetic understudy's ~22 book changes a
second, roughly two thirds of packs and uploads have nothing to do. A busy
live feed at ~130 messages a second changes the book most frames and skips
little. `?hud=1` reports `packs/s` against the ~60 requested, so the real
number is readable on the device rather than argued about. The renderer draws the latest
frame it has; if two arrive between paints it drops the stale one — **resting-book
states coalesce; discrete trade events are never dropped** (every one reaches the
worker's detectors, tape and trade stats; since the sprite layer was removed
nothing is drawn from them, and the per-frame event list that used to carry them
to the main thread is gone too: the book state carries every event's
consequence).

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
0.873ms for the full 8,768-order live book (Node bench, `test/perf/pack-bench`);
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
the arrival ramp's alpha, the mode-transition dip). A pixel may move only in
response to (a) a frame-state change from the worker or (b) a presentation clock
advancing. There is no path by which renderer code can invent a price, a size, or
an ordering; the packed frame is read-only truth.

Concrete applications: the mid line sits at the real mid, never an eased one — the
*camera* moves toward it, which changes where you look, not what is there. A
modify is a death and a birth (venue semantics), never a slide. Trades are
instantaneous, and now nothing outlives them: removing an animation can only
remove an assertion, never add one. Replay time-compression is a labeled
transformation of playback time. The reduced-motion mode (§13) cuts where the full
piece eases, a change of presentation only.

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

- `● live: Bitstamp BTC/USD order flow → local matching engine`
- `● simulated: seeded from live state 14s ago`
- `● replay: recorded 2026-08-07, real Bitstamp flow`

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

A detector layer watches engine events and cues captions and the screen-reader
narration. (Detector-driven camera cues were planned and never built: no detector
reaches the camera, which moves only for the market leaving the frame or the
viewer's hand.) V1 detectors, chosen from the brief's ranking for frequency ×
payoff:

1. **Spread breathing** — ambient; carried by the composition itself, no detector.
2. **Sweep** — multi-level consumption by one aggressor side within a short window;
   caption with levels, quantity, and dollar value.
3. **Replenishment** — refill rate into swept levels; caption when a hole knits
   closed ("refilled in 21s").
4. **Cancel storm** — cancel-rate spike vs rolling baseline; caption cites the live
   cancel-to-trade ratio (routinely ~300:1, a number worth saying out loud).
5. **Liquidity vacuum** — one side thin beyond threshold; the rarest and most
   startling; celebrated when it occurs. It needs a book that has stood on both
   sides for 10s to empty from, so a book assembling from nothing (the
   understudy's cold start, or any reseed) is not narrated as a vacuum.
6. **Quiet market** — low-rate regime (3am Sunday): caption embraces it ("quiet —
   single orders are events now").

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
  absence — though the gap has narrowed to almost nothing now that the piece
  itself is still: the same designed reframes and the viewer's glides happen,
  cut instead of eased; an arrival appears with no ramp; the chrome appears and
  leaves without a fade; a caption holds and then fades out over its last 0.7s.
  The ~600ms mode dip stays, as a change of light rather than of position. Same
  information, no vestibular triggers.
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
  eased quantities are the camera, the chrome, and the arrival and mode-change
  envelopes, which describe looking, not the market.
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
