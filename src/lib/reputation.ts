import type { NostrClient } from "./nostr";
import { parseOrder, RATING_MAX, type Order, type Rating } from "./protocol";

/**
 * Aggregated reputation for a single pubkey, computed locally from the ratings
 * it has received.
 *
 * There is no central daemon (unlike Mostro), so a viewer reconstructs
 * reputation from public events and verifies each rating against the order it
 * references. See `verifiedRatings` for the exact acceptance rules.
 */
export interface Reputation {
  /** Average star value over accepted ratings, rounded to 2 decimals. */
  average: number;
  /** Number of accepted ratings. */
  count: number;
  /** Lowest accepted rating, or 0 when there are none. */
  min: number;
  /** Highest accepted rating, or 0 when there are none. */
  max: number;
  /** Most recent accepted rating, or 0 when there are none. */
  last: number;
}

/** A reputation with no reviews yet. */
export const EMPTY_REPUTATION: Reputation = { average: 0, count: 0, min: 0, max: 0, last: 0 };

/** Only a successfully completed trade can produce reputation. */
const FINISHED_STATUSES = new Set(["success"]);

/**
 * Decide whether a rating should be counted, given the order it references.
 *
 * Because order takes happen over private DMs, a viewer can only prove the
 * *maker* publicly. We therefore accept a rating when it clears every check we
 * can reconstruct from public data:
 *
 *  1. The referenced order event exists, parses as a NIP-69 order and its
 *     status is `success` — only completed trades create reputation.
 *  2. The rating's `d`/`e`/`y`/`z` tags are well-formed and bound to that exact
 *     order (enforced by `parseRating` and the order id check below).
 *  3. The rater and ratee are different keys.
 *  4. One side is the maker and the other is the taker, and the declared
 *     `role` matches the side the rater actually played. The taker cannot be
 *     proven from public data, so this remains a signed self-declaration; it
 *     no longer permits self-rating, role spoofing or ratings on canceled
 *     orders.
 */
export function isRatingAcceptable(rating: Rating, order: Order | null): boolean {
  if (!order) return false;
  if (order.id !== rating.orderId) return false;
  if (rating.createdAt < order.createdAt) return false;
  if (!FINISHED_STATUSES.has(order.status)) return false;
  const maker = order.maker.toLowerCase();
  const ratee = rating.ratee.toLowerCase();
  const rater = rating.rater.toLowerCase();
  if (rater === ratee) return false;
  const makerRole: "buyer" | "seller" = order.type === "sell" ? "seller" : "buyer";
  const takerRole: "buyer" | "seller" = makerRole === "buyer" ? "seller" : "buyer";
  if (rater === maker) {
    return ratee !== maker && rating.role === makerRole;
  }
  if (ratee === maker) {
    return rater !== maker && rating.role === takerRole;
  }
  return false;
}

/**
 * Verify a list of received ratings against their referenced orders, keeping
 * only the acceptable ones. Orders are fetched once and cached by event id.
 */
export async function verifiedRatings(
  client: NostrClient,
  ratings: Rating[],
): Promise<Rating[]> {
  const cache = new Map<string, Order | null>();
  const accepted: Rating[] = [];
  for (const rating of ratings) {
    const orderEventId = eventIdOf(rating);
    if (!orderEventId) continue;
    let order = cache.get(orderEventId);
    if (order === undefined) {
      try {
        const event = await client.fetchOrderEventById(orderEventId);
        order = event ? parseOrder(event) : null;
      } catch {
        order = null;
      }
      cache.set(orderEventId, order);
    }
    if (!order) {
      // Fail closed: without the referenced order we cannot prove that a real
      // trade finished, so the rating does not count.
      continue;
    }
    if (order.event.id === orderEventId && isRatingAcceptable(rating, order)) {
      accepted.push(rating);
    }
  }
  return accepted;
}

/** The order event id a rating points at via its `e` tag. */
function eventIdOf(rating: Rating): string | null {
  const e = rating.event.tags.find((t) => t[0] === "e")?.[1];
  return e ?? null;
}

/** Fold a list of (already verified) ratings into a `Reputation`. */
export function aggregate(ratings: Rating[]): Reputation {
  if (ratings.length === 0) return EMPTY_REPUTATION;
  let sum = 0;
  let min = RATING_MAX;
  let max = 0;
  let last = 0;
  for (const r of ratings) {
    sum += r.value;
    if (r.value < min) min = r.value;
    if (r.value > max) max = r.value;
    if (r.createdAt > last) last = r.createdAt;
  }
  return {
    average: Math.round((sum / ratings.length) * 100) / 100,
    count: ratings.length,
    min,
    max,
    last,
  };
}

/**
 * Fetch and aggregate the reputation of a pubkey. `ratings` is fetched by
 * `#p`, verified against the referenced orders, then folded into aggregates.
 */
export async function loadReputation(
  client: NostrClient,
  pubkey: string,
): Promise<Reputation> {
  const received = await client.fetchRatingsReceived(pubkey);
  const accepted = await verifiedRatings(client, received);
  return aggregate(accepted);
}
