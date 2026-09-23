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
    ui.fatal("this piece needs WebGL2; a browser from the last few years will have it");
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
  // double-click or double-tap snaps back to the market, arrows travel
  // (held = accelerate), PageUp/Down leap a screen, Home returns.
  let dragging = false;
  // True once the drag passed the tap slop — from then on EVERY move pans.
  // (The old per-move 2px threshold quantized slow drags into a staircase.)
  let dragActive = false;
  let primaryPointer = -1;
  let activePointers = 0;
  let lastY = 0;
  let pinchDist = 0;
  let lastTapMs = 0;
  // Flick velocity: an exponentially-smoothed px/ms estimate from the last
  // few moves, released into the camera as momentum on pointerup.
  let velPxPerMs = 0;
  let lastMoveMs = 0;
  window.addEventListener("pointerdown", (e) => {
    activePointers++;
    if (activePointers === 1) {
      dragging = true;
      dragActive = false;
      primaryPointer = e.pointerId;
      lastY = e.clientY;
      velPxPerMs = 0;
      lastMoveMs = performance.now();
    } else {
      // Second finger down: this is a pinch now, not a pan — a two-finger
      // gesture whose pointermoves also panned made pinching judder.
      dragging = false;
      dragActive = false;
    }
  });
  const releasePointer = (e: PointerEvent): void => {
    activePointers = Math.max(0, activePointers - 1);
    if (e.pointerId !== primaryPointer) return;
    if (dragging && dragActive && renderer.camera.detached) {
      // Stale velocity (finger held still before lifting) means no flick —
      // release at zero so the glide degrades to a snap onto the row grid.
      const fresh = performance.now() - lastMoveMs < 80 && Math.abs(velPxPerMs) > 0.08;
      renderer.camera.fling(fresh ? velPxPerMs / renderer.camera.pxPerTick : 0);
    }
    dragging = false;
  };
  window.addEventListener("pointercancel", releasePointer);
  window.addEventListener("pointerup", (e) => {
    const wasDrag = dragActive;
    releasePointer(e);
    dragActive = false;
    // A drag's release is not a tap: no inspector, no double-tap recenter.
    if (wasDrag || e.pointerId !== primaryPointer) return;
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
    if (dragging && e.pointerId === primaryPointer && e.buttons > 0) {
      const dy = e.clientY - lastY;
      if (!dragActive && Math.abs(dy) <= 3) return; // still could be a tap
      dragActive = true;
      if (dy !== 0) {
        renderer.camera.panTicks(dy / renderer.camera.pxPerTick);
        const now = performance.now();
        const dt = Math.max(now - lastMoveMs, 1);
        velPxPerMs = velPxPerMs * 0.6 + (dy / dt) * 0.4;
        lastMoveMs = now;
      }
      lastY = e.clientY;
    } else if (e.pointerType === "mouse" && activePointers === 0) {
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

  // Held-key travel: a tapped arrow nudges a few rows; a HELD arrow
  // accelerates from a stroll to a sprint (integrated per-frame below), and
  // its release lands on the grid exactly like a flick. Down moves the
  // viewport down the book (toward deep bids), PageUp/Down leap a screen,
  // Home (or 0) returns to the market.
  let keyDir = 0;
  let keyHeldSince = 0;
  let keyVelPxPerMs = 0;
  window.addEventListener("keydown", (e) => {
    if (ui.explainerOpen()) return; // the panel scrolls; travel keys yield
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (!e.repeat || keyDir !== dir) {
        keyDir = dir;
        keyHeldSince = performance.now();
        keyVelPxPerMs = 0;
      }
      ui.engage();
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const h = window.visualViewport?.height ?? innerHeight;
      const dir = e.key === "PageDown" ? 1 : -1;
      renderer.camera.nudge((-dir * h * 0.85) / renderer.camera.pxPerTick);
      ui.engage();
    } else if (e.key === "Home" || e.key === "0") {
      renderer.camera.recenter();
      ui.engage();
    }
  });
  window.addEventListener("keyup", (e) => {
    const dir = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (dir !== 0 && dir === keyDir) {
      renderer.camera.fling((-keyDir * keyVelPxPerMs) / renderer.camera.pxPerTick);
      keyDir = 0;
    }
  });
  window.addEventListener("blur", () => {
    keyDir = 0; // a keyup lost to focus change must not scroll forever
  });

  // Render at ≤60fps even on 120Hz ProMotion displays: this content is a
  // mostly-still field with discrete events, and halving the fill-rate bill
  // on a 3x-resolution phone buys battery and thermal headroom that matter
  // more than 120Hz smoothness ever could here.
  let lastRenderMs = 0;
  const frame = (t: number): void => {
    if (t - lastRenderMs >= 15.5) {
      const dt = lastRenderMs === 0 ? 16.7 : Math.min(t - lastRenderMs, 50);
      lastRenderMs = t;
      if (keyDir !== 0) {
        // Ramp from a stroll (0.6 screens/s) to a sprint (4 screens/s) over
        // ~1.6s of hold — tap to nudge, hold to speed through the book.
        const r = Math.min((t - keyHeldSince) / 1600, 1);
        const smooth = r * r * (3 - 2 * r);
        const h = window.visualViewport?.height ?? innerHeight;
        keyVelPxPerMs = (h * (0.6 + 3.4 * smooth)) / 1000;
        renderer.camera.panTicks((-keyDir * keyVelPxPerMs * dt) / renderer.camera.pxPerTick);
      }
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
