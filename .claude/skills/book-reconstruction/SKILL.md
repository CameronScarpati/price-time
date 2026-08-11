---
name: book-reconstruction
description: Use when changing anything in src/sources/bitstamp/ or src/sources/replay/ — seeding, the event chain, gap handling, divergence, or reconnect behavior. Every failure mode here produces a book that LOOKS correct and is wrong.
---

# Book reconstruction and resync

The live book is rebuilt from a REST snapshot plus a WebSocket event stream.
Nothing here self-heals: a book that drifts stays wrong forever while looking
plausible. These procedures exist because each one closes a failure mode we
either hit during the build or the brief documents from real systems.

## The seeding procedure (order matters)

1. Open the socket, subscribe `live_orders_` + `live_trades_`, and **buffer**
   every normalized event from that moment.
2. Fetch `order_book/<pair>/?group=2`. Entries are `[price, amount, order_id]`;
   listing order within a price IS queue order (verified: ascending ids).
3. Apply the snapshot as one `seed` command.
4. Drain the buffer through the engine's idempotent external commands, with the
   timestamp rule below.
5. Only then report `flowing`.

## The timestamp rule (learned the hard way)

While draining, **drop `rest` and `reduce` commands whose `micro` is older than
the snapshot's `microtimestamp`; always apply `remove`**. If the socket lags the
snapshot — slow tab, congested path, proxy — the buffer holds creates for orders
the snapshot already saw die. Replaying them resurrects phantoms: stale quotes
inside the spread, a crossed book, zero gap alarms. We reproduced this through a
laggy relay; the fix is exact because event stamps and the snapshot stamp share
the venue's clock. Removes are always safe: an unknown id is ignored by design.

## Gap detection: discard, never patch

Every `live_orders` message carries `event_id`/`pre_event_id` and they chain:
each message's `pre_event_id` equals the previous message's `event_id`
(verified 709/709 live, and across every captured fixture). A broken link is a
gap; the response is `reseed("gap")` — throw the book away, snapshot again.
**There is no code path that patches across a gap. That absence is deliberate;
do not add one.** Any "small" patch produces the silently-wrong book class.

Same response to `bts:request_reconnect` and socket loss (after reconnect and
resubscribe): full reseed. Reseeds are cheap (~1s); wrongness is not.

## The sustained-cross healer

A real venue book cannot REST crossed — internal crossings resolve in
milliseconds. If the reconstructed book stays crossed (best bid ≥ best ask)
for more than ~8 seconds in live mode, a phantom order survived somewhere and
the pipeline forces `reseed("divergence")` without waiting for the 30s guard.
Observed in the wild as a phantom bid ~80 ticks above the real market during
a fast move; the composition collapses while the book is wrong, so healing
fast matters visually as well as truthfully.

## Defense in depth: the divergence guard

Every 30s in `flowing`, fetch the aggregated book (`group=1`) and compare local
BBO within one tick. One miss is a strike (the comparison races a moving
market); two consecutive strikes force `reseed("divergence")`. Do not tighten
to one strike (false positives on every burst) or drop the guard (it is the
only detector for wrongness the chain cannot see).

## Anomaly classes — keep them separate

`rest-existing-order`, `reduce-unknown-order`, `remove-unknown-order` are
EXPECTED reconstruction-protocol artifacts (snapshot overlap, pre-subscribe
orders) and must stay out of the surfaced divergence number.
`consume-not-front`, `traded-mismatch`, `grew-in-place`, `side-changed` are
genuine venue/local disagreement. Blurring the classes poisons the metric the
provenance UI shows. The split lives in `EXPECTED_ANOMALIES` (engine/types.ts).

## Validation pass mark

After any change here, run the soak:

    SOAK=1 SOAK_MINUTES=20 npx vitest run test/soak/soak.test.ts

Pass: every sample's BBO within one tick of the venue, zero unexplained gaps,
expected-anomaly counts in single digits, `docs/perf/soak-*.json` written. For
release-grade confidence run 60 minutes (the brief's benchmark). The captured
fixture test (`test/sources/reconstruction.test.ts`) must also pass: it replays
9,102 real messages and checks the closing book against the venue's own
snapshot with >90% per-order queue identity.

## Replay must mirror live

`ReplaySource` applies the same buffer→seed→drain discipline (captures record
arrival order, and pre-snapshot messages appear before the snapshot line) and
the same timestamp rule. If you change the seeding procedure, change both, or
the golden test will catch you.
