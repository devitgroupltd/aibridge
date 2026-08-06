import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAlwaysRule, generateSettings, readSettingsFile, writeSettingsFile } from "../src/settings.ts";

// A rule written from the tools reference's canonical name, never a UI label.
const CANONICAL_TOOL_NAMES = new Set([
  "Read",
  "Grep",
  "TodoWrite",
  "NotebookRead",
  "Bash",
  "Edit",
  "Write",
  "Glob",
  "NotebookEdit",
]);

function ruleToolName(rule: string): string {
  const match = rule.match(/^([A-Za-z_]+(?:__[A-Za-z_]+)*)(?:\(.*\))?$/);
  return match?.[1] ?? rule;
}

describe("generateSettings", () => {
  const settings = generateSettings();

  // §9 scenario 11: git writes are in `ask`, not merely outside `allow`, and no bare Bash entry
  // appears there (a bare ask rule is skipped for sandboxed commands, §6.1.1).
  test("puts git commit and git push in ask, content-scoped", () => {
    expect(settings.permissions.ask).toContain("Bash(git commit *)");
    expect(settings.permissions.ask).toContain("Bash(git push *)");
  });

  test("no bare Bash ask rule exists anywhere in ask", () => {
    expect(settings.permissions.ask).not.toContain("Bash");
    expect(settings.permissions.ask).not.toContain("Bash(*)");
  });

  test("git commit/push never sit only in allow without also being in ask", () => {
    expect(settings.permissions.allow).not.toContain("Bash(git commit *)");
    expect(settings.permissions.allow).not.toContain("Bash(git push *)");
  });

  // §9 scenario 12: path rules use safe anchors and canonical tool names.
  test("every path-shaped rule is home-anchored, // absolute, or a bare gitignore-style name - never a single leading slash", () => {
    const allRules = [...settings.permissions.deny, ...settings.permissions.ask, ...settings.permissions.allow];
    for (const rule of allRules) {
      const pathMatch = rule.match(/^[A-Za-z_]+\((.+)\)$/);
      if (!pathMatch) continue;
      const arg = pathMatch[1] ?? "";
      const looksLikePath = arg.startsWith("/") || arg.startsWith("~") || arg.startsWith(".") || arg.includes("/");
      if (!looksLikePath) continue;
      expect(arg.startsWith("/") && !arg.startsWith("//")).toBe(false);
    }
  });

  test("no rule names Write(path), NotebookEdit(path) or Glob(path) - those tools' path rules are silently unconsulted", () => {
    const allRules = [...settings.permissions.deny, ...settings.permissions.ask, ...settings.permissions.allow];
    for (const rule of allRules) {
      expect(rule.startsWith("Write(")).toBe(false);
      expect(rule.startsWith("NotebookEdit(")).toBe(false);
      expect(rule.startsWith("Glob(")).toBe(false);
    }
  });

  test("every rule's tool name is canonical", () => {
    const allRules = [...settings.permissions.deny, ...settings.permissions.ask, ...settings.permissions.allow];
    for (const rule of allRules) {
      if (rule.startsWith("mcp__")) continue; // MCP tool names are their own namespace
      expect(CANONICAL_TOOL_NAMES.has(ruleToolName(rule))).toBe(true);
    }
  });

  test("pre-allows mcp__aibridge__reply so the relay's own reply tool doesn't self-prompt (§3.3)", () => {
    expect(settings.permissions.allow).toContain("mcp__aibridge__reply");
  });

  // Found live 2026-08-07: the 0.55.0 plugin cutover changed the real MCP tool name Claude Code
  // presents to `mcp__plugin_<plugin>_<server>__*`, but the allowlist still only listed the old bare
  // `mcp__aibridge__*` form, which no longer matched anything - every session's first reply/send_file
  // call silently stopped being pre-approved.
  test("pre-allows the plugin-scoped reply/send_file tool names actually presented post-0.55.0", () => {
    expect(settings.permissions.allow).toContain("mcp__plugin_aibridge-telegram_aibridge__reply");
    expect(settings.permissions.allow).toContain("mcp__plugin_aibridge-telegram_aibridge__send_file");
  });

  test("omits the hooks block entirely when no hook client path is given", () => {
    expect(settings.hooks).toBeUndefined();
  });
});

describe("generateSettings with a hook client path", () => {
  const hookPath = "C:\\data\\projects\\aibridge\\packages\\hook-client\\dist\\aibridge-hook.exe";
  const settings = generateSettings(hookPath);

  test("registers every §5.1 event, all declared async", () => {
    const events = [
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
    ];
    for (const event of events) {
      const entry = settings.hooks?.[event]?.[0]?.hooks[0];
      expect(entry?.type).toBe("command");
      expect(entry?.async).toBe(true);
      expect(entry?.command).toContain(hookPath);
    }
  });

  // §6.4: a second, synchronous PreToolUse entry matched to AskUserQuestion specifically, on top
  // of (not instead of) the async catch-all above.
  test("adds a synchronous AskUserQuestion-matched PreToolUse entry with an hour timeout", () => {
    const entries = settings.hooks?.PreToolUse;
    expect(entries).toHaveLength(2);
    const askEntry = entries?.[1];
    expect(askEntry?.matcher).toBe("AskUserQuestion");
    const hook = askEntry?.hooks[0];
    expect(hook?.async).toBe(false);
    expect(hook?.timeout).toBe(3600);
    expect(hook?.command).toContain(hookPath);
    expect(hook?.command).toContain("--ask");
  });
});

describe("writeSettingsFile / readSettingsFile", () => {
  let stateDir: string;

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("round-trips a generated settings file to disk", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-settings-"));
    const settings = generateSettings();
    const filePath = writeSettingsFile(stateDir, "test-session", settings);

    expect(filePath).toBe(path.join(stateDir, "sessions", "test-session", "settings.json"));
    expect(readSettingsFile(stateDir, "test-session")).toEqual(settings);
  });

  test("falls back to a fresh baseline when nothing has been written yet", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-settings-"));
    expect(readSettingsFile(stateDir, "never-launched")).toEqual(generateSettings());
  });
});

describe("addAlwaysRule", () => {
  test("appends a new rule to allow", () => {
    const settings = generateSettings();
    const updated = addAlwaysRule(settings, "Bash(npm test *)");
    expect(updated.permissions.allow).toContain("Bash(npm test *)");
  });

  test("is idempotent - adding the same rule twice does not duplicate it", () => {
    const settings = generateSettings();
    const once = addAlwaysRule(settings, "Bash(npm test *)");
    const twice = addAlwaysRule(once, "Bash(npm test *)");
    expect(twice.permissions.allow.filter((r) => r === "Bash(npm test *)")).toHaveLength(1);
  });

  test("does not mutate the input settings object", () => {
    const settings = generateSettings();
    const before = settings.permissions.allow.length;
    addAlwaysRule(settings, "Bash(npm test *)");
    expect(settings.permissions.allow.length).toBe(before);
  });

  test("preserves the hooks block rather than dropping it - an Always tap must not silently kill the feed", () => {
    const settings = generateSettings("C:\\path\\to\\aibridge-hook.exe");
    const updated = addAlwaysRule(settings, "Bash(npm test *)");
    expect(updated.hooks).toEqual(settings.hooks);
  });
});
