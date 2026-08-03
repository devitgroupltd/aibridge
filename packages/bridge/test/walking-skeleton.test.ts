import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { StubTelegramServer } from "@aibridge/stub-telegram";
import type { ChannelMetaFields } from "@aibridge/protocol";
import { startPipeServer } from "../src/pipe-server.ts";
import { Routing } from "../src/routing.ts";
import { startPolling, TelegramClient, validateTokens } from "../src/telegram.ts";

/**
 * §9 scenario 29, the Phase 1 exit criterion: "an inbound message reaches Claude, and a `reply`
 * lands in the right topic." The real end-to-end form (a genuine `claude` process on a real
 * Telegram group) is Stage 7's manual verification - this automated version stands a real MCP
 * client in for Claude Code itself, connected to the real channel server over real stdio, so the
 * whole plumbing aibridge owns (Bridge <-> pipe <-> channel server <-> MCP) is exercised in CI
 * without needing a live, costed Claude Code session.
 */

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function spawnEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("walking skeleton (§9 scenario 29)", () => {
  test(
    "an inbound Telegram message reaches the channel server and a reply lands in the right topic",
    async () => {
      const stub = new StubTelegramServer();
      cleanups.push(() => stub.stop());
      const { baseUrl } = stub.start(0);

      const controlToken = "control-token";
      const feedToken = "feed-token";
      const chatId = "-1004470540564";
      const topicId = 3;
      const slug = "test-session";

      const controlBot = new TelegramClient(controlToken, baseUrl);
      const feedBot = new TelegramClient(feedToken, baseUrl);
      await validateTokens(controlBot, feedBot);

      const routing = new Routing();
      routing.add({ slug, topicId, worktreePath: "unused-in-this-test" });

      const pipePath = `\\\\.\\pipe\\aibridge-scenario29-${crypto.randomUUID()}`;
      const pipe = startPipeServer({ pipePath, routing, controlBot, chatId });
      cleanups.push(() => {
        pipe.server.close();
      });

      let seq = 0;
      const stopPolling = startPolling(controlBot, {
        timeoutSec: 1,
        retryDelayMs: 50,
        onUpdate: (update) => {
          const message = update.message;
          if (!message?.text) return;
          if (message.message_thread_id !== topicId) return;
          seq += 1;
          const meta: ChannelMetaFields = {
            topic_id: String(topicId),
            msg_id: String(message.message_id),
            from: message.from?.username ?? "unknown",
            seq,
          };
          pipe.sendInbound(slug, message.text, meta);
        },
      });
      cleanups.push(() => stopPolling());

      // Stand in for `claude --dangerously-load-development-channels server:aibridge`: spawn the
      // real channel server over stdio, exactly as Claude Code would.
      const channelServerEntry = path.resolve(import.meta.dirname, "../../channel-server/src/index.ts");
      const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", channelServerEntry],
        env: spawnEnv({ AIBRIDGE_SLUG: slug, AIBRIDGE_PIPE_PATH: pipePath }),
        stderr: "pipe",
      });

      // Stand in for Claude Code itself: a real MCP client receiving the channel notification and
      // deciding to call the `reply` tool.
      const client = new Client({ name: "test-claude-stand-in", version: "0.0.1" }, { capabilities: {} });
      const notifications: Array<{ content: string; meta: Record<string, unknown> }> = [];
      client.fallbackNotificationHandler = async (notification: Notification) => {
        if (notification.method === "notifications/claude/channel") {
          notifications.push(notification.params as { content: string; meta: Record<string, unknown> });
        }
      };

      await client.connect(transport);
      cleanups.push(() => client.close());

      // The operator sends a message from the phone, in the test-session topic.
      stub.pushUpdate(controlToken, { chatId: Number(chatId), text: "hello from telegram", messageThreadId: topicId });

      await waitFor(() => notifications.length >= 1);
      expect(notifications[0]?.content).toBe("hello from telegram");
      expect(notifications[0]?.meta).toMatchObject({ topic_id: "3", from: "unknown" });

      // Claude reads it and decides to reply - the stand-in client calls the same tool Claude
      // Code would, echoing back the topic_id exactly as §3.1's own instructions tell it to.
      const topicIdFromTag = notifications[0]?.meta.topic_id as string;
      await client.callTool({ name: "reply", arguments: { topic_id: topicIdFromTag, text: "hi from claude" } });

      await waitFor(() => stub.getSent(controlToken).length >= 1);
      const sent = stub.getSent(controlToken)[0];
      expect(sent).toMatchObject({ chat_id: Number(chatId), message_thread_id: topicId, text: "hi from claude" });
    },
    20000,
  );
});
