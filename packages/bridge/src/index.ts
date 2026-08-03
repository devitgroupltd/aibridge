import http from "node:http";
import path from "node:path";
import type * as pty from "node-pty";
import type { ChannelMetaFields, HookEventMessage } from "@aibridge/protocol";
import { renderChannelTag } from "@aibridge/protocol";
import { resolveAskCallback, renderAskAnsweredCard, renderAskCancelledCard } from "./ask-callback.ts";
import { buildCmdShimText, buildCommandKeyboard, isBuiltinPassthroughCommand, listRepoCommands, resolveCommandAction } from "./commands.ts";
import { loadConfig, STATE_DIR } from "./config.ts";
import { FeedCoalescer } from "./feed-coalescer.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import { parseFleetCommand, renderAttach, renderLsTable } from "./fleet-commands.ts";
import { renderCard } from "./feed-renderer.ts";
import { applyEvent, createFeedState, promptsInLastHour } from "./feed-state.ts";
import { normalizeHookEvent } from "./hook-events.ts";
import { resolvePermCallback } from "./permission-callback.ts";
import { loadReposRegistry, type ReposRegistry } from "./repos-registry.ts";
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
import { stateForHookEvent } from "./session-state-transitions.ts";
import { isValidTransition, SessionStore, type SessionState } from "./session-store.ts";
import { slugFromPrompt, uniqueSlug } from "./slug.ts";
import { addAlwaysRule, readSettingsFile, writeSettingsFile } from "./settings.ts";
import { startPolling, TelegramClient, validateTokens } from "./telegram.ts";
import { createThinkingPlaceholder } from "./thinking-placeholder.ts";
import { createTypingIndicator } from "./typing-indicator.ts";
import { removeWorktree } from "./worktree.ts";

type LogLevel = "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string): void {
  // §9's convention: ERROR/WARN/INFO, never a token or full tool input in the line.
  console.log(`[${new Date().toISOString()}] ${level} ${message}`);
}

/** §4.1: topic 1 (the implicit "General" topic) is the control topic - real Telegram omits
 * `message_thread_id` entirely for a General-topic message, so both `undefined` and the literal
 * `1` (the stub server's convention) count. */
function isControlTopic(threadId: number | undefined): boolean {
  return threadId === undefined || threadId === 1;
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
  // is what makes the Phase 1 test session's worktree show up as its own Source Control provider
  // for free. Fleet sessions created via /new use the plain §7.5 convention instead
  // (`c:\data\worktrees\<slug>`, `launchSession`'s own default) since they aren't all nested under
  // one repo any more.
  const phase1WorktreesRoot = process.env.PHASE1_WORKTREES_ROOT ?? path.join(config.phase1.repoPath, ".worktrees");
  const phase1WorktreePath = path.join(phase1WorktreesRoot, config.phase1.slug);
  const fleetWorktreesRoot = process.env.AIBRIDGE_WORKTREES_ROOT;

  const routing = new Routing();
  routing.add({ slug: config.phase1.slug, topicId: config.phase1.topicId, worktreePath: phase1WorktreePath });

  const nowIso = () => new Date().toISOString();

  const sessionStore = new SessionStore(process.env.AIBRIDGE_DB_PATH ?? path.join(STATE_DIR, "aibridge.db"));
  if (!sessionStore.get(config.phase1.slug)) {
    sessionStore.insert({
      slug: config.phase1.slug,
      topicId: config.phase1.topicId,
      sessionId: null,
      worktreePath: phase1WorktreePath,
      branch: `claude/${config.phase1.slug}-1`,
      repoPath: config.phase1.repoPath,
      model: "sonnet",
      ptyPid: 0,
      state: "starting",
      turnCardMsg: null,
      paused: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });
  }

  // §7.5: an unregistered/missing repos.toml disables /new rather than crashing the whole Bridge -
  // every other session (including the Phase 1 hardcoded one) works fine without it.
  let reposRegistry: ReposRegistry | undefined;
  try {
    reposRegistry = loadReposRegistry(process.env.AIBRIDGE_REPOS_TOML ?? path.join(STATE_DIR, "repos.toml"));
  } catch (err) {
    log("WARN", (err as Error).message);
  }

  const ptyProcessBySlug = new Map<string, pty.IPty>();

  function maybeSetState(slug: string, target: SessionState): void {
    const row = sessionStore.get(slug);
    if (row && row.state !== target && isValidTransition(row.state, target)) {
      sessionStore.setState(slug, target, nowIso());
    }
  }

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
  // control bot are deliberately left as direct calls for this pass - see Phase 3's own note.
  const feedStates = new Map<string, ReturnType<typeof createFeedState>>();
  const feedMessageIds = new Map<string, number>();
  const feedGovernor = new RateGovernor({ log });
  const feedCoalescer = new FeedCoalescer({
    activeSessionCount: () => routing.all().length,
    onFlush: (slug, text) => {
      feedGovernor.schedule("P2", async () => {
        // §4.2's /pause: replies and prompts still flow, only the feed card stops updating.
        if (sessionStore.get(slug)?.paused) return;
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
    // §4.3's state table, the hook-driven half (the permission/ask half is wired via
    // onAwaitingInput/maybeSetState below) - a stale/duplicate event is a silent no-op, not an error.
    const targetState = stateForHookEvent(msg.hook_event_name);
    if (targetState) maybeSetState(msg.slug, targetState);

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
    onAwaitingInput: (slug) => maybeSetState(slug, "awaiting_input"),
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

    // §6.4: past the 3540s ceiling, cancel rather than let the hook's own 3600s timeout expire
    // silently - the operator sees an explicit "cancelled" card and Claude sees a `deny` it can
    // recover from, never a wrong answer auto-picked on its behalf.
    for (const entry of pipeHandle.askRegistry.expired()) {
      pipeHandle.cancelAsk(entry.id);
      for (const q of entry.questions) {
        if (q.answerLabel !== undefined) continue;
        pipeHandle
          .finalizePermissionMessage(q.messageId, renderAskCancelledCard(entry.slug, q.question, q.header))
          .catch((err) => log("WARN", `failed to mark question as cancelled: ${(err as Error).message}`));
      }
    }
  }, 60_000);

  if (process.env.AIBRIDGE_SKIP_LAUNCH !== "1") {
    const channelServerEntryPath = path.resolve(import.meta.dirname, "../../channel-server/src/index.ts");
    const session = launchSession({
      slug: config.phase1.slug,
      topicId: config.phase1.topicId,
      repoPath: config.phase1.repoPath,
      channelServerEntryPath,
      worktreesRoot: phase1WorktreesRoot,
      mirrorPtyToConsole: process.env.AIBRIDGE_DEV_MIRROR_PTY === "1",
      log,
    });

    routing.setPtyWrite(config.phase1.slug, (text) => session.ptyProcess.write(text));
    session.ptyProcess.onData((data) => routing.appendOutput(config.phase1.slug, data));
    ptyProcessBySlug.set(config.phase1.slug, session.ptyProcess);

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
            try {
              session.ptyProcess.write(body);
              res.end("ok\n");
            } catch (err) {
              // node-pty's write() can throw synchronously once the underlying ConPTY socket has
              // closed (e.g. the session process already exited) - a dev-only debug affordance
              // crashing the whole Bridge process over a stale write is worse than the write itself.
              log("WARN", `dev control write failed - session likely exited: ${(err as Error).message}`);
              res.statusCode = 500;
              res.end("session gone\n");
            }
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
  function sendRaw(slug: string, text: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - command dropped`);
      return;
    }
    write(text);
    write("\r");
  }

  // /effort, unlike /model, opens a "Change effort level? 1. Yes, switch  2. No, go back"
  // confirmation dialog with "Yes" pre-selected - live-verified 2026-08-03. A second Enter selects
  // it, but sending both \r's in the same tick arrives before the dialog has rendered and is
  // dropped, leaving the dialog open and the level unchanged (also confirmed live) - same class of
  // PTY-timing hazard as the known single-write text+\r issue, one layer removed. A short delay
  // before the confirming \r fixes it.
  function sendEffortCommand(slug: string, effort: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - command dropped`);
      return;
    }
    write(`/effort ${effort}`);
    write("\r");
    setTimeout(() => write("\r"), 200);
  }

  // A normal inbound turn: wrapped in the <channel> tag Claude Code would have rendered itself,
  // for text Claude should read and act on rather than a literal TUI keystroke.
  function sendChannelText(slug: string, topicId: number, content: string, msgId: string, from: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - inbound message dropped`);
      return;
    }
    seq += 1;
    const meta: ChannelMetaFields = { topic_id: String(topicId), msg_id: msgId, from, seq };
    write(renderChannelTag(content, meta));
    write("\r");
    typingIndicator.start(meta.topic_id);
    thinkingPlaceholder.start(meta.topic_id);
  }

  function confirmSessionCommand(topicId: number | undefined, text: string, parseMode?: "HTML"): void {
    controlBot
      .sendMessage(config.supergroupChatId, topicId, text, undefined, parseMode)
      .catch((err: unknown) => log("WARN", `failed to send command confirmation: ${(err as Error).message}`));
  }

  // Shared by the typed `/model foo` / `/mode bar` / `/effort baz` path and the button-tap path
  // (bare /model, /mode or /effort followed by a keyboard selection) - same switch, two triggers.
  function applyModelSwitch(slug: string, topicId: number, model: string): void {
    sendRaw(slug, `/model ${model}`);
    sessionStore.setModel(slug, model);
    confirmSessionCommand(topicId, `Switched ${slug} to ${model}`);
  }

  function applyModeSwitch(slug: string, topicId: number, mode: Mode): void {
    const current = routing.getMode(slug);
    const keystrokes = buildModeKeystrokes(current, mode);
    // Already at the target mode: no keystroke to send, and sendRaw("") would still submit a
    // spurious blank Enter at the prompt.
    if (keystrokes.length > 0) {
      routing.getPtyWrite(slug)?.(keystrokes);
    }
    routing.setMode(slug, mode);
    confirmSessionCommand(topicId, `Switched ${slug} to ${mode} mode`);
  }

  function applyEffortSwitch(slug: string, topicId: number, effort: string): void {
    sendEffortCommand(slug, effort);
    confirmSessionCommand(topicId, `Switched ${slug} to ${effort} effort`);
  }

  // ---- §4.2's fleet commands (Phase 5) ----

  async function handleNewCommand(cmd: Extract<FleetCommand, { kind: "new" }>, controlTopicId: number | undefined): Promise<void> {
    if (!reposRegistry) {
      confirmSessionCommand(controlTopicId, "No repos.toml registered yet - see §7.5.");
      return;
    }
    const repo = reposRegistry.get(cmd.repo);
    if (!repo) {
      confirmSessionCommand(controlTopicId, `Unknown repo "${cmd.repo}". Registered: ${reposRegistry.names().join(", ") || "(none)"}`);
      return;
    }
    const model = cmd.model ?? repo.model ?? "sonnet";

    const base = slugFromPrompt(cmd.prompt);
    const slug = uniqueSlug(base, sessionStore.slugs());

    let topic: { message_thread_id: number };
    try {
      topic = await controlBot.createForumTopic(config.supergroupChatId, cmd.prompt.slice(0, 128));
    } catch (err) {
      confirmSessionCommand(controlTopicId, `Failed to create a topic for "${slug}": ${(err as Error).message}`);
      return;
    }

    const channelServerEntryPath = path.resolve(import.meta.dirname, "../../channel-server/src/index.ts");
    let session: ReturnType<typeof launchSession>;
    try {
      session = launchSession({
        slug,
        topicId: topic.message_thread_id,
        repoPath: repo.path,
        channelServerEntryPath,
        worktreesRoot: fleetWorktreesRoot,
        model,
        log,
      });
    } catch (err) {
      confirmSessionCommand(controlTopicId, `Failed to launch session "${slug}": ${(err as Error).message}`);
      return;
    }

    routing.add({ slug, topicId: topic.message_thread_id, worktreePath: session.worktreePath });
    routing.setPtyWrite(slug, (text) => session.ptyProcess.write(text));
    session.ptyProcess.onData((data) => routing.appendOutput(slug, data));
    ptyProcessBySlug.set(slug, session.ptyProcess);

    sessionStore.insert({
      slug,
      topicId: topic.message_thread_id,
      sessionId: null,
      worktreePath: session.worktreePath,
      branch: session.branch,
      repoPath: repo.path,
      model,
      ptyPid: session.ptyProcess.pid ?? 0,
      state: "starting",
      turnCardMsg: null,
      paused: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });

    sendChannelText(slug, topic.message_thread_id, cmd.prompt, "new-1", "telegram");
    confirmSessionCommand(controlTopicId, `Created "${slug}" (${model}) in a new topic.`);
  }

  function handleLsCommand(topicId: number | undefined): void {
    controlBot
      .sendMessage(config.supergroupChatId, topicId, renderLsTable(sessionStore.all(), Date.now()), undefined, "HTML")
      .catch((err) => log("WARN", `sendMessage (/ls) failed: ${(err as Error).message}`));
  }

  /** §4.2's `/kill`/`/rm`: no `reply` will ever land for this topic again, so the two "Claude is
   * working" signals (§5) need an explicit stop rather than their normal reply-triggered one - left
   * running, the typing indicator nags Telegram for up to its 30-minute backstop and the "🤔
   * Thinking..." placeholder sits there forever, both outliving the session they described. */
  function stopIndicatorsForTopic(topicId: number): void {
    const topicIdStr = String(topicId);
    typingIndicator.stop(topicIdStr);
    thinkingPlaceholder.consume(topicIdStr).then((messageId) => {
      if (messageId === undefined || !controlBot.editMessageText) return;
      return controlBot.editMessageText(config.supergroupChatId, messageId, "Session ended.");
    }).catch((err: unknown) => log("WARN", `failed to clear thinking placeholder for topic ${topicId}: ${(err as Error).message}`));
  }

  /** Fleet-lifecycle commands take an optional `<slug>`, falling back to "the session this
   * message's own topic belongs to" (§4.2: "`/kill` with no argument inside a session topic kills
   * that session"). Returns an error string for an unresolvable target rather than throwing. */
  function resolveTargetSlug(explicit: string | undefined, currentSlug: string | undefined): { slug: string } | { error: string } {
    const slug = explicit ?? currentSlug;
    if (!slug) return { error: "usage: <command> <slug> (or send it bare from inside that session's own topic)" };
    if (!sessionStore.get(slug)) return { error: `unknown slug "${slug}"` };
    return { slug };
  }

  async function handleKillCommand(cmd: Extract<FleetCommand, { kind: "kill" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;

    ptyProcessBySlug.get(slug)?.kill();
    ptyProcessBySlug.delete(slug);
    routing.clearPtyWrite(slug);
    if (row.state !== "dead") sessionStore.setState(slug, "dead", nowIso());
    stopIndicatorsForTopic(row.topicId);

    try {
      await controlBot.closeForumTopic(config.supergroupChatId, row.topicId);
    } catch (err) {
      log("WARN", `closeForumTopic failed for "${slug}": ${(err as Error).message}`);
    }
    confirmSessionCommand(topicId, `Killed "${slug}". Worktree left in place - \`/rm ${slug}\` to remove it.`);
  }

  async function handleRmCommand(cmd: Extract<FleetCommand, { kind: "rm" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;

    if (row.state !== "dead") {
      ptyProcessBySlug.get(slug)?.kill();
    }
    ptyProcessBySlug.delete(slug);
    routing.clearPtyWrite(slug);
    stopIndicatorsForTopic(row.topicId);

    try {
      removeWorktree(row.repoPath, row.worktreePath);
    } catch (err) {
      log("WARN", `removeWorktree failed for "${slug}": ${(err as Error).message}`);
    }
    try {
      await controlBot.deleteForumTopic(config.supergroupChatId, row.topicId);
    } catch (err) {
      log("WARN", `deleteForumTopic failed for "${slug}": ${(err as Error).message}`);
    }

    sessionStore.remove(slug);
    routing.remove(slug);
    feedStates.delete(slug);
    feedMessageIds.delete(slug);
    confirmSessionCommand(topicId, `Removed "${slug}" - worktree and topic deleted.`);
  }

  function handleAttachCommand(cmd: Extract<FleetCommand, { kind: "attach" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
    const tail = routing.getOutputTail(slug) || "(no output captured yet)";
    confirmSessionCommand(topicId, renderAttach(row, tail), "HTML");
  }

  function handlePauseCommand(cmd: Extract<FleetCommand, { kind: "pause" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
    const next = !row.paused;
    sessionStore.setPaused(slug, next);
    confirmSessionCommand(topicId, `${next ? "Paused" : "Resumed"} feed updates for "${slug}".`);
  }

  startPolling(controlBot, {
    onUpdate: (update) => {
      const callbackQuery = update.callback_query;
      if (callbackQuery) {
        controlBot
          .answerCallbackQuery(callbackQuery.id)
          .catch((err) => log("WARN", `answerCallbackQuery failed: ${(err as Error).message}`));

        const threadId = callbackQuery.message?.message_thread_id;
        const currentRoute = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
        const currentSlug = currentRoute?.slug;

        // §6.4's per-question keyboard - checked first since "ask:" never collides with the
        // other namespaces ("perm:", "run:", etc.).
        const askAction = callbackQuery.data ? resolveAskCallback(callbackQuery.data) : null;
        if (askAction) {
          const result = pipeHandle.answerAsk(askAction.id, askAction.questionIndex, askAction.optionIndex);
          if (!result) return; // unknown id, bad index, or already answered - a stale/duplicate tap
          const q = result.entry.questions[askAction.questionIndex];
          if (q) {
            pipeHandle
              .finalizePermissionMessage(q.messageId, renderAskAnsweredCard(result.entry.slug, q.question, q.header, result.label))
              .catch((err) => log("WARN", `failed to finalize question message: ${(err as Error).message}`));
          }
          if (result.allAnswered) {
            pipeHandle.completeAsk(askAction.id);
            maybeSetState(result.entry.slug, "working");
          }
          return;
        }

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
          maybeSetState(pending.slug, "working");

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
          if (currentSlug && threadId !== undefined) applyModelSwitch(currentSlug, threadId, model);
          return;
        }

        const mode = callbackQuery.data ? resolveModeCallback(callbackQuery.data) : null;
        if (mode) {
          if (currentSlug && threadId !== undefined) applyModeSwitch(currentSlug, threadId, mode);
          return;
        }

        const effort = callbackQuery.data ? resolveEffortCallback(callbackQuery.data) : null;
        if (effort) {
          if (currentSlug && threadId !== undefined) applyEffortSwitch(currentSlug, threadId, effort);
          return;
        }

        const action = callbackQuery.data ? resolveCommandAction(callbackQuery.data, currentRoute ? listRepoCommands(currentRoute.worktreePath) : []) : null;
        if (!action || !currentSlug || threadId === undefined) return;
        if (action.kind === "builtin") {
          sendRaw(currentSlug, `/${action.name}`);
        } else {
          sendChannelText(currentSlug, threadId, buildCmdShimText(action.name, ""), `cb-${callbackQuery.id}`, "telegram-button");
        }
        return;
      }

      const message = update.message;
      if (!message?.text) return;
      if (String(message.chat.id) !== config.supergroupChatId) return;

      const threadId = message.message_thread_id;
      const isControl = isControlTopic(threadId);
      const route = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
      const currentSlug = route?.slug;
      // Neither the control topic nor a topic this Bridge recognises as a session - ignore.
      if (!isControl && !route) return;

      const text = message.text.trim();
      const from = message.from?.username ?? message.from?.first_name ?? "unknown";

      const fleetCmd = parseFleetCommand(text);
      if (fleetCmd) {
        if (fleetCmd.kind === "new") {
          if (!isControl) {
            confirmSessionCommand(threadId, "/new only works from the control topic.");
            return;
          }
          void handleNewCommand(fleetCmd, threadId);
          return;
        }
        if (fleetCmd.kind === "ls") {
          handleLsCommand(threadId);
          return;
        }
        if (fleetCmd.kind === "kill") {
          void handleKillCommand(fleetCmd, threadId, currentSlug);
          return;
        }
        if (fleetCmd.kind === "rm") {
          void handleRmCommand(fleetCmd, threadId, currentSlug);
          return;
        }
        if (fleetCmd.kind === "attach") {
          handleAttachCommand(fleetCmd, threadId, currentSlug);
          return;
        }
        handlePauseCommand(fleetCmd, threadId, currentSlug);
        return;
      }

      if (text === "/help" || text === "/commands") {
        const repoCommands = route ? listRepoCommands(route.worktreePath) : [];
        controlBot
          .sendMessage(config.supergroupChatId, threadId, "Available commands:", {
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
          .sendMessage(config.supergroupChatId, threadId, bareCommand.prompt, {
            inline_keyboard: bareCommand.keyboard(),
          })
          .catch((err) => log("WARN", `sendMessage (${text} list) failed: ${(err as Error).message}`));
        return;
      }

      // §4.2.1/§4.2.2: neither /model nor /mode fires a hook or a reply call, so the Bridge
      // confirms them itself rather than waiting for an ack that will never arrive. Both are
      // session-scoped only (§4.2.2) - sent from the control topic they're rejected outright.
      const attempt = parseSessionCommand(text);
      if (attempt) {
        if (!currentSlug || threadId === undefined) {
          confirmSessionCommand(threadId, "/model, /mode and /effort are session-scoped - send them inside that session's own topic.");
          return;
        }
        if (attempt.kind === "model") {
          applyModelSwitch(currentSlug, threadId, attempt.model);
        } else if (attempt.kind === "effort") {
          applyEffortSwitch(currentSlug, threadId, attempt.effort);
        } else {
          applyModeSwitch(currentSlug, threadId, attempt.mode);
        }
        return;
      }
      if (isSessionCommandAttempt(text)) {
        confirmSessionCommand(
          threadId,
          `Unrecognised /model, /mode or /effort argument. Models: ${MODELS.join(", ")}. Modes: ${MODES.join(", ")}. Effort: ${EFFORTS.join(", ")}.`,
        );
        return;
      }

      const builtinName = text.startsWith("/") ? text.slice(1) : "";
      if (isBuiltinPassthroughCommand(builtinName)) {
        if (currentSlug) sendRaw(currentSlug, text);
        return;
      }

      if (!currentSlug || threadId === undefined) {
        if (isControl) confirmSessionCommand(threadId, "Unrecognised control-topic command. Try /new, /ls or /help.");
        return;
      }

      // §4.3: a message to a topic whose row is `dead` is acknowledged, not queued or silently
      // dropped - the one case the state table doesn't cover on its own.
      if (sessionStore.get(currentSlug)?.state === "dead") {
        confirmSessionCommand(threadId, "This session has ended.");
        return;
      }

      // §10.1.2: notifications/claude/channel is confirmed broken upstream (getClientCapabilities()
      // never negotiates the capability), so inbound delivery writes the same <channel> tag
      // Claude Code would have rendered itself directly to the session's PTY, exactly as an
      // operator typing it and pressing Enter would.
      sendChannelText(currentSlug, threadId, message.text, String(message.message_id), from);
    },
    onError: (err) => {
      log("WARN", `getUpdates failed, retrying: ${(err as Error).message}`);
    },
  });

  log("INFO", "Bridge started - getUpdates loop running");
}

await main();
