/** Price sources, in priority order. TasaK is the P2P market rate (Cuba). */
export type RateSource = "tasak" | "yadio";

export const TASAK_URL = "https://tasak.app/api/tasa.json";
export const YADIO_URL = "https://api.yadio.io/exrates/BTC";

export interface RateQuote {
  /** ISO 4217 fiat code (uppercase). */
  fiat: string;
  /** Fiat units per 1 BTC. */
  fiatPerBtc: number;
  /** Fiat units per 1 sat. */
  fiatPerSat: number;
  /** Which source produced this quote. */
  source: RateSource;
  /** Unix seconds when TasaK last updated (only for TasaK). */
  updated?: number;
  /** Unix ms when we fetched the quote. */
  fetchedAt: number;
}

interface TasakResponse {
  fiat: string;
  btc: number;
  usd: number;
  sat: number;
  decimals?: number;
  updated?: number;
}

interface YadioResponse {
  BTC: Record<string, number>;
}

async function fetchTasak(): Promise<TasakResponse> {
  const res = await fetch(TASAK_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TasaK HTTP ${res.status}`);
  const data = (await res.json()) as TasakResponse;
  if (typeof data.btc !== "number" || typeof data.sat !== "number") {
    throw new Error("TasaK: unexpected payload");
  }
  return data;
}

async function fetchYadio(): Promise<YadioResponse> {
  const res = await fetch(YADIO_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Yadio HTTP ${res.status}`);
  return (await res.json()) as YadioResponse;
}

/**
 * Fetch the fiat/BTC rate for `fiat`.
 *
 * Tries TasaK first (only covers the fiats it publishes, currently CUP); if the
 * requested fiat is not covered — or TasaK fails — falls back to Yadio.
 */
export async function fetchRate(fiat: string, errors: string[] = []): Promise<RateQuote> {
  const code = fiat.trim().toUpperCase();
  if (!code) throw new Error("fiat code is required");

  try {
    const tasak = await fetchTasak();
    if (tasak.fiat.toUpperCase() === code) {
      return {
        fiat: code,
        fiatPerBtc: tasak.btc,
        fiatPerSat: tasak.sat,
        source: "tasak",
        updated: tasak.updated,
        fetchedAt: Date.now(),
      };
    }
    errors.push(`TasaK does not quote ${code} (has ${tasak.fiat})`);
  } catch (e) {
    errors.push(`TasaK: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const yadio = await fetchYadio();
    const fiatPerBtc = yadio.BTC?.[code];
    if (typeof fiatPerBtc !== "number") {
      throw new Error(`Yadio has no rate for ${code}`);
    }
    return {
      fiat: code,
      fiatPerBtc,
      fiatPerSat: fiatPerBtc / 1e8,
      source: "yadio",
      fetchedAt: Date.now(),
    };
  } catch (e) {
    errors.push(`Yadio: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`no rate for ${code}: ${errors.join("; ")}`);
  }
}

/**
 * Effective price of one satoshis in fiat, applying the maker's premium.
 *
 * A positive `premiumPct` makes BTC more expensive (maker asks above market);
 * a negative value is a discount.
 */
export function effectivePricePerSat(quote: RateQuote, premiumPct: number): number {
  return quote.fiatPerSat * (1 + premiumPct / 100);
}

/** Sats to trade for a desired fiat amount, at the given fiat-per-sat price. */
export function fiatToSats(fiatAmount: number, pricePerSat: number): number {
  if (pricePerSat <= 0) throw new Error("price per sat must be positive");
  return Math.round(fiatAmount / pricePerSat);
}

/** Fiat value of a sats amount, at the given fiat-per-sat price. */
export function satsToFiat(sats: number, pricePerSat: number): number {
  return sats * pricePerSat;
}

/** Format a fiat amount with a fixed number of decimals. */
export function formatFiat(amount: number, decimals = 2): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
