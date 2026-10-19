import { useState } from "react";
import { hex } from "@scure/base";
import type { VirtualCoin } from "@arkade-os/sdk";
import type { ArkContext } from "../lib/arkade";
import type { Identity } from "../lib/identity";
import { buildEscrow, findEscrowVtxo, type Escrow } from "../lib/escrow";

interface Props {
  identity: Identity | null;
  ctx: ArkContext | null;
}

export function EscrowHarness({ identity, ctx }: Props) {
  const [buyerKey, setBuyerKey] = useState("");
  const [arbiterKey, setArbiterKey] = useState("");
  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [vtxo, setVtxo] = useState<VirtualCoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  function handleBuild() {
    if (!identity || !ctx) return;
    run(async () => {
      const buyer = buyerKey ? hex.decode(buyerKey) : await identity.ark.xOnlyPublicKey();
      const built = buildEscrow(
        {
          buyerPubKey: buyer,
          sellerPubKey: await identity.ark.xOnlyPublicKey(),
          arbiterPubKeys: arbiterKey ? [hex.decode(arbiterKey)] : [],
          serverPubKey: ctx.serverPubKey,
        },
        ctx.network,
      );
      setEscrow(built);
      setVtxo(null);
    });
  }

  function handleCheckFunding() {
    if (!ctx || !escrow) return;
    run(async () => setVtxo(await findEscrowVtxo(ctx.indexer, escrow)));
  }

  return (
    <section>
      <h2>Escrow (vista de desarrollo)</h2>
      <p style={{ fontSize: "0.85em" }}>
        Compone el VtxoScript de 2 hojas (release + árbitro), muestra direcciones y verifica
        fondeo.
      </p>
      <div>
        <input
          placeholder="buyer pubkey (hex, por defecto: yo)"
          value={buyerKey}
          onChange={(e) => setBuyerKey(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <input
          placeholder="arbiter pubkey (hex)"
          value={arbiterKey}
          onChange={(e) => setArbiterKey(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <button
        type="button"
        disabled={busy || !identity || !ctx || !arbiterKey}
        onClick={handleBuild}
      >
        Construir escrow
      </button>

      {escrow && (
        <>
          <dl>
            <dt>Dirección Ark</dt>
            <dd style={{ wordBreak: "break-all" }}>{escrow.address}</dd>
            <dt>Dirección onchain</dt>
            <dd style={{ wordBreak: "break-all" }}>{escrow.onchainAddress}</dd>
          </dl>
          <button type="button" disabled={busy} onClick={handleCheckFunding}>
            Verificar fondeo
          </button>
          {vtxo ? (
            <p>
              Fondeado: {vtxo.value} sats ({vtxo.txid}:{vtxo.vout})
            </p>
          ) : (
            <p>Sin VTXO todavía.</p>
          )}
        </>
      )}

      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </section>
  );
}
