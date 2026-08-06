import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalizeWindowsPath } from "./claude-config.ts";

const execFileAsync = promisify(execFile);

/**
 * §5.9 "Fixing the Bridge itself from Telegram": `/deploy <slug>` merges a session's own branch
 * into its repo's main checkout and runs the same gate an operator would run by hand, so a fix
 * written by a Claude session (including one against aibridge's own repo, registered like any
 * other project - see repos-registry.ts/§7.5) can land without a desk. Every git/test invocation
 * here goes through an injectable `CommandRunner` (mirrors the injected-clock convention already
 * used by rate-governor.ts) so the merge/gate/rollback logic is unit-testable without a real repo
 * or a real `bun test` run.
 *
 * Live-verified 2026-08-05: a trivial commit on this exact test-session branch was merged into
 * the real running dev Bridge's own checkout via a real `/deploy test-session` from Telegram,
 * the gate ran for real, and the self-respawn brought the Bridge back up with this comment live.
 */
export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[], cwd: string) => Promise<CommandResult>;

/** Runs as a real child process - async (not `execFileSync`) so a slow `bun test` run doesn't
 * block the event loop the rest of the fleet's pipe/feed traffic is running on. */
export async function defaultRunner(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Resolves the aibridge repo's own root from a module's own directory - `deploy.ts` and
 * `index.ts` both live at `packages/bridge/src`, always three directories below the repo root
 * regardless of the Bridge's own cwd at launch. Takes `moduleDir` rather than reading
 * `import.meta.dirname` itself so a test can point this at a fake layout. */
export function resolveBridgeRepoRoot(moduleDir: string): string {
  return path.resolve(moduleDir, "../../..");
}

/** True only when `repoPath` is (canonically) the exact checkout this Bridge process is running
 * from - the one case where a successful deploy should also trigger the self-restart+health-check
 * path below. Deploying any other registered project's branch is just a merge+test gate; there is
 * no "Bridge" to restart for it. */
export function isSelfRepo(repoPath: string, bridgeRepoRoot: string): boolean {
  return canonicalizeWindowsPath(path.resolve(repoPath)) === canonicalizeWindowsPath(path.resolve(bridgeRepoRoot));
}

/** Every `packages/*` directory that declares its own `typecheck` script (matches package.json's
 * actual convention, confirmed across bridge/channel-server/hook-client/protocol/stub-telegram) -
 * computed at deploy time rather than hardcoded so a future new package is picked up for free. */
export function discoverTypecheckedPackages(repoRoot: string): string[] {
  const packagesDir = path.join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.typecheck) dirs.push(path.join(packagesDir, entry.name));
    } catch {
      // an unparsable package.json just isn't included - not this function's job to validate it.
    }
  }
  return dirs;
}

export interface GateResult {
  ok: boolean;
  output: string;
}

/** Bun's own "there was nothing to run" line, which it prints on stderr while still exiting 0 -
 * matched on text because there is no distinguishable exit code for it. */
export function foundNoTests(stdout: string, stderr: string): boolean {
  return /0 test files? matching/i.test(`${stdout}\n${stderr}`);
}

/** The same gate `§9` already asks for by hand: `bun test` once at the repo root (covers every
 * workspace in one run), then `tsc --noEmit` per package that declares it. Stops at the first
 * failure - `output` always includes whichever command actually failed, never silently truncated
 * to "something failed". */
export async function runGate(repoRoot: string, packageDirs: readonly string[], run: CommandRunner = defaultRunner): Promise<GateResult> {
  const testResult = await run("bun", ["test"], repoRoot);
  const parts = [`$ bun test\n${testResult.stdout}${testResult.stderr}`];
  if (testResult.status !== 0) {
    // A repo with no test files at all already fails here - verified against the pinned toolchain:
    // `bun test` with zero matching files exits **1**, not 0. §7.5 allows registering any repo, so
    // that is the right outcome (§5.9's gate can't vouch for something it never ran), but bun's own
    // "0 test files matching ..." message reads like a tooling error rather than a gate verdict, so
    // say which it is.
    const why = foundNoTests(testResult.stdout, testResult.stderr)
      ? `\n\nThis repo has no test files, so there was nothing for the gate to run - it can't vouch for this branch. Add tests, or merge it by hand.`
      : "";
    return { ok: false, output: `${parts.join("\n\n")}${why}` };
  }

  for (const dir of packageDirs) {
    const tc = await run("bun", ["run", "typecheck"], dir);
    parts.push(`$ (${path.basename(dir)}) bun run typecheck\n${tc.stdout}${tc.stderr}`);
    if (tc.status !== 0) return { ok: false, output: parts.join("\n\n") };
  }
  return { ok: true, output: parts.join("\n\n") };
}

export interface DeployOutcome {
  ok: boolean;
  rolledBack: boolean;
  message: string;
  previousHeadSha?: string;
  newHeadSha?: string;
}

/** Telegram messages cap at 4096 UTF-16 code units; leave headroom for the surrounding text. */
export function truncateForTelegram(text: string, maxLen = 3500): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n… (truncated)` : text;
}

/**
 * Merges `branch` into `repoRoot`'s current HEAD via fast-forward only - never a real merge
 * commit, a diverged branch is a "rebase it yourself" case, not something to resolve
 * automatically over Telegram - then runs `runGate`. Any failure (a dirty tree, a non-ff branch, a
 * failing test or typecheck) leaves `repoRoot` exactly as it was: a dirty tree or non-ff branch
 * never merges at all, and a gate failure after a real merge is rolled back with
 * `git reset --hard` to the commit recorded before the merge started.
 */
export async function deployBranch(
  repoRoot: string,
  branch: string,
  packageDirs: readonly string[],
  run: CommandRunner = defaultRunner,
): Promise<DeployOutcome> {
  const status = await run("git", ["status", "--porcelain"], repoRoot);
  if (status.status !== 0) return { ok: false, rolledBack: false, message: `git status failed: ${status.stderr || status.stdout}` };
  if (status.stdout.trim().length > 0) {
    return { ok: false, rolledBack: false, message: `${repoRoot} has uncommitted changes - refusing to deploy onto a dirty tree.` };
  }

  const headResult = await run("git", ["rev-parse", "HEAD"], repoRoot);
  if (headResult.status !== 0) return { ok: false, rolledBack: false, message: `git rev-parse HEAD failed: ${headResult.stderr || headResult.stdout}` };
  const previousHead = headResult.stdout.trim();

  const verify = await run("git", ["rev-parse", "--verify", branch], repoRoot);
  if (verify.status !== 0) return { ok: false, rolledBack: false, message: `branch "${branch}" not found: ${verify.stderr || verify.stdout}` };

  const merge = await run("git", ["merge", "--ff-only", branch], repoRoot);
  if (merge.status !== 0) {
    return {
      ok: false,
      rolledBack: false,
      message: `"${branch}" isn't a fast-forward of HEAD (diverged, or main has moved on) - rebase it and retry: ${merge.stderr || merge.stdout}`,
    };
  }

  const newHeadResult = await run("git", ["rev-parse", "HEAD"], repoRoot);
  const newHead = newHeadResult.stdout.trim();
  if (newHead === previousHead) {
    return { ok: false, rolledBack: false, message: `"${branch}" is already merged into HEAD - nothing to deploy.` };
  }

  const gate = await runGate(repoRoot, packageDirs, run);
  if (!gate.ok) {
    await run("git", ["reset", "--hard", previousHead], repoRoot);
    return {
      ok: false,
      rolledBack: true,
      previousHeadSha: previousHead,
      message: `Gate failed after merging "${branch}" - rolled back to ${previousHead.slice(0, 8)}.\n\n${truncateForTelegram(gate.output)}`,
    };
  }

  return {
    ok: true,
    rolledBack: false,
    previousHeadSha: previousHead,
    newHeadSha: newHead,
    message: `Merged "${branch}" into ${repoRoot} (${previousHead.slice(0, 8)} -> ${newHead.slice(0, 8)}) - gate passed.`,
  };
}

/**
 * The crash-loop safety net for the self-restart path (`isSelfRepo`). Written right before the
 * old process spawns its detached successor and exits (§4.5.1's own `/restart` pattern) - if the
 * successor never reaches "started cleanly" (see `clearDeployMarker`'s call site in index.ts)
 * before this marker looks stale, the *next* boot attempt (this Bridge's Windows Task Scheduler
 * restart, or another `/restart`) treats that as the deploy having broken startup and rolls the
 * repo back on its own, rather than crash-looping forever on a bad commit with no way to say so.
 */
export interface DeployMarker {
  previousHeadSha: string;
  newHeadSha: string;
  repoRoot: string;
  branch: string;
  chatId: string;
  topicId: number | undefined;
  deployedAtIso: string;
}

export function deployMarkerPath(stateDir: string): string {
  return path.join(stateDir, "deploy-pending.json");
}

export function writeDeployMarker(stateDir: string, marker: DeployMarker): void {
  writeFileSync(deployMarkerPath(stateDir), JSON.stringify(marker), "utf8");
}

export function readDeployMarker(stateDir: string): DeployMarker | null {
  const p = deployMarkerPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DeployMarker;
  } catch {
    return null;
  }
}

export function clearDeployMarker(stateDir: string): void {
  const p = deployMarkerPath(stateDir);
  if (existsSync(p)) rmSync(p);
}

/** Matches Task Scheduler's own restart cadence (§7: "restart every 1 minute, up to 99 times") -
 * a marker is only "stale" (crash-loop-suspected) once a boot attempt has had a full cycle to
 * either clear it or crash again, not on the very next line of the same successful boot. */
export const DEPLOY_CRASH_LOOP_THRESHOLD_MS = 45_000;

export function isDeployMarkerStale(marker: DeployMarker, nowMs: number, thresholdMs = DEPLOY_CRASH_LOOP_THRESHOLD_MS): boolean {
  return nowMs - new Date(marker.deployedAtIso).getTime() > thresholdMs;
}

/** Reverts `marker.repoRoot` to the commit recorded before the deploy that's now suspected of
 * having broken Bridge startup. Does not touch the marker file itself - the caller clears it (or
 * not, if even the reset failed) so the decision of what to do next stays in index.ts alongside
 * the respawn/notify logic `/restart` already owns. */
export async function rollbackStaleDeploy(marker: DeployMarker, run: CommandRunner = defaultRunner): Promise<CommandResult> {
  return run("git", ["reset", "--hard", marker.previousHeadSha], marker.repoRoot);
}
