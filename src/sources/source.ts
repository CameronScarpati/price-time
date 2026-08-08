import type { Command, Micro, OrderId, PriceTick, Sats, Side } from "../engine/types";

/**
 * The one interface all three flow sources implement (docs/design.md §2).
 * A source emits a single ordered stream of events; the pipeline folds the
 * commands into the engine and routes prints/statuses to annotation and mode
 * handling. Live, synthetic, and replay differ only in who has authority to
 * declare a match — the stream shape is identical, which is what makes the
 * degradation cross-fade and capture/replay possible at all.
 */

export type SourceKind = "live" | "synthetic" | "replay";

/** A trade print: the venue's (or synthetic matcher's) record of an execution.
 * Joins against order ids for aggressor side, the tape, and cross-validation. */
export interface TradePrint {
  tradeId: number;
  tick: PriceTick;
  sats: Sats;
  aggressor: Side;
  buyOrderId: OrderId;
  sellOrderId: OrderId;
  micro: Micro;
}

export type SourceStatus =
  | { phase: "connecting" }
  | { phase: "seeding" }
  /** Healthy and flowing. */
  | { phase: "flowing" }
  /** A sequence gap or divergence was detected; the book is being rebuilt. */
  | { phase: "reseeding"; reason: "gap" | "divergence" | "reconnect" }
  /** The source is down and will not recover on its own. */
  | { phase: "down"; reason: string };

export type SourceEvent =
  | { type: "command"; cmd: Command }
  | { type: "print"; print: TradePrint }
  | { type: "status"; status: SourceStatus };

export type SourceSink = (event: SourceEvent) => void;

export interface FlowSource {
  readonly kind: SourceKind;
  start(sink: SourceSink): void;
  stop(): void;
}
