# A Live Matching Engine on the Web: Research Brief for the Builder

## TL;DR

- **Build architecture (3):** run your own correct, single-threaded matching engine, and drive it with real order-by-order flow reconstructed from Bitstamp's public `live_orders` WebSocket channel — the one free feed a browser can consume with no key and no server that actually exposes per-order identity, which is the only thing that makes queue position real.
- **The awe lives in the queue:** who is in front of whom, how long they have waited, who gets filled. Aggregated L2 feeds (Binance `@depth`, Coinbase `level2`) destroy that by summing orders into a single number per price, so they are the fallback texture, not the primary source.
- **Render** on a single WebGL canvas driven from a Web Worker via OffscreenCanvas, keep the engine on the worker, coalesce bursts to one visual state per animation frame, and treat 3am-on-a-weekend and a dropped socket as designed "resting" states rather than errors.

---

## Addendum: corrections and unresolved decisions

> **This section was added after the research, by review. It is not part of the original findings.** Three items below change architecture, so they sit here rather than at the end. Where this section and the body disagree, this section is the later word.

### A. Fill attribution is unresolved, and it blocks a headline phenomenon

`live_orders` tells you an order was deleted. It does not tell you *why*. A cancel and a fill both surface as `order_deleted`, and the two are opposite in meaning: one is liquidity withdrawn, the other is liquidity consumed. Phenomenon 4 below (queue decay under cancel-heavy quoting) is ranked a signature payoff of choosing L3 at all — and as specified it is **unbuildable**, because it requires exactly the distinction the channel does not give you. The sweep visualization has the same dependency.

The fix: subscribe to `live_trades_[pair]` alongside `live_orders_[pair]`. Bitstamp's trade events carry **`buy_order_id` and `sell_order_id`**, which join directly against the ids from `live_orders`. That join is what converts a deletion into either a fill or a cancel, and it is what lets you attribute consumed quantity to specific positions in a specific queue. Verify the field names on a live socket as part of the same five-minute check the Caveats section already prescribes.

### B. "Render the reconstruction, engine drives scenes" reduces the engine to decoration

Section 3 closes by recommending you render the reconstruction as truth and use your engine for pedagogical scenes and synthetic mode. Taken literally, that is Architecture 1 with an engine bolted alongside it — and the premise of this piece is a matching engine *made visible*.

There is also a mechanical problem underneath it. Fed only `live_orders`, your matcher would rarely match anything: orders that cross on arrival at Bitstamp largely never rest, and so never appear as `order_created`. You receive the passive side of the market, not the aggressive side. An engine fed that stream accumulates a book and then watches orders disappear from it.

**Resolution to adopt: one engine, one book, three sources.** What varies across modes is not the data structure and not the renderer — it is *who has authority to declare a match*.

- **Live:** the venue's trade stream is the matching authority. A trade event tells your engine which resting order was consumed and by how much; your engine applies that through the same queue-consumption code path it would use if it had matched internally.
- **Synthetic:** your matcher computes matches itself from agent-generated arrivals.
- **Replay:** whichever authority the recording carried, preserved.

Same structures, same invariants, same renderer, one code path for consuming a queue. The engine stays load-bearing and live mode stays honest. This also makes the source interface the brief recommends building first (see Recommendations) fall out naturally, since all three modes now differ in one well-defined place.

### C. The terms-of-service question is yours, and it gates the build, not the launch

The Caveats section calls this the open question most likely to bite and defers it to pre-launch. Move it to the front. It decides whether Bitstamp can be the spine at all, and the entire architecture rests on that one venue with no comparable second source. Confirm it before the build starts, not after it is built. The posture already recommended — consume rather than re-serve, attribute the venue by name on the page — is the one most likely to be permissible.

Related: because Bitstamp is a single point of failure, the synthetic fallback is not a nicety. It is load-bearing infrastructure and should be built early, exactly as Recommendations says.

### Verify before relying

- The `live_orders` event names and field set (already flagged in Caveats).
- The REST `order_book` `group` parameter semantics. You need **order ids in the seed snapshot**; if the group value is wrong you begin with a book that has no per-order identity, and therefore no queue at t=0 — a failure that will look like a rendering bug for hours.
- The `live_trades` field names, per item A above.
- The Field / Large / Nywall attribution for the pro-rata-versus-FIFO price-efficiency result. The *direction* of that finding is well supported; the specific paper attribution could not be confirmed in review. Do not quote it in the shipped piece without checking.

---

## Key Findings

Real order-by-order data that a browser can reach directly, with no server and no committed API key, exists but is rare. **Bitstamp is the one clean answer:** its v2 WebSocket at `wss://ws.bitstamp.net` publishes a public `live_orders_[pair]` channel that emits an event for every individual order as it is created, changed, and deleted, carrying an order id, side, price, amount and microsecond timestamp. That is genuine Level 3 / market-by-order data, and it is the substance the whole piece needs.

Coinbase publishes the same order-by-order richness on its `full` and `level3` channels, but both now require authentication, which kills the "no key in a public repo" constraint. Binance is generous and reliable but only exposes aggregated depth, so it can never show you the individual orders inside a price level.

The correct move is therefore neither to render someone else's book nor to fake flow, but to feed Bitstamp's real per-order events into your own deterministic matching engine and render that. You inherit real texture and real consequences while owning the engine, the timeline, the pause button, and the failure behavior.

---

## Details

### 1. Matching engine truth

**The book.** A limit order book is two sorted collections, bids descending and asks ascending by price. Each price level holds a queue of individual resting orders. In a price-time (FIFO) venue that queue is strictly ordered by arrival — first in line gets filled first. The best bid is the highest buy price with resting size, the best offer (ask) the lowest sell price; the difference is the spread, and the midpoint is (best bid + best ask) / 2. Depth is just the resting size at each level; "the book" as a shape is depth plotted against price.

The standard implementation is a map from price to a level object, where each level owns a doubly linked list or ring of orders so that cancels from the middle are O(1) and fills from the front are O(1); a secondary hash from order id to its node lets cancels and modifies find their target without scanning.

**Allocation algorithms.** Price is always the first priority. What differs is how orders at the same price share an incoming fill. *Price-time priority (FIFO)* rewards whoever arrived first and is the near-universal rule for equities and for most crypto. *Pro-rata* ignores time and splits the incoming quantity across resting orders in proportion to their size, so a larger order gets a larger share regardless of when it arrived.

Eurex, which applies pure pro-rata to products such as EURIBOR Futures and options on iShares ETFs, states the rationale plainly in its "What actually is … pro rata matching?" note: *"Pro rata matching guarantees constant access to the inside market for orders irrespective of their size."* The reasoning is that when volatility is low, large orders under FIFO would sit at the front and block smaller ones from ever reaching the inside.

Hybrids exist because each pure rule has a pathology. CME runs several: a FIFO-with-LMM variant, and an "Allocation" (pro-rata) algorithm used for SOFR futures that grants a "TOP" order priority when it is the first to better the market, then allocates the rest pro-rata with a two-lot minimum and FIFO for the leftovers.

The academic point worth encoding comes from Field, Large and Nywall's "Precedence rules in matching algorithms" (*Journal of Financial Markets*), which exploited the unexpected May 11–12, 2015 switch of the 2-year Treasury future from partial pro-rata to FIFO: *"compared to FIFO, orders placed later in time are significantly more profitable under pro-rata. However, the lower profitability of earlier orders in the queue under pro-rata matching causes prices to be less efficient under pro-rata rules."* In other words, time priority is what rewards the fast liquidity providers who tighten the market.

For the piece, FIFO is the right default because queue position is visible and meaningful; a pro-rata mode is a spectacular secondary scene because fills rain across the whole level at once instead of eating it front to back.

**Queue position and what it is worth.** In FIFO, your position in line is an asset. If you are 400 lots deep in a 1,000-lot level, 400 lots of trading (or cancels ahead of you) must clear before you fill. This is precisely what L3 data lets you see and L2 hides. CME built an entire market-by-order (MBO) product so participants could track "their exact queue positions," because in a large-tick, deep-queue instrument the difference between position 2 and position 200 is the difference between a profitable and an unprofitable market-making strategy.

**Order types, at the moment of arrival and as they rest.** A *limit* order rests at its price if it does not cross; if it crosses, it executes against the far side up to its limit and rests any remainder. A *market* order takes liquidity immediately at whatever prices are available and never rests. *Immediate-or-cancel (IOC)* takes what it can right now and cancels the rest, leaving nothing on the book. *Fill-or-kill (FOK)* is all-or-nothing and immediate: if the full size cannot be filled at once, none of it is. *Good-til-canceled (GTC)* rests until filled or pulled; *DAY* expires at session end; *GTD* expires at a stated time.

*Post-only* guarantees the order will only ever add liquidity: if it would cross and take, the venue rejects or reprices it, which is how makers avoid taker fees. A *stop* order is dormant and invisible to the book until its trigger price prints, at which point it becomes a market (stop) or limit (stop-limit) order and enters the normal lifecycle; Coinbase emits a distinct `activate` message when a stop is placed and only reveals it as a real order when triggered.

*Iceberg/reserve* orders show a small displayed slice and hide the rest; when the slice fills, the next slice is revealed and, crucially, usually goes to the back of the queue with a fresh timestamp. *Hidden* orders show nothing at all and typically yield priority to displayed orders at the same price. *Pegged* orders reprice automatically to a reference: primary peg to the same-side best, market peg to the opposite side, midpoint peg to the middle; London Stock Exchange's mid-price pegged orders even "park" when the midpoint moves outside a limit and re-inject when it returns.

**The lifecycle and what is public.** An order's life is: new (submitted) → ack (accepted) or reject → possibly partial fill(s) → fill (done) or cancel or expire, with cancel-replace (modify) as a step that can reset queue priority.

Coinbase's `full` channel is an unusually honest window onto this: `received` fires for every accepted order before it is on the book, `open` fires only when an order actually rests (with `remaining_size`), `match` fires on every trade and names the maker and taker order ids and the maker's side, `change` fires on a self-trade-prevention adjustment or a modify (carrying `old_size`/`new_size` or `old_price`/`new_price`), and `done` fires on fill or cancel with a reason.

What is public varies by venue: on most equity feeds you see anonymous adds, cancels, executions and the resulting book, but not the reject, not the owner, and not internal states. The `received`-before-`open` distinction Coinbase exposes is rare, and it matters because it lets you show an order being *considered* before it either rests or immediately trades.

**Matching mechanics.** The arriving order is the *aggressor* (taker); the resting order it hits is the *maker*. When a market buy is larger than the best offer's size, it walks (sweeps) up the ask side, eating level after level and printing a trade at each, which is why a big market order moves the price: it is literally consuming the book. *Price improvement* happens when an order executes at a better price than its limit because a resting order was there to give it. *Self-trade prevention* stops a participant's own orders from matching each other, cancelling or decrementing one side.

Tick size, the minimum price increment, quietly shapes everything. The SEC's Tick Size Pilot Program (approved May 2015, launched October 2016) forced a set of small-cap stocks from a one-cent to a five-cent quoting increment; SEC DERA and NYSE analyses found that displayed depth at the best quotes rose for the test groups while quoted and effective spreads widened for tick-constrained names (average quoted spread around 5.5 cents), because a coarse tick forces liquidity to pile into fewer levels and lengthens every queue. (One SEC working-paper figure puts the median depth increase for the most tick-constrained stocks as high as 108%; treat the exact magnitude as indicative rather than settled.)

The direction is the design lesson: **fine ticks give you a smooth, shallow, many-level book; coarse ticks give you a blocky, deep, few-level book with long visible queues.** This is a visual dial, not a footnote.

**Sequencing and determinism.** Real engines are single-threaded per symbol on purpose. A single sequencer thread linearizes all arrivals into one total order and stamps each with a monotonically increasing sequence number; that sequence number, not the wall clock, defines time priority. The order with the lower sequence number arrived "first," by definition.

This is what makes the engine a deterministic state machine: the same ordered input always yields the same output — on the primary, on the hot standby, and on an end-of-day replay for audit. Parallelism comes only from running different symbols on different cores, never from splitting one book.

Downstream, every market-data message carries that sequence number so consumers can detect a gap (a missing number) and resync. Coinbase's `heartbeat` channel exists precisely so a client can confirm no messages were missed; Binance's diff-depth stream carries a first and final update id (`U` and `u`) per message so you can prove continuity across the snapshot boundary.

**Auctions.** Continuous trading is interrupted at the open and close by an auction (a "cross"). Orders are collected but not matched during a display-only period; the venue disseminates an indicative price and an imbalance. At the bell, the engine computes the single *uncrossing price* that maximizes executable volume, ties broken by minimizing the imbalance and then minimizing the move from the reference midpoint. Nasdaq disseminates its Net Order Imbalance Indicator every second or two in the minutes before the cross, showing reference price, paired shares, and imbalance shares.

This is one of the only moments a market visibly resolves a whole accumulated tension into one number, and Nasdaq's own Closing Cross FAQ states that *"almost 10% of Nasdaq's average daily volume occurs in the closing auction"* (a separate Nasdaq webinar puts the opening and closing auctions together at more than 16% of daily volume on average, and above 25% on ETF-rebalance days). It is a first-class candidate for a set-piece scene: the book freezes, the imbalance glows on one side, the indicative price hunts, and then everything crosses at once. Bitstamp exposes an `auction` message with an indicative `open_price`/`open_size` and `can_open` flag, so this is buildable from real data.

**Volatility controls.** US equities have Limit Up-Limit Down (LULD): price bands set as a percentage above and below a rolling five-minute reference price. Quotes are not allowed to execute outside the band; if the market sits at the band for 15 seconds it enters a Limit State, and if it cannot correct within that window the primary exchange calls a five-minute trading pause, after which it reopens with an auction. Bands are wider (10%/20%) near the open and close and tighter (5%/10%) midday for the most liquid names. Market-wide circuit breakers halt everything at S&P 500 declines of 7% (Level 1), 13% (Level 2), and 20% (Level 3). These are rare but visually dramatic: the book empties, the pause counts down, and the reopening auction resolves it.

**Across asset classes.** *Equities* are FIFO, fragmented across many venues, with a consolidated tape and auctions and LULD; true order-by-order feeds (Nasdaq TotalView-ITCH) exist but are paid and not browser-reachable. *Futures* (CME) are single-venue per contract, offer FIFO and pro-rata and hybrids, and sell MBO data but not to an anonymous browser. *Crypto* is the outlier that makes this project possible: several venues run continuous FIFO books and publish market data over public WebSockets with no key, and a small number (Bitstamp, and Coinbase behind auth) publish true order-by-order events.

### 2. The phenomena worth showing, ranked

Ranked by visual payoff per unit of implementation effort; each entry flags how often it occurs in a short viewing session.

1. **The spread breathing.** The best bid and offer constantly nudge in and out as orders arrive and cancel; the spread widens under stress and knits back together. Physically, it is orders being added and pulled at and near the top of book. In the data it is a stream of adds and cancels at the best levels. It happens continuously, every second, so it carries the opening three seconds. Lowest effort, highest presence. A viewer learns that price is not a point but a living gap.

2. **Liquidity replenishment after a sweep.** A market order eats several levels; then new limit orders pour back in to refill the hole. Jeremy Large's "Measuring the resiliency of an electronic limit order book," modelling LSE order flow as a ten-variate Hawkes process, found that *"in over 60 per cent of cases, the order book does not replenish reliably after a large trade. However, if it does replenish, it does so with a fairly fast half life of around 20 s"*; equity studies find large, competitive names refill within about a minute. Frequent enough to see several times in ten minutes on an active pair. Teaches resiliency, the third dimension of liquidity after spread and depth.

3. **A large market order walking down five levels.** One aggressor prints a trade at each level as it consumes them and the mid lurches. In L3 you see individual resting orders wink out in sequence. Common on an active crypto pair. Teaches that price impact is mechanical, not magical.

4. **Queue decay under cancel-heavy quoting.** Most orders never trade; they are cancelled. In crypto L3 the median order lifetime is often just a few seconds. Visually, a level flickers as orders join the back and vanish from the middle. Constant, and only visible with L3, so it is a signature payoff of choosing real per-order data. Teaches that a quoted price is a promise that is mostly withdrawn. *(See Addendum A — this one requires the trade-stream join to be buildable at all.)*

5. **The opening/closing cross resolving an imbalance.** Described above. Rare in a live session (twice a day per venue, and crypto runs 24/7 without a formal cross), so it must be staged from a replay or from your synthetic mode. Highest per-moment drama.

6. **An iceberg revealing itself slice by slice.** A hidden reserve refills a small displayed slice each time it trades, so the same price level keeps regenerating a suspiciously constant displayed size. In L3 you can sometimes infer it: repeated new order ids at one price, each appearing right after a trade. Occasional. Teaches that the visible book is not the whole book.

7. **Market-maker inventory skew.** A maker who has accumulated a long position lowers both quotes to encourage selling and discourage buying; the whole two-sided quote leans. Continuous but subtle, and hard to attribute from anonymous data, so it is most honestly shown in your synthetic mode where you own the agents' inventories.

8. **Adverse selection around news.** Just before a sharp move, informed flow hits stale quotes and makers widen defensively. Visible as a sudden spread blow-out and one-sided sweeping. Sporadic; you cannot schedule it. Teaches why spreads exist at all (the Glosten-Milgrom insight that the spread compensates for trading against someone who knows more).

9. **Volume clustering and the intraday curve.** Activity is U-shaped over a session, heavy at open and close. Only visible over long windows, so it suits a time-compressed replay, not a live view.

10. **Liquid vs illiquid texture, side by side.** A large-tick liquid instrument is a dense cushion near the mid with long queues; a small-tick illiquid one is a sparse, gappy field with a wide spread. Showing two at once is the single clearest way to teach what liquidity feels like.

A **liquidity vacuum** (the book momentarily near-empty on one side) is a special case of the sweep-plus-slow-replenish combination and is the most genuinely startling to watch; it is uncommon and worth detecting and celebrating when it happens.

### 3. Where the data comes from — the resolved decision

**The constraint, stated precisely.** The beauty is in the per-order queue. That requires order-by-order (L3 / market-by-order) data, where each message concerns one identified order. Most free public feeds are market-by-price (L2): you get "400 units at this price," an aggregate that has already thrown away the twelve orders and their arrival order that compose it. **You cannot reconstruct queue position from L2, ever.** So the data question is really: can a browser get L3, for free, with no key, over a WebSocket, from a venue whose terms allow showing it publicly?

**What a browser can reach directly.** WebSocket connections are not subject to CORS. The same-origin policy governs HTTP response bodies read by fetch/XHR; a WebSocket upgrade completes on a 101 and then speaks its own protocol, so the browser never blocks it on cross-origin grounds and never runs a preflight (RFC 6455; origin enforcement is the server's job, not the browser's). This is why a static page with no server can hold a live market-data socket at all. The practical caveats are that the page must be served over HTTPS (so the socket must be `wss://`, mixed content is blocked) and that the REST snapshot fetch you need alongside the socket is a normal cross-origin HTTP request that *does* depend on the venue sending permissive CORS headers.

**Who exposes what, concretely.**

*Bitstamp*, `wss://ws.bitstamp.net`, is the key finding. Public, no key. Subscribe by sending `{"event":"bts:subscribe","data":{"channel":"live_orders_btcusd"}}`; the server acknowledges with `bts:subscription_succeeded`. You then receive `order_created`, `order_changed`, and `order_deleted` events, each with a `data` object carrying `id` (integer) and `id_str` (string), `order_type` encoded as an integer where 0 = buy and 1 = sell, `price`/`price_str`, `amount`/`amount_str`, `datetime` (Unix seconds) and `microtimestamp` (Unix microseconds). This is true order-by-order data.

It has one important gap: the `live_orders` channel does not send an initial snapshot, so you must seed the book from the REST endpoint `https://www.bitstamp.net/api/v2/order_book/btcusd/` (with `group=2` to get order-level rather than aggregated data) and then apply the live events. The server can force a reconnect with a `bts:request_reconnect` control message, and after any reconnection you must re-subscribe.

*Binance*, `wss://stream.binance.com:9443`, is public, no key, extremely reliable, but **aggregated only**. The `@depth` diff stream sends bid/ask updates as `[price, quantity]` where quantity is the new absolute total at that price, not a delta, and each message carries `U` (first update id) and `u` (final update id). You reconstruct by buffering diffs, fetching a REST snapshot from `https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5000`, discarding buffered events with `u` ≤ the snapshot's `lastUpdateId`, and applying the rest. It disconnects any connection at 24 hours and pings every 20 seconds expecting a pong. Good for L2 texture and as a fallback, useless for queue position.

*Coinbase*, `wss://ws-feed.exchange.coinbase.com`, has the best-documented order-by-order model (`full` and `level3` channels with `received`/`open`/`match`/`change`/`done`), but those channels now require authentication, so they violate the no-committed-key rule for a public static site. Its `level2_batch` channel is public but aggregated (50ms batches).

**Book reconstruction, and how it silently goes wrong.** The universal pattern is snapshot-plus-delta: take a numbered snapshot, then apply numbered incremental updates, using the sequence/update ids to stitch them together. The failure modes are specific and each produces a book that *looks fine but is wrong*:

- Apply a delta whose id precedes the snapshot → you double-count.
- Miss a delta (a gap in the sequence) and keep going → your book silently diverges and never self-heals, because these feeds send absolute state per level, not periodic full refreshes.
- Treat an L2 "new size" as a delta to add rather than a value to replace → every number inflates.
- Leave a level whose size went to zero → phantom liquidity.

The only safe design is to **detect any gap and, on detection, throw the book away and re-snapshot**; never try to patch across a gap. For Bitstamp L3 specifically, an `order_deleted` for an id you never saw created (because it predates your snapshot) must be ignored, not treated as an error, and a periodic full re-snapshot on a timer is cheap insurance against slow drift.

**Operational reality.** Crypto never closes, which is a gift: there is no nightly dead market to explain, though weekends and small hours are genuinely quiet and thin, which is itself worth showing rather than hiding. Message rates are modest most of the time and then spike hard during a move; a single busy pair can exceed a few hundred messages a second in a burst, which is fine for a socket but must never translate to more than one repaint per frame. On a phone on cellular, an always-on socket plus continuous WebGL animation is a real battery and data cost; the honest design throttles or pauses when the tab is hidden (the Page Visibility API) and offers a reduced mode. There is no rate limit that bites a single-pair subscriber, but there are limits (Binance caps streams per connection and connections per IP) that matter if you fan out to many pairs.

**Terms and attribution.** These are public market-data feeds intended for application use, but redistribution terms differ and are not the same as "do whatever." The safe posture for a public art piece is to attribute the venue by name on the page ("live order flow from Bitstamp"), to consume rather than re-serve the raw feed (do not stand up a public relay of their data), and to label clearly that the venue is the source and your engine is the renderer. Treat this as an open question to confirm against each venue's current terms, because these terms change and violating them can get an IP or key banned. *(See Addendum C — confirm this before building, not before launching.)*

**The three architectures, and the recommendation.**

*Architecture 1, render a real venue's book directly*, is the least work and the most authentic in one narrow sense (it is exactly their book) but it inherits their outages, their aggregation, and their pauses, and with a free feed you are almost always rendering L2, so you never get queue position. **It fails the core premise.**

*Architecture 2, your own engine on synthetic agent-driven flow*, is always alive, seedable, replayable, and lets you stage the cross and the crash on cue. Its cost is honesty: nobody's money is on the line, and a sophisticated viewer can feel the difference between real cancel-heavy noise and a tasteful simulation. Keep this, but as a mode, not the spine.

*Architecture 3, real flow into your own engine*, **is the recommendation.** You take Bitstamp's real `live_orders` events as the arrival stream, run them through your own deterministic FIFO engine, and render that. You get real texture (real cancel storms, real sweeps, real quiet weekends), a real matching engine whose rules you can show truthfully, and full control of time and failure.

The honest characterization of its approximation: you are *reconstructing*, not receiving, the venue's internal state; your engine's matching of the reconstructed stream will differ from Bitstamp's actual matches at the margins (because you lack their exact internal sequencing and any hidden or auction liquidity), and you must say so. *(For how the engine and the reconstruction relate, follow Addendum B rather than the original formulation, which reduced the engine to a scene driver.)*

**The degradation path, designed as content, not error.** When it is 3am and thin, lean in: slow the camera, let single orders become events, and label it "quiet market." When the socket drops or Bitstamp forces a reconnect, cross-fade seamlessly to your synthetic engine seeded from the last real book state, so the market keeps breathing while you reconnect in the background; the viewer should never see a spinner. When a device should not be streaming (hidden tab, reduced-motion preference, metered connection, low battery if detectable), fall back to a gentle replay of a recorded real session, which looks identical but costs nothing to receive.

The rule is that **the piece is never "down"**; it degrades along a gradient from live real, to live synthetic, to recorded replay, and each is beautiful.

**Labeling, so nothing lies without breaking the spell.** Adopt a small, always-present, low-key provenance mark — a single unobtrusive line or glyph — that states the current mode in plain words: "live · Bitstamp BTC/USD," or "simulated," or "replay." Anything interpolated for smoothness (a camera ease, a fade) is fine and need not be labeled because it is presentation, not data; anything that changes what the viewer would conclude about the market (a synthetic order, an inferred iceberg, a filled gap) must be marked as inferred or simulated. The discipline is: **truth of data is labeled by mode; truth of motion is handled by the rules in section 4.**

### 4. Making it beautiful without making it lie

**Prior art, and what to steal or avoid.** The dominant serious visualization is the Bookmap-style liquidity heatmap: price on the vertical axis, time flowing right to left, resting size encoded as brightness, with executed trades as dots sized by volume. It is beautiful and, importantly, honest, because it shows where liquidity waited and for how long, adding the time dimension a static ladder lacks. It is also now a cliché of trading Twitter, so borrow its truthfulness (time as an axis, size as brightness) without copying its exact look.

The classic depth chart (cumulative bid and ask as two mirrored area curves meeting at the mid) is instantly readable and genuinely useful but visually tired, and it hides the per-order structure entirely. Academic work has pushed further: Nasdaq-ITCH-based order-book heatmaps used by regulators (Paddrik et al.'s regulatory LOB visualizations), and a striking line of research by Verhulst and Pennings that visualizes the limit order book "using a particle physics lens," treating orders as particles — the closest prior art to the ants-and-cities feeling you want.

The DOM ladder (the raw two-column price/size table) is the traders' native view and the thing to react against: it is all truth and no awe. The misleading-but-pretty trap to avoid is any visualization that animates a smooth price line, because it invents motion between two real points that never existed.

**Encoding, and where the standard encodings quietly lie.** *Position* along the price axis is your most trustworthy channel; spend it on price, which is the one quantity that is genuinely ordered and metric. *Length and height* are honest for size and depth because they are proportional and start from a common baseline. *Area lies*: encoding size as the area of a blob makes viewers systematically under-read big values, because human area perception is compressive, so if you use bubbles for order size, the tens are perceptually far more than ten times the ones. *Opacity and brightness* are good for age or size but only ordinally; do not ask a viewer to read a precise number off a brightness.

*Hue* is dangerous twice over: it carries no magnitude, and the reflex of red-for-sell/green-for-buy fails the roughly 8% of men (and about 0.5% of women) with red-green color vision deficiency. Use a redundant channel for side (position — left vs right or up vs down — plus a colorblind-safe pair such as blue/orange rather than red/green), never hue alone.

*Motion* is the most seductive liar of all: animation implies causation, so if two things move together the viewer infers one caused the other. Reserve motion for things that actually move in the data (an order arriving, a trade printing, a level being consumed) and never animate a transition that did not happen.

**Motion design, the precise line.** The rule is: **interpolate presentation, never interpolate data.**

Fine, because they describe *how you are looking*: a camera pan, a zoom, a fade of an element as it is removed, an eased color change.

Forbidden, because they assert false facts about the market: smoothing a price path; tweening the book from one state to a later state through intermediate states that never existed; easing an order from its old price to a new price on a modify (it did not slide — it was cancelled and re-added).

A trade is instantaneous; show it as an instantaneous event (a flash, a spark) and let the decay of that flash be the only animated part, because the decay is presentation. When an order is cancelled it vanishes at a specific instant; you may fade the pixels over roughly 100ms so the eye can track the loss, but the data-time of the event is the instant, not the fade. Position on the price axis must always reflect the real current price, never an interpolated one. If you time-compress a replay, that is a *stated transformation of time*, which is honest as long as it is labeled; smoothing within real time is not.

**The mobile problem.** An order book is a tall, two-sided, price-indexed object and a portrait phone is a tall narrow window, which is actually a better fit than it first appears. Do not reflow the desktop side-by-side depth chart into a cramped phone version; compose a genuinely different view of the same truth.

The natural phone composition is vertical: price increasing upward, asks stacked above the mid, bids below, the spread as a living gap in the center of the screen, and time either compressed away or flowing as a subtle vertical drift. This uses the phone's long axis for price (the ordered quantity that deserves the most space) and puts the most important thing — the spread and the top of book — dead center where the thumb and eye rest. The desktop view can afford the horizontal time axis of a heatmap; the phone view should privilege the instantaneous cross-section and the immediate action at the touch. Same data, same engine, two honest compositions.

**Accessibility of a fast, dense, motion-defined thing.** Three hard problems.

*Color:* never rely on red/green for side; encode side by position and by a CVD-safe palette (the Viridis family and ColorBrewer palettes are the well-tested defaults), and test with a simulator such as Color Oracle.

*Motion:* `prefers-reduced-motion` is set by people for whom this kind of continuous animation causes real discomfort, and the whole content is motion, so you cannot simply stop. The honest response is a distinct reduced-motion mode that keeps the information and kills the vestibular triggers: no camera movement, no flying particles, no continuous drift; instead update the book as discrete, gentle cross-fades at a slower cadence, so a viewer still sees the market change without the swimming feeling.

*A non-visual description:* a meaningful live text alternative is not "a chart of the order book"; it is a periodically updated, screen-reader-friendly summary of the actual state and its notable events — "spread 2 dollars, bid stacked three-to-one over offer, large sell just swept two levels" — updated on a cadence a screen reader can keep up with (every few seconds, not every tick), exposed via an ARIA live region. That description is also a good design forcing function: **if you cannot say what is happening in a sentence, the visual may not be saying it either.**

### 5. Making it run at 60fps on a phone

**Rendering substrate.** The realistic options are SVG/DOM, Canvas 2D, and WebGL. SVG keeps every element as a retained DOM node and degrades past a few thousand nodes; a live book with thousands of frequently-changing orders would thrash the DOM and is out. Canvas 2D comfortably handles on the order of 1,000–3,000 simple draws per frame at 60fps on a mid laptop and is far easier to write, debug, and get crisp text from; it is the right choice up to a few thousand simultaneously-drawn elements and is a perfectly good place to start. WebGL sustains tens of thousands of simple elements at 60fps by pushing instanced geometry to the GPU, and it is the only substrate that will hold 60fps on a mid-range phone once you are drawing tens of thousands of individual orders.

The recommendation is **WebGL as the primary substrate**, with per-order elements drawn as instanced quads, and a Canvas 2D layer composited on top for text and axes (WebGL text is notoriously painful; the standard trick is to render text to a Canvas once and upload it as a texture). The recommendation **flips to Canvas-only** if the final aesthetic turns out to use aggregated levels rather than tens of thousands of individual orders, in which case the element count is in the hundreds and WebGL is over-engineering.

Decide the substrate by the maximum simultaneous element count the chosen aesthetic implies, and measure on a real phone before committing. (WebGPU beats WebGL only past roughly 500 draw calls per frame and is not yet universal on the long tail of Android, so it is not the base bet.)

**Keeping the engine off the render thread.** Run the WebSocket, the book reconstruction, and the matching engine in a Web Worker, and render on the main thread — or better, transfer the canvas to the worker with `transferControlToOffscreen()` so the worker both computes and draws while the main thread stays free for input and the DOM. OffscreenCanvas is transferable and has been Baseline "widely available" across browsers since March 2023 (Chrome 69+, Edge 79+, Firefox 105+, Safari 16.4+ on macOS and iOS, released 27 March 2023), so it is safe to rely on for this project.

The cost to watch is the boundary crossing: `postMessage` structured-clones by default, which for a large book every frame is real overhead, so pass state across the boundary as a pre-packed binary `ArrayBuffer` (or a `SharedArrayBuffer` if you can meet its cross-origin-isolation headers) **transferred, not copied**, and lay the book out as typed arrays (parallel arrays of price, size, side, age) rather than objects, so both the transfer and the GPU upload are cheap.

**Backpressure.** Events will arrive faster than 60 frames a second during a burst. The four responses cost different amounts of truth.

*Coalescing* (accumulate all events since the last frame and render only the resulting state once per frame) costs nothing meaningful, because the intermediate states between two 16ms frames were never perceptible anyway; this is the default and the right one for the resting book.

*Dropping* (discard events) loses trades and is a lie about what happened, so **never drop trade prints**; you may drop redundant intermediate resting-size states because only the latest matters.

*Batching* (render every Nth event) desyncs wall-clock from engine time and looks laggy under load.

*Slowing engine time* (let the engine fall behind real time under load and catch up) is honest only if you show it — and it is exactly the mechanism for a deliberate slow-motion scene.

The rule: **coalesce resting-book state to one repaint per frame, but preserve every discrete trade event as a first-class thing to animate** even if several land in one frame (draw them all, staggered within the frame's decay, not merged into one).

**Time.** Keep three clocks distinct. *Engine time* is defined by the event sequence and is the only clock in which matching is meaningful. *Wall-clock time* is now. *Playback time* is your controllable cursor over recorded or buffered events.

A live feed does not pause, so "pause" must mean pause playback time while continuing to buffer real events into a growing queue behind the cursor; on resume you either fast-forward through the buffer (time-compressed, labeled) or hard-cut back to live (dropping the buffer, labeled). Speed control is a scaling of playback time against wall-clock and only works on buffered or recorded data, never on the live edge. Make it explicit in the UI which clock the viewer is riding, because the difference between "you are watching live" and "you are 40 seconds behind, catching up" is exactly the kind of thing that must not lie.

**Measuring on a real phone.** Desktop emulators lie about GPU and thermal behavior, so measure on actual mid-range hardware. In the browser, use `requestAnimationFrame` timestamps to compute per-frame delta and log the distribution (you care about the 95th and 99th percentile frame time and the count of frames over 16.7ms, not the mean), and use the Long Animation Frames API (shipped in Chrome 123) to catch main-thread stalls over 50ms with attribution to what caused them.

For ground truth below the browser, Android's `adb shell dumpsys gfxinfo` reports janky-frame counts and the Perfetto FrameTimeline shows real GPU-inclusive frame times; on iOS the Xcode Instruments Core Animation and Time Profiler instruments show real device FPS and where main-thread time goes. Watch **thermal throttling** specifically: a phone holds 60fps for a minute and then drops as it heats, which no emulator will show you, so run the measurement for several minutes, not seconds.

---

## Recommendations

**Start by building the deterministic FIFO engine and a faithful Bitstamp `live_orders` reconstruction as two separate, testable modules**, because everything else depends on them being correct. Validate the reconstruction by diffing your rebuilt top-of-book against Bitstamp's own aggregated `order_book` REST snapshot every few seconds and alerting on divergence. *The benchmark that lets you proceed:* your reconstructed best bid/offer matches the venue's within one tick continuously for an hour on BTC/USD.

**Next, prove the render path on a real mid-range phone with dummy data** at the maximum element count your aesthetic implies, before you commit to WebGL versus Canvas. *The threshold that decides it:* if the aesthetic needs more than about 3,000 simultaneously-drawn elements at 60fps, go WebGL with OffscreenCanvas in a worker; if fewer, stay on Canvas 2D for the far lower implementation and debugging cost. Re-measure after each visually heavy feature, and treat a sustained 99th-percentile frame time over 16.7ms on the target phone as a stop-and-fix, not a nice-to-have.

**Then wire the degradation gradient (live real → live synthetic → recorded replay) early, not last**, because it changes the architecture: the synthetic engine and the replay must consume the exact same event interface as the live feed, so build that interface first and make all three sources implementations of it. *The benchmark:* you can pull the network cable mid-session and see no spinner, only a labeled, seamless cross-fade to synthetic.

**Build the phenomena as a small scene system on top of the engine:** a detector that watches the live stream for a sweep, a vacuum, a replenishment, or a cancel storm and cues the camera and labeling when one occurs, plus scripted scenes (the cross, the crash) that only run in synthetic or replay mode where you can stage them. Ship the spread-breathing and sweep-and-replenish behaviors first because they are the highest payoff per effort and are always present; add the cross and the iceberg reveal once the spine is solid.

**Hold the line on the two truth rules throughout:** label the data by mode with an always-present provenance mark, and never interpolate data (only presentation). If a reviewer cannot tell from the screen whether they are watching live Bitstamp flow or your simulation, that is a bug of the same severity as a wrong number.

---

## Caveats

The exact event strings on Bitstamp's `live_orders` channel (`order_created`/`order_changed`/`order_deleted`) and the precise current field set (the string-form fields and `microtimestamp`) are corroborated across multiple independent client libraries and the Tardis.dev capture documentation, but they could not be read verbatim from bitstamp.net because that page is a JavaScript app that returns no server-side HTML. Confirm against a live socket connection before building the parser — it is a five-minute check. That the `live_orders` and `diff_order_book` channels are public and keyless, that the subscription envelope is `bts:subscribe` with a `data.channel` field, and that Bitstamp does not send an initial snapshot on them (so you must seed from REST), are well corroborated and safe to rely on. The `order_type` 0=buy / 1=sell encoding is directly confirmed in sample data.

Architecture 3's central honesty caveat bears repeating: **you are reconstructing Bitstamp's book from its public event stream and running it through your own engine**, so your matches can differ at the margin from Bitstamp's actual internal matches, and the piece must never claim to be Bitstamp's engine — only Bitstamp's flow through yours.

Redistribution terms for each venue's public feed are the one thing that could not be fully resolved and that carries real consequence. Before any public launch, confirm Bitstamp's (and any fallback venue's) current terms of service permit consuming and visually redistributing the feed in this way, and attribute the venue by name. This is the open question most likely to bite.

The SEC Tick Size Pilot's exact depth-increase magnitude (one working paper cites up to 108% for the most tick-constrained stocks) should be treated as indicative; the robust, well-corroborated finding is only the *direction* — coarser ticks concentrate more displayed depth into fewer, longer-queued levels and widen spreads.

**Two things looked for and not found:** a free, browser-reachable, keyless, true order-by-order feed for equities or futures (they exist only as paid, non-browser products like Nasdaq TotalView-ITCH and CME MBO, so the real-L3 premise is only satisfiable in crypto); and a second free crypto venue as clean as Bitstamp for public L3 (Coinbase has the richest model but now gates it behind authentication, so **Bitstamp is effectively your single source and you should design for its outages accordingly**).

---

## Glossary

- **Aggressor / taker** — the incoming order that removes liquidity by matching against a resting order.
- **Ask / offer** — a resting sell order; the best ask is the lowest sell price.
- **Best bid and offer (BBO)** — the highest bid and lowest ask currently resting.
- **Bid** — a resting buy order; the best bid is the highest buy price.
- **Cancel-replace / modify** — changing a resting order's price or size; usually resets time priority.
- **Circuit breaker** — a market-wide trading halt triggered by a large index decline (7/13/20% for the S&P 500).
- **Cross / auction** — a batched matching event (open/close) that computes one uncrossing price maximizing executable volume.
- **Depth** — resting size available at a price level or cumulatively across levels.
- **Diff / delta stream** — incremental book updates applied on top of a snapshot.
- **FIFO / price-time priority** — same-price orders fill in arrival order.
- **FOK (fill-or-kill)** — execute the full size immediately or cancel entirely.
- **Iceberg / reserve** — an order showing a small slice with a hidden remainder that refills, usually to the back of the queue.
- **IOC (immediate-or-cancel)** — execute what is available now, cancel the rest.
- **L1 / L2 / L3** — top-of-book / aggregated-by-price (market-by-price) / order-by-order (market-by-order).
- **Limit order** — an order with a worst acceptable price; rests if it does not cross.
- **LULD (limit up-limit down)** — US equity price bands with a limit state and a five-minute pause.
- **Maker** — the resting order that provides liquidity in a trade.
- **Market order** — takes available liquidity immediately at any price; never rests.
- **MBO / MBP** — market-by-order (each order individually) / market-by-price (aggregated per price).
- **Midpoint** — the average of best bid and best ask.
- **NOII** — Nasdaq's Net Order Imbalance Indicator, disseminated before a cross.
- **Pegged order** — an order whose price tracks a reference (primary, market, or midpoint peg).
- **Post-only** — an order that will only add liquidity; rejected or repriced if it would take.
- **Pro-rata** — same-price orders fill in proportion to size, ignoring arrival time.
- **Queue position** — how many units rest ahead of your order at its price; visible only in L3.
- **Resiliency** — how fast and reliably the book refills after a liquidity shock.
- **Sequence number** — a monotonic id defining total event order and detecting gaps.
- **Self-trade prevention (STP)** — rules stopping one participant's orders from matching each other.
- **Snapshot** — a full picture of the book at one sequence number; seed for delta application.
- **Spread** — best ask minus best bid.
- **Stop / stop-limit** — an order dormant until a trigger price, then becoming a market or limit order.
- **Sweep / walk the book** — one aggressor consuming multiple price levels.
- **Tick size** — the minimum price increment; coarse ticks produce deep, blocky, few-level books.
- **Uncrossing price** — the single auction price that maximizes matched volume.
