import type { Event, EventTemplate } from "nostr-tools/pure";

/** NIP-69 peer-to-peer order event kind (addressable). */
export const ORDER_KIND = 38383;

/** What the maker does with bitcoin. */
export type OrderType = "buy" | "sell";

/** NIP-69 order lifecycle status. */
export type OrderStatus = "pending" | "canceled" | "in-progress" | "success" | "expired";

/** Platform tag value this client publishes. */
export const PLATFORM = "arkade-p2p";

/** Arkade is our settlement layer in the `layer` tag. */
export const LAYER = "arkade";

/**
 * A parsed NIP-69 order.
 *
 * `amountSats` is 0 for "market" orders where the sats amount is derived from a
 * public rate API when the taker accepts.
 */
export interface Order {
  id: string;
  maker: string;
  type: OrderType;
  fiat: string;
  status: OrderStatus;
  amountSats: number;
  fiatAmount: number;
  paymentMethods: string[];
  premium: number;
  network: string;
  layer: string;
  createdAt: number;
  expiresAt?: number;
  expiration?: number;
  name?: string;
  source?: string;
  bond?: number;
  geohash?: string;
  /** Maker's Ark address to receive a timeout/dispute refund (sell orders). */
  arkRefundAddress?: string;
  /** Buyer-maker's Ark address to receive the released sats (buy orders). */
  arkReceiveAddress?: string;
  platform: string;
  event: Event;
}

export interface OrderTemplate {
  type: OrderType;
  fiat: string;
  fiatAmount: number;
  /** Sats to trade; 0 means the amount is resolved from a rate API at take. */
  amountSats: number;
  /** Premium percentage over market (positive = above market). */
  premium: number;
  paymentMethods: string[];
  /** Unix seconds; after this the order should move to `expired`. */
  expiresAt: number;
  network?: string;
  layer?: string;
  platform?: string;
  name?: string;
  source?: string;
  bond?: number;
  geohash?: string;
  /** Maker's Ark refund address, published so takers/arbiters can refund them. */
  arkRefundAddress?: string;
  /** Buyer-maker's Ark receive address, published so the seller knows where to release. */
  arkReceiveAddress?: string;
}

function tag(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Generate a fresh addressable order id. */
export function newOrderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the unsigned NIP-69 order event template. */
export function buildOrderTemplate(template: OrderTemplate): EventTemplate {
  const id = newOrderId();
  const tags: string[][] = [
    ["d", id],
    ["k", template.type],
    ["f", template.fiat.toUpperCase()],
    ["s", "pending"],
    ["amt", String(Math.round(template.amountSats))],
    ["fa", String(template.fiatAmount)],
    ["premium", String(template.premium)],
    ["network", template.network ?? "mutinynet"],
    ["layer", template.layer ?? LAYER],
    ["expires_at", String(Math.floor(template.expiresAt))],
    ["y", template.platform ?? PLATFORM],
    ["z", "order"],
  ];

  const methods = template.paymentMethods.map((m) => m.trim()).filter(Boolean);
  if (methods.length > 0) tags.push(["pm", ...methods]);
  if (template.name) tags.push(["name", template.name]);
  if (template.source) tags.push(["source", template.source]);
  if (template.bond !== undefined) tags.push(["bond", String(template.bond)]);
  if (template.geohash) tags.push(["g", template.geohash]);
  if (template.arkRefundAddress) tags.push(["ark_refund", template.arkRefundAddress]);
  if (template.arkReceiveAddress) tags.push(["ark_receive", template.arkReceiveAddress]);

  return { kind: ORDER_KIND, created_at: Math.floor(Date.now() / 1000), tags, content: "" };
}

/** Parse a NIP-69 order event; returns null when mandatory tags are missing. */
export function parseOrder(event: Event): Order | null {
  if (event.kind !== ORDER_KIND) return null;

  const id = tag(event, "d");
  const type = tag(event, "k");
  const fiat = tag(event, "f");
  const status = tag(event, "s");
  const amountSats = num(tag(event, "amt"));
  const fiatAmount = num(tag(event, "fa"));
  const premium = num(tag(event, "premium"));
  const network = tag(event, "network");
  const layer = tag(event, "layer");

  if (
    !id ||
    (type !== "buy" && type !== "sell") ||
    !fiat ||
    !status ||
    amountSats === undefined ||
    fiatAmount === undefined ||
    premium === undefined ||
    !network ||
    !layer
  ) {
    return null;
  }

  const paymentMethods = event.tags
    .filter((t) => t[0] === "pm")
    .flatMap((t) => t.slice(1))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    id,
    maker: event.pubkey,
    type,
    fiat: fiat.toUpperCase(),
    status: status as OrderStatus,
    amountSats,
    fiatAmount,
    paymentMethods,
    premium,
    network,
    layer,
    createdAt: event.created_at,
    expiresAt: num(tag(event, "expires_at")),
    expiration: num(tag(event, "expiration")),
    name: tag(event, "name"),
    source: tag(event, "source"),
    bond: num(tag(event, "bond")),
    geohash: tag(event, "g"),
    arkRefundAddress: tag(event, "ark_refund"),
    arkReceiveAddress: tag(event, "ark_receive"),
    platform: tag(event, "y") ?? "unknown",
    event,
  };
}

/** True when an order has passed its `expires_at` and is still pending. */
export function isExpired(order: Order, now = Date.now() / 1000): boolean {
  if (order.status !== "pending") return false;
  if (order.expiresAt === undefined) return false;
  return order.expiresAt < now;
}

/** NIP-33-style replaceable events for disputes (multi-solver). */
export const DISPUTE_KIND = 38386;
export const DISPUTE_TAKE_KIND = 38387;
export const DISPUTE_RESOLUTION_KIND = 38388;

/** Solver registry: replaceable event published by coordinator (`d = "solvers"`). */
export const SOLVERS_KIND = 38389;

export interface SolverRegistry {
  id: string;
  pubkey: string;
  solvers: string[]; // hex pubkeys
  createdAt: number;
  event: Event;
}

export function parseSolverRegistry(event: Event): SolverRegistry | null {
  if (event.kind !== SOLVERS_KIND) return null;
  const d = tag(event, "d");
  if (d !== "solvers") return null;
  const solvers = event.tags
    .filter((t) => t[0] === "s")
    .map((t) => t[1])
    .filter((v) => typeof v === "string" && v.length > 0);
  return {
    id: d,
    pubkey: event.pubkey,
    solvers,
    createdAt: event.created_at,
    event,
  };
}

export type DisputeStatus = "initiated" | "in-progress" | "settled" | "refunded" | "canceled";

export interface DisputeAnnounce {
  id: string; // d = orderId
  pubkey: string;
  orderId: string;
  status: DisputeStatus;
  initiator: string; // hex pubkey
  reason?: string;
  createdAt: number;
  event: Event;
}

export function parseDisputeAnnounce(event: Event): DisputeAnnounce | null {
  if (event.kind !== DISPUTE_KIND) return null;
  const d = tag(event, "d");
  const status = tag(event, "s");
  const initiator = tag(event, "initiator");
  if (!d || !status || !initiator) return null;
  return {
    id: d,
    pubkey: event.pubkey,
    orderId: d,
    status: status as DisputeStatus,
    initiator,
    createdAt: event.created_at,
    event,
  };
}

export interface DisputeTake {
  id: string;
  pubkey: string;
  orderId: string;
  solverPubKey: string; // hex
  createdAt: number;
  event: Event;
}

export function parseDisputeTake(event: Event): DisputeTake | null {
  if (event.kind !== DISPUTE_TAKE_KIND) return null;
  const d = tag(event, "d");
  const solver = tag(event, "solver");
  const e = event.tags.find((t) => t[0] === "e")?.[1];
  const orderId = d || e;
  if (!orderId || !solver) return null;
  return {
    id: orderId,
    pubkey: event.pubkey,
    orderId,
    solverPubKey: solver,
    createdAt: event.created_at,
    event,
  };
}

export interface DisputeResolution {
  id: string;
  pubkey: string;
  orderId: string;
  status: DisputeStatus;
  solverPubKey: string;
  arkTxid?: string;
  createdAt: number;
  event: Event;
}

export function parseDisputeResolution(event: Event): DisputeResolution | null {
  if (event.kind !== DISPUTE_RESOLUTION_KIND) return null;
  const d = tag(event, "d");
  const e = event.tags.find((t) => t[0] === "e")?.[1];
  const status = tag(event, "s");
  const solver = tag(event, "solver");
  const ark = tag(event, "ark_txid");
  const orderId = d || e;
  if (!orderId || !status || !solver) return null;
  return {
    id: orderId,
    pubkey: event.pubkey,
    orderId,
    status: status as DisputeStatus,
    solverPubKey: solver,
    arkTxid: ark,
    createdAt: event.created_at,
    event,
  };
}
