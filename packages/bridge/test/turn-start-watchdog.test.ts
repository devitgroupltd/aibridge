import { describe, expect, test } from "bun:test";
import type { SessionState } from "../src/session-store.ts";
import { createTurnStartWatchdog, renderNoTurnStartedNotice } from "../src/turn-start-watchdog.ts";

/** A hand-driven scheduler: `fire()` runs every timer armed so far, so no test waits real time. */
function harness(state: SessionState | undefined = "idle") {
  const fired: Array<{ slug: string; topicId: number }> = [];
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  let current: SessionState | undefined = state;
  const watchdog = createTurnStartWatchdog({
    getState: () => current,
    onNoTurnStarted: (slug, topicId) => fired.push({ slug, topicId }),
    timeoutMs: 20_000,
    setTimeoutFn: (fn) => {
      const handle = nextHandle++;
      timers.set(handle, fn);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      timers.delete(handle as number);
    },
  });
  return {
    watchdog,
    fired,
    setState: (next: SessionState | undefined) => {
      current = next;
    },
    fire: () => {
      for (const fn of [...timers.values()]) fn();
      timers.clear();
    },
    liveTimers: () => timers.size,
  };
}

describe("createTurnStartWatchdog", () => {
  // The case the whole module exists for: the message was written, no `UserPromptSubmit` ever came,
  // and the session sat there still idle. Every live instance so far (an MCP consent dialog, the
  // startup-gate write, `/auto-mode-setup`) looks exactly like this from the Bridge's side.
  test("fires when a written message never became a turn", () => {
    const h = harness("idle");
    h.watchdog.arm("fix-bug", 5);
    h.fire();
    expect(h.fired).toEqual([{ slug: "fix-bug", topicId: 5 }]);
  });

  test("a UserPromptSubmit disarms it, and nothing is reported", () => {
    const h = harness("idle");
    h.watchdog.arm("fix-bug", 5);
    h.watchdog.turnStarted("fix-bug");
    h.setState("working");
    h.fire();
    expect(h.fired).toEqual([]);
    expect(h.watchdog.pendingCount()).toBe(0);
  });

  // Load-bearing, and the difference between a useful check and one that cries wolf on every
  // follow-up message. Claude Code queues a message sent mid-turn and fires `UserPromptSubmit` for it
  // only once the running turn ends - which can be minutes.
  test("never arms for a session that is mid-turn", () => {
    const h = harness("working");
    h.watchdog.arm("fix-bug", 5);
    expect(h.watchdog.pendingCount()).toBe(0);
    h.fire();
    expect(h.fired).toEqual([]);
  });

  test("never arms for a session parked on a permission or question card", () => {
    const h = harness("awaiting_input");
    h.watchdog.arm("fix-bug", 5);
    expect(h.watchdog.pendingCount()).toBe(0);
  });

  // The second guard, at fire time rather than arm time. A `turnStarted` that never arrived (a
  // dropped hook, a lost race) still leaves the row in `working`, and the row is the more reliable
  // witness of the two - so it gets the last word and the operator is not told about a session that
  // is visibly running.
  test("stays silent when the row moved on even though turnStarted was never called", () => {
    const h = harness("idle");
    h.watchdog.arm("fix-bug", 5);
    h.setState("working");
    h.fire();
    expect(h.fired).toEqual([]);
  });

  test("stays silent for a session that died or was removed inside the window", () => {
    for (const state of ["dead", undefined] as const) {
      const h = harness("idle");
      h.watchdog.arm("fix-bug", 5);
      h.setState(state);
      h.fire();
      expect(h.fired).toEqual([]);
    }
  });

  // One notice per stuck terminal, not one per message: a second message replaces the pending watch
  // rather than stacking beside it.
  test("a second message replaces the pending watch instead of queueing another", () => {
    const h = harness("idle");
    h.watchdog.arm("fix-bug", 5);
    h.watchdog.arm("fix-bug", 5);
    h.watchdog.arm("fix-bug", 5);
    expect(h.watchdog.pendingCount()).toBe(1);
    h.fire();
    expect(h.fired).toHaveLength(1);
  });

  test("slugs are watched independently", () => {
    const h = harness("idle");
    h.watchdog.arm("a", 1);
    h.watchdog.arm("b", 2);
    h.watchdog.turnStarted("a");
    h.fire();
    expect(h.fired).toEqual([{ slug: "b", topicId: 2 }]);
  });

  test("forget drops a pending watch without firing", () => {
    const h = harness("idle");
    h.watchdog.arm("fix-bug", 5);
    h.watchdog.forget("fix-bug");
    h.fire();
    expect(h.fired).toEqual([]);
    expect(h.liveTimers()).toBe(0);
  });
});

describe("renderNoTurnStartedNotice", () => {
  test("says what happened, shows the terminal, and names a recovery reachable from a phone", () => {
    const text = renderNoTurnStartedNotice("fix-bug", "New MCP server found in this project: trello\n1. Use this MCP server", 20_000);
    expect(text).toContain('"fix-bug" but never started a turn');
    expect(text).toContain("nothing was submitted in 20s");
    // The tail is the diagnosis - without it the operator is told only that something went wrong.
    expect(text).toContain("New MCP server found in this project: trello");
    // `/stop` writes a bare ESC, which is the exit every dialog seen so far offers.
    expect(text).toContain("/stop fix-bug");
    expect(text).toContain("ESC");
  });

  test("an empty tail still produces a usable message", () => {
    const text = renderNoTurnStartedNotice("fix-bug", "   ", 20_000);
    expect(text).toContain("(no output captured yet)");
  });

  // P1-10, inherited rather than re-implemented. A notice about a session that has gone silent, which
  // is itself rejected by Telegram for being too long, produces exactly the silence it exists to
  // break - and a failed send is only a log line. The `&` tail is the worst case: `escapeForFeed`
  // expands each one 5x.
  test("a huge tail is trimmed to fit Telegram, and never through an HTML entity", () => {
    // Every character escapes to `&amp;` (5x expansion), so a correct trim can only ever leave a run
    // of *whole* `&amp;` sequences. A slice through one leaves a leading `mp;`/`p;`/`;`, which
    // Telegram rejects with "can't parse entities" - swapping a too-long failure for a
    // malformed-HTML one, which is how P1-10's fix earned its own doc comment.
    const text = renderNoTurnStartedNotice("fix-bug", "&".repeat(4000), 20_000);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("trimmed to fit");

    const body = text.slice(text.indexOf("<pre>") + "<pre>".length, text.indexOf("</pre>")).replace("... (earlier output trimmed to fit)\n", "");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/^(&amp;)+$/);
  });

  test("the slug is escaped, so a slug with markup cannot break the HTML", () => {
    const text = renderNoTurnStartedNotice("a<b>c", "tail", 20_000);
    expect(text).toContain("a&lt;b&gt;c");
    expect(text).not.toContain("<b>");
  });
});
