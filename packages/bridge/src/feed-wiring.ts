import type { HookEventMessage } from "@aibridge/protocol";
import type { VerdictBehavior } from "@aibridge/protocol";
import { buildDetailsKeyboard } from "./details-button.ts";
import type { DetailsAnchorStore } from "./details-anchor-store.ts";
import { FeedCoalescer } from "./feed-coalescer.ts";
import { renderCard } from "./feed-renderer.ts";
import { applyEvent, createFeedState, promptsInLastHour, shouldSplitCard, splitCard, type FeedState } from "./feed-state.ts";
import { normalizeHookEvent } from "./hook-events.ts";
import type { RateGovernor } from "./rate-governor.ts";
import type { Routing, SessionRoute } from "./routing.ts";
import { isValidTransition, type SessionState, type SessionStore } from "./session-store.ts";
import { stateForHookEvent } from "./session-state-transitions.ts";
import { isPermanentEditFailure, type SendMessageSource } from "./telegram.ts";
import type { PendingPermissionRequest } from "./permission-registry.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { TypingIndicator } from "./typing-indicator.ts";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

// §10.4.1: this project's own choice of threshold, not a number the plan specifies - a
// conservative "worth a look" signal for whether the allowlist has grown too broad on a host with
// no sandbox, surfaced as a log line now and left for a Phase 5 fleet command to expose.
const PROMPTS_PER_HOUR_WARN_THRESHOLD = 20;

export interface FeedWiringOptions {
  sessionStore: SessionStore;
  routing: Routing;
  detailsAnchorStore: DetailsAnchorStore;
  feedGovernor: RateGovernor;
  controlBot: SendMessageSource;
  /** §5.1-§5.4: the feed card's own bot/identity, separate from `controlBot` - every render is
   * P2-lane traffic on this token, never the control bot's. */
  feedBot: SendMessageSource;
  supergroupChatId: string;
  confirmSessionCommand: ConfirmSessionCommand;
  /** Injected rather than imported - `quota-alarms.ts` (a later module in the split) owns this;
   * for now it's `index.ts`'s own hoisted function declaration, passed by reference. */
  markQuotaStopped: (slug: string) => void;
  /** The three `pipeHandle` members §6.5's terminal-race fix needs - injected individually (not
   * the whole handle) to keep this module's dependency surface minimal. `index.ts` wires these as
   * thin closures over `pipeHandle`, constructed *after* this factory (see the plan's Risks
   * section on `dispatchInboundMessage`-style forward references): each closure only reads
   * `pipeHandle` when actually invoked, by which time it exists, not when the closure is created. */
  resolveByToolMatch: (slug: string, toolName: string, toolInput: unknown) => PendingPermissionRequest | undefined;
  sendVerdict: (slug: string, requestId: string, behavior: VerdictBehavior) => boolean;
  finalizePermissionMessage: (messageId: number, text: string) => Promise<void>;
  /** Stopped the moment a turn ends (`Stop`/`StopFailure`/`SessionEnd`), not just on `onReplySent`
   * (index.ts's other caller) - a turn that ends without ever calling `reply()` left this ticking
   * every 4s for up to its 30-minute backstop with nothing actually happening, observed live
   * 2026-08-10. Both stop sites are idempotent (`typing-indicator.ts`'s `stop` on an already-stopped
   * topic is a no-op), so wiring this here doesn't risk double-stopping anything. */
  typingIndicator: TypingIndicator;
  /** Same shape/convention as `sessionSupervisor`'s `sendResumeNudge` (resume-nudge-on-lost-
   * permission-plan.md §1) - a synthetic inbound turn via `pty-io.ts`'s real `sendChannelText`,
   * fixed `msgId`/`from` identifying it as Bridge-generated. Fired from `handleHookEvent` itself
   * (not a `LateBound`): by construction order (index.ts) `feedWiring` is built *after* `ptyIo`
   * exists, unlike `sessionSupervisor`, which is built before it - so the forward-reference problem
   * that motivated `LateBound` there doesn't exist here. */
  sendNoReplyNudge: (slug: string, topicId: number, content: string) => void;
  log?: LogFn;
}

export interface FeedWiring {
  handleHookEvent(msg: HookEventMessage): void;
  postDetailsButton(slug: string, turnSeq: number): void;
  maybeSetState(slug: string, target: SessionState): void;
  /** A message landing in a session's own topic after the card's last edit pushes the card's
   * already-fixed position further up - the *next* flush needs to know this happened (see
   * `handleHookEvent`'s own turn-start handling). Called from `dispatchInboundMessage`
   * (`command-dispatch.ts`, not yet extracted) for any non-control message in a routed topic. */
  markInterjected(slug: string): void;
  /** Read-only lookup for the `"d:"` details-button callback (`callback-query-router.ts`, not yet
   * extracted) - checks the tapped turn is still the session's current one before rendering it. */
  getFeedState(slug: string): FeedState | undefined;
  /** Called from `pipe-server.ts`'s `onReplySent` (via index.ts, alongside the existing
   * `typingIndicator.stop`) the moment a reply actually lands for this slug - marks the *current*
   * turn as having produced operator-visible output, so a `Stop` that follows doesn't get flagged
   * as silent. A no-op if this slug has no tracked feed state yet (nothing to mark). */
  markReplied(slug: string): void;
  /** Read-only view of every tracked feed state, for `/ls`'s `buildLsDetail` (`fleet-commands.ts`)
   * - it needs the whole set to render each row's "running: ..." detail line, not one lookup. */
  allFeedStates(): ReadonlyMap<string, FeedState>;
  /** Drops this slug's feed-render state - called from `removeSessionRow`'s `/rm` teardown
   * (`session-lifecycle-commands.ts`, not yet extracted). */
  forgetSession(slug: string): void;
  /** Forces whatever's pending for this slug to flush immediately, returning the underlying send's
   * own promise - `pipe-server.ts`'s `onBeforeReply` awaits this (bounded by its own timeout) so a
   * reply never lands visually ahead of the card describing what led to it. */
  resetCoalescer(slug: string): Promise<void> | void;
  /** §5.4 point 4's quiet-mode notice, called from the composition root's periodic sweep: posts
   * once on the rising edge of P2 pressure, and resets so a later, separate storm notifies again. */
  checkQuietMode(): void;
}

/**
 * The hook-event -> feed-card rendering pipeline (§5.1-§5.4): turns a raw `HookEventMessage` into
 * `feed-state.ts`'s applied event, decides turn/split boundaries, and hands the rendered card to
 * `FeedCoalescer` for P2-lane-governed, change-only sends. Also owns the turn's "details" button
 * anchor (`postDetailsButton`) and the state-table half of hook-driven transitions (`maybeSetState`)
 * - both fire from the same hook events this module already normalizes.
 */
export function createFeedWiring(opts: FeedWiringOptions): FeedWiring {
  const { sessionStore, routing, detailsAnchorStore, feedGovernor, controlBot, feedBot, supergroupChatId, confirmSessionCommand, markQuotaStopped } = opts;
  const { resolveByToolMatch, sendVerdict, finalizePermissionMessage, typingIndicator, sendNoReplyNudge } = opts;
  const log = opts.log ?? (() => {});

  // How many *consecutive* turns have ended silently (no reply) for a slug - reset the moment
  // `markReplied` fires. Bounded the same way `resumeSession`'s follow-up nudge is (resume-nudge-
  // on-lost-permission-plan.md §7's "not a retry loop - exactly one follow-up"): nudging is itself a
  // synthetic inbound turn, so a session that ignores the nudge too would otherwise nudge itself
  // forever. One automatic nudge, then a plain warning notice instead of a second nudge.
  const silentStopStreak = new Map<string, number>();

  // §5.1-§5.4: one turn-card state per session, sharing feedGovernor's P2 lane (droppable, unlike
  // P0/P1) with a coalescer that skips a render when the text hasn't actually changed.
  const feedStates = new Map<string, FeedState>();
  const feedMessageIds = new Map<string, number>();
  // A message landing in a session's own topic after the card's last edit leaves the still-live
  // card visually "stuck" above it - Telegram never repositions an edited message, the same fact
  // behind the turn/split boundaries below, just triggered by the *operator* instead of a hook
  // event (live-observed complaint, 2026-08-07). Marked via markInterjected, consumed (and
  // cleared) by the next flush - no need to force an immediate one, since there's nothing new to
  // show until the next hook event anyway.
  const feedInterjected = new Set<string>();
  const feedCoalescer = new FeedCoalescer({
    activeSessionCount: () => routing.all().length,
    quietMode: () => feedGovernor.p2PressureExceeded(),
    // Returns `feedGovernor.schedule`'s own promise (0.97.0) rather than firing it and returning
    // nothing - `resetCoalescer` propagates this back out to `pipe-server.ts`'s `onBeforeReply`, so
    // awaiting a reply's ordering barrier actually awaits this call's underlying Telegram send, not
    // just its scheduling.
    onFlush: (slug, text) => {
      return feedGovernor.schedule("P2", async () => {
        // §4.2's /pause: replies and prompts still flow, only the feed card stops updating.
        if (sessionStore.get(slug)?.paused) return;
        const route = routing.get(slug);
        if (!route) return;
        if (feedInterjected.delete(slug)) feedMessageIds.delete(slug);
        const existingMessageId = feedMessageIds.get(slug);
        if (existingMessageId !== undefined && feedBot.editMessageText) {
          try {
            await feedBot.editMessageText(supergroupChatId, existingMessageId, text, undefined, "HTML");
          } catch (err) {
            // A per-message permanent failure has to invalidate the cached id, or the feed for this
            // session is dead for the rest of the process's life: the P2 lane swallows rejections,
            // so every later flush edited the same unusable message, silently, forever. Dropping
            // the id makes the next flush post a fresh card instead. (Reachable by deleting the
            // card by hand, and by Telegram's 48h edit window on a long-lived session.)
            if (isPermanentEditFailure(err)) {
              feedMessageIds.delete(slug);
              log("WARN", `feed card for "${slug}" is no longer editable (${(err as Error).message}) - a fresh card will be posted`);
              return;
            }
            throw err;
          }
        } else {
          const sent = await feedBot.sendMessage(supergroupChatId, route.topicId, text, undefined, "HTML");
          feedMessageIds.set(slug, sent.message_id);
        }
      });
    },
  });

  const nowIso = () => new Date().toISOString();

  function maybeSetState(slug: string, target: SessionState): void {
    const row = sessionStore.get(slug);
    if (row && row.state !== target && isValidTransition(row.state, target)) {
      sessionStore.setState(slug, target, nowIso());
    }
  }

  /** §5.5: one small anchor message per turn carrying the `details` button - see
   * `details-button.ts` for why this can't just live on the turn card itself. P1 lane (a
   * lifecycle notice, not a permission/question card), and skipped for a `/pause`d session for
   * the same reason `feedCoalescer`'s own flush is (§4.2: "replies and prompts still flow, only
   * the feed card stops updating" - this is feed-adjacent, not a reply or a prompt).
   *
   * The anchor is edited in place (not left un-edited) once its button is actually tapped - see
   * `callback-query-router.ts`'s "d:" branch - so its own message_id is persisted here
   * (`detailsAnchorStore`, survives a restart on the operator's own request) the moment it's known. */
  function postDetailsButton(slug: string, turnSeq: number): void {
    if (sessionStore.get(slug)?.paused) return;
    const route = routing.get(slug);
    if (!route) return;
    feedGovernor
      .scheduleAsync("P1", () =>
        controlBot.sendMessage(supergroupChatId, route.topicId, "Click Details to see this turn's full log.", {
          inline_keyboard: buildDetailsKeyboard(slug, turnSeq),
        }),
      )
      .then((sent) => detailsAnchorStore.set(slug, turnSeq, sent.message_id, Date.now()))
      .catch((err) => log("WARN", `failed to post details button for "${slug}": ${(err as Error).message}`));
  }

  /**
   * §6.5's terminal-race fix (§13 check 4): if the operator answers Claude Code's own terminal
   * prompt instead of tapping the Telegram card, there is no protocol event saying so - the first
   * sign is one of these three hooks landing for the same tool the pending card is for.
   * `PermissionDenied` on its own is ambiguous (fired by the sandbox's own deny rules too, with
   * nothing pending to match), so it's folded into the same lookup rather than special-cased.
   * Extracted out of `handleHookEvent`'s own body, which otherwise mixed this in with five other
   * independent hook-driven concerns.
   */
  function resolveTerminalRacePermission(msg: HookEventMessage): void {
    if (msg.hook_event_name !== "PostToolUse" && msg.hook_event_name !== "PostToolUseFailure" && msg.hook_event_name !== "PermissionDenied") return;
    const toolName = typeof msg.payload.tool_name === "string" ? msg.payload.tool_name : undefined;
    // The tool *input* is what makes this a match rather than a guess - see `resolveByToolMatch`
    // and `toolInputMatches` on what pairing by tool name alone did, and on why the comparison has
    // to parse the preview rather than substring-search it.
    const resolved = toolName ? resolveByToolMatch(msg.slug, toolName, msg.payload.tool_input) : undefined;
    if (!resolved) return;
    // The card is only half of it: the channel server's permission call is still blocked, and
    // nothing else will unblock it now that the entry is out of the registry (the expiry sweep
    // can no longer see it). Send the verdict the operator's own terminal answer implies.
    sendVerdict(resolved.slug, resolved.requestId, msg.hook_event_name === "PermissionDenied" ? "deny" : "allow");
    const behaviorLabel = msg.hook_event_name === "PermissionDenied" ? "⛔ Denied" : "✅ Allowed";
    finalizePermissionMessage(resolved.messageId, `${behaviorLabel}: ${resolved.toolName} (answered at terminal)`).catch((err) =>
      log("WARN", `failed to finalize permission message resolved at the terminal for "${msg.slug}": ${(err as Error).message}`),
    );
  }

  /**
   * §7 of resume-nudge-on-lost-permission-plan.md: on a genuine `turn_end` that never called
   * `reply()`, nudge once, then give up and warn if the *next* one is silent too - a nudge is
   * itself a synthetic inbound turn, so a session that stays silent through it too must not nudge
   * itself forever. `silentStopStreak` is incremented regardless of whether a route exists (so a
   * route reappearing later still sees the right streak); with no route, there's simply nowhere to
   * send anything. Extracted out of `handleHookEvent`'s own body for the same reason as
   * `resolveTerminalRacePermission` above.
   */
  function handleNoReplyNudge(slug: string, route: SessionRoute | undefined): void {
    const streak = (silentStopStreak.get(slug) ?? 0) + 1;
    silentStopStreak.set(slug, streak);
    if (!route) return;
    if (streak === 1) {
      sendNoReplyNudge(slug, route.topicId, "Your last turn ended without sending a reply - the operator saw nothing happen. Reply now with what you found/did, or say why there's nothing to report.");
      return;
    }
    log("WARN", `session "${slug}" ended a turn without replying ${streak} times in a row - not nudging again`);
    confirmSessionCommand(route.topicId, `⚠️ Session "${slug}" ended a turn without replying, ${streak} times in a row - the automatic nudge didn't help. It may need a manual look, or /restart.`);
  }

  function handleHookEvent(msg: HookEventMessage): void {
    const row = sessionStore.get(msg.slug);

    // Live-observed 2026-08-08: `SessionStore.setSessionId` existed and was unit-tested, but
    // nothing in production ever called it - `handleHookEvent` is the only place a live
    // `session_id` from Claude Code ever reaches the Bridge, and it never persisted one. Every
    // session, not just brand-new ones, silently lost `claude --resume` across every future Bridge
    // restart: `resumeSession` (session-supervisor.ts) reads `row.sessionId`, found it permanently
    // null, and killed the session with "no session id was recorded yet" instead of resuming it.
    // `SessionStart` is the right (and only necessary) hook to key off - it fires once per live
    // `claude` process with that process's own id, and a resumed conversation's `SessionStart`
    // carries the same id back, so re-setting it is idempotent, not just harmless.
    if (row && msg.hook_event_name === "SessionStart" && row.sessionId !== msg.session_id) {
      sessionStore.setSessionId(msg.slug, msg.session_id);
    }

    resolveTerminalRacePermission(msg);

    // §4.3's state table, the hook-driven half (the permission/ask half is wired via
    // onAwaitingInput/maybeSetState in index.ts) - a stale/duplicate event is a silent no-op, not
    // an error.
    const targetState = stateForHookEvent(msg.hook_event_name, typeof msg.payload.reason === "string" ? msg.payload.reason : undefined);
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
    let next = applyEvent(previous, event, nowMs);
    feedStates.set(msg.slug, next);
    const feedSettings = row ? { detail: row.feedDetail, verbose: row.feedVerbose } : undefined;

    // A turn ending (`turn_end`/`session_end`) is the real "Claude is done, for better or worse"
    // signal - `onReplySent` (index.ts) covers the common case, but a turn that ends *without* ever
    // calling `reply()` never fires it, and the typing indicator otherwise keeps ticking every 4s
    // for up to its 30-minute backstop with nothing actually happening (live-observed 2026-08-10).
    // Both stop sites are idempotent, so stopping it again here on a turn that did reply is harmless.
    if ((event.kind === "turn_end" || event.kind === "session_end") && previous.turnActive) {
      const route = routing.get(msg.slug);
      if (route) typingIndicator.stop(String(route.topicId));
    }

    // The no-reply nudge: only for a genuine `turn_end` (not `session_end` - a session that just
    // exited has no live PTY left to nudge), only if a turn had actually started, and only if that
    // turn never called `reply()`. Mirrors resume-nudge-on-lost-permission-plan.md's own nudge
    // mechanism and its "exactly one automatic follow-up, then give up" bound (§7) - a nudge is
    // itself a synthetic inbound turn, so a session that stays silent through the nudge too must not
    // nudge itself forever.
    if (event.kind === "turn_end" && previous.turnActive && !previous.repliedThisTurn) {
      handleNoReplyNudge(msg.slug, routing.get(msg.slug));
    }

    if (event.kind === "turn_start") {
      // §5.3/§5.4 are explicit that the card is *one message per turn*, edited in place - so a new
      // turn must start a new message. Without this the id set on the session's very first flush
      // was reused forever: turn 2 overwrote turn 1's record of what happened, and by turn 6 the
      // "live" card was buried above dozens of newer messages, since Telegram never repositions an
      // edited message. (`postDetailsButton` above already posts a fresh anchor per turn - the two
      // were out of step.)
      // Order matters, and getting it backwards undoes the whole fix. `reset` flushes any render that
      // was still armed when the turn ended, and that flush runs *synchronously* (the P2 lane invokes
      // its callback inline, and the callback reads `feedMessageIds` before its first await). So the
      // outgoing turn's last frame has to be able to still find its own card id - clear the id first
      // and that final frame gets posted as a brand-new message, leaving turn N frozen at an earlier
      // frame and turn N+1 editing turn N's final content. Flush into the old card, *then* forget it.
      feedCoalescer.reset(msg.slug);
      feedMessageIds.delete(msg.slug);
      const promptCount = promptsInLastHour(next, nowMs);
      if (promptCount > PROMPTS_PER_HOUR_WARN_THRESHOLD) {
        log("WARN", `session "${msg.slug}" started ${promptCount} turns in the last hour - check whether its allowlist has grown too broad (§10.4.1)`);
      }
      postDetailsButton(msg.slug, next.turnSeq);
    } else if (shouldSplitCard(next)) {
      // A very long turn (many tool calls) otherwise edits the same message forever, which loses
      // any sense of *when* things happened relative to anything else in the topic (live-observed
      // complaint, 2026-08-07) - same underlying Telegram fact as the turn boundary above (edits
      // never reposition), just crossed mid-turn instead of between turns. Same flush-then-clear
      // order and the same reason: render (and let this notify carry) the boundary-crossing line
      // into the card about to be frozen *before* moving `cardLineOffset` past it, or that line
      // never appears in either card.
      feedCoalescer.notify(msg.slug, renderCard(next, nowMs, feedSettings));
      feedCoalescer.reset(msg.slug);
      feedMessageIds.delete(msg.slug);
      next = splitCard(next);
      feedStates.set(msg.slug, next);
    }

    feedCoalescer.notify(msg.slug, renderCard(next, nowMs, feedSettings));
  }

  function markInterjected(slug: string): void {
    feedInterjected.add(slug);
  }

  function getFeedState(slug: string): FeedState | undefined {
    return feedStates.get(slug);
  }

  function markReplied(slug: string): void {
    silentStopStreak.delete(slug);
    const state = feedStates.get(slug);
    if (state) feedStates.set(slug, { ...state, repliedThisTurn: true });
  }

  function allFeedStates(): ReadonlyMap<string, FeedState> {
    return feedStates;
  }

  function forgetSession(slug: string): void {
    feedStates.delete(slug);
    feedMessageIds.delete(slug);
    // Same leak class as session-supervisor.ts's `untrack` was hardened against for
    // `resumeAttempts`/`lastPtyActivityBySlug` (plans/codebase-hardening-plan.md P1-2): slugs are
    // reused after `/rm` (they're derived from prompt text), so a stale streak left here would let
    // a brand-new session inherit someone else's silent-stop count and lose its own first nudge.
    silentStopStreak.delete(slug);
  }

  function resetCoalescer(slug: string): Promise<void> | void {
    return feedCoalescer.reset(slug);
  }

  // §5.4 point 4's quiet-mode notice: posted once on the rising edge only ("posts ... once", not
  // on every tick while pressure persists), and reset once pressure clears so a later, separate
  // storm notifies again rather than staying silent forever after the first one.
  let quietModeNotified = false;

  function checkQuietMode(): void {
    const quiet = feedGovernor.p2PressureExceeded();
    if (quiet && !quietModeNotified) {
      quietModeNotified = true;
      confirmSessionCommand(undefined, `⚠️ feed throttled, ${routing.all().length} sessions active`);
    } else if (!quiet && quietModeNotified) {
      quietModeNotified = false;
    }
  }

  return {
    handleHookEvent,
    postDetailsButton,
    maybeSetState,
    markInterjected,
    getFeedState,
    markReplied,
    allFeedStates,
    forgetSession,
    resetCoalescer,
    checkQuietMode,
  };
}
