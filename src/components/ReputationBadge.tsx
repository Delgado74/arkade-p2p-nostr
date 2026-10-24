import { useEffect, useState } from "react";
import type { NostrClient } from "../lib/nostr";
import { EMPTY_REPUTATION, loadReputation, type Reputation } from "../lib/reputation";
import { StarRating } from "./StarRating";

interface Props {
  client: NostrClient;
  pubkey: string;
  /** Hide the value entirely when the pubkey has no reviews yet. */
  hideWhenEmpty?: boolean;
}

/**
 * Compact reputation chip: `★ 4.5 (12)`. Loads the verified reputation of a
 * pubkey from relays once and caches it for the component's lifetime. Renders
 * nothing (or "sin reseñas") until the first result arrives.
 */
export function ReputationBadge({ client, pubkey, hideWhenEmpty }: Props) {
  const [state, setState] = useState<{ key: string; rep: Reputation } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!pubkey) return;
    loadReputation(client, pubkey)
      .then((r) => {
        if (!cancelled) setState({ key: pubkey, rep: r });
      })
      .catch(() => {
        if (!cancelled) setState({ key: pubkey, rep: EMPTY_REPUTATION });
      });
    return () => {
      cancelled = true;
    };
  }, [client, pubkey]);

  if (!pubkey) return null;
  // Ignore a result that belongs to a previously requested pubkey.
  const rep = state && state.key === pubkey ? state.rep : null;
  if (rep === null) {
    return (
      <span className="rep-badge" title="Cargando reputación…">
        <span className="rep-loading">…</span>
      </span>
    );
  }
  if (rep.count === 0) {
    if (hideWhenEmpty) return null;
    return (
      <span className="rep-badge rep-empty" title="Sin calificaciones todavía">
        sin reseñas
      </span>
    );
  }
  return (
    <span
      className="rep-badge"
      title={`${rep.count} calificación(es) · mín ${rep.min} · máx ${rep.max}`}
    >
      <StarRating value={Math.round(rep.average)} size="sm" />
      <span className="rep-average">{rep.average.toFixed(1)}</span>
      <span className="rep-count">({rep.count})</span>
    </span>
  );
}
