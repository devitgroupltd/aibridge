import { describe, expect, test } from "bun:test";
import { ORPHAN_TOPIC_NOTE, orphanWorktreeNote, renderBulkRemoveNotes, renderRemoveConfirmation } from "../src/remove-outcome.ts";

const WT = "c:\\data\\worktrees\\fix-bug";

describe("renderRemoveConfirmation", () => {
  test("both steps succeeded", () => {
    const text = renderRemoveConfirmation("fix-bug", WT, { topicDeleted: true, worktreeRemoved: true });
    expect(text).toBe('Removed "fix-bug" - worktree and topic deleted.');
  });

  // The whole point. This message used to read "worktree and topic deleted." unconditionally, with a
  // note appended only for the topic - so nine `/rm`s reported a worktree deletion that had not
  // happened, and the only trace was a WARN in bridge.log.
  test("a failed worktree removal is never described as deleted, and the path is named", () => {
    const text = renderRemoveConfirmation("fix-bug", WT, { topicDeleted: true, worktreeRemoved: false });
    expect(text).toBe(`Removed "fix-bug" - topic deleted.${orphanWorktreeNote(WT)}`);
    expect(text).not.toContain("worktree and topic deleted");
    // The path is the entire content of the recovery: nothing in aibridge retries this, and once the
    // row is gone the operator cannot get from the slug back to the directory.
    expect(text).toContain(WT);
  });

  test("a failed topic delete still reports the worktree that did go", () => {
    const text = renderRemoveConfirmation("fix-bug", WT, { topicDeleted: false, worktreeRemoved: true });
    expect(text).toBe(`Removed "fix-bug" - worktree deleted.${ORPHAN_TOPIC_NOTE}`);
    expect(text).not.toContain("still on disk");
  });

  // Both failing is the case where the old wording was furthest from the truth: it claimed two
  // deletions, neither of which happened, and mentioned only one of them as a caveat.
  test("both failing claims nothing, and carries both notes", () => {
    const text = renderRemoveConfirmation("fix-bug", WT, { topicDeleted: false, worktreeRemoved: false });
    expect(text).toContain("nothing on disk or in Telegram could be cleaned up");
    expect(text).toContain(ORPHAN_TOPIC_NOTE.trim());
    expect(text).toContain(WT);
    expect(text).not.toContain("deleted.");
  });
});

describe("renderBulkRemoveNotes", () => {
  test("a clean bulk run adds nothing at all", () => {
    expect(renderBulkRemoveNotes(false, [])).toBe("");
  });

  test("topics only", () => {
    expect(renderBulkRemoveNotes(true, [])).toBe(ORPHAN_TOPIC_NOTE);
  });

  // Slugs rather than full paths, because every worktree lives at `<worktreesRoot>/<slug>` and a
  // dozen absolute Windows paths on a phone is the kind of wall of text that gets skimmed - which is
  // how the WARN this replaces got missed in the first place.
  test("worktrees are named by slug, and the grammar follows the count", () => {
    expect(renderBulkRemoveNotes(false, ["a"])).toContain("1 worktree could not be deleted and is still on disk (a) - remove it by hand.");
    expect(renderBulkRemoveNotes(false, ["a", "b", "c"])).toContain("3 worktrees could not be deleted and are still on disk (a, b, c) - remove them by hand.");
  });

  test("both halves appear together when both failed", () => {
    const text = renderBulkRemoveNotes(true, ["a"]);
    expect(text).toContain(ORPHAN_TOPIC_NOTE.trim());
    expect(text).toContain("still on disk (a)");
  });
});
