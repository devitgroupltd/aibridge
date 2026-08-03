import { describe, expect, test } from "bun:test";
import { buildAskKeyboard, renderAskAnsweredCard, renderAskCancelledCard, renderAskCard, resolveAskCallback } from "../src/ask-callback.ts";

describe("resolveAskCallback", () => {
  test("resolves id, question index and option index from a real tool_use_id-shaped id", () => {
    expect(resolveAskCallback("ask:toolu_013ZNWVrhNiVB6prCBanHSyp:0:1")).toEqual({
      id: "toolu_013ZNWVrhNiVB6prCBanHSyp",
      questionIndex: 0,
      optionIndex: 1,
    });
  });

  test("rejects anything not matching the ask: shape", () => {
    expect(resolveAskCallback("perm:abcde:a")).toBeNull();
    expect(resolveAskCallback("ask:toolu_1:0")).toBeNull();
    expect(resolveAskCallback("garbage")).toBeNull();
  });
});

describe("buildAskKeyboard", () => {
  test("builds one row per option, matching resolveAskCallback's own encoding", () => {
    const keyboard = buildAskKeyboard("toolu_1", 0, [{ label: "Red" }, { label: "Blue" }]);
    expect(keyboard).toEqual([
      [{ text: "Red", callback_data: "ask:toolu_1:0:0" }],
      [{ text: "Blue", callback_data: "ask:toolu_1:0:1" }],
    ]);
    for (const row of keyboard) {
      for (const button of row) {
        expect(resolveAskCallback(button.callback_data)).not.toBeNull();
      }
    }
  });
});

describe("card rendering", () => {
  test("renderAskCard includes the slug, header and question", () => {
    const text = renderAskCard("test-session", "Pick a color", "Color");
    expect(text).toContain("test-session");
    expect(text).toContain("Color");
    expect(text).toContain("Pick a color");
  });

  test("renderAskAnsweredCard includes the chosen label", () => {
    const text = renderAskAnsweredCard("test-session", "Pick a color", "Color", "Red");
    expect(text).toContain("Red");
  });

  test("renderAskCancelledCard marks the question as cancelled without naming any option", () => {
    const text = renderAskCancelledCard("test-session", "Pick a color", "Color");
    expect(text).toContain("cancelled");
  });
});
