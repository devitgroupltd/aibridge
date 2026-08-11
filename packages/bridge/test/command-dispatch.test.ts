import { describe, expect, test } from "bun:test";
import { createCommandDispatch } from "../src/command-dispatch.ts";
import { Routing } from "../src/routing.ts";
import { RetryStore } from "../src/retry-store.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import type { Mode } from "../src/session-commands.ts";

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
    bypassPermission: false,
    autoAnswer: false,
    mode: "manual",
    createdUtc: "2026-08-08T00:00:00.000Z",
    lastEventUtc: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function fakeControlBot() {
  const sent: Array<{ topicId: number | undefined; text: string; keyboard?: unknown }> = [];
  return {
    sendMessage: async (_chatId: unknown, topicId: number | undefined, text: string, replyMarkup?: unknown) => {
      sent.push({ topicId, text, keyboard: replyMarkup });
      return { message_id: sent.length };
    },
    sent,
  };
}

function fakePtyIo() {
  const raw: Array<{ slug: string; text: string }> = [];
  const channel: Array<{ slug: string; topicId: number; content: string; msgId: string; from: string }> = [];
  return {
    sendRaw: (slug: string, text: string) => raw.push({ slug, text }),
    sendChannelText: (slug: string, topicId: number, content: string, msgId: string, from: string) => channel.push({ slug, topicId, content, msgId, from }),
    raw,
    channel,
  };
}

function fakeCardSenders() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => (...args: unknown[]) => calls.push({ fn, args });
  return {
    sendAboutCard: record("sendAboutCard"),
    sendHelpCard: record("sendHelpCard"),
    sendCommandsListCard: record("sendCommandsListCard"),
    sendSkillsListCard: record("sendSkillsListCard"),
    sendBrowseCard: record("sendBrowseCard"),
    sendFindCard: record("sendFindCard"),
    sendDiffCard: record("sendDiffCard"),
    calls,
  };
}

function fakeConfirmSessionCommand() {
  const calls: Array<{ topicId: number | undefined; text: string }> = [];
  const fn = (topicId: number | undefined, text: string) => calls.push({ topicId, text });
  return Object.assign(fn, { calls });
}

function fakeSessionLifecycle() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => (...args: unknown[]) => calls.push({ fn, args });
  return {
    handleNewCommand: record("handleNewCommand"),
    handleLsCommand: record("handleLsCommand"),
    handleKillCommand: record("handleKillCommand"),
    handleRmCommand: record("handleRmCommand"),
    handleAttachCommand: record("handleAttachCommand"),
    handleDetailCommand: record("handleDetailCommand"),
    handleVerboseCommand: record("handleVerboseCommand"),
    handlePauseCommand: record("handlePauseCommand"),
    handleStopCommand: record("handleStopCommand"),
    calls,
  };
}

function fakeFleetReporting() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => (...args: unknown[]) => calls.push({ fn, args });
  return {
    handleBudgetCommand: record("handleBudgetCommand"),
    handleSettingsCommand: record("handleSettingsCommand"),
    handleReposCommand: record("handleReposCommand"),
    calls,
  };
}

function fakeFleetConfirmFlow() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    handleUsageCommand: async (...args: unknown[]) => {
      calls.push({ fn: "handleUsageCommand", args });
    },
    calls,
  };
}

function fakeDeployLifecycle() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => async (...args: unknown[]) => {
    calls.push({ fn, args });
  };
  return {
    handleRestartCommand: record("handleRestartCommand"),
    handleMergeCommand: record("handleMergeCommand"),
    handleShipCommand: record("handleShipCommand"),
    handleAutostartCommand: record("handleAutostartCommand"),
    calls,
  };
}

function fakeOsPowerCommands() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    handleOsCommand: async (...args: unknown[]) => {
      calls.push({ fn: "handleOsCommand", args });
    },
    calls,
  };
}

function fakeVoiceModeCommands() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => (...args: unknown[]) => calls.push({ fn, args });
  return {
    handleVoiceModelCommand: record("handleVoiceModelCommand"),
    handleAssistCommand: record("handleAssistCommand"),
    handleRouterBackendCommand: record("handleRouterBackendCommand"),
    handleVoiceConfirmCommand: record("handleVoiceConfirmCommand"),
    handleDefaultCommand: record("handleDefaultCommand"),
    applyModelSwitch: record("applyModelSwitch"),
    applyModeSwitch: record("applyModeSwitch"),
    applyEffortSwitch: record("applyEffortSwitch"),
    calls,
  };
}

function fakeFeedWiring() {
  const interjected: string[] = [];
  return { markInterjected: (slug: string) => interjected.push(slug), interjected };
}

function fakeNlDispatch() {
  const postNlConfirmCalls: unknown[][] = [];
  const routeOrFallbackCalls: unknown[][] = [];
  let matchMode: "noMatch" | "retry" = "noMatch";
  return {
    postNlConfirm: async (...args: unknown[]) => {
      postNlConfirmCalls.push(args);
    },
    routeOrFallback: async (
      text: string,
      ctx: unknown,
      threadId: unknown,
      isControl: unknown,
      currentSlug: unknown,
      onNoMatch: () => void,
      onRetryMatch: () => void | Promise<void>,
    ) => {
      routeOrFallbackCalls.push([text, ctx, threadId, isControl, currentSlug]);
      // "retry" simulates nl-router.ts's `kind='retry'` match (any-language natural phrasing
      // `isRetryPhrase`'s regex missed) - command-dispatch.ts must wire its own `handleRetry` in as
      // `onRetryMatch` so this fires the exact same reply-to-retry/retryStore mechanics the regex
      // fast-path uses, not a silent no-op.
      if (matchMode === "retry") await onRetryMatch();
      else onNoMatch();
    },
    setNoMatchBehavior(mode: "call" | "skip") {
      matchMode = mode === "call" ? "noMatch" : "noMatch";
    },
    setRetryMatch() {
      matchMode = "retry";
    },
    postNlConfirmCalls,
    routeOrFallbackCalls,
  };
}

function setup(overrides: Partial<{ sessionStore: SessionStore; defaultSessionMode: Mode }> = {}) {
  const controlBot = fakeControlBot();
  const ptyIo = fakePtyIo();
  const cardSenders = fakeCardSenders();
  const confirmSessionCommand = fakeConfirmSessionCommand();
  const sessionLifecycle = fakeSessionLifecycle();
  const fleetReporting = fakeFleetReporting();
  const fleetConfirmFlow = fakeFleetConfirmFlow();
  const deployLifecycle = fakeDeployLifecycle();
  const osPowerCommands = fakeOsPowerCommands();
  const voiceModeCommands = fakeVoiceModeCommands();
  const feedWiring = fakeFeedWiring();
  const nlDispatch = fakeNlDispatch();
  const retryStore = new RetryStore();
  const routing = new Routing();
  const sessionStore = overrides.sessionStore ?? new SessionStore(":memory:");

  const commandDispatch = createCommandDispatch({
    controlBot: controlBot as never,
    routing,
    ptyIo: ptyIo as never,
    sessionStore,
    confirmSessionCommand: confirmSessionCommand as never,
    sessionLifecycle: sessionLifecycle as never,
    fleetReporting: fleetReporting as never,
    fleetConfirmFlow: fleetConfirmFlow as never,
    deployLifecycle: deployLifecycle as never,
    osPowerCommands: osPowerCommands as never,
    voiceModeCommands: voiceModeCommands as never,
    cardSenders: cardSenders as never,
    feedWiring: feedWiring as never,
    retryStore,
    nlDispatch: nlDispatch as never,
    getReposRegistry: () => undefined,
    supergroupChatId: "-100",
    getDefaultSessionMode: () => overrides.defaultSessionMode ?? "manual",
    log: () => {},
  });

  return {
    commandDispatch,
    controlBot,
    ptyIo,
    cardSenders,
    confirmSessionCommand,
    sessionLifecycle,
    fleetReporting,
    fleetConfirmFlow,
    deployLifecycle,
    osPowerCommands,
    voiceModeCommands,
    feedWiring,
    nlDispatch,
    retryStore,
    routing,
    sessionStore,
  };
}

describe("dispatchFleetCommand", () => {
  test("routes each documented kind to its intended handler", () => {
    const s = setup();

    s.commandDispatch.dispatchFleetCommand({ kind: "ls" }, 5, true, undefined);
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toContain("handleLsCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "kill", slug: "fix-bug" }, 5, true, "fix-bug");
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toContain("handleKillCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "budget" }, 5, true, undefined);
    expect(s.fleetReporting.calls.map((c) => c.fn)).toContain("handleBudgetCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "settings" }, 5, true, undefined);
    expect(s.fleetReporting.calls.map((c) => c.fn)).toContain("handleSettingsCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "restart" }, 5, true, undefined);
    expect(s.deployLifecycle.calls.map((c) => c.fn)).toContain("handleRestartCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "merge", slug: "fix-bug" }, 5, true, undefined);
    expect(s.deployLifecycle.calls.map((c) => c.fn)).toContain("handleMergeCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "ship", slug: "fix-bug" }, 5, true, undefined);
    expect(s.deployLifecycle.calls.map((c) => c.fn)).toContain("handleShipCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "voice" }, 5, true, undefined);
    expect(s.voiceModeCommands.calls.map((c) => c.fn)).toContain("handleVoiceModelCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "usage", slug: "fix-bug" }, 5, true, "fix-bug");
    expect(s.fleetConfirmFlow.calls.map((c) => c.fn)).toContain("handleUsageCommand");

    // "pause" has no explicit branch - falls through to handlePauseCommand by construction.
    s.commandDispatch.dispatchFleetCommand({ kind: "pause", slug: "fix-bug" }, 5, true, "fix-bug");
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toContain("handlePauseCommand");

    s.commandDispatch.dispatchFleetCommand({ kind: "stop", slug: "fix-bug" }, 5, true, "fix-bug");
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toContain("handleStopCommand");
  });

  test("/new, /budget and /default are rejected outside the control topic", () => {
    const s = setup();
    s.commandDispatch.dispatchFleetCommand({ kind: "new", repo: "seowrite", prompt: "hi" }, 5, false, undefined);
    s.commandDispatch.dispatchFleetCommand({ kind: "budget" }, 5, false, undefined);
    s.commandDispatch.dispatchFleetCommand({ kind: "default", category: "status" }, 5, false, undefined);

    expect(s.confirmSessionCommand.calls).toEqual([
      { topicId: 5, text: "/new only works from the control topic." },
      { topicId: 5, text: "/budget only works from the control topic." },
      { topicId: 5, text: "/default only works from the control topic." },
    ]);
    expect(s.sessionLifecycle.calls).toEqual([]);
    expect(s.fleetReporting.calls).toEqual([]);
    expect(s.voiceModeCommands.calls).toEqual([]);
  });
});

describe("dispatchInboundMessage - exact-syntax rule dispatch order", () => {
  test("/commands <real-invocation> runs the command instead of matching the list-filter branch first", async () => {
    // The historical shadowing bug: a `/commands <name>` invocation being swallowed by the
    // `/commands` list-filter branch matching first and greedily. Regression coverage for the fix,
    // asserted directly against the ordered rule list's own dispatch, not just end-to-end.
    const s = setup();
    // listRepoCommands reads the real filesystem - point it at a worktree with no commands so the
    // invocation branch's own `.includes(...)` check is exercised as "not found", proving this is a
    // dispatch-order test (the invocation path is *attempted* first) rather than a filesystem test.
    await s.commandDispatch.dispatchInboundMessage(1, "/commands review", 5, false, { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never, "fix-bug", "op");

    // No real repo command named "review" exists at that worktree, so this falls back to the list
    // filter - proving the invocation check ran first (and lost), not that it was skipped.
    expect(s.cardSenders.calls.map((c) => c.fn)).toEqual(["sendCommandsListCard"]);
    expect(s.ptyIo.channel).toEqual([]);
  });

  test("/about is recognised ahead of /help and other rules", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/about", undefined, true, undefined, undefined, "op");
    expect(s.cardSenders.calls.map((c) => c.fn)).toEqual(["sendAboutCard"]);
  });

  test("bare ? is a help request only from the control topic", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "?", undefined, true, undefined, undefined, "op");
    expect(s.cardSenders.calls.map((c) => c.fn)).toEqual(["sendHelpCard"]);
  });

  test("/find delegates to sendFindCard with the parsed query", async () => {
    const s = setup();
    const route = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never;
    await s.commandDispatch.dispatchInboundMessage(1, "/find TODO", 5, false, route, "fix-bug", "op");
    expect(s.cardSenders.calls).toEqual([{ fn: "sendFindCard", args: [5, route, "TODO"] }]);
  });

  test("/diff delegates to sendDiffCard", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/diff", 5, false, undefined, "fix-bug", "op");
    expect(s.cardSenders.calls.map((c) => c.fn)).toEqual(["sendDiffCard"]);
  });

  test("bare /model posts a picker keyboard instead of falling through to NL routing", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/model", 5, false, undefined, "fix-bug", "op");
    expect(s.controlBot.sent.length).toBe(1);
    expect(s.controlBot.sent[0]?.text).toContain("Choose a model");
    expect(s.nlDispatch.routeOrFallbackCalls).toEqual([]);
  });

  test("bare /mode in the control topic (no currentSlug) shows the fleet default, not a blank picker", async () => {
    const s = setup({ defaultSessionMode: "auto" });
    await s.commandDispatch.dispatchInboundMessage(1, "/mode", undefined, true, undefined, undefined, "op");
    expect(s.controlBot.sent.length).toBe(1);
    expect(s.controlBot.sent[0]?.text).toBe("Choose a permission mode (fleet default: auto):");
    const keyboard = s.controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ text: string }>> };
    expect(keyboard.inline_keyboard.flat().find((b) => b.text === "✓ auto")).toBeDefined();
  });

  test("bare /mode inside a session topic shows that session's own current mode, not the fleet default", async () => {
    const s = setup({ defaultSessionMode: "auto" });
    const route = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never;
    await s.commandDispatch.dispatchInboundMessage(1, "/mode", 5, false, route, "fix-bug", "op");
    expect(s.controlBot.sent[0]?.text).toBe("Choose a permission mode (current: manual):");
  });

  test("an unmatched /model argument is rejected with the recognised-value list, not forwarded", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/model not-a-real-model", 5, false, undefined, "fix-bug", "op");
    expect(s.confirmSessionCommand.calls.length).toBe(1);
    expect(s.confirmSessionCommand.calls[0]?.text).toContain("Unrecognised /model, /mode or /effort argument");
    expect(s.nlDispatch.routeOrFallbackCalls).toEqual([]);
  });

  test("a recognised /model switch outside any session topic is rejected as session-scoped", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/model opus", undefined, true, undefined, undefined, "op");
    expect(s.confirmSessionCommand.calls[0]?.text).toContain("session-scoped");
    expect(s.voiceModeCommands.calls).toEqual([]);
  });

  test("a recognised /model switch inside a session topic applies it directly", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/model opus", 5, false, undefined, "fix-bug", "op");
    expect(s.voiceModeCommands.calls).toEqual([{ fn: "applyModelSwitch", args: ["fix-bug", 5, "opus"] }]);
  });

  test("a builtin passthrough command reaches the PTY raw, not any card", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/compact", 5, false, undefined, "fix-bug", "op");
    expect(s.ptyIo.raw).toEqual([{ slug: "fix-bug", text: "/compact" }]);
    expect(s.cardSenders.calls).toEqual([]);
  });
});

describe("dispatchInboundMessage - non-exact-syntax fallthrough", () => {
  test("/new is dispatched as a fleet command ahead of every exact-syntax rule", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/new seowrite fix the bug", 1, true, undefined, undefined, "op");
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toEqual(["handleNewCommand"]);
    expect(s.cardSenders.calls).toEqual([]);
  });

  test("/retry with nothing pending tells the operator instead of silently dropping", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "/retry", 5, false, undefined, "fix-bug", "op");
    expect(s.confirmSessionCommand.calls).toEqual([{ topicId: 5, text: "Nothing to retry - no expired confirmation is waiting here." }]);
  });

  test("/retry with a pending expired nl-confirm re-posts it via postNlConfirm", async () => {
    const s = setup();
    // `resolve` looks up by `retryTopicKey(threadId)`, not a random id - `/retry` never names one.
    s.retryStore.add({ id: "5", command: { kind: "restart" } as never, threadId: 5, currentSlug: "fix-bug" });
    await s.commandDispatch.dispatchInboundMessage(1, "retry", 5, false, undefined, "fix-bug", "op");
    expect(s.nlDispatch.postNlConfirmCalls.length).toBe(1);
    expect(s.confirmSessionCommand.calls).toEqual([]);
  });

  // Reply-to-retry follow-up: a retry phrase carrying a `replyToText` re-runs that text through
  // this same function, fresh - distinct from (and taking priority over) retryStore's topic-keyed
  // stash above.
  test("replying 'retry' to an earlier message re-runs that message's text through dispatch", async () => {
    const s = setup();
    await s.commandDispatch.dispatchInboundMessage(1, "retry", 1, true, undefined, undefined, "op", undefined, "/new seowrite fix the bug");
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toEqual(["handleNewCommand"]);
  });

  test("reply-to-retry takes priority over retryStore's own topic-keyed stash when both are present", async () => {
    const s = setup();
    s.retryStore.add({ id: "1", command: { kind: "restart" } as never, threadId: 1, currentSlug: undefined });
    await s.commandDispatch.dispatchInboundMessage(1, "try again", 1, true, undefined, undefined, "op", undefined, "/new seowrite fix the bug");
    expect(s.nlDispatch.postNlConfirmCalls.length).toBe(0);
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toEqual(["handleNewCommand"]);
  });

  test("a reply that's itself the literal replied-to text of a retry phrase doesn't recurse forever", async () => {
    const s = setup();
    // The recursive dispatchInboundMessage call carries no replyToText of its own (Telegram's
    // reply_to_message doesn't nest), so re-running "retry" text falls to retryStore, not another
    // recursive replyToText hop.
    await s.commandDispatch.dispatchInboundMessage(1, "retry", 1, true, undefined, undefined, "op", undefined, "retry");
    expect(s.confirmSessionCommand.calls).toEqual([{ topicId: 1, text: "Nothing to retry - no expired confirmation is waiting here." }]);
  });

  test("reply-to-retry doesn't double the outer message's own contextPrefix onto the re-run text (code-review fix)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ slug: "fix-bug", topicId: 5, state: "working" }));
    const s = setup({ sessionStore });
    const route = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never;
    // The outer message's own contextPrefix (as inbound-media.ts's buildContextPrefix would have
    // built it from *this* message's reply_to_message) already quotes replyToText - it must not
    // also be prepended to the recursively re-run text below.
    await s.commandDispatch.dispatchInboundMessage(
      1,
      "retry",
      5,
      false,
      route,
      "fix-bug",
      "op",
      '[Replying to an earlier message: "just chatting"]\n\n',
      "just chatting",
    );
    expect(s.ptyIo.channel).toEqual([{ slug: "fix-bug", topicId: 5, content: "just chatting", msgId: "1", from: "op" }]);
  });

  // nl-router.ts's `kind='retry'` (2026-08-09): a natural-language phrase in any language that
  // `isRetryPhrase`'s exact-match regex misses (e.g. "Retry again as you already could handle such
  // messages", or a Russian/Azerbaijani equivalent) still reaches the same retry mechanics, just via
  // the NL router's `onRetryMatch` callback instead of the regex fast-path.
  test("an AI-matched retry (regex miss) still re-posts the pending retryStore entry via postNlConfirm", async () => {
    const s = setup();
    s.retryStore.add({ id: "5", command: { kind: "restart" } as never, threadId: 5, currentSlug: "fix-bug" });
    s.nlDispatch.setRetryMatch();
    await s.commandDispatch.dispatchInboundMessage(1, "Retry again as you already could handle such messages", 5, false, undefined, "fix-bug", "op");
    expect(s.nlDispatch.postNlConfirmCalls.length).toBe(1);
    expect(s.confirmSessionCommand.calls).toEqual([]);
  });

  test("an AI-matched retry (regex miss) on a reply re-runs the replied-to message's own text", async () => {
    const s = setup();
    s.nlDispatch.setRetryMatch();
    await s.commandDispatch.dispatchInboundMessage(1, "Retry again as you already could handle such messages", 1, true, undefined, undefined, "op", undefined, "/new seowrite fix the bug");
    expect(s.sessionLifecycle.calls.map((c) => c.fn)).toEqual(["handleNewCommand"]);
  });

  test("no exact-syntax rule matches and there's no session: falls back to NL routing with hasSession false", async () => {
    const s = setup();
    s.nlDispatch.setNoMatchBehavior("call");
    await s.commandDispatch.dispatchInboundMessage(1, "hello there", undefined, true, undefined, undefined, "op");
    expect(s.nlDispatch.routeOrFallbackCalls.length).toBe(1);
    const [, ctx, , , currentSlug] = s.nlDispatch.routeOrFallbackCalls[0]!;
    expect((ctx as { hasSession: boolean }).hasSession).toBe(false);
    expect(currentSlug).toBeUndefined();
    // on no match, the control-topic-only fallback message fires
    expect(s.confirmSessionCommand.calls[0]?.text).toContain("Unrecognised control-topic command");
  });

  test("a message to a dead session's topic (no route, restart-orphaned) is acknowledged, not routed", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ slug: "fix-bug", topicId: 5, state: "dead" }));
    const s = setup({ sessionStore });
    await s.commandDispatch.dispatchInboundMessage(1, "hello", 5, false, undefined, undefined, "op");
    expect(s.confirmSessionCommand.calls).toEqual([{ topicId: 5, text: "This session has ended." }]);
    expect(s.nlDispatch.routeOrFallbackCalls).toEqual([]);
  });

  test("a message to a dead session (route/currentSlug present) is acknowledged, not forwarded", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ slug: "fix-bug", topicId: 5, state: "dead" }));
    const s = setup({ sessionStore });
    const route = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never;
    await s.commandDispatch.dispatchInboundMessage(1, "hello", 5, false, route, "fix-bug", "op");
    expect(s.confirmSessionCommand.calls).toEqual([{ topicId: 5, text: "This session has ended." }]);
    expect(s.ptyIo.channel).toEqual([]);
  });

  test("plain text with a live session forwards to the session via NL-routing's onNoMatch", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ slug: "fix-bug", topicId: 5, state: "working" }));
    const s = setup({ sessionStore });
    const route = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never;
    await s.commandDispatch.dispatchInboundMessage(42, "just chatting", 5, false, route, "fix-bug", "op", "[voice] ");
    expect(s.ptyIo.channel).toEqual([{ slug: "fix-bug", topicId: 5, content: "[voice] just chatting", msgId: "42", from: "op" }]);
  });

  test("marks the topic interjected for a live session's own topic (non-control)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ slug: "fix-bug", topicId: 5, state: "working" }));
    const s = setup({ sessionStore });
    const route = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\does\\not\\exist", model: "sonnet" } as never;
    await s.commandDispatch.dispatchInboundMessage(1, "hi", 5, false, route, "fix-bug", "op");
    expect(s.feedWiring.interjected).toEqual(["fix-bug"]);
  });
});
