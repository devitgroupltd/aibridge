import http from "node:http";
import path from "node:path";
import type { ChannelMetaFields } from "@aibridge/protocol";
import { renderChannelTag } from "@aibridge/protocol";
import { loadConfig } from "./config.ts";
import { buildCmdShimText, buildCommandKeyboard, isBuiltinPassthroughCommand, listRepoCommands, resolveCommandAction } from "./commands.ts";
import { STATE_DIR } from "./config.ts";
import { resolvePermCallback } from "./permission-callback.ts";
import { launchSession } from "./session-launcher.ts";
import { startPipeServer } from "./pipe-server.ts";
import { deriveAlwaysRule, ruleAlreadyCovered } from "./rule-derivation.ts";
import { Routing } from "./routing.ts";
import { buildModeKeystrokes, isSessionCommandAttempt, MODELS, MODES, parseSessionCommand } from "./session-commands.ts";
import { addAlwaysRule, readSettingsFile, writeSettingsFile } from "./settings.ts";
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

  // Nested under the repo itself (like SeoWrite's .worktrees/<topic> convention) rather than a
  // sibling path - VS Code's Git extension only scans for repos INSIDE the opened folder, so this
  // is what makes each session worktree show up as its own Source Control provider for free.
  const worktreesRoot = process.env.PHASE1_WORKTREES_ROOT ?? path.join(config.phase1.repoPath, ".worktrees");
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
  const pipeHandle = startPipeServer({
    routing,
    controlBot,
    chatId: config.supergroupChatId,
    thinkingPlaceholder,
    onReplySent: (topicId) => typingIndicator.stop(topicId),
    log,
  });

  // §6.5: strip the keyboard and mark "expired" on any pending permission request past its TTL -
  // a stale button left live would look tappable but silently do nothing.
  setInterval(() => {
    for (const entry of pipeHandle.permissionRegistry.expired()) {
      pipeHandle.permissionRegistry.remove(entry.requestId);
      pipeHandle
        .finalizePermissionMessage(entry.messageId, `⌛ expired: ${entry.toolName} (no answer in time)`)
        .catch((err) => log("WARN", `failed to mark permission request as expired: ${(err as Error).message}`));
    }
  }, 60_000);

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

  // Raw keystroke passthrough: /model, /mode, /compact and /clear are all CLI-native, with no
  // backing markdown file for the /cmd shim (§4.2) to reach - they're written straight to the PTY,
  // bypassing the <channel> tag entirely, exactly as an operator typing them at the desk would.
  // Same two-write submit pattern as the tag path (see sendChannelText): confirmed live that a
  // single write carrying text plus a trailing \r leaves it sitting unsubmitted.
  function sendRaw(text: string): void {
    const write = routing.getPtyWrite(config.phase1.slug);
    if (!write) {
      log("WARN", `no live session for slug "${config.phase1.slug}" - command dropped`);
      return;
    }
    write(text);
    write("\r");
  }

  // A normal inbound turn: wrapped in the <channel> tag Claude Code would have rendered itself,
  // for text Claude should read and act on rather than a literal TUI keystroke.
  function sendChannelText(content: string, msgId: string, from: string): void {
    const write = routing.getPtyWrite(config.phase1.slug);
    if (!write) {
      log("WARN", `no live session for slug "${config.phase1.slug}" - inbound message dropped`);
      return;
    }
    seq += 1;
    const meta: ChannelMetaFields = { topic_id: String(config.phase1.topicId), msg_id: msgId, from, seq };
    write(renderChannelTag(content, meta));
    write("\r");
    typingIndicator.start(meta.topic_id);
    thinkingPlaceholder.start(meta.topic_id);
  }

  function confirmSessionCommand(text: string): void {
    controlBot
      .sendMessage(config.supergroupChatId, config.phase1.topicId, text)
      .catch((err: unknown) => log("WARN", `failed to send command confirmation: ${(err as Error).message}`));
  }

  startPolling(controlBot, {
    onUpdate: (update) => {
      const callbackQuery = update.callback_query;
      if (callbackQuery) {
        controlBot
          .answerCallbackQuery(callbackQuery.id)
          .catch((err) => log("WARN", `answerCallbackQuery failed: ${(err as Error).message}`));
        if (callbackQuery.message?.message_thread_id !== config.phase1.topicId) return;

        // §6.3's approve/deny/always keyboard - checked before the /help-style command keyboard
        // since the two callback_data namespaces ("perm:" vs "run:") never collide.
        const permAction = callbackQuery.data ? resolvePermCallback(callbackQuery.data) : null;
        if (permAction) {
          // Resolve pops the entry - a stale/expired/unknown id is a silent no-op (§9 scenarios 6-7),
          // not an error, since a race against the 30-minute sweep or a duplicate tap is expected.
          const pending = pipeHandle.resolvePermission(permAction.requestId);
          if (!pending) return;

          const behavior = permAction.action === "deny" ? "deny" : "allow";
          pipeHandle.sendVerdict(pending.slug, pending.requestId, behavior);

          let confirmText = `${behavior === "allow" ? "✅ Allowed" : "⛔ Denied"}: ${pending.toolName}`;
          if (permAction.action === "always") {
            const rule = deriveAlwaysRule(pending.toolName, pending.inputPreview);
            const settings = readSettingsFile(STATE_DIR, pending.slug);
            if (!rule) {
              confirmText += " (allow-once only - command isn't safe to generalise)";
            } else if (ruleAlreadyCovered(rule, settings)) {
              confirmText += ` (\`${rule}\` already covered by an existing rule)`;
            } else {
              writeSettingsFile(STATE_DIR, pending.slug, addAlwaysRule(settings, rule));
              confirmText += `, and added \`${rule}\` for this session`;
            }
          }
          pipeHandle
            .finalizePermissionMessage(pending.messageId, confirmText)
            .catch((err) => log("WARN", `failed to finalize permission message: ${(err as Error).message}`));
          return;
        }

        const action = callbackQuery.data ? resolveCommandAction(callbackQuery.data, listRepoCommands(worktreePath)) : null;
        if (!action) return;
        if (action.kind === "builtin") {
          sendRaw(`/${action.name}`);
        } else {
          sendChannelText(buildCmdShimText(action.name, ""), `cb-${callbackQuery.id}`, "telegram-button");
        }
        return;
      }

      const message = update.message;
      if (!message?.text) return;
      if (String(message.chat.id) !== config.supergroupChatId) return;
      if (message.message_thread_id !== config.phase1.topicId) return;

      const text = message.text.trim();
      const from = message.from?.username ?? message.from?.first_name ?? "unknown";

      if (text === "/help" || text === "/commands") {
        const repoCommands = listRepoCommands(worktreePath);
        controlBot
          .sendMessage(config.supergroupChatId, message.message_thread_id, "Available commands:", {
            inline_keyboard: buildCommandKeyboard(repoCommands),
          })
          .catch((err) => log("WARN", `sendMessage (command list) failed: ${(err as Error).message}`));
        return;
      }

      // §4.2.1/§4.2.2: neither /model nor /mode fires a hook or a reply call, so the Bridge
      // confirms them itself rather than waiting for an ack that will never arrive.
      const attempt = parseSessionCommand(text);
      if (attempt) {
        if (attempt.kind === "model") {
          sendRaw(`/model ${attempt.model}`);
          confirmSessionCommand(`Switched ${config.phase1.slug} to ${attempt.model}`);
        } else {
          const current = routing.getMode(config.phase1.slug);
          const keystrokes = buildModeKeystrokes(current, attempt.mode);
          // Already at the target mode: no keystroke to send, and sendRaw("") would still submit
          // a spurious blank Enter at the prompt.
          if (keystrokes.length > 0) {
            const write = routing.getPtyWrite(config.phase1.slug);
            write?.(keystrokes);
          }
          routing.setMode(config.phase1.slug, attempt.mode);
          confirmSessionCommand(`Switched ${config.phase1.slug} to ${attempt.mode} mode`);
        }
        return;
      }
      if (isSessionCommandAttempt(text)) {
        confirmSessionCommand(`Unrecognised /model or /mode argument. Models: ${MODELS.join(", ")}. Modes: ${MODES.join(", ")}.`);
        return;
      }

      const builtinName = text.startsWith("/") ? text.slice(1) : "";
      if (isBuiltinPassthroughCommand(builtinName)) {
        sendRaw(text);
        return;
      }

      // §10.1.2: notifications/claude/channel is confirmed broken upstream (getClientCapabilities()
      // never negotiates the capability), so inbound delivery writes the same <channel> tag
      // Claude Code would have rendered itself directly to the session's PTY, exactly as an
      // operator typing it and pressing Enter would.
      sendChannelText(message.text, String(message.message_id), from);
    },
    onError: (err) => {
      log("WARN", `getUpdates failed, retrying: ${(err as Error).message}`);
    },
  });

  log("INFO", "Bridge started - getUpdates loop running");
}

await main();
