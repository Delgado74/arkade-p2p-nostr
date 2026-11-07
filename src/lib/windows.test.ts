import { describe, expect, it } from "vitest";
import type { TradeDm, TradeMessageType } from "./trade";
import { computeWindowState, TRADE_WINDOW_SECONDS } from "./windows";

const ORDER = "order-1";
const OTHER_ORDER = "order-2";
const TAKER = "11".repeat(32);

function entry(
  type: TradeMessageType,
  createdAt: number,
  options: {
    orderId?: string;
    outgoing?: boolean;
    buyerArkAddress?: string;
  } = {},
): TradeDm {
  return {
    dm: {
      id: `${type}:${createdAt}:${options.orderId ?? ORDER}:${Math.random()}`,
      createdAt,
      outgoing: options.outgoing ?? false,
      sender: TAKER,
      content: "",
    },
    msg: {
      app: "arkade-p2p-trade",
      v: 1,
      type,
      orderId: options.orderId ?? ORDER,
      role: "buyer",
      from: TAKER,
      ts: createdAt,
      payload:
        type === "take" && options.buyerArkAddress
          ? { buyerArkAddress: options.buyerArkAddress }
          : {},
    },
  } as unknown as TradeDm;
}

function windowState(feed: TradeDm[], now: number, funded = false) {
  return computeWindowState({
    feed,
    orderId: ORDER,
    role: "seller",
    isMaker: true,
    funded,
    now,
  });
}

describe("computeWindowState", () => {
  const take = entry("take", 1_000);
  const address = entry("taker_address", 1_100);
  const escrow = entry("escrow", 1_200);

  it("uses the earliest event even when relays reorder or replay messages", () => {
    const inOrder = windowState([take, address, escrow], 1_200 + TRADE_WINDOW_SECONDS);
    const reordered = windowState(
      [escrow, entry("taker_address", 1_150), address, entry("take", 1_050), take],
      1_200 + TRADE_WINDOW_SECONDS,
    );
    const replayed = windowState(
      [entry("take", 1_900), take, address, entry("escrow", 1_900), escrow],
      1_200 + TRADE_WINDOW_SECONDS,
    );

    expect(inOrder.culprit).toBe("maker");
    expect(reordered).toEqual(inOrder);
    expect(replayed).toEqual(inOrder);
  });

  it("ignores messages from another order", () => {
    expect(
      windowState(
        [take, address, entry("escrow", 5_000, { orderId: OTHER_ORDER })],
        1_200 + TRADE_WINDOW_SECONDS,
      ).culprit,
    ).toBe("maker");
  });

  it("stops applying windows once the escrow is funded", () => {
    expect(windowState([take, address, escrow], 10_000, true).anyExpired).toBe(false);
  });

  it("ignores the taker's own outgoing messages when looking for its signal", () => {
    expect(
      windowState([entry("take", 1_000, { outgoing: true })], 10_000).culprit,
    ).toBe(null);
  });
});
