import type { RawMessage, RawSnapshot } from "../bitstamp/messages";

/**
 * Capture format: JSONL, one record per line, produced by tools/capture.mjs
 * and consumed by the replay source and the reconstruction tests. `at` is
 * milliseconds since capture start — replay pacing preserves real gaps.
 */
export type CaptureRecord =
  | { type: "meta"; pair: string; startedAtMs: number; plannedSeconds: number }
  | { type: "snapshot"; at: number; data: RawSnapshot }
  | { type: "msg"; at: number; data: RawMessage }
  | { type: "closing_snapshot"; at: number; data: RawSnapshot };

export function parseCapture(jsonl: string): CaptureRecord[] {
  const records: CaptureRecord[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line) as CaptureRecord);
  }
  return records;
}

/** Fetch and decompress a .jsonl.gz capture in the browser. */
export async function loadCapture(url: string): Promise<CaptureRecord[]> {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`capture fetch failed: ${res.status}`);
  const stream = url.endsWith(".gz")
    ? res.body.pipeThrough(new DecompressionStream("gzip"))
    : res.body;
  return parseCapture(await new Response(stream).text());
}
