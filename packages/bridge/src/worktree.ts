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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REMOVE_RETRY_DELAYS_MS = [300, 600, 1200, 2400];

/** Split out for direct unit testing (§9's "silent-wrong" bar): misclassifying a permanent git
 * error as the transient lock race would retry pointlessly for ~4.5s before failing anyway;
 * misclassifying the lock race as permanent would fail `/rm` on the very thing this exists to fix. */
export function isWorktreeLockRaceError(stderr: string): boolean {
  return /Permission denied|EBUSY|resource busy or locked/i.test(stderr);
}

/** `/rm`'s worktree teardown (§4.2) - `--force` because a session's worktree routinely has
 * uncommitted scratch state that `/rm` is an explicit, operator-triggered "throw this away" action
 * for, not an accidental one. A missing worktree (already removed by hand) is a no-op, not an error.
 *
 * Retries on a Windows file-lock race, confirmed live 2026-08-06: `/rm`/reconciliation kills the
 * session's `claude.exe` right before calling this, but the OS releases that process's open handles
 * into the worktree directory asynchronously - a removal attempted in the same tick routinely loses
 * to it with `error: failed to delete '...': Permission denied`. Windows gives no "handle closed"
 * event to wait on, so this retries on a fixed backoff instead of failing on the first race loss. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repoPath,
        stdio: "pipe",
      });
      return;
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString() ?? "";
      const delay = REMOVE_RETRY_DELAYS_MS[attempt];
      if (!isWorktreeLockRaceError(stderr) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}
