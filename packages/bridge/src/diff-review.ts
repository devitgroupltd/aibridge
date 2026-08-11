/**
 * `/diff` - a mobile-friendly way to review a session's pending (uncommitted) changes from Telegram,
 * without asking Claude to paste `git diff` output back as a chat bubble (§5.5: "diffs always go as
 * documents; a diff rendered into a chat bubble on a phone is unreadable"). This is Bridge-native code,
 * not a Claude tool call - same "own scoping, never through Claude's permission engine" posture as
 * `worktree-fs.ts`/`browse-nav.ts`.
 *
 * Primary path: push the pending diff to a throwaway GitHub branch and hand back a native
 * `/compare/base...head` link - GitHub's compare page is access-controlled exactly like any other repo
 * page (private-repo permissions apply), needs no PR to exist, and gives both a per-file "Files
 * changed" list and one continuous scrollable diff in a single link. Two things a naive version of
 * this got wrong, both corrected here:
 *
 * 1. GitHub's compare page 404s on two arbitrary commit SHAs unless they're reachable via a real
 *    `refs/heads/*`/`refs/tags/*` ref - a custom ref namespace (`refs/aibridge-review/...`) looks
 *    cleaner but silently produces a broken link. Branches pushed here are real `refs/heads/*`
 *    branches, just namespaced under an `aibridge-review/` prefix.
 * 2. A throwaway base branch is usually unnecessary - `findRemoteBranchContaining` (`worktree-fs.ts`)
 *    already tells us when `HEAD` is reachable from some already-pushed remote branch (typically the
 *    session's own `claude/<slug>-1` once it's had at least one push), so that becomes the base ref
 *    directly rather than pushing a second throwaway branch every time.
 *
 * Zero local-repo mutation, by construction: `git stash create` produces a commit object representing
 * the working tree's tracked changes (staged + unstaged) without ever touching the index or working
 * tree - unlike `git commit` + `git reset --soft` (which would flip previously-unstaged files to
 * staged) or `git add -N` (which leaves intent-to-add markers behind on failure). Untracked (never
 * `git add`-ed) files are therefore *not* included in the diff itself - callers surface `untrackedFiles`
 * so the operator isn't silently missing them, without risking a mutating workaround to include them.
 *
 * Fallback path (no `github.com` remote, or the push itself fails - offline, no push access): the
 * unified diff text, scrubbed through `scrubSecrets` (same defense-in-depth `readForPreview` already
 * applies in `worktree-fs.ts`) and handed back as `kind: "document"` for the caller to send as a
 * `.diff` file attachment, per §5.5's existing "diffs always go as documents" precedent. Never throws
 * either way - a push failure is a degrade, not an error surfaced to the operator as a failure.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { scrubSecrets } from "./secret-scrub.ts";
import { findRemoteBranchContaining, parseGithubOwnerRepo } from "./worktree-fs.ts";

export interface DiffReviewResult {
  kind: "empty" | "link" | "document";
  filePaths: string[];
  untrackedFiles: string[];
  url?: string;
  diffText?: string;
}

function baseBranchName(slug: string): string {
  return `aibridge-review/${slug}-base`;
}

function headBranchName(slug: string): string {
  return `aibridge-review/${slug}-head`;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function parseStatusPorcelain(status: string): { tracked: boolean; untracked: string[] } {
  const untracked: string[] = [];
  let tracked = false;
  for (const line of status.split("\n")) {
    if (line.length === 0) continue;
    const marker = line.slice(0, 2);
    const name = line.slice(3);
    if (marker === "??") {
      untracked.push(name);
    } else {
      tracked = true;
    }
  }
  return { tracked, untracked };
}

/** Falls back to a scrubbed unified-diff document. Shared by both the "push failed" and "no GitHub
 * remote" branches of `buildDiffReview` so the two failure modes can't drift. */
function fallbackDocument(root: string, filePaths: string[], untrackedFiles: string[]): DiffReviewResult {
  const raw = git(root, ["diff", "HEAD"]);
  const scrubbed = scrubSecrets(raw).text;
  return { kind: "document", diffText: scrubbed, filePaths, untrackedFiles };
}

/**
 * Builds a pending-changes review for one session's worktree. Never throws - any git failure that
 * isn't handled explicitly below degrades to `fallbackDocument` via the outer try/catch.
 */
export function buildDiffReview(worktreeRoot: string, slug: string): DiffReviewResult {
  const root = path.resolve(worktreeRoot);
  try {
    const status = parseStatusPorcelain(git(root, ["status", "--porcelain"]));
    const stashSha = git(root, ["stash", "create"]);
    if (stashSha.length === 0) {
      return { kind: "empty", filePaths: [], untrackedFiles: status.untracked };
    }

    const filePaths = git(root, ["diff", "--name-only", "HEAD", stashSha])
      .split("\n")
      .filter((l) => l.length > 0);

    const headSha = git(root, ["rev-parse", "HEAD"]);
    const reusedBase = findRemoteBranchContaining(root, headSha);
    const headBranch = headBranchName(slug);
    const refspecs = [`${stashSha}:refs/heads/${headBranch}`];
    let baseRefName = reusedBase;
    if (!baseRefName) {
      baseRefName = baseBranchName(slug);
      refspecs.push(`${headSha}:refs/heads/${baseRefName}`);
    }

    try {
      execFileSync("git", ["push", "--force", "origin", ...refspecs], { cwd: root, stdio: "pipe" });
    } catch {
      return fallbackDocument(root, filePaths, status.untracked);
    }

    const owned = parseGithubOwnerRepo(root);
    if (!owned) {
      return fallbackDocument(root, filePaths, status.untracked);
    }

    const url = `https://github.com/${owned.owner}/${owned.repo}/compare/${baseRefName}...${headBranch}`;
    return { kind: "link", url, filePaths, untrackedFiles: status.untracked };
  } catch {
    try {
      return fallbackDocument(root, [], []);
    } catch {
      return { kind: "empty", filePaths: [], untrackedFiles: [] };
    }
  }
}

/** Renders the "N file(s) changed" line `/diff` leads with, listing each changed path (relative to
 * the worktree root) rather than just the count - callers append their own untracked-file caveat. */
export function renderFilesChangedSummary(review: DiffReviewResult): string {
  const filesChanged = review.filePaths.length;
  if (filesChanged === 0) {
    return `${filesChanged} file(s) changed.`;
  }
  return `${filesChanged} file(s) changed:\n${review.filePaths.map((p) => `- ${p}`).join("\n")}`;
}

/** Best-effort teardown of the throwaway branches this session may have pushed - called from session
 * kill/rm alongside the existing `removeWorktree` cleanup. Deleting `-base` is always safe even when
 * `buildDiffReview` never pushed it (the "reused an existing remote branch" path) - nothing was ever
 * pushed under that literal name in that case, so the delete is a harmless no-op, never touches the
 * real branch that got reused. Never throws. */
export function cleanupDiffRefs(worktreeRoot: string, slug: string): void {
  const root = path.resolve(worktreeRoot);
  try {
    execFileSync(
      "git",
      ["push", "--delete", "origin", `refs/heads/${baseBranchName(slug)}`, `refs/heads/${headBranchName(slug)}`],
      { cwd: root, stdio: "pipe" },
    );
  } catch {
    // best-effort - refs may never have existed, remote may be unreachable, etc.
  }
}
