import type { SolverDispute, SolverDisputeStatus } from "../lib/solver";

interface Props {
  disputes: SolverDispute[];
  onOpen: (orderId: string) => void;
}

const STATUS_LABEL: Record<SolverDisputeStatus, string> = {
  pending: "Pendiente",
  mine: "La resuelves tú",
  taken: "Tomada",
  resolved: "Resuelta",
};

function shortPubkey(pubkey: string): string {
  return pubkey ? `${pubkey.slice(0, 12)}…` : "—";
}

function timestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function resolutionLabel(status: string | undefined): string {
  if (status === "settled") return "pagada al comprador";
  if (status === "refunded") return "reembolsada al vendedor";
  return status ?? "";
}

/** Solver inbox: disputes whose escrow commits our key to the solver set. */
export function SolverInbox({ disputes, onOpen }: Props) {
  const open = disputes.filter((d) => d.status !== "resolved");
  const closed = disputes.filter((d) => d.status === "resolved");

  function card(item: SolverDispute) {
    return (
      <li className="op-card" key={item.orderId} data-finished={item.status === "resolved"}>
        <div className="op-card-top">
          <span className="op-status" data-status={item.status}>
            {STATUS_LABEL[item.status]}
          </span>
          <span className="op-date">{timestamp(item.createdAt)}</span>
        </div>
        <div className="op-main">
          <span className="op-role">
            Disputa · {item.tradeSats.toLocaleString()} sats
          </span>
          <span className="op-amount">
            {item.fiatAmount.toLocaleString()} {item.fiat}
          </span>
        </div>
        <div className="op-meta">
          abierta por {shortPubkey(item.initiator)} · orden {item.orderId.slice(0, 8)}…
        </div>
        <p className="op-reason">{item.reason || "Sin motivo especificado."}</p>
        {item.status === "taken" && item.winner && (
          <div className="op-meta">la tomó {shortPubkey(item.winner)}</div>
        )}
        {item.status === "resolved" && item.resolution && (
          <div className="op-meta">resolución: {resolutionLabel(item.resolution)}</div>
        )}
        <div className="op-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(item.orderId)}>
            {item.status === "resolved" ? "Ver detalle" : "Abrir disputa"}
          </button>
        </div>
      </li>
    );
  }

  return (
    <section className="ops">
      <p className="panel-note">
        Solo aparecen disputas cuyo acuerdo incluye tu clave en el solver set. La primera en
        publicar el take gana; las demás observan.
      </p>

      {disputes.length === 0 && (
        <p className="empty">
          Sin disputas entrantes. Cuando una parte abra una disputa recibirás aquí su solicitud
          por DM cifrado.
        </p>
      )}

      {open.length > 0 && (
        <div>
          <div className="group-header">
            <span>Abiertas</span>
            <span>{open.length}</span>
          </div>
          <ul className="op-list">{open.map(card)}</ul>
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <div className="group-header">
            <span>Resueltas</span>
            <span>{closed.length}</span>
          </div>
          <ul className="op-list">{closed.map(card)}</ul>
        </div>
      )}
    </section>
  );
}
