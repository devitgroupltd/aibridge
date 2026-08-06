import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CostStore } from "../src/cost-store.ts";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    // Same non-fatal best-effort cleanup as settings-store.test.ts's own teardown - Windows can
    // hold the sqlite WAL file's handle open a beat past close().
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

async function freshDbPath(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-cost-store-test-"));
  return path.join(tmpDir, "aibridge.db");
}

describe("CostStore", () => {
  test("insert then all() round-trips every event, in insertion order", () => {
    const store = new CostStore(":memory:");
    store.insert("sess-1", 1000, 0.5);
    store.insert("sess-2", 2000, 1.25);
    expect(store.all()).toEqual([
      { sessionId: "sess-1", atMs: 1000, costUsd: 0.5 },
      { sessionId: "sess-2", atMs: 2000, costUsd: 1.25 },
    ]);
    store.close();
  });

  test("deleteOlderThan drops only events strictly before the cutoff", () => {
    const store = new CostStore(":memory:");
    store.insert("sess-1", 1000, 1);
    store.insert("sess-1", 5000, 2);
    store.deleteOlderThan(5000);
    expect(store.all()).toEqual([{ sessionId: "sess-1", atMs: 5000, costUsd: 2 }]);
    store.close();
  });

  test("a value survives across a fresh CostStore instance against the same db file - the whole point of persisting spend across a restart", async () => {
    const dbPath = await freshDbPath();
    const first = new CostStore(dbPath);
    first.insert("sess-1", 1000, 4.5);
    first.close();

    const second = new CostStore(dbPath);
    expect(second.all()).toEqual([{ sessionId: "sess-1", atMs: 1000, costUsd: 4.5 }]);
    second.close();
  });
});
