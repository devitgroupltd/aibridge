import { describe, expect, test } from "bun:test";
import { createNlDispatch } from "../src/nl-dispatch.ts";
import { NlConfirmRegistry } from "../src/nl-confirm.ts";
import { Routing } from "../src/routing.ts";

function fakeControlBot() {
  const sent: Array<{ topicId: number | undefined; text: string; keyboard?: unknown }> = [];
  const deleted: number[] = [];
  return {
    sendMessage: async (_chatId: unknown, topicId: number | undefined, text: string, replyMarkup?: unknown) => {
      sent.push({ topicId, text, keyboard: replyMarkup });
      return { message_id: sent.length };
    },
    deleteMessage: async (_chatId: unknown, messageId: number) => {
      deleted.push(messageId);
    },
    sent,
    deleted,
  };
}

function fakeTypingIndicator() {
  const started: string[] = [];
  const stopped: string[] = [];
  return { start: (k: string) => started.push(k), stop: (k: string) => stopped.push(k), started, stopped };
}

function fakeThinkingPlaceholder() {
  const started: string[] = [];
  let pendingMessageId: number | undefined;
  return {
    start: (k: string) => {
      started.push(k);
      pendingMessageId = 77;
    },
    consume: async () => {
      const id = pendingMessageId;
      pendingMessageId = undefined;
      return id;
    },
    started,
  };
}

function fakeCardSenders() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
  };
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

async function setup(overrides: Partial<Parameters<typeof createNlDispatch>[0]> = {}) {
  const controlBot = fakeControlBot();
  const routing = new Routing();
  const ptyIoCalls: Array<{ slug: string; text: string }> = [];
  const ptyIo = { sendRaw: (slug: string, text: string) => ptyIoCalls.push({ slug, text }) };
  const typingIndicator = fakeTypingIndicator();
  const thinkingPlaceholder = fakeThinkingPlaceholder();
  const cardSenders = fakeCardSenders();
  const modelSwitchCalls: unknown[] = [];
  const modeSwitchCalls: unknown[] = [];
  const effortSwitchCalls: unknown[] = [];
  const nlConfirmRegistry = new NlConfirmRegistry();
  const dispatchFleetCommandCalls: unknown[] = [];
  let assistEnabled = true;
  let nlRouterBackend: "api" | "cli" = "cli";
  const nlDispatch = createNlDispatch({
    controlBot,
    routing,
    ptyIo,
    typingIndicator,
    thinkingPlaceholder,
    cardSenders,
    applyModelSwitch: (...args) => modelSwitchCalls.push(args),
    applyModeSwitch: (...args) => modeSwitchCalls.push(args),
    applyEffortSwitch: (...args) => effortSwitchCalls.push(args),
    nlConfirmRegistry,
    dispatchFleetCommand: (...args) => dispatchFleetCommandCalls.push(args),
    nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
    getNlRouterBackend: () => nlRouterBackend,
    getAssistEnabled: () => assistEnabled,
    supergroupChatId: "-100",
    log: () => {},
    ...overrides,
  });
  return {
    nlDispatch,
    controlBot,
    routing,
    ptyIo,
    ptyIoCalls,
    typingIndicator,
    thinkingPlaceholder,
    cardSenders,
    modelSwitchCalls,
    modeSwitchCalls,
    effortSwitchCalls,
    nlConfirmRegistry,
    dispatchFleetCommandCalls,
    getAssistEnabled: () => assistEnabled,
    setAssistEnabled: (v: boolean) => {
      assistEnabled = v;
    },
  };
}

describe("createNlDispatch", () => {
  describe("describeNlCommand", () => {
    test.each([
      [{ kind: "kill", all: true }, "/kill --all"],
      [{ kind: "kill", all: false, slug: "fix-bug" }, "/kill fix-bug"],
      [{ kind: "kill", all: false }, "/kill"],
      [{ kind: "rm", bulk: { mode: "all" } }, "/rm --all"],
      [{ kind: "rm", bulk: { mode: "dead" } }, "/rm --dead"],
      [{ kind: "rm", bulk: { mode: "prefix", prefix: "old-" } }, "/rm --prefix old-"],
      [{ kind: "rm", slug: "fix-bug" }, "/rm fix-bug"],
      [{ kind: "restart" }, "/restart"],
      [{ kind: "deploy", slug: "fix-bug" }, "/deploy fix-bug"],
      [{ kind: "repos", action: "rm", name: "foo" }, "/repos rm foo"],
      [{ kind: "repos", action: "list" }, "/repos"],
      [{ kind: "budget" }, "/budget"],
    ] as Array<[never, string]>)("%j -> %s", async (command, expected) => {
      const { nlDispatch } = await setup();
      expect(nlDispatch.describeNlCommand(command)).toBe(expected);
    });
  });

  describe("executeMatchedCommand", () => {
    test("help/about/commands/skills/browse/find/diff route to the matching card sender", async () => {
      const { nlDispatch, cardSenders } = await setup();

      nlDispatch.executeMatchedCommand({ kind: "help" } as never, 1, true, undefined);
      nlDispatch.executeMatchedCommand({ kind: "about" } as never, 1, true, undefined);
      nlDispatch.executeMatchedCommand({ kind: "commands", term: "" } as never, 1, true, undefined);
      nlDispatch.executeMatchedCommand({ kind: "skills", term: "" } as never, 1, true, undefined);
      nlDispatch.executeMatchedCommand({ kind: "browse", path: "" } as never, 1, true, undefined);
      nlDispatch.executeMatchedCommand({ kind: "find", query: "x" } as never, 1, true, undefined);
      nlDispatch.executeMatchedCommand({ kind: "diff" } as never, 1, true, undefined);

      expect(cardSenders.calls.map((c) => c.fn)).toEqual([
        "sendHelpCard",
        "sendAboutCard",
        "sendCommandsListCard",
        "sendSkillsListCard",
        "sendBrowseCard",
        "sendFindCard",
        "sendDiffCard",
      ]);
    });

    test("builtin writes the raw command straight into the session's PTY", async () => {
      const { nlDispatch, ptyIoCalls } = await setup();

      nlDispatch.executeMatchedCommand({ kind: "builtin", name: "clear" } as never, 1, false, "fix-bug");

      expect(ptyIoCalls).toEqual([{ slug: "fix-bug", text: "/clear" }]);
    });

    test("builtin with no current session is silently dropped", async () => {
      const { nlDispatch, ptyIoCalls } = await setup();

      nlDispatch.executeMatchedCommand({ kind: "builtin", name: "clear" } as never, undefined, true, undefined);

      expect(ptyIoCalls).toEqual([]);
    });

    test.each([
      ["model", "modelSwitchCalls"],
      ["mode", "modeSwitchCalls"],
      ["effort", "effortSwitchCalls"],
    ] as const)("%s dispatches to the matching apply switch when a session is in scope", async (kind, callsKey) => {
      const s = await setup();
      const command = { kind, model: "sonnet", mode: "auto", effort: "high" } as never;

      s.nlDispatch.executeMatchedCommand(command, 5, false, "fix-bug");

      expect(s[callsKey].length).toBe(1);
    });

    test("model/mode/effort with no current session/thread is silently dropped", async () => {
      const { nlDispatch, modelSwitchCalls } = await setup();

      nlDispatch.executeMatchedCommand({ kind: "model", model: "sonnet" } as never, undefined, true, undefined);

      expect(modelSwitchCalls).toEqual([]);
    });

    test("anything else falls through to the injected dispatchFleetCommand", async () => {
      const { nlDispatch, dispatchFleetCommandCalls } = await setup();
      const command = { kind: "kill", all: true } as never;

      nlDispatch.executeMatchedCommand(command, 1, true, undefined);

      expect(dispatchFleetCommandCalls).toEqual([[command, 1, true, undefined]]);
    });
  });

  describe("postNlConfirm", () => {
    test("posts the run/don't-ask/cancel card and registers it", async () => {
      const { nlDispatch, controlBot, nlConfirmRegistry } = await setup();
      const command = { kind: "kill", all: true } as never;

      await nlDispatch.postNlConfirm(command, 1, "fix-bug");

      expect(controlBot.sent[0]?.text).toContain("/kill --all");
      const button = (controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard[0]?.[0];
      const id = button?.callback_data?.split(":")[1];
      expect(nlConfirmRegistry.take(id!)?.entry.command).toEqual(command);
    });

    test("a failed send is logged, not thrown", async () => {
      const warnings: string[] = [];
      const failingBot = { sendMessage: async () => Promise.reject(new Error("network down")) };
      const { nlDispatch } = await setup({ controlBot: failingBot, log: (level, msg) => warnings.push(`${level}: ${msg}`) });

      await nlDispatch.postNlConfirm({ kind: "restart" } as never, undefined, undefined);

      expect(warnings.some((w) => w.includes("failed to post NL-confirm card"))).toBe(true);
    });
  });

  describe("routeOrFallback", () => {
    test("when the NL router is disabled, calls onNoMatch without starting any indicator", async () => {
      const { nlDispatch, typingIndicator } = await setup({ nlRouterConfig: { enabled: false, apiKey: undefined, model: "m" } });
      let noMatchCalled = false;

      await nlDispatch.routeOrFallback("hello", { isControl: true, hasSession: false }, 1, true, undefined, () => {
        noMatchCalled = true;
      });

      expect(noMatchCalled).toBe(true);
      expect(typingIndicator.started).toEqual([]);
    });

    test("a no-match result calls onNoMatch exactly once and stops the typing indicator", async () => {
      const routeText = async () => ({ matched: false as const });
      const { nlDispatch, typingIndicator } = await setup({ routeText });
      let noMatchCount = 0;

      await nlDispatch.routeOrFallback("gibberish", { isControl: true, hasSession: true }, 5, true, "fix-bug", () => {
        noMatchCount += 1;
      });

      expect(noMatchCount).toBe(1);
      expect(typingIndicator.started).toEqual(["5"]);
      expect(typingIndicator.stopped).toEqual(["5"]);
    });

    test("a matched non-destructive command executes immediately without a confirm card", async () => {
      const command = { kind: "about" } as never;
      const routeText = async () => ({ matched: true as const, command, destructive: false });
      const { nlDispatch, cardSenders, controlBot } = await setup({ routeText });

      await nlDispatch.routeOrFallback("tell me about this", { isControl: true, hasSession: false }, 1, true, undefined, () => {});

      expect(cardSenders.calls.map((c) => c.fn)).toEqual(["sendAboutCard"]);
      expect(controlBot.sent).toEqual([]); // no confirm card posted
    });

    test("a matched destructive command posts a confirm card instead of executing immediately, when assist is on", async () => {
      const command = { kind: "kill", all: true } as never;
      const routeText = async () => ({ matched: true as const, command, destructive: true });
      const { nlDispatch, cardSenders, controlBot, dispatchFleetCommandCalls } = await setup({ routeText });

      await nlDispatch.routeOrFallback("kill everything", { isControl: true, hasSession: false }, 1, true, undefined, () => {});

      expect(controlBot.sent[0]?.text).toContain("/kill --all");
      expect(cardSenders.calls).toEqual([]);
      expect(dispatchFleetCommandCalls).toEqual([]);
    });

    test("a matched destructive command executes immediately when assist is off", async () => {
      const command = { kind: "restart" } as never;
      const routeText = async () => ({ matched: true as const, command, destructive: true });
      const { nlDispatch, controlBot, dispatchFleetCommandCalls, setAssistEnabled } = await setup({ routeText });
      setAssistEnabled(false);

      await nlDispatch.routeOrFallback("restart the bridge", { isControl: true, hasSession: false }, 1, true, undefined, () => {});

      expect(controlBot.sent).toEqual([]); // no confirm card
      expect(dispatchFleetCommandCalls).toEqual([[command, 1, true, undefined]]);
    });

    test("a hasSession context never uses the thinking placeholder (typing indicator only)", async () => {
      const routeText = async () => ({ matched: false as const });
      const { nlDispatch, thinkingPlaceholder, typingIndicator } = await setup({ routeText });

      await nlDispatch.routeOrFallback("hi", { isControl: false, hasSession: true }, 5, false, "fix-bug", () => {});

      expect(thinkingPlaceholder.started).toEqual([]);
      expect(typingIndicator.started).toEqual(["5"]);
    });

    test("a no-session context starts and consumes the thinking placeholder, deleting the message", async () => {
      const routeText = async () => ({ matched: false as const });
      const { nlDispatch, thinkingPlaceholder, controlBot } = await setup({ routeText });

      await nlDispatch.routeOrFallback("hi", { isControl: true, hasSession: false }, 5, true, undefined, () => {});

      expect(thinkingPlaceholder.started).toEqual(["5"]);
      expect(controlBot.deleted).toEqual([77]);
    });
  });
});
