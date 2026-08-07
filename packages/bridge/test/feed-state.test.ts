import { describe, expect, test } from "bun:test";
import { applyEvent, createFeedState, MAX_LINES_PER_CARD, promptsInLastHour, shouldSplitCard, splitCard } from "../src/feed-state.ts";

const T0 = 1_700_000_000_000;

describe("applyEvent", () => {
  test("turn_start opens the turn and clears lines from the previous one", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read x", fullInput: "Read x" }, T0);
    state = applyEvent(state, { kind: "turn_start" }, T0 + 1000);
    expect(state.turnActive).toBe(true);
    expect(state.turnStartedAtMs).toBe(T0 + 1000);
    expect(state.lines).toEqual([]);
  });

  test("tool_start appends a running line, tool_end resolves it by toolUseId", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash echo hi", fullInput: "$ echo hi" }, T0);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Bash echo hi", status: "running", fullInput: "$ echo hi" }]);

    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: true, output: "hi" }, T0 + 10);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Bash echo hi", status: "done", fullInput: "$ echo hi", output: "hi" }]);
  });

  test("a failing tool_end carries the error onto the right line", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash exit 1", fullInput: "$ exit 1" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: false, error: "Exit code 1" }, T0 + 10);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Bash exit 1", status: "failed", error: "Exit code 1", fullInput: "$ exit 1" }]);
  });

  test("two concurrent tool calls resolve independently by toolUseId", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a", fullInput: "Read a" }, T0);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "b", toolName: "Read", summary: "Read b", fullInput: "Read b" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "b", success: true }, T0 + 5);
    expect(state.lines.find((l) => l.toolUseId === "a")?.status).toBe("running");
    expect(state.lines.find((l) => l.toolUseId === "b")?.status).toBe("done");
  });

  test("a tool_end for an unknown toolUseId is a no-op, not a crash", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a", fullInput: "Read a" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "ghost", success: true }, T0 + 5);
    expect(state.lines).toEqual([{ toolUseId: "a", summary: "Read a", status: "running", fullInput: "Read a" }]);
  });

  test("turn_end closes the turn without touching the lines", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "turn_start" }, T0);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a", fullInput: "Read a" }, T0);
    state = applyEvent(state, { kind: "turn_end", success: true }, T0 + 100);
    expect(state.turnActive).toBe(false);
    expect(state.lines).toHaveLength(1);
  });

  test("§5.5: turnSeq increments on every turn_start, starting at 1, and is untouched by anything else", () => {
    let state = createFeedState("slug");
    expect(state.turnSeq).toBe(0);
    state = applyEvent(state, { kind: "turn_start" }, T0);
    expect(state.turnSeq).toBe(1);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Read", summary: "Read a", fullInput: "Read a" }, T0);
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

  test("turn_start resets cardLineOffset alongside lines", () => {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "turn_start" }, T0);
    for (let i = 0; i < MAX_LINES_PER_CARD; i++) {
      state = applyEvent(state, { kind: "tool_start", toolUseId: `t${i}`, toolName: "Read", summary: `Read ${i}`, fullInput: `Read ${i}` }, T0);
    }
    state = splitCard(state);
    expect(state.cardLineOffset).toBeGreaterThan(0);
    state = applyEvent(state, { kind: "turn_start" }, T0 + 1000);
    expect(state.cardLineOffset).toBe(0);
  });
});

describe("shouldSplitCard / splitCard", () => {
  function withNLines(n: number) {
    let state = createFeedState("slug");
    state = applyEvent(state, { kind: "turn_start" }, T0);
    for (let i = 0; i < n; i++) {
      state = applyEvent(state, { kind: "tool_start", toolUseId: `t${i}`, toolName: "Read", summary: `Read ${i}`, fullInput: `Read ${i}` }, T0);
    }
    return state;
  }

  test("false below the threshold, true once the current window reaches it", () => {
    expect(shouldSplitCard(withNLines(MAX_LINES_PER_CARD - 1))).toBe(false);
    expect(shouldSplitCard(withNLines(MAX_LINES_PER_CARD))).toBe(true);
  });

  test("splitCard moves cardLineOffset to the current line count without touching lines", () => {
    const state = withNLines(MAX_LINES_PER_CARD);
    const split = splitCard(state);
    expect(split.cardLineOffset).toBe(MAX_LINES_PER_CARD);
    expect(split.lines).toBe(state.lines);
  });

  test("threshold resets relative to the new offset - not split again until another full window", () => {
    let state = withNLines(MAX_LINES_PER_CARD);
    state = splitCard(state);
    expect(shouldSplitCard(state)).toBe(false);
    for (let i = 0; i < MAX_LINES_PER_CARD - 1; i++) {
      state = applyEvent(state, { kind: "tool_start", toolUseId: `u${i}`, toolName: "Read", summary: `Read u${i}`, fullInput: `Read u${i}` }, T0);
    }
    expect(shouldSplitCard(state)).toBe(false);
    state = applyEvent(state, { kind: "tool_start", toolUseId: "last", toolName: "Read", summary: "Read last", fullInput: "Read last" }, T0);
    expect(shouldSplitCard(state)).toBe(true);
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
