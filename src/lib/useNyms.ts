import { useEffect, useMemo, useState } from "react";
import { cachedNym, resolveNym } from "./nym";

/** Alias lookup: the pseudonym of a pubkey, or the given fallback. */
export type PeerLabel = (pubkeyHex: string, fallback?: string) => string;

const HEX64 = /^[0-9a-f]{64}$/;

function normalizeAll(pubkeys: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const key of pubkeys) {
    const hex = key.trim().toLowerCase();
    if (HEX64.test(hex)) seen.add(hex);
  }
  return [...seen].sort();
}

/**
 * Resolve the deterministic pseudonyms of every known pubkey and return a
 * stable `label(hex, fallback)` reader.
 *
 * Aliases are derived locally from the key (SHA-256), never published, so the
 * map starts empty and fills in as digests resolve; the hook re-renders once
 * per wave. `pubkeys` should be the union of every identity the UI may show.
 */
export function usePeerLabels(pubkeys: Iterable<string>): PeerLabel {
  const joined = [...new Set(pubkeys)].join(",");
  const keys = useMemo(() => normalizeAll(joined ? joined.split(",") : []), [joined]);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const missing = keys.filter((k) => cachedNym(k) === null);
    if (missing.length === 0) return;
    Promise.all(missing.map((k) => resolveNym(k)))
      .then(() => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const k of keys) {
          const nym = cachedNym(k);
          if (nym) next[k] = nym;
        }
        setLabels(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [keys]);

  return useMemo(
    () =>
      (pubkeyHex: string, fallback = "Anónimo"): string => {
        const hex = pubkeyHex.trim().toLowerCase();
        return labels[hex] ?? fallback;
      },
    [labels],
  );
}
