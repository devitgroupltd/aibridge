import { describe, expect, test } from "bun:test";
import { RateGovernor, RateLimitedError } from "../src/rate-governor.ts";

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeClock(startMs: number) {
  let nowMs = startMs;
  const timers: FakeTimer[] = [];
  const setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const timer: FakeTimer = { fireAt: nowMs + ms, fn, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const now = (): number => nowMs;
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const timer of timers.filter((t) => !t.cancelled && t.fireAt <= nowMs).sort((a, b) => a.fireAt - b.fireAt)) {
      if (timer.cancelled) continue;
      timer.cancelled = true;
      timer.fn();
    }
  };
  return { now, advance, setTimeoutFn };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RateGovernor", () => {
  test("§9 scenario 15: saturating the feed bucket does not delay a P0 send", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    for (let i = 0; i < 20; i++) {
      governor.schedule("P2", async () => {});
    }
    expect(governor.droppedP2Count).toBe(0);
    governor.schedule("P2", async () => {}); // 21st - feed bucket is now empty
    expect(governor.droppedP2Count).toBe(1);

    let p0Sent = false;
    governor.schedule("P0", async () => {
      p0Sent = true;
    });
    await flushMicrotasks();
    expect(p0Sent).toBe(true);
  });

  test("§9 scenario 16: P2 drops while P0 is queued and sent, P1 deferred behind it", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 1, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    const order: string[] = [];
    governor.schedule("P1", async () => {
      order.push("P1");
    });
    governor.schedule("P0", async () => {
      order.push("P0");
    });
    await flushMicrotasks();
    // Only one control-bucket token available: P0 must be drained first even though P1 was
    // scheduled first, and P1 stays queued rather than being dropped.
    expect(order).toEqual(["P0"]);

    // Exhaust the (independent) feed bucket's own single token before testing that a P2 call
    // past that point is dropped, not queued.
    governor.schedule("P2", async () => {});
    let p2Ran = false;
    governor.schedule("P2", async () => {
      p2Ran = true;
    });
    expect(p2Ran).toBe(false);
    expect(governor.droppedP2Count).toBe(1);

    clock.advance(60_000); // refill the control bucket
    governor.pump();
    await flushMicrotasks();
    expect(order).toEqual(["P0", "P1"]);
  });

  test("§9 scenario 17: answerCallbackQuery-shaped P0 work consumes a token like any other send", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 1, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    governor.schedule("P0", async () => {}); // consumes the only token, sends no visible message
    let secondRan = false;
    governor.schedule("P0", async () => {
      secondRan = true;
    });
    await flushMicrotasks();
    expect(secondRan).toBe(false); // bucket is empty even though the first call "sent nothing"

    clock.advance(60_000);
    governor.pump();
    await flushMicrotasks();
    expect(secondRan).toBe(true);
  });

  test("§9 scenario 18: a 429 pauses only that token's bucket, and a P2 edit is never retried", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    let p2Attempts = 0;
    governor.schedule("P2", async () => {
      p2Attempts += 1;
      throw new RateLimitedError(7);
    });
    await flushMicrotasks();
    expect(p2Attempts).toBe(1);

    // Feed bucket paused for 7s: a P2 scheduled inside that window is dropped even though it has
    // "tokens" on paper.
    clock.advance(1000);
    governor.schedule("P2", async () => {
      p2Attempts += 1;
    });
    expect(governor.droppedP2Count).toBe(1);
    expect(p2Attempts).toBe(1); // never retried

    // The control bucket is untouched by the feed bucket's pause.
    let p0Ran = false;
    governor.schedule("P0", async () => {
      p0Ran = true;
    });
    await flushMicrotasks();
    expect(p0Ran).toBe(true);

    clock.advance(6000); // total 7s elapsed since the pause
    governor.schedule("P2", async () => {
      p2Attempts += 1;
    });
    await flushMicrotasks();
    expect(p2Attempts).toBe(2);
  });

  test("a 429 on P0/P1 pauses the control bucket and re-sends once unpaused, without spending a retry", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    let attempts = 0;
    governor.schedule("P0", async () => {
      attempts += 1;
      if (attempts === 1) throw new RateLimitedError(5);
    });
    await flushMicrotasks();
    expect(attempts).toBe(1);

    clock.advance(5000);
    governor.pump();
    await flushMicrotasks();
    expect(attempts).toBe(2);
  });

  test("§9 scenario 41: a non-429 P0 failure retries at 1s/2s/4s, then logs ERROR and stops", async () => {
    const clock = makeClock(0);
    const logs: string[] = [];
    const governor = new RateGovernor({
      capacity: 20,
      refillIntervalMs: 60_000,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });

    let attempts = 0;
    governor.schedule("P0", async () => {
      attempts += 1;
      throw new Error("network error");
    });
    await flushMicrotasks();
    expect(attempts).toBe(1);

    clock.advance(1000);
    await flushMicrotasks();
    expect(attempts).toBe(2);

    clock.advance(2000);
    await flushMicrotasks();
    expect(attempts).toBe(3);

    clock.advance(4000);
    await flushMicrotasks();
    expect(attempts).toBe(4);

    // Retry budget exhausted (3 retries after the first attempt) - no further attempts, one
    // ERROR logged, nothing marked as delivered.
    clock.advance(100_000);
    await flushMicrotasks();
    expect(attempts).toBe(4);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  test("a P2 send that fails without a 429 is never retried either", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
    let attempts = 0;
    governor.schedule("P2", async () => {
      attempts += 1;
      throw new Error("network error");
    });
    await flushMicrotasks();
    clock.advance(100_000);
    await flushMicrotasks();
    expect(attempts).toBe(1);
  });
});
