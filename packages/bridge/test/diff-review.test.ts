import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDiffReview, cleanupDiffRefs } from "../src/diff-review.ts";

/**
 * A local bare repo stands in for GitHub's actual server (no network in CI), but `origin`'s
 * configured URL is a real `github.com` string, rewritten transparently to the local bare path via
 * `url.<bare>.insteadOf` - `git remote get-url origin` (what `parseGithubOwnerRepo` reads) returns the
 * github.com string untouched, while an actual `git push`/`git branch -r` silently goes to the local
 * bare repo. This exercises the real "link" happy path end to end without any real GitHub access.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let bareDir: string;
let workDir: string;

beforeEach(() => {
  bareDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-diff-review-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bareDir, stdio: "pipe" });

  workDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-diff-review-work-"));
  git(workDir, ["init", "-b", "main"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  git(workDir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(workDir, "README.md"), "hello\n");
  git(workDir, ["add", "README.md"]);
  git(workDir, ["commit", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", "https://github.com/testowner/testrepo.git"]);
  const bareUrl = `file://${bareDir.split(path.sep).join("/")}`;
  git(workDir, ["config", `url.${bareUrl}.insteadOf`, "https://github.com/testowner/testrepo.git"]);
});

afterEach(() => {
  rmSync(bareDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function bareBranches(): string[] {
  const out = execFileSync("git", ["-C", bareDir, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("buildDiffReview - no changes", () => {
  test("no tracked or untracked changes -> kind empty, no push attempted", () => {
    const result = buildDiffReview(workDir, "test-slug");
    expect(result).toEqual({ kind: "empty", filesChanged: 0, untrackedFiles: [] });
    expect(bareBranches()).toEqual([]);
  });

  test("untracked-only -> kind empty with untrackedFiles populated, no push attempted", () => {
    writeFileSync(path.join(workDir, "new-file.txt"), "brand new\n");
    const result = buildDiffReview(workDir, "test-slug");
    expect(result.kind).toBe("empty");
    expect(result.untrackedFiles).toEqual(["new-file.txt"]);
    expect(bareBranches()).toEqual([]);
  });
});

describe("buildDiffReview - link happy path", () => {
  test("HEAD already pushed to a remote branch -> reuses it as base, only pushes a throwaway -head branch", () => {
    git(workDir, ["push", "origin", "main"]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");

    const result = buildDiffReview(workDir, "test-slug");

    expect(result.kind).toBe("link");
    expect(result.filesChanged).toBe(1);
    expect(result.url).toBe("https://github.com/testowner/testrepo/compare/main...aibridge-review/test-slug-head");
    expect(bareBranches().sort()).toEqual(["aibridge-review/test-slug-head", "main"]);
  });

  test("nothing pushed yet -> pushes both a throwaway base and head branch", () => {
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");

    const result = buildDiffReview(workDir, "test-slug");

    expect(result.kind).toBe("link");
    expect(result.url).toBe("https://github.com/testowner/testrepo/compare/aibridge-review/test-slug-base...aibridge-review/test-slug-head");
    expect(bareBranches().sort()).toEqual(["aibridge-review/test-slug-base", "aibridge-review/test-slug-head"]);
  });

  test("includes an untracked-file caveat alongside a real link", () => {
    git(workDir, ["push", "origin", "main"]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");
    writeFileSync(path.join(workDir, "new-file.txt"), "brand new\n");

    const result = buildDiffReview(workDir, "test-slug");

    expect(result.kind).toBe("link");
    expect(result.untrackedFiles).toEqual(["new-file.txt"]);
  });

  test("git stash create leaves the working tree and index exactly as found", () => {
    git(workDir, ["push", "origin", "main"]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");
    const before = git(workDir, ["status", "--porcelain"]);

    buildDiffReview(workDir, "test-slug");

    const after = git(workDir, ["status", "--porcelain"]);
    expect(after).toBe(before);
  });
});

describe("buildDiffReview - fallback to a scrubbed document", () => {
  test("no github.com remote -> falls back to a document", () => {
    git(workDir, ["remote", "set-url", "origin", `file://${bareDir.split(path.sep).join("/")}`]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");

    const result = buildDiffReview(workDir, "test-slug");

    expect(result.kind).toBe("document");
    expect(result.diffText).toContain("README.md");
  });

  test("push failure -> falls back to a document, not an error", () => {
    // Remove the insteadOf rewrite - the configured origin URL is a real, unreachable github.com
    // host now, so the push genuinely fails rather than silently going anywhere.
    git(workDir, ["config", "--remove-section", `url.file://${bareDir.split(path.sep).join("/")}`]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");

    const result = buildDiffReview(workDir, "test-slug");

    expect(result.kind).toBe("document");
  });

  test("a secret in the diff is redacted before being returned", () => {
    git(workDir, ["config", "--remove-section", `url.file://${bareDir.split(path.sep).join("/")}`]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nAKIAABCDEFGHIJKLMNOP\n");

    const result = buildDiffReview(workDir, "test-slug");

    expect(result.kind).toBe("document");
    expect(result.diffText).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.diffText).toContain("[redacted:");
  });
});

describe("cleanupDiffRefs", () => {
  test("swallows errors when no refs were ever pushed", () => {
    expect(() => cleanupDiffRefs(workDir, "never-used-slug")).not.toThrow();
  });

  test("deletes throwaway branches without touching a reused real branch", () => {
    git(workDir, ["push", "origin", "main"]);
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");
    buildDiffReview(workDir, "test-slug");
    expect(bareBranches().sort()).toEqual(["aibridge-review/test-slug-head", "main"]);

    cleanupDiffRefs(workDir, "test-slug");

    expect(bareBranches().sort()).toEqual(["main"]);
  });

  test("deletes both throwaway branches when both were pushed", () => {
    writeFileSync(path.join(workDir, "README.md"), "hello\nchanged\n");
    buildDiffReview(workDir, "test-slug");
    expect(bareBranches().sort()).toEqual(["aibridge-review/test-slug-base", "aibridge-review/test-slug-head"]);

    cleanupDiffRefs(workDir, "test-slug");

    expect(bareBranches()).toEqual([]);
  });
});
