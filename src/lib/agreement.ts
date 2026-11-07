/**
 * Validation of the escrow agreement both parties are about to commit to.
 *
 * The agreement is delivered over an authenticated DM, but its contents are
 * still chosen by the counterparty. Deriving an address from it is not enough:
 * a malicious seller could commit an arbitrary solver set, a server key from a
 * different ASP, terms that do not match the order, or a timelock outside the
 * policy. Both sides must validate it before funding or spending the escrow.
 */

const HEX64 = /^[0-9a-f]{64}$/i;
const UINT = /^\d+$/;
const FIAT = /^[A-Za-z0-9]{2,16}$/;

/** Refunds must leave the buyer at least this long to react. */
export const MIN_REFUND_LOCKTIME_SECONDS = 5 * 60;
/** Upper bound for a refund timelock (7 days). */
export const MAX_REFUND_LOCKTIME_SECONDS = 7 * 24 * 60 * 60;
/** Warn once the timelock is this close/past. */
const MATURE_WARNING_SECONDS = 60 * 60;

/** Order data the agreement must reproduce exactly. */
export interface ExpectedAgreementTerms {
  orderId?: string;
  tradeSats?: number;
  fiat?: string;
  fiatAmount?: number;
  buyerPubKey?: string;
  sellerPubKey?: string;
}

export interface AgreementValidationContext {
  /** x-only hex of the ASP currently connected. Required. */
  expectedServerPubKey?: string;
  /**
   * Solvers currently trusted for the community (registry, with the configured
   * arbiter as fallback). An empty/absent list fails closed.
   */
  allowedSolvers?: readonly string[] | null;
  /** Order/terms the agreement is supposed to settle. */
  expectedOrder?: ExpectedAgreementTerms | null;
  /** Optional explicit party expectations (buyer/seller). */
  expectedBuyerPubKey?: string;
  expectedSellerPubKey?: string;
  /** Reference time in Unix seconds; defaults to the local clock. */
  now?: number;
  minRefundSeconds?: number;
  maxRefundSeconds?: number;
  /**
   * When true (agreement creation), the locktime must still be in the future.
   * When false (review/reopening), a matured locktime is only a warning because
   * the parties may still need to release or dispute.
   */
  requireFutureLocktime?: boolean;
}

export interface AgreementValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function pushOnce(list: string[], message: string): void {
  if (!list.includes(message)) list.push(message);
}

export function validateAgreement(
  input: unknown,
  context: AgreementValidationContext = {},
): AgreementValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["el acuerdo no es un objeto válido"], warnings };
  }

  const orderId = input.orderId;
  if (typeof orderId !== "string" || orderId.trim().length === 0) {
    pushOnce(errors, "falta el id de la orden en el acuerdo");
  } else if (orderId.length > 256) {
    pushOnce(errors, "el id de la orden del acuerdo es demasiado largo");
  }

  const buyerPubKey = input.buyerPubKey;
  const sellerPubKey = input.sellerPubKey;
  if (!isHex64(buyerPubKey)) {
    pushOnce(errors, "la clave del comprador no es un pubkey x-only hex de 32 bytes");
  }
  if (!isHex64(sellerPubKey)) {
    pushOnce(errors, "la clave del vendedor no es un pubkey x-only hex de 32 bytes");
  }
  if (isHex64(buyerPubKey) && isHex64(sellerPubKey) && normalize(buyerPubKey) === normalize(sellerPubKey)) {
    pushOnce(errors, "comprador y vendedor tienen la misma clave");
  }

  const fiat = input.fiat;
  if (typeof fiat !== "string" || !FIAT.test(fiat.trim())) {
    pushOnce(errors, "el fiat del acuerdo no es válido");
  }

  const fiatAmount = input.fiatAmount;
  if (typeof fiatAmount !== "number" || !Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    pushOnce(errors, "el monto fiat del acuerdo debe ser un número positivo");
  }

  const tradeSats = input.tradeSats;
  if (
    typeof tradeSats !== "number" ||
    !Number.isSafeInteger(tradeSats) ||
    tradeSats <= 0
  ) {
    pushOnce(errors, "los sats del acuerdo deben ser un entero positivo y seguro");
  }

  const serverPubKey = input.serverPubKey;
  if (!isHex64(serverPubKey)) {
    pushOnce(errors, "la clave del servidor no es un pubkey x-only hex de 32 bytes");
  }

  const allowedSolvers = context.allowedSolvers;
  const solverList = Array.isArray(allowedSolvers)
    ? allowedSolvers.map((value) => (typeof value === "string" ? normalize(value) : ""))
    : [];
  if (allowedSolvers === undefined || allowedSolvers === null) {
    pushOnce(errors, "no se pudo verificar el registro de solvers");
  } else if (solverList.length === 0) {
    pushOnce(errors, "el registro de solvers está vacío; no se puede validar el acuerdo");
  }

  const arbiterPubKeys = input.arbiterPubKeys;
  if (!Array.isArray(arbiterPubKeys) || arbiterPubKeys.length === 0) {
    pushOnce(errors, "el acuerdo no compromete ningún solver");
  } else if (arbiterPubKeys.length > 20) {
    pushOnce(errors, "el acuerdo compromete demasiados solvers");
  } else {
    const seen = new Set<string>();
    for (const solver of arbiterPubKeys) {
      if (!isHex64(solver)) {
        pushOnce(errors, "el acuerdo contiene una clave de solver inválida");
        continue;
      }
      const key = normalize(solver);
      if (seen.has(key)) {
        pushOnce(errors, "el acuerdo contiene solvers duplicados");
        continue;
      }
      seen.add(key);
      if (solverList.length > 0 && !solverList.includes(key)) {
        pushOnce(errors, `el solver ${solver.slice(0, 12)}… no está en el registro confiable`);
      }
    }
  }

  const expectedServer = context.expectedServerPubKey;
  if (!isHex64(expectedServer)) {
    pushOnce(errors, "no hay una clave de servidor conocida para comparar");
  } else if (isHex64(serverPubKey) && normalize(serverPubKey) !== normalize(expectedServer)) {
    pushOnce(errors, "la clave del servidor no coincide con el ASP conectado");
  }

  const expected = context.expectedOrder;
  if (expected) {
    if (expected.orderId !== undefined && String(orderId ?? "") !== expected.orderId) {
      pushOnce(errors, "el acuerdo pertenece a otra orden");
    }
    if (
      expected.tradeSats !== undefined &&
      (typeof tradeSats !== "number" || tradeSats !== expected.tradeSats)
    ) {
      pushOnce(errors, "los sats del acuerdo no coinciden con la orden");
    }
    if (
      expected.fiat !== undefined &&
      (typeof fiat !== "string" || fiat.trim().toUpperCase() !== expected.fiat.trim().toUpperCase())
    ) {
      pushOnce(errors, "el fiat del acuerdo no coincide con la orden");
    }
    if (
      expected.fiatAmount !== undefined &&
      (typeof fiatAmount !== "number" ||
        !Number.isFinite(fiatAmount) ||
        Math.abs(fiatAmount - expected.fiatAmount) > 1e-9)
    ) {
      pushOnce(errors, "el monto fiat del acuerdo no coincide con la orden");
    }
    if (
      expected.buyerPubKey !== undefined &&
      (!isHex64(buyerPubKey) || normalize(buyerPubKey) !== normalize(expected.buyerPubKey))
    ) {
      pushOnce(errors, "la clave del comprador no es la esperada para esta operación");
    }
    if (
      expected.sellerPubKey !== undefined &&
      (!isHex64(sellerPubKey) || normalize(sellerPubKey) !== normalize(expected.sellerPubKey))
    ) {
      pushOnce(errors, "la clave del vendedor no es la esperada para esta operación");
    }
  }

  if (
    context.expectedBuyerPubKey !== undefined &&
    (!isHex64(buyerPubKey) || normalize(buyerPubKey) !== normalize(context.expectedBuyerPubKey))
  ) {
    pushOnce(errors, "la clave del comprador no es la esperada para esta operación");
  }
  if (
    context.expectedSellerPubKey !== undefined &&
    (!isHex64(sellerPubKey) || normalize(sellerPubKey) !== normalize(context.expectedSellerPubKey))
  ) {
    pushOnce(errors, "la clave del vendedor no es la esperada para esta operación");
  }

  const locktimeRaw = input.refundLocktime;
  let locktime: bigint | null = null;
  if (typeof locktimeRaw === "string" && UINT.test(locktimeRaw)) {
    try {
      locktime = BigInt(locktimeRaw);
    } catch {
      locktime = null;
    }
  } else if (typeof locktimeRaw === "number" && Number.isSafeInteger(locktimeRaw)) {
    locktime = BigInt(locktimeRaw);
  }
  if (locktime === null) {
    pushOnce(errors, "el acuerdo no trae un refundLocktime determinista");
  } else {
    const now = BigInt(Math.floor(context.now ?? Date.now() / 1000));
    const min = BigInt(context.minRefundSeconds ?? MIN_REFUND_LOCKTIME_SECONDS);
    const max = BigInt(context.maxRefundSeconds ?? MAX_REFUND_LOCKTIME_SECONDS);
    if (locktime <= 0n) {
      pushOnce(errors, "el refundLocktime no es un timestamp válido");
    }
    if (locktime > now + max) {
      pushOnce(errors, "el refundLocktime está demasiado lejos en el futuro");
    }
    if (context.requireFutureLocktime !== false && locktime < now + min) {
      pushOnce(errors, "el refundLocktime vence demasiado pronto");
    }
    if (locktime <= now + BigInt(MATURE_WARNING_SECONDS)) {
      warnings.push("el plazo de reembolso ya venció o está por vencer");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
