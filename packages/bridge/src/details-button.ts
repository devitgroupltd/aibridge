import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * §5.5's `details` button. `callback_data` is capped at 64 bytes and carries a reference, never
 * content: `d:<slug>:<turn>`, the plan's own worked example. Slugs are `[a-z0-9-]`, max 40 chars
 * (`slug.ts`), so this comfortably fits even at the cap.
 *
 * The button itself can't be attached to the turn card - the card is sent by the *feed* bot
 * (§5.4's P2 lane, kept off the control bot's budget on purpose), but a `callback_query` always
 * routes back to whichever bot posted the message, and the feed bot never polls `getUpdates`
 * (it's send-only) - a button on the card would be permanently unanswerable. So this is posted as
 * its own small, un-edited anchor message on the *control* bot instead, once per turn.
 */

export interface DetailsCallback {
  slug: string;
  turnSeq: number;
}

const DETAILS_CALLBACK_RE = /^d:([a-z0-9-]{1,40}):(\d{1,10})$/;

export function buildDetailsKeyboard(slug: string, turnSeq: number): InlineKeyboardButton[][] {
  return [[{ text: "📋 Details", callback_data: `d:${slug}:${turnSeq}` }]];
}

/** Re-validates the format rather than trusting the tap, same defensive pattern as every other
 * `resolve*Callback` in this codebase (`permission-callback.ts`, `commands.ts`) - any client that
 * can see the message can send arbitrary `callback_data` for it. */
export function parseDetailsCallback(data: string): DetailsCallback | null {
  const match = data.match(DETAILS_CALLBACK_RE);
  if (!match) return null;
  return { slug: match[1] ?? "", turnSeq: Number(match[2]) };
}
