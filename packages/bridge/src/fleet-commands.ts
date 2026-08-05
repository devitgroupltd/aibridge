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
  | { kind: "deploy"; slug: string }
  | { kind: "settings" }
  | { kind: "autostart"; action: "status" | "install" | "uninstall" }
  | { kind: "repos"; action: "list" }
  | { kind: "repos"; action: "add"; name: string; path?: string; base?: string; model?: string }
  | { kind: "repos"; action: "rm"; name: string }
  | { kind: "voice"; model?: string };

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
 * `/repos [list]` / `/repos add <name> [<path>|<git-url>] [--base <branch>] [--model <model>]` /
 * `/repos rm|remove <name>` - §7.5's registry, made mutable from Telegram (`repos-registry.ts`'s
 * `addRepoEntry`/`removeRepoEntry`) instead of only by hand-editing the file. Bare `/repos` and
 * `/repos list` are the same as `/repos` itself is already the read path - `list` exists only so a
 * typed-out form matches `add`/`rm`'s shape. Neither `<name>` nor `<path>` accept embedded spaces,
 * same "no quoting" convention as every other fleet command's arguments (e.g. `/new`'s `<repo>`
 * token).
 *
 * `<path>` is optional - `index.ts`'s `handleReposCommand` fills it in (`inferDefaultRepoPath`) when
 * every already-registered repo shares one parent folder, or clones it first (`cloneRepo`) when the
 * token is a git URL (`isGitUrl`) rather than a local path. This parser only has to tell "no path
 * given" apart from "a flag came right after the name" (`/repos add foo --base main`), which is why
 * a leading `--` token is never consumed as the path.
 */
function parseRepos(rest: string): FleetCommand | null {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  const sub = tokens.length === 0 ? "list" : tokens.shift();
  if (sub === "list") return { kind: "repos", action: "list" };
  if (sub === "add") {
    const name = tokens.shift();
    if (!name) return null;
    const repoPath = tokens.length > 0 && !tokens[0]?.startsWith("--") ? tokens.shift() : undefined;
    let base: string | undefined;
    let model: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--base" && tokens[i + 1]) {
        base = tokens[++i];
      } else if (tokens[i] === "--model" && tokens[i + 1]) {
        model = tokens[++i];
      } else {
        return null;
      }
    }
    return { kind: "repos", action: "add", name, path: repoPath, base, model };
  }
  if (sub === "rm" || sub === "remove") {
    const name = tokens.shift();
    if (!name || tokens.length > 0) return null;
    return { kind: "repos", action: "rm", name };
  }
  return null;
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
  const match = trimmed.match(/^\/(new|ls|kill|rm|attach|pause|usage|budget|restart|deploy|settings|autostart|repos|voice)\b(.*)$/s);
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
    case "deploy": {
      const slug = rest.trim();
      return slug.length > 0 ? { kind: "deploy", slug } : null;
    }
    case "settings":
      return { kind: "settings" };
    case "autostart":
      return parseAutostart(rest);
    case "repos":
      return parseRepos(rest);
    case "voice": {
      const model = rest.trim();
      return { kind: "voice", model: model.length > 0 ? model : undefined };
    }
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
 * columns line up as a monospace table instead of Telegram's default proportional font.
 *
 * `detailBySlug` (added 2026-08-05): the `state` column alone only says a session is `working` or
 * `awaiting_input`, not *what* it's doing or *what* it's waiting on - the actually urgent question
 * when glancing at the fleet from a phone. `index.ts` builds this map from the same sources the
 * per-session turn card already reads (`feed-state.ts`'s current activity line for `working`,
 * `PermissionRegistry`/`AskRegistry`'s pending entries for `awaiting_input`) rather than inventing a
 * new state machine - this is a read-only join, not new tracked state. Rendered as a second section
 * below the table, one line per session that has something to say, so a fleet where nothing is
 * waiting doesn't grow an empty section. */
export function renderLsTable(
  rows: readonly SessionRow[],
  nowMs: number,
  costBySlug?: ReadonlyMap<string, number>,
  detailBySlug?: ReadonlyMap<string, string>,
): string {
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
  let text = `<pre>${escapeForFeed(lines.join("\n"))}</pre>`;
  const details = rows.map((r) => [r.slug, detailBySlug?.get(r.slug)] as const).filter(([, detail]) => detail !== undefined);
  if (details.length > 0) {
    const detailLines = details.map(([slug, detail]) => `  ${slug}: ${detail}`);
    text += `\n${escapeForFeed(detailLines.join("\n"))}`;
  }
  return text;
}

/** Elapsed-time label for a turn/wait duration already in milliseconds - `ageLabel`'s sibling, kept
 * separate since that one takes an ISO timestamp and this always takes a precomputed delta (a turn's
 * `turnStartedAtMs`, a pending permission/ask's `createdAt`). */
function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Truncates a tool-input preview to keep the `/ls` detail line short - the full text is already
 * available on the permission card itself in that session's own topic, this is just an at-a-glance
 * hint of *which* pending prompt it is. */
function truncatePreview(text: string, maxLen = 40): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/** Builds `renderLsTable`'s `detailBySlug` from the same sources the per-session turn card already
 * reads. Empty/absent for a session with nothing worth calling out (`idle`, `dead`, `quota_stopped`,
 * or a `working` session between hook events with no `feed-state.ts` line yet).
 *
 * Takes *two* clocks, not one - confirmed live 2026-08-05: a first pass that reused `nowMs` (wall
 * clock, matching `feed-state.ts`'s `turnStartedAtMs`) to also diff against
 * `PermissionRegistry`/`AskRegistry`'s `createdAt` produced a nonsense duration ("496088h12m"),
 * because those two registries stamp `createdAt` with `monotonicNowMs()` (§7.4 - never wall-clock,
 * so a suspend/resume can't mass-expire every pending prompt). Mixing the two clock bases in one
 * subtraction is exactly the silent-wrong failure mode §9 asks this kind of helper to be tested
 * against, not a crash - it would have shipped looking plausible. */
export function buildLsDetail(
  rows: readonly SessionRow[],
  nowMs: number,
  monotonicNowMs: number,
  feedStates: ReadonlyMap<string, { turnActive: boolean; turnStartedAtMs: number | null; lines: readonly { summary: string; status: string }[] }>,
  pendingPermissions: readonly { slug: string; toolName: string; inputPreview: string; createdAt: number }[],
  pendingAsks: readonly { slug: string; questions: readonly { question: string; answerLabel?: string }[]; createdAt: number }[],
): Map<string, string> {
  const detail = new Map<string, string>();
  for (const r of rows) {
    if (r.state === "working") {
      const state = feedStates.get(r.slug);
      const running = [...(state?.lines ?? [])].reverse().find((l) => l.status === "running");
      if (running && state?.turnStartedAtMs != null) {
        detail.set(r.slug, `running: ${truncatePreview(running.summary)} (${durationLabel(nowMs - state.turnStartedAtMs)})`);
      }
    } else if (r.state === "awaiting_input") {
      const permission = pendingPermissions.find((p) => p.slug === r.slug);
      if (permission) {
        detail.set(
          r.slug,
          `waiting: permission (${permission.toolName}: ${truncatePreview(permission.inputPreview)}) - ${durationLabel(monotonicNowMs - permission.createdAt)}`,
        );
        continue;
      }
      const ask = pendingAsks.find((a) => a.slug === r.slug);
      if (ask) {
        const unanswered = ask.questions.find((q) => q.answerLabel === undefined);
        detail.set(
          r.slug,
          `waiting: question${unanswered ? ` (${truncatePreview(unanswered.question)})` : ""} - ${durationLabel(monotonicNowMs - ask.createdAt)}`,
        );
        continue;
      }
      detail.set(r.slug, "waiting: reply");
    }
  }
  return detail;
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

/** `/repos [list]`: same registry `/settings` already shows a slice of, but as its own dedicated
 * command with a usage hint for `add`/`rm` underneath - `/settings` stays read-only (§7.5's original
 * "editing repos.toml is the only way in" model), this is the mutate-from-Telegram surface. */
export function renderReposList(repos: readonly RepoEntry[]): string {
  const lines = [`Registered repos (${repos.length}):`];
  if (repos.length === 0) {
    lines.push("  (none yet - /repos add <name> <path> to register one)");
  } else {
    for (const r of repos) {
      const extras = [r.base ? `base: ${r.base}` : null, r.model ? `default model: ${r.model}` : null].filter((x) => x !== null);
      lines.push(`  ${r.name} -> ${r.path}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`);
    }
  }
  lines.push(
    "",
    "/repos add <name> [path|git-url] [--base <branch>] [--model <model>] - register an already-cloned repo, clone a URL, or (if every repo above shares one parent folder) omit the path to reuse it",
    "/repos rm <name> - unregister one (leaves any existing worktree/session alone)",
  );
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
    "  /about - what this bot can do, with examples (start here if you're new)",
    "  /new [--model] <repo> <prompt> - start a new session",
    "  /ls - list sessions, with what's running/waiting on each",
    "  /kill [<slug>|--all] - stop a session (or all, confirm-gated)",
    "  /rm [<slug>|--dead|--prefix <text>|--all] - remove a dead session row",
    "  /attach [<slug>] - show a session's PTY tail",
    "  /pause [<slug>] - pause a session",
    "  /usage [<slug>] - token/cost usage",
    "  /budget - fleet spend (5h/7d)",
    "  /restart - restart the Bridge daemon",
    "  /deploy <slug> - merge that session's branch into its repo, run tests, and (if the repo is",
    "    aibridge's own) restart the Bridge to pick up the fix (§5.9)",
    "  /settings - registered repos + concurrency budget",
    "  /repos [list|add <name> [path|git-url] [--base <b>] [--model <m>]|rm <name>] - manage repos.toml",
    "  /autostart [status|install|uninstall] - manage the logon Task Scheduler entry",
    "  /voice [<model>] - show/switch the Whisper model used for voice-note transcription",
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
    { command: "about", description: "What this bot can do, with examples" },
    { command: "new", description: "Start a new session: /new [--model] <repo> <prompt>" },
    { command: "ls", description: "List sessions, with what's running/waiting on each" },
    { command: "kill", description: "Stop a session: /kill [<slug>|--all]" },
    { command: "rm", description: "Remove a dead session row: /rm [<slug>|--dead|--prefix <text>|--all]" },
    { command: "attach", description: "Show a session's PTY tail" },
    { command: "pause", description: "Pause a session" },
    { command: "usage", description: "Token/cost usage" },
    { command: "budget", description: "Fleet spend (5h/7d)" },
    { command: "restart", description: "Restart the Bridge daemon" },
    { command: "deploy", description: "Merge a session's branch and run tests: /deploy <slug> (restarts if it's aibridge's own repo)" },
    { command: "settings", description: "Registered repos + concurrency budget" },
    { command: "repos", description: "Manage repos.toml: list|add <name> [path|git-url]|rm <name>" },
    { command: "autostart", description: "Manage the logon Task Scheduler entry: status|install|uninstall" },
    { command: "voice", description: "Show/switch the Whisper model used for voice-note transcription" },
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
