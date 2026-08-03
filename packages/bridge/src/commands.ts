import type { Dirent } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * CLI-native slash commands that only make sense injected as literal keystrokes into the TUI's
 * input box - there is no `.claude/commands/*.md` file for them to read, so the `/cmd` shim
 * (§4.2 of the plan) cannot reach them at all. They're forwarded raw, bypassing
 * `renderChannelTag`, reusing the same "type it like a human would" primitive §10.1.2 already
 * uses for the dev-channels and MCP-consent keystrokes.
 */
export const BUILTIN_PASSTHROUGH_COMMANDS = ["compact", "clear"] as const;
export type BuiltinPassthroughCommand = (typeof BUILTIN_PASSTHROUGH_COMMANDS)[number];

export function isBuiltinPassthroughCommand(name: string): name is BuiltinPassthroughCommand {
  return (BUILTIN_PASSTHROUGH_COMMANDS as readonly string[]).includes(name);
}

/**
 * Recursively lists repo-defined slash commands under `.claude/commands/**\/*.md` in the
 * session's own worktree (not the source repo - a worktree can drift), returning posix-style
 * names with no extension (e.g. `.claude/commands/review/pre-push.md` -> `"review/pre-push"`).
 * A missing directory is a normal "no repo commands" case, not an error.
 */
export function listRepoCommands(worktreePath: string): string[] {
  const root = path.join(worktreePath, ".claude", "commands");
  const names: string[] = [];

  function walk(dir: string, prefix: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        names.push(rel.slice(0, -3));
      }
    }
  }

  walk(root, "");
  return names.sort();
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Builds the `/help` command-list keyboard: built-in passthrough commands, then repo commands. */
export function buildCommandKeyboard(repoCommands: string[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = BUILTIN_PASSTHROUGH_COMMANDS.map((name) => [
    { text: `/${name}`, callback_data: `run:builtin:${name}` },
  ]);
  for (const name of repoCommands) {
    rows.push([{ text: `/cmd ${name}`, callback_data: `run:cmd:${name}` }]);
  }
  return rows;
}

export type CommandAction = { kind: "builtin"; name: BuiltinPassthroughCommand } | { kind: "cmd"; name: string };

/**
 * Parses a `run:builtin:<name>` / `run:cmd:<name>` callback_data string, re-validating against
 * the known command sets rather than trusting the tap - callback_data is attacker-shaped input
 * in principle (any client that can see the message can send arbitrary callback_data for it), so
 * an unrecognized or tampered value returns null instead of being forwarded to the PTY.
 */
export function resolveCommandAction(data: string, repoCommands: string[]): CommandAction | null {
  const builtinMatch = data.match(/^run:builtin:(.+)$/);
  if (builtinMatch) {
    const name = builtinMatch[1] ?? "";
    return isBuiltinPassthroughCommand(name) ? { kind: "builtin", name } : null;
  }
  const cmdMatch = data.match(/^run:cmd:(.+)$/);
  if (cmdMatch) {
    const name = cmdMatch[1] ?? "";
    return repoCommands.includes(name) ? { kind: "cmd", name } : null;
  }
  return null;
}

/** §4.2's `/cmd` shim text: a plain instruction Claude reads like any other inbound message. */
export function buildCmdShimText(name: string, args: string): string {
  const argsSuffix = args.trim().length > 0 ? args.trim() : "(none)";
  return `Read \`.claude/commands/${name}.md\` and carry out the workflow it defines, with arguments: ${argsSuffix}`;
}
