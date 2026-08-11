import { Renderer } from "./render/renderer";
import { Ui } from "./ui/ui";
import type { MainToWorker } from "./worker/protocol";
import type { SourceKind } from "./sources/source";

/**
 * Boot: a worker for the truth, a renderer for the looking, a UI for the
 * words. URL parameters for the modes that need asking for:
 *   ?mode=live|synthetic|replay   (default: auto — live, degrading honestly)
 *   ?seed=42                      (synthetic determinism)
 *   ?hud=1                        (frame-time HUD)
 */
function boot(): void {
  const root = document.getElementById("app")!;
  const params = new URLSearchParams(location.search);

  const glCanvas = document.createElement("canvas");
  glCanvas.className = "layer";
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.className = "layer";
  root.append(glCanvas, overlayCanvas);

  const worker = new Worker(new URL("./worker/main.ts", import.meta.url), { type: "module" });

  let renderer: Renderer;
  const ui = new Ui(root, worker, () => renderer, params.get("hud") === "1");
  try {
    renderer = new Renderer(glCanvas, overlayCanvas, worker, ui);
  } catch {
    ui.fatal("this piece needs WebGL2 — a browser from the last few years will have it");
    return;
  }

  const mode = (params.get("mode") ?? "auto") as "auto" | SourceKind;
  const seed = Number(params.get("seed") ?? Date.now() % 2 ** 31);
  const replayUrl = params.get("replay") ?? new URL("replay/session.jsonl.gz", document.baseURI).href;
  const wsUrl = params.get("ws") ?? undefined;
  const restBase = params.get("rest") ?? undefined;
  worker.postMessage({
    type: "init", mode, seed, replayUrl,
    ...(wsUrl !== undefined ? { wsUrl } : {}),
    ...(restBase !== undefined ? { restBase } : {}),
  } satisfies MainToWorker);

  const resize = (): void => {
    // Full device resolution up to 3× — capping at 2 made every 3× phone
    // screen visibly soft. visualViewport tracks iOS URL-bar collapse, which
    // plain innerHeight misses.
    const dpr = Math.min(devicePixelRatio, 3);
    const w = window.visualViewport?.width ?? innerWidth;
    const h = window.visualViewport?.height ?? innerHeight;
    renderer.resize(Math.round(w), Math.round(h), dpr);
  };
  resize();
  addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);

  document.addEventListener("visibilitychange", () => {
    worker.postMessage({ type: "hidden", hidden: document.hidden } satisfies MainToWorker);
  });

  // Input: drag pans price, wheel/pinch zooms, hover/tap inspects,
  // double-click or double-tap snaps back to the market.
  let dragging = false;
  let lastY = 0;
  let pinchDist = 0;
  let lastTapMs = 0;
  // Flick velocity: an exponentially-smoothed px/ms estimate from the last
  // few moves, released into the camera as momentum on pointerup.
  let velPxPerMs = 0;
  let lastMoveMs = 0;
  window.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastY = e.clientY;
    velPxPerMs = 0;
    lastMoveMs = performance.now();
  });
  window.addEventListener("pointerup", (e) => {
    if (dragging && Math.abs(velPxPerMs) > 0.08 && performance.now() - lastMoveMs < 80) {
      renderer.camera.fling(velPxPerMs / renderer.camera.pxPerTick);
    }
    dragging = false;
    if (e.pointerType === "touch") {
      const now = performance.now();
      if (now - lastTapMs < 300) {
        renderer.camera.recenter();
        lastTapMs = 0;
        return;
      }
      lastTapMs = now;
    }
    ui.inspectAt(e.clientX, e.clientY);
  });
  window.addEventListener("dblclick", () => renderer.camera.recenter());
  window.addEventListener("pointermove", (e) => {
    if (dragging && e.buttons > 0) {
      // A real pan, not a jittery tap: only detach past a few pixels.
      const dy = e.clientY - lastY;
      if (Math.abs(dy) > 2) {
        renderer.camera.panTicks(dy / renderer.camera.pxPerTick);
        const now = performance.now();
        const dt = Math.max(now - lastMoveMs, 1);
        velPxPerMs = velPxPerMs * 0.6 + (dy / dt) * 0.4;
        lastMoveMs = now;
        lastY = e.clientY;
      }
    } else if (e.pointerType === "mouse") {
      ui.inspectAt(e.clientX, e.clientY);
    }
  });
  window.addEventListener("wheel", (e) => {
    renderer.camera.wheelZoom(e.deltaY);
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchDist > 0) renderer.camera.pinchZoom(d / pinchDist);
      pinchDist = d;
    }
  }, { passive: true });
  window.addEventListener("touchend", () => {
    pinchDist = 0;
  });

  // Render at ≤60fps even on 120Hz ProMotion displays: this content is a
  // mostly-still field with discrete events, and halving the fill-rate bill
  // on a 3x-resolution phone buys battery and thermal headroom that matter
  // more than 120Hz smoothness ever could here.
  let lastRenderMs = 0;
  const frame = (t: number): void => {
    if (t - lastRenderMs >= 15.5) {
      lastRenderMs = t;
      renderer.tick(t);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Dev hook for headless inspection (tools/screenshot.mjs and friends).
  (window as unknown as { __pt: unknown }).__pt = {
    camera: renderer.camera,
    layout: () => renderer.layoutParams,
    stats: () => renderer.frameStats(),
    book: () => ({ bestBid: renderer.bestBid, bestAsk: renderer.bestAsk }),
    frame: () => renderer.debugFrame(),
  };
}

boot();
