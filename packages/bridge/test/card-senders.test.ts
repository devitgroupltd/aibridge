import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCardSenders } from "../src/card-senders.ts";
import { BrowseRegistry } from "../src/browse-nav.ts";
import type { SessionRoute } from "../src/routing.ts";
import { fakeControlBot } from "./helpers.ts";

/** P1-8 (codebase-hardening-plan.md): card-senders.ts previously had no test file at all - its own
 * doc comment argues this is low-risk (thin wrappers around already-tested renderers), which these
 * tests confirm rather than assume: covering the wiring/guard logic this file actually owns
 * (session-scoping guards, chunking, branching on a renderer's result kind), not re-testing
 * about.ts/commands.ts/browse-nav.ts/worktree-fs.ts/diff-review.ts's own already-tested internals. */

/** The shared double plus `sendDocumentFile`, which `/browse`'s "Send file" action uses. */
function fakeCardBot() {
  const documentsSent: Array<{ topicId: number | undefined; filename: string; text: string; caption?: string }> = [];
  return {
    ...fakeControlBot(),
    sendDocumentFile: async (_chatId: unknown, topicId: number | undefined, filename: string, bytes: Uint8Array, caption?: string) => {
      documentsSent.push({ topicId, filename, text: new TextDecoder().decode(bytes), caption });
      return { message_id: 1 };
    },
    documentsSent,
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

function setup(overrides: Partial<Parameters<typeof createCardSenders>[0]> = {}) {
  const controlBot = fakeCardBot();
  const confirm = fakeConfirm();
  const browseRegistry = new BrowseRegistry();
  const cardSenders = createCardSenders({
    controlBot,
    confirmSessionCommand: confirm.fn,
    browseRegistry,
    supergroupChatId: "-100",
    log: () => {},
    ...overrides,
  });
  return { cardSenders, controlBot, confirm, browseRegistry };
}

describe("createCardSenders", () => {
  test("sendAboutCard sends the about text with its keyboard", () => {
    const { cardSenders, controlBot } = setup();
    cardSenders.sendAboutCard(5);
    expect(controlBot.sent.length).toBe(1);
    expect(controlBot.sent[0]?.topicId).toBe(5);
    expect(controlBot.sent[0]?.keyboard).toBeDefined();
  });

  test("sendAboutCard logs a WARN instead of throwing when sendMessage rejects", async () => {
    const warnings: string[] = [];
    const controlBot = {
      sendMessage: async () => {
        throw new Error("network blip");
      },
    };
    const confirm = fakeConfirm();
    const cardSenders = createCardSenders({
      controlBot,
      confirmSessionCommand: confirm.fn,
      browseRegistry: new BrowseRegistry(),
      supergroupChatId: "-100",
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });
    cardSenders.sendAboutCard(5);
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings[0]).toMatch(/\/about/);
  });

  describe("sendHelpCard", () => {
    test("without a route, sends the help text with no repo commands/skills in the keyboard", async () => {
      const { cardSenders, controlBot } = setup();
      cardSenders.sendHelpCard(5, undefined);
      // The chunk chain is a `.reduce` over a promise per chunk - the exact count (and therefore
      // the number of microtask ticks to drain it) depends on renderHelp()'s current length, so a
      // real macrotask wait is what actually flushes it rather than a fixed number of `await
      // Promise.resolve()`s.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controlBot.sent.length).toBeGreaterThan(0);
      // The keyboard rides only the final chunk - every earlier chunk (if any) has none.
      const last = controlBot.sent[controlBot.sent.length - 1];
      expect(last?.keyboard).toBeDefined();
      for (const chunk of controlBot.sent.slice(0, -1)) {
        expect(chunk.keyboard).toBeUndefined();
      }
    });

    test("with a route pointing at a worktree with no .claude/commands or .claude/skills, still sends cleanly", async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-"));
      try {
        const { cardSenders, controlBot } = setup();
        const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: dir };
        cardSenders.sendHelpCard(5, route);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(controlBot.sent.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a send failure mid-chunk is logged, not thrown", async () => {
      const warnings: string[] = [];
      const controlBot = {
        sendMessage: async () => {
          throw new Error("rate limited");
        },
      };
      const confirm = fakeConfirm();
      const cardSenders = createCardSenders({
        controlBot,
        confirmSessionCommand: confirm.fn,
        browseRegistry: new BrowseRegistry(),
        supergroupChatId: "-100",
        log: (level, message) => {
          if (level === "WARN") warnings.push(message);
        },
      });
      cardSenders.sendHelpCard(5, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warnings[0]).toMatch(/command list/);
    });
  });

  describe("sendCommandsListCard / sendSkillsListCard", () => {
    test("sendCommandsListCard without a route reports it's session-scoped, via sendMessage not confirmSessionCommand", () => {
      const { cardSenders, controlBot, confirm } = setup();
      cardSenders.sendCommandsListCard(5, undefined, "");
      expect(controlBot.sent[0]?.text).toMatch(/session-scoped/);
      expect(confirm.calls.length).toBe(0);
    });

    test("sendSkillsListCard without a route reports it's session-scoped", () => {
      const { cardSenders, controlBot } = setup();
      cardSenders.sendSkillsListCard(5, undefined, "");
      expect(controlBot.sent[0]?.text).toMatch(/session-scoped/);
    });

    test("sendCommandsListCard with a route reads that worktree's own commands", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-"));
      try {
        mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
        writeFileSync(path.join(dir, ".claude", "commands", "ship.md"), "# ship\n");
        const { cardSenders, controlBot } = setup();
        const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: dir };
        cardSenders.sendCommandsListCard(5, route, "");
        expect(controlBot.sent[0]?.text).toMatch(/ship/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("sendBrowseCard", () => {
    test("without a route, reports it's session-scoped via confirmSessionCommand", () => {
      const { cardSenders, confirm } = setup();
      cardSenders.sendBrowseCard(5, undefined, "");
      expect(confirm.calls[0]?.text).toMatch(/session-scoped/);
    });

    test("with a route and a valid path, sends the directory listing with its keyboard", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-"));
      try {
        writeFileSync(path.join(dir, "README.md"), "hello\n");
        const { cardSenders, controlBot } = setup();
        const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: dir };
        cardSenders.sendBrowseCard(5, route, "");
        expect(controlBot.sent[0]?.text).toMatch(/worktree root/);
        // Entries are rendered as keyboard buttons, not inline in the text - README.md shows up there.
        const keyboard = controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ text: string }>> };
        expect(keyboard.inline_keyboard.some((row) => row.some((btn) => btn.text.includes("README.md")))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("with a route and a path outside/nonexistent, reports it via confirmSessionCommand instead of sending", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-"));
      try {
        const { cardSenders, confirm, controlBot } = setup();
        const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: dir };
        cardSenders.sendBrowseCard(5, route, "../../../etc");
        expect(confirm.calls[0]?.text).toMatch(/Can't browse/);
        expect(controlBot.sent.length).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("sendFindCard", () => {
    test("without a route, reports it's session-scoped via confirmSessionCommand", () => {
      const { cardSenders, confirm } = setup();
      cardSenders.sendFindCard(5, undefined, "hello");
      expect(confirm.calls[0]?.text).toMatch(/session-scoped/);
    });

    test("with a route, searches the worktree and registers a hitset for the keyboard's paging", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-"));
      try {
        writeFileSync(path.join(dir, "needle.txt"), "hello world\n");
        const { cardSenders, controlBot, browseRegistry } = setup();
        const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: dir };
        cardSenders.sendFindCard(5, route, "needle");
        expect(controlBot.sent[0]?.text).toMatch(/needle/);
        // A hitset was actually registered, not just rendered - `buildHitsKeyboard` needs it to page.
        const keyboard = controlBot.sent[0]?.keyboard as { inline_keyboard: unknown[][] } | undefined;
        expect(keyboard?.inline_keyboard).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("sendDiffCard", () => {
    let bareDir: string;
    let workDir: string;

    function git(cwd: string, args: string[]): string {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    }

    beforeEach(() => {
      bareDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-bare-"));
      execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bareDir, stdio: "pipe" });
      workDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-card-senders-work-"));
      git(workDir, ["init", "-b", "main"]);
      git(workDir, ["config", "user.email", "test@example.com"]);
      git(workDir, ["config", "user.name", "Test"]);
      writeFileSync(path.join(workDir, "README.md"), "hello\n");
      git(workDir, ["add", "README.md"]);
      git(workDir, ["commit", "-m", "initial"]);
    });

    afterEach(() => {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    });

    test("without a route, reports it's session-scoped via confirmSessionCommand", () => {
      const { cardSenders, confirm } = setup();
      cardSenders.sendDiffCard(5, undefined);
      expect(confirm.calls[0]?.text).toMatch(/session-scoped/);
    });

    test("a clean worktree (no changes) reports 'No pending changes.' via confirmSessionCommand, not a send", () => {
      const { cardSenders, confirm, controlBot } = setup();
      const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: workDir };
      cardSenders.sendDiffCard(5, route);
      expect(confirm.calls[0]?.text).toBe("No pending changes.");
      expect(controlBot.sent.length).toBe(0);
    });

    test("untracked-only changes report the untracked note alongside 'No tracked changes.'", () => {
      writeFileSync(path.join(workDir, "new-file.txt"), "brand new\n");
      const { cardSenders, confirm } = setup();
      const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: workDir };
      cardSenders.sendDiffCard(5, route);
      expect(confirm.calls[0]?.text).toMatch(/No tracked changes\..*new-file\.txt/);
    });

    test("a tracked change with no reachable GitHub remote falls back to a .diff document attachment", () => {
      writeFileSync(path.join(workDir, "README.md"), "hello, changed\n");
      const { cardSenders, controlBot } = setup();
      const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: workDir };
      cardSenders.sendDiffCard(5, route);
      expect(controlBot.documentsSent.length).toBe(1);
      expect(controlBot.documentsSent[0]?.filename).toBe("fix-bug.diff");
      expect(controlBot.documentsSent[0]?.text).toMatch(/README\.md/);
      expect(controlBot.sent.length).toBe(0); // never also sent as a chat message
    });

    test("a tracked change with a reachable github.com remote sends a compare link with its button", () => {
      git(workDir, ["remote", "add", "origin", "https://github.com/testowner/testrepo.git"]);
      const bareUrl = `file://${bareDir.split(path.sep).join("/")}`;
      git(workDir, ["config", `url.${bareUrl}.insteadOf`, "https://github.com/testowner/testrepo.git"]);
      writeFileSync(path.join(workDir, "README.md"), "hello, changed\n");
      const { cardSenders, controlBot } = setup();
      const route: SessionRoute = { slug: "fix-bug", topicId: 5, worktreePath: workDir };
      cardSenders.sendDiffCard(5, route);
      expect(controlBot.sent.length).toBe(1);
      const keyboard = controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ text: string; url: string }>> };
      expect(keyboard.inline_keyboard[0]?.[0]?.url).toMatch(/^https:\/\/github\.com\/testowner\/testrepo\/compare\//);
      expect(controlBot.documentsSent.length).toBe(0);
    });
  });
});
