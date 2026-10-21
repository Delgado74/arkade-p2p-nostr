import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import type { Event, EventTemplate } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import {
  ORDER_KIND,
  parseOrder,
  type Order,
  type OrderStatus,
  type OrderType,
} from "./protocol";
import {
  DISPUTE_KIND,
  DISPUTE_TAKE_KIND,
  DISPUTE_RESOLUTION_KIND,
  SOLVERS_KIND,
  parseSolverRegistry,
  parseDisputeAnnounce,
  parseDisputeTake,
  parseDisputeResolution,
  type SolverRegistry,
  type DisputeAnnounce,
  type DisputeTake,
  type DisputeResolution,
} from "./protocol";
import type { Identity } from "./identity";

/** NIP-09 event kind used to request deletion of an order. */
export const DELETION_KIND = 5;

/**
 * Relays used when `VITE_RELAYS` is not set.
 *
 * A broad set matters: peers only exchange DMs over relays that BOTH can reach,
 * so a single dead relay must not silently cut a trade off. `relay.nostr.band`
 * was removed after repeated connection failures.
 */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://offchain.pub",
  "wss://nostr-pub.wellorder.net",
];

/** Read the relay list from `VITE_RELAYS`, falling back to defaults. */
export function relayList(): string[] {
  const raw = import.meta.env.VITE_RELAYS?.trim();
  if (!raw) return [...DEFAULT_RELAYS];
  const relays = raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return relays.length > 0 ? relays : [...DEFAULT_RELAYS];
}

export interface OrderFilter {
  type?: OrderType;
  fiat?: string;
  status?: OrderStatus | OrderStatus[];
  platform?: string;
  network?: string;
  layer?: string;
  authors?: string[];
  limit?: number;
}

/** Handle for a live order-book subscription. */
export interface OrderSubscription {
  close(): void;
}

/**
 * Thin Nostr client scoped to NIP-69 order events.
 *
 * Uses an ephemeral `SimplePool`; call {@link close} to tear down connections.
 */
export class NostrClient {
  readonly relays: string[];
  /** Shared connection pool (also used for NIP-17 DMs). */
  readonly pool: SimplePool;

  constructor(relays: string[] = relayList()) {
    this.relays = relays;
    this.pool = new SimplePool();
  }

  /** Sign and publish a template; succeeds if at least one relay accepts it. */
  async publish(template: EventTemplate, identity: Identity): Promise<Event> {
    const event = finalizeEvent(template, identity.secretKey);
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    if (accepted === 0) {
      throw new Error(`no relay accepted the event (${this.relays.join(", ")})`);
    }
    return event;
  }

  /** Query orders across all relays, de-duplicated to the latest version. */
  async fetchOrders(filter: OrderFilter = {}): Promise<Order[]> {
    const nostrFilter: Filter = {
      kinds: [ORDER_KIND],
      limit: filter.limit ?? 100,
    };
    if (filter.type) nostrFilter["#k"] = [filter.type];
    if (filter.fiat) nostrFilter["#f"] = [filter.fiat.toUpperCase()];
    if (filter.status) {
      nostrFilter["#s"] = Array.isArray(filter.status) ? filter.status : [filter.status];
    }
    if (filter.platform) nostrFilter["#y"] = [filter.platform];
    if (filter.authors && filter.authors.length > 0) nostrFilter.authors = filter.authors;
    // NOTE: `network` and `layer` are multi-letter tag names. Relays only index
    // single-letter tags for filters, so `#network`/`#layer` would match nothing;
    // they are applied client-side after parsing instead.

    const events = await this.pool.querySync(this.relays, nostrFilter);
    const latest = dedupeAddressable(events);
    const deleted = await this.fetchDeleted(latest);
    let orders = latest
      .filter(
        (event) =>
          !deleted.e.has(event.id) &&
          !deleted.a.has(`${event.kind}:${event.pubkey}:${dTag(event)}`),
      )
      .map(parseOrder)
      .filter((order): order is Order => order !== null);
    if (filter.network) orders = orders.filter((order) => order.network === filter.network);
    if (filter.layer) orders = orders.filter((order) => order.layer === filter.layer);
    return orders.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * NIP-09 deletions referencing the given orders, matching either the event id
   * (`e`, works on every relay) or the addressable reference (`a`, the canonical
   * form for addressable events).
   */
  private async fetchDeleted(latest: Event[]): Promise<{ e: Set<string>; a: Set<string> }> {
    const e = new Set<string>();
    const a = new Set<string>();
    if (latest.length === 0) return { e, a };

    const eIds = latest.map((event) => event.id);
    const addrRefs = latest.map((event) => `${event.kind}:${event.pubkey}:${dTag(event)}`);
    const [byE, byA] = await Promise.all([
      this.pool.querySync(this.relays, { kinds: [DELETION_KIND], "#e": eIds, limit: 500 }),
      this.pool.querySync(this.relays, { kinds: [DELETION_KIND], "#a": addrRefs, limit: 500 }),
    ]);

    for (const event of [...byE, ...byA]) {
      for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) e.add(tag[1]);
        if (tag[0] === "a" && tag[1]) a.add(tag[1]);
      }
    }
    return { e, a };
  }

  /**
   * Open a live subscription to order events so the book can update without a
   * manual reload (new orders appear, taken orders leave `pending`).
   *
   * Unlike {@link fetchOrders}, the `status` filter is intentionally NOT applied
   * relay-side: callers must observe an order moving out of `pending` (e.g. a
   * taker took it) to drop it from the book.
   */
  subscribeOrders(
    filter: OrderFilter,
    handlers: {
      onOrder: (order: Order, event: Event) => void;
      onEose?: () => void;
    },
  ): OrderSubscription {
    const nostrFilter: Filter = { kinds: [ORDER_KIND] };
    if (filter.type) nostrFilter["#k"] = [filter.type];
    if (filter.fiat) nostrFilter["#f"] = [filter.fiat.toUpperCase()];
    if (filter.platform) nostrFilter["#y"] = [filter.platform];
    if (filter.authors && filter.authors.length > 0) nostrFilter.authors = filter.authors;

    const subscription = this.pool.subscribeMany(this.relays, nostrFilter, {
      onevent: (event: Event) => {
        const order = parseOrder(event);
        if (order) handlers.onOrder(order, event);
      },
      oneose: handlers.onEose,
    });
    return { close: () => subscription.close() };
  }

  /** Fetch a single order by its addressable `d` id, optionally by author. */
  async fetchOrder(orderId: string, author?: string): Promise<Order | null> {
    const nostrFilter: Filter = { kinds: [ORDER_KIND], "#d": [orderId], limit: 1 };
    if (author) nostrFilter.authors = [author];
    const events = await this.pool.querySync(this.relays, nostrFilter);
    const current = dedupeAddressable(events)[0];
    return current ? parseOrder(current) : null;
  }

  /**
   * Republish one of our own addressable orders with a new lifecycle status.
   *
   * Only the maker can change an order (addressable events are keyed by
   * `(pubkey, kind, d)`), so this fetches our latest version of that `d` and
   * re-signs it with an updated `s` tag. No-ops when the order is not ours.
   *
   * @returns The republished event, or `null` if we do not own that order.
   */
  async setOrderStatus(
    identity: Identity,
    orderId: string,
    status: OrderStatus,
  ): Promise<Event | null> {
    const events = await this.pool.querySync(this.relays, {
      kinds: [ORDER_KIND],
      authors: [identity.pubkeyHex],
      "#d": [orderId],
      limit: 1,
    });
    const current = dedupeAddressable(events)[0];
    if (!current) return null;

    const tags = current.tags.map((t) => (t[0] === "s" ? ["s", status] : t));
    return this.publish(
      {
        kind: current.kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: current.content,
      },
      identity,
    );
  }

  /**
   * Delete one of our own orders via NIP-09. Publishes a kind-5 event carrying
   * both the addressable reference (`a`) and the concrete event id (`e`) so any
   * relay that honours deletions will drop it.
   *
   * @returns The deletion event, or throws if the order is not ours.
   */
  async deleteOrder(identity: Identity, orderId: string): Promise<Event> {
    const events = await this.pool.querySync(this.relays, {
      kinds: [ORDER_KIND],
      authors: [identity.pubkeyHex],
      "#d": [orderId],
      limit: 1,
    });
    const current = dedupeAddressable(events)[0];
    if (!current) {
      throw new Error("no encontramos esa orden entre tus órdenes");
    }
    const address = `${ORDER_KIND}:${identity.pubkeyHex}:${orderId}`;
    return this.publish(
      {
        kind: DELETION_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["a", address],
          ["e", current.id],
        ],
        content: "",
      },
      identity,
    );
  }

  close(): void {
    this.pool.close(this.relays);
  }

  /** Fetch solver registry published by coordinator (replaceable). */
  async fetchSolvers(coordinatorPubkey?: string): Promise<SolverRegistry | null> {
    const nostrFilter: Filter = {
      kinds: [SOLVERS_KIND],
      "#d": ["solvers"],
      limit: 1,
    };
    if (coordinatorPubkey) nostrFilter.authors = [coordinatorPubkey];
    const events = await this.pool.querySync(this.relays, nostrFilter);
    const current = dedupeAddressable(events)[0];
    return current ? parseSolverRegistry(current) : null;
  }

  /** Subscribe to solver registry updates. */
  subscribeSolvers(
    coordinatorPubkey: string,
    handlers: { onRegistry: (reg: SolverRegistry) => void; onEose?: () => void },
  ): OrderSubscription {
    const nostrFilter: Filter = { kinds: [SOLVERS_KIND], authors: [coordinatorPubkey], "#d": ["solvers"] };
    const subscription = this.pool.subscribeMany(this.relays, nostrFilter, {
      onevent: (event: Event) => {
        const reg = parseSolverRegistry(event);
        if (reg) handlers.onRegistry(reg);
      },
      oneose: handlers.onEose,
    });
    return { close: () => subscription.close() };
  }

  /** Subscribe to dispute announcements (38390) for a given order or globally. */
  subscribeDisputes(
    handlers: { onDispute: (d: DisputeAnnounce) => void; onEose?: () => void },
    opts?: { orderId?: string },
  ): OrderSubscription {
    const nostrFilter: Filter = { kinds: [DISPUTE_KIND] };
    if (opts?.orderId) nostrFilter["#d"] = [opts.orderId];
    const subscription = this.pool.subscribeMany(this.relays, nostrFilter, {
      onevent: (event: Event) => {
        const d = parseDisputeAnnounce(event);
        if (d) handlers.onDispute(d);
      },
      oneose: handlers.onEose,
    });
    return { close: () => subscription.close() };
  }

  /** Subscribe to dispute takes (38387). */
  subscribeDisputeTakes(
    handlers: { onTake: (t: DisputeTake) => void; onEose?: () => void },
    opts?: { orderId?: string },
  ): OrderSubscription {
    const nostrFilter: Filter = { kinds: [DISPUTE_TAKE_KIND] };
    if (opts?.orderId) {
      nostrFilter["#d"] = [opts.orderId];
      nostrFilter["#e"] = [opts.orderId];
    }
    const subscription = this.pool.subscribeMany(this.relays, nostrFilter, {
      onevent: (event: Event) => {
        const t = parseDisputeTake(event);
        if (t) handlers.onTake(t);
      },
      oneose: handlers.onEose,
    });
    return { close: () => subscription.close() };
  }

  /** Subscribe to dispute resolutions (38388). */
  subscribeDisputeResolutions(
    handlers: { onRes: (r: DisputeResolution) => void; onEose?: () => void },
    opts?: { orderId?: string },
  ): OrderSubscription {
    const nostrFilter: Filter = { kinds: [DISPUTE_RESOLUTION_KIND] };
    if (opts?.orderId) {
      nostrFilter["#d"] = [opts.orderId];
      nostrFilter["#e"] = [opts.orderId];
    }
    const subscription = this.pool.subscribeMany(this.relays, nostrFilter, {
      onevent: (event: Event) => {
        const r = parseDisputeResolution(event);
        if (r) handlers.onRes(r);
      },
      oneose: handlers.onEose,
    });
    return { close: () => subscription.close() };
  }
}

/** Read the addressable `d` tag value (empty string when absent). */
function dTag(event: Event): string {
  return event.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

/**
 * Addressable events (NIP-01) share `(pubkey, kind, d)`. Keep only the newest
 * `created_at` so a republished/edited order does not appear twice.
 */
export function dedupeAddressable(events: Event[]): Event[] {
  const latest = new Map<string, Event>();
  for (const event of events) {
    const d = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const key = `${event.kind}:${event.pubkey}:${d}`;
    const current = latest.get(key);
    if (!current || event.created_at > current.created_at) {
      latest.set(key, event);
    }
  }
  return [...latest.values()];
}
