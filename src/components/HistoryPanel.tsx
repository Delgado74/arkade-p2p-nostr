import type { OperationRecord } from "../lib/operations";
import { isFinished, statusLabel } from "../lib/operations";

interface Props {
  operations: OperationRecord[];
}

function shortPubkey(pubkey: string): string {
  return pubkey ? `${pubkey.slice(0, 12)}…` : "—";
}

/** Read-only list of the operations that are no longer in progress. */
export function HistoryPanel({ operations }: Props) {
  const finished = operations.filter((op) => isFinished(op.status));

  return (
    <section>
      <h2>Historial</h2>
      <p style={{ fontSize: "0.85em", opacity: 0.8 }}>
        Operaciones terminadas: completadas, canceladas o resueltas por disputa.
      </p>

      {finished.length === 0 && <p>Todavía no hay operaciones terminadas.</p>}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {finished.map((op) => (
          <li
            key={op.orderId}
            style={{ border: "1px solid #8884", borderRadius: 8, padding: 12, marginBottom: 8 }}
          >
            <strong>{statusLabel(op.status)}</strong>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              {op.role === "buyer" ? "comprador" : "vendedor"} · contraparte{" "}
              {shortPubkey(op.counterparty)}
            </div>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              {op.tradeSats !== undefined ? `${op.tradeSats.toLocaleString()} sats` : "—"}
              {op.fiatAmount !== undefined && op.fiat ? ` · ${op.fiatAmount} ${op.fiat}` : ""}
            </div>
            <div style={{ fontSize: "0.85em", opacity: 0.6 }}>
              orden {op.orderId.slice(0, 8)}… ·{" "}
              {new Date(op.updatedAt * 1000).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
