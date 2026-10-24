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
  platform: string;
  /**
   * Ark address declared by the maker: its payout address when the maker is
   * the buyer, its refund address when the maker is the seller. It is
   * mandatory for both kinds of order.
   */
  arkAddress?: string;
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
  /** Ark address of the maker: payout when it buys, refund when it sells. */
  arkAddress?: string;
}

function tag(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** True when the event declares our platform in the NIP-69 `y` tag. */
function isOurPlatform(event: Event): boolean {
  return event.tags.some((t) => t[0] === "y" && t.slice(1).includes(PLATFORM));
}

/** True when the event carries the expected `z` discriminator. */
function hasZ(event: Event, value: string): boolean {
  return event.tags.some((t) => t[0] === "z" && t[1] === value);
}

/** Nostr public keys are 32-byte hex; roles like `buyer`/`seller` are not. */
function isHex64(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
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
  if (template.arkAddress) tags.push(["ark", template.arkAddress]);
  if (template.name) tags.push(["name", template.name]);
  if (template.source) tags.push(["source", template.source]);
  if (template.bond !== undefined) tags.push(["bond", String(template.bond)]);
  if (template.geohash) tags.push(["g", template.geohash]);

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
    platform: tag(event, "y") ?? "unknown",
    arkAddress: tag(event, "ark"),
    event,
  };
}

/** True when an order has passed its `expires_at` and is still pending. */
export function isExpired(order: Order, now = Date.now() / 1000): boolean {
  if (order.status !== "pending") return false;
  if (order.expiresAt === undefined) return false;
  return order.expiresAt < now;
}

/**
 * NIP-33-style replaceable events for disputes (multi-solver).
 *
 * `38386` is taken by Mostro's dispute events, which also carry `d`, `s` and
 * `initiator`; publishing there makes our events indistinguishable to their
 * tooling and theirs indistinguishable to ours. We use `38390` instead and
 * keep `y = arkade-p2p` as the discriminator on every dispute event.
 */
export const DISPUTE_KIND = 38390;
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
  if (!isOurPlatform(event) || !hasZ(event, "dispute")) return null;
  const d = tag(event, "d");
  const status = tag(event, "s");
  const initiator = tag(event, "initiator");
  if (!d || !status || !isHex64(initiator)) return null;
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
  if (!isOurPlatform(event) || !hasZ(event, "dispute-take")) return null;
  const d = tag(event, "d");
  const solver = tag(event, "solver");
  const e = event.tags.find((t) => t[0] === "e")?.[1];
  const orderId = d || e;
  if (!orderId || !isHex64(solver)) return null;
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
  if (!isOurPlatform(event) || !hasZ(event, "dispute-resolution")) return null;
  const d = tag(event, "d");
  const e = event.tags.find((t) => t[0] === "e")?.[1];
  const status = tag(event, "s");
  const solver = tag(event, "solver");
  const ark = tag(event, "ark_txid");
  const orderId = d || e;
  if (!orderId || !status || !isHex64(solver)) return null;
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

/** Build the public dispute announcement (tags only, no agreement). */
export function buildDisputeAnnounceTemplate(
  orderId: string,
  initiator: string,
  reason: string,
): EventTemplate {
  return {
    kind: DISPUTE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", orderId],
      ["e", orderId],
      ["z", "dispute"],
      ["y", PLATFORM],
      ["s", "initiated"],
      ["initiator", initiator],
      ["reason", reason.slice(0, 500)],
    ],
    content: "",
  };
}

/** Build a solver's optimistic take of a dispute. Earliest created_at wins. */
export function buildDisputeTakeTemplate(orderId: string, solverPubKey: string): EventTemplate {
  return {
    kind: DISPUTE_TAKE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", orderId],
      ["e", orderId],
      ["z", "dispute-take"],
      ["y", PLATFORM],
      ["s", "in-progress"],
      ["solver", solverPubKey],
    ],
    content: "",
  };
}

/** Build the solver's resolution event (settled/refunded) for a dispute. */
export function buildDisputeResolutionTemplate(
  orderId: string,
  solverPubKey: string,
  status: "settled" | "refunded",
  arkTxid?: string,
): EventTemplate {
  const tags: string[][] = [
    ["d", orderId],
    ["e", orderId],
    ["z", "dispute-resolution"],
    ["y", PLATFORM],
    ["s", status],
    ["solver", solverPubKey],
  ];
  if (arkTxid) tags.push(["ark_txid", arkTxid]);
  return { kind: DISPUTE_RESOLUTION_KIND, created_at: Math.floor(Date.now() / 1000), tags, content: "" };
}

/**
 * Deterministic winner among take events for a dispute: earliest `created_at`,
 * ties broken by lowest event id. Returns the winning take or null.
 */
export function pickDisputeTakeTaker(takes: DisputeTake[]): DisputeTake | null {
  if (takes.length === 0) return null;
  return [...takes].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.event.id < b.event.id ? -1 : 1;
  })[0];
}

/* ------------------------------------------------------------------ */
/* Reputation (peer ratings)                                          */
/* ------------------------------------------------------------------ */

/**
 * Addressable reputation event kind (same as Mostro's `NOSTR_RATING_EVENT_KIND`).
 *
 * Unlike Mostro, which publishes an *aggregate* snapshot signed by the central
 * daemon, we publish one *individual* rating per (rater, order) signed by the
 * rater. Viewers aggregate locally: a pubkey's reputation is the average and
 * count of the ratings it has received. Because there is no daemon, all
 * verification is reconstructed from public events (see `lib/reputation.ts`).
 */
export const RATING_KIND = 38384;

/** Lowest star value a rater may leave. */
export const RATING_MIN = 1;
/** Highest star value a rater may leave. */
export const RATING_MAX = 5;

/** A parsed peer rating. */
export interface Rating {
  /** The pubkey being rated. */
  ratee: string;
  /** The pubkey that left the rating. */
  rater: string;
  /** Star value, clamped to `[RATING_MIN, RATING_MAX]`. */
  value: number;
  /** Which side of the trade the *rater* was on. */
  role: "buyer" | "seller";
  /** The order this rating refers to (`d`/`e`). */
  orderId: string;
  createdAt: number;
  event: Event;
}

/** True when `value` is an integer within the allowed star range. */
export function isValidRatingValue(value: number): boolean {
  return Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/**
 * Addressable `d` tag for a rating: one rating per (rater, order). `ratee`
 * is included so both parties can rate the same order without colliding.
 */
export function ratingKey(orderId: string, ratee: string): string {
  return `${orderId}:${ratee}`;
}

/** Build the template for leaving a 1-5 star rating on a finished trade. */
export function buildRatingTemplate(params: {
  orderId: string;
  orderEventId: string;
  ratee: string;
  value: number;
  role: "buyer" | "seller";
}): EventTemplate {
  if (!isValidRatingValue(params.value)) {
    throw new Error(`rating fuera de rango: ${params.value}`);
  }
  return {
    kind: RATING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", ratingKey(params.orderId, params.ratee)],
      ["e", params.orderEventId],
      ["p", params.ratee],
      ["rating", String(params.value)],
      ["role", params.role],
      ["y", PLATFORM],
      ["z", "rating"],
    ],
    content: "",
  };
}

/** Parse a reputation event, returning null when it is malformed. */
export function parseRating(event: Event): Rating | null {
  if (event.kind !== RATING_KIND) return null;
  const ratee = tag(event, "p");
  // `d` is `<orderId>:<ratee>` (see `ratingKey`); keep only the order id.
  const orderId = tag(event, "d")?.split(":")[0];
  const ratingRaw = tag(event, "rating");
  const roleRaw = tag(event, "role");
  if (!ratee || !orderId || !ratingRaw) return null;
  if (roleRaw !== "buyer" && roleRaw !== "seller") return null;
  const value = Number(ratingRaw);
  if (!isValidRatingValue(value)) return null;
  return {
    ratee: ratee.toLowerCase(),
    rater: event.pubkey.toLowerCase(),
    value,
    role: roleRaw,
    orderId,
    createdAt: event.created_at,
    event,
  };
}
