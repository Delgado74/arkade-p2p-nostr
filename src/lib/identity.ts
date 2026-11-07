import type { SingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { nip19 } from "nostr-tools";

export interface Identity {
  /** x-only public key as lowercase hex (Nostr pubkey). */
  pubkeyHex: string;
  /** Public key encoded as a NIP-19 `npub`. */
  npub: string;
  /**
   * Arkade signer placeholder owned by the daemon.
   *
   * Fase 1b replaces this with an RPC-backed signer. Until then it can derive
   * the public key but signing fails closed instead of using a browser key.
   */
  ark: SingleKey;
}

function pendingArkSigner(pubkeyHex: string): SingleKey {
  return {
    xOnlyPublicKey: async () => hex.decode(pubkeyHex),
    sign: async () => {
      throw new Error("Ark signing is not available until the daemon wallet integration (Fase 1b)");
    },
  } as unknown as SingleKey;
}

/** Build the client identity from the public key returned by the daemon. */
export function identityFromPubkey(pubkeyHex: string): Identity {
  const pk = pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pk)) {
    throw new Error("expected a 64-character hex pubkey");
  }
  return {
    pubkeyHex: pk,
    npub: nip19.npubEncode(pk),
    ark: pendingArkSigner(pk),
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
