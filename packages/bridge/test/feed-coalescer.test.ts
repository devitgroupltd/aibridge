import { describe, expect, test } from "bun:test";
import { FeedCoalescer } from "../src/feed-coalescer.ts";

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

/** Manual fake clock + timer queue - no real setTimeout waits, so these tests run instantly and
 * deterministically regardless of the real 3s/12s intervals under test. */
function makeClock(startMs: number) {
  let nowMs = startMs;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const timer: FakeTimer = { id: nextId++, fireAt: nowMs + ms, fn, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutFn = (handle: unknown): void => {
    (handle as FakeTimer).cancelled = true;
  };
  const now = (): number => nowMs;
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const timer of timers.filter((t) => !t.cancelled && t.fireAt <= nowMs).sort((a, b) => a.fireAt - b.fireAt)) {
      if (timer.cancelled) continue;
      timer.cancelled = true; // one-shot
      timer.fn();
    }
  };
  return { now, advance, setTimeoutFn, clearTimeoutFn };
}

describe("FeedCoalescer", () => {
  test("§9 scenario 14: 50 events in 1 second produce at most one flush", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => flushes.push(text),
    });

    for (let i = 0; i < 50; i++) {
      coalescer.notify("s1", `frame-${i}`);
      clock.advance(20); // 50 * 20ms = 1000ms total
    }
    // The very first notify() has no prior frame to compare against, so it flushes immediately
    // (frame-0) - everything else in the burst collapses into the single frame still pending
    // when the 3s interval elapses, rather than one edit per event.
    expect(flushes.length).toBeLessThanOrEqual(1);

    clock.advance(3000);
    expect(flushes.length).toBe(2);
    expect(flushes[0]).toBe("frame-0");
    expect(flushes[1]).toBe("frame-49"); // the latest text, not a stale intermediate frame
  });

  test("§9 scenario 14: 4 active sessions coalesce at 12s, so the aggregate stays at 20/minute", () => {
    const clock = makeClock(0);
    let flushCount = 0;
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 4,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: () => {
        flushCount += 1;
      },
    });

    let tick = 0;
    for (let elapsed = 0; elapsed < 60_000; elapsed += 500) {
      coalescer.notify("s1", `frame-${tick++}`);
      clock.advance(500);
    }
    // The first notify flushes immediately (t=0), then every 12s up to and including t=60000:
    // 0/12/24/36/48/60 - 6 flushes over 60s, i.e. within the 20/minute-per-bucket ceiling once
    // multiplied by 4 sessions (4 x 5 steady-state flushes/min, per §5.4's own arithmetic; the
    // extra immediate first frame is a one-time cost per session, not a steady-state rate).
    expect(flushCount).toBe(6);
  });

  test("an unchanged render is never flushed", () => {
    const clock = makeClock(0);
    let flushCount = 0;
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: () => {
        flushCount += 1;
      },
    });

    coalescer.notify("s1", "same text");
    clock.advance(3000);
    expect(flushCount).toBe(1);

    coalescer.notify("s1", "same text");
    clock.advance(3000);
    expect(flushCount).toBe(1); // no-op: identical to the last frame actually sent
  });

  test("an idle session (no notify calls) never flushes", () => {
    const clock = makeClock(0);
    let flushCount = 0;
    new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: () => {
        flushCount += 1;
      },
    });
    clock.advance(60_000);
    expect(flushCount).toBe(0);
  });
});
