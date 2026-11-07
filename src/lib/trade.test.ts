import { describe, expect, it } from "vitest";
import { decodeTradeMessage, TRADE_APP, TRADE_VERSION } from "./trade";

const HEX = (n: number) => n.toString(16).padStart(64, "0");

function message(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    app: TRADE_APP,
    v: TRADE_VERSION,
    type,
    orderId: "order-1",
    role: "buyer",
    from: HEX(1),
    ts: Date.now(),
    payload,
    ...overrides,
  });
}

describe("decodeTradeMessage runtime validation", () => {
  it("accepts valid chat and take envelopes", () => {
    expect(decodeTradeMessage(message("chat", { text: "hola" }))?.type).toBe("chat");
    expect(
      decodeTradeMessage(message("take", { buyerArkAddress: "ark1q..." }))?.type,
    ).toBe("take");
  });

  it("rejects a wrong protocol version, unknown type or non-hex author", () => {
    expect(decodeTradeMessage(message("chat", { text: "hola" }, { v: 2 }))).toBeNull();
    expect(decodeTradeMessage(message("nope", { text: "hola" }))).toBeNull();
    expect(decodeTradeMessage(message("chat", { text: "hola" }, { from: "mallory" }))).toBeNull();
  });

  it("rejects a missing or oversized chat body", () => {
    expect(decodeTradeMessage(message("chat", {}))).toBeNull();
    expect(decodeTradeMessage(message("chat", { text: "x".repeat(10_001) }))).toBeNull();
  });

  it("rejects malformed funded and release payloads", () => {
    expect(
      decodeTradeMessage(message("funded", { txid: "tx", vout: -1, amount: 1000 })),
    ).toBeNull();
    expect(
      decodeTradeMessage(message("funded", { txid: "tx", vout: 0, amount: 0 })),
    ).toBeNull();
    expect(
      decodeTradeMessage(
        message("release_request", {
          spend: { arkTx: "psbt", checkpoints: [] },
          to: "ark1q...",
          sats: 1000,
        }),
      ),
    ).toBeNull();
  });

  it("rejects an escrow agreement with an empty solver set", () => {
    const agreement = {
      orderId: "order-1",
      fiat: "USD",
      fiatAmount: 25,
      tradeSats: 10000,
      buyerPubKey: HEX(2),
      sellerPubKey: HEX(3),
      arbiterPubKeys: [],
      serverPubKey: HEX(4),
    };
    expect(
      decodeTradeMessage(
        message("escrow", { agreement, address: "ark1q...", refundAddress: "ark1r..." }),
      ),
    ).toBeNull();
  });
});
