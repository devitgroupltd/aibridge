import { describe, expect, test } from "bun:test";
import { createBranchCleanupCommands } from "../src/branch-cleanup-commands.ts";
import { FleetConfirmRegistry, type PendingFleetConfirm } from "../src/fleet-confirm.ts";
import type { SessionBranchInfo } from "../src/orphan-branches.ts";
import type { RepoEntry, ReposRegistry } from "../src/repos-registry.ts";
import { SessionStore } from "../src/session-store.ts";
import { fakeControlBot } from "./helpers.ts";

const branch = (over: Partial<SessionBranchInfo> & { branch: string }): SessionBranchInfo => ({
  worktreePath: "",
  lastCommitDate: "2026-08-06",
  merged: false,
  ahead: 2,
  ...over,
});

function setup(opts: { repos?: RepoEntry[]; branches?: Record<string, SessionBranchInfo[]>; isControlTopic?: boolean } = {}) {
  const repos = opts.repos ?? [{ name: "aibridge", path: "C:\\data\\projects\\aibridge" }];
  const controlBot = fakeControlBot();
  const sessionStore = new SessionStore(":memory:");
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  // The registry exposes `take(id)` but no listing, and the ids are random - so record what gets
  // registered on the way in. This is the assertion that matters most in this file: the card's text
  // and the card's *targets* are built from two different filters, and only one of them is visible.
  const registered: Array<Omit<PendingFleetConfirm, "createdAt">> = [];
  const realAdd = fleetConfirmRegistry.add.bind(fleetConfirmRegistry);
  fleetConfirmRegistry.add = (entry) => {
    registered.push(entry);
    realAdd(entry);
  };
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const commands = createBranchCleanupCommands({
    controlBot: controlBot as never,
    sessionStore,
    fleetConfirmRegistry,
    confirmSessionCommand: ((topicId: number | undefined, text: string) => confirmed.push({ topicId, text })) as never,
    isControlTopic: () => opts.isControlTopic ?? true,
    getReposRegistry: () => ({ all: () => repos }) as ReposRegistry,
    supergroupChatId: "-100",
    listBranches: (repoPath: string) => opts.branches?.[repoPath] ?? [],
    log: () => {},
  });
  return { commands, controlBot, sessionStore, fleetConfirmRegistry, registered, confirmed };
}

const AIBRIDGE = "C:\\data\\projects\\aibridge";

describe("handleBranchesCommand", () => {
  test("posts a card with a delete button when merged orphans exist, and registers exactly those", async () => {
    const s = setup({ branches: { [AIBRIDGE]: [branch({ branch: "claude/merged-1", merged: true, ahead: 0 }), branch({ branch: "claude/work-1" })] } });
    await s.commands.handleBranchesCommand({ kind: "branches" }, 1);

    expect(s.controlBot.sent).toHaveLength(1);
    const sent = s.controlBot.sent[0]!;
    expect(sent.text).toContain("claude/merged-1");
    expect(sent.text).toContain("claude/work-1");
    expect(sent.text).toContain("Delete the 1 merged branch listed above?");
    expect(sent.keyboard).toBeDefined();

    // The registered targets are the merged branch alone - the card names both, and a tap that
    // silently acted on the unmerged one is the exact lie this area keeps producing.
    expect(s.registered).toHaveLength(1);
    expect(s.registered[0]).toMatchObject({ kind: "rm-branch", slugs: ["claude/merged-1"], repoPath: AIBRIDGE });
  });

  // The common case: session branches are normally unmerged, so a button would almost always be one
  // that does nothing.
  test("posts no button at all when nothing is safe to delete", async () => {
    const s = setup({ branches: { [AIBRIDGE]: [branch({ branch: "claude/work-1" })] } });
    await s.commands.handleBranchesCommand({ kind: "branches" }, 1);

    expect(s.controlBot.sent).toHaveLength(0);
    expect(s.registered).toHaveLength(0);
    expect(s.confirmed[0]!.text).toContain("claude/work-1");
    expect(s.confirmed[0]!.text).toContain("nothing here will delete them");
  });

  test("a branch whose session is still live is not reported", async () => {
    const s = setup({ branches: { [AIBRIDGE]: [branch({ branch: "claude/live-1", merged: true })] } });
    s.sessionStore.insert({
      slug: "live",
      topicId: 9,
      sessionId: "abc",
      worktreePath: "C:\\data\\worktrees\\live",
      branch: "claude/live-1",
      repoPath: AIBRIDGE,
      model: "sonnet",
      ptyPid: 0,
      state: "idle",
      turnCardMsg: null,
      thinkingPlaceholderMsg: null,
      paused: false,
      feedDetail: "compact",
      feedVerbose: false,
      bypassPermission: false,
      autoAnswer: false,
      mode: "default",
      createdUtc: new Date().toISOString(),
      lastEventUtc: new Date().toISOString(),
    });
    await s.commands.handleBranchesCommand({ kind: "branches" }, 1);

    expect(s.controlBot.sent).toHaveLength(0);
    expect(s.confirmed[0]!.text).toBe('No orphaned session branches in "aibridge".');
  });

  // Answering the question that was asked. A boot card stays silent on a clean tree; a command must
  // not, or "nothing happened" is indistinguishable from the command having failed.
  test("says so explicitly when there is nothing to report", async () => {
    const s = setup();
    await s.commands.handleBranchesCommand({ kind: "branches" }, 1);
    expect(s.confirmed[0]!.text).toBe('No orphaned session branches in "aibridge".');
  });

  test("scans every registered repo when no name is given, one card each", async () => {
    const s = setup({
      repos: [
        { name: "aibridge", path: AIBRIDGE },
        { name: "seowrite", path: "C:\\data\\projects\\seowrite" },
      ],
      branches: {
        [AIBRIDGE]: [branch({ branch: "claude/a-1", merged: true })],
        "C:\\data\\projects\\seowrite": [branch({ branch: "claude/b-1", merged: true })],
      },
    });
    await s.commands.handleBranchesCommand({ kind: "branches" }, 1);

    expect(s.controlBot.sent).toHaveLength(2);
    expect(s.registered.map((p) => p.repoPath)).toEqual([AIBRIDGE, "C:\\data\\projects\\seowrite"]);
  });

  test("a named repo scans only that one", async () => {
    const s = setup({
      repos: [
        { name: "aibridge", path: AIBRIDGE },
        { name: "seowrite", path: "C:\\data\\projects\\seowrite" },
      ],
      branches: { [AIBRIDGE]: [branch({ branch: "claude/a-1", merged: true })], "C:\\data\\projects\\seowrite": [branch({ branch: "claude/b-1", merged: true })] },
    });
    await s.commands.handleBranchesCommand({ kind: "branches", repo: "seowrite" }, 1);

    expect(s.controlBot.sent).toHaveLength(1);
    expect(s.controlBot.sent[0]!.text).toContain("claude/b-1");
  });

  // A typo'd name reporting "none found" reads exactly like a clean result, which is the whole
  // silent-wrong class.
  test("an unregistered repo name is an error, not an empty report", async () => {
    const s = setup();
    await s.commands.handleBranchesCommand({ kind: "branches", repo: "seowrit" }, 1);
    expect(s.confirmed[0]!.text).toContain('No repo named "seowrit" is registered');
    expect(s.confirmed[0]!.text).not.toContain("No orphaned");
  });

  test("control topic only", async () => {
    const s = setup({ isControlTopic: false });
    await s.commands.handleBranchesCommand({ kind: "branches" }, 5);
    expect(s.confirmed[0]!.text).toBe("/branches only works from the control topic.");
    expect(s.controlBot.sent).toHaveLength(0);
  });

  test("an empty registry says to register one rather than reporting nothing found", async () => {
    const s = setup({ repos: [] });
    await s.commands.handleBranchesCommand({ kind: "branches" }, 1);
    expect(s.confirmed[0]!.text).toContain("No repos are registered");
  });
});
