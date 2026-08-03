import { PROTOCOL_VERSION } from "@aibridge/protocol";
import type { AskQuestion, HelloFromHook, HookAskMessage } from "@aibridge/protocol";
import type { AskResolution } from "./ask-once.ts";

export interface AskMessages {
  hello: HelloFromHook;
  ask: HookAskMessage;
}

/**
 * Only the synchronous `AskUserQuestion`-matcher hook entry invokes this (via the `--ask` CLI
 * flag, checked in `index.ts`) - the async catch-all `PreToolUse` entry fires on the exact same
 * stdin payload and must not also try to block on an answer, so which path runs is decided by
 * which hook slot invoked the process, never by inspecting the payload alone.
 */
export function buildAskMessages(rawPayload: unknown, slug: string, pid: number): AskMessages | null {
  if (typeof rawPayload !== "object" || rawPayload === null) return null;
  const payload = rawPayload as Record<string, unknown>;
  const toolUseId = payload.tool_use_id;
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const questions = toolInput?.questions;
  if (typeof toolUseId !== "string" || !Array.isArray(questions)) return null;

  return {
    hello: { v: PROTOCOL_VERSION, type: "hello", role: "hook", slug, pid, event: "PreToolUse" },
    ask: { v: PROTOCOL_VERSION, type: "ask", slug, request_id: toolUseId, questions: questions as AskQuestion[] },
  };
}

/**
 * The two stdout shapes live-verified 2026-08-03 against the real Claude Code binary (v2.1.220):
 * an `allow` with `updatedInput` echoing `questions` verbatim plus an `answers` map keyed by each
 * question's own text made Claude proceed with no terminal picker; a `deny` with a reason made it
 * report "cancelled" and ask whether to retry, rather than silently picking an option. Both
 * confirmed field-for-field, not inferred from documentation (§6.4/§10.0's own standing rule).
 */
export function buildAskOutput(questions: AskQuestion[], resolution: AskResolution): unknown {
  if (resolution.kind === "answered") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "answered via aibridge",
        updatedInput: { questions, answers: resolution.answers },
      },
    };
  }
  const reason = resolution.kind === "cancelled" ? "no answer in an hour, cancelling the question" : "aibridge did not respond in time";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
