import { describe, expect, test } from "bun:test";
import { createPtyIo } from "../src/pty-io.ts";
import { Routing } from "../src/routing.ts";
import { createTypingIndicator } from "../src/typing-indicator.ts";
import { createThinkingPlaceholder } from "../src/thinking-placeholder.ts";

interface FakeTimer {
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

/** Same shape as rate-governor.test.ts's fake clock: an injectable scheduler, not just a fake
 * clock reader - pty-io.ts's SUBMIT_CONFIRM_WINDOW_MS/ECHO_SETTLE_MS waits are driven through this
 * rather than bare `setTimeout`, per the plan's Bun test-runner note (native fake-timer support
 * is thinner than Jest's, so a real scheduler substitute is needed, not `setSystemTime` alone). */
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
  return { setTimeoutFn, advance };
}

function fakeRoutingWithWrite(slug: string) {
  const routing = new Routing();
  const writes: string[] = [];
  routing.setPtyWrite(slug, (text: string) => writes.push(text));
  return { routing, writes };
}

describe("createPtyIo", () => {
  test("sendRaw writes the text then a trailing \\r", () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined,
      ptyLookup: { get: () => undefined },
    });

    ptyIo.sendRaw("fix-bug", "/model opus");
    expect(writes).toEqual(["/model opus", "\r"]);
  });

  test("sendRaw drops the command and logs when there's no live PTY for the slug", () => {
    const routing = new Routing();
    const logs: string[] = [];
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined,
      ptyLookup: { get: () => undefined },
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    });

    ptyIo.sendRaw("gone-slug", "/model opus");
    expect(logs).toEqual(['WARN: no live session for slug "gone-slug" - command dropped']);
  });

  test("sendEffortCommand writes the command, submits, then resends a confirming \\r after 200ms", () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined,
      ptyLookup: { get: () => undefined },
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    ptyIo.sendEffortCommand("fix-bug", "high");
    expect(writes).toEqual(["/effort high", "\r"]);
    scheduler.advance(200);
    expect(writes).toEqual(["/effort high", "\r", "\r"]);
  });

  test("confirmSubmitted does nothing further when real PTY activity happens after the echo settles", () => {
    const { routing } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    let activity: number | undefined;
    const writes: string[] = [];
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => activity,
      ptyLookup: { get: () => undefined },
      setTimeoutFn: scheduler.setTimeoutFn,
      echoSettleMs: 500,
      submitConfirmWindowMs: 2500,
    });

    ptyIo.confirmSubmitted("fix-bug", 2, (text) => writes.push(text));
    scheduler.advance(500); // echo settle window elapses - baseline taken here
    activity = Date.now() + 1; // real activity lands after the baseline
    scheduler.advance(2500); // submit-confirm window elapses
    expect(writes).toEqual([]); // no retry \r - the turn genuinely produced output
  });

  test("confirmSubmitted retries the \\r exactly once when no activity happens at all, then gives up and auto-recovers on a second silent window", () => {
    const { routing } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    const writes: string[] = [];
    let recovered = 0;
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined, // never any real activity - the wedged case
      ptyLookup: {
        get: () => ({
          kill: () => {
            recovered += 1;
          },
        }),
      },
      setTimeoutFn: scheduler.setTimeoutFn,
      echoSettleMs: 500,
      submitConfirmWindowMs: 2500,
    });

    ptyIo.confirmSubmitted("fix-bug", 2, (text) => writes.push(text));
    scheduler.advance(500); // echo settle
    scheduler.advance(2500); // first submit-confirm window - retries the \r
    expect(writes).toEqual(["\r"]);
    expect(recovered).toBe(0);

    scheduler.advance(500); // the retry's own echo settle
    scheduler.advance(2500); // second submit-confirm window - gives up and auto-recovers
    expect(writes).toEqual(["\r"]); // never a third \r - "gives up loudly instead"
    expect(recovered).toBe(1);
  });

  test("sendChannelText wraps the content in a channel tag with an incrementing seq, starts the indicators, and arms confirmSubmitted", () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    const typingStarts: string[] = [];
    const thinkingStarts: string[] = [];
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: { start: (t) => typingStarts.push(t), stop: () => {} },
      thinkingPlaceholder: { start: (t) => thinkingStarts.push(t), consume: async () => undefined },
      lastActivityAt: () => Date.now(), // real activity - confirmSubmitted's own retry path stays quiet
      ptyLookup: { get: () => undefined },
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    ptyIo.sendChannelText("fix-bug", 2, "hello", "msg-1", "telegram");
    ptyIo.sendChannelText("fix-bug", 2, "world", "msg-2", "telegram");

    expect(writes.length).toBe(4); // two (channel-tag, \r) pairs
    expect(writes[0]).toContain("hello");
    expect(writes[0]).toMatch(/seq="1"/);
    expect(writes[2]).toContain("world");
    expect(writes[2]).toMatch(/seq="2"/); // proves the counter increments across calls, not per-call-reset
    expect(typingStarts).toEqual(["2", "2"]);
    expect(thinkingStarts).toEqual(["2", "2"]);
  });

  test("sendChannelText drops the message and logs when there's no live PTY for the slug", () => {
    const routing = new Routing();
    const logs: string[] = [];
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined,
      ptyLookup: { get: () => undefined },
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    });

    ptyIo.sendChannelText("gone-slug", 2, "hello", "msg-1", "telegram");
    expect(logs).toEqual(['WARN: no live session for slug "gone-slug" - inbound message dropped']);
  });

  test("autoRecoverWedgedSession is a no-op (and logs nothing) when the slug has no tracked pty - a manual kill or real crash already raced it", () => {
    const logs: string[] = [];
    const ptyIo = createPtyIo({
      routing: new Routing(),
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined,
      ptyLookup: { get: () => undefined },
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    });

    ptyIo.autoRecoverWedgedSession("gone-slug");
    expect(logs).toEqual([]);
  });
});
