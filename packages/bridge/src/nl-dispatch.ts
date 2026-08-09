import { randomUUID } from "node:crypto";
import { fireAndForget } from "./fire-and-forget.ts";
import { buildNlConfirmKeyboard, NlConfirmRegistry } from "./nl-confirm.ts";
import { routeText as realRouteText } from "./nl-router.ts";
import type { RouterAction } from "./nl-router.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { Effort, Mode, SessionCommand } from "./session-commands.ts";
import type { CardSenders } from "./card-senders.ts";
import type { PtyIo } from "./pty-io.ts";
import type { Routing } from "./routing.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { TypingIndicator } from "./typing-indicator.ts";
import type { SendMessageSource } from "./telegram.ts";

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
  dispatchFleetCommand: (fleetCmd: FleetCommand, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined) => void;
  nlRouterConfig: { enabled: boolean; apiKey: string | undefined; model: string };
  getNlRouterBackend: () => "api" | "cli";
  getAssistEnabled: () => boolean;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  /** Defaults to the real `nl-router.ts` implementation - injectable so `routeOrFallback`'s own
   * control flow (indicator start/stop, the destructive-confirm gate, dispatch to
   * `executeMatchedCommand`) is unit-testable without a real CLI/API backend call. */
  routeText?: typeof realRouteText;
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
    dispatchFleetCommand,
    nlRouterConfig,
    getNlRouterBackend,
    getAssistEnabled,
    supergroupChatId,
    log,
  } = opts;
  const routeText = opts.routeText ?? realRouteText;

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
   * (`dispatchFleetCommand`, `applyModelSwitch`/`applyModeSwitch`/`applyEffortSwitch`), never a
   * separate copy. `nl-router.ts`'s `mapRouterOutput` already guarantees a `session_*` kind never
   * arrives without `currentSlug`/`threadId` set (`allowedKinds`'s `hasSession` gate), so the guard
   * here is defense in depth, not load-bearing. */
  function executeMatchedCommand(command: FleetCommand | SessionCommand | RouterAction, threadId: number | undefined, isControl: boolean, currentSlug: string | undefined): void {
    if (command.kind === "help") {
      cardSenders.sendHelpCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined);
      return;
    }
    if (command.kind === "about") {
      cardSenders.sendAboutCard(threadId);
      return;
    }
    if (command.kind === "commands") {
      cardSenders.sendCommandsListCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.term);
      return;
    }
    if (command.kind === "skills") {
      cardSenders.sendSkillsListCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.term);
      return;
    }
    if (command.kind === "builtin") {
      if (currentSlug) ptyIo.sendRaw(currentSlug, `/${command.name}`);
      return;
    }
    if (command.kind === "browse") {
      cardSenders.sendBrowseCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.path);
      return;
    }
    if (command.kind === "find") {
      cardSenders.sendFindCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined, command.query);
      return;
    }
    if (command.kind === "diff") {
      cardSenders.sendDiffCard(threadId, threadId !== undefined ? routing.getByTopicId(threadId) : undefined);
      return;
    }
    // Never actually reached - `routeOrFallback` intercepts `kind === "retry"` itself before calling
    // here (see its own comment) - kept only so this function's `FleetCommand | SessionCommand |
    // RouterAction` parameter type still narrows the fall-through `dispatchFleetCommand(command, ...)`
    // call below to `FleetCommand`, which `retry` (a `RouterAction`) isn't.
    if (command.kind === "retry") return;
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
      const sent = await controlBot.sendMessage(supergroupChatId, threadId, `🤖 I read that as ${describeNlCommand(command)} - run it?`, {
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
    onRetryMatch: () => void | Promise<void>,
  ): Promise<void> {
    if (!nlRouterConfig.enabled) {
      onNoMatch();
      return;
    }
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

    const result = await routeText(text, ctx, { ...nlRouterConfig, backend: getNlRouterBackend() }, log);

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
    // The router's own `prompt` field is an emergent English paraphrase (its classification prompt
    // is all-English with no language-preservation instruction) - fine for the slug/topic title,
    // wrong for what the session actually sees as its first turn. Attaching the raw message here
    // (before the destructive/confirm branch, so a deferred `/new` would carry it too - moot today
    // since 'new' is never destructive, but this keeps the guarantee in one place) lets
    // `handleNewCommand` recover the operator's own words via `newSessionContent`.
    if (result.command.kind === "new") result.command = { ...result.command, sourceText: text };
    if (result.destructive && getAssistEnabled()) {
      fireAndForget(postNlConfirm(result.command, threadId, currentSlug), log, "nl-dispatch postNlConfirm");
      return;
    }
    executeMatchedCommand(result.command, threadId, isControl, currentSlug);
  }

  return { describeNlCommand, executeMatchedCommand, postNlConfirm, routeOrFallback };
}
