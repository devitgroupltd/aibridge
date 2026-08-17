import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyOrphanWorktrees,
  hasGitEntry,
  isSafeWorktreeSlug,
  listWorktreeDirs,
  removeOrphanWorktree,
  renderOrphanWorktreeReport,
  UnsafeWorktreeRemoval,
} from "../src/orphan-worktrees.ts";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aibridge-orphan-wt-"));
}

/** A directory under `root`, optionally carrying the `.git` entry that marks a live worktree. */
function dir(root: string, name: string, opts: { git?: boolean; file?: boolean } = {}): string {
  const target = path.join(root, name);
  mkdirSync(target, { recursive: true });
  if (opts.git) writeFileSync(path.join(target, ".git"), "gitdir: ../repo/.git/worktrees/x");
  if (opts.file) writeFileSync(path.join(target, "work.txt"), "some work");
  return target;
}

const alwaysOrphaned = () => true;

describe("classifyOrphanWorktrees", () => {
  test("a directory whose slug still has a row is not an orphan at all", () => {
    const orphans = classifyOrphanWorktrees({ dirNames: ["live-one", "left-behind"], knownSlugs: ["live-one"], hasGitEntry: () => false });
    expect(orphans.map((o) => o.slug)).toEqual(["left-behind"]);
  });

  // The discriminator the whole feature turns on. A `.git` entry means a live worktree of *something*
  // - possibly one the operator cut by hand under the same root - and the 2026-08-17 failure removed
  // exactly that entry while leaving the tree, which is why its absence is the safe signal.
  test("only a directory with no .git entry is marked removable", () => {
    const orphans = classifyOrphanWorktrees({
      dirNames: ["half-removed", "someones-own-worktree"],
      knownSlugs: [],
      hasGitEntry: (name) => name === "someones-own-worktree",
    });
    expect(orphans).toEqual([
      { slug: "half-removed", removable: true },
      { slug: "someones-own-worktree", removable: false },
    ]);
  });

  test("a clean tree produces nothing", () => {
    expect(classifyOrphanWorktrees({ dirNames: ["a", "b"], knownSlugs: ["a", "b"], hasGitEntry: () => false })).toEqual([]);
  });
});

describe("listWorktreeDirs / hasGitEntry", () => {
  test("lists child directories and sees a .git entry", () => {
    const root = tempRoot();
    dir(root, "with-git", { git: true });
    dir(root, "without-git");
    writeFileSync(path.join(root, "loose-file.txt"), "not a directory");

    expect(listWorktreeDirs(root).sort()).toEqual(["with-git", "without-git"]);
    expect(hasGitEntry(root, "with-git")).toBe(true);
    expect(hasGitEntry(root, "without-git")).toBe(false);
  });

  // A Bridge that has never created a session has no worktrees root, and that is not an error - the
  // scan runs on every boot, including the very first.
  test("a missing root is empty rather than a throw", () => {
    expect(listWorktreeDirs(path.join(tempRoot(), "never-created"))).toEqual([]);
  });
});

describe("removeOrphanWorktree", () => {
  test("removes an orphaned directory and everything in it", () => {
    const root = tempRoot();
    const target = dir(root, "half-removed", { file: true });
    removeOrphanWorktree(root, "half-removed", alwaysOrphaned);
    expect(existsSync(target)).toBe(false);
  });

  test("an already-gone directory is a no-op, not a throw", () => {
    const root = tempRoot();
    expect(() => removeOrphanWorktree(root, "never-existed", alwaysOrphaned)).not.toThrow();
  });

  // Every guard below is re-checked at deletion time rather than inherited from whatever posted the
  // card, because this is the only place in aibridge that recursively deletes a directory it did not
  // create, and the card's payload has made a round trip through Telegram.

  test("refuses a slug that could escape the worktrees root", () => {
    const root = tempRoot();
    for (const slug of ["..", "../..", "a/b", "a\\b", "C:\\Windows", "/etc", ".hidden", ""]) {
      expect(() => removeOrphanWorktree(root, slug, alwaysOrphaned)).toThrow(UnsafeWorktreeRemoval);
    }
  });

  // The card can be minutes old, and `/new` readopts an existing directory (`ensureWorktree`), so
  // between posting and tapping this can have become a live session's checkout.
  test("refuses a directory that has grown a .git entry since the card was posted", () => {
    const root = tempRoot();
    const target = dir(root, "readopted", { git: true, file: true });
    expect(() => removeOrphanWorktree(root, "readopted", alwaysOrphaned)).toThrow(/\.git entry/);
    expect(existsSync(target)).toBe(true);
  });

  test("refuses when a session now holds that slug", () => {
    const root = tempRoot();
    const target = dir(root, "reclaimed", { file: true });
    expect(() => removeOrphanWorktree(root, "reclaimed", () => false)).toThrow(/a session now holds/);
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a symlink rather than guessing at what someone meant by it", () => {
    const root = tempRoot();
    const real = dir(root, "real-dir", { file: true });
    try {
      symlinkSync(real, path.join(root, "link-to-dir"), "junction");
    } catch {
      return; // symlink/junction creation can need privileges - skip rather than fail on that
    }
    expect(() => removeOrphanWorktree(root, "link-to-dir", alwaysOrphaned)).toThrow(/symlink/);
    expect(existsSync(real)).toBe(true);
  });
});

describe("isSafeWorktreeSlug", () => {
  test("accepts the shape slug.ts produces and rejects anything that could traverse", () => {
    for (const good of ["fix-bug", "seowrite-guardrail-check-244341-reply", "a", "a.b_c-1"]) expect(isSafeWorktreeSlug(good)).toBe(true);
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "C:\\x", "-leading-dash", ".hidden"]) expect(isSafeWorktreeSlug(bad)).toBe(false);
  });
});

describe("renderOrphanWorktreeReport", () => {
  test("separates what the button will delete from what it will not touch", () => {
    const text = renderOrphanWorktreeReport("c:\\data\\worktrees", [
      { slug: "half-removed", removable: true },
      { slug: "someones-own", removable: false },
    ]);
    expect(text).toContain("c:\\data\\worktrees");
    expect(text).toContain("half-removed");
    expect(text).toContain("will not touch them: someones-own");
  });

  // A card that offers "delete 2" and silently skips one is the same class of lie the rest of this
  // day's work was about.
  test("says nothing about a removable group when there is none", () => {
    const text = renderOrphanWorktreeReport("c:\\data\\worktrees", [{ slug: "someones-own", removable: false }]);
    expect(text).not.toContain("no .git entry");
    expect(text).toContain("will not touch them");
  });

  test("singular and plural both read correctly", () => {
    expect(renderOrphanWorktreeReport("c:\\wt", [{ slug: "a", removable: true }])).toContain("1 directory under c:\\wt has no session behind it");
    expect(
      renderOrphanWorktreeReport("c:\\wt", [
        { slug: "a", removable: true },
        { slug: "b", removable: true },
      ]),
    ).toContain("2 directories under c:\\wt have no session behind them");
  });
});
