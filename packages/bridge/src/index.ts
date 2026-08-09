import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import type * as pty from "node-pty";
import { renderAskCancelledCard } from "./ask-callback.ts";
import { buildRunArgs } from "./autostart.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import { loadConfig, STATE_DIR } from "./config.ts";
import { initFileLogging, log } from "./logger.ts";
import { clearDeployMarker, isDeployMarkerStale, readDeployMarker, rollbackStaleDeploy } from "./deploy.ts";
import { DetailsAnchorStore, DETAILS_ANCHOR_RETENTION_MS } from "./details-anchor-store.ts";
import { BrowseRegistry } from "./browse-nav.ts";
import { FleetConfirmRegistry } from "./fleet-confirm.ts";
import { createOsPowerCommands, OsConfirmRegistry } from "./os-power-commands.ts";
import { StaleConfirmRegistry } from "./stale-confirm.ts";
import { VoiceConfirmRegistry } from "./voice-confirm.ts";
import { startWhisperServer } from "./voice-transcribe.ts";
import { NlConfirmRegistry } from "./nl-confirm.ts";
import { LateBound } from "./late-bound.ts";
import { RetryStore } from "./retry-store.ts";
import { ChannelConnectCoordinator } from "./channel-connect-coordinator.ts";
import type { RouterAction } from "./nl-router.ts";
import { SettingsStore } from "./settings-store.ts";
import { botCommandList } from "./fleet-commands.ts";
import { monotonicNowMs } from "./monotonic-clock.ts";
import { CostTracker } from "./cost-tracker.ts";
import { CostStore } from "./cost-store.ts";
import { startOtlpListener } from "./otlp-listener.ts";
import { sweepExpiredPermissions } from "./permission-registry.ts";
import { loadReposRegistry, type ReposRegistry } from "./repos-registry.ts";
import { launchSession, resolveNodeExecutable } from "./session-launcher.ts";
import { startPipeServer } from "./pipe-server.ts";
import { RateGovernor } from "./rate-governor.ts";
import { Routing } from "./routing.ts";
import { DEFAULT_EFFORT, DEFAULT_MODE, EFFORTS, MODES } from "./session-commands.ts";
import type { Effort, Mode, SessionCommand } from "./session-commands.ts";
import { SessionStore, type SessionRow, type SessionState } from "./session-store.ts";
import { looksEnglishEnough } from "./language-heuristic.ts";
import { startPolling, TelegramClient, validateTokens } from "./telegram.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";
import { loadOffset, saveOffset } from "./telegram-offset.ts";
import { createThinkingPlaceholder } from "./thinking-placeholder.ts";
import { createTypingIndicator } from "./typing-indicator.ts";
import { restartSettleDelayMs } from "./restart-settle.ts";
import { createSessionSupervisor } from "./session-supervisor.ts";
import { createPtyIo, DEFAULT_ECHO_SETTLE_MS, DEFAULT_SUBMIT_CONFIRM_WINDOW_MS } from "./pty-io.ts";
import { createFeedWiring } from "./feed-wiring.ts";
import { createQuotaAlarms, DEFAULT_BURN_RATE_THRESHOLD_USD } from "./quota-alarms.ts";
import { createConfirmCards } from "./confirm-cards.ts";
import { createInboundMedia } from "./inbound-media.ts";
import { createSessionLifecycleCommands, ORPHAN_TOPIC_NOTE } from "./session-lifecycle-commands.ts";
import type { SessionLifecycleCommands } from "./session-lifecycle-commands.ts";
import { createFleetReportingCommands } from "./fleet-reporting-commands.ts";
import { createDeployLifecycleCommands, createProcessRunner } from "./deploy-lifecycle-commands.ts";
import { createVoiceModeCommands } from "./voice-mode-commands.ts";
import { createConfirmSessionCommand, createFleetConfirmFlow, createStopIndicatorsForTopic } from "./fleet-confirm-flow.ts";
import type { FleetConfirmFlow } from "./fleet-confirm-flow.ts";
import { createCardSenders } from "./card-senders.ts";
import { createNlDispatch } from "./nl-dispatch.ts";
import { createCommandDispatch } from "./command-dispatch.ts";
import type { CommandDispatch } from "./command-dispatch.ts";
import { createCallbackQueryRouter } from "./callback-query-router.ts";

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

  // Constructed this early (ahead of sessionStore/routing/etc.) because `respawnSelfAndExit`
  // below can fire from the stale-deploy rollback check a few lines down, before any of that
  // later state exists - `runSchtasks` is the one deploy-lifecycle-commands.ts export it needs.
  // `deployLifecycle` itself (constructed further down, once sessionStore exists) reuses this
  // same instance rather than building its own.
  const processRunner = createProcessRunner();

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

  // fleet-confirm-flow.ts: `confirmSessionCommand` is the P1-lane-wrapped send primitive nearly
  // every other module in this split is built on (session-supervisor.ts, feed-wiring.ts,
  // confirm-cards.ts, and every fleet-command module extracted so far) - constructed this early,
  // right after its one dependency (`feedGovernor`) exists, rather than alongside the rest of
  // fleet-confirm-flow.ts's own exports (which need `sessionLifecycle`, not yet constructed here).
  const confirmSessionCommand = createConfirmSessionCommand({ feedGovernor, controlBot, supergroupChatId: config.supergroupChatId, log });

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
  // `/os shutdown|reboot` (os-power-commands.ts) - same confirm-button pattern as `/kill --all`
  // above, for a strictly more consequential action (kills the Bridge itself, not just a session).
  const osConfirmRegistry = new OsConfirmRegistry();
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

  // command-dispatch.ts's `dispatchFleetCommand`/`dispatchInboundMessage` are real two-way
  // dependencies with both `nlDispatch` (below) and `inboundMedia` (right below) - `commandDispatch`
  // itself isn't constructed until after `sessionLifecycle`/`fleetReporting`/`fleetConfirmFlow`/
  // `deployLifecycle`/`voiceModeCommands`/`cardSenders`/`feedWiring`/`nlDispatch` all exist.
  // `LateBound` (late-bound.ts) makes that "resolved before it's ever called, never before it's
  // assigned" invariant explicit and checked at the point of failure, rather than resting on this
  // comment alone - same pattern `fleetConfirmFlow` (fleet-confirm-flow.ts, item 11) uses below.
  const commandDispatch = new LateBound<CommandDispatch>();

  // `sessionLifecycle` (session-lifecycle-commands.ts) isn't constructed until well after
  // `inboundMedia` - same forward-reference shape as `commandDispatch` just above, needed so a
  // control-topic attachment's `/new`-caption path (inbound-media.ts) can reach
  // `handleNewCommand` without a static import in either direction
  // (attachment-triggered-session-creation-plan.md's Module Ownership & Wiring section).
  const sessionLifecycleLate = new LateBound<SessionLifecycleCommands>();

  // inbound-media.ts: voice/attachment handling plus the onUpdate plain-message routing entry
  // point - `dispatchInboundMessage` and `voiceConfirmEnabled` (read live via a getter, not a
  // snapshot, since `/voiceconfirm` flips it at runtime) are both injected.
  const inboundMedia = createInboundMedia({
    controlBot,
    feedGovernor,
    routing,
    sessionStore,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    confirmSessionCommand,
    dispatchInboundMessage: (messageId, rawText, threadId, isControl, route, currentSlug, from, contextPrefix, replyToText) =>
      commandDispatch.get().dispatchInboundMessage(messageId, rawText, threadId, isControl, route, currentSlug, from, contextPrefix, replyToText),
    createSessionFromAttachment: (cmd, controlTopicId) => sessionLifecycleLate.get().handleNewCommand(cmd, controlTopicId),
    // Kill switch (attachment-triggered-session-creation-plan.md's Attachment-to-Session Handoff
    // section) - a cheap, reversible way to disable just this trigger path without touching
    // anything else, given this plan documents a couple of risks (the widened slug race, git
    // worktree collisions) it deliberately doesn't fully close.
    disableCaptionNew: process.env.AIBRIDGE_DISABLE_CAPTION_NEW === "1",
    // Feature A of the caption-triggered `/new` follow-up: NL-router fallback for a freeform
    // caption. Plain values/getters (not `LateBound`) - both already exist by this point in the
    // composition root, same as `nlDispatch`'s own construction further down uses.
    nlRouterConfig: config.nlRouter,
    getNlRouterBackend: () => nlRouterBackend,
    getReposRegistry: () => reposRegistry,
    isControlTopic,
    voiceConfirmEnabled: () => voiceConfirmEnabled,
    voice: config.voice,
    supergroupChatId: config.supergroupChatId,
    stateDir: STATE_DIR,
    log,
  });

  // `/browse`/`/find`'s own id-per-row registry (browse-nav.ts) - unlike the confirm registries
  // above, entries here are non-consuming (a folder's Prev/Next can be tapped repeatedly) and never
  // store a messageId - a tap edits whichever message it came from, read straight off the callback.
  const browseRegistry = new BrowseRegistry();

  // card-senders.ts: /about, /help, /commands, /skills, /browse, /find, /diff - thin wrappers
  // around already-tested renderers, each reached by both an exact-syntax command and its
  // NL-matched equivalent (nl-router.ts).
  const cardSenders = createCardSenders({
    controlBot,
    confirmSessionCommand,
    browseRegistry,
    supergroupChatId: config.supergroupChatId,
    log,
  });

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

  const voiceModeCommands = createVoiceModeCommands({
    ptyIo,
    routing,
    sessionStore,
    settingsStore,
    controlBot,
    confirmSessionCommand,
    voiceServer,
    voiceModelPath: config.voice.modelPath,
    getAssistEnabled: () => assistEnabled,
    setAssistEnabled: (value) => {
      assistEnabled = value;
    },
    getVoiceConfirmEnabled: () => voiceConfirmEnabled,
    setVoiceConfirmEnabled: (value) => {
      voiceConfirmEnabled = value;
    },
    getDefaultSessionMode: () => defaultSessionMode,
    setDefaultSessionMode: (mode) => {
      defaultSessionMode = mode;
    },
    getDefaultSessionEffort: () => defaultSessionEffort,
    setDefaultSessionEffort: (effort) => {
      defaultSessionEffort = effort;
    },
    getNlRouterBackend: () => nlRouterBackend,
    setNlRouterBackend: (backend) => {
      nlRouterBackend = backend;
    },
    nlRouterApiKeyConfigured: Boolean(config.nlRouter.apiKey),
    supergroupChatId: config.supergroupChatId,
    log,
  });

  // fleet-confirm-flow.ts: no dependency on sessionLifecycle, so constructed directly here rather
  // than needing the forward-reference treatment postFleetConfirm/executeFleetActionDirect below
  // need (see fleetConfirmFlow's own construction, further down, for why those two do).
  const stopIndicatorsForTopic = createStopIndicatorsForTopic({
    typingIndicator,
    thinkingPlaceholder,
    controlBot,
    feedGovernor,
    supergroupChatId: config.supergroupChatId,
    log,
  });

  // fleet-confirm-flow.ts's `createFleetConfirmFlow` genuinely needs `sessionLifecycle` (for
  // killSessionRow/removeSessionRow/resolveTargetSlug), but `sessionLifecycle` itself takes
  // `postFleetConfirm`/`executeFleetActionDirect` as injected callbacks - a real two-way
  // dependency. Broken the same way a hoisted function declaration would have broken it pre-split:
  // `sessionLifecycle` is constructed first, with `postFleetConfirm`/`executeFleetActionDirect`
  // wrapped in closures over `fleetConfirmFlow` below, which isn't assigned until right after -
  // safe, since neither closure is ever called until well after both consts exist. `LateBound`
  // (late-bound.ts) makes that safety checked rather than just documented - see `commandDispatch`'s
  // own comment above for the full reasoning.
  const fleetConfirmFlow = new LateBound<FleetConfirmFlow>();

  // session-lifecycle-commands.ts: /new, /ls, /kill, /rm, /attach, /pause, /detail, /verbose, plus
  // the shared resolveTargetSlug/resolveSessionOrBail helpers.
  const sessionLifecycle = createSessionLifecycleCommands({
    sessionStore,
    routing,
    controlBot,
    sessionSupervisor,
    ptyIo,
    feedWiring,
    permissionRegistry: pipeHandle.permissionRegistry,
    askRegistry: pipeHandle.askRegistry,
    costTracker,
    fleetConfirmRegistry,
    confirmSessionCommand,
    finalizePermissionMessage: (messageId, text) => pipeHandle.finalizePermissionMessage(messageId, text),
    stopIndicatorsForTopic,
    postFleetConfirm: (kind, topicId, targets, promptText) => fleetConfirmFlow.get().postFleetConfirm(kind, topicId, targets, promptText),
    executeFleetActionDirect: (kind, topicId, targets) => fleetConfirmFlow.get().executeFleetActionDirect(kind, topicId, targets),
    writeModeKeystrokes: voiceModeCommands.writeModeKeystrokes,
    waitForChannelConnected,
    isControlTopic,
    getReposRegistry: () => reposRegistry,
    getDefaultSessionMode: () => defaultSessionMode,
    getDefaultSessionEffort: () => defaultSessionEffort,
    supergroupChatId: config.supergroupChatId,
    selfCheckSlug: config.selfCheck.slug,
    fleetWorktreesRoot,
    otlpPort,
    stateDir: STATE_DIR,
    log,
  });
  sessionLifecycleLate.set(sessionLifecycle);

  fleetConfirmFlow.set(
    createFleetConfirmFlow({
      controlBot,
      routing,
      sessionStore,
      confirmCards,
      fleetConfirmRegistry,
      sessionLifecycle,
      confirmSessionCommand,
      usageWaiters,
      orphanTopicNote: ORPHAN_TOPIC_NOTE,
      supergroupChatId: config.supergroupChatId,
      log,
    }),
  );

  const fleetReporting = createFleetReportingCommands({
    controlBot,
    sessionStore,
    costTracker,
    confirmSessionCommand,
    isControlTopic,
    getReposRegistry: () => reposRegistry,
    setReposRegistry: (registry) => {
      reposRegistry = registry;
    },
    reposTomlPath,
    supergroupChatId: config.supergroupChatId,
    log,
  });

  // `respawnSelfAndExit` is a hoisted function declaration (defined further down this same scope,
  // adjacent to `main()`'s own startup sequencing per the plan's Risks - its `bootReadyAt` settle
  // delay is safety-critical and stays put) - injected here as a callback rather than relocated.
  const deployLifecycle = createDeployLifecycleCommands({
    sessionStore,
    controlBot,
    confirmSessionCommand,
    isControlTopic,
    runSchtasks: processRunner.runSchtasks,
    runPowershell: processRunner.runPowershell,
    respawnSelfAndExit,
    stateDir: STATE_DIR,
    supergroupChatId: config.supergroupChatId,
    entryScriptDir: import.meta.dirname,
    log,
  });

  // os-power-commands.ts: `/os shutdown|reboot|cancel` (plans/swirling-crafting-pixel.md) - host
  // power control, confirm-gated the same way `/kill --all` is (fleet-confirm-flow.ts above), for a
  // strictly more consequential action.
  const osPowerCommands = createOsPowerCommands({
    controlBot,
    confirmSessionCommand,
    finalizeCard: confirmCards.finalizeCard,
    isControlTopic,
    osConfirmRegistry,
    runShutdown: processRunner.runShutdown,
    runPowershell: processRunner.runPowershell,
    supergroupChatId: config.supergroupChatId,
    log,
  });

  // nl-dispatch.ts: NL-router matching, the destructive-command confirm gate, and executing a
  // matched command through the exact same handlers a typed command uses.
  // `commandDispatch` (a `LateBound` above, alongside `inboundMedia`'s own forward reference to it)
  // isn't assigned until further down - `dispatchFleetCommand` below is a closure over it, same
  // reasoning as `inboundMedia`'s own `dispatchInboundMessage` option.
  const nlDispatch = createNlDispatch({
    controlBot,
    routing,
    ptyIo,
    typingIndicator,
    thinkingPlaceholder,
    cardSenders,
    applyModelSwitch: voiceModeCommands.applyModelSwitch,
    applyModeSwitch: voiceModeCommands.applyModeSwitch,
    applyEffortSwitch: voiceModeCommands.applyEffortSwitch,
    nlConfirmRegistry,
    dispatchFleetCommand: (fleetCmd, threadId, isControl, currentSlug) => commandDispatch.get().dispatchFleetCommand(fleetCmd, threadId, isControl, currentSlug),
    nlRouterConfig: config.nlRouter,
    getNlRouterBackend: () => nlRouterBackend,
    getAssistEnabled: () => assistEnabled,
    supergroupChatId: config.supergroupChatId,
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
    for (const entry of nlConfirmRegistry.takeExpired()) fireAndForget(confirmCards.markNlConfirmCardExpired(entry), log, "index sweep markNlConfirmCardExpired");
    for (const entry of fleetConfirmRegistry.takeExpired()) fireAndForget(confirmCards.markConfirmCardExpired(entry.messageId), log, "index sweep markConfirmCardExpired(fleet)");
    for (const entry of osConfirmRegistry.takeExpired()) fireAndForget(confirmCards.markConfirmCardExpired(entry.messageId), log, "index sweep markConfirmCardExpired(os)");
    for (const entry of staleConfirmRegistry.takeExpired()) fireAndForget(confirmCards.markConfirmCardExpired(entry.confirmCardMessageId), log, "index sweep markConfirmCardExpired(stale)");
    for (const entry of voiceConfirmRegistry.takeExpired()) fireAndForget(confirmCards.markConfirmCardExpired(entry.confirmCardMessageId), log, "index sweep markConfirmCardExpired(voice)");

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
    const ranViaTask = !(await processRunner.runSchtasks(buildRunArgs())).failed;
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

  // command-dispatch.ts: the exact-syntax `/command` switch (also reached by an NL-matched command
  // via `nlDispatch`'s `dispatchFleetCommand` callback below) and the full plain-text/command
  // dispatch gauntlet for every inbound message. Constructed after `nlDispatch` since
  // `dispatchInboundMessage` calls `nlDispatch.postNlConfirm`/`routeOrFallback` on its own
  // fallthrough paths - the reverse of the forward reference `nlDispatch` itself took to
  // `dispatchFleetCommand` while this module didn't exist yet.
  commandDispatch.set(
    createCommandDispatch({
      controlBot,
      routing,
      ptyIo,
      sessionStore,
      confirmSessionCommand,
      sessionLifecycle,
      fleetReporting,
      fleetConfirmFlow: fleetConfirmFlow.get(),
      deployLifecycle,
      osPowerCommands,
      voiceModeCommands,
      cardSenders,
      feedWiring,
      retryStore,
      nlDispatch,
      getReposRegistry: () => reposRegistry,
      supergroupChatId: config.supergroupChatId,
      log,
    }),
  );

  // callback-query-router.ts: every inline-keyboard tap's callback-query handling, one namespace
  // rule per `callback_data` prefix - constructed last of all the per-concern modules since it's
  // the one thing that needs nearly everything else already built.
  const callbackQueryRouter = createCallbackQueryRouter({
    controlBot,
    feedGovernor,
    routing,
    sessionStore,
    ptyIo,
    pipeHandle,
    feedWiring,
    detailsAnchorStore,
    confirmCards,
    fleetConfirmRegistry,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    nlConfirmRegistry,
    osConfirmRegistry,
    fleetConfirmFlow: fleetConfirmFlow.get(),
    osPowerCommands,
    browseRegistry,
    nlDispatch,
    commandDispatch: commandDispatch.get(),
    voiceModeCommands,
    confirmSessionCommand,
    isControlTopic,
    settingsStore,
    setAssistEnabled: (value) => {
      assistEnabled = value;
    },
    setVoiceConfirmEnabled: (value) => {
      voiceConfirmEnabled = value;
    },
    getDefaultSessionMode: () => defaultSessionMode,
    getDefaultSessionEffort: () => defaultSessionEffort,
    voiceServer,
    voiceModelPath: config.voice.modelPath,
    stateDir: STATE_DIR,
    supergroupChatId: config.supergroupChatId,
    log,
  });

  const offsetPath = path.join(STATE_DIR, "telegram-offset.json");
  startPolling(controlBot, {
    initialOffset: loadOffset(offsetPath),
    onOffsetChange: (offset) => saveOffset(offsetPath, offset, (err) => log("WARN", `failed to persist Telegram offset: ${(err as Error).message}`)),
    onUpdate: (update) => {
      if (update.callback_query) {
        callbackQueryRouter.routeCallbackQuery(update.callback_query);
        return;
      }

      const message = update.message;
      if (!message) return;
      inboundMedia.routeInboundMessage(message);
    },
    onError: (err) => {
      log("WARN", `getUpdates failed, retrying: ${(err as Error).message}`);
    },
    // §9, found live 2026-08-09: a throw from a single update's own routing (callback query or
    // inbound message) used to abort the rest of that batch and get logged as "getUpdates failed" -
    // the wrong cause, and it silently dropped every other update already queued behind the failing
    // one. Logged with the actual update_id so this is diagnosable, distinct from a real transport
    // failure above.
    onUpdateError: (update, err) => {
      log("ERROR", `onUpdate threw for update_id ${update.update_id}: ${(err as Error).message}`);
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
