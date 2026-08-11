import { describe, expect, test } from "bun:test";
import {
  buildDefaultCategoryKeyboard,
  buildDefaultEffortKeyboard,
  buildDefaultModeKeyboard,
  buildEffortKeyboard,
  buildModeKeyboard,
  buildModeKeystrokeSteps,
  buildModelKeyboard,
  EFFORTS,
  isDefaultCategoryCancelCallback,
  isDefaultEffortCancelCallback,
  isDefaultModeCancelCallback,
  isEffortCancelCallback,
  isModeCancelCallback,
  isModelCancelCallback,
  isSessionCommandAttempt,
  MODELS,
  MODES,
  parseSessionCommand,
  resolveDefaultCategoryCallback,
  resolveDefaultToggleCallback,
  resolveDefaultEffortCallback,
  resolveDefaultModeCallback,
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

  test("parses a valid /mode command, case-insensitively - including mixed-case acceptEdits", () => {
    expect(parseSessionCommand("/mode acceptEdits")).toEqual({ kind: "mode", mode: "acceptEdits" });
    expect(parseSessionCommand("/mode ACCEPTEDITS")).toEqual({ kind: "mode", mode: "acceptEdits" });
    expect(parseSessionCommand("/mode AUTO")).toEqual({ kind: "mode", mode: "auto" });
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

describe("buildModeKeystrokeSteps", () => {
  test("zero presses when already at the target", () => {
    expect(buildModeKeystrokeSteps("manual", "manual")).toEqual([]);
  });

  test("one press to the immediate next mode in the cycle", () => {
    expect(buildModeKeystrokeSteps("manual", "acceptEdits")).toEqual([SHIFT_TAB]);
  });

  test("counts forward across the whole cycle for every (current, target) pair", () => {
    for (const from of MODES) {
      for (const to of MODES) {
        const expectedSteps = (MODES.indexOf(to) - MODES.indexOf(from) + MODES.length) % MODES.length;
        expect(buildModeKeystrokeSteps(from, to)).toHaveLength(expectedSteps);
      }
    }
  });

  test("wraps forward past the end of the cycle rather than going backward", () => {
    // auto -> acceptEdits is "backward" by index, but the picker only cycles forward: auto -> manual
    // -> acceptEdits is 2 presses, not -2.
    expect(buildModeKeystrokeSteps("auto", "acceptEdits")).toEqual([SHIFT_TAB, SHIFT_TAB]);
  });

  // The shape is the point: one entry per press, never a single pre-concatenated string, so a caller
  // physically cannot write the burst that the 2026-08-10 defect was.
  test("never returns a multi-press entry", () => {
    for (const from of MODES) {
      for (const to of MODES) {
        for (const step of buildModeKeystrokeSteps(from, to)) expect(step).toBe(SHIFT_TAB);
      }
    }
  });
});

describe("buildEffortKeyboard / resolveEffortCallback", () => {
  test("builds one button per effort level plus a trailing cancel row, matching resolveEffortCallback's own encoding", () => {
    const keyboard = buildEffortKeyboard();
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    expect(flat).toEqual([...EFFORTS.map((effort) => `effort:${effort}`), "effort:cancel"]);
    for (const data of flat.slice(0, -1)) {
      expect(resolveEffortCallback(data)).not.toBeNull();
    }
    expect(resolveEffortCallback("effort:cancel")).toBeNull();
    expect(isEffortCancelCallback("effort:cancel")).toBe(true);
  });

  test("resolves a valid effort callback", () => {
    expect(resolveEffortCallback("effort:high")).toBe("high");
  });

  test("marks the current level's button and leaves the rest plain", () => {
    const keyboard = buildEffortKeyboard("high");
    const flat = keyboard.flat().map((btn) => btn.text);
    expect(flat).toContain("✓ high");
    expect(flat).not.toContain("high");
  });

  test("rejects an unknown level or a tampered/unrelated callback_data", () => {
    expect(resolveEffortCallback("effort:extreme")).toBeNull();
    expect(resolveEffortCallback("run:builtin:compact")).toBeNull();
    expect(resolveEffortCallback("effort:")).toBeNull();
    expect(isEffortCancelCallback("effort:high")).toBe(false);
    expect(isEffortCancelCallback("mode:cancel")).toBe(false);
  });
});

describe("buildModelKeyboard / resolveModelCallback", () => {
  test("builds one button per model plus a trailing cancel row, matching resolveModelCallback's own encoding", () => {
    const keyboard = buildModelKeyboard();
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    expect(flat).toEqual([...MODELS.map((model) => `model:${model}`), "model:cancel"]);
    for (const data of flat.slice(0, -1)) {
      expect(resolveModelCallback(data)).not.toBeNull();
    }
    expect(resolveModelCallback("model:cancel")).toBeNull();
    expect(isModelCancelCallback("model:cancel")).toBe(true);
  });

  test("rejects an unknown model or a tampered/unrelated callback_data", () => {
    expect(resolveModelCallback("model:gpt5")).toBeNull();
    expect(resolveModelCallback("effort:high")).toBeNull();
    expect(isModelCancelCallback("model:sonnet")).toBe(false);
  });
});

describe("buildModeKeyboard / resolveModeCallback", () => {
  test("builds one button per mode plus a trailing cancel row, matching resolveModeCallback's own encoding", () => {
    const keyboard = buildModeKeyboard();
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    expect(flat).toEqual([...MODES.map((mode) => `mode:${mode}`), "mode:cancel"]);
    for (const data of flat.slice(0, -1)) {
      expect(resolveModeCallback(data)).not.toBeNull();
    }
    expect(resolveModeCallback("mode:cancel")).toBeNull();
    expect(isModeCancelCallback("mode:cancel")).toBe(true);
  });

  test("rejects an unknown mode or a tampered/unrelated callback_data", () => {
    expect(resolveModeCallback("mode:yolo")).toBeNull();
    expect(resolveModeCallback("model:sonnet")).toBeNull();
    expect(isModeCancelCallback("mode:manual")).toBe(false);
  });
});

describe("buildDefaultModeKeyboard / buildDefaultEffortKeyboard - distinct namespace from the session-scoped pickers", () => {
  test("defmode:/defeffort: callback_data, not mode:/effort: - a session-scoped resolver must never match these", () => {
    const modeFlat = buildDefaultModeKeyboard().flat().map((btn) => btn.callback_data);
    expect(modeFlat).toEqual([...MODES.map((mode) => `defmode:${mode}`), "defmode:cancel"]);
    expect(resolveModeCallback("defmode:manual")).toBeNull();
    expect(resolveDefaultModeCallback("mode:manual")).toBeNull();

    const effortFlat = buildDefaultEffortKeyboard().flat().map((btn) => btn.callback_data);
    expect(effortFlat).toEqual([...EFFORTS.map((effort) => `defeffort:${effort}`), "defeffort:cancel"]);
    expect(resolveEffortCallback("defeffort:high")).toBeNull();
    expect(resolveDefaultEffortCallback("effort:high")).toBeNull();
  });

  test("marks the current value and resolves cancel separately from a real value", () => {
    expect(buildDefaultModeKeyboard("auto").flat().map((btn) => btn.text)).toContain("✓ auto");
    expect(resolveDefaultModeCallback("defmode:auto")).toBe("auto");
    expect(resolveDefaultModeCallback("defmode:cancel")).toBeNull();
    expect(isDefaultModeCancelCallback("defmode:cancel")).toBe(true);
    expect(isDefaultModeCancelCallback("defmode:auto")).toBe(false);

    expect(buildDefaultEffortKeyboard("xhigh").flat().map((btn) => btn.text)).toContain("✓ xhigh");
    expect(resolveDefaultEffortCallback("defeffort:xhigh")).toBe("xhigh");
    expect(resolveDefaultEffortCallback("defeffort:cancel")).toBeNull();
    expect(isDefaultEffortCancelCallback("defeffort:cancel")).toBe(true);
    expect(isDefaultEffortCancelCallback("defeffort:xhigh")).toBe(false);
  });
});

describe("buildDefaultCategoryKeyboard / resolveDefaultCategoryCallback", () => {
  test("one row per category, each labelled with its current value, plus a cancel row", () => {
    const keyboard = buildDefaultCategoryKeyboard("manual", "medium", false, false);
    expect(keyboard).toEqual([
      [{ text: "Mode (manual)", callback_data: "default:mode" }],
      [{ text: "Effort (medium)", callback_data: "default:effort" }],
      [{ text: "Auto-permission: OFF (tap to turn ON)", callback_data: "default:permission:on" }],
      [{ text: "Auto-answer: OFF (tap to turn ON)", callback_data: "default:answer:on" }],
      [{ text: "✖️ Cancel", callback_data: "default:cancel" }],
    ]);
  });

  test("resolves mode/effort taps, rejects cancel and unrelated callback_data", () => {
    expect(resolveDefaultCategoryCallback("default:mode")).toBe("mode");
    expect(resolveDefaultCategoryCallback("default:effort")).toBe("effort");
    expect(resolveDefaultCategoryCallback("default:cancel")).toBeNull();
    expect(resolveDefaultCategoryCallback("defmode:manual")).toBeNull();
    expect(isDefaultCategoryCancelCallback("default:cancel")).toBe(true);
    expect(isDefaultCategoryCancelCallback("default:mode")).toBe(false);
  });

  // A toggle row's `callback_data` carries the *inverse* of the current value, so a hardcoded
  // "default:permission:on" would pass any single-direction test while producing a button that can
  // turn the default on and then never off - under a label claiming the opposite. Both directions.
  test("the toggle rows flip both their label and their callback_data with the current value", () => {
    const keyboard = buildDefaultCategoryKeyboard("manual", "medium", true, true);
    expect(keyboard[2]).toEqual([{ text: "Auto-permission: ON (tap to turn OFF)", callback_data: "default:permission:off" }]);
    expect(keyboard[3]).toEqual([{ text: "Auto-answer: ON (tap to turn OFF)", callback_data: "default:answer:off" }]);
  });

  test("the two toggles are independent rows, not one shared value", () => {
    const keyboard = buildDefaultCategoryKeyboard("manual", "medium", true, false);
    expect(keyboard[2]?.[0]?.callback_data).toBe("default:permission:off");
    expect(keyboard[3]?.[0]?.callback_data).toBe("default:answer:on");
  });

  test("resolveDefaultCategoryCallback stays narrow - a toggle string is not a drill-down category", () => {
    // Widening it would hand a boolean category to the drill-down handler, which has no picker to
    // show for one.
    expect(resolveDefaultCategoryCallback("default:permission:on")).toBeNull();
    expect(resolveDefaultCategoryCallback("default:answer:off")).toBeNull();
  });
});

describe("resolveDefaultToggleCallback", () => {
  test("round-trips every button buildDefaultCategoryKeyboard actually emits", () => {
    for (const [bypass, autoAnswer] of [
      [false, false],
      [true, true],
    ] as const) {
      const rows = buildDefaultCategoryKeyboard("manual", "medium", bypass, autoAnswer);
      expect(resolveDefaultToggleCallback(rows[2]![0]!.callback_data)).toEqual({ category: "permission", value: !bypass });
      expect(resolveDefaultToggleCallback(rows[3]![0]!.callback_data)).toEqual({ category: "answer", value: !autoAnswer });
    }
  });

  test("rejects an unknown category, an unknown value, and a different namespace", () => {
    expect(resolveDefaultToggleCallback("default:mode:on")).toBeNull();
    expect(resolveDefaultToggleCallback("default:permission:maybe")).toBeNull();
    expect(resolveDefaultToggleCallback("default:permission")).toBeNull();
    expect(resolveDefaultToggleCallback("defmode:permission:on")).toBeNull();
    expect(resolveDefaultToggleCallback("garbage")).toBeNull();
  });
});
