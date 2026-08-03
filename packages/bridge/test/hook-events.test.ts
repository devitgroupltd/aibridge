import { describe, expect, test } from "bun:test";
import { normalizeHookEvent } from "../src/hook-events.ts";

// Every payload below is verbatim from the Phase 3 Stage 0 live spike (2026-08-03, real spike
// session, a real Read/Bash/failing-Bash turn) - not invented JSON (§9's own testing convention:
// build fixtures from what was actually observed, per §6.5's tool_use_id lesson).

const USER_PROMPT_SUBMIT = {
  session_id: "c43382b2",
  prompt_id: "86e32696",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt: "Read package.json...",
};

const PRE_TOOL_USE_BASH = {
  session_id: "c43382b2",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo spike-test", description: "Echo spike-test string" },
  tool_use_id: "toolu_013YdioHZEuE1qfmPeqVKk1S",
};

const PRE_TOOL_USE_READ = {
  session_id: "c43382b2",
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: "C:\\data\\projects\\aibridge\\.worktrees\\test-session\\package.json" },
  tool_use_id: "toolu_01JXhgBpNrpogaeYF3K4BjBr",
};

const POST_TOOL_USE = {
  session_id: "c43382b2",
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: "package.json" },
  tool_response: { type: "text", file: { filePath: "package.json", numLines: 15 } },
  tool_use_id: "toolu_01JXhgBpNrpogaeYF3K4BjBr",
  duration_ms: 12,
};

const POST_TOOL_USE_FAILURE = {
  session_id: "c43382b2",
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command: "exit 1" },
  tool_use_id: "toolu_01H9sEBM5zCg4Rgzr1Y95g3K",
  error: "Exit code 1",
  is_interrupt: false,
  duration_ms: 100,
};

const SUBAGENT_STOP = {
  session_id: "c43382b2",
  hook_event_name: "SubagentStop",
  agent_id: "adab982b24d16ccea",
  agent_type: "",
  stop_hook_active: false,
  last_assistant_message: "yes, go ahead and send it",
};

const STOP = {
  session_id: "c43382b2",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Ran, exited 1 as expected.",
};

const SESSION_END = {
  session_id: "c43382b2",
  hook_event_name: "SessionEnd",
  reason: "prompt_input_exit",
};

describe("normalizeHookEvent", () => {
  test("UserPromptSubmit opens a turn", () => {
    expect(normalizeHookEvent("UserPromptSubmit", USER_PROMPT_SUBMIT)).toEqual({ kind: "turn_start" });
  });

  test("PreToolUse for Bash summarises the command", () => {
    expect(normalizeHookEvent("PreToolUse", PRE_TOOL_USE_BASH)).toEqual({
      kind: "tool_start",
      toolUseId: "toolu_013YdioHZEuE1qfmPeqVKk1S",
      toolName: "Bash",
      summary: "Bash  echo spike-test",
    });
  });

  test("PreToolUse for Read summarises the file path", () => {
    expect(normalizeHookEvent("PreToolUse", PRE_TOOL_USE_READ)).toEqual({
      kind: "tool_start",
      toolUseId: "toolu_01JXhgBpNrpogaeYF3K4BjBr",
      toolName: "Read",
      summary: "Read  C:\\data\\projects\\aibridge\\.worktrees\\test-session\\package.json",
    });
  });

  test("PostToolUse resolves the matching tool_use_id as a success", () => {
    expect(normalizeHookEvent("PostToolUse", POST_TOOL_USE)).toEqual({
      kind: "tool_end",
      toolUseId: "toolu_01JXhgBpNrpogaeYF3K4BjBr",
      success: true,
    });
  });

  test("PostToolUseFailure resolves as a failure carrying the error text", () => {
    expect(normalizeHookEvent("PostToolUseFailure", POST_TOOL_USE_FAILURE)).toEqual({
      kind: "tool_end",
      toolUseId: "toolu_01H9sEBM5zCg4Rgzr1Y95g3K",
      success: false,
      error: "Exit code 1",
    });
  });

  test("SubagentStop maps to subagent_end", () => {
    expect(normalizeHookEvent("SubagentStop", SUBAGENT_STOP)).toEqual({
      kind: "subagent_end",
      agentId: "adab982b24d16ccea",
    });
  });

  test("Stop closes the turn as a success", () => {
    expect(normalizeHookEvent("Stop", STOP)).toEqual({ kind: "turn_end", success: true });
  });

  test("SessionEnd carries the reason", () => {
    expect(normalizeHookEvent("SessionEnd", SESSION_END)).toEqual({ kind: "session_end", reason: "prompt_input_exit" });
  });

  test("irrelevant or unrecognised events return null rather than a guess", () => {
    expect(normalizeHookEvent("PostToolBatch", { session_id: "x", hook_event_name: "PostToolBatch" })).toBeNull();
    expect(normalizeHookEvent("SessionStart", { session_id: "x", hook_event_name: "SessionStart" })).toBeNull();
    expect(normalizeHookEvent("SomethingNew", { session_id: "x" })).toBeNull();
  });

  test("a tool event missing tool_use_id is dropped, not guessed", () => {
    expect(normalizeHookEvent("PreToolUse", { session_id: "x", tool_name: "Bash" })).toBeNull();
    expect(normalizeHookEvent("PostToolUse", { session_id: "x" })).toBeNull();
  });
});
