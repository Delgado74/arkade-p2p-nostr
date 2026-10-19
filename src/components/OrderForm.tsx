import { useState } from "react";
import { effectivePricePerSat, fetchRate, fiatToSats, satsToFiat } from "../lib/rates";
import { buildOrderTemplate, type OrderType } from "../lib/protocol";
import type { Identity } from "../lib/identity";
import type { NostrClient } from "../lib/nostr";

interface Props {
  client: NostrClient;
  identity: Identity | null;
  onPublished?: () => void;
}

type Mode = "fiat" | "sats";

export function OrderForm({ client, identity, onPublished }: Props) {
  const [type, setType] = useState<OrderType>("sell");
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
    <section>
      <h2>Nueva orden</h2>
      <div>
        <label>
          Tipo{" "}
          <select value={type} onChange={(e) => setType(e.target.value as OrderType)}>
            <option value="sell">vender BTC</option>
            <option value="buy">comprar BTC</option>
          </select>
        </label>{" "}
        <label>
          Fiat{" "}
          <input value={fiat} onChange={(e) => setFiat(e.target.value)} style={{ width: 80 }} />
        </label>{" "}
        <label>
          Prima %{" "}
          <input
            value={premium}
            onChange={(e) => setPremium(e.target.value)}
            style={{ width: 60 }}
          />
        </label>
      </div>

      <div>
        <label>
          Medir por{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="fiat">monto fiat</option>
            <option value="sats">monto en sats</option>
          </select>
        </label>{" "}
        <label>
          Monto{" "}
          <input value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} />
        </label>{" "}
        <label>
          Expira en horas{" "}
          <input
            value={expiryHours}
            onChange={(e) => setExpiryHours(e.target.value)}
            style={{ width: 60 }}
          />
        </label>
      </div>

      <div>
        <label style={{ display: "block" }}>
          Métodos de pago (separados por coma)
          <input
            value={methods}
            onChange={(e) => setMethods(e.target.value)}
            style={{ width: "100%" }}
          />
        </label>
      </div>

      {type === "sell" && (
        <div>
          <label style={{ display: "block" }}>
            Tu dirección Ark de reembolso (recibe los sats si se cancela/disputa)
            <input
              value={arkRefund}
              onChange={(e) => setArkRefund(e.target.value)}
              placeholder="ark1..."
              style={{ width: "100%" }}
            />
          </label>
        </div>
      )}

      {type === "buy" && (
        <div>
          <label style={{ display: "block" }}>
            Tu dirección Ark donde recibirás los sats que compras
            <input
              value={arkReceive}
              onChange={(e) => setArkReceive(e.target.value)}
              placeholder="ark1..."
              style={{ width: "100%" }}
            />
          </label>
        </div>
      )}

      <button type="button" disabled={busy} onClick={submit}>
        {busy ? "Publicando..." : "Publicar orden"}
      </button>

      {status && <p style={{ color: "green" }}>{status}</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </section>
  );
}
