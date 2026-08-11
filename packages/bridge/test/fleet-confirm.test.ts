import { describe, expect, test } from "bun:test";
import { autoConfirmKind, buildFleetConfirmKeyboard, FleetConfirmRegistry, parseAutoConfirmKind, resolveFleetConfirmCallback } from "../src/fleet-confirm.ts";

function entry(overrides: Partial<Parameters<FleetConfirmRegistry["add"]>[0]> = {}) {
  return {
    id: "abcde123",
    kind: "kill" as const,
    slugs: ["fix-bug"],
    topicId: 1,
    messageId: 10,
    ...overrides,
  };
}

describe("FleetConfirmRegistry", () => {
  test("resolving one id does not resolve a concurrent, independent confirm", () => {
    const registry = new FleetConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa", kind: "kill" }));
    registry.add(entry({ id: "bbbbbbbb", kind: "rm" }));

    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.kind).toBe("kill");
    // resolving one is consuming - it's gone even if looked up again
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
    // the other, unrelated entry is untouched
    expect(registry.resolve("bbbbbbbb")?.kind).toBe("rm");
  });

  test("resolving an unknown id returns undefined without throwing", () => {
    const registry = new FleetConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));

    expect(() => registry.resolve("zzzzzzzz")).not.toThrow();
    expect(registry.resolve("zzzzzzzz")).toBeUndefined();
  });

  test("an expired id is refused even though it still matches a real entry", () => {
    let now = 0;
    const registry = new FleetConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa" }));

    now = 1001; // just past the TTL
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
  });

  test("resolving within the TTL succeeds and returns the registered slugs", () => {
    let now = 0;
    const registry = new FleetConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa", slugs: ["a", "b", "c"] }));

    now = 999;
    expect(registry.resolve("aaaaaaaa")?.slugs).toEqual(["a", "b", "c"]);
  });

  test("an rm-topic entry carries no slugs but keeps its topicId (§4.5.2 - acts on the topic directly)", () => {
    const registry = new FleetConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa", kind: "rm-topic", slugs: [], topicId: 42 }));

    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.kind).toBe("rm-topic");
    expect(resolved?.slugs).toEqual([]);
    expect(resolved?.topicId).toBe(42);
  });
});

describe("resolveFleetConfirmCallback", () => {
  test("resolves a yes and a no tap for kill, rm, and rm-topic", () => {
    expect(resolveFleetConfirmCallback("fc:kill:abcde123:y")).toEqual({ id: "abcde123", kind: "kill", confirmed: true });
    expect(resolveFleetConfirmCallback("fc:kill:abcde123:n")).toEqual({ id: "abcde123", kind: "kill", confirmed: false });
    expect(resolveFleetConfirmCallback("fc:rm:abcde123:y")).toEqual({ id: "abcde123", kind: "rm", confirmed: true });
    // §4.5.2: orphaned-Telegram-topic delete, keyed off topicId alone, no session row involved.
    expect(resolveFleetConfirmCallback("fc:rm-topic:abcde123:y")).toEqual({ id: "abcde123", kind: "rm-topic", confirmed: true });
    expect(resolveFleetConfirmCallback("fc:rm-topic:abcde123:n")).toEqual({ id: "abcde123", kind: "rm-topic", confirmed: false });
  });

  test("resolves all four /auto --all kinds - a card that posts but never resolves is a dead button", () => {
    for (const kind of ["permission-on", "permission-off", "answer-on", "answer-off"] as const) {
      expect(resolveFleetConfirmCallback(`fc:${kind}:abcde123:y`)).toEqual({ id: "abcde123", kind, confirmed: true });
      expect(resolveFleetConfirmCallback(`fc:${kind}:abcde123:n`)).toEqual({ id: "abcde123", kind, confirmed: false });
    }
  });

  test("rejects an unknown kind or malformed confirmation code (tampered callback_data)", () => {
    expect(resolveFleetConfirmCallback("fc:restart:abcde123:y")).toBeNull();
    expect(resolveFleetConfirmCallback("fc:kill:abcde123:x")).toBeNull();
  });

  test("rejects anything not matching the fc: shape", () => {
    expect(resolveFleetConfirmCallback("perm:abcde:a")).toBeNull();
    expect(resolveFleetConfirmCallback("fc:kill:abcde123")).toBeNull();
    expect(resolveFleetConfirmCallback("garbage")).toBeNull();
  });
});

describe("autoConfirmKind / parseAutoConfirmKind", () => {
  test("round-trips both categories in both directions", () => {
    for (const category of ["permission", "answer"] as const) {
      for (const on of [true, false]) {
        expect(parseAutoConfirmKind(autoConfirmKind(category, on))).toEqual({ category, on });
      }
    }
  });

  test('returns null for every non-auto kind - "rm-topic" especially', () => {
    // The reason this isn't a generic `kind.split("-")`: that reads "rm-topic" as category "rm",
    // value "topic", turning an /rm --all tap into an auto-toggle on a category that doesn't exist.
    expect(parseAutoConfirmKind("rm-topic")).toBeNull();
    expect(parseAutoConfirmKind("kill")).toBeNull();
    expect(parseAutoConfirmKind("rm")).toBeNull();
  });
});

describe("buildFleetConfirmKeyboard", () => {
  test("builds a yes/cancel row matching resolveFleetConfirmCallback's own encoding", () => {
    const keyboard = buildFleetConfirmKeyboard("rm", "abcde123");
    const flat = keyboard.flat().map((btn) => btn.callback_data!);
    for (const data of flat) {
      expect(resolveFleetConfirmCallback(data)).not.toBeNull();
    }
    expect(flat).toEqual(["fc:rm:abcde123:y", "fc:rm:abcde123:n"]);
  });

  test("also builds a valid rm-topic row (§4.5.2)", () => {
    const keyboard = buildFleetConfirmKeyboard("rm-topic", "abcde123");
    const flat = keyboard.flat().map((btn) => btn.callback_data!);
    expect(flat).toEqual(["fc:rm-topic:abcde123:y", "fc:rm-topic:abcde123:n"]);
  });
});
