#!/usr/bin/env node
/**
 * CI liveness check: the piece boots, labels itself, and draws. Exits
 * non-zero on page errors, a missing provenance line, or a black canvas.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:4173/?mode=synthetic&seed=42";
// CI installs its own Chromium; sandboxed dev environments preinstall one.
const preinstalled = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);

const provenance = await page.locator(".provenance").textContent();
const drawn = await page.evaluate(
  () =>
    new Promise((resolve) => {
      // Read inside the same rAF turn as the app's draw: the drawing buffer
      // is not preserved across presents, so reading later sees only clear.
      // A turn with nothing new to show skips the draw and reads clear too,
      // so sample turns until one drew.
      let turns = 0;
      const sample = () => {
        const canvas = document.querySelector("canvas");
        const gl = canvas.getContext("webgl2");
        const px = new Uint8Array(4 * canvas.width);
        // The exact center row is the spread gap (empty by design); sample
        // rows through the bid and ask fields on both sides of it.
        for (const dy of [-90, -45, 45, 90]) {
          const y = Math.floor(canvas.height / 2) + dy;
          gl.readPixels(0, y, canvas.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24) return resolve(true);
          }
        }
        if (++turns >= 120) return resolve(false);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }),
);
await browser.close();

console.log("provenance:", provenance);
console.log("cells drawn:", drawn);
if (errors.length > 0) {
  console.error("page errors:", errors);
  process.exit(1);
}
if (!provenance || !provenance.includes("simulated")) {
  console.error("provenance line missing or wrong");
  process.exit(1);
}
if (!drawn) {
  console.error("canvas is black — nothing drawn");
  process.exit(1);
}
console.log("smoke OK");
