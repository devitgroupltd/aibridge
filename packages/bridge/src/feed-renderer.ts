import { escapeForFeed } from "./feed-escape.ts";
import type { ActivityLine, FeedState } from "./feed-state.ts";
import type { FeedDetailLevel } from "./session-store.ts";

/** §5.3: at most 8 activity lines render on the card itself; anything past that splits into a
 * head + tail (see `HEAD_LINES`) with the gap reported as a counter. The full log always exists in
 * `state.lines` - `renderDetails` below is the only thing that reads past this cap (§5.5's `details`
 * button). Applies to `detail: "compact"` only - "full"'s lines are each bigger (an expandable
 * blockquote per line), so it's bounded by `MAX_CARD_CHARS` below instead of a fixed count. */
const MAX_VISIBLE_LINES = 8;

/** How many of the *oldest* visible lines lead the card once there are more lines than fit.
 * Operator feedback (2026-08-07): a long turn's card showing only its newest lines behind an opaque
 * "…and N earlier steps" counter, with no hint of how the turn actually started, was hard to follow.
 * Splitting into head + tail keeps that starting context alongside the most recent activity, at the
 * cost of a few tail lines (`MAX_VISIBLE_LINES - HEAD_LINES` remain for the tail in compact mode). */
const HEAD_LINES = 3;

/** §5.9's `/detail full`: how many lines fit is size-driven, not count-driven, since each one now
 * carries a blockquote of unpredictable length. Comfortably under Telegram's real 4096-UTF-16-unit
 * message cap, leaving headroom for the header and this function's own HTML markup overhead. */
const MAX_CARD_CHARS = 3800;

export interface FeedRenderSettings {
  detail: FeedDetailLevel;
  verbose: boolean;
}

const COMPACT_SETTINGS: FeedRenderSettings = { detail: "compact", verbose: false };

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

/** §5.9's `/detail full`: the compact line stays as the always-visible summary, followed by a
 * `<blockquote expandable>` - collapsed by default, one tap to open, native to the client since
 * Bot API 7.3 - carrying the untruncated input and (only with `verbose`) the tool's actual output.
 * A note line (`fullInput` unset, e.g. "compacting context…") renders identically to the compact
 * form - there's nothing more to expand. */
function renderLineFull(line: ActivityLine, verbose: boolean): string {
  const head = renderLine(line);
  if (!line.fullInput) return head;
  const bodyParts = [escapeForFeed(line.fullInput)];
  if (verbose && line.output) {
    bodyParts.push("", escapeForFeed(line.output));
  }
  return `${head}\n<blockquote expandable>${bodyParts.join("\n")}</blockquote>`;
}

/** One message per turn, edited in place (§5.3). `nowMs` is passed in rather than read internally
 * so the coalescing scheduler (rate-governor.ts) controls time, and so this stays as easy to unit
 * test as everything else here. `settings` defaults to compact/off - every existing call site (and
 * every existing test) that doesn't know about §5.9 yet keeps today's exact output. */
export function renderCard(state: FeedState, nowMs: number, settings: FeedRenderSettings = COMPACT_SETTINGS): string {
  const stateWord = state.turnActive ? "working" : "idle";
  const durationMs = state.turnStartedAtMs !== null ? nowMs - state.turnStartedAtMs : 0;
  // A card past the first for this turn (`cardLineOffset > 0`, index.ts's `splitCard`) is labelled
  // "(cont'd)" - without it, a fresh card with only a couple of lines and no visible link back to
  // the turn it belongs to reads as a new, unrelated turn rather than a continuation of a long one.
  const continued = (state.cardLineOffset ?? 0) > 0 ? " (cont’d)" : "";
  const header = `🔨 <b>${escapeForFeed(state.slug)}</b> · ${stateWord} (${formatDuration(durationMs)})${continued}`;
  const currentCardLines = state.lines.slice(state.cardLineOffset ?? 0);

  /** `  …N additional steps…` between a head and tail slice, or nothing when there's no gap. */
  function gapLine(omitted: number): string[] {
    return omitted > 0 ? [`  …${omitted} additional step${omitted === 1 ? "" : "s"}…`] : [];
  }

  if (settings.detail === "compact") {
    const total = currentCardLines.length;
    const parts = [header, ""];
    if (total <= MAX_VISIBLE_LINES) {
      parts.push(...currentCardLines.map(renderLine));
      return parts.join("\n");
    }
    const tailCount = MAX_VISIBLE_LINES - HEAD_LINES;
    const head = currentCardLines.slice(0, HEAD_LINES);
    const tail = currentCardLines.slice(total - tailCount);
    parts.push(...head.map(renderLine), ...gapLine(total - HEAD_LINES - tailCount), ...tail.map(renderLine));
    return parts.join("\n");
  }

  // "full": size-driven instead of count-driven (see MAX_CARD_CHARS), but the same head + tail idea
  // as compact - a small anchor from the start (capped at 30% of the budget, so it can't crowd out
  // the tail, which matters more) plus as much of the end as still fits, walked backwards same as
  // before this changed. Renders everything with no split at all when it simply all fits.
  const budget = MAX_CARD_CHARS - header.length;
  const rendered = currentCardLines.map((line) => renderLineFull(line, settings.verbose));
  const totalLen = rendered.reduce((sum, text) => sum + text.length + 1, 0);
  const parts = [header, ""];
  if (totalLen <= budget) {
    parts.push(...rendered);
    return parts.join("\n");
  }

  const headBudget = budget * 0.3;
  let headUsed = 0;
  let headCount = 0;
  while (headCount < HEAD_LINES && headCount < rendered.length) {
    const len = (rendered[headCount] as string).length + 1;
    if (headUsed + len > headBudget) break;
    headUsed += len;
    headCount += 1;
  }
  let tailUsed = 0;
  let tailCount = 0;
  for (let i = rendered.length - 1; i >= headCount; i--) {
    const len = (rendered[i] as string).length + 1;
    if (headUsed + tailUsed + len > budget) break;
    tailUsed += len;
    tailCount += 1;
  }
  parts.push(...rendered.slice(0, headCount), ...gapLine(rendered.length - headCount - tailCount), ...rendered.slice(rendered.length - tailCount));
  return parts.join("\n");
}

/** §5.5's `details` button target - one line per activity, same shape it's always had. Shows each
 * line's full (not 80-char-truncated) input regardless of the session's own `/detail` setting -
 * this is already an explicit tap, the same "you asked for it" reasoning an expandable blockquote
 * relies on - but only appends a tool's actual output when `verbose` is true, so the bigger §8.2
 * concern (routinely surfacing arbitrary tool output) stays behind that switch even here. No
 * blockquote here (unlike the card's own "full" mode) - this view already exists to show
 * everything at once, so there's nothing left to collapse. */
function renderDetailLine(line: ActivityLine, verbose: boolean): string {
  const text = escapeForFeed(line.fullInput ?? line.summary);
  const errorSuffix = line.status === "failed" && line.error ? ` — ${escapeForFeed(line.error)}` : "";
  const head = `  ${icon(line.status)} <code>${text}</code>${errorSuffix}`;
  return verbose && line.output ? `${head}\n    → <code>${escapeForFeed(line.output)}</code>` : head;
}

/** §5.5's `details` button target: the complete, untruncated per-turn log, HTML-formatted the
 * same way as the card itself - the caller is expected to send this with `parse_mode: "HTML"`. */
export function renderDetails(state: FeedState, verbose = false): string {
  if (state.lines.length === 0) return "No activity recorded for this turn.";
  return state.lines.map((line) => renderDetailLine(line, verbose)).join("\n");
}

/** Same content as `renderDetails`, but plain text - no `<code>` tags, no HTML-entity escaping.
 * §5.5's oversized-log path sends this as a `.txt` document instead of a chat message; a document
 * viewer has no HTML renderer, so `renderDetails`'s markup would show up as literal tag/entity
 * soup instead of being invisible formatting. */
export function renderDetailsPlainText(state: FeedState, verbose = false): string {
  if (state.lines.length === 0) return "No activity recorded for this turn.";
  return state.lines
    .map((line) => {
      const errorSuffix = line.status === "failed" && line.error ? ` — ${line.error}` : "";
      const head = `${icon(line.status)} ${line.fullInput ?? line.summary}${errorSuffix}`;
      return verbose && line.output ? `${head}\n    → ${line.output}` : head;
    })
    .join("\n");
}
