/**
 * What `/rm` actually managed to delete, and how it is reported.
 *
 * `removeSessionRow` has two independent teardown steps that can each fail without stopping the
 * other, because the DB row must go either way (§4.5.2 - a Telegram-side failure must not leave a
 * zombie row behind, and a worktree git could not delete must not wedge the slug forever). Until
 * 2026-08-17 only one of them was reported: a failed `deleteForumTopic` appended `ORPHAN_TOPIC_NOTE`,
 * while a failed `removeWorktree` produced a `WARN` in `bridge.log` and nothing else - and the
 * operator was told, verbatim, `Removed "<slug>" - worktree and topic deleted.`
 *
 * That message is simply false when the removal failed, and the failure is not hypothetical:
 * `worktree.ts`'s own doc comment documents the Windows file-lock race it retries for (the killed
 * `claude.exe`'s handles are released asynchronously, so `git worktree remove` loses to them), and
 * `ensureWorktree` documents what a leftover directory then does to the *next* `/new` handed that
 * slug. Found by counting the debris: nine orphaned directories under `c:\data\worktrees`, each a
 * full source tree with its `.git` file gone, every one of them from a `/rm` that had reported a
 * clean deletion. The sibling teardown path in `abandonHalfBuiltSession` had this right already -
 * it tells the operator to remove the directory by hand - which is what made the omission here look
 * like an oversight rather than a decision.
 *
 * So the message is built from what happened rather than asserted up front. This is a pure function
 * for the reason §9 gives: its failure mode is a plausible-looking wrong answer, not a crash.
 */

export interface RemoveSessionRowResult {
  /** The Telegram topic itself was deleted. `false` leaves an orphan topic with no row behind it -
   * §4.5.2's `rm-topic` confirm is the recovery. */
  topicDeleted: boolean;
  /** `git worktree remove --force` succeeded (or there was nothing there to remove). `false` means
   * the directory is still on disk, unregistered, and will be in the way of the next `/new` that is
   * handed this slug. */
  worktreeRemoved: boolean;
}

/** §4.5.2's note appended whenever `deleteForumTopic` failed - without this the operator only finds
 * out days later, by eye, that a topic was left behind (as happened live: two such orphans had
 * accumulated with nothing pointing at them). Naming `/remove` explicitly rather than describing the
 * fix, since that is the exact recovery step (the `rm-topic` confirm, keyed off the orphaned topic's
 * own thread id). */
export const ORPHAN_TOPIC_NOTE = " (Telegram topic itself could not be deleted - send /remove inside it directly to clean it up)";

/** The worktree half. Names the path because that is the whole content of the recovery - there is no
 * command inside aibridge that retries this, and the operator cannot find the directory from the slug
 * alone once the row is gone. */
export function orphanWorktreeNote(worktreePath: string): string {
  return ` Its worktree could not be deleted - ${worktreePath} is still on disk, remove it by hand.`;
}

/**
 * The single-slug `/rm` confirmation. The leading clause lists only what was really deleted, so the
 * sentence stays true in all four combinations rather than being contradicted by a note two clauses
 * later.
 */
export function renderRemoveConfirmation(slug: string, worktreePath: string, result: RemoveSessionRowResult): string {
  const deleted = [result.worktreeRemoved ? "worktree" : null, result.topicDeleted ? "topic" : null].filter(Boolean);
  const head = deleted.length > 0 ? `Removed "${slug}" - ${deleted.join(" and ")} deleted.` : `Removed "${slug}" from the fleet, but nothing on disk or in Telegram could be cleaned up.`;
  return head + (result.topicDeleted ? "" : ORPHAN_TOPIC_NOTE) + (result.worktreeRemoved ? "" : orphanWorktreeNote(worktreePath));
}

/**
 * The bulk (`--dead`/`--prefix`) form's tail. Deliberately a count plus the failed slugs rather than
 * `orphanWorktreeNote` per row: a bulk `/rm` can cover a dozen sessions, and a dozen full paths on a
 * phone is the kind of wall of text that gets skimmed past - which is the same way the `WARN` this
 * replaces got missed. The slugs are enough to find the directories, since every worktree path is
 * `<worktreesRoot>/<slug>`.
 */
export function renderBulkRemoveNotes(failedTopics: boolean, failedWorktreeSlugs: readonly string[]): string {
  const n = failedWorktreeSlugs.length;
  if (n === 0) return failedTopics ? ORPHAN_TOPIC_NOTE : "";
  const one = n === 1;
  const worktrees = `${n} worktree${one ? "" : "s"} could not be deleted and ${one ? "is" : "are"} still on disk (${failedWorktreeSlugs.join(", ")}) - remove ${one ? "it" : "them"} by hand.`;
  return (failedTopics ? ORPHAN_TOPIC_NOTE : "") + ` ${worktrees}`;
}
