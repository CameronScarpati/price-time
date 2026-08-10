import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { packFrame } from "../../src/worker/packer";
import { FRAME_BYTES } from "../../src/worker/protocol";
import { BTCUSD } from "../../src/sources/bitstamp/normalize";
import { parseCapture } from "../../src/sources/replay/format";
import { ReplaySource } from "../../src/sources/replay/player";

/**
 * Worker-side frame cost on the real 8.7k-order book: packFrame must be far
 * inside the frame budget, because it runs on every animation frame. This is
 * the part of the budget measurable off-device; render-side numbers come
 * from the on-device HUD (docs/design.md §8).
 */
describe("frame packing cost", () => {
  it("packs the full live book well under 4ms", () => {
    const fixture = parseCapture(
      gunzipSync(
        readFileSync(fileURLToPath(new URL("../fixtures/btcusd-120s.jsonl.gz", import.meta.url))),
      ).toString("utf8"),
    );
    const engine = new Engine("external");
    new ReplaySource(fixture, BTCUSD, Infinity).start((event) => {
      if (event.type === "command") engine.apply(event.cmd);
    });
    expect(engine.store.size).toBeGreaterThan(5000);

    const buffer = new ArrayBuffer(FRAME_BYTES);
    const age = () => 1;
    packFrame(engine, buffer, age); // warm
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) packFrame(engine, buffer, age);
    const perFrameMs = (performance.now() - t0) / runs;
    console.log(`packFrame: ${perFrameMs.toFixed(3)}ms for ${engine.store.size} orders`);
    expect(perFrameMs).toBeLessThan(4);
  });
});
