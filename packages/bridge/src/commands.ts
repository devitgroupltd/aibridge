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

/**
 * Recursively lists repo-defined skills under `.claude/skills/*&#47;SKILL.md` in the session's own
 * worktree - one level of subdirectory only (a skill is a directory, not an arbitrary nested file
 * tree, unlike `.claude/commands`), returning the directory name (e.g. `.claude/skills/plan-craft/`
 * -> `"plan-craft"`). A missing directory is a normal "no repo skills" case, not an error.
 */
export function listRepoSkills(worktreePath: string): string[] {
  const root = path.join(worktreePath, ".claude", "skills");
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (readdirSync(path.join(root, entry.name)).includes("SKILL.md")) names.push(entry.name);
    } catch {
      // unreadable subdirectory - skip it rather than fail the whole listing
    }
  }
  return names.sort();
}

/** Case-insensitive substring match against repo command/skill names, for `/commands <term>` and
 * `/skills <term>` - Telegram bot UX research (2026-08-04) on presenting long lists: search-as-
 * you-type is the standard fix for "too many items for buttons," not deeper pagination. An
 * empty/whitespace-only term is treated as "no filter" (returns `names` unchanged) rather than
 * matching nothing, so a bare `/commands`/`/skills` still shows the full list. */
export function filterNames(names: string[], term: string): string[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return names;
  return names.filter((name) => name.toLowerCase().includes(needle));
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/**
 * Builds the `/help` keyboard: built-in passthrough commands, then - only when there's at least
 * one - a single "Commands (N)"/"Skills (N)" button per category, never one button per item.
 * Individual per-item buttons don't scale (seowrite, confirmed live 2026-08-04: 43 repo commands,
 * 66 skills - a flat button list would either blow Telegram's ~100-button ceiling or just be
 * unusable well before that), so browsing a category always goes through `/commands`/`/skills`
 * (typed or tapped) rather than a button per name, even when there's currently only one or two -
 * one consistent path regardless of project size, instead of two UIs that diverge exactly when a
 * project grows past whatever the small-case threshold used to be.
 */
export function buildCommandKeyboard(repoCommands: string[], repoSkills: string[] = []): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = BUILTIN_PASSTHROUGH_COMMANDS.map((name) => [
    { text: `/${name}`, callback_data: `run:builtin:${name}` },
  ]);
  if (repoCommands.length > 0) rows.push([{ text: `Commands (${repoCommands.length})`, callback_data: "run:showcommands" }]);
  if (repoSkills.length > 0) rows.push([{ text: `Skills (${repoSkills.length})`, callback_data: "run:showskills" }]);
  return rows;
}

/**
 * How many names `renderCommandsListText`/`renderSkillsListText` will actually print before
 * falling back to a residual count - independent of button counts entirely now (there are no
 * per-item buttons to cap), this exists purely so a pathological project can't blow Telegram's
 * 4096-char message limit. At real seowrite scale (43 commands, 66 skills, confirmed live
 * 2026-08-04) every name still fits with room to spare.
 */
export const MAX_LISTED_NAMES = 60;

function formatNames(names: string[], prefix: string, narrowHint: string): string {
  const shown = names.slice(0, MAX_LISTED_NAMES).map((name) => `${prefix}${name}`);
  const restCount = names.length - shown.length;
  const suffix = restCount > 0 ? ` (+${restCount} more - narrow with ${narrowHint})` : "";
  return `${shown.join(", ")}${suffix}`;
}

/** `/commands [<term>]`'s reply text (and the "Commands (N)" button's payload, with `term`
 * omitted). An empty `repoCommands` is a normal "nothing defined" case, not an error. */
export function renderCommandsListText(repoCommands: string[], term = ""): string {
  const matches = filterNames(repoCommands, term);
  if (matches.length === 0) {
    return term ? `No repo commands matched "${term}".` : "No repo commands in this project.";
  }
  const header = term ? `Commands matching "${term}" (${matches.length}):` : `Repo commands (${matches.length}):`;
  return `${header}\n${formatNames(matches, "/cmd ", "/commands <term>")}`;
}

/** `/skills [<term>]`'s reply text (and the "Skills (N)" button's payload, with `term` omitted).
 * An empty `repoSkills` is a normal "nothing defined" case, not an error. */
export function renderSkillsListText(repoSkills: string[], term = ""): string {
  const matches = filterNames(repoSkills, term);
  if (matches.length === 0) {
    return term ? `No skills matched "${term}".` : "No skills in this project.";
  }
  const header = term ? `Skills matching "${term}" (${matches.length}):` : `Skills (${matches.length}):`;
  return `${header}\n${formatNames(matches, "/", "/skills <term>")}`;
}

export type CommandAction = { kind: "builtin"; name: BuiltinPassthroughCommand } | { kind: "show_commands" } | { kind: "show_skills" };

/**
 * Parses a `run:builtin:<name>` / `run:showcommands` / `run:showskills` callback_data string.
 * Only the builtin case is name-specific (and thus re-validated against the known set, since
 * callback_data is attacker-shaped input in principle - any client that can see the message can
 * send arbitrary callback_data for it); the other two are static actions with nothing to check
 * a name against.
 */
export function resolveCommandAction(data: string): CommandAction | null {
  if (data === "run:showcommands") return { kind: "show_commands" };
  if (data === "run:showskills") return { kind: "show_skills" };
  const builtinMatch = data.match(/^run:builtin:(.+)$/);
  if (builtinMatch) {
    const name = builtinMatch[1] ?? "";
    return isBuiltinPassthroughCommand(name) ? { kind: "builtin", name } : null;
  }
  return null;
}

/**
 * `/commands <name> [args]` (manual typing) and `/cmd <name> [args]` (kept as a synonym - it was
 * the original invocation syntax before per-item buttons were replaced with category browsing,
 * 2026-08-04) both resolve to this same shim: a plain instruction Claude reads like any other
 * inbound message, since `.claude/commands/*.md` invocation has no CLI-native keystroke path the
 * way `BUILTIN_PASSTHROUGH_COMMANDS` does.
 */
export function buildCmdShimText(name: string, args: string): string {
  const argsSuffix = args.trim().length > 0 ? args.trim() : "(none)";
  return `Read \`.claude/commands/${name}.md\` and carry out the workflow it defines, with arguments: ${argsSuffix}`;
}

/** Same shim idea as `buildCmdShimText`, for `.claude/skills/<name>/SKILL.md` - a skill is
 * normally invoked by typing `/<name>` in the interactive TUI, but that relies on the TUI's own
 * slash-command autocomplete firing on keystrokes, which the PTY passthrough used for
 * `BUILTIN_PASSTHROUGH_COMMANDS` isn't reliable for with a full pasted-in-one-go argument string
 * - so, like repo commands, this is sent as a plain instruction over the channel instead. */
export function buildSkillShimText(name: string, args: string): string {
  const argsSuffix = args.trim().length > 0 ? args.trim() : "(none)";
  return `Invoke the \`${name}\` skill (see \`.claude/skills/${name}/SKILL.md\`) with arguments: ${argsSuffix}`;
}

/**
 * `/cmd <name> [args]` or `/commands <name> [args]` typed manually - the only way to invoke a
 * specific repo command now that there's no per-item button (2026-08-04 redesign: category
 * buttons + browse-then-type replaced per-item buttons, see `buildCommandKeyboard`). Returns null
 * for anything that isn't this shape; the caller still has to check the extracted `name` against
 * `listRepoCommands`'s real result - this only parses syntax, same "not for us" vs. "for us, bad
 * name" split as `session-commands.ts`'s parser.
 */
export function parseCmdInvocation(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/(?:cmd|commands)\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/**
 * `/<name> [args]` typed manually, where `<name>` isn't any of the fleet/session/builtin commands
 * already handled earlier in `index.ts`'s dispatch chain. This is deliberately unvalidated syntax
 * extraction only - `/anything` matches - because at this point in the chain "not a real skill
 * name" and "ordinary chat text that happens to start with /" are indistinguishable without the
 * caller's own `listRepoSkills` result, so the caller must check `name` before acting on it and
 * let a non-match fall through untouched rather than treating every leading "/" as an error.
 */
export function parseSkillInvocation(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}
