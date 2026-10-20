import type { SerializedSpend } from "./escrow";
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
   * Absolute timelock (in blocks) of the escrow's `refund` leaf, as a string to
   * survive JSON. Both parties must agree on it so they derive the same script.
   * Absent on legacy agreements, in which case the default is used.
   */
  refundLocktime?: string;
}

/** Payload variants keyed by message type. */
export interface TradePayloads {
  /** Buyer announces the Ark address that should receive the released funds. */
  take: { buyerArkAddress: string };
  /** Concrete (private) fiat payment instructions. */
  payment_details: { methods: string[]; details: string };
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
   */
  ark_address: { agreement: EscrowAgreement; arkAddress: string };
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
  "payment_details",
  "escrow",
  "funded",
  "fiat_sent",
  "release_request",
  "release_signed",
  "release_done",
  "cancel_request",
  "cancel_agree",
  "ark_address",
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

/** Parse a DM content string, returning `null` when it is not a trade message. */
export function decodeTradeMessage(content: string): TradeMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const m = data as Partial<TradeMessageOf<TradeMessageType>>;
  if (m.app !== TRADE_APP) return null;
  if (typeof m.type !== "string") return null;
  if (!(TRADE_TYPES as readonly string[]).includes(m.type)) return null;
  return m as TradeMessage;
}
