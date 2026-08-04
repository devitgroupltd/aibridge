import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Cuts a git worktree for one session, idempotently (§2.3: every session gets its own worktree,
 * regardless of which target repo it's registered against). Worktree provisioning driven by
 * `/new` and a real repo registry is explicitly Phase 5 work (§12); Phase 1 only ever calls this
 * for the one hardcoded test session.
 */
export function ensureWorktree(repoPath: string, worktreePath: string, branch: string): void {
  if (existsSync(worktreePath)) {
    return;
  }
  try {
    execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch (err) {
    // A branch of this name can outlive its worktree - `/rm`'s `removeWorktree` (and a Bridge
    // crash mid-`/new`, confirmed live 2026-08-03) both leave the branch behind even though the
    // worktree directory (checked above) is gone. Safe to delete and retry: nothing has this
    // branch checked out, since the one worktree that could have is the one that doesn't exist.
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString() ?? "";
    if (!/already exists/.test(stderr)) throw err;
    execFileSync("git", ["branch", "-D", branch], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
      cwd: repoPath,
      stdio: "pipe",
    });
  }
}

/** `/rm`'s worktree teardown (§4.2) - `--force` because a session's worktree routinely has
 * uncommitted scratch state that `/rm` is an explicit, operator-triggered "throw this away" action
 * for, not an accidental one. A missing worktree (already removed by hand) is a no-op, not an error. */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  if (!existsSync(worktreePath)) return;
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoPath,
    stdio: "pipe",
  });
}
