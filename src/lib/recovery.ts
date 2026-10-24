import {
  Wallet,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  InMemoryIntentRepository,
  InMemoryVirtualTxRepository,
} from "@arkade-os/sdk";
import type { Contract, NetworkName, SettlementEvent } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { Escrow } from "./escrow";
import { escrowToParams, ESCROW_CONTRACT_TYPE } from "./escrowHandler";
import { ensureEscrowHandlerRegistered } from "./escrowWallet";
import type { ArkContext } from "./arkade";
import type { Identity } from "./identity";

/**
 * A minimal, single-key Arkade wallet used only to recover swept escrow VTXOs.
 *
 * The P2P app does not run an HD wallet: every participant holds a {@link
 * Identity} whose `ark` is a `SingleKey`. To drive `VtxoManager.recoverVtxos`
 * — the only off-chain path back from a VTXO swept out of its batch — the SDK
 * still needs a wallet with contract storage and the settlement machinery. We
 * build the smallest one that satisfies it: `walletMode: "static"` (no HD, no
 * rotation), `settlementConfig: false` (no background renewal/sweep), and
 * in-memory repositories (the escrow contract is re-registered on demand, so
 * nothing needs to survive a reload).
 *
 * With `walletMode: "static"` the wallet's own receive address is the same
 * default single-key script derived in {@link derivePersonalArkAddress}, so a
 * recovery settles the escrow straight back to the participant's personal
 * address.
 */
export interface RecoveryWallet {
  wallet: Wallet;
  /** Register an escrow contract so its VTXOs become visible to the wallet. */
  watchEscrow(escrow: Escrow): Promise<Contract>;
  /** Attempt recovery of every swept escrow VTXO the wallet can see. */
  recover(eventCallback?: (event: SettlementEvent) => void): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * Create a recovery wallet bound to one identity and Arkade connection.
 *
 * The escrow contract handler must be registered before the wallet is built so
 * `ContractManager` can rebuild the escrow script from stored params and apply
 * its `deriveTapscripts`/`assertSpendableNow` during sync and recovery.
 */
export async function createRecoveryWallet(
  ctx: ArkContext,
  identity: Identity,
): Promise<RecoveryWallet> {
  ensureEscrowHandlerRegistered();

  const wallet = await Wallet.create({
    identity: identity.ark,
    arkProvider: ctx.ark,
    indexerProvider: ctx.indexer,
    walletMode: "static",
    settlementConfig: false,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
      intentRepository: new InMemoryIntentRepository(),
      virtualTxRepository: new InMemoryVirtualTxRepository(),
    },
  });

  const manager = await wallet.getContractManager();
  const network = ctx.network.name as NetworkName;

  return {
    wallet,
    async watchEscrow(escrow) {
      const params = escrowToParams(escrow, network);
      return manager.createContract({
        type: ESCROW_CONTRACT_TYPE,
        params,
        script: hex.encode(escrow.script.pkScript),
        address: escrow.address,
      } as unknown as Parameters<typeof manager.createContract>[0]);
    },
    async recover(eventCallback) {
      const vtxoManager = await wallet.getVtxoManager();
      return vtxoManager.recoverVtxos(eventCallback);
    },
    async dispose() {
      await wallet.dispose();
    },
  };
}

/**
 * Convenience: register `escrow`, then recover. Bubbles up the SDK's own
 * errors (`No recoverable VTXOs found`, the `assertSpendableNow` refusal while
 * the refund timelock is immature, etc.) so callers can surface a useful
 * message.
 */
export async function recoverEscrowVtxos(
  ctx: ArkContext,
  identity: Identity,
  escrow: Escrow,
  eventCallback?: (event: SettlementEvent) => void,
): Promise<string> {
  const recovery = await createRecoveryWallet(ctx, identity);
  try {
    await recovery.watchEscrow(escrow);
    return await recovery.recover(eventCallback);
  } finally {
    await recovery.dispose();
  }
}
