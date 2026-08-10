/**
 * Domain vocabulary. An engineer who knows markets should recognize their world
 * in these types; see docs/brief.md's glossary for the terms.
 *
 * All quantities are integers: prices in ticks (cents for BTC/USD), sizes in
 * satoshis. Both fit exactly in a JS number (2.1e15 sats max < 2^53), so the
 * engine never touches floating point arithmetic on market quantities.
 */

/** Integer price in ticks (cents). */
export type PriceTick = number;
/** Integer quantity in satoshis. */
export type Sats = number;
/** Venue order id (Bitstamp ids are < 2^53, exact in a JS number). */
export type OrderId = number;
/** Monotonic engine sequence number; defines time priority. Lower = earlier. */
export type Seq = number;
/** Venue microsecond timestamp (informational; priority comes from Seq). */
export type Micro = number;

export const Side = { Bid: 0, Ask: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];

export function opposite(side: Side): Side {
  return side === Side.Bid ? Side.Ask : Side.Bid;
}

/** Time-in-force for orders placed through the internal matcher. */
export type TimeInForce = "gtc" | "ioc" | "fok";

/**
 * Who has authority to declare a match (docs/design.md §2). Internal: this
 * engine's matcher (synthetic mode, strict invariants). External: the venue's
 * event stream (live/replay mode) — its fills are applied as facts even when
 * they disagree with local expectations, and disagreements are counted as
 * anomalies rather than "corrected".
 */
export type MatchAuthority = "internal" | "external";

/** A resting order as seeded from a venue snapshot, in queue order. */
export interface SeedOrder {
  id: OrderId;
  side: Side;
  tick: PriceTick;
  sats: Sats;
  micro: Micro;
}

// ---------------------------------------------------------------------------
// Commands — the engine is a deterministic fold over an ordered command stream.
// ---------------------------------------------------------------------------

/** Internal-matching path (synthetic mode): the engine decides what matches. */
export interface PlaceCmd {
  kind: "place";
  id: OrderId;
  side: Side;
  /** Limit price, or null for a market order (never rests). */
  tick: PriceTick | null;
  sats: Sats;
  tif: TimeInForce;
  postOnly?: boolean;
}
export interface CancelCmd {
  kind: "cancel";
  id: OrderId;
}
/** Cancel-replace: loses queue position by design — that is the real rule. */
export interface ReplaceCmd {
  kind: "replace";
  id: OrderId;
  tick: PriceTick;
  sats: Sats;
}

/** External-authority path (live/replay): the venue's events applied as facts. */
export interface SeedCmd {
  kind: "seed";
  orders: SeedOrder[];
}
/** Venue says this order rests (Bitstamp order_created). Idempotent upsert. */
export interface RestCmd {
  kind: "rest";
  id: OrderId;
  side: Side;
  tick: PriceTick;
  sats: Sats;
  micro: Micro;
  liquidation?: boolean;
}
/** Venue says this order's remaining changed (order_changed). tradedSats > 0 means a fill. */
export interface ReduceCmd {
  kind: "reduce";
  id: OrderId;
  side: Side;
  tick: PriceTick;
  /** New remaining quantity — authoritative. */
  sats: Sats;
  /** Quantity traded in this event (0 = pure resize). */
  tradedSats: Sats;
  micro: Micro;
}
/** Venue says this order left the book (order_deleted). tradedSats > 0 means it filled out. */
export interface RemoveCmd {
  kind: "remove";
  id: OrderId;
  tradedSats: Sats;
  micro: Micro;
}

export type Command =
  | PlaceCmd
  | CancelCmd
  | ReplaceCmd
  | SeedCmd
  | RestCmd
  | ReduceCmd
  | RemoveCmd;

// ---------------------------------------------------------------------------
// Events — everything downstream (renderer, detectors, tests) sees only these.
// ---------------------------------------------------------------------------

export interface RestedEvent {
  kind: "rested";
  id: OrderId;
  side: Side;
  tick: PriceTick;
  sats: Sats;
  seq: Seq;
}
/** A match. Maker is the resting side; aggressor is the taker's side. */
export interface TradeEvent {
  kind: "trade";
  makerId: OrderId;
  /** Taker order id when known (internal matching); null for external fills. */
  takerId: OrderId | null;
  aggressor: Side;
  tick: PriceTick;
  sats: Sats;
  /** Maker's remaining quantity after this fill. */
  makerRemaining: Sats;
  /** The consumed maker was a forced liquidation (venue-flagged). */
  liquidation: boolean;
  seq: Seq;
}
export interface CanceledEvent {
  kind: "canceled";
  id: OrderId;
  side: Side;
  tick: PriceTick;
  /** Quantity that was still resting when the order was pulled. */
  sats: Sats;
  /** Quantity that was queued ahead of it — where in the line it died. */
  aheadSats: Sats;
  seq: Seq;
}
/** Pure resize with no trade (rare; live only). Position is kept. */
export interface ResizedEvent {
  kind: "resized";
  id: OrderId;
  side: Side;
  tick: PriceTick;
  from: Sats;
  to: Sats;
  seq: Seq;
}
/** An aggressor's remainder that could not fill and does not rest (market/IOC). */
export interface UnfilledEvent {
  kind: "unfilled";
  id: OrderId;
  side: Side;
  sats: Sats;
  seq: Seq;
}
export type RejectReason =
  | "duplicate-id"
  | "unknown-order"
  | "bad-quantity"
  | "bad-price"
  | "post-only-cross"
  | "fok-unfillable"
  | "market-post-only";
export interface RejectedEvent {
  kind: "rejected";
  id: OrderId;
  reason: RejectReason;
  seq: Seq;
}
export interface SeededEvent {
  kind: "seeded";
  count: number;
  seq: Seq;
}
/**
 * The venue asserted something our book disagrees with (live mode only) —
 * e.g. a fill against an order that is not at its queue's front. The venue is
 * right and we apply it; the anomaly is counted and surfaced, never hidden.
 *
 * Two classes. EXPECTED anomalies are normal artifacts of the reconstruction
 * protocol (events about orders that predate our snapshot, snapshot/buffer
 * overlap) and say nothing about book health. Everything else is genuine
 * local/venue disagreement and feeds the divergence metric.
 */
export type AnomalyKind =
  | "consume-not-front"
  | "reduce-unknown-order"
  | "remove-unknown-order"
  | "rest-existing-order"
  | "grew-in-place"
  | "side-changed"
  | "traded-mismatch"
  | "seed-duplicate-id"
  | "invalid-external-value";
export const EXPECTED_ANOMALIES: ReadonlySet<AnomalyKind> = new Set([
  "rest-existing-order",
  "reduce-unknown-order",
  "remove-unknown-order",
] satisfies AnomalyKind[]);
export interface AnomalyEvent {
  kind: "anomaly";
  anomaly: AnomalyKind;
  id: OrderId;
  seq: Seq;
}

export type EngineEvent =
  | RestedEvent
  | TradeEvent
  | CanceledEvent
  | ResizedEvent
  | UnfilledEvent
  | RejectedEvent
  | SeededEvent
  | AnomalyEvent;
