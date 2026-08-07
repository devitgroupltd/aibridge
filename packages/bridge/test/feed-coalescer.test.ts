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
      onFlush: (_slug, text) => { flushes.push(text); },
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

  test("§5.4 point 4: quiet mode doubles the coalescing interval", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      quietMode: () => true,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => { flushes.push(text); },
    });

    coalescer.notify("s1", "a"); // the first notify for a fresh slug always flushes immediately
    expect(flushes).toEqual(["a"]);

    coalescer.notify("s1", "b"); // now timed against the interval - doubled, since quiet mode is on
    clock.advance(3000); // the ordinary 3s interval - not enough while quiet mode is active
    expect(flushes).toEqual(["a"]);

    clock.advance(3000); // 6s total, matching the doubled interval
    expect(flushes).toEqual(["a", "b"]);
  });

  test("quiet mode clearing mid-wait does not retroactively shorten an already-armed timer", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    let quiet = true;
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      quietMode: () => quiet,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => { flushes.push(text); },
    });

    coalescer.notify("s1", "a"); // the first notify for a fresh slug always flushes immediately
    expect(flushes).toEqual(["a"]);

    coalescer.notify("s1", "b"); // armed at the doubled 6s interval, quiet mode still on
    quiet = false;
    clock.advance(3000); // the now-current (non-quiet) interval, but this timer was armed for 6s
    expect(flushes).toEqual(["a"]);
    clock.advance(3000); // 6s total - the timer it was actually armed with
    expect(flushes).toEqual(["a", "b"]);
  });
});

/**
 * §5.3's "one message per turn, edited in place" needs a turn boundary the coalescer knows about: the
 * next turn posts a *new* Telegram message, so the "unchanged since the last frame sent" skip must not
 * carry across it. The first render of turn N+1 is frequently byte-identical to the last render of
 * turn N (same header, same first step), which would leave the brand-new card empty until something
 * else changed - silent, and indistinguishable from a stalled session.
 */
describe("FeedCoalescer.reset (turn boundary)", () => {
  test("an identical render is sent again after a reset", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      onFlush: (_slug, text) => { flushes.push(text); },
    });

    coalescer.notify("s", "🔧 Bash");
    clock.advance(3000);
    expect(flushes).toEqual(["🔧 Bash"]);

    // Same text again mid-turn is correctly skipped...
    coalescer.notify("s", "🔧 Bash");
    clock.advance(3000);
    expect(flushes).toEqual(["🔧 Bash"]);

    // ...but after a turn boundary it belongs to a different message, so it must go out.
    coalescer.reset("s");
    coalescer.notify("s", "🔧 Bash");
    clock.advance(3000);
    expect(flushes).toEqual(["🔧 Bash", "🔧 Bash"]);
  });

  test("reset also clears the flush-interval timer's baseline, so the new card isn't held back", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      onFlush: (_slug, text) => { flushes.push(text); },
    });

    coalescer.notify("s", "first");
    clock.advance(3000);
    expect(flushes).toHaveLength(1);

    // A new turn immediately after the previous flush: without clearing `lastSentAtMs`, this would
    // wait out a full interval before the new card showed anything.
    coalescer.reset("s");
    coalescer.notify("s", "second turn");
    expect(flushes).toEqual(["first", "second turn"]);
  });

  test("reset is per-slug - it never disturbs another session's dedupe state", () => {
    const clock = makeClock(0);
    const flushes: [string, string][] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      onFlush: (slug, text) => { flushes.push([slug, text]); },
    });

    coalescer.notify("a", "same");
    coalescer.notify("b", "same");
    clock.advance(3000);
    expect(flushes).toHaveLength(2);

    coalescer.reset("a");
    coalescer.notify("a", "same");
    coalescer.notify("b", "same"); // still deduped
    clock.advance(3000);
    expect(flushes.filter(([slug]) => slug === "a")).toHaveLength(2);
    expect(flushes.filter(([slug]) => slug === "b")).toHaveLength(1);
  });
});

describe("FeedCoalescer.cancel (session teardown)", () => {
  // A slug comes from a prompt's first few words, so a later session can legitimately be handed the
  // same one - and would have inherited the removed session's dedupe state, silently skipping its
  // first identical render.
  test("forgets a slug's state, so a re-created slug doesn't inherit it", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      onFlush: (_slug, text) => { flushes.push(text); },
    });

    coalescer.notify("reused-slug", "🔧 Bash");
    clock.advance(3000);
    expect(flushes).toHaveLength(1);

    coalescer.cancel("reused-slug");

    coalescer.notify("reused-slug", "🔧 Bash");
    clock.advance(3000);
    expect(flushes).toHaveLength(2);
  });

  test("cancelling an armed timer means it never flushes", () => {
    const clock = makeClock(0);
    const flushes: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => { flushes.push(text); },
    });

    coalescer.notify("s", "a"); // flushes immediately - nothing sent yet for this slug
    expect(flushes).toEqual(["a"]);

    // Still inside the 3s interval, so this one is deferred onto a timer rather than sent.
    clock.advance(1000);
    coalescer.notify("s", "b");
    coalescer.cancel("s");
    clock.advance(60_000);

    expect(flushes).toEqual(["a"]);
  });
});

/**
 * The ordering trap in the turn-boundary fix. `onFlush` runs *synchronously* (the P2 lane invokes its
 * callback inline, and in `index.ts` that callback reads its cached `message_id` before its first
 * await), so a `reset()` that flushes must do so while the outgoing turn's card id is still cached.
 * Getting the order wrong posts the old turn's final frame as a brand-new message and then lets the
 * new turn edit *that* - which is the very bug the per-turn card change set out to fix.
 */
describe("FeedCoalescer.reset flushes into the outgoing turn, not the new one", () => {
  test("an armed render is flushed before the dedupe state is cleared", () => {
    const clock = makeClock(0);
    const flushed: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => { flushed.push(text); },
    });

    coalescer.notify("s", "turn1-frame1"); // sent immediately
    clock.advance(1000);
    coalescer.notify("s", "turn1-final"); // deferred onto a timer, still pending
    expect(flushed).toEqual(["turn1-frame1"]);

    coalescer.reset("s");

    // The pending frame went out, and it went out during the reset - not later, mixed into turn 2.
    expect(flushed).toEqual(["turn1-frame1", "turn1-final"]);

    clock.advance(60_000);
    expect(flushed).toEqual(["turn1-frame1", "turn1-final"]); // the cancelled timer never re-fires
  });

  test("reset with nothing armed flushes nothing", () => {
    const clock = makeClock(0);
    const flushed: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => { flushed.push(text); },
    });

    coalescer.notify("s", "only-frame");
    expect(flushed).toEqual(["only-frame"]);
    coalescer.reset("s");
    expect(flushed).toEqual(["only-frame"]);
  });

  /**
   * 0.97.0: `reset()`'s return value used to be discarded by every caller - `pipe-server.ts`'s
   * `onBeforeReply` now awaits it (bounded by its own timeout) so a reply can't be sent until the
   * feed card describing what produced it has actually reached Telegram, not merely been kicked off.
   */
  test("reset propagates onFlush's promise, resolving only once the flush itself settles", async () => {
    const clock = makeClock(0);
    let sendCompleted = false;
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: async () => {
        await Promise.resolve();
        await Promise.resolve();
        sendCompleted = true;
      },
    });

    coalescer.notify("s", "pending frame"); // sent immediately (first notify for a fresh slug)
    clock.advance(1000);
    coalescer.notify("s", "final frame"); // deferred onto a timer, still pending when reset() fires

    const flushed = coalescer.reset("s");
    expect(sendCompleted).toBe(false); // reset() returned, but onFlush's own promise hasn't settled yet
    await flushed;
    expect(sendCompleted).toBe(true);
  });

  test("reset with nothing armed returns undefined - nothing for a caller to await", () => {
    const clock = makeClock(0);
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 1,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: () => {},
    });

    coalescer.notify("s", "only-frame"); // sent immediately - nothing left armed
    expect(coalescer.reset("s")).toBeUndefined();
  });

  test("the new turn's first send still respects §5.4's interval", () => {
    // `lastSentAtMs` deliberately survives a reset - clearing it would make every turn boundary an
    // ungated immediate send, defeating the per-session budget.
    const clock = makeClock(0);
    const flushed: string[] = [];
    const coalescer = new FeedCoalescer({
      activeSessionCount: () => 2, // interval = 6s
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (_slug, text) => { flushed.push(text); },
    });

    coalescer.notify("s", "turn1");
    expect(flushed).toEqual(["turn1"]);

    clock.advance(1000);
    coalescer.reset("s");
    coalescer.notify("s", "turn2");
    expect(flushed).toEqual(["turn1"]); // held, not sent instantly

    clock.advance(6000);
    expect(flushed).toEqual(["turn1", "turn2"]);
  });
});
