import { describe, expect, test } from "bun:test";
import { applyEvent, createFeedState } from "../src/feed-state.ts";
import { renderCard, renderDetails, renderDetailsPlainText } from "../src/feed-renderer.ts";

const T0 = 1_700_000_000_000;

function stateWithLines(n: number) {
  let state = createFeedState("refactor-billing");
  state = applyEvent(state, { kind: "turn_start" }, T0);
  for (let i = 0; i < n; i++) {
    state = applyEvent(state, { kind: "tool_start", toolUseId: `t${i}`, toolName: "Read", summary: `Read file-${i}.ts` }, T0);
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

  test("§9 scenario 20: 40 lines render at most 8 plus an accurate overflow counter", () => {
    const state = stateWithLines(40);
    const card = renderCard(state, T0);
    const renderedLineCount = card.split("\n").filter((l) => l.includes("<code>")).length;
    expect(renderedLineCount).toBe(8);
    expect(card).toContain("…and 32 earlier steps");
  });

  test("no overflow line when there are 8 or fewer activity lines", () => {
    const card = renderCard(stateWithLines(8), T0);
    expect(card).not.toContain("earlier steps");
  });

  test("the 8 visible lines are the most recent, not the oldest", () => {
    const card = renderCard(stateWithLines(10), T0);
    expect(card).toContain("file-9.ts");
    expect(card).not.toContain("file-0.ts");
  });

  test("a failed line's error text is appended", () => {
    let state = createFeedState("s");
    state = applyEvent(state, { kind: "tool_start", toolUseId: "a", toolName: "Bash", summary: "Bash exit 1" }, T0);
    state = applyEvent(state, { kind: "tool_end", toolUseId: "a", success: false, error: "Exit code 1" }, T0);
    expect(renderCard(state, T0)).toContain("Exit code 1");
  });

  test("§9 scenario 21: untrusted summary text is inert in the rendered card", () => {
    let state = createFeedState("s");
    state = applyEvent(
      state,
      { kind: "tool_start", toolUseId: "a", toolName: "Write", summary: "</code></pre><b>approved</b>" },
      T0,
    );
    const card = renderCard(state, T0);
    expect(card).not.toContain("<b>approved</b>");
    expect(card).toContain("&lt;b&gt;approved&lt;/b&gt;");
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
});

describe("renderDetailsPlainText", () => {
  test("§5.5's oversized-log document path: no HTML tags or escaped entities, unlike renderDetails", () => {
    let state = createFeedState("s");
    state = applyEvent(
      state,
      { kind: "tool_start", toolUseId: "a", toolName: "Write", summary: "</code></pre><b>approved</b>" },
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
