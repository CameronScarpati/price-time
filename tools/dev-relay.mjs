#!/usr/bin/env node
/**
 * Dev-only bridge for sandboxed environments where the browser has no direct
 * egress but Node does: forwards the Bitstamp WebSocket and REST endpoints on
 * localhost. Point the page at it with
 *   http://localhost:5173/?ws=ws://localhost:8975&rest=http://localhost:8975/api/v2
 * Never needed in production — a real browser connects to the venue directly.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.argv[2] ?? 8975);
const REST_UPSTREAM = "https://www.bitstamp.net";
const WS_UPSTREAM = "wss://ws.bitstamp.net";

const http = createServer(async (req, res) => {
  try {
    const upstream = await fetch(REST_UPSTREAM + req.url, { cache: "no-store" });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

const wss = new WebSocketServer({ server: http });
wss.on("connection", (client) => {
  const upstream = new WebSocket(WS_UPSTREAM);
  const pendingToUpstream = [];
  upstream.onopen = () => {
    for (const msg of pendingToUpstream) upstream.send(msg);
    pendingToUpstream.length = 0;
  };
  upstream.onmessage = (m) => {
    if (client.readyState === client.OPEN) client.send(m.data);
  };
  upstream.onclose = () => client.close();
  upstream.onerror = () => client.close();
  client.on("message", (data) => {
    const text = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pendingToUpstream.push(text);
  });
  client.on("close", () => upstream.close());
  // An abrupt browser disconnect surfaces as an 'error' event; unhandled,
  // it would crash the whole relay.
  client.on("error", () => upstream.close());
});
wss.on("error", (err) => console.error("wss error:", err.message));

http.listen(PORT, () => console.log(`relay: ws://localhost:${PORT} and http://localhost:${PORT}/api/... → bitstamp`));
