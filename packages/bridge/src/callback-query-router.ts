import path from "node:path";
import { resolveAskCallback, renderAskAnsweredCard } from "./ask-callback.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import { buildContextPrefix } from "./message-context.ts";
import { ABOUT_TOPICS, resolveAboutCallback } from "./about.ts";
import { listRepoCommands, listRepoSkills, renderCommandsListText, renderSkillsListText, resolveCommandAction } from "./commands.ts";
import { parseDetailsCallback } from "./details-button.ts";
import type { DetailsAnchorStore } from "./details-anchor-store.ts";
import { renderDetails, renderDetailsPlainText } from "./feed-renderer.ts";
import { listAvailableVoiceModels, resolveVoiceModelCallback } from "./voice-model.ts";
import {
  BrowseRegistry,
  buildDirKeyboard,
  buildFileActionKeyboard,
  buildHitsKeyboard,
  renderDirText,
  renderHitsText,
  resolveBrowseCallback,
} from "./browse-nav.ts";
import { listDirectory, MAX_SEND_BYTES, prepareFileForSend, readForPreview, resolveGithubLink } from "./worktree-fs.ts";
import { FleetConfirmRegistry, resolveFleetConfirmCallback } from "./fleet-confirm.ts";
import { OsConfirmRegistry, resolveOsConfirmCallback } from "./os-power-commands.ts";
import { resolveStaleConfirmCallback, StaleConfirmRegistry } from "./stale-confirm.ts";
import { resolveVoiceConfirmCallback, VoiceConfirmRegistry } from "./voice-confirm.ts";
import { NlConfirmRegistry, resolveNlConfirmCallback } from "./nl-confirm.ts";
import { resolvePermCallback } from "./permission-callback.ts";
import { RepoPickRegistry, resolveRepoPickCallback } from "./repo-picker.ts";
import { deriveAlwaysRule, ruleAlreadyCovered } from "./rule-derivation.ts";
import { addAlwaysRule, readSettingsFile, writeSettingsFile } from "./settings.ts";
import {
  buildDefaultEffortKeyboard,
  buildDefaultModeKeyboard,
  isDefaultCategoryCancelCallback,
  isDefaultEffortCancelCallback,
  isDefaultModeCancelCallback,
  isEffortCancelCallback,
  isModeCancelCallback,
  isModelCancelCallback,
  resolveDefaultCategoryCallback,
  resolveDefaultEffortCallback,
  resolveDefaultToggleCallback,
  resolveDefaultModeCallback,
  resolveEffortCallback,
  resolveModeCallback,
  resolveModelCallback,
} from "./session-commands.ts";
import type { ConfirmEntry, ConfirmRegistry } from "./confirm-registry.ts";
import type { RateGovernor } from "./rate-governor.ts";
import type { Routing } from "./routing.ts";
import type { SessionStore } from "./session-store.ts";
import type { PipeServerHandle } from "./pipe-server.ts";
import type { FeedWiring } from "./feed-wiring.ts";
import type { ConfirmCards } from "./confirm-cards.ts";
import type { FleetConfirmFlow } from "./fleet-confirm-flow.ts";
import type { OsPowerCommands } from "./os-power-commands.ts";
import type { NlDispatch } from "./nl-dispatch.ts";
import type { CommandDispatch } from "./command-dispatch.ts";
import type { VoiceModeCommands } from "./voice-mode-commands.ts";
import type { PtyIo } from "./pty-io.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { WhisperServerHandle } from "./voice-transcribe.ts";
import type { Effort, Mode } from "./session-commands.ts";
import type { SendMessageSource, TelegramCallbackQuery } from "./telegram.ts";

/** `controlBot` here needs a few methods beyond the plain `SendMessageSource` every other module
 * gets away with: `answerCallbackQuery` (every callback query needs its spinner cleared, the very
 * first thing this module does) and `sendDocument` (the `/detail` button's oversized-log fallback,
 * §5.5's "diffs and outsized logs always go as documents"). Both are real `TelegramClient` methods
 * (telegram.ts) with no narrower interface of their own - defined inline rather than widening
 * `SendMessageSource` itself, which every other module's fake/stub controlBot would then need to
 * satisfy for no reason of their own. */
type CallbackControlBot = SendMessageSource & {
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
  sendDocument(chatId: string | number, messageThreadId: number | undefined, filename: string, content: string): Promise<{ message_id: number }>;
};

export interface CallbackQueryRouterOptions {
  controlBot: CallbackControlBot;
  feedGovernor: RateGovernor;
  routing: Routing;
  sessionStore: Pick<SessionStore, "get">;
  ptyIo: Pick<PtyIo, "sendRaw">;
  pipeHandle: Pick<PipeServerHandle, "answerAsk" | "completeAsk" | "finalizePermissionMessage" | "resolvePermission" | "sendVerdict">;
  feedWiring: Pick<FeedWiring, "maybeSetState" | "getFeedState">;
  detailsAnchorStore: DetailsAnchorStore;
  confirmCards: ConfirmCards;
  fleetConfirmRegistry: FleetConfirmRegistry;
  staleConfirmRegistry: StaleConfirmRegistry;
  voiceConfirmRegistry: VoiceConfirmRegistry;
  nlConfirmRegistry: NlConfirmRegistry;
  repoPickRegistry: RepoPickRegistry;
  osConfirmRegistry: OsConfirmRegistry;
  fleetConfirmFlow: Pick<FleetConfirmFlow, "executeFleetConfirm">;
  osPowerCommands: Pick<OsPowerCommands, "executeOsConfirm">;
  browseRegistry: BrowseRegistry;
  nlDispatch: Pick<NlDispatch, "describeNlCommand" | "executeMatchedCommand">;
  commandDispatch: Pick<CommandDispatch, "dispatchInboundMessage">;
  voiceModeCommands: Pick<
    VoiceModeCommands,
    "applyVoiceModelSwitch" | "applyModelSwitch" | "applyModeSwitch" | "applyEffortSwitch" | "applyDefaultMode" | "applyDefaultEffort" | "applyDefaultAutoToggle"
  >;
  confirmSessionCommand: ConfirmSessionCommand;
  isControlTopic: (threadId: number | undefined) => boolean;
  settingsStore: Pick<SettingsStore, "set">;
  setAssistEnabled: (value: boolean) => void;
  setVoiceConfirmEnabled: (value: boolean) => void;
  getDefaultSessionMode: () => Mode;
  getDefaultSessionEffort: () => Effort;
  voiceServer: WhisperServerHandle | null;
  voiceModelPath: string;
  stateDir: string;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface CallbackQueryRouter {
  routeCallbackQuery(callbackQuery: TelegramCallbackQuery): void;
}

/** Everything a namespace rule's `match`/`handle` pair below needs beyond `callbackQuery.data`
 * itself - the three already-computed values the old inline `onUpdate` branch closed over
 * directly. */
interface CallbackCtx {
  callbackQuery: TelegramCallbackQuery;
  threadId: number | undefined;
  currentSlug: string | undefined;
}

interface NamespaceRule {
  name: string;
  match(data: string | undefined, ctx: CallbackCtx): unknown;
  handle(matched: unknown, ctx: CallbackCtx): void;
}

function rule<M>(name: string, match: (data: string | undefined, ctx: CallbackCtx) => M | null | undefined, handle: (matched: M, ctx: CallbackCtx) => void): NamespaceRule {
  return {
    name,
    match,
    handle: (matched, ctx) => handle(matched as M, ctx),
  };
}

/**
 * §5-§6/§10's callback-query side of every inline keyboard the Bridge posts - one namespace per
 * `callback_data` prefix (`"ask:"`, `"perm:"`, `"fc:"`, `"br:"`/`"bf:"`/`"bv:"`/`"bs:"`, `"nc:"`,
 * `"rp:"`, `"sc:"`, `"vc:"`, `"vm:"`, the bare model/mode/effort cancel+value callbacks, `"default:"`/
 * `"defmode:"`/`"defeffort:"`, `"about:"`, and the catch-all `resolveCommandAction`). Reshaped from
 * the ~450-line sequential if-chain that used to sit inline inside `onUpdate` into an ordered
 * `NAMESPACE_RULES` table, same "order is data, not buried in control flow" treatment
 * `command-dispatch.ts` (item 14) gave `dispatchInboundMessage`'s exact-syntax checks - each
 * namespace's own `resolve*Callback` parser already refuses anything outside its own prefix, so
 * (unlike that module) there is no real shadowing risk between rules here; the table is for
 * readability and per-namespace testability, not a bug fix. **Not an Open/Closed fix** - adding a
 * sixteenth namespace still means editing this table, same as editing a switch statement would.
 */
export function createCallbackQueryRouter(opts: CallbackQueryRouterOptions): CallbackQueryRouter {
  const {
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
    repoPickRegistry,
    osConfirmRegistry,
    fleetConfirmFlow,
    osPowerCommands,
    browseRegistry,
    nlDispatch,
    commandDispatch,
    voiceModeCommands,
    confirmSessionCommand,
    isControlTopic,
    settingsStore,
    setAssistEnabled,
    setVoiceConfirmEnabled,
    getDefaultSessionMode,
    getDefaultSessionEffort,
    voiceServer,
    voiceModelPath,
    stateDir,
    supergroupChatId,
    log,
  } = opts;

  /**
   * Shared by "fleetConfirm" and "osConfirm" below: both do the identical take-or-notify-gone ->
   * discriminator-check -> cancel-or-execute dance, differing only in the registry, which field on
   * the pending entry acts as the discriminator (`kind` vs `action`), and what actually runs on
   * confirm. Extracted so a third `/x`-style destructive confirm card doesn't have to copy-paste
   * this a third time (found live as a fresh duplication introduced with the `/os` feature).
   */
  function handleSimpleConfirm<T extends ConfirmEntry & { messageId: number }, D>(
    registry: ConfirmRegistry<T>,
    action: { id: string; confirmed: boolean },
    callbackMessageId: number | undefined,
    actionDiscriminator: D,
    entryDiscriminator: (entry: T) => D,
    execute: (pending: T) => Promise<void>,
    logLabel: string,
  ): void {
    const pending = confirmCards.takeOrNotifyGone(registry, action.id, callbackMessageId, (entry) =>
      fireAndForget(confirmCards.markConfirmCardExpired(entry.messageId), log, `callback-query-router markConfirmCardExpired(${logLabel})`),
    );
    if (!pending) return;
    if (entryDiscriminator(pending) !== actionDiscriminator) return;
    if (!action.confirmed) {
      fireAndForget(confirmCards.finalizeCard(pending.messageId, "Cancelled - nothing was changed."), log, `callback-query-router finalizeCard(${logLabel} cancel)`);
      return;
    }
    fireAndForget(execute(pending), log, `callback-query-router execute(${logLabel})`);
  }

  const NAMESPACE_RULES: NamespaceRule[] = [
    // §6.4's per-question keyboard - "ask:", checked first since it never collides with the other
    // namespaces ("perm:", "run:", etc.).
    rule(
      "ask",
      (data) => (data ? resolveAskCallback(data) : null),
      (askAction) => {
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
      },
    ),

    // §5.5's `details` button - "d:", a fresh namespace alongside "ask:"/"perm:"/etc. Nothing to
    // resolve against a registry (the reference is self-contained: slug + turn number), so this
    // only needs `feedWiring`'s state to check the tapped turn is still the session's current one.
    rule(
      "details",
      (data) => (data ? parseDetailsCallback(data) : null),
      (detailsAction, ctx) => {
        const { threadId } = ctx;
        const state = feedWiring.getFeedState(detailsAction.slug);
        const stillCurrent = state && state.turnSeq === detailsAction.turnSeq;
        const verboseDetails = sessionStore.get(detailsAction.slug)?.feedVerbose ?? false;
        const text = stillCurrent ? renderDetails(state, verboseDetails) : "That turn has ended - its log is no longer available.";
        // renderDetails renders the same `<code>`/escaped-entity markup the turn card itself uses
        // (feed-renderer.ts) - needs "HTML" here or Telegram shows the literal tags.
        const fitsInOneMessage = text.length <= 4096;
        const anchorMsgId = detailsAnchorStore.get(detailsAction.slug, detailsAction.turnSeq);

        if (anchorMsgId !== undefined) {
          // Edit the button's own anchor message in place (full log + button removed) instead of
          // posting a separate message - the operator's own request, so a repeated /detail tap
          // doesn't keep piling up new messages next to the one that already has the answer. The
          // oversized case still edits the anchor too, just to a short note - the .txt document
          // itself still has to be its own message (Telegram can't inline a file into an edited
          // text message).
          const anchorText = fitsInOneMessage ? text : "📄 Details sent as a file below.";
          feedGovernor
            .scheduleAsync("P1", () => controlBot.editMessageText!(supergroupChatId, anchorMsgId, anchorText, { inline_keyboard: [] }, "HTML"))
            .then(() => detailsAnchorStore.delete(detailsAction.slug, detailsAction.turnSeq))
            .catch((err) => {
              // A stale/already-deleted anchor (or any other edit failure) degrades to the
              // pre-edit-in-place behaviour - the operator still gets the details, just as a new
              // message instead of an edit. Drop the now-unreliable mapping either way so a future
              // tap doesn't keep retrying the same broken edit.
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
          // §5.5: "Diffs always go as documents" - the same reasoning applies to a details log too
          // long to fit in one message. Plain text, not renderDetails's HTML markup - a document
          // viewer has no HTML renderer to make that markup invisible.
          const plainText = stillCurrent ? renderDetailsPlainText(state, verboseDetails) : text;
          feedGovernor
            .scheduleAsync("P1", () => controlBot.sendDocument(supergroupChatId, threadId, `${detailsAction.slug}-turn${detailsAction.turnSeq}-details.txt`, plainText))
            .catch((err) => log("WARN", `sendDocument (details) failed: ${(err as Error).message}`));
        }
      },
    ),

    // §6.3's approve/deny/always keyboard - "perm:", checked before the /help-style command
    // keyboard since the two callback_data namespaces ("perm:" vs "run:") never collide. Owns the
    // permission-rule derivation (`deriveAlwaysRule`/`ruleAlreadyCovered`/`addAlwaysRule`) CLAUDE.md
    // §9 already flags as needing unit tests.
    rule(
      "perm",
      (data) => (data ? resolvePermCallback(data) : null),
      (permAction) => {
        // Resolve pops the entry - a stale/expired/unknown id is a silent no-op (§9 scenarios 6-7),
        // not an error, since a race against the 30-minute sweep or a duplicate tap is expected.
        const pending = pipeHandle.resolvePermission(permAction.requestId);
        if (!pending) return;

        const behavior = permAction.action === "deny" ? "deny" : "allow";
        pipeHandle.sendVerdict(pending.slug, pending.requestId, behavior);
        feedWiring.maybeSetState(pending.slug, "working");

        let confirmText = `${behavior === "allow" ? "✅ Allowed" : "⛔ Denied"}: ${pending.toolName}`;
        if (permAction.action === "always") {
          const derivedRule = deriveAlwaysRule(pending.toolName, pending.inputPreview);
          const settings = readSettingsFile(stateDir, pending.slug);
          if (!derivedRule) {
            confirmText += " (allow-once only - command isn't safe to generalise)";
          } else if (ruleAlreadyCovered(derivedRule, settings)) {
            confirmText += ` (\`${derivedRule}\` already covered by an existing rule)`;
          } else {
            writeSettingsFile(stateDir, pending.slug, addAlwaysRule(settings, derivedRule));
            confirmText += `, and added \`${derivedRule}\` for this session`;
          }
        }
        pipeHandle.finalizePermissionMessage(pending.messageId, confirmText).catch((err) => log("WARN", `failed to finalize permission message: ${(err as Error).message}`));
      },
    ),

    // `/kill --all`/`/rm --all`'s own confirm keyboard (fleet-confirm.ts) - "fc:", a fresh
    // namespace, checked alongside "perm:" since both gate a destructive action behind a tap.
    // `take`, not `resolve`, inside `handleSimpleConfirm`: an expired card has to *say* it expired.
    // `answerCallbackQuery` already cleared the spinner, so returning silently here left the
    // operator with a tap that visibly did nothing - §6.5's stated failure mode.
    rule(
      "fleetConfirm",
      (data) => (data ? resolveFleetConfirmCallback(data) : null),
      (fleetConfirmAction, ctx) => {
        handleSimpleConfirm(
          fleetConfirmRegistry,
          fleetConfirmAction,
          ctx.callbackQuery.message?.message_id,
          fleetConfirmAction.kind,
          (entry) => entry.kind,
          (pending) => fleetConfirmFlow.executeFleetConfirm(pending),
          "fleet",
        );
      },
    ),

    // `/os shutdown|reboot`'s own confirm keyboard (os-power-commands.ts) - "os:", a fresh
    // namespace alongside "fc:" - same "an expired card has to say it expired" reasoning as
    // "fleetConfirm" above, for a strictly more consequential action.
    rule(
      "osConfirm",
      (data) => (data ? resolveOsConfirmCallback(data) : null),
      (osConfirmAction, ctx) => {
        handleSimpleConfirm(
          osConfirmRegistry,
          osConfirmAction,
          ctx.callbackQuery.message?.message_id,
          osConfirmAction.action,
          (entry) => entry.action,
          (pending) => osPowerCommands.executeOsConfirm(pending),
          "os",
        );
      },
    ),

    // `/browse`/`/find`'s own navigation - "br:"/"bf:"/"bv:"/"bs:", four fresh namespaces
    // (browse-nav.ts). Edits whichever message the tap came from (telegram.ts's own doc comment on
    // why `message_id` is read straight off the callback here, unlike every other flow above), so a
    // missing `message_id` (an old/mocked client) is a silent no-op.
    rule(
      "browse",
      (data) => (data ? resolveBrowseCallback(data) : null),
      (browseAction, ctx) => {
        const browseMessageId = ctx.callbackQuery.message?.message_id;
        if (browseMessageId === undefined) return;
        browseRegistry.sweep();
        const stored = browseRegistry.get(browseAction.id);
        if (!stored) {
          controlBot
            .editMessageText?.(supergroupChatId, browseMessageId, "This browse session has expired - run /browse or /find again.", { inline_keyboard: [] })
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
            .editMessageText?.(supergroupChatId, browseMessageId, text, { inline_keyboard: keyboard })
            .catch((err) => log("WARN", `editMessageText (browse dir) failed: ${(err as Error).message}`));
          return;
        }

        if (browseAction.kind === "file_menu" && stored.entry.kind === "file") {
          const githubUrl = resolveGithubLink(worktreePath, stored.entry.relPath);
          controlBot
            .editMessageText?.(supergroupChatId, browseMessageId, `📄 /${stored.entry.relPath}`, { inline_keyboard: buildFileActionKeyboard(browseAction.id, githubUrl) })
            .catch((err) => log("WARN", `editMessageText (browse file menu) failed: ${(err as Error).message}`));
          return;
        }

        if (browseAction.kind === "file_action" && stored.entry.kind === "file") {
          if (browseAction.action === "view") {
            const preview = readForPreview(worktreePath, stored.entry.relPath, stored.entry.matchLine);
            // No parse_mode here - preview.text is arbitrary, unescaped file content, and both
            // Telegram's Markdown and HTML modes would try to interpret stray backticks/`<`/`&` in
            // it as real formatting (feed-escape.ts exists precisely because that's unsafe without
            // escaping first). Plain text only.
            const text = !preview
              ? "That file no longer exists."
              : preview.tooLarge
                ? "That file is too large to preview here - try Send file instead."
                : preview.binary
                  ? "That looks like a binary file - use Send file instead."
                  : `${preview.text}${preview.truncated ? "\n(truncated)" : ""}`;
            const githubUrl = resolveGithubLink(worktreePath, stored.entry.relPath);
            controlBot
              .editMessageText?.(supergroupChatId, browseMessageId, text, { inline_keyboard: buildFileActionKeyboard(browseAction.id, githubUrl) })
              .catch((err) => log("WARN", `editMessageText (browse view) failed: ${(err as Error).message}`));
          } else {
            const prep = prepareFileForSend(worktreePath, stored.entry.relPath);
            if (!prep) {
              confirmSessionCommand(ctx.threadId, "That file no longer exists.");
            } else if (prep.tooLarge) {
              confirmSessionCommand(ctx.threadId, `"${prep.filename}" is too large to send here (over ${Math.round(MAX_SEND_BYTES / (1024 * 1024))}MB).`);
            } else if (controlBot.sendDocumentFile) {
              controlBot.sendDocumentFile(supergroupChatId, ctx.threadId, prep.filename, prep.bytes).catch((err) => log("WARN", `sendDocumentFile (browse send) failed: ${(err as Error).message}`));
            }
          }
          return;
        }

        if (browseAction.kind === "hits" && stored.entry.kind === "hitset") {
          controlBot
            .editMessageText?.(supergroupChatId, browseMessageId, renderHitsText(stored.entry.query, stored.entry, browseAction.page), {
              inline_keyboard: buildHitsKeyboard(browseRegistry, stored.slug, browseAction.id, stored.entry.hits, browseAction.page),
            })
            .catch((err) => log("WARN", `editMessageText (browse hits) failed: ${(err as Error).message}`));
        }
      },
    ),

    // nl-router.ts's destructive-command confirm keyboard (nl-confirm.ts) - "nc:", a fresh
    // namespace alongside "fc:"/"vc:"/"sc:"/"d:". "Run" and "run, don't ask again" both execute the
    // pending command through the same `executeMatchedCommand` a non-destructive NL match already
    // uses; "don't ask again" additionally flips `assistEnabled` off first (and persists it) so
    // every subsequent NL-matched destructive command skips this card until `/assist on` turns it
    // back on.
    rule(
      "nlConfirm",
      (data) => (data ? resolveNlConfirmCallback(data) : null),
      (nlConfirmAction, ctx) => {
        const pending = confirmCards.takeOrNotifyGone(nlConfirmRegistry, nlConfirmAction.id, ctx.callbackQuery.message?.message_id, (entry) =>
          fireAndForget(confirmCards.markNlConfirmCardExpired(entry), log, "callback-query-router markNlConfirmCardExpired"),
        );
        if (!pending) return;
        if (nlConfirmAction.action === "cancel") {
          fireAndForget(confirmCards.finalizeNlConfirmMessage(pending, "❌ Cancelled - nothing was changed."), log, "callback-query-router finalizeNlConfirmMessage(cancel)");
          return;
        }
        if (nlConfirmAction.action === "run_and_stop_asking") {
          setAssistEnabled(false);
          settingsStore.set("assist_enabled", "false");
        }
        fireAndForget(
          confirmCards.finalizeNlConfirmMessage(
            pending,
            `✅ Running ${nlDispatch.describeNlCommand(pending.command)}${nlConfirmAction.action === "run_and_stop_asking" ? " (confirmation now off - /assist on to re-enable)" : ""}.`,
          ),
          log,
          "callback-query-router finalizeNlConfirmMessage(run)",
        );
        const pendingIsControl = isControlTopic(pending.threadId);
        nlDispatch.executeMatchedCommand(pending.command, pending.threadId, pendingIsControl, pending.currentSlug);
      },
    ),

    // nl-router.ts's ask-which-repo keyboard (repo-picker.ts) - "rp:", a fresh namespace alongside
    // "nc:"/"fc:"/"vc:"/"sc:"/"d:". Only ever posted for a `kind='new'` NL match whose message never
    // named one of 2+ registered repos (`mapRouterOutput`'s "new" case) - a tap here is the operator
    // resolving that ambiguity, so it's turned into the exact same `kind='new'` `executeMatchedCommand`
    // call a directly-matched `/new` (typed or NL) would have gotten.
    rule(
      "repoPick",
      (data) => (data ? resolveRepoPickCallback(data) : null),
      (repoPickAction, ctx) => {
        const pending = confirmCards.takeOrNotifyGone(repoPickRegistry, repoPickAction.id, ctx.callbackQuery.message?.message_id, (entry) =>
          fireAndForget(confirmCards.markConfirmCardExpired(entry.messageId), log, "callback-query-router markConfirmCardExpired(repoPick)"),
        );
        if (!pending) return;
        if ("cancel" in repoPickAction) {
          fireAndForget(confirmCards.finalizeCard(pending.messageId, "❌ Cancelled - no session was created."), log, "callback-query-router finalizeCard(repoPick cancel)");
          return;
        }
        fireAndForget(confirmCards.finalizeCard(pending.messageId, `✅ Starting a session against "${repoPickAction.repo}"...`), log, "callback-query-router finalizeCard(repoPick run)");
        const pendingIsControl = isControlTopic(pending.threadId);
        nlDispatch.executeMatchedCommand(
          { kind: "new", repo: repoPickAction.repo, prompt: pending.prompt, model: pending.model, sourceText: pending.sourceText },
          pending.threadId,
          pendingIsControl,
          undefined,
        );
      },
    ),

    // §7.4's stale-inbound confirm keyboard (stale-confirm.ts) - "sc:", a fresh namespace alongside
    // "fc:". Recomputes isControl/route/currentSlug fresh from the pending card's own threadId
    // rather than trusting anything cached from when the card was first posted - the topic's
    // routing could have changed (e.g. the session was `/kill`ed) in the minutes the card sat
    // waiting for a tap, and `dispatchInboundMessage` already handles an unrecognised/dead
    // currentSlug the same way a live message would.
    rule(
      "staleConfirm",
      (data) => (data ? resolveStaleConfirmCallback(data) : null),
      (staleConfirmAction, ctx) => {
        const pending = confirmCards.takeOrNotifyGone(staleConfirmRegistry, staleConfirmAction.id, ctx.callbackQuery.message?.message_id, (entry) =>
          fireAndForget(confirmCards.markConfirmCardExpired(entry.confirmCardMessageId), log, "callback-query-router markConfirmCardExpired(stale)"),
        );
        if (!pending) return;
        if (!staleConfirmAction.confirmed) {
          fireAndForget(confirmCards.finalizeStaleConfirmMessage(pending, "Cancelled - not actioned."), log, "callback-query-router finalizeStaleConfirmMessage(cancel)");
          return;
        }
        fireAndForget(confirmCards.finalizeStaleConfirmMessage(pending, "✅ Confirmed - processing now."), log, "callback-query-router finalizeStaleConfirmMessage(confirm)");
        const pendingIsControl = isControlTopic(pending.threadId);
        const pendingRoute = pending.threadId !== undefined ? routing.getByTopicId(pending.threadId) : undefined;
        fireAndForget(
          commandDispatch.dispatchInboundMessage(pending.messageId, pending.rawText, pending.threadId, pendingIsControl, pendingRoute, pendingRoute?.slug, pending.from, buildContextPrefix(pending.origin)),
          log,
          "callback-query-router dispatchInboundMessage(stale replay)",
        );
      },
    ),

    // Voice input's own confirm keyboard (voice-confirm.ts) - "vc:", a fresh namespace alongside
    // "sc:"/"fc:"/"d:". "Re-record"/"Type instead"/"Cancel" all discard the transcript; they differ
    // only in which follow-up text is shown, so all three fall into the same finalize call below
    // rather than needing separate registry/dispatch handling. "Send, don't ask again" additionally
    // flips `voiceConfirmEnabled` off (and persists it) before sending, the typeable equivalent
    // being `/voiceconfirm off`.
    rule(
      "voiceConfirm",
      (data) => (data ? resolveVoiceConfirmCallback(data) : null),
      (voiceConfirmAction, ctx) => {
        const pending = confirmCards.takeOrNotifyGone(voiceConfirmRegistry, voiceConfirmAction.id, ctx.callbackQuery.message?.message_id, (entry) =>
          fireAndForget(confirmCards.markConfirmCardExpired(entry.confirmCardMessageId), log, "callback-query-router markConfirmCardExpired(voice)"),
        );
        if (!pending) return;
        if (voiceConfirmAction.action === "send" || voiceConfirmAction.action === "send_and_stop_asking") {
          if (voiceConfirmAction.action === "send_and_stop_asking") {
            setVoiceConfirmEnabled(false);
            settingsStore.set("voice_confirm_enabled", "false");
          }
          fireAndForget(
            confirmCards.finalizeVoiceConfirmMessage(pending, voiceConfirmAction.action === "send_and_stop_asking" ? "✅ Sent (confirmation now off - /voiceconfirm on to re-enable)." : "✅ Sent."),
            log,
            "callback-query-router finalizeVoiceConfirmMessage(send)",
          );
          const pendingIsControl = isControlTopic(pending.threadId);
          const pendingRoute = pending.threadId !== undefined ? routing.getByTopicId(pending.threadId) : undefined;
          fireAndForget(
            commandDispatch.dispatchInboundMessage(pending.messageId, pending.transcript, pending.threadId, pendingIsControl, pendingRoute, pendingRoute?.slug, pending.from, buildContextPrefix(pending.origin)),
            log,
            "callback-query-router dispatchInboundMessage(voice replay)",
          );
          return;
        }
        const doneText =
          voiceConfirmAction.action === "rerecord"
            ? "🔁 Discarded - send another voice note whenever you're ready."
            : voiceConfirmAction.action === "type"
              ? "✏️ Discarded - go ahead and type it."
              : "❌ Cancelled.";
        fireAndForget(confirmCards.finalizeVoiceConfirmMessage(pending, doneText), log, "callback-query-router finalizeVoiceConfirmMessage(discard)");
      },
    ),

    // `/voice`'s own model-picker keyboard (voice-model.ts) - "vm:", a fresh namespace alongside
    // "vc:"/"d:"/"sc:"/"fc:". Re-scans the model list rather than reusing whatever was on disk when
    // the button was posted - see `applyVoiceModelSwitch`'s own doc comment. Guards on `voiceServer`
    // being live as part of the match itself, same as the original inline check.
    rule(
      "voiceModel",
      (data) => (data && voiceServer ? resolveVoiceModelCallback(data) : null),
      (voiceModelName, ctx) => {
        const voiceDir = path.dirname(voiceModelPath);
        const models = listAvailableVoiceModels(voiceDir);
        const currentName = path.basename(voiceServer!.currentModelPath()).replace(/^ggml-/, "").replace(/\.bin$/, "");
        fireAndForget(voiceModeCommands.applyVoiceModelSwitch(ctx.threadId, voiceModelName, voiceDir, models, currentName), log, "callback-query-router applyVoiceModelSwitch");
      },
    ),

    // The trailing "✖️ Cancel" row on the /model, /mode and /effort pickers (session-commands.ts's
    // buildLevelKeyboard) - checked ahead of the three resolve* rules below since "cancel" is
    // deliberately never a valid level for any of them and would otherwise just look like an
    // unrecognised tap. Edits the card to a plain "Cancelled." with the keyboard stripped, rather
    // than leaving a stale keyboard sitting there or a whole new message.
    rule(
      "levelCancel",
      (data) => (data && (isModelCancelCallback(data) || isModeCancelCallback(data) || isEffortCancelCallback(data)) ? true : null),
      (_matched, ctx) => {
        const cancelMsgId = ctx.callbackQuery.message?.message_id;
        if (cancelMsgId !== undefined && controlBot.editMessageText) {
          controlBot.editMessageText(supergroupChatId, cancelMsgId, "Cancelled.", { inline_keyboard: [] }).catch((err) => log("WARN", `editMessageText (cancel) failed: ${(err as Error).message}`));
        }
      },
    ),

    rule(
      "model",
      (data) => (data ? resolveModelCallback(data) : null),
      (model, ctx) => {
        if (ctx.currentSlug && ctx.threadId !== undefined) voiceModeCommands.applyModelSwitch(ctx.currentSlug, ctx.threadId, model);
      },
    ),
    rule(
      "mode",
      (data) => (data ? resolveModeCallback(data) : null),
      (mode, ctx) => {
        if (ctx.currentSlug && ctx.threadId !== undefined) voiceModeCommands.applyModeSwitch(ctx.currentSlug, ctx.threadId, mode);
      },
    ),
    rule(
      "effort",
      (data) => (data ? resolveEffortCallback(data) : null),
      (effort, ctx) => {
        if (ctx.currentSlug && ctx.threadId !== undefined) voiceModeCommands.applyEffortSwitch(ctx.currentSlug, ctx.threadId, effort);
      },
    ),

    // `/default`'s three-namespace picker flow: "default:mode"/"default:effort" (the top-level
    // category keyboard) edits the same message into that category's own value picker;
    // "defmode:<value>"/"defeffort:<value>" (that picker's own buttons) applies the change and
    // edits the message into a plain confirmation; either picker's own Cancel row edits to
    // "Cancelled.". All three edit in place - unlike the session-scoped /model|/mode|/effort
    // pickers above, which only ever confirm via a *new* message (`applyModelSwitch` etc.),
    // `/default` has no `currentSlug` to hand off to and the picker itself is the whole UI, so
    // editing it through each step reads as one drill-down instead of a new message per tap. One
    // rule, not four, since all four only ever fire together off the same `defaultMsgId` guard. Note
    // this rule's `match` does the *actual* parsing (unlike every other rule's thin `resolve*`
    // delegate) rather than just gating on "has data, has a message id" - the original inline code's
    // outer `if` had no final `return`, so an unmatched-by-any-of-the-four tap silently fell through
    // to the next check ("about:", the catch-all) rather than being definitively "handled here". A
    // `match` that claimed every non-empty `data` (deferring the real discrimination into `handle`,
    // the way `command-dispatch.ts`'s rules do) would break that fall-through - so here specifically,
    // `match` resolves the real sub-case and only claims the tap once one of them actually fits.
    rule(
      "default",
      (data, ctx) => {
        const defaultMsgId = ctx.callbackQuery.message?.message_id;
        if (!data || defaultMsgId === undefined || !controlBot.editMessageText) return null;
        const category = resolveDefaultCategoryCallback(data);
        if (category) return { defaultMsgId, action: { kind: "category" as const, category } };
        if (isDefaultCategoryCancelCallback(data) || isDefaultModeCancelCallback(data) || isDefaultEffortCancelCallback(data)) return { defaultMsgId, action: { kind: "cancel" as const } };
        const defaultMode = resolveDefaultModeCallback(data);
        if (defaultMode) return { defaultMsgId, action: { kind: "mode" as const, mode: defaultMode } };
        const defaultEffort = resolveDefaultEffortCallback(data);
        if (defaultEffort) return { defaultMsgId, action: { kind: "effort" as const, effort: defaultEffort } };
        // The status card's two direct-toggle rows (`default:permission:on` etc.). Without this
        // branch `match` returns null for them, the rule declines, and the tap falls through to the
        // catch-all - a live-looking button that does nothing.
        const defaultToggle = resolveDefaultToggleCallback(data);
        if (defaultToggle) return { defaultMsgId, action: { kind: "toggle" as const, ...defaultToggle } };
        return null;
      },
      ({ defaultMsgId, action }) => {
        if (action.kind === "category") {
          // `action.category` is `DefaultPickerCategory`, not the full `DefaultCategory` - the two
          // boolean categories arrive as `kind: "toggle"` below and have no picker to drill into.
          // That narrowing is what keeps this two-way choice honest as `/default` grows categories:
          // widening a union never breaks a ternary, it just silently routes the new members into
          // whichever arm happens to be last.
          const [prompt, keyboard] =
            action.category === "mode"
              ? [`Choose the default permission mode for new sessions (current: ${getDefaultSessionMode()}):`, buildDefaultModeKeyboard(getDefaultSessionMode())]
              : [`Choose the default effort level for new sessions (current: ${getDefaultSessionEffort()}):`, buildDefaultEffortKeyboard(getDefaultSessionEffort())];
          controlBot
            .editMessageText!(supergroupChatId, defaultMsgId, prompt, { inline_keyboard: keyboard })
            .catch((err) => log("WARN", `editMessageText (/default category) failed: ${(err as Error).message}`));
          return;
        }
        if (action.kind === "cancel") {
          controlBot.editMessageText!(supergroupChatId, defaultMsgId, "Cancelled.", { inline_keyboard: [] }).catch((err) => log("WARN", `editMessageText (/default cancel) failed: ${(err as Error).message}`));
          return;
        }
        if (action.kind === "mode") {
          controlBot
            .editMessageText!(supergroupChatId, defaultMsgId, voiceModeCommands.applyDefaultMode(action.mode), { inline_keyboard: [] })
            .catch((err) => log("WARN", `editMessageText (/default mode) failed: ${(err as Error).message}`));
          return;
        }
        if (action.kind === "toggle") {
          controlBot
            .editMessageText!(supergroupChatId, defaultMsgId, voiceModeCommands.applyDefaultAutoToggle(action.category, action.value), { inline_keyboard: [] })
            .catch((err) => log("WARN", `editMessageText (/default ${action.category}) failed: ${(err as Error).message}`));
          return;
        }
        controlBot
          .editMessageText!(supergroupChatId, defaultMsgId, voiceModeCommands.applyDefaultEffort(action.effort), { inline_keyboard: [] })
          .catch((err) => log("WARN", `editMessageText (/default effort) failed: ${(err as Error).message}`));
      },
    ),

    // `/about`'s "more info" buttons ("about:") - a fresh namespace alongside "run:"/"perm:"/etc.;
    // unlike those, there's nothing to resolve against a registry (every topic's text is static),
    // so this just looks the id up and sends it. `/about` itself works from the control topic's own
    // default ("General") topic, which carries no `message_thread_id` at all - unlike
    // `resolveCommandAction`'s buttons (session-scoped only, so threadId is always defined there),
    // threadId being undefined here is the normal case, not an error; `sendMessage` already accepts
    // it the same way the `/about` dispatch path does.
    rule(
      "about",
      (data) => (data ? resolveAboutCallback(data) : null),
      (aboutTopicId, ctx) => {
        const topic = ABOUT_TOPICS[aboutTopicId];
        if (!topic) return;
        controlBot.sendMessage(supergroupChatId, ctx.threadId, topic.details).catch((err) => log("WARN", `sendMessage (about detail) failed: ${(err as Error).message}`));
      },
    ),

    // The catch-all `/help`-style command keyboard (commands.ts) - checked last since every rule
    // above owns a distinct, unambiguous prefix of its own.
    rule(
      "commandAction",
      (data) => (data ? resolveCommandAction(data) : null),
      (action, ctx) => {
        if (ctx.threadId === undefined) return;
        const currentRoute = ctx.threadId !== undefined ? routing.getByTopicId(ctx.threadId) : undefined;
        // "Commands (N)"/"Skills (N)" - answered directly, like /help/`/commands`/`/skills`
        // themselves; this is "list them as text," not something to forward into the PTY/channel.
        if (action.kind === "show_commands") {
          const text = renderCommandsListText(currentRoute ? listRepoCommands(currentRoute.worktreePath) : []);
          controlBot.sendMessage(supergroupChatId, ctx.threadId, text).catch((err) => log("WARN", `sendMessage (show commands) failed: ${(err as Error).message}`));
          return;
        }
        if (action.kind === "show_skills") {
          const text = renderSkillsListText(currentRoute ? listRepoSkills(currentRoute.worktreePath) : []);
          controlBot.sendMessage(supergroupChatId, ctx.threadId, text).catch((err) => log("WARN", `sendMessage (show skills) failed: ${(err as Error).message}`));
          return;
        }
        if (ctx.currentSlug) ptyIo.sendRaw(ctx.currentSlug, `/${action.name}`);
      },
    ),
  ];

  function routeCallbackQuery(callbackQuery: TelegramCallbackQuery): void {
    feedGovernor.scheduleAsync("P0", () => controlBot.answerCallbackQuery(callbackQuery.id)).catch((err) => log("WARN", `answerCallbackQuery failed: ${(err as Error).message}`));

    const threadId = callbackQuery.message?.message_thread_id;
    const currentRoute = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
    const currentSlug = currentRoute?.slug;
    const ctx: CallbackCtx = { callbackQuery, threadId, currentSlug };

    for (const r of NAMESPACE_RULES) {
      const matched = r.match(callbackQuery.data, ctx);
      if (matched !== null && matched !== undefined) {
        r.handle(matched, ctx);
        return;
      }
    }
  }

  return { routeCallbackQuery };
}
