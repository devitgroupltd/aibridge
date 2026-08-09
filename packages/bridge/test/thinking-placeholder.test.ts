import { describe, expect, test } from "bun:test";
import { createThinkingPlaceholder } from "../src/thinking-placeholder.ts";

describe("createThinkingPlaceholder", () => {
  test("consume returns the message_id from the placeholder send, once", async () => {
    const placeholder = createThinkingPlaceholder({
      send: async () => 42,
    });

    placeholder.start("3");
    expect(await placeholder.consume("3")).toBe(42);
    // Consumed once - a second consume for the same topic finds nothing pending.
    expect(await placeholder.consume("3")).toBeUndefined();
  });

  test("consume for a topic with no pending placeholder resolves to undefined", async () => {
    const placeholder = createThinkingPlaceholder({ send: async () => 1 });
    expect(await placeholder.consume("no-such-topic")).toBeUndefined();
  });

  test("a failed placeholder send resolves consume to undefined instead of throwing", async () => {
    const warnings: string[] = [];
    const placeholder = createThinkingPlaceholder({
      send: async () => {
        throw new Error("network blip");
      },
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });

    placeholder.start("3");
    expect(await placeholder.consume("3")).toBeUndefined();
    expect(warnings[0]).toMatch(/topic "3"/);
  });

  test("starting again for the same topic before it's consumed is a no-op, not a second message", async () => {
    // 2026-08-09: `nl-dispatch.ts`'s `routeOrFallback` starts one to cover its router-call latency,
    // then a no-match forward hands the same topic to `pty-io.ts`'s `sendChannelText`, which starts
    // another to cover the turn that follows - both calls are covering the same in-flight turn, so
    // the second must be a no-op rather than sending (and then orphaning) a second message.
    let calls = 0;
    const placeholder = createThinkingPlaceholder({
      send: async () => {
        calls++;
        return calls;
      },
    });

    placeholder.start("3");
    placeholder.start("3"); // same turn, covered twice - must not send again
    expect(await placeholder.consume("3")).toBe(1);
    expect(calls).toBe(1);
  });
});
