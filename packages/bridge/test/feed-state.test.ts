import { describe, expect, test } from "bun:test";
import { applyEvent, createFeedState, promptsInLastHour } from "../src/feed-state.ts";

const T0 = 1_700_000_000_000;

describe("applyEvent", () => {
  test("turn_start opens the turn and clears lines from the previous one", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read x" }, T0);
    state = applyEvent(state, { kind: "turn_start" }, T0 + 1000);
    expect(state.turnActive).toBe(true);
    expect(state.turnStartedAtMs).toBe(T0 + 1000);
    expect(state.lines).toEqual([]);
  });

  test("tool_start appends a running line, tool_end resolves it by toolUseId", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash echo hi" }, T0);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Bash echo hi", status: "running" }]);

    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: true }, T0 + 10);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Bash echo hi", status: "done" }]);
  });

  test("a failing tool_end carries the error onto the right line", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash exit 1" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: false, error: "Exit code 1" }, T0 + 10);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Bash exit 1", status: "failed", error: "Exit code 1" }]);
  });

  test("two concurrent tool calls resolve independently by toolUseId", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a" }, T0);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "b", toolName: "Read", summary: "Read b" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "b", success: true }, T0 + 5);
    expect(state.lines.find((l) => l.toolUseId === "a")?.status).toBe("running");
    expect(state.lines.find((l) => l.toolUseId === "b")?.status).toBe("done");
  });

  test("a tool_end for an unknown toolUseId is a no-op, not a crash", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "ghost", success: true }, T0 + 5);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Read a", status: "running" }]);
  });

  test("turn_end closes the turn without touching the lines", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "turn_start" }, T0);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a" }, T0);
    state = applyEvent(state, { kind: "turn_end", success: true }, T0 + 100);
    expect(state.turnActive).toBe(false);
    expect(state.lines).toHaveLength(1);
  });

  test("§5.5: turnSeq increments on every turn_start, starting at 1, and is untouched by anything else", () => {
    let state = createFeedState("slug");
    expect(state.turnSeq).toBe(0);
    state = applyEvent(state, { kind: "turn_start" }, T0);
    expect(state.turnSeq).toBe(1);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a" }, T0);
    state = applyEvent(state, { kind: "turn_end", success: true }, T0 + 10);
    expect(state.turnSeq).toBe(1);
    state = applyEvent(state, { kind: "turn_start" }, T0 + 20);
    expect(state.turnSeq).toBe(2);
  });

  test("subagent and compaction events append note lines with no toolUseId", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "compacting" }, T0);
    state = applyEvent(state, { kind: "compacted" }, T0 + 1);
    state = applyEvent(state, { kind: "subagent_start", agentId: "x" }, T0 + 2);
    expect(state.lines.map((l) => l.summary)).toEqual(["compacting context…", "compacted", "→ subagent started"]);
    expect(state.lines.every((l) => l.toolUseId === null)).toBe(true);
  });
});

describe("promptsInLastHour", () => {
  test("counts turn_start events within the rolling hour and evicts older ones", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "turn_start" }, T0);
    state = applyEvent(state, { kind: "turn_start" }, T0 + 10 * 60 * 1000);
    expect(promptsInLastHour(state, T0 + 20 * 60 * 1000)).toBe(2);

    // 61 minutes after the first prompt: only the second (10 minutes after the first) is still live.
    expect(promptsInLastHour(state, T0 + 61 * 60 * 1000)).toBe(1);
  });

  test("an empty session has zero prompts", () => {
    expect(promptsInLastHour(createFeedState("slug"), T0)).toBe(0);
  });
});
