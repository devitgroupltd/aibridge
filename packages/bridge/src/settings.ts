import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PermissionSettings {
  permissions: {
    deny: string[];
    ask: string[];
    allow: string[];
  };
}

/**
 * §6.2's per-session settings baseline, verbatim. Content-scoped from the start (§6.1.1: a bare
 * `Bash` ask rule is skipped for sandboxed commands, so writing it broad now avoids a rewrite at
 * the §7.6 sandbox migration), `~/`-anchored paths only (a single leading slash anchors at the
 * settings source, not the filesystem root), and `mcp__aibridge__reply` pre-allowed since the
 * channel server's own reply tool otherwise raises its own permission prompt on first use (§3.3).
 */
export function generateSettings(): PermissionSettings {
  return {
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
    permissions: { ...settings.permissions, allow: [...settings.permissions.allow, rule] },
  };
}
