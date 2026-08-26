---
name: verifying-a-change
description: Use before declaring ANY change to this repo done — the full verification loop, in order, including the visual checks that tests cannot cover and when the soak is mandatory.
---

# Verifying a change

"Tests pass" is the floor, not done. This is a visual, temporal, live-data
artifact; most of its failure modes are invisible to the suite. Run the loop
in this order — each step is cheaper than the one after it.

## 1. Static + tests (always)

    pnpm typecheck && pnpm test

The suite includes generated command sequences (engine), the captured-session
golden test (reconstruction + replay), synthetic determinism, and the
packFrame budget. A flaky test here is a bug somewhere — this codebase is
deterministic by construction; never retry-until-green.

## 2. Build (when touching anything shipped)

    pnpm build

Confirms strict TS across app code and prints bundle sizes against the 150KB
gzip budget.

## 3. Watch it (always for engine/worker/render/ui changes)

    pnpm dev   # then look — actually look, for a full minute

- Desktop viewport AND a narrow one (`node tools/screenshot.mjs <url> out 20`
  captures rest, engaged, and phone states headlessly).
- `?hud=1`: frame percentiles, msg rate, order count, anomaly count (should be
  0 or single digits in live mode).
- `?mode=synthetic&seed=42`: deterministic run for before/after comparison.
- In a sandboxed environment, live mode needs the relay:
  `node tools/dev-relay.mjs` + `?ws=ws://localhost:8975&rest=http://localhost:8975/api/v2`.

Checklist while watching: spread breathing at center · arrivals joining queue
backs · cancels vanishing quietly · trades visible as the queue at the touch
getting shorter (there is no flash — if you see one, something regressed) ·
captions appearing on real moments only · provenance label correct for the
mode · **the frame HOLDING** — pick one row and stare at it: it must not
shift, creep, or shimmer between the camera's rare designed moves · nothing
moving you can't name the event for.

## 4. Mode ladder (when touching pipeline/sources/ui)

Kill the feed mid-session (stop the relay, or drop the network) and watch:
label flips to "simulated — seeded from the last real book" at or before the
texture changes, book does not jump, no spinner ever. Restore the feed; it
should hand back to live within ~30s. Check `prefers-reduced-motion` still
has designed motion, and Tab reaches every control.

## 5. Soak (mandatory for reconstruction/engine-external changes)

    SOAK=1 SOAK_MINUTES=20 npx vitest run test/soak/soak.test.ts

Pass mark in `.claude/skills/book-reconstruction/`. Attach the resulting
`docs/perf/soak-*.json` to the change.

## 6. Commit discipline

Coherent steps; messages explain WHY (the repo's history narrates decisions —
read `git log` and match it). Never commit: `node_modules` (bit us once),
captures outside `test/fixtures`/`public/replay`, tuned-hot calibration
values, or a quietly relaxed budget. If a budget is missed, the README says so
in words.
