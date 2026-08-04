import { escapeForFeed } from "./feed-escape.ts";
import type { RepoEntry } from "./repos-registry.ts";
import type { Model } from "./session-commands.ts";
import { MODELS } from "./session-commands.ts";
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

/** §4.2's `/attach`: the PTY tail plus the local pickup command - both best-effort, same "takes it
 * on faith" convention as `/model`'s confirmation (§4.2.1). Markdown-style triple backticks render
 * as literal text without a matching `parse_mode`, so this uses the same HTML `<pre>` convention as
 * `renderLsTable` - callers must pass `parseMode: "HTML"`. */
export function renderAttach(row: SessionRow, tail: string): string {
  const resumeHint = row.sessionId ? `claude --resume ${row.sessionId}` : "(no session_id recorded yet)";
  return `${escapeForFeed(row.slug)} - last output:\n<pre>${escapeForFeed(tail)}</pre>\nLocal pickup: <code>${escapeForFeed(resumeHint)}</code>`;
}
