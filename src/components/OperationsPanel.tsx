import { useEffect, useState } from "react";
import { isFinished, statusLabel, type OperationRecord } from "../lib/operations";
import type { PeerLabel } from "../lib/useNyms";
import type { NostrClient } from "../lib/nostr";
import type { Identity } from "../lib/identity";
import { RateCounterparty } from "./RateCounterparty";
import { ReputationBadge } from "./ReputationBadge";
import { EMPTY_REPUTATION, loadReputation, type Reputation } from "../lib/reputation";
import { StarRating } from "./StarRating";

interface Props {
  operations: OperationRecord[];
  onOpen?: (orderId: string) => void;
  label?: PeerLabel;
  client: NostrClient;
  identity: Identity;
  onRate: (orderId: string, value: number) => void;
}

function fallbackLabel(pubkey: string): string {
  return pubkey ? `${pubkey.slice(0, 12)}…` : "—";
}

function timestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

/** Active and finished trades of the local identity. */
export function OperationsPanel({ operations, onOpen, label, client, identity, onRate }: Props) {
  const [selfRep, setSelfRep] = useState<Reputation>(EMPTY_REPUTATION);
  const peer = (pubkey: string, orderId?: string) =>
    label?.(pubkey, fallbackLabel(pubkey), orderId) ?? fallbackLabel(pubkey);
  const active = operations.filter((op) => !isFinished(op.status));
  const closed = operations.filter((op) => isFinished(op.status));
  const finishedCount = operations.filter((op) => isFinished(op.status)).length;
  const ratedByMe = operations.filter((op) => isFinished(op.status) && op.myRating).length;

  useEffect(() => {
    let cancelled = false;
    if (!identity?.pubkeyHex) return;
    loadReputation(client, identity.pubkeyHex)
      .then((rep) => {
        if (!cancelled) setSelfRep(rep);
      })
      .catch(() => {
        if (!cancelled) setSelfRep(EMPTY_REPUTATION);
      });
    return () => {
      cancelled = true;
    };
  }, [client, identity?.pubkeyHex]);

  function card(op: OperationRecord) {
    const finished = isFinished(op.status);
    // Rating makes sense only for trades that actually completed with a
    // counterparty. The public order event is resolved on demand when missing.
    const canRate =
      op.status === "completed" &&
      Boolean(op.counterparty);
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
          contraparte {peer(op.counterparty, op.orderId)}{" "}
          <ReputationBadge client={client} pubkey={op.counterparty} hideWhenEmpty /> · orden{" "}
          {op.orderId.slice(0, 8)}…
        </div>
        {finished && canRate && (
          <RateCounterparty
            client={client}
            identity={identity}
            op={op}
            onRated={(value) => onRate(op.orderId, value)}
          />
        )}
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
      <div
        className="rep-summary"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          alignItems: "center",
          marginBottom: 14,
          padding: "10px 14px",
          background: "var(--panel-2, #1f1f1f)",
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div>
          <strong>Operaciones finalizadas:</strong> {finishedCount}
        </div>
        <div>
          <strong>Calificaciones recibidas:</strong> {selfRep.count}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <strong>Promedio:</strong>
          {selfRep.count > 0 ? (
            <>
              <StarRating value={Math.round(selfRep.average)} size="sm" />
              <span>
                {selfRep.average.toFixed(1)} ({selfRep.count})
              </span>
            </>
          ) : (
            <span>Sin calificaciones</span>
          )}
        </div>
        {finishedCount > 0 && (
          <div>
            <strong>Has calificado:</strong> {ratedByMe}/{finishedCount}
          </div>
        )}
      </div>

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
