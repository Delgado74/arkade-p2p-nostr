import { SingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

export interface Identity {
  /** Raw 32-byte secp256k1 secret key. */
  secretKey: Uint8Array;
  /** Secret key as lowercase hex. */
  secretHex: string;
  /** Secret key encoded as a NIP-19 `nsec`. */
  nsec: string;
  /** x-only public key as lowercase hex (Nostr pubkey). */
  pubkeyHex: string;
  /** Public key encoded as a NIP-19 `npub`. */
  npub: string;
  /** Arkade signing identity backed by the same secp256k1 key. */
  ark: SingleKey;
}

function includeIdentity(secretKey: Uint8Array): Identity {
  if (secretKey.length !== 32) {
    throw new Error(`secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const pubkeyHex = getPublicKey(secretKey);
  return {
    secretKey,
    secretHex: hex.encode(secretKey),
    nsec: nip19.nsecEncode(secretKey),
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    ark: SingleKey.fromPrivateKey(secretKey),
  };
}

/** Generate a brand new identity (same key for Nostr and Arkade). */
export function generateIdentity(): Identity {
  return includeIdentity(generateSecretKey());
}

/** Build an identity from a raw 32-byte secret key. */
export function identityFromSecretKey(secretKey: Uint8Array): Identity {
  return includeIdentity(secretKey);
}

/** Build an identity from a hex-encoded secret key or an `nsec1...` string. */
export function identityFromInput(input: string): Identity {
  const value = input.trim();
  if (value.length === 0) throw new Error("empty key");

  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec") {
      throw new Error(`expected nsec, got ${decoded.type}`);
    }
    return includeIdentity(decoded.data);
  }

  return includeIdentity(hex.decode(value));
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
