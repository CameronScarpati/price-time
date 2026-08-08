/**
 * Raw Bitstamp v2 WebSocket message shapes, as verified against the live
 * socket on 2026-08-08 (docs/design.md §1). Field names here are the venue's,
 * not ours; normalize.ts translates them into domain vocabulary.
 */

export interface RawOrderData {
  id: number;
  id_str: string;
  /** 0 = buy, 1 = sell (confirmed in live sample data). */
  order_type: 0 | 1;
  /** Semantics unknown (observed 4, 5, 6); counted, never interpreted. */
  order_subtype: number;
  datetime: string;
  microtimestamp: string;
  amount: number;
  amount_str: string;
  /** Quantity traded IN THIS EVENT (verified: per-event, not cumulative). */
  amount_traded: string;
  amount_at_create: string;
  price: number;
  price_str: string;
  is_liquidation: boolean;
}

export interface RawOrderMessage {
  event: "order_created" | "order_changed" | "order_deleted";
  channel: string;
  data: RawOrderData;
  /** Chain link: every message's pre_event_id equals the previous message's
   * event_id on the same channel (verified 709/709) — exact gap detection. */
  event_id: string;
  pre_event_id: string;
  order_source: string;
}

export interface RawTradeData {
  id: number;
  timestamp: string;
  microtimestamp: string;
  amount: number;
  amount_str: string;
  price: number;
  price_str: string;
  /** Aggressor side: 0 = buy, 1 = sell. */
  type: 0 | 1;
  buy_order_id: number;
  sell_order_id: number;
}

export interface RawTradeMessage {
  event: "trade";
  channel: string;
  data: RawTradeData;
}

export interface RawControlMessage {
  event: "bts:subscription_succeeded" | "bts:request_reconnect" | "bts:error" | string;
  channel?: string;
  data?: unknown;
}

export type RawMessage = RawOrderMessage | RawTradeMessage | RawControlMessage;

export function isOrderMessage(msg: RawMessage): msg is RawOrderMessage {
  return msg.event === "order_created" || msg.event === "order_changed" || msg.event === "order_deleted";
}

export function isTradeMessage(msg: RawMessage): msg is RawTradeMessage {
  return msg.event === "trade";
}

/** REST order book snapshot with group=2: entries are [price, amount, order_id]. */
export interface RawSnapshot {
  timestamp: string;
  microtimestamp: string;
  bids: [string, string, string][];
  asks: [string, string, string][];
}
