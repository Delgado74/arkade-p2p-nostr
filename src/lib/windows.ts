import type { TradeDm, TradeRole } from "./trade";

/**
 * Window (seconds) an off-chain trade step's owner has to complete it before the
 * order is considered stalled. Mirrors Mostro's 15-minute payment window.
 */
export const TRADE_WINDOW_SECONDS = 15 * 60;

/** Who failed to act in time, or `null` while the trade is on schedule. */
export type WindowCulprit = "taker" | "maker" | null;

export interface WindowState {
  /** Relay-set time the take was received (maker side), else null. */
  takeReceivedAt: number | null;
  /** Relay-set time the taker delivered its Ark address, else null. */
  takerAddressAt: number | null;
  /** Relay-set time the escrow was published, else null. */
  escrowPublishedAt: number | null;
  /** A funded escrow VTXO already exists (windows no longer apply). */
  funded: boolean;
  /** True when the take/address/escrow steps blew their 15-minute window. */
  anyExpired: boolean;
  culprit: WindowCulprit;
}

/**
 * Compute the chained-window state of a trade from its DM feed.
 *
 * Steps, each measured from the previous step's relay-set timestamp:
 *
 *  1. Taker signal  — the taker must deliver its Ark address (in `take` or legacy
 *     `taker_address`).
 *  2. Maker build   — the maker, when it is the seller, must build and publish
 *                     the escrow (`escrow`).
 *  3. Seller fund   — the seller must fund the escrow.
 *
 * The party that misses its step is the culprit. Nothing is funded while a
 * window is running, so cancelling is always safe.
 */
export function computeWindowState(args: {
  feed: TradeDm[];
  orderId: string;
  role: TradeRole;
  isMaker: boolean;
  funded: boolean;
  now: number;
}): WindowState {
  const { feed, orderId, role, isMaker, funded, now } = args;
  const forOrder = feed.filter((e) => e.msg?.orderId === orderId);
  const takeReceivedAt =
    forOrder.find((e) => e.msg?.type === "take" && !e.dm.outgoing)?.dm.createdAt ?? null;
  const takerAddressAt =
    forOrder
      .find((e) => {
        if (e.dm.outgoing) return false;
        if (e.msg?.type === "taker_address") return true;
        if (e.msg?.type === "take" && e.msg.payload.buyerArkAddress) return true;
        return false;
      })
      ?.dm.createdAt ?? null;
  const escrowPublishedAt =
    forOrder.find((e) => e.msg?.type === "escrow")?.dm.createdAt ?? null;

  const takerWindowExpired =
    isMaker &&
    !funded &&
    takeReceivedAt !== null &&
    takerAddressAt === null &&
    now - takeReceivedAt >= TRADE_WINDOW_SECONDS;
  const makerBuildExpired =
    isMaker &&
    role === "seller" &&
    !funded &&
    takerAddressAt !== null &&
    escrowPublishedAt === null &&
    now - takerAddressAt >= TRADE_WINDOW_SECONDS;
  const sellerFundingExpired =
    role === "seller" &&
    !funded &&
    escrowPublishedAt !== null &&
    now - escrowPublishedAt >= TRADE_WINDOW_SECONDS;

  const culprit: WindowCulprit = takerWindowExpired
    ? "taker"
    : makerBuildExpired
      ? "maker"
      : sellerFundingExpired
        ? isMaker
          ? "maker"
          : "taker"
        : null;

  return {
    takeReceivedAt,
    takerAddressAt,
    escrowPublishedAt,
    funded,
    anyExpired: culprit !== null,
    culprit,
  };
}
