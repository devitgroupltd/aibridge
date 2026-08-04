import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { canonicalizeWindowsPath, ensureMcpJsonRegistration, ensureTrustDialogAccepted } from "./claude-config.ts";
import { STATE_DIR } from "./config.ts";
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
  /** Absolute path to packages/channel-server/src/index.ts, run via `bun run`. */
  channelServerEntryPath: string;
  worktreesRoot?: string;
  claudeJsonPath?: string;
  /** Overrides where the generated `--settings` file is written under - defaults to `$STATE`. */
  stateDir?: string;
  /**
   * §10.1 correction: the dev-flag confirm keystroke is Phase 5 work, not Phase 1 ("Manual
   * launch" per §12). When set, mirrors the PTY's I/O to this process's own stdio so the
   * operator can watch for and answer the development-channels warning dialog by hand.
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
   * Resolves once the dev-channels dialog is confirmed (or a safety timeout elapses assuming none
   * ever showed up). A caller that writes anything else to the PTY - `/new`'s initial prompt, in
   * particular - before this resolves races the still-open dialog: confirmed live 2026-08-04, a
   * `/new` prompt sent immediately after launch corrupted the dialog's input and the session never
   * got past it at all, with no error anywhere. Everyone who writes to a freshly-launched PTY must
   * await this first.
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
 * Watches the PTY's own output for a known startup dialog's banner text and its own confirm hint,
 * rather than a fixed delay - render time isn't fixed (Claude Code's own startup cost varies), and
 * the known PTY-timing hazard elsewhere in this codebase (`/effort`'s second `\r`) is exactly what
 * a fixed delay would risk here too. Two dialogs are known, and can both show up in sequence on a
 * genuinely fresh worktree (confirmed live 2026-08-04): the "New MCP server found in this project"
 * consent dialog (documented in `claude-config.ts` as unavoidable for this feature - it fires on
 * the worktree's first-ever launch, before the dev-channels dialog) and the dev-channels dialog
 * itself (fires on *every* launch, unconditionally). Each is confirmed with a bare Enter (both
 * pre-select the "use this session only" option), and the buffer is reset after each confirm so
 * trailing dialog text can't falsely re-match. Resolving as soon as the dev-channels dialog is
 * confirmed is NOT enough, though - confirmed live 2026-08-04, even with a 500ms settle delay
 * afterward, a caller's very next write (e.g. `/new`'s initial prompt) could still race Claude
 * Code's own post-dialog startup (the `SessionStart` hook firing, the MCP handshake, the banner
 * render) and silently lose its trailing Enter, wedging the session with no further output at all
 * and no error anywhere. So this waits for an explicit, later signal instead of any fixed delay:
 * the bottom status bar text that's the last thing the splash sequence renders, proving the REPL
 * prompt is actually live and accepting input.
 */
function autoConfirmDevChannelsDialog(ptyProcess: pty.IPty, log: LogFn): Promise<void> {
  return new Promise((resolve) => {
    let stage: "dialogs" | "prompt" | "done" = "dialogs";
    let rawBuffer = "";
    // A sequence that never completes (unexpected CLI version, `--resume` skipping straight past
    // both dialogs to a differently-rendered prompt, etc.) must not wedge every caller waiting on
    // `ready` forever - proceeds anyway past this, logged loudly since it means something about the
    // assumed startup sequence changed.
    const timeout = setTimeout(() => {
      if (stage === "done") return;
      stage = "done";
      log("WARN", "timed out waiting for startup dialogs/prompt to settle - proceeding anyway");
      resolve();
    }, 30_000);
    ptyProcess.onData((data) => {
      if (stage === "done") return;
      rawBuffer = (rawBuffer + data).slice(-8000);
      const plain = stripAnsi(rawBuffer);

      if (stage === "dialogs") {
        if (/new mcp server found/i.test(plain) && /enter to confirm/i.test(plain)) {
          ptyProcess.write("\r");
          log("INFO", 'auto-confirmed the "New MCP server found" consent dialog');
          rawBuffer = "";
          return;
        }
        if (/development channels/i.test(plain) && /enter to confirm/i.test(plain)) {
          ptyProcess.write("\r");
          log("INFO", "auto-confirmed the --dangerously-load-development-channels dialog");
          rawBuffer = "";
          stage = "prompt";
        }
        return;
      }

      // stage === "prompt": the "? for shortcuts · ← for agents" status bar is the last thing the
      // splash sequence renders, so seeing it is a real (not guessed) lower bound on readiness.
      // It is not sufficient by itself, though - confirmed live 2026-08-04 that a write right after
      // it can still silently lose its trailing Enter, because the MCP handshake (the channel
      // server registering itself with this Claude Code process) hasn't finished yet, and that has
      // no signal at all in the PTY stream. A caller that also needs *that* settled - `/new`'s
      // initial prompt does - waits on the real `channel server connected` event from the pipe
      // server instead (index.ts's `waitForChannelConnected`), which is what actually closes this
      // race deterministically rather than guessing a delay.
      if (/for shortcuts/i.test(plain) || /for agents/i.test(plain)) {
        stage = "done";
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

  const debugLogFile = process.env.AIBRIDGE_DEBUG_LOG_FILE;
  const { changed } = ensureMcpJsonRegistration(worktreePath, {
    command: resolveBunExecutable(),
    args: ["run", opts.channelServerEntryPath],
    // Claude Code spawns a registered MCP server as its own child process, not as a child of the
    // claude.exe PTY - it does not inherit AIBRIDGE_SLUG/AIBRIDGE_TOPIC from ptyEnv() just because
    // claude.exe itself has them. Without this, the channel server throws on its own AIBRIDGE_SLUG
    // guard before it ever opens the pipe, which also happens to be before its log() helper even
    // exists - so the crash produces no debug-log line and surfaces only as Claude Code's own
    // generic "server:aibridge - no MCP server configured with that name" channel-load warning.
    env: {
      AIBRIDGE_SLUG: opts.slug,
      AIBRIDGE_TOPIC: String(opts.topicId),
      // Claude Code does not surface an MCP server's stderr anywhere visible, so this is the only
      // way to observe the channel server's own log lines during manual verification (Stage 7).
      ...(debugLogFile ? { AIBRIDGE_DEBUG_LOG_FILE: debugLogFile } : {}),
    },
  });
  log(
    "INFO",
    changed
      ? `registered aibridge channel server in ${worktreePath}\\.mcp.json`
      : `channel server already registered in ${worktreePath}\\.mcp.json`,
  );

  // §6.2/§5.1: written fresh on every launch, before the process is spawned - same ordering
  // requirement as the .mcp.json/.claude.json registrations above. Resolving the hook client
  // binary can trigger a one-time `bun build --compile`, so it happens before the settings file
  // (and therefore the spawn) rather than racing it.
  const settingsPath = writeSettingsFile(opts.stateDir ?? STATE_DIR, opts.slug, generateSettings(resolveHookClientBinary(), opts.otlpPort));
  log("INFO", `wrote permission settings baseline to ${settingsPath}`);

  const ptyProcess = pty.spawn(
    resolveClaudeExecutable(),
    [
      "--dangerously-load-development-channels",
      "server:aibridge",
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
      env: ptyEnv({ AIBRIDGE_SLUG: opts.slug, AIBRIDGE_TOPIC: String(opts.topicId) }),
    },
  );

  log("INFO", `spawned claude (pid ${ptyProcess.pid}) for slug "${opts.slug}"`);

  // `--dangerously-load-development-channels` shows a one-time interactive warning on every
  // launch (confirmed live 2026-08-03: it is not persisted anywhere, and re-appears identically
  // after a `--resume`) - this is what the "Manual launch" affordance (`mirrorPtyToConsole`/the
  // dev-control-port `/write` handler, both wired to the Phase 1 hardcoded session only) existed
  // to answer by hand. Every `/new`-created fleet session had no such wiring at all and sat stuck
  // at this dialog forever - never reaching `SessionStart`, never getting a `session_id`, never
  // even seeing the prompt `/new` sent it. That is the automation §10.1/§9's own comment named as
  // "the Phase 5 supervisor's" job; this is it. The pre-selected option is always "I am using this
  // for local development" (confirmed live), so a bare Enter is the correct answer every time.
  const ready = autoConfirmDevChannelsDialog(ptyProcess, log);

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
