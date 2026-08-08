import { describe, expect, it } from "vitest";
import { formatDecimal, parseDecimal } from "../../src/sources/bitstamp/decimal";
import {
  BTCUSD,
  normalizeOrderMessage,
  normalizeSnapshot,
  normalizeTradeMessage,
} from "../../src/sources/bitstamp/normalize";
import type { RawOrderMessage, RawTradeMessage } from "../../src/sources/bitstamp/messages";
import { Side } from "../../src/engine/types";
import fc from "fast-check";

describe("decimal parsing", () => {
  it("parses venue strings exactly, without floating point", () => {
    expect(parseDecimal("65037.90", 2)).toBe(6503790);
    expect(parseDecimal("65037.9", 2)).toBe(6503790);
    expect(parseDecimal("65037", 2)).toBe(6503700);
    expect(parseDecimal("0.00007768", 8)).toBe(7768);
    expect(parseDecimal("0", 8)).toBe(0);
    // The classic float trap: 0.1 + 0.2 style values stay exact as integers.
    expect(parseDecimal("0.30000001", 8)).toBe(30000001);
  });

  it("rejects excess precision loudly rather than rounding a book silently", () => {
    expect(() => parseDecimal("1.234", 2)).toThrow();
  });

  it("round-trips with formatDecimal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_100_000_000_000_000 }),
        fc.integer({ min: 0, max: 8 }),
        (value, decimals) => {
          expect(parseDecimal(formatDecimal(value, decimals), decimals)).toBe(value);
        },
      ),
    );
  });
});

const orderData = {
  id: 2037231589982208,
  id_str: "2037231589982208",
  order_type: 0 as const,
  order_subtype: 5,
  datetime: "1786205968",
  microtimestamp: "1786205968306000",
  amount: 0.1,
  amount_str: "0.10000000",
  amount_traded: "0",
  amount_at_create: "0.10000000",
  price: 65037.9,
  price_str: "65037.90",
  is_liquidation: false,
};

describe("order message normalization (the verified attribution rule)", () => {
  it("order_created becomes rest", () => {
    const msg: RawOrderMessage = {
      event: "order_created", channel: "live_orders_btcusd", data: orderData,
      event_id: "a", pre_event_id: "b", order_source: "orderbook",
    };
    expect(normalizeOrderMessage(msg, BTCUSD)).toEqual({
      kind: "rest", id: 2037231589982208, side: Side.Bid,
      tick: 6503790, sats: 10_000_000, micro: 1786205968306000,
    });
  });

  it("order_deleted with amount_traded 0 is a cancel; with quantity it is a fill", () => {
    const cancel: RawOrderMessage = {
      event: "order_deleted", channel: "live_orders_btcusd", data: orderData,
      event_id: "a", pre_event_id: "b", order_source: "orderbook",
    };
    expect(normalizeOrderMessage(cancel, BTCUSD)).toMatchObject({ kind: "remove", tradedSats: 0 });

    const fill: RawOrderMessage = {
      ...cancel,
      data: { ...orderData, amount_traded: "0.05000000" },
    };
    expect(normalizeOrderMessage(fill, BTCUSD)).toMatchObject({ kind: "remove", tradedSats: 5_000_000 });
  });

  it("order_changed carries the new remaining and the per-event traded quantity", () => {
    const msg: RawOrderMessage = {
      event: "order_changed", channel: "live_orders_btcusd",
      data: { ...orderData, order_type: 1, amount_str: "0.21981200", amount_traded: "0.00018800" },
      event_id: "a", pre_event_id: "b", order_source: "orderbook",
    };
    expect(normalizeOrderMessage(msg, BTCUSD)).toEqual({
      kind: "reduce", id: orderData.id, side: Side.Ask, tick: 6503790,
      sats: 21_981_200, tradedSats: 18_800, micro: 1786205968306000,
    });
  });
});

describe("trade normalization", () => {
  it("carries maker/taker order ids and aggressor side", () => {
    const msg: RawTradeMessage = {
      event: "trade", channel: "live_trades_btcusd",
      data: {
        id: 614598702, timestamp: "1786206017", microtimestamp: "1786206017013000",
        amount: 0.000188, amount_str: "0.00018800", price: 65037.9, price_str: "65037.90",
        type: 0, buy_order_id: 2037231789490177, sell_order_id: 2037231612952577,
      },
    };
    expect(normalizeTradeMessage(msg, BTCUSD)).toEqual({
      tradeId: 614598702, tick: 6503790, sats: 18_800, aggressor: Side.Bid,
      buyOrderId: 2037231789490177, sellOrderId: 2037231612952577, micro: 1786206017013000,
    });
  });
});

describe("snapshot normalization", () => {
  it("preserves listing order — which is queue order at each price", () => {
    const orders = normalizeSnapshot(
      {
        timestamp: "1", microtimestamp: "1000000",
        bids: [["65037.89", "0.09984466", "101"], ["65037.89", "0.25000000", "102"]],
        asks: [["65037.91", "1.00000000", "201"]],
      },
      BTCUSD,
    );
    expect(orders.map((o) => o.id)).toEqual([101, 102, 201]);
    expect(orders[0]).toMatchObject({ side: Side.Bid, tick: 6503789, sats: 9_984_466 });
    expect(orders[2]).toMatchObject({ side: Side.Ask, tick: 6503791 });
  });
});
