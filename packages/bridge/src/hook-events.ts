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
  | { kind: "tool_start"; toolUseId: string; toolName: string; summary: string }
  | { kind: "tool_end"; toolUseId: string; success: true; summary?: string }
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

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LEN ? `${text.slice(0, MAX_SUMMARY_LEN - 1)}…` : text;
}

/** §5.3's per-tool one-liner. Best-effort: an unrecognised tool falls back to its name alone
 * rather than guessing at an input shape that hasn't been seen. */
function summarizeToolInput(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return toolName;
  const filePath = str(toolInput, "file_path");
  const command = str(toolInput, "command");
  const pattern = str(toolInput, "pattern");
  if (toolName === "Bash" && command) return truncate(`${toolName}  ${command}`);
  if (filePath) return truncate(`${toolName}  ${filePath}`);
  if (pattern) return truncate(`${toolName}  "${pattern}"`);
  return toolName;
}

export function normalizeHookEvent(hookEventName: string, payload: Record<string, unknown>): FeedEvent | null {
  switch (hookEventName) {
    case "UserPromptSubmit":
      return { kind: "turn_start" };

    case "PreToolUse": {
      const toolUseId = str(payload, "tool_use_id");
      const toolName = str(payload, "tool_name");
      if (!toolUseId || !toolName) return null;
      return { kind: "tool_start", toolUseId, toolName, summary: summarizeToolInput(toolName, record(payload, "tool_input")) };
    }

    case "PostToolUse": {
      const toolUseId = str(payload, "tool_use_id");
      if (!toolUseId) return null;
      return { kind: "tool_end", toolUseId, success: true };
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
