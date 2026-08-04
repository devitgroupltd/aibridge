import { describe, expect, test } from "bun:test";
import { isTopicDeleted } from "../src/topic-probe.ts";

function stubBot(behavior: () => Promise<void>) {
  return { sendChatAction: () => behavior() };
}

describe("isTopicDeleted (§9 scenario 24, §4.5's reconciliation table)", () => {
  test("a successful probe means the topic is still alive", async () => {
    const bot = stubBot(() => Promise.resolve());
    expect(await isTopicDeleted(bot, 1, 42)).toBe(false);
  });

  test("Telegram's exact 'message thread not found' error means the topic was deleted", async () => {
    const bot = stubBot(() => Promise.reject(new Error("Telegram sendChatAction failed: Bad Request: message thread not found")));
    expect(await isTopicDeleted(bot, 1, 42)).toBe(true);
  });

  test("any other failure is treated as inconclusive, not deleted - a false 'deleted' verdict kills a healthy row", async () => {
    const bot = stubBot(() => Promise.reject(new Error("Telegram sendChatAction failed: Too Many Requests")));
    expect(await isTopicDeleted(bot, 1, 42)).toBe(false);
  });
});
