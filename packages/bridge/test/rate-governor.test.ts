import { describe, expect, test } from "bun:test";
import { clampRetryAfterMs, RateGovernor, RateLimitedError } from "../src/rate-governor.ts";

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

  describe("scheduleAsync", () => {
    test("resolves with the scheduled function's own result once actually sent", async () => {
      const clock = makeClock(0);
      const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      await expect(governor.scheduleAsync("P0", async () => ({ message_id: 42 }))).resolves.toEqual({ message_id: 42 });
    });

    test("rejects once the 3-retry budget is exhausted, same task the caller awaited", async () => {
      const clock = makeClock(0);
      const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      let caught: unknown;
      const promise = governor.scheduleAsync("P1", async () => {
        throw new Error("network error");
      });
      promise.catch((err) => {
        caught = err;
      });
      await flushMicrotasks(); // attempt 1 (immediate, no backoff wait yet)
      clock.advance(1000); // attempt 2
      await flushMicrotasks();
      clock.advance(2000); // attempt 3
      await flushMicrotasks();
      clock.advance(4000); // attempt 4 - retry budget exhausted here, task.reject() fires
      await flushMicrotasks();
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("network error");
    });

    test("schedule() (fire-and-forget) never produces an unhandled rejection on the same failure path", async () => {
      const clock = makeClock(0);
      const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      governor.schedule("P0", async () => {
        throw new Error("network error");
      });
      await flushMicrotasks(); // attempt 1
      clock.advance(1000); // attempt 2
      await flushMicrotasks();
      clock.advance(2000); // attempt 3
      await flushMicrotasks();
      clock.advance(4000); // attempt 4 - exhausted; if this rejects unhandled, bun test surfaces it
      await flushMicrotasks();
    });
  });

  describe("p2PressureExceeded (§5.4 point 4's quiet-mode trigger)", () => {
    test("never reports pressure below the minimum sample count, even at a 100% drop rate", () => {
      const clock = makeClock(0);
      // Zero-capacity feed bucket: every P2 attempt drops immediately, so this isolates the
      // sample-count guard from the drop-rate arithmetic.
      const governor = new RateGovernor({ capacity: 0, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      governor.schedule("P2", async () => {});
      governor.schedule("P2", async () => {});
      governor.schedule("P2", async () => {});
      expect(governor.droppedP2Count).toBe(3);
      expect(governor.p2PressureExceeded()).toBe(false); // below MIN_SAMPLES_FOR_PRESSURE (4)
    });

    test("reports pressure once drops exceed 50% of a window with enough samples", () => {
      const clock = makeClock(0);
      const governor = new RateGovernor({ capacity: 0, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      for (let i = 0; i < 4; i++) governor.schedule("P2", async () => {}); // 4/4 dropped - 100%
      expect(governor.p2PressureExceeded()).toBe(true);
    });

    test("does not report pressure at exactly 50% - the plan says 'exceed', not 'reach'", () => {
      const clock = makeClock(0);
      const governor = new RateGovernor({ capacity: 2, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      // Bucket starts with 2 tokens: first 2 attempts succeed, next 2 drop - exactly 50%.
      governor.schedule("P2", async () => {});
      governor.schedule("P2", async () => {});
      governor.schedule("P2", async () => {});
      governor.schedule("P2", async () => {});
      expect(governor.droppedP2Count).toBe(2);
      expect(governor.p2PressureExceeded()).toBe(false);
    });

    test("drops older than the 60s window stop counting, so pressure can clear on its own", () => {
      const clock = makeClock(0);
      const governor = new RateGovernor({ capacity: 0, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
      for (let i = 0; i < 4; i++) governor.schedule("P2", async () => {});
      expect(governor.p2PressureExceeded()).toBe(true);
      clock.advance(60_001); // every one of those 4 outcomes is now outside the window
      expect(governor.p2PressureExceeded()).toBe(false); // back below the minimum sample count
    });
  });
});

/**
 * The queue used to defer on a time-based condition without owning a timer for it: `drainControl`
 * returned on an empty/paused bucket, and the 429 branch requeued the task with no timer at all. The
 * only things that ever re-drained were a *new* `enqueueControl` and the non-429 retry path, and
 * every existing test above hides that by calling `pump()` by hand.
 *
 * Concretely: a 429 on the last send before an idle stretch parks the requeued task indefinitely -
 * and when that task is the permission card a session is blocked waiting on, nothing for that session
 * will ever call `schedule()` again. The fleet deadlocks until the §6.5 sweep or a restart.
 */
describe("RateGovernor self-rearming (no external pump)", () => {
  test("a task deferred by an empty bucket drains itself once tokens refill", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 1, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    governor.schedule("P0", async () => {}); // takes the only token
    let deferredRan = false;
    governor.schedule("P0", async () => {
      deferredRan = true;
    });
    await flushMicrotasks();
    expect(deferredRan).toBe(false);

    // No pump() call here - that is the whole point. Only time passes.
    clock.advance(60_000);
    await flushMicrotasks();
    expect(deferredRan).toBe(true);
  });

  test("a 429'd P0 card is retried on its own after the retry_after window, with no new work arriving", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });

    let attempts = 0;
    const done = governor.scheduleAsync("P0", async () => {
      attempts += 1;
      if (attempts === 1) throw new RateLimitedError(3);
      return "delivered";
    });
    await flushMicrotasks();
    expect(attempts).toBe(1);

    clock.advance(3100);
    await flushMicrotasks();
    expect(attempts).toBe(2);
    expect(await done).toBe("delivered");
  });

  test("many deferred tasks share one retry timer rather than arming one each", async () => {
    const clock = makeClock(0);
    let timersArmed = 0;
    const countingSetTimeout = (fn: () => void, ms: number): unknown => {
      timersArmed += 1;
      return clock.setTimeoutFn(fn, ms);
    };
    const governor = new RateGovernor({ capacity: 1, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: countingSetTimeout });

    governor.schedule("P0", async () => {}); // takes the only token
    for (let i = 0; i < 50; i++) governor.schedule("P1", async () => {});
    await flushMicrotasks();

    // One shared drain-retry timer, not 50.
    expect(timersArmed).toBe(1);
  });
});

/**
 * 0.97.0: `schedule()`'s return value used to be `void` and every existing caller above ignores
 * it, but `pipe-server.ts`'s reply/feed ordering barrier now needs to know when a P2 send has
 * actually settled, not merely been scheduled - these lock in the contract that change relies on.
 */
describe("schedule()'s promise return (0.97.0 ordering barrier)", () => {
  test("a P2 send that succeeds resolves the returned promise only once the send itself completes", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
    let sendCompleted = false;
    const promise = governor.schedule("P2", async () => {
      await flushMicrotasks();
      sendCompleted = true;
    });
    expect(sendCompleted).toBe(false); // not yet - the send is still in flight
    await promise;
    expect(sendCompleted).toBe(true);
  });

  test("a P2 send dropped for an empty bucket resolves immediately - nothing to wait for", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 0, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
    let ran = false;
    const promise = governor.schedule("P2", async () => {
      ran = true;
    });
    await promise;
    expect(ran).toBe(false); // dropped, not attempted
    expect(governor.droppedP2Count).toBe(1);
  });

  test("a P2 send that throws still resolves (never rejects) the returned promise", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
    const promise = governor.schedule("P2", async () => {
      throw new Error("network error");
    });
    await expect(promise).resolves.toBeUndefined();
  });

  test("a P1 send's returned promise resolves once actually delivered, and never rejects even on exhausted retries", async () => {
    const clock = makeClock(0);
    const governor = new RateGovernor({ capacity: 20, refillIntervalMs: 60_000, now: clock.now, setTimeoutFn: clock.setTimeoutFn });
    let delivered = false;
    const promise = governor.schedule("P1", async () => {
      delivered = true;
    });
    await flushMicrotasks();
    await promise;
    expect(delivered).toBe(true);

    const failing = governor.schedule("P1", async () => {
      throw new Error("network error");
    });
    await flushMicrotasks();
    clock.advance(1000);
    await flushMicrotasks();
    clock.advance(2000);
    await flushMicrotasks();
    clock.advance(4000);
    await flushMicrotasks();
    await expect(failing).resolves.toBeUndefined(); // exhausted its retries, but schedule() never rejects
  });
});

describe("clampRetryAfterMs", () => {
  // §5.4 says honour retry_after exactly, but a bucket paused on an unbounded number taken straight
  // off the wire may never resume - a garbled retry_after of 10^9 would mute the fleet for the
  // process's lifetime, silently.
  test("passes a realistic retry_after through unchanged", () => {
    expect(clampRetryAfterMs(5)).toBe(5000);
    expect(clampRetryAfterMs(30)).toBe(30_000);
  });

  test("caps an absurd value at one hour and floors a nonsensical one at a second", () => {
    expect(clampRetryAfterMs(1_000_000_000)).toBe(60 * 60 * 1000);
    expect(clampRetryAfterMs(0)).toBe(1000);
    expect(clampRetryAfterMs(-5)).toBe(1000);
    expect(clampRetryAfterMs(Number.NaN)).toBe(1000);
    expect(clampRetryAfterMs(Number.POSITIVE_INFINITY)).toBe(1000);
  });
});
