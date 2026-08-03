import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { StubTelegramServer } from "@aibridge/stub-telegram";
import { startPipeServer } from "../src/pipe-server.ts";
import { resolvePermCallback } from "../src/permission-callback.ts";
import { Routing } from "../src/routing.ts";
import { startPolling, TelegramClient, validateTokens } from "../src/telegram.ts";

/**
 * §9 scenario 30, the Phase 2 exit criterion: "a gated Bash call raises a prompt, a simulated tap
 * sends the verdict, and the tool proceeds." As with scenario 29, a real MCP client stands in for
 * Claude Code, connected to the real channel server over real stdio - the whole relay path
 * (channel server -> pipe -> Bridge -> Telegram card -> tapped button -> pipe -> channel server ->
 * Claude) is exercised without a live, costed Claude Code session. The `permission_request`
 * notification shape itself is not invented for this test: it is the exact shape live-verified
 * 2026-08-03 against a real `Write` call under manual mode (see channel-server/src/index.ts).
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

describe("permission relay (§9 scenario 30)", () => {
  test(
    "a gated Bash call raises a prompt, a simulated tap sends the verdict, and the tool proceeds",
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

      const pipePath = `\\\\.\\pipe\\aibridge-scenario30-${crypto.randomUUID()}`;
      const pipe = startPipeServer({ pipePath, routing, controlBot, chatId });
      cleanups.push(() => {
        pipe.server.close();
      });

      // The same perm: handling index.ts's onUpdate wires into the real callback_query branch -
      // reproduced here rather than importing index.ts, which runs a whole Bridge as a side effect
      // of being imported (same reason walking-skeleton.test.ts reimplements its own tiny onUpdate).
      const stopPolling = startPolling(controlBot, {
        timeoutSec: 1,
        retryDelayMs: 50,
        onUpdate: (update) => {
          const callbackQuery = update.callback_query;
          if (!callbackQuery?.data) return;
          void controlBot.answerCallbackQuery(callbackQuery.id);
          const permAction = resolvePermCallback(callbackQuery.data);
          if (!permAction) return;
          const pending = pipe.resolvePermission(permAction.requestId);
          if (!pending) return;
          const behavior = permAction.action === "deny" ? "deny" : "allow";
          pipe.sendVerdict(pending.slug, pending.requestId, behavior);
          void pipe.finalizePermissionMessage(pending.messageId, `${behavior} sent`);
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

      // Stand in for Claude Code itself: a real MCP client that emits the exact
      // permission_request notification shape live-verified against a real gated tool call, then
      // listens for the verdict notification the channel server relays back.
      const client = new Client({ name: "test-claude-stand-in", version: "0.0.1" }, { capabilities: {} });
      const verdicts: Array<{ request_id: string; behavior: string }> = [];
      client.fallbackNotificationHandler = async (notification: Notification) => {
        if (notification.method === "notifications/claude/channel/permission") {
          verdicts.push(notification.params as { request_id: string; behavior: string });
        }
      };

      await client.connect(transport);
      cleanups.push(() => client.close());

      // The gated call: Claude Code emits this when a local permission dialog opens (§6.3).
      await client.notification({
        method: "notifications/claude/channel/permission_request",
        params: {
          request_id: "kqxmr",
          tool_name: "Bash",
          description: "Commit the billing fix",
          input_preview: '{"command":"git commit -m \\"fix(billing): correct proration\\""}',
        },
      });

      // The card lands in the session's topic with an inline keyboard.
      await waitFor(() => stub.getSent(controlToken).length >= 1);
      const sent = stub.getSent(controlToken)[0];
      expect(sent).toMatchObject({ chat_id: Number(chatId), message_thread_id: topicId });
      expect(sent?.text).toContain("Bash");
      expect(sent?.text).toContain("Commit the billing fix");
      expect(sent?.reply_markup).toBeDefined();

      // The operator taps Allow.
      stub.pushCallbackQuery(controlToken, { chatId: Number(chatId), data: "perm:kqxmr:a", messageThreadId: topicId });

      // The verdict round-trips all the way back to the stand-in Claude, and the card is edited to
      // strip its keyboard.
      await waitFor(() => verdicts.length >= 1);
      expect(verdicts[0]).toEqual({ request_id: "kqxmr", behavior: "allow" });

      await waitFor(() => stub.getAnsweredCallbackQueries(controlToken).length >= 1);
      await waitFor(() => stub.getSent(controlToken).some((m) => m.method === "editMessageText"));
      const edited = stub.getSent(controlToken).find((m) => m.method === "editMessageText");
      expect(edited?.reply_markup).toEqual({ inline_keyboard: [] });
    },
    20000,
  );

  test(
    "denying a request sends a deny verdict",
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

      const pipePath = `\\\\.\\pipe\\aibridge-scenario30b-${crypto.randomUUID()}`;
      const pipe = startPipeServer({ pipePath, routing, controlBot, chatId });
      cleanups.push(() => {
        pipe.server.close();
      });

      const stopPolling = startPolling(controlBot, {
        timeoutSec: 1,
        retryDelayMs: 50,
        onUpdate: (update) => {
          const callbackQuery = update.callback_query;
          if (!callbackQuery?.data) return;
          void controlBot.answerCallbackQuery(callbackQuery.id);
          const permAction = resolvePermCallback(callbackQuery.data);
          if (!permAction) return;
          const pending = pipe.resolvePermission(permAction.requestId);
          if (!pending) return;
          const behavior = permAction.action === "deny" ? "deny" : "allow";
          pipe.sendVerdict(pending.slug, pending.requestId, behavior);
        },
      });
      cleanups.push(() => stopPolling());

      const channelServerEntry = path.resolve(import.meta.dirname, "../../channel-server/src/index.ts");
      const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", channelServerEntry],
        env: spawnEnv({ AIBRIDGE_SLUG: slug, AIBRIDGE_PIPE_PATH: pipePath }),
        stderr: "pipe",
      });

      const client = new Client({ name: "test-claude-stand-in", version: "0.0.1" }, { capabilities: {} });
      const verdicts: Array<{ request_id: string; behavior: string }> = [];
      client.fallbackNotificationHandler = async (notification: Notification) => {
        if (notification.method === "notifications/claude/channel/permission") {
          verdicts.push(notification.params as { request_id: string; behavior: string });
        }
      };
      await client.connect(transport);
      cleanups.push(() => client.close());

      await client.notification({
        method: "notifications/claude/channel/permission_request",
        params: {
          request_id: "zzyxw",
          tool_name: "Bash",
          description: "Push to origin",
          input_preview: '{"command":"git push origin main"}',
        },
      });

      await waitFor(() => stub.getSent(controlToken).length >= 1);
      stub.pushCallbackQuery(controlToken, { chatId: Number(chatId), data: "perm:zzyxw:d", messageThreadId: topicId });

      await waitFor(() => verdicts.length >= 1);
      expect(verdicts[0]).toEqual({ request_id: "zzyxw", behavior: "deny" });
    },
    20000,
  );
});
