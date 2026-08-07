import { ConfirmRegistry, type ConfirmRegistryOptions } from "./confirm-registry.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { RouterAction } from "./nl-router.ts";
import type { SessionCommand } from "./session-commands.ts";

/**
 * Live-observed gap (2026-08-07): an operator whose destructive-NL-command confirm card
 * (nl-confirm.ts) expired before they tapped it had no way to re-arm it short of retyping (or
 * re-recording, for voice) the exact same request and hoping the NL router classified it
 * identically a second time. `RetryStore` remembers the single most recently *expired* nl-confirm
 * per topic, keyed by `retryTopicKey` rather than a random id - `/retry` never names one, "the thing
 * that just expired here" is the whole point - so a bare `/retry`/"retry"/"try again" can re-post
 * the identical Yes/Cancel card via `postNlConfirm` instead.
 *
 * Deliberately narrower than all four confirm-card kinds (fleet `--all`, stale-inbound replay,
 * voice-transcript review): a bulk kill/rm `--all`'s target list can go stale within minutes (a
 * session may have died or been created since), and stale/voice confirms are inherently
 * time-/content-sensitive - blindly replaying either past its own already-cautious TTL is a
 * different, riskier call than re-arming one already-classified command. Extend this the same way
 * if retry turns out to be wanted for those too.
 */
export interface PendingRetry {
  id: string;
  command: FleetCommand | SessionCommand | RouterAction;
  threadId: number | undefined;
  currentSlug: string | undefined;
  createdAt: number;
}

/** Long enough that "type /retry if you still want it" is a realistic thing to come back and do a
 * few minutes later, without outliving the operator's own memory of what the command even was. */
const RETRY_TTL_MS = 10 * 60 * 1000;

export type RetryStoreOptions = ConfirmRegistryOptions;

export class RetryStore extends ConfirmRegistry<PendingRetry> {
  constructor(opts: RetryStoreOptions = {}) {
    super(RETRY_TTL_MS, opts);
  }
}

/** The key both the expiry-stash path and `/retry` itself look up by: a session topic's own thread
 * id, or the fixed string "control" for the control topic (`threadId === undefined`) - same
 * "collapse undefined to one fixed key" convention `typingIndicator`'s own topic-id string uses. */
export function retryTopicKey(threadId: number | undefined): string {
  return threadId === undefined ? "control" : String(threadId);
}

/** `/retry`, or its natural-language voice/text equivalents ("retry", "try again", "do it/that
 * again") - optionally with the leading slash and/or trailing punctuation a voice transcript tends
 * to add. Deliberately matched only when `dispatchInboundMessage` (index.ts) already knows
 * `retryStore` holds something for this topic - so an ordinary "try again" meant for Claude, in a
 * topic with nothing pending, still falls through to the session untouched rather than being
 * swallowed on the strength of this regex alone. */
const RETRY_PHRASE = /^\/?retry[.!?]?$|^try again[.!?]?$|^do (?:it|that) again[.!?]?$/i;

export function isRetryPhrase(text: string): boolean {
  return RETRY_PHRASE.test(text.trim());
}
