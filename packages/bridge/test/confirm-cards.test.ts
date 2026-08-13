import { describe, expect, test } from "bun:test";
import { createConfirmCards } from "../src/confirm-cards.ts";
import { FleetConfirmRegistry } from "../src/fleet-confirm.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { retryTopicKey, RetryStore } from "../src/retry-store.ts";
import type { PendingNlConfirm } from "../src/nl-confirm.ts";
import type { PendingStaleConfirm } from "../src/stale-confirm.ts";
import type { PendingVoiceConfirm } from "../src/voice-confirm.ts";
import { fakeControlBot } from "./helpers.ts";

/** The shared double, plus the one variant this module needs: a control bot with *no*
 * `editMessageText` at all, which is the degraded-client path `confirm-cards.ts` guards for. */
function fakeConfirmCardsBot(overrides: { editMessageText?: boolean } = {}) {
  const base = fakeControlBot();
  return {
    ...base,
    editMessageText: overrides.editMessageText === false ? undefined : base.editMessageText,
    edits: base.edited,
  };
}

function setup(overrides: Partial<Parameters<typeof createConfirmCards>[0]> = {}) {
  const controlBot = fakeConfirmCardsBot();
  const feedGovernor = new RateGovernor({ log: () => {} });
  const retryStore = new RetryStore();
  const confirmCards = createConfirmCards({
    controlBot,
    feedGovernor,
    supergroupChatId: "-100",
    retryStore,
    ...overrides,
  });
  return { confirmCards, controlBot, retryStore };
}

describe("createConfirmCards", () => {
  test("finalizeCard edits the message and strips its keyboard", async () => {
    const { confirmCards, controlBot } = setup();
    await confirmCards.finalizeCard(42, "done");
    // The stripped keyboard is asserted, not just the text - this test's own name is about the
    // keyboard, and the shared double (helpers.ts) records it where the local one used to drop it.
    expect(controlBot.edits).toEqual([{ messageId: 42, text: "done", keyboard: { inline_keyboard: [] } }]);
  });

  test("finalizeCard is a no-op when the control bot has no editMessageText", async () => {
    const controlBot = fakeConfirmCardsBot({ editMessageText: false });
    const { confirmCards } = setup({ controlBot });
    await expect(confirmCards.finalizeCard(42, "done")).resolves.toBeUndefined();
  });

  test("markConfirmCardExpired posts the standard expiry text", async () => {
    const { confirmCards, controlBot } = setup();
    await confirmCards.markConfirmCardExpired(7);
    expect(controlBot.edits[0]?.text).toContain("expired");
  });

  test("markNlConfirmCardExpired stashes the command in retryStore and posts the /retry-flavored text", async () => {
    const { confirmCards, controlBot, retryStore } = setup();
    const entry: PendingNlConfirm = {
      id: "n1",
      command: { kind: "kill", slug: "fix-bug" } as unknown as PendingNlConfirm["command"],
      threadId: 5,
      currentSlug: "fix-bug",
      messageId: 99,
      createdAt: 0,
    };

    await confirmCards.markNlConfirmCardExpired(entry);

    expect(controlBot.edits[0]?.messageId).toBe(99);
    expect(controlBot.edits[0]?.text).toContain("/retry");
    const stashed = retryStore.resolve(retryTopicKey(5));
    expect(stashed).toMatchObject({ command: entry.command, threadId: 5, currentSlug: "fix-bug" });
  });

  test("notifyConfirmGone posts the restart-flavored text when the id was never seen and a messageId is present", async () => {
    const { confirmCards, controlBot } = setup();
    const registry = { wasRecentlyAnswered: () => false };
    confirmCards.notifyConfirmGone(registry, "gone-id", 11);
    await Promise.resolve();
    await Promise.resolve();
    expect(controlBot.edits.length).toBe(1);
    expect(controlBot.edits[0]?.text).toContain("no longer valid");
  });

  test("notifyConfirmGone stays silent for a duplicate tap on an already-answered id", () => {
    const { confirmCards, controlBot } = setup();
    const registry = { wasRecentlyAnswered: () => true };
    confirmCards.notifyConfirmGone(registry, "answered-id", 11);
    expect(controlBot.edits).toEqual([]);
  });

  test("notifyConfirmGone stays silent when there's no messageId to edit", () => {
    const { confirmCards, controlBot } = setup();
    const registry = { wasRecentlyAnswered: () => false };
    confirmCards.notifyConfirmGone(registry, "gone-id", undefined);
    expect(controlBot.edits).toEqual([]);
  });

  test("finalizeFleetConfirmMessage/finalizeStaleConfirmMessage/finalizeVoiceConfirmMessage/finalizeNlConfirmMessage all route through finalizeCard on their own message-id field", async () => {
    const { confirmCards, controlBot } = setup();

    await confirmCards.finalizeFleetConfirmMessage({ id: "f1", kind: "kill", slugs: [], topicId: 1, messageId: 1, createdAt: 0 }, "fleet done");
    await confirmCards.finalizeStaleConfirmMessage(
      { id: "s1", threadId: 1, messageId: 2, rawText: "hi", from: "op", confirmCardMessageId: 20, origin: {}, createdAt: 0 } as PendingStaleConfirm,
      "stale done",
    );
    await confirmCards.finalizeVoiceConfirmMessage(
      { id: "v1", threadId: 1, messageId: 3, transcript: "hello", from: "op", confirmCardMessageId: 30, origin: {}, createdAt: 0 } as PendingVoiceConfirm,
      "✅ Sent.",
    );
    await confirmCards.finalizeNlConfirmMessage(
      { id: "n1", command: {} as PendingNlConfirm["command"], threadId: 1, currentSlug: undefined, messageId: 4, createdAt: 0 },
      "nl done",
    );

    expect(controlBot.edits).toEqual([
      { messageId: 1, text: "fleet done", keyboard: { inline_keyboard: [] } },
      { messageId: 20, text: "stale done", keyboard: { inline_keyboard: [] } },
      { messageId: 30, text: "🎤 hello\n\n✅ Sent.", keyboard: { inline_keyboard: [] } },
      { messageId: 4, text: "nl done", keyboard: { inline_keyboard: [] } },
    ]);
  });

  describe("takeOrNotifyGone", () => {
    test("returns the live entry for a fresh, unexpired id", () => {
      const { confirmCards } = setup();
      const registry = new FleetConfirmRegistry();
      registry.add({ id: "id-1", kind: "kill", slugs: ["fix-bug"], topicId: 2, messageId: 5 });

      let markedExpired = false;
      const entry = confirmCards.takeOrNotifyGone(registry, "id-1", 5, () => {
        markedExpired = true;
      });

      expect(entry?.slugs).toEqual(["fix-bug"]);
      expect(markedExpired).toBe(false);
    });

    test("calls markExpiredFn and returns undefined for an entry past its TTL", () => {
      const { confirmCards } = setup();
      let nowMs = 0;
      const registry = new FleetConfirmRegistry({ ttlMs: 100, now: () => nowMs });
      registry.add({ id: "id-1", kind: "kill", slugs: ["fix-bug"], topicId: 2, messageId: 5 });
      nowMs = 1000; // well past the TTL

      let expiredEntry: unknown;
      const result = confirmCards.takeOrNotifyGone(registry, "id-1", 5, (entry) => {
        expiredEntry = entry;
      });

      expect(result).toBeUndefined();
      expect((expiredEntry as { messageId: number } | undefined)?.messageId).toBe(5);
    });

    test("notifies gone (posts the restart-flavored text) and returns undefined for an unknown id", async () => {
      const { confirmCards, controlBot } = setup();
      const registry = new FleetConfirmRegistry();

      const result = confirmCards.takeOrNotifyGone(registry, "never-existed", 5, () => {});
      await Promise.resolve();
      await Promise.resolve();

      expect(result).toBeUndefined();
      expect(controlBot.edits[0]?.text).toContain("no longer valid");
    });
  });
});
