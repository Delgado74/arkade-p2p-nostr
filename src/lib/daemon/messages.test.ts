import { describe, expect, it } from "vitest";
import {
  loadStoredDms,
  storedMessagesToDms,
  type MessagesRpc,
  type StoredDmMessage,
} from "./messages";

function row(overrides: Partial<StoredDmMessage> = {}): StoredDmMessage {
  return {
    id: "m1",
    type: "dm",
    outgoing: false,
    createdAt: 10,
    receivedAt: 11,
    payloadJson: JSON.stringify({
      sender: "a".repeat(64),
      recipients: ["b".repeat(64)],
      content: "hola",
      createdAt: 10,
    }),
    ...overrides,
  };
}

describe("storedMessagesToDms", () => {
  it("rebuilds a DM from its persisted rumor", () => {
    const dms = storedMessagesToDms([row()]);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      id: "m1",
      sender: "a".repeat(64),
      recipients: ["b".repeat(64)],
      content: "hola",
      createdAt: 10,
      outgoing: false,
    });
  });

  it("ignores non-DM rows and malformed payloads", () => {
    const dms = storedMessagesToDms([
      row({ id: "order", type: "trade" }),
      row({ id: "broken", payloadJson: "{" }),
      row({ id: "wrong", payloadJson: JSON.stringify({ sender: 1 }) }),
      row({ id: "ok" }),
    ]);
    expect(dms.map((dm) => dm.id)).toEqual(["ok"]);
  });

  it("returns DMs oldest first", () => {
    const dms = storedMessagesToDms([
      row({ id: "late", createdAt: 30, payloadJson: JSON.stringify({ sender: "a", recipients: [], content: "b", createdAt: 30 }) }),
      row({ id: "early", createdAt: 5, payloadJson: JSON.stringify({ sender: "a", recipients: [], content: "b", createdAt: 5 }) }),
    ]);
    expect(dms.map((dm) => dm.id)).toEqual(["early", "late"]);
  });
});

describe("loadStoredDms", () => {
  it("queries the daemon and maps rows", async () => {
    const rpc: MessagesRpc = {
      call: (async (method: string) => {
        expect(method).toBe("messages.list");
        return [row()];
      }) as MessagesRpc["call"],
    };
    const dms = await loadStoredDms(rpc);
    expect(dms).toHaveLength(1);
  });

  it("returns an empty list when the daemon is unavailable", async () => {
    const rpc: MessagesRpc = {
      call: (async () => {
        throw new Error("daemon down");
      }) as MessagesRpc["call"],
    };
    await expect(loadStoredDms(rpc)).resolves.toEqual([]);
  });
});
