import type { EscrowAgreement } from "../trade";
import { daemonClient } from "./client";

/**
 * RPC surface needed to persist derived state (injectable for tests).
 *
 * These writes are best-effort: the daemon is the durable owner, but the UI
 * must keep working when it is down, so failures are swallowed.
 */
export interface StateRpc {
  call<T = any>(method: string, params?: any): Promise<T>;
}

export type PersistedEscrowState =
  | "created"
  | "pending"
  | "spendable"
  | "recoverable"
  | "swept"
  | "released"
  | "refunded";

export interface EscrowSyncInput {
  orderId: string;
  address: string;
  agreement: EscrowAgreement;
  state: PersistedEscrowState;
  vtxoTxid?: string;
  vtxoVout?: number;
  fundedSats?: number;
}

/** Persist the escrow derived from an agreement, plus its current VTXO. */
export async function syncEscrow(
  input: EscrowSyncInput,
  rpc: StateRpc = daemonClient,
): Promise<void> {
  if (!input.orderId || !input.address) return;
  try {
    await rpc.call("escrows.upsert", {
      orderId: input.orderId,
      patch: {
        address: input.address,
        buyerPubKey: input.agreement.buyerPubKey,
        sellerPubKey: input.agreement.sellerPubKey,
        arbiterPubKeys: input.agreement.arbiterPubKeys,
        serverPubKey: input.agreement.serverPubKey,
        escrowVersion: input.agreement.escrowVersion,
        refundLocktime: input.agreement.refundLocktime,
        state: input.state,
        vtxoTxid: input.vtxoTxid,
        vtxoVout: input.vtxoVout,
        fundedSats: input.fundedSats,
        agreementJson: JSON.stringify(input.agreement),
      },
    });
  } catch {
    // Daemon unavailable: the panel keeps its in-memory state.
  }
}

export type PersistedDisputeState =
  | "initiated"
  | "in-progress"
  | "settled"
  | "refunded"
  | "canceled"
  | "open"
  | "taken"
  | "resolved";

export interface DisputeSyncInput {
  orderId: string;
  status: PersistedDisputeState;
  initiator?: string;
  winner?: string;
  reason?: string;
  announceEventId?: string;
  takeEventId?: string;
  resolutionEventId?: string;
}

/** Persist the public dispute lifecycle seen for one order. */
export async function syncDispute(
  input: DisputeSyncInput,
  rpc: StateRpc = daemonClient,
): Promise<void> {
  if (!input.orderId) return;
  try {
    await rpc.call("disputes.upsert", {
      orderId: input.orderId,
      patch: {
        status: input.status,
        initiator: input.initiator,
        winner: input.winner,
        reason: input.reason,
        announceEventId: input.announceEventId,
        takeEventId: input.takeEventId,
        resolutionEventId: input.resolutionEventId,
      },
    });
  } catch {
    // Daemon unavailable: disputes remain derivable from the relay feed.
  }
}

export interface RatingSyncInput {
  eventId: string;
  orderId: string;
  author: string;
  subject: string;
  score: number;
  community?: string;
  createdAt: number;
}

/** Index a rating we just published so reputation survives a reload. */
export async function syncRating(
  input: RatingSyncInput,
  rpc: StateRpc = daemonClient,
): Promise<void> {
  if (!input.eventId || !input.orderId) return;
  try {
    await rpc.call("ratings.upsert", { rating: input });
  } catch {
    // Daemon unavailable: the rating is still on the relays.
  }
}
