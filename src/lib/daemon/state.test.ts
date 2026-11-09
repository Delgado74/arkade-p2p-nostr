import { describe, expect, it } from "vitest";
import type { EscrowAgreement } from "../trade";
import { syncDispute, syncEscrow, syncRating, type StateRpc } from "./state";

class FakeRpc implements StateRpc {
  calls: { method: string; params: any }[] = [];
  fail = false;

  async call<T = any>(method: string, params?: any): Promise<T> {
    if (this.fail) throw new Error("daemon down");
    this.calls.push({ method, params });
    return undefined as T;
  }
}

const agreement: EscrowAgreement = {
  escrowVersion: 1,
  orderId: "o1",
  fiat: "USD",
  fiatAmount: 10,
  tradeSats: 1000,
  buyerPubKey: "a".repeat(64),
  sellerPubKey: "b".repeat(64),
  arbiterPubKeys: ["c".repeat(64)],
  serverPubKey: "d".repeat(64),
  refundLocktime: "1000",
};

describe("syncEscrow", () => {
  it("upserts the derived escrow and its VTXO", async () => {
    const rpc = new FakeRpc();
    await syncEscrow(
      {
        orderId: "o1",
        address: "ark1escrow",
        agreement,
        state: "spendable",
        vtxoTxid: "e".repeat(64),
        vtxoVout: 1,
        fundedSats: 1000,
      },
      rpc,
    );

    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0].method).toBe("escrows.upsert");
    expect(rpc.calls[0].params.orderId).toBe("o1");
    expect(rpc.calls[0].params.patch).toMatchObject({
      address: "ark1escrow",
      state: "spendable",
      vtxoTxid: "e".repeat(64),
      vtxoVout: 1,
      fundedSats: 1000,
      buyerPubKey: agreement.buyerPubKey,
      refundLocktime: "1000",
    });
    expect(JSON.parse(rpc.calls[0].params.patch.agreementJson)).toEqual(agreement);
  });

  it("skips empty identifiers and swallows daemon failures", async () => {
    const empty = new FakeRpc();
    await syncEscrow({ orderId: "", address: "ark1", agreement, state: "created" }, empty);
    expect(empty.calls).toHaveLength(0);

    const down = new FakeRpc();
    down.fail = true;
    await expect(
      syncEscrow({ orderId: "o1", address: "ark1", agreement, state: "created" }, down),
    ).resolves.toBeUndefined();
  });
});

describe("syncDispute", () => {
  it("upserts the public lifecycle for the order", async () => {
    const rpc = new FakeRpc();
    await syncDispute(
      {
        orderId: "o1",
        status: "resolved",
        initiator: "a".repeat(64),
        winner: "b".repeat(64),
        reason: "no pagó",
        announceEventId: "1".repeat(64),
        takeEventId: "2".repeat(64),
        resolutionEventId: "3".repeat(64),
      },
      rpc,
    );

    expect(rpc.calls[0]).toMatchObject({
      method: "disputes.upsert",
      params: {
        orderId: "o1",
        patch: {
          status: "resolved",
          winner: "b".repeat(64),
          reason: "no pagó",
          resolutionEventId: "3".repeat(64),
        },
      },
    });
  });
});

describe("syncRating", () => {
  it("indexes a published rating by event id", async () => {
    const rpc = new FakeRpc();
    const rating = {
      eventId: "1".repeat(64),
      orderId: "o1",
      author: "a".repeat(64),
      subject: "b".repeat(64),
      score: 5,
      createdAt: 123,
    };
    await syncRating(rating, rpc);

    expect(rpc.calls[0]).toEqual({
      method: "ratings.upsert",
      params: { rating },
    });
  });
});
