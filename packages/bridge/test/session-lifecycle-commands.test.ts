import { describe, expect, test } from "bun:test";
import { AskRegistry } from "../src/ask-registry.ts";
import { CostTracker } from "../src/cost-tracker.ts";
import { FleetConfirmRegistry } from "../src/fleet-confirm.ts";
import { PermissionRegistry } from "../src/permission-registry.ts";
import { Routing } from "../src/routing.ts";
import { createSessionLifecycleCommands, ORPHAN_TOPIC_NOTE } from "../src/session-lifecycle-commands.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";

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
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
    createdUtc: "2026-08-08T00:00:00.000Z",
    lastEventUtc: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function fakeControlBot() {
  const sent: Array<{ topicId: number | undefined; text: string; keyboard?: unknown }> = [];
  const forumTopicCalls = { closed: [] as number[], deleted: [] as number[] };
  return {
    sendMessage: async (_chatId: unknown, topicId: number | undefined, text: string, replyMarkup?: unknown) => {
      sent.push({ topicId, text, keyboard: replyMarkup });
      return { message_id: sent.length };
    },
    createForumTopic: async () => ({ message_thread_id: 999 }),
    editForumTopic: async () => {},
    closeForumTopic: async (_chatId: unknown, topicId: number) => {
      forumTopicCalls.closed.push(topicId);
    },
    deleteForumTopic: async (_chatId: unknown, topicId: number) => {
      forumTopicCalls.deleted.push(topicId);
    },
    sent,
    forumTopicCalls,
  };
}

function fakeSessionSupervisor() {
  const calls = { killAndUntrack: [] as string[], untrack: [] as string[] };
  return {
    isPidAlive: () => false,
    reapRowsWithDeletedTopics: async () => [],
    reportOrphanProcesses: async () => {},
    runStartupReconciliation: async () => {},
    wireSession: () => {},
    handleUnexpectedExit: async () => {},
    resumeSession: async () => {},
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
  const controlBot = fakeControlBot();
  const sessionSupervisor = fakeSessionSupervisor();
  const ptyIo = fakePtyIo();
  const feedWiring = {
    allFeedStates: () => new Map(),
    forgetSession: () => {},
  };
  const permissionRegistry = new PermissionRegistry();
  const askRegistry = new AskRegistry();
  const costTracker = new CostTracker();
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const postFleetConfirmCalls: Array<{ kind: string; topicId: number | undefined; targets: string[] }> = [];
  const executeFleetActionDirectCalls: Array<{ kind: string; topicId: number | undefined; targets: string[] }> = [];
  const finalizedMessages: Array<{ messageId: number; text: string }> = [];

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
    stopIndicatorsForTopic: () => {},
    postFleetConfirm: async (kind, topicId, targets) => {
      postFleetConfirmCalls.push({ kind, topicId, targets: targets.map((r) => r.slug) });
    },
    executeFleetActionDirect: async (kind, topicId, targets) => {
      executeFleetActionDirectCalls.push({ kind, topicId, targets: targets.map((r) => r.slug) });
    },
    writeModeKeystrokes: () => {},
    waitForChannelConnected: async () => {},
    isControlTopic: (topicId) => topicId === undefined || topicId === 1,
    getReposRegistry: () => undefined,
    getDefaultSessionMode: () => "manual",
    getDefaultSessionEffort: () => "medium",
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
      expect(confirmed[0]?.text).toContain("Paused");
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
          ...fakeControlBot(),
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
});
