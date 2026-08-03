import { describe, expect, test } from "bun:test";
import { buildAskMessages, buildAskOutput } from "../src/ask-message.ts";

// Captured live from the Stage 0 spike (2026-08-03) against a real AskUserQuestion PreToolUse call.
const ASK_USER_QUESTION = {
  session_id: "6e60788e-6f59-4e73-8317-9c97834dd36a",
  transcript_path: "C:\\Users\\minenko\\.claude\\projects\\...\\6e60788e....jsonl",
  cwd: "C:\\data\\projects\\aibridge\\.worktrees\\test-session",
  prompt_id: "dacc056a-e785-40fe-952b-ee23d66a0dfe",
  permission_mode: "default",
  effort: { level: "medium" },
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red", description: "Red" },
          { label: "Blue", description: "Blue" },
        ],
        multiSelect: false,
      },
    ],
  },
  tool_use_id: "toolu_013ZNWVrhNiVB6prCBanHSyp",
};

describe("buildAskMessages", () => {
  test("builds hello + ask from a real AskUserQuestion payload, keyed by tool_use_id", () => {
    const result = buildAskMessages(ASK_USER_QUESTION, "test-session", 4242);
    expect(result).not.toBeNull();
    expect(result?.hello).toEqual({ v: 1, type: "hello", role: "hook", slug: "test-session", pid: 4242, event: "PreToolUse" });
    expect(result?.ask).toEqual({
      v: 1,
      type: "ask",
      slug: "test-session",
      request_id: "toolu_013ZNWVrhNiVB6prCBanHSyp",
      questions: ASK_USER_QUESTION.tool_input.questions,
    });
  });

  test("rejects a payload missing tool_use_id or tool_input.questions", () => {
    expect(buildAskMessages({ tool_input: { questions: [] } }, "slug", 1)).toBeNull();
    expect(buildAskMessages({ tool_use_id: "toolu_x" }, "slug", 1)).toBeNull();
  });

  test("rejects a non-object payload", () => {
    expect(buildAskMessages(null, "slug", 1)).toBeNull();
    expect(buildAskMessages("not json", "slug", 1)).toBeNull();
  });
});

describe("buildAskOutput", () => {
  const questions = ASK_USER_QUESTION.tool_input.questions;

  // §9 scenario 22: schema assertion against the captured real payload - questions echoed
  // verbatim, answers keyed by each question's own text.
  test("an answered resolution produces allow + updatedInput echoing questions and answers", () => {
    const output = buildAskOutput(questions, { kind: "answered", answers: { "Pick a color": "Red" } });
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "answered via aibridge",
        updatedInput: { questions, answers: { "Pick a color": "Red" } },
      },
    });
  });

  // §9 scenario 23: the ceiling cancels rather than answers - no option is auto-selected, and
  // there is no `updatedInput` at all in this shape (nothing for Claude to silently adopt).
  test("a cancelled resolution produces deny with a reason and no updatedInput", () => {
    const output = buildAskOutput(questions, { kind: "cancelled" }) as { hookSpecificOutput: Record<string, unknown> };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("no answer in an hour, cancelling the question");
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined();
  });

  test("a local-timeout resolution also produces deny, with its own distinct reason", () => {
    const output = buildAskOutput(questions, { kind: "timeout" }) as { hookSpecificOutput: Record<string, unknown> };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe("aibridge did not respond in time");
  });
});
