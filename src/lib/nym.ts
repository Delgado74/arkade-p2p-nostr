/**
 * Deterministic pseudonym derived from a Nostr public key.
 *
 * Ported from Mostro v2 (`rust/src/crypto/nym.rs`) so the same key always
 * yields the same `adjective-noun` alias, on any device or session, without
 * the key ever leaving it. Derivation hashes the 32-byte x-only pubkey:
 *
 *   hash          = SHA-256(pubkey_bytes)
 *   adjective_idx = hash[0] % 64
 *   noun_idx      = hash[1] % 64
 */

/** Adjective pool (64 entries, index 0–63). Must match `nym.rs`. */
export const ADJECTIVES: readonly string[] = [
  "amber", "bold", "calm", "dark", "eager", "fast", "gold", "high",
  "icy", "just", "keen", "lazy", "mild", "neat", "old", "pale",
  "quick", "red", "safe", "tall", "urban", "vast", "warm", "young",
  "azure", "brave", "cool", "deep", "empty", "free", "gray", "hard",
  "iron", "jade", "kind", "lost", "moon", "new", "open", "pink",
  "quiet", "rare", "soft", "tiny", "used", "vivid", "wide", "exact",
  "yellow", "zero", "alien", "black", "crisp", "dusty", "early", "fresh",
  "grave", "heavy", "ideal", "jolly", "knit", "lean", "magic", "noble",
];

/** Noun pool (64 entries, index 0–63): the animal drawn on the avatar. */
export const NOUNS: readonly string[] = [
  "ant", "bird", "cat", "deer", "elk", "fox", "goat", "parrot",
  "flamingo", "peacock", "dove", "leopard", "butterfly", "turtle", "owl", "shark",
  "chicken", "bat", "seal", "tiger", "ram", "mouse", "wolf", "ox",
  "bear", "crab", "duck", "eagle", "frog", "zebra", "swan", "giraffe",
  "dog", "koala", "lion", "otter", "whale", "horse", "kangaroo", "penguin",
  "sloth", "pig", "viper", "octopus", "chipmunk", "skunk", "bison", "goose",
  "camel", "turkey", "hedgehog", "gecko", "hippo", "crocodile", "elephant", "fish",
  "monkey", "beaver", "dolphin", "llama", "panda", "rabbit", "badger", "cow",
];

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The pseudonym for a SHA-256 digest of an x-only pubkey. */
export function nymFromHash(hash: Uint8Array): string {
  const adjective = ADJECTIVES[hash[0] % ADJECTIVES.length];
  const noun = NOUNS[hash[1] % NOUNS.length];
  return `${adjective}-${noun}`;
}

/** Normalize any pubkey form to a lowercase 32-byte hex, or `null`. */
function normalize(pubkeyHex: string): string | null {
  const hex = pubkeyHex.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

const resolved = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

async function digest(pubkeyHex: string): Promise<string> {
  const bytes = hexToBytes(pubkeyHex);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return nymFromHash(new Uint8Array(hash));
}

/** Compute and cache a pubkey's pseudonym. Resolves to the alias. */
export async function resolveNym(pubkeyHex: string): Promise<string> {
  const hex = normalize(pubkeyHex);
  if (!hex) return "";
  const done = resolved.get(hex);
  if (done) return done;
  let inFlight = pending.get(hex);
  if (!inFlight) {
    inFlight = digest(hex).then((nym) => {
      resolved.set(hex, nym);
      pending.delete(hex);
      return nym;
    });
    pending.set(hex, inFlight);
  }
  return inFlight;
}

/** Precompute aliases for many keys so they read synchronously afterwards. */
export async function primeNyms(pubkeys: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(pubkeys)].map((p) => resolveNym(p)));
}

/**
 * Synchronous alias lookup: the pseudonym when already resolved, otherwise
 * `null`. Render code pairs this with a generic label until the value lands.
 */
export function cachedNym(pubkeyHex: string): string | null {
  const hex = normalize(pubkeyHex);
  return hex ? resolved.get(hex) ?? null : null;
}

/**
 * Display label for a peer. Once primed this is the deterministic pseudonym;
 * until then it falls back to `fallback` (a generic label by default) so the
 * raw key is never shown.
 */
export function peerLabel(pubkeyHex: string, fallback = "Anónimo"): string {
  return cachedNym(pubkeyHex) ?? fallback;
}
