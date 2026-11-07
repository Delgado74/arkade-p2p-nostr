import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./daemon/client", () => ({ daemonClient: { call } }));

import { identityFromPubkey } from "./identity";

const PUBKEY = "a".repeat(64);
const COMPRESSED = "02" + "b".repeat(64);

describe("rpc Ark signer", () => {
  beforeEach(() => call.mockReset());

  it("exposes the x-only and compressed public keys", async () => {
    const identity = identityFromPubkey(PUBKEY, COMPRESSED);
    expect(hex.encode(await identity.ark.xOnlyPublicKey())).toBe(PUBKEY);
    expect(hex.encode(await identity.ark.compressedPublicKey())).toBe(COMPRESSED);
  });

  it("fails closed when the daemon did not send a compressed key", async () => {
    const identity = identityFromPubkey(PUBKEY);
    await expect(identity.ark.compressedPublicKey()).rejects.toThrow(/compressed Ark pubkey/);
  });

  it("routes PSBT signing through the daemon", async () => {
    const tx = new Transaction();
    const psbt = base64.encode(tx.toPSBT());
    call.mockResolvedValueOnce(psbt);

    const identity = identityFromPubkey(PUBKEY, COMPRESSED);
    const signed = await identity.ark.sign(tx, [0]);

    expect(call).toHaveBeenCalledWith("ark.signPsbt", { psbt, inputIndexes: [0] });
    expect(base64.encode(signed.toPSBT())).toBe(psbt);
  });

  it("routes message signing through the daemon", async () => {
    const message = new Uint8Array(32).fill(7);
    const signature = base64.encode(new Uint8Array(64).fill(9));
    call.mockResolvedValueOnce(signature);

    const identity = identityFromPubkey(PUBKEY, COMPRESSED);
    const result = await identity.ark.signMessage(message, "ecdsa");

    expect(call).toHaveBeenCalledWith("ark.signMessage", {
      message: base64.encode(message),
      signatureType: "ecdsa",
    });
    expect(result).toEqual(new Uint8Array(64).fill(9));
  });

  it("routes deterministic Schnorr signing through the daemon", async () => {
    const hash = new Uint8Array(32).fill(3);
    const signature = base64.encode(new Uint8Array(64).fill(4));
    call.mockResolvedValueOnce(signature);

    const identity = identityFromPubkey(PUBKEY, COMPRESSED);
    const result = await identity.ark.signSchnorrDeterministic(hash);

    expect(call).toHaveBeenCalledWith("ark.signSchnorrDeterministic", {
      messageHash: base64.encode(hash),
    });
    expect(result).toEqual(new Uint8Array(64).fill(4));
  });
});
