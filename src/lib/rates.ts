/** Price source. */
export type RateSource = "yadio";
export type RatePreference = "auto" | "yadio";

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
  /** Unix ms when we fetched the quote. */
  fetchedAt: number;
  /** USD per 1 BTC (for showing CUP/USD equivalence). */
  usdPerBtc?: number;
}

interface YadioResponse {
  BTC: Record<string, number>;
}

async function fetchYadio(): Promise<YadioResponse> {
  const res = await fetch(YADIO_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Yadio HTTP ${res.status}`);
  return (await res.json()) as YadioResponse;
}

async function quoteFromYadio(code: string): Promise<RateQuote> {
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
    usdPerBtc: typeof yadio.BTC?.["USD"] === "number" ? yadio.BTC["USD"] : undefined,
  };
}

/**
 * Fetch the fiat/BTC rate for `fiat`.
 */
export async function fetchRate(fiat: string): Promise<RateQuote> {
  const code = fiat.trim().toUpperCase();
  if (!code) throw new Error("fiat code is required");
  return quoteFromYadio(code);
}

/** Fetch rate forcing a specific source. */
export async function fetchRateFrom(
  source: Exclude<RatePreference, "auto">,
  fiat: string,
): Promise<RateQuote> {
  const code = fiat.trim().toUpperCase();
  if (!code) throw new Error("fiat code is required");
  if (source === "yadio") return quoteFromYadio(code);
  return quoteFromYadio(code);
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
