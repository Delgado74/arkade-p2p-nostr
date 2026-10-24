import { useState } from "react";
import { effectivePricePerSat, fetchRate, fiatToSats, satsToFiat, type RateQuote } from "../lib/rates";
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

const MIN_ORDER_SATS = 350;

export function OrderForm({ client, identity, initialType = "sell", onPublished, onCancel }: Props) {
  const [type, setType] = useState<OrderType>(initialType);
  const [fiat, setFiat] = useState("CUP");
  const [mode, setMode] = useState<Mode>("fiat");
  const [amount, setAmount] = useState("1000");
  const [premium, setPremium] = useState("3");
  const [methods, setMethods] = useState("Transfermóvil, Efectivo");
  const [arkAddress, setArkAddress] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Load rate in real-time when fiat changes
  useState(() => {
    void (async () => {
      try {
        setQuoteLoading(true);
        const q = await fetchRate(fiat);
        setQuote(q);
      } catch {
        // ignore
      } finally {
        setQuoteLoading(false);
      }
    })();
  });

  async function submit() {
    if (!identity) {
      setError("Primero genera o importa una identidad.");
      return;
    }
    const address = arkAddress.trim();
    if (!address) {
      setError(
        type === "buy"
          ? "Indica tu dirección Ark de cobro: es donde recibirás los sats."
          : "Indica tu dirección Ark de reembolso: es donde volverían los sats si hay disputa.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const q = await fetchRate(fiat);
      setQuote(q);
      const pricePerSat = effectivePricePerSat(q, Number(premium) || 0);
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

      if (!Number.isFinite(amountSats) || amountSats < MIN_ORDER_SATS) {
        setError(`El monto mínimo para crear una oferta es ${MIN_ORDER_SATS} sats. Con montos menores el VTXO puede quedar barrido (swept).`);
        setBusy(false);
        return;
      }

      const template = buildOrderTemplate({
        type,
        fiat: q.fiat,
        fiatAmount,
        amountSats,
        premium: Number(premium) || 0,
        paymentMethods: methods.split(",").map((m) => m.trim()).filter(Boolean),
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
        name: identity.npub,
        arkAddress: address,
      });

      const event = await client.publish(template, identity);
      const id = event.tags.find((t) => t[0] === "d")?.[1] ?? event.id;
      setStatus(
        `Orden publicada (${id.slice(0, 8)}…): ${type} ${amountSats.toLocaleString()} sats ` +
          `por ${fiatAmount} ${q.fiat} (fuente Yadio, prima ${premium}%).`,
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
          <span>Moneda (Fiat)</span>
          <select
            className="input"
            value={fiat}
            onChange={async (e) => {
              const next = e.target.value;
              setFiat(next);
              try {
                setQuoteLoading(true);
                const q = await fetchRate(next);
                setQuote(q);
              } catch {
                // ignore
              } finally {
                setQuoteLoading(false);
              }
            }}
          >
            <option value="CUP">CUP - Peso cubano</option>
            <option value="MLC">MLC - Moneda Libremente Convertible</option>
            <option value="USD">USD - Dólar estadounidense</option>
            <option value="EUR">EUR - Euro</option>
            <option value="ARS">ARS - Peso argentino</option>
            <option value="BRL">BRL - Real brasileño</option>
            <option value="MXN">MXN - Peso mexicano</option>
            <option value="COP">COP - Peso colombiano</option>
            <option value="VES">VES - Bolívar venezolano</option>
            <option value="PEN">PEN - Sol peruano</option>
            <option value="CLP">CLP - Peso chileno</option>
            <option value="UYU">UYU - Peso uruguayo</option>
            <option value="BOB">BOB - Boliviano</option>
            <option value="PYG">PYG - Guaraní paraguayo</option>
            <option value="DOP">DOP - Peso dominicano</option>
            <option value="GTQ">GTQ - Quetzal guatemalteco</option>
            <option value="CRC">CRC - Colón costarricense</option>
            <option value="HNL">HNL - Lempira hondureño</option>
            <option value="NIO">NIO - Córdoba nicaragüense</option>
          </select>
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
        <p className="panel-note">Publicación de orden expira en 24 horas.</p>
      </div>
      {quote && quote.usdPerBtc && quote.fiatPerBtc && (
        <p className="panel-note" style={{ opacity: 0.9, fontSize: "0.9em" }}>
          Fuente: <strong>Yadio</strong>
          {quoteLoading ? " · Actualizando..." : ""}
          {fiat.toUpperCase() === "CUP" && (
            <>
              {" "}· 1 USD ≈ <strong>{(quote.fiatPerBtc / quote.usdPerBtc).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CUP</strong>
              {Number(premium) !== 0 && (
                <>
                  {" "}· Con tu {Number(premium) > 0 ? "prima" : "descuento"} ({Number(premium) > 0 ? "+" : ""}{premium}%):{" "}
                  <strong>
                    {((quote.fiatPerBtc / quote.usdPerBtc) * effectivePricePerSat(quote, Number(premium) || 0) / quote.fiatPerSat).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CUP/USD
                  </strong>
                </>
              )}
              {" "}· 1 BTC ≈ <strong>{Math.round(quote.fiatPerBtc).toLocaleString()} CUP</strong>
            </>
          )}
          {fiat.toUpperCase() !== "CUP" && fiat.toUpperCase() !== "USD" && (
            <>
              {" "}· 1 USD ≈ <strong>{(quote.fiatPerBtc / quote.usdPerBtc).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {quote.fiat}</strong>
              {Number(premium) !== 0 && (
                <>
                  {" "}· Con tu {Number(premium) > 0 ? "prima" : "descuento"} ({Number(premium) > 0 ? "+" : ""}{premium}%):{" "}
                  <strong>
                    {((quote.fiatPerBtc / quote.usdPerBtc) * effectivePricePerSat(quote, Number(premium) || 0) / quote.fiatPerSat).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {quote.fiat}/USD
                  </strong>
                </>
              )}
              {" "}· 1 BTC ≈ <strong>{Math.round(quote.fiatPerBtc).toLocaleString()} {quote.fiat}</strong>
            </>
          )}
          {fiat.toUpperCase() === "USD" && (
            <>
              {" "}· 1 BTC ≈ <strong>{Math.round(quote.fiatPerBtc).toLocaleString()} USD</strong>
              {Number(premium) !== 0 && (
                <>
                  {" "}· Con tu {Number(premium) > 0 ? "prima" : "descuento"} ({Number(premium) > 0 ? "+" : ""}{premium}%):{" "}
                  <strong>{Math.round(quote.fiatPerBtc * effectivePricePerSat(quote, Number(premium) || 0) / quote.fiatPerSat).toLocaleString()} USD/BTC</strong>
                </>
              )}
            </>
          )}
        </p>
      )}
      <div
        className="panel-note"
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(245, 158, 11, 0.7)",
          background: "rgba(245, 158, 11, 0.12)",
          fontWeight: 600,
        }}
      >
        <strong>⚠ Mínimo permitido: {MIN_ORDER_SATS} sats</strong>
        {(() => {
          try {
            const q = quote;
            if (!q) return null;
            const pricePerSat = effectivePricePerSat(q, Number(premium) || 0);
            if (pricePerSat <= 0) return null;
            const fiatVal = Math.round(satsToFiat(MIN_ORDER_SATS, pricePerSat) * 100) / 100;
            return ` ≈ ${fiatVal.toLocaleString()} ${q.fiat} (con esta prima/descuento)`;
          } catch {
            return null;
          }
        })()}
        . Con montos menores existe mayor riesgo de que el VTXO quede barrido (swept).
      </div>

      <label className="field">
        <span>Métodos de pago (separados por coma)</span>
        <input className="input" value={methods} onChange={(e) => setMethods(e.target.value)} />
      </label>

      <label className="field">
        <span>
          {type === "buy" ? "Tu dirección Ark de cobro" : "Tu dirección Ark de reembolso"}
        </span>
        <input
          className="input"
          value={arkAddress}
          onChange={(e) => setArkAddress(e.target.value)}
          placeholder="tark1…"
        />
      </label>
      <p className="panel-note">
        {type === "buy"
          ? "Aquí llegarán los sats si el vendedor libera el escrow."
          : "Aquí volverían los sats si el escrow se reembolsa. La contraparte la conoce desde tu oferta."}
      </p>

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
