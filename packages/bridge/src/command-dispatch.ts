import {
  buildCmdShimText,
  buildSkillShimText,
  isBuiltinPassthroughCommand,
  listRepoCommands,
  listRepoSkills,
  parseCmdInvocation,
  parseSkillInvocation,
} from "./commands.ts";
import { isAboutCommand } from "./about.ts";
import { parseBrowseCommand, parseDiffCommand, parseFindCommand } from "./browse-nav.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import { isRetryPhrase, retryTopicKey, type RetryStore } from "./retry-store.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import { isHelpCommand, parseCommandsQuery, parseFleetCommand, parseSkillsQuery, stripBotMention } from "./fleet-commands.ts";
import {
  buildEffortKeyboard,
  buildModeKeyboard,
  buildModelKeyboard,
  EFFORTS,
  isSessionCommandAttempt,
  MODELS,
  MODES,
  parseSessionCommand,
} from "./session-commands.ts";
import type { Model } from "./session-commands.ts";
import type { SessionStore } from "./session-store.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { Routing, SessionRoute } from "./routing.ts";
import type { PtyIo } from "./pty-io.ts";
import type { SendMessageSource } from "./telegram.ts";
import type { SessionLifecycleCommands } from "./session-lifecycle-commands.ts";
import type { FleetReportingCommands } from "./fleet-reporting-commands.ts";
import type { FleetConfirmFlow } from "./fleet-confirm-flow.ts";
import type { DeployLifecycleCommands } from "./deploy-lifecycle-commands.ts";
import type { VoiceModeCommands } from "./voice-mode-commands.ts";
import type { CardSenders } from "./card-senders.ts";
import type { FeedWiring } from "./feed-wiring.ts";
import type { NlDispatch } from "./nl-dispatch.ts";
import type { ReposRegistry } from "./repos-registry.ts";

export interface CommandDispatchOptions {
  controlBot: SendMessageSource;
  routing: Routing;
  ptyIo: Pick<PtyIo, "sendRaw" | "sendChannelText">;
  sessionStore: Pick<SessionStore, "get" | "getByTopicId">;
  confirmSessionCommand: ConfirmSessionCommand;
  sessionLifecycle: Pick<
    SessionLifecycleCommands,
    "handleNewCommand" | "handleLsCommand" | "handleKillCommand" | "handleRmCommand" | "handleAttachCommand" | "handleDetailCommand" | "handleVerboseCommand" | "handlePauseCommand" | "handleStopCommand"
  >;
  fleetReporting: FleetReportingCommands;
  fleetConfirmFlow: Pick<FleetConfirmFlow, "handleUsageCommand">;
  deployLifecycle: Pick<DeployLifecycleCommands, "handleRestartCommand" | "handleDeployCommand" | "handleAutostartCommand">;
  voiceModeCommands: Pick<
    VoiceModeCommands,
    "handleVoiceModelCommand" | "handleAssistCommand" | "handleRouterBackendCommand" | "handleVoiceConfirmCommand" | "handleDefaultCommand" | "applyModelSwitch" | "applyModeSwitch" | "applyEffortSwitch"
  >;
  cardSenders: CardSenders;
  feedWiring: Pick<FeedWiring, "markInterjected">;
  retryStore: RetryStore;
  nlDispatch: Pick<NlDispatch, "postNlConfirm" | "routeOrFallback">;
  getReposRegistry: () => ReposRegistry | undefined;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface CommandDispatch {
  dispatchFleetCommand(fleetCmd: FleetCommand, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined): void;
  dispatchInboundMessage(
    messageId: number,
    rawText: string,
    threadId: number | undefined,
    isControl: boolean,
    route: SessionRoute | undefined,
    currentSlug: string | undefined,
    from: string,
    contextPrefix?: string,
  ): Promise<void>;
}

/** Everything an exact-syntax rule's `match`/`handle` pair below needs beyond `text` itself - the
 * four already-computed values `dispatchInboundMessage` used to close over directly. */
interface DispatchCtx {
  messageId: number;
  threadId: number | undefined;
  isControl: boolean;
  route: SessionRoute | undefined;
  currentSlug: string | undefined;
  from: string;
}

/** A single entry in the ordered exact-syntax dispatch table below. `match` returns `null` for "not
 * this rule"; anything else (including `false`/`0` would be wrong, so every real `match` below
 * normalises to `null` or a truthy payload) means "handle it, then stop." Typed with `unknown` at
 * this boundary rather than a per-rule generic so the table itself can be one plain array - `rule()`
 * is what keeps each individual match/handle pair internally type-safe despite that erasure. */
interface ExactSyntaxRule {
  name: string;
  match(text: string, ctx: DispatchCtx): unknown;
  handle(matched: unknown, text: string, ctx: DispatchCtx): void | Promise<void>;
}

function rule<M>(name: string, match: (text: string, ctx: DispatchCtx) => M | null, handle: (matched: M, text: string, ctx: DispatchCtx) => void | Promise<void>): ExactSyntaxRule {
  return {
    name,
    match,
    handle: (matched, text, ctx) => handle(matched as M, text, ctx),
  };
}

/**
 * §7.4/§10's exact-syntax `/command` switch plus the plain-text dispatch gauntlet that used to sit
 * inline inside `onUpdate` - `dispatchFleetCommand` (the typed-`/command` switch, also reached by
 * an NL-matched command via `nl-dispatch.ts`'s injected callback) and `dispatchInboundMessage` (the
 * top-level entry point for every inbound message: exact-syntax checks, then NL routing, then a
 * forward to the session).
 *
 * `dispatchInboundMessage`'s exact-syntax checks (`/about` through the builtin-passthrough check)
 * are an ordered `EXACT_SYNTAX_RULES` list rather than an if-chain, so branch *order* - which
 * previously caused a real shadowing bug (a `/commands <name>` invocation being swallowed by the
 * `/commands` list-filter branch matching first and greedily) - is visible and testable as data
 * instead of buried in linear control flow. The fix for that specific bug is unchanged: it lives
 * inside the `commandsQuery` rule's own `handle` (checking for a real invocation before falling back
 * to the list filter), not in the ordering of rules relative to each other - nothing later in this
 * list could ever shadow it since each rule's `match` is independent of every other rule's.
 */
export function createCommandDispatch(opts: CommandDispatchOptions): CommandDispatch {
  const {
    controlBot,
    routing,
    ptyIo,
    sessionStore,
    confirmSessionCommand,
    sessionLifecycle,
    fleetReporting,
    fleetConfirmFlow,
    deployLifecycle,
    voiceModeCommands,
    cardSenders,
    feedWiring,
    retryStore,
    nlDispatch,
    getReposRegistry,
    supergroupChatId,
    log,
  } = opts;

  /**
   * The exact-syntax `/command` switch, extracted so both a typed `/command` (`parseFleetCommand`,
   * fleet-commands.ts) and an NL-matched command (nl-router.ts, via `nl-dispatch.ts`) execute
   * through the exact same code path - no separate copy to keep in sync. `isControl` mirrors the
   * same two inline checks (`/new`, `/budget`) `dispatchInboundMessage` always ran; an NL match can
   * never produce either kind outside the control topic anyway (`nl-router.ts`'s `allowedKinds`),
   * but the check stays here too as defense in depth rather than trusting upstream filtering.
   */
  function dispatchFleetCommand(fleetCmd: FleetCommand, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined): void {
    if (fleetCmd.kind === "new") {
      if (!isControl) {
        confirmSessionCommand(threadId, "/new only works from the control topic.");
        return;
      }
      fireAndForget(sessionLifecycle.handleNewCommand(fleetCmd, threadId), log, "command-dispatch handleNewCommand");
      return;
    }
    if (fleetCmd.kind === "ls") {
      sessionLifecycle.handleLsCommand(threadId);
      return;
    }
    if (fleetCmd.kind === "budget") {
      if (!isControl) {
        confirmSessionCommand(threadId, "/budget only works from the control topic.");
        return;
      }
      fleetReporting.handleBudgetCommand(threadId);
      return;
    }
    if (fleetCmd.kind === "kill") {
      fireAndForget(sessionLifecycle.handleKillCommand(fleetCmd, threadId, currentSlug), log, "command-dispatch handleKillCommand");
      return;
    }
    if (fleetCmd.kind === "rm") {
      fireAndForget(sessionLifecycle.handleRmCommand(fleetCmd, threadId, currentSlug), log, "command-dispatch handleRmCommand");
      return;
    }
    if (fleetCmd.kind === "attach") {
      sessionLifecycle.handleAttachCommand(fleetCmd, threadId, currentSlug);
      return;
    }
    if (fleetCmd.kind === "usage") {
      fireAndForget(fleetConfirmFlow.handleUsageCommand(fleetCmd, threadId, currentSlug), log, "command-dispatch handleUsageCommand");
      return;
    }
    if (fleetCmd.kind === "restart") {
      fireAndForget(deployLifecycle.handleRestartCommand(threadId), log, "command-dispatch handleRestartCommand");
      return;
    }
    if (fleetCmd.kind === "deploy") {
      fireAndForget(deployLifecycle.handleDeployCommand(threadId, fleetCmd.slug), log, "command-dispatch handleDeployCommand");
      return;
    }
    if (fleetCmd.kind === "detail") {
      sessionLifecycle.handleDetailCommand(fleetCmd, threadId, currentSlug);
      return;
    }
    if (fleetCmd.kind === "verbose") {
      sessionLifecycle.handleVerboseCommand(fleetCmd, threadId, currentSlug);
      return;
    }
    if (fleetCmd.kind === "settings") {
      fleetReporting.handleSettingsCommand(threadId);
      return;
    }
    if (fleetCmd.kind === "autostart") {
      fireAndForget(deployLifecycle.handleAutostartCommand(fleetCmd, threadId), log, "command-dispatch handleAutostartCommand");
      return;
    }
    if (fleetCmd.kind === "repos") {
      fleetReporting.handleReposCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "voice") {
      voiceModeCommands.handleVoiceModelCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "assist") {
      voiceModeCommands.handleAssistCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "router") {
      voiceModeCommands.handleRouterBackendCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "voiceconfirm") {
      voiceModeCommands.handleVoiceConfirmCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "default") {
      if (!isControl) {
        confirmSessionCommand(threadId, "/default only works from the control topic.");
        return;
      }
      voiceModeCommands.handleDefaultCommand(fleetCmd, threadId);
      return;
    }
    if (fleetCmd.kind === "stop") {
      sessionLifecycle.handleStopCommand(fleetCmd, threadId, currentSlug);
      return;
    }
    sessionLifecycle.handlePauseCommand(fleetCmd, threadId, currentSlug);
  }

  // §10's ordered exact-syntax table: `/about` through the builtin-passthrough check, i.e. every
  // check `dispatchInboundMessage` used to run as a top-to-bottom if-chain between the fleet-command/
  // retry-phrase checks above it and the NL-routing/forward-to-session fallbacks below it. Order
  // here is the whole contract - a rule earlier in this array always gets first refusal on `text`.
  const EXACT_SYNTAX_RULES: ExactSyntaxRule[] = [
    // `/about`: the friendly capability overview (about.ts) - checked ahead of /help since it's
    // the on-ramp `/help` deliberately isn't; works from either the control topic or a session's
    // own topic, same as /help.
    rule(
      "about",
      (text) => (isAboutCommand(text) ? true : null),
      (_matched, _text, ctx) => cardSenders.sendAboutCard(ctx.threadId),
    ),

    // "?" bare (no slash) is only treated as a help request from the control topic - inside a
    // session topic it's plausible real content meant for Claude (e.g. "?" as a shorthand
    // question), so only the unambiguous slash forms are recognised there.
    rule(
      "help",
      (text, ctx) => (isHelpCommand(text, ctx.isControl) ? true : null),
      (_matched, _text, ctx) => cardSenders.sendHelpCard(ctx.threadId, ctx.route),
    ),

    // `/commands [<term>]` - the per-project, item-count-scoped list (see commands.ts's doc
    // comments on `buildCommandKeyboard` for why these replaced per-item buttons). Session-scoped
    // only - control topic has no worktree to read commands from.
    rule(
      "commandsQuery",
      (text) => parseCommandsQuery(text),
      (commandsQuery, _text, ctx) => {
        // `/commands <name> [args]` is documented in three places (commands.ts, about.ts, and its
        // own unit test) as a synonym for `/cmd <name> [args]`, but this list-filter rule matches
        // first and greedily on the whole "/commands ..." syntax, so the invocation form would be
        // unreachable if this rule didn't check for it internally: `/commands review/pre-push
        // --staged` would answer `No repo commands matched "review/pre-push --staged"` instead of
        // running it. Only a *real* command name takes the invocation path; anything else is still
        // a list filter, so `/commands review` keeps working as a search. (This is a property of
        // this one rule's own `handle`, not of its position relative to any other rule below - see
        // this module's own doc comment.)
        const asInvocation = commandsQuery.term ? parseCmdInvocation(`/cmd ${commandsQuery.term}`) : null;
        if (ctx.route && asInvocation && listRepoCommands(ctx.route.worktreePath).includes(asInvocation.name)) {
          ptyIo.sendChannelText(ctx.route.slug, ctx.route.topicId, buildCmdShimText(asInvocation.name, asInvocation.args), String(ctx.messageId), ctx.from);
          return;
        }
        cardSenders.sendCommandsListCard(ctx.threadId, ctx.route, commandsQuery.term);
      },
    ),

    // `/skills [<term>]` - same reasoning as /commands above.
    rule(
      "skillsQuery",
      (text) => parseSkillsQuery(text),
      (skillsQuery, _text, ctx) => cardSenders.sendSkillsListCard(ctx.threadId, ctx.route, skillsQuery.term),
    ),

    // `/browse [<path>]` - the Telegram file browser (browse-nav.ts, worktree-fs.ts). Session-scoped
    // only - there's no worktree to browse without a route.
    rule(
      "browseCommand",
      (text) => parseBrowseCommand(text),
      (browseCmd, _text, ctx) => cardSenders.sendBrowseCard(ctx.threadId, ctx.route, browseCmd.path),
    ),

    // `/find <query>` - same file set as /browse, searched instead of listed.
    rule(
      "findCommand",
      (text) => parseFindCommand(text),
      (findCmd, _text, ctx) => cardSenders.sendFindCard(ctx.threadId, ctx.route, findCmd.query),
    ),

    // `/diff` - the pending-worktree-diff card (diff-review.ts).
    rule(
      "diffCommand",
      (text) => (parseDiffCommand(text) ? true : null),
      (_matched, _text, ctx) => cardSenders.sendDiffCard(ctx.threadId, ctx.route),
    ),

    // A bare /model, /mode or /effort (no argument to act on) surfaces a button per option instead
    // of falling through to the ordinary inbound-message path, where it would just arrive as plain
    // chat text and get answered conversationally rather than switching anything (confirmed live
    // for /effort). Each shows the session's current value (✓-marked button, named in the prompt
    // text) when one is known, and a trailing Cancel button.
    rule(
      "bareLevelCommand",
      (text, ctx) => {
        const currentModel = ctx.currentSlug ? sessionStore.get(ctx.currentSlug)?.model : undefined;
        const bareCommandKeyboards: Record<string, { prompt: string; keyboard: () => ReturnType<typeof buildEffortKeyboard> }> = {
          "/model": {
            prompt: currentModel ? `Choose a model (current: ${currentModel}):` : "Choose a model:",
            keyboard: () => buildModelKeyboard((MODELS as readonly string[]).includes(currentModel ?? "") ? (currentModel as Model) : undefined),
          },
          "/mode": {
            prompt: ctx.currentSlug ? `Choose a permission mode (current: ${routing.getMode(ctx.currentSlug)}):` : "Choose a permission mode:",
            keyboard: () => buildModeKeyboard(ctx.currentSlug ? routing.getMode(ctx.currentSlug) : undefined),
          },
          "/effort": {
            prompt: ctx.currentSlug ? `Choose an effort level (current: ${routing.getEffort(ctx.currentSlug)}):` : "Choose an effort level:",
            keyboard: () => buildEffortKeyboard(ctx.currentSlug ? routing.getEffort(ctx.currentSlug) : undefined),
          },
        };
        return bareCommandKeyboards[text] ?? null;
      },
      (bareCommand, text, ctx) => {
        controlBot
          .sendMessage(supergroupChatId, ctx.threadId, bareCommand.prompt, { inline_keyboard: bareCommand.keyboard() })
          .catch((err) => log("WARN", `sendMessage (${text} list) failed: ${(err as Error).message}`));
      },
    ),

    // §4.2.1/§4.2.2: neither /model nor /mode fires a hook or a reply call, so the Bridge confirms
    // them itself rather than waiting for an ack that will never arrive. Both are session-scoped
    // only (§4.2.2) - sent from the control topic they're rejected outright.
    rule(
      "sessionCommandAttempt",
      (text) => parseSessionCommand(text),
      (attempt, _text, ctx) => {
        if (!ctx.currentSlug || ctx.threadId === undefined) {
          confirmSessionCommand(ctx.threadId, "/model, /mode and /effort are session-scoped - send them inside that session's own topic.");
          return;
        }
        if (attempt.kind === "model") {
          voiceModeCommands.applyModelSwitch(ctx.currentSlug, ctx.threadId, attempt.model);
        } else if (attempt.kind === "effort") {
          voiceModeCommands.applyEffortSwitch(ctx.currentSlug, ctx.threadId, attempt.effort);
        } else {
          voiceModeCommands.applyModeSwitch(ctx.currentSlug, ctx.threadId, attempt.mode);
        }
      },
    ),
    rule(
      "sessionCommandAttemptRejected",
      (text) => (isSessionCommandAttempt(text) ? true : null),
      (_matched, _text, ctx) =>
        confirmSessionCommand(ctx.threadId, `Unrecognised /model, /mode or /effort argument. Models: ${MODELS.join(", ")}. Modes: ${MODES.join(", ")}. Effort: ${EFFORTS.join(", ")}.`),
    ),

    // Manual typing equivalent of the old per-item buttons (removed 2026-08-04 - see commands.ts's
    // `buildCommandKeyboard` doc comment): a builtin Claude Code slash command (e.g. `/compact`)
    // passes straight through to the PTY rather than being treated as unrecognised.
    rule(
      "builtinPassthrough",
      (text) => {
        const builtinName = text.startsWith("/") ? text.slice(1) : "";
        return isBuiltinPassthroughCommand(builtinName) ? text : null;
      },
      (text, _text2, ctx) => {
        if (ctx.currentSlug) ptyIo.sendRaw(ctx.currentSlug, text);
      },
    ),
  ];

  /**
   * The full plain-text/command dispatch that used to sit inline inside `onUpdate` - extracted
   * (§7.4) so a stale backlog message can be replayed from `staleConfirmRegistry`'s "yes" tap
   * through the exact same path a live message takes, rather than duplicating or approximating that
   * logic at the confirm-tap call site. `text` derives from `rawText` internally rather than being
   * handed in pre-stripped, so a replay strips a `@botusername` mention the same way a live message
   * would.
   *
   * Async since 2026-08-06 (nl-router.ts): the final two fallthrough branches (no session /
   * forward-to-session) try the NL router first - a real network/process call - before falling back
   * to today's immediate behaviour. Every existing caller already calls this fire-and-forget (`void
   * dispatchInboundMessage(...)` or a bare call inside a non-awaited context), so returning a
   * `Promise<void>` instead of `void` changes nothing at any call site.
   */
  async function dispatchInboundMessage(
    messageId: number,
    rawText: string,
    threadId: number | undefined,
    isControl: boolean,
    route: SessionRoute | undefined,
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
      fireAndForget(nlDispatch.postNlConfirm(pendingRetry.command, pendingRetry.threadId, pendingRetry.currentSlug), log, "command-dispatch postNlConfirm(retry)");
      return;
    }

    const ctx: DispatchCtx = { messageId, threadId, isControl, route, currentSlug, from };
    for (const r of EXACT_SYNTAX_RULES) {
      const matched = r.match(text, ctx);
      if (matched !== null && matched !== undefined) {
        await r.handle(matched, text, ctx);
        return;
      }
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
      // Natural-language routing (nl-router.ts) - only reached once every exact-syntax rule above
      // has already rejected this text. `hasSession: false` narrows the offered commands to the
      // control-topic-only subset (`/new`/`/budget`); on no match, today's exact behaviour.
      await nlDispatch.routeOrFallback(text, { isControl, hasSession: false, repoNames: getReposRegistry()?.names() }, threadId, isControl, undefined, () => {
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
    await nlDispatch.routeOrFallback(text, { isControl, hasSession: true, repoNames: getReposRegistry()?.names() }, threadId, isControl, currentSlug, () => {
      // §10.1.2: notifications/claude/channel is confirmed broken upstream (getClientCapabilities()
      // never negotiates the capability), so inbound delivery writes the same <channel> tag
      // Claude Code would have rendered itself directly to the session's PTY, exactly as an
      // operator typing it and pressing Enter would.
      ptyIo.sendChannelText(currentSlug, threadId, contextPrefix + rawText, String(messageId), from);
    });
  }

  return { dispatchFleetCommand, dispatchInboundMessage };
}
