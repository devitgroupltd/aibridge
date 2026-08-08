import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVoiceModeCommands } from "../src/voice-mode-commands.ts";
import { Routing } from "../src/routing.ts";
import { SessionStore } from "../src/session-store.ts";
import { SettingsStore } from "../src/settings-store.ts";

function fakePtyIo() {
  const sendRawCalls: Array<{ slug: string; text: string }> = [];
  const sendEffortCalls: Array<{ slug: string; effort: string }> = [];
  return {
    sendRaw: (slug: string, text: string) => {
      sendRawCalls.push({ slug, text });
    },
    sendEffortCommand: (slug: string, effort: string) => {
      sendEffortCalls.push({ slug, effort });
    },
    confirmSubmitted: () => {},
    autoRecoverWedgedSession: () => {},
    sendChannelText: () => {},
    sendRawCalls,
    sendEffortCalls,
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

function fakeVoiceServer(currentModelPath = "c:\\voice\\ggml-base.bin") {
  let path_ = currentModelPath;
  const switchModelCalls: string[] = [];
  let failNextSwitch: string | undefined;
  return {
    switchModel: async (modelPath: string) => {
      switchModelCalls.push(modelPath);
      if (failNextSwitch) {
        const msg = failNextSwitch;
        failNextSwitch = undefined;
        throw new Error(msg);
      }
      path_ = modelPath;
    },
    currentModelPath: () => path_,
    stop: () => {},
    switchModelCalls,
    failSwitchWith(msg: string) {
      failNextSwitch = msg;
    },
  };
}

async function setup(overrides: Partial<Parameters<typeof createVoiceModeCommands>[0]> = {}) {
  const ptyIo = fakePtyIo();
  const routing = new Routing();
  const sessionStore = new SessionStore(":memory:");
  const settingsStore = new SettingsStore(":memory:");
  const controlBot = fakeControlBot();
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  let assistEnabled = true;
  let voiceConfirmEnabled = true;
  let defaultSessionMode: "manual" | "auto" | "plan" | "acceptEdits" = "manual" as never;
  let defaultSessionEffort: "low" | "medium" | "high" | "xhigh" | "max" = "medium" as never;
  let nlRouterBackend: "api" | "cli" = "cli";
  const voiceModeCommands = createVoiceModeCommands({
    ptyIo,
    routing,
    sessionStore,
    settingsStore,
    controlBot,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text });
    },
    voiceServer: null,
    voiceModelPath: "c:\\voice\\ggml-base.bin",
    getAssistEnabled: () => assistEnabled,
    setAssistEnabled: (v) => {
      assistEnabled = v;
    },
    getVoiceConfirmEnabled: () => voiceConfirmEnabled,
    setVoiceConfirmEnabled: (v) => {
      voiceConfirmEnabled = v;
    },
    getDefaultSessionMode: () => defaultSessionMode,
    setDefaultSessionMode: (m) => {
      defaultSessionMode = m;
    },
    getDefaultSessionEffort: () => defaultSessionEffort,
    setDefaultSessionEffort: (e) => {
      defaultSessionEffort = e;
    },
    getNlRouterBackend: () => nlRouterBackend,
    setNlRouterBackend: (b) => {
      nlRouterBackend = b;
    },
    nlRouterApiKeyConfigured: false,
    supergroupChatId: "-100",
    log: () => {},
    ...overrides,
  });
  return {
    voiceModeCommands,
    ptyIo,
    routing,
    sessionStore,
    settingsStore,
    controlBot,
    confirmed,
    getAssistEnabled: () => assistEnabled,
    getVoiceConfirmEnabled: () => voiceConfirmEnabled,
    getDefaultSessionMode: () => defaultSessionMode,
    getDefaultSessionEffort: () => defaultSessionEffort,
    getNlRouterBackend: () => nlRouterBackend,
  };
}

describe("createVoiceModeCommands", () => {
  describe("applyModelSwitch / applyModeSwitch / applyEffortSwitch", () => {
    test("applyModelSwitch sends the raw /model keystroke, persists it, and confirms", async () => {
      const { voiceModeCommands, ptyIo, confirmed } = await setup();

      voiceModeCommands.applyModelSwitch("fix-bug", 5, "sonnet");

      expect(ptyIo.sendRawCalls).toEqual([{ slug: "fix-bug", text: "/model sonnet" }]);
      expect(confirmed[0]?.text).toBe("Switched fix-bug to sonnet");
    });

    test("applyModeSwitch writes mode keystrokes via routing and confirms", async () => {
      const { voiceModeCommands, routing, confirmed } = await setup();

      voiceModeCommands.applyModeSwitch("fix-bug", 5, "plan");

      expect(routing.getMode("fix-bug")).toBe("plan");
      expect(confirmed[0]?.text).toBe("Switched fix-bug to plan mode");
    });

    test("writeModeKeystrokes sends nothing through the pty write when already at the target mode", async () => {
      // Default tracked mode is "manual" (Routing.getMode's own fallback) - switching to "manual"
      // again should be a no-op write, not a spurious blank Enter.
      const writes: string[] = [];
      const routing = new Routing();
      routing.setPtyWrite("fix-bug", (text) => writes.push(text));
      const { voiceModeCommands } = await setup({ routing });

      voiceModeCommands.writeModeKeystrokes("fix-bug", "manual");

      expect(writes).toEqual([]);
      expect(routing.getMode("fix-bug")).toBe("manual");
    });

    test("applyEffortSwitch sends the effort command, tracks it in routing, and confirms", async () => {
      const { voiceModeCommands, ptyIo, routing, confirmed } = await setup();

      voiceModeCommands.applyEffortSwitch("fix-bug", 5, "high");

      expect(ptyIo.sendEffortCalls).toEqual([{ slug: "fix-bug", effort: "high" }]);
      expect(routing.getEffort("fix-bug")).toBe("high");
      expect(confirmed[0]?.text).toBe("Switched fix-bug to high effort");
    });
  });

  describe("handleVoiceModelCommand / applyVoiceModelSwitch", () => {
    test("reports voice input as disabled when there's no whisper server", async () => {
      const { voiceModeCommands, confirmed } = await setup({ voiceServer: null });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: undefined }, undefined);

      expect(confirmed[0]?.text).toContain("isn't enabled");
    });

    test("bare /voice with no models on disk reports there are none", async () => {
      const voiceServer = fakeVoiceServer();
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-empty-"));
      const { voiceModeCommands, confirmed } = await setup({
        voiceServer,
        voiceModelPath: path.join(emptyDir, "ggml-base.bin"),
      });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: undefined }, undefined);
      await Promise.resolve();

      expect(confirmed[0]?.text).toContain("No Whisper models found");
    });

    test("bare /voice with models on disk shows a picker keyboard via controlBot", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-models-"));
      await fs.writeFile(path.join(dir, "ggml-base.bin"), "");
      await fs.writeFile(path.join(dir, "ggml-small.bin"), "");
      const voiceServer = fakeVoiceServer(path.join(dir, "ggml-base.bin"));
      const { voiceModeCommands, controlBot } = await setup({
        voiceServer,
        voiceModelPath: path.join(dir, "ggml-base.bin"),
      });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: undefined }, undefined);
      await Promise.resolve();

      expect(controlBot.sent[0]?.text).toContain("Current model: base");
      expect(controlBot.sent[0]?.keyboard).toBeDefined();
    });

    test("/voice <name> already active reports it's already in use, without switching", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-already-"));
      await fs.writeFile(path.join(dir, "ggml-base.bin"), "");
      const voiceServer = fakeVoiceServer(path.join(dir, "ggml-base.bin"));
      const { voiceModeCommands, confirmed } = await setup({
        voiceServer,
        voiceModelPath: path.join(dir, "ggml-base.bin"),
      });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: "base" }, undefined);
      await Promise.resolve();

      expect(confirmed[0]?.text).toContain('Already using "base"');
      expect(voiceServer.switchModelCalls).toEqual([]);
    });

    test("/voice <unknown> reports the unknown model without switching", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-unknown-"));
      await fs.writeFile(path.join(dir, "ggml-base.bin"), "");
      const voiceServer = fakeVoiceServer(path.join(dir, "ggml-base.bin"));
      const { voiceModeCommands, confirmed } = await setup({
        voiceServer,
        voiceModelPath: path.join(dir, "ggml-base.bin"),
      });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: "nonexistent" }, undefined);
      await Promise.resolve();

      expect(confirmed[0]?.text).toContain('Unknown model "nonexistent"');
      expect(voiceServer.switchModelCalls).toEqual([]);
    });

    test("/voice <name> switches to a known, different model and confirms", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-switch-"));
      await fs.writeFile(path.join(dir, "ggml-base.bin"), "");
      await fs.writeFile(path.join(dir, "ggml-small.bin"), "");
      const voiceServer = fakeVoiceServer(path.join(dir, "ggml-base.bin"));
      const { voiceModeCommands, confirmed } = await setup({
        voiceServer,
        voiceModelPath: path.join(dir, "ggml-base.bin"),
      });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: "small" }, undefined);
      await Promise.resolve();

      expect(voiceServer.switchModelCalls).toEqual([path.join(dir, "ggml-small.bin")]);
      expect(confirmed[0]?.text).toContain('Switched to "small"');
    });

    test("a failed model switch reports the error", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-fail-"));
      await fs.writeFile(path.join(dir, "ggml-base.bin"), "");
      await fs.writeFile(path.join(dir, "ggml-small.bin"), "");
      const voiceServer = fakeVoiceServer(path.join(dir, "ggml-base.bin"));
      voiceServer.failSwitchWith("disk full");
      const { voiceModeCommands, confirmed } = await setup({
        voiceServer,
        voiceModelPath: path.join(dir, "ggml-base.bin"),
      });

      voiceModeCommands.handleVoiceModelCommand({ kind: "voice", model: "small" }, undefined);
      await Promise.resolve();
      await Promise.resolve();

      expect(confirmed.some((m) => m.text.includes("Failed to switch") && m.text.includes("disk full"))).toBe(true);
    });
  });

  describe("handleAssistCommand", () => {
    test("status reports the current value without changing it", async () => {
      const { voiceModeCommands, confirmed, getAssistEnabled } = await setup();

      voiceModeCommands.handleAssistCommand({ kind: "assist", action: "status" }, undefined);

      expect(confirmed[0]?.text).toContain("is on");
      expect(getAssistEnabled()).toBe(true);
    });

    test("off persists the change and confirms", async () => {
      const { voiceModeCommands, settingsStore, confirmed, getAssistEnabled } = await setup();

      voiceModeCommands.handleAssistCommand({ kind: "assist", action: "off" }, undefined);

      expect(getAssistEnabled()).toBe(false);
      expect(settingsStore.get("assist_enabled", "?")).toBe("false");
      expect(confirmed[0]?.text).toContain("now off");
    });
  });

  describe("handleVoiceConfirmCommand", () => {
    test("status reports the current value without changing it", async () => {
      const { voiceModeCommands, confirmed, getVoiceConfirmEnabled } = await setup();

      voiceModeCommands.handleVoiceConfirmCommand({ kind: "voiceconfirm", action: "status" }, undefined);

      expect(confirmed[0]?.text).toContain("is on");
      expect(getVoiceConfirmEnabled()).toBe(true);
    });

    test("off persists the change and confirms", async () => {
      const { voiceModeCommands, settingsStore, confirmed, getVoiceConfirmEnabled } = await setup();

      voiceModeCommands.handleVoiceConfirmCommand({ kind: "voiceconfirm", action: "off" }, undefined);

      expect(getVoiceConfirmEnabled()).toBe(false);
      expect(settingsStore.get("voice_confirm_enabled", "?")).toBe("false");
      expect(confirmed[0]?.text).toContain("now off");
    });
  });

  describe("/default", () => {
    test("bare status sends a card with a category keyboard via controlBot", async () => {
      const { voiceModeCommands, controlBot } = await setup();

      voiceModeCommands.handleDefaultCommand({ kind: "default", category: "status" }, undefined);
      await Promise.resolve();

      expect(controlBot.sent[0]?.text).toContain("New sessions currently start in");
      expect(controlBot.sent[0]?.keyboard).toBeDefined();
    });

    test("mode with no value shows the mode picker instead of applying anything", async () => {
      const { voiceModeCommands, controlBot, getDefaultSessionMode } = await setup();

      voiceModeCommands.handleDefaultCommand({ kind: "default", category: "mode", value: undefined }, undefined);
      await Promise.resolve();

      expect(controlBot.sent[0]?.text).toContain("Choose the default permission mode");
      expect(getDefaultSessionMode()).toBe("manual");
    });

    test("mode with a value applies it, persists it, and confirms - auto gets the extra warning", async () => {
      const { voiceModeCommands, settingsStore, confirmed, getDefaultSessionMode } = await setup();

      voiceModeCommands.handleDefaultCommand({ kind: "default", category: "mode", value: "auto" }, undefined);

      expect(getDefaultSessionMode()).toBe("auto");
      expect(settingsStore.get("default_session_mode", "?")).toBe("auto");
      expect(confirmed[0]?.text).toContain("no permission prompts at all");
    });

    test("effort with a value applies it, persists it, and confirms", async () => {
      const { voiceModeCommands, settingsStore, confirmed, getDefaultSessionEffort } = await setup();

      voiceModeCommands.handleDefaultCommand({ kind: "default", category: "effort", value: "high" }, undefined);

      expect(getDefaultSessionEffort()).toBe("high");
      expect(settingsStore.get("default_session_effort", "?")).toBe("high");
      expect(confirmed[0]?.text).toContain("start at high effort");
    });
  });

  describe("handleRouterBackendCommand", () => {
    test("status reports the current backend without changing it", async () => {
      const { voiceModeCommands, confirmed, getNlRouterBackend } = await setup();

      voiceModeCommands.handleRouterBackendCommand({ kind: "router", action: "status" }, undefined);

      expect(confirmed[0]?.text).toContain("cli");
      expect(getNlRouterBackend()).toBe("cli");
    });

    test("switching to api without a configured key is refused", async () => {
      const { voiceModeCommands, confirmed, getNlRouterBackend } = await setup({ nlRouterApiKeyConfigured: false });

      voiceModeCommands.handleRouterBackendCommand({ kind: "router", action: "api" }, undefined);

      expect(confirmed[0]?.text).toContain("No ANTHROPIC_API_KEY configured");
      expect(getNlRouterBackend()).toBe("cli");
    });

    test("switching to api with a configured key persists and confirms", async () => {
      const { voiceModeCommands, settingsStore, confirmed, getNlRouterBackend } = await setup({ nlRouterApiKeyConfigured: true });

      voiceModeCommands.handleRouterBackendCommand({ kind: "router", action: "api" }, undefined);

      expect(getNlRouterBackend()).toBe("api");
      expect(settingsStore.get("nl_router_backend", "?")).toBe("api");
      expect(confirmed[0]?.text).toContain("API backend");
    });
  });
});
