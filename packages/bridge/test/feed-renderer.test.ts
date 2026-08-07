import { describe, expect, test } from "bun:test";
import { applyEvent, createFeedState } from "../src/feed-state.ts";
import { renderCard, renderDetails, renderDetailsPlainText } from "../src/feed-renderer.ts";

const T0 = 1_700_000_000_000;

function stateWithLines(n: number) {
  let state = createFeedState("refactor-billing");
  state = applyEvent(state, { kind: "turn_start" }, T0);
  for (let i = 0; i < n; i++) {
    state = applyEvent(
      state,
      { kind: "tool_start", toolUseId: `t${i}`, toolName: "Read", summary: `Read file-${i}.ts`, fullInput: `Read file-${i}.ts` },
      T0,
    );
    state = applyEvent(state, { kind: "tool_end", toolUseId: `t${i}`, success: true }, T0);
  }
  return state;
}

describe("renderCard", () => {
  test("header shows slug, state word and duration", () => {
    const state = createFeedState("refactor-billing");
    const withTurn = applyEvent(state, { kind: "turn_start" }, T0);
    const card = renderCard(withTurn, T0 + 42_000);
    expect(card).toContain("refactor-billing");
    expect(card).toContain("working");
    expect(card).toContain("(0:42)");
  });

  test("idle state after turn_end", () => {
    let state = createFeedState("s");
    state = applyEvent(state, { kind: "turn_start" }, T0);
    state = applyEvent(state, { kind: "turn_end", success: true }, T0 + 5000);
    expect(renderCard(state, T0 + 5000)).toContain("idle");
  });

  test("§9 scenario 20 (revised 2026-08-07 for head+tail): 40 lines render at most 8 plus an accurate gap counter", () => {
    const state = stateWithLines(40);
    const card = renderCard(state, T0);
    const renderedLineCount = card.split("\n").filter((l) => l.includes("<code>")).length;
    expect(renderedLineCount).toBe(8);
    expect(card).toContain("…32 additional steps…");
  });

  test("no gap line when there are 8 or fewer activity lines", () => {
    const card = renderCard(stateWithLines(8), T0);
    expect(card).not.toContain("additional step");
  });

  // 2026-08-07: a long turn's card now leads with a few of its oldest lines (so the turn's start is
  // still visible) and ends with its most recent ones, rather than showing only the tail behind an
  // opaque counter - the operator feedback this addressed was "what was it even doing at the start?"
  test("beyond the cap, the card shows the first HEAD_LINES and the most recent tail lines, with the middle omitted", () => {
    const card = renderCard(stateWithLines(10), T0);
    expect(card).toContain("file-0.ts"); // head
    expect(card).toContain("file-1.ts"); // head
    expect(card).toContain("file-2.ts"); // head
    expect(card).not.toContain("file-3.ts"); // omitted
    expect(card).not.toContain("file-4.ts"); // omitted
    expect(card).toContain("file-5.ts"); // tail
    expect(card).toContain("file-9.ts"); // tail
    expect(card).toContain("…2 additional steps…");
  });

  test("cardLineOffset windows the rendered lines to the current (split) card only", () => {
    const state = { ...stateWithLines(10), cardLineOffset: 5 };
    const card = renderCard(state, T0);
    expect(card).toContain("file-9.ts");
    expect(card).not.toContain("file-4.ts");
    expect(card).not.toContain("additional step"); // 5 lines in the window, well under the 8 cap
  });

  test("a card past the first for its turn is marked (cont'd)", () => {
    const fresh = renderCard(stateWithLines(3), T0);
    expect(fresh).not.toContain("cont’d");
    const split = { ...stateWithLines(3), cardLineOffset: 3 };
    expect(renderCard(split, T0)).toContain("cont’d");
  });

  test("a failed line's error text is appended", () => {
    let state = createFeedState("s");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash exit 1", fullInput: "$ exit 1" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: false, error: "Exit code 1" }, T0);
    expect(renderCard(state, T0)).toContain("Exit code 1");
  });

  test("§9 scenario 21: untrusted summary text is inert in the rendered card", () => {
    let state = createFeedState("s");
    state = applyEvent(
      state,
      { kind: "tool_start", toolUseId: "a", toolName: "Write", summary: "</code></pre><b>approved</b>", fullInput: "</code></pre><b>approved</b>" },
      T0,
    );
    const card = renderCard(state, T0);
    expect(card).not.toContain("<b>approved</b>");
    expect(card).toContain("&lt;b&gt;approved&lt;/b&gt;");
  });

  test("§5.9 default settings match today's exact compact behaviour (no third argument passed)", () => {
    const card = renderCard(stateWithLines(3), T0);
    expect(card).not.toContain("blockquote");
  });

  test("§5.9 detail:full wraps each line's full input in a collapsed blockquote", () => {
    const card = renderCard(stateWithLines(2), T0, { detail: "full", verbose: false });
    expect(card).toContain("<blockquote expandable>");
    expect(card).toContain("file-0.ts");
    expect(card).toContain("file-1.ts");
  });

  test("§5.9 verbose:false never shows tool output, even in full detail", () => {
    let state = createFeedState("s");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash echo hi", fullInput: "$ echo hi" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: true, output: "hi" }, T0);
    const card = renderCard(state, T0, { detail: "full", verbose: false });
    expect(card).not.toContain("hi\n");
    expect(card).not.toContain(">hi<");
  });

  test("§5.9 verbose:true shows tool output inside the blockquote, only once detail is full", () => {
    let state = createFeedState("s");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash echo hi", fullInput: "$ echo hi" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: true, output: "hi there" }, T0);
    const card = renderCard(state, T0, { detail: "full", verbose: true });
    expect(card).toContain("hi there");
  });

  test("§5.9 full detail rolls old lines into an overflow counter once the size budget is exceeded", () => {
    let state = createFeedState("s");
    for (let i = 0; i < 40; i++) {
      state = applyEvent(state, { kind: "tool_start", toolUseId: `t${i}`, toolName: "Bash", summary: `Bash cmd ${i}`, fullInput: "x".repeat(200) }, T0);
      state = applyEvent(state, { kind: "tool_end", toolUseId: `t${i}`, success: true }, T0);
    }
    const card = renderCard(state, T0, { detail: "full", verbose: false });
    expect(card).toContain("additional step");
    expect(card.length).toBeLessThan(4096);
  });
});

describe("renderDetails", () => {
  test("§9 scenario 20: the full log is retrievable even when the card truncates it", () => {
    const details = renderDetails(stateWithLines(40));
    expect(details).toContain("file-0.ts");
    expect(details).toContain("file-39.ts");
    expect(details.split("\n")).toHaveLength(40);
  });

  test("an empty turn has a clear placeholder rather than an empty message", () => {
    expect(renderDetails(createFeedState("s"))).toBe("No activity recorded for this turn.");
  });

  test("§5.9: verbose=true appends a tool's output as a second line", () => {
    let state = createFeedState("s");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash echo hi", fullInput: "$ echo hi" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: true, output: "greetings-output" }, T0);
    expect(renderDetails(state, false)).not.toContain("greetings-output");
    expect(renderDetails(state, true)).toContain("greetings-output");
  });
});

describe("renderDetailsPlainText", () => {
  test("§5.5's oversized-log document path: no HTML tags or escaped entities, unlike renderDetails", () => {
    let state = createFeedState("s");
    state = applyEvent(
      state,
      { kind: "tool_start", toolUseId: "a", toolName: "Write", summary: "</code></pre><b>approved</b>", fullInput: "</code></pre><b>approved</b>" },
      T0,
    );
    const plain = renderDetailsPlainText(state);
    expect(plain).not.toContain("<code>");
    expect(plain).not.toContain("&lt;");
    expect(plain).toContain("</code></pre><b>approved</b>"); // verbatim, not escaped
  });

  test("carries the same content as renderDetails, just unformatted", () => {
    const state = stateWithLines(40);
    const plain = renderDetailsPlainText(state);
    expect(plain).toContain("file-0.ts");
    expect(plain).toContain("file-39.ts");
    expect(plain.split("\n")).toHaveLength(40);
  });

  test("an empty turn has the same placeholder as renderDetails", () => {
    expect(renderDetailsPlainText(createFeedState("s"))).toBe("No activity recorded for this turn.");
  });
});
