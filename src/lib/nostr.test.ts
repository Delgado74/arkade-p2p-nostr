import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools/pure";
import { DELETION_KIND, deletionRefsFor } from "./nostr";

const HEX = (n: number) => n.toString(16).padStart(64, "0");
const AUTHOR = HEX(1);
const OTHER = HEX(2);

function ev(overrides: Partial<Event> & Pick<Event, "kind" | "pubkey" | "tags">): Event {
  return {
    id: HEX(9),
    created_at: 1_000,
    content: "",
    sig: "0".repeat(128),
    ...overrides,
  };
}

const order = ev({
  id: HEX(10),
  kind: 38383,
  pubkey: AUTHOR,
  created_at: 1_000,
  tags: [
    ["d", "order-1"],
    ["k", "sell"],
  ],
});

function deletion(pubkey: string, createdAt: number, tags: string[][]): Event {
  return ev({
    id: HEX(20 + createdAt),
    kind: DELETION_KIND,
    pubkey,
    created_at: createdAt,
    tags,
  });
}

describe("NIP-09 deletion author check", () => {
  it("applies an e-tag deletion signed by the order author", () => {
    const refs = deletionRefsFor([order], [deletion(AUTHOR, 2_000, [["e", order.id]])]);
    expect(refs.e.has(order.id)).toBe(true);
  });

  it("applies an address-tag deletion signed by the order author", () => {
    const address = `38383:${AUTHOR}:order-1`;
    const refs = deletionRefsFor([order], [deletion(AUTHOR, 2_000, [["a", address]])]);
    expect(refs.a.has(address)).toBe(true);
  });

  it("ignores a deletion signed by another key", () => {
    const refs = deletionRefsFor([order], [deletion(OTHER, 2_000, [["e", order.id]])]);
    expect(refs.e.size).toBe(0);
  });

  it("ignores a deletion created before the order", () => {
    const refs = deletionRefsFor([order], [deletion(AUTHOR, 500, [["e", order.id]])]);
    expect(refs.e.size).toBe(0);
  });

  it("ignores tags that do not reference a known order", () => {
    const refs = deletionRefsFor(
      [order],
      [deletion(AUTHOR, 2_000, [["e", HEX(999)], ["a", `38383:${AUTHOR}:other`]])],
    );
    expect(refs.e.size).toBe(0);
    expect(refs.a.size).toBe(0);
  });
});
