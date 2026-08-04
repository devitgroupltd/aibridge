import { escapeForFeed } from "./feed-escape.ts";
import type { RepoEntry } from "./repos-registry.ts";
import type { Model } from "./session-commands.ts";
import { EFFORTS, MODELS, MODES } from "./session-commands.ts";
import type { SessionRow } from "./session-store.ts";

/**
 * §4.2's fleet-scoped commands. `/new`/`/ls`/`/budget` are control-topic only (no target to act on
 * besides the fleet itself); `/kill`/`/rm`/`/attach`/`/pause`/`/usage` take an optional `<slug>` so
 * they can be sent from the control topic *or* bare from inside the session's own topic (§4.2:
 * "`/kill` with no argument inside a session topic kills that session").
 */
/**
 * `/rm`'s bulk forms (added 2026-08-04, live testing produced dozens of `dead` rows within a
 * single sitting with no way to clear them except one `/rm <slug>` at a time). `--dead`/`--prefix`
 * are scoped to `dead` rows only, always - a bulk command is exactly the kind of action a
 * fat-fingered pattern shouldn't be able to turn into an accidental mass-`/kill` of live sessions.
 * `--all` (added 2026-08-04) is the deliberate exception - it can remove live sessions too, which
 * is why `index.ts` routes it through the `/kill --all` confirm-button flow (fleet-confirm.ts)
 * instead of executing on the same message, unlike its `dead`-only siblings here.
 */
export type RmBulkFilter = { mode: "dead" } | { mode: "prefix"; prefix: string } | { mode: "all" };

export type FleetCommand =
  | { kind: "new"; repo: string; prompt: string; model?: Model }
  | { kind: "ls" }
  | { kind: "kill"; slug?: string; all?: boolean }
  | { kind: "rm"; slug?: string; bulk?: RmBulkFilter }
  | { kind: "attach"; slug?: string }
  | { kind: "pause"; slug?: string }
  | { kind: "usage"; slug?: string }
  | { kind: "budget" }
  | { kind: "restart" }
  | { kind: "settings" }
  | { kind: "autostart"; action: "status" | "install" | "uninstall" };

const MODEL_FLAG_RE = new RegExp(`^--(${MODELS.join("|")})$`);

/** `/new [--opus|--haiku|--fable|--sonnet] <repo> <prompt...>` - the flag, if present, must come
 * immediately after `/new`, matching the plan's own `[--opus|--haiku] <repo> <prompt>` ordering. */
function parseNew(rest: string): FleetCommand | null {
  const tokens = rest.trim().split(/\s+/);
  let model: Model | undefined;
  if (tokens[0] && MODEL_FLAG_RE.test(tokens[0])) {
    const flagMatch = tokens[0].match(MODEL_FLAG_RE);
    model = flagMatch?.[1] as Model;
    tokens.shift();
  }
  const repo = tokens.shift();
  const prompt = tokens.join(" ");
  if (!repo || !prompt) return null;
  return { kind: "new", repo, prompt, model };
}

function parseSlugArg(kind: "attach" | "pause" | "usage", rest: string): FleetCommand {
  const slug = rest.trim();
  return { kind, slug: slug.length > 0 ? slug : undefined };
}

/** `/kill --all` requests fleet-confirm-gated (`index.ts`, fleet-confirm.ts) termination of every
 * live session. Anything else falls through to the ordinary single-slug form. */
function parseKill(rest: string): FleetCommand {
  const trimmed = rest.trim();
  if (trimmed === "--all") return { kind: "kill", all: true };
  return { kind: "kill", slug: trimmed.length > 0 ? trimmed : undefined };
}

/** `/rm --dead` removes every `dead`-state row; `/rm --prefix <text>` removes every `dead`-state
 * row whose slug starts with `<text>` (still `dead`-only, for the same reason `--dead` is - see
 * `RmBulkFilter`'s own note); `/rm --all` requests fleet-confirm-gated removal of every session
 * regardless of state. Anything else falls through to the ordinary single-slug form. */
function parseRm(rest: string): FleetCommand {
  const trimmed = rest.trim();
  if (trimmed === "--dead") return { kind: "rm", bulk: { mode: "dead" } };
  if (trimmed === "--all") return { kind: "rm", bulk: { mode: "all" } };
  const prefixMatch = trimmed.match(/^--prefix\s+(\S+)$/);
  if (prefixMatch?.[1]) return { kind: "rm", bulk: { mode: "prefix", prefix: prefixMatch[1] } };
  return { kind: "rm", slug: trimmed.length > 0 ? trimmed : undefined };
}

/** `/autostart` with no argument defaults to `status`; anything besides `status`/`install`/
 * `uninstall` is a malformed argument, not a different command. */
function parseAutostart(rest: string): FleetCommand | null {
  const trimmed = rest.trim();
  const action = trimmed.length === 0 ? "status" : trimmed;
  if (action !== "status" && action !== "install" && action !== "uninstall") return null;
  return { kind: "autostart", action };
}

/**
 * Telegram's own "/" autocomplete popup inserts "@<botusername>" right after the command name in
 * a group chat (confirmed live 2026-08-04 - see CLAUDE.md's live-verification note), so a tapped
 * suggestion arrives as e.g. `/kill@om_aibridge_control_bot slug` rather than `/kill slug`. Every
 * command match in this codebase (`parseFleetCommand`, `parseSessionCommand`, the `/help` exact
 * checks, `isBuiltinPassthroughCommand`) assumes a bare `/command` - without stripping the mention
 * first, a tapped suggestion would silently match nothing and fall through as plain chat text
 * instead of running the command. Only a mention directly following the leading `/word` with no
 * intervening space is stripped, matching exactly what Telegram inserts - a genuine `@name`
 * anywhere else in a real message (e.g. actual conversational text) is left untouched.
 */
export function stripBotMention(text: string): string {
  return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+\b/, "$1");
}

/**
 * `/help`/`/?`/`/h` (plus bare `?`, control-topic only - ambiguous with real chat text inside a
 * session topic): the fixed fleet+session command reference, never filtered. `/commands`
 * (formerly a `/help` alias, repurposed 2026-08-04 - see `parseCommandsQuery`) and `/skills` are
 * the ones that take a search term, since they're the ones whose item count actually scales with
 * the project.
 */
export function isHelpCommand(text: string, isControl: boolean): boolean {
  const trimmed = text.trim();
  if (trimmed === "?") return isControl;
  return trimmed === "/help" || trimmed === "/?" || trimmed === "/h";
}

/**
 * `/commands [<term>]` - lists the session's own `.claude/commands/**\/*.md`, optionally filtered.
 * Repurposed 2026-08-04 from a bare `/help` alias: once real projects showed up with 40+ repo
 * commands (seowrite, confirmed live) a flat per-item button list couldn't scale, and per Telegram
 * bot UX convention the fix for "too many items for buttons" is search-as-you-type browsing via a
 * dedicated command, not deeper pagination. Returns null for anything that isn't this command,
 * distinct from `{ term: "" }` (recognised, no filter given - list everything).
 */
export function parseCommandsQuery(text: string): { term: string } | null {
  const match = text.trim().match(/^\/commands(?:\s+(.+))?$/);
  if (!match) return null;
  return { term: (match[1] ?? "").trim() };
}

/** `/skills [<term>]` - same idea as `parseCommandsQuery`, for `.claude/skills/*`. */
export function parseSkillsQuery(text: string): { term: string } | null {
  const match = text.trim().match(/^\/skills(?:\s+(.+))?$/);
  if (!match) return null;
  return { term: (match[1] ?? "").trim() };
}

/** Returns null for anything that isn't one of these commands. A recognised command with a
 * malformed argument (e.g. `/new` with no repo) also returns null - same "not for us" vs.
 * "for us, but invalid" split as `session-commands.ts`'s parser. */
export function parseFleetCommand(text: string): FleetCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(new|ls|kill|rm|attach|pause|usage|budget|restart|settings|autostart)\b(.*)$/s);
  if (!match) return null;
  const [, cmd, rest] = match as [string, string, string];
  switch (cmd) {
    case "new":
      return parseNew(rest);
    case "ls":
      return { kind: "ls" };
    case "budget":
      return { kind: "budget" };
    case "restart":
      return { kind: "restart" };
    case "settings":
      return { kind: "settings" };
    case "autostart":
      return parseAutostart(rest);
    case "rm":
      return parseRm(rest);
    case "kill":
      return parseKill(rest);
    case "attach":
    case "pause":
    case "usage":
      return parseSlugArg(cmd, rest);
    default:
      return null;
  }
}

function ageLabel(createdUtc: string, nowMs: number): string {
  const ms = nowMs - new Date(createdUtc).getTime();
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Left-pads every row's cells to its column's widest entry - Telegram has no real table markup,
 * but a monospace `<pre>` block (§5.3 already relies on the same tag for the feed card) renders
 * space-padded columns aligned on every client, which is the closest fake-a-table gets without one. */
function padColumns(rows: readonly string[][]): string[][] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)));
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** §4.2's `/ls`: slug, state, worktree, branch, age, model, and (§5.7, added 2026-08-04) lifetime
 * cost per session, sourced from `cost-tracker.ts` and keyed by `session_id` - `costBySlug` is
 * optional so every existing caller/test that only cares about the lifecycle columns is unaffected,
 * and a session with no `session_id` yet (or simply no recorded spend) shows `$0.00` rather than a
 * blank cell. Rendered as an HTML `<pre>` block (call sites must pass `parseMode: "HTML"`) so the
 * columns line up as a monospace table instead of Telegram's default proportional font. */
export function renderLsTable(rows: readonly SessionRow[], nowMs: number, costBySlug?: ReadonlyMap<string, number>): string {
  if (rows.length === 0) return "No sessions.";
  const header = ["SLUG", "STATE", "MODEL", "BRANCH", "AGE", "COST"];
  const body = rows.map((r) => [
    r.slug,
    r.paused ? `${r.state} (paused)` : r.state,
    r.model,
    r.branch,
    ageLabel(r.createdUtc, nowMs),
    formatUsd(costBySlug?.get(r.slug) ?? 0),
  ]);
  const [paddedHeader, ...paddedBody] = padColumns([header, ...body]);
  const headerLine = (paddedHeader as string[]).join("  ");
  const separator = "-".repeat(headerLine.length);
  const lines = [headerLine, separator, ...paddedBody.map((row) => row.join("  "))];
  return `<pre>${escapeForFeed(lines.join("\n"))}</pre>`;
}

/** §10.5 point 2's `/budget`: rolling 5-hour and weekly fleet spend, plus a per-session breakdown
 * sorted highest-spend-first so the session actually driving the number is the first thing visible.
 * `perSessionFiveHour` only lists sessions with nonzero 5h spend - a fleet of mostly-idle sessions
 * shouldn't produce a wall of `$0.00` rows. */
export function renderBudget(fleetFiveHour: number, fleetWeekly: number, perSessionFiveHour: ReadonlyMap<string, number>): string {
  const lines = [`Fleet spend - last 5h: ${formatUsd(fleetFiveHour)} · last 7d: ${formatUsd(fleetWeekly)}`];
  const nonzero = [...perSessionFiveHour.entries()].filter(([, cost]) => cost > 0).sort((a, b) => b[1] - a[1]);
  if (nonzero.length > 0) {
    lines.push("", "Last 5h by session:");
    for (const [slug, cost] of nonzero) {
      lines.push(`  ${slug}: ${formatUsd(cost)}`);
    }
  }
  return escapeForFeed(lines.join("\n"));
}

/** `/settings`: a read-only card for the machine-level config an operator can't see from `/ls`
 * (registered repos, the weighted concurrency budget) - control-topic only, same reasoning as
 * `/budget` (there's no single session to scope this to). */
export function renderSettings(repos: readonly RepoEntry[], concurrency: { current: number; cap: number }): string {
  const lines = ["Bridge settings:", "", `Registered repos (${repos.length}):`];
  if (repos.length === 0) {
    lines.push("  (none - add one to repos.toml, §7.5)");
  } else {
    for (const r of repos) {
      lines.push(`  ${r.name} -> ${r.path}${r.model ? ` (default model: ${r.model})` : ""}`);
    }
  }
  lines.push("", `Concurrency: ${concurrency.current} / ${concurrency.cap} weighted units (§10.5)`);
  return escapeForFeed(lines.join("\n"));
}

/** `/help`: the fixed fleet- and session-scoped command reference, plain text (no `parse_mode`,
 * unlike the other render functions here - the `/help` call site sends it alongside the
 * built-in/category button keyboard, not in place of it). `/commands`/`/skills` are the
 * per-project, item-count-scoped lists (see `commands.ts`'s `renderCommandsListText`/
 * `renderSkillsListText`) - this only covers what's fixed regardless of project. */
export function renderHelp(): string {
  return [
    "Fleet commands (control topic; also /help, /?, /h, or bare ? here):",
    "  /new [--model] <repo> <prompt> - start a new session",
    "  /ls - list sessions",
    "  /kill [<slug>|--all] - stop a session (or all, confirm-gated)",
    "  /rm [<slug>|--dead|--prefix <text>|--all] - remove a dead session row",
    "  /attach [<slug>] - show a session's PTY tail",
    "  /pause [<slug>] - pause a session",
    "  /usage [<slug>] - token/cost usage",
    "  /budget - fleet spend (5h/7d)",
    "  /restart - restart the Bridge daemon",
    "  /settings - registered repos + concurrency budget",
    "  /autostart [status|install|uninstall] - manage the logon Task Scheduler entry",
    "",
    "Session commands (inside a session's own topic):",
    `  /model <${MODELS.join("|")}>`,
    `  /mode <${MODES.join("|")}>`,
    `  /effort <${EFFORTS.join("|")}>`,
    "  /commands [<term>] - list this project's .claude/commands",
    "  /skills [<term>] - list this project's .claude/skills",
    "",
    "Built-in passthrough is below - tap a button, or type /compact or /clear directly:",
  ].join("\n");
}

/** Drives `index.ts`'s startup `setMyCommands` call - Telegram's native "/" autocomplete popup
 * (`telegram.ts`'s `BotCommand`/`setMyCommands`). Mirrors `renderHelp()`'s content, minus the
 * `/?`/`/h`/bare-`?` aliases: Telegram command names are restricted to `[a-z0-9_]`, so those three
 * have no representable form here. The Bot API has no per-forum-topic command scope (only whole-chat
 * scopes), so this single list necessarily includes both fleet- and session-scoped commands together
 * - a suggestion tapped from the wrong topic just falls through to the existing wrong-topic rejection
 * the text parser already sends, rather than being filtered out by Telegram itself. */
export function botCommandList(): { command: string; description: string }[] {
  return [
    { command: "new", description: "Start a new session: /new [--model] <repo> <prompt>" },
    { command: "ls", description: "List sessions" },
    { command: "kill", description: "Stop a session: /kill [<slug>|--all]" },
    { command: "rm", description: "Remove a dead session row: /rm [<slug>|--dead|--prefix <text>|--all]" },
    { command: "attach", description: "Show a session's PTY tail" },
    { command: "pause", description: "Pause a session" },
    { command: "usage", description: "Token/cost usage" },
    { command: "budget", description: "Fleet spend (5h/7d)" },
    { command: "restart", description: "Restart the Bridge daemon" },
    { command: "settings", description: "Registered repos + concurrency budget" },
    { command: "autostart", description: "Manage the logon Task Scheduler entry: status|install|uninstall" },
    { command: "help", description: "Show the full command list" },
    { command: "model", description: `Set model: /model <${MODELS.join("|")}>` },
    { command: "mode", description: `Set mode: /mode <${MODES.join("|")}>` },
    { command: "effort", description: `Set effort: /effort <${EFFORTS.join("|")}>` },
    { command: "commands", description: "List this project's .claude/commands: /commands [<term>]" },
    { command: "skills", description: "List this project's .claude/skills: /skills [<term>]" },
    { command: "compact", description: "Compact the session's conversation" },
    { command: "clear", description: "Clear the session's conversation" },
  ];
}

/** §4.2's `/attach`: the PTY tail plus the local pickup command - both best-effort, same "takes it
 * on faith" convention as `/model`'s confirmation (§4.2.1). Markdown-style triple backticks render
 * as literal text without a matching `parse_mode`, so this uses the same HTML `<pre>` convention as
 * `renderLsTable` - callers must pass `parseMode: "HTML"`. */
export function renderAttach(row: SessionRow, tail: string): string {
  const resumeHint = row.sessionId ? `claude --resume ${row.sessionId}` : "(no session_id recorded yet)";
  return `${escapeForFeed(row.slug)} - last output:\n<pre>${escapeForFeed(tail)}</pre>\nLocal pickup: <code>${escapeForFeed(resumeHint)}</code>`;
}
