import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface HookEntry {
  matcher?: string;
  hooks: [{ type: "command"; command: string; async: boolean }];
}

export interface PermissionSettings {
  permissions: {
    deny: string[];
    ask: string[];
    allow: string[];
  };
  hooks?: Record<string, HookEntry[]>;
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
  return entries;
}

/**
 * §6.2's per-session settings baseline, verbatim. Content-scoped from the start (§6.1.1: a bare
 * `Bash` ask rule is skipped for sandboxed commands, so writing it broad now avoids a rewrite at
 * the §7.6 sandbox migration), `~/`-anchored paths only (a single leading slash anchors at the
 * settings source, not the filesystem root), and `mcp__aibridge__reply` pre-allowed since the
 * channel server's own reply tool otherwise raises its own permission prompt on first use (§3.3).
 * `hookClientPath` is optional so every existing caller/test that only cares about the permission
 * baseline is unaffected - `session-launcher.ts` is the one real caller that passes it.
 */
export function generateSettings(hookClientPath?: string): PermissionSettings {
  return {
    ...(hookClientPath ? { hooks: buildHooks(hookClientPath) } : {}),
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
