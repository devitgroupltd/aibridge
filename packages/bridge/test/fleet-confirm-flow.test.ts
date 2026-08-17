import { describe, expect, test } from "bun:test";
import { createConfirmSessionCommand, createFleetConfirmFlow, createStopIndicatorsForTopic } from "../src/fleet-confirm-flow.ts";
import { FleetConfirmRegistry } from "../src/fleet-confirm.ts";
import type { PendingFleetConfirm } from "../src/fleet-confirm.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { Routing } from "../src/routing.ts";
import type { RemoveSessionRowResult } from "../src/remove-outcome.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import { fakeControlBot } from "./helpers.ts";

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

/** The shared double (helpers.ts) plus the forum-topic calls, and a switch for making the next
 * `deleteForumTopic` fail - the orphan-topic path this module owns turns on that failure. */
function fakeFleetBot() {
  const deletedTopics: number[] = [];
  let failDelete = false;
  return {
    ...fakeControlBot(),
    deleteForumTopic: async (_chatId: unknown, messageThreadId: number) => {
      if (failDelete) throw new Error("Telegram rejected the delete");
      deletedTopics.push(messageThreadId);
    },
    createForumTopic: async () => ({ message_thread_id: 999 }),
    editForumTopic: async () => {},
    closeForumTopic: async () => {},
    deletedTopics,
    failDeleteNextTime() {
      failDelete = true;
    },
  };
}

describe("createConfirmSessionCommand", () => {
  test("schedules the send through the P1 lane and delivers text/keyboard/parseMode", async () => {
    const controlBot = fakeFleetBot();
    const feedGovernor = new RateGovernor({ log: () => {} });
    const confirmSessionCommand = createConfirmSessionCommand({ feedGovernor, controlBot, supergroupChatId: "-100", log: () => {} });

    confirmSessionCommand(5, "hello", "HTML", { inline_keyboard: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(controlBot.sent).toEqual([{ topicId: 5, text: "hello", keyboard: { inline_keyboard: [] } }]);
  });

  test("a failed send is logged, not thrown", async () => {
    // §5.4's P1 lane retries a failure up to 3 times with real backoff - fake the timer so this
    // test doesn't have to wait out 1s/2s/4s of real delay before the rejection finally surfaces.
    const feedGovernor = new RateGovernor({ log: () => {}, setTimeoutFn: (fn) => setImmediate(fn), clearTimeoutFn: () => {} });
    const warnings: string[] = [];
    const failingBot = { sendMessage: async () => Promise.reject(new Error("network down")) };
    const confirmSessionCommand = createConfirmSessionCommand({ feedGovernor, controlBot: failingBot, supergroupChatId: "-100", log: (level, msg) => warnings.push(`${level}: ${msg}`) });

    confirmSessionCommand(undefined, "hello");
    // 3 retries, each hopping through a setImmediate - wait out enough real macrotask turns.
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(warnings.some((w) => w.includes("failed to send command confirmation"))).toBe(true);
  });
});

describe("createStopIndicatorsForTopic", () => {
  function fakeTypingIndicator() {
    const stopped: string[] = [];
    return { start: () => {}, stop: (key: string) => stopped.push(key), stopped };
  }
  function fakeThinkingPlaceholder(messageId: number | undefined) {
    return { start: () => {}, consume: async () => messageId };
  }

  test("stops the typing indicator for the topic", () => {
    const typingIndicator = fakeTypingIndicator();
    const thinkingPlaceholder = fakeThinkingPlaceholder(undefined);
    const controlBot = fakeFleetBot();
    const feedGovernor = new RateGovernor({ log: () => {} });
    const stopIndicatorsForTopic = createStopIndicatorsForTopic({ typingIndicator, thinkingPlaceholder, controlBot, feedGovernor, supergroupChatId: "-100", log: () => {} });

    stopIndicatorsForTopic(5);

    expect(typingIndicator.stopped).toEqual(["5"]);
  });

  test("edits the thinking placeholder to 'Session ended.' when one was pending", async () => {
    const typingIndicator = fakeTypingIndicator();
    const thinkingPlaceholder = fakeThinkingPlaceholder(42);
    const controlBot = fakeFleetBot();
    const feedGovernor = new RateGovernor({ log: () => {} });
    const stopIndicatorsForTopic = createStopIndicatorsForTopic({ typingIndicator, thinkingPlaceholder, controlBot, feedGovernor, supergroupChatId: "-100", log: () => {} });

    stopIndicatorsForTopic(5);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controlBot.edited).toEqual([{ messageId: 42, text: "Session ended." }]);
  });

  test("does nothing when there was no pending placeholder", async () => {
    const typingIndicator = fakeTypingIndicator();
    const thinkingPlaceholder = fakeThinkingPlaceholder(undefined);
    const controlBot = fakeFleetBot();
    const feedGovernor = new RateGovernor({ log: () => {} });
    const stopIndicatorsForTopic = createStopIndicatorsForTopic({ typingIndicator, thinkingPlaceholder, controlBot, feedGovernor, supergroupChatId: "-100", log: () => {} });

    stopIndicatorsForTopic(5);
    await Promise.resolve();
    await Promise.resolve();

    expect(controlBot.edited).toEqual([]);
  });
});

function setup(overrides: { killSessionRow?: (row: SessionRow) => Promise<void>; removeSessionRow?: (row: SessionRow) => Promise<RemoveSessionRowResult>; resolveTargetSlug?: (explicit: string | undefined, currentSlug: string | undefined) => { slug: string } | { error: string } } = {}) {
  const controlBot = fakeFleetBot();
  const routing = new Routing();
  const sessionStore = new SessionStore(":memory:");
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  const finalizeCalls: Array<{ pending: PendingFleetConfirm; text: string }> = [];
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const killed: string[] = [];
  const removed: string[] = [];
  const autoToggles: Array<{ slug: string; category: string; on: boolean }> = [];
  const usageWaiters = new Map<string, { buffer: string; check: () => void }>();
  const confirmCards = {
    finalizeFleetConfirmMessage: async (pending: PendingFleetConfirm, text: string) => {
      finalizeCalls.push({ pending, text });
    },
  };
  const sessionLifecycle = {
    killSessionRow: overrides.killSessionRow ?? (async (r: SessionRow) => {
      killed.push(r.slug);
    }),
    removeSessionRow: overrides.removeSessionRow ?? (async (r: SessionRow) => {
      removed.push(r.slug);
      return { topicDeleted: true, worktreeRemoved: true };
    }),
    resolveTargetSlug: overrides.resolveTargetSlug ?? ((explicit: string | undefined, currentSlug: string | undefined) => {
      const slug = explicit ?? currentSlug;
      return slug ? { slug } : { error: "No session specified and this isn't a session topic." };
    }),
    // Recorded by name, not by its effect on `routing`: a test asserting only the resulting
    // `getBypass(slug)` value passes just as happily against a `routing.setBypass` call here, which
    // is the drain-skipping path §0.3 exists to forbid.
    applyAutoToggle: (slug: string, category: "permission" | "answer", on: boolean) => {
      autoToggles.push({ slug, category, on });
    },
  };
  const fleetConfirmFlow = createFleetConfirmFlow({
    controlBot,
    routing,
    sessionStore,
    confirmCards: confirmCards as never,
    fleetConfirmRegistry,
    sessionLifecycle,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text });
    },
    usageWaiters,
    supergroupChatId: "-100",
    log: () => {},
  });
  return { fleetConfirmFlow, controlBot, routing, sessionStore, fleetConfirmRegistry, finalizeCalls, confirmed, killed, removed, autoToggles };
}

describe("createFleetConfirmFlow", () => {
  describe("postFleetConfirm", () => {
    test("with no targets, reports there's nothing to do and posts no card", async () => {
      const { fleetConfirmFlow, controlBot, confirmed } = setup();

      await fleetConfirmFlow.postFleetConfirm("kill", 1, [], "Kill 0 sessions?");

      expect(confirmed[0]?.text).toBe("No live sessions to kill.");
      expect(controlBot.sent).toEqual([]);
    });

    test("with no targets for an auto kind, uses that kind's own copy, not the teardown wording", async () => {
      const { fleetConfirmFlow, controlBot, confirmed } = setup();

      await fleetConfirmFlow.postFleetConfirm("permission-on", 1, [], "Turn auto-permission ON for every live session?");

      expect(confirmed[0]?.text).toBe("No live sessions to change.");
      expect(controlBot.sent).toEqual([]);
    });

    test("posts the Yes/No card and registers it in the registry", async () => {
      const { fleetConfirmFlow, controlBot, fleetConfirmRegistry } = setup();

      await fleetConfirmFlow.postFleetConfirm("rm", 1, [row()], "Remove 1 session?");

      expect(controlBot.sent[0]?.text).toContain("fix-bug");
      expect(controlBot.sent[0]?.keyboard).toBeDefined();
      const button = (controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard[0]?.[0];
      const id = button?.callback_data?.split(":")[2];
      expect(id).toBeDefined();
      expect(fleetConfirmRegistry.take(id!)?.entry.slugs).toEqual(["fix-bug"]);
    });
  });

  describe("executeFleetConfirm", () => {
    test("rm-topic with no topicId finalizes as nothing left to act on", async () => {
      const { fleetConfirmFlow, finalizeCalls } = setup();
      const pending: PendingFleetConfirm = { id: "abc", kind: "rm-topic", slugs: [], topicId: undefined, messageId: 1, createdAt: Date.now() };

      await fleetConfirmFlow.executeFleetConfirm(pending);

      expect(finalizeCalls[0]?.text).toBe("Nothing left to act on.");
    });

    test("rm-topic deletes the forum topic and finalizes", async () => {
      const { fleetConfirmFlow, controlBot, finalizeCalls } = setup();
      const pending: PendingFleetConfirm = { id: "abc", kind: "rm-topic", slugs: [], topicId: 7, messageId: 1, createdAt: Date.now() };

      await fleetConfirmFlow.executeFleetConfirm(pending);

      expect(controlBot.deletedTopics).toEqual([7]);
      expect(finalizeCalls[0]?.text).toBe("Topic deleted.");
    });

    test("rm-topic reports when Telegram refuses the delete", async () => {
      const { fleetConfirmFlow, controlBot, finalizeCalls } = setup();
      controlBot.failDeleteNextTime();
      const pending: PendingFleetConfirm = { id: "abc", kind: "rm-topic", slugs: [], topicId: 7, messageId: 1, createdAt: Date.now() };

      await fleetConfirmFlow.executeFleetConfirm(pending);

      expect(finalizeCalls[0]?.text).toContain("would not delete this topic");
    });

    test("kill tears down each row via sessionLifecycle.killSessionRow and finalizes a summary", async () => {
      const { fleetConfirmFlow, sessionStore, killed, finalizeCalls } = setup();
      sessionStore.insert(row({ slug: "a", sessionId: "s-a", topicId: 10 }));
      sessionStore.insert(row({ slug: "b", sessionId: "s-b", topicId: 11 }));
      const pending: PendingFleetConfirm = { id: "abc", kind: "kill", slugs: ["a", "b"], topicId: 1, messageId: 1, createdAt: Date.now() };

      await fleetConfirmFlow.executeFleetConfirm(pending);

      expect(killed).toEqual(["a", "b"]);
      expect(finalizeCalls[0]?.text).toContain("Killed 2 sessions: a, b");
    });

    test("rm appends the orphan-topic note when a topic couldn't be deleted", async () => {
      const { fleetConfirmFlow, sessionStore, finalizeCalls } = setup({ removeSessionRow: async () => ({ topicDeleted: false, worktreeRemoved: true }) });
      sessionStore.insert(row({ slug: "a", sessionId: "s-a" }));
      const pending: PendingFleetConfirm = { id: "abc", kind: "rm", slugs: ["a"], topicId: 1, messageId: 1, createdAt: Date.now() };

      await fleetConfirmFlow.executeFleetConfirm(pending);

      expect(finalizeCalls[0]?.text).toContain("Removed 1 session: a");
      expect(finalizeCalls[0]?.text).toContain("Telegram topic itself could not be deleted");
      // The other half must stay quiet: a note about worktrees still on disk, on a run where every
      // worktree came away cleanly, is the same lie in the opposite direction.
      expect(finalizeCalls[0]?.text).not.toContain("still on disk");
    });

    // The bulk half of the 2026-08-17 finding. The previous shape of this code read
    // `if (!(await removeSessionRow(row)))`, which an object return makes permanently falsy - so this
    // note would silently never appear, and TypeScript has nothing to say about `!someObject`.
    test("rm reports worktrees left on disk, naming them, and pluralizes for one", async () => {
      const { fleetConfirmFlow, sessionStore, finalizeCalls } = setup({ removeSessionRow: async () => ({ topicDeleted: true, worktreeRemoved: false }) });
      sessionStore.insert(row({ slug: "a", sessionId: "s-a" }));
      sessionStore.insert(row({ slug: "b", topicId: 6, sessionId: "s-b" }));

      await fleetConfirmFlow.executeFleetConfirm({ id: "abc", kind: "rm", slugs: ["a", "b"], topicId: 1, messageId: 1, createdAt: Date.now() });
      expect(finalizeCalls[0]?.text).toContain("2 worktrees could not be deleted and are still on disk (a, b)");
      expect(finalizeCalls[0]?.text).not.toContain("Telegram topic");

      await fleetConfirmFlow.executeFleetConfirm({ id: "def", kind: "rm", slugs: ["a"], topicId: 1, messageId: 2, createdAt: Date.now() });
      expect(finalizeCalls[1]?.text).toContain("1 worktree could not be deleted and is still on disk (a) - remove it by hand.");
    });

    // bypass-and-autoanswer-plan.md §0.3: the four `/auto <category> --all` kinds must be handled by
    // an early return placed *ahead* of the kill/rm loop. Without it the loop's bare `else` absorbs
    // them and a tap on "Turn auto-permission ON for every live session?" removes the entire fleet -
    // while still compiling cleanly, since `pending.kind === "kill"` stays well-typed as the union
    // grows. These four tests are that regression's guard.
    describe("the /auto --all kinds", () => {
      test("permission-on toggles every re-looked-up row via applyAutoToggle and tears nothing down", async () => {
        const { fleetConfirmFlow, sessionStore, autoToggles, killed, removed, finalizeCalls } = setup();
        sessionStore.insert(row({ slug: "a", sessionId: "s-a", topicId: 10 }));
        sessionStore.insert(row({ slug: "b", sessionId: "s-b", topicId: 11 }));
        const pending: PendingFleetConfirm = { id: "abc", kind: "permission-on", slugs: ["a", "b"], topicId: 1, messageId: 1, createdAt: Date.now() };

        await fleetConfirmFlow.executeFleetConfirm(pending);

        expect(autoToggles).toEqual([
          { slug: "a", category: "permission", on: true },
          { slug: "b", category: "permission", on: true },
        ]);
        // The assertion `applyAutoToggle` does *not* imply: an explicit zero call-count on the
        // teardown the misplaced-branch bug would have run instead.
        expect(removed).toHaveLength(0);
        expect(killed).toHaveLength(0);
        // Line 170's *second* bare else, which survives a correctly-placed branch: the summary must
        // not say "Removed 2 sessions" under a card that said the opposite.
        expect(finalizeCalls[0]?.text).toBe("Auto-permission ON for 2 sessions: a, b");
      });

      test("answer-off carries the category and value through the kind, not a hyphen-split guess", async () => {
        const { fleetConfirmFlow, sessionStore, autoToggles, finalizeCalls } = setup();
        sessionStore.insert(row({ slug: "a", sessionId: "s-a" }));
        const pending: PendingFleetConfirm = { id: "abc", kind: "answer-off", slugs: ["a"], topicId: 1, messageId: 1, createdAt: Date.now() };

        await fleetConfirmFlow.executeFleetConfirm(pending);

        expect(autoToggles).toEqual([{ slug: "a", category: "answer", on: false }]);
        expect(finalizeCalls[0]?.text).toBe("Auto-answer OFF for 1 session: a");
      });

      test("a slug whose row is gone by tap time is skipped, by slug, not merely by count", async () => {
        // §0.3's stale-slug hazard: `uniqueSlug` de-duplicates only against *live* slugs, so a name
        // freed between posting and tapping can already belong to an unrelated new session - which
        // would then start silently auto-permitted. A call-count check alone passes when the wrong
        // set of slugs is toggled, hence asserting on the argument.
        const { fleetConfirmFlow, sessionStore, autoToggles, finalizeCalls } = setup();
        sessionStore.insert(row({ slug: "a", sessionId: "s-a" }));
        const pending: PendingFleetConfirm = { id: "abc", kind: "permission-on", slugs: ["a", "gone"], topicId: 1, messageId: 1, createdAt: Date.now() };

        await fleetConfirmFlow.executeFleetConfirm(pending);

        expect(autoToggles).toEqual([{ slug: "a", category: "permission", on: true }]);
        expect(finalizeCalls[0]?.text).toBe("Auto-permission ON for 1 session: a");
      });

      test("every slug gone finalizes 'nothing left', not an empty ON summary", async () => {
        const { fleetConfirmFlow, autoToggles, finalizeCalls } = setup();
        const pending: PendingFleetConfirm = { id: "abc", kind: "permission-on", slugs: ["ghost"], topicId: 1, messageId: 1, createdAt: Date.now() };

        await fleetConfirmFlow.executeFleetConfirm(pending);

        expect(autoToggles).toEqual([]);
        expect(finalizeCalls[0]?.text).toBe("Nothing left to act on.");
      });
    });

    test("no rows left to act on (all slugs vanished) finalizes 'nothing left'", async () => {
      const { fleetConfirmFlow, finalizeCalls } = setup();
      const pending: PendingFleetConfirm = { id: "abc", kind: "kill", slugs: ["ghost"], topicId: 1, messageId: 1, createdAt: Date.now() };

      await fleetConfirmFlow.executeFleetConfirm(pending);

      expect(finalizeCalls[0]?.text).toBe("Nothing left to act on.");
    });
  });

  describe("executeFleetActionDirect", () => {
    test("with no targets, reports there's nothing to do", async () => {
      const { fleetConfirmFlow, confirmed } = setup();

      await fleetConfirmFlow.executeFleetActionDirect("rm", 1, []);

      expect(confirmed[0]?.text).toBe("No sessions to remove.");
    });

    test("tears down each target directly and confirms a summary, no card involved", async () => {
      const { fleetConfirmFlow, killed, confirmed, controlBot } = setup();

      await fleetConfirmFlow.executeFleetActionDirect("kill", 1, [row({ slug: "a" }), row({ slug: "b" })]);

      expect(killed).toEqual(["a", "b"]);
      expect(confirmed[0]?.text).toBe("Killed 2 sessions: a, b");
      expect(controlBot.sent).toEqual([]); // confirmSessionCommand, not a posted card
    });
  });

  describe("requestUsagePanel / handleUsageCommand", () => {
    test("with no live PTY for the slug, resolves with a clear message", async () => {
      const { fleetConfirmFlow } = setup();

      const result = await fleetConfirmFlow.requestUsagePanel("fix-bug", 50);

      expect(result).toContain('No live PTY for "fix-bug"');
    });

    test("a concurrent capture for the same slug is refused, not queued", async () => {
      const { fleetConfirmFlow, routing } = setup();
      routing.setPtyWrite("fix-bug", () => {});

      const first = fleetConfirmFlow.requestUsagePanel("fix-bug", 50);
      const second = await fleetConfirmFlow.requestUsagePanel("fix-bug", 50);

      expect(second).toContain("already in flight");
      await first;
    });

    test("falls back to whatever was captured by the timeout", async () => {
      const { fleetConfirmFlow, routing } = setup();
      routing.setPtyWrite("fix-bug", () => {});

      const result = await fleetConfirmFlow.requestUsagePanel("fix-bug", 20);

      expect(typeof result).toBe("string");
    });

    test("handleUsageCommand reports resolveTargetSlug's error without querying a panel", async () => {
      const { fleetConfirmFlow, confirmed } = setup({ resolveTargetSlug: () => ({ error: "No session specified." }) });

      await fleetConfirmFlow.handleUsageCommand({ kind: "usage", slug: undefined }, 1, undefined);

      expect(confirmed[0]?.text).toBe("No session specified.");
    });

    test("handleUsageCommand resolves the slug then confirms the panel summary", async () => {
      const { fleetConfirmFlow, confirmed } = setup({ resolveTargetSlug: () => ({ slug: "fix-bug" }) });

      await fleetConfirmFlow.handleUsageCommand({ kind: "usage", slug: undefined }, 1, "fix-bug");

      expect(confirmed[0]?.text).toContain('No live PTY for "fix-bug"');
    });
  });
});
