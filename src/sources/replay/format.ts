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

/** Fetch a capture, decompressing only if the bytes are actually gzip.
 * Hosts disagree about .gz: some send Content-Encoding and the browser
 * decompresses transparently, others serve raw bytes — so sniff the gzip
 * magic number rather than trusting the extension or the headers. */
export async function loadCapture(url: string): Promise<CaptureRecord[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`capture fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return parseCapture(await new Response(stream).text());
  }
  return parseCapture(new TextDecoder().decode(bytes));
}
