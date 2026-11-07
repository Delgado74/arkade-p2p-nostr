import { describe, expect, it } from "vitest";
import { validateAgreement, type AgreementValidationContext } from "./agreement";
import { ESCROW_VERSION } from "./escrow";
import type { EscrowAgreement } from "./trade";

const NOW = 1_700_000_000;
const BUYER = "11".repeat(32);
const SELLER = "22".repeat(32);
const SERVER = "33".repeat(32);
const SOLVER = "44".repeat(32);

function agreement(overrides: Partial<EscrowAgreement> = {}): EscrowAgreement {
  return {
    escrowVersion: ESCROW_VERSION,
    orderId: "order-1",
    fiat: "USD",
    fiatAmount: 25,
    tradeSats: 10_000,
    buyerPubKey: BUYER,
    sellerPubKey: SELLER,
    arbiterPubKeys: [SOLVER],
    serverPubKey: SERVER,
    refundLocktime: String(NOW + 24 * 60 * 60),
    ...overrides,
  };
}

function context(overrides: Partial<AgreementValidationContext> = {}): AgreementValidationContext {
  return {
    expectedServerPubKey: SERVER,
    allowedSolvers: [SOLVER],
    expectedOrder: {
      orderId: "order-1",
      tradeSats: 10_000,
      fiat: "USD",
      fiatAmount: 25,
      buyerPubKey: BUYER,
      sellerPubKey: SELLER,
    },
    now: NOW,
    requireFutureLocktime: true,
    ...overrides,
  };
}

function errors(value: unknown, ctx: AgreementValidationContext = context()): string[] {
  return validateAgreement(value, ctx).errors;
}

describe("validateAgreement", () => {
  it("accepts a coherent agreement", () => {
    expect(validateAgreement(agreement(), context())).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it("rejects missing or unsupported escrow versions", () => {
    expect(errors(agreement({ escrowVersion: undefined as unknown as number }))).toContain(
      "el acuerdo usa una versión de escrow no soportada",
    );
    expect(errors(agreement({ escrowVersion: ESCROW_VERSION + 1 }))).toContain(
      "el acuerdo usa una versión de escrow no soportada",
    );
  });

  it("rejects a solver that is not in the trusted registry", () => {
    expect(errors(agreement({ arbiterPubKeys: ["55".repeat(32)] }))).toContain(
      "el solver 555555555555… no está en el registro confiable",
    );
  });

  it("rejects a server key from another ASP", () => {
    expect(errors(agreement({ serverPubKey: "66".repeat(32) }))).toContain(
      "la clave del servidor no coincide con el ASP conectado",
    );
  });

  it("rejects terms that do not match the order", () => {
    const found = errors(agreement({ tradeSats: 9_000, fiatAmount: 20, fiat: "EUR" }));
    expect(found).toContain("los sats del acuerdo no coinciden con la orden");
    expect(found).toContain("el fiat del acuerdo no coincide con la orden");
    expect(found).toContain("el monto fiat del acuerdo no coincide con la orden");
  });

  it("rejects an agreement for a different order", () => {
    expect(errors(agreement({ orderId: "order-2" }))).toContain(
      "el acuerdo pertenece a otra orden",
    );
  });

  it("rejects unexpected parties", () => {
    expect(
      errors(agreement(), context({ expectedBuyerPubKey: "77".repeat(32) })),
    ).toContain("la clave del comprador no es la esperada para esta operación");
  });

  it("rejects a missing or malformed refund locktime", () => {
    expect(errors(agreement({ refundLocktime: undefined }))).toContain(
      "el acuerdo no trae un refundLocktime determinista",
    );
    expect(errors(agreement({ refundLocktime: "soon" }))).toContain(
      "el acuerdo no trae un refundLocktime determinista",
    );
  });

  it("rejects a refund locktime that is too soon", () => {
    expect(errors(agreement({ refundLocktime: String(NOW + 60) }))).toContain(
      "el refundLocktime vence demasiado pronto",
    );
  });

  it("rejects a refund locktime that is too far away", () => {
    expect(
      errors(agreement({ refundLocktime: String(NOW + 30 * 24 * 60 * 60) })),
    ).toContain("el refundLocktime está demasiado lejos en el futuro");
  });

  it("allows a matured locktime when reviewing an existing trade", () => {
    const result = validateAgreement(
      agreement({ refundLocktime: String(NOW - 60) }),
      context({ requireFutureLocktime: false }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("el plazo de reembolso ya venció o está por vencer");
  });

  it("rejects duplicate solvers and identical parties", () => {
    const found = errors(
      agreement({
        buyerPubKey: SELLER,
        sellerPubKey: SELLER,
        arbiterPubKeys: [SOLVER, SOLVER],
      }),
    );
    expect(found).toContain("el acuerdo contiene solvers duplicados");
    expect(found).toContain("comprador y vendedor tienen la misma clave");
  });

  it("fails closed when the solver registry is unavailable", () => {
    expect(errors(agreement(), context({ allowedSolvers: null }))).toContain(
      "no se pudo verificar el registro de solvers",
    );
    expect(errors(agreement(), context({ allowedSolvers: [] }))).toContain(
      "el registro de solvers está vacío; no se puede validar el acuerdo",
    );
  });

  it("rejects malformed payloads without throwing", () => {
    expect(validateAgreement(null).ok).toBe(false);
    expect(validateAgreement("nope").ok).toBe(false);
    expect(validateAgreement({}).ok).toBe(false);
  });
});
