import { generateIdentity, identityFromInput, type Identity } from "./identity";

/**
 * `sessionStorage` key holding the `nsec` of the local identity.
 *
 * Deliberately per-tab (not `localStorage`): opening the app in a second tab or
 * window yields an independent identity, so the same browser can play several
 * peers (buyer/seller/arbiter). It still survives reloads within a tab. The same
 * secp256k1 key backs both Nostr and Arkade.
 */
const IDENTITY_KEY = "arkade-p2p-nostr:nsec";

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredNsec(): string | null {
  try {
    return storage()?.getItem(IDENTITY_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredNsec(nsec: string): void {
  try {
    storage()?.setItem(IDENTITY_KEY, nsec);
  } catch {
    // Storage unavailable (private mode, quota). The identity stays in memory.
  }
}

/** Persist an identity's secret so it survives reloads within this tab. */
export function saveIdentity(identity: Identity): void {
  writeStoredNsec(identity.nsec);
}

/**
 * Load this tab's identity, or generate and persist a new one.
 *
 * Called once as the `useState` initializer for the app identity, so a usable
 * key exists from the first render without any manual step.
 */
export function loadOrCreateIdentity(): Identity {
  const stored = readStoredNsec();
  if (stored) {
    try {
      return identityFromInput(stored);
    } catch {
      // Malformed stored key: fall through and mint a fresh one.
    }
  }
  const fresh = generateIdentity();
  writeStoredNsec(fresh.nsec);
  return fresh;
}
