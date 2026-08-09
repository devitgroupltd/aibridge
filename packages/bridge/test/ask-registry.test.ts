import { describe, expect, test } from "bun:test";
import { AskRegistry } from "../src/ask-registry.ts";

function question(overrides: Record<string, unknown> = {}) {
  return {
    question: "Pick a color",
    header: "Color",
    options: [{ label: "Red" }, { label: "Blue" }],
    topicId: 3,
    messageId: 10,
    ...overrides,
  };
}

describe("AskRegistry", () => {
  test("answer() records the tapped option's label and reports allAnswered for a single-question ask", () => {
    const registry = new AskRegistry();
    registry.add({ id: "toolu_1", slug: "test-session", questions: [question()] });

    const result = registry.answer("toolu_1", 0, 0);
    expect(result?.label).toBe("Red");
    expect(result?.allAnswered).toBe(true);
    expect(registry.buildAnswers(result!.entry)).toEqual({ "Pick a color": "Red" });
  });

  test("allAnswered is false until every question in a multi-question ask has an answer", () => {
    const registry = new AskRegistry();
    registry.add({
      id: "toolu_2",
      slug: "test-session",
      questions: [question({ question: "Pick a color" }), question({ question: "Pick a size", options: [{ label: "S" }, { label: "M" }] })],
    });

    const first = registry.answer("toolu_2", 0, 0);
    expect(first?.allAnswered).toBe(false);

    const second = registry.answer("toolu_2", 1, 1);
    expect(second?.allAnswered).toBe(true);
    expect(registry.buildAnswers(second!.entry)).toEqual({ "Pick a color": "Red", "Pick a size": "M" });
  });

  // §9 scenarios 6/7-style discipline: a stale or duplicate tap is a silent no-op, not a crash.
  test("answer() returns null for an unknown id", () => {
    const registry = new AskRegistry();
    expect(registry.answer("nope", 0, 0)).toBeNull();
  });

  test("answer() returns null for an out-of-range question or option index", () => {
    const registry = new AskRegistry();
    registry.add({ id: "toolu_3", slug: "test-session", questions: [question()] });
    expect(registry.answer("toolu_3", 5, 0)).toBeNull();
    expect(registry.answer("toolu_3", 0, 5)).toBeNull();
  });

  test("answer() returns null for a question already answered - a duplicate tap changes nothing", () => {
    const registry = new AskRegistry();
    registry.add({ id: "toolu_4", slug: "test-session", questions: [question()] });
    registry.answer("toolu_4", 0, 0);
    expect(registry.answer("toolu_4", 0, 1)).toBeNull();
    expect(registry.get("toolu_4")?.questions[0]?.answerLabel).toBe("Red");
  });

  // §6.4: the 3540s ceiling, one minute inside the hook's own configured 3600s timeout.
  test("expired() lists asks past the 3540s ceiling without removing them", () => {
    let now = 0;
    const registry = new AskRegistry({ now: () => now });
    registry.add({ id: "toolu_5", slug: "test-session", questions: [question()] });

    now = 3_539_000;
    expect(registry.expired()).toEqual([]);

    now = 3_541_000;
    expect(registry.expired().map((e) => e.id)).toEqual(["toolu_5"]);
    expect(registry.get("toolu_5")).toBeDefined();
  });

  // `/stop`'s counterpart to PermissionRegistry.removeForSlug - an interrupted AskUserQuestion
  // leaves its entry here just as unanswerable as an interrupted permission ask.
  describe("removeForSlug", () => {
    test("removes every pending ask for the given slug and returns the removed entries", () => {
      const registry = new AskRegistry();
      registry.add({ id: "toolu_a", slug: "session-a", questions: [question()] });
      registry.add({ id: "toolu_b", slug: "session-a", questions: [question()] });
      registry.add({ id: "toolu_c", slug: "session-b", questions: [question()] });

      expect(registry.removeForSlug("session-a").map((e) => e.id).sort()).toEqual(["toolu_a", "toolu_b"]);
      expect(registry.get("toolu_a")).toBeUndefined();
      expect(registry.get("toolu_b")).toBeUndefined();
      expect(registry.get("toolu_c")).toBeDefined();
    });

    test("returns an empty array without throwing when nothing is pending for that slug", () => {
      const registry = new AskRegistry();
      registry.add({ id: "toolu_a", slug: "session-a", questions: [question()] });

      expect(registry.removeForSlug("ghost")).toEqual([]);
      expect(registry.get("toolu_a")).toBeDefined();
    });
  });
});
