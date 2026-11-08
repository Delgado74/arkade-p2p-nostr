import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOperations,
  loadOperationsFromDaemon,
  mergeOperations,
  recordOperation,
  syncOperation,
  type OperationRecord,
  type OperationsRpc,
} from "./operations";

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

function op(orderId: string, updatedAt: number, overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    orderId,
    counterparty: "b".repeat(64),
    role: "buyer",
    status: "in-progress",
    createdAt: 1,
    updatedAt,
    ...overrides,
  };
}

function fakeRpc(handlers: {
  list?: () => OperationRecord[];
  onImport?: (records: OperationRecord[]) => void;
  onUpsert?: (orderId: string, patch: Partial<OperationRecord>) => void;
}): OperationsRpc {
  return {
    call: (async (method: string, params?: any) => {
      switch (method) {
        case "operations.import":
          handlers.onImport?.(params.operations);
          return { imported: params.operations.length, skipped: 0 };
        case "operations.list":
          return handlers.list?.() ?? [];
        case "operations.upsert":
          handlers.onUpsert?.(params.orderId, params.patch);
          return {};
        default:
          throw new Error(`unexpected method ${method}`);
      }
    }) as OperationsRpc["call"],
  };
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
});

describe("mergeOperations", () => {
  it("unions both sources and sorts newest first", () => {
    const merged = mergeOperations([op("a", 10), op("b", 30)], [op("c", 20)]);
    expect(merged.map((entry) => entry.orderId)).toEqual(["b", "c", "a"]);
  });

  it("keeps the daemon version on ties", () => {
    const merged = mergeOperations(
      [op("a", 10, { status: "completed" })],
      [op("a", 10, { status: "canceled" })],
    );
    expect(merged[0].status).toBe("completed");
  });

  it("prefers a strictly newer local version", () => {
    const merged = mergeOperations(
      [op("a", 10, { status: "in-progress" })],
      [op("a", 11, { status: "completed" })],
    );
    expect(merged[0].status).toBe("completed");
  });
});

describe("loadOperationsFromDaemon", () => {
  it("imports the local cache and returns the daemon history", () => {
    recordOperation(PUBKEY, "a", { status: "completed", updatedAt: 5 } as Partial<OperationRecord>);
    const imported: OperationRecord[][] = [];
    const remote = op("a", 5, { status: "completed" });

    return loadOperationsFromDaemon(
      PUBKEY,
      fakeRpc({
        onImport: (records) => imported.push(records),
        list: () => [remote],
      }),
    ).then((list) => {
      expect(imported).toHaveLength(1);
      expect(imported[0].map((entry) => entry.orderId)).toEqual(["a"]);
      expect(list.map((entry) => entry.orderId)).toEqual(["a"]);
      expect(loadOperations(PUBKEY)).toHaveLength(1);
    });
  });

  it("pushes local rows that are newer than the daemon copy", () => {
    recordOperation(PUBKEY, "a", { status: "completed" } as Partial<OperationRecord>);
    const upserts: Array<[string, Partial<OperationRecord>]> = [];

    return loadOperationsFromDaemon(
      PUBKEY,
      fakeRpc({
        list: () => [op("a", 1, { status: "in-progress" })],
        onUpsert: (orderId, patch) => upserts.push([orderId, patch]),
      }),
    ).then((list) => {
      expect(upserts.map(([orderId]) => orderId)).toEqual(["a"]);
      expect(upserts[0][1].status).toBe("completed");
      expect(list[0].status).toBe("completed");
    });
  });

  it("falls back to the local cache when the daemon is unreachable", async () => {
    recordOperation(PUBKEY, "a", { status: "completed" } as Partial<OperationRecord>);
    const rpc: OperationsRpc = {
      call: async () => {
        throw new Error("daemon disconnected");
      },
    };

    const list = await loadOperationsFromDaemon(PUBKEY, rpc);
    expect(list.map((entry) => entry.orderId)).toEqual(["a"]);
    expect(list[0].status).toBe("completed");
  });

  it("is idempotent: a second run does not re-push settled rows", async () => {
    recordOperation(PUBKEY, "a", { status: "completed" } as Partial<OperationRecord>);
    const remote = op("a", Math.floor(Date.now() / 1000), { status: "completed" });
    const upsert = vi.fn();

    await loadOperationsFromDaemon(
      PUBKEY,
      fakeRpc({ list: () => [remote], onUpsert: upsert }),
    );
    await loadOperationsFromDaemon(
      PUBKEY,
      fakeRpc({ list: () => [remote], onUpsert: upsert }),
    );

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("syncOperation", () => {
  it("sends only patchable fields", async () => {
    const seen: Array<[string, Partial<OperationRecord>]> = [];
    await syncOperation("a", op("a", 1), fakeRpc({ onUpsert: (id, patch) => seen.push([id, patch]) }));
    expect(seen[0][0]).toBe("a");
    expect(seen[0][1]).not.toHaveProperty("orderId");
    expect(seen[0][1]).not.toHaveProperty("createdAt");
    expect(seen[0][1]).not.toHaveProperty("updatedAt");
  });

  it("swallows daemon errors so the local cache stays usable", async () => {
    const rpc: OperationsRpc = {
      call: async () => {
        throw new Error("daemon disconnected");
      },
    };
    await expect(syncOperation("a", { status: "completed" }, rpc)).resolves.toBeUndefined();
  });
});
