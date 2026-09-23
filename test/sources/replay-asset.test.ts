import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import { checkInvariants } from "../../src/engine/invariants";
import { BTCUSD } from "../../src/sources/bitstamp/normalize";
import { parseCapture } from "../../src/sources/replay/format";
import { ReplaySource } from "../../src/sources/replay/player";

/**
 * The bundled replay is what the page plays when streaming is unreachable,
 * so every record in it has to survive normalization. One off-grid price
 * once stopped playback 46 seconds in, and nothing but a viewer noticed.
 */
describe("the bundled replay session", () => {
  it("plays to the end of the capture", () => {
    const records = parseCapture(
      gunzipSync(
        readFileSync(
          fileURLToPath(new URL("../../public/replay/session.jsonl.gz", import.meta.url)),
        ),
      ).toString("utf8"),
    );
    const engine = new Engine("external");
    const replay = new ReplaySource(records, BTCUSD, Infinity);
    let ended = false;
    replay.start((event) => {
      if (event.type === "command") engine.apply(event.cmd);
      if (event.type === "status" && event.status.phase === "down") {
        ended = event.status.reason === "capture ended";
      }
    });
    expect(ended).toBe(true);
    expect(checkInvariants(engine)).toEqual([]);
  });
});
