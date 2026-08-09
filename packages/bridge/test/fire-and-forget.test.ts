import { describe, expect, test } from "bun:test";
import { fireAndForget } from "../src/fire-and-forget.ts";

describe("fireAndForget", () => {
  test("a rejecting promise is logged, not thrown - the whole point (§9, found live 2026-08-09)", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    fireAndForget(Promise.reject(new Error("boom")), (level, message) => logs.push({ level, message }), "test context");

    // Let the rejection's own microtask settle before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("ERROR");
    expect(logs[0]?.message).toContain("test context");
    expect(logs[0]?.message).toContain("boom");
  });

  test("a resolving promise logs nothing", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    fireAndForget(Promise.resolve("fine"), (level, message) => logs.push({ level, message }), "test context");

    await Promise.resolve();
    await Promise.resolve();

    expect(logs).toHaveLength(0);
  });

  test("a caller passing a synchronous non-promise value (a loosely-typed test double, common for injected async callbacks) never throws", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    // Deliberately not a real Promise - some injected `() => Promise<void>` callbacks are backed by
    // synchronous stubs in tests. This must not throw "x.catch is not a function".
    expect(() => fireAndForget(undefined as unknown as Promise<unknown>, (level, message) => logs.push({ level, message }), "sync stub")).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();

    expect(logs).toHaveLength(0);
  });
});
