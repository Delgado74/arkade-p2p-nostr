import { ESCROW_VERSION, type SerializedSpend } from "./escrow";
import type { DirectMessage } from "./dm";

/** Application tag embedded in every trade message to reject unrelated DMs. */
export const TRADE_APP = "arkade-p2p-trade";
/** Message schema version. */
export const TRADE_VERSION = 1;

/** Which side of the trade the local user is playing. */
export type TradeRole = "buyer" | "seller";

/**
 * The escrow parameters both parties must agree on. Everything here is
 * deterministic so buyer and seller derive the exact same escrow script and
 * address; the server key comes from the ASP the seller published.
 */
export interface EscrowAgreement {
  /** Must equal {@link ESCROW_VERSION}; peers reject unknown versions. */
  escrowVersion: number;
  orderId: string;
  /** Fiat code, e.g. `USD`. */
  fiat: string;
  /** Agreed fiat amount the buyer pays off-chain. */
  fiatAmount: number;
  /** Net satoshis the buyer receives when the escrow is released. */
  tradeSats: number;
  /** x-only hex pubkeys. */
  buyerPubKey: string;
  sellerPubKey: string;
  /** List of solver x-only hex pubkeys committed to the escrow (deterministic). */
  arbiterPubKeys: string[];
  /** ASP co-signer x-only hex pubkey (`hex.encode(ctx.serverPubKey)`). */
  serverPubKey: string;
  /**
   * Absolute timelock (Unix seconds, or a block height) of the escrow's
   * `refund` leaf, as a string to survive JSON. Both parties must agree on it
   * so they derive the same script. It is mandatory: without it the two peers
   * would each fall back to their own clock and derive different addresses.
   */
  refundLocktime: string;
}

/** Payload variants keyed by message type. */
export interface TradePayloads {
  /**
   * A taker signals interest in the order. The role it will play is in the
   * message's `role`; the message carries no address — the taker delivers its
   * Ark payout/refund address separately via `taker_address`, which starts the
   * taker's window. A legacy taker may still inline `buyerArkAddress`.
   */
  take: { buyerArkAddress?: string };
  /**
   * The taker's own Ark address for this trade: its payout address when it
   * plays the buyer role, its refund address when it plays the seller role.
   * Authenticated by the DM sender key (not the counterparty's word).
   */
  taker_address: { arkAddress: string };
  /** Seller publishes the agreed escrow, its derived address, and the seller's
   * own Ark address that a refund/arbiter decision should pay if the trade fails. */
  escrow: { agreement: EscrowAgreement; address: string; refundAddress: string };
  /** Seller confirms the escrow VTXO is on-chain and spendable. */
  funded: { txid: string; vout: number; amount: number };
  /** Buyer signals the fiat transfer was sent. */
  fiat_sent: Record<string, never>;
  /** Seller shares the partially-signed release spend for the buyer to co-sign. */
  release_request: { spend: SerializedSpend; to: string; sats: number };
  /** Buyer returns the release spend carrying both signatures. */
  release_signed: { spend: SerializedSpend };
  /** Whoever submitted reports the final off-chain ark txid. */
  release_done: { arkTxid: string };
  /**
   * Cooperative cancellation, phase 1: a party proposes aborting the trade.
   * On its own it does nothing — the counterparty must reply with `cancel_agree`.
   */
  cancel_request: { reason?: string };
  /**
   * Cooperative cancellation, phase 2: a party accepts the pending
   * `cancel_request`. Once both a request and an agree exist the cancellation
   * is effective, so neither side can cancel unilaterally (e.g. the seller
   * cannot cancel after receiving the fiat payment).
   */
  cancel_agree: { reason?: string };
  /**
   * A party's own Ark payout address, sent to the arbiter and authenticated by
   * the DM sender key. The arbiter only pays addresses confirmed this way; it
   * never trusts the (possibly forged) addresses carried by a `dispute`.
   *
   * The agreement is optional: a party that states its address to the
   * counterparty (before the escrow agreement exists) sends it without one,
   * and the receiver still trusts it because the DM author is the claimant.
   */
  ark_address: { agreement?: EscrowAgreement; arkAddress: string };
  /**
   * A solver asks a party for its authenticated Ark payout address during a
   * dispute. Solvers never learn the parties' addresses before a dispute, so
   * they request them here and each party answers with `ark_address` (signed by
   * its own key).
   */
  ark_address_request: { reason?: string };
  /**
   * A party escalates to the solvers. Carries the agreement so solvers can
   * rebuild the escrow, plus both Ark payout addresses as hints. The solver
   * ignores hints for execution; it pays authenticated addresses.
   */
  dispute: {
    reason: string;
    agreement: EscrowAgreement;
    buyerArkAddress: string;
    sellerArkAddress: string;
  };
  /** Solver takes the dispute (optimistic). */
  dispute_taken: {
    orderId: string;
    solverPubKey: string; // hex
  };
  /** Arbiter/solver resolves a dispute; sent to both parties. */
  arbiter_decision: {
    outcome: "release_to_buyer" | "refund_to_seller";
    destination: string;
    sats: number;
    arkTxid: string;
    solverPubKey?: string;
  };
  /** Free-form evidence chat between a solver and one of the parties (NIP-17). */
  chat: {
    text: string;
  };
}

/** All message type discriminants. */
export const TRADE_TYPES = [
  "take",
  "taker_address",
  "escrow",
  "funded",
  "fiat_sent",
  "release_request",
  "release_signed",
  "release_done",
  "cancel_request",
  "cancel_agree",
  "ark_address",
  "ark_address_request",
  "dispute",
  "dispute_taken",
  "arbiter_decision",
  "chat",
] as const;

export type TradeMessageType = (typeof TRADE_TYPES)[number];

/** Envelope + payload for a single message type, used to build a union. */
export interface TradeMessageOf<K extends TradeMessageType> {
  app: typeof TRADE_APP;
  v: number;
  type: K;
  orderId: string;
  role: TradeRole;
  from: string;
  ts: number;
  payload: TradePayloads[K];
}

/** A single trade message carried as the plaintext of a NIP-17 DM. */
export type TradeMessage = { [K in TradeMessageType]: TradeMessageOf<K> }[TradeMessageType];

/** A received DM paired with its decoded trade message, when it is one. */
export interface TradeDm {
  dm: DirectMessage;
  msg: TradeMessage | null;
}

/** Serialize a trade message to the DM content string. */
export function encodeTradeMessage<K extends TradeMessageType>(msg: TradeMessageOf<K>): string {
  return JSON.stringify(msg);
}

const HEX64 = /^[0-9a-f]{64}$/i;
const UINT = /^\d+$/;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalText(value: unknown, max = MAX_TEXT_LENGTH): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSpend(value: unknown): value is SerializedSpend {
  return (
    isRecord(value) &&
    isText(value.arkTx) &&
    Array.isArray(value.checkpoints) &&
    value.checkpoints.length > 0 &&
    value.checkpoints.every((checkpoint) => isText(checkpoint))
  );
}

function isAgreementShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isText(value.orderId, MAX_ID_LENGTH) &&
    isText(value.fiat, 16) &&
    isPositiveNumber(value.fiatAmount) &&
    isPositiveNumber(value.tradeSats) &&
    isHex64(value.buyerPubKey) &&
    isHex64(value.sellerPubKey) &&
    Array.isArray(value.arbiterPubKeys) &&
    value.arbiterPubKeys.length > 0 &&
    value.arbiterPubKeys.every(isHex64) &&
    isHex64(value.serverPubKey) &&
    value.escrowVersion === ESCROW_VERSION &&
    typeof value.refundLocktime === "string" &&
    UINT.test(value.refundLocktime)
  );
}

function isValidPayload(type: TradeMessageType, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  switch (type) {
    case "take":
      return payload.buyerArkAddress === undefined || isText(payload.buyerArkAddress, 256);
    case "taker_address":
      return isText(payload.arkAddress, 256);
    case "escrow":
      return (
        isAgreementShape(payload.agreement) &&
        isText(payload.address, 256) &&
        isText(payload.refundAddress, 256)
      );
    case "funded":
      return (
        isText(payload.txid, 128) &&
        Number.isSafeInteger(payload.vout) &&
        (payload.vout as number) >= 0 &&
        isPositiveNumber(payload.amount)
      );
    case "fiat_sent":
      return true;
    case "release_request":
      return isSpend(payload.spend) && isText(payload.to, 256) && isPositiveNumber(payload.sats);
    case "release_signed":
      return isSpend(payload.spend);
    case "release_done":
      return isText(payload.arkTxid, 256);
    case "cancel_request":
    case "cancel_agree":
      return isOptionalText(payload.reason, 500);
    case "ark_address":
      return (
        isText(payload.arkAddress, 256) &&
        (payload.agreement === undefined || isAgreementShape(payload.agreement))
      );
    case "ark_address_request":
      return isOptionalText(payload.reason, 500);
    case "dispute":
      return (
        isText(payload.reason, 500) &&
        isAgreementShape(payload.agreement) &&
        isText(payload.buyerArkAddress, 256) &&
        isText(payload.sellerArkAddress, 256)
      );
    case "dispute_taken":
      return isText(payload.orderId, MAX_ID_LENGTH) && isHex64(payload.solverPubKey);
    case "arbiter_decision":
      return (
        (payload.outcome === "release_to_buyer" || payload.outcome === "refund_to_seller") &&
        isText(payload.destination, 256) &&
        isPositiveNumber(payload.sats) &&
        isText(payload.arkTxid, 256) &&
        (payload.solverPubKey === undefined || isHex64(payload.solverPubKey))
      );
    case "chat":
      return isText(payload.text);
    default:
      return false;
  }
}

/** Parse a DM content string, returning `null` when it is not a valid trade message. */
export function decodeTradeMessage(content: string): TradeMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.app !== TRADE_APP) return null;
  if (data.v !== TRADE_VERSION) return null;
  if (typeof data.type !== "string") return null;
  if (!(TRADE_TYPES as readonly string[]).includes(data.type)) return null;
  const type = data.type as TradeMessageType;
  if (!isText(data.orderId, MAX_ID_LENGTH)) return null;
  if (data.role !== "buyer" && data.role !== "seller") return null;
  if (!isHex64(data.from)) return null;
  if (!isPositiveNumber(data.ts)) return null;
  if (!isValidPayload(type, data.payload)) return null;
  return data as unknown as TradeMessage;
}
