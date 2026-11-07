import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools/pure";
import {
  DISPUTE_KIND,
  DISPUTE_RESOLUTION_KIND,
  DISPUTE_TAKE_KIND,
  PLATFORM,
  buildDisputeTakeTemplate,
  latestDisputeAnnounce,
  parseDisputeAnnounce,
  parseDisputeResolution,
  parseDisputeTake,
  parseOrder,
  parseRating,
  validDisputeResolutions,
  validDisputeTakes,
  type DisputeAnnounce,
  type DisputeTake,
} from "./protocol";

const HEX = (n: number) => n.toString(16).padStart(64, "0");
const BUYER = HEX(0xb1);
const SELLER = HEX(0x5e);
const SOLVER = HEX(0x50);
const OTHER = HEX(0x99);

function event(overrides: Partial<Event> & Pick<Event, "kind" | "pubkey" | "tags">): Event {
  return {
    id: HEX(1),
    created_at: 1_700_000_000,
    content: "",
    sig: "0".repeat(128),
    ...overrides,
  };
}

function orderEvent(overrides: Partial<Event> = {}): Event {
  return event({
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
    ...overrides,
  });
}

function announce(overrides: Partial<DisputeAnnounce> = {}): DisputeAnnounce {
  return {
    id: "order-1",
    pubkey: BUYER,
    orderId: "order-1",
    status: "initiated",
    initiator: BUYER,
    reason: "no pagó",
    createdAt: 1_700_000_010,
    event: event({
      id: HEX(10),
      kind: DISPUTE_KIND,
      pubkey: BUYER,
      created_at: 1_700_000_010,
      tags: [
        ["d", "order-1"],
        ["e", "order-1"],
        ["z", "dispute"],
        ["y", PLATFORM],
        ["s", "initiated"],
        ["initiator", BUYER],
      ],
    }),
    ...overrides,
  };
}

function take(overrides: Partial<DisputeTake> = {}): DisputeTake {
  return {
    id: "order-1",
    pubkey: SOLVER,
    orderId: "order-1",
    announceEventId: HEX(10),
    solverPubKey: SOLVER,
    createdAt: 1_700_000_020,
    event: event({
      id: HEX(20),
      kind: DISPUTE_TAKE_KIND,
      pubkey: SOLVER,
      created_at: 1_700_000_020,
      tags: [
        ["d", "order-1"],
        ["e", HEX(10)],
        ["z", "dispute-take"],
        ["y", PLATFORM],
        ["solver", SOLVER],
      ],
    }),
    ...overrides,
  };
}

describe("parseOrder runtime validation", () => {
  it("accepts a well-formed order", () => {
    expect(parseOrder(orderEvent())?.id).toBe("order-1");
  });

  it("rejects negative or non-integer sats", () => {
    expect(parseOrder(orderEvent({ tags: [...orderEvent().tags.filter((t) => t[0] !== "amt"), ["amt", "-1"]] }))).toBeNull();
    expect(parseOrder(orderEvent({ tags: [...orderEvent().tags.filter((t) => t[0] !== "amt"), ["amt", "1.5"]] }))).toBeNull();
  });

  it("rejects an unknown lifecycle status", () => {
    const tags = orderEvent().tags.map((t) => (t[0] === "s" ? ["s", "paid"] : t));
    expect(parseOrder(orderEvent({ tags }))).toBeNull();
  });

  it("rejects malformed authors and fiat codes", () => {
    expect(parseOrder(orderEvent({ pubkey: "not-a-key" }))).toBeNull();
    const tags = orderEvent().tags.map((t) => (t[0] === "f" ? ["f", "U$D"] : t));
    expect(parseOrder(orderEvent({ tags }))).toBeNull();
  });
});

describe("dispute announce, take and resolution binding", () => {
  it("requires the announcement to be signed by its initiator", () => {
    const forged = announce().event;
    expect(parseDisputeAnnounce({ ...forged, pubkey: OTHER })).toBeNull();
  });

  it("parses a take only when the solver tag matches the author", () => {
    const valid = take().event;
    expect(parseDisputeTake(valid)?.announceEventId).toBe(HEX(10));
    const forged = { ...valid, tags: valid.tags.map((t) => (t[0] === "solver" ? ["solver", OTHER] : t)) };
    expect(parseDisputeTake(forged)).toBeNull();
  });

  it("rejects legacy takes that point e at the order id", () => {
    const legacy = take().event;
    expect(
      parseDisputeTake({
        ...legacy,
        tags: legacy.tags.map((t) => (t[0] === "e" ? ["e", "order-1"] : t)),
      }),
    ).toBeNull();
  });

  it("filters takes by announcement and trusted solver set", () => {
    const announce1 = announce();
    const good = take();
    const wrongAnnounce = take({ announceEventId: HEX(11) });
    const untrusted = take({ solverPubKey: OTHER, event: { ...take().event, pubkey: OTHER } });
    expect(validDisputeTakes([good, wrongAnnounce, untrusted], [announce1], [SOLVER])).toEqual([good]);
    expect(validDisputeTakes([good], [announce1], [OTHER])).toEqual([]);
    const newer = announce({
      createdAt: 1_700_000_011,
      event: { ...announce().event, id: HEX(11) },
    });
    expect(validDisputeTakes([good], [announce1, newer], [SOLVER])).toEqual([]);
  });

  it("builds a take bound to the announcement event id", () => {
    const template = buildDisputeTakeTemplate("order-1", SOLVER, HEX(10));
    expect(template.tags).toContainEqual(["e", HEX(10)]);
  });

  it("only accepts a resolution from the winning solver of the same announcement", () => {
    const announce1 = announce();
    const winner = take();
    const resolution = {
      id: "order-1",
      pubkey: SOLVER,
      orderId: "order-1",
      announceEventId: HEX(10),
      status: "settled" as const,
      solverPubKey: SOLVER,
      createdAt: 1_700_000_030,
      event: event({
        id: HEX(30),
        kind: DISPUTE_RESOLUTION_KIND,
        pubkey: SOLVER,
        created_at: 1_700_000_030,
        tags: [
          ["d", "order-1"],
          ["e", HEX(10)],
          ["z", "dispute-resolution"],
          ["y", PLATFORM],
          ["s", "settled"],
          ["solver", SOLVER],
        ],
      }),
    };
    expect(parseDisputeResolution(resolution.event)?.announceEventId).toBe(HEX(10));
    expect(validDisputeResolutions([resolution], [announce1], [winner], [SOLVER])).toEqual([resolution]);
    expect(validDisputeResolutions([resolution], [announce1], [], [SOLVER])).toEqual([]);
    expect(validDisputeResolutions([resolution], [announce1], [winner], [OTHER])).toEqual([]);
  });

  it("picks the newest announcement per order", () => {
    const older = announce({ createdAt: 1 });
    const newer = announce({ createdAt: 2, event: { ...announce().event, id: HEX(12) } });
    expect(latestDisputeAnnounce([older, newer], "order-1")?.event.id).toBe(HEX(12));
  });
});

describe("parseRating runtime validation", () => {
  function ratingEvent(overrides: Partial<Event> = {}): Event {
    return event({
      kind: 38384,
      pubkey: BUYER,
      tags: [
        ["d", `order-1:${SELLER}`],
        ["e", orderEvent().id],
        ["p", SELLER],
        ["rating", "5"],
        ["role", "buyer"],
        ["y", PLATFORM],
        ["z", "rating"],
      ],
      ...overrides,
    });
  }

  it("accepts a well-formed rating", () => {
    expect(parseRating(ratingEvent())?.orderId).toBe("order-1");
  });

  it("rejects missing platform tags, bad d binding and non-hex ratees", () => {
    expect(parseRating(ratingEvent({ tags: ratingEvent().tags.filter((t) => t[0] !== "z") }))).toBeNull();
    expect(
      parseRating(ratingEvent({ tags: ratingEvent().tags.map((t) => (t[0] === "d" ? ["d", "other"] : t)) })),
    ).toBeNull();
    expect(
      parseRating(ratingEvent({ tags: ratingEvent().tags.map((t) => (t[0] === "p" ? ["p", "nope"] : t)) })),
    ).toBeNull();
  });
});
