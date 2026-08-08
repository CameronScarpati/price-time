import type { FlowSource, SourceEvent, SourceSink } from "../source";
import { isOrderMessage, isTradeMessage } from "../bitstamp/messages";
import { normalizeOrderMessage, normalizeSnapshot, normalizeTradeMessage } from "../bitstamp/normalize";
import type { Instrument } from "../bitstamp/normalize";
import type { CaptureRecord } from "./format";

/**
 * Replays a recorded session through the same normalization the live source
 * uses, preserving the recording's authority (venue events stay venue
 * events) and its real timing, scaled by `speed`. When the capture ends the
 * source reports down — the pipeline hands off to synthetic rather than
 * looping, because a loop is a lie about a market that never repeats.
 */
export class ReplaySource implements FlowSource {
  readonly kind = "replay" as const;

  private readonly records: CaptureRecord[];
  private readonly instrument: Instrument;
  private sink: SourceSink | null = null;
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Capture-time ms already consumed up to `index`. */
  private consumedMs = 0;
  private speed: number;
  /** Events recorded before the snapshot line. A capture interleaves them in
   * arrival order, but the seeding procedure is buffer → seed → drain: a
   * deletion received while the snapshot was in flight must be applied AFTER
   * the seed, or the deleted order survives as a phantom inside the spread
   * (caught by the golden test against a real capture). */
  private preSeedBuffer: SourceEvent[] = [];
  private seeded = false;

  constructor(records: CaptureRecord[], instrument: Instrument, speed = 1) {
    this.records = records;
    this.instrument = instrument;
    this.speed = speed;
  }

  start(sink: SourceSink): void {
    this.sink = sink;
    this.index = 0;
    this.consumedMs = 0;
    this.preSeedBuffer = [];
    this.seeded = false;
    sink({ type: "status", status: { phase: "seeding" } });
    this.pump();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.sink = null;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /** Emit all records due at or before capture-time `consumedMs`, then sleep
   * until the next one. Instant (speed = Infinity) drains synchronously. */
  private pump(): void {
    this.timer = null;
    const sink = this.sink;
    if (sink === null) return;

    while (this.index < this.records.length) {
      const record = this.records[this.index];
      const due = "at" in record ? record.at : 0;
      if (Number.isFinite(this.speed) && due > this.consumedMs) {
        const waitMs = (due - this.consumedMs) / this.speed;
        this.timer = setTimeout(() => {
          this.consumedMs = due;
          this.pump();
        }, waitMs);
        return;
      }
      this.consumedMs = due;
      this.index++;
      const event = this.toEvent(record);
      if (event !== null) {
        if (!this.seeded && record.type === "msg") {
          this.preSeedBuffer.push(event);
        } else {
          sink(event);
        }
      }
      if (record.type === "snapshot") {
        this.seeded = true;
        for (const buffered of this.preSeedBuffer) sink(buffered);
        this.preSeedBuffer = [];
        sink({ type: "status", status: { phase: "flowing" } });
      }
    }
    sink({ type: "status", status: { phase: "down", reason: "capture ended" } });
  }

  private toEvent(record: CaptureRecord): SourceEvent | null {
    switch (record.type) {
      case "snapshot":
        return {
          type: "command",
          cmd: { kind: "seed", orders: normalizeSnapshot(record.data, this.instrument) },
        };
      case "msg":
        if (isOrderMessage(record.data)) {
          return { type: "command", cmd: normalizeOrderMessage(record.data, this.instrument) };
        }
        if (isTradeMessage(record.data)) {
          return { type: "print", print: normalizeTradeMessage(record.data, this.instrument) };
        }
        return null;
      case "meta":
      case "closing_snapshot":
        return null;
    }
  }
}
