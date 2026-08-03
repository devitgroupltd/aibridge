import { describe, expect, test } from "bun:test";
import { buildModeKeystrokes, isSessionCommandAttempt, MODES, parseSessionCommand, SHIFT_TAB } from "../src/session-commands.ts";

describe("parseSessionCommand", () => {
  test("parses a valid /model command, case-insensitively", () => {
    expect(parseSessionCommand("/model opus")).toEqual({ kind: "model", model: "opus" });
    expect(parseSessionCommand("/model OPUS")).toEqual({ kind: "model", model: "opus" });
  });

  test("parses a valid /mode command", () => {
    expect(parseSessionCommand("/mode acceptEdits")).toEqual({ kind: "mode", mode: "acceptEdits" });
  });

  test("rejects an unknown model or mode name", () => {
    expect(parseSessionCommand("/model gpt5")).toBeNull();
    expect(parseSessionCommand("/mode yolo")).toBeNull();
  });

  test("is not fooled by unrelated text mentioning the words", () => {
    expect(parseSessionCommand("what model should I use?")).toBeNull();
    expect(parseSessionCommand("/models")).toBeNull();
  });

  test("requires an argument", () => {
    expect(parseSessionCommand("/model")).toBeNull();
    expect(parseSessionCommand("/mode")).toBeNull();
  });
});

describe("isSessionCommandAttempt", () => {
  test("true for /model or /mode with any argument, valid or not", () => {
    expect(isSessionCommandAttempt("/model opus")).toBe(true);
    expect(isSessionCommandAttempt("/model nonsense")).toBe(true);
    expect(isSessionCommandAttempt("/mode auto")).toBe(true);
  });

  test("false for ordinary inbound text", () => {
    expect(isSessionCommandAttempt("what's next on the plan?")).toBe(false);
    expect(isSessionCommandAttempt("/cmd review:pre-push")).toBe(false);
  });
});

describe("buildModeKeystrokes", () => {
  test("zero presses when already at the target", () => {
    expect(buildModeKeystrokes("manual", "manual")).toBe("");
  });

  test("one press to the immediate next mode in the cycle", () => {
    expect(buildModeKeystrokes("manual", "acceptEdits")).toBe(SHIFT_TAB);
  });

  test("counts forward across the whole cycle for every (current, target) pair", () => {
    for (const from of MODES) {
      for (const to of MODES) {
        const expectedSteps = (MODES.indexOf(to) - MODES.indexOf(from) + MODES.length) % MODES.length;
        expect(buildModeKeystrokes(from, to)).toBe(SHIFT_TAB.repeat(expectedSteps));
      }
    }
  });

  test("wraps forward past the end of the cycle rather than going backward", () => {
    // auto -> acceptEdits is "backward" by index, but the picker only cycles forward: auto -> manual
    // -> acceptEdits is 2 presses, not -2.
    expect(buildModeKeystrokes("auto", "acceptEdits")).toBe(SHIFT_TAB.repeat(2));
  });
});
