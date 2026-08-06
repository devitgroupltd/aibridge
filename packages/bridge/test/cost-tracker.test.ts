import { describe, expect, test } from "bun:test";
import { CostTracker, FIVE_HOURS_MS, ONE_WEEK_MS, type CostStorePort } from "../src/cost-tracker.ts";

/** In-memory double for the real `CostStore` (cost-store.ts) - keeps this file dependency-free of
 * SQLite while still exercising the injection point that fixes the "resets to $0 on /restart" bug
 * found during the /deep-check sweep. */
function fakeStore(): CostStorePort & { rows: { sessionId: string; atMs: number; costUsd: number }[] } {
  const rows: { sessionId: string; atMs: number; costUsd: number }[] = [];
  return {
    rows,
    insert: (sessionId, atMs, costUsd) => rows.push({ sessionId, atMs, costUsd }),
    all: () => rows.slice(),
    deleteOlderThan: (cutoffMs) => {
      const kept = rows.filter((r) => r.atMs >= cutoffMs);
      rows.length = 0;
      rows.push(...kept);
    },
  };
}

describe("CostTracker", () => {
  test("lifetimeSpend sums every recorded call for a session, no time window", () => {
    const tracker = new CostTracker();
    tracker.record("sess-1", 1000, 0.5);
    tracker.record("sess-1", 2000, 0.25);
    expect(tracker.lifetimeSpend("sess-1")).toBeCloseTo(0.75, 6);
  });

  test("lifetimeSpend for an unknown session is 0", () => {
    const tracker = new CostTracker();
    expect(tracker.lifetimeSpend("never-seen")).toBe(0);
  });

  test("spendSince only counts entries within the window", () => {
    const tracker = new CostTracker();
    const now = 10_000_000;
    tracker.record("sess-1", now - FIVE_HOURS_MS - 1, 5); // just outside the 5h window
    tracker.record("sess-1", now - 1000, 1); // inside
    expect(tracker.spendSince("sess-1", FIVE_HOURS_MS, now)).toBeCloseTo(1, 6);
    expect(tracker.spendSince("sess-1", ONE_WEEK_MS, now)).toBeCloseTo(6, 6);
  });

  test("fleetSpendSince sums across every session, not just one", () => {
    const tracker = new CostTracker();
    const now = 10_000_000;
    tracker.record("sess-1", now - 1000, 1.5);
    tracker.record("sess-2", now - 2000, 2.5);
    expect(tracker.fleetSpendSince(FIVE_HOURS_MS, now)).toBeCloseTo(4, 6);
  });

  test("prune drops entries older than the retention window, and removes an emptied session entirely", () => {
    const tracker = new CostTracker();
    const now = 10_000_000;
    const retentionMs = 8 * 24 * 60 * 60 * 1000;
    tracker.record("sess-1", now - retentionMs - 1, 3);
    tracker.prune(now);
    expect(tracker.lifetimeSpend("sess-1")).toBe(0);
    expect(tracker.sessionIds()).not.toContain("sess-1");
  });

  test("sessionIds lists every session with at least one recorded call", () => {
    const tracker = new CostTracker();
    tracker.record("sess-1", 1000, 0.1);
    tracker.record("sess-2", 1000, 0.2);
    expect(new Set(tracker.sessionIds())).toEqual(new Set(["sess-1", "sess-2"]));
  });
});

describe("CostTracker with a persistence store injected (§5.7/§10.5's /restart-survives-spend fix)", () => {
  test("record() writes through to the store immediately, not just to the in-memory map", () => {
    const store = fakeStore();
    const tracker = new CostTracker(store);
    tracker.record("sess-1", 1000, 0.5);
    expect(store.rows).toEqual([{ sessionId: "sess-1", atMs: 1000, costUsd: 0.5 }]);
  });

  test("a fresh CostTracker seeded from a store with existing rows reports their spend immediately - the actual restart scenario", () => {
    const store = fakeStore();
    store.rows.push({ sessionId: "sess-1", atMs: 1000, costUsd: 3 }, { sessionId: "sess-1", atMs: 2000, costUsd: 1 });
    const tracker = new CostTracker(store); // simulates the Bridge reconstructing CostTracker after /restart
    expect(tracker.lifetimeSpend("sess-1")).toBeCloseTo(4, 6);
  });

  test("prune() mirrors its cutoff into the store, not just the in-memory map", () => {
    const store = fakeStore();
    const tracker = new CostTracker(store);
    const now = 10_000_000;
    const retentionMs = 8 * 24 * 60 * 60 * 1000;
    tracker.record("sess-1", now - retentionMs - 1, 3);
    tracker.record("sess-1", now, 2);
    tracker.prune(now);
    expect(store.rows).toEqual([{ sessionId: "sess-1", atMs: now, costUsd: 2 }]);
  });

  test("omitting the store keeps today's in-memory-only behaviour (every existing caller/test)", () => {
    const tracker = new CostTracker();
    tracker.record("sess-1", 1000, 1);
    expect(tracker.lifetimeSpend("sess-1")).toBe(1);
  });
});
