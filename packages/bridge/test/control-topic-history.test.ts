import { describe, expect, test } from "bun:test";
import { createControlTopicHistory, formatHistoryForPrompt } from "../src/control-topic-history.ts";

describe("createControlTopicHistory", () => {
  test("recent(N) returns the last N pairs, oldest first", () => {
    const history = createControlTopicHistory();
    history.recordOperator("hi");
    history.recordBot("hello");
    history.recordOperator("restart the bridge");
    history.recordBot("🤖 I read that as /restart - run it?");
    history.recordOperator("yes");
    history.recordBot("Bridge restarting...");

    const recent = history.recent(2);
    expect(recent).toEqual([
      { role: "operator", text: "restart the bridge" },
      { role: "bot", text: "🤖 I read that as /restart - run it?" },
      { role: "operator", text: "yes" },
      { role: "bot", text: "Bridge restarting..." },
    ]);
  });

  test("recent(0) returns an empty array - the disable-the-window path", () => {
    const history = createControlTopicHistory();
    history.recordOperator("hi");
    history.recordBot("hello");

    expect(history.recent(0)).toEqual([]);
  });

  test("recent(N) with fewer than N pairs recorded returns what exists, no padding", () => {
    const history = createControlTopicHistory();
    history.recordOperator("hi");
    history.recordBot("hello");

    expect(history.recent(4)).toEqual([
      { role: "operator", text: "hi" },
      { role: "bot", text: "hello" },
    ]);
  });

  test("retention is bounded - writing far more than any realistic window doesn't grow unbounded", () => {
    const history = createControlTopicHistory();
    for (let i = 0; i < 300; i++) {
      history.recordOperator(`msg ${i}`);
      history.recordBot(`reply ${i}`);
    }

    // Still returns a correct, bounded slice - the cap doesn't corrupt recent() itself.
    const recent = history.recent(3);
    expect(recent).toEqual([
      { role: "operator", text: "msg 297" },
      { role: "bot", text: "reply 297" },
      { role: "operator", text: "msg 298" },
      { role: "bot", text: "reply 298" },
      { role: "operator", text: "msg 299" },
      { role: "bot", text: "reply 299" },
    ]);
  });

  test("clear() empties the buffer", () => {
    const history = createControlTopicHistory();
    history.recordOperator("hi");
    history.clear();

    expect(history.recent(10)).toEqual([]);
  });
});

describe("formatHistoryForPrompt", () => {
  test("empty entries produce an empty string, not a dangling header", () => {
    expect(formatHistoryForPrompt([])).toBe("");
  });

  test("renders operator/bot roles with a trailing blank line before the next section", () => {
    const text = formatHistoryForPrompt([
      { role: "operator", text: "restart the bridge" },
      { role: "bot", text: "🤖 I read that as /restart - run it?" },
    ]);
    expect(text).toBe("Recent conversation:\nOperator: restart the bridge\nBot: 🤖 I read that as /restart - run it?\n\n");
  });
});
