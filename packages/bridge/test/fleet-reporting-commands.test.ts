import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFleetReportingCommands } from "../src/fleet-reporting-commands.ts";
import { CostTracker } from "../src/cost-tracker.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import type { ReposRegistry } from "../src/repos-registry.ts";

/** P1-8 (codebase-hardening-plan.md): fleet-reporting-commands.ts previously had no test file at
 * all - its own doc comment argues this is a thin, low-risk, read-only wrapper. These tests confirm
 * that by covering what this file actually owns: the control-topic guards, the getter/setter
 * indirection around a reloadable `reposRegistry`, and `/repos add`'s path-inference/error-handling
 * branches - not re-testing renderBudget/renderSettings/renderReposList (fleet-commands.test.ts) or
 * repos-registry.ts's own file-format edge cases (repos-registry.test.ts). */

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-1",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 0,
    state: "working",
    turnCardMsg: null,
    thinkingPlaceholderMsg: null,
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
    bypassPermission: false,
    autoAnswer: false,
    mode: "manual",
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
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

function fakeConfirm() {
  const calls: Array<{ topicId: number | undefined; text: string }> = [];
  return {
    fn: (topicId: number | undefined, text: string) => {
      calls.push({ topicId, text });
    },
    calls,
  };
}

/** A throwaway dir with a `.git` marker - the minimum `addRepoEntry`'s existence check accepts,
 * mirroring `repos-registry.test.ts`'s own `makeFakeRepoDir`. */
function makeFakeRepoDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-fleet-reporting-repo-"));
  mkdirSync(path.join(dir, ".git"));
  return dir;
}

function setup(overrides: Partial<Parameters<typeof createFleetReportingCommands>[0]> = {}) {
  const controlBot = fakeControlBot();
  const confirm = fakeConfirm();
  const sessionStore = new SessionStore(":memory:");
  const costTracker = new CostTracker();
  let reposRegistry: ReposRegistry | undefined;
  const tomlDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-fleet-reporting-toml-"));
  const reposTomlPath = path.join(tomlDir, "repos.toml");
  const fleetReporting = createFleetReportingCommands({
    controlBot,
    sessionStore,
    costTracker,
    confirmSessionCommand: confirm.fn,
    isControlTopic: (threadId) => threadId === undefined,
    getReposRegistry: () => reposRegistry,
    setReposRegistry: (registry) => {
      reposRegistry = registry;
    },
    reposTomlPath,
    supergroupChatId: "-100",
    log: () => {},
    ...overrides,
  });
  return { fleetReporting, controlBot, confirm, sessionStore, costTracker, tomlDir, reposTomlPath, getReposRegistry: () => reposRegistry };
}

describe("createFleetReportingCommands", () => {
  describe("handleBudgetCommand", () => {
    test("sends the fleet spend summary, pruning and reading per-session cost first", () => {
      const { fleetReporting, controlBot, sessionStore, costTracker } = setup();
      sessionStore.insert(row());
      costTracker.record("sess-1", Date.now(), 1.5);
      fleetReporting.handleBudgetCommand(undefined);
      expect(controlBot.sent.length).toBe(1);
      expect(controlBot.sent[0]?.text).toMatch(/Fleet spend/);
      expect(controlBot.sent[0]?.text).toMatch(/\$1\.50/);
    });

    test("skips rows with no sessionId yet rather than crashing on a null lookup", () => {
      const { fleetReporting, controlBot, sessionStore } = setup();
      sessionStore.insert(row({ sessionId: null }));
      expect(() => fleetReporting.handleBudgetCommand(undefined)).not.toThrow();
      expect(controlBot.sent.length).toBe(1);
    });
  });

  describe("handleSettingsCommand", () => {
    test("outside the control topic, reports the guard via confirmSessionCommand instead of sending", () => {
      const { fleetReporting, confirm, controlBot } = setup();
      fleetReporting.handleSettingsCommand(5);
      expect(confirm.calls[0]?.text).toBe("/settings only works from the control topic.");
      expect(controlBot.sent.length).toBe(0);
    });

    test("from the control topic, sends settings reflecting the current repos registry and concurrency", () => {
      const { fleetReporting, controlBot, sessionStore } = setup();
      sessionStore.insert(row());
      fleetReporting.handleSettingsCommand(undefined);
      expect(controlBot.sent[0]?.text).toMatch(/Bridge settings/);
      expect(controlBot.sent[0]?.text).toMatch(/Registered repos \(0\)/);
    });
  });

  describe("handleReposCommand", () => {
    test("outside the control topic, every action reports the guard instead of running", () => {
      const { fleetReporting, confirm, controlBot } = setup();
      fleetReporting.handleReposCommand({ kind: "repos", action: "list" }, 5);
      expect(confirm.calls[0]?.text).toBe("/repos only works from the control topic.");
      expect(controlBot.sent.length).toBe(0);
    });

    test("list sends the current registry via renderReposList", () => {
      const { fleetReporting, controlBot } = setup();
      fleetReporting.handleReposCommand({ kind: "repos", action: "list" }, undefined);
      expect(controlBot.sent[0]?.text).toMatch(/Registered repos/);
    });

    test("add with an explicit path registers the repo, reloads the registry, and confirms", () => {
      const { fleetReporting, confirm, getReposRegistry } = setup();
      const repoDir = makeFakeRepoDir();
      try {
        fleetReporting.handleReposCommand({ kind: "repos", action: "add", name: "fresh", path: repoDir }, undefined);
        expect(confirm.calls[0]?.text).toMatch(/Registered "fresh"/);
        // The getter/setter round-trip actually happened - not just a confirmation with no reload.
        expect(getReposRegistry()?.all().map((r) => r.name)).toEqual(["fresh"]);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test("add with no path and nothing registered yet to infer from reports the error instead of guessing", () => {
      const { fleetReporting, confirm } = setup();
      fleetReporting.handleReposCommand({ kind: "repos", action: "add", name: "fresh" }, undefined);
      expect(confirm.calls[0]?.text).toMatch(/no path given and none could be inferred/);
    });

    test("add with a path that doesn't look like a git repo reports the failure via confirmSessionCommand, not a throw", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-fleet-reporting-notrepo-"));
      try {
        const { fleetReporting, confirm } = setup();
        expect(() => fleetReporting.handleReposCommand({ kind: "repos", action: "add", name: "notrepo", path: dir }, undefined)).not.toThrow();
        expect(confirm.calls[0]?.text).toMatch(/\/repos add failed:/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("rm unregisters an existing entry, reloads the registry, and confirms", () => {
      const { fleetReporting, confirm, getReposRegistry } = setup();
      const repoDir = makeFakeRepoDir();
      try {
        fleetReporting.handleReposCommand({ kind: "repos", action: "add", name: "fresh", path: repoDir }, undefined);
        fleetReporting.handleReposCommand({ kind: "repos", action: "rm", name: "fresh" }, undefined);
        expect(confirm.calls[1]?.text).toMatch(/Unregistered "fresh"/);
        expect(getReposRegistry()?.all()).toEqual([]);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test("rm for a name that isn't registered reports the failure instead of throwing", () => {
      const { fleetReporting, confirm } = setup();
      expect(() => fleetReporting.handleReposCommand({ kind: "repos", action: "rm", name: "ghost" }, undefined)).not.toThrow();
      expect(confirm.calls[0]?.text).toMatch(/\/repos rm failed:/);
    });
  });
});
