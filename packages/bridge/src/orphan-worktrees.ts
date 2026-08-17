import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * §4.5's reconciliation matrix has three "exists on one side, not the other" cases. Two were
 * already covered: an orphaned Telegram topic (§4.5.2's `rm-topic` confirm) and an orphaned
 * `claude.exe` (`orphan-scan.ts`). The third - **a worktree directory on disk with no session row -
 * had nothing at all**, and `reconciliation.ts` cannot see it by construction, since it walks rows
 * and never looks at the filesystem.
 *
 * Found 2026-08-17 by counting debris rather than by any test: nine directories under
 * `c:\data\worktrees`, seven of them full source trees, 94M, accumulated over months. Every one came
 * from a `/rm` whose `removeWorktree` lost the Windows file-lock race `worktree.ts` documents - the
 * row went (deliberately: a failed teardown must not wedge the slug forever), the directory stayed,
 * and a later `/new`'s `git worktree prune` dropped the registration, so `git worktree list` showed
 * nothing and only the disk knew.
 *
 * This is not merely untidy. `ensureWorktree`'s own doc comment spells out the hazard: a freed slug
 * can be handed to a `/new` against a *different* repo, which would then run in the old repo's
 * checkout while its row records the new repo's path. `assertWorktreeBelongsTo` catches that and
 * throws - so the real symptom is a `/new` that fails for reasons invisible to the operator, on a
 * slug that looks free.
 *
 * ## What is offered for deletion, and what is only reported
 *
 * A directory with no session row is *not* on its own enough to delete. The operator can cut their
 * own worktrees under the same root by hand, and one of those looks identical to a row-less
 * aibridge directory. The discriminator is `.git`: a live worktree always has one (a file pointing
 * at the parent repo's `.git/worktrees/<name>`), and the failure above removes it while leaving the
 * tree behind - which is exactly the signature all seven of the found directories had.
 *
 * So a row-less directory **with** a `.git` entry is reported and left strictly alone; only one
 * **without** is offered for removal, and only behind an operator tap. Erring toward reporting is
 * deliberate: the cost of leaving a directory is disk, and the cost of deleting the wrong one is
 * someone's uncommitted work.
 */

export interface OrphanWorktree {
  slug: string;
  /** No `.git` entry - not a live worktree of anything, safe to offer for deletion. */
  removable: boolean;
}

export interface ClassifyOrphanWorktreesInput {
  /** Direct child directory names of the worktrees root. */
  dirNames: readonly string[];
  /** Every slug the session store currently knows, live or dead. */
  knownSlugs: readonly string[];
  /** Whether that directory holds a `.git` entry - injected rather than read here so the
   * classification stays pure and directly testable. */
  hasGitEntry: (dirName: string) => boolean;
}

/**
 * The pure half. A directory whose slug still has a row is not an orphan at all, however broken it
 * looks - that session's own `/rm` owns it.
 */
export function classifyOrphanWorktrees(input: ClassifyOrphanWorktreesInput): OrphanWorktree[] {
  const known = new Set(input.knownSlugs);
  return input.dirNames
    .filter((name) => !known.has(name))
    .map((slug) => ({ slug, removable: !input.hasGitEntry(slug) }));
}

/** Direct child directories of `worktreesRoot`, or `[]` if the root does not exist yet (a Bridge
 * that has never created a session). Symlinks are skipped outright rather than followed - see
 * `removeOrphanWorktree` for why this module refuses to reason about them at all. */
export function listWorktreeDirs(worktreesRoot: string): string[] {
  try {
    return readdirSync(worktreesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function hasGitEntry(worktreesRoot: string, slug: string): boolean {
  return existsSync(path.join(worktreesRoot, slug, ".git"));
}

/** A slug that is safe to join onto the worktrees root: exactly the shape `slug.ts` produces, and
 * therefore incapable of being `..`, an absolute path, or anything with a separator in it. Checked
 * again here rather than trusted from the confirm card, because what happens next is a recursive
 * delete and the card's payload has made a round trip through Telegram. */
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeWorktreeSlug(slug: string): boolean {
  return SAFE_SLUG_RE.test(slug) && slug !== "." && slug !== "..";
}

export class UnsafeWorktreeRemoval extends Error {}

/**
 * Deletes one orphaned worktree directory, with every guard checked at the moment of deletion rather
 * than inherited from whatever decided to call it. This is the only place in aibridge that
 * recursively deletes a directory it did not just create, so the guards are the feature:
 *
 *   1. The slug must match `SAFE_SLUG_RE` - no separators, no `..`, no drive letters.
 *   2. The joined path's parent must be exactly `worktreesRoot`, re-derived from the join. A slug
 *      that survived (1) cannot escape, but this is the assertion that says so rather than a comment
 *      claiming it.
 *   3. The target must not be a symlink. `rmSync` would remove the link rather than its target, so
 *      this is not itself the dangerous case - it is that a symlink here means someone arranged
 *      something deliberate, and guessing at intent with a recursive delete is not this function's
 *      job.
 *   4. It must still have no `.git` entry. The card can be minutes old, and `/new` may have
 *      readopted the directory in between (`ensureWorktree` does exactly that), which would make
 *      this a delete of a live session's checkout.
 *   5. `isStillOrphaned` re-checks the session store for the same reason - the slug may have been
 *      handed to a new session since the card was posted.
 *
 * Throws `UnsafeWorktreeRemoval` rather than returning false so a guard trip can never be mistaken
 * for "there was nothing there".
 */
export function removeOrphanWorktree(worktreesRoot: string, slug: string, isStillOrphaned: (slug: string) => boolean): void {
  if (!isSafeWorktreeSlug(slug)) throw new UnsafeWorktreeRemoval(`refusing to remove worktree directory for unsafe slug "${slug}"`);
  const target = path.join(worktreesRoot, slug);
  if (path.dirname(target) !== path.resolve(worktreesRoot)) {
    throw new UnsafeWorktreeRemoval(`refusing to remove "${target}" - it is not a direct child of ${worktreesRoot}`);
  }
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) throw new UnsafeWorktreeRemoval(`refusing to remove "${target}" - it is a symlink`);
  if (hasGitEntry(worktreesRoot, slug)) throw new UnsafeWorktreeRemoval(`refusing to remove "${target}" - it has a .git entry, so it is a live worktree`);
  if (!isStillOrphaned(slug)) throw new UnsafeWorktreeRemoval(`refusing to remove "${target}" - a session now holds that slug`);
  rmSync(target, { recursive: true, force: true });
}

/**
 * The control-topic report. Names every orphan, separates the two classes, and says plainly which
 * ones the button will and will not touch - a card that offers "delete 9" and silently skips 2 is
 * the same class of lie this whole area keeps producing.
 */
export function renderOrphanWorktreeReport(worktreesRoot: string, orphans: readonly OrphanWorktree[]): string {
  const removable = orphans.filter((o) => o.removable).map((o) => o.slug);
  const kept = orphans.filter((o) => !o.removable).map((o) => o.slug);
  const lines = [
    `🧹 ${orphans.length} director${orphans.length === 1 ? "y" : "ies"} under ${worktreesRoot} ${orphans.length === 1 ? "has" : "have"} no session behind ${orphans.length === 1 ? "it" : "them"}.`,
  ];
  if (removable.length > 0) {
    lines.push("", `Left over from a /rm that could not delete its worktree (no .git entry, so nothing is using them): ${removable.join(", ")}`);
  }
  if (kept.length > 0) {
    lines.push("", `These have a .git entry, so they are real worktrees of something - reported only, and the button below will not touch them: ${kept.join(", ")}`);
  }
  return lines.join("\n");
}
