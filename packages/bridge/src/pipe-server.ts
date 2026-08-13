import { promises as fsPromises } from "node:fs";
import path from "node:path";
import net from "node:net";
import { DEFAULT_PIPE_PATH, encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type {
  ChannelMetaFields,
  HelloAck,
  HookAnswerMessage,
  HookAskMessage,
  HookEventMessage,
  InboundMessage,
  Message,
  PermissionRequestMessage,
  ReplyMessage,
  SendFileMessage,
  VerdictBehavior,
  VerdictMessage,
} from "@aibridge/protocol";
import { buildAskKeyboard, renderAskCard } from "./ask-callback.ts";
import { AskRegistry, type PendingAsk } from "./ask-registry.ts";
import { isCompoundCommandFullyAllowed, WIDENED_AUTO_APPROVE_PREFIXES } from "./compound-permission.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import { isImagePath, resolveOutboxPath } from "./outbox.ts";
import { buildPermissionKeyboard, renderPermissionCard } from "./permission-callback.ts";
import { PermissionRegistry, type PendingPermissionRequest } from "./permission-registry.ts";
import type { RateGovernor } from "./rate-governor.ts";
import { extractBashCommand, isCoveredByBareToolRule } from "./rule-derivation.ts";
import { scrubSecrets } from "./secret-scrub.ts";
import { readSettingsFile, type PermissionSettings } from "./settings.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { Routing } from "./routing.ts";
import type { SendMessageSource } from "./telegram.ts";
import { splitForTelegram } from "./telegram-split.ts";
import type { LogFn } from "./logger.ts";

export { DEFAULT_PIPE_PATH };

export interface PipeServerOptions {
  pipePath?: string;
  routing: Routing;
  controlBot: SendMessageSource;
  /** §5.4's P0 lane: permission/question cards, their resolutions and callback acks - never
   * dropped, never delayed by the feed bot's P2 traffic. Optional so existing stub-server tests
   * that construct `PipeServerOptions` without a governor keep working unchanged (falls back to
   * calling `controlBot` directly, the pre-governor behaviour). */
  governor?: RateGovernor;
  /** The one supergroup chat every session's topics live in (§4.1). */
  chatId: string;
  /** §5.8: root for `outbox.ts`'s `resolveOutboxPath` - every `send_file` path is checked against
   * `<stateDir>/sessions/<slug>/outbox/` before anything is read off disk. Optional so existing
   * tests that never exercise `send_file` don't need to supply one; a `send_file` arriving with no
   * `stateDir` configured is logged and dropped rather than defaulting to something guessed. */
  stateDir?: string;
  /** If a "🤔 Thinking..." placeholder is pending for this topic, it's deleted once the reply
   * actually sends (0.104.0 - previously edited in place; see `handleReply`'s own doc comment for
   * why that changed) rather than left to go stale (see `thinking-placeholder.ts`). */
  thinkingPlaceholder?: ThinkingPlaceholder;
  /** Fires after a `reply` is successfully delivered - the typing indicator's stop signal (§5's
   * feed doesn't exist yet, but "a reply landed" is already known here regardless). The reply text
   * is passed through too so a caller can drive §4.4's rename-once off the session's first reply
   * without this module needing to know anything about topics or the routing table. */
  onReplySent?: (topicId: string, text: string) => void;
  /**
   * Fires right before a `reply`'s text is actually sent (before the first `p1(...)` call below),
   * and is *awaited* (bounded by `onBeforeReplyTimeoutMs`) - lets a caller force-flush this slug's
   * coalesced feed card first (`feed-coalescer.ts`'s `reset`) and hold the reply back until that
   * flush's own send has actually completed, not merely started.
   *
   * Live-observed 2026-08-07: a reply routinely landed in the topic *before* the "working..." card
   * describing the investigation it's actually summarising, since the feed card sits behind
   * `FeedCoalescer`'s own several-second interval while the reply's P1 lane is deliberately
   * unthrottled (§5.4 - P1 must never wait on P2's traffic in general). The first fix (0.91.0) only
   * force-started that flush a few microtasks earlier - a head start, still a race, since nothing
   * stopped the reply's own send from completing first. 0.97.0 (this version) closes that race for
   * the case that actually matters - the one turn boundary immediately before a reply - by awaiting
   * the flush itself: every Telegram bot library's own recommended fix for out-of-order delivery is
   * "await each send before issuing the next" (there is no server-side ordering guarantee across
   * independent `sendMessage` calls, confirmed against the Bot API's own docs and multiple client
   * libraries' issue trackers), and this is that discipline applied across the P1/P2 boundary at the
   * one moment they're causally linked. Still bounded by a timeout rather than a truly hard
   * guarantee - a wedged or heavily rate-limited feed bot must never be able to stall a reply
   * indefinitely - but the common case (the near-totality of real turns) now has a real ordering
   * guarantee instead of a better-odds race.
   */
  onBeforeReply?: (slug: string) => Promise<void> | void;
  /** Upper bound on how long `handleReply` will wait on `onBeforeReply` before sending anyway.
   * Default 1500ms - comfortably past a normal Telegram round trip, short enough that a genuinely
   * stuck feed bot (empty-bucket P2 already resolves immediately, so this only bites on real network
   * stalls) never turns into a visibly "hung" reply. */
  onBeforeReplyTimeoutMs?: number;
  /** §5.1: every hook firing forwards one `event` message here. The hook client is a one-shot
   * process (a fresh connection per firing, no persistent registration to track), so this is the
   * only wiring needed on this side - there is no per-hook `hello_ack` to send back. */
  onHookEvent?: (msg: HookEventMessage) => void;
  /** §4.3: a freshly-posted permission/question card moves the session's tracked state to
   * `awaiting_input`. Not fired on an ask reconnect rebind (the question was already pending). */
  onAwaitingInput?: (slug: string) => void;
  /** Fires once the channel server (Claude Code's own MCP client for this session) registers
   * itself via `hello` - the deterministic signal that its MCP handshake has actually completed,
   * used by `index.ts` to know when it's finally safe to write a session's first inbound message
   * without racing that handshake (confirmed live 2026-08-04: a fixed delay guessed at this was
   * unreliable - this event is what replaced it). */
  onChannelConnected?: (slug: string) => void;
  log?: LogFn;
}

export interface PipeServerHandle {
  server: net.Server;
  /** Pushes an `inbound` message to the connected channel server for `slug`, if any. Returns
   * whether a connection was found to send it to. */
  sendInbound(slug: string, content: string, meta: ChannelMetaFields): boolean;
  /** Pushes a `verdict` to the connected channel server for `slug`. Returns whether a connection
   * was found to send it to (§6.3's round trip - the channel server relays this on to Claude). */
  sendVerdict(slug: string, requestId: string, behavior: VerdictBehavior): boolean;
  /** Resolves (and removes) a pending permission request by id - undefined for unknown or expired
   * ids (§9 scenarios 6-7), never throws. */
  resolvePermission(requestId: string): PendingPermissionRequest | undefined;
  /** Edits a permission card in place once resolved, stripping its keyboard (§6.5). Reused
   * verbatim for ask cards too - the edit itself has nothing permission-specific about it. */
  finalizePermissionMessage(messageId: number, text: string): Promise<void>;
  /** The registry itself, exposed for the expiry sweep (§6.5: strip + mark "expired" past 30min). */
  permissionRegistry: PermissionRegistry;
  /** §6.4: records a button tap against a pending question - null for an unknown id/index or a
   * question already answered (a stale or duplicate tap, same discipline as `resolvePermission`). */
  answerAsk(id: string, questionIndex: number, optionIndex: number): { entry: PendingAsk; label: string; allAnswered: boolean } | null;
  /** Sends the full `answers` map back to the blocked hook and forgets this ask. Returns whether
   * a live connection was found to send it on (the hook may have already timed out locally). */
  completeAsk(id: string): boolean;
  /** Sends `{ cancel: true }` back to the blocked hook (§6.4's 3540s ceiling) and forgets this ask. */
  cancelAsk(id: string): boolean;
  askRegistry: AskRegistry;
}

/**
 * Bridge side of the §2.5 socket protocol. Handles `hello` (idempotent re-registration by slug)
 * and `reply` (forward to the control bot in the session's topic); anything else is logged and
 * ignored rather than dropping the connection (§9 scenario 34 - version-skew tolerance).
 */
/** Telegram rejects a `sendDocument` over 50MB outright, so reading a larger file into memory only
 * to have the upload 400 (three times, once per retry) is pure waste. */
const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024;

/** See `PipeServerOptions.onBeforeReplyTimeoutMs`'s own doc comment. */
const DEFAULT_ONBEFOREREPLY_TIMEOUT_MS = 1500;

/** How much of a tool call's input preview an auto-approval notice shows. These are one-line
 * status notes in a topic that may get one per tool call, not the permission card's full detail -
 * the card is what got skipped. */
const AUTO_NOTE_PREVIEW_MAX = 120;

/** Claude Code's own marker for a preferred `AskUserQuestion` option - see `findAutoAnswer`. */
const RECOMMENDED_SUFFIX = " (Recommended)";

/**
 * Vocabulary suggesting an option defers or investigates rather than commits - "Verify against a
 * real session first", "Hold off, review the plan changes first", "Not yet".
 *
 * **This is a veto, never a selection, and the distinction is the whole design.** The operator's
 * standing preference is to investigate before committing, so the obvious feature is "auto-pick the
 * investigate option instead of the recommended one". That was measured against 715 real
 * `AskUserQuestion` calls from this machine's own Claude Code transcripts and rejected: option
 * semantics are not expressible in the schema (`AskQuestionOption` is `{label, description?}`, and
 * only `(Recommended)` is a convention Claude is actually instructed to emit), so any detector is
 * keyword-matching free prose. A generous one ran at roughly 13% precision, and its failures
 * inverted the operator's intent rather than merely missing - it would have answered *"Auto-send
 * immediately, no confirmation"* over *"Always show a confirm card first (Recommended)"*, having
 * matched "confirm" inside "no confirmation", i.e. silently disabling a safety confirmation the
 * question existed to enable.
 *
 * Used as a veto the same imprecision is harmless and the risk profile inverts: a false positive
 * costs one button tap (the real card is posted, which is also the only way the operator can pick
 * the investigate option at all), and a false negative just auto-answers as before. It fires on
 * ~11% of otherwise-auto-answerable questions in that corpus.
 *
 * Labels only, deliberately - `description` is explanatory prose that routinely contains "before"
 * and "first" while describing an option that commits to something.
 */
const DEFER_OPTION_RE = /\b(first|before|investigat\w*|research\w*|clarif\w*|explain\w*|hold off|hold on|wait|not yet|verify|double-check|look into)\b/i;

export function startPipeServer(opts: PipeServerOptions): PipeServerHandle {
  const pipePath = opts.pipePath ?? DEFAULT_PIPE_PATH;
  const log = opts.log ?? (() => {});
  const connectionsBySlug = new Map<string, net.Socket>();
  const permissionRegistry = new PermissionRegistry();
  const askRegistry = new AskRegistry();
  // Keyed by `request_id` (the tool's own `tool_use_id`, §6.4) rather than slug - a blocked ask
  // holds its own connection open for up to an hour, entirely separate from the channel server's
  // connection for the same slug.
  const askSocketsById = new Map<string, net.Socket>();

  // §9, found live 2026-08-09: `handleReply`/`handleAsk` each await a sequence of Telegram sends
  // for one slug (a reply's own chunks, one question card per ask), but nothing serialized two
  // *separate* `reply`/`ask` messages for that same slug arriving close together - each was simply
  // dispatched via its own bare fire-and-forget call, so their sends could interleave on the wire
  // (reply A chunk 1, reply B chunk 1, reply A chunk 2, ...). `serializedPerSlug` chains each new
  // call onto the previous one for the same slug, so a slug's own sends stay strictly ordered
  // relative to each other - unrelated slugs are unaffected (each gets its own chain).
  const perSlugChain = new Map<string, Promise<unknown>>();
  function serializedPerSlug(slug: string, fn: () => Promise<void>): Promise<void> {
    const prior = perSlugChain.get(slug) ?? Promise.resolve();
    // `.catch(() => {})` on the prior link, not on the chain this function returns: a failed
    // earlier reply for this slug must not block a later one from running, but the caller of
    // *this* call still needs to see its own `fn`'s real outcome (fireAndForget already logs it).
    const next = prior.catch(() => {}).then(fn);
    perSlugChain.set(slug, next);
    return next;
  }

  // §5.4's two control-bot lanes. Both fall back to calling `controlBot` directly when no
  // governor is supplied (existing stub-server tests), so this is additive rather than a
  // behaviour change for anything that doesn't opt in.
  function p0<T>(fn: () => Promise<T>): Promise<T> {
    return opts.governor ? opts.governor.scheduleAsync("P0", fn) : fn();
  }
  function p1<T>(fn: () => Promise<T>): Promise<T> {
    return opts.governor ? opts.governor.scheduleAsync("P1", fn) : fn();
  }

  /**
   * Pops this topic's thinking placeholder (if any) and best-effort deletes it - shared by
   * `handleReply`'s empty-chunks and successful-send branches, which used to each hand-write this
   * consume-then-delete sequence separately. The empty-chunks path used to bypass the `p1` rate-
   * governor lane every other Telegram send in this file goes through; a session producing many
   * scrubbed-to-empty replies in a burst could hit Telegram's rate limit on `deleteMessage` calls
   * nothing else here was protected from. Always resolves - callers that need the delete to have
   * settled before continuing should `await` it; the successful-send path fires it without awaiting
   * (via `fireAndForget`) so a slow/failing delete never delays the reply's own remaining chunks.
   */
  async function deletePlaceholder(routedTopic: string, slug: string): Promise<void> {
    const placeholderId = await opts.thinkingPlaceholder?.consume(routedTopic);
    if (placeholderId === undefined || !opts.controlBot.deleteMessage) return;
    await p1(() => opts.controlBot.deleteMessage!(opts.chatId, placeholderId)).catch((err) =>
      log("WARN", `failed to delete the thinking placeholder for slug "${slug}": ${(err as Error).message}`),
    );
  }

  /**
   * The destination topic is derived from the *slug*, never taken from the message. `topic_id` is
   * an argument the model fills in ("pass back the topic_id from the tag"), so a session that read
   * a file containing a channel-tag-shaped string - or just a confused model reusing a stale tag -
   * could otherwise deliver its reply, its files, and §4.4's rename-once into another session's
   * topic. The routing table is the only thing that knows where a slug's messages belong.
   */
  function topicFor(slug: string, claimed: string, what: string): number | undefined {
    const route = opts.routing.get(slug);
    if (route) {
      if (String(route.topicId) !== String(claimed)) {
        log("WARN", `${what} for slug "${slug}" named topic ${claimed} but its route is topic ${route.topicId} - using the route`);
      }
      return route.topicId;
    }
    // No route yet (the Phase 1 hardcoded slot, or a session mid-`/new`): fall back to the claimed
    // id, but never to `NaN` - `Number("abc")` would otherwise reach the Bot API as a bad thread.
    const parsed = Number(claimed);
    if (!Number.isFinite(parsed)) {
      log("WARN", `${what} for slug "${slug}" dropped - no route and "${claimed}" is not a topic id`);
      return undefined;
    }
    return parsed;
  }

  async function handleReply(msg: ReplyMessage): Promise<void> {
    try {
      // Last-line-of-defence, not a substitute for §6.2's Read/Edit deny rules: those stop Claude's
      // own tools from opening a secret file, but a subprocess the session wrote can still read one
      // and quote it back here. Every reply passes through this chokepoint regardless of how its
      // text was produced, so it's the one place that actually catches that gap (secret-scrub.ts).
      const { text, triggered } = scrubSecrets(msg.text);
      if (triggered.length > 0) {
        log("WARN", `redacted ${triggered.join(", ")} from a reply for slug "${msg.slug}" before sending to Telegram`);
      }
      const topicId = topicFor(msg.slug, msg.topic_id, "reply");
      if (topicId === undefined) return;
      // Awaited, bounded by a timeout - see `onBeforeReply`'s own doc comment for why this changed
      // from fire-and-forget (0.91.0) to an actual barrier (0.97.0). The whole thing is wrapped so a
      // *rejecting* onBeforeReply can never take the reply down with it: this call sits inside
      // handleReply's own try/catch, and an unswallowed rejection here would propagate to that catch
      // and skip sending the reply entirely - a wholly unrelated ordering-barrier failure silently
      // dropping the operator's actual answer. Today's real wiring (`scheduleP2Async`) is already
      // built to never reject, so this is a defensive backstop against a future change to that chain
      // breaking that contract, not a currently-reachable path - but it's exactly the "silent-wrong"
      // failure mode worth guarding against regardless (§9's own discipline).
      const beforeReply = opts.onBeforeReply?.(msg.slug);
      if (beforeReply) {
        const timeoutMs = opts.onBeforeReplyTimeoutMs ?? DEFAULT_ONBEFOREREPLY_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([
          Promise.resolve(beforeReply).catch((err) => {
            log("WARN", `onBeforeReply failed for slug "${msg.slug}" - sending the reply anyway: ${(err as Error).message}`);
          }),
          timeout,
        ]);
        clearTimeout(timer!);
      }
      // Telegram rejects both an empty message and one over 4096 code units with a 400, which the
      // governor cannot retry its way out of - and since the placeholder is consumed either way,
      // the failure used to leave a permanent "🤔 Thinking..." and no answer at all in the topic.
      const chunks = splitForTelegram(text);
      // Both of these are keyed by topic too, and both must use the *routed* topic rather than the
      // claimed one. `consume` pops a placeholder by topic, and a claimed-but-wrong topic would
      // otherwise have written this session's reply into another session's topic, leaving that
      // session's turn permanently unfinished. `onReplySent` drives §4.4's rename-once, so the same
      // mismatch would have retitled the wrong topic and consumed its one rename.
      const routedTopic = String(topicId);
      if (chunks.length === 0) {
        // 2026-08-09 (live-observed as a "Thinking..." bubble that only disappeared 2-4 messages
        // later than expected): this used to `return` here *before* the consume/delete below ever
        // ran, so a reply that scrubbed down to nothing left the placeholder dangling - it then sat
        // there, unrelated to any turn actually in flight, until whatever *later* reply happened to
        // land finally consumed it. A turn that resolves to "nothing to say" still resolves - the
        // placeholder has to clear here too, not just on the path that sends real text.
        log("WARN", `reply for slug "${msg.slug}" was empty after scrubbing - nothing to send`);
        await deletePlaceholder(routedTopic, msg.slug);
        return;
      }
      // 0.104.0: this used to *edit* the placeholder into the reply's own text instead of sending a
      // new message - which meant the reply's visible position in the topic was permanently pinned
      // to wherever "🤔 Thinking..." first landed (turn-start, sent immediately and unthrottled by
      // `thinking-placeholder.ts`, by design, for an instant typing indicator), regardless of
      // anything sent later in the same turn (a "Click Details" lifecycle notice, a feed card) -
      // Telegram never repositions an edited message. Live-observed 2026-08-08: this made the reply
      // look like it arrived "2nd" even after 0.97.0's/0.101.0's ordering fixes, since neither of
      // those touches *where* an edited message sits, only *when* independent sends complete. Now
      // the reply always sends as a genuinely new P1 message - landing in true chronological order,
      // after `onBeforeReply`'s flush and after anything already queued ahead of it on this lane -
      // and the placeholder is deleted afterward rather than reused, so the operator still gets the
      // same instant "something's happening" feedback at turn-start with no stale text left behind.
      await p1(() => opts.controlBot.sendMessage(opts.chatId, topicId, chunks[0]!));
      // Consumed only *after* that send has actually landed (2026-08-09, same live-observed symptom
      // as the empty-chunks case above): consuming first and sending second meant a send that threw
      // (network blip, governor giving up) popped the placeholder from the map without ever deleting
      // it - the outer catch below just logs the error, so that "🤔 Thinking..." would be orphaned
      // for good, unlike the empty-chunks case which at least still had a live map entry for some
      // later reply to self-heal. Consuming after a successful send means a failed one instead
      // leaves the placeholder right where the empty-chunks case leaves it too: still pending, so
      // whatever reply eventually does get through still clears it.
      // Best-effort, not awaited: a delete failing (already gone, past Telegram's edit/delete
      // window, etc.) must never take the reply down with it - the reply above has already landed
      // either way, and a stray leftover "🤔 Thinking..." bubble is a cosmetic wart, not a lost
      // message.
      fireAndForget(deletePlaceholder(routedTopic, msg.slug), log, `pipe-server deletePlaceholder(${msg.slug})`);
      for (const chunk of chunks.slice(1)) {
        await p1(() => opts.controlBot.sendMessage(opts.chatId, topicId, chunk));
      }
      opts.onReplySent?.(routedTopic, text);
    } catch (err) {
      log("ERROR", `failed to deliver reply for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  /**
   * §5.8: forwards a file Claude saved in its own outbox to Telegram, as a photo if the
   * extension is one `sendPhoto` renders inline, a document otherwise. Every failure mode here
   * (no `stateDir` configured, path outside the outbox, file missing, bot methods unavailable) is
   * logged and dropped rather than thrown - `send_file` has no caller waiting on a result the way
   * a tool call normally would (the MCP response was already returned "sent" by the channel
   * server before the Bridge ever sees this).
   */
  async function handleSendFile(msg: SendFileMessage): Promise<void> {
    if (!opts.stateDir) {
      log("WARN", `send_file for slug "${msg.slug}" dropped - no stateDir configured`);
      return;
    }
    const resolved = resolveOutboxPath(opts.stateDir, msg.slug, msg.path);
    if (!resolved) {
      log("WARN", `send_file for slug "${msg.slug}" rejected - "${msg.path}" is outside its outbox`);
      return;
    }
    // §9, found live 2026-08-09: this whole handler (stat, then a read of up to
    // `MAX_SEND_FILE_BYTES` = 50MB) used to run entirely synchronously. The Bridge is
    // single-threaded and serves every session at once - a 50MB `fs.readFileSync` blocks the
    // `getUpdates` loop, every permission card, every reply, for anyone, for as long as that read
    // takes. `fs/promises` here (the surrounding function is already `async`) yields to the event
    // loop instead of blocking it. Existence and size are checked together via one `stat` (not a
    // separate `existsSync` + `statSync`, which is also two syscalls where one now does).
    let size: number;
    try {
      size = (await fsPromises.stat(resolved)).size;
    } catch {
      log("WARN", `send_file for slug "${msg.slug}" rejected - "${resolved}" does not exist`);
      return;
    }
    const topicId = topicFor(msg.slug, msg.topic_id, "send_file");
    if (topicId === undefined) return;
    try {
      if (size > MAX_SEND_FILE_BYTES) {
        log("WARN", `send_file for slug "${msg.slug}" rejected - "${resolved}" is ${size} bytes, over Telegram's 50MB limit`);
        return;
      }
      const bytes = await fsPromises.readFile(resolved);
      const filename = path.basename(resolved);
      const asPhoto = isImagePath(filename);
      // The caption is free text Claude supplies, same as a reply - scrub it the same way (the
      // file's own bytes are unaffected; this repo has no equivalent scanner for file contents,
      // which is exactly the kind of gap §8.3 already tracks rather than something new).
      let caption = msg.caption;
      if (caption !== undefined) {
        const { text, triggered } = scrubSecrets(caption);
        caption = text;
        if (triggered.length > 0) {
          log("WARN", `redacted ${triggered.join(", ")} from a send_file caption for slug "${msg.slug}" before sending to Telegram`);
        }
      }
      if (asPhoto && opts.controlBot.sendPhotoFile) {
        await p1(() => opts.controlBot.sendPhotoFile!(opts.chatId, topicId, filename, bytes, caption));
        log("INFO", `sent "${filename}" (${bytes.length} bytes) as a photo for slug "${msg.slug}"`);
      } else if (opts.controlBot.sendDocumentFile) {
        await p1(() => opts.controlBot.sendDocumentFile!(opts.chatId, topicId, filename, bytes, caption));
        log("INFO", `sent "${filename}" (${bytes.length} bytes) as a document for slug "${msg.slug}"`);
      } else {
        log("WARN", `send_file for slug "${msg.slug}" dropped - control bot has no file-sending method`);
      }
    } catch (err) {
      log("ERROR", `failed to deliver send_file for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  /**
   * `/auto answer`'s whole rule: auto-resolve a call only when *every* question carries exactly one
   * option whose label ends in " (Recommended)", and pick those. If any question lacks exactly one,
   * return null and post the real card for the whole call - never a partial auto-answer.
   *
   * The suffix is Claude Code's own convention for marking a preferred option (its `AskUserQuestion`
   * tool description instructs the model to append it to the recommended option). That makes it an
   * instructed convention rather than a documented schema field - `AskQuestionOption` is `{ label,
   * description? }` with nothing structured to read - so a model that doesn't follow it, or follows
   * it twice, simply falls through to the real card. Hence "exactly one, or bail" rather than
   * "the first one found".
   */
  function findAutoAnswer(questions: HookAskMessage["questions"]): string[] | null {
    // Load-bearing, not defensive decoration: without it the loop below never runs and this returns
    // `[]`, which is non-null, so the caller would take the auto-answer path for a call with nothing
    // to answer and write an empty `answers` map to a hook client that then unblocks having
    // answered nothing.
    if (questions.length === 0) return null;
    const answers: string[] = [];
    for (const q of questions) {
      const recommended = q.options.filter((o) => o.label.endsWith(RECOMMENDED_SUFFIX));
      if (recommended.length !== 1) return null;
      // Operator-requested 2026-08-11: when there is *also* an option to investigate/defer, the
      // operator wants that one - and the only reliable way to give it to them is to show the real
      // buttons, since which option that is cannot be determined from the schema. See
      // DEFER_OPTION_RE for the measurement behind "veto, never select".
      const deferrable = q.options.find((o) => o !== recommended[0] && DEFER_OPTION_RE.test(o.label));
      if (deferrable) {
        log("INFO", `auto-answer declined for "${q.question}": "${deferrable.label}" looks like an investigate-first option, posting the real card`);
        return null;
      }
      answers.push(recommended[0]!.label);
    }
    return answers;
  }

  /** The answer sent back keeps the full label - a real button tap sends `option.label` verbatim, so
   * anything else would be a different answer than the operator could have given. Only the notice
   * strips it, for readability. */
  function stripRecommendedSuffix(label: string): string {
    return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
  }

  /** One-line plain-text summary of a tool call, e.g. `Bash(git push origin main)`. Deliberately not
   * built from `renderPermissionCard`/`renderInputPreview`: those produce Telegram HTML (`<b>`,
   * `<code>`, escaped body) for a `parse_mode: "HTML"` send, and `postAutoApprovedNote` sends with no
   * parse mode - reusing them would print literal tags in every notice. Plain text is also immune to
   * a command containing `<` or `&`, which is not a rare shape in a shell one-liner. */
  function describeCall(toolName: string, inputPreview: string): string {
    // A Bash `input_preview` is the tool's JSON input, so the raw string renders as
    // `Bash({ "command": "cd ... && bash scripts/typecheck.sh",…)` - the envelope crowding out the
    // one thing the operator is reading the line for (live-observed 2026-08-11). Unwrap it to the
    // command itself, reusing the same parser the compound-Bash shortcut in this file already
    // depends on. Non-Bash tools, and anything that doesn't parse, fall back to the raw preview.
    const unwrapped = (toolName === "Bash" ? extractBashCommand(inputPreview) : null) ?? inputPreview;
    const preview = unwrapped.replace(/\s+/g, " ").trim();
    if (!preview) return toolName;
    const truncated = preview.length > AUTO_NOTE_PREVIEW_MAX ? `${preview.slice(0, AUTO_NOTE_PREVIEW_MAX - 1)}…` : preview;
    return `${toolName}(${truncated})`;
  }

  /**
   * The operator-visible trace for anything the Bridge resolved on their behalf - a plain message
   * into the session's own topic, not a feed-card line (there is no Bridge-side primitive for
   * appending to a feed card, and `pipe-server.ts` holds no `feedWiring` reference at all).
   *
   * P1, not P0 and not P2. The permission card this replaces sends on P0, reserved for traffic a
   * human is actively blocked on; a burst of auto-approvals must not compete there with other
   * sessions' real permission cards. P2 is wrong the other way - droppable under pressure, and a
   * "what did the Bridge do on my behalf" audit trail must not silently vanish when the feed is busy.
   *
   * **Enqueued, never awaited by callers, and never throws.** P0 and P1 share one control-bot bucket
   * refilling at roughly one token every 3 seconds (rate-governor.ts). Awaiting this before sending
   * the verdict would gate every auto-approved tool call on a rate-limiter token - a 20-call turn
   * would freeze for about a minute, with Claude blocked on a verdict the Bridge decided instantly
   * and locally, and the feature meant to remove a Telegram round-trip would have replaced it with a
   * governor one. The ordering the operator's timeline needs ("🔓 auto-approved: X" before X's
   * effects) comes from enqueue order, since the lanes are FIFO - not from awaiting the send.
   */
  function postAutoApprovedNote(topicId: number, text: string): void {
    void p1(() => opts.controlBot.sendMessage(opts.chatId, topicId, text)).catch((err) =>
      log("WARN", `failed to post auto-approval notice: ${(err as Error).message}`),
    );
  }

  /**
   * §6.3's relay: post an inline-keyboard card and register it as pending. The card renders from
   * this notification's own fields alone (§6.5 - no join against a hook payload), and a post
   * failure (e.g. Telegram briefly unreachable) leaves nothing registered rather than a pending
   * entry with no way for the operator to ever see or answer it.
   */
  async function handlePermissionRequest(msg: PermissionRequestMessage): Promise<void> {
    const route = opts.routing.get(msg.slug);
    if (!route) {
      log("WARN", `permission_request for unknown slug "${msg.slug}" - dropped`);
      return;
    }
    // `/auto permission on` for this session: the operator-controlled generalization of the
    // compound-Bash shortcut below. Checked first because it's the coarser gate - if everything is
    // being auto-allowed anyway there's no point decomposing the command to find out whether this
    // one could have been. Note this can only ever see calls Claude Code already decided to escalate:
    // a `permissions.deny` match never reaches the relay at all (its precedence chain refuses the
    // call outright), so the deny list stays a hard floor regardless of this toggle. What it *does*
    // auto-allow is the `permissions.ask` list - git commit/push, PR merge, npm publish - which is
    // the deliberate, headline behavior change, not an oversight.
    if (opts.routing.getBypass(msg.slug)) {
      log("INFO", `auto-permission: auto-allowed ${msg.tool_name} for slug "${msg.slug}": ${msg.input_preview}`);
      postAutoApprovedNote(route.topicId, `🔓 auto-approved (auto permission): ${describeCall(msg.tool_name, msg.input_preview)}`);
      sendVerdict(msg.slug, msg.request_id, "allow");
      return;
    }
    // compound-permission.ts: Claude Code's own settings evaluation matches a Bash call's entire
    // raw command string against each glob rule, so a `&&`/`;`/`|` chain built entirely out of
    // already-trusted pieces (e.g. `cd <worktree> && sed -i ... && grep -c ...; grep -c ...`)
    // still reaches here unmatched. Decompose it ourselves and skip the Telegram round-trip
    // entirely when every piece is exactly as safe as it would be running on its own - never
    // touches Claude Code's own evaluation, and never fires for anything the decomposer can't
    // fully account for (metacharacters it refuses to guess through, a sensitive path anywhere in
    // the raw string, or a sub-command not already covered by this session's own allow list).
    if (opts.stateDir) {
      // One read serving both shortcuts below. Re-read per request on purpose: it is what makes an
      // `♾️ Always` tap take effect at all, since the running Claude Code process does not act on a
      // rule appended to its `--settings` mid-conversation (measured live 2026-08-12, §12 Phase 2).
      //
      // Guarded because this read moved onto *every* permission request when the non-Bash branch
      // was added (it used to run only for a Bash call with a parseable preview): a settings file
      // truncated mid-write would otherwise throw here and take the operator's card with it, on a
      // path whose entire job is to make sure a card appears. Failing to read means falling through
      // to the normal card - never toward an auto-approval.
      let settings: PermissionSettings | null = null;
      try {
        settings = readSettingsFile(opts.stateDir, msg.slug);
      } catch (err) {
        log("WARN", `could not read settings for slug "${msg.slug}" - posting the permission card unshortcut: ${(err as Error).message}`);
      }
      if (settings !== null) {
        const command = msg.tool_name === "Bash" ? extractBashCommand(msg.input_preview) : null;
        if (command !== null && isCompoundCommandFullyAllowed(command, settings, WIDENED_AUTO_APPROVE_PREFIXES)) {
          log("INFO", `auto-approved compound Bash for slug "${msg.slug}" - every sub-command already allowed: ${command}`);
          // Brought up to the same observability standard as the toggle above while in this
          // function: this shortcut has always been server-log-only, with no Telegram-visible trace
          // of what the Bridge approved on the operator's behalf.
          postAutoApprovedNote(route.topicId, `🔓 auto-approved (every sub-command already allowed): ${describeCall(msg.tool_name, msg.input_preview)}`);
          sendVerdict(msg.slug, msg.request_id, "allow");
          return;
        }
        // P0-7, the non-Bash half of the same idea: this session's allow list already carries this
        // tool's bare name - almost always because the operator tapped `♾️ Always` on an earlier card
        // for it - so re-asking is the bug, not the safety. `isCoveredByBareToolRule` refuses whenever
        // any deny/ask entry mentions the tool at all, so this cannot outrank either list; see its
        // doc comment for why that conservatism leaves `Edit`/`Read` still prompting.
        if (isCoveredByBareToolRule(msg.tool_name, msg.input_preview, settings)) {
          log("INFO", `auto-approved ${msg.tool_name} for slug "${msg.slug}" - already allow-listed for this session: ${msg.input_preview}`);
          postAutoApprovedNote(route.topicId, `🔓 auto-approved (already allowed for this session): ${describeCall(msg.tool_name, msg.input_preview)}`);
          sendVerdict(msg.slug, msg.request_id, "allow");
          return;
        }
      }
    }
    try {
      const text = renderPermissionCard({
        slug: msg.slug,
        toolName: msg.tool_name,
        description: msg.description,
        inputPreview: msg.input_preview,
      });
      const sent = await p0(() =>
        opts.controlBot.sendMessage(
          opts.chatId,
          route.topicId,
          text,
          { inline_keyboard: buildPermissionKeyboard(msg.request_id) },
          "HTML",
        ),
      );
      permissionRegistry.add({
        requestId: msg.request_id,
        slug: msg.slug,
        toolName: msg.tool_name,
        description: msg.description,
        inputPreview: msg.input_preview,
        topicId: route.topicId,
        messageId: sent.message_id,
      });
      opts.onAwaitingInput?.(msg.slug);
    } catch (err) {
      log("ERROR", `failed to post permission request for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  /**
   * §6.4: posts one card per question and registers the ask, keyed by `request_id` (the tool's
   * own `tool_use_id`) rather than a Bridge-invented id. A reconnect of the same blocked hook
   * invocation (§2.5 - the hook client re-sends `hello`+`ask` on every reconnect attempt) arrives
   * as a second `ask` with the same `request_id`; that case just rebinds the socket rather than
   * reposting the question, since the operator would otherwise see duplicate cards for one ask.
   */
  async function handleAsk(msg: HookAskMessage, socket: net.Socket): Promise<void> {
    const existing = askRegistry.get(msg.request_id);
    if (existing) {
      askSocketsById.set(msg.request_id, socket);
      return;
    }

    const route = opts.routing.get(msg.slug);
    if (!route) {
      log("WARN", `ask for unknown slug "${msg.slug}" - dropped`);
      return;
    }

    // `/auto answer on` for this session. Placed after *both* guards above, deliberately: after the
    // reconnect-rebind branch, so a re-sent `ask` for an entry still pending from before the toggle
    // went on keeps rebinding its socket rather than being answered out from under a card the
    // operator is already looking at; and after the route lookup, since the notice needs a topicId
    // and an unknown slug must keep falling through to the WARN-and-drop above.
    if (opts.routing.getAutoAnswer(msg.slug)) {
      const picked = findAutoAnswer(msg.questions);
      if (picked) {
        const answers: Record<string, string> = {};
        msg.questions.forEach((q, i) => {
          answers[q.question] = picked[i]!;
        });
        for (const [question, label] of Object.entries(answers)) {
          postAutoApprovedNote(route.topicId, `🔓 auto-answered (auto answer): "${question}" → "${stripRecommendedSuffix(label)}"`);
        }
        // Never registers with `askRegistry` and never posts a card - there is nothing for the
        // operator to answer, so an entry here would exist only to be deleted a microtask later,
        // racing the expiry sweep and `removeForSlug` for no benefit.
        writeAnswer(socket, msg.slug, { answers });
        return;
      }
    }

    try {
      const questions: PendingAsk["questions"] = [];
      for (const q of msg.questions) {
        const sent = await p0(() =>
          opts.controlBot.sendMessage(opts.chatId, route.topicId, renderAskCard(msg.slug, q.question, q.header), {
            inline_keyboard: buildAskKeyboard(msg.request_id, questions.length, q.options),
          }),
        );
        questions.push({ question: q.question, header: q.header, options: q.options, topicId: route.topicId, messageId: sent.message_id });
      }
      askRegistry.add({ id: msg.request_id, slug: msg.slug, questions });
      askSocketsById.set(msg.request_id, socket);
      opts.onAwaitingInput?.(msg.slug);
    } catch (err) {
      log("ERROR", `failed to post question for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  function handleHello(msg: Extract<Message, { type: "hello" }>, socket: net.Socket): void {
    if (msg.role !== "channel") {
      // §5.1: the hook client's hello carries no session_id (only pid + which event it's for),
      // so there is nothing to register here - the event message on the same connection, handled
      // below, is the one that actually carries anything routable.
      // slug is on every hook hello (EnvelopeBase) despite the above note about session_id - added
      // 2026-08-11 so this line is correlatable to a session by slug, not just a pid that meant
      // nothing without cross-referencing OS process listings (live debugging pain point).
      log("INFO", `hook client connected for event "${msg.event}" (pid ${msg.pid}, slug "${msg.slug}")`);
      return;
    }
    connectionsBySlug.set(msg.slug, socket);
    log("INFO", `channel server for "${msg.slug}" connected (pid ${msg.pid})`);
    opts.onChannelConnected?.(msg.slug);

    const route = opts.routing.get(msg.slug);
    const ack: HelloAck = {
      v: PROTOCOL_VERSION,
      type: "hello_ack",
      slug: msg.slug,
      re: msg.id,
      topic_id: route?.topicId ?? -1,
      session_state: route ? "idle" : "unknown",
    };
    socket.write(encodeMessage(ack));
  }

  function handleMessage(msg: Message, socket: net.Socket): void {
    switch (msg.type) {
      case "hello":
        handleHello(msg, socket);
        return;
      case "reply":
        fireAndForget(
          serializedPerSlug(msg.slug, () => handleReply(msg)),
          log,
          `pipe-server handleReply(${msg.slug})`,
        );
        return;
      case "send_file":
        fireAndForget(handleSendFile(msg), log, `pipe-server handleSendFile(${msg.slug})`);
        return;
      case "permission_request":
        fireAndForget(handlePermissionRequest(msg), log, `pipe-server handlePermissionRequest(${msg.slug})`);
        return;
      case "event":
        opts.onHookEvent?.(msg);
        return;
      case "ask":
        fireAndForget(
          serializedPerSlug(msg.slug, () => handleAsk(msg, socket)),
          log,
          `pipe-server handleAsk(${msg.slug})`,
        );
        return;
      default:
        log("WARN", `ignoring unrecognised message type "${(msg as { type?: unknown }).type}"`);
    }
  }

  const server = net.createServer((socket) => {
    // One corrupt line is logged and skipped individually; the well-formed messages sharing its
    // chunk still get handled (a hook's `hello`+`ask` pair arriving alongside one is otherwise lost
    // and Claude blocks for the full hour).
    const decoder = new NdjsonDecoder((line, err) => {
      log("ERROR", `skipping malformed message on pipe (${(err as Error).message}): ${line.slice(0, 200)}`);
    });

    socket.on("data", (chunk) => {
      let messages: Message[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        // Only the line-length guard reaches here now - the peer is not speaking the protocol.
        log("ERROR", `pipe framing violation, dropping connection: ${(err as Error).message}`);
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        handleMessage(msg, socket);
      }
    });

    socket.on("error", (err) => {
      log("WARN", `pipe client socket error: ${(err as Error).message}`);
    });

    socket.on("close", () => {
      for (const [slug, s] of connectionsBySlug) {
        if (s === socket) connectionsBySlug.delete(slug);
      }
      // Not removed from `askRegistry` here - only the socket goes away. The hook client
      // reconnects and re-sends the same `ask` (§2.5), which rebinds a fresh socket in
      // `handleAsk` above; the pending question itself is only ever cleared by an answer, a
      // cancel, or the expiry sweep.
      for (const [id, s] of askSocketsById) {
        if (s === socket) askSocketsById.delete(id);
      }
    });
  });

  server.on("error", (err) => {
    log("ERROR", `pipe server error: ${(err as Error).message}`);
    // A pipe we could not bind is not a degraded Bridge, it is a mute one: every channel server
    // and every hook client connects here, so the whole fleet loses its permission cards, its
    // replies and its feed while the process keeps running and looks healthy. The usual cause is a
    // second Bridge already holding the pipe (`MultipleInstances = Parallel` on the logon task
    // permits that for `/restart`'s handover), and the correct outcome there is for the loser to
    // die loudly rather than shadow the winner.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      log("ERROR", `another Bridge already owns ${pipePath} - exiting rather than running without a pipe`);
      process.exit(1);
    }
  });

  server.listen(pipePath, () => {
    log("INFO", `pipe server listening on ${pipePath}`);
  });

  function sendInbound(slug: string, content: string, meta: ChannelMetaFields): boolean {
    const socket = connectionsBySlug.get(slug);
    if (!socket) {
      log("WARN", `no connected channel server for slug "${slug}" - inbound message dropped`);
      return false;
    }
    const msg: InboundMessage = { v: PROTOCOL_VERSION, type: "inbound", slug, content, meta };
    socket.write(encodeMessage(msg));
    return true;
  }

  function sendVerdict(slug: string, requestId: string, behavior: VerdictBehavior): boolean {
    const socket = connectionsBySlug.get(slug);
    if (!socket) {
      log("WARN", `no connected channel server for slug "${slug}" - verdict dropped`);
      return false;
    }
    const msg: VerdictMessage = { v: PROTOCOL_VERSION, type: "verdict", slug, request_id: requestId, behavior };
    socket.write(encodeMessage(msg));
    return true;
  }

  function resolvePermission(requestId: string): PendingPermissionRequest | undefined {
    return permissionRegistry.resolve(requestId);
  }

  /**
   * §13 check 4, found live 2026-08-06: the §6.5 terminal-answer heuristic (`resolveByToolMatch`
   * in index.ts) can fire and call this within under a second of the card's own `sendMessage` -
   * far faster than a human or even a scripted button tap ever resolves one - and the real
   * Telegram Bot API intermittently 400s an edit that fast with `Bad Request: message to edit not
   * found`, reproduced on 2 of 2 live runs. Same class of fresh-object eventual-consistency
   * flakiness §4.5.2/0.69.0 already document for topics, now observed for messages too. A short
   * retry absorbs it; the button-tap path above never needs it in practice (real taps are already
   * seconds behind the send) but gets the same safety net for free.
   */
  async function finalizePermissionMessage(messageId: number, text: string): Promise<void> {
    if (!opts.controlBot.editMessageText) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await p0(() => opts.controlBot.editMessageText!(opts.chatId, messageId, text, { inline_keyboard: [] }));
        return;
      } catch (err) {
        const isFreshMessageRace = /message to edit not found/i.test((err as Error).message);
        if (!isFreshMessageRace || attempt >= 2) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  function answerAsk(id: string, questionIndex: number, optionIndex: number): { entry: PendingAsk; label: string; allAnswered: boolean } | null {
    return askRegistry.answer(id, questionIndex, optionIndex);
  }

  /** Shared by `completeAsk`/`cancelAsk` below - both pop the registry entry, forget its socket,
   * and (if one was still live) send a `type: "answer"` message back to the blocked hook, differing
   * only in the payload (`{ answers }` vs `{ cancel: true }`). */
  /** Writes the `type: "answer"` frame the blocked hook client is waiting on.
   *
   * **Takes the socket as a parameter; it must not look one up.** `finishAsk` resolves its socket
   * from `askSocketsById`, a map only ever populated on the same line as an `askRegistry.add` - so
   * the auto-answer path, which deliberately never registers an entry, has nothing to find there.
   * Folding the lookup in here would make that path silently write nothing: the operator would see
   * "🔓 auto-answered" while the hook client stayed blocked forever, with no registry entry left for
   * any expiry sweep to reach. The auto-answer path passes `handleAsk`'s own `socket` argument,
   * which is the very connection the blocked client is waiting on. */
  function writeAnswer(socket: net.Socket, slug: string, payload: Pick<HookAnswerMessage, "answers" | "cancel">): void {
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "answer", slug, ...payload }));
  }

  function finishAsk(id: string, buildPayload: (entry: PendingAsk) => Pick<HookAnswerMessage, "answers" | "cancel">): boolean {
    const entry = askRegistry.get(id);
    if (!entry) return false;
    const payload = buildPayload(entry);
    const socket = askSocketsById.get(id);
    askRegistry.remove(id);
    askSocketsById.delete(id);
    if (!socket) return false;
    writeAnswer(socket, entry.slug, payload);
    return true;
  }

  function completeAsk(id: string): boolean {
    return finishAsk(id, (entry) => ({ answers: askRegistry.buildAnswers(entry) }));
  }

  function cancelAsk(id: string): boolean {
    return finishAsk(id, () => ({ cancel: true }));
  }

  return {
    server,
    sendInbound,
    sendVerdict,
    resolvePermission,
    finalizePermissionMessage,
    permissionRegistry,
    answerAsk,
    completeAsk,
    cancelAsk,
    askRegistry,
  };
}
