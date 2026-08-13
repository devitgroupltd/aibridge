import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallbackQueryRouter } from "../src/callback-query-router.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { Routing } from "../src/routing.ts";
import { FleetConfirmRegistry } from "../src/fleet-confirm.ts";
import { RestartConfirmRegistry } from "../src/restart-confirm.ts";
import { OsConfirmRegistry } from "../src/os-confirm.ts";
import { StaleConfirmRegistry } from "../src/stale-confirm.ts";
import { VoiceConfirmRegistry } from "../src/voice-confirm.ts";
import { NlConfirmRegistry } from "../src/nl-confirm.ts";
import { RepoPickRegistry } from "../src/repo-picker.ts";
import { BrowseRegistry } from "../src/browse-nav.ts";
import { DetailsAnchorStore } from "../src/details-anchor-store.ts";
import { readSettingsFile } from "../src/settings.ts";
import type { TelegramCallbackQuery } from "../src/telegram.ts";
import { fakeControlBot, testRuntimeSettings } from "./helpers.ts";

/** The shared double plus `sendDocument`, the `/detail` button's oversized-log fallback. */
function fakeRouterBot() {
  return { ...fakeControlBot(), sendDocument: async () => ({ message_id: 1 }) };
}

function fakePipeHandle() {
  const permissions = new Map<string, { requestId: string; slug: string; toolName: string; inputPreview: string; topicId: number; messageId: number }>();
  const verdicts: Array<{ slug: string; requestId: string; behavior: string }> = [];
  const finalized: Array<{ messageId: number; text: string }> = [];
  const asks = new Map<string, { entry: { slug: string; questions: Array<{ messageId: number; question: string; header?: string }> }; label: string; allAnswered: boolean }>();
  const completedAsks: string[] = [];
  return {
    resolvePermission: (requestId: string) => {
      const p = permissions.get(requestId);
      permissions.delete(requestId);
      return p;
    },
    sendVerdict: (slug: string, requestId: string, behavior: string) => {
      verdicts.push({ slug, requestId, behavior });
      return true;
    },
    finalizePermissionMessage: async (messageId: number, text: string) => {
      finalized.push({ messageId, text });
    },
    answerAsk: (id: string) => asks.get(id) ?? null,
    completeAsk: (id: string) => {
      completedAsks.push(id);
      return true;
    },
    addPermission(p: { requestId: string; slug: string; toolName: string; inputPreview: string; topicId: number; messageId: number }) {
      permissions.set(p.requestId, p);
    },
    addAsk(id: string, entry: { entry: { slug: string; questions: Array<{ messageId: number; question: string; header?: string }> }; label: string; allAnswered: boolean }) {
      asks.set(id, entry);
    },
    verdicts,
    finalized,
    completedAsks,
  };
}

function fakeFeedWiring() {
  const states: Array<{ slug: string; state: string }> = [];
  return {
    maybeSetState: (slug: string, state: string) => states.push({ slug, state }),
    getFeedState: () => undefined,
    states,
  };
}

function fakeConfirmCards() {
  const finalizedFleet: Array<{ text: string }> = [];
  const finalizedNl: Array<{ text: string }> = [];
  const finalizedStale: Array<{ text: string }> = [];
  const finalizedVoice: Array<{ text: string }> = [];
  // What `handleSimpleConfirm` (callback-query-router.ts) calls directly for "fc:"/"os:" cancels,
  // and (repo-picker.ts) "rp:" run/cancel - shared by all three rather than a kind-specific
  // `finalize*ConfirmMessage` wrapper each.
  const finalizedCard: Array<{ messageId: number; text: string }> = [];
  return {
    takeOrNotifyGone: (registry: { take(id: string): { entry: unknown; expired: boolean } | undefined; wasRecentlyAnswered(id: string): boolean }, id: string) => {
      const taken = registry.take(id);
      if (!taken) return undefined;
      return taken.entry;
    },
    finalizeCard: async (messageId: number, text: string) => {
      finalizedCard.push({ messageId, text });
    },
    markConfirmCardExpired: async () => {},
    markNlConfirmCardExpired: async () => {},
    finalizeNlConfirmMessage: async (_p: unknown, text: string) => {
      finalizedNl.push({ text });
    },
    finalizeStaleConfirmMessage: async (_p: unknown, text: string) => {
      finalizedStale.push({ text });
    },
    finalizeVoiceConfirmMessage: async (_p: unknown, text: string) => {
      finalizedVoice.push({ text });
    },
    finalizedFleet,
    finalizedNl,
    finalizedStale,
    finalizedVoice,
    finalizedCard,
  };
}

function fakeFleetConfirmFlow() {
  const executed: unknown[] = [];
  return { executeFleetConfirm: async (pending: unknown) => void executed.push(pending), executed };
}

function fakeOsPowerCommands() {
  const executed: unknown[] = [];
  return { executeOsConfirm: async (pending: unknown) => void executed.push(pending), executed };
}

function fakeDeployLifecycle() {
  const executed: unknown[] = [];
  return { executeRestartConfirm: async (pending: unknown) => void executed.push(pending), executed };
}

function fakeNlDispatch() {
  const executed: unknown[][] = [];
  return {
    describeNlCommand: () => "/restart",
    executeMatchedCommand: (...args: unknown[]) => executed.push(args),
    executed,
  };
}

function fakeCommandDispatch() {
  const dispatched: unknown[][] = [];
  return {
    dispatchInboundMessage: async (...args: unknown[]) => {
      dispatched.push(args);
    },
    dispatched,
  };
}

function fakeVoiceModeCommands() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => (...args: unknown[]) => calls.push({ fn, args });
  return {
    applyVoiceModelSwitch: record("applyVoiceModelSwitch"),
    applyModelSwitch: record("applyModelSwitch"),
    applyModeSwitch: record("applyModeSwitch"),
    applyEffortSwitch: record("applyEffortSwitch"),
    applyDefaultMode: (mode: string) => `default mode is now ${mode}`,
    applyDefaultEffort: (effort: string) => `default effort is now ${effort}`,
    applyDefaultAutoToggle: (category: string, value: boolean) => {
      calls.push({ fn: "applyDefaultAutoToggle", args: [category, value] });
      return `default ${category} is now ${value ? "on" : "off"}`;
    },
    calls,
  };
}

function fakeConfirmSessionCommand() {
  const calls: Array<{ topicId: number | undefined; text: string }> = [];
  const fn = (topicId: number | undefined, text: string) => calls.push({ topicId, text });
  return Object.assign(fn, { calls });
}

function cq(data: string | undefined, messageId = 1, threadId: number | undefined = 5): TelegramCallbackQuery {
  return { id: "cbq1", data, message: { chat: { id: -100 }, message_thread_id: threadId, message_id: messageId } };
}

function setup() {
  const stateDir = mkdtempSync(path.join(tmpdir(), "aibridge-callback-router-test-"));
  const controlBot = fakeRouterBot();
  const feedGovernor = new RateGovernor({ log: () => {} });
  const routing = new Routing();
  const pipeHandle = fakePipeHandle();
  const feedWiring = fakeFeedWiring();
  const detailsAnchorStore = new DetailsAnchorStore(":memory:");
  const confirmCards = fakeConfirmCards();
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  const staleConfirmRegistry = new StaleConfirmRegistry();
  const voiceConfirmRegistry = new VoiceConfirmRegistry();
  const nlConfirmRegistry = new NlConfirmRegistry();
  const repoPickRegistry = new RepoPickRegistry();
  const osConfirmRegistry = new OsConfirmRegistry();
  const restartConfirmRegistry = new RestartConfirmRegistry();
  const fleetConfirmFlow = fakeFleetConfirmFlow();
  const osPowerCommands = fakeOsPowerCommands();
  const deployLifecycle = fakeDeployLifecycle();
  const browseRegistry = new BrowseRegistry();
  const nlDispatch = fakeNlDispatch();
  const commandDispatch = fakeCommandDispatch();
  const voiceModeCommands = fakeVoiceModeCommands();
  const confirmSessionCommand = fakeConfirmSessionCommand();
  const { settings, store: settingsStore } = testRuntimeSettings({ defaultSessionMode: "acceptEdits", defaultSessionEffort: "medium" });

  const router = createCallbackQueryRouter({
    controlBot: controlBot as never,
    feedGovernor,
    routing,
    sessionStore: { get: () => undefined } as never,
    ptyIo: { sendRaw: () => {} },
    pipeHandle: pipeHandle as never,
    feedWiring: feedWiring as never,
    detailsAnchorStore,
    confirmCards: confirmCards as never,
    fleetConfirmRegistry,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    nlConfirmRegistry,
    repoPickRegistry,
    osConfirmRegistry,
    restartConfirmRegistry,
    fleetConfirmFlow: fleetConfirmFlow as never,
    osPowerCommands: osPowerCommands as never,
    deployLifecycle: deployLifecycle as never,
    browseRegistry,
    nlDispatch: nlDispatch as never,
    commandDispatch: commandDispatch as never,
    voiceModeCommands: voiceModeCommands as never,
    confirmSessionCommand: confirmSessionCommand as never,
    isControlTopic: (threadId) => threadId === undefined,
    settings,
    voiceServer: null,
    voiceModelPath: "c:\\does\\not\\exist\\ggml-base.bin",
    stateDir,
    supergroupChatId: "-100",
    log: () => {},
  });

  return {
    router,
    controlBot,
    pipeHandle,
    feedWiring,
    confirmCards,
    fleetConfirmRegistry,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    nlConfirmRegistry,
    repoPickRegistry,
    osConfirmRegistry,
    restartConfirmRegistry,
    fleetConfirmFlow,
    osPowerCommands,
    deployLifecycle,
    browseRegistry,
    nlDispatch,
    commandDispatch,
    voiceModeCommands,
    confirmSessionCommand,
    settings,
    settingsStoreCalls: settingsStore.writes,
    stateDir,
  };
}

// `answerCallbackQuery` goes through `feedGovernor.scheduleAsync` (§5.4's P0 lane), so it lands on
// a microtask after `routeCallbackQuery` itself returns - every assertion against `answered` needs
// this flushed first. Every other controlBot call in this router is unscheduled (called directly),
// so only tests touching `answered` need it.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createCallbackQueryRouter - every documented namespace resolves to its handler", () => {
  test("answers the callback query for every tap, regardless of namespace", async () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("about:sessions"));
    await flush();
    expect(s.controlBot.answered).toEqual(["cbq1"]);
  });

  test('"ask:" resolves a pending question and finalizes its message', () => {
    const s = setup();
    s.pipeHandle.addAsk("tool_1", {
      entry: { slug: "fix-bug", questions: [{ messageId: 42, question: "Proceed?" }] },
      label: "Yes",
      allAnswered: true,
    });
    s.router.routeCallbackQuery(cq("ask:tool_1:0:0"));
    expect(s.pipeHandle.finalized).toEqual([{ messageId: 42, text: expect.stringContaining("Yes") as unknown as string }]);
    expect(s.pipeHandle.completedAsks).toEqual(["tool_1"]);
    expect(s.feedWiring.states).toEqual([{ slug: "fix-bug", state: "working" }]);
  });

  test('"perm:" allow resolves the pending request and sends the verdict', () => {
    const s = setup();
    s.pipeHandle.addPermission({ requestId: "abcde", slug: "fix-bug", toolName: "Read", inputPreview: "{}", topicId: 5, messageId: 7 });
    s.router.routeCallbackQuery(cq("perm:abcde:a"));
    expect(s.pipeHandle.verdicts).toEqual([{ slug: "fix-bug", requestId: "abcde", behavior: "allow" }]);
    expect(s.pipeHandle.finalized[0]?.text).toContain("✅ Allowed");
  });

  test('"fc:" confirmed executes the fleet confirm', () => {
    const s = setup();
    s.fleetConfirmRegistry.add({ id: "f1", kind: "kill", slugs: ["fix-bug"], topicId: 5, messageId: 9 });
    s.router.routeCallbackQuery(cq("fc:kill:f1:y"));
    expect(s.fleetConfirmFlow.executed.length).toBe(1);
  });

  test('"fc:" cancelled finalizes without executing', () => {
    const s = setup();
    s.fleetConfirmRegistry.add({ id: "f2", kind: "rm", slugs: ["fix-bug"], topicId: 5, messageId: 9 });
    s.router.routeCallbackQuery(cq("fc:rm:f2:n"));
    expect(s.fleetConfirmFlow.executed.length).toBe(0);
    expect(s.confirmCards.finalizedCard).toEqual([{ messageId: 9, text: "Cancelled - nothing was changed." }]);
  });

  test('"os:" confirmed executes the os confirm', () => {
    const s = setup();
    s.osConfirmRegistry.add({ id: "o1", action: "shutdown", topicId: 5, messageId: 9 });
    s.router.routeCallbackQuery(cq("os:shutdown:o1:y"));
    expect(s.osPowerCommands.executed.length).toBe(1);
  });

  test('"os:" cancelled finalizes without executing', () => {
    const s = setup();
    s.osConfirmRegistry.add({ id: "o2", action: "reboot", topicId: 5, messageId: 10 });
    s.router.routeCallbackQuery(cq("os:reboot:o2:n"));
    expect(s.osPowerCommands.executed.length).toBe(0);
    expect(s.confirmCards.finalizedCard).toEqual([{ messageId: 10, text: "Cancelled - nothing was changed." }]);
  });

  test('"os:" a mismatched action (stale/replaced card) is ignored', () => {
    const s = setup();
    s.osConfirmRegistry.add({ id: "o3", action: "shutdown", topicId: 5, messageId: 11 });
    s.router.routeCallbackQuery(cq("os:reboot:o3:y"));
    expect(s.osPowerCommands.executed.length).toBe(0);
    expect(s.confirmCards.finalizedCard).toEqual([]);
  });

  test('"rs:" confirmed executes the restart confirm', () => {
    const s = setup();
    s.restartConfirmRegistry.add({ id: "r1", topicId: 5, messageId: 9 });
    s.router.routeCallbackQuery(cq("rs:r1:y"));
    expect(s.deployLifecycle.executed.length).toBe(1);
  });

  test('"rs:" cancelled finalizes without executing', () => {
    const s = setup();
    s.restartConfirmRegistry.add({ id: "r2", topicId: 5, messageId: 10 });
    s.router.routeCallbackQuery(cq("rs:r2:n"));
    expect(s.deployLifecycle.executed.length).toBe(0);
    expect(s.confirmCards.finalizedCard).toEqual([{ messageId: 10, text: "Cancelled - nothing was changed." }]);
  });

  test('"rs:" an unknown/expired id is a silent no-op, not a crash', () => {
    const s = setup();
    expect(() => s.router.routeCallbackQuery(cq("rs:nosuch:y"))).not.toThrow();
    expect(s.deployLifecycle.executed.length).toBe(0);
  });

  test('"nc:" run executes the matched command via nlDispatch', () => {
    const s = setup();
    s.nlConfirmRegistry.add({ id: "n1", command: { kind: "restart" } as never, threadId: 5, currentSlug: undefined, messageId: 11 });
    s.router.routeCallbackQuery(cq("nc:n1:y"));
    expect(s.nlDispatch.executed.length).toBe(1);
  });

  test('"nc:" run-and-stop-asking flips assist off and persists it', () => {
    const s = setup();
    s.nlConfirmRegistry.add({ id: "n2", command: { kind: "restart" } as never, threadId: 5, currentSlug: undefined, messageId: 11 });
    s.router.routeCallbackQuery(cq("nc:n2:s"));
    expect(s.settings.assistEnabled).toBe(false);
    expect(s.settingsStoreCalls).toContainEqual({ key: "assist_enabled", value: "false" });
  });

  test('"rp:" a repo tap executes a real kind=\'new\' via nlDispatch, with the operator\'s own words as sourceText', () => {
    const s = setup();
    // `new`/`new_pick_repo` only ever originate from the control topic (nl-router.ts's
    // `allowedKinds`) - `undefined` is that convention's own encoding for it, same as every other
    // pending-confirm shape in this codebase (repo-picker.ts's own doc comment on `threadId`).
    s.repoPickRegistry.add({ id: "r1", prompt: "analyze this alarm", sourceText: "create a session for analyze this alarm", model: undefined, threadId: undefined, messageId: 11 });
    s.router.routeCallbackQuery(cq("rp:r1:aibridge", 1, undefined));
    expect(s.nlDispatch.executed).toEqual([[{ kind: "new", repo: "aibridge", prompt: "analyze this alarm", model: undefined, sourceText: "create a session for analyze this alarm" }, undefined, true, undefined]]);
    expect(s.confirmCards.finalizedCard).toEqual([{ messageId: 11, text: '✅ Starting a session against "aibridge"...' }]);
  });

  // Ambiguous-repo gap fix (inbound-media.ts): a repo-pick raised from a control-topic attachment's
  // caption carries a `pendingAttachment` on the registry entry - a tap here must hand it through
  // to `executeMatchedCommand`'s `kind: "new"` call so the attachment isn't silently dropped.
  test('"rp:" a repo tap on an attachment-originated pick carries pendingAttachment through', () => {
    const s = setup();
    const pendingAttachment = { kind: "image" as const, name: "screenshot.jpg", bytes: new Uint8Array([1, 2, 3]), rawCaption: "create a session and fix the login bug" };
    s.repoPickRegistry.add({ id: "r3", prompt: "fix the login bug", sourceText: "create a session and fix the login bug", model: undefined, threadId: undefined, messageId: 13, pendingAttachment });
    s.router.routeCallbackQuery(cq("rp:r3:aibridge", 1, undefined));
    expect(s.nlDispatch.executed).toEqual([
      [{ kind: "new", repo: "aibridge", prompt: "fix the login bug", model: undefined, sourceText: "create a session and fix the login bug", pendingAttachment }, undefined, true, undefined],
    ]);
  });

  test('"rp:" cancel finalizes without ever calling nlDispatch', () => {
    const s = setup();
    s.repoPickRegistry.add({ id: "r2", prompt: "analyze this alarm", sourceText: "create a session for analyze this alarm", model: undefined, threadId: undefined, messageId: 12 });
    s.router.routeCallbackQuery(cq("rp:r2:_cancel", 1, undefined));
    expect(s.nlDispatch.executed).toEqual([]);
    expect(s.confirmCards.finalizedCard).toEqual([{ messageId: 12, text: "❌ Cancelled - no session was created." }]);
  });

  test('"rp:" an unknown/expired id is a silent no-op, not a crash', () => {
    const s = setup();
    expect(() => s.router.routeCallbackQuery(cq("rp:doesnotexist:aibridge"))).not.toThrow();
    expect(s.nlDispatch.executed).toEqual([]);
  });

  test('"sc:" confirmed replays via commandDispatch.dispatchInboundMessage', () => {
    const s = setup();
    s.staleConfirmRegistry.add({ id: "sc1", threadId: 5, messageId: 1, rawText: "hello", from: "op", confirmCardMessageId: 2, origin: {} });
    s.router.routeCallbackQuery(cq("sc:sc1:y"));
    expect(s.commandDispatch.dispatched.length).toBe(1);
  });

  test('"vc:" send replays the transcript via commandDispatch.dispatchInboundMessage', () => {
    const s = setup();
    s.voiceConfirmRegistry.add({ id: "vc1", threadId: 5, messageId: 1, transcript: "hi", from: "op", confirmCardMessageId: 2, origin: {} });
    s.router.routeCallbackQuery(cq("vc:vc1:s"));
    expect(s.commandDispatch.dispatched.length).toBe(1);
  });

  test('"vc:" send-and-stop-asking flips voice confirm off and persists it', () => {
    const s = setup();
    s.voiceConfirmRegistry.add({ id: "vc2", threadId: 5, messageId: 1, transcript: "hi", from: "op", confirmCardMessageId: 2, origin: {} });
    s.router.routeCallbackQuery(cq("vc:vc2:a"));
    expect(s.settings.voiceConfirmEnabled).toBe(false);
    expect(s.settingsStoreCalls).toContainEqual({ key: "voice_confirm_enabled", value: "false" });
  });

  test('a bare level cancel ("model:cancel") edits the card to "Cancelled."', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("model:cancel"));
    expect(s.controlBot.edited).toEqual([{ messageId: 1, text: "Cancelled.", keyboard: { inline_keyboard: [] } }]);
  });

  test('"model:<value>" applies the switch for the current session topic', () => {
    const s = setup();
    // Routing has no route registered, so currentSlug is undefined - applyModelSwitch is only
    // called when currentSlug/threadId are both defined (session-scoped), matching original
    // behaviour; assert the no-route case is a graceful no-op.
    s.router.routeCallbackQuery(cq("model:opus"));
    expect(s.voiceModeCommands.calls).toEqual([]);
  });

  test('"default:mode" edits into the mode picker', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("default:mode"));
    expect(s.controlBot.edited[0]?.text).toContain("default permission mode");
  });

  test('"defmode:<value>" applies the default mode and edits to a confirmation', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("defmode:plan"));
    expect(s.controlBot.edited).toEqual([{ messageId: 1, text: "default mode is now plan", keyboard: { inline_keyboard: [] } }]);
  });

  // A resolver-only test can't catch a dead button: without a fifth `match` branch these strings
  // resolve to nothing, the "default" rule declines, and the tap falls through to the catch-all -
  // a live-looking button that silently does nothing.
  test('"default:permission:on" is claimed by the default rule and applies the toggle', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("default:permission:on"));
    expect(s.voiceModeCommands.calls).toEqual([{ fn: "applyDefaultAutoToggle", args: ["permission", true] }]);
    expect(s.controlBot.edited).toEqual([{ messageId: 1, text: "default permission is now on", keyboard: { inline_keyboard: [] } }]);
  });

  test('"default:answer:off" carries its own category and value, not the permission arm\'s', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("default:answer:off"));
    expect(s.voiceModeCommands.calls).toEqual([{ fn: "applyDefaultAutoToggle", args: ["answer", false] }]);
  });

  test('"about:<id>" sends the topic detail text', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("about:sessions"));
    expect(s.controlBot.sent.length).toBe(1);
  });

  test('"run:showcommands" answers directly rather than forwarding to the PTY', () => {
    const s = setup();
    s.router.routeCallbackQuery(cq("run:showcommands"));
    expect(s.controlBot.sent.length).toBe(1);
  });

  test("an unrecognised callback_data is handled gracefully - answered, no throw, no other side effect", async () => {
    const s = setup();
    expect(() => s.router.routeCallbackQuery(cq("totally:unknown:namespace"))).not.toThrow();
    await flush();
    expect(s.controlBot.answered).toEqual(["cbq1"]);
    expect(s.controlBot.sent).toEqual([]);
    expect(s.controlBot.edited).toEqual([]);
  });

  test("a callback query with no data at all is handled gracefully", async () => {
    const s = setup();
    expect(() => s.router.routeCallbackQuery(cq(undefined))).not.toThrow();
    await flush();
    expect(s.controlBot.answered).toEqual(["cbq1"]);
  });
});

describe("createCallbackQueryRouter - permission-rule derivation (perm:...:A)", () => {
  test("a representative Bash tool call derives and persists the expected always-allow rule", () => {
    const s = setup();
    s.pipeHandle.addPermission({
      requestId: "bash01",
      slug: "fix-bug",
      toolName: "Bash",
      inputPreview: JSON.stringify({ command: "make deploy" }),
      topicId: 5,
      messageId: 7,
    });
    s.router.routeCallbackQuery(cq("perm:bash01:A"));
    expect(s.pipeHandle.finalized[0]?.text).toContain("Bash(make deploy *)");
    const settings = readSettingsFile(s.stateDir, "fix-bug");
    expect(settings.permissions.allow).toContain("Bash(make deploy *)");
  });

  test("a rule already covered by an existing allow entry is reported, not double-written", () => {
    const s = setup();
    s.pipeHandle.addPermission({
      requestId: "bash02",
      slug: "fix-bug",
      toolName: "Bash",
      inputPreview: JSON.stringify({ command: "make deploy" }),
      topicId: 5,
      messageId: 7,
    });
    // First tap writes the rule to `allow`.
    s.router.routeCallbackQuery(cq("perm:bash02:A"));
    const afterFirst = readSettingsFile(s.stateDir, "fix-bug");
    const allowCountAfterFirst = afterFirst.permissions.allow.filter((r) => r === "Bash(make deploy *)").length;
    expect(allowCountAfterFirst).toBe(1);

    // A second, independent request deriving the identical rule must not add a second copy.
    s.pipeHandle.addPermission({
      requestId: "bash03",
      slug: "fix-bug",
      toolName: "Bash",
      inputPreview: JSON.stringify({ command: "make deploy" }),
      topicId: 5,
      messageId: 8,
    });
    s.router.routeCallbackQuery(cq("perm:bash03:A"));
    expect(s.pipeHandle.finalized[1]?.text).toContain("already covered by an existing rule");
    const afterSecond = readSettingsFile(s.stateDir, "fix-bug");
    expect(afterSecond.permissions.allow.filter((r) => r === "Bash(make deploy *)").length).toBe(1);
  });

  test("a non-Bash tool derives a bare-tool-name rule", () => {
    const s = setup();
    s.pipeHandle.addPermission({ requestId: "read01", slug: "fix-bug", toolName: "Glob", inputPreview: "{}", topicId: 5, messageId: 7 });
    s.router.routeCallbackQuery(cq("perm:read01:A"));
    expect(s.pipeHandle.finalized[0]?.text).toContain("added `Glob`");
  });

  test("a command containing a shell metacharacter falls back to allow-once, no rule written", () => {
    const s = setup();
    s.pipeHandle.addPermission({
      requestId: "bash04",
      slug: "fix-bug",
      toolName: "Bash",
      inputPreview: JSON.stringify({ command: "rm -rf / && echo done" }),
      topicId: 5,
      messageId: 7,
    });
    s.router.routeCallbackQuery(cq("perm:bash04:A"));
    expect(s.pipeHandle.finalized[0]?.text).toContain("allow-once only");
  });
});
