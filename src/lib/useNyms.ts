import { useEffect, useMemo, useState } from "react";
import { cachedNym, resolveNym } from "./nym";

/**
 * Alias lookup: the pseudonym of a pubkey, or the given fallback.
 *
 * The operation id scopes the alias: the same peer reads differently in every
 * operation, but keeps one name inside the operation it is shown in. Contexts
 * with no operation (a solver registry, for instance) fall back to a single
 * global alias for that key.
 */
export type PeerLabel = (pubkeyHex: string, fallback?: string, orderId?: string) => string;

/** A key to derive an alias for, with the operation that scopes it. */
export interface NymRef {
  pubkey: string;
  orderId?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function normalizeAll(refs: Iterable<string | NymRef>): NymRef[] {
  const seen = new Set<string>();
  const out: NymRef[] = [];
  for (const ref of refs) {
    const raw = typeof ref === "string" ? ref : ref.pubkey;
    const hex = raw.trim().toLowerCase();
    if (!HEX64.test(hex)) continue;
    const orderId = typeof ref === "string" ? undefined : ref.orderId;
    const key = `${orderId ?? ""}|${hex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pubkey: hex, orderId });
  }
  return out.sort((a, b) =>
    `${a.orderId ?? ""}|${a.pubkey}`.localeCompare(`${b.orderId ?? ""}|${b.pubkey}`),
  );
}

/**
 * Resolve the deterministic pseudonyms of every known pubkey and return a
 * stable `label(hex, fallback, orderId)` reader.
 *
 * Aliases are derived locally from the key (SHA-256), never published, so the
 * map starts empty and fills in as digests resolve; the hook re-renders once
 * per wave. `refs` should be the union of every identity the UI may show; pass
 * a memoized list so the digests are not recomputed on every render.
 */
export function usePeerLabels(refs: Iterable<string | NymRef>): PeerLabel {
  const normalized = useMemo(() => normalizeAll(refs), [refs]);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const missing = normalized.filter((k) => cachedNym(k.pubkey, k.orderId) === null);
    if (missing.length === 0) return;
    Promise.all(missing.map((k) => resolveNym(k.pubkey, k.orderId)))
      .then(() => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const k of normalized) {
          const nym = cachedNym(k.pubkey, k.orderId);
          if (nym) next[`${k.orderId ?? ""}|${k.pubkey}`] = nym;
        }
        setLabels(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [normalized]);

  return useMemo(
    () =>
      (pubkeyHex: string, fallback = "Anónimo", orderId?: string): string => {
        const hex = pubkeyHex.trim().toLowerCase();
        return labels[`${orderId ?? ""}|${hex}`] ?? fallback;
      },
    [labels],
  );
}
