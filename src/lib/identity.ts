import { SingleKey, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { nip19 } from "nostr-tools";
import { daemonClient } from "./daemon/client";

export interface Identity {
  /** x-only public key as lowercase hex (Nostr pubkey). */
  pubkeyHex: string;
  /** Public key encoded as a NIP-19 `npub`. */
  npub: string;
  /** Arkade signer backed by the daemon RPC. */
  ark: SingleKey;
}

function rpcArkSigner(pubkeyHex: string, compressedPk?: string): SingleKey {
  const session = SingleKey.fromRandomBytes().signerSession();
  return {
    xOnlyPublicKey: async () => hex.decode(pubkeyHex),
    compressedPublicKey: async () => {
      if (!compressedPk || !/^[0-9a-f]{66}$/.test(compressedPk)) {
        throw new Error("daemon did not return a valid compressed Ark pubkey");
      }
      return hex.decode(compressedPk);
    },
    sign: async (tx: Transaction, inputIndexes?: number[]) => {
      const psbt = base64.encode(tx.toPSBT());
      const signed = await daemonClient.call<string>("ark.signPsbt", { psbt, inputIndexes });
      return Transaction.fromPSBT(base64.decode(signed));
    },
    signMessage: async (message: Uint8Array, signatureType: "schnorr" | "ecdsa" = "schnorr") => {
      const signature = await daemonClient.call<string>("ark.signMessage", {
        message: base64.encode(message),
        signatureType,
      });
      return base64.decode(signature);
    },
    signSchnorrDeterministic: async (messageHash: Uint8Array) => {
      const signature = await daemonClient.call<string>("ark.signSchnorrDeterministic", {
        messageHash: base64.encode(messageHash),
      });
      return base64.decode(signature);
    },
    signerSession: () => session,
  } as unknown as SingleKey;
}

/** Build the client identity from the public keys returned by the daemon. */
export function identityFromPubkey(pubkeyHex: string, compressedPk?: string): Identity {
  const pk = pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pk)) {
    throw new Error("expected a 64-character hex pubkey");
  }
  return {
    pubkeyHex: pk,
    npub: nip19.npubEncode(pk),
    ark: rpcArkSigner(pk, compressedPk?.trim().toLowerCase()),
  };
}

/** x-only public key (32 bytes) for a given identity, as used by tapscripts. */
export async function xOnlyPubKey(identity: Identity): Promise<Uint8Array> {
  return identity.ark.xOnlyPublicKey();
}

/** Parse an `npub1...` or 64-char hex string into a lowercase hex pubkey. */
export function pubkeyFromInput(input: string): string {
  const value = input.trim();
  if (value.startsWith("npub1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") {
      throw new Error(`expected npub, got ${decoded.type}`);
    }
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("expected an npub or a 64-character hex pubkey");
  }
  return value.toLowerCase();
}
