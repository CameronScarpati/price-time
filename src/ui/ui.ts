import { Side } from "../engine/types";
import { formatDecimal } from "../sources/bitstamp/decimal";
import { HIT_SLOP_PX, hitTest } from "../render/layout";
import type { Renderer } from "../render/renderer";
import type { FrameMeta, InspectionResult, MainToWorker, WorkerToMain } from "../worker/protocol";

/**
 * Everything DOM: the always-present provenance line, and the chrome that
 * appears on engagement and gets out of the way again — controls, tape,
 * inspector, captions, the explainer, and the screen-reader narration.
 *
 * The one standing rule (docs/design.md §10): the label leads the data. Mode
 * text changes in the same frame the mode changes, before the eye can read
 * the new texture as the old truth.
 */

const MODE_LABEL: Record<string, string> = {
  live: "live: Bitstamp BTC/USD order flow → local matching engine",
  synthetic: "simulated: synthetic agents, seeded from the last real book",
  "synthetic-cold": "simulated: synthetic agents, not seeded from a real book",
  replay: "replay: recorded Bitstamp BTC/USD flow → local matching engine",
};

// The disclosure line is the piece's one standing sentence; on a phone the
// desktop copy ellipsizes mid-word, so narrow screens get a short form with
// the mode word still first (the label-leads rule is untouched).
const MODE_LABEL_SHORT: Record<string, string> = {
  live: "live: Bitstamp BTC/USD → local engine",
  synthetic: "simulated: seeded from the last real book",
  "synthetic-cold": "simulated: synthetic agents",
  replay: "replay: recorded Bitstamp BTC/USD flow",
};

/** A full chrome fade, 0 to 1 or back. A partial one (the target flipped
 * mid-fade) travels the same straight line for its shorter distance. */
export const CHROME_FADE_MS = 200;

/** Where the chrome fade stands: the alpha it left from, the alpha it is
 * going to, and when it left. */
export interface ChromeFade {
  from: number;
  to: number;
  atMs: number;
}

/** Alpha of a chrome fade at `nowMs`: a straight line at one full fade per
 * `fullMs`, landing EXACTLY on its target and holding there. A pure function
 * of the clock, so asking twice in a frame changes nothing, and the settled
 * value is bitwise stable — which is what lets the renderer's unchanged-frame
 * skip fire again once the chrome has finished moving. (The ease this
 * replaced stepped 12% of the remaining distance per call: it never arrived,
 * and it ran twice as fast once the renderer asked twice a frame.) A
 * `fullMs` of 0 cuts: the reduced-motion fade. */
export function chromeFadeAlpha(fade: ChromeFade, nowMs: number, fullMs: number): number {
  const travelled = fullMs > 0 ? Math.max(nowMs - fade.atMs, 0) / fullMs : Infinity;
  return fade.to >= fade.from
    ? Math.min(fade.from + travelled, fade.to)
    : Math.max(fade.from - travelled, fade.to);
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, parent: HTMLElement, text = "",
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  parent.appendChild(node);
  return node;
};

export class Ui {
  private chromeVisibleUntil = 0;
  private fade: ChromeFade = { from: 0, to: 0, atMs: 0 };
  private alpha = 0;
  /** The alpha last written to the DOM; NaN so the first call writes. */
  private writtenAlpha = NaN;
  /** True from a caption's start until the chrome has fully hidden. */
  private captionLive = false;
  private paused = false;
  private lastCaptionId = 0;
  private lastNarration = "";
  private lastNarrationAt = 0;
  private inspectToken = 0;
  /** Order id the open inspector describes; revalidated against the book so
   * the box closes the moment its order fills or cancels. */
  private watchedId: number | null = null;
  private lastWatchMs = 0;
  private mode = "";
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly narrow = matchMedia("(max-width: 480px)");

  private readonly provenance: HTMLElement;
  private readonly modeDot: HTMLElement;
  private readonly modeText: HTMLElement;
  private readonly captionBand: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly followChip: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly clockChip: HTMLElement;
  private readonly tapePanel: HTMLElement;
  private readonly tapeList: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly explainer: HTMLElement;
  private readonly narrator: HTMLElement;
  private readonly hud: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly worker: Worker,
    private readonly renderer: () => Renderer,
    private readonly showHud: boolean,
  ) {
    this.provenance = el("div", "provenance", root);
    this.modeDot = el("span", "mode-dot", this.provenance);
    this.modeText = el("span", "", this.provenance);

    // The band carries the chrome's alpha and the caption inside it carries
    // its own fade, so a caption leaving with the chrome is the product of
    // the two — never a pop. (A CSS animation outranks an inline opacity, so
    // they cannot share one element.)
    this.captionBand = el("div", "caption-band", root);
    this.caption = el("div", "caption", this.captionBand);
    this.caption.setAttribute("aria-hidden", "true");

    this.controls = el("div", "controls chrome", root);
    this.clockChip = el("span", "clock-chip", this.controls, "live");
    this.pauseButton = el("button", "control-button", this.controls, "pause");
    this.pauseButton.addEventListener("click", () => this.togglePause());
    const explainButton = el("button", "control-button", this.controls,
      this.narrow.matches ? "what is this?" : "what am I looking at?");
    explainButton.addEventListener("click", () => this.toggleExplainer(true));
    el("span", "credit", this.controls, "a piece by Cameron Scarpati · data: Bitstamp");

    this.followChip = el("button", "follow-chip", root, "↩ follow the market");
    this.followChip.addEventListener("click", () => {
      this.renderer().camera.recenter();
      this.engage();
    });

    this.tapePanel = el("div", "tape chrome", root);
    el("div", "tape-title", this.tapePanel, "the tape");
    this.tapeList = el("div", "tape-list", this.tapePanel);

    this.inspector = el("div", "inspector", root);
    this.narrator = el("div", "visually-hidden", root);
    this.narrator.setAttribute("aria-live", "polite");
    this.narrator.setAttribute("role", "status");

    this.explainer = this.buildExplainer(root);
    this.hud = el("div", "hud", root);
    if (!showHud) this.hud.style.display = "none";

    this.wireEngagement();
    this.wireKeyboard();

    worker.addEventListener("message", (e: MessageEvent<WorkerToMain>) => {
      if (e.data.type === "inspection") this.showInspection(e.data.token, e.data.result);
      if (e.data.type === "fatal") this.fatal(e.data.message);
    });
  }

  // ---------------------------------------------------------------- delegate

  chromeAlpha(): number {
    // The follow chip rides its own logic: visible whenever the viewer has
    // panned away, regardless of chrome idle state — it IS the way back.
    this.followChip.classList.toggle("show", this.renderer().camera.detached);
    const nowMs = performance.now();
    const fullMs = this.reduced ? 0 : CHROME_FADE_MS;
    const target = this.engaged(nowMs) ? 1 : 0;
    if (target !== this.fade.to) {
      // The way out starts when the window closed, not when a frame noticed,
      // so a late frame (or a tab coming back) finds it where it should be.
      const atMs = target === 0 ? this.chromeVisibleUntil : nowMs;
      this.fade = { from: chromeFadeAlpha(this.fade, atMs, fullMs), to: target, atMs };
    }
    this.alpha = chromeFadeAlpha(this.fade, nowMs, fullMs);
    if (this.alpha !== this.writtenAlpha) {
      this.writtenAlpha = this.alpha;
      for (const p of [this.controls, this.tapePanel]) {
        p.style.opacity = String(this.alpha);
        p.style.pointerEvents = this.alpha > 0.4 ? "auto" : "none";
      }
      this.captionBand.style.opacity = String(this.alpha);
    }
    // Hidden chrome ends the caption for good: re-engaging must not bring
    // back a sentence about a moment that has passed.
    if (this.captionLive && target === 0 && this.alpha === 0) {
      this.captionLive = false;
      this.caption.classList.remove("caption-show");
    }
    return this.alpha;
  }

  /** The chrome's visibility window: engagement keeps it open for 4s. */
  private engaged(nowMs: number): boolean {
    return nowMs < this.chromeVisibleUntil;
  }

  reducedMotion(): boolean {
    return this.reduced;
  }

  onMeta(meta: FrameMeta): void {
    const modeKey =
      meta.mode === "synthetic" && !meta.seededFromLive ? "synthetic-cold" : meta.mode;
    if (modeKey !== this.mode) {
      this.mode = modeKey;
      const labels = this.narrow.matches ? MODE_LABEL_SHORT : MODE_LABEL;
      this.modeText.textContent = " " + (labels[modeKey] ?? meta.mode);
      this.modeDot.dataset.mode = meta.mode;
    }
    this.modeDot.classList.toggle("degraded", meta.degraded);

    // Captions are chrome: they speak only while the viewer is engaged. One
    // that fires at rest is dropped, not held for later — the piece at rest
    // is wordless but for the provenance line. The detectors keep running
    // either way; the tape and the screen-reader narration do not wait on
    // this.
    if (meta.caption !== null && meta.caption.id !== this.lastCaptionId) {
      this.lastCaptionId = meta.caption.id;
      if (this.engaged(performance.now())) {
        this.caption.textContent = meta.caption.text;
        this.caption.classList.remove("caption-show");
        void this.caption.offsetWidth; // restart the CSS animation
        this.caption.classList.add("caption-show");
        this.captionLive = true;
      }
    }

    const clock = meta.clock;
    this.clockChip.textContent =
      clock.state === "live"
        ? meta.mode === "replay" ? "replay" : meta.mode === "synthetic" ? "simulated" : "live"
        : clock.state === "paused"
          ? `paused · ${(clock.behindMs / 1000).toFixed(0)}s behind`
          : `catching up ×${clock.speed} · ${(clock.behindMs / 1000).toFixed(0)}s`;
    this.clockChip.dataset.state = clock.state;

    const nowMs = performance.now();
    if (meta.narration !== this.lastNarration && nowMs - this.lastNarrationAt > 4000) {
      this.lastNarration = meta.narration;
      this.lastNarrationAt = nowMs;
      this.narrator.textContent = meta.narration;
    }

    // A resize voids the fit (lastTapeStamp -1): rebuild at once, hidden or
    // not, so the frame the chrome fades back in on already ends whole.
    if (this.alpha > 0.05 || this.lastTapeStamp === -1) this.renderTape(meta);
    if (this.showHud) this.renderHud(meta);

    // While the inspector is open, re-resolve its order against the live
    // book a few times a second. The moment the order fills or cancels the
    // worker answers null and the box closes — it never describes a ghost.
    // (Bonus: age and queue position tick forward while it stays open.)
    if (this.watchedId !== null && nowMs - this.lastWatchMs > 400) {
      this.lastWatchMs = nowMs;
      this.post({ type: "watch", token: ++this.inspectToken, id: this.watchedId });
    }
  }

  // ------------------------------------------------------------- engagement

  engage(): void {
    this.chromeVisibleUntil = performance.now() + 4000;
  }

  /** True while the explainer overlay is open — travel keys yield to it. */
  explainerOpen(): boolean {
    return this.explainer.classList.contains("open");
  }

  private wireEngagement(): void {
    for (const type of ["pointermove", "pointerdown", "touchstart"] as const) {
      window.addEventListener(type, () => this.engage(), { passive: true });
    }
    window.addEventListener("focusin", () => this.engage());
    // A resize moves the tape's fit: rebuild it on the next frame.
    window.addEventListener("resize", () => { this.lastTapeStamp = -1; });
  }

  /** Words and panels only — travel keys (arrows, PageUp/Down, Home) live
   * with the rest of the camera input in app.ts, where the frame loop can
   * integrate a HELD key into accelerating motion. */
  private wireKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.togglePause();
      } else if (e.key === "?") {
        this.toggleExplainer(true);
      } else if (e.key === "Escape") {
        this.toggleExplainer(false);
      }
    });
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseButton.textContent = this.paused ? "resume" : "pause";
    this.post(this.paused ? { type: "pause" } : { type: "resume" });
    this.engage();
  }

  private post(msg: MainToWorker): void {
    this.worker.postMessage(msg);
  }

  // -------------------------------------------------------------- inspector

  inspectAt(clientX: number, clientY: number, slopPx: number = HIT_SLOP_PX.mouse): void {
    const r = this.renderer();
    const hit = hitTest(clientX, clientY, r.layoutParams, r.bestBid, r.bestAsk, slopPx);
    if (hit === null) {
      // Bump the token so an in-flight reply can't resurrect the box after
      // the pointer has already left the field.
      this.inspectToken++;
      this.hideInspector();
      return;
    }
    // Stop re-resolving the order the box showed before: a watch sent while
    // this ask is out would take a newer token, drop this reply, and put the
    // old order back under the pointer.
    this.watchedId = null;
    const token = ++this.inspectToken;
    this.post({
      type: "inspect", token, sides: hit.sides, tickAt: hit.tickAt, reachTicks: hit.reachTicks,
      tickMin: hit.tickMin, tickMax: hit.tickMax,
      cumSats: Math.round(hit.cumSats), satsSlop: Math.round(hit.satsSlop),
    });
    this.inspector.style.left = `${Math.min(clientX + 14, innerWidth - 260)}px`;
    this.inspector.style.top = `${Math.min(clientY + 14, innerHeight - 90)}px`;
  }

  private hideInspector(): void {
    this.inspector.style.opacity = "0";
    this.watchedId = null;
  }

  private showInspection(token: number, result: InspectionResult | null): void {
    if (token !== this.inspectToken) return; // stale reply, a newer ask is out
    if (result === null) {
      this.hideInspector();
      return;
    }
    this.watchedId = result.id;
    const age =
      result.ageSec < 90
        ? `${result.ageSec.toFixed(0)}s`
        : result.ageSec < 5400
          ? `${(result.ageSec / 60).toFixed(0)}m`
          : `${(result.ageSec / 3600).toFixed(1)}h`;
    const ord = ordinal(result.queuePosition);
    this.inspector.innerHTML = "";
    const side = result.side === Side.Bid ? "bid" : "offer";
    el("div", "inspector-price", this.inspector,
      `${formatDecimal(result.sats, 8).replace(/0+$/, "").replace(/\.$/, "")} BTC ${side} @ $${formatDecimal(result.tick, 2)}`);
    el("div", "", this.inspector,
      `${ord} of ${result.queueLength} in queue · ${formatDecimal(result.aheadSats, 8).replace(/0+$/, "").replace(/\.$/, "")} BTC ahead`);
    el("div", "inspector-dim", this.inspector,
      `waiting ${age}${result.liquidation ? " · forced liquidation" : ""}`);
    this.inspector.style.opacity = "1";
  }

  // ------------------------------------------------------------------- tape

  private lastTapeStamp = -1;

  private renderTape(meta: FrameMeta): void {
    const stamp = meta.tape.length > 0 ? meta.tape[meta.tape.length - 1].atMs : 0;
    if (stamp === this.lastTapeStamp) return;
    this.lastTapeStamp = stamp;
    this.tapeList.innerHTML = "";
    for (let i = meta.tape.length - 1; i >= 0; i--) {
      const t = meta.tape[i];
      const row = el("div", "tape-row", this.tapeList);
      // Side is carried by glyph AND color — never color alone.
      el("span", t.aggressor === Side.Bid ? "tape-buy" : "tape-sell", row,
        t.aggressor === Side.Bid ? "▲" : "▼");
      el("span", "", row, ` $${formatDecimal(t.tick, 2)} `);
      // Fixed-width on purpose: trailing zeros are exact (sats are integers),
      // and a right-flush mono column must not jog row to row.
      el("span", "inspector-dim", row, `${formatDecimal(t.sats, 8)} BTC`);
    }
    // Keep only the rows that fit whole. The list clips at its max-height,
    // and a row cut through there, or faded out, reads as a fault. Measured
    // as fractional rects: offsetTop/clientHeight round to whole pixels, and
    // rows are 17.25px tall, so a rounded check let half a pixel shear.
    if (meta.tape.length > 0) {
      const clip = this.tapeList.getBoundingClientRect().bottom + 0.01;
      let last = this.tapeList.lastElementChild;
      while (last !== null && last.getBoundingClientRect().bottom > clip) {
        last.remove();
        last = this.tapeList.lastElementChild;
      }
    }
  }

  private renderHud(meta: FrameMeta): void {
    const s = this.renderer().frameStats();
    this.hud.textContent =
      `frame p50 ${s.p50.toFixed(1)}ms · p95 ${s.p95.toFixed(1)}ms · p99 ${s.p99.toFixed(1)}ms · ` +
      `>16.7ms ${s.over16_7}/600 · ${meta.stats.msgsPerSec.toFixed(0)} msg/s · ` +
      `${meta.stats.orders} orders · ${meta.stats.anomalies} anomalies · ` +
      // Against the ~60 frames a second the renderer asks for: the gap is
      // work an unchanged book did not cost.
      `${meta.packsPerSec} packs/s`;
  }

  // -------------------------------------------------------------- explainer

  private buildExplainer(root: HTMLElement): HTMLElement {
    const overlay = el("div", "explainer", root);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "About this piece");
    const panel = el("div", "explainer-panel", overlay);
    const close = el("button", "control-button explainer-close", panel, "close");
    close.addEventListener("click", () => this.toggleExplainer(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.toggleExplainer(false);
    });

    const section = (title: string, body: string) => {
      el("h2", "", panel, title);
      el("p", "", panel, body);
    };
    section("What is this?",
      "A live financial market, drawn from its raw parts. Every rectangle is one real " +
      "resting order on the Bitstamp BTC/USD order book, placed by someone, somewhere, " +
      "right now: buyers below in blue, sellers above in amber. The gap in the middle is " +
      "the spread: the distance between the highest price anyone will pay and the lowest " +
      "price anyone will accept. Watch it breathe.");
    section("The queue is the point",
      "At every price, orders wait in line: first to arrive, first to trade. That line is " +
      "usually invisible: most market data adds the queue up into a single number. Here each " +
      "order keeps its place: cells near the center line are next to trade, cells at the tail " +
      "may wait hours. Brightness is age: a new order holds its full color for about a " +
      "minute, then slowly dims as it waits. " +
      "Tap any cell to see its position, how much is ahead of it, and how long it has waited.");
    section("What to watch for",
      "Most quotes are withdrawn, not filled. The constant flicker is quoting machines " +
      "changing their minds hundreds of times a minute. A trade has no mark of its own: it " +
      "is the queue at the center line getting shorter, cells vanishing from the front of " +
      "the line where they were next to trade. A sweep is several prices emptying in a row, " +
      "one large order eating through them, and afterwards the market simply is somewhere " +
      "else. Then watch the hole refill: that is liquidity healing. At rest the frame " +
      "holds still on the book around the price; zoom in and a queue becomes countable, " +
      "one cell per order; zoom out and the far dim ones are wishes parked miles from the " +
      "price, some resting for days.");
    section("Finding your way",
      "Drag up or down to wander the price axis; scroll or pinch to zoom all " +
      "the way from single orders out to the market's whole shape. Once you " +
      "set a zoom, it holds until you return. Arrow keys travel too: tap to " +
      "step a few rows, hold to accelerate through the book; PageUp and " +
      "PageDown leap a screen at a time. Double-tap, double-click, or Home " +
      "snaps back to the current price, and a “follow the market” button " +
      "also appears whenever you have wandered off. Space pauses; " +
      "what you miss while paused replays on the way back, labeled.");
    section("Is it real?",
      "Yes, with one honest caveat. The order flow is Bitstamp's public feed, reconstructed " +
      "through a matching engine built for this piece, so at rare margins its matches can " +
      "differ from the venue's own. The label at the bottom always says what you are seeing: " +
      "live, replay of a recording, or simulated (when the feed drops, synthetic traders " +
      "seeded from the last real book keep the market breathing until it returns). Nothing " +
      "on screen is decoration: every mark is caused by an order event.");
    el("h2", "", panel, "Credits");
    const credits = el("p", "", panel,
      "A piece by Cameron Scarpati: a view of the beauty living inside the order " +
      "book. Market data: Bitstamp (BTC/USD). Engine, reconstruction, and " +
      "rendering are original work; source at ");
    const link = document.createElement("a");
    link.href = "https://github.com/CameronScarpati/price-time";
    link.textContent = "github.com/CameronScarpati/price-time";
    link.target = "_blank";
    link.rel = "noopener";
    credits.appendChild(link);
    credits.appendChild(document.createTextNode("."));
    return overlay;
  }

  private toggleExplainer(open: boolean): void {
    this.explainer.classList.toggle("open", open);
    if (open) this.engage();
  }

  fatal(message: string): void {
    const banner = el("div", "fatal", this.root);
    banner.textContent = `something broke: ${message}`;
  }
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][Math.min(n % 10, 4)] ?? "th";
  return `${n}${suffix}`;
}
