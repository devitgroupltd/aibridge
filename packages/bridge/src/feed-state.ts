import type { FeedEvent } from "./hook-events.ts";

export interface ActivityLine {
  /** null for a note line (compaction, subagent boundary) that no PostToolUse/Failure will ever
   * resolve - only a real tool call's toolUseId can transition out of "running". */
  toolUseId: string | null;
  summary: string;
  status: "running" | "done" | "failed";
  error?: string;
  /** §5.9's `/detail full` data - the untruncated (well, `MAX_FULL_LEN`-capped) form of `summary`.
   * Undefined for note lines (compaction, subagent boundaries), which have nothing more to show. */
  fullInput?: string;
  /** §5.9's `/verbose on` data - the tool's actual result, only ever populated once `tool_end`
   * resolves the line (a still-`running` line has no output yet). */
  output?: string;
}

export interface FeedState {
  slug: string;
  turnActive: boolean;
  turnStartedAtMs: number | null;
  /** Full, unbounded per-turn log - §5.3's 8-line cap is a rendering choice (feed-renderer.ts),
   * not a storage one, so the `details` button (§5.5) always has the complete history. */
  lines: ActivityLine[];
  /** One timestamp per `turn_start`, pruned to the last hour on every mutation - the raw series
   * behind the §10.4.1 prompts-per-hour metric. */
  promptTimestampsMs: number[];
  /** §5.5's `<turn>` in `d:<slug>:<turn>` - incremented on every `turn_start`, starting at 1 for
   * the first turn. `lines` resets on the same event, so this is also what tells a stale button
   * tap (from a turn whose log is already gone) apart from a fresh one: a tap only resolves
   * against `lines` if its `turn` still matches the session's current `turnSeq`. */
  turnSeq: number;
}

export function createFeedState(slug: string): FeedState {
  return { slug, turnActive: false, turnStartedAtMs: null, lines: [], promptTimestampsMs: [], turnSeq: 0 };
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function pruneOldPrompts(timestampsMs: number[], nowMs: number): number[] {
  const cutoff = nowMs - ONE_HOUR_MS;
  return timestampsMs.filter((t) => t >= cutoff);
}

function appendNote(state: FeedState, summary: string): FeedState {
  return { ...state, lines: [...state.lines, { toolUseId: null, summary, status: "done" }] };
}

/** Pure state transition - one call per normalized hook event. Never throws: an event that
 * references a `toolUseId` not currently in `lines` (e.g. a `PostToolUse` for a tool call whose
 * `PreToolUse` never arrived) is a no-op rather than a crash, since a dropped/delayed hook is a
 * real possibility this function cannot rule out. */
export function applyEvent(state: FeedState, event: FeedEvent, nowMs: number): FeedState {
  switch (event.kind) {
    case "turn_start":
      return {
        ...state,
        turnActive: true,
        turnStartedAtMs: nowMs,
        lines: [],
        promptTimestampsMs: pruneOldPrompts([...state.promptTimestampsMs, nowMs], nowMs),
        turnSeq: state.turnSeq + 1,
      };

    case "tool_start":
      return {
        ...state,
        lines: [...state.lines, { toolUseId: event.toolUseId, summary: event.summary, status: "running", fullInput: event.fullInput }],
      };

    case "tool_end":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.toolUseId === event.toolUseId
            ? event.success
              ? { ...line, status: "done" as const, output: event.output }
              : { ...line, status: "failed" as const, error: event.error }
            : line,
        ),
      };

    case "subagent_start":
      return appendNote(state, "→ subagent started");

    case "subagent_end":
      return appendNote(state, "← subagent finished");

    case "compacting":
      return appendNote(state, "compacting context…");

    case "compacted":
      return appendNote(state, "compacted");

    case "turn_end":
      return { ...state, turnActive: false };

    case "session_end":
      return { ...state, turnActive: false };

    default:
      return state;
  }
}

/** §10.4.1's metric: how many turns this session has started in the last rolling hour. Read-only -
 * the pruning that keeps this cheap happens as a side effect of `applyEvent`, not here. */
export function promptsInLastHour(state: FeedState, nowMs: number): number {
  return pruneOldPrompts(state.promptTimestampsMs, nowMs).length;
}
