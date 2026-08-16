import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { canonicalizeWindowsPath, ensurePlaywrightRegistration, ensureTrustDialogAccepted } from "./claude-config.ts";
import { STATE_DIR } from "./config.ts";
import { ensureOutboxDir, ensurePlaywrightSharedDir } from "./outbox.ts";
import { attachPtyErrorSuppression } from "./pty-write-guard.ts";
import type { PtyLike } from "./pty-write-guard.ts";
import { generateSettings, writeSettingsFile } from "./settings.ts";
import { ensureWorktree } from "./worktree.ts";
import type { LogFn } from "./logger.ts";

/**
 * `where.exe` prints one match per line (CRLF), and - live-observed - a blank trailing line, or
 * more than one match when a shim/stub sits earlier on PATH than the real binary; §9's silent-wrong
 * bar means the "which line is the actual answer" logic is worth pulling out and testing on its
 * own rather than trusting three independent inline copies to keep agreeing. Takes the *first*
 * non-blank line deliberately - PATH order is the same precedence an interactive shell would use,
 * so this matches "the one `where` would run" rather than an arbitrary pick among duplicates.
 * `undefined` for empty/whitespace-only output (no match), never a blank string.
 */
export function firstNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * node-pty's Windows ConPTY agent calls its native `startProcess` directly with `file` before
 * `cwd`/`env`/args are ever applied (those only arrive later, via a separate `connect()` call) -
 * so whatever PATH-search behaviour that native call does is not the same as an interactive
 * shell's, and neither a bare `claude` nor `claude.exe` resolves there even though both resolve
 * fine from PowerShell. Resolving the absolute path via `where` up front sidesteps the question
 * entirely (§2.4 correction 4).
 */
let cachedClaudeExePath: string | undefined;

function resolveClaudeExecutable(): string {
  if (cachedClaudeExePath) return cachedClaudeExePath;
  const output = execFileSync("where", ["claude.exe"], { encoding: "utf8" });
  const first = firstNonEmptyLine(output);
  if (!first) {
    throw new Error("claude.exe not found on PATH - is Claude Code installed and logged in for this account? (§7.5)");
  }
  cachedClaudeExePath = first;
  return first;
}

/**
 * Registered MCP servers are spawned by Claude Code itself, not by node-pty, but a bare `bun`
 * command string is exactly as unresolvable as a bare `claude` was above: `where bun` only
 * matches `bun.exe`, not the extension-less name the JSON registration would otherwise carry -
 * confirmed to be the actual cause of the channel server never starting (it produced Claude
 * Code's generic "server:aibridge - no MCP server configured with that name" channel-load
 * warning, with no channel-server log output at all, since a failed spawn never reaches the
 * server's own log() helper).
 */
let cachedBunExePath: string | undefined;

export function resolveBunExecutable(): string {
  if (cachedBunExePath) return cachedBunExePath;
  const output = execFileSync("where", ["bun.exe"], { encoding: "utf8" });
  const first = firstNonEmptyLine(output);
  if (!first) {
    throw new Error("bun.exe not found on PATH - is Bun installed for this account? (§9)");
  }
  cachedBunExePath = first;
  return first;
}

/**
 * The Bridge process's own runtime - `node --experimental-strip-types`, never Bun (0.21.0
 * root-caused this precisely: a node-pty ConPTY write that succeeds against a perfectly healthy
 * child still throws an unhandled "Socket is closed" asynchronously on the next tick when the
 * *Bridge itself* runs under Bun, wedging almost every session within ~1s of spawn - reproduced
 * with a minimal repro outside this codebase). `resolveBunExecutable` above is for a completely
 * different, legitimate use: the *channel server*'s own MCP registration inside a session, which is
 * correctly meant to run under Bun (§2.4). Every self-respawn site and the Task Scheduler
 * registration (autostart.ts) must resolve this one instead - live-observed 2026-08-08, both
 * `/autostart install`'s own Task Scheduler `/TR` string and `respawnSelfAndExit`'s raw-spawn
 * fallback (which blindly reused `process.execPath`/`process.argv`, perpetuating whatever binary
 * happened to launch the current process) had drifted onto Bun, and every new session on that
 * fleet was wedging and auto-resuming as a direct result.
 */
let cachedNodeExePath: string | undefined;

export function resolveNodeExecutable(): string {
  if (cachedNodeExePath) return cachedNodeExePath;
  const output = execFileSync("where", ["node.exe"], { encoding: "utf8" });
  const first = firstNonEmptyLine(output);
  if (!first) {
    throw new Error("node.exe not found on PATH - is Node.js installed for this account?");
  }
  cachedNodeExePath = first;
  return first;
}

/** Newest mtime among the hook client's own `.ts` sources - a plain existence check (this
 * function's first version) let a stale compiled binary silently keep running old behaviour after
 * a source edit, caught live 2026-08-03 when Phase 4's new `--ask` flag had no effect at all
 * because `dist/aibridge-hook.exe` still predated it. */
function newestSourceMtimeMs(srcDir: string): number {
  let newest = 0;
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".ts")) continue;
    const mtimeMs = statSync(path.join(srcDir, name)).mtimeMs;
    if (mtimeMs > newest) newest = mtimeMs;
  }
  return newest;
}

/**
 * §9's "startup latency is load-bearing" applies only to the hook client, not the channel server:
 * a hook fires synchronously once per tool call even though the event itself is `async`, so this
 * one has to be a compiled binary rather than run from source under `bun run` the way the channel
 * server is a few lines below. Built lazily on first launch and cached on disk, not per-launch -
 * `bun build --compile` costs real seconds - and rebuilt whenever any of its own `.ts` sources is
 * newer than the existing binary, not just when the binary is missing outright.
 */
let cachedHookClientPath: string | undefined;

/**
 * Whether the compiled hook binary needs a rebuild, and - when it does - whether there is an older
 * one to fall back on. The distinction matters only on the failure path: a *stale* binary is still
 * a working binary (it just predates the newest source edit), while a *missing* one leaves nothing
 * to launch a session with.
 */
export type HookBinaryState = "fresh" | "stale" | "missing";

export interface HookBinaryResolution {
  path: string;
  /**
   * A rebuild was attempted, failed, and the pre-existing binary is being reused. Deliberately
   * *not* cached by the caller, so the next launch retries the build once whatever blocked it is
   * gone.
   */
  degraded: boolean;
}

/**
 * The build half of `resolveHookClientBinary`, split out so the "what happens when the rebuild
 * fails" branch is decidable without shelling out to a real `bun build`.
 *
 * Why it degrades rather than throwing: live-observed 2026-08-12. Windows refuses to replace a
 * mapped executable, so `bun build --compile`'s final rename fails with `EPERM` ("failed to move
 * executable to ...\dist\aibridge-hook.exe") whenever *any* hook-client process still holds the old
 * binary open - and `--ask` invocations block indefinitely by design (§5.1), so one unanswered
 * question is enough to wedge every subsequent rebuild. That threw out of `execFileSync` on the
 * launch path, which surfaced as `uncaught exception` and killed the whole daemon seconds after a
 * `/restart`, taking the entire fleet down over a *stale binary* - a strictly worse outcome than
 * running the previous build for one more session. Only the `missing` case is genuinely fatal, and
 * it rethrows.
 *
 * The orphaned `.<hash>-NNNNNNNN.bun-build` temp file bun leaves behind on a failed rename is not
 * swept here on purpose: a concurrent launch's in-progress build writes an indistinguishable temp
 * file into the same directory, so deleting by pattern could break a build that was about to
 * succeed. `.gitignore` keeps it out of `git status` instead; disk cleanup stays manual.
 */
export function ensureHookBinary(opts: { exePath: string; state: HookBinaryState; build: () => void; log?: LogFn }): HookBinaryResolution {
  if (opts.state === "fresh") return { path: opts.exePath, degraded: false };
  try {
    opts.build();
  } catch (error) {
    if (opts.state === "missing") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    opts.log?.(
      "WARN",
      `hook client rebuild failed - reusing the existing (stale) binary at ${opts.exePath}, so a source edit may not be live yet. ` +
        `On Windows this is usually a still-running hook process holding the file open (a blocked --ask); ` +
        `\`bun run build\` in packages/hook-client once no session is mid-question to pick the edit up. Cause: ${detail}`,
    );
    return { path: opts.exePath, degraded: true };
  }
  return { path: opts.exePath, degraded: false };
}

/** §5.8: the desktop-capture helper (System.Drawing screenshot, whole desktop or one named
 * window) - a plain asset file, not a compiled binary like the hook client, so there is nothing
 * to build here, only a path to resolve once. */
function resolveScreenshotScriptPath(): string {
  return path.resolve(import.meta.dirname, "../assets/screenshot-desktop.ps1");
}

function resolveHookClientBinary(log?: LogFn): string {
  if (cachedHookClientPath) return cachedHookClientPath;
  const packageDir = path.resolve(import.meta.dirname, "../../hook-client");
  const srcDir = path.join(packageDir, "src");
  const exeName = process.platform === "win32" ? "aibridge-hook.exe" : "aibridge-hook";
  const exePath = path.join(packageDir, "dist", exeName);
  const state: HookBinaryState = !existsSync(exePath)
    ? "missing"
    : statSync(exePath).mtimeMs < newestSourceMtimeMs(srcDir)
      ? "stale"
      : "fresh";
  const { path: resolved, degraded } = ensureHookBinary({
    exePath,
    state,
    build: () =>
      void execFileSync(resolveBunExecutable(), ["build", "--compile", "src/index.ts", "--outfile", path.join("dist", "aibridge-hook")], {
        cwd: packageDir,
      }),
    log,
  });
  // Not cached when degraded: the next launch should retry the build rather than pin the whole
  // daemon's lifetime to one transient EPERM.
  if (!degraded) cachedHookClientPath = resolved;
  return resolved;
}

export interface SessionLaunchOptions {
  slug: string;
  topicId: number;
  repoPath: string;
  worktreesRoot?: string;
  claudeJsonPath?: string;
  /** Overrides where the generated `--settings` file is written under - defaults to `$STATE`. */
  stateDir?: string;
  /**
   * §10.1's original "Manual launch" affordance (Phase 1, before the Phase 5 supervisor existed to
   * answer startup dialogs automatically): mirrors the PTY's I/O to this process's own stdio so an
   * operator can watch and type into a session directly. The dev-flag dialog this was built to
   * answer by hand is gone as of 0.55.0 (the plugin launch form has none), but the mirror itself
   * still has standalone debugging value, so it stays.
   */
  mirrorPtyToConsole?: boolean;
  log?: LogFn;
  /** §10.5's per-session model routing: Sonnet unless `/new --opus`/`--haiku`/`--fable` overrides
   * it at launch. Defaults to "sonnet" (§4.2's own default), not left to `claude`'s own default. */
  model?: string;
  /** §4.5's reconciliation/`/restart` path: relaunches an existing conversation via
   * `claude --resume <id>` on a fresh PTY instead of starting a new one. The worktree is reused
   * as-is (`ensureWorktree` is a no-op when the directory already exists). */
  resumeSessionId?: string;
  /** The permission mode to *start* in (`/default mode`, and a resume preserving whatever the
   * session was last switched to). Omitted means "whatever the CLI's own default is" - which is
   * `manual`, the same value `DEFAULT_MODE` tracks. See `buildClaudeSpawnArgs` for why this is a
   * launch flag rather than post-launch keystrokes. */
  permissionMode?: string;
  /** §5.7: where this session's OTLP export should point - defaults to `settings.ts`'s own `4318`
   * default. Overridable so integration tests can point a launched session at a throwaway listener
   * instead of the Bridge's real one. */
  otlpPort?: number;
}

export interface LaunchedSession {
  worktreePath: string;
  branch: string;
  ptyProcess: pty.IPty;
  /**
   * Resolves once the startup splash sequence's own status bar appears (or a safety timeout
   * elapses assuming it never will). A caller that writes anything else to the PTY - `/new`'s
   * initial prompt, in particular - before this resolves races Claude Code's own still-rendering
   * startup: confirmed live 2026-08-04 (back when a startup dialog sat in that window too), a
   * `/new` prompt sent too early corrupted in-flight input and the session never got past it at
   * all, with no error anywhere. Everyone who writes to a freshly-launched PTY must await this
   * first. `resumeFailed` is only ever true for a `resumeSessionId` launch - see
   * `RESUME_FAILURE_PATTERN`'s own doc comment.
   *
   * `startupTimedOut` distinguishes "the status bar appeared, we really are past startup" from "the
   * safety timeout fired and we are guessing". Both resolve the promise, which is the point - this
   * must never wedge a caller - but they are not the same thing, and a caller that writes to the PTY
   * on the second one is writing blind (see `startup-gate-notice.ts`). Optional so the many
   * `Promise.resolve({ resumeFailed: false })` doubles in the suite stay valid; absent means "no
   * timeout information", treated as not-timed-out.
   */
  ready: Promise<{ resumeFailed: boolean; startupTimedOut?: boolean }>;
}

function ptyEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A CLAUDE_CODE_CHILD_SESSION marker (or other CLAUDE_CODE_* var) leaking in from an outer
    // Claude Code session the Bridge itself happens to be running under would disable the
    // spawned session's own transcript/context persistence - confirmed during Stage 7 manual
    // verification, where it silently made the session forget its own prior turns.
    if (key.startsWith("CLAUDE_CODE_")) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Strips CSI (`ESC [ ... letter`) and OSC (`ESC ] ... BEL/ESC\`) sequences - the TUI colours each
 * word of the dialog's banner separately (confirmed live 2026-08-03: "development" and "channels"
 * land as two separate colour spans with a literal space between them), so a plain substring test
 * against the raw PTY stream never matches; this is what makes it matchable. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g, "");
}

/**
 * Watches the PTY's own output for the splash sequence's final status-bar line rather than a
 * fixed delay - render time isn't fixed (Claude Code's own startup cost varies), and the known
 * PTY-timing hazard elsewhere in this codebase (`/effort`'s second `\r`) is exactly what a fixed
 * delay would risk here too.
 *
 * Through 0.54.0 this also had to watch for and auto-confirm two startup dialogs first - the "New
 * MCP server found in this project" consent dialog (fired on a worktree's first-ever launch, from
 * the old `.mcp.json` registration) and the `--dangerously-load-development-channels` warning
 * (fired on *every* launch, unconditionally). Removed in 0.55.0: the plugin launch form that
 * replaced both (live-verified as the fleet's real default, §10.1) registers the channel via its
 * own static `plugin.json` instead of a per-worktree `.mcp.json`, and needs no dev flag at all, so
 * neither dialog can fire anymore - there is nothing left here to detect or confirm.
 *
 * Resolving as soon as the status bar appears is NOT enough, though - confirmed live 2026-08-04,
 * even with a 500ms settle delay afterward, a caller's very next write (e.g. `/new`'s initial
 * prompt) could still race Claude Code's own post-splash startup (the `SessionStart` hook firing,
 * the MCP handshake, the banner render) and silently lose its trailing Enter, wedging the session
 * with no further output at all and no error anywhere. So this waits for an explicit, later signal
 * instead of any fixed delay: the bottom status bar text that's the last thing the splash sequence
 * renders, proving the REPL prompt is actually live and accepting input - and a caller that also
 * needs the MCP handshake settled (`/new`'s initial prompt does) waits on the real `channel server
 * connected` event from the pipe server instead (`index.ts`'s `waitForChannelConnected`), which is
 * what actually closes that race deterministically rather than guessing a delay.
 */
/** Matches Claude Code's own message when `--resume <id>` is given a session id it can't find a
 * transcript for (a stale id, or - found live 2026-08-07 - one recorded for a session that crashed
 * before its first transcript write ever completed). Confirmed live: the CLI does *not* exit on this
 * - it prints the line and falls through to a brand-new conversation in the same PTY, so nothing
 * about the process exiting (§4.5's `handleUnexpectedExit` safety net) ever catches it. Without this
 * check, `resumeSession` had no way to know its `claude --resume` had silently failed, so it declared
 * "resumed" over a conversation that had actually been thrown away - the topic then sat with no
 * reply forever, since the original prompt was never resent into the fresh conversation either. */
const RESUME_FAILURE_PATTERN = /no conversation found with session id/i;

/** Nothing else in the Bridge tells Claude what language to reply in (checked - `nl-router.ts`'s
 * classification prompt doesn't count, it governs command-extraction, not conversational replies;
 * confirmed via a full search of the package for "language"/"locale"/"respond in"). Installed once
 * per spawn via `--append-system-prompt` so it survives `--resume` relaunches too, since a resumed
 * PTY re-spawns the same `claude` CLI from scratch (§4.5) rather than continuing an existing process. */
const LANGUAGE_MIRROR_SYSTEM_PROMPT =
  "You're being operated over a Telegram bridge. The operator may write in any language and may " +
  "switch languages between messages within the same conversation. Always reply in the same " +
  "language as the operator's most recent message - never default to English just because the " +
  "session's slug, worktree/folder name, git branch, or earlier turns happen to be in English. " +
  "Code, filenames, commit messages, and identifiers should stay in whatever language the project " +
  "itself already uses (normally English), independent of the conversation's language.";

/** Extracted from `launchSession`'s `pty.spawn` call so it's unit-testable without touching
 * `pty.spawn` itself - mirrors this file's existing pattern of pulling pure logic (`stripAnsi`,
 * `waitForStartupPrompt`) out into its own exported piece. */
export function buildClaudeSpawnArgs(opts: { model: string; settingsPath: string; resumeSessionId?: string; permissionMode?: string }): string[] {
  return [
    "--channels",
    "plugin:aibridge-telegram@devitgroup-plugins",
    "--model",
    opts.model,
    "--settings",
    opts.settingsPath,
    "--append-system-prompt",
    LANGUAGE_MIRROR_SYSTEM_PROMPT,
    // `--permission-mode <manual|acceptEdits|plan|auto|…>` - a real, `--help`-documented flag
    // (verified against the pinned client 2026-08-11). This replaces the Shift+Tab keystroke burst
    // `/default mode` used to send *after* launch, which never worked: live-reproduced 2026-08-10,
    // every freshly-spawned session went `manual` -> `accept edits on` and stopped, i.e. exactly one
    // of the three presses `buildModeKeystrokeSteps` computes for manual->auto landed. Setting the mode
    // before the process starts removes the race outright rather than tuning it - there is no
    // picker to cycle, nothing to redraw between presses, and nothing to lose if the operator's
    // first turn arrives quickly. `buildModeKeystrokeSteps` still owns the *live* `/mode` switch, which
    // has no CLI equivalent mid-session.
    ...(opts.permissionMode ? ["--permission-mode", opts.permissionMode] : []),
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
  ];
}

export function waitForStartupPrompt(ptyProcess: pty.IPty, log: LogFn, resumeSessionId?: string): Promise<{ resumeFailed: boolean; startupTimedOut: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    let rawBuffer = "";
    // A sequence that never renders this line at all (unexpected CLI version, `--resume` skipping
    // straight to a differently-rendered prompt, etc.) must not wedge every caller waiting on
    // `ready` forever - proceeds anyway past this, logged loudly since it means something about the
    // assumed startup sequence changed.
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      log("WARN", "timed out waiting for the startup prompt to settle - proceeding anyway");
      resolve({ resumeFailed: false, startupTimedOut: true });
    }, 30_000);
    ptyProcess.onData((data) => {
      if (done) return;
      rawBuffer = (rawBuffer + data).slice(-8000);
      const plain = stripAnsi(rawBuffer);
      if (resumeSessionId && RESUME_FAILURE_PATTERN.test(plain)) {
        done = true;
        clearTimeout(timeout);
        resolve({ resumeFailed: true, startupTimedOut: false });
        return;
      }
      if (/for shortcuts/i.test(plain) || /for agents/i.test(plain)) {
        done = true;
        clearTimeout(timeout);
        resolve({ resumeFailed: false, startupTimedOut: false });
      }
    });
  });
}

export function launchSession(opts: SessionLaunchOptions): LaunchedSession {
  const log = opts.log ?? (() => {});
  const worktreesRoot = opts.worktreesRoot ?? "C:\\data\\worktrees";
  const worktreePath = path.join(worktreesRoot, opts.slug);
  // §2.3's `claude/<slug>-<id>`: `-1` is only the *preferred* name. `ensureWorktree` returns the
  // branch it actually cut, which differs when a leftover branch of that name still carries
  // unmerged work (it takes the next free id rather than destroying it) or when an existing
  // worktree is being readopted on whatever branch it is already on - so the returned row must
  // record that, not the guess.
  const branch = ensureWorktree(opts.repoPath, worktreePath, `claude/${opts.slug}-1`);
  log("INFO", `worktree ready at ${worktreePath} (${branch})`);

  // §9 scenario 28: this registration must be written before the process is spawned.
  const claudeJsonPath = opts.claudeJsonPath ?? path.join(os.homedir(), ".claude.json");
  const canonicalPath = canonicalizeWindowsPath(worktreePath);
  ensureTrustDialogAccepted(claudeJsonPath, canonicalPath);

  // §5.8: created eagerly, same as the settings file below, so the path named in
  // AIBRIDGE_OUTBOX_DIR (and handed to Playwright's --output-dir just below) always exists by the
  // time Claude's first turn could possibly try to write to it.
  const outboxPath = ensureOutboxDir(opts.stateDir ?? STATE_DIR, opts.slug);
  // Keyed by the *main repo's* canonical path, not the worktree's - confirmed live 2026-08-05 via
  // `claude mcp add`'s own "local" scope (git-common-dir resolves a worktree back to the main
  // repo, per `git rev-parse --git-common-dir`) that Claude Code's per-project ~/.claude.json
  // identity for a worktree checkout is the *main* repo, unlike `ensureTrustDialogAccepted` above
  // (resolved by plain cwd, genuinely per-worktree). Registering under the worktree's own
  // canonical path instead (the original implementation) silently produced an entry Claude Code
  // never read at all - not shown even as "pending" in `claude mcp list` - with no error anywhere,
  // the same class of invisible failure §2.4/§10.1.2 already document twice for this exact config
  // file. Because this registration (and its --output-dir) is necessarily shared by every
  // concurrent session on the same repo, it points at playwrightSharedDir, not this session's own
  // outbox - see outbox.ts.
  const canonicalRepoPath = canonicalizeWindowsPath(opts.repoPath);
  const playwrightSharedPath = ensurePlaywrightSharedDir(opts.stateDir ?? STATE_DIR);
  const { changed: playwrightChanged } = ensurePlaywrightRegistration(claudeJsonPath, canonicalRepoPath, playwrightSharedPath);
  log(
    "INFO",
    playwrightChanged
      ? `registered playwright MCP server in ~/.claude.json under the main repo (output-dir ${playwrightSharedPath})`
      : "playwright MCP server already registered in ~/.claude.json",
  );

  // §6.2/§5.1: written fresh on every launch, before the process is spawned - same ordering
  // requirement as the `.claude.json` registrations above. Resolving the hook client binary can
  // trigger a one-time `bun build --compile`, so it happens before the settings file (and
  // therefore the spawn) rather than racing it.
  const settingsPath = writeSettingsFile(opts.stateDir ?? STATE_DIR, opts.slug, generateSettings(resolveHookClientBinary(log), opts.otlpPort));
  log("INFO", `wrote permission settings baseline to ${settingsPath}`);

  // §10.1: `--channels plugin:aibridge-telegram@devitgroup-plugins` - the fleet's real default as
  // of 0.55.0, live-verified against the real dev Bridge (a real reply+Bash round trip, both
  // existing sessions reconciling cleanly through a restart under this mode). Needs no dev flag
  // and no `.mcp.json` registration - the plugin's own static `plugin.json` registers the channel
  // server instead, and `resolve-slug.ts` (channel-server package) recovers the slug from
  // `CLAUDE_PROJECT_DIR` since `plugin.json` is one static file shared by every worktree and can't
  // carry a per-session `AIBRIDGE_SLUG` the way a per-worktree `.mcp.json` env block used to.
  const ptyProcess = pty.spawn(
    resolveClaudeExecutable(),
    buildClaudeSpawnArgs({ model: opts.model ?? "sonnet", settingsPath, resumeSessionId: opts.resumeSessionId, permissionMode: opts.permissionMode }),
    {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: worktreePath,
      // §5.8: also on the PTY's own env (not just the channel server's) so a Bash/PowerShell
      // command Claude runs directly - e.g. the desktop-screenshot script's -Out argument, or
      // pointing a dev server's own asset dump at it - can reference $AIBRIDGE_OUTBOX_DIR without
      // needing to be told the path in every prompt.
      env: ptyEnv({
        AIBRIDGE_SLUG: opts.slug,
        AIBRIDGE_TOPIC: String(opts.topicId),
        AIBRIDGE_OUTBOX_DIR: outboxPath,
        AIBRIDGE_SCREENSHOT_SCRIPT: resolveScreenshotScriptPath(),
        AIBRIDGE_PLAYWRIGHT_SHARED_DIR: playwrightSharedPath,
      }),
    },
  );

  log("INFO", `spawned claude (pid ${ptyProcess.pid}) for slug "${opts.slug}"`);

  const ready = waitForStartupPrompt(ptyProcess, log, opts.resumeSessionId);

  if (process.env.AIBRIDGE_DEBUG_PTY_LOG === "1") {
    ptyProcess.onData((data) => log("INFO", `[pty:${opts.slug}] ${JSON.stringify(stripAnsi(data))}`));
  }

  if (opts.mirrorPtyToConsole) {
    ptyProcess.onData((data) => process.stdout.write(data));
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    // This bypasses attachPtyWriteGuard's wrapped write - it's wired onto the routing table's write
    // function, not this raw stdin passthrough - but still needs the same protection: found live
    // 2026-08-07 that the try/catch below alone is not enough, since a write to the underlying
    // process after it has already died can throw asynchronously (an unhandled 'error' emitted on
    // the private write-side socket, past any try/catch around the call site - see
    // pty-write-guard.ts's own doc comment). attachPtyErrorSuppression is the same fix
    // attachPtyWriteGuard applies, without its write wrapper.
    attachPtyErrorSuppression(ptyProcess as unknown as PtyLike, opts.slug, { log });
    process.stdin.on("data", (data) => {
      try {
        ptyProcess.write(data.toString());
      } catch (err) {
        log("WARN", `dev-mirror write to session "${opts.slug}" dropped - its PTY is gone: ${(err as Error).message}`);
      }
    });
  }

  return { worktreePath, branch, ptyProcess, ready };
}
