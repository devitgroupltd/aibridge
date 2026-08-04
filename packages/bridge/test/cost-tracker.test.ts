import { describe, expect, test } from "bun:test";
import { CostTracker, FIVE_HOURS_MS, ONE_WEEK_MS } from "../src/cost-tracker.ts";

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
