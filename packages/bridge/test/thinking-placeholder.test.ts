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

  // P0-5 (codebase-hardening-plan.md): the in-memory `pending` map can't survive a Bridge restart -
  // `persist` is the cross-restart escape hatch. These cover its own contract in isolation;
  // `session-supervisor.test.ts`'s "boot reconciliation relabels a stale thinking placeholder" test
  // covers the consumer side (`runStartupReconciliation` reading what `save` wrote).
  describe("persist hook (P0-5)", () => {
    function fakePersist() {
      const saved = new Map<string, number>();
      const cleared: string[] = [];
      return {
        saved,
        cleared,
        persist: {
          resolveSlug: (topicId: string) => (topicId === "3" ? "fix-bug" : undefined),
          save: (slug: string, messageId: number) => saved.set(slug, messageId),
          clear: (slug: string) => cleared.push(slug),
        },
      };
    }

    test("start saves the message_id under the resolved slug once send resolves", async () => {
      const { saved, persist } = fakePersist();
      const placeholder = createThinkingPlaceholder({ send: async () => 42, persist });

      placeholder.start("3");
      await placeholder.consume("3"); // drains the pending promise so `save` has definitely run

      expect(saved.get("fix-bug")).toBe(42);
    });

    test("consume clears the persisted record once a real reply is ready to replace it", async () => {
      const { cleared, persist } = fakePersist();
      const placeholder = createThinkingPlaceholder({ send: async () => 42, persist });

      placeholder.start("3");
      await placeholder.consume("3");

      expect(cleared).toEqual(["fix-bug"]);
    });

    test("a topic with no matching session row (e.g. the control topic) is a persistence no-op", async () => {
      const { saved, cleared, persist } = fakePersist();
      const placeholder = createThinkingPlaceholder({ send: async () => 7, persist });

      placeholder.start("control-topic"); // resolveSlug returns undefined for anything but "3"
      await placeholder.consume("control-topic");

      expect(saved.size).toBe(0);
      expect(cleared).toEqual([]);
    });

    test("a failed send never calls save - there is no message_id to persist", async () => {
      const { saved, persist } = fakePersist();
      const placeholder = createThinkingPlaceholder({
        send: async () => {
          throw new Error("network blip");
        },
        persist,
      });

      placeholder.start("3");
      await placeholder.consume("3");

      expect(saved.size).toBe(0);
    });

    test("omitting persist entirely still works - existing callers are unaffected", async () => {
      const placeholder = createThinkingPlaceholder({ send: async () => 42 });
      placeholder.start("3");
      expect(await placeholder.consume("3")).toBe(42);
    });
  });
});
