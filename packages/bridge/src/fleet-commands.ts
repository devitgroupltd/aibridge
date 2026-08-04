import { escapeForFeed } from "./feed-escape.ts";
import type { Model } from "./session-commands.ts";
import { MODELS } from "./session-commands.ts";
import type { SessionRow } from "./session-store.ts";

/**
 * §4.2's fleet-scoped commands. `/new`/`/ls` are control-topic only (no target to act on besides
 * the fleet itself); `/kill`/`/rm`/`/attach`/`/pause` take an optional `<slug>` so they can be sent
 * from the control topic *or* bare from inside the session's own topic (§4.2: "`/kill` with no
 * argument inside a session topic kills that session").
 */
/**
 * `/rm`'s bulk forms (added 2026-08-04, live testing produced dozens of `dead` rows within a
 * single sitting with no way to clear them except one `/rm <slug>` at a time). Scoped to `dead`
 * rows only, always - a bulk command is exactly the kind of action a fat-fingered pattern
 * shouldn't be able to turn into an accidental mass-`/kill` of live sessions.
 */
export type RmBulkFilter = { mode: "dead" } | { mode: "prefix"; prefix: string };

export type FleetCommand =
  | { kind: "new"; repo: string; prompt: string; model?: Model }
  | { kind: "ls" }
  | { kind: "kill"; slug?: string }
  | { kind: "rm"; slug?: string; bulk?: RmBulkFilter }
  | { kind: "attach"; slug?: string }
  | { kind: "pause"; slug?: string }
  | { kind: "restart" };

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

function parseSlugArg(kind: "kill" | "attach" | "pause", rest: string): FleetCommand {
  const slug = rest.trim();
  return { kind, slug: slug.length > 0 ? slug : undefined };
}

/** `/rm --dead` removes every `dead`-state row; `/rm --prefix <text>` removes every `dead`-state
 * row whose slug starts with `<text>` (still `dead`-only, for the same reason `--dead` is - see
 * `RmBulkFilter`'s own note). Anything else falls through to the ordinary single-slug form. */
function parseRm(rest: string): FleetCommand {
  const trimmed = rest.trim();
  if (trimmed === "--dead") return { kind: "rm", bulk: { mode: "dead" } };
  const prefixMatch = trimmed.match(/^--prefix\s+(\S+)$/);
  if (prefixMatch?.[1]) return { kind: "rm", bulk: { mode: "prefix", prefix: prefixMatch[1] } };
  return { kind: "rm", slug: trimmed.length > 0 ? trimmed : undefined };
}

/** Returns null for anything that isn't one of these commands. A recognised command with a
 * malformed argument (e.g. `/new` with no repo) also returns null - same "not for us" vs.
 * "for us, but invalid" split as `session-commands.ts`'s parser. */
export function parseFleetCommand(text: string): FleetCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(new|ls|kill|rm|attach|pause|restart)\b(.*)$/s);
  if (!match) return null;
  const [, cmd, rest] = match as [string, string, string];
  switch (cmd) {
    case "new":
      return parseNew(rest);
    case "ls":
      return { kind: "ls" };
    case "restart":
      return { kind: "restart" };
    case "rm":
      return parseRm(rest);
    case "kill":
    case "attach":
    case "pause":
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

/** §4.2's `/ls`: slug, state, worktree, branch, age, model - session cost/tokens (§5.7) deferred.
 * Rendered as an HTML `<pre>` block (call sites must pass `parseMode: "HTML"`) so the columns line
 * up as a monospace table instead of Telegram's default proportional font. */
export function renderLsTable(rows: readonly SessionRow[], nowMs: number): string {
  if (rows.length === 0) return "No sessions.";
  const header = ["SLUG", "STATE", "MODEL", "BRANCH", "AGE"];
  const body = rows.map((r) => [r.slug, r.paused ? `${r.state} (paused)` : r.state, r.model, r.branch, ageLabel(r.createdUtc, nowMs)]);
  const [paddedHeader, ...paddedBody] = padColumns([header, ...body]);
  const headerLine = (paddedHeader as string[]).join("  ");
  const separator = "-".repeat(headerLine.length);
  const lines = [headerLine, separator, ...paddedBody.map((row) => row.join("  "))];
  return `<pre>${escapeForFeed(lines.join("\n"))}</pre>`;
}

/** §4.2's `/attach`: the PTY tail plus the local pickup command - both best-effort, same "takes it
 * on faith" convention as `/model`'s confirmation (§4.2.1). Markdown-style triple backticks render
 * as literal text without a matching `parse_mode`, so this uses the same HTML `<pre>` convention as
 * `renderLsTable` - callers must pass `parseMode: "HTML"`. */
export function renderAttach(row: SessionRow, tail: string): string {
  const resumeHint = row.sessionId ? `claude --resume ${row.sessionId}` : "(no session_id recorded yet)";
  return `${escapeForFeed(row.slug)} - last output:\n<pre>${escapeForFeed(tail)}</pre>\nLocal pickup: <code>${escapeForFeed(resumeHint)}</code>`;
}
