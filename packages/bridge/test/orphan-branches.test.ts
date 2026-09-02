import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyOrphanBranches,
  listSessionBranches,
  removeOrphanBranch,
  renderOrphanBranchReport,
  resolveBaseRef,
  sessionBranchSlug,
  UnsafeBranchRemoval,
  type SessionBranchInfo,
} from "../src/orphan-branches.ts";

const info = (over: Partial<SessionBranchInfo> & { branch: string }): SessionBranchInfo => ({
  worktreePath: "",
  lastCommitDate: "2026-08-01",
  merged: false,
  ahead: 1,
  ...over,
});

describe("sessionBranchSlug", () => {
  test("reads the slug out of a session branch", () => {
    expect(sessionBranchSlug("claude/fix-bug-1")).toBe("fix-bug");
    expect(sessionBranchSlug("claude/fix-bug-12")).toBe("fix-bug");
    // `nextFreeBranch` only ever appends to the stem, so the *last* -<digits> is the id and any
    // earlier one is part of the slug.
    expect(sessionBranchSlug("claude/round-2-retry-3")).toBe("round-2-retry");
  });

  // The predicate that decides what this module may delete at all, so every near miss matters.
  test("rejects anything that is not aibridge's own branch shape", () => {
    for (const branch of ["main", "claude/no-id", "claude/", "feature/claude/x-1", "xclaude/fix-1", "claude/fix-1x"]) {
      expect(sessionBranchSlug(branch)).toBeUndefined();
    }
  });
});

describe("classifyOrphanBranches", () => {
  test("a session branch with no row and no worktree is an orphan", () => {
    const orphans = classifyOrphanBranches({ branches: [info({ branch: "claude/gone-1" })], knownSlugs: [] });
    expect(orphans).toEqual([{ branch: "claude/gone-1", slug: "gone", lastCommitDate: "2026-08-01", ahead: 1, removable: false }]);
  });

  test("only merged branches are marked removable", () => {
    const orphans = classifyOrphanBranches({
      branches: [info({ branch: "claude/merged-1", merged: true, ahead: 0 }), info({ branch: "claude/unmerged-1", merged: false, ahead: 3 })],
      knownSlugs: [],
    });
    expect(orphans.map((o) => [o.branch, o.removable])).toEqual([
      ["claude/merged-1", true],
      ["claude/unmerged-1", false],
    ]);
  });

  test("a branch checked out somewhere is live, however merged it looks", () => {
    const orphans = classifyOrphanBranches({
      branches: [info({ branch: "claude/live-1", merged: true, worktreePath: "C:\\data\\worktrees\\live" })],
      knownSlugs: [],
    });
    expect(orphans).toEqual([]);
  });

  test("a branch whose slug still has a session row belongs to that session", () => {
    const orphans = classifyOrphanBranches({ branches: [info({ branch: "claude/alive-1", merged: true })], knownSlugs: ["alive"] });
    expect(orphans).toEqual([]);
  });

  // Deliberately conservative, and the reason is in the doc comment: a live session on `-2` means
  // `-1` is that same session's earlier work, not debris.
  test("an earlier id is left alone while a live session holds the same slug on a later one", () => {
    const orphans = classifyOrphanBranches({ branches: [info({ branch: "claude/retry-1", merged: true })], knownSlugs: ["retry"] });
    expect(orphans).toEqual([]);
  });

  test("branches aibridge did not create are not listed at all", () => {
    const orphans = classifyOrphanBranches({ branches: [info({ branch: "main", merged: true }), info({ branch: "feature/x", merged: true })], knownSlugs: [] });
    expect(orphans).toEqual([]);
  });
});

describe("renderOrphanBranchReport", () => {
  test("separates what will be deleted from what is only reported, with ages and commit counts", () => {
    const text = renderOrphanBranchReport("aibridge", [
      { branch: "claude/keep-1", slug: "keep", lastCommitDate: "2026-08-06", ahead: 3, removable: false },
      { branch: "claude/drop-1", slug: "drop", lastCommitDate: "2026-08-14", ahead: 0, removable: true },
    ]);
    expect(text).toContain("2 session branches");
    expect(text).toContain("claude/keep-1 (3 commits, 2026-08-06)");
    expect(text).toContain("claude/drop-1 (0 commits, 2026-08-14)");
    expect(text).toContain("nothing here will delete them");
  });

  test("says so plainly when the base could not be resolved rather than printing a count it does not have", () => {
    const text = renderOrphanBranchReport("aibridge", [{ branch: "claude/x-1", slug: "x", lastCommitDate: "2026-08-06", ahead: undefined, removable: false }]);
    expect(text).toContain("base unknown");
    expect(text).not.toContain("undefined");
  });

  test("singular wording for one branch", () => {
    const text = renderOrphanBranchReport("aibridge", [{ branch: "claude/x-1", slug: "x", lastCommitDate: "2026-08-06", ahead: 1, removable: false }]);
    expect(text).toContain("1 session branch in \"aibridge\" has no session behind it");
    expect(text).toContain("1 commit,");
  });
});

// The git-facing half. Everything below runs against a real repo, because the failure modes worth
// catching here are all "git said something slightly different than assumed" - the exact thing a
// mocked git cannot catch.
describe("against a real repo", () => {
  let repoDir: string;
  let worktreesDir: string;

  const git = (args: string[], cwd = repoDir) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  const commit = (file: string, body: string) => {
    writeFileSync(path.join(repoDir, file), body);
    git(["add", file]);
    git(["commit", "-m", `add ${file}`]);
  };

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-branches-repo-"));
    worktreesDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-branches-wt-"));
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    commit("README.md", "hello\n");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  });

  describe("resolveBaseRef", () => {
    test("prefers the configured base, then main, then master", () => {
      expect(resolveBaseRef(repoDir, undefined)).toBe("main");
      git(["branch", "release"]);
      expect(resolveBaseRef(repoDir, "release")).toBe("release");
    });

    // Fail-closed: an unresolvable base makes every branch report as unmerged, so nothing is ever
    // offered for deletion against a base that was never checked.
    test("returns undefined when the configured base does not exist and neither main nor master do", () => {
      git(["branch", "-m", "main", "trunk"]);
      expect(resolveBaseRef(repoDir, "nope")).toBeUndefined();
    });
  });

  describe("listSessionBranches", () => {
    test("reports merged, ahead count and checked-out path for each claude/ branch", () => {
      git(["branch", "claude/merged-1"]);
      git(["checkout", "-q", "claude/merged-1"]);
      commit("a.txt", "a\n");
      git(["checkout", "-q", "main"]);
      git(["merge", "-q", "--no-ff", "-m", "merge", "claude/merged-1"]);

      git(["checkout", "-q", "-b", "claude/unmerged-1"]);
      commit("b.txt", "b\n");
      git(["checkout", "-q", "main"]);

      const infos = listSessionBranches(repoDir);
      const byName = new Map(infos.map((i) => [i.branch, i]));
      expect(byName.get("claude/merged-1")).toMatchObject({ merged: true, ahead: 0, worktreePath: "" });
      expect(byName.get("claude/unmerged-1")).toMatchObject({ merged: false, ahead: 1, worktreePath: "" });
      expect(byName.get("claude/merged-1")!.lastCommitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("a branch checked out in a worktree reports that worktree's path", () => {
      const wt = path.join(worktreesDir, "live");
      git(["worktree", "add", wt, "-b", "claude/live-1"]);
      const infos = listSessionBranches(repoDir);
      expect(infos.find((i) => i.branch === "claude/live-1")!.worktreePath).not.toBe("");
    });

    test("non-claude branches are not returned", () => {
      git(["branch", "feature/x"]);
      expect(listSessionBranches(repoDir).map((i) => i.branch)).not.toContain("feature/x");
    });

    test("an unresolvable base leaves ahead undefined rather than guessing zero", () => {
      git(["branch", "claude/x-1"]);
      git(["branch", "-m", "main", "trunk"]);
      const found = listSessionBranches(repoDir, "nope").find((i) => i.branch === "claude/x-1")!;
      expect(found.merged).toBe(false);
      expect(found.ahead).toBeUndefined();
    });

    test("a path that is not a git repo yields nothing instead of throwing", () => {
      expect(listSessionBranches(worktreesDir)).toEqual([]);
    });
  });

  describe("removeOrphanBranch", () => {
    const alwaysOrphaned = () => true;

    test("deletes a merged session branch", () => {
      git(["branch", "claude/merged-1"]);
      removeOrphanBranch(repoDir, "claude/merged-1", alwaysOrphaned);
      expect(git(["branch", "--list", "claude/merged-1"]).trim()).toBe("");
    });

    // The guard that matters most, and the one that holds even if every check above it were wrong:
    // `git branch -d`, never `-D`.
    test("refuses a branch holding commits the base does not have, and leaves it intact", () => {
      git(["checkout", "-q", "-b", "claude/work-1"]);
      commit("work.txt", "work\n");
      git(["checkout", "-q", "main"]);
      expect(() => removeOrphanBranch(repoDir, "claude/work-1", alwaysOrphaned)).toThrow(UnsafeBranchRemoval);
      expect(git(["branch", "--list", "claude/work-1"])).toContain("claude/work-1");
    });

    test("refuses anything that is not a claude/<slug>-<id> branch", () => {
      expect(() => removeOrphanBranch(repoDir, "main", alwaysOrphaned)).toThrow(UnsafeBranchRemoval);
      expect(git(["branch", "--list", "main"])).toContain("main");
    });

    // A tapped card is minutes old and has round-tripped through Telegram, so both of the
    // "is it still an orphan" questions get asked again here rather than trusted.
    test("refuses a branch that is checked out in a worktree now", () => {
      const wt = path.join(worktreesDir, "live");
      git(["worktree", "add", wt, "-b", "claude/live-1"]);
      // Matches this module's own refusal, not merely "something threw": git's `-d` also refuses a
      // checked-out branch, and its message contains the words "checked out" too - so a looser
      // pattern here would pass with the guard deleted, which is the whole failure mode this file
      // keeps having to design against.
      expect(() => removeOrphanBranch(repoDir, "claude/live-1", alwaysOrphaned)).toThrow(/refusing to delete "claude\/live-1" - it is checked out at/);
      expect(git(["branch", "--list", "claude/live-1"])).toContain("claude/live-1");
    });

    test("refuses when a session has claimed the slug since the card was posted", () => {
      git(["branch", "claude/reclaimed-1"]);
      expect(() => removeOrphanBranch(repoDir, "claude/reclaimed-1", (slug) => slug !== "reclaimed")).toThrow(/now holds the slug/);
      expect(git(["branch", "--list", "claude/reclaimed-1"])).toContain("claude/reclaimed-1");
    });

    test("a branch that no longer exists throws rather than reporting a deletion that did not happen", () => {
      expect(() => removeOrphanBranch(repoDir, "claude/never-1", alwaysOrphaned)).toThrow(/no such branch/);
    });
  });
});
