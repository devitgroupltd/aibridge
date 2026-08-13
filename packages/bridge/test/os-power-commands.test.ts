import { describe, expect, test } from "bun:test";
import { checkAutoLogonEnabled, createOsPowerCommands } from "../src/os-power-commands.ts";
import { buildOsConfirmKeyboard, OsConfirmRegistry, resolveOsConfirmCallback, type PendingOsConfirm } from "../src/os-confirm.ts";
import { fakeControlBot } from "./helpers.ts";

function setup(overrides: { runShutdown?: (args: string[]) => Promise<{ stdout: string; stderr: string; failed: boolean }>; runPowershell?: (script: string) => Promise<{ stdout: string; stderr: string; failed: boolean }>; isControlTopic?: (threadId: number | undefined) => boolean } = {}) {
  const controlBot = fakeControlBot();
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const finalized: Array<{ messageId: number; text: string }> = [];
  const runShutdownCalls: string[][] = [];
  const runPowershellCalls: string[] = [];
  const osConfirmRegistry = new OsConfirmRegistry();
  const osPowerCommands = createOsPowerCommands({
    controlBot,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text: String(text) });
    },
    finalizeCard: async (messageId, text) => {
      finalized.push({ messageId, text });
    },
    isControlTopic: overrides.isControlTopic ?? ((threadId) => threadId === undefined),
    osConfirmRegistry,
    runShutdown:
      overrides.runShutdown ??
      (async (args) => {
        runShutdownCalls.push(args);
        return { stdout: "", stderr: "", failed: false };
      }),
    runPowershell:
      overrides.runPowershell ??
      (async (script) => {
        runPowershellCalls.push(script);
        return { stdout: "1", stderr: "", failed: false };
      }),
    supergroupChatId: "-100",
    log: () => {},
  });
  return { controlBot, confirmed, finalized, runShutdownCalls, runPowershellCalls, osConfirmRegistry, osPowerCommands };
}

describe("resolveOsConfirmCallback / buildOsConfirmKeyboard", () => {
  test("round-trips buildOsConfirmKeyboard's own output", () => {
    const keyboard = buildOsConfirmKeyboard("shutdown", "abc123");
    const yes = resolveOsConfirmCallback((keyboard[0]?.[0] as { callback_data: string }).callback_data);
    const no = resolveOsConfirmCallback((keyboard[0]?.[1] as { callback_data: string }).callback_data);
    expect(yes).toEqual({ id: "abc123", action: "shutdown", confirmed: true });
    expect(no).toEqual({ id: "abc123", action: "shutdown", confirmed: false });
  });

  test("rejects malformed callback_data", () => {
    expect(resolveOsConfirmCallback("os:poweroff:abc:y")).toBeNull();
    expect(resolveOsConfirmCallback("fc:kill:abc:y")).toBeNull();
    expect(resolveOsConfirmCallback("os:shutdown:abc:maybe")).toBeNull();
  });
});

describe("checkAutoLogonEnabled", () => {
  test("true when the registry value is \"1\"", async () => {
    expect(await checkAutoLogonEnabled(async () => ({ stdout: "1", stderr: "", failed: false }))).toBe(true);
  });

  test("false when the value is empty/absent", async () => {
    expect(await checkAutoLogonEnabled(async () => ({ stdout: "", stderr: "", failed: false }))).toBe(false);
  });

  test("false when the value is \"0\"", async () => {
    expect(await checkAutoLogonEnabled(async () => ({ stdout: "0", stderr: "", failed: false }))).toBe(false);
  });

  test("undefined when the underlying runPowershell call itself fails", async () => {
    expect(await checkAutoLogonEnabled(async () => ({ stdout: "", stderr: "boom", failed: true }))).toBeUndefined();
  });
});

describe("handleOsCommand", () => {
  test("rejects a non-control-topic", async () => {
    const { confirmed, osPowerCommands } = setup({ isControlTopic: () => false });

    await osPowerCommands.handleOsCommand({ kind: "os", action: "shutdown" }, 5);

    expect(confirmed).toEqual([{ topicId: 5, text: "/os only works from the control topic." }]);
  });

  test("action: cancel runs shutdown /a directly, no registry involvement", async () => {
    const { confirmed, runShutdownCalls, osConfirmRegistry, osPowerCommands } = setup();

    await osPowerCommands.handleOsCommand({ kind: "os", action: "cancel" }, undefined);

    expect(runShutdownCalls).toEqual([["/a"]]);
    expect(confirmed).toEqual([{ topicId: undefined, text: "✅ Cancelled the pending shutdown/restart." }]);
    expect(osConfirmRegistry.size).toBe(0);
  });

  test("action: cancel reports failure without claiming success (a failed /a can mean nothing was scheduled, or that it already ran)", async () => {
    const { confirmed, osPowerCommands } = setup({ runShutdown: async () => ({ stdout: "", stderr: "", failed: true }) });

    await osPowerCommands.handleOsCommand({ kind: "os", action: "cancel" }, undefined);

    expect(confirmed).toEqual([{ topicId: undefined, text: "Nothing to cancel (either nothing was scheduled, or it already started)." }]);
  });

  test("action: shutdown posts a Yes/No card and registers the pending confirm, with no autologon warning", async () => {
    const { controlBot, osConfirmRegistry, osPowerCommands } = setup({ isControlTopic: () => true });

    await osPowerCommands.handleOsCommand({ kind: "os", action: "shutdown" }, 1);

    expect(controlBot.sent.length).toBe(1);
    const text = controlBot.sent[0]?.text ?? "";
    expect(text).toContain("shut down THE WHOLE MACHINE");
    expect(text).not.toContain("Autologon");
    expect(osConfirmRegistry.size).toBe(1);
  });

  test("action: reboot with autologon off adds the warning to the card text", async () => {
    const { controlBot, osPowerCommands } = setup({ isControlTopic: () => true, runPowershell: async () => ({ stdout: "", stderr: "", failed: false }) });

    await osPowerCommands.handleOsCommand({ kind: "os", action: "reboot" }, 1);

    const text = controlBot.sent[0]?.text ?? "";
    expect(text).toContain("Autologon is NOT configured");
  });

  test("action: reboot with autologon on omits the warning", async () => {
    const { controlBot, osPowerCommands } = setup({ isControlTopic: () => true, runPowershell: async () => ({ stdout: "1", stderr: "", failed: false }) });

    await osPowerCommands.handleOsCommand({ kind: "os", action: "reboot" }, 1);

    const text = controlBot.sent[0]?.text ?? "";
    expect(text).not.toContain("Autologon");
  });

  test("action: reboot when the autologon check itself fails says it could not be checked", async () => {
    const { controlBot, osPowerCommands } = setup({ isControlTopic: () => true, runPowershell: async () => ({ stdout: "", stderr: "boom", failed: true }) });

    await osPowerCommands.handleOsCommand({ kind: "os", action: "reboot" }, 1);

    const text = controlBot.sent[0]?.text ?? "";
    expect(text).toContain("Autologon could not be checked");
  });
});

describe("executeOsConfirm", () => {
  function pending(overrides: Partial<PendingOsConfirm> = {}): PendingOsConfirm {
    return { id: "abc12345", action: "shutdown", topicId: 1, messageId: 42, createdAt: 0, ...overrides };
  }

  test("calls runShutdown with the exact expected args for shutdown, then finalizes the card", async () => {
    const { runShutdownCalls, finalized, osPowerCommands } = setup();

    await osPowerCommands.executeOsConfirm(pending());

    expect(runShutdownCalls).toEqual([["/s", "/t", "60", "/c", "aibridge: shutdown requested from Telegram"]]);
    expect(finalized).toEqual([{ messageId: 42, text: "✅ Shutting down in 60s. /os cancel to abort." }]);
  });

  test("calls runShutdown with /r for reboot", async () => {
    const { runShutdownCalls, osPowerCommands } = setup();

    await osPowerCommands.executeOsConfirm(pending({ action: "reboot" }));

    expect(runShutdownCalls).toEqual([["/r", "/t", "60", "/c", "aibridge: shutdown requested from Telegram"]]);
  });

  test("never claims success when the wrapped runShutdown call failed", async () => {
    const { finalized, osPowerCommands } = setup({ runShutdown: async () => ({ stdout: "", stderr: "access denied", failed: true }) });

    await osPowerCommands.executeOsConfirm(pending());

    expect(finalized.length).toBe(1);
    expect(finalized[0]?.text).toContain("Failed to schedule");
    expect(finalized[0]?.text).toContain("access denied");
    expect(finalized[0]?.text).not.toContain("✅");
  });
});
