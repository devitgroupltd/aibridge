/**
 * §7.4: "Treat any inbound message older than 30 minutes as stale: acknowledge it with 'received
 * while offline, still want this?' rather than acting on it." Telegram queues updates for 24
 * hours while the Bridge is offline (laptop asleep, process down), so on resume a backlog burst
 * can contain a command typed hours ago - acting on a two-hour-old "yes, push it" is exactly the
 * kind of surprise this design must not produce.
 *
 * Deliberately just the age check, kept pure and separate from `index.ts`'s confirm-card wiring
 * (`stale-confirm.ts`) so the "is this stale" question is unit-testable on its own, table-driven,
 * against `message.date` values rather than against a live Telegram round trip.
 */

/** This project's own choice - the plan names the 30-minute threshold but not this constant's
 * name, so it is spelled out here for the one call site and every test to share. */
export const STALE_INBOUND_THRESHOLD_MS = 30 * 60 * 1000;

/** `messageDateUnixSec` is Telegram's own `message.date` field (Unix seconds, UTC, set by
 * Telegram's servers when the message was sent - not when the Bridge finally saw it), compared
 * against wall-clock `nowMs`. Wall-clock, not monotonic, is correct here: staleness is about how
 * long ago a *human* sent this relative to real time, which a monotonic clock cannot answer since
 * it has no fixed epoch (§7.4's monotonic-clock guidance is for *durations* like a 30-minute TTL,
 * not for anchoring to an external wall-clock timestamp like this one). */
export function isStaleInbound(messageDateUnixSec: number, nowMs: number, thresholdMs = STALE_INBOUND_THRESHOLD_MS): boolean {
  return nowMs - messageDateUnixSec * 1000 > thresholdMs;
}

/**
 * Does this message carry media the Bridge would land in a session's inbox (§5.6)? The staleness gate
 * has to know, because it runs *before* the per-kind handlers and must distinguish "content I would
 * have acted on" from a Telegram service message (`forum_topic_created`, `pinned_message`,
 * `new_chat_members`) or an unhandled kind (sticker, poll, location). Those used to fall through to
 * `if (!message.text) return` and must keep doing so - otherwise a backlog replay posts a spurious
 * "an attachment arrived while offline" notice for every topic Telegram re-announces.
 *
 * Deliberately the same field list `index.ts`'s handlers branch on, kept here so it is testable
 * alongside the age check it gates.
 */
export function hasAttachment(message: {
  photo?: unknown[];
  document?: unknown;
  video?: unknown;
  audio?: unknown;
  video_note?: unknown;
}): boolean {
  return (
    (Array.isArray(message.photo) && message.photo.length > 0) ||
    message.document !== undefined ||
    message.video !== undefined ||
    message.audio !== undefined ||
    message.video_note !== undefined
  );
}

/** For the confirm card's own text - "received while offline (42m ago)" reads better than raw ms. */
export function formatStaleAge(messageDateUnixSec: number, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - messageDateUnixSec * 1000);
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin === 0 ? `${hours}h ago` : `${hours}h${remainMin}m ago`;
}
