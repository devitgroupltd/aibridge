import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { canonicalizeWindowsPath, ensurePlaywrightRegistration, ensureTrustDialogAccepted } from "./claude-config.ts";
import { STATE_DIR } from "./config.ts";
import { ensureOutboxDir, ensurePlaywrightSharedDir } from "./outbox.ts";
import { generateSettings, writeSettingsFile } from "./settings.ts";
import { ensureWorktree } from "./worktree.ts";

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
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
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
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) {
    throw new Error("bun.exe not found on PATH - is Bun installed for this account? (§9)");
  }
  cachedBunExePath = first;
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

/** §5.8: the desktop-capture helper (System.Drawing screenshot, whole desktop or one named
 * window) - a plain asset file, not a compiled binary like the hook client, so there is nothing
 * to build here, only a path to resolve once. */
function resolveScreenshotScriptPath(): string {
  return path.resolve(import.meta.dirname, "../assets/screenshot-desktop.ps1");
}

function resolveHookClientBinary(): string {
  if (cachedHookClientPath) return cachedHookClientPath;
  const packageDir = path.resolve(import.meta.dirname, "../../hook-client");
  const srcDir = path.join(packageDir, "src");
  const exeName = process.platform === "win32" ? "aibridge-hook.exe" : "aibridge-hook";
  const exePath = path.join(packageDir, "dist", exeName);
  const stale = !existsSync(exePath) || statSync(exePath).mtimeMs < newestSourceMtimeMs(srcDir);
  if (stale) {
    execFileSync(resolveBunExecutable(), ["build", "--compile", "src/index.ts", "--outfile", path.join("dist", "aibridge-hook")], {
      cwd: packageDir,
    });
  }
  cachedHookClientPath = exePath;
  return exePath;
}

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

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
   * first.
   */
  ready: Promise<void>;
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
function waitForStartupPrompt(ptyProcess: pty.IPty, log: LogFn): Promise<void> {
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
      resolve();
    }, 30_000);
    ptyProcess.onData((data) => {
      if (done) return;
      rawBuffer = (rawBuffer + data).slice(-8000);
      const plain = stripAnsi(rawBuffer);
      if (/for shortcuts/i.test(plain) || /for agents/i.test(plain)) {
        done = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

export function launchSession(opts: SessionLaunchOptions): LaunchedSession {
  const log = opts.log ?? (() => {});
  const worktreesRoot = opts.worktreesRoot ?? "C:\\data\\worktrees";
  const worktreePath = path.join(worktreesRoot, opts.slug);
  const branch = `claude/${opts.slug}-1`;

  ensureWorktree(opts.repoPath, worktreePath, branch);
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
  const settingsPath = writeSettingsFile(opts.stateDir ?? STATE_DIR, opts.slug, generateSettings(resolveHookClientBinary(), opts.otlpPort));
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
    [
      "--channels",
      "plugin:aibridge-telegram@devitgroup-plugins",
      "--model",
      opts.model ?? "sonnet",
      "--settings",
      settingsPath,
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    ],
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

  const ready = waitForStartupPrompt(ptyProcess, log);

  if (process.env.AIBRIDGE_DEBUG_PTY_LOG === "1") {
    ptyProcess.onData((data) => log("INFO", `[pty:${opts.slug}] ${JSON.stringify(stripAnsi(data))}`));
  }

  if (opts.mirrorPtyToConsole) {
    ptyProcess.onData((data) => process.stdout.write(data));
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => ptyProcess.write(data.toString()));
  }

  return { worktreePath, branch, ptyProcess, ready };
}
