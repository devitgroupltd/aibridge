import { describe, expect, test } from "bun:test";
import { createFeedWiring } from "../src/feed-wiring.ts";
import { DetailsAnchorStore } from "../src/details-anchor-store.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { Routing } from "../src/routing.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import type { HookEventMessage } from "@aibridge/protocol";
import type { PendingPermissionRequest } from "../src/permission-registry.ts";

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
    paused: false,
    renamed: false,
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
