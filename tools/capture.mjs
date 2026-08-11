#!/usr/bin/env node
/**
 * Record a live Bitstamp session to JSONL: a leading meta line, a group=2
 * snapshot taken after subscribing (mirroring the seeding procedure), every
 * raw message with its arrival time, and a closing group=2 snapshot for
 * end-state validation.
 *
 * Usage: node tools/capture.mjs [pair] [seconds] [outfile]
 */
const pair = process.argv[2] ?? "btcusd";
const seconds = Number(process.argv[3] ?? 120);
const outfile = process.argv[4] ?? `capture-${pair}-${Date.now()}.jsonl`;

import { createWriteStream } from "node:fs";

const out = createWriteStream(outfile);
const t0 = Date.now();
const write = (record) => out.write(JSON.stringify(record) + "\n");

const fetchSnapshot = async () => {
  const res = await fetch(`https://www.bitstamp.net/api/v2/order_book/${pair}/?group=2`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  return res.json();
};

write({ type: "meta", pair, startedAtMs: t0, plannedSeconds: seconds });

let messages = 0;
const ws = new WebSocket("wss://ws.bitstamp.net");
ws.onopen = async () => {
  for (const channel of [`live_orders_${pair}`, `live_trades_${pair}`]) {
    ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel } }));
  }
  const snapshot = await fetchSnapshot();
  write({ type: "snapshot", at: Date.now() - t0, data: snapshot });
};
ws.onmessage = (m) => {
  messages++;
  write({ type: "msg", at: Date.now() - t0, data: JSON.parse(m.data) });
};
ws.onerror = (e) => console.error("ws error:", e.message ?? e);

setTimeout(async () => {
  ws.close();
  const closing = await fetchSnapshot();
  write({ type: "closing_snapshot", at: Date.now() - t0, data: closing });
  out.end(() => {
    console.log(`captured ${messages} messages over ${seconds}s → ${outfile}`);
    process.exit(0);
  });
}, seconds * 1000);
