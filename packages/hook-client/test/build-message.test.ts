import { describe, expect, test } from "bun:test";
import { buildHookMessages } from "../src/build-message.ts";

// Captured live from the Stage 0 spike (2026-08-03) against a real session - not invented JSON.
const PRE_TOOL_USE = {
  session_id: "c43382b2-d274-4c8f-a723-f2b9cdc14a83",
  transcript_path: "C:\\Users\\minenko\\.claude\\projects\\...\\c43382b2....jsonl",
  cwd: "C:\\data\\projects\\aibridge\\.worktrees\\test-session",
  prompt_id: "86e32696-6b24-4e7a-a95c-3396c9f59e0c",
  permission_mode: "default",
  effort: { level: "medium" },
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo spike-test", description: "Echo spike-test string" },
  tool_use_id: "toolu_013YdioHZEuE1qfmPeqVKk1S",
};

describe("buildHookMessages", () => {
  test("builds hello + event from a real PreToolUse payload", () => {
    const result = buildHookMessages(PRE_TOOL_USE, "test-session", 4242);
    expect(result).not.toBeNull();
    expect(result?.hello).toEqual({
      v: 1,
      type: "hello",
      role: "hook",
      slug: "test-session",
      pid: 4242,
      event: "PreToolUse",
    });
    expect(result?.event).toEqual({
      v: 1,
      type: "event",
      slug: "test-session",
      hook_event_name: "PreToolUse",
      session_id: "c43382b2-d274-4c8f-a723-f2b9cdc14a83",
      payload: PRE_TOOL_USE,
    });
  });

  test("rejects a payload missing hook_event_name or session_id", () => {
    expect(buildHookMessages({ session_id: "abc" }, "slug", 1)).toBeNull();
    expect(buildHookMessages({ hook_event_name: "Stop" }, "slug", 1)).toBeNull();
  });

  test("rejects a non-object payload", () => {
    expect(buildHookMessages(null, "slug", 1)).toBeNull();
    expect(buildHookMessages("not json", "slug", 1)).toBeNull();
    expect(buildHookMessages(42, "slug", 1)).toBeNull();
  });
});
