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
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoPath,
    stdio: "pipe",
  });
}
