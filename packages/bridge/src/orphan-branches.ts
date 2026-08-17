import { execFileSync } from "node:child_process";

/**
 * §4.5's *fourth* debris class, and the one the reconciliation matrix never named: a session branch
 * whose session is gone.
 *
 * Every session runs on `claude/<slug>-<id>` in a worktree cut from a registered repo (§2.3). `/rm`
 * deletes the topic, the row and the worktree directory - and deliberately leaves the branch. That
 * is not an oversight, and `worktree.ts` argues the case at its own call site: slugs come from a
 * prompt's first few words, so two similar prompts weeks apart collide, and at that point the
 * leftover branch is a finished session's real, unpushed work. `ensureWorktree` therefore tries
 * `git branch -d` (never `-D`), and when git refuses it takes the next free `-<id>` instead of
 * destroying anything.
 *
 * So nothing here is *broken*. What is missing is that **nothing ever tells the operator the
 * branches exist.** Measured on this host 2026-08-17: 25 session branches carrying unmerged commits,
 * the oldest from 2026-08-06, none of them reachable from any topic, `/ls`, or any other surface.
 * Most were throwaway verification runs; that is precisely the problem, because the handful that are
 * not look identical to them and nobody has ever been shown either.
 *
 * ## Why this is a command and not a boot card
 *
 * `orphan-worktrees.ts` posts at boot because its debris causes an *invisible failure*: a freed slug
 * plus a leftover directory produces a `/new` that fails for reasons the operator cannot see. A
 * leftover branch causes nothing - `ensureWorktree` handles the collision by design. The harm is
 * only that work quietly accumulates unlooked-at, which is a "go and check when you want to" fact,
 * not an interrupt. A 25-line 🧹 card on every single restart is how the *worktree* card stops being
 * read, and that one is load-bearing.
 *
 * ## What is offered for deletion, and what is only reported
 *
 * Only branches fully merged into their repo's base are offered. Unmerged ones are listed with their
 * commit counts and left strictly alone - the whole reason this debris is allowed to exist is that
 * an unmerged session branch may be the only copy of something. `removeOrphanBranch` then re-checks
 * every guard at deletion time and finishes with `git branch -d`, so git itself refuses an unmerged
 * branch even if everything upstream of it were wrong.
 */

/** `claude/<slug>-<id>`, exactly as `session-launcher.ts` builds it and `nextFreeBranch` increments
 * it. Anchored at both ends: this is the predicate that decides whether a branch is aibridge's to
 * reason about at all, so an operator's own `claude/experiments` or `feature/claude/x` must not
 * match. */
const SESSION_BRANCH_RE = /^claude\/(.+)-(\d+)$/;

/** The slug a session branch belongs to, or `undefined` for any branch aibridge did not create. */
export function sessionBranchSlug(branch: string): string | undefined {
  return SESSION_BRANCH_RE.exec(branch)?.[1];
}

export interface SessionBranchInfo {
  branch: string;
  /** The worktree that has it checked out, or `""` for none. Read from git rather than inferred from
   * the worktrees root: a branch checked out anywhere at all is live to git, including a worktree the
   * operator cut somewhere aibridge has never heard of. */
  worktreePath: string;
  /** `YYYY-MM-DD` of the last commit - the only thing that makes a list of 25 slugs actionable. */
  lastCommitDate: string;
  /** Fully merged into the repo's base branch. **False when the base could not be resolved**, which
   * is the fail-closed direction: unknown means report-only, never offer to delete. */
  merged: boolean;
  /** Commits not in the base, or `undefined` when the base could not be resolved. */
  ahead: number | undefined;
}

export interface OrphanBranch {
  branch: string;
  slug: string;
  lastCommitDate: string;
  ahead: number | undefined;
  /** Merged into base, so `git branch -d` will accept it - safe to offer. */
  removable: boolean;
}

export interface ClassifyOrphanBranchesInput {
  branches: readonly SessionBranchInfo[];
  /** Every slug the session store knows, live or dead. */
  knownSlugs: readonly string[];
}

/**
 * The pure half. Three independent reasons to leave a branch out, and each rules out a different way
 * of being wrong:
 *
 *   - not `claude/<slug>-<id>`: not aibridge's branch, never ours to list or delete.
 *   - checked out somewhere: git considers it live, and so should this.
 *   - its slug still has a session row: that session owns the branch and its own `/rm` will deal
 *     with it. Note this excludes `claude/foo-1` while a live session holds slug `foo` on
 *     `claude/foo-2` - deliberately conservative, since the cost of over-reporting is a card that
 *     offers to delete a running session's earlier work.
 */
export function classifyOrphanBranches(input: ClassifyOrphanBranchesInput): OrphanBranch[] {
  const known = new Set(input.knownSlugs);
  const orphans: OrphanBranch[] = [];
  for (const info of input.branches) {
    const slug = sessionBranchSlug(info.branch);
    if (slug === undefined) continue;
    if (info.worktreePath !== "") continue;
    if (known.has(slug)) continue;
    orphans.push({ branch: info.branch, slug, lastCommitDate: info.lastCommitDate, ahead: info.ahead, removable: info.merged });
  }
  return orphans;
}

function git(repoPath: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function tryGit(repoPath: string, args: readonly string[]): string | undefined {
  try {
    return git(repoPath, args);
  } catch {
    return undefined;
  }
}

/**
 * The base every branch is measured against: the repo's configured `base` (repos.toml, §7.5) if it
 * resolves, else `main`, else `master`. Returns `undefined` when none of them exist, which makes
 * every branch report as unmerged and therefore undeletable - the right way to fail, since the
 * alternative is offering to delete branches against a base that was never checked.
 */
export function resolveBaseRef(repoPath: string, configuredBase?: string): string | undefined {
  for (const candidate of [configuredBase, "main", "master"]) {
    if (!candidate) continue;
    if (tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) !== undefined) return candidate;
  }
  return undefined;
}

/** Every `refs/heads/claude/*` in one repo, with the three facts classification needs. One
 * `for-each-ref` rather than a `git branch` parse: `%(worktreepath)` is the authoritative
 * checked-out answer, and the tab-delimited format cannot be confused by a branch name containing
 * spaces the way `git branch`'s decorated output can. */
export function listSessionBranches(repoPath: string, configuredBase?: string): SessionBranchInfo[] {
  const base = resolveBaseRef(repoPath, configuredBase);
  const raw = tryGit(repoPath, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:short)%09%(worktreepath)", "refs/heads/claude/"]);
  if (raw === undefined) return [];
  const infos: SessionBranchInfo[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const [branch = "", lastCommitDate = "", worktreePath = ""] = line.split("\t");
    if (sessionBranchSlug(branch) === undefined) continue;
    let merged = false;
    let ahead: number | undefined;
    if (base !== undefined) {
      merged = tryGit(repoPath, ["merge-base", "--is-ancestor", branch, base]) !== undefined;
      const counted = tryGit(repoPath, ["rev-list", "--count", `${base}..${branch}`])?.trim();
      ahead = counted !== undefined && /^\d+$/.test(counted) ? Number(counted) : undefined;
    }
    infos.push({ branch, worktreePath: worktreePath.trim(), lastCommitDate, merged, ahead });
  }
  return infos;
}

export class UnsafeBranchRemoval extends Error {}

/**
 * Deletes one orphaned session branch. Same contract as `removeOrphanWorktree`: every guard is
 * checked here, at the moment of deletion, rather than inherited from a confirm card that may be
 * minutes old and has made a round trip through Telegram.
 *
 *   1. The name must be `claude/<slug>-<id>`. A tapped card cannot make this delete `main`.
 *   2. The branch must still exist and still be checked out nowhere - `/new` may have readopted the
 *      slug since the card was posted.
 *   3. `isStillOrphaned` re-asks the session store, for the same reason.
 *   4. `git branch -d`, never `-D`. This is the guard that matters: it is git refusing to destroy
 *      unmerged commits, and it holds even if every check above were somehow wrong.
 *
 * Throws `UnsafeBranchRemoval` rather than returning false, so a guard trip can never be read as
 * "there was nothing there".
 */
export function removeOrphanBranch(repoPath: string, branch: string, isStillOrphaned: (slug: string) => boolean): void {
  const slug = sessionBranchSlug(branch);
  if (slug === undefined) throw new UnsafeBranchRemoval(`refusing to delete "${branch}" - not a claude/<slug>-<id> session branch`);
  const raw = tryGit(repoPath, ["for-each-ref", "--format=%(refname:short)%09%(worktreepath)", `refs/heads/${branch}`]);
  const line = raw?.split("\n").find((l) => l.trim() !== "");
  if (line === undefined) throw new UnsafeBranchRemoval(`refusing to delete "${branch}" - no such branch in ${repoPath}`);
  const worktreePath = (line.split("\t")[1] ?? "").trim();
  if (worktreePath !== "") throw new UnsafeBranchRemoval(`refusing to delete "${branch}" - it is checked out at ${worktreePath}`);
  if (!isStillOrphaned(slug)) throw new UnsafeBranchRemoval(`refusing to delete "${branch}" - a session now holds the slug "${slug}"`);
  try {
    git(repoPath, ["branch", "-d", branch]);
  } catch (err) {
    // `-d`'s refusal is the expected failure, not an anomaly: it means the branch holds commits the
    // base does not, which is exactly the work this whole module exists to avoid destroying.
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim() ?? (err as Error).message;
    throw new UnsafeBranchRemoval(`git refused to delete "${branch}": ${stderr}`);
  }
}

/**
 * The report. Every orphan is named with its age and how far ahead of base it is, because a bare
 * list of 25 slugs is not something anyone acts on - "3 commits, 2026-08-06" is.
 */
export function renderOrphanBranchReport(repoName: string, orphans: readonly OrphanBranch[]): string {
  if (orphans.length === 0) return `No orphaned session branches in "${repoName}".`;
  const removable = orphans.filter((o) => o.removable);
  const kept = orphans.filter((o) => !o.removable);
  const describe = (o: OrphanBranch) => `• ${o.branch} (${o.ahead === undefined ? "base unknown" : `${o.ahead} commit${o.ahead === 1 ? "" : "s"}`}, ${o.lastCommitDate})`;
  const lines = [`🌿 ${orphans.length} session branch${orphans.length === 1 ? "" : "es"} in "${repoName}" ${orphans.length === 1 ? "has" : "have"} no session behind ${orphans.length === 1 ? "it" : "them"}.`];
  if (kept.length > 0) {
    lines.push("", `Holding commits that are not in the base branch - reported only, nothing here will delete them:`, ...kept.map(describe));
  }
  if (removable.length > 0) {
    lines.push("", `Fully merged, so nothing would be lost:`, ...removable.map(describe));
  }
  return lines.join("\n");
}
