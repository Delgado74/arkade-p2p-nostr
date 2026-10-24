import type { TradeRole } from "./trade";

/**
 * Lifecycle of a locally tracked trade, from the local user's point of view.
 *
 * - `in-progress` — the trade is live and belongs on the Operación screen.
 * - `completed` — funds released to the buyer.
 * - `canceled` — canceled by mutual agreement.
 * - `arbiter-release` / `arbiter-refund` — resolved by the arbiter.
 */
export type OperationStatus =
  | "in-progress"
  | "completed"
  | "canceled"
  | "arbiter-release"
  | "arbiter-refund";

/** A trade the local identity has participated in, stored locally. */
export interface OperationRecord {
  orderId: string;
  /** Counterparty pubkey (hex). */
  counterparty: string;
  role: TradeRole;
  fiat?: string;
  fiatAmount?: number;
  tradeSats?: number;
  status: OperationStatus;
  createdAt: number;
  updatedAt: number;
  /** Seller's Ark refund address, carried over from the order/escrow. */
  refundAddress?: string;
  /** Buyer's Ark payout address, carried over from the order/take. */
  buyerArkAddress?: string;
  /** Ark address published by the maker when it created the order. */
  makerArkAddress?: string;
  /**
   * True when the local identity published the order (maker), false when it
   * took it (taker). Undefined on records created before this field existed.
   */
  maker?: boolean;
  /**
   * The order's advertised side: `sell` (offers BTC) or `buy` (wants BTC).
   * Kept so a republish reproduces the same listing.
   */
  orderType?: "buy" | "sell";
  /**
   * Stars (1-5) the local identity left for the counterparty, once the trade
   * finished. Undefined means it has not rated yet; set it to stop prompting.
   */
  myRating?: number;
  /**
   * Event id of the public order (kind 38383). A rating points at it via its
   * `e` tag, so viewers can verify the rated trade actually exists and ended.
   */
  orderEventId?: string;
}

/** True when the operation is no longer live (finished or aborted). */
export function isFinished(status: OperationStatus): boolean {
  return status !== "in-progress";
}

/** Human-readable label for a finished operation status. */
export function statusLabel(status: OperationStatus): string {
  switch (status) {
    case "completed":
      return "Completada";
    case "canceled":
      return "Cancelada";
    case "arbiter-release":
      return "Disputa: pagada al comprador";
    case "arbiter-refund":
      return "Disputa: reembolsada al vendedor";
    default:
      return "En curso";
  }
}

const KEY_PREFIX = "arkade-p2p-nostr:operations";

function storageKey(pubkey: string): string {
  return `${KEY_PREFIX}:${pubkey}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** All locally tracked operations for an identity, newest first. */
export function loadOperations(pubkey: string): OperationRecord[] {
  if (!pubkey) return [];
  try {
    const raw = storage()?.getItem(storageKey(pubkey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as OperationRecord[]).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function persist(pubkey: string, operations: OperationRecord[]): void {
  try {
    storage()?.setItem(storageKey(pubkey), JSON.stringify(operations));
  } catch {
    // Storage unavailable (private mode, quota): keep the in-memory copy only.
  }
}

/**
 * Merge `patch` into the operation identified by `orderId` (creating it when
 * new) and persist the result.
 *
 * @returns The updated, newest-first operation list.
 */
export function recordOperation(
  pubkey: string,
  orderId: string,
  patch: Partial<OperationRecord>,
): OperationRecord[] {
  if (!pubkey || !orderId) return loadOperations(pubkey);
  const list = loadOperations(pubkey);
  const existing = list.find((op) => op.orderId === orderId);
  const now = Math.floor(Date.now() / 1000);
  const merged: OperationRecord = {
    orderId,
    role: patch.role ?? existing?.role ?? "buyer",
    counterparty: patch.counterparty ?? existing?.counterparty ?? "",
    fiat: patch.fiat ?? existing?.fiat,
    fiatAmount: patch.fiatAmount ?? existing?.fiatAmount,
    tradeSats: patch.tradeSats ?? existing?.tradeSats,
    status: patch.status ?? existing?.status ?? "in-progress",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    refundAddress: patch.refundAddress ?? existing?.refundAddress,
    buyerArkAddress: patch.buyerArkAddress ?? existing?.buyerArkAddress,
    makerArkAddress: patch.makerArkAddress ?? existing?.makerArkAddress,
    maker: patch.maker ?? existing?.maker,
    orderType: patch.orderType ?? existing?.orderType,
    myRating: patch.myRating ?? existing?.myRating,
    orderEventId: patch.orderEventId ?? existing?.orderEventId,
  };
  const next = [merged, ...list.filter((op) => op.orderId !== orderId)];
  persist(pubkey, next);
  return next;
}
