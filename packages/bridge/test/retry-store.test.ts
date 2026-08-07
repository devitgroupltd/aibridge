import { describe, expect, test } from "bun:test";
import { isRetryPhrase, retryTopicKey, RetryStore } from "../src/retry-store.ts";

function entry(overrides: Partial<Parameters<RetryStore["add"]>[0]> = {}) {
  return {
    id: retryTopicKey(1),
    command: { kind: "restart" as const },
    threadId: 1,
    currentSlug: undefined,
    ...overrides,
  };
}

describe("RetryStore", () => {
  test("stashed by topic key, resolved once, then gone", () => {
    const store = new RetryStore();
    store.add(entry());
    const resolved = store.resolve(retryTopicKey(1));
    expect(resolved?.command.kind).toBe("restart");
    expect(store.resolve(retryTopicKey(1))).toBeUndefined();
  });

  test("independent topics don't collide", () => {
    const store = new RetryStore();
    store.add(entry({ id: retryTopicKey(1), command: { kind: "restart" } }));
    store.add(entry({ id: retryTopicKey(2), command: { kind: "kill", slug: "fix-bug" } }));
    expect(store.resolve(retryTopicKey(1))?.command.kind).toBe("restart");
    expect(store.resolve(retryTopicKey(2))?.command.kind).toBe("kill");
  });

  test("the control topic (threadId undefined) gets its own fixed key", () => {
    expect(retryTopicKey(undefined)).toBe("control");
    expect(retryTopicKey(undefined)).not.toBe(retryTopicKey(1));
  });

  test("a second expiry for the same topic overwrites the first (only the most recent survives)", () => {
    const store = new RetryStore();
    store.add(entry({ command: { kind: "restart" } }));
    store.add(entry({ command: { kind: "kill", slug: "fix-bug" } }));
    expect(store.resolve(retryTopicKey(1))?.command.kind).toBe("kill");
  });

  test("past its own TTL, resolve refuses it", () => {
    let now = 0;
    const store = new RetryStore({ now: () => now, ttlMs: 1000 });
    store.add(entry());
    now = 1001;
    expect(store.resolve(retryTopicKey(1))).toBeUndefined();
  });
});

describe("isRetryPhrase", () => {
  test("matches the slash command, with and without the slash, case-insensitively", () => {
    expect(isRetryPhrase("/retry")).toBe(true);
    expect(isRetryPhrase("retry")).toBe(true);
    expect(isRetryPhrase("Retry")).toBe(true);
    expect(isRetryPhrase("RETRY")).toBe(true);
  });

  test("tolerates trailing punctuation a voice transcript tends to add", () => {
    expect(isRetryPhrase("Retry.")).toBe(true);
    expect(isRetryPhrase("retry!")).toBe(true);
    expect(isRetryPhrase("retry?")).toBe(true);
  });

  test("matches the natural-language equivalents too", () => {
    expect(isRetryPhrase("try again")).toBe(true);
    expect(isRetryPhrase("Try again.")).toBe(true);
    expect(isRetryPhrase("do it again")).toBe(true);
    expect(isRetryPhrase("do that again!")).toBe(true);
  });

  test("does not match ordinary chatter that merely contains the word", () => {
    expect(isRetryPhrase("can you retry the build")).toBe(false);
    expect(isRetryPhrase("retry once you fix it")).toBe(false);
    expect(isRetryPhrase("")).toBe(false);
  });
});
