import { describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/pure";
import { PLATFORM, parseOrder, parseRating } from "./protocol";
import { isRatingAcceptable, verifiedRatings } from "./reputation";
import type { NostrClient } from "./nostr";

const HEX = (n: number) => n.toString(16).padStart(64, "0");
const BUYER = HEX(0xb1);
const SELLER = HEX(0x5e);

function event(overrides: Partial<Event> & Pick<Event, "id" | "kind" | "pubkey" | "tags">): Event {
  return {
    created_at: 1_700_000_000,
    content: "",
    sig: "0".repeat(128),
    ...overrides,
  };
}

const orderEvent = event({
  id: HEX(1),
  kind: 38383,
  pubkey: SELLER,
  tags: [
    ["d", "order-1"],
    ["k", "sell"],
    ["f", "USD"],
    ["s", "success"],
    ["amt", "10000"],
    ["fa", "25"],
    ["premium", "0"],
    ["network", "mutinynet"],
    ["layer", "arkade"],
    ["y", PLATFORM],
  ],
});

function ratingEvent(params: {
  rater: string;
  ratee: string;
  role: "buyer" | "seller";
  orderId?: string;
  eventId?: string;
  contentOrderId?: string;
}): Event {
  const orderId = params.orderId ?? "order-1";
  return event({
    id: HEX(2),
    kind: 38384,
    pubkey: params.rater,
    created_at: 1_700_000_100,
    tags: [
      ["d", `${params.contentOrderId ?? orderId}:${params.ratee}`],
      ["e", params.eventId ?? orderEvent.id],
      ["p", params.ratee],
      ["rating", "5"],
      ["role", params.role],
      ["y", PLATFORM],
      ["z", "rating"],
    ],
  });
}

describe("rating acceptance", () => {
  const order = parseOrder(orderEvent);

  it("accepts the taker rating the maker", () => {
    const rating = parseRating(ratingEvent({ rater: BUYER, ratee: SELLER, role: "buyer" }));
    expect(rating && isRatingAcceptable(rating, order)).toBe(true);
  });

  it("accepts the maker rating the taker", () => {
    const rating = parseRating(ratingEvent({ rater: SELLER, ratee: BUYER, role: "seller" }));
    expect(rating && isRatingAcceptable(rating, order)).toBe(true);
  });

  it("rejects self-rating", () => {
    const rating = parseRating(ratingEvent({ rater: SELLER, ratee: SELLER, role: "seller" }));
    expect(rating && isRatingAcceptable(rating, order)).toBe(false);
  });

  it("rejects a role that does not match the rater's side", () => {
    const rating = parseRating(ratingEvent({ rater: BUYER, ratee: SELLER, role: "seller" }));
    expect(rating && isRatingAcceptable(rating, order)).toBe(false);
  });

  it("rejects ratings on canceled orders", () => {
    const canceled = parseOrder({
      ...orderEvent,
      tags: orderEvent.tags.map((t) => (t[0] === "s" ? ["s", "canceled"] : t)),
    });
    const rating = parseRating(ratingEvent({ rater: BUYER, ratee: SELLER, role: "buyer" }));
    expect(rating && isRatingAcceptable(rating, canceled)).toBe(false);
  });

  it("rejects a rating bound to another order id", () => {
    const rating = parseRating(
      ratingEvent({ rater: BUYER, ratee: SELLER, role: "buyer", contentOrderId: "order-2" }),
    );
    expect(rating && isRatingAcceptable(rating, order)).toBe(false);
  });
});

describe("verifiedRatings", () => {
  it("fails closed when the referenced order cannot be fetched", async () => {
    const rating = parseRating(ratingEvent({ rater: BUYER, ratee: SELLER, role: "buyer" }));
    if (!rating) throw new Error("fixture did not parse");
    const client = { fetchOrderEventById: vi.fn().mockResolvedValue(null) } as unknown as NostrClient;
    expect(await verifiedRatings(client, [rating])).toEqual([]);
  });

  it("drops a rating whose event id does not match the fetched order", async () => {
    const rating = parseRating(ratingEvent({ rater: BUYER, ratee: SELLER, role: "buyer" }));
    if (!rating) throw new Error("fixture did not parse");
    const client = {
      fetchOrderEventById: vi.fn().mockResolvedValue({ ...orderEvent, id: HEX(9) }),
    } as unknown as NostrClient;
    expect(await verifiedRatings(client, [rating])).toEqual([]);
  });

  it("keeps a rating tied to a real successful order", async () => {
    const rating = parseRating(ratingEvent({ rater: BUYER, ratee: SELLER, role: "buyer" }));
    if (!rating) throw new Error("fixture did not parse");
    const client = {
      fetchOrderEventById: vi.fn().mockResolvedValue(orderEvent),
    } as unknown as NostrClient;
    expect(await verifiedRatings(client, [rating])).toEqual([rating]);
  });
});
