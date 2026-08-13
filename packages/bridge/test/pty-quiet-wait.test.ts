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

  // `afterActivityAt` (P2-7). `pty-io.ts` waits for the echo of a body it has *just* written, and
  // the echo cannot possibly have arrived yet - so without this the wait sees the silence that was
  // already there, resolves instantly, and is a no-op that looks exactly like a working fix. That
  // is the §9 silent-wrong bar, and it is not hypothetical: it shipped that way for one live run.
  describe("afterActivityAt", () => {
    test("does not treat pre-existing silence as quiet - waits for the write's own echo first", async () => {
      const scheduler = makeScheduler();
      let lastActivity = 100; // the last thing that happened, long before this write
      const resultPromise = waitForPtyQuiet("slug-a", {
        lastActivityAt: () => lastActivity,
        afterActivityAt: 100, // read immediately before the write
        quietMs: 300,
        pollMs: 100,
        timeoutMs: 5000,
        now: scheduler.now,
        setTimeoutFn: scheduler.setTimeoutFn,
      });

      // The PTY has been silent since t=100 and is silent still, which without `afterActivityAt`
      // is "quiet" on the very first poll.
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      for (let i = 0; i < 5; i++) scheduler.advance(100);
      await flushMicrotasks();
      expect(settled).toBe(false);

      lastActivity = 600; // the echo finally lands
      for (let i = 0; i < 4; i++) scheduler.advance(100);
      expect(await resultPromise).toBe(true);
      // Quiet is measured from the echo, not from the silence before it: 600 + 300.
      expect(scheduler.now()).toBe(900);
    });

    test("a write whose echo never arrives still gives up at timeoutMs rather than hanging", async () => {
      const scheduler = makeScheduler();
      const resultPromise = waitForPtyQuiet("slug-a", {
        lastActivityAt: () => 100,
        afterActivityAt: 100,
        quietMs: 300,
        pollMs: 100,
        timeoutMs: 1000,
        now: scheduler.now,
        setTimeoutFn: scheduler.setTimeoutFn,
      });

      for (let i = 0; i < 11; i++) scheduler.advance(100);
      // `false` is "gave up, proceed anyway" - pty-io.ts writes the Enter regardless.
      expect(await resultPromise).toBe(false);
    });

    test("a PTY that has never produced anything is not instantly quiet when a write is being waited on", async () => {
      const scheduler = makeScheduler();
      const resultPromise = waitForPtyQuiet("slug-a", {
        lastActivityAt: () => undefined, // the `Infinity` fast path
        afterActivityAt: 0,
        quietMs: 300,
        pollMs: 100,
        timeoutMs: 500,
        now: scheduler.now,
        setTimeoutFn: scheduler.setTimeoutFn,
      });

      for (let i = 0; i < 6; i++) scheduler.advance(100);
      expect(await resultPromise).toBe(false);
    });

    test("omitting it keeps the original behaviour the /new startup gate relies on", async () => {
      // `handleNewCommand` has no write of its own to wait for - it wants "quiet, whenever that
      // started", and must still resolve immediately against an already-idle PTY.
      const scheduler = makeScheduler();
      const result = await waitForPtyQuiet("slug-a", {
        lastActivityAt: () => 0,
        quietMs: 300,
        now: () => 10_000,
        setTimeoutFn: scheduler.setTimeoutFn,
      });
      expect(result).toBe(true);
    });
  });
});

/** One turn of the real event loop, so a `.then` on a still-pending promise has had its chance to
 * run before asserting it did not. `await Promise.resolve()` drains one microtask level only. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
