import { describe, expect, test } from "bun:test";
import { buildNlConfirmKeyboard, NlConfirmRegistry, resolveNlConfirmCallback } from "../src/nl-confirm.ts";

function entry(overrides: Partial<Parameters<NlConfirmRegistry["add"]>[0]> = {}) {
  return {
    id: "abcde123",
    command: { kind: "restart" as const },
    threadId: 1,
    currentSlug: undefined,
    messageId: 10,
    ...overrides,
  };
}

describe("NlConfirmRegistry", () => {
  test("resolving one id does not resolve a concurrent, independent confirm", () => {
    const registry = new NlConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));
    registry.add(entry({ id: "bbbbbbbb", command: { kind: "kill", slug: "fix-bug" } }));

    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.command.kind).toBe("restart");
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
    expect(registry.resolve("bbbbbbbb")?.command.kind).toBe("kill");
  });

  test("resolving an unknown id returns undefined without throwing", () => {
    const registry = new NlConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));
    expect(() => registry.resolve("zzzzzzzz")).not.toThrow();
    expect(registry.resolve("zzzzzzzz")).toBeUndefined();
  });

  test("an expired id is refused even though it still matches a real entry", () => {
    let now = 0;
    const registry = new NlConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa" }));
    now = 1001;
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
  });

  test("resolving within the TTL succeeds and returns the registered command/slug", () => {
    let now = 0;
    const registry = new NlConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa", currentSlug: "fix-bug" }));
    now = 999;
    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.currentSlug).toBe("fix-bug");
  });
});

describe("resolveNlConfirmCallback", () => {
  test("resolves run, run-and-stop-asking, and cancel taps", () => {
    expect(resolveNlConfirmCallback("nc:abcde123:y")).toEqual({ id: "abcde123", action: "run" });
    expect(resolveNlConfirmCallback("nc:abcde123:s")).toEqual({ id: "abcde123", action: "run_and_stop_asking" });
    expect(resolveNlConfirmCallback("nc:abcde123:n")).toEqual({ id: "abcde123", action: "cancel" });
  });

  test("rejects a malformed action code (tampered callback_data)", () => {
    expect(resolveNlConfirmCallback("nc:abcde123:x")).toBeNull();
  });

  test("rejects anything not matching the nc: shape", () => {
    expect(resolveNlConfirmCallback("fc:kill:abcde123:y")).toBeNull();
    expect(resolveNlConfirmCallback("nc:abcde123")).toBeNull();
    expect(resolveNlConfirmCallback("garbage")).toBeNull();
  });
});

describe("buildNlConfirmKeyboard", () => {
  test("builds a run/stop-asking/cancel stack matching resolveNlConfirmCallback's own encoding", () => {
    const keyboard = buildNlConfirmKeyboard("abcde123");
    const flat = keyboard.flat().map((btn) => btn.callback_data);
    for (const data of flat) {
      expect(resolveNlConfirmCallback(data)).not.toBeNull();
    }
    expect(flat).toEqual(["nc:abcde123:y", "nc:abcde123:s", "nc:abcde123:n"]);
  });
});
