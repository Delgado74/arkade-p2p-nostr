import { isFinished, statusLabel, type OperationRecord } from "../lib/operations";
import type { PeerLabel } from "../lib/useNyms";

interface Props {
  operations: OperationRecord[];
  onOpen?: (orderId: string) => void;
  label?: PeerLabel;
}

function fallbackLabel(pubkey: string): string {
  return pubkey ? `${pubkey.slice(0, 12)}…` : "—";
}

function timestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

/** Active and finished trades of the local identity. */
export function OperationsPanel({ operations, onOpen, label }: Props) {
  const peer = (pubkey: string) => label?.(pubkey, fallbackLabel(pubkey)) ?? fallbackLabel(pubkey);
  const active = operations.filter((op) => !isFinished(op.status));
  const closed = operations.filter((op) => isFinished(op.status));

  function card(op: OperationRecord) {
    const finished = isFinished(op.status);
    return (
      <li className="op-card" key={op.orderId} data-finished={finished}>
        <div className="op-card-top">
          <span className="op-status" data-status={op.status}>
            {statusLabel(op.status)}
          </span>
          <span className="op-date">{timestamp(op.updatedAt)}</span>
        </div>
        <div className="op-main">
          <span className="op-role">{op.role === "buyer" ? "Compra de BTC" : "Venta de BTC"}</span>
          <span className="op-amount">
            {op.tradeSats !== undefined ? `${op.tradeSats.toLocaleString()} sats` : "—"}
            {op.fiatAmount !== undefined && op.fiat && (
              <span className="op-fiat">
                {op.fiatAmount} {op.fiat}
              </span>
            )}
          </span>
        </div>
        <div className="op-meta">
          contraparte {peer(op.counterparty)} · orden {op.orderId.slice(0, 8)}…
        </div>
        {!finished && onOpen && (
          <div className="op-actions">
            <button type="button" className="btn btn-primary" onClick={() => onOpen(op.orderId)}>
              Abrir operación
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="ops">
      {operations.length === 0 && (
        <p className="empty">Sin operaciones todavía. Toma una orden del libro para empezar.</p>
      )}

      {active.length > 0 && (
        <div>
          <div className="group-header">
            <span>En curso</span>
            <span>{active.length}</span>
          </div>
          <ul className="op-list">{active.map(card)}</ul>
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <div className="group-header">
            <span>Terminadas</span>
            <span>{closed.length}</span>
          </div>
          <ul className="op-list">{closed.map(card)}</ul>
        </div>
      )}
    </section>
  );
}
