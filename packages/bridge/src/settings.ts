import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface HookEntry {
  matcher?: string;
  hooks: [{ type: "command"; command: string; async: boolean; timeout?: number }];
}

export interface PermissionSettings {
  permissions: {
    deny: string[];
    ask: string[];
    allow: string[];
  };
  hooks?: Record<string, HookEntry[]>;
  env?: Record<string, string>;
}

/**
 * §5.1's event table, live-verified shapes aside (hook-events.ts's own concern) - every one of
 * these is declared `async` so firing them never adds latency to the agent loop; the
 * `AskUserQuestion`-matched synchronous exception is Phase 4, not added here.
 */
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

function buildHooks(hookClientPath: string): Record<string, HookEntry[]> {
  const entries: Record<string, HookEntry[]> = {};
  for (const event of HOOK_EVENTS) {
    entries[event] = [{ hooks: [{ type: "command", command: `"${hookClientPath}"`, async: true }] }];
  }
  // §6.4: a second, synchronous PreToolUse entry matched to AskUserQuestion specifically - the
  // async catch-all above still fires on the same call (for the feed's "asking: ..." line) but
  // can't be the one that blocks, so the hook client distinguishes the two by the `--ask` flag
  // baked into this command string, not by inspecting the payload (both entries get identical
  // stdin). "timeout": 3600 is a real hour, not a ceiling to work around (§6.4) - live-verified
  // 2026-08-03 that Claude Code accepts both the resulting `allow`+`updatedInput` and `deny`
  // stdout shapes exactly as documented there.
  entries.PreToolUse = [
    ...(entries.PreToolUse ?? []),
    {
      matcher: "AskUserQuestion",
      hooks: [{ type: "command", command: `"${hookClientPath}" --ask`, async: false, timeout: 3600 }],
    },
  ];
  return entries;
}

/**
 * §5.7's telemetry env block - `http/json`, not the plan's originally-written `http/protobuf` (see
 * `otlp-listener.ts`'s own doc comment for why: confirmed live 2026-08-04 that Claude Code honours
 * the env var and sends plain JSON, which needs no protobuf decoder on the Bridge side). Deliberately
 * omits `OTEL_LOG_USER_PROMPTS` and the tool-content variables (§5.7's "two deliberate restraints") -
 * prompts/tool output would put source code and secrets into a second store for no operational gain.
 */
function buildTelemetryEnv(otlpPort: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlpPort}`,
    OTEL_METRIC_EXPORT_INTERVAL: "15000",
  };
}

/**
 * §6.2's per-session settings baseline, verbatim. Content-scoped from the start (§6.1.1: a bare
 * `Bash` ask rule is skipped for sandboxed commands, so writing it broad now avoids a rewrite at
 * the §7.6 sandbox migration), `~/`-anchored paths only (a single leading slash anchors at the
 * settings source, not the filesystem root), and `mcp__aibridge__reply` pre-allowed since the
 * channel server's own reply tool otherwise raises its own permission prompt on first use (§3.3).
 * `hookClientPath` is optional so every existing caller/test that only cares about the permission
 * baseline is unaffected - `session-launcher.ts` is the one real caller that passes it. `otlpPort`
 * defaults to §5.7's `4318` - overridable for tests that run their own throwaway listener.
 */
export function generateSettings(hookClientPath?: string, otlpPort = 4318): PermissionSettings {
  return {
    ...(hookClientPath ? { hooks: buildHooks(hookClientPath) } : {}),
    env: buildTelemetryEnv(otlpPort),
    permissions: {
      deny: [
        "Bash(rm -rf /*)",
        "Bash(git push --force *)",
        "Bash(curl * | sh)",
        "Bash(curl * | bash)",
        "Read(.env)",
        "Read(~/.ssh/**)",
        "Read(~/.aws/**)",
      ],
      ask: ["Bash(git commit *)", "Bash(git push *)", "Bash(gh pr *)", "Bash(npm publish *)", "Bash(dotnet nuget push *)"],
      allow: [
        "Read",
        "Grep",
        "TodoWrite",
        "NotebookRead",
        "mcp__aibridge__reply",
        "Bash(git status *)",
        "Bash(git diff *)",
        "Bash(git log *)",
        "Bash(git branch *)",
        "Bash(git show *)",
        "Bash(dotnet build *)",
        "Bash(dotnet test *)",
        "Bash(npm run *)",
        "Bash(npm ci)",
        "Bash(ls *)",
        "Bash(cat *)",
        "Bash(rg *)",
      ],
    },
  };
}

function settingsFilePath(stateDir: string, slug: string): string {
  return path.join(stateDir, "sessions", slug, "settings.json");
}

export function writeSettingsFile(stateDir: string, slug: string, settings: PermissionSettings): string {
  const filePath = settingsFilePath(stateDir, slug);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2));
  return filePath;
}

/** Falls back to a fresh baseline if no settings file has been written for this slug yet. */
export function readSettingsFile(stateDir: string, slug: string): PermissionSettings {
  const filePath = settingsFilePath(stateDir, slug);
  if (!existsSync(filePath)) {
    return generateSettings();
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as PermissionSettings;
}

/**
 * §6.6: session-scoped accumulation of an `Always`-derived rule. Whether a running session
 * re-reads its `--settings` file mid-conversation is unverified - this is honestly a known gap,
 * not a solved one, so the confirmation text (§7 index.ts) never claims more than "added for this
 * session" without implying it takes effect on the very next call with certainty.
 */
export function addAlwaysRule(settings: PermissionSettings, rule: string): PermissionSettings {
  if (settings.permissions.allow.includes(rule)) {
    return settings;
  }
  return {
    ...settings,
    permissions: { ...settings.permissions, allow: [...settings.permissions.allow, rule] },
  };
}
