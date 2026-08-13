import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { AskRegistry } from "../src/ask-registry.ts";
import { CostTracker } from "../src/cost-tracker.ts";
import { FleetConfirmRegistry } from "../src/fleet-confirm.ts";
import { PermissionRegistry } from "../src/permission-registry.ts";
import { ReposRegistry } from "../src/repos-registry.ts";
import { Routing } from "../src/routing.ts";
import { abandonHalfBuiltSession, applyPendingAttachment, createSessionLifecycleCommands, ORPHAN_TOPIC_NOTE, type NewSessionTeardownDeps } from "../src/session-lifecycle-commands.ts";
import { isValidTransition, SessionStore, type SessionRow, type SessionState } from "../src/session-store.ts";
import { fakeControlBot, testRuntimeSettings } from "./helpers.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 5,
    sessionId: "sess-1",
    worktreePath: "c:\\does\\not\\exist\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\does\\not\\exist\\repo",
    model: "sonnet",
    ptyPid: 1234,
    state: "working",
    turnCardMsg: null,
    thinkingPlaceholderMsg: null,
    paused: false,
    feedDetail: "compact",
    feedVerbose: false,
    bypassPermission: false,
    autoAnswer: false,
    mode: "manual",
    createdUtc: "2026-08-08T00:00:00.000Z",
    lastEventUtc: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

/** The shared double (helpers.ts) plus the forum-topic calls `/new` and `/rm` make. */
function fakeLifecycleBot() {
  const forumTopicCalls = { closed: [] as number[], deleted: [] as number[] };
  return {
    ...fakeControlBot(),
    createForumTopic: async () => ({ message_thread_id: 999 }),
    editForumTopic: async () => {},
    closeForumTopic: async (_chatId: unknown, topicId: number) => {
      forumTopicCalls.closed.push(topicId);
    },
    deleteForumTopic: async (_chatId: unknown, topicId: number) => {
      forumTopicCalls.deleted.push(topicId);
    },
    forumTopicCalls,
  };
}

function fakeSessionSupervisor() {
  const calls = { killAndUntrack: [] as string[], untrack: [] as string[] };
  return {
    isPidAlive: () => false,
    // Default: no topic is ever deleted, i.e. every row survives unchanged - matches every existing
    // test's assumption that `/resume` reaches `resumeSession`. Tests exercising the deleted-topic
    // path override this per-case.
    reapRowsWithDeletedTopics: async (rows: SessionRow[]) => rows,
    reportOrphanProcesses: async () => {},
    runStartupReconciliation: async () => {},
    wireSession: () => {},
    handleUnexpectedExit: async () => {},
    resumeSession: async (_row: SessionRow) => {},
    getPtyProcess: () => undefined,
    killAndUntrack: (slug: string) => {
      calls.killAndUntrack.push(slug);
    },
    untrack: (slug: string) => {
      calls.untrack.push(slug);
    },
    clearResumeAttempts: () => {},
    lastActivityAt: () => undefined,
    calls,
  };
}

function fakePtyIo() {
  return {
    sendRaw: () => {},
    sendEffortCommand: () => {},
    confirmSubmitted: () => {},
    autoRecoverWedgedSession: () => {},
    sendChannelText: () => {},
  };
}

function setup(overrides: Partial<Parameters<typeof createSessionLifecycleCommands>[0]> = {}) {
  const sessionStore = new SessionStore(":memory:");
  const routing = new Routing();
  const controlBot = fakeLifecycleBot();
  const sessionSupervisor = fakeSessionSupervisor();
  const ptyIo = fakePtyIo();
  const stoppedIndicatorTopics: number[] = [];
  const feedWiring = {
    allFeedStates: () => new Map(),
    forgetSession: () => {},
    // Mirrors feed-wiring.ts's real `maybeSetState` rather than just recording the call: it writes
    // through `isValidTransition`, so a test asserting `/stop` moved a row is also asserting §4.3
    // actually permits that edge. A record-only spy would have happily "passed" for the whole period
    // `awaiting_input -> idle` was missing from the table.
    maybeSetState: (slug: string, next: SessionState) => {
      const current = sessionStore.get(slug);
      if (current && current.state !== next && isValidTransition(current.state, next)) sessionStore.setState(slug, next, new Date().toISOString());
    },
  };
  const permissionRegistry = new PermissionRegistry();
  const askRegistry = new AskRegistry();
  const costTracker = new CostTracker();
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const postFleetConfirmCalls: Array<{ kind: string; topicId: number | undefined; targets: string[] }> = [];
  const executeFleetActionDirectCalls: Array<{ kind: string; topicId: number | undefined; targets: string[] }> = [];
  const finalizedMessages: Array<{ messageId: number; text: string }> = [];
  const verdicts: Array<{ slug: string; requestId: string; behavior: string }> = [];
  // Flipped by the drain-with-a-disconnected-channel case: `sendVerdict` returning false is the
  // situation a stale pending card is most likely to be in, and the card text must follow it.
  let verdictDelivered = true;

  const sessionLifecycle = createSessionLifecycleCommands({
    sessionStore,
    routing,
    controlBot,
    sessionSupervisor,
    ptyIo,
    feedWiring,
    permissionRegistry,
    askRegistry,
    costTracker,
    fleetConfirmRegistry,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text });
    },
    finalizePermissionMessage: async (messageId, text) => {
      finalizedMessages.push({ messageId, text });
    },
    sendVerdict: (slug, requestId, behavior) => {
      verdicts.push({ slug, requestId, behavior });
      return verdictDelivered;
    },
    stopIndicatorsForTopic: (topicId: number) => {
      stoppedIndicatorTopics.push(topicId);
    },
    thinkingPlaceholder: { start: () => {}, consume: async () => undefined },
    postFleetConfirm: async (kind, topicId, targets) => {
      postFleetConfirmCalls.push({ kind, topicId, targets: targets.map((r) => r.slug) });
    },
    executeFleetActionDirect: async (kind, topicId, targets) => {
      executeFleetActionDirectCalls.push({ kind, topicId, targets: targets.map((r) => r.slug) });
    },
    waitForChannelConnected: async () => {},
    waitForPtyQuiet: async () => {},
    isControlTopic: (topicId) => topicId === undefined || topicId === 1,
    getReposRegistry: () => undefined,
    settings: testRuntimeSettings({ defaultSessionMode: "manual", defaultSessionEffort: "medium" }).settings,
    supergroupChatId: "-100",
    selfCheckSlug: "self-check",
    fleetWorktreesRoot: undefined,
    otlpPort: 4318,
    ...overrides,
  });

  return {
    sessionLifecycle,
    sessionStore,
    routing,
    controlBot,
    sessionSupervisor,
    fleetConfirmRegistry,
    permissionRegistry,
    askRegistry,
    confirmed,
    finalizedMessages,
    verdicts,
    stoppedIndicatorTopics,
    setVerdictDelivered: (delivered: boolean) => {
      verdictDelivered = delivered;
    },
    postFleetConfirmCalls,
    executeFleetActionDirectCalls,
  };
}

describe("createSessionLifecycleCommands", () => {
  describe("resolveTargetSlug", () => {
    test("resolves an explicit slug over the current one", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row());
      expect(sessionLifecycle.resolveTargetSlug("fix-bug", "other")).toEqual({ slug: "fix-bug" });
    });

    test("falls back to the current topic's slug when no explicit one is given", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row());
      expect(sessionLifecycle.resolveTargetSlug(undefined, "fix-bug")).toEqual({ slug: "fix-bug" });
    });

    test("reports a usage error with neither an explicit nor a current slug", () => {
      const { sessionLifecycle } = setup();
      expect(sessionLifecycle.resolveTargetSlug(undefined, undefined)).toEqual({ error: expect.stringContaining("usage:") });
    });

    test("reports an unknown-slug error rather than crashing on a missing row", () => {
      const { sessionLifecycle } = setup();
      expect(sessionLifecycle.resolveTargetSlug("ghost", undefined)).toEqual({ error: expect.stringContaining('unknown slug "ghost"') });
    });
  });

  // The shared resolveSessionOrBail helper is exercised indirectly through each of the six call
  // sites the plan names, rather than directly (it isn't part of the module's public interface) -
  // every one of them must report a clear failure for an unknown slug instead of the old
  // `sessionStore.get(slug) as NonNullable<...>` cast crashing on `undefined`.
  describe("resolveSessionOrBail (via its six call sites)", () => {
    test("handleAttachCommand reports a clear failure for an unknown slug", () => {
      const { sessionLifecycle, confirmed } = setup();
      sessionLifecycle.handleAttachCommand({ kind: "attach", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleAttachCommand renders the attach panel for a known slug", () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row());
      sessionLifecycle.handleAttachCommand({ kind: "attach", slug: "fix-bug" }, 1, undefined);
      expect(confirmed[0]?.text).toContain("fix-bug");
    });

    test("handlePauseCommand reports a clear failure for an unknown slug", () => {
      const { sessionLifecycle, confirmed } = setup();
      sessionLifecycle.handlePauseCommand({ kind: "pause", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handlePauseCommand toggles a known session's paused flag", () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row({ paused: false }));
      sessionLifecycle.handlePauseCommand({ kind: "pause", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.paused).toBe(true);
      expect(confirmed[0]?.text).toContain("Feed paused");
    });

    test("handleStopCommand reports a clear failure for an unknown slug", () => {
      const { sessionLifecycle, confirmed } = setup();
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleStopCommand writes a bare Escape to the session's PTY, no trailing \\r", () => {
      const { sessionLifecycle, sessionStore, routing, confirmed } = setup();
      sessionStore.insert(row());
      const written: string[] = [];
      routing.setPtyWrite("fix-bug", (text) => written.push(text));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(written).toEqual(["\x1b"]);
      expect(confirmed[0]?.text).toContain('Sent stop to "fix-bug"');
    });

    test("handleStopCommand on a session with no tracked PTY write is a harmless no-op", () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row());
      expect(() => sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined)).not.toThrow();
      expect(confirmed[0]?.text).toContain('Sent stop to "fix-bug"');
    });

    // Live-verified 2026-08-13: an operator interrupt emits no `Stop`/`StopFailure` hook at all, so
    // the "let the hook pipeline move the row" design this command was built on had nothing to wait
    // for and stranded every interrupted session in whatever state it was interrupted from. Measured
    // on two real sessions - `working` for minutes after a mid-turn `/stop`, and `awaiting_input` for
    // 3.5 minutes after a `/stop` on a permission card, until an unrelated message dragged it out.
    test("handleStopCommand moves an interrupted working session to idle itself, with no Stop hook", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row({ state: "working" }));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.state).toBe("idle");
    });

    // The first real caller of P1-11's `awaiting_input -> idle` edge: that fix added the edge, but an
    // edge only helps if something crosses it, and no hook event ever did.
    test("handleStopCommand moves an interrupted awaiting_input session to idle", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row({ state: "awaiting_input" }));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.state).toBe("idle");
    });

    // The reason the write is gated on the two interruptible states instead of unconditional:
    // §4.3 permits `quota_stopped -> idle`, so an unconditional write would let a stray `/stop`
    // erase the one signal §10.5's alarms and `/ls`'s "stopped on a usage limit" line key on.
    test("handleStopCommand does not erase a quota_stopped session's rate-limit signal", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row({ state: "quota_stopped" }));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.state).toBe("quota_stopped");
    });

    test("handleStopCommand does not claim a still-starting session is idle", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row({ state: "starting" }));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.state).toBe("starting");
    });

    test("handleStopCommand leaves a dead row dead", () => {
      const { sessionLifecycle, sessionStore } = setup();
      sessionStore.insert(row({ state: "dead" }));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.state).toBe("dead");
    });

    // Observed live alongside the stranded row: with no `Stop` hook coming, the abandoned turn's
    // "Thinking..." placeholder was left spinning indefinitely on a turn that had been interrupted.
    test("handleStopCommand clears the abandoned turn's typing/thinking indicators", () => {
      const { sessionLifecycle, sessionStore, stoppedIndicatorTopics } = setup();
      sessionStore.insert(row({ topicId: 7 }));
      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);
      expect(stoppedIndicatorTopics).toEqual([7]);
    });

    // Live-verified 2026-08-09: interrupting a session mid-tool-call abandons a still-pending
    // permission/ask outright, leaving it stuck in permissionRegistry/askRegistry forever (never
    // resolved by an operator tap or an at-terminal answer) - /ls kept misreporting the session as
    // awaiting_input over a request Claude had already dropped. handleStopCommand now clears both.
    test("handleStopCommand clears a stale pending permission for that slug, mentions it, and edits its card in place", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, confirmed, finalizedMessages } = setup();
      sessionStore.insert(row());
      permissionRegistry.add({
        requestId: "req-1",
        slug: "fix-bug",
        toolName: "Bash",
        description: "run a command",
        inputPreview: '{ "command": "echo hi" }',
        topicId: 1,
        messageId: 10,
      });

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      expect(permissionRegistry.get("req-1")).toBeUndefined();
      expect(confirmed[0]?.text).toContain('Sent stop to "fix-bug"');
      expect(confirmed[0]?.text).toContain("cleared 1 stale pending prompt");
      expect(finalizedMessages).toEqual([{ messageId: 10, text: "🛑 interrupted: Bash (session was stopped before this was answered)" }]);
    });

    // Measured 2026-08-13: a permission request blocks inside the session's own channel server, not
    // in a hook client, and an Escape does not release it - a `/stop` over a permission card
    // followed by nothing at all left the session silent for 8 minutes. Removing the registry entry
    // without a verdict leaves nothing able to answer it ever again, since `sweepExpiredPermissions`
    // iterates the registry `/stop` just emptied.
    test("handleStopCommand denies a cleared pending permission rather than leaving it unanswered", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, verdicts } = setup();
      sessionStore.insert(row());
      permissionRegistry.add({
        requestId: "req-1",
        slug: "fix-bug",
        toolName: "Bash",
        description: "run a command",
        inputPreview: '{ "command": "echo hi" }',
        topicId: 1,
        messageId: 10,
      });

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      expect(verdicts).toEqual([{ slug: "fix-bug", requestId: "req-1", behavior: "deny" }]);
    });

    // An ask is the asymmetric case: it blocks a hook client, which Claude's own interrupt handling
    // does release, so sending a verdict for one would be answering a question nobody is waiting on.
    test("handleStopCommand sends no verdict for a cleared ask", () => {
      const { sessionLifecycle, sessionStore, askRegistry, verdicts } = setup();
      sessionStore.insert(row());
      askRegistry.add({
        id: "toolu_ask1",
        slug: "fix-bug",
        questions: [{ question: "A or B?", header: "Plan", options: [{ label: "A" }, { label: "B" }], topicId: 1, messageId: 11 }],
      });

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      expect(verdicts).toEqual([]);
    });

    test("handleStopCommand warns rather than throwing when the channel is already gone", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, setVerdictDelivered, confirmed } = setup();
      setVerdictDelivered(false);
      sessionStore.insert(row());
      permissionRegistry.add({
        requestId: "req-1",
        slug: "fix-bug",
        toolName: "Bash",
        description: "run a command",
        inputPreview: '{ "command": "echo hi" }',
        topicId: 1,
        messageId: 10,
      });

      expect(() => sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined)).not.toThrow();
      expect(confirmed[0]?.text).toContain('Sent stop to "fix-bug"');
    });

    test("handleStopCommand clears a stale pending ask for that slug, mentions it, and edits its card in place", () => {
      const { sessionLifecycle, sessionStore, askRegistry, confirmed, finalizedMessages } = setup();
      sessionStore.insert(row());
      askRegistry.add({
        id: "toolu_1",
        slug: "fix-bug",
        questions: [{ question: "Pick a color", header: "Color", options: [{ label: "Red" }], topicId: 1, messageId: 10 }],
      });

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      expect(askRegistry.get("toolu_1")).toBeUndefined();
      expect(confirmed[0]?.text).toContain("cleared 1 stale pending prompt");
      expect(finalizedMessages).toEqual([{ messageId: 10, text: "❓ fix-bug asks (Color):\n\nPick a color\n\n🛑 interrupted - session was stopped before this was answered" }]);
    });

    test("handleStopCommand does not edit an already-answered question's card", () => {
      const { sessionLifecycle, sessionStore, askRegistry, finalizedMessages } = setup();
      sessionStore.insert(row());
      askRegistry.add({
        id: "toolu_1",
        slug: "fix-bug",
        questions: [
          { question: "Pick a color", options: [{ label: "Red" }], topicId: 1, messageId: 10, answerLabel: "Red" },
          { question: "Pick a size", options: [{ label: "S" }], topicId: 1, messageId: 11 },
        ],
      });

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      // only the unanswered second question's card gets edited
      expect(finalizedMessages.map((m) => m.messageId)).toEqual([11]);
    });

    test("handleStopCommand does not mention clearing anything when nothing was pending", () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row());

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      expect(confirmed[0]?.text).toBe('Sent stop to "fix-bug".');
    });

    test("handleStopCommand does not clear a pending permission belonging to a different session", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry } = setup();
      sessionStore.insert(row());
      sessionStore.insert(row({ slug: "other-session", topicId: 6, sessionId: "sess-2" }));
      permissionRegistry.add({
        requestId: "req-1",
        slug: "other-session",
        toolName: "Bash",
        description: "run a command",
        inputPreview: '{ "command": "echo hi" }',
        topicId: 6,
        messageId: 10,
      });

      sessionLifecycle.handleStopCommand({ kind: "stop", slug: "fix-bug" }, 1, undefined);

      expect(permissionRegistry.get("req-1")).toBeDefined();
    });

    test("handleResumeCommand reports a clear failure for an unknown slug", async () => {
      const { sessionLifecycle, confirmed } = setup();
      await sessionLifecycle.handleResumeCommand({ kind: "resume", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleResumeCommand calls sessionSupervisor.resumeSession for a dead row", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor } = setup();
      sessionStore.insert(row({ state: "dead" }));
      const resumed: SessionRow[] = [];
      sessionSupervisor.resumeSession = async (r: SessionRow) => {
        resumed.push(r);
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", slug: "fix-bug" }, 1, undefined);
      expect(resumed.map((r) => r.slug)).toEqual(["fix-bug"]);
    });

    // Bug fix (live-confirmed 2026-08-11): without `manuallyRequested: true`, `resumeSession`'s own
    // dead-guard (session-supervisor.ts, meant to catch a crash-backoff/reconciliation race) always
    // fired here too - `row.state === "dead"` is the very reason /resume calls it, not a race - so
    // every manual /resume on a dead session silently no-op'd. Asserted against the real
    // `resumeSession` (not the mocked-away version above) so a regression here fails loudly again.
    test("handleResumeCommand passes manuallyRequested:true so resumeSession's own dead-guard doesn't swallow it", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor } = setup();
      sessionStore.insert(row({ state: "dead" }));
      const calls: Array<{ slug: string; opts: unknown }> = [];
      sessionSupervisor.resumeSession = async (r: SessionRow, opts?: unknown) => {
        calls.push({ slug: r.slug, opts });
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", slug: "fix-bug" }, 1, undefined);
      expect(calls).toEqual([{ slug: "fix-bug", opts: { manuallyRequested: true } }]);
    });

    test("handleResumeCommand is a no-op with an explanatory note for a still-alive session (/stop leaves the process alive)", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ state: "working" }));
      const resumed: SessionRow[] = [];
      sessionSupervisor.resumeSession = async (r: SessionRow) => {
        resumed.push(r);
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", slug: "fix-bug" }, 1, undefined);
      expect(resumed).toEqual([]);
      expect(confirmed[0]?.text).toContain("still running");
    });

    test("handleResumeCommand reports quota_stopped with its own wording rather than treating it like a dead row", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ state: "quota_stopped" }));
      const resumed: SessionRow[] = [];
      sessionSupervisor.resumeSession = async (r: SessionRow) => {
        resumed.push(r);
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", slug: "fix-bug" }, 1, undefined);
      expect(resumed).toEqual([]);
      expect(confirmed[0]?.text).toContain("usage limit");
    });

    test("/resume --all resumes every dead session, excluding the self-check slug, and skips anything still alive", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ slug: "dead-one", state: "dead", topicId: 6, sessionId: "sess-dead-1" }));
      sessionStore.insert(row({ slug: "dead-two", state: "dead", topicId: 7, sessionId: "sess-dead-2" }));
      sessionStore.insert(row({ slug: "alive-one", state: "working", topicId: 8, sessionId: "sess-alive" }));
      sessionStore.insert(row({ slug: "self-check", state: "dead", topicId: 9, sessionId: "sess-self" }));
      const calls: Array<{ slug: string; opts: unknown }> = [];
      sessionSupervisor.resumeSession = async (r: SessionRow, opts?: unknown) => {
        calls.push({ slug: r.slug, opts });
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", all: true }, 1, undefined);
      expect(calls).toEqual([
        { slug: "dead-one", opts: { manuallyRequested: true } },
        { slug: "dead-two", opts: { manuallyRequested: true } },
      ]);
      expect(confirmed[0]?.text).toContain("Resumed 2 dead sessions: dead-one, dead-two");
    });

    test("/resume --all reports a clear no-op when nothing is dead", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ state: "working" }));
      const resumed: SessionRow[] = [];
      sessionSupervisor.resumeSession = async (r: SessionRow) => {
        resumed.push(r);
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", all: true }, 1, undefined);
      expect(resumed).toEqual([]);
      expect(confirmed[0]?.text).toBe("No dead sessions to resume.");
    });

    // Live-confirmed 2026-08-12: a Bridge restart followed by `/resume --all` tried to resume rows
    // whose Telegram topics had been deleted - every send into them failed with "message thread not
    // found", silently, so the control-topic summary claimed a resume that never actually reached
    // Telegram. `reapRowsWithDeletedTopics` (already used by boot reconciliation) has to run first.
    test("/resume --all reaps a row whose Telegram topic was deleted instead of trying (and silently failing) to resume it", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ slug: "dead-one", state: "dead", topicId: 6, sessionId: "sess-dead-1" }));
      sessionStore.insert(row({ slug: "gone-topic", state: "dead", topicId: 7, sessionId: "sess-gone" }));
      sessionSupervisor.reapRowsWithDeletedTopics = async (rows: SessionRow[]) => rows.filter((r) => r.slug !== "gone-topic");
      const calls: Array<{ slug: string; opts: unknown }> = [];
      sessionSupervisor.resumeSession = async (r: SessionRow, opts?: unknown) => {
        calls.push({ slug: r.slug, opts });
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", all: true }, 1, undefined);
      expect(calls).toEqual([{ slug: "dead-one", opts: { manuallyRequested: true } }]);
      expect(confirmed[0]?.text).toContain("Resumed 1 dead session: dead-one");
      expect(confirmed[0]?.text).toContain("1 more had a deleted topic");
    });

    test("/resume --all reports a clear failure, and calls resumeSession for nobody, when every dead session's topic was deleted", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ slug: "gone-topic", state: "dead", topicId: 7, sessionId: "sess-gone" }));
      sessionSupervisor.reapRowsWithDeletedTopics = async () => [];
      const resumed: SessionRow[] = [];
      sessionSupervisor.resumeSession = async (r: SessionRow) => {
        resumed.push(r);
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", all: true }, 1, undefined);
      expect(resumed).toEqual([]);
      expect(confirmed[0]?.text).toContain("1 dead session could not be resumed");
      expect(confirmed[0]?.text).toContain("its Telegram topic no longer exists");
    });

    test("handleResumeCommand (single slug) does not call resumeSession when the row's own topic was deleted", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row({ state: "dead" }));
      sessionSupervisor.reapRowsWithDeletedTopics = async () => [];
      const resumed: SessionRow[] = [];
      sessionSupervisor.resumeSession = async (r: SessionRow) => {
        resumed.push(r);
      };
      await sessionLifecycle.handleResumeCommand({ kind: "resume", slug: "fix-bug" }, 1, undefined);
      expect(resumed).toEqual([]);
      // `reapRowsWithDeletedTopics` itself is the one that posts the "topic no longer exists" notice
      // (to the control topic, per its own doc comment) - this path deliberately posts nothing further.
      expect(confirmed).toEqual([]);
    });

    test("handleDetailCommand reports a clear failure for an unknown slug", () => {
      const { sessionLifecycle, confirmed } = setup();
      sessionLifecycle.handleDetailCommand({ kind: "detail", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleDetailCommand reports the current setting when bare and sets it when given a level", () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row({ feedDetail: "compact" }));
      sessionLifecycle.handleDetailCommand({ kind: "detail", slug: "fix-bug" }, 1, undefined);
      expect(confirmed[0]?.text).toContain("feed detail: compact");
      sessionLifecycle.handleDetailCommand({ kind: "detail", slug: "fix-bug", level: "full" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.feedDetail).toBe("full");
      expect(confirmed[1]?.text).toContain("feed detail set to full");
    });

    test("handleVerboseCommand reports a clear failure for an unknown slug", () => {
      const { sessionLifecycle, confirmed } = setup();
      sessionLifecycle.handleVerboseCommand({ kind: "verbose", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleVerboseCommand's two internal row reads (bare status, then after mutation) both use a real row, not a stale cast", () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row({ feedVerbose: false, feedDetail: "compact" }));
      sessionLifecycle.handleVerboseCommand({ kind: "verbose", slug: "fix-bug" }, 1, undefined);
      expect(confirmed[0]?.text).toContain("verbose tool output: off");

      sessionLifecycle.handleVerboseCommand({ kind: "verbose", slug: "fix-bug", on: true }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.feedVerbose).toBe(true);
      // feedDetail is still "compact" - the no-effect note reads the freshly-mutated row, not the
      // pre-mutation snapshot the old second cast would have re-derived from scratch anyway.
      expect(confirmed[1]?.text).toContain("no effect until /detail full");
    });

    test("handleKillCommand's single-slug form reports a clear failure for an unknown slug", async () => {
      const { sessionLifecycle, confirmed } = setup();
      await sessionLifecycle.handleKillCommand({ kind: "kill", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleKillCommand's single-slug form kills a known session", async () => {
      const { sessionLifecycle, sessionStore, sessionSupervisor, confirmed } = setup();
      sessionStore.insert(row());
      await sessionLifecycle.handleKillCommand({ kind: "kill", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")?.state).toBe("dead");
      expect(sessionSupervisor.calls.killAndUntrack).toEqual(["fix-bug"]);
      expect(confirmed[0]?.text).toContain('Killed "fix-bug"');
    });

    test("handleRmCommand's single-slug form reports a clear failure for an unknown slug typed explicitly", async () => {
      const { sessionLifecycle, confirmed } = setup();
      await sessionLifecycle.handleRmCommand({ kind: "rm", slug: "ghost" }, 1, undefined);
      expect(confirmed[0]?.text).toContain('unknown slug "ghost"');
    });

    test("handleRmCommand's single-slug form removes a known session", async () => {
      const { sessionLifecycle, sessionStore, confirmed } = setup();
      sessionStore.insert(row());
      await sessionLifecycle.handleRmCommand({ kind: "rm", slug: "fix-bug" }, 1, undefined);
      expect(sessionStore.get("fix-bug")).toBeUndefined();
      expect(confirmed[0]?.text).toContain('Removed "fix-bug"');
    });
  });

  describe("handleAutoCommand", () => {
    const pending = (requestId: string, messageId: number) => ({
      requestId,
      slug: "fix-bug",
      toolName: "Bash",
      description: "run a command",
      inputPreview: '{ "command": "git push" }',
      topicId: 1,
      messageId,
    });

    test("bare /auto permission reports status without toggling", () => {
      const { sessionLifecycle, sessionStore, routing, confirmed } = setup();
      sessionStore.insert(row());

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "fix-bug" }, 1, undefined);

      expect(confirmed[0]?.text).toBe('"fix-bug" auto-permission: off.');
      expect(routing.getBypass("fix-bug")).toBe(false);
    });

    test("bare /auto answer reports its own category, not permission's", () => {
      const { sessionLifecycle, sessionStore, routing, confirmed } = setup();
      sessionStore.insert(row());
      routing.setAutoAnswer("fix-bug", true);

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "answer", slug: "fix-bug" }, 1, undefined);

      expect(confirmed[0]?.text).toBe('"fix-bug" auto-answer: on.');
      expect(routing.getBypass("fix-bug")).toBe(false);
    });

    test("explicit on/off sets the flag and confirms, naming the ask list it now auto-allows", () => {
      const { sessionLifecycle, sessionStore, routing, confirmed } = setup();
      sessionStore.insert(row());

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "fix-bug", on: true }, 1, undefined);
      expect(routing.getBypass("fix-bug")).toBe(true);
      expect(confirmed[0]?.text).toContain("git commit/push");
      expect(confirmed[0]?.text).toContain("deny list");

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "fix-bug", on: false }, 1, undefined);
      expect(routing.getBypass("fix-bug")).toBe(false);
    });

    test("the two categories are independent", () => {
      const { sessionLifecycle, sessionStore, routing } = setup();
      sessionStore.insert(row());

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "answer", slug: "fix-bug", on: true }, 1, undefined);

      expect(routing.getAutoAnswer("fix-bug")).toBe(true);
      expect(routing.getBypass("fix-bug")).toBe(false);
    });

    test("an unknown slug bails via resolveSessionOrBail without setting anything", () => {
      const { sessionLifecycle, routing, confirmed } = setup();

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "nope", on: true }, 1, undefined);

      expect(confirmed[0]?.text).toContain('"nope"');
      expect(routing.getBypass("nope")).toBe(false);
    });

    // The common way to discover you want this is to be looking at a card you don't want to tap.
    test("turning permission on drains already-pending requests: verdict THEN card finalize", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, verdicts, finalizedMessages } = setup();
      sessionStore.insert(row());
      permissionRegistry.add(pending("req-1", 10));
      permissionRegistry.add(pending("req-2", 11));

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "fix-bug", on: true }, 1, undefined);

      expect(verdicts).toEqual([
        { slug: "fix-bug", requestId: "req-1", behavior: "allow" },
        { slug: "fix-bug", requestId: "req-2", behavior: "allow" },
      ]);
      expect(permissionRegistry.get("req-1")).toBeUndefined();
      expect(finalizedMessages.map((m) => m.messageId)).toEqual([10, 11]);
      expect(finalizedMessages[0]?.text).toContain("auto-approved");
    });

    // The worst possible combination is: entry gone from the registry, card claiming approval,
    // verdict delivered to nothing - past any sweep's reach, session hung forever.
    test("a drain whose verdict reaches no live channel says so, rather than claiming approval", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, finalizedMessages, setVerdictDelivered } = setup();
      sessionStore.insert(row());
      permissionRegistry.add(pending("req-1", 10));
      setVerdictDelivered(false);

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "fix-bug", on: true }, 1, undefined);

      expect(finalizedMessages[0]?.text).toContain("couldn't be auto-approved");
      expect(finalizedMessages[0]?.text).not.toContain("🔓 auto-approved");
    });

    test("turning permission OFF drains nothing", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, verdicts } = setup();
      sessionStore.insert(row());
      permissionRegistry.add(pending("req-1", 10));

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", slug: "fix-bug", on: false }, 1, undefined);

      expect(verdicts).toEqual([]);
      expect(permissionRegistry.get("req-1")).toBeDefined();
    });

    // The deliberate asymmetry: draining a pending question would answer it on the operator's
    // behalf with an option they never saw.
    test("turning answer on leaves a pending permission request alone", () => {
      const { sessionLifecycle, sessionStore, permissionRegistry, verdicts, finalizedMessages } = setup();
      sessionStore.insert(row());
      permissionRegistry.add(pending("req-1", 10));

      sessionLifecycle.handleAutoCommand({ kind: "auto", category: "answer", slug: "fix-bug", on: true }, 1, undefined);

      expect(verdicts).toEqual([]);
      expect(finalizedMessages).toEqual([]);
      expect(permissionRegistry.get("req-1")).toBeDefined();
    });

    describe("--all", () => {
      test("posts a confirm card keyed to the category AND the value, changing nothing yet", async () => {
        const { sessionLifecycle, sessionStore, routing, postFleetConfirmCalls } = setup();
        sessionStore.insert(row());
        sessionStore.insert(row({ slug: "other", topicId: 2, sessionId: "sess-2" }));

        await sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", all: true, on: true }, 1, "fix-bug");

        expect(postFleetConfirmCalls).toEqual([{ kind: "permission-on", topicId: 1, targets: ["fix-bug", "other"] }]);
        // The card is the gate: nothing is applied until it's tapped.
        expect(routing.getBypass("fix-bug")).toBe(false);
      });

      test("off posts the -off kind, so the tap can't coerce its way into the opposite action", async () => {
        const { sessionLifecycle, sessionStore, postFleetConfirmCalls } = setup();
        sessionStore.insert(row());

        await sessionLifecycle.handleAutoCommand({ kind: "auto", category: "answer", all: true, on: false }, 1, undefined);

        expect(postFleetConfirmCalls[0]?.kind).toBe("answer-off");
      });

      test("excludes the self-check slug and dead sessions, same as /kill --all", async () => {
        const { sessionLifecycle, sessionStore, postFleetConfirmCalls } = setup();
        sessionStore.insert(row());
        sessionStore.insert(row({ slug: "self-check", topicId: 2, sessionId: "sess-2" }));
        sessionStore.insert(row({ slug: "gone", topicId: 3, state: "dead", sessionId: "sess-3" }));

        await sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", all: true, on: true }, 1, undefined);

        expect(postFleetConfirmCalls[0]?.targets).toEqual(["fix-bug"]);
      });

      // §0.3: `FleetConfirmKind` carries the value, so a card built from `on: undefined` would read
      // "Turn auto-permission ON" and turn it off everywhere. Bare `--all` reports instead.
      test("bare --all reports fleet status for BOTH categories and posts no card", async () => {
        const { sessionLifecycle, sessionStore, routing, confirmed, postFleetConfirmCalls } = setup();
        sessionStore.insert(row());
        sessionStore.insert(row({ slug: "other", topicId: 2, sessionId: "sess-2" }));
        routing.setBypass("fix-bug", true);
        routing.setAutoAnswer("other", true);

        await sessionLifecycle.handleAutoCommand({ kind: "auto", category: "permission", all: true }, 1, undefined);

        expect(postFleetConfirmCalls).toEqual([]);
        expect(confirmed[0]?.text).toContain("fix-bug: permission on, answer off");
        expect(confirmed[0]?.text).toContain("other: permission off, answer on");
      });

      test("bare --all with no live sessions says so instead of rendering an empty list", async () => {
        const { sessionLifecycle, confirmed } = setup();

        await sessionLifecycle.handleAutoCommand({ kind: "auto", category: "answer", all: true }, 1, undefined);

        expect(confirmed[0]?.text).toBe("No live sessions.");
      });
    });
  });

  describe("handleRmCommand's non-shared-helper branches", () => {
    test("a bare /rm in a real topic with no session row at all redirects to postOrphanTopicRmConfirm", async () => {
      const { sessionLifecycle, controlBot } = setup();
      await sessionLifecycle.handleRmCommand({ kind: "rm" }, 42, undefined);
      expect(controlBot.sent[0]?.text).toContain("no session tracked");
    });

    test("a bare /rm in the control topic reports the usual usage error instead", async () => {
      const { sessionLifecycle, confirmed } = setup();
      await sessionLifecycle.handleRmCommand({ kind: "rm" }, undefined, undefined);
      expect(confirmed[0]?.text).toContain("usage:");
    });

    test("/rm --dead removes every dead session and reports orphaned topics", async () => {
      const { sessionLifecycle, sessionStore, controlBot, confirmed } = setup();
      sessionStore.insert(row({ slug: "dead-one", state: "dead", topicId: 6, sessionId: "sess-dead" }));
      sessionStore.insert(row({ slug: "alive-one", state: "working", topicId: 7, sessionId: "sess-alive" }));
      controlBot.deleteForumTopic = async () => {
        throw new Error("TOPIC_ID_INVALID");
      };
      await sessionLifecycle.handleRmCommand({ kind: "rm", bulk: { mode: "dead" } }, 1, undefined);
      expect(sessionStore.get("dead-one")).toBeUndefined();
      expect(sessionStore.get("alive-one")).toBeDefined();
      expect(confirmed[0]?.text).toContain(ORPHAN_TOPIC_NOTE);
    });

    test("/rm --all with force removes everything directly via executeFleetActionDirect, excluding the self-check slug", async () => {
      const { sessionLifecycle, sessionStore, executeFleetActionDirectCalls } = setup();
      sessionStore.insert(row({ slug: "fix-bug", sessionId: "sess-1" }));
      sessionStore.insert(row({ slug: "self-check", topicId: 9, sessionId: "sess-2" }));
      await sessionLifecycle.handleRmCommand({ kind: "rm", bulk: { mode: "all" }, force: true }, 1, undefined);
      expect(executeFleetActionDirectCalls).toEqual([{ kind: "rm", topicId: 1, targets: ["fix-bug"] }]);
    });

    test("/kill --all without force posts a confirm card via postFleetConfirm, excluding the self-check slug", async () => {
      const { sessionLifecycle, sessionStore, postFleetConfirmCalls } = setup();
      sessionStore.insert(row({ slug: "fix-bug", sessionId: "sess-1" }));
      sessionStore.insert(row({ slug: "self-check", topicId: 9, sessionId: "sess-2" }));
      await sessionLifecycle.handleKillCommand({ kind: "kill", all: true }, 1, undefined);
      expect(postFleetConfirmCalls).toEqual([{ kind: "kill", topicId: 1, targets: ["fix-bug"] }]);
    });
  });

  describe("killSessionRow / removeSessionRow", () => {
    test("killSessionRow marks the row dead and closes its topic", async () => {
      const { sessionLifecycle, sessionStore, controlBot, sessionSupervisor } = setup();
      const r = row();
      sessionStore.insert(r);
      await sessionLifecycle.killSessionRow(r);
      expect(sessionStore.get("fix-bug")?.state).toBe("dead");
      expect(sessionSupervisor.calls.killAndUntrack).toEqual(["fix-bug"]);
      expect(controlBot.forumTopicCalls.closed).toEqual([5]);
    });

    test("removeSessionRow deletes the row and its topic, reporting whether the topic delete succeeded", async () => {
      const { sessionLifecycle, sessionStore, controlBot } = setup();
      const r = row();
      sessionStore.insert(r);
      const topicDeleted = await sessionLifecycle.removeSessionRow(r);
      expect(topicDeleted).toBe(true);
      expect(sessionStore.get("fix-bug")).toBeUndefined();
      expect(controlBot.forumTopicCalls.deleted).toEqual([5]);
    });

    test("removeSessionRow reports a failed topic delete without leaving the row behind", async () => {
      const { sessionLifecycle, sessionStore } = setup({
        controlBot: {
          ...fakeLifecycleBot(),
          deleteForumTopic: async () => {
            throw new Error("TOPIC_ID_INVALID");
          },
        },
      });
      const r = row();
      sessionStore.insert(r);
      const topicDeleted = await sessionLifecycle.removeSessionRow(r);
      expect(topicDeleted).toBe(false);
      expect(sessionStore.get("fix-bug")).toBeUndefined();
    });
  });

  describe("postOrphanTopicRmConfirm", () => {
    test("posts the rm-topic confirm card and registers it", async () => {
      const { sessionLifecycle, controlBot, fleetConfirmRegistry } = setup();
      await sessionLifecycle.postOrphanTopicRmConfirm(77);
      expect(controlBot.sent[0]?.text).toContain("no session tracked");
      expect(controlBot.sent[0]?.keyboard).toBeDefined();
      // The registry now holds exactly one rm-topic entry for this topic - confirmed by taking it
      // via the id encoded on the keyboard rather than a magic string.
      const button = (controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard[0]?.[0];
      // callback_data is "fc:<kind>:<id>:y" (fleet-confirm.ts's buildFleetConfirmKeyboard).
      const id = button?.callback_data?.split(":")[2];
      expect(id).toBeDefined();
      const taken = fleetConfirmRegistry.take(id!);
      expect(taken?.entry.kind).toBe("rm-topic");
      expect(taken?.entry.topicId).toBe(77);
    });
  });

  // attachment-triggered-session-creation-plan.md's `cmd.pendingAttachment` handling - the parts of
  // `handleNewCommand` that don't require a real `launchSession` (git worktree + PTY spawn), which
  // isn't injectable here (session-lifecycle-commands.ts imports it directly, not via options). The
  // attachment write itself now happens *after* `launchSession` succeeds (it lands inside the
  // freshly-created worktree - attachment-inbox.ts's own doc comment on `writeAttachmentToInbox`
  // explains why), so a write-failure-after-a-successful-launch scenario isn't reachable from here
  // either; `attachment-inbox.test.ts` covers `writeAttachmentToInbox`'s own failure modes directly.
  describe("handleNewCommand with a pendingAttachment", () => {
    test("an early rejection (unknown repo) tells the operator the attachment was lost, not just the repo error", async () => {
      const { sessionLifecycle, confirmed } = setup({ getReposRegistry: () => new ReposRegistry([]) });

      await sessionLifecycle.handleNewCommand(
        { kind: "new", repo: "not-a-real-repo", prompt: "add a README", pendingAttachment: { kind: "image", name: "shot.png", bytes: new Uint8Array([1, 2, 3]) } },
        1,
      );

      expect(confirmed[0]?.text).toContain('Unknown repo "not-a-real-repo"');
      expect(confirmed[0]?.text).toContain("attachment you sent was not saved");
    });

    test("an early rejection with no pendingAttachment does not mention a lost attachment", async () => {
      const { sessionLifecycle, confirmed } = setup({ getReposRegistry: () => new ReposRegistry([]) });

      await sessionLifecycle.handleNewCommand({ kind: "new", repo: "not-a-real-repo", prompt: "add a README" }, 1);

      expect(confirmed[0]?.text).not.toContain("attachment you sent was not saved");
    });

    test("a fleet-at-capacity refusal also carries the lost-attachment note", async () => {
      const reposRegistry = new ReposRegistry([{ name: "demo-repo", path: "c:\\does\\not\\exist\\demo-repo" }]);
      const { sessionLifecycle, sessionStore, confirmed } = setup({ getReposRegistry: () => reposRegistry });
      // checkConcurrencyCap (concurrency-cap.ts, WEIGHTED_CAP = 4, sonnet weight = 1): four live
      // sonnet rows already sit exactly at the cap, so one more of any weight is refused - rather
      // than asserting the exact cap value here (that's concurrency-cap.test.ts's own job).
      for (let i = 0; i < 4; i++) {
        sessionStore.insert(row({ slug: `filler-${i}`, topicId: 100 + i, sessionId: `filler-sess-${i}`, state: "working" }));
      }

      await sessionLifecycle.handleNewCommand(
        { kind: "new", repo: "demo-repo", prompt: "add a README", pendingAttachment: { kind: "image", name: "shot.png", bytes: new Uint8Array([1, 2, 3]) } },
        1,
      );

      expect(confirmed[0]?.text).toContain("Refused:");
      expect(confirmed[0]?.text).toContain("attachment you sent was not saved");
    });
  });

  // Extracted from handleNewCommand (code-review finding: the post-launch write-failure branch had
  // no coverage at all, since handleNewCommand itself can't be unit-tested past a real launchSession
  // call) - directly exercises the note text/log line/sourceText-override logic with an injected
  // fake `write`, no real filesystem or launchSession involved.
  describe("applyPendingAttachment", () => {
    test("no pendingAttachment - returns cmd unchanged with no note", async () => {
      const cmd = { kind: "new" as const, repo: "demo-repo", prompt: "add a README" };
      const logs: Array<{ level: string; message: string }> = [];
      const result = await applyPendingAttachment(cmd, "c:\\worktree", "slug-1", (level, message) => logs.push({ level, message }));
      expect(result).toEqual({ cmd, note: "", saved: false });
      expect(logs).toEqual([]);
    });

    test("a successful write overrides sourceText, returns no note, and reports saved: true", async () => {
      const cmd = {
        kind: "new" as const,
        repo: "demo-repo",
        prompt: "add a README",
        pendingAttachment: { kind: "image" as const, name: "shot.png", bytes: new Uint8Array([1]) },
      };
      const fakeWrite = async () => "c:\\worktree\\.aibridge-inbox\\shot.png";

      const result = await applyPendingAttachment(cmd, "c:\\worktree", "slug-1", () => {}, fakeWrite);

      expect(result.note).toBe("");
      expect(result.saved).toBe(true);
      expect(result.cmd.sourceText).toBe("operator sent an image: c:\\worktree\\.aibridge-inbox\\shot.png\nadd a README");
    });

    test("a successful write prefers the raw caption over the clean prompt", async () => {
      const cmd = {
        kind: "new" as const,
        repo: "demo-repo",
        prompt: "add a README",
        pendingAttachment: { kind: "document" as const, name: "spec.pdf", bytes: new Uint8Array([1]), rawCaption: "create a session for demo-repo and add a README" },
      };
      const fakeWrite = async () => "c:\\worktree\\.aibridge-inbox\\spec.pdf";

      const result = await applyPendingAttachment(cmd, "c:\\worktree", "slug-1", () => {}, fakeWrite);

      expect(result.cmd.sourceText).toContain("create a session for demo-repo and add a README");
    });

    test("a failing write logs a WARN and returns a note without mutating cmd", async () => {
      const cmd = {
        kind: "new" as const,
        repo: "demo-repo",
        prompt: "add a README",
        pendingAttachment: { kind: "document" as const, name: "spec.pdf", bytes: new Uint8Array([1]) },
      };
      const logs: Array<{ level: string; message: string }> = [];
      const fakeWrite = async () => {
        throw new Error("disk full");
      };

      const result = await applyPendingAttachment(cmd, "c:\\worktree", "slug-1", (level, message) => logs.push({ level, message }), fakeWrite);

      expect(result.cmd).toBe(cmd);
      expect(result.saved).toBe(false);
      expect(result.note).toContain("couldn't save the attachment - disk full");
      expect(result.note).toContain("re-send it in this topic once it's open");
      expect(logs).toEqual([{ level: "WARN", message: 'failed to save the attachment for "slug-1" into its worktree: disk full' }]);
    });
  });

  // codebase-hardening-plan.md P1-9. `launchSession` isn't injectable here (imported directly, see
  // the comment above `handleNewCommand with a pendingAttachment`), so this drives the real one
  // against a repo path that exists but isn't a git repo - `ensureWorktree` is the very first thing
  // it does, so `git worktree add` fails with a genuine exit 128 and nothing is written to $STATE,
  // `~/.claude.json`, or the worktrees root. That makes it the one launch-failure branch reachable
  // from a unit test, and it is exactly the branch the 2026-08-12 incident went through.
  describe("handleNewCommand when the launch itself fails (P1-9)", () => {
    async function runFailingLaunch() {
      const logs: Array<{ level: string; message: string }> = [];
      const reposRegistry = new ReposRegistry([{ name: "demo-repo", path: os.tmpdir() }]);
      const harness = setup({
        getReposRegistry: () => reposRegistry,
        fleetWorktreesRoot: path.join(os.tmpdir(), "aibridge-p1-9-never-created"),
        log: (level, message) => logs.push({ level, message }),
      });

      await harness.sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: "probe the launch failure path" }, 1);

      return { ...harness, logs };
    }

    test("logs the failure at ERROR with the slug, the repo path and git's exit status", async () => {
      const { logs } = await runFailingLaunch();

      const error = logs.find((entry) => entry.level === "ERROR");
      expect(error).toBeDefined();
      expect(error!.message).toContain("launch failed for");
      expect(error!.message).toContain(os.tmpdir());
      // The whole point of the finding: an exit status where there used to be nothing at all.
      expect(error!.message).toContain("status: 128");
      // git's own reason survives, exactly once - Node already put it in `err.message`, so the
      // separate `stderr:` field is deliberately suppressed rather than duplicating the sentence.
      expect(error!.message).toContain("fatal: not a git repository");
      expect(error!.message.match(/not a git repository/g)).toHaveLength(1);
      // One line, or `grep ERROR bridge.log` shows the header without any of this.
      expect(error!.message).not.toContain("\n");
    });

    test("tells the operator how it exited, not just that a command failed", async () => {
      const { confirmed } = await runFailingLaunch();

      const failure = confirmed.find((entry) => entry.text.includes("Failed to launch session"));
      expect(failure).toBeDefined();
      expect(failure!.text).toContain("(exit 128)");
    });

    test("still deletes the topic it had already created", async () => {
      // Pre-existing behavior (2026-08-03's orphan-topic fix); asserted here because the P1-9 log
      // call was inserted at the top of this same branch and must not have displaced it.
      const { controlBot } = await runFailingLaunch();

      expect(controlBot.forumTopicCalls.deleted).toEqual([999]);
    });
  });

  // codebase-hardening-plan.md P1-13, found live 2026-08-13: two `/new`s whose prompts sanitize to
  // the same base both passed `uniqueSlug` against a `sessionStore` neither had written to yet,
  // because the check and the `insert` sit ~110 lines and three `await`s apart. Driven through the
  // same failing-launch harness as P1-9 above (the only way to reach `handleNewCommand`'s slug
  // derivation without a real git worktree and PTY spawn) - the slug each call settled on is
  // recoverable from the ERROR line the launch failure logs.
  //
  // Concurrency here is real, not simulated: `handleNewCommand` runs synchronously all the way to
  // its first `await` (`createForumTopic`), so starting the second call before awaiting the first
  // puts both in exactly the window the finding is about. That is also why the fix has to claim the
  // slug in that same synchronous run rather than anywhere after it.
  describe("handleNewCommand's slug race (P1-13)", () => {
    const PROMPT = "probe the launch failure path";
    const BASE_SLUG = "probe-the-launch-failure-path";

    function failingLaunchHarness() {
      const logs: Array<{ level: string; message: string }> = [];
      const reposRegistry = new ReposRegistry([{ name: "demo-repo", path: os.tmpdir() }]);
      const harness = setup({
        getReposRegistry: () => reposRegistry,
        fleetWorktreesRoot: path.join(os.tmpdir(), "aibridge-p1-13-never-created"),
        log: (level, message) => logs.push({ level, message }),
      });
      // Each launch failure logs `launch failed for "<slug>" (repo ...)` - the one place the slug a
      // given call actually settled on is observable from outside.
      const slugsAttempted = (): string[] =>
        logs.filter((entry) => entry.message.startsWith("launch failed for")).map((entry) => entry.message.match(/launch failed for "([^"]+)"/)?.[1] ?? "(unparsed)");
      return { ...harness, logs, slugsAttempted };
    }

    test("two concurrent /new commands with the same prompt get distinct slugs", async () => {
      const { sessionLifecycle, slugsAttempted } = failingLaunchHarness();

      // Deliberately NOT awaited in turn: both promises must be in flight at once, or this asserts
      // the sequential behaviour (which was always correct) and would pass against the bug.
      await Promise.all([
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
      ]);

      const attempted = slugsAttempted();
      expect(attempted).toHaveLength(2);
      expect(new Set(attempted).size).toBe(2);
      // The second one is `uniqueSlug`'s ordinary suffix, not some other disambiguation - a slug is
      // also the worktree directory name (§7.5), so its shape is load-bearing, not cosmetic.
      expect(attempted.sort()).toEqual([BASE_SLUG, `${BASE_SLUG}-2`]);
    });

    test("a reservation is released once the attempt finishes, so a later /new reuses the base slug", async () => {
      const { sessionLifecycle, slugsAttempted } = failingLaunchHarness();

      await Promise.all([
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
      ]);
      // Both failed, so nothing is persisted and nothing is in flight - the base slug is genuinely
      // free again. A leaked reservation is permanent for the Bridge's lifetime and would show up
      // here as an ever-climbing `-2`, `-3`, ... on a fleet that has no sessions at all.
      await sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1);

      expect(slugsAttempted()[2]).toBe(BASE_SLUG);
    });

    test("three concurrent /new commands get three distinct slugs", async () => {
      const { sessionLifecycle, slugsAttempted } = failingLaunchHarness();

      await Promise.all([
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
      ]);

      expect(slugsAttempted().sort()).toEqual([BASE_SLUG, `${BASE_SLUG}-2`, `${BASE_SLUG}-3`]);
    });

    test("an in-flight slug is excluded on top of, not instead of, the persisted ones", async () => {
      const { sessionLifecycle, sessionStore, slugsAttempted } = failingLaunchHarness();
      // A live session already holds the base slug, so the two racing calls must skip past it to
      // `-2` and `-3` - the union of both sources, not whichever one the fix happened to consult.
      sessionStore.insert(row({ slug: BASE_SLUG, topicId: 42, sessionId: "sess-base" }));

      await Promise.all([
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
        sessionLifecycle.handleNewCommand({ kind: "new", repo: "demo-repo", prompt: PROMPT }, 1),
      ]);

      expect(slugsAttempted().sort()).toEqual([`${BASE_SLUG}-2`, `${BASE_SLUG}-3`]);
    });
  });

  // P1-13's other half. `handleNewCommand` cannot be driven past `launchSession` from a unit test
  // (real git worktree + real PTY spawn - see the P1-9 block above), and this teardown only ever
  // runs on a day something else has already gone wrong, so it is exported and driven directly
  // rather than left as untested closure code. Same reasoning as `applyPendingAttachment`.
  describe("abandonHalfBuiltSession (P1-13)", () => {
    function teardownHarness(overrides: Partial<NewSessionTeardownDeps> = {}) {
      const logs: Array<{ level: string; message: string }> = [];
      const calls = {
        untracked: [] as string[],
        clearedPtyWrite: [] as string[],
        forgottenRoutes: [] as string[],
        forgottenFeeds: [] as string[],
        deletedTopics: [] as number[],
        removedWorktrees: [] as Array<{ repoPath: string; worktreePath: string }>,
        cleanedDiffRefs: [] as string[],
        forgottenInboxCaches: [] as string[],
        removedRows: [] as string[],
        killed: 0,
      };
      const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
      const deps: NewSessionTeardownDeps = {
        log: (level, message) => logs.push({ level, message }),
        confirmSessionCommand: (topicId, text) => confirmed.push({ topicId, text }),
        removeSessionRow: async (r) => {
          calls.removedRows.push(r.slug);
          return true;
        },
        getRow: () => undefined,
        untrack: (slug) => calls.untracked.push(slug),
        clearPtyWrite: (slug) => calls.clearedPtyWrite.push(slug),
        forgetRoute: (slug) => calls.forgottenRoutes.push(slug),
        forgetFeed: (slug) => calls.forgottenFeeds.push(slug),
        deleteForumTopic: async (topicId) => {
          calls.deletedTopics.push(topicId);
        },
        removeWorktreeFn: async (repoPath, worktreePath) => {
          calls.removedWorktrees.push({ repoPath, worktreePath });
        },
        cleanupDiffRefsFn: (_worktreePath, slug) => calls.cleanedDiffRefs.push(slug),
        forgetInboxGitignoreCacheFn: (worktreePath) => calls.forgottenInboxCaches.push(worktreePath),
        ...overrides,
      };
      const attempt = {
        slug: "half-built",
        topicId: 999,
        launched: {
          ptyProcess: {
            kill: () => {
              calls.killed += 1;
            },
          },
          worktreePath: "c:\\data\\worktrees\\half-built",
          repoPath: "c:\\data\\projects\\demo",
        },
        clearPlaceholder: async () => {
          placeholderCleared += 1;
        },
      };
      let placeholderCleared = 0;
      return { deps, attempt, logs, calls, confirmed, placeholdersCleared: () => placeholderCleared };
    }

    test("a launched-but-untracked session is killed, unwired, its worktree and topic removed", async () => {
      const { deps, attempt, calls } = teardownHarness();

      await abandonHalfBuiltSession(attempt, 1, new Error("UNIQUE constraint failed: sessions.slug"), deps);

      // The whole finding in one assertion: the process that used to survive this is killed.
      expect(calls.killed).toBe(1);
      expect(calls.untracked).toEqual(["half-built"]);
      expect(calls.clearedPtyWrite).toEqual(["half-built"]);
      expect(calls.forgottenRoutes).toEqual(["half-built"]);
      expect(calls.forgottenFeeds).toEqual(["half-built"]);
      expect(calls.removedWorktrees).toEqual([{ repoPath: "c:\\data\\projects\\demo", worktreePath: "c:\\data\\worktrees\\half-built" }]);
      expect(calls.deletedTopics).toEqual([999]);
      expect(calls.forgottenInboxCaches).toEqual(["c:\\data\\worktrees\\half-built"]);
      // `removeSessionRow` is the tracked-row path only - there is no row here to remove.
      expect(calls.removedRows).toEqual([]);
    });

    test("diff refs are cleaned before the worktree they need as their cwd is deleted", async () => {
      // Ordering constraint `removeSessionRow` already documents; asserted rather than trusted,
      // since getting it backwards fails silently (cleanupDiffRefs swallows its own errors).
      const order: string[] = [];
      const { deps, attempt } = teardownHarness({
        cleanupDiffRefsFn: () => order.push("cleanupDiffRefs"),
        removeWorktreeFn: async () => {
          order.push("removeWorktree");
        },
      });

      await abandonHalfBuiltSession(attempt, 1, new Error("boom"), deps);

      expect(order).toEqual(["cleanupDiffRefs", "removeWorktree"]);
    });

    test("a tracked session goes through removeSessionRow instead, with no second kill", async () => {
      const trackedRow = row({ slug: "half-built", topicId: 999 });
      const { deps, attempt, calls } = teardownHarness({ getRow: () => trackedRow });

      await abandonHalfBuiltSession({ ...attempt, tracked: true }, 1, new Error("boom"), deps);

      expect(calls.removedRows).toEqual(["half-built"]);
      // `removeSessionRow` does its own killing and worktree removal - doing it here as well would
      // be a second teardown racing the first over the same directory.
      expect(calls.killed).toBe(0);
      expect(calls.removedWorktrees).toEqual([]);
      expect(calls.deletedTopics).toEqual([]);
    });

    test("a worktree that will not delete is named in the operator's message, not just the log", async () => {
      const { deps, attempt, confirmed, logs, calls } = teardownHarness({
        removeWorktreeFn: async () => {
          throw new Error("Device or resource busy");
        },
      });

      await abandonHalfBuiltSession(attempt, 1, new Error("boom"), deps);

      expect(confirmed[0]!.text).toContain("c:\\data\\worktrees\\half-built");
      expect(logs.some((entry) => entry.level === "WARN" && entry.message.includes("removeWorktree failed"))).toBe(true);
      // A failed worktree removal must not stop the topic being cleaned up too.
      expect(calls.deletedTopics).toEqual([999]);
    });

    test("a topic that will not delete appends the orphan-topic note", async () => {
      const { deps, attempt, confirmed } = teardownHarness({
        deleteForumTopic: async () => {
          throw new Error("TOPIC_ID_INVALID");
        },
      });

      await abandonHalfBuiltSession(attempt, 1, new Error("boom"), deps);

      expect(confirmed[0]!.text).toContain(ORPHAN_TOPIC_NOTE.trim());
    });

    test("an attempt that never launched anything tears nothing down but still reports", async () => {
      const { deps, attempt, calls, confirmed } = teardownHarness();

      await abandonHalfBuiltSession({ slug: attempt.slug, topicId: attempt.topicId }, 1, new Error("boom"), deps);

      expect(calls.killed).toBe(0);
      expect(calls.removedWorktrees).toEqual([]);
      expect(calls.deletedTopics).toEqual([]);
      expect(confirmed[0]!.text).toContain('Failed to create "half-built"');
    });

    test("logs the original failure at ERROR with its stack, and reports its message to the operator", async () => {
      const { deps, attempt, logs, confirmed } = teardownHarness();

      await abandonHalfBuiltSession(attempt, 7, new Error("UNIQUE constraint failed: sessions.slug"), deps);

      const error = logs.find((entry) => entry.level === "ERROR");
      expect(error!.message).toContain('/new failed for "half-built"');
      // The stack is the point: this branch only runs for failures nothing anticipated.
      expect(error!.message).toContain("session-lifecycle-commands.test");
      expect(confirmed[0]).toEqual({
        topicId: 7,
        text: expect.stringContaining("UNIQUE constraint failed: sessions.slug") as unknown as string,
      });
    });

    test("clears an NL-/new's thinking placeholder", async () => {
      const { deps, attempt, placeholdersCleared } = teardownHarness();

      await abandonHalfBuiltSession(attempt, 1, new Error("boom"), deps);

      expect(placeholdersCleared()).toBe(1);
    });

    test("never rethrows, even when the report to the operator is what fails", async () => {
      // This runs from a `catch`. A throw on the way out would put the original failure straight
      // back into the hole this function exists to close - and, via fireAndForget, would replace a
      // precise "/new failed for X" log with a generic unhandled-rejection one.
      const { deps, attempt, logs, calls } = teardownHarness({
        confirmSessionCommand: () => {
          throw new Error("Telegram is down");
        },
      });

      await abandonHalfBuiltSession(attempt, 1, new Error("boom"), deps);

      // The teardown itself still completed - only the report failed, and it said so.
      expect(calls.killed).toBe(1);
      expect(calls.deletedTopics).toEqual([999]);
      expect(logs.some((entry) => entry.level === "WARN" && entry.message.includes("could not report the failed /new"))).toBe(true);
    });
  });
});
