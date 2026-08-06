import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DetailsAnchorStore } from "../src/details-anchor-store.ts";

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-details-anchor-test-"));
  return path.join(tmpDir, "aibridge.db");
}

describe("DetailsAnchorStore", () => {
  test("set then get round-trips the message_id for that (slug, turnSeq)", () => {
    const store = new DetailsAnchorStore(":memory:");
    store.set("fix-bug", 1, 4242, 1000);
    expect(store.get("fix-bug", 1)).toBe(4242);
    store.close();
  });

  test("an unknown (slug, turnSeq) pair returns undefined, not a crash", () => {
    const store = new DetailsAnchorStore(":memory:");
    expect(store.get("never-seen", 1)).toBeUndefined();
    store.close();
  });

  test("different turnSeq values for the same slug are tracked independently", () => {
    const store = new DetailsAnchorStore(":memory:");
    store.set("fix-bug", 1, 100, 1000);
    store.set("fix-bug", 2, 200, 2000);
    expect(store.get("fix-bug", 1)).toBe(100);
    expect(store.get("fix-bug", 2)).toBe(200);
    store.close();
  });

  test("set on the same (slug, turnSeq) again overwrites rather than erroring on the primary key", () => {
    const store = new DetailsAnchorStore(":memory:");
    store.set("fix-bug", 1, 100, 1000);
    store.set("fix-bug", 1, 999, 2000);
    expect(store.get("fix-bug", 1)).toBe(999);
    store.close();
  });

  test("delete removes exactly that (slug, turnSeq) row, not others", () => {
    const store = new DetailsAnchorStore(":memory:");
    store.set("fix-bug", 1, 100, 1000);
    store.set("fix-bug", 2, 200, 1000);
    store.delete("fix-bug", 1);
    expect(store.get("fix-bug", 1)).toBeUndefined();
    expect(store.get("fix-bug", 2)).toBe(200);
    store.close();
  });

  test("deleteOlderThan drops only rows strictly before the cutoff", () => {
    const store = new DetailsAnchorStore(":memory:");
    store.set("fix-bug", 1, 100, 1000);
    store.set("fix-bug", 2, 200, 5000);
    store.deleteOlderThan(5000);
    expect(store.get("fix-bug", 1)).toBeUndefined();
    expect(store.get("fix-bug", 2)).toBe(200);
    store.close();
  });

  test("a value survives across a fresh DetailsAnchorStore instance against the same db file - the whole point of persisting this across a restart", async () => {
    const dbPath = await freshDbPath();
    const first = new DetailsAnchorStore(dbPath);
    first.set("fix-bug", 1, 555, 1000);
    first.close();

    const second = new DetailsAnchorStore(dbPath);
    expect(second.get("fix-bug", 1)).toBe(555);
    second.close();
  });
});
