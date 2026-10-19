import type { TradeMessage } from "./trade";

/** One-line human summary of a trade message, used in chat previews. */
export function summarize(msg: TradeMessage): string {
  switch (msg.type) {
    case "take":
      return `toma la orden → paga a ${msg.payload.buyerArkAddress.slice(0, 16)}…`;
    case "payment_details":
      return `datos de pago (${msg.payload.methods.join(", ") || "métodos"}): ${msg.payload.details}`;
    case "escrow":
      return `acuerdo ${msg.payload.agreement.tradeSats} sats / ${msg.payload.agreement.fiatAmount} ${msg.payload.agreement.fiat}`;
    case "funded":
      return `fondeado ${msg.payload.amount} sats (${msg.payload.txid.slice(0, 12)}…:${msg.payload.vout})`;
    case "fiat_sent":
      return "fiat enviado";
    case "release_request":
      return `pide firmar liberación de ${msg.payload.sats} sats`;
    case "release_signed":
      return "liberación co-firmada";
    case "release_done":
      return `operación completada (ark tx ${msg.payload.arkTxid.slice(0, 16)}…)`;
    case "cancel_request":
      return `propone cancelar${msg.payload.reason ? `: ${msg.payload.reason}` : ""}`;
    case "cancel_agree":
      return `acepta la cancelación${msg.payload.reason ? `: ${msg.payload.reason}` : ""}`;
    case "ark_address":
      return `dirección Ark: ${msg.payload.arkAddress.slice(0, 16)}…`;
    case "dispute":
      return `disputa al árbitro: ${msg.payload.reason}`;
    case "dispute_taken":
      return `disputa tomada por el solver ${msg.payload.solverPubKey.slice(0, 12)}…`;
    case "arbiter_decision":
      return `decisión del árbitro: ${
        msg.payload.outcome === "release_to_buyer" ? "paga al comprador" : "reembolsa al vendedor"
      } (${msg.payload.arkTxid.slice(0, 16)}…)`;
    case "chat":
      return msg.payload.text;
    default:
      return "mensaje";
  }
}
