import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import type * as pty from "node-pty";
import { resolveAskCallback, renderAskAnsweredCard, renderAskCancelledCard } from "./ask-callback.ts";
import { ABOUT_TOPICS, buildAboutKeyboard, isAboutCommand, renderAbout, resolveAboutCallback } from "./about.ts";
import { buildCreateArgs, buildDeleteArgs, buildFixTaskSettingsScript, buildQueryArgs, buildRunArgs, parseQueryOutput, renderAutostartStatus, TASK_NAME } from "./autostart.ts";
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
import { initFileLogging, log } from "./logger.ts";
import {
  clearDeployMarker,
  deployBranch,
  discoverTypecheckedPackages,
  isDeployMarkerStale,
  isSelfRepo,
  readDeployMarker,
  resolveBridgeRepoRoot,
  rollbackStaleDeploy,
  truncateForTelegram,
  writeDeployMarker,
} from "./deploy.ts";
import { parseDetailsCallback } from "./details-button.ts";
import { DetailsAnchorStore, DETAILS_ANCHOR_RETENTION_MS } from "./details-anchor-store.ts";
import {
  attachmentKindLabel,
  buildAttachmentAnnouncement,
  guessAttachmentFilename,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  writeAttachmentToInbox,
} from "./attachment-inbox.ts";
import type { AttachmentKind } from "./attachment-inbox.ts";
import { buildVoiceModelKeyboard, listAvailableVoiceModels, resolveVoiceModelCallback } from "./voice-model.ts";
import {
  BrowseRegistry,
  buildDirKeyboard,
  buildFileActionKeyboard,
  buildHitsKeyboard,
  parseBrowseCommand,
  parseDiffCommand,
  parseFindCommand,
  renderDirText,
  renderHitsText,
  resolveBrowseCallback,
} from "./browse-nav.ts";
import { listDirectory, MAX_SEND_BYTES, prepareFileForSend, readForPreview, resolveGithubLink, searchWorktree } from "./worktree-fs.ts";
import { buildDiffReview, cleanupDiffRefs } from "./diff-review.ts";
import { buildFleetConfirmKeyboard, FleetConfirmRegistry, resolveFleetConfirmCallback } from "./fleet-confirm.ts";
import type { PendingFleetConfirm } from "./fleet-confirm.ts";
import { formatStaleAge, hasAttachment, isStaleInbound } from "./stale-inbound.ts";
import { buildStaleConfirmKeyboard, resolveStaleConfirmCallback, StaleConfirmRegistry } from "./stale-confirm.ts";
import { buildVoiceConfirmKeyboard, resolveVoiceConfirmCallback, VoiceConfirmRegistry } from "./voice-confirm.ts";
import { startWhisperServer, transcribeVoiceNote } from "./voice-transcribe.ts";
import { buildNlConfirmKeyboard, NlConfirmRegistry, resolveNlConfirmCallback } from "./nl-confirm.ts";
import { isRetryPhrase, retryTopicKey, RetryStore } from "./retry-store.ts";
import { buildContextPrefix } from "./message-context.ts";
import type { MessageOrigin } from "./message-context.ts";
import { ChannelConnectCoordinator } from "./channel-connect-coordinator.ts";
import { routeText } from "./nl-router.ts";
import type { RouterAction } from "./nl-router.ts";
import { SettingsStore } from "./settings-store.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import {
  botCommandList,
  isKnownCommandText,
  isHelpCommand,
  buildLsDetail,
  newSessionContent,
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
import { renderDetails, renderDetailsPlainText } from "./feed-renderer.ts";
import { monotonicNowMs } from "./monotonic-clock.ts";
import { CostTracker, FIVE_HOURS_MS, ONE_WEEK_MS } from "./cost-tracker.ts";
import { CostStore } from "./cost-store.ts";
import { checkConcurrencyCap, currentUnits, WEIGHTED_CAP } from "./concurrency-cap.ts";
import { startOtlpListener } from "./otlp-listener.ts";
import { resolvePermCallback } from "./permission-callback.ts";
import { sweepExpiredPermissions } from "./permission-registry.ts";
import {
  addRepoEntry,
  cloneRepo,
  inferDefaultRepoPath,
  isGitUrl,
  loadReposRegistry,
  removeRepoEntry,
  resolveRepoNameFuzzy,
  type ReposRegistry,
} from "./repos-registry.ts";
import { launchSession, resolveNodeExecutable, stripAnsi } from "./session-launcher.ts";
import { startPipeServer } from "./pipe-server.ts";
import { RateGovernor } from "./rate-governor.ts";
import { deriveAlwaysRule, ruleAlreadyCovered } from "./rule-derivation.ts";
import { Routing } from "./routing.ts";
import {
  buildDefaultCategoryKeyboard,
  buildDefaultEffortKeyboard,
  buildDefaultModeKeyboard,
  buildEffortKeyboard,
  buildModeKeyboard,
  buildModeKeystrokes,
  buildModelKeyboard,
  DEFAULT_EFFORT,
  DEFAULT_MODE,
  EFFORTS,
  isDefaultCategoryCancelCallback,
  isDefaultEffortCancelCallback,
  isDefaultModeCancelCallback,
  isEffortCancelCallback,
  isModeCancelCallback,
  isModelCancelCallback,
  isSessionCommandAttempt,
  MODELS,
  MODES,
  parseSessionCommand,
  resolveDefaultCategoryCallback,
  resolveDefaultEffortCallback,
  resolveDefaultModeCallback,
  resolveEffortCallback,
  resolveModeCallback,
  resolveModelCallback,
} from "./session-commands.ts";
import type { DefaultCategory, Effort, Mode, Model, SessionCommand } from "./session-commands.ts";
import { formatUsagePanel } from "./usage-panel.ts";
import { SessionStore, type SessionRow, type SessionState } from "./session-store.ts";
import { looksEnglishEnough } from "./language-heuristic.ts";
import { slugFromPrompt, uniqueSlug } from "./slug.ts";
import { addAlwaysRule, readSettingsFile, writeSettingsFile } from "./settings.ts";
import { buildTopicDeepLink, startPolling, TelegramClient, validateTokens } from "./telegram.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";
import { loadOffset, saveOffset } from "./telegram-offset.ts";
import { createThinkingPlaceholder } from "./thinking-placeholder.ts";
import { createTypingIndicator } from "./typing-indicator.ts";
import { restartSettleDelayMs } from "./restart-settle.ts";
import { removeWorktree } from "./worktree.ts";
import { createSessionSupervisor } from "./session-supervisor.ts";
import { createPtyIo, DEFAULT_ECHO_SETTLE_MS, DEFAULT_SUBMIT_CONFIRM_WINDOW_MS } from "./pty-io.ts";
import { createFeedWiring } from "./feed-wiring.ts";
import { createQuotaAlarms, DEFAULT_BURN_RATE_THRESHOLD_USD } from "./quota-alarms.ts";
import { createConfirmCards } from "./confirm-cards.ts";

// §7.2's Task Scheduler stdout/stderr gap (logger.ts's own doc comment has the full story): a
// launch that predates `main()` itself getting to run - a bad env file, a throw during module
// load - still deserves a line in the real log file, so the sink is initialized and the crash
// handlers are installed at module scope, not inside `main()`.
initFileLogging(STATE_DIR);
process.on("uncaughtException", (err) => {
  log("ERROR", `uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("ERROR", `unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  process.exit(1);
});

/** §4.1: topic 1 (the implicit "General" topic) is the control topic - real Telegram omits
 * `message_thread_id` entirely for a General-topic message, so both `undefined` and the literal
 * `1` (the stub server's convention) count. */
function isControlTopic(threadId: number | undefined): boolean {
  return threadId === undefined || threadId === 1;
}

async function main(): Promise<void> {
  // restart-settle.ts: unset until this boot's own reconciliation has resumed every live session -
  // the stale-deploy rollback just below can respawn before that point, and has nothing of this
  // boot's own to protect yet, so `respawnSelfAndExit` treats "still undefined" as "go immediately".
  let bootReadyAt: number | undefined;

  const config = loadConfig();
  const baseUrl = process.env.AIBRIDGE_TELEGRAM_BASE_URL; // integration tests point this at the stub

  const controlBot = new TelegramClient(config.controlBotToken, baseUrl);
  const feedBot = new TelegramClient(config.feedBotToken, baseUrl);

  await validateTokens(controlBot, feedBot);
  log("INFO", "both bot tokens validated via getMe");

  // §5.9's crash-loop safety net for `/deploy`'s self-restart path: a marker written just before
  // the *previous* boot attempt's self-respawn that is still here, and old enough that this boot
  // clearly isn't that same attempt continuing (§7's Task Scheduler restart cadence), means the
  // deployed commit never reached "started cleanly" (see the marker-clearing call near the end of
  // `main()`) - roll the repo back on our own rather than crash-looping forever with no way to say
  // so. A fresh marker (this boot IS that attempt) is left alone here and consumed later instead.
  {
    const marker = readDeployMarker(STATE_DIR);
    if (marker && isDeployMarkerStale(marker, Date.now())) {
      log("WARN", `deploy marker for "${marker.branch}" is stale - Bridge never started cleanly after that deploy, rolling back to ${marker.previousHeadSha.slice(0, 8)}`);
      const reset = await rollbackStaleDeploy(marker);
      clearDeployMarker(STATE_DIR);
      if (reset.status === 0) {
        try {
          await controlBot.sendMessage(
            marker.chatId,
            marker.topicId,
            `⚠️ Deploy of "${marker.branch}" didn't come back up cleanly - rolled back to ${marker.previousHeadSha.slice(0, 8)} and restarting again.`,
          );
        } catch (err) {
          log("WARN", `failed to send deploy-rollback notice: ${(err as Error).message}`);
        }
        await respawnSelfAndExit();
      } else {
        log("ERROR", `deploy rollback itself failed (${reset.stderr || reset.stdout}) - continuing this boot on whatever commit is on disk`);
      }
    }
  }

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
  const selfCheckWorktreesRoot = process.env.SELF_CHECK_WORKTREES_ROOT ?? path.join(config.selfCheck.repoPath, ".worktrees");
  const selfCheckWorktreePath = path.join(selfCheckWorktreesRoot, config.selfCheck.slug);
  const fleetWorktreesRoot = process.env.AIBRIDGE_WORKTREES_ROOT;

  const routing = new Routing();
  routing.add({ slug: config.selfCheck.slug, topicId: config.selfCheck.topicId, worktreePath: selfCheckWorktreePath });

  const nowIso = () => new Date().toISOString();

  const dbPath = process.env.AIBRIDGE_DB_PATH ?? path.join(STATE_DIR, "aibridge.db");
  const sessionStore = new SessionStore(dbPath);
  // nl-router.ts's confirm gate (nl-confirm.ts) - a fleet-wide preference, not per-session, same
  // reasoning `/budget`/`/settings` staying control-topic-only already established. Lives in the
  // same aibridge.db file, not a second database (settings-store.ts).
  const settingsStore = new SettingsStore(dbPath);
  // §5.5's details-button edit-in-place (details-anchor-store.ts) - same aibridge.db file, same
  // reasoning as settingsStore above.
  const detailsAnchorStore = new DetailsAnchorStore(dbPath);
  let assistEnabled = settingsStore.get("assist_enabled", "true") !== "false";
  // Live override for config.ts's nlRouter.backend startup default - see that field's own doc
  // comment for why an API key's mere presence must never switch this on its own. Falls back to
  // the config default (always "cli" unless NL_ROUTER_BACKEND=api) when nothing's been switched
  // live yet.
  let nlRouterBackend: "api" | "cli" = settingsStore.get("nl_router_backend", config.nlRouter.backend) === "api" ? "api" : "cli";
  // voice-confirm.ts's own confirm-before-send gate - same "fleet-wide, persisted, in-memory for
  // reads" shape as assistEnabled above. Default on: Whisper's accuracy varies enough by language
  // that skipping the review step should be an explicit opt-in, not the out-of-the-box behavior.
  let voiceConfirmEnabled = settingsStore.get("voice_confirm_enabled", "true") !== "false";
  // `/defaultmode` - the permission mode every *new* session starts in, before its own first turn
  // (handleNewCommand below). Same in-memory-for-reads, persisted-on-write shape as the two above.
  // Falls back to DEFAULT_MODE ("manual", the CLI's own real spawn default) if the stored value is
  // ever something MODES no longer recognises (a downgrade after a value was added then removed,
  // say) - same defensive re-validation `isModel`/`isMode`/`isEffort` already apply to callback data.
  let defaultSessionMode: Mode = (() => {
    const stored = settingsStore.get("default_session_mode", DEFAULT_MODE);
    return (MODES as readonly string[]).includes(stored) ? (stored as Mode) : DEFAULT_MODE;
  })();
  // `/defaulteffort` - same in-memory-for-reads, persisted-on-write, re-validated-on-load shape as
  // defaultSessionMode above.
  let defaultSessionEffort: Effort = (() => {
    const stored = settingsStore.get("default_session_effort", DEFAULT_EFFORT);
    return (EFFORTS as readonly string[]).includes(stored) ? (stored as Effort) : DEFAULT_EFFORT;
  })();
  if (!sessionStore.get(config.selfCheck.slug)) {
    sessionStore.insert({
      slug: config.selfCheck.slug,
      topicId: config.selfCheck.topicId,
      sessionId: null,
      worktreePath: selfCheckWorktreePath,
      branch: `claude/${config.selfCheck.slug}-1`,
      repoPath: config.selfCheck.repoPath,
      model: "sonnet",
      ptyPid: 0,
      state: "starting",
      turnCardMsg: null,
      paused: false,
      renamed: false,
      feedDetail: "compact",
      feedVerbose: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });
  }

  // §5.7/§10.5 (added 2026-08-04): cost tracking is strictly read-only input, same guarantee as the
  // rest of telemetry - a listener failure degrades /ls and /budget and nothing else. Port is
  // overridable for symmetry with the other AIBRIDGE_* dev overrides, though nothing in the test
  // suite currently spawns a full Bridge process that would need it.
  const otlpPort = Number(process.env.AIBRIDGE_OTLP_PORT ?? 4318);
  // Same aibridge.db file as sessionStore/settingsStore (dbPath above) - see cost-store.ts's own
  // doc comment for why this is injected rather than imported directly into cost-tracker.ts.
  const costStore = new CostStore(dbPath);
  const costTracker = new CostTracker(costStore);

  // §5.1-§5.4: one shared governor across both the feed bot's droppable P2 lane (§9 scenarios
  // 14-18 are unit-tested against rate-governor.ts/feed-coalescer.ts directly) and every P1 fleet
  // notice - used directly here and passed into quota-alarms.ts/feed-wiring.ts below.
  const feedGovernor = new RateGovernor({ log });

  // quota-alarms.ts: §10.5's usage-limit/burn-rate guardrails. `feedGovernor` is passed as a shared
  // reference (composition root owns it, used pervasively for other P1 sends elsewhere in this
  // file), same convention as feed-wiring.ts's own construction.
  const quotaAlarms = createQuotaAlarms({
    sessionStore,
    costTracker,
    feedGovernor,
    controlBot,
    supergroupChatId: config.supergroupChatId,
    burnRateThresholdUsd: Number(process.env.AIBRIDGE_BURN_RATE_THRESHOLD_USD ?? DEFAULT_BURN_RATE_THRESHOLD_USD),
    log,
  });

  // pty-io.ts's lost-Enter detector (found 2026-08-04) - real activity (spinner frames etc.) redraws
  // well within a couple of seconds, confirmed live, so this is generous rather than tight. Read
  // here (composition root owns env/config loading) and passed through as options below.
  const submitConfirmWindowMs = Number(process.env.AIBRIDGE_SUBMIT_CONFIRM_WINDOW_MS ?? DEFAULT_SUBMIT_CONFIRM_WINDOW_MS);
  // How long the write's own echo takes to land, confirmed live to be well under 500ms - the
  // baseline for the lost-Enter check is taken after this, not at the moment of the write itself.
  const echoSettleMs = Number(process.env.AIBRIDGE_ECHO_SETTLE_MS ?? DEFAULT_ECHO_SETTLE_MS);

  startOtlpListener({
    port: otlpPort,
    log,
    onApiRequest: (event) => {
      costTracker.record(event.sessionId, event.atMs, event.costUsd);
      quotaAlarms.maybeFireBurnRateAlarm(event.atMs);
    },
    onApiError: (event) => {
      const slug = quotaAlarms.slugForSessionId(event.sessionId);
      if (slug) quotaAlarms.markQuotaStopped(slug);
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

  // `/kill --all` and `/rm --all` (§4.2, added 2026-08-04) - the only fleet commands that can act
  // on every live session at once, so they go through the same confirm-button pattern as a
  // permission prompt instead of executing on the same message (fleet-confirm.ts).
  const fleetConfirmRegistry = new FleetConfirmRegistry();
  const staleConfirmRegistry = new StaleConfirmRegistry();
  // Voice input (self-hosted Whisper via whisper.cpp) - a transcribed voice note is never
  // dispatched directly, only replayed from a tap on its own Send/Re-record/Type-instead card
  // (voice-confirm.ts), same shape as the stale-inbound confirm above.
  const voiceConfirmRegistry = new VoiceConfirmRegistry();
  // nl-router.ts's destructive-command confirm gate (nl-confirm.ts) - own registry, same
  // add/resolve-pops-and-checks-TTL shape as fleetConfirmRegistry/voiceConfirmRegistry above.
  const nlConfirmRegistry = new NlConfirmRegistry();
  // §4.2's `/retry` (retry-store.ts): the single most recently *expired* nl-confirm per topic, so
  // it can be re-armed without retyping/re-saying the original request. Populated only where an
  // nl-confirm entry actually expires (the sweep below, and the tap-loses-the-race path further
  // down) - never on a cancel/run, which already has its own explicit outcome.
  const retryStore = new RetryStore();

  // confirm-cards.ts: the four confirm-card protocols' (fleet/stale/voice/nl) shared finalize/
  // expire/take-or-notify-gone logic - `feedGovernor` passed as a shared reference, same convention
  // as quota-alarms.ts/feed-wiring.ts above.
  const confirmCards = createConfirmCards({
    controlBot,
    feedGovernor,
    supergroupChatId: config.supergroupChatId,
    retryStore,
    log,
  });

  // `/browse`/`/find`'s own id-per-row registry (browse-nav.ts) - unlike the confirm registries
  // above, entries here are non-consuming (a folder's Prev/Next can be tapped repeatedly) and never
  // store a messageId - a tap edits whichever message it came from, read straight off the callback.
  const browseRegistry = new BrowseRegistry();
  const voiceServer = config.voice.enabled ? startWhisperServer(config.voice, log) : null;

  // Two independent, cheap "Claude is working on this" signals, kept side by side rather than
  // choosing one: `sendChatAction` renders correctly on mobile clients but Telegram Desktop has a
  // known bug (tdesktop#30452) that only shows it in the topics overview, not inside the open
  // topic - so the message-based placeholder covers desktop, and the reply landing is what stops
  // (or, for the placeholder, edits away) both of them.
  const typingIndicator = createTypingIndicator({
    // On the *feed* bot, through the governor's droppable P2 lane. §5.4 point 2 is explicit that
    // every API method counts against its token's budget, and one active turn fires this ~15 times
    // a minute - as an ungoverned direct call on the control bot it was invisible to the very
    // accounting that decides whether a permission card can be sent, so real 429s landed on P0
    // cards while the governor believed the budget was free. Charging it to the feed bucket is only
    // honest if it *is* feed-bot traffic, hence the token swap too; the feed bot is already this
    // topic's "here's what's happening" identity, and a missed typing frame is worth nothing once
    // the next one is due - exactly the P2 contract.
    send: (topicId) => {
      feedGovernor.schedule("P2", () => feedBot.sendChatAction(config.supergroupChatId, Number(topicId), "typing"));
      return Promise.resolve();
    },
    log: (level, message) => log(level, message),
  });
  const thinkingPlaceholder = createThinkingPlaceholder({
    send: async (topicId) => {
      const sent = await controlBot.sendMessage(config.supergroupChatId, Number(topicId), "🤔 Thinking...");
      return sent.message_id;
    },
    log: (level, message) => log(level, message),
  });

  // The deterministic half of `/new`'s first-write race (§4.5's dev-channels dialog is the other
  // half, handled in `session-launcher.ts`): a slug can have at most one pending waiter at a time,
  // since nothing writes a session's first message before it's even launched. Delegated to
  // `ChannelConnectCoordinator` rather than a plain waiter map - confirmed live 2026-08-07
  // ("check-what-is-left-to") that a fast-connecting channel can complete its handshake before this
  // function even gets called, silently losing the resolve on a plain map with no way to represent
  // "this already happened"; see that module's own doc comment for the full story.
  const channelConnectCoordinator = new ChannelConnectCoordinator();

  /** Resolves once the channel server for `slug` has completed its MCP handshake with this Claude
   * Code process, or after `timeoutMs` if it never does (a misconfigured `.mcp.json`, say) - a
   * caller that needs this settled before writing must not wedge forever over a signal that never
   * arrives. Replaces a guessed fixed delay after the dev-channels dialog (confirmed live
   * 2026-08-04 to be unreliable) with the real event that delay was standing in for. */
  async function waitForChannelConnected(slug: string, timeoutMs = 15_000): Promise<void> {
    const connected = await channelConnectCoordinator.waitFor(slug, timeoutMs);
    if (!connected) log("WARN", `timed out waiting for the channel server to connect for "${slug}" - proceeding anyway`);
  }

  // `/usage` (§4.2, added 2026-08-04): a slug can have at most one pending capture at a time - a
  // second `/usage` for the same slug while one is already in flight would garble both buffers, so
  // a concurrent request is refused up front (see `requestUsagePanel`). It used to *overwrite* the
  // waiter, which was not the "last request wins" the comment claimed: the first request's timer
  // resolved the first promise with the second request's buffer and then deleted the map entry, so
  // the second promise never settled at all - `/usage` simply never replied, and the awaiting frame
  // leaked.
  const usageWaiters = new Map<string, { buffer: string; check: () => void }>();

  // §12 Phase 5's session supervisor (session-supervisor.ts): PTY liveness tracking, startup
  // reconciliation (§4.5), and the crash-resume loop. Owns ptyProcessBySlug/resumeAttempts/
  // lastPtyActivityBySlug - everything else reaches them only through the accessors below.
  // `confirmSessionCommand` is a hoisted function declaration (defined further down in this same
  // scope) - referencing it here is safe, since JS hoists the whole declaration, not just the name.
  const sessionSupervisor = createSessionSupervisor({
    sessionStore,
    routing,
    controlBot,
    confirmSessionCommand,
    supergroupChatId: config.supergroupChatId,
    selfCheckSlug: config.selfCheck.slug,
    otlpPort,
    log,
    usageWaiters,
  });

  // pty-io.ts: PTY write primitives, the lost-Enter detector, and its wedged-session auto-recovery.
  // Depends on sessionSupervisor's liveness accessors (constructed just above) rather than owning
  // any PTY-tracking state itself.
  const ptyIo = createPtyIo({
    routing,
    typingIndicator,
    thinkingPlaceholder,
    lastActivityAt: sessionSupervisor.lastActivityAt,
    ptyLookup: { get: (slug) => sessionSupervisor.getPtyProcess(slug) },
    log,
    submitConfirmWindowMs,
    echoSettleMs,
  });

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
      if (usageWaiters.has(slug)) {
        resolve(`A /usage capture for "${slug}" is already in flight - the reply to that one is on its way.`);
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

  // feed-wiring.ts: the hook-event -> feed-card rendering pipeline, the details-button anchor, and
  // the hook-driven half of the state table. Constructed *before* `pipeHandle` (needs
  // `feedWiring.handleHookEvent` as its `onHookEvent`), so the three `resolveByToolMatch`/
  // `sendVerdict`/`finalizePermissionMessage` closures below reference `pipeHandle` ahead of its
  // own declaration - safe, since none of them run until a real hook event arrives, well after
  // `pipeHandle` is assigned (same deferred-closure pattern `confirmSessionCommand` already uses
  // above).
  const feedWiring = createFeedWiring({
    sessionStore,
    routing,
    detailsAnchorStore,
    feedGovernor,
    controlBot,
    feedBot,
    supergroupChatId: config.supergroupChatId,
    confirmSessionCommand,
    markQuotaStopped: quotaAlarms.markQuotaStopped,
    resolveByToolMatch: (slug, toolName, toolInput) => pipeHandle.permissionRegistry.resolveByToolMatch(slug, toolName, toolInput),
    sendVerdict: (slug, requestId, behavior) => pipeHandle.sendVerdict(slug, requestId, behavior),
    finalizePermissionMessage: (messageId, text) => pipeHandle.finalizePermissionMessage(messageId, text),
    log,
  });

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
    // Live-observed 2026-08-07: a reply routinely landed in its topic *before* the "working..."
    // feed card describing the tool calls it was actually summarising - the P1 reply lane is
    // deliberately unthrottled (§5.4) while the feed card sits behind FeedCoalescer's own
    // several-second interval. `reset` (already the turn-boundary flush) forces whatever's pending
    // for this slug to flush right before the reply's own send - and since 0.97.0, `reset`'s return
    // (via `onFlush` below, now itself promise-returning) is a promise `pipe-server.ts` actually
    // awaits (bounded by its own timeout), not just a fire-and-forget head start.
    onBeforeReply: (slug) => feedWiring.resetCoalescer(slug),
    onReplySent: (topicId, text) => {
      typingIndicator.stop(topicId);
      // §4.4's rename-once: the first real reply upgrades the topic off its provisional
      // `/new`-prompt title, capped so a later reply never renames it again.
      const row = sessionStore.getByTopicId(Number(topicId));
      if (row && !row.renamed) {
        sessionStore.setRenamed(row.slug); // marked regardless - a one-shot decision, not a retry loop
        // The reply may now be in the operator's own language (the language-mirroring system
        // prompt), but the topic title is meant to stay a stable English label like the
        // slug/worktree/branch already do - so a reply that isn't English enough leaves the topic
        // on its original /new-derived (English) title instead of flipping it to another script.
        if (looksEnglishEnough(text)) {
          controlBot
            .editForumTopic(config.supergroupChatId, Number(topicId), text.slice(0, 128) || row.slug)
            .catch((err: unknown) => log("WARN", `editForumTopic (rename-once) failed for "${row.slug}": ${(err as Error).message}`));
        }
      }
    },
    onHookEvent: feedWiring.handleHookEvent,
    onAwaitingInput: (slug) => feedWiring.maybeSetState(slug, "awaiting_input"),
    onChannelConnected: (slug) => {
      channelConnectCoordinator.onConnected(slug);
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
    browseRegistry.sweep();

    // §5.5's edit-in-place anchor: rows for a button that's never tapped at all (the common case)
    // would otherwise grow the table by one per turn, forever - see details-anchor-store.ts's own
    // comment on why this window is much longer than cost-store.ts's.
    detailsAnchorStore.deleteOlderThan(Date.now() - DETAILS_ANCHOR_RETENTION_MS);

    // §6.5's "a stale button must not look tappable and silently do nothing", applied to the four
    // operator-confirm cards too: past their TTL, strip the keyboard and say so. Doubles as the
    // sweep these four never had - entries used to be dropped only by a tap, so an untapped card
    // (and its whole replay payload) leaked for the lifetime of the daemon.
    for (const entry of nlConfirmRegistry.takeExpired()) void confirmCards.markNlConfirmCardExpired(entry);
    for (const entry of fleetConfirmRegistry.takeExpired()) void confirmCards.markConfirmCardExpired(entry.messageId);
    for (const entry of staleConfirmRegistry.takeExpired()) void confirmCards.markConfirmCardExpired(entry.confirmCardMessageId);
    for (const entry of voiceConfirmRegistry.takeExpired()) void confirmCards.markConfirmCardExpired(entry.confirmCardMessageId);

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
    feedWiring.checkQuietMode();
  }, 60_000);

  if (process.env.AIBRIDGE_SKIP_LAUNCH !== "1") {
    const session = launchSession({
      slug: config.selfCheck.slug,
      topicId: config.selfCheck.topicId,
      repoPath: config.selfCheck.repoPath,
      worktreesRoot: selfCheckWorktreesRoot,
      mirrorPtyToConsole: process.env.AIBRIDGE_DEV_MIRROR_PTY === "1",
      otlpPort,
      log,
    });

    sessionSupervisor.wireSession(config.selfCheck.slug, session.ptyProcess, config.selfCheck.topicId);
    // Without this, the self-check row's ptyPid stays whatever it was set to on the row's one-time
    // insert above (0, since that always predates the first-ever launch) forever after - unlike
    // every fleet session, which gets this same call on each `resumeSession` relaunch (§4.5).
    // `reportOrphanProcesses` right below then matches live processes against rows by exact pid, so
    // a permanently-0 ptyPid means the self-check session's own freshly-launched process can never
    // match its own row - flagging its perfectly legitimate self-relaunch as an "orphan" on every
    // single restart (live-observed 2026-08-08, right after an operator-issued `/restart`).
    sessionStore.setPtyPid(config.selfCheck.slug, session.ptyProcess.pid ?? 0);

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
              const target = slug ? sessionSupervisor.getPtyProcess(slug) : session.ptyProcess;
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

  // §4.5's reconciliation (session-supervisor.ts): reports orphaned processes, reaps rows whose
  // Telegram topic was deleted while the Bridge was down, then resumes everything else live.
  if (process.env.AIBRIDGE_SKIP_LAUNCH !== "1") {
    await sessionSupervisor.runStartupReconciliation();
    // Unconditional, unlike reportOrphanProcesses'/reapRowsWithDeletedTopics' own messages above
    // (which only post when there's something to report) - /restart's own "...once it's back up"
    // message otherwise has no matching confirmation, so there was no way to tell a clean restart
    // (nothing to reconcile, nothing posted) apart from one that's still coming up or crashed.
    confirmSessionCommand(undefined, "✅ Bridge is back up.");
  }
  // restart-settle.ts: everything reconciliation just resumed is only milliseconds old from here -
  // `respawnSelfAndExit` waits out RESTART_SETTLE_MS from this point rather than firing immediately.
  bootReadyAt = Date.now();

  // §5.4's P1 lane: every fleet-command echo and session lifecycle notice this Bridge posts on
  // its own initiative funnels through here, so wiring it through the governor once covers all of
  // them - never delayed behind P2 feed traffic, itself never allowed to delay a P0 permission
  // prompt or question.
  function confirmSessionCommand(topicId: number | undefined, text: string, parseMode?: "HTML", keyboard?: InlineKeyboardMarkup): void {
    feedGovernor
      .scheduleAsync("P1", () => controlBot.sendMessage(config.supergroupChatId, topicId, text, keyboard, parseMode))
      .catch((err: unknown) => log("WARN", `failed to send command confirmation: ${(err as Error).message}`));
  }

  // Shared by the typed `/model foo` / `/mode bar` / `/effort baz` path and the button-tap path
  // (bare /model, /mode or /effort followed by a keyboard selection) - same switch, two triggers.
  function applyModelSwitch(slug: string, topicId: number, model: string): void {
    ptyIo.sendRaw(slug, `/model ${model}`);
    sessionStore.setModel(slug, model);
    confirmSessionCommand(topicId, `Switched ${slug} to ${model}`);
  }

  // Shared by applyModeSwitch (an operator-visible switch, with its own confirmation) and
  // handleNewCommand's `/defaultmode` application (silent - the new topic already gets its own
  // "Created ..." confirmation, and a second "Switched ... mode" message right after would just be
  // noise for something the operator already configured, not something they just asked for here).
  function writeModeKeystrokes(slug: string, mode: Mode): void {
    const current = routing.getMode(slug);
    const keystrokes = buildModeKeystrokes(current, mode);
    // Already at the target mode: no keystroke to send, and ptyIo.sendRaw("") would still submit a
    // spurious blank Enter at the prompt.
    if (keystrokes.length > 0) {
      routing.getPtyWrite(slug)?.(keystrokes);
    }
    routing.setMode(slug, mode);
  }

  function applyModeSwitch(slug: string, topicId: number, mode: Mode): void {
    writeModeKeystrokes(slug, mode);
    confirmSessionCommand(topicId, `Switched ${slug} to ${mode} mode`);
  }

  function applyEffortSwitch(slug: string, topicId: number, effort: Effort): void {
    ptyIo.sendEffortCommand(slug, effort);
    routing.setEffort(slug, effort);
    confirmSessionCommand(topicId, `Switched ${slug} to ${effort} effort`);
  }

  // ---- §4.2's fleet commands (Phase 5) ----

  async function handleNewCommand(cmd: Extract<FleetCommand, { kind: "new" }>, controlTopicId: number | undefined): Promise<void> {
    if (!reposRegistry) {
      confirmSessionCommand(controlTopicId, "No repos.toml registered yet - see §7.5.");
      return;
    }
    let repo = reposRegistry.get(cmd.repo);
    if (!repo) {
      // Voice-transcribed /new commands routinely mangle the repo name ("aibridge" heard back as
      // "eI-Bridge") before it ever reaches this codebase - fall back to the single unambiguous
      // fuzzy match (see resolveRepoNameFuzzy's own doc comment) rather than failing outright.
      const fuzzy = resolveRepoNameFuzzy(reposRegistry.all(), cmd.repo);
      if (fuzzy) {
        repo = fuzzy;
        confirmSessionCommand(controlTopicId, `Unknown repo "${cmd.repo}" - using closest match "${fuzzy.name}".`);
      } else {
        confirmSessionCommand(controlTopicId, `Unknown repo "${cmd.repo}". Registered: ${reposRegistry.names().join(", ") || "(none)"}`);
        return;
      }
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

    // The topic's own title is truncated to 128 chars (Telegram's forum-topic-name limit) and the
    // actual delivery further below is a raw PTY keystroke into Claude's context, not a Telegram
    // post - so without this, the topic opened straight into Claude's tool-call feed with no visible
    // record of what was actually asked for. Posted as a plain message (not `confirmSessionCommand`,
    // which targets `controlTopicId`) since this belongs in the new topic itself.
    confirmSessionCommand(topic.message_thread_id, newSessionContent(cmd));

    let session: ReturnType<typeof launchSession>;
    try {
      session = launchSession({
        slug,
        topicId: topic.message_thread_id,
        repoPath: repo.path,
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
    sessionSupervisor.wireSession(slug, session.ptyProcess, topic.message_thread_id);

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
      feedDetail: "compact",
      feedVerbose: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });

    // Deep-links straight into the new topic (buildTopicDeepLink's own doc comment) rather than
    // making the operator find it by hand in the topic list - a `url` button, so no round trip
    // through the Bridge and no callback-registry entry to track or ever expire.
    confirmSessionCommand(controlTopicId, `Created "${slug}" (${model}) in a new topic.`, undefined, {
      inline_keyboard: [[{ text: `↪️ Open "${slug}"`, url: buildTopicDeepLink(config.supergroupChatId, topic.message_thread_id) }]],
    });

    // Two independent gates, both real events rather than guessed delays: the dev-channels dialog
    // must be confirmed (`session.ready` - otherwise the write lands on the still-open dialog and
    // corrupts it, confirmed live 2026-08-04), and the channel server's own MCP handshake must have
    // completed (`waitForChannelConnected` - otherwise the write's trailing Enter can be silently
    // lost even with the dialog long since confirmed, also confirmed live 2026-08-04).
    await session.ready;
    await waitForChannelConnected(slug);
    // `/defaultmode`/`/defaulteffort`: applied before the initial prompt, not after, so the very
    // first turn already runs under the configured defaults rather than starting under the CLI's
    // own "manual"/"medium" spawn default and switching mid-turn. Silent (no confirmSessionCommand)
    // - see writeModeKeystrokes's own doc comment for why a second "Switched..." message here would
    // just be noise on top of the "Created ..." confirmation already sent above. Skipped entirely
    // when a default is still at the CLI's own spawn default, rather than relying on either write
    // being a harmless no-op at that value - unverified for `/effort`, and `routing.getMode`'s
    // default already assumes "manual" until the first real switch, so a same-value keystroke send
    // isn't even a true no-op, just zero `buildModeKeystrokes` steps.
    if (defaultSessionMode !== DEFAULT_MODE) writeModeKeystrokes(slug, defaultSessionMode);
    if (defaultSessionEffort !== DEFAULT_EFFORT) ptyIo.sendEffortCommand(slug, defaultSessionEffort);
    ptyIo.sendChannelText(slug, topic.message_thread_id, newSessionContent(cmd), "new-1", "telegram");
  }

  function handleLsCommand(topicId: number | undefined): void {
    const rows = sessionStore.all();
    const nowMs = Date.now();
    const costBySlug = new Map<string, number>();
    for (const row of rows) {
      if (row.sessionId) costBySlug.set(row.slug, costTracker.lifetimeSpend(row.sessionId));
    }
    const detailBySlug = buildLsDetail(rows, nowMs, monotonicNowMs(), feedWiring.allFeedStates(), pipeHandle.permissionRegistry.all(), pipeHandle.askRegistry.all());
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
    sessionSupervisor.killAndUntrack(slug);
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

  /** §7.4's stale-inbound path: posts the "received while offline, still want this?" card instead
   * of dispatching a backlog message directly, and registers the replay payload. Mirrors
   * `postFleetConfirm`'s shape exactly. */
  async function postStaleConfirm(threadId: number | undefined, messageId: number, rawText: string, from: string, ageLabel: string, origin: MessageOrigin): Promise<void> {
    const id = randomUUID().slice(0, 8);
    const preview = rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
    try {
      const sent = await controlBot.sendMessage(config.supergroupChatId, threadId, `⏳ received while offline (${ageLabel}) - still want this?\n\n${preview}`, {
        inline_keyboard: buildStaleConfirmKeyboard(id),
      });
      staleConfirmRegistry.add({ id, threadId, messageId, rawText, from, confirmCardMessageId: sent.message_id, origin });
    } catch (err) {
      log("WARN", `failed to post stale-inbound confirmation: ${(err as Error).message}`);
    }
  }

  /** §7.4 for the media paths: say so and stop, rather than landing a hours-old file in the
   * worktree and announcing it to a live session as if it had just arrived. */
  function notifyStaleAttachment(threadId: number | undefined, ageLabel: string): void {
    confirmSessionCommand(threadId, `⏳ An attachment arrived while offline (${ageLabel}) - not delivered. Re-send it if you still want it.`);
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
  async function handleVoiceMessage(
    voice: { file_id: string; duration: number },
    threadId: number | undefined,
    messageId: number,
    from: string,
    messageDate: number,
    origin: MessageOrigin,
  ): Promise<void> {
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
      const preview = text.length > 0 ? text : "(nothing recognised - try again?)";
      // An empty transcript always still shows the card, even with confirmation off - there's
      // nothing useful to auto-send, and re-record/type-instead are the only sensible next steps.
      // A *stale* note does the same: voice is exempt from §7.4's gate only because the confirm
      // card is itself the review step, so with confirmation off that justification disappears and
      // a note recorded hours ago would otherwise auto-send into a live session.
      const staleNote = isStaleInbound(messageDate, Date.now());
      if (voiceConfirmEnabled || text.length === 0 || staleNote) {
        const id = randomUUID().slice(0, 8);
        if (controlBot.editMessageText) {
          await feedGovernor.scheduleAsync("P1", () =>
            controlBot.editMessageText!(config.supergroupChatId, placeholderId!, `🎤 ${preview}`, { inline_keyboard: buildVoiceConfirmKeyboard(id) }),
          );
        }
        voiceConfirmRegistry.add({ id, threadId, messageId, transcript: text, from, confirmCardMessageId: placeholderId, origin });
        return;
      }
      // Confirmation is off - send straight through, but the transcript stays visible on the
      // finalized message (not just a bare "Sent") so there's still something to read before
      // deciding to flip /voiceconfirm back on.
      if (controlBot.editMessageText) {
        await feedGovernor.scheduleAsync("P1", () =>
          controlBot.editMessageText!(
            config.supergroupChatId,
            placeholderId!,
            `🎤 ${preview}\n\n✅ Auto-sent (confirmation off - /voiceconfirm on to review before sending).`,
            { inline_keyboard: [] },
          ),
        );
      }
      const autoIsControl = isControlTopic(threadId);
      const autoRoute = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
      void dispatchInboundMessage(messageId, text, threadId, autoIsControl, autoRoute, autoRoute?.slug, from, buildContextPrefix(origin));
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
    origin: MessageOrigin,
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
      void dispatchInboundMessage(messageId, announcement, threadId, isControl, route, route.slug, from, buildContextPrefix(origin));
    } catch (err) {
      log("WARN", `attachment download failed: ${(err as Error).message}`);
      confirmSessionCommand(threadId, `Couldn't download that ${kind} - try sending it again.`);
    }
  }

  /** Runs after a `/kill --all`/`/rm --all` confirm tap - re-looks-up rows by slug rather than
   * trusting a snapshot from when the confirm card was posted, since a session can die or get
   * removed independently in the minutes between posting and the tap. */
  async function executeFleetConfirm(pending: PendingFleetConfirm): Promise<void> {
    // §4.5.2's `rm-topic` variant has no session row at all - it acts on `pending.topicId`
    // directly, which is the only reason it was postable in the first place (no DB lookup).
    if (pending.kind === "rm-topic") {
      if (pending.topicId === undefined) {
        await confirmCards.finalizeFleetConfirmMessage(pending, "Nothing left to act on.");
        return;
      }
      try {
        await controlBot.deleteForumTopic(config.supergroupChatId, pending.topicId);
        await confirmCards.finalizeFleetConfirmMessage(pending, "Topic deleted.");
      } catch (err) {
        log("WARN", `deleteForumTopic failed for orphan topic ${pending.topicId}: ${(err as Error).message}`);
        await confirmCards.finalizeFleetConfirmMessage(pending, "Telegram would not delete this topic - it may need to be removed by hand (topic menu -> Delete Topic).");
      }
      return;
    }

    const rows = pending.slugs.map((s) => sessionStore.get(s)).filter((r): r is SessionRow => r !== undefined);
    let allTopicsDeleted = true;
    for (const row of rows) {
      if (pending.kind === "kill") {
        await killSessionRow(row);
      } else if (!(await removeSessionRow(row))) {
        allTopicsDeleted = false;
      }
    }
    const verb = pending.kind === "kill" ? "Killed" : "Removed";
    const note = pending.kind === "rm" && !allTopicsDeleted ? ORPHAN_TOPIC_NOTE : "";
    await confirmCards.finalizeFleetConfirmMessage(pending, rows.length === 0 ? "Nothing left to act on." : `${verb} ${rows.length} session${rows.length === 1 ? "" : "s"}: ${rows.map((r) => r.slug).join(", ")}${note}`);
  }

  /** `/kill --all --force`/`/rm --all --force` (operator-requested 2026-08-08): the same teardown
   * `executeFleetConfirm` runs after a button tap, just triggered on the same message instead of
   * behind a posted Yes/No card - the operator has already decided and doesn't want to round-trip a
   * tap. Posts the same summary text a tapped card would have finalized to, just as a plain reply
   * since there's no card here to finalize. */
  async function executeFleetActionDirect(kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[]): Promise<void> {
    if (targets.length === 0) {
      confirmSessionCommand(topicId, kind === "kill" ? "No live sessions to kill." : "No sessions to remove.");
      return;
    }
    let allTopicsDeleted = true;
    for (const row of targets) {
      if (kind === "kill") {
        await killSessionRow(row);
      } else if (!(await removeSessionRow(row))) {
        allTopicsDeleted = false;
      }
    }
    const verb = kind === "kill" ? "Killed" : "Removed";
    const note = kind === "rm" && !allTopicsDeleted ? ORPHAN_TOPIC_NOTE : "";
    confirmSessionCommand(topicId, `${verb} ${targets.length} session${targets.length === 1 ? "" : "s"}: ${targets.map((r) => r.slug).join(", ")}${note}`);
  }

  async function handleKillCommand(cmd: Extract<FleetCommand, { kind: "kill" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    if (cmd.all) {
      // Excludes config.selfCheck.slug the same way runStartupReconciliation already does (index.ts's
      // reconciliation filter) - it's the Bridge's own hardcoded dev/self-check session (a fixed
      // SELF_CHECK_TOPIC_ID from .env, always relaunched on the next restart regardless), not a real
      // operator-created session with its own discoverable Telegram topic, so a blanket "kill
      // everything" must not sweep it in.
      const targets = sessionStore.all().filter((r) => r.state !== "dead" && r.slug !== config.selfCheck.slug);
      if (cmd.force) {
        await executeFleetActionDirect("kill", topicId, targets);
        return;
      }
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
   * `--dead`/`--prefix` forms below, so the two can't drift. Returns whether the Telegram topic
   * itself was actually deleted - the DB row is removed either way (§4.5.2: a Telegram-side
   * failure here, e.g. `TOPIC_ID_INVALID`, shouldn't leave a zombie row behind), but callers use
   * this to tell the operator when a topic was left orphaned rather than silently succeeding. */
  async function removeSessionRow(row: SessionRow): Promise<boolean> {
    const { slug } = row;
    if (row.state !== "dead") {
      sessionSupervisor.getPtyProcess(slug)?.kill();
    }
    sessionSupervisor.untrack(slug);
    routing.clearPtyWrite(slug);
    stopIndicatorsForTopic(row.topicId);

    // Best-effort - must run before removeWorktree deletes the checkout `cleanupDiffRefs` needs as
    // its `cwd` to reach `origin` at all.
    cleanupDiffRefs(row.worktreePath, slug);

    try {
      await removeWorktree(row.repoPath, row.worktreePath);
    } catch (err) {
      log("WARN", `removeWorktree failed for "${slug}": ${(err as Error).message}`);
    }
    let topicDeleted = true;
    try {
      await controlBot.deleteForumTopic(config.supergroupChatId, row.topicId);
    } catch (err) {
      topicDeleted = false;
      log("WARN", `deleteForumTopic failed for "${slug}": ${(err as Error).message}`);
    }

    sessionStore.remove(slug);
    routing.remove(slug);
    feedWiring.forgetSession(slug);
    return topicDeleted;
  }

  /** §4.5.2's note appended to an `/rm` confirmation whenever `deleteForumTopic` failed above -
   * without this the operator only finds out days later, by eye, that a topic was left behind
   * (as happened live: two such orphans had accumulated with nothing pointing at them). Naming
   * `/rm` explicitly rather than just describing the fix, since that's the exact recovery step
   * (§4.5.2's `rm-topic` confirm below, keyed off the orphaned topic's own thread id). */
  const ORPHAN_TOPIC_NOTE = " (Telegram topic itself could not be deleted - send /rm inside it directly to clean it up)";

  async function handleRmCommand(cmd: Extract<FleetCommand, { kind: "rm" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    // `--all` (added 2026-08-04) is the deliberate exception to the dead-only rule below - it can
    // remove live sessions too, so it goes through the same confirm-button flow as `/kill --all`
    // rather than executing on the same message (fleet-commands.ts's RmBulkFilter note).
    if (cmd.bulk?.mode === "all") {
      // Same exclusion as /kill --all just above (and runStartupReconciliation's own filter) -
      // config.selfCheck.slug is the Bridge's own hardcoded dev/self-check session, not a real
      // operator-created one, and removeSessionRow would delete its worktree and try to
      // deleteForumTopic against a hardcoded SELF_CHECK_TOPIC_ID that was never actually created via
      // createForumTopic in the first place.
      const targets = sessionStore.all().filter((r) => r.slug !== config.selfCheck.slug);
      if (cmd.force) {
        await executeFleetActionDirect("rm", topicId, targets);
        return;
      }
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
      let allTopicsDeleted = true;
      for (const row of targets) {
        if (!(await removeSessionRow(row))) allTopicsDeleted = false;
      }
      confirmSessionCommand(
        topicId,
        `Removed ${targets.length} dead session${targets.length === 1 ? "" : "s"}: ${targets.map((r) => r.slug).join(", ")}${allTopicsDeleted ? "" : ORPHAN_TOPIC_NOTE}`,
      );
      return;
    }

    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      // §4.5.2: a bare `/rm` with nothing to resolve to - if this is a real Telegram topic (not
      // the control topic itself) that just has no session row, it's very likely one of these
      // orphans (an earlier `deleteForumTopic` failure left the topic behind after its row was
      // already removed) rather than a plain usage mistake. Offer to delete the topic directly,
      // keyed off `topicId` alone, since there is nothing in the DB to look up for it.
      if (topicId !== undefined && !isControlTopic(topicId) && cmd.slug === undefined) {
        await postOrphanTopicRmConfirm(topicId);
        return;
      }
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
    const topicDeleted = await removeSessionRow(row);
    confirmSessionCommand(topicId, `Removed "${slug}" - worktree and topic deleted.${topicDeleted ? "" : ORPHAN_TOPIC_NOTE}`);
  }

  /** §4.5.2: posts the confirm card for deleting a Telegram topic that has no matching session
   * row at all - the `rm-topic` fleet-confirm variant. Unlike `postFleetConfirm`, there are no
   * `slugs` to show (there is nothing tracked for this topic), so the prompt just names the topic
   * by id. */
  async function postOrphanTopicRmConfirm(topicId: number): Promise<void> {
    const id = randomUUID().slice(0, 8);
    try {
      const sent = await controlBot.sendMessage(
        config.supergroupChatId,
        topicId,
        "This topic has no session tracked in the Bridge - delete this Telegram topic itself?",
        { inline_keyboard: buildFleetConfirmKeyboard("rm-topic", id) },
      );
      fleetConfirmRegistry.add({ id, kind: "rm-topic", slugs: [], topicId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post orphan-topic /rm confirmation: ${(err as Error).message}`);
    }
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
   * §5.9's `/detail [<slug>] [compact|full]`: how much of each tool call the feed card shows for
   * this one session - "full" wraps each line's untruncated input in a `<blockquote expandable>`
   * instead of the 80-char one-liner; no argument reports the current setting rather than
   * changing anything, same "bare = status" convention as `/autostart`.
   */
  function handleDetailCommand(cmd: Extract<FleetCommand, { kind: "detail" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    if (!cmd.level) {
      const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
      confirmSessionCommand(topicId, `"${slug}" feed detail: ${row.feedDetail}.`);
      return;
    }
    sessionStore.setFeedDetail(slug, cmd.level);
    confirmSessionCommand(topicId, `"${slug}" feed detail set to ${cmd.level}.`);
  }

  /**
   * §5.9's `/verbose [<slug>] [on|off]`: whether the feed also shows a tool's actual output, not
   * just what it was asked to do - default off, since real tool output can carry arbitrary file
   * content (the same §8.2 concern §5.3 already truncates for), and only visible at all once
   * `/detail` is `full`.
   */
  function handleVerboseCommand(cmd: Extract<FleetCommand, { kind: "verbose" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const { slug } = resolved;
    if (cmd.on === undefined) {
      const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
      confirmSessionCommand(topicId, `"${slug}" verbose tool output: ${row.feedVerbose ? "on" : "off"}.`);
      return;
    }
    sessionStore.setFeedVerbose(slug, cmd.on);
    const row = sessionStore.get(slug) as NonNullable<ReturnType<typeof sessionStore.get>>;
    const noEffectNote = cmd.on && row.feedDetail !== "full" ? ` (no effect until /detail full is also set for "${slug}")` : "";
    confirmSessionCommand(topicId, `"${slug}" verbose tool output set to ${cmd.on ? "on" : "off"}.${noEffectNote}`);
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
    log("INFO", "/restart requested - relaunching and exiting");
    await respawnSelfAndExit();
  }

  /**
   * The only correct way for this process to replace itself. A raw detached spawn is killed
   * instantly if this process is itself a Task-Scheduler-launched task (Windows Job Object
   * containment - see `buildRunArgs`' own note, live-verified 2026-08-06), so re-run the registered
   * task instead when one exists: the successor is then a fresh, independent Task Scheduler action
   * rather than a doomed child of this one. Falls back to the direct spawn otherwise, which is
   * correct for a manually-started dev Bridge where there is no job to escape.
   *
   * Shared by all three self-respawn sites (`/restart`, `/deploy`'s self-repo restart, and the
   * stale-deploy rollback at boot). The latter two used the raw spawn directly, so on an
   * autostart-installed host a successful `/deploy` took the Bridge down permanently - and the
   * rollback path then did it again on the next manual start, immediately after rolling back.
   *
   * restart-settle.ts: found live 2026-08-06 that firing this within ~1s of `bootReadyAt` kills a
   * session this same process's own boot reconciliation just resumed and immediately resumes the
   * same `session_id` again in the successor - Claude Code's own resume bookkeeping doesn't
   * tolerate two resumes that close together and the second one comes up dead. `bootReadyAt` is
   * still `undefined` for the stale-deploy rollback (it fires before reconciliation ever runs, so
   * there is nothing of this boot's own to protect yet) - only `/restart` and `/deploy` can ever
   * see a defined, non-zero delay here.
   */
  async function respawnSelfAndExit(): Promise<never> {
    if (bootReadyAt !== undefined) {
      const delay = restartSettleDelayMs(bootReadyAt, Date.now());
      if (delay > 0) {
        log("INFO", `delaying self-respawn ${delay}ms so this boot's own just-resumed sessions can settle first (§4.5)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const ranViaTask = !(await runSchtasks(buildRunArgs())).failed;
    if (!ranViaTask) {
      // Deliberately never `spawn(process.execPath, process.argv.slice(1), ...)` here (0.100.0):
      // that blindly re-launches with whatever binary happened to start *this* process, so a
      // Bridge that was ever started via `bun run` even once - manually, or via the autostart
      // Task Scheduler entry's own past mis-registration - kept perpetuating that lineage forever,
      // across every `/restart` and `/deploy`. Bun is the confirmed, reproduced trigger for
      // node-pty's unhandled "Socket is closed" ConPTY write crash (0.21.0), which wedges nearly
      // every session within ~1s of spawn - live-observed 2026-08-08, see
      // `resolveNodeExecutable`'s own doc comment (session-launcher.ts) for the full chain. Always
      // resolving and re-launching the documented runtime explicitly, regardless of how this
      // process itself was started, is what actually breaks that cycle rather than perpetuating it.
      const entryScript = path.join(import.meta.dirname, "index.ts");
      spawn(resolveNodeExecutable(), ["--experimental-strip-types", entryScript], { detached: true, stdio: "ignore" }).unref();
    }
    process.exit(0);
  }

  /**
   * §5.9's `/deploy <slug>`: lets a fix written by a Claude session - including one against
   * aibridge's own repo, registered like any other project (§7.5) - land without a desk. Merges
   * that session's own branch into its repo's main checkout via `deployBranch` (fast-forward only,
   * rolled back automatically on a gate failure), then only if the repo being merged into is this
   * Bridge's own checkout (`isSelfRepo` - any other project's branch is just a merge+test, there is
   * no "Bridge" to restart for it) does the same self-respawn `/restart` already does, first
   * writing `deployMarker` so a boot that never comes up cleanly gets rolled back automatically
   * (see the startup check near the end of `main()`) rather than crash-looping on a bad commit
   * with no way to say so.
   */
  async function handleDeployCommand(topicId: number | undefined, slug: string): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/deploy only works from the control topic.");
      return;
    }
    const row = sessionStore.get(slug);
    if (!row) {
      confirmSessionCommand(topicId, `No session "${slug}".`);
      return;
    }
    const { repoPath, branch } = row;
    try {
      await controlBot.sendMessage(config.supergroupChatId, topicId, `Deploying "${branch}" (session "${slug}") into ${repoPath}…`);
    } catch (err) {
      log("WARN", `failed to send /deploy ack: ${(err as Error).message}`);
    }
    log("INFO", `/deploy requested for slug "${slug}" -> merging "${branch}" into ${repoPath}`);
    const packageDirs = discoverTypecheckedPackages(repoPath);
    const outcome = await deployBranch(repoPath, branch, packageDirs);
    if (!outcome.ok) {
      log("WARN", `/deploy failed for "${branch}": ${outcome.message}`);
      try {
        await controlBot.sendMessage(config.supergroupChatId, topicId, truncateForTelegram(outcome.message));
      } catch (err) {
        log("WARN", `failed to send /deploy failure message: ${(err as Error).message}`);
      }
      return;
    }
    try {
      await controlBot.sendMessage(config.supergroupChatId, topicId, truncateForTelegram(outcome.message));
    } catch (err) {
      log("WARN", `failed to send /deploy success message: ${(err as Error).message}`);
    }

    const bridgeRepoRoot = resolveBridgeRepoRoot(import.meta.dirname);
    if (!isSelfRepo(repoPath, bridgeRepoRoot)) {
      log("INFO", `/deploy: "${repoPath}" isn't this Bridge's own repo - merged only, no restart`);
      return;
    }

    writeDeployMarker(STATE_DIR, {
      previousHeadSha: outcome.previousHeadSha ?? "",
      newHeadSha: outcome.newHeadSha ?? "",
      repoRoot: repoPath,
      branch,
      chatId: config.supergroupChatId,
      topicId,
      deployedAtIso: new Date().toISOString(),
    });
    try {
      await controlBot.sendMessage(
        config.supergroupChatId,
        topicId,
        "This is aibridge's own repo - restarting now to apply the fix (§5.9). If it doesn't come back up cleanly within a minute, it rolls itself back automatically and restarts again.",
      );
    } catch (err) {
      log("WARN", `failed to send /deploy restart notice: ${(err as Error).message}`);
    }
    log("INFO", "/deploy: self-repo, respawning and exiting");
    await respawnSelfAndExit();
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

  /** Runs a PowerShell one-liner and reports success/failure the same shape as `runSchtasks` -
   * `schtasks.exe` alone can't fix the two task-settings defaults `buildFixTaskSettingsScript` targets,
   * so `/autostart install` needs this second tool as well. */
  function runPowershell(script: string): Promise<{ stderr: string; failed: boolean }> {
    return new Promise((resolve) => {
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (err, _stdout, stderr) => {
        resolve({ stderr: stderr ?? "", failed: err !== null });
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
        const result = await runSchtasks(buildCreateArgs(resolveNodeExecutable(), entryScript));
        if (result.failed) throw new Error(result.stderr.trim() || "schtasks /Create failed");
        // schtasks /Create leaves two defaults that would bite later (§7.2 point 2's 3-day execution
        // limit, and a "Multiple Instances" policy that silently breaks /restart's buildRunArgs path -
        // see buildFixTaskSettingsScript's own doc comment for both). Best-effort: the task is already
        // registered and usable either way, so a failure here is reported, not thrown, and doesn't
        // undo the install.
        const settingsResult = await runPowershell(buildFixTaskSettingsScript(TASK_NAME));
        confirmSessionCommand(
          topicId,
          settingsResult.failed
            ? `Registered "${TASK_NAME}" as a logon-trigger scheduled task (§7.2), but fixing its execution-time-limit/multiple-instances defaults failed: ${settingsResult.stderr.trim() || "unknown error"}. It will still start at logon, but a long-running fleet risks the 3-day kill and /restart may not survive - run /autostart install again once fixed, or fix both manually in Task Scheduler.`
            : `Registered "${TASK_NAME}" as a logon-trigger scheduled task (§7.2) - starts the Bridge at next log-on, current-user scope, no admin rights needed. Its 3-day execution time limit is disabled and multiple-instances is set to Parallel, so a long-running fleet won't get killed on the fourth day and /restart works reliably.`,
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

  /** `/assist [on|off]` - whether an NL-matched destructive command shows a confirm card first
   * (nl-confirm.ts). `assistEnabled` is the in-memory copy every confirm-gate check reads;
   * `settingsStore` is only touched on an actual change, matching `feed_detail`/`feed_verbose`'s
   * own "in-memory for reads, persisted on write" shape (session-store.ts). */
  function handleAssistCommand(cmd: Extract<FleetCommand, { kind: "assist" }>, topicId: number | undefined): void {
    if (cmd.action === "status") {
      confirmSessionCommand(topicId, `Natural-language destructive-command confirmation is ${assistEnabled ? "on" : "off"}.`);
      return;
    }
    assistEnabled = cmd.action === "on";
    settingsStore.set("assist_enabled", assistEnabled ? "true" : "false");
    confirmSessionCommand(
      topicId,
      assistEnabled
        ? "Natural-language destructive-command confirmation is now on - kill/rm/restart/deploy/repos-rm matched from plain text or voice will ask first."
        : "Natural-language destructive-command confirmation is now off - kill/rm/restart/deploy/repos-rm matched from plain text or voice will run immediately.",
    );
  }

  /** `/voiceconfirm [on|off]` - whether a transcribed voice note shows a Send/Re-record/Type-
   * instead card first (voice-confirm.ts) or is auto-sent straight through. Same in-memory-for-
   * reads, persisted-on-write shape as `handleAssistCommand`. */
  function handleVoiceConfirmCommand(cmd: Extract<FleetCommand, { kind: "voiceconfirm" }>, topicId: number | undefined): void {
    if (cmd.action === "status") {
      confirmSessionCommand(topicId, `Voice-note send confirmation is ${voiceConfirmEnabled ? "on" : "off"}.`);
      return;
    }
    voiceConfirmEnabled = cmd.action === "on";
    settingsStore.set("voice_confirm_enabled", voiceConfirmEnabled ? "true" : "false");
    confirmSessionCommand(
      topicId,
      voiceConfirmEnabled
        ? "Voice-note send confirmation is now on - a transcribed voice note shows a Send/Re-record/Type-instead card before it's dispatched."
        : "Voice-note send confirmation is now off - a transcribed voice note is sent straight through, with the transcript still shown so you can see what was sent - /voiceconfirm on to review before sending again.",
    );
  }

  /** Text shown by both bare `/default` and the "Cancel"-free result of applying a mode change -
   * kept as one function so the two spots that need "what are the defaults right now" (the status
   * card and the mode-change confirmation) can't drift apart. */
  function renderDefaultModeConfirmation(mode: Mode): string {
    return mode === "auto"
      ? "New sessions will now start in auto mode - no permission prompts at all for any tool call, including git commit/push, until this is changed back. /default mode manual to revert."
      : `New sessions will now start in ${mode} mode.`;
  }

  /** `/default` (bare or `status`): both current values, plus a tappable Mode/Effort keyboard to
   * drill into either one (`session-commands.ts`'s `buildDefaultCategoryKeyboard`) - one command to
   * remember instead of two separately-named ones (operator feedback, 2026-08-07). Sent directly via
   * `controlBot`, not `confirmSessionCommand`, so the keyboard actually attaches - same reasoning as
   * the bare `/model`/`/mode`/`/effort` keyboards further down. */
  function sendDefaultStatusCard(topicId: number | undefined): void {
    controlBot
      .sendMessage(
        config.supergroupChatId,
        topicId,
        `New sessions currently start in ${defaultSessionMode} mode at ${defaultSessionEffort} effort. Tap one to change it:`,
        { inline_keyboard: buildDefaultCategoryKeyboard(defaultSessionMode, defaultSessionEffort) },
      )
      .catch((err) => log("WARN", `sendMessage (/default status) failed: ${(err as Error).message}`));
  }

  /** `/default mode` / `/default effort` with no value (typed, or reached by tapping a category
   * button from `sendDefaultStatusCard`'s keyboard): shows that category's own value picker, current
   * value marked, under the `defmode:`/`defeffort:` namespace (`session-commands.ts` - deliberately
   * not `mode:`/`effort:`, which resolve against `currentSlug` and would silently no-op here). */
  function sendDefaultCategoryPicker(topicId: number | undefined, category: DefaultCategory): void {
    const [prompt, keyboard] =
      category === "mode"
        ? [`Choose the default permission mode for new sessions (current: ${defaultSessionMode}):`, buildDefaultModeKeyboard(defaultSessionMode)]
        : [`Choose the default effort level for new sessions (current: ${defaultSessionEffort}):`, buildDefaultEffortKeyboard(defaultSessionEffort)];
    controlBot
      .sendMessage(config.supergroupChatId, topicId, prompt, { inline_keyboard: keyboard })
      .catch((err) => log("WARN", `sendMessage (/default ${category}) failed: ${(err as Error).message}`));
  }

  /** `/default mode <value>` / `/default effort <value>` (typed, or via the value pickers' own
   * callback taps in the `onUpdate` handler below) - the actual set-and-persist, shared by both
   * entry points so a typed command and a tapped button can't drift into different behavior.
   *
   * `mode`'s `auto` gets its own explicit warning in the confirmation text - it's the one
   * `nl-router.ts`'s `isDestructive` already treats as security-sensitive when reached via natural
   * language inside a live session, and setting it here has a wider blast radius than that
   * single-session case: every session launched from this point on starts with no permission
   * prompts at all, not just the one the operator is looking at right now, until this is explicitly
   * changed back. `effort` has no such warning - it's a cost/latency choice, not a safety one. */
  function applyDefaultMode(mode: Mode): string {
    defaultSessionMode = mode;
    settingsStore.set("default_session_mode", mode);
    return renderDefaultModeConfirmation(mode);
  }

  function applyDefaultEffort(effort: Effort): string {
    defaultSessionEffort = effort;
    settingsStore.set("default_session_effort", effort);
    return `New sessions will now start at ${effort} effort.`;
  }

  function handleDefaultCommand(cmd: Extract<FleetCommand, { kind: "default" }>, topicId: number | undefined): void {
    if (cmd.category === "status") {
      sendDefaultStatusCard(topicId);
      return;
    }
    if (cmd.category === "mode") {
      if (cmd.value === undefined) {
        sendDefaultCategoryPicker(topicId, "mode");
        return;
      }
      confirmSessionCommand(topicId, applyDefaultMode(cmd.value));
      return;
    }
    if (cmd.value === undefined) {
      sendDefaultCategoryPicker(topicId, "effort");
      return;
    }
    confirmSessionCommand(topicId, applyDefaultEffort(cmd.value));
  }

  /** `/router [api|cli]` - live switch for the NL-router backend, no restart needed either
   * direction. Switching to "api" is refused (not silently downgraded to "cli") when no key is
   * configured - the operator asked for the fast/paid path specifically, so a silent no-op would
   * be more confusing than telling them what's missing. */
  function handleRouterBackendCommand(cmd: Extract<FleetCommand, { kind: "router" }>, topicId: number | undefined): void {
    if (cmd.action === "status") {
      confirmSessionCommand(
        topicId,
        `Natural-language routing backend: ${nlRouterBackend}${nlRouterBackend === "cli" ? " (your Claude Code subscription)" : " (funded ANTHROPIC_API_KEY)"}.`,
      );
      return;
    }
    if (cmd.action === "api" && !config.nlRouter.apiKey) {
      confirmSessionCommand(topicId, "No ANTHROPIC_API_KEY configured in .env - add one first, then /router api.");
      return;
    }
    nlRouterBackend = cmd.action;
    settingsStore.set("nl_router_backend", nlRouterBackend);
    confirmSessionCommand(
      topicId,
      nlRouterBackend === "api"
        ? "Natural-language routing now uses the API backend - faster, but each unmatched message has a small real cost."
        : "Natural-language routing now uses your Claude Code subscription (cli backend) - no extra cost, but slower per message.",
    );
  }

  /** `/about`'s exact-syntax and NL-matched (`kind: "about"`, nl-router.ts) paths both call this -
   * extracted so there's one place to keep in sync. */
  function sendAboutCard(threadId: number | undefined): void {
    controlBot
      .sendMessage(config.supergroupChatId, threadId, renderAbout(), { inline_keyboard: buildAboutKeyboard() })
      .catch((err) => log("WARN", `sendMessage (/about) failed: ${(err as Error).message}`));
  }

  /** `/help`'s exact-syntax and NL-matched (`kind: "help"`, nl-router.ts) paths both call this. */
  function sendHelpCard(threadId: number | undefined, route: ReturnType<typeof routing.getByTopicId>): void {
    const repoCommands = route ? listRepoCommands(route.worktreePath) : [];
    const repoSkills = route ? listRepoSkills(route.worktreePath) : [];
    controlBot
      .sendMessage(config.supergroupChatId, threadId, renderHelp(), { inline_keyboard: buildCommandKeyboard(repoCommands, repoSkills) })
      .catch((err) => log("WARN", `sendMessage (command list) failed: ${(err as Error).message}`));
  }

  /** `/commands [<term>]`'s exact-syntax and NL-matched (`kind: "commands"`, nl-router.ts) paths
   * both call this - session-scoped only (no worktree to read commands from without a `route`). */
  function sendCommandsListCard(threadId: number | undefined, route: ReturnType<typeof routing.getByTopicId>, term: string): void {
    const text = route
      ? renderCommandsListText(listRepoCommands(route.worktreePath), term)
      : "Repo commands are session-scoped - send /commands inside a session's own topic.";
    controlBot.sendMessage(config.supergroupChatId, threadId, text).catch((err) => log("WARN", `sendMessage (/commands) failed: ${(err as Error).message}`));
  }

  /** `/skills [<term>]`'s exact-syntax and NL-matched (`kind: "skills"`, nl-router.ts) paths both
   * call this - same session-scoping as `sendCommandsListCard`. */
  function sendSkillsListCard(threadId: number | undefined, route: ReturnType<typeof routing.getByTopicId>, term: string): void {
    const text = route
      ? renderSkillsListText(listRepoSkills(route.worktreePath), term)
      : "Repo skills are session-scoped - send /skills inside a session's own topic.";
    controlBot.sendMessage(config.supergroupChatId, threadId, text).catch((err) => log("WARN", `sendMessage (/skills) failed: ${(err as Error).message}`));
  }

  /** `/browse [<path>]` - session-scoped only, same as `sendCommandsListCard`. An invalid/escaping
   * `path` argument (worktree-fs.ts's `resolveWorktreeRelPath` rejects it) is reported, not silently
   * clamped to the root. */
  function sendBrowseCard(threadId: number | undefined, route: ReturnType<typeof routing.getByTopicId>, requestedPath: string): void {
    if (!route) {
      confirmSessionCommand(threadId, "File browsing is session-scoped - send /browse inside a session's own topic.");
      return;
    }
    const listing = listDirectory(route.worktreePath, requestedPath);
    if (!listing) {
      confirmSessionCommand(threadId, `Can't browse "${requestedPath || "/"}" - it doesn't exist, or is outside this session's worktree.`);
      return;
    }
    controlBot
      .sendMessage(config.supergroupChatId, threadId, renderDirText(listing), { inline_keyboard: buildDirKeyboard(browseRegistry, route.slug, listing) })
      .catch((err) => log("WARN", `sendMessage (/browse) failed: ${(err as Error).message}`));
  }

  /** `/find <query>` - session-scoped only. The hit set is a snapshot taken now, stored once in
   * `browseRegistry` (kind "hitset") and paged from that snapshot rather than re-searched per page -
   * see browse-nav.ts's own doc comment on `buildHitsKeyboard` for why. */
  function sendFindCard(threadId: number | undefined, route: ReturnType<typeof routing.getByTopicId>, query: string): void {
    if (!route) {
      confirmSessionCommand(threadId, "File search is session-scoped - send /find inside a session's own topic.");
      return;
    }
    const result = searchWorktree(route.worktreePath, query);
    const hitsetId = browseRegistry.add(route.slug, { kind: "hitset", query, ...result });
    controlBot
      .sendMessage(config.supergroupChatId, threadId, renderHitsText(query, result, 0), {
        inline_keyboard: buildHitsKeyboard(browseRegistry, route.slug, hitsetId, result.hits, 0),
      })
      .catch((err) => log("WARN", `sendMessage (/find) failed: ${(err as Error).message}`));
  }

  /** `/diff` - session-scoped only. Pushes the session's pending (uncommitted) changes to a
   * throwaway GitHub branch and replies with a compare-view link (diff-review.ts), or a scrubbed
   * `.diff` document when there's no GitHub remote or the push itself fails - see that module's own
   * doc comment for the full design. */
  function sendDiffCard(threadId: number | undefined, route: ReturnType<typeof routing.getByTopicId>): void {
    if (!route) {
      confirmSessionCommand(threadId, "Diff review is session-scoped - send /diff inside a session's own topic.");
      return;
    }
    const review = buildDiffReview(route.worktreePath, route.slug);
    const untrackedNote = review.untrackedFiles.length > 0 ? ` ${review.untrackedFiles.length} new file(s) not shown - /browse to view: ${review.untrackedFiles.join(", ")}` : "";
    if (review.kind === "empty") {
      confirmSessionCommand(threadId, review.untrackedFiles.length > 0 ? `No tracked changes.${untrackedNote}` : "No pending changes.");
      return;
    }
    if (review.kind === "link" && review.url) {
      controlBot
        .sendMessage(config.supergroupChatId, threadId, `${review.filesChanged} file(s) changed.${untrackedNote}`, {
          inline_keyboard: [[{ text: "Open diff on GitHub", url: review.url }]],
        })
        .catch((err) => log("WARN", `sendMessage (/diff) failed: ${(err as Error).message}`));
      return;
    }
    if (review.kind === "document" && review.diffText !== undefined && controlBot.sendDocumentFile) {
      controlBot
        .sendDocumentFile(config.supergroupChatId, threadId, `${route.slug}.diff`, new TextEncoder().encode(review.diffText), `${review.filesChanged} file(s) changed.${untrackedNote}`)
        .catch((err) => log("WARN", `sendDocumentFile (/diff) failed: ${(err as Error).message}`));
    }
  }

  /** Short human-readable label for an NL-matched command's confirm card and its finalize message
   * - not exhaustive-per-field (e.g. `/new`'s prompt text isn't echoed back), just enough for the
   * operator to recognise what they're about to approve. */
  function describeNlCommand(command: FleetCommand | SessionCommand | RouterAction): string {
    switch (command.kind) {
      case "kill":
        return command.all ? "/kill --all" : `/kill${command.slug ? ` ${command.slug}` : ""}`;
      case "rm":
        if (command.bulk?.mode === "all") return "/rm --all";
        if (command.bulk?.mode === "dead") return "/rm --dead";
        if (command.bulk?.mode === "prefix") return `/rm --prefix ${command.bulk.prefix}`;
        return `/rm${command.slug ? ` ${command.slug}` : ""}`;
      case "restart":
        return "/restart";
      case "deploy":
        return `/deploy ${command.slug}`;
      case "repos":
        return command.action === "rm" ? `/repos rm ${command.name}` : "/repos";
      default:
        return `/${command.kind}`;
    }
  }

  /** Executes an NL-matched command that either wasn't destructive, or was and got confirmed -
   * routes to the exact same handlers a typed `/command` or `/model`/`/mode`/`/effort` would use
   * (`dispatchFleetCommand` above, `applyModelSwitch`/`applyModeSwitch`/`applyEffortSwitch`), never
   * a separate copy. `nl-router.ts`'s `mapRouterOutput` already guarantees a `session_*` kind never
   * arrives without `currentSlug`/`threadId` set (`allowedKinds`'s `hasSession` gate), so the guard
   * here is defense in depth, not load-bearing. */
  function executeMatchedCommand(
    command: FleetCommand | SessionCommand | RouterAction,
    threadId: number | undefined,
    isControl: boolean,
    currentSlug: string | undefined,
  ): void {
    if (command.kind === "help") {
      sendHelpCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined);
      return;
    }
    if (command.kind === "about") {
      sendAboutCard(threadId);
      return;
    }
    if (command.kind === "commands") {
      sendCommandsListCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.term);
      return;
    }
    if (command.kind === "skills") {
      sendSkillsListCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.term);
      return;
    }
    if (command.kind === "builtin") {
      if (currentSlug) ptyIo.sendRaw(currentSlug, `/${command.name}`);
      return;
    }
    if (command.kind === "browse") {
      sendBrowseCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.path);
      return;
    }
    if (command.kind === "find") {
      sendFindCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.query);
      return;
    }
    if (command.kind === "diff") {
      sendDiffCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined);
      return;
    }
    if (command.kind === "model" || command.kind === "mode" || command.kind === "effort") {
      if (!currentSlug || threadId === undefined) return;
      if (command.kind === "model") applyModelSwitch(currentSlug, threadId, command.model);
      else if (command.kind === "effort") applyEffortSwitch(currentSlug, threadId, command.effort);
      else applyModeSwitch(currentSlug, threadId, command.mode);
      return;
    }
    dispatchFleetCommand(command, threadId, isControl, currentSlug);
  }

  /** Posts the run/don't-ask-again/cancel card for an NL-matched *destructive* command
   * (nl-confirm.ts) and registers it - mirrors `postFleetConfirm`'s shape exactly. */
  async function postNlConfirm(command: FleetCommand | SessionCommand | RouterAction, threadId: number | undefined, currentSlug: string | undefined): Promise<void> {
    const id = randomUUID().slice(0, 8);
    try {
      const sent = await controlBot.sendMessage(config.supergroupChatId, threadId, `🤖 I read that as ${describeNlCommand(command)} - run it?`, {
        inline_keyboard: buildNlConfirmKeyboard(id),
      });
      nlConfirmRegistry.add({ id, command, threadId, currentSlug, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post NL-confirm card: ${(err as Error).message}`);
    }
  }

  /**
   * The one entry point for both of `dispatchInboundMessage`'s fallthrough branches (no session /
   * forward-to-session) - tries the NL router, and only calls `onNoMatch` (today's existing
   * behaviour for that branch) when it genuinely didn't match anything. Never throws and never
   * takes longer than the router itself does to fail - `routeText` (nl-router.ts) already catches
   * every backend error internally and resolves `{ matched: false }`.
   */
  async function routeOrFallback(
    text: string,
    ctx: { isControl: boolean; hasSession: boolean; repoNames?: string[] },
    threadId: number | undefined,
    isControl: boolean,
    currentSlug: string | undefined,
    onNoMatch: () => void,
  ): Promise<void> {
    if (!config.nlRouter.enabled) {
      onNoMatch();
      return;
    }
    const topicIdStr = threadId !== undefined ? String(threadId) : undefined;
    // The router call itself is the latency gap with no existing "something is happening" signal
    // (unlike a forwarded turn, which sendChannelText already covers) - live-observed as a silent
    // multi-second wait on the CLI backend. Reuses §5's two existing indicators rather than
    // inventing a third: `typingIndicator` (cheap, self-expiring, safe to start/stop repeatedly)
    // always; the message-based `thinkingPlaceholder` only for `!ctx.hasSession, where nothing
    // else will start one a moment later - starting it unconditionally would leak an orphaned
    // placeholder in the `hasSession` branch, since `sendChannelText`'s own `start()` a few lines
    // below `onNoMatch()` overwrites the pending entry without consuming this one first
    // (`thinking-placeholder.ts` has no built-in dedup the way `typing-indicator.ts` does).
    const usePlaceholder = !ctx.hasSession && topicIdStr !== undefined;
    if (topicIdStr) typingIndicator.start(topicIdStr);
    if (usePlaceholder) thinkingPlaceholder.start(topicIdStr!);

    const result = await routeText(text, ctx, { ...config.nlRouter, backend: nlRouterBackend }, log);

    if (topicIdStr) typingIndicator.stop(topicIdStr);
    if (usePlaceholder) {
      const placeholderMsgId = await thinkingPlaceholder.consume(topicIdStr!);
      // Removed outright, not edited into a final state - no single text fits every outcome below
      // (a command's own reply, a confirm card, or "Unrecognised control-topic command" are all
      // separate messages that follow immediately).
      if (placeholderMsgId !== undefined && controlBot.deleteMessage) {
        await controlBot.deleteMessage(config.supergroupChatId, placeholderMsgId).catch((err) => log("WARN", `failed to delete NL-router placeholder: ${(err as Error).message}`));
      }
    }

    if (!result.matched) {
      onNoMatch();
      return;
    }
    // The router's own `prompt` field is an emergent English paraphrase (its classification prompt
    // is all-English with no language-preservation instruction) - fine for the slug/topic title,
    // wrong for what the session actually sees as its first turn. Attaching the raw message here
    // (before the destructive/confirm branch, so a deferred `/new` would carry it too - moot today
    // since 'new' is never destructive, but this keeps the guarantee in one place) lets
    // `handleNewCommand` recover the operator's own words via `newSessionContent`.
    if (result.command.kind === "new") result.command = { ...result.command, sourceText: text };
    if (result.destructive && assistEnabled) {
      void postNlConfirm(result.command, threadId, currentSlug);
      return;
    }
    executeMatchedCommand(result.command, threadId, isControl, currentSlug);
  }

  /**
   * The exact-syntax `/command` switch, extracted so both a typed `/command` (`parseFleetCommand`,
   * below) and an NL-matched command (nl-router.ts, wired further down) execute through the exact
   * same code path - no separate copy to keep in sync. `isControl` mirrors the same two inline
   * checks (`/new`, `/budget`) `dispatchInboundMessage` always ran; an NL match can never produce
   * either kind outside the control topic anyway (`nl-router.ts`'s `allowedKinds`), but the check
   * stays here too as defense in depth rather than trusting that filtering happened upstream.
   */
  function dispatchFleetCommand(fleetCmd: FleetCommand, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined): void {
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
    if (fleetCmd.kind === "deploy") {
      void handleDeployCommand(threadId, fleetCmd.slug);
      return;
    }
    if (fleetCmd.kind === "detail") {
      handleDetailCommand(fleetCmd, threadId, currentSlug);
      return;
    }
    if (fleetCmd.kind === "verbose") {
      handleVerboseCommand(fleetCmd, threadId, currentSlug);
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
    if (fleetCmd.kind === "assist") {
      handleAssistCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "router") {
      handleRouterBackendCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "voiceconfirm") {
      handleVoiceConfirmCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "default") {
      if (!isControl) {
        confirmSessionCommand(threadId, "/default only works from the control topic.");
        return;
      }
      handleDefaultCommand(fleetCmd, threadId);
      return;
    }
    handlePauseCommand(fleetCmd, threadId, currentSlug);
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
   *
   * Async since 2026-08-06 (nl-router.ts): the final two fallthrough branches (no session /
   * forward-to-session) now try the NL router first - a real network/process call - before
   * falling back to today's immediate behaviour. Every existing caller already calls this
   * fire-and-forget (`void dispatchInboundMessage(...)` or a bare call inside a non-awaited
   * context), so returning a `Promise<void>` instead of `void` changes nothing at any call site.
   */
  async function dispatchInboundMessage(
    messageId: number,
    rawText: string,
    threadId: number | undefined,
    isControl: boolean,
    route: ReturnType<typeof routing.getByTopicId>,
    currentSlug: string | undefined,
    from: string,
    // §5.x (message-context.ts): built once by the caller from the *original* Telegram message's
    // `forward_origin`/`reply_to_message` (never re-derived from `rawText`, which by this point may
    // already be a synthesized announcement/transcript with no such fields of its own). Applied only
    // at the one "this reaches the session" send below - never mixed into `text`/`rawText` itself,
    // which every `/command` parse in this function still needs byte-identical to what was typed.
    contextPrefix = "",
  ): Promise<void> {
    // Strip a Telegram-inserted "@botusername" before any command parsing below - see
    // stripBotMention's doc comment for why this has to happen exactly once, here.
    const text = stripBotMention(rawText.trim());

    // Any message landing in a session's own topic (chat, command, whatever) pushes the feed
    // card's already-fixed position further up the topic - see feedInterjected's own doc comment
    // above for why the *next* card flush needs to know this happened.
    if (route && !isControl) feedWiring.markInterjected(route.slug);

    const fleetCmd = parseFleetCommand(text);
    if (fleetCmd) {
      dispatchFleetCommand(fleetCmd, threadId, isControl, currentSlug);
      return;
    }

    // `/retry` (retry-store.ts, §4.2, added 2026-08-07): only intercepted when `retryStore` actually
    // holds something for this topic - so a plain "retry"/"try again" meant for Claude, in a topic
    // with nothing pending, still falls through to the session untouched instead of being swallowed
    // on the strength of the phrase alone.
    if (isRetryPhrase(text)) {
      const pendingRetry = retryStore.resolve(retryTopicKey(threadId));
      if (!pendingRetry) {
        confirmSessionCommand(threadId, "Nothing to retry - no expired confirmation is waiting here.");
        return;
      }
      void postNlConfirm(pendingRetry.command, pendingRetry.threadId, pendingRetry.currentSlug);
      return;
    }

    // `/about`: the friendly capability overview (about.ts) - checked ahead of /help since it's
    // the on-ramp `/help` deliberately isn't; works from either the control topic or a session's
    // own topic, same as /help.
    if (isAboutCommand(text)) {
      sendAboutCard(threadId);
      return;
    }

    // "?" bare (no slash) is only treated as a help request from the control topic - inside a
    // session topic it's plausible real content meant for Claude (e.g. "?" as a shorthand
    // question), so only the unambiguous slash forms are recognised there.
    if (isHelpCommand(text, isControl)) {
      sendHelpCard(threadId, route);
      return;
    }

    // `/commands [<term>]`/`/skills [<term>]` - the per-project, item-count-scoped lists (see
    // commands.ts's doc comments on `buildCommandKeyboard` for why these replaced per-item
    // buttons: seowrite, confirmed live 2026-08-04, has 43 repo commands and 66 skills, and a
    // flat button-per-item keyboard can't scale to that). Session-scoped only - control topic
    // has no worktree to read commands/skills from.
    const commandsQuery = parseCommandsQuery(text);
    if (commandsQuery) {
      // `/commands <name> [args]` is documented in three places (commands.ts, about.ts, and its own
      // unit test) as a synonym for `/cmd <name> [args]`, but this list-filter branch matched first
      // and greedily, so the invocation form was unreachable: `/commands review/pre-push --staged`
      // answered `No repo commands matched "review/pre-push --staged"` instead of running it. Only a
      // *real* command name takes the invocation path; anything else is still a list filter, so
      // `/commands review` keeps working as a search. (The unit test passed throughout because it
      // exercised the parser in isolation - reachability is a dispatch-order property, not a parser
      // one.)
      const asInvocation = commandsQuery.term ? parseCmdInvocation(`/cmd ${commandsQuery.term}`) : null;
      if (route && asInvocation && listRepoCommands(route.worktreePath).includes(asInvocation.name)) {
        ptyIo.sendChannelText(route.slug, route.topicId, buildCmdShimText(asInvocation.name, asInvocation.args), String(messageId), from);
        return;
      }
      sendCommandsListCard(threadId, route, commandsQuery.term);
      return;
    }
    const skillsQuery = parseSkillsQuery(text);
    if (skillsQuery) {
      sendSkillsListCard(threadId, route, skillsQuery.term);
      return;
    }

    // `/browse [<path>]`/`/find <query>` - the Telegram file browser/search (browse-nav.ts,
    // worktree-fs.ts). Session-scoped only, same reasoning as /commands/skills above: there's no
    // worktree to browse without a route. Bridge-native, not a Claude tool call - see worktree-fs.ts's
    // own doc comment for why it carries its own independent path-containment logic.
    const browseCmd = parseBrowseCommand(text);
    if (browseCmd) {
      sendBrowseCard(threadId, route, browseCmd.path);
      return;
    }
    const findCmd = parseFindCommand(text);
    if (findCmd) {
      sendFindCard(threadId, route, findCmd.query);
      return;
    }
    if (parseDiffCommand(text)) {
      sendDiffCard(threadId, route);
      return;
    }

    // A bare /model, /mode or /effort (no argument to act on) surfaces a button per option
    // instead of falling through to the ordinary inbound-message path, where it would just
    // arrive as plain chat text and get answered conversationally rather than switching
    // anything (confirmed live for /effort). Each shows the session's current value (✓-marked
    // button, named in the prompt text) when one is known, and a trailing Cancel button - without
    // that, the only way to back out was to ignore the card and hope, or send an unrelated message
    // that just sits below it.
    const currentModel = currentSlug ? sessionStore.get(currentSlug)?.model : undefined;
    const bareCommandKeyboards: Record<string, { prompt: string; keyboard: () => ReturnType<typeof buildEffortKeyboard> }> = {
      "/model": {
        prompt: currentModel ? `Choose a model (current: ${currentModel}):` : "Choose a model:",
        keyboard: () => buildModelKeyboard((MODELS as readonly string[]).includes(currentModel ?? "") ? (currentModel as Model) : undefined),
      },
      "/mode": {
        prompt: currentSlug ? `Choose a permission mode (current: ${routing.getMode(currentSlug)}):` : "Choose a permission mode:",
        keyboard: () => buildModeKeyboard(currentSlug ? routing.getMode(currentSlug) : undefined),
      },
      "/effort": {
        prompt: currentSlug ? `Choose an effort level (current: ${routing.getEffort(currentSlug)}):` : "Choose an effort level:",
        keyboard: () => buildEffortKeyboard(currentSlug ? routing.getEffort(currentSlug) : undefined),
      },
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
      if (currentSlug) ptyIo.sendRaw(currentSlug, text);
      return;
    }

    // §4.3's "a message to a `dead` row's topic is acknowledged, not silently dropped", for the case
    // the check further down cannot reach: reconciliation only re-routes non-`dead` rows, so after any
    // restart a killed session's topic has a row but no route, and `currentSlug` is undefined here.
    // Answering from the row keeps the contract holding across a restart instead of only before one.
    if (!currentSlug && !isControl && threadId !== undefined) {
      const deadRow = sessionStore.getByTopicId(threadId);
      if (deadRow?.state === "dead") {
        confirmSessionCommand(threadId, "This session has ended.");
        return;
      }
    }

    if (!currentSlug || threadId === undefined) {
      // Natural-language routing (nl-router.ts) - only reached once every exact-syntax check
      // above has already rejected this text. `hasSession: false` narrows the offered commands to
      // the control-topic-only subset (`/new`/`/budget`); on no match, today's exact behaviour.
      await routeOrFallback(text, { isControl, hasSession: false, repoNames: reposRegistry?.names() }, threadId, isControl, undefined, () => {
        if (isControl) confirmSessionCommand(threadId, "Unrecognised control-topic command. Try /new, /ls or /help.");
      });
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
          ptyIo.sendChannelText(currentSlug, threadId, buildCmdShimText(cmdInvoke.name, cmdInvoke.args), String(messageId), from);
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
          ptyIo.sendChannelText(currentSlug, threadId, buildSkillShimText(skillInvoke.name, skillInvoke.args), String(messageId), from);
          return;
        }
        if (listRepoCommands(route.worktreePath).includes(skillInvoke.name)) {
          ptyIo.sendChannelText(currentSlug, threadId, buildCmdShimText(skillInvoke.name, skillInvoke.args), String(messageId), from);
          return;
        }
      }
    }

    // Natural-language routing again - this time with a real session to either act on
    // (`hasSession: true`, so `/model`/`/mode`/`/effort` are also offered) or forward to on no
    // match, exactly as §10.1.2's note below always did.
    await routeOrFallback(text, { isControl, hasSession: true, repoNames: reposRegistry?.names() }, threadId, isControl, currentSlug, () => {
      // §10.1.2: notifications/claude/channel is confirmed broken upstream (getClientCapabilities()
      // never negotiates the capability), so inbound delivery writes the same <channel> tag
      // Claude Code would have rendered itself directly to the session's PTY, exactly as an
      // operator typing it and pressing Enter would.
      ptyIo.sendChannelText(currentSlug, threadId, contextPrefix + rawText, String(messageId), from);
    });
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
            feedWiring.maybeSetState(result.entry.slug, "working");
          }
          return;
        }

        // §5.5's `details` button - "d:", a fresh namespace alongside "ask:"/"perm:"/etc. Nothing
        // to resolve against a registry (the reference is self-contained: slug + turn number), so
        // this only needs `feedStates` to check the tapped turn is still the session's current one.
        const detailsAction = callbackQuery.data ? parseDetailsCallback(callbackQuery.data) : null;
        if (detailsAction) {
          const state = feedWiring.getFeedState(detailsAction.slug);
          const stillCurrent = state && state.turnSeq === detailsAction.turnSeq;
          const verboseDetails = sessionStore.get(detailsAction.slug)?.feedVerbose ?? false;
          const text = stillCurrent ? renderDetails(state, verboseDetails) : "That turn has ended - its log is no longer available.";
          // renderDetails renders the same `<code>`/escaped-entity markup the turn card itself
          // uses (feed-renderer.ts) - needs "HTML" here or Telegram shows the literal tags.
          const fitsInOneMessage = text.length <= 4096;
          const anchorMsgId = detailsAnchorStore.get(detailsAction.slug, detailsAction.turnSeq);

          if (anchorMsgId !== undefined) {
            // Edit the button's own anchor message in place (full log + button removed) instead
            // of posting a separate message - the operator's own request, so a repeated /detail
            // tap doesn't keep piling up new messages next to the one that already has the answer.
            // The oversized case still edits the anchor too, just to a short note - the .txt
            // document itself still has to be its own message (Telegram can't inline a file into
            // an edited text message).
            const anchorText = fitsInOneMessage ? text : "📄 Details sent as a file below.";
            feedGovernor
              .scheduleAsync("P1", () => controlBot.editMessageText!(config.supergroupChatId, anchorMsgId, anchorText, { inline_keyboard: [] }, "HTML"))
              .then(() => detailsAnchorStore.delete(detailsAction.slug, detailsAction.turnSeq))
              .catch((err) => {
                // A stale/already-deleted anchor (or any other edit failure) degrades to the
                // pre-edit-in-place behaviour - the operator still gets the details, just as a new
                // message instead of an edit. Drop the now-unreliable mapping either way so a
                // future tap doesn't keep retrying the same broken edit.
                detailsAnchorStore.delete(detailsAction.slug, detailsAction.turnSeq);
                log("WARN", `details-anchor edit failed for "${detailsAction.slug}" turn ${detailsAction.turnSeq}, falling back to a new message: ${(err as Error).message}`);
                if (fitsInOneMessage) confirmSessionCommand(threadId, text, "HTML");
              });
          } else if (fitsInOneMessage) {
            // No anchor on record (posted before this feature shipped, or the Bridge restarted
            // between posting it and this tap) - today's exact fallback behaviour.
            confirmSessionCommand(threadId, text, "HTML");
          }

          if (!fitsInOneMessage) {
            // §5.5: "Diffs always go as documents" - the same reasoning applies to a details log
            // too long to fit in one message. Plain text, not renderDetails's HTML markup - a
            // document viewer has no HTML renderer to make that markup invisible.
            const plainText = stillCurrent ? renderDetailsPlainText(state, verboseDetails) : text;
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
          feedWiring.maybeSetState(pending.slug, "working");

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
          // `take`, not `resolve`: an expired card has to *say* it expired. `answerCallbackQuery`
          // above already cleared the spinner, so returning silently here left the operator with a
          // tap that visibly did nothing - §6.5's stated failure mode.
          const pending = confirmCards.takeOrNotifyGone(fleetConfirmRegistry, fleetConfirmAction.id, callbackQuery.message?.message_id, (entry) =>
            void confirmCards.markConfirmCardExpired(entry.messageId),
          );
          if (!pending) return;
          if (pending.kind !== fleetConfirmAction.kind) return;
          if (!fleetConfirmAction.confirmed) {
            void confirmCards.finalizeFleetConfirmMessage(pending, "Cancelled - nothing was changed.");
            return;
          }
          void executeFleetConfirm(pending);
          return;
        }

        // `/browse`/`/find`'s own navigation - "br:"/"bf:"/"bv:"/"bs:", four fresh namespaces
        // (browse-nav.ts). Edits whichever message the tap came from (telegram.ts's own doc
        // comment on why `message_id` is read straight off the callback here, unlike every other
        // flow above), so a missing `message_id` (an old/mocked client) is a silent no-op.
        const browseAction = callbackQuery.data ? resolveBrowseCallback(callbackQuery.data) : null;
        if (browseAction) {
          const browseMessageId = callbackQuery.message?.message_id;
          if (browseMessageId === undefined) return;
          browseRegistry.sweep();
          const stored = browseRegistry.get(browseAction.id);
          if (!stored) {
            controlBot
              .editMessageText?.(config.supergroupChatId, browseMessageId, "This browse session has expired - run /browse or /find again.", { inline_keyboard: [] })
              .catch((err) => log("WARN", `failed to finalize expired browse message: ${(err as Error).message}`));
            return;
          }
          const worktreePath = routing.get(stored.slug)?.worktreePath;
          if (!worktreePath) return; // the session behind this id is gone

          if (browseAction.kind === "dir" && stored.entry.kind === "dir") {
            const listing = listDirectory(worktreePath, stored.entry.relPath, browseAction.page);
            const text = listing ? renderDirText(listing) : "That folder no longer exists.";
            const keyboard = listing ? buildDirKeyboard(browseRegistry, stored.slug, listing) : [];
            controlBot
              .editMessageText?.(config.supergroupChatId, browseMessageId, text, { inline_keyboard: keyboard })
              .catch((err) => log("WARN", `editMessageText (browse dir) failed: ${(err as Error).message}`));
            return;
          }

          if (browseAction.kind === "file_menu" && stored.entry.kind === "file") {
            const githubUrl = resolveGithubLink(worktreePath, stored.entry.relPath);
            controlBot
              .editMessageText?.(config.supergroupChatId, browseMessageId, `📄 /${stored.entry.relPath}`, {
                inline_keyboard: buildFileActionKeyboard(browseAction.id, githubUrl),
              })
              .catch((err) => log("WARN", `editMessageText (browse file menu) failed: ${(err as Error).message}`));
            return;
          }

          if (browseAction.kind === "file_action" && stored.entry.kind === "file") {
            if (browseAction.action === "view") {
              const preview = readForPreview(worktreePath, stored.entry.relPath, stored.entry.matchLine);
              // No parse_mode here - preview.text is arbitrary, unescaped file content, and both
              // Telegram's Markdown and HTML modes would try to interpret stray backticks/`<`/`&`
              // in it as real formatting (feed-escape.ts exists precisely because that's unsafe
              // without escaping first). Plain text only.
              const text = !preview
                ? "That file no longer exists."
                : preview.tooLarge
                  ? "That file is too large to preview here - try Send file instead."
                  : preview.binary
                    ? "That looks like a binary file - use Send file instead."
                    : `${preview.text}${preview.truncated ? "\n(truncated)" : ""}`;
              const githubUrl = resolveGithubLink(worktreePath, stored.entry.relPath);
              controlBot
                .editMessageText?.(config.supergroupChatId, browseMessageId, text, { inline_keyboard: buildFileActionKeyboard(browseAction.id, githubUrl) })
                .catch((err) => log("WARN", `editMessageText (browse view) failed: ${(err as Error).message}`));
            } else {
              const prep = prepareFileForSend(worktreePath, stored.entry.relPath);
              if (!prep) {
                confirmSessionCommand(threadId, "That file no longer exists.");
              } else if (prep.tooLarge) {
                confirmSessionCommand(threadId, `"${prep.filename}" is too large to send here (over ${Math.round(MAX_SEND_BYTES / (1024 * 1024))}MB).`);
              } else if (controlBot.sendDocumentFile) {
                controlBot
                  .sendDocumentFile(config.supergroupChatId, threadId, prep.filename, prep.bytes)
                  .catch((err) => log("WARN", `sendDocumentFile (browse send) failed: ${(err as Error).message}`));
              }
            }
            return;
          }

          if (browseAction.kind === "hits" && stored.entry.kind === "hitset") {
            controlBot
              .editMessageText?.(config.supergroupChatId, browseMessageId, renderHitsText(stored.entry.query, stored.entry, browseAction.page), {
                inline_keyboard: buildHitsKeyboard(browseRegistry, stored.slug, browseAction.id, stored.entry.hits, browseAction.page),
              })
              .catch((err) => log("WARN", `editMessageText (browse hits) failed: ${(err as Error).message}`));
          }
          return;
        }

        // nl-router.ts's destructive-command confirm keyboard (nl-confirm.ts) - "nc:", a fresh
        // namespace alongside "fc:"/"vc:"/"sc:"/"d:". "Run" and "run, don't ask again" both
        // execute the pending command through the same `executeMatchedCommand` a non-destructive
        // NL match already uses; "don't ask again" additionally flips `assistEnabled` off first
        // (and persists it) so every subsequent NL-matched destructive command skips this card
        // until `/assist on` turns it back on.
        const nlConfirmAction = callbackQuery.data ? resolveNlConfirmCallback(callbackQuery.data) : null;
        if (nlConfirmAction) {
          const pending = confirmCards.takeOrNotifyGone(nlConfirmRegistry, nlConfirmAction.id, callbackQuery.message?.message_id, (entry) =>
            void confirmCards.markNlConfirmCardExpired(entry),
          );
          if (!pending) return;
          if (nlConfirmAction.action === "cancel") {
            void confirmCards.finalizeNlConfirmMessage(pending, "❌ Cancelled - nothing was changed.");
            return;
          }
          if (nlConfirmAction.action === "run_and_stop_asking") {
            assistEnabled = false;
            settingsStore.set("assist_enabled", "false");
          }
          void confirmCards.finalizeNlConfirmMessage(pending, `✅ Running ${describeNlCommand(pending.command)}${nlConfirmAction.action === "run_and_stop_asking" ? " (confirmation now off - /assist on to re-enable)" : ""}.`);
          const pendingIsControl = isControlTopic(pending.threadId);
          executeMatchedCommand(pending.command, pending.threadId, pendingIsControl, pending.currentSlug);
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
          const pending = confirmCards.takeOrNotifyGone(staleConfirmRegistry, staleConfirmAction.id, callbackQuery.message?.message_id, (entry) =>
            void confirmCards.markConfirmCardExpired(entry.confirmCardMessageId),
          );
          if (!pending) return;
          if (!staleConfirmAction.confirmed) {
            void confirmCards.finalizeStaleConfirmMessage(pending, "Cancelled - not actioned.");
            return;
          }
          void confirmCards.finalizeStaleConfirmMessage(pending, "✅ Confirmed - processing now.");
          const pendingIsControl = isControlTopic(pending.threadId);
          const pendingRoute = pending.threadId !== undefined ? routing.getByTopicId(pending.threadId) : undefined;
          void dispatchInboundMessage(pending.messageId, pending.rawText, pending.threadId, pendingIsControl, pendingRoute, pendingRoute?.slug, pending.from, buildContextPrefix(pending.origin));
          return;
        }

        // Voice input's own confirm keyboard (voice-confirm.ts) - "vc:", a fresh namespace
        // alongside "sc:"/"fc:"/"d:". "Re-record"/"Type instead"/"Cancel" all discard the
        // transcript; they differ only in which follow-up text is shown, so all three fall into
        // the same finalize call below rather than needing separate registry/dispatch handling.
        // "Send, don't ask again" additionally flips `voiceConfirmEnabled` off (and persists it)
        // before sending, the typeable equivalent being `/voiceconfirm off`.
        const voiceConfirmAction = callbackQuery.data ? resolveVoiceConfirmCallback(callbackQuery.data) : null;
        if (voiceConfirmAction) {
          const pending = confirmCards.takeOrNotifyGone(voiceConfirmRegistry, voiceConfirmAction.id, callbackQuery.message?.message_id, (entry) =>
            void confirmCards.markConfirmCardExpired(entry.confirmCardMessageId),
          );
          if (!pending) return;
          if (voiceConfirmAction.action === "send" || voiceConfirmAction.action === "send_and_stop_asking") {
            if (voiceConfirmAction.action === "send_and_stop_asking") {
              voiceConfirmEnabled = false;
              settingsStore.set("voice_confirm_enabled", "false");
            }
            void confirmCards.finalizeVoiceConfirmMessage(pending, voiceConfirmAction.action === "send_and_stop_asking" ? "✅ Sent (confirmation now off - /voiceconfirm on to re-enable)." : "✅ Sent.");
            const pendingIsControl = isControlTopic(pending.threadId);
            const pendingRoute = pending.threadId !== undefined ? routing.getByTopicId(pending.threadId) : undefined;
            void dispatchInboundMessage(pending.messageId, pending.transcript, pending.threadId, pendingIsControl, pendingRoute, pendingRoute?.slug, pending.from, buildContextPrefix(pending.origin));
            return;
          }
          const doneText =
            voiceConfirmAction.action === "rerecord"
              ? "🔁 Discarded - send another voice note whenever you're ready."
              : voiceConfirmAction.action === "type"
                ? "✏️ Discarded - go ahead and type it."
                : "❌ Cancelled.";
          void confirmCards.finalizeVoiceConfirmMessage(pending, doneText);
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

        // The trailing "✖️ Cancel" row on the /model, /mode and /effort pickers (session-commands.ts's
        // buildLevelKeyboard) - checked ahead of the three resolve* calls below since "cancel" is
        // deliberately never a valid level for any of them and would otherwise just look like an
        // unrecognised tap. Edits the card to a plain "Cancelled." with the keyboard stripped,
        // rather than leaving a stale keyboard sitting there or a whole new message.
        if (callbackQuery.data && (isModelCancelCallback(callbackQuery.data) || isModeCancelCallback(callbackQuery.data) || isEffortCancelCallback(callbackQuery.data))) {
          const cancelMsgId = callbackQuery.message?.message_id;
          if (cancelMsgId !== undefined && controlBot.editMessageText) {
            controlBot
              .editMessageText(config.supergroupChatId, cancelMsgId, "Cancelled.", { inline_keyboard: [] })
              .catch((err) => log("WARN", `editMessageText (cancel) failed: ${(err as Error).message}`));
          }
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

        // `/default`'s three-namespace picker flow: "default:mode"/"default:effort" (the top-level
        // category keyboard) edits the same message into that category's own value picker;
        // "defmode:<value>"/"defeffort:<value>" (that picker's own buttons) applies the change and
        // edits the message into a plain confirmation; either picker's own Cancel row edits to
        // "Cancelled.". All three edit in place - unlike the session-scoped /model|/mode|/effort
        // pickers above, which only ever confirm via a *new* message (`applyModelSwitch` etc.),
        // `/default` has no `currentSlug` to hand off to and the picker itself is the whole UI, so
        // editing it through each step reads as one drill-down instead of a new message per tap.
        const defaultMsgId = callbackQuery.message?.message_id;
        if (callbackQuery.data && defaultMsgId !== undefined && controlBot.editMessageText) {
          const category = resolveDefaultCategoryCallback(callbackQuery.data);
          if (category) {
            const [prompt, keyboard] =
              category === "mode"
                ? [`Choose the default permission mode for new sessions (current: ${defaultSessionMode}):`, buildDefaultModeKeyboard(defaultSessionMode)]
                : [`Choose the default effort level for new sessions (current: ${defaultSessionEffort}):`, buildDefaultEffortKeyboard(defaultSessionEffort)];
            controlBot
              .editMessageText(config.supergroupChatId, defaultMsgId, prompt, { inline_keyboard: keyboard })
              .catch((err) => log("WARN", `editMessageText (/default category) failed: ${(err as Error).message}`));
            return;
          }
          if (
            isDefaultCategoryCancelCallback(callbackQuery.data) ||
            isDefaultModeCancelCallback(callbackQuery.data) ||
            isDefaultEffortCancelCallback(callbackQuery.data)
          ) {
            controlBot
              .editMessageText(config.supergroupChatId, defaultMsgId, "Cancelled.", { inline_keyboard: [] })
              .catch((err) => log("WARN", `editMessageText (/default cancel) failed: ${(err as Error).message}`));
            return;
          }
          const defaultMode = resolveDefaultModeCallback(callbackQuery.data);
          if (defaultMode) {
            controlBot
              .editMessageText(config.supergroupChatId, defaultMsgId, applyDefaultMode(defaultMode), { inline_keyboard: [] })
              .catch((err) => log("WARN", `editMessageText (/default mode) failed: ${(err as Error).message}`));
            return;
          }
          const defaultEffort = resolveDefaultEffortCallback(callbackQuery.data);
          if (defaultEffort) {
            controlBot
              .editMessageText(config.supergroupChatId, defaultMsgId, applyDefaultEffort(defaultEffort), { inline_keyboard: [] })
              .catch((err) => log("WARN", `editMessageText (/default effort) failed: ${(err as Error).message}`));
            return;
          }
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
        if (currentSlug) ptyIo.sendRaw(currentSlug, `/${action.name}`);
        return;
      }

      const message = update.message;
      if (!message) return;
      if (String(message.chat.id) !== config.supergroupChatId) return;

      const threadId = message.message_thread_id;
      const isControl = isControlTopic(threadId);
      const route = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
      const currentSlug = route?.slug;
      // A topic with no *live route* may still be a topic this Bridge knows about: a `dead` row's
      // topic (reconciliation only re-routes non-dead rows, so every `/kill`ed session's topic
      // loses its route on the next restart), or an orphaned topic whose row is gone entirely -
      // §4.5.2's own recovery instruction is for the operator to send `/rm` *in that topic*.
      // Dropping those outright made that instruction impossible to follow and silently swallowed
      // `/help` too, which is also what made the live diagnosis of §4.5.2 ambiguous: an unanswered
      // command there was indistinguishable from a dead Bot-API thread.
      // An *unrouted* topic gets explicit slash commands dispatched (so `/rm` and `/help` work
      // there) but not free text - including a topic whose row is only `dead`. Without that
      // narrowing, ordinary chatter in an unrelated forum topic, or a reply typed into a killed
      // session's topic, would fall through to the NL router and spend an LLM call answering
      // something no session can act on anyway.
      // A *known* command specifically, not merely a leading "/": anything else in an unrouted topic
      // would fall through to the NL router and spend an LLM call answering something no session can
      // act on. A topic this Bridge still has a row for is let through regardless of shape, so §4.3's
      // "this session has ended" acknowledgement can fire there.
      const knownRow = threadId !== undefined ? sessionStore.getByTopicId(threadId) : undefined;
      if (!isControl && !route && knownRow === undefined && !isKnownCommandText(message.text)) return;

      const from = message.from?.username ?? message.from?.first_name ?? "unknown";

      // §7.4, checked before *any* content branch below. It used to sit after the media handlers,
      // so every attachment path bypassed it: a document queued while the laptop slept, captioned
      // "yes, push it", was downloaded into the worktree and written straight into the live PTY on
      // resume - the exact surprise §7.4 exists to prevent, quoted almost word for word there.
      // Voice notes remain the one deliberate exception (their own confirm card, below).
      const nowMs = Date.now();
      // Only content this Bridge would actually act on is gated. Without that narrowing the `else`
      // branch below fired for every *service* message too (forum_topic_created/_edited,
      // pinned_message, new_chat_members) and for stickers/polls/locations, all of which previously
      // fell through to `if (!message.text) return` - so a backlog replay after downtime posted a
      // spurious "an attachment arrived while offline" notice for each one.
      const hasActionableContent = message.text !== undefined || hasAttachment(message);
      if (hasActionableContent && !message.voice && isStaleInbound(message.date, nowMs)) {
        if (message.text !== undefined) {
          void postStaleConfirm(threadId, message.message_id, message.text, from, formatStaleAge(message.date, nowMs), message);
        } else {
          // An attachment gets a plain notice rather than a replayable confirm card: replaying one
          // would mean holding its `file_id` and re-running the download later, and a re-send from
          // the phone is both cheaper and unambiguous. The point is that it isn't silently landed
          // in the worktree and announced to a live session.
          void notifyStaleAttachment(threadId, formatStaleAge(message.date, nowMs));
        }
        return;
      }

      // Voice input - a recorded voice note, not a forwarded/uploaded audio file (message.audio,
      // unhandled). Goes through its own confirm-card path (handleVoiceMessage), and is the one
      // deliberate exemption from the §7.4 gate above: staleness of the *card* (voice-confirm.ts's
      // own TTL) is what matters, not staleness of when the note was recorded, because nothing
      // reaches the session until the operator taps Send on a transcript they can read.
      if (message.voice) {
        void handleVoiceMessage(message.voice, threadId, message.message_id, from, message.date, message);
        return;
      }

      // §5.6: photos/documents/videos/audio/video-notes - landed in the session's inbox and
      // announced by path rather than transcribed. `photo` arrives as one entry per resolution,
      // smallest to largest; the largest is the one worth downloading. Telegram allows a message
      // to carry at most one kind of media, so these are mutually exclusive with each other and
      // with `voice`/`text` above - order here doesn't matter beyond that.
      if (message.photo && message.photo.length > 0) {
        const largest = message.photo[message.photo.length - 1]!;
        void handleAttachmentMessage("image", largest.file_id, largest.file_size, undefined, undefined, threadId, route, isControl, message.message_id, message.caption, from, message);
        return;
      }
      if (message.document) {
        const doc = message.document;
        void handleAttachmentMessage("document", doc.file_id, doc.file_size, doc.file_name, doc.mime_type, threadId, route, isControl, message.message_id, message.caption, from, message);
        return;
      }
      if (message.video) {
        const video = message.video;
        void handleAttachmentMessage("video", video.file_id, video.file_size, video.file_name, video.mime_type, threadId, route, isControl, message.message_id, message.caption, from, message);
        return;
      }
      if (message.audio) {
        const audio = message.audio;
        void handleAttachmentMessage("audio", audio.file_id, audio.file_size, audio.file_name, audio.mime_type, threadId, route, isControl, message.message_id, message.caption, from, message);
        return;
      }
      if (message.video_note) {
        const note = message.video_note;
        void handleAttachmentMessage("video note", note.file_id, note.file_size, undefined, undefined, threadId, route, isControl, message.message_id, message.caption, from, message);
        return;
      }

      if (!message.text) return;

      // §7.4's gate already ran above, before any content branch - nothing below ever sees a stale
      // message.
      void dispatchInboundMessage(message.message_id, message.text, threadId, isControl, route, currentSlug, from, buildContextPrefix(message));
    },
    onError: (err) => {
      log("WARN", `getUpdates failed, retrying: ${(err as Error).message}`);
    },
  });

  log("INFO", "Bridge started - getUpdates loop running");

  // §5.9: this boot reached the end of startup without throwing, so any deploy marker still
  // sitting here is *this* attempt succeeding, not a crash-loop - confirm it to the operator and
  // clear it so the stale-marker check above never sees it again.
  {
    const marker = readDeployMarker(STATE_DIR);
    if (marker) {
      clearDeployMarker(STATE_DIR);
      try {
        await controlBot.sendMessage(
          marker.chatId,
          marker.topicId,
          `✅ Deploy succeeded - Bridge is back up on ${marker.newHeadSha.slice(0, 8)} ("${marker.branch}").`,
        );
      } catch (err) {
        log("WARN", `failed to send deploy-success notice: ${(err as Error).message}`);
      }
    }
  }
}

await main();
