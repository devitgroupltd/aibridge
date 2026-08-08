import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeployLifecycleCommands, createProcessRunner } from "../src/deploy-lifecycle-commands.ts";
import { readDeployMarker } from "../src/deploy.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import type { DeployOutcome } from "../src/deploy.ts";

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
  const sent: Array<{ topicId: number | undefined; text: string }> = [];
  return {
    sendMessage: async (_chatId: unknown, topicId: number | undefined, text: string) => {
      sent.push({ topicId, text });
      return { message_id: sent.length };
    },
    sent,
  };
}

async function setup(overrides: Partial<Parameters<typeof createDeployLifecycleCommands>[0]> = {}) {
  const controlBot = fakeControlBot();
  const sessionStore = new SessionStore(":memory:");
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const respawnCalls: number[] = [];
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-deploy-lifecycle-test-"));
  const runSchtasksCalls: string[][] = [];
  const runPowershellCalls: string[] = [];
  const deployLifecycle = createDeployLifecycleCommands({
    sessionStore,
    controlBot,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text });
    },
    isControlTopic: (threadId) => threadId === undefined || threadId === 1,
    runSchtasks: async (args) => {
      runSchtasksCalls.push(args);
      return { stdout: "", stderr: "", failed: false };
    },
    runPowershell: async (script) => {
      runPowershellCalls.push(script);
      return { stderr: "", failed: false };
    },
    respawnSelfAndExit: async () => {
      respawnCalls.push(1);
      return undefined as never;
    },
    stateDir,
    supergroupChatId: "-100",
    entryScriptDir: "c:\\bridge-repo\\packages\\bridge\\src",
    log: () => {},
    ...overrides,
  });
  return { deployLifecycle, controlBot, sessionStore, confirmed, respawnCalls, stateDir, runSchtasksCalls, runPowershellCalls };
}

describe("createDeployLifecycleCommands", () => {
  describe("handleRestartCommand", () => {
    test("outside the control topic, refuses and never respawns", async () => {
      const { deployLifecycle, confirmed, respawnCalls } = await setup();

      await deployLifecycle.handleRestartCommand(5);

      expect(confirmed[0]?.text).toContain("only works from the control topic");
      expect(respawnCalls).toEqual([]);
    });

    test("in the control topic, acknowledges then respawns", async () => {
      const { deployLifecycle, controlBot, respawnCalls } = await setup();

      await deployLifecycle.handleRestartCommand(undefined);

      expect(controlBot.sent[0]?.text).toContain("Restarting the Bridge now");
      expect(respawnCalls).toEqual([1]);
    });
  });

  describe("handleDeployCommand", () => {
    test("outside the control topic, refuses without touching the session store", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleDeployCommand(5, "fix-bug");

      expect(confirmed[0]?.text).toContain("only works from the control topic");
    });

    test("an unknown slug reports it's missing", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleDeployCommand(undefined, "no-such-session");

      expect(confirmed[0]?.text).toContain('No session "no-such-session"');
    });

    test("a failing gate reports the failure and never restarts", async () => {
      const failingOutcome: DeployOutcome = { ok: false, rolledBack: true, message: "typecheck failed" };
      const { deployLifecycle, sessionStore, controlBot, respawnCalls, stateDir } = await setup({
        deployBranch: async () => failingOutcome,
      });
      sessionStore.insert(row());

      await deployLifecycle.handleDeployCommand(undefined, "fix-bug");

      expect(controlBot.sent.some((m) => m.text.includes("typecheck failed"))).toBe(true);
      expect(respawnCalls).toEqual([]);
      expect(readDeployMarker(stateDir)).toBeNull();
    });

    test("a successful gate against a non-self repo merges but never restarts or writes a marker", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const { deployLifecycle, sessionStore, controlBot, respawnCalls, stateDir } = await setup({
        deployBranch: async () => okOutcome,
        // Doesn't resolve to the same root as `entryScriptDir`'s bridge repo, so isSelfRepo is false.
      });
      sessionStore.insert(row({ repoPath: "c:\\some-other-project\\repo" }));

      await deployLifecycle.handleDeployCommand(undefined, "fix-bug");

      expect(controlBot.sent.some((m) => m.text.includes("merged cleanly"))).toBe(true);
      expect(controlBot.sent.some((m) => m.text.includes("restarting now"))).toBe(false);
      expect(respawnCalls).toEqual([]);
      expect(readDeployMarker(stateDir)).toBeNull();
    });

    test("a successful gate against aibridge's own repo writes the deploy marker and respawns", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      // resolveBridgeRepoRoot("c:\\bridge-repo\\packages\\bridge\\src") -> "c:\\bridge-repo"
      const { deployLifecycle, sessionStore, controlBot, respawnCalls, stateDir } = await setup({
        deployBranch: async () => okOutcome,
      });
      sessionStore.insert(row({ repoPath: "c:\\bridge-repo" }));

      await deployLifecycle.handleDeployCommand(undefined, "fix-bug");

      expect(controlBot.sent.some((m) => m.text.includes("restarting now"))).toBe(true);
      expect(respawnCalls).toEqual([1]);
      const marker = readDeployMarker(stateDir);
      expect(marker?.branch).toBe("claude/fix-bug-1");
      expect(marker?.previousHeadSha).toBe("aaa");
      expect(marker?.newHeadSha).toBe("bbb");
    });
  });

  describe("handleAutostartCommand", () => {
    test("outside the control topic, refuses", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleAutostartCommand({ kind: "autostart", action: "status" }, 5);

      expect(confirmed[0]?.text).toContain("only works from the control topic");
    });

    test("status queries schtasks and reports it", async () => {
      const { deployLifecycle, controlBot, runSchtasksCalls } = await setup();

      await deployLifecycle.handleAutostartCommand({ kind: "autostart", action: "status" }, undefined);

      expect(runSchtasksCalls.length).toBe(1);
      expect(controlBot.sent.length).toBe(1);
    });

    test("install registers the task then fixes its settings via powershell", async () => {
      const { deployLifecycle, confirmed, runSchtasksCalls, runPowershellCalls } = await setup();

      await deployLifecycle.handleAutostartCommand({ kind: "autostart", action: "install" }, undefined);

      expect(runSchtasksCalls.length).toBe(1);
      expect(runPowershellCalls.length).toBe(1);
      expect(confirmed[0]?.text).toContain("Registered");
    });

    test("install reports (but doesn't undo) a failed settings fix-up", async () => {
      const { deployLifecycle, confirmed } = await setup({
        runPowershell: async () => ({ stderr: "access denied", failed: true }),
      });

      await deployLifecycle.handleAutostartCommand({ kind: "autostart", action: "install" }, undefined);

      expect(confirmed[0]?.text).toContain("fixing its execution-time-limit");
      expect(confirmed[0]?.text).toContain("access denied");
    });

    test("a failed schtasks /Create is reported as a failure", async () => {
      const { deployLifecycle, confirmed } = await setup({
        runSchtasks: async () => ({ stdout: "", stderr: "boom", failed: true }),
      });

      await deployLifecycle.handleAutostartCommand({ kind: "autostart", action: "install" }, undefined);

      expect(confirmed[0]?.text).toContain("/autostart install failed");
      expect(confirmed[0]?.text).toContain("boom");
    });

    test("uninstall deletes the task", async () => {
      const { deployLifecycle, confirmed, runSchtasksCalls } = await setup();

      await deployLifecycle.handleAutostartCommand({ kind: "autostart", action: "uninstall" }, undefined);

      expect(runSchtasksCalls.length).toBe(1);
      expect(confirmed[0]?.text).toContain("Removed");
    });
  });
});

describe("createProcessRunner", () => {
  test("runSchtasks resolves with failed:false on a clean exit and passes through stdout/stderr", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(null, "out", "err"));

    const result = await runner.runSchtasks(["/Query"]);

    expect(result).toEqual({ stdout: "out", stderr: "err", failed: false });
  });

  test("runSchtasks resolves with failed:true (not a rejection) on a non-zero exit", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("nonzero exit"), "", "not registered"));

    const result = await runner.runSchtasks(["/Query", "/TN", "missing"]);

    expect(result.failed).toBe(true);
    expect(result.stderr).toBe("not registered");
  });

  test("runSchtasks defaults stdout/stderr to empty strings when the callback omits them", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(null, undefined as unknown as string, undefined as unknown as string));

    const result = await runner.runSchtasks(["/Query"]);

    expect(result).toEqual({ stdout: "", stderr: "", failed: false });
  });

  test("runPowershell resolves the same shape without a stdout field", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const result = await runner.runPowershell("Get-ScheduledTask");

    expect(result).toEqual({ stderr: "", failed: false });
  });

  test("runPowershell reports failure on a non-zero exit", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("boom"), "", "access denied"));

    const result = await runner.runPowershell("Set-ScheduledTask");

    expect(result).toEqual({ stderr: "access denied", failed: true });
  });
});
