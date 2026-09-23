import { Side, type Command, type SeedOrder } from "../../engine/types";
import type { TradePrint } from "../source";
import { parseDecimal } from "./decimal";
import type { RawOrderMessage, RawSnapshot, RawTradeMessage } from "./messages";

/**
 * Instrument definition: how a pair's decimal strings map to integer ticks
 * and sats. BTC/USD quotes prices in cents and amounts in hundred-millionths.
 */
export interface Instrument {
  pair: string;
  priceDecimals: number;
  amountDecimals: number;
}

export const BTCUSD: Instrument = { pair: "btcusd", priceDecimals: 2, amountDecimals: 8 };

/**
 * Translate a venue order event into the engine command it asserts
 * (docs/design.md §5). The mapping encodes the verified attribution rule:
 * amount_traded > 0 means the event was caused by a fill; zero means a
 * cancel (deleted) or resize (changed).
 */
export function normalizeOrderMessage(msg: RawOrderMessage, instrument: Instrument): Command {
  const d = msg.data;
  const side: Side = d.order_type === 0 ? Side.Bid : Side.Ask;
  const tradedSats = parseDecimal(d.amount_traded, instrument.amountDecimals);
  const micro = Number(d.microtimestamp);

  // A deletion names the order by id alone, so its price is never parsed:
  // the venue deletes orders that never rested, at prices off the cent grid
  // (a recorded "63941.91523761"), and the strict parse would throw on them.
  switch (msg.event) {
    case "order_created":
      return {
        kind: "rest", id: d.id, side, micro,
        tick: parseDecimal(d.price_str, instrument.priceDecimals),
        sats: parseDecimal(d.amount_str, instrument.amountDecimals),
        ...(d.is_liquidation ? { liquidation: true } : {}),
      };
    case "order_changed":
      return {
        kind: "reduce", id: d.id, side, tradedSats, micro,
        tick: parseDecimal(d.price_str, instrument.priceDecimals),
        sats: parseDecimal(d.amount_str, instrument.amountDecimals),
      };
    case "order_deleted":
      return { kind: "remove", id: d.id, tradedSats, micro };
  }
}

export function normalizeTradeMessage(msg: RawTradeMessage, instrument: Instrument): TradePrint {
  const d = msg.data;
  return {
    tradeId: d.id,
    tick: parseDecimal(d.price_str, instrument.priceDecimals),
    sats: parseDecimal(d.amount_str, instrument.amountDecimals),
    aggressor: d.type === 0 ? Side.Bid : Side.Ask,
    buyOrderId: d.buy_order_id,
    sellOrderId: d.sell_order_id,
    micro: Number(d.microtimestamp),
  };
}

/**
 * Translate a group=2 snapshot into seed orders. Listing order within a price
 * is queue order (verified: ascending-id in all observed multi-order levels),
 * so seeding in listing order reproduces the venue's queues.
 */
export function normalizeSnapshot(snapshot: RawSnapshot, instrument: Instrument): SeedOrder[] {
  const micro = Number(snapshot.microtimestamp);
  const orders: SeedOrder[] = [];
  for (const [price, amount, id] of snapshot.bids) {
    orders.push({
      id: Number(id), side: Side.Bid,
      tick: parseDecimal(price, instrument.priceDecimals),
      sats: parseDecimal(amount, instrument.amountDecimals),
      micro,
    });
  }
  for (const [price, amount, id] of snapshot.asks) {
    orders.push({
      id: Number(id), side: Side.Ask,
      tick: parseDecimal(price, instrument.priceDecimals),
      sats: parseDecimal(amount, instrument.amountDecimals),
      micro,
    });
  }
  return orders;
}
