import { describe, expect, test } from "bun:test";
import { createFeedWiring } from "../src/feed-wiring.ts";
import { DetailsAnchorStore } from "../src/details-anchor-store.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { Routing } from "../src/routing.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import type { HookEventMessage } from "@aibridge/protocol";
import type { PendingPermissionRequest } from "../src/permission-registry.ts";
import { createWedgedRecoveryMarks } from "../src/wedged-recovery.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-1",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "starting",
    turnCardMsg: null,
    thinkingPlaceholderMsg: null,
    paused: false,
    feedDetail: "compact",
    feedVerbose: false,
    bypassPermission: false,
    autoAnswer: false,
    mode: "manual",
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function hookMsg(overrides: Partial<HookEventMessage> = {}): HookEventMessage {
  return {
    v: 1,
    slug: "fix-bug",
    type: "event",
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-1",
    payload: {},
    ...overrides,
  };
}

function fakeSendMessageSource() {
  const sent: Array<{ chatId: unknown; topicId: number | undefined; text: string }> = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  return {
    sendMessage: async (chatId: unknown, topicId: number | undefined, text: string) => {
      sent.push({ chatId, topicId, text });
      return { message_id: sent.length };
    },
    editMessageText: async (_chatId: unknown, messageId: number, text: string) => {
      edits.push({ messageId, text });
    },
    sent,
    edits,
  };
}

function setup(overrides: Partial<Parameters<typeof createFeedWiring>[0]> = {}) {
  const sessionStore = new SessionStore(":memory:");
  const routing = new Routing();
  const detailsAnchorStore = new DetailsAnchorStore(":memory:");
  const feedGovernor = new RateGovernor({ log: () => {} });
  const controlBot = fakeSendMessageSource();
  const feedBot = fakeSendMessageSource();
  const confirmCalls: Array<{ topicId: number | undefined; text: string }> = [];
  const quotaStoppedSlugs: string[] = [];
  const verdicts: Array<{ slug: string; requestId: string; behavior: string }> = [];
  const finalized: Array<{ messageId: number; text: string }> = [];
  const typingStops: string[] = [];
  const noReplyNudges: Array<{ slug: string; topicId: number; content: string }> = [];
  const wedgedRecoveryMarks = createWedgedRecoveryMarks();
  let permissionToResolve: PendingPermissionRequest | undefined;

  const feedWiring = createFeedWiring({
    sessionStore,
    routing,
    detailsAnchorStore,
    feedGovernor,
    controlBot,
    feedBot,
    supergroupChatId: "-100",
    confirmSessionCommand: (topicId, text) => confirmCalls.push({ topicId, text }),
    markQuotaStopped: (slug) => quotaStoppedSlugs.push(slug),
    resolveByToolMatch: () => permissionToResolve,
    sendVerdict: (slug, requestId, behavior) => {
      verdicts.push({ slug, requestId, behavior });
      return true;
    },
    finalizePermissionMessage: async (messageId, text) => {
      finalized.push({ messageId, text });
    },
    typingIndicator: {
      start: () => {},
      stop: (topicId) => typingStops.push(topicId),
    },
    sendNoReplyNudge: (slug, topicId, content) => noReplyNudges.push({ slug, topicId, content }),
    wedgedRecoveryMarks,
    ...overrides,
  });

  return {
    feedWiring,
    sessionStore,
    routing,
    controlBot,
    feedBot,
    confirmCalls,
    quotaStoppedSlugs,
    verdicts,
    finalized,
    typingStops,
    noReplyNudges,
    wedgedRecoveryMarks,
    setPermissionToResolve: (p: PendingPermissionRequest | undefined) => {
      permissionToResolve = p;
    },
  };
}

describe("createFeedWiring", () => {
  test("maybeSetState applies a valid transition and is a no-op for an invalid one", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row({ state: "idle" }));

    feedWiring.maybeSetState("fix-bug", "working");
    expect(sessionStore.get("fix-bug")?.state).toBe("working");

    // idle -> awaiting_input is not a valid transition (isValidTransition's own table) - working
    // is already current, so this checks the *unreachable* transition is rejected, not a same-state
    // no-op.
    feedWiring.maybeSetState("fix-bug", "starting");
    expect(sessionStore.get("fix-bug")?.state).toBe("working");
  });

  test("maybeSetState is a no-op for an unknown slug", () => {
    const { feedWiring, sessionStore } = setup();
    feedWiring.maybeSetState("no-such-slug", "working");
    expect(sessionStore.get("no-such-slug")).toBeUndefined();
  });

  test("handleHookEvent resolves a pending permission via the terminal-race fix when a matching PostToolUse arrives", () => {
    const { feedWiring, sessionStore, verdicts, finalized, setPermissionToResolve } = setup();
    sessionStore.insert(row());
    setPermissionToResolve({
      requestId: "req-1",
      slug: "fix-bug",
      toolName: "Bash",
      description: "run a command",
      inputPreview: "npm test",
      topicId: 2,
      messageId: 55,
      createdAt: Date.now(),
    });

    feedWiring.handleHookEvent(
      hookMsg({
        hook_event_name: "PostToolUse",
        payload: { tool_use_id: "tu-1", tool_name: "Bash", tool_input: {} },
      }),
    );

    expect(verdicts).toEqual([{ slug: "fix-bug", requestId: "req-1", behavior: "allow" }]);
    expect(finalized.length).toBe(1);
    expect(finalized[0]?.text).toContain("✅ Allowed");
  });

  // turn-start-watchdog.ts's disarm half. `UserPromptSubmit` is the *only* event that means "Claude
  // Code accepted this text as a prompt", which is the exact claim the watchdog is waiting to have
  // retracted - so it is wired to that hook rather than to the `working` transition, which the
  // permission relay also drives from a button tap.
  test("handleHookEvent reports a started turn on UserPromptSubmit, and on nothing else", () => {
    const started: string[] = [];
    const { feedWiring, sessionStore } = setup({ onTurnStarted: (slug) => started.push(slug) });
    sessionStore.insert(row());

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionStart", payload: {} }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "PreToolUse", payload: { tool_name: "Bash", tool_input: {} } }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop", payload: {} }));
    expect(started).toEqual([]);

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit", payload: { prompt: "hello" } }));
    expect(started).toEqual(["fix-bug"]);
  });

  test("handleHookEvent sends a deny verdict for PermissionDenied", () => {
    const { feedWiring, sessionStore, verdicts, finalized, setPermissionToResolve } = setup();
    sessionStore.insert(row());
    setPermissionToResolve({
      requestId: "req-1",
      slug: "fix-bug",
      toolName: "Bash",
      description: "run a command",
      inputPreview: "npm test",
      topicId: 2,
      messageId: 55,
      createdAt: Date.now(),
    });

    feedWiring.handleHookEvent(
      hookMsg({
        hook_event_name: "PermissionDenied",
        payload: { tool_name: "Bash" },
      }),
    );

    expect(verdicts).toEqual([{ slug: "fix-bug", requestId: "req-1", behavior: "deny" }]);
    expect(finalized[0]?.text).toContain("⛔ Denied");
  });

  // 2026-08-13: the terminal-race path resolved the prompt but never moved the row, because the
  // `maybeSetState(..., "working")` that does it lived only on the button-tap path in
  // `callback-query-router.ts`. The session then ran on with `/ls` reporting it blocked.
  test("handleHookEvent moves the row out of awaiting_input when the terminal-race fix resolves a permission", () => {
    const { feedWiring, sessionStore, setPermissionToResolve } = setup();
    sessionStore.insert(row({ state: "working" }));
    sessionStore.setState("fix-bug", "awaiting_input", "2026-08-13T00:00:00.000Z");
    setPermissionToResolve({
      requestId: "req-1",
      slug: "fix-bug",
      toolName: "Bash",
      description: "run a command",
      inputPreview: "npm test",
      topicId: 2,
      messageId: 55,
      createdAt: Date.now(),
    });

    feedWiring.handleHookEvent(
      hookMsg({ hook_event_name: "PostToolUse", payload: { tool_use_id: "tu-1", tool_name: "Bash", tool_input: {} } }),
    );

    expect(sessionStore.get("fix-bug")?.state).toBe("working");
  });

  // P0-8, found live 2026-08-13. The order below is the entire test: `SessionEnd` has to arrive
  // *after* the recovery kill and *before* the exit handler, which is what actually happened live
  // (33ms end to end). Marking the row dead there makes `handleUnexpectedExit` bail on its own
  // "already dead" guard, so the kill that exists purely to trigger a resume produces a permanently
  // dead session instead - and `dead` is terminal, so nothing downstream can undo it.
  test("handleHookEvent leaves the row alive for the SessionEnd of the Bridge's own wedged-recovery kill", () => {
    const { feedWiring, sessionStore, wedgedRecoveryMarks } = setup();
    sessionStore.insert(row({ state: "starting" }));
    sessionStore.setState("fix-bug", "idle", "2026-08-13T00:00:00.000Z");

    wedgedRecoveryMarks.mark("fix-bug"); // `recoverWedgedPty` does this immediately before kill()
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionEnd", payload: { reason: "other" } }));

    expect(sessionStore.get("fix-bug")?.state).toBe("idle");
  });

  test("handleHookEvent still marks the row dead for a SessionEnd with no recovery in flight", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row({ state: "starting" }));
    sessionStore.setState("fix-bug", "idle", "2026-08-13T00:00:00.000Z");

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionEnd", payload: { reason: "other" } }));

    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
  });

  test("the recovery mark shields one slug's SessionEnd without shielding another session's", () => {
    const { feedWiring, sessionStore, wedgedRecoveryMarks } = setup();
    sessionStore.insert(row({ slug: "fix-bug", state: "starting" }));
    sessionStore.insert(row({ slug: "other-task", topicId: 3, sessionId: "sess-2", state: "starting" }));
    sessionStore.setState("fix-bug", "idle", "2026-08-13T00:00:00.000Z");
    sessionStore.setState("other-task", "idle", "2026-08-13T00:00:00.000Z");

    wedgedRecoveryMarks.mark("fix-bug");
    feedWiring.handleHookEvent(hookMsg({ slug: "fix-bug", hook_event_name: "SessionEnd", payload: { reason: "other" } }));
    feedWiring.handleHookEvent(hookMsg({ slug: "other-task", hook_event_name: "SessionEnd", payload: { reason: "other" } }));

    expect(sessionStore.get("fix-bug")?.state).toBe("idle");
    expect(sessionStore.get("other-task")?.state).toBe("dead");
  });

  // The mark must not outlive the recovery it was written for: once the successor process announces
  // itself, a *genuine* exit right afterwards has to be able to mark the row dead again. Without
  // this clear, only the 30s TTL would eventually let that happen.
  test("a successor SessionStart clears the recovery mark, so the next real SessionEnd marks the row dead", () => {
    const { feedWiring, sessionStore, wedgedRecoveryMarks } = setup();
    sessionStore.insert(row({ state: "starting" }));
    sessionStore.setState("fix-bug", "idle", "2026-08-13T00:00:00.000Z");

    wedgedRecoveryMarks.mark("fix-bug");
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionEnd", payload: { reason: "other" } }));
    expect(sessionStore.get("fix-bug")?.state).toBe("idle");

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionStart", session_id: "sess-2" }));
    expect(wedgedRecoveryMarks.isRecovering("fix-bug")).toBe(false);

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionEnd", payload: { reason: "other" } }));
    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
  });

  // 2026-08-13: `awaiting_input` had no `idle` edge, so a turn-ending `Stop` arriving while a
  // resolved-but-unannounced prompt was still on the row was rejected - silently, since
  // `maybeSetState` only logs writes that succeed. The row stayed `awaiting_input` indefinitely.
  test("handleHookEvent applies a turn-ending Stop that arrives while the row still says awaiting_input", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row({ state: "working" }));
    sessionStore.setState("fix-bug", "awaiting_input", "2026-08-13T00:00:00.000Z");

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop", payload: {} }));

    expect(sessionStore.get("fix-bug")?.state).toBe("idle");
  });

  // 0.101.0: `SessionStore.setSessionId` existed and was unit-tested in isolation, but nothing in
  // production ever called it - `handleHookEvent` is the only place a live `session_id` from
  // Claude Code ever reaches the Bridge. Live-observed 2026-08-08: every session's `row.sessionId`
  // stayed permanently null, so `claude --resume <id>` (session-supervisor.ts) always found nothing
  // to resume, killing the session on every Bridge restart with "no session id was recorded yet"
  // instead of actually resuming it.
  test("handleHookEvent persists session_id from a SessionStart hook", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row({ sessionId: null }));

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionStart", session_id: "claude-sess-abc" }));

    expect(sessionStore.get("fix-bug")?.sessionId).toBe("claude-sess-abc");
  });

  test("handleHookEvent re-recording the same session_id on a resumed SessionStart is a harmless no-op", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row({ sessionId: "claude-sess-abc" }));

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionStart", session_id: "claude-sess-abc" }));

    expect(sessionStore.get("fix-bug")?.sessionId).toBe("claude-sess-abc");
  });

  test("handleHookEvent does not persist session_id for an unknown slug", () => {
    const { feedWiring, sessionStore } = setup();
    // No insert() - "fix-bug" is not a tracked session.

    expect(() => feedWiring.handleHookEvent(hookMsg({ hook_event_name: "SessionStart", session_id: "claude-sess-abc" }))).not.toThrow();
    expect(sessionStore.get("fix-bug")).toBeUndefined();
  });

  test("handleHookEvent ignores session_id on hook events other than SessionStart", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row({ sessionId: "sess-1" }));

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit", session_id: "some-other-id" }));

    expect(sessionStore.get("fix-bug")?.sessionId).toBe("sess-1");
  });

  test("handleHookEvent does nothing extra when no pending permission matches", () => {
    const { feedWiring, sessionStore, verdicts, finalized } = setup();
    sessionStore.insert(row());

    feedWiring.handleHookEvent(
      hookMsg({
        hook_event_name: "PostToolUse",
        payload: { tool_use_id: "tu-1", tool_name: "Bash" },
      }),
    );

    expect(verdicts).toEqual([]);
    expect(finalized).toEqual([]);
  });

  test("handleHookEvent calls markQuotaStopped on a StopFailure whose error names a rate/usage limit", () => {
    const { feedWiring, sessionStore, quotaStoppedSlugs } = setup();
    sessionStore.insert(row());

    feedWiring.handleHookEvent(
      hookMsg({
        hook_event_name: "StopFailure",
        payload: { error: "rate limit exceeded, try again later" },
      }),
    );

    expect(quotaStoppedSlugs).toEqual(["fix-bug"]);
  });

  test("handleHookEvent does not call markQuotaStopped for an unrelated StopFailure", () => {
    const { feedWiring, sessionStore, quotaStoppedSlugs } = setup();
    sessionStore.insert(row());

    feedWiring.handleHookEvent(
      hookMsg({
        hook_event_name: "StopFailure",
        payload: { error: "network timeout" },
      }),
    );

    expect(quotaStoppedSlugs).toEqual([]);
  });

  test("handleHookEvent's turn_start posts a details button and starts a fresh feed-state entry", async () => {
    const { feedWiring, sessionStore, routing, controlBot } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(controlBot.sent.length).toBe(1);
    expect(controlBot.sent[0]?.text).toContain("Details");
    expect(feedWiring.getFeedState("fix-bug")).toBeDefined();
  });

  test("markInterjected/getFeedState/allFeedStates/forgetSession round-trip", () => {
    const { feedWiring, sessionStore } = setup();
    sessionStore.insert(row());
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));

    expect(feedWiring.getFeedState("fix-bug")).toBeDefined();
    expect(feedWiring.allFeedStates().get("fix-bug")).toBe(feedWiring.getFeedState("fix-bug"));

    feedWiring.markInterjected("fix-bug"); // no observable state here beyond not throwing - the
    // effect is consumed internally by the next coalescer flush, already covered by feed-coalescer.test.ts

    feedWiring.forgetSession("fix-bug");
    expect(feedWiring.getFeedState("fix-bug")).toBeUndefined();
  });

  test("checkQuietMode posts once on the rising edge and resets on the falling edge, per feedGovernor.p2PressureExceeded()", () => {
    let quiet = false;
    const fakeGovernor = {
      p2PressureExceeded: () => quiet,
      schedule: () => Promise.resolve(),
      scheduleAsync: () => Promise.resolve({ message_id: 1 }),
    } as unknown as RateGovernor;
    const { feedWiring, confirmCalls } = setup({ feedGovernor: fakeGovernor });

    feedWiring.checkQuietMode();
    expect(confirmCalls.length).toBe(0);

    quiet = true;
    feedWiring.checkQuietMode();
    feedWiring.checkQuietMode(); // still quiet - must not notify a second time
    expect(confirmCalls.length).toBe(1);

    quiet = false;
    feedWiring.checkQuietMode(); // clears the flag, no new notice
    expect(confirmCalls.length).toBe(1);

    quiet = true;
    feedWiring.checkQuietMode(); // a later, separate storm notifies again
    expect(confirmCalls.length).toBe(2);
  });

  test("Stop stops the typing indicator even when the turn never replied", () => {
    const { feedWiring, sessionStore, routing, typingStops } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" }));

    expect(typingStops).toEqual(["2"]);
  });

  test("Stop sends the no-reply nudge exactly once when a turn never called reply()", () => {
    const { feedWiring, sessionStore, routing, noReplyNudges, confirmCalls } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" }));

    expect(noReplyNudges.length).toBe(1);
    expect(noReplyNudges[0]).toEqual({ slug: "fix-bug", topicId: 2, content: expect.stringContaining("Reply now") });
    expect(confirmCalls).toEqual([]);
  });

  test("Stop does not nudge when markReplied fired for the current turn", () => {
    const { feedWiring, sessionStore, routing, noReplyNudges } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.markReplied("fix-bug");
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" }));

    expect(noReplyNudges).toEqual([]);
  });

  test("a second consecutive silent Stop posts a give-up warning instead of nudging again", () => {
    const { feedWiring, sessionStore, routing, noReplyNudges, confirmCalls } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" })); // 1st silent turn - nudged
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" })); // the nudge's own turn
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" })); // also silent - give up instead

    expect(noReplyNudges.length).toBe(1);
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]?.text).toContain("2 times in a row");
  });

  test("markReplied resets the silent-stop streak so a later silent Stop nudges again", () => {
    const { feedWiring, sessionStore, routing, noReplyNudges } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" })); // 1st silent turn - nudged
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.markReplied("fix-bug"); // this turn actually replied
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" })); // silent again - streak restarted at 1

    expect(noReplyNudges.length).toBe(2);
  });

  // Regression: slugs are derived from prompt text and reused after `/rm` - without clearing
  // `silentStopStreak` in `forgetSession`, a brand-new session reusing the same slug would inherit
  // the removed session's streak count and skip straight to the give-up warning on its own very
  // first silent turn (same leak class as codebase-hardening-plan.md's P1-2).
  test("forgetSession clears the silent-stop streak so a slug reused after /rm starts fresh", () => {
    const { feedWiring, sessionStore, routing, noReplyNudges, confirmCalls } = setup();
    sessionStore.insert(row());
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });

    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" })); // 1st silent turn - nudged
    expect(noReplyNudges.length).toBe(1);

    // /rm's teardown
    feedWiring.forgetSession("fix-bug");
    sessionStore.remove("fix-bug");

    // A brand-new session reusing the same slug (a distinct session_id, same as a real resumed PTY)
    sessionStore.insert(row({ sessionId: "sess-2" }));
    routing.add({ slug: "fix-bug", topicId: 2, worktreePath: "c:\\data\\worktrees\\fix-bug" });
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "UserPromptSubmit" }));
    feedWiring.handleHookEvent(hookMsg({ hook_event_name: "Stop" })); // silent again - should nudge, not give up

    expect(noReplyNudges.length).toBe(2);
    expect(confirmCalls).toEqual([]);
  });

  test("markReplied on a slug with no tracked feed state is a no-op, not a throw", () => {
    const { feedWiring } = setup();
    expect(() => feedWiring.markReplied("no-such-slug")).not.toThrow();
  });
});
