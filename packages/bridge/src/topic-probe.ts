export interface ChatActionSource {
  sendChatAction(chatId: string | number, messageThreadId: number | undefined, action: string): Promise<void>;
}

/**
 * §4.5's "row exists, topic deleted in Telegram" case. There is no `getForumTopic` in the Bot
 * API to just ask - the only way to find out is to try something against the thread and read the
 * error. A `sendChatAction("typing")` probe is the least intrusive real call available: it never
 * posts a visible message (the indicator self-clears in ~5s and leaves no trace if the topic is
 * fine), unlike `sendMessage` or re-`closeForumTopic`-ing a topic that might still be open. Telegram
 * returns "Bad Request: message thread not found" (confirmed against the Bot API's own error
 * text) when `messageThreadId` no longer resolves to a live topic; any other failure (network
 * blip, rate limit) is treated as "can't tell" rather than "deleted" - a false "deleted" verdict
 * kills a row that might still be perfectly healthy, so this only returns true on that specific,
 * unambiguous error text.
 */
export async function isTopicDeleted(bot: ChatActionSource, chatId: string | number, topicId: number): Promise<boolean> {
  try {
    await bot.sendChatAction(chatId, topicId, "typing");
    return false;
  } catch (err) {
    return /message thread not found/i.test((err as Error).message);
  }
}
