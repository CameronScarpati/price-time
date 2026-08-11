---
name: engine-invariants
description: Use before and after ANY change to src/engine/ — matching logic, order types, the store, book structure, or command semantics. States what must hold, the authority asymmetry, and exactly how to check it.
---

# Engine invariants

The engine is the piece's accuracy contract. A subtly wrong book rendered
beautifully is the project's stated failure mode. Every invariant below is
enforced by `checkInvariants` (src/engine/invariants.ts) plus the property
suites; changing matching logic means re-running them and knowing why each
holds.

## What must hold after any command, always

- Ticks sorted strictly ascending per side; every tick has a level and vice
  versa; level `count`/`totalSats` equal a fresh walk of its queue.
- Doubly-linked queue integrity (prev/next mutual, tail reachable), no cycles.
- Queue order = arrival order: `seq` strictly increases front→back. This IS
  price-time priority; violating it is the cardinal sin.
- Every resting order has sats > 0. Zero-quantity phantoms fake the BBO (a
  review found exactly this via venue resize-to-zero; it is now a cancel).
- Store bijection: `idToSlot.size` = live orders = orders linked on the book.

## Authority asymmetry (internal vs external)

- `internal` (synthetic): the matcher decides. The book may NEVER cross — a
  crossed internal book means the matcher left money on the table. Strict mode
  in `checkInvariants`. An internal seed that would cross throws: the pipeline
  must sanitize handoff seeds (`sanitizeSeed`).
- `external` (live/replay): the venue decides. Transient crossing is absorbed
  truth, not a bug; disagreements increment anomaly counters and are never
  "corrected". A venue fill against a non-front order is applied AND counted.
- Commands are authority-checked: `place/cancel/replace` require internal,
  `rest/reduce/remove` require external, mixing throws. Don't weaken this to
  "absorb" — a mixed stream is a pipeline bug, not a market condition.

## Semantics that look wrong but are right

- `replace` re-enters as a fresh arrival: priority reset is the real rule, and
  a replace that crosses executes. It validates BEFORE touching the resting
  order (atomic reject).
- A venue price-modify (`reduce` with a different tick) relocates to the BACK
  of the new level as cancel + re-add events. Orders do not slide.
- `remove` with `tradedSats > 0` books the LOCAL remainder as the fill and
  counts any magnitude disagreement (`traded-mismatch`) — local ledger
  conservation wins, divergence is surfaced.
- IOC/market remainders emit `unfilled` — that event exists so conservation is
  observable; don't delete it as "unused".

## How to check

    pnpm test               # includes ~1,500 generated command sequences
    npx vitest run test/engine/properties.test.ts

Property tests check invariants after EVERY command. If you add a command or
order type: (1) extend the generators so the new path is actually reachable —
a property suite that can't generate your feature proves nothing; (2) add
example tests pinning exact semantics; (3) if it touches consumption, it must
go through `consumeSlot` — one consumption path is what keeps live mode honest.

Determinism: same command stream → byte-identical event stream (JSON compare).
No `Date.now()`, no `Math.random()`, no Map-iteration-order dependence in any
engine path. If your change needs a clock, it belongs in the pipeline, and the
time enters as a command field.
