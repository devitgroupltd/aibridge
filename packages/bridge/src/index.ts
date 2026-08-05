import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import type * as pty from "node-pty";
import type { ChannelMetaFields, HookEventMessage } from "@aibridge/protocol";
import { renderChannelTag } from "@aibridge/protocol";
import { resolveAskCallback, renderAskAnsweredCard, renderAskCancelledCard } from "./ask-callback.ts";
import { ABOUT_TOPICS, buildAboutKeyboard, isAboutCommand, renderAbout, resolveAboutCallback } from "./about.ts";
import { buildCreateArgs, buildDeleteArgs, buildQueryArgs, parseQueryOutput, renderAutostartStatus, TASK_NAME } from "./autostart.ts";
import {
  buildCmdShimText,
  buildCommandKeyboard,
  buildSkillShimText,
  isBuiltinPassthroughCommand,
  listRepoCommands,
  listRepoSkills,
  parseCmdInvocation,
  parseSkillInvocation,
  renderCommandsListText,
  renderSkillsListText,
  resolveCommandAction,
} from "./commands.ts";
import { loadConfig, STATE_DIR } from "./config.ts";
import { buildDetailsKeyboard, parseDetailsCallback } from "./details-button.ts";
import {
  attachmentKindLabel,
  buildAttachmentAnnouncement,
  guessAttachmentFilename,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  writeAttachmentToInbox,
} from "./attachment-inbox.ts";
import type { AttachmentKind } from "./attachment-inbox.ts";
import { buildVoiceModelKeyboard, listAvailableVoiceModels, resolveVoiceModelCallback } from "./voice-model.ts";
import { FeedCoalescer } from "./feed-coalescer.ts";
import { buildFleetConfirmKeyboard, FleetConfirmRegistry, resolveFleetConfirmCallback } from "./fleet-confirm.ts";
import type { PendingFleetConfirm } from "./fleet-confirm.ts";
import { formatStaleAge, isStaleInbound } from "./stale-inbound.ts";
import { buildStaleConfirmKeyboard, resolveStaleConfirmCallback, StaleConfirmRegistry } from "./stale-confirm.ts";
import type { PendingStaleConfirm } from "./stale-confirm.ts";
import { buildVoiceConfirmKeyboard, resolveVoiceConfirmCallback, VoiceConfirmRegistry } from "./voice-confirm.ts";
import type { PendingVoiceConfirm } from "./voice-confirm.ts";
import { startWhisperServer, transcribeVoiceNote } from "./voice-transcribe.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import {
  botCommandList,
  isHelpCommand,
  buildLsDetail,
  parseCommandsQuery,
  parseFleetCommand,
  parseSkillsQuery,
  renderAttach,
  renderBudget,
  renderHelp,
  renderLsTable,
  renderReposList,
  renderSettings,
  stripBotMention,
} from "./fleet-commands.ts";
import { renderCard, renderDetails, renderDetailsPlainText } from "./feed-renderer.ts";
import { applyEvent, createFeedState, promptsInLastHour } from "./feed-state.ts";
import { monotonicNowMs } from "./monotonic-clock.ts";
import { normalizeHookEvent } from "./hook-events.ts";
import { CostTracker, FIVE_HOURS_MS, ONE_WEEK_MS } from "./cost-tracker.ts";
import { checkConcurrencyCap, currentUnits, WEIGHTED_CAP } from "./concurrency-cap.ts";
import { findOrphanProcesses } from "./orphan-scan.ts";
import { startOtlpListener } from "./otlp-listener.ts";
import { resolvePermCallback } from "./permission-callback.ts";
import { sweepExpiredPermissions } from "./permission-registry.ts";
import { listClaudeProcesses } from "./process-scan.ts";
import { reconcile } from "./reconciliation.ts";
import { isTopicDeleted } from "./topic-probe.ts";
import {
  addRepoEntry,
  cloneRepo,
  inferDefaultRepoPath,
  isGitUrl,
  loadReposRegistry,
  removeRepoEntry,
  type ReposRegistry,
} from "./repos-registry.ts";
import { launchSession, resolveBunExecutable, stripAnsi } from "./session-launcher.ts";
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
import { formatUsagePanel } from "./usage-panel.ts";
import { isValidTransition, SessionStore, type SessionRow, type SessionState } from "./session-store.ts";
import { slugFromPrompt, uniqueSlug } from "./slug.ts";
import { addAlwaysRule, readSettingsFile, writeSettingsFile } from "./settings.ts";
import { startPolling, TelegramClient, validateTokens } from "./telegram.ts";
import { loadOffset, saveOffset } from "./telegram-offset.ts";
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

  try {
    await controlBot.setMyCommands(config.supergroupChatId, botCommandList());
    log("INFO", "registered Telegram's native '/' command list via setMyCommands");
  } catch (err) {
    // Best-effort: the manual /help path still works, so a failure here shouldn't block startup.
    log("WARN", `setMyCommands failed - Telegram's native command popup won't reflect the current list: ${err}`);
  }

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
      renamed: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });
  }

  // §5.7/§10.5 (added 2026-08-04): cost tracking is strictly read-only input, same guarantee as the
  // rest of telemetry - a listener failure degrades /ls and /budget and nothing else. Port is
  // overridable for symmetry with the other AIBRIDGE_* dev overrides, though nothing in the test
  // suite currently spawns a full Bridge process that would need it.
  const otlpPort = Number(process.env.AIBRIDGE_OTLP_PORT ?? 4318);
  const costTracker = new CostTracker();

  function slugForSessionId(sessionId: string): string | undefined {
    return sessionStore.getBySessionId(sessionId)?.slug;
  }

  /** §10.5 point 3: marks a session `quota_stopped` and posts a one-time notice, from either signal
   * - the OTLP `api_error` log event or a `StopFailure` hook carrying a rate-limit error (wired
   * below in `handleHookEvent`). Idempotent: a session already `quota_stopped` (or `dead`) is left
   * alone rather than re-posting on every subsequent error in the same stopped window. */
  function markQuotaStopped(slug: string): void {
    const row = sessionStore.get(slug);
    if (!row || row.state === "quota_stopped" || row.state === "dead") return;
    if (!isValidTransition(row.state, "quota_stopped")) return;
    sessionStore.setState(slug, "quota_stopped", nowIso());
    feedGovernor
      .scheduleAsync("P1", () =>
        controlBot.sendMessage(config.supergroupChatId, row.topicId, `⚠️ "${slug}" stopped on a usage limit (§10.5) - this looks frozen but isn't wedged; it should resume once the window resets.`),
      )
      .catch((err) => log("WARN", `failed to post quota-stop notice for "${slug}": ${(err as Error).message}`));
  }

  // §10.5 point 2's burn-rate alarm - this project's own choice of threshold, not a number the plan
  // specifies (same convention as §10.4.1's prompts-per-hour warning), overridable for a laptop that
  // wants a tighter or looser guardrail. `lastBurnAlarmMs` cooldown keeps a session that's genuinely
  // burning through quota from posting on every single API call once it crosses the line - "an alarm
  // that fires constantly is an alarm nobody reads" (§10.5).
  const BURN_RATE_THRESHOLD_USD = Number(process.env.AIBRIDGE_BURN_RATE_THRESHOLD_USD ?? 10);
  const BURN_RATE_ALARM_COOLDOWN_MS = 60 * 60 * 1000;
  let lastBurnAlarmMs = 0;

  // `sendChannelText`'s lost-Enter detector (found 2026-08-04) - real activity (spinner frames etc.)
  // redraws well within a couple of seconds, confirmed live, so this is generous rather than tight.
  const SUBMIT_CONFIRM_WINDOW_MS = Number(process.env.AIBRIDGE_SUBMIT_CONFIRM_WINDOW_MS ?? 2500);
  // How long the write's own echo takes to land, confirmed live to be well under 500ms - the
  // baseline for the check above is taken after this, not at the moment of the write itself.
  const ECHO_SETTLE_MS = Number(process.env.AIBRIDGE_ECHO_SETTLE_MS ?? 500);

  function maybeFireBurnRateAlarm(nowMs: number): void {
    if (nowMs - lastBurnAlarmMs < BURN_RATE_ALARM_COOLDOWN_MS) return;
    const fleetFiveHour = costTracker.fleetSpendSince(FIVE_HOURS_MS, nowMs);
    if (fleetFiveHour < BURN_RATE_THRESHOLD_USD) return;
    lastBurnAlarmMs = nowMs;
    const breakdown = sessionStore
      .all()
      .filter((r) => r.sessionId)
      .map((r) => ({ slug: r.slug, spend: costTracker.spendSince(r.sessionId as string, FIVE_HOURS_MS, nowMs) }))
      .filter((r) => r.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .map((r) => `  ${r.slug}: $${r.spend.toFixed(2)}`)
      .join("\n");
    feedGovernor
      .scheduleAsync("P1", () =>
        controlBot.sendMessage(
          config.supergroupChatId,
          undefined,
          `⚠️ Burn-rate alarm: fleet has spent $${fleetFiveHour.toFixed(2)} in the last 5h (threshold $${BURN_RATE_THRESHOLD_USD.toFixed(2)}).\n${breakdown}`,
        ),
      )
      .catch((err) => log("WARN", `failed to post burn-rate alarm: ${(err as Error).message}`));
  }

  startOtlpListener({
    port: otlpPort,
    log,
    onApiRequest: (event) => {
      costTracker.record(event.sessionId, event.atMs, event.costUsd);
      maybeFireBurnRateAlarm(event.atMs);
    },
    onApiError: (event) => {
      const slug = slugForSessionId(event.sessionId);
      if (slug) markQuotaStopped(slug);
    },
  });

  // §7.5: an unregistered/missing repos.toml disables /new rather than crashing the whole Bridge -
  // every other session (including the Phase 1 hardcoded one) works fine without it.
  const reposTomlPath = process.env.AIBRIDGE_REPOS_TOML ?? path.join(STATE_DIR, "repos.toml");
  let reposRegistry: ReposRegistry | undefined;
  try {
    reposRegistry = loadReposRegistry(reposTomlPath);
  } catch (err) {
    log("WARN", (err as Error).message);
  }

  const ptyProcessBySlug = new Map<string, pty.IPty>();
  const channelServerEntryPath = path.resolve(import.meta.dirname, "../../channel-server/src/index.ts");
  // `sendChannelText`'s own lost-Enter detector (found 2026-08-04, see the 0.27.0 changelog entry):
  // the last time each session's PTY produced *any* output, so a write that never gets a single
  // further onData event within the check window is treated as "the trailing \r never submitted"
  // rather than silently trusted.
  const lastPtyActivityBySlug = new Map<string, number>();
  // `/kill --all` and `/rm --all` (§4.2, added 2026-08-04) - the only fleet commands that can act
  // on every live session at once, so they go through the same confirm-button pattern as a
  // permission prompt instead of executing on the same message (fleet-confirm.ts).
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  const staleConfirmRegistry = new StaleConfirmRegistry();
  // Voice input (self-hosted Whisper via whisper.cpp) - a transcribed voice note is never
  // dispatched directly, only replayed from a tap on its own Send/Re-record/Type-instead card
  // (voice-confirm.ts), same shape as the stale-inbound confirm above.
  const voiceConfirmRegistry = new VoiceConfirmRegistry();
  const voiceServer = config.voice.enabled ? startWhisperServer(config.voice, log) : null;

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
    quietMode: () => feedGovernor.p2PressureExceeded(),
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

  // §5.4 point 4's quiet-mode notice: posted once on the rising edge only ("posts ... once", not
  // on every tick while pressure persists), and reset once pressure clears so a later, separate
  // storm notifies again rather than staying silent forever after the first one.
  let quietModeNotified = false;

  /** §5.5: one small, un-edited anchor message per turn carrying the `details` button - see
   * `details-button.ts` for why this can't just live on the turn card itself. P1 lane (a
   * lifecycle notice, not a permission/question card), and skipped for a `/pause`d session for
   * the same reason `feedCoalescer`'s own flush is (§4.2: "replies and prompts still flow, only
   * the feed card stops updating" - this is feed-adjacent, not a reply or a prompt). */
  function postDetailsButton(slug: string, turnSeq: number): void {
    if (sessionStore.get(slug)?.paused) return;
    const route = routing.get(slug);
    if (!route) return;
    feedGovernor
      .scheduleAsync("P1", () =>
        controlBot.sendMessage(config.supergroupChatId, route.topicId, "📋", { inline_keyboard: buildDetailsKeyboard(slug, turnSeq) }),
      )
      .catch((err) => log("WARN", `failed to post details button for "${slug}": ${(err as Error).message}`));
  }

  function handleHookEvent(msg: HookEventMessage): void {
    // §4.5's resume path needs a real session_id to hand to `claude --resume` - every hook event
    // carries one (§5.1), so this is the only place it's ever known, and it's cheap to keep fresh
    // in case a session's own id ever changes mid-run (e.g. after its own internal --resume).
    // Missing live 2026-08-03 until now: `sessionId` sat `null` forever, so the very first restart
    // recovery attempt had nothing to resume with.
    const row = sessionStore.get(msg.slug);
    if (row && row.sessionId !== msg.session_id) {
      sessionStore.setSessionId(msg.slug, msg.session_id);
    }

    // §4.3's state table, the hook-driven half (the permission/ask half is wired via
    // onAwaitingInput/maybeSetState below) - a stale/duplicate event is a silent no-op, not an error.
    const targetState = stateForHookEvent(msg.hook_event_name);
    if (targetState) maybeSetState(msg.slug, targetState);

    const event = normalizeHookEvent(msg.hook_event_name, msg.payload);
    if (!event) return;

    // §10.5 point 3's second quota-stop signal - a `StopFailure` hook whose own error text names a
    // rate limit/usage limit, independent of whether the OTLP `api_error` event (unverified shape,
    // see otlp-listener.ts) ever arrives for the same failure.
    if (event.kind === "turn_end" && !event.success && /rate.?limit|usage limit|quota/i.test(event.error)) {
      markQuotaStopped(msg.slug);
    }

    const nowMs = Date.now();
    const previous = feedStates.get(msg.slug) ?? createFeedState(msg.slug);
    const next = applyEvent(previous, event, nowMs);
    feedStates.set(msg.slug, next);

    if (event.kind === "turn_start") {
      const promptCount = promptsInLastHour(next, nowMs);
      if (promptCount > PROMPTS_PER_HOUR_WARN_THRESHOLD) {
        log("WARN", `session "${msg.slug}" started ${promptCount} turns in the last hour - check whether its allowlist has grown too broad (§10.4.1)`);
      }
      postDetailsButton(msg.slug, next.turnSeq);
    }

    feedCoalescer.notify(msg.slug, renderCard(next, nowMs));
  }

  // The deterministic half of `/new`'s first-write race (§4.5's dev-channels dialog is the other
  // half, handled in `session-launcher.ts`): a slug can have at most one pending waiter at a time,
  // since nothing writes a session's first message before it's even launched.
  const channelConnectedWaiters = new Map<string, () => void>();

  /** Resolves once the channel server for `slug` has completed its MCP handshake with this Claude
   * Code process, or after `timeoutMs` if it never does (a misconfigured `.mcp.json`, say) - a
   * caller that needs this settled before writing must not wedge forever over a signal that never
   * arrives. Replaces a guessed fixed delay after the dev-channels dialog (confirmed live
   * 2026-08-04 to be unreliable) with the real event that delay was standing in for. */
  function waitForChannelConnected(slug: string, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        channelConnectedWaiters.delete(slug);
        log("WARN", `timed out waiting for the channel server to connect for "${slug}" - proceeding anyway`);
        resolve();
      }, timeoutMs);
      channelConnectedWaiters.set(slug, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // `/usage` (§4.2, added 2026-08-04): a slug can have at most one pending capture at a time - a
  // second `/usage` for the same slug while one is already in flight would garble both buffers, so
  // `requestUsagePanel` below overwrites rather than queuing, same "last request wins" simplicity as
  // the channel-connected waiter above.
  const usageWaiters = new Map<string, { buffer: string; check: () => void }>();

  /** Writes `/usage` into `slug`'s own PTY (a local TUI overlay - never reaches the model, so it
   * can't pollute the conversation) and resolves once Claude Code's async "scanning local sessions"
   * refresh has settled (the "d to day · w to week" hint is the last thing that overlay renders -
   * confirmed live 2026-08-04, see `usage-panel.ts`). Falls back to whatever's been captured so far
   * on timeout rather than discarding it - the first frame alone already has real numbers, same
   * "best-effort" convention `/attach`'s ring buffer already uses. Always closes the overlay with
   * Esc before resolving, so the session isn't left showing it over the normal prompt. */
  function requestUsagePanel(slug: string, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve) => {
      const write = routing.getPtyWrite(slug);
      if (!write) {
        resolve(`No live PTY for "${slug}" to query.`);
        return;
      }
      const finish = (state: { buffer: string }) => {
        clearTimeout(timeout);
        usageWaiters.delete(slug);
        write("\x1b");
        resolve(formatUsagePanel(stripAnsi(state.buffer)));
      };
      const timeout = setTimeout(() => {
        const state = usageWaiters.get(slug);
        if (state) finish(state);
      }, timeoutMs);
      usageWaiters.set(slug, {
        buffer: "",
        check() {
          if (/d to day/i.test(stripAnsi(this.buffer))) finish(this);
        },
      });
      write("/usage\r");
    });
  }

  // §10.1.2: inbound delivery no longer goes through the channel server (see the onUpdate
  // handler below), but the pipe server still owns outbound reply relay and stays the
  // transport for Phase 2+ (permission_request/verdict/event), so it's still started
  // unconditionally.
  const pipeHandle = startPipeServer({
    routing,
    controlBot,
    governor: feedGovernor,
    chatId: config.supergroupChatId,
    stateDir: STATE_DIR,
    thinkingPlaceholder,
    onReplySent: (topicId, text) => {
      typingIndicator.stop(topicId);
      // §4.4's rename-once: the first real reply upgrades the topic off its provisional
      // `/new`-prompt title, capped so a later reply never renames it again.
      const row = sessionStore.getByTopicId(Number(topicId));
      if (row && !row.renamed) {
        sessionStore.setRenamed(row.slug);
        controlBot
          .editForumTopic(config.supergroupChatId, Number(topicId), text.slice(0, 128) || row.slug)
          .catch((err: unknown) => log("WARN", `editForumTopic (rename-once) failed for "${row.slug}": ${(err as Error).message}`));
      }
    },
    onHookEvent: handleHookEvent,
    onAwaitingInput: (slug) => maybeSetState(slug, "awaiting_input"),
    onChannelConnected: (slug) => {
      channelConnectedWaiters.get(slug)?.();
      channelConnectedWaiters.delete(slug);
    },
    log,
  });

  // §6.5: strip the keyboard, mark "expired", and deny (see sweepExpiredPermissions) on any
  // pending permission request past its TTL - a stale button left live would look tappable but
  // silently do nothing.
  setInterval(() => {
    sweepExpiredPermissions(
      pipeHandle.permissionRegistry,
      pipeHandle.sendVerdict,
      pipeHandle.finalizePermissionMessage,
      (err) => log("WARN", `failed to mark permission request as expired: ${err.message}`),
    );

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

    // §5.4 point 4: more than half of P2 (feed card) sends dropped over the last 60s means the
    // feed bot's bucket is genuinely saturated, not just one unlucky edit - tell the operator once
    // rather than let cards silently go stale with no explanation. feed-coalescer.ts already reads
    // this same signal to double its own interval; this is only the notice half.
    const quiet = feedGovernor.p2PressureExceeded();
    if (quiet && !quietModeNotified) {
      quietModeNotified = true;
      confirmSessionCommand(undefined, `⚠️ feed throttled, ${routing.all().length} sessions active`);
    } else if (!quiet && quietModeNotified) {
      quietModeNotified = false;
    }
  }, 60_000);

  if (process.env.AIBRIDGE_SKIP_LAUNCH !== "1") {
    const session = launchSession({
      slug: config.phase1.slug,
      topicId: config.phase1.topicId,
      repoPath: config.phase1.repoPath,
      channelServerEntryPath,
      worktreesRoot: phase1WorktreesRoot,
      mirrorPtyToConsole: process.env.AIBRIDGE_DEV_MIRROR_PTY === "1",
      otlpPort,
      log,
    });

    wireSession(config.phase1.slug, session.ptyProcess, config.phase1.topicId);

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
              // ?slug= targets any tracked session, not just the Phase 1 hardcoded one - added
              // 2026-08-04 purely as a live-debugging affordance, to send a raw keystroke to a
              // fleet session with no other manual-launch wiring.
              const slug = url.searchParams.get("slug");
              const target = slug ? ptyProcessBySlug.get(slug) : session.ptyProcess;
              if (!target) {
                res.statusCode = 404;
                res.end(`no live session for slug "${slug}"\n`);
                return;
              }
              target.write(body);
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

  /**
   * §4.5's reconciliation, wired for real: on this stack (measured 2026-08-03) a live session's
   * process never survives the Bridge dying, so `readopt` (row 1 - "process alive") is defensive
   * only, kept for the untested-in-practice recycled-pid case §4.5 calls out - it still relaunches
   * fresh rather than pretending an orphaned handle is usable. Every other non-`dead` row always
   * lands on `resume`. Scoped to every slug except the hardcoded Phase 1 one, which the block above
   * already launches fresh unconditionally rather than resuming - a known simplification, not an
   * oversight (Phase 1's own session predates this table and isn't itself Phase 5 scope).
   */
  function isPidAlive(pid: number): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** §4.5's "row exists, topic deleted in Telegram" row: probed live (there's no `getForumTopic`
   * to just ask - see `topic-probe.ts`) before spending a resume attempt on a topic nothing can be
   * posted to. Marks the row `dead` and notifies the control topic instead of the (gone) session
   * topic - a `resumeSession` for a deleted topic would itself fail to post its own confirmation,
   * silently, which is worse than skipping it outright. */
  async function reapRowsWithDeletedTopics(rows: readonly SessionRow[]): Promise<SessionRow[]> {
    const survivors: SessionRow[] = [];
    for (const row of rows) {
      const deleted = await isTopicDeleted(controlBot, config.supergroupChatId, row.topicId);
      if (deleted) {
        sessionStore.setState(row.slug, "dead", nowIso());
        log("WARN", `session "${row.slug}"'s Telegram topic was deleted while the Bridge was down (§4.5) - marked dead, worktree preserved at ${row.worktreePath}`);
        confirmSessionCommand(undefined, `Session "${row.slug}" was marked dead: its Telegram topic no longer exists. Worktree preserved at ${row.worktreePath}.`);
      } else {
        survivors.push(row);
      }
    }
    return survivors;
  }

  /** §4.5's "process alive, no row" orphan row: a `claude` process this Bridge instance never
   * launched (or lost track of) that's still holding onto a worktree. Detected, logged and
   * surfaced to the control topic for manual review only - an unrecognized live process is never
   * auto-killed (deciding to kill something is the operator's call, not a startup heuristic's). */
  async function reportOrphanProcesses(): Promise<void> {
    const processes = await listClaudeProcesses();
    if (processes.length === 0) return;
    const orphans = findOrphanProcesses(processes, sessionStore.all());
    if (orphans.length === 0) return;
    const pidList = orphans.map((o) => o.pid).join(", ");
    log("WARN", `found ${orphans.length} orphaned claude process(es) with no matching session row (§4.5): pid(s) ${pidList}`);
    confirmSessionCommand(
      undefined,
      `Found ${orphans.length} orphaned claude process(es) not tracked by any session row: pid(s) ${pidList}. Not killed automatically - review and end manually if unwanted.`,
    );
  }

  async function runStartupReconciliation(): Promise<void> {
    await reportOrphanProcesses();
    const rows = sessionStore.all().filter((r) => r.slug !== config.phase1.slug && r.state !== "dead");
    if (rows.length === 0) return;
    const live = await reapRowsWithDeletedTopics(rows);
    if (live.length === 0) return;
    const actions = reconcile(live, isPidAlive);
    for (const action of actions) {
      if (action.kind === "readopt") {
        log("WARN", `session "${action.slug}"'s process is still alive after a Bridge restart, but the PTY handle is gone (§4.5) - resuming on a fresh PTY anyway`);
      }
    }
    for (const row of live) {
      log("INFO", `reconciling session "${row.slug}" after a Bridge restart`);
      await resumeSession(row);
    }
  }

  if (process.env.AIBRIDGE_SKIP_LAUNCH !== "1") {
    await runStartupReconciliation();
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

  /**
   * Retries the trailing `\r` once if the PTY produces no output at all within the window - found
   * live 2026-08-04 (see the 0.27.0 changelog entry): the content+`\r` writes can land with the
   * Enter never actually submitting, silently wedging the session with no further output ever and
   * no error anywhere. `session.ready`/`waitForChannelConnected` close the *startup* race but not
   * this one. A genuinely working turn produces PTY output (spinner frames etc.) well within this
   * window - confirmed live, real activity redraws every few hundred ms - so "nothing at all" for
   * the full window is a reliable "the Enter didn't land" signal, not a false positive on a slow
   * turn. Resends only the `\r`, never the content, so a `\r` that *did* land doesn't get the
   * prompt injected twice. If the retry also produces nothing, gives up loudly instead of leaving
   * the "Thinking..." placeholder lying forever with no explanation.
   */
  function confirmSubmitted(slug: string, topicId: number, write: (text: string) => void, attempt = 1): void {
    // The write's own echo (the typed text reappearing) is itself real, non-empty PTY output - so
    // the baseline has to be taken *after* that echo has landed, not at the moment of the write,
    // or the echo alone always looks like "it worked" regardless of whether Claude ever submitted
    // it. `ECHO_SETTLE_MS` is comfortably longer than the echo has ever taken to land live.
    setTimeout(() => {
      const baseline = lastPtyActivityBySlug.get(slug) ?? 0;
      setTimeout(() => {
        const lastActivity = lastPtyActivityBySlug.get(slug) ?? 0;
        if (lastActivity > baseline) return; // real activity happened after the echo settled
        if (attempt >= 2) {
          log("ERROR", `session "${slug}" produced no output after ${attempt} attempts to submit an inbound message - likely wedged`);
          confirmSessionCommand(topicId, `⚠️ "${slug}" isn't responding to its last message - it may be wedged. Try /kill then /new again, or check /attach.`);
          return;
        }
        log("WARN", `session "${slug}" produced no output ${SUBMIT_CONFIRM_WINDOW_MS}ms after an inbound message - retrying the Enter`);
        write("\r");
        confirmSubmitted(slug, topicId, write, attempt + 1);
      }, SUBMIT_CONFIRM_WINDOW_MS);
    }, ECHO_SETTLE_MS);
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
    confirmSubmitted(slug, topicId, write);
  }

  // §5.4's P1 lane: every fleet-command echo and session lifecycle notice this Bridge posts on
  // its own initiative funnels through here, so wiring it through the governor once covers all of
  // them - never delayed behind P2 feed traffic, itself never allowed to delay a P0 permission
  // prompt or question.
  function confirmSessionCommand(topicId: number | undefined, text: string, parseMode?: "HTML"): void {
    feedGovernor
      .scheduleAsync("P1", () => controlBot.sendMessage(config.supergroupChatId, topicId, text, undefined, parseMode))
      .catch((err: unknown) => log("WARN", `failed to send command confirmation: ${(err as Error).message}`));
  }

  /** Wires up a freshly-spawned (or resumed) session's PTY: the routing table's write/output-tail
   * plumbing, the `ptyProcessBySlug` liveness map, and the supervisor's crash detector. Shared by
   * the Phase 1 launch, `/new`, and every `resumeSession` relaunch so the three don't drift. */
  function wireSession(slug: string, ptyProcess: pty.IPty, topicId: number): void {
    routing.setPtyWrite(slug, (text) => ptyProcess.write(text));
    ptyProcess.onData((data) => {
      // An onData event alone is too loose a signal - confirmed live 2026-08-04 that a wedged
      // session still periodically emits ANSI-only chunks (cursor blink, resize repaint) with no
      // visible text at all, which defeated the first version of this check entirely. Only content
      // that survives `stripAnsi` counts as real activity.
      if (stripAnsi(data).length > 0) lastPtyActivityBySlug.set(slug, Date.now());
      routing.appendOutput(slug, data);
      const usageState = usageWaiters.get(slug);
      if (usageState) {
        usageState.buffer += data;
        usageState.check();
      }
    });
    ptyProcessBySlug.set(slug, ptyProcess);
    ptyProcess.onExit(({ exitCode }) => {
      void handleUnexpectedExit(slug, ptyProcess, topicId, exitCode);
    });
  }

  /**
   * The supervisor's health/restart-on-crash duty (§12 Phase 5). Fires on *any* PTY exit,
   * deliberate or not - the `ptyProcessBySlug.get(slug) !== ptyProcess` check is what tells the two
   * apart: `/kill`/`/rm` both delete the map entry before calling `.kill()`, so by the time this
   * (asynchronous) exit handler runs for that call, the entry is already gone or already points at
   * a newer PTY, and this is a silent no-op. Anything else is a real crash, and gets the same
   * `claude --resume` treatment §4.5 already gives a Bridge restart.
   */
  async function handleUnexpectedExit(slug: string, ptyProcess: pty.IPty, topicId: number, exitCode: number): Promise<void> {
    if (ptyProcessBySlug.get(slug) !== ptyProcess) return;
    ptyProcessBySlug.delete(slug);
    routing.clearPtyWrite(slug);
    const row = sessionStore.get(slug);
    if (!row || row.state === "dead") return;
    log("WARN", `session "${slug}" exited unexpectedly (code ${exitCode}) - attempting an automatic resume`);
    confirmSessionCommand(topicId, `⚠️ Session "${slug}" exited unexpectedly. Attempting to resume it automatically...`);
    await resumeSession(row);
  }

  /**
   * Shared by both restart-recovery paths - a Bridge restart (`runStartupReconciliation`) and a
   * live crash (`handleUnexpectedExit`) - since both need exactly the same thing: relaunch via
   * `claude --resume <session_id>` on a fresh PTY, rewire it, and tell the topic what happened.
   * §4.5's "row exists, `state = awaiting_input`" case is handled first since the pending prompt
   * is gone either way and needs its own notice, distinct from the resume notice.
   */
  async function resumeSession(row: SessionRow): Promise<void> {
    const { slug, topicId } = row;
    if (row.state === "awaiting_input") {
      sessionStore.setState(slug, "working", nowIso());
      confirmSessionCommand(topicId, "The pending question was lost - please re-ask.");
    }
    if (!row.sessionId) {
      sessionStore.setState(slug, "dead", nowIso());
      confirmSessionCommand(topicId, `Session "${slug}" could not be resumed (no session id was recorded yet). Worktree preserved at ${row.worktreePath}.`);
      return;
    }
    try {
      const session = launchSession({
        slug,
        topicId,
        repoPath: row.repoPath,
        channelServerEntryPath,
        worktreesRoot: path.dirname(row.worktreePath),
        model: row.model,
        resumeSessionId: row.sessionId,
        otlpPort,
        log,
      });
      wireSession(slug, session.ptyProcess, topicId);
      sessionStore.setPtyPid(slug, session.ptyProcess.pid ?? 0);
      // Without this, `routing.getByTopicId(topicId)` stays undefined for this session forever
      // after this restart (only the phase1 slot and freshly-`/new`'d sessions ever call
      // `routing.add` otherwise) - every message in its topic then silently drops at the
      // `!isControl && !route` guard, with no error and no log line. Confirmed live 2026-08-04:
      // a resumed session answered /ls (control topic, doesn't need routing) but never replied to
      // anything sent in its own topic - not the command being wrong, the route being missing.
      routing.add({ slug, topicId, worktreePath: row.worktreePath });
      confirmSessionCommand(topicId, `Session "${slug}" resumed.`);
    } catch (err) {
      sessionStore.setState(slug, "dead", nowIso());
      confirmSessionCommand(topicId, `Failed to resume "${slug}": ${(err as Error).message}. Worktree preserved at ${row.worktreePath}.`);
    }
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

    // §10.5 point 1: refuse before ever creating a topic/worktree, so a rejected /new leaves no
    // debris the way a launch failure further down deliberately cleans up after itself.
    const capCheck = checkConcurrencyCap(sessionStore.all(), model);
    if (!capCheck.ok) {
      confirmSessionCommand(
        controlTopicId,
        `Refused: the fleet is already at ${capCheck.current}/${WEIGHTED_CAP} weighted units - adding a ${model} session would bring it to ${capCheck.wouldBe}. Kill or /rm a session first.`,
      );
      return;
    }

    const base = slugFromPrompt(cmd.prompt);
    const slug = uniqueSlug(base, sessionStore.slugs());

    let topic: { message_thread_id: number };
    try {
      topic = await controlBot.createForumTopic(config.supergroupChatId, cmd.prompt.slice(0, 128));
    } catch (err) {
      confirmSessionCommand(controlTopicId, `Failed to create a topic for "${slug}": ${(err as Error).message}`);
      return;
    }

    let session: ReturnType<typeof launchSession>;
    try {
      session = launchSession({
        slug,
        topicId: topic.message_thread_id,
        repoPath: repo.path,
        channelServerEntryPath,
        worktreesRoot: fleetWorktreesRoot,
        model,
        otlpPort,
        log,
      });
    } catch (err) {
      // A launch failure this late still leaves the topic already created above (Telegram has no
      // atomic "create topic + do the rest" call) - deleted here rather than left as an orphan with
      // no session row and therefore no slug for `/rm` to ever find, confirmed live 2026-08-03 when
      // a branch-name collision left exactly this kind of debris behind.
      try {
        await controlBot.deleteForumTopic(config.supergroupChatId, topic.message_thread_id);
      } catch (deleteErr) {
        log("WARN", `failed to clean up topic for "${slug}" after a failed launch: ${(deleteErr as Error).message}`);
      }
      confirmSessionCommand(controlTopicId, `Failed to launch session "${slug}": ${(err as Error).message}`);
      return;
    }

    routing.add({ slug, topicId: topic.message_thread_id, worktreePath: session.worktreePath });
    wireSession(slug, session.ptyProcess, topic.message_thread_id);

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
      renamed: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });

    confirmSessionCommand(controlTopicId, `Created "${slug}" (${model}) in a new topic.`);

    // Two independent gates, both real events rather than guessed delays: the dev-channels dialog
    // must be confirmed (`session.ready` - otherwise the write lands on the still-open dialog and
    // corrupts it, confirmed live 2026-08-04), and the channel server's own MCP handshake must have
    // completed (`waitForChannelConnected` - otherwise the write's trailing Enter can be silently
    // lost even with the dialog long since confirmed, also confirmed live 2026-08-04). `/new`'s
    // initial prompt is the only write this codebase ever makes to a session this early.
    await session.ready;
    await waitForChannelConnected(slug);
    sendChannelText(slug, topic.message_thread_id, cmd.prompt, "new-1", "telegram");
  }

  function handleLsCommand(topicId: number | undefined): void {
    const rows = sessionStore.all();
    const nowMs = Date.now();
    const costBySlug = new Map<string, number>();
    for (const row of rows) {
      if (row.sessionId) costBySlug.set(row.slug, costTracker.lifetimeSpend(row.sessionId));
    }
    const detailBySlug = buildLsDetail(rows, nowMs, monotonicNowMs(), feedStates, pipeHandle.permissionRegistry.all(), pipeHandle.askRegistry.all());
    controlBot
      .sendMessage(config.supergroupChatId, topicId, renderLsTable(rows, nowMs, costBySlug, detailBySlug), undefined, "HTML")
      .catch((err) => log("WARN", `sendMessage (/ls) failed: ${(err as Error).message}`));
  }

  /** §10.5 point 2's `/budget`: fleet-wide rolling 5h/7d spend plus a per-session 5h breakdown -
   * control-topic only, same as `/ls` (no single session to scope this to). */
  function handleBudgetCommand(topicId: number | undefined): void {
    const nowMs = Date.now();
    costTracker.prune(nowMs);
    const fleetFiveHour = costTracker.fleetSpendSince(FIVE_HOURS_MS, nowMs);
    const fleetWeekly = costTracker.fleetSpendSince(ONE_WEEK_MS, nowMs);
    const perSessionFiveHour = new Map<string, number>();
    for (const row of sessionStore.all()) {
      if (row.sessionId) perSessionFiveHour.set(row.slug, costTracker.spendSince(row.sessionId, FIVE_HOURS_MS, nowMs));
    }
    controlBot
      .sendMessage(config.supergroupChatId, topicId, renderBudget(fleetFiveHour, fleetWeekly, perSessionFiveHour))
      .catch((err) => log("WARN", `sendMessage (/budget) failed: ${(err as Error).message}`));
  }

  /** `/voice [<model>]` - control-topic-only (voice-model.ts), same reasoning as `/budget`/`/ls`:
   * there is exactly one whisper-server for the whole Bridge, not one per session, so there is
   * nothing to scope this to besides the fleet itself. Bare `/voice` lists what's on disk with a
   * button per model (current one checkmarked); `/voice <model>` or a button tap switches live via
   * `/load` - live-verified 2026-08-05, no process restart needed. */
  function handleVoiceModelCommand(cmd: Extract<FleetCommand, { kind: "voice" }>, topicId: number | undefined): void {
    if (!voiceServer) {
      confirmSessionCommand(topicId, "Voice input isn't enabled on this Bridge (VOICE_ENABLED=false).");
      return;
    }
    const voiceDir = path.dirname(config.voice.modelPath);
    const models = listAvailableVoiceModels(voiceDir);
    const currentName = path.basename(voiceServer.currentModelPath()).replace(/^ggml-/, "").replace(/\.bin$/, "");
    if (!cmd.model) {
      if (models.length === 0) {
        confirmSessionCommand(topicId, `No Whisper models found under ${voiceDir} - run scripts/setup-windows.ps1's voice step.`);
        return;
      }
      controlBot
        .sendMessage(config.supergroupChatId, topicId, `Current model: ${currentName}\nChoose a model:`, { inline_keyboard: buildVoiceModelKeyboard(models, currentName) })
        .catch((err) => log("WARN", `sendMessage (/voice) failed: ${(err as Error).message}`));
      return;
    }
    void applyVoiceModelSwitch(topicId, cmd.model, voiceDir, models, currentName);
  }

  /** Re-validates `name` against a freshly re-scanned model list rather than trusting the caller
   * (a typed `/voice <name>` argument is untrusted text; a button tap is re-checked too, since the
   * list on disk could have changed between the button being posted and tapped). */
  async function applyVoiceModelSwitch(topicId: number | undefined, name: string, voiceDir: string, models: readonly string[], currentName: string): Promise<void> {
    if (!voiceServer) return;
    if (name === currentName) {
      confirmSessionCommand(topicId, `🎤 Already using "${name}".`);
      return;
    }
    if (!models.includes(name)) {
      confirmSessionCommand(topicId, `Unknown model "${name}" - available: ${models.length > 0 ? models.join(", ") : "(none found)"}`);
      return;
    }
    try {
      await voiceServer.switchModel(path.join(voiceDir, `ggml-${name}.bin`));
      confirmSessionCommand(topicId, `🎤 Switched to "${name}".`);
    } catch (err) {
      confirmSessionCommand(topicId, `Failed to switch to "${name}": ${(err as Error).message}`);
    }
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
      return feedGovernor.scheduleAsync("P1", () => controlBot.editMessageText!(config.supergroupChatId, messageId, "Session ended."));
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

  /** The actual teardown `/kill` does for one row - shared by the single-slug form and the
   * `--all` confirm-button flow below, so the two can't drift. */
  async function killSessionRow(row: SessionRow): Promise<void> {
    const { slug } = row;
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
  }

  /** Posts the Yes/No confirm card for `/kill --all`/`/rm --all` and registers it in
   * `fleetConfirmRegistry` - shared since the two commands differ only in wording and which
   * teardown function eventually runs. Returns without posting if there's nothing to act on. */
  async function postFleetConfirm(kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[], promptText: string): Promise<void> {
    if (targets.length === 0) {
      confirmSessionCommand(topicId, kind === "kill" ? "No live sessions to kill." : "No sessions to remove.");
      return;
    }
    const id = randomUUID().slice(0, 8);
    const slugs = targets.map((r) => r.slug);
    try {
      const sent = await controlBot.sendMessage(config.supergroupChatId, topicId, `${promptText}\n${slugs.join(", ")}`, {
        inline_keyboard: buildFleetConfirmKeyboard(kind, id),
      });
      fleetConfirmRegistry.add({ id, kind, slugs, topicId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post /${kind} --all confirmation: ${(err as Error).message}`);
    }
  }

  async function finalizeFleetConfirmMessage(pending: PendingFleetConfirm, text: string): Promise<void> {
    if (!controlBot.editMessageText) return;
    try {
      await controlBot.editMessageText(config.supergroupChatId, pending.messageId, text, { inline_keyboard: [] });
    } catch (err) {
      log("WARN", `failed to finalize fleet-confirm message: ${(err as Error).message}`);
    }
  }

  /** §7.4's stale-inbound path: posts the "received while offline, still want this?" card instead
   * of dispatching a backlog message directly, and registers the replay payload. Mirrors
   * `postFleetConfirm`'s shape exactly. */
  async function postStaleConfirm(threadId: number | undefined, messageId: number, rawText: string, from: string, ageLabel: string): Promise<void> {
    const id = randomUUID().slice(0, 8);
    const preview = rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
    try {
      const sent = await controlBot.sendMessage(config.supergroupChatId, threadId, `⏳ received while offline (${ageLabel}) - still want this?\n\n${preview}`, {
        inline_keyboard: buildStaleConfirmKeyboard(id),
      });
      staleConfirmRegistry.add({ id, threadId, messageId, rawText, from, confirmCardMessageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post stale-inbound confirmation: ${(err as Error).message}`);
    }
  }

  async function finalizeStaleConfirmMessage(pending: PendingStaleConfirm, text: string): Promise<void> {
    if (!controlBot.editMessageText) return;
    try {
      await controlBot.editMessageText(config.supergroupChatId, pending.confirmCardMessageId, text, { inline_keyboard: [] });
    } catch (err) {
      log("WARN", `failed to finalize stale-confirm message: ${(err as Error).message}`);
    }
  }

  /** Voice-input's own confirm-card path (voice-confirm.ts): downloads the voice note, transcribes
   * it locally against the Bridge's own supervised whisper-server, and posts a Send/Re-record/
   * Type-instead card - never dispatched directly. Whisper's accuracy varies a lot by language
   * (Azerbaijani meaningfully weaker than English/Russian/Ukrainian per the voice-input design
   * decision), so showing the transcript before it reaches a live session is load-bearing.
   *
   * A real recording is several seconds of download+ffmpeg+whisper before there's anything to
   * show - same "nothing visible is happening" gap thinking-placeholder.ts exists to close for a
   * turn, and observed live the same way (an 8s voice note with no feedback at all reads as
   * "did this even work?"). Same fix: post a "🎤 Transcribing..." placeholder immediately, then
   * edit that same message into the real confirm card - one message per voice note, not two. */
  async function handleVoiceMessage(voice: { file_id: string; duration: number }, threadId: number | undefined, messageId: number, from: string): Promise<void> {
    if (!config.voice.enabled) {
      confirmSessionCommand(threadId, "Voice input isn't set up on this Bridge yet - see scripts/setup-windows.ps1's voice step, then set VOICE_ENABLED=true.");
      return;
    }
    let placeholderId: number | undefined;
    try {
      const placeholder = await feedGovernor.scheduleAsync("P1", () =>
        controlBot.sendMessage(config.supergroupChatId, threadId, "🎤 Transcribing..."),
      );
      placeholderId = placeholder.message_id;

      const { file_path } = await controlBot.getFile(voice.file_id);
      const oggBytes = await controlBot.downloadFile(file_path);
      const { text } = await transcribeVoiceNote(
        { ffmpegPath: config.voice.ffmpegPath, serverUrl: `http://127.0.0.1:${config.voice.port}` },
        oggBytes,
      );
      const id = randomUUID().slice(0, 8);
      const preview = text.length > 0 ? text : "(nothing recognised - try again?)";
      if (controlBot.editMessageText) {
        await feedGovernor.scheduleAsync("P1", () =>
          controlBot.editMessageText!(config.supergroupChatId, placeholderId!, `🎤 ${preview}`, { inline_keyboard: buildVoiceConfirmKeyboard(id) }),
        );
      }
      voiceConfirmRegistry.add({ id, threadId, messageId, transcript: text, from, confirmCardMessageId: placeholderId });
    } catch (err) {
      log("WARN", `voice transcription failed: ${(err as Error).message}`);
      const failText = "Couldn't transcribe that voice note - try again, or just type it.";
      if (placeholderId !== undefined && controlBot.editMessageText) {
        await controlBot.editMessageText(config.supergroupChatId, placeholderId, failText).catch(() => {});
      } else {
        confirmSessionCommand(threadId, failText);
      }
    }
  }

  /** Inbound photos/documents/videos/audio/video-notes (§5.6): downloaded into the session's own
   * `inbox/` directory and announced by path - "no protocol extension is needed, because a path
   * in context is enough." Unlike voice input, there's no transcription step and no confirm card:
   * the announcement (plus any caption) goes straight to the session through the same
   * `dispatchInboundMessage` path a typed message would, since there's nothing ambiguous here for
   * an operator to review first. Only fires for a real session topic - the control topic has no
   * worktree/session to hand a landed file to. */
  async function handleAttachmentMessage(
    kind: AttachmentKind,
    fileId: string,
    fileSize: number | undefined,
    fileName: string | undefined,
    mimeType: string | undefined,
    threadId: number | undefined,
    route: ReturnType<typeof routing.getByTopicId>,
    isControl: boolean,
    messageId: number,
    caption: string | undefined,
    from: string,
  ): Promise<void> {
    if (!route) {
      if (isControl) confirmSessionCommand(threadId, `Send ${attachmentKindLabel(kind)} in a session topic - the control topic has no session to hand it to.`);
      return;
    }
    if (fileSize !== undefined && fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      confirmSessionCommand(threadId, `That's too large to download (${Math.round(fileSize / (1024 * 1024))} MB) - Telegram's Bot API caps bot downloads at 20 MB.`);
      return;
    }
    try {
      const { file_path } = await controlBot.getFile(fileId);
      const bytes = await controlBot.downloadFile(file_path);
      const suggestedName = guessAttachmentFilename(kind, fileName, mimeType);
      const absPath = writeAttachmentToInbox(STATE_DIR, route.slug, suggestedName, bytes);
      const announcement = buildAttachmentAnnouncement(kind, absPath, caption);
      dispatchInboundMessage(messageId, announcement, threadId, isControl, route, route.slug, from);
    } catch (err) {
      log("WARN", `attachment download failed: ${(err as Error).message}`);
      confirmSessionCommand(threadId, `Couldn't download that ${kind} - try sending it again.`);
    }
  }

  async function finalizeVoiceConfirmMessage(pending: PendingVoiceConfirm, text: string): Promise<void> {
    if (!controlBot.editMessageText) return;
    try {
      await controlBot.editMessageText(config.supergroupChatId, pending.confirmCardMessageId, text, { inline_keyboard: [] });
    } catch (err) {
      log("WARN", `failed to finalize voice-confirm message: ${(err as Error).message}`);
    }
  }

  /** Runs after a `/kill --all`/`/rm --all` confirm tap - re-looks-up rows by slug rather than
   * trusting a snapshot from when the confirm card was posted, since a session can die or get
   * removed independently in the minutes between posting and the tap. */
  async function executeFleetConfirm(pending: PendingFleetConfirm): Promise<void> {
    const rows = pending.slugs.map((s) => sessionStore.get(s)).filter((r): r is SessionRow => r !== undefined);
    for (const row of rows) {
      await (pending.kind === "kill" ? killSessionRow(row) : removeSessionRow(row));
    }
    const verb = pending.kind === "kill" ? "Killed" : "Removed";
    await finalizeFleetConfirmMessage(pending, rows.length === 0 ? "Nothing left to act on." : `${verb} ${rows.length} session${rows.length === 1 ? "" : "s"}: ${rows.map((r) => r.slug).join(", ")}`);
  }

  async function handleKillCommand(cmd: Extract<FleetCommand, { kind: "kill" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    if (cmd.all) {
      const targets = sessionStore.all().filter((r) => r.state !== "dead");
      await postFleetConfirm("kill", topicId, targets, `Kill ${targets.length} live session${targets.length === 1 ? "" : "s"}?`);
      return;
    }

    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
    await killSessionRow(row);
    confirmSessionCommand(topicId, `Killed "${slug}". Worktree left in place - \`/rm ${slug}\` to remove it.`);
  }

  /** The actual teardown `/rm` does for one row - shared by the single-slug form and the bulk
   * `--dead`/`--prefix` forms below, so the two can't drift. */
  async function removeSessionRow(row: SessionRow): Promise<void> {
    const { slug } = row;
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
  }

  async function handleRmCommand(cmd: Extract<FleetCommand, { kind: "rm" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    // `--all` (added 2026-08-04) is the deliberate exception to the dead-only rule below - it can
    // remove live sessions too, so it goes through the same confirm-button flow as `/kill --all`
    // rather than executing on the same message (fleet-commands.ts's RmBulkFilter note).
    if (cmd.bulk?.mode === "all") {
      const targets = sessionStore.all();
      await postFleetConfirm("rm", topicId, targets, `Remove ALL ${targets.length} session${targets.length === 1 ? "" : "s"} - worktrees and topics deleted, live ones killed first?`);
      return;
    }

    // §4.2's bulk cleanup (added 2026-08-04): always scoped to `dead` rows, regardless of which
    // filter matched, since a bulk command is exactly the kind of action a mistyped prefix
    // shouldn't be able to turn into an accidental mass-`/kill` of live sessions.
    if (cmd.bulk) {
      const targets = sessionStore
        .all()
        .filter((r) => r.state === "dead")
        .filter((r) => (cmd.bulk?.mode === "prefix" ? r.slug.startsWith(cmd.bulk.prefix) : true));
      if (targets.length === 0) {
        confirmSessionCommand(topicId, "No dead sessions matched - nothing removed.");
        return;
      }
      for (const row of targets) {
        await removeSessionRow(row);
      }
      confirmSessionCommand(topicId, `Removed ${targets.length} dead session${targets.length === 1 ? "" : "s"}: ${targets.map((r) => r.slug).join(", ")}`);
      return;
    }

    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
    await removeSessionRow(row);
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

  /** `/usage` (§4.2, added 2026-08-04): asks `slug`'s own session to open Claude Code's own `/usage`
   * overlay (account-level Anthropic usage, distinct from anything Bridge tracks itself) and relays
   * the parsed Session/Weekly/Weekly-Fable percentages back into Telegram. */
  async function handleUsageCommand(cmd: Extract<FleetCommand, { kind: "usage" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const summary = await requestUsagePanel(resolved.slug);
    confirmSessionCommand(topicId, summary);
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

  /**
   * §4.5.1's `/restart`: self-respawn, not an external supervisor. Every live session dies with
   * this process (§4.5's measurement) and comes back via `resumeSession`'s `claude --resume` path
   * once the successor's own startup reconciliation runs - the same cold-start cost as any other
   * Bridge restart, just operator-triggered instead of waiting for a crash.
   */
  async function handleRestartCommand(topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/restart only works from the control topic.");
      return;
    }
    try {
      await controlBot.sendMessage(
        config.supergroupChatId,
        topicId,
        "Restarting the Bridge now (§4.5.1) - live sessions will relaunch via claude --resume once it's back up.",
      );
    } catch (err) {
      log("WARN", `failed to send /restart confirmation: ${(err as Error).message}`);
    }
    log("INFO", "/restart requested - spawning a detached successor and exiting");
    spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore" }).unref();
    process.exit(0);
  }

  /** `/settings`: control-topic only, same reasoning as `/budget` - repos.toml and the weighted
   * concurrency budget are fleet-wide, not scoped to any one session's topic. */
  function handleSettingsCommand(topicId: number | undefined): void {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/settings only works from the control topic.");
      return;
    }
    controlBot
      .sendMessage(
        config.supergroupChatId,
        topicId,
        renderSettings(reposRegistry?.all() ?? [], { current: currentUnits(sessionStore.all()), cap: WEIGHTED_CAP }),
      )
      .catch((err) => log("WARN", `sendMessage (/settings) failed: ${(err as Error).message}`));
  }

  /** `/repos [list|add <name> [path|git-url] [--base <b>] [--model <m>]|rm <name>]`: §7.5's
   * registry, now mutable from Telegram (`repos-registry.ts` owns the file I/O and validation)
   * instead of only by hand-editing repos.toml. Control-topic only, same reasoning as
   * `/settings`/`/budget` - the registry is fleet-wide, not scoped to any one session's topic.
   * `add`/`rm` reload `reposRegistry` in place so the very next `/new` sees the change without a
   * Bridge restart.
   *
   * `add`'s path argument is resolved here, ahead of `addRepoEntry`'s own local-path checks: a git
   * URL (`isGitUrl`) is cloned first (`cloneRepo`) into an inferred destination, and an omitted path
   * is inferred outright (`inferDefaultRepoPath`) - both only when every already-registered repo
   * shares one parent folder, per the operator's own §7.5 ask; otherwise this asks for an explicit
   * path rather than guessing. */
  function handleReposCommand(cmd: Extract<FleetCommand, { kind: "repos" }>, topicId: number | undefined): void {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/repos only works from the control topic.");
      return;
    }
    if (cmd.action === "list") {
      controlBot
        .sendMessage(config.supergroupChatId, topicId, renderReposList(reposRegistry?.all() ?? []))
        .catch((err) => log("WARN", `sendMessage (/repos) failed: ${(err as Error).message}`));
      return;
    }
    try {
      if (cmd.action === "add") {
        const existing = reposRegistry?.all() ?? [];
        const givenUrl = cmd.path && isGitUrl(cmd.path) ? cmd.path : undefined;
        let repoPath = givenUrl ? undefined : cmd.path;
        if (!repoPath) {
          repoPath = inferDefaultRepoPath(existing, cmd.name) ?? undefined;
          if (!repoPath) {
            confirmSessionCommand(
              topicId,
              `/repos add ${cmd.name}: no path given and none could be inferred (need at least one repo already registered, all sharing one parent folder) - specify a path or git URL explicitly.`,
            );
            return;
          }
        }
        if (givenUrl) {
          cloneRepo(givenUrl, repoPath, cmd.base);
        }
        addRepoEntry(reposTomlPath, { name: cmd.name, path: repoPath, base: cmd.base, model: cmd.model });
        reposRegistry = loadReposRegistry(reposTomlPath);
        confirmSessionCommand(
          topicId,
          `${givenUrl ? `Cloned ${givenUrl} -> ${repoPath} and r` : "R"}egistered "${cmd.name}" -> ${repoPath} (§7.5). /new ${cmd.name} <prompt> now works.`,
        );
        return;
      }
      removeRepoEntry(reposTomlPath, cmd.name);
      reposRegistry = loadReposRegistry(reposTomlPath);
      confirmSessionCommand(topicId, `Unregistered "${cmd.name}" - any existing worktree/session for it is untouched.`);
    } catch (err) {
      confirmSessionCommand(topicId, `/repos ${cmd.action} failed: ${(err as Error).message}`);
    }
  }

  /** Wraps `schtasks.exe` (built into Windows, no extra dependency) - `/Query` against an
   * unregistered task exits non-zero, which is a valid "not registered" answer, not a transport
   * failure, so this always resolves rather than rejecting; callers that care about install/delete
   * failing check `failed` themselves. */
  function runSchtasks(args: string[]): Promise<{ stdout: string; stderr: string; failed: boolean }> {
    return new Promise((resolve) => {
      execFile("schtasks", args, { windowsHide: true }, (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: err !== null });
      });
    });
  }

  /** `/autostart status|install|uninstall`: §7.2's Task Scheduler entry, made reachable from
   * Telegram instead of only from the desk. `install` registers a logon-trigger task under this
   * account's own token (`/RL LIMITED`), which needs no admin rights. */
  async function handleAutostartCommand(cmd: Extract<FleetCommand, { kind: "autostart" }>, topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/autostart only works from the control topic.");
      return;
    }
    try {
      if (cmd.action === "status") {
        const { stdout, stderr } = await runSchtasks(buildQueryArgs());
        await controlBot.sendMessage(config.supergroupChatId, topicId, renderAutostartStatus(parseQueryOutput(stdout, stderr)));
        return;
      }
      if (cmd.action === "install") {
        const entryScript = path.join(import.meta.dirname, "index.ts");
        const result = await runSchtasks(buildCreateArgs(resolveBunExecutable(), entryScript));
        if (result.failed) throw new Error(result.stderr.trim() || "schtasks /Create failed");
        confirmSessionCommand(
          topicId,
          `Registered "${TASK_NAME}" as a logon-trigger scheduled task (§7.2) - starts the Bridge at next log-on, current-user scope, no admin rights needed.`,
        );
        return;
      }
      const result = await runSchtasks(buildDeleteArgs());
      if (result.failed) throw new Error(result.stderr.trim() || "schtasks /Delete failed");
      confirmSessionCommand(topicId, `Removed the "${TASK_NAME}" scheduled task.`);
    } catch (err) {
      confirmSessionCommand(topicId, `/autostart ${cmd.action} failed: ${(err as Error).message}`);
    }
  }

  /**
   * The full plain-text/command dispatch that used to sit inline inside `onUpdate` - extracted
   * (§7.4) so a stale backlog message can be replayed from `staleConfirmRegistry`'s "yes" tap
   * through the exact same path a live message takes, rather than duplicating or approximating
   * that logic at the confirm-tap call site. Pure code motion off the live path below: no branch
   * here changed behaviour, only how the four already-computed values it depends on
   * (`isControl`/`route`/`currentSlug`/`from`) arrive - as parameters instead of closed-over
   * `const`s - plus `text` now derives from `rawText` internally instead of being handed in
   * pre-stripped, so a replay strips a `@botusername` mention the same way a live message would.
   */
  function dispatchInboundMessage(
    messageId: number,
    rawText: string,
    threadId: number | undefined,
    isControl: boolean,
    route: ReturnType<typeof routing.getByTopicId>,
    currentSlug: string | undefined,
    from: string,
  ): void {
    // Strip a Telegram-inserted "@botusername" before any command parsing below - see
    // stripBotMention's doc comment for why this has to happen exactly once, here.
    const text = stripBotMention(rawText.trim());

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
      if (fleetCmd.kind === "budget") {
        if (!isControl) {
          confirmSessionCommand(threadId, "/budget only works from the control topic.");
          return;
        }
        handleBudgetCommand(threadId);
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
      if (fleetCmd.kind === "usage") {
        void handleUsageCommand(fleetCmd, threadId, currentSlug);
        return;
      }
      if (fleetCmd.kind === "restart") {
        void handleRestartCommand(threadId);
        return;
      }
      if (fleetCmd.kind === "settings") {
        handleSettingsCommand(threadId);
        return;
      }
      if (fleetCmd.kind === "autostart") {
        void handleAutostartCommand(fleetCmd, threadId);
        return;
      }
      if (fleetCmd.kind === "repos") {
        handleReposCommand(fleetCmd, threadId);
        return;
      }
      if (fleetCmd.kind === "voice") {
        handleVoiceModelCommand(fleetCmd, threadId);
        return;
      }
      handlePauseCommand(fleetCmd, threadId, currentSlug);
      return;
    }

    // `/about`: the friendly capability overview (about.ts) - checked ahead of /help since it's
    // the on-ramp `/help` deliberately isn't; works from either the control topic or a session's
    // own topic, same as /help.
    if (isAboutCommand(text)) {
      controlBot
        .sendMessage(config.supergroupChatId, threadId, renderAbout(), {
          inline_keyboard: buildAboutKeyboard(),
        })
        .catch((err) => log("WARN", `sendMessage (/about) failed: ${(err as Error).message}`));
      return;
    }

    // "?" bare (no slash) is only treated as a help request from the control topic - inside a
    // session topic it's plausible real content meant for Claude (e.g. "?" as a shorthand
    // question), so only the unambiguous slash forms are recognised there.
    if (isHelpCommand(text, isControl)) {
      const repoCommands = route ? listRepoCommands(route.worktreePath) : [];
      const repoSkills = route ? listRepoSkills(route.worktreePath) : [];
      controlBot
        .sendMessage(config.supergroupChatId, threadId, renderHelp(), {
          inline_keyboard: buildCommandKeyboard(repoCommands, repoSkills),
        })
        .catch((err) => log("WARN", `sendMessage (command list) failed: ${(err as Error).message}`));
      return;
    }

    // `/commands [<term>]`/`/skills [<term>]` - the per-project, item-count-scoped lists (see
    // commands.ts's doc comments on `buildCommandKeyboard` for why these replaced per-item
    // buttons: seowrite, confirmed live 2026-08-04, has 43 repo commands and 66 skills, and a
    // flat button-per-item keyboard can't scale to that). Session-scoped only - control topic
    // has no worktree to read commands/skills from.
    const commandsQuery = parseCommandsQuery(text);
    if (commandsQuery) {
      const text_ = route
        ? renderCommandsListText(listRepoCommands(route.worktreePath), commandsQuery.term)
        : "Repo commands are session-scoped - send /commands inside a session's own topic.";
      controlBot.sendMessage(config.supergroupChatId, threadId, text_).catch((err) => log("WARN", `sendMessage (/commands) failed: ${(err as Error).message}`));
      return;
    }
    const skillsQuery = parseSkillsQuery(text);
    if (skillsQuery) {
      const text_ = route
        ? renderSkillsListText(listRepoSkills(route.worktreePath), skillsQuery.term)
        : "Repo skills are session-scoped - send /skills inside a session's own topic.";
      controlBot.sendMessage(config.supergroupChatId, threadId, text_).catch((err) => log("WARN", `sendMessage (/skills) failed: ${(err as Error).message}`));
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

    // Manual typing equivalent of the old per-item buttons (removed 2026-08-04 - see
    // commands.ts's `buildCommandKeyboard` doc comment): `/cmd <name>`/`/commands <name>`
    // invokes a repo command by name, `/<name>` invokes a repo skill by name if - and only if -
    // `<name>` matches a real skill; anything else falls through untouched rather than treating
    // every leading "/" as an error, since ordinary chat text can start with "/" too.
    if (route) {
      const cmdInvoke = parseCmdInvocation(text);
      if (cmdInvoke) {
        if (listRepoCommands(route.worktreePath).includes(cmdInvoke.name)) {
          sendChannelText(currentSlug, threadId, buildCmdShimText(cmdInvoke.name, cmdInvoke.args), String(messageId), from);
        } else {
          confirmSessionCommand(threadId, `No repo command named "${cmdInvoke.name}" in this project. Try /commands to list them.`);
        }
        return;
      }
      // A bare `/<name>` is checked against both skills and repo commands (in that order) -
      // `/cmd`/`/commands` stays available as an explicit disambiguator for the rare case a
      // skill and a command share a name, but for everything else typing `/deep-check` should
      // just work without the operator needing to know which category it's in.
      const skillInvoke = parseSkillInvocation(text);
      if (skillInvoke) {
        if (listRepoSkills(route.worktreePath).includes(skillInvoke.name)) {
          sendChannelText(currentSlug, threadId, buildSkillShimText(skillInvoke.name, skillInvoke.args), String(messageId), from);
          return;
        }
        if (listRepoCommands(route.worktreePath).includes(skillInvoke.name)) {
          sendChannelText(currentSlug, threadId, buildCmdShimText(skillInvoke.name, skillInvoke.args), String(messageId), from);
          return;
        }
      }
    }

    // §10.1.2: notifications/claude/channel is confirmed broken upstream (getClientCapabilities()
    // never negotiates the capability), so inbound delivery writes the same <channel> tag
    // Claude Code would have rendered itself directly to the session's PTY, exactly as an
    // operator typing it and pressing Enter would.
    sendChannelText(currentSlug, threadId, rawText, String(messageId), from);
  }

  const offsetPath = path.join(STATE_DIR, "telegram-offset.json");
  startPolling(controlBot, {
    initialOffset: loadOffset(offsetPath),
    onOffsetChange: (offset) => saveOffset(offsetPath, offset, (err) => log("WARN", `failed to persist Telegram offset: ${(err as Error).message}`)),
    onUpdate: (update) => {
      const callbackQuery = update.callback_query;
      if (callbackQuery) {
        feedGovernor
          .scheduleAsync("P0", () => controlBot.answerCallbackQuery(callbackQuery.id))
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

        // §5.5's `details` button - "d:", a fresh namespace alongside "ask:"/"perm:"/etc. Nothing
        // to resolve against a registry (the reference is self-contained: slug + turn number), so
        // this only needs `feedStates` to check the tapped turn is still the session's current one.
        const detailsAction = callbackQuery.data ? parseDetailsCallback(callbackQuery.data) : null;
        if (detailsAction) {
          const state = feedStates.get(detailsAction.slug);
          const stillCurrent = state && state.turnSeq === detailsAction.turnSeq;
          const text = stillCurrent ? renderDetails(state) : "That turn has ended - its log is no longer available.";
          if (text.length <= 4096) {
            // renderDetails renders the same `<code>`/escaped-entity markup the turn card itself
            // uses (feed-renderer.ts) - needs "HTML" here or Telegram shows the literal tags.
            confirmSessionCommand(threadId, text, "HTML");
          } else {
            // §5.5: "Diffs always go as documents" - the same reasoning applies to a details log
            // too long to fit in one message. Plain text, not renderDetails's HTML markup - a
            // document viewer has no HTML renderer to make that markup invisible.
            const plainText = stillCurrent ? renderDetailsPlainText(state) : text;
            feedGovernor
              .scheduleAsync("P1", () =>
                controlBot.sendDocument(config.supergroupChatId, threadId, `${detailsAction.slug}-turn${detailsAction.turnSeq}-details.txt`, plainText),
              )
              .catch((err) => log("WARN", `sendDocument (details) failed: ${(err as Error).message}`));
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

        // `/kill --all`/`/rm --all`'s own confirm keyboard (fleet-confirm.ts) - a fresh "fc:"
        // namespace, checked alongside "perm:" since both gate a destructive action behind a tap.
        const fleetConfirmAction = callbackQuery.data ? resolveFleetConfirmCallback(callbackQuery.data) : null;
        if (fleetConfirmAction) {
          const pending = fleetConfirmRegistry.resolve(fleetConfirmAction.id);
          if (!pending || pending.kind !== fleetConfirmAction.kind) return;
          if (!fleetConfirmAction.confirmed) {
            void finalizeFleetConfirmMessage(pending, "Cancelled - nothing was changed.");
            return;
          }
          void executeFleetConfirm(pending);
          return;
        }

        // §7.4's stale-inbound confirm keyboard (stale-confirm.ts) - "sc:", a fresh namespace
        // alongside "fc:". Recomputes isControl/route/currentSlug fresh from the pending card's
        // own threadId rather than trusting anything cached from when the card was first posted -
        // the topic's routing could have changed (e.g. the session was `/kill`ed) in the minutes
        // the card sat waiting for a tap, and dispatchInboundMessage already handles an
        // unrecognised/dead currentSlug the same way a live message would.
        const staleConfirmAction = callbackQuery.data ? resolveStaleConfirmCallback(callbackQuery.data) : null;
        if (staleConfirmAction) {
          const pending = staleConfirmRegistry.resolve(staleConfirmAction.id);
          if (!pending) return;
          if (!staleConfirmAction.confirmed) {
            void finalizeStaleConfirmMessage(pending, "Cancelled - not actioned.");
            return;
          }
          void finalizeStaleConfirmMessage(pending, "✅ Confirmed - processing now.");
          const pendingIsControl = isControlTopic(pending.threadId);
          const pendingRoute = pending.threadId !== undefined ? routing.getByTopicId(pending.threadId) : undefined;
          dispatchInboundMessage(pending.messageId, pending.rawText, pending.threadId, pendingIsControl, pendingRoute, pendingRoute?.slug, pending.from);
          return;
        }

        // Voice input's own confirm keyboard (voice-confirm.ts) - "vc:", a fresh namespace
        // alongside "sc:"/"fc:"/"d:". "Re-record"/"Type instead"/"Cancel" all discard the
        // transcript; they differ only in which follow-up text is shown, so all three fall into
        // the same finalize call below rather than needing separate registry/dispatch handling.
        const voiceConfirmAction = callbackQuery.data ? resolveVoiceConfirmCallback(callbackQuery.data) : null;
        if (voiceConfirmAction) {
          const pending = voiceConfirmRegistry.resolve(voiceConfirmAction.id);
          if (!pending) return;
          if (voiceConfirmAction.action === "send") {
            void finalizeVoiceConfirmMessage(pending, "✅ Sent.");
            const pendingIsControl = isControlTopic(pending.threadId);
            const pendingRoute = pending.threadId !== undefined ? routing.getByTopicId(pending.threadId) : undefined;
            dispatchInboundMessage(pending.messageId, pending.transcript, pending.threadId, pendingIsControl, pendingRoute, pendingRoute?.slug, pending.from);
            return;
          }
          const doneText =
            voiceConfirmAction.action === "rerecord"
              ? "🔁 Discarded - send another voice note whenever you're ready."
              : voiceConfirmAction.action === "type"
                ? "✏️ Discarded - go ahead and type it."
                : "❌ Cancelled.";
          void finalizeVoiceConfirmMessage(pending, doneText);
          return;
        }

        // `/voice`'s own model-picker keyboard (voice-model.ts) - "vm:", a fresh namespace
        // alongside "vc:"/"d:"/"sc:"/"fc:". Re-scans the model list rather than reusing whatever
        // was on disk when the button was posted - see applyVoiceModelSwitch's own doc comment.
        const voiceModelName = callbackQuery.data ? resolveVoiceModelCallback(callbackQuery.data) : null;
        if (voiceModelName && voiceServer) {
          const voiceDir = path.dirname(config.voice.modelPath);
          const models = listAvailableVoiceModels(voiceDir);
          const currentName = path.basename(voiceServer.currentModelPath()).replace(/^ggml-/, "").replace(/\.bin$/, "");
          void applyVoiceModelSwitch(threadId, voiceModelName, voiceDir, models, currentName);
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

        // `/about`'s "more info" buttons ("about:") - a fresh namespace alongside "run:"/"perm:"/
        // etc.; unlike those, there's nothing to resolve against a registry (every topic's text
        // is static), so this just looks the id up and sends it. `/about` itself works from the
        // control topic's own default ("General") topic, which carries no `message_thread_id` at
        // all - unlike `resolveCommandAction`'s buttons (session-scoped only, so threadId is
        // always defined there), threadId being undefined here is the normal case, not an error;
        // `sendMessage` already accepts it the same way the `/about` dispatch path above does.
        const aboutTopicId = callbackQuery.data ? resolveAboutCallback(callbackQuery.data) : null;
        if (aboutTopicId) {
          const topic = ABOUT_TOPICS[aboutTopicId];
          if (!topic) return;
          controlBot
            .sendMessage(config.supergroupChatId, threadId, topic.details)
            .catch((err) => log("WARN", `sendMessage (about detail) failed: ${(err as Error).message}`));
          return;
        }

        const action = callbackQuery.data ? resolveCommandAction(callbackQuery.data) : null;
        if (!action || threadId === undefined) return;
        // "Commands (N)"/"Skills (N)" - answered directly, like /help/`/commands`/`/skills`
        // themselves; this is "list them as text," not something to forward into the PTY/channel.
        if (action.kind === "show_commands") {
          const text = renderCommandsListText(currentRoute ? listRepoCommands(currentRoute.worktreePath) : []);
          controlBot.sendMessage(config.supergroupChatId, threadId, text).catch((err) => log("WARN", `sendMessage (show commands) failed: ${(err as Error).message}`));
          return;
        }
        if (action.kind === "show_skills") {
          const text = renderSkillsListText(currentRoute ? listRepoSkills(currentRoute.worktreePath) : []);
          controlBot.sendMessage(config.supergroupChatId, threadId, text).catch((err) => log("WARN", `sendMessage (show skills) failed: ${(err as Error).message}`));
          return;
        }
        if (currentSlug) sendRaw(currentSlug, `/${action.name}`);
        return;
      }

      const message = update.message;
      if (!message) return;
      if (String(message.chat.id) !== config.supergroupChatId) return;

      const threadId = message.message_thread_id;
      const isControl = isControlTopic(threadId);
      const route = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
      const currentSlug = route?.slug;
      // Neither the control topic nor a topic this Bridge recognises as a session - ignore.
      if (!isControl && !route) return;

      const from = message.from?.username ?? message.from?.first_name ?? "unknown";

      // Voice input - a recorded voice note, not a forwarded/uploaded audio file (message.audio,
      // unhandled). Goes through its own confirm-card path (handleVoiceMessage), never the
      // stale-inbound check below: staleness of the *card* (voice-confirm.ts's own TTL) is what
      // matters, not staleness of when the note was recorded.
      if (message.voice) {
        void handleVoiceMessage(message.voice, threadId, message.message_id, from);
        return;
      }

      // §5.6: photos/documents/videos/audio/video-notes - landed in the session's inbox and
      // announced by path rather than transcribed. `photo` arrives as one entry per resolution,
      // smallest to largest; the largest is the one worth downloading. Telegram allows a message
      // to carry at most one kind of media, so these are mutually exclusive with each other and
      // with `voice`/`text` above - order here doesn't matter beyond that.
      if (message.photo && message.photo.length > 0) {
        const largest = message.photo[message.photo.length - 1]!;
        void handleAttachmentMessage("image", largest.file_id, largest.file_size, undefined, undefined, threadId, route, isControl, message.message_id, message.caption, from);
        return;
      }
      if (message.document) {
        const doc = message.document;
        void handleAttachmentMessage("document", doc.file_id, doc.file_size, doc.file_name, doc.mime_type, threadId, route, isControl, message.message_id, message.caption, from);
        return;
      }
      if (message.video) {
        const video = message.video;
        void handleAttachmentMessage("video", video.file_id, video.file_size, video.file_name, video.mime_type, threadId, route, isControl, message.message_id, message.caption, from);
        return;
      }
      if (message.audio) {
        const audio = message.audio;
        void handleAttachmentMessage("audio", audio.file_id, audio.file_size, audio.file_name, audio.mime_type, threadId, route, isControl, message.message_id, message.caption, from);
        return;
      }
      if (message.video_note) {
        const note = message.video_note;
        void handleAttachmentMessage("video note", note.file_id, note.file_size, undefined, undefined, threadId, route, isControl, message.message_id, message.caption, from);
        return;
      }

      if (!message.text) return;

      // §7.4: a backlog burst on resume (Telegram queues updates for 24h while the Bridge is
      // down/asleep) can replay a command typed long ago - confirm rather than act on anything
      // older than 30 minutes, exactly as an operator would want "yes, push it" treated after
      // finding it hours later. Checked before any command parsing so nothing below ever sees a
      // stale message directly.
      const nowMs = Date.now();
      if (isStaleInbound(message.date, nowMs)) {
        void postStaleConfirm(threadId, message.message_id, message.text, from, formatStaleAge(message.date, nowMs));
        return;
      }

      dispatchInboundMessage(message.message_id, message.text, threadId, isControl, route, currentSlug, from);
    },
    onError: (err) => {
      log("WARN", `getUpdates failed, retrying: ${(err as Error).message}`);
    },
  });

  log("INFO", "Bridge started - getUpdates loop running");
}

await main();
