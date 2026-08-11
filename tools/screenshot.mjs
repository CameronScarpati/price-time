// Open the piece, watch it, screenshot desktop + phone viewports, report
// console errors and frame stats. Usage: node shot.mjs [url] [outPrefix] [watchSec]
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/?hud=1";
const prefix = process.argv[3] ?? "shot";
const watchSec = Number(process.argv[4] ?? 12);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--enable-webgl"],
  // Live mode needs the venue; in sandboxed environments outbound TLS goes
  // through the agent proxy (the browser NSS store already trusts its CA).
  ...(process.env.HTTPS_PROXY
    ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } }
    : {}),
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "networkidle" }).catch((e) => errors.push(String(e)));

await page.waitForTimeout(watchSec * 1000);
await page.screenshot({ path: `${prefix}-desktop.png` });

// engage the chrome, then screenshot again
await page.mouse.move(720, 430);
await page.waitForTimeout(800);
await page.screenshot({ path: `${prefix}-desktop-engaged.png` });

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
phone.on("console", (m) => { if (m.type() === "error") errors.push("phone: " + m.text()); });
phone.on("pageerror", (e) => errors.push("phone: " + String(e)));
await phone.goto(url, { waitUntil: "networkidle" }).catch((e) => errors.push(String(e)));
await phone.waitForTimeout(8000);
await phone.screenshot({ path: `${prefix}-phone.png` });

const hud = await page.locator(".hud").textContent().catch(() => "(no hud)");
const provenance = await page.locator(".provenance").textContent().catch(() => "(none)");
console.log("provenance:", provenance);
console.log("hud:", hud);
console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
await browser.close();
