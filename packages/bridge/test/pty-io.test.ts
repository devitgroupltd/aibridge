import { describe, expect, test } from "bun:test";
import { chunkForPty, createPtyIo } from "../src/pty-io.ts";
import { createWedgedRecoveryMarks } from "../src/wedged-recovery.ts";
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

/**
 * A hand-operated stand-in for `waitForPtyQuiet` (P2-7). The echo-settle wait is a promise now, not
 * a `setTimeoutFn` window, and it reads a clock as well as scheduling - so the fake scheduler above
 * cannot drive it (a virtual clock paired with a real `Date.now` deadline never resolves). Holding
 * the gate open is also the only way to express "the echo is *still streaming*", which is the exact
 * state the finding is about.
 */
function makeQuietGate() {
  let pending: Array<(quiet: boolean) => void> = [];
  return {
    waitForPtyQuietFn: () => new Promise<boolean>((resolve) => pending.push(resolve)),
    waiting: () => pending.length,
    /** Resolves every open wait as "the PTY went quiet", then lets the continuations run. */
    release: async (quiet = true) => {
      const waiters = pending;
      pending = [];
      for (const resolve of waiters) resolve(quiet);
      await flush();
    },
  };
}

/** One turn of the real event loop - enough for the awaited continuations behind the gate to run.
 * A bare `await Promise.resolve()` only drains one microtask level and silently under-flushes. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
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
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
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
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    ptyIo.sendEffortCommand("fix-bug", "high");
    expect(writes).toEqual(["/effort high", "\r"]);
    scheduler.advance(200);
    expect(writes).toEqual(["/effort high", "\r", "\r"]);
  });

  test("confirmSubmitted does nothing further when real PTY activity happens after the Enter", () => {
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
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: scheduler.setTimeoutFn,
      submitConfirmWindowMs: 2500,
    });

    ptyIo.confirmSubmitted("fix-bug", 2, (text) => writes.push(text)); // baseline taken here
    activity = Date.now() + 1; // real activity lands after the baseline
    scheduler.advance(2500); // submit-confirm window elapses
    expect(writes).toEqual([]); // no retry \r - the turn genuinely produced output
  });

  test("confirmSubmitted retries the \\r exactly once when no activity happens at all, then gives up and auto-recovers on a second silent window", () => {
    const { routing } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    const writes: string[] = [];
    let recovered = 0;
    const marks = createWedgedRecoveryMarks();
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
      wedgedRecoveryMarks: marks,
      setTimeoutFn: scheduler.setTimeoutFn,
      submitConfirmWindowMs: 2500,
    });

    ptyIo.confirmSubmitted("fix-bug", 2, (text) => writes.push(text));
    scheduler.advance(2500); // first submit-confirm window - retries the \r
    expect(writes).toEqual(["\r"]);
    expect(recovered).toBe(0);

    scheduler.advance(2500); // second submit-confirm window - gives up and auto-recovers
    expect(writes).toEqual(["\r"]); // never a third \r - "gives up loudly instead"
    expect(recovered).toBe(1);
    // P0-8: the kill is only half the recovery - without the mark, the dying process's own
    // `SessionEnd` marks the row dead and `handleUnexpectedExit` refuses to resume it.
    expect(marks.isRecovering("fix-bug")).toBe(true);
  });

  // codebase-hardening-plan.md P2-7, reproduced live 2026-08-13 with a ~3.7KB message. The baseline
  // used to be taken on a fixed 500ms timer of `confirmSubmitted`'s own; a long echo is still
  // streaming at that point, so the rest of the echo counted as "the turn started" and the retry that
  // would have rescued the message never fired. That is strictly worse than having no detector at
  // all - the message was typed, never submitted, and nothing in the daemon ever said so.
  test("a message whose echo was the only activity still gets its retry, however long that echo ran", async () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    const gate = makeQuietGate();
    let activity = 1_000;
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => activity,
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: scheduler.setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
      echoSettleMs: 500,
      submitConfirmWindowMs: 2500,
    });

    ptyIo.sendChannelText("fix-bug", 2, "a very long message", "msg-1", "telegram");
    await flush();
    // The echo streams for a long time - real PTY output, none of it a sign the Enter landed.
    activity = 10_000;
    await gate.release(); // ...and then ends, and the Enter goes out into a genuinely quiet PTY
    scheduler.advance(2500); // nothing happens after it: the Enter was swallowed

    expect(writes).toHaveLength(3);
    expect(writes[1]).toBe("\r"); // the paced Enter
    expect(writes[2]).toBe("\r"); // the retry, which the old fixed-timer baseline suppressed
  });

  test("sendChannelText wraps the content in a channel tag with an incrementing seq, starts the indicators, and arms confirmSubmitted", async () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const scheduler = makeScheduler();
    const gate = makeQuietGate();
    const typingStarts: string[] = [];
    const thinkingStarts: string[] = [];
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: { start: (t) => typingStarts.push(t), stop: () => {} },
      thinkingPlaceholder: { start: (t) => thinkingStarts.push(t), consume: async () => undefined },
      lastActivityAt: () => Date.now(), // real activity - confirmSubmitted's own retry path stays quiet
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: scheduler.setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
    });

    ptyIo.sendChannelText("fix-bug", 2, "hello", "msg-1", "telegram");
    ptyIo.sendChannelText("fix-bug", 2, "world", "msg-2", "telegram");
    // Both bodies cannot be on the wire yet: the second is queued behind the first message's Enter.
    await flush();
    expect(writes.length).toBe(1);
    await gate.release(); // first message's echo settles -> its \r goes out, second body follows
    await gate.release(); // second message's echo settles -> its \r goes out

    expect(writes.length).toBe(4); // two (channel-tag, \r) pairs
    expect(writes[0]).toContain("hello");
    expect(writes[0]).toMatch(/seq="1"/);
    expect(writes[2]).toContain("world");
    expect(writes[2]).toMatch(/seq="2"/); // proves the counter increments across calls, not per-call-reset
    expect(typingStarts).toEqual(["2", "2"]);
    expect(thinkingStarts).toEqual(["2", "2"]);
  });

  // The wiring half of turn-start-watchdog.ts. Its own tests cover when it should fire; this one
  // exists so "the watchdog is correct but nothing ever arms it" cannot pass - the same failure mode
  // startup-gate-notice.ts had to be guarded against, and the one that makes a detector worthless.
  //
  // Armed *after* the Enter, not at call time: the second message's Enter is queued behind the
  // first's, so arming at call time would start the second window while the first message was still
  // being written, and measure a stretch of time the message had no chance to be submitted in.
  test("sendChannelText arms the turn-start watchdog, once per message, only after that message's Enter", async () => {
    const { routing } = fakeRoutingWithWrite("fix-bug");
    const gate = makeQuietGate();
    const armed: Array<{ slug: string; topicId: number }> = [];
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
      turnStartWatchdog: { arm: (slug, topicId) => armed.push({ slug, topicId }) },
    });

    ptyIo.sendChannelText("fix-bug", 2, "hello", "msg-1", "telegram");
    ptyIo.sendChannelText("fix-bug", 2, "world", "msg-2", "telegram");
    await flush();
    expect(armed).toEqual([]); // body written, Enter not out yet

    await gate.release();
    expect(armed).toEqual([{ slug: "fix-bug", topicId: 2 }]);

    await gate.release();
    expect(armed).toEqual([
      { slug: "fix-bug", topicId: 2 },
      { slug: "fix-bug", topicId: 2 },
    ]);
  });

  // A dead PTY returns early, before anything is written - so there is no Enter to watch and no
  // message in flight to report on. Arming there would produce a "your message never started a turn"
  // notice for a message that was never sent, on top of the `WARN` that already says so.
  test("a message dropped for want of a live PTY does not arm the watchdog", () => {
    const armed: string[] = [];
    const ptyIo = createPtyIo({
      routing: { getPtyWrite: () => undefined } as unknown as Parameters<typeof createPtyIo>[0]["routing"],
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      turnStartWatchdog: { arm: (slug) => armed.push(slug) },
    });

    ptyIo.sendChannelText("gone", 2, "hello", "msg-1", "telegram");

    expect(armed).toEqual([]);
  });

  // P2-7's primary fix. Measured over a full bridge.log, the same-tick `\r` failed to submit on 105
  // of 145 inbound messages: the TUI is still ingesting the body when the Enter arrives and swallows
  // it. `confirmSubmitted`'s retry rescued most of them 2.5s later - and past roughly 3KB, where the
  // echo also blinds the detector, rescued none of them.
  test("sendChannelText holds the Enter until the echo of its own body has finished", async () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const gate = makeQuietGate();
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: makeScheduler().setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
    });

    ptyIo.sendChannelText("fix-bug", 2, "hello", "msg-1", "telegram");
    await flush();

    // The body is out; the Enter is not, and is waiting on the PTY going quiet rather than racing it.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("hello");
    expect(gate.waiting()).toBe(1);

    await gate.release();
    expect(writes[1]).toBe("\r");
  });

  test("a PTY that never goes quiet still gets its Enter once the wait times out", async () => {
    // The wait is bounded, and a timeout resolves `false` rather than rejecting. An interjection into
    // a running turn is exactly this case - it must still be submitted, just not sooner than it can be.
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const gate = makeQuietGate();
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: makeScheduler().setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
    });

    ptyIo.sendChannelText("fix-bug", 2, "are you still there", "msg-1", "telegram");
    await flush();
    await gate.release(false); // never went quiet - gave up and proceeded

    expect(writes[1]).toBe("\r");
  });

  test("two messages sent back to back never interleave into one prompt", async () => {
    // The body and the Enter are no longer in the same tick, so without a per-slug queue the writes
    // could land as body-1, body-2, \r, \r - submitting both as a single prompt and then pressing
    // Enter on an empty composer.
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const gate = makeQuietGate();
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: makeScheduler().setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
    });

    ptyIo.sendChannelText("fix-bug", 2, "first", "msg-1", "telegram");
    ptyIo.sendChannelText("fix-bug", 2, "second", "msg-2", "telegram");
    await flush();
    await gate.release();
    await gate.release();

    expect(writes).toHaveLength(4);
    expect(writes[0]).toContain("first");
    expect(writes[1]).toBe("\r");
    expect(writes[2]).toContain("second");
    expect(writes[3]).toBe("\r");
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
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    });

    ptyIo.sendChannelText("gone-slug", 2, "hello", "msg-1", "telegram");
    expect(logs).toEqual(['WARN: no live session for slug "gone-slug" - inbound message dropped']);
  });

  // P2-7's second half. A single large write loses its *middle*: measured live at 3.7KB, the session
  // got the first ~200 characters and the last ~350 and said so itself ("after C03 it jumps straight
  // to C71"). Head-and-tail-survive is the signature of a bounded input buffer overrunning, and
  // nothing upstream notices - `write()` succeeds and the message is simply missing a chunk by the
  // time Claude reads it.
  test("sendChannelText paces a long body across several writes, waiting for each chunk's echo", async () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const gate = makeQuietGate();
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: makeScheduler().setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
      writeChunkChars: 100,
    });

    ptyIo.sendChannelText("fix-bug", 2, "x".repeat(450), "msg-1", "telegram");
    await flush();
    // Exactly one chunk is on the wire, and the next is genuinely blocked on the first one's echo
    // rather than merely scheduled - a timer-paced version would pass this by advancing a clock.
    expect(writes).toHaveLength(1);
    expect(gate.waiting()).toBe(1);

    // Each release lets one more chunk through. The body is 450 chars of `x` plus the channel tag,
    // so the number of chunks depends on the tag's own length - drain until the Enter appears.
    for (let i = 0; i < 40 && writes[writes.length - 1] !== "\r"; i++) await gate.release();

    const enter = writes.pop();
    expect(enter).toBe("\r");
    expect(writes.length).toBeGreaterThan(1);
    // Nothing lost, nothing duplicated, nothing reordered - the whole point.
    expect(writes.join("")).toContain("x".repeat(450));
    expect(writes.every((chunk) => Array.from(chunk).length <= 100)).toBe(true);
  });

  test("a short body is still a single write with no per-chunk wait at all", async () => {
    const { routing, writes } = fakeRoutingWithWrite("fix-bug");
    const gate = makeQuietGate();
    const ptyIo = createPtyIo({
      routing,
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => Date.now(),
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      setTimeoutFn: makeScheduler().setTimeoutFn,
      waitForPtyQuietFn: gate.waitForPtyQuietFn,
      writeChunkChars: 4000,
    });

    ptyIo.sendChannelText("fix-bug", 2, "hello", "msg-1", "telegram");
    await flush();

    expect(writes).toHaveLength(1);
    // One wait, and it is the pre-Enter one - the common case pays nothing for the chunk pacing.
    expect(gate.waiting()).toBe(1);
    await gate.release();
    expect(writes[1]).toBe("\r");
  });

  describe("chunkForPty", () => {
    test("returns the text as a single chunk when it fits, and nothing at all when empty", () => {
      expect(chunkForPty("short", 400)).toEqual(["short"]);
      expect(chunkForPty("", 400)).toEqual([]);
      // The exact-fit boundary: 400 characters is not 401, and must not split.
      expect(chunkForPty("a".repeat(400), 400)).toEqual(["a".repeat(400)]);
    });

    test("splits into ordered chunks that reassemble to exactly the input", () => {
      const text = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join("");
      const chunks = chunkForPty(text, 128);

      expect(chunks.length).toBe(8);
      expect(chunks.join("")).toBe(text);
      expect(chunks.slice(0, -1).every((c) => c.length === 128)).toBe(true);
    });

    test("never splits a surrogate pair", () => {
      // A boundary falling inside a pair would not throw - it would put a replacement character in
      // the middle of the operator's own message, which reads as a typo rather than as a bug.
      const text = "a" + "😀".repeat(10); // 1 + 20 UTF-16 units, 11 code points
      const chunks = chunkForPty(text, 3);

      expect(chunks.join("")).toBe(text);
      expect(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c))).toBe(true);
      expect(chunks.every((c) => !/^[\uDC00-\uDFFF]/.test(c))).toBe(true);
      expect(chunks.every((c) => Array.from(c).length <= 3)).toBe(true);
    });

    test("a non-positive chunk size means no chunking rather than an infinite loop", () => {
      expect(chunkForPty("abc", 0)).toEqual(["abc"]);
      expect(chunkForPty("abc", -1)).toEqual(["abc"]);
    });
  });

  test("autoRecoverWedgedSession is a no-op (and logs nothing) when the slug has no tracked pty - a manual kill or real crash already raced it", () => {
    const logs: string[] = [];
    const ptyIo = createPtyIo({
      routing: new Routing(),
      typingIndicator: createTypingIndicator({ send: async () => {} }),
      thinkingPlaceholder: createThinkingPlaceholder({ send: async () => 1 }),
      lastActivityAt: () => undefined,
      ptyLookup: { get: () => undefined },
      wedgedRecoveryMarks: createWedgedRecoveryMarks(),
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    });

    ptyIo.autoRecoverWedgedSession("gone-slug");
    expect(logs).toEqual([]);
  });
});
