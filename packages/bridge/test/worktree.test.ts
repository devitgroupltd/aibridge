import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktree, isWorktreeLockRaceError, removeWorktree } from "../src/worktree.ts";

let repoDir: string;
let worktreesDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

  worktreesDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktrees-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("ensureWorktree", () => {
  test("creates a worktree on a new branch", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(path.join(worktreePath, "README.md"))).toBe(true);

    const branches = execFileSync("git", ["branch", "--list", "claude/test-session-1"], {
      cwd: repoDir,
    }).toString();
    expect(branches).toContain("claude/test-session-1");
  });

  test("is idempotent - a second call for the same worktree does not error", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");
    expect(() => ensureWorktree(repoDir, worktreePath, "claude/test-session-1")).not.toThrow();
  });

  test("a stale branch left behind by a crashed/removed earlier attempt at the same slug does not block a retry", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");
    rmSync(worktreePath, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    // The worktree directory is gone but the branch survived (exactly what removeWorktree/a crash
    // leaves behind) - a fresh attempt at the same slug must still succeed.
    expect(() => ensureWorktree(repoDir, worktreePath, "claude/test-session-1")).not.toThrow();
    expect(existsSync(worktreePath)).toBe(true);
  });

  // The previous recovery step was `git branch -D`, which force-deletes regardless of whether the
  // branch carries work. Slugs come from a prompt's first five words (`slug.ts`), so two similar
  // prompts weeks apart legitimately collide - and then the "stale husk" being deleted is a finished
  // session's real, unpushed commits. Silent, unrecoverable, and not a crash: exactly §9's bar.
  test("a colliding branch carrying unmerged commits is never deleted - a fresh branch id is used", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");

    // Real work committed on that branch, never merged and never pushed.
    writeFileSync(path.join(worktreePath, "work.txt"), "important\n");
    execFileSync("git", ["add", "work.txt"], { cwd: worktreePath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "work worth keeping"], { cwd: worktreePath, stdio: "pipe" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();

    // Its worktree goes away (a `/rm` whose removal succeeded), leaving the branch behind.
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoDir, stdio: "pipe" });

    const branch = ensureWorktree(repoDir, worktreePath, "claude/test-session-1");

    expect(branch).toBe("claude/test-session-2");
    // The commit is still reachable from the original branch - nothing was destroyed.
    expect(execFileSync("git", ["rev-parse", "claude/test-session-1"], { cwd: repoDir, encoding: "utf8" }).trim()).toBe(sha);
  });

  test("returns the branch it actually cut, so the caller records the truth", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    expect(ensureWorktree(repoDir, worktreePath, "claude/test-session-1")).toBe("claude/test-session-1");
  });

  // "The directory exists" is not "the right worktree exists". A `/rm` whose `removeWorktree` lost
  // the Windows lock race still deletes the row and frees the slug, so a later `/new` against a
  // *different* repo could be handed the same slug and silently run in the old repo's checkout,
  // editing the wrong codebase while its row claimed otherwise.
  test("refuses to readopt a directory belonging to a different repo", () => {
    const otherRepo = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-other-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: otherRepo, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: otherRepo, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: otherRepo, stdio: "pipe" });
      writeFileSync(path.join(otherRepo, "OTHER.md"), "other\n");
      execFileSync("git", ["add", "OTHER.md"], { cwd: otherRepo, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: otherRepo, stdio: "pipe" });

      // A worktree of the *other* repo occupies the path this slug wants.
      const worktreePath = path.join(worktreesDir, "test-session");
      ensureWorktree(otherRepo, worktreePath, "claude/test-session-1");

      expect(() => ensureWorktree(repoDir, worktreePath, "claude/test-session-1")).toThrow(/different repo/);
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  test("readopting this repo's own existing worktree is still fine, and reports its real branch", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");

    expect(ensureWorktree(repoDir, worktreePath, "claude/test-session-1")).toBe("claude/test-session-1");
  });

  // `ensureWorktree` runs on every launch including `claude --resume`, and `resumeSession` turns a
  // throw here into an irreversible `dead` row - so a worktree left mid-rebase or on a detached
  // checkout (ordinary things for a session to do) must still be readoptable.
  test("readopts a worktree with a detached HEAD instead of failing the resume", () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "--detach", sha], { cwd: worktreePath, stdio: "pipe" });
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim()).toBe("HEAD");

    expect(() => ensureWorktree(repoDir, worktreePath, "claude/test-session-1")).not.toThrow();
  });

  test("a path that exists but is not a git worktree at all fails loudly", () => {
    const notAWorktree = path.join(worktreesDir, "just-a-folder");
    mkdirSync(notAWorktree, { recursive: true });
    writeFileSync(path.join(notAWorktree, "stray.txt"), "x\n");

    expect(() => ensureWorktree(repoDir, notAWorktree, "claude/x-1")).toThrow(/not a git worktree/);
  });
});

describe("removeWorktree", () => {
  test("removes a real worktree", async () => {
    const worktreePath = path.join(worktreesDir, "test-session");
    ensureWorktree(repoDir, worktreePath, "claude/test-session-1");

    await removeWorktree(repoDir, worktreePath);

    expect(existsSync(worktreePath)).toBe(false);
  });

  test("a missing worktree is a no-op, not an error", async () => {
    const worktreePath = path.join(worktreesDir, "never-created");
    await expect(removeWorktree(repoDir, worktreePath)).resolves.toBeUndefined();
  });
});

describe("isWorktreeLockRaceError", () => {
  // The exact classifier removeWorktree's retry loop branches on (§9's "silent-wrong" bar) -
  // misclassifying either direction either retries a permanent failure pointlessly or gives up on
  // the transient race this was added to survive.
  test("recognizes Windows' 'Permission denied' worktree-removal message", () => {
    expect(
      isWorktreeLockRaceError("error: failed to delete 'C:/data/worktrees/x': Permission denied\n"),
    ).toBe(true);
  });

  test("recognizes EBUSY and POSIX 'resource busy or locked'", () => {
    expect(isWorktreeLockRaceError("EBUSY: resource busy or locked, unlink 'x'")).toBe(true);
    expect(isWorktreeLockRaceError("resource busy or locked")).toBe(true);
  });

  test("does not misclassify an unrelated git error as the lock race", () => {
    expect(isWorktreeLockRaceError("fatal: 'x' is not a working tree")).toBe(false);
    expect(isWorktreeLockRaceError("")).toBe(false);
  });
});
