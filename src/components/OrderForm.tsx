import { useState } from "react";
import { effectivePricePerSat, fetchRate, fiatToSats, satsToFiat } from "../lib/rates";
import { buildOrderTemplate, type OrderType } from "../lib/protocol";
import type { Identity } from "../lib/identity";
import type { NostrClient } from "../lib/nostr";

interface Props {
  client: NostrClient;
  identity: Identity | null;
  initialType?: OrderType;
  onPublished?: () => void;
  onCancel?: () => void;
}

type Mode = "fiat" | "sats";

export function OrderForm({ client, identity, initialType = "sell", onPublished, onCancel }: Props) {
  const [type, setType] = useState<OrderType>(initialType);
  const [fiat, setFiat] = useState("CUP");
  const [mode, setMode] = useState<Mode>("fiat");
  const [amount, setAmount] = useState("1000");
  const [premium, setPremium] = useState("3");
  const [methods, setMethods] = useState("Transfermóvil, Efectivo");
  const [arkRefund, setArkRefund] = useState("");
  const [arkReceive, setArkReceive] = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!identity) {
      setError("Primero genera o importa una identidad.");
      return;
    }
    if (type === "sell" && !arkRefund.trim()) {
      setError("Indica tu dirección Ark de reembolso (para devolverte los sats si algo falla).");
      return;
    }
    if (type === "buy" && !arkReceive.trim()) {
      setError("Indica tu dirección Ark donde recibirás los sats que compras.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const quote = await fetchRate(fiat);
      const pricePerSat = effectivePricePerSat(quote, Number(premium) || 0);
      const input = Number(amount) || 0;

      let amountSats: number;
      let fiatAmount: number;
      if (mode === "fiat") {
        fiatAmount = input;
        amountSats = fiatToSats(fiatAmount, pricePerSat);
      } else {
        amountSats = Math.round(input);
        fiatAmount = Math.round(satsToFiat(amountSats, pricePerSat) * 100) / 100;
      }

      const template = buildOrderTemplate({
        type,
        fiat: quote.fiat,
        fiatAmount,
        amountSats,
        premium: Number(premium) || 0,
        paymentMethods: methods.split(",").map((m) => m.trim()).filter(Boolean),
        expiresAt: Math.floor(Date.now() / 1000) + (Number(expiryHours) || 24) * 3600,
        name: identity.npub,
        arkRefundAddress: arkRefund.trim() || undefined,
        arkReceiveAddress: arkReceive.trim() || undefined,
      });

      const event = await client.publish(template, identity);
      const id = event.tags.find((t) => t[0] === "d")?.[1] ?? event.id;
      setStatus(
        `Orden publicada (${id.slice(0, 8)}…): ${type} ${amountSats.toLocaleString()} sats ` +
          `por ${fiatAmount} ${quote.fiat} (fuente ${quote.source}, prima ${premium}%).`,
      );
      onPublished?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="segmented" role="tablist" aria-label="Lado de la oferta">
        <button
          type="button"
          role="tab"
          data-side="buy"
          data-active={type === "buy"}
          aria-selected={type === "buy"}
          onClick={() => setType("buy")}
        >
          Comprar BTC
        </button>
        <button
          type="button"
          role="tab"
          data-side="sell"
          data-active={type === "sell"}
          aria-selected={type === "sell"}
          onClick={() => setType("sell")}
        >
          Vender BTC
        </button>
      </div>

      <p className="panel-note">
        {type === "buy"
          ? "Publicas una oferta de compra: la contraparte te venderá BTC y tú pagas en fiat."
          : "Publicas una oferta de venta: la contraparte te comprará BTC y tú recibes fiat."}
      </p>

      <div className="form-grid">
        <label className="field">
          <span>Fiat</span>
          <input className="input" value={fiat} onChange={(e) => setFiat(e.target.value)} />
        </label>
        <label className="field">
          <span>Prima %</span>
          <input
            className="input"
            inputMode="decimal"
            value={premium}
            onChange={(e) => setPremium(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Medir por</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="fiat">monto fiat</option>
            <option value="sats">monto en sats</option>
          </select>
        </label>
        <label className="field">
          <span>Monto</span>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Expira en horas</span>
          <input
            className="input"
            inputMode="numeric"
            value={expiryHours}
            onChange={(e) => setExpiryHours(e.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>Métodos de pago (separados por coma)</span>
        <input className="input" value={methods} onChange={(e) => setMethods(e.target.value)} />
      </label>

      {type === "sell" && (
        <label className="field">
          <span>Tu dirección Ark de reembolso (recibe los sats si se cancela o disputa)</span>
          <input
            className="input"
            value={arkRefund}
            onChange={(e) => setArkRefund(e.target.value)}
            placeholder="ark1..."
          />
        </label>
      )}

      {type === "buy" && (
        <label className="field">
          <span>Tu dirección Ark donde recibirás los sats que compras</span>
          <input
            className="input"
            value={arkReceive}
            onChange={(e) => setArkReceive(e.target.value)}
            placeholder="ark1..."
          />
        </label>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Publicando…" : "Publicar oferta"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>

      {status && <p className="notice">{status}</p>}
      {error && <p className="alert">Error: {error}</p>}
    </section>
  );
}
