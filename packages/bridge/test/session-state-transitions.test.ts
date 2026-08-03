import { describe, expect, test } from "bun:test";
import { stateForHookEvent } from "../src/session-state-transitions.ts";

describe("stateForHookEvent (§9 scenario 40, the hook-driven half of §4.3's table)", () => {
  test("SessionStart -> idle", () => {
    expect(stateForHookEvent("SessionStart")).toBe("idle");
  });

  test("UserPromptSubmit -> working", () => {
    expect(stateForHookEvent("UserPromptSubmit")).toBe("working");
  });

  test("Stop and StopFailure both -> idle", () => {
    expect(stateForHookEvent("Stop")).toBe("idle");
    expect(stateForHookEvent("StopFailure")).toBe("idle");
  });

  test("SessionEnd -> dead", () => {
    expect(stateForHookEvent("SessionEnd")).toBe("dead");
  });

  test("events with no state-table entry return null", () => {
    expect(stateForHookEvent("PreToolUse")).toBeNull();
    expect(stateForHookEvent("PostToolUse")).toBeNull();
    expect(stateForHookEvent("Notification")).toBeNull();
  });
});
