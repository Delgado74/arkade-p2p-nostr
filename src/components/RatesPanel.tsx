import { useState } from "react";
import {
  effectivePricePerSat,
  fetchRate,
  fiatToSats,
  formatFiat,
  satsToFiat,
  type RateQuote,
} from "../lib/rates";

export function RatesPanel() {
  const [fiat, setFiat] = useState("CUP");
  const [premium, setPremium] = useState("3");
  const [amount, setAmount] = useState("1000");
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError("");
    try {
      setQuote(await fetchRate(fiat));
    } catch (e) {
      setQuote(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const premiumPct = Number(premium) || 0;
  const pricePerSat = quote ? effectivePricePerSat(quote, premiumPct) : null;
  const fiatValue = Number(amount) || 0;

  return (
    <section>
      <h2>Tasas</h2>
      <div>
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
        </label>{" "}
        <button type="button" disabled={busy} onClick={load}>
          {busy ? "..." : "Consultar"}
        </button>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {quote && pricePerSat !== null && (
        <>
          <dl>
            <dt>Fuente</dt>
            <dd>{quote.source}</dd>
            <dt>Fiat por BTC</dt>
            <dd>{formatFiat(quote.fiatPerBtc)}</dd>
            <dt>Fiat por sat (mercado)</dt>
            <dd>{quote.fiatPerSat.toFixed(8)}</dd>
            <dt>Precio efectivo por sat (con prima)</dt>
            <dd>{pricePerSat.toFixed(8)}</dd>
          </dl>
          <div>
            <label>
              Fiat a cambiar{" "}
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ width: 100 }}
              />
            </label>
            <p>
              = {fiatToSats(fiatValue, pricePerSat).toLocaleString()} sats
              {" · "}
              {formatFiat(satsToFiat(fiatToSats(fiatValue, pricePerSat), pricePerSat))}{" "}
              {quote.fiat}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
