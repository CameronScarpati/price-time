import { chromium } from "playwright";
const url = process.argv[2];
const secs = Number(process.argv[3] ?? 20);
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--enable-webgl"],
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(Number(process.env.WARMUP_MS ?? 3000));
const samples = [];
for (let i = 0; i < secs * 10; i++) {
  samples.push(await page.evaluate(() => {
    const pt = window.__pt, f = pt.frame();
    return { ppt: pt.camera.pxPerTick, center: pt.camera.centerTick,
      drawnCenter: pt.layout().centerTick,
      mid: f ? f.header[3] : 0, span: f ? f.header[7] : 0,
      lo: f ? f.header[9] : 0, hi: f ? f.header[10] : 0, n: f ? f.header[0] : 0,
      pxPerSat: pt.layout().pxPerSat };
  }));
  await page.waitForTimeout(100);
}
const last = samples[samples.length - 1];
const ppts = samples.map((s) => s.ppt);
const centers = samples.map((s) => s.center);
console.log(JSON.stringify({
  last,
  rowPx: Math.max(last.ppt - 1, 2.6).toFixed(1),
  pptMin: Math.min(...ppts), pptMax: Math.max(...ppts),
  distinctPpt: new Set(ppts.map((v) => v.toFixed(6))).size,
  distinctCenter: new Set(centers.map((v) => v.toFixed(6))).size,
  distinctPxPerSat: new Set(samples.map((s) => s.pxPerSat.toExponential(8))).size,
  samples: samples.length,
  visibleHalfTicks: 430 / last.ppt,
  bookHalfTicks: Math.max(last.mid - last.lo, last.hi - last.mid),
  errors,
}, null, 1));
await page.screenshot({ path: process.argv[4] ?? "/tmp/shot.png" });
await browser.close();
