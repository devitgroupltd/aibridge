import { describe, expect, test } from "bun:test";
import { buildRepoPickKeyboard, RepoPickRegistry, resolveRepoPickCallback } from "../src/repo-picker.ts";

function entry(overrides: Partial<Parameters<RepoPickRegistry["add"]>[0]> = {}) {
  return {
    id: "abcde123",
    prompt: "analyze this alarm",
    sourceText: "create a session for analyze this alarm",
    model: undefined,
    threadId: 1,
    messageId: 10,
    ...overrides,
  };
}

describe("RepoPickRegistry", () => {
  test("resolving one id does not resolve a concurrent, independent pick", () => {
    const registry = new RepoPickRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));
    registry.add(entry({ id: "bbbbbbbb", prompt: "fix the flaky test" }));

    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.prompt).toBe("analyze this alarm");
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
    expect(registry.resolve("bbbbbbbb")?.prompt).toBe("fix the flaky test");
  });

  test("resolving an unknown id returns undefined without throwing", () => {
    const registry = new RepoPickRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));
    expect(() => registry.resolve("zzzzzzzz")).not.toThrow();
    expect(registry.resolve("zzzzzzzz")).toBeUndefined();
  });

  test("an expired id is refused even though it still matches a real entry", () => {
    let now = 0;
    const registry = new RepoPickRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa" }));
    now = 1001;
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
  });

  test("resolving within the TTL succeeds and returns the registered prompt/sourceText/model", () => {
    let now = 0;
    const registry = new RepoPickRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa", model: "opus" }));
    now = 999;
    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.sourceText).toBe("create a session for analyze this alarm");
    expect(resolved?.model).toBe("opus");
  });
});

describe("resolveRepoPickCallback", () => {
  test("resolves a repo choice", () => {
    expect(resolveRepoPickCallback("rp:abcde123:aibridge")).toEqual({ id: "abcde123", repo: "aibridge" });
  });

  test("resolves the cancel token", () => {
    expect(resolveRepoPickCallback("rp:abcde123:_cancel")).toEqual({ id: "abcde123", cancel: true });
  });

  test("rejects anything not matching the rp: shape", () => {
    expect(resolveRepoPickCallback("nc:abcde123:aibridge")).toBeNull();
    expect(resolveRepoPickCallback("rp:abcde123")).toBeNull();
    expect(resolveRepoPickCallback("garbage")).toBeNull();
  });
});

describe("buildRepoPickKeyboard", () => {
  test("builds one row per repo plus a trailing cancel row, matching resolveRepoPickCallback's own encoding", () => {
    const keyboard = buildRepoPickKeyboard("abcde123", ["aibridge", "seowrite"]);
    const flat = keyboard.flat().map((btn) => btn.callback_data!);
    for (const data of flat) {
      expect(resolveRepoPickCallback(data)).not.toBeNull();
    }
    expect(flat).toEqual(["rp:abcde123:aibridge", "rp:abcde123:seowrite", "rp:abcde123:_cancel"]);
  });

  test("still posts just the cancel row when no repos are given", () => {
    const keyboard = buildRepoPickKeyboard("abcde123", []);
    expect(keyboard.flat().map((btn) => btn.callback_data!)).toEqual(["rp:abcde123:_cancel"]);
  });
});
