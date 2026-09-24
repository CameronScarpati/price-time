import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_FADE_MS, chromeFadeAlpha, Ui } from "../../src/ui/ui";
import { Side } from "../../src/engine/types";
import type { Renderer } from "../../src/render/renderer";
import type {
  FrameMeta, InspectionResult, MainToWorker, WorkerToMain,
} from "../../src/worker/protocol";

/**
 * The chrome is the only DOM that moves, and it moves on the same terms as
 * the field: a finite fade that lands EXACTLY and then holds, bitwise, so the
 * renderer's unchanged-frame skip can fire again the moment it has landed.
 * Captions are chrome: they may speak only while the viewer is engaged, and
 * they leave with the chrome rather than popping off.
 */

describe("chromeFadeAlpha", () => {
  const rise = { from: 0, to: 1, atMs: 1000 };

  it("travels a straight line and lands exactly on its target", () => {
    expect(chromeFadeAlpha(rise, 1000, CHROME_FADE_MS)).toBe(0);
    expect(chromeFadeAlpha(rise, 1000 + CHROME_FADE_MS / 2, CHROME_FADE_MS)).toBeCloseTo(0.5, 12);
    expect(chromeFadeAlpha(rise, 1000 + CHROME_FADE_MS, CHROME_FADE_MS)).toBe(1);
    // And holds: no tail, no overshoot, the same bits forever after.
    for (const t of [1201, 1500, 60_000, 1e9]) expect(chromeFadeAlpha(rise, t, CHROME_FADE_MS)).toBe(1);
  });

  it("lands exactly on 0 on the way out, too", () => {
    const fall = { from: 1, to: 0, atMs: 0 };
    expect(chromeFadeAlpha(fall, CHROME_FADE_MS * 0.25, CHROME_FADE_MS)).toBeCloseTo(0.75, 12);
    expect(chromeFadeAlpha(fall, CHROME_FADE_MS, CHROME_FADE_MS)).toBe(0);
    expect(chromeFadeAlpha(fall, 1e9, CHROME_FADE_MS)).toBe(0);
  });

  it("reverses from where it stood, at the same rate, over the shorter distance", () => {
    const back = { from: 0.5, to: 0, atMs: 0 };
    expect(chromeFadeAlpha(back, CHROME_FADE_MS / 2, CHROME_FADE_MS)).toBe(0);
  });

  it("cuts when the fade has no duration (reduced motion)", () => {
    expect(chromeFadeAlpha(rise, 1000, 0)).toBe(1);
    expect(chromeFadeAlpha({ from: 1, to: 0, atMs: 5 }, 5, 0)).toBe(0);
  });

  it("never runs backwards before its start", () => {
    expect(chromeFadeAlpha(rise, 900, CHROME_FADE_MS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The Ui itself, on a minimal stand-in DOM (the suite runs in node).
// ---------------------------------------------------------------------------

class FakeNode {
  className = "";
  textContent = "";
  innerHTML = "";
  href = "";
  target = "";
  rel = "";
  offsetWidth = 0;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly children: FakeNode[] = [];
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
  };
  setAttribute(): void {}
  addEventListener(): void {}
  appendChild<T>(child: T): T {
    if (child instanceof FakeNode) this.children.push(child);
    return child;
  }
  find(className: string): FakeNode {
    for (const c of this.children) {
      if (c.className === className) return c;
      const deep = c.children.length > 0 ? c.tryFind(className) : null;
      if (deep !== null) return deep;
    }
    throw new Error(`no .${className}`);
  }
  private tryFind(className: string): FakeNode | null {
    try {
      return this.find(className);
    } catch {
      return null;
    }
  }
}

let clock = 0;

function stubDom(reduced = false): void {
  vi.stubGlobal("document", {
    createElement: () => new FakeNode(),
    createTextNode: () => new FakeNode(),
  });
  vi.stubGlobal("window", { addEventListener: () => {} });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduced-motion") }));
}

function makeUi(reduced = false): { ui: Ui; root: FakeNode } {
  stubDom(reduced);
  const root = new FakeNode();
  const worker = { addEventListener: () => {}, postMessage: () => {} };
  const renderer = { camera: { detached: false } };
  const ui = new Ui(
    root as unknown as HTMLElement,
    worker as unknown as Worker,
    () => renderer as unknown as Renderer,
    false,
  );
  return { ui, root };
}

function meta(caption: { text: string; id: number } | null): FrameMeta {
  return {
    mode: "synthetic",
    seededFromLive: false,
    degraded: false,
    clock: { state: "live", behindMs: 0, speed: 1 },
    nowSec: 0,
    tape: [],
    caption,
    narration: "",
    stats: { msgsPerSec: 0, tradesPerMin: 0, orders: 0, anomalies: 0, coreMedianSats: 1 },
    transition: null,
    packsPerSec: 0,
  };
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Ui chrome fade", () => {
  it("fades in and out on the clock, lands exactly, and holds", () => {
    const { ui, root } = makeUi();
    const controls = root.find("controls chrome");
    clock = 1000;
    expect(ui.chromeAlpha()).toBe(0); // at rest: nothing to show
    expect(controls.style.pointerEvents).toBe("none");

    ui.engage(); // visible until 5000
    expect(ui.chromeAlpha()).toBe(0);
    clock = 1000 + CHROME_FADE_MS / 2;
    expect(ui.chromeAlpha()).toBeCloseTo(0.5, 12);
    clock = 1000 + CHROME_FADE_MS;
    expect(ui.chromeAlpha()).toBe(1);
    expect(controls.style.opacity).toBe("1");
    expect(controls.style.pointerEvents).toBe("auto");
    clock = 4999;
    expect(ui.chromeAlpha()).toBe(1);

    clock = 5000; // the 4s window closes
    expect(ui.chromeAlpha()).toBe(1);
    clock = 5000 + CHROME_FADE_MS / 2;
    expect(ui.chromeAlpha()).toBeCloseTo(0.5, 12);
    clock = 5000 + CHROME_FADE_MS;
    expect(ui.chromeAlpha()).toBe(0);
    // The old ease was still moving ~48s later; this one has stopped.
    clock = 5000 + 48_000;
    expect(ui.chromeAlpha()).toBe(0);
    expect(controls.style.opacity).toBe("0");
    expect(controls.style.pointerEvents).toBe("none");
  });

  it("is idempotent within a frame: asking twice does not double the speed", () => {
    const once = makeUi().ui;
    const twice = makeUi().ui;
    once.engage();
    twice.engage();
    for (clock = 0; clock <= 96; clock += 16) {
      once.chromeAlpha();
      twice.chromeAlpha();
      twice.chromeAlpha();
    }
    clock = 96;
    expect(twice.chromeAlpha()).toBe(once.chromeAlpha());
    expect(once.chromeAlpha()).toBeCloseTo(96 / CHROME_FADE_MS, 12);
  });

  it("reverses mid-fade from where it stood", () => {
    const { ui } = makeUi();
    ui.engage(); // visible until 4000
    ui.chromeAlpha();
    clock = 3950;
    expect(ui.chromeAlpha()).toBe(1);
    clock = 4000 + CHROME_FADE_MS / 4; // fading out: 0.75
    expect(ui.chromeAlpha()).toBeCloseTo(0.75, 12);
    ui.engage(); // back in from 0.75, not from 0 or 1
    expect(ui.chromeAlpha()).toBeCloseTo(0.75, 12);
    clock += CHROME_FADE_MS / 4;
    expect(ui.chromeAlpha()).toBe(1);
  });

  it("cuts under reduced motion", () => {
    const { ui } = makeUi(true);
    ui.engage();
    expect(ui.chromeAlpha()).toBe(1);
    clock = 4000;
    expect(ui.chromeAlpha()).toBe(0);
  });
});

describe("Ui captions speak only while engaged", () => {
  it("drops a caption that fires at rest, and does not queue it", () => {
    const { ui, root } = makeUi();
    const caption = root.find("caption");
    clock = 10_000;
    ui.chromeAlpha();
    ui.onMeta(meta({ text: "a vacuum", id: 1 }));
    expect(caption.classList.contains("caption-show")).toBe(false);
    expect(caption.textContent).toBe("");

    // Engaging afterwards does not bring the dropped caption back.
    ui.engage();
    ui.onMeta(meta({ text: "a vacuum", id: 1 }));
    expect(caption.classList.contains("caption-show")).toBe(false);

    // A new one, while engaged, shows.
    ui.onMeta(meta({ text: "a sweep", id: 2 }));
    expect(caption.classList.contains("caption-show")).toBe(true);
    expect(caption.textContent).toBe("a sweep");
  });

  it("leaves with the chrome, faded by it, and stays gone", () => {
    const { ui, root } = makeUi();
    const band = root.find("caption-band");
    const caption = root.find("caption");
    ui.engage(); // visible until 4000
    ui.onMeta(meta({ text: "a sweep", id: 1 }));
    ui.chromeAlpha();
    clock = 3000;
    ui.chromeAlpha();
    expect(band.style.opacity).toBe("1");
    expect(caption.classList.contains("caption-show")).toBe(true);

    clock = 4000 + CHROME_FADE_MS / 2;
    ui.chromeAlpha();
    expect(Number(band.style.opacity)).toBeCloseTo(0.5, 12); // fading, not popping
    expect(caption.classList.contains("caption-show")).toBe(true);

    clock = 4000 + CHROME_FADE_MS;
    ui.chromeAlpha();
    expect(band.style.opacity).toBe("0");
    expect(caption.classList.contains("caption-show")).toBe(false);

    // Re-engaging inside the caption's old 6s life does not revive it.
    ui.engage();
    clock += CHROME_FADE_MS;
    ui.chromeAlpha();
    expect(caption.classList.contains("caption-show")).toBe(false);
    // The full-screen band must never take the pointer from the canvas.
    expect(band.style.pointerEvents).toBeUndefined();
  });
});

describe("Ui inspector", () => {
  // One tick per 8px about a centre at y=400, the seam at x=400: the best bid
  // (tick 999) is the row at y=408 left of the seam, the best offer (tick
  // 1001) the row at y=392 right of it.
  function makeInspectorUi() {
    stubDom();
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("innerHeight", 860);
    const posted: MainToWorker[] = [];
    let onMessage: (e: { data: WorkerToMain }) => void = () => {};
    const worker = {
      addEventListener: (_type: string, fn: typeof onMessage) => void (onMessage = fn),
      postMessage: (msg: MainToWorker) => void posted.push(msg),
    };
    const renderer = {
      camera: { detached: false },
      layoutParams: {
        centerTick: 1000, pxPerTick: 8, viewH: 800, centerYFrac: 0.5,
        seamX: 400, layout: 0, pxPerSat: 1,
      },
      bestBid: 999,
      bestAsk: 1001,
    };
    const root = new FakeNode();
    const ui = new Ui(
      root as unknown as HTMLElement,
      worker as unknown as Worker,
      () => renderer as unknown as Renderer,
      false,
    );
    const lastAsk = () => {
      const asks = posted.filter((m) => m.type === "inspect");
      return asks[asks.length - 1]!;
    };
    const reply = (token: number, result: InspectionResult | null) =>
      onMessage({ data: { type: "inspection", token, result } });
    return { ui, inspector: root.find("inspector"), posted, lastAsk, reply };
  }

  const order = (id: number, side: Side, tick: number): InspectionResult => ({
    id, side, tick, sats: 1e8, aheadSats: 0,
    queuePosition: 1, queueLength: 1, ageSec: 2, liquidation: false,
  });

  it("describes the order under the pointer when a re-check lands mid-ask", () => {
    const { ui, inspector, posted, lastAsk, reply } = makeInspectorUi();
    ui.inspectAt(390, 408);
    reply(lastAsk().token, order(1, Side.Bid, 999));
    expect(inspector.style.opacity).toBe("1");

    // Straight to the offer, and a frame past the 400ms re-check arrives
    // before the worker answers. The re-check must not take the newer token
    // and bring the bid back.
    ui.inspectAt(410, 392);
    const ask = lastAsk();
    expect(ask).toMatchObject({ sides: [Side.Ask], tick: 1001 });
    clock = 1000;
    ui.onMeta(meta(null));
    reply(ask.token, order(2, Side.Ask, 1001));
    const prices = inspector.children.filter((c) => c.className === "inspector-price");
    expect(prices[prices.length - 1]!.textContent).toBe("1 BTC offer @ $10.01");

    // From here the re-check follows the offer.
    clock = 1500;
    ui.onMeta(meta(null));
    expect(posted[posted.length - 1]).toMatchObject({ type: "watch", id: 2 });
  });
});

describe("stylesheet stillness", () => {
  const css = readFileSync(new URL("../../src/style.css", import.meta.url), "utf8");

  it("runs no perpetual animation", () => {
    expect(css).not.toMatch(/infinite/);
  });

  it("fades the caption in place: its keyframes animate opacity only", () => {
    const frames = /@keyframes caption \{([\s\S]*?)\n\}/.exec(css);
    expect(frames).not.toBeNull();
    expect(frames![1]).not.toMatch(/transform|translate/);
    expect(frames![1]).toMatch(/opacity/);
  });
});
