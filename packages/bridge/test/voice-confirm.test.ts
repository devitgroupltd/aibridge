import { describe, expect, test } from "bun:test";
import { buildVoiceConfirmKeyboard, resolveVoiceConfirmCallback, VoiceConfirmRegistry } from "../src/voice-confirm.ts";

function entry(overrides: Partial<Parameters<VoiceConfirmRegistry["add"]>[0]> = {}) {
  return {
    id: "abcde123",
    threadId: 5,
    messageId: 42,
    transcript: "push the fix now",
    from: "operator",
    confirmCardMessageId: 100,
    origin: {},
    ...overrides,
  };
}

describe("VoiceConfirmRegistry", () => {
  test("resolving one id does not resolve a concurrent, independent confirm", () => {
    const registry = new VoiceConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa", transcript: "push it" }));
    registry.add(entry({ id: "bbbbbbbb", transcript: "commit it" }));

    expect(registry.resolve("aaaaaaaa")?.transcript).toBe("push it");
    expect(registry.resolve("aaaaaaaa")).toBeUndefined(); // consumed
    expect(registry.resolve("bbbbbbbb")?.transcript).toBe("commit it");
  });

  test("resolving an unknown id returns undefined without throwing", () => {
    const registry = new VoiceConfirmRegistry();
    registry.add(entry({ id: "aaaaaaaa" }));

    expect(() => registry.resolve("zzzzzzzz")).not.toThrow();
    expect(registry.resolve("zzzzzzzz")).toBeUndefined();
  });

  test("an expired id is refused even though it still matches a real entry", () => {
    let now = 0;
    const registry = new VoiceConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa" }));

    now = 1001;
    expect(registry.resolve("aaaaaaaa")).toBeUndefined();
  });

  test("resolving within the TTL succeeds and returns the full transcript payload", () => {
    let now = 0;
    const registry = new VoiceConfirmRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ id: "aaaaaaaa", transcript: "проверь тесты", threadId: undefined, from: "boss" }));

    now = 999;
    const resolved = registry.resolve("aaaaaaaa");
    expect(resolved?.transcript).toBe("проверь тесты");
    expect(resolved?.threadId).toBeUndefined();
    expect(resolved?.from).toBe("boss");
  });
});

describe("resolveVoiceConfirmCallback", () => {
  test("resolves send/send_and_stop_asking/rerecord/type taps", () => {
    expect(resolveVoiceConfirmCallback("vc:abcde123:s")).toEqual({ id: "abcde123", action: "send" });
    expect(resolveVoiceConfirmCallback("vc:abcde123:a")).toEqual({ id: "abcde123", action: "send_and_stop_asking" });
    expect(resolveVoiceConfirmCallback("vc:abcde123:r")).toEqual({ id: "abcde123", action: "rerecord" });
    expect(resolveVoiceConfirmCallback("vc:abcde123:t")).toEqual({ id: "abcde123", action: "type" });
    expect(resolveVoiceConfirmCallback("vc:abcde123:c")).toEqual({ id: "abcde123", action: "cancel" });
  });

  test("rejects a malformed action code (tampered callback_data)", () => {
    expect(resolveVoiceConfirmCallback("vc:abcde123:x")).toBeNull();
  });

  test("rejects anything not matching the vc: shape, including a different namespace", () => {
    expect(resolveVoiceConfirmCallback("sc:abcde123:y")).toBeNull();
    expect(resolveVoiceConfirmCallback("perm:abcde:a")).toBeNull();
    expect(resolveVoiceConfirmCallback("vc:abcde123")).toBeNull();
    expect(resolveVoiceConfirmCallback("garbage")).toBeNull();
  });
});

describe("buildVoiceConfirmKeyboard", () => {
  test("builds send/send-and-stop-asking/re-record/type/cancel buttons matching resolveVoiceConfirmCallback's own encoding", () => {
    const keyboard = buildVoiceConfirmKeyboard("abcde123");
    const flat = keyboard.flat().map((btn) => btn.callback_data!);
    for (const data of flat) {
      expect(resolveVoiceConfirmCallback(data)).not.toBeNull();
    }
    expect(flat).toHaveLength(5);
  });

  test("Send and Send-don't-ask-again each get their own row, separate from the three discard actions", () => {
    const keyboard = buildVoiceConfirmKeyboard("abcde123");
    expect(keyboard).toHaveLength(3);
    expect(keyboard[0]).toHaveLength(1);
    expect(resolveVoiceConfirmCallback(keyboard[0]?.[0]?.callback_data ?? "")?.action).toBe("send");
    expect(keyboard[1]).toHaveLength(1);
    expect(resolveVoiceConfirmCallback(keyboard[1]?.[0]?.callback_data ?? "")?.action).toBe("send_and_stop_asking");
    expect(keyboard[2]).toHaveLength(3);
  });
});
