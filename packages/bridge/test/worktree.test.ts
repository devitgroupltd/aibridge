import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktree } from "../src/worktree.ts";

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
});
