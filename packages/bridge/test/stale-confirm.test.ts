import { describe, expect, test } from "bun:test";
import { buildStaleConfirmKeyboard, resolveStaleConfirmCallback, StaleConfirmRegistry } from "../src/stale-confirm.ts";

function entry(overrides: Partial<Parameters<StaleConfirmRegistry["add"]>[0]> = {}) {
  return {
    id: "abcde123",
    threadId: 5,
    messageId: 42,
    rawText: "push it",
    from: "operator",
    confirmCardMessageId: 100,
    ...overrides,
  };
}

describe("StaleConfirmRegistry", () => {
  test("resolving one id does not resolve a concurrent, independent confirm", () => {
    const registry = new StaleConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa", rawText: "push it" }));
    registry.add(entry({ id: "bbbbbbbb", rawText: "commit it" }));

    expect(registry.resolve("aaaaaaaa")?.rawText).toBe("push it");
    // resolving one is consuming - it's gone even if looked up again
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
    // the other, unrelated entry is untouched
    expect(registry.resolve("bbbbbbbb")?.rawText).toBe("commit it");
  });

  test("resolving an unknown id returns undefined without throwing", () => {
    const registry = new StaleConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));

    expect(() => registry.resolve("zzzzzzzz")).not.toThrow();
    expect(registry.resolve("zzzzzzzz")).toBeUndefined();
  });

  test("an expired id is refused even though it still matches a real entry - a forgotten card goes cold", () => {
    let now = 0;
    const registry = new StaleConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa" }));

    now = 1001; // just past the TTL
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
  });

  test("resolving within the TTL succeeds and returns the full replay payload", () => {
    let now = 0;
    const registry = new StaleConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa", rawText: "/ls", threadId: undefined, from: "boss" }));

    now = 999;
    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.rawText).toBe("/ls");
    expect(resolved?.threadId).toBeUndefined();
    expect(resolved?.from).toBe("boss");
  });
});

describe("resolveStaleConfirmCallback", () => {
  test("resolves a yes and a no tap", () => {
    expect(resolveStaleConfirmCallback("sc:abcde123:y")).toEqual({ id: "abcde123", confirmed: true });
    expect(resolveStaleConfirmCallback("sc:abcde123:n")).toEqual({ id: "abcde123", confirmed: false });
  });

  test("rejects a malformed confirmation code (tampered callback_data)", () => {
    expect(resolveStaleConfirmCallback("sc:abcde123:x")).toBeNull();
  });

  test("rejects anything not matching the sc: shape, including a different namespace", () => {
    expect(resolveStaleConfirmCallback("fc:kill:abcde123:y")).toBeNull();
    expect(resolveStaleConfirmCallback("perm:abcde:a")).toBeNull();
    expect(resolveStaleConfirmCallback("sc:abcde123")).toBeNull();
    expect(resolveStaleConfirmCallback("garbage")).toBeNull();
  });
});

describe("buildStaleConfirmKeyboard", () => {
  test("builds a yes/no row matching resolveStaleConfirmCallback's own encoding", () => {
    const keyboard = buildStaleConfirmKeyboard("abcde123");
    const flat = keyboard.flat().map((btn) => btn.callback_data!);
    for (const data of flat) {
      expect(resolveStaleConfirmCallback(data)).not.toBeNull();
    }
    expect(flat).toHaveLength(2);
  });
});
