// Diagnose venue reachability from inside the page's browser context:
// can it open the WebSocket, and can it fetch the REST snapshot?
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.HTTPS_PROXY
    ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } }
    : {}),
});
const page = await browser.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
const result = await page.evaluate(async () => {
  const out = {};
  out.ws = await new Promise((resolve) => {
    try {
      const ws = new WebSocket("wss://ws.bitstamp.net");
      const t = setTimeout(() => resolve("timeout"), 8000);
      ws.onopen = () => { clearTimeout(t); ws.close(); resolve("open"); };
      ws.onerror = () => { clearTimeout(t); resolve("error"); };
    } catch (e) { resolve("throw: " + e); }
  });
  try {
    const res = await fetch("https://www.bitstamp.net/api/v2/order_book/btcusd/?group=1", { cache: "no-store" });
    out.rest = res.ok ? "ok" : `http ${res.status}`;
    if (res.ok) { const b = await res.json(); out.bestBid = b.bids[0][0]; }
  } catch (e) { out.rest = "throw: " + e; }
  return out;
});
console.log(result);
await browser.close();
