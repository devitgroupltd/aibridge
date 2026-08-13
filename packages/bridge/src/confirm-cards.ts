import type { ConfirmEntry, ConfirmRegistry } from "./confirm-registry.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import type { PendingFleetConfirm } from "./fleet-confirm.ts";
import type { PendingNlConfirm } from "./nl-confirm.ts";
import { retryTopicKey, type RetryStore } from "./retry-store.ts";
import type { RateGovernor } from "./rate-governor.ts";
import type { PendingStaleConfirm } from "./stale-confirm.ts";
import { isPermanentEditFailure, type SendMessageSource } from "./telegram.ts";
import type { PendingVoiceConfirm } from "./voice-confirm.ts";
import type { LogFn } from "./logger.ts";

export interface ConfirmCardsOptions {
  controlBot: SendMessageSource;
  /** Shared reference, same "composition root owns it, module borrows it" rule as
   * feed-wiring.ts/quota-alarms.ts - `feedGovernor` is used pervasively elsewhere in index.ts. */
  feedGovernor: RateGovernor;
  supergroupChatId: string;
  retryStore: RetryStore;
  log?: LogFn;
}

export interface ConfirmCards {
  finalizeCard(messageId: number, text: string): Promise<void>;
  markConfirmCardExpired(messageId: number): Promise<void>;
  markNlConfirmCardExpired(entry: PendingNlConfirm): Promise<void>;
  notifyConfirmGone(registry: { wasRecentlyAnswered(id: string): boolean }, id: string, messageId: number | undefined): void;
  finalizeFleetConfirmMessage(pending: PendingFleetConfirm, text: string): Promise<void>;
  finalizeStaleConfirmMessage(pending: PendingStaleConfirm, text: string): Promise<void>;
  finalizeVoiceConfirmMessage(pending: PendingVoiceConfirm, statusLine: string): Promise<void>;
  finalizeNlConfirmMessage(pending: PendingNlConfirm, text: string): Promise<void>;
  /** The "take from registry -> `notifyConfirmGone` if missing -> mark expired if past TTL ->
   * proceed with the pending entry" preamble all four callback-query confirm-action branches
   * (fleetConfirmAction/nlConfirmAction/staleConfirmAction/voiceConfirmAction, callback-query-
   * router.ts) repeated identically, differing only in which registry and which mark-expired
   * function was plugged in. Returns the live entry, or `undefined` once it has already notified/
   * finalized the card itself - the caller's only job on `undefined` is to return. */
  takeOrNotifyGone<T extends ConfirmEntry>(
    registry: ConfirmRegistry<T>,
    id: string,
    messageId: number | undefined,
    markExpiredFn: (entry: T) => void,
  ): T | undefined;
}

/**
 * The four confirm-card protocols' (fleet/stale/voice/nl) finalize/expire logic - `index.ts`'s own
 * comments already called out that the four finalize paths differ only in which field holds the
 * message id (fixed here as `finalizeCard`), and the four callback-query preambles repeated an
 * identical take/notify-gone/mark-expired sequence one layer above that (fixed here as
 * `takeOrNotifyGone`). Both were acknowledged duplication before this extraction, not something
 * discovered by it.
 */
export function createConfirmCards(opts: ConfirmCardsOptions): ConfirmCards {
  const { controlBot, feedGovernor, supergroupChatId, retryStore } = opts;
  const log = opts.log ?? (() => {});

  /** The one "this card is settled" edit: replace its text, strip its keyboard. Every confirm card
   * (fleet, NL, stale, voice) finalizes identically - four copies of this differing only in which
   * field held the message id was pure duplication. */
  async function finalizeCard(messageId: number, text: string): Promise<void> {
    if (!controlBot.editMessageText) return;
    try {
      // Through the control governor's P1 lane, not a direct call. §5.4 counts every method against
      // the token, and the expiry sweep below can produce a *burst*: one stale-confirm card per
      // backlog message after an overnight sleep means ~200 of these come due in the same tick. Fired
      // directly they would all 429 - invisibly to the governor, whose bucket would still believe the
      // budget was free when the next P0 permission card went out.
      await feedGovernor.scheduleAsync("P1", async () => {
        try {
          await controlBot.editMessageText!(supergroupChatId, messageId, text, { inline_keyboard: [] });
        } catch (err) {
          // Swallowed *inside* the lane deliberately: P1 retries three times with backoff, and a
          // message that can never be edited again (the operator deleted it, or it aged out of
          // Telegram's 48h edit window) would spend four control-bucket tokens per card. A sweep burst
          // of 200 expired cards would then burn ~40 minutes of the 20/min budget on failures that
          // cannot succeed, delaying real replies. Transient errors still get their retries.
          if (!isPermanentEditFailure(err)) throw err;
          log("WARN", `confirm card ${messageId} is no longer editable - leaving it as-is`);
        }
      });
    } catch (err) {
      log("WARN", `failed to finalize a confirm card: ${(err as Error).message}`);
    }
  }

  /** What the sweep (and a tap that lost the race to it) leaves behind, so an expired card reads as
   * expired instead of as a button that does nothing. */
  function markConfirmCardExpired(messageId: number): Promise<void> {
    return finalizeCard(messageId, "⌛ This confirmation expired - send it again if you still want it.");
  }

  /** Same "past its TTL" outcome as `markConfirmCardExpired`, but for nl-confirm specifically:
   * stashes the command into `retryStore` first (see that file's doc comment) and says so on the
   * card, so `/retry` - or a spoken "retry"/"try again" - re-arms it instead of the operator having
   * to retype/re-say the original request. */
  function markNlConfirmCardExpired(entry: PendingNlConfirm): Promise<void> {
    retryStore.add({ id: retryTopicKey(entry.threadId), command: entry.command, threadId: entry.threadId, currentSlug: entry.currentSlug });
    return finalizeCard(entry.messageId, "⌛ This confirmation expired - /retry to re-arm it, or send it again if you still want it.");
  }

  /** What a tap on an id `registry.take()` no longer has leaves behind. Two causes look identical
   * to `take` once the entry is gone - a duplicate tap racing its own already-in-flight answer, or
   * a tap left over from before a Bridge restart wiped every in-memory confirmation - and only the
   * second should edit the card, since re-editing the first would clobber the real result with a
   * misleading "no longer valid" a moment after it was correctly answered. `wasRecentlyAnswered`
   * tells the two apart. Restart is the far more common case in practice (§4.5.1: the operator
   * restarts, then taps a button that was already on screen), and leaving it silent - Telegram's
   * spinner already cleared - was the exact §6.5 failure mode this project works to avoid elsewhere. */
  function notifyConfirmGone(registry: { wasRecentlyAnswered(id: string): boolean }, id: string, messageId: number | undefined): void {
    if (registry.wasRecentlyAnswered(id) || messageId === undefined) return;
    fireAndForget(
      finalizeCard(messageId, "⌛ This confirmation is no longer valid - most likely the Bridge restarted since it was posted. Resend the command to try again."),
      log,
      "confirm-cards notifyConfirmGone",
    );
  }

  async function finalizeFleetConfirmMessage(pending: PendingFleetConfirm, text: string): Promise<void> {
    await finalizeCard(pending.messageId, text);
  }

  async function finalizeStaleConfirmMessage(pending: PendingStaleConfirm, text: string): Promise<void> {
    await finalizeCard(pending.confirmCardMessageId, text);
  }

  /** Keeps the transcript visible under the final status line rather than replacing it outright -
   * once the card's buttons are gone, the transcript text was the only record of what a "Sent"/
   * "Discarded" tap actually applied to; losing it made the finalized message unreadable on its
   * own (live-reported: a "✅ Sent." card with no way to see what was sent). */
  async function finalizeVoiceConfirmMessage(pending: PendingVoiceConfirm, statusLine: string): Promise<void> {
    await finalizeCard(pending.confirmCardMessageId, `🎤 ${pending.transcript}\n\n${statusLine}`);
  }

  async function finalizeNlConfirmMessage(pending: PendingNlConfirm, text: string): Promise<void> {
    await finalizeCard(pending.messageId, text);
  }

  function takeOrNotifyGone<T extends ConfirmEntry>(
    registry: ConfirmRegistry<T>,
    id: string,
    messageId: number | undefined,
    markExpiredFn: (entry: T) => void,
  ): T | undefined {
    const taken = registry.take(id);
    if (!taken) {
      notifyConfirmGone(registry, id, messageId);
      return undefined;
    }
    if (taken.expired) {
      markExpiredFn(taken.entry);
      return undefined;
    }
    return taken.entry;
  }

  return {
    finalizeCard,
    markConfirmCardExpired,
    markNlConfirmCardExpired,
    notifyConfirmGone,
    finalizeFleetConfirmMessage,
    finalizeStaleConfirmMessage,
    finalizeVoiceConfirmMessage,
    finalizeNlConfirmMessage,
    takeOrNotifyGone,
  };
}
