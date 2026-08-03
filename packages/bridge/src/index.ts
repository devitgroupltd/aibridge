import http from "node:http";
import path from "node:path";
import type { ChannelMetaFields, HookEventMessage } from "@aibridge/protocol";
import { renderChannelTag } from "@aibridge/protocol";
import { loadConfig } from "./config.ts";
import { buildCmdShimText, buildCommandKeyboard, isBuiltinPassthroughCommand, listRepoCommands, resolveCommandAction } from "./commands.ts";
import { STATE_DIR } from "./config.ts";
import { FeedCoalescer } from "./feed-coalescer.ts";
import { renderCard } from "./feed-renderer.ts";
import { applyEvent, createFeedState, promptsInLastHour } from "./feed-state.ts";
import { normalizeHookEvent } from "./hook-events.ts";
import { resolvePermCallback } from "./permission-callback.ts";
import { launchSession } from "./session-launcher.ts";
import { startPipeServer } from "./pipe-server.ts";
import { RateGovernor } from "./rate-governor.ts";
import { deriveAlwaysRule, ruleAlreadyCovered } from "./rule-derivation.ts";
import { Routing } from "./routing.ts";
import {
  buildEffortKeyboard,
  buildModeKeyboard,
  buildModeKeystrokes,
  buildModelKeyboard,
  EFFORTS,
  isSessionCommandAttempt,
  MODELS,
  MODES,
  parseSessionCommand,
  resolveEffortCallback,
  resolveModeCallback,
  resolveModelCallback,
} from "./session-commands.ts";
import type { Mode } from "./session-commands.ts";
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

  // §5.1-§5.4: one turn-card state per session, one shared governor across both the feed bot's
  // droppable P2 lane (§9 scenarios 14-18 are unit-tested against rate-governor.ts/
  // feed-coalescer.ts directly) and a per-session-count-scaled coalescer that skips a render when
  // the text hasn't actually changed. Reply/permission-card/answerCallbackQuery sends on the
  // control bot are deliberately left as direct calls for this pass - Phase 1/2's own call volume
  // is far below the 20/minute ceiling the governor exists to protect, and routing Phase 2's
  // already live-verified permission relay through a queueing/retry layer is a real regression
  // risk this pass isn't taking on for a budget concern that isn't yet observable. Wiring P0/P1
  // through the same governor is a reasonable Phase 3 follow-up, not done here.
  const feedStates = new Map<string, ReturnType<typeof createFeedState>>();
  const feedMessageIds = new Map<string, number>();
  const feedGovernor = new RateGovernor({ log });
  const feedCoalescer = new FeedCoalescer({
    activeSessionCount: () => routing.all().length,
    onFlush: (slug, text) => {
      feedGovernor.schedule("P2", async () => {
        const route = routing.get(slug);
        if (!route) return;
        const existingMessageId = feedMessageIds.get(slug);
        if (existingMessageId !== undefined && feedBot.editMessageText) {
          await feedBot.editMessageText(config.supergroupChatId, existingMessageId, text, undefined, "HTML");
        } else {
          const sent = await feedBot.sendMessage(config.supergroupChatId, route.topicId, text, undefined, "HTML");
          feedMessageIds.set(slug, sent.message_id);
        }
      });
    },
  });

  // §10.4.1: this project's own choice of threshold, not a number the plan specifies - a
  // conservative "worth a look" signal for whether the allowlist has grown too broad on a host
  // with no sandbox, surfaced as a log line now and left for a Phase 5 fleet command to expose.
  const PROMPTS_PER_HOUR_WARN_THRESHOLD = 20;

  function handleHookEvent(msg: HookEventMessage): void {
    const event = normalizeHookEvent(msg.hook_event_name, msg.payload);
    if (!event) return;

    const nowMs = Date.now();
    const previous = feedStates.get(msg.slug) ?? createFeedState(msg.slug);
    const next = applyEvent(previous, event, nowMs);
    feedStates.set(msg.slug, next);

    if (event.kind === "turn_start") {
      const promptCount = promptsInLastHour(next, nowMs);
      if (promptCount > PROMPTS_PER_HOUR_WARN_THRESHOLD) {
        log("WARN", `session "${msg.slug}" started ${promptCount} turns in the last hour - check whether its allowlist has grown too broad (§10.4.1)`);
      }
    }

    feedCoalescer.notify(msg.slug, renderCard(next, nowMs));
  }

  // §10.1.2: inbound delivery no longer goes through the channel server (see the onUpdate
  // handler below), but the pipe server still owns outbound reply relay and stays the
  // transport for Phase 2+ (permission_request/verdict/event), so it's still started
  // unconditionally.
  const pipeHandle = startPipeServer({
    routing,
    controlBot,
    chatId: config.supergroupChatId,
    thinkingPlaceholder,
    onReplySent: (topicId) => typingIndicator.stop(topicId),
    onHookEvent: handleHookEvent,
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

  // /effort, unlike /model, opens a "Change effort level? 1. Yes, switch  2. No, go back"
  // confirmation dialog with "Yes" pre-selected - live-verified 2026-08-03 against the same
  // test-session used for Phase 1/2's own spikes. A second Enter selects it, but sending both \r's
  // in the same tick arrives before the dialog has rendered and is dropped, leaving the dialog open
  // and the level unchanged (also confirmed live) - same class of PTY-timing hazard as the
  // known single-write text+\r issue, one layer removed. A short delay before the confirming \r
  // fixes it.
  function sendEffortCommand(effort: string): void {
    const write = routing.getPtyWrite(config.phase1.slug);
    if (!write) {
      log("WARN", `no live session for slug "${config.phase1.slug}" - command dropped`);
      return;
    }
    write(`/effort ${effort}`);
    write("\r");
    setTimeout(() => write("\r"), 200);
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

  // Shared by the typed `/model foo` / `/mode bar` / `/effort baz` path and the button-tap path
  // (bare /model, /mode or /effort followed by a keyboard selection) - same switch, two triggers.
  function applyModelSwitch(model: string): void {
    sendRaw(`/model ${model}`);
    confirmSessionCommand(`Switched ${config.phase1.slug} to ${model}`);
  }

  function applyModeSwitch(mode: Mode): void {
    const current = routing.getMode(config.phase1.slug);
    const keystrokes = buildModeKeystrokes(current, mode);
    // Already at the target mode: no keystroke to send, and sendRaw("") would still submit a
    // spurious blank Enter at the prompt.
    if (keystrokes.length > 0) {
      const write = routing.getPtyWrite(config.phase1.slug);
      write?.(keystrokes);
    }
    routing.setMode(config.phase1.slug, mode);
    confirmSessionCommand(`Switched ${config.phase1.slug} to ${mode} mode`);
  }

  function applyEffortSwitch(effort: string): void {
    sendEffortCommand(effort);
    confirmSessionCommand(`Switched ${config.phase1.slug} to ${effort} effort`);
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

        const model = callbackQuery.data ? resolveModelCallback(callbackQuery.data) : null;
        if (model) {
          applyModelSwitch(model);
          return;
        }

        const mode = callbackQuery.data ? resolveModeCallback(callbackQuery.data) : null;
        if (mode) {
          applyModeSwitch(mode);
          return;
        }

        const effort = callbackQuery.data ? resolveEffortCallback(callbackQuery.data) : null;
        if (effort) {
          applyEffortSwitch(effort);
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

      // A bare /model, /mode or /effort (no argument to act on) surfaces a button per option
      // instead of falling through to the ordinary inbound-message path, where it would just
      // arrive as plain chat text and get answered conversationally rather than switching
      // anything (confirmed live for /effort).
      const bareCommandKeyboards: Record<string, { prompt: string; keyboard: () => ReturnType<typeof buildEffortKeyboard> }> = {
        "/model": { prompt: "Choose a model:", keyboard: buildModelKeyboard },
        "/mode": { prompt: "Choose a permission mode:", keyboard: buildModeKeyboard },
        "/effort": { prompt: "Choose an effort level:", keyboard: buildEffortKeyboard },
      };
      const bareCommand = bareCommandKeyboards[text];
      if (bareCommand) {
        controlBot
          .sendMessage(config.supergroupChatId, message.message_thread_id, bareCommand.prompt, {
            inline_keyboard: bareCommand.keyboard(),
          })
          .catch((err) => log("WARN", `sendMessage (${text} list) failed: ${(err as Error).message}`));
        return;
      }

      // §4.2.1/§4.2.2: neither /model nor /mode fires a hook or a reply call, so the Bridge
      // confirms them itself rather than waiting for an ack that will never arrive.
      const attempt = parseSessionCommand(text);
      if (attempt) {
        if (attempt.kind === "model") {
          applyModelSwitch(attempt.model);
        } else if (attempt.kind === "effort") {
          applyEffortSwitch(attempt.effort);
        } else {
          applyModeSwitch(attempt.mode);
        }
        return;
      }
      if (isSessionCommandAttempt(text)) {
        confirmSessionCommand(
          `Unrecognised /model, /mode or /effort argument. Models: ${MODELS.join(", ")}. Modes: ${MODES.join(", ")}. Effort: ${EFFORTS.join(", ")}.`,
        );
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
