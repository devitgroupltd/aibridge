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
  const nudges: Array<{ slug: string; topicId: number; content: string; msgId: string; from: string }> = [];
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
      return { stdout: "", stderr: "", failed: false };
    },
    respawnSelfAndExit: async () => {
      respawnCalls.push(1);
      return undefined as never;
    },
    stateDir,
    supergroupChatId: "-100",
    entryScriptDir: "c:\\bridge-repo\\packages\\bridge\\src",
    log: () => {},
    ptyIo: {
      sendChannelText: (slug, topicId, content, msgId, from) => {
        nudges.push({ slug, topicId, content, msgId, from });
      },
    },
    ...overrides,
  });
  return { deployLifecycle, controlBot, sessionStore, confirmed, respawnCalls, stateDir, runSchtasksCalls, runPowershellCalls, nudges };
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

  describe("handleMergeCommand", () => {
    test("outside the control topic, refuses without touching the session store", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleMergeCommand(5, "fix-bug");

      expect(confirmed[0]?.text).toContain("only works from the control topic");
    });

    test("an unknown slug reports it's missing", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleMergeCommand(undefined, "no-such-session");

      expect(confirmed[0]?.text).toContain('No session "no-such-session"');
    });

    test("a failing gate reports the failure and never restarts", async () => {
      const failingOutcome: DeployOutcome = { ok: false, rolledBack: true, message: "typecheck failed" };
      const { deployLifecycle, sessionStore, controlBot, respawnCalls, stateDir } = await setup({
        deployBranch: async () => failingOutcome,
      });
      sessionStore.insert(row());

      await deployLifecycle.handleMergeCommand(undefined, "fix-bug");

      expect(controlBot.sent.some((m) => m.text.includes("typecheck failed"))).toBe(true);
      expect(respawnCalls).toEqual([]);
      expect(readDeployMarker(stateDir)).toBeNull();
    });

    test("a plain (non-conflict) failure never nudges the session", async () => {
      const failingOutcome: DeployOutcome = { ok: false, rolledBack: true, message: "typecheck failed" };
      const { deployLifecycle, sessionStore, nudges } = await setup({
        deployBranch: async () => failingOutcome,
      });
      sessionStore.insert(row());

      await deployLifecycle.handleMergeCommand(undefined, "fix-bug");

      expect(nudges).toEqual([]);
    });

    /** Found live 2026-08-11: a rebase-conflict message used to tell the operator to "resolve by
     * hand in <worktree path>" - useless from a phone with no shell access. Now the session that
     * owns the worktree (already sitting there with full code context) gets nudged to resolve it
     * itself, and the control-topic message is rendered as HTML so the raw git output doesn't run
     * into the middle of a sentence. */
    test("a conflict failure nudges the owning session and renders detail as its own HTML block", async () => {
      const conflictOutcome: DeployOutcome = {
        ok: false,
        rolledBack: false,
        conflict: true,
        message: '"claude/fix-bug-1" diverged from C:\\repo and auto-rebase onto it hit conflicts - aborted, C:\\wt\\fix-bug left clean.',
        detail: "CONFLICT (content): Merge conflict in src/foo.ts",
      };
      const { deployLifecycle, sessionStore, controlBot, nudges } = await setup({
        deployBranch: async () => conflictOutcome,
      });
      sessionStore.insert(row());

      await deployLifecycle.handleMergeCommand(undefined, "fix-bug");

      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.slug).toBe("fix-bug");
      expect(nudges[0]?.topicId).toBe(5); // the session's own topic, not the control topic
      expect(nudges[0]?.content).toContain("/ship");
      expect(nudges[0]?.from).toBe("aibridge");

      const sent = controlBot.sent.at(-1);
      expect(sent?.text).toContain("<b>");
      expect(sent?.text).toContain("<pre>CONFLICT (content): Merge conflict in src/foo.ts");
    });

    test("a successful gate against a non-self repo merges but never restarts or writes a marker", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const { deployLifecycle, sessionStore, controlBot, respawnCalls, stateDir } = await setup({
        deployBranch: async () => okOutcome,
        // Doesn't resolve to the same root as `entryScriptDir`'s bridge repo, so isSelfRepo is false.
      });
      sessionStore.insert(row({ repoPath: "c:\\some-other-project\\repo" }));

      await deployLifecycle.handleMergeCommand(undefined, "fix-bug");

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

      await deployLifecycle.handleMergeCommand(undefined, "fix-bug");

      expect(controlBot.sent.some((m) => m.text.includes("restarting now"))).toBe(true);
      expect(respawnCalls).toEqual([1]);
      const marker = readDeployMarker(stateDir);
      expect(marker?.branch).toBe("claude/fix-bug-1");
      expect(marker?.previousHeadSha).toBe("aaa");
      expect(marker?.newHeadSha).toBe("bbb");
    });
  });

  describe("handleShipCommand", () => {
    test("an explicit slug outside the control topic refuses without touching the session store", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleShipCommand(5, "fix-bug", undefined);

      expect(confirmed[0]?.text).toContain("needs a slug from the control topic");
    });

    test("bare, with no current session and outside the control topic, reports usage", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleShipCommand(5, undefined, undefined);

      expect(confirmed[0]?.text).toContain("needs a slug from the control topic");
    });

    test("bare, with no current session but from the control topic, reports usage", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleShipCommand(undefined, undefined, undefined);

      expect(confirmed[0]?.text).toContain("usage: /ship <slug>");
    });

    test("an unknown slug reports it's missing", async () => {
      const { deployLifecycle, confirmed } = await setup();

      await deployLifecycle.handleShipCommand(undefined, "no-such-session", undefined);

      expect(confirmed[0]?.text).toContain('No session "no-such-session"');
    });

    test("bare, from inside that session's own topic, targets it without needing the control topic", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const { deployLifecycle, sessionStore, controlBot } = await setup({
        deployBranch: async () => okOutcome,
        commitIfDirty: async () => ({ committed: false, message: "clean" }),
        pushCurrentBranch: async () => ({ status: 0, stdout: "", stderr: "" }),
      });
      sessionStore.insert(row({ repoPath: "c:\\some-other-project\\repo" }));

      // topicId 5 is that session's own topic (not the control topic per this fake's isControlTopic),
      // no explicit slug - resolved from currentSlug, exactly like /kill's own bare-in-topic form.
      await deployLifecycle.handleShipCommand(5, undefined, "fix-bug");

      expect(controlBot.sent.some((m) => m.text.includes("merged cleanly"))).toBe(true);
    });

    test("an explicit slug naming a different session, sent from inside a session's own topic, still refuses", async () => {
      const { deployLifecycle, confirmed, sessionStore } = await setup();
      sessionStore.insert(row({ slug: "other-session" }));

      // topicId 5 is *this* session's own topic; naming a different slug isn't "targeting own
      // session" - only the control topic can direct /ship at a session other than the one you're in.
      await deployLifecycle.handleShipCommand(5, "other-session", "fix-bug");

      expect(confirmed[0]?.text).toContain("needs a slug from the control topic");
    });

    test("commits a dirty worktree before merging, then pushes on success", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const commitCalls: string[] = [];
      const pushCalls: string[] = [];
      const { deployLifecycle, sessionStore, controlBot, respawnCalls } = await setup({
        deployBranch: async () => okOutcome,
        commitIfDirty: async (worktreePath) => {
          commitCalls.push(worktreePath);
          return { committed: true, message: "Auto-committed uncommitted work." };
        },
        pushCurrentBranch: async (repoPath) => {
          pushCalls.push(repoPath);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      sessionStore.insert(row({ repoPath: "c:\\some-other-project\\repo", worktreePath: "c:\\wt\\fix-bug" }));

      await deployLifecycle.handleShipCommand(undefined, "fix-bug", undefined);

      expect(commitCalls).toEqual(["c:\\wt\\fix-bug"]);
      expect(pushCalls).toEqual(["c:\\some-other-project\\repo"]);
      expect(controlBot.sent.some((m) => m.text.includes("merged cleanly"))).toBe(true);
      expect(controlBot.sent.some((m) => m.text.includes("Pushed to origin"))).toBe(true);
      expect(respawnCalls).toEqual([]);
    });

    test("a clean worktree is not committed, only merged and pushed", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const commitCalls: string[] = [];
      const { deployLifecycle, sessionStore } = await setup({
        deployBranch: async () => okOutcome,
        commitIfDirty: async (worktreePath) => {
          commitCalls.push(worktreePath);
          return { committed: false, message: "worktree already clean - nothing to auto-commit." };
        },
        pushCurrentBranch: async () => ({ status: 0, stdout: "", stderr: "" }),
      });
      sessionStore.insert(row({ repoPath: "c:\\some-other-project\\repo" }));

      await deployLifecycle.handleShipCommand(undefined, "fix-bug", undefined);

      expect(commitCalls).toHaveLength(1);
    });

    test("a failing gate reports the failure, never pushes, never restarts", async () => {
      const failingOutcome: DeployOutcome = { ok: false, rolledBack: true, message: "typecheck failed" };
      const pushCalls: string[] = [];
      const { deployLifecycle, sessionStore, controlBot, respawnCalls } = await setup({
        deployBranch: async () => failingOutcome,
        commitIfDirty: async () => ({ committed: false, message: "clean" }),
        pushCurrentBranch: async (repoPath) => {
          pushCalls.push(repoPath);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      sessionStore.insert(row());

      await deployLifecycle.handleShipCommand(undefined, "fix-bug", undefined);

      expect(controlBot.sent.some((m) => m.text.includes("typecheck failed"))).toBe(true);
      expect(pushCalls).toEqual([]);
      expect(respawnCalls).toEqual([]);
    });

    test("a conflict failure nudges the owning session here too, and never pushes", async () => {
      const conflictOutcome: DeployOutcome = {
        ok: false,
        rolledBack: false,
        conflict: true,
        message: '"claude/fix-bug-1" diverged and auto-rebase hit conflicts - aborted, worktree left clean.',
        detail: "CONFLICT (content): Merge conflict in src/foo.ts",
      };
      const pushCalls: string[] = [];
      const { deployLifecycle, sessionStore, nudges } = await setup({
        deployBranch: async () => conflictOutcome,
        commitIfDirty: async () => ({ committed: false, message: "clean" }),
        pushCurrentBranch: async (repoPath) => {
          pushCalls.push(repoPath);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      sessionStore.insert(row());

      await deployLifecycle.handleShipCommand(undefined, "fix-bug", undefined);

      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.slug).toBe("fix-bug");
      expect(nudges[0]?.topicId).toBe(5);
      expect(nudges[0]?.content).toContain("/ship");
      expect(pushCalls).toEqual([]);
    });

    test("a successful merge but a failed push reports the push failure without undoing the merge", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const { deployLifecycle, sessionStore, controlBot } = await setup({
        deployBranch: async () => okOutcome,
        commitIfDirty: async () => ({ committed: false, message: "clean" }),
        pushCurrentBranch: async () => ({ status: 1, stdout: "", stderr: "remote rejected" }),
      });
      sessionStore.insert(row({ repoPath: "c:\\some-other-project\\repo" }));

      await deployLifecycle.handleShipCommand(undefined, "fix-bug", undefined);

      expect(controlBot.sent.some((m) => m.text.includes("merged cleanly"))).toBe(true);
      expect(controlBot.sent.some((m) => m.text.includes("push to origin failed"))).toBe(true);
    });

    test("a successful ship against aibridge's own repo writes the deploy marker and respawns", async () => {
      const okOutcome: DeployOutcome = { ok: true, rolledBack: false, message: "merged cleanly", previousHeadSha: "aaa", newHeadSha: "bbb" };
      const { deployLifecycle, sessionStore, controlBot, respawnCalls, stateDir } = await setup({
        deployBranch: async () => okOutcome,
        commitIfDirty: async () => ({ committed: false, message: "clean" }),
        pushCurrentBranch: async () => ({ status: 0, stdout: "", stderr: "" }),
      });
      sessionStore.insert(row({ repoPath: "c:\\bridge-repo" }));

      await deployLifecycle.handleShipCommand(undefined, "fix-bug", undefined);

      expect(controlBot.sent.some((m) => m.text.includes("restarting now"))).toBe(true);
      expect(respawnCalls).toEqual([1]);
      const marker = readDeployMarker(stateDir);
      expect(marker?.branch).toBe("claude/fix-bug-1");
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
        runPowershell: async () => ({ stdout: "", stderr: "access denied", failed: true }),
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

  test("runSchtasks falls back to err.message on a spawn-level failure (schtasks not found, stderr never populated)", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("spawn schtasks ENOENT"), "", ""));

    const result = await runner.runSchtasks(["/Query"]);

    expect(result).toEqual({ stdout: "", stderr: "spawn schtasks ENOENT", failed: true });
  });

  test("runPowershell resolves stdout/stderr/failed", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(null, "1", ""));

    const result = await runner.runPowershell("Get-ScheduledTask");

    expect(result).toEqual({ stdout: "1", stderr: "", failed: false });
  });

  test("runPowershell reports failure on a non-zero exit", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("boom"), "", "access denied"));

    const result = await runner.runPowershell("Set-ScheduledTask");

    expect(result).toEqual({ stdout: "", stderr: "access denied", failed: true });
  });

  test("runPowershell falls back to err.message on a spawn-level failure (powershell not found, stderr never populated)", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("spawn powershell ENOENT"), "", ""));

    const result = await runner.runPowershell("Set-ScheduledTask");

    expect(result).toEqual({ stdout: "", stderr: "spawn powershell ENOENT", failed: true });
  });

  test("runShutdown resolves with failed:false on a clean exit", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const result = await runner.runShutdown(["/a"]);

    expect(result).toEqual({ stdout: "", stderr: "", failed: false });
  });

  test("runShutdown resolves with failed:true (not a rejection) on a non-zero exit", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("boom"), "", "nothing to abort"));

    const result = await runner.runShutdown(["/a"]);

    expect(result).toEqual({ stdout: "", stderr: "nothing to abort", failed: true });
  });

  test("runShutdown falls back to err.message on a spawn-level failure (shutdown not found, stderr never populated)", async () => {
    const runner = createProcessRunner((_cmd, _args, _opts, cb) => cb(new Error("spawn shutdown ENOENT"), "", ""));

    const result = await runner.runShutdown(["/a"]);

    expect(result).toEqual({ stdout: "", stderr: "spawn shutdown ENOENT", failed: true });
  });
});
