import { randomUUID } from "node:crypto";
import { fireAndForget } from "./fire-and-forget.ts";
import { buildDialogueGroundingText } from "./about.ts";
import { formatHistoryForPrompt } from "./control-topic-history.ts";
import type { ControlTopicHistory } from "./control-topic-history.ts";
import { buildNlConfirmKeyboard, NlConfirmRegistry } from "./nl-confirm.ts";
import { answerControlTopicQuestion as realAnswerControlTopicQuestion, routeText as realRouteText } from "./nl-router.ts";
import type { RouterAction } from "./nl-router.ts";
import { buildRepoPickKeyboard, RepoPickRegistry } from "./repo-picker.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { Effort, Mode, Model, SessionCommand } from "./session-commands.ts";
import type { CardSenders } from "./card-senders.ts";
import type { PtyIo } from "./pty-io.ts";
import type { Routing } from "./routing.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { TypingIndicator } from "./typing-indicator.ts";
import type { SendMessageSource } from "./telegram.ts";
import type { LogFn } from "./logger.ts";
import type { RuntimeSettings } from "./runtime-settings.ts";

/** §10's natural-language command routing: matching plain text against `nl-router.ts`, confirming
 * a destructive match before it runs, and executing a matched command through the exact same
 * handlers a typed `/command` would use. Takes `dispatchFleetCommand` as an injected callback
 * (fleet-command dispatch itself lives in command-dispatch.ts, item 14, constructed after this
 * module - same forward-reference treatment `dispatchInboundMessage` gets in inbound-media.ts,
 * item 6) rather than importing it directly, avoiding a circular module dependency. */
export interface NlDispatchOptions {
  controlBot: SendMessageSource;
  routing: Routing;
  ptyIo: Pick<PtyIo, "sendRaw">;
  typingIndicator: TypingIndicator;
  thinkingPlaceholder: ThinkingPlaceholder;
  cardSenders: CardSenders;
  applyModelSwitch: (slug: string, topicId: number, model: string) => void;
  applyModeSwitch: (slug: string, topicId: number, mode: Mode) => void;
  applyEffortSwitch: (slug: string, topicId: number, effort: Effort) => void;
  nlConfirmRegistry: NlConfirmRegistry;
  /** Backs `RouterAction`'s `new_pick_repo` outcome (`nl-router.ts`) - an ask-which-repo keyboard for
   * an NL-matched `kind='new'` whose message never named one of 2+ registered repos. */
  repoPickRegistry: RepoPickRegistry;
  dispatchFleetCommand: (fleetCmd: FleetCommand, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined) => void;
  nlRouterConfig: { enabled: boolean; apiKey: string | undefined; model: string; historyTurns?: number };
  /** Read live, never snapshotted: `/router` and `/assist` both flip under this module at runtime. */
  settings: Pick<RuntimeSettings, "nlRouterBackend" | "assistEnabled">;
  supergroupChatId: string;
  log: LogFn;
  /** Defaults to the real `nl-router.ts` implementation - injectable so `routeOrFallback`'s own
   * control flow (indicator start/stop, the destructive-confirm gate, dispatch to
   * `executeMatchedCommand`) is unit-testable without a real CLI/API backend call. */
  routeText?: typeof realRouteText;
  /** Control-topic free-form Q&A (`plans/control-topic-nl-dialogue-plan.md`) - defaults to the real
   * `nl-router.ts` implementation, injectable for the same testability reason as `routeText` above.
   * Only ever called from `routeOrFallback`'s no-match branch, and only when `ctx.isControl`. */
  answerControlTopicQuestion?: typeof realAnswerControlTopicQuestion;
  /** The control topic's bounded exchange-history buffer (`control-topic-history.ts`) - optional so
   * every existing caller/test that doesn't care about history continues to work unchanged; a
   * missing `history` just means no context is recorded or read (equivalent to `historyTurns: 0`). */
  history?: ControlTopicHistory;
}

export interface NlDispatch {
  describeNlCommand(command: FleetCommand | SessionCommand | RouterAction): string;
  executeMatchedCommand(command: FleetCommand | SessionCommand | RouterAction, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined): void;
  postNlConfirm(command: FleetCommand | SessionCommand | RouterAction, threadId: number | undefined, currentSlug: string | undefined): Promise<void>;
  routeOrFallback(
    text: string,
    ctx: { isControl: boolean; hasSession: boolean; repoNames?: string[] },
    threadId: number | undefined,
    isControl: boolean,
    currentSlug: string | undefined,
    onNoMatch: () => void,
    onRetryMatch: () => void | Promise<void>,
    // §5.x (message-context.ts): same value `dispatchInboundMessage` receives, forwarded through so
    // a control-topic reply (no session yet to forward into) still reaches the NL classifier and,
    // for a `kind='new'`/`kind='new_pick_repo'` match, the new session's own `sourceText` - the one
    // gap `contextPrefix` didn't originally cover (it was applied only at the forward-into-a-live-
    // session send in command-dispatch.ts). Defaults to "" so every existing caller/test is unaffected.
    contextPrefix?: string,
  ): Promise<void>;
}

export function createNlDispatch(opts: NlDispatchOptions): NlDispatch {
  const {
    controlBot,
    routing,
    ptyIo,
    typingIndicator,
    thinkingPlaceholder,
    cardSenders,
    applyModelSwitch,
    applyModeSwitch,
    applyEffortSwitch,
    nlConfirmRegistry,
    repoPickRegistry,
    dispatchFleetCommand,
    nlRouterConfig,
    settings,
    supergroupChatId,
    log,
    history,
  } = opts;
  const routeText = opts.routeText ?? realRouteText;
  const answerControlTopicQuestion = opts.answerControlTopicQuestion ?? realAnswerControlTopicQuestion;

  /** Short human-readable label for an NL-matched command's confirm card and its finalize message
   * - not exhaustive-per-field (e.g. `/new`'s prompt text isn't echoed back), just enough for the
   * operator to recognise what they're about to approve. */
  function describeNlCommand(command: FleetCommand | SessionCommand | RouterAction): string {
    switch (command.kind) {
      case "kill":
        return command.all ? "/kill --all" : `/kill${command.slug ? ` ${command.slug}` : ""}`;
      case "rm":
        if (command.bulk?.mode === "all") return "/remove --all";
        if (command.bulk?.mode === "dead") return "/remove --dead";
        if (command.bulk?.mode === "prefix") return `/remove --prefix ${command.bulk.prefix}`;
        return `/remove${command.slug ? ` ${command.slug}` : ""}`;
      case "restart":
        return "/restart";
      case "merge":
        return `/merge ${command.slug}`;
      case "repos":
        return command.action === "rm" ? `/repos rm ${command.name}` : "/repos";
      default:
        return `/${command.kind}`;
    }
  }

  /** Executes an NL-matched command that either wasn't destructive, or was and got confirmed -
   * routes to the exact same handlers a typed `/command` or `/model`/`/mode`/`/effort` would use
   * (`dispatchFleetCommand`, `applyModelSwitch`/`applyModeSwitch`/`applyEffortSwitch`), never a
   * separate copy. `nl-router.ts`'s `mapRouterOutput` already guarantees a `session_*` kind never
   * arrives without `currentSlug`/`threadId` set (`allowedKinds`'s `hasSession` gate), so the guard
   * here is defense in depth, not load-bearing. */
  function executeMatchedCommand(command: FleetCommand | SessionCommand | RouterAction, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined): void {
    // Hoisted once - help/commands/skills/browse/find each independently recomputed this same
    // conditional lookup inline.
    const route = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
    if (command.kind === "help") {
      cardSenders.sendHelpCard(threadId, route);
      return;
    }
    if (command.kind === "about") {
      cardSenders.sendAboutCard(threadId);
      return;
    }
    if (command.kind === "commands") {
      cardSenders.sendCommandsListCard(threadId, route, command.term);
      return;
    }
    if (command.kind === "skills") {
      cardSenders.sendSkillsListCard(threadId, route, command.term);
      return;
    }
    if (command.kind === "builtin") {
      if (currentSlug) ptyIo.sendRaw(currentSlug, `/${command.name}`);
      return;
    }
    if (command.kind === "browse") {
      cardSenders.sendBrowseCard(threadId, route, command.path);
      return;
    }
    if (command.kind === "find") {
      cardSenders.sendFindCard(threadId, route, command.query);
      return;
    }
    if (command.kind === "diff") {
      cardSenders.sendDiffCard(threadId, route);
      return;
    }
    // Never actually reached - `routeOrFallback` intercepts `kind === "retry"`/`"new_pick_repo"`
    // themselves before calling here (see their own comments there) - kept only so this function's
    // `FleetCommand | SessionCommand | RouterAction` parameter type still narrows the fall-through
    // `dispatchFleetCommand(command, ...)` call below to `FleetCommand`, which neither `retry` nor
    // `new_pick_repo` (both `RouterAction`) is.
    if (command.kind === "retry" || command.kind === "new_pick_repo") return;
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
      const confirmText = `🤖 I read that as ${describeNlCommand(command)} - run it?`;
      const sent = await controlBot.sendMessage(supergroupChatId, threadId, confirmText, {
        inline_keyboard: buildNlConfirmKeyboard(id),
      });
      history?.recordBot(confirmText);
      nlConfirmRegistry.add({ id, command, threadId, currentSlug, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post NL-confirm card: ${(err as Error).message}`);
    }
  }

  /** Posts the ask-which-repo keyboard for a `new_pick_repo` match (`nl-router.ts`) - the "new"
   * equivalent of `postNlConfirm` above, minus the destructive-confirm framing: this isn't confirming
   * a guess, it's resolving a genuine ambiguity `mapRouterOutput` refused to guess past. `sourceText`
   * is the operator's own raw message, carried through so the eventual `handleNewCommand` call gets
   * the same "operator's own words, not the classifier's paraphrase" treatment a direct `kind='new'`
   * match already gets a few lines below in `routeOrFallback`. */
  async function postRepoPick(prompt: string, model: Model | undefined, sourceText: string, repoNames: readonly string[], threadId: number | undefined): Promise<void> {
    const id = randomUUID().slice(0, 8);
    try {
      const pickText = `🤖 Which repo should I start "${prompt}" against?`;
      const sent = await controlBot.sendMessage(supergroupChatId, threadId, pickText, {
        inline_keyboard: buildRepoPickKeyboard(id, repoNames),
      });
      history?.recordBot(pickText);
      repoPickRegistry.add({ id, prompt, sourceText, model, threadId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post repo-pick card: ${(err as Error).message}`);
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
    onRetryMatch: () => void | Promise<void>,
    contextPrefix = "",
  ): Promise<void> {
    if (!nlRouterConfig.enabled) {
      onNoMatch();
      return;
    }
    // Fed to the classifier/Q&A call and into a `kind='new'`/`new_pick_repo` match's `sourceText`
    // below - never into `history.recordOperator(text)` a few lines down, which stays the operator's
    // own literal words (the history buffer is a transcript, not an interpretation aid). See this
    // function's `contextPrefix` param doc for why a bare `text` here was the bug.
    const contextedText = contextPrefix + text;
    // Recorded regardless of match outcome, but only in the control topic - the history buffer is a
    // control-topic-only concept (plans/control-topic-nl-dialogue-plan.md §4); a session's own topic
    // already has its own native conversation context and never reads this buffer.
    if (ctx.isControl) history?.recordOperator(text);
    const topicIdStr = threadId !== undefined ? String(threadId) : undefined;
    // The router call itself is the latency gap with no existing "something is happening" signal
    // (unlike a forwarded turn, which sendChannelText already covers) - live-observed as a silent
    // multi-second wait on the CLI backend, in *both* the no-session (control-topic `/new`) and the
    // hasSession (plain text into an existing session's own topic, e.g. "Continue") cases. Reuses
    // §5's two existing indicators rather than inventing a third: `typingIndicator` always,
    // `thinkingPlaceholder` unconditionally too now (2026-08-09) - it used to be gated to
    // `!ctx.hasSession` specifically to avoid orphaning a message when `sendChannelText`'s own
    // `start()` a few lines below `onNoMatch()` fired a moment later, but `thinking-placeholder.ts`
    // now de-dupes `start()` per topic instead, so that second call is a safe no-op covering the
    // same wait rather than a second message to leak.
    const usePlaceholder = topicIdStr !== undefined;
    if (topicIdStr) typingIndicator.start(topicIdStr);
    if (usePlaceholder) thinkingPlaceholder.start(topicIdStr!);

    const result = await routeText(contextedText, ctx, { ...nlRouterConfig, backend: settings.nlRouterBackend }, log);

    if (topicIdStr) typingIndicator.stop(topicIdStr);
    // `kind === "new"` is the one outcome whose own latency (topic creation, worktree, PTY spawn -
    // session-lifecycle-commands.ts's `handleNewCommand`) dwarfs the router call this placeholder was
    // covering - deleting it here just reopens the same silent gap one step later, live-observed as a
    // multi-second wait between this message and "Created ... in a new topic." Left pending in
    // `thinkingPlaceholder`'s map instead, so `handleNewCommand` (which knows the topic that map entry
    // is keyed under, `controlTopicId` = this same `threadId`) can consume/clear it once its own work
    // is actually done, rather than every other outcome's "gone the instant routing finishes" shape.
    const deferPlaceholderToNew = usePlaceholder && result.matched && result.command.kind === "new";
    // Symmetric case for the hasSession side: no match here means `onNoMatch` below forwards this
    // text straight into the PTY via `sendChannelText` for a real Claude turn, which can run far
    // longer than this router call did - `pipe-server.ts`'s `onReplySent` is the one that actually
    // clears this placeholder, once that turn's reply lands, not this function.
    const deferPlaceholderToForward = usePlaceholder && ctx.hasSession && !result.matched;
    if (usePlaceholder && !deferPlaceholderToNew && !deferPlaceholderToForward) {
      const placeholderMsgId = await thinkingPlaceholder.consume(topicIdStr!);
      // Removed outright, not edited into a final state - no single text fits every outcome below
      // (a command's own reply, a confirm card, or "Unrecognised control-topic command" are all
      // separate messages that follow immediately).
      if (placeholderMsgId !== undefined && controlBot.deleteMessage) {
        await controlBot.deleteMessage(supergroupChatId, placeholderMsgId).catch((err) => log("WARN", `failed to delete NL-router placeholder: ${(err as Error).message}`));
      }
    }

    if (!result.matched) {
      // Control-topic free-form Q&A (plans/control-topic-nl-dialogue-plan.md) - only in the control
      // topic (a session's own topic already forwards unmatched text to a live Claude turn with real
      // repo access, which answers better - this path never fires there). A second, isolated
      // `claude -p` call that can only ever produce a string or `null`, never a command - it cannot
      // execute anything, so this never touches the destructive-confirm gate below.
      if (ctx.isControl) {
        const groundingText = buildDialogueGroundingText();
        const historyText = formatHistoryForPrompt(history?.recent(nlRouterConfig.historyTurns ?? 0) ?? []);
        const answer = await answerControlTopicQuestion(contextedText, groundingText, historyText, nlRouterConfig.model, log);
        if (answer) {
          history?.recordBot(answer);
          try {
            await controlBot.sendMessage(supergroupChatId, threadId, answer);
          } catch (err) {
            log("WARN", `failed to send control-topic Q&A answer: ${(err as Error).message}`);
          }
          return;
        }
      }
      onNoMatch();
      return;
    }
    // `retry` is a `RouterAction` in name only - it has no card/handler of its own the way
    // `help`/`browse`/etc. do. `command-dispatch.ts` owns the actual retry mechanics (replying to
    // the earlier message vs. the topic-keyed `retryStore`), the same ones `isRetryPhrase`'s regex
    // fast-path already triggers - this just widens what triggers them to any-language natural
    // phrasing, so it's intercepted here rather than falling into `executeMatchedCommand`'s switch
    // (which has no branch for it and would silently drop it into `dispatchFleetCommand`).
    if (result.command.kind === "retry") {
      await onRetryMatch();
      return;
    }
    // Same "no dedicated card/handler" shape as `retry` above, for the ambiguous-repo case
    // `mapRouterOutput`'s "new" case defers here rather than guessing: post the ask-which-repo
    // keyboard and stop - there is no `FleetCommand`/`SessionCommand` yet to hand to
    // `executeMatchedCommand`, only once a repo is actually tapped (callback-query-router.ts's `rp:`
    // rule turns that tap into a real `kind='new'` call).
    if (result.command.kind === "new_pick_repo") {
      await postRepoPick(result.command.prompt, result.command.model, contextedText, ctx.repoNames ?? [], threadId);
      return;
    }
    // The router's own `prompt` field is an emergent English paraphrase (its classification prompt
    // is all-English with no language-preservation instruction) - fine for the slug/topic title,
    // wrong for what the session actually sees as its first turn. Attaching the raw message here
    // (before the destructive/confirm branch, so a deferred `/new` would carry it too - moot today
    // since 'new' is never destructive, but this keeps the guarantee in one place) lets
    // `handleNewCommand` recover the operator's own words via `newSessionContent`. Uses
    // `contextedText` (not bare `text`) so a control-topic reply's quoted context - e.g. replying to
    // a burn-rate alarm with "create a session for analyze this alarm" - survives into both the new
    // topic's announcement and the session's actual first turn, instead of leaving Claude to guess
    // what "this alarm" refers to.
    if (result.command.kind === "new") result.command = { ...result.command, sourceText: contextedText };
    if (result.destructive && settings.assistEnabled) {
      fireAndForget(postNlConfirm(result.command, threadId, currentSlug), log, "nl-dispatch postNlConfirm");
      return;
    }
    executeMatchedCommand(result.command, threadId, isControl, currentSlug);
  }

  return { describeNlCommand, executeMatchedCommand, postNlConfirm, routeOrFallback };
}
