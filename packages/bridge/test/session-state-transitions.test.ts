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

  /**
   * `/clear` is an advertised passthrough command (`commands.ts`, and NL-routable) that fires
   * `SessionEnd` with `reason: "clear"` and then a fresh `SessionStart` - on the same live `claude`.
   * Returning `dead` there was unrecoverable: `dead` is terminal in `session-store.ts`, so the
   * follow-up `SessionStart -> idle` is dropped silently and a fully working session shows as dead in
   * `/ls`, stops counting toward the concurrency budget, is refused a resume if it later crashes, has
   * its live pid reported as an orphan, and is killed by `/rm --dead`. No crash anywhere.
   */
  test("a SessionEnd that only restarts the conversation is not a state change at all", () => {
    expect(stateForHookEvent("SessionEnd", "clear")).toBeNull();
    expect(stateForHookEvent("SessionEnd", "compact")).toBeNull();
  });

  test("a real session exit still marks the row dead, whatever the reason says", () => {
    expect(stateForHookEvent("SessionEnd", "logout")).toBe("dead");
    expect(stateForHookEvent("SessionEnd", "prompt_input_exit")).toBe("dead");
    expect(stateForHookEvent("SessionEnd", "other")).toBe("dead");
    // An unknown reason falls through to `dead` deliberately: an over-eager dead is self-correcting
    // via reconciliation, a missed exit leaves a phantom live row forever.
    expect(stateForHookEvent("SessionEnd", "some-future-reason")).toBe("dead");
    expect(stateForHookEvent("SessionEnd", undefined)).toBe("dead");
  });

  test("the reason argument is ignored for every other event", () => {
    expect(stateForHookEvent("SessionStart", "clear")).toBe("idle");
    expect(stateForHookEvent("Stop", "clear")).toBe("idle");
    expect(stateForHookEvent("PreToolUse", "clear")).toBeNull();
  });

  test("events with no state-table entry return null", () => {
    expect(stateForHookEvent("PreToolUse")).toBeNull();
    expect(stateForHookEvent("PostToolUse")).toBeNull();
    expect(stateForHookEvent("Notification")).toBeNull();
  });
});
