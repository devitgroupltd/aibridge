/**
 * Normalizes a raw hook payload (§5.1's event table) into the small union the feed renderer
 * understands. Built from Stage 0's live capture (2026-08-03, a real turn against the spike
 * session) rather than Claude Code's public docs alone - the docs' own field names have already
 * been wrong once in this project (§6.5's `tool_use_id` on `PermissionRequest`), so every field
 * read here is optional-checked rather than trusted, and only fields actually observed in the
 * capture are relied upon for the events that were triggered live (SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, PostToolUseFailure, Stop, SubagentStop, SessionEnd). `PostToolBatch` is
 * deliberately treated as redundant (every batched call already fired its own PreToolUse/
 * PostToolUse), and `SubagentStart`, `PermissionDenied`, `Notification`, `StopFailure` are handled
 * from the documented common envelope only, not independently live-verified - a real payload that
 * turns out to differ degrades to the same "no line rendered" outcome as an unrecognised event,
 * not a crash.
 */

export type FeedEvent =
  | { kind: "turn_start" }
  | { kind: "tool_start"; toolUseId: string; toolName: string; summary: string; fullInput: string }
  | { kind: "tool_end"; toolUseId: string; success: true; summary?: string; output?: string }
  | { kind: "tool_end"; toolUseId: string; success: false; error: string }
  | { kind: "subagent_start"; agentId: string }
  | { kind: "subagent_end"; agentId: string }
  | { kind: "compacting" }
  | { kind: "compacted" }
  | { kind: "turn_end"; success: true }
  | { kind: "turn_end"; success: false; error: string }
  | { kind: "session_end"; reason: string };

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function record(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

const MAX_SUMMARY_LEN = 80;
// §5.9's `/detail full`: still bounded, just much more generous than the card's own one-liner -
// this is what an expandable blockquote holds, not the always-visible line, but it's in-memory
// state kept for a whole turn, so it gets its own cap rather than trusting an agent-supplied string
// to be any particular size.
const MAX_FULL_LEN = 1500;

function truncateTo(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function truncate(text: string): string {
  return truncateTo(text, MAX_SUMMARY_LEN);
}

interface TodoItem {
  content?: string;
  status?: string;
  activeForm?: string;
}

/** `TodoWrite`'s payload is `{ todos: [{content, status, activeForm}, ...] }` (confirmed live -
 * every `TodoWrite` call this project's own sessions make sends exactly this shape) - an array, not
 * a string field, so it matches none of `summarizeToolInput`/`fullToolInput`'s named-field checks
 * and silently fell back to the bare tool name in both the compact card line and the `/detail full`
 * blockquote (found during the `/deep-check` follow-up: an operator watching a session work through
 * a todo list saw nothing but "TodoWrite" the whole time). */
function asTodoItems(toolInput: Record<string, unknown>): TodoItem[] | undefined {
  const todos = toolInput.todos;
  if (!Array.isArray(todos)) return undefined;
  const items = todos.filter((t): t is TodoItem => typeof t === "object" && t !== null);
  return items.length > 0 ? items : undefined;
}

/** §5.3's compact one-liner for `TodoWrite`: progress count plus whichever item is actually in
 * flight - the one thing worth knowing at a glance while the rest of the checklist sits still. */
function summarizeTodos(toolInput: Record<string, unknown>): string | undefined {
  const todos = asTodoItems(toolInput);
  if (!todos) return undefined;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  const activeForm = current?.activeForm ?? current?.content;
  return truncate(`TodoWrite  ${done}/${todos.length} done${activeForm ? ` · now: ${activeForm}` : ""}`);
}

/** `/detail full`'s sibling of `summarizeTodos` - the whole checklist, one line per item, same
 * ✓/▶/· convention the IDE's own todo view uses so an operator who's used Claude Code before
 * doesn't have to learn a new vocabulary just because they're reading it in Telegram. */
function fullTodos(toolInput: Record<string, unknown>): string | undefined {
  const todos = asTodoItems(toolInput);
  if (!todos) return undefined;
  const lines = todos.map((t) => {
    const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "·";
    const text = (t.status === "in_progress" ? t.activeForm : undefined) ?? t.content ?? "(untitled)";
    return `${mark} ${text}`;
  });
  return truncateTo(lines.join("\n"), MAX_FULL_LEN);
}

/** §5.3's per-tool one-liner. Named-field priority mirrors `fullToolInput` below (see that
 * function's own comment for the full-detail side of this): a growing set of well-known fields
 * that carry a tool call's actual target, checked in specificity order, before falling back to
 * whatever string field happens to come first, and only then to the bare tool name. Found during
 * the `/deep-check` follow-up: `Task`/`WebFetch`/`WebSearch`/`NotebookEdit`/`Skill`/`ExitPlanMode`
 * all fell back to their bare name here even though their actual target (a subagent's task,
 * a URL, a search query, a notebook path, a skill name, a plan) was sitting right there and
 * already rendered fine in `/detail full` - the always-visible card line was the one place it was
 * missing. */
function summarizeToolInput(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return toolName;
  if (toolName === "TodoWrite") return summarizeTodos(toolInput) ?? toolName;
  const command = str(toolInput, "command");
  if (toolName === "Bash" && command) return truncate(`${toolName}  ${command}`);
  const filePath = str(toolInput, "file_path") ?? str(toolInput, "notebook_path");
  if (filePath) return truncate(`${toolName}  ${filePath}`);
  const pattern = str(toolInput, "pattern");
  if (pattern) return truncate(`${toolName}  "${pattern}"`);
  const known = str(toolInput, "url") ?? str(toolInput, "query") ?? str(toolInput, "skill") ?? str(toolInput, "description") ?? str(toolInput, "plan");
  if (known) return truncate(`${toolName}  ${known}`);
  const anyString = firstStringField(toolInput);
  return anyString ? truncate(`${toolName}  ${anyString}`) : toolName;
}

/** Last-resort fallback shared by both summarizers - object key order from a parsed tool call
 * mirrors the order the tool's own schema declares its fields in, so "the first string field" is
 * usually the primary one (`skill` before `args`, `query` before secondary options, ...) even for
 * a tool this file has no specific name for yet. Better than the bare tool name; not a substitute
 * for a real named-field match above when one exists. */
function firstStringField(toolInput: Record<string, unknown>): string | undefined {
  for (const value of Object.values(toolInput)) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** `/detail full`'s untruncated (well, `MAX_FULL_LEN`-truncated) sibling of `summarizeToolInput` -
 * same field preference order, just without the 80-char cut. Falls back to a shallow dump of
 * every string-valued field for a tool shape none of the named fields matched, rather than only
 * ever showing the tool name the way the compact summary does - the whole point of "full" is not
 * silently having less than the compact line already gave. */
function fullToolInput(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return toolName;
  if (toolName === "TodoWrite") return fullTodos(toolInput) ?? toolName;
  const filePath = str(toolInput, "file_path") ?? str(toolInput, "notebook_path");
  const command = str(toolInput, "command");
  const pattern = str(toolInput, "pattern");
  const description = str(toolInput, "description");
  const label = description ? `${toolName} (${description})` : toolName;
  if (toolName === "Bash" && command) return truncateTo(`$ ${command}`, MAX_FULL_LEN);
  if (filePath) return truncateTo(`${label}  ${filePath}`, MAX_FULL_LEN);
  if (pattern) return truncateTo(`${label}  "${pattern}"`, MAX_FULL_LEN);
  const strFields = Object.entries(toolInput)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}: ${v as string}`)
    .join("\n");
  return truncateTo(strFields.length > 0 ? `${label}\n${strFields}` : label, MAX_FULL_LEN);
}

/**
 * `/verbose on`'s data source - the tool's actual result, not just what it was asked to do.
 * **Not independently live-verified** the way `PermissionRequest`'s payload was (§6.5) - `tool_response`
 * as a `PostToolUse` field, and the `stdout`/`stderr`/`content` shapes below, are sourced from Claude
 * Code's own documentation and public examples only. Degrades the same way an unrecognised event
 * already does: an unexpected shape just produces no output line, never a crash, so this is safe to
 * ship ahead of a live spike, but should not be trusted as a completeness guarantee until one happens.
 */
function summarizeToolResponse(toolResponse: unknown): string | undefined {
  if (typeof toolResponse === "string") return toolResponse.length > 0 ? truncateTo(toolResponse, MAX_FULL_LEN) : undefined;
  if (typeof toolResponse !== "object" || toolResponse === null) return undefined;
  const obj = toolResponse as Record<string, unknown>;
  const stdout = str(obj, "stdout");
  const stderr = str(obj, "stderr");
  if (stdout || stderr) {
    const combined = [stdout, stderr].filter((s): s is string => Boolean(s)).join("\n");
    return combined.length > 0 ? truncateTo(combined, MAX_FULL_LEN) : undefined;
  }
  // The one shape actually seen live so far (Stage 0's spike, 2026-08-03, a real Read call):
  // `{ type: "text", file: { filePath, numLines } }`. Everything else here is doc-sourced only.
  const file = record(obj, "file");
  if (file) {
    const filePath = str(file, "filePath");
    const numLines = file.numLines;
    if (filePath) return truncateTo(`${filePath}${typeof numLines === "number" ? ` (${numLines} lines)` : ""}`, MAX_FULL_LEN);
  }
  const content = str(obj, "content") ?? str(obj, "output") ?? str(obj, "result") ?? str(obj, "filePath");
  return content ? truncateTo(content, MAX_FULL_LEN) : undefined;
}

export function normalizeHookEvent(hookEventName: string, payload: Record<string, unknown>): FeedEvent | null {
  switch (hookEventName) {
    case "UserPromptSubmit":
      return { kind: "turn_start" };

    case "PreToolUse": {
      const toolUseId = str(payload, "tool_use_id");
      const toolName = str(payload, "tool_name");
      if (!toolUseId || !toolName) return null;
      const toolInput = record(payload, "tool_input");
      return {
        kind: "tool_start",
        toolUseId,
        toolName,
        summary: summarizeToolInput(toolName, toolInput),
        fullInput: fullToolInput(toolName, toolInput),
      };
    }

    case "PostToolUse": {
      const toolUseId = str(payload, "tool_use_id");
      if (!toolUseId) return null;
      return { kind: "tool_end", toolUseId, success: true, output: summarizeToolResponse(payload.tool_response) };
    }

    case "PostToolUseFailure": {
      const toolUseId = str(payload, "tool_use_id");
      if (!toolUseId) return null;
      return { kind: "tool_end", toolUseId, success: false, error: truncate(str(payload, "error") ?? "failed") };
    }

    case "SubagentStart": {
      const agentId = str(payload, "agent_id");
      return agentId ? { kind: "subagent_start", agentId } : null;
    }

    case "SubagentStop": {
      const agentId = str(payload, "agent_id");
      return agentId ? { kind: "subagent_end", agentId } : null;
    }

    case "PreCompact":
      return { kind: "compacting" };

    case "PostCompact":
      return { kind: "compacted" };

    case "Stop":
      return { kind: "turn_end", success: true };

    case "StopFailure":
      return { kind: "turn_end", success: false, error: truncate(str(payload, "error") ?? "the turn ended with an error") };

    case "SessionEnd":
      return { kind: "session_end", reason: str(payload, "reason") ?? "unknown" };

    // SessionStart / PostToolBatch / PermissionRequest / PermissionDenied / Notification: not
    // card-relevant (SessionStart's own header line is rendered from routing state, not a hook;
    // the two Permission* events feed the relay's resolution heuristic in permission-registry.ts
    // instead; PostToolBatch is redundant with the individual PreToolUse/PostToolUse pairs above).
    default:
      return null;
  }
}
