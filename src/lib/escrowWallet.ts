import { contractHandlers, DefaultVtxo } from "@arkade-os/sdk";
import type { Contract, NetworkName } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
  escrowContractHandler,
  escrowFromContract,
  escrowFromParams,
  escrowToParams,
  ESCROW_CONTRACT_TYPE,
  type EscrowContractParams,
} from "./escrowHandler";
import { buildEscrow, type Escrow, type EscrowConfig } from "./escrow";
import type { ArkContext } from "./arkade";
import type { Identity } from "./identity";

/**
 * Ensure the escrow contract handler is registered with the SDK.
 * Safe to call multiple times.
 */
export function ensureEscrowHandlerRegistered(): void {
  try {
    // If already registered this may throw; ignore
    contractHandlers.register(escrowContractHandler as any);
  } catch {
    // ignore
  }
}

/**
 * Build an Escrow instance and serialize its params for contract storage.
 */
export function createEscrowParams(
  ctx: ArkContext,
  config: Omit<EscrowConfig, "serverPubKey">,
): { escrow: Escrow; params: EscrowContractParams } {
  ensureEscrowHandlerRegistered();
  const escrow = buildEscrow(
    {
      ...config,
      serverPubKey: ctx.serverPubKey,
    },
    ctx.network,
  );
  const params = escrowToParams(escrow, ctx.network.name as NetworkName);
  return { escrow, params };
}

/**
 * Rebuild an Escrow from serialized contract params.
 */
export function escrowFromContractParams(params: Record<string, string>): Escrow {
  ensureEscrowHandlerRegistered();
  return escrowFromParams(params);
}

/**
 * Rebuild an Escrow from an SDK Contract instance.
 */
export function escrowFromSdkContract(contract: Contract): Escrow {
  ensureEscrowHandlerRegistered();
  return escrowFromContract(contract);
}

/**
 * Get the contract type identifier for escrow contracts.
 */
export function getEscrowContractType(): string {
  return ESCROW_CONTRACT_TYPE;
}

/**
 * Create a Contract-like object descriptor for the escrow using the handler.
 * This is useful for passing to SDK APIs that expect a Contract shape.
 */
export function contractFromEscrow(
  escrow: Escrow,
  network: NetworkName,
  contractId?: string,
): Contract {
  ensureEscrowHandlerRegistered();
  const params = escrowToParams(escrow, network);
  const script = escrowContractHandler.createScript(params);
  return {
    id: contractId ?? `${ESCROW_CONTRACT_TYPE}:${hex.encode(escrow.script.pkScript)}`,
    type: ESCROW_CONTRACT_TYPE,
    params,
    script,
  } as unknown as Contract;
}

/**
 * Derive a plain single-key Arkade address for an identity, without an HD
 * wallet. Uses the default VTXO script shape (`forfeit = owner + server`,
 * `exit = owner after CSV`), so a payout sent here lands in a VTXO the owner
 * controls and can move with the server's co-signature.
 *
 * This is the destination used for escrow recovery: it is a script *this*
 * identity can satisfy on its own (with the ASP), so recovered funds are not
 * stranded.
 */
export function derivePersonalArkScript(identity: Identity, ctx: ArkContext): DefaultVtxo.Script {
  const delay = BigInt(ctx.info.unilateralExitDelay);
  return new DefaultVtxo.Script({
    pubKey: hex.decode(identity.pubkeyHex),
    serverPubKey: ctx.serverPubKey,
    csvTimelock: {
      value: delay,
      type: delay < 512n ? "blocks" : "seconds",
    },
  });
}

/** The Arkade address for {@link derivePersonalArkScript}. */
export function derivePersonalArkAddress(identity: Identity, ctx: ArkContext): string {
  const script = derivePersonalArkScript(identity, ctx);
  return script.address(ctx.network.hrp, ctx.serverPubKey).encode();
}

/** The on-chain Taproot address for {@link derivePersonalArkScript}. */
export function derivePersonalOnchainAddress(identity: Identity, ctx: ArkContext): string {
  const script = derivePersonalArkScript(identity, ctx);
  return script.onchainAddress(ctx.network);
}
