import { describe, expect, test } from "bun:test";
import { waitForPtyQuiet } from "../src/pty-quiet-wait.ts";

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

/** Same fake-scheduler shape as pty-io.test.ts's, extended with a `now()` reader so the module
 * under test's own `now`/`setTimeoutFn` injections stay on one consistent fake clock. */
function makeScheduler() {
  let nowMs = 0;
  const timers: FakeTimer[] = [];
  const setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const timer: FakeTimer = { fireAt: nowMs + ms, fn, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const timer of timers.filter((t) => !t.cancelled && t.fireAt <= nowMs).sort((a, b) => a.fireAt - b.fireAt)) {
      if (timer.cancelled) continue;
      timer.cancelled = true;
      timer.fn();
    }
  };
  return { setTimeoutFn, advance, now: () => nowMs };
}

describe("waitForPtyQuiet", () => {
  test("resolves true immediately when the PTY has never produced any output", async () => {
    const scheduler = makeScheduler();
    const result = await waitForPtyQuiet("slug-a", {
      lastActivityAt: () => undefined,
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeoutFn,
    });
    expect(result).toBe(true);
  });

  test("resolves true immediately when the last activity is already older than quietMs", async () => {
    const scheduler = makeScheduler();
    scheduler.advance(5000); // now = 5000
    const result = await waitForPtyQuiet("slug-a", {
      lastActivityAt: () => 4000, // 1000ms ago, past the 800ms default quietMs
      quietMs: 800,
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeoutFn,
    });
    expect(result).toBe(true);
  });

  test("keeps polling while activity keeps refreshing, then resolves true once it stops", async () => {
    const scheduler = makeScheduler();
    // Simulates other-MCP-server startup chatter still landing on the PTY up to t=300 (exactly the
    // false-positive `confirmSubmitted` was fooled by live), then genuine silence after that.
    const lastActivityAt = () => Math.min(scheduler.now(), 300);
    const resultPromise = waitForPtyQuiet("slug-a", {
      lastActivityAt,
      quietMs: 300,
      pollMs: 100,
      timeoutMs: 5000,
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // Each poll fires exactly one pending timer, which schedules the next - so this needs one
    // `advance(pollMs)` per poll rather than a single larger jump. Resolves once quietFor (now -
    // last activity, capped at t=300) reaches 300, i.e. at t=600.
    for (let i = 0; i < 6; i++) scheduler.advance(100);
    expect(await resultPromise).toBe(true);
    expect(scheduler.now()).toBe(600);
  });

  test("resolves false after timeoutMs when the PTY never goes quiet", async () => {
    const scheduler = makeScheduler();
    const resultPromise = waitForPtyQuiet("slug-a", {
      lastActivityAt: () => scheduler.now(), // "just happened" on every single poll - never quiet
      quietMs: 300,
      pollMs: 100,
      timeoutMs: 1000,
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    for (let i = 0; i < 11; i++) scheduler.advance(100);
    expect(await resultPromise).toBe(false);
  });

  test("checks a different slug's activity than the one it's waiting on", async () => {
    const scheduler = makeScheduler();
    const activity = new Map<string, number>([["slug-a", 0]]);
    const result = await waitForPtyQuiet("slug-b", {
      lastActivityAt: (slug) => activity.get(slug),
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeoutFn,
    });
    // slug-b has no recorded activity at all, regardless of slug-a's - still quiet immediately.
    expect(result).toBe(true);
  });
});
