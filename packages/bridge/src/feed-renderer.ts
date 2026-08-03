import { escapeForFeed } from "./feed-escape.ts";
import type { ActivityLine, FeedState } from "./feed-state.ts";

/** §5.3: at most 8 activity lines render on the card itself; anything older rolls into a counter.
 * The full log always exists in `state.lines` - `renderDetails` below is the only thing that
 * reads past this cap (§5.5's `details` button). */
const MAX_VISIBLE_LINES = 8;

function icon(status: ActivityLine["status"]): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  return "⠸";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** `<code>` rather than `<pre>` for the summary itself - it's an inline snippet, not a block, and
 * every value is escaped before interpolation (§9 scenario 21). */
function renderLine(line: ActivityLine): string {
  const summary = escapeForFeed(line.summary);
  const errorSuffix = line.status === "failed" && line.error ? ` — ${escapeForFeed(line.error)}` : "";
  return `  ${icon(line.status)} <code>${summary}</code>${errorSuffix}`;
}

/** One message per turn, edited in place (§5.3). `nowMs` is passed in rather than read internally
 * so the coalescing scheduler (rate-governor.ts) controls time, and so this stays as easy to unit
 * test as everything else here. */
export function renderCard(state: FeedState, nowMs: number): string {
  const stateWord = state.turnActive ? "working" : "idle";
  const durationMs = state.turnStartedAtMs !== null ? nowMs - state.turnStartedAtMs : 0;
  const header = `🔨 <b>${escapeForFeed(state.slug)}</b> · ${stateWord} (${formatDuration(durationMs)})`;

  const total = state.lines.length;
  const visible = total > MAX_VISIBLE_LINES ? state.lines.slice(total - MAX_VISIBLE_LINES) : state.lines;
  const overflow = total - visible.length;

  const parts = [header, ""];
  if (overflow > 0) {
    parts.push(`  …and ${overflow} earlier steps`);
  }
  parts.push(...visible.map(renderLine));
  return parts.join("\n");
}

/** §5.5's `details` button target: the complete, untruncated per-turn log. */
export function renderDetails(state: FeedState): string {
  if (state.lines.length === 0) return "No activity recorded for this turn.";
  return state.lines.map(renderLine).join("\n");
}
