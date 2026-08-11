import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner, DeployMarker } from "../src/deploy.ts";
import {
  clearDeployMarker,
  commitIfDirty,
  deployBranch,
  deployMarkerPath,
  discoverTypecheckedPackages,
  foundNoTests,
  DEPLOY_CRASH_LOOP_THRESHOLD_MS,
  isDeployMarkerStale,
  isSelfRepo,
  pushCurrentBranch,
  readDeployMarker,
  resolveBridgeRepoRoot,
  rollbackStaleDeploy,
  runGate,
  truncateForTelegram,
  writeDeployMarker,
} from "../src/deploy.ts";

const OK: CommandResult = { status: 0, stdout: "", stderr: "" };

/** A scripted runner: replays canned results in call order and records every (cmd, args, cwd)
 * triple it was asked to run, so tests can assert both the outcome and exactly what would have
 * been executed - without a real git repo or a real `bun test` invocation. */
function scriptedRunner(results: readonly CommandResult[]): { run: CommandRunner; calls: [string, string[], string][] } {
  const calls: [string, string[], string][] = [];
  let i = 0;
  const run: CommandRunner = async (cmd, args, cwd) => {
    calls.push([cmd, args, cwd]);
    const result = results[i] ?? OK;
    i++;
    return result;
  };
  return { run, calls };
}

describe("resolveBridgeRepoRoot", () => {
  test("resolves three directories up from a packages/bridge/src-shaped module dir", () => {
    expect(resolveBridgeRepoRoot(path.join("C:", "data", "projects", "aibridge", "packages", "bridge", "src"))).toBe(
      path.resolve(path.join("C:", "data", "projects", "aibridge")),
    );
  });
});

describe("isSelfRepo", () => {
  test("true for the exact same path, even with different casing/slashes", () => {
    expect(isSelfRepo("c:\\data\\projects\\aibridge", "C:/data/projects/aibridge")).toBe(true);
  });

  test("false for a different repo", () => {
    expect(isSelfRepo("c:\\data\\projects\\seowrite", "C:/data/projects/aibridge")).toBe(false);
  });
});

describe("discoverTypecheckedPackages", () => {
  test("finds only package dirs declaring a typecheck script, ignoring files and package-less dirs", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-deploy-test-"));
    try {
      await fs.mkdir(path.join(repoRoot, "packages", "has-typecheck"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, "packages", "has-typecheck", "package.json"),
        JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
      );
      await fs.mkdir(path.join(repoRoot, "packages", "no-typecheck"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, "packages", "no-typecheck", "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await fs.mkdir(path.join(repoRoot, "packages", "no-package-json"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, "packages", "stray-file.txt"), "not a directory");

      const found = discoverTypecheckedPackages(repoRoot);
      expect(found).toEqual([path.join(repoRoot, "packages", "has-typecheck")]);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns an empty list when there's no packages/ directory at all", () => {
    expect(discoverTypecheckedPackages(path.join(os.tmpdir(), "definitely-does-not-exist-aibridge"))).toEqual([]);
  });
});

describe("runGate", () => {
  test("passes through bun test then each package's typecheck, in order", async () => {
    const { run, calls } = scriptedRunner([OK, OK, OK]);
    const result = await runGate("C:\\repo", ["C:\\repo\\packages\\a", "C:\\repo\\packages\\b"], run);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["bun", ["test"], "C:\\repo"],
      ["bun", ["run", "typecheck"], "C:\\repo\\packages\\a"],
      ["bun", ["run", "typecheck"], "C:\\repo\\packages\\b"],
    ]);
  });

  test("stops at bun test failing - never runs any typecheck", async () => {
    const { run, calls } = scriptedRunner([{ status: 1, stdout: "1 fail", stderr: "" }]);
    const result = await runGate("C:\\repo", ["C:\\repo\\packages\\a"], run);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("1 fail");
    expect(calls).toHaveLength(1);
  });

  test("stops at the first package's typecheck failing - never runs the second", async () => {
    const { run, calls } = scriptedRunner([OK, { status: 2, stdout: "", stderr: "type error" }, OK]);
    const result = await runGate("C:\\repo", ["C:\\repo\\packages\\a", "C:\\repo\\packages\\b"], run);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("type error");
    expect(calls).toHaveLength(2);
  });

  /**
   * §7.5 allows registering *any* repo, so `/deploy` can land on one with no Bun tests at all. Verified
   * against the pinned toolchain that `bun test` with zero matching files exits **1**, so the gate
   * already refuses - the risk was never a false pass, only that bun's "0 test files matching ..."
   * reads as a tooling error rather than a verdict. This pins both halves: still a failure, and now it
   * says which kind.
   */
  test("a repo with no test files fails the gate, and the message says that's why", async () => {
    const { run } = scriptedRunner([{ status: 1, stdout: "", stderr: "error: 0 test files matching were found" }]);
    const result = await runGate("C:\\repo", ["C:\\repo\\packages\\a"], run);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no test files/i);
  });

  test("an ordinary test failure is not dressed up as a missing-tests message", async () => {
    const { run } = scriptedRunner([{ status: 1, stdout: "3 pass\n1 fail", stderr: "" }]);
    const result = await runGate("C:\\repo", [], run);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("1 fail");
    expect(result.output).not.toMatch(/no test files/i);
  });

  test("a repo with real tests and no typechecked packages passes", async () => {
    const { run } = scriptedRunner([{ status: 0, stdout: "42 pass\n0 fail", stderr: "" }]);
    const result = await runGate("C:\\repo", [], run);
    expect(result.ok).toBe(true);
  });
});

describe("foundNoTests", () => {
  test("recognises bun's own zero-test line on either stream", () => {
    expect(foundNoTests("", 'error: 0 test files matching "x" were found')).toBe(true);
    expect(foundNoTests("0 test file matching", "")).toBe(true);
  });

  test("does not fire on a real run", () => {
    expect(foundNoTests("42 pass\n0 fail", "")).toBe(false);
    expect(foundNoTests("", "")).toBe(false);
    // "0 fail" is not "0 test files".
    expect(foundNoTests("730 pass\n0 fail\nRan 730 tests across 59 files.", "")).toBe(false);
  });
});

describe("deployBranch", () => {
  test("refuses a dirty tree without touching git any further", async () => {
    const { run, calls } = scriptedRunner([{ status: 0, stdout: " M some/file.ts\n", stderr: "" }]);
    const outcome = await deployBranch("C:\\repo", "claude/fix-1", [], run);
    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.message).toContain("uncommitted changes");
    expect(calls).toHaveLength(1);
  });

  test("reports a branch that doesn't exist", async () => {
    const { run } = scriptedRunner([
      OK, // status --porcelain
      { status: 0, stdout: "abc1234\n", stderr: "" }, // rev-parse HEAD
      { status: 128, stdout: "", stderr: "unknown revision" }, // rev-parse --verify
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/nope", [], run);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Branch "claude/nope" not found');
  });

  test("reports a non-fast-forward branch and never resets anything (nothing was merged)", async () => {
    const { run, calls } = scriptedRunner([
      OK,
      { status: 0, stdout: "abc1234\n", stderr: "" },
      OK, // rev-parse --verify
      { status: 1, stdout: "", stderr: "not possible to fast-forward" },
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/diverged", [], run);
    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.message).toContain("isn't a fast-forward");
    expect(calls.some(([cmd, args]) => cmd === "git" && args[0] === "reset")).toBe(false);
  });

  test("with a worktreePath, auto-rebases a diverged branch and retries the merge", async () => {
    const { run, calls } = scriptedRunner([
      OK, // status
      { status: 0, stdout: "abc1234\n", stderr: "" }, // HEAD before
      OK, // verify
      { status: 1, stdout: "", stderr: "not possible to fast-forward" }, // merge #1 - diverged
      OK, // rebase abc1234 (in worktree)
      OK, // merge #2 - retried, now ff
      { status: 0, stdout: "def5678\n", stderr: "" }, // HEAD after
      OK, // bun test
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/diverged", [], run, "C:\\wt\\diverged");
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("Auto-rebased");
    expect(outcome.message).toContain("abc1234 -> def5678");
    expect(calls).toContainEqual(["git", ["rebase", "abc1234"], "C:\\wt\\diverged"]);
    expect(calls.filter(([cmd, args]) => cmd === "git" && args[0] === "merge")).toHaveLength(2);
  });

  test("with a worktreePath, aborts the rebase and reports conflicts without touching repoRoot", async () => {
    const { run, calls } = scriptedRunner([
      OK, // status
      { status: 0, stdout: "abc1234\n", stderr: "" }, // HEAD before
      OK, // verify
      { status: 1, stdout: "", stderr: "not possible to fast-forward" }, // merge #1 - diverged
      { status: 1, stdout: "", stderr: "CONFLICT" }, // rebase - conflicts
      OK, // rebase --abort
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/conflicted", [], run, "C:\\wt\\conflicted");
    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.conflict).toBe(true);
    expect(outcome.message).toContain("auto-rebase");
    expect(outcome.message).toContain("conflicts");
    // The raw git error (multi-line, not fit for the middle of a sentence) lives in `detail`,
    // separate from the human-readable `message` - see `formatOutcomeHtml` in
    // deploy-lifecycle-commands.ts for why.
    expect(outcome.detail).toBe("CONFLICT");
    expect(calls).toContainEqual(["git", ["rebase", "--abort"], "C:\\wt\\conflicted"]);
    expect(calls.some(([cmd, args]) => cmd === "git" && args[0] === "reset")).toBe(false);
  });

  test("with a worktreePath, still reports failure if the retried merge is also non-ff", async () => {
    const { run } = scriptedRunner([
      OK,
      { status: 0, stdout: "abc1234\n", stderr: "" },
      OK,
      { status: 1, stdout: "", stderr: "not possible to fast-forward" }, // merge #1
      OK, // rebase succeeds
      { status: 1, stdout: "", stderr: "still not possible" }, // merge #2 - still fails
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/still-stuck", [], run, "C:\\wt\\still-stuck");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("even after auto-rebasing");
  });

  test("reports nothing-to-deploy when the branch is already merged (HEAD unchanged)", async () => {
    const { run } = scriptedRunner([
      OK,
      { status: 0, stdout: "abc1234\n", stderr: "" },
      OK,
      OK, // merge --ff-only (no-op, already up to date)
      { status: 0, stdout: "abc1234\n", stderr: "" }, // rev-parse HEAD again - unchanged
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/already-in", [], run);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("already merged");
  });

  test("rolls back to the pre-merge commit when the gate fails after a real merge", async () => {
    const { run, calls } = scriptedRunner([
      OK, // status
      { status: 0, stdout: "abc1234\n", stderr: "" }, // HEAD before
      OK, // verify
      OK, // merge
      { status: 0, stdout: "def5678\n", stderr: "" }, // HEAD after
      { status: 1, stdout: "", stderr: "test failed" }, // bun test (via runGate)
      OK, // reset --hard
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/broken", [], run);
    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.previousHeadSha).toBe("abc1234");
    expect(outcome.message).toContain("rolled back to abc1234");
    expect(calls.at(-1)).toEqual(["git", ["reset", "--hard", "abc1234"], "C:\\repo"]);
  });

  test("succeeds end to end: merges, gate passes, no rollback", async () => {
    const { run } = scriptedRunner([
      OK, // status
      { status: 0, stdout: "abc1234\n", stderr: "" }, // HEAD before
      OK, // verify
      OK, // merge
      { status: 0, stdout: "def5678\n", stderr: "" }, // HEAD after
      OK, // bun test
    ]);
    const outcome = await deployBranch("C:\\repo", "claude/good-fix", [], run);
    expect(outcome.ok).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.previousHeadSha).toBe("abc1234");
    expect(outcome.newHeadSha).toBe("def5678");
    expect(outcome.message).toContain("abc1234 -> def5678");
  });
});

describe("commitIfDirty", () => {
  test("no-op on a clean worktree", async () => {
    const { run, calls } = scriptedRunner([OK]);
    const outcome = await commitIfDirty("C:\\wt\\session-1", run);
    expect(outcome.committed).toBe(false);
    expect(outcome.message).toContain("already clean");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["git", ["status", "--porcelain"], "C:\\wt\\session-1"]);
  });

  test("stages and commits everything when the worktree is dirty", async () => {
    const { run, calls } = scriptedRunner([
      { status: 0, stdout: " M some/file.ts\n", stderr: "" }, // status
      OK, // add -A
      OK, // commit
    ]);
    const outcome = await commitIfDirty("C:\\wt\\session-1", run);
    expect(outcome.committed).toBe(true);
    expect(outcome.message).toContain("Auto-committed");
    expect(calls[1]).toEqual(["git", ["add", "-A"], "C:\\wt\\session-1"]);
    expect(calls[2]?.[1]).toEqual(["commit", "-m", "chore: auto-commit uncommitted work for /ship"]);
  });

  test("reports a git status failure without attempting to commit", async () => {
    const { run, calls } = scriptedRunner([{ status: 128, stdout: "", stderr: "not a git repository" }]);
    const outcome = await commitIfDirty("C:\\wt\\gone", run);
    expect(outcome.committed).toBe(false);
    expect(outcome.message).toContain("git status failed");
    expect(calls).toHaveLength(1);
  });

  test("reports a commit failure (e.g. nothing staged after add)", async () => {
    const { run } = scriptedRunner([
      { status: 0, stdout: " M some/file.ts\n", stderr: "" },
      OK,
      { status: 1, stdout: "", stderr: "nothing to commit" },
    ]);
    const outcome = await commitIfDirty("C:\\wt\\session-1", run);
    expect(outcome.committed).toBe(false);
    expect(outcome.message).toContain("git commit failed");
  });
});

describe("pushCurrentBranch", () => {
  test("pushes whatever branch is currently checked out to origin", async () => {
    const { run, calls } = scriptedRunner([{ status: 0, stdout: "main\n", stderr: "" }, OK]);
    const result = await pushCurrentBranch("C:\\repo", run);
    expect(result.status).toBe(0);
    expect(calls[1]).toEqual(["git", ["push", "origin", "main"], "C:\\repo"]);
  });

  test("does not attempt a push when the branch name can't be resolved", async () => {
    const { run, calls } = scriptedRunner([{ status: 128, stdout: "", stderr: "not a git repository" }]);
    const result = await pushCurrentBranch("C:\\repo", run);
    expect(result.status).toBe(128);
    expect(calls).toHaveLength(1);
  });
});

describe("deployMarkerPath / write / read / clear", () => {
  function makeMarker(deployedAtIso: string): DeployMarker {
    return {
      previousHeadSha: "abc1234",
      newHeadSha: "def5678",
      repoRoot: "C:\\repo",
      branch: "claude/fix-1",
      chatId: "-100123",
      topicId: 42,
      deployedAtIso,
    };
  }

  test("computes <stateDir>/deploy-pending.json", () => {
    expect(deployMarkerPath("C:\\state")).toBe(path.join("C:\\state", "deploy-pending.json"));
  });

  test("round-trips a written marker and clear removes it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-deploy-test-"));
    try {
      expect(readDeployMarker(stateDir)).toBeNull();
      const marker = makeMarker("2026-08-05T20:00:00.000Z");
      writeDeployMarker(stateDir, marker);
      expect(readDeployMarker(stateDir)).toEqual(marker);
      clearDeployMarker(stateDir);
      expect(readDeployMarker(stateDir)).toBeNull();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  test("clear is a no-op when no marker exists", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-deploy-test-"));
    try {
      expect(() => clearDeployMarker(stateDir)).not.toThrow();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("isDeployMarkerStale", () => {
  const marker: DeployMarker = {
    previousHeadSha: "abc1234",
    newHeadSha: "def5678",
    repoRoot: "C:\\repo",
    branch: "claude/fix-1",
    chatId: "-100123",
    topicId: 42,
    deployedAtIso: "2026-08-05T20:00:00.000Z",
  };
  const deployedAtMs = new Date(marker.deployedAtIso).getTime();

  test("not stale just after being written", () => {
    expect(isDeployMarkerStale(marker, deployedAtMs + 1_000)).toBe(false);
  });

  test("not stale right at the threshold boundary", () => {
    expect(isDeployMarkerStale(marker, deployedAtMs + DEPLOY_CRASH_LOOP_THRESHOLD_MS)).toBe(false);
  });

  test("stale once comfortably past the threshold", () => {
    expect(isDeployMarkerStale(marker, deployedAtMs + DEPLOY_CRASH_LOOP_THRESHOLD_MS + 1_000)).toBe(true);
  });

  test("a caller-supplied threshold overrides the default", () => {
    expect(isDeployMarkerStale(marker, deployedAtMs + 5_000, 1_000)).toBe(true);
  });
});

describe("rollbackStaleDeploy", () => {
  test("resets the marker's repoRoot to its previousHeadSha", async () => {
    const { run, calls } = scriptedRunner([OK]);
    const marker: DeployMarker = {
      previousHeadSha: "abc1234",
      newHeadSha: "def5678",
      repoRoot: "C:\\repo",
      branch: "claude/fix-1",
      chatId: "-100123",
      topicId: 42,
      deployedAtIso: "2026-08-05T20:00:00.000Z",
    };
    const result = await rollbackStaleDeploy(marker, run);
    expect(result.status).toBe(0);
    expect(calls).toEqual([["git", ["reset", "--hard", "abc1234"], "C:\\repo"]]);
  });
});

describe("truncateForTelegram", () => {
  test("leaves short text untouched", () => {
    expect(truncateForTelegram("short")).toBe("short");
  });

  test("truncates and marks long text", () => {
    const long = "x".repeat(4000);
    const result = truncateForTelegram(long, 10);
    expect(result.startsWith("x".repeat(10))).toBe(true);
    expect(result).toContain("truncated");
    expect(result.length).toBeLessThan(long.length);
  });
});
