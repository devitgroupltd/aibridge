import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

function resolveBunExecutable(): string {
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

/**
 * §9's "startup latency is load-bearing" applies only to the hook client, not the channel server:
 * a hook fires synchronously once per tool call even though the event itself is `async`, so this
 * one has to be a compiled binary rather than run from source under `bun run` the way the channel
 * server is a few lines below. Built lazily on first launch and cached on disk, not per-launch -
 * `bun build --compile` costs real seconds, and the binary only needs rebuilding when its own
 * source changes, which a `dist/` check-then-build covers without needing a separate build step
 * wired into CI for Phase 3's scope.
 */
let cachedHookClientPath: string | undefined;

function resolveHookClientBinary(): string {
  if (cachedHookClientPath) return cachedHookClientPath;
  const packageDir = path.resolve(import.meta.dirname, "../../hook-client");
  const exeName = process.platform === "win32" ? "aibridge-hook.exe" : "aibridge-hook";
  const exePath = path.join(packageDir, "dist", exeName);
  if (!existsSync(exePath)) {
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
}

export interface LaunchedSession {
  worktreePath: string;
  branch: string;
  ptyProcess: pty.IPty;
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
  const settingsPath = writeSettingsFile(opts.stateDir ?? STATE_DIR, opts.slug, generateSettings(resolveHookClientBinary()));
  log("INFO", `wrote permission settings baseline to ${settingsPath}`);

  const ptyProcess = pty.spawn(
    resolveClaudeExecutable(),
    ["--dangerously-load-development-channels", "server:aibridge", "--model", "sonnet", "--settings", settingsPath],
    {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: worktreePath,
      env: ptyEnv({ AIBRIDGE_SLUG: opts.slug, AIBRIDGE_TOPIC: String(opts.topicId) }),
    },
  );

  log("INFO", `spawned claude (pid ${ptyProcess.pid}) for slug "${opts.slug}"`);

  if (opts.mirrorPtyToConsole) {
    ptyProcess.onData((data) => process.stdout.write(data));
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => ptyProcess.write(data.toString()));
  }

  return { worktreePath, branch, ptyProcess };
}
