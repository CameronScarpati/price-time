import { Side } from "../engine/types";
import { formatDecimal } from "../sources/bitstamp/decimal";
import { hitTest } from "../render/layout";
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
  live: "live — Bitstamp BTC/USD order flow → local matching engine",
  synthetic: "simulated — synthetic agents, seeded from the last real book",
  "synthetic-cold": "simulated — synthetic agents (live feed unreachable)",
  replay: "replay — recorded Bitstamp BTC/USD flow → local matching engine",
};

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
  private alpha = 0;
  private paused = false;
  private lastCaptionId = 0;
  private lastNarration = "";
  private lastNarrationAt = 0;
  private inspectToken = 0;
  private mode = "";
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  private readonly provenance: HTMLElement;
  private readonly modeDot: HTMLElement;
  private readonly modeText: HTMLElement;
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

    this.caption = el("div", "caption", root);
    this.caption.setAttribute("aria-hidden", "true");

    this.controls = el("div", "controls chrome", root);
    this.clockChip = el("span", "clock-chip", this.controls, "live");
    this.pauseButton = el("button", "control-button", this.controls, "pause");
    this.pauseButton.addEventListener("click", () => this.togglePause());
    const explainButton = el("button", "control-button", this.controls, "what am I looking at?");
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
      if (e.data.type === "inspection") this.showInspection(e.data.result);
      if (e.data.type === "fatal") this.fatal(e.data.message);
    });
  }

  // ---------------------------------------------------------------- delegate

  chromeAlpha(): number {
    // The follow chip rides its own logic: visible whenever the viewer has
    // panned away, regardless of chrome idle state — it IS the way back.
    this.followChip.classList.toggle("show", this.renderer().camera.detached);
    const target = performance.now() < this.chromeVisibleUntil ? 1 : 0;
    this.alpha += (target - this.alpha) * (this.reduced ? 1 : 0.12);
    const panels = [this.controls, this.tapePanel];
    for (const p of panels) {
      p.style.opacity = String(this.alpha);
      p.style.pointerEvents = this.alpha > 0.4 ? "auto" : "none";
    }
    return this.alpha;
  }

  reducedMotion(): boolean {
    return this.reduced;
  }

  onMeta(meta: FrameMeta): void {
    const modeKey =
      meta.mode === "synthetic" && !meta.seededFromLive ? "synthetic-cold" : meta.mode;
    if (modeKey !== this.mode) {
      this.mode = modeKey;
      this.modeText.textContent = " " + (MODE_LABEL[modeKey] ?? meta.mode);
      this.modeDot.dataset.mode = meta.mode;
    }
    this.modeDot.classList.toggle("degraded", meta.degraded);

    if (meta.caption !== null && meta.caption.id !== this.lastCaptionId) {
      this.lastCaptionId = meta.caption.id;
      this.caption.textContent = meta.caption.text;
      this.caption.classList.remove("caption-show");
      void this.caption.offsetWidth; // restart the CSS animation
      this.caption.classList.add("caption-show");
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

    if (this.alpha > 0.05) this.renderTape(meta);
    if (this.showHud) this.renderHud(meta);
  }

  // ------------------------------------------------------------- engagement

  private engage(): void {
    this.chromeVisibleUntil = performance.now() + 4000;
  }

  private wireEngagement(): void {
    for (const type of ["pointermove", "pointerdown", "touchstart"] as const) {
      window.addEventListener(type, () => this.engage(), { passive: true });
    }
    window.addEventListener("focusin", () => this.engage());
  }

  private wireKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      const camera = this.renderer().camera;
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.togglePause();
      } else if (e.key === "?") {
        this.toggleExplainer(true);
      } else if (e.key === "Escape") {
        this.toggleExplainer(false);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        camera.panTicks(((e.key === "ArrowUp" ? -1 : 1) * 80) / camera.pxPerTick);
        this.engage();
      } else if (e.key === "Home" || e.key === "0") {
        camera.recenter();
        this.engage();
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

  inspectAt(clientX: number, clientY: number): void {
    const r = this.renderer();
    const hit = hitTest(clientX, clientY, r.layoutParams, r.bestBid, r.bestAsk);
    if (hit === null) {
      this.inspector.style.opacity = "0";
      return;
    }
    const token = ++this.inspectToken;
    this.post({ type: "inspect", token, side: hit.side, tick: hit.tick, cumSats: Math.round(hit.cumSats) });
    this.inspector.style.left = `${Math.min(clientX + 14, innerWidth - 260)}px`;
    this.inspector.style.top = `${Math.min(clientY + 14, innerHeight - 90)}px`;
  }

  private showInspection(result: InspectionResult | null): void {
    if (result === null) {
      this.inspector.style.opacity = "0";
      return;
    }
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
      el("span", "inspector-dim", row,
        `${formatDecimal(t.sats, 8).replace(/0+$/, "").replace(/\.$/, "")} BTC`);
    }
  }

  private renderHud(meta: FrameMeta): void {
    const s = this.renderer().frameStats();
    this.hud.textContent =
      `frame p50 ${s.p50.toFixed(1)}ms · p95 ${s.p95.toFixed(1)}ms · p99 ${s.p99.toFixed(1)}ms · ` +
      `>16.7ms ${s.over16_7}/600 · ${meta.stats.msgsPerSec.toFixed(0)} msg/s · ` +
      `${meta.stats.orders} orders · ${meta.stats.anomalies} anomalies`;
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
      "resting order on the Bitstamp BTC/USD order book — buyers below in blue, sellers " +
      "above in amber — placed by someone, somewhere, right now. The gap in the middle is " +
      "the spread: the distance between the highest price anyone will pay and the lowest " +
      "price anyone will accept. Watch it breathe.");
    section("The queue is the point",
      "At every price, orders wait in line — first to arrive, first to trade. That line is " +
      "usually invisible: most market data adds the queue up into a single number. Here each " +
      "order keeps its place: cells near the center line are next to trade, cells at the tail " +
      "may wait hours. Brightness is age — new orders arrive bright and dim as they wait. " +
      "Tap any cell to see its position, how much is ahead of it, and how long it has waited.");
    section("What to watch for",
      "Most quotes are withdrawn, not filled — the constant flicker is quoting machines " +
      "changing their minds hundreds of times a minute. A flash at the center line is a real " +
      "trade. A run of flashes climbing the book is a sweep: one large order eating through " +
      "several prices. After a sweep, watch the hole refill — that is liquidity healing. " +
      "Zoom out and the queues melt into the market's whole shape; the far, dim orders are " +
      "wishes parked miles from the price, some resting for days.");
    section("Finding your way",
      "Drag up or down to wander the price axis; scroll or pinch to zoom all " +
      "the way from single orders out to the market's whole shape. Double-tap " +
      "(or double-click) to snap back to where the market is trading — a " +
      "“follow the market” button also appears whenever you have " +
      "wandered off. Space pauses; what you miss while paused replays on the " +
      "way back, labeled.");
    section("Is it real?",
      "Yes, with one honest caveat. The order flow is Bitstamp's public feed, reconstructed " +
      "through a matching engine built for this piece — so at rare margins its matches can " +
      "differ from the venue's own. The label at the bottom always says what you are seeing: " +
      "live, replay of a recording, or simulated (when the feed drops, synthetic traders " +
      "seeded from the last real book keep the market breathing until it returns). Nothing " +
      "on screen is decoration: every mark is caused by an order event.");
    el("h2", "", panel, "Credits");
    const credits = el("p", "", panel,
      "A piece by Cameron Scarpati — a view of the beauty living inside market " +
      "microstructure. Market data: Bitstamp (BTC/USD). Engine, reconstruction, and " +
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
