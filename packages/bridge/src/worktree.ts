import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Cuts a git worktree for one session, idempotently (§2.3: every session gets its own worktree,
 * regardless of which target repo it's registered against). Worktree provisioning driven by
 * `/new` and a real repo registry is explicitly Phase 5 work (§12); Phase 1 only ever calls this
 * for the one hardcoded test session.
 */
export function ensureWorktree(repoPath: string, worktreePath: string, branch: string): string {
  if (existsSync(worktreePath)) {
    // "The directory exists" is not the same claim as "the right worktree exists". A `/rm` whose
    // `removeWorktree` failed (the Windows lock race below can exhaust its retries) deletes the
    // session row anyway and frees the slug, so a later `/new` against a *different* repo can be
    // handed this same slug - and silently run in the old repo's checkout while its row records
    // the new repo's path. Assert the invariant instead of trusting a proxy for it.
    assertWorktreeBelongsTo(repoPath, worktreePath);
    // A detached HEAD has no branch to report, so fall back to the preferred name. Deliberately *not*
    // an error: `ensureWorktree` runs on every launch including `claude --resume`, and `resumeSession`
    // turns any throw here into an irreversible `dead` row - so throwing would permanently kill a
    // session that merely left its worktree mid-`git rebase` or on a `git checkout <sha>`, which is
    // ordinary work for a session to be doing. The correctness invariant is `assertWorktreeBelongsTo`
    // above; the branch name is only used for reporting.
    return currentBranch(worktreePath) ?? branch;
  }
  // A registered-but-missing worktree entry (directory deleted by hand, or a partial removal)
  // otherwise makes both `worktree add` *and* the branch delete below fail permanently - git
  // refuses to touch a branch it still believes is checked out somewhere.
  tryGit(repoPath, ["worktree", "prune"]);
  try {
    addWorktree(repoPath, worktreePath, branch);
    return branch;
  } catch (err) {
    // A branch of this name can outlive its worktree - `/rm`'s `removeWorktree` (and a Bridge
    // crash mid-`/new`, confirmed live 2026-08-03) both leave the branch behind even though the
    // worktree directory (checked above) is gone.
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString() ?? "";
    if (!/already exists/.test(stderr)) throw err;
    // `-d`, never `-D`: the leftover branch is *usually* the empty husk of a crashed `/new`, but
    // slugs are derived from a prompt's first few words (`slug.ts`), so two similar prompts weeks
    // apart collide - and then the leftover branch is a finished session's real, unpushed work.
    // `-d` refuses exactly that case; `-D` used to delete it, commits and all.
    if (tryGit(repoPath, ["branch", "-d", branch])) {
      addWorktree(repoPath, worktreePath, branch);
      return branch;
    }
    // Unmerged commits on that branch. §2.3's `claude/<slug>-<id>` suffix exists for this: take
    // the next free id rather than either destroying the work or wedging the slug forever.
    const fresh = nextFreeBranch(repoPath, branch);
    addWorktree(repoPath, worktreePath, fresh);
    return fresh;
  }
}

function addWorktree(repoPath: string, worktreePath: string, branch: string): void {
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoPath, stdio: "pipe" });
}

/** Runs a git command for its success/failure only - `true` on exit 0, `false` on anything else.
 * Used for the recovery steps where a failure is informative rather than fatal. */
function tryGit(cwd: string, args: readonly string[]): boolean {
  try {
    execFileSync("git", [...args], { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Exported for `attachment-inbox.ts`'s `ensureInboxGitignored` too - both need "the real, canonical
 * common git dir for this path" and there's no reason for a second, less battle-tested copy of the
 * relative-vs-absolute/realpath handling below. */
export function gitCommonDir(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    if (out.length === 0) return null;
    // `--git-common-dir` is relative to `cwd` when it can be (a plain `.git`), absolute in a
    // worktree - resolve either against the cwd it was asked from before comparing.
    return canonical(path.resolve(cwd, out));
  } catch {
    return null;
  }
}

/** Windows paths compare case-insensitively and routinely differ in drive-letter case between what
 * git prints and what the config carries; a naive `===` here would reject a perfectly good worktree.
 * They can also differ in 8.3-short-name vs. long-name form - e.g. GitHub's Windows runners report
 * `os.tmpdir()` as `C:\Users\RUNNER~1\...` while git resolves an absolute `--git-common-dir` through
 * its own long-form realpath - so resolve through the OS's real path first; `path.resolve` alone
 * only normalizes `.`/`..`/separators and leaves short names untouched. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  let real: string;
  try {
    real = realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function currentBranch(worktreePath: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
    return out.length > 0 && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}

/** Throws (loudly, naming both paths) if `worktreePath` isn't a checkout of `repoPath`. Failing
 * fast here is the whole point: the alternative is a session editing a different repo's code while
 * every row, feed line and `/diff` link claims otherwise. */
export function assertWorktreeBelongsTo(repoPath: string, worktreePath: string): void {
  const expected = gitCommonDir(repoPath);
  const actual = gitCommonDir(worktreePath);
  if (expected === null || actual === null) {
    throw new Error(`"${worktreePath}" exists but is not a git worktree (expected one cut from "${repoPath}")`);
  }
  if (expected !== actual) {
    throw new Error(
      `"${worktreePath}" already exists but belongs to a different repo (its git dir is "${actual}", expected "${expected}") - remove it by hand, then retry`,
    );
  }
}

/** `claude/<slug>-1` -> `claude/<slug>-2`, `-3`, ... stopping at the first name no ref uses. */
function nextFreeBranch(repoPath: string, branch: string): string {
  const match = /^(.*)-(\d+)$/.exec(branch);
  const stem = match ? match[1]! : branch;
  const start = match ? Number(match[2]) + 1 : 2;
  for (let id = start; id < start + 100; id++) {
    const candidate = `${stem}-${id}`;
    if (!tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
  }
  throw new Error(`could not find a free branch name for "${branch}" after 100 attempts`);
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
