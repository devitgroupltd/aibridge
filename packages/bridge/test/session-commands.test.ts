import { describe, expect, test } from "bun:test";
import {
  buildEffortKeyboard,
  buildModeKeyboard,
  buildModeKeystrokes,
  buildModelKeyboard,
  EFFORTS,
  isSessionCommandAttempt,
  MODELS,
  MODES,
  parseSessionCommand,
  resolveEffortCallback,
  resolveModeCallback,
  resolveModelCallback,
  SHIFT_TAB,
} from "../src/session-commands.ts";

describe("parseSessionCommand", () => {
  test("parses a valid /model command, case-insensitively", () => {
    expect(parseSessionCommand("/model opus")).toEqual({ kind: "model", model: "opus" });
    expect(parseSessionCommand("/model OPUS")).toEqual({ kind: "model", model: "opus" });
  });

  test("parses a valid /mode command", () => {
    expect(parseSessionCommand("/mode acceptEdits")).toEqual({ kind: "mode", mode: "acceptEdits" });
  });

  test("parses a valid /effort command, case-insensitively", () => {
    expect(parseSessionCommand("/effort high")).toEqual({ kind: "effort", effort: "high" });
    expect(parseSessionCommand("/effort MAX")).toEqual({ kind: "effort", effort: "max" });
  });

  test("rejects an unknown model, mode or effort name", () => {
    expect(parseSessionCommand("/model gpt5")).toBeNull();
    expect(parseSessionCommand("/mode yolo")).toBeNull();
    expect(parseSessionCommand("/effort extreme")).toBeNull();
  });

  test("is not fooled by unrelated text mentioning the words", () => {
    expect(parseSessionCommand("what model should I use?")).toBeNull();
    expect(parseSessionCommand("/models")).toBeNull();
    expect(parseSessionCommand("that took real effort")).toBeNull();
  });

  test("requires an argument", () => {
    expect(parseSessionCommand("/model")).toBeNull();
    expect(parseSessionCommand("/mode")).toBeNull();
    expect(parseSessionCommand("/effort")).toBeNull();
  });
});

describe("isSessionCommandAttempt", () => {
  test("true for /model, /mode or /effort with any argument, valid or not", () => {
    expect(isSessionCommandAttempt("/model opus")).toBe(true);
    expect(isSessionCommandAttempt("/model nonsense")).toBe(true);
    expect(isSessionCommandAttempt("/mode auto")).toBe(true);
    expect(isSessionCommandAttempt("/effort low")).toBe(true);
    expect(isSessionCommandAttempt("/effort nonsense")).toBe(true);
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

describe("buildEffortKeyboard / resolveEffortCallback", () => {
  test("builds one button per effort level, matching resolveEffortCallback's own encoding", () => {
    const keyboard = buildEffortKeyboard();
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    expect(flat).toEqual(EFFORTS.map((effort) => `effort:${effort}`));
    for (const data of flat) {
      expect(resolveEffortCallback(data)).not.toBeNull();
    }
  });

  test("resolves a valid effort callback", () => {
    expect(resolveEffortCallback("effort:high")).toBe("high");
  });

  test("rejects an unknown level or a tampered/unrelated callback_data", () => {
    expect(resolveEffortCallback("effort:extreme")).toBeNull();
    expect(resolveEffortCallback("run:builtin:compact")).toBeNull();
    expect(resolveEffortCallback("effort:")).toBeNull();
  });
});

describe("buildModelKeyboard / resolveModelCallback", () => {
  test("builds one button per model, matching resolveModelCallback's own encoding", () => {
    const keyboard = buildModelKeyboard();
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    expect(flat).toEqual(MODELS.map((model) => `model:${model}`));
    for (const data of flat) {
      expect(resolveModelCallback(data)).not.toBeNull();
    }
  });

  test("rejects an unknown model or a tampered/unrelated callback_data", () => {
    expect(resolveModelCallback("model:gpt5")).toBeNull();
    expect(resolveModelCallback("effort:high")).toBeNull();
  });
});

describe("buildModeKeyboard / resolveModeCallback", () => {
  test("builds one button per mode, matching resolveModeCallback's own encoding", () => {
    const keyboard = buildModeKeyboard();
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    expect(flat).toEqual(MODES.map((mode) => `mode:${mode}`));
    for (const data of flat) {
      expect(resolveModeCallback(data)).not.toBeNull();
    }
  });

  test("rejects an unknown mode or a tampered/unrelated callback_data", () => {
    expect(resolveModeCallback("mode:yolo")).toBeNull();
    expect(resolveModeCallback("model:sonnet")).toBeNull();
  });
});
