import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner, DeployMarker } from "../src/deploy.ts";
import {
  clearDeployMarker,
  deployBranch,
  deployMarkerPath,
  discoverTypecheckedPackages,
  DEPLOY_CRASH_LOOP_THRESHOLD_MS,
  isDeployMarkerStale,
  isSelfRepo,
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
    expect(outcome.message).toContain('branch "claude/nope" not found');
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
