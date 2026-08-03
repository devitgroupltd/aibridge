import http from "node:http";
import path from "node:path";
import type { ChannelMetaFields } from "@aibridge/protocol";
import { renderChannelTag } from "@aibridge/protocol";
import { loadConfig } from "./config.ts";
import { launchSession } from "./session-launcher.ts";
import { startPipeServer } from "./pipe-server.ts";
import { Routing } from "./routing.ts";
import { startPolling, TelegramClient, validateTokens } from "./telegram.ts";
import { createThinkingPlaceholder } from "./thinking-placeholder.ts";
import { createTypingIndicator } from "./typing-indicator.ts";

type LogLevel = "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string): void {
  // §9's convention: ERROR/WARN/INFO, never a token or full tool input in the line.
  console.log(`[${new Date().toISOString()}] ${level} ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const baseUrl = process.env.AIBRIDGE_TELEGRAM_BASE_URL; // integration tests point this at the stub

  const controlBot = new TelegramClient(config.controlBotToken, baseUrl);
  const feedBot = new TelegramClient(config.feedBotToken, baseUrl);

  await validateTokens(controlBot, feedBot);
  log("INFO", "both bot tokens validated via getMe");

  const worktreesRoot = process.env.PHASE1_WORKTREES_ROOT ?? "C:\\data\\worktrees";
  const worktreePath = path.join(worktreesRoot, config.phase1.slug);

  const routing = new Routing();
  routing.add({ slug: config.phase1.slug, topicId: config.phase1.topicId, worktreePath });

  // Two independent, cheap "Claude is working on this" signals, kept side by side rather than
  // choosing one: `sendChatAction` renders correctly on mobile clients but Telegram Desktop has a
  // known bug (tdesktop#30452) that only shows it in the topics overview, not inside the open
  // topic - so the message-based placeholder covers desktop, and the reply landing is what stops
  // (or, for the placeholder, edits away) both of them.
  const typingIndicator = createTypingIndicator({
    send: (topicId) => controlBot.sendChatAction(config.supergroupChatId, Number(topicId), "typing"),
    log: (level, message) => log(level, message),
  });
  const thinkingPlaceholder = createThinkingPlaceholder({
    send: async (topicId) => {
      const sent = await controlBot.sendMessage(config.supergroupChatId, Number(topicId), "🤔 Thinking...");
      return sent.message_id;
    },
    log: (level, message) => log(level, message),
  });

  // §10.1.2: inbound delivery no longer goes through the channel server (see the onUpdate
  // handler below), but the pipe server still owns outbound reply relay and stays the
  // transport for Phase 2+ (permission_request/verdict), so it's still started unconditionally.
  startPipeServer({
    routing,
    controlBot,
    chatId: config.supergroupChatId,
    thinkingPlaceholder,
    onReplySent: (topicId) => typingIndicator.stop(topicId),
    log,
  });

  if (process.env.AIBRIDGE_SKIP_LAUNCH !== "1") {
    const channelServerEntryPath = path.resolve(import.meta.dirname, "../../channel-server/src/index.ts");
    const session = launchSession({
      slug: config.phase1.slug,
      topicId: config.phase1.topicId,
      repoPath: config.phase1.repoPath,
      channelServerEntryPath,
      worktreesRoot,
      mirrorPtyToConsole: process.env.AIBRIDGE_DEV_MIRROR_PTY === "1",
      log,
    });

    routing.setPtyWrite(config.phase1.slug, (text) => session.ptyProcess.write(text));

    // Stage 7 manual-verification-only affordance: this process's own stdin isn't a real TTY
    // when the Bridge itself is launched non-interactively, so mirrorPtyToConsole's stdin pipe
    // has nothing to relay. This lets the operator send the one-time dev-channels confirmation
    // keystroke over loopback HTTP instead. Removed once the Phase 5 supervisor automates it (§10.1).
    const devControlPort = process.env.AIBRIDGE_DEV_CONTROL_PORT;
    if (devControlPort) {
      const controlServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/write" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            session.ptyProcess.write(body);
            res.end("ok\n");
          });
          return;
        }
        res.statusCode = 404;
        res.end("not found\n");
      });
      controlServer.listen(Number(devControlPort), "127.0.0.1", () => {
        log("INFO", `dev control server on http://127.0.0.1:${devControlPort}`);
      });
    }
  } else {
    log("INFO", "AIBRIDGE_SKIP_LAUNCH=1 - not spawning a claude session");
  }

  let seq = 0;
  startPolling(controlBot, {
    onUpdate: (update) => {
      const message = update.message;
      if (!message?.text) return;
      if (String(message.chat.id) !== config.supergroupChatId) return;
      if (message.message_thread_id !== config.phase1.topicId) return;

      seq += 1;
      const meta: ChannelMetaFields = {
        topic_id: String(config.phase1.topicId),
        msg_id: String(message.message_id),
        from: message.from?.username ?? message.from?.first_name ?? "unknown",
        seq,
      };

      // §10.1.2: notifications/claude/channel is confirmed broken upstream (getClientCapabilities()
      // never negotiates the capability), so inbound delivery writes the same <channel> tag
      // Claude Code would have rendered itself directly to the session's PTY, exactly as an
      // operator typing it and pressing Enter would.
      const write = routing.getPtyWrite(config.phase1.slug);
      if (!write) {
        log("WARN", `no live session for slug "${config.phase1.slug}" - inbound message dropped`);
        return;
      }
      // Two separate writes, not one: confirmed live that a single write carrying the tag text
      // plus a trailing \r leaves it sitting unsubmitted, plausibly bracketed-paste handling
      // swallowing the embedded Enter (renderChannelTag's own doc comment).
      write(renderChannelTag(message.text, meta));
      write("\r");
      typingIndicator.start(meta.topic_id);
      thinkingPlaceholder.start(meta.topic_id);
    },
    onError: (err) => {
      log("WARN", `getUpdates failed, retrying: ${(err as Error).message}`);
    },
  });

  log("INFO", "Bridge started - getUpdates loop running");
}

await main();
