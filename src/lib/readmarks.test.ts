import { beforeEach, describe, expect, it } from "vitest";
import {
  loadReadMarks,
  loadReadMarksFromDaemon,
  mergeReadMarks,
  saveReadMarks,
  saveReadMarksToDaemon,
  type ReadMarksRpc,
} from "./chat";

const PUBKEY = "a".repeat(64);

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
});

describe("mergeReadMarks", () => {
  it("keeps the newest mark per conversation", () => {
    expect(mergeReadMarks({ a: 5, b: 9 }, { a: 7, c: 2 })).toEqual({ a: 7, b: 9, c: 2 });
  });
});

describe("loadReadMarksFromDaemon", () => {
  it("imports local marks and mirrors them to the daemon", async () => {
    saveReadMarks(PUBKEY, { local: 4 });
    const writes: Array<{ key: string; value: string }> = [];
    const rpc: ReadMarksRpc = {
      call: (async (method: string, params?: any) => {
        if (method === "settings.get") return null;
        if (method === "settings.set") {
          writes.push({ key: params.key, value: params.value });
          return {};
        }
        throw new Error(`unexpected ${method}`);
      }) as ReadMarksRpc["call"],
    };
    const marks = await loadReadMarksFromDaemon(PUBKEY, rpc);
    expect(marks).toEqual({ local: 4 });
    expect(writes[0]?.key).toBe(`readMarks:${PUBKEY}`);
    expect(JSON.parse(writes[0].value)).toEqual({ local: 4 });
  });

  it("merges remote and local without moving marks backwards", async () => {
    saveReadMarks(PUBKEY, { a: 9 });
    const rpc: ReadMarksRpc = {
      call: (async (method: string, params?: any) => {
        if (method === "settings.get") return JSON.stringify({ a: 3, b: 8 });
        if (method === "settings.set") {
          expect(JSON.parse(params.value)).toEqual({ a: 9, b: 8 });
          return {};
        }
        throw new Error(`unexpected ${method}`);
      }) as ReadMarksRpc["call"],
    };
    await expect(loadReadMarksFromDaemon(PUBKEY, rpc)).resolves.toEqual({ a: 9, b: 8 });
  });

  it("falls back to the local cache when the daemon fails", async () => {
    saveReadMarks(PUBKEY, { a: 1 });
    const rpc: ReadMarksRpc = {
      call: (async () => {
        throw new Error("down");
      }) as ReadMarksRpc["call"],
    };
    await expect(loadReadMarksFromDaemon(PUBKEY, rpc)).resolves.toEqual({ a: 1 });
    expect(loadReadMarks(PUBKEY)).toEqual({ a: 1 });
  });
});

describe("saveReadMarksToDaemon", () => {
  it("writes the local cache synchronously and mirrors to the daemon", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const rpc: ReadMarksRpc = {
      call: (async (method: string, params?: any) => {
        calls.push({ method, params });
        return {};
      }) as ReadMarksRpc["call"],
    };
    await saveReadMarksToDaemon(PUBKEY, { a: 2 }, rpc);
    expect(loadReadMarks(PUBKEY)).toEqual({ a: 2 });
    expect(calls).toEqual([
      { method: "settings.set", params: { key: `readMarks:${PUBKEY}`, value: '{"a":2}' } },
    ]);
  });

  it("does not throw when the daemon is unavailable", async () => {
    const rpc: ReadMarksRpc = {
      call: (async () => {
        throw new Error("down");
      }) as ReadMarksRpc["call"],
    };
    await expect(saveReadMarksToDaemon(PUBKEY, { a: 1 }, rpc)).resolves.toBeUndefined();
    expect(loadReadMarks(PUBKEY)).toEqual({ a: 1 });
  });
});
