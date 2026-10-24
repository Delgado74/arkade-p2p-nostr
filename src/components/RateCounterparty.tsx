import { useState } from "react";
import type { NostrClient } from "../lib/nostr";
import type { Identity } from "../lib/identity";
import type { OperationRecord } from "../lib/operations";
import { StarRating } from "./StarRating";

interface Props {
  client: NostrClient;
  identity: Identity;
  op: OperationRecord;
  /** Called with the chosen value after a successful publish. */
  onRated: (value: number) => void;
}

/**
 * Prompt shown on a finished operation, letting the local identity leave a
 * 1-5 star rating for the counterparty, once. The order's public event id is
 * required to bind the rating to a real, verifiable trade; it comes from the
 * operation the notice was recorded for (see `App.rateCounterparty`).
 */
export function RateCounterparty({ client, identity, op, onRated }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [value, setValue] = useState(0);

  if (op.myRating) {
    return (
      <div className="rate-done" style={{ fontSize: "0.85em", opacity: 0.75 }}>
        Tu calificación: <StarRating value={op.myRating} size="sm" />
      </div>
    );
  }

  async function submit(stars: number) {
    setBusy(true);
    setError("");
    try {
      // Records created before the reputation feature (or whose order fetch
      // failed at take time) lack the public event id. Resolve it now so the
      // rating can still be bound to a verifiable order.
      let orderEventId = op.orderEventId ?? "";
      if (!orderEventId) {
        const order = await client.fetchOrder(op.orderId);
        orderEventId = order?.event.id ?? "";
      }
      if (!orderEventId) {
        throw new Error("no se encontró la orden pública para vincular la calificación");
      }
      await client.publishRating(identity, {
        orderId: op.orderId,
        orderEventId,
        ratee: op.counterparty,
        value: stars,
        role: op.role,
      });
      setValue(stars);
      onRated(stars);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rate-prompt">
      <span className="rate-label">Califica a tu contraparte:</span>
      <StarRating value={value} onChange={busy ? undefined : submit} disabled={busy} />
      {busy && <span className="rate-busy">publicando…</span>}
      {error && <span className="rate-error" style={{ color: "crimson" }}> {error}</span>}
    </div>
  );
}
